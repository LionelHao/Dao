import type { RoomRepairRecord } from "@native-im/core";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import type { MessageAuthorityWireTransport } from "../message-authority/websocket-authority.js";
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
type ProjectWireTransport = Pick<MessageAuthorityWireTransport,
  "onTerminalRevoked" | "onRoomAccessChanged" | "onConnectionFailure"
> & Readonly<{
  projectRequest(command: ProjectLoopWireRequest): Promise<ProjectLoopWireResponse>;
}>;
type ProjectAuthorityCache = Readonly<{
  roomRepairRecords(roomId: string): readonly RoomRepairRecord[] | undefined;
  subscribeRoomRecords(listener: (
    roomId: string,
    records: readonly RoomRepairRecord[] | undefined,
  ) => void): () => void;
  clearRoom(roomId: string): void;
  clear(): void;
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
  refreshAuthorityGeneration: number | undefined;
  authorityGeneration: number;
  pendingOperation: Readonly<{
    intent: ProjectLoopIntent;
    identity: Readonly<{ requestId: string; idempotencyKey: string }>;
  }> | undefined;
}

function errorStatus(error: unknown): Readonly<{
  status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503;
  code: string;
  retryAfterSeconds?: number;
}> {
  const closed = typeof error === "object" && error !== null && "projectError" in error &&
    (error as { projectError?: unknown }).projectError !== undefined
    ? (error as { projectError?: { status?: unknown; code?: unknown; retryAfterSeconds?: unknown } }).projectError
    : typeof error === "object" && error !== null && "closedError" in error
    ? (error as { closedError?: { status?: unknown; code?: unknown; retryAfterSeconds?: unknown } }).closedError
    : typeof error === "object" && error !== null && "status" in error && "code" in error
    ? error as { status?: unknown; code?: unknown; retryAfterSeconds?: unknown }
    : undefined;
  const rawCode = typeof closed?.code === "string" ? closed.code : undefined;
  const status = rawCode === "session_revoked" ? 401 : closed?.status;
  const normalized = status === 400 || status === 401 || status === 403 || status === 404 ||
    status === 409 || status === 410 ||
    status === 429 || status === 503 ? status : 503;
  return Object.freeze({
    status: normalized,
    code: rawCode !== undefined && rawCode.length > 0 ? rawCode : "project_dependency_unavailable",
    ...(typeof closed?.retryAfterSeconds === "number" && Number.isSafeInteger(closed.retryAfterSeconds) &&
      closed.retryAfterSeconds >= 0 ? { retryAfterSeconds: closed.retryAfterSeconds } : {}),
  });
}

