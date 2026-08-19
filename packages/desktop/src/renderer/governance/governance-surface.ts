import {
  createGovernanceViewModel,
  type DepartureConflict,
  type DepartureConflictKind,
  type DepartureResolution,
  type GovernanceClosedError,
  type GovernanceDialog,
  type GovernanceIntent,
  type GovernanceOperationState,
  type GovernanceSurfaceState,
} from "./view-model.js";

export interface GovernanceSurfaceActions {
  readonly onIntent: (intent: GovernanceIntent) => void;
  readonly onOpenDialog: (dialog: GovernanceDialog) => void;
  readonly onRetry: (error: GovernanceClosedError) => void;
  readonly onResolveConflict: (
    conflict: DepartureConflict,
    resolution: DepartureResolution,
  ) => void;
  readonly onCloseDialog: (dialog: GovernanceDialog) => void;
}

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
): HTMLElementTagNameMap[Tag] {
  const value = document.createElement(tag);
  if (className !== undefined) value.className = className;
  return value;
}

function text<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  content: string,
  className?: string,
): HTMLElementTagNameMap[Tag] {
  const value = element(tag, className);
  value.textContent = content;
  return value;
}

function button(label: string, className?: string): HTMLButtonElement {
  const value = text("button", label, className);
  value.type = "button";
  return value;
}

const commandLabels: Record<Exclude<GovernanceOperationState, { status: "idle" }>["command"], string> = {
  "room.ownership.transfer": "ownership 转移",
  "room.member.leave": "离开 Room",
  "room.member.remove": "移除成员",
  "room.archive": "归档",
  "room.reopen": "重开",
};

function operationAnnouncement(state: GovernanceSurfaceState): string {
  const operation = state.operation;
  if (operation.status === "idle") {
    return "";
  }
  const label = commandLabels[operation.command];
  if (operation.status === "submitting") {
    return `正在提交${label} · requestId ${operation.requestId}`;
  }
  if (operation.status === "acknowledged") {
    return `${label} ACK 已接受，等待 stable event / projection · requestId ${operation.requestId}`;
  }
  if (operation.status === "succeeded") {
    return `${label}成功，权威状态已收敛 · requestId ${operation.requestId}`;
  }
  return `${label}失败 · ${operation.error.status} ${operation.error.code}`;
}

function connectionLabel(state: GovernanceSurfaceState): string | undefined {
  switch (state.connection.status) {
    case "online":
      return undefined;
    case "offline":
      return `离线只读 · 数据截至 ${state.connection.asOf} · lease 到期 ${state.connection.leaseExpiresAt}`;
    case "repairing":
      return `REPAIR 进行中 · fixed watermark ${state.connection.watermark} · 旧完整 projection 保持只读`;
    case "repair_failed":
      return `REPAIR FAILED · ${state.connection.errorCode} · 新 staging 未提交，旧完整 projection 保持只读`;
    case "revoked":
      return state.connection.purgeCompleted
        ? "已失去访问权 · 缓存已清除"
        : "已失去访问权 · 正在清除缓存";
    case "fatal":
      return `FATAL · ${state.connection.errorCode} · Room 内容已锁定`;
  }
}

function recoveryLabel(error: GovernanceClosedError): string {
  switch (error.status) {
    case 401:
      return "重新认证";
    case 403:
      return "查看权限";
    case 404:
      return "刷新治理状态";
    case 409:
      return error.code === "departure_blocked"
        ? "查看最新冲突"
        : error.code === "room_revision_conflict" ? "载入最新版本" : "查看权威状态";
    case 410:
      return "重新开始 repair";
    case 429:
      return "稍后重试";
    case 503:
      return "重试";
  }
}

function appendOperationError(
  container: HTMLElement,
  operation: Extract<GovernanceOperationState, { status: "failed" }>,
  actions: GovernanceSurfaceActions,
): HTMLElement {
  const alert = element("section", "governance-error");
  alert.dataset.governanceError = "true";
  alert.setAttribute("role", "group");
  alert.setAttribute("aria-label", "治理操作错误");
  alert.tabIndex = -1;
  const heading = text("h3", `${operation.error.status} · ${operation.error.code}`);
  const recovery = button(recoveryLabel(operation.error));
  recovery.dataset.action = "recover";
  recovery.addEventListener("click", () => actions.onRetry(operation.error));
  alert.append(heading, recovery);
  container.append(alert);
  return alert;
}

