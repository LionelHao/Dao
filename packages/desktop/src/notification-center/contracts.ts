import {
  isNotificationProjection,
  isNotificationReadAck,
  type NotificationDeepLinkKind,
  type NotificationProjection,
  type NotificationReadAck,
  type NotificationStableEvent,
} from "@native-im/core";
import type { NotificationCenterRemoteState } from "../renderer/notification-center/view-model.js";
import type { NotificationRoomBadgeProjection } from "./replica.js";

export const NOTIFICATION_CENTER_IPC_CHANNELS = Object.freeze({
  getState: "notification-center:get-state",
  list: "notification-center:list",
  markRead: "notification-center:mark-read",
  resolveSource: "notification-center:resolve-source",
  retryRepair: "notification-center:retry-repair",
  stateChanged: "notification-center:state-changed",
} as const);

export type NotificationListCursor = Readonly<{
  createdAt: string;
  notificationId: string;
}>;

export type NotificationListQuery = Readonly<{
  roomId: string | null;
  before: NotificationListCursor | null;
  limit: number;
}>;

export type NotificationMarkReadIntent = Readonly<{
  notificationId: string;
  expectedReadRevision: number;
}>;

export type NotificationResolveSourceIntent = Readonly<{
  notificationId: string;
}>;

export type NotificationListCommand = NotificationListQuery & Readonly<{
  type: "notification.list";
  requestId: string;
}>;

export type NotificationMarkReadCommand = NotificationMarkReadIntent & Readonly<{
  type: "notification.mark-read";
  requestId: string;
}>;

export type NotificationResolveSourceCommand = NotificationResolveSourceIntent & Readonly<{
  type: "notification.source.resolve";
  requestId: string;
}>;

export type NotificationListWireResult = Readonly<{
  type: "notification.list.result";
  requestId: string;
  notifications: readonly NotificationProjection[];
  roomBadges: readonly NotificationRoomBadgeProjection[];
  hasMore: boolean;
  /** Principal-stream position that makes the list and subsequent stable events contiguous. */
  identityWatermark: number;
}>;

export type NotificationSourceWireResult = Readonly<{
  type: "notification.source.result";
  requestId: string;
  projection: NotificationProjection;
}>;

export type NotificationClosedStatus = 401 | 403 | 409 | 410 | 429 | 503;

export type NotificationClosedError = Readonly<{
  status: NotificationClosedStatus;
  code: "authentication_required" | "notification_forbidden" |
    "notification_revision_conflict" | "notification_gone" |
    "notification_source_gone" | "rate_limited" | "storage_unavailable";
  retryAfterMs?: number;
}>;

export function isNotificationClosedError(value: unknown): value is NotificationClosedError {
  return record(value) && exact(value, ["status", "code"], ["retryAfterMs"]) &&
    [401, 403, 409, 410, 429, 503].includes(Number(value.status)) && [
      "authentication_required", "notification_forbidden", "notification_revision_conflict",
      "notification_gone", "notification_source_gone", "rate_limited", "storage_unavailable",
    ].includes(String(value.code)) && (value.retryAfterMs === undefined ||
      nonNegativeInteger(value.retryAfterMs));
}

export type NotificationSourceResolution =
  | Readonly<{ status: "available"; notificationId: string;
      roomId: string;
      deepLink: Readonly<{ kind: NotificationDeepLinkKind; targetId: string }> }>
  | Readonly<{ status: "inaccessible"; notificationId: string }>;

export interface NotificationCenterBridge {
  getState(): Promise<NotificationCenterRemoteState>;
  list(query: NotificationListQuery): Promise<NotificationCenterRemoteState>;
  markRead(intent: NotificationMarkReadIntent): Promise<NotificationCenterRemoteState>;
  resolveSource(intent: NotificationResolveSourceIntent): Promise<NotificationSourceResolution>;
  retryRepair(): Promise<NotificationCenterRemoteState>;
  onStateChanged(listener: (state: NotificationCenterRemoteState) => void): () => void;
}