export function createDesktopProjectLoopRuntime(options: Readonly<{
  session: () => IdentityAuthoritySession | undefined;
  transport: ProjectWireTransport;
  authorityCache: ProjectAuthorityCache;
  repairRoom(roomId: string): Promise<void>;
  restoreAuthorityCache(actorId: string): Promise<boolean>;
  createRequestIdentity: () => Readonly<{ requestId: string; idempotencyKey: string }>;
  now?: () => string;
}>): DesktopProjectLoopRuntime {
  const rooms = new Map<string, RoomState>();
  const revokedRooms = new Set<string>();
  const listeners = new Set<Listener>();
  const now = options.now ?? (() => new Date().toISOString());
  let closed = false;
  let revokedSessionId: string | undefined;
  let sessionAuthorityGeneration = 0;

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
      refreshAuthorityGeneration: undefined,
      authorityGeneration: 0,
      pendingOperation: undefined,
    };
    rooms.set(roomId, created);
    return created;
  };
  const lock = (state: RoomState, status: 401 | 410 | 503, code: string): void => {
    state.replica.clear();
    state.remote = { status: "locked", roomId: state.roomId, error: { status, code } };
    publish(state);
  };
  const revokeRoom = (state: RoomState, code: string): void => {
    state.authorityGeneration += 1;
    state.pendingOperation = undefined;
    revokedRooms.add(state.roomId);
    lock(state, 410, code);
    options.authorityCache.clearRoom(state.roomId);
  };
  const revokeSession = (code: string): void => {
    sessionAuthorityGeneration += 1;
    revokedSessionId = options.session()?.sessionId;
    for (const state of rooms.values()) {
      state.authorityGeneration += 1;
      state.pendingOperation = undefined;
      revokedRooms.add(state.roomId);
      lock(state, 401, code);
    }
    options.authorityCache.clear();
  };

  const readCachedSnapshot = (state: RoomState): ProjectLoopRemoteState => {
    const records = options.authorityCache.roomRepairRecords(state.roomId);
    const record = records?.find(
      (candidate): candidate is Extract<RoomRepairRecord, { kind: "project-loop" }> =>
        candidate.kind === "project-loop" && candidate.roomId === state.roomId,
    );
    if (record === undefined) throw new TypeError("Project Loop repair record is absent");
    const snapshot = state.replica.replaceFromRepair(record);
    const session = options.session();
    if (session === undefined) {
      lock(state, 401, "unauthenticated");
      return state.remote;
    }
    state.remote = {
      status: "ready", roomId: state.roomId, snapshot, viewerActorId: session.actorId,
      connection: { status: "online" },
      operation: records?.some((candidate) => candidate.kind === "room" &&
        candidate.value.id === state.roomId && candidate.value.status === "archived")
        ? { status: "failed", intentId: `lifecycle:${state.roomId}`,
            error: { status: 410, code: "room_archived" } }
        : { status: "idle" },
    };
    publish(state);
    return state.remote;
  };

  const refresh = async (
    state: RoomState,
    source: "query" | "repair" = "query",
  ): Promise<ProjectLoopRemoteState> => {
    if (state.refresh !== undefined) return state.refresh;
    const authorityGeneration = state.authorityGeneration;
    const sessionGeneration = sessionAuthorityGeneration;
    const stillAuthorized = (): boolean => sessionGeneration === sessionAuthorityGeneration &&
      authorityGeneration === state.authorityGeneration && !revokedRooms.has(state.roomId);
    const discardLateRepair = (): ProjectLoopRemoteState => {
      if (sessionGeneration !== sessionAuthorityGeneration) {
        options.authorityCache.clear();
      } else {
        options.authorityCache.clearRoom(state.roomId);
      }
      return state.remote;
    };
    const run = (async () => {
      const session = options.session();
      if (session === undefined) {
        lock(state, 401, "unauthenticated");
        return state.remote;
      }
      await options.restoreAuthorityCache(session.actorId);
      if (!stillAuthorized()) return discardLateRepair();
      await options.repairRoom(state.roomId);
      if (!stillAuthorized()) return discardLateRepair();
      return readCachedSnapshot(state);
    })().catch((error: unknown) => {
      if (!stillAuthorized()) return discardLateRepair();
      const normalized = errorStatus(error);
      if (normalized.status === 401) revokeSession(normalized.code);
      else if (normalized.status === 403 && ["access_revoked", "room_forbidden", "identity_forbidden"]
        .includes(normalized.code)) revokeRoom(state, normalized.code);
      else if (normalized.status === 410 && normalized.code !== "room_archived") {
        revokeRoom(state, normalized.code);
      } else if (state.remote.status === "ready") {
        state.remote = { ...state.remote,
          connection: source === "repair"
            ? { status: "repair_failed", code: normalized.code }
            : { status: "offline", asOf: now() },
          operation: { status: "failed", intentId: `refresh:${state.roomId}`, error: normalized },
        };
        publish(state);
      } else {
        try {
          const cached = readCachedSnapshot(state);
          if (cached.status === "ready") {
            state.remote = { ...cached, connection: { status: "offline", asOf: now() } };
            publish(state);
          }
        } catch {
          lock(state, normalized.status === 410 ? 410 : 503, normalized.code);
        }
      }
      return state.remote;
    }).finally(() => {
      state.refresh = undefined;
      state.refreshAuthorityGeneration = undefined;
    });
    state.refresh = run;
    state.refreshAuthorityGeneration = authorityGeneration;
    return run;
  };

  const submit = async (
    state: RoomState,
    intent: ProjectLoopIntent,
    identity: Readonly<{ requestId: string; idempotencyKey: string }> = options.createRequestIdentity(),
  ): Promise<ProjectLoopRemoteState> => {
    if (state.remote.status !== "ready" || state.remote.connection.status !== "online" ||
        state.remote.operation.status === "failed" &&
          (state.remote.operation.error.status === 401 || state.remote.operation.error.status === 403 ||
            state.remote.operation.error.status === 410)) return state.remote;
    state.remote = { ...state.remote, operation: { status: "submitting", intentId: intent.intentId } };
    publish(state);
    state.pendingOperation = Object.freeze({ intent: structuredClone(intent), identity: { ...identity } });
    try {
      const common = { requestId: identity.requestId, idempotencyKey: identity.idempotencyKey,
        roomId: state.roomId, projectId: state.roomId } as const;
      const frame: ProjectLoopWireRequest = intent.kind === "proposal.resolve" ? {
        type: "project.proposal.resolve", requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey, roomId: state.roomId, projectId: state.roomId,
        proposalId: intent.proposalId, expectedRevision: intent.expectedRevision,
        resolution: intent.resolution, reason: intent.reason,
      } : intent.kind === "request.transition" && intent.action === "accept" ? {
        type: "project.request.transition", requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey, roomId: state.roomId, projectId: state.roomId,
        factId: intent.factId, expectedRevision: intent.expectedRevision, action: "accept",
      } : intent.kind === "request.transition" && intent.action === "transfer" ? {
        type: "project.request.transition", requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey, roomId: state.roomId, projectId: state.roomId,
        factId: intent.factId, expectedRevision: intent.expectedRevision, action: "transfer",
        target: intent.target, reason: intent.reason,
      } : intent.kind === "request.transition" ? {
        type: "project.request.transition", requestId: identity.requestId,
        idempotencyKey: identity.idempotencyKey, roomId: state.roomId, projectId: state.roomId,
        factId: intent.factId, expectedRevision: intent.expectedRevision,
        action: intent.action, reason: intent.reason,
      } : intent.kind === "next_action.transition" ? {
        ...common, type: "project.next-action.transition", factId: intent.factId,
        expectedRevision: intent.expectedRevision, action: intent.action,
        ...(intent.action === "complete" ? { completionNote: intent.completionNote,
          criteriaSnapshot: intent.criteriaSnapshot }
          : intent.action === "deliver" ? { source: intent.source, summary: intent.summary }
            : intent.action === "reject" || intent.action === "cancel" || intent.action === "reopen"
              ? { reason: intent.reason } : {}),
      } as ProjectLoopWireRequest : intent.kind === "obstacle.transition" ? {
        ...common, type: "project.obstacle.transition", factId: intent.factId,
        expectedRevision: intent.expectedRevision, obstacleKind: intent.obstacleKind, action: intent.action,
        ...(intent.action === "resolve" ? { resultSource: intent.resultSource, reason: intent.reason }
          : intent.action === "defer" ? { reason: intent.reason, reviewAt: intent.reviewAt }
            : { reason: intent.reason }),
      } as ProjectLoopWireRequest : intent.kind === "transfer.propose" ? {
        ...common, type: "project.transfer.propose", transferProposalId: intent.transferProposalId,
        subjectKind: intent.subjectKind, subjectId: intent.subjectId,
        expectedRevision: intent.expectedRevision, toOwner: intent.toOwner, reason: intent.reason,
      } : {
        ...common, type: "project.transfer.resolve", transferProposalId: intent.transferProposalId,
        subjectKind: intent.subjectKind, subjectId: intent.subjectId,
        expectedRevision: intent.expectedRevision, resolution: intent.resolution, reason: intent.reason,
      };
      const response = await options.transport.projectRequest(frame);
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
      state.pendingOperation = undefined;
      return await refresh(state);
    } catch (error: unknown) {
      const normalized = errorStatus(error);
      if (normalized.status === 401) revokeSession(normalized.code);
      else if (normalized.status === 403 && ["access_revoked", "room_forbidden", "identity_forbidden"]
        .includes(normalized.code)) revokeRoom(state, normalized.code);
      else if (normalized.status === 410 && normalized.code !== "room_archived") {
        revokeRoom(state, normalized.code);
      } else if (state.remote.status === "ready") {
        state.remote = { ...state.remote,
          ...(normalized.status === 503 ? { connection: { status: "offline" as const, asOf: now() } } : {}),
          operation: { status: "failed", intentId: intent.intentId, error: normalized },
        };
        publish(state);
      }
      if (normalized.status !== 409 && normalized.status !== 429 && normalized.status !== 503) {
        state.pendingOperation = undefined;
      }
      return state.remote;
    }
  };

  const rebasedIntent = (state: RoomState, intent: ProjectLoopIntent): ProjectLoopIntent | undefined => {
    if (state.remote.status !== "ready") return undefined;
    const snapshot = state.remote.snapshot;
    const revision = intent.kind === "proposal.resolve"
      ? snapshot.proposals.find((item) => item.proposalId === intent.proposalId)?.revision
      : intent.kind === "request.transition"
        ? snapshot.requests.find((item) => item.requestId === intent.factId)?.revision
        : intent.kind === "next_action.transition"
          ? snapshot.nextActions.find((item) => item.nextActionId === intent.factId)?.revision
          : intent.kind === "obstacle.transition"
            ? snapshot.obstacles.find((item) => item.obstacleId === intent.factId)?.revision
            : intent.kind === "transfer.resolve"
              ? snapshot.transferProposals.find((item) =>
                  item.transferProposalId === intent.transferProposalId)?.revision
              : intent.subjectKind === "next_action"
                ? snapshot.nextActions.find((item) => item.nextActionId === intent.subjectId)?.revision
                : snapshot.obstacles.find((item) => item.obstacleId === intent.subjectId &&
                    item.kind === intent.subjectKind)?.revision;
    return revision === undefined ? undefined : { ...intent, expectedRevision: revision };
  };

  const recoverPendingOperation = async (state: RoomState): Promise<ProjectLoopRemoteState> => {
    const pending = state.pendingOperation;
    if (pending === undefined || state.remote.status !== "ready" ||
        state.remote.operation.status !== "failed") return structuredClone(state.remote);
    const status = state.remote.operation.error.status;
    if (status !== 409 && status !== 429 && status !== 503) return structuredClone(state.remote);
    if (status === 409 || state.remote.connection.status !== "online") {
      await refresh(state, "repair");
    }
    if (state.remote.status !== "ready" || state.remote.connection.status !== "online") {
      return structuredClone(state.remote);
    }
    if (status === 409) {
      const intent = rebasedIntent(state, pending.intent);
      if (intent === undefined) return structuredClone(state.remote);
      return submit(state, intent, options.createRequestIdentity());
    }
    return submit(state, pending.intent, pending.identity);
  };

  const stopTerminal = options.transport.onTerminalRevoked(() => {
    revokeSession("session_revoked");
  });
  const stopAccess = options.transport.onRoomAccessChanged((roomId, change) => {
    const state = rooms.get(roomId);
    if (state === undefined) return;
    if (change === "removed") revokeRoom(state, "room_access_removed");
    else {
      const authorityGeneration = ++state.authorityGeneration;
      revokedRooms.delete(roomId);
      if (state.remote.status === "locked") {
        state.remote = { status: "loading", roomId };
        publish(state);
      }
      const previousRefresh = state.refresh;
      void (async () => {
        if (previousRefresh !== undefined) await previousRefresh;
        if (closed || state.authorityGeneration !== authorityGeneration || revokedRooms.has(roomId)) return;
        await refresh(state, "repair");
      })().catch(() => undefined);
    }
  });
  const stopFailure = options.transport.onConnectionFailure(() => {
    for (const state of rooms.values()) {
      if (state.remote.status === "ready") {
        state.remote = { ...state.remote, connection: { status: "offline", asOf: now() } };
        publish(state);
      }
    }
  });
  const stopCache = options.authorityCache.subscribeRoomRecords((roomId, records) => {
    const state = rooms.get(roomId);
    if (closed || state === undefined) return;
    if (revokedRooms.has(roomId)) return;
    if (state.refresh !== undefined && state.refreshAuthorityGeneration !== state.authorityGeneration) return;
    if (records === undefined) {
      state.replica.clear();
      state.remote = { status: "loading", roomId };
      publish(state);
      if (state.refresh === undefined) void refresh(state, "repair");
      return;
    }
    const record = records.find((candidate) => candidate.kind === "project-loop" &&
      candidate.roomId === roomId);
    if (record !== undefined) {
      try { readCachedSnapshot(state); }
      catch { lock(state, 503, "project_repair_record_invalid"); }
      return;
    }
    if (state.remote.status === "ready" && state.refresh === undefined) {
      state.remote = { ...state.remote, connection: { status: "repairing" },
        operation: { status: "idle" } };
      publish(state);
      void refresh(state, "repair");
    }
  });

  return Object.freeze({
    async getSurface(query: ProjectLoopSurfaceQuery) {
      const state = room(query.roomId);
      const activeSessionId = options.session()?.sessionId;
      if (state.remote.status === "locked" && state.remote.error.status === 401 &&
          activeSessionId !== undefined && activeSessionId !== revokedSessionId) {
        revokedSessionId = undefined;
        revokedRooms.clear();
        sessionAuthorityGeneration += 1;
        state.authorityGeneration += 1;
        state.remote = { status: "loading", roomId: state.roomId };
      }
      if (state.remote.status === "ready" && state.remote.operation.status === "failed" &&
          (state.remote.operation.error.status === 409 || state.remote.operation.error.status === 429 ||
            state.remote.operation.error.status === 503) && state.pendingOperation !== undefined) {
        return recoverPendingOperation(state);
      }
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
      revokeSession("identity_invalidated");
    },
    close() {
      if (closed) return;
      closed = true;
      stopTerminal(); stopAccess(); stopFailure(); stopCache();
      listeners.clear();
    },
  });
}
