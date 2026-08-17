import {
  isRouteJob,
  isRouterProviderInput,
  type RouteInvocationIntent,
  type RouteJudgment,
} from "@native-im/core";
import {
  AuthorityWorkerClientError,
  type WorkerDatabaseClient,
} from "../persistence/worker-database-client.js";
import type {
  RouteAuthorityOperation,
  RouteAuthorityOperationResult,
  RouteClaimDecisionContext,
  RouteProviderFailureCode,
} from "./route-authority-protocol.js";
import {
  RouteRuntimeError,
  type RouteAuthority,
  type RouteAuthorityClaim,
} from "./contracts.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mappedError(error: unknown): RouteRuntimeError {
  if (error instanceof RouteRuntimeError) return error;
  if (error instanceof AuthorityWorkerClientError &&
      (error.code === "route_conflict" || error.code === "route_job_not_found")) {
    return new RouteRuntimeError(error.code, `Authority route operation failed (${error.code})`);
  }
  return new RouteRuntimeError("provider_failure", "Authority route operation failed");
}

function invocationIntent(value: unknown): value is RouteInvocationIntent {
  return record(value) &&
    (value.kind === "direct_mention" || value.kind === "structured_help" || value.kind === "routed_candidate") &&
    typeof value.roomId === "string" && typeof value.sourceMessageId === "string" &&
    typeof value.targetAgentId === "string" && typeof value.reasonText === "string" &&
    (value.reasonCode === "direct_mention" || value.reasonCode === "structured_help" ||
      value.reasonCode === "domain_match" || value.reasonCode === "risk_detected" || value.reasonCode === "ball_due") &&
    (value.priority === 1 || value.priority === 2 || value.priority === 3);
}

function decisionContext(value: unknown): value is RouteClaimDecisionContext {
  return record(value) && Array.isArray(value.directMentionAgentIds) &&
    value.directMentionAgentIds.every((entry) => typeof entry === "string") &&
    Array.isArray(value.structuredHelpAgentIds) &&
    value.structuredHelpAgentIds.every((entry) => typeof entry === "string") &&
    Array.isArray(value.recentHumanMessageTimes) &&
    value.recentHumanMessageTimes.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry)) &&
    typeof value.consecutiveAgentRounds === "number" && Number.isSafeInteger(value.consecutiveAgentRounds) &&
    value.consecutiveAgentRounds >= 0 && Array.isArray(value.cooldownByAgentId) &&
    value.cooldownByAgentId.every((entry) => record(entry) && typeof entry.agentId === "string" &&
      typeof entry.lastRespondedAt === "number" && Number.isSafeInteger(entry.lastRespondedAt));
}

function claimResult(value: unknown): RouteAuthorityClaim {
  if (!record(value) || value.kind !== "route-claimed" || !isRouteJob(value.job) ||
      !isRouterProviderInput(value.providerInput) || !decisionContext(value.decisionContext)) {
    throw new RouteRuntimeError("provider_failure", "Authority route claim result was malformed");
  }
  return {
    job: value.job,
    providerInput: value.providerInput,
    decisionContext: value.decisionContext,
  };
}

export function createWorkerRouteAuthority(worker: WorkerDatabaseClient): RouteAuthority {
  const execute = async (operation: RouteAuthorityOperation): Promise<RouteAuthorityOperationResult> => {
    try {
      return await worker.executeRoute(operation) as RouteAuthorityOperationResult;
    } catch (error: unknown) {
      throw mappedError(error);
    }
  };
  const authority: RouteAuthority = {
    async claim(sourceMessageId) {
      return claimResult(await execute({ type: "route.claim", sourceMessageId, now: Date.now() }));
    },
    async complete(job, judgments: readonly RouteJudgment[], intents, terminalErrorCode) {
      const result = await execute({
        type: "route.complete",
        routeJobId: job.id,
        attempt: job.currentAttempt,
        judgments,
        intents,
        ...(terminalErrorCode === undefined ? {} : { terminalErrorCode }),
        now: Date.now(),
      });
      if (!record(result) || result.kind !== "route-completed" || !isRouteJob(result.job) ||
          !Array.isArray(result.intents) || !result.intents.every(invocationIntent)) {
        throw new RouteRuntimeError("provider_failure", "Authority route completion result was malformed");
      }
      return { job: result.job, intents: result.intents };
    },
    async fail(job, errorCode: RouteProviderFailureCode) {
      const result = await execute({
        type: "route.fail",
        routeJobId: job.id,
        attempt: job.currentAttempt,
        errorCode,
        now: Date.now(),
      });
      if (!record(result) || result.kind !== "route-failed" || !isRouteJob(result.job) ||
          (result.retryAfterMs !== undefined &&
            (typeof result.retryAfterMs !== "number" || !Number.isSafeInteger(result.retryAfterMs)))) {
        throw new RouteRuntimeError("provider_failure", "Authority route failure result was malformed");
      }
      return {
        job: result.job,
        ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
      };
    },
    async recover() {
      const result = await execute({ type: "route.recover", now: Date.now() });
      if (!record(result) || result.kind !== "route-recovery" || !Array.isArray(result.jobs) ||
          !result.jobs.every(isRouteJob)) {
        throw new RouteRuntimeError("provider_failure", "Authority route recovery result was malformed");
      }
      return result.jobs;
    },
  };
  return Object.freeze(authority);
}
