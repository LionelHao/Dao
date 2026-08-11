import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Actor,
  ManagedRoom,
  Message,
  PersistedIdentityEvent,
  PersistedRoomEvent,
  RoomSyncRequest,
  RoomSyncResult,
} from "@native-im/core";
import {
  isManagedRoomShape,
  isRoomAuditRecord,
  type RoomAuditRecord,
} from "../room-lifecycle.js";
import {
  parsePersistedIdentityEvent,
  parsePersistedRoomEvent,
  parsePersistentCommand,
  ROOM_SYNC_DEFAULT_LIMIT,
  ROOM_SYNC_MAX_PAGE_BYTES,
  type AgentCollaborationCommand,
  type AgentWorkerCommandContext,
  type AuthenticatedCommandContext,
  type AuthenticatedSessionContext,
  type CommandAcknowledgement,
  type HumanCollaborationCommand,
  type JsonValue,
  type OutboxDelivery,
  type OutboxDeliveryFailureReason,
  type OutboxDispatchCandidate,
  type PersistentCommand,
  type RoomGovernanceCommand,
} from "./contracts.js";
import type { AuthorityWorkerErrorCode } from "./worker-protocol.js";

export class AuthorityDatabaseError extends Error {
  constructor(
    readonly code: AuthorityWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthorityDatabaseError";
  }
}

export interface ExecuteHumanDatabaseCommandInput {
  readonly context: AuthenticatedCommandContext;
  readonly command: HumanCollaborationCommand | RoomGovernanceCommand;
  readonly invitationSecret?: {
    readonly tokenHash: string;
    readonly sealedToken: string;
  };
  readonly now: number;
}

export interface ExecuteAgentDatabaseCommandInput {
  readonly context: AgentWorkerCommandContext;
  readonly command: AgentCollaborationCommand;
  readonly now: number;
}

function fail(code: AuthorityWorkerErrorCode, message: string): never {
  throw new AuthorityDatabaseError(code, message);
}

function unreachableCommand(command: never): never {
  throw new TypeError(`Unreachable persistent command: ${String(command)}`);
}

export class AuthorityRollbackFatalError extends AggregateError {
  constructor(operationError: unknown, rollbackError: unknown) {
    super(
      [operationError, rollbackError],
      "Authority transaction rollback failed",
    );
    this.name = "AuthorityRollbackFatalError";
  }
}

export function runAuthorityImmediateTransaction<Result>(
  database: DatabaseSync,
  operation: () => Result,
): Result {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError: unknown) {
      throw new AuthorityRollbackFatalError(error, rollbackError);
    }
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON rejects unsupported values");
}

function roomSyncResultWithinPageLimit<Result extends RoomSyncResult>(result: Result): Result {
  if (Buffer.byteLength(canonicalJson(result), "utf8") > ROOM_SYNC_MAX_PAGE_BYTES) {
    return fail("storage_unavailable", "Authority room sync result exceeds the page limit");
  }
  return result;
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("base64url");
}

function businessHash(command: PersistentCommand): string {
  return createHash("sha256").update(canonicalJson(command)).digest("base64url");
}

interface IdempotentCommandInput {
  readonly actorId: string;
  readonly command: PersistentCommand;
  readonly aggregateKind: "room" | "identity";
  readonly aggregateId: string;
  readonly idempotencyKey: string;
  readonly now: number;
  readonly execute: (
    acceptedAt: string,
    scope: string,
    idempotencyKey: string,
  ) => CommandAcknowledgement;
}

function executeIdempotently(
  database: DatabaseSync,
  input: IdempotentCommandInput,
): CommandAcknowledgement {
  const scope = [
    input.actorId,
    input.command.type,
    input.aggregateKind,
    input.aggregateId,
  ].join("\u0000");
  const requestHash = businessHash(input.command);
  const existing = database
    .prepare(
      `SELECT request_hash AS requestHash, response_json AS responseJson
       FROM idempotency_records WHERE scope = ? AND key = ?`,
    )
    .get(scope, input.idempotencyKey);
  if (existing !== undefined) {
    if (existing.requestHash !== requestHash) {
      return fail("idempotency_conflict", "Idempotency key payload changed");
    }
    if (typeof existing.responseJson !== "string") {
      return fail("storage_unavailable", "Stored idempotency acknowledgement is corrupt");
    }
    return parseStoredAcknowledgement(existing.responseJson);
  }
  const acceptedAt = new Date(input.now).toISOString();
  const acknowledgement = input.execute(
    acceptedAt,
    scope,
    input.idempotencyKey,
  );
  database
    .prepare(
      `INSERT INTO idempotency_records (
         scope, key, request_hash, response_json, status_code,
         created_at, expires_at
       ) VALUES (?, ?, ?, ?, 200, ?, ?)`,
    )
    .run(
      scope,
      input.idempotencyKey,
      requestHash,
      canonicalJson(acknowledgement),
      acceptedAt,
      new Date(input.now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    );
  return acknowledgement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredAcknowledgement(value: string): CommandAcknowledgement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail("storage_unavailable", "Stored idempotency acknowledgement is corrupt");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join("\u0000") !==
      ["acceptedAt", "aggregateId", "eventIds", "result"].sort().join("\u0000") ||
    typeof parsed.aggregateId !== "string" ||
    parsed.aggregateId.length === 0 ||
    !Array.isArray(parsed.eventIds) ||
    !parsed.eventIds.every((eventId) => typeof eventId === "string" && eventId.length > 0) ||
    typeof parsed.acceptedAt !== "string" ||
    parsed.acceptedAt.length === 0
  ) {
    return fail("storage_unavailable", "Stored idempotency acknowledgement is corrupt");
  }
  return parsed as unknown as CommandAcknowledgement;
}

function requireHumanSession(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  now: number,
): string {
  const session = database
    .prepare(
      `SELECT
         session.family_id AS familyId,
         session.account_id AS accountId,
         session.actor_id AS actorId,
         session.access_expires_at AS accessExpiresAt,
         session.revoked_at AS revokedAt,
         actor.kind AS actorKind
       FROM sessions AS session
       JOIN actors AS actor ON actor.id = session.actor_id
       WHERE session.access_token_hash = ?`,
    )
    .get(context.sessionId);
  if (session === undefined) {
    return fail("invalid_token", "Authority command session was rejected");
  }
  if (
    session.actorKind !== "human" ||
    session.familyId !== context.sessionFamilyId ||
    session.accountId !== context.principal.accountId ||
    session.actorId !== context.principal.actorId
  ) {
    return fail("identity_forbidden", "Authority command identity was rejected");
  }
  if (typeof session.revokedAt === "number") {
    return fail("session_revoked", "Authority command session was revoked");
  }
  if (
    typeof session.accessExpiresAt !== "number" ||
    now >= session.accessExpiresAt
  ) {
    return fail("token_expired", "Authority command session expired");
  }
  return context.principal.actorId;
}

export function readHistoryDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
): readonly Message[] {
  const actorId = requireHumanSession(database, context, now);
  requireRoomMembership(database, actorId, roomId);
  return database.prepare(
    `SELECT id, room_id AS roomId, author_id AS authorId,
            author_kind AS authorKind, body, sent_at AS sentAt
     FROM messages WHERE room_id = ? ORDER BY sent_at, id`,
  ).all(roomId).map((row) => {
    if (typeof row.id !== "string" || typeof row.roomId !== "string" ||
        typeof row.authorId !== "string" ||
        (row.authorKind !== "human" && row.authorKind !== "agent") ||
        typeof row.body !== "string" || typeof row.sentAt !== "string") {
      return fail("storage_unavailable", "Authority message history is corrupt");
    }
    return {
      id: row.id,
      roomId: row.roomId,
      authorId: row.authorId,
      authorKind: row.authorKind,
      body: row.body,
      sentAt: row.sentAt,
    };
  });
}

function runAuthorityReadTransaction<Result>(
  database: DatabaseSync,
  operation: () => Result,
): Result {
  database.exec("BEGIN");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError: unknown) {
      throw new AuthorityRollbackFatalError(error, rollbackError);
    }
    throw error;
  }
}

function requireActiveHumanRoomMembership(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): void {
  const row = database.prepare(
    `SELECT room.status AS roomStatus
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.room_id = ?
       AND membership.actor_id = ?
       AND membership.kind = 'human'`,
  ).get(roomId, actorId);
  if (row?.roomStatus !== "active") {
    fail("room_forbidden", "Authority room sync access was rejected");
  }
}

function parseRoomSyncEvent(row: Record<string, unknown>): PersistedRoomEvent {
  let payload: unknown;
  try {
    payload = typeof row.payloadJson === "string"
      ? JSON.parse(row.payloadJson) as unknown
      : undefined;
  } catch {
    return fail("storage_unavailable", "Stored room sync event is corrupt");
  }
  const parsed = parsePersistedRoomEvent({
    eventId: row.eventId,
    streamKind: row.streamKind,
    streamId: row.streamId,
    streamSeq: row.streamSeq,
    roomId: row.roomId,
    actorId: row.actorId,
    occurredAt: row.occurredAt,
    type: row.eventType,
    payload,
  });
  return parsed.ok
    ? parsed.value
    : fail("storage_unavailable", "Stored room sync event is corrupt");
}

