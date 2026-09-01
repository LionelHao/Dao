import type { DatabaseSync } from "node:sqlite";
import {
  PRIVACY_RETENTION_MAX_BATCH_SIZE,
  isPrivacyRetentionRunBatchOperation,
  type PrivacyRetentionAuthorityResult,
  type PrivacyRetentionRunBatchOperation,
} from "./retention-authority-protocol.js";

type RetentionCandidateRow = Readonly<{
  category: "context_snapshot_payload" | "tool_sealed_side_effect_payload";
  candidateId: string;
  dueAt: string;
}>;

const RETENTION_CANDIDATES_SQL = `
  SELECT 'context_snapshot_payload' AS category,
         snapshot.snapshot_id AS candidateId,
         snapshot.retain_until AS dueAt
  FROM context_snapshots AS snapshot
  WHERE snapshot.payload_retention_state = 'purge_pending'
    AND snapshot.retain_until <= ?
    AND EXISTS (
      SELECT 1
      FROM agent_execution_context_bindings AS binding
      JOIN agent_executions AS execution ON execution.id = binding.execution_id
      WHERE binding.snapshot_id = snapshot.snapshot_id
        AND execution.status IN ('completed', 'failed', 'cancelled')
    )
  UNION ALL
  SELECT 'tool_sealed_side_effect_payload' AS category,
         call.tool_call_id AS candidateId,
         call.sealed_payload_expires_at AS dueAt
  FROM tool_calls_v2 AS call
  WHERE call.sealed_payload_ciphertext IS NOT NULL
    AND call.sealed_payload_key_version IS NOT NULL
    AND call.sealed_payload_expires_at IS NOT NULL
    AND call.sealed_payload_expires_at <= ?
    AND EXISTS (
      SELECT 1 FROM tool_dispatches_v2 AS dispatch
      WHERE dispatch.tool_call_id = call.tool_call_id
        AND dispatch.state IN ('known_succeeded', 'known_failed', 'reviewed')
    )`;

const RUNNABLE_CANDIDATES_SQL = `
  SELECT candidate.category, candidate.candidateId, candidate.dueAt
  FROM (${RETENTION_CANDIDATES_SQL}) AS candidate
  LEFT JOIN privacy_retention_attempts AS attempt
    ON attempt.category = candidate.category
   AND attempt.candidate_id = candidate.candidateId
  WHERE attempt.status IS NULL
     OR (attempt.status = 'pending' AND attempt.available_at <= ?)`;

function parseCandidate(row: Record<string, unknown>): RetentionCandidateRow {
  if ((row.category !== "context_snapshot_payload" &&
      row.category !== "tool_sealed_side_effect_payload") ||
      typeof row.candidateId !== "string" || row.candidateId.length === 0 ||
      typeof row.dueAt !== "string" || row.dueAt.length === 0) {
    throw new TypeError("Retention authority candidate row was corrupt");
  }
  return {
    category: row.category,
    candidateId: row.candidateId,
    dueAt: row.dueAt,
  };
}

function canonicalDueTimeMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return new Date(parsed).toISOString() === value ? parsed : undefined;
}

function purgeContextSnapshotPayload(
  database: DatabaseSync,
  snapshotId: string,
  now: string,
): boolean {
  const stillEligible = `EXISTS (
    SELECT 1
    FROM context_snapshots AS snapshot
    JOIN agent_execution_context_bindings AS binding
      ON binding.snapshot_id = snapshot.snapshot_id
    JOIN agent_executions AS execution ON execution.id = binding.execution_id
    WHERE snapshot.snapshot_id = ?
      AND snapshot.payload_retention_state = 'purge_pending'
      AND snapshot.retain_until <= ?
      AND execution.status IN ('completed', 'failed', 'cancelled')
  )`;
  database.prepare(
    `DELETE FROM context_source_read_payloads
     WHERE read_id IN (SELECT read_id FROM context_source_reads WHERE snapshot_id = ?)
       AND ${stillEligible}`,
  ).run(snapshotId, snapshotId, now);
  const deleted = database.prepare(
    `DELETE FROM context_snapshot_bodies
     WHERE snapshot_id = ? AND ${stillEligible}`,
  ).run(snapshotId, snapshotId, now);
  if (deleted.changes === 1) return true;
  return database.prepare(
    `UPDATE context_snapshots SET payload_retention_state = 'purged'
     WHERE snapshot_id = ? AND payload_retention_state = 'purge_pending'
       AND retain_until <= ?
       AND EXISTS (
         SELECT 1
         FROM agent_execution_context_bindings AS binding
         JOIN agent_executions AS execution ON execution.id = binding.execution_id
         WHERE binding.snapshot_id = context_snapshots.snapshot_id
           AND execution.status IN ('completed', 'failed', 'cancelled')
       )`,
  ).run(snapshotId, now).changes === 1;
}

