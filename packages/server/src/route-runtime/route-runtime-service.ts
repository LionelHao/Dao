import {
  isRouterPlan,
  type RouterPlan,
} from "@native-im/core";
import type { RouteProviderFailureCode } from "./route-authority-protocol.js";
import {
  evaluateMemoryRuntimeGate,
  type MemoryRuntimeReadiness,
} from "../room-memory/runtime-readiness.js";
import {
  RouteRuntimeError,
  type RouteAuthority,
  type RouterProvider,
} from "./contracts.js";
import { evaluateRoutePlan } from "./route-decision.js";

interface QueuedRoute {
  readonly roomId: string;
  readonly sourceMessageId: string;
}

export interface RouteRuntimeService {
  notify(roomId: string, sourceMessageId: string): boolean;
  recover(): Promise<void>;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

export interface RouteMemoryReadinessPort {
  read(roomId: string): Promise<MemoryRuntimeReadiness>;
}

export type ProactiveRouteProjectFactsReadiness =
  | { readonly status: "dependency_unavailable" }
  | {
      readonly status: "ready";
      readonly goalRevision: number;
      readonly projectRevision: number;
    };

export interface ProactiveRouteProjectFactsPort {
  read(roomId: string): Promise<ProactiveRouteProjectFactsReadiness>;
}

export interface CreateRouteRuntimeServiceOptions {
  readonly authority: RouteAuthority;
  readonly memoryReadiness: RouteMemoryReadinessPort;
  readonly projectFacts: ProactiveRouteProjectFactsPort;
  readonly provider: RouterProvider;
  readonly maxActiveRooms?: number;
  readonly maxQueuedPerRoom?: number;
  readonly onError?: (error: unknown) => void;
}

function providerFailureCode(error: unknown, timedOut: boolean): RouteProviderFailureCode {
  if (timedOut) return "provider_timeout";
  if (error instanceof RouteRuntimeError &&
      (error.code === "provider_timeout" || error.code === "provider_cancelled" ||
        error.code === "provider_malformed" || error.code === "provider_failure")) {
    return error.code;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "provider_timeout" || code === "provider_cancelled" ||
        code === "provider_malformed" || code === "provider_failure") return code;
  }
  return "provider_failure";
}

function planMatchesClosedInput(
  plan: unknown,
  agentIds: ReadonlySet<string>,
  limit: number,
  sourceAuthorKind: "human" | "agent",
): plan is RouterPlan {
  if (!isRouterPlan(plan) || plan.candidates.length > limit) return false;
  return plan.candidates.every((candidate) => {
    if (!agentIds.has(candidate.agentId)) return false;
    if (candidate.trigger === "domain") return candidate.reasonCode === "domain_match";
    if (candidate.trigger === "risk") return candidate.reasonCode === "risk_detected";
    if (candidate.trigger === "structured_mention") {
      return sourceAuthorKind === "agent" && candidate.reasonCode === "structured_help";
    }
    return candidate.reasonCode === "ball_due";
  });
}

