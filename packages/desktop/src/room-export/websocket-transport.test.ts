import { describe, expect, it, vi } from "vitest";

import { createRoomExportWebSocketTransport } from "./websocket-transport.js";

describe("Room export same-socket transport adapter", () => {
  it("delegates only the three closed RPCs to Message Authority", async () => {
    const shared = {
      roomExportOpen: vi.fn(async (command) => ({ type: "room-export.opened" as const,
        requestId: command.requestId, streamId: "stream-1", roomId: command.roomId,
        chunkSize: 65_536 as const })),
      roomExportRead: vi.fn(async (command) => ({ type: "room-export.chunk" as const,
        requestId: command.requestId, streamId: command.streamId, offset: command.offset,
        byteLength: 0, base64: "", eof: true })),
      roomExportAbort: vi.fn(async (command) => ({ type: "room-export.aborted" as const,
        requestId: command.requestId, streamId: command.streamId })),
    };
    const transport = createRoomExportWebSocketTransport(shared);
    expect(Object.keys(transport)).toEqual(["open", "read", "abort"]);
    await transport.open({ type: "room-export.open", requestId: "open-1", roomId: "room-1" });
    await transport.read({ type: "room-export.read", requestId: "read-1",
      streamId: "stream-1", offset: 0 });
    await transport.abort({ type: "room-export.abort", requestId: "abort-1", streamId: "stream-1" });
    expect(shared.roomExportOpen).toHaveBeenCalledOnce();
    expect(shared.roomExportRead).toHaveBeenCalledOnce();
    expect(shared.roomExportAbort).toHaveBeenCalledOnce();
  });
});
