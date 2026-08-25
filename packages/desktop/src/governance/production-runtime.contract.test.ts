import type {
  ManagedRoom,
  RoomGovernanceView,
  RoomRepairRecord,
} from "@native-im/core";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountGovernanceSurface } from "../renderer/app.js";
import type { DesktopRoomEvent } from "../sync/client-sync-replica.js";
import type { GovernanceBridge, GovernanceRemoteState } from "./contracts.js";
import { authoritySnapshotChecksum } from "./authority-cache.js";
import { createDesktopGovernanceRuntime } from "./production-runtime.js";
import {
  parseGovernanceServerFrame,
  validateGovernanceWebSocketEndpoint,
  type GovernanceWebSocketLike,
} from "./websocket-authority.js";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  document.body.replaceChildren();
  await Promise.all(servers.splice(0).map(async (server) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

const joinedAt = "2026-08-19T00:00:00.000Z";
const members: ManagedRoom["members"] = [
  { kind: "human", actorId: "owner-1", role: "owner", joinedAt },
  { kind: "human", actorId: "member-1", role: "member", joinedAt },
];

function governance(lifecycle: "active" | "archived", revision: number): RoomGovernanceView {
  return {
    roomId: "room-1", projectId: "room-1", lifecycle, governanceRevision: revision,
    ownerActorId: "owner-1", archiveGeneration: lifecycle === "active" && revision === 7 ? 0 : 1,
    ...(lifecycle === "archived" ? { archivedAt: "2026-08-19T08:00:00.000Z" } : {}),
  };
}

function room(status: "active" | "archived"): ManagedRoom {
  return { id: "room-1", name: "Alpha", status, createdAt: joinedAt, members };
}

function event(
  eventId: string,
  streamSeq: number,
  type: "room.archived" | "room.reopened" | "room.governance.changed",
  lifecycle: "active" | "archived",
  revision: number,
): DesktopRoomEvent {
  const base = {
    eventId, streamKind: "room" as const, streamId: "room-1", streamSeq,
    roomId: "room-1", actorId: "owner-1", occurredAt: "2026-08-19T08:00:00.000Z",
  };
  return type === "room.governance.changed"
    ? { ...base, type, payload: { governance: governance(lifecycle, revision) } }
    : type === "room.reopened"
      ? { ...base, type, payload: {
          governance: governance(lifecycle, revision), archiveGeneration: 1, resumedTimerCount: 0,
        } }
      : { ...base, type, payload: {
          governance: governance(lifecycle, revision), archiveGeneration: 1, frozenTimerCount: 0,
        } };
}

async function loopbackAuthority(): Promise<{
  readonly endpoint: string;
  readonly received: readonly Record<string, unknown>[];
  disconnect(): void;
  removeRoomAccess(): void;
  revokeSession(): void;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string") throw new TypeError("Expected TCP loopback server");
  const received: Record<string, unknown>[] = [];
  let currentGovernance = governance("active", 7);
  let currentRoom = room("active");
  let watermark = 9;
  const history: DesktopRoomEvent[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (bytes, binary) => {
      if (binary) return socket.close(1002, "text only");
      const frame = JSON.parse(bytes.toString()) as Record<string, unknown>;
      received.push(frame);
      const requestId = frame.requestId as string;
      const send = (value: unknown): void => socket.send(JSON.stringify(value));
      switch (frame.type) {
        case "auth.resume":
          if (frame.accessToken !== "main-only-token") return socket.close(1008, "invalid token");
          send({ type: "auth.authenticated", requestId, accountId: "account-1", actorId: "owner-1", sessionId: "session-1" });
          return;
        case "room.repair.begin": {
          const records: readonly RoomRepairRecord[] = [
            { kind: "room", value: {
              id: currentRoom.id, name: currentRoom.name, status: currentRoom.status,
              createdAt: currentRoom.createdAt,
            } },
            { kind: "governance", value: currentGovernance },
            ...members.map((value) => ({ kind: "membership" as const, value })),
          ];
          send({
            type: "room.repair.page", requestId, snapshotId: `snapshot-${watermark}`, roomId: "room-1",
            page: 0, records, watermark, snapshotChecksum: authoritySnapshotChecksum("room", records),
            hasMore: false, mode: "materialized", expiresAt: "2026-08-19T08:05:00.000Z",
          });
          return;
        }
        case "room.sync": {
          const cursor = frame.cursor as { afterSeq?: number } | undefined;
          const afterSeq = cursor?.afterSeq ?? 0;
          const events = history.filter((item) => item.streamSeq > afterSeq);
          send({
            type: "room.sync.result", requestId, mode: "delta", events,
            nextCursor: { version: 1, roomId: "room-1", afterSeq: watermark },
            watermark, hasMore: false,
          });
          return;
        }
        case "room.subscribe.v2":
          send({
            type: "room.sync.result", requestId, mode: "delta", events: [],
            nextCursor: frame.cursor, watermark, hasMore: false,
          });
          send({ type: "room.subscribed.v2", requestId, roomId: "room-1", cursor: frame.cursor, watermark });
          return;
        case "room.departure.conflicts":
          send({ type: "room.departure.conflicts.result", requestId, conflicts: {
            roomId: "room-1", targetActorId: frame.targetActorId,
            governanceRevision: frame.expectedGovernanceRevision, conflicts: [],
          } });
          return;
        case "room.archive": {
          currentGovernance = governance("archived", 8);
          currentRoom = room("archived");
          const events = [
            event("room-stream-archive", 10, "room.archived", "archived", 8),
            event("room-stream-governance-archive", 11, "room.governance.changed", "archived", 8),
          ];
          history.push(...events); watermark = 11;
          send({ type: "room.governance.ack", requestId, operation: "room.archive", replayed: false,
            governance: currentGovernance, eventIds: events.map((item) => item.eventId) });
          setTimeout(() => { for (const item of events) send({ type: "room.event", event: item }); }, 150);
          return;
        }
        case "room.reopen": {
          currentGovernance = governance("active", 9);
          currentRoom = room("active");
          const events = [
            event("room-stream-reopen", 12, "room.reopened", "active", 9),
            event("room-stream-governance-reopen", 13, "room.governance.changed", "active", 9),
          ];
          history.push(...events); watermark = 13;
          send({ type: "room.governance.ack", requestId, operation: "room.reopen", replayed: false,
            governance: currentGovernance, eventIds: events.map((item) => item.eventId) });
          setTimeout(() => { for (const item of events) send({ type: "room.event", event: item }); }, 150);
          return;
        }
        default:
          socket.close(1002, "unexpected request");
      }
    });
  });
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    received,
    disconnect() { for (const client of server.clients) client.terminate(); },
    removeRoomAccess() {
      for (const client of server.clients) client.send(JSON.stringify({
        eventId: "identity-room-removed", streamKind: "identity", streamId: "owner-1",
        streamSeq: 3, actorId: "owner-1", occurredAt: "2026-08-19T08:10:00.000Z",
        type: "identity.room-access.changed", payload: { roomId: "room-1", change: "removed" },
      }));
    },
    revokeSession() {
      for (const client of server.clients) client.send(JSON.stringify({
        type: "auth.session-revoked", eventId: "session-revoked-1",
      }));
    },
  };
}

