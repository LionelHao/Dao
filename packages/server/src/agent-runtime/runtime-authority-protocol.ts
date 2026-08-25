import {
  isProjectBoundaryInvocationRequest,
  type LegacyAgentExecution as AgentExecution,
  type LegacyAgentInvocationIntent as AgentInvocationIntent,
  type HumanPreemptionNotice,
  type RoomMemoryRawDeltaPage,
  type RoomMemoryStatus,
  type RoomMemoryVersionProjection,
  type ProjectBoundaryInvocationRequest,
  type ProjectBoundaryInvocationResult,
  type ToolConfirmationInput,
  type ToolDescriptor,
  type AgentExecutionRetryReceipt,
} from "@native-im/core";
import type {
  AgentRuntimeErrorCode,
  InvocationCancellationTarget,
  RuntimeRecoveryRecord,
} from "./contracts.js";
import type {
  AgentWorkerCommandContext,
  AuthenticatedCommandContext,
  AuthenticatedSessionContext,
  JsonValue,
} from "../persistence/contracts.js";
import type {
  ScopedCancellationCommitReceipt,
} from "../scoped-cancellation/scoped-cancellation-orchestrator.js";

export type RuntimeAuthorityOperation =
  | { readonly type: "runtime.read-context"; readonly executionId: string; readonly now: number }
  | {
      readonly type: "runtime.preview-authorize";
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly executionId: string;
      readonly attemptSeq: number;
      readonly deliveryKind: "preview" | "reset";
      readonly subscriptionGeneration: number;
      readonly expectedAuthorityEpoch?: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.read-memory-delta";
      readonly executionId: string;
      readonly cursor: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.invoke";
      readonly context: AuthenticatedCommandContext | AgentWorkerCommandContext;
      readonly intent: AgentInvocationIntent;
      readonly executionId: string;
      readonly intentId: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.invoke-routed";
      readonly routeJobId: string;
      readonly intent: AgentInvocationIntent;
      readonly executionId: string;
      readonly intentId: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.claim-pending-direct-intents";
      readonly providerId: string;
      readonly modelId: string;
      readonly limit: number;
      readonly now: number;
    }
  | {
      readonly type: "runtime.suppress-project-boundary";
      readonly request: ProjectBoundaryInvocationRequest;
      readonly requestSha256: string;
      readonly reason: "dependency_unavailable";
      readonly decidedAt: string;
      readonly now: number;
    }
  | { readonly type: "runtime.claim"; readonly executionId: string; readonly attemptSeq: number; readonly now: number }
  | {
      readonly type: "runtime.complete";
      readonly executionId: string;
      readonly attemptSeq: number;
      readonly messageId: string;
      readonly body: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.schedule-retry";
      readonly executionId: string;
      readonly attemptSeq: number;
      readonly errorCode: AgentRuntimeErrorCode;
      readonly nextRetryAt?: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.interrupt";
      readonly context: AuthenticatedCommandContext;
      readonly executionId: string;
      readonly reason: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.shutdown";
      readonly executionId: string;
      readonly attemptSeq: number;
      readonly now: number;
    }
  | {
      readonly type: "runtime.manual-retry";
      readonly context: AuthenticatedCommandContext;
      readonly executionId: string;
      readonly newExecutionId: string;
      readonly newIntentId: string;
      readonly expectedVersion?: number;
      readonly now: number;
    }
  | {
      readonly type: "runtime.cancel-scoped";
      readonly context: AuthenticatedCommandContext;
      readonly target: InvocationCancellationTarget;
      readonly producerId: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.begin-compensation";
      readonly context: AuthenticatedCommandContext;
      readonly executionId: string;
      readonly newExecutionId: string;
      readonly grantId: string;
      readonly dispatchId: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.prepare-tool";
      readonly executionId: string;
      readonly attemptSeq: number;
      readonly tool: ToolDescriptor;
      readonly parameters: Readonly<Record<string, unknown>>;
      readonly grantId: string;
      readonly confirmationId?: string;
      readonly confirmationContext?: AuthenticatedCommandContext;
      readonly providerCall?: { readonly callId: string; readonly argumentsJson: string };
      readonly expiresAt: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.read-pending-confirmation";
      readonly confirmationId: string;
      readonly executionId: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.claim-tool";
      readonly executionId: string;
      readonly attemptSeq: number;
      readonly grantId: string;
      readonly dispatchId: string;
      readonly parameters: Readonly<Record<string, unknown>>;
      readonly confirmation?: {
        readonly context: AuthenticatedCommandContext;
        readonly input: ToolConfirmationInput;
      };
      readonly now: number;
    }
  | {
      readonly type: "runtime.settle-tool";
      readonly dispatchId: string;
      readonly state: "succeeded" | "failed" | "outcome_unknown";
      readonly summary: Readonly<Record<string, string | number | boolean>>;
      readonly sealedCompensation?: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.checkpoint";
      readonly executionId: string;
      readonly attemptSeq: number;
      readonly stepSeq: number;
      readonly kind: "model" | "tool";
      readonly inputSha256: string;
      readonly outputSha256: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.cancel-for-human-fence";
      readonly sourceHumanMessageId: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.create-route-after-human-fence";
      readonly sourceHumanMessageId: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.create-route-for-human-message";
      readonly sourceHumanMessageId: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.enqueue-fence-replacements";
      readonly routeJobId: string;
      readonly targetAgentId: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly now: number;
    }
  | { readonly type: "runtime.list-pending-human-fences"; readonly now: number }
  | {
      readonly type: "runtime.recovery-scan";
      readonly after?: string;
      readonly limit: number;
      readonly includeRunning: boolean;
      readonly leaseOwner: string;
      readonly leaseExpiresAt: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.recovery-isolate";
      readonly cursor: string;
      readonly candidateId?: string;
      readonly leaseOwner: string;
      readonly reason: "recovery_candidate_invalid" | "recovery_candidate_conflict";
      readonly now: number;
    }
  | {
      readonly type: "runtime.recovery-settle";
      readonly cursor: string;
      readonly candidateId: string;
      readonly leaseOwner: string;
      readonly now: number;
    }
  | {
      readonly type: "runtime.recovery-release";
      readonly leaseOwner: string;
      readonly now: number;
    }
  | { readonly type: "runtime.recover"; readonly now: number };

