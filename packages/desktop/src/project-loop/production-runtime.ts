import { isProjectEvent } from "@native-im/core";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import type { MessageAuthorityWireTransport } from "../message-authority/websocket-authority.js";
import type { RoomSubscription } from "../sync/client-sync-replica.js";
import type { ProjectLoopIntent } from "../renderer/project-loop/surface.js";
import type { ProjectLoopRemoteState } from "../renderer/project-loop/view-model.js";
import {
  isProjectLoopWireResponse,
  type ProjectLoopSubmitCommand,
  type ProjectLoopSurfaceQuery,
  type ProjectLoopWireRequest,
  type ProjectLoopWireResponse,
} from "./contracts.js";
import { createProjectLoopReplica } from "./replica.js";

type Listener = (input: Readonly<{ roomId: string; state: ProjectLoopRemoteState }>) => void;
const PROJECT_LOOP_EVENT_BATCH_LIMIT = 512;
type ProjectWireTransport = Pick<MessageAuthorityWireTransport,
  "subscribeRoom" | "onTerminalRevoked" | "onRoomAccessChanged" | "onConnectionFailure" | "close"
> & Readonly<{
  projectRequest(command: ProjectLoopWireRequest): Promise<ProjectLoopWireResponse>;
}>;

export interface DesktopProjectLoopRuntime {
  getSurface(query: ProjectLoopSurfaceQuery): Promise<ProjectLoopRemoteState>;
  submit(command: ProjectLoopSubmitCommand): Promise<ProjectLoopRemoteState>;
  subscribe(listener: Listener): () => void;
  invalidateAuthorizedState(): void;
  close(): void;
}

interface RoomState {
  readonly roomId: string;
  readonly replica: ReturnType<typeof createProjectLoopReplica>;
  remote: ProjectLoopRemoteState;
  refresh: Promise<ProjectLoopRemoteState> | undefined;
  subscription: RoomSubscription | undefined;
  subscriptionStarting: Promise<void> | undefined;
}

function errorStatus(error: unknown): Readonly<{
  status: 401 | 403 | 409 | 410 | 429 | 503;
  code: string;
  retryAfterSeconds?: number;
}> {
  const closed = typeof error === "object" && error !== null && "projectError" in error &&
    (error as { projectError?: unknown }).projectError !== undefined
    ? (error as { projectError?: { status?: unknown; code?: unknown; retryAfterSeconds?: unknown } }).projectError
    : typeof error === "object" && error !== null && "closedError" in error
    ? (error as { closedError?: { status?: unknown; code?: unknown; retryAfterSeconds?: unknown } }).closedError
    : undefined;
  const status = closed?.status;
  const normalized = status === 401 || status === 403 || status === 409 || status === 410 ||
    status === 429 || status === 503 ? status : 503;
  return Object.freeze({
    status: normalized,
    code: typeof closed?.code === "string" && closed.code.length > 0
      ? closed.code : "project_dependency_unavailable",
    ...(typeof closed?.retryAfterSeconds === "number" && Number.isSafeInteger(closed.retryAfterSeconds) &&
      closed.retryAfterSeconds >= 0 ? { retryAfterSeconds: closed.retryAfterSeconds } : {}),
  });
}

