import { describe, expect, it, vi } from "vitest";
import type { PersistedIdentityEvent, PersistedRoomEvent } from "@native-im/core";
import {
  createOutboxDispatcher,
  type OutboxDispatchStore,
  type OutboxSendResult,
} from "./outbox-dispatcher.js";
import type {
  OutboxDelivery,
  OutboxDispatchCandidate,
} from "./persistence/contracts.js";
import {
  createSubscriptionRegistry,
  type RegisteredConnection,
} from "./subscription-registry.js";

const roomEvent: PersistedRoomEvent = {
  eventId: "event-room-1",
  streamKind: "room",
  streamId: "room-1",
  streamSeq: 1,
  roomId: "room-1",
  actorId: "human-author",
  occurredAt: "2026-08-11T00:00:00.000Z",
  type: "room.message.accepted",
  payload: {
    id: "message-1",
    roomId: "room-1",
    authorId: "human-author",
    authorKind: "human",
    body: "durable",
    sentAt: "2026-08-11T00:00:00.000Z",
  },
};

const roomReadEvent: PersistedRoomEvent = {
  eventId: "event-room-read-1",
  streamKind: "room",
  streamId: "room-1",
  streamSeq: 2,
  roomId: "room-1",
  actorId: "human-member",
  occurredAt: "2026-08-11T00:00:00.500Z",
  type: "room.human_read.recorded",
  payload: {
    id: "read-1",
    messageId: "message-1",
    readerId: "human-member",
    readAt: "2026-08-11T00:00:00.500Z",
  },
};

const principalEvent: PersistedIdentityEvent = {
  eventId: "event-principal-1",
  streamKind: "identity",
  streamId: "human-removed",
  streamSeq: 2,
  actorId: "human-removed",
  occurredAt: "2026-08-11T00:00:01.000Z",
  type: "identity.room-access.changed",
  payload: { roomId: "room-1", change: "removed" },
};

const revokedEvent: PersistedIdentityEvent = {
  eventId: "event-revoked-1",
  streamKind: "identity",
  streamId: "human-revoked",
  streamSeq: 3,
  actorId: "human-revoked",
  occurredAt: "2026-08-11T00:00:02.000Z",
  type: "identity.session.revoked",
  payload: {
    sessionId: "session-revoked",
    familyId: "family-revoked",
    accountId: "account-revoked",
  },
};

function delivery(
  deliveryId: string,
  targetKind: OutboxDelivery["targetKind"],
  targetId: string,
  event: PersistedRoomEvent | PersistedIdentityEvent,
): OutboxDelivery {
  if (targetKind === "room" && event.streamKind === "room") {
    return {
      deliveryId,
      eventId: event.eventId,
      targetKind,
      targetId,
      streamSeq: event.streamSeq,
      attempts: 0,
      event,
    };
  }
  if (targetKind !== "room" && event.streamKind === "identity") {
    return {
      deliveryId,
      eventId: event.eventId,
      targetKind,
      targetId,
      streamSeq: event.streamSeq,
      attempts: 0,
      event,
    };
  }
  throw new TypeError("Outbox target kind must match its event stream");
}

function connection(
  connectionId: string,
  principalId: string,
  familyId = `family-${connectionId}`,
): RegisteredConnection {
  return {
    connectionId,
    principal: { accountId: `account-${principalId}`, actorId: principalId },
    sessionId: `session-${connectionId}`,
    sessionFamilyId: familyId,
    credentialGeneration: 1,
    revoke: vi.fn(),
  };
}

class MemoryOutboxStore implements OutboxDispatchStore {
  readonly pending = new Map<string, OutboxDelivery>();
  readonly authorizationCalls: Array<{
    readonly deliveryId: string;
    readonly connectionId: string;
  }> = [];
  readonly dispatched: string[] = [];
  readonly failed: Array<{ readonly deliveryId: string; readonly reason: string }> = [];

  constructor(
    deliveries: readonly OutboxDelivery[],
    private readonly authorize: (
      delivery: OutboxDelivery,
      candidate: OutboxDispatchCandidate,
    ) => boolean | Promise<boolean>,
  ) {
    for (const item of deliveries) this.pending.set(item.deliveryId, item);
  }

  async listPendingOutbox(limit: number): Promise<readonly OutboxDelivery[]> {
    return [...this.pending.values()].slice(0, limit);
  }

