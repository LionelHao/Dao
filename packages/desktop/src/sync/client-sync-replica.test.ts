import { createHash } from "node:crypto";

import type {
  PersistedRoomEvent,
  RoomCursor,
  RoomRepairPage,
  RoomRepairRecord,
  RoomSummary,
  RoomSyncRequest,
  RoomSyncResult,
  SnapshotCompleted,
  SnapshotVersion,
  WorkspaceBootstrapPage,
} from "@native-im/core";
import { describe, expect, it, vi } from "vitest";

import {
  ClientSyncReplicaError,
  SnapshotCompletionOutcomeUnknownError,
  createClientSyncReplica,
  type ClientAuthorityCache,
  type RoomSubscription,
  type RoomSubscriptionObserver,
  type SyncTransport,
} from "./client-sync-replica.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("unsupported canonical value");
}

function checksum(kind: "catalog" | "room", values: readonly unknown[]): string {
  return createHash("sha256")
    .update(canonicalJson({ kind, values, version: 1 }), "utf8")
    .digest("hex");
}

const roomSummary: RoomSummary = {
  roomId: "room-1",
  name: "Alpha",
  status: "active",
  role: "owner",
};

const roomRecord: RoomRepairRecord = {
  kind: "room",
  value: {
    id: "room-1",
    name: "Alpha",
    status: "active",
    createdAt: "2026-08-12T00:00:00.000Z",
  },
};

function event(sequence: number, id = `event-${sequence}`): PersistedRoomEvent {
  return {
    eventId: id,
    streamKind: "room",
    streamId: "room-1",
    streamSeq: sequence,
    roomId: "room-1",
    actorId: "human-1",
    occurredAt: "2026-08-12T00:00:00.000Z",
    type: "room.message.accepted",
    payload: {
      id: `message-${sequence}`,
      roomId: "room-1",
      authorId: "human-1",
      authorKind: "human",
      body: `message ${sequence}`,
      sentAt: "2026-08-12T00:00:00.000Z",
    },
  };
}

function catalogPage(overrides: Partial<WorkspaceBootstrapPage> = {}): WorkspaceBootstrapPage {
  const rooms = overrides.rooms ?? [roomSummary];
  return {
    type: "workspace.bootstrap.page",
    requestId: "catalog-0",
    snapshotId: "catalog-snapshot",
    page: 0,
    rooms,
    catalogRevision: 3,
    snapshotChecksum: checksum("catalog", rooms),
    hasMore: false,
    mode: "materialized",
    expiresAt: "2026-08-12T00:05:00.000Z",
    ...overrides,
  } as WorkspaceBootstrapPage;
}

function repairPage(overrides: Partial<RoomRepairPage> = {}): RoomRepairPage {
  const records = overrides.records ?? [roomRecord];
  return {
    type: "room.repair.page",
    requestId: "room-0",
    snapshotId: "room-snapshot",
    roomId: "room-1",
    page: 0,
    records,
    watermark: 9,
    snapshotChecksum: checksum("room", records),
    hasMore: false,
    mode: "materialized",
    expiresAt: "2026-08-12T00:05:00.000Z",
    ...overrides,
  } as RoomRepairPage;
}

function streamingRepairPage(overrides: Partial<RoomRepairPage> = {}): RoomRepairPage {
  const records = overrides.records ?? [roomRecord];
  return {
    type: "room.repair.page",
    requestId: "room-0",
    snapshotId: "room-snapshot",
    roomId: "room-1",
    page: 0,
    records,
    watermark: 9,
    snapshotChecksum: checksum("room", records),
    hasMore: false,
    mode: "streaming",
    idleExpiresAt: "2026-08-12T00:00:30.000Z",
    ...overrides,
  } as RoomRepairPage;
}

class MemoryCache implements ClientAuthorityCache {
  #catalogStage: { id: string; rooms: RoomSummary[] } | undefined;
  #roomStage = new Map<string, { id: string; records: RoomRepairRecord[] }>();
  #catalog: RoomSummary[] = [];
  #rooms = new Map<string, { records: RoomRepairRecord[]; cursor: RoomCursor; events: PersistedRoomEvent[] }>();

