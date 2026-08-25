import type {
  AgentConfigurationRequest,
  AgentExecution,
  AgentExecutionStatus,
  AgentInvocationIntent,
  AgentRoomMembership,
  HumanInvitationRequest,
  InvocationCancelCommand,
  LegacyHumanPreemptionNotice,
  ProjectBoundaryInvocationRequest,
  HumanRoomMembership,
  LightTask,
  BallInCourt,
  MessageDraft,
  DepartureConflict,
} from "./index.js";
import type {
  AgentRuntimeProviderInput,
  RouterProviderInput,
} from "./collaboration.js";

const invalidHumanMembership: HumanRoomMembership = {
  kind: "human",
  actorId: "human-2",
  role: "member",
  joinedAt: "2026-08-09T00:00:00.000Z",
  // @ts-expect-error Human membership cannot carry agent participation.
  participation: "active",
};

const humanMembershipWithConfiguredAt = {
  kind: "human" as const,
  actorId: "human-2",
  role: "member" as const,
  joinedAt: "2026-08-09T00:00:00.000Z",
  configuredAt: "2026-08-09T00:00:00.000Z",
};

// @ts-expect-error Human membership cannot carry agent configuration time.
const invalidHumanConfiguredAt: HumanRoomMembership = humanMembershipWithConfiguredAt;

const invalidAgentMembership: AgentRoomMembership = {
  kind: "agent",
  actorId: "agent-search",
  participation: "active",
  toolPermissions: ["search"],
  configuredAt: "2026-08-09T00:00:00.000Z",
  // @ts-expect-error Agent membership cannot carry a human social role.
  role: "member",
};

const conflictWithGrant = {
  conflictId: "conflict-1", roomId: "room-1", subjectId: "human-2",
  kind: "confirmation" as const, title: "Pending confirmation", state: "pending",
  allowedResolutions: ["reject_or_revoke"] as const, sourceId: "confirmation-1",
  revision: 1, grant: "secret",
};
// @ts-expect-error Departure conflicts cannot carry raw grant material.
const invalidConflictGrant: DepartureConflict = conflictWithGrant;
void invalidConflictGrant;

const draftWithAuthorId = {
  id: "message-1",
  roomId: "room-1",
  body: "由会话决定作者",
  sentAt: "2026-08-09T00:00:00.000Z",
  authorId: "human-2",
};

// @ts-expect-error A message draft cannot select its author actor.
const invalidDraftAuthorId: MessageDraft = draftWithAuthorId;

const draftWithAuthorKind = {
  id: "message-1",
  roomId: "room-1",
  body: "由会话决定作者",
  sentAt: "2026-08-09T00:00:00.000Z",
  authorKind: "human" as const,
};

// @ts-expect-error A message draft cannot select its author kind.
const invalidDraftAuthorKind: MessageDraft = draftWithAuthorKind;

const humanInvitationWithAgentId = {
  kind: "human-invitation" as const,
  roomId: "room-1",
  inviteeActorId: "human-2",
  agentId: "agent-search",
};

// @ts-expect-error A human invitation cannot configure an agent identity.
const invalidHumanInvitationAgentId: HumanInvitationRequest =
  humanInvitationWithAgentId;

const humanInvitationWithParticipation = {
  kind: "human-invitation" as const,
  roomId: "room-1",
  inviteeActorId: "human-2",
  participation: "active" as const,
};

// @ts-expect-error A human invitation cannot configure agent participation.
const invalidHumanInvitationParticipation: HumanInvitationRequest =
  humanInvitationWithParticipation;

const humanInvitationWithToolPermissions = {
  kind: "human-invitation" as const,
  roomId: "room-1",
  inviteeActorId: "human-2",
  toolPermissions: ["search"],
};

// @ts-expect-error A human invitation cannot grant agent tool permissions.
const invalidHumanInvitationToolPermissions: HumanInvitationRequest =
  humanInvitationWithToolPermissions;

const agentConfigurationWithInviteeActorId = {
  kind: "agent-configuration" as const,
  roomId: "room-1",
  agentId: "agent-search",
  participation: "active" as const,
  toolPermissions: ["search"],
  inviteeActorId: "human-2",
};

// @ts-expect-error Agent configuration cannot target a human invitee.
const invalidAgentConfigurationInviteeActorId: AgentConfigurationRequest =
  agentConfigurationWithInviteeActorId;

const invalidLightTaskPlanningField: LightTask = {
  id: "task-1", roomId: "room-1", sourceMessageId: "message-1", title: "完成评审",
  claimant: null, claimantRoleAtClaim: null, verifierRole: "owner", verifierActorId: null,
  criteria: [], status: "todo", createdAt: "2026-08-17T00:00:00.000Z",
  // @ts-expect-error LightTask cannot carry Blueprint dependency planning.
  deps: ["T-0001"],
};

