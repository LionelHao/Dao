import {
  isRouteJudgment,
  type RouteInvocationIntent,
  type RouteJob,
  type RouteJudgment,
  type RouterProviderInput,
} from "@native-im/core";
import type { JsonValue } from "../persistence/contracts.js";
import type {
  ClaimRoutedInvocationIntentResult,
  RoutedInvocationIntentRecord,
} from "../agent-runtime/durable-trusted-intent-authority.js";

export type RouteProviderFailureCode =
  | "provider_timeout"
  | "provider_cancelled"
  | "provider_malformed"
  | "provider_failure"
  | "runtime_restarted";

export interface RouteClaimDecisionContext {
  readonly directMentionAgentIds: readonly string[];
  readonly structuredHelpAgentIds: readonly string[];
  readonly recentHumanMessageTimes: readonly number[];
  readonly consecutiveAgentRounds: number;
  readonly cooldownByAgentId: readonly {
    readonly agentId: string;
    readonly lastRespondedAt: number;
  }[];
}

export type RouteAuthorityOperation =
  | {
      readonly type: "route.claim";
      readonly sourceMessageId: string;
      readonly agentProviderReady: boolean;
      readonly now: number;
    }
  | {
      readonly type: "route.complete";
      readonly routeJobId: string;
      readonly attempt: 1 | 2 | 3;
      readonly judgments: readonly RouteJudgment[];
      readonly intents: readonly RouteInvocationIntent[];
      readonly agentProviderReady: boolean;
      readonly terminalErrorCode?: RouteProviderFailureCode;
      readonly now: number;
    }
  | {
      readonly type: "route.fail";
      readonly routeJobId: string;
      readonly attempt: 1 | 2 | 3;
      readonly errorCode: RouteProviderFailureCode;
      readonly now: number;
    }
  | { readonly type: "route.recover"; readonly now: number }
  | {
      readonly type: "route.handoff.claim";
      readonly roomId: string;
      readonly intentId: string;
      readonly providerReady: boolean;
      readonly now: number;
    }
  | { readonly type: "route.handoff.recover"; readonly now: number };

export type RouteAuthorityOperationResult =
  | {
      readonly kind: "route-claimed";
      readonly job: RouteJob;
      readonly providerInput: RouterProviderInput;
      readonly decisionContext: RouteClaimDecisionContext;
    }
  | {
      readonly kind: "route-completed";
      readonly job: RouteJob;
      readonly intents: readonly RouteInvocationIntent[];
      readonly handoffs: readonly RoutedInvocationIntentRecord[];
    }
  | {
      readonly kind: "route-failed";
      readonly job: RouteJob;
      readonly retryAfterMs?: number;
    }
  | { readonly kind: "route-recovery"; readonly jobs: readonly RouteJob[] }
  | {
      readonly kind: "route-handoff-claimed";
      readonly result: ClaimRoutedInvocationIntentResult;
    }
  | {
      readonly kind: "route-handoff-recovery";
      readonly intents: readonly RoutedInvocationIntentRecord[];
    };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, required: readonly string[]): boolean {
  return Object.keys(value).length === required.length &&
    required.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function count(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function invocationIntent(value: unknown): value is RouteInvocationIntent {
  return record(value) && exact(value, [
    "kind", "roomId", "sourceMessageId", "targetAgentId",
    "reasonCode", "reasonText", "priority",
  ]) &&
    (value.kind === "direct_mention" || value.kind === "structured_help" || value.kind === "routed_candidate") &&
    text(value.roomId) && text(value.sourceMessageId) && text(value.targetAgentId) &&
    (value.reasonCode === "direct_mention" || value.reasonCode === "structured_help" ||
      value.reasonCode === "domain_match" || value.reasonCode === "risk_detected" ||
      value.reasonCode === "ball_due") &&
    text(value.reasonText) &&
    (value.priority === 1 || value.priority === 2 || value.priority === 3);
}

const providerFailureCodes = new Set<RouteProviderFailureCode>([
  "provider_timeout",
  "provider_cancelled",
  "provider_malformed",
  "provider_failure",
  "runtime_restarted",
]);

export function isRouteAuthorityOperation(value: unknown): value is RouteAuthorityOperation {
  if (!record(value) || !text(value.type)) return false;
  if (value.type === "route.claim") {
    return exact(value, ["type", "sourceMessageId", "agentProviderReady", "now"]) &&
      text(value.sourceMessageId) && typeof value.agentProviderReady === "boolean" &&
      count(value.now);
  }
  if (value.type === "route.complete") {
    const keys = ["type", "routeJobId", "attempt", "judgments", "intents", "agentProviderReady", "now",
      ...(Object.hasOwn(value, "terminalErrorCode") ? ["terminalErrorCode"] : [])];
    return exact(value, keys) &&
      text(value.routeJobId) && (value.attempt === 1 || value.attempt === 2 || value.attempt === 3) &&
      Array.isArray(value.judgments) && value.judgments.length <= 256 &&
      value.judgments.every(isRouteJudgment) &&
      Array.isArray(value.intents) && value.intents.length <= 256 &&
      value.intents.every(invocationIntent) &&
      typeof value.agentProviderReady === "boolean" &&
      (!Object.hasOwn(value, "terminalErrorCode") ||
        providerFailureCodes.has(value.terminalErrorCode as RouteProviderFailureCode)) &&
      count(value.now);
  }
  if (value.type === "route.fail") {
    return exact(value, ["type", "routeJobId", "attempt", "errorCode", "now"]) &&
      text(value.routeJobId) && (value.attempt === 1 || value.attempt === 2 || value.attempt === 3) &&
      providerFailureCodes.has(value.errorCode as RouteProviderFailureCode) && count(value.now);
  }
  if (value.type === "route.recover" || value.type === "route.handoff.recover") {
    return exact(value, ["type", "now"]) && count(value.now);
  }
  return value.type === "route.handoff.claim" &&
    exact(value, ["type", "roomId", "intentId", "providerReady", "now"]) &&
    text(value.roomId) && text(value.intentId) && typeof value.providerReady === "boolean" &&
    count(value.now);
}

export function routeResultAsJson(result: RouteAuthorityOperationResult): JsonValue {
  return result as unknown as JsonValue;
}
