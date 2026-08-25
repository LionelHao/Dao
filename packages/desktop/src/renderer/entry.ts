import type { IdentityBridge } from "../identity/contracts.js";
import type { GovernanceBridge } from "../governance/contracts.js";
import type { MessageAuthorityBridge } from "../message-authority/contracts.js";
import type { AttachmentAuthorityBridge } from "../attachment-authority/contracts.js";
import type { MemoryAuthorityBridge } from "../memory-authority/contracts.js";
import type { AgentSettingsBridge } from "../agent-profile-routing/contracts.js";
import type { InvocationBridge } from "../invocation-runtime/contracts.js";
import { mountAgentSettingsBridgeSurface } from "./agent-settings/bridge-adapter.js";
import {
  mountGovernanceSurface,
  renderM2PrimitivesPreview,
  renderRoomJoinReview,
  renderVisualSeparationPreview,
} from "./app.js";
import { mountIdentityApp } from "./identity.js";
import { mountMessageAuthorityBridgeSurface } from "./message-authority/bridge-adapter.js";
import { mountDesktopMemoryAuthoritySurface } from "./memory-authority/host-adapter.js";
import { mountInvocationSurface } from "./invocation-runtime/surface.js";

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
  readonly mountMessageAuthoritySurface: (
    root: HTMLElement,
    bridge: MessageAuthorityBridge,
    roomId: string,
    attachmentBridge?: AttachmentAuthorityBridge,
    memoryBridge?: MemoryAuthorityBridge,
  ) => () => void;
  readonly mountMemoryAuthoritySurface?: (
    root: HTMLElement,
    bridge: MemoryAuthorityBridge,
    roomId: string,
  ) => () => void;
  readonly mountAgentSettingsSurface?: (root: HTMLElement, bridge: AgentSettingsBridge,
    roomId: string) => () => void;
  readonly mountInvocationSurface?: (root: HTMLElement, bridge: InvocationBridge,
    roomId: string) => () => void;
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
  mountMessageAuthoritySurface: (
    root: HTMLElement,
    bridge: MessageAuthorityBridge,
    roomId: string,
    attachmentBridge?: AttachmentAuthorityBridge,
    memoryBridge?: MemoryAuthorityBridge,
  ) => mountMessageAuthorityBridgeSurface(root, bridge, roomId, {
    createMessageId: () => `message-${globalThis.crypto.randomUUID()}`,
    createTargetId: () => `target-${globalThis.crypto.randomUUID()}`,
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    ...(attachmentBridge === undefined ? {} : { attachmentBridge }),
    ...(memoryBridge === undefined ? {} : { memoryBridge }),
  }),
  mountMemoryAuthoritySurface: (
    root: HTMLElement,
    bridge: MemoryAuthorityBridge,
    roomId: string,
  ) => mountDesktopMemoryAuthoritySurface(
    root,
    bridge,
    roomId,
    {
      reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    },
  ),
  mountAgentSettingsSurface: (root: HTMLElement, bridge: AgentSettingsBridge, roomId: string) => mountAgentSettingsBridgeSurface(
    root, bridge, roomId, { reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      onClose: () => history.back() }),
  mountInvocationSurface,
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

function messageRoomId(route: URLSearchParams): string | undefined {
  const values = route.getAll("message-room");
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

function renderMessageAuthorityRouteFailure(root: HTMLElement, reason: string): void {
  const error = document.createElement("section");
  error.dataset.messageAuthorityRouteLocked = "true";
  error.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = "无法安全打开 Room 消息";
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
  messageAuthority: MessageAuthorityBridge | undefined,
  ports: DesktopRendererEntryPorts = DEFAULT_PORTS,
  attachmentAuthority?: AttachmentAuthorityBridge,
  memoryAuthority?: MemoryAuthorityBridge,
  agentSettings?: AgentSettingsBridge,
  invocation?: InvocationBridge,
): (() => void) | undefined {
  const route = new URLSearchParams(search);
  root.dataset.governanceRouteContract = "closed-v1";
  root.dataset.messageAuthorityRouteContract = "closed-v2";
  root.dataset.agentSettingsRouteContract = "closed-v1";

  if (route.has("agent-settings-room")) {
    const roomId = (() => { const values = route.getAll("agent-settings-room");
      return values.length === 1 && [...route.keys()].length === 1 && values[0]!.trim() === values[0] &&
        values[0]!.length > 0 ? values[0] : undefined; })();
    if (roomId === undefined || agentSettings === undefined || ports.mountAgentSettingsSurface === undefined) {
      renderGovernanceRouteFailure(root, "Agent Settings bridge 或 Room 标识无效；设置保持锁定。");
      return undefined;
    }
    return ports.mountAgentSettingsSurface(root, agentSettings, roomId);
  }

  if (route.has("message-room")) {
    const roomId = messageRoomId(route);
    if (roomId === undefined) {
      renderMessageAuthorityRouteFailure(root, "Room 标识无效或 route 含未批准参数。");
      return undefined;
    }
    if (messageAuthority === undefined) {
      renderMessageAuthorityRouteFailure(root, "Desktop 消息桥未加载，Room 内容保持锁定。");
      return undefined;
    }
    if (memoryAuthority === undefined || ports.mountMemoryAuthoritySurface === undefined) {
      return attachmentAuthority === undefined
        ? ports.mountMessageAuthoritySurface(root, messageAuthority, roomId)
        : ports.mountMessageAuthoritySurface(root, messageAuthority, roomId, attachmentAuthority);
    }
    const workspace = document.createElement("section");
    workspace.className = "room-authority-workspace";
    workspace.dataset.roomAuthorityWorkspace = "true";
    const timeline = document.createElement("main");
    timeline.className = "room-authority-workspace__timeline";
    const memory = document.createElement("aside");
    memory.className = "room-authority-workspace__memory";
    memory.setAttribute("aria-label", "Room 重要记忆");
    const executions = invocation === undefined || ports.mountInvocationSurface === undefined
      ? undefined : document.createElement("aside");
    if (executions !== undefined) {
      executions.className = "room-authority-workspace__invocations";
      executions.setAttribute("aria-label", "Agent 执行");
      workspace.append(timeline, executions, memory);
    } else workspace.append(timeline, memory);
    root.replaceChildren(workspace);
    const disposeMessage = ports.mountMessageAuthoritySurface(
      timeline,
      messageAuthority,
      roomId,
      attachmentAuthority,
      memoryAuthority,
    );
    const disposeMemory = ports.mountMemoryAuthoritySurface(memory, memoryAuthority, roomId);
    const disposeInvocations = executions === undefined || invocation === undefined ||
      ports.mountInvocationSurface === undefined ? undefined
      : ports.mountInvocationSurface(executions, invocation, roomId);
    return () => {
      disposeInvocations?.();
      disposeMemory();
      disposeMessage();
    };
  }

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
