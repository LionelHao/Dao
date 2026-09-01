import {
  isNotificationProjection,
  type NotificationDeepLinkKind,
  type NotificationKind,
  type NotificationProjection,
} from "@native-im/core";
import type { NotificationRoomBadgeProjection } from "../../notification-center/replica.js";

export type NotificationCenterConnection =
  | Readonly<{ status: "online" }>
  | Readonly<{ status: "offline"; asOf: string }>
  | Readonly<{ status: "repairing"; watermark: number }>
  | Readonly<{ status: "repair_failed"; code: string }>
  | Readonly<{ status: "archived"; roomIds: readonly string[] }>;
export type NotificationErrorStatus = 401 | 403 | 409 | 410 | 429 | 503;
export type NotificationOperation =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "submitting"; requestId: string; notificationId: string }>
  | Readonly<{ status: "acknowledged"; requestId: string; notificationId: string; readRevision: number }>
  | Readonly<{ status: "failed"; requestId: string; notificationId: string;
      error: Readonly<{ status: NotificationErrorStatus; code: string; retryAfterMs?: number }> }>;
export type NotificationCenterRemoteState =
  | Readonly<{ status: "loading"; recipientActorId: string }>
  | Readonly<{ status: "revoked"; recipientActorId: string;
      reason: "session_revoked" | "membership_revoked" | "lease_expired" }>
  | Readonly<{ status: "ready"; recipientActorId: string;
      notifications: readonly NotificationProjection[];
      roomBadges: readonly NotificationRoomBadgeProjection[];
      sourceResolutions?: readonly Readonly<{
        notificationId: string;
        status: "available" | "recalled";
      }>[];
      connection: NotificationCenterConnection;
      operation: NotificationOperation;
      hasMore?: boolean;
      page: Readonly<{ offset: number; limit: number }> }>;
export type NotificationCenterItem = Readonly<{
  notificationId: string;
  roomId: string;
  notificationKind: NotificationKind;
  sourceKind: NotificationProjection["source"]["sourceKind"];
  title: string;
  actorLabel: string | null;
  createdAt: string;
  read: boolean;
  readRevision: number;
  handled: boolean;
  readLabel: "未读" | "已读";
  handledLabel: "未处理" | "已处理";
  sourceStatus: "available" | "recalled";
  sourceLabel: "打开来源" | "来源已撤回，仅显示 tombstone";
  readDisabled: boolean;
  deepLink: Readonly<{ kind: NotificationDeepLinkKind; targetId: string }>;
}>;
export type NotificationCenterBadge = NotificationRoomBadgeProjection & Readonly<{
  visibleUnreadCount: string;
  accessibleLabel: string;
}>;
export type NotificationCenterRecovery = Readonly<{ status: NotificationErrorStatus; action: string }>;
export type NotificationCenterViewModel = Readonly<{
  status: "loading" | "revoked" | "empty" | "ready";
  recipientActorId: string;
  items: readonly NotificationCenterItem[];
  roomBadges: readonly NotificationCenterBadge[];
  totalCount: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  connection?: NotificationCenterConnection;
  operation?: NotificationOperation;
  writeDisabled: boolean;
  connectionAnnouncement: string;
  operationAnnouncement: string;
  recovery?: NotificationCenterRecovery;
}>;

const TITLES: Readonly<Record<NotificationKind, string>> = Object.freeze({
  human_mention: "Human 在消息中提及你",
  human_request: "Human 向你发出 Request",
  tool_confirmation: "Agent 请求工具确认",
  project_due: "项目责任已到期",
  tool_result: "工具调用已有结果",
  agent_execution_completed: "Agent execution 已完成",
  agent_execution_failed: "Agent execution 已失败",
  cannot_answer_escalation: "问题已升级：cannot answer",
});
function operationMessage(operation: NotificationOperation): string {
  if (operation.status === "idle") return "";
  if (operation.status === "submitting") return "正在提交已读意图；当前 read projection 尚未改变。";
  if (operation.status === "acknowledged") return "服务端已接受已读意图；等待 stable event 收敛。";
  const messages: Readonly<Record<NotificationErrorStatus, string>> = {
    401: "身份已失效，请重新登录；未改变 read。",
    403: "当前通知或 Room 已无访问权限；本地内容将安全移除。",
    409: "通知 read revision 已变化，请载入最新 projection。",
    410: "通知来源已不可访问；不会显示来源标题、正文或 metadata。",
    429: `操作过于频繁，请在 ${Math.max(1, Math.ceil((operation.error.retryAfterMs ?? 1000) / 1000))} 秒后显式重试。`,
    503: "通知服务暂不可用；保留旧完整 projection，稍后显式重试。",
  };
  return messages[operation.error.status];
}
function recovery(operation: NotificationOperation): NotificationCenterRecovery | undefined {
  if (operation.status !== "failed") return undefined;
  const actions: Readonly<Record<NotificationErrorStatus, string>> = {
    401: "reauthenticate", 403: "refresh", 409: "refresh", 410: "refresh",
    429: "retry", 503: "retry",
  };
  return Object.freeze({ status: operation.error.status, action: actions[operation.error.status] });
}
function connectionMessage(connection: NotificationCenterConnection): string {
  if (connection.status === "online") return "通知 projection 已同步。";
  if (connection.status === "offline") return `离线只读；显示 ${connection.asOf} 的最后完整、仍获授权 cache。`;
  if (connection.status === "repairing") return `repair 进行中；固定 watermark ${connection.watermark}，继续显示旧完整 projection。`;
  if (connection.status === "repair_failed") return "repair 失败；新 staging 未提交，继续显示旧完整 projection。";
  return "部分通知来自已归档 Room；已有项只读，不产生新业务通知。";
}
function toItem(value: NotificationProjection, sourceStatus: "available" | "recalled",
  readDisabled: boolean): NotificationCenterItem {
  return Object.freeze({ notificationId: value.notificationId, roomId: value.roomId,
    notificationKind: value.notificationKind, sourceKind: value.source.sourceKind,
    title: TITLES[value.safeProjection.titleKey],
    actorLabel: value.safeProjection.actorId, createdAt: value.createdAt,
    read: value.readAt !== null, readRevision: value.readRevision, handled: value.handled,
    readLabel: value.readAt === null ? "未读" : "已读",
    handledLabel: value.handled ? "已处理" : "未处理",
    sourceStatus,
    sourceLabel: sourceStatus === "recalled" ? "来源已撤回，仅显示 tombstone" : "打开来源",
    readDisabled,
    deepLink: Object.freeze({ ...value.deepLink }) });
}
function toBadge(value: NotificationRoomBadgeProjection): NotificationCenterBadge {
  return Object.freeze({ ...value, visibleUnreadCount: value.unreadCount > 99 ? "99+" : String(value.unreadCount),
    accessibleLabel: `Room ${value.roomId}，${value.unreadCount} 条未读，${value.unhandledCount} 条未处理` });
}

