import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import { useAuthorityTransactionDatabase } from
  "../persistence/authority-transaction-database.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TITLE_UTF8_LIMIT = 512;
const DESCRIPTION_UTF8_LIMIT = 8_192;

export type HumanRequestAcceptanceMode = "next_action" | "open_question" | "blocker";

type FrozenHumanOwner = Readonly<{ kind: "human"; actorId: string }>;
type FrozenCriterion = Readonly<{ criterionId: string; text: string }>;

export type HumanRequestFrozenResponsibility =
  | Readonly<{
      kind: "next_action";
      responsibilityId: string;
      title: string;
      description: string;
      owner: FrozenHumanOwner;
      dueAt: string | null;
      deliverable: string;
      acceptanceCriteria: readonly FrozenCriterion[];
      verifier: FrozenHumanOwner | null;
    }>
  | Readonly<{
      kind: "blocker";
      responsibilityId: string;
      title: string;
      description: string;
      owner: FrozenHumanOwner;
      impact: string;
      resolutionCriteria: string;
      dueAt: string | null;
      reviewAt: string | null;
    }>
  | Readonly<{
      kind: "open_question";
      responsibilityId: string;
      title: string;
      description: string;
      owner: FrozenHumanOwner;
      impact: string;
      question: string;
      dueAt: string | null;
      reviewAt: string | null;
    }>;

/**
 * FT-03's frozen MentionTarget deliberately carries no project payload. The
 * payload used by FT-09 therefore comes from an explicit server-private
 * companion policy. It has no message-body or trusted-actor fields.
 */
export type HumanRequestCompanionPayload = Readonly<{
  title: string;
  description: string;
  acceptanceMode: HumanRequestAcceptanceMode;
  frozenResponsibility: HumanRequestFrozenResponsibility;
  frozenResponsibilityJson: string;
  frozenResponsibilitySha256: string;
}>;

export type HumanRequestMessageBinding = Readonly<{
  roomId: string;
  projectId: string;
  requestIntentId: string;
  sourceMessageId: string;
  sourceRevision: number;
  requesterHumanActorId: string;
  targetHumanActorId: string;
  sourceTargetId: string;
  occurredAt: string;
}>;

export type HumanRequestMessageParticipantResult = Readonly<{
  status: "created" | "replayed";
  roomId: string;
  requestIntentId: string;
  requestId: string;
  eventId: string;
  boundaryId: string;
  projectRevision: number;
}>;

export type HumanRequestMessageRecallBinding = Readonly<{
  roomId: string;
  sourceMessageId: string;
  sourceRevision: number;
  recalledByHumanActorId: string;
  occurredAt: string;
}>;

export type HumanRequestMessageRecallResult = Readonly<{
  roomId: string;
  sourceMessageId: string;
  cancelledRequestIds: readonly string[];
  eventIds: readonly string[];
}>;

export interface HumanRequestMessageTransactionParticipant {
  createPendingInTransaction(
    transaction: AuthorityTransactionView,
    binding: HumanRequestMessageBinding,
  ): HumanRequestMessageParticipantResult;
  cancelPendingForRecallInTransaction(
    transaction: AuthorityTransactionView,
    binding: HumanRequestMessageRecallBinding,
  ): HumanRequestMessageRecallResult;
}

export type HumanRequestMessageParticipantErrorCode =
  | "invalid_binding"
  | "payload_unavailable"
  | "source_unavailable"
  | "binding_conflict"
  | "storage_unavailable";

export class HumanRequestMessageParticipantError extends Error {
  constructor(
    readonly code: HumanRequestMessageParticipantErrorCode,
    message: string,
  ) {
    super(message);
    Object.defineProperty(this, "name", { value: "HumanRequestMessageParticipantError" });
  }
}

type UnknownRecord = Record<PropertyKey, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) =>
    typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function boundedText(value: unknown, maxUtf8: number, allowEmpty: boolean): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) &&
    Buffer.byteLength(value, "utf8") <= maxUtf8;
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function humanOwner(value: unknown): value is FrozenHumanOwner {
  return record(value) && exact(value, ["kind", "actorId"]) && value.kind === "human" &&
    identifier(value.actorId);
}

