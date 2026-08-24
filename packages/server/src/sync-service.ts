import type {
  DeploymentAgentProfileRepairSnapshot,
  DeploymentAgentProfileSyncResult,
  RoomAgentAssignmentRepairSnapshot,
  RoomRepairPage,
  RoomSyncResult,
  SnapshotCompleted,
  SnapshotVersion,
  WorkspaceBootstrapPage,
} from "@native-im/core";
import {
  isDeploymentAgentProfileRepairSnapshot,
  isDeploymentAgentProfileSyncResult,
  isRoomAgentAssignmentRepairSnapshot,
  isSnapshotVersion,
} from "@native-im/core";
import {
  parseRoomSyncRequest,
  ROOM_SYNC_DEFAULT_LIMIT,
  ROOM_SYNC_MAX_LIMIT,
  ROOM_SYNC_MAX_PAGE_BYTES,
  type AuthenticatedSessionContext,
  type SyncQueryStore,
} from "./persistence/contracts.js";

export {
  ROOM_SYNC_DEFAULT_LIMIT,
  ROOM_SYNC_MAX_LIMIT,
  ROOM_SYNC_MAX_PAGE_BYTES,
};

export class SyncServiceError extends Error {
  readonly status = 400 as const;
  readonly code = "invalid_request" as const;

  constructor() {
    super("invalid_request");
    this.name = "SyncServiceError";
  }
}

export interface SyncService {
  syncAgentProfiles(
    context: AuthenticatedSessionContext,
    requestId: string,
    afterSeq?: number,
    limit?: number,
  ): Promise<DeploymentAgentProfileSyncResult>;
  repairAgentProfiles(
    context: AuthenticatedSessionContext,
    requestId: string,
  ): Promise<DeploymentAgentProfileRepairSnapshot>;
  repairRoomAgentAssignments(
    context: AuthenticatedSessionContext,
    requestId: string,
    roomId: string,
  ): Promise<RoomAgentAssignmentRepairSnapshot>;
  syncRoom(
    context: AuthenticatedSessionContext,
    request: unknown,
  ): Promise<RoomSyncResult>;
  beginRoomRepair(
    context: AuthenticatedSessionContext,
    requestId: string,
    roomId: string,
  ): Promise<RoomRepairPage>;
  readRoomRepairPage(
    context: AuthenticatedSessionContext,
    requestId: string,
    snapshotId: string,
    afterPage: number,
  ): Promise<RoomRepairPage>;
  beginWorkspaceBootstrap(
    context: AuthenticatedSessionContext,
    requestId: string,
  ): Promise<WorkspaceBootstrapPage>;
  readWorkspaceBootstrapPage(
    context: AuthenticatedSessionContext,
    requestId: string,
    snapshotId: string,
    afterPage: number,
  ): Promise<WorkspaceBootstrapPage>;
  completeSnapshot(
    context: AuthenticatedSessionContext,
    requestId: string,
    snapshotId: string,
    version: SnapshotVersion,
    checksum: string,
  ): Promise<SnapshotCompleted>;
  releaseSnapshot(
    context: AuthenticatedSessionContext,
    snapshotId: string,
  ): Promise<void>;
}

export interface MaterializedSnapshotStore {
  beginRoomRepair(context: AuthenticatedSessionContext, requestId: string, roomId: string): Promise<RoomRepairPage>;
  readRoomRepairPage(context: AuthenticatedSessionContext, requestId: string,
    snapshotId: string, afterPage: number): Promise<RoomRepairPage>;
  beginWorkspaceBootstrap(context: AuthenticatedSessionContext,
    requestId: string): Promise<WorkspaceBootstrapPage>;
  readWorkspaceBootstrapPage(context: AuthenticatedSessionContext, requestId: string,
    snapshotId: string, afterPage: number): Promise<WorkspaceBootstrapPage>;
  completeSnapshot(context: AuthenticatedSessionContext, requestId: string,
    snapshotId: string, version: SnapshotVersion, checksum: string): Promise<SnapshotCompleted>;
  releaseSnapshot(context: AuthenticatedSessionContext, snapshotId: string): Promise<void>;
}

export interface SyncServiceOptions {
  readonly store: Pick<SyncQueryStore, "syncRoom">;
  readonly snapshots?: MaterializedSnapshotStore;
  readonly agentSettings?: AgentSettingsProjectionSyncStore;
}

/**
 * Authority-owned FT-07 projection port. Implementations must reauthenticate on
 * every operation: deployment sync/repair is Tenant-Administrator-only; Room
 * repair requires current Room membership and can return that Room only.
 */
export interface AgentSettingsProjectionSyncStore {
  syncAgentProfiles(
    context: AuthenticatedSessionContext,
    input: Readonly<{ requestId: string; afterSeq?: number; limit: number }>,
  ): Promise<unknown>;
  repairAgentProfiles(
    context: AuthenticatedSessionContext,
    requestId: string,
  ): Promise<unknown>;
  repairRoomAgentAssignments(
    context: AuthenticatedSessionContext,
    requestId: string,
    roomId: string,
  ): Promise<unknown>;
}

function validText(value: string): boolean {
  return value.trim().length > 0;
}

function snapshotsUnavailable(): Error & { readonly status: number; readonly code: string } {
  const unavailable = new Error("storage_unavailable") as Error & {
    readonly status: number;
    readonly code: string;
  };
  Object.assign(unavailable, { status: 503, code: "storage_unavailable" });
  return unavailable;
}

