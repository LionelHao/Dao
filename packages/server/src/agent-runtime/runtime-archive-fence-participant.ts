import type { DatabaseSync } from "node:sqlite";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import {
  AUTHORITY_PARTICIPANT_VERSION,
  type AuthorityTransactionView,
  type ParticipantRegistration,
  type RuntimeArchiveFenceParticipant,
  type RuntimeArchiveFenceResult,
} from "../room-governance/private-participant-contracts.js";

const REGISTRATION_ID = "dao.agent-runtime.archive-fence.v1";
const ARCHIVE_CANCELLATION_REASON = "room_archived";
const OUTCOME_REVIEW_ERROR = "side_effect_outcome_unknown";
const DISPATCH_SETTLEMENT_ERROR = "room_archived_after_dispatch";

type FenceDisposition =
  | "cancelled_queued"
  | "cancelled_waiting"
  | "preserved_dispatched"
  | "preserved_outcome_review";

interface RuntimeCandidateRow {
  readonly id: unknown;
  readonly status: unknown;
  readonly currentAttemptSeq: unknown;
  readonly roomArchiveGeneration: unknown;
  readonly actionCategory: unknown;
  readonly toolDispatchPhase: unknown;
  readonly dispatchId: unknown;
  readonly dispatchState: unknown;
}

interface FenceCountRow {
  readonly fencedQueuedCount: unknown;
  readonly fencedWaitingCount: unknown;
  readonly preservedDispatchedCount: unknown;
  readonly preservedOutcomeReviewCount: unknown;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertInput(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; archiveGeneration: number }>,
): void {
  if (input.roomId !== transaction.roomId || input.roomId.length === 0 ||
      !Number.isSafeInteger(input.archiveGeneration) || input.archiveGeneration <= 0) {
    throw new TypeError("Runtime archive fence input is invalid");
  }
}

function requireCurrentArchivedRoom(
  database: DatabaseSync,
  roomId: string,
  archiveGeneration: number,
): void {
  const room = database.prepare(
    `SELECT status, archive_generation AS archiveGeneration
     FROM rooms WHERE id = ?`,
  ).get(roomId);
  if (room?.status !== "archived" || room.archiveGeneration !== archiveGeneration) {
    throw new Error("Runtime archive fence generation is stale");
  }
  const newestFence = database.prepare(
    `SELECT MAX(archive_generation) AS archiveGeneration
     FROM runtime_archive_fences WHERE room_id = ?`,
  ).get(roomId)?.archiveGeneration;
  if (newestFence !== null && newestFence !== undefined &&
      (!isNonNegativeInteger(newestFence) || newestFence > archiveGeneration)) {
    throw new Error("Runtime archive fence history is inconsistent");
  }
}

function currentCandidates(
  database: DatabaseSync,
  roomId: string,
  archiveGeneration: number,
): readonly RuntimeCandidateRow[] {
  const futureLive = database.prepare(
    `SELECT COUNT(*) AS count
     FROM agent_executions
     WHERE room_id = ?
       AND status IN ('queued', 'running')
       AND room_archive_generation > ?`,
  ).get(roomId, archiveGeneration)?.count;
  if (!isNonNegativeInteger(futureLive) || futureLive !== 0) {
    throw new Error("Runtime execution generation is inconsistent");
  }

  return database.prepare(
    `SELECT execution.id,
            execution.status,
            execution.current_attempt_seq AS currentAttemptSeq,
            execution.room_archive_generation AS roomArchiveGeneration,
            execution.action_category AS actionCategory,
            execution.tool_dispatch_phase AS toolDispatchPhase,
            dispatch.dispatch_id AS dispatchId,
            dispatch.state AS dispatchState
     FROM agent_executions AS execution
     LEFT JOIN tool_dispatches AS dispatch
       ON dispatch.rowid = (
         SELECT candidate.rowid
         FROM tool_dispatches AS candidate
         WHERE candidate.execution_id = execution.id
           AND candidate.attempt_seq = execution.current_attempt_seq
         ORDER BY candidate.rowid DESC
         LIMIT 1
       )
     LEFT JOIN runtime_archive_fence_members AS member
       ON member.room_id = execution.room_id
      AND member.archive_generation = ?
      AND member.execution_id = execution.id
     WHERE execution.room_id = ?
       AND execution.room_archive_generation <= ?
       AND member.execution_id IS NULL
       AND (
         execution.status IN ('queued', 'running')
         OR (
           execution.status = 'failed'
           AND execution.terminal_error_code = 'side_effect_outcome_unknown'
           AND dispatch.state = 'outcome_unknown'
         )
       )
     ORDER BY execution.queued_at, execution.id`,
  ).all(archiveGeneration, roomId, archiveGeneration) as unknown as readonly RuntimeCandidateRow[];
}

