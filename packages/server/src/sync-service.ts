import type { RoomSyncResult } from "@native-im/core";
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
}

export interface SyncServiceOptions {
  readonly store: Pick<SyncQueryStore, "syncRoom">;
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
  };
}
