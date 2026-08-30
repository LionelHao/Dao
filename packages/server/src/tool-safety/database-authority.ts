import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TOOL_CANONICALIZER_VERSION, type ToolId } from "@native-im/core";
import { parseToolParameters } from "../agent-runtime/tool-parameters.js";
import {
  FrozenRuntimeAuthorityError,
  requireFrozenRuntimeAuthority,
} from "../agent-runtime/frozen-runtime-authority-gate.js";
import type {
  AuthenticatedCommandContext,
  AuthenticatedSessionContext,
} from "../persistence/contracts.js";
import type {
  ToolSafetyAuthorityOperation,
  ToolSafetyAuthorityResult,
} from "./authority-protocol.js";

const PHYSICAL_TOOL_IDS = new Set<ToolId>([
  "http-json.read", "repository.git-status", "sandbox-file.write",
]);
const CONFIRMATION_TTL_HARD_MS = 15 * 60_000;
const GRANT_TTL_HARD_MS = 5 * 60_000;
const REVIEW_EVIDENCE_HARD_BYTES = 8_192;
const COMMAND_RECEIPT_TTL_MS = 30 * 24 * 60 * 60_000;

export class ToolSafetyDatabaseError extends Error {
  constructor(
    readonly code: "invalid_token" | "token_expired" | "session_revoked" |
      "identity_forbidden" | "permission_denied" | "execution_conflict" |
      "confirmation_expired" | "confirmation_replayed" | "invalid_parameters" |
      "storage_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ToolSafetyDatabaseError";
  }
}

function fail(code: ToolSafetyDatabaseError["code"], message: string): never {
  throw new ToolSafetyDatabaseError(code, message);
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url");
}

type ToolSafetyCommandKind = "confirmation_decide" | "handoff_offer" | "handoff_accept" |
  "outcome_review" | "compensation_propose";

