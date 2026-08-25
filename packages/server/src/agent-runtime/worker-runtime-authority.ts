import { createHash, randomUUID } from "node:crypto";
import {
  isLegacyAgentExecution as isAgentExecution,
  isRoomMemoryProjection,
  isRoomMemoryRawDeltaPage,
  isRoomMemoryStatus,
  isAgentExecutionRetryReceipt,
  isScopedCancellationReceipt,
  type LegacyAgentExecution as AgentExecution,
  type LegacyAgentInvocationIntent as AgentInvocationIntent,
} from "@native-im/core";
import type { AuthenticatedCommandContext, InternalAgentCommandContext } from "../persistence/contracts.js";
import { toAgentWorkerCommandContext } from "../persistence/contracts.js";
import {
  AuthorityWorkerClientError,
  type WorkerDatabaseClient,
} from "../persistence/worker-database-client.js";
import type { ContextAuthorityWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type { ScopedCancellationCommitReceipt } from "../scoped-cancellation/scoped-cancellation-orchestrator.js";
import { canonicalJsonV1 } from "../context-compiler/canonical-json.js";
import {
  AgentRuntimeError,
  type AgentRuntimeErrorCode,
  type InvocationAcceptedWithIntent,
  type RuntimeAuthority,
  type RuntimeRecoveryAuthority,
} from "./contracts.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mappedError(error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) return error;
  if (error instanceof AuthorityWorkerClientError) {
    const mapping: Partial<Record<AuthorityWorkerClientError["code"], AgentRuntimeErrorCode>> = {
      agent_queue_full: "agent_queue_full",
      execution_conflict: "execution_conflict",
      execution_not_found: "execution_not_found",
      invalid_parameters: "invalid_parameters",
      permission_denied: "permission_denied",
      room_forbidden: "permission_denied",
      message_not_found: "execution_not_found",
      confirmation_expired: "confirmation_expired",
      confirmation_forbidden: "confirmation_forbidden",
      confirmation_replayed: "confirmation_replayed",
      context_capacity_limited: "context_capacity_limited",
      context_forbidden: "context_forbidden",
      context_generation_conflict: "context_generation_conflict",
      context_snapshot_conflict: "context_snapshot_conflict",
      context_snapshot_invalidated: "context_snapshot_invalidated",
      context_source_gone: "context_source_gone",
      context_storage_unavailable: "context_storage_unavailable",
    };
    return new AgentRuntimeError(
      mapping[error.code] ?? "provider_failure",
      `Authority runtime operation failed (${error.code})`,
      error.retryAfterMs,
    );
  }
  return new AgentRuntimeError("provider_failure", "Authority runtime operation failed");
}

function executionResult(value: unknown): AgentExecution {
  if (!record(value) || value.kind !== "execution" || !isAgentExecution(value.execution)) {
    throw new AgentRuntimeError("provider_failure", "Authority runtime result was malformed");
  }
  return value.execution;
}

function invocationIntent(value: unknown): value is AgentInvocationIntent {
  return record(value) &&
    (value.kind === "direct_mention" || value.kind === "structured_help" ||
      value.kind === "routed_candidate") &&
    typeof value.roomId === "string" && typeof value.sourceMessageId === "string" &&
    typeof value.targetAgentId === "string";
}

