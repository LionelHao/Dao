import { describe, expect, it, vi } from "vitest";
import { registerNotificationCenterIpc } from "./ipc.js";
import { NOTIFICATION_CENTER_IPC_CHANNELS, type NotificationCenterBridge } from "./contracts.js";

const loading = { status: "loading" as const, recipientActorId: "human-1" };

describe("Notification Center IPC", () => {
  it("registers only closed operations and requires the trusted main frame", async () => {
    const handlers = new Map<string, (event: { sender: unknown; senderFrame: unknown },
      ...args: readonly unknown[]) => unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: typeof handlers extends Map<string, infer H> ? H : never) =>
      handlers.set(channel, handler)), removeHandler: vi.fn((channel: string) => handlers.delete(channel)) };
    const sender = {}; const frame = {}; const listeners = new Set<(state: typeof loading) => void>();
    const runtime: NotificationCenterBridge = {
      getState: vi.fn(async () => loading), list: vi.fn(async () => loading),
      markRead: vi.fn(async () => loading),
      resolveSource: vi.fn(async (intent) => ({ status: "inaccessible" as const,
        notificationId: intent.notificationId })),
      retryRepair: vi.fn(async () => loading),
      onStateChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const webContents = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
    const dispose = registerNotificationCenterIpc({ ipcMain, webContents, runtime });
    expect([...handlers.keys()].sort()).toEqual([
      NOTIFICATION_CENTER_IPC_CHANNELS.getState,
      NOTIFICATION_CENTER_IPC_CHANNELS.list,
      NOTIFICATION_CENTER_IPC_CHANNELS.markRead,
      NOTIFICATION_CENTER_IPC_CHANNELS.resolveSource,
      NOTIFICATION_CENTER_IPC_CHANNELS.retryRepair,
    ].sort());
    await expect(handlers.get(NOTIFICATION_CENTER_IPC_CHANNELS.getState)!({ sender, senderFrame: frame }))
      .rejects.toThrow("trusted main frame");
    await expect(handlers.get(NOTIFICATION_CENTER_IPC_CHANNELS.list)!({ sender: webContents,
      senderFrame: frame }, { roomId: null, before: null, limit: 50, recipientActorId: "human-2" }))
      .rejects.toThrow("Invalid notification list query");
    await expect(handlers.get(NOTIFICATION_CENTER_IPC_CHANNELS.markRead)!({ sender: webContents,
      senderFrame: frame }, { notificationId: "notification-1", expectedReadRevision: 0,
      handled: true })).rejects.toThrow("Invalid notification read intent");
    expect(await handlers.get(NOTIFICATION_CENTER_IPC_CHANNELS.resolveSource)!({ sender: webContents,
      senderFrame: frame }, { notificationId: "notification-1" })).toEqual({
      status: "inaccessible", notificationId: "notification-1",
    });
    for (const listener of listeners) listener(loading);
    expect(webContents.send).toHaveBeenCalledWith(NOTIFICATION_CENTER_IPC_CHANNELS.stateChanged, loading);
    dispose(); dispose();
    expect(listeners.size).toBe(0);
    expect(handlers.size).toBe(0);
  });
});