export type RuntimeAuthorityOperationResult =
  | {
      readonly kind: "context";
      readonly visibleConversation: readonly { readonly messageId: string; readonly authorId: string; readonly body: string }[];
      readonly toolIds: readonly ToolDescriptor["id"][];
      readonly openItemTargets: readonly { readonly actorId: string; readonly kind: "human" | "agent" }[];
      readonly roomMemory: Readonly<{
        status: RoomMemoryStatus;
        injectableSnapshot: readonly RoomMemoryVersionProjection[];
        rawDelta: RoomMemoryRawDeltaPage;
      }>;
    }
  | { readonly kind: "memory-delta"; readonly rawDelta: RoomMemoryRawDeltaPage }
  | {
      readonly kind: "preview-authority";
      readonly authorized: boolean;
      readonly authorityEpoch: string;
      readonly subscriptionGeneration: number;
    }
  | {
      readonly kind: "invocation";
      readonly execution: AgentExecution;
      readonly intent: AgentInvocationIntent;
      readonly replayed: boolean;
      readonly retryReceipt?: AgentExecutionRetryReceipt;
    }
  | {
      readonly kind: "direct-intent-claims";
      readonly records: readonly RuntimeRecoveryRecord[];
      readonly hasMore: boolean;
    }
  | { readonly kind: "project-boundary"; readonly result: ProjectBoundaryInvocationResult }
  | { readonly kind: "execution"; readonly execution: AgentExecution }
  | {
      readonly kind: "prepared-tool";
      readonly execution: AgentExecution;
      readonly grantId: string;
      readonly confirmationId?: string;
      readonly target?: string;
      readonly impact?: string;
      readonly reversibility?: "compensatable" | "irreversible";
    }
  | {
      readonly kind: "claimed-tool";
      readonly dispatchId: string;
      readonly toolId: ToolDescriptor["id"];
      readonly parameters: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "pending-confirmation";
      readonly execution: AgentExecution;
      readonly intent: AgentInvocationIntent;
      readonly grantId: string;
      readonly toolId: ToolDescriptor["id"];
      readonly parameters: Readonly<Record<string, unknown>>;
      readonly callId: string;
      readonly argumentsJson: string;
    }
  | { readonly kind: "settled-tool" }
  | { readonly kind: "checkpoint" }
  | ScopedCancellationCommitReceipt
  | {
      readonly kind: "human-fence-cancelled";
      readonly notice: HumanPreemptionNotice;
      readonly cancelledExecutions: readonly AgentExecution[];
    }
  | {
      readonly kind: "human-fence-route";
      readonly roomId: string;
      readonly sourceHumanMessageId: string;
      readonly routeJobId: string;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "human-message-route";
      readonly roomId: string;
      readonly sourceHumanMessageId: string;
      readonly routeJobId: string;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "human-fence-replacements";
      readonly executions: readonly AgentExecution[];
      readonly replayed: boolean;
    }
  | {
      readonly kind: "pending-human-fences";
      readonly sourceHumanMessageIds: readonly string[];
    }
  | {
      readonly kind: "compensation";
      readonly execution: AgentExecution;
      readonly dispatchId: string;
      readonly toolId: ToolDescriptor["id"];
      readonly sealedCompensation: string;
      readonly replayed: boolean;
    }
  | { readonly kind: "recovery"; readonly records: readonly RuntimeRecoveryRecord[] }
  | {
      readonly kind: "recovery-page";
      readonly candidates: readonly Readonly<{
        readonly cursor: string;
        readonly record: RuntimeRecoveryRecord;
      }>[];
      readonly hasMore: boolean;
    }
  | { readonly kind: "recovery-isolated" }
  | { readonly kind: "recovery-settled" }
  | { readonly kind: "recovery-released"; readonly released: number };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
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