function frozenResponsibility(value: unknown): value is HumanRequestFrozenResponsibility {
  if (!record(value) || !identifier(value.responsibilityId) ||
      !boundedText(value.title, TITLE_UTF8_LIMIT, false) ||
      !boundedText(value.description, DESCRIPTION_UTF8_LIMIT, true) || !humanOwner(value.owner) ||
      !nullableTimestamp(value.dueAt)) return false;
  if (value.kind === "next_action") {
    if (!exact(value, ["kind", "responsibilityId", "title", "description", "owner", "dueAt",
      "deliverable", "acceptanceCriteria", "verifier"]) ||
        !boundedText(value.deliverable, DESCRIPTION_UTF8_LIMIT, false) ||
        !Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length > 32 ||
        !(value.verifier === null || humanOwner(value.verifier))) return false;
    const criteria = new Set<string>();
    return value.acceptanceCriteria.every((criterion) => {
      if (!record(criterion) || !exact(criterion, ["criterionId", "text"]) ||
          !identifier(criterion.criterionId) ||
          !boundedText(criterion.text, DESCRIPTION_UTF8_LIMIT, false) ||
          criteria.has(criterion.criterionId)) return false;
      criteria.add(criterion.criterionId);
      return true;
    });
  }
  if (value.kind === "blocker") {
    return exact(value, ["kind", "responsibilityId", "title", "description", "owner", "impact",
      "resolutionCriteria", "dueAt", "reviewAt"]) &&
      boundedText(value.impact, DESCRIPTION_UTF8_LIMIT, false) &&
      boundedText(value.resolutionCriteria, DESCRIPTION_UTF8_LIMIT, false) &&
      nullableTimestamp(value.reviewAt);
  }
  return value.kind === "open_question" && exact(value, [
    "kind", "responsibilityId", "title", "description", "owner", "impact", "question",
    "dueAt", "reviewAt",
  ]) && boundedText(value.impact, DESCRIPTION_UTF8_LIMIT, false) &&
    boundedText(value.question, DESCRIPTION_UTF8_LIMIT, false) && nullableTimestamp(value.reviewAt);
}

export function isHumanRequestCompanionPayload(
  value: unknown,
): value is HumanRequestCompanionPayload {
  if (!record(value) || !exact(value, [
    "title", "description", "acceptanceMode", "frozenResponsibility",
    "frozenResponsibilityJson", "frozenResponsibilitySha256",
  ])) return false;
  if (!boundedText(value.title, TITLE_UTF8_LIMIT, false) ||
    !boundedText(value.description, DESCRIPTION_UTF8_LIMIT, true) ||
    !(value.acceptanceMode === "next_action" || value.acceptanceMode === "open_question" ||
      value.acceptanceMode === "blocker") || !frozenResponsibility(value.frozenResponsibility) ||
    value.frozenResponsibility.kind !== value.acceptanceMode ||
    typeof value.frozenResponsibilityJson !== "string" ||
    !/^[a-f0-9]{64}$/u.test(String(value.frozenResponsibilitySha256))) return false;
  const expectedJson = canonical(value.frozenResponsibility);
  return value.frozenResponsibilityJson === expectedJson &&
    value.frozenResponsibilitySha256 === createHash("sha256").update(expectedJson).digest("hex");
}

export function isHumanRequestMessageBinding(value: unknown): value is HumanRequestMessageBinding {
  return record(value) && exact(value, [
    "roomId", "projectId", "requestIntentId", "sourceMessageId", "sourceRevision",
    "requesterHumanActorId", "targetHumanActorId", "sourceTargetId", "occurredAt",
  ]) && identifier(value.roomId) && value.projectId === value.roomId &&
    identifier(value.requestIntentId) && identifier(value.sourceMessageId) &&
    Number.isSafeInteger(value.sourceRevision) && Number(value.sourceRevision) > 0 &&
    identifier(value.requesterHumanActorId) && identifier(value.targetHumanActorId) &&
    identifier(value.sourceTargetId) && timestamp(value.occurredAt);
}

function isHumanRequestMessageRecallBinding(
  value: unknown,
): value is HumanRequestMessageRecallBinding {
  return record(value) && exact(value, [
    "roomId", "sourceMessageId", "sourceRevision", "recalledByHumanActorId", "occurredAt",
  ]) && identifier(value.roomId) && identifier(value.sourceMessageId) &&
    Number.isSafeInteger(value.sourceRevision) && Number(value.sourceRevision) > 0 &&
    identifier(value.recalledByHumanActorId) && timestamp(value.occurredAt);
}

function stableBase64Url(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url");
}

