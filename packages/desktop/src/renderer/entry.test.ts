import { describe, expect, it, vi } from "vitest";
import type { IdentityBridge } from "../identity/contracts.js";
import type { GovernanceBridge } from "../governance/contracts.js";
import type { MessageAuthorityBridge } from "../message-authority/contracts.js";
import type { AttachmentAuthorityBridge } from "../attachment-authority/contracts.js";
import type { MemoryAuthorityBridge } from "../memory-authority/contracts.js";
import type { AgentSettingsBridge } from "../agent-profile-routing/contracts.js";
import type { InvocationBridge } from "../invocation-runtime/contracts.js";
import { mountDesktopRendererEntry } from "./entry.js";

const bridge = {} as IdentityBridge;
const governance = {} as GovernanceBridge;
const messageAuthority = {} as MessageAuthorityBridge;
const attachmentAuthority = {} as AttachmentAuthorityBridge;
const memoryAuthority = {} as MemoryAuthorityBridge;
const agentSettings = {} as AgentSettingsBridge;
const invocation = {} as InvocationBridge;

function ports() {
  return {
    renderM2PrimitivesPreview: vi.fn(),
    renderRoomJoinReview: vi.fn(),
    renderVisualSeparationPreview: vi.fn(),
    mountIdentityApp: vi.fn(() => vi.fn()),
    mountGovernanceSurface: vi.fn(() => vi.fn()),
    mountMessageAuthoritySurface: vi.fn(() => vi.fn()),
    mountMemoryAuthoritySurface: vi.fn(() => vi.fn()),
    mountAgentSettingsSurface: vi.fn(() => vi.fn()),
    mountInvocationSurface: vi.fn(() => vi.fn()),
  };
}

