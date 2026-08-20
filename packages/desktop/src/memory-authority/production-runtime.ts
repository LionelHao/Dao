import {
  isRoomMemoryError,
  isRoomMemoryEvent,
  isRoomMemoryRequest,
  type RoomMemoryProjection,
  type RoomMemoryRepairRecord,
  type RoomMemoryRequest,
} from "@native-im/core";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  MessageAuthorityTransportError,
  createMessageAuthorityWebSocketTransport,
  type MessageAuthorityWebSocketLike,
  type MessageAuthorityWireTransport,
} from "../message-authority/websocket-authority.js";
import type { RoomSubscription } from "../sync/client-sync-replica.js";
import type {
  MemoryAuthorityClientApplication,
  MemoryAuthorityEpochRequest,
} from "../renderer/memory-authority/client.js";
import type {
  MemoryAuthorityContext,
  MemoryAuthorityContextQuery,
} from "./contracts.js";

const PAGE_LIMIT = 50;
const MAX_PAGES = 100;

type Listener = (input: MemoryAuthorityClientApplication) => void;
type RoomState = {
  readonly roomId: string;
  accessEpoch: number;
  lifecycle: "active" | "archived";
  subscription: RoomSubscription | undefined;
  initializing: Promise<void> | undefined;
  refresh: Promise<void> | undefined;
  repairGeneration: number;
  revoked: boolean;
  viewer: MemoryAuthorityContext["viewer"] | undefined;
};

export interface DesktopMemoryAuthorityRuntime {
  context(query: MemoryAuthorityContextQuery): Promise<MemoryAuthorityContext>;
  request(input: MemoryAuthorityEpochRequest): Promise<unknown>;
  subscribe(listener: Listener): () => void;
  invalidateAuthorizedState(): void;
  close(): void;
}

function dependencyFailure(): Error {
  return new MessageAuthorityTransportError("connection_unavailable");
}

