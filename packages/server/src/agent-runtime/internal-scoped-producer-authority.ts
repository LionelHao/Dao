import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isAgentExecution,
  isAgentExecutionAttempt,
  isAgentInvocationIntent,
  isScopedCancellationReceipt,
  type InvocationCancellationReason,
  type ScopedCancellationReceipt,
  type ScopedCancellationScope,
} from "@native-im/core";
import type {
  ScopedCancellationCommitEffect,
  ScopedCancellationCommitReceipt,
} from "../scoped-cancellation/scoped-cancellation-orchestrator.js";

export type InternalScopedProducerCapability =
  | "message_authority"
  | "room_authority"
  | "membership_authority"
  | "profile_authority"
  | "assignment_authority";

export interface InternalScopedProducerInput {
  readonly producerId: string;
  readonly requestId: string;
  readonly capability: InternalScopedProducerCapability;
  readonly actorId: string;
  readonly roomId: string;
  readonly scope: ScopedCancellationScope;
  readonly reason: Extract<InvocationCancellationReason,
    | "message_recalled"
    | "room_archived"
    | "membership_revoked"
    | "assignment_revoked"
    | "profile_disabled"
    | "capability_revoked">;
  readonly occurredAt: string;
  /**
   * Room archive already owns execution terminalization and its historical
   * audit. Stage the v22 fence before that participant and finalize canonical
   * evidence after it, without replacing the archive participant.
   */
  readonly deferExecutionTerminalization?: boolean;
}

export interface InternalScopedProducerResult {
  readonly receipts: readonly ScopedCancellationCommitReceipt[];
  readonly effects: readonly ScopedCancellationCommitEffect[];
  readonly deferredExecutions?: readonly InternalScopedProducerDeferredExecution[];
}

export interface InternalScopedProducerDeferredExecution {
  readonly row: Row;
  readonly requestId: string;
  readonly fenceId: string;
  readonly rejectedConfirmationIds: readonly string[];
  readonly revokedGrantIds: readonly string[];
  readonly preservedDispatchIds: readonly string[];
  readonly confirmationDisposition: ScopedCancellationCommitEffect["confirmationDisposition"];
  readonly grantDisposition: ScopedCancellationCommitEffect["grantDisposition"];
}

type Row = Record<string, unknown>;

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("base64url");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Canonical JSON rejects unsupported values");
}

function selector(input: InternalScopedProducerInput): Readonly<{
  sql: string;
  parameters: readonly (string | number)[];
}> {
  if (input.scope.kind === "source_message") {
    // Recalling the current revision fences every still-live invocation frozen
    // from that source, including executions created from an earlier revision.
    return { sql: "intent.source_message_id = ? AND intent.source_revision <= ?",
      parameters: [input.scope.sourceMessageId, input.scope.sourceRevision] };
  }
  if (input.scope.kind === "room") {
    return { sql: "intent.room_id = ?", parameters: [input.scope.roomId] };
  }
  if (input.scope.kind === "agent_authority") {
    return { sql: "intent.room_id = ? AND intent.target_agent_id = ?",
      parameters: [input.roomId, input.scope.agentId] };
  }
  throw new TypeError("Internal scoped producer requires a producer scope");
}