export function syncRoomDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  request: RoomSyncRequest,
  now: number,
): RoomSyncResult {
  return runAuthorityReadTransaction(database, () => {
    const actorId = requireHumanSession(database, context, now);
    requireActiveHumanRoomMembership(database, actorId, request.roomId);
    const stream = database.prepare(
      `SELECT head_seq AS headSeq, retained_from_seq AS retainedFromSeq
       FROM streams WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(request.roomId);
    if (
      typeof stream?.headSeq !== "number" ||
      !Number.isSafeInteger(stream.headSeq) ||
      stream.headSeq < 0 ||
      typeof stream.retainedFromSeq !== "number" ||
      !Number.isSafeInteger(stream.retainedFromSeq) ||
      stream.retainedFromSeq < 1 ||
      stream.retainedFromSeq > stream.headSeq + 1
    ) {
      return fail("storage_unavailable", "Authority room stream is corrupt");
    }
    const currentHeadSeq = stream.headSeq;
    const retainedFromSeq = stream.retainedFromSeq;
    if (request.cursor === undefined) {
      return roomSyncResultWithinPageLimit({
        type: "room.sync.result",
        requestId: request.requestId,
        mode: "repair_required",
        reason: "cursor_absent",
        retainedFromSeq,
        watermark: currentHeadSeq,
      });
    }
    if (
      request.cursor.roomId !== request.roomId ||
      request.cursor.afterSeq > currentHeadSeq ||
      (request.cursor.watermark !== undefined &&
        request.cursor.watermark > currentHeadSeq)
    ) {
      return fail("invalid_request", "Authority room sync cursor was rejected");
    }
    if (request.cursor.afterSeq < retainedFromSeq - 1) {
      return roomSyncResultWithinPageLimit({
        type: "room.sync.result",
        requestId: request.requestId,
        mode: "repair_required",
        reason: "cursor_expired",
        retainedFromSeq,
        watermark: currentHeadSeq,
      });
    }
    const watermark = request.cursor.watermark ?? currentHeadSeq;

    const limit = request.limit ?? ROOM_SYNC_DEFAULT_LIMIT;
    const rows = database.prepare(
      `SELECT event_id AS eventId, stream_kind AS streamKind,
              stream_id AS streamId, stream_seq AS streamSeq, room_id AS roomId,
              actor_id AS actorId, event_type AS eventType,
              occurred_at AS occurredAt, payload_json AS payloadJson
       FROM events
       WHERE stream_kind = 'room' AND stream_id = ?
         AND stream_seq > ? AND stream_seq <= ?
       ORDER BY stream_seq
       LIMIT ?`,
    ).all(request.roomId, request.cursor.afterSeq, watermark, limit);
    const events: PersistedRoomEvent[] = [];
    let expectedSeq = request.cursor.afterSeq + 1;
    let eventBytesTotal = 0;
    for (const row of rows) {
      const event = parseRoomSyncEvent(row);
      if (
        event.streamSeq !== expectedSeq ||
        event.streamId !== request.roomId ||
        event.roomId !== request.roomId
      ) {
        return fail("storage_unavailable", "Authority room sync sequence is corrupt");
      }
      const eventBytes = Buffer.byteLength(canonicalJson(event), "utf8");
      if (eventBytes > ROOM_SYNC_MAX_PAGE_BYTES) {
        return fail("storage_unavailable", "Authority room sync event exceeds the page limit");
      }
      const candidateAfterSeq = event.streamSeq;
      const candidateHasMore = candidateAfterSeq < watermark;
      const candidateWithoutEvents = {
        type: "room.sync.result" as const,
        requestId: request.requestId,
        mode: "delta" as const,
        events: [],
        nextCursor: {
          version: 1 as const,
          roomId: request.roomId,
          afterSeq: candidateAfterSeq,
          ...(candidateHasMore ? { watermark } : {}),
        },
        watermark,
        hasMore: candidateHasMore,
      };
      const envelopeBytes = Buffer.byteLength(canonicalJson(candidateWithoutEvents), "utf8") - 2;
      const candidateEventsBytes = 2 + eventBytesTotal + eventBytes + events.length;
      if (envelopeBytes + candidateEventsBytes > ROOM_SYNC_MAX_PAGE_BYTES) {
        if (events.length === 0) {
          return fail("storage_unavailable", "Authority room sync result exceeds the page limit");
        }
        break;
      }
      events.push(event);
      eventBytesTotal += eventBytes;
      expectedSeq += 1;
    }
    const afterSeq = events.at(-1)?.streamSeq ?? request.cursor.afterSeq;
    if (events.length === 0 && afterSeq < watermark) {
      return fail("storage_unavailable", "Authority room sync sequence is corrupt");
    }
    const hasMore = afterSeq < watermark;
    return roomSyncResultWithinPageLimit({
      type: "room.sync.result",
      requestId: request.requestId,
      mode: "delta",
      events,
      nextCursor: {
        version: 1,
        roomId: request.roomId,
        afterSeq,
        ...(hasMore ? { watermark } : {}),
      },
      watermark,
      hasMore,
    });
  });
}

export function compactRoomStreamDatabaseCommand(
  database: DatabaseSync,
  roomId: string,
  retainedFromSeq: number,
): { readonly retainedFromSeq: number; readonly headSeq: number } {
  return runAuthorityImmediateTransaction(database, () => {
    const room = database.prepare("SELECT status FROM rooms WHERE id = ?").get(roomId);
    if (room === undefined) {
      return fail("room_not_found", "Authority room was not found");
    }
    if (room.status === "archived") {
      return fail("room_archived", "Authority archived room cannot be compacted");
    }
    if (room.status !== "active") {
      return fail("storage_unavailable", "Authority room is corrupt");
    }
    const stream = database.prepare(
      `SELECT head_seq AS headSeq, retained_from_seq AS currentRetainedFromSeq
       FROM streams
       WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(roomId);
    if (
      typeof stream?.headSeq !== "number" ||
      !Number.isSafeInteger(stream.headSeq) ||
      typeof stream.currentRetainedFromSeq !== "number" ||
      !Number.isSafeInteger(stream.currentRetainedFromSeq)
    ) {
      return fail("storage_unavailable", "Authority room stream is corrupt");
    }
    if (
      retainedFromSeq < stream.currentRetainedFromSeq ||
      retainedFromSeq > stream.headSeq + 1
    ) {
      return fail("invalid_request", "Authority room stream retention was rejected");
    }
    const pendingDelivery = database.prepare(
      `SELECT 1 AS present
       FROM outbox_deliveries AS delivery
       JOIN events AS event ON event.event_id = delivery.event_id
       WHERE event.stream_kind = 'room' AND event.stream_id = ?
         AND event.stream_seq < ? AND delivery.status <> 'dispatched'
       LIMIT 1`,
    ).get(roomId, retainedFromSeq);
    if (pendingDelivery?.present === 1) {
      return fail(
        "room_compaction_blocked",
        "Authority room stream compaction is waiting for pending delivery",
      );
    }
    database.prepare(
      `UPDATE streams SET retained_from_seq = ?
       WHERE stream_kind = 'room' AND stream_id = ?`,
    ).run(retainedFromSeq, roomId);
    database.prepare(
      `DELETE FROM outbox_deliveries
       WHERE status = 'dispatched' AND event_id IN (
         SELECT event_id FROM events
         WHERE stream_kind = 'room' AND stream_id = ? AND stream_seq < ?
       )`,
    ).run(roomId, retainedFromSeq);
    database.prepare(
      `DELETE FROM events
       WHERE stream_kind = 'room' AND stream_id = ? AND stream_seq < ?`,
    ).run(roomId, retainedFromSeq);
    return { retainedFromSeq, headSeq: stream.headSeq };
  });
}

export function readActorDatabaseQuery(
  database: DatabaseSync,
  actorId: string,
): Actor | undefined {
  const row = database.prepare(
    `SELECT id, kind, display_name AS displayName, reachability, readiness,
            tool_permissions_json AS toolPermissionsJson
     FROM actors WHERE id = ?`,
  ).get(actorId);
  if (row === undefined) {
    return undefined;
  }
  if (typeof row.id !== "string" || typeof row.displayName !== "string") {
    return fail("storage_unavailable", "Authority actor is corrupt");
  }
  if (row.kind === "human" &&
      (row.reachability === "online" || row.reachability === "dnd" || row.reachability === "offline")) {
    return {
      id: row.id,
      kind: "human",
      displayName: row.displayName,
      reachability: row.reachability,
    };
  }
  if (row.kind === "agent" &&
      (row.readiness === "ready" || row.readiness === "busy" ||
       row.readiness === "paused" || row.readiness === "noauth") &&
      typeof row.toolPermissionsJson === "string") {
    const toolPermissions: unknown = JSON.parse(row.toolPermissionsJson);
    if (Array.isArray(toolPermissions) &&
        toolPermissions.every((permission) => typeof permission === "string")) {
      return {
        id: row.id,
        kind: "agent",
        displayName: row.displayName,
        readiness: row.readiness,
        toolPermissions,
      };
    }
  }
  return fail("storage_unavailable", "Authority actor is corrupt");
}

export function readRoomDatabaseQuery(
  database: DatabaseSync,
  roomId: string,
): ManagedRoom | undefined {
  const exists = database.prepare("SELECT 1 AS present FROM rooms WHERE id = ?").get(roomId);
  if (exists?.present !== 1) {
    return undefined;
  }
  const room = readManagedRoom(database, roomId);
  return isManagedRoomShape(room)
    ? room
    : fail("storage_unavailable", "Authority room is corrupt");
}

export function canAccessRoomDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
): boolean {
  const actorId = requireHumanSession(database, context, now);
  const membership = database.prepare(
    `SELECT room.status AS roomStatus
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.room_id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
  ).get(roomId, actorId);
  return membership?.roomStatus === "active";
}

export function readRoomAuditDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
): readonly RoomAuditRecord[] {
  const actorId = requireHumanSession(database, context, now);
  requireRoomMembership(database, actorId, roomId);
  return database.prepare(
    `SELECT id, type, room_id AS roomId, actor_id AS actorId,
            result, timestamp, details_json AS detailsJson
     FROM room_audit WHERE room_id = ? ORDER BY rowid`,
  ).all(roomId).map((row) => {
    if (typeof row.detailsJson !== "string") {
      return fail("storage_unavailable", "Authority room audit is corrupt");
    }
    const details: unknown = JSON.parse(row.detailsJson);
    if (typeof details !== "object" || details === null || Array.isArray(details)) {
      return fail("storage_unavailable", "Authority room audit is corrupt");
    }
    const envelopeKeys = new Set(["id", "type", "roomId", "actorId", "result", "timestamp"]);
    if (Object.keys(details).some((key) => envelopeKeys.has(key))) {
      return fail("storage_unavailable", "Authority room audit is corrupt");
    }
    const record: unknown = {
      id: row.id,
      type: row.type,
      roomId: row.roomId,
      actorId: row.actorId,
      result: row.result,
      timestamp: row.timestamp,
      ...details,
    };
    if (!isRoomAuditRecord(record)) {
      return fail("storage_unavailable", "Authority room audit is corrupt");
    }
    return record;
  });
}

function parseOutboxEvent(row: Record<string, unknown>): PersistedRoomEvent | PersistedIdentityEvent {
  let payload: unknown;
  try {
    payload = typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson) : undefined;
  } catch {
    return fail("storage_unavailable", "Stored outbox event payload is corrupt");
  }
  const envelope = {
    eventId: row.eventId,
    streamKind: row.streamKind,
    streamId: row.streamId,
    streamSeq: row.streamSeq,
    actorId: row.actorId,
    occurredAt: row.occurredAt,
    type: row.eventType,
    payload,
  };
  if (row.streamKind === "room") {
    const parsed = parsePersistedRoomEvent({ ...envelope, roomId: row.roomId });
    if (parsed.ok) return parsed.value;
  } else if (row.streamKind === "identity") {
    const parsed = parsePersistedIdentityEvent(envelope);
    if (parsed.ok) return parsed.value;
  }
  return fail("storage_unavailable", "Stored outbox event is corrupt");
}

function isSessionRevokedEvent(
  event: PersistedIdentityEvent,
): event is PersistedIdentityEvent & { readonly type: "identity.session.revoked" } {
  return event.type === "identity.session.revoked";
}

function isRoomAccessChangedEvent(
  event: PersistedIdentityEvent,
): event is PersistedIdentityEvent & { readonly type: "identity.room-access.changed" } {
  return event.type === "identity.room-access.changed";
}

export function listPendingOutboxDatabaseQuery(
  database: DatabaseSync,
  limit: number,
  now: number,
): readonly OutboxDelivery[] {
  const rows = database
    .prepare(
      `SELECT
         delivery.id AS deliveryId,
         delivery.event_id AS eventId,
         delivery.target_kind AS targetKind,
         delivery.target_id AS targetId,
         delivery.stream_seq AS streamSeq,
         delivery.attempts,
         event.stream_kind AS streamKind,
         event.stream_id AS streamId,
         event.room_id AS roomId,
         event.actor_id AS actorId,
         event.event_type AS eventType,
         event.occurred_at AS occurredAt,
         event.payload_json AS payloadJson
       FROM outbox_deliveries AS delivery
       JOIN events AS event
         ON event.event_id = delivery.event_id
        AND event.stream_seq = delivery.stream_seq
       WHERE delivery.status = 'pending'
         AND delivery.available_at <= ?
       ORDER BY delivery.stream_seq, delivery.id
       LIMIT ?`,
    )
    .all(new Date(now).toISOString(), limit) as Record<string, unknown>[];
  return rows.map((row) => {
    if (
      typeof row.deliveryId !== "string" ||
      typeof row.eventId !== "string" ||
      (row.targetKind !== "room" &&
        row.targetKind !== "principal" &&
        row.targetKind !== "session-family") ||
      typeof row.targetId !== "string" ||
      typeof row.streamSeq !== "number" ||
      !Number.isSafeInteger(row.streamSeq) ||
      row.streamSeq < 1 ||
      typeof row.attempts !== "number" ||
      !Number.isSafeInteger(row.attempts) ||
      row.attempts < 0
    ) {
      return fail("storage_unavailable", "Stored outbox delivery is corrupt");
    }
    const event = parseOutboxEvent(row);
    if (event.eventId !== row.eventId || event.streamSeq !== row.streamSeq) {
      return fail("storage_unavailable", "Stored outbox delivery event does not match");
    }
    if (
      row.targetKind === "room" &&
      event.streamKind === "room" &&
      event.roomId === row.targetId
    ) {
      return {
        deliveryId: row.deliveryId,
        eventId: row.eventId,
        targetKind: "room",
        targetId: row.targetId,
        streamSeq: row.streamSeq,
        attempts: row.attempts,
        event,
      };
    }
    if (
      row.targetKind === "principal" &&
      event.streamKind === "identity" &&
      isRoomAccessChangedEvent(event) &&
      event.streamId === row.targetId
    ) {
      return {
        deliveryId: row.deliveryId,
        eventId: row.eventId,
        targetKind: "principal",
        targetId: row.targetId,
        streamSeq: row.streamSeq,
        attempts: row.attempts,
        event,
      };
    }
    if (
      row.targetKind === "session-family" &&
      event.streamKind === "identity" &&
      isSessionRevokedEvent(event) &&
      event.payload.familyId === row.targetId
    ) {
      return {
        deliveryId: row.deliveryId,
        eventId: row.eventId,
        targetKind: "session-family",
        targetId: row.targetId,
        streamSeq: row.streamSeq,
        attempts: row.attempts,
        event,
      };
    }
    return fail("storage_unavailable", "Stored outbox target does not match its event stream");
  });
}

export function authorizeOutboxCandidateDatabaseQuery(
  database: DatabaseSync,
  deliveryId: string,
  candidate: OutboxDispatchCandidate,
  now: number,
): boolean {
  const delivery = database
    .prepare(
      `SELECT target_kind AS targetKind, target_id AS targetId
       FROM outbox_deliveries
       WHERE id = ? AND status = 'pending'`,
    )
    .get(deliveryId);
  if (
    typeof delivery?.targetKind !== "string" ||
    typeof delivery.targetId !== "string"
  ) {
    return false;
  }
  if (delivery.targetKind === "session-family") {
    return candidate.sessionFamilyId === delivery.targetId;
  }
  const sessionParameters = [
    candidate.sessionId,
    candidate.sessionFamilyId,
    candidate.principal.accountId,
    candidate.principal.actorId,
    now,
  ] as const;
  if (delivery.targetKind === "principal") {
    if (candidate.principal.actorId !== delivery.targetId) return false;
    return database
      .prepare(
        `SELECT 1 AS allowed
         FROM sessions AS session
         JOIN actors AS actor ON actor.id = session.actor_id
         WHERE session.access_token_hash = ?
           AND session.family_id = ?
           AND session.account_id = ?
           AND session.actor_id = ?
           AND session.access_expires_at > ?
           AND session.revoked_at IS NULL
           AND actor.kind = 'human'`,
      )
      .get(...sessionParameters)?.allowed === 1;
  }
  if (delivery.targetKind !== "room") return false;
  return database
    .prepare(
      `SELECT 1 AS allowed
       FROM sessions AS session
       JOIN actors AS actor ON actor.id = session.actor_id
       JOIN room_memberships AS membership ON membership.actor_id = session.actor_id
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE session.access_token_hash = ?
         AND session.family_id = ?
         AND session.account_id = ?
         AND session.actor_id = ?
         AND session.access_expires_at > ?
         AND session.revoked_at IS NULL
         AND actor.kind = 'human'
         AND membership.room_id = ?
         AND room.status = 'active'`,
    )
    .get(...sessionParameters, delivery.targetId)?.allowed === 1;
}

export function markOutboxDispatchedDatabaseCommand(
  database: DatabaseSync,
  deliveryId: string,
  now: number,
): void {
  const result = database
    .prepare(
      `UPDATE outbox_deliveries
       SET status = 'dispatched', delivered_at = ?, last_error = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .run(new Date(now).toISOString(), deliveryId);
  if (result.changes === 0) {
    const existing = database
      .prepare("SELECT status FROM outbox_deliveries WHERE id = ?")
      .get(deliveryId);
    if (existing?.status !== "dispatched") {
      return fail("storage_unavailable", "Authority outbox delivery does not exist");
    }
  }
}

export function markOutboxFailedDatabaseCommand(
  database: DatabaseSync,
  deliveryId: string,
  reason: OutboxDeliveryFailureReason,
): void {
  const result = database
    .prepare(
      `UPDATE outbox_deliveries
       SET attempts = attempts + 1, last_error = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(reason, deliveryId);
  if (result.changes === 0) {
    const existing = database
      .prepare("SELECT status FROM outbox_deliveries WHERE id = ?")
      .get(deliveryId);
    if (existing?.status !== "dispatched") {
      return fail("storage_unavailable", "Authority outbox delivery does not exist");
    }
  }
}

function requireRoomMembership(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): void {
  const membership = database
    .prepare(
      `SELECT room.status AS roomStatus
       FROM room_memberships AS membership
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE membership.room_id = ? AND membership.actor_id = ?`,
    )
    .get(roomId, actorId);
  if (membership?.roomStatus !== "active") {
    fail("room_forbidden", "Authority room access was rejected");
  }
}

function requireRoomManager(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): { readonly roomStatus: string; readonly role: string } {
  const membership = database
    .prepare(
      `SELECT room.status AS roomStatus, membership.role
       FROM room_memberships AS membership
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE membership.room_id = ?
         AND membership.actor_id = ?
         AND membership.kind = 'human'`,
    )
    .get(roomId, actorId);
  if (
    typeof membership?.roomStatus !== "string" ||
    (membership.role !== "owner" && membership.role !== "admin")
  ) {
    return fail("room_forbidden", "Authority room governance was rejected");
  }
  return { roomStatus: membership.roomStatus, role: membership.role };
}

function requireRoomOwner(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): { readonly roomStatus: string } {
  const manager = requireRoomManager(database, actorId, roomId);
  if (manager.role !== "owner") {
    return fail("room_forbidden", "Authority room owner permission was rejected");
  }
  return { roomStatus: manager.roomStatus };
}

function invitationByToken(
  database: DatabaseSync,
  token: string,
): Record<string, unknown> {
  const tokenHash = createHash("sha256").update(token).digest("base64url");
  const invitation = database
    .prepare(
      `SELECT
         id, room_id AS roomId, inviter_actor_id AS inviterActorId,
         invitee_actor_id AS inviteeActorId, status, created_at AS createdAt,
         decision_actor_id AS decisionActorId, decided_at AS decidedAt
       FROM room_invitations WHERE token_hash = ?`,
    )
    .get(tokenHash);
  if (invitation === undefined) {
    return fail("invitation_not_found", "Authority invitation was not found");
  }
  return invitation;
}

function readManagedRoom(database: DatabaseSync, roomId: string): JsonValue {
  const row = database
    .prepare(
      `SELECT id, name, status, created_at AS createdAt
       FROM rooms WHERE id = ?`,
    )
    .get(roomId);
  if (
    typeof row?.id !== "string" ||
    typeof row.name !== "string" ||
    (row.status !== "active" && row.status !== "archived") ||
    typeof row.createdAt !== "string"
  ) {
    return fail("room_not_found", "Authority room was not found");
  }
  const members = database
    .prepare(
      `SELECT
         actor_id AS actorId, kind, role, participation,
         tool_permissions_json AS toolPermissionsJson,
         joined_at AS joinedAt, configured_at AS configuredAt
       FROM room_memberships WHERE room_id = ? ORDER BY rowid`,
    )
    .all(roomId)
    .map((member) => {
      if (
        member.kind === "human" &&
        typeof member.actorId === "string" &&
        (member.role === "owner" || member.role === "admin" || member.role === "member") &&
        typeof member.joinedAt === "string"
      ) {
        return {
          kind: "human",
          actorId: member.actorId,
          role: member.role,
          joinedAt: member.joinedAt,
        };
      }
      if (
        member.kind === "agent" &&
        typeof member.actorId === "string" &&
        (member.participation === "active" ||
          member.participation === "on-mention" ||
          member.participation === "silent") &&
        typeof member.toolPermissionsJson === "string" &&
        typeof member.configuredAt === "string"
      ) {
        const toolPermissions: unknown = JSON.parse(member.toolPermissionsJson);
        if (
          !Array.isArray(toolPermissions) ||
          !toolPermissions.every((permission) => typeof permission === "string")
        ) {
          return fail("storage_unavailable", "Authority membership is corrupt");
        }
        return {
          kind: "agent",
          actorId: member.actorId,
          participation: member.participation,
          toolPermissions,
          configuredAt: member.configuredAt,
        };
      }
      return fail("storage_unavailable", "Authority membership is corrupt");
    });
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    members,
    createdAt: row.createdAt,
  };
}

function appendRoomEvent(
  database: DatabaseSync,
  input: {
    readonly eventId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly eventType: string;
    readonly occurredAt: string;
    readonly payload: JsonValue;
  },
): number {
  const stream = database
    .prepare(
      `SELECT head_seq AS headSeq FROM streams
       WHERE stream_kind = 'room' AND stream_id = ?`,
    )
    .get(input.roomId);
  if (typeof stream?.headSeq !== "number") {
    return fail("storage_unavailable", "Authority room stream is missing");
  }
  const streamSeq = stream.headSeq + 1;
  database
    .prepare(
      `UPDATE streams SET head_seq = ?
       WHERE stream_kind = 'room' AND stream_id = ?`,
    )
    .run(streamSeq, input.roomId);
  database
    .prepare(
      `INSERT INTO events (
         event_id, stream_kind, stream_id, stream_seq, room_id,
         actor_id, event_type, occurred_at, payload_json
       ) VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventId,
      input.roomId,
      streamSeq,
      input.roomId,
      input.actorId,
      input.eventType,
      input.occurredAt,
      canonicalJson(input.payload),
    );
  return streamSeq;
}

function appendRoomOutbox(
  database: DatabaseSync,
  eventId: string,
  roomId: string,
  streamSeq: number,
  occurredAt: string,
  scope: string,
  key: string,
): void {
  database
    .prepare(
      `INSERT INTO outbox_deliveries (
         id, event_id, target_kind, target_id, stream_seq, status,
         attempts, available_at, delivered_at, last_error
       ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
    )
    .run(
      stableId("outbox", scope, key, eventId, "room", roomId),
      eventId,
      roomId,
      streamSeq,
      occurredAt,
    );
}

type IdentityEventTypeAndPayload<Event extends PersistedIdentityEvent = PersistedIdentityEvent> =
  Event extends PersistedIdentityEvent
    ? {
        readonly eventType: Event["type"];
        readonly payload: Event["payload"];
      }
    : never;

export type CanonicalIdentityEventInput = {
  readonly eventId: string | ((canonicalPayloadJson: string) => string);
  readonly principalId: string;
  readonly occurredAt: string;
} & IdentityEventTypeAndPayload;

export function appendCanonicalIdentityEvent(
  database: DatabaseSync,
  input: CanonicalIdentityEventInput,
): number {
  const payloadJson = canonicalJson(input.payload);
  const eventId = typeof input.eventId === "function"
    ? input.eventId(payloadJson)
    : input.eventId;
  const stream = database
    .prepare(
      `SELECT head_seq AS headSeq FROM streams
       WHERE stream_kind = 'identity' AND stream_id = ?`,
    )
    .get(input.principalId);
  if (typeof stream?.headSeq !== "number") {
    return fail("storage_unavailable", "Authority identity stream is missing");
  }
  const streamSeq = stream.headSeq + 1;
  database
    .prepare(
      `UPDATE streams SET head_seq = ?
       WHERE stream_kind = 'identity' AND stream_id = ?`,
    )
    .run(streamSeq, input.principalId);
  database
    .prepare(
      `INSERT INTO events (
         event_id, stream_kind, stream_id, stream_seq, room_id,
         actor_id, event_type, occurred_at, payload_json
       ) VALUES (?, 'identity', ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      input.principalId,
      streamSeq,
      input.principalId,
      input.eventType,
      input.occurredAt,
      payloadJson,
    );
  return streamSeq;
}

function appendPrincipalOutbox(
  database: DatabaseSync,
  eventId: string,
  principalId: string,
  streamSeq: number,
  occurredAt: string,
  scope: string,
  key: string,
): void {
  database
    .prepare(
      `INSERT INTO outbox_deliveries (
         id, event_id, target_kind, target_id, stream_seq, status,
         attempts, available_at, delivered_at, last_error
       ) VALUES (?, ?, 'principal', ?, ?, 'pending', 0, ?, NULL, NULL)`,
    )
    .run(
      stableId("outbox", scope, key, eventId, "principal", principalId),
      eventId,
      principalId,
      streamSeq,
      occurredAt,
    );
}

function executeRoomCreate(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "room.create" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const roomId = stableId("room", scope, key);
  const roomEventId = stableId("event", scope, key, "0");
  const identityEventId = stableId("event", scope, key, "1");
  const membership = {
    kind: "human" as const,
    actorId,
    role: "owner" as const,
    joinedAt: acceptedAt,
  };
  const room = {
    id: roomId,
    name: command.payload.name,
    status: "active" as const,
    members: [membership],
    createdAt: acceptedAt,
  };
  database
    .prepare(
      `INSERT INTO rooms (id, name, status, created_at)
       VALUES (?, ?, 'active', ?)`,
    )
    .run(roomId, room.name, acceptedAt);
  database
    .prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, 'human', 'owner', NULL, '[]', ?, NULL, 0)`,
    )
    .run(roomId, actorId, acceptedAt);
  database
    .prepare(
      `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
       VALUES ('room', ?, 0, 1)`,
    )
    .run(roomId);
  database
    .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
    .run(actorId);
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.created', ?, ?, 'created', ?, '{}')`,
    )
    .run(stableId("audit", scope, key), roomId, actorId, acceptedAt);
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId,
    actorId,
    eventType: "room.created",
    occurredAt: acceptedAt,
    payload: { room } as unknown as JsonValue,
  });
  appendRoomOutbox(database, roomEventId, roomId, roomSeq, acceptedAt, scope, key);
  const identitySeq = appendCanonicalIdentityEvent(database, {
    eventId: identityEventId,
    principalId: actorId,
    eventType: "identity.room-access.changed",
    occurredAt: acceptedAt,
    payload: { roomId, change: "joined" },
  });
  appendPrincipalOutbox(
    database,
    identityEventId,
    actorId,
    identitySeq,
    acceptedAt,
    scope,
    key,
  );
  return {
    aggregateId: roomId,
    eventIds: [roomEventId, identityEventId],
    acceptedAt,
    result: { room } as unknown as JsonValue,
  };
}

