import { createHash } from "node:crypto";
import {
  isNotificationProjection,
  type NotificationKind,
  type NotificationProjection,
  type NotificationSourceKind,
} from "@native-im/core";

type ProducerBase = Readonly<{
  roomId: string;
  roomLifecycle: "active" | "archived";
  createdAt: string;
  actorId: string | null;
}>;

export type NotificationProducerEvidence =
  | ProducerBase & Readonly<{
      kind: "human_mention";
      messageId: string;
      messageRevision: number;
      mentionTargetId: string;
      targetHumanActorId: string;
      targetMembership: "active" | "revoked";
      linkedRequestId: string;
    }>
  | ProducerBase & Readonly<{
      kind: "human_request";
      recipientRelation: "target_pending";
      requestId: string;
      requestRevision: number;
      requestBoundaryOrdinal: number;
      stableTargetHumanActorId: string;
      targetMembership: "active" | "revoked";
      requestStatus: "pending_acceptance";
    }>
  | ProducerBase & Readonly<{
      kind: "human_request";
      recipientRelation: "requester_result";
      requestId: string;
      requestRevision: number;
      requestBoundaryOrdinal: number;
      requesterHumanActorId: string;
      requesterMembership: "active" | "revoked";
      requestStatus: "accepted" | "rejected" | "cancelled" | "transferred";
    }>
  | ProducerBase & Readonly<{
      kind: "tool_confirmation";
      confirmationId: string;
      confirmationRevision: number;
      exactPrincipalHumanActorId: string;
      principalBinding: "current" | "revoked";
      confirmationState: "pending" | "confirmed" | "rejected" | "expired";
    }>
  | ProducerBase & Readonly<{
      kind: "project_due";
      boundaryId: string;
      sourceFactId: string;
      sourceRevision: number;
      lifecycleGeneration: number;
      reminderOrdinal: number;
      holder: Readonly<{
        kind: "human" | "agent";
        actorId: string;
        membership: "active" | "revoked";
      }>;
    }>
  | ProducerBase & Readonly<{
      kind: "tool_result";
      toolCallId: string;
      toolCallRevision: number;
      exactRelatedHumanActorId: string;
      relation: "confirmation_principal" | "invocation_source";
      resultState: "known_succeeded" | "known_failed" | "revoked_before_dispatch" |
        "outcome_unknown" | "reviewed";
    }>
  | ProducerBase & Readonly<{
      kind: "agent_execution_completed";
      executionId: string;
      executionVersion: number;
      sourceHumanRecipientActorId: string;
      recipientRelation: "invocation_source" | "project_boundary_owner";
      executionStatus: "completed";
    }>
  | ProducerBase & Readonly<{
      kind: "agent_execution_failed";
      executionId: string;
      executionVersion: number;
      sourceHumanRecipientActorId: string;
      recipientRelation: "invocation_source" | "project_boundary_owner";
      executionStatus: "failed";
    }>
  | ProducerBase & Readonly<{
      kind: "cannot_answer_escalation";
      obstacleId: string;
      obstacleRevision: number;
      escalationBoundaryId: string;
      exactEscalationHumanActorId: string;
      obstacleStatus: "cannot_answer" | "resolved" | "deferred" | "open";
    }>;

type IntentParts = Readonly<{
  recipientActorId: string;
  notificationKind: NotificationKind;
  sourceKind: NotificationSourceKind;
  sourceId: string;
  sourceRevision: number;
  sourceBoundaryId: string;
  ordinal: number;
  handled: boolean;
}>;

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function timestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function dueParts(value: Extract<NotificationProducerEvidence, { kind: "project_due" }>):
  IntentParts | null {
  if (!identifier(value.boundaryId) || !identifier(value.sourceFactId) ||
      !positiveInteger(value.sourceRevision) || !nonNegativeInteger(value.lifecycleGeneration) ||
      !nonNegativeInteger(value.reminderOrdinal) || !identifier(value.holder.actorId) ||
      value.holder.membership !== "active") {
    throw new TypeError("Project due notification evidence was invalid");
  }
  if (value.holder.kind !== "human") return null;
  return Object.freeze({ recipientActorId: value.holder.actorId,
    notificationKind: "project_due", sourceKind: "project_boundary",
    sourceId: value.boundaryId, sourceRevision: value.sourceRevision,
    sourceBoundaryId: value.boundaryId, ordinal: value.reminderOrdinal, handled: false });
}