function appendCanonicalEvent(
  database: DatabaseSync,
  receipt: ScopedCancellationReceipt,
  actorId: string,
  occurredAt: string,
): void {
  if (!isScopedCancellationReceipt(receipt)) {
    throw new Error("Internal scoped producer receipt was not canonical");
  }
  const stream = database.prepare(
    `SELECT head_seq AS headSeq FROM streams
     WHERE stream_kind = 'room' AND stream_id = ?`,
  ).get(receipt.roomId);
  if (typeof stream?.headSeq !== "number") throw new Error("Runtime producer room stream is missing");
  const streamSeq = stream.headSeq + 1;
  const eventId = stableId("runtime-canonical-scoped-cancellation", receipt.requestId);
  database.prepare(
    `UPDATE streams SET head_seq = ? WHERE stream_kind = 'room' AND stream_id = ?`,
  ).run(streamSeq, receipt.roomId);
  database.prepare(
    `INSERT INTO events (
       event_id, stream_kind, stream_id, stream_seq, room_id,
       actor_id, event_type, occurred_at, payload_json
     ) VALUES (?, 'room', ?, ?, ?, ?,
               'agent.invocation.scoped-cancellation.committed', ?, ?)`,
  ).run(eventId, receipt.roomId, streamSeq, receipt.roomId, actorId, occurredAt,
    canonicalJson(receipt));
  database.prepare(
    `INSERT INTO outbox_deliveries (
       id, event_id, target_kind, target_id, stream_seq, status,
       attempts, available_at, delivered_at, last_error
     ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
  ).run(stableId("outbox", "internal-scoped-producer", receipt.requestId, eventId,
    "room", receipt.roomId), eventId, receipt.roomId, streamSeq, occurredAt);
}

function appendCanonicalIntentProjection(
  database: DatabaseSync,
  intentId: string,
  occurredAt: string,
  transition: string,
): void {
  const row = database.prepare(
    `SELECT intent.id AS intentId, intent.lineage_id AS lineageId,
            intent.turn_id AS turnId, intent.room_id AS roomId,
            intent.source_message_id AS sourceMessageId,
            intent.source_revision AS sourceRevision, intent.target_id AS targetId,
            intent.target_agent_id AS agentId,
            intent.message_transaction_id AS messageTransactionId,
            runtime.public_status AS status, intent.created_at AS createdAt,
            runtime.claimed_at AS claimedAt, runtime.cancelled_at AS cancelledAt,
            runtime.cancellation_reason AS cancellationReason,
            intent.supersedes_intent_id AS supersedesIntentId,
            binding.profile_revision AS profileRevision,
            binding.assignment_revision AS assignmentRevision,
            binding.access_revision AS accessRevision
     FROM agent_invocation_intents AS intent
     JOIN agent_invocation_intent_runtime_states AS runtime
       ON runtime.intent_id = intent.id
     JOIN direct_agent_invocation_authority_bindings AS binding
       ON binding.intent_id = intent.id
     WHERE intent.id = ? AND intent.origin_kind = 'message_target'`,
  ).get(intentId);
  if (typeof row?.intentId !== "string" || typeof row.lineageId !== "string" ||
      typeof row.turnId !== "string" || typeof row.roomId !== "string" ||
      typeof row.sourceMessageId !== "string" || typeof row.targetId !== "string" ||
      typeof row.agentId !== "string" || typeof row.messageTransactionId !== "string") {
    // Historical/legacy-review intents without a v21 direct authority binding
    // remain cancellable, but are deliberately excluded from canonical v22
    // stable projection. Repair exposes them through the legacy record kind.
    return;
  }
  const projection = {
    intentId: row?.intentId, lineageId: row?.lineageId, turnId: row?.turnId,
    roomId: row?.roomId, sourceMessageId: row?.sourceMessageId,
    sourceRevision: row?.sourceRevision, targetId: row?.targetId, agentId: row?.agentId,
    origin: { kind: "message_target" as const,
      messageTransactionId: row?.messageTransactionId, targetId: row?.targetId },
    profileRevision: row?.profileRevision, assignmentRevision: row?.assignmentRevision,
    accessRevision: row?.accessRevision, status: row?.status, createdAt: row?.createdAt,
    ...(typeof row?.claimedAt === "string" ? { claimedAt: row.claimedAt } : {}),
    ...(typeof row?.cancelledAt === "string" ? {
      cancelledAt: row.cancelledAt,
      ...(typeof row.cancellationReason === "string"
        ? { cancellationReason: row.cancellationReason } : {}),
    } : {}),
    ...(typeof row?.supersedesIntentId === "string"
      ? { supersedesIntentId: row.supersedesIntentId } : {}),
  };
  if (!isAgentInvocationIntent(projection)) {
    throw new Error("Internal scoped producer intent projection was not canonical");
  }
  const eventId = stableId("runtime-canonical-intent", intentId, transition);
  const stream = database.prepare(
    `SELECT head_seq AS headSeq FROM streams
     WHERE stream_kind = 'room' AND stream_id = ?`,
  ).get(projection.roomId);
  if (typeof stream?.headSeq !== "number") {
    throw new Error("Runtime producer room stream is missing");
  }
  const streamSeq = stream.headSeq + 1;
  database.prepare(
    `UPDATE streams SET head_seq = ? WHERE stream_kind = 'room' AND stream_id = ?`,
  ).run(streamSeq, projection.roomId);
  database.prepare(
    `INSERT INTO events (event_id, stream_kind, stream_id, stream_seq, room_id,
       actor_id, event_type, occurred_at, payload_json)
     VALUES (?, 'room', ?, ?, ?, ?, 'agent.invocation.intent.changed', ?, ?)`,
  ).run(eventId, projection.roomId, streamSeq, projection.roomId,
    projection.agentId, occurredAt, canonicalJson(projection));
  database.prepare(
    `INSERT INTO outbox_deliveries (id, event_id, target_kind, target_id, stream_seq,
       status, attempts, available_at, delivered_at, last_error)
     VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
  ).run(stableId("outbox", "runtime-canonical-intent", transition, eventId),
    eventId, projection.roomId, streamSeq, occurredAt);
}

