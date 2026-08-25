import { createHash } from "node:crypto";
import {
  isDepartureConflict,
  isProjectSourceRef,
  type DepartureConflict,
  type DepartureResolution,
  type ProjectSourceRef,
} from "@native-im/core";
import {
  isAuthorityTransactionView,
  type AuthorityParticipantEnvelope,
  type AuthorityTransactionView,
  type DepartureContributionResult,
  type DepartureResponsibilityContributor,
} from "../room-governance/private-participant-contracts.js";

const FEATURE = "departure-responsibility" as const;

export type CanonicalDepartureSubjectKind =
  | "request" | "next_action" | "blocker" | "open_question" | "transfer" | "confirmation";
export type CanonicalDepartureResponsibilityRole =
  | "requester" | "target" | "owner" | "verifier" | "confirmer" | "transfer_target";

export type CanonicalDepartureResponsibility = Readonly<{
  roomId: string;
  subjectKind: CanonicalDepartureSubjectKind;
  subjectId: string;
  subjectRevision: number;
  responsibilityRole: CanonicalDepartureResponsibilityRole;
  responsibleActorId: string;
  state:
    | "pending_acceptance" | "proposed" | "accepted" | "in_progress" | "delivered"
    | "done" | "rejected" | "cancelled" | "open" | "resolved" | "deferred"
    | "cannot_answer" | "pending" | "expired";
  safeSummaryCode: string;
  sourceRef: ProjectSourceRef;
}>;

export interface CanonicalDepartureResponsibilityAuthorityPort {
  /** Must run on the caller's existing AuthorityWorker transaction/connection and perform no writes. */
  listCanonicalResponsibilitiesInTransaction(
    transaction: AuthorityTransactionView,
    input: Readonly<{ roomId: string; targetHumanActorId: string }>,
  ): unknown;
}

type UnknownRecord = Record<PropertyKey, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) =>
    typeof key === "string" && keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isCanonicalResponsibility(value: unknown): value is CanonicalDepartureResponsibility {
  return record(value) && exact(value, [
    "roomId", "subjectKind", "subjectId", "subjectRevision", "responsibilityRole",
    "responsibleActorId", "state", "safeSummaryCode", "sourceRef",
  ]) && identifier(value.roomId) &&
    (value.subjectKind === "request" || value.subjectKind === "next_action" ||
      value.subjectKind === "blocker" || value.subjectKind === "open_question" ||
      value.subjectKind === "transfer" || value.subjectKind === "confirmation") &&
    identifier(value.subjectId) && positive(value.subjectRevision) &&
    (value.responsibilityRole === "requester" || value.responsibilityRole === "target" ||
      value.responsibilityRole === "owner" || value.responsibilityRole === "verifier" ||
      value.responsibilityRole === "confirmer" || value.responsibilityRole === "transfer_target") &&
    identifier(value.responsibleActorId) &&
    (value.state === "pending_acceptance" || value.state === "proposed" || value.state === "accepted" ||
      value.state === "in_progress" || value.state === "delivered" || value.state === "done" ||
      value.state === "rejected" || value.state === "cancelled" || value.state === "open" ||
      value.state === "resolved" || value.state === "deferred" || value.state === "cannot_answer" ||
      value.state === "pending" || value.state === "expired") && identifier(value.safeSummaryCode) &&
    isProjectSourceRef(value.sourceRef) && value.sourceRef.roomId === value.roomId;
}

function isActive(value: CanonicalDepartureResponsibility): boolean {
  switch (value.subjectKind) {
    case "request":
      return value.state === "pending_acceptance" &&
        (value.responsibilityRole === "requester" || value.responsibilityRole === "target");
    case "next_action":
      return (value.responsibilityRole === "owner" &&
          (value.state === "proposed" || value.state === "accepted" || value.state === "in_progress")) ||
        (value.responsibilityRole === "verifier" && value.state === "delivered");
    case "blocker":
    case "open_question":
      return value.responsibilityRole === "owner" &&
        (value.state === "open" || value.state === "deferred" || value.state === "cannot_answer");
    case "transfer":
      return value.responsibilityRole === "transfer_target" && value.state === "pending";
    case "confirmation":
      return value.responsibilityRole === "confirmer" && value.state === "pending";
  }
}

