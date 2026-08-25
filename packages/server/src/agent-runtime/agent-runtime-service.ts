import { createHash } from "node:crypto";
import type {
  AgentExecution,
  AgentInvocationIntent,
  AgentRuntimeProviderInput,
  ToolConfirmationInput,
  ToolDescriptor,
} from "@native-im/core";
import { isAgentExecution } from "@native-im/core";
import type { AuthenticatedCommandContext, InternalAgentCommandContext } from "../persistence/contracts.js";
import { canonicalJsonV1, compareUtf8 } from "../context-compiler/canonical-json.js";
import {
  AGENT_RUNTIME_MAX_ACTIVE,
  AGENT_RUNTIME_MAX_ADMITTED_PER_ROOM,
  AGENT_RUNTIME_MAX_ATTEMPTS,
  AGENT_RUNTIME_MAX_QUEUED_PER_ROOM,
  AGENT_RUNTIME_RECOVERY_BATCH_SIZE,
  AGENT_RUNTIME_RETRY_DELAYS_MS,
  AgentRuntimeError,
  type AgentRuntime,
  type InvocationAccepted,
  type ProviderAdapter,
  type RuntimeAuthority,
  type RuntimeClock,
  type RuntimeRecoveryAuthority,
  type ToolAdapter,
} from "./contracts.js";
import type { ToolGateway } from "./tool-gateway.js";

interface RuntimeLimits {
  readonly maxActive: number;
  readonly maxQueuedPerRoom: number;
  readonly maxPartialBytes: number;
}

export interface AgentRuntimeServiceOptions {
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
  readonly recoveryAuthority?: RuntimeRecoveryAuthority;
  readonly shutdownTimeoutMs?: number;
  readonly limits?: RuntimeLimits;
  readonly emitPreview?: (preview: {
    readonly roomId: string;
    readonly sourceMessageId: string;
    readonly executionId: string;
    readonly attemptSeq: number;
    readonly streamSeq: number;
    readonly delta: string;
  }) => void;
  readonly onMessageCommitted?: (execution: AgentExecution) => void;
  readonly proposeOpenItem?: (input: {
    readonly execution: AgentExecution;
    readonly callId: string;
    readonly proposalKind: "risk" | "challenge";
    readonly targetActorId: string;
    readonly sourceMessageId: string;
    readonly reason: string;
    readonly content: string;
  }) => Promise<{ readonly id: string }>;
}

interface RuntimeJob {
  execution: AgentExecution;
  readonly intent: AgentInvocationIntent;
  readonly context: AuthenticatedCommandContext | InternalAgentCommandContext | undefined;
  readonly toolContinuations: {
    callId: string;
    toolId: ToolDescriptor["id"] | "open-item.propose";
    argumentsJson: string;
    modelInput: string;
  }[];
  sideEffectDispatched: boolean;
}