function purgeToolSealedPayload(
  database: DatabaseSync,
  toolCallId: string,
  now: string,
): boolean {
  return database.prepare(
    `UPDATE tool_calls_v2
     SET sealed_payload_ciphertext = NULL,
         sealed_payload_key_version = NULL,
         sealed_payload_expires_at = NULL
     WHERE tool_call_id = ?
       AND sealed_payload_ciphertext IS NOT NULL
       AND sealed_payload_key_version IS NOT NULL
       AND sealed_payload_expires_at IS NOT NULL
       AND sealed_payload_expires_at <= ?
       AND EXISTS (
         SELECT 1 FROM tool_dispatches_v2 AS dispatch
         WHERE dispatch.tool_call_id = tool_calls_v2.tool_call_id
           AND dispatch.state IN ('known_succeeded', 'known_failed', 'reviewed')
       )`,
  ).run(toolCallId, now).changes === 1;
}

function readRemainingQueue(
  database: DatabaseSync,
  now: string,
  nowMs: number,
): Readonly<{ queueDepth: number; oldestAgeMs: number; hasRunnable: boolean }> {
  const row = database.prepare(
    `SELECT COUNT(*) AS queueDepth, MIN(candidate.dueAt) AS oldestDueAt,
            SUM(CASE WHEN attempt.status IS NULL OR attempt.available_at <= ?
                     THEN 1 ELSE 0 END) AS runnableDepth
     FROM (${RETENTION_CANDIDATES_SQL}) AS candidate
     LEFT JOIN privacy_retention_attempts AS attempt
       ON attempt.category = candidate.category
      AND attempt.candidate_id = candidate.candidateId
     WHERE attempt.status IS NULL OR attempt.status = 'pending'`,
  ).get(now, now, now);
  if (row === undefined || !Number.isSafeInteger(row.queueDepth) || Number(row.queueDepth) < 0) {
    throw new TypeError("Retention authority queue metrics were corrupt");
  }
  const queueDepth = Number(row.queueDepth);
  const runnableDepth = Number(row.runnableDepth ?? 0);
  if (!Number.isSafeInteger(runnableDepth) || runnableDepth < 0 || runnableDepth > queueDepth) {
    throw new TypeError("Retention authority runnable queue metrics were corrupt");
  }
  if (queueDepth === 0) return { queueDepth: 0, oldestAgeMs: 0, hasRunnable: false };
  if (typeof row.oldestDueAt !== "string") {
    throw new TypeError("Retention authority oldest queue boundary was corrupt");
  }
  const oldestDueAtMs = canonicalDueTimeMs(row.oldestDueAt);
  // An invalid persisted boundary is never interpreted as deletion authority. Keep it queued
  // with a zero age so operators see backlog without guessing a destructive timestamp.
  if (oldestDueAtMs === undefined || oldestDueAtMs > nowMs) {
    return { queueDepth, oldestAgeMs: 0, hasRunnable: runnableDepth > 0 };
  }
  return { queueDepth, oldestAgeMs: nowMs - oldestDueAtMs, hasRunnable: runnableDepth > 0 };
}

