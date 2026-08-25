import { describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot, RoomRepairRecord } from "@native-im/core";
import type { ProjectLoopWireRequest, ProjectLoopWireResponse } from "./contracts.js";
import { createDesktopProjectLoopRuntime } from "./production-runtime.js";
import { projectSnapshot } from "./test-fixture.js";

type RecordsListener = (roomId: string, records: readonly RoomRepairRecord[] | undefined) => void;

function createCacheHarness(snapshots: readonly ProjectSnapshot[]) {
  const listeners = new Set<RecordsListener>();
  const records = new Map<string, readonly RoomRepairRecord[]>();
  let repairCount = 0;
  const publish = (roomId: string) => {
    for (const listener of listeners) listener(roomId, records.get(roomId));
  };
  return {
    cache: {
      roomRepairRecords(roomId: string) { return records.get(roomId); },
      subscribeRoomRecords(listener: RecordsListener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async repairRoom(roomId: string) {
      const snapshot = snapshots[Math.min(repairCount, snapshots.length - 1)];
      repairCount += 1;
      if (snapshot === undefined) throw new Error("repair unavailable");
      records.set(roomId, [{ kind: "project-loop", roomId, value: snapshot }]);
      publish(roomId);
    },
    invalidate(roomId: string) { records.set(roomId, []); publish(roomId); },
    clear(roomId: string) { records.delete(roomId); publish(roomId); },
    seed(roomId: string, snapshot: ProjectSnapshot) {
      records.set(roomId, [{ kind: "project-loop", roomId, value: snapshot }]);
    },
    seedRecords(roomId: string, value: readonly RoomRepairRecord[]) { records.set(roomId, value); publish(roomId); },
    get repairCount() { return repairCount; },
  };
}

function createTransport(projectRequest: (frame: ProjectLoopWireRequest) => Promise<ProjectLoopWireResponse>) {
  let revoked: (() => void) | undefined;
  let failed: (() => void) | undefined;
  let access: ((roomId: string, change: "joined" | "updated" | "removed" | "archived") => void) | undefined;
  return {
    transport: {
      projectRequest,
      onTerminalRevoked(listener: () => void) { revoked = listener; return () => { revoked = undefined; }; },
      onRoomAccessChanged(listener: NonNullable<typeof access>) { access = listener; return () => { access = undefined; }; },
      onConnectionFailure(listener: () => void) { failed = listener; return () => { failed = undefined; }; },
    },
    revoke: () => revoked?.(), fail: () => failed?.(),
    remove: (roomId: string) => access?.(roomId, "removed"),
  };
}

const session = () => ({ actorId: "human-2", sessionId: "session-1",
  accessToken: "token", expiresAt: "2026-08-26T00:00:00.000Z" });

describe("FT-09 Desktop Project Loop production runtime", () => {
  it("sends exact intents, exposes ACK, and repairs the central fixed-watermark cache", async () => {
    const calls: ProjectLoopWireRequest[] = [];
    let releaseMutation: (() => void) | undefined;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const wire = createTransport(async (frame) => {
      calls.push(frame);
      if (frame.type === "project.snapshot.read") throw new Error("local snapshot RPC is forbidden");
      await mutationGate;
      return { type: "project.mutation.ack", requestId: frame.requestId, roomId: frame.roomId,
        projectId: frame.projectId, acceptedRevision: 8, eventIds: ["event-8"], replayed: false };
    });
    const cache = createCacheHarness([projectSnapshot(), projectSnapshot({ watermark: 8 })]);
    let sequence = 0;
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: `request-${++sequence}`, idempotencyKey: `idem-${sequence}` }) });
    await runtime.getSurface({ roomId: "room-1" });
    const states: unknown[] = []; runtime.subscribe((input) => states.push(input.state));
    const submitted = runtime.submit({ roomId: "room-1", intent: { kind: "request.transition",
      intentId: "accept-request-1", factId: "request-1", expectedRevision: 3, action: "accept" } });
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({ status: "ready", snapshot: { watermark: 7 },
      operation: { status: "submitting" } });
    releaseMutation?.();
    await submitted;
    expect(calls).toEqual([expect.objectContaining({ type: "project.request.transition", roomId: "room-1",
      projectId: "room-1", factId: "request-1", expectedRevision: 3, action: "accept" })]);
    expect(states.some((state) => (state as { operation?: { status?: string } }).operation?.status === "acknowledged"))
      .toBe(true);
    expect(cache.repairCount).toBe(2);
    expect(states.at(-1)).toMatchObject({ snapshot: { watermark: 8 }, connection: { status: "online" } });
    runtime.close();
  });

  it("locks on terminal or Room access revocation and retains the repaired cache while offline", async () => {
    const wire = createTransport(async () => { throw new Error("unexpected mutation"); });
    const cache = createCacheHarness([projectSnapshot(), projectSnapshot()]);
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: "request-1", idempotencyKey: "idem-1" }),
      now: () => "2026-08-25T05:00:00.000Z" });
    const states: unknown[] = []; runtime.subscribe((input) => states.push(input.state));
    await runtime.getSurface({ roomId: "room-1" });
    wire.fail();
    expect(states.at(-1)).toMatchObject({ status: "ready",
      connection: { status: "offline" }, snapshot: { watermark: 7 } });
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({ status: "ready",
      connection: { status: "online" }, snapshot: { watermark: 7 } });
    wire.remove("room-1");
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({ status: "locked",
      error: { status: 410 } });
    wire.revoke();
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({ status: "locked",
      error: { status: 401 } });
    runtime.close();
  });

  it("repairs when a stable Project event invalidates the central cache", async () => {
    const wire = createTransport(async () => { throw new Error("unexpected mutation"); });
    const cache = createCacheHarness([projectSnapshot(), projectSnapshot({ watermark: 9 })]);
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: "request-1", idempotencyKey: "idem-1" }) });
    const states: unknown[] = []; runtime.subscribe((input) => states.push(input.state));
    await runtime.getSurface({ roomId: "room-1" });
    cache.invalidate("room-1");
    await vi.waitFor(() => expect(cache.repairCount).toBe(2));
    expect(states.some((state) => (state as { connection?: { status?: string } }).connection?.status === "repairing"))
      .toBe(true);
    expect(states.at(-1)).toMatchObject({ status: "ready", snapshot: { watermark: 9 },
      connection: { status: "online" } });
    runtime.close();
  });

  it("opens the last complete restored cache read-only when cold-start repair is offline", async () => {
    const wire = createTransport(async () => { throw new Error("unexpected mutation"); });
    const cache = createCacheHarness([]);
    cache.seed("room-1", projectSnapshot());
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: async () => { throw new Error("offline"); },
      restoreAuthorityCache: async () => true,
      createRequestIdentity: () => ({ requestId: "request-1", idempotencyKey: "idem-1" }),
      now: () => "2026-08-25T05:00:00.000Z" });
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", snapshot: { watermark: 7 }, connection: { status: "offline",
        asOf: "2026-08-25T05:00:00.000Z" },
    });
    runtime.close();
  });

  it("keeps an archived Room readable while disabling every Project mutation", async () => {
    const mutation = vi.fn(async (): Promise<ProjectLoopWireResponse> => { throw new Error("unexpected mutation"); });
    const wire = createTransport(mutation);
    const cache = createCacheHarness([]);
    cache.seedRecords("room-1", [{ kind: "room", value: { id: "room-1", name: "Room",
      status: "archived", createdAt: "2026-08-25T01:00:00.000Z" } },
    { kind: "project-loop", roomId: "room-1", value: projectSnapshot() }]);
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: async () => {}, restoreAuthorityCache: async () => true,
      createRequestIdentity: () => ({ requestId: "request-1", idempotencyKey: "idem-1" }) });
    const state = await runtime.getSurface({ roomId: "room-1" });
    expect(state).toMatchObject({ status: "ready", operation: { status: "failed",
      error: { status: 410, code: "room_archived" } } });
    if (state.status === "ready") {
      await runtime.submit({ roomId: "room-1", intent: { kind: "request.transition",
        intentId: "cancel-request", factId: "request-1", expectedRevision: 3,
        action: "cancel", reason: "No longer needed" } });
    }
    expect(mutation).not.toHaveBeenCalled();
    runtime.close();
  });

  it("converges three Desktop clients after the same stable invalidation", async () => {
    const clients = Array.from({ length: 3 }, (_, index) => {
      const wire = createTransport(async () => { throw new Error("unexpected mutation"); });
      const cache = createCacheHarness([projectSnapshot(), projectSnapshot({ watermark: 9 })]);
      const runtime = createDesktopProjectLoopRuntime({ session: () => ({ ...session(), sessionId: `session-${index}` }),
        transport: wire.transport, authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
        restoreAuthorityCache: async () => false,
        createRequestIdentity: () => ({ requestId: `request-${index}`, idempotencyKey: `idem-${index}` }) });
      return { cache, runtime };
    });
    await Promise.all(clients.map(({ runtime }) => runtime.getSurface({ roomId: "room-1" })));
    for (const { cache } of clients) cache.invalidate("room-1");
    await vi.waitFor(() => expect(clients.map(({ cache }) => cache.repairCount)).toEqual([2, 2, 2]));
    await expect(Promise.all(clients.map(({ runtime }) => runtime.getSurface({ roomId: "room-1" }))))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "ready", snapshot: expect.objectContaining({ watermark: 9 }) }),
      ]));
    for (const { runtime } of clients) runtime.close();
  });

  it("rediscovers Project after central clear-cache and follows archived to reopened lifecycle", async () => {
    const wire = createTransport(async () => { throw new Error("unexpected mutation"); });
    const cache = createCacheHarness([projectSnapshot({ watermark: 10 })]);
    let repairEnabled = false;
    cache.seedRecords("room-1", [{ kind: "room", value: { id: "room-1", name: "Room",
      status: "archived", createdAt: "2026-08-25T01:00:00.000Z" } },
    { kind: "project-loop", roomId: "room-1", value: projectSnapshot() }]);
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => repairEnabled
        ? cache.repairRoom(roomId) : Promise.reject(new Error("offline")),
      restoreAuthorityCache: async () => true,
      createRequestIdentity: () => ({ requestId: "request-reopen", idempotencyKey: "idem-reopen" }) });
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", operation: { status: "failed", error: { status: 410, code: "room_archived" } },
    });
    cache.seedRecords("room-1", [{ kind: "room", value: { id: "room-1", name: "Room",
      status: "active", createdAt: "2026-08-25T01:00:00.000Z" } },
    { kind: "project-loop", roomId: "room-1", value: projectSnapshot({ watermark: 9 }) }]);
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", snapshot: { watermark: 9 }, operation: { status: "idle" },
    });
    repairEnabled = true;
    cache.clear("room-1");
    await vi.waitFor(() => expect(cache.repairCount).toBe(1));
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", snapshot: { watermark: 10 }, operation: { status: "idle" },
    });
    runtime.close();
  });
});
