import type { NotificationDeepLinkKind } from "@native-im/core";
import { isNotificationClosedError, type NotificationCenterBridge,
  type NotificationListCursor } from "../../notification-center/contracts.js";
import type { NotificationToolResultActionBridge } from
  "../../notification-center/tool-result-action-contracts.js";
import type { NotificationExecutionResultActionBridge } from
  "../../notification-center/execution-result-action-contracts.js";
import type { NotificationCenterRemoteState } from "./view-model.js";
import { renderNotificationCenter, type NotificationSourceActionState } from "./surface.js";

export type NotificationDeepLinkTarget = Readonly<{
  roomId: string;
  kind: NotificationDeepLinkKind;
  targetId: string;
}>;

export function mountNotificationCenterShell(options: Readonly<{
  workspace: HTMLElement;
  bridge: NotificationCenterBridge;
  toolResultAction: NotificationToolResultActionBridge;
  executionResultAction: NotificationExecutionResultActionBridge;
  roomId: string;
  onDeepLink(target: NotificationDeepLinkTarget): void;
  onReauthenticate(): void;
}>): () => void {
  const host = document.createElement("section");
  host.className = "notification-center-host";
  host.setAttribute("aria-label", "应用内通知");
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "notification-center-trigger";
  trigger.textContent = "通知";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  const badge = document.createElement("span");
  badge.className = "notification-center-trigger__badge";
  badge.hidden = true;
  trigger.append(badge);
  const overlay = document.createElement("div");
  overlay.className = "notification-center-overlay";
  overlay.hidden = true;
  host.append(trigger, overlay);
  options.workspace.prepend(host);

  let state: NotificationCenterRemoteState = { status: "loading", recipientActorId: "unavailable" };
  let pageOffset = 0;
  let disposed = false;
  const sourceActionStates = new Map<string, NotificationSourceActionState>();

  const sourceActionErrorStatus = (error: unknown): 401 | 403 | 409 | 410 | 429 | 503 => {
    if (typeof error === "object" && error !== null && "notificationError" in error &&
        isNotificationClosedError(error.notificationError)) return error.notificationError.status;
    return 503;
  };

  const pruneSourceActions = (): void => {
    if (state.status !== "ready") { sourceActionStates.clear(); return; }
    const pending = new Set(state.notifications.filter((item) => !item.handled)
      .map((item) => item.notificationId));
    for (const notificationId of sourceActionStates.keys()) {
      if (!pending.has(notificationId)) sourceActionStates.delete(notificationId);
    }
  };

  const updateTrigger = (): void => {
    const projection = state.status === "ready"
      ? state.roomBadges.find((item) => item.roomId === options.roomId) : undefined;
    const unread = projection?.unreadCount ?? 0;
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? "99+" : String(unread);
    trigger.setAttribute("aria-label", unread === 0 ? "打开通知中心；当前 Room 无未读通知"
      : `打开通知中心；当前 Room ${unread} 条未读通知`);
  };

  const render = (): void => {
    pruneSourceActions();
    updateTrigger();
    if (overlay.hidden) return;
    const rendered = state.status === "ready"
      ? { ...state, page: { ...state.page, offset: pageOffset } }
      : state;
    renderNotificationCenter(overlay, rendered, {
      onMarkRead(notificationId, expectedReadRevision) {
        void options.bridge.markRead({ notificationId, expectedReadRevision }).then((next) => {
          if (!disposed) { state = next; render(); }
        });
      },
      onOpenDeepLink(deepLink) {
        if (state.status !== "ready") return;
        const item = state.notifications.find((candidate) =>
          candidate.deepLink.kind === deepLink.kind && candidate.deepLink.targetId === deepLink.targetId);
        if (item === undefined) return;
        void options.bridge.resolveSource({ notificationId: item.notificationId }).then((result) => {
          if (!disposed && result.status === "available") options.onDeepLink({
            roomId: result.roomId, ...result.deepLink,
          });
        });
      },
      onRetry() {
        void options.bridge.retryRepair().then((next) => {
          if (!disposed) { state = next; pageOffset = 0; render(); }
        });
      },
      onReauthenticate: options.onReauthenticate,
      onRefresh() {
        void options.bridge.list({ roomId: null, before: null, limit: 50 }).then((next) => {
          if (!disposed) { state = next; pageOffset = 0; render(); }
        });
      },
      onRequestClose() {
        overlay.hidden = true; trigger.setAttribute("aria-expanded", "false");
      },
      onPage(offset) {
        if (state.status !== "ready") return;
        if (offset < state.notifications.length) { pageOffset = offset; render(); return; }
        if (state.hasMore !== true || state.notifications.length === 0) return;
        const last = state.notifications.at(-1)!;
        const before: NotificationListCursor = { createdAt: last.createdAt,
          notificationId: last.notificationId };
        void options.bridge.list({ roomId: null, before, limit: state.page.limit }).then((next) => {
          if (!disposed) { state = next; pageOffset = offset; render(); }
        });
      },
      onAcknowledgeToolResult(notificationId) {
        if (sourceActionStates.get(notificationId)?.status === "submitting" ||
            sourceActionStates.get(notificationId)?.status === "acknowledged") return;
        sourceActionStates.set(notificationId, { status: "submitting" }); render();
        void options.toolResultAction.acknowledge({ notificationId }).then(() => {
          if (disposed) return;
          sourceActionStates.set(notificationId, { status: "acknowledged" }); render();
        }).catch((error: unknown) => {
          if (disposed) return;
          sourceActionStates.set(notificationId,
            { status: "failed", errorStatus: sourceActionErrorStatus(error) }); render();
        });
      },
      onAcknowledgeExecutionResult(notificationId) {
        if (sourceActionStates.get(notificationId)?.status === "submitting" ||
            sourceActionStates.get(notificationId)?.status === "acknowledged") return;
        sourceActionStates.set(notificationId, { status: "submitting" }); render();
        void options.executionResultAction.acknowledge({ notificationId }).then(() => {
          if (disposed) return;
          sourceActionStates.set(notificationId, { status: "acknowledged" }); render();
        }).catch((error: unknown) => {
          if (disposed) return;
          sourceActionStates.set(notificationId,
            { status: "failed", errorStatus: sourceActionErrorStatus(error) }); render();
        });
      },
    }, { opener: trigger, sourceActionStates });
  };

  trigger.addEventListener("click", () => {
    overlay.hidden = false; trigger.setAttribute("aria-expanded", "true");
    void options.bridge.getState().then((next) => {
      if (!disposed) { state = next; render(); }
    });
    render();
  });
  const unsubscribe = options.bridge.onStateChanged((next) => {
    if (disposed) return;
    state = next;
    if (state.status !== "ready" || pageOffset >= state.notifications.length) pageOffset = 0;
    render();
  });
  void options.bridge.getState().then((next) => {
    if (!disposed) { state = next; updateTrigger(); }
  });

  return () => {
    if (disposed) return;
    disposed = true; unsubscribe(); host.remove();
  };
}
