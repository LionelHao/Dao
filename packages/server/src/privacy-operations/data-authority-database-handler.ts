import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AUTHORITY_SCHEMA_VERSION } from "../persistence/schema.js";
import type { DiagnosticEntry } from "./diagnostics.js";
import {
  isPrivacyDataAuthorityOperation,
  type PrivacyDataAuthorityOperation,
  type PrivacyDataAuthorityResult,
} from "./data-authority-protocol.js";
import type { RoomExportCategory, RoomExportJson } from "./room-export.js";

const TENANT_ID = "deployment-singleton" as const;

export class PrivacyDataAuthorityError extends Error {
  constructor(
    readonly code: "administrator_required" | "room_forbidden" | "storage_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PrivacyDataAuthorityError";
  }
}

function fail(
  code: PrivacyDataAuthorityError["code"],
  message: string,
): never {
  throw new PrivacyDataAuthorityError(code, message);
}

function canonicalNow(now: number): string {
  return new Date(now).toISOString();
}

function activeSession(
  database: DatabaseSync,
  actorId: string,
  sessionFamilyId: string,
  sessionId: string,
  now: number,
): Readonly<{ tenantAdministrator: boolean }> {
  const row = database.prepare(
    `SELECT CASE WHEN administrator.human_actor_id IS NULL
              THEN 0 ELSE 1 END AS tenantAdministrator
     FROM session_families AS family
     JOIN actors AS actor ON actor.id = family.actor_id AND actor.kind = 'human'
     LEFT JOIN tenant_administrators AS administrator
       ON administrator.human_actor_id = family.actor_id AND administrator.status = 'active'
     WHERE family.family_id = ? AND family.actor_id = ?
       AND family.revoked_at IS NULL AND family.refresh_expires_at > ?
       AND EXISTS (
         SELECT 1 FROM sessions AS session
         WHERE session.family_id = family.family_id AND session.actor_id = family.actor_id
           AND session.access_token_hash = ?
           AND session.revoked_at IS NULL AND session.access_expires_at > ?
       )`,
  ).get(sessionFamilyId, actorId, now, sessionId, now);
  if (row?.tenantAdministrator !== 0 && row?.tenantAdministrator !== 1) {
    return fail("room_forbidden", "Privacy operation requires a current authenticated session");
  }
  return { tenantAdministrator: row.tenantAdministrator === 1 };
}

type RoomBinding = Readonly<{
  lifecycle: "active" | "archived";
  accessRevision: number;
  watermark: number;
  retainedFromSeq: number;
}>;

function currentRoomBinding(
  database: DatabaseSync,
  input: Readonly<{
    actorId: string;
    sessionFamilyId: string;
    sessionId: string;
    roomId: string;
    now: number;
  }>,
): RoomBinding {
  activeSession(
    database,
    input.actorId,
    input.sessionFamilyId,
    input.sessionId,
    input.now,
  );
  const row = database.prepare(
    `SELECT room.status AS lifecycle, membership.role AS membershipRole,
            room.owner_actor_id AS ownerActorId,
            CASE WHEN access.access_revision IS NULL OR
                      membership.access_revision > access.access_revision
              THEN membership.access_revision ELSE access.access_revision END AS accessRevision,
            stream.head_seq AS watermark, stream.retained_from_seq AS retainedFromSeq
     FROM rooms AS room
     JOIN room_memberships AS membership
       ON membership.room_id = room.id AND membership.actor_id = ? AND membership.kind = 'human'
     JOIN streams AS stream ON stream.stream_kind = 'room' AND stream.stream_id = room.id
     LEFT JOIN room_access_authority AS access ON access.room_id = room.id
     WHERE room.id = ?`,
  ).get(input.actorId, input.roomId);
  if ((row?.lifecycle !== "active" && row?.lifecycle !== "archived") ||
      row.membershipRole !== "owner" || row.ownerActorId !== input.actorId ||
      !Number.isSafeInteger(row.accessRevision) || Number(row.accessRevision) < 0 ||
      !Number.isSafeInteger(row.watermark) || Number(row.watermark) < 0 ||
      !Number.isSafeInteger(row.retainedFromSeq) || Number(row.retainedFromSeq) < 1) {
    return fail("room_forbidden", "Room export requires current owner membership");
  }
  return {
    lifecycle: row.lifecycle,
    accessRevision: Number(row.accessRevision),
    watermark: Number(row.watermark),
    retainedFromSeq: Number(row.retainedFromSeq),
  };
}

