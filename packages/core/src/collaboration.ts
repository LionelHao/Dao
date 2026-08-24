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

export type AgentExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AgentExecutionActionCategory = "model_generation" | "tool_call" | "waiting_upstream";
export type AgentToolDispatchPhase = "not_started" | "dispatched" | "finished";

export interface AgentExecution {
  readonly id: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly requesterId: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly status: AgentExecutionStatus;
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

export interface HumanPreemptionNotice {
  readonly roomId: string;
  readonly sourceHumanMessageId: string;
  readonly cancelledExecutionIds: readonly string[];
  readonly rerouteStatus: "queued";
  readonly occurredAt: string;
}

export interface AgentExecutionAttempt {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly retryCycle: number;
  readonly retryOrdinal: 1 | 2 | 3;
  readonly status: AgentExecutionStatus;
  readonly actionCategory: AgentExecutionActionCategory;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
  readonly nextRetryAt?: string;
  readonly recoveryCursor: number;
}

export type AgentInvocationIntentKind = "direct_mention" | "structured_help" | "routed_candidate";

export interface AgentInvocationIntent {
  readonly kind: AgentInvocationIntentKind;
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
  readonly invocation: AgentInvocationIntent;
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

export interface RouteInvocationIntent extends AgentInvocationIntent {
  readonly reasonCode: "direct_mention" | "structured_help" | "domain_match" | "risk_detected" | "ball_due";
  readonly reasonText: string;
  readonly priority: 1 | 2 | 3;
}

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

export function isAgentExecution(value: unknown): value is AgentExecution {
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

export function isHumanPreemptionNotice(value: unknown): value is HumanPreemptionNotice {
  return isRecord(value) && hasExactKeys(value, [
    "roomId", "sourceHumanMessageId", "cancelledExecutionIds", "rerouteStatus", "occurredAt",
  ]) && isNonEmptyString(value.roomId) && isNonEmptyString(value.sourceHumanMessageId) &&
    Array.isArray(value.cancelledExecutionIds) && value.cancelledExecutionIds.length <= 33 &&
    value.cancelledExecutionIds.every(isNonEmptyString) &&
    new Set(value.cancelledExecutionIds).size === value.cancelledExecutionIds.length &&
    value.rerouteStatus === "queued" && isNonEmptyString(value.occurredAt);
}

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
