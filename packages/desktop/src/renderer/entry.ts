import type { IdentityBridge } from "../identity/contracts.js";
import type { GovernanceBridge } from "../governance/contracts.js";
import type { MessageAuthorityBridge } from "../message-authority/contracts.js";
import type { AttachmentAuthorityBridge } from "../attachment-authority/contracts.js";
import type { MemoryAuthorityBridge } from "../memory-authority/contracts.js";
import type { AgentSettingsBridge } from "../agent-profile-routing/contracts.js";
import type { InvocationBridge } from "../invocation-runtime/contracts.js";
import type { ProjectLoopBridge } from "../project-loop/contracts.js";
import type { ToolSafetyBridge } from "../tool-safety/contracts.js";
import type { NotificationCenterBridge } from "../notification-center/contracts.js";
import type { RoomExportBridge } from "../room-export/contracts.js";
import type { DiagnosticsBridge } from "../diagnostics/contracts.js";
import type { NotificationToolResultActionBridge } from
  "../notification-center/tool-result-action-contracts.js";
import type { NotificationExecutionResultActionBridge } from
  "../notification-center/execution-result-action-contracts.js";
import {
  mountNotificationCenterShell,
  type NotificationDeepLinkTarget,
} from "./notification-center/host-adapter.js";
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
import {
  mountInvocationSurface,
  type InvocationHostAction,
  type InvocationSurfaceActions,
} from "./invocation-runtime/surface.js";
import { mountProjectLoopBridgeSurface } from "./project-loop/bridge-adapter.js";
import { mountToolSafetyBridgeSurface } from "./tool-safety/bridge-adapter.js";

export interface DesktopRendererEntryPorts {
  readonly renderM2PrimitivesPreview: (root: HTMLElement) => void;
  readonly renderRoomJoinReview: (root: HTMLElement) => void;
  readonly renderVisualSeparationPreview: (root: HTMLElement) => void;
  readonly mountIdentityApp: (root: HTMLElement, bridge: IdentityBridge) => () => void;
  readonly mountGovernanceSurface: (
    root: HTMLElement,
    bridge: GovernanceBridge,
    roomId: string,
    roomExport?: RoomExportBridge,
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
    roomId: string, diagnostics?: DiagnosticsBridge) => () => void;
  readonly mountInvocationSurface?: (root: HTMLElement, bridge: InvocationBridge,
    roomId: string, actions: InvocationSurfaceActions) => () => void;
  readonly mountProjectLoopSurface?: (
    root: HTMLElement,
    bridge: ProjectLoopBridge,
    roomId: string,
    messageBridge?: MessageAuthorityBridge,
  ) => () => void;
  readonly mountToolSafetySurface?: (
    root: HTMLElement,
    bridge: ToolSafetyBridge,
    roomId: string,
    actions: { openSource(sourceRef: string): void; newInvocation(): void; reauthenticate(): void },
  ) => () => void;
  readonly mountNotificationCenterShell?: (options: Readonly<{
    workspace: HTMLElement;
    bridge: NotificationCenterBridge;
    toolResultAction: NotificationToolResultActionBridge;
    executionResultAction: NotificationExecutionResultActionBridge;
    roomId: string;
    onDeepLink(target: NotificationDeepLinkTarget): void;
    onReauthenticate(): void;
  }>) => () => void;
}

