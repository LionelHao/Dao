export type ActorKind = "human" | "agent";

export type HumanReachability = "online" | "dnd" | "offline";
export type AgentReadiness = "ready" | "busy" | "paused" | "noauth";

export interface HumanActor {
  readonly id: string;
  readonly kind: "human";
  readonly displayName: string;
  readonly reachability: HumanReachability;
}

export interface AgentActor {
  readonly id: string;
  readonly kind: "agent";
  readonly displayName: string;
  readonly readiness: AgentReadiness;
  readonly toolPermissions: readonly string[];
}

export type Actor = HumanActor | AgentActor;

export interface Event {
  readonly id: string;
  readonly type: string;
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly roomId: string;
  readonly occurredAt: string;
}

export interface Message {
  readonly id: string;
  readonly roomId: string;
  readonly authorId: string;
  readonly authorKind: ActorKind;
  readonly body: string;
  readonly sentAt: string;
}

export interface MessageAcceptedAck {
  readonly type: "message.accepted";
  readonly requestId: string;
  readonly messageId: string;
  readonly persistedAt: string;
}

export interface Room {
  readonly id: string;
  readonly name: string;
  readonly memberIds: readonly string[];
  readonly createdAt: string;
}

export type HumanRoomRole = "owner" | "admin" | "member";
export type AgentParticipation = "active" | "on-mention" | "silent";
export type RoomStatus = "active" | "archived";
export type RoomLifecycleState = "active" | "archived";

export interface RoomGovernanceView<TRoomId extends string = string> {
  readonly roomId: TRoomId;
  readonly projectId: TRoomId;
  readonly lifecycle: RoomLifecycleState;
  readonly governanceRevision: number;
  readonly ownerActorId: string;
  readonly archivedAt?: string;
  readonly archiveGeneration: number;
}

export type DepartureResponsibilityKind =
  | "request" | "next_action" | "blocker_or_open_question" | "confirmation" | "acceptance";
export type DepartureResolution = "complete" | "transfer" | "escalate" | "reject_or_revoke";

export interface DepartureConflict {
  readonly conflictId: string;
  readonly roomId: string;
  readonly subjectId: string;
  readonly kind: DepartureResponsibilityKind;
  readonly title: string;
  readonly state: string;
  readonly allowedResolutions: readonly DepartureResolution[];
  readonly sourceId: string;
  readonly revision: number;
  readonly grant?: never;
  readonly confirmationParameters?: never;
}

export interface DepartureConflictList {
  readonly roomId: string;
  readonly targetActorId: string;
  readonly governanceRevision: number;
  readonly conflicts: readonly DepartureConflict[];
}

export interface HumanRoomMembership {
  readonly kind: "human";
  readonly actorId: string;
  readonly role: HumanRoomRole;
  readonly joinedAt: string;
  readonly participation?: never;
  readonly toolPermissions?: never;
  readonly configuredAt?: never;
}

export interface AgentRoomMembership {
  readonly kind: "agent";
  readonly actorId: string;
  readonly participation: AgentParticipation;
  readonly toolPermissions: readonly string[];
  readonly configuredAt: string;
  readonly role?: never;
  readonly joinedAt?: never;
}

export interface HumanInvitationRequest {
  readonly kind: "human-invitation";
  readonly roomId: string;
  readonly inviteeActorId: string;
  readonly agentId?: never;
  readonly participation?: never;
  readonly toolPermissions?: never;
}

export interface AgentConfigurationRequest {
  readonly kind: "agent-configuration";
  readonly roomId: string;
  readonly agentId: string;
  readonly participation: AgentParticipation;
  readonly toolPermissions: readonly string[];
  readonly inviteeActorId?: never;
}

export interface MessageDraft {
  readonly id: string;
  readonly roomId: string;
  readonly body: string;
  readonly sentAt: string;
  readonly authorId?: never;
  readonly authorKind?: never;
}

export interface ManagedRoom {
  readonly id: string;
  readonly name: string;
  readonly status: RoomStatus;
  readonly members: readonly (HumanRoomMembership | AgentRoomMembership)[];
  readonly createdAt: string;
}

type UnknownRecord = Record<string, unknown>;

