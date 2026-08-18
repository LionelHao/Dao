import type { IdentityBridge } from "../identity/contracts.js";
import {
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
}

const DEFAULT_PORTS: DesktopRendererEntryPorts = Object.freeze({
  renderM2PrimitivesPreview,
  renderRoomJoinReview,
  renderVisualSeparationPreview,
  mountIdentityApp,
});

export function mountDesktopRendererEntry(
  root: HTMLElement,
  search: string,
  identity: IdentityBridge | undefined,
  ports: DesktopRendererEntryPorts = DEFAULT_PORTS,
): (() => void) | undefined {
  const route = new URLSearchParams(search);

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