function stableHex(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function projectEventId(roomId: string, eventSeq: number): string {
  return `project-event-${createHash("sha256")
    .update(`dao.project-event.v1\0${roomId}\0${eventSeq}`).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Canonical JSON rejects unsupported values");
}

function requireCurrentSource(database: DatabaseSync, binding: HumanRequestMessageBinding): void {
  const row = database.prepare(
    `SELECT envelope.lifecycle, envelope.message_kind AS messageKind,
            message.author_id AS authorId, actor.kind AS authorKind,
            intent.room_id AS intentRoomId, intent.source_message_id AS intentMessageId,
            intent.target_id AS targetId, intent.source_revision AS sourceRevision,
            intent.requester_human_actor_id AS requesterActorId,
            intent.target_human_actor_id AS targetActorId, intent.status AS intentStatus,
            target.kind AS targetKind
     FROM human_request_intents AS intent
     JOIN message_envelopes AS envelope
       ON envelope.message_id = intent.source_message_id AND envelope.room_id = intent.room_id
     JOIN messages AS message ON message.id = envelope.message_id
     JOIN actors AS actor ON actor.id = message.author_id
     JOIN actors AS target ON target.id = intent.target_human_actor_id
     WHERE intent.id = ?`,
  ).get(binding.requestIntentId);
  if (row === undefined || row.lifecycle !== "active" || row.messageKind !== "human" ||
      row.authorKind !== "human" || row.targetKind !== "human" || row.intentStatus !== "pending" ||
      row.intentRoomId !== binding.roomId || row.intentMessageId !== binding.sourceMessageId ||
      row.targetId !== binding.sourceTargetId || row.sourceRevision !== binding.sourceRevision ||
      row.requesterActorId !== binding.requesterHumanActorId ||
      row.targetActorId !== binding.targetHumanActorId ||
      row.authorId !== binding.requesterHumanActorId) {
    throw new HumanRequestMessageParticipantError(
      "source_unavailable",
      "Human Request source intent is not a current active Human message binding",
    );
  }
}

interface RequestReplayRow {
  readonly id: unknown;
  readonly roomId: unknown;
  readonly sourceId: unknown;
  readonly sourceRevision: unknown;
  readonly requesterActorId: unknown;
  readonly targetActorId: unknown;
  readonly status: unknown;
  readonly title: unknown;
  readonly description: unknown;
  readonly requestKind: unknown;
  readonly sourceIntentId: unknown;
  readonly sourceTargetId: unknown;
  readonly frozenResponsibilityJson: unknown;
  readonly frozenResponsibilitySha256: unknown;
  readonly eventId: unknown;
  readonly eventSeq: unknown;
  readonly boundaryId: unknown;
}

function replayResult(
  database: DatabaseSync,
  binding: HumanRequestMessageBinding,
  requestId: string,
  payload: HumanRequestCompanionPayload,
): HumanRequestMessageParticipantResult | undefined {
  const row = database.prepare(
    `SELECT request.id, request.room_id AS roomId, request.source_id AS sourceId,
            request.source_revision AS sourceRevision,
            request.requester_human_actor_id AS requesterActorId,
            request.target_human_actor_id AS targetActorId, request.status,
            request.title, request.description, request.request_kind AS requestKind,
            request.source_request_intent_id AS sourceIntentId,
            request.source_target_id AS sourceTargetId,
            request.frozen_responsibility_json AS frozenResponsibilityJson,
            request.frozen_responsibility_sha256 AS frozenResponsibilitySha256,
            event.event_id AS eventId, event.event_seq AS eventSeq,
            boundary.boundary_id AS boundaryId
     FROM project_requests AS request
     LEFT JOIN project_events AS event
       ON event.room_id = request.room_id AND event.fact_kind = 'request'
      AND event.fact_id = request.id AND event.fact_revision = 1
      AND event.event_type = 'fact.created'
     LEFT JOIN project_ball_boundaries AS boundary
       ON boundary.room_id = request.room_id AND boundary.source_kind = 'request'
      AND boundary.source_id = request.id AND boundary.source_revision = 1
     WHERE request.room_id = ? AND request.source_request_intent_id = ?`,
  ).get(binding.roomId, binding.requestIntentId) as RequestReplayRow | undefined;
  if (row === undefined) return undefined;
  const frozenJson = canonical(payload.frozenResponsibility);
  const frozenSha256 = createHash("sha256").update(frozenJson).digest("hex");
  if (row.id !== requestId || row.roomId !== binding.roomId ||
      row.sourceId !== binding.sourceMessageId || row.sourceRevision !== binding.sourceRevision ||
      row.requesterActorId !== binding.requesterHumanActorId ||
      row.targetActorId !== binding.targetHumanActorId || row.status !== "pending_acceptance" ||
      row.title !== payload.title || row.description !== payload.description ||
      row.requestKind !== payload.acceptanceMode || row.sourceIntentId !== binding.requestIntentId ||
      row.sourceTargetId !== binding.sourceTargetId || row.frozenResponsibilityJson !== frozenJson ||
      row.frozenResponsibilitySha256 !== frozenSha256 || typeof row.eventId !== "string" ||
      typeof row.eventSeq !== "number" || typeof row.boundaryId !== "string") {
    throw new HumanRequestMessageParticipantError(
      "binding_conflict",
      "Human Request intent is already bound to a different canonical Request",
    );
  }
  return Object.freeze({
    status: "replayed",
    roomId: binding.roomId,
    requestIntentId: binding.requestIntentId,
    requestId,
    eventId: row.eventId,
    boundaryId: row.boundaryId,
    projectRevision: row.eventSeq,
  });
}

export function createSqliteHumanRequestMessageParticipant(options: Readonly<{
  resolveCompanionPayload(binding: HumanRequestMessageBinding): unknown;
  writeCheckpointInTransaction(
    database: DatabaseSync,
    roomId: string,
    projectRevision: number,
    occurredAt: string,
  ): void;
}>): HumanRequestMessageTransactionParticipant {
  if (typeof options.resolveCompanionPayload !== "function" ||
      typeof options.writeCheckpointInTransaction !== "function") {
    throw new TypeError("Human Request message participant composition is invalid");
  }
  return Object.freeze({
    createPendingInTransaction(
      transaction: AuthorityTransactionView,
      binding: HumanRequestMessageBinding,
    ): HumanRequestMessageParticipantResult {
      if (!isHumanRequestMessageBinding(binding) || transaction.roomId !== binding.roomId) {
        throw new HumanRequestMessageParticipantError(
          "invalid_binding",
          "Human Request message transaction binding is invalid",
        );
      }
      const candidate = options.resolveCompanionPayload(Object.freeze({ ...binding }));
      if (!isHumanRequestCompanionPayload(candidate)) {
        throw new HumanRequestMessageParticipantError(
          "payload_unavailable",
          "Explicit Human Request companion payload is unavailable",
        );
      }
      const payload = Object.freeze({ ...candidate });
      if (payload.frozenResponsibility.owner.actorId !== binding.targetHumanActorId) {
        throw new HumanRequestMessageParticipantError(
          "invalid_binding",
          "Frozen Human Request responsibility is not bound to the exact target and intent",
        );
      }
      return useAuthorityTransactionDatabase(transaction, (database) => {
        requireCurrentSource(database, binding);
        const requestId = stableBase64Url("project-request-from-message", binding.requestIntentId);
        const replay = replayResult(database, binding, requestId, payload);
        if (replay !== undefined) return replay;
        database.prepare(
          `INSERT INTO project_room_states (
             room_id, project_id, revision, event_head_seq, updated_at
           ) VALUES (?, ?, 0, 0, ?) ON CONFLICT(room_id) DO NOTHING`,
        ).run(binding.roomId, binding.projectId, binding.occurredAt);
        const state = database.prepare(
          `SELECT state.revision, state.event_head_seq AS eventHeadSeq,
                  room.archive_generation AS lifecycleGeneration
           FROM project_room_states AS state JOIN rooms AS room ON room.id = state.room_id
           WHERE state.room_id = ?`,
        ).get(binding.roomId);
        if (typeof state?.revision !== "number" || typeof state.eventHeadSeq !== "number" ||
            typeof state.lifecycleGeneration !== "number" ||
            state.revision !== state.eventHeadSeq || state.revision < 0) {
          throw new HumanRequestMessageParticipantError(
            "storage_unavailable",
            "Project authority revision state is corrupt",
          );
        }
        const projectRevision = state.revision + 1;
        const eventId = projectEventId(binding.roomId, projectRevision);
        const boundaryId = `project-ball-${stableHex(
          binding.roomId,
          "request",
          requestId,
          "1",
          String(state.lifecycleGeneration),
          "human",
          binding.requesterHumanActorId,
        )}`;
        const eventPayload = Object.freeze({
          acceptanceMode: payload.acceptanceMode,
          description: payload.description,
          sourceRequestIntentId: binding.requestIntentId,
          sourceTargetId: binding.sourceTargetId,
          targetHumanActorId: binding.targetHumanActorId,
          title: payload.title,
          responsibility: payload.frozenResponsibility,
        });
        const payloadJson = canonical(eventPayload);
        const frozenResponsibilityJson = payload.frozenResponsibilityJson;
        const frozenResponsibilitySha256 = payload.frozenResponsibilitySha256;
        database.prepare(
          `INSERT INTO project_requests (
             id, room_id, source_room_id, source_id, revision,
             requester_human_actor_id, target_human_actor_id, status,
             title, description, request_kind, linked_fact_kind, linked_fact_id,
             source_kind, created_by_actor_id, created_at, updated_at,
             source_revision, visibility_room_id, source_request_intent_id, source_target_id,
             frozen_responsibility_json, frozen_responsibility_sha256
           ) VALUES (?, ?, ?, ?, 1, ?, ?, 'pending_acceptance', ?, ?, ?, NULL, NULL,
                     'message', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          requestId, binding.roomId, binding.roomId, binding.sourceMessageId,
          binding.requesterHumanActorId, binding.targetHumanActorId,
          payload.title, payload.description, payload.acceptanceMode,
          binding.requesterHumanActorId, binding.occurredAt, binding.occurredAt,
          binding.sourceRevision, binding.roomId, binding.requestIntentId, binding.sourceTargetId,
          frozenResponsibilityJson, frozenResponsibilitySha256,
        );
        database.prepare(
          `INSERT INTO project_events (
             event_id, room_id, project_id, event_seq, event_type, fact_kind, fact_id,
             fact_revision, actor_kind, actor_id, source_room_id, source_id, source_kind,
             source_revision, source_visibility, occurred_at, payload_json
           ) VALUES (?, ?, ?, ?, 'fact.created', 'request', ?, 1, 'human', ?, ?, ?,
                     'message', ?, 'room', ?, ?)`,
        ).run(
          eventId, binding.roomId, binding.projectId, projectRevision, requestId,
          binding.requesterHumanActorId, binding.roomId, binding.sourceMessageId,
          binding.sourceRevision, binding.occurredAt, payloadJson,
        );
        const sharedStream = database.prepare(
          `SELECT head_seq AS headSeq FROM streams
           WHERE stream_kind = 'room' AND stream_id = ?`,
        ).get(binding.roomId);
        if (typeof sharedStream?.headSeq !== "number" || sharedStream.headSeq < 0) {
          throw new HumanRequestMessageParticipantError(
            "storage_unavailable",
            "Shared Room stream is unavailable for the Project Request event",
          );
        }
        const sharedStreamSeq = sharedStream.headSeq + 1;
        const sharedRequestProjection = Object.freeze({
          recordVersion: "project-loop.v1" as const,
          roomId: binding.roomId,
          projectId: binding.projectId,
          revision: 1,
          provenance: Object.freeze({
            source: Object.freeze({
              kind: "message" as const,
              sourceId: binding.sourceMessageId,
              sourceRevision: binding.sourceRevision,
              roomId: binding.roomId,
              visibility: "room" as const,
            }),
            proposedBy: Object.freeze({
              actorId: binding.requesterHumanActorId,
              kind: "human" as const,
            }),
          }),
          createdAt: binding.occurredAt,
          updatedAt: binding.occurredAt,
          kind: "request" as const,
          requestId,
          title: payload.title,
          description: payload.description,
          requester: Object.freeze({
            actorId: binding.requesterHumanActorId,
            kind: "human" as const,
          }),
          target: Object.freeze({
            actorId: binding.targetHumanActorId,
            kind: "human" as const,
          }),
          acceptanceMode: payload.acceptanceMode,
          status: "pending_acceptance" as const,
          resolutionActor: null,
          resolvedAt: null,
          responsibilityLink: null,
          transferChain: Object.freeze([]),
        });
        database.prepare(
          `UPDATE streams SET head_seq = ?
           WHERE stream_kind = 'room' AND stream_id = ? AND head_seq = ?`,
        ).run(sharedStreamSeq, binding.roomId, sharedStream.headSeq);
        database.prepare(
          `INSERT INTO events (
             event_id, stream_kind, stream_id, stream_seq, room_id, actor_id,
             event_type, occurred_at, payload_json
           ) VALUES (?, 'room', ?, ?, ?, ?, 'project.request.changed', ?, ?)`,
        ).run(
          eventId, binding.roomId, sharedStreamSeq, binding.roomId,
          binding.requesterHumanActorId, binding.occurredAt, canonical(sharedRequestProjection),
        );
        database.prepare(
          `INSERT INTO outbox_deliveries (
             id, event_id, target_kind, target_id, stream_seq, status,
             attempts, available_at, delivered_at, last_error
           ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
        ).run(
          stableBase64Url("project-request-room-outbox", eventId, binding.roomId),
          eventId,
          binding.roomId,
          sharedStreamSeq,
          binding.occurredAt,
        );
        database.prepare(
          `INSERT INTO project_event_outbox (
             event_id, room_id, event_seq, status, attempts, available_at, dispatched_at
           ) VALUES (?, ?, ?, 'pending', 0, ?, NULL)`,
        ).run(eventId, binding.roomId, projectRevision, binding.occurredAt);
        database.prepare(
          `INSERT INTO project_transition_audit (
             audit_id, room_id, project_id, project_revision, event_id, operation,
             fact_kind, fact_id, actor_kind, actor_id, transition_json, occurred_at
           ) VALUES (?, ?, ?, ?, ?, 'fact.created', 'request', ?, 'human', ?, ?, ?)`,
        ).run(
          `audit:${eventId}`, binding.roomId, binding.projectId, projectRevision, eventId,
          requestId, binding.requesterHumanActorId, payloadJson, binding.occurredAt,
        );
        database.prepare(
          `INSERT INTO project_ball_boundaries (
             boundary_id, room_id, project_id, source_kind, source_id, source_revision,
             lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at, status, released_at
           ) VALUES (?, ?, ?, 'request', ?, 1, ?, 'human', ?, 'pending_acceptance', ?,
                     NULL, 'active', NULL)`,
        ).run(
          boundaryId, binding.roomId, binding.projectId, requestId, state.lifecycleGeneration,
          binding.requesterHumanActorId, binding.occurredAt,
        );
        const advanced = database.prepare(
          `UPDATE project_room_states
           SET revision = revision + 1, event_head_seq = event_head_seq + 1, updated_at = ?
           WHERE room_id = ? AND revision = ? AND event_head_seq = ?`,
        ).run(
          binding.occurredAt, binding.roomId, projectRevision - 1, projectRevision - 1,
        );
        if (advanced.changes !== 1) {
          throw new HumanRequestMessageParticipantError(
            "storage_unavailable",
            "Project authority revision compare-and-set failed",
          );
        }
        options.writeCheckpointInTransaction(
          database,
          binding.roomId,
          projectRevision,
          binding.occurredAt,
        );
        return Object.freeze({
          status: "created" as const,
          roomId: binding.roomId,
          requestIntentId: binding.requestIntentId,
          requestId,
          eventId,
          boundaryId,
          projectRevision,
        });
      });
    },
    cancelPendingForRecallInTransaction(
      transaction: AuthorityTransactionView,
      binding: HumanRequestMessageRecallBinding,
    ): HumanRequestMessageRecallResult {
      if (!isHumanRequestMessageRecallBinding(binding) || transaction.roomId !== binding.roomId) {
        throw new HumanRequestMessageParticipantError(
          "invalid_binding",
          "Human Request recall transaction binding is invalid",
        );
      }
      return useAuthorityTransactionDatabase(transaction, (database) => {
        const rows = database.prepare(
          `SELECT request.id, request.title, request.description,
                  request.request_kind AS requestKind,
                  request.requester_human_actor_id AS requesterActorId,
                  request.target_human_actor_id AS targetActorId,
                  request.source_request_intent_id AS requestIntentId,
                  request.source_target_id AS sourceTargetId,
                  request.created_at AS createdAt, request.revision,
                  request.source_revision AS sourceRevision
           FROM project_requests AS request
           JOIN human_request_intents AS intent
             ON intent.id = request.source_request_intent_id
           WHERE request.room_id = ? AND request.source_id = ?
             AND request.source_kind = 'message'
             AND request.status = 'pending_acceptance' AND intent.status = 'cancelled'
           ORDER BY request.id`,
        ).all(binding.roomId, binding.sourceMessageId);
        const cancelledRequestIds: string[] = [];
        const eventIds: string[] = [];
        for (const row of rows) {
          if (typeof row.id !== "string" || typeof row.title !== "string" ||
              typeof row.description !== "string" ||
              !(row.requestKind === "next_action" || row.requestKind === "open_question" ||
                row.requestKind === "blocker") || typeof row.requesterActorId !== "string" ||
              typeof row.targetActorId !== "string" || typeof row.requestIntentId !== "string" ||
              typeof row.sourceTargetId !== "string" || typeof row.createdAt !== "string" ||
              typeof row.revision !== "number" || row.revision < 1 ||
              typeof row.sourceRevision !== "number" || row.sourceRevision < 1) {
            throw new HumanRequestMessageParticipantError(
              "storage_unavailable",
              "Pending Project Request recall row is corrupt",
            );
          }
          const state = database.prepare(
            `SELECT revision, event_head_seq AS eventHeadSeq
             FROM project_room_states WHERE room_id = ?`,
          ).get(binding.roomId);
          if (typeof state?.revision !== "number" || state.eventHeadSeq !== state.revision) {
            throw new HumanRequestMessageParticipantError(
              "storage_unavailable",
              "Project authority revision state is corrupt during recall",
            );
          }
          const projectRevision = state.revision + 1;
          const eventId = projectEventId(binding.roomId, projectRevision);
          const requestRevision = row.revision + 1;
          const updated = database.prepare(
            `UPDATE project_requests
             SET status = 'cancelled', revision = revision + 1, updated_at = ?,
                 resolution_actor_kind = 'human', resolution_actor_id = ?, resolved_at = ?
             WHERE id = ? AND room_id = ? AND status = 'pending_acceptance' AND revision = ?`,
          ).run(binding.occurredAt, binding.recalledByHumanActorId, binding.occurredAt,
            row.id, binding.roomId, row.revision);
          if (updated.changes !== 1) {
            throw new HumanRequestMessageParticipantError(
              "binding_conflict",
              "Pending Project Request changed during source recall",
            );
          }
          database.prepare(
            `UPDATE project_ball_boundaries
             SET status = 'released', released_at = ?
             WHERE room_id = ? AND source_kind = 'request' AND source_id = ?
               AND status = 'active'`,
          ).run(binding.occurredAt, binding.roomId, row.id);
          const transitionPayload = canonical(Object.freeze({
            reason: "message_recalled",
            sourceRequestIntentId: row.requestIntentId,
          }));
          database.prepare(
            `INSERT INTO project_events (
               event_id, room_id, project_id, event_seq, event_type, fact_kind, fact_id,
               fact_revision, actor_kind, actor_id, source_room_id, source_id, source_kind,
               source_revision, source_visibility, occurred_at, payload_json
             ) VALUES (?, ?, ?, ?, 'fact.transitioned', 'request', ?, ?, 'human', ?, ?, ?,
                       'message', ?, 'room', ?, ?)`,
          ).run(eventId, binding.roomId, binding.roomId, projectRevision, row.id, requestRevision,
            binding.recalledByHumanActorId, binding.roomId, binding.sourceMessageId,
            row.sourceRevision, binding.occurredAt, transitionPayload);
          database.prepare(
            `INSERT INTO project_event_outbox (
               event_id, room_id, event_seq, status, attempts, available_at, dispatched_at
             ) VALUES (?, ?, ?, 'pending', 0, ?, NULL)`,
          ).run(eventId, binding.roomId, projectRevision, binding.occurredAt);
          database.prepare(
            `INSERT INTO project_transition_audit (
               audit_id, room_id, project_id, project_revision, event_id, operation,
               fact_kind, fact_id, actor_kind, actor_id, transition_json, occurred_at
             ) VALUES (?, ?, ?, ?, ?, 'fact.transitioned', 'request', ?, 'human', ?, ?, ?)`,
          ).run(`audit:${eventId}`, binding.roomId, binding.roomId, projectRevision, eventId,
            row.id, binding.recalledByHumanActorId, transitionPayload, binding.occurredAt);
          const advanced = database.prepare(
            `UPDATE project_room_states
             SET revision = revision + 1, event_head_seq = event_head_seq + 1, updated_at = ?
             WHERE room_id = ? AND revision = ? AND event_head_seq = ?`,
          ).run(binding.occurredAt, binding.roomId, projectRevision - 1, projectRevision - 1);
          if (advanced.changes !== 1) {
            throw new HumanRequestMessageParticipantError(
              "storage_unavailable",
              "Project authority revision compare-and-set failed during recall",
            );
          }
          const sharedStream = database.prepare(
            `SELECT head_seq AS headSeq FROM streams
             WHERE stream_kind = 'room' AND stream_id = ?`,
          ).get(binding.roomId);
          if (typeof sharedStream?.headSeq !== "number") {
            throw new HumanRequestMessageParticipantError(
              "storage_unavailable",
              "Shared Room stream is unavailable during Request recall",
            );
          }
          const sharedSeq = sharedStream.headSeq + 1;
          database.prepare(
            `UPDATE streams SET head_seq = ?
             WHERE stream_kind = 'room' AND stream_id = ? AND head_seq = ?`,
          ).run(sharedSeq, binding.roomId, sharedStream.headSeq);
          const transferRows = database.prepare(
            `SELECT from_owner_kind AS fromKind, from_owner_actor_id AS fromActorId,
                    to_owner_kind AS toKind, to_owner_actor_id AS toActorId,
                    accepted_by_human_actor_id AS initiatedByActorId,
                    reason, transferred_at AS transferredAt
             FROM project_transfer_chain
             WHERE room_id = ? AND subject_kind = 'request' AND subject_id = ?
             ORDER BY subject_revision, transfer_id`,
          ).all(binding.roomId, row.id);
          const transferChain = transferRows.map((transfer) => {
            if (transfer.fromKind !== "human" || typeof transfer.fromActorId !== "string" ||
                transfer.toKind !== "human" || typeof transfer.toActorId !== "string" ||
                typeof transfer.initiatedByActorId !== "string" ||
                typeof transfer.reason !== "string" || typeof transfer.transferredAt !== "string") {
              throw new HumanRequestMessageParticipantError(
                "storage_unavailable",
                "Project Request transfer history is corrupt during recall",
              );
            }
            return Object.freeze({
              from: Object.freeze({ actorId: transfer.fromActorId, kind: "human" }),
              to: Object.freeze({ actorId: transfer.toActorId, kind: "human" }),
              initiatedBy: Object.freeze({
                actorId: transfer.initiatedByActorId,
                kind: "human",
              }),
              reason: transfer.reason,
              transferredAt: transfer.transferredAt,
            });
          });
          const projection = Object.freeze({
            recordVersion: "project-loop.v1",
            roomId: binding.roomId,
            projectId: binding.roomId,
            revision: requestRevision,
            provenance: Object.freeze({
              source: Object.freeze({ kind: "message", sourceId: binding.sourceMessageId,
                sourceRevision: row.sourceRevision, roomId: binding.roomId, visibility: "room" }),
              proposedBy: Object.freeze({ actorId: row.requesterActorId, kind: "human" }),
            }),
            createdAt: row.createdAt,
            updatedAt: binding.occurredAt,
            kind: "request",
            requestId: row.id,
            title: row.title,
            description: row.description,
            requester: Object.freeze({ actorId: row.requesterActorId, kind: "human" }),
            target: Object.freeze({ actorId: row.targetActorId, kind: "human" }),
            acceptanceMode: row.requestKind,
            status: "cancelled",
            resolutionActor: Object.freeze({ actorId: binding.recalledByHumanActorId, kind: "human" }),
            resolvedAt: binding.occurredAt,
            responsibilityLink: null,
            transferChain: Object.freeze(transferChain),
          });
          database.prepare(
            `INSERT INTO events (
               event_id, stream_kind, stream_id, stream_seq, room_id, actor_id,
               event_type, occurred_at, payload_json
             ) VALUES (?, 'room', ?, ?, ?, ?, 'project.request.changed', ?, ?)`,
          ).run(eventId, binding.roomId, sharedSeq, binding.roomId,
            binding.recalledByHumanActorId, binding.occurredAt, canonical(projection));
          database.prepare(
            `INSERT INTO outbox_deliveries (
               id, event_id, target_kind, target_id, stream_seq, status,
               attempts, available_at, delivered_at, last_error
             ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
          ).run(stableBase64Url("project-request-room-outbox", eventId, binding.roomId),
            eventId, binding.roomId, sharedSeq, binding.occurredAt);
          options.writeCheckpointInTransaction(
            database, binding.roomId, projectRevision, binding.occurredAt,
          );
          cancelledRequestIds.push(row.id);
          eventIds.push(eventId);
        }
        return Object.freeze({
          roomId: binding.roomId,
          sourceMessageId: binding.sourceMessageId,
          cancelledRequestIds: Object.freeze(cancelledRequestIds),
          eventIds: Object.freeze(eventIds),
        });
      });
    },
  });
}
