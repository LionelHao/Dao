import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_IPC_CHANNELS } from "./contracts.js";
import { registerDiagnosticsIpc } from "./ipc.js";

describe("FT-14 diagnostics trusted main-frame IPC", () => {
  it("rejects every renderer argument, sanitizes failures, and disposes its one handler", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)), removeHandler: vi.fn((channel: string) => handlers.delete(channel)) };
    const frame = {};
    const webContents = { mainFrame: frame };
    const runtime = { save: vi.fn(async () => ({ status: "saved" as const })) };
    const dispose = registerDiagnosticsIpc({ ipcMain, webContents, runtime });
    expect([...handlers.keys()]).toEqual([DIAGNOSTICS_IPC_CHANNELS.save]);
    const save = handlers.get(DIAGNOSTICS_IPC_CHANNELS.save)!;
    await expect(save({ sender: {}, senderFrame: frame })).rejects.toThrow("trusted main frame");
    for (const argument of ["/tmp/output", { path: "/tmp/output" }, new Uint8Array([1])]) {
      await expect(save({ sender: webContents, senderFrame: frame }, argument))
        .rejects.toThrow("accepts no renderer arguments");
    }
    await expect(save({ sender: webContents, senderFrame: frame })).resolves.toEqual({ status: "saved" });
    runtime.save.mockRejectedValueOnce(Object.assign(new Error("/private/path-token-canary"), {
      diagnosticsError: { status: 403, code: "administrator_required" },
    }));
    const rejected = save({ sender: webContents, senderFrame: frame });
    await expect(rejected).rejects.toMatchObject({
      message: "Diagnostics save failed: 403 administrator_required",
      diagnosticsError: { status: 403, code: "administrator_required" },
    });
    await expect(rejected).rejects.not.toThrow(/private|canary/u);
    dispose(); dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledOnce();
  });
});