const invalidBallHolderSet: BallInCourt = {
  holderId: "human-1", roomId: "room-1", sourceKind: "open-item", sourceId: "item-1",
  reason: "awaiting", since: "2026-08-17T00:00:00.000Z",
  deadline: "2026-08-18T00:00:00.000Z",
  // @ts-expect-error BallInCourt has exactly one holder and cannot carry a holder set.
  holderIds: ["human-1", "human-2"],
};

const invalidConfigurablePreemption: LegacyHumanPreemptionNotice = {
  roomId: "room-1", sourceHumanMessageId: "message-human-1",
  cancelledExecutionIds: [], rerouteStatus: "queued", occurredAt: "2026-08-17T00:00:00.000Z",
  // @ts-expect-error Human preemption is a hard rule and cannot carry an opt-out.
  enabled: false,
};
void invalidConfigurablePreemption;

// @ts-expect-error queued is an internal accepted phase, never a public execution status.
const invalidQueuedPublicStatus: AgentExecutionStatus = "queued";

const canonicalExecution: AgentExecution = {
  executionId: "execution-1", intentId: "intent-1", lineageId: "lineage-1",
  executionOrdinal: 1, roomId: "room-1", agentId: "agent-1", snapshotId: "snapshot-1",
  providerId: "provider-1", modelId: "model-1", status: "accepted", phase: "queued",
  currentAttemptSeq: 1, version: 1, queuedAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

const intentWithClientOrigin = {
  intentId: "intent-1", lineageId: "lineage-1", turnId: "turn-1", roomId: "room-1",
  sourceMessageId: "message-1", sourceRevision: 1, targetId: "target-1", agentId: "agent-1",
  origin: { kind: "routed_candidate" as const }, profileRevision: 1, assignmentRevision: 1,
  accessRevision: 1, status: "pending" as const, createdAt: "2026-08-25T00:00:00.000Z",
};
// @ts-expect-error routed_candidate is not a canonical trusted invocation origin.
const invalidClientSelectedOrigin: AgentInvocationIntent = intentWithClientOrigin;

const cancelWithReason = {
  type: "invocation.cancel" as const, requestId: "request-1", executionId: "execution-1",
  expectedVersion: 1, reason: "free text",
};
// @ts-expect-error Public cancellation cannot choose a cancellation reason.
const invalidPublicCancelReason: InvocationCancelCommand = cancelWithReason;

const cancelWithAgent = {
  type: "invocation.cancel" as const, requestId: "request-1", executionId: "execution-1",
  expectedVersion: 1, agentId: "agent-1",
};
// @ts-expect-error Public cancellation cannot select an Agent identity.
const invalidPublicCancelAgent: InvocationCancelCommand = cancelWithAgent;

const projectBoundaryRequest: ProjectBoundaryInvocationRequest = {
  purpose: "project_boundary_invocation", boundaryId: "boundary-1", boundaryKind: "checkpoint",
  projectId: "room-1", roomId: "room-1", agentId: "agent-1",
  sourceFactId: "checkpoint-1", sourceFactRevision: 1,
};
// @ts-expect-error A server-private project boundary cannot be used as a public cancel command.
const invalidPublicProjectBoundary: InvocationCancelCommand = projectBoundaryRequest;
const invalidInternalCancel: ProjectBoundaryInvocationRequest = {
  // @ts-expect-error A public cancel command cannot be used as a trusted project-boundary producer input.
  type: "invocation.cancel", requestId: "request-1", executionId: "execution-1", expectedVersion: 1,
};

declare const runtimeProviderInput: AgentRuntimeProviderInput;
declare const routerProviderInput: RouterProviderInput;

// @ts-expect-error Compiled runtime input cannot expose the retired raw conversation window.
const invalidLegacyConversation = runtimeProviderInput.visibleConversation;

// @ts-expect-error Router input cannot receive the full runtime conversation/tool context.
const invalidRouterInput: RouterProviderInput = runtimeProviderInput;
// @ts-expect-error Runtime input cannot receive the closed routing-summary contract.
const invalidRuntimeInput: AgentRuntimeProviderInput = routerProviderInput;

void invalidHumanMembership;
void invalidHumanConfiguredAt;
void invalidAgentMembership;
void invalidDraftAuthorId;
void invalidDraftAuthorKind;
void invalidHumanInvitationAgentId;
void invalidHumanInvitationParticipation;
void invalidHumanInvitationToolPermissions;
void invalidAgentConfigurationInviteeActorId;
void invalidLightTaskPlanningField;
void invalidBallHolderSet;
void invalidRouterInput;
void invalidRuntimeInput;
void invalidLegacyConversation;
void invalidQueuedPublicStatus;
void canonicalExecution;
void invalidClientSelectedOrigin;
void invalidPublicCancelReason;
void invalidPublicCancelAgent;
void projectBoundaryRequest;
void invalidPublicProjectBoundary;
void invalidInternalCancel;
