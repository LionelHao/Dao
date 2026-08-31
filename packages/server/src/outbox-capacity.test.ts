import type { PersistedRoomEvent } from "@native-im/core";
import { describe, expect, it } from "vitest";
import {
  createOutboxDispatcher,
  type OutboxDispatchStore,
  type OutboxFailureLifecyclePort,
} from "./outbox-dispatcher.js";
import type { OutboxStructuredAlert } from "./outbox-alert-sink.js";
import type {
  OutboxDelivery,
  OutboxDeliveryFailureReason,
} from "./persistence/contracts.js";
import { createSubscriptionRegistry } from "./subscription-registry.js";

const TOTAL_DELIVERIES = 10_000;
const FAILED_DELIVERIES = TOTAL_DELIVERIES / 10;
const NOW_MS = Date.parse("2026-08-31T00:00:00.000Z");

interface CapacityRow {
  delivery: OutboxDelivery;
  availableAtMs: number;
}

class CapacityOutbox implements OutboxDispatchStore, OutboxFailureLifecyclePort {
  readonly pending = new Map<string, CapacityRow>();
  readonly deadLetters = new Map<string, OutboxDelivery>();
  readonly listBatchSizes: number[] = [];
  readonly retryAttempts: number[] = [];
  dispatched = 0;

  constructor(deliveries: readonly OutboxDelivery[]) {
    for (const delivery of deliveries) {
      this.pending.set(delivery.deliveryId, { delivery, availableAtMs: NOW_MS });
    }
  }

  async listPendingOutbox(limit: number): Promise<readonly OutboxDelivery[]> {
    const batch = [...this.pending.values()]
      .filter((row) => row.availableAtMs <= NOW_MS)
      .slice(0, limit)
      .map((row) => row.delivery);
    this.listBatchSizes.push(batch.length);
    return batch;
  }

  async authorizeOutboxCandidate(): Promise<boolean> {
    return true;
  }

  async markOutboxDispatched(deliveryId: string): Promise<void> {
    if (this.pending.delete(deliveryId)) this.dispatched += 1;
  }

  async markOutboxFailed(): Promise<void> {
    throw new TypeError("capacity test requires the production bounded failure lifecycle");
  }

  async scheduleRetry(input: Readonly<{
    deliveryId: string;
    eventId: string;
    attempt: number;
    reason: OutboxDeliveryFailureReason;
    availableAtMs: number;
  }>): Promise<void> {
    const row = this.pending.get(input.deliveryId);
    if (row === undefined || row.delivery.eventId !== input.eventId) {
      throw new TypeError("retry did not bind to the pending delivery");
    }
    this.retryAttempts.push(input.attempt);
    this.pending.set(input.deliveryId, {
      availableAtMs: input.availableAtMs,
      delivery: { ...row.delivery, attempts: input.attempt },
    });
  }

  async deadLetter(input: Readonly<{
    deliveryId: string;
    eventId: string;
    attempt: number;
    reason: OutboxDeliveryFailureReason;
    deadLetteredAtMs: number;
  }>): Promise<void> {
    const row = this.pending.get(input.deliveryId);
    if (row === undefined || row.delivery.eventId !== input.eventId || input.attempt !== 8) {
      throw new TypeError("dead-letter did not bind to the eighth delivery attempt");
    }
    this.pending.delete(input.deliveryId);
    this.deadLetters.set(input.deliveryId, { ...row.delivery, attempts: input.attempt });
  }
}

function capacityDelivery(index: number): OutboxDelivery {
  const id = index.toString().padStart(5, "0");
  const event: PersistedRoomEvent = {
    eventId: `capacity-event-${id}`,
    streamKind: "room",
    streamId: "capacity-room",
    streamSeq: index + 1,
    roomId: "capacity-room",
    actorId: "capacity-human",
    occurredAt: new Date(NOW_MS).toISOString(),
    type: "room.message.accepted",
    payload: {
      id: `capacity-message-${id}`,
      roomId: "capacity-room",
      authorId: "capacity-human",
      authorKind: "human",
      body: id,
      sentAt: new Date(NOW_MS).toISOString(),
    },
  };
  return {
    deliveryId: `capacity-delivery-${id}`,
    eventId: event.eventId,
    targetKind: "room",
    targetId: "capacity-room",
    streamSeq: event.streamSeq,
    attempts: 0,
    event,
  };
}

describe("central outbox PR capacity", () => {
  it("drains 10k deliveries with deterministic 10% failures in <=100-row batches", async () => {
    const deliveries = Array.from(
      { length: TOTAL_DELIVERIES },
      (_value, index) => capacityDelivery(index),
    );
    const store = new CapacityOutbox(deliveries);
    const registry = createSubscriptionRegistry();
    registry.addRoom({
      roomId: "capacity-room",
      connection: {
        connectionId: "capacity-connection",
        principal: { accountId: "capacity-account", actorId: "capacity-human" },
        sessionId: "capacity-session",
        sessionFamilyId: "capacity-family",
        credentialGeneration: 1,
        revoke() {},
      },
    });
    const alerts: OutboxStructuredAlert[] = [];
    const dispatcher = createOutboxDispatcher({
      store,
      registry,
      batchSize: 100,
      now: () => NOW_MS,
      random: () => 0,
      failureLifecycle: store,
      alertSink: { emit(alert) { alerts.push(alert); } },
      send: async (_candidate, _frame, delivery) => {
        const ordinal = Number(delivery.deliveryId.slice(-5));
        return ordinal % 10 === 0
          ? { accepted: false as const, reason: "send_rejected" as const }
          : { accepted: true as const };
      },
    });

    let flushes = 0;
    while (store.pending.size > 0) {
      await dispatcher.flushOnce();
      flushes += 1;
      if (flushes > 2_000) throw new Error("bounded outbox capacity drain did not converge");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await dispatcher.close();

    expect(store.dispatched).toBe(TOTAL_DELIVERIES - FAILED_DELIVERIES);
    expect(store.deadLetters.size).toBe(FAILED_DELIVERIES);
    expect([...store.deadLetters.values()].every((item) => item.attempts === 8)).toBe(true);
    expect(store.retryAttempts).toHaveLength(FAILED_DELIVERIES * 7);
    expect(Math.max(...store.listBatchSizes)).toBe(100);
    expect(store.listBatchSizes.every((size) => size <= 100)).toBe(true);
    expect(alerts.filter((alert) => alert.code === "outbox_delivery_dead_lettered"))
      .toHaveLength(FAILED_DELIVERIES);
  }, 30_000);
});
