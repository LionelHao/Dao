export interface HumanReadReceipt {
  readonly id: string;
  readonly messageId: string;
  readonly readerId: string;
  readonly readAt: string;
}

export type AgentJudgementOutcome = "will_respond" | "no_response_needed" | "suppressed";

export interface AgentJudgement {
  readonly id: string;
  readonly messageId: string;
  readonly agentId: string;
  readonly outcome: AgentJudgementOutcome;
  readonly reason: string;
  readonly decidedAt: string;
}

export type OpenItemStatus = "awaiting" | "answered" | "deferred" | "transferred";

export type OpenItemOrigin =
  | { readonly kind: "human_mention" }
  | { readonly kind: "manual_unfinished" }
  | {
      readonly kind: "agent_proposal";
      readonly proposalKind: "risk" | "challenge";
      readonly sourceExecutionId: string;
      readonly reason: string;
    };

export interface OpenItemTransfer {
  readonly fromId: string;
  readonly toId: string;
  readonly reason: string;
  readonly transferredAt: string;
}

export interface OpenItem {
  readonly id: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly requesterId: string;
  readonly currentOwnerId: string | null;
  readonly content: string;
  readonly status: OpenItemStatus;
  readonly origin: OpenItemOrigin;
  readonly createdAt: string;
  readonly respondedAt?: string;
  readonly transferChain: readonly OpenItemTransfer[];
}

export interface OpenItemAgentFailure {
  readonly id: string;
  readonly openItemId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly reasonCode: string;
  readonly failedAt: string;
}

export type LightTaskStatus = "todo" | "claimed" | "delivered" | "verified";
export type LightTaskVerifierRole = "owner" | "admin" | "member";

export interface LightTaskCriterion {
  readonly id: string;
  readonly text: string;
  readonly met: boolean;
}

export interface LightTask {
  readonly id: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly title: string;
  readonly claimant: string | null;
  readonly claimantRoleAtClaim: LightTaskVerifierRole | null;
  readonly verifierRole: LightTaskVerifierRole;
  readonly verifierActorId: string | null;
  readonly criteria: readonly LightTaskCriterion[];
  readonly status: LightTaskStatus;
  readonly createdAt: string;
  readonly claimedAt?: string;
  readonly deliveredAt?: string;
  readonly verifiedAt?: string;
}

export type LightTaskProjection = Pick<
  LightTask,
  | "id"
  | "roomId"
  | "sourceMessageId"
  | "title"
  | "claimant"
  | "status"
  | "criteria"
>;

export type BallSourceKind =
  | "open-item"
  | "light-task"
  | "blueprint-task"
  | "blueprint-awaiting"
  | "blueprint-blocked-mention";

export interface BallInCourt {
  readonly holderId: string;
  readonly roomId: string;
  readonly sourceKind: BallSourceKind;
  readonly sourceId: string;
  readonly reason: string;
  readonly since: string;
  readonly deadline: string;
}

export type BlueprintBallFact =
  | {
      readonly sourceKind: "blueprint-task" | "blueprint-awaiting";
      readonly sourceId: string;
      readonly roomId: string;
      readonly assigneeId: string;
      readonly reason: string;
      readonly since: string;
    }
  | {
      readonly sourceKind: "blueprint-blocked-mention";
      readonly sourceId: string;
      readonly roomId: string;
      readonly mentionedActorId: string;
      readonly reason: string;
      readonly since: string;
    };

export interface NeedsActionProjection {
  readonly roomId: string;
  readonly actorId: string;
  readonly ball: BallInCourt;
  readonly overdue: boolean;
}

export interface ReminderCandidate {
  readonly roomId: string;
  readonly recipientId: string;
  readonly sourceKind: BallSourceKind;
  readonly sourceId: string;
  readonly dueAt: string;
}

export interface BallOverdueTrigger {
  readonly id: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly ball: BallInCourt;
  readonly triggeredAt: string;
}

export interface BallProjectionInput {
  readonly openItems: readonly OpenItem[];
  readonly lightTasks: readonly LightTask[];
  readonly blueprintFacts: readonly BlueprintBallFact[];
  readonly openItemDeadlineMs: number;
  readonly lightTaskDeadlineMs: number;
}

export type AgentExecutionStatus = "accepted" | "running" | "completed" | "failed" | "cancelled";
export type AgentExecutionAcceptedPhase =
  | "queued"
  | "retry_scheduled"
  | "recovery_queued"
  | "awaiting_capacity";
export type AgentExecutionRunningPhase =
  | "claiming"
  | "snapshot_frozen"
  | "model_generation"
  | "read_tool"
  | "waiting_confirmation"
  | "side_effect_claimed"
  | "final_committing";
export type AgentExecutionTerminalPhase = "completed" | "failed" | "cancelled";
export type AgentExecutionPhase =
  | AgentExecutionAcceptedPhase
  | AgentExecutionRunningPhase
  | AgentExecutionTerminalPhase;
export type AgentExecutionActionCategory = "model_generation" | "tool_call" | "waiting_upstream";
export type AgentToolDispatchPhase = "not_started" | "dispatched" | "finished";
export type AgentExecutionReviewState = "not_required" | "needs_review" | "reviewed";

export type InvocationOrigin =
  | Readonly<{
      kind: "message_target";
      messageTransactionId: string;
      targetId: string;
    }>
  | Readonly<{
      kind: "route_decision";
      routeJobId: string;
      judgmentId: string;
    }>
  | Readonly<{
      kind: "project_boundary";
      boundaryId: string;
      boundaryKind: "checkpoint" | "due" | "blocker" | "agent_ball";
    }>;

export type InvocationCancellationReason =
  | "human_cancelled"
  | "reply_superseded"
  | "correction_superseded"
  | "intent_superseded"
  | "message_recalled"
  | "room_archived"
  | "membership_revoked"
  | "assignment_revoked"
  | "profile_disabled"
  | "capability_revoked"
  | "source_ineligible"
  | "runtime_shutdown";

export interface AgentInvocationIntent {
  readonly intentId: string;
  readonly lineageId: string;
  readonly turnId: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly sourceRevision: number;
  readonly targetId: string;
  readonly agentId: string;
  readonly origin: InvocationOrigin;
  readonly profileRevision: number;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly status: "pending" | "claimed" | "cancelled";
  readonly createdAt: string;
  readonly claimedAt?: string;
  readonly cancelledAt?: string;
  readonly cancellationReason?: InvocationCancellationReason;
  readonly supersedesIntentId?: string;
}

export interface AgentExecution {
  readonly executionId: string;
  readonly intentId: string;
  readonly lineageId: string;
  readonly executionOrdinal: number;
  readonly retryOfExecutionId?: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly snapshotId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly status: AgentExecutionStatus;
  readonly phase: AgentExecutionPhase;
  readonly currentAttemptSeq: number;
  readonly version: number;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly cancellationReason?: InvocationCancellationReason;
  readonly terminalErrorCode?: string;
  readonly deadLetteredAt?: string;
  readonly resultMessageId?: string;
  readonly reviewState?: AgentExecutionReviewState;
}

export interface AgentExecutionAttempt {
  readonly executionId: string;
  readonly intentId: string;
  readonly lineageId: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly attemptSeq: number;
  readonly snapshotId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly status: AgentExecutionStatus;
  readonly phase: AgentExecutionPhase;
  readonly executionVersion: number;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
  readonly nextRetryAt?: string;
}

type InvocationCancelCommandBase = Readonly<{
  type: "invocation.cancel";
  requestId: string;
  expectedVersion: number;
  reason?: never;
  agentId?: never;
  origin?: never;
  providerId?: never;
  modelId?: never;
  snapshotId?: never;
  attemptSeq?: never;
}>;

export type InvocationCancelCommand =
  | Readonly<InvocationCancelCommandBase & { executionId: string; intentId?: never }>
  | Readonly<InvocationCancelCommandBase & { intentId: string; executionId?: never }>;

export type InvocationRetryCommand = Readonly<{
  type: "invocation.retry";
  requestId: string;
  executionId: string;
  expectedVersion: number;
  agentId?: never;
  origin?: never;
  providerId?: never;
  modelId?: never;
  snapshotId?: never;
  attemptSeq?: never;
}>;

