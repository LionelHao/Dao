import type { IdentityBridge } from "../identity/contracts.js";
import type { GovernanceBridge } from "../governance/contracts.js";
import {
  mountGovernanceSurface,
  renderM2PrimitivesPreview,
  renderRoomJoinReview,
  renderVisualSeparationPreview,
} from "./app.js";
import { mountIdentityApp } from "./identity.js";

export interface DesktopRendererEntryPorts {
  readonly renderM2PrimitivesPreview: (root: HTMLElement) => void;
  readonly renderRoomJoinReview: (root: HTMLElement) => void;
  readonly renderVisualSeparationPreview: (root: HTMLElement) => void;
  readonly mountIdentityApp: (root: HTMLElement, bridge: IdentityBridge) => () => void;
  readonly mountGovernanceSurface: (
    root: HTMLElement,
    bridge: GovernanceBridge,
    roomId: string,
  ) => () => void;
}

const DEFAULT_PORTS: DesktopRendererEntryPorts = Object.freeze({
  renderM2PrimitivesPreview,
  renderRoomJoinReview,
  renderVisualSeparationPreview,
  mountIdentityApp,
  mountGovernanceSurface: (root: HTMLElement, bridge: GovernanceBridge, roomId: string) =>
    mountGovernanceSurface(root, bridge, {
      roomId,
      reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      onNavigateConflictResolution: (conflict, resolution) => {
        const notice = document.createElement("p");
        notice.dataset.governanceHostNavigationRequired = "true";
        notice.setAttribute("role", "alert");
        notice.textContent = `未执行 ${resolution}；请由 FT-11 工作区宿主打开 ${conflict.sourceRef}。`;
        root.append(notice);
      },
    }),
});

const encoder = new TextEncoder();
function governanceRoomId(route: URLSearchParams): string | undefined {
  const values = route.getAll("governance-room");
  if (values.length !== 1 || [...route.keys()].length !== 1) return undefined;
  const roomId = values[0]!;
  const printable = Array.from(roomId).every((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint > 31 && codePoint !== 127;
  });
  return roomId === roomId.trim() && encoder.encode(roomId).byteLength <= 256 &&
    printable && roomId.length > 0 ? roomId : undefined;
}

function renderGovernanceRouteFailure(root: HTMLElement, reason: string): void {
  const error = document.createElement("section");
  error.dataset.governanceRouteLocked = "true";
  error.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = "无法安全打开 Room 治理";
  const explanation = document.createElement("p");
  explanation.textContent = reason;
  error.append(heading, explanation);
  root.replaceChildren(error);
}

export function mountDesktopRendererEntry(
  root: HTMLElement,
  search: string,
  identity: IdentityBridge | undefined,
  governance: GovernanceBridge | undefined,
  ports: DesktopRendererEntryPorts = DEFAULT_PORTS,
): (() => void) | undefined {
  const route = new URLSearchParams(search);
  root.dataset.governanceRouteContract = "closed-v1";

  if (route.has("governance-room")) {
    const roomId = governanceRoomId(route);
    if (roomId === undefined) {
      renderGovernanceRouteFailure(root, "Room 标识无效或 route 含未批准参数。");
      return undefined;
    }
    if (governance === undefined) {
      renderGovernanceRouteFailure(root, "Desktop 治理桥未加载，Room 内容保持锁定。");
      return undefined;
    }
    return ports.mountGovernanceSurface(root, governance, roomId);
  }

  if (route.has("m2-primitives")) {
    ports.renderM2PrimitivesPreview(root);
    return undefined;
  }
  if (route.has("join-review")) {
    ports.renderRoomJoinReview(root);
    return undefined;
  }
  if (route.has("visual-review")) {
    ports.renderVisualSeparationPreview(root);
    return undefined;
  }
  if (identity !== undefined) return ports.mountIdentityApp(root, identity);

  const error = document.createElement("section");
  error.className = "identity-shell";
  error.dataset.identityBridgeMissing = "true";
  error.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = "无法安全启动";
  const explanation = document.createElement("p");
  explanation.textContent = "Desktop 身份桥未加载，请重启应用。";
  error.append(heading, explanation);
  root.dataset.identityStatus = "fatal";
  root.replaceChildren(error);
  return undefined;
}
