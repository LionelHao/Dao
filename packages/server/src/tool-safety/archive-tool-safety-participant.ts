import type { DatabaseSync } from "node:sqlite";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import {
  AUTHORITY_PARTICIPANT_VERSION,
  type ArchiveSettlementParticipant,
  type ArchiveSettlementResult,
  type AuthorityParticipantEnvelope,
  type AuthorityParticipantFailureReason,
  type AuthorityTransactionView,
  type ParticipantRegistration,
} from "../room-governance/private-participant-contracts.js";

const FEATURE = "archive-settlement" as const;
const REGISTRATION_ID = "dao.tool-safety.archive-settlement.v1";
const ARCHIVE_REASON = "room_archived";
const PARAMETER_HASH = /^[0-9a-f]{64}$/u;
const DISPATCH_STATES = new Set([
  "claimed", "dispatched", "succeeded", "failed", "outcome_unknown", "reviewed",
]);

class ArchiveSettlementInputMismatchError extends Error {
  constructor() {
    super("Tool archive settlement lifecycle input is stale");
    Object.defineProperty(this, "name", { value: "ArchiveSettlementInputMismatchError" });
  }
}

interface RoomRow {
  readonly status: unknown;
  readonly archiveGeneration: unknown;
  readonly archivedAt: unknown;
}

interface ConfirmationBindingRow {
  readonly confirmationId: unknown;
  readonly executionId: unknown;
  readonly attemptSeq: unknown;
  readonly toolId: unknown;
  readonly parameterSha256: unknown;
  readonly roomId: unknown;
  readonly consumedAt: unknown;
  readonly confirmationState: unknown;
  readonly confirmationRevision: unknown;
  readonly executionRoomId: unknown;
  readonly currentAttemptSeq: unknown;
  readonly attemptStatus: unknown;
  readonly grantId: unknown;
  readonly grantExecutionId: unknown;
  readonly grantAttemptSeq: unknown;
  readonly grantRoomId: unknown;
  readonly grantToolId: unknown;
  readonly grantParameterSha256: unknown;
  readonly grantState: unknown;
  readonly grantConsumedAt: unknown;
}

interface GrantBindingRow {
  readonly grantId: unknown;
  readonly executionId: unknown;
  readonly attemptSeq: unknown;
  readonly roomId: unknown;
  readonly toolId: unknown;
  readonly parameterSha256: unknown;
  readonly consumedAt: unknown;
  readonly grantState: unknown;
  readonly grantRevision: unknown;
  readonly executionRoomId: unknown;
  readonly currentAttemptSeq: unknown;
  readonly attemptStatus: unknown;
}

interface DispatchRow {
  readonly dispatchId: unknown;
  readonly executionId: unknown;
  readonly attemptSeq: unknown;
  readonly grantId: unknown;
  readonly state: unknown;
  readonly executionRoomId: unknown;
}

interface WaitingExecutionRow {
  readonly executionId: unknown;
  readonly currentAttemptSeq: unknown;
  readonly status: unknown;
  readonly actionCategory: unknown;
  readonly toolDispatchPhase: unknown;
  readonly attemptStatus: unknown;
  readonly attemptActionCategory: unknown;
}

interface SettlementCountRow {
  readonly rejectedPendingCount: unknown;
  readonly revokedGrantCount: unknown;
  readonly fencedWaitingCount: unknown;
  readonly preservedDispatchedCount: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fail(
  reason: AuthorityParticipantFailureReason,
): AuthorityParticipantEnvelope<ArchiveSettlementResult> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      httpStatus: 503 as const,
      code: "dependency_unavailable" as const,
      dependency: FEATURE,
      reason,
      retryable: true as const,
    }),
  });
}