describe("Desktop renderer route entry", () => {
  it("mounts the real closed Agent Settings route", () => {
    const root = document.createElement("main"); const renderers = ports();
    mountDesktopRendererEntry(root, "?agent-settings-room=room-1", bridge, governance,
      messageAuthority, renderers, attachmentAuthority, memoryAuthority, agentSettings);
    expect(renderers.mountAgentSettingsSurface).toHaveBeenCalledWith(root, agentSettings, "room-1");
    expect(root.dataset.agentSettingsRouteContract).toBe("closed-v1");
  });
  it.each([
    ["?m2-primitives", "renderM2PrimitivesPreview"],
    ["?join-review", "renderRoomJoinReview"],
    ["?visual-review", "renderVisualSeparationPreview"],
  ] as const)("preserves the %s review route", (search, selected) => {
    const root = document.createElement("main");
    const renderers = ports();
    const dispose = mountDesktopRendererEntry(
      root, search, bridge, governance, messageAuthority, renderers,
    );

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

    const dispose = mountDesktopRendererEntry(
      root, "", bridge, governance, messageAuthority, renderers,
    );

    expect(renderers.mountIdentityApp).toHaveBeenCalledWith(root, bridge);
    expect(dispose).toEqual(expect.any(Function));
    dispose?.();
    expect(expectedDispose).toHaveBeenCalledOnce();
  });

  it("fails closed on the default route when the preload bridge is absent", () => {
    const root = document.createElement("main");
    const renderers = ports();

    const dispose = mountDesktopRendererEntry(
      root, "", undefined, governance, messageAuthority, renderers,
    );

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
      root, "?governance-room=room-1", bridge, governance, messageAuthority, renderers,
    );

    expect(renderers.mountGovernanceSurface).toHaveBeenCalledWith(root, governance, "room-1");
    expect(renderers.mountIdentityApp).not.toHaveBeenCalled();
    expect(root.dataset.governanceRouteContract).toBe("closed-v1");
    expect(dispose).toEqual(expect.any(Function));
    dispose?.();
    expect(expectedDispose).toHaveBeenCalledOnce();
  });

  it.each([
    "?governance-room=", "?governance-room=%20room", "?governance-room=room-1&extra=true",
    "?governance-room=room-1&governance-room=room-2",
  ])("locks malformed or ambiguous Governance route %s", (search) => {
    const root = document.createElement("main");
    const renderers = ports();
    mountDesktopRendererEntry(root, search, bridge, governance, messageAuthority, renderers);
    expect(renderers.mountGovernanceSurface).not.toHaveBeenCalled();
    expect(root.querySelector("[data-governance-route-locked][role='alert']")).not.toBeNull();
  });

  it("locks the Governance route when its preload bridge is absent", () => {
    const root = document.createElement("main");
    const renderers = ports();
    mountDesktopRendererEntry(
      root, "?governance-room=room-1", bridge, undefined, messageAuthority, renderers,
    );
    expect(renderers.mountGovernanceSurface).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Room 内容保持锁定");
  });

  it("mounts the closed Message Authority route with one bounded Room ID", () => {
    const root = document.createElement("main");
    const renderers = ports();
    const expectedDispose = vi.fn();
    renderers.mountMessageAuthoritySurface.mockReturnValue(expectedDispose);

    const dispose = mountDesktopRendererEntry(
      root, "?message-room=room-1", bridge, governance, messageAuthority, renderers,
    );

    expect(renderers.mountMessageAuthoritySurface)
      .toHaveBeenCalledWith(root, messageAuthority, "room-1");
    expect(renderers.mountIdentityApp).not.toHaveBeenCalled();
    expect(root.dataset.messageAuthorityRouteContract).toBe("closed-v2");
    expect(dispose).toBe(expectedDispose);
  });

  it("passes the closed Attachment Authority bridge only to the Message route", () => {
    const root = document.createElement("main");
    const renderers = ports();
    mountDesktopRendererEntry(
      root,
      "?message-room=room-1",
      bridge,
      governance,
      messageAuthority,
      renderers,
      attachmentAuthority,
    );
    expect(renderers.mountMessageAuthoritySurface).toHaveBeenCalledWith(
      root, messageAuthority, "room-1", attachmentAuthority,
    );
  });

  it("mounts Memory Authority in the current Room right rail without blocking chat", () => {
    const root = document.createElement("main");
    const renderers = ports();
    const disposeMessage = vi.fn();
    const disposeMemory = vi.fn();
    renderers.mountMessageAuthoritySurface.mockReturnValue(disposeMessage);
    renderers.mountMemoryAuthoritySurface.mockReturnValue(disposeMemory);
    const dispose = mountDesktopRendererEntry(
      root, "?message-room=room-1", bridge, governance, messageAuthority, renderers,
      undefined, memoryAuthority,
    );
    const timeline = root.querySelector<HTMLElement>(".room-authority-workspace__timeline")!;
    const memory = root.querySelector<HTMLElement>(".room-authority-workspace__memory")!;
    expect(renderers.mountMessageAuthoritySurface).toHaveBeenCalledWith(
      timeline, messageAuthority, "room-1", undefined, memoryAuthority,
    );
    expect(renderers.mountMemoryAuthoritySurface).toHaveBeenCalledWith(
      memory, memoryAuthority, "room-1",
    );
    dispose?.();
    expect(disposeMemory).toHaveBeenCalledOnce();
    expect(disposeMessage).toHaveBeenCalledOnce();
  });

  it("mounts production Invocation authority with reachable host actions", () => {
    const root = document.createElement("main"); const renderers = ports();
    document.body.append(root);
    const disposeInvocation = vi.fn();
    renderers.mountInvocationSurface.mockReturnValue(disposeInvocation);
    const dispose = mountDesktopRendererEntry(
      root, "?message-room=room-1", bridge, governance, messageAuthority, renderers,
      undefined, memoryAuthority, agentSettings, invocation,
    );
    const executionRail = root.querySelector<HTMLElement>(".room-authority-workspace__invocations")!;
    expect(renderers.mountInvocationSurface).toHaveBeenCalledWith(
      executionRail, invocation, "room-1", expect.objectContaining({ onHostAction: expect.any(Function) }),
    );
    const actions = renderers.mountInvocationSurface.mock.calls[0]![3]!;
    actions.onHostAction("review-required", { roomId: "room-1", executionId: "execution-1" });
    const review = root.querySelector<HTMLElement>(
      "[data-invocation-host-handoff='review-required']",
    )!;
    expect(review.getAttribute("role")).toBe("alert");
    expect(review.textContent).toContain("原 toolCall 与普通重试继续关闭");
    expect(review.textContent).toContain("不会伪造 FT-10 审阅结论");
    expect(document.activeElement).toBe(review);

    actions.onHostAction("upgrade-client", { roomId: "room-1", executionId: "execution-1" });
    const update = root.querySelector<HTMLElement>("[data-invocation-host-handoff='upgrade-client']")!;
    expect(update.getAttribute("role")).toBe("alert");
    expect(update.textContent).toContain("部署方批准的客户端更新渠道");
    expect(document.activeElement).toBe(update);

    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    actions.onHostAction("request-access", { roomId: "room-1", executionId: "execution-1" });
    expect(window.location.search).toBe("?governance-room=room-1");
    expect(popstate).toHaveBeenCalledOnce();
    actions.onHostAction("reauthenticate", { roomId: "room-1", executionId: "execution-1" });
    expect(window.location.search).toBe("");
    expect(popstate).toHaveBeenCalledTimes(2);
    window.removeEventListener("popstate", popstate);
    dispose?.();
    expect(disposeInvocation).toHaveBeenCalledOnce();
    root.remove();
  });

  it("remounts the existing Identity and Governance views with route-entry focus", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    const renderers = ports();
    renderers.mountIdentityApp.mockImplementation((identityRoot) => {
      const form = document.createElement("form");
      form.dataset.identityLogin = "true";
      const account = document.createElement("input");
      form.append(account);
      identityRoot.replaceChildren(form);
      return vi.fn();
    });
    renderers.mountGovernanceSurface.mockImplementation((governanceRoot) => {
      const shell = document.createElement("section");
      shell.className = "dao-governance";
      const heading = document.createElement("h1");
      heading.textContent = "Room 访问管理";
      shell.append(heading);
      governanceRoot.replaceChildren(shell);
      return vi.fn();
    });
    let actions: Parameters<NonNullable<typeof renderers.mountInvocationSurface>>[3] | undefined;
    renderers.mountInvocationSurface.mockImplementation((_root, _bridge, _roomId, next) => {
      actions = next;
      return vi.fn();
    });
    let dispose: (() => void) | undefined;
    const render = () => {
      dispose?.();
      dispose = mountDesktopRendererEntry(
        root, window.location.search, bridge, governance, messageAuthority, renderers,
        undefined, memoryAuthority, agentSettings, invocation,
      );
    };
    window.history.replaceState(null, "", "?message-room=room-1");
    window.addEventListener("popstate", render);
    render();

    actions?.onHostAction("request-access", { roomId: "room-1", executionId: "execution-1" });
    await Promise.resolve();
    expect(renderers.mountGovernanceSurface).toHaveBeenCalledWith(root, governance, "room-1");
    expect(document.activeElement).toBe(root.querySelector(".dao-governance h1"));

    actions?.onHostAction("reauthenticate", { roomId: "room-1", executionId: "execution-1" });
    await Promise.resolve();
    expect(renderers.mountIdentityApp).toHaveBeenCalledWith(root, bridge);
    expect(document.activeElement).toBe(root.querySelector("[data-identity-login] input"));

    window.removeEventListener("popstate", render);
    dispose?.();
    root.remove();
  });

  it.each([
    "?message-room=", "?message-room=%20room", "?message-room=room-1&extra=true",
    "?message-room=room-1&message-room=room-2",
  ])("locks malformed or ambiguous Message Authority route %s", (search) => {
    const root = document.createElement("main");
    const renderers = ports();
    mountDesktopRendererEntry(root, search, bridge, governance, messageAuthority, renderers);
    expect(renderers.mountMessageAuthoritySurface).not.toHaveBeenCalled();
    expect(root.querySelector("[data-message-authority-route-locked][role='alert']"))
      .not.toBeNull();
  });

  it("locks the Message Authority route when its preload bridge is absent", () => {
    const root = document.createElement("main");
    const renderers = ports();
    mountDesktopRendererEntry(
      root, "?message-room=room-1", bridge, governance, undefined, renderers,
    );
    expect(renderers.mountMessageAuthoritySurface).not.toHaveBeenCalled();
    expect(root.textContent).toContain("消息桥未加载");
  });

  it("passes the closed Governance preload namespace from the production renderer main", () => {
    const source = readFileSync(resolve(import.meta.dirname, "main.ts"), "utf8");
    expect(source).toContain("window.dao?.governance");
    expect(source).toContain("window.dao?.messageAuthority");
    expect(source).toContain("window.dao?.attachmentAuthority");
    expect(source).toContain("window.dao?.memoryAuthority");
    expect(source).toContain('window.addEventListener("popstate", render)');
    expect(source).toContain("mountDesktopRendererEntry");
    expect(source).not.toMatch(/WebSocket|accessToken|ipcRenderer/u);
  });
});
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
