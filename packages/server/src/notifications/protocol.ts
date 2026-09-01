import {
  isNotificationExecutionResultAcknowledgeAck,
  isNotificationExecutionResultAcknowledgeCommand,
  isNotificationProjection,
  isNotificationReadAck,
  isNotificationRoomBadge,
  type NotificationProjection,
  type NotificationReadAck,
  type NotificationRoomBadge,
  type NotificationExecutionResultAcknowledgeAck,
  type NotificationExecutionResultAcknowledgeCommand,
} from "@native-im/core";

export type NotificationClientFrame =
  | Readonly<{ type: "notification.list"; requestId: string; roomId: string | null;
      before: Readonly<{ createdAt: string; notificationId: string }> | null; limit: number }>
  | Readonly<{ type: "notification.mark-read"; requestId: string; notificationId: string;
      expectedReadRevision: number }>
  | Readonly<{ type: "notification.source.resolve"; requestId: string;
      notificationId: string }>
  | Readonly<{ type: "notification.tool-result.acknowledge"; requestId: string;
      notificationId: string }>
  | NotificationExecutionResultAcknowledgeCommand;

export type NotificationServerFrame =
  | Readonly<{ type: "notification.list.result"; requestId: string;
      notifications: readonly NotificationProjection[]; hasMore: boolean;
      roomBadges: readonly NotificationRoomBadge[]; identityWatermark: number }>
  | NotificationReadAck
  | Readonly<{ type: "notification.source.result"; requestId: string;
      projection: NotificationProjection }>
  | Readonly<{ type: "notification.tool-result.ack"; requestId: string;
      outcome: "acknowledged" | "already_acknowledged";
      projection: NotificationProjection }>
  | NotificationExecutionResultAcknowledgeAck;

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: UnknownRecord, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) =>
    typeof key === "string" && keys.includes(key));
};
const id = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 256;
const timestamp = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const integer = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) && value >= 0;

export function isNotificationFrameType(value: unknown): value is NotificationClientFrame["type"] {
  return value === "notification.list" || value === "notification.mark-read" ||
    value === "notification.source.resolve" ||
    value === "notification.tool-result.acknowledge" ||
    value === "notification.execution-result.acknowledge";
}

export function parseNotificationClientFrame(value: unknown):
  Readonly<{ ok: true; frame: NotificationClientFrame }> |
  Readonly<{ ok: false; requestId?: string }> {
  const requestId = record(value) && id(value.requestId) ? value.requestId : undefined;
  if (!record(value) || !isNotificationFrameType(value.type)) {
    return Object.freeze({ ok: false, ...(requestId === undefined ? {} : { requestId }) });
  }
  if (value.type === "notification.execution-result.acknowledge") {
    return isNotificationExecutionResultAcknowledgeCommand(value)
      ? Object.freeze({ ok: true, frame: value })
      : Object.freeze({ ok: false, ...(requestId === undefined ? {} : { requestId }) });
  }
  if (value.type === "notification.list") {
    const before = value.before;
    const valid = exact(value, ["type", "requestId", "roomId", "before", "limit"]) &&
      id(value.requestId) && (value.roomId === null || id(value.roomId)) &&
      (before === null || (record(before) && exact(before, ["createdAt", "notificationId"]) &&
        timestamp(before.createdAt) && id(before.notificationId))) &&
      integer(value.limit) && value.limit >= 1 && value.limit <= 256;
    return valid ? Object.freeze({ ok: true, frame: value as unknown as NotificationClientFrame }) :
      Object.freeze({ ok: false, ...(requestId === undefined ? {} : { requestId }) });
  }
  if (value.type === "notification.mark-read") {
    const valid = exact(value, ["type", "requestId", "notificationId",
      "expectedReadRevision"]) && id(value.requestId) && id(value.notificationId) &&
      integer(value.expectedReadRevision);
    return valid ? Object.freeze({ ok: true, frame: value as unknown as NotificationClientFrame }) :
      Object.freeze({ ok: false, ...(requestId === undefined ? {} : { requestId }) });
  }
  const valid = exact(value, ["type", "requestId", "notificationId"]) &&
    id(value.requestId) && id(value.notificationId);
  return valid ? Object.freeze({ ok: true, frame: value as unknown as NotificationClientFrame }) :
    Object.freeze({ ok: false, ...(requestId === undefined ? {} : { requestId }) });
}

export function isNotificationServerFrame(value: unknown): value is NotificationServerFrame {
  if (isNotificationReadAck(value) || isNotificationExecutionResultAcknowledgeAck(value)) return true;
  if (!record(value)) return false;
  if (value.type === "notification.list.result") {
    return exact(value, ["type", "requestId", "notifications", "hasMore", "roomBadges",
      "identityWatermark"]) &&
      id(value.requestId) && Array.isArray(value.notifications) &&
      value.notifications.every(isNotificationProjection) && typeof value.hasMore === "boolean" &&
      Array.isArray(value.roomBadges) && value.roomBadges.every(isNotificationRoomBadge) &&
      integer(value.identityWatermark);
  }
  if (value.type === "notification.source.result") {
    return exact(value, ["type", "requestId", "projection"]) && id(value.requestId) &&
      isNotificationProjection(value.projection);
  }
  return value.type === "notification.tool-result.ack" &&
    exact(value, ["type", "requestId", "outcome", "projection"]) && id(value.requestId) &&
    (value.outcome === "acknowledged" || value.outcome === "already_acknowledged") &&
    isNotificationProjection(value.projection);
}
