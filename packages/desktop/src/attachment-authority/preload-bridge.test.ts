import { describe, expect, it, vi } from "vitest";

import { ATTACHMENT_AUTHORITY_IPC_CHANNELS } from "./contracts.js";
import { createAttachmentAuthorityBridge } from "./preload-bridge.js";

describe("attachment preload bridge", () => {
  it("is frozen, closed, filters malformed events, and exposes no generic primitive", async () => {
    const listeners = new Map<string, (event: unknown, input: unknown) => void>();
    const ipc = {
      invoke: vi.fn(async (channel: string) => channel === ATTACHMENT_AUTHORITY_IPC_CHANNELS.select
        ? { status: "cancelled" }
        : { operationId: "op-1" }),
      on: vi.fn((channel: string, listener: (event: unknown, input: unknown) => void) => listeners.set(channel, listener)),
      removeListener: vi.fn(),
    };
    const bridge = createAttachmentAuthorityBridge(ipc);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual([
      "cancel", "download", "onAuthorityInput", "preview", "removeSelection", "retryProcessing", "select", "status", "upload",
    ].sort());
    expect(JSON.stringify(bridge)).not.toMatch(/ipcRenderer|invoke|send|token|WebSocket/u);
    await expect(bridge.upload({ type: "attachment.upload", roomId: "room-1", selectionHandle: "h", token: "leak" } as never)).rejects.toThrow();
    await expect(bridge.select()).resolves.toEqual({ status: "cancelled" });

    const listener = vi.fn();
    const dispose = bridge.onAuthorityInput(listener);
    listeners.get(ATTACHMENT_AUTHORITY_IPC_CHANNELS.authorityInput)?.({}, {
      type: "attachment.upload.progress", operationId: "op-1", acknowledgedBytes: 3, totalBytes: 4,
    });
    listeners.get(ATTACHMENT_AUTHORITY_IPC_CHANNELS.authorityInput)?.({}, {
      type: "attachment.upload.progress", operationId: "op-1", acknowledgedBytes: 3, totalBytes: 4, path: "/leak",
    });
    expect(listener).toHaveBeenCalledOnce();
    dispose();
    dispose();
    expect(ipc.removeListener).toHaveBeenCalledOnce();
  });
});