function requireCandidate(row: RuntimeCandidateRow): Readonly<{
  id: string;
  status: "queued" | "running" | "failed";
  currentAttemptSeq: number;
  actionCategory: string;
  toolDispatchPhase: null | string;
  dispatchId?: string;
  dispatchState?: "dispatched" | "succeeded" | "failed" | "outcome_unknown";
}> {
  if (typeof row.id !== "string" || row.id.length === 0 ||
      (row.status !== "queued" && row.status !== "running" && row.status !== "failed") ||
      !Number.isSafeInteger(row.currentAttemptSeq) || (row.currentAttemptSeq as number) < 1 ||
      !isNonNegativeInteger(row.roomArchiveGeneration) ||
      typeof row.actionCategory !== "string" ||
      (row.toolDispatchPhase !== null && typeof row.toolDispatchPhase !== "string")) {
    throw new Error("Runtime archive candidate is corrupt");
  }
  const hasDispatch = row.dispatchId !== null;
  if (hasDispatch && (typeof row.dispatchId !== "string" ||
      (row.dispatchState !== "dispatched" && row.dispatchState !== "succeeded" &&
       row.dispatchState !== "failed" && row.dispatchState !== "outcome_unknown"))) {
    throw new Error("Runtime archive dispatch evidence is corrupt");
  }
  if (!hasDispatch && (row.dispatchState !== null ||
      (row.actionCategory === "tool_call" &&
       (row.toolDispatchPhase === "dispatched" || row.toolDispatchPhase === "finished")))) {
    throw new Error("Runtime archive dispatch evidence is missing");
  }
  return {
    id: row.id,
    status: row.status,
    currentAttemptSeq: row.currentAttemptSeq as number,
    actionCategory: row.actionCategory,
    toolDispatchPhase: row.toolDispatchPhase,
    ...(hasDispatch ? {
      dispatchId: row.dispatchId as string,
      dispatchState: row.dispatchState as "dispatched" | "succeeded" | "failed" | "outcome_unknown",
    } : {}),
  };
}

function terminateAttempt(
  database: DatabaseSync,
  candidate: ReturnType<typeof requireCandidate>,
  status: "cancelled" | "failed",
  errorCode: string,
  now: string,
): void {
  if (candidate.status === "failed") return;
  const attempt = database.prepare(
    `UPDATE agent_execution_attempts
     SET status = ?, finished_at = ?, error_code = ?, next_retry_at = NULL
     WHERE execution_id = ? AND attempt_seq = ? AND status IN ('queued', 'running')`,
  ).run(status, now, errorCode, candidate.id, candidate.currentAttemptSeq);
  if (attempt.changes !== 1) {
    throw new Error("Runtime archive attempt terminal transition was stale");
  }
}

function preserveDispatch(
  database: DatabaseSync,
  candidate: ReturnType<typeof requireCandidate>,
  now: string,
): FenceDisposition {
  if (candidate.dispatchId === undefined || candidate.dispatchState === undefined) {
    throw new Error("Runtime archive dispatch evidence is missing");
  }
  const outcomeReview = candidate.dispatchState === "outcome_unknown";
  if (candidate.dispatchState === "dispatched") {
    const dispatch = database.prepare(
      `UPDATE tool_dispatches
       SET state = 'outcome_unknown', settled_at = ?
       WHERE dispatch_id = ? AND state = 'dispatched'`,
    ).run(now, candidate.dispatchId);
    if (dispatch.changes !== 1) {
      throw new Error("Runtime archive dispatch transition was stale");
    }
  }
  const errorCode = candidate.dispatchState === "dispatched" || outcomeReview
    ? OUTCOME_REVIEW_ERROR
    : DISPATCH_SETTLEMENT_ERROR;
  terminateAttempt(database, candidate, "failed", errorCode, now);
  if (candidate.status !== "failed") {
    const execution = database.prepare(
      `UPDATE agent_executions
       SET status = 'failed', completed_at = ?, updated_at = ?,
           cancellation_reason = NULL, terminal_error_code = ?, dead_lettered_at = ?,
           next_retry_at = NULL
       WHERE id = ? AND current_attempt_seq = ? AND status IN ('queued', 'running')`,
    ).run(now, now, errorCode, now, candidate.id, candidate.currentAttemptSeq);
    if (execution.changes !== 1) {
      throw new Error("Runtime archive dispatch terminal transition was stale");
    }
  }
  return outcomeReview ? "preserved_outcome_review" : "preserved_dispatched";
}

