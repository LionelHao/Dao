import { isRoomGovernanceView, type RoomGovernanceView } from "@native-im/core";
import type {
  DepartureConflictList,
  GovernanceClosedError,
  GovernanceOperationState,
} from "../renderer/governance/view-model.js";
import {
  cloneDepartureConflictList,
  cloneGovernanceAuthorityAck,
  cloneGovernanceAuthoritySnapshot,
  cloneGovernanceRemoteState,
  isGovernanceDepartureQuery,
  isGovernanceMutationRequest,
  isGovernanceSurfaceQuery,
  type GovernanceAuthorityAck,
  type GovernanceAuthorityCommand,
  type GovernanceAuthoritySnapshot,
  type GovernanceDepartureQuery,
  type GovernanceMutationRequest,
  type GovernanceRemoteState,
  type GovernanceReadyState,
  type GovernanceStateEnvelope,
  type GovernanceSubmitResult,
  type GovernanceSurfaceQuery,
} from "./contracts.js";

export interface GovernanceAuthorityAdapter {
  querySurface(query: GovernanceSurfaceQuery): Promise<GovernanceAuthoritySnapshot>;
  queryDepartureConflicts(query: GovernanceDepartureQuery): Promise<DepartureConflictList>;
  execute(command: GovernanceAuthorityCommand): Promise<GovernanceAuthorityAck>;
}

export type GovernanceReplicaApplication =
  | {
      readonly source: "events";
      readonly roomId: string;
      readonly eventIds: readonly string[];
      readonly governance?: RoomGovernanceView;
    }
  | {
      readonly source: "repair";
      readonly roomId: string;
      readonly eventIds: readonly [];
      readonly governance: RoomGovernanceView;
    }
  | {
      readonly source: "revoked";
      readonly roomId: string;
      readonly eventIds: readonly [];
      readonly scope: "room" | "session";
      readonly purgeCompleted: boolean;
    }
  | {
      readonly source: "fatal";
      readonly roomId: string;
      readonly eventIds: readonly [];
      readonly errorCode: string;
    }
  | {
      readonly source: "offline";
      readonly roomId: string;
      readonly eventIds: readonly [];
      readonly asOf: string;
    };

export interface GovernanceReplicaFeed {
  subscribe(listener: (application: GovernanceReplicaApplication) => void): () => void;
}

export interface GovernanceReplicaFeedPort extends GovernanceReplicaFeed {
  applied(application: Extract<GovernanceReplicaApplication, { source: "events" | "repair" }>): void;
  revoked(input: {
    readonly roomId: string;
    readonly scope: "room" | "session";
    readonly purgeCompleted: boolean;
  }): void;
  fatal(input: { readonly roomId: string; readonly errorCode: string }): void;
  offline(input: { readonly roomId: string; readonly asOf: string }): void;
}

