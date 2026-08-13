import {
  isActor,
  isAgentExecution,
  isAgentJudgement,
  isAgentRoomMembership,
  isCalibrationSignal,
  isHumanReadReceipt,
  isPublicAgentToolDispatch,
  isPublicToolConfirmationRequired,
  isRoomCursor,
  isHumanRoomMembership,
  isMessage,
  isOpenItem,
} from "@native-im/core";
import type {
  AgentExecution,
  AgentJudgementOutcome,
  AgentParticipation,
  Actor,
  ManagedRoom,
  Message,
  MessageDraft,
  PersistedIdentityEvent,
  PersistedRoomEvent,
  RoomRepairPage,
  RoomSyncRequest,
  RoomSyncResult,
  WorkspaceBootstrapPage,
  SnapshotVersion,
} from "@native-im/core";

type LegacyAgentExecutionTransitionStatus = "running" | "completed" | "interrupted" | "failed";

export const SNAPSHOT_REQUEST_ID_MAX_BYTES = 128;
import type { AuthenticatedPrincipal } from "../auth.js";
import type { RoomAuditRecord } from "../room-lifecycle.js";

export interface AuthenticatedSessionContext {
  readonly sessionId: string;
  readonly sessionFamilyId: string;
  readonly principal: AuthenticatedPrincipal;
}

export type RepairScope =
  | { readonly kind: "room"; readonly roomId: string }
  | { readonly kind: "catalog"; readonly principalId: string };

export interface StreamingRepairLease {
  readonly snapshotId: string;
  readonly principalId: string;
  readonly accountId: string;
  readonly sessionFamilyId: string;
  readonly scope: RepairScope;
  readonly version: SnapshotVersion;
  readonly authorizationRevision: number;
  readonly checksum?: string;
  readonly pageCount?: number;
  readonly lastPage?: number;
  readonly highestAuthorizedPage?: number;
  readonly idleExpiresAt: string;
}

export type MaterializedSnapshotManifest = {
  readonly snapshotId: string;
  readonly principalId: string;
  readonly sessionFamilyId: string;
  readonly checksum: string;
  readonly pageCount: number;
  readonly expiresAt: string;
} & (
  | {
      readonly kind: "room";
      readonly roomId: string;
      readonly accessRevision: number;
      readonly watermark: number;
    }
  | { readonly kind: "catalog"; readonly catalogRevision: number }
);

export type SnapshotRevalidationRequest =
  | {
      readonly kind: "room";
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly accessRevision: number;
    }
  | {
      readonly kind: "catalog";
      readonly context: AuthenticatedSessionContext;
      readonly catalogRevision: number;
    };

export type SnapshotMaterializedPage = RoomRepairPage | WorkspaceBootstrapPage;
export type StreamingSnapshotManifest = {
  readonly snapshotId: string;
  readonly principalId: string;
  readonly sessionFamilyId: string;
  readonly checksum: string;
  readonly pageCount: number;
} & (
  | {
      readonly kind: "room";
      readonly roomId: string;
      readonly accessRevision: number;
      readonly watermark: number;
    }
  | { readonly kind: "catalog"; readonly catalogRevision: number }
);
export type SnapshotFallbackReason = "quota" | "deadline" | "wal-growth";

export type SnapshotWorkerRequest =
  | { readonly type: "snapshot.initialize"; readonly requestId: string }
  | {
      readonly type: "snapshot.begin-room";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly responseRequestId: string;
      readonly roomId: string;
      readonly now: number;
    }
  | {
      readonly type: "snapshot.begin-catalog";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly responseRequestId: string;
      readonly now: number;
    }
  | {
      readonly type: "snapshot.read-page";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly responseRequestId: string;
      readonly snapshotId: string;
      readonly afterPage: number;
      readonly now: number;
    }
  | {
      readonly type: "snapshot.begin-streaming";
      readonly requestId: string;
      readonly lease: StreamingRepairLease;
      readonly responseRequestId: string;
    }
  | {
      readonly type: "snapshot.read-streaming-page";
      readonly requestId: string;
      readonly lease: StreamingRepairLease;
      readonly responseRequestId: string;
      readonly afterPage: number;
    }
  | {
      readonly type: "snapshot.release-streaming";
      readonly requestId: string;
      readonly snapshotId: string;
    }
  | {
      readonly type: "snapshot.invalidate";
      readonly requestId: string;
      readonly snapshotId: string;
    }
  | { readonly type: "snapshot.cache-count"; readonly requestId: string }
  | { readonly type: "snapshot.full-validation-count"; readonly requestId: string }
  | { readonly type: "snapshot.close"; readonly requestId: string };

export type SnapshotWorkerErrorCode =
  | "invalid_request"
  | "invalid_token"
  | "token_expired"
  | "session_revoked"
  | "snapshot_family_revoked"
  | "snapshot_expired"
  | "snapshot_forbidden"
  | "snapshot_not_found"
  | "snapshot_stale"
  | "room_archived"
  | "room_forbidden"
  | "room_not_found"
  | "storage_unavailable";

