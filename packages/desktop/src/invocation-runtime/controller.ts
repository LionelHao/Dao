import type { RoomRepairRecord } from "@native-im/core";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import type { DesktopAuthorityCache } from "../governance/authority-cache.js";
import {
  GovernanceTransportError,
  type GovernanceAuthorityTransport,
  type InvocationWireCommand,
} from "../governance/websocket-authority.js";
import type {
  InvocationClosedError,
  InvocationConnectionState,
  InvocationControlKind,
  InvocationControlRequest,
  InvocationControlResult,
  InvocationOperationState,
  InvocationStateEnvelope,
  InvocationSurfaceState,
} from "./contracts.js";

function closedError(error: unknown): InvocationClosedError {
  if (!(error instanceof GovernanceTransportError)) {
    return { status: 503, code: "service_unavailable", recovery: "repair-room" };
  }
  switch (error.code) {
    case "authentication_required":
    case "session_revoked":
      return { status: 401, code: "authentication_required", recovery: "reauthenticate" };
    case "access_revoked":
    case "role_forbidden":
      return { status: 403, code: "access_revoked", recovery: "request-access" };
    case "execution_conflict":
    case "room_archived":
      return { status: 409, code: "execution_conflict", recovery: "refresh-authority" };
    case "context_unavailable":
      return { status: 410, code: "context_unavailable", recovery: "refresh-authority" };
    case "protocol_upgrade_required":
    case "snapshot_expired":
      return { status: 410, code: "protocol_upgrade_required", recovery: "upgrade-client" };
    case "rate_limited":
      return { status: 429, code: "rate_limited", recovery: "retry-later",
        ...(error.retryAfterSeconds === undefined
          ? {} : { retryAfterSeconds: error.retryAfterSeconds }) };
    default:
      return { status: 503, code: "service_unavailable", recovery: "repair-room" };
  }
}

function recordsState(
  roomId: string,
  records: readonly RoomRepairRecord[] | undefined,
  connection: InvocationConnectionState,
  operations: ReadonlyMap<string, InvocationOperationState>,
): InvocationSurfaceState {
  const values = records ?? [];
  const attempts = values.flatMap((record) => record.kind === "agent-execution-attempt"
    ? [record.value] : []);
  const intents = new Map(values.flatMap((record) => record.kind === "agent-invocation-intent"
    ? [[record.value.intentId, record.value] as const] : []));
  const cancellations = values.flatMap((record) => record.kind === "agent-scoped-cancellation"
    ? [record.value] : []);
  const timeline = new Map(values.flatMap((record) => record.kind === "timeline-message"
    ? [[record.value.id, record.value] as const] : []));
  const executions = values.flatMap((record) => {
    if (record.kind !== "agent-execution") return [];
    const intent = intents.get(record.value.intentId);
    const source = intent === undefined ? undefined : timeline.get(intent.sourceMessageId);
    const sourceLifecycle = source === undefined ? "unknown" as const
      : source.lifecycle === "recalled" ? "recalled" as const
        : source.authorKind !== "human" || intent === undefined ? "unknown" as const
          : source.currentRevision.revision === intent.sourceRevision ? "active" as const
            : source.currentRevision.revision > intent.sourceRevision ? "revised" as const
              : "unknown" as const;
    const preservedDispatchIds = cancellations.flatMap((receipt) =>
      receipt.executionOutcomes.some((outcome) => outcome.executionId === record.value.executionId)
        ? receipt.preservedDispatchIds : []);
    return [{
      execution: record.value,
      attempts: attempts.filter((attempt) => attempt.executionId === record.value.executionId)
        .sort((left, right) => left.attemptSeq - right.attemptSeq),
      sourceLifecycle,
      preservedDispatchIds: [...new Set(preservedDispatchIds)].sort(),
    }];
  }).sort((left, right) => left.execution.queuedAt.localeCompare(right.execution.queuedAt) ||
    left.execution.executionId.localeCompare(right.execution.executionId));
  const executionIds = new Set(executions.map((entry) => entry.execution.executionId));
  return {
    roomId,
    connection,
    executions,
    retries: values.flatMap((record) => record.kind === "agent-execution-retry" ? [record.value] : []),
    cancellations,
    projectBoundaries: values.flatMap((record) =>
      record.kind === "project-boundary-invocation" ? [record.value] : []),
    operations: [...operations.values()].filter((operation) => operation.status !== "idle" &&
      executionIds.has(operation.executionId)),
  };
}

