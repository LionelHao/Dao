import { createHash } from "node:crypto";
import type { AgentExecution } from "@native-im/core";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedCommandContext } from "../persistence/contracts.js";
import { mintInternalAgentRuntimeContext } from "../persistence/contracts.js";
import type { AgentRuntimeProviderInput, ProviderAdapter } from "./contracts.js";
import {
  AgentRuntimeQueueFullError,
  createAgentRuntime,
  type AgentRuntimeSchedulerAuthority,
} from "./agent-runtime.js";

const HUMAN: AuthenticatedCommandContext = {
  kind: "human",
  sessionId: "session-1",
  sessionFamilyId: "family-1",
  principal: { accountId: "account-1", actorId: "human-1" },
  requestId: "request-1",
  idempotencyKey: "idempotency-1",
};

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function providerInput(execution: AgentExecution): AgentRuntimeProviderInput {
  return {
    purpose: "agent_runtime",
    invocation: {
      sourceMessageId: execution.sourceMessageId,
      requesterActorId: execution.requesterId,
      targetAgentId: execution.agentId,
      intentKind: "direct_mention",
    },
    visibleConversation: [],
    availableTools: [],
    committedSteps: [],
    limits: {
      maxInputBytes: 65_536,
      maxOutputBytes: 65_536,
      maxToolCalls: 4,
    },
  };
}

function createAuthorityFixture(): {
  readonly authority: AgentRuntimeSchedulerAuthority;
  readonly executions: Map<string, AgentExecution>;
  readonly calls: string[];
} {
  const executions = new Map<string, AgentExecution>();
  const roomQueues = new Map<string, string[]>();
  const calls: string[] = [];
  const preparedTools = new Map<string, {
    readonly grant: Awaited<ReturnType<AgentRuntimeSchedulerAuthority["prepareTool"]>>;
    readonly parameters: import("../persistence/contracts.js").JsonValue;
    readonly remainingCalls: readonly import("../persistence/contracts.js").AgentRuntimeToolPlanEntry[];
  }>();
  const toolParameters = new Map<string, import("../persistence/contracts.js").JsonValue>();
  const remainingToolCalls = new Map<string, readonly import("../persistence/contracts.js").AgentRuntimeToolPlanEntry[]>();
  const resumedConfirmations = new Set<string>();
  const confirmationExecutions = new Map<string, string>();
  let executionOrdinal = 0;
  let nowOrdinal = 0;
  const iso = (): string => new Date(1_700_000_000_000 + nowOrdinal++).toISOString();
  const replace = (execution: AgentExecution): AgentExecution => {
    executions.set(execution.id, execution);
    return execution;
  };

  const authority: AgentRuntimeSchedulerAuthority = {
    async invoke(_context, input, maxQueuedPerRoom) {
      const existing = [...executions.values()].find(
        (execution) =>
          execution.sourceMessageId === input.sourceMessageId &&
          execution.agentId === input.targetAgentId,
      );
      if (existing !== undefined) return existing;
      if (maxQueuedPerRoom !== undefined) {
        const outstanding = [...executions.values()].filter(
          (execution) =>
            execution.roomId === input.roomId &&
            (execution.status === "queued" || execution.status === "running"),
        ).length;
        if (outstanding >= maxQueuedPerRoom + 1) {
          throw Object.assign(new Error("target_busy"), { code: "target_busy", status: 429 });
        }
      }
      calls.push(`invoke:${input.sourceMessageId}`);
      executionOrdinal += 1;
      const queuedAt = iso();
      const execution = replace({
        id: `execution-${executionOrdinal}`,
        roomId: input.roomId,
        sourceMessageId: input.sourceMessageId,
        requesterId: HUMAN.principal.actorId,
        agentId: input.targetAgentId,
        status: "queued",
        actionCategory: "model_generation",
        currentAttemptSeq: 1,
        retryCycle: 1,
        retryOrdinal: 1,
        providerId: input.providerId,
        modelId: input.modelId,
        recoveryCursor: 0,
        queuedAt,
        updatedAt: queuedAt,
      });
      const queue = roomQueues.get(input.roomId) ?? [];
      queue.push(execution.id);
      roomQueues.set(input.roomId, queue);
      return execution;
    },
    async claimNext(runtime, roomId) {
      const queue = roomQueues.get(roomId) ?? [];
      const id = queue[0];
      if (id === undefined) return undefined;
      const current = executions.get(id);
      if (current === undefined || current.status !== "queued") return undefined;
      if (current.agentId !== runtime.agentId) return undefined;
      queue.shift();
      calls.push(`claim:${current.sourceMessageId}`);
      const startedAt = iso();
      return replace({
        ...current,
        status: "running",
        startedAt,
        updatedAt: startedAt,
      });
    },
    async commitStep(_runtime, input) {
      const current = executions.get(input.executionId);
      if (current === undefined) throw new Error("missing execution");
      calls.push(`step:${input.stepKind}:${input.stepSeq}`);
      const updatedAt = iso();
      if (input.stepKind === "tool_call") {
        toolParameters.set(input.executionId, input.canonicalToolCall.parameters ?? null);
        remainingToolCalls.set(input.executionId, input.canonicalToolCall.remainingCalls ?? []);
        return replace({
          ...current,
          actionCategory: "tool_call",
          toolDispatchPhase: "not_started",
          currentToolId: input.canonicalToolCall.toolId,
          recoveryCursor: input.stepSeq,
          updatedAt,
        });
      }
      return replace({
        ...current,
        actionCategory: "model_generation",
        recoveryCursor: input.stepSeq,
        updatedAt,
        ...(current.actionCategory === "tool_call"
          ? { toolDispatchPhase: undefined, currentToolId: undefined }
          : {}),
      } as AgentExecution);
    },
    async completeExecution(_runtime, input) {
      const current = executions.get(input.executionId);
      if (current === undefined) throw new Error("missing execution");
      calls.push(`complete:${current.sourceMessageId}:${input.body}`);
      const finishedAt = iso();
      return replace({
        ...current,
        status: "completed",
        resultMessageId: input.messageId,
        finishedAt,
        updatedAt: finishedAt,
      });
    },
    async completeCompensation(_runtime, input) {
      const current = executions.get(input.executionId);
      if (current === undefined) throw new Error("missing execution");
      calls.push(`complete-compensation:${input.dispatchId}:${input.messageId}`);
      const finishedAt = iso();
      return replace({
        ...current,
        status: "completed",
        actionCategory: "model_generation",
        toolDispatchPhase: undefined,
        currentToolId: undefined,
        recoveryCursor: 2,
        resultMessageId: input.messageId,
        finishedAt,
        updatedAt: finishedAt,
      } as AgentExecution);
    },
    async scheduleRetry(_runtime, input) {
      const current = executions.get(input.executionId);
      if (current === undefined) throw new Error("missing execution");
      calls.push(`retry:${current.retryOrdinal}:${input.errorCode}`);
      const updatedAt = iso();
      if (current.retryOrdinal === 3) {
        return replace({
          ...current,
          status: "failed",
          terminalErrorCode: input.errorCode,
          deadLetteredAt: updatedAt,
          finishedAt: updatedAt,
          updatedAt,
        });
      }
      const queued = replace({
        ...current,
        status: "queued",
        actionCategory: "model_generation",
        currentAttemptSeq: current.currentAttemptSeq + 1,
        retryOrdinal: (current.retryOrdinal + 1) as 2 | 3,
        recoveryCursor: 0,
        queuedAt: updatedAt,
        updatedAt,
        startedAt: undefined,
      } as AgentExecution);
      const queue = roomQueues.get(current.roomId) ?? [];
      queue.push(current.id);
      roomQueues.set(current.roomId, queue);
      return queued;
    },
    async failExecution(_runtime, input) {
      const current = executions.get(input.executionId);
      if (current === undefined) throw new Error("missing execution");
      calls.push(`fail:${input.errorCode}`);
      const finishedAt = iso();
      return replace({
        ...current,
        status: "failed",
        terminalErrorCode: input.errorCode,
        finishedAt,
        updatedAt: finishedAt,
      });
    },
    async interrupt(_context, input) {
      const current = executions.get(input.executionId);
      if (current === undefined) throw new Error("missing execution");
      calls.push(`interrupt:${input.executionId}`);
      if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
        return current;
      }
      const finishedAt = iso();
      return replace({
        ...current,
        status: "cancelled",
        cancellationReason: input.reason,
        finishedAt,
        updatedAt: finishedAt,
      });
    },
    async manualRetry() {
      throw new Error("unused manual retry");
    },
    async compensate() {
      throw new Error("unused compensation");
    },
    async resumeCompensation() {
      throw new Error("unused compensation resume");
    },
    async prepareTool(_runtime, input) {
      calls.push(`prepare:${input.toolId}`);
      const grant = {
        id: `grant-${input.executionId}-${input.attemptSeq}-${input.toolCallStepSeq}`,
        executionId: input.executionId,
        attemptSeq: input.attemptSeq,
        toolCallStepSeq: input.toolCallStepSeq,
        agentId: "agent-1",
        roomId: executions.get(input.executionId)?.roomId ?? "missing-room",
        toolId: input.toolId,
        parameterHash: input.parameterHash,
        toolPlanHash: input.toolPlanHash,
        confirmationRequirement: input.confirmationRequirement,
        issuedAt: new Date(input.now).toISOString(),
        expiresAt: new Date(input.expiresAt).toISOString(),
      };
      preparedTools.set(input.executionId, {
        grant,
        parameters: toolParameters.get(input.executionId) ?? null,
        remainingCalls: remainingToolCalls.get(input.executionId) ?? [],
      });
      if (input.confirmationRequirement === "side_effect") {
        const current = executions.get(input.executionId);
        if (current !== undefined) {
          replace({
            ...current,
            actionCategory: "waiting_upstream",
            toolDispatchPhase: undefined,
            currentToolId: undefined,
            updatedAt: iso(),
          } as AgentExecution);
        }
      }
      return grant;
    },
    async confirmTool(_context, input) {
      calls.push(`confirm:${input.toolId}`);
      const current = executions.get(input.executionId);
      const confirmationId = `confirmation-${preparedTools.get(input.executionId)?.grant.id ?? input.executionId}`;
      confirmationExecutions.set(confirmationId, input.executionId);
      return {
        id: confirmationId,
        executionId: input.executionId,
        attemptSeq: input.attemptSeq,
        grantId: preparedTools.get(input.executionId)?.grant.id ?? "missing-grant",
        toolId: input.toolId,
        parameterHash: input.parameterHash,
        toolPlanHash: preparedTools.get(input.executionId)?.grant.toolPlanHash ?? "0".repeat(64),
        roomId: current?.roomId ?? "missing-room",
        humanPrincipalId: HUMAN.principal.actorId,
        sessionFamilyId: HUMAN.sessionFamilyId,
        target: input.target,
        impact: input.impact,
        reversibility: input.reversibility,
        expiresAt: new Date(input.expiresAt).toISOString(),
      };
    },
    async resumeConfirmedTool(_runtime, input) {
      if (resumedConfirmations.has(input.confirmationId)) {
        throw Object.assign(new Error("execution_conflict"), { code: "execution_conflict", status: 409 });
      }
      resumedConfirmations.add(input.confirmationId);
      const executionId = confirmationExecutions.get(input.confirmationId);
      if (executionId === undefined) throw new Error("missing confirmed execution");
      const prepared = preparedTools.get(executionId);
      const current = executions.get(executionId);
      if (prepared === undefined || current === undefined) throw new Error("missing prepared tool");
      const dispatchedAt = iso();
      const execution = replace({
        ...current,
        actionCategory: "tool_call",
        toolDispatchPhase: "dispatched",
        currentToolId: prepared.grant.toolId,
        updatedAt: dispatchedAt,
      } as AgentExecution);
      return {
        confirmationId: input.confirmationId,
        execution,
        parameters: prepared.parameters,
        remainingCalls: prepared.remainingCalls,
        toolPlanHash: prepared.grant.toolPlanHash,
        dispatch: {
          id: `dispatch-${execution.id}-${execution.currentAttemptSeq}`,
          executionId: execution.id,
          attemptSeq: execution.currentAttemptSeq,
          grantId: prepared.grant.id,
          toolId: prepared.grant.toolId,
          parameterHash: prepared.grant.parameterHash,
          state: "dispatched",
          dispatchedAt,
        },
      };
    },
    async readExecution(_context, executionId) {
      const execution = executions.get(executionId);
      if (execution === undefined) throw new Error("missing execution");
      return execution;
    },
    async dispatchTool(_runtime, input) {
      calls.push(`dispatch:${input.toolId}`);
      return {
        id: `dispatch-${input.executionId}-${input.attemptSeq}`,
        executionId: input.executionId,
        attemptSeq: input.attemptSeq,
        grantId: input.grantId,
        toolId: input.toolId,
        parameterHash: input.parameterHash,
        state: "dispatched",
        dispatchedAt: new Date(input.now).toISOString(),
      };
    },
    async settleTool(_runtime, input) {
      calls.push(`settle:${input.outcome}`);
      return {
        id: input.dispatchId,
        executionId: input.executionId,
        attemptSeq: input.attemptSeq,
        grantId: input.grantId,
        toolId: executions.get(input.executionId)?.currentToolId ?? "missing-tool",
        parameterHash: "0".repeat(64),
        state: input.outcome,
        dispatchedAt: new Date(input.now).toISOString(),
        settledAt: new Date(input.now).toISOString(),
        ...(input.closedSummary === undefined ? {} : { closedSummary: input.closedSummary }),
        ...(input.sealedCompensation === undefined
          ? {}
          : { sealedCompensation: input.sealedCompensation }),
      };
    },
    async recoverPage(_runtime, input) {
      calls.push("recover");
      const recoveries = [...executions.values()]
        .filter((execution) => execution.status === "queued")
        .map((execution) => ({ execution }));
      return { recoveries: recoveries.slice(0, input.limit) };
    },
  };

  return { authority, executions, calls };
}