function validateRoom(
  database: DatabaseSync,
  input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
): boolean {
  const room = database.prepare(
    `SELECT status, archive_generation AS archiveGeneration, archived_at AS archivedAt
     FROM rooms WHERE id = ?`,
  ).get(input.roomId) as RoomRow | undefined;
  return room?.status === "archived" && room.archiveGeneration === input.archiveGeneration &&
    isNonEmptyString(room.archivedAt) && Number.isFinite(Date.parse(input.now));
}

function validateConfirmationBindings(database: DatabaseSync, roomId: string): void {
  const rows = database.prepare(
    `SELECT
       confirmation.confirmation_id AS confirmationId,
       confirmation.execution_id AS executionId,
       confirmation.attempt_seq AS attemptSeq,
       confirmation.tool_id AS toolId,
       confirmation.parameter_sha256 AS parameterSha256,
       confirmation.room_id AS roomId,
       confirmation.consumed_at AS consumedAt,
       confirmation.confirmation_state AS confirmationState,
       confirmation.confirmation_revision AS confirmationRevision,
       execution.room_id AS executionRoomId,
       execution.current_attempt_seq AS currentAttemptSeq,
       attempt.status AS attemptStatus,
       grant.grant_id AS grantId,
       grant.execution_id AS grantExecutionId,
       grant.attempt_seq AS grantAttemptSeq,
       grant.room_id AS grantRoomId,
       grant.tool_id AS grantToolId,
       grant.parameter_sha256 AS grantParameterSha256,
       grant.grant_state AS grantState,
       grant.consumed_at AS grantConsumedAt
     FROM tool_confirmations AS confirmation
     LEFT JOIN agent_executions AS execution
       ON execution.id = confirmation.execution_id
     LEFT JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = confirmation.execution_id
      AND attempt.attempt_seq = confirmation.attempt_seq
     LEFT JOIN agent_execution_grants AS grant
       ON grant.execution_id = confirmation.execution_id
      AND grant.attempt_seq = confirmation.attempt_seq
      AND grant.room_id = confirmation.room_id
      AND grant.tool_id = confirmation.tool_id
      AND grant.parameter_sha256 = confirmation.parameter_sha256
     WHERE confirmation.room_id = ?
     ORDER BY confirmation.confirmation_id, grant.grant_id`,
  ).all(roomId) as unknown as readonly ConfirmationBindingRow[];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isNonEmptyString(row.confirmationId) || seen.has(row.confirmationId) ||
        !isNonEmptyString(row.executionId) || !isPositiveInteger(row.attemptSeq) ||
        !isNonEmptyString(row.toolId) || typeof row.parameterSha256 !== "string" ||
        !PARAMETER_HASH.test(row.parameterSha256) || row.roomId !== roomId ||
        !["pending", "confirmed", "rejected", "expired"].includes(row.confirmationState as string) ||
        !isNonNegativeInteger(row.confirmationRevision) || row.executionRoomId !== roomId ||
        !isPositiveInteger(row.currentAttemptSeq) ||
        !isNonEmptyString(row.attemptStatus) || !isNonEmptyString(row.grantId) ||
        row.grantExecutionId !== row.executionId || row.grantAttemptSeq !== row.attemptSeq ||
        row.grantRoomId !== roomId || row.grantToolId !== row.toolId ||
        row.grantParameterSha256 !== row.parameterSha256 ||
        !["active", "claimed", "revoked", "expired"].includes(row.grantState as string)) {
      throw new Error("Tool confirmation binding is corrupt");
    }
    if (row.confirmationState === "pending" && row.currentAttemptSeq !== row.attemptSeq) {
      throw new Error("Pending confirmation targeted a stale attempt");
    }
    if (row.confirmationState === "pending" && row.consumedAt !== null) {
      throw new Error("Pending confirmation is already consumed");
    }
    if (row.grantState === "active" && row.grantConsumedAt !== null) {
      throw new Error("Active grant is already consumed");
    }
    if (row.grantState === "claimed" && !isNonEmptyString(row.grantConsumedAt)) {
      throw new Error("Claimed grant is missing consumption evidence");
    }
    seen.add(row.confirmationId);
  }
}

