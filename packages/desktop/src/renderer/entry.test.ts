import { describe, expect, it, vi } from "vitest";
import type { IdentityBridge } from "../identity/contracts.js";
import type { GovernanceBridge } from "../governance/contracts.js";
import { mountDesktopRendererEntry } from "./entry.js";

const bridge = {} as IdentityBridge;
const governance = {} as GovernanceBridge;

function ports() {
  return {
    renderM2PrimitivesPreview: vi.fn(),
    renderRoomJoinReview: vi.fn(),
    renderVisualSeparationPreview: vi.fn(),
    mountIdentityApp: vi.fn(() => vi.fn()),
    mountGovernanceSurface: vi.fn(() => vi.fn()),
  };
}

describe("Desktop renderer route entry", () => {
  it.each([
    ["?m2-primitives", "renderM2PrimitivesPreview"],
    ["?join-review", "renderRoomJoinReview"],
    ["?visual-review", "renderVisualSeparationPreview"],
  ] as const)("preserves the %s review route", (search, selected) => {
    const root = document.createElement("main");
    const renderers = ports();
    const dispose = mountDesktopRendererEntry(root, search, bridge, governance, renderers);

    expect(renderers[selected]).toHaveBeenCalledOnce();
    expect(renderers[selected]).toHaveBeenCalledWith(root);
    expect(renderers.mountIdentityApp).not.toHaveBeenCalled();
    expect(dispose).toBeUndefined();
  });

  it("mounts live Identity only on the default route and returns its disposer", () => {
    const root = document.createElement("main");
    const renderers = ports();
    const expectedDispose = vi.fn();
    renderers.mountIdentityApp.mockReturnValue(expectedDispose);

    const dispose = mountDesktopRendererEntry(root, "", bridge, governance, renderers);

    expect(renderers.mountIdentityApp).toHaveBeenCalledWith(root, bridge);
    expect(dispose).toBe(expectedDispose);
  });

  it("fails closed on the default route when the preload bridge is absent", () => {
    const root = document.createElement("main");
    const renderers = ports();

    const dispose = mountDesktopRendererEntry(root, "", undefined, governance, renderers);

    expect(dispose).toBeUndefined();
    expect(renderers.mountIdentityApp).not.toHaveBeenCalled();
    expect(root.dataset.identityStatus).toBe("fatal");
    expect(root.querySelector("[role='alert']")?.textContent).toContain("无法安全启动");
  });

  it("mounts the closed Governance route with one bounded Room ID", () => {
    const root = document.createElement("main");
    const renderers = ports();
    const expectedDispose = vi.fn();
    renderers.mountGovernanceSurface.mockReturnValue(expectedDispose);

    const dispose = mountDesktopRendererEntry(
      root, "?governance-room=room-1", bridge, governance, renderers,
    );

    expect(renderers.mountGovernanceSurface).toHaveBeenCalledWith(root, governance, "room-1");
    expect(renderers.mountIdentityApp).not.toHaveBeenCalled();
    expect(root.dataset.governanceRouteContract).toBe("closed-v1");
    expect(dispose).toBe(expectedDispose);
  });

  it.each([
    "?governance-room=", "?governance-room=%20room", "?governance-room=room-1&extra=true",
    "?governance-room=room-1&governance-room=room-2",
  ])("locks malformed or ambiguous Governance route %s", (search) => {
    const root = document.createElement("main");
    const renderers = ports();
    mountDesktopRendererEntry(root, search, bridge, governance, renderers);
    expect(renderers.mountGovernanceSurface).not.toHaveBeenCalled();
    expect(root.querySelector("[data-governance-route-locked][role='alert']")).not.toBeNull();
  });

  it("locks the Governance route when its preload bridge is absent", () => {
    const root = document.createElement("main");
    const renderers = ports();
    mountDesktopRendererEntry(root, "?governance-room=room-1", bridge, undefined, renderers);
    expect(renderers.mountGovernanceSurface).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Room 内容保持锁定");
  });

  it("passes the closed Governance preload namespace from the production renderer main", () => {
    const source = readFileSync(resolve(import.meta.dirname, "main.ts"), "utf8");
    expect(source).toContain("window.dao?.governance");
    expect(source).toContain("mountDesktopRendererEntry");
    expect(source).not.toMatch(/WebSocket|accessToken|ipcRenderer/u);
  });
});
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