function humanContext(value: unknown): value is AuthenticatedCommandContext {
  if (!record(value) || !exact(value, ["kind", "sessionId", "sessionFamilyId", "principal", "requestId", "idempotencyKey"]) ||
      value.kind !== "human" || !text(value.sessionId) || !text(value.sessionFamilyId) || !text(value.requestId) || !text(value.idempotencyKey) ||
      !record(value.principal) || !exact(value.principal, ["accountId", "actorId"]) || !text(value.principal.accountId) || !text(value.principal.actorId)) return false;
  return true;
}

function sessionContext(value: unknown): value is AuthenticatedSessionContext {
  return record(value) && exact(value, ["sessionId", "sessionFamilyId", "principal"]) &&
    text(value.sessionId) && text(value.sessionFamilyId) && record(value.principal) &&
    exact(value.principal, ["accountId", "actorId"]) &&
    text(value.principal.accountId) && text(value.principal.actorId);
}

function agentContext(value: unknown): value is AgentWorkerCommandContext {
  return record(value) && exact(value, ["kind", "agent", "requestId", "idempotencyKey"]) && value.kind === "agent" &&
    text(value.requestId) && text(value.idempotencyKey) && record(value.agent) &&
    exact(value.agent, ["actorId", "kind"]) && value.agent.kind === "agent" && text(value.agent.actorId);
}

function invocationIntent(value: unknown): value is AgentInvocationIntent {
  return record(value) && exact(value, ["kind", "roomId", "sourceMessageId", "targetAgentId"]) &&
    (value.kind === "direct_mention" || value.kind === "structured_help" || value.kind === "routed_candidate") &&
    text(value.roomId) && text(value.sourceMessageId) && text(value.targetAgentId);
}

const toolIds = new Set<ToolDescriptor["id"]>([
  "http-json.read", "repository.git-status", "sandbox-file.write",
]);

function jsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!record(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= 64 * 1_024;
  } catch {
    return false;
  }
}

