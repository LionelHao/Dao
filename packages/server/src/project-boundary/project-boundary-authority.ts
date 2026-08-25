import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ProjectBoundaryInvocationRequest,
  ProjectBoundaryInvocationResult,
} from "@native-im/core";
import type { JsonValue } from "../persistence/contracts.js";

type Row = Record<string, unknown>;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Project boundary ${field} is corrupt`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Project boundary ${field} is corrupt`);
  }
  return value;
}

export type ClaimedProjectBoundaryExecution = Readonly<{
  intentId: string;
  executionId: string;
  roomId: string;
  projectId: string;
  agentId: string;
  boundaryId: string;
  boundaryKind: ProjectBoundaryInvocationRequest["boundaryKind"];
  sourceKind: string;
  sourceId: string;
  sourceRevision: number;
  lifecycleGeneration: number;
  profileId: string;
  profileRevision: number;
  assignmentId: string;
  assignmentRevision: number;
  accessRevision: number;
  checkpointId: string;
  checkpointRevision: number;
  checkpointSha256: string;
  checkpointProjectionJson: string;
  providerId: string;
  modelId: string;
  status: "accepted" | "running" | "completed" | "failed" | "cancelled";
  version: number;
}>;

function digest(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function projectBoundaryIntentId(input: Readonly<{
  roomId: string;
  boundaryId: string;
  sourceRevision: number;
  lifecycleGeneration: number;
  agentId: string;
}>): string {
  return `project-boundary-intent:${digest(input.roomId, input.boundaryId,
    String(input.sourceRevision), String(input.lifecycleGeneration), input.agentId)}`;
}

function sourceIsCurrent(database: DatabaseSync, row: Row, attemptedAt: string): boolean {
  const roomId = requiredText(row.roomId, "roomId");
  const sourceId = requiredText(row.sourceId, "sourceId");
  const sourceRevision = requiredInteger(row.sourceRevision, "sourceRevision", 1);
  const agentId = requiredText(row.agentId, "agentId");
  if (row.sourceKind === "next_action") {
    const fact = database.prepare(
      `SELECT revision, status, owner_kind AS ownerKind, owner_actor_id AS ownerActorId
       FROM project_next_actions WHERE room_id = ? AND id = ?`,
    ).get(roomId, sourceId);
    return fact !== undefined && fact.revision === sourceRevision && fact.ownerKind === "agent" &&
      fact.ownerActorId === agentId &&
      (fact.status === "accepted" || fact.status === "in_progress");
  }
  if (row.sourceKind === "blocker" || row.sourceKind === "open_question" ||
      row.sourceKind === "review") {
    const fact = database.prepare(
      `SELECT revision, kind, status, owner_kind AS ownerKind, owner_actor_id AS ownerActorId,
              review_at AS reviewAt
       FROM project_obstacles WHERE room_id = ? AND id = ?`,
    ).get(roomId, sourceId);
    if (fact === undefined || fact.revision !== sourceRevision || fact.ownerKind !== "agent" ||
        fact.ownerActorId !== agentId) return false;
    if (row.sourceKind === "review") {
      return fact.status === "deferred" && typeof fact.reviewAt === "string" &&
        fact.reviewAt <= attemptedAt;
    }
    return fact.kind === row.sourceKind &&
      (fact.status === "open" || fact.status === "cannot_answer");
  }
  if (row.sourceKind === "confirmation") {
    if (sourceId.startsWith("project-checkpoint:")) {
      const checkpoint = database.prepare(
        `SELECT project_revision AS projectRevision, projection_json AS projectionJson,
                projection_sha256 AS projectionSha256
         FROM project_fact_checkpoints WHERE room_id = ? AND checkpoint_id = ?`,
      ).get(roomId, sourceId);
      return checkpoint !== undefined && checkpoint.projectRevision === sourceRevision &&
        typeof checkpoint.projectionJson === "string" &&
        typeof checkpoint.projectionSha256 === "string" &&
        createHash("sha256").update(checkpoint.projectionJson).digest("hex") ===
          checkpoint.projectionSha256;
    }
    const proposalId = sourceId.startsWith("confirmation:")
      ? sourceId.slice("confirmation:".length) : sourceId;
    const proposal = database.prepare(
      `SELECT revision, status FROM project_fact_proposals WHERE room_id = ? AND id = ?`,
    ).get(roomId, proposalId);
    return proposal !== undefined && proposal.revision === sourceRevision &&
      proposal.status === "pending";
  }
  if (row.sourceKind === "due") {
    const parent = database.prepare(
      `SELECT boundary.room_id AS roomId, boundary.source_kind AS sourceKind,
              boundary.source_id AS sourceId, boundary.source_revision AS sourceRevision,
              boundary.holder_actor_id AS agentId, boundary.status AS boundaryStatus,
              boundary.due_at AS dueAt
       FROM project_ball_boundaries AS boundary
       WHERE boundary.boundary_id = ? AND boundary.room_id = ?`,
    ).get(sourceId, roomId) as Row | undefined;
    return parent !== undefined && parent.boundaryStatus === "active" &&
      parent.sourceKind !== "due" && parent.sourceRevision === sourceRevision &&
      parent.agentId === agentId && sourceIsCurrent(database, parent, attemptedAt);
  }
  return false;
}

function boundaryKindMatches(row: Row, request: ProjectBoundaryInvocationRequest): boolean {
  const expected = row.sourceKind === "confirmation" ? "checkpoint" :
    row.sourceKind === "blocker" || row.sourceKind === "open_question" ||
      row.sourceKind === "review" ? "blocker" :
      row.sourceKind === "due" ? "due" : "agent_ball";
  return request.boundaryKind === expected;
}

function appendInvocationEvent(database: DatabaseSync, identity: Readonly<{
  boundaryId: string; roomId: string; agentId: string;
}>, result: ProjectBoundaryInvocationResult, occurredAt: string): void {
  const stream = database.prepare(
    `SELECT head_seq AS headSeq FROM streams
     WHERE stream_kind = 'room' AND stream_id = ?`,
  ).get(identity.roomId);
  if (typeof stream?.headSeq !== "number") throw new Error("Project boundary stream is unavailable");
  const streamSeq = stream.headSeq + 1;
  const advanced = database.prepare(
    `UPDATE streams SET head_seq = ?
     WHERE stream_kind = 'room' AND stream_id = ? AND head_seq = ?`,
  ).run(streamSeq, identity.roomId, stream.headSeq);
  if (advanced.changes !== 1) throw new Error("Project boundary stream compare-and-set failed");
  const eventId = `project-boundary-event:${digest(identity.boundaryId, JSON.stringify(result))}`;
  database.prepare(
    `INSERT INTO events (
       event_id, stream_kind, stream_id, stream_seq, room_id, actor_id,
       event_type, occurred_at, payload_json
     ) VALUES (?, 'room', ?, ?, ?, ?, 'project.boundary.invocation.decided', ?, ?)`,
  ).run(eventId, identity.roomId, streamSeq, identity.roomId, identity.agentId,
    occurredAt, JSON.stringify(result as unknown as JsonValue));
  database.prepare(
    `INSERT INTO outbox_deliveries (
       id, event_id, target_kind, target_id, stream_seq, status,
       attempts, available_at, delivered_at, last_error
     ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
  ).run(`outbox:${eventId}`, eventId, identity.roomId, streamSeq, occurredAt);
}

function appendDecisionEvent(database: DatabaseSync, request: ProjectBoundaryInvocationRequest,
  result: ProjectBoundaryInvocationResult, occurredAt: string): void {
  appendInvocationEvent(database, request, result, occurredAt);
}

function appendExecutionStateEvent(database: DatabaseSync,
  execution: ClaimedProjectBoundaryExecution, occurredAt: string): void {
  appendInvocationEvent(database, execution, Object.freeze({
    boundaryId: execution.boundaryId, roomId: execution.roomId,
    status: "execution-state" as const, intentId: execution.intentId,
    executionId: execution.executionId, agentId: execution.agentId,
    executionStatus: execution.status, occurredAt,
  }), occurredAt);
}

function priorDecision(database: DatabaseSync, request: ProjectBoundaryInvocationRequest,
  requestSha256: string): ProjectBoundaryInvocationResult | undefined {
  const intent = database.prepare(
    `SELECT intent_id AS intentId, room_id AS roomId, request_sha256 AS requestSha256,
            claimed_at AS claimedAt, created_at AS createdAt
     FROM project_boundary_agent_invocation_intents
     WHERE boundary_id = ? AND source_revision = ?`,
  ).get(request.boundaryId, request.sourceFactRevision);
  if (intent !== undefined) {
    if (intent.roomId !== request.roomId || intent.requestSha256 !== requestSha256 ||
        typeof intent.intentId !== "string") {
      throw new Error("Project boundary idempotency conflict");
    }
    const consumedAt = typeof intent.claimedAt === "string" ? intent.claimedAt : intent.createdAt;
    if (typeof consumedAt !== "string") throw new Error("Project boundary intent is corrupt");
    return Object.freeze({ boundaryId: request.boundaryId, roomId: request.roomId,
      status: "intent-created", intentId: intent.intentId, consumedAt });
  }
  const legacy = database.prepare(
    `SELECT room_id AS roomId, status, request_sha256 AS requestSha256,
            recorded_at AS recordedAt
     FROM project_boundary_invocation_receipts WHERE boundary_id = ?`,
  ).get(request.boundaryId);
  if (legacy === undefined) return undefined;
  if (legacy.roomId !== request.roomId || legacy.requestSha256 !== requestSha256 ||
      typeof legacy.recordedAt !== "string") throw new Error("Project boundary idempotency conflict");
  return Object.freeze({ boundaryId: request.boundaryId, roomId: request.roomId,
    status: "suppressed", reason: legacy.status === "dependency_unavailable"
      ? "dependency_unavailable" : "boundary_ineligible", decidedAt: legacy.recordedAt });
}

/** Runs inside an existing AuthorityWorker transaction. */
export function claimProjectBoundaryInvocationInTransaction(database: DatabaseSync, input: Readonly<{
  request: ProjectBoundaryInvocationRequest;
  requestSha256: string;
  attemptedAt: string;
  providerId: string;
  modelId: string;
  intentId?: string;
}>): ProjectBoundaryInvocationResult {
  const prior = priorDecision(database, input.request, input.requestSha256);
  if (prior !== undefined) return prior;
  const row = database.prepare(
    `SELECT boundary.room_id AS roomId, boundary.project_id AS projectId,
            boundary.source_kind AS sourceKind, boundary.source_id AS sourceId,
            boundary.source_revision AS sourceRevision,
            boundary.lifecycle_generation AS lifecycleGeneration,
            boundary.holder_kind AS holderKind, boundary.holder_actor_id AS agentId,
            boundary.due_at AS dueAt, boundary.status AS boundaryStatus,
            room.status AS roomStatus, room.archive_generation AS archiveGeneration,
            membership.kind AS membershipKind, membership.participation AS membershipParticipation,
            membership.access_revision AS accessRevision,
            profile.id AS profileId, profile.revision AS profileRevision,
            profile.status AS profileStatus,
            profile.capability_ceiling_json AS capabilityCeilingJson,
            assignment.id AS assignmentId, assignment.revision AS assignmentRevision,
            assignment.status AS assignmentStatus,
            assignment.participation AS assignmentParticipation,
            assignment.paused AS assignmentPaused,
            assignment.capability_subset_json AS capabilitiesJson,
            checkpoint.checkpoint_id AS checkpointId,
            checkpoint.project_revision AS checkpointRevision,
            checkpoint.projection_sha256 AS checkpointSha256,
            checkpoint.projection_json AS checkpointProjectionJson
     FROM project_ball_boundaries AS boundary
     JOIN rooms AS room ON room.id = boundary.room_id
     LEFT JOIN room_memberships AS membership
       ON membership.room_id = boundary.room_id
      AND membership.actor_id = boundary.holder_actor_id
     LEFT JOIN agent_profiles AS profile ON profile.actor_id = boundary.holder_actor_id
     LEFT JOIN room_agent_assignments AS assignment
       ON assignment.room_id = boundary.room_id
      AND assignment.agent_actor_id = boundary.holder_actor_id
      AND assignment.status = 'current'
     LEFT JOIN project_fact_checkpoints AS checkpoint
       ON checkpoint.room_id = boundary.room_id
      AND checkpoint.project_revision = (
        SELECT MAX(candidate.project_revision) FROM project_fact_checkpoints AS candidate
        WHERE candidate.room_id = boundary.room_id
      )
     WHERE boundary.boundary_id = ?`,
  ).get(input.request.boundaryId) as Row | undefined;
  let capabilities: unknown = null;
  let capabilityCeiling: unknown = null;
  try { capabilities = typeof row?.capabilitiesJson === "string"
    ? JSON.parse(row.capabilitiesJson) : null; } catch { capabilities = null; }
  try { capabilityCeiling = typeof row?.capabilityCeilingJson === "string"
    ? JSON.parse(row.capabilityCeilingJson) : null; } catch { capabilityCeiling = null; }
  const structurallyCurrent = row !== undefined && row.roomId === input.request.roomId &&
    row.projectId === input.request.projectId && row.sourceId === input.request.sourceFactId &&
    row.sourceRevision === input.request.sourceFactRevision && row.agentId === input.request.agentId &&
    row.holderKind === "agent" && row.boundaryStatus === "active" && row.roomStatus === "active" &&
    row.archiveGeneration === row.lifecycleGeneration &&
    boundaryKindMatches(row, input.request) &&
    sourceIsCurrent(database, row, input.attemptedAt);
  const eligible = structurallyCurrent && row.membershipKind === "agent" &&
    row.membershipParticipation === "active" && row.profileStatus === "enabled" &&
    row.assignmentStatus === "current" && row.assignmentParticipation === "active" &&
    row.assignmentPaused === 0 && Array.isArray(capabilities) &&
    capabilities.includes("room.project.read") && capabilities.includes("room.respond") &&
    Array.isArray(capabilityCeiling) && capabilityCeiling.includes("room.project.read") &&
    capabilityCeiling.includes("room.respond") &&
    typeof row.checkpointId === "string" && typeof row.checkpointRevision === "number" &&
    typeof row.checkpointSha256 === "string" && typeof row.checkpointProjectionJson === "string";
  if (!eligible) {
    const result = Object.freeze({ boundaryId: input.request.boundaryId,
      roomId: input.request.roomId, status: "suppressed" as const,
      reason: "boundary_ineligible" as const, decidedAt: input.attemptedAt });
    // Membership/Profile/Assignment/Provider prerequisites are recoverable. Do not
    // consume the stable boundary merely because one scan observed a transient gate.
    if (structurallyCurrent) return result;
    database.prepare(
      `INSERT INTO project_boundary_invocation_receipts (
         boundary_id, room_id, source_revision, status, invocation_intent_id,
         request_sha256, recorded_at
       ) VALUES (?, ?, ?, 'suppressed', NULL, ?, ?)`,
    ).run(input.request.boundaryId, input.request.roomId, input.request.sourceFactRevision,
      input.requestSha256, input.attemptedAt);
    appendDecisionEvent(database, input.request, result, input.attemptedAt);
    return result;
  }
  const intentId = input.intentId ?? projectBoundaryIntentId({ roomId: input.request.roomId,
    boundaryId: input.request.boundaryId, sourceRevision: input.request.sourceFactRevision,
    lifecycleGeneration: requiredInteger(row.lifecycleGeneration, "lifecycleGeneration", 0),
    agentId: input.request.agentId });
  const lineageId = `project-boundary-lineage:${digest(input.request.roomId, input.request.boundaryId)}`;
  const executionId = `project-boundary-execution:${digest(intentId, "1")}`;
  const sourceKind = requiredText(row.sourceKind, "sourceKind");
  const sourceId = requiredText(row.sourceId, "sourceId");
  const sourceRevision = requiredInteger(row.sourceRevision, "sourceRevision", 1);
  const lifecycleGeneration = requiredInteger(row.lifecycleGeneration, "lifecycleGeneration", 0);
  const profileId = requiredText(row.profileId, "profileId");
  const profileRevision = requiredInteger(row.profileRevision, "profileRevision", 1);
  const assignmentId = requiredText(row.assignmentId, "assignmentId");
  const assignmentRevision = requiredInteger(row.assignmentRevision, "assignmentRevision", 1);
  const accessRevision = requiredInteger(row.accessRevision, "accessRevision", 0);
  const checkpointId = requiredText(row.checkpointId, "checkpointId");
  const checkpointRevision = requiredInteger(row.checkpointRevision, "checkpointRevision", 0);
  const checkpointSha256 = requiredText(row.checkpointSha256, "checkpointSha256");
  const consumedExistingClaim = database.prepare(
    `UPDATE project_agent_boundary_claims
     SET status = 'consumed', consumed_at = ?
     WHERE boundary_id = ? AND source_revision = ? AND room_id = ?
       AND holder_agent_actor_id = ? AND request_sha256 = ? AND status = 'claimed'`,
  ).run(input.attemptedAt, input.request.boundaryId, input.request.sourceFactRevision,
    input.request.roomId, input.request.agentId, input.requestSha256);
  if (consumedExistingClaim.changes === 0) database.prepare(
    `INSERT INTO project_agent_boundary_claims (
       boundary_id, source_revision, room_id, holder_agent_actor_id,
       request_sha256, status, attempted_at, consumed_at
     ) VALUES (?, ?, ?, ?, ?, 'consumed', ?, ?)`,
  ).run(input.request.boundaryId, input.request.sourceFactRevision, input.request.roomId,
    input.request.agentId, input.requestSha256, input.attemptedAt, input.attemptedAt);
  database.prepare(
    `INSERT INTO project_boundary_agent_invocation_intents (
       intent_id, room_id, project_id, boundary_id, boundary_kind, source_kind,
       source_id, source_revision, lifecycle_generation, target_agent_actor_id,
       profile_id, profile_revision, assignment_id, assignment_revision, access_revision,
       lineage_id, turn_id, request_sha256, status, authority_version,
       created_at, claimed_at, cancelled_at, cancellation_reason, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', 1,
               ?, ?, NULL, NULL, ?)`,
  ).run(intentId, input.request.roomId, input.request.projectId, input.request.boundaryId,
    input.request.boundaryKind, sourceKind, sourceId, sourceRevision,
    lifecycleGeneration, input.request.agentId, profileId, profileRevision,
    assignmentId, assignmentRevision, accessRevision, lineageId,
    `project-boundary-turn:${digest(input.request.boundaryId, String(sourceRevision))}`,
    input.requestSha256, input.attemptedAt, input.attemptedAt, input.attemptedAt);
  database.prepare(
    `INSERT INTO project_boundary_agent_executions (
       execution_id, intent_id, lineage_id, execution_ordinal, retry_of_execution_id,
       room_id, project_id, agent_actor_id, source_revision, lifecycle_generation,
       provider_id, model_id, public_status, phase, current_attempt_seq, authority_version,
       queued_at, started_at, updated_at, completed_at, cancellation_reason,
       terminal_error_code, result_message_id
     ) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, 'accepted', 'queued', 1, 1,
               ?, NULL, ?, NULL, NULL, NULL, NULL)`,
  ).run(executionId, intentId, lineageId, input.request.roomId, input.request.projectId,
    input.request.agentId, sourceRevision, lifecycleGeneration,
    input.providerId, input.modelId, input.attemptedAt, input.attemptedAt);
  database.prepare(
    `INSERT INTO project_boundary_agent_execution_links (
       intent_id, execution_id, execution_ordinal, retry_of_execution_id,
       source_revision, lifecycle_generation, linked_at
     ) VALUES (?, ?, 1, NULL, ?, ?, ?)`,
  ).run(intentId, executionId, sourceRevision, lifecycleGeneration, input.attemptedAt);
  database.prepare(
    `INSERT INTO project_boundary_context_sources (
       context_source_id, intent_id, execution_id, execution_ordinal, room_id, project_id,
       checkpoint_id, checkpoint_project_revision, checkpoint_projection_sha256,
       source_kind, source_id, source_revision, lifecycle_generation, created_at
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`project-boundary-context:${digest(executionId)}`, intentId, executionId,
    input.request.roomId, input.request.projectId, checkpointId, checkpointRevision,
    checkpointSha256, sourceKind, sourceId, sourceRevision,
    lifecycleGeneration, input.attemptedAt);
  const result = Object.freeze({ boundaryId: input.request.boundaryId,
    roomId: input.request.roomId, status: "intent-created" as const, intentId,
    consumedAt: input.attemptedAt });
  appendDecisionEvent(database, input.request, result, input.attemptedAt);
  const accepted = executionRow(database, executionId);
  if (accepted === undefined) throw new Error("Project boundary execution was not persisted");
  appendExecutionStateEvent(database, publicExecution(accepted), input.attemptedAt);
  return result;
}

export function listRunnableProjectBoundaryExecutions(database: DatabaseSync,
  limit: number): readonly ClaimedProjectBoundaryExecution[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new TypeError("Invalid limit");
  const rows = database.prepare(
    `SELECT intent.intent_id AS intentId, execution.execution_id AS executionId,
            intent.room_id AS roomId, intent.project_id AS projectId,
            intent.target_agent_actor_id AS agentId, intent.boundary_id AS boundaryId,
            intent.boundary_kind AS boundaryKind, intent.source_kind AS sourceKind,
            intent.source_id AS sourceId, intent.source_revision AS sourceRevision,
            intent.lifecycle_generation AS lifecycleGeneration, intent.profile_id AS profileId,
            intent.profile_revision AS profileRevision, intent.assignment_id AS assignmentId,
            intent.assignment_revision AS assignmentRevision,
            intent.access_revision AS accessRevision, source.checkpoint_id AS checkpointId,
            source.checkpoint_project_revision AS checkpointRevision,
            source.checkpoint_projection_sha256 AS checkpointSha256,
            checkpoint.projection_json AS checkpointProjectionJson,
            execution.provider_id AS providerId, execution.model_id AS modelId,
            execution.public_status AS status, execution.authority_version AS version
     FROM project_boundary_agent_invocation_intents AS intent
     JOIN project_boundary_agent_executions AS execution ON execution.intent_id = intent.intent_id
     JOIN project_boundary_context_sources AS source ON source.execution_id = execution.execution_id
     JOIN project_fact_checkpoints AS checkpoint ON checkpoint.checkpoint_id = source.checkpoint_id
     WHERE intent.status = 'claimed' AND execution.public_status IN ('accepted', 'running')
     ORDER BY execution.queued_at, execution.execution_id LIMIT ?`,
  ).all(limit) as Row[];
  return Object.freeze(rows.map(publicExecution));
}

function executionRow(database: DatabaseSync, executionId: string): Row | undefined {
  return database.prepare(
    `SELECT intent.intent_id AS intentId, execution.execution_id AS executionId,
            intent.room_id AS roomId, intent.project_id AS projectId,
            intent.target_agent_actor_id AS agentId, intent.boundary_id AS boundaryId,
            intent.boundary_kind AS boundaryKind, intent.source_kind AS sourceKind,
            intent.source_id AS sourceId, intent.source_revision AS sourceRevision,
            intent.lifecycle_generation AS lifecycleGeneration, intent.profile_id AS profileId,
            intent.profile_revision AS profileRevision, intent.assignment_id AS assignmentId,
            intent.assignment_revision AS assignmentRevision,
            intent.access_revision AS accessRevision, source.checkpoint_id AS checkpointId,
            source.checkpoint_project_revision AS checkpointRevision,
            source.checkpoint_projection_sha256 AS checkpointSha256,
            checkpoint.projection_json AS checkpointProjectionJson,
            execution.provider_id AS providerId, execution.model_id AS modelId,
            execution.public_status AS status, execution.authority_version AS version,
            boundary.status AS boundaryStatus, room.status AS roomStatus,
            room.archive_generation AS archiveGeneration,
            membership.kind AS membershipKind,
            membership.participation AS membershipParticipation,
            membership.access_revision AS currentAccessRevision,
            profile.status AS profileStatus, profile.revision AS currentProfileRevision,
            assignment.status AS assignmentStatus,
            assignment.participation AS assignmentParticipation,
            assignment.paused AS assignmentPaused,
            assignment.revision AS currentAssignmentRevision,
            assignment.capability_subset_json AS capabilitiesJson,
            boundary.due_at AS dueAt
     FROM project_boundary_agent_invocation_intents AS intent
     JOIN project_boundary_agent_executions AS execution ON execution.intent_id = intent.intent_id
     JOIN project_boundary_context_sources AS source ON source.execution_id = execution.execution_id
     JOIN project_fact_checkpoints AS checkpoint ON checkpoint.checkpoint_id = source.checkpoint_id
     LEFT JOIN project_ball_boundaries AS boundary ON boundary.boundary_id = intent.boundary_id
     LEFT JOIN rooms AS room ON room.id = intent.room_id
     LEFT JOIN room_memberships AS membership
       ON membership.room_id = intent.room_id AND membership.actor_id = intent.target_agent_actor_id
     LEFT JOIN agent_profiles AS profile ON profile.id = intent.profile_id
     LEFT JOIN room_agent_assignments AS assignment ON assignment.id = intent.assignment_id
     WHERE execution.execution_id = ?`,
  ).get(executionId) as Row | undefined;
}

function executionIsCurrent(database: DatabaseSync, row: Row, now: string): boolean {
  let capabilities: unknown;
  try { capabilities = typeof row.capabilitiesJson === "string"
    ? JSON.parse(row.capabilitiesJson) : null; } catch { capabilities = null; }
  return row.boundaryStatus === "active" && row.roomStatus === "active" &&
    row.archiveGeneration === row.lifecycleGeneration && row.membershipKind === "agent" &&
    row.membershipParticipation === "active" && row.currentAccessRevision === row.accessRevision &&
    row.profileStatus === "enabled" && row.currentProfileRevision === row.profileRevision &&
    row.assignmentStatus === "current" && row.assignmentParticipation === "active" &&
    row.assignmentPaused === 0 && row.currentAssignmentRevision === row.assignmentRevision &&
    Array.isArray(capabilities) && capabilities.includes("room.project.read") &&
    capabilities.includes("room.respond") && sourceIsCurrent(database, row, now);
}

function publicExecution(row: Row): ClaimedProjectBoundaryExecution {
  const boundaryKind = row.boundaryKind;
  if (boundaryKind !== "checkpoint" && boundaryKind !== "due" &&
      boundaryKind !== "blocker" && boundaryKind !== "agent_ball") {
    throw new Error("Project boundary boundaryKind is corrupt");
  }
  const status = row.status;
  if (status !== "accepted" && status !== "running" && status !== "completed" &&
      status !== "failed" && status !== "cancelled") {
    throw new Error("Project boundary execution status is corrupt");
  }
  const checkpointProjectionJson = requiredText(
    row.checkpointProjectionJson, "checkpointProjectionJson",
  );
  const checkpointSha256 = requiredText(row.checkpointSha256, "checkpointSha256");
  if (createHash("sha256").update(checkpointProjectionJson).digest("hex") !== checkpointSha256) {
    throw new Error("Project boundary checkpoint digest is corrupt");
  }
  try {
    const parsed = JSON.parse(checkpointProjectionJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
  } catch {
    throw new Error("Project boundary checkpoint projection is corrupt");
  }
  return Object.freeze({
    intentId: requiredText(row.intentId, "intentId"),
    executionId: requiredText(row.executionId, "executionId"),
    roomId: requiredText(row.roomId, "roomId"),
    projectId: requiredText(row.projectId, "projectId"),
    agentId: requiredText(row.agentId, "agentId"),
    boundaryId: requiredText(row.boundaryId, "boundaryId"),
    boundaryKind,
    sourceKind: requiredText(row.sourceKind, "sourceKind"),
    sourceId: requiredText(row.sourceId, "sourceId"),
    sourceRevision: requiredInteger(row.sourceRevision, "sourceRevision", 1),
    lifecycleGeneration: requiredInteger(row.lifecycleGeneration, "lifecycleGeneration", 0),
    profileId: requiredText(row.profileId, "profileId"),
    profileRevision: requiredInteger(row.profileRevision, "profileRevision", 1),
    assignmentId: requiredText(row.assignmentId, "assignmentId"),
    assignmentRevision: requiredInteger(row.assignmentRevision, "assignmentRevision", 1),
    accessRevision: requiredInteger(row.accessRevision, "accessRevision", 0),
    checkpointId: requiredText(row.checkpointId, "checkpointId"),
    checkpointRevision: requiredInteger(row.checkpointRevision, "checkpointRevision", 0),
    checkpointSha256,
    checkpointProjectionJson,
    providerId: requiredText(row.providerId, "providerId"),
    modelId: requiredText(row.modelId, "modelId"),
    status,
    version: requiredInteger(row.version, "version", 1),
  });
}

export function beginProjectBoundaryExecutionInTransaction(database: DatabaseSync, input: Readonly<{
  executionId: string;
  expectedVersion: number;
  now: string;
}>): ClaimedProjectBoundaryExecution | null {
  const row = executionRow(database, input.executionId);
  if (row === undefined || row.version !== input.expectedVersion || row.status !== "accepted") return null;
  if (!executionIsCurrent(database, row, input.now)) {
    const changed = database.prepare(
      `UPDATE project_boundary_agent_executions
       SET public_status = 'cancelled', phase = 'cancelled', authority_version = authority_version + 1,
           completed_at = ?, cancellation_reason = 'source_ineligible', updated_at = ?
       WHERE execution_id = ? AND authority_version = ? AND public_status = 'accepted'`,
    ).run(input.now, input.now, input.executionId, input.expectedVersion);
    if (changed.changes === 1) {
      const cancelled = executionRow(database, input.executionId);
      if (cancelled !== undefined) appendExecutionStateEvent(database, publicExecution(cancelled), input.now);
    }
    return null;
  }
  const changed = database.prepare(
    `UPDATE project_boundary_agent_executions
     SET public_status = 'running', phase = 'model_generation',
         authority_version = authority_version + 1, started_at = ?, updated_at = ?
     WHERE execution_id = ? AND authority_version = ? AND public_status = 'accepted'`,
  ).run(input.now, input.now, input.executionId, input.expectedVersion);
  if (changed.changes !== 1) return null;
  const current = executionRow(database, input.executionId);
  if (current === undefined) return null;
  const result = publicExecution(current);
  appendExecutionStateEvent(database, result, input.now);
  return result;
}

export function finishProjectBoundaryExecutionInTransaction(database: DatabaseSync, input: Readonly<{
  executionId: string;
  expectedVersion: number;
  outcome: "completed" | "failed";
  errorCode?: string;
  now: string;
}>): ClaimedProjectBoundaryExecution | null {
  const row = executionRow(database, input.executionId);
  if (row === undefined || row.version !== input.expectedVersion || row.status !== "running") return null;
  if (!executionIsCurrent(database, row, input.now)) {
    const changed = database.prepare(
      `UPDATE project_boundary_agent_executions
       SET public_status = 'cancelled', phase = 'cancelled', authority_version = authority_version + 1,
           completed_at = ?, cancellation_reason = 'source_ineligible', updated_at = ?
       WHERE execution_id = ? AND authority_version = ? AND public_status = 'running'`,
    ).run(input.now, input.now, input.executionId, input.expectedVersion);
    if (changed.changes === 1) {
      const cancelled = executionRow(database, input.executionId);
      if (cancelled !== undefined) appendExecutionStateEvent(database, publicExecution(cancelled), input.now);
    }
    return null;
  }
  const errorCode = input.outcome === "failed" ? input.errorCode ?? "provider_failure" : null;
  const changed = database.prepare(
    `UPDATE project_boundary_agent_executions
     SET public_status = ?, phase = ?, authority_version = authority_version + 1,
         completed_at = ?, terminal_error_code = ?, updated_at = ?
     WHERE execution_id = ? AND authority_version = ? AND public_status = 'running'`,
  ).run(input.outcome, input.outcome, input.now, errorCode, input.now,
    input.executionId, input.expectedVersion);
  if (changed.changes !== 1) return null;
  const current = executionRow(database, input.executionId);
  if (current === undefined) return null;
  const result = publicExecution(current);
  appendExecutionStateEvent(database, result, input.now);
  return result;
}
