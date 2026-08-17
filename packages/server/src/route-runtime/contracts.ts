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

export interface RouterProvider {
  decide(input: RouterProviderInput, signal: AbortSignal): Promise<RouterPlan>;
}

export interface RouteAuthorityClaim {
  readonly job: RouteJob;
  readonly providerInput: RouterProviderInput;
  readonly decisionContext: RouteClaimDecisionContext;
}

export interface RouteAuthority {
  claim(sourceMessageId: string): Promise<RouteAuthorityClaim>;
  complete(
    job: RouteJob,
    judgments: readonly RouteJudgment[],
    intents: readonly RouteInvocationIntent[],
    terminalErrorCode?: RouteProviderFailureCode,
  ): Promise<{ readonly job: RouteJob; readonly intents: readonly RouteInvocationIntent[] }>;
  fail(
    job: RouteJob,
    errorCode: RouteProviderFailureCode,
  ): Promise<{ readonly job: RouteJob; readonly retryAfterMs?: number }>;
  recover(): Promise<readonly RouteJob[]>;
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
