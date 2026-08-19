import { isMessage } from "@native-im/core";
import type {
  OutboxDelivery,
  OutboxDeliveryFailureReason,
  OutboxDispatchCandidate,
  SyncQueryStore,
} from "./persistence/contracts.js";
import type {
  AuthSessionRevokedFrame,
  IdentityRoomAccessChangedFrame,
  MessageCreatedFrame,
  RoomEventFrame,
} from "./protocol.js";
import type { SubscriptionRegistry } from "./subscription-registry.js";

export type OutboxDispatchFrame =
  | MessageCreatedFrame
  | RoomEventFrame
  | IdentityRoomAccessChangedFrame
  | AuthSessionRevokedFrame;

export type OutboxSendResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: OutboxDeliveryFailureReason;
    };

export type OutboxDispatchStore = Pick<
  SyncQueryStore,
  | "listPendingOutbox"
  | "authorizeOutboxCandidate"
  | "markOutboxDispatched"
  | "markOutboxFailed"
>;

export interface OutboxDispatcher {
  flushOnce(): Promise<number>;
  start(): void;
  close(): Promise<void>;
}

export interface OutboxDispatcherOptions {
  readonly store: OutboxDispatchStore;
  readonly registry: SubscriptionRegistry;
  readonly send: (
    candidate: OutboxDispatchCandidate,
    frame: OutboxDispatchFrame,
    delivery: OutboxDelivery,
  ) => Promise<OutboxSendResult> | OutboxSendResult;
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly afterSendBeforeMark?: (delivery: OutboxDelivery) => Promise<void> | void;
}

function dispatchFrame(delivery: OutboxDelivery): OutboxDispatchFrame {
  if (delivery.targetKind === "room") {
    if (delivery.event.type === "room.message.accepted" &&
        isMessage(delivery.event.payload)) {
      return { type: "message.created", message: delivery.event.payload };
    }
    return { type: "room.event", event: delivery.event };
  }
  if (delivery.targetKind === "principal") {
    if (delivery.event.type !== "identity.room-access.changed") {
      throw new TypeError("Principal delivery must carry a room-access identity event");
    }
    return delivery.event;
  }
  if (delivery.event.type !== "identity.session.revoked") {
    throw new TypeError("Session-family delivery must carry a revoked-session event");
  }
  return { type: "auth.session-revoked", eventId: delivery.eventId };
}

export function createOutboxDispatcher(
  options: OutboxDispatcherOptions,
): OutboxDispatcher {
  const batchSize = options.batchSize ?? 100;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a positive safe integer");
  }
  if (batchSize > 1_000) {
    throw new RangeError("batchSize must be at most 1000");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("pollIntervalMs must be a positive safe integer");
  }

  let started = false;
  let closed = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let activeFlush: Promise<number> | undefined;

  async function flushOnce(): Promise<number> {
    if (closed) return 0;
    if (activeFlush !== undefined) return activeFlush;
    activeFlush = (async () => {
      let dispatched = 0;
      const deliveries = await options.store.listPendingOutbox(batchSize);
      for (const delivery of deliveries) {
        const candidates = options.registry.candidates(delivery);
        let failedReason: OutboxDeliveryFailureReason | undefined;
        const frame = dispatchFrame(delivery);
        for (const candidate of candidates) {
          const candidateSnapshot: OutboxDispatchCandidate = {
            connectionId: candidate.connectionId,
            principal: candidate.principal,
            sessionId: candidate.sessionId,
            sessionFamilyId: candidate.sessionFamilyId,
            credentialGeneration: candidate.credentialGeneration,
          };
          const eligible = await options.store.authorizeOutboxCandidate(
            delivery,
            candidateSnapshot,
          );
          if (!eligible) continue;

          let result: OutboxSendResult;
          try {
            result = await options.send(candidateSnapshot, frame, delivery);
          } catch {
            result = { accepted: false, reason: "send_rejected" };
          }
          if (!result.accepted) {
            failedReason ??= result.reason;
            continue;
          }
          if (delivery.targetKind === "session-family") {
            options.registry.revokeConnection(
              candidateSnapshot.connectionId,
              delivery.targetId,
            );
          }
        }

        if (failedReason !== undefined) {
          await options.store.markOutboxFailed(delivery.deliveryId, failedReason);
          continue;
        }
        await options.afterSendBeforeMark?.(delivery);
        await options.store.markOutboxDispatched(delivery.deliveryId);
        dispatched += 1;
      }
      return dispatched;
    })().finally(() => {
      activeFlush = undefined;
    });
    return activeFlush;
  }

  function schedule(): void {
    if (!started || closed) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      void flushOnce().catch(() => undefined).finally(schedule);
    }, pollIntervalMs);
  }

  return {
    flushOnce,
    start() {
      if (started || closed) return;
      started = true;
      void flushOnce().catch(() => undefined).finally(schedule);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (wakeTimer !== undefined) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
      await activeFlush;
    },
  };
}
