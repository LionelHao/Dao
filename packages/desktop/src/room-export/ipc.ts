import {
  ROOM_EXPORT_IPC_CHANNELS,
  cloneRoomExportResult,
  isRoomExportClosedError,
  isRoomExportIntent,
  type RoomExportClosedError,
  type RoomExportIntent,
  type RoomExportResult,
} from "./contracts.js";

interface RoomExportIpcEvent {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface RoomExportIpcMain {
  handle(channel: string, handler: (event: RoomExportIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface RoomExportIpcWebContents {
  readonly mainFrame: unknown;
}

export interface RoomExportRuntimePort {
  save(intent: RoomExportIntent): Promise<RoomExportResult>;
}

export class RoomExportIpcError extends Error {
  readonly roomExportError: RoomExportClosedError;
  constructor(error: RoomExportClosedError) {
    super(`Room export failed: ${error.status} ${error.code}`);
    this.name = "RoomExportIpcError";
    this.roomExportError = structuredClone(error);
  }
}

function sanitize(error: unknown): never {
  if (typeof error === "object" && error !== null && "roomExportError" in error &&
      isRoomExportClosedError(error.roomExportError)) {
    throw new RoomExportIpcError(error.roomExportError);
  }
  throw new RoomExportIpcError({ status: 503, code: "storage_unavailable" });
}

export function registerRoomExportIpc(options: Readonly<{
  ipcMain: RoomExportIpcMain;
  webContents: RoomExportIpcWebContents;
  runtime: RoomExportRuntimePort;
}>): () => void {
  const { ipcMain, webContents, runtime } = options;
  ipcMain.handle(ROOM_EXPORT_IPC_CHANNELS.save, async (event, ...args) => {
    if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
      throw new TypeError("Room export IPC requires the trusted main frame");
    }
    if (args.length !== 1 || !isRoomExportIntent(args[0])) {
      throw new TypeError("Invalid Room export intent");
    }
    try {
      return cloneRoomExportResult(await runtime.save(args[0]));
    } catch (error) {
      sanitize(error);
    }
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcMain.removeHandler(ROOM_EXPORT_IPC_CHANNELS.save);
  };
}