export interface AgentExecutionRetryReceipt {
  readonly requestId: string;
  readonly sourceExecutionId: string;
  readonly executionId: string;
  readonly intentId: string;
  readonly lineageId: string;
  readonly roomId: string;
  readonly executionOrdinal: number;
  readonly snapshotId: string;
  readonly status: "accepted";
  readonly createdAt: string;
}

export type ScopedCancellationScope =
  | Readonly<{ kind: "intent"; intentId: string; expectedVersion: number }>
  | Readonly<{ kind: "execution"; executionId: string; expectedVersion: number }>
  | Readonly<{ kind: "source_message"; sourceMessageId: string; sourceRevision: number }>
  | Readonly<{ kind: "room"; roomId: string; archiveGeneration: number }>
  | Readonly<{
      kind: "agent_authority";
      agentId: string;
      authority: "membership" | "assignment" | "profile" | "capability";
      authorityRevision: number;
    }>;

export interface ScopedCancellationReceipt {
  readonly requestId: string;
  readonly fenceId: string;
  readonly roomId: string;
  readonly lineageId: string;
  readonly scope: ScopedCancellationScope;
  readonly reason: InvocationCancellationReason;
  readonly intentOutcomes: readonly Readonly<{
    intentId: string;
    outcome: "cancelled" | "already_claimed" | "already_cancelled";
  }>[];
  readonly executionOutcomes: readonly Readonly<{
    executionId: string;
    outcome: "cancelled" | "already_terminal";
    version: number;
  }>[];
  readonly rejectedConfirmationIds: readonly string[];
  readonly revokedGrantIds: readonly string[];
  readonly preservedDispatchIds: readonly string[];
  readonly committedAt: string;
}

export type ProjectBoundaryInvocationRequest = Readonly<{
  purpose: "project_boundary_invocation";
  boundaryId: string;
  boundaryKind: "checkpoint" | "due" | "blocker" | "agent_ball";
  projectId: string;
  roomId: string;
  agentId: string;
  sourceFactId: string;
  sourceFactRevision: number;
}>;

export type ProjectBoundaryInvocationResult =
  | Readonly<{
      boundaryId: string;
      roomId: string;
      status: "intent-created";
      intentId: string;
      consumedAt: string;
    }>
  | Readonly<{
      boundaryId: string;
      roomId: string;
      status: "suppressed";
      reason: "dependency_unavailable" | "boundary_ineligible" | "authority_unavailable";
      decidedAt: string;
    }>
  | Readonly<{
      boundaryId: string;
      roomId: string;
      status: "execution-state";
      intentId: string;
      executionId: string;
      agentId: string;
      executionStatus: "accepted" | "running" | "completed" | "failed" | "cancelled";
      occurredAt: string;
    }>;

/**
 * Provider-visible identity for a Project Loop boundary execution. Unlike the
 * message runtime intent, this deliberately has no sourceMessageId: a timer or
 * Agent-held Project boundary is an independently authoritative source.
 */
export interface ProjectBoundaryProviderInvocation {
  readonly kind: "project_boundary";
  readonly intentId: string;
  readonly executionId: string;
  readonly roomId: string;
  readonly projectId: string;
  readonly boundaryId: string;
  readonly boundaryKind: "checkpoint" | "due" | "blocker" | "agent_ball";
  readonly sourceFactId: string;
  readonly sourceFactRevision: number;
  readonly targetAgentId: string;
  readonly lifecycleGeneration: number;
}

export type LegacyAgentExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface LegacyAgentExecution {
  readonly id: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly requesterId: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly status: LegacyAgentExecutionStatus;
  readonly actionCategory: AgentExecutionActionCategory;
  readonly toolDispatchPhase?: AgentToolDispatchPhase;
  readonly currentAttemptSeq: number;
  readonly retryCycle: number;
  readonly retryOrdinal: 1 | 2 | 3;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly recoveryCursor: number;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly cancellationReason?: string;
  readonly terminalErrorCode?: string;
  readonly deadLetteredAt?: string;
  readonly resultMessageId?: string;
  readonly nextRetryAt?: string;
  readonly manualRetryOfExecutionId?: string;
  readonly compensatesExecutionId?: string;
  readonly supersedesExecutionIds?: readonly string[];
}

export interface LegacyAgentExecutionAttempt {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly retryCycle: number;
  readonly retryOrdinal: 1 | 2 | 3;
  readonly status: LegacyAgentExecutionStatus;
  readonly actionCategory: AgentExecutionActionCategory;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
  readonly nextRetryAt?: string;
  readonly recoveryCursor: number;
}

export interface LegacyHumanPreemptionNotice {
  readonly roomId: string;
  readonly sourceHumanMessageId: string;
  readonly cancelledExecutionIds: readonly string[];
  readonly rerouteStatus: "queued";
  readonly occurredAt: string;
}

/** @deprecated v1-v21 audit reader only; production must not emit broad preemption. */
export type HumanPreemptionNotice = LegacyHumanPreemptionNotice;

export type LegacyAgentInvocationIntentKind = "direct_mention" | "structured_help" | "routed_candidate";

export interface LegacyAgentInvocationIntent {
  readonly kind: LegacyAgentInvocationIntentKind;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly targetAgentId: string;
}

export type ToolEffect = "read-only" | "side-effecting";
export type ToolReversibility = "compensatable" | "irreversible";

export interface ToolDescriptor {
  readonly id: "http-json.read" | "repository.git-status" | "sandbox-file.write" | "room-memory.read";
  readonly displayName: string;
  readonly effect: ToolEffect;
  readonly reversibility: ToolReversibility;
}

export interface ToolConfirmationInput {
  readonly confirmationId: string;
  readonly executionId: string;
}

export interface ProviderNeutralCheckpoint {
  readonly attemptSeq: number;
  readonly stepSeq: number;
  readonly kind: "model" | "tool";
  readonly inputSha256: string;
  readonly outputSha256: string;
}

export interface AgentRuntimeProviderInput {
  readonly purpose: "agent_runtime";
  readonly schemaVersion: "compiled-context-envelope.v1";
  readonly snapshot: Readonly<{
    snapshotId: string;
    generation: number;
    manifestHash: string;
    compilerVersion: string;
    configVersion: string;
    modelId: string;
  }>;
  readonly invocation: AgentInvocationIntent | LegacyAgentInvocationIntent |
    ProjectBoundaryProviderInvocation;
  readonly trusted: Readonly<{
    system: readonly Readonly<{
      kind: "product_policy" | "safety_policy";
      text: string;
    }>[];
    developer: readonly (
      | Readonly<{
          kind: "agent_identity" | "responsibility" | "room_goal" | "trigger_contract" |
            "citation_contract" | "authority_fact";
          data: Readonly<Record<string, unknown>>;
        }>
      | Readonly<{
          kind: "agent_identity" | "responsibility" | "room_goal" | "trigger_contract" |
            "citation_contract" | "authority_fact";
          text: string;
        }>
    )[];
  }>;
  readonly groupContent: readonly Readonly<{
    kind: "trigger" | "human_message" | "agent_message" | "memory" | "raw_delta" |
      "retrieval" | "attachment_extraction" | "omission";
    trust: "untrusted_group_content";
    source: Readonly<{
      label: string;
      kind: "message" | "message_revision" | "message_tombstone" |
        "attachment_extraction" | "memory" | "project_fact_checkpoint";
      revision: number;
    }>;
    content: string;
    memoryKind?: "goal" | "decision" | "context" | "next_action" | "open_question_or_blocker";
    speaker?: Readonly<{ actorId: string; kind: "human" | "agent" }>;
    serverTime?: string;
    replyTo?: Readonly<{ messageId: string; revision: number }>;
    mentions?: readonly Readonly<{
      startUtf16: number;
      endUtf16: number;
      targetKind: "human-request" | "agent-invocation";
      targetActorId: string;
    }>[];
  }>[];
  readonly projectContext:
    | Readonly<{ status: "disabled" | "unavailable"; reason: string }>
    | Readonly<{
        status: "available";
        projectId: string;
        revision: number;
        representation: Readonly<{ kind: "content" | "excerpt" | "segment" | "digest" | "index"; text: string }> | null;
        disposition: "included" | "excerpted" | "segmented" | "digested" | "index_only" |
          "omitted" | "unavailable" | "invalidated";
        citationLabel: string | null;
        sourceRefs: readonly Readonly<{
          roomId: string;
          sourceKind: "message" | "message_revision" | "message_tombstone" |
            "attachment_extraction" | "memory" | "project_fact_checkpoint";
          sourceId: string;
          revision: number;
          corpusSeq: number | null;
        }>[];
      }>;
  readonly availableTools: readonly ToolDescriptor[];
  readonly openItemTargets?: readonly {
    readonly actorId: string;
    readonly kind: "human" | "agent";
  }[];
  readonly committedSteps: readonly ProviderNeutralCheckpoint[];
  readonly toolContinuations?: readonly {
    readonly callId: string;
    readonly toolId: ToolDescriptor["id"] | "open-item.propose";
    readonly argumentsJson: string;
    readonly modelInput: string;
  }[];
  readonly limits: {
    readonly maxInputBytes: number;
    readonly compiledInputTokens: number;
    readonly maxContextInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
  };
}