function requireExpectedBinding(
  database: DatabaseSync,
  operation: Extract<PrivacyDataAuthorityOperation, {
    readonly type: "privacy.room-export.begin" | "privacy.room-export.reauthorize" |
      "privacy.room-export.read-page";
  }>,
): RoomBinding {
  if (operation.tenantId !== TENANT_ID) {
    return fail("room_forbidden", "Room export tenant binding changed");
  }
  const binding = currentRoomBinding(database, operation);
  if (operation.type !== "privacy.room-export.begin" &&
      Date.parse(operation.startedAt) > operation.now) {
    return fail("room_forbidden", "Room export snapshot time is outside current authority");
  }
  if (binding.accessRevision !== operation.accessRevision ||
      binding.lifecycle !== operation.lifecycle) {
    return fail("room_forbidden", "Room export authorization revision changed");
  }
  if (operation.type !== "privacy.room-export.begin" &&
      operation.watermark > binding.watermark) {
    return fail("room_forbidden", "Room export watermark is outside current authority");
  }
  if (binding.retainedFromSeq > 1) {
    return fail("storage_unavailable", "Full Room event projection is no longer retained");
  }
  return binding;
}

function diagnosticEntries(database: DatabaseSync, now: number): readonly DiagnosticEntry[] {
  const occurredAt = canonicalNow(now);
  const schema = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  if (schema?.version !== AUTHORITY_SCHEMA_VERSION) {
    return fail("storage_unavailable", "Diagnostics schema authority is unavailable");
  }
  const outbox = database.prepare(
    `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS deadLetter
     FROM outbox_deliveries`,
  ).get();
  const invalidations = database.prepare(
    `SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS deadLetter
     FROM room_cache_invalidation_intents`,
  ).get();
  const counts = [outbox?.pending, outbox?.deadLetter, invalidations?.pending, invalidations?.deadLetter]
    .map((value) => value === null ? 0 : value);
  if (counts.some((value) => !Number.isSafeInteger(value) || Number(value) < 0)) {
    return fail("storage_unavailable", "Diagnostics queue metrics are corrupt");
  }
  return Object.freeze([
    Object.freeze({
      category: "schema" as const,
      code: "authority_schema_current",
      occurredAt,
      state: "ready",
      metadata: Object.freeze({ schemaVersion: AUTHORITY_SCHEMA_VERSION }),
    }),
    Object.freeze({
      category: "outbox" as const,
      code: "authority_outbox_queue",
      occurredAt,
      queueDepth: Number(counts[0]),
      metadata: Object.freeze({ deadLetterCount: Number(counts[1]) }),
    }),
    Object.freeze({
      category: "cache" as const,
      code: "cache_invalidation_queue",
      occurredAt,
      queueDepth: Number(counts[2]),
      metadata: Object.freeze({ deadLetterCount: Number(counts[3]) }),
    }),
  ]);
}

function parseJson(value: unknown): RoomExportJson {
  if (typeof value !== "string") return fail("storage_unavailable", "Room event payload is corrupt");
  try {
    return JSON.parse(value) as RoomExportJson;
  } catch {
    return fail("storage_unavailable", "Room event payload is corrupt");
  }
}

const EXPORT_CATEGORY_ORDER = [
  "attachment_inventory",
  "execution_tool_review",
  "membership_governance_audit",
  "memory",
  "message",
  "message_revision",
  "project_fact",
  "recall_audit",
  "source_link",
] as const satisfies readonly RoomExportCategory[];

type ProjectionCursor = Readonly<{
  categoryOrder: number;
  entityId: string;
  revision: number;
}>;

type ProjectionCandidate = Readonly<{
  category: RoomExportCategory;
  categoryOrder: number;
  entityId: string;
  revision: number;
  payload: RoomExportJson;
}>;

const FORBIDDEN_PROJECTION_KEYS = new Set([
  "access_token", "api_key", "authorization", "credential", "credentials",
  "encryption_key", "header", "headers", "hidden_reasoning", "key_material", "password",
  "private_key", "provider_raw_request", "provider_raw_response", "provider_request",
  "provider_response", "refresh_token", "secret", "secrets", "secret_key", "session_token",
]);

function isForbiddenProjectionKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return FORBIDDEN_PROJECTION_KEYS.has(normalized);
}

function assertProjectionPayload(value: RoomExportJson): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertProjectionPayload(item);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenProjectionKey(key)) {
      return fail("storage_unavailable", "Room export projection contains forbidden security material");
    }
    assertProjectionPayload(nested);
  }
}

function decodeCursor(value: string | undefined): ProjectionCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(2), "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 3 ||
        !Number.isSafeInteger(decoded[0]) || Number(decoded[0]) < 0 ||
        Number(decoded[0]) >= EXPORT_CATEGORY_ORDER.length ||
        typeof decoded[1] !== "string" || decoded[1].length === 0 ||
        !Number.isSafeInteger(decoded[2]) || Number(decoded[2]) < 0) {
      return fail("room_forbidden", "Room export cursor is invalid");
    }
    return { categoryOrder: Number(decoded[0]), entityId: decoded[1], revision: Number(decoded[2]) };
  } catch (error) {
    if (error instanceof PrivacyDataAuthorityError) throw error;
    return fail("room_forbidden", "Room export cursor is invalid");
  }
}