function recordRetentionFailure(
  database: DatabaseSync,
  candidate: RetentionCandidateRow,
  nowMs: number,
): "retried" | "dead_lettered" {
  const existing = database.prepare(
    `SELECT status, attempts FROM privacy_retention_attempts
     WHERE category = ? AND candidate_id = ?`,
  ).get(candidate.category, candidate.candidateId);
  const currentAttempts = existing === undefined ? 0 : Number(existing.attempts);
  if ((existing !== undefined && existing.status !== "pending") ||
      !Number.isSafeInteger(currentAttempts) || currentAttempts < 0 || currentAttempts >= 8) {
    throw new TypeError("Retention authority retry row was corrupt");
  }
  const attempts = currentAttempts + 1;
  const updatedAt = new Date(nowMs).toISOString();
  const delayMs = Math.min(60 * 60 * 1_000, 2 ** attempts * 1_000);
  const availableAt = new Date(nowMs + delayMs).toISOString();
  const terminal = attempts === 8;
  if (existing === undefined) {
    database.prepare(
      `INSERT INTO privacy_retention_attempts (
         category, candidate_id, status, attempts, available_at, last_error,
         updated_at, dead_lettered_at
       ) VALUES (?, ?, ?, ?, ?, 'purge_failed', ?, ?)`,
    ).run(candidate.category, candidate.candidateId,
      terminal ? "dead_letter" : "pending", attempts, availableAt, updatedAt,
      terminal ? updatedAt : null);
  } else {
    database.prepare(
      `UPDATE privacy_retention_attempts
       SET status = ?, attempts = ?, available_at = ?, last_error = 'purge_failed',
           updated_at = ?, dead_lettered_at = ?
       WHERE category = ? AND candidate_id = ? AND status = 'pending' AND attempts = ?`,
    ).run(terminal ? "dead_letter" : "pending", attempts, availableAt, updatedAt,
      terminal ? updatedAt : null, candidate.category, candidate.candidateId, currentAttempts);
  }
  return terminal ? "dead_lettered" : "retried";
}

/**
 * Executes one bounded retention batch inside the caller's AuthorityWorker transaction.
 * It only clears restricted payload columns; source facts and immutable audit metadata remain.
 */
export function executePrivacyRetentionAuthorityOperation(
  database: DatabaseSync,
  operation: PrivacyRetentionRunBatchOperation,
): PrivacyRetentionAuthorityResult {
  if (!isPrivacyRetentionRunBatchOperation(operation) ||
      operation.limit > PRIVACY_RETENTION_MAX_BATCH_SIZE) {
    throw new TypeError("Privacy retention authority operation is invalid");
  }
  const now = new Date(operation.now).toISOString();
  const candidates = database.prepare(
    `SELECT category, candidateId, dueAt
     FROM (${RUNNABLE_CANDIDATES_SQL})
     ORDER BY dueAt, category, candidateId
     LIMIT ?`,
  ).all(now, now, now, operation.limit).map(parseCandidate);

  let purged = 0;
  let retained = 0;
  let retried = 0;
  let deadLettered = 0;
  for (const candidate of candidates) {
    const dueAtMs = canonicalDueTimeMs(candidate.dueAt);
    if (dueAtMs === undefined || dueAtMs > operation.now) {
      // A malformed persisted deletion boundary is never deletion authority. Move it
      // through the same bounded durable retry/dead-letter lane so it cannot hot-loop
      // at the head of every batch and starve a later valid candidate.
      const outcome = recordRetentionFailure(database, candidate, operation.now);
      if (outcome === "retried") retried += 1;
      else deadLettered += 1;
      continue;
    }
    database.exec("SAVEPOINT privacy_retention_candidate");
    try {
      const didPurge = candidate.category === "context_snapshot_payload"
        ? purgeContextSnapshotPayload(database, candidate.candidateId, now)
        : purgeToolSealedPayload(database, candidate.candidateId, now);
      if (didPurge) {
        database.prepare(
          "DELETE FROM privacy_retention_attempts WHERE category = ? AND candidate_id = ?",
        ).run(candidate.category, candidate.candidateId);
        purged += 1;
      } else {
        retained += 1;
      }
      database.exec("RELEASE privacy_retention_candidate");
    } catch {
      database.exec("ROLLBACK TO privacy_retention_candidate");
      database.exec("RELEASE privacy_retention_candidate");
      const outcome = recordRetentionFailure(database, candidate, operation.now);
      if (outcome === "retried") retried += 1;
      else deadLettered += 1;
    }
  }

  const queue = readRemainingQueue(database, now, operation.now);
  return Object.freeze({
    kind: "privacy-retention-batch",
    processed: candidates.length,
    purged,
    retained,
    retried,
    deadLettered,
    hasMore: queue.hasRunnable,
    queueDepth: queue.queueDepth,
    oldestAgeMs: queue.oldestAgeMs,
  });
}
