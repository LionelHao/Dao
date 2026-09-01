import { describe, expect, it, vi } from "vitest";

import { ROOM_EXPORT_IPC_CHANNELS } from "./contracts.js";
import { registerRoomExportIpc } from "./ipc.js";

describe("Room export trusted main-frame IPC", () => {
  it("registers one closed method, rejects surplus/path input, sanitizes errors, and cleans up", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)), removeHandler: vi.fn((channel: string) => handlers.delete(channel)) };
    const frame = {};
    const webContents = { mainFrame: frame };
    const runtime = { save: vi.fn(async () => ({ status: "saved" as const, roomId: "room-1" })) };
    const dispose = registerRoomExportIpc({ ipcMain, webContents, runtime });
    expect([...handlers.keys()]).toEqual([ROOM_EXPORT_IPC_CHANNELS.save]);
    const save = handlers.get(ROOM_EXPORT_IPC_CHANNELS.save)!;
    await expect(save({ sender: {}, senderFrame: frame }, { roomId: "room-1" }))
      .rejects.toThrow("trusted main frame");
    await expect(save({ sender: webContents, senderFrame: frame }, {
      roomId: "room-1", path: "/private/export.ndjson",
    })).rejects.toThrow("Invalid Room export intent");
    await expect(save({ sender: webContents, senderFrame: frame }, { roomId: "room-1" }))
      .resolves.toEqual({ status: "saved", roomId: "room-1" });
    runtime.save.mockRejectedValueOnce(Object.assign(new Error("/private/export.ndjson"), {
      roomExportError: { status: 403, code: "room_export_forbidden" },
    }));
    const failure = save({ sender: webContents, senderFrame: frame }, { roomId: "room-1" });
    await expect(failure).rejects.toMatchObject({
      message: "Room export failed: 403 room_export_forbidden",
      roomExportError: { status: 403, code: "room_export_forbidden" },
    });
    await expect(failure).rejects.not.toThrow("/private/export.ndjson");
    dispose(); dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledOnce();
  });
});