const humanReachability = new Set<HumanReachability>(["online", "dnd", "offline"]);
const agentReadiness = new Set<AgentReadiness>(["ready", "busy", "paused", "noauth"]);
const humanRoomRoles = new Set<HumanRoomRole>(["owner", "admin", "member"]);
const agentParticipations = new Set<AgentParticipation>([
  "active",
  "on-mention",
  "silent",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}

function hasStringArray(value: UnknownRecord, key: string): boolean {
  return Array.isArray(value[key]) && value[key].every((entry) => typeof entry === "string");
}

function hasNonEmptyStringArray(value: UnknownRecord, key: string): boolean {
  return hasStringArray(value, key) && (value[key] as readonly string[]).length > 0;
}

function isActorKind(value: unknown): value is ActorKind {
  return value === "human" || value === "agent";
}

function isHumanReachability(value: unknown): value is HumanReachability {
  return typeof value === "string" && humanReachability.has(value as HumanReachability);
}

function isAgentReadiness(value: unknown): value is AgentReadiness {
  return typeof value === "string" && agentReadiness.has(value as AgentReadiness);
}

function isHumanRoomRole(value: unknown): value is HumanRoomRole {
  return typeof value === "string" && humanRoomRoles.has(value as HumanRoomRole);
}

function isAgentParticipation(value: unknown): value is AgentParticipation {
  return (
    typeof value === "string" && agentParticipations.has(value as AgentParticipation)
  );
}

function hasOnlyKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isRoomGovernanceView(value: unknown): value is RoomGovernanceView {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "roomId", "projectId", "lifecycle", "governanceRevision", "ownerActorId", "archiveGeneration",
  ], ["archivedAt"])) return false;
  return isNonEmptyString(value.roomId) && value.projectId === value.roomId &&
    (value.lifecycle === "active" || value.lifecycle === "archived") &&
    isSafeRevision(value.governanceRevision) && isNonEmptyString(value.ownerActorId) &&
    isSafeRevision(value.archiveGeneration) &&
    (value.lifecycle === "archived" ? isNonEmptyString(value.archivedAt) : value.archivedAt === undefined);
}

const departureKinds = new Set<DepartureResponsibilityKind>([
  "request", "next_action", "blocker_or_open_question", "confirmation", "acceptance",
]);
const departureResolutions = new Set<DepartureResolution>([
  "complete", "transfer", "escalate", "reject_or_revoke",
]);

export function isDepartureConflict(value: unknown): value is DepartureConflict {
  return isRecord(value) && hasOnlyKeys(value, [
    "conflictId", "roomId", "subjectId", "kind", "title", "state", "allowedResolutions", "sourceId", "revision",
  ]) && isNonEmptyString(value.conflictId) && isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.subjectId) && departureKinds.has(value.kind as DepartureResponsibilityKind) &&
    isNonEmptyString(value.title) && isNonEmptyString(value.state) &&
    Array.isArray(value.allowedResolutions) && value.allowedResolutions.length > 0 &&
    value.allowedResolutions.every((resolution) => departureResolutions.has(resolution as DepartureResolution)) &&
    new Set(value.allowedResolutions).size === value.allowedResolutions.length &&
    isNonEmptyString(value.sourceId) && isSafeRevision(value.revision);
}

export function isDepartureConflictList(value: unknown): value is DepartureConflictList {
  if (!isRecord(value) || !hasOnlyKeys(value, ["roomId", "targetActorId", "governanceRevision", "conflicts"]) ||
    !isNonEmptyString(value.roomId) || !isNonEmptyString(value.targetActorId) ||
    !isSafeRevision(value.governanceRevision) || !Array.isArray(value.conflicts)) return false;
  const ids = new Set<string>();
  return value.conflicts.every((conflict) => {
    if (!isDepartureConflict(conflict) || conflict.roomId !== value.roomId || ids.has(conflict.conflictId)) return false;
    ids.add(conflict.conflictId);
    return true;
  });
}

export function isHumanActor(value: unknown): value is HumanActor {
  return (
    isRecord(value) &&
    value.kind === "human" &&
    hasString(value, "id") &&
    hasString(value, "displayName") &&
    isHumanReachability(value.reachability) &&
    !("readiness" in value) &&
    !("toolPermissions" in value)
  );
}

