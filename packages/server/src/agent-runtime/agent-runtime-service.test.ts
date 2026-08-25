import { describe, expect, it, vi } from "vitest";
import type { AgentExecution, AgentInvocationIntent, AgentRuntimeProviderInput, ProviderEvent } from "@native-im/core";
import type { AuthenticatedCommandContext } from "../persistence/contracts.js";
import {
  AgentRuntimeError,
  type ProviderAdapter,
  type RuntimeAuthority,
  type RuntimeClock,
  type RuntimeRecoveryAuthority,
  type ToolAdapter,
} from "./contracts.js";
import { createAgentRuntimeService } from "./agent-runtime-service.js";
import { createToolGateway } from "./tool-gateway.js";
import { RoomMemoryReadError } from "./room-memory-read-tool.js";

const context: AuthenticatedCommandContext = {
  kind: "human",
  sessionId: "session-1",
  sessionFamilyId: "family-1",
  principal: { accountId: "account-1", actorId: "human-1" },
  requestId: "request-1",
  idempotencyKey: "key-1",
};

function intent(
  roomId: string,
  sourceMessageId: string,
  targetAgentId = `agent-${roomId}`,
): AgentInvocationIntent {
  return { kind: "direct_mention", roomId, sourceMessageId, targetAgentId };
}

function execution(id: string, roomId: string, attempt = 1, retryOrdinal: 1 | 2 | 3 = 1): AgentExecution {
  const now = "2026-08-17T00:00:00.000Z";
  return {
    id,
    roomId,
    sourceMessageId: `message-${id}`,
    requesterId: "human-1",
    agentId: `agent-${roomId}`,
    toolName: "model.generate",
    status: "queued",
    actionCategory: "model_generation",
    currentAttemptSeq: attempt,
    retryCycle: 1,
    retryOrdinal,
    providerId: "fake-provider",
    modelId: "fake-model",
    recoveryCursor: 0,
    queuedAt: now,
    updatedAt: now,
  };
}

const emptyRoomMemoryContext = {
  status: {
    roomId: "room-a",
    health: { state: "healthy", reason: "none", memoryWatermark: 0, corpusHead: 0,
      lag: 0, lastAttemptAt: null, retryable: false, recoveryRequired: false },
    recoveryGeneration: 1,
    updatedAt: "2026-08-20T00:00:00.000Z",
  },
  injectableSnapshot: [],
  rawDelta: { roomId: "room-a", fromWatermarkExclusive: 0, toCorpusSeqInclusive: 0,
    authorizationEpoch: 0, cursor: null, entries: [], nextCursor: null, hasMore: false },
} as const;

function authority(): RuntimeAuthority & { executions: Map<string, AgentExecution> } {
  const executions = new Map<string, AgentExecution>();
  let next = 0;
  return {
    executions,
    async readContext() {
      return { visibleConversation: [], toolIds: [], openItemTargets: [],
        roomMemory: emptyRoomMemoryContext };
    },
    async readMemoryDelta() { return emptyRoomMemoryContext.rawDelta; },
    beginCompensation: vi.fn(),
    readPendingConfirmation: vi.fn(),
    async invoke(_context, invocation) {
      next += 1;
      const value = { ...execution(`execution-${next}`, invocation.roomId),
        sourceMessageId: invocation.sourceMessageId, agentId: invocation.targetAgentId };
      executions.set(value.id, value);
      return { execution: value, intent: invocation, replayed: false };
    },
    invokeRouted: vi.fn(),
    enqueueFenceReplacements: vi.fn(),
    async claim(id, attemptSeq) {
      const value = executions.get(id)!;
      if (value.currentAttemptSeq !== attemptSeq || value.status !== "queued") throw new AgentRuntimeError("execution_conflict", "stale");
      const running = { ...value, status: "running" as const, startedAt: value.queuedAt };
      executions.set(id, running);
      return running;
    },
    async complete(id, attemptSeq) {
      const value = executions.get(id)!;
      if (value.currentAttemptSeq !== attemptSeq || value.status !== "running") throw new AgentRuntimeError("execution_conflict", "stale");
      const completed = { ...value, status: "completed" as const, completedAt: value.queuedAt, resultMessageId: `result-${id}` };
      executions.set(id, completed);
      return completed;
    },
    async scheduleRetry(id, attemptSeq, errorCode, nextRetryAt) {
      const value = executions.get(id)!;
      if (value.currentAttemptSeq !== attemptSeq) throw new AgentRuntimeError("execution_conflict", "stale");
      if (value.retryOrdinal === 3 || nextRetryAt === undefined) {
        const failed = { ...value, status: "failed" as const, completedAt: value.queuedAt, terminalErrorCode: errorCode, deadLetteredAt: value.queuedAt };
        executions.set(id, failed);
        return failed;
      }
      const queued = {
        ...value,
        status: "queued" as const,
        currentAttemptSeq: value.currentAttemptSeq + 1,
        retryOrdinal: (value.retryOrdinal + 1) as 2 | 3,
        nextRetryAt,
      };
      executions.set(id, queued);
      return queued;
    },
    async interrupt(_context, id, reason) {
      const value = executions.get(id)!;
      if (value.status === "completed" || value.status === "failed" || value.status === "cancelled") return value;
      const cancelled = { ...value, status: "cancelled" as const, completedAt: value.queuedAt, cancellationReason: reason };
      executions.set(id, cancelled);
      return cancelled;
    },
    cancelScoped: vi.fn(),
    async shutdown(id, attemptSeq) {
      const value = executions.get(id)!;
      if (value.currentAttemptSeq !== attemptSeq) throw new AgentRuntimeError("execution_conflict", "stale");
      const cancelled = {
        ...value,
        status: "cancelled" as const,
        completedAt: value.queuedAt,
        cancellationReason: "runtime_shutdown",
      };
      executions.set(id, cancelled);
      return cancelled;
    },
    retry: vi.fn(), prepareTool: vi.fn(), claimTool: vi.fn(), settleTool: vi.fn(),
    checkpoint: vi.fn(), recover: vi.fn(async () => []),
  };
}

function provider(run: (input: AgentRuntimeProviderInput, signal: AbortSignal) => AsyncIterable<ProviderEvent>): ProviderAdapter {
  return { id: "fake-provider", stream: run };
}

const providerInput = async (value: AgentExecution, invocation: AgentInvocationIntent): Promise<AgentRuntimeProviderInput> => ({
  purpose: "agent_runtime",
  schemaVersion: "compiled-context-envelope.v1",
  snapshot: {
    snapshotId: `snapshot-${value.id}`,
    generation: 1,
    manifestHash: "a".repeat(64),
    compilerVersion: "context_compiler_v1",
    configVersion: "ft06_test_v1",
    modelId: "fake-model",
  },
  invocation,
  trusted: {
    system: [{ kind: "product_policy", text: "Follow authority." }],
    developer: [{ kind: "citation_contract", data: { kind: "manifest_labels_only" } }],
  },
  groupContent: [{
    kind: "trigger",
    trust: "untrusted_group_content",
    source: { label: "ctx-0001", kind: "message", revision: 1 },
    content: "bounded",
    speaker: { actorId: value.requesterId, kind: "human" },
  }],
  projectContext: { status: "disabled", reason: "ft09_not_delivered" },
  availableTools: [],
  committedSteps: [],
  limits: {
    maxInputBytes: 4_096, compiledInputTokens: 512, maxContextInputTokens: 3_072,
    maxOutputTokens: 256, maxOutputBytes: 1_024, timeoutMs: 5_000,
  },
});

const providerInputWithTools = (
  availableTools: AgentRuntimeProviderInput["availableTools"],
) => async (value: AgentExecution, invocation: AgentInvocationIntent): Promise<AgentRuntimeProviderInput> => ({
  ...(await providerInput(value, invocation)),
  availableTools,
});

