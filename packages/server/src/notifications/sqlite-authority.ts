import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isNotificationProjection,
  type NotificationProjection,
  type NotificationRoomBadge,
  type NotificationRevocation,
} from "@native-im/core";
import {
  applyNotificationHandledProjection,
  markNotificationRead,
  type NotificationReadAuthority,
  type NotificationSourceTerminal,
} from "./domain.js";

export const NOTIFICATION_REPAIR_KEYSET_LIMIT = 256;

type AppendInput =
  | Readonly<{
      type: "notification.created" | "notification.read" | "notification.handled";
      occurredAt: string;
      payload: NotificationProjection;
    }>
  | Readonly<{
      type: "notification.revoked";
      occurredAt: string;
      payload: NotificationRevocation;
    }>;

export type NotificationEventAppendResult = Readonly<{ eventId: string; streamSeq: number }>;

export type AppendNotificationEventInTransaction = (
  database: DatabaseSync,
  input: AppendInput,
) => NotificationEventAppendResult;

type Row = Readonly<{
  notificationId: string;
  roomId: string;
  recipientActorId: string;
  notificationKind: NotificationProjection["notificationKind"];
  sourceKind: NotificationProjection["source"]["sourceKind"];
  sourceId: string;
  sourceRevision: number;
  sourceBoundaryId: string;
  sourceOrdinal: number;
  dedupeKey: string;
  safeActorId: string | null;
  createdAt: string;
  readAt: string | null;
  readRevision: number;
  handledAt: string | null;
  handledRevision: number;
  revokedAt: string | null;
  revokeReason: string | null;
}>;

const columns = `notification_id AS notificationId, room_id AS roomId,
  recipient_actor_id AS recipientActorId, notification_kind AS notificationKind,
  source_kind AS sourceKind, source_id AS sourceId, source_revision AS sourceRevision,
  source_boundary_id AS sourceBoundaryId, source_ordinal AS sourceOrdinal,
  dedupe_key AS dedupeKey, safe_actor_id AS safeActorId, created_at AS createdAt,
  read_at AS readAt, read_revision AS readRevision, handled_at AS handledAt,
  handled_revision AS handledRevision, revoked_at AS revokedAt, revoke_reason AS revokeReason`;

function projection(row: Row): NotificationProjection {
  const value: NotificationProjection = Object.freeze({
    recordVersion: "notification.v1",
    notificationId: row.notificationId,
    roomId: row.roomId,
    recipientActorId: row.recipientActorId,
    notificationKind: row.notificationKind,
    source: Object.freeze({ sourceKind: row.sourceKind, sourceId: row.sourceId,
      sourceRevision: row.sourceRevision, sourceBoundaryId: row.sourceBoundaryId,
      ordinal: row.sourceOrdinal }),
    dedupeKey: row.dedupeKey,
    createdAt: row.createdAt,
    readAt: row.readAt,
    readRevision: row.readRevision,
    handled: row.handledAt !== null,
    handledAt: row.handledAt,
    sourceAccessible: true,
    deepLink: Object.freeze({
      kind: row.sourceKind === "message_mention" ? "message" as const
        : row.sourceKind === "project_request" ? "request" as const
          : row.sourceKind === "tool_confirmation" ? "confirmation" as const
            : row.sourceKind === "project_boundary" ? "project_boundary" as const
              : row.sourceKind === "tool_call" ? "tool_call" as const
                : row.sourceKind === "agent_execution" ? "agent_execution" as const
                  : "project_obstacle" as const,
      targetId: row.sourceId,
    }),
    safeProjection: Object.freeze({ titleKey: row.notificationKind, actorId: row.safeActorId }),
  });
  const handledRevisionValid = value.handled
    ? Number.isSafeInteger(row.handledRevision) && row.handledRevision >= 1
    : row.handledRevision === 0;
  if (!isNotificationProjection(value) || !handledRevisionValid) {
    throw new Error("Notification authority row was corrupt");
  }
  return value;
}

function readById(database: DatabaseSync, notificationId: string): Row | undefined {
  return database.prepare(`SELECT ${columns} FROM notifications WHERE notification_id = ?`)
    .get(notificationId) as Row | undefined;
}