export interface RouterProviderInput {
  readonly purpose: "route_decision";
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly message: {
    readonly authorId: string;
    readonly authorKind: "human" | "agent";
    readonly summary: string;
  };
  readonly roomPhase: RouteRoomPhase;
  readonly agents: readonly {
    readonly agentId: string;
    readonly participation: "active" | "on-mention";
    readonly role: string;
    readonly capabilities: readonly string[];
    readonly calibrationScore: number;
    readonly hasBall: boolean;
  }[];
  readonly topic: {
    readonly topicKey: string;
    readonly embeddingModelVersion: "dao-topic-embedding-v1";
    readonly windowSize: 8;
    readonly cosineThreshold: 0.82;
  };
  readonly limits: {
    readonly timeoutMs: 1_000;
    readonly maxCandidates: number;
    readonly maxOutputBytes: number;
  };
}

export type RouteRoomPhase = "discussion" | "execution";
export type RouteJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type RouteTriggerCategory = "domain" | "risk" | "structured_mention" | "ball";
export type RouteReasonCode =
  | "direct_mention"
  | "structured_help"
  | "domain_match"
  | "risk_detected"
  | "ball_due"
  | "participation_on_mention"
  | "cooldown"
  | "agent_round_limit"
  | "human_burst_soft_suppression"
  | "execution_phase"
  | "calibration_suppressed"
  | "provider_omitted"
  | "provider_failed"
  | "permission_denied"
  | "not_selected";

export interface RouteJob {
  readonly id: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly status: RouteJobStatus;
  readonly currentAttempt: 1 | 2 | 3;
  readonly topicKey: string;
  readonly embeddingModelVersion: "dao-topic-embedding-v1";
  readonly windowSize: 8;
  readonly cosineThreshold: 0.82;
  readonly roomPhase: RouteRoomPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly terminalErrorCode?: string;
  readonly nextRetryAt?: string;
}

export interface RouterCandidate {
  readonly agentId: string;
  readonly trigger: RouteTriggerCategory;
  readonly order: number;
  readonly reasonCode: "domain_match" | "risk_detected" | "structured_help" | "ball_due";
  readonly reasonText: string;
}

export interface RouterPlan {
  readonly candidates: readonly RouterCandidate[];
}

export interface RouteJudgment {
  readonly id: string;
  readonly routeJobId: string;
  readonly sourceMessageId: string;
  readonly agentId: string;
  readonly outcome: AgentJudgementOutcome;
  readonly reasonCode: RouteReasonCode;
  readonly reasonText: string;
  readonly routeAttempt: 1 | 2 | 3;
  readonly decidedAt: string;
}

export interface RouteInvocationIntent extends LegacyAgentInvocationIntent {
  readonly reasonCode: "direct_mention" | "structured_help" | "domain_match" | "risk_detected" | "ball_due";
  readonly reasonText: string;
  readonly priority: 1 | 2 | 3;
}

export type CanonicalRouteInvocationIntent = AgentInvocationIntent & Readonly<{
  origin: Extract<InvocationOrigin, { readonly kind: "route_decision" }>;
}>;

export interface BallSummary {
  readonly agentId: string;
  readonly sourceKind: BallSourceKind;
  readonly sourceId: string;
  readonly reason: string;
  readonly since: string;
  readonly deadline: string;
}

export type ProviderEvent =
  | { readonly type: "response_started"; readonly sequence: number }
  | { readonly type: "text_delta"; readonly sequence: number; readonly delta: string }
  | { readonly type: "tool_call_started"; readonly sequence: number; readonly callId: string; readonly toolName: string }
  | { readonly type: "tool_call_delta"; readonly sequence: number; readonly callId: string; readonly delta: string }
  | { readonly type: "usage"; readonly sequence: number; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: "agent_final"; readonly sequence: number; readonly body: string; readonly citations: readonly string[] }
  | { readonly type: "completed"; readonly sequence: number };

export interface SocialReaction {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly actorId: string;
  readonly emoji: string;
  readonly createdAt: string;
}

interface CalibrationSignalBase {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly actorId: string;
  readonly agentId: string;
  readonly createdAt: string;
}

export type CalibrationSignal = CalibrationSignalBase & (
  | { readonly emoji: "👍" | "👎" }
  | { readonly feedback: "useful" | "not_needed" }
);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isHumanReadReceipt(value: unknown): value is HumanReadReceipt {
  return isRecord(value) &&
    hasExactKeys(value, ["id", "messageId", "readerId", "readAt"]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.messageId) &&
    isNonEmptyString(value.readerId) &&
    isNonEmptyString(value.readAt);
}

export function isAgentJudgement(value: unknown): value is AgentJudgement {
  return isRecord(value) &&
    hasExactKeys(value, ["id", "messageId", "agentId", "outcome", "reason", "decidedAt"]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.messageId) &&
    isNonEmptyString(value.agentId) &&
    (value.outcome === "will_respond" || value.outcome === "no_response_needed" || value.outcome === "suppressed") &&
    isNonEmptyString(value.reason) &&
    isNonEmptyString(value.decidedAt);
}

const routeReasonCodes = new Set<RouteReasonCode>([
  "direct_mention", "structured_help", "domain_match", "risk_detected", "ball_due",
  "participation_on_mention", "cooldown", "agent_round_limit",
  "human_burst_soft_suppression", "execution_phase", "calibration_suppressed",
  "provider_omitted", "provider_failed", "permission_denied", "not_selected",
]);

export function isRouteJob(value: unknown): value is RouteJob {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "roomId", "sourceMessageId", "status", "currentAttempt", "topicKey",
    "embeddingModelVersion", "windowSize", "cosineThreshold", "roomPhase",
    "createdAt", "updatedAt",
  ], ["completedAt", "terminalErrorCode", "nextRetryAt"])) return false;
  const terminal = value.status === "completed" || value.status === "failed" || value.status === "cancelled";
  return isNonEmptyString(value.id) && isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.sourceMessageId) &&
    (value.status === "queued" || value.status === "running" || terminal) &&
    (value.currentAttempt === 1 || value.currentAttempt === 2 || value.currentAttempt === 3) &&
    isNonEmptyString(value.topicKey) && value.embeddingModelVersion === "dao-topic-embedding-v1" &&
    value.windowSize === 8 && value.cosineThreshold === 0.82 &&
    (value.roomPhase === "discussion" || value.roomPhase === "execution") &&
    isNonEmptyString(value.createdAt) && isNonEmptyString(value.updatedAt) &&
    (!Object.hasOwn(value, "completedAt") || isNonEmptyString(value.completedAt)) &&
    (!Object.hasOwn(value, "terminalErrorCode") || isNonEmptyString(value.terminalErrorCode)) &&
    (!Object.hasOwn(value, "nextRetryAt") || isNonEmptyString(value.nextRetryAt)) &&
    (!terminal || isNonEmptyString(value.completedAt));
}

