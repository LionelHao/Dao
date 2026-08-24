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
import type {
  ClaimRoutedInvocationIntentResult,
  RoutedInvocationIntentRecord,
} from "../agent-runtime/durable-trusted-intent-authority.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) =>
    Object.hasOwn(value, key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function time(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
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

function routedIntent(value: unknown): value is RoutedInvocationIntentRecord {
  if (!record(value)) return false;
  const optionalKeys = ["claimedAt", "cancelledAt", "cancellationReason"].filter((key) =>
    Object.hasOwn(value, key));
  if (!exact(value, [
    "intentId", "decisionId", "routeJobId", "snapshotId", "roomId",
    "sourceMessageId", "sourceMessageRevision", "actorId", "profileId",
    "profileRevision", "assignmentId", "assignmentRevision", "accessRevision",
    "trigger", "reasonText", "status", "createdAt", ...optionalKeys,
  ])) return false;
  if (!text(value.intentId) || !text(value.decisionId) || !text(value.routeJobId) ||
      !text(value.snapshotId) || !text(value.roomId) || !text(value.sourceMessageId) ||
      !positive(value.sourceMessageRevision) || !text(value.actorId) ||
      !text(value.profileId) || !positive(value.profileRevision) ||
      !text(value.assignmentId) || !positive(value.assignmentRevision) ||
      !nonnegative(value.accessRevision) || !text(value.reasonText) || !time(value.createdAt) ||
      (value.claimedAt !== undefined && !time(value.claimedAt)) ||
      (value.cancelledAt !== undefined && !time(value.cancelledAt))) return false;
  const cancellationReasons = new Set([
    "route_provenance_invalid", "route_revision_stale", "source_revision_stale",
    "room_archived", "profile_unavailable", "profile_revision_stale",
    "assignment_removed", "assignment_paused", "assignment_inactive",
    "assignment_revision_stale", "access_revoked", "access_revision_stale",
    "noauth", "busy",
  ]);
  if (value.cancellationReason !== undefined &&
      (!text(value.cancellationReason) || !cancellationReasons.has(value.cancellationReason))) {
    return false;
  }
  return (value.trigger === "domain" || value.trigger === "risk" || value.trigger === "ball") &&
    (value.status === "pending" || value.status === "claimed" || value.status === "cancelled") &&
    (value.status === "pending"
      ? value.claimedAt === undefined && value.cancelledAt === undefined &&
        value.cancellationReason === undefined
      : value.status === "claimed"
        ? value.claimedAt !== undefined && value.cancelledAt === undefined &&
          value.cancellationReason === undefined
        : value.claimedAt === undefined && value.cancelledAt !== undefined &&
          value.cancellationReason !== undefined);
}

function acceptedHandoff(value: unknown, intent: RoutedInvocationIntentRecord): boolean {
  return record(value) && exact(value, [
    "intentId", "roomId", "sourceMessageId", "sourceMessageRevision", "actorId",
    "profileId", "profileRevision", "assignmentId", "assignmentRevision",
    "accessRevision", "trigger", "reasonText",
  ]) && value.intentId === intent.intentId && value.roomId === intent.roomId &&
    value.sourceMessageId === intent.sourceMessageId &&
    value.sourceMessageRevision === intent.sourceMessageRevision &&
    value.actorId === intent.actorId && value.profileId === intent.profileId &&
    value.profileRevision === intent.profileRevision &&
    value.assignmentId === intent.assignmentId &&
    value.assignmentRevision === intent.assignmentRevision &&
    value.accessRevision === intent.accessRevision && value.trigger === intent.trigger &&
    value.reasonText === intent.reasonText;
}

function claimHandoffResult(value: unknown): value is ClaimRoutedInvocationIntentResult {
  if (!record(value) ||
      (value.disposition !== "claimed" && value.disposition !== "already-claimed" &&
       value.disposition !== "cancelled" && value.disposition !== "already-cancelled") ||
      !routedIntent(value.intent)) return false;
  return (value.disposition === "claimed" || value.disposition === "already-claimed")
    ? exact(value, ["disposition", "intent", "handoff"]) &&
      acceptedHandoff(value.handoff, value.intent)
    : exact(value, ["disposition", "intent"]);
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
    async claim(sourceMessageId, agentProviderReady) {
      return claimResult(await execute({
        type: "route.claim", sourceMessageId, agentProviderReady, now: Date.now(),
      }));
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
          !Array.isArray(result.intents) || !result.intents.every(invocationIntent) ||
          !Array.isArray(result.handoffs) || !result.handoffs.every(routedIntent)) {
        throw new RouteRuntimeError("provider_failure", "Authority route completion result was malformed");
      }
      return { job: result.job, intents: result.intents, handoffs: result.handoffs };
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
    async claimHandoff(roomId, intentId, providerReady) {
      const result = await execute({
        type: "route.handoff.claim", roomId, intentId, providerReady, now: Date.now(),
      });
      if (!record(result) || result.kind !== "route-handoff-claimed" ||
          !claimHandoffResult(result.result)) {
        throw new RouteRuntimeError("provider_failure", "Authority route handoff claim was malformed");
      }
      return result.result;
    },
    async recoverHandoffs() {
      const result = await execute({ type: "route.handoff.recover", now: Date.now() });
      if (!record(result) || result.kind !== "route-handoff-recovery" ||
          !Array.isArray(result.intents) || !result.intents.every(routedIntent)) {
        throw new RouteRuntimeError("provider_failure", "Authority route handoff recovery was malformed");
      }
      return result.intents;
    },
  };
  return Object.freeze(authority);
}