function appendCatalogEvents(
  database: DatabaseSync,
  input: {
    readonly roomId: string;
    readonly change: "updated" | "archived";
    readonly acceptedAt: string;
    readonly scope: string;
    readonly key: string;
    readonly startIndex: number;
  },
): readonly string[] {
  const humans = database
    .prepare(
      `SELECT actor_id AS actorId FROM room_memberships
       WHERE room_id = ? AND kind = 'human' ORDER BY actor_id`,
    )
    .all(input.roomId);
  const eventIds: string[] = [];
  for (const [offset, row] of humans.entries()) {
    if (typeof row.actorId !== "string") {
      return fail("storage_unavailable", "Authority human membership is corrupt");
    }
    database
      .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
      .run(row.actorId);
    const eventId = stableId(
      "event",
      input.scope,
      input.key,
      String(input.startIndex + offset),
    );
    const streamSeq = appendCanonicalIdentityEvent(database, {
      eventId,
      principalId: row.actorId,
      eventType: "identity.room-access.changed",
      occurredAt: input.acceptedAt,
      payload: { roomId: input.roomId, change: input.change },
    });
    appendPrincipalOutbox(
      database,
      eventId,
      row.actorId,
      streamSeq,
      input.acceptedAt,
      input.scope,
      input.key,
    );
    eventIds.push(eventId);
  }
  return eventIds;
}