function encodeCursor(candidate: ProjectionCandidate): string {
  return `c:${Buffer.from(JSON.stringify([
    candidate.categoryOrder,
    candidate.entityId,
    candidate.revision,
  ]), "utf8").toString("base64url")}`;
}

function compareBinaryText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CATEGORY_QUERIES: Readonly<Record<RoomExportCategory, string>> = Object.freeze({
  attachment_inventory: `
    WITH snapshot(roomId, watermark) AS (VALUES (?, ?))
    SELECT json_extract(bound.payload_json, '$.attachment.attachmentId') AS entityId,
           json_extract(bound.payload_json, '$.attachment.generation') AS revision,
           json_set(
             bound.payload_json,
             '$.recordKind', 'attachment_inventory',
             '$.sourceEligibility', CASE WHEN EXISTS (
               SELECT 1 FROM events AS excluded
               WHERE excluded.stream_kind = 'room'
                 AND excluded.stream_id = bound.stream_id
                 AND excluded.stream_seq <= snapshot.watermark
                 AND excluded.event_type = 'room.attachment.excluded'
                 AND json_extract(excluded.payload_json, '$.attachmentId') =
                   json_extract(bound.payload_json, '$.attachment.attachmentId')
             ) THEN 'excluded-recalled' ELSE 'bound-active' END
           ) AS payloadJson
    FROM events AS bound
    JOIN snapshot ON snapshot.roomId = bound.stream_id
    WHERE bound.stream_kind = 'room' AND bound.stream_seq <= snapshot.watermark
      AND bound.event_type = 'room.attachment.bound'`,
  execution_tool_review: `
    WITH snapshot(watermark, roomId, startedAt) AS (VALUES (?, ?, ?))
    SELECT 'execution-tool-event:' || event.event_id AS entityId,
           event.stream_seq AS revision,
           json_object(
             'recordKind', CASE event.event_type
               WHEN 'tool.safety.changed' THEN 'tool_safety_transition'
               WHEN 'agent.execution.attempt.changed' THEN 'agent_execution_attempt'
               WHEN 'agent.execution.retry.accepted' THEN 'agent_execution_retry'
               WHEN 'agent.invocation.intent.changed' THEN 'agent_invocation_intent'
               WHEN 'agent.invocation.scoped-cancellation.committed' THEN 'scoped_cancellation'
               WHEN 'room.agent_execution.changed' THEN 'legacy_agent_execution'
               ELSE 'agent_execution'
             END,
             'eventType', event.event_type,
             'occurredAt', event.occurred_at,
             'data', json(event.payload_json)
           ) AS payloadJson
    FROM events AS event
    JOIN snapshot ON snapshot.roomId = event.stream_id
    WHERE event.stream_kind = 'room' AND event.stream_seq <= snapshot.watermark
      AND event.occurred_at <= snapshot.startedAt
      AND event.event_type IN (
        'agent.execution.changed', 'agent.execution.attempt.changed',
        'agent.execution.retry.accepted', 'agent.invocation.intent.changed',
        'agent.invocation.scoped-cancellation.committed',
        'room.agent_execution.changed', 'tool.safety.changed'
      )
    UNION ALL
    SELECT 'boundary-event:' || event.event_id AS entityId,
           event.stream_seq AS revision,
           json_object(
             'recordKind', CASE json_extract(event.payload_json, '$.status')
               WHEN 'execution-state' THEN 'project_boundary_agent_execution'
               ELSE 'project_boundary_invocation'
             END,
             'eventType', event.event_type,
             'occurredAt', event.occurred_at,
             'publicStatus', json_extract(event.payload_json, '$.executionStatus'),
             'phase', CASE json_extract(event.payload_json, '$.executionStatus')
               WHEN 'accepted' THEN 'queued'
               WHEN 'running' THEN 'model_generation'
               WHEN 'completed' THEN 'completed'
               WHEN 'failed' THEN 'failed'
               WHEN 'cancelled' THEN 'cancelled'
               ELSE NULL
             END,
             'completedAt', CASE WHEN json_extract(event.payload_json, '$.executionStatus')
               IN ('completed', 'failed', 'cancelled') THEN event.occurred_at ELSE NULL END,
             'data', json(event.payload_json),
             'binding', CASE WHEN execution.execution_id IS NULL THEN NULL ELSE json_object(
               'lineageId', execution.lineage_id,
               'executionOrdinal', execution.execution_ordinal,
               'retryOfExecutionId', execution.retry_of_execution_id,
               'sourceRevision', execution.source_revision,
               'lifecycleGeneration', execution.lifecycle_generation,
               'providerId', execution.provider_id,
               'modelId', execution.model_id,
               'queuedAt', execution.queued_at
             ) END
           ) AS payloadJson
    FROM events AS event
    JOIN snapshot ON snapshot.roomId = event.stream_id
    LEFT JOIN project_boundary_agent_executions AS execution
      ON execution.execution_id = json_extract(event.payload_json, '$.executionId')
     AND execution.room_id = event.stream_id
    WHERE event.stream_kind = 'room' AND event.stream_seq <= snapshot.watermark
      AND event.occurred_at <= snapshot.startedAt
      AND event.event_type = 'project.boundary.invocation.decided'`,
  membership_governance_audit: `
    WITH snapshot(watermark, roomId, startedAt) AS (VALUES (?, ?, ?)),
    audit_candidates AS (
      SELECT audit.*, audit.rowid AS auditRowId,
             CASE audit.type
               WHEN 'room.agent.configured' THEN CASE
                 WHEN json_type(audit.details_json, '$.assignmentId') = 'text'
                   THEN 'room.agent-assignment.changed'
                 ELSE 'agent.configured'
               END
               WHEN 'room.human.invited' THEN 'human.invitation.issued'
               WHEN 'room.invitation.accepted' THEN 'human.invitation.accepted'
               WHEN 'room.invitation.rejected' THEN 'human.invitation.rejected'
               WHEN 'room.member.left' THEN 'room.governance.changed'
               WHEN 'room.member.removed' THEN 'room.governance.changed'
               WHEN 'room.member.role.changed' THEN 'room.governance.changed'
               WHEN 'room.ownership.transferred' THEN 'room.governance.changed'
               ELSE audit.type
             END AS expectedEventType
      FROM room_audit AS audit
      JOIN snapshot ON snapshot.roomId = audit.room_id
      WHERE audit.timestamp <= snapshot.startedAt
    ),
    ranked_audits AS (
      SELECT candidate.*,
             ROW_NUMBER() OVER (
               PARTITION BY candidate.room_id, candidate.actor_id, candidate.timestamp,
                            candidate.expectedEventType
               ORDER BY candidate.auditRowId
             ) AS eventOrdinal
      FROM audit_candidates AS candidate
    ),
    ranked_events AS (
      SELECT event.*,
             ROW_NUMBER() OVER (
               PARTITION BY event.stream_id, event.actor_id, event.occurred_at, event.event_type
               ORDER BY event.stream_seq, event.event_id COLLATE BINARY
             ) AS auditOrdinal
      FROM events AS event
      JOIN snapshot ON snapshot.roomId = event.stream_id
      WHERE event.stream_kind = 'room' AND event.stream_seq <= snapshot.watermark
        AND event.occurred_at <= snapshot.startedAt
    )
    SELECT 'governance-event:' || event.event_id AS entityId, event.stream_seq AS revision,
           json_object(
             'recordKind', 'room_governance_snapshot',
             'eventType', event.event_type,
             'actorId', event.actor_id,
             'occurredAt', event.occurred_at,
             'details', json(event.payload_json),
             'data', json(event.payload_json)
           ) AS payloadJson
    FROM ranked_events AS event
    WHERE event.event_type IN (
        'room.created', 'room.renamed', 'room.governance.changed', 'room.archived',
        'room.reopened', 'room.security.reduced', 'human.invitation.issued',
        'human.invitation.accepted', 'human.invitation.rejected', 'human.role.changed',
        'member.removed', 'agent.configured', 'room.agent-assignment.changed'
      )
    UNION ALL
    SELECT 'audit:' || audit.id AS entityId, event.stream_seq AS revision,
           json_object(
             'recordKind', 'governance_audit',
             'type', audit.type,
             'actorId', audit.actor_id,
             'result', audit.result,
             'occurredAt', audit.timestamp,
             'details', json(audit.details_json)
           ) AS payloadJson
    FROM ranked_audits AS audit
    JOIN ranked_events AS event ON event.stream_id = audit.room_id
      AND event.actor_id = audit.actor_id AND event.occurred_at = audit.timestamp
      AND event.event_type = audit.expectedEventType
      AND event.auditOrdinal = audit.eventOrdinal
    UNION ALL
    SELECT 'audit:' || audit.id AS entityId, 0 AS revision,
           json_object(
             'recordKind', 'governance_audit',
             'type', audit.type,
             'actorId', audit.actor_id,
             'result', audit.result,
             'occurredAt', audit.timestamp,
             'details', json(audit.details_json)
           ) AS payloadJson
    FROM audit_candidates AS audit
    WHERE NOT EXISTS (
      SELECT 1 FROM events AS event
      WHERE event.stream_kind = 'room' AND event.stream_id = audit.room_id
        AND event.actor_id = audit.actor_id AND event.occurred_at = audit.timestamp
    )`,
  memory: `
    -- source_job_id is internal steward scheduling correlation, not export provenance.
    SELECT version.memory_version_id AS entityId, version.version_number AS revision,
           json_object(
             'memoryRecordId', version.memory_record_id,
             'kind', version.kind,
             'state', version.state,
             'derivedText', version.derived_text,
             'originKind', version.origin_kind,
             'createdByActorId', version.created_by_actor_id,
             'replacesVersionId', version.replaces_version_id,
             'sourceCount', version.source_count,
             'sourceRefs', json((
               SELECT COALESCE(json_group_array(json_object(
                 'sourceKind', ordered.source_kind,
                 'sourceId', ordered.source_id,
                 'sourceRevision', ordered.source_revision
               )), '[]')
               FROM (
                 SELECT edge.source_kind, edge.source_id, edge.source_revision
                 FROM room_memory_source_edges AS edge
                 WHERE edge.memory_version_id = version.memory_version_id
                 ORDER BY edge.source_kind COLLATE BINARY,
                          edge.source_id COLLATE BINARY, edge.source_revision
                 LIMIT 16
               ) AS ordered
             )),
             'createdAt', version.created_at
           ) AS payloadJson
    FROM room_memory_versions AS version
    WHERE version.room_id = ? AND version.created_at <= ?
      AND EXISTS (
        SELECT 1 FROM events AS version_event
        WHERE version_event.stream_kind = 'room'
          AND version_event.stream_id = version.room_id
          AND version_event.stream_seq <= ?
          AND version_event.event_type = 'room.memory.version.changed'
          AND json_extract(version_event.payload_json, '$.memoryVersionId') =
            version.memory_version_id
          AND version_event.occurred_at = version.created_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM room_memory_source_edges AS edge
        JOIN room_memory_sources AS source
          ON source.room_id = edge.room_id AND source.source_kind = edge.source_kind
         AND source.source_id = edge.source_id AND source.source_revision = edge.source_revision
        WHERE edge.memory_version_id = version.memory_version_id
          AND source.server_stream_seq > ?
      )`,
  message: `
    WITH snapshot(watermark, roomId, startedAt) AS (VALUES (?, ?, ?)),
    eligible_revisions AS (
      SELECT revision.*
      FROM message_revisions AS revision
      JOIN message_envelopes AS envelope ON envelope.message_id = revision.message_id
      JOIN snapshot ON snapshot.roomId = envelope.room_id
      WHERE (
        (revision.revision = 1 AND (
          EXISTS (
            SELECT 1 FROM events AS event
            WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
              AND event.stream_seq <= snapshot.watermark
              AND event.event_type = 'room.message.accepted'
              AND json_extract(event.payload_json, '$.id') = revision.message_id
          ) OR (revision.revised_at <= snapshot.startedAt AND NOT EXISTS (
              SELECT 1 FROM events AS event
              WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
                AND event.event_type = 'room.message.accepted'
                AND json_extract(event.payload_json, '$.id') = revision.message_id
            ))
        )) OR (revision.revision > 1 AND (
          SELECT COUNT(*) FROM events AS event
          WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
            AND event.stream_seq <= snapshot.watermark
            AND event.event_type = 'room.message.revised'
            AND json_extract(event.payload_json, '$.id') = revision.message_id
        ) >= revision.revision - 1)
      )
    ),
    eligible_messages AS (
      SELECT envelope.message_id
      FROM message_envelopes AS envelope
      JOIN snapshot ON snapshot.roomId = envelope.room_id
      WHERE (
        EXISTS (
          SELECT 1 FROM events AS event
          WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
            AND event.stream_seq <= snapshot.watermark
            AND event.event_type = 'room.message.accepted'
            AND json_extract(event.payload_json, '$.id') = envelope.message_id
        ) OR (envelope.created_at <= snapshot.startedAt AND NOT EXISTS (
            SELECT 1 FROM events AS event
            WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
              AND event.event_type = 'room.message.accepted'
              AND json_extract(event.payload_json, '$.id') = envelope.message_id
          ))
      )
    )
    SELECT envelope.message_id AS entityId, MAX(revision.revision) AS revision,
           json_object(
             'messageKind', envelope.message_kind,
             'lifecycle', CASE WHEN EXISTS (
               SELECT 1 FROM events AS recalled
               WHERE recalled.stream_kind = 'room' AND recalled.stream_id = envelope.room_id
                 AND recalled.stream_seq <= snapshot.watermark
                 AND recalled.event_type = 'room.message.recalled'
                 AND json_extract(recalled.payload_json, '$.id') = envelope.message_id
             ) THEN 'recalled' ELSE 'active' END,
             'currentRevision', MAX(revision.revision),
             'revisionCount', COUNT(revision.revision),
             'authorId', message.author_id,
             'authorKind', message.author_kind,
             'sentAt', message.sent_at
           ) AS payloadJson
    FROM message_envelopes AS envelope
    JOIN messages AS message ON message.id = envelope.message_id
    JOIN snapshot ON snapshot.roomId = envelope.room_id
    JOIN eligible_messages AS eligible_message
      ON eligible_message.message_id = envelope.message_id
    JOIN eligible_revisions AS revision ON revision.message_id = envelope.message_id
    GROUP BY envelope.message_id, envelope.message_kind, envelope.room_id,
             message.author_id, message.author_kind, message.sent_at`,
  message_revision: `
    WITH snapshot(watermark, roomId, startedAt) AS (VALUES (?, ?, ?)),
    eligible_revisions AS (
      SELECT revision.*
      FROM message_revisions AS revision
      JOIN message_envelopes AS envelope ON envelope.message_id = revision.message_id
      JOIN snapshot ON snapshot.roomId = envelope.room_id
      WHERE (
        (revision.revision = 1 AND (
          EXISTS (
            SELECT 1 FROM events AS event
            WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
              AND event.stream_seq <= snapshot.watermark
              AND event.event_type = 'room.message.accepted'
              AND json_extract(event.payload_json, '$.id') = revision.message_id
          ) OR (revision.revised_at <= snapshot.startedAt AND NOT EXISTS (
              SELECT 1 FROM events AS event
              WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
                AND event.event_type = 'room.message.accepted'
                AND json_extract(event.payload_json, '$.id') = revision.message_id
            ))
        )) OR (revision.revision > 1 AND (
          SELECT COUNT(*) FROM events AS event
          WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
            AND event.stream_seq <= snapshot.watermark
            AND event.event_type = 'room.message.revised'
            AND json_extract(event.payload_json, '$.id') = revision.message_id
        ) >= revision.revision - 1)
      )
    )
    SELECT revision.message_id || ':revision:' || revision.revision AS entityId,
           revision.revision AS revision,
           json_object(
             'messageId', revision.message_id,
             'body', revision.body,
             'revisedAt', revision.revised_at,
             'revisedByActorId', revision.revised_by_actor_id,
             'isCurrent', CASE WHEN revision.revision = (
               SELECT MAX(snapshot_revision.revision)
               FROM eligible_revisions AS snapshot_revision
               WHERE snapshot_revision.message_id = revision.message_id
             ) THEN 1 ELSE 0 END,
             'isRecalled', CASE WHEN EXISTS (
               SELECT 1 FROM events AS recalled
               WHERE recalled.stream_kind = 'room' AND recalled.stream_id = envelope.room_id
                 AND recalled.stream_seq <= snapshot.watermark
                 AND recalled.event_type = 'room.message.recalled'
                 AND json_extract(recalled.payload_json, '$.id') = envelope.message_id
             ) THEN 1 ELSE 0 END
           ) AS payloadJson
    FROM eligible_revisions AS revision
    JOIN message_envelopes AS envelope ON envelope.message_id = revision.message_id
    JOIN snapshot ON snapshot.roomId = envelope.room_id`,
  project_fact: `
    SELECT project.event_id AS entityId, project.fact_revision AS revision,
           json_object(
             'projectId', project.project_id,
             'eventType', project.event_type,
             'factKind', project.fact_kind,
             'factId', project.fact_id,
             'authorityKind', project.authority_kind,
             'sourceKind', project.source_kind,
             'sourceId', project.source_id,
             'sourceRevision', project.source_revision,
             'occurredAt', project.occurred_at,
             'data', json(project.payload_json)
           ) AS payloadJson
    FROM project_events AS project
    JOIN events AS event ON event.event_id = project.event_id
      AND event.stream_kind = 'room' AND event.stream_id = project.room_id
      AND event.stream_seq <= ?
    WHERE project.room_id = ? AND project.occurred_at <= ?`,
  recall_audit: `
    WITH snapshot(watermark, roomId, startedAt) AS (VALUES (?, ?, ?)),
    eligible_revisions AS (
      SELECT revision.*
      FROM message_revisions AS revision
      JOIN message_envelopes AS envelope ON envelope.message_id = revision.message_id
      JOIN snapshot ON snapshot.roomId = envelope.room_id
      WHERE (
        (revision.revision = 1 AND (
          EXISTS (
            SELECT 1 FROM events AS event
            WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
              AND event.stream_seq <= snapshot.watermark
              AND event.event_type = 'room.message.accepted'
              AND json_extract(event.payload_json, '$.id') = revision.message_id
          ) OR (revision.revised_at <= snapshot.startedAt AND NOT EXISTS (
              SELECT 1 FROM events AS event
              WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
                AND event.event_type = 'room.message.accepted'
                AND json_extract(event.payload_json, '$.id') = revision.message_id
            ))
        )) OR (revision.revision > 1 AND (
          SELECT COUNT(*) FROM events AS event
          WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
            AND event.stream_seq <= snapshot.watermark
            AND event.event_type = 'room.message.revised'
            AND json_extract(event.payload_json, '$.id') = revision.message_id
        ) >= revision.revision - 1)
      )
    )
    SELECT envelope.message_id || ':recall' AS entityId,
           (
             SELECT MAX(snapshot_revision.revision)
             FROM eligible_revisions AS snapshot_revision
             WHERE snapshot_revision.message_id = envelope.message_id
           ) AS revision,
           json_object(
             'messageId', envelope.message_id,
             'recalledAt', envelope.recalled_at,
             'recalledByActorId', envelope.recalled_by_actor_id,
             'currentRevision', (
               SELECT MAX(snapshot_revision.revision)
               FROM eligible_revisions AS snapshot_revision
               WHERE snapshot_revision.message_id = envelope.message_id
             )
           ) AS payloadJson
    FROM message_envelopes AS envelope
    JOIN snapshot ON snapshot.roomId = envelope.room_id
    WHERE envelope.lifecycle = 'recalled' AND EXISTS (
        SELECT 1 FROM eligible_revisions AS revision
        WHERE revision.message_id = envelope.message_id
      ) AND (
        EXISTS (
          SELECT 1 FROM events AS event
          WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
            AND event.stream_seq <= snapshot.watermark
            AND event.event_type = 'room.message.recalled'
            AND json_extract(event.payload_json, '$.id') = envelope.message_id
        ) OR (envelope.recalled_at <= snapshot.startedAt AND NOT EXISTS (
            SELECT 1 FROM events AS event
            WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
              AND event.event_type = 'room.message.recalled'
              AND json_extract(event.payload_json, '$.id') = envelope.message_id
          ))
      )`,
  source_link: `
    SELECT source.source_kind || ':' || source.source_id || ':' || source.source_revision AS entityId,
           source.source_revision AS revision,
           json_object(
             'corpusSeq', source.corpus_seq,
             'sourceKind', source.source_kind,
             'sourceId', source.source_id,
             'sourceRevision', source.source_revision,
             'serverStreamSeq', source.server_stream_seq,
             'sourceActorId', source.source_actor_id,
             'readReference', source.read_reference,
             'occurredAt', source.occurred_at,
             'safeMetadata', json(source.safe_metadata_json)
           ) AS payloadJson
    FROM room_memory_sources AS source
    WHERE source.room_id = ? AND source.server_stream_seq <= ? AND source.occurred_at <= ?`,
});