function invocation(roomId: string, sourceMessageId: string, targetAgentId = "agent-1") {
  return {
    roomId,
    sourceMessageId,
    targetAgentId,
    intentKind: "direct_mention" as const,
    providerId: "provider-1",
    modelId: "model-1",
  };
}

describe("Agent runtime scheduler", () => {
  it("persists before provider work and runs one room in durable FIFO order", async () => {
    const fixture = createAuthorityFixture();
    const releaseFirst = deferred();
    const providerCalls: string[] = [];
    const provider: ProviderAdapter = {
      id: "provider-1",
      async *stream(input) {
        const source = input.invocation.sourceMessageId;
        providerCalls.push(source);
        yield { type: "response_started" };
        if (source === "message-1") await releaseFirst.promise;
        yield { type: "text_delta", delta: `reply-${source}` };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-1",
        agentId: "agent-1",
      }),
      provider,
      inputSource: { load: async (execution) => providerInput(execution) },
      createMessageId: () => "result-message",
    });

    await runtime.invoke(HUMAN, invocation("room-1", "message-1"));
    await runtime.invoke(HUMAN, invocation("room-1", "message-2"));
    await vi.waitFor(() => expect(providerCalls).toEqual(["message-1"]));
    expect(fixture.calls.indexOf("invoke:message-1")).toBeLessThan(
      fixture.calls.indexOf("claim:message-1"),
    );

    releaseFirst.resolve();
    await runtime.whenIdle();
    expect(providerCalls).toEqual(["message-1", "message-2"]);
    expect(fixture.calls.indexOf("invoke:message-2")).toBeLessThan(
      fixture.calls.indexOf("claim:message-2"),
    );
    expect(
      [...fixture.executions.values()].map((execution) => execution.status),
    ).toEqual(["completed", "completed"]);
  });

  it("caps cross-room work and rejects the 33rd queued item before authority persistence", async () => {
    const fixture = createAuthorityFixture();
    const release = deferred();
    let active = 0;
    let maximumActive = 0;
    const provider: ProviderAdapter = {
      id: "provider-1",
      async *stream() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        yield { type: "response_started" };
        await release.promise;
        active -= 1;
        yield { type: "text_delta", delta: "done" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-1",
        agentId: "agent-1",
      }),
      provider,
      inputSource: { load: async (execution) => providerInput(execution) },
      limits: { maxActiveRooms: 8, maxQueuedPerRoom: 32 },
    });

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        runtime.invoke(HUMAN, invocation(`room-${index}`, `cross-${index}`)),
      ),
    );
    await vi.waitFor(() => expect(active).toBe(8));
    expect(maximumActive).toBe(8);

    const roomFixture = createAuthorityFixture();
    const roomProviderEntered = deferred();
    const roomRuntime = createAgentRuntime({
      authority: roomFixture.authority,
      coordinatorIdentity: roomFixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-2",
        agentId: "agent-1",
      }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          roomProviderEntered.resolve();
          await release.promise;
          yield { type: "text_delta", delta: "done" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
      limits: { maxActiveRooms: 1, maxQueuedPerRoom: 32 },
    });
    await roomRuntime.invoke(HUMAN, invocation("bounded-room", "bounded-active"));
    await roomProviderEntered.promise;
    for (let index = 0; index < 32; index += 1) {
      await roomRuntime.invoke(HUMAN, invocation("bounded-room", `bounded-${index}`));
    }
    const persistedBeforeOverflow = roomFixture.calls.filter((call) =>
      call.startsWith("invoke:bounded"),
    ).length;
    await expect(
      roomRuntime.invoke(HUMAN, invocation("bounded-room", "bounded-overflow")),
    ).rejects.toBeInstanceOf(AgentRuntimeQueueFullError);
    expect(
      roomFixture.calls.filter((call) => call.startsWith("invoke:bounded")).length,
    ).toBe(persistedBeforeOverflow);

    release.resolve();
    await Promise.all([runtime.whenIdle(), roomRuntime.whenIdle()]);
  });

  it("shares the process-wide eight-room cap across runtimes and rejects wrong targets before persistence", async () => {
    const fixture = createAuthorityFixture();
    const release = deferred();
    let active = 0;
    let maximumActive = 0;
    const provider: ProviderAdapter = {
      id: "provider-1",
      async *stream() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        yield { type: "response_started" };
        await release.promise;
        active -= 1;
        yield { type: "text_delta", delta: "done" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const runtime1 = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "shared-1", agentId: "agent-1" }),
      provider,
      inputSource: { load: async (execution) => providerInput(execution) },
    });
    const runtime2 = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "shared-2", agentId: "agent-2" }),
      provider,
      inputSource: { load: async (execution) => providerInput(execution) },
    });

    await expect(
      runtime1.invoke(HUMAN, invocation("wrong-room", "wrong-target", "agent-2")),
    ).rejects.toMatchObject({ code: "agent_capability_forbidden", status: 403 });
    expect(fixture.calls).not.toContain("invoke:wrong-target");

    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) =>
        runtime1.invoke(HUMAN, invocation(`shared-a-${index}`, `shared-a-${index}`)),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        runtime2.invoke(
          HUMAN,
          invocation(`shared-b-${index}`, `shared-b-${index}`, "agent-2"),
        ),
      ),
    ]);
    await vi.waitFor(() => expect(active).toBe(8));
    expect(maximumActive).toBe(8);
    release.resolve();
    await Promise.all([runtime1.whenIdle(), runtime2.whenIdle()]);
    expect(maximumActive).toBe(8);
  });

  it("admits exact replay at a full durable room cap without double scheduling", async () => {
    const fixture = createAuthorityFixture();
    const release = deferred();
    const entered = deferred();
    let providerCalls = 0;
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "replay", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          providerCalls += 1;
          yield { type: "response_started" };
          entered.resolve();
          await release.promise;
          yield { type: "text_delta", delta: "done" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
      limits: { maxQueuedPerRoom: 1 },
    });

    await runtime.invoke(HUMAN, invocation("replay-room", "replay-active"));
    await entered.promise;
    const queued = await runtime.invoke(HUMAN, invocation("replay-room", "replay-queued"));
    const replayed = await runtime.invoke(HUMAN, invocation("replay-room", "replay-queued"));
    expect(replayed.id).toBe(queued.id);
    await expect(
      runtime.invoke(HUMAN, invocation("replay-room", "replay-overflow")),
    ).rejects.toMatchObject({ code: "target_busy", status: 429 });
    release.resolve();
    await runtime.whenIdle();
    expect(providerCalls).toBe(2);
  });

  it("installs a wakeup for a recovered retry that is not due yet", async () => {
    const fixture = createAuthorityFixture();
    const execution = await fixture.authority.invoke(
      HUMAN,
      invocation("restart-room", "restart-message"),
    );
    const retried = await fixture.authority.scheduleRetry(
      mintInternalAgentRuntimeContext({ runtimeId: "seed", agentId: "agent-1" }),
      {
        executionId: execution.id,
        attemptSeq: 1,
        errorCode: "upstream_timeout",
        now: 1_700_000_000_000,
      },
    );
    expect(retried.retryOrdinal).toBe(2);
    let due = false;
    const waits: number[] = [];
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async recoverPage() {
          return { recoveries: [{ execution: retried, nextRetryAt: 1_700_000_001_000 }] };
        },
        async claimNext(runtimeContext, roomId, now) {
          if (!due) return undefined;
          return fixture.authority.claimNext(runtimeContext, roomId, now);
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "restart", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "text_delta", delta: "restored" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (current) => providerInput(current) },
      clock: {
        now: () => 1_700_000_000_000,
        async wait(delayMs) {
          waits.push(delayMs);
          due = true;
        },
      },
    });

    await runtime.start();
    await runtime.whenIdle();
    expect(waits).toEqual([1_000]);
    expect(fixture.calls).toContain("complete:restart-message:restored");
  });

  it("claims an already-due recovered retry without applying a fresh backoff", async () => {
    const fixture = createAuthorityFixture();
    const execution = await fixture.authority.invoke(HUMAN, invocation("due-room", "due-message"));
    const retried = await fixture.authority.scheduleRetry(
      mintInternalAgentRuntimeContext({ runtimeId: "due-seed", agentId: "agent-1" }),
      { executionId: execution.id, attemptSeq: 1, errorCode: "upstream_timeout", now: 1_000 },
    );
    const waits: number[] = [];
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async recoverPage() {
          return { recoveries: [{ execution: retried, nextRetryAt: 1_500 }] };
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "due", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "text_delta", delta: "due" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (current) => providerInput(current) },
      clock: { now: () => 2_000, async wait(delayMs) { waits.push(delayMs); } },
    });
    await runtime.start();
    await runtime.whenIdle();
    expect(waits).toEqual([0]);
    expect(fixture.calls).toContain("complete:due-message:due");
  });

  it("consumes bounded recovery pages through their opaque cursor before startup returns", async () => {
    const fixture = createAuthorityFixture();
    const first = await fixture.authority.invoke(
      HUMAN,
      invocation("recovery-page-a", "recovery-page-message-a"),
    );
    const second = await fixture.authority.invoke(
      HUMAN,
      invocation("recovery-page-b", "recovery-page-message-b"),
    );
    const pageInputs: Array<{ readonly now: number; readonly limit: number; readonly cursor?: string }> = [];
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async recoverPage(_runtime, input) {
          pageInputs.push(input);
          return input.cursor === undefined
            ? { recoveries: [{ execution: first }], nextCursor: "page-two" }
            : { recoveries: [{ execution: second }] };
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "recovery-pages",
        agentId: "agent-1",
      }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "text_delta", delta: "restored" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (current) => providerInput(current) },
      clock: { now: () => 2_000, wait: async () => undefined },
    });

    await runtime.start();
    await runtime.whenIdle();
    expect(pageInputs).toEqual([
      { now: 2_000, limit: 64 },
      { now: 2_000, limit: 64, cursor: "page-two" },
    ]);
    expect(fixture.calls.filter((call) => call.startsWith("complete:"))).toEqual([
      "complete:recovery-page-message-a:restored",
      "complete:recovery-page-message-b:restored",
    ]);
  });

  it("keeps draining room FIFO when a recovery page enumerates a later execution first", async () => {
    const fixture = createAuthorityFixture();
    const earlier = await fixture.authority.invoke(
      HUMAN,
      invocation("recovery-fifo-room", "recovery-fifo-earlier"),
    );
    const later = await fixture.authority.invoke(
      HUMAN,
      invocation("recovery-fifo-room", "recovery-fifo-later"),
    );
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async recoverPage(_runtime, input) {
          return input.cursor === undefined
            ? { recoveries: [{ execution: later }], nextCursor: "after-later" }
            : { recoveries: [] };
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "recovery-fifo",
        agentId: "agent-1",
      }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "text_delta", delta: "restored" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (current) => providerInput(current) },
      clock: { now: () => 2_000, wait: async () => undefined },
    });

    await runtime.start();
    await runtime.whenIdle();
    expect(fixture.executions.get(earlier.id)?.status).toBe("completed");
    expect(fixture.executions.get(later.id)?.status).toBe("completed");
    expect(fixture.calls.filter((call) => call.startsWith("complete:"))).toEqual([
      "complete:recovery-fifo-earlier:restored",
      "complete:recovery-fifo-later:restored",
    ]);
  });

  it("retries a transient claim failure without losing the durable scheduled execution", async () => {
    const fixture = createAuthorityFixture();
    let claims = 0;
    const waits: number[] = [];
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async claimNext(context, roomId, now) {
          claims += 1;
          if (claims === 1) throw new Error("storage temporarily unavailable");
          return fixture.authority.claimNext(context, roomId, now);
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "claim-retry", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "text_delta", delta: "claimed" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
      clock: {
        now: () => 1_700_000_000_000,
        async wait(delayMs) { waits.push(delayMs); },
      },
    });
    await runtime.invoke(HUMAN, invocation("claim-room", "claim-message"));
    await runtime.whenIdle();
    expect(claims).toBe(2);
    expect(waits).toEqual([1_000]);
    expect(fixture.calls).toContain("complete:claim-message:claimed");
  });

  it("bounds previews, disables only a backpressured preview sink, and terminalizes overflow", async () => {
    const fixture = createAuthorityFixture();
    const previews: string[] = [];
    const provider: ProviderAdapter = {
      id: "provider-1",
      async *stream(input) {
        yield { type: "response_started" };
        if (input.invocation.sourceMessageId === "overflow") {
          yield { type: "text_delta", delta: "123456789" };
        } else {
          yield { type: "text_delta", delta: "one" };
          yield { type: "text_delta", delta: "two" };
          yield { type: "completed", finishReason: "stop" };
        }
      },
    };
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-preview",
        agentId: "agent-1",
      }),
      provider,
      inputSource: { load: async (execution) => providerInput(execution) },
      preview: (preview) => {
        previews.push(preview.text);
        return false;
      },
      limits: { maxPreviewBytes: 8 },
    });

    await runtime.invoke(HUMAN, invocation("room-preview", "backpressure"));
    await runtime.whenIdle();
    expect(previews).toEqual(["one"]);
    expect(fixture.calls).toContain("complete:backpressure:onetwo");

    await runtime.invoke(HUMAN, invocation("room-preview", "overflow"));
    await runtime.whenIdle();
    expect(fixture.calls).toContain("fail:provider_response_too_large");
    expect(
      [...fixture.executions.values()].find(
        (execution) => execution.sourceMessageId === "overflow",
      )?.status,
    ).toBe("failed");
  });

  it.each(["throw", "reject"] as const)(
    "disables a preview sink that %s without terminalizing execution",
    async (mode) => {
      const fixture = createAuthorityFixture();
      let previewCalls = 0;
      const runtime = createAgentRuntime({
        authority: fixture.authority,
        runtimeContext: mintInternalAgentRuntimeContext({
          runtimeId: `runtime-preview-${mode}`,
          agentId: "agent-1",
        }),
        provider: {
          id: "provider-1",
          async *stream() {
            yield { type: "response_started" };
            yield { type: "text_delta", delta: "one" };
            yield { type: "text_delta", delta: "two" };
            yield { type: "completed", finishReason: "stop" };
          },
        },
        inputSource: { load: async (execution) => providerInput(execution) },
        preview: () => {
          previewCalls += 1;
          if (mode === "throw") throw new Error("preview unavailable");
          return Promise.reject(new Error("preview unavailable"));
        },
      });

      await runtime.invoke(HUMAN, invocation(`preview-${mode}`, `preview-${mode}`));
      await runtime.whenIdle();
      expect(previewCalls).toBe(1);
      expect(fixture.calls).toContain(`complete:preview-${mode}:onetwo`);
      expect(fixture.calls.some((call) => call.startsWith("fail:"))).toBe(false);
    },
  );

  it("commits provider and read-only tool steps before continuation", async () => {
    const fixture = createAuthorityFixture();
    let providerPass = 0;
    const provider: ProviderAdapter = {
      id: "provider-1",
      async *stream() {
        providerPass += 1;
        yield { type: "response_started" };
        if (providerPass === 1) {
          yield {
            type: "tool_call_delta",
            callId: "call-1",
            toolId: "read.status",
            argumentsDelta: "{\"path\":\".\"}",
          };
          yield { type: "completed", finishReason: "tool_calls" };
        } else {
          yield { type: "text_delta", delta: "tool complete" };
          yield { type: "completed", finishReason: "stop" };
        }
      },
    };
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-tool",
        agentId: "agent-1",
      }),
      provider,
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [
            {
              id: "read.status",
              description: "read status",
              confirmationRequirement: "read_only",
              parametersSchema: { type: "object" },
            },
          ],
        }),
      },
      tools: [
        {
          descriptor: {
            id: "read.status",
            description: "read status",
            confirmationRequirement: "read_only",
            parametersSchema: { type: "object" },
          },
          async execute(parameters) {
            fixture.calls.push(`adapter:${JSON.stringify(parameters)}`);
            return { modelInput: { clean: true }, closedSummary: "clean" };
          },
        },
      ],
    });

    await runtime.invoke(HUMAN, invocation("room-tool", "tool-message"));
    await runtime.whenIdle();
    expect(providerPass).toBe(2);
    expect(fixture.calls).toEqual([
      "invoke:tool-message",
      "claim:tool-message",
      "step:model_generation:1",
      "step:tool_call:2",
      "prepare:read.status",
      "dispatch:read.status",
      'adapter:{"path":"."}',
      "settle:succeeded",
      "step:tool_result:3",
      "step:model_generation:4",
      "complete:tool-message:tool complete",
    ]);
  });

  it("resumes a confirmed side effect from durable parameters and continues the same attempt", async () => {
    const fixture = createAuthorityFixture();
    let providerPass = 0;
    let adapterCalls = 0;
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "runtime-side", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          providerPass += 1;
          yield { type: "response_started" };
          if (providerPass === 1) {
            yield {
              type: "tool_call_delta",
              callId: "call-side",
              toolId: "write.file",
              argumentsDelta: '{"path":"note.txt","content":"hello"}',
            };
            yield { type: "completed", finishReason: "tool_calls" };
          } else {
            yield { type: "text_delta", delta: "written" };
            yield { type: "completed", finishReason: "stop" };
          }
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{
            id: "write.file",
            description: "write file",
            confirmationRequirement: "side_effect",
            parametersSchema: { type: "object" },
          }],
        }),
      },
      tools: [{
        descriptor: {
          id: "write.file",
          description: "write file",
          confirmationRequirement: "side_effect",
          parametersSchema: { type: "object" },
        },
        async execute(parameters) {
          adapterCalls += 1;
          expect(parameters).toEqual({ path: "note.txt", content: "hello" });
          return { modelInput: { written: true }, closedSummary: "written" };
        },
      }],
    });

    const waiting = await runtime.invoke(HUMAN, invocation("room-side", "message-side"));
    await runtime.whenIdle();
    expect(adapterCalls).toBe(0);
    const parameterHash = createHash("sha256")
      .update('{"content":"hello","path":"note.txt"}', "utf8")
      .digest("hex");
    const confirmationInput = {
      executionId: waiting.id,
      attemptSeq: 1,
      toolId: "write.file",
      parameterHash,
      target: "note.txt",
      impact: "create file",
      reversibility: "compensatable",
      expiresAt: 1_700_000_030_000,
    } as const;
    const [confirmed, replayed] = await Promise.all([
      runtime.confirmTool(HUMAN, confirmationInput),
      runtime.confirmTool(HUMAN, confirmationInput),
    ]);
    expect(confirmed.id).toBe(waiting.id);
    expect(replayed.id).toBe(waiting.id);
    await runtime.whenIdle();
    expect(adapterCalls).toBe(1);
    expect(providerPass).toBe(2);
    expect(fixture.calls).toContain("complete:message-side:written");
  });

  it("persists outcome unknown and its sealed token when an adapter reports a post-effect durability gap", async () => {
    const fixture = createAuthorityFixture();
    const settleTool = vi.fn(fixture.authority.settleTool.bind(fixture.authority));
    const failExecution = vi.fn(fixture.authority.failExecution.bind(fixture.authority));
    const runtime = createAgentRuntime({
      authority: { ...fixture.authority, settleTool, failExecution },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "runtime-unknown-effect", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "tool_call_delta", callId: "unknown", toolId: "write.file", argumentsDelta: "{}" };
          yield { type: "completed", finishReason: "tool_calls" };
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{ id: "write.file", description: "write", confirmationRequirement: "side_effect", parametersSchema: { type: "object" } }],
        }),
      },
      tools: [{
        descriptor: { id: "write.file", description: "write", confirmationRequirement: "side_effect", parametersSchema: { type: "object" } },
        async execute() {
          throw Object.assign(new Error("durability unknown"), {
            code: "tool_failed", effectOutcomeUnknown: true, sealedCompensation: "sealed-after-effect",
          });
        },
      }],
    });
    const waiting = await runtime.invoke(HUMAN, invocation("unknown-effect-room", "unknown-effect-message"));
    await runtime.whenIdle();
    await runtime.confirmTool(HUMAN, {
      executionId: waiting.id, attemptSeq: 1, toolId: "write.file",
      parameterHash: createHash("sha256").update("{}", "utf8").digest("hex"),
      target: "target", impact: "impact", reversibility: "compensatable",
      expiresAt: 1_700_000_030_000,
    });
    await runtime.whenIdle();
    expect(settleTool).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: "outcome_unknown", closedSummary: "tool_effect_unconfirmed",
      sealedCompensation: "sealed-after-effect",
    }));
    expect(failExecution).not.toHaveBeenCalled();
  });

  it("never downgrades a resolved side effect to failed when success settlement is unconfirmed", async () => {
    const fixture = createAuthorityFixture();
    const settleTool = vi.fn(async (runtimeContext, input) => {
      if (input.outcome === "succeeded") {
        throw Object.assign(new Error("storage_unavailable"), {
          code: "storage_unavailable", status: 503,
        });
      }
      return fixture.authority.settleTool(runtimeContext, input);
    });
    const runtime = createAgentRuntime({
      authority: { ...fixture.authority, settleTool },
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-unconfirmed-success", agentId: "agent-1",
      }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "tool_call_delta", callId: "write", toolId: "write.file", argumentsDelta: "{}" };
          yield { type: "completed", finishReason: "tool_calls" };
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{
            id: "write.file", description: "write",
            confirmationRequirement: "side_effect", parametersSchema: { type: "object" },
          }],
        }),
      },
      tools: [{
        descriptor: {
          id: "write.file", description: "write",
          confirmationRequirement: "side_effect", parametersSchema: { type: "object" },
        },
        async execute() {
          return {
            modelInput: { written: true }, closedSummary: "written",
            sealedCompensation: "sealed-resolved-effect",
          };
        },
      }],
    });
    const waiting = await runtime.invoke(HUMAN, invocation(
      "unconfirmed-success-room", "unconfirmed-success-message",
    ));
    await runtime.whenIdle();
    await runtime.confirmTool(HUMAN, {
      executionId: waiting.id, attemptSeq: 1, toolId: "write.file",
      parameterHash: createHash("sha256").update("{}", "utf8").digest("hex"),
      target: "target", impact: "impact", reversibility: "compensatable",
      expiresAt: 1_700_000_030_000,
    });
    await runtime.whenIdle();
    expect(settleTool).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: "outcome_unknown", closedSummary: "tool_settlement_unconfirmed",
      sealedCompensation: "sealed-resolved-effect",
    }));
    expect(settleTool).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: "failed",
    }));
  });

  it("resumes the persisted provider-ordered tool suffix after side-effect confirmation", async () => {
    const fixture = createAuthorityFixture();
    const adapters: string[] = [];
    let providerPass = 0;
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "plan", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          providerPass += 1;
          yield { type: "response_started" };
          if (providerPass === 1) {
            yield { type: "tool_call_delta", callId: "write", toolId: "write.file", argumentsDelta: "{}" };
            yield { type: "tool_call_delta", callId: "read", toolId: "read.status", argumentsDelta: "{}" };
            yield { type: "completed", finishReason: "tool_calls" };
          } else {
            yield { type: "text_delta", delta: "done" };
            yield { type: "completed", finishReason: "stop" };
          }
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [
            { id: "write.file", description: "write", confirmationRequirement: "side_effect", parametersSchema: { type: "object" } },
            { id: "read.status", description: "read", confirmationRequirement: "read_only", parametersSchema: { type: "object" } },
          ],
        }),
      },
      tools: [
        {
          descriptor: { id: "write.file", description: "write", confirmationRequirement: "side_effect", parametersSchema: { type: "object" } },
          async execute() { adapters.push("write.file"); return { modelInput: { wrote: true }, closedSummary: "wrote" }; },
        },
        {
          descriptor: { id: "read.status", description: "read", confirmationRequirement: "read_only", parametersSchema: { type: "object" } },
          async execute() { adapters.push("read.status"); return { modelInput: { read: true }, closedSummary: "read" }; },
        },
      ],
    });
    const waiting = await runtime.invoke(HUMAN, invocation("plan-room", "plan-message"));
    await runtime.whenIdle();
    expect(adapters).toEqual([]);
    const parameterHash = createHash("sha256").update("{}", "utf8").digest("hex");
    await runtime.confirmTool(HUMAN, {
      executionId: waiting.id,
      attemptSeq: 1,
      toolId: "write.file",
      parameterHash,
      target: "target",
      impact: "impact",
      reversibility: "compensatable",
      expiresAt: 1_700_000_030_000,
    });
    await runtime.whenIdle();
    expect(adapters).toEqual(["write.file", "read.status"]);
    expect(providerPass).toBe(2);
    expect(fixture.calls).toContain("complete:plan-message:done");
  });

  it("executes two identical side-effect calls in one attempt with distinct durable call identities", async () => {
    const fixture = createAuthorityFixture();
    const adapters: string[] = [];
    let providerPass = 0;
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "repeat-call", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          providerPass += 1;
          yield { type: "response_started" };
          if (providerPass === 1) {
            yield { type: "tool_call_delta", callId: "write-1", toolId: "write.file", argumentsDelta: "{}" };
            yield { type: "tool_call_delta", callId: "write-2", toolId: "write.file", argumentsDelta: "{}" };
            yield { type: "completed", finishReason: "tool_calls" };
          } else {
            yield { type: "text_delta", delta: "done" };
            yield { type: "completed", finishReason: "stop" };
          }
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{
            id: "write.file", description: "write", confirmationRequirement: "side_effect",
            parametersSchema: { type: "object" },
          }],
        }),
      },
      tools: [{
        descriptor: {
          id: "write.file", description: "write", confirmationRequirement: "side_effect",
          parametersSchema: { type: "object" },
        },
        async execute() { adapters.push("write.file"); return { modelInput: { wrote: true }, closedSummary: "wrote" }; },
      }],
    });
    const waiting = await runtime.invoke(HUMAN, invocation("repeat-room", "repeat-message"));
    await runtime.whenIdle();
    const confirmationInput = {
      executionId: waiting.id, attemptSeq: 1, toolId: "write.file",
      parameterHash: createHash("sha256").update("{}", "utf8").digest("hex"),
      target: "target", impact: "impact", reversibility: "compensatable" as const,
      expiresAt: 1_700_000_030_000,
    };
    await runtime.confirmTool(HUMAN, confirmationInput);
    await runtime.whenIdle();
    expect(adapters).toEqual(["write.file"]);
    await runtime.confirmTool(HUMAN, confirmationInput);
    await runtime.whenIdle();
    expect(adapters).toEqual(["write.file", "write.file"]);
    expect(fixture.calls.filter((call) => call === "prepare:write.file")).toHaveLength(2);
    expect(providerPass).toBe(2);
    expect(fixture.calls).toContain("complete:repeat-message:done");
  });

  it("fails a committed side-effect dispatch when the resumed adapter binding changes", async () => {
    const fixture = createAuthorityFixture();
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async resumeConfirmedTool(context, input) {
          const resumed = await fixture.authority.resumeConfirmedTool(context, input);
          return {
            ...resumed,
            dispatch: { ...resumed.dispatch, toolId: "write.other" },
          };
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "binding", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield {
            type: "tool_call_delta",
            callId: "call-binding",
            toolId: "write.file",
            argumentsDelta: "{}",
          };
          yield { type: "completed", finishReason: "tool_calls" };
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{
            id: "write.file",
            description: "write",
            confirmationRequirement: "side_effect",
            parametersSchema: { type: "object" },
          }],
        }),
      },
      tools: [{
        descriptor: {
          id: "write.file",
          description: "write",
          confirmationRequirement: "side_effect",
          parametersSchema: { type: "object" },
        },
        async execute() {
          throw new Error("must not execute");
        },
      }],
    });
    const waiting = await runtime.invoke(HUMAN, invocation("binding-room", "binding-message"));
    await runtime.whenIdle();
    const parameterHash = createHash("sha256").update("{}", "utf8").digest("hex");
    await runtime.confirmTool(HUMAN, {
      executionId: waiting.id,
      attemptSeq: 1,
      toolId: "write.file",
      parameterHash,
      target: "target",
      impact: "impact",
      reversibility: "compensatable",
      expiresAt: 1_700_000_030_000,
    });
    await runtime.whenIdle();
    expect(fixture.calls).toContain("settle:failed");
    expect(fixture.calls.some((call) => call.startsWith("step:tool_result"))).toBe(false);
  });

  it.each([
    ["execution", (resumed: Awaited<ReturnType<AgentRuntimeSchedulerAuthority["resumeConfirmedTool"]>>) => ({
      ...resumed, execution: { ...resumed.execution, id: "execution-other" },
    })],
    ["attempt", (resumed: Awaited<ReturnType<AgentRuntimeSchedulerAuthority["resumeConfirmedTool"]>>) => ({
      ...resumed, execution: { ...resumed.execution, currentAttemptSeq: 2 },
    })],
    ["room", (resumed: Awaited<ReturnType<AgentRuntimeSchedulerAuthority["resumeConfirmedTool"]>>) => ({
      ...resumed, execution: { ...resumed.execution, roomId: "room-other" },
    })],
    ["phase", (resumed: Awaited<ReturnType<AgentRuntimeSchedulerAuthority["resumeConfirmedTool"]>>) => ({
      ...resumed, execution: { ...resumed.execution, toolDispatchPhase: "finished" as const },
    })],
    ["dispatch-state", (resumed: Awaited<ReturnType<AgentRuntimeSchedulerAuthority["resumeConfirmedTool"]>>) => ({
      ...resumed, dispatch: { ...resumed.dispatch, state: "succeeded" as const, settledAt: resumed.dispatch.dispatchedAt },
    })],
    ["tool-plan", (resumed: Awaited<ReturnType<AgentRuntimeSchedulerAuthority["resumeConfirmedTool"]>>) => ({
      ...resumed,
      remainingCalls: [{ callId: "forged", toolId: "write.file", parameters: {} }],
    })],
  ] as const)("never calls an adapter for a resumed side effect with wrong %s", async (_label, mutate) => {
    const fixture = createAuthorityFixture();
    let adapterCalls = 0;
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async resumeConfirmedTool(context, input) {
          return mutate(await fixture.authority.resumeConfirmedTool(context, input));
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: `wrong-${_label}`, agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "tool_call_delta", callId: "wrong", toolId: "write.file", argumentsDelta: "{}" };
          yield { type: "completed", finishReason: "tool_calls" };
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{ id: "write.file", description: "write", confirmationRequirement: "side_effect", parametersSchema: { type: "object" } }],
        }),
      },
      tools: [{
        descriptor: { id: "write.file", description: "write", confirmationRequirement: "side_effect", parametersSchema: { type: "object" } },
        async execute() { adapterCalls += 1; return { modelInput: {}, closedSummary: "unexpected" }; },
      }],
    });
    const waiting = await runtime.invoke(HUMAN, invocation(`wrong-${_label}`, `wrong-${_label}`));
    await runtime.whenIdle();
    const parameterHash = createHash("sha256").update("{}", "utf8").digest("hex");
    await runtime.confirmTool(HUMAN, {
      executionId: waiting.id, attemptSeq: 1, toolId: "write.file", parameterHash,
      target: "target", impact: "impact", reversibility: "compensatable",
      expiresAt: 1_700_000_030_000,
    });
    await runtime.whenIdle();
    expect(adapterCalls).toBe(0);
    expect(fixture.calls).toContain("settle:failed");
  });

  it("aborts an interrupted side effect but persists its late settlement only", async () => {
    const fixture = createAuthorityFixture();
    const entered = deferred();
    const release = deferred();
    let observedAbort = false;
    const settleInputs: import("../persistence/contracts.js").SettleToolDispatchInput[] = [];
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async settleTool(context, input) {
          settleInputs.push(input);
          return fixture.authority.settleTool(context, input);
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "late-side", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield {
            type: "tool_call_delta",
            callId: "call-late",
            toolId: "write.file",
            argumentsDelta: "{}",
          };
          yield { type: "completed", finishReason: "tool_calls" };
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{
            id: "write.file",
            description: "write",
            confirmationRequirement: "side_effect",
            parametersSchema: { type: "object" },
          }],
        }),
      },
      tools: [{
        descriptor: {
          id: "write.file",
          description: "write",
          confirmationRequirement: "side_effect",
          parametersSchema: { type: "object" },
        },
        async execute(_parameters, signal) {
          entered.resolve();
          await release.promise;
          observedAbort = signal.aborted;
          return {
            modelInput: { mustNotContinue: true },
            closedSummary: "late-success",
            sealedCompensation: "sealed-compensation",
          };
        },
      }],
    });
    const waiting = await runtime.invoke(HUMAN, invocation("late-room", "late-message"));
    await runtime.whenIdle();
    const parameterHash = createHash("sha256").update("{}", "utf8").digest("hex");
    await runtime.confirmTool(HUMAN, {
      executionId: waiting.id,
      attemptSeq: 1,
      toolId: "write.file",
      parameterHash,
      target: "target",
      impact: "impact",
      reversibility: "compensatable",
      expiresAt: 1_700_000_030_000,
    });
    await entered.promise;
    await runtime.interrupt(HUMAN, waiting.id, "requested_by_requester");
    release.resolve();
    await runtime.whenIdle();
    expect(observedAbort).toBe(true);
    expect(settleInputs).toEqual([
      expect.objectContaining({
        outcome: "succeeded",
        closedSummary: "late-success",
        sealedCompensation: "sealed-compensation",
      }),
    ]);
    expect(fixture.calls.some((call) => call.startsWith("step:tool_result"))).toBe(false);
  });

  it("waits boundedly for an active side-effect settlement during close", async () => {
    const fixture = createAuthorityFixture();
    const entered = deferred();
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "close-side", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "tool_call_delta", callId: "close-side", toolId: "write.file", argumentsDelta: "{}" };
          yield { type: "completed", finishReason: "tool_calls" };
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{
            id: "write.file", description: "write", confirmationRequirement: "side_effect",
            parametersSchema: { type: "object" },
          }],
        }),
      },
      tools: [{
        descriptor: {
          id: "write.file", description: "write", confirmationRequirement: "side_effect",
          parametersSchema: { type: "object" },
        },
        async execute(_parameters, signal) {
          entered.resolve();
          while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1));
          return { modelInput: { late: true }, closedSummary: "late-close" };
        },
      }],
      limits: { closeTimeoutMs: 1_000 },
    });
    const waiting = await runtime.invoke(HUMAN, invocation("close-side-room", "close-side-message"));
    await runtime.whenIdle();
    const parameterHash = createHash("sha256").update("{}", "utf8").digest("hex");
    await runtime.confirmTool(HUMAN, {
      executionId: waiting.id, attemptSeq: 1, toolId: "write.file", parameterHash,
      target: "target", impact: "impact", reversibility: "compensatable",
      expiresAt: 1_700_000_030_000,
    });
    await entered.promise;
    await runtime.close();
    expect(fixture.calls).toContain("settle:succeeded");
    expect(fixture.calls.some((call) => call.startsWith("step:tool_result"))).toBe(false);
  });

  it("never starts an adapter when close wins an in-flight resume RPC", async () => {
    const fixture = createAuthorityFixture();
    const resumeEntered = deferred();
    const releaseResume = deferred();
    let adapterCalls = 0;
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async resumeConfirmedTool(context, input) {
          resumeEntered.resolve();
          await releaseResume.promise;
          return fixture.authority.resumeConfirmedTool(context, input);
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "close-rpc", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "tool_call_delta", callId: "close-rpc", toolId: "write.file", argumentsDelta: "{}" };
          yield { type: "completed", finishReason: "tool_calls" };
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{ id: "write.file", description: "write", confirmationRequirement: "side_effect", parametersSchema: { type: "object" } }],
        }),
      },
      tools: [{
        descriptor: { id: "write.file", description: "write", confirmationRequirement: "side_effect", parametersSchema: { type: "object" } },
        async execute() { adapterCalls += 1; return { modelInput: {}, closedSummary: "wrong" }; },
      }],
      limits: { closeTimeoutMs: 1_000 },
    });
    const waiting = await runtime.invoke(HUMAN, invocation("close-rpc-room", "close-rpc-message"));
    await runtime.whenIdle();
    const parameterHash = createHash("sha256").update("{}", "utf8").digest("hex");
    await runtime.confirmTool(HUMAN, {
      executionId: waiting.id, attemptSeq: 1, toolId: "write.file", parameterHash,
      target: "target", impact: "impact", reversibility: "compensatable",
      expiresAt: 1_700_000_030_000,
    });
    await resumeEntered.promise;
    const closing = runtime.close();
    releaseResume.resolve();
    await closing;
    expect(adapterCalls).toBe(0);
    expect(fixture.calls).toContain("settle:outcome_unknown");
  });

  it("releases a blocked durable handle on close so a replacement runtime can claim it", async () => {
    const fixture = createAuthorityFixture();
    const queued = await fixture.authority.invoke(HUMAN, invocation("blocked-close-room", "blocked-close-message"));
    const blocked = createAgentRuntime({
      authority: { ...fixture.authority, async claimNext() { return undefined; } },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "blocked-close", agentId: "agent-1" }),
      provider: { id: "provider-1", async *stream() { yield* []; } },
      inputSource: { load: async (execution) => providerInput(execution) },
    });
    await blocked.start();
    await Promise.resolve();
    await blocked.close();
    const replacement = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "blocked-replacement", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "text_delta", delta: "recovered" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
    });
    await replacement.start();
    await replacement.whenIdle();
    expect(fixture.executions.get(queued.id)?.status).toBe("completed");
  });

  it("retries only transient provider errors at 1s then 4s and dead-letters attempt three", async () => {
    const fixture = createAuthorityFixture();
    const waits: number[] = [];
    let attempt = 0;
    const provider: ProviderAdapter = {
      id: "provider-1",
      async *stream() {
        attempt += 1;
        if (attempt < 3) {
          throw Object.assign(new Error("upstream_timeout"), {
            code: "upstream_timeout",
          });
        }
        yield { type: "response_started" };
        yield { type: "text_delta", delta: "recovered" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-retry",
        agentId: "agent-1",
      }),
      provider,
      inputSource: { load: async (execution) => providerInput(execution) },
      clock: {
        now: () => 1_700_000_000_000,
        async wait(delayMs) {
          waits.push(delayMs);
        },
      },
    });

    await runtime.invoke(HUMAN, invocation("room-retry", "retry-message"));
    await runtime.whenIdle();
    expect(waits).toEqual([1_000, 4_000]);
    expect(fixture.calls.filter((call) => call.startsWith("retry:"))).toEqual([
      "retry:1:upstream_timeout",
      "retry:2:upstream_timeout",
    ]);
    expect(fixture.calls).toContain("complete:retry-message:recovered");

    attempt = 0;
    const alwaysTransient: ProviderAdapter = {
      id: "provider-1",
      async *stream() {
        yield* [];
        throw Object.assign(new Error("upstream_unavailable"), {
          code: "upstream_unavailable",
        });
      },
    };
    const deadLetter = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-dead-letter",
        agentId: "agent-1",
      }),
      provider: alwaysTransient,
      inputSource: { load: async (execution) => providerInput(execution) },
      clock: {
        now: () => 1_700_000_000_000,
        async wait() {},
      },
    });
    await deadLetter.invoke(HUMAN, invocation("room-dead", "dead-message"));
    await deadLetter.whenIdle();
    const dead = [...fixture.executions.values()].find(
      (execution) => execution.sourceMessageId === "dead-message",
    );
    expect(dead).toMatchObject({ status: "failed", retryOrdinal: 3 });
    expect(dead?.currentAttemptSeq).toBe(3);
  });

  it("does not classify provider target_busy as a transient provider failure", async () => {
    const fixture = createAuthorityFixture();
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "provider-busy", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield* [];
          throw Object.assign(new Error("target_busy"), { code: "target_busy", status: 429 });
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
    });
    await runtime.invoke(HUMAN, invocation("provider-busy", "provider-busy"));
    await runtime.whenIdle();
    expect(fixture.calls.some((call) => call.startsWith("retry:"))).toBe(false);
    expect(fixture.calls).toContain("fail:provider_failure");
  });

  it("commits interruption before aborting provider work and recovers queued facts on start", async () => {
    const fixture = createAuthorityFixture();
    const entered = deferred();
    let abortObservedAfterCommit = false;
    const provider: ProviderAdapter = {
      id: "provider-1",
      async *stream(_input, signal) {
        yield { type: "response_started" };
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abortObservedAfterCommit = fixture.calls.some((call) =>
                call.startsWith("interrupt:"),
              );
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    };
    const runtime = createAgentRuntime({
      authority: fixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-interrupt",
        agentId: "agent-1",
      }),
      provider,
      inputSource: { load: async (execution) => providerInput(execution) },
    });

    const accepted = await runtime.invoke(
      HUMAN,
      invocation("room-interrupt", "interrupt-message"),
    );
    await entered.promise;
    const cancelled = await runtime.interrupt(
      HUMAN,
      accepted.id,
      "requested_by_requester",
    );
    await runtime.whenIdle();
    expect(cancelled.status).toBe("cancelled");
    expect(abortObservedAfterCommit).toBe(true);
    expect(fixture.calls.some((call) => call.startsWith("complete:interrupt"))).toBe(false);

    const recoveryFixture = createAuthorityFixture();
    await recoveryFixture.authority.invoke(HUMAN, invocation("room-recover", "recover-message"));
    const recovery = createAgentRuntime({
      authority: recoveryFixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-recover",
        agentId: "agent-1",
      }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "text_delta", delta: "restored" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
    });
    await recovery.start();
    await recovery.whenIdle();
    expect(recoveryFixture.calls).toContain("recover");
    expect(recoveryFixture.calls).toContain("complete:recover-message:restored");
  });

  it("persists terminal provider errors and close discards abort-ignorant late output", async () => {
    const terminalFixture = createAuthorityFixture();
    const terminal = createAgentRuntime({
      authority: terminalFixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-terminal",
        agentId: "agent-1",
      }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield* [];
          throw Object.assign(new Error("provider_invalid_response"), {
            code: "provider_invalid_response",
          });
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
    });
    await terminal.invoke(HUMAN, invocation("room-terminal", "terminal-message"));
    await terminal.whenIdle();
    expect(terminalFixture.calls).toContain("fail:provider_invalid_response");

    const closeFixture = createAuthorityFixture();
    const late = deferred();
    const entered = deferred();
    const closing = createAgentRuntime({
      authority: closeFixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-close",
        agentId: "agent-1",
      }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          entered.resolve();
          await late.promise;
          yield { type: "text_delta", delta: "must-not-commit" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
      clock: {
        now: () => 1_700_000_000_000,
        async wait() {},
      },
      limits: { closeTimeoutMs: 1 },
    });
    await closing.invoke(HUMAN, invocation("room-close", "close-message"));
    await entered.promise;
    await closing.close();
    late.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(closeFixture.calls.some((call) => call.startsWith("step:"))).toBe(false);
    expect(closeFixture.calls.some((call) => call.startsWith("complete:"))).toBe(false);
    await expect(
      closing.invoke(HUMAN, invocation("room-close", "after-close")),
    ).rejects.toMatchObject({ code: "runtime_closed", status: 503 });
  });

  it("releases an interrupted abort-ignorant provider and does not mis-settle a read tool on close", async () => {
    const providerFixture = createAuthorityFixture();
    const providerEntered = deferred();
    const providerRuntime = createAgentRuntime({
      authority: providerFixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "abort-provider", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          providerEntered.resolve();
          await new Promise<void>(() => undefined);
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
    });
    const accepted = await providerRuntime.invoke(
      HUMAN,
      invocation("abort-provider", "abort-provider"),
    );
    await providerEntered.promise;
    await providerRuntime.interrupt(HUMAN, accepted.id, "requested_by_requester");
    await providerRuntime.whenIdle();
    expect(providerFixture.executions.get(accepted.id)?.status).toBe("cancelled");

    const toolFixture = createAuthorityFixture();
    const toolEntered = deferred();
    const toolRuntime = createAgentRuntime({
      authority: toolFixture.authority,
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "abort-tool", agentId: "agent-1" }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield {
            type: "tool_call_delta",
            callId: "call-close",
            toolId: "read.status",
            argumentsDelta: "{}",
          };
          yield { type: "completed", finishReason: "tool_calls" };
        },
      },
      inputSource: {
        load: async (execution) => ({
          ...providerInput(execution),
          availableTools: [{
            id: "read.status",
            description: "read",
            confirmationRequirement: "read_only",
            parametersSchema: { type: "object" },
          }],
        }),
      },
      tools: [{
        descriptor: {
          id: "read.status",
          description: "read",
          confirmationRequirement: "read_only",
          parametersSchema: { type: "object" },
        },
        async execute() {
          toolEntered.resolve();
          return new Promise(() => undefined);
        },
      }],
      clock: { now: () => 1_700_000_000_000, async wait() {} },
      limits: { closeTimeoutMs: 1 },
    });
    await toolRuntime.invoke(HUMAN, invocation("abort-tool", "abort-tool"));
    await toolEntered.promise;
    await toolRuntime.close();
    expect(toolFixture.calls).not.toContain("settle:failed");
    expect(toolFixture.calls).not.toContain("fail:tool_failure");
    expect(toolFixture.calls).toContain("fail:provider_cancelled");
  });

  it("discards a stale completion CAS without attempting a second terminal write", async () => {
    const fixture = createAuthorityFixture();
    const failSpy = vi.fn(fixture.authority.failExecution.bind(fixture.authority));
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        failExecution: failSpy,
        async completeExecution() {
          throw Object.assign(new Error("execution_conflict"), {
            code: "execution_conflict",
            status: 409,
          });
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-stale",
        agentId: "agent-1",
      }),
      provider: {
        id: "provider-1",
        async *stream() {
          yield { type: "response_started" };
          yield { type: "text_delta", delta: "late" };
          yield { type: "completed", finishReason: "stop" };
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
    });

    await runtime.invoke(HUMAN, invocation("room-stale", "stale-message"));
    await runtime.whenIdle();
    expect(failSpy).not.toHaveBeenCalled();
  });

  it("runs a sealed sandbox compensation as one new execution without invoking Provider", async () => {
    const fixture = createAuthorityFixture();
    const original = await fixture.authority.invoke(
      HUMAN,
      invocation("room-compensation", "message-compensation"),
    );
    const originalCompleted: AgentExecution = {
      ...original,
      status: "completed",
      startedAt: original.queuedAt,
      finishedAt: original.queuedAt,
      updatedAt: original.queuedAt,
      resultMessageId: "original-result",
    };
    fixture.executions.set(original.id, originalCompleted);
    const compensationAt = "2023-11-14T22:13:30.000Z";
    const compensation: AgentExecution = {
      id: "compensation-execution",
      roomId: original.roomId,
      sourceMessageId: original.sourceMessageId,
      requesterId: HUMAN.principal.actorId,
      agentId: original.agentId,
      status: "queued",
      actionCategory: "model_generation",
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      providerId: original.providerId,
      modelId: original.modelId,
      recoveryCursor: 0,
      queuedAt: compensationAt,
      updatedAt: compensationAt,
      compensatesExecutionId: original.id,
    };
    fixture.executions.set(compensation.id, compensation);
    const claimedCompensation: AgentExecution = {
      ...compensation,
      status: "running",
      startedAt: compensationAt,
    };
    const resumedCompensation: AgentExecution = {
      ...claimedCompensation,
      actionCategory: "tool_call",
      toolDispatchPhase: "dispatched",
      currentToolId: "sandbox-file.write",
      recoveryCursor: 1,
    };
    let compensationClaimed = false;
    const provider = vi.fn();
    const compensate = vi.fn(async () => ({
      modelInput: { path: "note.txt", restored: true },
      closedSummary: "sandbox_compensation:restored:note.txt",
    }));
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async compensate() {
          fixture.executions.set(compensation.id, compensation);
          compensationClaimed = false;
          return compensation;
        },
        async claimNext(runtimeContext, roomId, now) {
          if (!compensationClaimed && roomId === compensation.roomId) {
            compensationClaimed = true;
            fixture.executions.set(compensation.id, claimedCompensation);
            return claimedCompensation;
          }
          return fixture.authority.claimNext(runtimeContext, roomId, now);
        },
        async resumeCompensation() {
          fixture.executions.set(compensation.id, resumedCompensation);
          return {
            execution: resumedCompensation,
            dispatch: {
              id: "compensation-dispatch",
              executionId: compensation.id,
              attemptSeq: 1,
              grantId: "compensation-grant",
              toolId: "sandbox-file.write",
              parameterHash: createHash("sha256").update("sealed-private-token").digest("hex"),
              state: "dispatched" as const,
              dispatchedAt: compensationAt,
            },
            sealedCompensation: "sealed-private-token",
          };
        },
      },
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-compensation",
        agentId: "agent-1",
      }),
      provider: {
        id: "provider-1",
        async *stream() {
          provider();
          yield* [];
        },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
      tools: [{
        descriptor: {
          id: "sandbox-file.write",
          description: "sandbox",
          confirmationRequirement: "side_effect",
          parametersSchema: { type: "object" },
        },
        async execute() {
          throw new Error("must not execute forward path");
        },
        compensate,
      }],
      createMessageId: () => "compensation-result",
    });

    await expect(runtime.compensate(HUMAN, original.id, "original-dispatch")).resolves.toEqual(compensation);
    await runtime.whenIdle();
    expect(provider).not.toHaveBeenCalled();
    expect(compensate).toHaveBeenCalledWith("sealed-private-token", expect.any(AbortSignal));
    expect(fixture.calls).toContain(
      "complete-compensation:compensation-dispatch:compensation-result",
    );
    expect(fixture.calls).not.toContain("settle:succeeded");
  });

  it("records outcome unknown when physical compensation succeeds but atomic completion is unconfirmed", async () => {
    const fixture = createAuthorityFixture();
    const original = await fixture.authority.invoke(
      HUMAN,
      invocation("room-compensation-crash", "message-compensation-crash"),
    );
    fixture.executions.set(original.id, {
      ...original,
      status: "completed",
      startedAt: original.queuedAt,
      finishedAt: original.queuedAt,
      updatedAt: original.queuedAt,
      resultMessageId: "original-result",
    });
    const compensationAt = "2023-11-14T22:13:30.000Z";
    const queuedCompensation: AgentExecution = {
      ...original,
      id: "compensation-crash",
      status: "queued",
      actionCategory: "model_generation",
      queuedAt: compensationAt,
      updatedAt: compensationAt,
      compensatesExecutionId: original.id,
    };
    fixture.executions.set(queuedCompensation.id, queuedCompensation);
    const compensation: AgentExecution = {
      ...queuedCompensation,
      status: "running",
      startedAt: compensationAt,
    };
    const dispatched: AgentExecution = {
      ...compensation,
      actionCategory: "tool_call",
      toolDispatchPhase: "dispatched",
      currentToolId: "sandbox-file.write",
      recoveryCursor: 1,
    };
    const settleTool = vi.fn(async (_runtime, input) => ({
      id: input.dispatchId,
      executionId: input.executionId,
      attemptSeq: input.attemptSeq,
      grantId: input.grantId,
      toolId: "sandbox-file.write",
      parameterHash: createHash("sha256").update("sealed-private-token").digest("hex"),
      state: input.outcome,
      dispatchedAt: compensationAt,
      settledAt: compensationAt,
      closedSummary: input.closedSummary,
    }));
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async claimNext() {
          if (fixture.executions.get(compensation.id)?.status !== "queued") return undefined;
          fixture.executions.set(compensation.id, compensation);
          return compensation;
        },
        async resumeCompensation() {
          return {
            execution: dispatched,
            dispatch: {
              id: "compensation-crash-dispatch",
              executionId: compensation.id,
              attemptSeq: 1,
              grantId: "compensation-crash-grant",
              toolId: "sandbox-file.write",
              parameterHash: createHash("sha256").update("sealed-private-token").digest("hex"),
              state: "dispatched" as const,
              dispatchedAt: compensationAt,
            },
            sealedCompensation: "sealed-private-token",
          };
        },
        async completeCompensation() {
          throw Object.assign(new Error("storage_unavailable"), {
            code: "storage_unavailable",
            status: 503,
          });
        },
        settleTool,
      },
      runtimeContext: mintInternalAgentRuntimeContext({
        runtimeId: "runtime-compensation-crash",
        agentId: original.agentId,
      }),
      provider: {
        id: original.providerId,
        async *stream() { yield* []; },
      },
      inputSource: { load: async (execution) => providerInput(execution) },
      tools: [{
        descriptor: {
          id: "sandbox-file.write",
          description: "sandbox",
          confirmationRequirement: "side_effect",
          parametersSchema: { type: "object" },
        },
        async execute() { throw new Error("unused"); },
        async compensate() {
          return {
            modelInput: { restored: true },
            closedSummary: "sandbox_compensation:restored",
          };
        },
      }],
    });
    await runtime.start();
    await runtime.whenIdle();
    expect(settleTool).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      dispatchId: "compensation-crash-dispatch",
      outcome: "outcome_unknown",
      closedSummary: "compensation_completion_unconfirmed",
    }));
    expect(settleTool).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: "failed",
    }));
  });

  it("leaves an ACK-lost compensation dispatch for restart recovery instead of failing the execution", async () => {
    const fixture = createAuthorityFixture();
    const queuedAt = "2023-11-14T22:13:30.000Z";
    const queued: AgentExecution = {
      id: "compensation-ack-lost", roomId: "room-compensation-ack-lost",
      sourceMessageId: "message-compensation-ack-lost", requesterId: HUMAN.principal.actorId,
      agentId: "agent-1", status: "queued", actionCategory: "model_generation",
      currentAttemptSeq: 1, retryCycle: 1, retryOrdinal: 1, providerId: "provider-1",
      modelId: "model-1", recoveryCursor: 0, queuedAt, updatedAt: queuedAt,
      compensatesExecutionId: "original-execution",
    };
    fixture.executions.set(queued.id, queued);
    const claimed: AgentExecution = { ...queued, status: "running", startedAt: queuedAt };
    let didClaim = false;
    const failExecution = vi.fn(fixture.authority.failExecution.bind(fixture.authority));
    const settleTool = vi.fn(fixture.authority.settleTool.bind(fixture.authority));
    const runtime = createAgentRuntime({
      authority: {
        ...fixture.authority,
        async claimNext() {
          if (didClaim) return undefined;
          didClaim = true;
          fixture.executions.set(claimed.id, claimed);
          return claimed;
        },
        async resumeCompensation() {
          // Represents a committed dispatch whose Worker response was lost.
          throw Object.assign(new Error("storage_unavailable"), { code: "storage_unavailable" });
        },
        failExecution,
        settleTool,
      },
      runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: "runtime-ack-lost", agentId: "agent-1" }),
      provider: { id: "provider-1", async *stream() { yield* []; } },
      inputSource: { load: async (execution) => providerInput(execution) },
    });
    await runtime.start();
    await runtime.whenIdle();
    expect(failExecution).not.toHaveBeenCalled();
    expect(settleTool).not.toHaveBeenCalled();
  });

  it.each(["session_revoked", "agent_missing_permission"] as const)(
    "terminalizes a compensation claim immediately when resume is denied with %s before dispatch",
    async (denialCode) => {
      const fixture = createAuthorityFixture();
      const queuedAt = "2023-11-14T22:13:30.000Z";
      const queued: AgentExecution = {
        id: `compensation-denied-${denialCode}`,
        roomId: `room-compensation-denied-${denialCode}`,
        sourceMessageId: `message-compensation-denied-${denialCode}`,
        requesterId: HUMAN.principal.actorId, agentId: "agent-1", status: "queued",
        actionCategory: "model_generation", currentAttemptSeq: 1, retryCycle: 1,
        retryOrdinal: 1, providerId: "provider-1", modelId: "model-1",
        recoveryCursor: 0, queuedAt, updatedAt: queuedAt,
        compensatesExecutionId: "original-execution",
      };
      fixture.executions.set(queued.id, queued);
      const claimed: AgentExecution = { ...queued, status: "running", startedAt: queuedAt };
      let didClaim = false;
      const failExecution = vi.fn(fixture.authority.failExecution.bind(fixture.authority));
      const runtime = createAgentRuntime({
        authority: {
          ...fixture.authority,
          async claimNext() {
            if (didClaim) return undefined;
            didClaim = true;
            fixture.executions.set(claimed.id, claimed);
            return claimed;
          },
          async resumeCompensation() {
            throw Object.assign(new Error(denialCode), { code: denialCode, status: 403 });
          },
          failExecution,
        },
        runtimeContext: mintInternalAgentRuntimeContext({
          runtimeId: `runtime-denied-${denialCode}`, agentId: "agent-1",
        }),
        provider: { id: "provider-1", async *stream() { yield* []; } },
        inputSource: { load: async (execution) => providerInput(execution) },
      });
      await runtime.start();
      await runtime.whenIdle();
      expect(failExecution).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        executionId: queued.id, attemptSeq: 1, errorCode: "tool_failure",
      }));
    },
  );

  it.each(["close", "interrupt"] as const)(
    "does not call a compensation adapter when %s wins while resume is in flight",
    async (mode) => {
      const fixture = createAuthorityFixture();
      const queuedAt = "2023-11-14T22:13:30.000Z";
      const queued: AgentExecution = {
        id: `compensation-${mode}-resume`, roomId: `room-compensation-${mode}`,
        sourceMessageId: `message-compensation-${mode}`, requesterId: HUMAN.principal.actorId,
        agentId: "agent-1", status: "queued", actionCategory: "model_generation",
        currentAttemptSeq: 1, retryCycle: 1, retryOrdinal: 1, providerId: "provider-1",
        modelId: "model-1", recoveryCursor: 0, queuedAt, updatedAt: queuedAt,
        compensatesExecutionId: "original-execution",
      };
      fixture.executions.set(queued.id, queued);
      const claimed: AgentExecution = { ...queued, status: "running", startedAt: queuedAt };
      const dispatched: AgentExecution = {
        ...claimed, actionCategory: "tool_call", toolDispatchPhase: "dispatched",
        currentToolId: "sandbox-file.write", recoveryCursor: 1,
      };
      const work = {
        execution: dispatched,
        dispatch: {
          id: `dispatch-${mode}`, executionId: queued.id, attemptSeq: 1,
          grantId: `grant-${mode}`, toolId: "sandbox-file.write",
          parameterHash: createHash("sha256").update("sealed-private-token").digest("hex"),
          state: "dispatched" as const, dispatchedAt: queuedAt,
        },
        sealedCompensation: "sealed-private-token",
      };
      const resumeEntered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<typeof work>();
      let didClaim = false;
      const compensate = vi.fn(async () => ({
        modelInput: { restored: true }, closedSummary: "compensated",
      }));
      const settleTool = vi.fn(fixture.authority.settleTool.bind(fixture.authority));
      const failExecution = vi.fn(fixture.authority.failExecution.bind(fixture.authority));
      const runtime = createAgentRuntime({
        authority: {
          ...fixture.authority,
          async claimNext() {
            if (didClaim) return undefined;
            didClaim = true;
            fixture.executions.set(claimed.id, claimed);
            return claimed;
          },
          async resumeCompensation() {
            resumeEntered.resolve();
            return resume.promise;
          },
          settleTool,
          failExecution,
        },
        runtimeContext: mintInternalAgentRuntimeContext({ runtimeId: `runtime-${mode}`, agentId: "agent-1" }),
        provider: { id: "provider-1", async *stream() { yield* []; } },
        inputSource: { load: async (execution) => providerInput(execution) },
        tools: [{
          descriptor: { id: "sandbox-file.write", description: "sandbox", confirmationRequirement: "side_effect", parametersSchema: { type: "object" } },
          async execute() { throw new Error("unused"); },
          compensate,
        }],
      });
      await runtime.start();
      await resumeEntered.promise;
      const close = mode === "close"
        ? runtime.close()
        : runtime.interrupt(HUMAN, queued.id, "stop").then(() => runtime.whenIdle());
      resume.resolve(work);
      await close;
      expect(compensate).not.toHaveBeenCalled();
      expect(failExecution).not.toHaveBeenCalled();
      expect(settleTool).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        dispatchId: `dispatch-${mode}`, outcome: "outcome_unknown",
        closedSummary: "runtime_closed_before_adapter",
      }));
    },
  );

  it("rejects non-positive scheduler bounds at construction", () => {
    const fixture = createAuthorityFixture();
    expect(() =>
      createAgentRuntime({
        authority: fixture.authority,
        runtimeContext: mintInternalAgentRuntimeContext({
          runtimeId: "runtime-invalid",
          agentId: "agent-1",
        }),
        provider: {
          id: "provider-1",
          async *stream() {
            yield* [];
          },
        },
        inputSource: { load: async (execution) => providerInput(execution) },
        limits: { maxActiveRooms: 0 },
      }),
    ).toThrow("maxActiveRooms must be a positive safe integer");
  });
});