function executeRenameOrArchive(
  database: DatabaseSync,
  actorId: string,
  command: Extract<
    RoomGovernanceCommand,
    { readonly type: "room.rename" | "room.archive" }
  >,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const manager = requireRoomManager(database, actorId, command.roomId);
  if (manager.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  if (command.type === "room.rename") {
    database.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(
      command.payload.name,
      command.roomId,
    );
  } else {
    database.prepare("UPDATE rooms SET status = 'archived' WHERE id = ?").run(
      command.roomId,
    );
  }
  const eventType = command.type === "room.rename" ? "room.renamed" : "room.archived";
  const auditType = eventType;
  const auditResult = command.type === "room.rename" ? "renamed" : "archived";
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, '{}')`,
    )
    .run(
      stableId("audit", scope, key),
      auditType,
      command.roomId,
      actorId,
      auditResult,
      acceptedAt,
    );
  const room = readManagedRoom(database, command.roomId);
  const roomEventId = stableId("event", scope, key, "0");
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId: command.roomId,
    actorId,
    eventType,
    occurredAt: acceptedAt,
    payload: { room },
  });
  appendRoomOutbox(
    database,
    roomEventId,
    command.roomId,
    roomSeq,
    acceptedAt,
    scope,
    key,
  );
  const catalogEventIds = appendCatalogEvents(database, {
    roomId: command.roomId,
    change: command.type === "room.rename" ? "updated" : "archived",
    acceptedAt,
    scope,
    key,
    startIndex: 1,
  });
  return {
    aggregateId: command.roomId,
    eventIds: [roomEventId, ...catalogEventIds],
    acceptedAt,
    result: { room },
  };
}

function executeAgentConfigure(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "agent.configure" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const manager = requireRoomManager(database, actorId, command.roomId);
  if (manager.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  const agent = database
    .prepare(
      `SELECT kind, tool_permissions_json AS toolPermissionsJson
       FROM actors WHERE id = ?`,
    )
    .get(command.payload.agentId);
  if (agent?.kind !== "agent" || typeof agent.toolPermissionsJson !== "string") {
    return fail("agent_required", "Authority Agent configuration was rejected");
  }
  const allowed: unknown = JSON.parse(agent.toolPermissionsJson);
  if (
    !Array.isArray(allowed) ||
    !command.payload.toolPermissions.every((permission) => allowed.includes(permission))
  ) {
    return fail("agent_permissions_invalid", "Authority Agent permissions were rejected");
  }
  const existing = database
    .prepare(
      `SELECT access_revision AS accessRevision
       FROM room_memberships WHERE room_id = ? AND actor_id = ?`,
    )
    .get(command.roomId, command.payload.agentId);
  const accessRevision = typeof existing?.accessRevision === "number"
    ? existing.accessRevision + 1
    : 1;
  database
    .prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, 'agent', NULL, ?, ?, NULL, ?, ?)
       ON CONFLICT(room_id, actor_id) DO UPDATE SET
         kind = 'agent', role = NULL, participation = excluded.participation,
         tool_permissions_json = excluded.tool_permissions_json,
         joined_at = NULL, configured_at = excluded.configured_at,
         access_revision = excluded.access_revision`,
    )
    .run(
      command.roomId,
      command.payload.agentId,
      command.payload.participation,
      canonicalJson(command.payload.toolPermissions),
      acceptedAt,
      accessRevision,
    );
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.agent.configured', ?, ?, 'configured', ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      command.roomId,
      actorId,
      acceptedAt,
      canonicalJson({
        targetActorId: command.payload.agentId,
        participation: command.payload.participation,
        toolPermissions: command.payload.toolPermissions,
      }),
    );
  const room = readManagedRoom(database, command.roomId);
  const membership = (room as { readonly members: readonly JsonValue[] }).members.find(
    (candidate) =>
      isRecord(candidate) && candidate.actorId === command.payload.agentId,
  );
  if (membership === undefined) {
    return fail("storage_unavailable", "Configured Agent membership is missing");
  }
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "agent.configured",
    occurredAt: acceptedAt,
    payload: { membership },
  });
  appendRoomOutbox(
    database,
    eventId,
    command.roomId,
    streamSeq,
    acceptedAt,
    scope,
    key,
  );
  const identityEventId = stableId("event", scope, key, "1");
  appendCanonicalIdentityEvent(database, {
    eventId: identityEventId,
    principalId: command.payload.agentId,
    eventType: "identity.room-access.changed",
    occurredAt: acceptedAt,
    payload: {
      roomId: command.roomId,
      change: existing === undefined ? "joined" : "updated",
    },
  });
  return {
    aggregateId: command.roomId,
    eventIds: [eventId, identityEventId],
    acceptedAt,
    result: { room },
  };
}

