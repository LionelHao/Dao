import { MESSAGE_AUTHORITY_LIMITS } from "@native-im/core";
import {
  type AgentMessageWorkerContext,
  type InternalAgentMessageCommitContext,
  toAgentMessageWorkerContext,
} from "../internal-message-capability.js";

const MAX_SOURCE_EFFECTS = 256;
const MAX_PREVIEW_DELTA_BYTES = 64 * 1_024;

export interface SourceRecallRequest {
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly expectedRevision: number;
}

export type RetainedSideEffectState =
  | "none"
  | "dispatched-retained"
  | "outcome-unknown-retained";

export interface CommittedSourceExecutionCancellation {
  readonly sourceMessageId: string;
  readonly sourceRevision: number;
  readonly invocationIntentId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly cancellationReason: "message_recalled";
  readonly sideEffectState: RetainedSideEffectState;
}

export interface SourceRecallCommitReceipt {
  readonly kind: "source-recall-committed";
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly recalledRevision: number;
  readonly cancelledIntentIds: readonly string[];
  readonly executionCancellations: readonly CommittedSourceExecutionCancellation[];
  readonly retainedFinalMessageIds: readonly string[];
  readonly retainedFactIds: readonly string[];
}

export interface InvocationClaimRequest {
  readonly sourceMessageId: string;
  readonly invocationIntentId: string;
}

export type InvocationClaimCommitReceipt =
  | Readonly<{
      kind: "execution-created";
      sourceMessageId: string;
      invocationIntentId: string;
      executionId: string;
      attemptSeq: number;
    }>
  | Readonly<{
      kind: "source-fenced";
      sourceMessageId: string;
      invocationIntentId: string;
      reason: "message_recalled";
    }>
  | Readonly<{
      kind: "claim-rejected";
      sourceMessageId: string;
      invocationIntentId: string;
      reason:
        | "intent_not_pending"
        | "source_revision_stale"
        | "membership_revoked"
        | "assignment_inactive"
        | "room_archived";
    }>;

interface AgentMessageCommitBase {
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly sourceRevision: number;
  readonly messageId: string;
  readonly body: string;
}

export type AgentMessageCommitCommand =
  | Readonly<AgentMessageCommitBase & { readonly kind: "final" }>
  | Readonly<AgentMessageCommitBase & {
      readonly kind: "correction";
      readonly correctsMessageId: string;
    }>;

export type AgentMessageCommitRejectionReason =
  | "source_fenced"
  | "source_revision_stale"
  | "stale_attempt"
  | "stale_execution_generation"
  | "execution_terminal"
  | "lineage_mismatch";

export type AgentMessageCommitReceipt =
  | Readonly<{
      kind: "agent-message-committed";
      messageKind: AgentMessageCommitCommand["kind"];
      roomId: string;
      sourceMessageId: string;
      messageId: string;
    }>
  | Readonly<{
      kind: "agent-message-rejected";
      messageKind: AgentMessageCommitCommand["kind"];
      sourceMessageId: string;
      reason: AgentMessageCommitRejectionReason;
      writeDisposition: "zero-write";
    }>;

export interface SourceScopedRuntimePersistencePort {
  commitSourceRecall(request: SourceRecallRequest): Promise<SourceRecallCommitReceipt>;
  claimAndCreateExecution(
    request: InvocationClaimRequest,
  ): Promise<InvocationClaimCommitReceipt>;
  commitAgentMessage(input: Readonly<{
    context: AgentMessageWorkerContext;
    command: AgentMessageCommitCommand;
  }>): Promise<AgentMessageCommitReceipt>;
}

export interface SourceScopedAgentRuntimePort {
  enqueueCommittedExecution(input: Readonly<{
    sourceMessageId: string;
    invocationIntentId: string;
    executionId: string;
    attemptSeq: number;
  }>): void | Promise<void>;
  abortAfterCommittedCancellation(
    effect: CommittedSourceExecutionCancellation,
  ): void | Promise<void>;
}

export interface TransientAgentPreview {
  readonly sourceMessageId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly streamSeq: number;
  readonly delta: string;
}

export type TransientPreviewResetReason = "runtime-crash" | "client-reconnect";

export interface TransientAgentPreviewPort {
  publish(preview: TransientAgentPreview): void;
  discardExecution(input: Readonly<{
    executionId: string;
    reason: "message-recalled";
  }>): void | Promise<void>;
  discardAll(input: Readonly<{ reason: TransientPreviewResetReason }>): void;
}

