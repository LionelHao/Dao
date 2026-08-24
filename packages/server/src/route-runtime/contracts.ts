import type {
  RouteInvocationIntent,
  RouteJob,
  RouteJudgment,
  RouterPlan,
  RouterProviderInput,
} from "@native-im/core";
import type {
  RouteClaimDecisionContext,
  RouteProviderFailureCode,
} from "./route-authority-protocol.js";
import type {
  ClaimRoutedInvocationIntentResult,
  RoutedInvocationIntentRecord,
} from "../agent-runtime/durable-trusted-intent-authority.js";

export interface RouterProvider {
  decide(input: RouterProviderInput, signal: AbortSignal): Promise<RouterPlan>;
}

export interface RouteAuthorityClaim {
  readonly job: RouteJob;
  readonly providerInput: RouterProviderInput;
  readonly decisionContext: RouteClaimDecisionContext;
}

export interface RouteAuthority {
  claim(sourceMessageId: string, agentProviderReady: boolean): Promise<RouteAuthorityClaim>;
  complete(
    job: RouteJob,
    judgments: readonly RouteJudgment[],
    intents: readonly RouteInvocationIntent[],
    terminalErrorCode?: RouteProviderFailureCode,
  ): Promise<{
    readonly job: RouteJob;
    readonly intents: readonly RouteInvocationIntent[];
    readonly handoffs: readonly RoutedInvocationIntentRecord[];
  }>;
  fail(
    job: RouteJob,
    errorCode: RouteProviderFailureCode,
  ): Promise<{ readonly job: RouteJob; readonly retryAfterMs?: number }>;
  recover(): Promise<readonly RouteJob[]>;
  claimHandoff(
    roomId: string,
    intentId: string,
    providerReady: boolean,
  ): Promise<ClaimRoutedInvocationIntentResult>;
  recoverHandoffs(): Promise<readonly RoutedInvocationIntentRecord[]>;
}

export class RouteRuntimeError extends Error {
  constructor(
    readonly code: RouteProviderFailureCode | "route_conflict" | "route_job_not_found" | "route_queue_full",
    message: string,
  ) {
    super(message);
    this.name = "RouteRuntimeError";
  }
}
