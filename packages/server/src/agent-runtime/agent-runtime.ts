import { createHash, randomUUID } from "node:crypto";
import type { AgentExecution } from "@native-im/core";
import type {
  AgentInvocationInput,
  AgentRuntimeToolPlanEntry,
  AgentRuntimeAuthorityStore,
  AuthenticatedCommandContext,
  CommitExecutionStepInput,
  CompleteExecutionInput,
  FailExecutionInput,
  InternalAgentCommandContext,
  InternalAgentRuntimeContext,
  ResumeConfirmedToolInput,
  ScheduleRetryInput,
  ToolConfirmationInput,
} from "../persistence/contracts.js";
import type { AgentRuntimeTerminalErrorCode } from "../persistence/contracts.js";
import type {
  AgentRuntimeCompensatableToolAdapter,
  AgentExecutionPreview,
  AgentRuntimeProviderInput,
  AgentRuntimeToolAdapter,
  ProviderAdapter,
  RuntimeJsonValue,
} from "./contracts.js";

export interface AgentRuntimeSchedulerAuthority
  extends Pick<
    AgentRuntimeAuthorityStore,
    | "invoke"
    | "claimNext"
    | "commitStep"
    | "completeExecution"
    | "completeCompensation"
    | "scheduleRetry"
    | "interrupt"
    | "manualRetry"
    | "compensate"
    | "resumeCompensation"
    | "prepareTool"
    | "confirmTool"
    | "resumeConfirmedTool"
    | "dispatchTool"
    | "settleTool"
    | "recoverPage"
    | "readExecution"
  > {
  failExecution(runtime: InternalAgentRuntimeContext, input: FailExecutionInput): Promise<AgentExecution>;
}

export interface AgentRuntimeInputSource {
  load(execution: AgentExecution): Promise<AgentRuntimeProviderInput>;
}

export interface AgentRuntimeClock {
  now(): number;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface AgentRuntimeLimits {
  readonly maxActiveRooms?: number;
  readonly maxQueuedPerRoom?: number;
  readonly maxPreviewBytes?: number;
  readonly closeTimeoutMs?: number;
  readonly toolGrantTtlMs?: number;
}

export interface CreateAgentRuntimeOptions {
  readonly authority: AgentRuntimeSchedulerAuthority;
  readonly runtimeContext: InternalAgentRuntimeContext;
  readonly provider: ProviderAdapter;
  readonly inputSource: AgentRuntimeInputSource;
  readonly tools?: readonly AgentRuntimeToolAdapter[];
  readonly clock?: AgentRuntimeClock;
  readonly limits?: AgentRuntimeLimits;
  readonly preview?: (preview: AgentExecutionPreview) => boolean | Promise<boolean>;
  readonly createMessageId?: () => string;
  /** Stable composition-root identity for runtimes that share one process coordinator. */
  readonly coordinatorIdentity?: object;
}

export interface AgentRuntime {
  start(): Promise<void>;
  invoke(
    context: AuthenticatedCommandContext | InternalAgentCommandContext,
    input: AgentInvocationInput,
  ): Promise<AgentExecution>;
  interrupt(
    context: AuthenticatedCommandContext,
    executionId: string,
    reason: "requested_by_requester" | "requested_by_room_manager",
  ): Promise<AgentExecution>;
  retry(context: AuthenticatedCommandContext, executionId: string): Promise<AgentExecution>;
  compensate(context: AuthenticatedCommandContext, executionId: string, dispatchId: string): Promise<AgentExecution>;
  confirmTool(context: AuthenticatedCommandContext, input: ToolConfirmationInput): Promise<AgentExecution>;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

export class AgentRuntimeQueueFullError extends Error {
  readonly code = "target_busy" as const;
  readonly status = 429 as const;

  constructor(readonly retryAfterMs: number) {
    super("target_busy");
    this.name = "AgentRuntimeQueueFullError";
  }
}

class AgentRuntimeClosedError extends Error {
  readonly code = "runtime_closed" as const;
  readonly status = 503 as const;

