import { describe, expect, it, vi } from "vitest";
import { deriveProjectBallFacts, type ProjectSnapshot, type RoomRepairRecord } from "@native-im/core";
import type { ProjectLoopWireRequest, ProjectLoopWireResponse } from "./contracts.js";
import type { ProjectLoopIntent } from "../renderer/project-loop/surface.js";
import type { ProjectLoopRemoteState } from "../renderer/project-loop/view-model.js";
import { GovernanceTransportError } from "../governance/websocket-authority.js";
import { createDesktopProjectLoopRuntime } from "./production-runtime.js";
import { projectSnapshot } from "./test-fixture.js";

type RecordsListener = (roomId: string, records: readonly RoomRepairRecord[] | undefined) => void;

function createCacheHarness(snapshots: readonly ProjectSnapshot[]) {
  const listeners = new Set<RecordsListener>();
  const records = new Map<string, readonly RoomRepairRecord[]>();
  let repairCount = 0;
  let offlineAuthorized = true;
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
      clearRoom(roomId: string) { records.delete(roomId); publish(roomId); },
      clear() {
        const roomIds = [...records.keys()]; records.clear();
        for (const roomId of roomIds) publish(roomId);
      },
      isOfflineReadAuthorized: () => offlineAuthorized,
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
    setOfflineAuthorized(value: boolean) { offlineAuthorized = value; },
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
    join: (roomId: string) => access?.(roomId, "joined"),
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

  it("locks a restored Project snapshot when no signed offline capability is active", async () => {
    const wire = createTransport(async () => { throw new Error("unexpected mutation"); });
    const cache = createCacheHarness([]);
    cache.seed("room-1", projectSnapshot());
    cache.setOfflineAuthorized(false);
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: async () => { throw new Error("offline"); },
      restoreAuthorityCache: async () => true,
      createRequestIdentity: () => ({ requestId: "request-locked", idempotencyKey: "idem-locked" }),
      now: () => "2026-08-25T05:00:00.000Z" });
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "locked", error: { status: 503, code: "project_dependency_unavailable" },
    });
    runtime.close();
  });

  it("purges and locks a restored Room when central repair explicitly denies access", async () => {
    const wire = createTransport(async () => { throw new Error("unexpected mutation"); });
    const cache = createCacheHarness([]);
    cache.seed("room-1", projectSnapshot());
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache,
      repairRoom: async () => { throw new GovernanceTransportError("access_revoked", 403); },
      restoreAuthorityCache: async () => true,
      createRequestIdentity: () => ({ requestId: "request-1", idempotencyKey: "idem-1" }) });
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "locked", error: { status: 410, code: "access_revoked" },
    });
    expect(cache.cache.roomRepairRecords("room-1")).toBeUndefined();
    runtime.close();
  });

  it("discards a deferred repair that completes after Room access was revoked", async () => {
    const wire = createTransport(async () => { throw new Error("unexpected mutation"); });
    const cache = createCacheHarness([projectSnapshot()]);
    let releaseRepair!: () => void;
    let markRepairStarted!: () => void;
    const repairStarted = new Promise<void>((resolve) => { markRepairStarted = resolve; });
    const repairGate = new Promise<void>((resolve) => { releaseRepair = resolve; });
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache,
      repairRoom: async (roomId) => {
        markRepairStarted();
        await repairGate;
        await cache.repairRoom(roomId);
      },
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: "request-race", idempotencyKey: "idem-race" }) });

    const loading = runtime.getSurface({ roomId: "room-1" });
    await repairStarted;
    wire.remove("room-1");
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "locked", error: { status: 410, code: "room_access_removed" },
    });
    releaseRepair();

    await expect(loading).resolves.toMatchObject({
      status: "locked", error: { status: 410, code: "room_access_removed" },
    });
    expect(cache.cache.roomRepairRecords("room-1")).toBeUndefined();
    runtime.close();
  });

  it("starts a new-generation repair after access is restored while the revoked repair is pending", async () => {
    const wire = createTransport(async () => { throw new Error("unexpected mutation"); });
    const cache = createCacheHarness([
      projectSnapshot({ watermark: 8 }),
      projectSnapshot({ watermark: 9 }),
    ]);
    let releaseFirstRepair!: () => void;
    let markFirstRepairStarted!: () => void;
    const firstRepairStarted = new Promise<void>((resolve) => { markFirstRepairStarted = resolve; });
    const firstRepairGate = new Promise<void>((resolve) => { releaseFirstRepair = resolve; });
    let repairCount = 0;
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache,
      repairRoom: async (roomId) => {
        repairCount += 1;
        if (repairCount === 1) {
          markFirstRepairStarted();
          await firstRepairGate;
        }
        await cache.repairRoom(roomId);
      },
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: "request-race", idempotencyKey: "idem-race" }) });
    const states: ProjectLoopRemoteState[] = [];
    runtime.subscribe(({ state }) => states.push(state));

    const initial = runtime.getSurface({ roomId: "room-1" });
    await firstRepairStarted;
    wire.remove("room-1");
    wire.join("room-1");
    releaseFirstRepair();

    await initial;
    await vi.waitFor(() => expect(repairCount).toBe(2));
    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", snapshot: { watermark: 9 }, connection: { status: "online" },
    });
    expect(cache.cache.roomRepairRecords("room-1")).toEqual([
      expect.objectContaining({ kind: "project-loop", value: expect.objectContaining({ watermark: 9 }) }),
    ]);
    expect(states.some((state) => state.status === "ready" && state.snapshot.watermark === 8)).toBe(false);
    runtime.close();
  });

  it("purges every restored projection when a direct transport 401 revokes the session", async () => {
    const wire = createTransport(async () => { throw new GovernanceTransportError("session_revoked", 401); });
    const cache = createCacheHarness([projectSnapshot()]);
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: "request-revoked", idempotencyKey: "idem-revoked" }) });
    await runtime.getSurface({ roomId: "room-1" });
    await expect(runtime.submit({ roomId: "room-1", intent: { kind: "request.transition",
      intentId: "cancel-revoked", factId: "request-1", expectedRevision: 3,
      action: "cancel", reason: "done" } })).resolves.toMatchObject({
        status: "locked", error: { status: 401, code: "session_revoked" },
      });
    expect(cache.cache.roomRepairRecords("room-1")).toBeUndefined();
    runtime.close();
  });

  it("distinguishes Room access revocation from an operation-only permission denial", async () => {
    let code = "permission_denied";
    const wire = createTransport(async () => { throw Object.assign(new Error(code), { projectError: {
      type: "error", status: 403, code, message: code, requestId: "request-1",
    } }); });
    const cache = createCacheHarness([projectSnapshot()]);
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: "request-1", idempotencyKey: "idem-1" }) });
    await runtime.getSurface({ roomId: "room-1" });
    const intent = { kind: "request.transition" as const, intentId: "cancel-request",
      factId: "request-1", expectedRevision: 3, action: "cancel" as const, reason: "No longer needed" };
    await expect(runtime.submit({ roomId: "room-1", intent })).resolves.toMatchObject({
      status: "ready", operation: { status: "failed", error: { status: 403, code: "permission_denied" } },
    });
    expect(cache.cache.roomRepairRecords("room-1")).toBeDefined();
    runtime.close();
    code = "room_forbidden";
    const revokedRuntime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: "request-2", idempotencyKey: "idem-2" }) });
    await revokedRuntime.getSurface({ roomId: "room-1" });
    await expect(revokedRuntime.submit({ roomId: "room-1",
      intent: { ...intent, intentId: "cancel-revoked" } }))
      .resolves.toMatchObject({ status: "locked", error: { status: 410, code: "room_forbidden" } });
    expect(cache.cache.roomRepairRecords("room-1")).toBeUndefined();
    revokedRuntime.close();
  });

  it.each([
    ["429", 429, "rate_limited"],
    ["503", 503, "project_dependency_unavailable"],
    ["timeout", 503, "project_dependency_unavailable"],
  ] as const)("retries %s with the frozen intent and the same request/idempotency identity",
  async (failure, expectedStatus, code) => {
    const calls: ProjectLoopWireRequest[] = [];
    const wire = createTransport(async (frame) => {
      calls.push(frame);
      if (calls.length === 1) {
        if (failure === "timeout") throw new Error("transport timed out");
        throw Object.assign(new Error(code), { projectError: {
          type: "error", status: expectedStatus, code, message: code, requestId: frame.requestId,
          ...(failure === "429" ? { retryAfterSeconds: 2 } : {}),
        } });
      }
      return { type: "project.mutation.ack", requestId: frame.requestId, roomId: frame.roomId,
        projectId: frame.projectId, acceptedRevision: 8, eventIds: ["event-8"], replayed: true };
    });
    const cache = createCacheHarness([projectSnapshot(), projectSnapshot({ watermark: 8 })]);
    const createRequestIdentity = vi.fn(() => ({ requestId: "request-frozen", idempotencyKey: "idem-frozen" }));
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false, createRequestIdentity });
    const intent = { kind: "request.transition" as const, intentId: "cancel-frozen",
      factId: "request-1", expectedRevision: 3, action: "cancel" as const, reason: "No longer needed" };
    await runtime.getSurface({ roomId: "room-1" });
    await expect(runtime.submit({ roomId: "room-1", intent })).resolves.toMatchObject({
      status: "ready", operation: { status: "failed", error: { status: expectedStatus, code } },
    });

    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", operation: { status: "idle" }, snapshot: { watermark: 8 },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(createRequestIdentity).toHaveBeenCalledTimes(1);
    runtime.close();
  });

  it("uses the explicit recovery request to repair and replay a 409 intent at the latest revision", async () => {
    const latest = projectSnapshot();
    const requests = latest.requests.map((request) => ({ ...request, revision: 4 }));
    const repaired = { ...latest, watermark: 8, requests, balls: deriveProjectBallFacts({
      roomId: latest.roomId, projectId: latest.projectId, requests,
      nextActions: latest.nextActions, obstacles: latest.obstacles, proposals: latest.proposals,
      confirmations: latest.confirmations, transferProposals: latest.transferProposals,
    }) };
    const calls: ProjectLoopWireRequest[] = [];
    const wire = createTransport(async (frame) => {
      calls.push(frame);
      if (calls.length === 1) throw Object.assign(new Error("conflict"), { projectError: {
        type: "error", status: 409, code: "revision_conflict",
        message: "conflict", requestId: frame.requestId,
      } });
      return { type: "project.mutation.ack", requestId: frame.requestId, roomId: frame.roomId,
        projectId: frame.projectId, acceptedRevision: 9, eventIds: ["event-9"], replayed: false };
    });
    const cache = createCacheHarness([latest, repaired, { ...repaired, watermark: 9 }]);
    let identity = 0;
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: `request-${++identity}`, idempotencyKey: `idem-${identity}` }) });
    const intent = { kind: "request.transition" as const, intentId: "cancel-conflict",
      factId: "request-1", expectedRevision: 3, action: "cancel" as const, reason: "No longer needed" };
    await runtime.getSurface({ roomId: "room-1" });
    await expect(runtime.submit({ roomId: "room-1", intent })).resolves.toMatchObject({
      status: "ready", operation: { status: "failed", error: { status: 409 } },
    });

    await expect(runtime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", operation: { status: "idle" }, snapshot: { watermark: 9 },
    });
    expect(calls).toEqual([
      expect.objectContaining({ requestId: "request-1", idempotencyKey: "idem-1", expectedRevision: 3 }),
      expect.objectContaining({ requestId: "request-2", idempotencyKey: "idem-2", expectedRevision: 4,
        action: "cancel", reason: "No longer needed" }),
    ]);
    runtime.close();
  });

  it("rebases transfer resolution to the current subject fact and refuses a stale proposal", async () => {
    const transferSnapshot = (actionRevision: number, transferRevision: number,
      subjectRevision: number, watermark: number): ProjectSnapshot => {
      const base = projectSnapshot(); const provenance = base.requests[0]!.provenance;
      const action = { recordVersion: "project-loop.v1" as const, roomId: "room-1", projectId: "room-1",
        revision: actionRevision, provenance, createdAt: base.capturedAt, updatedAt: base.capturedAt,
        kind: "next_action" as const, nextActionId: "action-transfer", title: "Transfer",
        description: "Transfer safely", owner: { kind: "human" as const, actorId: "human-1" },
        status: "accepted" as const, dueAt: null, deliverable: "release", acceptanceCriteria: [],
        verifier: null, acceptedBy: { kind: "human" as const, actorId: "human-1" },
        acceptedAt: base.capturedAt, delivery: null, completedBy: null, completedAt: null,
        statusReason: null, reassignmentChain: [] };
      const transfer = { recordVersion: "project-loop.v1" as const,
        transferProposalId: "transfer-resolution", roomId: "room-1", projectId: "room-1",
        revision: transferRevision, subjectKind: "next_action" as const,
        subjectId: action.nextActionId, subjectRevision, fromOwner: action.owner,
        toOwner: { kind: "human" as const, actorId: "human-2" }, proposedBy: action.owner,
        principalActorId: "human-2", reason: "handoff", status: "pending" as const,
        proposedAt: base.capturedAt, expiresAt: "2026-08-29T00:00:00.000Z",
        resolvedBy: null, resolvedAt: null, resolutionReason: null };
      return { ...base, watermark, nextActions: [action], transferProposals: [transfer],
        balls: deriveProjectBallFacts({ roomId: "room-1", projectId: "room-1",
          requests: base.requests, nextActions: [action], obstacles: [], proposals: base.proposals,
          confirmations: [], transferProposals: [transfer] }) };
    };
    const initial = transferSnapshot(2, 1, 2, 7);
    const rebound = transferSnapshot(4, 8, 4, 9);
    const calls: ProjectLoopWireRequest[] = [];
    const wire = createTransport(async (frame) => {
      calls.push(frame);
      if (calls.length === 1) throw Object.assign(new Error("conflict"), { projectError: {
        type: "error", status: 409, code: "revision_conflict", message: "conflict",
        requestId: frame.requestId,
      } });
      return { type: "project.mutation.ack", requestId: frame.requestId, roomId: frame.roomId,
        projectId: frame.projectId, acceptedRevision: 10, eventIds: ["event-10"], replayed: false };
    });
    const cache = createCacheHarness([initial, rebound, { ...rebound, watermark: 10 }]);
    let identity = 0;
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: `transfer-request-${++identity}`,
        idempotencyKey: `transfer-idem-${identity}` }) });
    const intent = { kind: "transfer.resolve" as const, intentId: "accept-transfer-resolution",
      transferProposalId: "transfer-resolution", subjectKind: "next_action" as const,
      subjectId: "action-transfer", expectedRevision: 2, resolution: "accepted" as const,
      reason: null };
    await runtime.getSurface({ roomId: "room-1" });
    await runtime.submit({ roomId: "room-1", intent });
    await runtime.getSurface({ roomId: "room-1" });
    expect(calls).toEqual([
      expect.objectContaining({ type: "project.transfer.resolve", expectedRevision: 2 }),
      expect.objectContaining({ type: "project.transfer.resolve", expectedRevision: 4 }),
    ]);
    runtime.close();

    const staleCalls: ProjectLoopWireRequest[] = [];
    const staleWire = createTransport(async (frame) => {
      staleCalls.push(frame);
      throw Object.assign(new Error("conflict"), { projectError: {
        type: "error", status: 409, code: "revision_conflict", message: "conflict",
        requestId: frame.requestId,
      } });
    });
    const stale = transferSnapshot(4, 8, 2, 9);
    const staleCache = createCacheHarness([initial, stale]);
    const staleRuntime = createDesktopProjectLoopRuntime({ session, transport: staleWire.transport,
      authorityCache: staleCache.cache, repairRoom: (roomId) => staleCache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: "stale-request", idempotencyKey: "stale-idem" }) });
    await staleRuntime.getSurface({ roomId: "room-1" });
    await staleRuntime.submit({ roomId: "room-1", intent });
    await expect(staleRuntime.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", snapshot: { watermark: 9, nextActions: [{ revision: 4 }],
        transferProposals: [{ revision: 8, subjectRevision: 2 }] },
    });
    expect(staleCalls).toHaveLength(1);
    staleRuntime.close();
  });

  it("wires every Desktop core-action family to the closed public Project protocol", async () => {
    const source = { kind: "message" as const, sourceId: "message-result", sourceRevision: 2,
      roomId: "room-1", visibility: "room" as const };
    const cases: readonly Readonly<{ intent: ProjectLoopIntent; expected: Record<string, unknown> }>[] = [
      { intent: { kind: "next_action.transition", intentId: "start-action", factId: "action-1",
        expectedRevision: 2, action: "start" }, expected: {
        type: "project.next-action.transition", factId: "action-1", action: "start" } },
      { intent: { kind: "next_action.transition", intentId: "complete-action", factId: "action-1",
        expectedRevision: 2, action: "complete", completionNote: "done",
        criteriaSnapshot: [{ criterionId: "c-1", text: "green" }] }, expected: {
        type: "project.next-action.transition", action: "complete", completionNote: "done",
        criteriaSnapshot: [{ criterionId: "c-1", text: "green" }] } },
      { intent: { kind: "next_action.transition", intentId: "deliver-action", factId: "action-1",
        expectedRevision: 2, action: "deliver", source, summary: "ready" }, expected: {
        type: "project.next-action.transition", action: "deliver", source, summary: "ready" } },
      { intent: { kind: "obstacle.transition", intentId: "resolve-blocker", factId: "blocker-1",
        expectedRevision: 2, obstacleKind: "blocker", action: "resolve", resultSource: source,
        reason: "fixed" }, expected: { type: "project.obstacle.transition", obstacleKind: "blocker",
        action: "resolve", resultSource: source, reason: "fixed" } },
      { intent: { kind: "obstacle.transition", intentId: "defer-question", factId: "question-1",
        expectedRevision: 2, obstacleKind: "open_question", action: "defer", reason: "waiting",
        reviewAt: "2026-08-28T00:00:00.000Z" }, expected: { type: "project.obstacle.transition",
        obstacleKind: "open_question", action: "defer", reason: "waiting",
        reviewAt: "2026-08-28T00:00:00.000Z" } },
      { intent: { kind: "obstacle.transition", intentId: "reopen-question", factId: "question-1",
        expectedRevision: 3, obstacleKind: "open_question", action: "reopen", reason: "follow-up" },
        expected: { type: "project.obstacle.transition", obstacleKind: "open_question",
          action: "reopen", reason: "follow-up" } },
      { intent: { kind: "transfer.propose", intentId: "propose-transfer",
        transferProposalId: "transfer-1", subjectKind: "next_action", subjectId: "action-1",
        expectedRevision: 2, toOwner: { kind: "human", actorId: "human-3" }, reason: "handoff" },
        expected: { type: "project.transfer.propose", transferProposalId: "transfer-1",
          subjectKind: "next_action", subjectId: "action-1",
          toOwner: { kind: "human", actorId: "human-3" }, reason: "handoff" } },
      { intent: { kind: "transfer.propose", intentId: "propose-agent-transfer",
        transferProposalId: "transfer-agent", subjectKind: "blocker", subjectId: "blocker-1",
        expectedRevision: 2, toOwner: { kind: "agent", actorId: "agent-2" }, reason: "specialist" },
        expected: { type: "project.transfer.propose", transferProposalId: "transfer-agent",
          subjectKind: "blocker", toOwner: { kind: "agent", actorId: "agent-2" }, reason: "specialist" } },
      { intent: { kind: "transfer.resolve", intentId: "accept-transfer",
        transferProposalId: "transfer-1", subjectKind: "next_action", subjectId: "action-1",
        expectedRevision: 1, resolution: "accepted", reason: null }, expected: {
        type: "project.transfer.resolve", transferProposalId: "transfer-1",
        resolution: "accepted", reason: null } },
    ];
    for (const { intent, expected } of cases) {
      const calls: ProjectLoopWireRequest[] = [];
      const wire = createTransport(async (frame) => {
        calls.push(frame);
        return { type: "project.mutation.ack", requestId: frame.requestId, roomId: frame.roomId,
          projectId: frame.projectId, acceptedRevision: 8, eventIds: ["event-8"], replayed: false };
      });
      const cache = createCacheHarness([projectSnapshot(), projectSnapshot({ watermark: 8 })]);
      const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
        authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
        restoreAuthorityCache: async () => false,
        createRequestIdentity: () => ({ requestId: `request-${intent.intentId}`,
          idempotencyKey: `idem-${intent.intentId}` }) });
      await runtime.getSurface({ roomId: "room-1" });
      await runtime.submit({ roomId: "room-1", intent });
      expect(calls).toEqual([expect.objectContaining(expected)]);
      runtime.close();
    }
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

  it.each([
    [400, "invalid_request"], [404, "project_fact_not_found"], [410, "room_archived"],
  ] as const)("preserves a %s Project authority failure without fabricating offline state", async (status, code) => {
    const wire = createTransport(async () => {
      throw Object.assign(new Error(code), { projectError: {
        type: "error", status, code, message: code, requestId: "request-1",
      } });
    });
    const cache = createCacheHarness([projectSnapshot()]);
    const runtime = createDesktopProjectLoopRuntime({ session, transport: wire.transport,
      authorityCache: cache.cache, repairRoom: (roomId) => cache.repairRoom(roomId),
      restoreAuthorityCache: async () => false,
      createRequestIdentity: () => ({ requestId: "request-1", idempotencyKey: "idem-1" }) });
    await runtime.getSurface({ roomId: "room-1" });
    await expect(runtime.submit({ roomId: "room-1", intent: { kind: "request.transition",
      intentId: "cancel-request", factId: "request-1", expectedRevision: 3,
      action: "cancel", reason: "No longer needed" } })).resolves.toMatchObject({
        status: "ready", connection: { status: "online" },
        operation: { status: "failed", error: { status, code } },
      });
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