export interface AgentRuntimeService extends AgentRuntime {
  invokeRouted(routeJobId: string, intent: AgentInvocationIntent): Promise<InvocationAccepted>;
  invokeFenceReplacements(
    routeJobId: string,
    intent: AgentInvocationIntent,
  ): Promise<readonly AgentExecution[]>;
  applyCommittedHumanFence(cancelledExecutions: readonly AgentExecution[]): void;
  applyCommittedMessageRecall(input: Readonly<{
    sourceMessageId: string;
    cancellations: readonly Readonly<{
      sourceMessageId: string;
      sourceRevision: number;
      invocationIntentId: string;
      executionId: string;
      attemptSeq: number;
      cancellationReason: "message_recalled";
      sideEffectState: "none" | "dispatched-retained" | "outcome-unknown-retained";
    }>[];
  }>): void;
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

const OPEN_ITEM_PROPOSAL_FUNCTION = "dao_propose_open_item";

function closedOpenItemProposal(value: unknown): value is {
  readonly proposalKind: "risk" | "challenge";
  readonly targetActorId: string;
  readonly sourceMessageId: string;
  readonly reason: string;
  readonly content: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 5 && keys.join("\0") === [
    "content", "proposalKind", "reason", "sourceMessageId", "targetActorId",
  ].join("\0") &&
    (record.proposalKind === "risk" || record.proposalKind === "challenge") &&
    typeof record.targetActorId === "string" && record.targetActorId.length > 0 &&
    typeof record.sourceMessageId === "string" && record.sourceMessageId.length > 0 &&
    typeof record.reason === "string" && record.reason.trim().length > 0 &&
    Buffer.byteLength(record.reason, "utf8") <= 2_048 &&
    typeof record.content === "string" && record.content.trim().length > 0 &&
    Buffer.byteLength(record.content, "utf8") <= 32_768;
}

function validateLimits(limits: RuntimeLimits): void {
  if (!Number.isSafeInteger(limits.maxActive) || limits.maxActive < 1 || limits.maxActive > AGENT_RUNTIME_MAX_ACTIVE ||
      !Number.isSafeInteger(limits.maxQueuedPerRoom) || limits.maxQueuedPerRoom < 1 || limits.maxQueuedPerRoom > AGENT_RUNTIME_MAX_QUEUED_PER_ROOM ||
      !Number.isSafeInteger(limits.maxPartialBytes) || limits.maxPartialBytes < 256 || limits.maxPartialBytes > 1_048_576) {
    throw new TypeError("Agent runtime limits were invalid");
  }
}

function transient(code: AgentRuntimeError["code"]): boolean {
  return code === "provider_rate_limited" || code === "provider_timeout" ||
    code === "provider_unavailable" || code === "tool_target_busy" ||
    code === "context_storage_unavailable";
}

function assertProviderInputBudget(input: AgentRuntimeProviderInput): void {
  const continuationTokens = input.toolContinuations === undefined ? 0 :
    Buffer.byteLength(canonicalJsonV1({ toolContinuations: input.toolContinuations }), "utf8");
  if (input.limits.compiledInputTokens + continuationTokens >
      input.limits.maxContextInputTokens) {
    throw new AgentRuntimeError(
      "content_too_large",
      "Compiled context and tool continuations exceeded the deterministic input budget",
    );
  }
}

function runtimeRecoveryRecord(value: unknown): value is Awaited<
  ReturnType<RuntimeAuthority["recover"]>
>[number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const invocation = record.intent;
  if (!isAgentExecution(record.execution) || typeof invocation !== "object" ||
      invocation === null || Array.isArray(invocation)) return false;
  const invocationRecord = invocation as Record<string, unknown>;
  return (record.outcome === "enqueue" || record.outcome === "failed" ||
      record.outcome === "fail_outcome_unknown" || record.outcome === "wait_confirmation") &&
    (invocationRecord.kind === "direct_mention" || invocationRecord.kind === "structured_help" ||
      invocationRecord.kind === "routed_candidate") &&
    typeof invocationRecord.roomId === "string" &&
    typeof invocationRecord.sourceMessageId === "string" &&
    typeof invocationRecord.targetAgentId === "string" &&
    invocationRecord.roomId === record.execution.roomId &&
    invocationRecord.sourceMessageId === record.execution.sourceMessageId &&
    invocationRecord.targetAgentId === record.execution.agentId;
}

function recoveryCandidateId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const execution = (value as Record<string, unknown>).execution;
  if (typeof execution !== "object" || execution === null || Array.isArray(execution)) return undefined;
  const id = (execution as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
}

export function createAgentRuntimeService(options: AgentRuntimeServiceOptions): AgentRuntimeService {
  if (options.modelId.trim().length === 0) throw new TypeError("Agent runtime modelId must be non-empty");
  const limits = options.limits ?? {
    maxActive: AGENT_RUNTIME_MAX_ACTIVE,
    maxQueuedPerRoom: AGENT_RUNTIME_MAX_QUEUED_PER_ROOM,
    maxPartialBytes: 64 * 1_024,
  };
  validateLimits(limits);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 30_000) {
    throw new TypeError("Agent runtime shutdown timeout was invalid");
  }
  const clock = options.clock ?? productionClock;
  const queues = new Map<string, RuntimeJob[]>();
  const activeAgents = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const jobsByExecution = new Map<string, RuntimeJob>();
  const admittedExecutions = new Set<string>();
  const admittedByRoom = new Map<string, number>();
  const admissionReservations = new Map<string, number>();
  const pendingConfirmations = new Map<string, {
    readonly job: RuntimeJob;
    readonly grantId: string;
    readonly callId: string;
    readonly tool: ToolDescriptor;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly argumentsJson: string;
  }>();
  const idleWaiters = new Set<() => void>();
  const capacityWaiters = new Set<() => void>();
  let active = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let recoveryPromise: Promise<void> | undefined;