function appendOperationSuccess(
  container: HTMLElement,
  operation: Extract<GovernanceOperationState, { status: "succeeded" }>,
): HTMLElement {
  const success = element("section", "governance-success");
  success.dataset.governanceSuccess = "true";
  success.setAttribute("role", "group");
  success.setAttribute("aria-label", "治理操作成功");
  success.tabIndex = -1;
  success.append(text(
    "p",
    `${commandLabels[operation.command]}成功 · 权威状态已收敛 · requestId ${operation.requestId}`,
  ));
  container.append(success);
  return success;
}

function trapDialogFocus(dialog: HTMLElement): void {
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      "button:not([disabled]), select:not([disabled]), [tabindex='0']",
    )];
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

const conflictLabels: Record<DepartureConflictKind, string> = {
  request: "Request",
  next_action: "NextAction",
  blocker_or_open_question: "Blocker / OpenQuestion",
  pending_acceptance: "待接受责任",
  pending_verification: "待验收责任",
  pending_confirmation: "待工具确认",
};
const resolutionLabels: Record<DepartureResolution, string> = {
  complete: "完成",
  transfer: "转交",
  escalate: "升级",
  reject_or_revoke: "拒绝或撤销",
};

function appendDepartureDialog(
  container: HTMLElement,
  state: GovernanceSurfaceState,
  actions: GovernanceSurfaceActions,
): HTMLElement | undefined {
  const list = state.departureConflicts;
  if (state.dialog !== "departure_conflicts" || list === undefined) return undefined;
  const dialog = element("aside", "governance-dialog governance-departure-dialog");
  dialog.dataset.departureConflicts = "true";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "departure-dialog-title");
  const heading = text("h2", `离群责任冲突 · ${list.conflicts.length} 项`);
  heading.id = "departure-dialog-title";
  heading.tabIndex = -1;
  dialog.append(heading);
  for (const kind of Object.keys(conflictLabels) as DepartureConflictKind[]) {
    const group = element("section", "departure-conflict-group");
    group.dataset.conflictGroup = kind;
    group.append(text("h3", conflictLabels[kind]));
    for (const conflict of list.conflicts.filter((entry) => entry.kind === kind)) {
      const card = element("article", "departure-conflict");
      card.dataset.conflictId = conflict.conflictId;
      card.append(
        text("p", conflict.summary),
        text("p", `状态 ${conflict.state} · revision ${conflict.revision}`),
      );
      const source = text("p", `来源 ${conflict.sourceRef}`);
      source.dataset.sourceRef = conflict.sourceRef;
      source.dataset.roomId = conflict.roomId;
      card.append(source);
      for (const resolution of conflict.allowedResolutions) {
        const resolve = button(resolutionLabels[resolution]);
        resolve.dataset.resolution = resolution;
        resolve.addEventListener("click", () => actions.onResolveConflict(conflict, resolution));
        card.append(resolve);
      }
      group.append(card);
    }
    dialog.append(group);
  }
  const close = button("关闭");
  close.dataset.action = "close-dialog";
  close.addEventListener("click", () => {
    actions.onCloseDialog("departure_conflicts");
    container.querySelector<HTMLElement>("[data-action='open-departure-conflicts']")?.focus();
  });
  dialog.append(close);
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    actions.onCloseDialog("departure_conflicts");
    container.querySelector<HTMLElement>("[data-action='open-departure-conflicts']")?.focus();
  });
  trapDialogFocus(dialog);
  container.append(dialog);
  heading.focus();
  return dialog;
}

function appendArchiveDialog(
  container: HTMLElement,
  state: GovernanceSurfaceState,
  actions: GovernanceSurfaceActions,
): HTMLElement | undefined {
  if (state.dialog !== "archive_confirmation") return undefined;
  const dialog = element("aside", "governance-dialog governance-archive-dialog");
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "archive-dialog-title");
  const heading = text("h2", "确认归档 Room");
  heading.id = "archive-dialog-title";
  heading.tabIndex = -1;
  dialog.append(
    heading,
    text("p", "归档后业务只读；业务 timer 保留剩余时长。"),
    text("p", "未 dispatch confirmation 会被拒绝、grant 会被撤销；已 dispatch 事实不会被伪称回滚。"),
    text("p", "session、confirmation、grant 与 offline lease 的安全有效期继续流逝。"),
  );
  const confirm = button("提交归档");
  confirm.dataset.action = "confirm-archive";
  confirm.addEventListener("click", () => actions.onIntent({
    command: "room.archive",
    expectedGovernanceRevision: state.projection.governanceRevision,
  }));
  const cancel = button("取消");
  cancel.dataset.action = "close-dialog";
  cancel.addEventListener("click", () => {
    actions.onCloseDialog("archive_confirmation");
    container.querySelector<HTMLElement>("[data-action='open-archive-confirmation']")?.focus();
  });
  dialog.append(confirm, cancel);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.preventDefault();
  });
  trapDialogFocus(dialog);
  container.append(dialog);
  heading.focus();
  return dialog;
}