const DEFAULT_PORTS: DesktopRendererEntryPorts = Object.freeze({
  renderM2PrimitivesPreview,
  renderRoomJoinReview,
  renderVisualSeparationPreview,
  mountIdentityApp,
  mountGovernanceSurface: (root: HTMLElement, bridge: GovernanceBridge, roomId: string,
    roomExport?: RoomExportBridge) =>
    mountGovernanceSurface(root, bridge, {
      roomId,
      ...(roomExport === undefined ? {} : { roomExport }),
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
  mountAgentSettingsSurface: (root: HTMLElement, bridge: AgentSettingsBridge, roomId: string,
    diagnostics?: DiagnosticsBridge) => mountAgentSettingsBridgeSurface(
    root, bridge, roomId, { reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      onClose: () => history.back(),
      ...(diagnostics === undefined ? {} : { diagnostics }) }),
  mountInvocationSurface,
  mountProjectLoopSurface: (root: HTMLElement, bridge: ProjectLoopBridge, roomId: string,
    messageBridge?: MessageAuthorityBridge) => mountProjectLoopBridgeSurface(
    root, bridge, roomId, {
      reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      onSearch: () => root.querySelector<HTMLInputElement>("input[type='search']")?.focus(),
      onNavigateSegment: (segment) => {
        const selector = segment === "timeline" ? ".room-authority-workspace__timeline"
          : segment === "project" ? ".room-authority-workspace__project"
            : ".room-authority-workspace__memory";
        const workspace = root.closest<HTMLElement>(".room-authority-workspace");
        if (workspace !== null) workspace.dataset.compactSegment = segment === "timeline" ? "timeline" : "project";
        const target = workspace?.querySelector<HTMLElement>(selector);
        if (target !== null && target !== undefined) { target.tabIndex = -1; target.focus(); }
      },
      onReauthenticate: () => navigateRenderer(""),
      ...(messageBridge === undefined ? {} : { messageBridge }),
    },
    ),
  mountToolSafetySurface: mountToolSafetyBridgeSurface,
  mountNotificationCenterShell,
});

const encoder = new TextEncoder();
const ROUTE_FOCUS_SELECTORS = Object.freeze({
  identity: [
    "[data-identity-login] input:not(:disabled)",
    ".identity-shell [role='alert']",
    ".identity-shell h1",
  ],
  governance: [
    ".dao-governance h1",
    "[data-governance-locked] h1",
    "[data-governance-route-locked] h1",
  ],
});

function focusRouteEntry(
  root: HTMLElement,
  selectors: readonly string[],
): () => void {
  let stopped = false;
  const focus = (): boolean => {
    if (stopped) return false;
    const target = selectors.map((selector) => root.querySelector<HTMLElement>(selector))
      .find((element) => element !== null);
    if (target === undefined || target === null) return false;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLButtonElement) &&
        !(target instanceof HTMLSelectElement) && !(target instanceof HTMLTextAreaElement) &&
        !target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus();
    return true;
  };
  const observer = new MutationObserver(() => {
    if (focus()) observer.disconnect();
  });
  observer.observe(root, { childList: true, subtree: true });
  queueMicrotask(() => {
    if (focus()) observer.disconnect();
  });
  return () => {
    stopped = true;
    observer.disconnect();
  };
}

function navigateRenderer(search: string, hash = ""): void {
  const url = new URL(window.location.href);
  url.search = search;
  url.hash = hash;
  window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

function showInvocationHostHandoff(
  workspace: HTMLElement,
  executions: HTMLElement,
  action: Extract<InvocationHostAction, "upgrade-client" | "review-required">,
  executionId: string,
): void {
  let handoff = workspace.querySelector<HTMLElement>("[data-invocation-host-handoff]");
  if (handoff === null) {
    handoff = document.createElement("section");
    handoff.className = "invocation-host-handoff";
    handoff.dataset.invocationHostHandoff = action;
    handoff.tabIndex = -1;
    workspace.prepend(handoff);
  }
  handoff.dataset.invocationHostHandoff = action;
  handoff.setAttribute("role", "alert");
  const heading = document.createElement("h2");
  const explanation = document.createElement("p");
  if (action === "upgrade-client") {
    heading.textContent = "需要更新客户端";
    explanation.textContent =
      "当前客户端不能安全消费此协议版本。请通过部署方批准的客户端更新渠道安装新版；此入口不会伪装成已经更新。";
  } else {
    heading.textContent = "人工审阅仍待权威入口接入";
    explanation.textContent =
      `执行 ${executionId} 仍保持 needs_review，原 toolCall 与普通重试继续关闭。` +
      "当前 Desktop 不会伪造 FT-10 审阅结论；请等待权威 review 接线或联系 Room owner。";
  }
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "返回执行详情";
  back.addEventListener("click", () => {
    handoff?.remove();
    const card = [...executions.querySelectorAll<HTMLElement>("[data-execution-id]")]
      .find((element) => element.dataset.executionId === executionId);
    card?.focus();
  });
  handoff.replaceChildren(heading, explanation, back);
  handoff.focus();
}

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
  projectLoop?: ProjectLoopBridge,
  toolSafety?: ToolSafetyBridge,
  notificationCenter?: NotificationCenterBridge,
  notificationToolResult?: NotificationToolResultActionBridge,
  notificationExecutionResult?: NotificationExecutionResultActionBridge,
  roomExport?: RoomExportBridge,
  diagnostics?: DiagnosticsBridge,
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
    return diagnostics === undefined
      ? ports.mountAgentSettingsSurface(root, agentSettings, roomId)
      : ports.mountAgentSettingsSurface(root, agentSettings, roomId, diagnostics);
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
    let authorityRail: HTMLElement | undefined;
    const project = projectLoop === undefined || ports.mountProjectLoopSurface === undefined
      ? undefined : document.createElement("aside");
    if (project !== undefined) {
      project.className = "room-authority-workspace__project";
      project.setAttribute("aria-label", "Room Project");
      workspace.dataset.compactSegment = "timeline";
      const segments = document.createElement("nav");
      segments.className = "room-authority-workspace__segments";
      segments.setAttribute("aria-label", "最小窗口内容分段");
      for (const [value, label] of [["timeline", "时间线"], ["project", "项目"]] as const) {
        const segment = document.createElement("button"); segment.type = "button"; segment.textContent = label;
        segment.dataset.compactSegmentTarget = value;
        segment.setAttribute("aria-pressed", String(value === "timeline"));
        segment.addEventListener("click", () => {
          workspace.dataset.compactSegment = value;
          for (const candidate of segments.querySelectorAll<HTMLButtonElement>("button")) {
            candidate.setAttribute("aria-pressed", String(candidate === segment));
          }
          const destination = workspace.querySelector<HTMLElement>(value === "timeline"
            ? ".room-authority-workspace__timeline" : ".room-authority-workspace__rail");
          if (destination !== null) { destination.tabIndex = -1; destination.focus(); }
        });
        segments.append(segment);
      }
      workspace.append(segments);
    }
    const executions = invocation === undefined || ports.mountInvocationSurface === undefined
      ? undefined : document.createElement("aside");
    const tools = toolSafety === undefined || ports.mountToolSafetySurface === undefined
      ? undefined : document.createElement("aside");
    if (tools !== undefined) {
      tools.className = "room-authority-workspace__tools";
      tools.setAttribute("aria-label", "Agent 工具安全");
    }
    if (executions !== undefined) {
      executions.className = "room-authority-workspace__invocations";
      executions.setAttribute("aria-label", "Agent 执行");
      if (project === undefined) workspace.append(timeline, executions, memory);
    } else if (project === undefined) workspace.append(timeline, memory);
    if (project !== undefined) {
      authorityRail = document.createElement("aside");
      authorityRail.className = "room-authority-workspace__rail";
      authorityRail.dataset.authorityRail = "project";
      authorityRail.setAttribute("aria-label", "项目、记忆与 Agent 面板");
      authorityRail.tabIndex = -1;
      const railTabs = document.createElement("div");
      railTabs.className = "room-authority-workspace__rail-tabs";
      railTabs.setAttribute("role", "tablist");
      railTabs.setAttribute("aria-label", "Room 权威面板");
      const panels: Array<readonly ["project" | "memory" | "agent" | "tool", string, HTMLElement]> = [
        ["project", "项目", project],
        ["memory", "记忆", memory],
      ];
      if (executions !== undefined) panels.push(["agent", "Agent", executions]);
      if (tools !== undefined) panels.push(["tool", "工具安全", tools]);
      const selectRail = (selected: string, focus = false): void => {
        authorityRail!.dataset.authorityRail = selected;
        for (const [value, , panel] of panels) {
          const active = value === selected;
          panel.hidden = !active;
          panel.setAttribute("aria-hidden", String(!active));
        }
        for (const candidate of railTabs.querySelectorAll<HTMLButtonElement>("[role='tab']")) {
          const active = candidate.dataset.authorityRailTab === selected;
          candidate.setAttribute("aria-selected", String(active)); candidate.tabIndex = active ? 0 : -1;
          if (active && focus) candidate.focus();
        }
      };
      for (const [value, label, panel] of panels) {
        panel.id = `room-authority-${roomId}-${value}`;
        panel.setAttribute("role", "tabpanel");
        const tab = document.createElement("button"); tab.type = "button"; tab.textContent = label;
        tab.dataset.authorityRailTab = value; tab.id = `${panel.id}-tab`; tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", panel.id); panel.setAttribute("aria-labelledby", tab.id);
        tab.addEventListener("click", () => selectRail(value)); railTabs.append(tab);
      }
      railTabs.addEventListener("keydown", (event) => {
        const tabs = [...railTabs.querySelectorAll<HTMLButtonElement>("[role='tab']")];
        const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
        if (current < 0) return;
        const next = event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length
          : event.key === "ArrowRight" ? (current + 1) % tabs.length : event.key === "Home" ? 0
            : event.key === "End" ? tabs.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); tabs[next]?.click(); tabs[next]?.focus(); }
      });
      authorityRail.append(railTabs, ...panels.map(([, , panel]) => panel));
      selectRail("project");
      workspace.append(timeline, authorityRail);
    }
    root.replaceChildren(workspace);
    const disposeMessage = ports.mountMessageAuthoritySurface(
      timeline,
      messageAuthority,
      roomId,
      attachmentAuthority,
      memoryAuthority,
    );
    const disposeMemory = ports.mountMemoryAuthoritySurface(memory, memoryAuthority, roomId);
    const disposeProject = project === undefined || projectLoop === undefined ||
      ports.mountProjectLoopSurface === undefined ? undefined
      : ports.mountProjectLoopSurface(project, projectLoop, roomId, messageAuthority);
    const openSource = (sourceRef: string): void => {
      const source = [...timeline.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((candidate) => candidate.dataset.messageId === sourceRef) ?? null;
      if (source !== null) { source.tabIndex = -1; source.focus(); source.dataset.sourceHighlighted = "true"; }
      else {
        const notice = document.createElement("p"); notice.setAttribute("role", "alert");
        notice.textContent = `来源 ${sourceRef} 当前不可见；请在时间线中加载该权威版本。`; timeline.prepend(notice);
        notice.tabIndex = -1; notice.focus();
      }
    };
    const openNotificationSource = (target: NotificationDeepLinkTarget): void => {
      if (target.roomId !== roomId) {
        const hash = `notification-source=${encodeURIComponent(`${target.kind}:${target.targetId}`)}`;
        navigateRenderer(`?message-room=${encodeURIComponent(target.roomId)}`, hash);
        return;
      }
      const selectors: Readonly<Record<NotificationDeepLinkTarget["kind"], string>> = {
        message: "[data-message-id]", request: "[data-request-transfer-target]",
        confirmation: "[data-confirmation-id]", project_boundary: "[data-project-source-ref]",
        tool_call: "[data-tool-call-id]", agent_execution: "[data-execution-id]",
        project_obstacle: "[data-obstacle-reason]",
      };
      const attribute = selectors[target.kind];
      const source = [...workspace.querySelectorAll<HTMLElement>(attribute)].find((candidate) =>
        Object.values(candidate.dataset).includes(target.targetId));
      if (source !== undefined) {
        source.tabIndex = -1; source.dataset.sourceHighlighted = "true";
        source.scrollIntoView({ block: "center", behavior: "auto" }); source.focus();
        return;
      }
      const notice = document.createElement("p"); notice.setAttribute("role", "status");
      notice.textContent = "来源仍可访问，但当前 Room projection 尚未载入该位置。请刷新对应权威面板。";
      timeline.prepend(notice); notice.tabIndex = -1; notice.focus();
    };
    const disposeNotifications = notificationCenter === undefined || notificationToolResult === undefined ||
      notificationExecutionResult === undefined ||
      ports.mountNotificationCenterShell === undefined ? undefined
      : ports.mountNotificationCenterShell({ workspace, bridge: notificationCenter, roomId,
          toolResultAction: notificationToolResult,
          executionResultAction: notificationExecutionResult,
          onDeepLink: openNotificationSource, onReauthenticate: () => navigateRenderer("") });
    const disposeTools = tools === undefined || toolSafety === undefined ||
      ports.mountToolSafetySurface === undefined ? undefined
      : ports.mountToolSafetySurface(tools, toolSafety, roomId, {
        openSource,
        newInvocation: () => timeline.querySelector<HTMLTextAreaElement>("textarea")?.focus(),
        reauthenticate: () => navigateRenderer(""),
      });
    const disposeInvocations = executions === undefined || invocation === undefined ||
      ports.mountInvocationSurface === undefined ? undefined
      : ports.mountInvocationSurface(executions, invocation, roomId, {
        onHostAction(action, context) {
          if (context.roomId !== roomId) return;
          if (action === "reauthenticate") {
            navigateRenderer("");
            return;
          }
          if (action === "request-access") {
            navigateRenderer(`?governance-room=${encodeURIComponent(roomId)}`);
            return;
          }
          if (action === "review-required" && tools !== undefined) {
            tools.hidden = false; tools.setAttribute("aria-hidden", "false");
            const toolTab = authorityRail?.querySelector<HTMLButtonElement>("[data-authority-rail-tab='tool']");
            toolTab?.click();
            const target = tools.querySelector<HTMLElement>("h2, [role='alert']");
            if (target !== null) { target.tabIndex = -1; target.focus(); }
            return;
          }
          showInvocationHostHandoff(workspace, executions, action, context.executionId);
        },
      });
    const notificationHash = window.location.hash.startsWith("#notification-source=")
      ? decodeURIComponent(window.location.hash.slice("#notification-source=".length)) : undefined;
    if (notificationHash !== undefined) {
      const separator = notificationHash.indexOf(":");
      const kind = notificationHash.slice(0, separator) as NotificationDeepLinkTarget["kind"];
      const targetId = notificationHash.slice(separator + 1);
      if (separator > 0 && ["message", "request", "confirmation", "project_boundary", "tool_call",
        "agent_execution", "project_obstacle"].includes(kind) && targetId.length > 0 &&
        new TextEncoder().encode(targetId).byteLength <= 256) {
        queueMicrotask(() => openNotificationSource({ roomId, kind, targetId }));
      }
    }
    return () => {
      disposeNotifications?.();
      disposeInvocations?.();
      disposeTools?.();
      disposeProject?.();
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
    const dispose = ports.mountGovernanceSurface(root, governance, roomId, roomExport);
    const stopFocus = focusRouteEntry(root, ROUTE_FOCUS_SELECTORS.governance);
    return () => {
      stopFocus();
      dispose();
    };
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
  if (identity !== undefined) {
    const dispose = ports.mountIdentityApp(root, identity);
    const stopFocus = focusRouteEntry(root, ROUTE_FOCUS_SELECTORS.identity);
    return () => {
      stopFocus();
      dispose();
    };
  }

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
