import type {
  Actor,
  AgentRoomMembership,
  HumanRoomMembership,
  HumanRoomRole,
  ManagedRoom,
  Message,
  RoomGovernanceView,
  RoomStatus,
} from "./index.js";
import { isRoomGovernanceView } from "./index.js";
import {
  isAgentExecution,
  isAgentExecutionAttempt,
  isAgentExecutionRetryReceipt,
  isAgentInvocationIntent,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isLegacyAgentExecution,
  isLegacyHumanPreemptionNotice,
  isLightTask,
  isBallOverdueTrigger,
  isOpenItem,
  isOpenItemAgentFailure,
  isRouteJob,
  isRouteJudgment,
  isProjectBoundaryInvocationResult,
  isScopedCancellationReceipt,
  type AgentExecution,
  type AgentExecutionAttempt,
  type AgentExecutionRetryReceipt,
  type AgentInvocationIntent,
  type AgentJudgement,
  type CalibrationSignal,
  type HumanReadReceipt,
  type LegacyAgentExecution,
  type LegacyAgentExecutionStatus,
  type LegacyHumanPreemptionNotice,
  type LightTask,
  type BallOverdueTrigger,
  type OpenItem,
  type OpenItemAgentFailure,
  type RouteJob,
  type RouteJudgment,
  type ProjectBoundaryInvocationResult,
  type ScopedCancellationReceipt,
} from "./collaboration.js";
import {
  isAttachmentRepairRecord,
  isAttachmentRoomEvent,
  type AttachmentPrivateEvent,
  type AttachmentRepairRecord,
  type AttachmentRoomEvent,
} from "./attachment-authority.js";
import {
  isMessageAuthorityEvent,
  isMessageAuthorityRepairRecord,
  type MessageAuthorityEvent,
  type MessageAuthorityRepairRecord,
} from "./message-authority.js";
import {
  isRoomMemoryEvent,
  isRoomMemoryRepairRecord,
  type RoomMemoryEvent,
  type RoomMemoryRepairRecord,
} from "./room-memory.js";
import {
  isProjectEvent,
  isProjectRepairRecord,
  type ProjectEvent,
  type ProjectRepairRecord,
} from "./project-loop.js";
import {
  isAgentProfileRecord,
  isCanonicalAgentCapabilitySet,
  isCanonicalAgentToolSet,
  type AgentAvailability,
  type AgentProfileRecord,
  type AgentAssignmentParticipation,
  type AgentCapabilityId,
  type AgentToolId,
} from "./agent-profile.js";

export interface DeploymentProviderDisclosure {
  readonly providerId: string;
  readonly modelId: string;
  readonly credentialReadiness: "ready" | "noauth";
}

export type AgentProfileProjection = AgentProfileRecord & Readonly<{
  recordVersion: "agent-profile.v1";
}>;

export interface RoomAgentAssignmentProjection {
  readonly recordVersion: "room-agent-assignment.v1";
  readonly assignmentId: string;
  readonly roomId: string;
  readonly profileId: string;
  readonly actorId: string;
  readonly displayName: string;
  readonly globalResponsibility: string;
  readonly roomResponsibility: string;
  readonly participation: AgentAssignmentParticipation;
  readonly availability: AgentAvailability;
  readonly paused: boolean;
  readonly capabilityCeiling: readonly AgentCapabilityId[];
  readonly capabilitySubset: readonly AgentCapabilityId[];
  readonly effectiveCapabilities: readonly AgentCapabilityId[];
  readonly toolCeiling: readonly AgentToolId[];
  readonly toolSubset: readonly AgentToolId[];
  readonly effectiveTools: readonly AgentToolId[];
  readonly profileRevision: number;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly updatedAt: string;
}

export type RoomAgentAssignmentChangedPayload =
  | Readonly<{
      change: "upserted" | "availability-changed";
      roomRevision: number;
      assignment: RoomAgentAssignmentProjection;
    }>
  | Readonly<{
      change: "removed";
      roomRevision: number;
      assignmentId: string;
      actorId: string;
      assignmentRevision: number;
    }>;

export interface PersistedDeploymentAgentProfileEvent {
  readonly eventId: string;
  readonly streamKind: "deployment";
  readonly streamId: "agent-profile";
  readonly streamSeq: number;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly type:
    | "agent-profile.created"
    | "agent-profile.updated"
    | "agent-profile.enabled"
    | "agent-profile.disabled";
  readonly payload: Readonly<{
    catalogRevision: number;
    profile: AgentProfileProjection;
  }>;
}

export interface DeploymentAgentProfileRepairSnapshot {
  readonly type: "agent-profile.repair.snapshot";
  readonly requestId: string;
  readonly watermark: number;
  readonly profiles: readonly AgentProfileProjection[];
  readonly provider: DeploymentProviderDisclosure;
}

export type DeploymentAgentProfileSyncResult =
  | Readonly<{
      type: "agent-profile.sync.result";
      requestId: string;
      mode: "delta";
      events: readonly PersistedDeploymentAgentProfileEvent[];
      nextCursor: number;
      watermark: number;
      hasMore: boolean;
    }>
  | Readonly<{
      type: "agent-profile.sync.result";
      requestId: string;
      mode: "repair_required";
      reason: "cursor_absent" | "cursor_expired" | "projection_changed";
      retainedFromSeq: number;
      watermark: number;
    }>;

export interface RoomAgentAssignmentRepairSnapshot {
  readonly type: "room-agent-assignment.repair.snapshot";
  readonly requestId: string;
  readonly roomId: string;
  readonly watermark: number;
  readonly roomRevision: number;
  readonly assignments: readonly RoomAgentAssignmentProjection[];
  readonly provider: DeploymentProviderDisclosure;
}

export interface RoomSummary {
  readonly roomId: string;
  readonly name: string;
  readonly status: RoomStatus;
  readonly role: HumanRoomRole;
}

export type SnapshotDeliveryMode =
  | { readonly mode: "materialized"; readonly expiresAt: string; readonly idleExpiresAt?: never }
  | { readonly mode: "streaming"; readonly idleExpiresAt: string; readonly expiresAt?: never };