export interface SourceScopedRuntimePostCommitErrorContext {
  readonly phase: "enqueue" | "preview-reset" | "abort" | "preview";
  readonly sourceMessageId?: string;
  readonly executionId?: string;
}

export interface CreateSourceScopedRuntimeCoordinatorOptions {
  readonly persistence: SourceScopedRuntimePersistencePort;
  readonly runtime?: SourceScopedAgentRuntimePort;
  readonly preview?: TransientAgentPreviewPort;
  readonly onPostCommitError?: (
    error: unknown,
    context: SourceScopedRuntimePostCommitErrorContext,
  ) => void;
}

export interface SourceScopedRuntimeCoordinator {
  recallSource(request: SourceRecallRequest): Promise<Readonly<{
    receipt: SourceRecallCommitReceipt;
    postCommitEffects: readonly Readonly<{
      executionId: string;
      status: "applied" | "recovery-required";
    }>[];
  }>>;
  claimAndCreateExecution(request: InvocationClaimRequest): Promise<Readonly<{
    receipt: InvocationClaimCommitReceipt;
    runtimeHandoff: "scheduled" | "not-applicable" | "recovery-required";
  }>>;
  commitAgentMessage(
    context: InternalAgentMessageCommitContext,
    command: AgentMessageCommitCommand,
  ): Promise<AgentMessageCommitReceipt>;
  publishPreview(preview: TransientAgentPreview): void;
  discardTransientPreviews(reason: TransientPreviewResetReason): void;
}

export interface CommittedMessageRecallRuntimeInput {
  readonly sourceMessageId: string;
  readonly cancellations: readonly CommittedSourceExecutionCancellation[];
}

export interface RuntimeProviderPreview extends TransientAgentPreview {
  readonly roomId: string;
}

export interface SourceScopedRuntimeBoundaryOptions {
  readonly runtime?: Readonly<{
    applyCommittedMessageRecall(input: CommittedMessageRecallRuntimeInput): void | Promise<void>;
  }>;
  readonly preview?: Readonly<{
    publish(preview: RuntimeProviderPreview): void;
  }>;
  readonly onPostCommitError?: (
    error: unknown,
    context: SourceScopedRuntimePostCommitErrorContext,
  ) => void;
}

export interface SourceScopedRuntimeBoundary {
  coordinateRecallCommit<Receipt>(
    commit: () => Promise<Receipt>,
    selectRuntimeInput: (receipt: Receipt) => CommittedMessageRecallRuntimeInput,
  ): Promise<Receipt>;
  publishPreview(preview: RuntimeProviderPreview): void;
}

type UnknownRecord = Record<string, unknown>;

interface ActiveSourceState {
  activeClaims: number;
  fenceCommitted: boolean;
}

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MESSAGE_AUTHORITY_LIMITS.identifierUtf16 && value === value.trim();
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function uniqueIdentifiers(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_SOURCE_EFFECTS &&
    value.every(identifier) && new Set(value).size === value.length;
}

function sourceRecallRequest(value: unknown): value is SourceRecallRequest {
  return record(value) && exact(value, ["roomId", "sourceMessageId", "expectedRevision"]) &&
    identifier(value.roomId) && identifier(value.sourceMessageId) &&
    positiveInteger(value.expectedRevision);
}

function invocationClaimRequest(value: unknown): value is InvocationClaimRequest {
  return record(value) && exact(value, ["sourceMessageId", "invocationIntentId"]) &&
    identifier(value.sourceMessageId) && identifier(value.invocationIntentId);
}

function executionCancellation(
  value: unknown,
  sourceMessageId: string,
  sourceRevision: number,
): value is CommittedSourceExecutionCancellation {
  return record(value) && exact(value, [
    "sourceMessageId",
    "sourceRevision",
    "invocationIntentId",
    "executionId",
    "attemptSeq",
    "cancellationReason",
    "sideEffectState",
  ]) && value.sourceMessageId === sourceMessageId && value.sourceRevision === sourceRevision &&
    identifier(value.invocationIntentId) && identifier(value.executionId) &&
    positiveInteger(value.attemptSeq) && value.cancellationReason === "message_recalled" &&
    (value.sideEffectState === "none" || value.sideEffectState === "dispatched-retained" ||
      value.sideEffectState === "outcome-unknown-retained");
}