function validateGrantBindings(database: DatabaseSync, roomId: string): void {
  const rows = database.prepare(
    `SELECT
       grant.grant_id AS grantId,
       grant.execution_id AS executionId,
       grant.attempt_seq AS attemptSeq,
       grant.room_id AS roomId,
       grant.tool_id AS toolId,
       grant.parameter_sha256 AS parameterSha256,
       grant.consumed_at AS consumedAt,
       grant.grant_state AS grantState,
       grant.grant_revision AS grantRevision,
       execution.room_id AS executionRoomId,
       execution.current_attempt_seq AS currentAttemptSeq,
       attempt.status AS attemptStatus
     FROM agent_execution_grants AS grant
     LEFT JOIN agent_executions AS execution ON execution.id = grant.execution_id
     LEFT JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = grant.execution_id
      AND attempt.attempt_seq = grant.attempt_seq
     WHERE grant.room_id = ?
     ORDER BY grant.grant_id`,
  ).all(roomId) as unknown as readonly GrantBindingRow[];
  for (const row of rows) {
    if (!isNonEmptyString(row.grantId) || !isNonEmptyString(row.executionId) ||
        !isPositiveInteger(row.attemptSeq) || row.roomId !== roomId ||
        !isNonEmptyString(row.toolId) || typeof row.parameterSha256 !== "string" ||
        !PARAMETER_HASH.test(row.parameterSha256) ||
        !["active", "claimed", "revoked", "expired"].includes(row.grantState as string) ||
        !isNonNegativeInteger(row.grantRevision) || row.executionRoomId !== roomId ||
        !isPositiveInteger(row.currentAttemptSeq) || !isNonEmptyString(row.attemptStatus)) {
      throw new Error("Tool grant binding is corrupt");
    }
    if (row.grantState === "active" && row.consumedAt !== null) {
      throw new Error("Active grant is already consumed");
    }
    if (row.grantState === "claimed" && !isNonEmptyString(row.consumedAt)) {
      throw new Error("Claimed grant is missing consumption evidence");
    }
  }
}

function validateDispatches(database: DatabaseSync, roomId: string): readonly DispatchRow[] {
  const rows = database.prepare(
    `SELECT dispatch.dispatch_id AS dispatchId,
            dispatch.execution_id AS executionId,
            dispatch.attempt_seq AS attemptSeq,
            dispatch.grant_id AS grantId,
            dispatch.state,
            execution.room_id AS executionRoomId
     FROM tool_dispatches AS dispatch
     LEFT JOIN agent_executions AS execution ON execution.id = dispatch.execution_id
     WHERE execution.room_id = ?
     ORDER BY dispatch.dispatch_id`,
  ).all(roomId) as unknown as readonly DispatchRow[];
  for (const row of rows) {
    if (!isNonEmptyString(row.dispatchId) || !isNonEmptyString(row.executionId) ||
        !isPositiveInteger(row.attemptSeq) || !isNonEmptyString(row.grantId) ||
        typeof row.state !== "string" || !DISPATCH_STATES.has(row.state) ||
        row.executionRoomId !== roomId) {
      throw new Error("Tool dispatch evidence is corrupt");
    }
  }
  return rows;
}