  const agentLane = (job: RuntimeJob): string =>
    `${job.execution.roomId}\0${job.execution.agentId}`;

  const admitted = (roomId: string): number => admittedByRoom.get(roomId) ?? 0;
  const reserved = (roomId: string): number => admissionReservations.get(roomId) ?? 0;
  const reserveAdmission = (roomId: string): void => {
    if (admitted(roomId) + reserved(roomId) >= AGENT_RUNTIME_MAX_ADMITTED_PER_ROOM) {
      throw new AgentRuntimeError("agent_queue_full", "Agent room admission is full", 1_000);
    }
    admissionReservations.set(roomId, reserved(roomId) + 1);
  };
  const releaseReservation = (roomId: string): void => {
    const count = reserved(roomId);
    if (count <= 1) admissionReservations.delete(roomId);
    else admissionReservations.set(roomId, count - 1);
  };
  const admit = (job: RuntimeJob): void => {
    if (admittedExecutions.has(job.execution.id)) return;
    if (admitted(job.execution.roomId) >= AGENT_RUNTIME_MAX_ADMITTED_PER_ROOM) {
      throw new AgentRuntimeError("agent_queue_full", "Agent room admission is full", 1_000);
    }
    admittedExecutions.add(job.execution.id);
    admittedByRoom.set(job.execution.roomId, admitted(job.execution.roomId) + 1);
  };
  const releaseAdmission = (job: RuntimeJob): void => {
    if (!admittedExecutions.delete(job.execution.id)) return;
    const count = admitted(job.execution.roomId);
    if (count <= 1) admittedByRoom.delete(job.execution.roomId);
    else admittedByRoom.set(job.execution.roomId, count - 1);
    for (const resolve of capacityWaiters) resolve();
    capacityWaiters.clear();
  };

  const exactOwnKeys = (value: object, keys: readonly string[]): boolean => {
    const allowed = new Set(keys);
    return keys.every((key) => Object.hasOwn(value, key)) &&
      Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
  };

