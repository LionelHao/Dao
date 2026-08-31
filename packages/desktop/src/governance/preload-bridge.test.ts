import { describe, expect, it, vi } from "vitest";
import { createGovernanceBridge } from "./preload-bridge.js";
import { GOVERNANCE_IPC_CHANNELS } from "./contracts.js";

describe("Governance preload bridge", () => {
  it("exposes only closed methods, rejects extra authority material, and bounds subscription cleanup", async () => {
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const ipc = {
      invoke: vi.fn(async () => ({
        status: "locked", roomId: "room-1", connection: { status: "fatal", errorCode: "unavailable" },
      })),
      on: vi.fn((channel: string, listener: (event: unknown, value: unknown) => void) => listeners.set(channel, listener)),
      removeListener: vi.fn(),
    };
    const bridge = createGovernanceBridge(ipc);
    expect(Object.keys(bridge).sort()).toEqual([
      "clearCache", "getDepartureConflicts", "getSurface", "onStateChanged", "submit",
    ]);
    await expect(bridge.getSurface({ roomId: "room-1", token: "forbidden" } as never))
      .rejects.toThrow("Invalid Governance surface query");
    await expect(bridge.getSurface({ roomId: "room-1" })).resolves.toMatchObject({ status: "locked" });
    expect(ipc.invoke).toHaveBeenCalledWith(GOVERNANCE_IPC_CHANNELS.getSurface, { roomId: "room-1" });
    await expect(bridge.clearCache({ roomId: "room-1" })).resolves.toMatchObject({ status: "locked" });
    expect(ipc.invoke).toHaveBeenCalledWith(GOVERNANCE_IPC_CHANNELS.clearCache, { roomId: "room-1" });
    const callback = vi.fn();
    const close = bridge.onStateChanged(callback);
    listeners.get(GOVERNANCE_IPC_CHANNELS.stateChanged)?.({}, { token: "leak" });
    expect(callback).not.toHaveBeenCalled();
    close();
    close();
    expect(ipc.removeListener).toHaveBeenCalledOnce();
  });
});
