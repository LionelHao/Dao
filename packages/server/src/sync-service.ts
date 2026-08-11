import type {
  RoomRepairPage,
  RoomSyncResult,
  WorkspaceBootstrapPage,
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
}

export interface MaterializedSnapshotStore {
  beginRoomRepair(context: AuthenticatedSessionContext, requestId: string, roomId: string): Promise<RoomRepairPage>;
  readRoomRepairPage(context: AuthenticatedSessionContext, requestId: string,
    snapshotId: string, afterPage: number): Promise<RoomRepairPage>;
  beginWorkspaceBootstrap(context: AuthenticatedSessionContext,
    requestId: string): Promise<WorkspaceBootstrapPage>;
  readWorkspaceBootstrapPage(context: AuthenticatedSessionContext, requestId: string,
    snapshotId: string, afterPage: number): Promise<WorkspaceBootstrapPage>;
}

export interface SyncServiceOptions {
  readonly store: Pick<SyncQueryStore, "syncRoom">;
  readonly snapshots?: MaterializedSnapshotStore;
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

export function createSyncService(options: SyncServiceOptions): SyncService {
  return {
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
  };
}
