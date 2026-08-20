import { describe, expect, it, vi } from "vitest";
import type { AgentExecution, AgentInvocationIntent, AgentRuntimeProviderInput, ProviderEvent } from "@native-im/core";
import type { AuthenticatedCommandContext } from "../persistence/contracts.js";
import {
  AgentRuntimeError,
  type ProviderAdapter,
  type RuntimeAuthority,
  type RuntimeClock,
  type ToolAdapter,
} from "./contracts.js";
import { createAgentRuntimeService } from "./agent-runtime-service.js";
import { createToolGateway } from "./tool-gateway.js";

const context: AuthenticatedCommandContext = {
  kind: "human",
  sessionId: "session-1",
  sessionFamilyId: "family-1",
  principal: { accountId: "account-1", actorId: "human-1" },
  requestId: "request-1",
  idempotencyKey: "key-1",
};

function intent(roomId: string, sourceMessageId: string): AgentInvocationIntent {
  return { kind: "direct_mention", roomId, sourceMessageId, targetAgentId: `agent-${roomId}` };
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
        sourceMessageId: invocation.sourceMessageId };
      executions.set(value.id, value);
      return { execution: value, replayed: false };
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
    retry: vi.fn(), prepareTool: vi.fn(), claimTool: vi.fn(), settleTool: vi.fn(),
    checkpoint: vi.fn(), recover: vi.fn(async () => []),
  };
}

function provider(run: (input: AgentRuntimeProviderInput, signal: AbortSignal) => AsyncIterable<ProviderEvent>): ProviderAdapter {
  return { id: "fake-provider", stream: run };
}

const providerInput = async (value: AgentExecution, invocation: AgentInvocationIntent): Promise<AgentRuntimeProviderInput> => ({
  purpose: "agent_runtime",
  invocation,
  visibleConversation: [{ messageId: value.sourceMessageId, authorId: value.requesterId, body: "bounded" }],
  availableTools: [],
  committedSteps: [],
  limits: { maxInputBytes: 1_024, maxOutputBytes: 1_024, timeoutMs: 5_000 },
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

  it("runs FIFO within a room while allowing bounded cross-room parallelism", async () => {
    const runtimeAuthority = authority();
    const order: string[] = [];
    const runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider: provider(async function* (input) {
        order.push(`start:${input.invocation.sourceMessageId}`);
        yield { type: "response_started", sequence: 1 };
        yield { type: "text_delta", sequence: 2, delta: "ok" };
        yield { type: "completed", sequence: 3 };
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
    expect([...runtimeAuthority.executions.values()].every((value) => value.status === "completed")).toBe(true);
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
        yield { type: "completed", sequence: 2 };
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

  it("retries only transient failures at 1s and 4s then dead-letters attempt 3", async () => {
    const runtimeAuthority = authority();
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
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          ordering.push("abort-propagated");
          resolve();
        }, { once: true }));
        throw new AgentRuntimeError("provider_timeout", "aborted");
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
      expect(ordering).toEqual(["source-cancel-committed", "source-abort-propagated"]);
    });
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
          yield { type: "text_delta", sequence: 2, delta: "repository changed" };
          yield { type: "completed", sequence: 3 };
        }
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
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
          yield { type: "text_delta", sequence: 2, delta: "已创建待答项" };
          yield { type: "completed", sequence: 3 };
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
      buildProviderInput: providerInput,
      tools: [adapter.descriptor],
      toolGateway: gateway,
    });
    const accepted = await beforeRestart.invoke(context, intent("room-a", "a-restored"));
    await beforeRestart.whenIdle();
    await beforeRestart.close();
    runtimeAuthority.readPendingConfirmation = vi.fn(async () => ({
      execution: runtimeAuthority.executions.get(accepted.execution.id)!,
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
        yield { type: "text_delta", sequence: 2, delta: "restored completion" };
        yield { type: "completed", sequence: 3 };
      }),
      modelId: "fake-model",
      buildProviderInput: providerInput,
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
});