  async authorizeOutboxCandidate(
    item: OutboxDelivery,
    candidate: OutboxDispatchCandidate,
  ): Promise<boolean> {
    this.authorizationCalls.push({
      deliveryId: item.deliveryId,
      connectionId: candidate.connectionId,
    });
    return this.authorize(item, candidate);
  }

  async markOutboxDispatched(deliveryId: string): Promise<void> {
    this.dispatched.push(deliveryId);
    this.pending.delete(deliveryId);
  }

  async markOutboxFailed(deliveryId: string, reason: string): Promise<void> {
    this.failed.push({ deliveryId, reason });
    const current = this.pending.get(deliveryId);
    if (current !== undefined) {
      this.pending.set(deliveryId, { ...current, attempts: current.attempts + 1 });
    }
  }
}

describe("OutboxDispatcher", () => {
  it("rejects a batch size above the closed worker wire limit", () => {
    expect(() => createOutboxDispatcher({
      store: new MemoryOutboxStore([], () => true),
      registry: createSubscriptionRegistry(),
      send: async () => ({ accepted: true }),
      batchSize: 1_001,
    })).toThrow("batchSize must be at most 1000");
  });

  it("applies target-kind authorization before every send", async () => {
    const registry = createSubscriptionRegistry();
    const member = connection("member", "human-member");
    const removedRoomMember = connection("removed-room", "human-removed");
    const removedPrincipal = connection("removed-principal", "human-removed");
    const revokedFamily = connection("revoked-family", "human-revoked", "family-revoked");
    registry.addRoom({ roomId: "room-1", connection: member });
    registry.addRoom({ roomId: "room-1", connection: removedRoomMember });
    registry.addPrincipal({ principalId: "human-removed", connection: removedPrincipal });
    registry.addSessionFamily({ familyId: "family-revoked", connection: revokedFamily });
    const deliveries = [
      delivery("delivery-room", "room", "room-1", roomEvent),
      delivery("delivery-room-read", "room", "room-1", roomReadEvent),
      delivery("delivery-principal", "principal", "human-removed", principalEvent),
      delivery("delivery-family", "session-family", "family-revoked", revokedEvent),
    ];
    const store = new MemoryOutboxStore(deliveries, (item, candidate) =>
      item.targetKind !== "room" || candidate.connectionId === member.connectionId);
    const sent: Array<{ readonly connectionId: string; readonly frame: unknown }> = [];
    const dispatcher = createOutboxDispatcher({
      store,
      registry,
      send: async (candidate, frame) => {
        sent.push({ connectionId: candidate.connectionId, frame });
        return { accepted: true };
      },
    });

    await expect(dispatcher.flushOnce()).resolves.toBe(4);

    expect(sent).toContainEqual({
      connectionId: member.connectionId,
      frame: { type: "message.created", message: roomEvent.payload },
    });
    expect(sent).toContainEqual({
      connectionId: member.connectionId,
      frame: { type: "room.event", event: roomReadEvent },
    });
    expect(sent).not.toContainEqual(expect.objectContaining({
      connectionId: removedRoomMember.connectionId,
    }));
    expect(sent).toContainEqual({
      connectionId: removedPrincipal.connectionId,
      frame: principalEvent,
    });
    expect(sent).toContainEqual({
      connectionId: revokedFamily.connectionId,
      frame: { type: "auth.session-revoked", eventId: revokedEvent.eventId },
    });
    expect(revokedFamily.revoke).toHaveBeenCalledTimes(1);
    expect(store.authorizationCalls).toHaveLength(6);
    expect(store.dispatched).toEqual(deliveries.map((item) => item.deliveryId));
  });

  it.each(["closed", "backpressure", "send_rejected"] as const)(
    "keeps a row pending and increments attempts when one eligible send reports %s",
    async (reason) => {
      const registry = createSubscriptionRegistry();
      const acceptedPeer = connection("accepted", "human-accepted");
      const rejectedPeer = connection("rejected", "human-rejected");
      registry.addRoom({ roomId: "room-1", connection: acceptedPeer });
      registry.addRoom({ roomId: "room-1", connection: rejectedPeer });
      const item = delivery("delivery-room", "room", "room-1", roomEvent);
      const store = new MemoryOutboxStore([item], () => true);
      const receivedByAcceptedPeer: string[] = [];
      let rejectSecond = true;
      const send = async (
        candidate: OutboxDispatchCandidate,
      ): Promise<OutboxSendResult> => {
        if (candidate.connectionId === rejectedPeer.connectionId && rejectSecond) {
          return { accepted: false, reason };
        }
        if (candidate.connectionId === acceptedPeer.connectionId) {
          receivedByAcceptedPeer.push(item.eventId);
        }
        return { accepted: true };
      };
      const firstDispatcher = createOutboxDispatcher({ store, registry, send });

      await expect(firstDispatcher.flushOnce()).resolves.toBe(0);
      expect(store.pending.get(item.deliveryId)?.attempts).toBe(1);
      expect(store.failed).toEqual([{ deliveryId: item.deliveryId, reason }]);

      rejectSecond = false;
      const restartedDispatcher = createOutboxDispatcher({ store, registry, send });
      await expect(restartedDispatcher.flushOnce()).resolves.toBe(1);
      expect(receivedByAcceptedPeer).toEqual([item.eventId, item.eventId]);
      expect(store.pending.size).toBe(0);
    },
  );

  it("marks a pending row dispatched when no eligible local connection exists", async () => {
    const registry = createSubscriptionRegistry();
    const removed = connection("removed", "human-removed");
    registry.addRoom({ roomId: "room-1", connection: removed });
    const item = delivery("delivery-room", "room", "room-1", roomEvent);
    const store = new MemoryOutboxStore([item], () => false);
    const send = vi.fn();
    const dispatcher = createOutboxDispatcher({ store, registry, send });

    await expect(dispatcher.flushOnce()).resolves.toBe(1);

    expect(send).not.toHaveBeenCalled();
    expect(store.dispatched).toEqual([item.deliveryId]);
  });

  it("replays the same event ID after a crash between send and mark", async () => {
    const registry = createSubscriptionRegistry();
    const member = connection("member", "human-member");
    registry.addRoom({ roomId: "room-1", connection: member });
    const item = delivery("delivery-room", "room", "room-1", roomEvent);
    const store = new MemoryOutboxStore([item], () => true);
    const received: string[] = [];
    const send = async (): Promise<OutboxSendResult> => {
      received.push(item.eventId);
      return { accepted: true };
    };
    const crashing = createOutboxDispatcher({
      store,
      registry,
      send,
      afterSendBeforeMark: () => {
        throw new Error("simulated process crash");
      },
    });

    await expect(crashing.flushOnce()).rejects.toThrow("simulated process crash");
    expect(store.pending.has(item.deliveryId)).toBe(true);

    const restarted = createOutboxDispatcher({ store, registry, send });
    await expect(restarted.flushOnce()).resolves.toBe(1);
    expect(received).toEqual([item.eventId, item.eventId]);
  });

  it("does not revoke a socket that changed to another family after terminal send", async () => {
    const registry = createSubscriptionRegistry();
    let currentFamilyId = "family-revoked";
    const revoke = vi.fn();
    const connection: RegisteredConnection = {
      connectionId: "family-race",
      principal: { accountId: "account-human", actorId: "human-revoked" },
      sessionId: "session-revoked",
      get sessionFamilyId() {
        return currentFamilyId;
      },
      credentialGeneration: 1,
      revoke,
    };
    registry.addSessionFamily({ familyId: "family-revoked", connection });
    const item = delivery(
      "delivery-family-race",
      "session-family",
      "family-revoked",
      revokedEvent,
    );
    const store = new MemoryOutboxStore([item], () => true);
    const dispatcher = createOutboxDispatcher({
      store,
      registry,
      send: async () => {
        currentFamilyId = "family-new";
        return { accepted: true };
      },
    });

    await expect(dispatcher.flushOnce()).resolves.toBe(1);

    expect(revoke).not.toHaveBeenCalled();
  });

  it("starts by draining pending rows and can be closed idempotently", async () => {
    const registry = createSubscriptionRegistry();
    const item = delivery("delivery-principal", "principal", "offline", principalEvent);
    const store = new MemoryOutboxStore([item], () => true);
    const dispatcher = createOutboxDispatcher({
      store,
      registry,
      send: async () => ({ accepted: true }),
      pollIntervalMs: 5,
    });

    dispatcher.start();
    await vi.waitFor(() => expect(store.pending.size).toBe(0));
    await dispatcher.close();
    await dispatcher.close();
  });
});