export interface LegacyUnknownCalibrationSignal {
  readonly id: string;
  readonly sourceMessageId: null;
  readonly actorId: null;
  readonly agentId: string;
  readonly emoji: "👍" | "👎";
  readonly createdAt: string;
}

type OperationalMessageAuthorityRepairRecord = MessageAuthorityRepairRecord;

export type ToolSafetyRepairRecord =
  | { readonly kind: "tool-call"; readonly value: Readonly<{
      toolCallId: string; toolId: string; safePreview: string;
      state: "prepared"; version: number; sourceRef: string;
    }> }
  | { readonly kind: "tool-confirmation"; readonly value: Readonly<{
      confirmationId: string; toolCallId: string; toolId: string;
      state: "pending" | "confirmed" | "rejected" | "expired";
      safePreview: string; reasonCode: string | null; expiresAt: string;
      version: number; principalActorId: string; namedHumanDisplayRef: string | null; sourceRef: string;
    }> }
  | { readonly kind: "tool-grant"; readonly value: Readonly<{
      grantId: string; toolCallId: string;
      state: "active" | "claimed" | "revoked" | "expired";
      reasonCode: string | null; expiresAt: string; version: number;
    }> }
  | { readonly kind: "tool-dispatch"; readonly value: Readonly<{
      dispatchId: string; toolCallId: string;
      state: "prepared" | "claimed" | "dispatched" | "known_succeeded" |
        "known_failed" | "outcome_unknown" | "reviewed";
      reasonCode: string | null; version: number;
    }> }
  | { readonly kind: "tool-review"; readonly value: Readonly<{
      reviewId: string; dispatchId: string;
      resolution: "known_succeeded" | "known_failed" | "compensated" | "accepted_risk";
      evidenceSummary: string; namedHumanDisplayRef: string;
      compensationToolCallId: string | null; version: number;
    }> }
  | { readonly kind: "tool-handoff"; readonly value: Readonly<{
      handoffId: string; confirmationId: string;
      state: "offered" | "accepted" | "rejected" | "expired"; targetActorId: string;
      targetNamedHumanDisplayRef: string; version: number;
    }> }
  | { readonly kind: "tool-compensation"; readonly value: Readonly<{
      lineageId: string; originalDispatchId: string; compensationInvocationId: string;
      compensationExecutionId: string; compensationToolCallId: string;
      state: "pending" | "rejected" | "expired" | "claimed" | "dispatched" |
        "known_succeeded" | "known_failed" | "outcome_unknown" | "reviewed";
      version: number;
    }> };

export type ToolSafetyEvent = RoomEvent<"tool.safety.changed", ToolSafetyRepairRecord>;

export type RoomRepairRecord =
  | { readonly kind: "room"; readonly value: Omit<ManagedRoom, "members"> }
  | { readonly kind: "governance"; readonly value: RoomGovernanceView }
  | { readonly kind: "membership"; readonly value: HumanRoomMembership | AgentRoomMembership }
  | { readonly kind: "message"; readonly value: Message }
  | { readonly kind: "human-read"; readonly value: HumanReadReceipt }
  | { readonly kind: "agent-judgement"; readonly value: AgentJudgement }
  | { readonly kind: "open-item"; readonly value: OpenItem }
  | { readonly kind: "open-item-agent-failure"; readonly value: OpenItemAgentFailure }
  | { readonly kind: "light-task"; readonly value: LightTask }
  | { readonly kind: "agent-invocation-intent"; readonly value: AgentInvocationIntent }
  | { readonly kind: "agent-execution"; readonly value: AgentExecution }
  | { readonly kind: "agent-execution-attempt"; readonly value: AgentExecutionAttempt }
  | { readonly kind: "agent-execution-retry"; readonly value: AgentExecutionRetryReceipt }
  | { readonly kind: "agent-scoped-cancellation"; readonly value: ScopedCancellationReceipt }
  | { readonly kind: "project-boundary-invocation"; readonly value: ProjectBoundaryInvocationResult }
  | { readonly kind: "legacy-agent-execution"; readonly value: LegacyAgentExecution }
  | { readonly kind: "route-job"; readonly value: RouteJob }
  | { readonly kind: "route-judgment"; readonly value: RouteJudgment }
  | { readonly kind: "calibration"; readonly value: CalibrationSignal }
  | { readonly kind: "legacy-unknown-calibration";
      readonly value: LegacyUnknownCalibrationSignal }
  | OperationalMessageAuthorityRepairRecord
  | AttachmentRepairRecord
  | RoomMemoryRepairRecord
  | ToolSafetyRepairRecord
  | ProjectRepairRecord;

export type SnapshotVersion =
  | { readonly kind: "room"; readonly roomId: string; readonly watermark: number }
  | { readonly kind: "catalog"; readonly catalogRevision: number };

export type WorkspaceBootstrapPage = {
  readonly type: "workspace.bootstrap.page";
  readonly requestId: string;
  readonly snapshotId: string;
  readonly page: number;
  readonly rooms: readonly RoomSummary[];
  readonly catalogRevision: number;
  readonly snapshotChecksum: string;
  readonly hasMore: boolean;
} & SnapshotDeliveryMode;

export type RoomRepairPage = {
  readonly type: "room.repair.page";
  readonly requestId: string;
  readonly snapshotId: string;
  readonly roomId: string;
  readonly page: number;
  readonly records: readonly RoomRepairRecord[];
  readonly watermark: number;
  readonly snapshotChecksum: string;
  readonly hasMore: boolean;
} & SnapshotDeliveryMode;

export interface SnapshotCompleted {
  readonly type: "snapshot.completed";
  readonly requestId: string;
  readonly snapshotId: string;
  readonly version: SnapshotVersion;
}

export interface RoomCursor {
  readonly version: 1;
  readonly roomId: string;
  readonly afterSeq: number;
  readonly watermark?: number;
}

export interface RoomSyncRequest {
  readonly type: "room.sync";
  readonly requestId: string;
  readonly roomId: string;
  readonly cursor?: RoomCursor;
  readonly limit?: number;
}

interface PersistedEventBase {
  readonly eventId: string;
  readonly streamSeq: number;
  readonly actorId: string;
  readonly occurredAt: string;
}