function isRouterCandidate(value: unknown): value is RouterCandidate {
  return isRecord(value) && hasExactKeys(value, [
    "agentId", "trigger", "order", "reasonCode", "reasonText",
  ]) && isNonEmptyString(value.agentId) &&
    (value.trigger === "domain" || value.trigger === "risk" ||
     value.trigger === "structured_mention" || value.trigger === "ball") &&
    typeof value.order === "number" && Number.isSafeInteger(value.order) && value.order >= 1 &&
    (value.reasonCode === "domain_match" || value.reasonCode === "risk_detected" ||
     value.reasonCode === "structured_help" || value.reasonCode === "ball_due") &&
    isNonEmptyString(value.reasonText);
}

export function isRouterPlan(value: unknown): value is RouterPlan {
  if (!isRecord(value) || !hasExactKeys(value, ["candidates"]) || !Array.isArray(value.candidates) ||
      !value.candidates.every(isRouterCandidate)) return false;
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const candidate of value.candidates) {
    if (ids.has(candidate.agentId) || orders.has(candidate.order)) return false;
    ids.add(candidate.agentId);
    orders.add(candidate.order);
  }
  return value.candidates.every((candidate, index) => candidate.order === index + 1);
}

export function isRouterProviderInput(value: unknown): value is RouterProviderInput {
  if (!isRecord(value) || !hasExactKeys(value, [
    "purpose", "roomId", "sourceMessageId", "message", "roomPhase",
    "agents", "topic", "limits",
  ]) || value.purpose !== "route_decision" || !isNonEmptyString(value.roomId) ||
      !isNonEmptyString(value.sourceMessageId) ||
      (value.roomPhase !== "discussion" && value.roomPhase !== "execution") ||
      !isRecord(value.message) || !hasExactKeys(value.message, ["authorId", "authorKind", "summary"]) ||
      !isNonEmptyString(value.message.authorId) ||
      (value.message.authorKind !== "human" && value.message.authorKind !== "agent") ||
      !isNonEmptyString(value.message.summary) ||
      !Array.isArray(value.agents) || value.agents.length > 256 ||
      !isRecord(value.topic) || !hasExactKeys(value.topic, [
        "topicKey", "embeddingModelVersion", "windowSize", "cosineThreshold",
      ]) || !isNonEmptyString(value.topic.topicKey) ||
      value.topic.embeddingModelVersion !== "dao-topic-embedding-v1" ||
      value.topic.windowSize !== 8 || value.topic.cosineThreshold !== 0.82 ||
      !isRecord(value.limits) || !hasExactKeys(value.limits, [
        "timeoutMs", "maxCandidates", "maxOutputBytes",
      ]) || value.limits.timeoutMs !== 1_000 ||
      typeof value.limits.maxCandidates !== "number" ||
      !Number.isSafeInteger(value.limits.maxCandidates) || value.limits.maxCandidates < 0 ||
      value.limits.maxCandidates > 256 || value.limits.maxOutputBytes !== 64 * 1_024) {
    return false;
  }
  const agentIds = new Set<string>();
  for (const agent of value.agents) {
    if (!isRecord(agent) || !hasExactKeys(agent, [
      "agentId", "participation", "role", "capabilities", "calibrationScore", "hasBall",
    ]) || !isNonEmptyString(agent.agentId) || agentIds.has(agent.agentId) ||
        (agent.participation !== "active" && agent.participation !== "on-mention") ||
        !isNonEmptyString(agent.role) || !Array.isArray(agent.capabilities) ||
        !agent.capabilities.every(isNonEmptyString) ||
        new Set(agent.capabilities).size !== agent.capabilities.length ||
        typeof agent.calibrationScore !== "number" || !Number.isSafeInteger(agent.calibrationScore) ||
        agent.calibrationScore < -4 || agent.calibrationScore > 4 || typeof agent.hasBall !== "boolean") {
      return false;
    }
    agentIds.add(agent.agentId);
  }
  return value.limits.maxCandidates === value.agents.length;
}

export function isRouteJudgment(value: unknown): value is RouteJudgment {
  return isRecord(value) && hasExactKeys(value, [
    "id", "routeJobId", "sourceMessageId", "agentId", "outcome", "reasonCode",
    "reasonText", "routeAttempt", "decidedAt",
  ]) && isNonEmptyString(value.id) && isNonEmptyString(value.routeJobId) &&
    isNonEmptyString(value.sourceMessageId) && isNonEmptyString(value.agentId) &&
    (value.outcome === "will_respond" || value.outcome === "no_response_needed" || value.outcome === "suppressed") &&
    routeReasonCodes.has(value.reasonCode as RouteReasonCode) && isNonEmptyString(value.reasonText) &&
    (value.routeAttempt === 1 || value.routeAttempt === 2 || value.routeAttempt === 3) &&
    isNonEmptyString(value.decidedAt);
}

function isOpenItemTransfer(value: unknown): value is OpenItemTransfer {
  return isRecord(value) &&
    hasExactKeys(value, ["fromId", "toId", "reason", "transferredAt"]) &&
    isNonEmptyString(value.fromId) &&
    isNonEmptyString(value.toId) &&
    isNonEmptyString(value.reason) &&
    isNonEmptyString(value.transferredAt);
}

function isOpenItemOrigin(value: unknown): value is OpenItemOrigin {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) return false;
  if (value.kind === "human_mention" || value.kind === "manual_unfinished") {
    return hasExactKeys(value, ["kind"]);
  }
  return value.kind === "agent_proposal" &&
    hasExactKeys(value, ["kind", "proposalKind", "sourceExecutionId", "reason"]) &&
    (value.proposalKind === "risk" || value.proposalKind === "challenge") &&
    isNonEmptyString(value.sourceExecutionId) && isNonEmptyString(value.reason);
}

export function isOpenItem(value: unknown): value is OpenItem {
  if (!isRecord(value) ||
    hasExactKeys(
      value,
      ["id", "roomId", "sourceMessageId", "requesterId", "currentOwnerId", "content", "status", "origin", "createdAt", "transferChain"],
      ["respondedAt"],
    ) === false ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.roomId) ||
    !isNonEmptyString(value.sourceMessageId) ||
    !isNonEmptyString(value.requesterId) ||
    !(value.currentOwnerId === null || isNonEmptyString(value.currentOwnerId)) ||
    !isNonEmptyString(value.content) ||
    !(value.status === "awaiting" || value.status === "answered" || value.status === "deferred" || value.status === "transferred") ||
    !isOpenItemOrigin(value.origin) ||
    !isNonEmptyString(value.createdAt) ||
    !Array.isArray(value.transferChain) ||
    !value.transferChain.every(isOpenItemTransfer)) {
    return false;
  }
  const terminal = value.status === "answered" || value.status === "deferred";
  if (terminal !== (value.currentOwnerId === null)) return false;
  if (terminal !== Object.hasOwn(value, "respondedAt") ||
      (terminal && !isNonEmptyString(value.respondedAt))) return false;
  if (value.status === "awaiting" && value.transferChain.length !== 0) return false;
  if (value.status === "transferred") {
    const last = value.transferChain.at(-1);
    if (last === undefined || last.toId !== value.currentOwnerId) return false;
  }
  for (let index = 1; index < value.transferChain.length; index += 1) {
    if (value.transferChain[index - 1]!.toId !== value.transferChain[index]!.fromId) return false;
  }
  return true;
}

export function isOpenItemAgentFailure(value: unknown): value is OpenItemAgentFailure {
  return isRecord(value) && hasExactKeys(value, [
    "id", "openItemId", "executionId", "attemptSeq", "reasonCode", "failedAt",
  ]) && isNonEmptyString(value.id) && isNonEmptyString(value.openItemId) &&
    isNonEmptyString(value.executionId) && Number.isSafeInteger(value.attemptSeq) &&
    (value.attemptSeq as number) >= 1 && isNonEmptyString(value.reasonCode) &&
    isNonEmptyString(value.failedAt);
}

function isLightTaskRole(value: unknown): value is LightTaskVerifierRole {
  return value === "owner" || value === "admin" || value === "member";
}

