import type { ProjectActorRef } from "@native-im/core";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const PROJECT_REMINDER_SCAN_LIMITS = Object.freeze({
  maxBoundaries: 256,
  maxOrdinal: 36_500,
});

export type PersistedProjectBoundaryStatus =
  | "active" | "suspended" | "revoked" | "consumed" | "stale" | "resolved" | "transferred";

export type PersistedProjectBoundary = Readonly<{
  recordVersion: "project-boundary.v1";
  boundaryId: string;
  roomId: string;
  projectId: string;
  boundaryKind: "checkpoint" | "due" | "blocker" | "agent_ball" | "review";
  sourceKind: "goal" | "decision" | "request" | "next_action" | "blocker" | "open_question";
  sourceId: string;
  sourceRevision: number;
  holder: ProjectActorRef;
  lifecycleGeneration: number;
  status: PersistedProjectBoundaryStatus;
  confirmed: boolean;
  consumed: boolean;
  dueAt: string | null;
  reviewAt: string | null;
  createdAt: string;
}>;

export type ProjectReminderKind = "human_reminder" | "agent_invocation";

export type ProjectReminderClaimResult =
  | Readonly<{
      status: "claimed";
      roomId: string;
      boundaryId: string;
      reminderOrdinal: number;
      recipientActorId: string;
      dispatch:
        | Readonly<{ kind: "human_notification"; outboxId: string }>
        | Readonly<{ kind: "agent_invocation"; intentId: string }>;
    }>
  | Readonly<{
      status: "duplicate" | "ineligible";
      roomId: string;
      boundaryId: string;
      reminderOrdinal: number;
      recipientActorId: string;
    }>;

export interface ProjectReminderAuthorityPort {
  listEligibleBoundaries(input: Readonly<{
    now: string;
    limit: number;
  }>): Promise<unknown>;
  /**
   * The v23 adapter must atomically claim the stable reminder key and write the
   * Human outbox row or Agent invocation intent before returning `claimed`.
   */
  claimCurrentBucket(input: Readonly<{
    roomId: string;
    boundaryId: string;
    sourceRevision: number;
    lifecycleGeneration: number;
    reminderKind: ProjectReminderKind;
    reminderOrdinal: number;
    recipientActorId: string;
    scheduledAt: string;
    claimedAt: string;
  }>): Promise<unknown>;
}

export type ProjectReminderScanResult = Readonly<{
  scannedCount: number;
  claimedCount: number;
  duplicateCount: number;
  ignoredCount: number;
  claims: readonly ProjectReminderClaimResult[];
}>;

export type ProjectLoopArchiveResult = Readonly<{
  roomId: string;
  archiveGeneration: number;
  lifecycleGeneration: number;
  state: "archived";
  suspendedBoundaryCount: number;
  terminalBoundaryCount: number;
}>;

export type ProjectLoopReopenResult = Readonly<{
  roomId: string;
  archiveGeneration: number;
  lifecycleGeneration: number;
  state: "active";
  resumedBoundaryCount: number;
  replacementBoundaryCount: number;
}>;

export type ProjectLoopLifecycleInput = Readonly<{
  roomId: string;
  archiveGeneration: number;
  previousLifecycleGeneration: number;
  occurredAt: string;
}>;

export interface ProjectLoopLifecycleAuthorityPort {
  /** Freezes only non-terminal boundaries and stores their remaining business duration. */
  archive(input: ProjectLoopLifecycleInput): Promise<unknown>;
  /** Resumes frozen responsibility with new generation-bound boundary IDs; terminal rows stay terminal. */
  reopen(input: ProjectLoopLifecycleInput): Promise<unknown>;
}

type UnknownRecord = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function actor(value: unknown): value is ProjectActorRef {
  return isRecord(value) && exact(value, ["kind", "actorId"]) && identifier(value.actorId) &&
    (value.kind === "human" || value.kind === "agent");
}

