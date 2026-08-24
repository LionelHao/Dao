import type { AgentSettingsMutationIntent } from "../../agent-profile-routing/contracts.js";
import type {
  AgentAssignmentCardView,
  AgentProfileCardView,
  AgentSettingsErrorView,
  AgentSettingsViewModel,
} from "./view-model.js";

export interface AgentSettingsSurfaceActions {
  readonly onIntent: (intent: AgentSettingsMutationIntent) => void;
  readonly onRecover: (error: AgentSettingsErrorView) => void;
  readonly onClose: () => void;
}

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className?: string): HTMLElementTagNameMap[Tag] {
  const value = document.createElement(tag);
  if (className !== undefined) value.className = className;
  return value;
}

function text<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, content: string, className?: string): HTMLElementTagNameMap[Tag] {
  const value = element(tag, className);
  value.textContent = content;
  return value;
}

function button(label: string, action: string, disabled: boolean): HTMLButtonElement {
  const value = text("button", label, "agent-settings-action");
  value.type = "button";
  value.dataset.action = action;
  value.dataset.agentMutation = "true";
  value.disabled = disabled;
  return value;
}

function installDialogKeyboardContract(shell: HTMLElement, actions: AgentSettingsSurfaceActions): void {
  shell.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      actions.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(shell.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex='0']",
    ));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function appendError(
  shell: HTMLElement,
  error: AgentSettingsErrorView,
  actions: AgentSettingsSurfaceActions,
): HTMLElement {
  const summary = element("section", "agent-settings-error");
  summary.dataset.agentSettingsError = "true";
  summary.setAttribute("role", "group");
  summary.setAttribute("aria-label", "Agent Settings 错误摘要");
  summary.tabIndex = -1;
  summary.append(
    text("strong", `ERROR · ${error.status} · ${error.code}`),
    text("p", `requestId ${error.requestId} · stable Profile / Assignment 未被本地改写。`),
  );
  const recover = button(error.recoveryLabel, "recover", false);
  recover.removeAttribute("data-agent-mutation");
  recover.addEventListener("click", () => actions.onRecover(error));
  summary.append(recover);
  shell.append(summary);
  return summary;
}

function renderProfileCard(
  profile: AgentProfileCardView,
  model: AgentSettingsViewModel,
  actions: AgentSettingsSurfaceActions,
): HTMLElement {
  const card = element("article", "agent-profile-card");
  card.dataset.profileId = profile.profileId;
  card.dataset.profileStatus = profile.status;
  card.append(
    text("h3", profile.displayName),
    text("p", `Global Profile · ${profile.actorId} · revision ${profile.revision}`, "agent-settings-metadata"),
    text("p", profile.statusLabel, "agent-settings-state-label"),
  );
  const nameLabel = element("label", "agent-settings-field");
  nameLabel.append(text("span", "显示名称（改名不改变 actorId）"));
  const name = element("input");
  name.name = "displayName";
  name.value = profile.displayName;
  name.maxLength = 128;
  name.disabled = !model.permissions.canManageProfiles || model.writeLocked;
  nameLabel.append(name);
  const responsibilityLabel = element("label", "agent-settings-field");
  responsibilityLabel.append(text("span", "全局职责"));
  const responsibility = element("textarea");
  responsibility.name = "globalResponsibility";
  responsibility.value = profile.globalResponsibility;
  responsibility.maxLength = 4000;
  responsibility.disabled = name.disabled;
  responsibilityLabel.append(responsibility);
  card.append(nameLabel, responsibilityLabel);
  const ceilings = text(
    "p",
    `全局上限 · capabilities ${profile.capabilityCeiling.join(", ") || "无"} · tools ${profile.toolCeiling.join(", ") || "无"}`,
    "agent-settings-grants",
  );
  card.append(ceilings);
  const controls = element("div", "agent-settings-actions");
  for (const action of profile.actions) {
    const control = button(action.label, action.command, model.writeLocked);
    control.dataset.destructive = String(action.destructive);
    control.addEventListener("click", () => {
      if (action.command === "profile.update") {
        actions.onIntent({
          command: "profile.update",
          profileId: profile.profileId,
          expectedProfileRevision: profile.revision,
          displayName: name.value.trim(),
          globalResponsibility: responsibility.value.trim(),
          capabilityCeiling: profile.capabilityCeiling,
          toolCeiling: profile.toolCeiling,
        });
      } else if (action.command === "profile.disable" || action.command === "profile.enable") {
        actions.onIntent({
          command: action.command,
          profileId: profile.profileId,
          expectedProfileRevision: profile.revision,
        });
      }
    });
    controls.append(control);
  }
  card.append(controls);
  return card;
}