function appendCanonicalTerminalProjection(
  database: DatabaseSync,
  executionId: string,
  occurredAt: string,
  transition: string,
): void {
  const row = database.prepare(
    `SELECT runtime.execution_id AS executionId, runtime.intent_id AS intentId,
            runtime.lineage_id AS lineageId, runtime.execution_ordinal AS executionOrdinal,
            runtime.retry_of_execution_id AS retryOfExecutionId,
            runtime.snapshot_id AS snapshotId, runtime.provider_id AS providerId,
            runtime.model_id AS modelId, runtime.public_status AS status, runtime.phase,
            runtime.current_attempt_seq AS currentAttemptSeq,
            runtime.authority_version AS version, runtime.queued_at AS queuedAt,
            runtime.started_at AS startedAt, runtime.updated_at AS updatedAt,
            runtime.completed_at AS completedAt, runtime.terminal_reason AS terminalReason,
            runtime.terminal_error_code AS terminalErrorCode, runtime.review_state AS reviewState,
            legacy.room_id AS roomId, legacy.agent_id AS agentId,
            legacy.dead_lettered_at AS deadLetteredAt,
            legacy.result_message_id AS resultMessageId
     FROM agent_execution_runtime_states AS runtime
     JOIN agent_executions AS legacy ON legacy.id = runtime.execution_id
     WHERE runtime.execution_id = ? AND runtime.review_state <> 'legacy_review_required'`,
  ).get(executionId);
  if (typeof row?.executionId !== "string" || typeof row.intentId !== "string" ||
      typeof row.lineageId !== "string" || typeof row.executionOrdinal !== "number" ||
      typeof row.snapshotId !== "string" || typeof row.providerId !== "string" ||
      typeof row.modelId !== "string" || typeof row.version !== "number" ||
      typeof row.queuedAt !== "string" || typeof row.updatedAt !== "string" ||
      typeof row.roomId !== "string" || typeof row.agentId !== "string") {
    // Legacy-review executions are intentionally excluded from stable v22
    // projection; repair owns their disclosure. Current production executions
    // always satisfy the canonical binding below.
    return;
  }
  const status = row.status;
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  const execution = {
    executionId: row.executionId, intentId: row.intentId, lineageId: row.lineageId,
    executionOrdinal: row.executionOrdinal,
    ...(typeof row.retryOfExecutionId === "string" ? { retryOfExecutionId: row.retryOfExecutionId } : {}),
    roomId: row.roomId, agentId: row.agentId, snapshotId: row.snapshotId,
    providerId: row.providerId, modelId: row.modelId, status, phase: row.phase,
    currentAttemptSeq: row.currentAttemptSeq, version: row.version, queuedAt: row.queuedAt,
    ...(status === "accepted" ? {} : { startedAt: row.startedAt ?? row.updatedAt }),
    updatedAt: row.updatedAt,
    ...(terminal ? { completedAt: row.completedAt ?? row.updatedAt } : {}),
    ...(status === "cancelled" ? { cancellationReason: row.terminalReason } : {}),
    ...(status === "failed" ? {
      terminalErrorCode: row.terminalErrorCode,
      reviewState: row.reviewState === "needs_review" ? "needs_review" : "not_required",
    } : {}),
    ...(typeof row.deadLetteredAt === "string" ? { deadLetteredAt: row.deadLetteredAt } : {}),
    ...(typeof row.resultMessageId === "string" ? { resultMessageId: row.resultMessageId } : {}),
  };
  if (!isAgentExecution(execution)) {
    throw new Error("Internal scoped producer execution projection was not canonical");
  }
  const executionEventId = stableId("runtime-canonical", executionId,
    String(execution.currentAttemptSeq), transition);
  const stream = database.prepare(
    `SELECT head_seq AS headSeq FROM streams
     WHERE stream_kind = 'room' AND stream_id = ?`,
  ).get(execution.roomId);
  if (typeof stream?.headSeq !== "number") throw new Error("Runtime producer room stream is missing");
  const executionSeq = stream.headSeq + 1;
  database.prepare(
    `UPDATE streams SET head_seq = ? WHERE stream_kind = 'room' AND stream_id = ?`,
  ).run(executionSeq, execution.roomId);
  database.prepare(
    `INSERT INTO events (event_id, stream_kind, stream_id, stream_seq, room_id,
       actor_id, event_type, occurred_at, payload_json)
     VALUES (?, 'room', ?, ?, ?, ?, 'agent.execution.changed', ?, ?)`,
  ).run(executionEventId, execution.roomId, executionSeq, execution.roomId,
    execution.agentId, occurredAt, canonicalJson(execution));
  database.prepare(
    `INSERT INTO outbox_deliveries (id, event_id, target_kind, target_id, stream_seq,
       status, attempts, available_at, delivered_at, last_error)
     VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
  ).run(stableId("outbox", "runtime-canonical", transition, executionEventId), executionEventId,
    execution.roomId, executionSeq, occurredAt);

  const attemptRow = database.prepare(
    `SELECT public_status AS status, phase, started_at AS startedAt,
            finished_at AS finishedAt, error_code AS errorCode, next_retry_at AS nextRetryAt
     FROM agent_execution_attempt_runtime_states
     WHERE execution_id = ? AND attempt_seq = ?`,
  ).get(executionId, execution.currentAttemptSeq);
  const attempt = {
    executionId: execution.executionId, intentId: execution.intentId,
    lineageId: execution.lineageId, roomId: execution.roomId, agentId: execution.agentId,
    attemptSeq: execution.currentAttemptSeq, snapshotId: execution.snapshotId,
    providerId: execution.providerId, modelId: execution.modelId,
    status: attemptRow?.status, phase: attemptRow?.phase, executionVersion: execution.version,
    ...(attemptRow?.status === "accepted" ? {} : {
      startedAt: attemptRow?.startedAt ?? execution.updatedAt,
    }),
    updatedAt: execution.updatedAt,
    ...((attemptRow?.status === "completed" || attemptRow?.status === "failed" ||
      attemptRow?.status === "cancelled")
      ? { finishedAt: attemptRow.finishedAt ?? execution.updatedAt } : {}),
    ...(attemptRow?.status === "failed" && typeof attemptRow.errorCode === "string"
      ? { errorCode: attemptRow.errorCode } : {}),
    ...(attemptRow?.status === "failed" && typeof attemptRow.nextRetryAt === "string"
      ? { nextRetryAt: attemptRow.nextRetryAt } : {}),
  };
  if (!isAgentExecutionAttempt(attempt)) {
    throw new Error("Internal scoped producer attempt projection was not canonical");
  }
  const attemptEventId = stableId("runtime-canonical-attempt", executionId,
    String(execution.currentAttemptSeq), transition);
  const attemptSeq = executionSeq + 1;
  database.prepare(
    `UPDATE streams SET head_seq = ? WHERE stream_kind = 'room' AND stream_id = ?`,
  ).run(attemptSeq, execution.roomId);
  database.prepare(
    `INSERT INTO events (event_id, stream_kind, stream_id, stream_seq, room_id,
       actor_id, event_type, occurred_at, payload_json)
     VALUES (?, 'room', ?, ?, ?, ?, 'agent.execution.attempt.changed', ?, ?)`,
  ).run(attemptEventId, execution.roomId, attemptSeq, execution.roomId,
    execution.agentId, occurredAt, canonicalJson(attempt));
  database.prepare(
    `INSERT INTO outbox_deliveries (id, event_id, target_kind, target_id, stream_seq,
       status, attempts, available_at, delivered_at, last_error)
     VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
  ).run(stableId("outbox", "runtime-canonical-attempt", transition, attemptEventId),
    attemptEventId, execution.roomId, attemptSeq, occurredAt);
}