export interface InvocationController {
  getSurface(input: { readonly roomId: string }): Promise<InvocationSurfaceState>;
  cancel(input: InvocationControlRequest): Promise<InvocationControlResult>;
  retry(input: InvocationControlRequest): Promise<InvocationControlResult>;
  subscribe(listener: (state: InvocationStateEnvelope) => void): () => void;
  markOffline(roomId: string): void;
  markRevoked(roomId: string, scope: "session" | "room"): void;
  close(): void;
}

export function createInvocationController(options: {
  readonly cache: DesktopAuthorityCache;
  readonly transport: Pick<GovernanceAuthorityTransport, "controlInvocation">;
  readonly repairRoom: (roomId: string) => Promise<void>;
  readonly session: () => IdentityAuthoritySession | undefined;
  readonly createRequestId: (kind: InvocationControlKind) => string;
  readonly now?: () => string;
}): InvocationController {
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<(state: InvocationStateEnvelope) => void>();
  const connections = new Map<string, InvocationConnectionState>();
  const operations = new Map<string, InvocationOperationState>();
  const operationRooms = new Map<string, string>();
  let closed = false;
  const state = (roomId: string): InvocationSurfaceState => {
    const connection = connections.get(roomId) ?? { status: "repairing" as const };
    const offlineAuthorized = options.cache.isOfflineReadAuthorized(roomId);
    const mayRead = connection.status === "online" ||
      ((connection.status === "offline" || connection.status === "repair_failed") && offlineAuthorized);
    return recordsState(
      roomId,
      mayRead ? options.cache.roomRepairRecords(roomId) : undefined,
      connection,
      operations,
    );
  };
  const publish = (roomId: string): void => {
    const envelope = { roomId, state: state(roomId) };
    for (const listener of [...listeners]) {
      try { listener(structuredClone(envelope)); } catch { /* observer */ }
    }
  };
  const reconcile = (roomId: string, records: readonly RoomRepairRecord[] | undefined): void => {
    if (records === undefined) {
      connections.set(roomId, { status: "offline", asOf: now() });
      publish(roomId);
      return;
    }
    for (const [executionId, operation] of operations) {
      if (operation.status !== "acknowledged") continue;
      if (operation.kind === "cancel") {
        const execution = records.find((record) => record.kind === "agent-execution" &&
          record.value.executionId === executionId);
        if (execution?.kind === "agent-execution" &&
            execution.value.version > operation.expectedVersion) {
          operations.delete(executionId); operationRooms.delete(executionId);
        }
      } else if (records.some((record) => record.kind === "agent-execution-retry" &&
          record.value.requestId === operation.requestId)) {
        operations.delete(executionId); operationRooms.delete(executionId);
      }
    }
    const prior = connections.get(roomId);
    if (prior?.status !== "online") {
      connections.set(roomId, options.cache.isOfflineReadAuthorized(roomId)
        ? { status: "offline", asOf: now() }
        : { status: "repairing" });
    }
    publish(roomId);
  };
  const unsubscribeCache = options.cache.subscribeRoomRecords(reconcile);

  const control = async (
    kind: InvocationControlKind,
    input: InvocationControlRequest,
  ): Promise<InvocationControlResult> => {
    const requestId = options.createRequestId(kind);
    operationRooms.set(input.executionId, input.roomId);
    const currentConnection = connections.get(input.roomId);
    const current = options.cache.roomRepairRecords(input.roomId)?.find((record) =>
      record.kind === "agent-execution" && record.value.executionId === input.executionId);
    if (closed || options.session() === undefined || currentConnection?.status !== "online") {
      const error = options.session() === undefined
        ? { status: 401, code: "authentication_required", recovery: "reauthenticate" } as const
        : { status: 503, code: "service_unavailable", recovery: "repair-room" } as const;
      operations.set(input.executionId, {
        status: "failed", requestId, kind, executionId: input.executionId,
        expectedVersion: input.expectedVersion, error,
      });
      publish(input.roomId);
      return { requestId, state: state(input.roomId) };
    }
    if (current?.kind !== "agent-execution" || current.value.version !== input.expectedVersion) {
      operations.set(input.executionId, {
        status: "failed", requestId, kind, executionId: input.executionId,
        expectedVersion: input.expectedVersion,
        error: { status: 409, code: "execution_conflict", recovery: "refresh-authority" },
      });
      publish(input.roomId);
      return { requestId, state: state(input.roomId) };
    }
    const projection = state(input.roomId).executions.find((entry) =>
      entry.execution.executionId === input.executionId);
    const eligible = kind === "cancel"
      ? current.value.status === "accepted" || current.value.status === "running"
      : (current.value.status === "failed" || current.value.status === "cancelled") &&
        (projection?.sourceLifecycle === "active" || projection?.sourceLifecycle === "revised") &&
        current.value.reviewState !== "needs_review";
    if (!eligible) {
      operations.set(input.executionId, {
        status: "failed", requestId, kind, executionId: input.executionId,
        expectedVersion: input.expectedVersion,
        error: { status: 409, code: "execution_conflict", recovery: "refresh-authority" },
      });
      publish(input.roomId);
      return { requestId, state: state(input.roomId) };
    }
    operations.set(input.executionId, {
      status: "submitting", requestId, kind, executionId: input.executionId,
      expectedVersion: input.expectedVersion,
    });
    publish(input.roomId);
    const command: InvocationWireCommand = {
      type: kind === "cancel" ? "invocation.cancel" : "invocation.retry",
      requestId,
      executionId: input.executionId,
      expectedVersion: input.expectedVersion,
    };
    try {
      await options.transport.controlInvocation(command);
      operations.set(input.executionId, {
        status: "acknowledged", requestId, kind, executionId: input.executionId,
        expectedVersion: input.expectedVersion,
      });
    } catch (error: unknown) {
      operations.set(input.executionId, {
        status: "failed", requestId, kind, executionId: input.executionId,
        expectedVersion: input.expectedVersion, error: closedError(error),
      });
    }
    publish(input.roomId);
    return { requestId, state: state(input.roomId) };
  };

  const controller: InvocationController = {
    async getSurface({ roomId }: { readonly roomId: string }) {
      if (closed || options.session() === undefined) {
        connections.set(roomId, { status: "revoked", scope: "session", purgeCompleted: true });
        return state(roomId);
      }
      connections.set(roomId, { status: "repairing" });
      publish(roomId);
      try {
        await options.repairRoom(roomId);
        connections.set(roomId, { status: "online" });
      } catch (error: unknown) {
        const failure = closedError(error);
        connections.set(roomId, failure.status === 401 || failure.status === 403
          ? { status: "revoked", scope: failure.status === 401 ? "session" : "room", purgeCompleted: true }
          : failure.status === 503
            ? { status: "offline", asOf: now() }
            : { status: "repair_failed", errorCode: failure.code });
      }
      publish(roomId);
      return state(roomId);
    },
    cancel: (input: InvocationControlRequest) => control("cancel", input),
    retry: (input: InvocationControlRequest) => control("retry", input),
    subscribe(listener: (state: InvocationStateEnvelope) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    markOffline(roomId: string) {
      connections.set(roomId, { status: "offline", asOf: now() });
      publish(roomId);
    },
    markRevoked(roomId: string, scope: "session" | "room") {
      for (const [executionId, operationRoomId] of operationRooms) {
        if (operationRoomId === roomId) {
          operationRooms.delete(executionId); operations.delete(executionId);
        }
      }
      connections.set(roomId, { status: "revoked", scope, purgeCompleted: true });
      publish(roomId);
    },
    close() {
      closed = true; unsubscribeCache(); listeners.clear(); operations.clear(); operationRooms.clear();
      connections.clear();
    },
  };
  return Object.freeze(controller);
}
