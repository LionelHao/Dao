import { randomUUID } from "node:crypto";
import { isAgentExecution, type AgentExecution } from "@native-im/core";
import type { AuthenticatedCommandContext, InternalAgentCommandContext } from "../persistence/contracts.js";
import { toAgentWorkerCommandContext } from "../persistence/contracts.js";
import {
  AuthorityWorkerClientError,
  type WorkerDatabaseClient,
} from "../persistence/worker-database-client.js";
import {
  AgentRuntimeError,
  type AgentRuntimeErrorCode,
  type InvocationAccepted,
  type RuntimeAuthority,
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

function invocationResult(value: unknown): InvocationAccepted {
  if (!record(value) || value.kind !== "invocation" || typeof value.replayed !== "boolean" || !isAgentExecution(value.execution)) {
    throw new AgentRuntimeError("provider_failure", "Authority invocation result was malformed");
  }
  return { execution: value.execution, replayed: value.replayed };
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
      (value.toolId !== "http-json.read" && value.toolId !== "repository.git-status" && value.toolId !== "sandbox-file.write") ||
      !record(value.parameters)) {
    throw new AgentRuntimeError("provider_failure", "Authority claimed-tool result was malformed");
  }
  return value as unknown as ReturnType<RuntimeAuthority["claimTool"]> extends Promise<infer Result> ? Result : never;
}

function pendingConfirmationResult(value: unknown): Awaited<ReturnType<RuntimeAuthority["readPendingConfirmation"]>> {
  if (!record(value) || value.kind !== "pending-confirmation" || !isAgentExecution(value.execution) ||
      typeof value.grantId !== "string" ||
      (value.toolId !== "http-json.read" && value.toolId !== "repository.git-status" && value.toolId !== "sandbox-file.write") ||
      !record(value.parameters) || typeof value.callId !== "string" || typeof value.argumentsJson !== "string") {
    throw new AgentRuntimeError("provider_failure", "Authority pending confirmation result was malformed");
  }
  return value as unknown as Awaited<ReturnType<RuntimeAuthority["readPendingConfirmation"]>>;
}

export function createWorkerRuntimeAuthority(worker: WorkerDatabaseClient): RuntimeAuthority {
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
      if (!record(result) || result.kind !== "context" || !Array.isArray(result.visibleConversation) ||
          !result.visibleConversation.every((message) => record(message) &&
            typeof message.messageId === "string" && typeof message.authorId === "string" && typeof message.body === "string") ||
          !Array.isArray(result.toolIds) || !result.toolIds.every((toolId) =>
            toolId === "http-json.read" || toolId === "repository.git-status" || toolId === "sandbox-file.write")) {
        throw new AgentRuntimeError("provider_failure", "Authority runtime context was malformed");
      }
      return result as unknown as Awaited<ReturnType<RuntimeAuthority["readContext"]>>;
    },
    async invoke(context, intent, providerId, modelId) {
      const wireContext = context.kind === "human" ? context : toAgentWorkerCommandContext(context);
      return invocationResult(await execute({
        type: "runtime.invoke",
        context: wireContext,
        intent,
        executionId: `execution-${randomUUID()}`,
        intentId: `intent-${randomUUID()}`,
        providerId,
        modelId,
        now: Date.now(),
      }));
    },
    async invokeRouted(routeJobId, intent, providerId, modelId) {
      return invocationResult(await execute({
        type: "runtime.invoke-routed",
        routeJobId,
        intent,
        executionId: `execution-${randomUUID()}`,
        intentId: `intent-${randomUUID()}`,
        providerId,
        modelId,
        now: Date.now(),
      }));
    },
    async claim(executionId, attemptSeq) {
      return executionResult(await execute({ type: "runtime.claim", executionId, attemptSeq, now: Date.now() }));
    },
    async complete(executionId, attemptSeq, body) {
      return executionResult(await execute({
        type: "runtime.complete",
        executionId,
        attemptSeq,
        messageId: `message-agent-${randomUUID()}`,
        body,
        now: Date.now(),
      }));
    },
    async scheduleRetry(executionId, attemptSeq, errorCode, nextRetryAt) {
      return executionResult(await execute({
        type: "runtime.schedule-retry",
        executionId,
        attemptSeq,
        errorCode,
        ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
        now: Date.now(),
      }));
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
    async retry(context: AuthenticatedCommandContext, executionId) {
      return invocationResult(await execute({
        type: "runtime.manual-retry",
        context,
        executionId,
        newExecutionId: `execution-${randomUUID()}`,
        newIntentId: `intent-${randomUUID()}`,
        now: Date.now(),
      }));
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
            (entry.outcome === "enqueue" || entry.outcome === "failed" || entry.outcome === "fail_outcome_unknown" || entry.outcome === "wait_confirmation"))) {
        throw new AgentRuntimeError("provider_failure", "Authority recovery result was malformed");
      }
      return result.records as ReturnType<RuntimeAuthority["recover"]> extends Promise<infer Records> ? Records : never;
    },
    async prepareTool(executionId, attemptSeq, tool, parameters, confirmationContext, providerCall) {
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
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
    async claimTool(executionId, attemptSeq, grantId, parameters, confirmation) {
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

export type WorkerRuntimeAuthorityContext = AuthenticatedCommandContext | InternalAgentCommandContext;