function isLightTaskCriterion(value: unknown): value is LightTaskCriterion {
  return isRecord(value) && hasExactKeys(value, ["id", "text", "met"]) &&
    isNonEmptyString(value.id) && value.id.trim().length > 0 &&
    isNonEmptyString(value.text) && value.text.trim().length > 0 && typeof value.met === "boolean";
}

const ballSourceKinds = new Set<BallSourceKind>([
  "open-item", "light-task", "blueprint-task", "blueprint-awaiting",
  "blueprint-blocked-mention",
]);

function validTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

export function isBallInCourt(value: unknown): value is BallInCourt {
  return isRecord(value) && hasExactKeys(value, [
    "holderId", "roomId", "sourceKind", "sourceId", "reason", "since", "deadline",
  ]) && isNonEmptyString(value.holderId) && isNonEmptyString(value.roomId) &&
    ballSourceKinds.has(value.sourceKind as BallSourceKind) && isNonEmptyString(value.sourceId) &&
    isNonEmptyString(value.reason) && validTimestamp(value.since) && validTimestamp(value.deadline) &&
    Date.parse(value.deadline) >= Date.parse(value.since);
}

export function isNeedsActionProjection(value: unknown): value is NeedsActionProjection {
  return isRecord(value) && hasExactKeys(value, ["roomId", "actorId", "ball", "overdue"]) &&
    isNonEmptyString(value.roomId) && isNonEmptyString(value.actorId) &&
    isBallInCourt(value.ball) && value.ball.roomId === value.roomId &&
    value.ball.holderId === value.actorId && typeof value.overdue === "boolean";
}

export function isReminderCandidate(value: unknown): value is ReminderCandidate {
  return isRecord(value) && hasExactKeys(value, [
    "roomId", "recipientId", "sourceKind", "sourceId", "dueAt",
  ]) && isNonEmptyString(value.roomId) && isNonEmptyString(value.recipientId) &&
    ballSourceKinds.has(value.sourceKind as BallSourceKind) && isNonEmptyString(value.sourceId) &&
    validTimestamp(value.dueAt);
}

export function isBallOverdueTrigger(value: unknown): value is BallOverdueTrigger {
  return isRecord(value) && hasExactKeys(value, [
    "id", "roomId", "agentId", "ball", "triggeredAt",
  ]) && isNonEmptyString(value.id) && isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.agentId) && isBallInCourt(value.ball) &&
    value.ball.roomId === value.roomId && value.ball.holderId === value.agentId &&
    validTimestamp(value.triggeredAt) && Date.parse(value.triggeredAt) >= Date.parse(value.ball.deadline);
}

export function isBlueprintBallFact(value: unknown): value is BlueprintBallFact {
  if (!isRecord(value) || !isNonEmptyString(value.sourceKind)) return false;
  if (value.sourceKind === "blueprint-task" || value.sourceKind === "blueprint-awaiting") {
    return hasExactKeys(value, [
      "sourceKind", "sourceId", "roomId", "assigneeId", "reason", "since",
    ]) && isNonEmptyString(value.sourceId) && isNonEmptyString(value.roomId) &&
      isNonEmptyString(value.assigneeId) && isNonEmptyString(value.reason) && validTimestamp(value.since);
  }
  return value.sourceKind === "blueprint-blocked-mention" && hasExactKeys(value, [
    "sourceKind", "sourceId", "roomId", "mentionedActorId", "reason", "since",
  ]) && isNonEmptyString(value.sourceId) && isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.mentionedActorId) && isNonEmptyString(value.reason) && validTimestamp(value.since);
}

const BLUEPRINT_DEADLINE_MS = 7 * 24 * 60 * 60 * 1_000;

function deadline(since: string, delayMs: number): string {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new TypeError("Ball deadline must be a non-negative safe integer");
  }
  return new Date(Date.parse(since) + delayMs).toISOString();
}

export function projectBallsInCourt(input: BallProjectionInput): readonly BallInCourt[] {
  const balls = new Map<string, BallInCourt>();
  const put = (ball: BallInCourt): void => {
    const key = `${ball.sourceKind}:${ball.sourceId}`;
    const current = balls.get(key);
    if (current === undefined || Date.parse(ball.since) > Date.parse(current.since)) balls.set(key, ball);
  };
  for (const item of input.openItems) {
    if ((item.status !== "awaiting" && item.status !== "transferred") || item.currentOwnerId === null) continue;
    const since = item.status === "transferred"
      ? item.transferChain.at(-1)?.transferredAt ?? item.createdAt
      : item.createdAt;
    put({
      holderId: item.currentOwnerId, roomId: item.roomId, sourceKind: "open-item", sourceId: item.id,
      reason: item.status === "transferred"
        ? "open item transferred to current owner" : "open item awaits current owner",
      since, deadline: deadline(since, input.openItemDeadlineMs),
    });
  }
  for (const task of input.lightTasks) {
    if (task.status === "claimed" && task.claimant !== null && task.claimedAt !== undefined) {
      put({
        holderId: task.claimant, roomId: task.roomId, sourceKind: "light-task", sourceId: task.id,
        reason: "claimed light task awaits delivery", since: task.claimedAt,
        deadline: deadline(task.claimedAt, input.lightTaskDeadlineMs),
      });
    } else if (task.status === "delivered" && task.verifierActorId !== null && task.deliveredAt !== undefined) {
      put({
        holderId: task.verifierActorId, roomId: task.roomId, sourceKind: "light-task", sourceId: task.id,
        reason: "delivered light task awaits persisted verifier", since: task.deliveredAt,
        deadline: deadline(task.deliveredAt, input.lightTaskDeadlineMs),
      });
    }
  }
  for (const fact of input.blueprintFacts) {
    const blocked = fact.sourceKind === "blueprint-blocked-mention";
    put({
      holderId: blocked ? fact.mentionedActorId : fact.assigneeId,
      roomId: fact.roomId,
      sourceKind: fact.sourceKind,
      sourceId: fact.sourceId,
      reason: fact.reason,
      since: fact.since,
      deadline: deadline(fact.since, blocked ? 0 : BLUEPRINT_DEADLINE_MS),
    });
  }
  const order: Readonly<Record<BallSourceKind, number>> = {
    "open-item": 0,
    "light-task": 1,
    "blueprint-task": 2,
    "blueprint-awaiting": 3,
    "blueprint-blocked-mention": 4,
  };
  return [...balls.values()].sort((left, right) =>
    order[left.sourceKind] - order[right.sourceKind] || left.sourceId.localeCompare(right.sourceId));
}

export function isLightTask(value: unknown): value is LightTask {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "roomId", "sourceMessageId", "title", "claimant", "claimantRoleAtClaim",
    "verifierRole", "verifierActorId", "criteria", "status", "createdAt",
  ], ["claimedAt", "deliveredAt", "verifiedAt"]) ||
      !isNonEmptyString(value.id) || !isNonEmptyString(value.roomId) ||
      !isNonEmptyString(value.sourceMessageId) || !isNonEmptyString(value.title) ||
      value.title.trim().length === 0 ||
      !(value.claimant === null || isNonEmptyString(value.claimant)) ||
      !(value.claimantRoleAtClaim === null || isLightTaskRole(value.claimantRoleAtClaim)) ||
      !isLightTaskRole(value.verifierRole) ||
      !(value.verifierActorId === null || isNonEmptyString(value.verifierActorId)) ||
      !Array.isArray(value.criteria) || !value.criteria.every(isLightTaskCriterion) ||
      new Set(value.criteria.map((criterion) => criterion.id)).size !== value.criteria.length ||
      !(value.status === "todo" || value.status === "claimed" ||
        value.status === "delivered" || value.status === "verified") ||
      !isNonEmptyString(value.createdAt)) {
    return false;
  }
  const hasClaim = value.claimant !== null && value.claimantRoleAtClaim !== null &&
    isNonEmptyString(value.claimedAt);
  if (value.status === "todo") {
    return value.claimant === null && value.claimantRoleAtClaim === null &&
      value.verifierActorId === null && !Object.hasOwn(value, "claimedAt") &&
      !Object.hasOwn(value, "deliveredAt") && !Object.hasOwn(value, "verifiedAt");
  }
  if (!hasClaim) return false;
  if (value.status === "claimed") {
    return value.verifierActorId === null && !Object.hasOwn(value, "deliveredAt") &&
      !Object.hasOwn(value, "verifiedAt");
  }
  if (!isNonEmptyString(value.verifierActorId) || value.verifierActorId === value.claimant ||
      value.verifierRole === value.claimantRoleAtClaim || !isNonEmptyString(value.deliveredAt)) {
    return false;
  }
  if (value.status === "delivered") return !Object.hasOwn(value, "verifiedAt");
  return isNonEmptyString(value.verifiedAt) && value.criteria.every((criterion) => criterion.met);
}

