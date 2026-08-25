import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { JsonValue } from "../persistence/contracts.js";
import {
  isProjectLoopAuthorityOperation,
  type ProjectLoopActorCommandContext,
  type ProjectLoopAuthorityOperation,
  type ProjectLoopAuthorityResult,
  type ProjectLoopFactKind,
  type ProjectLoopSource,
  type ProjectLoopStoredEvent,
  type ProjectLoopStoredFact,
  type ProjectLoopStoredProposal,
} from "./authority-protocol.js";
import { hashProjectFrozenResponsibility } from "./request-factory.js";
import {
  readCanonicalProjectEventPayloadDatabaseQuery,
  readCanonicalProjectEventsDatabaseQuery,
  readCanonicalProjectSnapshotDatabaseQuery,
} from "./canonical-projection.js";

export type ProjectLoopAuthorityErrorCode =
  | "invalid_request" | "permission_denied" | "room_forbidden" | "room_not_found"
  | "room_archived" | "revision_conflict" | "idempotency_conflict"
  | "project_fact_not_found" | "invalid_transition" | "storage_unavailable";

export class ProjectLoopAuthorityError extends Error {
  constructor(readonly code: ProjectLoopAuthorityErrorCode, message: string) {
    super(message);
    Object.defineProperty(this, "name", { value: "ProjectLoopAuthorityError" });
  }
}

interface StateRow { readonly revision: unknown; readonly eventHeadSeq: unknown }
interface ProposalRow {
  readonly id: unknown; readonly roomId: unknown; readonly projectId: unknown;
  readonly revision: unknown; readonly factKind: unknown; readonly factId: unknown;
  readonly baseRevision: unknown; readonly status: unknown; readonly payloadJson: unknown;
  readonly sourceRoomId: unknown; readonly sourceId: unknown; readonly sourceKind: unknown;
  readonly proposedByKind: unknown; readonly proposedByActorId: unknown;
  readonly principalHumanActorId: unknown; readonly createdAt: unknown; readonly updatedAt: unknown;
  readonly sourceRevision: unknown; readonly visibilityRoomId: unknown;
  readonly expiresAt: unknown; readonly resolvedAt: unknown; readonly resolutionReason: unknown;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key] as JsonValue)}`).join(",")}}`;
}

function requestHash(operation: ProjectLoopAuthorityOperation): string {
  const authority = operation.type === "project-loop.snapshot.read"
    ? operation
    : { type: operation.type, command: operation.command };
  return createHash("sha256").update(canonical(authority as unknown as JsonValue)).digest("hex");
}

function actor(context: ProjectLoopActorCommandContext): { kind: "human" | "agent"; actorId: string } {
  return context.kind === "human"
    ? { kind: "human", actorId: context.principal.actorId }
    : { kind: "agent", actorId: context.agent.actorId };
}

function commandIdentity(context: ProjectLoopActorCommandContext): {
  actorId: string; idempotencyKey: string;
} {
  const principal = actor(context);
  return { actorId: principal.actorId, idempotencyKey: context.idempotencyKey };
}

function iso(now: number): string {
  const value = new Date(now).toISOString();
  if (!Number.isFinite(Date.parse(value))) throw new ProjectLoopAuthorityError("invalid_request", "Invalid time");
  return value;
}

function parseObject(value: unknown): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "string") throw new ProjectLoopAuthorityError("storage_unavailable", "Project row is corrupt");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project row is corrupt");
  }
}

function stringField(payload: Readonly<Record<string, JsonValue>>, key: string, fallback = ""): string {
  const value = payload[key];
  if (value === undefined && fallback !== "") return fallback;
  if (typeof value !== "string") throw new ProjectLoopAuthorityError("invalid_request", `Project payload ${key} is invalid`);
  return value;
}

function optionalString(payload: Readonly<Record<string, JsonValue>>, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectLoopAuthorityError("invalid_request", `Project payload ${key} is invalid`);
  }
  return value;
}

function jsonArrayField(payload: Readonly<Record<string, JsonValue>>, key: string): readonly JsonValue[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new ProjectLoopAuthorityError("invalid_request", `Project payload ${key} is invalid`);
  }
  return value;
}

function requireRoomAccess(database: DatabaseSync, roomId: string, actorId: string, mutate: boolean): void {
  const room = database.prepare("SELECT status FROM rooms WHERE id = ?").get(roomId);
  if (room === undefined) throw new ProjectLoopAuthorityError("room_not_found", "Project Room was not found");
  const membership = database.prepare(
    `SELECT membership.kind, membership.participation
     FROM room_memberships AS membership
     JOIN actors AS actor ON actor.id = membership.actor_id
     WHERE membership.room_id = ? AND membership.actor_id = ?
       AND actor.kind = membership.kind`,
  ).get(roomId, actorId);
  if (membership === undefined) throw new ProjectLoopAuthorityError("room_forbidden", "Project Room access is forbidden");
  if (mutate && room.status === "archived") throw new ProjectLoopAuthorityError("room_archived", "Project Room is archived");
  if (mutate && membership.kind === "agent") {
    const assignment = database.prepare(
      `SELECT 1
       FROM room_agent_assignments AS assignment
       JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
         AND profile.actor_id = assignment.agent_actor_id
       JOIN room_agent_assignment_revisions AS assignment_revision
         ON assignment_revision.assignment_id = assignment.id
        AND assignment_revision.revision = assignment.revision
       JOIN agent_profile_revisions AS profile_revision
         ON profile_revision.profile_id = profile.id
        AND profile_revision.revision = profile.revision
       WHERE assignment.room_id = ? AND assignment.agent_actor_id = ?
         AND assignment.status = 'current' AND assignment.participation = 'active'
         AND assignment.paused = 0 AND profile.status = 'enabled'
         AND assignment_revision.status = assignment.status
         AND assignment_revision.participation = assignment.participation
         AND assignment_revision.paused = assignment.paused
         AND profile_revision.status = profile.status
         AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
                     WHERE value = 'room.project.read')
         AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
                     WHERE value = 'room.respond')
         AND EXISTS (SELECT 1 FROM json_each(profile.capability_ceiling_json)
                     WHERE value = 'room.project.read')
         AND EXISTS (SELECT 1 FROM json_each(profile.capability_ceiling_json)
                     WHERE value = 'room.respond')`,
    ).get(roomId, actorId);
    if (membership.participation !== "active" || assignment === undefined) {
      throw new ProjectLoopAuthorityError("permission_denied", "Agent Project assignment is unavailable");
    }
  }
}

function requireAssignableActor(database: DatabaseSync, roomId: string, actorId: string,
  expectedKind: "human" | "agent"): void {
  const member = database.prepare(
    `SELECT membership.kind, membership.participation
     FROM room_memberships AS membership
     JOIN actors AS actor ON actor.id = membership.actor_id AND actor.kind = membership.kind
     WHERE membership.room_id = ? AND membership.actor_id = ?`,
  ).get(roomId, actorId);
  if (member?.kind !== expectedKind) {
    throw new ProjectLoopAuthorityError("invalid_request", "Project target actor binding is invalid");
  }
  if (expectedKind === "agent") {
    const assignment = database.prepare(
      `SELECT 1 FROM room_agent_assignments AS assignment
       JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
         AND profile.actor_id = assignment.agent_actor_id
       JOIN room_agent_assignment_revisions AS assignment_revision
         ON assignment_revision.assignment_id = assignment.id
        AND assignment_revision.revision = assignment.revision
       JOIN agent_profile_revisions AS profile_revision
         ON profile_revision.profile_id = profile.id
        AND profile_revision.revision = profile.revision
       WHERE assignment.room_id = ? AND assignment.agent_actor_id = ?
         AND assignment.status = 'current' AND assignment.paused = 0
         AND assignment.participation = 'active' AND profile.status = 'enabled'
         AND assignment_revision.status = assignment.status
         AND assignment_revision.participation = assignment.participation
         AND assignment_revision.paused = assignment.paused
         AND profile_revision.status = profile.status
         AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
                     WHERE value = 'room.project.read')
         AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
                     WHERE value = 'room.respond')
         AND EXISTS (SELECT 1 FROM json_each(profile.capability_ceiling_json)
                     WHERE value = 'room.project.read')
         AND EXISTS (SELECT 1 FROM json_each(profile.capability_ceiling_json)
                     WHERE value = 'room.respond')`,
    ).get(roomId, actorId);
    if (member.participation !== "active" || assignment === undefined) {
      throw new ProjectLoopAuthorityError("permission_denied", "Project Agent target is unavailable");
    }
  }
}

function hasRoomOwnerOrAdminAuthority(database: DatabaseSync, roomId: string,
  humanActorId: string): boolean {
  const authority = database.prepare(
    `SELECT CASE WHEN room.owner_actor_id = ? OR membership.role = 'admin'
                 THEN 1 ELSE 0 END AS authorized
     FROM rooms AS room
     LEFT JOIN room_memberships AS membership
       ON membership.room_id = room.id AND membership.actor_id = ?
      AND membership.kind = 'human'
     WHERE room.id = ?`,
  ).get(humanActorId, humanActorId, roomId);
  return authority?.authorized === 1;
}

function requireSupersedeAuthority(database: DatabaseSync, roomId: string,
  humanActorId: string): void {
  if (!hasRoomOwnerOrAdminAuthority(database, roomId, humanActorId)) {
    throw new ProjectLoopAuthorityError("permission_denied",
      "Only the Room owner or Room admin may supersede a Goal or Decision");
  }
}

function roomOwnerHumanActorId(database: DatabaseSync, roomId: string): string {
  const owner = database.prepare(
    `SELECT room.owner_actor_id AS actorId
     FROM rooms AS room
     JOIN room_memberships AS membership
       ON membership.room_id = room.id AND membership.actor_id = room.owner_actor_id
      AND membership.kind = 'human' AND membership.role = 'owner'
     JOIN actors AS actor ON actor.id = room.owner_actor_id AND actor.kind = 'human'
     WHERE room.id = ?`,
  ).get(roomId);
  if (typeof owner?.actorId !== "string") {
    throw new ProjectLoopAuthorityError("storage_unavailable",
      "Project Room owner authority is unavailable");
  }
  return owner.actorId;
}

