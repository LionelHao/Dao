import type { MessageAuthorityWireTransport } from "../message-authority/websocket-authority.js";
import type { RoomExportStreamTransport } from "./runtime.js";
import type {
  RoomExportAbortCommand,
  RoomExportOpenCommand,
  RoomExportReadCommand,
} from "./stream-contracts.js";

/** Reuses the one authenticated Message Authority socket; it owns no connection or event bus. */
export function createRoomExportWebSocketTransport(
  transport: Pick<MessageAuthorityWireTransport,
    "roomExportOpen" | "roomExportRead" | "roomExportAbort">,
): RoomExportStreamTransport {
  return Object.freeze({
    open: (command: RoomExportOpenCommand) => transport.roomExportOpen(command),
    read: (command: RoomExportReadCommand) => transport.roomExportRead(command),
    abort: (command: RoomExportAbortCommand) => transport.roomExportAbort(command),
  });
}