export function projectLightTask(value: LightTask): LightTaskProjection {
  return {
    id: value.id,
    roomId: value.roomId,
    sourceMessageId: value.sourceMessageId,
    title: value.title,
    claimant: value.claimant,
    status: value.status,
    criteria: value.criteria,
  };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isInvocationCancellationReason(value: unknown): value is InvocationCancellationReason {
  return value === "human_cancelled" || value === "reply_superseded" ||
    value === "correction_superseded" || value === "intent_superseded" ||
    value === "message_recalled" || value === "room_archived" ||
    value === "membership_revoked" || value === "assignment_revoked" ||
    value === "profile_disabled" || value === "capability_revoked" ||
    value === "source_ineligible" || value === "runtime_shutdown";
}

function isInvocationOrigin(value: unknown, targetId: string): value is InvocationOrigin {
  if (!isRecord(value)) return false;
  if (value.kind === "message_target") {
    return hasExactKeys(value, ["kind", "messageTransactionId", "targetId"]) &&
      isNonEmptyString(value.messageTransactionId) && value.targetId === targetId;
  }
  if (value.kind === "route_decision") {
    return hasExactKeys(value, ["kind", "routeJobId", "judgmentId"]) &&
      isNonEmptyString(value.routeJobId) && isNonEmptyString(value.judgmentId);
  }
  return value.kind === "project_boundary" &&
    hasExactKeys(value, ["kind", "boundaryId", "boundaryKind"]) &&
    isNonEmptyString(value.boundaryId) &&
    (value.boundaryKind === "checkpoint" || value.boundaryKind === "due" ||
      value.boundaryKind === "blocker" || value.boundaryKind === "agent_ball");
}

export function isAgentInvocationIntent(value: unknown): value is AgentInvocationIntent {
  if (!isRecord(value) || !hasExactKeys(value, [
    "intentId", "lineageId", "turnId", "roomId", "sourceMessageId", "sourceRevision",
    "targetId", "agentId", "origin", "profileRevision", "assignmentRevision",
    "accessRevision", "status", "createdAt",
  ], ["claimedAt", "cancelledAt", "cancellationReason", "supersedesIntentId"]) ||
      !isNonEmptyString(value.intentId) || !isNonEmptyString(value.lineageId) ||
      !isNonEmptyString(value.turnId) || !isNonEmptyString(value.roomId) ||
      !isNonEmptyString(value.sourceMessageId) || !isPositiveSafeInteger(value.sourceRevision) ||
      !isNonEmptyString(value.targetId) || !isNonEmptyString(value.agentId) ||
      !isInvocationOrigin(value.origin, value.targetId) ||
      !isPositiveSafeInteger(value.profileRevision) ||
      !isPositiveSafeInteger(value.assignmentRevision) ||
      !isPositiveSafeInteger(value.accessRevision) || !isNonEmptyString(value.createdAt) ||
      (Object.hasOwn(value, "supersedesIntentId") &&
        (!isNonEmptyString(value.supersedesIntentId) || value.supersedesIntentId === value.intentId))) {
    return false;
  }
  if (value.status === "pending") {
    return !Object.hasOwn(value, "claimedAt") && !Object.hasOwn(value, "cancelledAt") &&
      !Object.hasOwn(value, "cancellationReason");
  }
  if (value.status === "claimed") {
    return isNonEmptyString(value.claimedAt) && !Object.hasOwn(value, "cancelledAt") &&
      !Object.hasOwn(value, "cancellationReason");
  }
  return value.status === "cancelled" && isNonEmptyString(value.cancelledAt) &&
    isInvocationCancellationReason(value.cancellationReason) && !Object.hasOwn(value, "claimedAt");
}

function isAcceptedPhase(value: unknown): value is AgentExecutionAcceptedPhase {
  return value === "queued" || value === "retry_scheduled" || value === "recovery_queued" ||
    value === "awaiting_capacity";
}

function isRunningPhase(value: unknown): value is AgentExecutionRunningPhase {
  return value === "claiming" || value === "snapshot_frozen" || value === "model_generation" ||
    value === "read_tool" || value === "waiting_confirmation" ||
    value === "side_effect_claimed" || value === "final_committing";
}

function executionStatusMatchesPhase(status: unknown, phase: unknown): status is AgentExecutionStatus {
  return (status === "accepted" && isAcceptedPhase(phase)) ||
    (status === "running" && isRunningPhase(phase)) || status === phase &&
      (status === "completed" || status === "failed" || status === "cancelled");
}

export function isAgentExecution(value: unknown): value is AgentExecution {
  if (!isRecord(value) || !hasExactKeys(value, [
    "executionId", "intentId", "lineageId", "executionOrdinal", "roomId", "agentId",
    "snapshotId", "providerId", "modelId", "status", "phase", "currentAttemptSeq",
    "version", "queuedAt", "updatedAt",
  ], [
    "retryOfExecutionId", "startedAt", "completedAt", "cancellationReason",
    "terminalErrorCode", "deadLetteredAt", "resultMessageId", "reviewState",
  ]) || !isNonEmptyString(value.executionId) || !isNonEmptyString(value.intentId) ||
      !isNonEmptyString(value.lineageId) || !isPositiveSafeInteger(value.executionOrdinal) ||
      !isNonEmptyString(value.roomId) || !isNonEmptyString(value.agentId) ||
      !isNonEmptyString(value.snapshotId) || !isNonEmptyString(value.providerId) ||
      !isNonEmptyString(value.modelId) || !executionStatusMatchesPhase(value.status, value.phase) ||
      !isPositiveSafeInteger(value.currentAttemptSeq) || !isPositiveSafeInteger(value.version) ||
      !isNonEmptyString(value.queuedAt) || !isNonEmptyString(value.updatedAt) ||
      (Object.hasOwn(value, "retryOfExecutionId") &&
        (!isNonEmptyString(value.retryOfExecutionId) || value.retryOfExecutionId === value.executionId)) ||
      (value.executionOrdinal === 1 && Object.hasOwn(value, "retryOfExecutionId")) ||
      (value.executionOrdinal > 1 && !isNonEmptyString(value.retryOfExecutionId))) {
    return false;
  }
  const terminal = value.status === "completed" || value.status === "failed" || value.status === "cancelled";
  if (value.status === "accepted") {
    if (Object.hasOwn(value, "startedAt")) return false;
  } else if (!isNonEmptyString(value.startedAt)) {
    return false;
  }
  if (terminal !== isNonEmptyString(value.completedAt)) return false;
  if ((value.status === "cancelled") !== isInvocationCancellationReason(value.cancellationReason)) return false;
  if ((value.status === "failed") !== isNonEmptyString(value.terminalErrorCode)) return false;
  if (Object.hasOwn(value, "deadLetteredAt") &&
      (value.status !== "failed" || !isNonEmptyString(value.deadLetteredAt))) return false;
  if (Object.hasOwn(value, "resultMessageId") &&
      (value.status !== "completed" || !isNonEmptyString(value.resultMessageId))) return false;
  if (Object.hasOwn(value, "reviewState")) {
    if (value.status !== "failed" ||
        (value.reviewState !== "not_required" && value.reviewState !== "needs_review" &&
          value.reviewState !== "reviewed")) return false;
  }
  return true;
}

export function isAgentExecutionAttempt(value: unknown): value is AgentExecutionAttempt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "executionId", "intentId", "lineageId", "roomId", "agentId", "attemptSeq", "snapshotId", "providerId",
    "modelId", "status", "phase", "executionVersion", "updatedAt",
  ], ["startedAt", "finishedAt", "errorCode", "nextRetryAt"]) ||
      !isNonEmptyString(value.executionId) || !isNonEmptyString(value.intentId) ||
      !isNonEmptyString(value.lineageId) || !isNonEmptyString(value.roomId) ||
      !isNonEmptyString(value.agentId) || !isPositiveSafeInteger(value.attemptSeq) ||
      !isNonEmptyString(value.snapshotId) || !isNonEmptyString(value.providerId) ||
      !isNonEmptyString(value.modelId) || !executionStatusMatchesPhase(value.status, value.phase) ||
      !isPositiveSafeInteger(value.executionVersion) || !isNonEmptyString(value.updatedAt)) return false;
  const terminal = value.status === "completed" || value.status === "failed" || value.status === "cancelled";
  if (value.status === "accepted") {
    if (Object.hasOwn(value, "startedAt")) return false;
  } else if (!isNonEmptyString(value.startedAt)) return false;
  if (terminal !== isNonEmptyString(value.finishedAt)) return false;
  if (Object.hasOwn(value, "errorCode") &&
      (value.status !== "failed" || !isNonEmptyString(value.errorCode))) return false;
  return !Object.hasOwn(value, "nextRetryAt") ||
    (value.status === "failed" && isNonEmptyString(value.nextRetryAt));
}

