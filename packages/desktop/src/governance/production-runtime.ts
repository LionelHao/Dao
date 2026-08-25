import { randomUUID } from "node:crypto";
import { createClientSyncReplica } from "../sync/client-sync-replica.js";
import type { RoomGovernanceView } from "@native-im/core";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import type { GovernanceProjection } from "../renderer/governance/view-model.js";
import {
  GovernanceAuthorityFailure,
  createGovernanceController,
  createGovernanceReplicaFeed,
  type GovernanceAuthorityAdapter,
  type GovernanceController,
} from "./controller.js";
import { createDesktopAuthorityCache, type DesktopAuthorityCache } from "./authority-cache.js";
import {
  GovernanceTransportError,
  createGovernanceWebSocketAuthority,
  type GovernanceAuthorityTransport,
  type GovernanceWebSocketLike,
} from "./websocket-authority.js";
import type { GovernanceClosedError } from "../renderer/governance/view-model.js";
import { createInvocationController, type InvocationController } from "../invocation-runtime/controller.js";

function closedError(error: unknown): GovernanceClosedError {
  if (!(error instanceof GovernanceTransportError)) {
    return { status: 503, code: "service_unavailable" };
  }
  switch (error.code) {
    case "authentication_required": return { status: 401, code: "authentication_required" };
    case "session_revoked": return { status: 401, code: "session_revoked" };
    case "access_revoked": return { status: 403, code: "access_revoked" };
    case "role_forbidden": return { status: 403, code: "role_forbidden" };
    case "member_not_found": return { status: 404, code: "member_not_found" };
    case "room_not_found": return { status: 404, code: "room_not_found" };
    case "room_revision_conflict": return { status: 409, code: "room_revision_conflict" };
    case "ownership_transfer_required": return { status: 409, code: "ownership_transfer_required" };
    case "room_archived": return { status: 409, code: "room_archived" };
    case "departure_blocked":
      return error.details === undefined
        ? { status: 503, code: "service_unavailable" }
        : { status: 409, code: "departure_blocked", details: error.details };
    case "snapshot_expired": return { status: 410, code: "snapshot_expired" };
    case "rate_limited": return { status: 429, code: "rate_limited" };
    case "dependency_unavailable": return { status: 503, code: "dependency_unavailable" };
    case "snapshot_stale":
    case "context_unavailable":
    case "execution_conflict":
    case "protocol_upgrade_required":
    case "connection_unavailable":
    case "request_timeout":
    case "protocol_error":
    case "client_closed":
    case "service_unavailable":
      return { status: 503, code: "service_unavailable" };
  }
}

function mergeAcknowledgedProjection(
  current: GovernanceProjection,
  governance: RoomGovernanceView,
  command: Parameters<GovernanceAuthorityTransport["execute"]>[0],
  viewerActorId: string,
): GovernanceProjection {
  const departedActorId = command.intent.command === "room.member.leave" ? viewerActorId
    : command.intent.command === "room.member.remove" ? command.intent.targetActorId : undefined;
  return {
    ...current,
    lifecycle: governance.lifecycle,
    governanceRevision: governance.governanceRevision,
    archiveGeneration: governance.archiveGeneration,
    ownerActorId: governance.ownerActorId,
    ...(governance.archivedAt === undefined ? { archivedAt: undefined } : { archivedAt: governance.archivedAt }),
    members: departedActorId === undefined ? current.members
      : current.members.filter((member) => member.actorId !== departedActorId),
  } as GovernanceProjection;
}

export interface DesktopGovernanceRuntime {
  readonly controller: GovernanceController;
  readonly invocations: InvocationController;
  readonly cache: DesktopAuthorityCache;
  invalidateAuthorizedState(): void;
  close(): void;
}