function renderAssignmentCard(
  assignment: AgentAssignmentCardView,
  model: AgentSettingsViewModel,
  actions: AgentSettingsSurfaceActions,
): HTMLElement {
  const card = element("article", "agent-assignment-card");
  card.dataset.assignmentId = assignment.assignmentId;
  card.append(
    text("h3", assignment.displayName),
    text("p", `Global Profile · ${assignment.actorId} · Profile r${assignment.profileRevision} / Assignment r${assignment.assignmentRevision}`, "agent-settings-metadata"),
  );
  const availability = text(
    "p",
    `${assignment.availabilityGlyph} ${assignment.availabilityLabel}`,
    "agent-settings-state-label agent-settings-availability",
  );
  availability.dataset.availability = assignment.availability;
  availability.setAttribute("aria-label", `Agent availability ${assignment.availability}`);
  card.append(availability);
  const responsibilityLabel = element("label", "agent-settings-field");
  responsibilityLabel.append(text("span", "房间职责"));
  const responsibility = element("textarea");
  responsibility.name = "roomResponsibility";
  responsibility.value = assignment.roomResponsibility;
  responsibility.maxLength = 4000;
  responsibility.disabled = !model.permissions.canManageAssignments || model.writeLocked || model.lifecycle === "archived";
  responsibilityLabel.append(responsibility);
  const participationLabel = element("label", "agent-settings-field");
  participationLabel.append(text("span", "participation"));
  const participation = element("select");
  participation.name = "participation";
  participation.append(new Option("on-mention · 仅结构化点名/直接调用", "on-mention"));
  participation.append(new Option("active · 可受控主动参与", "active"));
  participation.value = assignment.participation;
  participation.disabled = responsibility.disabled;
  participationLabel.append(participation);
  card.append(responsibilityLabel, participationLabel);
  card.append(text(
    "p",
    `工具 grant（全局上限的子集）· ${assignment.effectiveTools.join(", ") || "无"}`,
    "agent-settings-grants",
  ));
  card.append(text(
    "p",
    `有效 capability · ${assignment.effectiveCapabilities.join(", ") || "无"}`,
    "agent-settings-grants",
  ));
  const controls = element("div", "agent-settings-actions");
  for (const action of assignment.actions) {
    const control = button(action.label, action.command, model.writeLocked);
    control.dataset.destructive = String(action.destructive);
    control.addEventListener("click", () => {
      if (action.command === "assignment.update") {
        actions.onIntent({
          command: "assignment.update",
          roomId: assignment.roomId,
          assignmentId: assignment.assignmentId,
          expectedRoomRevision: model.roomRevision ?? 0,
          expectedAssignmentRevision: assignment.assignmentRevision,
          roomResponsibility: responsibility.value.trim(),
          participation: participation.value === "active" ? "active" : "on-mention",
          capabilitySubset: assignment.capabilitySubset,
          toolSubset: assignment.toolSubset,
        });
      } else if (action.command === "assignment.pause" || action.command === "assignment.resume" || action.command === "assignment.remove") {
        actions.onIntent({
          command: action.command,
          roomId: assignment.roomId,
          assignmentId: assignment.assignmentId,
          expectedRoomRevision: model.roomRevision ?? 0,
          expectedAssignmentRevision: assignment.assignmentRevision,
        });
      }
    });
    controls.append(control);
  }
  card.append(controls);
  return card;
}

