import {
  isTrustedInvocationOrigin,
  type RouteDecisionOrigin,
} from "./trusted-invocation-origin.js";

export interface RouteHandoffIntentInput {
  readonly intentId: string;
  readonly actorId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly trigger: "domain" | "risk" | "ball";
  readonly reasonText: string;
}

export interface RouteDurableIntentOperation {
  readonly type: "route-decision.commit-intents.v1";
  readonly decisionId: string;
  readonly routeJobId: string;
  readonly expectedRouteJobRevision: number;
  readonly snapshotId: string;
  readonly roomId: string;
  readonly createdAt: string;
  readonly intents: readonly RouteHandoffIntentInput[];
}

export interface DurableRouteIntentRecord extends RouteHandoffIntentInput {
  readonly decisionId: string;
  readonly routeJobId: string;
  readonly snapshotId: string;
  readonly roomId: string;
  readonly status: "pending" | "claimed" | "cancelled";
}

export interface DurableRouteHandoffAuthority {
  commitDecisionAndIntents(operation: RouteDurableIntentOperation): Promise<Readonly<{
    decisionStatus: "completed" | "already_completed";
    intents: readonly DurableRouteIntentRecord[];
  }>>;
  recoverPendingIntents(limit: number): Promise<readonly DurableRouteIntentRecord[]>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function time(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

function intent(value: unknown): value is RouteHandoffIntentInput {
  return record(value) && exact(value, [
    "intentId", "actorId", "profileId", "profileRevision", "assignmentId",
    "assignmentRevision", "accessRevision", "trigger", "reasonText",
  ]) && text(value.intentId) && text(value.actorId) && text(value.profileId) &&
    revision(value.profileRevision) && text(value.assignmentId) &&
    revision(value.assignmentRevision) && revision(value.accessRevision) &&
    (value.trigger === "domain" || value.trigger === "risk" || value.trigger === "ball") &&
    text(value.reasonText) && value.reasonText.length <= 2_000;
}

export function isRouteDurableIntentOperation(value: unknown): value is RouteDurableIntentOperation {
  if (!record(value) || !exact(value, [
    "type", "decisionId", "routeJobId", "expectedRouteJobRevision", "snapshotId",
    "roomId", "createdAt", "intents",
  ]) || value.type !== "route-decision.commit-intents.v1" || !text(value.decisionId) ||
      !text(value.routeJobId) || !revision(value.expectedRouteJobRevision) ||
      !text(value.snapshotId) || !text(value.roomId) || !time(value.createdAt) ||
      !Array.isArray(value.intents) || value.intents.length > 256 ||
      !value.intents.every(intent)) return false;
  const intentIds = value.intents.map((entry) => entry.intentId);
  const actorIds = value.intents.map((entry) => entry.actorId);
  return new Set(intentIds).size === intentIds.length &&
    new Set(actorIds).size === actorIds.length && actorIds.every((actorId, index) =>
      index === 0 || actorIds[index - 1]!.localeCompare(actorId) < 0);
}

export function createRouteDurableIntentOperation(
  origin: RouteDecisionOrigin,
  intents: readonly RouteHandoffIntentInput[],
  createdAt: string,
): RouteDurableIntentOperation {
  if (!isTrustedInvocationOrigin(origin) || origin.kind !== "route_decision") {
    throw new TypeError("A trusted route decision origin is required");
  }
  const operation: RouteDurableIntentOperation = {
    type: "route-decision.commit-intents.v1",
    decisionId: origin.decisionId,
    routeJobId: origin.routeJobId,
    expectedRouteJobRevision: origin.routeJobRevision,
    snapshotId: origin.snapshotId,
    roomId: origin.roomId,
    createdAt,
    intents: Object.freeze(intents.map((entry) => Object.freeze({ ...entry }))),
  };
  const targetByActorId = new Map(origin.targets.map((target) => [target.actorId, target]));
  const allIntentsBound = operation.intents.length === origin.targets.length &&
    operation.intents.every((entry) => {
      const target = targetByActorId.get(entry.actorId);
      return target !== undefined && target.profileId === entry.profileId &&
        target.profileRevision === entry.profileRevision &&
        target.assignmentId === entry.assignmentId &&
        target.assignmentRevision === entry.assignmentRevision &&
        target.accessRevision === entry.accessRevision;
    });
  if (!isRouteDurableIntentOperation(operation) || !allIntentsBound) {
    throw new TypeError("Route durable intent operation is invalid");
  }
  return Object.freeze(operation);
}

export async function commitDurableRouteHandoff(
  authority: DurableRouteHandoffAuthority,
  operation: RouteDurableIntentOperation,
): Promise<readonly DurableRouteIntentRecord[]> {
  if (!isRouteDurableIntentOperation(operation)) {
    throw new TypeError("Route durable intent operation is invalid");
  }
  const result = await authority.commitDecisionAndIntents(operation);
  return result.intents;
}

export async function recoverDurableRouteHandoffs(
  authority: DurableRouteHandoffAuthority,
  limit = 256,
): Promise<readonly DurableRouteIntentRecord[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new TypeError("Route handoff recovery limit is invalid");
  }
  return authority.recoverPendingIntents(limit);
}