export function createDesktopGovernanceRuntime(options: {
  readonly endpoint: string;
  readonly session: () => IdentityAuthoritySession | undefined;
  readonly webSocketFactory: (endpoint: string) => GovernanceWebSocketLike;
  readonly createRequestIdentity: () => { readonly requestId: string; readonly idempotencyKey: string };
  readonly now?: () => string;
  readonly timeoutMs?: number;
}): DesktopGovernanceRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const cache = createDesktopAuthorityCache(now);
  const feed = createGovernanceReplicaFeed();
  const transport = createGovernanceWebSocketAuthority({
    endpoint: options.endpoint,
    session: options.session,
    webSocketFactory: options.webSocketFactory,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const replica = createClientSyncReplica({ transport, cache, governanceObserver: feed });
  const invocations = createInvocationController({
    cache, transport, repairRoom: (roomId) => replica.repairRoom(roomId),
    session: options.session, createRequestId: (kind) => `invocation-${kind}-${randomUUID()}`, now,
  });
  let closed = false;

  const authority: GovernanceAuthorityAdapter = {
    async querySurface({ roomId }) {
      const session = options.session();
      if (session === undefined) {
        return { status: "locked", roomId, connection: {
          status: "revoked", scope: "session", purgeCompleted: true,
        } };
      }
      try {
        await replica.repairRoom(roomId);
        const projection = cache.governanceProjection(roomId);
        if (projection === undefined) {
          return { status: "locked", roomId, connection: {
            status: "fatal", errorCode: "governance_projection_invalid",
          } };
        }
        return { status: "ready", projection, viewerActorId: session.actorId,
          connection: { status: "online" } };
      } catch (error: unknown) {
        const authorityError = closedError(error);
        if (authorityError.status === 503) {
          cache.clear();
          return { status: "locked", roomId, connection: { status: "offline", asOf: now() } };
        }
        if (authorityError.status === 401 || authorityError.status === 403) {
          cache.clear();
          return { status: "locked", roomId, connection: {
            status: "revoked", scope: authorityError.status === 401 ? "session" : "room", purgeCompleted: true,
          } };
        }
        return { status: "locked", roomId, connection: {
          status: "fatal", errorCode: authorityError.code === "snapshot_expired"
            ? "repair_snapshot_expired" : "repair_unavailable",
        } };
      }
    },
    async queryDepartureConflicts(query) {
      try {
        return await transport.queryDepartureConflicts({ requestId: `departure-${randomUUID()}`, ...query });
      } catch (error: unknown) {
        throw new GovernanceAuthorityFailure(closedError(error));
      }
    },
    async execute(command) {
      const session = options.session();
      const current = cache.governanceProjection(command.roomId);
      if (session === undefined || current === undefined) {
        throw new GovernanceAuthorityFailure({ status: 401, code: "authentication_required" });
      }
      try {
        const ack = await transport.execute(command);
        return {
          type: "ack", requestId: ack.requestId, command: ack.command, result: ack.result,
          eventIds: ack.eventIds, replayed: ack.replayed,
          projection: mergeAcknowledgedProjection(current, ack.governance, command, session.actorId),
        };
      } catch (error: unknown) {
        throw new GovernanceAuthorityFailure(closedError(error));
      }
    },
  };

  const controller = createGovernanceController({
    authority, replica: feed, createRequestIdentity: options.createRequestIdentity,
  });
  const unsubscribeTerminal = transport.onTerminalRevoked(() => {
    const roomIds = cache.roomIds();
    cache.clear();
    for (const roomId of roomIds) {
      invocations.markRevoked(roomId, "session");
      feed.revoked({ roomId, scope: "session", purgeCompleted: true });
    }
  });
  const unsubscribeRoomAccess = transport.onRoomAccessChanged((roomId, change) => {
    if (change === "removed") {
      cache.clearRoom(roomId);
      invocations.markRevoked(roomId, "room");
      feed.revoked({ roomId, scope: "room", purgeCompleted: true });
      return;
    }
    void replica.repairRoom(roomId).catch(() => {
      cache.clearRoom(roomId);
      feed.fatal({ roomId, errorCode: "repair_unavailable" });
    });
  });
  const unsubscribeFailure = transport.onConnectionFailure(() => {
    const roomIds = cache.roomIds();
    cache.clear();
    for (const roomId of roomIds) {
      invocations.markOffline(roomId);
      feed.offline({ roomId, asOf: now() });
    }
  });

  return Object.freeze({
    controller,
    invocations,
    cache,
    invalidateAuthorizedState() {
      const roomIds = cache.roomIds();
      cache.clear();
      transport.resetSession();
      for (const roomId of roomIds) {
        invocations.markRevoked(roomId, "session");
        feed.revoked({ roomId, scope: "session", purgeCompleted: true });
      }
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribeTerminal(); unsubscribeRoomAccess(); unsubscribeFailure(); controller.close();
      invocations.close();
      replica.close(); transport.close(); cache.clear();
    },
  });
}
