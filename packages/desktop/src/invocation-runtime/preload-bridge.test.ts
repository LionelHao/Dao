import { describe, expect, it, vi } from "vitest";
import { INVOCATION_IPC_CHANNELS } from "./contracts.js";
import { createInvocationBridge } from "./preload-bridge.js";

describe("Invocation preload bridge", () => {
  it("exposes only closed query/control/listener methods", async () => {
    const state = { roomId: "room-1", connection: { status: "online" as const }, executions: [],
      retries: [], cancellations: [], projectBoundaries: [], operations: [] };
    const invoke = vi.fn().mockResolvedValue({ requestId: "request-1", state });
    const on = vi.fn(); const removeListener = vi.fn();
    const bridge = createInvocationBridge({ invoke, on, removeListener });
    expect(Object.keys(bridge).sort()).toEqual(["cancel", "getSurface", "onStateChanged", "retry"]);
    await expect(bridge.cancel({ roomId: "room-1", executionId: "execution-1", expectedVersion: 2 }))
      .resolves.toEqual({ requestId: "request-1", state });
    expect(invoke).toHaveBeenCalledWith(INVOCATION_IPC_CHANNELS.cancel, { roomId: "room-1",
      executionId: "execution-1", expectedVersion: 2 });
    expect(() => bridge.onStateChanged(undefined as never)).toThrow(TypeError);
  });
});