export type NotificationAuthorityInput =
  | Readonly<{ type: "notification.state"; state: NotificationCenterRemoteState }>
  | Readonly<{ type: "notification.stable-event"; event: NotificationStableEvent }>;

type UnknownRecord = Record<string, unknown>;
const encoder = new TextEncoder();

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 &&
    encoder.encode(value).byteLength <= 256;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isNotificationListQuery(value: unknown): value is NotificationListQuery {
  if (!record(value) || !exact(value, ["roomId", "before", "limit"]) ||
      !(value.roomId === null || identifier(value.roomId)) ||
      !nonNegativeInteger(value.limit) || value.limit < 1 || value.limit > 50) return false;
  return value.before === null || record(value.before) &&
    exact(value.before, ["createdAt", "notificationId"]) &&
    timestamp(value.before.createdAt) && identifier(value.before.notificationId);
}

export function isNotificationMarkReadIntent(value: unknown): value is NotificationMarkReadIntent {
  return record(value) && exact(value, ["notificationId", "expectedReadRevision"]) &&
    identifier(value.notificationId) && nonNegativeInteger(value.expectedReadRevision);
}

export function isNotificationResolveSourceIntent(value: unknown): value is NotificationResolveSourceIntent {
  return record(value) && exact(value, ["notificationId"]) && identifier(value.notificationId);
}

export function isNotificationListWireResult(value: unknown): value is NotificationListWireResult {
  return record(value) && exact(value, [
    "type", "requestId", "notifications", "roomBadges", "hasMore", "identityWatermark",
  ]) &&
    value.type === "notification.list.result" && identifier(value.requestId) &&
    Array.isArray(value.notifications) && value.notifications.length <= 50 &&
    value.notifications.every(isNotificationProjection) && validBadges(value.roomBadges) &&
    typeof value.hasMore === "boolean" && nonNegativeInteger(value.identityWatermark);
}

export function isNotificationSourceWireResult(value: unknown): value is NotificationSourceWireResult {
  return record(value) && exact(value, ["type", "requestId", "projection"]) &&
    value.type === "notification.source.result" && identifier(value.requestId) &&
    isNotificationProjection(value.projection);
}

export function cloneNotificationListWireResult(value: unknown): NotificationListWireResult {
  if (!isNotificationListWireResult(value)) throw new TypeError("Invalid notification list result");
  return structuredClone(value);
}

export function cloneNotificationReadAck(value: unknown): NotificationReadAck {
  if (!isNotificationReadAck(value)) throw new TypeError("Invalid notification read ACK");
  return structuredClone(value);
}

export function cloneNotificationSourceWireResult(value: unknown): NotificationSourceWireResult {
  if (!isNotificationSourceWireResult(value)) throw new TypeError("Invalid notification source result");
  return structuredClone(value);
}

function validConnection(value: unknown): boolean {
  if (!record(value) || typeof value.status !== "string") return false;
  if (value.status === "online") return exact(value, ["status"]);
  if (value.status === "offline") return exact(value, ["status", "asOf"]) && timestamp(value.asOf);
  if (value.status === "repairing") return exact(value, ["status", "watermark"]) &&
    nonNegativeInteger(value.watermark);
  if (value.status === "repair_failed") return exact(value, ["status", "code"]) && identifier(value.code);
  return value.status === "archived" && exact(value, ["status", "roomIds"]) &&
    Array.isArray(value.roomIds) && value.roomIds.length <= 512 && value.roomIds.every(identifier);
}