type RoomEvent<TType extends string, TPayload> = PersistedEventBase & {
  readonly streamKind: "room";
  readonly streamId: string;
  readonly roomId: string;
  readonly type: TType;
  readonly payload: TPayload;
};

export interface LegacyAgentExecutionLifecyclePayload {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly retryCycle: number;
  readonly retryOrdinal: 1 | 2 | 3;
  readonly actionCategory: LegacyAgentExecution["actionCategory"];
  readonly status: LegacyAgentExecutionStatus;
  readonly errorCode?: string;
  readonly nextRetryAt?: string;
}

export interface ToolConfirmationRequiredPayload {
  readonly confirmationId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly toolId: string;
  readonly target: string;
  readonly impact: string;
  readonly reversibility: "compensatable" | "irreversible";
  readonly expiresAt: string;
}

export interface RoomArchivedEventPayload {
  readonly governance: RoomGovernanceView;
  readonly archiveGeneration: number;
  readonly frozenTimerCount: number;
}

export interface RoomReopenedEventPayload {
  readonly governance: RoomGovernanceView;
  readonly archiveGeneration: number;
  readonly resumedTimerCount: number;
}

export interface RoomSecurityReducedEventPayload {
  readonly governance: RoomGovernanceView;
  readonly archiveGeneration: number;
  readonly assignmentRevision: number;
}

export type LegacyRoomHumanPreemptionEvent = RoomEvent<
  "room.human_preemption.applied",
  LegacyHumanPreemptionNotice
>;

export type LegacyAgentExecutionEvent =
  | RoomEvent<"room.agent_execution.changed", LegacyAgentExecution>
  | RoomEvent<
      | "agent.execution.queued"
      | "agent.execution.started"
      | "agent.execution.retry-scheduled"
      | "agent.execution.completed"
      | "agent.execution.failed"
      | "agent.execution.cancelled"
      | "agent.execution.dead-lettered"
      | "agent.execution.recovered",
      LegacyAgentExecutionLifecyclePayload
    >;

export type PersistedRoomEvent =
  | RoomEvent<"room.created" | "room.renamed", { readonly room: ManagedRoom }>
  | RoomEvent<"room.governance.changed", { readonly governance: RoomGovernanceView }>
  | RoomEvent<"room.archived", RoomArchivedEventPayload>
  | RoomEvent<"room.reopened", RoomReopenedEventPayload>
  | RoomEvent<"room.security.reduced", RoomSecurityReducedEventPayload>
  | RoomEvent<"human.invitation.issued", { readonly invitationId: string; readonly inviteeActorId: string }>
  | RoomEvent<"human.invitation.accepted", { readonly invitationId: string; readonly membership: HumanRoomMembership }>
  | RoomEvent<"human.invitation.rejected", { readonly invitationId: string; readonly targetActorId: string }>
  | RoomEvent<"human.role.changed", { readonly membership: HumanRoomMembership }>
  | RoomEvent<"member.removed", { readonly targetActorId: string }>
  | RoomEvent<"agent.configured", { readonly membership: AgentRoomMembership }>
  | RoomEvent<"room.agent-assignment.changed", RoomAgentAssignmentChangedPayload>
  | RoomEvent<"room.message.accepted", Message>
  | MessageAuthorityEvent
  | AttachmentRoomEvent
  | RoomMemoryEvent
  | ProjectEvent
  | ToolSafetyEvent
  | RoomEvent<"room.human_read.recorded", HumanReadReceipt>
  | RoomEvent<"room.agent_judgment.recorded", AgentJudgement>
  | RoomEvent<"room.open_item.changed", OpenItem>
  | RoomEvent<"room.open_item.agent_attempt_failed", OpenItemAgentFailure>
  | RoomEvent<"room.light_task.changed", LightTask>
  | RoomEvent<"room.ball.overdue", BallOverdueTrigger>
  | LegacyRoomHumanPreemptionEvent
  | LegacyAgentExecutionEvent
  | RoomEvent<"agent.invocation.intent.changed", AgentInvocationIntent>
  | RoomEvent<"agent.execution.changed", AgentExecution>
  | RoomEvent<"agent.execution.attempt.changed", AgentExecutionAttempt>
  | RoomEvent<"agent.execution.retry.accepted", AgentExecutionRetryReceipt>
  | RoomEvent<"agent.invocation.scoped-cancellation.committed", ScopedCancellationReceipt>
  | RoomEvent<"project.boundary.invocation.decided", ProjectBoundaryInvocationResult>
  | RoomEvent<"room.route_judgment.recorded", RouteJudgment>
  | RoomEvent<
      | "route.queued"
      | "route.started"
      | "route.retry-scheduled"
      | "route.completed"
      | "route.failed"
      | "route.recovered",
      RouteJob
    >
  | RoomEvent<"agent.tool.confirmation-required", ToolConfirmationRequiredPayload>
  | RoomEvent<"room.calibration.recorded", CalibrationSignal>;

type IdentityEvent<TType extends string, TPayload> = PersistedEventBase & {
  readonly streamKind: "identity";
  readonly streamId: string;
  readonly roomId?: never;
  readonly type: TType;
  readonly payload: TPayload;
};

export type PersistedAttachmentPrivateEvent = Omit<
  AttachmentPrivateEvent,
  "streamKind"
> & Readonly<{ streamKind: "identity" }>;

export type PersistedIdentityEvent =
  | IdentityEvent<"identity.actor.registered", { readonly actor: Actor }>
  | IdentityEvent<
      "identity.session.issued" | "identity.session.rotated" | "identity.session.revoked",
      { readonly sessionId: string; readonly familyId: string; readonly accountId: string }
    >
  | IdentityEvent<
      "identity.room-access.changed",
      { readonly roomId: string; readonly change: "joined" | "updated" | "removed" | "archived" }
    >
  | PersistedAttachmentPrivateEvent;

export type RoomSyncResult =
  | {
      readonly type: "room.sync.result";
      readonly requestId: string;
      readonly mode: "delta";
      readonly events: readonly PersistedRoomEvent[];
      readonly nextCursor: RoomCursor;
      readonly watermark: number;
      readonly hasMore: boolean;
    }
  | {
      readonly type: "room.sync.result";
      readonly requestId: string;
      readonly mode: "repair_required";
      readonly reason: "cursor_absent" | "cursor_expired" | "operational_projection_changed";
      readonly retainedFromSeq: number;
      readonly watermark: number;
    };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRoomSummary(value: unknown): value is RoomSummary {
  return isRecord(value) && exact(value, ["roomId", "name", "status", "role"]) &&
    text(value.roomId) && text(value.name) &&
    (value.status === "active" || value.status === "archived") &&
    (value.role === "owner" || value.role === "admin" || value.role === "member");
}

function stringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length;
}

function isHumanMembershipValue(value: unknown): value is HumanRoomMembership {
  return isRecord(value) && exact(value, ["kind", "actorId", "role", "joinedAt"]) && value.kind === "human" &&
    text(value.actorId) && (value.role === "owner" || value.role === "admin" || value.role === "member") && text(value.joinedAt);
}

function isAgentMembershipValue(value: unknown): value is AgentRoomMembership {
  return isRecord(value) && exact(value, ["kind", "actorId", "participation", "toolPermissions", "configuredAt"]) &&
    value.kind === "agent" && text(value.actorId) &&
    (value.participation === "active" || value.participation === "on-mention") &&
    stringList(value.toolPermissions) && text(value.configuredAt);
}

function isMessageValue(value: unknown): value is Message {
  return isRecord(value) && exact(value, ["id", "roomId", "authorId", "authorKind", "body", "sentAt"]) &&
    text(value.id) && text(value.roomId) && text(value.authorId) &&
    (value.authorKind === "human" || value.authorKind === "agent") && text(value.body) && text(value.sentAt);
}

function isRoomMetadata(value: unknown): value is Omit<ManagedRoom, "members"> {
  return isRecord(value) && exact(value, ["id", "name", "status", "createdAt"]) && text(value.id) && text(value.name) &&
    (value.status === "active" || value.status === "archived") && text(value.createdAt);
}

function isManagedRoomValue(value: unknown): value is ManagedRoom {
  return isRecord(value) && exact(value, ["id", "name", "status", "members", "createdAt"]) &&
    text(value.id) && text(value.name) && (value.status === "active" || value.status === "archived") &&
    Array.isArray(value.members) && value.members.every((entry) => isHumanMembershipValue(entry) || isAgentMembershipValue(entry)) &&
    text(value.createdAt);
}

function isDeliveryMode(value: UnknownRecord): boolean {
  return value.mode === "materialized"
    ? text(value.expiresAt) && !Object.hasOwn(value, "idleExpiresAt")
    : value.mode === "streaming" && text(value.idleExpiresAt) && !Object.hasOwn(value, "expiresAt");
}

function canonicalSubset(candidate: readonly string[], ceiling: readonly string[]): boolean {
  const allowed = new Set(ceiling);
  return candidate.every((value) => allowed.has(value));
}

export function isDeploymentProviderDisclosure(
  value: unknown,
): value is DeploymentProviderDisclosure {
  return isRecord(value) && exact(value, [
    "providerId", "modelId", "credentialReadiness",
  ]) && text(value.providerId) && text(value.modelId) &&
    (value.credentialReadiness === "ready" || value.credentialReadiness === "noauth");
}

export function isAgentProfileProjection(value: unknown): value is AgentProfileProjection {
  if (!isRecord(value) || value.recordVersion !== "agent-profile.v1") return false;
  const { recordVersion, ...profile } = value;
  void recordVersion;
  return isAgentProfileRecord(profile);
}

export function isRoomAgentAssignmentProjection(
  value: unknown,
  expectedRoomId?: string,
): value is RoomAgentAssignmentProjection {
  if (!isRecord(value) || !exact(value, [
    "recordVersion", "assignmentId", "roomId", "profileId", "actorId", "displayName",
    "globalResponsibility", "roomResponsibility", "participation", "availability", "paused",
    "capabilityCeiling", "capabilitySubset", "effectiveCapabilities", "toolCeiling",
    "toolSubset", "effectiveTools", "profileRevision", "assignmentRevision", "accessRevision",
    "updatedAt",
  ]) || value.recordVersion !== "room-agent-assignment.v1" || !text(value.assignmentId) ||
      !text(value.roomId) || (expectedRoomId !== undefined && value.roomId !== expectedRoomId) ||
      !text(value.profileId) || !text(value.actorId) || !text(value.displayName) ||
      !text(value.globalResponsibility) || !text(value.roomResponsibility) ||
      (value.participation !== "active" && value.participation !== "on-mention") ||
      (value.availability !== "ready" && value.availability !== "busy" &&
       value.availability !== "paused" && value.availability !== "noauth") ||
      typeof value.paused !== "boolean" ||
      !isCanonicalAgentCapabilitySet(value.capabilityCeiling) ||
      !isCanonicalAgentCapabilitySet(value.capabilitySubset) ||
      !isCanonicalAgentCapabilitySet(value.effectiveCapabilities) ||
      !isCanonicalAgentToolSet(value.toolCeiling) ||
      !isCanonicalAgentToolSet(value.toolSubset) ||
      !isCanonicalAgentToolSet(value.effectiveTools) ||
      !count(value.profileRevision) || value.profileRevision === 0 ||
      !count(value.assignmentRevision) || value.assignmentRevision === 0 ||
      !count(value.accessRevision) || !text(value.updatedAt) ||
      !Number.isFinite(Date.parse(value.updatedAt as string))) return false;
  return value.paused === (value.availability === "paused") &&
    canonicalSubset(value.capabilitySubset, value.capabilityCeiling) &&
    canonicalSubset(value.effectiveCapabilities, value.capabilitySubset) &&
    canonicalSubset(value.toolSubset, value.toolCeiling) &&
    canonicalSubset(value.effectiveTools, value.toolSubset);
}