function cancelUndispatched(
  database: DatabaseSync,
  candidate: ReturnType<typeof requireCandidate>,
  now: string,
): FenceDisposition {
  if (candidate.status === "failed" || candidate.dispatchId !== undefined) {
    throw new Error("Runtime archive undispatched candidate is invalid");
  }
  const disposition: FenceDisposition = candidate.status === "queued"
    ? "cancelled_queued"
    : "cancelled_waiting";
  terminateAttempt(database, candidate, "cancelled", ARCHIVE_CANCELLATION_REASON, now);
  const execution = database.prepare(
    `UPDATE agent_executions
     SET status = 'cancelled', completed_at = ?, updated_at = ?,
         cancellation_reason = ?, terminal_error_code = NULL,
         dead_lettered_at = NULL, next_retry_at = NULL
     WHERE id = ? AND current_attempt_seq = ? AND status IN ('queued', 'running')`,
  ).run(now, now, ARCHIVE_CANCELLATION_REASON, candidate.id, candidate.currentAttemptSeq);
  if (execution.changes !== 1) {
    throw new Error("Runtime archive cancellation was stale");
  }
  return disposition;
}

function readCounts(
  database: DatabaseSync,
  roomId: string,
  archiveGeneration: number,
): RuntimeArchiveFenceResult {
  const row = database.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN disposition = 'cancelled_queued' THEN 1 ELSE 0 END), 0)
         AS fencedQueuedCount,
       COALESCE(SUM(CASE WHEN disposition = 'cancelled_waiting' THEN 1 ELSE 0 END), 0)
         AS fencedWaitingCount,
       COALESCE(SUM(CASE WHEN disposition = 'preserved_dispatched' THEN 1 ELSE 0 END), 0)
         AS preservedDispatchedCount,
       COALESCE(SUM(CASE WHEN disposition = 'preserved_outcome_review' THEN 1 ELSE 0 END), 0)
         AS preservedOutcomeReviewCount
     FROM runtime_archive_fence_members
     WHERE room_id = ? AND archive_generation = ?`,
  ).get(roomId, archiveGeneration) as FenceCountRow | undefined;
  const values = [
    row?.fencedQueuedCount,
    row?.fencedWaitingCount,
    row?.preservedDispatchedCount,
    row?.preservedOutcomeReviewCount,
  ];
  if (!values.every(isNonNegativeInteger)) {
    throw new Error("Runtime archive fence counts are corrupt");
  }
  return Object.freeze({
    roomId,
    archiveGeneration,
    fencedQueuedCount: values[0] as number,
    fencedWaitingCount: values[1] as number,
    preservedDispatchedCount: values[2] as number,
    preservedOutcomeReviewCount: values[3] as number,
  });
}

function fenceDatabase(
  database: DatabaseSync,
  input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
): RuntimeArchiveFenceResult {
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new TypeError("Runtime archive fence time is invalid");
  }
  requireCurrentArchivedRoom(database, input.roomId, input.archiveGeneration);
  database.prepare(
    `INSERT INTO runtime_archive_fences (
       room_id, archive_generation, fenced_at
     ) VALUES (?, ?, ?)
     ON CONFLICT(room_id, archive_generation) DO NOTHING`,
  ).run(input.roomId, input.archiveGeneration, input.now);

  for (const row of currentCandidates(database, input.roomId, input.archiveGeneration)) {
    const candidate = requireCandidate(row);
    const disposition = candidate.dispatchId === undefined
      ? cancelUndispatched(database, candidate, input.now)
      : preserveDispatch(database, candidate, input.now);
    database.prepare(
      `INSERT INTO runtime_archive_fence_members (
         room_id, archive_generation, execution_id, attempt_seq, disposition, fenced_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.roomId,
      input.archiveGeneration,
      candidate.id,
      candidate.currentAttemptSeq,
      disposition,
      input.now,
    );
  }

  const result = readCounts(database, input.roomId, input.archiveGeneration);
  database.prepare(
    `UPDATE runtime_archive_fences
     SET fenced_queued_count = ?, fenced_waiting_count = ?,
         preserved_dispatched_count = ?, preserved_outcome_review_count = ?
     WHERE room_id = ? AND archive_generation = ?`,
  ).run(
    result.fencedQueuedCount,
    result.fencedWaitingCount,
    result.preservedDispatchedCount,
    result.preservedOutcomeReviewCount,
    input.roomId,
    input.archiveGeneration,
  );
  return result;
}