function executeInvitationIssue(
  database: DatabaseSync,
  actorId: string,
  command: Extract<
    RoomGovernanceCommand,
    { readonly type: "human.invitation.issue" }
  >,
  invitationSecret: {
    readonly tokenHash: string;
    readonly sealedToken: string;
  } | undefined,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const manager = requireRoomManager(database, actorId, command.roomId);
  if (manager.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  if (invitationSecret === undefined) {
    return fail(
      "invitation_secret_unavailable",
      "Invitation secret protection is unavailable",
    );
  }
  const invitee = database
    .prepare("SELECT kind FROM actors WHERE id = ?")
    .get(command.payload.inviteeActorId);
  if (invitee?.kind !== "human") {
    return fail("invitee_required", "Invitation target must be human");
  }
  if (
    database
      .prepare(
        `SELECT 1 FROM room_memberships
         WHERE room_id = ? AND actor_id = ?`,
      )
      .get(command.roomId, command.payload.inviteeActorId) !== undefined
  ) {
    return fail("room_member_exists", "Invitation target is already a room member");
  }
  if (
    database
      .prepare(
        `SELECT 1 FROM room_invitations
         WHERE room_id = ? AND invitee_actor_id = ? AND status = 'pending'`,
      )
      .get(command.roomId, command.payload.inviteeActorId) !== undefined
  ) {
    return fail("invitation_pending", "A pending invitation already exists");
  }
  const invitationId = stableId("invitation", scope, key);
  database
    .prepare(
      `INSERT INTO room_invitations (
         id, room_id, inviter_actor_id, invitee_actor_id, token_hash, status,
         created_at, decision_actor_id, decided_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
    )
    .run(
      invitationId,
      command.roomId,
      actorId,
      command.payload.inviteeActorId,
      invitationSecret.tokenHash,
      acceptedAt,
    );
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.human.invited', ?, ?, 'pending', ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      command.roomId,
      actorId,
      acceptedAt,
      canonicalJson({
        targetActorId: command.payload.inviteeActorId,
        invitationId,
      }),
    );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "human.invitation.issued",
    occurredAt: acceptedAt,
    payload: {
      invitationId,
      inviteeActorId: command.payload.inviteeActorId,
    },
  });
  appendRoomOutbox(
    database,
    eventId,
    command.roomId,
    streamSeq,
    acceptedAt,
    scope,
    key,
  );
  return {
    aggregateId: invitationId,
    eventIds: [eventId],
    acceptedAt,
    result: {
      invitation: {
        invitationId,
        roomId: command.roomId,
        inviterActorId: actorId,
        inviteeActorId: command.payload.inviteeActorId,
        sealedToken: invitationSecret.sealedToken,
        createdAt: acceptedAt,
      },
    },
  };
}

function executeInvitationDecision(
  database: DatabaseSync,
  actorId: string,
  command: Extract<
    RoomGovernanceCommand,
    { readonly type: "human.invitation.decide" }
  >,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const invitation = invitationByToken(database, command.payload.token);
  if (invitation.inviteeActorId !== actorId) {
    return fail("invitation_forbidden", "Authority invitation identity was rejected");
  }
  if (invitation.status !== "pending") {
    return fail("invitation_consumed", "Authority invitation was already consumed");
  }
  if (typeof invitation.id !== "string" || typeof invitation.roomId !== "string") {
    return fail("storage_unavailable", "Authority invitation is corrupt");
  }
  const room = database.prepare("SELECT status FROM rooms WHERE id = ?").get(invitation.roomId);
  if (command.payload.decision === "accept" && room?.status !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  database
    .prepare(
      `UPDATE room_invitations
       SET status = ?, decision_actor_id = ?, decided_at = ?
       WHERE id = ?`,
    )
    .run(
      command.payload.decision === "accept" ? "accepted" : "rejected",
      actorId,
      acceptedAt,
      invitation.id,
    );
  let membership: JsonValue | undefined;
  if (command.payload.decision === "accept") {
    if (
      database
        .prepare("SELECT 1 FROM room_memberships WHERE room_id = ? AND actor_id = ?")
        .get(invitation.roomId, actorId) !== undefined
    ) {
      return fail("room_member_exists", "Invitation target is already a room member");
    }
    database
      .prepare(
        `INSERT INTO room_memberships (
           room_id, actor_id, kind, role, participation, tool_permissions_json,
           joined_at, configured_at, access_revision
         ) VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 0)`,
      )
      .run(invitation.roomId, actorId, acceptedAt);
    database
      .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
      .run(actorId);
    membership = {
      kind: "human",
      actorId,
      role: "member",
      joinedAt: acceptedAt,
    };
  }
  const accepted = command.payload.decision === "accept";
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      accepted ? "room.invitation.accepted" : "room.invitation.rejected",
      invitation.roomId,
      actorId,
      accepted ? "accepted" : "rejected",
      acceptedAt,
      canonicalJson({
        targetActorId: actorId,
        inviterActorId: invitation.inviterActorId,
        invitationId: invitation.id,
      }),
    );
  const roomEventId = stableId("event", scope, key, "0");
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId: invitation.roomId,
    actorId,
    eventType: accepted
      ? "human.invitation.accepted"
      : "human.invitation.rejected",
    occurredAt: acceptedAt,
    payload: accepted
      ? { invitationId: invitation.id, membership: membership as JsonValue }
      : { invitationId: invitation.id, targetActorId: actorId },
  });
  appendRoomOutbox(
    database,
    roomEventId,
    invitation.roomId,
    roomSeq,
    acceptedAt,
    scope,
    key,
  );
  const eventIds = [roomEventId];
  if (accepted) {
    const identityEventId = stableId("event", scope, key, "1");
    const identitySeq = appendCanonicalIdentityEvent(database, {
      eventId: identityEventId,
      principalId: actorId,
      eventType: "identity.room-access.changed",
      occurredAt: acceptedAt,
      payload: { roomId: invitation.roomId, change: "joined" },
    });
    appendPrincipalOutbox(
      database,
      identityEventId,
      actorId,
      identitySeq,
      acceptedAt,
      scope,
      key,
    );
    eventIds.push(identityEventId);
  }
  return {
    aggregateId: invitation.id,
    eventIds,
    acceptedAt,
    result: {
      invitation: {
        id: invitation.id,
        roomId: invitation.roomId,
        inviterActorId: invitation.inviterActorId as JsonValue,
        inviteeActorId: actorId,
        status: accepted ? "accepted" : "rejected",
        createdAt: invitation.createdAt as JsonValue,
        decisionActorId: actorId,
        decidedAt: acceptedAt,
      },
    },
  };
}

function executeHumanRoleChange(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "human.role.change" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const owner = requireRoomOwner(database, actorId, command.roomId);
  if (owner.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  const target = database
    .prepare(
      `SELECT kind, role, joined_at AS joinedAt
       FROM room_memberships WHERE room_id = ? AND actor_id = ?`,
    )
    .get(command.roomId, command.payload.targetActorId);
  if (target?.kind !== "human" || typeof target.joinedAt !== "string") {
    return fail("room_member_not_found", "Authority human member was not found");
  }
  if (target.role === "owner") {
    return fail("room_owner_required", "Authority room owner cannot be reassigned");
  }
  database
    .prepare(
      `UPDATE room_memberships
       SET role = ?, access_revision = access_revision + 1
       WHERE room_id = ? AND actor_id = ?`,
    )
    .run(command.payload.role, command.roomId, command.payload.targetActorId);
  database
    .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
    .run(command.payload.targetActorId);
  const membership = {
    kind: "human",
    actorId: command.payload.targetActorId,
    role: command.payload.role,
    joinedAt: target.joinedAt,
  };
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.member.role.changed', ?, ?, 'role-changed', ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      command.roomId,
      actorId,
      acceptedAt,
      canonicalJson({
        targetActorId: command.payload.targetActorId,
        role: command.payload.role,
      }),
    );
  const roomEventId = stableId("event", scope, key, "0");
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId: command.roomId,
    actorId,
    eventType: "human.role.changed",
    occurredAt: acceptedAt,
    payload: { membership },
  });
  appendRoomOutbox(database, roomEventId, command.roomId, roomSeq, acceptedAt, scope, key);
  const identityEventId = stableId("event", scope, key, "1");
  const identitySeq = appendCanonicalIdentityEvent(database, {
    eventId: identityEventId,
    principalId: command.payload.targetActorId,
    eventType: "identity.room-access.changed",
    occurredAt: acceptedAt,
    payload: { roomId: command.roomId, change: "updated" },
  });
  appendPrincipalOutbox(
    database,
    identityEventId,
    command.payload.targetActorId,
    identitySeq,
    acceptedAt,
    scope,
    key,
  );
  return {
    aggregateId: command.roomId,
    eventIds: [roomEventId, identityEventId],
    acceptedAt,
    result: { room: readManagedRoom(database, command.roomId) },
  };
}

function executeMemberRemove(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "member.remove" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const manager = requireRoomManager(database, actorId, command.roomId);
  if (manager.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  const target = database
    .prepare(
      `SELECT kind, role FROM room_memberships
       WHERE room_id = ? AND actor_id = ?`,
    )
    .get(command.roomId, command.payload.targetActorId);
  if (target === undefined || (target.kind !== "human" && target.kind !== "agent")) {
    return fail("room_member_not_found", "Authority room member was not found");
  }
  if (target.kind === "human" && target.role === "owner") {
    return fail("room_owner_required", "Authority room owner cannot be removed");
  }
  database
    .prepare("DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?")
    .run(command.roomId, command.payload.targetActorId);
  if (target.kind === "human") {
    database
      .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
      .run(command.payload.targetActorId);
  }
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.member.removed', ?, ?, 'removed', ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      command.roomId,
      actorId,
      acceptedAt,
      canonicalJson({ targetActorId: command.payload.targetActorId }),
    );
  const roomEventId = stableId("event", scope, key, "0");
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId: command.roomId,
    actorId,
    eventType: "member.removed",
    occurredAt: acceptedAt,
    payload: { targetActorId: command.payload.targetActorId },
  });
  appendRoomOutbox(database, roomEventId, command.roomId, roomSeq, acceptedAt, scope, key);
  const eventIds = [roomEventId];
  {
    const identityEventId = stableId("event", scope, key, "1");
    const identitySeq = appendCanonicalIdentityEvent(database, {
      eventId: identityEventId,
      principalId: command.payload.targetActorId,
      eventType: "identity.room-access.changed",
      occurredAt: acceptedAt,
      payload: { roomId: command.roomId, change: "removed" },
    });
    if (target.kind === "human") {
      appendPrincipalOutbox(
        database,
        identityEventId,
        command.payload.targetActorId,
        identitySeq,
        acceptedAt,
        scope,
        key,
      );
    }
    eventIds.push(identityEventId);
  }
  return {
    aggregateId: command.roomId,
    eventIds,
    acceptedAt,
    result: { room: readManagedRoom(database, command.roomId) },
  };
}

function executeMessageSend(
  database: DatabaseSync,
  actorId: string,
  command: Extract<
    HumanCollaborationCommand | AgentCollaborationCommand,
    { readonly type: "message.send" }
  >,
  acceptedAt: string,
  eventId: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  requireRoomMembership(database, actorId, command.roomId);
  const actor = database.prepare("SELECT kind FROM actors WHERE id = ?").get(actorId);
  if (actor?.kind !== "human" && actor?.kind !== "agent") {
    return fail("identity_forbidden", "Message author identity was rejected");
  }
  const message: Message = {
    ...command.payload,
    authorId: actorId,
    authorKind: actor.kind,
  };
  database
    .prepare(
      `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.id,
      message.roomId,
      message.authorId,
      message.authorKind,
      message.body,
      message.sentAt,
    );
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: message.roomId,
    actorId,
    eventType: "room.message.accepted",
    occurredAt: acceptedAt,
    payload: message as unknown as JsonValue,
  });
  appendRoomOutbox(
    database,
    eventId,
    message.roomId,
    streamSeq,
    acceptedAt,
    scope,
    key,
  );
  return {
    aggregateId: message.id,
    eventIds: [eventId],
    acceptedAt,
    result: { message: message as unknown as JsonValue },
  };
}

