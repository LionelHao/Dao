import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isNotificationReadAck,
  type NotificationProjection,
  type NotificationReadAck,
} from "@native-im/core";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import type {
  NotificationAuthorityFailure,
  NotificationAuthorityOperation,
  NotificationAuthorityResult,
} from "./authority-protocol.js";
import {
  appendNotificationIdentityEventInTransaction,
  listNotificationProjections,
  listNotificationRoomBadges,
  markNotificationHandledInTransaction,
  markNotificationReadInTransaction,
  persistNotificationInTransaction,
  readNotificationProjectionById,
  revokeNotificationInTransaction,
  revokeNotificationsForRecipientInTransaction,
} from "./sqlite-authority.js";
import { recoverNotificationSourceRevocationsInTransaction } from
  "./source-transaction-adapter.js";

const failure = (code: NotificationAuthorityFailure["code"], status: NotificationAuthorityFailure["status"]):
  NotificationAuthorityFailure => Object.freeze({ kind: "failure", code, status });

function authorize(database: DatabaseSync, context: AuthenticatedSessionContext, now: number):
  NotificationAuthorityFailure | Readonly<{ actorId: string }> {
  const session = database.prepare(
    `SELECT session.family_id AS familyId, session.account_id AS accountId,
            session.actor_id AS actorId, session.access_expires_at AS accessExpiresAt,
            session.revoked_at AS revokedAt, actor.kind AS actorKind
     FROM sessions AS session JOIN actors AS actor ON actor.id = session.actor_id
     WHERE session.access_token_hash = ?`,
  ).get(context.sessionId);
  if (session === undefined || session.actorKind !== "human") return failure("unauthenticated", 401);
  if (session.familyId !== context.sessionFamilyId ||
      session.accountId !== context.principal.accountId ||
      session.actorId !== context.principal.actorId) return failure("forbidden", 403);
  if (session.revokedAt !== null || typeof session.accessExpiresAt !== "number" ||
      now >= session.accessExpiresAt) return failure("unauthenticated", 401);
  return Object.freeze({ actorId: context.principal.actorId });
}