  roomCursor(roomId: string): RoomCursor | undefined {
    return this.#rooms.get(roomId)?.cursor;
  }
  beginCatalog(snapshotId: string): void {
    this.#catalogStage = { id: snapshotId, rooms: [] };
  }
  stageCatalogPage(page: WorkspaceBootstrapPage): void {
    if (this.#catalogStage === undefined) throw new Error("catalog staging absent");
    this.#catalogStage.rooms.push(...page.rooms);
  }
  async finalizeCatalog(snapshotId: string, expectedChecksum: string): Promise<boolean> {
    return this.#catalogStage?.id === snapshotId &&
      checksum("catalog", this.#catalogStage.rooms) === expectedChecksum &&
      new Set(this.#catalogStage.rooms.map((room) => room.roomId)).size ===
        this.#catalogStage.rooms.length;
  }
  commitCatalog(version: number, value: string): void {
    void version;
    void value;
    if (this.#catalogStage === undefined) throw new Error("catalog staging absent");
    this.#catalog = structuredClone(this.#catalogStage.rooms);
    this.#catalogStage = undefined;
  }
  *catalogRoomIds(): Iterable<string> {
    for (const room of this.#catalog) yield room.roomId;
  }
  beginRoom(roomId: string, snapshotId: string): void {
    this.#roomStage.set(roomId, { id: snapshotId, records: [] });
  }
  stageRoomPage(page: RoomRepairPage): void {
    const stage = this.#roomStage.get(page.roomId);
    if (stage === undefined) throw new Error("room staging absent");
    stage.records.push(...page.records);
  }
  async finalizeRoom(snapshotId: string, expectedChecksum: string): Promise<boolean> {
    const stage = [...this.#roomStage.values()].find((candidate) => candidate.id === snapshotId);
    return stage !== undefined && checksum("room", stage.records) === expectedChecksum;
  }
  commitRoom(roomId: string, watermark: number, value: string): void {
    void value;
    const stage = this.#roomStage.get(roomId);
    if (stage === undefined) throw new Error("room staging absent");
    this.#rooms.set(roomId, {
      records: structuredClone(stage.records),
      cursor: { version: 1, roomId, afterSeq: watermark },
      events: [],
    });
    this.#roomStage.delete(roomId);
  }
  applyRoomEvents(roomId: string, events: readonly PersistedRoomEvent[], cursor: RoomCursor): void {
    const room = this.#rooms.get(roomId);
    if (room === undefined) throw new Error("live room absent");
    const ids = new Set(room.events.map((item) => item.eventId));
    for (const item of events) {
      if (!ids.has(item.eventId)) {
        ids.add(item.eventId);
        room.events.push(structuredClone(item));
      }
    }
    room.cursor = structuredClone(cursor);
  }
  discardSnapshot(snapshotId: string): void {
    if (this.#catalogStage?.id === snapshotId) this.#catalogStage = undefined;
    for (const [roomId, stage] of this.#roomStage) {
      if (stage.id === snapshotId) this.#roomStage.delete(roomId);
    }
  }
  clear(): void {
    this.#catalogStage = undefined;
    this.#roomStage.clear();
    this.#catalog = [];
    this.#rooms.clear();
  }
  liveCatalog(): readonly RoomSummary[] { return structuredClone(this.#catalog); }
  liveRoom(roomId: string) { return structuredClone(this.#rooms.get(roomId)); }
  hasStaging(): boolean { return this.#catalogStage !== undefined || this.#roomStage.size > 0; }
}

class FakeSubscription implements RoomSubscription {
  closed = false;
  constructor(readonly cursor: RoomCursor) {}
  close(): void { this.closed = true; }
}

class FakeTransport implements SyncTransport {
  catalog: WorkspaceBootstrapPage[] = [catalogPage()];
  repairs = new Map<string, RoomRepairPage[]>([["room-1", [repairPage()]]]);
  syncResults: RoomSyncResult[] = [];
  completeFailures: unknown[] = [];
  completeCalls: { snapshotId: string; version: SnapshotVersion; checksum: string }[] = [];
  syncRequests: RoomSyncRequest[] = [];
  subscribeCalls: RoomCursor[] = [];
  observer: RoomSubscriptionObserver | undefined;
  subscriptions: FakeSubscription[] = [];
  repairBeginCalls = 0;

  async bootstrapBegin(requestId: string): Promise<WorkspaceBootstrapPage> {
    return { ...this.catalog[0]!, requestId };
  }
  async bootstrapPage(requestId: string, _snapshotId: string, afterPage: number): Promise<WorkspaceBootstrapPage> {
    return { ...this.catalog[afterPage + 1]!, requestId };
  }
  async syncRoom(request: RoomSyncRequest): Promise<RoomSyncResult> {
    this.syncRequests.push(structuredClone(request));
    const result = this.syncResults.shift();
    return result ?? {
      type: "room.sync.result",
      requestId: request.requestId,
      mode: "delta",
      events: [],
      nextCursor: { version: 1, roomId: request.roomId, afterSeq: request.cursor?.afterSeq ?? 0 },
      watermark: request.cursor?.afterSeq ?? 0,
      hasMore: false,
    };
  }
  async repairRoomBegin(requestId: string, roomId: string): Promise<RoomRepairPage> {
    this.repairBeginCalls += 1;
    return { ...this.repairs.get(roomId)![0]!, requestId };
  }
  async repairRoomPage(requestId: string, snapshotId: string, afterPage: number): Promise<RoomRepairPage> {
    const pages = [...this.repairs.values()].find((items) => items[0]?.snapshotId === snapshotId);
    return { ...pages![afterPage + 1]!, requestId };
  }
  async completeSnapshot(
    requestId: string,
    snapshotId: string,
    version: SnapshotVersion,
    value: string,
  ): Promise<SnapshotCompleted> {
    this.completeCalls.push({ snapshotId, version: structuredClone(version), checksum: value });
    const failure = this.completeFailures.shift();
    if (failure !== undefined) throw failure;
    return { type: "snapshot.completed", requestId, snapshotId, version };
  }
  async subscribeRoom(
    roomId: string,
    cursor: RoomCursor,
    observer: RoomSubscriptionObserver,
  ): Promise<RoomSubscription> {
    expect(roomId).toBe(cursor.roomId);
    this.subscribeCalls.push(structuredClone(cursor));
    this.observer = observer;
    const subscription = new FakeSubscription(cursor);
    this.subscriptions.push(subscription);
    return subscription;
  }
}

function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`status ${status}`), { status });
}

describe("ClientSyncReplica", () => {
  it("keeps replica buffering O(page) and delegates staged canonical verification to the cache", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const records = Array.from({ length: 200 }, (_, index): RoomRepairRecord => ({
      kind: "message",
      value: {
        id: `bounded-${index}`,
        roomId: "room-1",
        authorId: "human-1",
        authorKind: "human",
        body: `bounded-${index}`,
        sentAt: "2026-08-12T00:00:00.000Z",
      },
    }));
    const expectedChecksum = checksum("room", records);
    transport.repairs.set("room-1", records.map((record, page) => repairPage({
      page,
      records: [record],
      hasMore: page < records.length - 1,
      snapshotChecksum: expectedChecksum,
    })));
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const replica = createClientSyncReplica({ transport, cache });

    await replica.repairRoom("room-1");

    expect(digest).not.toHaveBeenCalled();
    expect(cache.liveRoom("room-1")?.records).toHaveLength(records.length);
    digest.mockRestore();
  });

  it("restores a materialized catalog and every discovered room", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });

    await replica.restoreWorkspace();

    expect(cache.liveCatalog()).toEqual([roomSummary]);
    expect(cache.liveRoom("room-1")?.cursor.afterSeq).toBe(9);
    expect(transport.subscribeCalls).toEqual([{ version: 1, roomId: "room-1", afterSeq: 9 }]);
  });

  it("keeps the previous complete room live until the final repair page commits", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const previous = cache.liveRoom("room-1");
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const records = [roomRecord, { kind: "message", value: event(1).payload } satisfies RoomRepairRecord];
    transport.repairs.set("room-1", [
      repairPage({ records: [records[0]!], hasMore: true, snapshotChecksum: checksum("room", records) }),
      repairPage({ page: 1, records: [records[1]!], hasMore: false, snapshotChecksum: checksum("room", records) }),
    ]);
    const originalPage = transport.repairRoomPage.bind(transport);
    transport.repairRoomPage = async (...args) => { await paused; return originalPage(...args); };

    const restoring = replica.repairRoom("room-1");
    await Promise.resolve();
    expect(cache.liveRoom("room-1")).toEqual(previous);
    release();
    await restoring;
    expect(cache.liveRoom("room-1")?.records).toEqual(records);
  });

  it("commits streaming repair only after an idempotent completion retry succeeds", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const page = streamingRepairPage();
    transport.repairs.set("room-1", [page]);
    transport.completeFailures.push(new SnapshotCompletionOutcomeUnknownError());
    const replica = createClientSyncReplica({ transport, cache });

    await replica.repairRoom("room-1");

    expect(transport.completeCalls).toHaveLength(2);
    expect(transport.completeCalls[0]).toEqual({
      snapshotId: page.snapshotId,
      version: { kind: "room", roomId: "room-1", watermark: 9 },
      checksum: page.snapshotChecksum,
    });
    expect(cache.liveRoom("room-1")?.cursor.afterSeq).toBe(9);
  });

  it.each([401, 403, 409, 410])("does not retry an explicit completion status %i", async (status) => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.repairs.set("room-1", [streamingRepairPage()]);
    transport.completeFailures.push(statusError(status));
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toMatchObject({ status });

    expect(transport.completeCalls).toHaveLength(1);
    expect(cache.liveRoom("room-1")).toBeUndefined();
    expect(cache.hasStaging()).toBe(false);
  });

  it("restarts a stale streaming repair with bounded 250ms and 1s backoff", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.repairs.set("room-1", [streamingRepairPage()]);
    const stale = () => Object.assign(new Error("snapshot stale"), {
      status: 409,
      code: "snapshot_stale",
    });
    transport.completeFailures.push(stale(), stale());
    const replica = createClientSyncReplica({ transport, cache });

    const repairing = replica.repairRoom("room-1");
    await vi.advanceTimersByTimeAsync(249);
    expect(transport.repairBeginCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.repairBeginCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(repairing).resolves.toBeUndefined();

    expect(transport.repairBeginCalls).toBe(3);
    expect(transport.completeCalls).toHaveLength(3);
    expect(cache.liveRoom("room-1")?.cursor.afterSeq).toBe(9);
    vi.useRealTimers();
  });

  it("single-flights concurrent repair for the same room", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const originalBegin = transport.repairRoomBegin.bind(transport);
    transport.repairRoomBegin = async (requestId, roomId) => { await paused; return originalBegin(requestId, roomId); };
    const replica = createClientSyncReplica({ transport, cache });

    const first = replica.repairRoom("room-1");
    const second = replica.repairRoom("room-1");
    release();
    await Promise.all([first, second]);

    expect(transport.repairBeginCalls).toBe(1);
    expect(transport.subscribeCalls).toHaveLength(1);
  });