function validRecallReceipt(
  value: unknown,
  request: SourceRecallRequest,
): value is SourceRecallCommitReceipt {
  if (!record(value) || !exact(value, [
    "kind",
    "roomId",
    "sourceMessageId",
    "recalledRevision",
    "cancelledIntentIds",
    "executionCancellations",
    "retainedFinalMessageIds",
    "retainedFactIds",
  ]) || value.kind !== "source-recall-committed" || value.roomId !== request.roomId ||
      value.sourceMessageId !== request.sourceMessageId ||
      value.recalledRevision !== request.expectedRevision ||
      !uniqueIdentifiers(value.cancelledIntentIds) ||
      !uniqueIdentifiers(value.retainedFinalMessageIds) ||
      !uniqueIdentifiers(value.retainedFactIds) || !Array.isArray(value.executionCancellations) ||
      value.executionCancellations.length > MAX_SOURCE_EFFECTS ||
      !value.executionCancellations.every((effect) =>
        executionCancellation(effect, request.sourceMessageId, request.expectedRevision))) {
    return false;
  }
  const executionIds = value.executionCancellations.map((effect) => effect.executionId);
  return new Set(executionIds).size === executionIds.length;
}

const claimRejectionReasons = new Set([
  "intent_not_pending",
  "source_revision_stale",
  "membership_revoked",
  "assignment_inactive",
  "room_archived",
]);

function validClaimReceipt(
  value: unknown,
  request: InvocationClaimRequest,
): value is InvocationClaimCommitReceipt {
  if (!record(value) || value.sourceMessageId !== request.sourceMessageId ||
      value.invocationIntentId !== request.invocationIntentId) {
    return false;
  }
  if (value.kind === "execution-created") {
    return exact(value, [
      "kind", "sourceMessageId", "invocationIntentId", "executionId", "attemptSeq",
    ]) && identifier(value.executionId) && positiveInteger(value.attemptSeq);
  }
  if (value.kind === "source-fenced") {
    return exact(value, ["kind", "sourceMessageId", "invocationIntentId", "reason"]) &&
      value.reason === "message_recalled";
  }
  return value.kind === "claim-rejected" &&
    exact(value, ["kind", "sourceMessageId", "invocationIntentId", "reason"]) &&
    claimRejectionReasons.has(value.reason as string);
}

function validAgentMessageCommand(value: unknown): value is AgentMessageCommitCommand {
  if (!record(value) || !identifier(value.roomId) || !identifier(value.sourceMessageId) ||
      !positiveInteger(value.sourceRevision) || !identifier(value.messageId) ||
      typeof value.body !== "string" || value.body.trim().length === 0 ||
      value.body.length > MESSAGE_AUTHORITY_LIMITS.bodyUtf16) {
    return false;
  }
  if (value.kind === "final") {
    return exact(value, [
      "kind", "roomId", "sourceMessageId", "sourceRevision", "messageId", "body",
    ]);
  }
  return value.kind === "correction" && exact(value, [
    "kind", "roomId", "sourceMessageId", "sourceRevision", "messageId", "body",
    "correctsMessageId",
  ]) && identifier(value.correctsMessageId) && value.correctsMessageId !== value.messageId;
}

const agentMessageRejectionReasons = new Set<AgentMessageCommitRejectionReason>([
  "source_fenced",
  "source_revision_stale",
  "stale_attempt",
  "stale_execution_generation",
  "execution_terminal",
  "lineage_mismatch",
]);

function validAgentMessageReceipt(
  value: unknown,
  command: AgentMessageCommitCommand,
): value is AgentMessageCommitReceipt {
  if (!record(value) || value.messageKind !== command.kind ||
      value.sourceMessageId !== command.sourceMessageId) {
    return false;
  }
  if (value.kind === "agent-message-committed") {
    return exact(value, [
      "kind", "messageKind", "roomId", "sourceMessageId", "messageId",
    ]) && value.roomId === command.roomId && value.messageId === command.messageId;
  }
  return value.kind === "agent-message-rejected" && exact(value, [
    "kind", "messageKind", "sourceMessageId", "reason", "writeDisposition",
  ]) && agentMessageRejectionReasons.has(value.reason as AgentMessageCommitRejectionReason) &&
    value.writeDisposition === "zero-write";
}

function validPreview(value: unknown): value is TransientAgentPreview {
  return record(value) && exact(value, [
    "sourceMessageId", "executionId", "attemptSeq", "streamSeq", "delta",
  ]) && identifier(value.sourceMessageId) && identifier(value.executionId) &&
    positiveInteger(value.attemptSeq) && positiveInteger(value.streamSeq) &&
    typeof value.delta === "string" && value.delta.length > 0 &&
    Buffer.byteLength(value.delta, "utf8") <= MAX_PREVIEW_DELTA_BYTES;
}