export function isPersistedDeploymentAgentProfileEvent(
  value: unknown,
): value is PersistedDeploymentAgentProfileEvent {
  if (!isRecord(value) || !exact(value, [
    "eventId", "streamKind", "streamId", "streamSeq", "actorId", "occurredAt", "type", "payload",
  ]) || !text(value.eventId) || value.streamKind !== "deployment" ||
      value.streamId !== "agent-profile" || !count(value.streamSeq) || value.streamSeq === 0 ||
      !text(value.actorId) || !text(value.occurredAt) ||
      (value.type !== "agent-profile.created" && value.type !== "agent-profile.updated" &&
       value.type !== "agent-profile.enabled" && value.type !== "agent-profile.disabled") ||
      !isRecord(value.payload) || !exact(value.payload, ["catalogRevision", "profile"]) ||
      !count(value.payload.catalogRevision) || value.payload.catalogRevision === 0 ||
      !isAgentProfileProjection(value.payload.profile)) return false;
  const profile = value.payload.profile;
  return profile.actorId === value.actorId && value.payload.catalogRevision === value.streamSeq &&
    (value.type !== "agent-profile.enabled" || profile.status === "enabled") &&
    (value.type !== "agent-profile.disabled" || profile.status === "disabled");
}

export function isDeploymentAgentProfileRepairSnapshot(
  value: unknown,
): value is DeploymentAgentProfileRepairSnapshot {
  return isRecord(value) && exact(value, [
    "type", "requestId", "watermark", "profiles", "provider",
  ]) && value.type === "agent-profile.repair.snapshot" && text(value.requestId) &&
    count(value.watermark) && Array.isArray(value.profiles) && value.profiles.length <= 256 &&
    value.profiles.every(isAgentProfileProjection) &&
    new Set(value.profiles.map((profile) => profile.profileId)).size === value.profiles.length &&
    isDeploymentProviderDisclosure(value.provider);
}

export function isDeploymentAgentProfileSyncResult(
  value: unknown,
): value is DeploymentAgentProfileSyncResult {
  if (!isRecord(value) || value.type !== "agent-profile.sync.result" || text(value.requestId) === false) {
    return false;
  }
  if (value.mode === "repair_required") {
    return exact(value, [
      "type", "requestId", "mode", "reason", "retainedFromSeq", "watermark",
    ]) && (value.reason === "cursor_absent" || value.reason === "cursor_expired" ||
      value.reason === "projection_changed") && count(value.retainedFromSeq) &&
      value.retainedFromSeq > 0 && count(value.watermark) &&
      value.retainedFromSeq <= value.watermark + 1;
  }
  if (value.mode !== "delta" || !exact(value, [
    "type", "requestId", "mode", "events", "nextCursor", "watermark", "hasMore",
  ]) || !Array.isArray(value.events) || value.events.length > 256 ||
      !value.events.every(isPersistedDeploymentAgentProfileEvent) || !count(value.nextCursor) ||
      !count(value.watermark) || value.nextCursor > value.watermark ||
      typeof value.hasMore !== "boolean") return false;
  const events = value.events as readonly PersistedDeploymentAgentProfileEvent[];
  const nextCursor = value.nextCursor as number;
  return value.hasMore === (nextCursor < value.watermark) &&
    new Set(events.map((event) => event.eventId)).size === events.length &&
    events.every((event, index) =>
      event.streamSeq === nextCursor - events.length + index + 1);
}

export function isRoomAgentAssignmentRepairSnapshot(
  value: unknown,
): value is RoomAgentAssignmentRepairSnapshot {
  return isRecord(value) && exact(value, [
    "type", "requestId", "roomId", "watermark", "roomRevision", "assignments", "provider",
  ]) && value.type === "room-agent-assignment.repair.snapshot" && text(value.requestId) &&
    text(value.roomId) && count(value.watermark) && count(value.roomRevision) &&
    Array.isArray(value.assignments) && value.assignments.length <= 256 &&
    value.assignments.every((assignment) =>
      isRoomAgentAssignmentProjection(assignment, value.roomId as string)) &&
    new Set(value.assignments.map((assignment) => assignment.assignmentId)).size ===
      value.assignments.length &&
    new Set(value.assignments.map((assignment) => assignment.actorId)).size ===
      value.assignments.length && isDeploymentProviderDisclosure(value.provider);
}

export function isRoomCursor(value: unknown): value is RoomCursor {
  return isRecord(value) &&
    exact(
      value,
      ["version", "roomId", "afterSeq"],
      Object.hasOwn(value, "watermark") ? ["watermark"] : [],
    ) &&
    value.version === 1 && text(value.roomId) && count(value.afterSeq) &&
    (!Object.hasOwn(value, "watermark") ||
      (count(value.watermark) && value.watermark >= value.afterSeq));
}

export function isSnapshotVersion(value: unknown): value is SnapshotVersion {
  return isRecord(value) && (
    (exact(value, ["kind", "roomId", "watermark"]) && value.kind === "room" && text(value.roomId) && count(value.watermark)) ||
    (exact(value, ["kind", "catalogRevision"]) && value.kind === "catalog" && count(value.catalogRevision))
  );
}

export function isSnapshotCompleted(value: unknown): value is SnapshotCompleted {
  return isRecord(value) && exact(value, ["type", "requestId", "snapshotId", "version"]) &&
    value.type === "snapshot.completed" && text(value.requestId) && text(value.snapshotId) &&
    isSnapshotVersion(value.version);
}