function membership(database: DatabaseSync, actorId: string, roomId: string):
  NotificationAuthorityFailure | Readonly<{ lifecycle: "active" | "archived" }> {
  const row = database.prepare(
    `SELECT room.status AS lifecycle FROM rooms AS room
     JOIN room_memberships AS membership ON membership.room_id = room.id
     WHERE room.id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
  ).get(roomId, actorId);
  if (row === undefined) return failure("forbidden", 403);
  if (row.lifecycle !== "active" && row.lifecycle !== "archived") return failure("invalid_request", 400);
  return Object.freeze({ lifecycle: row.lifecycle });
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function notificationSourceIsAccessible(
  database: DatabaseSync,
  projection: NotificationProjection,
): boolean {
  const source = projection.source;
  if (source.sourceKind === "message_mention") {
    return database.prepare(
      `SELECT 1 AS present FROM message_envelopes
       WHERE message_id = ? AND room_id = ? AND lifecycle = 'active'`,
    ).get(source.sourceId, projection.roomId)?.present === 1;
  }
  if (source.sourceKind === "project_request") {
    return database.prepare(
      "SELECT 1 AS present FROM project_requests WHERE id = ? AND room_id = ?",
    ).get(source.sourceId, projection.roomId)?.present === 1;
  }
  if (source.sourceKind === "tool_confirmation") {
    return database.prepare(
      `SELECT 1 AS present FROM tool_confirmations_v2 AS confirmation
       JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
       WHERE confirmation.confirmation_id = ? AND call.room_id = ?`,
    ).get(source.sourceId, projection.roomId)?.present === 1;
  }
  if (source.sourceKind === "project_boundary") {
    return database.prepare(
      "SELECT 1 AS present FROM project_ball_boundaries WHERE boundary_id = ? AND room_id = ?",
    ).get(source.sourceId, projection.roomId)?.present === 1;
  }
  if (source.sourceKind === "tool_call") {
    return database.prepare(
      "SELECT 1 AS present FROM tool_calls_v2 WHERE tool_call_id = ? AND room_id = ?",
    ).get(source.sourceId, projection.roomId)?.present === 1;
  }
  if (source.sourceKind === "agent_execution") {
    return database.prepare(
      `SELECT 1 AS present FROM agent_executions WHERE id = ? AND room_id = ?
       UNION ALL
       SELECT 1 AS present FROM project_boundary_agent_executions
       WHERE execution_id = ? AND room_id = ? LIMIT 1`,
    ).get(source.sourceId, projection.roomId, source.sourceId, projection.roomId)?.present === 1;
  }
  return database.prepare(
    "SELECT 1 AS present FROM project_obstacles WHERE id = ? AND room_id = ?",
  ).get(source.sourceId, projection.roomId)?.present === 1;
}

function requestSha(operation: Extract<NotificationAuthorityOperation,
  { type: "notification.mark-read" }>): string {
  return createHash("sha256").update(JSON.stringify({
    notificationId: operation.notificationId,
    expectedReadRevision: operation.expectedReadRevision,
  })).digest("hex");
}

export function executeNotificationAuthorityOperation(
  database: DatabaseSync,
  operation: NotificationAuthorityOperation,
): NotificationAuthorityResult {
  if (operation.type === "notification.create") {
    const result = transaction(database, () => persistNotificationInTransaction(
      database, operation.fact, appendNotificationIdentityEventInTransaction));
    return Object.freeze({ kind: result.outcome, projection: result.projection,
      eventId: result.eventId, streamSeq: result.streamSeq });
  }
  if (operation.type === "notification.list") {
    const principal = authorize(database, operation.context, operation.now);
    if ("kind" in principal) return principal;
    if (operation.roomId !== null) {
      const access = membership(database, principal.actorId, operation.roomId);
      if ("kind" in access) return access;
    }
    const stream = database.prepare(
      "SELECT head_seq AS headSeq FROM streams WHERE stream_kind = 'identity' AND stream_id = ?",
    ).get(principal.actorId);
    if (typeof stream?.headSeq !== "number" || !Number.isSafeInteger(stream.headSeq) ||
        stream.headSeq < 0) throw new Error("Notification identity stream was unavailable");
    const listed = listNotificationProjections(database, {
      recipientActorId: principal.actorId, roomId: operation.roomId,
      before: operation.before, limit: operation.limit + 1,
    });
    return Object.freeze({ kind: "list", notifications: listed.slice(0, operation.limit),
      hasMore: listed.length > operation.limit,
      roomBadges: listNotificationRoomBadges(database, principal.actorId),
      identityWatermark: stream.headSeq });
  }
  if (operation.type === "notification.mark-read") {
    return transaction(database, () => {
      const principal = authorize(database, operation.context, operation.now);
      if ("kind" in principal) return principal;
      const row = database.prepare(
        `SELECT room_id AS roomId, recipient_actor_id AS recipientActorId,
                revoked_at AS revokedAt
         FROM notifications WHERE notification_id = ?`,
      ).get(operation.notificationId);
      if (row === undefined) return failure("not_found", 404);
      if (row.recipientActorId !== principal.actorId) return failure("forbidden", 403);
      const access = membership(database, principal.actorId, String(row.roomId));
      if ("kind" in access) return access;
      if (access.lifecycle === "archived") return failure("room_archived", 409);
      if (row.revokedAt !== null) return failure("source_inaccessible", 410);
      const sha = requestSha(operation);
      const receipt = database.prepare(
        `SELECT request_sha256 AS requestSha256, response_json AS responseJson
         FROM notification_command_receipts
         WHERE recipient_actor_id = ? AND request_id = ?`,
      ).get(principal.actorId, operation.commandRequestId);
      if (receipt !== undefined) {
        if (receipt.requestSha256 !== sha) return failure("revision_conflict", 409);
        const ack = JSON.parse(String(receipt.responseJson));
        if (!isNotificationReadAck(ack)) throw new Error("Notification read receipt was corrupt");
        return Object.freeze({ kind: "read" as const, ack });
      }
      let result;
      try {
        result = markNotificationReadInTransaction(database, {
          notificationId: operation.notificationId,
          principal: { kind: "human", actorId: principal.actorId },
          session: "active", membership: "active", sourceAccessible: true,
          availability: "ready", expectedReadRevision: operation.expectedReadRevision,
          readAt: operation.occurredAt,
        }, appendNotificationIdentityEventInTransaction);
      } catch (error) {
        if (error instanceof Error && /revision|compare-and-set/i.test(error.message)) {
          return failure("revision_conflict", 409);
        }
        throw error;
      }
      const ack: NotificationReadAck = Object.freeze({
        type: "notification.read.ack", requestId: operation.commandRequestId,
        notificationId: result.projection.notificationId, roomId: result.projection.roomId,
        recipientActorId: result.projection.recipientActorId, outcome: result.outcome,
        readAt: result.projection.readAt!, readRevision: result.projection.readRevision,
        eventId: result.eventId,
      });
      database.prepare(
        `INSERT INTO notification_command_receipts (
           recipient_actor_id, request_id, command_kind, request_sha256,
           notification_id, response_json, committed_at, expires_at
         ) VALUES (?, ?, 'mark_read', ?, ?, json(?), ?, ?)`,
      ).run(principal.actorId, operation.commandRequestId, sha, operation.notificationId,
        JSON.stringify(ack), operation.occurredAt,
        new Date(Date.parse(operation.occurredAt) + 30 * 24 * 60 * 60_000).toISOString());
      return Object.freeze({ kind: "read" as const, ack });
    });
  }
  if (operation.type === "notification.resolve-source") {
    return transaction(database, () => {
      const principal = authorize(database, operation.context, operation.now);
      if ("kind" in principal) return principal;
      const projection = readNotificationProjectionById(database, operation.notificationId);
      if (projection === null) return failure("source_inaccessible", 410);
      if (projection.recipientActorId !== principal.actorId) return failure("forbidden", 403);
      const access = membership(database, principal.actorId, projection.roomId);
      if ("kind" in access) return access;
      if (!notificationSourceIsAccessible(database, projection)) {
        revokeNotificationInTransaction(database, {
          notificationId: projection.notificationId,
          reason: "source_inaccessible",
          revokedAt: new Date(operation.now).toISOString(),
        }, appendNotificationIdentityEventInTransaction);
        return failure("source_inaccessible", 410);
      }
      return Object.freeze({ kind: "source", projection });
    });
  }
  if (operation.type === "notification.acknowledge-tool-result") {
    return transaction(database, () => {
      const principal = authorize(database, operation.context, operation.now);
      if ("kind" in principal) return principal;
      const row = database.prepare(
        `SELECT notification.room_id AS roomId,
                notification.recipient_actor_id AS recipientActorId,
                notification.source_kind AS sourceKind,
                notification.source_id AS sourceId,
                notification.source_boundary_id AS sourceBoundaryId,
                notification.handled_at AS handledAt,
                notification.revoked_at AS revokedAt,
                dispatch.state AS dispatchState
         FROM notifications AS notification
         LEFT JOIN tool_calls_v2 AS call
           ON call.tool_call_id = notification.source_id
         LEFT JOIN tool_dispatches_v2 AS dispatch
           ON dispatch.tool_call_id = call.tool_call_id
         WHERE notification.notification_id = ?`,
      ).get(operation.notificationId);
      if (row === undefined) return failure("not_found", 404);
      if (row.recipientActorId !== principal.actorId) return failure("forbidden", 403);
      const access = membership(database, principal.actorId, String(row.roomId));
      if ("kind" in access) return access;
      if (access.lifecycle === "archived") return failure("room_archived", 409);
      if (row.revokedAt !== null) return failure("source_inaccessible", 410);
      if (row.sourceKind !== "tool_call" || typeof row.sourceId !== "string" ||
          row.sourceBoundaryId !== row.sourceId ||
          (row.dispatchState !== "known_succeeded" &&
            row.dispatchState !== "known_failed" &&
            row.dispatchState !== "revoked_before_dispatch")) {
        return failure("revision_conflict", 409);
      }
      const projection = markNotificationHandledInTransaction(database, {
        notificationId: operation.notificationId,
        sourceBoundaryId: row.sourceBoundaryId,
        sourceTerminal: "tool_result_acknowledged_or_reviewed",
        occurredAt: operation.occurredAt,
      }, appendNotificationIdentityEventInTransaction);
      return Object.freeze({ kind: "acknowledged" as const, projection,
        outcome: row.handledAt === null
          ? "acknowledged" as const : "already_acknowledged" as const });
    });
  }
  if (operation.type === "notification.acknowledge-execution-result") {
    return transaction(database, () => {
      const principal = authorize(database, operation.context, operation.now);
      if ("kind" in principal) return principal;
      const row = database.prepare(
        `SELECT room_id AS roomId, recipient_actor_id AS recipientActorId,
                notification_kind AS notificationKind, source_kind AS sourceKind,
                source_id AS sourceId, source_revision AS sourceRevision,
                source_boundary_id AS sourceBoundaryId, handled_at AS handledAt,
                revoked_at AS revokedAt
         FROM notifications WHERE notification_id = ?`,
      ).get(operation.notificationId);
      if (row === undefined) return failure("source_inaccessible", 410);
      if (row.recipientActorId !== principal.actorId) return failure("forbidden", 403);
      const access = membership(database, principal.actorId, String(row.roomId));
      if ("kind" in access) return access;
      if (access.lifecycle === "archived") return failure("room_archived", 409);
      if (row.revokedAt !== null) return failure("source_inaccessible", 410);
      if (row.sourceKind !== "agent_execution" || typeof row.sourceId !== "string" ||
          row.sourceBoundaryId !== row.sourceId ||
          (row.notificationKind !== "agent_execution_completed" &&
            row.notificationKind !== "agent_execution_failed")) {
        return failure("revision_conflict", 409);
      }
      const direct = database.prepare(
        `SELECT room_id AS roomId, status, current_attempt_seq AS sourceRevision
         FROM agent_executions WHERE id = ?`,
      ).get(row.sourceId);
      const boundary = direct === undefined ? database.prepare(
        `SELECT room_id AS roomId, public_status AS status, authority_version AS sourceRevision
         FROM project_boundary_agent_executions WHERE execution_id = ?`,
      ).get(row.sourceId) : undefined;
      const source = direct ?? boundary;
      if (source === undefined || source.roomId !== row.roomId) {
        return failure("source_inaccessible", 410);
      }
      const expectedStatus = row.notificationKind === "agent_execution_completed"
        ? "completed" : "failed";
      if (source.status !== expectedStatus || source.sourceRevision !== row.sourceRevision) {
        return failure("revision_conflict", 409);
      }
      const projection = markNotificationHandledInTransaction(database, {
        notificationId: operation.notificationId,
        sourceBoundaryId: row.sourceBoundaryId,
        sourceTerminal: "execution_result_acknowledged_or_recovered",
        occurredAt: operation.occurredAt,
      }, appendNotificationIdentityEventInTransaction);
      return Object.freeze({ kind: "acknowledged" as const, projection,
        outcome: row.handledAt === null
          ? "acknowledged" as const : "already_acknowledged" as const });
    });
  }
  if (operation.type === "notification.source-handled") {
    const projection = transaction(database, () => markNotificationHandledInTransaction(
      database, operation, appendNotificationIdentityEventInTransaction));
    return Object.freeze({ kind: "handled", projection });
  }
  if (operation.type === "notification.recover-source-revocations") {
    const recovered = transaction(database, () =>
      recoverNotificationSourceRevocationsInTransaction(database, operation,
        appendNotificationIdentityEventInTransaction));
    return Object.freeze({ kind: "source-revocations-recovered", ...recovered });
  }
  const revoked = transaction(database, () => revokeNotificationsForRecipientInTransaction(
    database, operation, appendNotificationIdentityEventInTransaction));
  return Object.freeze({ kind: "revoked", ...revoked });
}
