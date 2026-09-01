export const NOTIFICATION_EXECUTION_RESULT_IPC_CHANNELS = Object.freeze({
  acknowledge: "notification-execution-result:acknowledge",
} as const);

export type NotificationExecutionResultAcknowledgeIntent = Readonly<{ notificationId: string }>;
export type NotificationExecutionResultAcknowledgeResult = Readonly<{
  notificationId: string;
  outcome: "acknowledged" | "already_acknowledged";
}>;

export interface NotificationExecutionResultActionBridge {
  acknowledge(intent: NotificationExecutionResultAcknowledgeIntent):
    Promise<NotificationExecutionResultAcknowledgeResult>;
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

export function isNotificationExecutionResultAcknowledgeIntent(
  value: unknown,
): value is NotificationExecutionResultAcknowledgeIntent {
  return record(value) && exact(value, ["notificationId"]) && id(value.notificationId);
}

export function isNotificationExecutionResultAcknowledgeResult(
  value: unknown,
): value is NotificationExecutionResultAcknowledgeResult {
  return record(value) && exact(value, ["notificationId", "outcome"]) && id(value.notificationId) &&
    (value.outcome === "acknowledged" || value.outcome === "already_acknowledged");
}

export function cloneNotificationExecutionResultAcknowledgeResult(
  value: unknown,
): NotificationExecutionResultAcknowledgeResult {
  if (!isNotificationExecutionResultAcknowledgeResult(value)) {
    throw new TypeError("Invalid notification execution-result acknowledge result");
  }
  return Object.freeze({ ...value });
}
