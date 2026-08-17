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

export type OpenItemStatus = "pending_response" | "responded" | "deferred" | "transferred";

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
  readonly ownerId: string;
  readonly content: string;
  readonly status: OpenItemStatus;
  readonly createdAt: string;
  readonly respondedAt?: string;
  readonly transferChain: readonly OpenItemTransfer[];
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
  readonly id: "http-json.read" | "repository.git-status" | "sandbox-file.write";
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
  readonly invocation: AgentInvocationIntent;
  readonly visibleConversation: readonly {
    readonly messageId: string;
    readonly authorId: string;
    readonly body: string;
  }[];
  readonly availableTools: readonly ToolDescriptor[];
  readonly committedSteps: readonly ProviderNeutralCheckpoint[];
  readonly toolContinuations?: readonly {
    readonly callId: string;
    readonly toolId: ToolDescriptor["id"];
    readonly argumentsJson: string;
    readonly modelInput: string;
  }[];
  readonly limits: {
    readonly maxInputBytes: number;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
  };
}

export interface RouterProviderInput {
  readonly purpose: "route_decision";
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly messageSummary: string;
  readonly candidateAgentIds: readonly string[];
}

export type ProviderEvent =
  | { readonly type: "response_started"; readonly sequence: number }
  | { readonly type: "text_delta"; readonly sequence: number; readonly delta: string }
  | { readonly type: "tool_call_started"; readonly sequence: number; readonly callId: string; readonly toolName: string }
  | { readonly type: "tool_call_delta"; readonly sequence: number; readonly callId: string; readonly delta: string }
  | { readonly type: "usage"; readonly sequence: number; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: "completed"; readonly sequence: number };

export interface SocialReaction {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly actorId: string;
  readonly emoji: string;
  readonly createdAt: string;
}

export interface CalibrationSignal {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly actorId: string;
  readonly agentId: string;
  readonly emoji: "👍" | "👎";
  readonly createdAt: string;
}

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

function isOpenItemTransfer(value: unknown): value is OpenItemTransfer {
  return isRecord(value) &&
    hasExactKeys(value, ["fromId", "toId", "reason", "transferredAt"]) &&
    isNonEmptyString(value.fromId) &&
    isNonEmptyString(value.toId) &&
    isNonEmptyString(value.reason) &&
    isNonEmptyString(value.transferredAt);
}

export function isOpenItem(value: unknown): value is OpenItem {
  return isRecord(value) &&
    hasExactKeys(
      value,
      ["id", "roomId", "sourceMessageId", "requesterId", "ownerId", "content", "status", "createdAt", "transferChain"],
      ["respondedAt"],
    ) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.sourceMessageId) &&
    isNonEmptyString(value.requesterId) &&
    isNonEmptyString(value.ownerId) &&
    isNonEmptyString(value.content) &&
    (value.status === "pending_response" || value.status === "responded" || value.status === "deferred" || value.status === "transferred") &&
    isNonEmptyString(value.createdAt) &&
    (!Object.hasOwn(value, "respondedAt") || isNonEmptyString(value.respondedAt)) &&
    Array.isArray(value.transferChain) &&
    value.transferChain.every(isOpenItemTransfer);
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
    (!Object.hasOwn(value, "compensatesExecutionId") || isNonEmptyString(value.compensatesExecutionId))
  );
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
  return isRecord(value) &&
    hasExactKeys(value, ["id", "sourceMessageId", "actorId", "agentId", "emoji", "createdAt"]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.sourceMessageId) &&
    isNonEmptyString(value.actorId) &&
    isNonEmptyString(value.agentId) &&
    (value.emoji === "👍" || value.emoji === "👎") &&
    isNonEmptyString(value.createdAt);
}
