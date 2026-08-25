import { describe, expect, it, vi } from "vitest";
import { INVOCATION_IPC_CHANNELS } from "./contracts.js";
import { registerInvocationIpc } from "./ipc.js";

const state = { roomId: "room-1", connection: { status: "online" as const }, executions: [],
  retries: [], cancellations: [], projectBoundaries: [], operations: [] };

describe("Invocation closed IPC", () => {
  it("trusts only the main frame, validates input, and forwards canonical envelopes", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)), removeHandler: vi.fn() };
    const webContents = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    let listener: ((value: { roomId: string; state: typeof state }) => void) | undefined;
    const controller = { getSurface: vi.fn().mockResolvedValue(state), cancel: vi.fn()
      .mockResolvedValue({ requestId: "request-1", state }), retry: vi.fn(),
      subscribe: (next: typeof listener) => { listener = next; return vi.fn(); } };
    registerInvocationIpc({ ipcMain, webContents, controller });
    const trusted = { sender: webContents, senderFrame: webContents.mainFrame };
    await expect(handlers.get(INVOCATION_IPC_CHANNELS.cancel)?.(trusted, { roomId: "room-1",
      executionId: "execution-1", expectedVersion: 2 })).resolves.toMatchObject({ requestId: "request-1" });
    expect(controller.cancel).toHaveBeenCalledWith({ roomId: "room-1", executionId: "execution-1",
      expectedVersion: 2 });
    await expect(handlers.get(INVOCATION_IPC_CHANNELS.getSurface)?.(
      { sender: {}, senderFrame: webContents.mainFrame }, { roomId: "room-1" },
    )).rejects.toThrow(/trusted main frame/);
    listener?.({ roomId: "room-1", state });
    expect(webContents.send).toHaveBeenCalledWith(INVOCATION_IPC_CHANNELS.stateChanged,
      { roomId: "room-1", state });
  });
});
