import { isNotificationProjection, type NotificationProjection } from "@native-im/core";

export const NOTIFICATION_TOOL_RESULT_IPC_CHANNELS = Object.freeze({
  acknowledge: "notification-tool-result:acknowledge",
} as const);

export type NotificationToolResultAcknowledgeIntent = Readonly<{ notificationId: string }>;
export type NotificationToolResultAcknowledgeCommand = NotificationToolResultAcknowledgeIntent & Readonly<{
  type: "notification.tool-result.acknowledge";
  requestId: string;
}>;
export type NotificationToolResultAcknowledgeWireResult = Readonly<{
  type: "notification.tool-result.ack";
  requestId: string;
  outcome: "acknowledged" | "already_acknowledged";
  projection: NotificationProjection;
}>;
export type NotificationToolResultAcknowledgeResult = Readonly<{
  notificationId: string;
  outcome: "acknowledged" | "already_acknowledged";
}>;

export interface NotificationToolResultActionBridge {
  acknowledge(intent: NotificationToolResultAcknowledgeIntent):
    Promise<NotificationToolResultAcknowledgeResult>;
}

type UnknownRecord = Record<string, unknown>;
function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim();
}

export function isNotificationToolResultAcknowledgeIntent(
  value: unknown,
): value is NotificationToolResultAcknowledgeIntent {
  return record(value) && exact(value, ["notificationId"]) && id(value.notificationId);
}

export function isNotificationToolResultAcknowledgeWireResult(
  value: unknown,
): value is NotificationToolResultAcknowledgeWireResult {
  return record(value) && exact(value, ["type", "requestId", "outcome", "projection"]) &&
    value.type === "notification.tool-result.ack" && id(value.requestId) &&
    (value.outcome === "acknowledged" || value.outcome === "already_acknowledged") &&
    isNotificationProjection(value.projection);
}

export function isNotificationToolResultAcknowledgeResult(
  value: unknown,
): value is NotificationToolResultAcknowledgeResult {
  return record(value) && exact(value, ["notificationId", "outcome"]) && id(value.notificationId) &&
    (value.outcome === "acknowledged" || value.outcome === "already_acknowledged");
}

export function cloneNotificationToolResultAcknowledgeResult(
  value: unknown,
): NotificationToolResultAcknowledgeResult {
  if (!isNotificationToolResultAcknowledgeResult(value)) {
    throw new TypeError("Invalid notification tool-result acknowledge result");
  }
  return Object.freeze({ ...value });
}