export type SnapshotWorkerResponse =
  | { readonly type: "snapshot.ready"; readonly requestId: string }
  | {
      readonly type: "snapshot.page";
      readonly requestId: string;
      readonly page: SnapshotMaterializedPage;
      readonly manifest: MaterializedSnapshotManifest;
    }
  | {
      readonly type: "snapshot.fallback";
      readonly requestId: string;
      readonly reason: SnapshotFallbackReason;
    }
  | {
      readonly type: "snapshot.streaming-page";
      readonly requestId: string;
      readonly page: SnapshotMaterializedPage;
      readonly manifest: StreamingSnapshotManifest;
    }
  | {
      readonly type: "snapshot.cache-count";
      readonly requestId: string;
      readonly count: number;
    }
  | {
      readonly type: "snapshot.full-validation-count";
      readonly requestId: string;
      readonly count: number;
    }
  | { readonly type: "snapshot.invalidated"; readonly requestId: string }
  | { readonly type: "snapshot.streaming-released"; readonly requestId: string }
  | { readonly type: "snapshot.closed"; readonly requestId: string }
  | {
      readonly type: "snapshot.error";
      readonly requestId: string;
      readonly code: SnapshotWorkerErrorCode;
      readonly message: string;
    };

export interface SnapshotRevalidationStore {
  revalidateSnapshot(validation: SnapshotRevalidationRequest): Promise<void>;
}