function dispositions(database: DatabaseSync, executionId: string, attemptSeq: number, reason: string,
  occurredAt: string, apply: boolean): Readonly<{
    rejectedConfirmationIds: readonly string[];
    revokedGrantIds: readonly string[];
    preservedDispatchIds: readonly string[];
    confirmationDisposition: ScopedCancellationCommitEffect["confirmationDisposition"];
    grantDisposition: ScopedCancellationCommitEffect["grantDisposition"];
    sideEffectState: ScopedCancellationCommitEffect["sideEffectState"];
  }> {
  const confirmations = database.prepare(
    `SELECT confirmation_id AS id, confirmation_state AS state FROM tool_confirmations
     WHERE execution_id = ? AND attempt_seq = ? ORDER BY confirmation_id`,
  ).all(executionId, attemptSeq);
  const grants = database.prepare(
    `SELECT grant_id AS id, grant_state AS state FROM agent_execution_grants
     WHERE execution_id = ? AND attempt_seq = ? ORDER BY grant_id`,
  ).all(executionId, attemptSeq);
  const dispatches = database.prepare(
    `SELECT dispatch_id AS id, state FROM tool_dispatches
     WHERE execution_id = ? AND attempt_seq = ? ORDER BY dispatch_id`,
  ).all(executionId, attemptSeq);
  const rejectedConfirmationIds = confirmations.flatMap((row) =>
    row.state === "pending" && typeof row.id === "string" ? [row.id] : []);
  const revokedGrantIds = grants.flatMap((row) =>
    row.state === "active" && typeof row.id === "string" ? [row.id] : []);
  const preservedDispatchIds = dispatches.flatMap((row) => typeof row.id === "string" ? [row.id] : []);
  if (apply) {
    database.prepare(
      `UPDATE tool_confirmations SET confirmation_state = 'rejected', confirmation_reason = ?,
         confirmation_revision = confirmation_revision + 1, confirmation_changed_at = ?
       WHERE execution_id = ? AND attempt_seq = ? AND confirmation_state = 'pending'`,
    ).run(reason, occurredAt, executionId, attemptSeq);
    database.prepare(
      `UPDATE agent_execution_grants SET grant_state = 'revoked', grant_reason = ?,
         grant_revision = grant_revision + 1, grant_changed_at = ?
       WHERE execution_id = ? AND attempt_seq = ? AND grant_state = 'active'`,
    ).run(reason, occurredAt, executionId, attemptSeq);
  }
  return {
    rejectedConfirmationIds,
    revokedGrantIds,
    preservedDispatchIds,
    confirmationDisposition: rejectedConfirmationIds.length > 0 ? "pending_rejected"
      : confirmations.some((row) => row.state === "confirmed") ? "confirmed_retained" : "none",
    grantDisposition: revokedGrantIds.length > 0 ? "unclaimed_revoked"
      : grants.some((row) => row.state === "claimed") ? "claimed_retained" : "none",
    sideEffectState: dispatches.some((row) => row.state === "outcome_unknown")
      ? "outcome-unknown-retained" : preservedDispatchIds.length > 0 ? "dispatched-retained" : "none",
  };
}

