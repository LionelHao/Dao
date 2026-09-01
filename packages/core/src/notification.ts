import { isIsoUtcTimestamp } from "./message-authority.js";

export const NOTIFICATION_KINDS = Object.freeze([
  "human_mention",
  "human_request",
  "tool_confirmation",
  "project_due",
  "tool_result",
  "agent_execution_completed",
  "agent_execution_failed",
  "cannot_answer_escalation",
] as const);

export const NOTIFICATION_SOURCE_KINDS = Object.freeze([
  "message_mention",
  "project_request",
  "tool_confirmation",
  "project_boundary",
  "tool_call",
  "agent_execution",
  "project_obstacle",
] as const);

export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type NotificationSourceKind = typeof NOTIFICATION_SOURCE_KINDS[number];

export type NotificationSourceBinding = Readonly<{
  sourceKind: NotificationSourceKind;
  sourceId: string;
  sourceRevision: number;
  sourceBoundaryId: string;
  ordinal: number;
}>;

export type NotificationDeepLinkKind =
  | "message" | "request" | "confirmation" | "project_boundary"
  | "tool_call" | "agent_execution" | "project_obstacle";

export type NotificationProjection = Readonly<{
  recordVersion: "notification.v1";
  notificationId: string;
  roomId: string;
  recipientActorId: string;
  notificationKind: NotificationKind;
  source: NotificationSourceBinding;
  dedupeKey: string;
  createdAt: string;
  readAt: string | null;
  readRevision: number;
  handled: boolean;
  handledAt: string | null;
  sourceAccessible: true;
  deepLink: Readonly<{ kind: NotificationDeepLinkKind; targetId: string }>;
  safeProjection: Readonly<{ titleKey: NotificationKind; actorId: string | null }>;
}>;

export type NotificationRoomBadge = Readonly<{
  roomId: string;
  unreadCount: number;
  unhandledCount: number;
}>;

export type NotificationRepairRecord = Readonly<{
  kind: "notification";
  value: NotificationProjection;
}>;

export type NotificationRevocationReason = "membership_revoked" | "source_inaccessible";

export type NotificationRevocation = Readonly<{
  notificationId: string;
  roomId: string;
  recipientActorId: string;
  reason: NotificationRevocationReason;
}>;

type NotificationProjectionEventType =
  | "notification.created" | "notification.read" | "notification.handled";

export type NotificationStableEvent =
  | Readonly<{
      eventId: string;
      streamKind: "identity";
      streamId: string;
      streamSeq: number;
      type: NotificationProjectionEventType;
      occurredAt: string;
      payload: NotificationProjection;
    }>
  | Readonly<{
      eventId: string;
      streamKind: "identity";
      streamId: string;
      streamSeq: number;
      type: "notification.revoked";
      occurredAt: string;
      payload: NotificationRevocation;
    }>;

export type NotificationReadAck = Readonly<{
  type: "notification.read.ack";
  requestId: string;
  notificationId: string;
  roomId: string;
  recipientActorId: string;
  outcome: "read" | "already_read";
  readAt: string;
  readRevision: number;
  eventId: string;
}>;

export type NotificationExecutionResultAcknowledgeCommand = Readonly<{
  type: "notification.execution-result.acknowledge";
  requestId: string;
  notificationId: string;
}>;

export type NotificationExecutionResultAcknowledgeAck = Readonly<{
  type: "notification.execution-result.ack";
  requestId: string;
  outcome: "acknowledged" | "already_acknowledged";
  projection: NotificationProjection;
}>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) =>
    typeof key === "string" && keys.includes(key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" &&
    NOTIFICATION_KINDS.includes(value as NotificationKind);
}

function isNotificationSourceKind(value: unknown): value is NotificationSourceKind {
  return typeof value === "string" &&
    NOTIFICATION_SOURCE_KINDS.includes(value as NotificationSourceKind);
}

const deepLinkForSource: Readonly<Record<NotificationSourceKind, NotificationDeepLinkKind>> =
  Object.freeze({
    message_mention: "message",
    project_request: "request",
    tool_confirmation: "confirmation",
    project_boundary: "project_boundary",
    tool_call: "tool_call",
    agent_execution: "agent_execution",
    project_obstacle: "project_obstacle",
  });

function isSource(value: unknown): value is NotificationSourceBinding {
  return record(value) && exact(value, [
    "sourceKind", "sourceId", "sourceRevision", "sourceBoundaryId", "ordinal",
  ]) && isNotificationSourceKind(value.sourceKind) && identifier(value.sourceId) &&
    nonNegativeInteger(value.sourceRevision) && identifier(value.sourceBoundaryId) &&
    nonNegativeInteger(value.ordinal);
}

function isDeepLink(value: unknown, source: NotificationSourceBinding): boolean {
  return record(value) && exact(value, ["kind", "targetId"]) &&
    value.kind === deepLinkForSource[source.sourceKind] && identifier(value.targetId) &&
    value.targetId === source.sourceId;
}