function kind(value: CanonicalDepartureResponsibility): DepartureConflict["kind"] {
  switch (value.subjectKind) {
    case "request": return value.responsibilityRole === "target" ? "acceptance" : "request";
    case "next_action": return "next_action";
    case "blocker":
    case "open_question": return "blocker_or_open_question";
    case "transfer": return "acceptance";
    case "confirmation": return "confirmation";
  }
}

function resolutions(value: CanonicalDepartureResponsibility): readonly DepartureResolution[] {
  if (value.subjectKind === "confirmation") return Object.freeze(["reject_or_revoke"]);
  if (value.subjectKind === "request" || value.subjectKind === "transfer" || value.state === "proposed") {
    return Object.freeze(["transfer", "reject_or_revoke"]);
  }
  return Object.freeze(["complete", "transfer", "escalate"]);
}

function stableConflictId(value: CanonicalDepartureResponsibility): string {
  const digest = createHash("sha256").update([
    "departure-conflict-v1", value.roomId, value.responsibleActorId, value.subjectKind,
    value.subjectId, String(value.subjectRevision), value.responsibilityRole,
  ].join("\0"), "utf8").digest("hex");
  return `departure-conflict-v1-${digest}`;
}

function toConflict(value: CanonicalDepartureResponsibility): DepartureConflict {
  return Object.freeze({
    conflictId: stableConflictId(value),
    roomId: value.roomId,
    subjectId: value.subjectId,
    kind: kind(value),
    title: value.safeSummaryCode,
    state: value.state,
    allowedResolutions: resolutions(value),
    sourceId: value.sourceRef.sourceId,
    revision: value.subjectRevision,
  });
}

function failure(reason: "transaction_mismatch" | "malformed_result" | "cross_room_result" | "participant_threw"):
AuthorityParticipantEnvelope<DepartureContributionResult> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      httpStatus: 503 as const,
      code: "dependency_unavailable" as const,
      dependency: FEATURE,
      reason,
      retryable: true as const,
    }),
  });
}

export function createCanonicalDepartureResponsibilityContributor(options: Readonly<{
  authority: CanonicalDepartureResponsibilityAuthorityPort;
}>): DepartureResponsibilityContributor {
  return Object.freeze({
    listInTransaction(
      transaction: AuthorityTransactionView,
      input: Readonly<{ roomId: string; targetHumanActorId: string }>,
    ) {
      if (!isAuthorityTransactionView(transaction) || !record(input) ||
          !exact(input, ["roomId", "targetHumanActorId"]) || !identifier(input.roomId) ||
          !identifier(input.targetHumanActorId) || transaction.roomId !== input.roomId) {
        return failure("transaction_mismatch");
      }
      try {
        const candidate = options.authority.listCanonicalResponsibilitiesInTransaction(
          transaction,
          input,
        );
        if (!Array.isArray(candidate) || candidate.length > 4_096) return failure("malformed_result");
        const sourceKeys = new Set<string>();
        const conflicts: DepartureConflict[] = [];
        for (const raw of candidate) {
          if (!isCanonicalResponsibility(raw)) return failure("malformed_result");
          if (raw.roomId !== input.roomId) return failure("cross_room_result");
          if (raw.responsibleActorId !== input.targetHumanActorId) return failure("malformed_result");
          const sourceKey = `${raw.subjectKind}\0${raw.subjectId}\0${raw.subjectRevision}\0${raw.responsibilityRole}`;
          if (sourceKeys.has(sourceKey)) return failure("malformed_result");
          sourceKeys.add(sourceKey);
          if (!isActive(raw)) continue;
          const conflict = toConflict(raw);
          if (!isDepartureConflict(conflict)) return failure("malformed_result");
          conflicts.push(conflict);
        }
        conflicts.sort((left, right) => left.conflictId.localeCompare(right.conflictId));
        return Object.freeze({
          ok: true as const,
          result: Object.freeze({
            roomId: input.roomId,
            targetHumanActorId: input.targetHumanActorId,
            conflicts: Object.freeze(conflicts),
          }),
        });
      } catch {
        return failure("participant_threw");
      }
    },
  });
}
