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
  readonly status: AgentExecutionStatus;
  readonly actionCategory: AgentExecutionActionCategory;
  readonly toolDispatchPhase?: AgentToolDispatchPhase;
  readonly currentToolId?: string;
  readonly currentAttemptSeq: number;
  readonly retryCycle: number;
  readonly retryOrdinal: 1 | 2 | 3;
  readonly providerId: string;
  readonly modelId: string;
  readonly recoveryCursor: number;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly cancellationReason?: string;
  readonly terminalErrorCode?: string;
  readonly deadLetteredAt?: string;
  readonly resultMessageId?: string;
  readonly manualRetryOfExecutionId?: string;
  readonly compensatesExecutionId?: string;
  readonly supersedesExecutionIds?: readonly string[];
}

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

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
      "id", "roomId", "sourceMessageId", "requesterId", "agentId", "status", "actionCategory",
      "currentAttemptSeq", "retryCycle", "retryOrdinal", "providerId", "modelId", "recoveryCursor",
      "queuedAt", "updatedAt",
    ],
    [
      "toolDispatchPhase", "currentToolId", "startedAt", "finishedAt", "cancellationReason",
      "terminalErrorCode", "deadLetteredAt", "resultMessageId", "manualRetryOfExecutionId",
      "compensatesExecutionId", "supersedesExecutionIds",
    ],
  )) {
    return false;
  }

  const isTerminal = value.status === "completed" || value.status === "failed" || value.status === "cancelled";
  const hasOptionalString = (key: string): boolean =>
    !Object.hasOwn(value, key) || isNonEmptyString(value[key]);
  const hasExecutionIdList = !Object.hasOwn(value, "supersedesExecutionIds") ||
    (Array.isArray(value.supersedesExecutionIds) &&
      value.supersedesExecutionIds.length > 0 &&
      value.supersedesExecutionIds.every(isNonEmptyString) &&
      new Set(value.supersedesExecutionIds).size === value.supersedesExecutionIds.length);
  const hasToolDispatch = Object.hasOwn(value, "toolDispatchPhase");
  const hasCurrentTool = Object.hasOwn(value, "currentToolId");

  return isNonEmptyString(value.id) &&
    isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.sourceMessageId) &&
    isNonEmptyString(value.requesterId) &&
    isNonEmptyString(value.agentId) &&
    (value.status === "queued" || value.status === "running" || value.status === "completed" || value.status === "failed" || value.status === "cancelled") &&
    (value.actionCategory === "model_generation" || value.actionCategory === "tool_call" || value.actionCategory === "waiting_upstream") &&
    isPositiveSafeInteger(value.currentAttemptSeq) &&
    isPositiveSafeInteger(value.retryCycle) &&
    (value.retryOrdinal === 1 || value.retryOrdinal === 2 || value.retryOrdinal === 3) &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.modelId) &&
    isNonNegativeSafeInteger(value.recoveryCursor) &&
    isCanonicalIsoTimestamp(value.queuedAt) &&
    isCanonicalIsoTimestamp(value.updatedAt) &&
    (!Object.hasOwn(value, "startedAt") || isCanonicalIsoTimestamp(value.startedAt)) &&
    (!Object.hasOwn(value, "finishedAt") || isCanonicalIsoTimestamp(value.finishedAt)) &&
    hasOptionalString("cancellationReason") &&
    hasOptionalString("terminalErrorCode") &&
    (!Object.hasOwn(value, "deadLetteredAt") || isCanonicalIsoTimestamp(value.deadLetteredAt)) &&
    hasOptionalString("resultMessageId") &&
    hasOptionalString("manualRetryOfExecutionId") &&
    hasOptionalString("compensatesExecutionId") &&
    hasExecutionIdList &&
    (value.actionCategory === "tool_call"
      ? hasToolDispatch === hasCurrentTool &&
        (!hasToolDispatch ||
          ((value.toolDispatchPhase === "not_started" || value.toolDispatchPhase === "dispatched" || value.toolDispatchPhase === "finished") &&
            isNonEmptyString(value.currentToolId)))
      : !hasToolDispatch && !hasCurrentTool) &&
    (isTerminal ? Object.hasOwn(value, "finishedAt") : !Object.hasOwn(value, "finishedAt")) &&
    (value.status === "queued" ? !Object.hasOwn(value, "startedAt") : true) &&
    (value.status === "running" || value.status === "completed" || value.status === "failed" ? Object.hasOwn(value, "startedAt") : true) &&
    (value.status === "completed" ? !Object.hasOwn(value, "cancellationReason") &&
      !Object.hasOwn(value, "terminalErrorCode") && !Object.hasOwn(value, "deadLetteredAt") : true) &&
    (value.status === "cancelled" ? Object.hasOwn(value, "cancellationReason") &&
      !Object.hasOwn(value, "resultMessageId") && !Object.hasOwn(value, "terminalErrorCode") &&
      !Object.hasOwn(value, "deadLetteredAt") : true) &&
    (value.status === "failed" ? Object.hasOwn(value, "terminalErrorCode") &&
      !Object.hasOwn(value, "resultMessageId") && !Object.hasOwn(value, "cancellationReason") : true) &&
    (value.status === "queued" || value.status === "running" ?
      !Object.hasOwn(value, "resultMessageId") && !Object.hasOwn(value, "cancellationReason") &&
      !Object.hasOwn(value, "terminalErrorCode") && !Object.hasOwn(value, "deadLetteredAt") : true) &&
    Date.parse(value.queuedAt as string) <= Date.parse(value.updatedAt as string) &&
    (!Object.hasOwn(value, "startedAt") || Date.parse(value.queuedAt as string) <= Date.parse(value.startedAt as string) &&
      Date.parse(value.startedAt as string) <= Date.parse(value.updatedAt as string)) &&
    (!Object.hasOwn(value, "finishedAt") ||
      Date.parse(value.queuedAt as string) <= Date.parse(value.finishedAt as string) &&
      (!Object.hasOwn(value, "startedAt") || Date.parse(value.startedAt as string) <= Date.parse(value.finishedAt as string)) &&
      Date.parse(value.finishedAt as string) <= Date.parse(value.updatedAt as string)) &&
    (!Object.hasOwn(value, "deadLetteredAt") ||
      Date.parse(value.finishedAt as string) <= Date.parse(value.deadLetteredAt as string) &&
      Date.parse(value.deadLetteredAt as string) <= Date.parse(value.updatedAt as string)) &&
    !(value.actionCategory === "tool_call" && value.status === "queued" &&
      hasToolDispatch && value.toolDispatchPhase !== "not_started") &&
    ["manualRetryOfExecutionId", "compensatesExecutionId", "supersedesExecutionIds"].filter((key) => Object.hasOwn(value, key)).length <= 1 &&
    value.manualRetryOfExecutionId !== value.id && value.compensatesExecutionId !== value.id &&
    (!Object.hasOwn(value, "supersedesExecutionIds") || !(value.supersedesExecutionIds as readonly string[]).includes(value.id));
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