function parts(value: NotificationProducerEvidence): IntentParts | null {
  if (value.kind === "human_mention") {
    if (!identifier(value.messageId) || !positiveInteger(value.messageRevision) ||
        !identifier(value.mentionTargetId) || !identifier(value.targetHumanActorId) ||
        !identifier(value.linkedRequestId)) throw new TypeError("Human mention evidence was invalid");
    if (value.targetMembership !== "active") return null;
    return Object.freeze({ recipientActorId: value.targetHumanActorId,
      notificationKind: value.kind, sourceKind: "message_mention", sourceId: value.messageId,
      sourceRevision: value.messageRevision,
      // The mention is closed by the Request created in the same message transaction. Keep the
      // durable Request id as the boundary so later Request transitions can project handled
      // without reconstructing a message-local hash.
      sourceBoundaryId: value.linkedRequestId,
      ordinal: 0, handled: false });
  }
  if (value.kind === "human_request") {
    if (!identifier(value.requestId) || !positiveInteger(value.requestRevision) ||
        !nonNegativeInteger(value.requestBoundaryOrdinal) ||
        value.requestBoundaryOrdinal > Math.floor((Number.MAX_SAFE_INTEGER - 1) / 2)) {
      throw new TypeError("Human Request evidence was invalid");
    }
    if (value.recipientRelation === "target_pending") {
      if (!identifier(value.stableTargetHumanActorId)) {
        throw new TypeError("Human Request target evidence was invalid");
      }
      if (value.targetMembership !== "active") return null;
      return Object.freeze({ recipientActorId: value.stableTargetHumanActorId,
        notificationKind: value.kind, sourceKind: "project_request", sourceId: value.requestId,
        sourceRevision: value.requestRevision,
        sourceBoundaryId: value.requestId,
        // Even ordinals are pending-target boundaries. A transfer back to a prior target therefore
        // cannot collide with that Human's earlier Request notification.
        ordinal: value.requestBoundaryOrdinal * 2, handled: false });
    }
    if (value.recipientRelation !== "requester_result" ||
        !identifier(value.requesterHumanActorId)) {
      throw new TypeError("Human Request requester-result evidence was invalid");
    }
    if (value.requesterMembership !== "active") return null;
    return Object.freeze({ recipientActorId: value.requesterHumanActorId,
      notificationKind: value.kind, sourceKind: "project_request", sourceId: value.requestId,
      sourceRevision: value.requestRevision,
      sourceBoundaryId: value.requestId,
      // Odd ordinals are terminal/transfer results for the requester. They are unread on creation
      // but already handled because the authoritative Request transition has committed.
      ordinal: value.requestBoundaryOrdinal * 2 + 1, handled: true });
  }
  if (value.kind === "tool_confirmation") {
    if (!identifier(value.confirmationId) || !positiveInteger(value.confirmationRevision) ||
        !identifier(value.exactPrincipalHumanActorId)) throw new TypeError("Tool confirmation evidence was invalid");
    if (value.principalBinding !== "current" || value.confirmationState !== "pending") return null;
    return Object.freeze({ recipientActorId: value.exactPrincipalHumanActorId,
      notificationKind: value.kind, sourceKind: "tool_confirmation",
      sourceId: value.confirmationId, sourceRevision: value.confirmationRevision,
      sourceBoundaryId: value.confirmationId, ordinal: 0, handled: false });
  }
  if (value.kind === "project_due") return dueParts(value);
  if (value.kind === "tool_result") {
    if (!identifier(value.toolCallId) || !positiveInteger(value.toolCallRevision) ||
        !identifier(value.exactRelatedHumanActorId) ||
        (value.relation !== "confirmation_principal" && value.relation !== "invocation_source")) {
      throw new TypeError("Tool result evidence was invalid");
    }
    if (value.resultState === "reviewed") return null;
    return Object.freeze({ recipientActorId: value.exactRelatedHumanActorId,
      notificationKind: value.kind, sourceKind: "tool_call", sourceId: value.toolCallId,
      sourceRevision: value.toolCallRevision,
      sourceBoundaryId: value.toolCallId,
      // A known result still requires the recipient's source-specific acknowledgement; an
      // outcome_unknown remains open until review/compensation closes it.
      ordinal: 0, handled: false });
  }
  if (value.kind === "agent_execution_completed" || value.kind === "agent_execution_failed") {
    if (!identifier(value.executionId) || !positiveInteger(value.executionVersion) ||
        !identifier(value.sourceHumanRecipientActorId) ||
        (value.recipientRelation !== "invocation_source" &&
          value.recipientRelation !== "project_boundary_owner") ||
        (value.kind === "agent_execution_completed") !== (value.executionStatus === "completed")) {
      throw new TypeError("Agent execution notification evidence was invalid");
    }
    return Object.freeze({ recipientActorId: value.sourceHumanRecipientActorId,
      notificationKind: value.kind, sourceKind: "agent_execution", sourceId: value.executionId,
      sourceRevision: value.executionVersion, sourceBoundaryId: value.executionId,
      // Completion/failure are notification creation facts. Both remain unhandled until an
      // explicit source acknowledgement or retry/cancel/repair recovery action is committed.
      ordinal: 0, handled: false });
  }
  if (!identifier(value.obstacleId) || !positiveInteger(value.obstacleRevision) ||
      !identifier(value.escalationBoundaryId) ||
      !identifier(value.exactEscalationHumanActorId)) {
    throw new TypeError("Cannot-answer escalation evidence was invalid");
  }
  if (value.obstacleStatus !== "cannot_answer") return null;
  return Object.freeze({ recipientActorId: value.exactEscalationHumanActorId,
    notificationKind: value.kind, sourceKind: "project_obstacle", sourceId: value.obstacleId,
    sourceRevision: value.obstacleRevision, sourceBoundaryId: value.escalationBoundaryId,
    ordinal: 0, handled: false });
}

