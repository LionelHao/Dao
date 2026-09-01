import {
  isNotificationProjection,
  isNotificationReadAck,
  isNotificationRoomBadge,
  type NotificationProjection,
  type NotificationReadAck,
  type NotificationRoomBadge,
} from "@native-im/core";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import type { NotificationSourceTerminal } from "./domain.js";

export type NotificationAuthorityOperation =
  | Readonly<{ type: "notification.create"; fact: NotificationProjection }>
  | Readonly<{ type: "notification.list"; context: AuthenticatedSessionContext;
      roomId: string | null; before: Readonly<{ createdAt: string; notificationId: string }> | null;
      limit: number; now: number }>
  | Readonly<{ type: "notification.mark-read"; context: AuthenticatedSessionContext;
      commandRequestId: string; notificationId: string; expectedReadRevision: number;
      occurredAt: string; now: number }>
  | Readonly<{ type: "notification.resolve-source"; context: AuthenticatedSessionContext;
      notificationId: string; now: number }>
  | Readonly<{ type: "notification.acknowledge-tool-result";
      context: AuthenticatedSessionContext; commandRequestId: string;
      notificationId: string; occurredAt: string; now: number }>
  | Readonly<{ type: "notification.acknowledge-execution-result";
      context: AuthenticatedSessionContext; commandRequestId: string;
      notificationId: string; occurredAt: string; now: number }>
  | Readonly<{ type: "notification.source-handled"; notificationId: string;
      sourceBoundaryId: string; sourceTerminal: NotificationSourceTerminal; occurredAt: string }>
  | Readonly<{ type: "notification.recover-source-revocations"; roomId: string;
      sourceKind: "message_mention"; sourceId: string; limit: number }>
  | Readonly<{ type: "notification.revoke-recipient"; roomId: string;
      recipientActorId: string; reason: "membership_revoked" | "source_inaccessible";
      revokedAt: string; limit: number }>;

export type NotificationAuthorityFailure = Readonly<{
  kind: "failure";
  code: "unauthenticated" | "forbidden" | "not_found" | "source_inaccessible" |
    "revision_conflict" | "room_archived" | "invalid_request";
  status: 400 | 401 | 403 | 404 | 409 | 410;
}>;

export type NotificationAuthorityResult =
  | Readonly<{ kind: "created" | "duplicate"; projection: NotificationProjection;
      eventId: string; streamSeq: number }>
  | Readonly<{ kind: "list"; notifications: readonly NotificationProjection[];
      hasMore: boolean; roomBadges: readonly NotificationRoomBadge[];
      identityWatermark: number }>
  | Readonly<{ kind: "read"; ack: NotificationReadAck }>
  | Readonly<{ kind: "source"; projection: NotificationProjection }>
  | Readonly<{ kind: "acknowledged"; projection: NotificationProjection;
      outcome: "acknowledged" | "already_acknowledged" }>
  | Readonly<{ kind: "handled"; projection: NotificationProjection }>
  | Readonly<{ kind: "revoked"; revokedCount: number; hasMore: boolean }>
  | Readonly<{ kind: "source-revocations-recovered"; recoveredCount: number;
      hasMore: boolean }>
  | NotificationAuthorityFailure;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: RecordValue, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) =>
    typeof key === "string" && keys.includes(key));
};
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const timestamp = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

function context(value: unknown): value is AuthenticatedSessionContext {
  return record(value) &&
    (exact(value, ["sessionId", "sessionFamilyId", "principal"]) ||
      exact(value, ["sessionId", "sessionFamilyId", "deviceId", "principal"])) &&
    text(value.sessionId) && text(value.sessionFamilyId) &&
    (!Object.hasOwn(value, "deviceId") || text(value.deviceId)) &&
    record(value.principal) && exact(value.principal, ["accountId", "actorId"]) &&
    text(value.principal.accountId) && text(value.principal.actorId);
}