function invocationResult(
  value: unknown,
  expectedRetry?: Readonly<{
    requestId: string;
    sourceExecutionId: string;
    receiptRequired: boolean;
  }>,
): InvocationAcceptedWithIntent {
  if (!record(value) || value.kind !== "invocation" || typeof value.replayed !== "boolean" ||
      !isAgentExecution(value.execution) || !invocationIntent(value.intent) ||
      value.intent.roomId !== value.execution.roomId ||
      value.intent.sourceMessageId !== value.execution.sourceMessageId ||
      value.intent.targetAgentId !== value.execution.agentId) {
    throw new AgentRuntimeError("provider_failure", "Authority invocation result was malformed");
  }
  if (value.retryReceipt !== undefined && !isAgentExecutionRetryReceipt(value.retryReceipt)) {
    throw new AgentRuntimeError("provider_failure", "Authority retry receipt was malformed");
  }
  if (expectedRetry !== undefined &&
      ((expectedRetry.receiptRequired && value.retryReceipt === undefined) ||
       (value.retryReceipt !== undefined &&
        (value.retryReceipt.requestId !== expectedRetry.requestId ||
         value.retryReceipt.sourceExecutionId !== expectedRetry.sourceExecutionId ||
         value.retryReceipt.executionId !== value.execution.id ||
         value.retryReceipt.roomId !== value.execution.roomId ||
         value.retryReceipt.createdAt !== value.execution.queuedAt ||
         value.execution.manualRetryOfExecutionId !== expectedRetry.sourceExecutionId)))) {
    throw new AgentRuntimeError("provider_failure", "Authority retry receipt binding was malformed");
  }
  return {
    execution: value.execution,
    intent: value.intent,
    replayed: value.replayed,
    ...(value.retryReceipt === undefined ? {} : { retryReceipt: value.retryReceipt }),
  };
}

function fenceReplacementResult(
  value: unknown,
): Awaited<ReturnType<RuntimeAuthority["enqueueFenceReplacements"]>> {
  if (!record(value) || value.kind !== "human-fence-replacements" ||
      !Array.isArray(value.executions) || !value.executions.every(isAgentExecution) ||
      typeof value.replayed !== "boolean") {
    throw new AgentRuntimeError("provider_failure", "Authority fence replacement result was malformed");
  }
  return { executions: value.executions, replayed: value.replayed };
}

function scopedCancellationResult(value: unknown): ScopedCancellationCommitReceipt {
  if (!record(value) || value.kind !== "scoped-cancellation-committed" ||
      typeof value.fenceId !== "string" || typeof value.roomId !== "string" ||
      typeof value.producerId !== "string" || value.reason !== "human_cancelled" ||
      typeof value.replayed !== "boolean" || !isScopedCancellationReceipt(value.receipt) ||
      value.receipt.fenceId !== value.fenceId || value.receipt.roomId !== value.roomId ||
      value.receipt.requestId !== value.producerId || !Array.isArray(value.effects) ||
      !value.effects.every((effect) => record(effect) &&
        typeof effect.sourceMessageId === "string" &&
        typeof effect.sourceRevision === "number" &&
        typeof effect.invocationIntentId === "string" &&
        ((effect.disposition === "intent_cancelled" && effect.executionId === undefined &&
          effect.attemptSeq === undefined) ||
         ((effect.disposition === "execution_cancelled" || effect.disposition === "already_terminal") &&
          typeof effect.executionId === "string" && typeof effect.attemptSeq === "number")) &&
        (effect.confirmationDisposition === "none" ||
          effect.confirmationDisposition === "pending_rejected" ||
          effect.confirmationDisposition === "confirmed_retained") &&
        (effect.grantDisposition === "none" || effect.grantDisposition === "unclaimed_revoked" ||
          effect.grantDisposition === "claimed_retained") &&
        (effect.sideEffectState === "none" || effect.sideEffectState === "dispatched-retained" ||
          effect.sideEffectState === "outcome-unknown-retained"))) {
    throw new AgentRuntimeError("provider_failure", "Authority cancellation receipt was malformed");
  }
  return value as unknown as ScopedCancellationCommitReceipt;
}

function preparedToolResult(value: unknown): ReturnType<RuntimeAuthority["prepareTool"]> extends Promise<infer Result> ? Result : never {
  if (!record(value) || value.kind !== "prepared-tool" || !isAgentExecution(value.execution) ||
      typeof value.grantId !== "string" ||
      (value.confirmationId !== undefined && typeof value.confirmationId !== "string")) {
    throw new AgentRuntimeError("provider_failure", "Authority prepared-tool result was malformed");
  }
  return value as unknown as ReturnType<RuntimeAuthority["prepareTool"]> extends Promise<infer Result> ? Result : never;
}