export function readNotificationProjectionById(
  database: DatabaseSync,
  notificationId: string,
): NotificationProjection | null {
  const row = readById(database, notificationId);
  return row === undefined || row.revokedAt !== null ? null : projection(row);
}

function eventIdentity(input: AppendInput): string {
  const revision = input.type === "notification.read" ? input.payload.readRevision
    : input.type === "notification.handled" ? input.payload.handledAt
      : input.type === "notification.revoked" ? `${input.payload.reason}:${input.occurredAt}`
        : input.payload.dedupeKey;
  return createHash("sha256").update(
    `dao.notification.event.v1\0${input.type}\0${input.payload.notificationId}\0${revision}`,
  ).digest("hex");
}

/** Must be called inside the source AuthorityWorker transaction. */
export function appendNotificationIdentityEventInTransaction(
  database: DatabaseSync,
  input: AppendInput,
): NotificationEventAppendResult {
  const recipientActorId = input.payload.recipientActorId;
  const stream = database.prepare(
    "SELECT head_seq AS headSeq FROM streams WHERE stream_kind = 'identity' AND stream_id = ?",
  ).get(recipientActorId);
  if (typeof stream?.headSeq !== "number" || !Number.isSafeInteger(stream.headSeq)) {
    throw new Error("Notification recipient identity stream was unavailable");
  }
  const streamSeq = stream.headSeq + 1;
  const advanced = database.prepare(
    `UPDATE streams SET head_seq = ? WHERE stream_kind = 'identity' AND stream_id = ?
     AND head_seq = ?`,
  ).run(streamSeq, recipientActorId, stream.headSeq);
  if (advanced.changes !== 1) throw new Error("Notification identity stream changed concurrently");
  const eventId = `notification-event-${eventIdentity(input)}`;
  database.prepare(
    `INSERT INTO events (event_id, stream_kind, stream_id, stream_seq, room_id,
       authority_kind, actor_id, event_type, occurred_at, payload_json)
     VALUES (?, 'identity', ?, ?, NULL, 'actor', ?, ?, ?, json(?))`,
  ).run(eventId, recipientActorId, streamSeq, recipientActorId, input.type,
    input.occurredAt, JSON.stringify(input.payload));
  database.prepare(
    `INSERT INTO outbox_deliveries (id, event_id, target_kind, target_id, stream_seq,
       status, attempts, available_at, delivered_at, last_error)
     VALUES (?, ?, 'principal', ?, ?, 'pending', 0, ?, NULL, NULL)`,
  ).run(`outbox:${eventId}`, eventId, recipientActorId, streamSeq, input.occurredAt);
  return Object.freeze({ eventId, streamSeq });
}

export type NotificationPersistResult = Readonly<{
  outcome: "created" | "duplicate";
  projection: NotificationProjection;
  eventId: string;
  streamSeq: number;
}>;