function queryCategory(
  database: DatabaseSync,
  category: RoomExportCategory,
  categoryOrder: number,
  operation: Extract<PrivacyDataAuthorityOperation, { readonly type: "privacy.room-export.read-page" }>,
  cursor: ProjectionCursor | undefined,
): readonly ProjectionCandidate[] {
  if (cursor !== undefined && categoryOrder < cursor.categoryOrder) return [];
  const baseArguments: readonly (string | number)[] = category === "attachment_inventory"
    ? [operation.roomId, operation.watermark]
    : category === "execution_tool_review"
      ? [operation.watermark, operation.roomId, operation.startedAt]
      : category === "membership_governance_audit" || category === "project_fact"
        ? [operation.watermark, operation.roomId, operation.startedAt]
        : category === "memory"
          ? [operation.roomId, operation.startedAt, operation.watermark, operation.watermark]
          : category === "message"
            ? [operation.watermark, operation.roomId, operation.startedAt]
            : category === "message_revision"
              ? [operation.watermark, operation.roomId, operation.startedAt]
              : category === "recall_audit"
                ? [operation.watermark, operation.roomId, operation.startedAt]
                : [operation.roomId, operation.watermark, operation.startedAt];
  const sameCategory = cursor?.categoryOrder === categoryOrder;
  const rows = database.prepare(
    `SELECT entityId, revision, payloadJson FROM (${CATEGORY_QUERIES[category]})
     ${sameCategory ? "WHERE entityId COLLATE BINARY > ? OR (entityId COLLATE BINARY = ? AND revision > ?)" : ""}
     ORDER BY entityId COLLATE BINARY, revision LIMIT ?`,
  ).all(...baseArguments,
    ...(sameCategory ? [cursor.entityId, cursor.entityId, cursor.revision] : []),
    operation.limit + 1);
  return rows.map((row) => {
    if (typeof row.entityId !== "string" || row.entityId.length === 0 ||
        !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) {
      return fail("storage_unavailable", "Room export projection identity is corrupt");
    }
    const payload = parseJson(row.payloadJson);
    assertProjectionPayload(payload);
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 1_048_576) {
      return fail("storage_unavailable", "Room export projection record exceeds its bound");
    }
    return {
      category,
      categoryOrder,
      entityId: row.entityId,
      revision: Number(row.revision),
      payload,
    };
  });
}