export function isPersistedProjectBoundary(value: unknown): value is PersistedProjectBoundary {
  return isRecord(value) && exact(value, [
    "recordVersion", "boundaryId", "roomId", "projectId", "boundaryKind", "sourceKind", "sourceId",
    "sourceRevision", "holder", "lifecycleGeneration", "status", "confirmed", "consumed", "dueAt",
    "reviewAt", "createdAt",
  ]) && value.recordVersion === "project-boundary.v1" && identifier(value.boundaryId) &&
    identifier(value.roomId) && value.projectId === value.roomId &&
    (value.boundaryKind === "checkpoint" || value.boundaryKind === "due" ||
      value.boundaryKind === "blocker" || value.boundaryKind === "agent_ball" ||
      value.boundaryKind === "review") &&
    (value.sourceKind === "goal" || value.sourceKind === "decision" || value.sourceKind === "request" ||
      value.sourceKind === "next_action" || value.sourceKind === "blocker" ||
      value.sourceKind === "open_question") && identifier(value.sourceId) && positive(value.sourceRevision) &&
    actor(value.holder) && nonnegative(value.lifecycleGeneration) &&
    (value.status === "active" || value.status === "suspended" || value.status === "revoked" ||
      value.status === "consumed" || value.status === "stale" || value.status === "resolved" ||
      value.status === "transferred") && typeof value.confirmed === "boolean" &&
    typeof value.consumed === "boolean" && (value.dueAt === null || timestamp(value.dueAt)) &&
    (value.reviewAt === null || timestamp(value.reviewAt)) && timestamp(value.createdAt);
}

function eligible(boundary: PersistedProjectBoundary): boolean {
  return boundary.status === "active" && boundary.confirmed && !boundary.consumed;
}

export function currentProjectReminderOrdinal(dueAt: string, now: string): number | null {
  if (!timestamp(dueAt) || !timestamp(now)) return null;
  const elapsed = Date.parse(now) - Date.parse(dueAt);
  if (elapsed < 0) return null;
  const ordinal = Math.floor(elapsed / DAY_MS);
  return ordinal <= PROJECT_REMINDER_SCAN_LIMITS.maxOrdinal ? ordinal : null;
}

function claimResult(
  value: unknown,
  expected: Readonly<{
    roomId: string;
    boundaryId: string;
    reminderOrdinal: number;
    recipientActorId: string;
    reminderKind: ProjectReminderKind;
  }>,
): value is ProjectReminderClaimResult {
  if (!isRecord(value) || value.roomId !== expected.roomId || value.boundaryId !== expected.boundaryId ||
      value.reminderOrdinal !== expected.reminderOrdinal ||
      value.recipientActorId !== expected.recipientActorId) return false;
  if (value.status === "duplicate" || value.status === "ineligible") {
    return exact(value, ["status", "roomId", "boundaryId", "reminderOrdinal", "recipientActorId"]);
  }
  if (value.status !== "claimed" || !exact(value, [
    "status", "roomId", "boundaryId", "reminderOrdinal", "recipientActorId", "dispatch",
  ]) || !isRecord(value.dispatch)) return false;
  if (expected.reminderKind === "human_reminder") {
    return exact(value.dispatch, ["kind", "outboxId"]) &&
      value.dispatch.kind === "human_notification" && identifier(value.dispatch.outboxId);
  }
  return exact(value.dispatch, ["kind", "intentId"]) && value.dispatch.kind === "agent_invocation" &&
    identifier(value.dispatch.intentId);
}

function cloneClaim(value: ProjectReminderClaimResult): ProjectReminderClaimResult {
  if (value.status !== "claimed") return Object.freeze({ ...value });
  return Object.freeze({ ...value, dispatch: Object.freeze({ ...value.dispatch }) });
}