export function isAgentActor(value: unknown): value is AgentActor {
  return (
    isRecord(value) &&
    value.kind === "agent" &&
    hasString(value, "id") &&
    hasString(value, "displayName") &&
    isAgentReadiness(value.readiness) &&
    hasStringArray(value, "toolPermissions") &&
    !("reachability" in value)
  );
}

export function isActor(value: unknown): value is Actor {
  return isHumanActor(value) || isAgentActor(value);
}

export function isEvent(value: unknown): value is Event {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "type") &&
    hasString(value, "actorId") &&
    isActorKind(value.actorKind) &&
    hasString(value, "roomId") &&
    hasString(value, "occurredAt")
  );
}

export function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "roomId") &&
    hasString(value, "authorId") &&
    isActorKind(value.authorKind) &&
    hasString(value, "body") &&
    hasString(value, "sentAt")
  );
}

export function isMessageAcceptedAck(value: unknown): value is MessageAcceptedAck {
  return (
    isRecord(value) &&
    value.type === "message.accepted" &&
    hasString(value, "requestId") &&
    hasString(value, "messageId") &&
    hasString(value, "persistedAt")
  );
}

export function isRoom(value: unknown): value is Room {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "name") &&
    hasStringArray(value, "memberIds") &&
    hasString(value, "createdAt")
  );
}

export function isHumanRoomMembership(value: unknown): value is HumanRoomMembership {
  return (
    isRecord(value) &&
    value.kind === "human" &&
    hasString(value, "actorId") &&
    isHumanRoomRole(value.role) &&
    hasString(value, "joinedAt") &&
    !("participation" in value) &&
    !("toolPermissions" in value) &&
    !("configuredAt" in value)
  );
}

export function isAgentRoomMembership(value: unknown): value is AgentRoomMembership {
  return (
    isRecord(value) &&
    value.kind === "agent" &&
    hasString(value, "actorId") &&
    isAgentParticipation(value.participation) &&
    hasNonEmptyStringArray(value, "toolPermissions") &&
    hasString(value, "configuredAt") &&
    !("role" in value) &&
    !("joinedAt" in value)
  );
}

export function isHumanInvitationRequest(
  value: unknown,
): value is HumanInvitationRequest {
  return (
    isRecord(value) &&
    value.kind === "human-invitation" &&
    hasString(value, "roomId") &&
    hasString(value, "inviteeActorId") &&
    !("agentId" in value) &&
    !("participation" in value) &&
    !("toolPermissions" in value)
  );
}

export function isAgentConfigurationRequest(
  value: unknown,
): value is AgentConfigurationRequest {
  return (
    isRecord(value) &&
    value.kind === "agent-configuration" &&
    hasString(value, "roomId") &&
    hasString(value, "agentId") &&
    isAgentParticipation(value.participation) &&
    hasNonEmptyStringArray(value, "toolPermissions") &&
    !("inviteeActorId" in value)
  );
}

export function isMessageDraft(value: unknown): value is MessageDraft {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "roomId") &&
    hasString(value, "body") &&
    hasString(value, "sentAt") &&
    !("authorId" in value) &&
    !("authorKind" in value)
  );
}