export function createRouteRuntimeService(
  options: CreateRouteRuntimeServiceOptions,
): RouteRuntimeService {
  const maxActiveRooms = options.maxActiveRooms ?? 8;
  const maxQueuedPerRoom = options.maxQueuedPerRoom ?? 32;
  if (!Number.isSafeInteger(maxActiveRooms) || maxActiveRooms < 1 || maxActiveRooms > 8 ||
      !Number.isSafeInteger(maxQueuedPerRoom) || maxQueuedPerRoom < 1 || maxQueuedPerRoom > 32) {
    throw new TypeError("Route runtime bounds were invalid");
  }
  const queues = new Map<string, QueuedRoute[]>();
  const knownSourceIds = new Set<string>();
  const deferredSourceIds = new Set<string>();
  const activeRooms = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const idleWaiters = new Set<() => void>();
  let closed = false;
  let recoveryNeeded = false;
  let recoveryTask: Promise<void> | undefined;

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot alter durable route state.
    }
  };

  const workIsIdle = (): boolean => activeRooms.size === 0 && retryTimers.size === 0 &&
    [...queues.values()].every((queue) => queue.length === 0);
  const isIdle = (): boolean => workIsIdle() && recoveryTask === undefined && !recoveryNeeded;

  const settleIdle = (): void => {
    maybeRecover();
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const enqueue = (entry: QueuedRoute): boolean => {
    if (closed) return false;
    if (knownSourceIds.has(entry.sourceMessageId) || deferredSourceIds.has(entry.sourceMessageId)) {
      return true;
    }
    const queue = queues.get(entry.roomId) ?? [];
    if (queue.length >= maxQueuedPerRoom) {
      recoveryNeeded = true;
      return false;
    }
    queue.push(entry);
    queues.set(entry.roomId, queue);
    knownSourceIds.add(entry.sourceMessageId);
    return true;
  };

  const scheduleRetry = (entry: QueuedRoute, retryAfterMs: number): void => {
    if (closed) return;
    deferredSourceIds.add(entry.sourceMessageId);
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      deferredSourceIds.delete(entry.sourceMessageId);
      if (!closed) {
        enqueue(entry);
        pump();
      }
      settleIdle();
    }, retryAfterMs);
    retryTimers.add(timer);
  };

  const scheduleRecoveredRetry = (entry: QueuedRoute, nextRetryAt: string): void => {
    if (closed) return;
    const readyAt = Date.parse(nextRetryAt);
    if (!Number.isFinite(readyAt) || readyAt <= Date.now()) {
      enqueue(entry);
      return;
    }
    deferredSourceIds.add(entry.sourceMessageId);
    const delay = Math.min(readyAt - Date.now(), 1_000);
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      deferredSourceIds.delete(entry.sourceMessageId);
      if (!closed) {
        scheduleRecoveredRetry(entry, nextRetryAt);
        pump();
      }
      settleIdle();
    }, delay);
    retryTimers.add(timer);
  };

  const process = async (entry: QueuedRoute): Promise<void> => {
    const claimed = await options.authority.claim(entry.sourceMessageId);
    const { job, providerInput, decisionContext } = claimed;
    let plan: RouterPlan | undefined;
    let failure: RouteProviderFailureCode | undefined;
    let projectFactsAvailable = false;
    let semanticProviderAllowed = false;
    let routeGateFailed = false;
    if (providerInput.message.authorKind === "human") {
      try {
        const projectFacts = await options.projectFacts.read(job.roomId);
        if (projectFacts.status === "ready" &&
            (!Number.isSafeInteger(projectFacts.goalRevision) || projectFacts.goalRevision < 1 ||
             !Number.isSafeInteger(projectFacts.projectRevision) || projectFacts.projectRevision < 1)) {
          throw new TypeError("Proactive route project fact revisions were invalid");
        }
        projectFactsAvailable = projectFacts.status === "ready";
        if (projectFactsAvailable) {
          const memory = await options.memoryReadiness.read(job.roomId);
          semanticProviderAllowed = evaluateMemoryRuntimeGate({
            kind: "semantic_proactive",
            memory,
          }).allowed;
        }
      } catch (error: unknown) {
        routeGateFailed = true;
        report(error);
      }
    }
    if (closed) return;
    if (semanticProviderAllowed) {
      const controller = new AbortController();
      controllers.set(entry.roomId, controller);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("route provider timeout"));
        }, providerInput.limits.timeoutMs);
        const candidatePlan = await options.provider.decide(providerInput, controller.signal);
        const agentIds = new Set(providerInput.agents.map((agent) => agent.agentId));
        if (!planMatchesClosedInput(
          candidatePlan,
          agentIds,
          providerInput.limits.maxCandidates,
          providerInput.message.authorKind,
        )) {
          failure = "provider_malformed";
        } else {
          plan = candidatePlan;
        }
      } catch (error: unknown) {
        failure = providerFailureCode(error, timedOut);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        controllers.delete(entry.roomId);
      }
    }
    if (closed) return;
    if (failure !== undefined && job.currentAttempt < 3) {
      const failed = await options.authority.fail(job, failure);
      if (failed.retryAfterMs === undefined) {
        throw new RouteRuntimeError("provider_failure", "Route retry did not provide a bounded delay");
      }
      knownSourceIds.delete(entry.sourceMessageId);
      scheduleRetry(entry, failed.retryAfterMs);
      return;
    }
    const evaluated = evaluateRoutePlan({
      routeJobId: job.id,
      roomId: job.roomId,
      sourceMessageId: job.sourceMessageId,
      sourceAuthorKind: providerInput.message.authorKind,
      routeAttempt: job.currentAttempt,
      now: Date.now(),
      roomPhase: providerInput.roomPhase,
      topicKey: providerInput.topic.topicKey,
      agents: providerInput.agents.map((agent) => ({
        agentId: agent.agentId,
        participation: agent.participation,
        calibrationScore: agent.calibrationScore,
        hasBall: projectFactsAvailable && providerInput.message.authorKind === "human"
          ? agent.hasBall
          : false,
      })),
      directMentionAgentIds: providerInput.message.authorKind === "human"
        ? decisionContext.directMentionAgentIds
        : [],
      structuredHelpAgentIds: [],
      recentHumanMessageTimes: decisionContext.recentHumanMessageTimes,
      consecutiveAgentRounds: decisionContext.consecutiveAgentRounds,
      cooldownByAgentId: new Map(decisionContext.cooldownByAgentId.map((entry) => [
        entry.agentId,
        entry.lastRespondedAt,
      ])),
      ...(plan === undefined ? {} : { providerPlan: plan }),
      ...(failure === undefined ? {} : { providerFailureCode: failure }),
    });
    const suppressionReason = providerInput.message.authorKind === "agent"
      ? "agent_authored_source: Agent final messages cannot cascade"
      : routeGateFailed || !projectFactsAvailable
        ? "dependency_unavailable: FT-09 project facts are not installed"
        : undefined;
    const result = suppressionReason === undefined
      ? evaluated
      : {
          intents: [],
          judgments: evaluated.judgments.map((judgment) => ({
            ...judgment,
            outcome: "suppressed" as const,
            reasonCode: "not_selected" as const,
            reasonText: suppressionReason,
          })),
        };
    await options.authority.complete(
      job,
      result.judgments,
      result.intents,
      failure,
    );
  };

  function pump(): void {
    if (closed) return;
    while (activeRooms.size < maxActiveRooms) {
      const nextRoom = [...queues.entries()].find(([roomId, queue]) =>
        queue.length > 0 && !activeRooms.has(roomId));
      if (nextRoom === undefined) break;
      const [roomId, queue] = nextRoom;
      const entry = queue.shift();
      if (entry === undefined) continue;
      activeRooms.add(roomId);
      const task = process(entry).catch(report).finally(() => {
        knownSourceIds.delete(entry.sourceMessageId);
        activeRooms.delete(roomId);
        tasks.delete(task);
        pump();
        settleIdle();
      });
      tasks.add(task);
    }
    settleIdle();
  }

  function maybeRecover(): void {
    if (closed || !recoveryNeeded || recoveryTask !== undefined || !workIsIdle()) return;
    recoveryNeeded = false;
    const task = options.authority.recover()
      .then((jobs) => {
        for (const job of jobs) {
          const entry = { roomId: job.roomId, sourceMessageId: job.sourceMessageId };
          if (job.nextRetryAt === undefined) enqueue(entry);
          else scheduleRecoveredRetry(entry, job.nextRetryAt);
        }
        pump();
      })
      .catch(report)
      .finally(() => {
        if (recoveryTask === task) recoveryTask = undefined;
        pump();
        settleIdle();
      });
    recoveryTask = task;
  }

  const service: RouteRuntimeService = {
    notify(roomId, sourceMessageId) {
      if (roomId.trim().length === 0 || sourceMessageId.trim().length === 0) return false;
      const accepted = enqueue({ roomId, sourceMessageId });
      if (accepted) pump();
      return accepted;
    },
    async recover() {
      recoveryNeeded = true;
      maybeRecover();
      await recoveryTask;
    },
    whenIdle() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      for (const controller of controllers.values()) controller.abort(new Error("route runtime closed"));
      for (const queue of queues.values()) queue.length = 0;
      recoveryNeeded = false;
      knownSourceIds.clear();
      deferredSourceIds.clear();
      await Promise.allSettled([
        ...tasks,
        ...(recoveryTask === undefined ? [] : [recoveryTask]),
      ]);
      settleIdle();
    },
  };
  return Object.freeze(service);
}