export function createNotificationCenterViewModel(state: NotificationCenterRemoteState): NotificationCenterViewModel {
  if (state.status === "loading") return Object.freeze({ status: "loading", recipientActorId: state.recipientActorId,
    items: [], roomBadges: [], totalCount: 0, hasPreviousPage: false, hasNextPage: false,
    writeDisabled: true, connectionAnnouncement: "正在载入 recipient notification projection。",
    operationAnnouncement: "" });
  if (state.status === "revoked") return Object.freeze({ status: "revoked", recipientActorId: state.recipientActorId,
    items: [], roomBadges: [], totalCount: 0, hasPreviousPage: false, hasNextPage: false,
    writeDisabled: true, connectionAnnouncement: "通知访问已撤销；本地 recipient projection 已清除。",
    operationAnnouncement: "" });
  if (!Number.isSafeInteger(state.page.offset) || state.page.offset < 0 ||
      !Number.isSafeInteger(state.page.limit) || state.page.limit < 1 || state.page.limit > 50 ||
      state.notifications.some((value) => !isNotificationProjection(value) ||
        value.recipientActorId !== state.recipientActorId)) {
    throw new TypeError("Notification center requires a bounded recipient-scoped projection");
  }
  const hiddenNotificationId = state.operation.status === "failed" &&
    (state.operation.error.status === 403 || state.operation.error.status === 410)
    ? state.operation.notificationId : undefined;
  const visibleNotifications = state.operation.status === "failed" && state.operation.error.status === 401
    ? [] : state.notifications.filter(({ notificationId }) => notificationId !== hiddenNotificationId);
  const hiddenRoomId = hiddenNotificationId === undefined ? undefined
    : state.notifications.find(({ notificationId }) => notificationId === hiddenNotificationId)?.roomId;
  const archivedRoomIds = new Set(state.connection.status === "archived" ? state.connection.roomIds : []);
  const sourceResolutions = new Map(state.sourceResolutions?.map((value) =>
    [value.notificationId, value.status] as const) ?? []);
  const page = visibleNotifications.slice(state.page.offset, state.page.offset + state.page.limit)
    .map((value) => toItem(value, sourceResolutions.get(value.notificationId) ?? "available",
      archivedRoomIds.has(value.roomId)));
  const status = visibleNotifications.length === 0 ? "empty" : "ready";
  return Object.freeze({ status, recipientActorId: state.recipientActorId,
    items: Object.freeze(page), roomBadges: Object.freeze((state.operation.status === "failed" &&
      state.operation.error.status === 401 ? [] : state.roomBadges.filter(({ roomId }) => roomId !== hiddenRoomId))
      .map(toBadge)),
    totalCount: visibleNotifications.length, hasPreviousPage: state.page.offset > 0,
    hasNextPage: state.page.offset + state.page.limit < visibleNotifications.length || state.hasMore === true,
    connection: state.connection, operation: state.operation,
    writeDisabled: state.connection.status !== "online" && state.connection.status !== "archived" ||
      state.operation.status === "submitting" ||
      state.operation.status === "failed" && [401, 403, 410].includes(state.operation.error.status),
    connectionAnnouncement: connectionMessage(state.connection),
    operationAnnouncement: operationMessage(state.operation),
    ...(recovery(state.operation) === undefined ? {} : { recovery: recovery(state.operation)! }) });
}