function contractError(message: string): TypeError {
  return new TypeError(message);
}

function validCommittedRecallRuntimeInput(
  value: unknown,
): value is CommittedMessageRecallRuntimeInput {
  if (!record(value) || !exact(value, ["sourceMessageId", "cancellations"]) ||
      !identifier(value.sourceMessageId) || !Array.isArray(value.cancellations) ||
      value.cancellations.length > MAX_SOURCE_EFFECTS) {
    return false;
  }
  const executionIds = new Set<string>();
  for (const cancellation of value.cancellations) {
    if (!record(cancellation) || cancellation.sourceMessageId !== value.sourceMessageId ||
        !positiveInteger(cancellation.sourceRevision) ||
        !executionCancellation(
          cancellation,
          value.sourceMessageId,
          cancellation.sourceRevision,
        ) || executionIds.has(cancellation.executionId)) {
      return false;
    }
    executionIds.add(cancellation.executionId);
  }
  return true;
}

/**
 * Production composition boundary for effects that are allowed only after the
 * AuthorityWorker recall transaction resolves. It deliberately has no
 * persistence method: provider previews cannot be routed back into authority.
 */
export function createSourceScopedRuntimeBoundary(
  options: SourceScopedRuntimeBoundaryOptions,
): SourceScopedRuntimeBoundary {
  const report = (
    error: unknown,
    context: SourceScopedRuntimePostCommitErrorContext,
  ): void => {
    try {
      options.onPostCommitError?.(error, context);
    } catch {
      // Diagnostics cannot change a committed authority result or preview lifecycle.
    }
  };
  return Object.freeze({
    async coordinateRecallCommit<Receipt>(
      commit: () => Promise<Receipt>,
      selectRuntimeInput: (receipt: Receipt) => CommittedMessageRecallRuntimeInput,
    ): Promise<Receipt> {
      const receipt = await commit();
      let selected: unknown;
      try {
        selected = selectRuntimeInput(receipt);
      } catch (error: unknown) {
        report(error, { phase: "abort" });
        return receipt;
      }
      if (!validCommittedRecallRuntimeInput(selected)) {
        const sourceMessageId = record(selected) && typeof selected.sourceMessageId === "string"
          ? selected.sourceMessageId
          : undefined;
        report(
          contractError("Committed message recall runtime input was malformed"),
          sourceMessageId === undefined
            ? { phase: "abort" }
            : { phase: "abort", sourceMessageId },
        );
        return receipt;
      }
      const input = selected;
      try {
        await options.runtime?.applyCommittedMessageRecall(input);
      } catch (error: unknown) {
        report(error, {
          phase: "abort",
          sourceMessageId: input.sourceMessageId,
        });
      }
      return receipt;
    },
    publishPreview(preview: RuntimeProviderPreview): void {
      if (!record(preview) || !exact(preview, [
        "roomId", "sourceMessageId", "executionId", "attemptSeq", "streamSeq", "delta",
      ]) || !identifier(preview.roomId) || !validPreview({
        sourceMessageId: preview.sourceMessageId,
        executionId: preview.executionId,
        attemptSeq: preview.attemptSeq,
        streamSeq: preview.streamSeq,
        delta: preview.delta,
      })) {
        throw contractError("Transient Agent preview was malformed");
      }
      try {
        options.preview?.publish(preview);
      } catch (error: unknown) {
        report(error, {
          phase: "preview",
          sourceMessageId: preview.sourceMessageId,
          executionId: preview.executionId,
        });
      }
    },
  });
}