/** Database uniqueness is the final dedupe authority; caller owns BEGIN/COMMIT. */
export function persistNotificationInTransaction(
  database: DatabaseSync,
  fact: NotificationProjection,
  appendEvent: AppendNotificationEventInTransaction,
): NotificationPersistResult {
  if (!isNotificationProjection(fact)) throw new TypeError("Notification fact was invalid");
  const inserted = database.prepare(
    `INSERT INTO notifications (
       notification_id, room_id, recipient_actor_id, notification_kind, source_kind,
       source_id, source_revision, source_boundary_id, source_ordinal, dedupe_key,
       safe_actor_id, created_at, read_at, read_revision, handled_at, handled_revision,
       revoked_at, revoke_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT DO NOTHING`,
  ).run(fact.notificationId, fact.roomId, fact.recipientActorId, fact.notificationKind,
    fact.source.sourceKind, fact.source.sourceId, fact.source.sourceRevision,
    fact.source.sourceBoundaryId, fact.source.ordinal, fact.dedupeKey,
    fact.safeProjection.actorId, fact.createdAt, fact.readAt, fact.readRevision,
    fact.handledAt, fact.handled ? 1 : 0);
  if (inserted.changes === 1) {
    const event = appendEvent(database, { type: "notification.created",
      occurredAt: fact.createdAt, payload: fact });
    return Object.freeze({ outcome: "created", projection: fact, ...event });
  }
  const row = database.prepare(
    `SELECT ${columns} FROM notifications
     WHERE dedupe_key = ? OR (recipient_actor_id = ? AND source_boundary_id = ?
       AND notification_kind = ? AND source_ordinal = ?)`,
  ).get(fact.dedupeKey, fact.recipientActorId, fact.source.sourceBoundaryId,
    fact.notificationKind, fact.source.ordinal) as Row | undefined;
  if (row === undefined || row.notificationId !== fact.notificationId ||
      row.dedupeKey !== fact.dedupeKey) throw new Error("Notification dedupe collision was corrupt");
  const existing = projection(row);
  const eventId = `notification-event-${eventIdentity({ type: "notification.created",
    occurredAt: existing.createdAt, payload: existing })}`;
  const event = database.prepare(
    "SELECT stream_seq AS streamSeq FROM events WHERE event_id = ?",
  ).get(eventId);
  if (typeof event?.streamSeq !== "number") throw new Error("Notification created event was missing");
  return Object.freeze({ outcome: "duplicate", projection: existing,
    eventId, streamSeq: event.streamSeq });
}

export function listNotificationProjections(database: DatabaseSync, input: Readonly<{
  recipientActorId: string;
  roomId: string | null;
  before: Readonly<{ createdAt: string; notificationId: string }> | null;
  limit: number;
}>): readonly NotificationProjection[] {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 257) {
    throw new TypeError("Notification list limit was invalid");
  }
  const roomClause = input.roomId === null ? "" : " AND room_id = ?";
  const beforeClause = input.before === null ? "" :
    " AND (created_at < ? OR (created_at = ? AND notification_id < ?))";
  const parameters: (string | number | null)[] = [input.recipientActorId];
  if (input.roomId !== null) parameters.push(input.roomId);
  if (input.before !== null) parameters.push(input.before.createdAt,
    input.before.createdAt, input.before.notificationId);
  parameters.push(input.limit);
  const rows = database.prepare(
    `SELECT ${columns} FROM notifications
     WHERE recipient_actor_id = ? AND revoked_at IS NULL
       AND EXISTS (
         SELECT 1 FROM room_memberships AS membership
         WHERE membership.room_id = notifications.room_id
           AND membership.actor_id = notifications.recipient_actor_id
           AND membership.kind = 'human'
       )${roomClause}${beforeClause}
     ORDER BY created_at DESC, notification_id DESC LIMIT ?`,
  ).all(...parameters) as unknown as readonly Row[];
  return Object.freeze(rows.map(projection));
}

export function listNotificationRoomBadges(
  database: DatabaseSync,
  recipientActorId: string,
): readonly NotificationRoomBadge[] {
  const rows = database.prepare(
    `SELECT notification.room_id AS roomId,
            SUM(CASE WHEN notification.read_at IS NULL THEN 1 ELSE 0 END) AS unreadCount,
            SUM(CASE WHEN notification.handled_at IS NULL THEN 1 ELSE 0 END) AS unhandledCount
     FROM notifications AS notification
     WHERE notification.recipient_actor_id = ? AND notification.revoked_at IS NULL
       AND EXISTS (
         SELECT 1 FROM room_memberships AS membership
         WHERE membership.room_id = notification.room_id
           AND membership.actor_id = notification.recipient_actor_id
           AND membership.kind = 'human'
       )
     GROUP BY notification.room_id ORDER BY notification.room_id`,
  ).all(recipientActorId) as unknown as readonly Readonly<{
    roomId: string;
    unreadCount: number;
    unhandledCount: number;
  }>[];
  return Object.freeze(rows.map((row) => {
    if (typeof row.roomId !== "string" || !Number.isSafeInteger(row.unreadCount) ||
        row.unreadCount < 0 || !Number.isSafeInteger(row.unhandledCount) ||
        row.unhandledCount < 0) throw new Error("Notification badge projection was corrupt");
    return Object.freeze({ ...row });
  }));
}

