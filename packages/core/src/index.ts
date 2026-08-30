export type ActorKind = "human" | "agent";

export * from "./project-loop.js";
export * from "./tool-safety.js";

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
/** @deprecated Historical v1 Room membership decoder only. New Assignment writes use AgentAssignmentParticipation. */
export type AgentParticipation = "active" | "on-mention";
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
  /** @deprecated Legacy command decoder; the FT-07 Assignment command is closed separately. */
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
  AGENT_CAPABILITY_IDS,
  AGENT_TOOL_IDS,
  asAgentActorId,
  asAgentAssignmentId,
  asAgentProfileId,
  canonicalizeAgentCapabilities,
  canonicalizeAgentTools,
  deriveAgentAvailability,
  intersectAgentAuthority,
  isAgentActorId,
  isAgentAssignmentId,
  isAgentAssignmentRecord,
  isAgentAvailabilityFacts,
  isAgentCapabilityId,
  isAgentProfileId,
  isAgentProfileRecord,
  isAgentToolId,
  isAssignmentWithinProfileCeiling,
  isCanonicalAgentCapabilitySet,
  isCanonicalAgentToolSet,
  isRoomAgentProjection,
} from "./agent-profile.js";
export type {
  AgentActorId,
  AgentAssignmentId,
  AgentAssignmentRecord,
  AgentAssignmentStatus,
  AgentAvailability,
  AgentAvailabilityFacts,
  AgentCapabilityId,
  AgentAssignmentParticipation,
  AgentProfileId,
  AgentProfileRecord,
  AgentProfileStatus,
  AgentToolId,
  RoomAgentProjection,
} from "./agent-profile.js";

