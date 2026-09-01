import type { NotificationDeepLinkKind } from "@native-im/core";
import { createNotificationCenterViewModel, type NotificationCenterRemoteState,
  type NotificationErrorStatus } from "./view-model.js";

export type NotificationSourceActionState =
  | Readonly<{ status: "submitting" }>
  | Readonly<{ status: "acknowledged" }>
  | Readonly<{ status: "failed"; errorStatus: NotificationErrorStatus }>;

export interface NotificationCenterActions {
  onMarkRead(notificationId: string, expectedReadRevision: number): void;
  onOpenDeepLink(deepLink: Readonly<{ kind: NotificationDeepLinkKind; targetId: string }>): void;
  onRetry(): void;
  onReauthenticate(): void;
  onRefresh(): void;
  onRequestClose(): void;
  onPage(offset: number): void;
  onAcknowledgeToolResult?(notificationId: string): void;
  onAcknowledgeExecutionResult?(notificationId: string): void;
}
export type NotificationCenterSurfaceOptions = Readonly<{
  opener?: HTMLElement;
  sourceActionStates?: ReadonlyMap<string, NotificationSourceActionState>;
}>;

function button(text: string, action: () => void, disabled = false): HTMLButtonElement {
  const value = document.createElement("button"); value.type = "button"; value.textContent = text;
  value.disabled = disabled; value.addEventListener("click", action); return value;
}
function renderTerminal(root: HTMLElement, state: Exclude<NotificationCenterRemoteState, { status: "ready" }>,
  actions: NotificationCenterActions): void {
  const vm = createNotificationCenterViewModel(state);
  const panel = document.createElement("section"); panel.className = "notification-center notification-center--terminal";
  panel.dataset.notificationCenterStatus = vm.status;
  panel.setAttribute("role", vm.status === "revoked" ? "alert" : "status");
  const heading = document.createElement("h2");
  heading.textContent = vm.status === "loading" ? "正在载入通知" : "通知访问已撤销";
  const detail = document.createElement("p"); detail.textContent = vm.connectionAnnouncement;
  panel.append(heading, detail);
  if (vm.status === "revoked") panel.append(button("重新登录", actions.onReauthenticate));
  root.replaceChildren(panel);
}
function trapDialogFocus(dialog: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
  )];
  if (focusable.length === 0) return;
  const first = focusable[0]!; const last = focusable.at(-1)!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function sourceActionFailure(status: NotificationErrorStatus): string {
  const messages: Readonly<Record<NotificationErrorStatus, string>> = {
    401: "身份已失效，请重新登录；结果仍未确认。",
    403: "当前通知或 Room 已无操作权限；结果仍未确认。",
    409: "来源状态已变化，请刷新后重试。",
    410: "来源已不可访问；不会泄漏来源 metadata。",
    429: "操作过于频繁，请稍后显式重试。",
    503: "通知服务暂不可用；结果仍未确认。",
  };
  return messages[status];
}