  constructor() {
    super("runtime_closed");
    this.name = "AgentRuntimeClosedError";
  }
}

const DEFAULT_MAX_ACTIVE_ROOMS = 8;
const DEFAULT_MAX_QUEUED_PER_ROOM = 32;
const DEFAULT_MAX_PREVIEW_BYTES = 65_536;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_TOOL_GRANT_TTL_MS = 30_000;
const TRANSIENT_CODES = new Set([
  "rate_limited",
  "upstream_timeout",
  "upstream_unavailable",
]);
const TOOL_TRANSIENT_CODES = new Set(["target_busy"]);

interface SharedCoordinator {
  readonly maxActiveRooms: number;
  activeCount: number;
  readonly activeRooms: Set<string>;
  readonly outstandingByRoom: Map<string, number>;
  readonly scheduledExecutionIds: Set<string>;
  readonly scheduledConfirmationIds: Set<string>;
  readonly blockedByRoom: Map<string, Array<() => Promise<void>>>;
  readonly queue: Array<{ readonly roomId: string; readonly run: () => Promise<void> }>;
  pump(): void;
  enqueue(roomId: string, run: () => Promise<void>): void;
  block(roomId: string, run: () => Promise<void>): void;
  unblock(roomId: string, run: () => Promise<void>): void;
  wake(roomId: string): void;
}

const coordinators = new WeakMap<object, SharedCoordinator>();
const PROCESS_COORDINATOR_IDENTITY = {};

function coordinatorFor(authority: object, maxActiveRooms: number): SharedCoordinator {
  const existing = coordinators.get(authority);
  if (existing !== undefined) {
    if (existing.maxActiveRooms !== maxActiveRooms) {
      throw new TypeError("Agent runtimes sharing an authority must share maxActiveRooms");
    }
    return existing;
  }
  const coordinator: SharedCoordinator = {
    maxActiveRooms,
    activeCount: 0,
    activeRooms: new Set(),
    outstandingByRoom: new Map(),
    scheduledExecutionIds: new Set(),
    scheduledConfirmationIds: new Set(),
    blockedByRoom: new Map(),
    queue: [],
    enqueue(roomId, run) {
      this.queue.push({ roomId, run });
      queueMicrotask(() => this.pump());
    },
    block(roomId, run) {
      const blocked = this.blockedByRoom.get(roomId) ?? [];
      blocked.push(run);
      this.blockedByRoom.set(roomId, blocked);
    },
    unblock(roomId, run) {
      const remaining = (this.blockedByRoom.get(roomId) ?? []).filter(
        (candidate) => candidate !== run,
      );
      if (remaining.length === 0) this.blockedByRoom.delete(roomId);
      else this.blockedByRoom.set(roomId, remaining);
    },
    wake(roomId) {
      const blocked = this.blockedByRoom.get(roomId) ?? [];
      this.blockedByRoom.delete(roomId);
      for (const run of blocked) this.enqueue(roomId, run);
    },
    pump() {
      for (let index = 0; index < this.queue.length && this.activeCount < this.maxActiveRooms;) {
        const item = this.queue[index];
        if (item === undefined) break;
        if (this.activeRooms.has(item.roomId)) {
          index += 1;
          continue;
        }
        this.queue.splice(index, 1);
        this.activeRooms.add(item.roomId);
        this.activeCount += 1;
        void item.run().catch(() => undefined).finally(() => {
          this.activeRooms.delete(item.roomId);
          this.activeCount -= 1;
          this.pump();
        });
      }
    },
  };
  coordinators.set(authority, coordinator);
  return coordinator;
}

function positiveSafe(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function defaultClock(): AgentRuntimeClock {
  return {
    now: () => Date.now(),
    wait(delayMs, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, delayMs);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function canonicalJson(value: RuntimeJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Runtime JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as { readonly [key: string]: RuntimeJsonValue };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as RuntimeJsonValue)}`)
    .join(",")}}`;
}

function sha256(value: RuntimeJsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "provider_failure";
}

function adapterEffectOutcomeUnknown(error: unknown): {
  readonly sealedCompensation?: string;
} | undefined {
  if (typeof error !== "object" || error === null ||
      !("effectOutcomeUnknown" in error) ||
      (error as { readonly effectOutcomeUnknown?: unknown }).effectOutcomeUnknown !== true) {
    return undefined;
  }
  const sealedCompensation = (error as { readonly sealedCompensation?: unknown }).sealedCompensation;
  return typeof sealedCompensation === "string" ? { sealedCompensation } : {};
}

function terminalCode(code: string): AgentRuntimeTerminalErrorCode {
  switch (code) {
    case "provider_cancelled":
    case "provider_input_too_large":
    case "provider_invalid_request":
    case "provider_invalid_response":
    case "provider_not_configured":
    case "provider_failure":
    case "provider_response_too_large":
    case "provider_unauthorized":
    case "tool_failure":
      return code;
    default:
      return "provider_failure";
  }
}

function isStaleAuthorityCode(code: string): boolean {
  return code === "execution_conflict" || code === "agent_capability_forbidden";
}

interface ToolCallAccumulator {
  readonly callId: string;
  readonly toolId: string;
  arguments: string;
}

type RuntimeStepInput = {
  readonly inputSha256: string;
  readonly outputSha256: string;
} & (
  | {
      readonly stepKind: "model_generation";
      readonly canonicalToolCall?: never;
      readonly dispatchId?: never;
      readonly boundedToolResult?: never;
    }
  | {
      readonly stepKind: "tool_call";
      readonly canonicalToolCall: {
        readonly toolId: string;
        readonly parameters: RuntimeJsonValue;
        readonly remainingCalls?: readonly AgentRuntimeToolPlanEntry[];
      };
      readonly dispatchId?: never;
      readonly boundedToolResult?: never;
    }
  | {
      readonly stepKind: "tool_result";
      readonly canonicalToolCall?: never;
      readonly dispatchId: string;
      readonly boundedToolResult: Exclude<RuntimeJsonValue, null>;
    }
);

type ToolPlanResult =
  | { readonly kind: "continue"; readonly execution: AgentExecution }
  | { readonly kind: "waiting" | "retry" | "terminal" };

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const maxActiveRooms = positiveSafe(
    options.limits?.maxActiveRooms ?? DEFAULT_MAX_ACTIVE_ROOMS,
    "maxActiveRooms",
  );
  const maxQueuedPerRoom = positiveSafe(
    options.limits?.maxQueuedPerRoom ?? DEFAULT_MAX_QUEUED_PER_ROOM,
    "maxQueuedPerRoom",
  );
  const maxPreviewBytes = positiveSafe(
    options.limits?.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES,
    "maxPreviewBytes",
  );
  const closeTimeoutMs = positiveSafe(
    options.limits?.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    "closeTimeoutMs",
  );
  const toolGrantTtlMs = positiveSafe(
    options.limits?.toolGrantTtlMs ?? DEFAULT_TOOL_GRANT_TTL_MS,
    "toolGrantTtlMs",
  );
  const clock = options.clock ?? defaultClock();
  const coordinator = coordinatorFor(
    options.coordinatorIdentity ?? PROCESS_COORDINATOR_IDENTITY,
    maxActiveRooms,
  );
  const tools = new Map((options.tools ?? []).map((tool) => [tool.descriptor.id, tool]));
  if (tools.size !== (options.tools ?? []).length) {
    throw new TypeError("Agent runtime tool IDs must be unique");
  }

  let closing = false;
  const markersByRoom = new Map<string, number>();
  const activeControllers = new Map<string, AbortController>();
  const activeExecutions = new Map<string, AgentExecution>();
  const activeSideEffects = new Set<string>();
  const interruptedSideEffects = new Set<string>();
  const localScheduledExecutions = new Map<string, string>();
  const blockedRuns = new Map<string, () => Promise<void>>();
  const tasks = new Set<Promise<void>>();
  const confirmationJobs = new Map<string, Promise<void>>();
  const idleWaiters = new Set<() => void>();
  const lifecycleAbort = new AbortController();

  const notifyIdle = (): void => {
    if (tasks.size !== 0 || markersByRoom.size !== 0 || activeExecutions.size !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const track = (task: Promise<void>): void => {
    const guarded = task.catch(() => undefined);
    tasks.add(guarded);
    void guarded.finally(() => {
      tasks.delete(guarded);
      notifyIdle();
    });
  };

  const scheduleRoom = (roomId: string): void => {
    markersByRoom.set(roomId, (markersByRoom.get(roomId) ?? 0) + 1);
    coordinator.enqueue(roomId, () => runRoom(roomId));
  };

  const scheduleRunningExecution = (execution: AgentExecution): void => {
    coordinator.scheduledExecutionIds.add(execution.id);
    localScheduledExecutions.set(execution.id, execution.roomId);
    coordinator.outstandingByRoom.set(
      execution.roomId,
      (coordinator.outstandingByRoom.get(execution.roomId) ?? 0) + 1,
    );
    markersByRoom.set(execution.roomId, (markersByRoom.get(execution.roomId) ?? 0) + 1);
    coordinator.enqueue(execution.roomId, async () => {
      activeExecutions.set(execution.id, execution);
      let keepOutstanding = false;
      try {
        keepOutstanding = (await processExecution(execution)) === "retry";
      } finally {
        if (!keepOutstanding) releaseOutstanding(execution.roomId, execution.id);
        const markers = markersByRoom.get(execution.roomId) ?? 0;
        if (markers <= 1) markersByRoom.delete(execution.roomId);
        else markersByRoom.set(execution.roomId, markers - 1);
        notifyIdle();
      }
    });
  };

  const releaseOutstanding = (roomId: string, executionId: string): boolean => {
    localScheduledExecutions.delete(executionId);
    if (!coordinator.scheduledExecutionIds.delete(executionId)) return false;
    const remaining = (coordinator.outstandingByRoom.get(roomId) ?? 1) - 1;
    if (remaining <= 0) coordinator.outstandingByRoom.delete(roomId);
    else coordinator.outstandingByRoom.set(roomId, remaining);
    return true;
  };

  const enqueueRetry = (execution: AgentExecution, nextRetryAt?: number): void => {
    if (execution.status !== "queued") {
      releaseOutstanding(execution.roomId, execution.id);
      return;
    }
    const delayMs = nextRetryAt === undefined
      ? execution.retryOrdinal === 2 ? 1_000 : 4_000
      : Math.max(0, nextRetryAt - clock.now());
    const delayed = clock
      .wait(delayMs, lifecycleAbort.signal)
      .then(() => {
        if (!closing) scheduleRoom(execution.roomId);
        else releaseOutstanding(execution.roomId, execution.id);
      })
      .catch(() => {
        releaseOutstanding(execution.roomId, execution.id);
      });
    track(delayed);
  };

  const commitStep = async (
    execution: AgentExecution,
    input: RuntimeStepInput,
  ): Promise<AgentExecution> =>
    options.authority.commitStep(options.runtimeContext, {
      executionId: execution.id,
      attemptSeq: execution.currentAttemptSeq,
      stepSeq: execution.recoveryCursor + 1,
      now: clock.now(),
      ...input,
    } as CommitExecutionStepInput);

  const failTerminal = async (
    execution: AgentExecution,
    code: AgentRuntimeTerminalErrorCode,
  ): Promise<void> => {
    await options.authority.failExecution(options.runtimeContext, {
      executionId: execution.id,
      attemptSeq: execution.currentAttemptSeq,
      errorCode: code,
      now: clock.now(),
    });
  };

  const processCompensation = async (
    claimed: AgentExecution,
    controller: AbortController,
  ): Promise<"terminal"> => {
    activeSideEffects.add(claimed.id);
    let work: Awaited<ReturnType<AgentRuntimeSchedulerAuthority["resumeCompensation"]>> | undefined;
    let adapterResolved = false;
    try {
      try {
        work = await options.authority.resumeCompensation(options.runtimeContext, {
          executionId: claimed.id,
          attemptSeq: claimed.currentAttemptSeq,
          now: clock.now(),
        });
      } catch (error: unknown) {
        // The authority transaction may have committed its dispatch before the response was lost.
        // Only storage/protocol ambiguity and stale replay can mean the dispatch committed.
        // Closed authorization denials happen before the transaction writes and must not strand
        // the claimed execution until a process restart.
        const code = errorCode(error);
        if (code === "session_revoked" || code === "agent_missing_permission" ||
            code === "agent_capability_forbidden" || code === "room_forbidden" ||
            code === "room_archived" || code === "room_not_found") {
          await failTerminal(claimed, "tool_failure").catch(() => undefined);
        }
        // Leave ambiguous/stale cases running for restart reconciliation; never guess whether
        // the atomic dispatch committed from a missing response alone.
        return "terminal";
      }
      if (createHash("sha256").update(work.sealedCompensation).digest("hex") !==
          work.dispatch.parameterHash ||
        work.execution.id !== claimed.id || work.execution.roomId !== claimed.roomId ||
        work.execution.currentAttemptSeq !== claimed.currentAttemptSeq ||
        work.execution.compensatesExecutionId !== claimed.compensatesExecutionId ||
        work.execution.status !== "running" || work.execution.actionCategory !== "tool_call" ||
        work.execution.toolDispatchPhase !== "dispatched" ||
        work.execution.currentToolId !== work.dispatch.toolId ||
        work.dispatch.executionId !== claimed.id ||
        work.dispatch.attemptSeq !== claimed.currentAttemptSeq ||
        work.dispatch.state !== "dispatched") {
        // A dispatch may already be durable, but an untrusted/miscorrelated response cannot
        // safely name the row to settle. Restart recovery owns the outcome-unknown transition.
        return "terminal";
      }
      if (closing || controller.signal.aborted || interruptedSideEffects.has(work.execution.id)) {
        await options.authority.settleTool(options.runtimeContext, {
          dispatchId: work.dispatch.id, executionId: work.execution.id,
          attemptSeq: work.execution.currentAttemptSeq, grantId: work.dispatch.grantId,
          outcome: "outcome_unknown", closedSummary: "runtime_closed_before_adapter",
          now: clock.now(),
        });
        return "terminal";
      }
      const adapter = tools.get(work.dispatch.toolId);
      if (adapter === undefined || !("compensate" in adapter) ||
        typeof adapter.compensate !== "function") {
        await options.authority.settleTool(options.runtimeContext, {
          dispatchId: work.dispatch.id, executionId: work.execution.id,
          attemptSeq: work.execution.currentAttemptSeq, grantId: work.dispatch.grantId,
          outcome: "failed", closedSummary: "tool_failure", now: clock.now(),
        });
        return "terminal";
      }
      const outcome = await (adapter as AgentRuntimeCompensatableToolAdapter).compensate(
        work.sealedCompensation,
        controller.signal,
      );
      adapterResolved = true;
      if (!closing && !controller.signal.aborted && !interruptedSideEffects.has(work.execution.id)) {
        const now = clock.now();
        await options.authority.completeCompensation(options.runtimeContext, {
          executionId: work.execution.id, attemptSeq: work.execution.currentAttemptSeq,
          dispatchId: work.dispatch.id, grantId: work.dispatch.grantId,
          boundedToolResult: outcome.modelInput,
          inputSha256: work.dispatch.parameterHash,
          outputSha256: sha256(outcome.modelInput), closedSummary: outcome.closedSummary,
          messageId: options.createMessageId?.() ?? randomUUID(),
          body: "Compensation completed.", sentAt: new Date(now).toISOString(), now,
        });
      } else {
        await options.authority.settleTool(options.runtimeContext, {
          dispatchId: work.dispatch.id, executionId: work.execution.id,
          attemptSeq: work.execution.currentAttemptSeq, grantId: work.dispatch.grantId,
          outcome: "succeeded", closedSummary: outcome.closedSummary, now: clock.now(),
        });
      }
      return "terminal";
    } catch (error: unknown) {
      if (work === undefined) return "terminal";
      const effectUnknown = adapterEffectOutcomeUnknown(error);
      const outcomeUnknown = effectUnknown !== undefined || adapterResolved || closing || controller.signal.aborted;
      await options.authority.settleTool(options.runtimeContext, {
        dispatchId: work.dispatch.id, executionId: work.execution.id,
        attemptSeq: work.execution.currentAttemptSeq, grantId: work.dispatch.grantId,
        outcome: outcomeUnknown ? "outcome_unknown" : "failed",
        closedSummary: effectUnknown !== undefined
          ? "compensation_effect_unconfirmed"
          : adapterResolved
          ? "compensation_completion_unconfirmed"
          : outcomeUnknown
            ? "runtime_closed_before_adapter_settlement"
          : "tool_failure",
        now: clock.now(),
      }).catch(() => undefined);
      return "terminal";
    } finally {
      activeSideEffects.delete(claimed.id);
      interruptedSideEffects.delete(claimed.id);
    }
  };

  const executeToolPlan = async (
    initial: AgentExecution,
    plan: readonly AgentRuntimeToolPlanEntry[],
    controller: AbortController,
  ): Promise<ToolPlanResult> => {
    let execution = initial;
    for (let index = 0; index < plan.length; index += 1) {
      if (closing || controller.signal.aborted) throw controller.signal.reason;
      const call = plan[index];
      if (call === undefined) throw new TypeError("Agent runtime tool plan was sparse");
      const adapter = tools.get(call.toolId);
      if (adapter === undefined) {
        await failTerminal(execution, "tool_failure");
        return { kind: "terminal" };
      }
      const canonicalToolCall = {
        toolId: call.toolId,
        parameters: call.parameters,
        remainingCalls: plan.slice(index + 1),
      };
      if (
        Buffer.byteLength(
          canonicalJson(canonicalToolCall as unknown as RuntimeJsonValue),
          "utf8",
        ) > 65_536
      ) {
        await failTerminal(execution, "provider_response_too_large");
        return { kind: "terminal" };
      }
      execution = await commitStep(execution, {
        stepKind: "tool_call",
        canonicalToolCall,
        inputSha256: sha256({ callId: call.callId, toolId: call.toolId }),
        outputSha256: sha256(call.parameters),
      });
      const now = clock.now();
      const parameterHash = sha256(call.parameters);
      const toolPlanHash = sha256(canonicalToolCall as unknown as RuntimeJsonValue);
      const grant = await options.authority.prepareTool(options.runtimeContext, {
        executionId: execution.id,
        attemptSeq: execution.currentAttemptSeq,
        toolCallStepSeq: execution.recoveryCursor,
        toolId: call.toolId,
        parameterHash,
        toolPlanHash,
        confirmationRequirement: adapter.descriptor.confirmationRequirement,
        now,
        expiresAt: now + toolGrantTtlMs,
      });
      if (adapter.descriptor.confirmationRequirement === "side_effect") {
        return { kind: "waiting" };
      }
      const dispatch = await options.authority.dispatchTool(options.runtimeContext, {
        executionId: execution.id,
        attemptSeq: execution.currentAttemptSeq,
        grantId: grant.id,
        toolId: call.toolId,
        parameterHash,
        confirmationRequirement: "read_only",
        now: clock.now(),
      });
      try {
        const outcome = await raceAbort(
          adapter.execute(call.parameters as RuntimeJsonValue, controller.signal),
          controller.signal,
        );
        if (closing || controller.signal.aborted) throw controller.signal.reason;
        await options.authority.settleTool(options.runtimeContext, {
          dispatchId: dispatch.id,
          executionId: execution.id,
          attemptSeq: execution.currentAttemptSeq,
          grantId: grant.id,
          outcome: "succeeded",
          closedSummary: outcome.closedSummary,
          now: clock.now(),
          ...(outcome.sealedCompensation === undefined
            ? {}
            : { sealedCompensation: outcome.sealedCompensation }),
        });
        execution = await commitStep(execution, {
          stepKind: "tool_result",
          dispatchId: dispatch.id,
          boundedToolResult: outcome.modelInput as Exclude<RuntimeJsonValue, null>,
          inputSha256: parameterHash,
          outputSha256: sha256(outcome.modelInput),
        });
      } catch (error) {
        if (closing || controller.signal.aborted) throw controller.signal.reason ?? error;
        const code = errorCode(error);
        await options.authority.settleTool(options.runtimeContext, {
          dispatchId: dispatch.id,
          executionId: execution.id,
          attemptSeq: execution.currentAttemptSeq,
          grantId: grant.id,
          outcome: "failed",
          closedSummary: code === "target_busy" ? "target_busy" : "tool_failure",
          now: clock.now(),
        });
        if (TOOL_TRANSIENT_CODES.has(code)) {
          const retried = await options.authority.scheduleRetry(options.runtimeContext, {
            executionId: execution.id,
            attemptSeq: execution.currentAttemptSeq,
            errorCode: code as ScheduleRetryInput["errorCode"],
            now: clock.now(),
          });
          enqueueRetry(retried);
          return { kind: "retry" };
        }
        await failTerminal(execution, "tool_failure");
        return { kind: "terminal" };
      }
    }
    return { kind: "continue", execution };
  };

  const processExecution = async (initial: AgentExecution): Promise<"terminal" | "retry"> => {
    let execution = initial;
    const controller = new AbortController();
    activeControllers.set(execution.id, controller);
    let previewEnabled = options.preview !== undefined;
    let previewBytes = 0;
    let previewSeq = 0;
    try {
      if (execution.compensatesExecutionId !== undefined) {
        return await processCompensation(execution, controller);
      }
      while (!closing && !controller.signal.aborted) {
        const providerInput = await raceAbort(options.inputSource.load(execution), controller.signal);
        if (
          providerInput.invocation.sourceMessageId !== execution.sourceMessageId ||
          providerInput.invocation.requesterActorId !== execution.requesterId ||
          providerInput.invocation.targetAgentId !== execution.agentId ||
          execution.providerId !== options.provider.id
        ) {
          throw Object.assign(new Error("provider_invalid_request"), {
            code: "provider_invalid_request",
          });
        }
        let text = "";
        let finishReason: "stop" | "tool_calls" | undefined;
        const calls: ToolCallAccumulator[] = [];
        const callsById = new Map<string, ToolCallAccumulator>();
        const iterator = options.provider.stream(providerInput, controller.signal)[Symbol.asyncIterator]();
        while (true) {
          const next = await raceAbort(iterator.next(), controller.signal);
          if (next.done) break;
          const event = next.value;
          if (closing || controller.signal.aborted) throw controller.signal.reason;
          if (event.type === "text_delta") {
            previewBytes += Buffer.byteLength(event.delta, "utf8");
            if (previewBytes > maxPreviewBytes) {
              throw Object.assign(new Error("provider_response_too_large"), {
                code: "provider_response_too_large",
              });
            }
            text += event.delta;
            if (previewEnabled && options.preview !== undefined) {
              previewSeq += 1;
              try {
                previewEnabled = await raceAbort(Promise.resolve(options.preview({
                  executionId: execution.id,
                  attemptSeq: execution.currentAttemptSeq,
                  streamSeq: previewSeq,
                  text: event.delta,
                })), controller.signal);
              } catch (error) {
                if (controller.signal.aborted) throw error;
                previewEnabled = false;
              }
            }
          } else if (event.type === "tool_call_delta") {
            let call = callsById.get(event.callId);
            if (call === undefined) {
              call = { callId: event.callId, toolId: event.toolId, arguments: "" };
              callsById.set(event.callId, call);
              calls.push(call);
            } else if (call.toolId !== event.toolId) {
              throw Object.assign(new Error("provider_invalid_response"), {
                code: "provider_invalid_response",
              });
            }
            call.arguments += event.argumentsDelta;
            if (Buffer.byteLength(call.arguments, "utf8") > providerInput.limits.maxOutputBytes) {
              throw Object.assign(new Error("provider_response_too_large"), {
                code: "provider_response_too_large",
              });
            }
          } else if (event.type === "completed") {
            finishReason = event.finishReason;
          }
        }
        if (closing || controller.signal.aborted) throw controller.signal.reason;
        if (finishReason === undefined) {
          throw Object.assign(new Error("provider_invalid_response"), {
            code: "provider_invalid_response",
          });
        }
        if ((finishReason === "stop") !== (calls.length === 0)) {
          throw Object.assign(new Error("provider_invalid_response"), {
            code: "provider_invalid_response",
          });
        }
        if (calls.length > providerInput.limits.maxToolCalls) {
          throw Object.assign(new Error("provider_response_too_large"), {
            code: "provider_response_too_large",
          });
        }
        if (finishReason === "stop" && text.trim().length === 0) {
          throw Object.assign(new Error("provider_invalid_response"), {
            code: "provider_invalid_response",
          });
        }

        const toolPlan: AgentRuntimeToolPlanEntry[] = [];
        for (const call of calls) {
          const adapter = tools.get(call.toolId);
          const authorizedDescriptor = providerInput.availableTools.find(
            (descriptor) => descriptor.id === call.toolId,
          );
          if (
            adapter === undefined ||
            authorizedDescriptor === undefined ||
            authorizedDescriptor.confirmationRequirement !==
              adapter.descriptor.confirmationRequirement
          ) {
            throw Object.assign(new Error("tool_failure"), { code: "tool_failure" });
          }
          let parameters: RuntimeJsonValue;
          try {
            parameters = JSON.parse(call.arguments) as RuntimeJsonValue;
          } catch {
            throw Object.assign(new Error("provider_invalid_response"), {
              code: "provider_invalid_response",
            });
          }
          toolPlan.push({ callId: call.callId, toolId: call.toolId, parameters });
        }
        if (Buffer.byteLength(canonicalJson(toolPlan as unknown as RuntimeJsonValue), "utf8") > 65_536) {
          throw Object.assign(new Error("provider_response_too_large"), {
            code: "provider_response_too_large",
          });
        }

        const generationSummary: RuntimeJsonValue = {
          finishReason,
          text,
          toolCalls: calls.map((call) => ({
            callId: call.callId,
            toolId: call.toolId,
            arguments: call.arguments,
          })),
        };
        execution = await commitStep(execution, {
          stepKind: "model_generation",
          inputSha256: sha256(providerInput as unknown as RuntimeJsonValue),
          outputSha256: sha256(generationSummary),
        });

        if (finishReason === "stop") {
          const now = clock.now();
          const completion: CompleteExecutionInput = {
            executionId: execution.id,
            attemptSeq: execution.currentAttemptSeq,
            messageId: options.createMessageId?.() ?? randomUUID(),
            body: text,
            sentAt: new Date(now).toISOString(),
            now,
          };
          await options.authority.completeExecution(options.runtimeContext, completion);
          return "terminal";
        }

        const toolResult = await executeToolPlan(execution, toolPlan, controller);
        if (toolResult.kind === "retry") return "retry";
        if (toolResult.kind !== "continue") return "terminal";
        execution = toolResult.execution;
      }
      return "terminal";
    } catch (error) {
      if (closing || controller.signal.aborted) return "terminal";
      const code = errorCode(error);
      if (isStaleAuthorityCode(code)) return "terminal";
      if (TRANSIENT_CODES.has(code)) {
        const retried = await options.authority.scheduleRetry(options.runtimeContext, {
          executionId: execution.id,
          attemptSeq: execution.currentAttemptSeq,
          errorCode: code as ScheduleRetryInput["errorCode"],
          now: clock.now(),
        });
        enqueueRetry(retried);
        return "retry";
      }
      await failTerminal(execution, terminalCode(code));
      return "terminal";
    } finally {
      activeControllers.delete(execution.id);
      activeExecutions.delete(execution.id);
    }
  };

  async function runRoom(roomId: string): Promise<void> {
    let keepOutstanding = false;
    let claimedExecutionId: string | undefined;
    let blocked = false;
    let claimFailed = false;
    try {
      if (closing) return;
      const execution = await options.authority.claimNext(
        options.runtimeContext,
        roomId,
        clock.now(),
      );
      if (execution !== undefined) {
        claimedExecutionId = execution.id;
        activeExecutions.set(execution.id, execution);
        keepOutstanding = (await processExecution(execution)) === "retry";
      } else if (
        !closing &&
        (coordinator.outstandingByRoom.get(roomId) ?? 0) > 0
      ) {
        const blockedRun = (): Promise<void> => {
          blockedRuns.delete(roomId);
          return runRoom(roomId);
        };
        blockedRuns.set(roomId, blockedRun);
        coordinator.block(roomId, blockedRun);
        blocked = true;
      }
    } catch {
      claimFailed = true;
      const retry = clock.wait(1_000, lifecycleAbort.signal).then(() => {
        if (!closing) scheduleRoom(roomId);
      }).catch(() => undefined);
      track(retry);
    } finally {
      if (blocked) {
        notifyIdle();
      } else {
        if (!keepOutstanding && claimedExecutionId !== undefined) {
          const releasedScheduledExecution = releaseOutstanding(roomId, claimedExecutionId);
          if (!releasedScheduledExecution && !closing &&
              (coordinator.outstandingByRoom.get(roomId) ?? 0) > 0) {
            scheduleRoom(roomId);
          }
        }
        const markers = markersByRoom.get(roomId) ?? 0;
        if (markers <= 1) markersByRoom.delete(roomId);
        else markersByRoom.set(roomId, markers - 1);
        notifyIdle();
        if (claimedExecutionId !== undefined) coordinator.wake(roomId);
        if (claimFailed) notifyIdle();
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (closing) throw new AgentRuntimeClosedError();
      const now = clock.now();
      let cursor: string | undefined;
      do {
        const page = await options.authority.recoverPage(options.runtimeContext, {
          now, limit: 64, ...(cursor === undefined ? {} : { cursor }),
        });
        for (const { execution, nextRetryAt } of page.recoveries) {
          if (execution.status !== "queued") continue;
          if (coordinator.scheduledExecutionIds.has(execution.id)) continue;
          coordinator.scheduledExecutionIds.add(execution.id);
          localScheduledExecutions.set(execution.id, execution.roomId);
          coordinator.outstandingByRoom.set(
            execution.roomId,
            (coordinator.outstandingByRoom.get(execution.roomId) ?? 0) + 1,
          );
          if (execution.retryOrdinal === 1) scheduleRoom(execution.roomId);
          else enqueueRetry(execution, nextRetryAt);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined && !closing);
    },

    async invoke(context, input): Promise<AgentExecution> {
      if (closing) throw new AgentRuntimeClosedError();
      if (input.targetAgentId !== options.runtimeContext.agentId) {
        throw Object.assign(new Error("agent_capability_forbidden"), {
          code: "agent_capability_forbidden",
          status: 403,
        });
      }
      try {
        const execution = await options.authority.invoke(context, input, maxQueuedPerRoom);
        if (execution.status !== "queued" || coordinator.scheduledExecutionIds.has(execution.id)) {
          return execution;
        }
        coordinator.scheduledExecutionIds.add(execution.id);
        localScheduledExecutions.set(execution.id, execution.roomId);
        coordinator.outstandingByRoom.set(
          execution.roomId,
          (coordinator.outstandingByRoom.get(execution.roomId) ?? 0) + 1,
        );
        scheduleRoom(execution.roomId);
        return execution;
      } catch (error) {
        if (errorCode(error) === "target_busy") throw new AgentRuntimeQueueFullError(1_000);
        throw error;
      }
    },

    async interrupt(context, executionId, reason): Promise<AgentExecution> {
      const execution = await options.authority.interrupt(context, {
        executionId,
        reason,
      });
      if (activeSideEffects.has(executionId)) interruptedSideEffects.add(executionId);
      activeControllers.get(executionId)?.abort(new Error("provider_cancelled"));
      return execution;
    },

    async retry(context, executionId): Promise<AgentExecution> {
      if (closing) throw new AgentRuntimeClosedError();
      const execution = await options.authority.manualRetry(context, executionId, maxQueuedPerRoom);
      if (execution.status === "queued" && !coordinator.scheduledExecutionIds.has(execution.id)) {
        coordinator.scheduledExecutionIds.add(execution.id);
        localScheduledExecutions.set(execution.id, execution.roomId);
        coordinator.outstandingByRoom.set(
          execution.roomId,
          (coordinator.outstandingByRoom.get(execution.roomId) ?? 0) + 1,
        );
        scheduleRoom(execution.roomId);
      }
      return execution;
    },

    async compensate(context, executionId, dispatchId): Promise<AgentExecution> {
      if (closing) throw new AgentRuntimeClosedError();
      const execution = await options.authority.compensate(
        context, executionId, dispatchId, maxQueuedPerRoom,
      );
      if (execution.status === "queued" && !coordinator.scheduledExecutionIds.has(execution.id)) {
        coordinator.scheduledExecutionIds.add(execution.id);
        localScheduledExecutions.set(execution.id, execution.roomId);
        coordinator.outstandingByRoom.set(
          execution.roomId,
          (coordinator.outstandingByRoom.get(execution.roomId) ?? 0) + 1,
        );
        scheduleRoom(execution.roomId);
      }
      return execution;
    },

    async confirmTool(context, input): Promise<AgentExecution> {
      if (closing) throw new AgentRuntimeClosedError();
      const confirmation = await options.authority.confirmTool(context, input);
      const confirmedAdapter = tools.get(confirmation.toolId);
      if (
        confirmedAdapter === undefined ||
        confirmedAdapter.descriptor.confirmationRequirement !== "side_effect"
      ) {
        throw Object.assign(new Error("tool_failure"), { code: "tool_failure" });
      }
      if (!coordinator.scheduledConfirmationIds.has(confirmation.id)) {
        coordinator.scheduledConfirmationIds.add(confirmation.id);
        markersByRoom.set(confirmation.roomId, (markersByRoom.get(confirmation.roomId) ?? 0) + 1);
        let resolveJob = (): void => undefined;
        const job = new Promise<void>((resolve) => { resolveJob = resolve; });
        confirmationJobs.set(confirmation.id, job);
        coordinator.enqueue(confirmation.roomId, async () => {
          let resumed: Awaited<ReturnType<AgentRuntimeSchedulerAuthority["resumeConfirmedTool"]>> | undefined;
          let adapterResolved = false;
          let resolvedSealedCompensation: string | undefined;
          const controller = new AbortController();
          activeControllers.set(confirmation.executionId, controller);
          try {
            if (closing) return;
            resumed = await options.authority.resumeConfirmedTool(options.runtimeContext, {
              confirmationId: confirmation.id,
              executionId: confirmation.executionId,
              attemptSeq: confirmation.attemptSeq,
              roomId: confirmation.roomId,
              toolId: confirmation.toolId,
              parameterHash: confirmation.parameterHash,
              toolPlanHash: confirmation.toolPlanHash,
              now: clock.now(),
            } satisfies ResumeConfirmedToolInput);
            if (closing || controller.signal.aborted) {
              await options.authority.settleTool(options.runtimeContext, {
                dispatchId: resumed.dispatch.id,
                executionId: resumed.execution.id,
                attemptSeq: resumed.execution.currentAttemptSeq,
                grantId: resumed.dispatch.grantId,
                outcome: "outcome_unknown",
                closedSummary: "runtime_closed_before_adapter",
                now: clock.now(),
              });
              return;
            }
            if (sha256({
              toolId: resumed.dispatch.toolId,
              parameters: resumed.parameters,
              remainingCalls: resumed.remainingCalls,
            } as unknown as RuntimeJsonValue) !== resumed.toolPlanHash) {
              throw new TypeError("Agent runtime confirmed tool plan failed integrity validation");
            }
            if (
              resumed.confirmationId !== confirmation.id ||
              resumed.execution.id !== confirmation.executionId ||
              resumed.execution.roomId !== confirmation.roomId ||
              resumed.execution.currentAttemptSeq !== confirmation.attemptSeq ||
              resumed.execution.status !== "running" ||
              resumed.execution.actionCategory !== "tool_call" ||
              resumed.execution.toolDispatchPhase !== "dispatched" ||
              resumed.execution.currentToolId !== confirmation.toolId ||
              resumed.dispatch.executionId !== confirmation.executionId ||
              resumed.dispatch.attemptSeq !== confirmation.attemptSeq ||
              resumed.dispatch.state !== "dispatched" ||
              resumed.dispatch.toolId !== confirmation.toolId ||
              resumed.dispatch.parameterHash !== confirmation.parameterHash ||
              resumed.dispatch.parameterHash !== sha256(resumed.parameters as RuntimeJsonValue)
            ) {
              throw Object.assign(new Error("tool_failure"), { code: "tool_failure" });
            }
            const adapter = tools.get(resumed.dispatch.toolId);
            if (
              adapter === undefined ||
              adapter !== confirmedAdapter ||
              adapter.descriptor.confirmationRequirement !== "side_effect"
            ) {
              throw Object.assign(new Error("tool_failure"), { code: "tool_failure" });
            }
            activeExecutions.set(resumed.execution.id, resumed.execution);
            activeSideEffects.add(resumed.execution.id);
            try {
              const outcome = await adapter.execute(
                resumed.parameters as RuntimeJsonValue,
                controller.signal,
              );
              adapterResolved = true;
              resolvedSealedCompensation = outcome.sealedCompensation;
              await options.authority.settleTool(options.runtimeContext, {
                dispatchId: resumed.dispatch.id, executionId: resumed.execution.id,
                attemptSeq: resumed.execution.currentAttemptSeq, grantId: resumed.dispatch.grantId,
                outcome: "succeeded", closedSummary: outcome.closedSummary, now: clock.now(),
                ...(outcome.sealedCompensation === undefined ? {} : { sealedCompensation: outcome.sealedCompensation }),
              });
              if (
                !closing &&
                !controller.signal.aborted &&
                !interruptedSideEffects.has(resumed.execution.id)
              ) {
                const continued = await commitStep(resumed.execution, {
                  stepKind: "tool_result", dispatchId: resumed.dispatch.id,
                  boundedToolResult: outcome.modelInput, inputSha256: resumed.dispatch.parameterHash,
                  outputSha256: sha256(outcome.modelInput),
                });
                const remaining = await executeToolPlan(
                  continued,
                  resumed.remainingCalls,
                  controller,
                );
                if (remaining.kind === "continue") {
                  scheduleRunningExecution(remaining.execution);
                }
              }
            } catch (error: unknown) {
              const effectUnknown = adapterEffectOutcomeUnknown(error);
              const interrupted = closing || controller.signal.aborted ||
                interruptedSideEffects.has(resumed.execution.id);
              const outcomeUnknown = effectUnknown !== undefined || adapterResolved || interrupted;
              const sealedCompensation =
                effectUnknown?.sealedCompensation ?? resolvedSealedCompensation;
              await options.authority.settleTool(options.runtimeContext, {
                dispatchId: resumed.dispatch.id, executionId: resumed.execution.id,
                attemptSeq: resumed.execution.currentAttemptSeq, grantId: resumed.dispatch.grantId,
                outcome: outcomeUnknown ? "outcome_unknown" : "failed",
                closedSummary: effectUnknown !== undefined
                  ? "tool_effect_unconfirmed"
                  : adapterResolved
                    ? "tool_settlement_unconfirmed"
                  : interrupted
                    ? "runtime_closed_before_adapter_settlement"
                    : "tool_failure",
                now: clock.now(),
                ...(sealedCompensation === undefined
                  ? {}
                  : { sealedCompensation }),
              }).catch(() => undefined);
            } finally {
              activeControllers.delete(resumed.execution.id);
              activeExecutions.delete(resumed.execution.id);
              activeSideEffects.delete(resumed.execution.id);
              interruptedSideEffects.delete(resumed.execution.id);
            }
          } catch (error) {
            if (resumed !== undefined) {
              await options.authority.settleTool(options.runtimeContext, {
                dispatchId: resumed.dispatch.id,
                executionId: resumed.execution.id,
                attemptSeq: resumed.execution.currentAttemptSeq,
                grantId: resumed.dispatch.grantId,
                outcome: adapterResolved ? "outcome_unknown" : "failed",
                closedSummary: adapterResolved ? "tool_settlement_unconfirmed" : "tool_failure",
                now: clock.now(),
                ...(resolvedSealedCompensation === undefined
                  ? {}
                  : { sealedCompensation: resolvedSealedCompensation }),
              }).catch(() => undefined);
            }
            if (errorCode(error) !== "execution_conflict") throw error;
          } finally {
            coordinator.scheduledConfirmationIds.delete(confirmation.id);
            activeControllers.delete(confirmation.executionId);
            const markers = markersByRoom.get(confirmation.roomId) ?? 0;
            if (markers <= 1) markersByRoom.delete(confirmation.roomId);
            else markersByRoom.set(confirmation.roomId, markers - 1);
            notifyIdle();
            coordinator.wake(confirmation.roomId);
            resolveJob();
            confirmationJobs.delete(confirmation.id);
          }
        });
      }
      return options.authority.readExecution(context, input.executionId);
    },

    whenIdle(): Promise<void> {
      if (tasks.size === 0 && markersByRoom.size === 0 && activeExecutions.size === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },

    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      const terminalWrites = Promise.allSettled(
        [...activeExecutions.values()].filter((execution) => !activeSideEffects.has(execution.id)).map((execution) =>
          options.authority.failExecution(options.runtimeContext, {
            executionId: execution.id,
            attemptSeq: execution.currentAttemptSeq,
            errorCode: "provider_cancelled",
            now: clock.now(),
          }),
        ),
      );
      lifecycleAbort.abort(new Error("runtime_closed"));
      for (const [roomId, blockedRun] of blockedRuns) {
        coordinator.unblock(roomId, blockedRun);
      }
      blockedRuns.clear();
      for (const [executionId, roomId] of localScheduledExecutions) {
        releaseOutstanding(roomId, executionId);
      }
      for (const roomId of [...markersByRoom.keys()]) markersByRoom.delete(roomId);
      for (const controller of activeControllers.values()) {
        controller.abort(new Error("runtime_closed"));
      }
      const pending = Promise.allSettled([terminalWrites, ...tasks, ...confirmationJobs.values()]);
      const timeoutController = new AbortController();
      await Promise.race([
        pending,
        clock.wait(closeTimeoutMs, timeoutController.signal).catch(() => undefined),
      ]);
      timeoutController.abort();
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    },
  };
}