export function isNotificationAuthorityOperation(value: unknown): value is NotificationAuthorityOperation {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "notification.create") {
    return exact(value, ["type", "fact"]) && isNotificationProjection(value.fact);
  }
  if (value.type === "notification.list") {
    const before = value.before;
    return exact(value, ["type", "context", "roomId", "before", "limit", "now"]) &&
      context(value.context) && (value.roomId === null || text(value.roomId)) &&
      (before === null || (record(before) && exact(before, ["createdAt", "notificationId"]) &&
        timestamp(before.createdAt) && text(before.notificationId))) &&
      integer(value.limit, 1) && value.limit <= 256 && integer(value.now);
  }
  if (value.type === "notification.mark-read") {
    return exact(value, ["type", "context", "commandRequestId", "notificationId",
      "expectedReadRevision", "occurredAt", "now"]) && context(value.context) &&
      text(value.commandRequestId) && text(value.notificationId) &&
      integer(value.expectedReadRevision) && timestamp(value.occurredAt) && integer(value.now);
  }
  if (value.type === "notification.resolve-source") {
    return exact(value, ["type", "context", "notificationId", "now"]) &&
      context(value.context) && text(value.notificationId) && integer(value.now);
  }
  if (value.type === "notification.acknowledge-tool-result" ||
      value.type === "notification.acknowledge-execution-result") {
    return exact(value, ["type", "context", "commandRequestId", "notificationId",
      "occurredAt", "now"]) && context(value.context) && text(value.commandRequestId) &&
      text(value.notificationId) && timestamp(value.occurredAt) && integer(value.now);
  }
  if (value.type === "notification.source-handled") {
    return exact(value, ["type", "notificationId", "sourceBoundaryId", "sourceTerminal",
      "occurredAt"]) && text(value.notificationId) && text(value.sourceBoundaryId) &&
      ["request_terminal", "confirmation_terminal", "project_boundary_released",
        "tool_result_acknowledged_or_reviewed", "execution_result_acknowledged_or_recovered",
        "escalation_resolved"].includes(String(value.sourceTerminal)) && timestamp(value.occurredAt);
  }
  if (value.type === "notification.recover-source-revocations") {
    return exact(value, ["type", "roomId", "sourceKind", "sourceId", "limit"]) &&
      text(value.roomId) && value.sourceKind === "message_mention" && text(value.sourceId) &&
      integer(value.limit, 1) && value.limit <= 256;
  }
  return value.type === "notification.revoke-recipient" &&
    exact(value, ["type", "roomId", "recipientActorId", "reason", "revokedAt", "limit"]) &&
    text(value.roomId) && text(value.recipientActorId) &&
    (value.reason === "membership_revoked" || value.reason === "source_inaccessible") &&
    timestamp(value.revokedAt) && integer(value.limit, 1) && value.limit <= 256;
}

export function isNotificationAuthorityResult(value: unknown): value is NotificationAuthorityResult {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "failure") return exact(value, ["kind", "code", "status"]) &&
    [400, 401, 403, 404, 409, 410].includes(Number(value.status)) && typeof value.code === "string";
  if (value.kind === "list") return exact(value, ["kind", "notifications", "hasMore",
    "roomBadges", "identityWatermark"]) &&
    Array.isArray(value.notifications) && value.notifications.every(isNotificationProjection) &&
    typeof value.hasMore === "boolean" && Array.isArray(value.roomBadges) &&
    value.roomBadges.every(isNotificationRoomBadge) &&
    integer(value.identityWatermark);
  if (value.kind === "read") return exact(value, ["kind", "ack"]) && isNotificationReadAck(value.ack);
  if (value.kind === "acknowledged") return exact(value,
    ["kind", "projection", "outcome"]) && isNotificationProjection(value.projection) &&
    (value.outcome === "acknowledged" || value.outcome === "already_acknowledged");
  if (value.kind === "handled" || value.kind === "source") return (
    exact(value, ["kind", "projection"]) &&
    isNotificationProjection(value.projection)
  );
  if (value.kind === "revoked") return exact(value, ["kind", "revokedCount", "hasMore"]) &&
    integer(value.revokedCount) && typeof value.hasMore === "boolean";
  if (value.kind === "source-revocations-recovered") return exact(value,
    ["kind", "recoveredCount", "hasMore"]) && integer(value.recoveredCount) &&
    value.recoveredCount <= 256 && typeof value.hasMore === "boolean" &&
    (!value.hasMore || value.recoveredCount > 0);
  return (value.kind === "created" || value.kind === "duplicate") &&
    exact(value, ["kind", "projection", "eventId", "streamSeq"]) &&
    isNotificationProjection(value.projection) && text(value.eventId) && integer(value.streamSeq, 1);
}