function executeHumanRead(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand, { readonly type: "human.read.record" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const message = database
    .prepare("SELECT room_id AS roomId FROM messages WHERE id = ?")
    .get(command.payload.messageId);
  if (message?.roomId !== command.roomId) {
    return fail("message_not_found", "Authority room message was not found");
  }
  const receiptId = stableId("human-read", scope, key);
  database
    .prepare(
      `INSERT INTO human_read_receipts (room_id, actor_id, message_id, read_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(command.roomId, actorId, command.payload.messageId, acceptedAt);
  const receipt = {
    id: receiptId,
    messageId: command.payload.messageId,
    readerId: actorId,
    readAt: acceptedAt,
  };
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.human_read.recorded",
    occurredAt: acceptedAt,
    payload: receipt,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: receiptId,
    eventIds: [eventId],
    acceptedAt,
    result: { receipt },
  };
}

function roomMessageAuthor(
  database: DatabaseSync,
  roomId: string,
  messageId: string,
): string {
  const message = database
    .prepare("SELECT room_id AS roomId, author_id AS authorId FROM messages WHERE id = ?")
    .get(messageId);
  if (message?.roomId !== roomId || typeof message.authorId !== "string") {
    return fail("message_not_found", "Authority room message was not found");
  }
  return message.authorId;
}

function requireAssignedRoomMember(
  database: DatabaseSync,
  roomId: string,
  actorId: string,
): void {
  const member = database
    .prepare("SELECT 1 AS present FROM room_memberships WHERE room_id = ? AND actor_id = ?")
    .get(roomId, actorId);
  if (member?.present !== 1) {
    return fail("member_not_found", "Authority open-item owner is not a room member");
  }
}

function executeOpenItemCreate(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand | AgentCollaborationCommand, { readonly type: "open-item.create" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const requesterId = roomMessageAuthor(
    database,
    command.roomId,
    command.payload.sourceMessageId,
  );
  requireAssignedRoomMember(database, command.roomId, command.payload.ownerId);
  const item = {
    id: stableId("open-item", scope, key),
    roomId: command.roomId,
    sourceMessageId: command.payload.sourceMessageId,
    requesterId,
    ownerId: command.payload.ownerId,
    content: command.payload.content,
    status: "pending_response" as const,
    createdAt: acceptedAt,
    transferChain: [] as readonly JsonValue[],
  };
  database
    .prepare(
      `INSERT INTO open_items (
         id, room_id, source_message_id, assigned_actor_id, status, body,
         created_at, resolved_at, requester_actor_id, transfer_chain_json, responded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, '[]', NULL)`,
    )
    .run(
      item.id,
      item.roomId,
      item.sourceMessageId,
      item.ownerId,
      item.status,
      item.content,
      item.createdAt,
      item.requesterId,
    );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.open_item.changed",
    occurredAt: acceptedAt,
    payload: item,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: item.id,
    eventIds: [eventId],
    acceptedAt,
    result: { item },
  };
}

function executeOpenItemTransition(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand | AgentCollaborationCommand, { readonly type: "open-item.transition" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const row = database
    .prepare(
      `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
              requester_actor_id AS requesterId, assigned_actor_id AS ownerId,
              body AS content, status, created_at AS createdAt,
              responded_at AS respondedAt, transfer_chain_json AS transferChainJson
       FROM open_items WHERE id = ?`,
    )
    .get(command.payload.itemId);
  if (row?.roomId !== command.roomId || typeof row.id !== "string" ||
      typeof row.sourceMessageId !== "string" || typeof row.requesterId !== "string" ||
      typeof row.ownerId !== "string" || typeof row.content !== "string" ||
      typeof row.createdAt !== "string" || typeof row.transferChainJson !== "string") {
    return fail("open_item_not_found", "Authority open item was not found");
  }
  const parsedTransfers: unknown = JSON.parse(row.transferChainJson);
  if (!Array.isArray(parsedTransfers)) {
    return fail("storage_unavailable", "Authority open item transfer chain is corrupt");
  }
  let ownerId = row.ownerId;
  let status: "responded" | "deferred" | "transferred";
  let respondedAt = typeof row.respondedAt === "string" ? row.respondedAt : undefined;
  let transferChain = parsedTransfers as JsonValue[];
  if (command.payload.action === "transfer") {
    const targetId = command.payload.targetId;
    const reason = command.payload.reason;
    if (targetId === undefined || reason === undefined) {
      return fail("invalid_request", "Authority open item transfer was rejected");
    }
    requireAssignedRoomMember(database, command.roomId, targetId);
    status = "transferred";
    transferChain = [
      ...transferChain,
      {
        fromId: ownerId,
        toId: targetId,
        reason,
        transferredAt: acceptedAt,
      },
    ];
    ownerId = targetId;
  } else {
    status = command.payload.action === "respond" ? "responded" : "deferred";
    if (status === "responded") {
      respondedAt = acceptedAt;
    }
  }
  const item = {
    id: row.id,
    roomId: command.roomId,
    sourceMessageId: row.sourceMessageId,
    requesterId: row.requesterId,
    ownerId,
    content: row.content,
    status,
    createdAt: row.createdAt,
    ...(respondedAt === undefined ? {} : { respondedAt }),
    transferChain,
  };
  database
    .prepare(
      `UPDATE open_items
       SET assigned_actor_id = ?, status = ?, resolved_at = ?,
           transfer_chain_json = ?, responded_at = ?
       WHERE id = ?`,
    )
    .run(
      ownerId,
      status,
      status === "responded" ? acceptedAt : null,
      canonicalJson(transferChain),
      respondedAt ?? null,
      row.id,
    );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.open_item.changed",
    occurredAt: acceptedAt,
    payload: item,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: row.id,
    eventIds: [eventId],
    acceptedAt,
    result: { item },
  };
}

function executeCalibrationRecord(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand, { readonly type: "calibration.record" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const source = database.prepare(
    `SELECT room_id AS roomId, author_id AS authorId, author_kind AS authorKind
     FROM messages WHERE id = ?`,
  ).get(command.payload.sourceMessageId);
  if (source?.roomId !== command.roomId || source.authorKind !== "agent" ||
      typeof source.authorId !== "string") {
    return fail(
      "calibration_source_invalid",
      "Authority calibration must reference an Agent message",
    );
  }
  const signal = {
    id: stableId("calibration", scope, key),
    sourceMessageId: command.payload.sourceMessageId,
    actorId,
    agentId: source.authorId,
    emoji: command.payload.emoji,
    createdAt: acceptedAt,
  };
  database.prepare(
    `INSERT INTO calibration_signals (
       id, room_id, agent_id, judgment_id, signal, created_at,
       source_message_id, actor_id
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    signal.id,
    command.roomId,
    signal.agentId,
    signal.emoji,
    signal.createdAt,
    signal.sourceMessageId,
    signal.actorId,
  );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.calibration.recorded",
    occurredAt: acceptedAt,
    payload: signal,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: signal.id,
    eventIds: [eventId],
    acceptedAt,
    result: { signal },
  };
}

function recheckHumanCommandAuthority(
  database: DatabaseSync,
  actorId: string,
  command: HumanCollaborationCommand | RoomGovernanceCommand,
): void {
  if (command.type === "room.create") {
    return;
  }
  if (command.type === "human.invitation.decide") {
    const invitation = invitationByToken(database, command.payload.token);
    if (invitation.inviteeActorId !== actorId) {
      return fail("invitation_forbidden", "Authority invitation identity was rejected");
    }
    return;
  }
  if (command.type === "human.role.change") {
    requireRoomOwner(database, actorId, command.roomId);
    return;
  }
  if (
    command.type === "room.rename" ||
    command.type === "room.archive" ||
    command.type === "human.invitation.issue" ||
    command.type === "agent.configure" ||
    command.type === "member.remove"
  ) {
    requireRoomManager(database, actorId, command.roomId);
    return;
  }
  requireRoomMembership(database, actorId, command.roomId);
}

function requireAgentCommandAuthority(
  database: DatabaseSync,
  agentId: string,
  roomId: string,
): void {
  const membership = database
    .prepare(
      `SELECT actor.kind AS actorKind, room.status AS roomStatus
       FROM room_memberships AS membership
       JOIN actors AS actor ON actor.id = membership.actor_id
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE membership.room_id = ?
         AND membership.actor_id = ?
         AND membership.kind = 'agent'`,
    )
    .get(roomId, agentId);
  if (membership?.actorKind !== "agent" || membership.roomStatus !== "active") {
    return fail("room_forbidden", "Authority Agent room access was rejected");
  }
}

function executeAgentJudgment(
  database: DatabaseSync,
  agentId: string,
  command: Extract<AgentCollaborationCommand, { readonly type: "agent.judgment.record" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const message = database
    .prepare("SELECT room_id AS roomId FROM messages WHERE id = ?")
    .get(command.payload.messageId);
  if (message?.roomId !== command.roomId) {
    return fail("message_not_found", "Authority room message was not found");
  }
  const judgmentId = stableId("agent-judgment", scope, key);
  const judgment = {
    id: judgmentId,
    messageId: command.payload.messageId,
    agentId,
    outcome: command.payload.outcome,
    reason: command.payload.reason,
    decidedAt: acceptedAt,
  };
  database
    .prepare(
      `INSERT INTO agent_judgments (
         id, room_id, agent_id, message_id, judgment_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      judgmentId,
      command.roomId,
      agentId,
      command.payload.messageId,
      canonicalJson(judgment),
      acceptedAt,
    );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId: agentId,
    eventType: "room.agent_judgment.recorded",
    occurredAt: acceptedAt,
    payload: judgment,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: judgmentId,
    eventIds: [eventId],
    acceptedAt,
    result: { judgment },
  };
}

function requireAgentToolPermission(
  database: DatabaseSync,
  roomId: string,
  agentId: string,
  toolName: string,
): void {
  const row = database.prepare(
    `SELECT tool_permissions_json AS toolPermissionsJson
     FROM room_memberships
     WHERE room_id = ? AND actor_id = ? AND kind = 'agent'`,
  ).get(roomId, agentId);
  if (typeof row?.toolPermissionsJson !== "string") {
    return fail("room_forbidden", "Authority Agent room access was rejected");
  }
  const parsed: unknown = JSON.parse(row.toolPermissionsJson);
  if (!Array.isArray(parsed) || !parsed.includes(toolName)) {
    return fail("agent_missing_permission", "Authority Agent tool permission was rejected");
  }
}

function executeAgentExecutionTransition(
  database: DatabaseSync,
  agentId: string,
  command: Extract<AgentCollaborationCommand, { readonly type: "agent.execution.transition" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  requireAgentToolPermission(database, command.roomId, agentId, command.payload.toolName);
  const current = database.prepare(
    `SELECT id, room_id AS roomId, agent_id AS agentId,
            trigger_message_id AS sourceMessageId, requester_actor_id AS requesterId,
            tool_name AS toolName, status, started_at AS startedAt,
            completed_at AS completedAt, result_json AS resultJson
     FROM agent_executions WHERE id = ?`,
  ).get(command.payload.executionId);
  let execution: Record<string, JsonValue>;
  if (current === undefined) {
    if (command.payload.status !== "running") {
      return fail("execution_not_running", "Authority Agent execution must start running");
    }
    const requesterId = roomMessageAuthor(
      database,
      command.roomId,
      command.payload.sourceMessageId,
    );
    execution = {
      id: command.payload.executionId,
      roomId: command.roomId,
      sourceMessageId: command.payload.sourceMessageId,
      requesterId,
      agentId,
      toolName: command.payload.toolName,
      status: "running",
      startedAt: acceptedAt,
    };
    database.prepare(
      `INSERT INTO agent_executions (
         id, room_id, agent_id, trigger_message_id, status, started_at,
         completed_at, result_json, requester_actor_id, tool_name
       ) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?)`,
    ).run(
      command.payload.executionId,
      command.roomId,
      agentId,
      command.payload.sourceMessageId,
      acceptedAt,
      requesterId,
      command.payload.toolName,
    );
  } else {
    if (current.roomId !== command.roomId || current.agentId !== agentId ||
        current.sourceMessageId !== command.payload.sourceMessageId ||
        current.toolName !== command.payload.toolName ||
        typeof current.requesterId !== "string" || typeof current.startedAt !== "string") {
      return fail("execution_conflict", "Authority Agent execution identity changed");
    }
    if (current.status !== "running" || command.payload.status === "running") {
      return fail("execution_not_running", "Authority Agent execution is not running");
    }
    execution = {
      id: command.payload.executionId,
      roomId: command.roomId,
      sourceMessageId: command.payload.sourceMessageId,
      requesterId: current.requesterId,
      agentId,
      toolName: command.payload.toolName,
      status: command.payload.status,
      startedAt: current.startedAt,
      completedAt: acceptedAt,
      ...(command.payload.result === undefined ? {} : { result: command.payload.result }),
    };
    database.prepare(
      `UPDATE agent_executions
       SET status = ?, completed_at = ?, result_json = ?
       WHERE id = ?`,
    ).run(
      command.payload.status,
      acceptedAt,
      command.payload.result === undefined ? null : canonicalJson(command.payload.result),
      command.payload.executionId,
    );
  }
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId: agentId,
    eventType: "room.agent_execution.changed",
    occurredAt: acceptedAt,
    payload: execution,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: command.payload.executionId,
    eventIds: [eventId],
    acceptedAt,
    result: { execution },
  };
}

export function executeAgentDatabaseCommand(
  database: DatabaseSync,
  input: ExecuteAgentDatabaseCommandInput,
): CommandAcknowledgement {
  return runAuthorityImmediateTransaction(database, () => {
    const parsed = parsePersistentCommand(input.command);
    if (!parsed.ok) {
      return fail("invalid_request", "Authority Agent command payload was rejected");
    }
    const agentId = input.context.agent.actorId;
    requireAgentCommandAuthority(database, agentId, input.command.roomId);
    return executeIdempotently(database, {
      actorId: agentId,
      command: input.command,
      aggregateKind: "room",
      aggregateId: input.command.roomId,
      idempotencyKey: input.command.type === "message.send"
        ? input.command.payload.id
        : input.context.idempotencyKey,
      now: input.now,
      execute(acceptedAt, scope, key) {
        return input.command.type === "message.send"
          ? executeMessageSend(
              database,
              agentId,
              input.command,
              acceptedAt,
              stableId("event", scope, key, "0"),
              scope,
              key,
            )
          : input.command.type === "agent.judgment.record"
          ? executeAgentJudgment(
              database,
              agentId,
              input.command,
              acceptedAt,
              scope,
              key,
            )
          : input.command.type === "open-item.create"
            ? executeOpenItemCreate(database, agentId, input.command, acceptedAt, scope, key)
            : input.command.type === "open-item.transition"
              ? executeOpenItemTransition(database, agentId, input.command, acceptedAt, scope, key)
              : input.command.type === "agent.execution.transition"
                ? executeAgentExecutionTransition(
                    database,
                    agentId,
                    input.command,
                    acceptedAt,
                    scope,
                    key,
                  )
                : unreachableCommand(input.command);
      },
    });
  });
}

export function executeHumanDatabaseCommand(
  database: DatabaseSync,
  input: ExecuteHumanDatabaseCommandInput,
): CommandAcknowledgement {
  return runAuthorityImmediateTransaction(database, () => {
    const parsed = parsePersistentCommand(input.command);
    if (!parsed.ok) {
      return fail("invalid_request", "Authority command payload was rejected");
    }
    const actorId = requireHumanSession(database, input.context, input.now);
    recheckHumanCommandAuthority(database, actorId, input.command);
    const aggregateKind = input.command.type === "room.create" ? "identity" : "room";
    const aggregateId = input.command.type === "room.create"
      ? actorId
      : input.command.type === "human.invitation.decide"
        ? (() => {
            const invitation = invitationByToken(database, input.command.payload.token);
            return typeof invitation.roomId === "string"
              ? invitation.roomId
              : fail("storage_unavailable", "Authority invitation is corrupt");
          })()
        : input.command.roomId;
    return executeIdempotently(database, {
      actorId,
      command: input.command,
      aggregateKind,
      aggregateId,
      idempotencyKey: input.command.type === "message.send"
        ? input.command.payload.id
        : input.context.idempotencyKey,
      now: input.now,
      execute(acceptedAt, scope, key) {
        const eventId = stableId("event", scope, key, "0");
        return input.command.type === "message.send"
          ? executeMessageSend(
              database,
              actorId,
              input.command,
              acceptedAt,
              eventId,
              scope,
              key,
            )
          : input.command.type === "human.read.record"
            ? executeHumanRead(database, actorId, input.command, acceptedAt, scope, key)
            : input.command.type === "open-item.create"
              ? executeOpenItemCreate(database, actorId, input.command, acceptedAt, scope, key)
            : input.command.type === "open-item.transition"
              ? executeOpenItemTransition(database, actorId, input.command, acceptedAt, scope, key)
              : input.command.type === "calibration.record"
                ? executeCalibrationRecord(database, actorId, input.command, acceptedAt, scope, key)
            : input.command.type === "room.create"
              ? executeRoomCreate(database, actorId, input.command, acceptedAt, scope, key)
              : input.command.type === "room.rename" || input.command.type === "room.archive"
                ? executeRenameOrArchive(database, actorId, input.command, acceptedAt, scope, key)
                : input.command.type === "agent.configure"
                  ? executeAgentConfigure(database, actorId, input.command, acceptedAt, scope, key)
                  : input.command.type === "human.invitation.issue"
                    ? executeInvitationIssue(
                        database,
                        actorId,
                        input.command,
                        input.invitationSecret,
                        acceptedAt,
                        scope,
                        key,
                      )
                    : input.command.type === "human.invitation.decide"
                      ? executeInvitationDecision(database, actorId, input.command, acceptedAt, scope, key)
                      : input.command.type === "human.role.change"
                        ? executeHumanRoleChange(database, actorId, input.command, acceptedAt, scope, key)
                        : input.command.type === "member.remove"
                          ? executeMemberRemove(database, actorId, input.command, acceptedAt, scope, key)
                          : unreachableCommand(input.command);
      },
    });
  });
}