  it.each([
    ["out-of-order page", (pages: RoomRepairPage[]) => { pages[1] = repairPage({ ...pages[1], page: 2 }); }],
    ["duplicate page", (pages: RoomRepairPage[]) => { pages[1] = repairPage({ ...pages[1], page: 0 }); }],
    ["wrong snapshot", (pages: RoomRepairPage[]) => { pages[1] = repairPage({ ...pages[1], snapshotId: "other" }); }],
    ["wrong room", (pages: RoomRepairPage[]) => { pages[1] = repairPage({ ...pages[1], roomId: "room-2" }); }],
    ["changed watermark", (pages: RoomRepairPage[]) => { pages[1] = repairPage({ ...pages[1], watermark: 10 }); }],
    ["changed mode", (pages: RoomRepairPage[]) => { pages[1] = repairPage({ ...pages[1], mode: "streaming", idleExpiresAt: "soon", expiresAt: undefined } as Partial<RoomRepairPage>); }],
    ["checksum mismatch", (pages: RoomRepairPage[]) => { pages[1] = repairPage({ ...pages[1], snapshotChecksum: "wrong" }); }],
  ])("rejects %s, discards staging, and preserves the old complete room", async (_name, mutate) => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const previous = cache.liveRoom("room-1");
    const records = [roomRecord, { kind: "message", value: event(1).payload } satisfies RoomRepairRecord];
    const pages = [
      repairPage({ records: [records[0]!], hasMore: true, snapshotChecksum: checksum("room", records) }),
      repairPage({ page: 1, records: [records[1]!], hasMore: false, snapshotChecksum: checksum("room", records) }),
    ];
    mutate(pages);
    transport.repairs.set("room-1", pages);

    await expect(replica.repairRoom("room-1")).rejects.toBeInstanceOf(ClientSyncReplicaError);
    expect(cache.liveRoom("room-1")).toEqual(previous);
    expect(cache.hasStaging()).toBe(false);
  });

  it("rejects a stable but false checksum after reading every room page", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.repairs.set("room-1", [repairPage({ snapshotChecksum: "f".repeat(64) })]);
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toBeInstanceOf(ClientSyncReplicaError);
    expect(cache.liveRoom("room-1")).toBeUndefined();
    expect(cache.hasStaging()).toBe(false);
  });

  it("rejects a stable but false catalog checksum without exposing its rooms", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.catalog = [catalogPage({ snapshotChecksum: "e".repeat(64) })];
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.restoreWorkspace()).rejects.toBeInstanceOf(ClientSyncReplicaError);
    expect(cache.liveCatalog()).toEqual([]);
    expect(cache.hasStaging()).toBe(false);
  });

  it.each([401, 403, 409, 410])("discards staging on transport status %i", async (status) => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.repairs.set("room-1", [repairPage({ hasMore: true })]);
    transport.repairRoomPage = async () => { throw statusError(status); };
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toMatchObject({ status });
    expect(cache.liveRoom("room-1")).toBeUndefined();
    expect(cache.hasStaging()).toBe(false);
  });

  it("applies paginated delta and live overlap once while preserving final cursor semantics", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const first = event(10);
    const second = event(11);
    transport.syncResults.push(
      {
        type: "room.sync.result", requestId: "placeholder", mode: "delta",
        events: [first], nextCursor: { version: 1, roomId: "room-1", afterSeq: 10, watermark: 11 },
        watermark: 11, hasMore: true,
      },
      {
        type: "room.sync.result", requestId: "placeholder", mode: "delta",
        events: [second],
        nextCursor: { version: 1, roomId: "room-1", afterSeq: 11 }, watermark: 11, hasMore: false,
      },
    );
    const original = transport.syncRoom.bind(transport);
    transport.syncRoom = async (request) => ({ ...await original(request), requestId: request.requestId });
    const replica = createClientSyncReplica({ transport, cache });

    await replica.repairRoom("room-1");
    await transport.observer!.events([second], { version: 1, roomId: "room-1", afterSeq: 11 });

    expect(cache.liveRoom("room-1")?.events.map((item) => item.eventId)).toEqual([first.eventId, second.eventId]);
    expect(cache.roomCursor("room-1")).toEqual({ version: 1, roomId: "room-1", afterSeq: 11 });
    expect(transport.syncRequests[1]?.cursor).toEqual({ version: 1, roomId: "room-1", afterSeq: 10, watermark: 11 });
  });

  it("rejects a delta gap relative to the requested cursor", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.syncResults.push({
      type: "room.sync.result", requestId: "placeholder", mode: "delta",
      events: [event(11)], nextCursor: { version: 1, roomId: "room-1", afterSeq: 11 },
      watermark: 11, hasMore: false,
    });
    const original = transport.syncRoom.bind(transport);
    transport.syncRoom = async (request) => ({ ...await original(request), requestId: request.requestId });
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toBeInstanceOf(ClientSyncReplicaError);
    expect(cache.roomCursor("room-1")).toEqual({ version: 1, roomId: "room-1", afterSeq: 9 });
    expect(cache.liveRoom("room-1")?.events).toEqual([]);
  });

  it("rejects a changed fixed watermark between delta pages", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.syncResults.push(
      {
        type: "room.sync.result", requestId: "placeholder", mode: "delta", events: [event(10)],
        nextCursor: { version: 1, roomId: "room-1", afterSeq: 10, watermark: 12 },
        watermark: 12, hasMore: true,
      },
      {
        type: "room.sync.result", requestId: "placeholder", mode: "delta", events: [event(11), event(12), event(13)],
        nextCursor: { version: 1, roomId: "room-1", afterSeq: 13 }, watermark: 13, hasMore: false,
      },
    );
    const original = transport.syncRoom.bind(transport);
    transport.syncRoom = async (request) => ({ ...await original(request), requestId: request.requestId });
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toBeInstanceOf(ClientSyncReplicaError);
  });

  it("does not expose an earlier delta page when a later page requires repair", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.syncResults.push(
      {
        type: "room.sync.result", requestId: "placeholder", mode: "delta", events: [event(10)],
        nextCursor: { version: 1, roomId: "room-1", afterSeq: 10, watermark: 11 },
        watermark: 11, hasMore: true,
      },
      {
        type: "room.sync.result", requestId: "placeholder", mode: "repair_required",
        reason: "cursor_expired", retainedFromSeq: 11, watermark: 11,
      },
    );
    const original = transport.syncRoom.bind(transport);
    transport.syncRoom = async (request) => ({ ...await original(request), requestId: request.requestId });
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toBeInstanceOf(ClientSyncReplicaError);

    expect(cache.roomCursor("room-1")).toEqual({ version: 1, roomId: "room-1", afterSeq: 9 });
    expect(cache.liveRoom("room-1")?.events).toEqual([]);
  });

  it("rejects duplicate room IDs in a catalog before repairing them twice", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const rooms = [roomSummary, roomSummary];
    transport.catalog = [catalogPage({ rooms, snapshotChecksum: checksum("catalog", rooms) })];
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.restoreWorkspace()).rejects.toBeInstanceOf(ClientSyncReplicaError);
    expect(transport.repairBeginCalls).toBe(0);
  });

  it("clears every local cache and fully rediscovers rooms from authority", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();

    await replica.clearAndRestore();

    expect(cache.liveCatalog()).toEqual([roomSummary]);
    expect(cache.liveRoom("room-1")?.records).toEqual([roomRecord]);
    expect(transport.subscribeCalls).toHaveLength(2);
    expect(transport.subscriptions[0]?.closed).toBe(true);
  });

  it("durably resyncs from a subscription retry cursor before resubscribing", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const next = event(10);
    transport.syncResults.push({
      type: "room.sync.result", requestId: "placeholder", mode: "delta", events: [next],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 10 }, watermark: 10, hasMore: false,
    });
    const original = transport.syncRoom.bind(transport);
    transport.syncRoom = async (request) => ({ ...await original(request), requestId: request.requestId });

    await transport.observer!.retry({ version: 1, roomId: "room-1", afterSeq: 9 });

    expect(cache.liveRoom("room-1")?.events.map((item) => item.eventId)).toEqual([next.eventId]);
    expect(transport.subscribeCalls.at(-1)).toEqual({ version: 1, roomId: "room-1", afterSeq: 10 });
    expect(transport.subscriptions[0]?.closed).toBe(true);
  });

  it("rejects a malformed subscription retry cursor before durable sync", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const syncCount = transport.syncRequests.length;

    await expect(transport.observer!.retry(
      { version: 2, roomId: "room-1", afterSeq: 9 } as unknown as RoomCursor,
    )).rejects.toBeInstanceOf(ClientSyncReplicaError);

    expect(transport.syncRequests).toHaveLength(syncCount);
    expect(transport.subscriptions[0]?.closed).toBe(false);
  });

  it("applies overlapping live events once and never moves the cursor backwards", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const live = event(10);

    await transport.observer!.events([live, live], { version: 1, roomId: "room-1", afterSeq: 10 });
    await expect(transport.observer!.events([], { version: 1, roomId: "room-1", afterSeq: 9 }))
      .rejects.toBeInstanceOf(ClientSyncReplicaError);

    expect(cache.liveRoom("room-1")?.events).toEqual([live]);
    expect(cache.roomCursor("room-1")?.afterSeq).toBe(10);
  });

  it("ignores a late observer after its subscription was replaced", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const stale = transport.observer!;
    await replica.repairRoom("room-1");

    await stale.events([event(10)], { version: 1, roomId: "room-1", afterSeq: 10 });

    expect(cache.roomCursor("room-1")?.afterSeq).toBe(9);
    expect(cache.liveRoom("room-1")?.events).toEqual([]);
  });

  it("keeps the newly committed complete room when subscribe fails after delta", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const previous = cache.liveRoom("room-1");
    const replacement = { kind: "message", value: event(2).payload } satisfies RoomRepairRecord;
    transport.repairs.set("room-1", [repairPage({ records: [roomRecord, replacement],
      snapshotChecksum: checksum("room", [roomRecord, replacement]) })]);
    transport.subscribeRoom = async () => { throw statusError(401); };

    await expect(replica.repairRoom("room-1")).rejects.toMatchObject({ status: 401 });

    expect(cache.liveRoom("room-1")).not.toEqual(previous);
    expect(cache.liveRoom("room-1")?.records).toEqual([roomRecord, replacement]);
    expect(cache.hasStaging()).toBe(false);
  });

  it("does not commit or subscribe when closed during an in-flight repair", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const original = transport.repairRoomBegin.bind(transport);
    transport.repairRoomBegin = async (...args) => { await paused; return original(...args); };
    const replica = createClientSyncReplica({ transport, cache });

    const repairing = replica.repairRoom("room-1");
    replica.close();
    release();

    await expect(repairing).rejects.toBeInstanceOf(ClientSyncReplicaError);
    expect(cache.liveRoom("room-1")).toBeUndefined();
    expect(transport.subscribeCalls).toEqual([]);
  });

  it("does not retry a malformed completion response", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.repairs.set("room-1", [streamingRepairPage()]);
    const original = transport.completeSnapshot.bind(transport);
    let calls = 0;
    transport.completeSnapshot = async (...args) => {
      calls += 1;
      const completed = await original(...args);
      return calls === 1 ? { ...completed, snapshotId: "wrong-snapshot" } : completed;
    };
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toBeInstanceOf(ClientSyncReplicaError);
    expect(calls).toBe(1);
  });

  it("rejects a page whose requestId does not match the current request", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const records = [roomRecord, { kind: "message", value: event(1).payload } satisfies RoomRepairRecord];
    transport.repairs.set("room-1", [
      repairPage({ records: [records[0]!], hasMore: true, snapshotChecksum: checksum("room", records) }),
      repairPage({ page: 1, requestId: "wrong-request", records: [records[1]!], hasMore: false,
        snapshotChecksum: checksum("room", records) }),
    ]);
    const original = transport.repairRoomPage.bind(transport);
    transport.repairRoomPage = async (...args) => ({ ...await original(...args), requestId: "wrong-request" });
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toBeInstanceOf(ClientSyncReplicaError);
    expect(cache.liveRoom("room-1")).toBeUndefined();
  });

  it("validates buffered subscription events before committing the replacement room", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const previous = cache.liveRoom("room-1");
    const replacement: RoomRepairRecord = {
      kind: "room",
      value: { ...roomRecord.value, name: "Replacement" },
    };
    transport.repairs.set("room-1", [repairPage({
      records: [replacement],
      snapshotChecksum: checksum("room", [replacement]),
    })]);
    transport.subscribeRoom = async (_roomId, cursor, observer) => {
      await observer.events([event(10)], { version: 1, roomId: "wrong-room", afterSeq: 10 });
      return new FakeSubscription(cursor);
    };

    await expect(replica.repairRoom("room-1")).rejects.toBeInstanceOf(ClientSyncReplicaError);

    expect(cache.liveRoom("room-1")).not.toEqual(previous);
    expect(cache.liveRoom("room-1")?.records).toEqual([replacement]);
    expect(cache.liveRoom("room-1")?.events).toEqual([]);
    expect(cache.hasStaging()).toBe(false);
  });

  it("ignores a wholly duplicate stale subscription batch after newer live events", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.subscribeRoom = async (roomId, cursor, observer) => {
      expect(roomId).toBe("room-1");
      await observer.events([event(10)], {
        version: 1, roomId: "room-1", afterSeq: 10,
      });
      await observer.events([event(11)], {
        version: 1, roomId: "room-1", afterSeq: 11,
      });
      await observer.events([event(10)], {
        version: 1, roomId: "room-1", afterSeq: 10,
      });
      return new FakeSubscription({ ...cursor, afterSeq: 11 });
    };
    const replica = createClientSyncReplica({ transport, cache });

    await replica.repairRoom("room-1");

    expect(cache.liveRoom("room-1")?.events.map((item) => item.streamSeq)).toEqual([10, 11]);
    expect(cache.roomCursor("room-1")).toEqual({
      version: 1, roomId: "room-1", afterSeq: 11,
    });
  });

  it("does not let a stale retry replace a newer room subscription", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const stale = transport.observer!;
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const syncReached = new Promise<void>((resolve) => { reached = resolve; });
    const originalSync = transport.syncRoom.bind(transport);
    let syncCalls = 0;
    transport.syncRoom = async (request) => {
      syncCalls += 1;
      if (syncCalls === 1) {
        reached();
        await paused;
      }
      return originalSync(request);
    };

    const retrying = stale.retry({ version: 1, roomId: "room-1", afterSeq: 9 });
    await syncReached;
    await replica.repairRoom("room-1");
    expect(transport.subscribeCalls).toHaveLength(2);
    release();
    await retrying;

    expect(transport.subscribeCalls).toHaveLength(2);
    expect(transport.subscriptions[1]?.closed).toBe(false);
  });

  it("rejects an empty delta that skips unseen sequence numbers", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    transport.syncResults.push({
      type: "room.sync.result", requestId: "placeholder", mode: "delta", events: [],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 11 }, watermark: 11, hasMore: false,
    });
    const original = transport.syncRoom.bind(transport);
    transport.syncRoom = async (request) => ({ ...await original(request), requestId: request.requestId });
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toBeInstanceOf(ClientSyncReplicaError);
    expect(cache.roomCursor("room-1")).toEqual({ version: 1, roomId: "room-1", afterSeq: 9 });
    expect(cache.liveRoom("room-1")?.events).toEqual([]);
  });

  it("rejects malformed live event and cursor values at the observer boundary", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    const malformedEvent = { ...event(10), type: "room.unknown", extra: true };

    await expect(transport.observer!.events(
      [malformedEvent as unknown as PersistedRoomEvent],
      { version: 2, roomId: "room-1", afterSeq: 10 } as unknown as RoomCursor,
    )).rejects.toBeInstanceOf(ClientSyncReplicaError);

    expect(cache.roomCursor("room-1")?.afterSeq).toBe(9);
    expect(cache.liveRoom("room-1")?.events).toEqual([]);
  });

  it("single-flights concurrent workspace restores without crossing catalog staging", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const original = transport.bootstrapBegin.bind(transport);
    let calls = 0;
    transport.bootstrapBegin = async (requestId) => {
      calls += 1;
      reached();
      await paused;
      return original(requestId);
    };
    const replica = createClientSyncReplica({ transport, cache });

    const first = replica.restoreWorkspace();
    await entered;
    const second = replica.restoreWorkspace();
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(cache.liveCatalog()).toEqual([roomSummary]);
    expect(transport.repairBeginCalls).toBe(1);
  });

  it("does not reject an installed replacement when closing the old subscription throws", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const replica = createClientSyncReplica({ transport, cache });
    await replica.restoreWorkspace();
    transport.subscriptions[0]!.close = () => { throw new Error("close failed"); };

    await expect(replica.repairRoom("room-1")).resolves.toBeUndefined();

    expect(transport.subscriptions[1]?.closed).toBe(false);
    expect(cache.liveRoom("room-1")?.records).toEqual([roomRecord]);
  });

  it("discards room staging when beginRoom creates staging and then throws", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const original = cache.beginRoom.bind(cache);
    cache.beginRoom = (roomId, snapshotId) => {
      original(roomId, snapshotId);
      throw new Error("begin room failed");
    };
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.repairRoom("room-1")).rejects.toThrow("begin room failed");

    expect(cache.hasStaging()).toBe(false);
    expect(cache.liveRoom("room-1")).toBeUndefined();
  });

  it("discards catalog staging when beginCatalog creates staging and then throws", async () => {
    const transport = new FakeTransport();
    const cache = new MemoryCache();
    const original = cache.beginCatalog.bind(cache);
    cache.beginCatalog = (snapshotId) => {
      original(snapshotId);
      throw new Error("begin catalog failed");
    };
    const replica = createClientSyncReplica({ transport, cache });

    await expect(replica.restoreWorkspace()).rejects.toThrow("begin catalog failed");

    expect(cache.hasStaging()).toBe(false);
    expect(cache.liveCatalog()).toEqual([]);
  });
});
