import {
  isBallInCourt,
  isBallOverdueTrigger,
  isBlueprintBallFact,
  isNeedsActionProjection,
  isReminderCandidate,
  type BallInCourt,
  type BallOverdueTrigger,
  type BallSummary,
  type BlueprintBallFact,
  type NeedsActionProjection,
  type ReminderCandidate,
} from "@native-im/core";
import type { AuthenticatedSessionContext, JsonValue } from "../persistence/contracts.js";

export interface BallDeadlinePolicy {
  readonly openItemDeadlineMs: number;
  readonly lightTaskDeadlineMs: number;
}

export type BallAuthorityOperation =
  | { readonly type: "ball.list-rooms"; readonly now: number }
  | {
      readonly type: "ball.query";
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly blueprintFacts: readonly BlueprintBallFact[];
      readonly policy: BallDeadlinePolicy;
      readonly now: number;
    }
  | {
      readonly type: "ball.scan-overdue";
      readonly roomId: string;
      readonly blueprintFacts: readonly BlueprintBallFact[];
      readonly policy: BallDeadlinePolicy;
      readonly now: number;
    };

export type BallAuthorityOperationResult =
  | { readonly kind: "ball-rooms"; readonly roomIds: readonly string[] }
  | {
      readonly kind: "ball-query";
      readonly balls: readonly BallInCourt[];
      readonly needsAction: readonly NeedsActionProjection[];
      readonly reminders: readonly ReminderCandidate[];
    }
  | {
      readonly kind: "ball-overdue-scan";
      readonly agentTriggers: readonly BallOverdueTrigger[];
      readonly reminders: readonly ReminderCandidate[];
      readonly ballSummaries: readonly BallSummary[];
    };

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const exact = (value: UnknownRecord, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const tokenHash = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
};
const sessionContext = (value: unknown): value is AuthenticatedSessionContext =>
  record(value) && exact(value, ["sessionId", "sessionFamilyId", "principal"]) &&
  tokenHash(value.sessionId) && tokenHash(value.sessionFamilyId) && record(value.principal) &&
  exact(value.principal, ["accountId", "actorId"]) && text(value.principal.accountId) &&
  text(value.principal.actorId);

function policy(value: unknown): value is BallDeadlinePolicy {
  return record(value) && exact(value, ["openItemDeadlineMs", "lightTaskDeadlineMs"]) &&
    integer(value.openItemDeadlineMs) && integer(value.lightTaskDeadlineMs);
}

export function isBallAuthorityOperation(value: unknown): value is BallAuthorityOperation {
  if (!record(value) || !text(value.type)) return false;
  if (value.type === "ball.list-rooms") {
    return exact(value, ["type", "now"]) && integer(value.now);
  }
  const common = text(value.roomId) && Array.isArray(value.blueprintFacts) &&
    value.blueprintFacts.length <= 256 && value.blueprintFacts.every(isBlueprintBallFact) &&
    policy(value.policy) && integer(value.now);
  if (value.type === "ball.query") {
    return exact(value, ["type", "context", "roomId", "blueprintFacts", "policy", "now"]) &&
      sessionContext(value.context) && common;
  }
  return value.type === "ball.scan-overdue" &&
    exact(value, ["type", "roomId", "blueprintFacts", "policy", "now"]) && common;
}

export function isBallAuthorityOperationResult(value: unknown): value is BallAuthorityOperationResult {
  if (!record(value) || !text(value.kind)) return false;
  if (value.kind === "ball-rooms") {
    return exact(value, ["kind", "roomIds"]) && Array.isArray(value.roomIds) &&
      value.roomIds.length <= 256 && value.roomIds.every(text) &&
      new Set(value.roomIds).size === value.roomIds.length;
  }
  if (value.kind === "ball-query") {
    return exact(value, ["kind", "balls", "needsAction", "reminders"]) &&
      Array.isArray(value.balls) && value.balls.every(isBallInCourt) &&
      Array.isArray(value.needsAction) && value.needsAction.every(isNeedsActionProjection) &&
      Array.isArray(value.reminders) && value.reminders.every(isReminderCandidate);
  }
  return value.kind === "ball-overdue-scan" &&
    exact(value, ["kind", "agentTriggers", "reminders", "ballSummaries"]) &&
    Array.isArray(value.agentTriggers) && value.agentTriggers.every(isBallOverdueTrigger) &&
    Array.isArray(value.reminders) && value.reminders.every(isReminderCandidate) &&
    Array.isArray(value.ballSummaries) && value.ballSummaries.every((summary) =>
      record(summary) && exact(summary, ["agentId", "sourceKind", "sourceId", "reason", "since", "deadline"]) &&
      text(summary.agentId) && text(summary.sourceKind) && text(summary.sourceId) &&
      text(summary.reason) && text(summary.since) && text(summary.deadline));
}

export function ballResultAsJson(result: BallAuthorityOperationResult): JsonValue {
  return result as unknown as JsonValue;
}
