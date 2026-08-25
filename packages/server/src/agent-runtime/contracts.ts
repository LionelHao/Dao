import type {
  LegacyAgentExecution as AgentExecution,
  LegacyAgentInvocationIntent as AgentInvocationIntent,
  AgentRuntimeProviderInput,
  ProviderEvent,
  RoomMemoryRawDeltaPage,
  RoomMemoryStatus,
  RoomMemoryVersionProjection,
  ToolConfirmationInput,
  ToolDescriptor,
  AgentExecutionRetryReceipt,
  ScopedCancellationReceipt,
} from "@native-im/core";
import type { AuthenticatedCommandContext, InternalAgentCommandContext } from "../persistence/contracts.js";
import type { ScopedCancellationCommitReceipt } from "../scoped-cancellation/scoped-cancellation-orchestrator.js";

export const AGENT_RUNTIME_MAX_ACTIVE = 8;
export const AGENT_RUNTIME_MAX_QUEUED_PER_ROOM = 32;
export const AGENT_RUNTIME_MAX_ADMITTED_PER_ROOM = 32;
export const AGENT_RUNTIME_RECOVERY_BATCH_SIZE = 256;
export const AGENT_RUNTIME_RETRY_DELAYS_MS = [1_000, 4_000] as const;
export const AGENT_RUNTIME_MAX_ATTEMPTS = 3;

export type AgentRuntimeErrorCode =
  | "agent_configuration_missing"
  | "agent_queue_full"
  | "agent_runtime_closed"
  | "confirmation_expired"
  | "confirmation_forbidden"
  | "confirmation_replayed"
  | "content_too_large"
  | "context_capacity_limited"
  | "context_forbidden"
  | "context_generation_conflict"
  | "context_snapshot_conflict"
  | "context_snapshot_invalidated"
  | "context_source_gone"
  | "context_storage_unavailable"
  | "execution_conflict"
  | "execution_not_found"
  | "invalid_parameters"
  | "permission_denied"
  | "provider_authentication"
  | "provider_failure"
  | "provider_malformed"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_unavailable"
  | "side_effect_outcome_unknown"
  | "tool_failure"
  | "tool_target_busy";

const errorStatuses: Readonly<Record<AgentRuntimeErrorCode, 400 | 403 | 404 | 409 | 410 | 429 | 503>> = {
  agent_configuration_missing: 503,
  agent_queue_full: 429,
  agent_runtime_closed: 503,
  confirmation_expired: 410,
  confirmation_forbidden: 403,
  confirmation_replayed: 409,
  content_too_large: 400,
  context_capacity_limited: 429,
  context_forbidden: 403,
  context_generation_conflict: 409,
  context_snapshot_conflict: 409,
  context_snapshot_invalidated: 410,
  context_source_gone: 410,
  context_storage_unavailable: 503,
  execution_conflict: 409,
  execution_not_found: 404,
  invalid_parameters: 400,
  permission_denied: 403,
  provider_authentication: 503,
  provider_failure: 503,
  provider_malformed: 503,
  provider_rate_limited: 503,
  provider_timeout: 503,
  provider_unavailable: 503,
  side_effect_outcome_unknown: 409,
  tool_failure: 503,
  tool_target_busy: 503,
};

export class AgentRuntimeError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 410 | 429 | 503;

  constructor(
    readonly code: AgentRuntimeErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
    this.status = errorStatuses[code];
  }
}