describe("production Desktop Governance loopback wire contract fixture", () => {
  it("rejects non-loopback/credential endpoints and exact-parser extensions", () => {
    expect(() => validateGovernanceWebSocketEndpoint("wss://authority.example.test"))
      .toThrow("endpoint is not allowed");
    expect(() => validateGovernanceWebSocketEndpoint("ws://user:secret@127.0.0.1:8787"))
      .toThrow("endpoint is not allowed");
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "auth.authenticated", requestId: "r", accountId: "a", actorId: "owner-1",
      sessionId: "session-1", accessToken: "must-not-return",
    }))).toBeUndefined();
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "room.governance.ack", requestId: "r", operation: "room.archive",
      governance: governance("archived", 8), eventIds: [], replayed: false, result: "already_archived",
    }))).toBeUndefined();
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "room.governance.ack", requestId: "r", operation: "room.archive",
      governance: governance("archived", 8), eventIds: ["room-stream-1"], replayed: true,
    }))).toMatchObject({ type: "room.governance.ack", result: "accepted", replayed: true });
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "room.departure.conflicts", requestId: "r", conflicts: {
        roomId: "room-1", targetActorId: "member-1", governanceRevision: 7, conflicts: [],
      },
    }))).toBeUndefined();
    expect(parseGovernanceServerFrame(JSON.stringify({
      eventId: "identity-room-removed", streamKind: "identity", streamId: "owner-1",
      streamSeq: 3, actorId: "owner-1", occurredAt: "2026-08-19T08:10:00.000Z",
      type: "identity.room-access.changed", payload: { roomId: "room-1", change: "removed" },
    }))).toMatchObject({
      type: "identity.room-access.changed", actorId: "owner-1", roomId: "room-1", change: "removed",
    });
    expect(parseGovernanceServerFrame(JSON.stringify({
      eventId: "identity-room-removed", streamKind: "identity", streamId: "owner-1",
      streamSeq: 3, actorId: "owner-1", occurredAt: "2026-08-19T08:10:00.000Z",
      type: "identity.room-access.changed",
      payload: { roomId: "room-1", change: "removed", accessToken: "injected" },
    }))).toBeUndefined();
  });

  it("drives archive and reopen renderer success only after matching ACK and real Room stream events", async () => {
    const authority = await loopbackAuthority();
    let request = 0;
    const runtime = createDesktopGovernanceRuntime({
      endpoint: authority.endpoint,
      session: () => ({ actorId: "owner-1", sessionId: "session-1", accessToken: "main-only-token",
        expiresAt: "2026-08-19T12:00:00.000Z" }),
      webSocketFactory: (endpoint) => new WebSocket(endpoint) as unknown as GovernanceWebSocketLike,
      createRequestIdentity: () => ({ requestId: `governance-${++request}`, idempotencyKey: `key-${request}` }),
      timeoutMs: 2_000,
    });
    const observed: GovernanceRemoteState[] = [];
    runtime.controller.subscribe(({ state }) => observed.push(state));
    const bridge: GovernanceBridge = {
      getSurface: (query) => runtime.controller.getSurface(query),
      getDepartureConflicts: (query) => runtime.controller.getDepartureConflicts(query),
      submit: async (mutation) => runtime.controller.submit(mutation),
      onStateChanged: (listener) => runtime.controller.subscribe(listener),
    };
    const root = document.createElement("main");
    document.body.append(root);
    const dispose = mountGovernanceSurface(root, bridge, {
      roomId: "room-1", reducedMotion: true, onNavigateConflictResolution: vi.fn(),
    });

    await vi.waitFor(() => expect(root.querySelector("[data-archive-room]")).not.toBeNull());
    await expect(runtime.controller.getDepartureConflicts({
      roomId: "room-1", targetActorId: "member-1", expectedGovernanceRevision: 7,
    })).resolves.toEqual({
      roomId: "room-1", targetActorId: "member-1", governanceRevision: 7, conflicts: [],
    });
    root.querySelector<HTMLButtonElement>("[data-archive-room]")!.click();
    root.querySelector<HTMLButtonElement>("[data-action='confirm-archive']")!.click();
    await vi.waitFor(() => expect(observed.some((state) => state.status === "ready" &&
      state.operation.status === "acknowledged" && state.projection.lifecycle === "active")).toBe(true));
    expect(root.querySelector("[data-archived-banner]")).toBeNull();
    await vi.waitFor(() => expect(root.querySelector("[data-archived-banner]")).not.toBeNull());
    expect(root.querySelector("[data-governance-success]")?.textContent).toContain("归档成功");

    root.querySelector<HTMLButtonElement>("[data-action='reopen-room']")!.click();
    await vi.waitFor(() => expect(observed.some((state) => state.status === "ready" &&
      state.operation.status === "acknowledged" && state.projection.lifecycle === "archived")).toBe(true));
    await vi.waitFor(() => expect(root.querySelector("[data-archived-banner]")).toBeNull());
    expect(root.querySelector("[data-governance-success]")?.textContent).toContain("重开成功");

    const mutationFrames = authority.received.filter((frame) =>
      frame.type === "room.archive" || frame.type === "room.reopen");
    expect(mutationFrames.map((frame) => frame.type)).toEqual(["room.archive", "room.reopen"]);
    expect(authority.received.every((frame) => !("actorId" in frame) && !("token" in frame))).toBe(true);
    expect(authority.received.find((frame) => frame.type === "auth.resume")).toMatchObject({
      accessToken: "main-only-token",
    });
    dispose(); runtime.close();
  });

  it("locks writes but retains the verified offline cache, reconnects on repair, and purges on revoke", async () => {
    const authority = await loopbackAuthority();
    let request = 0;
    const runtime = createDesktopGovernanceRuntime({
      endpoint: authority.endpoint,
      session: () => ({ actorId: "owner-1", sessionId: "session-1", accessToken: "main-only-token",
        expiresAt: "2026-08-19T12:00:00.000Z" }),
      webSocketFactory: (endpoint) => new WebSocket(endpoint) as unknown as GovernanceWebSocketLike,
      createRequestIdentity: () => ({ requestId: `offline-${++request}`, idempotencyKey: `key-${request}` }),
      timeoutMs: 2_000,
    });
    await expect(runtime.controller.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", connection: { status: "online" },
    });
    authority.disconnect();
    await vi.waitFor(() => expect(runtime.controller.current("room-1")).toMatchObject({
      status: "locked", connection: { status: "offline" },
    }));
    expect(runtime.cache.governanceProjection("room-1")).toMatchObject({
      roomId: "room-1", governanceRevision: 7,
    });
    const countBeforeSubmit = authority.received.length;
    expect(() => runtime.controller.submit({
      roomId: "room-1", intent: { command: "room.archive", expectedGovernanceRevision: 7 },
    })).toThrow("not available for mutation");
    expect(authority.received).toHaveLength(countBeforeSubmit);

    await expect(runtime.controller.getSurface({ roomId: "room-1" })).resolves.toMatchObject({
      status: "ready", connection: { status: "online" },
    });
    authority.removeRoomAccess();
    await vi.waitFor(() => expect(runtime.controller.current("room-1")).toMatchObject({
      status: "locked", connection: { status: "revoked", scope: "room", purgeCompleted: true },
    }));
    expect(runtime.cache.governanceProjection("room-1")).toBeUndefined();
    expect(runtime.controller.current("room-1")).toEqual({
      status: "locked", roomId: "room-1",
      connection: { status: "revoked", scope: "room", purgeCompleted: true },
    });
    runtime.close();
  });

  it("publishes terminal purge completion only after durable deletion and preserves cache on ordinary close", async () => {
    const authority = await loopbackAuthority();
    let releaseClear: (() => void) | undefined;
    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve; });
    const clear = vi.fn(async () => clearGate);
    const persistence = { async load() { return undefined; }, async save() {}, clear };
    let request = 0;
    const runtime = createDesktopGovernanceRuntime({
      endpoint: authority.endpoint,
      session: () => ({ actorId: "owner-1", sessionId: "session-1", accessToken: "main-only-token",
        expiresAt: "2026-08-19T12:00:00.000Z" }),
      webSocketFactory: (endpoint) => new WebSocket(endpoint) as unknown as GovernanceWebSocketLike,
      createRequestIdentity: () => ({ requestId: `purge-${++request}`, idempotencyKey: `key-${request}` }),
      cachePersistence: persistence,
      timeoutMs: 2_000,
    });
    await runtime.controller.getSurface({ roomId: "room-1" });
    authority.revokeSession();
    await vi.waitFor(() => expect(runtime.controller.current("room-1")).toMatchObject({
      status: "locked", connection: { status: "revoked", scope: "session", purgeCompleted: false },
    }));
    expect(clear).toHaveBeenCalledOnce();
    releaseClear?.();
    await vi.waitFor(() => expect(runtime.controller.current("room-1")).toMatchObject({
      status: "locked", connection: { status: "revoked", scope: "session", purgeCompleted: true },
    }));
    runtime.close();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("keeps the durable authority cache across an ordinary runtime close", async () => {
    const authority = await loopbackAuthority();
    const clear = vi.fn(async () => {});
    let request = 0;
    const runtime = createDesktopGovernanceRuntime({
      endpoint: authority.endpoint,
      session: () => ({ actorId: "owner-1", sessionId: "session-1", accessToken: "main-only-token",
        expiresAt: "2026-08-19T12:00:00.000Z" }),
      webSocketFactory: (endpoint) => new WebSocket(endpoint) as unknown as GovernanceWebSocketLike,
      createRequestIdentity: () => ({ requestId: `close-${++request}`, idempotencyKey: `key-${request}` }),
      cachePersistence: { async load() { return undefined; }, async save() {}, clear },
      timeoutMs: 2_000,
    });
    await runtime.controller.getSurface({ roomId: "room-1" });
    runtime.close();
    expect(clear).not.toHaveBeenCalled();
  });
});