export function canStartRuntimeGenerationInTransaction(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; archiveGeneration: number }>,
): boolean {
  if (input.roomId !== transaction.roomId || input.roomId.length === 0 ||
      !isNonNegativeInteger(input.archiveGeneration)) {
    throw new TypeError("Runtime generation admission input is invalid");
  }
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const room = database.prepare(
      `SELECT status, archive_generation AS archiveGeneration
       FROM rooms WHERE id = ?`,
    ).get(input.roomId);
    if (room?.status !== "active" || room.archiveGeneration !== input.archiveGeneration) {
      return false;
    }
    const futureFence = database.prepare(
      `SELECT 1 AS present
       FROM runtime_archive_fences
       WHERE room_id = ? AND archive_generation > ?
       LIMIT 1`,
    ).get(input.roomId, input.archiveGeneration);
    return futureFence?.present !== 1;
  });
}

/**
 * Restart/recovery entry point for one room. The AuthorityWorker can keyset-scan
 * archived rooms and call this inside a fresh room transaction until its scan
 * is empty. Active rooms are intentionally a no-op; archived rooms are always
 * reconciled from durable executions, attempts, dispatches, and fence members.
 */
export function recoverRuntimeArchiveFenceInTransaction(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; now: string }>,
): RuntimeArchiveFenceResult | undefined {
  if (input.roomId !== transaction.roomId || input.roomId.length === 0 ||
      !Number.isFinite(Date.parse(input.now))) {
    throw new TypeError("Runtime archive fence recovery input is invalid");
  }
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const room = database.prepare(
      `SELECT status, archive_generation AS archiveGeneration
       FROM rooms WHERE id = ?`,
    ).get(input.roomId);
    if (room?.status === "active" && isNonNegativeInteger(room.archiveGeneration)) {
      return undefined;
    }
    if (room?.status !== "archived" || !isNonNegativeInteger(room.archiveGeneration) ||
        room.archiveGeneration < 1) {
      throw new Error("Runtime archive recovery room is corrupt");
    }
    return fenceDatabase(database, {
      roomId: input.roomId,
      archiveGeneration: room.archiveGeneration,
      now: input.now,
    });
  });
}

export function createRuntimeArchiveFenceParticipant(): RuntimeArchiveFenceParticipant {
  const participant: RuntimeArchiveFenceParticipant = {
    fenceForArchive(
      transaction: AuthorityTransactionView,
      input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
    ) {
      assertInput(transaction, input);
      const result = useAuthorityTransactionDatabase(
        transaction,
        (database) => fenceDatabase(database, input),
      );
      return Object.freeze({ ok: true as const, result });
    },
  };
  return Object.freeze(participant);
}

const productionParticipant = createRuntimeArchiveFenceParticipant();

export const runtimeArchiveFenceParticipantRegistration = Object.freeze({
  registrationId: REGISTRATION_ID,
  feature: "runtime-archive-fence" as const,
  version: AUTHORITY_PARTICIPANT_VERSION,
  enabled: true,
  participant: productionParticipant,
}) satisfies ParticipantRegistration<RuntimeArchiveFenceParticipant>;