export interface ProviderAdapter {
  readonly id: string;
  stream(input: AgentRuntimeProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export interface SecretProvider {
  getSecret(name: "OPENAI_API_KEY"): string | undefined;
}

export interface ToolInvocation {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly roomId: string;
  readonly agentId: string;
  readonly callId: string;
  readonly grantId: string;
  readonly dispatchId: string;
  readonly toolId: ToolDescriptor["id"];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface ToolOutcome {
  readonly summary: Readonly<Record<string, string | number | boolean>>;
  readonly modelInput: string;
  readonly compensationToken?: string;
}

export interface ToolAdapter {
  readonly descriptor: ToolDescriptor;
  execute(invocation: ToolInvocation): Promise<ToolOutcome>;
  compensate?(token: string, signal: AbortSignal): Promise<ToolOutcome>;
}

export interface InvocationAccepted {
  readonly execution: AgentExecution;
  readonly replayed: boolean;
}

export interface InvocationAcceptedWithIntent extends InvocationAccepted {
  readonly intent: AgentInvocationIntent;
  readonly retryReceipt?: AgentExecutionRetryReceipt;
}

export type InvocationCancellationTarget =
  | Readonly<{ executionId: string; expectedVersion: number }>
  | Readonly<{ intentId: string; expectedVersion: number }>;

export interface PreparedToolCall {
  readonly execution: AgentExecution;
  readonly grantId: string;
  readonly confirmationId?: string;
  readonly target?: string;
  readonly impact?: string;
  readonly reversibility?: "compensatable" | "irreversible";
}

export interface ClaimedToolDispatch {
  readonly dispatchId: string;
  readonly toolId: ToolDescriptor["id"];
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface PendingToolConfirmation {
  readonly execution: AgentExecution;
  readonly intent: AgentInvocationIntent;
  readonly grantId: string;
  readonly toolId: ToolDescriptor["id"];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly callId: string;
  readonly argumentsJson: string;
}

export interface BegunCompensation {
  readonly execution: AgentExecution;
  readonly dispatchId: string;
  readonly toolId: ToolDescriptor["id"];
  readonly sealedCompensation: string;
  readonly replayed: boolean;
}

export interface RuntimeRecoveryRecord {
  readonly execution: AgentExecution;
  readonly intent: AgentInvocationIntent;
  readonly outcome: "enqueue" | "failed" | "fail_outcome_unknown" | "wait_confirmation";
}

/**
 * Closed keyset-scanning port for FT-08 recovery. The persistence owner may
 * implement this without exposing rows or SQL to the runtime scheduler. The
 * scheduler always performs one final scan that returns an empty page, so a
 * non-empty page never becomes an implicit batch tail.
 */
export interface RuntimeRecoveryAuthority {
  scan(input: Readonly<{
    /** Opaque, stable key returned by the preceding candidate. */
    readonly after?: string;
    readonly limit: number;
  }>): Promise<Readonly<{
    candidates: readonly Readonly<{
      readonly cursor: string;
      /** Deliberately unknown until the runtime boundary validates it. */
      readonly record: unknown;
    }>[];
    readonly hasMore: boolean;
  }>>;
  isolate(input: Readonly<{
    readonly cursor: string;
    readonly candidateId?: string;
    readonly reason: "recovery_candidate_invalid" | "recovery_candidate_conflict";
  }>): Promise<void>;
  /** Acknowledges a candidate whose durable execution already left queued state. */
  settle?(input: Readonly<{
    readonly cursor: string;
    readonly candidateId: string;
  }>): Promise<void>;
  /** Returns every still-owned, unstarted candidate to durable pending state. */
  release?(): Promise<number>;
}

export interface FenceReplacementAccepted {
  readonly executions: readonly AgentExecution[];
  readonly replayed: boolean;
}

export interface RuntimeAuthority {
  readContext(executionId: string): Promise<{
    readonly visibleConversation: readonly { readonly messageId: string; readonly authorId: string; readonly body: string }[];
    readonly toolIds: readonly ToolDescriptor["id"][];
    readonly openItemTargets: readonly { readonly actorId: string; readonly kind: "human" | "agent" }[];
    readonly roomMemory: Readonly<{
      status: RoomMemoryStatus;
      injectableSnapshot: readonly RoomMemoryVersionProjection[];
      rawDelta: RoomMemoryRawDeltaPage;
    }>;
  }>;
  readMemoryDelta(executionId: string, cursor: string): Promise<RoomMemoryRawDeltaPage>;
  invoke(
    context: AuthenticatedCommandContext | InternalAgentCommandContext,
    intent: AgentInvocationIntent,
    providerId: string,
    modelId: string,
  ): Promise<InvocationAcceptedWithIntent>;
  invokeRouted(
    routeJobId: string,
    intent: AgentInvocationIntent,
    providerId: string,
    modelId: string,
  ): Promise<InvocationAcceptedWithIntent>;
  enqueueFenceReplacements(
    routeJobId: string,
    targetAgentId: string,
    providerId: string,
    modelId: string,
  ): Promise<FenceReplacementAccepted>;
  claim(executionId: string, attemptSeq: number): Promise<AgentExecution>;
  complete(
    executionId: string,
    attemptSeq: number,
    body: string,
    citationLabels?: readonly string[],
  ): Promise<AgentExecution>;
  scheduleRetry(
    executionId: string,
    attemptSeq: number,
    errorCode: AgentRuntimeErrorCode,
    nextRetryAt: string | undefined,
  ): Promise<AgentExecution>;
  shutdown(executionId: string, attemptSeq: number): Promise<AgentExecution>;
  interrupt(
    context: AuthenticatedCommandContext,
    executionId: string,
    reason: string,
  ): Promise<AgentExecution>;
  cancelScoped(
    context: AuthenticatedCommandContext,
    target: InvocationCancellationTarget,
    producerId: string,
  ): Promise<ScopedCancellationCommitReceipt>;
  retry(
    context: AuthenticatedCommandContext,
    executionId: string,
    expectedVersion?: number,
  ): Promise<InvocationAcceptedWithIntent>;
  beginCompensation(
    context: AuthenticatedCommandContext,
    executionId: string,
  ): Promise<BegunCompensation>;
  prepareTool(
    executionId: string,
    attemptSeq: number,
    tool: ToolDescriptor,
    parameters: Readonly<Record<string, unknown>>,
    confirmationContext?: AuthenticatedCommandContext,
    providerCall?: { readonly callId: string; readonly argumentsJson: string },
  ): Promise<PreparedToolCall>;
  readPendingConfirmation(
    confirmationId: string,
    executionId: string,
  ): Promise<PendingToolConfirmation>;
  claimTool(
    executionId: string,
    attemptSeq: number,
    grantId: string,
    parameters: Readonly<Record<string, unknown>>,
    confirmation?: { readonly context: AuthenticatedCommandContext; readonly input: ToolConfirmationInput },
    providerCall?: { readonly callId: string },
  ): Promise<ClaimedToolDispatch>;
  settleTool(
    dispatchId: string,
    state: "succeeded" | "failed" | "outcome_unknown",
    summary: Readonly<Record<string, string | number | boolean>>,
    compensationToken?: string,
  ): Promise<void>;
  checkpoint(
    executionId: string,
    attemptSeq: number,
    stepSeq: number,
    kind: "model" | "tool",
    inputSha256: string,
    outputSha256: string,
  ): Promise<void>;
  recover(): Promise<readonly RuntimeRecoveryRecord[]>;
}

export interface AgentRuntime {
  invoke(
    context: AuthenticatedCommandContext | InternalAgentCommandContext,
    intent: AgentInvocationIntent,
  ): Promise<InvocationAccepted>;
  interrupt(
    context: AuthenticatedCommandContext,
    executionId: string,
    reason: string,
  ): Promise<AgentExecution>;
  cancelInvocation(
    context: AuthenticatedCommandContext,
    target: InvocationCancellationTarget,
  ): Promise<ScopedCancellationReceipt>;
  retry(context: AuthenticatedCommandContext, executionId: string): Promise<InvocationAccepted>;
  retryInvocation(
    context: AuthenticatedCommandContext,
    executionId: string,
    expectedVersion: number,
  ): Promise<InvocationAcceptedWithIntent & { readonly retryReceipt: AgentExecutionRetryReceipt }>;
  confirmTool(
    context: AuthenticatedCommandContext,
    confirmation: ToolConfirmationInput,
  ): Promise<AgentExecution>;
  compensate(context: AuthenticatedCommandContext, executionId: string): Promise<InvocationAccepted>;
  close(): Promise<void>;
}

export interface RuntimeClock {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}
