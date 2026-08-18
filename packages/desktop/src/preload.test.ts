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

  it("exposes one frozen dao namespace containing only the Identity bridge", async () => {
    await import("./preload.js");

    expect(exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, value] = exposeInMainWorld.mock.calls[0] as [string, unknown];
    expect(name).toBe("dao");
    expect(Object.keys(value as object)).toEqual(["identity"]);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys((value as { identity: object }).identity).sort()).toEqual([
      "getState",
      "login",
      "logout",
      "onStateChanged",
      "refreshSessions",
      "revokeSession",
    ]);
    expect(JSON.stringify(value)).not.toMatch(/token|secret|ipcRenderer|shell|filesystem/u);
  });
});
