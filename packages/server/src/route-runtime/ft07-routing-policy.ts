import type { AssignmentAvailability, AssignmentParticipation } from
  "../room-assignment/assignment-policy.js";

export interface RouteCandidateSnapshotEntry {
  readonly actorId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly participation: AssignmentParticipation;
  readonly availability: AssignmentAvailability;
  readonly roomResponsibility: string;
  readonly effectiveCapabilities: readonly string[];
  readonly effectiveTools: readonly string[];
  readonly calibrationScore: number;
  readonly hasBall: boolean;
  readonly goalFactRevision: number | null;
  readonly projectFactRevision: number | null;
  readonly ballFactRevision: number | null;
}

export interface RouteCandidateSnapshot {
  readonly snapshotId: string;
  readonly routeJobId: string;
  readonly routeJobRevision: number;
  readonly roomId: string;
  readonly roomRevision: number;
  readonly sourceMessageId: string;
  readonly sourceMessageRevision: number;
  readonly sourceAuthorKind: "human" | "agent";
  readonly sourceMessageKind: "human" | "agent-final" | "agent-correction";
  readonly candidates: readonly RouteCandidateSnapshotEntry[];
}

export interface CurrentRouteFacts {
  readonly roomRevision: number;
  readonly goalFactRevision: number | null;
  readonly projectFactRevision: number | null;
  readonly ballFactRevisionByActorId: ReadonlyMap<string, number>;
}

export interface RouteProviderSelection {
  readonly actorId: string;
  readonly profileRevision: number;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly trigger: "domain" | "risk" | "ball";
  readonly reasonText: string;
}

export type RoutePolicyReason =
  | "selected"
  | "source_not_human"
  | "candidate_not_found"
  | "candidate_revision_changed"
  | "candidate_not_active"
  | "candidate_unavailable"
  | "missing_authority_facts"
  | "stale_authority_facts"
  | "ball_fact_unavailable";

export interface RoutePolicyJudgment {
  readonly actorId: string;
  readonly outcome: "will_respond" | "suppressed";
  readonly reason: RoutePolicyReason;
}

export interface RoutePolicyResult {
  readonly intents: readonly Readonly<{
    actorId: string;
    profileId: string;
    profileRevision: number;
    assignmentId: string;
    assignmentRevision: number;
    accessRevision: number;
    trigger: RouteProviderSelection["trigger"];
    reasonText: string;
  }>[];
  readonly judgments: readonly RoutePolicyJudgment[];
}

export type SemanticRouteProviderGate = Readonly<{
  allowed: true;
  candidateActorIds: readonly string[];
}> | Readonly<{
  allowed: false;
  reason: "source_not_human" | "candidate_unavailable" | "missing_authority_facts" |
    "stale_authority_facts";
}>;

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

function positiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nullableRevision(value: unknown): value is number | null {
  return value === null || positiveRevision(value);
}

function canonicalSet(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length &&
    value.every((entry, index) => index === 0 || value[index - 1]!.localeCompare(entry) < 0);
}

function candidate(value: unknown): value is RouteCandidateSnapshotEntry {
  if (!record(value) || !exact(value, [
    "actorId", "profileId", "profileRevision", "assignmentId", "assignmentRevision",
    "accessRevision", "participation", "availability", "roomResponsibility",
    "effectiveCapabilities", "effectiveTools", "calibrationScore", "hasBall",
    "goalFactRevision", "projectFactRevision", "ballFactRevision",
  ])) return false;
  return text(value.actorId) && text(value.profileId) && positiveRevision(value.profileRevision) &&
    text(value.assignmentId) && positiveRevision(value.assignmentRevision) &&
    positiveRevision(value.accessRevision) &&
    (value.participation === "active" || value.participation === "on-mention") &&
    (value.availability === "ready" || value.availability === "busy" ||
      value.availability === "paused" || value.availability === "noauth") &&
    text(value.roomResponsibility) && value.roomResponsibility.length <= 2_000 &&
    canonicalSet(value.effectiveCapabilities) && canonicalSet(value.effectiveTools) &&
    typeof value.calibrationScore === "number" && Number.isSafeInteger(value.calibrationScore) &&
    value.calibrationScore >= -3 && value.calibrationScore <= 3 &&
    typeof value.hasBall === "boolean" && nullableRevision(value.goalFactRevision) &&
    nullableRevision(value.projectFactRevision) && nullableRevision(value.ballFactRevision) &&
    (value.hasBall ? value.ballFactRevision !== null : value.ballFactRevision === null);
}