function validateProjectSource(database: DatabaseSync, source: ProjectLoopSource): void {
  let row: Record<string, unknown> | undefined;
  if (source.kind === "message") {
    row = database.prepare(
      `SELECT message.room_id AS roomId, envelope.current_revision AS revision,
              envelope.lifecycle AS lifecycle
       FROM messages AS message
       JOIN message_envelopes AS envelope ON envelope.message_id = message.id
       WHERE message.id = ?`,
    ).get(source.sourceId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new ProjectLoopAuthorityError("project_fact_not_found", "Project source was not found");
    if (row.roomId !== source.roomId) throw new ProjectLoopAuthorityError("invalid_request", "Project source is cross-Room");
    if (row.revision !== source.sourceRevision) throw new ProjectLoopAuthorityError("revision_conflict", "Project source revision is stale");
    if (row.lifecycle !== "active") throw new ProjectLoopAuthorityError("invalid_transition", "Project source is no longer active");
    return;
  }
  if (source.kind === "attachment") {
    row = database.prepare(
      `SELECT room_id AS roomId, access_revision AS revision,
              processing_status AS processingStatus, source_operational_state AS sourceState
       FROM attachments WHERE attachment_id = ?`,
    ).get(source.sourceId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new ProjectLoopAuthorityError("project_fact_not_found", "Project source was not found");
    if (row.roomId !== source.roomId) throw new ProjectLoopAuthorityError("invalid_request", "Project source is cross-Room");
    if (row.revision !== source.sourceRevision) throw new ProjectLoopAuthorityError("revision_conflict", "Project source revision is stale");
    if (row.processingStatus !== "ready" || row.sourceState === "excluded-recalled") {
      throw new ProjectLoopAuthorityError("invalid_transition", "Project attachment source is unavailable");
    }
    return;
  }
  if (source.kind === "agent_execution") {
    row = database.prepare(
      `SELECT execution.room_id AS roomId, runtime.authority_version AS revision,
              runtime.public_status AS status
       FROM agent_executions AS execution
       JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = execution.id
       WHERE execution.id = ?`,
    ).get(source.sourceId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new ProjectLoopAuthorityError("project_fact_not_found", "Project source was not found");
    if (row.roomId !== source.roomId) throw new ProjectLoopAuthorityError("invalid_request", "Project source is cross-Room");
    if (row.revision !== source.sourceRevision) throw new ProjectLoopAuthorityError("revision_conflict", "Project source revision is stale");
    return;
  }
  if (source.kind === "memory") {
    row = database.prepare(
      `SELECT room_id AS roomId, current_version_number AS revision
       FROM room_memory_records WHERE memory_record_id = ?`,
    ).get(source.sourceId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new ProjectLoopAuthorityError("project_fact_not_found", "Project source was not found");
    if (row.roomId !== source.roomId) throw new ProjectLoopAuthorityError("invalid_request", "Project source is cross-Room");
    if (row.revision !== source.sourceRevision || source.sourceRevision < 1) {
      throw new ProjectLoopAuthorityError("revision_conflict", "Project source revision is stale");
    }
    return;
  }
  if (source.kind === "project_fact") {
    row = database.prepare(
      `SELECT room_id AS roomId, revision FROM (
         SELECT id, room_id, revision FROM project_goals
         UNION ALL SELECT id, room_id, revision FROM project_decisions
         UNION ALL SELECT id, room_id, revision FROM project_requests WHERE source_kind <> 'legacy_v14'
         UNION ALL SELECT id, room_id, revision FROM project_next_actions WHERE source_kind <> 'legacy_v14'
         UNION ALL SELECT id, room_id, revision FROM project_obstacles WHERE source_kind <> 'legacy_v14'
       ) WHERE id = ?`,
    ).get(source.sourceId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new ProjectLoopAuthorityError("project_fact_not_found", "Project source was not found");
    if (row.roomId !== source.roomId) throw new ProjectLoopAuthorityError("invalid_request", "Project source is cross-Room");
    if (row.revision !== source.sourceRevision) throw new ProjectLoopAuthorityError("revision_conflict", "Project source revision is stale");
    return;
  }
  throw new ProjectLoopAuthorityError("permission_denied", "Legacy Project sources are not accepted by live authority");
}

function state(database: DatabaseSync, roomId: string, now: string): { revision: number; eventHeadSeq: number } {
  database.prepare(
    `INSERT INTO project_room_states (room_id, project_id, revision, event_head_seq, updated_at)
     VALUES (?, ?, 0, 0, ?) ON CONFLICT(room_id) DO NOTHING`,
  ).run(roomId, roomId, now);
  const row = database.prepare(
    `SELECT revision, event_head_seq AS eventHeadSeq FROM project_room_states WHERE room_id = ?`,
  ).get(roomId) as StateRow | undefined;
  if (typeof row?.revision !== "number" || typeof row.eventHeadSeq !== "number" ||
      row.revision !== row.eventHeadSeq) {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project revision state is corrupt");
  }
  return { revision: row.revision, eventHeadSeq: row.eventHeadSeq };
}

function eventId(roomId: string, eventSeq: number): string {
  const digest = createHash("sha256").update(`dao.project-event.v1\0${roomId}\0${eventSeq}`).digest("hex");
  return `project-event-${digest}`;
}

export function appendProjectLoopEventInTransaction(database: DatabaseSync, input: {
  roomId: string; eventSeq: number; eventType: ProjectLoopStoredEvent["eventType"];
  factKind: ProjectLoopFactKind; factId: string; factRevision: number;
  actorKind: "human" | "agent"; actorId: string; source: ProjectLoopSource;
  occurredAt: string; payload: Readonly<Record<string, JsonValue>>;
  transitionAuthority?: "system_timer";
  publicEntity?: "fact" | "proposal" | "transfer";
  publicEntityId?: string;
  publicEntityRevision?: number;
}): string {
  const id = eventId(input.roomId, input.eventSeq);
  const transitionPayload = input.transitionAuthority === "system_timer"
    ? Object.freeze({ ...input.payload,
      transitionAuthority: Object.freeze({ kind: "system_timer" as const }) })
    : input.payload;
  const authorityKind = input.transitionAuthority === "system_timer"
    ? "system_timer" as const : input.actorKind;
  const authorityActorKind = input.transitionAuthority === "system_timer" ? null : input.actorKind;
  const authorityActorId = input.transitionAuthority === "system_timer" ? null : input.actorId;
  const causalActorKind = input.transitionAuthority === "system_timer" ? null : input.actorKind;
  const causalActorId = input.transitionAuthority === "system_timer" ? null : input.actorId;
  database.prepare(
    `INSERT INTO project_events (
       event_id, room_id, project_id, event_seq, event_type, fact_kind, fact_id,
       fact_revision, authority_kind, actor_kind, actor_id, causal_actor_kind,
       causal_actor_id, source_room_id, source_id, source_kind,
       source_revision, source_visibility, occurred_at, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.roomId, input.roomId, input.eventSeq, input.eventType, input.factKind,
    input.factId, input.factRevision, authorityKind, authorityActorKind, authorityActorId,
    causalActorKind, causalActorId, input.source.roomId, input.source.sourceId,
    input.source.kind, input.source.sourceRevision,
    input.source.visibility, input.occurredAt, JSON.stringify(transitionPayload),
  );
  database.prepare(
    `INSERT INTO project_event_outbox (event_id, room_id, event_seq, available_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, input.roomId, input.eventSeq, input.occurredAt);
  database.prepare(
    `INSERT INTO project_transition_audit (
       audit_id, room_id, project_id, project_revision, event_id, operation,
       fact_kind, fact_id, authority_kind, actor_kind, actor_id, causal_actor_kind,
       causal_actor_id, transition_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`audit:${id}`, input.roomId, input.roomId, input.eventSeq, id, input.eventType,
    input.factKind, input.factId, authorityKind, authorityActorKind, authorityActorId,
    causalActorKind, causalActorId,
    JSON.stringify(transitionPayload), input.occurredAt);
  const stream = database.prepare(
    `SELECT head_seq AS headSeq FROM streams WHERE stream_kind = 'room' AND stream_id = ?`,
  ).get(input.roomId);
  if (typeof stream?.headSeq !== "number" || !Number.isSafeInteger(stream.headSeq)) {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project Room stream is unavailable");
  }
  const streamSeq = stream.headSeq + 1;
  const advanced = database.prepare(
    `UPDATE streams SET head_seq = ?
     WHERE stream_kind = 'room' AND stream_id = ? AND head_seq = ?`,
  ).run(streamSeq, input.roomId, stream.headSeq);
  if (advanced.changes !== 1) {
    throw new ProjectLoopAuthorityError("revision_conflict", "Project Room stream changed concurrently");
  }
  const entity = input.publicEntity ??
    (input.eventType.startsWith("proposal.") ? "proposal" as const : "fact" as const);
  const eventPayload = readCanonicalProjectEventPayloadDatabaseQuery(database, {
    roomId: input.roomId, factKind: input.factKind,
    factId: input.publicEntityId ?? input.factId, entity,
  });
  if (input.publicEntityRevision !== undefined &&
      (!Number.isSafeInteger(input.publicEntityRevision) || input.publicEntityRevision < 1 ||
       typeof eventPayload.revision !== "number" ||
       eventPayload.revision !== input.publicEntityRevision)) {
    throw new ProjectLoopAuthorityError("revision_conflict",
      "Canonical Project public event revision changed concurrently");
  }
  const publicType = entity === "proposal" ? "project.proposal.changed"
    : entity === "transfer" ? "project.transfer-proposal.changed"
    : input.factKind === "goal" ? "project.goal.changed"
      : input.factKind === "decision" ? "project.decision.changed"
        : input.factKind === "request" ? "project.request.changed"
          : input.factKind === "next_action" ? "project.next-action.changed"
            : input.factKind === "blocker" ? "project.blocker.changed"
              : "project.open-question.changed";
  database.prepare(
    `INSERT INTO events (
       event_id, stream_kind, stream_id, stream_seq, room_id,
       authority_kind, actor_id, event_type, occurred_at, payload_json
     ) VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.roomId, streamSeq, input.roomId, authorityKind, authorityActorId, publicType,
    input.occurredAt, canonical(eventPayload as unknown as JsonValue));
  database.prepare(
    `INSERT INTO outbox_deliveries (
       id, event_id, target_kind, target_id, stream_seq, status,
       attempts, available_at, delivered_at, last_error
     ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
  ).run(`outbox:${id}`, id, input.roomId, streamSeq, input.occurredAt);
  database.prepare(
    `UPDATE project_room_states
     SET revision = revision + 1, event_head_seq = event_head_seq + 1, updated_at = ?
     WHERE room_id = ?`,
  ).run(input.occurredAt, input.roomId);
  return id;
}

const appendEvent = appendProjectLoopEventInTransaction;

function proposalFromRow(row: ProposalRow): ProjectLoopStoredProposal {
  if (typeof row.id !== "string" || typeof row.roomId !== "string" ||
      row.projectId !== row.roomId || typeof row.revision !== "number" ||
      typeof row.factKind !== "string" || typeof row.factId !== "string" ||
      typeof row.baseRevision !== "number" || typeof row.status !== "string" ||
      typeof row.sourceRoomId !== "string" || row.sourceRoomId !== row.roomId ||
      typeof row.sourceId !== "string" || typeof row.sourceKind !== "string" ||
      row.sourceKind === "legacy_v14" || typeof row.sourceRevision !== "number" ||
      typeof row.proposedByKind !== "string" || typeof row.proposedByActorId !== "string" ||
      typeof row.principalHumanActorId !== "string" || typeof row.sourceRevision !== "number" ||
      row.visibilityRoomId !== row.roomId || typeof row.expiresAt !== "string" ||
      typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project proposal row is corrupt");
  }
  return Object.freeze({
    id: row.id, roomId: row.roomId, projectId: row.roomId, revision: row.revision,
    factKind: row.factKind as ProjectLoopFactKind, factId: row.factId,
    baseRevision: row.baseRevision,
    status: row.status as ProjectLoopStoredProposal["status"], payload: parseObject(row.payloadJson),
    source: { roomId: row.sourceRoomId, sourceId: row.sourceId,
      kind: row.sourceKind as ProjectLoopSource["kind"],
      sourceRevision: row.sourceRevision as number, visibility: "room" as const },
    proposedBy: { kind: row.proposedByKind as "human" | "agent", actorId: row.proposedByActorId },
    ...(typeof row.principalHumanActorId === "string"
      ? { principalHumanActorId: row.principalHumanActorId } : {}),
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  });
}

const PROPOSAL_SELECT = `SELECT id, room_id AS roomId, project_id AS projectId, revision,
  fact_kind AS factKind, fact_id AS factId, base_revision AS baseRevision, status,
  payload_json AS payloadJson, source_room_id AS sourceRoomId, source_id AS sourceId,
  source_kind AS sourceKind, proposed_by_kind AS proposedByKind,
  proposed_by_actor_id AS proposedByActorId, principal_human_actor_id AS principalHumanActorId,
  created_at AS createdAt, updated_at AS updatedAt, source_revision AS sourceRevision,
  visibility_room_id AS visibilityRoomId, expires_at AS expiresAt, resolved_at AS resolvedAt,
  resolution_reason AS resolutionReason FROM project_fact_proposals`;

function readProposal(database: DatabaseSync, proposalId: string): ProjectLoopStoredProposal | undefined {
  const row = database.prepare(`${PROPOSAL_SELECT} WHERE id = ?`).get(proposalId) as ProposalRow | undefined;
  return row === undefined ? undefined : proposalFromRow(row);
}

function createPendingConfirmationBoundary(database: DatabaseSync,
  proposal: Readonly<{ roomId: string; proposalId: string; revision: number;
    principalHumanActorId: string; expiresAt: string }>, now: string): void {
  const lifecycle = database.prepare(
    "SELECT archive_generation AS generation FROM rooms WHERE id = ?",
  ).get(proposal.roomId);
  if (typeof lifecycle?.generation !== "number") {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project lifecycle generation is unavailable");
  }
  const boundaryId = `project-ball-${createHash("sha256").update(
    `${proposal.roomId}\0confirmation\0${proposal.proposalId}\0${proposal.revision}` +
      `\0${lifecycle.generation}\0human\0${proposal.principalHumanActorId}`,
  ).digest("hex")}`;
  database.prepare(
    `INSERT INTO project_ball_boundaries (
       boundary_id, room_id, project_id, source_kind, source_id, source_revision,
       lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at, status
     ) VALUES (?, ?, ?, 'confirmation', ?, ?, ?, 'human', ?,
               'pending_confirmation', ?, ?, 'active')`,
  ).run(boundaryId, proposal.roomId, proposal.roomId, `confirmation:${proposal.proposalId}`,
    proposal.revision, lifecycle.generation, proposal.principalHumanActorId,
    now, proposal.expiresAt);
}

function createConfirmedCheckpointBoundary(database: DatabaseSync,
  input: Readonly<{ roomId: string; checkpointId: string; projectRevision: number;
    agentActorId: string; now: string }>): void {
  const lifecycle = database.prepare(
    "SELECT archive_generation AS generation FROM rooms WHERE id = ?",
  ).get(input.roomId);
  if (typeof lifecycle?.generation !== "number") {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project lifecycle generation is unavailable");
  }
  const boundaryId = `project-ball-${createHash("sha256").update(
    `${input.roomId}\0confirmation\0${input.checkpointId}\0${input.projectRevision}` +
      `\0${lifecycle.generation}\0agent\0${input.agentActorId}`,
  ).digest("hex")}`;
  database.prepare(
    `INSERT INTO project_ball_boundaries (
       boundary_id, room_id, project_id, source_kind, source_id, source_revision,
       lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at, status
     ) VALUES (?, ?, ?, 'confirmation', ?, ?, ?, 'agent', ?,
               'confirmed_checkpoint', ?, NULL, 'active')`,
  ).run(boundaryId, input.roomId, input.roomId, input.checkpointId,
    input.projectRevision, lifecycle.generation, input.agentActorId, input.now);
}

function refreshTransferBoundary(database: DatabaseSync, input: Readonly<{
  roomId: string; transferId: string; revision: number; holderActorId: string;
  reason: "transfer_acceptance" | "escalation"; dueAt: string; now: string;
}>): void {
  database.prepare(
    `UPDATE project_ball_boundaries SET status = 'superseded', released_at = ?
     WHERE room_id = ? AND source_kind = 'transfer' AND source_id = ? AND status = 'active'`,
  ).run(input.now, input.roomId, input.transferId);
  const lifecycle = database.prepare(
    "SELECT archive_generation AS generation FROM rooms WHERE id = ?",
  ).get(input.roomId);
  if (typeof lifecycle?.generation !== "number") {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project lifecycle generation is unavailable");
  }
  const boundaryId = `project-ball-${createHash("sha256").update(
    `${input.roomId}\0transfer\0${input.transferId}\0${input.revision}` +
      `\0${lifecycle.generation}\0human\0${input.holderActorId}`,
  ).digest("hex")}`;
  database.prepare(
    `INSERT INTO project_ball_boundaries (
       boundary_id, room_id, project_id, source_kind, source_id, source_revision,
       lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at, status
     ) VALUES (?, ?, ?, 'transfer', ?, ?, ?, 'human', ?, ?, ?, ?, 'active')`,
  ).run(boundaryId, input.roomId, input.roomId, input.transferId, input.revision,
    lifecycle.generation, input.holderActorId, input.reason, input.now, input.dueAt);
}

function releaseTransferBoundary(database: DatabaseSync, roomId: string,
  transferId: string, now: string): void {
  database.prepare(
    `UPDATE project_ball_boundaries SET status = 'superseded', released_at = ?
     WHERE room_id = ? AND source_kind = 'transfer' AND source_id = ? AND status = 'active'`,
  ).run(now, roomId, transferId);
}

function transferEscalationHolder(fact: ProjectLoopStoredFact): string {
  const ownerActorId = fact.details.ownerActorId;
  if (typeof ownerActorId !== "string") {
    throw new ProjectLoopAuthorityError("storage_unavailable",
      "Transfer escalation owner is unavailable");
  }
  if (fact.kind !== "next_action" || fact.details.ownerKind === "human") {
    return ownerActorId;
  }
  const verifierHumanActorId = fact.details.verifierHumanActorId;
  if (typeof verifierHumanActorId !== "string") {
    throw new ProjectLoopAuthorityError("storage_unavailable",
      "NextAction escalation principal is unavailable");
  }
  return verifierHumanActorId;
}

function refreshBallBoundary(database: DatabaseSync, fact: ProjectLoopStoredFact, now: string): void {
  database.prepare(
    `UPDATE project_ball_boundaries SET status = 'superseded', released_at = ?
     WHERE room_id = ? AND source_kind = ? AND source_id = ? AND status = 'active'`,
  ).run(now, fact.roomId, fact.kind, fact.id);
  if (fact.kind === "next_action" || fact.kind === "blocker" || fact.kind === "open_question") {
    database.prepare(
      `UPDATE project_ball_boundaries SET status = 'superseded', released_at = ?
       WHERE room_id = ? AND source_kind = 'transfer' AND status = 'active'
         AND source_id IN (
           SELECT id FROM project_transfer_proposals
           WHERE room_id = ? AND subject_kind = ? AND subject_id = ?
             AND status = 'pending' AND subject_revision <> ?
         )`,
    ).run(now, fact.roomId, fact.roomId, fact.kind, fact.id, fact.revision);
  }
  let holderKind: "human" | "agent" | undefined;
  let holderId: string | undefined;
  let reason = "";
  let dueAt: string | null = null;
  let sourceKind: "request" | "next_action" | "blocker" | "open_question" | "review" = fact.kind as never;
  if (fact.kind === "request" && fact.status === "pending_acceptance") {
    holderKind = "human"; holderId = String(fact.details.requesterActorId);
    reason = "pending_acceptance";
  } else if (fact.kind === "next_action" &&
      (fact.status === "proposed" || fact.status === "accepted" || fact.status === "in_progress" || fact.status === "delivered")) {
    const ownerKind = String(fact.details.ownerKind);
    const ownerId = String(fact.details.ownerActorId);
    const verifier = fact.details.verifierHumanActorId;
    if (fact.status === "delivered" || (fact.status === "proposed" && ownerKind === "agent")) {
      holderKind = "human"; holderId = typeof verifier === "string" ? verifier : undefined;
      reason = fact.status === "delivered" ? "delivery_verification" : "pending_confirmation";
    } else {
      holderKind = ownerKind as "human" | "agent"; holderId = ownerId; reason = "work";
    }
    dueAt = typeof fact.details.dueAt === "string" ? fact.details.dueAt : null;
  } else if ((fact.kind === "blocker" || fact.kind === "open_question") &&
      (fact.status === "open" || fact.status === "cannot_answer" || fact.status === "deferred")) {
    holderKind = String(fact.details.ownerKind) as "human" | "agent";
    holderId = String(fact.details.ownerActorId);
    if (fact.status === "deferred") {
      sourceKind = "review";
      reason = "review";
      dueAt = typeof fact.details.reviewAt === "string" ? fact.details.reviewAt : null;
    } else {
      reason = fact.status === "cannot_answer" ? "escalation" : "obstacle";
      dueAt = typeof fact.details.dueAt === "string" ? fact.details.dueAt : null;
    }
  }
  if (holderKind === undefined || holderId === undefined) return;
  const lifecycle = database.prepare(
    "SELECT archive_generation AS generation FROM rooms WHERE id = ?",
  ).get(fact.roomId);
  if (typeof lifecycle?.generation !== "number") {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project lifecycle generation is unavailable");
  }
  const boundaryId = `project-ball-${createHash("sha256")
    .update(`${fact.roomId}\0${sourceKind}\0${fact.id}\0${fact.revision}\0${lifecycle.generation}` +
      `\0${holderKind}\0${holderId}`)
    .digest("hex")}`;
  database.prepare(
    `INSERT INTO project_ball_boundaries (
       boundary_id, room_id, project_id, source_kind, source_id, source_revision, lifecycle_generation,
       holder_kind, holder_actor_id, reason, since, due_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
  ).run(boundaryId, fact.roomId, fact.roomId, sourceKind, fact.id, fact.revision,
    lifecycle.generation, holderKind, holderId, reason, now, dueAt);
}

function createFact(database: DatabaseSync, proposal: ProjectLoopStoredProposal, confirmerId: string,
  now: string): ProjectLoopStoredFact {
  const payload = proposal.payload;
  const title = stringField(payload, "title");
  const description = proposal.factKind === "decision"
    ? stringField(payload, "rationale", "") : stringField(payload, "description", "");
  const common = [proposal.factId, proposal.roomId, proposal.roomId, 1, title] as SQLInputValue[];
  if (proposal.factKind === "goal") {
    const supersedes = optionalString(payload, "supersedesGoalId");
    const supersedeReason = supersedes === null ? null : stringField(payload, "reason");
    const active = database.prepare("SELECT id FROM project_goals WHERE room_id = ? AND status = 'active'")
      .get(proposal.roomId);
    if (active !== undefined && (typeof active.id !== "string" || supersedes !== active.id)) {
      throw new ProjectLoopAuthorityError("revision_conflict", "An active primary Goal already exists");
    }
    if (supersedes !== null) {
      requireSupersedeAuthority(database, proposal.roomId, confirmerId);
      const updated = database.prepare(
        `UPDATE project_goals SET status = 'superseded', superseded_by_goal_id = ?, supersede_reason = ?,
           revision = revision + 1, updated_at = ?
         WHERE id = ? AND room_id = ? AND status = 'active'`,
      ).run(proposal.factId, supersedeReason, now, supersedes, proposal.roomId);
      if (updated.changes !== 1) throw new ProjectLoopAuthorityError("revision_conflict", "Superseded Goal is not current");
    }
    database.prepare(
      `INSERT INTO project_goals (
         id, room_id, project_id, revision, title, description, status,
         supersedes_goal_id, supersede_reason, source_room_id, source_id, source_kind,
         created_by_actor_id, confirmed_by_human_actor_id, created_at, updated_at
         , source_revision, visibility_room_id
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...common, description, supersedes, supersedeReason, proposal.roomId,
      proposal.source.sourceId, proposal.source.kind, proposal.proposedBy.actorId, confirmerId, now, now,
      proposal.source.sourceRevision, proposal.roomId);
  } else if (proposal.factKind === "decision") {
    const supersedes = optionalString(payload, "supersedesDecisionId");
    if (supersedes !== null) {
      requireSupersedeAuthority(database, proposal.roomId, confirmerId);
      const updated = database.prepare(
        `UPDATE project_decisions SET status = 'superseded', superseded_by_decision_id = ?,
           revision = revision + 1, updated_at = ?
         WHERE id = ? AND room_id = ? AND status = 'confirmed'`,
      ).run(proposal.factId, now, supersedes, proposal.roomId);
      if (updated.changes !== 1) throw new ProjectLoopAuthorityError("revision_conflict", "Superseded Decision is not confirmed");
    }
    database.prepare(
      `INSERT INTO project_decisions (
         id, room_id, project_id, revision, title, rationale, status,
         supersedes_decision_id, source_room_id, source_id, source_kind,
         created_by_actor_id, confirmed_by_human_actor_id, created_at, updated_at
         , source_revision, visibility_room_id
       ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...common, description, supersedes, proposal.roomId,
      proposal.source.sourceId, proposal.source.kind, proposal.proposedBy.actorId, confirmerId, now, now,
      proposal.source.sourceRevision, proposal.roomId);
  } else if (proposal.factKind === "request") {
    const target = stringField(payload, "targetHumanActorId");
    requireAssignableActor(database, proposal.roomId, target, "human");
    const frozenResponsibility = payload.responsibility;
    if (!isRecord(frozenResponsibility)) {
      throw new ProjectLoopAuthorityError("invalid_request", "Request responsibility factory is required");
    }
    database.prepare(
      `INSERT INTO project_requests (
         id, room_id, source_room_id, source_id, revision, requester_human_actor_id,
         target_human_actor_id, status, title, description, request_kind,
         linked_fact_kind, linked_fact_id, source_kind, created_by_actor_id, created_at, updated_at
         , source_revision, visibility_room_id, frozen_responsibility_json,
         frozen_responsibility_sha256
       ) VALUES (?, ?, ?, ?, 1, ?, ?, 'pending_acceptance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(proposal.factId, proposal.roomId, proposal.roomId, proposal.source.sourceId,
      proposal.proposedBy.kind === "human" ? proposal.proposedBy.actorId : confirmerId,
      target, title, description, stringField(payload, "acceptanceMode", "next_action"),
      optionalString(payload, "linkedFactKind"), optionalString(payload, "linkedFactId"),
      proposal.source.kind, proposal.proposedBy.actorId, now, now,
      proposal.source.sourceRevision, proposal.roomId, canonical(frozenResponsibility),
      hashProjectFrozenResponsibility(frozenResponsibility));
  } else if (proposal.factKind === "next_action") {
    const ownerKind = stringField(payload, "ownerKind");
    const ownerId = stringField(payload, "ownerActorId");
    const verifier = optionalString(payload, "verifierHumanActorId");
    if (ownerKind !== "human" && ownerKind !== "agent") throw new ProjectLoopAuthorityError("invalid_request", "NextAction owner kind is invalid");
    if (ownerKind === "agent" && verifier === null) throw new ProjectLoopAuthorityError("invalid_request", "Agent NextAction requires a Human verifier");
    requireAssignableActor(database, proposal.roomId, ownerId, ownerKind);
    if (verifier !== null) requireAssignableActor(database, proposal.roomId, verifier, "human");
    database.prepare(
      `INSERT INTO project_next_actions (
         id, room_id, source_room_id, source_id, revision, owner_kind, owner_actor_id,
         verifier_human_actor_id, status, title, description, due_at, acceptance_criteria,
         deliverable, source_kind, created_by_actor_id, accepted_by_human_actor_id, created_at, updated_at
         , source_revision, visibility_room_id
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(proposal.factId, proposal.roomId, proposal.roomId, proposal.source.sourceId,
      ownerKind, ownerId, verifier, title, description, optionalString(payload, "dueAt"),
      canonical(jsonArrayField(payload, "acceptanceCriteria")), stringField(payload, "deliverable"),
      proposal.source.kind, proposal.proposedBy.actorId, now, now,
      proposal.source.sourceRevision, proposal.roomId);
  } else {
    const ownerKind = stringField(payload, "ownerKind");
    const ownerId = stringField(payload, "ownerActorId");
    if (ownerKind !== "human" && ownerKind !== "agent") throw new ProjectLoopAuthorityError("invalid_request", "Obstacle owner kind is invalid");
    requireAssignableActor(database, proposal.roomId, ownerId, ownerKind);
    database.prepare(
      `INSERT INTO project_obstacles (
         id, room_id, source_room_id, source_id, revision, kind, owner_kind,
         owner_actor_id, status, title, description, impact, due_at, review_at,
         resolution_criteria, question, source_kind, created_by_actor_id, created_at, updated_at
         , source_revision, visibility_room_id
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(proposal.factId, proposal.roomId, proposal.roomId, proposal.source.sourceId,
      proposal.factKind, ownerKind, ownerId, title, description,
      stringField(payload, "impact", ""), optionalString(payload, "dueAt"),
      optionalString(payload, "reviewAt"), proposal.factKind === "blocker"
        ? stringField(payload, "resolutionCriteria") : null,
      proposal.factKind === "open_question" ? stringField(payload, "question") : null,
      proposal.source.kind, proposal.proposedBy.actorId, now, now,
      proposal.source.sourceRevision, proposal.roomId);
  }
  const fact = readFact(database, proposal.factKind, proposal.factId, proposal.roomId);
  refreshBallBoundary(database, fact, now);
  return fact;
}

function factFromRow(kind: ProjectLoopFactKind, row: Record<string, unknown>): ProjectLoopStoredFact {
  if (typeof row.id !== "string" || typeof row.roomId !== "string" ||
      typeof row.revision !== "number" || typeof row.status !== "string" ||
      typeof row.title !== "string" || typeof row.description !== "string" ||
      typeof row.sourceRoomId !== "string" || row.sourceRoomId !== row.roomId ||
      typeof row.sourceId !== "string" || typeof row.sourceKind !== "string" ||
      row.sourceKind === "legacy_v14" || typeof row.sourceRevision !== "number" ||
      typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project fact row is corrupt");
  }
  const excluded = new Set(["id", "roomId", "revision", "status", "title", "description",
    "sourceRoomId", "sourceId", "sourceKind", "createdAt", "updatedAt"]);
  const details: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!excluded.has(key) && value !== null &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      details[key] = value;
    }
  }
  return Object.freeze({
    kind, id: row.id, roomId: row.roomId, projectId: row.roomId, revision: row.revision,
    status: row.status, title: row.title, description: row.description,
    source: { roomId: row.sourceRoomId, sourceId: row.sourceId,
      kind: row.sourceKind as ProjectLoopSource["kind"], sourceRevision: row.sourceRevision,
      visibility: "room" as const },
    createdAt: row.createdAt, updatedAt: row.updatedAt, details: Object.freeze(details),
  });
}

function factSql(kind: ProjectLoopFactKind): string {
  if (kind === "goal") return `SELECT id, room_id AS roomId, revision, status, title, description,
    source_room_id AS sourceRoomId, source_id AS sourceId, source_kind AS sourceKind,
    created_at AS createdAt, updated_at AS updatedAt, source_revision AS sourceRevision,
    supersedes_goal_id AS supersedesGoalId,
    superseded_by_goal_id AS supersededByGoalId, confirmed_by_human_actor_id AS confirmedByHumanActorId
    FROM project_goals`;
  if (kind === "decision") return `SELECT id, room_id AS roomId, revision, status, title,
    rationale AS description, source_room_id AS sourceRoomId, source_id AS sourceId,
    source_kind AS sourceKind, created_at AS createdAt, updated_at AS updatedAt,
    source_revision AS sourceRevision,
    supersedes_decision_id AS supersedesDecisionId, superseded_by_decision_id AS supersededByDecisionId,
    confirmed_by_human_actor_id AS confirmedByHumanActorId FROM project_decisions`;
  if (kind === "request") return `SELECT id, room_id AS roomId, revision, status, title, description,
    source_room_id AS sourceRoomId, source_id AS sourceId, source_kind AS sourceKind,
    created_at AS createdAt, updated_at AS updatedAt, source_revision AS sourceRevision,
    requester_human_actor_id AS requesterActorId,
    target_human_actor_id AS targetActorId, request_kind AS requestKind,
    linked_fact_kind AS linkedFactKind, linked_fact_id AS linkedFactId FROM project_requests`;
  if (kind === "next_action") return `SELECT id, room_id AS roomId, revision, status, title, description,
    source_room_id AS sourceRoomId, source_id AS sourceId, source_kind AS sourceKind,
    created_at AS createdAt, updated_at AS updatedAt, source_revision AS sourceRevision,
    owner_kind AS ownerKind,
    owner_actor_id AS ownerActorId, verifier_human_actor_id AS verifierHumanActorId,
    due_at AS dueAt, acceptance_criteria AS acceptanceCriteria, deliverable,
    verified_by_human_actor_id AS verifiedByHumanActorId FROM project_next_actions`;
  return `SELECT id, room_id AS roomId, revision, status, title, description,
    source_room_id AS sourceRoomId, source_id AS sourceId, source_kind AS sourceKind,
    created_at AS createdAt, updated_at AS updatedAt, source_revision AS sourceRevision,
    kind AS obstacleKind, created_by_actor_id AS createdByActorId,
    owner_kind AS ownerKind, owner_actor_id AS ownerActorId, impact, due_at AS dueAt,
    review_at AS reviewAt, resolution_criteria AS resolutionCriteria, question,
    status_reason AS statusReason, escalation_emitted AS escalationEmitted
    FROM project_obstacles WHERE kind = '${kind}'`;
}

export function readProjectLoopFactInTransaction(database: DatabaseSync,
  kind: ProjectLoopFactKind, factId: string,
  roomId: string): ProjectLoopStoredFact {
  const row = database.prepare(`${factSql(kind)} AND id = ? AND room_id = ?`.replace("FROM project_goals AND", "FROM project_goals WHERE").replace("FROM project_decisions AND", "FROM project_decisions WHERE").replace("FROM project_requests AND", "FROM project_requests WHERE").replace("FROM project_next_actions AND", "FROM project_next_actions WHERE")).get(factId, roomId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new ProjectLoopAuthorityError("project_fact_not_found", "Project fact was not found");
  return factFromRow(kind, row);
}

const readFact = readProjectLoopFactInTransaction;

function createProposal(database: DatabaseSync,
  operation: Extract<ProjectLoopAuthorityOperation, { type: "project-loop.proposal.create" }>,
): ProjectLoopAuthorityResult {
  const principal = actor(operation.context);
  requireRoomAccess(database, operation.command.roomId, principal.actorId, true);
  if (principal.kind === "agent" && operation.command.factKind !== "goal" &&
      operation.command.factKind !== "decision") {
    throw new ProjectLoopAuthorityError("permission_denied",
      "Agents may only propose a Goal or Decision");
  }
  validateProjectSource(database, operation.command.source);
  const timestamp = iso(operation.now);
  const current = state(database, operation.command.roomId, timestamp);
  if (current.revision !== operation.command.baseRevision) {
    throw new ProjectLoopAuthorityError("revision_conflict", "Project base revision is stale");
  }
  const revision = current.revision + 1;
  const source = operation.command.source;
  if (actorKind(database, operation.command.principalActorId) !== "human") {
    throw new ProjectLoopAuthorityError("invalid_request", "Project proposal principal must be Human");
  }
  requireRoomAccess(database, operation.command.roomId, operation.command.principalActorId, false);
  if (principal.kind === "human" && operation.command.principalActorId !== principal.actorId) {
    throw new ProjectLoopAuthorityError("permission_denied", "Human proposal principal must be self");
  }
  if (Date.parse(operation.command.expiresAt) <= operation.now) {
    throw new ProjectLoopAuthorityError("invalid_request", "Project proposal expiry must be in the future");
  }
  const payloadJson = JSON.stringify(operation.command.payload);
  const payloadDigest = `sha256:${createHash("sha256").update(payloadJson).digest("hex")}`;
  database.prepare(
    `INSERT INTO project_fact_proposals (
       id, room_id, project_id, revision, fact_kind, fact_id, base_revision, status,
       payload_json, source_room_id, source_id, source_kind, proposed_by_kind,
       proposed_by_actor_id, principal_human_actor_id, created_at, updated_at,
       expires_at, source_revision, visibility_room_id
     ) VALUES (?, ?, ?, 1, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(operation.command.proposalId, operation.command.roomId, operation.command.projectId,
    operation.command.factKind, operation.command.factId, operation.command.baseRevision,
    payloadJson, source.roomId, source.sourceId, source.kind,
    principal.kind, principal.actorId, operation.command.principalActorId,
    timestamp, timestamp, operation.command.expiresAt, source.sourceRevision, source.roomId);
  database.prepare(
    `INSERT INTO project_confirmations (
       id, room_id, project_id, proposal_id, revision, principal_human_actor_id,
       base_revision, payload_digest, state, source_room_id, source_id, created_at, expires_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(`confirmation:${operation.command.proposalId}`, operation.command.roomId,
    operation.command.projectId, operation.command.proposalId,
    operation.command.principalActorId, operation.command.baseRevision, payloadDigest,
    source.roomId, source.sourceId, timestamp, operation.command.expiresAt);
  createPendingConfirmationBoundary(database, {
    roomId: operation.command.roomId,
    proposalId: operation.command.proposalId,
    revision: 1,
    principalHumanActorId: operation.command.principalActorId,
    expiresAt: operation.command.expiresAt,
  }, timestamp);
  const id = appendEvent(database, { roomId: operation.command.roomId, eventSeq: revision,
    eventType: "proposal.created", factKind: operation.command.factKind,
    factId: operation.command.factId, factRevision: 1, actorKind: principal.kind,
    actorId: principal.actorId, source, occurredAt: timestamp, payload: operation.command.payload });
  return { kind: "project-loop-mutation", roomId: operation.command.roomId,
    projectId: operation.command.roomId, acceptedRevision: revision, eventIds: [id], replayed: false };
}

function resolveProposal(database: DatabaseSync,
  operation: Extract<ProjectLoopAuthorityOperation, { type: "project-loop.proposal.resolve" }>,
): ProjectLoopAuthorityResult {
  const actorId = operation.context.principal.actorId;
  requireRoomAccess(database, operation.command.roomId, actorId, true);
  const timestamp = iso(operation.now);
  const current = state(database, operation.command.roomId, timestamp);
  const proposal = readProposal(database, operation.command.proposalId);
  if (proposal === undefined || proposal.roomId !== operation.command.roomId) {
    throw new ProjectLoopAuthorityError("project_fact_not_found", "Project proposal was not found");
  }
  if (proposal.revision !== operation.command.expectedRevision) {
    throw new ProjectLoopAuthorityError("revision_conflict", "Project proposal revision is stale");
  }
  if (proposal.status !== "pending") throw new ProjectLoopAuthorityError("invalid_transition", "Project proposal is already resolved");
  const rawProposal = database.prepare(`${PROPOSAL_SELECT} WHERE id = ?`).get(proposal.id);
  if (rawProposal?.principalHumanActorId !== actorId || typeof rawProposal.expiresAt !== "string" ||
      Date.parse(rawProposal.expiresAt) < operation.now) {
    throw new ProjectLoopAuthorityError("permission_denied", "Project confirmation principal is invalid or expired");
  }
  let fact: ProjectLoopStoredFact | undefined;
  if (operation.command.resolution === "confirmed") {
    validateProjectSource(database, proposal.source);
    fact = createFact(database, proposal, actorId, timestamp);
  }
  database.prepare(
    `UPDATE project_ball_boundaries SET status = 'superseded', released_at = ?
     WHERE room_id = ? AND source_kind = 'confirmation' AND source_id = ?
       AND source_revision = ? AND status = 'active'`,
  ).run(timestamp, proposal.roomId, `confirmation:${proposal.id}`, proposal.revision);
  database.prepare(
    `UPDATE project_fact_proposals SET status = ?, revision = revision + 1, updated_at = ?,
       resolved_at = ?, resolution_reason = ?
     WHERE id = ? AND revision = ? AND status = 'pending'`,
  ).run(operation.command.resolution, timestamp, timestamp,
    operation.command.reason,
    proposal.id, proposal.revision);
  database.prepare(
    `UPDATE project_confirmations
     SET revision = revision + 1, state = ?, resolved_by_human_actor_id = ?,
         resolved_at = ?, resolution_reason = ?
     WHERE proposal_id = ? AND revision = ? AND state = 'pending'`,
  ).run(operation.command.resolution, actorId, timestamp,
    operation.command.reason,
    proposal.id, proposal.revision);
  const revision = current.revision + 1;
  const id = appendEvent(database, { roomId: proposal.roomId, eventSeq: revision,
    eventType: operation.command.resolution === "confirmed" ? "proposal.confirmed" : "proposal.rejected",
    factKind: proposal.factKind, factId: proposal.factId, factRevision: fact?.revision ?? proposal.revision + 1,
    actorKind: "human", actorId, source: proposal.source, occurredAt: timestamp, payload: proposal.payload });
  return { kind: "project-loop-mutation", roomId: proposal.roomId, projectId: proposal.roomId,
    acceptedRevision: revision, eventIds: [id], replayed: false };
}

function humanActorId(context: ProjectLoopActorCommandContext): string {
  if (context.kind !== "human") {
    throw new ProjectLoopAuthorityError("permission_denied", "This Project transition requires a Human principal");
  }
  return context.principal.actorId;
}

function actorKind(database: DatabaseSync, actorId: string): "human" | "agent" {
  const row = database.prepare("SELECT kind FROM actors WHERE id = ?").get(actorId);
  if (row?.kind !== "human" && row?.kind !== "agent") {
    throw new ProjectLoopAuthorityError("invalid_request", "Project owner actor is invalid");
  }
  return row.kind;
}

function createRequestResponsibility(database: DatabaseSync, request: ProjectLoopStoredFact,
  targetHumanId: string, now: string): {
    kind: "next_action" | "blocker" | "open_question"; id: string;
} {
  const factory = database.prepare(
    `SELECT frozen_responsibility_json AS frozenResponsibilityJson,
            frozen_responsibility_sha256 AS frozenResponsibilitySha256
     FROM project_requests WHERE id = ? AND room_id = ? AND revision = ?`,
  ).get(request.id, request.roomId, request.revision);
  const raw = parseObject(factory?.frozenResponsibilityJson);
  if (typeof factory?.frozenResponsibilitySha256 !== "string" ||
      hashProjectFrozenResponsibility(raw) !== factory.frozenResponsibilitySha256) {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Request responsibility factory hash is corrupt");
  }
  const kind = stringField(raw, "kind");
  const id = stringField(raw, "responsibilityId");
  const title = stringField(raw, "title");
  const description = stringField(raw, "description");
  if (kind !== request.details.requestKind ||
      (kind !== "next_action" && kind !== "blocker" && kind !== "open_question")) {
    throw new ProjectLoopAuthorityError("invalid_request", "Request responsibility does not match acceptance mode");
  }
  const owner = raw.owner;
  if (!isRecord(owner) || owner.kind !== "human" || owner.actorId !== targetHumanId) {
    throw new ProjectLoopAuthorityError("invalid_request", "Request responsibility owner is not the frozen target");
  }
  if (kind === "next_action") {
    const criteria = raw.acceptanceCriteria;
    if (!Array.isArray(criteria) || !criteria.every((criterion) => isRecord(criterion) &&
        typeof criterion.criterionId === "string" && typeof criterion.text === "string")) {
      throw new ProjectLoopAuthorityError("invalid_request", "Request responsibility criteria are invalid");
    }
    const verifier = raw.verifier;
    if (verifier !== null && (!isRecord(verifier) || verifier.kind !== "human" ||
        typeof verifier.actorId !== "string")) {
      throw new ProjectLoopAuthorityError("invalid_request", "Request responsibility verifier is invalid");
    }
    const verifierActorId = verifier === null ? null : verifier.actorId as string;
    database.prepare(
      `INSERT INTO project_next_actions (
         id, room_id, source_room_id, source_id, revision, owner_kind, owner_actor_id,
         verifier_human_actor_id, status, title, description, due_at, deliverable,
         acceptance_criteria, source_kind, created_by_actor_id,
         accepted_by_human_actor_id, accepted_at, created_at, updated_at,
         source_revision, visibility_room_id
       ) VALUES (?, ?, ?, ?, 1, 'human', ?, ?, 'accepted', ?, ?, ?, ?, ?,
                 'project_fact', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, request.roomId, request.roomId, request.id, targetHumanId,
      verifierActorId, title, description,
      optionalString(raw, "dueAt"), stringField(raw, "deliverable"), canonical(criteria as JsonValue),
      targetHumanId, targetHumanId,
      now, now, now, request.revision, request.roomId);
  } else {
    database.prepare(
      `INSERT INTO project_obstacles (
         id, room_id, source_room_id, source_id, revision, kind, owner_kind, owner_actor_id,
         status, title, description, impact, due_at, review_at, resolution_criteria, question,
         source_kind, created_by_actor_id,
         created_at, updated_at, source_revision, visibility_room_id
       ) VALUES (?, ?, ?, ?, 1, ?, 'human', ?, 'open', ?, ?, ?, ?, ?, ?, ?,
                 'project_fact', ?, ?, ?, ?, ?)`,
    ).run(id, request.roomId, request.roomId, request.id, kind, targetHumanId, title,
      description, stringField(raw, "impact"), optionalString(raw, "dueAt"),
      optionalString(raw, "reviewAt"), kind === "blocker"
        ? stringField(raw, "resolutionCriteria") : null,
      kind === "open_question" ? stringField(raw, "question") : null,
      targetHumanId, now, now,
      request.revision, request.roomId);
  }
  const created = readFact(database, kind, id, request.roomId);
  refreshBallBoundary(database, created, now);
  return { kind, id };
}

function targetStatus(kind: ProjectLoopFactKind, current: string, transition: string): string {
  const edge = `${kind}:${current}:${transition}`;
  const targets: Readonly<Record<string, string>> = {
    "request:pending_acceptance:request.accept": "accepted",
    "request:pending_acceptance:request.reject": "rejected",
    "request:pending_acceptance:request.cancel": "cancelled",
    "request:pending_acceptance:request.transfer": "pending_acceptance",
    "next_action:proposed:next_action.accept": "accepted",
    "next_action:proposed:next_action.reject": "rejected",
    "next_action:proposed:next_action.cancel": "cancelled",
    "next_action:accepted:next_action.start": "in_progress",
    "next_action:accepted:next_action.cancel": "cancelled",
    "next_action:in_progress:next_action.deliver": "delivered",
    "next_action:in_progress:next_action.complete": "done",
    "next_action:in_progress:next_action.cancel": "cancelled",
    "next_action:delivered:next_action.complete": "done",
    "next_action:delivered:next_action.reopen": "in_progress",
    "next_action:delivered:next_action.cancel": "cancelled",
    "next_action:done:next_action.reopen": "in_progress",
    "next_action:accepted:next_action.transfer_propose": "accepted",
    "next_action:in_progress:next_action.transfer_propose": "in_progress",
    "next_action:delivered:next_action.transfer_propose": "delivered",
    "next_action:accepted:next_action.transfer_accept": "accepted",
    "next_action:in_progress:next_action.transfer_accept": "in_progress",
    "next_action:delivered:next_action.transfer_accept": "delivered",
    "next_action:accepted:next_action.transfer_reject": "accepted",
    "next_action:in_progress:next_action.transfer_reject": "in_progress",
    "next_action:delivered:next_action.transfer_reject": "delivered",
    "blocker:open:obstacle.resolve": "resolved",
    "open_question:open:obstacle.resolve": "resolved",
    "blocker:open:obstacle.defer": "deferred",
    "open_question:open:obstacle.defer": "deferred",
    "blocker:open:obstacle.cannot_answer": "cannot_answer",
    "open_question:open:obstacle.cannot_answer": "cannot_answer",
    "blocker:deferred:obstacle.reopen": "open",
    "open_question:deferred:obstacle.reopen": "open",
    "blocker:cannot_answer:obstacle.reopen": "open",
    "open_question:cannot_answer:obstacle.reopen": "open",
    "blocker:open:obstacle.transfer_propose": "open",
    "open_question:open:obstacle.transfer_propose": "open",
    "blocker:deferred:obstacle.transfer_propose": "deferred",
    "open_question:deferred:obstacle.transfer_propose": "deferred",
    "blocker:cannot_answer:obstacle.transfer_propose": "cannot_answer",
    "open_question:cannot_answer:obstacle.transfer_propose": "cannot_answer",
    "blocker:open:obstacle.transfer_accept": "open",
    "open_question:open:obstacle.transfer_accept": "open",
    "blocker:deferred:obstacle.transfer_accept": "open",
    "open_question:deferred:obstacle.transfer_accept": "open",
    "blocker:cannot_answer:obstacle.transfer_accept": "open",
    "open_question:cannot_answer:obstacle.transfer_accept": "open",
    "blocker:open:obstacle.transfer_reject": "open",
    "open_question:open:obstacle.transfer_reject": "open",
    "blocker:deferred:obstacle.transfer_reject": "deferred",
    "open_question:deferred:obstacle.transfer_reject": "deferred",
    "blocker:cannot_answer:obstacle.transfer_reject": "cannot_answer",
    "open_question:cannot_answer:obstacle.transfer_reject": "cannot_answer",
  };
  const target = targets[edge];
  if (target === undefined) throw new ProjectLoopAuthorityError("invalid_transition", "Project fact transition is invalid");
  return target;
}

function transitionFact(database: DatabaseSync,
  operation: Extract<ProjectLoopAuthorityOperation, { type: "project-loop.fact.transition" }>,
): ProjectLoopAuthorityResult {
  const principal = actor(operation.context);
  requireRoomAccess(database, operation.command.roomId, principal.actorId, true);
  const timestamp = iso(operation.now);
  const current = state(database, operation.command.roomId, timestamp);
  const fact = readFact(database, operation.command.factKind, operation.command.factId, operation.command.roomId);
  if (fact.revision !== operation.command.expectedRevision) throw new ProjectLoopAuthorityError("revision_conflict", "Project fact revision is stale");
  if (operation.command.factKind === "goal" || operation.command.factKind === "decision") {
    throw new ProjectLoopAuthorityError("invalid_transition", "Goal and Decision changes require a superseding proposal");
  }
  const transition = operation.command.transition;
  const nextStatus = targetStatus(operation.command.factKind, fact.status, transition);
  const payload = operation.command.payload;
  const eventIds: string[] = [];
  let changedTransfer: Readonly<{ id: string; revision: number }> | null = null;
  if (operation.command.factKind === "request") {
    const requester = String(fact.details.requesterActorId);
    const target = String(fact.details.targetActorId);
    const human = humanActorId(operation.context);
    if (transition === "request.accept" || transition === "request.reject") {
      if (human !== target) throw new ProjectLoopAuthorityError("permission_denied", "Only the Request target may respond");
    } else if (transition === "request.transfer") {
      const governanceFallback = hasRoomOwnerOrAdminAuthority(database, fact.roomId, human);
      if (human !== target && !governanceFallback) {
        throw new ProjectLoopAuthorityError("permission_denied",
          "Only the Request target or Room governance may transfer");
      }
    } else if (human !== requester) {
      throw new ProjectLoopAuthorityError("permission_denied", "Only the Request requester may cancel");
    }
    if (transition === "request.accept") {
      const linked = createRequestResponsibility(database, fact, target, timestamp);
      const responsibility = readFact(database, linked.kind, linked.id, fact.roomId);
      database.prepare(
        `UPDATE project_requests SET status = ?, linked_fact_kind = ?, linked_fact_id = ?,
           resolution_actor_kind = ?, resolution_actor_id = ?, resolved_at = ?,
           revision = revision + 1, updated_at = ? WHERE id = ? AND room_id = ? AND revision = ?`,
      ).run(nextStatus, linked.kind, linked.id, principal.kind, principal.actorId, timestamp,
        timestamp, fact.id, fact.roomId, fact.revision);
      eventIds.push(appendEvent(database, { roomId: fact.roomId,
        eventSeq: current.revision + 1, eventType: "fact.created", factKind: linked.kind,
        factId: linked.id, factRevision: responsibility.revision,
        actorKind: principal.kind, actorId: principal.actorId, source: responsibility.source,
        occurredAt: timestamp, payload: responsibility.details }));
    } else if (transition === "request.transfer") {
      const newTarget = stringField(payload, "targetHumanActorId");
      requireAssignableActor(database, fact.roomId, newTarget, "human");
      const factory = database.prepare(
        `SELECT frozen_responsibility_json AS frozenResponsibilityJson,
                frozen_responsibility_sha256 AS frozenResponsibilitySha256
         FROM project_requests WHERE id = ? AND room_id = ? AND revision = ?`,
      ).get(fact.id, fact.roomId, fact.revision);
      const frozen = parseObject(factory?.frozenResponsibilityJson);
      if (typeof factory?.frozenResponsibilitySha256 !== "string" ||
          hashProjectFrozenResponsibility(frozen) !== factory.frozenResponsibilitySha256) {
        throw new ProjectLoopAuthorityError("storage_unavailable", "Request responsibility factory hash is corrupt");
      }
      const rebound = Object.freeze({ ...frozen,
        owner: Object.freeze({ kind: "human" as const, actorId: newTarget }) });
      database.prepare(
        `UPDATE project_requests SET target_human_actor_id = ?, status = 'pending_acceptance',
           frozen_responsibility_json = ?, frozen_responsibility_sha256 = ?,
           revision = revision + 1, updated_at = ? WHERE id = ? AND room_id = ? AND revision = ?`,
      ).run(newTarget, canonical(rebound), hashProjectFrozenResponsibility(rebound),
        timestamp, fact.id, fact.roomId, fact.revision);
      database.prepare(
        `INSERT INTO project_transfer_chain VALUES (?, ?, ?, 'request', ?, ?, 'human', ?, 'human', ?, ?, ?, ?)`,
      ).run(`transfer:${fact.id}:${fact.revision + 1}`, fact.roomId, fact.roomId, fact.id,
        fact.revision + 1, target, newTarget, human, stringField(payload, "reason"), timestamp);
    } else {
      database.prepare(
        `UPDATE project_requests SET status = ?, resolution_actor_kind = ?, resolution_actor_id = ?,
         resolved_at = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND room_id = ? AND revision = ?`,
      ).run(nextStatus, principal.kind, principal.actorId, timestamp,
        timestamp, fact.id, fact.roomId, fact.revision);
    }
  } else if (operation.command.factKind === "next_action") {
    const ownerKind = String(fact.details.ownerKind);
    const ownerId = String(fact.details.ownerActorId);
    const verifier = fact.details.verifierHumanActorId;
    if (transition === "next_action.transfer_propose") {
      const human = humanActorId(operation.context);
      const transferAuthority = ownerKind === "human" ? ownerId : verifier;
      if (human !== transferAuthority) {
        throw new ProjectLoopAuthorityError("permission_denied", "NextAction transfer proposer is invalid");
      }
      const toKind = stringField(payload, "toOwnerKind");
      const toId = stringField(payload, "toOwnerActorId");
      if (toKind !== "human" && toKind !== "agent") {
        throw new ProjectLoopAuthorityError("invalid_request", "NextAction transfer target is invalid");
      }
      requireAssignableActor(database, fact.roomId, toId, toKind);
      const principalHumanActorId = toKind === "human" ? toId : verifier;
      if (typeof principalHumanActorId !== "string") {
        throw new ProjectLoopAuthorityError("invalid_request", "Agent transfer requires a designated Human principal");
      }
      const expiresAt = stringField(payload, "expiresAt");
      if (Date.parse(expiresAt) <= operation.now) {
        throw new ProjectLoopAuthorityError("invalid_request", "NextAction transfer expiry is invalid");
      }
      database.prepare(
        `INSERT INTO project_transfer_proposals (
           id, room_id, source_room_id, source_id, revision, subject_kind, subject_id,
           to_owner_kind, to_owner_actor_id, status, from_owner_kind, from_owner_actor_id,
           principal_human_actor_id, reason, source_kind, created_by_actor_id, created_at, updated_at,
           subject_revision, expires_at
         ) VALUES (?, ?, ?, ?, 1, 'next_action', ?, ?, ?, 'pending', ?, ?, ?, ?,
                   'project_fact', ?, ?, ?, ?, ?)`,
      ).run(stringField(payload, "transferProposalId"), fact.roomId, fact.roomId, fact.id,
        fact.id, toKind, toId, ownerKind, ownerId, principalHumanActorId,
        stringField(payload, "reason"), human, timestamp, timestamp, fact.revision, expiresAt);
      changedTransfer = Object.freeze({ id: stringField(payload, "transferProposalId"), revision: 1 });
      refreshTransferBoundary(database, {
        roomId: fact.roomId, transferId: stringField(payload, "transferProposalId"),
        revision: 1, holderActorId: principalHumanActorId,
        reason: "transfer_acceptance", dueAt: timestamp, now: timestamp,
      });
    } else if (transition === "next_action.transfer_accept" ||
        transition === "next_action.transfer_reject") {
      const human = humanActorId(operation.context);
      const transferId = stringField(payload, "transferProposalId");
      const transfer = database.prepare(
        `SELECT * FROM project_transfer_proposals WHERE id = ? AND room_id = ?
           AND subject_kind = 'next_action' AND subject_id = ? AND subject_revision = ?
           AND status = 'pending'`,
      ).get(transferId, fact.roomId, fact.id, fact.revision);
      if (transfer === undefined || transfer.principal_human_actor_id !== human ||
          (transfer.to_owner_kind === "human" && transfer.to_owner_actor_id !== human)) {
        throw new ProjectLoopAuthorityError("permission_denied", "NextAction transfer principal is invalid");
      }
      if ((transfer.to_owner_kind !== "human" && transfer.to_owner_kind !== "agent") ||
          typeof transfer.to_owner_actor_id !== "string" || typeof transfer.reason !== "string" ||
          typeof transfer.expires_at !== "string" || typeof transfer.revision !== "number") {
        throw new ProjectLoopAuthorityError("storage_unavailable", "NextAction transfer row is corrupt");
      }
      const expired = Date.parse(transfer.expires_at) <= operation.now;
      const accepted = transition === "next_action.transfer_accept";
      if (accepted && !expired) {
        requireAssignableActor(database, fact.roomId, transfer.to_owner_actor_id,
          transfer.to_owner_kind);
      }
      const changed = database.prepare(
        `UPDATE project_transfer_proposals SET status = ?, revision = revision + 1, updated_at = ?,
           resolved_by_human_actor_id = ?, resolved_at = ?, resolution_reason = ?
         WHERE id = ? AND room_id = ? AND revision = ? AND status = 'pending'`,
      ).run(expired ? "expired" : accepted ? "accepted" : "rejected", timestamp, human, timestamp,
        expired ? "Transfer proposal expired" : accepted ? null : "Human rejected transfer",
        transferId, fact.roomId, Number(transfer.revision));
      if (changed.changes !== 1) {
        throw new ProjectLoopAuthorityError("revision_conflict", "NextAction transfer changed concurrently");
      }
      changedTransfer = Object.freeze({ id: transferId, revision: Number(transfer.revision) + 1 });
      releaseTransferBoundary(database, fact.roomId, transferId, timestamp);
      if (expired) {
        const escalationHolder = transferEscalationHolder(fact);
        refreshTransferBoundary(database, {
          roomId: fact.roomId, transferId, revision: Number(transfer.revision) + 1,
          holderActorId: escalationHolder, reason: "escalation",
          dueAt: timestamp, now: timestamp,
        });
      }
      if (accepted && !expired) {
        database.prepare(
          `UPDATE project_next_actions SET owner_kind = ?, owner_actor_id = ?,
             verifier_human_actor_id = CASE WHEN ? = 'human' AND verifier_human_actor_id = ?
               THEN NULL ELSE verifier_human_actor_id END,
             status = CASE WHEN ? = 'human' THEN 'proposed' ELSE 'accepted' END,
             accepted_by_human_actor_id = CASE WHEN ? = 'human' THEN NULL ELSE ? END,
             accepted_at = CASE WHEN ? = 'human' THEN NULL ELSE ? END,
             delivery_source_kind = NULL, delivery_source_id = NULL,
             delivery_source_revision = NULL, delivery_source_room_id = NULL,
             delivery_summary = NULL, verified_by_human_actor_id = NULL,
             completed_by_human_actor_id = NULL, completed_at = NULL,
             completion_note = NULL, completion_criteria_json = NULL, status_reason = NULL,
             revision = revision + 1, updated_at = ?
           WHERE id = ? AND room_id = ? AND revision = ?`,
        ).run(transfer.to_owner_kind, transfer.to_owner_actor_id,
          transfer.to_owner_kind, transfer.to_owner_actor_id,
          transfer.to_owner_kind, transfer.to_owner_kind, human,
          transfer.to_owner_kind, timestamp, timestamp,
          fact.id, fact.roomId, fact.revision);
        database.prepare(
          `INSERT INTO project_transfer_chain VALUES (?, ?, ?, 'next_action', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(transferId, fact.roomId, fact.roomId, fact.id, fact.revision + 1,
          ownerKind, ownerId, transfer.to_owner_kind, transfer.to_owner_actor_id,
          human, transfer.reason, timestamp);
      }
    } else if (transition === "next_action.start" || transition === "next_action.deliver") {
      if (principal.actorId !== ownerId) throw new ProjectLoopAuthorityError("permission_denied", "Only the NextAction owner may progress delivery");
    } else if (transition === "next_action.complete") {
      const human = humanActorId(operation.context);
      if (fact.status === "in_progress" &&
          (ownerKind !== "human" || typeof verifier === "string")) {
        throw new ProjectLoopAuthorityError("invalid_transition",
          "Only a Human-owned NextAction without a verifier may complete before delivery");
      }
      if ((typeof verifier === "string" && human !== verifier) ||
          (typeof verifier !== "string" && (ownerKind !== "human" || human !== ownerId))) {
        throw new ProjectLoopAuthorityError("permission_denied", "Only the designated Human may complete this NextAction");
      }
    } else if (transition === "next_action.accept") {
      const human = humanActorId(operation.context);
      if (ownerKind === "human" ? human !== ownerId : human !== verifier) {
        throw new ProjectLoopAuthorityError("permission_denied", "NextAction acceptance principal is invalid");
      }
    } else if (transition === "next_action.reopen") {
      const human = humanActorId(operation.context);
      const reopenAuthority = typeof verifier === "string" ? verifier
        : ownerKind === "human" ? ownerId : null;
      if (human !== reopenAuthority) {
        throw new ProjectLoopAuthorityError("permission_denied",
          "Only the designated Human may reopen this NextAction");
      }
    } else if (transition === "next_action.reject" || transition === "next_action.cancel") {
      const human = humanActorId(operation.context);
      const authorityId = ownerKind === "human" ? ownerId : verifier;
      if (human !== authorityId) {
        throw new ProjectLoopAuthorityError("permission_denied", "NextAction terminal authority is invalid");
      }
    }
    if (transition === "next_action.transfer_propose" ||
        transition === "next_action.transfer_accept" || transition === "next_action.transfer_reject") {
      // Transfer proposals are their own authority record. Pending/rejected proposals never
      // revise the responsibility; acceptance above is the only owner mutation.
    } else {
    let deliverySource: Readonly<Record<string, JsonValue>> | null = null;
    if (transition === "next_action.deliver") {
      if (!isRecord(payload.source)) {
        throw new ProjectLoopAuthorityError("invalid_request", "NextAction delivery source is invalid");
      }
      deliverySource = payload.source;
      validateProjectSource(database, deliverySource as unknown as ProjectLoopSource);
    }
    const terminalReason = transition === "next_action.reject" || transition === "next_action.cancel"
      ? stringField(payload, "reason") : null;
    const completionNote = transition === "next_action.complete" ? stringField(payload, "completionNote") : null;
    const completionCriteria = transition === "next_action.complete"
      ? canonical(jsonArrayField(payload, "criteriaSnapshot")) : null;
    database.prepare(
      `UPDATE project_next_actions SET status = ?,
         accepted_by_human_actor_id = CASE WHEN ? = 'next_action.accept' THEN ? ELSE accepted_by_human_actor_id END,
         accepted_at = CASE WHEN ? = 'next_action.accept' THEN ? ELSE accepted_at END,
         delivery_source_kind = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.deliver' THEN ? ELSE delivery_source_kind END,
         delivery_source_id = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.deliver' THEN ? ELSE delivery_source_id END,
         delivery_source_revision = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.deliver' THEN ? ELSE delivery_source_revision END,
         delivery_source_room_id = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.deliver' THEN ? ELSE delivery_source_room_id END,
         delivery_summary = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.deliver' THEN ? ELSE delivery_summary END,
         verified_by_human_actor_id = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.complete' THEN ? ELSE verified_by_human_actor_id END,
         completed_by_human_actor_id = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.complete' THEN ? ELSE completed_by_human_actor_id END,
         completed_at = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.complete' THEN ? ELSE completed_at END,
         completion_note = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.complete' THEN ? ELSE completion_note END,
         completion_criteria_json = CASE WHEN ? = 'next_action.reopen' THEN NULL
           WHEN ? = 'next_action.complete' THEN ? ELSE completion_criteria_json END,
         status_reason = CASE WHEN ? IN ('next_action.reject','next_action.cancel') THEN ?
           WHEN ? = 'next_action.reopen' THEN NULL ELSE status_reason END,
         revision = revision + 1, updated_at = ? WHERE id = ? AND room_id = ? AND revision = ?`,
    ).run(nextStatus, transition,
      operation.context.kind === "human" ? operation.context.principal.actorId : null,
      transition, timestamp,
      transition, transition, deliverySource === null ? null : stringField(deliverySource, "kind"),
      transition, transition, deliverySource === null ? null : stringField(deliverySource, "sourceId"),
      transition, transition, deliverySource === null ? null : deliverySource.sourceRevision as number,
      transition, transition, deliverySource === null ? null : stringField(deliverySource, "roomId"),
      transition, transition, transition === "next_action.deliver" ? stringField(payload, "summary") : null,
      transition, transition,
      operation.context.kind === "human" ? operation.context.principal.actorId : null,
      transition, transition,
      operation.context.kind === "human" ? operation.context.principal.actorId : null,
      transition, transition, timestamp, transition, transition, completionNote,
      transition, transition, completionCriteria,
      transition, terminalReason, transition,
      timestamp, fact.id, fact.roomId, fact.revision);
    }
  } else {
    const ownerKind = String(fact.details.ownerKind);
    const ownerId = String(fact.details.ownerActorId);
    if (transition === "obstacle.transfer_propose") {
      const humanProposer = operation.context.kind === "human"
        ? operation.context.principal.actorId : null;
      const requesterId = fact.details.createdByActorId;
      if (typeof requesterId !== "string") {
        throw new ProjectLoopAuthorityError("storage_unavailable",
          "Obstacle requester authority is unavailable");
      }
      const currentOwner = principal.actorId === ownerId;
      const currentRequester = humanProposer === requesterId;
      const governanceFallback = humanProposer !== null &&
        hasRoomOwnerOrAdminAuthority(database, fact.roomId, humanProposer);
      if (!currentOwner && !currentRequester && !governanceFallback) {
        throw new ProjectLoopAuthorityError("permission_denied", "Obstacle transfer proposer is invalid");
      }
      const toKind = stringField(payload, "toOwnerKind");
      const toId = stringField(payload, "toOwnerActorId");
      if (toKind !== "human" && toKind !== "agent") {
        throw new ProjectLoopAuthorityError("invalid_request", "Obstacle transfer target is invalid");
      }
      requireAssignableActor(database, fact.roomId, toId, toKind);
      const principalHumanActorId = toKind === "human" ? toId :
        humanProposer ?? roomOwnerHumanActorId(database, fact.roomId);
      const expiresAt = stringField(payload, "expiresAt");
      if (Date.parse(expiresAt) <= operation.now) {
        throw new ProjectLoopAuthorityError("invalid_request", "Obstacle transfer expiry is invalid");
      }
      database.prepare(
        `INSERT INTO project_transfer_proposals (
           id, room_id, source_room_id, source_id, revision, subject_kind, subject_id,
           to_owner_kind, to_owner_actor_id, status, from_owner_kind, from_owner_actor_id,
           principal_human_actor_id, reason, source_kind, created_by_actor_id, created_at, updated_at,
           subject_revision, expires_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 'project_fact', ?, ?, ?, ?, ?)`,
      ).run(stringField(payload, "transferProposalId"), fact.roomId, fact.roomId, fact.id,
        operation.command.factKind, fact.id, toKind, toId, ownerKind, ownerId,
        principalHumanActorId, stringField(payload, "reason"),
        principal.actorId, timestamp, timestamp, fact.revision, expiresAt);
      changedTransfer = Object.freeze({ id: stringField(payload, "transferProposalId"), revision: 1 });
      refreshTransferBoundary(database, {
        roomId: fact.roomId, transferId: stringField(payload, "transferProposalId"),
        revision: 1, holderActorId: principalHumanActorId,
        reason: "transfer_acceptance", dueAt: timestamp, now: timestamp,
      });
    } else if (transition === "obstacle.transfer_accept" || transition === "obstacle.transfer_reject") {
      const human = humanActorId(operation.context);
      const transferId = stringField(payload, "transferProposalId");
      const transfer = database.prepare(
        `SELECT * FROM project_transfer_proposals WHERE id = ? AND room_id = ?
           AND subject_kind = ? AND subject_id = ? AND subject_revision = ?
           AND status = 'pending'`,
      ).get(transferId, fact.roomId, operation.command.factKind, fact.id, fact.revision);
      if (transfer === undefined || (transfer.to_owner_kind === "human"
          ? transfer.to_owner_actor_id !== human : transfer.principal_human_actor_id !== human)) {
        throw new ProjectLoopAuthorityError("permission_denied", "Obstacle transfer principal is invalid");
      }
      if ((transfer.to_owner_kind !== "human" && transfer.to_owner_kind !== "agent") ||
          typeof transfer.to_owner_actor_id !== "string" || typeof transfer.reason !== "string" ||
          typeof transfer.expires_at !== "string" || typeof transfer.revision !== "number") {
        throw new ProjectLoopAuthorityError("storage_unavailable", "Obstacle transfer row is corrupt");
      }
      const expired = Date.parse(transfer.expires_at) <= operation.now;
      const accepted = transition === "obstacle.transfer_accept";
      if (accepted && !expired) {
        requireAssignableActor(database, fact.roomId, transfer.to_owner_actor_id,
          transfer.to_owner_kind);
      }
      const changed = database.prepare(
        `UPDATE project_transfer_proposals SET status = ?, revision = revision + 1, updated_at = ?,
           resolved_by_human_actor_id = ?, resolved_at = ?, resolution_reason = ?
         WHERE id = ? AND room_id = ? AND revision = ? AND status = 'pending'`,
      ).run(expired ? "expired" : accepted ? "accepted" : "rejected", timestamp, human, timestamp,
        expired ? "Transfer proposal expired" : accepted ? null : "Human rejected transfer",
        transferId, fact.roomId, Number(transfer.revision));
      if (changed.changes !== 1) {
        throw new ProjectLoopAuthorityError("revision_conflict", "Obstacle transfer changed concurrently");
      }
      changedTransfer = Object.freeze({ id: transferId, revision: Number(transfer.revision) + 1 });
      releaseTransferBoundary(database, fact.roomId, transferId, timestamp);
      if (expired) refreshTransferBoundary(database, {
        roomId: fact.roomId, transferId, revision: Number(transfer.revision) + 1,
        holderActorId: ownerId, reason: "escalation",
        dueAt: timestamp, now: timestamp,
      });
      if (accepted && !expired) {
        database.prepare(
          `UPDATE project_obstacles SET owner_kind = ?, owner_actor_id = ?, status = 'open',
             status_reason = NULL, review_at = NULL, escalation_emitted = 0,
             escalation_boundary_id = NULL,
             revision = revision + 1, updated_at = ? WHERE id = ? AND room_id = ? AND revision = ?`,
        ).run(transfer.to_owner_kind, transfer.to_owner_actor_id, timestamp,
          fact.id, fact.roomId, fact.revision);
        database.prepare(
          `INSERT INTO project_transfer_chain VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(transferId, fact.roomId, fact.roomId, operation.command.factKind, fact.id,
          fact.revision + 1, ownerKind, ownerId, transfer.to_owner_kind,
          transfer.to_owner_actor_id, human, transfer.reason, timestamp);
      }
    } else {
      if (principal.actorId !== ownerId) throw new ProjectLoopAuthorityError("permission_denied", "Only the Obstacle owner may transition it");
      const reason = transition === "obstacle.defer" || transition === "obstacle.cannot_answer" ||
        transition === "obstacle.reopen" ? stringField(payload, "reason") : null;
      const reviewAt = transition === "obstacle.defer" ? stringField(payload, "reviewAt") : null;
      if (transition === "obstacle.defer" && Date.parse(reviewAt as string) <= operation.now) {
        throw new ProjectLoopAuthorityError("invalid_request", "Obstacle review must be in the future");
      }
      let resultSource: Readonly<Record<string, JsonValue>> | null = null;
      if (transition === "obstacle.resolve") {
        if (!isRecord(payload.source)) {
          throw new ProjectLoopAuthorityError("invalid_request", "Obstacle result source is invalid");
        }
        resultSource = payload.source;
        validateProjectSource(database, resultSource as unknown as ProjectLoopSource);
      }
      database.prepare(
        `UPDATE project_obstacles SET status = ?, status_reason = ?, review_at = ?,
           escalation_emitted = CASE WHEN ? = 'obstacle.cannot_answer' THEN 1 ELSE escalation_emitted END,
           escalation_boundary_id = CASE WHEN ? = 'obstacle.reopen' THEN NULL ELSE escalation_boundary_id END,
           result_source_kind = CASE WHEN ? = 'obstacle.resolve' THEN ? ELSE result_source_kind END,
           result_source_id = CASE WHEN ? = 'obstacle.resolve' THEN ? ELSE result_source_id END,
           result_source_revision = CASE WHEN ? = 'obstacle.resolve' THEN ? ELSE result_source_revision END,
           result_source_room_id = CASE WHEN ? = 'obstacle.resolve' THEN ? ELSE result_source_room_id END,
           revision = revision + 1, updated_at = ? WHERE id = ? AND room_id = ? AND revision = ?`,
      ).run(nextStatus, transition === "obstacle.reopen" ? null :
        transition === "obstacle.resolve" ? stringField(payload, "reason") : reason, reviewAt,
        transition, transition, transition, resultSource === null ? null : stringField(resultSource, "kind"),
        transition, resultSource === null ? null : stringField(resultSource, "sourceId"),
        transition, resultSource === null ? null : resultSource.sourceRevision as number,
        transition, resultSource === null ? null : stringField(resultSource, "roomId"),
        timestamp, fact.id, fact.roomId, fact.revision);
    }
  }
  let updated = readFact(database, operation.command.factKind, fact.id, fact.roomId);
  if (updated.revision !== fact.revision) refreshBallBoundary(database, updated, timestamp);
  if (transition === "obstacle.cannot_answer") {
    const escalation = database.prepare(
      `SELECT boundary_id AS boundaryId FROM project_ball_boundaries
       WHERE room_id = ? AND source_id = ? AND source_revision = ?
         AND reason = 'escalation' AND status = 'active'`,
    ).get(fact.roomId, fact.id, updated.revision);
    if (typeof escalation?.boundaryId !== "string") {
      throw new ProjectLoopAuthorityError("storage_unavailable", "Obstacle escalation boundary is missing");
    }
    database.prepare(
      `UPDATE project_obstacles SET escalation_boundary_id = ? WHERE id = ? AND room_id = ?`,
    ).run(escalation.boundaryId, fact.id, fact.roomId);
    updated = readFact(database, operation.command.factKind, fact.id, fact.roomId);
  }
  const source = fact.source;
  if (changedTransfer !== null) {
    eventIds.push(appendEvent(database, { roomId: fact.roomId,
      eventSeq: current.revision + eventIds.length + 1,
      eventType: "fact.transitioned", factKind: fact.kind, factId: fact.id,
      factRevision: updated.revision, actorKind: principal.kind, actorId: principal.actorId,
      source, occurredAt: timestamp, publicEntity: "transfer",
      publicEntityId: changedTransfer.id, publicEntityRevision: changedTransfer.revision,
      payload: Object.freeze({ ...operation.command.payload, transition,
        transferProposalId: changedTransfer.id, transferRevision: changedTransfer.revision }) }));
  }
  if (changedTransfer === null || updated.revision !== fact.revision) {
    eventIds.push(appendEvent(database, { roomId: fact.roomId,
      eventSeq: current.revision + eventIds.length + 1,
      eventType: "fact.transitioned", factKind: fact.kind, factId: fact.id,
      factRevision: updated.revision, actorKind: principal.kind, actorId: principal.actorId,
      source, occurredAt: timestamp, payload: operation.command.payload }));
  }
  const revision = current.revision + eventIds.length;
  return { kind: "project-loop-mutation", roomId: fact.roomId, projectId: fact.roomId,
    acceptedRevision: revision, eventIds: Object.freeze(eventIds), replayed: false };
}

export function readProjectLoopRepairSnapshotDatabaseQuery(database: DatabaseSync, input: {
  roomId: string; projectId: string; watermark: number; afterEventSeq: number; limit: number;
}) {
  if (!Number.isSafeInteger(input.watermark) || input.watermark < 0) {
    throw new ProjectLoopAuthorityError("invalid_request", "Project repair watermark is invalid");
  }
  const captured = database.prepare(
    `SELECT COALESCE(state.updated_at, room.created_at) AS capturedAt
     FROM rooms AS room LEFT JOIN project_room_states AS state ON state.room_id = room.id
     WHERE room.id = ?`,
  ).get(input.roomId);
  if (typeof captured?.capturedAt !== "string") {
    throw new ProjectLoopAuthorityError("room_not_found", "Project Room was not found");
  }
  return readCanonicalProjectSnapshotDatabaseQuery(database, { roomId: input.roomId,
    projectId: input.projectId, watermark: input.watermark, capturedAt: captured.capturedAt });
}

export function writeProjectLoopCheckpointInTransaction(database: DatabaseSync, input: {
  roomId: string; projectRevision: number; occurredAt: string;
}): Readonly<{ checkpointId: string; projectionSha256: string }> {
  if (!Number.isSafeInteger(input.projectRevision) || input.projectRevision < 0 ||
      !Number.isFinite(Date.parse(input.occurredAt))) {
    throw new ProjectLoopAuthorityError("invalid_request", "Project checkpoint input is invalid");
  }
  const stream = database.prepare(
    `SELECT head_seq AS headSeq FROM streams WHERE stream_kind = 'room' AND stream_id = ?`,
  ).get(input.roomId);
  if (typeof stream?.headSeq !== "number") {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project Room stream is unavailable");
  }
  const stateRow = database.prepare(
    `SELECT revision FROM project_room_states WHERE room_id = ?`,
  ).get(input.roomId);
  if (stateRow?.revision !== input.projectRevision) {
    throw new ProjectLoopAuthorityError("revision_conflict", "Project checkpoint revision is stale");
  }
  const snapshot = readCanonicalProjectSnapshotDatabaseQuery(database, {
    roomId: input.roomId, projectId: input.roomId, watermark: stream.headSeq,
    capturedAt: input.occurredAt,
  });
  const projectionJson = canonical(snapshot as unknown as JsonValue);
  const projectionSha256 = createHash("sha256").update(projectionJson).digest("hex");
  const checkpointId = `project-checkpoint:${input.roomId}:${input.projectRevision}`;
  database.prepare(
    `INSERT INTO project_fact_checkpoints (
       checkpoint_id, room_id, project_id, project_revision,
       projection_json, projection_sha256, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(checkpointId, input.roomId, input.roomId, input.projectRevision,
    projectionJson, projectionSha256, input.occurredAt);
  return Object.freeze({ checkpointId, projectionSha256 });
}

export type ProjectDueReminderClaim = Readonly<{
  claimId: string;
  roomId: string;
  boundaryId: string;
  sourceRevision: number;
  reminderKind: "initial_due" | "repeat_24h" | "review";
  reminderOrdinal: number;
  recipientActorId: string;
  holderKind: "human" | "agent";
  claimedAt: string;
}>;

export function claimDueProjectRemindersDatabaseCommand(database: DatabaseSync, input: {
  roomId: string; now: number; limit: number;
}): readonly ProjectDueReminderClaim[] {
  if (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isSafeInteger(input.limit) ||
      input.limit < 1 || input.limit > 200) {
    throw new ProjectLoopAuthorityError("invalid_request", "Project due claim input is invalid");
  }
  const nowIso = iso(input.now);
  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = database.prepare(
      `SELECT boundary_id AS boundaryId, source_revision AS sourceRevision,
              holder_kind AS holderKind, holder_actor_id AS holderActorId, due_at AS dueAt
       FROM project_ball_boundaries
       WHERE room_id = ? AND status = 'active' AND due_at IS NOT NULL AND due_at <= ?
       ORDER BY due_at, boundary_id LIMIT ?`,
    ).all(input.roomId, nowIso, input.limit);
    const claims: ProjectDueReminderClaim[] = [];
    for (const row of rows) {
      if (typeof row.boundaryId !== "string" || typeof row.sourceRevision !== "number" ||
          (row.holderKind !== "human" && row.holderKind !== "agent") ||
          typeof row.holderActorId !== "string" || typeof row.dueAt !== "string") {
        throw new ProjectLoopAuthorityError("storage_unavailable", "Project due boundary is corrupt");
      }
      const due = Date.parse(row.dueAt);
      if (!Number.isFinite(due)) throw new ProjectLoopAuthorityError("storage_unavailable", "Project due boundary is corrupt");
      const ordinal = Math.floor((input.now - due) / (24 * 60 * 60 * 1_000));
      const kind = ordinal === 0 ? "initial_due" as const : "repeat_24h" as const;
      const claimId = `project-reminder-${createHash("sha256")
        .update(`${row.boundaryId}\0${row.sourceRevision}\0${kind}\0${ordinal}\0${row.holderActorId}`)
        .digest("hex")}`;
      const inserted = database.prepare(
        `INSERT INTO project_due_reminder_claims (
           claim_id, room_id, boundary_id, source_revision, reminder_kind,
           reminder_ordinal, boundary_at, holder_kind, holder_actor_id,
           recipient_actor_id, status, claimed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)
         ON CONFLICT(room_id, boundary_id, reminder_kind, reminder_ordinal, recipient_actor_id)
         DO NOTHING`,
      ).run(claimId, input.roomId, row.boundaryId, row.sourceRevision, kind, ordinal,
        row.dueAt, row.holderKind, row.holderActorId, row.holderActorId, nowIso);
      if (inserted.changes === 1) claims.push(Object.freeze({ claimId, roomId: input.roomId,
        boundaryId: row.boundaryId, sourceRevision: row.sourceRevision, reminderKind: kind,
        reminderOrdinal: ordinal, recipientActorId: row.holderActorId,
        holderKind: row.holderKind, claimedAt: nowIso }));
    }
    database.exec("COMMIT");
    return Object.freeze(claims);
  } catch (error: unknown) {
    try { database.exec("ROLLBACK"); } catch { /* preserve original */ }
    if (error instanceof ProjectLoopAuthorityError) throw error;
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project due claim failed");
  }
}

/** Advances business timers while the caller owns the AuthorityWorker transaction. */
export function advanceProjectLoopTimedTransitionsInTransaction(database: DatabaseSync, input: {
  now: string; limit: number;
}): Readonly<{ reopenedReviews: number; expiredTransfers: number }> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256 ||
      !Number.isFinite(Date.parse(input.now)) || new Date(Date.parse(input.now)).toISOString() !== input.now) {
    throw new TypeError("Project timed transition scan is invalid");
  }
  let reopenedReviews = 0;
  let expiredTransfers = 0;
  const transferSubjectRevisionAvailable = database.prepare(
    `SELECT 1 FROM pragma_table_info('project_transfer_proposals')
     WHERE name = 'subject_revision'`,
  ).get() !== undefined;
  const reviews = database.prepare(
    `SELECT obstacle.id, obstacle.room_id AS roomId, obstacle.kind,
            obstacle.revision, obstacle.owner_kind AS ownerKind,
            obstacle.owner_actor_id AS ownerActorId
     FROM project_obstacles AS obstacle
     JOIN rooms AS room ON room.id = obstacle.room_id
     WHERE obstacle.status = 'deferred' AND obstacle.review_at IS NOT NULL
       AND obstacle.review_at <= ? AND room.status = 'active'
     ORDER BY obstacle.review_at, obstacle.room_id, obstacle.id LIMIT ?`,
  ).all(input.now, input.limit);
  for (const row of reviews) {
    if (typeof row.id !== "string" || typeof row.roomId !== "string" ||
        (row.kind !== "blocker" && row.kind !== "open_question") ||
        typeof row.revision !== "number" ||
        (row.ownerKind !== "human" && row.ownerKind !== "agent") ||
        typeof row.ownerActorId !== "string") {
      throw new ProjectLoopAuthorityError("storage_unavailable", "Project review timer row is corrupt");
    }
    const fact = readFact(database, row.kind, row.id, row.roomId);
    const changed = database.prepare(
      `UPDATE project_obstacles SET status = 'open', review_at = NULL,
         status_reason = NULL, revision = revision + 1, updated_at = ?
       WHERE id = ? AND room_id = ? AND revision = ? AND status = 'deferred'`,
    ).run(input.now, row.id, row.roomId, row.revision);
    if (changed.changes !== 1) continue;
    const reboundTransfers = transferSubjectRevisionAvailable ? database.prepare(
      `SELECT id, revision, principal_human_actor_id AS principalActorId,
              expires_at AS expiresAt
       FROM project_transfer_proposals
       WHERE room_id = ? AND subject_kind = ? AND subject_id = ?
         AND subject_revision = ? AND status = 'pending'
       ORDER BY id`,
    ).all(row.roomId, row.kind, row.id, row.revision) : [];
    for (const transfer of reboundTransfers) {
      if (typeof transfer.id !== "string" || typeof transfer.revision !== "number" ||
          typeof transfer.principalActorId !== "string" ||
          (transfer.expiresAt !== null && typeof transfer.expiresAt !== "string")) {
        throw new ProjectLoopAuthorityError("storage_unavailable",
          "Project review transfer row is corrupt");
      }
      const rebound = database.prepare(
        `UPDATE project_transfer_proposals
         SET subject_revision = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND room_id = ? AND revision = ? AND status = 'pending'
           AND subject_kind = ? AND subject_id = ? AND subject_revision = ?`,
      ).run(row.revision + 1, input.now, transfer.id, row.roomId, transfer.revision,
        row.kind, row.id, row.revision);
      if (rebound.changes !== 1) {
        throw new ProjectLoopAuthorityError("revision_conflict",
          "Project review transfer changed concurrently");
      }
      releaseTransferBoundary(database, row.roomId, transfer.id, input.now);
      refreshTransferBoundary(database, { roomId: row.roomId, transferId: transfer.id,
        revision: transfer.revision + 1, holderActorId: transfer.principalActorId,
        reason: "transfer_acceptance", dueAt: input.now, now: input.now });
    }
    database.prepare(
      `UPDATE project_ball_boundaries SET status = 'superseded', released_at = ?
       WHERE room_id = ? AND source_kind = 'review' AND source_id = ?
         AND source_revision = ? AND status = 'active'`,
    ).run(input.now, row.roomId, row.id, row.revision);
    const updated = readFact(database, row.kind, row.id, row.roomId);
    refreshBallBoundary(database, updated, input.now);
    const current = state(database, row.roomId, input.now);
    let eventSeq = current.revision + 1;
    appendEvent(database, { roomId: row.roomId, eventSeq,
      eventType: "fact.transitioned", factKind: row.kind, factId: row.id,
      factRevision: updated.revision, actorKind: row.ownerKind, actorId: row.ownerActorId,
      source: fact.source, occurredAt: input.now,
      payload: Object.freeze({ transition: "review_due", reason: "Review boundary reached" }),
      transitionAuthority: "system_timer" });
    for (const transfer of reboundTransfers) {
      eventSeq += 1;
      appendEvent(database, { roomId: row.roomId, eventSeq,
        eventType: "fact.transitioned", factKind: row.kind, factId: row.id,
        factRevision: updated.revision, actorKind: row.ownerKind, actorId: row.ownerActorId,
        source: fact.source, occurredAt: input.now, publicEntity: "transfer",
        publicEntityId: String(transfer.id), publicEntityRevision: Number(transfer.revision) + 1,
        payload: Object.freeze({ transition: "review_due_transfer_rebound",
          transferProposalId: String(transfer.id), transferRevision: Number(transfer.revision) + 1 }),
        transitionAuthority: "system_timer" });
    }
    writeProjectLoopCheckpointInTransaction(database, { roomId: row.roomId,
      projectRevision: eventSeq, occurredAt: input.now });
    reopenedReviews += 1;
  }
  const remaining = input.limit - reopenedReviews;
  if (remaining > 0) {
    const currentTransferSubject = transferSubjectRevisionAvailable ? `
         AND (
           (proposal.subject_kind = 'next_action' AND EXISTS (
             SELECT 1 FROM project_next_actions AS action
             WHERE action.room_id = proposal.room_id AND action.id = proposal.subject_id
               AND action.revision = proposal.subject_revision
               AND action.status IN ('proposed','accepted','in_progress','delivered')
           ))
           OR (proposal.subject_kind IN ('blocker','open_question') AND EXISTS (
             SELECT 1 FROM project_obstacles AS obstacle
             WHERE obstacle.room_id = proposal.room_id AND obstacle.id = proposal.subject_id
               AND obstacle.kind = proposal.subject_kind
               AND obstacle.revision = proposal.subject_revision
               AND obstacle.status IN ('open','deferred','cannot_answer')
           ))
         )` : "";
    const transfers = database.prepare(
      `SELECT proposal.id, proposal.room_id AS roomId, proposal.revision,
              proposal.subject_kind AS subjectKind, proposal.subject_id AS subjectId,
              proposal.principal_human_actor_id AS principalActorId
       FROM project_transfer_proposals AS proposal
       JOIN rooms AS room ON room.id = proposal.room_id
       WHERE proposal.status = 'pending' AND proposal.expires_at IS NOT NULL
         AND proposal.expires_at <= ? AND room.status = 'active'
         ${currentTransferSubject}
       ORDER BY proposal.expires_at, proposal.room_id, proposal.id LIMIT ?`,
    ).all(input.now, remaining);
    for (const row of transfers) {
      if (typeof row.id !== "string" || typeof row.roomId !== "string" ||
          typeof row.revision !== "number" ||
          (row.subjectKind !== "next_action" && row.subjectKind !== "blocker" &&
            row.subjectKind !== "open_question") || typeof row.subjectId !== "string" ||
          typeof row.principalActorId !== "string") {
        throw new ProjectLoopAuthorityError("storage_unavailable", "Project transfer timer row is corrupt");
      }
      const fact = readFact(database, row.subjectKind, row.subjectId, row.roomId);
      const escalationHolder = transferEscalationHolder(fact);
      const changed = database.prepare(
        `UPDATE project_transfer_proposals SET status = 'expired', revision = revision + 1,
           updated_at = ?, resolved_by_human_actor_id = NULL, resolved_at = ?,
           resolution_reason = 'Transfer proposal expired'
         WHERE id = ? AND room_id = ? AND revision = ? AND status = 'pending'`,
      ).run(input.now, input.now, row.id, row.roomId, row.revision);
      if (changed.changes !== 1) continue;
      releaseTransferBoundary(database, row.roomId, row.id, input.now);
      refreshTransferBoundary(database, { roomId: row.roomId, transferId: row.id,
        revision: row.revision + 1, holderActorId: escalationHolder,
        reason: "escalation", dueAt: input.now, now: input.now });
      const current = state(database, row.roomId, input.now);
      appendEvent(database, { roomId: row.roomId, eventSeq: current.revision + 1,
        eventType: "fact.transitioned", factKind: row.subjectKind, factId: row.subjectId,
        factRevision: fact.revision, actorKind: "human", actorId: row.principalActorId,
        source: fact.source, occurredAt: input.now,
        publicEntity: "transfer", publicEntityId: row.id,
        publicEntityRevision: row.revision + 1,
        payload: Object.freeze({ transferProposalId: row.id,
          transferRevision: row.revision + 1, transition: "transfer_expired" }),
        transitionAuthority: "system_timer" });
      writeProjectLoopCheckpointInTransaction(database, { roomId: row.roomId,
        projectRevision: current.revision + 1, occurredAt: input.now });
      expiredTransfers += 1;
    }
  }
  return Object.freeze({ reopenedReviews, expiredTransfers });
}

function replay(database: DatabaseSync, operation: Exclude<ProjectLoopAuthorityOperation,
  { type: "project-loop.snapshot.read" }>): ProjectLoopAuthorityResult | undefined {
  const identity = commandIdentity(operation.context);
  const row = database.prepare(
    `SELECT request_sha256 AS requestSha256, response_json AS responseJson
     FROM project_command_receipts WHERE actor_id = ? AND idempotency_key = ?`,
  ).get(identity.actorId, identity.idempotencyKey);
  if (row === undefined) return undefined;
  if (row.requestSha256 !== requestHash(operation) || typeof row.responseJson !== "string") {
    throw new ProjectLoopAuthorityError("idempotency_conflict", "Project idempotency key was reused");
  }
  const parsed = parseObject(row.responseJson) as unknown as ProjectLoopAuthorityResult;
  if (parsed.kind !== "project-loop-mutation") throw new ProjectLoopAuthorityError("storage_unavailable", "Project receipt is corrupt");
  return Object.freeze({ ...parsed, replayed: true });
}

function mutate(database: DatabaseSync, operation: Exclude<ProjectLoopAuthorityOperation,
  { type: "project-loop.snapshot.read" }>): ProjectLoopAuthorityResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("PRAGMA defer_foreign_keys = ON");
    const prior = replay(database, operation);
    if (prior !== undefined) { database.exec("COMMIT"); return prior; }
    const result = operation.type === "project-loop.proposal.create"
      ? createProposal(database, operation)
      : operation.type === "project-loop.proposal.resolve"
        ? resolveProposal(database, operation)
        : transitionFact(database, operation);
    if (result.kind !== "project-loop-mutation") {
      throw new ProjectLoopAuthorityError("storage_unavailable", "Project mutation returned a snapshot");
    }
    const identity = commandIdentity(operation.context);
    const roomId = operation.command.roomId;
    const checkpoint = writeProjectLoopCheckpointInTransaction(database, { roomId,
      projectRevision: result.acceptedRevision, occurredAt: iso(operation.now) });
    if (operation.type === "project-loop.proposal.resolve" &&
        operation.command.resolution === "confirmed") {
      const proposer = database.prepare(
        `SELECT proposed_by_kind AS kind, proposed_by_actor_id AS actorId
         FROM project_fact_proposals WHERE id = ? AND room_id = ?`,
      ).get(operation.command.proposalId, roomId);
      const preferredAgentId = proposer?.kind === "agent" && typeof proposer.actorId === "string"
        ? proposer.actorId : "";
      const checkpointAgent = database.prepare(
        `SELECT assignment.agent_actor_id AS actorId
         FROM room_agent_assignments AS assignment
         JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
           AND profile.actor_id = assignment.agent_actor_id
           AND profile.status = 'enabled'
         JOIN room_memberships AS membership ON membership.room_id = assignment.room_id
           AND membership.actor_id = assignment.agent_actor_id
           AND membership.kind = 'agent' AND membership.participation = 'active'
         WHERE assignment.room_id = ? AND assignment.status = 'current'
           AND assignment.participation = 'active' AND assignment.paused = 0
           AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
             WHERE value = 'room.project.read')
           AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
             WHERE value = 'room.respond')
         ORDER BY CASE WHEN assignment.agent_actor_id = ? THEN 0 ELSE 1 END,
                  assignment.agent_actor_id LIMIT 1`,
      ).get(roomId, preferredAgentId);
      if (typeof checkpointAgent?.actorId === "string") {
        createConfirmedCheckpointBoundary(database, {
          roomId,
          checkpointId: checkpoint.checkpointId,
          projectRevision: result.acceptedRevision,
          agentActorId: checkpointAgent.actorId,
          now: iso(operation.now),
        });
      }
    }
    database.prepare(
      `INSERT INTO project_command_receipts (
         actor_id, idempotency_key, room_id, request_sha256, response_json, committed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(identity.actorId, identity.idempotencyKey, roomId, requestHash(operation),
      JSON.stringify(result), iso(operation.now));
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the authority failure */ }
    if (error instanceof ProjectLoopAuthorityError) throw error;
    const message = error instanceof Error ? error.message : "unknown";
    if (/UNIQUE constraint failed: project_goals\.room_id/.test(message)) {
      throw new ProjectLoopAuthorityError("revision_conflict", "An active primary Goal already exists");
    }
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project authority transaction failed");
  }
}

export function executeProjectLoopAuthorityOperation(
  database: DatabaseSync,
  operation: ProjectLoopAuthorityOperation,
): ProjectLoopAuthorityResult {
  if (!isProjectLoopAuthorityOperation(operation)) {
    throw new ProjectLoopAuthorityError("invalid_request", "Project authority operation is invalid");
  }
  if (operation.type === "project-loop.snapshot.read") {
    const actorId = operation.context.principal.actorId;
    requireRoomAccess(database, operation.roomId, actorId, false);
    const stream = database.prepare(
      `SELECT head_seq AS headSeq FROM streams WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(operation.roomId);
    if (typeof stream?.headSeq !== "number") {
      throw new ProjectLoopAuthorityError("storage_unavailable", "Project Room stream is unavailable");
    }
    const events = readCanonicalProjectEventsDatabaseQuery(database, { roomId: operation.roomId,
      afterStreamSeq: operation.afterEventSeq, limit: operation.limit });
    return Object.freeze({ kind: "project-loop-snapshot", snapshot:
      readCanonicalProjectSnapshotDatabaseQuery(database, { roomId: operation.roomId,
        projectId: operation.projectId, watermark: stream.headSeq, capturedAt: iso(operation.now) }),
      events, nextEventSeq: events.at(-1)?.streamSeq ?? operation.afterEventSeq });
  }
  return mutate(database, operation);
}