function claimedToolResult(value: unknown): ReturnType<RuntimeAuthority["claimTool"]> extends Promise<infer Result> ? Result : never {
  if (!record(value) || value.kind !== "claimed-tool" || typeof value.dispatchId !== "string" ||
      (value.toolId !== "http-json.read" && value.toolId !== "repository.git-status" &&
       value.toolId !== "sandbox-file.write" && value.toolId !== "room-memory.read") ||
      !record(value.parameters)) {
    throw new AgentRuntimeError("provider_failure", "Authority claimed-tool result was malformed");
  }
  return value as unknown as ReturnType<RuntimeAuthority["claimTool"]> extends Promise<infer Result> ? Result : never;
}

function pendingConfirmationResult(value: unknown): Awaited<ReturnType<RuntimeAuthority["readPendingConfirmation"]>> {
  if (!record(value) || value.kind !== "pending-confirmation" || !isAgentExecution(value.execution) ||
      !invocationIntent(value.intent) || value.intent.roomId !== value.execution.roomId ||
      value.intent.sourceMessageId !== value.execution.sourceMessageId ||
      value.intent.targetAgentId !== value.execution.agentId ||
      typeof value.grantId !== "string" ||
      (value.toolId !== "http-json.read" && value.toolId !== "repository.git-status" && value.toolId !== "sandbox-file.write") ||
      !record(value.parameters) || typeof value.callId !== "string" || typeof value.argumentsJson !== "string") {
    throw new AgentRuntimeError("provider_failure", "Authority pending confirmation result was malformed");
  }
  return value as unknown as Awaited<ReturnType<RuntimeAuthority["readPendingConfirmation"]>>;
}