function isRepairRecord(value: unknown, expectedRoomId?: string): value is RoomRepairRecord {
  if (!isRecord(value)) return false;
  if (value.kind === "timeline-message" || value.kind === "message-revision") {
    return isMessageAuthorityRepairRecord(value, expectedRoomId);
  }
  if (value.kind === "attachment") return isAttachmentRepairRecord(value, expectedRoomId);
  if (value.kind === "memory") return isRoomMemoryRepairRecord(value, expectedRoomId);
  if (value.kind === "project-loop") return isProjectRepairRecord(value, expectedRoomId);
  if (value.kind === "tool-call" || value.kind === "tool-confirmation" ||
      value.kind === "tool-grant" || value.kind === "tool-dispatch" ||
      value.kind === "tool-review" || value.kind === "tool-handoff" ||
      value.kind === "tool-compensation") {
    return isToolSafetyRepairRecord(value);
  }
  if (!exact(value, ["kind", "value"])) return false;
  if (value.kind === "human-read") return isHumanReadReceipt(value.value);
  if (value.kind === "agent-judgement") return isAgentJudgement(value.value);
  if (value.kind === "open-item") return isOpenItem(value.value);
  if (value.kind === "open-item-agent-failure") return isOpenItemAgentFailure(value.value);
  if (value.kind === "light-task") return isLightTask(value.value);
  if (value.kind === "agent-invocation-intent") return isAgentInvocationIntent(value.value) &&
    (!expectedRoomId || value.value.roomId === expectedRoomId);
  if (value.kind === "agent-execution") return isAgentExecution(value.value) &&
    (!expectedRoomId || value.value.roomId === expectedRoomId);
  if (value.kind === "agent-execution-attempt") return isAgentExecutionAttempt(value.value) &&
    (!expectedRoomId || value.value.roomId === expectedRoomId);
  if (value.kind === "agent-execution-retry") return isAgentExecutionRetryReceipt(value.value) &&
    (!expectedRoomId || value.value.roomId === expectedRoomId);
  if (value.kind === "agent-scoped-cancellation") return isScopedCancellationReceipt(value.value) &&
    (!expectedRoomId || value.value.roomId === expectedRoomId);
  if (value.kind === "project-boundary-invocation") return isProjectBoundaryInvocationResult(value.value) &&
    (!expectedRoomId || value.value.roomId === expectedRoomId);
  if (value.kind === "legacy-agent-execution") return isLegacyAgentExecution(value.value) &&
    (!expectedRoomId || value.value.roomId === expectedRoomId);
  if (value.kind === "route-job") return isRouteJob(value.value);
  if (value.kind === "route-judgment") return isRouteJudgment(value.value);
  if (value.kind === "calibration") return isCalibrationSignal(value.value);
  if (value.kind === "legacy-unknown-calibration") {
    const legacy = value.value;
    return isRecord(legacy) && exact(legacy,
      ["id", "sourceMessageId", "actorId", "agentId", "emoji", "createdAt"]) &&
      text(legacy.id) && legacy.sourceMessageId === null && legacy.actorId === null &&
      text(legacy.agentId) && (legacy.emoji === "👍" || legacy.emoji === "👎") &&
      text(legacy.createdAt);
  }
  if (value.kind === "room") return isRoomMetadata(value.value);
  if (value.kind === "governance") return isRoomGovernanceView(value.value);
  if (value.kind === "membership") return isHumanMembershipValue(value.value) || isAgentMembershipValue(value.value);
  return value.kind === "message" && isMessageValue(value.value);
}

export function isToolSafetyRepairRecord(value: unknown): value is ToolSafetyRepairRecord {
  if (!isRecord(value) || !exact(value, ["kind", "value"]) || !isRecord(value.value)) return false;
  const payload = value.value;
  if (value.kind === "tool-call") {
    return exact(payload, ["toolCallId", "toolId", "safePreview", "state", "version", "sourceRef"]) &&
      text(payload.toolCallId) && text(payload.toolId) && typeof payload.safePreview === "string" &&
      payload.state === "prepared" && count(payload.version) && text(payload.sourceRef);
  }
  if (value.kind === "tool-confirmation") {
    return exact(payload, ["confirmationId", "toolCallId", "toolId", "state", "safePreview",
      "reasonCode", "expiresAt", "version", "principalActorId", "namedHumanDisplayRef", "sourceRef"]) &&
      text(payload.confirmationId) && text(payload.toolCallId) && text(payload.toolId) &&
      ["pending", "confirmed", "rejected", "expired"].includes(String(payload.state)) &&
      typeof payload.safePreview === "string" && text(payload.expiresAt) && count(payload.version) &&
      (payload.reasonCode === null || text(payload.reasonCode)) && text(payload.principalActorId) &&
      (payload.namedHumanDisplayRef === null || text(payload.namedHumanDisplayRef)) &&
      text(payload.sourceRef);
  }
  if (value.kind === "tool-grant") {
    return exact(payload, ["grantId", "toolCallId", "state", "reasonCode", "expiresAt", "version"]) &&
      text(payload.grantId) && text(payload.toolCallId) &&
      ["active", "claimed", "revoked", "expired"].includes(String(payload.state)) &&
      (payload.reasonCode === null || text(payload.reasonCode)) && text(payload.expiresAt) &&
      count(payload.version);
  }
  if (value.kind === "tool-dispatch") {
    return exact(payload, ["dispatchId", "toolCallId", "state", "reasonCode", "version"]) &&
      text(payload.dispatchId) && text(payload.toolCallId) &&
      ["prepared", "claimed", "dispatched", "known_succeeded", "known_failed",
        "outcome_unknown", "reviewed"].includes(String(payload.state)) &&
      (payload.reasonCode === null || text(payload.reasonCode)) && count(payload.version);
  }
  if (value.kind === "tool-review") {
    return exact(payload, ["reviewId", "dispatchId", "resolution", "evidenceSummary",
      "namedHumanDisplayRef", "compensationToolCallId", "version"]) &&
      text(payload.reviewId) && text(payload.dispatchId) &&
      ["known_succeeded", "known_failed", "compensated", "accepted_risk"].includes(
        String(payload.resolution)) && typeof payload.evidenceSummary === "string" &&
      text(payload.namedHumanDisplayRef) &&
      (payload.compensationToolCallId === null || text(payload.compensationToolCallId)) &&
      count(payload.version);
  }
  if (value.kind === "tool-handoff") {
    return exact(payload, ["handoffId", "confirmationId", "state", "targetActorId",
      "targetNamedHumanDisplayRef", "version"]) && text(payload.handoffId) &&
      text(payload.confirmationId) && ["offered", "accepted", "rejected", "expired"]
        .includes(String(payload.state)) && text(payload.targetActorId) &&
      text(payload.targetNamedHumanDisplayRef) &&
      count(payload.version);
  }
  return value.kind === "tool-compensation" && exact(payload,
    ["lineageId", "originalDispatchId", "compensationInvocationId",
      "compensationExecutionId", "compensationToolCallId", "state", "version"]) &&
    text(payload.lineageId) && text(payload.originalDispatchId) &&
    text(payload.compensationInvocationId) && text(payload.compensationExecutionId) &&
    text(payload.compensationToolCallId) && ["pending", "rejected", "expired", "claimed",
      "dispatched", "known_succeeded", "known_failed", "outcome_unknown", "reviewed"]
      .includes(String(payload.state)) && count(payload.version);
}

