import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RouteInvocationIntent,
  RouteJob,
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

function fakeAuthority(
  jobs: readonly RouteJob[],
  claimFactory: (job: RouteJob) => RouteAuthorityClaim = claim,
) {
  const bySource = new Map(jobs.map((job) => [job.sourceMessageId, job]));
  const completed: { readonly job: RouteJob; readonly terminal?: string; readonly intents: readonly RouteInvocationIntent[] }[] = [];
  const failed: { readonly job: RouteJob; readonly code: string }[] = [];
  const authority: RouteAuthority = {
    async claim(sourceMessageId) {
      const job = bySource.get(sourceMessageId);
      if (job === undefined) throw new Error("missing job");
      return claimFactory(job);
    },
    async complete(job, _judgments, intents, terminalErrorCode) {
      const terminal = terminalErrorCode === undefined
        ? { ...job, status: "completed" as const, completedAt: new Date().toISOString() }
        : { ...job, status: "failed" as const, terminalErrorCode, completedAt: new Date().toISOString() };
      completed.push({ job: terminal, ...(terminalErrorCode === undefined ? {} : { terminal: terminalErrorCode }), intents });
      bySource.delete(job.sourceMessageId);
      return { job: terminal, intents };
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
  };
  return { authority, completed, failed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded single-route runtime", () => {
  it.each(["catching_up", "noauth", "degraded", "failed"] as const)(
    "claims then gates %s semantic routing with zero Provider/retry calls",
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
      const invoked: RouteInvocationIntent[] = [];
      const runtime = createRouteRuntimeService({
        authority: fixture.authority,
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
        invoke: async (_routeJobId, intent) => { invoked.push(intent); },
      });

      expect(runtime.notify(base.roomId, base.sourceMessageId)).toBe(true);
      await runtime.whenIdle();

      expect(order).toEqual(["claim", `memory:${base.roomId}`]);
      expect(providerCalls).toBe(0);
      expect(fixture.failed).toEqual([]);
      expect(fixture.completed).toHaveLength(1);
      expect(fixture.completed[0]?.terminal).toBeUndefined();
      expect(invoked.map((intent) => intent.reasonCode))
        .toEqual(["direct_mention", "structured_help"]);
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
      invoke: async () => undefined,
    });

    runtime.notify(base.roomId, base.sourceMessageId);
    await runtime.whenIdle();

    expect(order).toEqual(["claim", `memory:${base.roomId}`, "provider"]);
    expect(fixture.failed).toEqual([]);
    expect(fixture.completed).toHaveLength(1);
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
      memoryReadiness: { async read() { throw diagnostic; } },
      provider: {
        async decide() {
          providerCalls += 1;
          return { candidates: [] };
        },
      },
      invoke: async () => undefined,
      onError: (error) => { errors.push(error); },
    });

    runtime.notify(base.roomId, base.sourceMessageId);
    await runtime.whenIdle();

    expect(providerCalls).toBe(0);
    expect(fixture.failed).toEqual([]);
    expect(fixture.completed).toHaveLength(1);
    expect(fixture.completed[0]?.terminal).toBeUndefined();
    expect(errors).toEqual([diagnostic]);
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
    const invoked: RouteInvocationIntent[] = [];
    let providerCalls = 0;
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      memoryReadiness: { async read() { return readiness("noauth"); } },
      provider: {
        async decide() {
          providerCalls += 1;
          return { candidates: [] };
        },
      },
      invoke: async (_routeJobId, intent) => { invoked.push(intent); },
    });

    runtime.notify(base.roomId, base.sourceMessageId);
    await runtime.whenIdle();

    expect(providerCalls).toBe(0);
    expect(invoked.map((intent) => intent.reasonCode))
      .toEqual(["direct_mention", "ball_due"]);
    expect(fixture.failed).toEqual([]);
    await runtime.close();
  });

  it("passes only the closed summary input and invokes merged mandatory/provider intents once", async () => {
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
    const invoked: RouteInvocationIntent[] = [];
    const runtime = createRouteRuntimeService({
      authority: fixture.authority,
      memoryReadiness: healthyMemoryReadiness,
      provider,
      invoke: async (_routeJobId, intent) => { invoked.push(intent); },
    });

    expect(runtime.notify("room-1", "message-1")).toBe(true);
    await runtime.whenIdle();

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty("visibleConversation");
    expect(inputs[0]).not.toHaveProperty("secret");
    expect(invoked.map((intent) => intent.targetAgentId)).toEqual(["agent-direct", "agent-active"]);
    expect(fixture.completed).toHaveLength(1);
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
      memoryReadiness: healthyMemoryReadiness,
      provider,
      invoke: async () => undefined,
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
      memoryReadiness: healthyMemoryReadiness,
      provider: { async decide() { calls += 1; return { candidates: [], extra: true } as never; } },
      invoke: async () => undefined,
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
    expect(fixture.completed[0]?.intents.map((intent) => intent.targetAgentId)).toEqual(["agent-direct"]);
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
      invoke: async () => undefined,
    });

    runtime.notify(`room-${mode}`, `message-${mode}`);
    await vi.runAllTimersAsync();
    await runtime.whenIdle();

    expect(calls).toBe(3);
    expect(fixture.completed[0]).toMatchObject({ terminal: code });
    expect(fixture.completed[0]?.intents.map((intent) => intent.targetAgentId))
      .toEqual(["agent-direct"]);
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
      memoryReadiness: healthyMemoryReadiness,
      provider: { async decide() { return { candidates: [] }; } },
      invoke: async () => undefined,
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
      memoryReadiness: healthyMemoryReadiness,
      provider: { async decide() { calls += 1; return { candidates: [] }; } },
      invoke: async () => undefined,
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