export function isRouteProviderSelection(value: unknown): value is RouteProviderSelection {
  return record(value) && exact(value, [
    "actorId", "profileRevision", "assignmentRevision", "accessRevision", "trigger", "reasonText",
  ]) && text(value.actorId) && positiveRevision(value.profileRevision) &&
    positiveRevision(value.assignmentRevision) && positiveRevision(value.accessRevision) &&
    (value.trigger === "domain" || value.trigger === "risk" || value.trigger === "ball") &&
    text(value.reasonText) && value.reasonText.length <= 2_000;
}

export function isRouteCandidateSnapshot(value: unknown): value is RouteCandidateSnapshot {
  if (!record(value) || !exact(value, [
    "snapshotId", "routeJobId", "routeJobRevision", "roomId", "roomRevision",
    "sourceMessageId", "sourceMessageRevision", "sourceAuthorKind", "sourceMessageKind",
    "candidates",
  ])) return false;
  if (!text(value.snapshotId) || !text(value.routeJobId) ||
      !positiveRevision(value.routeJobRevision) || !text(value.roomId) ||
      !positiveRevision(value.roomRevision) || !text(value.sourceMessageId) ||
      !positiveRevision(value.sourceMessageRevision) ||
      (value.sourceAuthorKind !== "human" && value.sourceAuthorKind !== "agent") ||
      (value.sourceMessageKind !== "human" && value.sourceMessageKind !== "agent-final" &&
        value.sourceMessageKind !== "agent-correction") || !Array.isArray(value.candidates) ||
      value.candidates.length > 256 || !value.candidates.every(candidate)) return false;
  const actorIds = value.candidates.map((entry) => entry.actorId);
  return new Set(actorIds).size === actorIds.length && actorIds.every((actorId, index) =>
    index === 0 || actorIds[index - 1]!.localeCompare(actorId) < 0);
}

export function isRouteJobSourceEligible(
  source: Pick<RouteCandidateSnapshot, "sourceAuthorKind" | "sourceMessageKind">,
): boolean {
  return source.sourceAuthorKind === "human" && source.sourceMessageKind === "human";
}

export function evaluateSemanticRouteProviderGate(
  snapshot: RouteCandidateSnapshot,
  facts: CurrentRouteFacts,
): SemanticRouteProviderGate {
  if (!isRouteCandidateSnapshot(snapshot)) throw new TypeError("Route candidate snapshot is invalid");
  if (!isRouteJobSourceEligible(snapshot)) {
    return Object.freeze({ allowed: false as const, reason: "source_not_human" as const });
  }
  if (facts.roomRevision !== snapshot.roomRevision) {
    return Object.freeze({ allowed: false as const, reason: "stale_authority_facts" as const });
  }
  if (facts.goalFactRevision === null || facts.projectFactRevision === null) {
    return Object.freeze({ allowed: false as const, reason: "missing_authority_facts" as const });
  }
  const eligible = snapshot.candidates.filter((entry) =>
    entry.participation === "active" && entry.availability === "ready");
  if (eligible.length === 0) {
    return Object.freeze({ allowed: false as const, reason: "candidate_unavailable" as const });
  }
  const current = eligible.filter((entry) => entry.goalFactRevision === facts.goalFactRevision &&
    entry.projectFactRevision === facts.projectFactRevision);
  if (current.length === 0) {
    const missing = eligible.some((entry) => entry.goalFactRevision === null ||
      entry.projectFactRevision === null);
    return Object.freeze({
      allowed: false as const,
      reason: missing ? "missing_authority_facts" as const : "stale_authority_facts" as const,
    });
  }
  return Object.freeze({
    allowed: true as const,
    candidateActorIds: Object.freeze(current.map((entry) => entry.actorId)),
  });
}

