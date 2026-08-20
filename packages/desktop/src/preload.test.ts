import { beforeEach, describe, expect, it, vi } from "vitest";

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

describe("Desktop preload entry", () => {
  beforeEach(() => {
    exposeInMainWorld.mockClear();
  });

  it("exposes one frozen dao namespace containing only closed authority bridges", async () => {
    await import("./preload.js");

    expect(exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, value] = exposeInMainWorld.mock.calls[0] as [string, unknown];
    expect(name).toBe("dao");
    expect(Object.keys(value as object)).toEqual([
      "identity", "governance", "messageAuthority", "attachmentAuthority", "memoryAuthority",
    ]);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys((value as { identity: object }).identity).sort()).toEqual([
      "getState",
      "login",
      "logout",
      "onStateChanged",
      "refreshSessions",
      "revokeSession",
    ]);
    expect(Object.keys((value as { governance: object }).governance).sort()).toEqual([
      "getDepartureConflicts", "getSurface", "onStateChanged", "submit",
    ]);
    expect(Object.keys((value as { messageAuthority: object }).messageAuthority).sort()).toEqual([
      "historyV2", "onAuthorityInput", "recall", "revise", "revisionsQuery", "sendV2",
    ]);
    expect(Object.keys((value as { attachmentAuthority: object }).attachmentAuthority).sort()).toEqual([
      "cancel", "download", "onAuthorityInput", "preview", "removeSelection",
      "retryProcessing", "select", "status", "upload",
    ]);
    expect(Object.keys((value as { memoryAuthority: object }).memoryAuthority).sort()).toEqual([
      "context", "onAuthorityInput", "request",
    ]);
    expect(JSON.stringify(value)).not.toMatch(/token|secret|idempotency|ipcRenderer|shell|filesystem|websocket/iu);
  });
});