export function renderGovernanceSurface(
  root: HTMLElement,
  state: GovernanceSurfaceState,
  actions: GovernanceSurfaceActions,
): void {
  const model = createGovernanceViewModel(state);
  const shell = element("section", "dao-governance");
  shell.dataset.motion = state.reducedMotion ? "reduced" : "standard";
  shell.dataset.lifecycle = state.projection.lifecycle;
  shell.setAttribute("aria-label", "房间治理");

  if (model.contentLocked) {
    const locked = element("section", "governance-locked");
    locked.dataset.governanceLocked = "true";
    locked.setAttribute("role", "alert");
    locked.append(
      text("h2", state.connection.status === "revoked" ? "Room 访问已撤销" : "无法安全显示 Room"),
      text("p", connectionLabel(state) ?? "Room 内容已锁定"),
    );
    shell.append(locked);
    root.replaceChildren(shell);
    return;
  }

  const heading = text("h1", model.roomName);
  const lifecycle = text(
    "p",
    `${model.lifecycle === "archived" ? "ARCHIVED" : "ACTIVE"} · 治理版本 ${state.projection.governanceRevision}`,
    "governance-lifecycle",
  );
  const live = text("p", operationAnnouncement(state), "governance-operation-status");
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  const viewer = text("p", `当前身份：${model.viewerRole ?? "无权限"}`, "governance-viewer-role");
  viewer.dataset.viewerRole = model.viewerRole ?? "none";
  shell.append(heading, lifecycle, live, viewer);

  const connection = connectionLabel(state);
  if (connection !== undefined) {
    const banner = text("p", connection, "governance-connection-state");
    banner.dataset.connectionStatus = state.connection.status;
    shell.append(banner);
  }

  if (model.lifecycle === "archived") {
    const archived = element("section", "governance-archived-banner");
    archived.dataset.archivedBanner = "true";
    archived.setAttribute("role", "region");
    archived.setAttribute("aria-label", "Room 已归档");
    archived.append(
      text("h2", "ARCHIVED · 业务只读"),
      text("p", `归档时间 ${model.archivedAt ?? "未知"}`),
      text("p", "历史、附件、项目事实与审计仍可浏览；业务 timer 已冻结，安全有效期继续。"),
    );
    shell.append(archived);
  }

  const read = element("section", "governance-readable-surfaces");
  read.setAttribute("aria-label", "authority repair 中保持可读的内容状态");
  const readList = element("ul");
  const readSurfaces = [
    ["history", "历史", model.readableSurfaces.history],
    ["attachments", "附件", model.readableSurfaces.attachments],
    ["project-facts", "项目事实", model.readableSurfaces.projectFacts],
    ["audit", "审计", model.readableSurfaces.audit],
  ] as const;
  for (const [key, label, enabled] of readSurfaces) {
    const item = text("li", enabled
      ? `${label} · 当前 authority projection 保持可读，由宿主内容区呈现`
      : `${label} · 当前无读取 authority`);
    item.dataset.readSurface = key;
    item.dataset.readable = String(enabled);
    readList.append(item);
  }
  read.append(readList);
  shell.append(read);

  const business = element("section", "governance-business-controls");
  business.setAttribute("aria-label", "Room 业务控制");
  const businessControls = [
    ["composer", "发送消息", model.businessControls.composer],
    ["project-mutation", "修改项目事实", model.businessControls.projectMutation],
    ["agent-business-controls", "启动 Agent 业务", model.businessControls.agentBusinessControls],
  ] as const;
  for (const [key, label, enabled] of businessControls) {
    const description = text(
      "span",
      enabled ? "当前 Room active 且同步完成" : "业务只读：归档、离线或 repair 状态不接受写入",
    );
    description.id = `governance-business-${key}-reason`;
    const control = button(label);
    control.dataset.businessControl = key;
    control.disabled = !enabled;
    control.setAttribute("aria-describedby", description.id);
    business.append(control, description);
  }
  shell.append(business);

  const membership = element("section", "governance-membership");
  membership.append(text("h2", "成员与权限"));
  const memberList = element("ul", "governance-member-list");
  for (const member of model.members) {
    const item = element("li", "governance-member");
    item.dataset.memberId = member.actorId;
    item.dataset.memberRole = member.role;
    const name = text("strong", `${member.displayName} · ${member.role}`);
    const reason = text("span", member.manageReason);
    reason.id = `governance-member-${member.actorId}-reason`;
    const remove = button("移除");
    remove.dataset.removeMember = member.actorId;
    remove.disabled = !member.manageable;
    remove.setAttribute("aria-describedby", reason.id);
    remove.addEventListener("click", () => actions.onIntent({
      command: "room.member.remove",
      targetActorId: member.actorId,
      expectedGovernanceRevision: state.projection.governanceRevision,
    }));
    item.append(name, reason, remove);
    memberList.append(item);
  }
  membership.append(memberList);
  shell.append(membership);

  const governance = element("section", "governance-actions");
  governance.append(text("h2", "治理"));
  const targetLabel = text("label", "转移 ownership");
  const target = element("select");
  target.dataset.ownershipTarget = "true";
  target.disabled = !model.controls.canTransferOwnership;
  const placeholder = element("option");
  placeholder.value = "";
  placeholder.textContent = "选择当前 Human member…";
  target.append(placeholder);
  for (const human of model.transferTargets) {
    const option = element("option");
    option.value = human.actorId;
    option.textContent = `${human.displayName} · ${human.role}`;
    target.append(option);
  }
  targetLabel.append(target);
  const transfer = button("提交 ownership 转移");
  transfer.disabled = !model.controls.canTransferOwnership;
  transfer.addEventListener("click", () => {
    if (target.value.length === 0) return;
    actions.onIntent({
      command: "room.ownership.transfer",
      targetActorId: target.value,
      expectedGovernanceRevision: state.projection.governanceRevision,
    });
  });
  const conflicts = button("查看离群责任冲突");
  conflicts.dataset.action = "open-departure-conflicts";
  conflicts.disabled = state.departureConflicts === undefined;
  conflicts.addEventListener("click", () => actions.onOpenDialog("departure_conflicts"));
  const archiveConfirmation = button("归档 Room");
  archiveConfirmation.dataset.action = "open-archive-confirmation";
  archiveConfirmation.dataset.archiveRoom = "true";
  archiveConfirmation.disabled = !model.controls.canArchive;
  archiveConfirmation.setAttribute(
    "aria-label",
    model.controls.canArchive ? "归档 Room" : "归档 Room（当前不可用）",
  );
  archiveConfirmation.addEventListener("click", () => actions.onOpenDialog("archive_confirmation"));
  const reopen = button("审计重开");
  reopen.dataset.action = "reopen-room";
  reopen.disabled = !model.controls.canReopen;
  reopen.addEventListener("click", () => actions.onIntent({
    command: "room.reopen",
    expectedGovernanceRevision: state.projection.governanceRevision,
  }));
  const leave = button("离开 Room");
  leave.disabled = !model.controls.canSelfLeave;
  leave.addEventListener("click", () => actions.onIntent({
    command: "room.member.leave",
    expectedGovernanceRevision: state.projection.governanceRevision,
  }));
  governance.append(
    targetLabel,
    transfer,
    conflicts,
    archiveConfirmation,
    reopen,
    leave,
  );
  shell.append(governance);

  const operationError = state.operation.status === "failed"
    ? appendOperationError(shell, state.operation, actions)
    : undefined;
  const operationSuccess = state.operation.status === "succeeded"
    ? appendOperationSuccess(shell, state.operation)
    : undefined;

  root.replaceChildren(shell);
  const departureDialog = appendDepartureDialog(shell, state, actions);
  const archiveDialog = appendArchiveDialog(shell, state, actions);
  if (departureDialog === undefined && archiveDialog === undefined) {
    (operationError ?? operationSuccess)?.focus();
  }
}