function suppress(actorId: string, reason: RoutePolicyReason): RoutePolicyJudgment {
  return Object.freeze({ actorId, outcome: "suppressed" as const, reason });
}

export function evaluateTrustedRouteSelections(
  snapshot: RouteCandidateSnapshot,
  facts: CurrentRouteFacts,
  selections: readonly RouteProviderSelection[],
): RoutePolicyResult {
  if (!isRouteCandidateSnapshot(snapshot)) throw new TypeError("Route candidate snapshot is invalid");
  if (!Array.isArray(selections) || selections.length > 256 ||
      !selections.every(isRouteProviderSelection)) {
    throw new TypeError("Route Provider selections are invalid");
  }
  if (!isRouteJobSourceEligible(snapshot)) {
    return Object.freeze({
      intents: Object.freeze([]),
      judgments: Object.freeze(selections.map((selection) => suppress(selection.actorId, "source_not_human"))),
    });
  }
  const candidates = new Map(snapshot.candidates.map((entry) => [entry.actorId, entry]));
  const seen = new Set<string>();
  const intents: RoutePolicyResult["intents"][number][] = [];
  const judgments: RoutePolicyJudgment[] = [];
  for (const selection of selections) {
    if (seen.has(selection.actorId)) continue;
    seen.add(selection.actorId);
    const entry = candidates.get(selection.actorId);
    if (entry === undefined) {
      judgments.push(suppress(selection.actorId, "candidate_not_found"));
      continue;
    }
    if (entry.profileRevision !== selection.profileRevision ||
        entry.assignmentRevision !== selection.assignmentRevision ||
        entry.accessRevision !== selection.accessRevision) {
      judgments.push(suppress(selection.actorId, "candidate_revision_changed"));
      continue;
    }
    if (entry.participation !== "active") {
      judgments.push(suppress(selection.actorId, "candidate_not_active"));
      continue;
    }
    if (entry.availability !== "ready") {
      judgments.push(suppress(selection.actorId, "candidate_unavailable"));
      continue;
    }
    if (facts.roomRevision !== snapshot.roomRevision) {
      judgments.push(suppress(selection.actorId, "stale_authority_facts"));
      continue;
    }
    if (selection.trigger === "domain" || selection.trigger === "risk") {
      if (entry.goalFactRevision === null || entry.projectFactRevision === null ||
          facts.goalFactRevision === null || facts.projectFactRevision === null) {
        judgments.push(suppress(selection.actorId, "missing_authority_facts"));
        continue;
      }
      if (entry.goalFactRevision !== facts.goalFactRevision ||
          entry.projectFactRevision !== facts.projectFactRevision) {
        judgments.push(suppress(selection.actorId, "stale_authority_facts"));
        continue;
      }
    } else if (!entry.hasBall || entry.ballFactRevision === null ||
        facts.ballFactRevisionByActorId.get(entry.actorId) !== entry.ballFactRevision) {
      judgments.push(suppress(selection.actorId, "ball_fact_unavailable"));
      continue;
    }
    intents.push(Object.freeze({
      actorId: entry.actorId,
      profileId: entry.profileId,
      profileRevision: entry.profileRevision,
      assignmentId: entry.assignmentId,
      assignmentRevision: entry.assignmentRevision,
      accessRevision: entry.accessRevision,
      trigger: selection.trigger,
      reasonText: selection.reasonText,
    }));
    judgments.push(Object.freeze({
      actorId: entry.actorId,
      outcome: "will_respond" as const,
      reason: "selected" as const,
    }));
  }
  return Object.freeze({ intents: Object.freeze(intents), judgments: Object.freeze(judgments) });
}
