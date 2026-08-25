import {
  isMessageAuthorityEvent,
  type MessageAuthorityEvent,
  type PersistedRoomEvent,
  type TimelineMessage,
} from "@native-im/core";

import type { IdentityAuthoritySession } from "../identity/controller.js";
import type { RoomSubscription } from "../sync/client-sync-replica.js";
import {
  MessageAuthorityClientFailure,
  type MessageAuthorityClientPort,
} from "./controller.js";
import type {
  MessageAuthorityPortInput,
  MessageHistoryV2Command,
} from "./contracts.js";
import type { MessageClosedError } from "../renderer/message-authority/view-model.js";
import {
  MessageAuthorityTransportError,
  createMessageAuthorityWebSocketTransport,
  type MessageHistoryV2WireResult,
  type MessageAuthorityWebSocketLike,
  type MessageAuthorityWireTransport,
} from "./websocket-authority.js";

const MAX_HISTORY_MESSAGES = 10_000;
const MAX_HISTORY_PAGES = 100;
const MAX_INITIAL_EVENTS = 4_096;

interface RoomRuntimeState {
  readonly roomId: string;
  generation: number;
  watermark: number;
  lifecycle: "active" | "archived";
  subscription: RoomSubscription | undefined;
  initialize: Promise<void> | undefined;
  initialized: boolean;
  collecting: boolean;
  desynchronized: boolean;
  repairing: boolean;
  initialEvents: PersistedRoomEvent[];
}

export interface DesktopMessageAuthorityRuntime {
  readonly client: MessageAuthorityClientPort;
  readonly transport: MessageAuthorityWireTransport;
  clearAndRestore(roomId: string): void;
  invalidateAuthorizedState(): void;
  close(): void;
}

function closedError(error: unknown): MessageClosedError {
  if (!(error instanceof MessageAuthorityTransportError)) {
    return { status: 503, code: "service_unavailable" };
  }
  if (error.closedError !== undefined) return error.closedError;
  if (error.code === "authentication_required") {
    return { status: 401, code: "unauthenticated" };
  }
  if (error.code === "session_revoked") {
    return { status: 401, code: "identity_forbidden" };
  }
  if (error.code === "access_revoked") {
    return { status: 403, code: "room_forbidden" };
  }
  return { status: 503, code: error.code === "connection_unavailable"
    ? "dependency_unavailable" : "service_unavailable" };
}

function authorityFailure(error: unknown): MessageAuthorityClientFailure {
  return new MessageAuthorityClientFailure(closedError(error));
}

function updateLifecycle(state: RoomRuntimeState, event: PersistedRoomEvent): void {
  if (event.type === "room.archived" || event.type === "room.security.reduced") {
    state.lifecycle = "archived";
  } else if (event.type === "room.reopened") {
    state.lifecycle = "active";
  }
}

function foldMessageEvent(
  timeline: readonly TimelineMessage[],
  event: MessageAuthorityEvent,
): readonly TimelineMessage[] {
  const index = timeline.findIndex(({ id }) => id === event.payload.id);
  const current = index < 0 ? undefined : timeline[index];
  if (event.type === "room.message.accepted") {
    if (current !== undefined) return timeline;
    return [...timeline, structuredClone(event.payload)];
  }
  if (event.type === "room.message.revised") {
    if (current === undefined || current.lifecycle === "recalled" ||
        current.authorKind !== "human" ||
        current.currentRevision.revision >= event.payload.currentRevision.revision) return timeline;
  } else if (current?.lifecycle === "recalled") {
    return timeline;
  }
  const next = [...timeline];
  if (index < 0) next.push(structuredClone(event.payload));
  else next[index] = structuredClone(event.payload);
  return next;
}