export function createWorkerRuntimeAuthority(
  worker: WorkerDatabaseClient,
  options: Readonly<{ contextWorker?: ContextAuthorityWorkerDatabaseClient }> = {},
): RuntimeAuthority {
  const executions = new Map<string, AgentExecution>();
  const sourceGrants = new Map<string, Readonly<{
    executionId: string;
    attemptSeq: number;
    parameterSha256: string;
  }>>();
  const sourceDispatches = new Set<string>();
  const remember = (execution: AgentExecution): AgentExecution => {
    executions.set(execution.id, execution);
    return execution;
  };
  const contextExecute = async (
    operation: Parameters<ContextAuthorityWorkerDatabaseClient["executeContext"]>[0],
  ): Promise<unknown> => {
    if (options.contextWorker === undefined) {
      throw new AgentRuntimeError("provider_failure", "Context authority was unavailable");
    }
    try {
      return await options.contextWorker.executeContext(operation);
    } catch (error: unknown) {
      throw mappedError(error);
    }
  };
  const execute = async (operation: Parameters<WorkerDatabaseClient["executeRuntime"]>[0]): Promise<unknown> => {
    try {
      return await worker.executeRuntime(operation);
    } catch (error: unknown) {
      throw mappedError(error);
    }
  };
  const authority: RuntimeAuthority = {
    async readContext(executionId) {
      const result = await execute({ type: "runtime.read-context", executionId, now: Date.now() });
      const roomMemory = record(result) && record(result.roomMemory) ? result.roomMemory : undefined;
      const memoryStatus = roomMemory === undefined ? undefined : roomMemory.status;
      if (!record(result) || result.kind !== "context" || !Array.isArray(result.visibleConversation) ||
          !result.visibleConversation.every((message) => record(message) &&
            typeof message.messageId === "string" && typeof message.authorId === "string" && typeof message.body === "string") ||
          !Array.isArray(result.toolIds) || !result.toolIds.every((toolId) =>
            toolId === "http-json.read" || toolId === "repository.git-status" || toolId === "sandbox-file.write") ||
          !Array.isArray(result.openItemTargets) || !result.openItemTargets.every((target) =>
            record(target) && typeof target.actorId === "string" &&
            (target.kind === "human" || target.kind === "agent")) ||
          roomMemory === undefined || !isRoomMemoryStatus(memoryStatus) ||
          !Array.isArray(roomMemory.injectableSnapshot) ||
          !roomMemory.injectableSnapshot.every((projection) =>
            isRoomMemoryProjection(projection) && projection.roomId === memoryStatus.roomId) ||
          !isRoomMemoryRawDeltaPage(roomMemory.rawDelta) ||
          roomMemory.rawDelta.roomId !== memoryStatus.roomId) {
        throw new AgentRuntimeError("provider_failure", "Authority runtime context was malformed");
      }
      return result as unknown as Awaited<ReturnType<RuntimeAuthority["readContext"]>>;
    },
    async readMemoryDelta(executionId, cursor) {
      const result = await execute({
        type: "runtime.read-memory-delta",
        executionId,
        cursor,
        now: Date.now(),
      });
      if (!record(result) || result.kind !== "memory-delta" ||
          !isRoomMemoryRawDeltaPage(result.rawDelta)) {
        throw new AgentRuntimeError("provider_failure", "Authority memory delta result was malformed");
      }
      return result.rawDelta;
    },
    async invoke(context, intent, providerId, modelId) {
      const wireContext = context.kind === "human" ? context : toAgentWorkerCommandContext(context);
      const result = invocationResult(await execute({
        type: "runtime.invoke",
        context: wireContext,
        intent,
        executionId: `execution-${randomUUID()}`,
        intentId: `intent-${randomUUID()}`,
        providerId,
        modelId,
        now: Date.now(),
      }));
      remember(result.execution);
      return result;
    },
    async invokeRouted(routeJobId, intent, providerId, modelId) {
      const result = invocationResult(await execute({
        type: "runtime.invoke-routed",
        routeJobId,
        intent,
        executionId: `execution-${randomUUID()}`,
        intentId: `intent-${randomUUID()}`,
        providerId,
        modelId,
        now: Date.now(),
      }));
      remember(result.execution);
      return result;
    },
    async enqueueFenceReplacements(routeJobId, targetAgentId, providerId, modelId) {
      const result = fenceReplacementResult(await execute({
        type: "runtime.enqueue-fence-replacements",
        routeJobId,
        targetAgentId,
        providerId,
        modelId,
        now: Date.now(),
      }));
      for (const execution of result.executions) remember(execution);
      return result;
    },
    async claim(executionId, attemptSeq) {
      return remember(executionResult(await execute({
        type: "runtime.claim", executionId, attemptSeq, now: Date.now(),
      })));
    },
    async complete(executionId, attemptSeq, body, citationLabels = []) {
      const currentExecution = executions.get(executionId);
      if (options.contextWorker !== undefined && currentExecution?.actionCategory === "model_generation") {
        const prepared = await contextExecute({
          type: "context.prepare", executionId, attemptSeq, now: Date.now(),
        });
        if (!record(prepared) || prepared.kind !== "context-preparation" ||
            !record(prepared.preparation) || !record(prepared.snapshot) ||
            typeof prepared.preparation.executionGeneration !== "number" ||
            typeof prepared.preparation.invocationIntentId !== "string" ||
            typeof prepared.preparation.agentId !== "string" ||
            typeof prepared.preparation.roomId !== "string" ||
            typeof prepared.snapshot.snapshotId !== "string" ||
            typeof prepared.snapshot.snapshotGeneration !== "number") {
          throw new AgentRuntimeError("provider_failure", "Context finalization facts were malformed");
        }
        const result = await contextExecute({
          type: "context.finalize-agent-message",
          context: {
            kind: "agent-message",
            agent: { actorId: prepared.preparation.agentId, kind: "agent" },
            invocationIntentId: prepared.preparation.invocationIntentId,
            executionId,
            attemptSeq,
            executionGeneration: prepared.preparation.executionGeneration,
          },
          command: {
            messageId: `message-agent-${randomUUID()}`,
            roomId: prepared.preparation.roomId,
            body,
          },
          snapshotId: prepared.snapshot.snapshotId,
          snapshotGeneration: prepared.snapshot.snapshotGeneration,
          citationLabels,
          now: Date.now(),
        });
        if (!record(result) || result.kind !== "context-finalized" ||
            !isAgentExecution(result.execution)) {
          throw new AgentRuntimeError("provider_failure", "Context finalization result was malformed");
        }
        return remember(result.execution);
      }
      return remember(executionResult(await execute({
        type: "runtime.complete",
        executionId,
        attemptSeq,
        messageId: `message-agent-${randomUUID()}`,
        body,
        now: Date.now(),
      })));
    },
    async scheduleRetry(executionId, attemptSeq, errorCode, nextRetryAt) {
      return remember(executionResult(await execute({
        type: "runtime.schedule-retry",
        executionId,
        attemptSeq,
        errorCode,
        ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
        now: Date.now(),
      })));
    },
    async shutdown(executionId, attemptSeq) {
      return remember(executionResult(await execute({
        type: "runtime.shutdown",
        executionId,
        attemptSeq,
        now: Date.now(),
      })));
    },
    async interrupt(context: AuthenticatedCommandContext, executionId, reason) {
      return executionResult(await execute({
        type: "runtime.interrupt",
        context,
        executionId,
        reason,
        now: Date.now(),
      }));
    },
    async cancelScoped(context, target, producerId) {
      return scopedCancellationResult(await execute({
        type: "runtime.cancel-scoped",
        context,
        target,
        producerId,
        now: Date.now(),
      }));
    },
    async retry(context: AuthenticatedCommandContext, executionId, expectedVersion) {
      const result = invocationResult(await execute({
        type: "runtime.manual-retry",
        context,
        executionId,
        newExecutionId: `execution-${randomUUID()}`,
        newIntentId: `intent-${randomUUID()}`,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        now: Date.now(),
      }), {
        requestId: context.requestId,
        sourceExecutionId: executionId,
        receiptRequired: expectedVersion !== undefined,
      });
      remember(result.execution);
      return result;
    },
    async beginCompensation(context, executionId) {
      const result = await execute({
        type: "runtime.begin-compensation",
        context,
        executionId,
        newExecutionId: `execution-${randomUUID()}`,
        grantId: `grant-${randomUUID()}`,
        dispatchId: `dispatch-${randomUUID()}`,
        now: Date.now(),
      });
      if (!record(result) || result.kind !== "compensation" || !isAgentExecution(result.execution) ||
          typeof result.dispatchId !== "string" || result.toolId !== "sandbox-file.write" ||
          typeof result.sealedCompensation !== "string" || typeof result.replayed !== "boolean") {
        throw new AgentRuntimeError("provider_failure", "Authority compensation result was malformed");
      }
      return result as unknown as Awaited<ReturnType<RuntimeAuthority["beginCompensation"]>>;
    },
    async recover() {
      const result = await execute({ type: "runtime.recover", now: Date.now() });
      if (!record(result) || result.kind !== "recovery" || !Array.isArray(result.records) ||
          !result.records.every((entry) => record(entry) && isAgentExecution(entry.execution) &&
            invocationIntent(entry.intent) && entry.intent.roomId === entry.execution.roomId &&
            entry.intent.sourceMessageId === entry.execution.sourceMessageId &&
            entry.intent.targetAgentId === entry.execution.agentId &&
            (entry.outcome === "enqueue" || entry.outcome === "failed" || entry.outcome === "fail_outcome_unknown" || entry.outcome === "wait_confirmation"))) {
        throw new AgentRuntimeError("provider_failure", "Authority recovery result was malformed");
      }
      for (const entry of result.records) remember(entry.execution as AgentExecution);
      return result.records as ReturnType<RuntimeAuthority["recover"]> extends Promise<infer Records> ? Records : never;
    },
    async prepareTool(executionId, attemptSeq, tool, parameters, confirmationContext, providerCall) {
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      if (tool.id === "room-memory.read") {
        const execution = executions.get(executionId);
        if (execution === undefined || execution.currentAttemptSeq !== attemptSeq ||
            execution.status !== "running" || providerCall === undefined) {
          throw new AgentRuntimeError("execution_conflict", "Source read execution was not current");
        }
        const prepared = await contextExecute({
          type: "context.prepare", executionId, attemptSeq, now: Date.now(),
        });
        if (!record(prepared) || prepared.kind !== "context-preparation" ||
            !record(prepared.snapshot) || typeof prepared.snapshot.snapshotGeneration !== "number") {
          throw new AgentRuntimeError("provider_failure", "Source read snapshot was unavailable");
        }
        const grantId = `context-grant-${randomUUID()}`;
        const parameterSha256 = createHash("sha256")
          .update(canonicalJsonV1(parameters), "utf8").digest("hex");
        const granted = await contextExecute({
          type: "context.source-read-grant",
          grantId,
          executionId,
          attemptSeq,
          expectedSnapshotGeneration: prepared.snapshot.snapshotGeneration,
          parameterSha256,
          expiresAt,
          now: Date.now(),
        });
        if (!record(granted) || granted.kind !== "context-source-read-grant" ||
            granted.grantId !== grantId) {
          throw new AgentRuntimeError("provider_failure", "Source read grant was malformed");
        }
        sourceGrants.set(grantId, { executionId, attemptSeq, parameterSha256 });
        return { execution, grantId };
      }
      return preparedToolResult(await execute({
        type: "runtime.prepare-tool",
        executionId,
        attemptSeq,
        tool,
        parameters,
        grantId: `grant-${randomUUID()}`,
        ...(tool.effect === "side-effecting" ? {
          confirmationId: `confirmation-${randomUUID()}`,
          ...(confirmationContext === undefined ? {} : { confirmationContext }),
        } : {}),
        ...(providerCall === undefined ? {} : { providerCall }),
        expiresAt,
        now: Date.now(),
      }));
    },
    async readPendingConfirmation(confirmationId, executionId) {
      return pendingConfirmationResult(await execute({
        type: "runtime.read-pending-confirmation",
        confirmationId,
        executionId,
        now: Date.now(),
      }));
    },
    async claimTool(executionId, attemptSeq, grantId, parameters, confirmation, providerCall) {
      const sourceGrant = sourceGrants.get(grantId);
      if (sourceGrant !== undefined) {
        try {
          if (sourceGrant.executionId !== executionId || sourceGrant.attemptSeq !== attemptSeq ||
              providerCall === undefined || createHash("sha256")
                .update(canonicalJsonV1(parameters), "utf8").digest("hex") !==
                sourceGrant.parameterSha256) {
            throw new AgentRuntimeError("execution_conflict", "Source read dispatch changed its grant");
          }
          const dispatchId = `context-dispatch-${randomUUID()}`;
          const dispatched = await contextExecute({
            type: "context.source-read-dispatch",
            grantId,
            dispatchId,
            executionId,
            attemptSeq,
            callId: providerCall.callId,
            parameterSha256: sourceGrant.parameterSha256,
            now: Date.now(),
          });
          if (!record(dispatched) || dispatched.kind !== "context-source-read-dispatch" ||
              dispatched.dispatchId !== dispatchId) {
            throw new AgentRuntimeError("provider_failure", "Source read dispatch was malformed");
          }
          sourceDispatches.add(dispatchId);
          return { dispatchId, toolId: "room-memory.read", parameters };
        } finally {
          sourceGrants.delete(grantId);
        }
      }
      return claimedToolResult(await execute({
        type: "runtime.claim-tool",
        executionId,
        attemptSeq,
        grantId,
        dispatchId: `dispatch-${randomUUID()}`,
        parameters,
        ...(confirmation === undefined ? {} : { confirmation }),
        now: Date.now(),
      }));
    },
    async settleTool(dispatchId, state, summary, compensationToken) {
      if (sourceDispatches.delete(dispatchId)) return;
      const result = await execute({
        type: "runtime.settle-tool",
        dispatchId,
        state,
        summary,
        ...(compensationToken === undefined ? {} : { sealedCompensation: compensationToken }),
        now: Date.now(),
      });
      if (!record(result) || result.kind !== "settled-tool") {
        throw new AgentRuntimeError("provider_failure", "Authority tool settlement was malformed");
      }
    },
    async checkpoint(executionId, attemptSeq, stepSeq, kind, inputSha256, outputSha256) {
      const result = await execute({
        type: "runtime.checkpoint",
        executionId,
        attemptSeq,
        stepSeq,
        kind,
        inputSha256,
        outputSha256,
        now: Date.now(),
      });
      if (!record(result) || result.kind !== "checkpoint") {
        throw new AgentRuntimeError("provider_failure", "Authority checkpoint result was malformed");
      }
    },
  };
  return Object.freeze(authority);
}