function renderCreateProfile(model: AgentSettingsViewModel, actions: AgentSettingsSurfaceActions): HTMLElement {
  const form = element("form", "agent-settings-create");
  form.dataset.createProfile = "true";
  const name = element("input"); name.name = "displayName"; name.required = true; name.maxLength = 128;
  const responsibility = element("textarea"); responsibility.name = "globalResponsibility";
  responsibility.required = true; responsibility.maxLength = 4000;
  const nameLabel = element("label"); nameLabel.append(text("span", "Profile 显示名称"), name);
  const responsibilityLabel = element("label"); responsibilityLabel.append(text("span", "全局职责"), responsibility);
  const submit = button("创建 Global Profile", "profile.create", model.writeLocked);
  submit.type = "submit";
  form.append(nameLabel, responsibilityLabel, text("p", "默认最小上限 · room.respond / room-memory.read"), submit);
  form.addEventListener("submit", (event) => { event.preventDefault();
    if (!form.reportValidity()) return;
    actions.onIntent({ command: "profile.create", displayName: name.value.trim(),
      globalResponsibility: responsibility.value.trim(), capabilityCeiling: ["room.respond"],
      toolCeiling: ["room-memory.read"] });
  });
  return form;
}

function renderCreateAssignment(model: AgentSettingsViewModel, actions: AgentSettingsSurfaceActions): HTMLElement {
  const form = element("form", "agent-settings-create"); form.dataset.createAssignment = "true";
  const profile = element("select"); profile.name = "profileId"; profile.required = true;
  profile.append(new Option("选择已启用 Global Profile", ""));
  for (const item of model.profiles.filter((candidate) => candidate.status === "enabled"))
    profile.append(new Option(`${item.displayName} · ${item.actorId}`, item.profileId));
  const responsibility = element("textarea"); responsibility.name = "roomResponsibility";
  responsibility.required = true; responsibility.maxLength = 4000;
  const participation = element("select"); participation.name = "participation";
  participation.append(new Option("on-mention · 点名响应", "on-mention"), new Option("active · 受控主动参与", "active"));
  const submit = button("创建 Room Assignment", "assignment.create", model.writeLocked || model.lifecycle === "archived"); submit.type = "submit";
  const profileLabel = element("label"); profileLabel.append(text("span", "Global Profile"), profile);
  const responsibilityLabel = element("label"); responsibilityLabel.append(text("span", "房间职责"), responsibility);
  const participationLabel = element("label"); participationLabel.append(text("span", "participation"), participation);
  form.append(profileLabel, responsibilityLabel, participationLabel, submit);
  form.addEventListener("submit", (event) => { event.preventDefault(); if (!form.reportValidity()) return;
    const selected = model.profiles.find((item) => item.profileId === profile.value); if (selected === undefined) return;
    actions.onIntent({ command: "assignment.create", roomId: model.roomId!, profileId: selected.profileId,
      expectedRoomRevision: model.roomRevision ?? 0, roomResponsibility: responsibility.value.trim(),
      participation: participation.value === "active" ? "active" : "on-mention",
      capabilitySubset: selected.capabilityCeiling, toolSubset: selected.toolCeiling });
  });
  return form;
}

