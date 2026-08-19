import { describe, expect, it, vi } from "vitest";

import { MESSAGE_AUTHORITY_IPC_CHANNELS } from "./contracts.js";
import { registerMessageAuthorityIpc } from "./ipc.js";

describe("Message Authority main IPC allowlist", () => {
  it("registers only trusted exact operations and removes every handler/listener", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };
    const frame = {};
    const webContents = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
    const unsubscribe = vi.fn();
    const controller = {
      historyV2: vi.fn(async () => ({
        type: "room.history.v2", requestId: "history-1", roomId: "room-1",
        status: "locked", connection: { status: "fatal", errorCode: "unavailable" },
      })),
      revisionsQuery: vi.fn(),
      sendV2: vi.fn(() => ({ requestId: "send-1" })),
      revise: vi.fn(() => ({ requestId: "revise-1" })),
      recall: vi.fn(() => ({ requestId: "recall-1" })),
      subscribe: vi.fn(() => unsubscribe),
    };

    const dispose = registerMessageAuthorityIpc({ ipcMain, webContents, controller });
    expect([...handlers.keys()].sort()).toEqual([
      MESSAGE_AUTHORITY_IPC_CHANNELS.historyV2,
      MESSAGE_AUTHORITY_IPC_CHANNELS.recall,
      MESSAGE_AUTHORITY_IPC_CHANNELS.revise,
      MESSAGE_AUTHORITY_IPC_CHANNELS.revisionsQuery,
      MESSAGE_AUTHORITY_IPC_CHANNELS.sendV2,
    ].sort());

    const history = handlers.get(MESSAGE_AUTHORITY_IPC_CHANNELS.historyV2)!;
    await expect(history(
      { sender: webContents, senderFrame: frame },
      { type: "room.history.v2", roomId: "room-1", accessToken: "leak" },
    )).rejects.toThrow("Invalid Message Authority history query");
    await expect(history(
      { sender: {}, senderFrame: frame },
      { type: "room.history.v2", roomId: "room-1" },
    )).rejects.toThrow("trusted main frame");
    await expect(history(
      { sender: webContents, senderFrame: frame },
      { type: "room.history.v2", roomId: "room-1" },
    )).resolves.toMatchObject({ status: "locked" });

    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(5);
  });
});