  const nonEmptyId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= 256;

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
    admit(job);
    queue.push(job);
    queues.set(job.execution.roomId, queue);
    jobsByExecution.set(job.execution.id, job);
  };

  const removeQueuedJob = (executionId: string): RuntimeJob | undefined => {
    for (const [roomId, queue] of queues) {
      const index = queue.findIndex((candidate) => candidate.execution.id === executionId);
      if (index < 0) continue;
      const [removed] = queue.splice(index, 1);
      if (queue.length === 0) queues.delete(roomId);
      if (removed !== undefined) {
        releaseAdmission(removed);
        jobsByExecution.delete(removed.execution.id);
      }
      return removed;
    }
    return undefined;
  };

  const persistFailure = async (
    job: RuntimeJob,
    claimed: AgentExecution,
    runtimeError: AgentRuntimeError,
  ): Promise<Readonly<{ next: AgentExecution; retryDelay?: number }>> => {
    if (!transient(runtimeError.code) || job.sideEffectDispatched) {
      const next = await options.authority.scheduleRetry(
        claimed.id, claimed.currentAttemptSeq, runtimeError.code, undefined,
      );
      job.execution = next;
      return { next };
    }
    const configuredRetryDelay = claimed.retryOrdinal < AGENT_RUNTIME_MAX_ATTEMPTS
      ? AGENT_RUNTIME_RETRY_DELAYS_MS[claimed.retryOrdinal - 1]
      : undefined;
    const retryDelay = configuredRetryDelay === undefined ? undefined
      : Number.isSafeInteger(runtimeError.retryAfterMs) && runtimeError.retryAfterMs! >= 0
        ? runtimeError.retryAfterMs
        : configuredRetryDelay;
    const nextRetryAt = retryDelay === undefined
      ? undefined
      : new Date(clock.now() + retryDelay).toISOString();
    const next = await options.authority.scheduleRetry(
      claimed.id, claimed.currentAttemptSeq, runtimeError.code, nextRetryAt,
    );
    job.execution = next;
    return retryDelay === undefined ? { next } : { next, retryDelay };
  };

  const runAttempt = async (job: RuntimeJob, jobController: AbortController): Promise<void> => {
    let claimed = job.execution.status === "queued"
      ? await options.authority.claim(job.execution.id, job.execution.currentAttemptSeq)
      : job.execution;
    if (claimed.status !== "running") {
      throw new AgentRuntimeError("execution_conflict", "Agent attempt was not runnable");
    }
    job.execution = claimed;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let partial = "";
    let finalDraft: Readonly<{ body: string; citations: readonly string[] }> | undefined;
    let sawStarted = false;
    let sawCompleted = false;
    let lastSequence = 0;
    const toolCalls = new Map<string, { toolName: string; argumentsJson: string }>();
    const attemptController = new AbortController();
    let rejectJobAbort!: (error: unknown) => void;
    const jobAbortGate = new Promise<never>((_resolve, reject) => {
      rejectJobAbort = reject;
    });
    void jobAbortGate.catch(() => undefined);
    const relayJobAbort = (): void => {
      attemptController.abort(jobController.signal.reason);
      rejectJobAbort(new AgentRuntimeError("execution_conflict", "Agent job was cancelled"));
    };
    if (jobController.signal.aborted) relayJobAbort();
    else jobController.signal.addEventListener("abort", relayJobAbort, { once: true });
    let timeoutSettlement: Promise<Readonly<{ next: AgentExecution; retryDelay?: number }>> | undefined;
    let rejectTimeout!: (error: unknown) => void;
    const timeoutGate = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    try {
      const baseInput = await options.buildProviderInput(claimed, job.intent, job.context);
      const input: AgentRuntimeProviderInput = {
        ...baseInput,
        ...(job.toolContinuations.length === 0 ? {} : { toolContinuations: job.toolContinuations }),
      };
      assertProviderInputBudget(input);
      if (!Number.isSafeInteger(input.limits.timeoutMs) || input.limits.timeoutMs < 1 ||
          input.limits.timeoutMs > 30_000) {
        throw new AgentRuntimeError("invalid_parameters", "Provider timeout limit was invalid");
      }
      if (jobController.signal.aborted) {
        throw new AgentRuntimeError("execution_conflict", "Agent job was cancelled");
      }
      timeout = setTimeout(() => {
        timeoutSettlement = persistFailure(
          job,
          claimed,
          new AgentRuntimeError("provider_timeout", "Provider attempt timed out"),
        );
        void timeoutSettlement.then(
          () => {
            attemptController.abort("provider_timeout");
            rejectTimeout(new AgentRuntimeError("provider_timeout", "Provider attempt timed out"));
          },
          (error: unknown) => {
            attemptController.abort("provider_timeout_persist_failed");
            rejectTimeout(error);
          },
        );
      }, input.limits.timeoutMs);
      const stream = options.provider.stream(input, attemptController.signal)[Symbol.asyncIterator]();
      while (true) {
        const iteration = await Promise.race([stream.next(), timeoutGate, jobAbortGate]);
        if (iteration.done) break;
        const event = iteration.value;
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
            sourceMessageId: claimed.sourceMessageId,
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
        } else if (event.type === "agent_final") {
          if (!sawStarted || sawCompleted || finalDraft !== undefined || partial.length > 0 ||
              toolCalls.size > 0 || event.body.length === 0 ||
              Buffer.byteLength(event.body, "utf8") > input.limits.maxOutputBytes ||
              event.citations.length > 128) {
            throw new AgentRuntimeError("provider_malformed", "Provider final order was invalid");
          }
          const labels = new Set<string>();
          if (!event.citations.every((label) => {
            if (typeof label !== "string" || label.length === 0 || label.length > 256 ||
                label !== label.trim() || label.normalize("NFC") !== label ||
                /[\p{Cc}\p{Cf}]/u.test(label) || labels.has(label)) return false;
            labels.add(label);
            return true;
          })) {
            throw new AgentRuntimeError("provider_malformed", "Provider final citations were invalid");
          }
          finalDraft = Object.freeze({
            body: event.body,
            citations: Object.freeze([...event.citations].sort(compareUtf8)),
          });
        } else if (event.type === "completed") {
          if (!sawStarted || sawCompleted || finalDraft !== undefined) {
            throw new AgentRuntimeError("provider_malformed", "Provider completion order was invalid");
          }
          sawCompleted = true;
        }
      }
      if (!sawStarted || attemptController.signal.aborted ||
          (toolCalls.size > 0 ? !sawCompleted || finalDraft !== undefined
            : finalDraft === undefined || sawCompleted)) {
        throw new AgentRuntimeError("provider_malformed", "Provider stream did not complete");
      }
      if (toolCalls.size > 0) {
        if (options.toolGateway === undefined || options.tools === undefined) {
          throw new AgentRuntimeError("provider_malformed", "Provider requested an unavailable tool");
        }
        const toolsByName = new Map(input.availableTools.map((tool) => [
          tool.id.replaceAll(".", "_").replaceAll("-", "_"), tool,
        ]));
        for (const [callId, call] of toolCalls) {
          let parameters: unknown;
          try {
            parameters = JSON.parse(call.argumentsJson);
          } catch {
            throw new AgentRuntimeError("provider_malformed", "Provider tool arguments were malformed");
          }
          if (call.toolName === OPEN_ITEM_PROPOSAL_FUNCTION) {
            if (options.proposeOpenItem === undefined || !closedOpenItemProposal(parameters) ||
                parameters.sourceMessageId !== claimed.sourceMessageId ||
                !input.openItemTargets?.some((target) => target.actorId === parameters.targetActorId)) {
              throw new AgentRuntimeError("provider_malformed", "Provider OpenItem proposal was rejected");
            }
            const item = await options.proposeOpenItem({
              execution: claimed, callId, ...parameters,
            });
            const modelInput = `OpenItem ${item.id} was authoritatively created.`;
            const stepSeq = job.toolContinuations.length + 1;
            await options.authority.checkpoint(
              claimed.id, claimed.currentAttemptSeq, stepSeq, "tool",
              createHash("sha256").update(call.argumentsJson).digest("hex"),
              createHash("sha256").update(modelInput).digest("hex"),
            );
            job.toolContinuations.push({
              callId, toolId: "open-item.propose", argumentsJson: call.argumentsJson, modelInput,
            });
            continue;
          }
          const tool = toolsByName.get(call.toolName);
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
            callId,
            grantId: prepared.grantId,
            toolId: tool.id,
            parameters: parameters as Readonly<Record<string, unknown>>,
            signal: attemptController.signal,
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
        await runAttempt(job, jobController);
        return;
      }
      const completed = await options.authority.complete(
        claimed.id,
        claimed.currentAttemptSeq,
        finalDraft!.body,
        finalDraft!.citations,
      );
      try {
        options.onMessageCommitted?.(completed);
      } catch {
        // Post-commit routing notification cannot alter the completed execution.
      }
      return;
    } catch (error: unknown) {
      clearTimeout(timeout);
      if (jobController.signal.aborted) return;
      if (timeoutSettlement !== undefined) {
        const persisted = await timeoutSettlement;
        if (!attemptController.signal.aborted) attemptController.abort("provider_timeout");
        if (persisted.next.status === "queued" && persisted.retryDelay !== undefined) {
          await clock.wait(persisted.retryDelay, jobController.signal);
          if (!jobController.signal.aborted) await runAttempt(job, jobController);
        }
        return;
      }
      const runtimeError = error instanceof AgentRuntimeError
        ? error
        : new AgentRuntimeError("provider_failure", "Provider execution failed");
      if (runtimeError.code === "execution_conflict") return;
      const persisted = await persistFailure(job, claimed, runtimeError);
      if (persisted.next.status === "queued" && persisted.retryDelay !== undefined) {
        await clock.wait(persisted.retryDelay, jobController.signal);
        if (!jobController.signal.aborted) await runAttempt(job, jobController);
      }
    } finally {
      clearTimeout(timeout);
      jobController.signal.removeEventListener("abort", relayJobAbort);
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
        if (runtimeError.code === "execution_conflict") return;
        await options.authority.scheduleRetry(
          job.execution.id,
          job.execution.currentAttemptSeq,
          runtimeError.code,
          undefined,
        ).catch(() => undefined);
      }
    } finally {
      controllers.delete(job.execution.id);
      const waitingForConfirmation = [...pendingConfirmations.values()].some((pending) =>
        pending.job.execution.id === job.execution.id);
      if (!waitingForConfirmation) {
        releaseAdmission(job);
        jobsByExecution.delete(job.execution.id);
      }
    }
  };

  const pump = (): void => {
    if (closed) {
      signalIdle();
      return;
    }
    let madeProgress = true;
    while (active < limits.maxActive && madeProgress) {
      madeProgress = false;
      for (const [roomId, queue] of queues) {
        if (active >= limits.maxActive) break;
        const index = queue.findIndex((candidate) => !activeAgents.has(agentLane(candidate)));
        if (index < 0) continue;
        const [job] = queue.splice(index, 1);
        if (job === undefined) continue;
        const lane = agentLane(job);
        active += 1;
        activeAgents.add(lane);
        madeProgress = true;
        void runJob(job).finally(() => {
          active -= 1;
          activeAgents.delete(lane);
          if (queue.length === 0) queues.delete(roomId);
          pump();
          signalIdle();
        });
      }
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
      reserveAdmission(intent.roomId);
      try {
        const accepted = await options.authority.invoke(context, intent, options.provider.id, options.modelId);
        if (!accepted.replayed && accepted.execution.status === "queued") {
          enqueue({ execution: accepted.execution, intent, context, toolContinuations: [], sideEffectDispatched: false });
          pump();
        }
        return accepted;
      } finally {
        releaseReservation(intent.roomId);
      }
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
      reserveAdmission(intent.roomId);
      try {
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
      } finally {
        releaseReservation(intent.roomId);
      }
    },
    async invokeFenceReplacements(routeJobId, intent) {
      if (closed) throw new AgentRuntimeError("agent_runtime_closed", "Agent runtime is closed");
      if (options.readiness?.() === "noauth") {
        throw new AgentRuntimeError("agent_configuration_missing", "Agent model authentication is not configured");
      }
      const queue = queues.get(intent.roomId);
      if (queue !== undefined && queue.length >= limits.maxQueuedPerRoom) {
        throw new AgentRuntimeError("agent_queue_full", "Agent room queue is full", 1_000);
      }
      const accepted = await options.authority.enqueueFenceReplacements(
        routeJobId,
        intent.targetAgentId,
        options.provider.id,
        options.modelId,
      );
      for (const execution of accepted.executions) {
        if (execution.status !== "queued" || jobsByExecution.has(execution.id)) continue;
        enqueue({ execution, intent, context: undefined, toolContinuations: [], sideEffectDispatched: false });
      }
      pump();
      return accepted.executions;
    },
    applyCommittedHumanFence(cancelledExecutions) {
      for (const cancelled of cancelledExecutions) {
        if (cancelled.status !== "cancelled") continue;
        controllers.get(cancelled.id)?.abort("human_preempted");
        const job = jobsByExecution.get(cancelled.id);
        if (job !== undefined) job.execution = cancelled;
        removeQueuedJob(cancelled.id);
        for (const [confirmationId, pending] of pendingConfirmations) {
          if (pending.job.execution.id === cancelled.id) pendingConfirmations.delete(confirmationId);
        }
        if (job !== undefined && !controllers.has(cancelled.id)) {
          releaseAdmission(job);
          jobsByExecution.delete(cancelled.id);
        }
      }
      signalIdle();
    },
    applyCommittedMessageRecall(input) {
      if (typeof input !== "object" || input === null ||
          !exactOwnKeys(input, ["sourceMessageId", "cancellations"]) ||
          !nonEmptyId(input.sourceMessageId) || !Array.isArray(input.cancellations) ||
          input.cancellations.length > 256) {
        throw new TypeError("Committed message recall tuple was malformed");
      }
      const executionIds = new Set<string>();
      for (const cancellation of input.cancellations) {
        if (typeof cancellation !== "object" || cancellation === null ||
            !exactOwnKeys(cancellation, [
              "sourceMessageId", "sourceRevision", "invocationIntentId", "executionId",
              "attemptSeq", "cancellationReason", "sideEffectState",
            ]) || cancellation.sourceMessageId !== input.sourceMessageId ||
            !Number.isSafeInteger(cancellation.sourceRevision) || cancellation.sourceRevision < 1 ||
            !nonEmptyId(cancellation.invocationIntentId) || !nonEmptyId(cancellation.executionId) ||
            !Number.isSafeInteger(cancellation.attemptSeq) || cancellation.attemptSeq < 1 ||
            cancellation.cancellationReason !== "message_recalled" ||
            (cancellation.sideEffectState !== "none" &&
              cancellation.sideEffectState !== "dispatched-retained" &&
              cancellation.sideEffectState !== "outcome-unknown-retained") ||
            executionIds.has(cancellation.executionId)) {
          throw new TypeError("Committed message recall tuple was malformed");
        }
        executionIds.add(cancellation.executionId);
        const job = jobsByExecution.get(cancellation.executionId);
        if (job !== undefined &&
            (job.intent.sourceMessageId !== cancellation.sourceMessageId ||
              job.execution.currentAttemptSeq !== cancellation.attemptSeq)) {
          throw new TypeError("Committed message recall tuple did not match runtime state");
        }
      }
      for (const cancellation of input.cancellations) {
        controllers.get(cancellation.executionId)?.abort("message_recalled");
        removeQueuedJob(cancellation.executionId);
        for (const [confirmationId, pending] of pendingConfirmations) {
          if (pending.job.execution.id === cancellation.executionId) {
            pendingConfirmations.delete(confirmationId);
          }
        }
        const job = jobsByExecution.get(cancellation.executionId);
        if (job !== undefined && !controllers.has(cancellation.executionId)) releaseAdmission(job);
        jobsByExecution.delete(cancellation.executionId);
      }
      signalIdle();
    },
    async interrupt(context, executionId, reason) {
      const cancelled = await options.authority.interrupt(context, executionId, reason);
      controllers.get(executionId)?.abort("cancelled");
      const job = jobsByExecution.get(executionId);
      if (job !== undefined) job.execution = cancelled;
      removeQueuedJob(executionId);
      if (job !== undefined && !controllers.has(executionId)) {
        releaseAdmission(job);
        jobsByExecution.delete(executionId);
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
        intent: prior?.intent ?? accepted.intent,
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
            intent: restored.intent,
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
          callId: pending.callId,
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
      if (closed) throw new AgentRuntimeError("agent_runtime_closed", "Agent runtime is closed");
      recoveryPromise ??= (async () => {
        const processCandidate = async (
          cursor: string,
          value: unknown,
          isolate: RuntimeRecoveryAuthority["isolate"] | undefined,
        ): Promise<void> => {
          if (!runtimeRecoveryRecord(value)) {
            const candidateId = recoveryCandidateId(value);
            await isolate?.({
              cursor,
              ...(candidateId === undefined ? {} : { candidateId }),
              reason: "recovery_candidate_invalid",
            });
            return;
          }
          if (value.outcome !== "enqueue" || jobsByExecution.has(value.execution.id)) return;
          const job: RuntimeJob = {
            execution: value.execution,
            intent: value.intent,
            context: undefined,
            toolContinuations: [],
            sideEffectDispatched: false,
          };
          while (!closed) {
            try {
              enqueue(job);
              pump();
              return;
            } catch (error: unknown) {
              if (!(error instanceof AgentRuntimeError) || error.code !== "agent_queue_full") {
                await isolate?.({
                  cursor,
                  candidateId: value.execution.id,
                  reason: "recovery_candidate_conflict",
                });
                return;
              }
              pump();
              await new Promise<void>((resolve) => {
                capacityWaiters.add(resolve);
                const queue = queues.get(job.execution.roomId);
                if (admitted(job.execution.roomId) < AGENT_RUNTIME_MAX_ADMITTED_PER_ROOM &&
                    (queue?.length ?? 0) < limits.maxQueuedPerRoom) {
                  capacityWaiters.delete(resolve);
                  resolve();
                }
              });
            }
          }
        };

        if (options.recoveryAuthority === undefined) {
          const records = await options.authority.recover();
          for (const [index, record] of records.entries()) {
            await processCandidate(String(index), record, undefined);
          }
          return;
        }

        let after: string | undefined;
        while (!closed) {
          const page = await options.recoveryAuthority.scan({
            ...(after === undefined ? {} : { after }),
            limit: AGENT_RUNTIME_RECOVERY_BATCH_SIZE,
          });
          if (typeof page !== "object" || page === null || !Array.isArray(page.candidates) ||
              typeof page.hasMore !== "boolean" ||
              page.candidates.length > AGENT_RUNTIME_RECOVERY_BATCH_SIZE) {
            throw new AgentRuntimeError("provider_failure", "Authority recovery page was malformed");
          }
          if (page.candidates.length === 0) {
            if (page.hasMore) {
              throw new AgentRuntimeError("provider_failure", "Authority recovery page was malformed");
            }
            return;
          }
          for (const candidate of page.candidates) {
            if (typeof candidate !== "object" || candidate === null ||
                typeof candidate.cursor !== "string" || candidate.cursor.length === 0 ||
                candidate.cursor.length > 2_048 ||
                (after !== undefined && compareUtf8(candidate.cursor, after) <= 0)) {
              throw new AgentRuntimeError("provider_failure", "Authority recovery cursor was malformed");
            }
            await processCandidate(
              candidate.cursor,
              candidate.record,
              options.recoveryAuthority.isolate.bind(options.recoveryAuthority),
            );
            after = candidate.cursor;
          }
        }
      })().finally(() => {
        recoveryPromise = undefined;
      });
      await recoveryPromise;
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        for (const controller of controllers.values()) controller.abort("runtime_close");
        for (const queue of queues.values()) {
          for (const job of queue) {
            releaseAdmission(job);
            jobsByExecution.delete(job.execution.id);
          }
          queue.splice(0);
        }
        queues.clear();
        for (const resolve of capacityWaiters) resolve();
        capacityWaiters.clear();
        const drained = runtime.whenIdle();
        await Promise.race([
          drained,
          new Promise<void>((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
        ]);
      })();
      return closePromise;
    },
  };
  return Object.freeze(runtime);
}