export function renderAgentSettingsSurface(
  root: HTMLElement,
  model: AgentSettingsViewModel,
  actions: AgentSettingsSurfaceActions,
): void {
  const shell = element("section", "dao-agent-settings");
  shell.dataset.agentSettingsState = model.visibleState;
  shell.dataset.motion = model.motion;
  shell.setAttribute("role", "dialog");
  shell.setAttribute("aria-modal", "true");
  shell.setAttribute("aria-labelledby", "agent-settings-title");
  installDialogKeyboardContract(shell, actions);

  const live = text("p", model.liveAnnouncement, "agent-settings-live");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  shell.append(live);

  if (model.visibleState === "revoked") {
    const revoked = element("section", "agent-settings-revoked");
    revoked.setAttribute("role", "alert");
    revoked.tabIndex = -1;
    revoked.dataset.revokedRecovery = "true";
    const revokedHeading = text("h2", "Agent Settings 访问已撤销");
    revokedHeading.id = "agent-settings-title";
    revoked.append(
      revokedHeading,
      text("p", model.connectionLabel ?? "缓存正在清除；不显示旧 Profile 或 Assignment。"),
    );
    shell.append(revoked);
    root.replaceChildren(shell);
    revoked.focus();
    return;
  }

  const header = element("header", "agent-settings-header");
  const heading = text("h1", model.roomName === undefined ? "Agent Settings" : `Room 设置 · ${model.roomName}`);
  heading.id = "agent-settings-title";
  heading.tabIndex = -1;
  const role = text("p", `Room 角色：${model.viewerRole ?? "无 Room membership"}`, "agent-settings-metadata");
  const close = button("关闭设置", "close-settings", false);
  close.removeAttribute("data-agent-mutation");
  close.setAttribute("aria-label", "关闭 Agent Settings 并将焦点归还触发器");
  close.addEventListener("click", actions.onClose);
  header.append(heading, role, close);
  shell.append(header);

  if (model.connectionLabel !== undefined) {
    const banner = text("p", model.connectionLabel, "agent-settings-connection");
    banner.dataset.connectionBanner = "true";
    shell.append(banner);
  }
  if (model.lifecycle === "archived") {
    const archived = text("p", "ARCHIVED · Room 业务只读；仅保留 Assignment 暂停/移除等安全缩减。", "agent-settings-archived");
    archived.dataset.archived = "true";
    shell.append(archived);
  }
  let errorElement: HTMLElement | undefined;
  if (model.error !== undefined) errorElement = appendError(shell, model.error, actions);

  if (model.visibleState === "loading") {
    shell.append(text("p", "正在载入 Agent Profile / Assignment 权威 projection。", "agent-settings-loading"));
    root.replaceChildren(shell);
    heading.focus();
    return;
  }

  if (model.provider !== undefined) {
    const disclosure = element("section", "agent-settings-provider");
    disclosure.dataset.providerDisclosure = "true";
    disclosure.setAttribute("aria-label", "Provider 与模型披露，只读");
    disclosure.append(
      text("h2", "Provider / Model · 只读披露"),
      text("p", `单 Provider / 单模型 · ${model.provider.providerId} / ${model.provider.modelId}`),
      text("p", model.provider.credentialStatus === "configured"
        ? "credential 已由服务端配置 · Provider 侧留存已禁用"
        : "noauth · credential 尚未由 Tenant Administrator 在部署管理路径配置"),
    );
    shell.append(disclosure);
  }

  const human = element("section", "agent-settings-human-path");
  human.dataset.settingsSection = "human-invitation";
  human.append(
    text("h2", "流程 A · Human invitation"),
    text("p", "Human 必须显式接受或拒绝邀请；接受前不产生 membership。Agent 不走这条路径。"),
  );
  shell.append(human);

  const profiles = element("section", "agent-settings-profile-path");
  profiles.dataset.settingsSection = "global-profiles";
  profiles.append(
    text("h2", "部署管理 · Global Agent Profile"),
    text("p", model.permissions.canManageProfiles
      ? "Tenant Administrator 可管理稳定 actorId、全局职责与 capability/tool ceiling；此身份不授予 Room 读取权。"
      : "仅 Tenant Administrator 可管理 Profile；当前表面不显示部署级 Profile catalog。"),
  );
  if (model.permissions.canManageProfiles) profiles.append(renderCreateProfile(model, actions));
  if (model.profiles.length === 0) profiles.append(text("p", "EMPTY · 没有可显示的 Global Profile。"));
  else for (const profile of model.profiles) profiles.append(renderProfileCard(profile, model, actions));
  shell.append(profiles);

  const assignments = element("section", "agent-settings-assignment-path");
  assignments.dataset.settingsSection = "room-assignments";
  assignments.append(
    text("h2", "流程 B · Room Agent Assignment"),
    text("p", model.permissions.canManageAssignments
      ? "Room owner/admin 可管理房间职责、active/on-mention、全局上限内的 grant 与 durable pause。"
      : "Room member 只读查看职责、participation、availability 与有效 grant。"),
  );
  if (model.permissions.canManageAssignments && model.roomId !== undefined)
    assignments.append(renderCreateAssignment(model, actions));
  if (model.assignments.length === 0) assignments.append(text("p", "EMPTY · 当前 Room 没有 Agent Assignment。"));
  else for (const assignment of model.assignments) assignments.append(renderAssignmentCard(assignment, model, actions));
  shell.append(assignments);

  root.replaceChildren(shell);
  if (errorElement !== undefined) errorElement.focus();
  else heading.focus();
}