function isPersistedRoomEventValue(value: unknown): value is PersistedRoomEvent {
  if (isProjectEvent(value)) return true;
  if (!isRecord(value) || !exact(
    value,
    ["eventId", "streamKind", "streamId", "streamSeq", "roomId", "actorId", "occurredAt", "type", "payload"],
  ) || value.streamKind !== "room" || !text(value.eventId) || !text(value.streamId) || value.streamId !== value.roomId ||
    !count(value.streamSeq) || value.streamSeq === 0 || !text(value.actorId) || !text(value.occurredAt) || !isRecord(value.payload)) {
    return false;
  }
  const payload = value.payload;
  if (isMessageAuthorityEvent(value)) return true;
  if (isAttachmentRoomEvent(value)) return true;
  if (isRoomMemoryEvent(value)) return true;
  if (value.type === "tool.safety.changed") return isToolSafetyRepairRecord(value.payload);
  if (value.type === "room.created" || value.type === "room.renamed") {
    return exact(payload, ["room"]) && isManagedRoomValue(payload.room) && payload.room.id === value.roomId;
  }
  if (value.type === "human.invitation.issued") {
    return exact(payload, ["invitationId", "inviteeActorId"]) && text(payload.invitationId) && text(payload.inviteeActorId);
  }
  if (value.type === "human.invitation.accepted") {
    return exact(payload, ["invitationId", "membership"]) && text(payload.invitationId) && isHumanMembershipValue(payload.membership);
  }
  if (value.type === "human.invitation.rejected") {
    return exact(payload, ["invitationId", "targetActorId"]) && text(payload.invitationId) && text(payload.targetActorId);
  }
  if (value.type === "human.role.changed") {
    return exact(payload, ["membership"]) && isHumanMembershipValue(payload.membership);
  }
  if (value.type === "room.governance.changed") {
    return exact(payload, ["governance"]) && isRoomGovernanceView(payload.governance) &&
      payload.governance.roomId === value.roomId;
  }
  if (value.type === "room.archived") {
    return exact(payload, ["governance", "archiveGeneration", "frozenTimerCount"]) &&
      isRoomGovernanceView(payload.governance) &&
      payload.governance.roomId === value.roomId &&
      payload.governance.lifecycle === "archived" && count(payload.archiveGeneration) &&
      payload.archiveGeneration > 0 &&
      payload.governance.archiveGeneration === payload.archiveGeneration &&
      count(payload.frozenTimerCount);
  }
  if (value.type === "room.reopened") {
    return exact(payload, ["governance", "archiveGeneration", "resumedTimerCount"]) &&
      isRoomGovernanceView(payload.governance) &&
      payload.governance.roomId === value.roomId &&
      payload.governance.lifecycle === "active" && count(payload.archiveGeneration) &&
      payload.archiveGeneration > 0 &&
      payload.governance.archiveGeneration === payload.archiveGeneration &&
      count(payload.resumedTimerCount);
  }
  if (value.type === "room.security.reduced") {
    return exact(payload, ["governance", "archiveGeneration", "assignmentRevision"]) &&
      isRoomGovernanceView(payload.governance) &&
      payload.governance.roomId === value.roomId &&
      payload.governance.lifecycle === "archived" && count(payload.archiveGeneration) &&
      payload.archiveGeneration > 0 &&
      payload.governance.archiveGeneration === payload.archiveGeneration &&
      count(payload.assignmentRevision);
  }
  if (value.type === "member.removed") {
    return exact(payload, ["targetActorId"]) && text(payload.targetActorId);
  }
  if (value.type === "agent.configured") {
    return exact(payload, ["membership"]) && isAgentMembershipValue(payload.membership);
  }
  if (value.type === "room.agent-assignment.changed") {
    if (payload.change === "removed") {
      return exact(payload, [
        "change", "roomRevision", "assignmentId", "actorId", "assignmentRevision",
      ]) && count(payload.roomRevision) && text(payload.assignmentId) && text(payload.actorId) &&
        count(payload.assignmentRevision) && payload.assignmentRevision > 0;
    }
    return (payload.change === "upserted" || payload.change === "availability-changed") &&
      exact(payload, ["change", "roomRevision", "assignment"]) &&
      count(payload.roomRevision) &&
      isRoomAgentAssignmentProjection(payload.assignment, value.roomId);
  }
  if (value.type === "room.message.accepted") {
    return isMessageValue(payload) && payload.roomId === value.roomId && payload.authorId === value.actorId;
  }
  if (value.type === "room.human_read.recorded") {
    return isHumanReadReceipt(payload) && payload.readerId === value.actorId;
  }
  if (value.type === "room.agent_judgment.recorded") {
    return isAgentJudgement(payload) && payload.agentId === value.actorId;
  }
  if (value.type === "room.open_item.changed") {
    return isOpenItem(payload) && payload.roomId === value.roomId;
  }
  if (value.type === "room.open_item.agent_attempt_failed") {
    return isOpenItemAgentFailure(payload);
  }
  if (value.type === "room.light_task.changed") {
    return isLightTask(payload) && payload.roomId === value.roomId;
  }
  if (value.type === "room.ball.overdue") {
    return isBallOverdueTrigger(payload) && payload.roomId === value.roomId &&
      payload.agentId === value.actorId;
  }
  if (value.type === "room.human_preemption.applied") {
    return isLegacyHumanPreemptionNotice(payload) && payload.roomId === value.roomId &&
      payload.occurredAt === value.occurredAt;
  }
  if (value.type === "room.agent_execution.changed") {
    return isLegacyAgentExecution(payload) && payload.roomId === value.roomId && payload.agentId === value.actorId;
  }
  if (value.type === "agent.invocation.intent.changed") {
    return isAgentInvocationIntent(payload) && payload.roomId === value.roomId;
  }
  if (value.type === "agent.execution.changed") {
    return isAgentExecution(payload) && payload.roomId === value.roomId && payload.agentId === value.actorId;
  }
  if (value.type === "agent.execution.attempt.changed") {
    return isAgentExecutionAttempt(payload) && payload.roomId === value.roomId && payload.agentId === value.actorId;
  }
  if (value.type === "agent.execution.retry.accepted") {
    return isAgentExecutionRetryReceipt(payload) && payload.roomId === value.roomId;
  }
  if (value.type === "agent.invocation.scoped-cancellation.committed") {
    return isScopedCancellationReceipt(payload) && payload.roomId === value.roomId;
  }
  if (value.type === "project.boundary.invocation.decided") {
    return isProjectBoundaryInvocationResult(payload) && payload.roomId === value.roomId;
  }
  if (value.type === "room.route_judgment.recorded") {
    return isRouteJudgment(payload) && payload.agentId === value.actorId;
  }
  if (value.type === "route.queued" || value.type === "route.started" ||
      value.type === "route.retry-scheduled" || value.type === "route.completed" ||
      value.type === "route.failed" || value.type === "route.recovered") {
    return isRouteJob(payload) && payload.roomId === value.roomId;
  }
  if (
    value.type === "agent.execution.queued" || value.type === "agent.execution.started" ||
    value.type === "agent.execution.retry-scheduled" || value.type === "agent.execution.completed" ||
    value.type === "agent.execution.failed" || value.type === "agent.execution.cancelled" ||
    value.type === "agent.execution.dead-lettered" || value.type === "agent.execution.recovered"
  ) {
    return exact(payload, [
      "executionId", "attemptSeq", "retryCycle", "retryOrdinal", "actionCategory", "status",
    ], ["errorCode", "nextRetryAt"]) && text(payload.executionId) && count(payload.attemptSeq) &&
      payload.attemptSeq >= 1 && count(payload.retryCycle) && payload.retryCycle >= 1 &&
      (payload.retryOrdinal === 1 || payload.retryOrdinal === 2 || payload.retryOrdinal === 3) &&
      (payload.actionCategory === "model_generation" || payload.actionCategory === "tool_call" || payload.actionCategory === "waiting_upstream") &&
      (payload.status === "queued" || payload.status === "running" || payload.status === "completed" || payload.status === "failed" || payload.status === "cancelled") &&
      (!Object.hasOwn(payload, "errorCode") || text(payload.errorCode)) &&
      (!Object.hasOwn(payload, "nextRetryAt") || text(payload.nextRetryAt));
  }
  if (value.type === "agent.tool.confirmation-required") {
    return exact(payload, [
      "confirmationId", "executionId", "attemptSeq", "toolId", "target", "impact",
      "reversibility", "expiresAt",
    ]) && text(payload.confirmationId) && text(payload.executionId) &&
      count(payload.attemptSeq) && payload.attemptSeq >= 1 && text(payload.toolId) &&
      text(payload.target) && text(payload.impact) &&
      (payload.reversibility === "compensatable" || payload.reversibility === "irreversible") &&
      text(payload.expiresAt) && Number.isFinite(Date.parse(payload.expiresAt));
  }
  return value.type === "room.calibration.recorded" && isCalibrationSignal(payload) && payload.actorId === value.actorId;
}

