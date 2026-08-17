import { createHash } from "node:crypto";
import type {
  AgentExecution,
  AgentInvocationIntent,
  AgentRuntimeProviderInput,
  ToolConfirmationInput,
  ToolDescriptor,
} from "@native-im/core";
import type { AuthenticatedCommandContext, InternalAgentCommandContext } from "../persistence/contracts.js";
import {
  AGENT_RUNTIME_MAX_ACTIVE,
  AGENT_RUNTIME_MAX_ATTEMPTS,
  AGENT_RUNTIME_MAX_QUEUED_PER_ROOM,
  AGENT_RUNTIME_RETRY_DELAYS_MS,
  AgentRuntimeError,
  type AgentRuntime,
  type InvocationAccepted,
  type ProviderAdapter,
  type RuntimeAuthority,
  type RuntimeClock,
  type ToolAdapter,
} from "./contracts.js";
import type { ToolGateway } from "./tool-gateway.js";

interface RuntimeLimits {
  readonly maxActive: number;
  readonly maxQueuedPerRoom: number;
  readonly maxPartialBytes: number;
}

interface AgentRuntimeServiceOptions {
  readonly authority: RuntimeAuthority;
  readonly provider: ProviderAdapter;
  readonly modelId: string;
  readonly buildProviderInput: (
    execution: AgentExecution,
    intent: AgentInvocationIntent,
    context: AuthenticatedCommandContext | InternalAgentCommandContext | undefined,
  ) => Promise<AgentRuntimeProviderInput>;
  readonly readiness?: () => "ready" | "noauth";
  readonly tools?: readonly ToolDescriptor[];
  readonly toolGateway?: ToolGateway;
  readonly toolAdapters?: readonly ToolAdapter[];
  readonly clock?: RuntimeClock;
  readonly limits?: RuntimeLimits;
  readonly emitPreview?: (preview: {
    readonly roomId: string;
    readonly executionId: string;
    readonly attemptSeq: number;
    readonly streamSeq: number;
    readonly delta: string;
  }) => void;
  readonly onMessageCommitted?: (execution: AgentExecution) => void;
}

interface RuntimeJob {
  execution: AgentExecution;
  readonly intent: AgentInvocationIntent;
  readonly context: AuthenticatedCommandContext | InternalAgentCommandContext | undefined;
  readonly toolContinuations: {
    callId: string;
    toolId: ToolDescriptor["id"];
    argumentsJson: string;
    modelInput: string;
  }[];
  sideEffectDispatched: boolean;
}

export interface AgentRuntimeService extends AgentRuntime {
  invokeRouted(routeJobId: string, intent: AgentInvocationIntent): Promise<InvocationAccepted>;
  whenIdle(): Promise<void>;
  recover(): Promise<void>;
}

const productionClock: RuntimeClock = {
  now: () => Date.now(),
  wait(milliseconds, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new AgentRuntimeError("provider_timeout", "Runtime wait was cancelled"));
        return;
      }
      const timeout = setTimeout(resolve, milliseconds);
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new AgentRuntimeError("provider_timeout", "Runtime wait was cancelled"));
      }, { once: true });
    });
  },
};

function validateLimits(limits: RuntimeLimits): void {
  if (!Number.isSafeInteger(limits.maxActive) || limits.maxActive < 1 || limits.maxActive > AGENT_RUNTIME_MAX_ACTIVE ||
      !Number.isSafeInteger(limits.maxQueuedPerRoom) || limits.maxQueuedPerRoom < 1 || limits.maxQueuedPerRoom > AGENT_RUNTIME_MAX_QUEUED_PER_ROOM ||
      !Number.isSafeInteger(limits.maxPartialBytes) || limits.maxPartialBytes < 256 || limits.maxPartialBytes > 1_048_576) {
    throw new TypeError("Agent runtime limits were invalid");
  }
}