function validOperation(value: unknown): boolean {
  if (!record(value) || typeof value.status !== "string") return false;
  if (value.status === "idle") return exact(value, ["status"]);
  if (value.status === "submitting") {
    return exact(value, ["status", "requestId", "notificationId"]) &&
      identifier(value.requestId) && identifier(value.notificationId);
  }
  if (value.status === "acknowledged") {
    return exact(value, ["status", "requestId", "notificationId", "readRevision"]) &&
      identifier(value.requestId) && identifier(value.notificationId) &&
      nonNegativeInteger(value.readRevision) && value.readRevision > 0;
  }
  return value.status === "failed" && exact(value, ["status", "requestId", "notificationId", "error"]) &&
    identifier(value.requestId) && identifier(value.notificationId) && record(value.error) &&
    exact(value.error, ["status", "code"], ["retryAfterMs"]) &&
    [401, 403, 409, 410, 429, 503].includes(Number(value.error.status)) &&
    identifier(value.error.code) && (value.error.retryAfterMs === undefined ||
      nonNegativeInteger(value.error.retryAfterMs));
}

function validBadges(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 512 && value.every((item) =>
    record(item) && exact(item, ["roomId", "unreadCount", "unhandledCount"]) &&
    identifier(item.roomId) && nonNegativeInteger(item.unreadCount) &&
    nonNegativeInteger(item.unhandledCount));
}

export function isNotificationCenterRemoteState(value: unknown): value is NotificationCenterRemoteState {
  if (!record(value) || typeof value.status !== "string" || !identifier(value.recipientActorId)) return false;
  if (value.status === "loading") return exact(value, ["status", "recipientActorId"]);
  if (value.status === "revoked") return exact(value, ["status", "recipientActorId", "reason"]) &&
    ["session_revoked", "membership_revoked", "lease_expired"].includes(String(value.reason));
  return value.status === "ready" && exact(value, [
    "status", "recipientActorId", "notifications", "roomBadges", "connection", "operation", "page",
  ], ["sourceResolutions", "hasMore"]) && Array.isArray(value.notifications) &&
    value.notifications.length <= 10_000 && value.notifications.every(isNotificationProjection) &&
    value.notifications.every((item) => item.recipientActorId === value.recipientActorId) &&
    validBadges(value.roomBadges) && validConnection(value.connection) && validOperation(value.operation) &&
    (value.hasMore === undefined || typeof value.hasMore === "boolean") &&
    record(value.page) && exact(value.page, ["offset", "limit"]) &&
    nonNegativeInteger(value.page.offset) && nonNegativeInteger(value.page.limit) &&
    value.page.limit >= 1 && value.page.limit <= 50 &&
    (value.sourceResolutions === undefined || Array.isArray(value.sourceResolutions) &&
      value.sourceResolutions.length <= 10_000 && value.sourceResolutions.every((item) =>
        record(item) && exact(item, ["notificationId", "status"]) &&
        identifier(item.notificationId) && (item.status === "available" || item.status === "recalled")));
}

export function cloneNotificationCenterRemoteState(value: unknown): NotificationCenterRemoteState {
  if (!isNotificationCenterRemoteState(value)) throw new TypeError("Invalid notification center state");
  return structuredClone(value);
}

export function isNotificationSourceResolution(value: unknown): value is NotificationSourceResolution {
  if (!record(value) || !identifier(value.notificationId) ||
      (value.status !== "available" && value.status !== "inaccessible")) return false;
  if (value.status === "inaccessible") return exact(value, ["status", "notificationId"]);
  return exact(value, ["status", "notificationId", "roomId", "deepLink"]) &&
    identifier(value.roomId) && record(value.deepLink) &&
    exact(value.deepLink, ["kind", "targetId"]) &&
    ["message", "request", "confirmation", "project_boundary", "tool_call",
      "agent_execution", "project_obstacle"].includes(String(value.deepLink.kind)) &&
    identifier(value.deepLink.targetId);
}

export function cloneNotificationSourceResolution(value: unknown): NotificationSourceResolution {
  if (!isNotificationSourceResolution(value)) throw new TypeError("Invalid notification source resolution");
  return structuredClone(value);
}