export function renderNotificationCenter(root: HTMLElement, state: NotificationCenterRemoteState,
  actions: NotificationCenterActions, options: NotificationCenterSurfaceOptions = {}): void {
  if (state.status !== "ready") { renderTerminal(root, state, actions); return; }
  const vm = createNotificationCenterViewModel(state);
  const dialog = document.createElement("section"); dialog.className = "notification-center";
  dialog.dataset.notificationCenterStatus = vm.status; dialog.dataset.minimumViewport = "840x560";
  dialog.dataset.zoomContract = "100-200"; dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-labelledby", "notification-center-title");
  dialog.tabIndex = -1;
  const header = document.createElement("header"); header.className = "notification-center__header";
  const heading = document.createElement("h2"); heading.id = "notification-center-title"; heading.textContent = "通知";
  const scope = document.createElement("p"); scope.textContent = "flat · durable · recipient-scoped";
  const close = button("关闭", () => { actions.onRequestClose(); options.opener?.focus(); });
  close.setAttribute("aria-label", "关闭通知中心"); header.append(heading, scope, close);
  const live = document.createElement("p"); live.className = "notification-center__live";
  live.setAttribute("aria-live", "polite"); live.setAttribute("role", "status");
  live.textContent = vm.operationAnnouncement || vm.connectionAnnouncement;
  const badges = document.createElement("section"); badges.className = "notification-center__badges";
  badges.setAttribute("aria-label", "Room 未读与未处理计数");
  for (const badge of vm.roomBadges) {
    const value = document.createElement("span"); value.dataset.notificationBadge = badge.roomId;
    value.setAttribute("aria-label", badge.accessibleLabel); value.textContent = `${badge.roomId} ${badge.visibleUnreadCount}`;
    badges.append(value);
  }
  const connection = document.createElement("p"); connection.dataset.notificationConnection = state.connection.status;
  connection.className = "notification-center__connection"; connection.textContent = vm.connectionAnnouncement;
  const list = document.createElement("section"); list.className = "notification-center__list";
  list.setAttribute("aria-label", "通知列表");
  if (vm.status === "empty") {
    const empty = document.createElement("p"); empty.className = "notification-center__empty";
    empty.textContent = "没有通知"; empty.setAttribute("role", "status"); list.append(empty);
  }
  for (const item of vm.items) {
    const row = document.createElement("article"); row.className = "notification-center__row";
    row.dataset.notificationCard = item.notificationId;
    const card = button("", () => {
      if (!item.read && !item.readDisabled && !vm.writeDisabled) {
        actions.onMarkRead(item.notificationId, item.readRevision);
      }
      actions.onOpenDeepLink(item.deepLink);
    });
    card.className = "notification-center__item"; card.dataset.notificationId = item.notificationId;
    card.dataset.notificationKind = item.notificationKind;
    card.setAttribute("aria-label", `${item.title}，${item.readLabel}，${item.handledLabel}，${item.sourceLabel}`);
    const meta = document.createElement("span"); meta.className = "notification-center__meta";
    meta.textContent = `${item.notificationKind}${item.actorLabel === null ? "" : ` · actor ${item.actorLabel}`}`;
    const title = document.createElement("strong"); title.textContent = item.title;
    const states = document.createElement("span"); states.className = "notification-center__states";
    const read = document.createElement("span"); read.dataset.readState = item.read ? "read" : "unread";
    read.textContent = item.readLabel;
    const handled = document.createElement("span"); handled.dataset.handledState = item.handled ? "handled" : "unhandled";
    handled.textContent = item.handledLabel;
    const source = document.createElement("span"); source.dataset.sourceStatus = item.sourceStatus;
    source.textContent = item.sourceLabel;
    states.append(read, handled); card.append(meta, title, states, source); row.append(card);
    const actionKind = item.notificationKind === "tool_result" && item.sourceKind === "tool_call" &&
        actions.onAcknowledgeToolResult !== undefined ? "tool_result" as const
      : (item.notificationKind === "agent_execution_completed" ||
          item.notificationKind === "agent_execution_failed") && item.sourceKind === "agent_execution" &&
          actions.onAcknowledgeExecutionResult !== undefined ? item.notificationKind : undefined;
    if (!item.handled && item.sourceStatus === "available" && actionKind !== undefined) {
      const state = options.sourceActionStates?.get(item.notificationId);
      const toolResult = actionKind === "tool_result";
      const idleLabel = toolResult ? "确认工具结果" : "知悉执行结果";
      const label = state?.status === "submitting"
        ? toolResult ? "正在确认工具结果" : "正在提交知悉"
        : state?.status === "acknowledged" ? "已提交，等待 handled 事件"
          : state?.status === "failed" ? `重试${idleLabel}` : idleLabel;
      const action = button(label, () => {
        if (toolResult) actions.onAcknowledgeToolResult?.(item.notificationId);
        else actions.onAcknowledgeExecutionResult?.(item.notificationId);
      }, vm.writeDisabled || vm.connection?.status !== "online" || state?.status === "submitting" ||
        state?.status === "acknowledged" || state?.status === "failed" &&
          [401, 403, 410].includes(state.errorStatus));
      action.className = "notification-center__source-action";
      action.dataset.notificationSourceAction = actionKind;
      action.setAttribute("aria-label", `${idleLabel}：${item.title}`);
      row.append(action);
      if (state !== undefined) {
        const status = document.createElement("span");
        status.className = "notification-center__source-action-status";
        status.dataset.notificationSourceActionStatus = state.status;
        status.setAttribute("aria-live", "polite");
        status.setAttribute("role", state.status === "failed" ? "alert" : "status");
        status.textContent = state.status === "submitting" ? "正在提交；handled 尚未改变。"
          : state.status === "acknowledged" ? "服务端已接受；等待 stable handled event 收敛。"
            : sourceActionFailure(state.errorStatus);
        row.append(status);
      }
    }
    list.append(row);
  }
  const recovery = document.createElement("section"); recovery.className = "notification-center__recovery";
  if (vm.recovery !== undefined) {
    const action = vm.recovery.action === "reauthenticate" ? actions.onReauthenticate
      : vm.recovery.action === "retry" ? actions.onRetry : actions.onRefresh;
    const control = button(vm.recovery.action === "reauthenticate" ? "重新登录"
      : vm.recovery.action === "retry" ? "重试" : "刷新", action);
    control.dataset.notificationRecovery = String(vm.recovery.status); recovery.append(control);
  } else if (state.connection.status === "repair_failed") {
    const retry = button("重试完整 repair", actions.onRetry); retry.dataset.notificationRecovery = "repair_failed";
    recovery.append(retry);
  }
  const pagination = document.createElement("footer"); pagination.className = "notification-center__pagination";
  const previous = button("上一页", () => actions.onPage(Math.max(0, state.page.offset - state.page.limit)),
    !vm.hasPreviousPage);
  const next = button("下一页", () => actions.onPage(state.page.offset + state.page.limit), !vm.hasNextPage);
  const count = document.createElement("span"); count.textContent = `共 ${vm.totalCount} 条`;
  pagination.append(previous, count, next);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); actions.onRequestClose(); options.opener?.focus(); return; }
    trapDialogFocus(dialog, event);
  });
  dialog.append(header, live, badges, connection, list, recovery, pagination); root.replaceChildren(dialog);
  heading.tabIndex = -1; heading.focus();
}
