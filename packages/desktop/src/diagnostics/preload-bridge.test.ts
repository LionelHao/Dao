import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_IPC_CHANNELS } from "./contracts.js";
import { createDiagnosticsBridge } from "./preload-bridge.js";

describe("FT-14 diagnostics preload bridge", () => {
  it("invokes exactly one closed channel with no renderer-controlled value", async () => {
    const ipc = { invoke: vi.fn(async () => ({ status: "saved" })) };
    const bridge = createDiagnosticsBridge(ipc);
    expect(Object.keys(bridge)).toEqual(["save"]);
    await expect(bridge.save()).resolves.toEqual({ status: "saved" });
    expect(ipc.invoke).toHaveBeenCalledWith(DIAGNOSTICS_IPC_CHANNELS.save);
  });
});
