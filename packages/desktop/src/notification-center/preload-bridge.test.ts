import { describe, expect, it, vi } from "vitest";
import { createNotificationCenterPreloadBridge } from "./preload-bridge.js";
import { NOTIFICATION_CENTER_IPC_CHANNELS } from "./contracts.js";

const loading = { status: "loading" as const, recipientActorId: "human-1" };

describe("Notification Center preload bridge", () => {
  it("exposes no generic channel and filters invalid pushed state", async () => {
    const listeners = new Map<string, (event: unknown, input: unknown) => void>();
    const ipc = { invoke: vi.fn(async (channel: string) => channel === NOTIFICATION_CENTER_IPC_CHANNELS.resolveSource
      ? { status: "inaccessible", notificationId: "notification-1" } : loading),
    on: vi.fn((channel: string, listener: (event: unknown, input: unknown) => void) =>
      listeners.set(channel, listener)), removeListener: vi.fn((channel: string) => listeners.delete(channel)) };
    const bridge = createNotificationCenterPreloadBridge(ipc);
    expect(Object.keys(bridge).sort()).toEqual([
      "getState", "list", "markRead", "onStateChanged", "resolveSource", "retryRepair",
    ]);
    await expect(bridge.list({ roomId: null, before: null, limit: 51 })).rejects.toThrow(TypeError);
    await expect(bridge.markRead({ notificationId: "notification-1", expectedReadRevision: 0 }))
      .resolves.toEqual(loading);
    await expect(bridge.resolveSource({ notificationId: "notification-1" })).resolves.toEqual({
      status: "inaccessible", notificationId: "notification-1",
    });
    const observed = vi.fn(); const dispose = bridge.onStateChanged(observed);
    listeners.get(NOTIFICATION_CENTER_IPC_CHANNELS.stateChanged)?.({}, { rawBody: "secret" });
    listeners.get(NOTIFICATION_CENTER_IPC_CHANNELS.stateChanged)?.({}, loading);
    expect(observed).toHaveBeenCalledOnce();
    dispose(); dispose();
    expect(listeners.size).toBe(0);
  });
});