function isSafeProjection(value: unknown, kind: NotificationKind): boolean {
  return record(value) && exact(value, ["titleKey", "actorId"]) &&
    value.titleKey === kind && (value.actorId === null || identifier(value.actorId));
}

export function isNotificationProjection(value: unknown): value is NotificationProjection {
  if (!record(value) || !exact(value, [
    "recordVersion", "notificationId", "roomId", "recipientActorId", "notificationKind",
    "source", "dedupeKey", "createdAt", "readAt", "readRevision", "handled",
    "handledAt", "sourceAccessible", "deepLink", "safeProjection",
  ]) || value.recordVersion !== "notification.v1" || !identifier(value.notificationId) ||
      !identifier(value.roomId) || !identifier(value.recipientActorId) ||
      !isNotificationKind(value.notificationKind) || !isSource(value.source) ||
      typeof value.dedupeKey !== "string" || !/^[a-f0-9]{64}$/u.test(value.dedupeKey) ||
      !isIsoUtcTimestamp(value.createdAt) || typeof value.handled !== "boolean" ||
      value.sourceAccessible !== true || !isDeepLink(value.deepLink, value.source) ||
      !isSafeProjection(value.safeProjection, value.notificationKind)) return false;

  const validRead = value.readAt === null
    ? value.readRevision === 0
    : isIsoUtcTimestamp(value.readAt) && positiveInteger(value.readRevision);
  const validHandled = value.handled
    ? isIsoUtcTimestamp(value.handledAt)
    : value.handledAt === null;
  return validRead && validHandled;
}

export function isNotificationRoomBadge(value: unknown): value is NotificationRoomBadge {
  return record(value) && exact(value, ["roomId", "unreadCount", "unhandledCount"]) &&
    identifier(value.roomId) && nonNegativeInteger(value.unreadCount) &&
    nonNegativeInteger(value.unhandledCount);
}

export function isNotificationRepairRecord(value: unknown): value is NotificationRepairRecord {
  return record(value) && exact(value, ["kind", "value"]) &&
    value.kind === "notification" && isNotificationProjection(value.value);
}

function isNotificationRevocation(value: unknown): value is NotificationRevocation {
  return record(value) && exact(value, [
    "notificationId", "roomId", "recipientActorId", "reason",
  ]) && identifier(value.notificationId) && identifier(value.roomId) &&
    identifier(value.recipientActorId) &&
    (value.reason === "membership_revoked" || value.reason === "source_inaccessible");
}

export function isNotificationStableEvent(value: unknown): value is NotificationStableEvent {
  if (!record(value) || !exact(value, [
    "eventId", "streamKind", "streamId", "streamSeq", "type", "occurredAt", "payload",
  ]) || !identifier(value.eventId) || value.streamKind !== "identity" ||
      !identifier(value.streamId) || !positiveInteger(value.streamSeq) ||
      !isIsoUtcTimestamp(value.occurredAt)) return false;
  if (value.type === "notification.revoked") {
    return isNotificationRevocation(value.payload) &&
      value.payload.recipientActorId === value.streamId;
  }
  return (value.type === "notification.created" || value.type === "notification.read" ||
    value.type === "notification.handled") && isNotificationProjection(value.payload) &&
    value.payload.recipientActorId === value.streamId;
}

export function isNotificationReadAck(value: unknown): value is NotificationReadAck {
  return record(value) && exact(value, [
    "type", "requestId", "notificationId", "roomId", "recipientActorId", "outcome",
    "readAt", "readRevision", "eventId",
  ]) && value.type === "notification.read.ack" && identifier(value.requestId) &&
    identifier(value.notificationId) && identifier(value.roomId) &&
    identifier(value.recipientActorId) &&
    (value.outcome === "read" || value.outcome === "already_read") &&
    isIsoUtcTimestamp(value.readAt) && positiveInteger(value.readRevision) &&
    identifier(value.eventId);
}

export function isNotificationExecutionResultAcknowledgeCommand(
  value: unknown,
): value is NotificationExecutionResultAcknowledgeCommand {
  return record(value) && exact(value, ["type", "requestId", "notificationId"]) &&
    value.type === "notification.execution-result.acknowledge" &&
    identifier(value.requestId) && identifier(value.notificationId);
}

export function isNotificationExecutionResultAcknowledgeAck(
  value: unknown,
): value is NotificationExecutionResultAcknowledgeAck {
  if (!record(value) || !exact(value, ["type", "requestId", "outcome", "projection"]) ||
      value.type !== "notification.execution-result.ack" || !identifier(value.requestId) ||
      (value.outcome !== "acknowledged" && value.outcome !== "already_acknowledged") ||
      !isNotificationProjection(value.projection)) return false;
  return value.projection.source.sourceKind === "agent_execution" &&
    (value.projection.notificationKind === "agent_execution_completed" ||
      value.projection.notificationKind === "agent_execution_failed") &&
    value.projection.handled && value.projection.handledAt !== null;
}