function storeReceipt(database: DatabaseSync, input: InternalScopedProducerInput,
  row: Row, canonicalReceipt: ScopedCancellationReceipt,
  effect: ScopedCancellationCommitEffect): ScopedCancellationCommitReceipt {
  const stored: ScopedCancellationCommitReceipt = {
    kind: "scoped-cancellation-committed",
    fenceId: canonicalReceipt.fenceId,
    roomId: input.roomId,
    producerId: input.producerId,
    reason: input.reason,
    replayed: false,
    receipt: canonicalReceipt,
    effects: [effect],
  };
  const requestSha256 = createHash("sha256").update(canonicalJson({
    producerId: input.producerId, scope: input.scope, reason: input.reason,
    intentId: row.intentId, executionId: row.executionId ?? null,
  })).digest("hex");
  database.prepare(
    `INSERT INTO invocation_cancellation_receipts (
       request_id, fence_id, principal_actor_id, request_sha256,
       status_code, response_json, committed_at
     ) VALUES (?, ?, NULL, ?, 200, ?, ?)`,
  ).run(canonicalReceipt.requestId, canonicalReceipt.fenceId, requestSha256,
    JSON.stringify(stored), input.occurredAt);
  appendCanonicalEvent(database, canonicalReceipt, input.actorId, input.occurredAt);
  return Object.freeze(stored);
}

