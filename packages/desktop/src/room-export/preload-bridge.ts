import {
  ROOM_EXPORT_IPC_CHANNELS,
  cloneRoomExportResult,
  isRoomExportIntent,
  type RoomExportBridge,
  type RoomExportIntent,
} from "./contracts.js";

export interface RoomExportIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
}

export function createRoomExportBridge(ipc: RoomExportIpcRenderer): RoomExportBridge {
  return Object.freeze({
    async save(intent: RoomExportIntent) {
      if (!isRoomExportIntent(intent)) throw new TypeError("Invalid Room export intent");
      return cloneRoomExportResult(await ipc.invoke(ROOM_EXPORT_IPC_CHANNELS.save, intent));
    },
  });
}