function insertMember(
  database: DatabaseSync,
  input: Readonly<{
    roomId: string;
    archiveGeneration: number;
    subjectKind: "confirmation" | "grant" | "execution" | "dispatch";
    subjectId: string;
    disposition: "rejected_pending" | "revoked_unclaimed" | "fenced_waiting" | "preserved_dispatched";
    now: string;
  }>,
): void {
  database.prepare(
    `INSERT INTO tool_archive_settlement_members (
       room_id, archive_generation, subject_kind, subject_id, disposition, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.roomId,
    input.archiveGeneration,
    input.subjectKind,
    input.subjectId,
    input.disposition,
    input.now,
  );
}

function readResult(
  database: DatabaseSync,
  roomId: string,
  archiveGeneration: number,
): ArchiveSettlementResult {
  const row = database.prepare(
    `SELECT rejected_pending_count AS rejectedPendingCount,
            revoked_grant_count AS revokedGrantCount,
            fenced_waiting_count AS fencedWaitingCount,
            preserved_dispatched_count AS preservedDispatchedCount
     FROM tool_archive_settlements
     WHERE room_id = ? AND archive_generation = ?`,
  ).get(roomId, archiveGeneration) as SettlementCountRow | undefined;
  const counts = [
    row?.rejectedPendingCount,
    row?.revokedGrantCount,
    row?.fencedWaitingCount,
    row?.preservedDispatchedCount,
  ];
  if (!counts.every(isNonNegativeInteger)) {
    throw new Error("Tool archive settlement counts are corrupt");
  }
  const memberCounts = database.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN disposition = 'rejected_pending' THEN 1 ELSE 0 END), 0)
         AS rejectedPendingCount,
       COALESCE(SUM(CASE WHEN disposition = 'revoked_unclaimed' THEN 1 ELSE 0 END), 0)
         AS revokedGrantCount,
       COALESCE(SUM(CASE WHEN disposition = 'fenced_waiting' THEN 1 ELSE 0 END), 0)
         AS fencedWaitingCount,
       COALESCE(SUM(CASE WHEN disposition = 'preserved_dispatched' THEN 1 ELSE 0 END), 0)
         AS preservedDispatchedCount
     FROM tool_archive_settlement_members
     WHERE room_id = ? AND archive_generation = ?`,
  ).get(roomId, archiveGeneration) as SettlementCountRow | undefined;
  const durableCounts = [
    memberCounts?.rejectedPendingCount,
    memberCounts?.revokedGrantCount,
    memberCounts?.fencedWaitingCount,
    memberCounts?.preservedDispatchedCount,
  ];
  if (!durableCounts.every(isNonNegativeInteger) ||
      durableCounts.some((value, index) => value !== counts[index])) {
    throw new Error("Tool archive settlement ledger is corrupt");
  }
  return Object.freeze({
    roomId,
    archiveGeneration,
    rejectedPendingCount: counts[0] as number,
    revokedGrantCount: counts[1] as number,
    fencedWaitingCount: counts[2] as number,
    preservedDispatchedCount: counts[3] as number,
  });
}