export function isWorkspaceBootstrapPage(value: unknown): value is WorkspaceBootstrapPage {
  return isRecord(value) &&
    exact(
      value,
      ["type", "requestId", "snapshotId", "page", "rooms", "catalogRevision", "snapshotChecksum", "hasMore", "mode"],
      ["expiresAt", "idleExpiresAt"],
    ) &&
    value.type === "workspace.bootstrap.page" && text(value.requestId) && text(value.snapshotId) && count(value.page) &&
    Array.isArray(value.rooms) && value.rooms.every(isRoomSummary) && count(value.catalogRevision) &&
    text(value.snapshotChecksum) && typeof value.hasMore === "boolean" && isDeliveryMode(value);
}

export function isRoomRepairPage(value: unknown): value is RoomRepairPage {
  return isRecord(value) &&
    exact(
      value,
      ["type", "requestId", "snapshotId", "roomId", "page", "records", "watermark", "snapshotChecksum", "hasMore", "mode"],
      ["expiresAt", "idleExpiresAt"],
    ) &&
    value.type === "room.repair.page" && text(value.requestId) && text(value.snapshotId) && text(value.roomId) && count(value.page) &&
    Array.isArray(value.records) &&
    value.records.every((record) => isRepairRecord(record, value.roomId as string)) &&
    count(value.watermark) &&
    text(value.snapshotChecksum) && typeof value.hasMore === "boolean" && isDeliveryMode(value);
}

export function isRoomSyncResult(value: unknown): value is RoomSyncResult {
  if (!isRecord(value) || value.type !== "room.sync.result" || !text(value.requestId)) {
    return false;
  }
  if (value.mode === "repair_required") {
    return exact(value, ["type", "requestId", "mode", "reason", "retainedFromSeq", "watermark"]) &&
      (value.reason === "cursor_absent" || value.reason === "cursor_expired" ||
        value.reason === "operational_projection_changed") &&
      count(value.retainedFromSeq) && value.retainedFromSeq >= 1 &&
      count(value.watermark) && value.retainedFromSeq <= value.watermark + 1;
  }
  if (value.mode === "delta") {
    const nextCursor = value.nextCursor;
    if (!exact(value, ["type", "requestId", "mode", "events", "nextCursor", "watermark", "hasMore"]) ||
      !Array.isArray(value.events) || !isRoomCursor(nextCursor) || !count(value.watermark) ||
      typeof value.hasMore !== "boolean") {
      return false;
    }
    const events = value.events;
    const eventIds = new Set<string>();
    if (
      nextCursor.afterSeq > value.watermark ||
      value.hasMore !== (nextCursor.afterSeq < value.watermark) ||
      (value.hasMore
        ? nextCursor.watermark !== value.watermark
        : Object.hasOwn(nextCursor, "watermark")) ||
      !events.every(isPersistedRoomEventValue) ||
      !events.every((event) => {
        if (eventIds.has(event.eventId)) return false;
        eventIds.add(event.eventId);
        return true;
      }) ||
      !events.every((event) =>
        event.roomId === nextCursor.roomId && event.streamId === nextCursor.roomId)
    ) {
      return false;
    }
    if (events.length === 0) {
      return nextCursor.afterSeq === value.watermark;
    }
    const lastEvent = events.at(-1);
    return lastEvent?.streamSeq === nextCursor.afterSeq &&
      events.every((event, index) =>
        index === 0 || event.streamSeq === events[index - 1]!.streamSeq + 1);
  }
  return false;
}