export function isInvocationCancelCommand(value: unknown): value is InvocationCancelCommand {
  if (!isRecord(value) || value.type !== "invocation.cancel" ||
      !isNonEmptyString(value.requestId) || !isPositiveSafeInteger(value.expectedVersion)) return false;
  const executionTarget = hasExactKeys(value, [
    "type", "requestId", "executionId", "expectedVersion",
  ]) && isNonEmptyString(value.executionId);
  const intentTarget = hasExactKeys(value, [
    "type", "requestId", "intentId", "expectedVersion",
  ]) && isNonEmptyString(value.intentId);
  return executionTarget !== intentTarget;
}

export function isInvocationRetryCommand(value: unknown): value is InvocationRetryCommand {
  return isRecord(value) && hasExactKeys(value, ["type", "requestId", "executionId", "expectedVersion"]) &&
    value.type === "invocation.retry" && isNonEmptyString(value.requestId) &&
    isNonEmptyString(value.executionId) && isPositiveSafeInteger(value.expectedVersion);
}

export function isAgentExecutionRetryReceipt(value: unknown): value is AgentExecutionRetryReceipt {
  return isRecord(value) && hasExactKeys(value, [
    "requestId", "sourceExecutionId", "executionId", "intentId", "lineageId", "roomId",
    "executionOrdinal", "snapshotId", "status", "createdAt",
  ]) && isNonEmptyString(value.requestId) && isNonEmptyString(value.sourceExecutionId) &&
    isNonEmptyString(value.executionId) && value.executionId !== value.sourceExecutionId &&
    isNonEmptyString(value.intentId) && isNonEmptyString(value.lineageId) && isNonEmptyString(value.roomId) &&
    isPositiveSafeInteger(value.executionOrdinal) && value.executionOrdinal >= 2 &&
    isNonEmptyString(value.snapshotId) && value.status === "accepted" &&
    isNonEmptyString(value.createdAt);
}

function isScopedCancellationScope(value: unknown): value is ScopedCancellationScope {
  if (!isRecord(value)) return false;
  if (value.kind === "intent") {
    return hasExactKeys(value, ["kind", "intentId", "expectedVersion"]) &&
      isNonEmptyString(value.intentId) && isPositiveSafeInteger(value.expectedVersion);
  }
  if (value.kind === "execution") {
    return hasExactKeys(value, ["kind", "executionId", "expectedVersion"]) &&
      isNonEmptyString(value.executionId) && isPositiveSafeInteger(value.expectedVersion);
  }
  if (value.kind === "source_message") {
    return hasExactKeys(value, ["kind", "sourceMessageId", "sourceRevision"]) &&
      isNonEmptyString(value.sourceMessageId) && isPositiveSafeInteger(value.sourceRevision);
  }
  if (value.kind === "room") {
    return hasExactKeys(value, ["kind", "roomId", "archiveGeneration"]) &&
      isNonEmptyString(value.roomId) && isPositiveSafeInteger(value.archiveGeneration);
  }
  return value.kind === "agent_authority" && hasExactKeys(value, [
    "kind", "agentId", "authority", "authorityRevision",
  ]) && isNonEmptyString(value.agentId) &&
    (value.authority === "membership" || value.authority === "assignment" ||
      value.authority === "profile" || value.authority === "capability") &&
    isPositiveSafeInteger(value.authorityRevision);
}

function isUniqueIdentifiers(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 256 && value.every(isNonEmptyString) &&
    new Set(value).size === value.length;
}

export function isScopedCancellationReceipt(value: unknown): value is ScopedCancellationReceipt {
  if (!isRecord(value) || !hasExactKeys(value, [
    "requestId", "fenceId", "roomId", "lineageId", "scope", "reason", "intentOutcomes",
    "executionOutcomes", "rejectedConfirmationIds", "revokedGrantIds", "preservedDispatchIds",
    "committedAt",
  ]) || !isNonEmptyString(value.requestId) || !isNonEmptyString(value.fenceId) ||
      !isNonEmptyString(value.roomId) || !isNonEmptyString(value.lineageId) ||
      !isScopedCancellationScope(value.scope) || !isInvocationCancellationReason(value.reason) ||
      !Array.isArray(value.intentOutcomes) || !Array.isArray(value.executionOutcomes) ||
      value.intentOutcomes.length > 256 || value.executionOutcomes.length > 256 ||
      !isUniqueIdentifiers(value.rejectedConfirmationIds) ||
      !isUniqueIdentifiers(value.revokedGrantIds) || !isUniqueIdentifiers(value.preservedDispatchIds) ||
      !isNonEmptyString(value.committedAt)) return false;
  if (value.scope.kind === "room" &&
      (value.scope.roomId !== value.roomId || value.reason !== "room_archived")) return false;
  if (value.scope.kind === "source_message" && value.reason !== "message_recalled") return false;
  if (value.scope.kind === "agent_authority") {
    const reasonByAuthority = {
      membership: "membership_revoked",
      assignment: "assignment_revoked",
      profile: "profile_disabled",
      capability: "capability_revoked",
    } as const;
    if (value.reason !== reasonByAuthority[value.scope.authority]) return false;
  }
  const intentIds = new Set<string>();
  for (const outcome of value.intentOutcomes) {
    if (!isRecord(outcome) || !hasExactKeys(outcome, ["intentId", "outcome"]) ||
        !isNonEmptyString(outcome.intentId) || intentIds.has(outcome.intentId) ||
        (outcome.outcome !== "cancelled" && outcome.outcome !== "already_claimed" &&
          outcome.outcome !== "already_cancelled")) return false;
    intentIds.add(outcome.intentId);
  }
  const executionIds = new Set<string>();
  for (const outcome of value.executionOutcomes) {
    if (!isRecord(outcome) || !hasExactKeys(outcome, ["executionId", "outcome", "version"]) ||
        !isNonEmptyString(outcome.executionId) || executionIds.has(outcome.executionId) ||
        (outcome.outcome !== "cancelled" && outcome.outcome !== "already_terminal") ||
        !isPositiveSafeInteger(outcome.version)) return false;
    executionIds.add(outcome.executionId);
  }
  return (value.scope.kind !== "intent" || intentIds.has(value.scope.intentId)) &&
    (value.scope.kind !== "execution" || executionIds.has(value.scope.executionId));
}