export function createSourceScopedRuntimeCoordinator(
  options: CreateSourceScopedRuntimeCoordinatorOptions,
): SourceScopedRuntimeCoordinator {
  const sourceStates = new Map<string, ActiveSourceState>();

  const report = (
    error: unknown,
    context: SourceScopedRuntimePostCommitErrorContext,
  ): void => {
    try {
      options.onPostCommitError?.(error, context);
    } catch {
      // Diagnostics cannot change a committed authority result or transient preview lifecycle.
    }
  };

  const sourceState = (sourceMessageId: string): ActiveSourceState => {
    const existing = sourceStates.get(sourceMessageId);
    if (existing !== undefined) return existing;
    const created = { activeClaims: 0, fenceCommitted: false };
    sourceStates.set(sourceMessageId, created);
    return created;
  };

  const releaseSourceState = (sourceMessageId: string, state: ActiveSourceState): void => {
    if (state.activeClaims === 0 && sourceStates.get(sourceMessageId) === state) {
      sourceStates.delete(sourceMessageId);
    }
  };

  const coordinator: SourceScopedRuntimeCoordinator = {
    async recallSource(request) {
      if (!sourceRecallRequest(request)) {
        throw contractError("Source recall request was malformed");
      }
      const receipt = await options.persistence.commitSourceRecall(request);
      if (!validRecallReceipt(receipt, request)) {
        throw contractError("Source recall authority receipt was malformed");
      }

      const state = sourceState(request.sourceMessageId);
      state.fenceCommitted = true;
      const postCommitEffects: {
        executionId: string;
        status: "applied" | "recovery-required";
      }[] = [];
      for (const effect of receipt.executionCancellations) {
        let recoveryRequired = false;
        if (options.preview !== undefined) {
          try {
            await options.preview.discardExecution({
              executionId: effect.executionId,
              reason: "message-recalled",
            });
          } catch (error: unknown) {
            recoveryRequired = true;
            report(error, {
              phase: "preview-reset",
              sourceMessageId: request.sourceMessageId,
              executionId: effect.executionId,
            });
          }
        }
        if (options.runtime === undefined) {
          recoveryRequired = true;
        } else {
          try {
            await options.runtime.abortAfterCommittedCancellation(effect);
          } catch (error: unknown) {
            recoveryRequired = true;
            report(error, {
              phase: "abort",
              sourceMessageId: request.sourceMessageId,
              executionId: effect.executionId,
            });
          }
        }
        postCommitEffects.push({
          executionId: effect.executionId,
          status: recoveryRequired ? "recovery-required" : "applied",
        });
      }
      releaseSourceState(request.sourceMessageId, state);
      return { receipt, postCommitEffects };
    },

    async claimAndCreateExecution(request) {
      if (!invocationClaimRequest(request)) {
        throw contractError("Invocation claim request was malformed");
      }
      const state = sourceState(request.sourceMessageId);
      state.activeClaims += 1;
      try {
        const receipt = await options.persistence.claimAndCreateExecution(request);
        if (!validClaimReceipt(receipt, request)) {
          throw contractError("Invocation claim authority receipt was malformed");
        }
        if (receipt.kind !== "execution-created") {
          return { receipt, runtimeHandoff: "not-applicable" as const };
        }
        if (state.fenceCommitted) {
          report(
            contractError("Authority created an execution after the source fence committed"),
            {
              phase: "enqueue",
              sourceMessageId: request.sourceMessageId,
              executionId: receipt.executionId,
            },
          );
          return { receipt, runtimeHandoff: "recovery-required" as const };
        }
        if (options.runtime === undefined) {
          return { receipt, runtimeHandoff: "recovery-required" as const };
        }
        try {
          await options.runtime.enqueueCommittedExecution({
            sourceMessageId: receipt.sourceMessageId,
            invocationIntentId: receipt.invocationIntentId,
            executionId: receipt.executionId,
            attemptSeq: receipt.attemptSeq,
          });
          return { receipt, runtimeHandoff: "scheduled" as const };
        } catch (error: unknown) {
          report(error, {
            phase: "enqueue",
            sourceMessageId: request.sourceMessageId,
            executionId: receipt.executionId,
          });
          return { receipt, runtimeHandoff: "recovery-required" as const };
        }
      } finally {
        state.activeClaims -= 1;
        releaseSourceState(request.sourceMessageId, state);
      }
    },

    async commitAgentMessage(context, command) {
      const workerContext = toAgentMessageWorkerContext(context);
      if (!validAgentMessageCommand(command)) {
        throw contractError("Agent message commit command was malformed");
      }
      const receipt = await options.persistence.commitAgentMessage({
        context: workerContext,
        command,
      });
      if (!validAgentMessageReceipt(receipt, command)) {
        throw contractError("Agent message authority receipt was malformed");
      }
      return receipt;
    },

    publishPreview(preview) {
      if (!validPreview(preview)) {
        throw contractError("Transient Agent preview was malformed");
      }
      try {
        options.preview?.publish(preview);
      } catch (error: unknown) {
        report(error, {
          phase: "preview",
          sourceMessageId: preview.sourceMessageId,
          executionId: preview.executionId,
        });
      }
    },

    discardTransientPreviews(reason) {
      if (reason !== "runtime-crash" && reason !== "client-reconnect") {
        throw contractError("Transient Agent preview reset reason was malformed");
      }
      try {
        options.preview?.discardAll({ reason });
      } catch (error: unknown) {
        report(error, { phase: "preview" });
      }
    },
  };
  return Object.freeze(coordinator);
}