function commandRequestSha256(operation: ToolSafetyAuthorityOperation): string {
  let payload: Readonly<Record<string, unknown>>;
  switch (operation.type) {
    case "tool-safety.confirmation-decide":
      payload = { type: operation.type, confirmationId: operation.confirmationId,
        expectedVersion: operation.expectedVersion, decision: operation.decision };
      break;
    case "tool-safety.handoff-offer":
      payload = { type: operation.type, confirmationId: operation.confirmationId,
        expectedVersion: operation.expectedVersion, targetActorId: operation.targetActorId };
      break;
    case "tool-safety.handoff-read":
    case "tool-safety.handoff-accept":
      payload = { type: "tool-safety.handoff-accept", handoffId: operation.handoffId,
        expectedVersion: operation.expectedVersion };
      break;
    case "tool-safety.outcome-review":
      payload = { type: operation.type, dispatchId: operation.dispatchId,
        expectedVersion: operation.expectedVersion, resolution: operation.resolution,
        evidenceSummary: operation.evidenceSummary };
      break;
    case "tool-safety.compensation-propose":
      payload = { type: operation.type, dispatchId: operation.dispatchId,
        expectedVersion: operation.expectedVersion };
      break;
    default:
      return fail("invalid_parameters", "Tool safety receipt operation was not public");
  }
  const request = {
    sessionFamilyId: "context" in operation ? operation.context.sessionFamilyId : undefined,
    payload,
  };
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function removeExpiredCommandReceipts(database: DatabaseSync, nowIso: string): void {
  database.prepare(
    `DELETE FROM tool_safety_command_receipts_v2
     WHERE rowid IN (
       SELECT rowid FROM tool_safety_command_receipts_v2
       WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT 100
     )`,
  ).run(nowIso);
}

function replayCommandReceipt(
  database: DatabaseSync,
  operation: ToolSafetyAuthorityOperation & { readonly context: AuthenticatedCommandContext },
  commandKind: ToolSafetyCommandKind,
): ToolSafetyAuthorityResult | undefined {
  const nowIso = new Date(operation.now).toISOString();
  database.prepare(
    `DELETE FROM tool_safety_command_receipts_v2
     WHERE principal_actor_id = ? AND command_kind = ? AND idempotency_key = ?
       AND expires_at <= ?`,
  ).run(operation.context.principal.actorId, commandKind,
    operation.context.idempotencyKey, nowIso);
  removeExpiredCommandReceipts(database, nowIso);
  const requestSha256 = commandRequestSha256(operation);
  const existing = database.prepare(
    `SELECT request_sha256 AS requestSha256, response_json AS responseJson
     FROM tool_safety_command_receipts_v2
     WHERE principal_actor_id = ? AND command_kind = ? AND idempotency_key = ?
       AND expires_at > ?`,
  ).get(operation.context.principal.actorId, commandKind, operation.context.idempotencyKey,
    nowIso);
  if (existing === undefined) return undefined;
  if (existing.requestSha256 !== requestSha256 || typeof existing.responseJson !== "string") {
    return fail("execution_conflict", "Tool safety idempotency payload changed");
  }
  try {
    const parsed = JSON.parse(existing.responseJson) as ToolSafetyAuthorityResult;
    return "replayed" in parsed ? { ...parsed, replayed: true } : parsed;
  } catch {
    return fail("storage_unavailable", "Tool safety receipt was corrupt");
  }
}

function withCommandReceipt(
  database: DatabaseSync,
  operation: ToolSafetyAuthorityOperation & { readonly context: AuthenticatedCommandContext },
  commandKind: ToolSafetyCommandKind,
  execute: () => ToolSafetyAuthorityResult,
): ToolSafetyAuthorityResult {
  requireHumanSession(database, operation.context, operation.now);
  const replay = replayCommandReceipt(database, operation, commandKind);
  if (replay !== undefined) return replay;
  const requestSha256 = commandRequestSha256(operation);
  const result = execute();
  database.prepare(
    `INSERT INTO tool_safety_command_receipts_v2 (
       principal_actor_id, command_kind, idempotency_key, request_sha256,
       response_json, committed_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(operation.context.principal.actorId, commandKind, operation.context.idempotencyKey,
    requestSha256, JSON.stringify(result), new Date(operation.now).toISOString(),
    new Date(operation.now + COMMAND_RECEIPT_TTL_MS).toISOString());
  return result;
}

function timestamp(value: string, now: number, hardMs: number): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now || parsed - now > hardMs) {
    return fail("invalid_parameters", "Tool safety expiry exceeded its closed limit");
  }
  return new Date(parsed).toISOString();
}

function requireHumanSession(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  now: number,
): string {
  const session = database.prepare(
    `SELECT session.family_id AS familyId, session.account_id AS accountId,
            session.actor_id AS actorId, session.access_expires_at AS accessExpiresAt,
            session.revoked_at AS revokedAt, actor.kind AS actorKind,
            family.revoked_at AS familyRevokedAt,
            family.refresh_expires_at AS familyExpiresAt,
            family.account_id AS familyAccountId, family.actor_id AS familyActorId
     FROM sessions AS session JOIN actors AS actor ON actor.id = session.actor_id
     JOIN session_families AS family ON family.family_id = session.family_id
     WHERE session.access_token_hash = ?`,
  ).get(context.sessionId);
  if (session === undefined) return fail("invalid_token", "Tool safety session was rejected");
  if (session.actorKind !== "human" || session.familyId !== context.sessionFamilyId ||
      session.accountId !== context.principal.accountId ||
      session.actorId !== context.principal.actorId ||
      session.familyAccountId !== context.principal.accountId ||
      session.familyActorId !== context.principal.actorId) {
    return fail("identity_forbidden", "Tool safety principal binding was rejected");
  }
  if (session.revokedAt !== null || session.familyRevokedAt !== null) {
    return fail("session_revoked", "Tool safety session was revoked");
  }
  if (typeof session.accessExpiresAt !== "number" || now >= session.accessExpiresAt) {
    return fail("token_expired", "Tool safety session expired");
  }
  if (typeof session.familyExpiresAt !== "number" || now >= session.familyExpiresAt) {
    return fail("token_expired", "Tool safety session family expired");
  }
  return context.principal.actorId;
}

function requireHumanMembership(database: DatabaseSync, roomId: string, actorId: string): void {
  if (database.prepare(
    `SELECT 1 AS present FROM room_memberships
     WHERE room_id = ? AND actor_id = ? AND kind = 'human'`,
  ).get(roomId, actorId)?.present !== 1) {
    return fail("permission_denied", "Named Human is not a current Room member");
  }
}

function frozenAuthority(database: DatabaseSync, executionId: string) {
  const compensation = database.prepare(
    `SELECT lineage.compensation_invocation_id AS invocationId,
            lineage.profile_id AS profileId, lineage.profile_revision AS profileRevision,
            lineage.assignment_id AS assignmentId,
            lineage.assignment_revision AS assignmentRevision,
            lineage.access_revision AS accessRevision,
            call.room_id AS roomId, call.agent_id AS actorId,
            profile.status AS profileStatus, profile.revision AS currentProfileRevision,
            assignment.status AS assignmentStatus, assignment.paused AS assignmentPaused,
            assignment.revision AS currentAssignmentRevision,
            assignment.participation, membership.access_revision AS currentAccessRevision,
            membership.kind AS membershipKind, room.status AS roomStatus
     FROM tool_compensation_lineage_v2 AS lineage
     JOIN tool_calls_v2 AS call ON call.tool_call_id = lineage.compensation_tool_call_id
     JOIN agent_profiles AS profile ON profile.id = lineage.profile_id
     JOIN room_agent_assignments AS assignment ON assignment.id = lineage.assignment_id
     JOIN room_memberships AS membership
       ON membership.room_id = call.room_id AND membership.actor_id = call.agent_id
     JOIN rooms AS room ON room.id = call.room_id
     WHERE lineage.compensation_execution_id = ?`,
  ).get(executionId);
  if (compensation !== undefined) {
    if (compensation.profileStatus !== "enabled" ||
        compensation.currentProfileRevision !== compensation.profileRevision ||
        compensation.assignmentStatus !== "current" || compensation.assignmentPaused !== 0 ||
        compensation.currentAssignmentRevision !== compensation.assignmentRevision ||
        compensation.currentAccessRevision !== compensation.accessRevision ||
        compensation.membershipKind !== "agent" || compensation.roomStatus !== "active" ||
        (compensation.participation !== "active" && compensation.participation !== "on-mention")) {
      return fail("permission_denied", "Compensation authority was revoked or changed");
    }
    return Object.freeze({ origin: "direct" as const, executionId,
      intentId: compensation.invocationId as string,
      roomId: compensation.roomId as string, actorId: compensation.actorId as string,
      profileId: compensation.profileId as string,
      profileRevision: compensation.profileRevision as number,
      assignmentId: compensation.assignmentId as string,
      assignmentRevision: compensation.assignmentRevision as number,
      accessRevision: compensation.accessRevision as number,
      participation: compensation.participation as "active" | "on-mention",
      effectiveToolIds: Object.freeze(["sandbox-file.write"] as const),
    });
  }
  try {
    return requireFrozenRuntimeAuthority(database, executionId);
  } catch (error) {
    if (error instanceof FrozenRuntimeAuthorityError) {
      return fail("permission_denied", `Tool authority rejected: ${error.reason}`);
    }
    throw error;
  }
}

function runtimeBinding(database: DatabaseSync, executionId: string) {
  const row = database.prepare(
    `SELECT execution.id AS executionId, execution.room_id AS roomId,
            execution.room_archive_generation AS roomLifecycleGeneration,
            execution.agent_id AS agentId, execution.current_attempt_seq AS attemptSeq,
            execution.status AS legacyStatus, runtime.intent_id AS invocationId,
            runtime.snapshot_id AS sourceSnapshotId, runtime.public_status AS publicStatus,
            runtime.phase, runtime.authority_version AS executionVersion,
            attempt.attempt_version AS attemptVersion,
            EXISTS(SELECT 1 FROM message_recall_fences AS fence
              WHERE fence.execution_id = execution.id) AS sourceRecalled
     FROM agent_executions AS execution
     JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = execution.id
     JOIN agent_execution_attempt_runtime_states AS attempt
       ON attempt.execution_id = execution.id
      AND attempt.attempt_seq = execution.current_attempt_seq
     WHERE execution.id = ?`,
  ).get(executionId);
  if (typeof row?.executionId !== "string" || typeof row.roomId !== "string" ||
      typeof row.agentId !== "string" || typeof row.invocationId !== "string" ||
      typeof row.sourceSnapshotId !== "string" || typeof row.executionVersion !== "number" ||
      typeof row.attemptSeq !== "number" || typeof row.roomLifecycleGeneration !== "number") {
    return fail("storage_unavailable", "Tool execution binding was corrupt");
  }
  return row;
}

function requireCurrentExecution(
  database: DatabaseSync,
  input: Readonly<{
    executionId: string; invocationId: string; attemptSeq: number;
    expectedExecutionVersion: number; toolId: ToolId;
  }>,
) {
  const binding = runtimeBinding(database, input.executionId);
  const authority = frozenAuthority(database, input.executionId);
  if (binding.invocationId !== input.invocationId || binding.attemptSeq !== input.attemptSeq ||
      binding.executionVersion !== input.expectedExecutionVersion ||
      binding.legacyStatus !== "running" || binding.publicStatus !== "running" ||
      binding.sourceRecalled === 1 || !authority.effectiveToolIds.includes(input.toolId)) {
    return fail("execution_conflict", "Tool execution authority was stale");
  }
  return { binding, authority };
}

function writeRepair(
  database: DatabaseSync,
  kind: "tool-call" | "tool-confirmation" | "tool-grant" | "tool-dispatch" | "tool-review" |
    "tool-handoff" | "tool-compensation",
  id: string,
  roomId: string,
  version: number,
  projection: Readonly<Record<string, unknown>>,
  occurredAt: string,
): void {
  let publicValue: Readonly<Record<string, unknown>> | undefined;
  if (kind === "tool-call") {
    publicValue = database.prepare(
      `SELECT call.tool_call_id AS toolCallId, call.tool_id AS toolId,
              call.safe_preview_json AS safePreview, 'prepared' AS state,
              call.current_version AS version,
              COALESCE(execution.trigger_message_id, call.execution_id) AS sourceRef
       FROM tool_calls_v2 AS call
       JOIN agent_executions AS execution ON execution.id = call.execution_id
       WHERE call.tool_call_id = ?`,
    ).get(id);
  } else if (kind === "tool-confirmation") {
    publicValue = database.prepare(
      `SELECT confirmation.confirmation_id AS confirmationId,
              call.tool_call_id AS toolCallId, call.tool_id AS toolId,
              confirmation.state, call.safe_preview_json AS safePreview,
              confirmation.reason AS reasonCode, confirmation.expires_at AS expiresAt,
              confirmation.version, actor.display_name AS namedHumanDisplayRef,
              COALESCE(execution.trigger_message_id, call.execution_id) AS sourceRef
       FROM tool_confirmations_v2 AS confirmation
       JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
       JOIN agent_executions AS execution ON execution.id = call.execution_id
       JOIN actors AS actor ON actor.id = confirmation.principal_human_actor_id
       WHERE confirmation.confirmation_id = ?`,
    ).get(id);
  } else if (kind === "tool-grant") {
    publicValue = database.prepare(
      `SELECT grant_id AS grantId, tool_call_id AS toolCallId, state,
              reason AS reasonCode, expires_at AS expiresAt, version
       FROM tool_grants_v2 WHERE grant_id = ?`,
    ).get(id);
  } else if (kind === "tool-dispatch") {
    publicValue = database.prepare(
      `SELECT dispatch_id AS dispatchId, tool_call_id AS toolCallId, state,
              reason AS reasonCode, version
       FROM tool_dispatches_v2 WHERE dispatch_id = ?`,
    ).get(id);
  } else if (kind === "tool-review") {
    publicValue = database.prepare(
      `SELECT review.review_id AS reviewId, review.dispatch_id AS dispatchId,
              review.resolution, review.evidence_summary AS evidenceSummary,
              actor.display_name AS namedHumanDisplayRef,
              review.compensation_tool_call_id AS compensationToolCallId, review.version
       FROM tool_reviews_v2 AS review
       JOIN actors AS actor ON actor.id = review.principal_human_actor_id
       WHERE review.review_id = ?`,
    ).get(id);
  } else if (kind === "tool-handoff") {
    publicValue = database.prepare(
      `SELECT handoff.handoff_id AS handoffId,
              handoff.confirmation_id AS confirmationId, handoff.state,
              handoff.to_principal_human_actor_id AS targetActorId,
              actor.display_name AS targetNamedHumanDisplayRef,
              CASE handoff.state WHEN 'offered' THEN 1 ELSE 2 END AS version
       FROM tool_confirmation_handoffs_v2 AS handoff
       JOIN actors AS actor ON actor.id = handoff.to_principal_human_actor_id
       WHERE handoff.handoff_id = ?`,
    ).get(id);
  } else if (kind === "tool-compensation") {
    publicValue = database.prepare(
      `SELECT lineage.lineage_id AS lineageId,
              lineage.original_dispatch_id AS originalDispatchId,
              lineage.compensation_invocation_id AS compensationInvocationId,
              lineage.compensation_execution_id AS compensationExecutionId,
              lineage.compensation_tool_call_id AS compensationToolCallId,
              CASE
                WHEN dispatch.state IS NOT NULL THEN dispatch.state
                WHEN confirmation.state IN ('rejected','expired') THEN confirmation.state
                ELSE 'pending'
              END AS state,
              COALESCE(dispatch.version, confirmation.version, 1) AS version
       FROM tool_compensation_lineage_v2 AS lineage
       LEFT JOIN tool_dispatches_v2 AS dispatch
         ON dispatch.tool_call_id = lineage.compensation_tool_call_id
       LEFT JOIN tool_confirmations_v2 AS confirmation
         ON confirmation.tool_call_id = lineage.compensation_tool_call_id
       WHERE lineage.lineage_id = ?`,
    ).get(id);
  }
  const durableProjection = publicValue ?? projection;
  const projectionJson = JSON.stringify(durableProjection);
  if (Buffer.byteLength(projectionJson, "utf8") > 8_192) {
    return fail("storage_unavailable", "Tool repair projection exceeded its safe bound");
  }
  database.prepare(
    `INSERT INTO tool_safety_repair_records_v2 (
       kind, record_id, room_id, stable_key, version, projection_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, record_id) DO UPDATE SET
       version = excluded.version, projection_json = excluded.projection_json,
       updated_at = excluded.updated_at`,
  ).run(kind, id, roomId, `${kind}:${id}`, version, projectionJson, occurredAt);
  if (publicValue !== undefined) {
    const eventId = stableId("tool-safety-event", kind, id, String(version));
    if (database.prepare(
      "SELECT 1 AS present FROM events WHERE event_id = ?",
    ).get(eventId)?.present === 1) {
      return;
    }
    const stream = database.prepare(
      `SELECT head_seq AS headSeq FROM streams
       WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(roomId);
    if (typeof stream?.headSeq !== "number") {
      return fail("storage_unavailable", "Tool safety Room stream was unavailable");
    }
    const streamSeq = stream.headSeq + 1;
    const advanced = database.prepare(
      `UPDATE streams SET head_seq = ?
       WHERE stream_kind = 'room' AND stream_id = ? AND head_seq = ?`,
    ).run(streamSeq, roomId, stream.headSeq);
    if (advanced.changes !== 1) {
      return fail("storage_unavailable", "Tool safety Room stream CAS was stale");
    }
    const causal = database.prepare(
      `SELECT actor.id AS actorId, actor.kind AS actorKind
       FROM actors AS actor
       WHERE actor.id = COALESCE(
         (SELECT principal_human_actor_id FROM tool_reviews_v2 WHERE review_id = ?),
         (SELECT COALESCE(accepted_by_human_actor_id, offered_by_human_actor_id)
          FROM tool_confirmation_handoffs_v2 WHERE handoff_id = ?),
         (SELECT proposed_by_human_actor_id FROM tool_compensation_lineage_v2
          WHERE lineage_id = ?),
         (SELECT principal_human_actor_id FROM tool_confirmation_decisions_v2
          WHERE confirmation_id = ? ORDER BY decision_version DESC LIMIT 1),
         (SELECT confirmation.principal_human_actor_id
          FROM tool_grants_v2 AS grant
          JOIN tool_confirmations_v2 AS confirmation
            ON confirmation.confirmation_id = grant.confirmation_id
          WHERE grant.grant_id = ?),
         (SELECT call.agent_id FROM tool_calls_v2 AS call WHERE call.tool_call_id = COALESCE(
         (SELECT tool_call_id FROM tool_calls_v2 WHERE tool_call_id = ?),
         (SELECT tool_call_id FROM tool_confirmations_v2 WHERE confirmation_id = ?),
         (SELECT tool_call_id FROM tool_grants_v2 WHERE grant_id = ?),
         (SELECT tool_call_id FROM tool_dispatches_v2 WHERE dispatch_id = ?),
         (SELECT dispatch.tool_call_id FROM tool_reviews_v2 AS review
          JOIN tool_dispatches_v2 AS dispatch ON dispatch.dispatch_id = review.dispatch_id
          WHERE review.review_id = ?),
         (SELECT confirmation.tool_call_id
          FROM tool_confirmation_handoffs_v2 AS handoff
          JOIN tool_confirmations_v2 AS confirmation
            ON confirmation.confirmation_id = handoff.confirmation_id
          WHERE handoff.handoff_id = ?),
         (SELECT compensation_tool_call_id FROM tool_compensation_lineage_v2
          WHERE lineage_id = ?)
         ))
       ) LIMIT 1`,
    ).get(id, id, id, id, id, id, id, id, id, id, id, id);
    if (typeof causal?.actorId !== "string" ||
        (causal.actorKind !== "human" && causal.actorKind !== "agent")) {
      return fail("storage_unavailable", "Tool safety event actor was unavailable");
    }
    database.prepare(
      `INSERT INTO events (
         event_id, stream_kind, stream_id, stream_seq, room_id,
         authority_kind, actor_id, event_type, occurred_at, payload_json
       ) VALUES (?, 'room', ?, ?, ?, ?, ?, 'tool.safety.changed', ?, ?)`,
    ).run(eventId, roomId, streamSeq, roomId, causal.actorKind, causal.actorId, occurredAt,
      JSON.stringify({ kind, value: publicValue }));
    database.prepare(
      `INSERT INTO outbox_deliveries (
         id, event_id, target_kind, target_id, stream_seq, status,
         attempts, available_at, delivered_at, last_error
       ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
    ).run(stableId("tool-safety-outbox", eventId), eventId, roomId, streamSeq, occurredAt);
  }
}

/** Shared transaction-local writer for lifecycle participants that terminalize FT-10 facts. */
export function writeToolSafetyProjectionInTransaction(
  database: DatabaseSync,
  kind: "tool-call" | "tool-confirmation" | "tool-grant" | "tool-dispatch" |
    "tool-review" | "tool-handoff" | "tool-compensation",
  id: string,
  roomId: string,
  version: number,
  projection: Readonly<Record<string, unknown>>,
  occurredAt: string,
): void {
  writeRepair(database, kind, id, roomId, version, projection, occurredAt);
}

function prepare(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.prepare" }>,
): ToolSafetyAuthorityResult {
  const isSideEffect = operation.toolId === "sandbox-file.write";
  if (!PHYSICAL_TOOL_IDS.has(operation.toolId) ||
      !/^[0-9a-f]{64}$/u.test(operation.canonicalParameterSha256) ||
      operation.canonicalizerVersion !== TOOL_CANONICALIZER_VERSION) {
    return fail("invalid_parameters", "Tool call canonical binding was rejected");
  }
  const { binding, authority } = requireCurrentExecution(database, operation);
  const occurredAt = new Date(operation.now).toISOString();
  const baseClaimBinding = {
    toolCallId: operation.toolCallId,
    invocationId: operation.invocationId,
    executionId: operation.executionId,
    attemptSeq: operation.attemptSeq,
    executionVersion: operation.expectedExecutionVersion,
    roomId: binding.roomId as string,
    roomLifecycleGeneration: binding.roomLifecycleGeneration as number,
    agentId: binding.agentId as string,
    sourceSnapshotId: binding.sourceSnapshotId as string,
    accessRevision: authority.accessRevision,
    profileId: authority.profileId,
    profileRevision: authority.profileRevision,
    assignmentId: authority.assignmentId,
    assignmentRevision: authority.assignmentRevision,
    canonicalParameterSha256: operation.canonicalParameterSha256,
    canonicalizerVersion: operation.canonicalizerVersion,
    toolId: operation.toolId,
  } as const;
  const existing = database.prepare(
    `SELECT tool_call_id AS toolCallId, invocation_id AS invocationId,
            execution_id AS executionId, attempt_seq AS attemptSeq,
            execution_version AS executionVersion, room_id AS roomId,
            agent_id AS agentId, tool_id AS toolId,
            canonical_parameter_sha256 AS parameterSha256,
            parameter_schema_version AS parameterSchemaVersion,
            canonicalizer_version AS canonicalizerVersion,
            source_snapshot_id AS sourceSnapshotId,
            profile_revision AS profileRevision,
            assignment_revision AS assignmentRevision,
            access_revision AS accessRevision, current_version AS version
     FROM tool_calls_v2 WHERE tool_call_id = ?`,
  ).get(operation.toolCallId);
  if (existing !== undefined) {
    if (existing.toolCallId !== operation.toolCallId || existing.version !== 1 ||
        existing.invocationId !== operation.invocationId ||
        existing.executionId !== operation.executionId ||
        existing.attemptSeq !== operation.attemptSeq ||
        existing.executionVersion !== operation.expectedExecutionVersion ||
        existing.roomId !== binding.roomId || existing.agentId !== binding.agentId ||
        existing.toolId !== operation.toolId ||
        existing.parameterSha256 !== operation.canonicalParameterSha256 ||
        existing.parameterSchemaVersion !== operation.parameterSchemaVersion ||
        existing.canonicalizerVersion !== operation.canonicalizerVersion ||
        existing.sourceSnapshotId !== binding.sourceSnapshotId ||
        existing.profileRevision !== authority.profileRevision ||
        existing.assignmentRevision !== authority.assignmentRevision ||
        existing.accessRevision !== authority.accessRevision) {
      return fail("execution_conflict", "Tool call replay binding changed");
    }
    const confirmation = database.prepare(
      `SELECT confirmation_id AS id, principal_human_actor_id AS principalActorId,
              session_family_id AS sessionFamilyId, binding_generation AS bindingGeneration
       FROM tool_confirmations_v2 WHERE tool_call_id = ?`,
    ).get(operation.toolCallId);
    const grant = database.prepare(
      "SELECT grant_id AS id FROM tool_grants_v2 WHERE tool_call_id = ?",
    ).get(operation.toolCallId);
    return { kind: "prepared", toolCallId: operation.toolCallId,
      ...(typeof confirmation?.id === "string" ? { confirmationId: confirmation.id } : {}),
      ...(typeof grant?.id === "string" ? { grantId: grant.id } : {}), version: 1,
      claimBinding: {
        ...baseClaimBinding,
        ...(typeof confirmation?.principalActorId === "string" ? {
          principalActorId: confirmation.principalActorId,
          sessionFamilyId: confirmation.sessionFamilyId as string,
          bindingGeneration: confirmation.bindingGeneration as number,
        } : {}),
      } };
  }
  if (isSideEffect !== (operation.confirmation !== undefined) ||
      isSideEffect !== (operation.sealedPayload !== undefined) ||
      isSideEffect === (operation.grantId !== undefined)) {
    return fail("invalid_parameters", "Tool prepare shape violated the side-effect policy");
  }
  if (!isSideEffect && (operation.grantId === undefined || operation.grantExpiresAt === undefined)) {
    return fail("invalid_parameters", "Read tool prepare requires one short-lived grant");
  }
  let principalActorId: string | undefined;
  if (operation.confirmation !== undefined) {
    principalActorId = requireHumanSession(database, operation.confirmation.context, operation.now);
    requireHumanMembership(database, binding.roomId as string, principalActorId);
    timestamp(operation.sealedPayload!.expiresAt, operation.now, CONFIRMATION_TTL_HARD_MS);
    const pending = database.prepare(
      `SELECT
         SUM(CASE WHEN call.execution_id = ? THEN 1 ELSE 0 END) AS executionCount,
         COUNT(*) AS roomCount
       FROM tool_confirmations_v2 AS confirmation
       JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
       WHERE confirmation.state = 'pending' AND call.room_id = ?`,
    ).get(operation.executionId, binding.roomId as string);
    if ((pending?.executionCount as number | null ?? 0) >= 1 ||
        (pending?.roomCount as number | null ?? 0) >= 64) {
      return fail("execution_conflict", "Pending tool confirmation capacity was reached");
    }
  }
  const nextExecutionVersion = operation.expectedExecutionVersion + 1;
  const runtimeTransition = database.prepare(
    `UPDATE agent_execution_runtime_states
     SET phase = ?, authority_version = ?, updated_at = ?
     WHERE execution_id = ? AND public_status = 'running'
       AND phase IN ('model_generation','read_tool') AND authority_version = ?`,
  ).run(isSideEffect ? "waiting_confirmation" : "read_tool", nextExecutionVersion,
    occurredAt, operation.executionId, operation.expectedExecutionVersion);
  if (runtimeTransition.changes !== 1) {
    return fail("execution_conflict", "Tool prepare lost the execution phase CAS");
  }
  const attemptTransition = database.prepare(
    `UPDATE agent_execution_attempt_runtime_states
     SET phase = ?, attempt_version = attempt_version + 1
     WHERE execution_id = ? AND attempt_seq = ? AND public_status = 'running'
       AND phase IN ('model_generation','read_tool') AND attempt_version = ?`,
  ).run(isSideEffect ? "waiting_confirmation" : "read_tool", operation.executionId,
    operation.attemptSeq, binding.attemptVersion as number);
  if (attemptTransition.changes !== 1) {
    return fail("execution_conflict", "Tool prepare lost the attempt phase CAS");
  }
  const preparedClaimBinding = { ...baseClaimBinding, executionVersion: nextExecutionVersion };
  database.prepare(
    `INSERT INTO tool_calls_v2 (
       tool_call_id, invocation_id, execution_id, attempt_seq, execution_version,
       room_id, agent_id, tool_id, canonical_parameter_sha256,
       parameter_schema_version, canonicalizer_version, source_snapshot_id,
       profile_revision, assignment_revision, access_revision, safe_preview_json,
       sealed_payload_ciphertext, sealed_payload_key_version, sealed_payload_expires_at,
       binding_generation, current_version, created_at, legacy_origin
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'stage12')`,
  ).run(operation.toolCallId, operation.invocationId, operation.executionId,
    operation.attemptSeq, nextExecutionVersion,
    binding.roomId as string, binding.agentId as string,
    operation.toolId, operation.canonicalParameterSha256, operation.parameterSchemaVersion,
    operation.canonicalizerVersion, binding.sourceSnapshotId as string, authority.profileRevision,
    authority.assignmentRevision, authority.accessRevision, JSON.stringify(operation.safePreview),
    operation.sealedPayload?.ciphertext ?? null, operation.sealedPayload?.keyVersion ?? null,
    operation.sealedPayload?.expiresAt ?? null, operation.confirmation?.bindingGeneration ?? 1,
    occurredAt);
  writeRepair(database, "tool-call", operation.toolCallId, binding.roomId as string, 1, {
    toolCallId: operation.toolCallId, toolId: operation.toolId,
    safePreview: operation.safePreview, state: "prepared", version: 1,
  }, occurredAt);
  if (operation.confirmation !== undefined && principalActorId !== undefined) {
    const expiry = timestamp(operation.sealedPayload!.expiresAt, operation.now, CONFIRMATION_TTL_HARD_MS);
    database.prepare(
      `INSERT INTO tool_confirmations_v2 (
         confirmation_id, tool_call_id, principal_human_actor_id, session_family_id,
         binding_generation, state, expires_at, version, created_at, changed_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)`,
    ).run(operation.confirmation.confirmationId, operation.toolCallId, principalActorId,
      operation.confirmation.context.sessionFamilyId, operation.confirmation.bindingGeneration,
      expiry, occurredAt, occurredAt);
    writeRepair(database, "tool-confirmation", operation.confirmation.confirmationId,
      binding.roomId as string, 1, {
        confirmationId: operation.confirmation.confirmationId,
        toolCallId: operation.toolCallId, state: "pending", version: 1,
        safePreview: operation.safePreview, expiresAt: expiry,
      }, occurredAt);
    return { kind: "prepared", toolCallId: operation.toolCallId,
      confirmationId: operation.confirmation.confirmationId, version: 1,
      claimBinding: { ...preparedClaimBinding, principalActorId,
        sessionFamilyId: operation.confirmation.context.sessionFamilyId,
        bindingGeneration: operation.confirmation.bindingGeneration } };
  }
  const readGrantId = operation.grantId!;
  const grantExpiry = timestamp(operation.grantExpiresAt!, operation.now, GRANT_TTL_HARD_MS);
  database.prepare(
    `INSERT INTO tool_grants_v2 (
       grant_id, tool_call_id, state, issued_at, expires_at, version, changed_at
     ) VALUES (?, ?, 'active', ?, ?, 1, ?)`,
  ).run(readGrantId, operation.toolCallId, occurredAt, grantExpiry, occurredAt);
  database.prepare(
    `INSERT INTO tool_grant_transitions_v2 (
       transition_id, grant_id, from_state, to_state, transition_version, occurred_at
     ) VALUES (?, ?, NULL, 'active', 1, ?)`,
  ).run(stableId("tool-grant-active", readGrantId), readGrantId, occurredAt);
  writeRepair(database, "tool-grant", readGrantId, binding.roomId as string, 1,
    { grantId: readGrantId, toolCallId: operation.toolCallId,
      state: "active", expiresAt: grantExpiry, version: 1 }, occurredAt);
  return { kind: "prepared", toolCallId: operation.toolCallId,
    grantId: readGrantId, version: 1, claimBinding: preparedClaimBinding };
}

function readPrepareBinding(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.read-prepare-binding" }>,
): ToolSafetyAuthorityResult {
  const binding = runtimeBinding(database, operation.executionId);
  if (binding.attemptSeq !== operation.attemptSeq || binding.legacyStatus !== "running" ||
      binding.publicStatus !== "running" || binding.sourceRecalled === 1) {
    return fail("execution_conflict", "Tool prepare binding targeted a stale execution");
  }
  const authority = frozenAuthority(database, operation.executionId);
  if (!authority.effectiveToolIds.includes(operation.toolId)) {
    return fail("permission_denied", "Tool is outside the current authority intersection");
  }
  return {
    kind: "prepare-binding",
    invocationId: binding.invocationId as string,
    executionId: operation.executionId,
    attemptSeq: operation.attemptSeq,
    executionVersion: binding.executionVersion as number,
    roomId: binding.roomId as string,
    roomLifecycleGeneration: binding.roomLifecycleGeneration as number,
    agentId: binding.agentId as string,
    sourceSnapshotId: binding.sourceSnapshotId as string,
    accessRevision: authority.accessRevision,
    profileId: authority.profileId,
    profileRevision: authority.profileRevision,
    assignmentId: authority.assignmentId,
    assignmentRevision: authority.assignmentRevision,
    toolId: operation.toolId,
  };
}

function decide(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.confirmation-decide" }>,
): ToolSafetyAuthorityResult {
  const actorId = requireHumanSession(database, operation.context, operation.now);
  const row = database.prepare(
    `SELECT confirmation.tool_call_id AS toolCallId,
            confirmation.principal_human_actor_id AS principalActorId,
            confirmation.session_family_id AS sessionFamilyId,
            confirmation.binding_generation AS bindingGeneration,
            confirmation.state, confirmation.expires_at AS expiresAt,
            confirmation.version, call.execution_id AS executionId,
            call.invocation_id AS invocationId, call.attempt_seq AS attemptSeq,
            call.execution_version AS executionVersion, call.room_id AS roomId,
            call.safe_preview_json AS safePreviewJson
     FROM tool_confirmations_v2 AS confirmation
     JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
     WHERE confirmation.confirmation_id = ?`,
  ).get(operation.confirmationId);
  if (row === undefined) return fail("confirmation_expired", "Tool confirmation is gone");
  if (row.principalActorId !== actorId || row.sessionFamilyId !== operation.context.sessionFamilyId) {
    return fail("permission_denied", "Tool confirmation principal was forbidden");
  }
  requireHumanMembership(database, row.roomId as string, actorId);
  if (row.state !== "pending") {
    return fail("confirmation_replayed", "Tool confirmation is already terminal");
  }
  if (row.version !== operation.expectedVersion) {
    return fail("execution_conflict", "Tool confirmation version was stale");
  }
  if (typeof row.expiresAt !== "string" || Date.parse(row.expiresAt) <= operation.now) {
    return fail("confirmation_expired", "Tool confirmation expired");
  }
  requireCurrentExecution(database, {
    executionId: row.executionId as string, invocationId: row.invocationId as string,
    attemptSeq: row.attemptSeq as number, expectedExecutionVersion: row.executionVersion as number,
    toolId: "sandbox-file.write",
  });
  const occurredAt = new Date(operation.now).toISOString();
  const state = operation.decision === "confirm" ? "confirmed" : "rejected";
  database.prepare(
    `UPDATE tool_confirmations_v2 SET state = ?, reason = ?, version = version + 1,
       changed_at = ? WHERE confirmation_id = ? AND state = 'pending' AND version = ?`,
  ).run(state, state === "rejected" ? "human_rejected" : null, occurredAt,
    operation.confirmationId, operation.expectedVersion);
  database.prepare(
    `INSERT INTO tool_confirmation_decisions_v2 (
       decision_id, confirmation_id, tool_call_id, binding_generation,
       principal_human_actor_id, session_family_id, decision, reason,
       decision_version, decided_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(stableId("tool-confirmation-decision", operation.confirmationId,
    String(row.bindingGeneration)), operation.confirmationId, row.toolCallId as string,
    row.bindingGeneration as number, actorId, operation.context.sessionFamilyId, state,
    state === "rejected" ? "human_rejected" : null, operation.expectedVersion + 1, occurredAt);
  let grantId: string | undefined;
  if (state === "confirmed") {
    if (operation.grantId === undefined || operation.grantExpiresAt === undefined) {
      return fail("invalid_parameters", "Confirmed tool decision requires one grant binding");
    }
    const grantExpiry = timestamp(operation.grantExpiresAt, operation.now, GRANT_TTL_HARD_MS);
    if (Date.parse(grantExpiry) > Date.parse(row.expiresAt as string)) {
      return fail("invalid_parameters", "Tool grant cannot outlive its confirmation");
    }
    database.prepare(
      `INSERT INTO tool_grants_v2 (
         grant_id, tool_call_id, confirmation_id, state, issued_at, expires_at,
         version, changed_at
       ) VALUES (?, ?, ?, 'active', ?, ?, 1, ?)`,
    ).run(operation.grantId, row.toolCallId as string, operation.confirmationId,
      occurredAt, grantExpiry, occurredAt);
    database.prepare(
      `INSERT INTO tool_grant_transitions_v2 (
         transition_id, grant_id, from_state, to_state, transition_version, occurred_at
       ) VALUES (?, ?, NULL, 'active', 1, ?)`,
    ).run(stableId("tool-grant-active", operation.grantId), operation.grantId, occurredAt);
    grantId = operation.grantId;
    writeRepair(database, "tool-grant", operation.grantId, row.roomId as string, 1,
      { grantId: operation.grantId, toolCallId: row.toolCallId,
        state: "active", expiresAt: grantExpiry, version: 1 }, occurredAt);
  }
  if (state === "rejected") {
    const runtimeClosed = database.prepare(
      `UPDATE agent_execution_runtime_states
       SET public_status = 'failed', phase = 'failed',
           authority_version = authority_version + 1, completed_at = ?, updated_at = ?,
           terminal_error_code = 'confirmation_rejected', terminal_reason = NULL,
           review_state = 'none'
       WHERE execution_id = ? AND public_status = 'running'
         AND phase = 'waiting_confirmation' AND authority_version = ?`,
    ).run(occurredAt, occurredAt, row.executionId as string, row.executionVersion as number);
    const attemptClosed = database.prepare(
      `UPDATE agent_execution_attempts
       SET status = 'failed', finished_at = ?, error_code = 'confirmation_rejected',
           next_retry_at = NULL
       WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
    ).run(occurredAt, row.executionId as string, row.attemptSeq as number);
    const executionClosed = database.prepare(
      `UPDATE agent_executions
       SET status = 'failed', completed_at = ?, updated_at = ?,
           terminal_error_code = 'confirmation_rejected', next_retry_at = NULL
       WHERE id = ? AND current_attempt_seq = ? AND status = 'running'`,
    ).run(occurredAt, occurredAt, row.executionId as string, row.attemptSeq as number);
    if (runtimeClosed.changes !== 1 || attemptClosed.changes !== 1 || executionClosed.changes !== 1) {
      return fail("execution_conflict", "Rejected confirmation parent closure lost its CAS");
    }
  }
  writeRepair(database, "tool-confirmation", operation.confirmationId,
    row.roomId as string, operation.expectedVersion + 1, {
      confirmationId: operation.confirmationId, toolCallId: row.toolCallId,
      state, reason: state === "rejected" ? "human_rejected" : null,
      version: operation.expectedVersion + 1,
      safePreview: JSON.parse(row.safePreviewJson as string) as unknown,
    }, occurredAt);
  return { kind: "confirmation-decision", confirmationId: operation.confirmationId,
    state, version: operation.expectedVersion + 1,
    ...(grantId === undefined ? {} : { grantId }), replayed: false };
}

function claim(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.claim" }>,
): ToolSafetyAuthorityResult {
  const prior = database.prepare(
    `SELECT dispatch.dispatch_id AS dispatchId, dispatch.state
     FROM tool_dispatches_v2 AS dispatch
     WHERE dispatch.tool_call_id = ?`,
  ).get(operation.toolCallId);
  if (typeof prior?.dispatchId === "string") {
    const state = prior.state === "outcome_unknown" ? "outcome_unknown" :
      prior.state === "claimed" ? "claimed" : "dispatched";
    return { kind: "not_replayable", state, dispatchId: prior.dispatchId };
  }
  const { binding, authority } = requireCurrentExecution(database, operation);
  if (binding.roomId !== operation.roomId || binding.agentId !== operation.agentId ||
      binding.sourceSnapshotId !== operation.sourceSnapshotId ||
      binding.roomLifecycleGeneration !== operation.expectedRoomLifecycleGeneration ||
      authority.profileId !== operation.profileId ||
      authority.profileRevision !== operation.expectedProfileRevision ||
      authority.assignmentId !== operation.assignmentId ||
      authority.assignmentRevision !== operation.expectedAssignmentRevision ||
      authority.accessRevision !== operation.expectedAccessRevision) {
    return { kind: "rejected", reason: "tool_call_binding_stale" };
  }
  const call = database.prepare(
    `SELECT canonical_parameter_sha256 AS parameterSha256,
            canonicalizer_version AS canonicalizerVersion,
            parameter_schema_version AS parameterSchemaVersion,
            binding_generation AS bindingGeneration
     FROM tool_calls_v2
     WHERE tool_call_id = ? AND invocation_id = ? AND execution_id = ?
       AND attempt_seq = ? AND execution_version = ? AND room_id = ?
       AND agent_id = ? AND tool_id = ?`,
  ).get(operation.toolCallId, operation.invocationId, operation.executionId,
    operation.attemptSeq, operation.expectedExecutionVersion, operation.roomId,
    operation.agentId, operation.toolId);
  if (call === undefined) return { kind: "rejected", reason: "tool_call_binding_stale" };
  if (call.parameterSha256 !== operation.canonicalParameterSha256) {
    return { kind: "rejected", reason: "parameter_hash_mismatch" };
  }
  if (call.canonicalizerVersion !== operation.canonicalizerVersion ||
      operation.canonicalizerVersion !== TOOL_CANONICALIZER_VERSION) {
    return { kind: "rejected", reason: "canonicalizer_version_mismatch" };
  }
  const compensation = database.prepare(
    `SELECT lineage.original_dispatch_id AS originalDispatchId,
            original.sealed_compensation_ciphertext AS compensationToken
     FROM tool_compensation_lineage_v2 AS lineage
     JOIN tool_dispatches_v2 AS original
       ON original.dispatch_id = lineage.original_dispatch_id
     WHERE lineage.compensation_tool_call_id = ?`,
  ).get(operation.toolCallId);
  let parsedParameters: Readonly<Record<string, unknown>>;
  if (compensation !== undefined) {
    const canonicalReference = JSON.stringify({
      operation: "compensate",
      originalDispatchId: compensation.originalDispatchId,
    });
    if (call.parameterSchemaVersion !== "sandbox-file.write.compensation.v1" ||
        operation.compensationOfDispatchId !== compensation.originalDispatchId ||
        createHash("sha256").update(canonicalReference).digest("hex") !==
          operation.canonicalParameterSha256 ||
        typeof compensation.compensationToken !== "string" ||
        Reflect.ownKeys(operation.parameters).length !== 0) {
      return { kind: "rejected", reason: "parameter_hash_mismatch" };
    }
    parsedParameters = Object.freeze({});
  } else {
    if (operation.compensationOfDispatchId !== undefined) {
      return { kind: "rejected", reason: "tool_call_binding_stale" };
    }
    let parsed;
    try {
      parsed = parseToolParameters({ toolId: operation.toolId,
        argumentsJson: JSON.stringify(operation.parameters),
        expectedSchemaVersion: call.parameterSchemaVersion as string,
        canonicalizerVersion: operation.canonicalizerVersion });
    } catch {
      return { kind: "rejected", reason: "parameter_hash_mismatch" };
    }
    if (parsed.canonicalParameterSha256 !== operation.canonicalParameterSha256) {
      return { kind: "rejected", reason: "parameter_hash_mismatch" };
    }
    parsedParameters = parsed.parsed as Readonly<Record<string, unknown>>;
  }
  const grant = database.prepare(
    `SELECT grant.confirmation_id AS confirmationId, grant.state,
            grant.expires_at AS expiresAt, grant.version,
            confirmation.principal_human_actor_id AS principalActorId,
            confirmation.session_family_id AS sessionFamilyId,
            confirmation.binding_generation AS bindingGeneration,
            confirmation.state AS confirmationState
     FROM tool_grants_v2 AS grant
     LEFT JOIN tool_confirmations_v2 AS confirmation
       ON confirmation.confirmation_id = grant.confirmation_id
     WHERE grant.grant_id = ? AND grant.tool_call_id = ?`,
  ).get(operation.grantId, operation.toolCallId);
  if (grant?.state !== "active") return { kind: "rejected", reason: "grant_inactive" };
  if (typeof grant.expiresAt !== "string" || Date.parse(grant.expiresAt) <= operation.now) {
    return { kind: "rejected", reason: "grant_expired" };
  }
  if (operation.toolId === "sandbox-file.write") {
    if (grant.confirmationState !== "confirmed" ||
        grant.principalActorId !== operation.principalActorId ||
        grant.sessionFamilyId !== operation.sessionFamilyId ||
        grant.bindingGeneration !== operation.bindingGeneration ||
        call.bindingGeneration !== operation.bindingGeneration) {
      return { kind: "rejected", reason: "confirmation_binding_stale" };
    }
    if (typeof operation.principalActorId !== "string") {
      return { kind: "rejected", reason: "principal_mismatch" };
    }
    const family = database.prepare(
      `SELECT actor_id AS actorId, revoked_at AS revokedAt,
              refresh_expires_at AS expiresAt
       FROM session_families WHERE family_id = ?`,
    ).get(operation.sessionFamilyId as string);
    if (family?.actorId !== operation.principalActorId || family.revokedAt !== null ||
        typeof family.expiresAt !== "number" || family.expiresAt <= operation.now) {
      return { kind: "rejected", reason: "principal_mismatch" };
    }
    requireHumanMembership(database, operation.roomId, operation.principalActorId);
    if (database.prepare(
      `SELECT 1 AS busy FROM tool_dispatches_v2 AS dispatch
       JOIN tool_calls_v2 AS call ON call.tool_call_id = dispatch.tool_call_id
       WHERE call.room_id = ? AND call.tool_id = 'sandbox-file.write'
         AND dispatch.state IN ('claimed','dispatched') LIMIT 1`,
    ).get(operation.roomId)?.busy === 1) {
      return { kind: "rejected", reason: "side_effect_slot_busy" };
    }
  }
  const occurredAt = new Date(operation.now).toISOString();
  const expectedPhase = operation.toolId === "sandbox-file.write"
    ? "waiting_confirmation" : "read_tool";
  if (binding.phase !== expectedPhase) {
    return { kind: "rejected", reason: "execution_version_stale" };
  }
  const executionClaim = database.prepare(
    `UPDATE agent_execution_runtime_states
     SET phase = ?, authority_version = authority_version + 1, updated_at = ?
     WHERE execution_id = ? AND public_status = 'running'
       AND phase = ? AND authority_version = ?`,
  ).run(operation.toolId === "sandbox-file.write" ? "side_effect_claimed" : "read_tool",
    occurredAt, operation.executionId, expectedPhase, operation.expectedExecutionVersion);
  if (executionClaim.changes !== 1) {
    return { kind: "rejected", reason: "execution_version_stale" };
  }
  const attemptClaim = database.prepare(
    `UPDATE agent_execution_attempt_runtime_states
     SET phase = ?, attempt_version = attempt_version + 1
     WHERE execution_id = ? AND attempt_seq = ? AND public_status = 'running'
       AND phase = ? AND attempt_version = ?`,
  ).run(operation.toolId === "sandbox-file.write" ? "side_effect_claimed" : "read_tool",
    operation.executionId, operation.attemptSeq, expectedPhase,
    binding.attemptVersion as number);
  if (attemptClaim.changes !== 1) {
    return { kind: "rejected", reason: "execution_version_stale" };
  }
  const dispatchId = stableId("tool-dispatch", operation.toolCallId, operation.grantId);
  database.prepare(
    `INSERT INTO tool_dispatches_v2 (
       dispatch_id, tool_call_id, grant_id, state, prepared_at, claimed_at,
       dispatched_at, version, changed_at
     ) VALUES (?, ?, ?, 'claimed', ?, ?, ?, 2, ?)`,
  ).run(dispatchId, operation.toolCallId, operation.grantId,
    occurredAt, occurredAt, occurredAt, occurredAt);
  database.prepare(
    `INSERT INTO tool_dispatch_transitions_v2 (
       transition_id, dispatch_id, from_state, to_state, transition_version, occurred_at
     ) VALUES (?, ?, NULL, 'prepared', 1, ?),
              (?, ?, 'prepared', 'claimed', 2, ?)`,
  ).run(stableId("tool-dispatch-prepared", dispatchId), dispatchId, occurredAt,
    stableId("tool-dispatch-claimed", dispatchId), dispatchId, occurredAt);
  database.prepare(
    `UPDATE tool_grants_v2 SET state = 'claimed', claimed_at = ?, version = version + 1,
       changed_at = ? WHERE grant_id = ? AND state = 'active'`,
  ).run(occurredAt, occurredAt, operation.grantId);
  database.prepare(
    `INSERT INTO tool_grant_transitions_v2 (
       transition_id, grant_id, from_state, to_state, transition_version, occurred_at
     ) VALUES (?, ?, 'active', 'claimed', ?, ?)`,
  ).run(stableId("tool-grant-claimed", operation.grantId), operation.grantId,
    (grant.version as number) + 1, occurredAt);
  writeRepair(database, "tool-grant", operation.grantId, operation.roomId,
    (grant.version as number) + 1, { grantId: operation.grantId,
      toolCallId: operation.toolCallId, dispatchId, state: "claimed",
      version: (grant.version as number) + 1 }, occurredAt);
  writeRepair(database, "tool-dispatch", dispatchId, operation.roomId, 2,
    { dispatchId, toolCallId: operation.toolCallId, state: "claimed", version: 2 }, occurredAt);
  return { kind: "claimed", dispatchId, toolId: operation.toolId,
    parameters: parsedParameters,
    ...(compensation === undefined ? {} : {
      compensationToken: compensation.compensationToken as string,
      compensationOfDispatchId: compensation.originalDispatchId as string,
    }) };
}

function freezeParentForUnknownOutcome(
  database: DatabaseSync,
  executionId: string,
  attemptSeq: number,
  occurredAt: string,
): void {
  const current = database.prepare(
    `SELECT execution.status, execution.current_attempt_seq AS currentAttemptSeq,
            execution.terminal_error_code AS terminalErrorCode,
            attempt.status AS attemptStatus, attempt.error_code AS attemptErrorCode,
            runtime.public_status AS publicStatus, runtime.phase,
            runtime.review_state AS reviewState,
            attempt_runtime.public_status AS attemptPublicStatus,
            attempt_runtime.phase AS attemptPhase
     FROM agent_executions AS execution
     JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = execution.id AND attempt.attempt_seq = ?
     JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = execution.id
     JOIN agent_execution_attempt_runtime_states AS attempt_runtime
       ON attempt_runtime.execution_id = execution.id AND attempt_runtime.attempt_seq = ?
     WHERE execution.id = ?`,
  ).get(attemptSeq, attemptSeq, executionId);
  if (current === undefined || current.currentAttemptSeq !== attemptSeq ||
      current.status === "completed" || current.attemptStatus === "completed") {
    return fail("execution_conflict", "Unknown side-effect parent binding was stale");
  }
  if (current.status === "failed" && current.terminalErrorCode === "side_effect_outcome_unknown" &&
      current.attemptStatus === "failed" && current.attemptErrorCode === "side_effect_outcome_unknown" &&
      current.publicStatus === "failed" && current.phase === "failed" &&
      current.reviewState === "needs_review" && current.attemptPublicStatus === "failed" &&
      current.attemptPhase === "failed") return;

  database.prepare(
    `UPDATE agent_execution_runtime_states
     SET review_state = 'needs_review', authority_version = authority_version + 1,
         updated_at = ?
     WHERE execution_id = ? AND public_status IN ('running','failed','cancelled')
       AND phase IN ('side_effect_claimed','failed','cancelled')
       AND review_state <> 'needs_review'`,
  ).run(occurredAt, executionId);
  const attemptClosed = database.prepare(
    `UPDATE agent_execution_attempts
     SET status = 'failed', finished_at = ?, error_code = 'side_effect_outcome_unknown',
         next_retry_at = NULL
     WHERE execution_id = ? AND attempt_seq = ?
       AND status IN ('running','failed','cancelled')`,
  ).run(occurredAt, executionId, attemptSeq);
  const executionClosed = database.prepare(
    `UPDATE agent_executions
     SET status = 'failed', cancellation_reason = NULL, completed_at = ?, updated_at = ?,
         terminal_error_code = 'side_effect_outcome_unknown', dead_lettered_at = NULL,
         next_retry_at = NULL,
         tool_dispatch_phase = CASE WHEN action_category = 'tool_call'
           THEN 'finished' ELSE tool_dispatch_phase END
     WHERE id = ? AND current_attempt_seq = ?
       AND status IN ('running','failed','cancelled')`,
  ).run(occurredAt, occurredAt, executionId, attemptSeq);
  const closed = database.prepare(
    `SELECT execution.status, execution.terminal_error_code AS terminalErrorCode,
            attempt.status AS attemptStatus, attempt.error_code AS attemptErrorCode,
            runtime.public_status AS publicStatus, runtime.phase,
            runtime.review_state AS reviewState,
            attempt_runtime.public_status AS attemptPublicStatus,
            attempt_runtime.phase AS attemptPhase
     FROM agent_executions AS execution
     JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = execution.id AND attempt.attempt_seq = ?
     JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = execution.id
     JOIN agent_execution_attempt_runtime_states AS attempt_runtime
       ON attempt_runtime.execution_id = execution.id AND attempt_runtime.attempt_seq = ?
     WHERE execution.id = ?`,
  ).get(attemptSeq, attemptSeq, executionId);
  if (attemptClosed.changes !== 1 || executionClosed.changes !== 1 ||
      closed?.status !== "failed" || closed.terminalErrorCode !== "side_effect_outcome_unknown" ||
      closed.attemptStatus !== "failed" || closed.attemptErrorCode !== "side_effect_outcome_unknown" ||
      closed.publicStatus !== "failed" || closed.phase !== "failed" ||
      closed.reviewState !== "needs_review" || closed.attemptPublicStatus !== "failed" ||
      closed.attemptPhase !== "failed") {
    return fail("execution_conflict", "Unknown side-effect parent closure lost its CAS");
  }
}

function settle(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.settle" }>,
): ToolSafetyAuthorityResult {
  const summaryJson = JSON.stringify(operation.summary);
  if (Buffer.byteLength(summaryJson, "utf8") > 8_192) {
    return fail("invalid_parameters", "Tool settlement summary exceeded its safe bound");
  }
  if ((operation.sealedCompensation !== undefined && operation.state !== "known_succeeded") ||
      (operation.sealedCompensation !== undefined &&
        Buffer.byteLength(operation.sealedCompensation, "utf8") > 1_048_576)) {
    return fail("invalid_parameters", "Tool compensation settlement binding was rejected");
  }
  const dispatch = database.prepare(
    `SELECT dispatch.state, dispatch.reason, dispatch.version, call.room_id AS roomId,
            dispatch.tool_call_id AS toolCallId, call.execution_id AS executionId,
            call.attempt_seq AS attemptSeq, call.tool_id AS toolId,
            confirmation.principal_human_actor_id AS confirmationPrincipalActorId,
            room.owner_actor_id AS roomOwnerActorId,
            review.review_id AS reviewId
     FROM tool_dispatches_v2 AS dispatch
     JOIN tool_calls_v2 AS call ON call.tool_call_id = dispatch.tool_call_id
     JOIN rooms AS room ON room.id = call.room_id
     LEFT JOIN tool_grants_v2 AS grant ON grant.grant_id = dispatch.grant_id
     LEFT JOIN tool_confirmations_v2 AS confirmation
       ON confirmation.confirmation_id = grant.confirmation_id
     LEFT JOIN tool_reviews_v2 AS review ON review.dispatch_id = dispatch.dispatch_id
     WHERE dispatch.dispatch_id = ?`,
  ).get(operation.dispatchId);
  if (dispatch === undefined) return fail("execution_conflict", "Tool dispatch was not found");
  if (dispatch.state === operation.state && (dispatch.version as number) >= operation.expectedVersion) {
    return { kind: "settled", dispatchId: operation.dispatchId, state: operation.state,
      version: dispatch.version as number, replayed: true };
  }
  const lateKnownAfterFence = dispatch.state === "outcome_unknown" &&
    operation.state !== "outcome_unknown" && dispatch.reviewId === null &&
    (dispatch.reason === "execution_cancelled" || dispatch.reason === "source_recalled" ||
      dispatch.reason === "principal_revoked") &&
    dispatch.version === operation.expectedVersion + 1;
  if (!lateKnownAfterFence &&
      ((dispatch.state !== "claimed" && dispatch.state !== "dispatched") ||
       dispatch.version !== operation.expectedVersion)) {
    return fail("execution_conflict", "Tool dispatch settlement was terminal");
  }
  const occurredAt = new Date(operation.now).toISOString();
  const nextVersion = (dispatch.version as number) + 1;
  const dispatchSettled = database.prepare(
    `UPDATE tool_dispatches_v2 SET state = ?, reason = ?, safe_summary_json = ?,
       sealed_compensation_ciphertext = ?,
       settled_at = ?, version = ?, changed_at = ?
     WHERE dispatch_id = ? AND state = ? AND version = ?`,
  ).run(operation.state, operation.state === "outcome_unknown" ? "adapter_ambiguous" : null,
    summaryJson, operation.sealedCompensation ?? null, occurredAt, nextVersion, occurredAt,
    operation.dispatchId, dispatch.state as string, dispatch.version as number);
  if (dispatchSettled.changes !== 1) {
    return fail("execution_conflict", "Tool dispatch settlement lost its version CAS");
  }
  database.prepare(
    `INSERT INTO tool_dispatch_transitions_v2 (
       transition_id, dispatch_id, from_state, to_state, reason,
       safe_summary_sha256, transition_version, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(stableId("tool-dispatch-settle", operation.dispatchId, String(nextVersion)),
    operation.dispatchId, dispatch.state as string, operation.state,
    operation.state === "outcome_unknown" ? "adapter_ambiguous" : null,
    createHash("sha256").update(summaryJson).digest("hex"), nextVersion, occurredAt);
  writeRepair(database, "tool-dispatch", operation.dispatchId, dispatch.roomId as string,
    nextVersion, { dispatchId: operation.dispatchId, toolCallId: dispatch.toolCallId,
      state: operation.state, summary: operation.summary, version: nextVersion }, occurredAt);
  const compensation = database.prepare(
    `SELECT lineage.lineage_id AS lineageId,
            lineage.original_dispatch_id AS originalDispatchId,
            lineage.compensation_invocation_id AS invocationId,
            lineage.compensation_execution_id AS executionId,
            lineage.compensation_tool_call_id AS toolCallId,
            call.attempt_seq AS attemptSeq
     FROM tool_compensation_lineage_v2 AS lineage
     JOIN tool_calls_v2 AS call ON call.tool_call_id = lineage.compensation_tool_call_id
     WHERE lineage.compensation_tool_call_id = ?`,
  ).get(dispatch.toolCallId as string);
  if (dispatch.toolId === "sandbox-file.write" && operation.state === "outcome_unknown" &&
      compensation === undefined) {
    freezeParentForUnknownOutcome(database, dispatch.executionId as string,
      dispatch.attemptSeq as number, occurredAt);
  }
  if (compensation !== undefined && dispatch.state !== "outcome_unknown") {
    const succeeded = operation.state === "known_succeeded";
    const errorCode = operation.state === "outcome_unknown"
      ? "side_effect_outcome_unknown" : "tool_failure";
    if (operation.state === "outcome_unknown") {
      const reviewMarked = database.prepare(
        `UPDATE agent_execution_runtime_states
         SET authority_version = authority_version + 1, review_state = 'needs_review',
             updated_at = ?
         WHERE execution_id = ? AND public_status = 'running'
           AND phase = 'side_effect_claimed' AND review_state = 'none'`,
      ).run(occurredAt, compensation.executionId as string);
      if (reviewMarked.changes !== 1) {
        return fail("execution_conflict", "Compensation review fence lost its CAS");
      }
    }
    const attemptClosed = database.prepare(
      `UPDATE agent_execution_attempts
       SET status = ?, finished_at = ?, error_code = ?, next_retry_at = NULL
       WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
    ).run(succeeded ? "completed" : "failed", occurredAt, succeeded ? null : errorCode,
      compensation.executionId as string, compensation.attemptSeq as number);
    const executionClosed = database.prepare(
      `UPDATE agent_executions
       SET status = ?, completed_at = ?, updated_at = ?, terminal_error_code = ?,
           next_retry_at = NULL, tool_dispatch_phase = 'finished'
       WHERE id = ? AND status = 'running'`,
    ).run(succeeded ? "completed" : "failed", occurredAt, occurredAt,
      succeeded ? null : errorCode, compensation.executionId as string);
    const runtime = database.prepare(
      `SELECT public_status AS publicStatus, phase, review_state AS reviewState
       FROM agent_execution_runtime_states WHERE execution_id = ?`,
    ).get(compensation.executionId as string);
    const attemptRuntime = database.prepare(
      `SELECT public_status AS publicStatus, phase
       FROM agent_execution_attempt_runtime_states
       WHERE execution_id = ? AND attempt_seq = ?`,
    ).get(compensation.executionId as string, compensation.attemptSeq as number);
    const expectedTerminal = succeeded ? "completed" : "failed";
    if (attemptClosed.changes !== 1 || executionClosed.changes !== 1 ||
        runtime?.publicStatus !== expectedTerminal || runtime.phase !== expectedTerminal ||
        attemptRuntime?.publicStatus !== expectedTerminal || attemptRuntime.phase !== expectedTerminal ||
        (operation.state === "outcome_unknown" && runtime.reviewState !== "needs_review")) {
      return fail("execution_conflict", "Compensation parent closure lost its CAS");
    }
    writeRepair(database, "tool-compensation", compensation.lineageId as string,
      dispatch.roomId as string, nextVersion, {
        lineageId: compensation.lineageId,
        originalDispatchId: compensation.originalDispatchId,
        compensationInvocationId: compensation.invocationId,
        compensationExecutionId: compensation.executionId,
        compensationToolCallId: compensation.toolCallId,
        state: operation.state,
        version: nextVersion,
      }, occurredAt);
  }
  return { kind: "settled", dispatchId: operation.dispatchId,
    state: operation.state, version: nextVersion, replayed: false };
}

function offerHandoff(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.handoff-offer" }>,
): ToolSafetyAuthorityResult {
  const actorId = requireHumanSession(database, operation.context, operation.now);
  const row = database.prepare(
    `SELECT confirmation.tool_call_id AS toolCallId,
            confirmation.principal_human_actor_id AS principalActorId,
            confirmation.binding_generation AS bindingGeneration,
            confirmation.state, confirmation.version, confirmation.expires_at AS expiresAt,
            call.execution_id AS executionId, call.invocation_id AS invocationId,
            call.attempt_seq AS attemptSeq, call.execution_version AS executionVersion,
            call.room_id AS roomId, call.tool_id AS toolId
     FROM tool_confirmations_v2 AS confirmation
     JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
     WHERE confirmation.confirmation_id = ?`,
  ).get(operation.confirmationId);
  if (row === undefined || row.principalActorId !== actorId) {
    return fail("permission_denied", "Only the named Human can offer confirmation handoff");
  }
  requireHumanMembership(database, row.roomId as string, actorId);
  requireHumanMembership(database, row.roomId as string, operation.targetActorId);
  if (row.state !== "pending" || row.version !== operation.expectedVersion ||
      Date.parse(row.expiresAt as string) <= operation.now) {
    return fail("execution_conflict", "Confirmation handoff targeted a stale binding");
  }
  requireCurrentExecution(database, { executionId: row.executionId as string,
    invocationId: row.invocationId as string, attemptSeq: row.attemptSeq as number,
    expectedExecutionVersion: row.executionVersion as number, toolId: row.toolId as ToolId });
  const existing = database.prepare(
    `SELECT handoff_id AS handoffId, to_principal_human_actor_id AS targetActorId, state
     FROM tool_confirmation_handoffs_v2
     WHERE confirmation_id = ? AND from_binding_generation = ?`,
  ).get(operation.confirmationId, row.bindingGeneration as number);
  if (existing !== undefined) {
    if (existing.handoffId !== operation.handoffId ||
        existing.targetActorId !== operation.targetActorId || existing.state !== "offered") {
      return fail("execution_conflict", "Confirmation handoff offer already has a winner");
    }
    return { kind: "handoff", handoffId: operation.handoffId,
      confirmationId: operation.confirmationId, state: "offered",
      version: operation.expectedVersion, replayed: true };
  }
  const occurredAt = new Date(operation.now).toISOString();
  database.prepare(
    `INSERT INTO tool_confirmation_handoffs_v2 (
       handoff_id, confirmation_id, from_binding_generation, to_binding_generation,
       from_principal_human_actor_id, to_principal_human_actor_id,
       offered_by_human_actor_id, accepted_by_human_actor_id, state, offered_at, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'offered', ?, NULL)`,
  ).run(operation.handoffId, operation.confirmationId, row.bindingGeneration as number,
    (row.bindingGeneration as number) + 1, actorId, operation.targetActorId, actorId, occurredAt);
  writeRepair(database, "tool-handoff", operation.handoffId, row.roomId as string, 1,
    { handoffId: operation.handoffId, confirmationId: operation.confirmationId,
      state: "offered", targetActorId: operation.targetActorId, version: 1 }, occurredAt);
  return { kind: "handoff", handoffId: operation.handoffId,
    confirmationId: operation.confirmationId, state: "offered",
    version: operation.expectedVersion, replayed: false };
}

function readHandoffBinding(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.handoff-read" }>,
): ToolSafetyAuthorityResult {
  const actorId = requireHumanSession(database, operation.context, operation.now);
  const replay = replayCommandReceipt(database, operation, "handoff_accept");
  if (replay !== undefined) return replay;
  const row = database.prepare(
    `SELECT handoff.confirmation_id AS confirmationId,
            handoff.to_principal_human_actor_id AS toPrincipalActorId,
            handoff.to_binding_generation AS toBindingGeneration,
            handoff.state AS handoffState,
            confirmation.state AS confirmationState, confirmation.version AS confirmationVersion,
            confirmation.principal_human_actor_id AS principalActorId,
            confirmation.session_family_id AS sessionFamilyId,
            confirmation.binding_generation AS bindingGeneration,
            confirmation.expires_at AS expiresAt,
            call.tool_call_id AS toolCallId, call.invocation_id AS invocationId,
            call.execution_id AS executionId, call.attempt_seq AS attemptSeq,
            call.execution_version AS executionVersion, call.room_id AS roomId,
            room.archive_generation AS roomLifecycleGeneration, call.agent_id AS agentId,
            call.tool_id AS toolId,
            call.canonical_parameter_sha256 AS parameterSha256,
            call.parameter_schema_version AS parameterSchemaVersion,
            call.canonicalizer_version AS canonicalizerVersion,
            call.source_snapshot_id AS sourceSnapshotId,
            call.sealed_payload_ciphertext AS ciphertext,
            call.sealed_payload_key_version AS keyVersion,
            call.sealed_payload_expires_at AS sealedExpiresAt
     FROM tool_confirmation_handoffs_v2 AS handoff
     JOIN tool_confirmations_v2 AS confirmation
       ON confirmation.confirmation_id = handoff.confirmation_id
     JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
     JOIN rooms AS room ON room.id = call.room_id
     WHERE handoff.handoff_id = ?`,
  ).get(operation.handoffId);
  if (row === undefined || row.toPrincipalActorId !== actorId || row.handoffState !== "offered" ||
      row.confirmationState !== "pending" || row.confirmationVersion !== operation.expectedVersion ||
      typeof row.ciphertext !== "string" || typeof row.keyVersion !== "string" ||
      typeof row.sealedExpiresAt !== "string") {
    return fail("execution_conflict", "Confirmation handoff accept binding was stale");
  }
  requireHumanMembership(database, row.roomId as string, actorId);
  const authority = frozenAuthority(database, row.executionId as string);
  return { kind: "handoff-binding", handoffId: operation.handoffId,
    confirmationId: row.confirmationId as string,
    confirmationVersion: row.confirmationVersion as number,
    toPrincipalActorId: actorId, toSessionFamilyId: operation.context.sessionFamilyId,
    parameterSchemaVersion: row.parameterSchemaVersion as string,
    sealedPayload: { ciphertext: row.ciphertext as string, keyVersion: row.keyVersion as string,
      expiresAt: row.sealedExpiresAt as string },
    claimBinding: { toolCallId: row.toolCallId as string,
      invocationId: row.invocationId as string,
      executionId: row.executionId as string, attemptSeq: row.attemptSeq as number,
      executionVersion: row.executionVersion as number, roomId: row.roomId as string,
      roomLifecycleGeneration: row.roomLifecycleGeneration as number,
      agentId: row.agentId as string, sourceSnapshotId: row.sourceSnapshotId as string,
      accessRevision: authority.accessRevision, profileId: authority.profileId,
      profileRevision: authority.profileRevision, assignmentId: authority.assignmentId,
      assignmentRevision: authority.assignmentRevision,
      canonicalParameterSha256: row.parameterSha256 as string,
      canonicalizerVersion: row.canonicalizerVersion as string, toolId: row.toolId as ToolId,
      principalActorId: row.principalActorId as string,
      sessionFamilyId: row.sessionFamilyId as string,
      bindingGeneration: row.bindingGeneration as number } };
}

function acceptHandoff(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.handoff-accept" }>,
): ToolSafetyAuthorityResult {
  const actorId = requireHumanSession(database, operation.context, operation.now);
  const row = database.prepare(
    `SELECT handoff.confirmation_id AS confirmationId,
            handoff.to_principal_human_actor_id AS targetActorId,
            handoff.to_binding_generation AS toBindingGeneration, handoff.state,
            confirmation.version AS confirmationVersion,
            confirmation.state AS confirmationState, call.room_id AS roomId,
            call.tool_call_id AS toolCallId
     FROM tool_confirmation_handoffs_v2 AS handoff
     JOIN tool_confirmations_v2 AS confirmation
       ON confirmation.confirmation_id = handoff.confirmation_id
     JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
     WHERE handoff.handoff_id = ?`,
  ).get(operation.handoffId);
  if (row === undefined || row.targetActorId !== actorId || row.state !== "offered" ||
      row.confirmationState !== "pending" || row.confirmationVersion !== operation.expectedVersion ||
      operation.resealedPayload.expiresAt === undefined ||
      Date.parse(operation.resealedPayload.expiresAt) <= operation.now) {
    return fail("execution_conflict", "Confirmation handoff accept lost its CAS");
  }
  requireHumanMembership(database, row.roomId as string, actorId);
  const occurredAt = new Date(operation.now).toISOString();
  const nextVersion = operation.expectedVersion + 1;
  const changed = database.prepare(
    `UPDATE tool_confirmations_v2
     SET principal_human_actor_id = ?, session_family_id = ?, binding_generation = ?,
         version = ?, changed_at = ?
     WHERE confirmation_id = ? AND state = 'pending' AND version = ?`,
  ).run(actorId, operation.context.sessionFamilyId, row.toBindingGeneration as number,
    nextVersion, occurredAt, row.confirmationId as string, operation.expectedVersion);
  if (changed.changes !== 1) return fail("execution_conflict", "Handoff accept lost its winner CAS");
  database.prepare(
    `UPDATE tool_calls_v2 SET binding_generation = ?, sealed_payload_ciphertext = ?,
       sealed_payload_key_version = ?, sealed_payload_expires_at = ?,
       current_version = current_version + 1
     WHERE tool_call_id = ?`,
  ).run(row.toBindingGeneration as number, operation.resealedPayload.ciphertext,
    operation.resealedPayload.keyVersion, operation.resealedPayload.expiresAt,
    row.toolCallId as string);
  database.prepare(
    `UPDATE tool_confirmation_handoffs_v2
     SET state = 'accepted', accepted_by_human_actor_id = ?, resolved_at = ?
     WHERE handoff_id = ? AND state = 'offered'`,
  ).run(actorId, occurredAt, operation.handoffId);
  writeRepair(database, "tool-confirmation", row.confirmationId as string,
    row.roomId as string, nextVersion, {
      confirmationId: row.confirmationId, toolCallId: row.toolCallId,
      state: "pending", version: nextVersion,
    }, occurredAt);
  writeRepair(database, "tool-handoff", operation.handoffId, row.roomId as string, 2,
    { handoffId: operation.handoffId, confirmationId: row.confirmationId,
      state: "accepted", targetActorId: actorId, version: 2 }, occurredAt);
  return { kind: "handoff", handoffId: operation.handoffId,
    confirmationId: row.confirmationId as string, state: "accepted",
    version: nextVersion, replayed: false };
}

function review(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.outcome-review" }>,
): ToolSafetyAuthorityResult {
  const actorId = requireHumanSession(database, operation.context, operation.now);
  if (Buffer.byteLength(operation.evidenceSummary, "utf8") > REVIEW_EVIDENCE_HARD_BYTES ||
      !/^[0-9a-f]{64}$/u.test(operation.evidenceSha256) ||
      createHash("sha256").update(operation.evidenceSummary).digest("hex") !==
        operation.evidenceSha256) {
    return fail("invalid_parameters", "Tool review evidence was rejected");
  }
  const dispatch = database.prepare(
    `SELECT dispatch.state, dispatch.version, call.room_id AS roomId,
            dispatch.tool_call_id AS toolCallId,
            confirmation.principal_human_actor_id AS confirmationPrincipalActorId,
            room.owner_actor_id AS roomOwnerActorId
     FROM tool_dispatches_v2 AS dispatch
     JOIN tool_calls_v2 AS call ON call.tool_call_id = dispatch.tool_call_id
     JOIN rooms AS room ON room.id = call.room_id
     LEFT JOIN tool_grants_v2 AS grant ON grant.grant_id = dispatch.grant_id
     LEFT JOIN tool_confirmations_v2 AS confirmation
       ON confirmation.confirmation_id = grant.confirmation_id
     WHERE dispatch.dispatch_id = ?`,
  ).get(operation.dispatchId);
  if (dispatch === undefined) return fail("execution_conflict", "Tool review dispatch was not found");
  requireHumanMembership(database, dispatch.roomId as string, actorId);
  const designatedReviewer = typeof dispatch.confirmationPrincipalActorId === "string"
    ? dispatch.confirmationPrincipalActorId : dispatch.roomOwnerActorId;
  if (designatedReviewer !== actorId) {
    return fail("permission_denied", "Tool review requires the designated Human principal");
  }
  const existing = database.prepare(
    `SELECT review_id AS reviewId, resolution, evidence_summary AS evidenceSummary,
            evidence_sha256 AS evidenceSha256,
            compensation_tool_call_id AS compensationToolCallId, version
     FROM tool_reviews_v2 WHERE dispatch_id = ?`,
  ).get(operation.dispatchId);
  if (existing !== undefined) {
    if (existing.resolution !== operation.resolution ||
        existing.evidenceSummary !== operation.evidenceSummary ||
        existing.evidenceSha256 !== operation.evidenceSha256 ||
        (operation.compensationToolCallId !== undefined &&
          existing.compensationToolCallId !== operation.compensationToolCallId)) {
      return fail("execution_conflict", "Tool review payload changed after commit");
    }
    return { kind: "reviewed", dispatchId: operation.dispatchId,
      reviewId: existing.reviewId as string, resolution: operation.resolution,
      version: existing.version as number, replayed: true };
  }
  if (dispatch.state !== "outcome_unknown" || dispatch.version !== operation.expectedVersion) {
    return fail("execution_conflict", "Tool review targeted a stale dispatch");
  }
  const inferredCompensation = operation.resolution === "compensated" &&
      operation.compensationToolCallId === undefined ? database.prepare(
        `SELECT lineage.compensation_tool_call_id AS toolCallId
         FROM tool_compensation_lineage_v2 AS lineage
         JOIN tool_dispatches_v2 AS compensation
           ON compensation.tool_call_id = lineage.compensation_tool_call_id
         WHERE lineage.original_dispatch_id = ? AND compensation.state = 'known_succeeded'`,
      ).get(operation.dispatchId)?.toolCallId : undefined;
  const compensationToolCallId = operation.compensationToolCallId ??
    (typeof inferredCompensation === "string" ? inferredCompensation : undefined);
  if ((operation.resolution === "compensated") !==
      (compensationToolCallId !== undefined)) {
    return fail("invalid_parameters", "Compensated review requires a new compensation tool call");
  }
  if (compensationToolCallId !== undefined && database.prepare(
    `SELECT 1 AS succeeded
     FROM tool_compensation_lineage_v2 AS lineage
     JOIN tool_dispatches_v2 AS compensation
       ON compensation.tool_call_id = lineage.compensation_tool_call_id
     WHERE lineage.original_dispatch_id = ?
       AND lineage.compensation_tool_call_id = ?
       AND compensation.state = 'known_succeeded'`,
  ).get(operation.dispatchId, compensationToolCallId)?.succeeded !== 1) {
    return fail("execution_conflict", "Compensation tool call has not known-succeeded");
  }
  const occurredAt = new Date(operation.now).toISOString();
  const reviewId = stableId("tool-review", operation.dispatchId, String(operation.expectedVersion));
  database.prepare(
    `INSERT INTO tool_reviews_v2 (
       review_id, dispatch_id, principal_human_actor_id, resolution,
       evidence_summary, evidence_sha256, compensation_tool_call_id, version, reviewed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(reviewId, operation.dispatchId, actorId, operation.resolution,
    operation.evidenceSummary, operation.evidenceSha256,
    compensationToolCallId ?? null, occurredAt);
  database.prepare(
    `UPDATE tool_dispatches_v2 SET state = 'reviewed', version = version + 1,
       changed_at = ? WHERE dispatch_id = ? AND state = 'outcome_unknown' AND version = ?`,
  ).run(occurredAt, operation.dispatchId, operation.expectedVersion);
  const version = operation.expectedVersion + 1;
  database.prepare(
    `INSERT INTO tool_dispatch_transitions_v2 (
       transition_id, dispatch_id, from_state, to_state, reason,
       transition_version, occurred_at
     ) VALUES (?, ?, 'outcome_unknown', 'reviewed', ?, ?, ?)`,
  ).run(stableId("tool-dispatch-reviewed", operation.dispatchId), operation.dispatchId,
    operation.resolution, version, occurredAt);
  writeRepair(database, "tool-review", reviewId, dispatch.roomId as string, 1,
    { reviewId, dispatchId: operation.dispatchId, resolution: operation.resolution,
      reviewedByActorId: actorId, version: 1 }, occurredAt);
  writeRepair(database, "tool-dispatch", operation.dispatchId, dispatch.roomId as string,
    version, { dispatchId: operation.dispatchId, toolCallId: dispatch.toolCallId,
      state: "reviewed", reviewId, resolution: operation.resolution, version }, occurredAt);
  return { kind: "reviewed", dispatchId: operation.dispatchId, reviewId,
    resolution: operation.resolution, version, replayed: false };
}

function proposeCompensation(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.compensation-propose" }>,
): ToolSafetyAuthorityResult {
  const actorId = requireHumanSession(database, operation.context, operation.now);
  const original = database.prepare(
    `SELECT dispatch.state, dispatch.version,
            dispatch.sealed_compensation_ciphertext AS sealedCompensation,
            call.tool_call_id AS originalToolCallId, call.execution_id AS originalExecutionId,
            call.room_id AS roomId, call.agent_id AS agentId,
            runtime.snapshot_id AS sourceSnapshotId, runtime.provider_id AS providerId,
            runtime.model_id AS modelId, execution.trigger_message_id AS sourceMessageId,
            source.author_id AS sourceAuthorId, room.archive_generation AS archiveGeneration,
            room.owner_actor_id AS roomOwnerActorId,
            confirmation.principal_human_actor_id AS confirmationPrincipalActorId
     FROM tool_dispatches_v2 AS dispatch
     JOIN tool_calls_v2 AS call ON call.tool_call_id = dispatch.tool_call_id
     JOIN agent_executions AS execution ON execution.id = call.execution_id
     JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = call.execution_id
     JOIN messages AS source ON source.id = execution.trigger_message_id
     JOIN rooms AS room ON room.id = call.room_id
     LEFT JOIN tool_grants_v2 AS grant ON grant.grant_id = dispatch.grant_id
     LEFT JOIN tool_confirmations_v2 AS confirmation
       ON confirmation.confirmation_id = grant.confirmation_id
     WHERE dispatch.dispatch_id = ?`,
  ).get(operation.dispatchId);
  if (original === undefined ||
      (original.state !== "known_succeeded" && original.state !== "outcome_unknown") ||
      original.version !== operation.expectedVersion ||
      typeof original.sealedCompensation !== "string" ||
      typeof original.originalExecutionId !== "string" || typeof original.roomId !== "string" ||
      typeof original.agentId !== "string" || typeof original.sourceSnapshotId !== "string" ||
      typeof original.sourceMessageId !== "string" || typeof original.sourceAuthorId !== "string" ||
      typeof original.archiveGeneration !== "number") {
    return fail("execution_conflict", "Compensation proposal targeted a stale or non-compensatable dispatch");
  }
  requireHumanMembership(database, original.roomId, actorId);
  const designated = typeof original.confirmationPrincipalActorId === "string"
    ? original.confirmationPrincipalActorId : original.roomOwnerActorId;
  if (designated !== actorId) {
    return fail("permission_denied", "Compensation requires the named Human or Room owner");
  }
  const authority = frozenAuthority(database, original.originalExecutionId);
  if (!authority.effectiveToolIds.includes("sandbox-file.write")) {
    return fail("permission_denied", "Compensation tool authority was revoked");
  }
  const suffix = stableId(actorId, operation.context.idempotencyKey,
    operation.dispatchId, String(operation.expectedVersion));
  if (operation.invocationId !== `tool-compensation-invocation-${suffix}` ||
      operation.executionId !== `tool-compensation-execution-${suffix}` ||
      operation.toolCallId !== `tool-compensation-call-${suffix}` ||
      operation.confirmationId !== `tool-compensation-confirmation-${suffix}`) {
    return fail("invalid_parameters", "Compensation identities were not server-derived");
  }
  const canonicalReference = JSON.stringify({
    operation: "compensate",
    originalDispatchId: operation.dispatchId,
  });
  const expectedParameterSha256 = createHash("sha256").update(canonicalReference).digest("hex");
  const expectedCiphertext = createHash("sha256")
    .update(`reference\0${canonicalReference}`).digest("base64url");
  if (operation.canonicalParameterSha256 !== expectedParameterSha256 ||
      operation.sealedReference.keyVersion !== "dao-compensation-reference.v1" ||
      operation.sealedReference.ciphertext !== expectedCiphertext) {
    return fail("invalid_parameters", "Compensation reference binding changed");
  }
  const expiresAt = timestamp(operation.sealedReference.expiresAt,
    operation.now, CONFIRMATION_TTL_HARD_MS);
  const existing = database.prepare(
    `SELECT lineage_id AS lineageId FROM tool_compensation_lineage_v2
     WHERE compensation_execution_id = ? AND original_dispatch_id = ?
       AND compensation_tool_call_id = ? AND proposed_by_human_actor_id = ?`,
  ).get(operation.executionId, operation.dispatchId, operation.toolCallId, actorId);
  if (typeof existing?.lineageId === "string") {
    return { kind: "compensation-proposed", lineageId: existing.lineageId,
      originalDispatchId: operation.dispatchId, invocationId: operation.invocationId,
      executionId: operation.executionId, toolCallId: operation.toolCallId,
      confirmationId: operation.confirmationId, version: 1, replayed: true };
  }
  const occurredAt = new Date(operation.now).toISOString();
  database.prepare(
    `INSERT INTO agent_executions (
       id, room_id, room_archive_generation, agent_id, trigger_message_id, status, started_at,
       requester_actor_id, tool_name, action_category, tool_dispatch_phase,
       current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
       queued_at, updated_at, compensates_execution_id
     ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, 'sandbox-file.write', 'tool_call',
               'not_started', 1, 1, 1, ?, ?, 0, ?, ?, ?)`,
  ).run(operation.executionId, original.roomId, original.archiveGeneration,
    original.agentId, original.sourceMessageId, occurredAt, actorId,
    original.providerId ?? null, original.modelId ?? null, occurredAt, occurredAt,
    original.originalExecutionId);
  database.prepare(
    `INSERT INTO agent_execution_attempts (
       execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
       action_category, started_at, recovery_cursor
     ) VALUES (?, 1, 1, 1, 'running', 'tool_call', ?, 0)`,
  ).run(operation.executionId, occurredAt);
  database.prepare(
    `INSERT INTO agent_invocation_intents (
       id, room_id, source_message_id, target_agent_id, requester_actor_id,
       intent_kind, execution_id, created_at, message_transaction_id, target_id,
       source_revision, lineage_id, turn_id, origin_kind, status, claimed_at,
       cancelled_at, cancellation_reason, supersedes_intent_id
     ) VALUES (?, ?, ?, ?, ?, 'structured_help', ?, ?, NULL, NULL,
               1, ?, 'compensation', 'legacy_runtime', 'claimed', ?, NULL, NULL, NULL)`,
  ).run(operation.invocationId, original.roomId, original.sourceMessageId,
    original.agentId, original.sourceAuthorId, operation.executionId, occurredAt,
    operation.invocationId, occurredAt);
  database.prepare(
    `INSERT INTO agent_execution_intent_links (
       intent_id, execution_id, execution_ordinal, retry_of_execution_id,
       source_revision, linked_at
     ) VALUES (?, ?, 1, NULL, 1, ?)`,
  ).run(operation.invocationId, operation.executionId, occurredAt);
  const runtimePrepared = database.prepare(
    `UPDATE agent_execution_runtime_states
     SET snapshot_id = ?, phase = 'waiting_confirmation', authority_version = 2,
         review_state = 'none', updated_at = ?
     WHERE execution_id = ? AND public_status = 'running' AND phase = 'claiming'
       AND authority_version = 1 AND snapshot_id IS NULL
       AND review_state = 'legacy_review_required'`,
  ).run(original.sourceSnapshotId, occurredAt, operation.executionId);
  const attemptPrepared = database.prepare(
    `UPDATE agent_execution_attempt_runtime_states
     SET phase = 'waiting_confirmation', attempt_version = 2
     WHERE execution_id = ? AND attempt_seq = 1 AND public_status = 'running'
       AND phase = 'claiming' AND attempt_version = 1`,
  ).run(operation.executionId);
  if (runtimePrepared.changes !== 1 || attemptPrepared.changes !== 1) {
    return fail("execution_conflict", "Compensation runtime preparation lost its CAS");
  }
  const safePreview = Object.freeze({
    schemaVersion: "tool-safe-preview.v1",
    target: `原工具调用 ${operation.dispatchId}`,
    summary: "执行一个新的补偿副作用动作",
    impact: "仅在原写入结果仍精确匹配时恢复先前内容",
    reversibility: "unknown",
  });
  database.prepare(
    `INSERT INTO tool_calls_v2 (
       tool_call_id, invocation_id, execution_id, attempt_seq, execution_version,
       room_id, agent_id, tool_id, canonical_parameter_sha256,
       parameter_schema_version, canonicalizer_version, source_snapshot_id,
       profile_revision, assignment_revision, access_revision, safe_preview_json,
       sealed_payload_ciphertext, sealed_payload_key_version, sealed_payload_expires_at,
       binding_generation, current_version, created_at, legacy_origin
     ) VALUES (?, ?, ?, 1, 2, ?, ?, 'sandbox-file.write', ?,
               'sandbox-file.write.compensation.v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'stage12')`,
  ).run(operation.toolCallId, operation.invocationId, operation.executionId,
    original.roomId, original.agentId, operation.canonicalParameterSha256,
    TOOL_CANONICALIZER_VERSION, original.sourceSnapshotId, authority.profileRevision,
    authority.assignmentRevision, authority.accessRevision, JSON.stringify(safePreview),
    operation.sealedReference.ciphertext, operation.sealedReference.keyVersion,
    expiresAt, occurredAt);
  database.prepare(
    `INSERT INTO tool_confirmations_v2 (
       confirmation_id, tool_call_id, principal_human_actor_id, session_family_id,
       binding_generation, state, expires_at, version, created_at, changed_at
     ) VALUES (?, ?, ?, ?, 1, 'pending', ?, 1, ?, ?)`,
  ).run(operation.confirmationId, operation.toolCallId, actorId,
    operation.context.sessionFamilyId, expiresAt, occurredAt, occurredAt);
  const lineageId = `tool-compensation-lineage-${suffix}`;
  database.prepare(
    `INSERT INTO tool_compensation_lineage_v2 (
       lineage_id, original_dispatch_id, compensation_invocation_id,
       compensation_execution_id, compensation_tool_call_id, proposed_by_human_actor_id,
       profile_id, profile_revision, assignment_id, assignment_revision, access_revision,
       proposed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(lineageId, operation.dispatchId, operation.invocationId, operation.executionId,
    operation.toolCallId, actorId, authority.profileId, authority.profileRevision,
    authority.assignmentId, authority.assignmentRevision, authority.accessRevision, occurredAt);
  writeRepair(database, "tool-call", operation.toolCallId, original.roomId, 1,
    { toolCallId: operation.toolCallId, toolId: "sandbox-file.write", safePreview,
      state: "prepared", version: 1 }, occurredAt);
  writeRepair(database, "tool-confirmation", operation.confirmationId, original.roomId, 1,
    { confirmationId: operation.confirmationId, toolCallId: operation.toolCallId,
      state: "pending", safePreview, expiresAt, version: 1 }, occurredAt);
  writeRepair(database, "tool-compensation", lineageId, original.roomId, 1,
    { lineageId, originalDispatchId: operation.dispatchId,
      compensationInvocationId: operation.invocationId,
      compensationExecutionId: operation.executionId,
      compensationToolCallId: operation.toolCallId,
      state: "pending", version: 1 }, occurredAt);
  return { kind: "compensation-proposed", lineageId,
    originalDispatchId: operation.dispatchId, invocationId: operation.invocationId,
    executionId: operation.executionId, toolCallId: operation.toolCallId,
    confirmationId: operation.confirmationId, version: 1, replayed: false };
}

function expire(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.expire" }>,
): ToolSafetyAuthorityResult {
  if (!Number.isSafeInteger(operation.limit) || operation.limit < 1 || operation.limit > 500) {
    return fail("invalid_parameters", "Tool expiry batch limit was invalid");
  }
  const occurredAt = new Date(operation.now).toISOString();
  const confirmations = database.prepare(
    `SELECT confirmation.confirmation_id AS id,
            confirmation.tool_call_id AS toolCallId,
            confirmation.binding_generation AS bindingGeneration,
            confirmation.principal_human_actor_id AS principalActorId,
            confirmation.session_family_id AS sessionFamilyId,
            confirmation.version, call.execution_id AS executionId,
            call.attempt_seq AS attemptSeq, call.execution_version AS executionVersion,
            call.room_id AS roomId, call.safe_preview_json AS safePreviewJson
     FROM tool_confirmations_v2 AS confirmation
     JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
     WHERE confirmation.state = 'pending' AND confirmation.expires_at <= ?
     ORDER BY confirmation.expires_at, confirmation.confirmation_id LIMIT ?`,
  ).all(occurredAt, operation.limit);
  for (const row of confirmations) {
    const nextVersion = (row.version as number) + 1;
    const changed = database.prepare(
      `UPDATE tool_confirmations_v2 SET state = 'expired', reason = 'confirmation_expired',
       version = ?, changed_at = ?
       WHERE confirmation_id = ? AND state = 'pending' AND version = ?`,
    ).run(nextVersion, occurredAt, row.id as string, row.version as number);
    if (changed.changes !== 1) return fail("execution_conflict", "Confirmation expiry lost its CAS");
    database.prepare(
      `INSERT INTO tool_confirmation_decisions_v2 (
         decision_id, confirmation_id, tool_call_id, binding_generation,
         principal_human_actor_id, session_family_id, decision, reason,
         decision_version, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'expired', 'confirmation_expired', ?, ?)`,
    ).run(stableId("tool-confirmation-expired", row.id as string), row.id as string,
      row.toolCallId as string, row.bindingGeneration as number, row.principalActorId as string,
      row.sessionFamilyId as string, nextVersion, occurredAt);
    writeRepair(database, "tool-confirmation", row.id as string, row.roomId as string,
      nextVersion, { confirmationId: row.id, toolCallId: row.toolCallId, state: "expired",
        reason: "confirmation_expired", version: nextVersion,
        safePreview: JSON.parse(row.safePreviewJson as string) as unknown }, occurredAt);
    database.prepare(
      `UPDATE agent_execution_runtime_states
       SET public_status = 'failed', phase = 'failed',
           authority_version = authority_version + 1, completed_at = ?, updated_at = ?,
           terminal_error_code = 'confirmation_expired', terminal_reason = NULL,
           review_state = 'none'
       WHERE execution_id = ? AND public_status = 'running'
         AND phase = 'waiting_confirmation' AND authority_version = ?`,
    ).run(occurredAt, occurredAt, row.executionId as string, row.executionVersion as number);
    database.prepare(
      `UPDATE agent_execution_attempts
       SET status = 'failed', finished_at = ?, error_code = 'confirmation_expired',
           next_retry_at = NULL
       WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
    ).run(occurredAt, row.executionId as string, row.attemptSeq as number);
    database.prepare(
      `UPDATE agent_executions
       SET status = 'failed', completed_at = ?, updated_at = ?,
           terminal_error_code = 'confirmation_expired', next_retry_at = NULL
       WHERE id = ? AND current_attempt_seq = ? AND status = 'running'`,
    ).run(occurredAt, occurredAt, row.executionId as string, row.attemptSeq as number);
  }
  const grants = database.prepare(
    `SELECT grant.grant_id AS id, grant.version, grant.tool_call_id AS toolCallId,
            call.room_id AS roomId
     FROM tool_grants_v2 AS grant
     JOIN tool_calls_v2 AS call ON call.tool_call_id = grant.tool_call_id
     WHERE grant.state = 'active' AND grant.expires_at <= ?
     ORDER BY grant.expires_at, grant.grant_id LIMIT ?`,
  ).all(occurredAt, operation.limit);
  for (const row of grants) {
    database.prepare(
      `UPDATE tool_grants_v2 SET state = 'expired', reason = 'grant_expired',
       version = version + 1, changed_at = ? WHERE grant_id = ? AND state = 'active'`,
    ).run(occurredAt, row.id as string);
    database.prepare(
      `INSERT INTO tool_grant_transitions_v2 (
       transition_id, grant_id, from_state, to_state, reason, transition_version, occurred_at
       ) VALUES (?, ?, 'active', 'expired', 'grant_expired', ?, ?)`,
    ).run(stableId("tool-grant-expired", row.id as string), row.id as string,
      (row.version as number) + 1, occurredAt);
    writeRepair(database, "tool-grant", row.id as string, row.roomId as string,
      (row.version as number) + 1, { grantId: row.id, toolCallId: row.toolCallId,
        state: "expired", reason: "grant_expired", version: (row.version as number) + 1 },
      occurredAt);
  }
  return { kind: "expired", confirmations: confirmations.length, grants: grants.length };
}

function recoverExecution(
  database: DatabaseSync,
  operation: Extract<ToolSafetyAuthorityOperation, { type: "tool-safety.recover-execution" }>,
): ToolSafetyAuthorityResult {
  const row = database.prepare(
    `SELECT call.tool_call_id AS toolCallId, call.invocation_id AS invocationId,
            call.execution_id AS executionId, call.attempt_seq AS attemptSeq,
            call.execution_version AS executionVersion, call.room_id AS roomId,
            room.archive_generation AS roomLifecycleGeneration,
            call.agent_id AS agentId, call.tool_id AS toolId,
            call.canonical_parameter_sha256 AS parameterSha256,
            call.parameter_schema_version AS parameterSchemaVersion,
            call.canonicalizer_version AS canonicalizerVersion,
            call.source_snapshot_id AS sourceSnapshotId,
            call.binding_generation AS callBindingGeneration,
            call.sealed_payload_ciphertext AS ciphertext,
            call.sealed_payload_key_version AS keyVersion,
            call.sealed_payload_expires_at AS sealedExpiresAt,
            confirmation.confirmation_id AS confirmationId,
            confirmation.principal_human_actor_id AS principalActorId,
            confirmation.session_family_id AS sessionFamilyId,
            confirmation.binding_generation AS bindingGeneration,
            confirmation.state AS confirmationState,
            confirmation.version AS confirmationVersion,
            grant.grant_id AS grantId, grant.state AS grantState,
            grant.expires_at AS grantExpiresAt,
            dispatch.dispatch_id AS dispatchId, dispatch.state AS dispatchState,
            dispatch.version AS dispatchVersion,
            lineage.original_dispatch_id AS compensationOfDispatchId
     FROM tool_calls_v2 AS call
     JOIN rooms AS room ON room.id = call.room_id
     LEFT JOIN tool_confirmations_v2 AS confirmation
       ON confirmation.tool_call_id = call.tool_call_id
     LEFT JOIN tool_grants_v2 AS grant ON grant.tool_call_id = call.tool_call_id
     LEFT JOIN tool_dispatches_v2 AS dispatch ON dispatch.tool_call_id = call.tool_call_id
     LEFT JOIN tool_compensation_lineage_v2 AS lineage
       ON lineage.compensation_tool_call_id = call.tool_call_id
     WHERE call.execution_id = ? AND call.tool_id = 'sandbox-file.write'
     ORDER BY call.created_at DESC LIMIT 1`,
  ).get(operation.executionId);
  if (row === undefined) return { kind: "recovery", state: "none" };
  if (row.dispatchState === "claimed" || row.dispatchState === "dispatched") {
    const occurredAt = new Date(operation.now).toISOString();
    const version = (row.dispatchVersion as number) + 1;
    database.prepare(
      `UPDATE tool_dispatches_v2
       SET state = 'outcome_unknown', reason = 'shutdown', settled_at = ?,
           version = ?, changed_at = ?
       WHERE dispatch_id = ? AND state IN ('claimed','dispatched') AND version = ?`,
    ).run(occurredAt, version, occurredAt, row.dispatchId as string,
      row.dispatchVersion as number);
    database.prepare(
      `INSERT INTO tool_dispatch_transitions_v2 (
         transition_id, dispatch_id, from_state, to_state, reason,
         transition_version, occurred_at
       ) VALUES (?, ?, ?, 'outcome_unknown', 'shutdown', ?, ?)`,
    ).run(stableId("tool-dispatch-recovered-unknown", row.dispatchId as string),
      row.dispatchId as string, row.dispatchState as string, version, occurredAt);
    const reviewMarked = database.prepare(
      `UPDATE agent_execution_runtime_states
       SET review_state = 'needs_review', authority_version = authority_version + 1,
           updated_at = ?
       WHERE execution_id = ? AND public_status = 'running'
         AND phase = 'side_effect_claimed' AND review_state = 'none'`,
    ).run(occurredAt, operation.executionId);
    const attemptClosed = database.prepare(
      `UPDATE agent_execution_attempts SET status = 'failed', finished_at = ?,
         error_code = 'side_effect_outcome_unknown', next_retry_at = NULL
       WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
    ).run(occurredAt, operation.executionId, row.attemptSeq as number);
    const executionClosed = database.prepare(
      `UPDATE agent_executions SET status = 'failed', completed_at = ?, updated_at = ?,
         terminal_error_code = 'side_effect_outcome_unknown', next_retry_at = NULL
       WHERE id = ? AND status = 'running'`,
    ).run(occurredAt, occurredAt, operation.executionId);
    const runtime = database.prepare(
      `SELECT public_status AS publicStatus, phase, review_state AS reviewState
       FROM agent_execution_runtime_states WHERE execution_id = ?`,
    ).get(operation.executionId);
    const attemptRuntime = database.prepare(
      `SELECT public_status AS publicStatus, phase
       FROM agent_execution_attempt_runtime_states
       WHERE execution_id = ? AND attempt_seq = ?`,
    ).get(operation.executionId, row.attemptSeq as number);
    if (reviewMarked.changes !== 1 || attemptClosed.changes !== 1 ||
        executionClosed.changes !== 1 || runtime?.publicStatus !== "failed" ||
        runtime.phase !== "failed" || runtime.reviewState !== "needs_review" ||
        attemptRuntime?.publicStatus !== "failed" || attemptRuntime.phase !== "failed") {
      return fail("execution_conflict", "Recovered unknown parent closure lost its CAS");
    }
    writeRepair(database, "tool-dispatch", row.dispatchId as string, row.roomId as string,
      version, { dispatchId: row.dispatchId, toolCallId: row.toolCallId,
        state: "outcome_unknown", reason: "shutdown", version }, occurredAt);
    return { kind: "recovery", state: "outcome_unknown", toolCallId: row.toolCallId as string,
      dispatchId: row.dispatchId as string };
  }
  if (row.dispatchState === "outcome_unknown") {
    freezeParentForUnknownOutcome(database, operation.executionId,
      row.attemptSeq as number, new Date(operation.now).toISOString());
    return { kind: "recovery", state: "outcome_unknown",
      toolCallId: row.toolCallId as string, dispatchId: row.dispatchId as string };
  }
  if (["known_succeeded", "known_failed", "reviewed"].includes(String(row.dispatchState))) {
    return { kind: "recovery", state: row.dispatchState as "outcome_unknown" |
      "known_succeeded" | "known_failed" | "reviewed", toolCallId: row.toolCallId as string,
      dispatchId: row.dispatchId as string };
  }
  if (row.confirmationState === "pending") {
    return { kind: "recovery", state: "pending", toolCallId: row.toolCallId as string,
      confirmationId: row.confirmationId as string,
      confirmationVersion: row.confirmationVersion as number };
  }
  if (row.confirmationState !== "confirmed" || row.grantState !== "active" ||
      typeof row.grantExpiresAt !== "string" || Date.parse(row.grantExpiresAt) <= operation.now ||
      typeof row.ciphertext !== "string" || typeof row.keyVersion !== "string" ||
      typeof row.sealedExpiresAt !== "string") {
    return { kind: "recovery", state: "none" };
  }
  const authority = frozenAuthority(database, operation.executionId);
  const binding = runtimeBinding(database, operation.executionId);
  if (binding.executionVersion !== row.executionVersion || binding.phase !== "waiting_confirmation") {
    return fail("execution_conflict", "Recovered confirmation execution binding was stale");
  }
  return { kind: "recovery", state: "confirmed_active",
    toolCallId: row.toolCallId as string, confirmationId: row.confirmationId as string,
    confirmationVersion: row.confirmationVersion as number, grantId: row.grantId as string,
    ...(typeof row.compensationOfDispatchId === "string" ? {
      compensationOfDispatchId: row.compensationOfDispatchId,
    } : {}),
    parameterSchemaVersion: row.parameterSchemaVersion as string,
    sealedPayload: { ciphertext: row.ciphertext as string, keyVersion: row.keyVersion as string,
      expiresAt: row.sealedExpiresAt as string },
    claimBinding: {
      toolCallId: row.toolCallId as string,
      invocationId: row.invocationId as string, executionId: row.executionId as string,
      attemptSeq: row.attemptSeq as number, executionVersion: row.executionVersion as number,
      roomId: row.roomId as string, roomLifecycleGeneration: row.roomLifecycleGeneration as number,
      agentId: row.agentId as string, sourceSnapshotId: row.sourceSnapshotId as string,
      accessRevision: authority.accessRevision, profileId: authority.profileId,
      profileRevision: authority.profileRevision, assignmentId: authority.assignmentId,
      assignmentRevision: authority.assignmentRevision,
      canonicalParameterSha256: row.parameterSha256 as string,
      canonicalizerVersion: row.canonicalizerVersion as string, toolId: "sandbox-file.write",
      principalActorId: row.principalActorId as string,
      sessionFamilyId: row.sessionFamilyId as string,
      bindingGeneration: row.bindingGeneration as number,
    } };
}

export type ToolSafetyFenceReason = "execution_cancelled" | "source_recalled" |
  "principal_revoked";

export interface ToolSafetyFenceSettlement {
  readonly rejectedConfirmationIds: readonly string[];
  readonly revokedGrantIds: readonly string[];
  readonly preservedDispatchIds: readonly string[];
}

/** Transaction-local cancellation/revocation participant for FT-08/Room/session authorities. */
export function settleToolSafetyExecutionFenceInTransaction(
  database: DatabaseSync,
  executionId: string,
  reason: ToolSafetyFenceReason,
  occurredAt: string,
): ToolSafetyFenceSettlement {
  const rejectedConfirmationIds: string[] = [];
  const revokedGrantIds: string[] = [];
  const preservedDispatchIds: string[] = [];
  const confirmations = database.prepare(
    `SELECT confirmation.confirmation_id AS confirmationId,
            confirmation.tool_call_id AS toolCallId,
            confirmation.binding_generation AS bindingGeneration,
            confirmation.principal_human_actor_id AS principalActorId,
            confirmation.session_family_id AS sessionFamilyId,
            confirmation.version, call.room_id AS roomId
     FROM tool_confirmations_v2 AS confirmation
     JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
     WHERE call.execution_id = ? AND confirmation.state = 'pending'
     ORDER BY confirmation.confirmation_id`,
  ).all(executionId);
  for (const row of confirmations) {
    const confirmationId = row.confirmationId as string;
    const version = (row.version as number) + 1;
    const changed = database.prepare(
      `UPDATE tool_confirmations_v2
       SET state = 'rejected', reason = ?, version = ?, changed_at = ?
       WHERE confirmation_id = ? AND state = 'pending' AND version = ?`,
    ).run(reason, version, occurredAt, confirmationId, row.version as number);
    if (changed.changes !== 1) return fail("execution_conflict", "Tool fence lost confirmation CAS");
    database.prepare(
      `INSERT INTO tool_confirmation_decisions_v2 (
         decision_id, confirmation_id, tool_call_id, binding_generation,
         principal_human_actor_id, session_family_id, decision, reason,
         decision_version, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?, ?, ?)`,
    ).run(stableId("tool-fence-confirmation", confirmationId, reason), confirmationId,
      row.toolCallId as string, row.bindingGeneration as number, row.principalActorId as string,
      row.sessionFamilyId as string, reason, version, occurredAt);
    writeRepair(database, "tool-confirmation", confirmationId, row.roomId as string,
      version, { confirmationId, toolCallId: row.toolCallId, state: "rejected",
        reason, version }, occurredAt);
    rejectedConfirmationIds.push(confirmationId);
  }
  const grants = database.prepare(
    `SELECT grant.grant_id AS grantId, grant.tool_call_id AS toolCallId,
            grant.version, call.room_id AS roomId
     FROM tool_grants_v2 AS grant
     JOIN tool_calls_v2 AS call ON call.tool_call_id = grant.tool_call_id
     WHERE call.execution_id = ? AND grant.state = 'active'
     ORDER BY grant.grant_id`,
  ).all(executionId);
  for (const row of grants) {
    const grantId = row.grantId as string;
    const version = (row.version as number) + 1;
    const changed = database.prepare(
      `UPDATE tool_grants_v2
       SET state = 'revoked', reason = ?, version = ?, changed_at = ?
       WHERE grant_id = ? AND state = 'active' AND version = ?`,
    ).run(reason, version, occurredAt, grantId, row.version as number);
    if (changed.changes !== 1) return fail("execution_conflict", "Tool fence lost grant CAS");
    database.prepare(
      `INSERT INTO tool_grant_transitions_v2 (
         transition_id, grant_id, from_state, to_state, reason,
         transition_version, occurred_at
       ) VALUES (?, ?, 'active', 'revoked', ?, ?, ?)`,
    ).run(stableId("tool-fence-grant", grantId, reason), grantId, reason, version, occurredAt);
    writeRepair(database, "tool-grant", grantId, row.roomId as string, version,
      { grantId, toolCallId: row.toolCallId, state: "revoked", reason, version }, occurredAt);
    revokedGrantIds.push(grantId);
  }
  const dispatches = database.prepare(
    `SELECT dispatch.dispatch_id AS dispatchId, dispatch.tool_call_id AS toolCallId,
            dispatch.state, dispatch.version, call.room_id AS roomId,
            call.execution_id AS executionId, call.attempt_seq AS attemptSeq
     FROM tool_dispatches_v2 AS dispatch
     JOIN tool_calls_v2 AS call ON call.tool_call_id = dispatch.tool_call_id
     WHERE call.execution_id = ? AND dispatch.state IN ('claimed','dispatched')
     ORDER BY dispatch.dispatch_id`,
  ).all(executionId);
  for (const row of dispatches) {
    const dispatchId = row.dispatchId as string;
    const version = (row.version as number) + 1;
    const changed = database.prepare(
      `UPDATE tool_dispatches_v2
       SET state = 'outcome_unknown', reason = ?, settled_at = ?,
           version = ?, changed_at = ?
       WHERE dispatch_id = ? AND state IN ('claimed','dispatched') AND version = ?`,
    ).run(reason, occurredAt, version, occurredAt, dispatchId, row.version as number);
    if (changed.changes !== 1) return fail("execution_conflict", "Tool fence lost dispatch CAS");
    database.prepare(
      `INSERT INTO tool_dispatch_transitions_v2 (
         transition_id, dispatch_id, from_state, to_state, reason,
         transition_version, occurred_at
       ) VALUES (?, ?, ?, 'outcome_unknown', ?, ?, ?)`,
    ).run(stableId("tool-fence-dispatch", dispatchId, reason), dispatchId,
      row.state as string, reason, version, occurredAt);
    writeRepair(database, "tool-dispatch", dispatchId, row.roomId as string, version,
      { dispatchId, toolCallId: row.toolCallId, state: "outcome_unknown",
        reason, version }, occurredAt);
    freezeParentForUnknownOutcome(database, row.executionId as string,
      row.attemptSeq as number, occurredAt);
    preservedDispatchIds.push(dispatchId);
  }
  return Object.freeze({ rejectedConfirmationIds: Object.freeze(rejectedConfirmationIds),
    revokedGrantIds: Object.freeze(revokedGrantIds),
    preservedDispatchIds: Object.freeze(preservedDispatchIds) });
}

export function settleToolSafetyPrincipalFenceInTransaction(
  database: DatabaseSync,
  actorId: string,
  sessionFamilyId: string | undefined,
  occurredAt: string,
  roomId?: string,
): ToolSafetyFenceSettlement {
  const rows = database.prepare(
    `SELECT DISTINCT call.execution_id AS executionId
     FROM tool_confirmations_v2 AS confirmation
     JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
     LEFT JOIN tool_grants_v2 AS grant ON grant.confirmation_id = confirmation.confirmation_id
     LEFT JOIN tool_dispatches_v2 AS dispatch ON dispatch.tool_call_id = call.tool_call_id
     WHERE confirmation.principal_human_actor_id = ?
       AND (? IS NULL OR confirmation.session_family_id = ?)
       AND (? IS NULL OR call.room_id = ?)
       AND (confirmation.state = 'pending' OR grant.state = 'active'
            OR dispatch.state IN ('claimed','dispatched'))
     ORDER BY call.execution_id`,
  ).all(actorId, sessionFamilyId ?? null, sessionFamilyId ?? null,
    roomId ?? null, roomId ?? null);
  const aggregate = { rejectedConfirmationIds: [] as string[], revokedGrantIds: [] as string[],
    preservedDispatchIds: [] as string[] };
  for (const row of rows) {
    if (typeof row.executionId !== "string") {
      return fail("storage_unavailable", "Tool principal fence execution was corrupt");
    }
    const settled = settleToolSafetyExecutionFenceInTransaction(
      database, row.executionId, "principal_revoked", occurredAt,
    );
    aggregate.rejectedConfirmationIds.push(...settled.rejectedConfirmationIds);
    aggregate.revokedGrantIds.push(...settled.revokedGrantIds);
    aggregate.preservedDispatchIds.push(...settled.preservedDispatchIds);
  }
  return Object.freeze({ rejectedConfirmationIds: Object.freeze(aggregate.rejectedConfirmationIds),
    revokedGrantIds: Object.freeze(aggregate.revokedGrantIds),
    preservedDispatchIds: Object.freeze(aggregate.preservedDispatchIds) });
}

export function executeToolSafetyAuthorityOperationInTransaction(
  database: DatabaseSync,
  operation: ToolSafetyAuthorityOperation,
): ToolSafetyAuthorityResult {
  switch (operation.type) {
    case "tool-safety.read-prepare-binding": return readPrepareBinding(database, operation);
    case "tool-safety.prepare": return prepare(database, operation);
    case "tool-safety.confirmation-decide":
      return withCommandReceipt(database, operation, "confirmation_decide",
        () => decide(database, operation));
    case "tool-safety.claim": return claim(database, operation);
    case "tool-safety.handoff-offer":
      return withCommandReceipt(database, operation, "handoff_offer",
        () => offerHandoff(database, operation));
    case "tool-safety.handoff-read": return readHandoffBinding(database, operation);
    case "tool-safety.handoff-accept":
      return withCommandReceipt(database, operation, "handoff_accept",
        () => acceptHandoff(database, operation));
    case "tool-safety.settle": return settle(database, operation);
    case "tool-safety.outcome-review":
      return withCommandReceipt(database, operation, "outcome_review",
        () => review(database, operation));
    case "tool-safety.compensation-propose":
      return withCommandReceipt(database, operation, "compensation_propose",
        () => proposeCompensation(database, operation));
    case "tool-safety.expire": return expire(database, operation);
    case "tool-safety.recover-execution": return recoverExecution(database, operation);
  }
}
