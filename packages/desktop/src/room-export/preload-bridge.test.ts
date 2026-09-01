import { describe, expect, it, vi } from "vitest";

import { ROOM_EXPORT_IPC_CHANNELS } from "./contracts.js";
import { createRoomExportBridge } from "./preload-bridge.js";

describe("Room export preload bridge", () => {
  it("is frozen and exposes one domain method with no generic IPC/fs/path/binary primitive", async () => {
    const ipc = { invoke: vi.fn(async () => ({ status: "saved", roomId: "room-1" })) };
    const bridge = createRoomExportBridge(ipc);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge)).toEqual(["save"]);
    await expect(bridge.save({ roomId: "room-1" })).resolves.toEqual({
      status: "saved", roomId: "room-1",
    });
    expect(ipc.invoke).toHaveBeenCalledWith(ROOM_EXPORT_IPC_CHANNELS.save, { roomId: "room-1" });
    for (const intent of [
      { roomId: "room-1", path: "/private/export" },
      { roomId: "room-1", url: "file:///private/export" },
      { roomId: "room-1", bytes: new Uint8Array([1]) },
    ]) await expect(bridge.save(intent as never)).rejects.toThrow("Invalid Room export intent");
    expect(JSON.stringify(bridge)).not.toMatch(/ipcRenderer|invoke|send|path|url|bytes|buffer|fs|shell/iu);
  });
});