/**
 * Production durable recovery adapter. A process's first complete generation
 * also fences stale running attempts left by a crash. Later generations are
 * deliberately queued-only so a post-commit rescan can be triggered at any
 * time without treating this process's live attempts as crashed.
 */
export function createWorkerRuntimeRecoveryAuthority(
  worker: WorkerDatabaseClient,
): RuntimeRecoveryAuthority {
  const leaseOwner = `invocation-runtime:${randomUUID()}`;
  const leaseDurationMs = 5 * 60_000;
  let completedGenerations = 0;
  let includeRunningForGeneration = true;
  const execute = async (
    operation: Parameters<WorkerDatabaseClient["executeRuntime"]>[0],
  ): Promise<unknown> => {
    try {
      return await worker.executeRuntime(operation);
    } catch (error: unknown) {
      throw mappedError(error);
    }
  };
  const recoveryAuthority: RuntimeRecoveryAuthority = {
    async scan({ after, limit }) {
      if (after === undefined) {
        includeRunningForGeneration = completedGenerations === 0;
      }
      const now = Date.now();
      const result = await execute({
        type: "runtime.recovery-scan",
        ...(after === undefined ? {} : { after }),
        limit,
        includeRunning: includeRunningForGeneration,
        leaseOwner,
        leaseExpiresAt: new Date(now + leaseDurationMs).toISOString(),
        now,
      });
      if (!record(result) || result.kind !== "recovery-page" ||
          typeof result.hasMore !== "boolean" || !Array.isArray(result.candidates) ||
          !result.candidates.every((candidate) => record(candidate) &&
            typeof candidate.cursor === "string" && candidate.cursor.length > 0 &&
            Object.hasOwn(candidate, "record"))) {
        throw new AgentRuntimeError("provider_failure", "Authority recovery page was malformed");
      }
      if (result.candidates.length === 0) completedGenerations += 1;
      return result as Awaited<ReturnType<RuntimeRecoveryAuthority["scan"]>>;
    },
    async isolate({ cursor, candidateId, reason }) {
      const result = await execute({
        type: "runtime.recovery-isolate",
        cursor,
        ...(candidateId === undefined ? {} : { candidateId }),
        leaseOwner,
        reason,
        now: Date.now(),
      });
      if (!record(result) || result.kind !== "recovery-isolated") {
        throw new AgentRuntimeError("provider_failure", "Authority recovery isolation was malformed");
      }
    },
    async settle({ cursor, candidateId }) {
      const result = await execute({
        type: "runtime.recovery-settle",
        cursor,
        candidateId,
        leaseOwner,
        now: Date.now(),
      });
      if (!record(result) || result.kind !== "recovery-settled") {
        throw new AgentRuntimeError("provider_failure", "Authority recovery settlement was malformed");
      }
    },
    async release() {
      const result = await execute({
        type: "runtime.recovery-release",
        leaseOwner,
        now: Date.now(),
      });
      if (!record(result) || result.kind !== "recovery-released" ||
          typeof result.released !== "number" || !Number.isSafeInteger(result.released) ||
          result.released < 0) {
        throw new AgentRuntimeError("provider_failure", "Authority recovery release was malformed");
      }
      return result.released;
    },
  };
  return Object.freeze(recoveryAuthority);
}

export type WorkerRuntimeAuthorityContext = AuthenticatedCommandContext | InternalAgentCommandContext;