/**
 * Converts only server-owned source relations into a recipient fact. There is deliberately no
 * generic recipientActorId input: each union member names the authority relation that supplied it.
 */
export function deriveNotificationProducerIntent(
  value: NotificationProducerEvidence,
): NotificationProjection | null {
  if (!identifier(value.roomId) || !timestamp(value.createdAt) ||
      (value.actorId !== null && !identifier(value.actorId))) {
    throw new TypeError("Notification producer evidence was invalid");
  }
  if (value.roomLifecycle !== "active") return null;
  const derived = parts(value);
  if (derived === null) return null;
  if (!identifier(derived.sourceBoundaryId)) {
    throw new TypeError("Notification source boundary was invalid");
  }
  const dedupeKey = createHash("sha256").update(
    `dao.notification.dedupe.v1\0${derived.recipientActorId}\0${derived.sourceBoundaryId}` +
      `\0${derived.notificationKind}\0${derived.ordinal}`,
  ).digest("hex");
  const projection: NotificationProjection = Object.freeze({
    recordVersion: "notification.v1",
    notificationId: `notification-${dedupeKey}`,
    roomId: value.roomId,
    recipientActorId: derived.recipientActorId,
    notificationKind: derived.notificationKind,
    source: Object.freeze({ sourceKind: derived.sourceKind, sourceId: derived.sourceId,
      sourceRevision: derived.sourceRevision, sourceBoundaryId: derived.sourceBoundaryId,
      ordinal: derived.ordinal }),
    dedupeKey,
    createdAt: value.createdAt,
    readAt: null,
    readRevision: 0,
    handled: derived.handled,
    handledAt: derived.handled ? value.createdAt : null,
    sourceAccessible: true,
    deepLink: Object.freeze({
      kind: derived.sourceKind === "message_mention" ? "message" as const
        : derived.sourceKind === "project_request" ? "request" as const
          : derived.sourceKind === "tool_confirmation" ? "confirmation" as const
            : derived.sourceKind === "project_boundary" ? "project_boundary" as const
              : derived.sourceKind === "tool_call" ? "tool_call" as const
                : derived.sourceKind === "agent_execution" ? "agent_execution" as const
                  : "project_obstacle" as const,
      targetId: derived.sourceId,
    }),
    safeProjection: Object.freeze({ titleKey: derived.notificationKind, actorId: value.actorId }),
  });
  if (!isNotificationProjection(projection)) {
    throw new TypeError("Derived notification projection was invalid");
  }
  return projection;
}