function transient(code: AgentRuntimeError["code"]): boolean {
  return code === "provider_rate_limited" || code === "provider_timeout" ||
    code === "provider_unavailable" || code === "tool_target_busy";
}

export function createAgentRuntimeService(options: AgentRuntimeServiceOptions): AgentRuntimeService {
  if (options.modelId.trim().length === 0) throw new TypeError("Agent runtime modelId must be non-empty");
  const limits = options.limits ?? {
    maxActive: AGENT_RUNTIME_MAX_ACTIVE,
    maxQueuedPerRoom: AGENT_RUNTIME_MAX_QUEUED_PER_ROOM,
    maxPartialBytes: 64 * 1_024,
  };
  validateLimits(limits);
  const clock = options.clock ?? productionClock;
  const queues = new Map<string, RuntimeJob[]>();
  const activeRooms = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const jobsByExecution = new Map<string, RuntimeJob>();
  const pendingConfirmations = new Map<string, {
    readonly job: RuntimeJob;
    readonly grantId: string;
    readonly callId: string;
    readonly tool: ToolDescriptor;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly argumentsJson: string;
  }>();
  const idleWaiters = new Set<() => void>();
  let active = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const isIdle = (): boolean => active === 0 && [...queues.values()].every((queue) => queue.length === 0);
  const signalIdle = (): void => {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const enqueue = (job: RuntimeJob): void => {
    const queue = queues.get(job.execution.roomId) ?? [];
    if (queue.length >= limits.maxQueuedPerRoom) {
      throw new AgentRuntimeError("agent_queue_full", "Agent room queue is full", 1_000);
    }
    queue.push(job);
    queues.set(job.execution.roomId, queue);
    jobsByExecution.set(job.execution.id, job);
    if (jobsByExecution.size > 1_024) {
      const oldest = jobsByExecution.keys().next().value as string | undefined;
      if (oldest !== undefined && !controllers.has(oldest)) jobsByExecution.delete(oldest);
    }
  };

  const runAttempt = async (job: RuntimeJob, controller: AbortController): Promise<void> => {
    let claimed = job.execution.status === "queued"
      ? await options.authority.claim(job.execution.id, job.execution.currentAttemptSeq)
      : job.execution;
    if (claimed.status !== "running") {
      throw new AgentRuntimeError("execution_conflict", "Agent attempt was not runnable");
    }
    job.execution = claimed;
    const baseInput = await options.buildProviderInput(claimed, job.intent, job.context);
    const input: AgentRuntimeProviderInput = {
      ...baseInput,
      ...(job.toolContinuations.length === 0 ? {} : { toolContinuations: job.toolContinuations }),
    };
    if (!Number.isSafeInteger(input.limits.timeoutMs) || input.limits.timeoutMs < 1 || input.limits.timeoutMs > 30_000) {
      throw new AgentRuntimeError("invalid_parameters", "Provider timeout limit was invalid");
    }
    const timeout = setTimeout(() => controller.abort("provider_timeout"), input.limits.timeoutMs);
    let partial = "";
    let sawStarted = false;
    let sawCompleted = false;
    let lastSequence = 0;
    const toolCalls = new Map<string, { toolName: string; argumentsJson: string }>();
    try {
      for await (const event of options.provider.stream(input, controller.signal)) {
        if (event.sequence !== lastSequence + 1) {
          throw new AgentRuntimeError("provider_malformed", "Provider event sequence was invalid");
        }
        lastSequence = event.sequence;
        if (event.type === "response_started") {
          if (sawStarted) throw new AgentRuntimeError("provider_malformed", "Provider started twice");
          sawStarted = true;
        } else if (event.type === "text_delta") {
          if (!sawStarted || sawCompleted) throw new AgentRuntimeError("provider_malformed", "Provider delta order was invalid");
          partial += event.delta;
          if (Buffer.byteLength(partial, "utf8") > limits.maxPartialBytes) {
            throw new AgentRuntimeError("provider_malformed", "Provider partial preview exceeded its limit");
          }
          options.emitPreview?.({
            roomId: claimed.roomId,
            executionId: claimed.id,
            attemptSeq: claimed.currentAttemptSeq,
            streamSeq: event.sequence,
            delta: event.delta,
          });
        } else if (event.type === "tool_call_started") {
          if (!sawStarted || sawCompleted || toolCalls.has(event.callId)) {
            throw new AgentRuntimeError("provider_malformed", "Provider tool call order was invalid");
          }
          toolCalls.set(event.callId, { toolName: event.toolName, argumentsJson: "" });
        } else if (event.type === "tool_call_delta") {
          const call = toolCalls.get(event.callId);
          if (!sawStarted || sawCompleted || call === undefined) {
            throw new AgentRuntimeError("provider_malformed", "Provider tool call delta was unbound");
          }
          call.argumentsJson += event.delta;
          if (Buffer.byteLength(call.argumentsJson, "utf8") > 64 * 1_024) {
            throw new AgentRuntimeError("provider_malformed", "Provider tool arguments exceeded their limit");
          }
        } else if (event.type === "completed") {
          if (!sawStarted || sawCompleted) throw new AgentRuntimeError("provider_malformed", "Provider completion order was invalid");
          sawCompleted = true;
        }
      }
      if (!sawStarted || !sawCompleted || controller.signal.aborted) {
        throw new AgentRuntimeError("provider_malformed", "Provider stream did not complete");
      }
      if (toolCalls.size > 0) {
        if (options.toolGateway === undefined || options.tools === undefined) {
          throw new AgentRuntimeError("provider_malformed", "Provider requested an unavailable tool");
        }
        const toolsByName = new Map(options.tools.map((tool) => [
          tool.id.replaceAll(".", "_").replaceAll("-", "_"), tool,
        ]));
        for (const [callId, call] of toolCalls) {
          const tool = toolsByName.get(call.toolName);
          let parameters: unknown;
          try {
            parameters = JSON.parse(call.argumentsJson);
          } catch {
            throw new AgentRuntimeError("provider_malformed", "Provider tool arguments were malformed");
          }
          if (tool === undefined || typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
            throw new AgentRuntimeError("provider_malformed", "Provider tool plan was rejected");
          }
          const prepared = await options.authority.prepareTool(
            claimed.id,
            claimed.currentAttemptSeq,
            tool,
            parameters as Readonly<Record<string, unknown>>,
            job.context?.kind === "human" ? job.context : undefined,
            { callId, argumentsJson: call.argumentsJson },
          );
          job.execution = prepared.execution;
          claimed = prepared.execution;
          if (tool.effect === "side-effecting") {
            if (prepared.confirmationId === undefined) {
              throw new AgentRuntimeError("provider_failure", "Tool confirmation authority was malformed");
            }
            pendingConfirmations.set(prepared.confirmationId, {
              job,
              grantId: prepared.grantId,
              callId,
              tool,
              parameters: parameters as Readonly<Record<string, unknown>>,
              argumentsJson: call.argumentsJson,
            });
            return;
          }
          const outcome = await options.toolGateway.execute({
            executionId: claimed.id,
            attemptSeq: claimed.currentAttemptSeq,
            roomId: claimed.roomId,
            agentId: claimed.agentId,
            grantId: prepared.grantId,
            toolId: tool.id,
            parameters: parameters as Readonly<Record<string, unknown>>,
            signal: controller.signal,
          });
          const stepSeq = job.toolContinuations.length + 1;
          await options.authority.checkpoint(
            claimed.id,
            claimed.currentAttemptSeq,
            stepSeq,
            "tool",
            createHash("sha256").update(call.argumentsJson).digest("hex"),
            createHash("sha256").update(outcome.modelInput).digest("hex"),
          );
          job.toolContinuations.push({
            callId,
            toolId: tool.id,
            argumentsJson: call.argumentsJson,
            modelInput: outcome.modelInput,
          });
        }
        clearTimeout(timeout);
        partial = "";
        await runAttempt(job, controller);
        return;
      }
      const completed = await options.authority.complete(claimed.id, claimed.currentAttemptSeq, partial);
      try {
        options.onMessageCommitted?.(completed);
      } catch {
        // Post-commit routing notification cannot alter the completed execution.
      }
      return;
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      const runtimeError = error instanceof AgentRuntimeError
        ? error
        : new AgentRuntimeError("provider_failure", "Provider execution failed");
      if (!transient(runtimeError.code)) {
        await options.authority.scheduleRetry(claimed.id, claimed.currentAttemptSeq, runtimeError.code, undefined);
        return;
      }
      const ordinal = claimed.retryOrdinal;
      if (job.sideEffectDispatched) {
        await options.authority.scheduleRetry(claimed.id, claimed.currentAttemptSeq, runtimeError.code, undefined);
        return;
      }
      const retryDelay = ordinal < AGENT_RUNTIME_MAX_ATTEMPTS
        ? AGENT_RUNTIME_RETRY_DELAYS_MS[ordinal - 1]
        : undefined;
      const nextRetryAt = retryDelay === undefined
        ? undefined
        : new Date(clock.now() + retryDelay).toISOString();
      const next = await options.authority.scheduleRetry(
        claimed.id,
        claimed.currentAttemptSeq,
        runtimeError.code,
        nextRetryAt,
      );
      job.execution = next;
      if (next.status === "queued" && retryDelay !== undefined) {
        clearTimeout(timeout);
        await clock.wait(retryDelay, controller.signal);
        if (!controller.signal.aborted) await runAttempt(job, controller);
      }
    } finally {
      clearTimeout(timeout);
      partial = "";
    }
  };

  const runJob = async (job: RuntimeJob): Promise<void> => {
    const controller = new AbortController();
    controllers.set(job.execution.id, controller);
    try {
      await runAttempt(job, controller);
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        const runtimeError = error instanceof AgentRuntimeError
          ? error
          : new AgentRuntimeError("provider_failure", "Agent runtime failed");
        await options.authority.scheduleRetry(
          job.execution.id,
          job.execution.currentAttemptSeq,
          runtimeError.code,
          undefined,
        ).catch(() => undefined);
      }
    } finally {
      controllers.delete(job.execution.id);
    }
  };

  const pump = (): void => {
    if (closed) {
      signalIdle();
      return;
    }
    for (const [roomId, queue] of queues) {
      if (active >= limits.maxActive) break;
      if (activeRooms.has(roomId) || queue.length === 0) continue;
      const job = queue.shift();
      if (job === undefined) continue;
      active += 1;
      activeRooms.add(roomId);
      void runJob(job).finally(() => {
        active -= 1;
        activeRooms.delete(roomId);
        if (queue.length === 0) queues.delete(roomId);
        pump();
        signalIdle();
      });
    }
    signalIdle();
  };

  const runtime: AgentRuntimeService = {
    async invoke(context, intent): Promise<InvocationAccepted> {
      if (closed) throw new AgentRuntimeError("agent_runtime_closed", "Agent runtime is closed");
      if (options.readiness?.() === "noauth") {
        throw new AgentRuntimeError("agent_configuration_missing", "Agent model authentication is not configured");
      }
      const queue = queues.get(intent.roomId);
      if (queue !== undefined && queue.length >= limits.maxQueuedPerRoom) {
        throw new AgentRuntimeError("agent_queue_full", "Agent room queue is full", 1_000);
      }
      const accepted = await options.authority.invoke(context, intent, options.provider.id, options.modelId);
      if (!accepted.replayed && accepted.execution.status === "queued") {
        enqueue({ execution: accepted.execution, intent, context, toolContinuations: [], sideEffectDispatched: false });
        pump();
      }
      return accepted;
    },
    async invokeRouted(routeJobId, intent): Promise<InvocationAccepted> {
      if (closed) throw new AgentRuntimeError("agent_runtime_closed", "Agent runtime is closed");
      if (options.readiness?.() === "noauth") {
        throw new AgentRuntimeError("agent_configuration_missing", "Agent model authentication is not configured");
      }
      const queue = queues.get(intent.roomId);
      if (queue !== undefined && queue.length >= limits.maxQueuedPerRoom) {
        throw new AgentRuntimeError("agent_queue_full", "Agent room queue is full", 1_000);
      }
      const accepted = await options.authority.invokeRouted(
        routeJobId,
        intent,
        options.provider.id,
        options.modelId,
      );
      if (!accepted.replayed && accepted.execution.status === "queued") {
        enqueue({
          execution: accepted.execution,
          intent,
          context: undefined,
          toolContinuations: [],
          sideEffectDispatched: false,
        });
        pump();
      }
      return accepted;
    },
    async interrupt(context, executionId, reason) {
      const cancelled = await options.authority.interrupt(context, executionId, reason);
      controllers.get(executionId)?.abort("cancelled");
      const job = jobsByExecution.get(executionId);
      if (job !== undefined) job.execution = cancelled;
      for (const queue of queues.values()) {
        const index = queue.findIndex((candidate) => candidate.execution.id === executionId);
        if (index >= 0) queue.splice(index, 1);
      }
      signalIdle();
      return cancelled;
    },
    async retry(context, executionId) {
      if (closed) throw new AgentRuntimeError("agent_runtime_closed", "Agent runtime is closed");
      if (options.readiness?.() === "noauth") {
        throw new AgentRuntimeError("agent_configuration_missing", "Agent model authentication is not configured");
      }
      const accepted = await options.authority.retry(context, executionId);
      const prior = jobsByExecution.get(executionId);
      if (accepted.replayed && prior !== undefined) return accepted;
      const job: RuntimeJob = {
        execution: accepted.execution,
        intent: prior?.intent ?? {
          kind: "direct_mention",
          roomId: accepted.execution.roomId,
          sourceMessageId: accepted.execution.sourceMessageId,
          targetAgentId: accepted.execution.agentId,
        },
        context,
        toolContinuations: [],
        sideEffectDispatched: false,
      };
      enqueue(job);
      pump();
      return accepted;
    },
    async confirmTool(context: AuthenticatedCommandContext, confirmation: ToolConfirmationInput) {
      let pending = pendingConfirmations.get(confirmation.confirmationId);
      if (pending === undefined) {
        const restored = await options.authority.readPendingConfirmation(
          confirmation.confirmationId,
          confirmation.executionId,
        );
        const tool = options.tools?.find((candidate) => candidate.id === restored.toolId);
        if (tool === undefined) {
          throw new AgentRuntimeError("execution_not_found", "No tool confirmation is pending");
        }
        pending = {
          job: {
            execution: restored.execution,
            intent: {
              kind: "direct_mention",
              roomId: restored.execution.roomId,
              sourceMessageId: restored.execution.sourceMessageId,
              targetAgentId: restored.execution.agentId,
            },
            context,
            toolContinuations: [],
            sideEffectDispatched: false,
          },
          grantId: restored.grantId,
          callId: restored.callId,
          tool,
          parameters: restored.parameters,
          argumentsJson: restored.argumentsJson,
        };
      }
      if (pending.job.execution.id !== confirmation.executionId || options.toolGateway === undefined) {
        throw new AgentRuntimeError("execution_not_found", "No tool confirmation is pending");
      }
      const controller = new AbortController();
      const execution = pending.job.execution;
      let outcome;
      try {
        outcome = await options.toolGateway.execute({
          executionId: execution.id,
          attemptSeq: execution.currentAttemptSeq,
          roomId: execution.roomId,
          agentId: execution.agentId,
          grantId: pending.grantId,
          toolId: pending.tool.id,
          parameters: pending.parameters,
          confirmation: { context, input: confirmation },
          signal: controller.signal,
        });
      } catch (error: unknown) {
        pendingConfirmations.delete(confirmation.confirmationId);
        const runtimeError = error instanceof AgentRuntimeError
          ? error
          : new AgentRuntimeError("side_effect_outcome_unknown", "Side-effect outcome requires review");
        await options.authority.scheduleRetry(
          execution.id,
          execution.currentAttemptSeq,
          runtimeError.code,
          undefined,
        ).catch(() => undefined);
        throw runtimeError;
      }
      pending.job.sideEffectDispatched = true;
      const stepSeq = pending.job.toolContinuations.length + 1;
      await options.authority.checkpoint(
        execution.id,
        execution.currentAttemptSeq,
        stepSeq,
        "tool",
        createHash("sha256").update(pending.argumentsJson).digest("hex"),
        createHash("sha256").update(outcome.modelInput).digest("hex"),
      );
      pending.job.toolContinuations.push({
        callId: pending.callId,
        toolId: pending.tool.id,
        argumentsJson: pending.argumentsJson,
        modelInput: outcome.modelInput,
      });
      pendingConfirmations.delete(confirmation.confirmationId);
      enqueue(pending.job);
      pump();
      return execution;
    },
    async compensate(context: AuthenticatedCommandContext, executionId: string) {
      if (closed) throw new AgentRuntimeError("agent_runtime_closed", "Agent runtime is closed");
      const adapter = options.toolAdapters?.find((candidate) =>
        candidate.descriptor.id === "sandbox-file.write" && candidate.compensate !== undefined,
      );
      if (adapter?.compensate === undefined) {
        throw new AgentRuntimeError("execution_not_found", "No compensatable execution was found");
      }
      const begun = await options.authority.beginCompensation(context, executionId);
      if (begun.replayed) return { execution: begun.execution, replayed: true };
      const controller = new AbortController();
      controllers.set(begun.execution.id, controller);
      try {
        const outcome = await adapter.compensate(begun.sealedCompensation, controller.signal);
        await options.authority.settleTool(
          begun.dispatchId,
          "succeeded",
          outcome.summary,
          outcome.compensationToken,
        );
        const completed = await options.authority.complete(
          begun.execution.id,
          begun.execution.currentAttemptSeq,
          "Compensation completed",
        );
        try {
          options.onMessageCommitted?.(completed);
        } catch {
          // Post-commit routing notification cannot alter compensation completion.
        }
        return { execution: completed, replayed: false };
      } catch (error: unknown) {
        await options.authority.settleTool(
          begun.dispatchId,
          "outcome_unknown",
          { outcome: "unknown" },
        ).catch(() => undefined);
        await options.authority.scheduleRetry(
          begun.execution.id,
          begun.execution.currentAttemptSeq,
          "side_effect_outcome_unknown",
          undefined,
        ).catch(() => undefined);
        if (error instanceof AgentRuntimeError) throw error;
        throw new AgentRuntimeError("side_effect_outcome_unknown", "Compensation outcome requires review");
      } finally {
        controllers.delete(begun.execution.id);
      }
    },
    whenIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
    async recover() {
      const records = await options.authority.recover();
      for (const record of records) {
        if (record.outcome !== "enqueue") continue;
        const existing = jobsByExecution.get(record.execution.id);
        if (existing !== undefined) continue;
        enqueue({
          execution: record.execution,
          intent: {
            kind: "direct_mention",
            roomId: record.execution.roomId,
            sourceMessageId: record.execution.sourceMessageId,
            targetAgentId: record.execution.agentId,
          },
          context: undefined,
          toolContinuations: [],
          sideEffectDispatched: false,
        });
      }
      pump();
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        for (const controller of controllers.values()) controller.abort("runtime_close");
        for (const queue of queues.values()) queue.splice(0);
        const drained = runtime.whenIdle();
        await Promise.race([
          drained,
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      })();
      return closePromise;
    },
  };
  return Object.freeze(runtime);
}