describe("bounded Agent runtime scheduler", () => {
  it("reports noauth before creating work and never falls back to a provider mock", async () => {
    const runtimeAuthority = authority();
    const stream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: "completed", sequence: 1 };
    });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(stream),
      modelId: "configured-model",
      buildProviderInput: providerInput,
      readiness: () => "noauth",
    });
    await expect(runtime.invoke(context, intent("room-a", "a-noauth"))).rejects.toMatchObject({
      code: "agent_configuration_missing",
      status: 503,
    });
    expect(runtimeAuthority.executions.size).toBe(0);
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(["direct", "routed"] as const)(
    "re-enqueues a %s invocation replay when the durable execution is absent locally",
    async (kind) => {
      const runtimeAuthority = authority();
      const replayIntent = intent("room-replay", `source-${kind}`);
      const replayExecution = {
        ...execution(`execution-replay-${kind}`, replayIntent.roomId),
        sourceMessageId: replayIntent.sourceMessageId,
        agentId: replayIntent.targetAgentId,
      };
      runtimeAuthority.executions.set(replayExecution.id, replayExecution);
      const accepted = { execution: replayExecution, intent: replayIntent, replayed: true };
      runtimeAuthority.invoke = vi.fn(async () => accepted);
      runtimeAuthority.invokeRouted = vi.fn(async () => accepted);
      const stream = vi.fn(async function* () {
        yield { type: "response_started" as const, sequence: 1 };
        yield { type: "agent_final" as const, sequence: 2, body: "replayed", citations: [] };
      });
      const runtime = createAgentRuntimeService({
        authority: runtimeAuthority,
        provider: provider(stream),
        modelId: "fake-model",
        buildProviderInput: providerInput,
      });

      if (kind === "direct") await runtime.invoke(context, replayIntent);
      else await runtime.invokeRouted("route-replay", replayIntent);
      await runtime.whenIdle();

      expect(stream).toHaveBeenCalledTimes(1);
      expect(runtimeAuthority.executions.get(replayExecution.id)?.status).toBe("completed");
    },
  );

  it("keeps a committed retry ACK durable when local admission fills after commit", async () => {
    const runtimeAuthority = authority();
    let started!: () => void;
    const sawStart = new Promise<void>((resolve) => { started = resolve; });
    const recoveryScan = vi.fn(async () => ({ candidates: [], hasMore: false }));
    const recoveryAuthority: RuntimeRecoveryAuthority = {
      scan: recoveryScan,
      isolate: vi.fn(async () => undefined),
    };
    const childIntent = intent("room-full-after-commit", "retry-child");
    const childExecution = {
      ...execution("execution-durable-child", childIntent.roomId),
      sourceMessageId: childIntent.sourceMessageId,
      agentId: childIntent.targetAgentId,
    };
    runtimeAuthority.retry = vi.fn(async () => {
      runtimeAuthority.executions.set(childExecution.id, childExecution);
      return {
        execution: childExecution,
        intent: childIntent,
        replayed: false,
        retryReceipt: {
          requestId: context.requestId,
          sourceExecutionId: "terminal-parent",
          executionId: childExecution.id,
          intentId: "intent-durable-retry",
          lineageId: "lineage-durable-retry",
          roomId: childExecution.roomId,
          executionOrdinal: 2,
          snapshotId: "snapshot-durable-retry",
          status: "accepted",
          createdAt: childExecution.queuedAt,
        },
      };
    });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      recoveryAuthority,
      provider: provider(async function* (_input, signal) {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        yield { type: "response_started", sequence: 1 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      limits: { maxActive: 1, maxQueuedPerRoom: 1, maxPartialBytes: 1_024 },
    });
    await runtime.invoke(context, intent("room-full-after-commit", "active"));
    await sawStart;
    await runtime.invoke(
      { ...context, requestId: "queued", idempotencyKey: "queued" },
      intent("room-full-after-commit", "queued"),
    );

    await expect(runtime.retryInvocation(context, "terminal-parent", 7)).resolves.toMatchObject({
      execution: { id: childExecution.id }, replayed: false,
    });
    await vi.waitFor(() => expect(recoveryScan).toHaveBeenCalled());
    expect(runtimeAuthority.executions.get(childExecution.id)?.status).toBe("queued");
    await runtime.close();
  });

  it("terminalizes an invalidated frozen snapshot before any Provider stream begins", async () => {
    const runtimeAuthority = authority();
    const stream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: "response_started", sequence: 1 };
    });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(stream),
      modelId: "fake-model",
      async buildProviderInput() {
        throw new AgentRuntimeError(
          "context_snapshot_invalidated", "Frozen context snapshot was invalidated",
        );
      },
    });

    const accepted = await runtime.invoke(context, intent("room-a", "invalidated"));
    await runtime.whenIdle();

    expect(stream).not.toHaveBeenCalled();
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
      status: "failed", terminalErrorCode: "context_snapshot_invalidated",
    });
  });

  it("keeps Provider call count zero when the frozen handoff claim gate rejects", async () => {
    const runtimeAuthority = authority();
    runtimeAuthority.claim = vi.fn(async () => {
      throw new AgentRuntimeError("permission_denied", "Frozen Agent authority changed");
    });
    runtimeAuthority.scheduleRetry = vi.fn(runtimeAuthority.scheduleRetry);
    const stream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: "response_started", sequence: 1 };
    });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(stream),
      modelId: "fake-model",
      buildProviderInput: providerInput,
    });

    await runtime.invoke(context, intent("room-a", "frozen-claim-rejected"));
    await runtime.whenIdle();

    expect(stream).not.toHaveBeenCalled();
    expect(runtimeAuthority.scheduleRetry).toHaveBeenCalledWith(
      "execution-1", 1, "permission_denied", undefined,
    );
  });

  it("runs FIFO within a room while allowing bounded cross-room parallelism", async () => {
    const runtimeAuthority = authority();
    const complete = vi.spyOn(runtimeAuthority, "complete");
    const order: string[] = [];
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (input) {
        order.push(`start:${input.invocation.sourceMessageId}`);
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "ok", citations: ["ctx-0001"] };
        order.push(`done:${input.invocation.sourceMessageId}`);
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      limits: { maxActive: 2, maxQueuedPerRoom: 2, maxPartialBytes: 1_024 },
    });
    await Promise.all([
      runtime.invoke(context, intent("room-a", "a-1")),
      runtime.invoke({ ...context, requestId: "r2", idempotencyKey: "k2" }, intent("room-a", "a-2")),
      runtime.invoke({ ...context, requestId: "r3", idempotencyKey: "k3" }, intent("room-b", "b-1")),
    ]);
    await runtime.whenIdle();
    expect(order.indexOf("done:a-1")).toBeLessThan(order.indexOf("start:a-2"));
    expect(complete.mock.calls.every((call) => call[2] === "ok" &&
      JSON.stringify(call[3]) === JSON.stringify(["ctx-0001"]))).toBe(true);
    expect([...runtimeAuthority.executions.values()].every((value) => value.status === "completed")).toBe(true);
  });

  it("runs different Agents from the same turn concurrently while keeping each Agent FIFO", async () => {
    const runtimeAuthority = authority();
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (input) {
        started.push(input.invocation.targetAgentId);
        if (started.length < 2) await blocked;
        else release();
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "ok", citations: [] };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      limits: { maxActive: 2, maxQueuedPerRoom: 4, maxPartialBytes: 1_024 },
    });

    await Promise.all([
      runtime.invoke(context, intent("room-a", "same-turn", "agent-a")),
      runtime.invoke(
        { ...context, requestId: "same-turn-2", idempotencyKey: "same-turn-2" },
        intent("room-a", "same-turn", "agent-b"),
      ),
    ]);
    await runtime.whenIdle();

    expect(started).toEqual(["agent-a", "agent-b"]);
    expect([...runtimeAuthority.executions.values()].every((value) => value.status === "completed"))
      .toBe(true);
  });

  it("caps default global Provider concurrency at eight", async () => {
    const runtimeAuthority = authority();
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (input) {
        started.push(input.invocation.sourceMessageId);
        await blocked;
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "ok", citations: [] };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
    });

    await Promise.all(Array.from({ length: 9 }, (_, index) => runtime.invoke(
      { ...context, requestId: `global-${index}`, idempotencyKey: `global-${index}` },
      intent(`room-global-${index}`, `source-${index}`, `agent-${index}`),
    )));
    await vi.waitFor(() => expect(started).toHaveLength(8));
    expect(started).toHaveLength(8);

    release();
    await runtime.whenIdle();
    expect(started).toHaveLength(9);
  });

  it("returns a closed 429 before creating an execution when the room queue is full", async () => {
    const runtimeAuthority = authority();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* () {
        yield { type: "response_started", sequence: 1 };
        await blocked;
        yield { type: "agent_final", sequence: 2, body: "ok", citations: [] };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      limits: { maxActive: 1, maxQueuedPerRoom: 1, maxPartialBytes: 1_024 },
    });
    await runtime.invoke(context, intent("room-a", "a-1"));
    await runtime.invoke({ ...context, requestId: "r2", idempotencyKey: "k2" }, intent("room-a", "a-2"));
    await expect(runtime.invoke(
      { ...context, requestId: "r3", idempotencyKey: "k3" },
      intent("room-a", "a-3"),
    )).rejects.toMatchObject({ code: "agent_queue_full", status: 429, retryAfterMs: 1_000 });
    expect(runtimeAuthority.executions.size).toBe(2);
    release();
    await runtime.whenIdle();
  });

  it("caps durable per-Room admission at 32 including active work", async () => {
    const runtimeAuthority = authority();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* () {
        await blocked;
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "ok", citations: [] };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
    });

    for (let index = 0; index < 32; index += 1) {
      await runtime.invoke(
        { ...context, requestId: `admission-${index}`, idempotencyKey: `admission-${index}` },
        intent("room-admission", `source-${index}`, `agent-${index}`),
      );
    }
    await expect(runtime.invoke(
      { ...context, requestId: "admission-overflow", idempotencyKey: "admission-overflow" },
      intent("room-admission", "source-overflow", "agent-overflow"),
    )).rejects.toMatchObject({ code: "agent_queue_full", status: 429 });
    expect(runtimeAuthority.executions.size).toBe(32);

    release();
    await runtime.whenIdle();
  });

  it("retries only transient failures at 1s and 4s then dead-letters attempt 3", async () => {
    const runtimeAuthority = authority();
    const resetPreview = vi.fn();
    const waits: number[] = [];
    const clock: RuntimeClock = {
      now: vi.fn(() => Date.parse("2026-08-17T00:00:00.000Z")),
      wait: vi.fn(async (milliseconds) => { waits.push(milliseconds); }),
    };
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* () {
        await Promise.reject(new AgentRuntimeError("provider_unavailable", "closed"));
        yield { type: "completed", sequence: 1 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      clock,
      resetPreview,
    });
    const accepted = await runtime.invoke(context, intent("room-a", "a-1"));
    await runtime.whenIdle();
    expect(waits).toEqual([1_000, 4_000]);
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
      status: "failed",
      currentAttemptSeq: 3,
      retryOrdinal: 3,
      terminalErrorCode: "provider_unavailable",
    });
    expect(resetPreview.mock.calls.map(([reset]) => reset)).toEqual([
      expect.objectContaining({ attemptSeq: 1, reason: "attempt_rolled_over" }),
      expect.objectContaining({ attemptSeq: 2, reason: "attempt_rolled_over" }),
      expect.objectContaining({ attemptSeq: 3, reason: "execution_terminal" }),
    ]);
  });

  it("persists a timeout retry decision before aborting the Provider attempt", async () => {
    const runtimeAuthority = authority();
    const ordering: string[] = [];
    const originalScheduleRetry = runtimeAuthority.scheduleRetry.bind(runtimeAuthority);
    runtimeAuthority.scheduleRetry = vi.fn(async (...args) => {
      ordering.push(`persist:${args[1]}`);
      return originalScheduleRetry(...args);
    });
    const waits: number[] = [];
    const clock: RuntimeClock = {
      now: () => Date.parse("2026-08-17T00:00:00.000Z"),
      wait: vi.fn(async (milliseconds) => { waits.push(milliseconds); }),
    };
    let dispatches = 0;
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (_input, signal) {
        dispatches += 1;
        if (dispatches === 1) {
          signal.addEventListener("abort", () => {
            ordering.push("abort:1");
          }, { once: true });
          await new Promise<void>(() => undefined);
        }
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "recovered", citations: [] };
      }),
      modelId: "fake-model",
      async buildProviderInput(value, invocationValue) {
        return {
          ...(await providerInput(value, invocationValue)),
          limits: { ...(await providerInput(value, invocationValue)).limits, timeoutMs: 10 },
        };
      },
      clock,
    });

    const accepted = await runtime.invoke(context, intent("room-timeout", "timeout"));
    await runtime.whenIdle();

    expect(ordering.slice(0, 2)).toEqual(["persist:1", "abort:1"]);
    expect(waits).toEqual([1_000]);
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
      status: "completed", currentAttemptSeq: 2,
    });
  });

  it("gates a late Provider final while a failed timeout transition is retried and committed", async () => {
    const runtimeAuthority = authority();
    const originalScheduleRetry = runtimeAuthority.scheduleRetry.bind(runtimeAuthority);
    const complete = vi.spyOn(runtimeAuthority, "complete");
    let persistenceCalls = 0;
    let firstPersistenceFailed!: () => void;
    const firstPersistenceFailure = new Promise<void>((resolve) => {
      firstPersistenceFailed = resolve;
    });
    runtimeAuthority.scheduleRetry = vi.fn(async (...args) => {
      persistenceCalls += 1;
      ordering.push(`persist:${persistenceCalls}`);
      if (persistenceCalls === 1) {
        firstPersistenceFailed();
        throw new AgentRuntimeError("context_storage_unavailable", "authority unavailable");
      }
      return originalScheduleRetry(...args);
    });
    const ordering: string[] = [];
    const waits: number[] = [];
    let releasePersistenceRetry!: () => void;
    const persistenceRetry = new Promise<void>((resolve) => {
      releasePersistenceRetry = resolve;
    });
    let lateFinalOffered!: () => void;
    const lateFinal = new Promise<void>((resolve) => {
      lateFinalOffered = resolve;
    });
    let dispatches = 0;
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (_input, signal) {
        dispatches += 1;
        if (dispatches === 1) {
          signal.addEventListener("abort", () => { ordering.push("abort"); }, { once: true });
          yield { type: "response_started", sequence: 1 };
          await firstPersistenceFailure;
          ordering.push("late-final");
          lateFinalOffered();
          yield { type: "agent_final", sequence: 2, body: "must-not-commit", citations: [] };
          return;
        }
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "recovered", citations: [] };
      }),
      modelId: "fake-model",
      async buildProviderInput(value, invocationValue) {
        return {
          ...(await providerInput(value, invocationValue)),
          limits: { ...(await providerInput(value, invocationValue)).limits, timeoutMs: 10 },
        };
      },
      clock: {
        now: () => Date.parse("2026-08-17T00:00:00.000Z"),
        wait: vi.fn(async (milliseconds) => {
          waits.push(milliseconds);
          if (waits.length === 1) await persistenceRetry;
        }),
      },
    });

    const accepted = await runtime.invoke(context, intent("room-timeout-storage", "timeout-storage"));
    await lateFinal;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ordering).toEqual(["persist:1", "late-final"]);
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({ status: "running" });
    expect(complete).not.toHaveBeenCalled();
    expect(runtimeAuthority.prepareTool).not.toHaveBeenCalled();
    expect(runtimeAuthority.checkpoint).not.toHaveBeenCalled();

    releasePersistenceRetry();
    await runtime.whenIdle();

    expect(ordering).toEqual(["persist:1", "late-final", "persist:2", "abort"]);
    expect(waits).toEqual([1_000, 1_000]);
    expect(runtimeAuthority.scheduleRetry).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(accepted.execution.id, 2, "recovered", []);
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
      status: "completed", currentAttemptSeq: 2,
    });
  });

  it("rejects duplicate citation labels and mixed preview/final output before authority commit", async () => {
    const malformedStreams = [
      provider(async function* () {
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "answer", citations: ["ctx-0001", "ctx-0001"] };
      }),
      provider(async function* () {
        yield { type: "response_started", sequence: 1 };
        yield { type: "text_delta", sequence: 2, delta: "preview" };
        yield { type: "agent_final", sequence: 3, body: "answer", citations: [] };
      }),
    ];
    for (const [index, malformedProvider] of malformedStreams.entries()) {
      const runtimeAuthority = authority();
      const complete = vi.spyOn(runtimeAuthority, "complete");
      const runtime = createAgentRuntimeService({
        authority: runtimeAuthority,
        provider: malformedProvider,
        modelId: "fake-model",
        buildProviderInput: providerInput,
      });
      const accepted = await runtime.invoke(
        { ...context, requestId: `malformed-${index}`, idempotencyKey: `malformed-${index}` },
        intent("room-a", `malformed-${index}`),
      );
      await runtime.whenIdle();
      expect(complete).not.toHaveBeenCalled();
      expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
        status: "failed",
        terminalErrorCode: "provider_malformed",
      });
    }
  });

  it("sorts distinct provider citations before the authority final boundary", async () => {
    const runtimeAuthority = authority();
    const complete = vi.spyOn(runtimeAuthority, "complete");
    const resetPreview = vi.fn();
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* () {
        yield { type: "response_started", sequence: 1 };
        yield {
          type: "agent_final", sequence: 2, body: "answer",
          citations: ["read:z-source", "ctx-0002", "ctx-0001"],
        };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      resetPreview,
    });
    await runtime.invoke(context, intent("room-a", "citation-order"));
    await runtime.whenIdle();
    expect(complete).toHaveBeenCalledWith(
      expect.any(String), 1, "answer", ["ctx-0001", "ctx-0002", "read:z-source"],
    );
    expect(resetPreview).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-a", attemptSeq: 1, reason: "execution_terminal",
    }));
  });

  it("uses the fixed 1s retry backoff even when a transient error suggests Retry-After", async () => {
    const runtimeAuthority = authority();
    const waits: number[] = [];
    const clock: RuntimeClock = {
      now: () => Date.parse("2026-08-17T00:00:00.000Z"),
      wait: vi.fn(async (milliseconds) => { waits.push(milliseconds); }),
    };
    let builds = 0;
    const stream = vi.fn(async function* (input: AgentRuntimeProviderInput) {
      yield { type: "response_started" as const, sequence: 1 };
      yield { type: "agent_final" as const, sequence: 2, body: "recovered", citations: [] };
      expect(input.snapshot.snapshotId).toContain("execution-");
    });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(stream),
      modelId: "fake-model",
      async buildProviderInput(executionValue, invocationValue) {
        builds += 1;
        if (builds === 1) {
          throw new AgentRuntimeError(
            "context_storage_unavailable", "busy", 7,
          );
        }
        return providerInput(executionValue, invocationValue);
      },
      clock,
    });
    const accepted = await runtime.invoke(context, intent("room-a", "context-503"));
    await runtime.whenIdle();
    expect(waits).toEqual([1_000]);
    expect(builds).toBe(2);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
      status: "completed", currentAttemptSeq: 2,
    });
  });

  it.each([257, 513, 1_025])(
    "keyset-recovers all %i candidates across full room admission windows",
    async (candidateCount) => {
      const runtimeAuthority = authority();
      const records = Array.from({ length: candidateCount }, (_, index) => {
        const recoveredIntent = intent("room-recovery", `source-${index}`, `agent-${index}`);
        const recoveredExecution = {
          ...execution(`recovered-${index}`, recoveredIntent.roomId),
          sourceMessageId: recoveredIntent.sourceMessageId,
          agentId: recoveredIntent.targetAgentId,
        };
        runtimeAuthority.executions.set(recoveredExecution.id, recoveredExecution);
        return {
          execution: recoveredExecution,
          intent: recoveredIntent,
          outcome: "enqueue" as const,
        };
      });
      const scan = vi.fn<RuntimeRecoveryAuthority["scan"]>(async ({ after, limit }) => {
        const start = after === undefined ? 0 : Number(after) + 1;
        const page = records.slice(start, start + limit);
        return {
          candidates: page.map((record, offset) => ({
            cursor: String(start + offset).padStart(6, "0"),
            record,
          })),
          hasMore: start + page.length < records.length,
        };
      });
      const settle = vi.fn(async () => undefined);
      const recoveryAuthority: RuntimeRecoveryAuthority = {
        scan,
        isolate: vi.fn(async () => undefined),
        settle,
      };
      const stream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "recovered", citations: [] };
      });
      const runtime = createAgentRuntimeService({
        authority: runtimeAuthority,
        recoveryAuthority,
        provider: provider(stream),
        modelId: "fake-model",
        buildProviderInput: providerInput,
      });

      await runtime.recover();
      await runtime.whenIdle();

      expect(scan.mock.calls.length).toBe(Math.ceil(candidateCount / 256) + 1);
      expect(settle).not.toHaveBeenCalled();
      expect(stream).toHaveBeenCalledTimes(candidateCount);
      expect([...runtimeAuthority.executions.values()].filter((value) => value.status === "completed"))
        .toHaveLength(candidateCount);
    },
  );

  it("stops a 257-candidate recovery page at close and releases the 224 unadmitted leases", async () => {
    const runtimeAuthority = authority();
    const originalShutdown = runtimeAuthority.shutdown.bind(runtimeAuthority);
    runtimeAuthority.shutdown = vi.fn(originalShutdown);
    const records = Array.from({ length: 257 }, (_, index) => {
      const recoveredIntent = intent("room-recovery-close", `source-${index}`, `agent-${index}`);
      const recoveredExecution = {
        ...execution(`recovered-close-${index}`, recoveredIntent.roomId),
        sourceMessageId: recoveredIntent.sourceMessageId,
        agentId: recoveredIntent.targetAgentId,
      };
      runtimeAuthority.executions.set(recoveredExecution.id, recoveredExecution);
      return { execution: recoveredExecution, intent: recoveredIntent, outcome: "enqueue" as const };
    });
    const release = vi.fn(async () => 224);
    const recoveryAuthority: RuntimeRecoveryAuthority = {
      scan: vi.fn(async ({ after }) => after === undefined ? ({
        candidates: records.slice(0, 256).map((record, index) => ({
          cursor: String(index).padStart(6, "0"), record,
        })),
        hasMore: true,
      }) : ({ candidates: [], hasMore: false })),
      isolate: vi.fn(async () => undefined),
      release,
    };
    let eightStarted!: () => void;
    const activeAtCapacity = new Promise<void>((resolve) => { eightStarted = resolve; });
    let starts = 0;
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      recoveryAuthority,
      provider: provider(async function* () {
        starts += 1;
        if (starts === 8) eightStarted();
        await new Promise<void>(() => undefined);
        yield { type: "response_started", sequence: 1 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
    });

    const recovery = runtime.recover();
    await activeAtCapacity;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await runtime.close();
    await recovery;

    expect(runtimeAuthority.shutdown).toHaveBeenCalledTimes(32);
    expect(release).toHaveBeenCalledTimes(1);
    expect([...runtimeAuthority.executions.values()].filter((value) =>
      value.status === "cancelled" && value.cancellationReason === "runtime_shutdown"))
      .toHaveLength(32);
    expect([...runtimeAuthority.executions.values()].filter((value) => value.status === "queued"))
      .toHaveLength(225);
  });

  it("isolates a poison recovery candidate without blocking larger stable keys", async () => {
    const runtimeAuthority = authority();
    const firstIntent = intent("room-recovery", "source-first", "agent-first");
    const lastIntent = intent("room-recovery", "source-last", "agent-last");
    const first = { ...execution("recovered-first", "room-recovery"),
      sourceMessageId: firstIntent.sourceMessageId, agentId: firstIntent.targetAgentId };
    const last = { ...execution("recovered-last", "room-recovery"),
      sourceMessageId: lastIntent.sourceMessageId, agentId: lastIntent.targetAgentId };
    runtimeAuthority.executions.set(first.id, first);
    runtimeAuthority.executions.set(last.id, last);
    const isolate = vi.fn(async () => undefined);
    const recoveryAuthority: RuntimeRecoveryAuthority = {
      scan: vi.fn(async ({ after }) => after === undefined ? ({
          candidates: [
            { cursor: "001", record: { execution: first, intent: firstIntent, outcome: "enqueue" } },
            { cursor: "002", record: { execution: { id: "poison" }, raw: "must-not-leak" } },
            { cursor: "003", record: { execution: last, intent: lastIntent, outcome: "enqueue" } },
          ],
          hasMore: false,
        }) : ({ candidates: [], hasMore: false })),
      isolate,
    };
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      recoveryAuthority,
      provider: provider(async function* () {
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "ok", citations: [] };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
    });

    await runtime.recover();
    await runtime.whenIdle();

    expect(isolate).toHaveBeenCalledWith({
      cursor: "002",
      candidateId: "poison",
      reason: "recovery_candidate_invalid",
    });
    expect(runtimeAuthority.executions.get(first.id)?.status).toBe("completed");
    expect(runtimeAuthority.executions.get(last.id)?.status).toBe("completed");
  });

  it("does not poison a terminal candidate when durable lease settlement is transiently unavailable", async () => {
    const runtimeAuthority = authority();
    const recoveredIntent = intent("room-recovery", "source-settle", "agent-settle");
    const recoveredExecution = {
      ...execution("recovered-settle", recoveredIntent.roomId),
      sourceMessageId: recoveredIntent.sourceMessageId,
      agentId: recoveredIntent.targetAgentId,
      status: "failed" as const,
      completedAt: "2026-08-17T00:00:01.000Z",
      terminalErrorCode: "provider_failure",
      deadLetteredAt: "2026-08-17T00:00:01.000Z",
    };
    runtimeAuthority.executions.set(recoveredExecution.id, recoveredExecution);
    const isolate = vi.fn(async () => undefined);
    const recoveryAuthority: RuntimeRecoveryAuthority = {
      scan: vi.fn(async () => ({
        candidates: [{
          cursor: "001",
          record: { execution: recoveredExecution, intent: recoveredIntent, outcome: "failed" },
        }],
        hasMore: false,
      })),
      isolate,
      settle: vi.fn(async () => {
        throw new AgentRuntimeError("provider_failure", "lease settlement unavailable");
      }),
    };
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      recoveryAuthority,
      provider: provider(async function* () {
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "ok", citations: [] };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
    });

    await expect(runtime.recover()).rejects.toThrow("lease settlement unavailable");
    await runtime.whenIdle();
    expect(isolate).not.toHaveBeenCalled();
    expect(runtimeAuthority.executions.get(recoveredExecution.id)?.status).toBe("failed");
  });

  it("preserves all authoritative invocation kinds across restart recovery and manual retry", async () => {
    const kinds = ["direct_mention", "structured_help", "routed_candidate"] as const;
    for (const kind of kinds) {
      const recoveredAuthority = authority();
      const recoveredIntent: AgentInvocationIntent = {
        kind, roomId: `room-${kind}`, sourceMessageId: `source-${kind}`,
        targetAgentId: `agent-room-${kind}`,
      };
      const recoveredExecution = {
        ...execution(`recovered-${kind}`, recoveredIntent.roomId),
        sourceMessageId: recoveredIntent.sourceMessageId,
      };
      recoveredAuthority.executions.set(recoveredExecution.id, recoveredExecution);
      recoveredAuthority.recover = vi.fn(async () => [{
        execution: recoveredExecution, intent: recoveredIntent, outcome: "enqueue" as const,
      }]);
      const recoveredInputs: AgentInvocationIntent[] = [];
      const recoveredRuntime = createAgentRuntimeService({
        authority: recoveredAuthority,
        provider: provider(async function* () {
          yield { type: "response_started", sequence: 1 };
          yield { type: "agent_final", sequence: 2, body: "recovered", citations: [] };
        }),
        modelId: "fake-model",
        async buildProviderInput(executionValue, invocationValue) {
          recoveredInputs.push(invocationValue);
          return providerInput(executionValue, invocationValue);
        },
      });
      await recoveredRuntime.recover();
      await recoveredRuntime.whenIdle();
      expect(recoveredInputs).toEqual([recoveredIntent]);
      expect(recoveredAuthority.executions.get(recoveredExecution.id)?.status).toBe("completed");

      const retryAuthority = authority();
      const retryExecution = {
        ...execution(`retry-${kind}`, recoveredIntent.roomId),
        sourceMessageId: recoveredIntent.sourceMessageId,
      };
      retryAuthority.executions.set(retryExecution.id, retryExecution);
      retryAuthority.retry = vi.fn(async () => ({
        execution: retryExecution, intent: recoveredIntent, replayed: false,
      }));
      const retryInputs: AgentInvocationIntent[] = [];
      const retryRuntime = createAgentRuntimeService({
        authority: retryAuthority,
        provider: provider(async function* () {
          yield { type: "response_started", sequence: 1 };
          yield { type: "agent_final", sequence: 2, body: "retried", citations: [] };
        }),
        modelId: "fake-model",
        async buildProviderInput(executionValue, invocationValue) {
          retryInputs.push(invocationValue);
          return providerInput(executionValue, invocationValue);
        },
      });
      await retryRuntime.retry(context, `terminal-${kind}`);
      await retryRuntime.whenIdle();
      expect(retryInputs).toEqual([recoveredIntent]);
      expect(retryAuthority.executions.get(retryExecution.id)?.status).toBe("completed");
    }
  });

  it("commits cancelled before aborting and never completes a partial stream", async () => {
    const runtimeAuthority = authority();
    const ordering: string[] = [];
    const originalInterrupt = runtimeAuthority.interrupt.bind(runtimeAuthority);
    runtimeAuthority.interrupt = async (...args) => {
      const result = await originalInterrupt(...args);
      ordering.push("cancel-committed");
      return result;
    };
    const complete = vi.spyOn(runtimeAuthority, "complete");
    let started!: () => void;
    const sawStart = new Promise<void>((resolve) => { started = resolve; });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (_input, signal) {
        yield { type: "response_started", sequence: 1 };
        yield { type: "text_delta", sequence: 2, delta: "partial" };
        started();
        signal.addEventListener("abort", () => {
          ordering.push("abort-propagated");
        }, { once: true });
        await new Promise<void>(() => undefined);
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
    });
    const accepted = await runtime.invoke(context, intent("room-a", "a-1"));
    await sawStart;
    const cancelled = await runtime.interrupt(context, accepted.execution.id, "requested_by_human");
    await runtime.whenIdle();
    expect(cancelled.status).toBe("cancelled");
    expect(ordering).toEqual(["cancel-committed", "abort-propagated"]);
    expect(complete).not.toHaveBeenCalled();
    await expect(runtime.interrupt(context, accepted.execution.id, "replayed"))
      .resolves.toMatchObject({ id: accepted.execution.id, status: "cancelled" });
    expect(ordering).toEqual(["cancel-committed", "abort-propagated", "cancel-committed"]);
  });

  it("aborts a provider fake and removes queued work only after a committed human fence is applied", async () => {
    const runtimeAuthority = authority();
    const ordering: string[] = [];
    let started!: () => void;
    const sawStart = new Promise<void>((resolve) => { started = resolve; });
    const complete = vi.spyOn(runtimeAuthority, "complete");
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (_input, signal) {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          ordering.push("abort-propagated");
          resolve();
        }, { once: true }));
        yield { type: "response_started", sequence: 1 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      limits: { maxActive: 1, maxQueuedPerRoom: 2, maxPartialBytes: 1_024 },
    });
    const active = await runtime.invoke(context, intent("room-a", "human-fence-active"));
    const queued = await runtime.invoke(
      { ...context, requestId: "human-fence-r2", idempotencyKey: "human-fence-k2" },
      intent("room-a", "human-fence-queued"),
    );
    await sawStart;
    const cancelledAt = "2026-08-17T00:00:02.000Z";
    const cancelled = [active.execution.id, queued.execution.id].map((id) => {
      const current = runtimeAuthority.executions.get(id)!;
      const value: AgentExecution = {
        ...current,
        status: "cancelled",
        actionCategory: id === active.execution.id ? "waiting_upstream" : current.actionCategory,
        updatedAt: cancelledAt,
        completedAt: cancelledAt,
        cancellationReason: "human_preempted:human-message",
      };
      runtimeAuthority.executions.set(id, value);
      return value;
    });

    ordering.push("cancel-committed");
    runtime.applyCommittedHumanFence(cancelled);
    await runtime.whenIdle();

    expect(ordering).toEqual(["cancel-committed", "abort-propagated"]);
    expect(complete).not.toHaveBeenCalled();
    expect([...runtimeAuthority.executions.values()].map((value) => value.status))
      .toEqual(["cancelled", "cancelled"]);
  });

  it("applies only exact source-scoped message recall tuples after durable cancellation", async () => {
    const runtimeAuthority = authority();
    const ordering: string[] = [];
    let started!: () => void;
    const sawStart = new Promise<void>((resolve) => { started = resolve; });
    const complete = vi.spyOn(runtimeAuthority, "complete");
    const resetPreview = vi.fn(() => ordering.push("source-preview-reset"));
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (_input, signal) {
        started();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          ordering.push("source-abort-propagated");
          resolve();
        }, { once: true }));
        yield { type: "response_started", sequence: 1 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      limits: { maxActive: 1, maxQueuedPerRoom: 2, maxPartialBytes: 1_024 },
      resetPreview,
    });
    const activeSourceMessageId = "message-source-active";
    const queuedSourceMessageId = "message-source-queued";
    const active = await runtime.invoke(context, intent("room-a", activeSourceMessageId));
    const queued = await runtime.invoke(
      { ...context, requestId: "source-recall-r2", idempotencyKey: "source-recall-k2" },
      intent("room-a", queuedSourceMessageId),
    );
    await sawStart;

    ordering.push("source-cancel-committed");
    runtime.applyCommittedMessageRecall({
      sourceMessageId: activeSourceMessageId,
      cancellations: [{
        sourceMessageId: activeSourceMessageId,
        sourceRevision: 1,
        invocationIntentId: "intent-active",
        executionId: active.execution.id,
        attemptSeq: 1,
        cancellationReason: "message_recalled",
        sideEffectState: "none",
      }],
    });
    await vi.waitFor(() => {
      expect(ordering).toEqual([
        "source-cancel-committed", "source-preview-reset", "source-abort-propagated",
      ]);
    });
    expect(resetPreview).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-a", executionId: active.execution.id, attemptSeq: 1,
      reason: "message_recalled",
    }));
    expect(complete).not.toHaveBeenCalled();
    expect(runtimeAuthority.executions.get(queued.execution.id)?.status)
      .toMatch(/queued|running/);
    expect(() => runtime.applyCommittedMessageRecall({
      sourceMessageId: queuedSourceMessageId,
      cancellations: [{
        sourceMessageId: queuedSourceMessageId,
        sourceRevision: 1,
        invocationIntentId: "intent-queued",
        executionId: queued.execution.id,
        attemptSeq: 2,
        cancellationReason: "message_recalled",
        sideEffectState: "none",
      }],
    })).toThrow(/tuple/i);
    await runtime.close();
  });

  it("executes a closed provider tool plan and continues with only bounded tool output", async () => {
    const runtimeAuthority = authority();
    runtimeAuthority.prepareTool = vi.fn(async (executionId, _attempt, tool) => {
      const current = runtimeAuthority.executions.get(executionId)!;
      const updated = { ...current, actionCategory: "tool_call" as const, toolName: tool.id, toolDispatchPhase: "not_started" as const };
      runtimeAuthority.executions.set(executionId, updated);
      return { execution: updated, grantId: "grant-1" };
    });
    runtimeAuthority.claimTool = vi.fn(async (_executionId, _attempt, _grant, parameters) => ({
      dispatchId: "dispatch-1",
      toolId: "repository.git-status" as const,
      parameters,
    }));
    runtimeAuthority.settleTool = vi.fn(async () => undefined);
    runtimeAuthority.checkpoint = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({ summary: { lines: 1 }, modelInput: "M README.md" }));
    const adapter: ToolAdapter = {
      descriptor: {
        id: "repository.git-status",
        displayName: "Git status",
        effect: "read-only",
        reversibility: "compensatable",
      },
      execute,
    };
    const gateway = createToolGateway({ authority: runtimeAuthority, adapters: [adapter] });
    let rounds = 0;
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (input) {
        rounds += 1;
        yield { type: "response_started", sequence: 1 };
        if (input.toolContinuations === undefined) {
          yield { type: "tool_call_started", sequence: 2, callId: "call-1", toolName: "repository_git_status" };
          yield { type: "tool_call_delta", sequence: 3, callId: "call-1", delta: "{}" };
          yield { type: "completed", sequence: 4 };
        } else {
          expect(input.toolContinuations).toEqual([{
            callId: "call-1",
            toolId: "repository.git-status",
            argumentsJson: "{}",
            modelInput: "M README.md",
          }]);
          yield { type: "agent_final", sequence: 2, body: "repository changed", citations: ["ctx-0001"] };
        }
      }),
      modelId: "fake-model",
      buildProviderInput: providerInputWithTools([adapter.descriptor]),
      tools: [adapter.descriptor],
      toolGateway: gateway,
    });
    const accepted = await runtime.invoke(context, intent("room-a", "a-tool"));
    await runtime.whenIdle();
    expect(rounds).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtimeAuthority.checkpoint).toHaveBeenCalledTimes(1);
    expect(runtimeAuthority.executions.get(accepted.execution.id)?.status).toBe("completed");
  });

  it("terminalizes an invalidated source read without a second Provider dispatch", async () => {
    const runtimeAuthority = authority();
    runtimeAuthority.prepareTool = vi.fn(async (executionId) => ({
      execution: runtimeAuthority.executions.get(executionId)!, grantId: "grant-source-gone",
    }));
    runtimeAuthority.claimTool = vi.fn(async (_executionId, _attempt, _grant, parameters) => ({
      dispatchId: "dispatch-source-gone", toolId: "room-memory.read" as const, parameters,
    }));
    runtimeAuthority.settleTool = vi.fn(async () => undefined);
    const sourceTool = {
      descriptor: {
        id: "room-memory.read" as const,
        displayName: "Room memory read",
        effect: "read-only" as const,
        reversibility: "irreversible" as const,
      },
      execute: vi.fn(async () => {
        throw new RoomMemoryReadError(410, "source_invalidated");
      }),
    };
    let providerDispatches = 0;
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* () {
        providerDispatches += 1;
        yield { type: "response_started", sequence: 1 };
        yield {
          type: "tool_call_started", sequence: 2,
          callId: "call-source-gone", toolName: "room_memory_read",
        };
        yield {
          type: "tool_call_delta", sequence: 3, callId: "call-source-gone",
          delta: JSON.stringify({
            snapshotId: "snapshot-execution-1", sourceLabel: "ctx-0001", mode: "source",
          }),
        };
        yield { type: "completed", sequence: 4 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInputWithTools([sourceTool.descriptor]),
      tools: [sourceTool.descriptor],
      toolGateway: createToolGateway({ authority: runtimeAuthority, adapters: [sourceTool] }),
    });
    const accepted = await runtime.invoke(context, intent("room-a", "source-gone"));
    await runtime.whenIdle();
    expect(providerDispatches).toBe(1);
    expect(sourceTool.execute).toHaveBeenCalledTimes(1);
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
      status: "failed", terminalErrorCode: "context_source_gone",
    });
  });

  it("rejects a tool continuation that exceeds the frozen deterministic input budget", async () => {
    const runtimeAuthority = authority();
    runtimeAuthority.prepareTool = vi.fn(async (executionId) => ({
      execution: runtimeAuthority.executions.get(executionId)!, grantId: "grant-large-read",
    }));
    runtimeAuthority.claimTool = vi.fn(async (_executionId, _attempt, _grant, parameters) => ({
      dispatchId: "dispatch-large-read", toolId: "repository.git-status" as const, parameters,
    }));
    runtimeAuthority.settleTool = vi.fn(async () => undefined);
    runtimeAuthority.checkpoint = vi.fn(async () => undefined);
    const adapter: ToolAdapter = {
      descriptor: {
        id: "repository.git-status", displayName: "Git status", effect: "read-only",
        reversibility: "compensatable",
      },
      execute: vi.fn(async () => ({ summary: { bytes: 3_000 }, modelInput: "x".repeat(3_000) })),
    };
    let providerDispatches = 0;
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* () {
        providerDispatches += 1;
        yield { type: "response_started", sequence: 1 };
        yield {
          type: "tool_call_started", sequence: 2,
          callId: "call-large-read", toolName: "repository_git_status",
        };
        yield { type: "tool_call_delta", sequence: 3, callId: "call-large-read", delta: "{}" };
        yield { type: "completed", sequence: 4 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInputWithTools([adapter.descriptor]),
      tools: [adapter.descriptor],
      toolGateway: createToolGateway({ authority: runtimeAuthority, adapters: [adapter] }),
    });
    const accepted = await runtime.invoke(context, intent("room-a", "large-continuation"));
    await runtime.whenIdle();
    expect(providerDispatches).toBe(1);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
      status: "failed", terminalErrorCode: "content_too_large",
    });
  });

  it("rejects a configured tool omitted by the compiled context before grant or adapter calls", async () => {
    const runtimeAuthority = authority();
    runtimeAuthority.prepareTool = vi.fn(async (executionId, _attempt, tool) => ({
      execution: runtimeAuthority.executions.get(executionId)!,
      grantId: `grant-${tool.id}`,
    }));
    runtimeAuthority.claimTool = vi.fn(async (_executionId, _attempt, _grant, parameters) => ({
      dispatchId: "dispatch-omitted",
      toolId: "repository.git-status" as const,
      parameters,
    }));
    const adapter: ToolAdapter = {
      descriptor: {
        id: "repository.git-status",
        displayName: "Git status",
        effect: "read-only",
        reversibility: "compensatable",
      },
      execute: vi.fn(async () => ({ summary: { lines: 0 }, modelInput: "clean" })),
    };
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (input) {
        yield { type: "response_started", sequence: 1 };
        if (input.toolContinuations !== undefined) {
          yield { type: "agent_final", sequence: 2, body: "unexpected continuation", citations: [] };
          return;
        }
        yield {
          type: "tool_call_started",
          sequence: 2,
          callId: "call-omitted",
          toolName: "repository_git_status",
        };
        yield { type: "tool_call_delta", sequence: 3, callId: "call-omitted", delta: "{}" };
        yield { type: "completed", sequence: 4 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      tools: [adapter.descriptor],
      toolGateway: createToolGateway({ authority: runtimeAuthority, adapters: [adapter] }),
    });

    const accepted = await runtime.invoke(context, intent("room-a", "tool-omitted"));
    await runtime.whenIdle();

    expect(runtimeAuthority.prepareTool).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
      status: "failed",
      terminalErrorCode: "provider_malformed",
    });
  });

  it("revalidates the frozen context before dispatching a completed tool result", async () => {
    const runtimeAuthority = authority();
    runtimeAuthority.complete = vi.fn(runtimeAuthority.complete);
    runtimeAuthority.prepareTool = vi.fn(async (executionId, _attempt, tool) => ({
      execution: runtimeAuthority.executions.get(executionId)!,
      grantId: `grant-${tool.id}`,
    }));
    runtimeAuthority.claimTool = vi.fn(async (_executionId, _attempt, _grant, parameters) => ({
      dispatchId: "dispatch-read",
      toolId: "repository.git-status" as const,
      parameters,
    }));
    runtimeAuthority.settleTool = vi.fn(async () => undefined);
    runtimeAuthority.checkpoint = vi.fn(async () => undefined);
    const adapter: ToolAdapter = {
      descriptor: {
        id: "repository.git-status",
        displayName: "Git status",
        effect: "read-only",
        reversibility: "compensatable",
      },
      execute: vi.fn(async () => ({ summary: { lines: 1 }, modelInput: "bounded result" })),
    };
    const gateway = createToolGateway({ authority: runtimeAuthority, adapters: [adapter] });
    let providerDispatches = 0;
    let contextReads = 0;
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* () {
        providerDispatches += 1;
        yield { type: "response_started", sequence: 1 };
        yield { type: "tool_call_started", sequence: 2, callId: "call-read", toolName: "repository_git_status" };
        yield { type: "tool_call_delta", sequence: 3, callId: "call-read", delta: "{}" };
        yield { type: "completed", sequence: 4 };
      }),
      modelId: "fake-model",
      buildProviderInput: async (executionValue, invocationValue) => {
        contextReads += 1;
        if (contextReads === 2) {
          throw new AgentRuntimeError("execution_conflict", "Snapshot was invalidated after source read");
        }
        return providerInputWithTools([adapter.descriptor])(executionValue, invocationValue);
      },
      tools: [adapter.descriptor],
      toolGateway: gateway,
    });

    const accepted = await runtime.invoke(context, intent("room-a", "source-read-race"));
    await runtime.whenIdle();

    expect(contextReads).toBe(2);
    expect(providerDispatches).toBe(1);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(runtimeAuthority.complete).not.toHaveBeenCalled();
    expect(runtimeAuthority.executions.get(accepted.execution.id)?.status).toBe("running");
  });

  it("turns only a closed provider risk/challenge function into an authoritative OpenItem proposal", async () => {
    const runtimeAuthority = authority();
    runtimeAuthority.checkpoint = vi.fn(async () => undefined);
    const proposeOpenItem = vi.fn(async () => ({ id: "open-item-proposed" }));
    let rounds = 0;
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (input) {
        rounds += 1;
        yield { type: "response_started", sequence: 1 };
        if (input.toolContinuations === undefined) {
          yield { type: "tool_call_started", sequence: 2, callId: "proposal-call", toolName: "dao_propose_open_item" };
          yield { type: "tool_call_delta", sequence: 3, callId: "proposal-call", delta: JSON.stringify({
            proposalKind: "risk", targetActorId: "human-reviewer",
            sourceMessageId: "proposal-source", reason: "权限边界风险", content: "请确认权限边界",
          }) };
          yield { type: "completed", sequence: 4 };
        } else {
          expect(input.toolContinuations).toEqual([{
            callId: "proposal-call", toolId: "open-item.propose",
            argumentsJson: JSON.stringify({
              proposalKind: "risk", targetActorId: "human-reviewer",
              sourceMessageId: "proposal-source", reason: "权限边界风险", content: "请确认权限边界",
            }),
            modelInput: "OpenItem open-item-proposed was authoritatively created.",
          }]);
          yield { type: "agent_final", sequence: 2, body: "已创建待答项", citations: [] };
        }
      }),
      modelId: "fake-model",
      buildProviderInput: async (value, invocation) => ({
        ...(await providerInput(value, invocation)),
        openItemTargets: [{ actorId: "human-reviewer", kind: "human" }],
      }),
      tools: [],
      toolGateway: { execute: vi.fn() },
      proposeOpenItem,
    });
    const accepted = await runtime.invoke(context, intent("room-a", "proposal-source"));
    await runtime.whenIdle();
    expect(proposeOpenItem).toHaveBeenCalledWith(expect.objectContaining({
      execution: expect.objectContaining({ id: accepted.execution.id, agentId: "agent-room-a" }),
      callId: "proposal-call", proposalKind: "risk", targetActorId: "human-reviewer",
      sourceMessageId: "proposal-source", reason: "权限边界风险", content: "请确认权限边界",
    }));
    expect(runtimeAuthority.checkpoint).toHaveBeenCalledTimes(1);
    expect(rounds).toBe(2);
    expect(runtimeAuthority.executions.get(accepted.execution.id)?.status).toBe("completed");
  });

  it("resumes a persisted side-effect confirmation after runtime restart", async () => {
    const runtimeAuthority = authority();
    runtimeAuthority.prepareTool = vi.fn(async (executionId, _attempt, tool) => {
      const current = runtimeAuthority.executions.get(executionId)!;
      const waiting = { ...current, actionCategory: "waiting_upstream" as const, toolName: tool.id };
      runtimeAuthority.executions.set(executionId, waiting);
      return {
        execution: waiting,
        grantId: "grant-restored",
        confirmationId: "confirmation-restored",
        target: tool.id,
        impact: "bounded-side-effect",
        reversibility: tool.reversibility,
      };
    });
    runtimeAuthority.claimTool = vi.fn(async (_executionId, _attempt, _grant, parameters) => ({
      dispatchId: "dispatch-restored",
      toolId: "sandbox-file.write" as const,
      parameters,
    }));
    runtimeAuthority.settleTool = vi.fn(async () => undefined);
    runtimeAuthority.checkpoint = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({ summary: { operation: "created" }, modelInput: "write succeeded" }));
    const adapter: ToolAdapter = {
      descriptor: {
        id: "sandbox-file.write",
        displayName: "Sandbox write",
        effect: "side-effecting",
        reversibility: "compensatable",
      },
      execute,
    };
    const gateway = createToolGateway({ authority: runtimeAuthority, adapters: [adapter] });
    const beforeRestart = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* () {
        yield { type: "response_started", sequence: 1 };
        yield { type: "tool_call_started", sequence: 2, callId: "call-restored", toolName: "sandbox_file_write" };
        yield { type: "tool_call_delta", sequence: 3, callId: "call-restored", delta: "{\"path\":\"a.txt\"}" };
        yield { type: "completed", sequence: 4 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInputWithTools([adapter.descriptor]),
      tools: [adapter.descriptor],
      toolGateway: gateway,
    });
    const restoredIntent = {
      ...intent("room-a", "a-restored"),
      kind: "structured_help" as const,
    };
    const accepted = await beforeRestart.invoke(context, restoredIntent);
    await beforeRestart.whenIdle();
    // Model an abrupt process loss. A graceful close now terminalizes every
    // admitted execution before aborting, so it cannot represent a restart.
    runtimeAuthority.readPendingConfirmation = vi.fn(async () => ({
      execution: runtimeAuthority.executions.get(accepted.execution.id)!,
      intent: restoredIntent,
      grantId: "grant-restored",
      toolId: "sandbox-file.write",
      parameters: { path: "a.txt" },
      callId: "call-restored",
      argumentsJson: "{\"path\":\"a.txt\"}",
    }));
    const afterRestart = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (input) {
        expect(input.toolContinuations).toEqual([{
          callId: "call-restored",
          toolId: "sandbox-file.write",
          argumentsJson: "{\"path\":\"a.txt\"}",
          modelInput: "write succeeded",
        }]);
        yield { type: "response_started", sequence: 1 };
        yield { type: "agent_final", sequence: 2, body: "restored completion", citations: [] };
      }),
      modelId: "fake-model",
      async buildProviderInput(executionValue, invocationValue) {
        expect(invocationValue).toEqual(restoredIntent);
        return providerInputWithTools([adapter.descriptor])(executionValue, invocationValue);
      },
      tools: [adapter.descriptor],
      toolGateway: gateway,
    });
    await afterRestart.confirmTool(context, {
      confirmationId: "confirmation-restored",
      executionId: accepted.execution.id,
    });
    await afterRestart.whenIdle();
    expect(runtimeAuthority.readPendingConfirmation).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtimeAuthority.executions.get(accepted.execution.id)?.status).toBe("completed");
  });

  it("bounds shutdown even when a Provider ignores AbortSignal", async () => {
    const runtimeAuthority = authority();
    const resetPreview = vi.fn();
    let started!: () => void;
    const sawStart = new Promise<void>((resolve) => { started = resolve; });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* () {
        started();
        await new Promise<void>(() => undefined);
        yield { type: "response_started", sequence: 1 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      shutdownTimeoutMs: 10,
      resetPreview,
    });
    await runtime.invoke(context, intent("room-close", "close"));
    await sawStart;

    const before = Date.now();
    await runtime.close();

    expect(Date.now() - before).toBeLessThan(250);
    expect(runtimeAuthority.executions.get("execution-1")).toMatchObject({
      status: "cancelled",
      cancellationReason: "runtime_shutdown",
    });
    expect(resetPreview).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-close", executionId: "execution-1", attemptSeq: 1,
      reason: "runtime_shutdown",
    }));
  });

  it("converges shutdown while a timed-out attempt is retrying unavailable authority", async () => {
    const runtimeAuthority = authority();
    const originalShutdown = runtimeAuthority.shutdown.bind(runtimeAuthority);
    const ordering: string[] = [];
    runtimeAuthority.scheduleRetry = vi.fn(async () => {
      ordering.push("timeout-persist-failed");
      throw new AgentRuntimeError("context_storage_unavailable", "authority unavailable");
    });
    runtimeAuthority.shutdown = vi.fn(async (...args) => {
      const terminal = await originalShutdown(...args);
      ordering.push("shutdown-committed");
      return terminal;
    });
    let retrying!: () => void;
    const retryStarted = new Promise<void>((resolve) => { retrying = resolve; });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (_input, signal) {
        signal.addEventListener("abort", () => ordering.push("provider-aborted"), { once: true });
        await new Promise<void>(() => undefined);
        yield { type: "response_started", sequence: 1 };
      }),
      modelId: "fake-model",
      async buildProviderInput(value, invocationValue) {
        return {
          ...(await providerInput(value, invocationValue)),
          limits: { ...(await providerInput(value, invocationValue)).limits, timeoutMs: 10 },
        };
      },
      clock: {
        now: () => Date.parse("2026-08-17T00:00:00.000Z"),
        wait: vi.fn(async (_milliseconds, signal) => {
          retrying();
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new AgentRuntimeError("execution_conflict", "shutdown"));
              return;
            }
            signal.addEventListener("abort", () => {
              reject(new AgentRuntimeError("execution_conflict", "shutdown"));
            }, { once: true });
          });
        }),
      },
      shutdownTimeoutMs: 250,
    });
    const accepted = await runtime.invoke(context, intent("room-timeout-close", "timeout-close"));
    await retryStarted;

    await runtime.close();

    expect(ordering).toEqual([
      "timeout-persist-failed", "shutdown-committed", "provider-aborted",
    ]);
    expect(runtimeAuthority.executions.get(accepted.execution.id)).toMatchObject({
      status: "cancelled", cancellationReason: "runtime_shutdown",
    });
  });

  it("does not abort running or remove queued work when shutdown authority commit fails", async () => {
    const runtimeAuthority = authority();
    let started!: () => void;
    const sawStart = new Promise<void>((resolve) => { started = resolve; });
    let aborted = false;
    runtimeAuthority.shutdown = vi.fn(async () => {
      throw new AgentRuntimeError("provider_failure", "shutdown commit unavailable");
    });
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (_input, signal) {
        started();
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        await new Promise<void>(() => undefined);
        yield { type: "response_started", sequence: 1 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
      limits: { maxActive: 1, maxQueuedPerRoom: 2, maxPartialBytes: 1_024 },
      shutdownTimeoutMs: 50,
    });
    const running = await runtime.invoke(context, intent("room-close-failure", "running"));
    await sawStart;
    const queued = await runtime.invoke(
      { ...context, requestId: "close-queued", idempotencyKey: "close-queued" },
      intent("room-close-failure", "queued"),
    );

    await expect(runtime.close()).rejects.toMatchObject({ code: "provider_failure" });
    expect(aborted).toBe(false);
    expect(runtimeAuthority.executions.get(running.execution.id)?.status).toBe("running");
    expect(runtimeAuthority.executions.get(queued.execution.id)?.status).toBe("queued");
    expect(runtimeAuthority.shutdown).toHaveBeenCalledTimes(1);
  });
});