export {
  isAgentExecution,
  isAgentExecutionAttempt,
  isAgentExecutionRetryReceipt,
  isAgentInvocationIntent,
  isBallInCourt,
  isBallOverdueTrigger,
  isBlueprintBallFact,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isInvocationCancelCommand,
  isInvocationRetryCommand,
  isLegacyAgentExecution,
  isLegacyAgentInvocationIntent,
  isLegacyHumanPreemptionNotice,
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
  isProjectBoundaryInvocationResult,
  isProjectBoundaryInvocationRequest,
  isScopedCancellationReceipt,
} from "./collaboration.js";
export type {
  AgentExecution,
  BallInCourt,
  BallOverdueTrigger,
  BallProjectionInput,
  BallSourceKind,
  BlueprintBallFact,
  AgentExecutionActionCategory,
  AgentExecutionAcceptedPhase,
  AgentExecutionAttempt,
  AgentExecutionPhase,
  AgentExecutionRetryReceipt,
  AgentExecutionReviewState,
  AgentExecutionRunningPhase,
  AgentExecutionStatus,
  AgentExecutionTerminalPhase,
  AgentInvocationIntent,
  AgentRuntimeProviderInput,
  AgentToolDispatchPhase,
  AgentJudgement,
  AgentJudgementOutcome,
  CalibrationSignal,
  HumanReadReceipt,
  InvocationCancelCommand,
  InvocationCancellationReason,
  InvocationOrigin,
  InvocationRetryCommand,
  LegacyAgentExecution,
  LegacyAgentExecutionAttempt,
  LegacyAgentExecutionStatus,
  LegacyAgentInvocationIntent,
  LegacyAgentInvocationIntentKind,
  LegacyHumanPreemptionNotice,
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
  ProjectBoundaryInvocationRequest,
  ProjectBoundaryInvocationResult,
  ProjectBoundaryProviderInvocation,
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
  ScopedCancellationReceipt,
  ScopedCancellationScope,
  ToolConfirmationInput,
  ToolDescriptor,
  ToolEffect,
  ToolReversibility,
} from "./collaboration.js";
export {
  isAgentProfileProjection,
  isDeploymentAgentProfileRepairSnapshot,
  isDeploymentAgentProfileSyncResult,
  isDeploymentProviderDisclosure,
  isPersistedDeploymentAgentProfileEvent,
  isRoomAgentAssignmentProjection,
  isRoomAgentAssignmentRepairSnapshot,
  isRoomCursor,
  isRoomRepairPage,
  isRoomSyncResult,
  isSnapshotCompleted,
  isSnapshotVersion,
  isWorkspaceBootstrapPage,
} from "./sync.js";
export type {
  AgentProfileProjection,
  DeploymentAgentProfileRepairSnapshot,
  DeploymentAgentProfileSyncResult,
  DeploymentProviderDisclosure,
  LegacyAgentExecutionEvent,
  LegacyAgentExecutionLifecyclePayload,
  LegacyRoomHumanPreemptionEvent,
  PersistedDeploymentAgentProfileEvent,
  PersistedIdentityEvent,
  PersistedRoomEvent,
  LegacyUnknownCalibrationSignal,
  RoomCursor,
  RoomArchivedEventPayload,
  RoomRepairPage,
  RoomRepairRecord,
  RoomAgentAssignmentChangedPayload,
  RoomAgentAssignmentProjection,
  RoomAgentAssignmentRepairSnapshot,
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
  isAgentMessageCitation,
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
  AgentMessageCitation,
  AgentMessageCitationSourceKind,
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
export {
  ROOM_MEMORY_LIMITS,
  isRoomMemoryDispute,
  isRoomMemoryError,
  isRoomMemoryEvent,
  isRoomMemoryHealth,
  isRoomMemoryKind,
  isRoomMemoryProjection,
  isRoomMemoryProtocolFrame,
  isRoomMemoryRawDeltaPage,
  isRoomMemoryRepairRecord,
  isRoomMemoryRequest,
  isRoomMemoryResolution,
  isRoomMemorySource,
  isRoomMemorySourceIdentity,
  isRoomMemorySourceView,
  isRoomMemoryStatus,
  isRoomMemoryVersion,
} from "./room-memory.js";
export type {
  RoomMemoryAuthorizedReadRef,
  RoomMemoryConfirmedProjectReference,
  RoomMemoryContextDisputeAccepted,
  RoomMemoryContextDisputeRequest,
  RoomMemoryContextResolveAccepted,
  RoomMemoryContextResolveRequest,
  RoomMemoryDispute,
  RoomMemoryError,
  RoomMemoryErrorCode,
  RoomMemoryErrorStatus,
  RoomMemoryEvent,
  RoomMemoryHealth,
  RoomMemoryHealthReason,
  RoomMemoryHealthState,
  RoomMemoryKind,
  RoomMemoryNonContextKind,
  RoomMemoryPageFrame,
  RoomMemoryProjection,
  RoomMemoryProtocolFrame,
  RoomMemoryQueryRequest,
  RoomMemoryRawDeltaPage,
  RoomMemoryRepairRecord,
  RoomMemoryRepairValue,
  RoomMemoryRequest,
  RoomMemoryResolution,
  RoomMemoryResolutionAction,
  RoomMemoryRetryAccepted,
  RoomMemoryRetryRequest,
  RoomMemorySource,
  RoomMemorySourceAvailability,
  RoomMemorySourceEligibility,
  RoomMemorySourceFrame,
  RoomMemorySourceIdentity,
  RoomMemorySourceKind,
  RoomMemorySourceMetadata,
  RoomMemorySourceNavigation,
  RoomMemorySourceQueryRequest,
  RoomMemorySourceView,
  RoomMemoryStatus,
  RoomMemoryStatusFrame,
  RoomMemoryStatusQueryRequest,
  RoomMemorySuccessFrame,
  RoomMemoryVersion,
  RoomMemoryVersionChangedPayload,
  RoomMemoryVersionProjection,
  RoomMemoryVersionSourceRef,
  RoomMemoryVersionState,
} from "./room-memory.js";
export {
  CONTEXT_COMPILER_CONFIG_VERSION,
  CONTEXT_COMPILER_INPUT_VERSION,
  CONTEXT_COMPILER_LIMITS,
  CONTEXT_COMPILER_VERSION,
  CONTEXT_TOKEN_ESTIMATOR_VERSION,
  isCompiledContextEnvelopeV1,
  isContextCompileResultV1,
  isContextCompilerConfigV1,
  isContextCompilerInputV1,
  isContextManifestV1,
} from "./context-compiler.js";
export type {
  CompiledContextEnvelopeV1,
  CompiledContextGroupItemV1,
  CompiledProjectContextV1,
  ContextAccountingV1,
  ContextAgentAuthorityV1,
  ContextActorV1,
  ContextCompileErrorV1,
  ContextCompileResultV1,
  ContextCompilerConfigV1,
  ContextCompilerInputV1,
  ContextInvocationIntentV1,
  ContextManifestDispositionV1,
  ContextManifestEntryV1,
  ContextManifestItemV1,
  ContextManifestRangeV1,
  ContextManifestReasonV1,
  ContextManifestSectionV1,
  ContextManifestV1,
  ContextMemoryCandidateV1,
  ContextMemoryKindV1,
  ContextMentionV1,
  ContextReplyRefV1,
  ContextRoomGoalV1,
  ContextSectionAccountingV1,
  ContextSegmentV1,
  ContextSourceAvailabilityV1,
  ContextSourceCandidateV1,
  ContextSourceIdentityV1,
  ContextSourceKindV1,
  ContextToolDescriptorV1,
  ContextTriggerV1,
  ProjectContextInputV1,
} from "./context-compiler.js";