/** Recipient- and Room-scoped ascending page used only by the closed repair registry. */
export function readNotificationRepairPage(database: DatabaseSync, input: Readonly<{
  recipientActorId: string;
  roomId: string;
  afterNotificationId: string | undefined;
  limit: number;
}>): readonly Readonly<{ kind: "notification"; value: NotificationProjection }>[] {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 ||
      input.limit > NOTIFICATION_REPAIR_KEYSET_LIMIT) {
    throw new TypeError("Notification repair limit was invalid");
  }
  const rows = database.prepare(
    `SELECT ${columns} FROM notifications
     WHERE recipient_actor_id = ? AND room_id = ? AND revoked_at IS NULL
       AND notification_id > ?
     ORDER BY notification_id LIMIT ?`,
  ).all(input.recipientActorId, input.roomId, input.afterNotificationId ?? "", input.limit) as
    unknown as readonly Row[];
  return Object.freeze(rows.map((row) => Object.freeze({
    kind: "notification" as const,
    value: projection(row),
  })));
}

export function markNotificationReadInTransaction(
  database: DatabaseSync,
  input: NotificationReadAuthority & Readonly<{ notificationId: string }>,
  appendEvent: AppendNotificationEventInTransaction,
): Readonly<{
  outcome: "read" | "already_read";
  projection: NotificationProjection;
  eventId: string;
  streamSeq: number;
}> {
  const row = readById(database, input.notificationId);
  if (row === undefined || row.revokedAt !== null) {
    throw new Error("Notification source is inaccessible");
  }
  const result = markNotificationRead(projection(row), input);
  if (result.outcome === "already_read") {
    const eventId = `notification-event-${eventIdentity({ type: "notification.read",
      occurredAt: result.projection.readAt!, payload: result.projection })}`;
    const event = database.prepare("SELECT stream_seq AS streamSeq FROM events WHERE event_id = ?")
      .get(eventId);
    if (typeof event?.streamSeq !== "number") throw new Error("Notification read event was missing");
    return Object.freeze({ outcome: "already_read", projection: result.projection,
      eventId, streamSeq: event.streamSeq });
  }
  const updated = database.prepare(
    `UPDATE notifications SET read_at = ?, read_revision = ?
     WHERE notification_id = ? AND read_revision = ? AND read_at IS NULL AND revoked_at IS NULL`,
  ).run(result.projection.readAt, result.projection.readRevision, input.notificationId,
    input.expectedReadRevision);
  if (updated.changes !== 1) throw new Error("Notification read compare-and-set failed");
  const event = appendEvent(database, { type: "notification.read", occurredAt: input.readAt,
    payload: result.projection });
  return Object.freeze({ outcome: "read", projection: result.projection, ...event });
}

export function markNotificationHandledInTransaction(database: DatabaseSync, input: Readonly<{
  notificationId: string;
  sourceBoundaryId: string;
  sourceTerminal: NotificationSourceTerminal;
  occurredAt: string;
}>, appendEvent: AppendNotificationEventInTransaction): NotificationProjection {
  const row = readById(database, input.notificationId);
  if (row === undefined || row.revokedAt !== null) throw new Error("Notification source is inaccessible");
  const current = projection(row);
  const handled = applyNotificationHandledProjection(current, input);
  if (handled === current) return current;
  const updated = database.prepare(
    `UPDATE notifications SET handled_at = ?, handled_revision = handled_revision + 1
     WHERE notification_id = ? AND handled_at IS NULL AND revoked_at IS NULL`,
  ).run(handled.handledAt, input.notificationId);
  if (updated.changes !== 1) throw new Error("Notification handled compare-and-set failed");
  appendEvent(database, { type: "notification.handled", occurredAt: input.occurredAt,
    payload: handled });
  return handled;
}

export function revokeNotificationsForRecipientInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    roomId: string;
    recipientActorId: string;
    reason: NotificationRevocation["reason"];
    revokedAt: string;
    limit: number;
  }>,
  appendEvent: AppendNotificationEventInTransaction,
): Readonly<{ revokedCount: number; hasMore: boolean }> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
    throw new TypeError("Notification revoke limit was invalid");
  }
  const rows = database.prepare(
    `SELECT ${columns} FROM notifications WHERE room_id = ? AND recipient_actor_id = ?
       AND revoked_at IS NULL ORDER BY notification_id LIMIT ?`,
  ).all(input.roomId, input.recipientActorId, input.limit + 1) as unknown as readonly Row[];
  const batch = rows.slice(0, input.limit);
  for (const row of batch) {
    const updated = database.prepare(
      `UPDATE notifications SET revoked_at = ?, revoke_reason = ?
       WHERE notification_id = ? AND revoked_at IS NULL`,
    ).run(input.revokedAt, input.reason, row.notificationId);
    if (updated.changes !== 1) throw new Error("Notification revoke compare-and-set failed");
    appendEvent(database, { type: "notification.revoked", occurredAt: input.revokedAt,
      payload: Object.freeze({ notificationId: row.notificationId, roomId: row.roomId,
        recipientActorId: row.recipientActorId, reason: input.reason }) });
  }
  return Object.freeze({ revokedCount: batch.length, hasMore: rows.length > input.limit });
}

/**
 * Membership removal is an access boundary, not an ordinary fanout job. Revoke
 * every pre-existing durable projection with one set-based statement so a fast
 * rejoin can never make an old boundary visible again. Per-item stable events
 * remain bounded; the same transaction's identity.room-access.changed event is
 * the authoritative cache-clear signal for the complete Room slice.
 */
export function revokeAllNotificationsForMembershipInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    roomId: string;
    recipientActorId: string;
    revokedAt: string;
    eventLimit: number;
  }>,
  appendEvent: AppendNotificationEventInTransaction,
): Readonly<{ revokedCount: number; emittedEventCount: number }> {
  if (!Number.isSafeInteger(input.eventLimit) || input.eventLimit < 1 ||
      input.eventLimit > 256) {
    throw new TypeError("Notification membership revoke event limit was invalid");
  }
  const eventRows = database.prepare(
    `SELECT ${columns} FROM notifications WHERE room_id = ? AND recipient_actor_id = ?
       AND revoked_at IS NULL ORDER BY notification_id LIMIT ?`,
  ).all(input.roomId, input.recipientActorId, input.eventLimit) as unknown as readonly Row[];
  const updated = database.prepare(
    `UPDATE notifications SET revoked_at = ?, revoke_reason = 'membership_revoked'
     WHERE room_id = ? AND recipient_actor_id = ? AND revoked_at IS NULL`,
  ).run(input.revokedAt, input.roomId, input.recipientActorId);
  const revokedCount = Number(updated.changes);
  if (!Number.isSafeInteger(revokedCount) || revokedCount < eventRows.length) {
    throw new Error("Notification membership revoke result was corrupt");
  }
  for (const row of eventRows) {
    appendEvent(database, {
      type: "notification.revoked",
      occurredAt: input.revokedAt,
      payload: Object.freeze({
        notificationId: row.notificationId,
        roomId: row.roomId,
        recipientActorId: row.recipientActorId,
        reason: "membership_revoked" as const,
      }),
    });
  }
  return Object.freeze({
    revokedCount,
    emittedEventCount: eventRows.length,
  });
}

export function revokeNotificationInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    notificationId: string;
    reason: NotificationRevocation["reason"];
    revokedAt: string;
  }>,
  appendEvent: AppendNotificationEventInTransaction,
): boolean {
  const row = readById(database, input.notificationId);
  if (row === undefined || row.revokedAt !== null) return false;
  const updated = database.prepare(
    `UPDATE notifications SET revoked_at = ?, revoke_reason = ?
     WHERE notification_id = ? AND revoked_at IS NULL`,
  ).run(input.revokedAt, input.reason, input.notificationId);
  if (updated.changes !== 1) throw new Error("Notification revoke compare-and-set failed");
  appendEvent(database, { type: "notification.revoked", occurredAt: input.revokedAt,
    payload: Object.freeze({ notificationId: row.notificationId, roomId: row.roomId,
      recipientActorId: row.recipientActorId, reason: input.reason }) });
  return true;
}