export {
  isAgentExecution,
  isBallInCourt,
  isBallOverdueTrigger,
  isBlueprintBallFact,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isHumanPreemptionNotice,
  isOpenItem,
  isOpenItemAgentFailure,
  isLightTask,
  isNeedsActionProjection,
  projectLightTask,
  projectBallsInCourt,
  isReminderCandidate,
  isRouteJob,
  isRouteJudgment,
  isRouterProviderInput,
  isRouterPlan,
  isSocialReaction,
} from "./collaboration.js";
export type {
  AgentExecution,
  BallInCourt,
  BallOverdueTrigger,
  BallProjectionInput,
  BallSourceKind,
  BlueprintBallFact,
  AgentExecutionActionCategory,
  AgentExecutionAttempt,
  AgentExecutionStatus,
  AgentInvocationIntent,
  AgentInvocationIntentKind,
  AgentRuntimeProviderInput,
  AgentToolDispatchPhase,
  AgentJudgement,
  AgentJudgementOutcome,
  CalibrationSignal,
  HumanReadReceipt,
  HumanPreemptionNotice,
  OpenItem,
  OpenItemAgentFailure,
  LightTask,
  LightTaskCriterion,
  LightTaskProjection,
  LightTaskStatus,
  LightTaskVerifierRole,
  NeedsActionProjection,
  ReminderCandidate,
  OpenItemOrigin,
  OpenItemStatus,
  OpenItemTransfer,
  ProviderEvent,
  ProviderNeutralCheckpoint,
  RouterProviderInput,
  RouterCandidate,
  RouterPlan,
  RouteInvocationIntent,
  RouteJob,
  RouteJobStatus,
  RouteJudgment,
  RouteReasonCode,
  RouteRoomPhase,
  RouteTriggerCategory,
  BallSummary,
  SocialReaction,
  ToolConfirmationInput,
  ToolDescriptor,
  ToolEffect,
  ToolReversibility,
} from "./collaboration.js";
export {
  isRoomCursor,
  isRoomRepairPage,
  isRoomSyncResult,
  isSnapshotCompleted,
  isSnapshotVersion,
  isWorkspaceBootstrapPage,
} from "./sync.js";
export type {
  AgentExecutionLifecyclePayload,
  PersistedIdentityEvent,
  PersistedRoomEvent,
  LegacyUnknownCalibrationSignal,
  RoomCursor,
  RoomArchivedEventPayload,
  RoomRepairPage,
  RoomRepairRecord,
  RoomReopenedEventPayload,
  RoomSecurityReducedEventPayload,
  RoomSummary,
  RoomSyncRequest,
  RoomSyncResult,
  SnapshotCompleted,
  SnapshotDeliveryMode,
  SnapshotVersion,
  ToolConfirmationRequiredPayload,
  WorkspaceBootstrapPage,
} from "./sync.js";
export {
  MESSAGE_AUTHORITY_LIMITS,
  isActiveHumanMessage,
  isAgentFinalMessage,
  isAttachmentReference,
  isHumanMessageSubmit,
  isIsoUtcTimestamp,
  isMentionTarget,
  isMessageAuthorityEvent,
  isMessageAuthorityRepairRecord,
  isMessageRevision,
  isMessageTargetOutcome,
  isMessageTombstone,
  isTimelineMessage,
  isUtf16Range,
} from "./message-authority.js";
export type {
  ActiveHumanMessage,
  AgentFinalMessageLinkContext,
  AgentFinalMessage,
  AttachmentReference,
  HumanMessageSubmit,
  HumanMessageSubmitLinkContext,
  MentionTarget,
  MentionTargetKind,
  MessageAuthorityEvent,
  MessageAuthorityRepairRecord,
  MessageLifecycle,
  MessageRevision,
  MessageTargetOutcome,
  MessageTargetRejectionCode,
  MessageTombstone,
  TimelineMessage,
  Utf16Range,
} from "./message-authority.js";
export {
  ATTACHMENT_AUTHORITY_LIMITS,
  attachmentDetectedMime,
  isAttachmentError,
  isAttachmentFormat,
  isAttachmentMetadata,
  isAttachmentPrivateEvent,
  isAttachmentReadyProvenance,
  isAttachmentRepairRecord,
  isAttachmentRoomEvent,
  isAttachmentSafeFilename,
  isAttachmentSha256,
  isAttachmentUiAxes,
  projectAttachmentUiState,
} from "./attachment-authority.js";
export type {
  AttachmentAccessProjection,
  AttachmentDetectedMime,
  AttachmentDurableProcessing,
  AttachmentError,
  AttachmentExtractionMethod,
  AttachmentExtractionTool,
  AttachmentFormat,
  AttachmentLocalTransport,
  AttachmentMetadata,
  AttachmentNonretryableReason,
  AttachmentPrivateEvent,
  AttachmentProcessingStatus,
  AttachmentReadyProvenance,
  AttachmentRepairRecord,
  AttachmentRoomBoundEvent,
  AttachmentRoomEvent,
  AttachmentRoomExcludedEvent,
  AttachmentSourceEligibility,
  AttachmentUiAxes,
  AttachmentUiState,
} from "./attachment-authority.js";