export async function scanCurrentProjectReminderBuckets(options: Readonly<{
  authority: ProjectReminderAuthorityPort;
  now: string;
  limit: number;
}>): Promise<ProjectReminderScanResult> {
  if (!timestamp(options.now) || !positive(options.limit) ||
      options.limit > PROJECT_REMINDER_SCAN_LIMITS.maxBoundaries) {
    throw new TypeError("Project reminder scan input was invalid");
  }
  const candidate = await options.authority.listEligibleBoundaries({
    now: options.now,
    limit: options.limit,
  });
  if (!Array.isArray(candidate) || candidate.length > options.limit) {
    throw new TypeError("Project reminder authority result was malformed");
  }
  const ids = new Set<string>();
  const claims: ProjectReminderClaimResult[] = [];
  let ignoredCount = 0;
  for (const raw of candidate) {
    if (!isPersistedProjectBoundary(raw)) {
      throw new TypeError("Project reminder authority boundary was malformed");
    }
    if (ids.has(raw.boundaryId)) {
      throw new TypeError("Project reminder authority boundary was duplicated");
    }
    ids.add(raw.boundaryId);
    if (!eligible(raw)) {
      ignoredCount += 1;
      continue;
    }
    const scheduledBoundary = raw.boundaryKind === "review" ? raw.reviewAt : raw.dueAt;
    if (scheduledBoundary === null) {
      ignoredCount += 1;
      continue;
    }
    const ordinal = currentProjectReminderOrdinal(scheduledBoundary, options.now);
    if (ordinal === null) {
      ignoredCount += 1;
      continue;
    }
    const reminderKind = raw.holder.kind === "human" ? "human_reminder" : "agent_invocation";
    const expected = {
      roomId: raw.roomId,
      boundaryId: raw.boundaryId,
      reminderOrdinal: ordinal,
      recipientActorId: raw.holder.actorId,
      reminderKind,
    } as const;
    const result = await options.authority.claimCurrentBucket({
      roomId: raw.roomId,
      boundaryId: raw.boundaryId,
      sourceRevision: raw.sourceRevision,
      lifecycleGeneration: raw.lifecycleGeneration,
      reminderKind,
      reminderOrdinal: ordinal,
      recipientActorId: raw.holder.actorId,
      scheduledAt: new Date(Date.parse(scheduledBoundary) + ordinal * DAY_MS).toISOString(),
      claimedAt: options.now,
    });
    if (!claimResult(result, expected)) {
      throw new TypeError("Project reminder claim result was malformed");
    }
    claims.push(cloneClaim(result));
  }
  const frozenClaims = Object.freeze(claims);
  return Object.freeze({
    scannedCount: candidate.length,
    claimedCount: claims.filter((item) => item.status === "claimed").length,
    duplicateCount: claims.filter((item) => item.status === "duplicate").length,
    ignoredCount: ignoredCount + claims.filter((item) => item.status === "ineligible").length,
    claims: frozenClaims,
  });
}

function lifecycleInput(value: unknown): value is ProjectLoopLifecycleInput {
  return isRecord(value) && exact(value, [
    "roomId", "archiveGeneration", "previousLifecycleGeneration", "occurredAt",
  ]) && identifier(value.roomId) && positive(value.archiveGeneration) &&
    nonnegative(value.previousLifecycleGeneration) && timestamp(value.occurredAt);
}

function archiveResult(value: unknown, input: ProjectLoopLifecycleInput): value is ProjectLoopArchiveResult {
  return isRecord(value) && exact(value, [
    "roomId", "archiveGeneration", "lifecycleGeneration", "state", "suspendedBoundaryCount",
    "terminalBoundaryCount",
  ]) && value.roomId === input.roomId && value.archiveGeneration === input.archiveGeneration &&
    value.lifecycleGeneration === input.previousLifecycleGeneration + 1 && value.state === "archived" &&
    nonnegative(value.suspendedBoundaryCount) && nonnegative(value.terminalBoundaryCount);
}

function reopenResult(value: unknown, input: ProjectLoopLifecycleInput): value is ProjectLoopReopenResult {
  return isRecord(value) && exact(value, [
    "roomId", "archiveGeneration", "lifecycleGeneration", "state", "resumedBoundaryCount",
    "replacementBoundaryCount",
  ]) && value.roomId === input.roomId && value.archiveGeneration === input.archiveGeneration &&
    value.lifecycleGeneration === input.previousLifecycleGeneration + 1 && value.state === "active" &&
    nonnegative(value.resumedBoundaryCount) && nonnegative(value.replacementBoundaryCount) &&
    value.replacementBoundaryCount === value.resumedBoundaryCount;
}

export function createProjectLoopLifecycleCoordinator(options: Readonly<{
  authority: ProjectLoopLifecycleAuthorityPort;
}>): Readonly<{
  archive(input: ProjectLoopLifecycleInput): Promise<ProjectLoopArchiveResult>;
  reopen(input: ProjectLoopLifecycleInput): Promise<ProjectLoopReopenResult>;
}> {
  return Object.freeze({
    async archive(input) {
      if (!lifecycleInput(input)) throw new TypeError("Project lifecycle input was invalid");
      const result = await options.authority.archive(input);
      if (!archiveResult(result, input)) throw new TypeError("Project lifecycle authority result was malformed");
      return Object.freeze({ ...result });
    },
    async reopen(input) {
      if (!lifecycleInput(input)) throw new TypeError("Project lifecycle input was invalid");
      const result = await options.authority.reopen(input);
      if (!reopenResult(result, input)) throw new TypeError("Project lifecycle authority result was malformed");
      return Object.freeze({ ...result });
    },
  });
}
