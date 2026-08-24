import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RouteInvocationIntent,
  RouteJob,
  RouteJudgment,
  RouterPlan,
  RouterProviderInput,
} from "@native-im/core";
import type {
  RouteAuthority,
  RouteAuthorityClaim,
  RouterProvider,
} from "./contracts.js";
import { RouteRuntimeError } from "./contracts.js";
import { createRouteRuntimeService } from "./route-runtime-service.js";
import type { MemoryRuntimeReadiness } from "../room-memory/runtime-readiness.js";

function routeJob(sourceMessageId: string, roomId: string, attempt: 1 | 2 | 3 = 1): RouteJob {
  return {
    id: `route-${sourceMessageId}`,
    roomId,
    sourceMessageId,
    status: "queued",
    currentAttempt: attempt,
    topicKey: "topic-v1:test",
    embeddingModelVersion: "dao-topic-embedding-v1",
    windowSize: 8,
    cosineThreshold: 0.82,
    roomPhase: "discussion",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

function claim(job: RouteJob): RouteAuthorityClaim {
  return {
    job: { ...job, status: "running" },
    providerInput: {
      purpose: "route_decision",
      roomId: job.roomId,
      sourceMessageId: job.sourceMessageId,
      message: { authorId: "human-1", authorKind: "human", summary: "migration risk" },
      roomPhase: "discussion",
      agents: [
        { agentId: "agent-direct", participation: "on-mention", role: "agent", capabilities: [], calibrationScore: 0, hasBall: false },
        { agentId: "agent-active", participation: "active", role: "agent", capabilities: ["review.read"], calibrationScore: 0, hasBall: false },
      ],
      topic: {
        topicKey: job.topicKey,
        embeddingModelVersion: "dao-topic-embedding-v1",
        windowSize: 8,
        cosineThreshold: 0.82,
      },
      limits: { timeoutMs: 1_000, maxCandidates: 2, maxOutputBytes: 65_536 },
    },
    decisionContext: {
      directMentionAgentIds: ["agent-direct"],
      structuredHelpAgentIds: [],
      recentHumanMessageTimes: [],
      consecutiveAgentRounds: 0,
      cooldownByAgentId: [],
    },
  };
}

function readiness(status: MemoryRuntimeReadiness["status"]): MemoryRuntimeReadiness {
  return {
    status,
    memoryWatermark: status === "healthy" ? 12 : 10,
    corpusHead: 12,
    rawDeltaComplete: status !== "failed",
    injectableSnapshotReadable: status !== "failed",
  };
}

const healthyMemoryReadiness = Object.freeze({
  async read(): Promise<MemoryRuntimeReadiness> {
    return readiness("healthy");
  },
});

const healthyProjectFacts = Object.freeze({
  async read() {
    return { status: "ready", goalRevision: 3, projectRevision: 5 } as const;
  },
});

function fakeAuthority(
  jobs: readonly RouteJob[],
  claimFactory: (job: RouteJob) => RouteAuthorityClaim = claim,
) {
  const bySource = new Map(jobs.map((job) => [job.sourceMessageId, job]));
  const completed: {
    readonly job: RouteJob;
    readonly terminal?: string;
    readonly intents: readonly RouteInvocationIntent[];
    readonly judgments: readonly RouteJudgment[];
  }[] = [];
  const failed: { readonly job: RouteJob; readonly code: string }[] = [];
  const authority: RouteAuthority = {
    async claim(sourceMessageId) {
      const job = bySource.get(sourceMessageId);
      if (job === undefined) throw new Error("missing job");
      return claimFactory(job);
    },
    async complete(job, judgments, intents, _agentProviderReady, terminalErrorCode) {
      const terminal = terminalErrorCode === undefined
        ? { ...job, status: "completed" as const, completedAt: new Date().toISOString() }
        : { ...job, status: "failed" as const, terminalErrorCode, completedAt: new Date().toISOString() };
      completed.push({
        job: terminal,
        ...(terminalErrorCode === undefined ? {} : { terminal: terminalErrorCode }),
        intents,
        judgments,
      });
      bySource.delete(job.sourceMessageId);
      return { job: terminal, intents, handoffs: [] };
    },
    async fail(job, errorCode) {
      failed.push({ job, code: errorCode });
      const retryAfterMs = job.currentAttempt === 1 ? 250 : 1_000;
      const next = { ...job, status: "queued" as const, currentAttempt: (job.currentAttempt + 1) as 2 | 3 };
      bySource.set(job.sourceMessageId, next);
      return { job: next, retryAfterMs };
    },
    async recover() {
      return [...bySource.values()];
    },
    async claimHandoff() {
      throw new Error("no handoff fixture");
    },
    async recoverHandoffs() {
      return [];
    },
  };
  return { authority, completed, failed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded single-route runtime", () => {
  it.each(["catching_up", "noauth", "degraded", "failed"] as const)(
    "does not cascade an Agent-authored final while memory is %s",
    async (status) => {
      const order: string[] = [];
      const base = routeJob(`message-${status}`, `room-${status}`);
      const fixture = fakeAuthority([base], (job) => {
        order.push("claim");
        const claimed = claim(job);
        return {
          ...claimed,
          providerInput: {
            ...claimed.providerInput,
            message: { ...claimed.providerInput.message, authorKind: "agent" as const },
          },
          decisionContext: {
            ...claimed.decisionContext,
            structuredHelpAgentIds: ["agent-active"],
          },
        };
      });
      let providerCalls = 0;
      const runtime = createRouteRuntimeService({
        authority: fixture.authority,
        projectFacts: healthyProjectFacts,
        memoryReadiness: {
          async read(roomId) {
            order.push(`memory:${roomId}`);
            return readiness(status);
          },
        },
        provider: {
          async decide() {
            providerCalls += 1;
            order.push("provider");
            return { candidates: [] };
          },
        },
      });

      expect(runtime.notify(base.roomId, base.sourceMessageId)).toBe(true);
      await runtime.whenIdle();

      expect(order).toEqual(["claim"]);
      expect(providerCalls).toBe(0);
      expect(fixture.failed).toEqual([]);
      expect(fixture.completed).toHaveLength(1);
      expect(fixture.completed[0]?.terminal).toBeUndefined();
      expect(fixture.completed[0]?.intents).toEqual([]);
      expect(fixture.completed[0]?.judgments).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: "suppressed", reasonCode: "not_selected" }),
      ]));
      await runtime.close();
    },
  );

  it("calls the Provider after claim only when semantic memory readiness is healthy", async () => {
    const order: string[] = [];
    const base = routeJob("message-healthy", "room-healthy");
    const fixture = fakeAuthority([base], (job) => {
      order.push("claim");
      return claim(job);
    });
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: {
        async read(roomId) {
          order.push(`memory:${roomId}`);
          return readiness("healthy");
        },
      },
      provider: {
        async decide() {
          order.push("provider");
          return { candidates: [] };
        },
      },
    });

    runtime.notify(base.roomId, base.sourceMessageId);
    await runtime.whenIdle();

    expect(order).toEqual(["claim", `memory:${base.roomId}`, "provider"]);
    expect(fixture.failed).toEqual([]);
    expect(fixture.completed).toHaveLength(1);
    await runtime.close();
  });

  it("suppresses proactive routing before Provider when project facts are unavailable", async () => {
    const base = routeJob("message-project-unavailable", "room-project-unavailable");
    const fixture = fakeAuthority([base]);
    const provider = { decide: vi.fn(async () => ({ candidates: [] })) };
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      memoryReadiness: healthyMemoryReadiness,
      projectFacts: {
        async read() {
          return { status: "dependency_unavailable" as const };
        },
      },
      provider,
    });

    runtime.notify(base.roomId, base.sourceMessageId);
    await runtime.whenIdle();

    expect(provider.decide).not.toHaveBeenCalled();
    expect(fixture.completed).toHaveLength(1);
    expect(fixture.completed[0]?.intents).toEqual([]);
    expect(fixture.completed[0]?.judgments).toEqual([
      expect.objectContaining({
        agentId: "agent-direct",
        outcome: "suppressed",
        reasonCode: "not_selected",
        reasonText: "dependency_unavailable: FT-09 project facts are not installed",
      }),
      expect.objectContaining({
        agentId: "agent-active",
        outcome: "suppressed",
        reasonCode: "not_selected",
        reasonText: "dependency_unavailable: FT-09 project facts are not installed",
      }),
    ]);
    await runtime.close();
  });

  it("fails a broken readiness seam closed without manufacturing Provider failure", async () => {
    const base = routeJob("message-readiness-error", "room-readiness-error");
    const fixture = fakeAuthority([base]);
    const diagnostic = new Error("readiness unavailable");
    const errors: unknown[] = [];
    let providerCalls = 0;
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: { async read() { throw diagnostic; } },
      provider: {
        async decide() {
          providerCalls += 1;
          return { candidates: [] };
        },
      },
      onError: (error) => { errors.push(error); },
    });

    runtime.notify(base.roomId, base.sourceMessageId);
    await runtime.whenIdle();

    expect(providerCalls).toBe(0);
    expect(fixture.failed).toEqual([]);
    expect(fixture.completed).toHaveLength(1);
    expect(fixture.completed[0]?.terminal).toBeUndefined();
    expect(fixture.completed[0]?.intents).toEqual([]);
    expect(fixture.completed[0]?.judgments.every((entry) => entry.outcome === "suppressed"))
      .toBe(true);
    expect(errors).toEqual([diagnostic]);
    await runtime.close();
  });

  it("rejects an unversioned project-facts readiness result before Provider", async () => {
    const base = routeJob("message-project-version", "room-project-version");
    const fixture = fakeAuthority([base]);
    const provider = { decide: vi.fn(async () => ({ candidates: [] })) };
    const errors: unknown[] = [];
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: {
        async read() {
          return { status: "ready", goalRevision: 0, projectRevision: 0 };
        },
      },
      memoryReadiness: healthyMemoryReadiness,
      provider,
      onError(error) { errors.push(error); },
    });

    runtime.notify(base.roomId, base.sourceMessageId);
    await runtime.whenIdle();

    expect(provider.decide).not.toHaveBeenCalled();
    expect(errors).toEqual([
      expect.objectContaining({ message: "Proactive route project fact revisions were invalid" }),
    ]);
    expect(fixture.completed[0]?.intents).toEqual([]);
    expect(fixture.completed[0]?.judgments.every((entry) =>
      entry.outcome === "suppressed" && entry.reasonCode === "not_selected")).toBe(true);
    await runtime.close();
  });

  it("does not let the semantic gate suppress an existing deterministic Ball intent", async () => {
    const base = routeJob("message-ball", "room-ball");
    const fixture = fakeAuthority([base], (job) => {
      const claimed = claim(job);
      return {
        ...claimed,
        providerInput: {
          ...claimed.providerInput,
          agents: claimed.providerInput.agents.map((agent) =>
            agent.agentId === "agent-active" ? { ...agent, hasBall: true } : agent),
        },
      };
    });
    let providerCalls = 0;
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: { async read() { return readiness("noauth"); } },
      provider: {
        async decide() {
          providerCalls += 1;
          return { candidates: [] };
        },
      },
    });

    runtime.notify(base.roomId, base.sourceMessageId);
    await runtime.whenIdle();

    expect(providerCalls).toBe(0);
    expect(fixture.completed[0]?.intents.map((intent) => intent.reasonCode))
      .toEqual(["ball_due"]);
    expect(fixture.failed).toEqual([]);
    await runtime.close();
  });

  it("passes only the closed summary input and durably completes merged intents once", async () => {
    const fixture = fakeAuthority([routeJob("message-1", "room-1")]);
    const inputs: RouterProviderInput[] = [];
    const provider: RouterProvider = {
      async decide(input) {
        inputs.push(input);
        return { candidates: [{
          agentId: "agent-active", trigger: "risk", order: 1,
          reasonCode: "risk_detected", reasonText: "migration is risky",
        }] };
      },
    };
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: healthyMemoryReadiness,
      provider,
    });

    expect(runtime.notify("room-1", "message-1")).toBe(true);
    await runtime.whenIdle();

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty("visibleConversation");
    expect(inputs[0]).not.toHaveProperty("secret");
    expect(fixture.completed[0]?.intents.map((intent) => intent.targetAgentId))
      .toEqual(["agent-active"]);
    expect(fixture.completed).toHaveLength(1);
    await runtime.close();
  });

  it("leaves completed intents durable without a best-effort execution callback", async () => {
    const fixture = fakeAuthority([routeJob("message-durable", "room-durable")]);
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: healthyMemoryReadiness,
      provider: { async decide() { return { candidates: [{
        agentId: "agent-active", trigger: "domain", order: 1,
        reasonCode: "domain_match", reasonText: "responsibility match",
      }] }; } },
    });

    runtime.notify("room-durable", "message-durable");
    await runtime.whenIdle();

    expect(fixture.completed[0]?.intents).toHaveLength(1);
    await runtime.close();
  });

  it("serializes FIFO within a room while running different rooms concurrently", async () => {
    const fixture = fakeAuthority([
      routeJob("a-1", "room-a"), routeJob("a-2", "room-a"), routeJob("b-1", "room-b"),
    ]);
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const provider: RouterProvider = {
      decide(input): Promise<RouterPlan> {
        started.push(input.sourceMessageId);
        return new Promise((resolve) => {
          releases.set(input.sourceMessageId, () => resolve({ candidates: [] }));
        });
      },
    };
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: healthyMemoryReadiness,
      provider,
      maxActiveRooms: 8,
    });
    runtime.notify("room-a", "a-1");
    runtime.notify("room-a", "a-2");
    runtime.notify("room-b", "b-1");
    await vi.waitFor(() => expect(started).toEqual(["a-1", "b-1"]));
    releases.get("a-1")?.();
    await vi.waitFor(() => expect(started).toEqual(["a-1", "b-1", "a-2"]));
    releases.get("a-2")?.();
    releases.get("b-1")?.();
    await runtime.whenIdle();
    await runtime.close();
  });

  it("retries malformed output at 250ms and 1s, then closes failure without losing mandatory intent", async () => {
    vi.useFakeTimers();
    const fixture = fakeAuthority([routeJob("message-fail", "room-fail")]);
    let calls = 0;
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: healthyMemoryReadiness,
      provider: { async decide() { calls += 1; return { candidates: [], extra: true } as never; } },
    });
    runtime.notify("room-fail", "message-fail");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(3);
    await runtime.whenIdle();
    expect(fixture.completed[0]).toMatchObject({ terminal: "provider_malformed" });
    expect(fixture.completed[0]?.intents).toEqual([]);
    await runtime.close();
  });

  it.each([
    ["provider_timeout", "timeout"],
    ["provider_cancelled", "cancelled"],
  ] as const)("closes %s after three attempts and preserves mandatory intent", async (code, mode) => {
    vi.useFakeTimers();
    const fixture = fakeAuthority([routeJob(`message-${mode}`, `room-${mode}`)]);
    let calls = 0;
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: healthyMemoryReadiness,
      provider: {
        async decide(_input, signal) {
          calls += 1;
          if (mode === "cancelled") throw new RouteRuntimeError(code, "closed cancellation");
          return await new Promise<RouterPlan>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
    });

    runtime.notify(`room-${mode}`, `message-${mode}`);
    await vi.runAllTimersAsync();
    await runtime.whenIdle();

    expect(calls).toBe(3);
    expect(fixture.completed[0]).toMatchObject({ terminal: code });
    expect(fixture.completed[0]?.intents.map((intent) => intent.targetAgentId))
      .toEqual([]);
    await runtime.close();
  });

  it("rescans durable recovery work after the bounded per-room queue drains", async () => {
    const fixture = fakeAuthority(Array.from({ length: 5 }, (_, index) =>
      routeJob(`message-${index + 1}`, "room-recovery")));
    let recoverCalls = 0;
    const authority: RouteAuthority = {
      ...fixture.authority,
      async recover() {
        recoverCalls += 1;
        return fixture.authority.recover();
      },
    };
    const runtime = createRouteRuntimeService({
      authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: healthyMemoryReadiness,
      provider: { async decide() { return { candidates: [] }; } },
      maxQueuedPerRoom: 2,
    });

    await runtime.recover();
    await runtime.whenIdle();

    expect(fixture.completed).toHaveLength(5);
    expect(recoverCalls).toBeGreaterThanOrEqual(3);
    await runtime.close();
  });

  it("reinstalls a future durable retry timer after process recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
    const recovered = {
      ...routeJob("message-recovered-retry", "room-recovered-retry", 2),
      nextRetryAt: "2026-08-17T00:00:00.250Z",
    };
    const fixture = fakeAuthority([recovered]);
    let calls = 0;
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      projectFacts: healthyProjectFacts,
      memoryReadiness: healthyMemoryReadiness,
      provider: { async decide() { calls += 1; return { candidates: [] }; } },
    });

    await runtime.recover();
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await runtime.whenIdle();

    expect(calls).toBe(1);
    expect(fixture.completed).toHaveLength(1);
    await runtime.close();
  });
});