export function isProjectBoundaryInvocationResult(value: unknown): value is ProjectBoundaryInvocationResult {
  if (!isRecord(value) || !isNonEmptyString(value.boundaryId) || !isNonEmptyString(value.roomId)) return false;
  if (value.status === "intent-created") {
    return hasExactKeys(value, ["boundaryId", "roomId", "status", "intentId", "consumedAt"]) &&
      isNonEmptyString(value.intentId) && isNonEmptyString(value.consumedAt);
  }
  if (value.status === "execution-state") {
    return hasExactKeys(value, ["boundaryId", "roomId", "status", "intentId", "executionId",
      "agentId", "executionStatus", "occurredAt"]) && isNonEmptyString(value.intentId) &&
      isNonEmptyString(value.executionId) && isNonEmptyString(value.agentId) &&
      (value.executionStatus === "accepted" || value.executionStatus === "running" ||
        value.executionStatus === "completed" || value.executionStatus === "failed" ||
        value.executionStatus === "cancelled") && isNonEmptyString(value.occurredAt);
  }
  return value.status === "suppressed" &&
    hasExactKeys(value, ["boundaryId", "roomId", "status", "reason", "decidedAt"]) &&
    (value.reason === "dependency_unavailable" || value.reason === "boundary_ineligible" ||
      value.reason === "authority_unavailable") && isNonEmptyString(value.decidedAt);
}

export function isProjectBoundaryInvocationRequest(value: unknown): value is ProjectBoundaryInvocationRequest {
  return isRecord(value) && hasExactKeys(value, [
    "purpose", "boundaryId", "boundaryKind", "projectId", "roomId", "agentId",
    "sourceFactId", "sourceFactRevision",
  ]) && value.purpose === "project_boundary_invocation" && isNonEmptyString(value.boundaryId) &&
    (value.boundaryKind === "checkpoint" || value.boundaryKind === "due" ||
      value.boundaryKind === "blocker" || value.boundaryKind === "agent_ball") &&
    isNonEmptyString(value.projectId) && isNonEmptyString(value.roomId) && value.projectId === value.roomId &&
    isNonEmptyString(value.agentId) && isNonEmptyString(value.sourceFactId) &&
    isPositiveSafeInteger(value.sourceFactRevision);
}

export function isLegacyAgentInvocationIntent(value: unknown): value is LegacyAgentInvocationIntent {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "roomId", "sourceMessageId", "targetAgentId",
  ]) && (value.kind === "direct_mention" || value.kind === "structured_help" ||
    value.kind === "routed_candidate") && isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.sourceMessageId) && isNonEmptyString(value.targetAgentId);
}

export function isLegacyAgentExecution(value: unknown): value is LegacyAgentExecution {
  if (!isRecord(value) || !hasExactKeys(
    value,
    [
      "id", "roomId", "sourceMessageId", "requesterId", "agentId", "toolName", "status",
      "actionCategory", "currentAttemptSeq", "retryCycle", "retryOrdinal", "recoveryCursor",
      "queuedAt", "updatedAt",
    ],
    [
      "toolDispatchPhase", "providerId", "modelId", "startedAt", "completedAt",
      "cancellationReason", "terminalErrorCode", "deadLetteredAt", "resultMessageId",
      "nextRetryAt", "manualRetryOfExecutionId", "compensatesExecutionId",
      "supersedesExecutionIds",
    ],
  )) {
    return false;
  }
  const status = value.status;
  const actionCategory = value.actionCategory;
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.sourceMessageId) &&
    isNonEmptyString(value.requesterId) &&
    isNonEmptyString(value.agentId) &&
    isNonEmptyString(value.toolName) &&
    (status === "queued" || status === "running" || terminal) &&
    (actionCategory === "model_generation" || actionCategory === "tool_call" || actionCategory === "waiting_upstream") &&
    (actionCategory === "tool_call"
      ? value.toolDispatchPhase === "not_started" || value.toolDispatchPhase === "dispatched" || value.toolDispatchPhase === "finished"
      : !Object.hasOwn(value, "toolDispatchPhase")) &&
    Number.isSafeInteger(value.currentAttemptSeq) && (value.currentAttemptSeq as number) >= 1 &&
    Number.isSafeInteger(value.retryCycle) && (value.retryCycle as number) >= 1 &&
    (value.retryOrdinal === 1 || value.retryOrdinal === 2 || value.retryOrdinal === 3) &&
    Number.isSafeInteger(value.recoveryCursor) && (value.recoveryCursor as number) >= 0 &&
    isNonEmptyString(value.queuedAt) && isNonEmptyString(value.updatedAt) &&
    (!Object.hasOwn(value, "providerId") || isNonEmptyString(value.providerId)) &&
    (!Object.hasOwn(value, "modelId") || isNonEmptyString(value.modelId)) &&
    (!Object.hasOwn(value, "startedAt") || isNonEmptyString(value.startedAt)) &&
    (terminal ? isNonEmptyString(value.completedAt) : !Object.hasOwn(value, "completedAt")) &&
    (status === "cancelled" ? isNonEmptyString(value.cancellationReason) : !Object.hasOwn(value, "cancellationReason")) &&
    (status === "failed" ? isNonEmptyString(value.terminalErrorCode) : !Object.hasOwn(value, "terminalErrorCode")) &&
    (!Object.hasOwn(value, "deadLetteredAt") || (status === "failed" && isNonEmptyString(value.deadLetteredAt))) &&
    (!Object.hasOwn(value, "resultMessageId") || (status === "completed" && isNonEmptyString(value.resultMessageId))) &&
    (!Object.hasOwn(value, "nextRetryAt") || (status === "queued" && isNonEmptyString(value.nextRetryAt))) &&
    (!Object.hasOwn(value, "manualRetryOfExecutionId") || isNonEmptyString(value.manualRetryOfExecutionId)) &&
    (!Object.hasOwn(value, "compensatesExecutionId") || isNonEmptyString(value.compensatesExecutionId)) &&
    (!Object.hasOwn(value, "supersedesExecutionIds") || (
      Array.isArray(value.supersedesExecutionIds) && value.supersedesExecutionIds.length > 0 &&
      value.supersedesExecutionIds.length <= 32 &&
      value.supersedesExecutionIds.every(isNonEmptyString) &&
      new Set(value.supersedesExecutionIds).size === value.supersedesExecutionIds.length &&
      !value.supersedesExecutionIds.includes(value.id as string)
    ))
  );
}

export function isLegacyHumanPreemptionNotice(value: unknown): value is LegacyHumanPreemptionNotice {
  return isRecord(value) && hasExactKeys(value, [
    "roomId", "sourceHumanMessageId", "cancelledExecutionIds", "rerouteStatus", "occurredAt",
  ]) && isNonEmptyString(value.roomId) && isNonEmptyString(value.sourceHumanMessageId) &&
    Array.isArray(value.cancelledExecutionIds) && value.cancelledExecutionIds.length <= 33 &&
    value.cancelledExecutionIds.every(isNonEmptyString) &&
    new Set(value.cancelledExecutionIds).size === value.cancelledExecutionIds.length &&
    value.rerouteStatus === "queued" && isNonEmptyString(value.occurredAt);
}

/** @deprecated v1-v21 audit reader only; production must not emit broad preemption. */
export const isHumanPreemptionNotice = isLegacyHumanPreemptionNotice;

export function isSocialReaction(value: unknown): value is SocialReaction {
  return isRecord(value) &&
    hasExactKeys(value, ["id", "sourceMessageId", "actorId", "emoji", "createdAt"]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.sourceMessageId) &&
    isNonEmptyString(value.actorId) &&
    isNonEmptyString(value.emoji) &&
    isNonEmptyString(value.createdAt);
}

export function isCalibrationSignal(value: unknown): value is CalibrationSignal {
  if (!isRecord(value)) return false;
  const emoji = hasExactKeys(value, ["id", "sourceMessageId", "actorId", "agentId", "emoji", "createdAt"]) &&
    (value.emoji === "👍" || value.emoji === "👎");
  const feedback = hasExactKeys(value, ["id", "sourceMessageId", "actorId", "agentId", "feedback", "createdAt"]) &&
    (value.feedback === "useful" || value.feedback === "not_needed");
  return (emoji || feedback) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.sourceMessageId) &&
    isNonEmptyString(value.actorId) &&
    isNonEmptyString(value.agentId) &&
    isNonEmptyString(value.createdAt);
}
