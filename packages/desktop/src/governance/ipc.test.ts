import { describe, expect, it, vi } from "vitest";
import { registerGovernanceIpc } from "./ipc.js";
import { GOVERNANCE_IPC_CHANNELS } from "./contracts.js";

describe("Governance main IPC allowlist", () => {
  it("accepts only the trusted frame and exact closed payloads, then removes every handler", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };
    const frame = {};
    const webContents = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
    const unsubscribe = vi.fn();
    const controller = {
      getSurface: vi.fn(async () => ({ status: "locked", roomId: "room-1", connection: { status: "fatal", errorCode: "unavailable" } })),
      getDepartureConflicts: vi.fn(), submit: vi.fn(), subscribe: vi.fn(() => unsubscribe),
    };
    const clearCache = vi.fn(async () => ({ status: "locked" as const, roomId: "room-1",
      connection: { status: "fatal" as const, errorCode: "unavailable" } }));
    const dispose = registerGovernanceIpc({ ipcMain, webContents, controller, clearCache });
    expect([...handlers.keys()].sort()).toEqual([
      GOVERNANCE_IPC_CHANNELS.getDepartureConflicts,
      GOVERNANCE_IPC_CHANNELS.getSurface,
      GOVERNANCE_IPC_CHANNELS.clearCache,
      GOVERNANCE_IPC_CHANNELS.submit,
    ].sort());
    const get = handlers.get(GOVERNANCE_IPC_CHANNELS.getSurface)!;
    await expect(get({ sender: webContents, senderFrame: frame }, { roomId: "room-1", token: "leak" }))
      .rejects.toThrow("Invalid Governance surface query");
    await expect(get({ sender: {}, senderFrame: frame }, { roomId: "room-1" }))
      .rejects.toThrow("trusted main frame");
    await expect(get({ sender: webContents, senderFrame: frame }, { roomId: "room-1" }))
      .resolves.toMatchObject({ status: "locked" });
    const clear = handlers.get(GOVERNANCE_IPC_CHANNELS.clearCache)!;
    await expect(clear({ sender: webContents, senderFrame: frame }, { roomId: "room-1" }))
      .resolves.toMatchObject({ status: "locked" });
    expect(clearCache).toHaveBeenCalledWith("room-1");
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(4);
  });
});