function settleDatabase(
  database: DatabaseSync,
  input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
): ArchiveSettlementResult {
  if (!validateRoom(database, input)) {
    throw new ArchiveSettlementInputMismatchError();
  }
  const previous = database.prepare(
    `SELECT 1 AS present FROM tool_archive_settlements
     WHERE room_id = ? AND archive_generation = ?`,
  ).get(input.roomId, input.archiveGeneration);
  if (previous?.present === 1) {
    return readResult(database, input.roomId, input.archiveGeneration);
  }
  const future = database.prepare(
    `SELECT 1 AS present FROM tool_archive_settlements
     WHERE room_id = ? AND archive_generation > ? LIMIT 1`,
  ).get(input.roomId, input.archiveGeneration);
  if (future?.present === 1) {
    throw new Error("Tool archive settlement generation is stale");
  }

  validateConfirmationBindings(database, input.roomId);
  validateGrantBindings(database, input.roomId);
  const dispatches = validateDispatches(database, input.roomId);
  const waitingRows = database.prepare(
    `SELECT execution.id AS executionId,
            execution.current_attempt_seq AS currentAttemptSeq,
            execution.status,
            execution.action_category AS actionCategory,
            execution.tool_dispatch_phase AS toolDispatchPhase,
            attempt.status AS attemptStatus,
            attempt.action_category AS attemptActionCategory
     FROM agent_executions AS execution
     LEFT JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = execution.id
      AND attempt.attempt_seq = execution.current_attempt_seq
     WHERE execution.room_id = ?
       AND execution.status IN ('queued', 'running')
       AND (
         execution.action_category = 'waiting_upstream'
         OR (
           execution.action_category = 'tool_call'
           AND execution.tool_dispatch_phase = 'not_started'
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM tool_dispatches AS dispatch
         WHERE dispatch.execution_id = execution.id
       )
     ORDER BY execution.id`,
  ).all(input.roomId) as unknown as readonly WaitingExecutionRow[];
  for (const row of waitingRows) {
    if (!isNonEmptyString(row.executionId) || !isPositiveInteger(row.currentAttemptSeq) ||
        (row.status !== "queued" && row.status !== "running") ||
        (row.actionCategory !== "waiting_upstream" && row.actionCategory !== "tool_call") ||
        (row.actionCategory === "waiting_upstream" && row.toolDispatchPhase !== null) ||
        (row.actionCategory === "tool_call" && row.toolDispatchPhase !== "not_started") ||
        (row.attemptStatus !== "queued" && row.attemptStatus !== "running") ||
        row.attemptActionCategory !== row.actionCategory) {
      throw new Error("Tool waiting execution is corrupt");
    }
  }

  database.prepare(
    `INSERT INTO tool_archive_settlements (
       room_id, archive_generation, settled_at
     ) VALUES (?, ?, ?)`,
  ).run(input.roomId, input.archiveGeneration, input.now);

  const pending = database.prepare(
    `SELECT confirmation_id AS confirmationId
     FROM tool_confirmations
     WHERE room_id = ? AND confirmation_state = 'pending' AND consumed_at IS NULL
     ORDER BY confirmation_id`,
  ).all(input.roomId) as unknown as readonly { readonly confirmationId: string }[];
  for (const row of pending) {
    const transition = database.prepare(
      `UPDATE tool_confirmations
       SET confirmation_state = 'rejected', confirmation_reason = ?,
           confirmation_revision = confirmation_revision + 1,
           confirmation_changed_at = ?
       WHERE confirmation_id = ?
         AND confirmation_state = 'pending' AND consumed_at IS NULL`,
    ).run(ARCHIVE_REASON, input.now, row.confirmationId);
    if (transition.changes !== 1) throw new Error("Pending confirmation archive CAS was stale");
    insertMember(database, {
      ...input,
      subjectKind: "confirmation",
      subjectId: row.confirmationId,
      disposition: "rejected_pending",
    });
  }

  const activeGrants = database.prepare(
    `SELECT grant_id AS grantId
     FROM agent_execution_grants
     WHERE room_id = ? AND grant_state = 'active' AND consumed_at IS NULL
     ORDER BY grant_id`,
  ).all(input.roomId) as unknown as readonly { readonly grantId: string }[];
  for (const row of activeGrants) {
    const transition = database.prepare(
      `UPDATE agent_execution_grants
       SET grant_state = 'revoked', grant_reason = ?,
           grant_revision = grant_revision + 1, grant_changed_at = ?
       WHERE grant_id = ? AND grant_state = 'active' AND consumed_at IS NULL`,
    ).run(ARCHIVE_REASON, input.now, row.grantId);
    if (transition.changes !== 1) throw new Error("Active grant archive CAS was stale");
    insertMember(database, {
      ...input,
      subjectKind: "grant",
      subjectId: row.grantId,
      disposition: "revoked_unclaimed",
    });
  }

  for (const row of waitingRows) {
    const executionId = row.executionId as string;
    const currentAttemptSeq = row.currentAttemptSeq as number;
    const attempt = database.prepare(
      `UPDATE agent_execution_attempts
       SET status = 'cancelled', finished_at = ?, error_code = ?, next_retry_at = NULL
       WHERE execution_id = ? AND attempt_seq = ? AND status IN ('queued', 'running')`,
    ).run(input.now, ARCHIVE_REASON, executionId, currentAttemptSeq);
    const execution = database.prepare(
      `UPDATE agent_executions
       SET status = 'cancelled', completed_at = ?, updated_at = ?,
           cancellation_reason = ?, terminal_error_code = NULL,
           dead_lettered_at = NULL, next_retry_at = NULL
       WHERE id = ? AND current_attempt_seq = ? AND status IN ('queued', 'running')`,
    ).run(input.now, input.now, ARCHIVE_REASON, executionId, currentAttemptSeq);
    if (attempt.changes !== 1 || execution.changes !== 1) {
      throw new Error("Tool waiting execution archive CAS was stale");
    }
    insertMember(database, {
      ...input,
      subjectKind: "execution",
      subjectId: executionId,
      disposition: "fenced_waiting",
    });
  }

  for (const row of dispatches) {
    insertMember(database, {
      ...input,
      subjectKind: "dispatch",
      subjectId: row.dispatchId as string,
      disposition: "preserved_dispatched",
    });
  }

  const counts = database.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN disposition = 'rejected_pending' THEN 1 ELSE 0 END), 0)
         AS rejectedPendingCount,
       COALESCE(SUM(CASE WHEN disposition = 'revoked_unclaimed' THEN 1 ELSE 0 END), 0)
         AS revokedGrantCount,
       COALESCE(SUM(CASE WHEN disposition = 'fenced_waiting' THEN 1 ELSE 0 END), 0)
         AS fencedWaitingCount,
       COALESCE(SUM(CASE WHEN disposition = 'preserved_dispatched' THEN 1 ELSE 0 END), 0)
         AS preservedDispatchedCount
     FROM tool_archive_settlement_members
     WHERE room_id = ? AND archive_generation = ?`,
  ).get(input.roomId, input.archiveGeneration) as SettlementCountRow | undefined;
  if (!counts || ![
    counts.rejectedPendingCount,
    counts.revokedGrantCount,
    counts.fencedWaitingCount,
    counts.preservedDispatchedCount,
  ].every(isNonNegativeInteger)) {
    throw new Error("Tool archive settlement member counts are corrupt");
  }
  database.prepare(
    `UPDATE tool_archive_settlements
     SET rejected_pending_count = ?, revoked_grant_count = ?,
         fenced_waiting_count = ?, preserved_dispatched_count = ?
     WHERE room_id = ? AND archive_generation = ?`,
  ).run(
    counts.rejectedPendingCount as number,
    counts.revokedGrantCount as number,
    counts.fencedWaitingCount as number,
    counts.preservedDispatchedCount as number,
    input.roomId,
    input.archiveGeneration,
  );
  return readResult(database, input.roomId, input.archiveGeneration);
}

function settleUndispatched(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
): AuthorityParticipantEnvelope<ArchiveSettlementResult> {
  if (!isNonEmptyString(input.roomId) || !isPositiveInteger(input.archiveGeneration) ||
      !isNonEmptyString(input.now) || transaction.roomId !== input.roomId) {
    return fail("transaction_mismatch");
  }
  try {
    const result = useAuthorityTransactionDatabase(
      transaction,
      (database) => settleDatabase(database, input),
    );
    return Object.freeze({ ok: true as const, result });
  } catch (error: unknown) {
    return fail(error instanceof ArchiveSettlementInputMismatchError
      ? "transaction_mismatch"
      : "participant_threw");
  }
}

export function createArchiveToolSafetyParticipant(): ArchiveSettlementParticipant {
  return Object.freeze({ settleUndispatched });
}

const productionParticipant = createArchiveToolSafetyParticipant();

export const archiveToolSafetyParticipantRegistration = Object.freeze({
  registrationId: REGISTRATION_ID,
  feature: FEATURE,
  version: AUTHORITY_PARTICIPANT_VERSION,
  enabled: true,
  participant: productionParticipant,
}) satisfies ParticipantRegistration<ArchiveSettlementParticipant>;
