import {
  isAttachmentPrivateEvent,
  isMessage,
  type AttachmentPrivateEvent,
  type NotificationStableEvent,
} from "@native-im/core";
import type {
  OutboxDelivery,
  OutboxDeliveryFailureReason,
  OutboxDispatchCandidate,
  SyncQueryStore,
} from "./persistence/contracts.js";
import {
  createOutboxAlertController,
  type OutboxAlertSink,
} from "./outbox-alert-sink.js";
import {
  createOutboxRetryPolicy,
  type OutboxRetryPolicy,
} from "./outbox-retry-policy.js";
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
  | NotificationStableEvent
  | AttachmentPrivateEvent
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

export interface OutboxFailureLifecyclePort {
  scheduleRetry(input: Readonly<{
    deliveryId: string;
    eventId: string;
    attempt: number;
    reason: OutboxDeliveryFailureReason;
    availableAtMs: number;
  }>): Promise<void>;
  deadLetter(input: Readonly<{
    deliveryId: string;
    eventId: string;
    attempt: number;
    reason: OutboxDeliveryFailureReason;
    deadLetteredAtMs: number;
  }>): Promise<void>;
}

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
  readonly shutdownTimeoutMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly retryPolicy?: OutboxRetryPolicy;
  readonly failureLifecycle?: OutboxFailureLifecyclePort;
  readonly alertSink?: OutboxAlertSink;
  readonly afterSendBeforeMark?: (delivery: OutboxDelivery) => Promise<void> | void;
  /** Runs durable, bounded prerequisite work without consuming delivery retry state. */
  readonly prepareDelivery?: (
    delivery: OutboxDelivery,
  ) => Promise<"ready" | "deferred"> | "ready" | "deferred";
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
    if (delivery.event.type === "attachment.private.status-changed") {
      const event = { ...delivery.event, streamKind: "principal" };
      if (!isAttachmentPrivateEvent(event)) {
        throw new TypeError("Principal attachment delivery is invalid");
      }
      return event;
    }
    if (delivery.event.type === "notification.created" ||
        delivery.event.type === "notification.read" ||
        delivery.event.type === "notification.handled" ||
        delivery.event.type === "notification.revoked") {
      return delivery.event;
    }
    if (delivery.event.type !== "identity.room-access.changed") {
      throw new TypeError("Principal delivery must carry a private identity event");
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
  const retryPolicy = options.retryPolicy ?? createOutboxRetryPolicy({
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  const batchSize = retryPolicy.batchSize;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError("pollIntervalMs must be a positive safe integer");
  }
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0 ||
      shutdownTimeoutMs > 30_000) {
    throw new RangeError("shutdownTimeoutMs must be a positive safe integer at most 30000");
  }
  const now = options.now ?? Date.now;
  const alertController = createOutboxAlertController({
    sink: options.alertSink ?? { emit() {} },
  });

  let started = false;
  let closed = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let activeFlush: Promise<number> | undefined;
  let loopFailureCount = 0;
  const retryNotBefore = new Map<string, number>();
  const acceptedPeers = new Map<string, Set<string>>();

  function acceptedPeerKey(candidate: OutboxDispatchCandidate): string {
    return `${candidate.connectionId}\0${candidate.credentialGeneration}`;
  }

  function clearDeliveryState(deliveryId: string): void {
    retryNotBefore.delete(deliveryId);
    acceptedPeers.delete(deliveryId);
    alertController.settled("central", deliveryId);
  }

  async function reportDispatcherFailure(
    reason: "storage_unavailable" | "shutdown_timeout",
  ): Promise<void> {
    try {
      await alertController.dispatcherFailure(reason);
    } catch {
      // The alert adapter is operational telemetry, never a second authority writer.
    }
  }

  async function observeBacklog(delivery: OutboxDelivery, currentNow: number): Promise<void> {
    const occurredAtMs = Date.parse(delivery.event.occurredAt);
    if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) return;
    try {
      await alertController.observeBacklog({
        family: "central",
        deliveryId: delivery.deliveryId,
        eventId: delivery.eventId,
        occurredAtMs,
        attempts: delivery.attempts,
      }, currentNow);
    } catch {
      // Alert delivery cannot change an authoritative outbox row.
    }
  }

  async function settleFailure(
    delivery: OutboxDelivery,
    reason: OutboxDeliveryFailureReason,
    currentNow: number,
  ): Promise<void> {
    const decision = retryPolicy.afterFailure({
      priorAttempts: delivery.attempts,
      nowMs: currentNow,
    });
    if (decision.kind === "retry") {
      if (options.failureLifecycle === undefined) {
        await options.store.markOutboxFailed(delivery.deliveryId, reason);
      } else {
        await options.failureLifecycle.scheduleRetry({
          deliveryId: delivery.deliveryId,
          eventId: delivery.eventId,
          attempt: decision.attempt,
          reason,
          availableAtMs: decision.availableAtMs,
        });
      }
      retryNotBefore.set(delivery.deliveryId, decision.availableAtMs);
      return;
    }
    if (options.failureLifecycle === undefined) {
      await options.store.markOutboxFailed(delivery.deliveryId, reason);
      retryNotBefore.set(delivery.deliveryId, Number.MAX_SAFE_INTEGER);
    } else {
      await options.failureLifecycle.deadLetter({
        deliveryId: delivery.deliveryId,
        eventId: delivery.eventId,
        attempt: decision.attempt,
        reason,
        deadLetteredAtMs: currentNow,
      });
      acceptedPeers.delete(delivery.deliveryId);
    }
    const occurredAtMs = Date.parse(delivery.event.occurredAt);
    const ageMs = Number.isSafeInteger(occurredAtMs) && occurredAtMs >= 0 && currentNow >= occurredAtMs
      ? currentNow - occurredAtMs
      : 0;
    try {
      await alertController.deadLetter({
        family: "central",
        deliveryId: delivery.deliveryId,
        eventId: delivery.eventId,
        attempts: decision.attempt,
        ageMs,
        reason,
      });
    } catch {
      // The durable dead-letter row remains the authority when telemetry is unavailable.
    }
    if (options.failureLifecycle !== undefined) {
      clearDeliveryState(delivery.deliveryId);
    }
  }

  async function flushOnce(): Promise<number> {
    if (closed) return 0;
    if (activeFlush !== undefined) return activeFlush;
    activeFlush = (async () => {
      let dispatched = 0;
      const deliveries = await options.store.listPendingOutbox(batchSize);
      for (const delivery of deliveries) {
        const currentNow = now();
        if (!Number.isSafeInteger(currentNow) || currentNow < 0) {
          throw new RangeError("outbox clock must return a non-negative safe integer");
        }
        if ((retryNotBefore.get(delivery.deliveryId) ?? 0) > currentNow) continue;
        if (await options.prepareDelivery?.(delivery) === "deferred") continue;
        await observeBacklog(delivery, currentNow);
        const candidates = options.registry.candidates(delivery);
        let failedReason: OutboxDeliveryFailureReason | undefined;
        const frame = dispatchFrame(delivery);
        let acceptedForDelivery = acceptedPeers.get(delivery.deliveryId);
        if (acceptedForDelivery === undefined) {
          acceptedForDelivery = new Set<string>();
          acceptedPeers.set(delivery.deliveryId, acceptedForDelivery);
        }
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
          const peerKey = acceptedPeerKey(candidateSnapshot);
          if (!eligible) {
            acceptedForDelivery.delete(peerKey);
            continue;
          }
          if (acceptedForDelivery.has(peerKey)) continue;

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
          acceptedForDelivery.add(peerKey);
          if (delivery.targetKind === "session-family") {
            options.registry.revokeConnection(
              candidateSnapshot.connectionId,
              delivery.targetId,
            );
          }
        }

        if (failedReason !== undefined) {
          await settleFailure(delivery, failedReason, currentNow);
          continue;
        }
        await options.afterSendBeforeMark?.(delivery);
        await options.store.markOutboxDispatched(delivery.deliveryId);
        clearDeliveryState(delivery.deliveryId);
        dispatched += 1;
      }
      return dispatched;
    })().finally(() => {
      activeFlush = undefined;
    });
    return activeFlush;
  }

  function schedule(delayMs = pollIntervalMs): void {
    if (!started || closed) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      void runLoopIteration();
    }, delayMs);
  }

  async function runLoopIteration(): Promise<void> {
    let nextDelayMs = pollIntervalMs;
    try {
      await flushOnce();
      loopFailureCount = 0;
    } catch {
      await reportDispatcherFailure("storage_unavailable");
      const exponent = Math.min(loopFailureCount, 7);
      nextDelayMs = Math.max(pollIntervalMs, Math.min(30_000, 250 * 2 ** exponent));
      loopFailureCount += 1;
    } finally {
      schedule(nextDelayMs);
    }
  }

  return {
    flushOnce,
    start() {
      if (started || closed) return;
      started = true;
      void runLoopIteration();
    },
    async close() {
      if (closed) return;
      closed = true;
      if (wakeTimer !== undefined) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
      if (activeFlush === undefined) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          activeFlush,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error("outbox dispatcher shutdown timed out"));
            }, shutdownTimeoutMs);
          }),
        ]);
      } catch (error: unknown) {
        if (error instanceof Error && error.message === "outbox dispatcher shutdown timed out") {
          void reportDispatcherFailure("shutdown_timeout");
        }
        throw error;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}