export function createDesktopProjectLoopRuntime(options: Readonly<{
  session: () => IdentityAuthoritySession | undefined;
  transport: ProjectWireTransport;
  createRequestIdentity: () => Readonly<{ requestId: string; idempotencyKey: string }>;
  now?: () => string;
}>): DesktopProjectLoopRuntime {
  const rooms = new Map<string, RoomState>();
  const listeners = new Set<Listener>();
  const now = options.now ?? (() => new Date().toISOString());
  let closed = false;

  const publish = (state: RoomState): void => {
    if (closed) return;
    for (const listener of [...listeners]) {
      try { listener(structuredClone({ roomId: state.roomId, state: state.remote })); }
      catch { /* observers are isolated */ }
    }
  };
  const room = (roomId: string): RoomState => {
    const prior = rooms.get(roomId);
    if (prior !== undefined) return prior;
    const created: RoomState = {
      roomId,
      replica: createProjectLoopReplica(roomId),
      remote: { status: "loading", roomId },
      refresh: undefined,
      subscription: undefined,
      subscriptionStarting: undefined,
    };
    rooms.set(roomId, created);
    return created;
  };
  const lock = (state: RoomState, status: 401 | 410 | 503, code: string): void => {
    state.subscription?.close();
    state.subscription = undefined;
    state.replica.clear();
    state.remote = { status: "locked", roomId: state.roomId, error: { status, code } };
    publish(state);
  };

  const ensureSubscription = async (state: RoomState): Promise<void> => {
    if (closed || state.subscription !== undefined || state.subscriptionStarting !== undefined) return;
    const snapshot = state.replica.snapshot();
    if (snapshot === undefined) return;
    const started = options.transport.subscribeRoom(
      state.roomId,
      { version: 1, roomId: state.roomId, afterSeq: snapshot.watermark },
      {
        async events(events) {
          if (events.length > PROJECT_LOOP_EVENT_BATCH_LIMIT) {
            if (state.remote.status === "ready") {
              state.remote = { ...state.remote,
                connection: { status: "repair_failed", code: "project_event_buffer_exceeded" } };
              publish(state);
            }
            return;
          }
          let needsRefresh = false;
          try {
            for (const event of events) {
              if (isProjectEvent(event) && state.replica.observeStableEvent(event).needsRefresh) needsRefresh = true;
            }
          } catch {
            if (state.remote.status === "ready") {
              state.remote = { ...state.remote,
                connection: { status: "repair_failed", code: "project_event_invalid" } };
              publish(state);
            }
            return;
          }
          if (!needsRefresh) return;
          if (state.remote.status === "ready") {
            state.remote = { ...state.remote, connection: { status: "repairing" },
              operation: { status: "idle" } };
            publish(state);
          }
          await refresh(state, "repair");
        },
        async retry() { await refresh(state, "repair"); },
      },
    ).then((subscription) => {
      if (closed) subscription.close(); else state.subscription = subscription;
    }).catch(async () => {
      if (state.remote.status === "ready") {
        state.remote = { ...state.remote, connection: { status: "repair_failed", code: "project_subscription_failed" } };
        publish(state);
      }
    }).finally(() => { state.subscriptionStarting = undefined; });
    state.subscriptionStarting = started;
    await started;
  };

  const refresh = async (
    state: RoomState,
    source: "query" | "repair" = "query",
  ): Promise<ProjectLoopRemoteState> => {
    if (state.refresh !== undefined) return state.refresh;
    const run = (async () => {
      const session = options.session();
      if (session === undefined) {
        lock(state, 401, "unauthenticated");
        return state.remote;
      }
      const identity = options.createRequestIdentity();
      const response = await options.transport.projectRequest({
        type: "project.snapshot.read",
        requestId: identity.requestId,
        roomId: state.roomId,
        projectId: state.roomId,
        afterEventSeq: 0,
        limit: 256,
      });
      if (!isProjectLoopWireResponse(response) || response.type !== "project.snapshot" ||
          response.requestId !== identity.requestId || response.snapshot.roomId !== state.roomId) {
        throw new TypeError("Project Loop returned a malformed snapshot");
      }
      const snapshot = source === "repair"
        ? state.replica.replaceFromRepair({ kind: "project-loop", roomId: state.roomId, value: response.snapshot })
        : state.replica.replaceFromQuery(response.snapshot);
      state.remote = {
        status: "ready",
        roomId: state.roomId,
        snapshot,
        viewerActorId: session.actorId,
        connection: { status: "online" },
        operation: { status: "idle" },
      };
      publish(state);
      void ensureSubscription(state);
      return state.remote;
    })().catch((error: unknown) => {
      const normalized = errorStatus(error);
      if (normalized.status === 401) lock(state, 401, normalized.code);
      else if (state.remote.status === "ready") {
        state.remote = { ...state.remote,
          connection: source === "repair"
            ? { status: "repair_failed", code: normalized.code }
            : { status: "offline", asOf: now() },
          operation: { status: "failed", intentId: `refresh:${state.roomId}`, error: normalized },
        };
        publish(state);
      } else lock(state, normalized.status === 410 ? 410 : 503, normalized.code);
      return state.remote;
    }).finally(() => { state.refresh = undefined; });
    state.refresh = run;
    return run;
  };

  const submit = async (state: RoomState, intent: ProjectLoopIntent): Promise<ProjectLoopRemoteState> => {
    if (state.remote.status !== "ready" || state.remote.connection.status !== "online") return state.remote;
    state.remote = { ...state.remote, operation: { status: "submitting", intentId: intent.intentId } };
    publish(state);
    const identity = options.createRequestIdentity();
    try {
      const response = await options.transport.projectRequest(intent.kind === "proposal.resolve" ? {
        type: "project.proposal.resolve", requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey, roomId: state.roomId, projectId: state.roomId,
        proposalId: intent.proposalId, expectedRevision: intent.expectedRevision,
        resolution: intent.resolution, reason: intent.reason,
      } : intent.action === "accept" ? {
        type: "project.request.transition", requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey, roomId: state.roomId, projectId: state.roomId,
        factId: intent.factId, expectedRevision: intent.expectedRevision, action: "accept",
      } : intent.action === "transfer" ? {
        type: "project.request.transition", requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey, roomId: state.roomId, projectId: state.roomId,
        factId: intent.factId, expectedRevision: intent.expectedRevision, action: "transfer",
        target: intent.target, reason: intent.reason,
      } : {
        type: "project.request.transition", requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey, roomId: state.roomId, projectId: state.roomId,
        factId: intent.factId, expectedRevision: intent.expectedRevision,
        action: intent.action, reason: intent.reason,
      });
      if (!isProjectLoopWireResponse(response) || response.type !== "project.mutation.ack" ||
          response.requestId !== identity.requestId || response.roomId !== state.roomId) {
        throw new TypeError("Project Loop returned a malformed mutation ACK");
      }
      if (state.remote.status === "ready") {
        state.remote = { ...state.remote, operation: {
          status: "acknowledged", intentId: intent.intentId,
          acceptedRevision: response.acceptedRevision,
        } };
        publish(state);
      }
      return await refresh(state);
    } catch (error: unknown) {
      const normalized = errorStatus(error);
      if (normalized.status === 401) lock(state, 401, normalized.code);
      else if (state.remote.status === "ready") {
        state.remote = { ...state.remote,
          ...(normalized.status === 503 ? { connection: { status: "offline" as const, asOf: now() } } : {}),
          operation: { status: "failed", intentId: intent.intentId, error: normalized },
        };
        publish(state);
      }
      return state.remote;
    }
  };

  const stopTerminal = options.transport.onTerminalRevoked(() => {
    for (const state of rooms.values()) lock(state, 401, "session_revoked");
  });
  const stopAccess = options.transport.onRoomAccessChanged((roomId, change) => {
    const state = rooms.get(roomId);
    if (state === undefined) return;
    if (change === "removed") lock(state, 410, "room_access_removed");
    else void refresh(state, "repair");
  });
  const stopFailure = options.transport.onConnectionFailure(() => {
    for (const state of rooms.values()) {
      if (state.remote.status === "ready") {
        state.remote = { ...state.remote, connection: { status: "offline", asOf: now() } };
        publish(state);
      }
    }
  });

  return Object.freeze({
    async getSurface(query: ProjectLoopSurfaceQuery) {
      const state = room(query.roomId);
      return state.remote.status === "loading" || state.remote.status === "ready" &&
        (state.remote.connection.status === "offline" || state.remote.connection.status === "repair_failed")
        ? refresh(state, state.remote.status === "ready" ? "repair" : "query")
        : structuredClone(state.remote);
    },
    submit(command: ProjectLoopSubmitCommand) { return submit(room(command.roomId), command.intent); },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidateAuthorizedState() {
      for (const state of rooms.values()) lock(state, 401, "identity_invalidated");
    },
    close() {
      if (closed) return;
      closed = true;
      stopTerminal(); stopAccess(); stopFailure();
      for (const state of rooms.values()) state.subscription?.close();
      listeners.clear();
      options.transport.close();
    },
  });
}