export interface HashedSessionIssue {
  readonly accountId: string;
  readonly actorId: string;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

export interface HashedSessionRotation {
  readonly currentRefreshTokenHash: string;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly expectedPrincipal?: AuthenticatedPrincipal;
  readonly now: number;
}

export interface IssuedSessionRecord {
  readonly sessionId: string;
  readonly familyId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

export interface SessionAuthority {
  issue(input: HashedSessionIssue): Promise<IssuedSessionRecord>;
  authenticate(
    accessTokenHash: string,
    now: number,
  ): Promise<AuthenticatedSessionContext>;
  validateRefresh(
    currentRefreshTokenHash: string,
    expectedPrincipal: AuthenticatedPrincipal | undefined,
    now: number,
  ): Promise<void>;
  rotate(input: HashedSessionRotation): Promise<IssuedSessionRecord>;
  revoke(accessTokenHash: string, now: number): Promise<void>;
}

export interface AuthenticatedCommandContext extends AuthenticatedSessionContext {
  readonly kind: "human";
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface AgentPrincipal {
  readonly actorId: string;
  readonly kind: "agent";
}

const internalCommandAuthority: unique symbol = Symbol("internal-agent-command-authority");
const internalAgentCommandContexts = new WeakSet<object>();
const internalRuntimeAuthority: unique symbol = Symbol("internal-agent-runtime-authority");
const internalAgentRuntimeContexts = new WeakSet<object>();

export interface InternalAgentCommandContext {
  readonly kind: "agent";
  readonly [internalCommandAuthority]: true;
  readonly agent: AgentPrincipal;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface AgentWorkerCommandContext {
  readonly kind: "agent";
  readonly agent: AgentPrincipal;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface InternalAgentRuntimeContext {
  readonly kind: "runtime";
  readonly [internalRuntimeAuthority]: true;
  readonly runtimeId: string;
  readonly agentId: string;
}

export interface AgentRuntimeWorkerContext {
  readonly kind: "runtime";
  readonly runtimeId: string;
  readonly agentId: string;
}

export interface InternalAgentRuntimeContextInput {
  readonly runtimeId: string;
  readonly agentId: string;
}

export type AgentInvocationIntentKind =
  | "direct_mention"
  | "structured_help"
  | "routed_candidate";

export interface AgentInvocationInput {
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly targetAgentId: string;
  readonly intentKind: AgentInvocationIntentKind;
  readonly providerId: string;
  readonly modelId: string;
}

interface CommitExecutionStepInputBase {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly stepSeq: number;
  readonly inputSha256: string;
  readonly outputSha256: string;
  readonly now: number;
}

export interface AgentRuntimeToolPlanEntry {
  readonly callId: string;
  readonly toolId: string;
  readonly parameters: JsonValue;
}

export type CommitExecutionStepInput = CommitExecutionStepInputBase & (
  | {
      readonly stepKind: "model_generation";
      readonly canonicalToolCall?: never;
      readonly boundedToolResult?: never;
    }
  | {
      readonly stepKind: "tool_call";
      readonly canonicalToolCall: {
        readonly toolId: string;
        readonly parameters?: JsonValue;
        readonly remainingCalls?: readonly AgentRuntimeToolPlanEntry[];
      };
      readonly boundedToolResult?: never;
    }
  | {
      readonly stepKind: "tool_result";
      readonly canonicalToolCall?: never;
      readonly dispatchId: string;
      readonly boundedToolResult: Exclude<JsonValue, null>;
    }
);

export interface ScheduleRetryInput {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly errorCode: "rate_limited" | "upstream_timeout" | "upstream_unavailable" | "target_busy" | "runtime_restarted";
  readonly now: number;
}

export type AgentRuntimeTerminalErrorCode =
  | "provider_cancelled"
  | "provider_input_too_large"
  | "provider_invalid_request"
  | "provider_invalid_response"
  | "provider_not_configured"
  | "provider_failure"
  | "provider_response_too_large"
  | "provider_unauthorized"
  | "tool_failure";

export interface FailExecutionInput {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly errorCode: AgentRuntimeTerminalErrorCode;
  readonly now: number;
}

export interface CompleteExecutionInput {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly messageId: string;
  readonly body: string;
  readonly sentAt: string;
  readonly now: number;
}

export interface CompleteCompensationInput extends CompleteExecutionInput {
  readonly dispatchId: string;
  readonly grantId: string;
  readonly boundedToolResult: Exclude<JsonValue, null>;
  readonly inputSha256: string;
  readonly outputSha256: string;
  readonly closedSummary: string;
}

export interface InterruptExecutionInput {
  readonly executionId: string;
  readonly reason: "requested_by_requester" | "requested_by_room_manager";
}

export type ToolConfirmationRequirement = "read_only" | "side_effect";

export interface PrepareToolInput {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly toolCallStepSeq: number;
  readonly toolId: string;
  readonly parameterHash: string;
  readonly toolPlanHash: string;
  readonly confirmationRequirement: ToolConfirmationRequirement;
  readonly now: number;
  readonly expiresAt: number;
}

export interface ToolGrant {
  readonly id: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly toolCallStepSeq: number;
  readonly agentId: string;
  readonly roomId: string;
  readonly toolId: string;
  readonly parameterHash: string;
  readonly toolPlanHash: string;
  readonly confirmationRequirement: ToolConfirmationRequirement;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

export interface ToolConfirmationInput {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly toolId: string;
  readonly parameterHash: string;
  readonly target: string;
  readonly impact: string;
  readonly reversibility: "compensatable" | "irreversible";
  readonly expiresAt: number;
}

export interface ToolConfirmation {
  readonly id: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly grantId: string;
  readonly toolId: string;
  readonly parameterHash: string;
  readonly toolPlanHash: string;
  readonly roomId: string;
  readonly humanPrincipalId: string;
  readonly sessionFamilyId: string;
  readonly target: string;
  readonly impact: string;
  readonly reversibility: "compensatable" | "irreversible";
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

export interface ResumeConfirmedToolInput {
  readonly confirmationId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly roomId: string;
  readonly toolId: string;
  readonly parameterHash: string;
  readonly toolPlanHash: string;
  readonly now: number;
}

export interface ResumedToolDispatch {
  readonly confirmationId: string;
  readonly execution: AgentExecution;
  readonly dispatch: ToolDispatch;
  readonly parameters: JsonValue;
  readonly remainingCalls: readonly AgentRuntimeToolPlanEntry[];
  readonly toolPlanHash: string;
}

export interface AgentRuntimeRecovery {
  readonly execution: AgentExecution;
  readonly nextRetryAt?: number;
}

export interface AgentRuntimeRecoveryPageInput {
  readonly now: number;
  readonly limit: number;
  readonly cursor?: string;
}

export interface AgentRuntimeRecoveryPage {
  readonly recoveries: readonly AgentRuntimeRecovery[];
  readonly nextCursor?: string;
}

export type DispatchToolInput = {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly grantId: string;
  readonly toolId: string;
  readonly parameterHash: string;
  readonly now: number;
} & (
  | { readonly confirmationRequirement: "read_only"; readonly confirmationId?: never }
  | { readonly confirmationRequirement: "side_effect"; readonly confirmationId: string }
);

export interface SettleToolInput {
  readonly dispatchId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly grantId: string;
  readonly outcome: "succeeded" | "failed" | "outcome_unknown";
  readonly closedSummary?: string;
  readonly sealedCompensation?: string;
  readonly now: number;
}

export interface CancelForHumanFenceInput {
  readonly executionId: string;
  readonly fenceMessageId: string;
  readonly now: number;
}

export interface ToolDispatch {
  readonly id: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly grantId: string;
  readonly toolId: string;
  readonly parameterHash: string;
  readonly state: "dispatched" | "succeeded" | "failed" | "outcome_unknown";
  readonly dispatchedAt: string;
  readonly settledAt?: string;
  readonly closedSummary?: string;
  readonly sealedCompensation?: string;
}

export interface ResumeAgentRuntimeCompensationInput {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly now: number;
}

export interface AgentRuntimeCompensationWork {
  readonly execution: AgentExecution;
  readonly dispatch: ToolDispatch;
  readonly sealedCompensation: string;
}

export interface AgentRuntimeAuthorityStore {
  invoke(
    context: AuthenticatedCommandContext | InternalAgentCommandContext,
    input: AgentInvocationInput,
    maxQueuedPerRoom?: number,
  ): Promise<AgentExecution>;
  claimNext(runtime: InternalAgentRuntimeContext, roomId: string, now: number): Promise<AgentExecution | undefined>;
  commitStep(runtime: InternalAgentRuntimeContext, input: CommitExecutionStepInput): Promise<AgentExecution>;
  completeExecution(runtime: InternalAgentRuntimeContext, input: CompleteExecutionInput): Promise<AgentExecution>;
  completeCompensation(
    runtime: InternalAgentRuntimeContext,
    input: CompleteCompensationInput,
  ): Promise<AgentExecution>;
  scheduleRetry(runtime: InternalAgentRuntimeContext, input: ScheduleRetryInput): Promise<AgentExecution>;
  failExecution(runtime: InternalAgentRuntimeContext, input: FailExecutionInput): Promise<AgentExecution>;
  interrupt(context: AuthenticatedCommandContext, input: InterruptExecutionInput): Promise<AgentExecution>;
  manualRetry(
    context: AuthenticatedCommandContext,
    executionId: string,
    maxQueuedPerRoom?: number,
  ): Promise<AgentExecution>;
  compensate(
    context: AuthenticatedCommandContext,
    executionId: string,
    dispatchId: string,
    maxQueuedPerRoom?: number,
  ): Promise<AgentExecution>;
  resumeCompensation(
    runtime: InternalAgentRuntimeContext,
    input: ResumeAgentRuntimeCompensationInput,
  ): Promise<AgentRuntimeCompensationWork>;
  prepareTool(runtime: InternalAgentRuntimeContext, input: PrepareToolInput): Promise<ToolGrant>;
  confirmTool(context: AuthenticatedCommandContext, input: ToolConfirmationInput): Promise<ToolConfirmation>;
  resumeConfirmedTool(
    runtime: InternalAgentRuntimeContext,
    input: ResumeConfirmedToolInput,
  ): Promise<ResumedToolDispatch>;
  dispatchTool(runtime: InternalAgentRuntimeContext, input: DispatchToolInput): Promise<ToolDispatch>;
  settleTool(runtime: InternalAgentRuntimeContext, input: SettleToolInput): Promise<ToolDispatch>;
  cancelForHumanFence(runtime: InternalAgentRuntimeContext, input: CancelForHumanFenceInput): Promise<AgentExecution>;
  recoverPage(
    runtime: InternalAgentRuntimeContext,
    input: AgentRuntimeRecoveryPageInput,
  ): Promise<AgentRuntimeRecoveryPage>;
  readExecution(context: AuthenticatedSessionContext, executionId: string): Promise<AgentExecution>;
  loadProviderContext(
    runtime: InternalAgentRuntimeContext,
    executionId: string,
  ): Promise<AgentRuntimeProviderContext>;
}

export interface AgentRuntimeProviderContext {
  readonly invocation: {
    readonly sourceMessageId: string;
    readonly requesterActorId: string;
    readonly targetAgentId: string;
    readonly intentKind: "direct_mention" | "structured_help" | "routed_candidate";
  };
  readonly visibleConversation: readonly {
    readonly messageId: string;
    readonly actorId: string;
    readonly body: string;
  }[];
  readonly committedSteps: readonly {
    readonly stepSeq: number;
    readonly kind: "model_generation" | "tool_call" | "tool_result";
    readonly modelInput: JsonValue;
  }[];
}

export interface InternalAgentCommandContextInput {
  readonly agentId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

class AgentCapabilityForbiddenError extends Error {
  readonly status = 403 as const;
  readonly code = "agent_capability_forbidden" as const;

  constructor() {
    super("agent_capability_forbidden");
    this.name = "AgentCapabilityForbiddenError";
  }
}

export function mintInternalAgentCommandContext(
  input: InternalAgentCommandContextInput,
): InternalAgentCommandContext {
  if (
    typeof input.agentId !== "string" ||
    input.agentId.trim().length === 0 ||
    typeof input.requestId !== "string" ||
    input.requestId.trim().length === 0 ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.trim().length === 0
  ) {
    throw new TypeError("Internal Agent command context fields must be non-empty");
  }
  const context: InternalAgentCommandContext = Object.freeze({
    kind: "agent",
    [internalCommandAuthority]: true as const,
    agent: Object.freeze({ actorId: input.agentId, kind: "agent" }),
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
  });
  internalAgentCommandContexts.add(context);
  return context;
}

export function isInternalAgentCommandContext(
  value: unknown,
): value is InternalAgentCommandContext {
  return typeof value === "object" && value !== null && internalAgentCommandContexts.has(value);
}

export function mintInternalAgentRuntimeContext(
  input: InternalAgentRuntimeContextInput,
): InternalAgentRuntimeContext {
  if (typeof input.runtimeId !== "string" || input.runtimeId.trim().length === 0 ||
      typeof input.agentId !== "string" || input.agentId.trim().length === 0) {
    throw new TypeError("Internal Agent runtime context runtimeId and agentId must be non-empty");
  }
  const context: InternalAgentRuntimeContext = Object.freeze({
    kind: "runtime",
    [internalRuntimeAuthority]: true as const,
    runtimeId: input.runtimeId,
    agentId: input.agentId,
  });
  internalAgentRuntimeContexts.add(context);
  return context;
}

export function isInternalAgentRuntimeContext(
  value: unknown,
): value is InternalAgentRuntimeContext {
  return typeof value === "object" && value !== null && internalAgentRuntimeContexts.has(value);
}

export function toAgentRuntimeWorkerContext(
  context: InternalAgentRuntimeContext,
): AgentRuntimeWorkerContext {
  if (!isInternalAgentRuntimeContext(context)) {
    throw new AgentCapabilityForbiddenError();
  }
  return Object.freeze({ kind: "runtime", runtimeId: context.runtimeId, agentId: context.agentId });
}

export function toAgentWorkerCommandContext(
  context: InternalAgentCommandContext,
): AgentWorkerCommandContext {
  if (!isInternalAgentCommandContext(context)) {
    throw new AgentCapabilityForbiddenError();
  }
  return Object.freeze({
    kind: "agent",
    agent: Object.freeze({ ...context.agent }),
    requestId: context.requestId,
    idempotencyKey: context.idempotencyKey,
  });
}

type CommandActorFreePayload = {
  readonly actorId?: never;
  readonly agentId?: never;
  readonly authorId?: never;
  readonly authorKind?: never;
};

export type CollaborationCommand =
  | { readonly type: "message.send"; readonly roomId: string; readonly payload: MessageDraft & CommandActorFreePayload }
  | {
      readonly type: "human.read.record";
      readonly roomId: string;
      readonly payload: { readonly messageId: string } & CommandActorFreePayload;
    }
  | {
      readonly type: "agent.judgment.record";
      readonly roomId: string;
      readonly payload: {
        readonly messageId: string;
        readonly outcome: AgentJudgementOutcome;
        readonly reason: string;
      } & CommandActorFreePayload;
    }
  | {
      readonly type: "open-item.create";
      readonly roomId: string;
      readonly payload: {
        readonly sourceMessageId: string;
        readonly ownerId: string;
        readonly content: string;
      } & CommandActorFreePayload;
    }
  | {
      readonly type: "open-item.transition";
      readonly roomId: string;
      readonly payload: {
        readonly itemId: string;
        readonly action: "respond" | "defer" | "transfer";
        readonly targetId?: string;
        readonly reason?: string;
      } & CommandActorFreePayload;
    }
  | {
      readonly type: "agent.execution.transition";
      readonly roomId: string;
      readonly payload: {
        readonly executionId: string;
        readonly sourceMessageId: string;
        readonly toolName: string;
        readonly status: LegacyAgentExecutionTransitionStatus;
        readonly result?: string;
      } & CommandActorFreePayload;
    }
  | {
      readonly type: "calibration.record";
      readonly roomId: string;
      readonly payload: {
        readonly sourceMessageId: string;
        readonly emoji: "👍" | "👎";
      } & CommandActorFreePayload;
    };

export type HumanCollaborationCommand = Extract<
  CollaborationCommand,
  { readonly type: "message.send" | "human.read.record" | "open-item.create" | "open-item.transition" | "calibration.record" }
>;

export type AgentCollaborationCommand = Extract<
  CollaborationCommand,
  { readonly type: "message.send" | "agent.judgment.record" | "open-item.create" | "open-item.transition" | "agent.execution.transition" }
>;

export type RoomGovernanceCommand =
  | { readonly type: "room.create"; readonly payload: { readonly name: string } }
  | { readonly type: "room.rename"; readonly roomId: string; readonly payload: { readonly name: string } }
  | { readonly type: "room.archive"; readonly roomId: string; readonly payload: Record<string, never> }
  | {
      readonly type: "human.invitation.issue";
      readonly roomId: string;
      readonly payload: { readonly inviteeActorId: string };
    }
  | {
      readonly type: "human.invitation.decide";
      readonly payload: { readonly token: string; readonly decision: "accept" | "reject" };
    }
  | {
      readonly type: "agent.configure";
      readonly roomId: string;
      readonly payload: {
        readonly agentId: string;
        readonly participation: AgentParticipation;
        readonly toolPermissions: readonly string[];
      };
    }
  | {
      readonly type: "human.role.change";
      readonly roomId: string;
      readonly payload: { readonly targetActorId: string; readonly role: "admin" | "member" };
    }
  | {
      readonly type: "member.remove";
      readonly roomId: string;
      readonly payload: { readonly targetActorId: string };
    };

export type PersistentCommand = CollaborationCommand | RoomGovernanceCommand;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CommandAcknowledgement {
  readonly aggregateId: string;
  readonly eventIds: readonly string[];
  readonly acceptedAt: string;
  readonly result: JsonValue;
}

interface OutboxDeliveryBase {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly targetId: string;
  readonly streamSeq: number;
  readonly attempts: number;
}

type PersistedSessionRevokedEvent = PersistedIdentityEvent & {
  readonly type: "identity.session.revoked";
};

type PersistedRoomAccessChangedEvent = PersistedIdentityEvent & {
  readonly type: "identity.room-access.changed";
};

export type OutboxDelivery =
  | (OutboxDeliveryBase & {
      readonly targetKind: "room";
      readonly event: PersistedRoomEvent;
    })
  | (OutboxDeliveryBase & {
      readonly targetKind: "principal";
      readonly event: PersistedRoomAccessChangedEvent;
    })
  | (OutboxDeliveryBase & {
      readonly targetKind: "session-family";
      readonly event: PersistedSessionRevokedEvent;
    });

export interface OutboxDispatchCandidate {
  readonly connectionId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly sessionId: string;
  readonly sessionFamilyId: string;
  readonly credentialGeneration: number;
}

export type OutboxDeliveryFailureReason =
  | "closed"
  | "backpressure"
  | "send_rejected";

export interface CommandStore {
  executeHuman(
    context: AuthenticatedCommandContext,
    command: HumanCollaborationCommand | RoomGovernanceCommand,
  ): Promise<CommandAcknowledgement>;
  executeAgent(
    context: InternalAgentCommandContext,
    command: AgentCollaborationCommand,
  ): Promise<CommandAcknowledgement>;
}

export interface SyncQueryStore {
  syncRoom(context: AuthenticatedSessionContext, request: RoomSyncRequest): Promise<RoomSyncResult>;
  readHistory(context: AuthenticatedSessionContext, roomId: string): Promise<readonly Message[]>;
  readActor(actorId: string): Promise<Actor | undefined>;
  readRoom(roomId: string): Promise<ManagedRoom | undefined>;
  canAccessRoom(context: AuthenticatedSessionContext, roomId: string): Promise<boolean>;
  readRoomAudit(
    context: AuthenticatedSessionContext,
    roomId: string,
  ): Promise<readonly RoomAuditRecord[]>;
  listPendingOutbox(limit: number): Promise<readonly OutboxDelivery[]>;
  authorizeOutboxCandidate(
    delivery: OutboxDelivery,
    candidate: OutboxDispatchCandidate,
  ): Promise<boolean>;
  markOutboxDispatched(deliveryId: string): Promise<void>;
  markOutboxFailed(
    deliveryId: string,
    reason: OutboxDeliveryFailureReason,
  ): Promise<void>;
}

export const ROOM_SYNC_DEFAULT_LIMIT = 100;
export const ROOM_SYNC_MAX_LIMIT = 1_000;
export const ROOM_SYNC_MAX_PAGE_BYTES = 256 * 1_024;

export type ContractParseResult<T, TCode extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: TCode };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function count(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function stringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length;
}

export function parseRoomSyncRequest(
  value: unknown,
): ContractParseResult<RoomSyncRequest, "invalid_request"> {
  if (!isRecord(value)) {
    return { ok: false, code: "invalid_request" };
  }
  const optional = [
    ...(Object.hasOwn(value, "cursor") ? ["cursor"] : []),
    ...(Object.hasOwn(value, "limit") ? ["limit"] : []),
  ];
  if (
    !exact(value, ["type", "requestId", "roomId"], optional) ||
    value.type !== "room.sync" ||
    !text(value.requestId) ||
    !text(value.roomId) ||
    (Object.hasOwn(value, "cursor") && !isRoomCursor(value.cursor)) ||
    (Object.hasOwn(value, "limit") &&
      (!count(value.limit, 1) || value.limit > ROOM_SYNC_MAX_LIMIT))
  ) {
    return { ok: false, code: "invalid_request" };
  }
  return { ok: true, value: value as unknown as RoomSyncRequest };
}

function messageDraft(value: unknown, roomId: string): value is MessageDraft {
  return isRecord(value) && exact(value, ["id", "roomId", "body", "sentAt"]) &&
    text(value.id) && value.roomId === roomId && text(value.body) && text(value.sentAt);
}

function commandEnvelope(value: UnknownRecord, withRoom: boolean): value is UnknownRecord {
  return exact(value, withRoom ? ["type", "roomId", "payload"] : ["type", "payload"]) &&
    text(value.type) && (!withRoom || text(value.roomId)) && isRecord(value.payload);
}

function isCollaborationCommand(value: UnknownRecord): boolean {
  if (!commandEnvelope(value, true)) {
    return false;
  }
  const payload = value.payload as UnknownRecord;
  if (value.type === "message.send") {
    return messageDraft(payload, value.roomId as string);
  }
  if (value.type === "human.read.record") {
    return exact(payload, ["messageId"]) && text(payload.messageId);
  }
  if (value.type === "agent.judgment.record") {
    return exact(payload, ["messageId", "outcome", "reason"]) && text(payload.messageId) &&
      (payload.outcome === "will_respond" || payload.outcome === "no_response_needed" || payload.outcome === "suppressed") &&
      text(payload.reason);
  }
  if (value.type === "open-item.create") {
    return exact(payload, ["sourceMessageId", "ownerId", "content"]) &&
      text(payload.sourceMessageId) && text(payload.ownerId) && text(payload.content);
  }
  if (value.type === "open-item.transition") {
    if (payload.action === "transfer") {
      return exact(payload, ["itemId", "action", "targetId", "reason"]) &&
        text(payload.itemId) && text(payload.targetId) && text(payload.reason);
    }
    return (payload.action === "respond" || payload.action === "defer") &&
      exact(payload, ["itemId", "action"]) && text(payload.itemId);
  }
  if (value.type === "agent.execution.transition") {
    return exact(payload, ["executionId", "sourceMessageId", "toolName", "status"], ["result"]) &&
      text(payload.executionId) && text(payload.sourceMessageId) && text(payload.toolName) &&
      (payload.status === "running" || payload.status === "completed" || payload.status === "interrupted" || payload.status === "failed") &&
      (payload.result === undefined || text(payload.result));
  }
  return value.type === "calibration.record" &&
    exact(payload, ["sourceMessageId", "emoji"]) && text(payload.sourceMessageId) &&
    (payload.emoji === "👍" || payload.emoji === "👎");
}

function isGovernanceCommand(value: UnknownRecord): boolean {
  const withRoom = value.type !== "room.create" && value.type !== "human.invitation.decide";
  if (!commandEnvelope(value, withRoom)) {
    return false;
  }
  const payload = value.payload as UnknownRecord;
  if (value.type === "room.create" || value.type === "room.rename") {
    return exact(payload, ["name"]) && text(payload.name);
  }
  if (value.type === "room.archive") {
    return exact(payload, []);
  }
  if (value.type === "human.invitation.issue") {
    return exact(payload, ["inviteeActorId"]) && text(payload.inviteeActorId);
  }
  if (value.type === "human.invitation.decide") {
    return exact(payload, ["token", "decision"]) && text(payload.token) &&
      (payload.decision === "accept" || payload.decision === "reject");
  }
  if (value.type === "agent.configure") {
    return exact(payload, ["agentId", "participation", "toolPermissions"]) && text(payload.agentId) &&
      (payload.participation === "active" || payload.participation === "on-mention" || payload.participation === "silent") &&
      stringList(payload.toolPermissions);
  }
  if (value.type === "human.role.change") {
    return exact(payload, ["targetActorId", "role"]) && text(payload.targetActorId) &&
      (payload.role === "admin" || payload.role === "member");
  }
  return value.type === "member.remove" && exact(payload, ["targetActorId"]) && text(payload.targetActorId);
}

export function parsePersistentCommand(
  value: unknown,
): ContractParseResult<PersistentCommand, "invalid_command"> {
  return isRecord(value) && (isCollaborationCommand(value) || isGovernanceCommand(value))
    ? { ok: true, value: value as PersistentCommand }
    : { ok: false, code: "invalid_command" };
}

function roomEventEnvelope(value: UnknownRecord): value is UnknownRecord {
  return exact(
    value,
    ["eventId", "streamKind", "streamId", "streamSeq", "roomId", "actorId", "occurredAt", "type", "payload"],
  ) && value.streamKind === "room" && text(value.eventId) && text(value.streamId) &&
    value.streamId === value.roomId && count(value.streamSeq, 1) && text(value.actorId) &&
    text(value.occurredAt) && text(value.type) && isRecord(value.payload);
}

function strictMessage(value: unknown): boolean {
  return isRecord(value) && exact(value, ["id", "roomId", "authorId", "authorKind", "body", "sentAt"]) && isMessage(value) &&
    text(value.id) && text(value.roomId) && text(value.authorId) && text(value.body) && text(value.sentAt);
}

function strictHumanMembership(value: unknown): boolean {
  return isRecord(value) && exact(value, ["kind", "actorId", "role", "joinedAt"]) && isHumanRoomMembership(value) &&
    text(value.actorId) && text(value.joinedAt);
}

function strictAgentMembership(value: unknown): boolean {
  return isRecord(value) && exact(value, ["kind", "actorId", "participation", "toolPermissions", "configuredAt"]) &&
    isAgentRoomMembership(value) && text(value.actorId) && stringList(value.toolPermissions) && text(value.configuredAt);
}

function strictManagedRoom(value: unknown): boolean {
  return isRecord(value) && exact(value, ["id", "name", "status", "members", "createdAt"]) &&
    text(value.id) && text(value.name) && (value.status === "active" || value.status === "archived") &&
    Array.isArray(value.members) && value.members.every((entry) => strictHumanMembership(entry) || strictAgentMembership(entry)) &&
    text(value.createdAt);
}

function validRoomEventPayload(
  type: unknown,
  payload: UnknownRecord,
  roomId: string,
  eventActorId: string,
): boolean {
  if (type === "room.created" || type === "room.renamed" || type === "room.archived") {
    return exact(payload, ["room"]) && strictManagedRoom(payload.room) &&
      (payload.room as { readonly id: string }).id === roomId;
  }
  if (type === "human.invitation.issued") {
    return exact(payload, ["invitationId", "inviteeActorId"]) && text(payload.invitationId) && text(payload.inviteeActorId);
  }
  if (type === "human.invitation.accepted") {
    return exact(payload, ["invitationId", "membership"]) && text(payload.invitationId) && strictHumanMembership(payload.membership);
  }
  if (type === "human.invitation.rejected") {
    return exact(payload, ["invitationId", "targetActorId"]) && text(payload.invitationId) && text(payload.targetActorId);
  }
  if (type === "human.role.changed") {
    return exact(payload, ["membership"]) && strictHumanMembership(payload.membership);
  }
  if (type === "member.removed") {
    return exact(payload, ["targetActorId"]) && text(payload.targetActorId);
  }
  if (type === "agent.configured") {
    return exact(payload, ["membership"]) && strictAgentMembership(payload.membership);
  }
  if (type === "room.message.accepted") {
    return strictMessage(payload) && payload.roomId === roomId && payload.authorId === eventActorId;
  }
  if (type === "room.human_read.recorded") {
    return isHumanReadReceipt(payload) && payload.readerId === eventActorId;
  }
  if (type === "room.agent_judgment.recorded") {
    return isAgentJudgement(payload) && payload.agentId === eventActorId;
  }
  if (type === "room.open_item.changed") {
    return isOpenItem(payload) && payload.roomId === roomId;
  }
  if (type === "room.agent_execution.changed") {
    return isAgentExecution(payload) && payload.roomId === roomId && payload.agentId === eventActorId;
  }
  if (type === "room.agent_tool_dispatch.changed") {
    return isPublicAgentToolDispatch(payload) && payload.roomId === roomId && payload.agentId === eventActorId;
  }
  if (type === "room.agent_tool_confirmation.required") {
    return isPublicToolConfirmationRequired(payload) && payload.roomId === roomId && payload.agentId === eventActorId;
  }
  return type === "room.calibration.recorded" && isCalibrationSignal(payload) && payload.actorId === eventActorId;
}

export function parsePersistedRoomEvent(
  value: unknown,
): ContractParseResult<PersistedRoomEvent, "invalid_event"> {
  return isRecord(value) && roomEventEnvelope(value) && validRoomEventPayload(
    value.type,
    value.payload as UnknownRecord,
    value.roomId as string,
    value.actorId as string,
  )
    ? { ok: true, value: value as unknown as PersistedRoomEvent }
    : { ok: false, code: "invalid_event" };
}

function identityEventEnvelope(value: UnknownRecord): value is UnknownRecord {
  return exact(
    value,
    ["eventId", "streamKind", "streamId", "streamSeq", "actorId", "occurredAt", "type", "payload"],
  ) && value.streamKind === "identity" && text(value.eventId) && text(value.streamId) &&
    value.streamId === value.actorId && count(value.streamSeq, 1) && text(value.actorId) &&
    text(value.occurredAt) && text(value.type) && isRecord(value.payload);
}

function strictActor(value: unknown): boolean {
  if (!isRecord(value) || !isActor(value)) return false;
  return value.kind === "human"
    ? exact(value, ["id", "kind", "displayName", "reachability"])
    : exact(value, ["id", "kind", "displayName", "readiness", "toolPermissions"]);
}

function validIdentityEventPayload(type: unknown, payload: UnknownRecord): boolean {
  if (type === "identity.actor.registered") {
    return exact(payload, ["actor"]) && strictActor(payload.actor);
  }
  if (type === "identity.session.issued" || type === "identity.session.rotated" || type === "identity.session.revoked") {
    return exact(payload, ["sessionId", "familyId", "accountId"]) &&
      text(payload.sessionId) && text(payload.familyId) && text(payload.accountId);
  }
  return type === "identity.room-access.changed" &&
    exact(payload, ["roomId", "change"]) && text(payload.roomId) &&
    (payload.change === "joined" || payload.change === "updated" || payload.change === "removed" || payload.change === "archived");
}

export function parsePersistedIdentityEvent(
  value: unknown,
): ContractParseResult<PersistedIdentityEvent, "invalid_event"> {
  return isRecord(value) && identityEventEnvelope(value) && validIdentityEventPayload(value.type, value.payload as UnknownRecord) &&
    (value.type !== "identity.actor.registered" ||
      (value.payload as { readonly actor: { readonly id: string } }).actor.id === value.streamId)
    ? { ok: true, value: value as unknown as PersistedIdentityEvent }
    : { ok: false, code: "invalid_event" };
}
