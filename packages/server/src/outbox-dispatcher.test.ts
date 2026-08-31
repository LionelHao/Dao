import { describe, expect, it, vi } from "vitest";
import type { PersistedIdentityEvent, PersistedRoomEvent } from "@native-im/core";
import {
  createOutboxDispatcher,
  type OutboxFailureLifecyclePort,
  type OutboxDispatchStore,
  type OutboxSendResult,
} from "./outbox-dispatcher.js";
import type { OutboxStructuredAlert } from "./outbox-alert-sink.js";
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

const messageAuthorityEvent: PersistedRoomEvent = {
  eventId: "event-message-v2-1",
  streamKind: "room",
  streamId: "room-1",
  streamSeq: 3,
  roomId: "room-1",
  actorId: "human-author",
  occurredAt: "2026-08-19T00:01:00.000Z",
  type: "room.message.accepted",
  payload: {
    id: "message-v2-1",
    roomId: "room-1",
    authorId: "human-author",
    authorKind: "human",
    createdAt: "2026-08-19T00:00:00.000Z",
    lifecycle: "active",
    currentRevision: {
      messageId: "message-v2-1",
      revision: 1,
      body: "durable v2",
      revisedAt: "2026-08-19T00:00:00.000Z",
      revisedByActorId: "human-author",
    },
    revisionCount: 1,
    mentionedTargets: [],
    attachments: [],
    targetOutcomes: [],
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

const attachmentPrincipalEvent: PersistedIdentityEvent = {
  eventId: "event-attachment-private-1",
  streamKind: "identity",
  streamId: "human-author",
  streamSeq: 4,
  actorId: "human-author",
  occurredAt: "2026-08-19T00:00:01.000Z",
  type: "attachment.private.status-changed",
  payload: {
    attachment: {
      attachmentId: "attachment-1",
      roomId: "room-1",
      originalFilename: "safe.txt",
      format: "txt",
      declaredMime: "text/plain",
      detectedMime: "text/plain",
      byteSize: 5,
      sha256: "a".repeat(64),
      uploaderActorId: "human-author",
      createdAt: "2026-08-19T00:00:00.000Z",
      readyAt: null,
      processingStatus: "accepted-quarantined",
      generation: 1,
      sourceMessageId: null,
      provenance: null,
    },
  },
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
  it("converts internal identity attachment status into a private principal frame", async () => {
    const registry = createSubscriptionRegistry();
    const uploader = connection("attachment-uploader", "human-author");
    registry.addPrincipal({ principalId: "human-author", connection: uploader });
    const item = delivery(
      "delivery-attachment-private",
      "principal",
      "human-author",
      attachmentPrincipalEvent,
    );
    const store = new MemoryOutboxStore([item], () => true);
    const send = vi.fn(async () => ({ accepted: true as const }));
    const dispatcher = createOutboxDispatcher({ store, registry, send });

    await expect(dispatcher.flushOnce()).resolves.toBe(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: uploader.connectionId }),
      { ...attachmentPrincipalEvent, streamKind: "principal" },
      item,
    );
  });

  it("dispatches Message Authority events without downgrading them to legacy message.created", async () => {
    const registry = createSubscriptionRegistry();
    const member = connection("message-v2-member", "human-member");
    registry.addRoom({ roomId: "room-1", connection: member });
    const item = delivery("delivery-message-v2", "room", "room-1", messageAuthorityEvent);
    const store = new MemoryOutboxStore([item], () => true);
    const send = vi.fn(async () => ({ accepted: true as const }));
    const dispatcher = createOutboxDispatcher({ store, registry, send });

    await expect(dispatcher.flushOnce()).resolves.toBe(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: member.connectionId }),
      { type: "room.event", event: messageAuthorityEvent },
      item,
    );
  });

  it("rejects a batch size above the closed worker wire limit", () => {
    expect(() => createOutboxDispatcher({
      store: new MemoryOutboxStore([], () => true),
      registry: createSubscriptionRegistry(),
      send: async () => ({ accepted: true }),
      batchSize: 101,
    })).toThrow("batchSize must be a positive safe integer at most 100");
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
    const sent: Array<{
      readonly connectionId: string;
      readonly frame: unknown;
      readonly item: OutboxDelivery;
    }> = [];
    const dispatcher = createOutboxDispatcher({
      store,
      registry,
      send: async (candidate, frame, item) => {
        sent.push({ connectionId: candidate.connectionId, frame, item });
        return { accepted: true };
      },
    });

    await expect(dispatcher.flushOnce()).resolves.toBe(4);

    expect(sent).toContainEqual({
      connectionId: member.connectionId,
      frame: { type: "message.created", message: roomEvent.payload },
      item: deliveries[0],
    });
    expect(sent).toContainEqual({
      connectionId: member.connectionId,
      frame: { type: "room.event", event: roomReadEvent },
      item: deliveries[1],
    });
    expect(sent).not.toContainEqual(expect.objectContaining({
      connectionId: removedRoomMember.connectionId,
    }));
    expect(sent).toContainEqual({
      connectionId: removedPrincipal.connectionId,
      frame: principalEvent,
      item: deliveries[2],
    });
    expect(sent).toContainEqual({
      connectionId: revokedFamily.connectionId,
      frame: { type: "auth.session-revoked", eventId: revokedEvent.eventId },
      item: deliveries[3],
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

  it("revalidates but does not resend an accepted peer while another peer retries", async () => {
    const registry = createSubscriptionRegistry();
    const acceptedPeer = connection("accepted-ledger", "human-accepted");
    const rejectedPeer = connection("rejected-ledger", "human-rejected");
    registry.addRoom({ roomId: "room-1", connection: acceptedPeer });
    registry.addRoom({ roomId: "room-1", connection: rejectedPeer });
    const item = delivery("delivery-ledger", "room", "room-1", roomEvent);
    const store = new MemoryOutboxStore([item], () => true);
    const retries: string[] = [];
    const lifecycle: OutboxFailureLifecyclePort = {
      async scheduleRetry(input) {
        retries.push(`${input.attempt}:${input.availableAtMs}`);
        await store.markOutboxFailed(input.deliveryId, input.reason);
      },
      async deadLetter() { throw new Error("delivery should recover before dead-letter"); },
    };
    const sends: string[] = [];
    let reject = true;
    const dispatcher = createOutboxDispatcher({
      store,
      registry,
      failureLifecycle: lifecycle,
      now: () => 1_000,
      random: () => 0,
      send: async (candidate) => {
        sends.push(candidate.connectionId);
        if (candidate.connectionId === rejectedPeer.connectionId && reject) {
          return { accepted: false, reason: "backpressure" };
        }
        return { accepted: true };
      },
    });

    await expect(dispatcher.flushOnce()).resolves.toBe(0);
    reject = false;
    await expect(dispatcher.flushOnce()).resolves.toBe(1);

    expect(retries).toEqual(["1:1000"]);
    expect(sends).toEqual([
      acceptedPeer.connectionId,
      rejectedPeer.connectionId,
      rejectedPeer.connectionId,
    ]);
    expect(store.authorizationCalls).toHaveLength(4);
  });

  it("dead-letters the eighth failure and emits only closed alert metadata", async () => {
    const registry = createSubscriptionRegistry();
    const peer = connection("dead-peer", "human-dead");
    registry.addRoom({ roomId: "room-1", connection: peer });
    const initial = delivery("delivery-dead", "room", "room-1", roomEvent);
    const item = { ...initial, attempts: 7 } satisfies OutboxDelivery;
    const store = new MemoryOutboxStore([item], () => true);
    const terminal: unknown[] = [];
    const alerts: OutboxStructuredAlert[] = [];
    const lifecycle: OutboxFailureLifecyclePort = {
      async scheduleRetry() { throw new Error("eighth failure must be terminal"); },
      async deadLetter(input) {
        terminal.push(input);
        store.pending.delete(input.deliveryId);
      },
    };
    const now = Date.parse(roomEvent.occurredAt) + 5 * 60_000;
    const dispatcher = createOutboxDispatcher({
      store, registry, failureLifecycle: lifecycle, now: () => now,
      alertSink: { emit: (alert) => { alerts.push(alert); } },
      send: async () => ({ accepted: false, reason: "send_rejected" }),
    });

    await expect(dispatcher.flushOnce()).resolves.toBe(0);

    expect(terminal).toEqual([{
      deliveryId: item.deliveryId,
      eventId: item.eventId,
      attempt: 8,
      reason: "send_rejected",
      deadLetteredAtMs: now,
    }]);
    expect(alerts).toContainEqual({
      severity: "critical", code: "outbox_delivery_dead_lettered", family: "central",
      deliveryId: item.deliveryId, eventId: item.eventId, attempts: 8,
      ageMs: 5 * 60_000, reason: "send_rejected",
    });
  });

  it("surfaces loop storage failures through the structured sink", async () => {
    const alerts: OutboxStructuredAlert[] = [];
    const store = new MemoryOutboxStore([], () => true);
    store.listPendingOutbox = async () => { throw new Error("raw database path /secret"); };
    const dispatcher = createOutboxDispatcher({
      store,
      registry: createSubscriptionRegistry(),
      send: async () => ({ accepted: true }),
      pollIntervalMs: 5,
      alertSink: { emit: (alert) => { alerts.push(alert); } },
    });

    dispatcher.start();
    await vi.waitFor(() => expect(alerts).toContainEqual({
      severity: "critical", code: "outbox_dispatcher_failure", family: "central",
      reason: "storage_unavailable",
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alerts).toHaveLength(1);
    await dispatcher.close();
    expect(JSON.stringify(alerts)).not.toContain("/secret");
  });

  it("bounds shutdown when an in-flight send does not settle", async () => {
    const registry = createSubscriptionRegistry();
    registry.addRoom({ roomId: "room-1", connection: connection("hung", "human-hung") });
    const store = new MemoryOutboxStore([
      delivery("delivery-hung", "room", "room-1", roomEvent),
    ], () => true);
    const dispatcher = createOutboxDispatcher({
      store,
      registry,
      shutdownTimeoutMs: 10,
      send: async () => new Promise<OutboxSendResult>(() => undefined),
    });
    void dispatcher.flushOnce();
    await expect(dispatcher.close()).rejects.toThrow("outbox dispatcher shutdown timed out");
  });

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