export function createDesktopMessageAuthorityRuntime(options: {
  readonly endpoint: string;
  readonly session: () => IdentityAuthoritySession | undefined;
  readonly webSocketFactory: (endpoint: string) => MessageAuthorityWebSocketLike;
  readonly now?: () => string;
  readonly timeoutMs?: number;
  readonly maxPendingRequests?: number;
  readonly maxBufferedEvents?: number;
}): DesktopMessageAuthorityRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const transport = createMessageAuthorityWebSocketTransport({
    endpoint: options.endpoint,
    session: options.session,
    webSocketFactory: options.webSocketFactory,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxPendingRequests === undefined
      ? {}
      : { maxPendingRequests: options.maxPendingRequests }),
    ...(options.maxBufferedEvents === undefined
      ? {}
      : { maxBufferedEvents: options.maxBufferedEvents }),
  });
  const listeners = new Set<(input: MessageAuthorityPortInput) => void>();
  const rooms = new Map<string, RoomRuntimeState>();
  let closed = false;

  const publish = (input: MessageAuthorityPortInput): void => {
    if (closed) return;
    const safe = structuredClone(input);
    for (const listener of [...listeners]) {
      try { listener(structuredClone(safe)); } catch { /* renderer observer is isolated */ }
    }
  };
  const connection = (
    roomId: string,
    value: Extract<MessageAuthorityPortInput, { type: "message.connection" }>["connection"],
  ): void => publish({ type: "message.connection", roomId, connection: value });
  const failMixedCursor = (state: RoomRuntimeState): void => {
    if (state.desynchronized) return;
    state.desynchronized = true;
    state.initialized = false;
    state.subscription?.close();
    state.subscription = undefined;
    connection(state.roomId, {
      status: "repair-failed",
      errorCode: "mixed_room_cursor_requires_repair",
    });
  };

  const observeRoomEvents = async (
    state: RoomRuntimeState,
    events: readonly PersistedRoomEvent[],
  ): Promise<void> => {
    for (const event of events) {
      updateLifecycle(state, event);
      if (!state.initialized) {
        if (state.collecting) {
          if (state.initialEvents.length >= MAX_INITIAL_EVENTS) {
            state.desynchronized = true;
            throw new MessageAuthorityTransportError("request_capacity_exceeded");
          }
          state.initialEvents.push(structuredClone(event));
        }
        state.watermark = event.streamSeq;
        continue;
      }
      if (state.desynchronized || event.streamSeq !== state.watermark + 1) {
        failMixedCursor(state);
        return;
      }
      if (isMessageAuthorityEvent(event)) {
        publish({
          type: "room.event",
          cursorBefore: state.watermark,
          generation: state.generation,
          event,
        });
      } else {
        publish({
          type: "room.cursor.advanced",
          roomId: state.roomId,
          cursorBefore: state.watermark,
          generation: state.generation,
          eventId: event.eventId,
          streamSeq: event.streamSeq,
        });
      }
      state.watermark = event.streamSeq;
    }
  };

  const freshRoomState = (roomId: string, prior?: RoomRuntimeState): RoomRuntimeState => ({
    roomId,
    generation: prior === undefined ? 1 : prior.generation + 1,
    watermark: 0,
    lifecycle: prior?.lifecycle ?? "active",
    initialized: false,
    collecting: false,
    desynchronized: false,
    repairing: false,
    initialEvents: [],
    subscription: undefined,
    initialize: undefined,
  });

  const ensureRoom = async (roomId: string): Promise<RoomRuntimeState> => {
    const existing = rooms.get(roomId);
    if (existing?.initialized === true && !existing.desynchronized) return existing;
    if (existing?.initialize !== undefined) {
      await existing.initialize;
      return rooms.get(roomId)!;
    }
    existing?.subscription?.close();
    const state = freshRoomState(roomId, existing);
    rooms.set(roomId, state);
    state.collecting = true;
    state.initialEvents = [];
    const observer = {
      events: async (events: readonly PersistedRoomEvent[]) => observeRoomEvents(state, events),
      async retry() {
        state.desynchronized = true;
        connection(roomId, { status: "repair-failed", errorCode: "subscription_gate_overflow" });
      },
    };
    const initialize = transport.subscribeRoom(
      roomId,
      { version: 1, roomId, afterSeq: 0 },
      observer,
    ).catch(async (error: unknown) => {
      if (!(error instanceof MessageAuthorityTransportError) ||
          error.code !== "repair_required" || error.repair === undefined) throw error;
      state.repairing = true;
      state.watermark = error.repair.watermark;
      connection(roomId, { status: "repairing", watermark: error.repair.watermark });
      return transport.subscribeRoom(
        roomId,
        { version: 1, roomId, afterSeq: error.repair.watermark },
        observer,
      );
    }).then((subscription) => {
      if (rooms.get(roomId) !== state) {
        subscription.close();
        return;
      }
      state.subscription = subscription;
      state.watermark = subscription.cursor.afterSeq;
    }).catch((error: unknown) => {
      if (rooms.get(roomId) === state) {
        if (state.repairing) {
          state.desynchronized = true;
          connection(roomId, {
            status: "repair-failed",
            errorCode: "subscription_restore_failed",
          });
        } else {
          rooms.delete(roomId);
        }
      }
      throw error;
    });
    state.initialize = initialize;
    await initialize;
    state.initialize = undefined;
    return state;
  };

  const readCompleteHistory = async (
    transportPort: MessageAuthorityWireTransport,
    command: MessageHistoryV2Command,
  ): Promise<Readonly<{
    messages: readonly TimelineMessage[];
    lifecycle: "active" | "archived";
    actors: MessageHistoryV2WireResult["actors"];
  }>> => {
    const messages: TimelineMessage[] = [];
    const seen = new Set<string>();
    let afterMessageId = command.afterMessageId;
    let authority: Pick<MessageHistoryV2WireResult, "lifecycle" | "actors"> | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const response = await transportPort.historyV2({
        type: "room.history.v2",
        requestId: page === 0 ? command.requestId : `${command.requestId}:page:${page}`,
        roomId: command.roomId,
        ...(afterMessageId === undefined ? {} : { afterMessageId }),
        limit: Math.min(command.limit ?? 100, 100),
      });
      if (response.roomId !== command.roomId) {
        throw new MessageAuthorityTransportError("protocol_error");
      }
      if (authority === undefined) {
        authority = { lifecycle: response.lifecycle, actors: response.actors };
      } else if (authority.lifecycle !== response.lifecycle ||
          JSON.stringify(authority.actors) !== JSON.stringify(response.actors)) {
        throw new MessageAuthorityTransportError("protocol_error");
      }
      for (const message of response.messages) {
        if (seen.has(message.id) || messages.length >= MAX_HISTORY_MESSAGES) {
          throw new MessageAuthorityTransportError("request_capacity_exceeded");
        }
        seen.add(message.id);
        messages.push(structuredClone(message));
      }
      if (!response.hasMore) return {
        messages,
        lifecycle: authority.lifecycle,
        actors: authority.actors,
      };
      const last = response.messages.at(-1);
      if (last === undefined) throw new MessageAuthorityTransportError("protocol_error");
      afterMessageId = last.id;
    }
    throw new MessageAuthorityTransportError("request_capacity_exceeded");
  };

  const requireWritableRoom = (roomId: string): void => {
    if (options.session() === undefined) {
      throw new MessageAuthorityClientFailure({ status: 401, code: "unauthenticated" });
    }
    const state = rooms.get(roomId);
    if (state === undefined || !state.initialized || state.desynchronized) {
      throw new MessageAuthorityClientFailure({ status: 503, code: "repair_unavailable" });
    }
    if (state.lifecycle === "archived") {
      throw new MessageAuthorityClientFailure({ status: 403, code: "room_forbidden" });
    }
  };

  const clientValue: MessageAuthorityClientPort = {
    async historyV2(command) {
      if (closed) throw new MessageAuthorityClientFailure({ status: 503, code: "service_unavailable" });
      const session = options.session();
      if (session === undefined) {
        throw new MessageAuthorityClientFailure({ status: 401, code: "unauthenticated" });
      }
      try {
        const state = await ensureRoom(command.roomId);
        const history = await readCompleteHistory(transport, command);
        let messages = history.messages;
        state.lifecycle = history.lifecycle;
        for (const event of state.initialEvents) {
          updateLifecycle(state, event);
          if (isMessageAuthorityEvent(event)) messages = [...foldMessageEvent(messages, event)];
        }
        state.initialEvents = [];
        state.collecting = false;
        if (state.desynchronized) throw new MessageAuthorityTransportError("protocol_error");
        state.initialized = true;
        return {
          type: "room.history.v2",
          requestId: command.requestId,
          roomId: command.roomId,
          status: "ready",
          viewerActorId: session.actorId,
          lifecycle: state.lifecycle,
          connection: { status: "online" },
          actors: history.actors,
          messages,
          hasMore: false,
          generation: state.generation,
          watermark: state.watermark,
        };
      } catch (error: unknown) {
        const current = rooms.get(command.roomId);
        if (current !== undefined) {
          current.collecting = false;
          current.initialEvents = [];
          if (current.repairing) {
            current.desynchronized = true;
            connection(command.roomId, {
              status: "repair-failed",
              errorCode: "history_restore_failed",
            });
          }
        }
        throw authorityFailure(error);
      }
    },
    async revisionsQuery(command) {
      requireWritableRoom(command.roomId);
      try {
        return await transport.revisionsQuery({
          ...command,
          ...(command.limit === undefined ? {} : { limit: Math.min(command.limit, 100) }),
        });
      } catch (error: unknown) {
        throw authorityFailure(error);
      }
    },
    async sendV2(command) {
      requireWritableRoom(command.message.roomId);
      try {
        return await transport.sendV2(command);
      } catch (error: unknown) {
        throw authorityFailure(error);
      }
    },
    async revise(command) {
      requireWritableRoom(command.roomId);
      try {
        return await transport.revise(command);
      } catch (error: unknown) {
        throw authorityFailure(error);
      }
    },
    async recall(command) {
      requireWritableRoom(command.roomId);
      try {
        return await transport.recall(command);
      } catch (error: unknown) {
        throw authorityFailure(error);
      }
    },
    subscribe(listener) {
      if (closed) throw new TypeError("Message Authority runtime is closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const client = Object.freeze(clientValue);

  const revokeAll = (scope: "room" | "session", roomId?: string): void => {
    const targets = roomId === undefined ? [...rooms.values()]
      : [...rooms.values()].filter((state) => state.roomId === roomId);
    for (const state of targets) {
      state.subscription?.close();
      connection(state.roomId, { status: "revoked", scope, purgeCompleted: true });
      rooms.delete(state.roomId);
    }
  };
  const unsubscribeTerminal = transport.onTerminalRevoked(() => revokeAll("session"));
  const unsubscribePreview = transport.onAgentPreview((input) => {
    const state = rooms.get(input.roomId);
    if (state === undefined || state.desynchronized) return;
    publish(input);
  });
  const unsubscribeAccess = transport.onRoomAccessChanged((roomId, change) => {
    if (change === "removed" || change === "archived") {
      revokeAll("room", roomId);
      return;
    }
    const state = rooms.get(roomId);
    if (state !== undefined) failMixedCursor(state);
  });
  const unsubscribeFailure = transport.onConnectionFailure(() => {
    for (const state of rooms.values()) {
      state.desynchronized = true;
      state.initialized = false;
      state.subscription = undefined;
      connection(state.roomId, { status: "offline", asOf: now() });
    }
  });

  return Object.freeze({
    client,
    transport,
    clearAndRestore(roomId: string) {
      const state = rooms.get(roomId);
      if (state === undefined) return;
      state.subscription?.close();
      state.subscription = undefined;
      state.initialized = false;
      state.desynchronized = true;
      state.collecting = false;
      state.initialEvents = [];
    },
    invalidateAuthorizedState() {
      revokeAll("session");
      transport.resetSession();
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribeTerminal();
      unsubscribePreview();
      unsubscribeAccess();
      unsubscribeFailure();
      for (const state of rooms.values()) state.subscription?.close();
      rooms.clear();
      listeners.clear();
      transport.close();
    },
  });
}