function toolDescriptor(value: unknown): value is ToolDescriptor {
  return record(value) && exact(value, ["id", "displayName", "effect", "reversibility"]) &&
    toolIds.has(value.id as ToolDescriptor["id"]) && text(value.displayName) &&
    (value.effect === "read-only" || value.effect === "side-effecting") &&
    (value.reversibility === "compensatable" || value.reversibility === "irreversible");
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

const errorCodes = new Set<AgentRuntimeErrorCode>([
  "agent_configuration_missing", "agent_queue_full", "agent_runtime_closed", "confirmation_expired",
  "confirmation_forbidden", "confirmation_replayed", "content_too_large", "execution_conflict", "execution_not_found",
  "context_capacity_limited", "context_forbidden", "context_generation_conflict",
  "context_snapshot_conflict", "context_snapshot_invalidated", "context_source_gone",
  "context_storage_unavailable",
  "invalid_parameters", "permission_denied", "provider_authentication", "provider_failure",
  "provider_malformed", "provider_rate_limited", "provider_timeout", "provider_unavailable",
  "side_effect_outcome_unknown", "tool_failure", "tool_target_busy",
]);

export function isRuntimeAuthorityOperation(value: unknown): value is RuntimeAuthorityOperation {
  if (!record(value) || !text(value.type)) return false;
  if (value.type === "runtime.read-context") {
    return exact(value, ["type", "executionId", "now"]) && text(value.executionId) && count(value.now);
  }
  if (value.type === "runtime.preview-authorize") {
    const optional = Object.hasOwn(value, "expectedAuthorityEpoch")
      ? ["expectedAuthorityEpoch"] : [];
    return exact(value, [
      "type", "context", "roomId", "executionId", "attemptSeq", "deliveryKind",
      "subscriptionGeneration", "now",
    ], optional) && sessionContext(value.context) && text(value.roomId) &&
      text(value.executionId) && count(value.attemptSeq, 1) &&
      (value.deliveryKind === "preview" || value.deliveryKind === "reset") &&
      count(value.subscriptionGeneration, 1) &&
      (!Object.hasOwn(value, "expectedAuthorityEpoch") || text(value.expectedAuthorityEpoch)) &&
      count(value.now);
  }
  if (value.type === "runtime.read-memory-delta") {
    return exact(value, ["type", "executionId", "cursor", "now"]) &&
      text(value.executionId) && text(value.cursor) &&
      Buffer.byteLength(value.cursor, "utf8") <= 2_048 && count(value.now);
  }
  if (value.type === "runtime.invoke") {
    return exact(value, ["type", "context", "intent", "executionId", "intentId", "providerId", "modelId", "now"]) &&
      (humanContext(value.context) || agentContext(value.context)) && invocationIntent(value.intent) &&
      text(value.executionId) && text(value.intentId) && text(value.providerId) && text(value.modelId) && count(value.now);
  }
  if (value.type === "runtime.invoke-routed") {
    return exact(value, ["type", "routeJobId", "intent", "executionId", "intentId", "providerId", "modelId", "now"]) &&
      text(value.routeJobId) && invocationIntent(value.intent) && text(value.executionId) &&
      text(value.intentId) && text(value.providerId) && text(value.modelId) && count(value.now);
  }
  if (value.type === "runtime.claim-pending-direct-intents") {
    return exact(value, ["type", "providerId", "modelId", "limit", "now"]) &&
      text(value.providerId) && text(value.modelId) && count(value.limit, 1) &&
      value.limit <= 256 && count(value.now);
  }
  if (value.type === "runtime.suppress-project-boundary") {
    return exact(value, [
      "type", "request", "requestSha256", "reason", "decidedAt", "now",
    ]) && isProjectBoundaryInvocationRequest(value.request) && sha256(value.requestSha256) &&
      value.reason === "dependency_unavailable" && text(value.decidedAt) && count(value.now);
  }
  if (value.type === "runtime.claim") {
    return exact(value, ["type", "executionId", "attemptSeq", "now"]) && text(value.executionId) && count(value.attemptSeq, 1) && count(value.now);
  }
  if (value.type === "runtime.complete") {
    return exact(value, ["type", "executionId", "attemptSeq", "messageId", "body", "now"]) &&
      text(value.executionId) && count(value.attemptSeq, 1) && text(value.messageId) && text(value.body) &&
      Buffer.byteLength(value.body, "utf8") <= 256 * 1_024 && count(value.now);
  }
  if (value.type === "runtime.schedule-retry") {
    return exact(value, ["type", "executionId", "attemptSeq", "errorCode", "now"], Object.hasOwn(value, "nextRetryAt") ? ["nextRetryAt"] : []) &&
      text(value.executionId) && count(value.attemptSeq, 1) && errorCodes.has(value.errorCode as AgentRuntimeErrorCode) &&
      (!Object.hasOwn(value, "nextRetryAt") || text(value.nextRetryAt)) && count(value.now);
  }
  if (value.type === "runtime.interrupt") {
    return exact(value, ["type", "context", "executionId", "reason", "now"]) && humanContext(value.context) &&
      text(value.executionId) && text(value.reason) && count(value.now);
  }
  if (value.type === "runtime.shutdown") {
    return exact(value, ["type", "executionId", "attemptSeq", "now"]) &&
      text(value.executionId) && count(value.attemptSeq, 1) && count(value.now);
  }
  if (value.type === "runtime.manual-retry") {
    const optional = Object.hasOwn(value, "expectedVersion") ? ["expectedVersion"] : [];
    return exact(value, ["type", "context", "executionId", "newExecutionId", "newIntentId", "now"], optional) &&
      humanContext(value.context) && text(value.executionId) && text(value.newExecutionId) &&
      text(value.newIntentId) && (!Object.hasOwn(value, "expectedVersion") ||
        count(value.expectedVersion, 1)) && count(value.now);
  }
  if (value.type === "runtime.cancel-scoped") {
    return exact(value, [
      "type", "context", "target", "producerId", "now",
    ]) && humanContext(value.context) && record(value.target) &&
      ((exact(value.target, ["executionId", "expectedVersion"]) &&
        text(value.target.executionId) && count(value.target.expectedVersion, 1)) ||
       (exact(value.target, ["intentId", "expectedVersion"]) &&
        text(value.target.intentId) && count(value.target.expectedVersion, 1))) &&
      text(value.producerId) && count(value.now);
  }
  if (value.type === "runtime.begin-compensation") {
    return exact(value, ["type", "context", "executionId", "newExecutionId", "grantId", "dispatchId", "now"]) &&
      humanContext(value.context) && text(value.executionId) && text(value.newExecutionId) &&
      text(value.grantId) && text(value.dispatchId) && count(value.now);
  }
  if (value.type === "runtime.prepare-tool") {
    const optional = [
      ...(Object.hasOwn(value, "confirmationId") ? ["confirmationId"] : []),
      ...(Object.hasOwn(value, "confirmationContext") ? ["confirmationContext"] : []),
      ...(Object.hasOwn(value, "providerCall") ? ["providerCall"] : []),
    ];
    return exact(value, ["type", "executionId", "attemptSeq", "tool", "parameters", "grantId", "expiresAt", "now"], optional) &&
      text(value.executionId) && count(value.attemptSeq, 1) && toolDescriptor(value.tool) &&
      jsonObject(value.parameters) && text(value.grantId) && text(value.expiresAt) && count(value.now) &&
      (!Object.hasOwn(value, "confirmationId") || text(value.confirmationId)) &&
      (!Object.hasOwn(value, "confirmationContext") || humanContext(value.confirmationContext)) &&
      (!Object.hasOwn(value, "providerCall") || (record(value.providerCall) &&
        exact(value.providerCall, ["callId", "argumentsJson"]) && text(value.providerCall.callId) &&
        typeof value.providerCall.argumentsJson === "string" &&
        Buffer.byteLength(value.providerCall.argumentsJson, "utf8") <= 64 * 1_024));
  }
  if (value.type === "runtime.read-pending-confirmation") {
    return exact(value, ["type", "confirmationId", "executionId", "now"]) &&
      text(value.confirmationId) && text(value.executionId) && count(value.now);
  }
  if (value.type === "runtime.claim-tool") {
    const optional = Object.hasOwn(value, "confirmation") ? ["confirmation"] : [];
    return exact(value, ["type", "executionId", "attemptSeq", "grantId", "dispatchId", "parameters", "now"], optional) &&
      text(value.executionId) && count(value.attemptSeq, 1) && text(value.grantId) && text(value.dispatchId) &&
      jsonObject(value.parameters) && count(value.now) &&
      (!Object.hasOwn(value, "confirmation") || (record(value.confirmation) &&
        exact(value.confirmation, ["context", "input"]) && humanContext(value.confirmation.context) &&
        record(value.confirmation.input) && exact(value.confirmation.input, ["confirmationId", "executionId"]) &&
        text(value.confirmation.input.confirmationId) && text(value.confirmation.input.executionId)));
  }
  if (value.type === "runtime.settle-tool") {
    const optional = Object.hasOwn(value, "sealedCompensation") ? ["sealedCompensation"] : [];
    return exact(value, ["type", "dispatchId", "state", "summary", "now"], optional) &&
      text(value.dispatchId) && (value.state === "succeeded" || value.state === "failed" || value.state === "outcome_unknown") &&
      jsonObject(value.summary) && Object.values(value.summary).every((entry) =>
        typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") &&
      (!Object.hasOwn(value, "sealedCompensation") || text(value.sealedCompensation)) && count(value.now);
  }
  if (value.type === "runtime.checkpoint") {
    return exact(value, ["type", "executionId", "attemptSeq", "stepSeq", "kind", "inputSha256", "outputSha256", "now"]) &&
      text(value.executionId) && count(value.attemptSeq, 1) && count(value.stepSeq, 1) &&
      (value.kind === "model" || value.kind === "tool") && sha256(value.inputSha256) && sha256(value.outputSha256) && count(value.now);
  }
  if (value.type === "runtime.cancel-for-human-fence" ||
      value.type === "runtime.create-route-after-human-fence" ||
      value.type === "runtime.create-route-for-human-message") {
    return exact(value, ["type", "sourceHumanMessageId", "now"]) &&
      text(value.sourceHumanMessageId) && count(value.now);
  }
  if (value.type === "runtime.enqueue-fence-replacements") {
    return exact(value, ["type", "routeJobId", "targetAgentId", "providerId", "modelId", "now"]) &&
      text(value.routeJobId) && text(value.targetAgentId) && text(value.providerId) &&
      text(value.modelId) && count(value.now);
  }
  if (value.type === "runtime.list-pending-human-fences") {
    return exact(value, ["type", "now"]) && count(value.now);
  }
  if (value.type === "runtime.recovery-scan") {
    const optional = Object.hasOwn(value, "after") ? ["after"] : [];
    const leaseExpiresAt = typeof value.leaseExpiresAt === "string"
      ? Date.parse(value.leaseExpiresAt)
      : Number.NaN;
    return exact(value, [
      "type", "limit", "includeRunning", "leaseOwner", "leaseExpiresAt", "now",
    ], optional) &&
      count(value.limit, 1) && value.limit <= 256 && typeof value.includeRunning === "boolean" &&
      (!Object.hasOwn(value, "after") || text(value.after)) && text(value.leaseOwner) &&
      Buffer.byteLength(value.leaseOwner, "utf8") <= 256 && count(value.now) &&
      Number.isFinite(leaseExpiresAt) && leaseExpiresAt > value.now &&
      leaseExpiresAt <= value.now + 10 * 60_000 &&
      new Date(leaseExpiresAt).toISOString() === value.leaseExpiresAt;
  }
  if (value.type === "runtime.recovery-isolate") {
    const optional = Object.hasOwn(value, "candidateId") ? ["candidateId"] : [];
    return exact(value, ["type", "cursor", "leaseOwner", "reason", "now"], optional) &&
      text(value.cursor) && (!Object.hasOwn(value, "candidateId") || text(value.candidateId)) &&
      text(value.leaseOwner) && Buffer.byteLength(value.leaseOwner, "utf8") <= 256 &&
      (value.reason === "recovery_candidate_invalid" ||
        value.reason === "recovery_candidate_conflict") && count(value.now);
  }
  if (value.type === "runtime.recovery-settle") {
    return exact(value, ["type", "cursor", "candidateId", "leaseOwner", "now"]) &&
      text(value.cursor) && text(value.candidateId) && text(value.leaseOwner) &&
      Buffer.byteLength(value.leaseOwner, "utf8") <= 256 && count(value.now);
  }
  if (value.type === "runtime.recovery-release") {
    return exact(value, ["type", "leaseOwner", "now"]) && text(value.leaseOwner) &&
      Buffer.byteLength(value.leaseOwner, "utf8") <= 256 && count(value.now);
  }
  return value.type === "runtime.recover" && exact(value, ["type", "now"]) && count(value.now);
}

export function runtimeResultAsJson(result: RuntimeAuthorityOperationResult): JsonValue {
  return result as unknown as JsonValue;
}