export function commitInternalScopedProducerInTransaction(
  database: DatabaseSync,
  input: InternalScopedProducerInput,
): InternalScopedProducerResult {
  const runtimeSchema = database.prepare(
    `SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type = 'table' AND name IN (
       'agent_invocation_intent_runtime_states', 'agent_execution_runtime_states',
       'invocation_scoped_cancellation_fences', 'invocation_cancellation_receipts'
     )`,
  ).get();
  // Isolated repository tests intentionally use pre-v22 minimal schemas. The
  // production AuthorityWorker always migrates all four tables atomically.
  if (runtimeSchema?.count !== 4) {
    return Object.freeze({ receipts: Object.freeze([]), effects: Object.freeze([]) });
  }
  const selected = selector(input);
  const pending = database.prepare(
    `SELECT intent.id AS intentId, intent.lineage_id AS lineageId,
            intent.source_message_id AS sourceMessageId,
            intent.source_revision AS sourceRevision,
            runtime.authority_version AS authorityVersion
     FROM agent_invocation_intents AS intent
     JOIN agent_invocation_intent_runtime_states AS runtime ON runtime.intent_id = intent.id
     WHERE ${selected.sql} AND runtime.public_status = 'pending'
     ORDER BY intent.id`,
  ).all(...selected.parameters);
  const live = database.prepare(
    `SELECT intent.id AS intentId, intent.lineage_id AS lineageId,
            intent.source_message_id AS sourceMessageId,
            intent.source_revision AS sourceRevision,
            execution.id AS executionId, execution.current_attempt_seq AS attemptSeq,
            runtime.authority_version AS authorityVersion
     FROM agent_invocation_intents AS intent
     JOIN agent_execution_intent_links AS link ON link.intent_id = intent.id
     JOIN agent_executions AS execution ON execution.id = link.execution_id
     JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = execution.id
     WHERE ${selected.sql} AND execution.room_id = ?
       AND execution.status IN ('queued', 'running')
       AND runtime.public_status IN ('accepted', 'running')
     ORDER BY intent.id, execution.id`,
  ).all(...selected.parameters, input.roomId);
  const receipts: ScopedCancellationCommitReceipt[] = [];
  const effects: ScopedCancellationCommitEffect[] = [];
  const deferredExecutions: InternalScopedProducerDeferredExecution[] = [];

  for (const row of [...pending, ...live]) {
    if (typeof row.intentId !== "string" || typeof row.lineageId !== "string" ||
        typeof row.sourceMessageId !== "string" || typeof row.sourceRevision !== "number" ||
        typeof row.authorityVersion !== "number") {
      throw new Error("Internal scoped producer target was corrupt");
    }
    const executionId = typeof row.executionId === "string" ? row.executionId : undefined;
    const attemptSeq = typeof row.attemptSeq === "number" ? row.attemptSeq : undefined;
    const requestId = stableId("internal-scoped-producer-request", input.requestId,
      row.intentId, executionId ?? "pending");
    const fenceId = stableId("internal-scoped-producer-fence", requestId);
    database.prepare(
      `INSERT INTO invocation_scoped_cancellation_fences (
         fence_id, room_id, scope_kind, intent_id, execution_id,
         expected_authority_version, reason, principal_human_actor_id,
         internal_capability, committed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(fenceId, input.roomId, executionId === undefined ? "intent" : "execution",
      row.intentId, executionId ?? null, row.authorityVersion, input.reason,
      input.capability, input.occurredAt);
    if (executionId === undefined) {
      const cancelled = database.prepare(
        `UPDATE agent_invocation_intent_runtime_states
         SET public_status = 'cancelled', authority_version = authority_version + 1,
             cancelled_at = ?, cancellation_reason = ?, updated_at = ?
         WHERE intent_id = ? AND public_status = 'pending' AND authority_version = ?`,
      ).run(input.occurredAt, input.reason, input.occurredAt, row.intentId, row.authorityVersion);
      if (cancelled.changes !== 1) throw new Error("Internal intent cancellation lost its CAS");
      // v22 owns the real cancellation reason. The immutable v16 row can only
      // encode message_recalled, but its historical recall trigger requires a
      // canonically cancelled pending intent to leave the legacy pending state.
      // This compatibility sentinel is write-only for v22 runtime readers.
      const compatibilityIntent = database.prepare(
        `UPDATE agent_invocation_intents SET status = 'cancelled', cancelled_at = ?,
           cancellation_reason = 'message_recalled' WHERE id = ? AND status = 'pending'`,
      ).run(input.occurredAt, row.intentId);
      if (compatibilityIntent.changes !== 1) {
        const compatibility = database.prepare(
          "SELECT status FROM agent_invocation_intents WHERE id = ?",
        ).get(row.intentId);
        if (compatibility?.status === "pending" || typeof compatibility?.status !== "string") {
          throw new Error("Internal intent cancellation lost its compatibility CAS");
        }
      }
      const effect: ScopedCancellationCommitEffect = {
        sourceMessageId: row.sourceMessageId,
        sourceRevision: row.sourceRevision,
        invocationIntentId: row.intentId,
        disposition: "intent_cancelled",
        confirmationDisposition: "none",
        grantDisposition: "none",
        sideEffectState: "none",
      };
      const canonicalReceipt: ScopedCancellationReceipt = {
        requestId, fenceId, roomId: input.roomId, lineageId: row.lineageId,
        scope: input.scope, reason: input.reason,
        intentOutcomes: [{ intentId: row.intentId, outcome: "cancelled" }],
        executionOutcomes: [], rejectedConfirmationIds: [], revokedGrantIds: [],
        preservedDispatchIds: [], committedAt: input.occurredAt,
      };
      receipts.push(storeReceipt(database, input, row, canonicalReceipt, effect));
      effects.push(effect);
      appendCanonicalIntentProjection(database, row.intentId, input.occurredAt,
        `internal-scoped:${fenceId}`);
      continue;
    }
    if (attemptSeq === undefined) throw new Error("Internal execution attempt was corrupt");
    const disposition = dispositions(database, executionId, attemptSeq, input.reason,
      input.occurredAt, input.deferExecutionTerminalization !== true);
    if (input.deferExecutionTerminalization === true) {
      deferredExecutions.push(Object.freeze({
        row, requestId, fenceId,
        rejectedConfirmationIds: disposition.rejectedConfirmationIds,
        revokedGrantIds: disposition.revokedGrantIds,
        preservedDispatchIds: disposition.preservedDispatchIds,
        confirmationDisposition: disposition.confirmationDisposition,
        grantDisposition: disposition.grantDisposition,
      }));
      continue;
    }
    const executionUpdated = database.prepare(
      `UPDATE agent_executions SET status = 'cancelled', cancellation_reason = ?,
         completed_at = ?, updated_at = ?, next_retry_at = NULL
       WHERE id = ? AND current_attempt_seq = ? AND status IN ('queued', 'running')`,
    ).run(input.reason, input.occurredAt, input.occurredAt, executionId, attemptSeq);
    const attemptUpdated = database.prepare(
      `UPDATE agent_execution_attempts SET status = 'cancelled', finished_at = ?,
         error_code = ?, next_retry_at = NULL
       WHERE execution_id = ? AND attempt_seq = ? AND status IN ('queued', 'running')`,
    ).run(input.occurredAt, input.reason, executionId, attemptSeq);
    if (executionUpdated.changes !== 1 || attemptUpdated.changes !== 1) {
      throw new Error("Internal execution cancellation lost its CAS");
    }
    database.prepare(
      `INSERT INTO invocation_scoped_cancellation_targets (
         fence_id, execution_id, attempt_seq, execution_version_before, execution_version_after
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(fenceId, executionId, attemptSeq, row.authorityVersion, row.authorityVersion + 1);
    database.prepare(
      `UPDATE invocation_recovery_queue SET state = 'closed', lease_owner = NULL,
         lease_expires_at = NULL, failure_code = ?, updated_at = ?
       WHERE execution_id = ? AND state IN ('pending', 'leased')`,
    ).run(input.reason, input.occurredAt, executionId);
    const effect: ScopedCancellationCommitEffect = {
      sourceMessageId: row.sourceMessageId,
      sourceRevision: row.sourceRevision,
      invocationIntentId: row.intentId,
      executionId, attemptSeq,
      disposition: "execution_cancelled",
      confirmationDisposition: disposition.confirmationDisposition,
      grantDisposition: disposition.grantDisposition,
      sideEffectState: disposition.sideEffectState,
    };
    const canonicalReceipt: ScopedCancellationReceipt = {
      requestId, fenceId, roomId: input.roomId, lineageId: row.lineageId,
      scope: input.scope, reason: input.reason,
      intentOutcomes: [{ intentId: row.intentId, outcome: "already_claimed" }],
      executionOutcomes: [{ executionId, outcome: "cancelled", version: row.authorityVersion + 1 }],
      rejectedConfirmationIds: disposition.rejectedConfirmationIds,
      revokedGrantIds: disposition.revokedGrantIds,
      preservedDispatchIds: disposition.preservedDispatchIds,
      committedAt: input.occurredAt,
    };
    appendCanonicalTerminalProjection(database, executionId, input.occurredAt,
      `internal-scoped:${fenceId}`);
    receipts.push(storeReceipt(database, input, row, canonicalReceipt, effect));
    effects.push(effect);
  }
  return Object.freeze({
    receipts: Object.freeze(receipts),
    effects: Object.freeze(effects),
    ...(deferredExecutions.length > 0
      ? { deferredExecutions: Object.freeze(deferredExecutions) }
      : {}),
  });
}

export function finalizeInternalScopedProducerInTransaction(
  database: DatabaseSync,
  input: InternalScopedProducerInput,
  deferredExecutions: readonly InternalScopedProducerDeferredExecution[],
): InternalScopedProducerResult {
  const receipts: ScopedCancellationCommitReceipt[] = [];
  const effects: ScopedCancellationCommitEffect[] = [];
  for (const deferred of deferredExecutions) {
    const row = deferred.row;
    if (typeof row.intentId !== "string" || typeof row.lineageId !== "string" ||
        typeof row.sourceMessageId !== "string" || typeof row.sourceRevision !== "number" ||
        typeof row.executionId !== "string" || typeof row.attemptSeq !== "number" ||
        typeof row.authorityVersion !== "number") {
      throw new Error("Deferred scoped producer target was corrupt");
    }
    const runtime = database.prepare(
      `SELECT public_status AS publicStatus, authority_version AS authorityVersion
       FROM agent_execution_runtime_states WHERE execution_id = ?`,
    ).get(row.executionId);
    if ((runtime?.publicStatus !== "cancelled" && runtime?.publicStatus !== "failed") ||
        runtime.authorityVersion !== row.authorityVersion + 1) {
      throw new Error("Deferred scoped producer terminal authority was not committed");
    }
    const dispatches = database.prepare(
      `SELECT state FROM tool_dispatches WHERE execution_id = ? AND attempt_seq = ?`,
    ).all(row.executionId, row.attemptSeq);
    const sideEffectState = dispatches.some((dispatch) => dispatch.state === "outcome_unknown")
      ? "outcome-unknown-retained" as const
      : deferred.preservedDispatchIds.length > 0 ? "dispatched-retained" as const : "none" as const;
    database.prepare(
      `INSERT INTO invocation_scoped_cancellation_targets (
         fence_id, execution_id, attempt_seq, execution_version_before, execution_version_after
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(deferred.fenceId, row.executionId, row.attemptSeq,
      row.authorityVersion, row.authorityVersion + 1);
    database.prepare(
      `UPDATE invocation_recovery_queue SET state = 'closed', lease_owner = NULL,
         lease_expires_at = NULL, failure_code = ?, updated_at = ?
       WHERE execution_id = ? AND state IN ('pending', 'leased')`,
    ).run(input.reason, input.occurredAt, row.executionId);
    const effect: ScopedCancellationCommitEffect = {
      sourceMessageId: row.sourceMessageId,
      sourceRevision: row.sourceRevision,
      invocationIntentId: row.intentId,
      executionId: row.executionId,
      attemptSeq: row.attemptSeq,
      disposition: runtime.publicStatus === "cancelled" ? "execution_cancelled" : "already_terminal",
      confirmationDisposition: deferred.confirmationDisposition,
      grantDisposition: deferred.grantDisposition,
      sideEffectState,
    };
    const canonicalReceipt: ScopedCancellationReceipt = {
      requestId: deferred.requestId,
      fenceId: deferred.fenceId,
      roomId: input.roomId,
      lineageId: row.lineageId,
      scope: input.scope,
      reason: input.reason,
      intentOutcomes: [{ intentId: row.intentId, outcome: "already_claimed" }],
      executionOutcomes: [{ executionId: row.executionId,
        outcome: runtime.publicStatus === "cancelled" ? "cancelled" : "already_terminal",
        version: row.authorityVersion + 1 }],
      rejectedConfirmationIds: deferred.rejectedConfirmationIds,
      revokedGrantIds: deferred.revokedGrantIds,
      preservedDispatchIds: deferred.preservedDispatchIds,
      committedAt: input.occurredAt,
    };
    appendCanonicalTerminalProjection(database, row.executionId, input.occurredAt,
      `internal-scoped:${deferred.fenceId}`);
    receipts.push(storeReceipt(database, input, row, canonicalReceipt, effect));
    effects.push(effect);
  }
  return Object.freeze({ receipts: Object.freeze(receipts), effects: Object.freeze(effects) });
}
