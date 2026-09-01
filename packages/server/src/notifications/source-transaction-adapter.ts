import type { DatabaseSync } from "node:sqlite";
import type { NotificationProjection } from "@native-im/core";
import type { AuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import {
  useAuthorityTransactionDatabase,
} from "../persistence/authority-transaction-database.js";
import type {
  HumanRequestMessageBinding,
  HumanRequestMessageRecallBinding,
  HumanRequestMessageTransactionParticipant,
} from "../project-loop/message-human-request-participant.js";
import {
  appendNotificationIdentityEventInTransaction,
  markNotificationHandledInTransaction,
  persistNotificationInTransaction,
  type AppendNotificationEventInTransaction,
  type NotificationPersistResult,
} from "./sqlite-authority.js";
import {
  deriveNotificationProducerIntent,
  type NotificationProducerEvidence,
} from "./producer-matrix.js";

const MAX_NOTIFICATIONS_PER_SOURCE_TRANSACTION = 256;

export type NotificationSourceTerminalEvidence =
  | Readonly<{
      sourceKind: "message_mention" | "project_request";
      sourceBoundaryId: string;
      sourceTerminal: "request_terminal";
      occurredAt: string;
    }>
  | Readonly<{
      sourceKind: "tool_confirmation";
      sourceBoundaryId: string;
      sourceTerminal: "confirmation_terminal";
      occurredAt: string;
    }>
  | Readonly<{
      sourceKind: "project_boundary";
      sourceBoundaryId: string;
      sourceTerminal: "project_boundary_released";
      occurredAt: string;
    }>
  | Readonly<{
      sourceKind: "tool_call";
      sourceBoundaryId: string;
      sourceTerminal: "tool_result_acknowledged_or_reviewed";
      occurredAt: string;
    }>
  | Readonly<{
      sourceKind: "agent_execution";
      sourceBoundaryId: string;
      sourceTerminal: "execution_result_acknowledged_or_recovered";
      occurredAt: string;
    }>
  | Readonly<{
      sourceKind: "project_obstacle";
      sourceBoundaryId: string;
      sourceTerminal: "escalation_resolved";
      occurredAt: string;
    }>;

function sameProjection(left: NotificationProjection, right: NotificationProjection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Converts server-owned source evidence and writes its notification fact/event/outbox while the
 * caller still owns the source AuthorityWorker transaction. This function never opens or commits
 * a transaction and therefore cannot become a post-commit notification side channel.
 */
export function persistNotificationProducerEvidenceInTransaction(
  database: DatabaseSync,
  evidence: NotificationProducerEvidence,
  appendEvent: AppendNotificationEventInTransaction =
    appendNotificationIdentityEventInTransaction,
): NotificationPersistResult | null {
  const projection = deriveNotificationProducerIntent(evidence);
  return projection === null
    ? null
    : persistNotificationInTransaction(database, projection, appendEvent);
}

/**
 * Bounded multi-recipient composition for tool results and proactive execution fallback routing.
 * Exact duplicate evidence is collapsed before SQLite writes; conflicting facts with one stable
 * notification identity fail the source transaction instead of choosing a recipient locally.
 */
export function persistNotificationProducerEvidenceBatchInTransaction(
  database: DatabaseSync,
  evidence: readonly NotificationProducerEvidence[],
  appendEvent: AppendNotificationEventInTransaction =
    appendNotificationIdentityEventInTransaction,
): readonly NotificationPersistResult[] {
  if (evidence.length > MAX_NOTIFICATIONS_PER_SOURCE_TRANSACTION) {
    throw new TypeError("Notification source transaction batch exceeded its bound");
  }
  const unique = new Map<string, NotificationProjection>();
  for (const item of evidence) {
    const projection = deriveNotificationProducerIntent(item);
    if (projection === null) continue;
    const previous = unique.get(projection.notificationId);
    if (previous !== undefined && !sameProjection(previous, projection)) {
      throw new Error("Notification source transaction derived a conflicting stable identity");
    }
    unique.set(projection.notificationId, projection);
  }
  return Object.freeze([...unique.values()].map((projection) =>
    persistNotificationInTransaction(database, projection, appendEvent)));
}

/**
 * Projects handled from a closed source-terminal transition. It intentionally accepts neither a
 * recipient nor notification id; the stable source binding selects each currently pending fact.
 * Historical handled rows never consume the bounded terminal batch.
 */
export function projectNotificationSourceTerminalInTransaction(
  database: DatabaseSync,
  evidence: NotificationSourceTerminalEvidence,
  appendEvent: AppendNotificationEventInTransaction =
    appendNotificationIdentityEventInTransaction,
): Readonly<{ matchedCount: number; newlyHandledCount: number }> {
  const sourceKinds = evidence.sourceTerminal === "request_terminal"
    ? ["message_mention", "project_request"] as const
    : [evidence.sourceKind] as const;
  const placeholders = sourceKinds.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT notification_id AS notificationId, handled_at AS handledAt
     FROM notifications
     WHERE source_boundary_id = ? AND source_kind IN (${placeholders})
       AND revoked_at IS NULL AND handled_at IS NULL
     ORDER BY notification_id LIMIT ?`,
  ).all(evidence.sourceBoundaryId, ...sourceKinds,
    MAX_NOTIFICATIONS_PER_SOURCE_TRANSACTION + 1) as unknown as readonly Readonly<{
      notificationId: string;
      handledAt: string | null;
    }>[];
  if (rows.length > MAX_NOTIFICATIONS_PER_SOURCE_TRANSACTION) {
    throw new Error("Notification source terminal fanout exceeded its bound");
  }
  let newlyHandledCount = 0;
  for (const row of rows) {
    if (typeof row.notificationId !== "string" ||
        !(row.handledAt === null || typeof row.handledAt === "string")) {
      throw new Error("Notification source terminal row was corrupt");
    }
    const wasHandled = row.handledAt !== null;
    markNotificationHandledInTransaction(database, {
      notificationId: row.notificationId,
      sourceBoundaryId: evidence.sourceBoundaryId,
      sourceTerminal: evidence.sourceTerminal,
      occurredAt: evidence.occurredAt,
    }, appendEvent);
    if (!wasHandled) newlyHandledCount += 1;
  }
  return Object.freeze({ matchedCount: rows.length, newlyHandledCount });
}

/**
 * Removes a source whose current access-safe projection no longer exists. The caller owns the
 * source transaction, so the source lifecycle transition, recipient revocations, stable events,
 * and outbox rows commit or roll back together.
 */
export function revokeNotificationSourceInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    roomId: string;
    sourceKind: "message_mention";
    sourceId: string;
    revokedAt: string;
  }>,
  appendEvent: AppendNotificationEventInTransaction =
    appendNotificationIdentityEventInTransaction,
): Readonly<{ matchedCount: number; revokedCount: number }> {
  const count = database.prepare(
    `SELECT COUNT(*) AS matchedCount FROM notifications
     WHERE room_id = ? AND source_kind = ? AND source_id = ?`,
  ).get(input.roomId, input.sourceKind, input.sourceId)?.matchedCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Notification source revocation count was corrupt");
  }
  const eventRows = database.prepare(
    `SELECT notification_id AS notificationId, room_id AS roomId,
            recipient_actor_id AS recipientActorId
     FROM notifications
     WHERE room_id = ? AND source_kind = ? AND source_id = ? AND revoked_at IS NULL
     ORDER BY notification_id LIMIT ?`,
  ).all(input.roomId, input.sourceKind, input.sourceId,
    MAX_NOTIFICATIONS_PER_SOURCE_TRANSACTION) as unknown as readonly Readonly<{
      notificationId: string;
      roomId: string;
      recipientActorId: string;
    }>[];
  const updated = database.prepare(
    `UPDATE notifications SET revoked_at = ?, revoke_reason = 'source_inaccessible'
     WHERE room_id = ? AND source_kind = ? AND source_id = ? AND revoked_at IS NULL`,
  ).run(input.revokedAt, input.roomId, input.sourceKind, input.sourceId);
  const revokedCount = Number(updated.changes);
  if (!Number.isSafeInteger(revokedCount) || revokedCount < eventRows.length) {
    throw new Error("Notification source revocation result was corrupt");
  }
  for (const row of eventRows) {
    if (typeof row.notificationId !== "string" || typeof row.roomId !== "string" ||
        typeof row.recipientActorId !== "string") {
      throw new Error("Notification source revocation row was corrupt");
    }
    appendEvent(database, { type: "notification.revoked", occurredAt: input.revokedAt,
      payload: Object.freeze({ notificationId: row.notificationId, roomId: row.roomId,
        recipientActorId: row.recipientActorId, reason: "source_inaccessible" as const }) });
  }
  return Object.freeze({ matchedCount: count, revokedCount });
}

/**
 * Appends a bounded tail of stable revoke events after the source transaction durably revoked its
 * complete projection set. The pending Room recall outbox row is the recovery marker, so this
 * operation needs no second scheduler or epoch: a recalled source can never reopen.
 */
export function recoverNotificationSourceRevocationsInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    roomId: string;
    sourceKind: "message_mention";
    sourceId: string;
    limit: number;
  }>,
  appendEvent: AppendNotificationEventInTransaction =
    appendNotificationIdentityEventInTransaction,
): Readonly<{ recoveredCount: number; hasMore: boolean }> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 ||
      input.limit > MAX_NOTIFICATIONS_PER_SOURCE_TRANSACTION) {
    throw new TypeError("Notification source revocation recovery limit was invalid");
  }
  const rows = database.prepare(
    `SELECT notification.notification_id AS notificationId,
            notification.room_id AS roomId,
            notification.recipient_actor_id AS recipientActorId,
            notification.revoked_at AS revokedAt
     FROM notifications AS notification
     WHERE notification.room_id = ? AND notification.source_kind = ?
       AND notification.source_id = ?
       AND notification.revoked_at IS NOT NULL
       AND notification.revoke_reason = 'source_inaccessible'
       AND NOT EXISTS (
         SELECT 1 FROM events AS event
         WHERE event.event_type = 'notification.revoked'
           AND event.stream_kind = 'identity'
           AND event.stream_id = notification.recipient_actor_id
           AND event.occurred_at = notification.revoked_at
           AND json_extract(event.payload_json, '$.notificationId') =
             notification.notification_id
           AND json_extract(event.payload_json, '$.roomId') = notification.room_id
           AND json_extract(event.payload_json, '$.recipientActorId') =
             notification.recipient_actor_id
           AND json_extract(event.payload_json, '$.reason') = 'source_inaccessible'
       )
     ORDER BY notification.notification_id LIMIT ?`,
  ).all(input.roomId, input.sourceKind, input.sourceId, input.limit + 1) as unknown as readonly
    Readonly<{ notificationId: string; roomId: string; recipientActorId: string;
      revokedAt: string }> [];
  const batch = rows.slice(0, input.limit);
  for (const row of batch) {
    if (typeof row.notificationId !== "string" || typeof row.roomId !== "string" ||
        typeof row.recipientActorId !== "string" || typeof row.revokedAt !== "string") {
      throw new Error("Notification source revocation recovery row was corrupt");
    }
    appendEvent(database, { type: "notification.revoked", occurredAt: row.revokedAt,
      payload: Object.freeze({ notificationId: row.notificationId, roomId: row.roomId,
        recipientActorId: row.recipientActorId, reason: "source_inaccessible" as const }) });
  }
  return Object.freeze({ recoveredCount: batch.length, hasMore: rows.length > input.limit });
}

/**
 * Production-composable participant for the existing Human message -> Project Request seam.
 * The delegate creates/cancels the canonical Request first; notifications are then written through
 * the same unforgeable transaction capability, so a notification failure rolls the message and
 * Project source facts back as one unit.
 */
export function createNotificationAwareHumanRequestParticipant(options: Readonly<{
  delegate: HumanRequestMessageTransactionParticipant;
  appendEvent?: AppendNotificationEventInTransaction;
}>): HumanRequestMessageTransactionParticipant {
  if (typeof options.delegate?.createPendingInTransaction !== "function" ||
      typeof options.delegate.cancelPendingForRecallInTransaction !== "function" ||
      (options.appendEvent !== undefined && typeof options.appendEvent !== "function")) {
    throw new TypeError("Notification-aware Human Request participant composition was invalid");
  }
  const appendEvent = options.appendEvent ?? appendNotificationIdentityEventInTransaction;
  return Object.freeze({
    createPendingInTransaction(
      transaction: AuthorityTransactionView,
      binding: HumanRequestMessageBinding,
    ) {
      const result = options.delegate.createPendingInTransaction(transaction, binding);
      if (result.roomId !== binding.roomId || result.requestIntentId !== binding.requestIntentId) {
        throw new Error("Human Request participant returned a conflicting source binding");
      }
      useAuthorityTransactionDatabase(transaction, (database) => {
        persistNotificationProducerEvidenceBatchInTransaction(database, [
          {
            kind: "human_mention",
            roomId: binding.roomId,
            roomLifecycle: "active",
            createdAt: binding.occurredAt,
            actorId: binding.requesterHumanActorId,
            messageId: binding.sourceMessageId,
            messageRevision: binding.sourceRevision,
            mentionTargetId: binding.sourceTargetId,
            targetHumanActorId: binding.targetHumanActorId,
            targetMembership: "active",
            linkedRequestId: result.requestId,
          },
          {
            kind: "human_request",
            roomId: binding.roomId,
            roomLifecycle: "active",
            createdAt: binding.occurredAt,
            actorId: binding.requesterHumanActorId,
            recipientRelation: "target_pending",
            requestId: result.requestId,
            requestRevision: 1,
            requestBoundaryOrdinal: 0,
            stableTargetHumanActorId: binding.targetHumanActorId,
            targetMembership: "active",
            requestStatus: "pending_acceptance",
          },
        ], appendEvent);
      });
      return result;
    },
    cancelPendingForRecallInTransaction(
      transaction: AuthorityTransactionView,
      binding: HumanRequestMessageRecallBinding,
    ) {
      const result = options.delegate.cancelPendingForRecallInTransaction(transaction, binding);
      if (result.roomId !== binding.roomId || result.sourceMessageId !== binding.sourceMessageId) {
        throw new Error("Human Request recall participant returned a conflicting source binding");
      }
      useAuthorityTransactionDatabase(transaction, (database) => {
        for (const requestId of result.cancelledRequestIds) {
          projectNotificationSourceTerminalInTransaction(database, {
            sourceKind: "project_request",
            sourceBoundaryId: requestId,
            sourceTerminal: "request_terminal",
            occurredAt: binding.occurredAt,
          }, appendEvent);
        }
      });
      return result;
    },
  });
}