export function createDesktopMemoryAuthorityRuntime(options: {
  readonly endpoint: string;
  readonly session: () => IdentityAuthoritySession | undefined;
  readonly webSocketFactory: (endpoint: string) => MessageAuthorityWebSocketLike;
  readonly timeoutMs?: number;
  readonly maxPendingRequests?: number;
  readonly maxBufferedEvents?: number;
  readonly testOnlyTransport?: MessageAuthorityWireTransport;
}): DesktopMemoryAuthorityRuntime {
  const transport = options.testOnlyTransport ?? createMessageAuthorityWebSocketTransport({
    endpoint: options.endpoint,
    session: options.session,
    webSocketFactory: options.webSocketFactory,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxPendingRequests === undefined ? {} : {
      maxPendingRequests: options.maxPendingRequests,
    }),
    ...(options.maxBufferedEvents === undefined ? {} : {
      maxBufferedEvents: options.maxBufferedEvents,
    }),
  });
  const rooms = new Map<string, RoomState>();
  const listeners = new Set<Listener>();
  let closed = false;
  let sequence = 0;

  const publish = (input: MemoryAuthorityClientApplication): void => {
    if (closed) return;
    for (const listener of [...listeners]) {
      try { listener(structuredClone(input)); } catch { /* renderer observer is isolated */ }
    }
  };

  const room = (roomId: string): RoomState => {
    const existing = rooms.get(roomId);
    if (existing !== undefined) return existing;
    const created: RoomState = {
      roomId,
      accessEpoch: 1,
      lifecycle: "active",
      subscription: undefined,
      initializing: undefined,
      refresh: undefined,
      repairGeneration: 0,
      revoked: false,
      viewer: undefined,
    };
    rooms.set(roomId, created);
    return created;
  };

  const refresh = async (state: RoomState): Promise<void> => {
    if (closed || state.revoked) return;
    if (state.refresh !== undefined) return state.refresh;
    const accessEpoch = state.accessEpoch;
    const generation = ++state.repairGeneration;
    const run = (async () => {
      const projections: RoomMemoryProjection[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let status: Extract<RoomMemoryRepairRecord["value"], { recordType: "status" }>["status"] |
        undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const request: RoomMemoryRequest = cursor === null
          ? { type: "room.memory.query.v1", requestId: `memory-refresh-${++sequence}`,
            roomId: state.roomId, limit: PAGE_LIMIT }
          : { type: "room.memory.query.v1", requestId: `memory-refresh-${++sequence}`,
            roomId: state.roomId, cursor, limit: PAGE_LIMIT };
        const response = await transport.memoryRequest(request);
        if (isRoomMemoryError(response) || response.type !== "room.memory.page.v1" ||
            response.roomId !== state.roomId) throw dependencyFailure();
        if (status !== undefined && JSON.stringify(status) !== JSON.stringify(response.status)) {
          throw dependencyFailure();
        }
        status = response.status;
        for (const projection of response.items) {
          const key = `${projection.projectionKind}\u0000${projection.memoryRecordId}`;
          if (seen.has(key)) throw dependencyFailure();
          seen.add(key);
          projections.push(structuredClone(projection));
        }
        cursor = response.nextCursor;
        if (cursor === null) break;
        if (page === MAX_PAGES - 1) throw dependencyFailure();
      }
      if (status === undefined || state.accessEpoch !== accessEpoch || state.revoked) return;
      const records: RoomMemoryRepairRecord[] = [
        { kind: "memory", roomId: state.roomId, value: { recordType: "status", status } },
        ...projections.map((projection): RoomMemoryRepairRecord => ({
          kind: "memory",
          roomId: state.roomId,
          value: { recordType: "projection", projection },
        })),
      ];
      publish({ type: "room.memory.repair.completed", roomId: state.roomId, accessEpoch,
        generation, records });
    })().catch(() => {
      if (!closed && !state.revoked && state.accessEpoch === accessEpoch) {
        publish({ type: "room.memory.repair.failed", roomId: state.roomId, accessEpoch,
          generation, errorCode: "memory_refresh_failed" });
      }
    }).finally(() => {
      if (state.refresh === run) state.refresh = undefined;
    });
    state.refresh = run;
    return run;
  };

  const ensureSubscription = async (state: RoomState): Promise<void> => {
    if (state.subscription !== undefined || state.revoked) return;
    if (state.initializing !== undefined) return state.initializing;
    const observer = {
      async events(events: readonly import("@native-im/core").PersistedRoomEvent[]) {
        if (events.some(isRoomMemoryEvent)) await refresh(state);
      },
      async retry() {
        await refresh(state);
      },
    };
    const initialize = transport.subscribeRoom(
      state.roomId,
      { version: 1, roomId: state.roomId, afterSeq: 0 },
      observer,
    ).catch(async (error: unknown) => {
      if (!(error instanceof MessageAuthorityTransportError) ||
          error.code !== "repair_required" || error.repair === undefined) throw error;
      publish({ type: "room.memory.connection", roomId: state.roomId,
        accessEpoch: state.accessEpoch, connection: { status: "repairing" } });
      const subscription = await transport.subscribeRoom(
        state.roomId,
        { version: 1, roomId: state.roomId, afterSeq: error.repair.watermark },
        observer,
      );
      await refresh(state);
      return subscription;
    }).then((subscription) => {
      if (state.revoked || closed) subscription.close();
      else state.subscription = subscription;
    }).finally(() => {
      state.initializing = undefined;
    });
    state.initializing = initialize;
    return initialize;
  };

  const revoke = (state: RoomState): void => {
    if (state.revoked) return;
    state.subscription?.close();
    state.subscription = undefined;
    state.revoked = true;
    state.accessEpoch += 1;
    publish({ type: "room.memory.revoked", roomId: state.roomId,
      accessEpoch: state.accessEpoch, scope: "room", purgeCompleted: true });
  };

  const stopAccess = transport.onRoomAccessChanged((roomId, change) => {
    const state = rooms.get(roomId);
    if (state === undefined) return;
    if (change === "removed") {
      revoke(state);
      return;
    }
    if (change === "archived") {
      state.lifecycle = "archived";
      if (state.viewer !== undefined) publish({ type: "room.memory.context", roomId,
        accessEpoch: state.accessEpoch, lifecycle: state.lifecycle, viewer: state.viewer });
    }
    if (change === "joined" || change === "updated") {
      state.revoked = false;
      void refresh(state);
    }
  });
  const stopTerminal = transport.onTerminalRevoked(() => {
    for (const state of rooms.values()) revoke(state);
  });
  const stopFailure = transport.onConnectionFailure(() => {
    for (const state of rooms.values()) {
      if (!state.revoked) publish({ type: "room.memory.connection", roomId: state.roomId,
        accessEpoch: state.accessEpoch, connection: { status: "offline" } });
    }
  });

  const runtime: DesktopMemoryAuthorityRuntime = {
    async context(query) {
      if (closed) throw dependencyFailure();
      const currentSession = options.session();
      if (currentSession === undefined) throw dependencyFailure();
      let state = room(query.roomId);
      if (state.revoked) {
        state = {
          roomId: query.roomId,
          accessEpoch: state.accessEpoch + 1,
          lifecycle: "active",
          subscription: undefined,
          initializing: undefined,
          refresh: undefined,
          repairGeneration: state.repairGeneration,
          revoked: false,
          viewer: undefined,
        };
        rooms.set(query.roomId, state);
      }
      await ensureSubscription(state);
      const history = await transport.historyV2({
        type: "room.history.v2",
        requestId: `memory-context-${++sequence}`,
        roomId: query.roomId,
        limit: 1,
      });
      state.lifecycle = history.lifecycle;
      state.viewer = Object.freeze({
        actorId: currentSession.actorId,
        currentHuman: history.actors.some((actor) =>
          actor.actorId === currentSession.actorId && actor.kind === "human"),
      });
      return Object.freeze({
        roomId: query.roomId,
        accessEpoch: state.accessEpoch,
        lifecycle: state.lifecycle,
        viewer: state.viewer,
      });
    },
    async request(input) {
      if (closed || !isRoomMemoryRequest(input.frame)) throw dependencyFailure();
      const state = room(input.frame.roomId);
      if (state.revoked || state.accessEpoch !== input.accessEpoch) throw dependencyFailure();
      await ensureSubscription(state);
      const frame = await transport.memoryRequest(structuredClone(input.frame));
      if ((!isRoomMemoryError(frame) && !isRoomMemoryRequest(input.frame)) ||
          frame.requestId !== input.frame.requestId) throw dependencyFailure();
      return Object.freeze({ accessEpoch: input.accessEpoch, frame: structuredClone(frame) });
    },
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidateAuthorizedState() {
      transport.resetSession();
      for (const state of rooms.values()) revoke(state);
    },
    close() {
      if (closed) return;
      closed = true;
      stopAccess();
      stopTerminal();
      stopFailure();
      for (const state of rooms.values()) state.subscription?.close();
      rooms.clear();
      listeners.clear();
      transport.close();
    },
  };
  return Object.freeze(runtime);
}