function closedProjection<TResult>(value: unknown, guard: (candidate: unknown) => candidate is TResult): TResult {
  if (!guard(value)) throw snapshotsUnavailable();
  return value;
}

export function createSyncService(options: SyncServiceOptions): SyncService {
  return {
    async syncAgentProfiles(context, requestId, afterSeq, limit = 100) {
      if (!validText(requestId) || (afterSeq !== undefined &&
          (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) || !Number.isSafeInteger(limit) ||
          limit < 1 || limit > 256) throw new SyncServiceError();
      if (options.agentSettings === undefined) throw snapshotsUnavailable();
      const result = closedProjection(await options.agentSettings.syncAgentProfiles(context, {
        requestId,
        ...(afterSeq === undefined ? {} : { afterSeq }),
        limit,
      }), isDeploymentAgentProfileSyncResult);
      if (result.requestId !== requestId) throw snapshotsUnavailable();
      if (afterSeq === undefined) {
        if (result.mode !== "repair_required" || result.reason !== "cursor_absent") {
          throw snapshotsUnavailable();
        }
      } else if (result.mode === "repair_required") {
        if (result.reason === "cursor_absent") throw snapshotsUnavailable();
      } else if (result.nextCursor !== afterSeq + result.events.length ||
          result.watermark < afterSeq) {
        throw snapshotsUnavailable();
      }
      return result;
    },
    async repairAgentProfiles(context, requestId) {
      if (!validText(requestId)) throw new SyncServiceError();
      if (options.agentSettings === undefined) throw snapshotsUnavailable();
      const result = closedProjection(
        await options.agentSettings.repairAgentProfiles(context, requestId),
        isDeploymentAgentProfileRepairSnapshot,
      );
      if (result.requestId !== requestId) throw snapshotsUnavailable();
      return result;
    },
    async repairRoomAgentAssignments(context, requestId, roomId) {
      if (!validText(requestId) || !validText(roomId)) throw new SyncServiceError();
      if (options.agentSettings === undefined) throw snapshotsUnavailable();
      const result = closedProjection(
        await options.agentSettings.repairRoomAgentAssignments(context, requestId, roomId),
        isRoomAgentAssignmentRepairSnapshot,
      );
      if (result.requestId !== requestId || result.roomId !== roomId) throw snapshotsUnavailable();
      return result;
    },
    syncRoom(context, value): Promise<RoomSyncResult> {
      const parsed = parseRoomSyncRequest(value);
      if (
        !parsed.ok ||
        (parsed.value.cursor !== undefined &&
          parsed.value.cursor.roomId !== parsed.value.roomId)
      ) {
        return Promise.reject(new SyncServiceError());
      }
      return options.store.syncRoom(context, parsed.value);
    },
    beginRoomRepair(context, requestId, roomId): Promise<RoomRepairPage> {
      if (!validText(requestId) || !validText(roomId)) {
        return Promise.reject(new SyncServiceError());
      }
      return options.snapshots === undefined
        ? Promise.reject(snapshotsUnavailable())
        : options.snapshots.beginRoomRepair(context, requestId, roomId);
    },
    readRoomRepairPage(context, requestId, snapshotId, afterPage): Promise<RoomRepairPage> {
      if (!validText(requestId) || !validText(snapshotId) ||
          !Number.isSafeInteger(afterPage) || afterPage < 0) {
        return Promise.reject(new SyncServiceError());
      }
      return options.snapshots === undefined
        ? Promise.reject(snapshotsUnavailable())
        : options.snapshots.readRoomRepairPage(context, requestId, snapshotId, afterPage);
    },
    beginWorkspaceBootstrap(context, requestId): Promise<WorkspaceBootstrapPage> {
      if (!validText(requestId)) return Promise.reject(new SyncServiceError());
      return options.snapshots === undefined
        ? Promise.reject(snapshotsUnavailable())
        : options.snapshots.beginWorkspaceBootstrap(context, requestId);
    },
    readWorkspaceBootstrapPage(context, requestId, snapshotId, afterPage): Promise<WorkspaceBootstrapPage> {
      if (!validText(requestId) || !validText(snapshotId) ||
          !Number.isSafeInteger(afterPage) || afterPage < 0) {
        return Promise.reject(new SyncServiceError());
      }
      return options.snapshots === undefined
        ? Promise.reject(snapshotsUnavailable())
        : options.snapshots.readWorkspaceBootstrapPage(
            context, requestId, snapshotId, afterPage,
          );
    },
    completeSnapshot(context, requestId, snapshotId, version, checksum): Promise<SnapshotCompleted> {
      if (!validText(requestId) || !validText(snapshotId) || !validText(checksum) ||
          !isSnapshotVersion(version)) {
        return Promise.reject(new SyncServiceError());
      }
      return options.snapshots === undefined
        ? Promise.reject(snapshotsUnavailable())
        : options.snapshots.completeSnapshot(context, requestId, snapshotId, version, checksum);
    },
    releaseSnapshot(context, snapshotId): Promise<void> {
      if (!validText(snapshotId)) return Promise.reject(new SyncServiceError());
      return options.snapshots === undefined
        ? Promise.reject(snapshotsUnavailable())
        : options.snapshots.releaseSnapshot(context, snapshotId);
    },
  };
}
