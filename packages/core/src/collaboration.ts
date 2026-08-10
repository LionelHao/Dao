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

export type AgentExecutionStatus = "running" | "completed" | "interrupted" | "failed";

export interface AgentExecution {
  readonly id: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly requesterId: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly status: AgentExecutionStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly result?: string;
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
  return isRecord(value) &&
    hasExactKeys(
      value,
      ["id", "roomId", "sourceMessageId", "requesterId", "agentId", "toolName", "status", "startedAt"],
      ["completedAt", "result"],
    ) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.sourceMessageId) &&
    isNonEmptyString(value.requesterId) &&
    isNonEmptyString(value.agentId) &&
    isNonEmptyString(value.toolName) &&
    (value.status === "running" || value.status === "completed" || value.status === "interrupted" || value.status === "failed") &&
    isNonEmptyString(value.startedAt) &&
    (!Object.hasOwn(value, "completedAt") || isNonEmptyString(value.completedAt)) &&
    (!Object.hasOwn(value, "result") || isNonEmptyString(value.result));
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