function readRoomPage(
  database: DatabaseSync,
  operation: Extract<PrivacyDataAuthorityOperation, { readonly type: "privacy.room-export.read-page" }>,
): PrivacyDataAuthorityResult {
  requireExpectedBinding(database, operation);
  const cursor = decodeCursor(operation.after);
  const candidates = EXPORT_CATEGORY_ORDER.flatMap((category, categoryOrder) =>
    queryCategory(database, category, categoryOrder, operation, cursor))
    .sort((left, right) => left.categoryOrder - right.categoryOrder ||
      compareBinaryText(left.entityId, right.entityId) || left.revision - right.revision);
  const included = candidates.slice(0, operation.limit);
  const records = included.map((candidate) => Object.freeze({
      tenantId: TENANT_ID,
      roomId: operation.roomId,
      category: candidate.category,
      entityId: candidate.entityId,
      revision: candidate.revision,
      payload: candidate.payload,
    }));
  const last = included.at(-1);
  return Object.freeze({
    kind: "room-export-page",
    records: Object.freeze(records),
    ...(candidates.length > operation.limit && last !== undefined
      ? { next: encodeCursor(last) } : {}),
  });
}

/** Executes one closed diagnostics/Room-export read inside the caller's worker transaction. */
export function executePrivacyDataAuthorityOperation(
  database: DatabaseSync,
  operation: PrivacyDataAuthorityOperation,
): PrivacyDataAuthorityResult {
  if (!isPrivacyDataAuthorityOperation(operation)) {
    throw new TypeError("Privacy data authority operation is invalid");
  }
  switch (operation.type) {
    case "privacy.diagnostics.authorize": {
      const session = activeSession(database, operation.actorId, operation.sessionFamilyId, operation.sessionId, operation.now);
      if (!session.tenantAdministrator) {
        return fail("administrator_required", "Diagnostics requires Tenant Administrator");
      }
      return Object.freeze({
        kind: "diagnostics-principal",
        actorId: operation.actorId,
        sessionFamilyId: operation.sessionFamilyId,
        sessionId: operation.sessionId,
        principalKind: "tenant_administrator",
      });
    }
    case "privacy.diagnostics.read-closed": {
      const session = activeSession(database, operation.actorId, operation.sessionFamilyId, operation.sessionId, operation.now);
      if (!session.tenantAdministrator) {
        return fail("administrator_required", "Diagnostics requires Tenant Administrator");
      }
      return Object.freeze({
        kind: "diagnostics-entries",
        entries: diagnosticEntries(database, operation.now).slice(0, operation.limit),
      });
    }
    case "privacy.room-export.inspect-session": {
      activeSession(database, operation.actorId, operation.sessionFamilyId, operation.sessionId, operation.now);
      return Object.freeze({
        kind: "room-export-session",
        session: Object.freeze({
          actorId: operation.actorId,
          sessionFamilyId: operation.sessionFamilyId,
          sessionId: operation.sessionId,
          tenantId: TENANT_ID,
          principalKind: "human",
          active: true,
        }),
      });
    }
    case "privacy.room-export.inspect-access": {
      const binding = currentRoomBinding(database, operation);
      return Object.freeze({
        kind: "room-export-access",
        access: Object.freeze({
          actorId: operation.actorId,
          tenantId: TENANT_ID,
          roomId: operation.roomId,
          membershipRole: "owner",
          lifecycle: binding.lifecycle,
          accessRevision: binding.accessRevision,
          exportAllowed: true,
        }),
      });
    }
    case "privacy.room-export.begin": {
      const binding = requireExpectedBinding(database, operation);
      return Object.freeze({
        kind: "room-export-snapshot",
        snapshot: Object.freeze({
          exportId: `export:${randomUUID()}`,
          roomId: operation.roomId,
          watermark: binding.watermark,
          accessRevision: binding.accessRevision,
          startedAt: canonicalNow(operation.now),
        }),
      });
    }
    case "privacy.room-export.reauthorize":
      requireExpectedBinding(database, operation);
      return Object.freeze({ kind: "room-export-reauthorized" });
    case "privacy.room-export.read-page":
      return readRoomPage(database, operation);
  }
}
