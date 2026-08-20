import { describe, expect, it } from "vitest";
import type {
  PersistedRoomEvent,
  RoomMemoryRequest,
  RoomMemorySuccessFrame,
} from "@native-im/core";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import type {
  MessageAuthorityWireTransport,
} from "../message-authority/websocket-authority.js";
import { createDesktopMemoryAuthorityRuntime } from "./production-runtime.js";

const session: IdentityAuthoritySession = Object.freeze({
  accountId: "account-1",
  actorId: "human-1",
  sessionId: "session-1",
  accessToken: "token-1",
});

function statusFrame(request: RoomMemoryRequest): RoomMemorySuccessFrame {
  return Object.freeze({
    type: "room.memory.status.v1",
    requestId: request.requestId,
    roomId: request.roomId,
    status: {
      roomId: request.roomId,
      health: {
        state: "healthy",
        reason: "none",
        memoryWatermark: 1,
        corpusHead: 1,
        lag: 0,
        lastAttemptAt: "2026-08-20T00:00:00.000Z",
        retryable: false,
        recoveryRequired: false,
      },
      recoveryGeneration: 0,
      updatedAt: "2026-08-20T00:00:00.000Z",
    },
  });
}

describe("Desktop Memory Authority production runtime", () => {
  it("binds context and requests to the authenticated Room and purges on revocation", async () => {
    let roomObserver: Parameters<MessageAuthorityWireTransport["subscribeRoom"]>[2] | undefined;
    let accessListener: Parameters<MessageAuthorityWireTransport["onRoomAccessChanged"]>[0] | undefined;
    const transport = {
      historyV2: async (command: { requestId: string; roomId: string }) => ({
        type: "room.history.v2" as const,
        requestId: command.requestId,
        roomId: command.roomId,
        messages: [],
        hasMore: false,
        lifecycle: "active" as const,
        actors: [{ actorId: "human-1", kind: "human" as const, displayName: "Human", secondaryLabel: "Owner" }],
      }),
      memoryRequest: async (request: RoomMemoryRequest) => statusFrame(request),
      subscribeRoom: async (_roomId: string, cursor: { version: 1; roomId: string; afterSeq: number }, observer: Parameters<MessageAuthorityWireTransport["subscribeRoom"]>[2]) => {
        roomObserver = observer;
        return { cursor, close() {} };
      },
      onRoomAccessChanged(listener: typeof accessListener) {
        accessListener = listener;
        return () => undefined;
      },
      onTerminalRevoked() { return () => undefined; },
      onConnectionFailure() { return () => undefined; },
      resetSession() {},
      close() {},
    } as unknown as MessageAuthorityWireTransport;
    const runtime = createDesktopMemoryAuthorityRuntime({
      endpoint: "ws://127.0.0.1:8787",
      session: () => session,
      webSocketFactory: () => { throw new Error("test transport must be used"); },
      testOnlyTransport: transport,
    });
    const inputs: unknown[] = [];
    const stop = runtime.subscribe((input) => inputs.push(input));

    const context = await runtime.context({ roomId: "room-1" });
    expect(context).toMatchObject({ roomId: "room-1", accessEpoch: 1, lifecycle: "active",
      viewer: { actorId: "human-1", currentHuman: true } });
    expect(roomObserver).toBeDefined();
    const request: RoomMemoryRequest = {
      type: "room.memory.status.query.v1",
      requestId: "request-1",
      roomId: "room-1",
    };
    await expect(runtime.request({ accessEpoch: 1, frame: request })).resolves.toMatchObject({
      accessEpoch: 1,
      frame: { type: "room.memory.status.v1", requestId: "request-1", roomId: "room-1" },
    });

    accessListener?.("room-1", "removed");
    expect(inputs.at(-1)).toEqual({ type: "room.memory.revoked", roomId: "room-1",
      accessEpoch: 2, scope: "room", purgeCompleted: true });
    await expect(runtime.request({ accessEpoch: 1, frame: request })).rejects.toThrow();
    stop();
    runtime.close();
  });

  it("turns stable memory events into a bounded repair refresh", async () => {
    let observer: Parameters<MessageAuthorityWireTransport["subscribeRoom"]>[2] | undefined;
    const transport = {
      historyV2: async (command: { requestId: string; roomId: string }) => ({
        type: "room.history.v2" as const, requestId: command.requestId, roomId: command.roomId,
        messages: [], hasMore: false, lifecycle: "active" as const,
        actors: [{ actorId: "human-1", kind: "human" as const, displayName: "Human", secondaryLabel: "Owner" }],
      }),
      memoryRequest: async (request: RoomMemoryRequest): Promise<RoomMemorySuccessFrame> => {
        if (request.type === "room.memory.query.v1") return {
          type: "room.memory.page.v1", requestId: request.requestId, roomId: request.roomId,
          items: [], nextCursor: null, status: statusFrame(request).type === "room.memory.status.v1"
            ? statusFrame(request).status : (() => { throw new Error(); })(),
        };
        return statusFrame(request);
      },
      subscribeRoom: async (_roomId: string, cursor: { version: 1; roomId: string; afterSeq: number }, next: Parameters<MessageAuthorityWireTransport["subscribeRoom"]>[2]) => {
        observer = next;
        return { cursor, close() {} };
      },
      onRoomAccessChanged() { return () => undefined; },
      onTerminalRevoked() { return () => undefined; },
      onConnectionFailure() { return () => undefined; },
      resetSession() {},
      close() {},
    } as unknown as MessageAuthorityWireTransport;
    const runtime = createDesktopMemoryAuthorityRuntime({
      endpoint: "ws://127.0.0.1:8787", session: () => session,
      webSocketFactory: () => { throw new Error("test transport must be used"); },
      testOnlyTransport: transport,
    });
    const inputs: unknown[] = [];
    runtime.subscribe((input) => inputs.push(input));
    await runtime.context({ roomId: "room-1" });
    const event = {
      eventId: "memory-event-1", streamKind: "room", streamId: "room-1", roomId: "room-1", streamSeq: 1,
      actorId: "human-1", occurredAt: "2026-08-20T00:00:00.000Z",
      type: "room.memory.health.changed", payload: statusFrame({
        type: "room.memory.status.query.v1", requestId: "status", roomId: "room-1",
      }).type === "room.memory.status.v1" ? statusFrame({
        type: "room.memory.status.query.v1", requestId: "status", roomId: "room-1",
      }).status : undefined,
    } as PersistedRoomEvent;
    await observer!.events([event], { version: 1, roomId: "room-1", afterSeq: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inputs.some((input) => (input as { type?: string }).type ===
      "room.memory.repair.completed")).toBe(true);
    runtime.close();
  });
});
