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
import type { AuthorityCachePersistence } from "./encrypted-authority-cache.js";
import type { EncryptedAuthorityGenerationStore } from "./encrypted-generation-store.js";
import {
  GovernanceTransportError,
  createGovernanceWebSocketAuthority,
  type GovernanceAuthorityTransport,
  type GovernanceWebSocketLike,
} from "./websocket-authority.js";
import type { GovernanceClosedError } from "../renderer/governance/view-model.js";
import type { GovernanceRemoteState } from "./contracts.js";
import { createInvocationController, type InvocationController } from "../invocation-runtime/controller.js";
import type {
  DesktopActiveGenerationBinding,
  DesktopOfflineReadLeaseBinding,
  DesktopOfflineReadLeaseClaims,
  DesktopOfflineReadLeaseVerifier,
} from "./offline-read-lease.js";

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
  restoreWorkspace(): Promise<void>;
  repairRoom(roomId: string): Promise<void>;
  clearCache(roomId: string): Promise<GovernanceRemoteState>;
  restoreCache(actorId: string): Promise<boolean>;
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
  readonly cachePersistence?: AuthorityCachePersistence;
  readonly generationStoreFactory?: (actorId: string) => EncryptedAuthorityGenerationStore;
  readonly offlineReadLeaseVerifier?: DesktopOfflineReadLeaseVerifier;
  readonly offlineReadLeaseAuthority?: Readonly<{
    tenantId: string;
    serverSubject: string;
  }>;
}): DesktopGovernanceRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const cache = createDesktopAuthorityCache(
    now,
    options.cachePersistence,
    options.generationStoreFactory,
  );
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
  const offlineRooms = new Set<string>();
  const leaseExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearLeaseTimer = (roomId: string): void => {
    const timer = leaseExpiryTimers.get(roomId);
    if (timer !== undefined) clearTimeout(timer);
    leaseExpiryTimers.delete(roomId);
  };
  const expireOfflineRead = (roomId: string): void => {
    clearLeaseTimer(roomId);
    cache.revokeOfflineRead(roomId);
    offlineRooms.delete(roomId);
    cache.clearRoom(roomId);
    invocations.markRevoked(roomId, "room");
    feed.fatal({ roomId, errorCode: "offline_lease_expired" });
  };
  const scheduleLeaseExpiry = (roomId: string, expiresAtMs: number): void => {
    clearLeaseTimer(roomId);
    const schedule = (): void => {
      const remaining = expiresAtMs - Date.parse(now());
      if (remaining <= 0) {
        expireOfflineRead(roomId);
        return;
      }
      const timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      leaseExpiryTimers.set(roomId, timer);
    };
    schedule();
  };
  const leaseBinding = (
    session: IdentityAuthoritySession,
    authority: Pick<DesktopOfflineReadLeaseClaims, "tenantId" | "serverSubject">,
    room: Pick<DesktopActiveGenerationBinding,
      "roomId" | "lifecycleGeneration" | "accessRevision" | "leaseGeneration">,
  ): DesktopOfflineReadLeaseBinding => {
    if (session.sessionFamilyId === undefined || session.deviceId === undefined ||
        session.installationId === undefined) {
      throw new GovernanceTransportError("authentication_required", 401);
    }
    return {
    tenantId: options.offlineReadLeaseAuthority?.tenantId ?? authority.tenantId,
    accountId: session.accountId,
    actorId: session.actorId,
    sessionFamilyId: session.sessionFamilyId,
    deviceId: session.deviceId,
    installationId: session.installationId,
    serverSubject: options.offlineReadLeaseAuthority?.serverSubject ?? authority.serverSubject,
    roomId: room.roomId,
    lifecycleGeneration: room.lifecycleGeneration,
    accessRevision: room.accessRevision,
    leaseGeneration: room.leaseGeneration,
    };
  };
  const refreshOfflineLease = async (
    roomId: string,
    session: IdentityAuthoritySession,
  ): Promise<void> => {
    const verifier = options.offlineReadLeaseVerifier;
    if (verifier === undefined) return;
    const issued = await transport.issueOfflineReadLease(roomId);
    const verified = verifier.verify(
      issued.token,
      leaseBinding(session, issued.claims, issued.claims.room),
    );
    if (verified.room.roomId !== roomId) throw new GovernanceTransportError("protocol_error");
    cache.installOfflineReadLease(roomId, { token: issued.token, claims: verified });
    const generation = cache.activeGenerationBinding(roomId);
    if (generation === undefined) throw new GovernanceTransportError("protocol_error");
    const generationVerified = verifier.verifyForActiveGeneration(
      issued.token,
      leaseBinding(session, issued.claims, generation),
      generation,
    );
    cache.authorizeOfflineRead(roomId, generationVerified.expiresAtMs);
    scheduleLeaseExpiry(roomId, generationVerified.expiresAtMs);
  };
  const repairAndLease = async (roomId: string, session: IdentityAuthoritySession): Promise<void> => {
    await replica.repairRoom(roomId);
    await refreshOfflineLease(roomId, session);
    offlineRooms.delete(roomId);
  };
  const completePurge = (
    roomIds: readonly string[],
    scope: "room" | "session",
    clear: () => void,
  ): void => {
    for (const roomId of roomIds) clearLeaseTimer(roomId);
    clear();
    for (const roomId of roomIds) {
      invocations.markRevoked(roomId, scope);
      feed.revoked({ roomId, scope, purgeCompleted: false });
    }
    void cache.waitForPersistence().then(() => {
      if (closed) return;
      for (const roomId of roomIds) feed.revoked({ roomId, scope, purgeCompleted: true });
    }).catch(() => {
      if (closed) return;
      for (const roomId of roomIds) feed.fatal({ roomId, errorCode: "authorized_cache_purge_failed" });
    });
  };

  const authority: GovernanceAuthorityAdapter = {
    async querySurface({ roomId }) {
      const session = options.session();
      if (session === undefined) {
        cache.clear();
        let purgeCompleted = false;
        try { await cache.waitForPersistence(); purgeCompleted = true; } catch { /* fail closed below */ }
        return { status: "locked", roomId, connection: {
          status: "revoked", scope: "session", purgeCompleted,
        } };
      }
      try {
        await repairAndLease(roomId, session);
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
          const lease = cache.offlineReadLease(roomId);
          const projection = cache.governanceProjection(roomId);
          const verifier = options.offlineReadLeaseVerifier;
          if (lease === undefined || projection === undefined || verifier === undefined) {
            return { status: "locked", roomId, connection: { status: "offline", asOf: now() } };
          }
          try {
            const generation = cache.activeGenerationBinding(roomId);
            if (generation === undefined) throw new Error("offline generation binding absent");
            const verified = verifier.verifyForActiveGeneration(
              lease.token,
              leaseBinding(session, lease.claims, generation),
              generation,
            );
            if (projection.archiveGeneration !== verified.room.lifecycleGeneration) {
              throw new Error("offline generation mismatch");
            }
            offlineRooms.add(roomId);
            cache.authorizeOfflineRead(roomId, verified.expiresAtMs);
            scheduleLeaseExpiry(roomId, verified.expiresAtMs);
            return { status: "ready", projection, viewerActorId: session.actorId,
              connection: { status: "offline", asOf: cache.updatedAt(roomId) ?? now(),
                leaseExpiresAt: new Date(verified.expiresAtMs).toISOString() } };
          } catch {
            clearLeaseTimer(roomId);
            cache.clearRoom(roomId);
            return { status: "locked", roomId, connection: { status: "offline", asOf: now() } };
          }
        }
        if (authorityError.status === 401 || authorityError.status === 403) {
          if (authorityError.status === 401) cache.clear(); else cache.clearRoom(roomId);
          let purgeCompleted = false;
          try { await cache.waitForPersistence(); purgeCompleted = true; } catch { /* fail closed below */ }
          return { status: "locked", roomId, connection: {
            status: "revoked", scope: authorityError.status === 401 ? "session" : "room", purgeCompleted,
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
      if (offlineRooms.has(command.roomId)) {
        throw new GovernanceAuthorityFailure({ status: 409, code: "room_read_only" });
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
    completePurge(roomIds, "session", () => cache.clear());
  });
  const unsubscribeRoomAccess = transport.onRoomAccessChanged((roomId, change) => {
    if (change === "removed") {
      completePurge([roomId], "room", () => cache.clearRoom(roomId));
      return;
    }
    void replica.repairRoom(roomId).catch(() => {
      cache.clearRoom(roomId);
      feed.fatal({ roomId, errorCode: "repair_unavailable" });
    });
  });
  const unsubscribeFailure = transport.onConnectionFailure(() => {
    const roomIds = cache.roomIds();
    for (const roomId of roomIds) {
      if (cache.isOfflineReadAuthorized(roomId, Date.parse(now()))) {
        invocations.markOffline(roomId);
        feed.offline({ roomId, asOf: now() });
      } else {
        cache.revokeOfflineRead(roomId);
        offlineRooms.delete(roomId);
        invocations.markOffline(roomId);
        feed.offline({ roomId, asOf: now() });
      }
    }
  });

  return Object.freeze({
    controller,
    invocations,
    cache,
    async restoreWorkspace() {
      const session = options.session();
      if (session === undefined) throw new GovernanceTransportError("authentication_required", 401);
      await replica.restoreWorkspace();
      for (const roomId of cache.roomIds()) await refreshOfflineLease(roomId, session);
    },
    async repairRoom(roomId: string) {
      const session = options.session();
      if (session === undefined) throw new GovernanceTransportError("authentication_required", 401);
      await repairAndLease(roomId, session);
    },
    async clearCache(roomId: string) {
      const session = options.session();
      if (session === undefined) throw new GovernanceTransportError("authentication_required", 401);
      for (const cachedRoomId of [...leaseExpiryTimers.keys()]) clearLeaseTimer(cachedRoomId);
      offlineRooms.clear();
      await replica.clearAndRestore(async () => {
        await cache.restore(session.actorId);
      });
      return controller.getSurface({ roomId });
    },
    async restoreCache(actorId: string) {
      const restored = await cache.restore(actorId);
      const session = options.session();
      const verifier = options.offlineReadLeaseVerifier;
      if (!restored || session === undefined || verifier === undefined) return restored;
      for (const roomId of cache.roomIds()) {
        const lease = cache.offlineReadLease(roomId);
        if (lease === undefined) continue;
        try {
          const generation = cache.activeGenerationBinding(roomId);
          if (generation === undefined) throw new Error("offline generation binding absent");
          const verified = verifier.verifyForActiveGeneration(
            lease.token,
            leaseBinding(session, lease.claims, generation),
            generation,
          );
          const projection = cache.governanceProjection(roomId);
          if (projection === undefined ||
              projection.archiveGeneration !== verified.room.lifecycleGeneration) throw new Error();
          cache.authorizeOfflineRead(roomId, verified.expiresAtMs);
          scheduleLeaseExpiry(roomId, verified.expiresAtMs);
        } catch {
          expireOfflineRead(roomId);
        }
      }
      return cache.roomIds().length > 0;
    },
    invalidateAuthorizedState() {
      const roomIds = cache.roomIds();
      transport.resetSession();
      completePurge(roomIds, "session", () => cache.clear());
    },
    close() {
      if (closed) return;
      closed = true;
      for (const roomId of [...leaseExpiryTimers.keys()]) clearLeaseTimer(roomId);
      unsubscribeTerminal(); unsubscribeRoomAccess(); unsubscribeFailure(); controller.close();
      invocations.close();
      replica.close(); transport.close();
      cache.close();
    },
  });
}