export function createGovernanceReplicaFeed(): GovernanceReplicaFeedPort {
  const listeners = new Set<(application: GovernanceReplicaApplication) => void>();
  const publish = (application: GovernanceReplicaApplication): void => {
    for (const listener of listeners) listener(structuredClone(application));
  };
  return Object.freeze({
    applied(application: Extract<GovernanceReplicaApplication, { source: "events" | "repair" }>) {
      if ((application.governance !== undefined &&
            (!isRoomGovernanceView(application.governance) ||
              application.governance.roomId !== application.roomId)) ||
          (application.source === "repair" && application.governance === undefined) ||
          !application.eventIds.every((eventId) => eventId.length > 0 && eventId.length <= 512)) {
        throw new TypeError("Governance replica application is not closed");
      }
      publish(application);
    },
    revoked(input: { readonly roomId: string; readonly scope: "room" | "session"; readonly purgeCompleted: boolean }) {
      publish({ source: "revoked", eventIds: [], ...input });
    },
    fatal(input: { readonly roomId: string; readonly errorCode: string }) {
      publish({ source: "fatal", eventIds: [], ...input });
    },
    offline(input: { readonly roomId: string; readonly asOf: string }) {
      publish({ source: "offline", eventIds: [], ...input });
    },
    subscribe(listener: (application: GovernanceReplicaApplication) => void) {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
  });
}

export class GovernanceAuthorityFailure extends Error {
  readonly error: GovernanceClosedError;
  constructor(error: GovernanceClosedError) {
    super(`${error.status} ${error.code}`);
    this.name = "GovernanceAuthorityFailure";
    this.error = structuredClone(error);
  }
}

interface PendingAuthority {
  readonly ack: GovernanceAuthorityAck;
  readonly appliedEventIds: Set<string>;
  appliedGovernance?: RoomGovernanceView;
}

export interface GovernanceController {
  getSurface(query: GovernanceSurfaceQuery): Promise<GovernanceRemoteState>;
  getDepartureConflicts(query: GovernanceDepartureQuery): Promise<DepartureConflictList>;
  submit(request: GovernanceMutationRequest): GovernanceSubmitResult;
  current(roomId: string): GovernanceRemoteState | undefined;
  subscribe(listener: (state: GovernanceStateEnvelope) => void): () => void;
  close(): void;
}

function readyState(snapshot: Extract<GovernanceAuthoritySnapshot, { status: "ready" }>): GovernanceReadyState {
  return {
    status: "ready",
    projection: structuredClone(snapshot.projection),
    viewerActorId: snapshot.viewerActorId,
    connection: structuredClone(snapshot.connection),
    operation: { status: "idle" },
    ...(snapshot.departureConflicts === undefined
      ? {} : { departureConflicts: structuredClone(snapshot.departureConflicts) }),
  };
}

function roomIdOf(state: GovernanceRemoteState): string {
  return state.status === "locked" ? state.roomId : state.projection.roomId;
}

function governanceMatchesProjection(
  governance: RoomGovernanceView,
  projection: Extract<GovernanceRemoteState, { status: "ready" }>["projection"],
): boolean {
  return governance.roomId === projection.roomId && governance.projectId === projection.projectId &&
    governance.lifecycle === projection.lifecycle &&
    governance.governanceRevision === projection.governanceRevision &&
    governance.archiveGeneration === projection.archiveGeneration &&
    governance.ownerActorId === projection.ownerActorId && governance.archivedAt === projection.archivedAt;
}

function projectionGovernanceMatches(
  left: Extract<GovernanceRemoteState, { status: "ready" }>["projection"],
  right: Extract<GovernanceRemoteState, { status: "ready" }>["projection"],
): boolean {
  return left.roomId === right.roomId && left.projectId === right.projectId &&
    left.lifecycle === right.lifecycle && left.governanceRevision === right.governanceRevision &&
    left.archiveGeneration === right.archiveGeneration && left.ownerActorId === right.ownerActorId &&
    left.archivedAt === right.archivedAt;
}

function mergeGovernance(
  state: Extract<GovernanceRemoteState, { status: "ready" }>,
  governance: RoomGovernanceView,
): Extract<GovernanceRemoteState, { status: "ready" }> {
  return {
    ...state,
    projection: {
      ...state.projection,
      lifecycle: governance.lifecycle,
      governanceRevision: governance.governanceRevision,
      archiveGeneration: governance.archiveGeneration,
      ownerActorId: governance.ownerActorId,
      ...(governance.archivedAt === undefined ? { archivedAt: undefined } : { archivedAt: governance.archivedAt }),
    },
  } as Extract<GovernanceRemoteState, { status: "ready" }>;
}

function localUnavailable(operation: GovernanceOperationState): GovernanceOperationState {
  if (operation.status === "idle") throw new TypeError("A submitting operation is required");
  return {
    status: "failed",
    requestId: operation.requestId,
    command: operation.command,
    error: { status: 503, code: "repair_unavailable" },
  };
}

export function createGovernanceController(options: {
  readonly authority: GovernanceAuthorityAdapter;
  readonly replica: GovernanceReplicaFeed;
  readonly createRequestIdentity: () => { readonly requestId: string; readonly idempotencyKey: string };
}): GovernanceController {
  const states = new Map<string, GovernanceRemoteState>();
  const pending = new Map<string, PendingAuthority>();
  const listeners = new Set<(state: GovernanceStateEnvelope) => void>();
  let closed = false;

  const emit = (state: GovernanceRemoteState): void => {
    const roomId = roomIdOf(state);
    states.set(roomId, cloneGovernanceRemoteState(state));
    const envelope = { roomId, state: cloneGovernanceRemoteState(state) };
    for (const listener of listeners) listener(envelope);
  };

  const refreshAfterConflict = async (
    roomId: string,
    failed: Extract<GovernanceOperationState, { status: "failed" }>,
  ): Promise<void> => {
    try {
      const snapshot = cloneGovernanceAuthoritySnapshot(
        await options.authority.querySurface({ roomId }),
      );
      if (closed) return;
      if (snapshot.status === "locked") {
        pending.delete(roomId);
        emit(snapshot);
        return;
      }
      emit({ ...readyState(snapshot), operation: failed });
    } catch {
      const current = states.get(roomId);
      if (current?.status === "ready") emit({ ...current, operation: failed });
    }
  };

  const finishAuthority = async (
    roomId: string,
    request: GovernanceMutationRequest,
    requestId: string,
    idempotencyKey: string,
  ): Promise<void> => {
    try {
      const ack = cloneGovernanceAuthorityAck(await options.authority.execute({
        ...request, requestId, idempotencyKey,
      }));
      if (closed || ack.requestId !== requestId || ack.command !== request.intent.command ||
          ack.projection.roomId !== roomId) return;
      const current = states.get(roomId);
      if (current?.status !== "ready" || current.operation.status !== "submitting" ||
          current.operation.requestId !== requestId) return;
      if (ack.replayed) {
        emit({ ...current, operation: { status: "acknowledged", requestId, command: ack.command } });
        try {
          const repaired = cloneGovernanceAuthoritySnapshot(
            await options.authority.querySurface({ roomId }),
          );
          if (closed) return;
          const waiting = states.get(roomId);
          if (waiting?.status !== "ready" || waiting.operation.status !== "acknowledged" ||
              waiting.operation.requestId !== requestId) return;
          if (repaired.status === "locked") {
            pending.delete(roomId);
            emit(repaired);
            return;
          }
          if (repaired.connection.status !== "online" ||
              !projectionGovernanceMatches(repaired.projection, ack.projection)) {
            emit({ ...waiting, operation: {
              status: "failed", requestId, command: ack.command,
              error: { status: 503, code: "repair_unavailable" },
            } });
            return;
          }
          emit({ ...readyState(repaired), operation: {
            status: "succeeded", requestId, command: ack.command,
          } });
        } catch {
          const waiting = states.get(roomId);
          if (waiting?.status === "ready" && waiting.operation.status === "acknowledged" &&
              waiting.operation.requestId === requestId) emit({ ...waiting, operation: {
            status: "failed", requestId, command: ack.command,
            error: { status: 503, code: "repair_unavailable" },
          } });
        }
        return;
      }
      if (ack.result !== "accepted") {
        const expectedLifecycle = ack.result === "already_archived" ? "archived" : "active";
        if (ack.projection.lifecycle !== expectedLifecycle) return;
        emit({
          ...current,
          projection: ack.projection,
          operation: { status: "succeeded", requestId, command: ack.command },
        });
        return;
      }
      pending.set(roomId, { ack, appliedEventIds: new Set() });
      emit({
        ...current,
        operation: { status: "acknowledged", requestId, command: ack.command },
      });
    } catch (cause: unknown) {
      if (closed) return;
      const current = states.get(roomId);
      if (current?.status !== "ready" || current.operation.status !== "submitting" ||
          current.operation.requestId !== requestId) return;
      const error: GovernanceClosedError = cause instanceof GovernanceAuthorityFailure
        ? cause.error
        : { status: 503, code: "service_unavailable" };
      const failed = { status: "failed", requestId, command: request.intent.command, error } as const;
      if (error.status === 409 && error.code === "departure_blocked") {
        emit({ ...current, operation: failed, departureConflicts: error.details });
      } else if (error.status === 409 && error.code === "room_revision_conflict") {
        await refreshAfterConflict(roomId, failed);
      } else {
        emit({ ...current, operation: failed });
      }
    }
  };

  const unsubscribeReplica = options.replica.subscribe((application) => {
    if (closed) return;
    if (application.source === "revoked") {
      pending.delete(application.roomId);
      emit({
        status: "locked",
        roomId: application.roomId,
        connection: {
          status: "revoked", scope: application.scope, purgeCompleted: application.purgeCompleted,
        },
      });
      return;
    }
    if (application.source === "fatal") {
      pending.delete(application.roomId);
      emit({
        status: "locked", roomId: application.roomId,
        connection: { status: "fatal", errorCode: application.errorCode },
      });
      return;
    }
    if (application.source === "offline") {
      pending.delete(application.roomId);
      emit({ status: "locked", roomId: application.roomId,
        connection: { status: "offline", asOf: application.asOf } });
      return;
    }
    if (application.governance !== undefined &&
        (!isRoomGovernanceView(application.governance) ||
          application.governance.roomId !== application.roomId)) return;
    const current = states.get(application.roomId);
    if (current?.status !== "ready") return;
    const waiting = pending.get(application.roomId);
    if (waiting === undefined) {
      if (application.governance !== undefined) {
        emit(mergeGovernance(current, application.governance));
      }
      return;
    }
    for (const eventId of application.eventIds) waiting.appliedEventIds.add(eventId);
    if (application.governance !== undefined) waiting.appliedGovernance = application.governance;
    const complete = waiting.ack.eventIds.every((eventId) => waiting.appliedEventIds.has(eventId));
    if (!complete || waiting.appliedGovernance === undefined ||
        !governanceMatchesProjection(waiting.appliedGovernance, waiting.ack.projection)) return;
    pending.delete(application.roomId);
    emit({
      ...current,
      projection: waiting.ack.projection,
      operation: {
        status: "succeeded", requestId: waiting.ack.requestId, command: waiting.ack.command,
      },
    });
  });

  return {
    async getSurface(query) {
      if (closed) throw new TypeError("Governance controller is closed");
      if (!isGovernanceSurfaceQuery(query)) throw new TypeError("Invalid Governance surface query");
      const snapshot = cloneGovernanceAuthoritySnapshot(await options.authority.querySurface(query));
      const state = snapshot.status === "locked" ? snapshot : readyState(snapshot);
      emit(state);
      return cloneGovernanceRemoteState(state);
    },
    async getDepartureConflicts(query) {
      if (closed) throw new TypeError("Governance controller is closed");
      if (!isGovernanceDepartureQuery(query)) throw new TypeError("Invalid Governance conflicts query");
      const list = cloneDepartureConflictList(await options.authority.queryDepartureConflicts(query));
      if (list.roomId !== query.roomId || list.targetActorId !== query.targetActorId) {
        throw new TypeError("Governance conflicts crossed Room authority");
      }
      const current = states.get(query.roomId);
      if (current?.status === "ready") emit({ ...current, departureConflicts: list });
      return list;
    },
    submit(request) {
      if (closed) throw new TypeError("Governance controller is closed");
      if (!isGovernanceMutationRequest(request)) throw new TypeError("Invalid Governance mutation request");
      const current = states.get(request.roomId);
      if (current === undefined || current.status === "locked") {
        throw new TypeError("Governance Room is not available for mutation");
      }
      const identity = options.createRequestIdentity();
      if (identity.requestId.length === 0 || identity.idempotencyKey.length === 0) {
        throw new TypeError("Governance request identity is invalid");
      }
      const operation: GovernanceOperationState = {
        status: "submitting", requestId: identity.requestId, command: request.intent.command,
      };
      const next: GovernanceRemoteState = current.connection.status === "online"
        ? { ...current, operation }
        : { ...current, operation: localUnavailable(operation) };
      emit(next);
      if (current.connection.status === "online") {
        void finishAuthority(request.roomId, request, identity.requestId, identity.idempotencyKey);
      }
      return { requestId: identity.requestId, state: cloneGovernanceRemoteState(next) };
    },
    current(roomId) {
      const state = states.get(roomId);
      return state === undefined ? undefined : cloneGovernanceRemoteState(state);
    },
    subscribe(listener) {
      if (closed) throw new TypeError("Governance controller is closed");
      if (typeof listener !== "function") throw new TypeError("Governance listener is invalid");
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribeReplica();
      listeners.clear();
      states.clear();
      pending.clear();
    },
  };
}
