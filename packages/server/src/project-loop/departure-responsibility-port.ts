import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DepartureConflict, DepartureResolution } from "@native-im/core";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import {
  AUTHORITY_PARTICIPANT_FEATURES,
  isAuthorityParticipantEnvelope,
  type AuthorityParticipantEnvelope,
  type AuthorityParticipantFailureReason,
  type AuthorityTransactionView,
  type DepartureContributionResult,
  type DepartureResponsibilityContributor,
  type FeatureEnablementManifest,
  type ParticipantRegistration,
} from "../room-governance/private-participant-contracts.js";
import {
  assertAuthorityParticipantRegistry,
  AuthorityParticipantUnavailableError,
  invokeAuthorityParticipant,
} from "../room-governance/private-participant-registry.js";

const FEATURE = "departure-responsibility" as const;
const PENDING_CONFIRMATION_FEATURE = "pending-confirmation-departure" as const;
const REGISTRATION_ID = "dao.project-loop.departure-responsibility.v1";
const PENDING_CONFIRMATION_REGISTRATION_ID =
  "dao.tool-safety.pending-confirmation-departure.v1";
const PROJECT_DEPARTURE_TABLES = Object.freeze([
  "project_requests",
  "project_next_actions",
  "project_obstacles",
  "project_transfer_proposals",
  "project_fact_proposals",
  "project_confirmations",
] as const);

export type DepartureResponsibilityComposition = Readonly<{
  readonly pendingConfirmation:
    | Readonly<{ readonly enabled: false }>
    | Readonly<{
      readonly enabled: true;
      readonly registrations: readonly unknown[];
    }>;
}>;

interface RequestRow {
  readonly id: unknown;
  readonly roomId: unknown;
  readonly sourceRoomId: unknown;
  readonly sourceId: unknown;
  readonly revision: unknown;
  readonly requesterHumanActorId: unknown;
  readonly targetHumanActorId: unknown;
  readonly status: unknown;
}

interface NextActionRow {
  readonly id: unknown;
  readonly roomId: unknown;
  readonly sourceRoomId: unknown;
  readonly sourceId: unknown;
  readonly revision: unknown;
  readonly ownerKind: unknown;
  readonly ownerActorId: unknown;
  readonly verifierHumanActorId: unknown;
  readonly status: unknown;
}

interface ObstacleRow {
  readonly id: unknown;
  readonly roomId: unknown;
  readonly sourceRoomId: unknown;
  readonly sourceId: unknown;
  readonly revision: unknown;
  readonly kind: unknown;
  readonly ownerKind: unknown;
  readonly ownerActorId: unknown;
  readonly status: unknown;
}

interface TransferProposalRow {
  readonly id: unknown;
  readonly roomId: unknown;
  readonly sourceRoomId: unknown;
  readonly sourceId: unknown;
  readonly revision: unknown;
  readonly subjectKind: unknown;
  readonly subjectId: unknown;
  readonly toOwnerKind: unknown;
  readonly toOwnerActorId: unknown;
  readonly principalHumanActorId: unknown;
  readonly status: unknown;
}

interface ProjectConfirmationRow {
  readonly id: unknown;
  readonly roomId: unknown;
  readonly sourceRoomId: unknown;
  readonly sourceId: unknown;
  readonly revision: unknown;
  readonly principalHumanActorId: unknown;
  readonly state: unknown;
}

class DepartureCollectionError extends Error {
  readonly reason: AuthorityParticipantFailureReason;

  constructor(reason: AuthorityParticipantFailureReason) {
    super(`Departure responsibility collection failed: ${reason}`);
    Object.defineProperty(this, "name", { value: "DepartureCollectionError" });
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) &&
    keys.every((key) => required.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeError(
  reason: AuthorityParticipantFailureReason,
): AuthorityParticipantEnvelope<DepartureContributionResult> {
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

function hasProjectDepartureSchema(database: DatabaseSync): boolean {
  const placeholders = PROJECT_DEPARTURE_TABLES.map(() => "?").join(", ");
  const rows = database.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name IN (${placeholders})`,
  ).all(...PROJECT_DEPARTURE_TABLES) as unknown as readonly Readonly<{ name: unknown }>[];
  const names = new Set(rows.map((row) => row.name));
  if (PROJECT_DEPARTURE_TABLES.every((table) => names.has(table))) return true;

  const version = database.prepare("PRAGMA user_version").get()?.user_version;
  if (typeof version !== "number") {
    throw new DepartureCollectionError("malformed_result");
  }
  if (version >= 23) {
    throw new DepartureCollectionError("malformed_result");
  }
  return false;
}

function scopedPendingConfirmationManifest(enabled: boolean): FeatureEnablementManifest {
  return Object.freeze(Object.fromEntries(
    AUTHORITY_PARTICIPANT_FEATURES.map((feature) => [
      feature,
      feature === PENDING_CONFIRMATION_FEATURE && enabled,
    ]),
  )) as FeatureEnablementManifest;
}

function unavailablePendingConfirmation(
  reason: AuthorityParticipantFailureReason,
): never {
  throw new AuthorityParticipantUnavailableError(PENDING_CONFIRMATION_FEATURE, reason);
}

function prepareComposition(
  composition: DepartureResponsibilityComposition,
): Readonly<{
  enabled: boolean;
  manifest: FeatureEnablementManifest;
  registrations: readonly unknown[];
}> {
  if (!isRecord(composition) || !hasExactKeys(composition, ["pendingConfirmation"]) ||
    !isRecord(composition.pendingConfirmation) ||
    typeof composition.pendingConfirmation.enabled !== "boolean") {
    unavailablePendingConfirmation("malformed_registration");
  }

  if (!composition.pendingConfirmation.enabled) {
    if (!hasExactKeys(composition.pendingConfirmation, ["enabled"])) {
      unavailablePendingConfirmation("manifest_mismatch");
    }
    return Object.freeze({
      enabled: false,
      manifest: scopedPendingConfirmationManifest(false),
      registrations: Object.freeze([]),
    });
  }

  if (!hasExactKeys(composition.pendingConfirmation, ["enabled", "registrations"]) ||
    !Array.isArray(composition.pendingConfirmation.registrations)) {
    unavailablePendingConfirmation("malformed_registration");
  }
  const registrations = Object.freeze([...composition.pendingConfirmation.registrations]);
  const manifest = scopedPendingConfirmationManifest(true);
  assertAuthorityParticipantRegistry(manifest, registrations);
  if (registrations.length !== 1 || !isRecord(registrations[0]) ||
    registrations[0].registrationId !== PENDING_CONFIRMATION_REGISTRATION_ID) {
    unavailablePendingConfirmation("malformed_registration");
  }
  return Object.freeze({ enabled: true, manifest, registrations });
}

function stableConflictId(input: Readonly<{
  roomId: string;
  targetHumanActorId: string;
  kind: DepartureConflict["kind"];
  subjectId: string;
  revision: number;
  responsibilityRole: string;
}>): string {
  const digest = createHash("sha256")
    .update("dao.departure-conflict.v1\0", "utf8")
    .update(input.roomId, "utf8")
    .update("\0", "utf8")
    .update(input.targetHumanActorId, "utf8")
    .update("\0", "utf8")
    .update(input.kind, "utf8")
    .update("\0", "utf8")
    .update(input.subjectId, "utf8")
    .update("\0", "utf8")
    .update(String(input.revision), "utf8")
    .update("\0", "utf8")
    .update(input.responsibilityRole, "utf8")
    .digest("hex");
  return `departure-conflict-v1-${digest}`;
}

function conflict(input: Readonly<{
  roomId: string;
  targetHumanActorId: string;
  subjectId: unknown;
  kind: DepartureConflict["kind"];
  title: string;
  state: string;
  allowedResolutions: readonly DepartureResolution[];
  sourceRoomId: unknown;
  sourceId: unknown;
  revision: unknown;
  responsibilityRole: string;
}>): DepartureConflict {
  if (!isNonEmptyString(input.subjectId) || !isNonEmptyString(input.sourceId) ||
    !isPositiveInteger(input.revision)) {
    throw new DepartureCollectionError("malformed_result");
  }
  if (input.sourceRoomId !== input.roomId) {
    throw new DepartureCollectionError("cross_room_result");
  }
  return Object.freeze({
    conflictId: stableConflictId({
      roomId: input.roomId,
      targetHumanActorId: input.targetHumanActorId,
      kind: input.kind,
      subjectId: input.subjectId,
      revision: input.revision,
      responsibilityRole: input.responsibilityRole,
    }),
    roomId: input.roomId,
    subjectId: input.subjectId,
    kind: input.kind,
    title: input.title,
    state: input.state,
    allowedResolutions: Object.freeze([...input.allowedResolutions]),
    sourceId: input.sourceId,
    revision: input.revision,
  });
}

function collectRequests(
  database: DatabaseSync,
  roomId: string,
  targetHumanActorId: string,
): readonly DepartureConflict[] {
  const rows = database.prepare(
    `SELECT id, room_id AS roomId, source_room_id AS sourceRoomId, source_id AS sourceId,
            revision, requester_human_actor_id AS requesterHumanActorId,
            target_human_actor_id AS targetHumanActorId, status
     FROM project_requests
     WHERE room_id = ? AND status = 'pending_acceptance'
       AND source_kind <> 'legacy_v14'
       AND (requester_human_actor_id = ? OR target_human_actor_id = ?)
     ORDER BY id`,
  ).all(roomId, targetHumanActorId, targetHumanActorId) as unknown as readonly RequestRow[];

  const conflicts: DepartureConflict[] = [];
  for (const row of rows) {
    if (row.roomId !== roomId || row.status !== "pending_acceptance" ||
      !isNonEmptyString(row.requesterHumanActorId) ||
      !isNonEmptyString(row.targetHumanActorId)) {
      throw new DepartureCollectionError(
        row.roomId !== roomId ? "cross_room_result" : "malformed_result",
      );
    }
    if (row.requesterHumanActorId === targetHumanActorId) {
      conflicts.push(conflict({
        roomId,
        targetHumanActorId,
        subjectId: row.id,
        kind: "request",
        title: "project.request.pending_acceptance.requester",
        state: "pending_request_coordination",
        allowedResolutions: ["transfer", "reject_or_revoke"],
        sourceRoomId: row.sourceRoomId,
        sourceId: row.sourceId,
        revision: row.revision,
        responsibilityRole: "requester",
      }));
    }
    if (row.targetHumanActorId === targetHumanActorId) {
      conflicts.push(conflict({
        roomId,
        targetHumanActorId,
        subjectId: row.id,
        kind: "acceptance",
        title: "project.request.pending_acceptance.target",
        state: "pending_acceptance",
        allowedResolutions: ["transfer", "reject_or_revoke"],
        sourceRoomId: row.sourceRoomId,
        sourceId: row.sourceId,
        revision: row.revision,
        responsibilityRole: "target",
      }));
    }
  }
  return conflicts;
}

function collectNextActions(
  database: DatabaseSync,
  roomId: string,
  targetHumanActorId: string,
): readonly DepartureConflict[] {
  const rows = database.prepare(
    `SELECT id, room_id AS roomId, source_room_id AS sourceRoomId, source_id AS sourceId,
            revision, owner_kind AS ownerKind, owner_actor_id AS ownerActorId,
            verifier_human_actor_id AS verifierHumanActorId, status
     FROM project_next_actions
     WHERE room_id = ?
       AND source_kind <> 'legacy_v14'
       AND (
         (owner_kind = 'human' AND owner_actor_id = ?
          AND status IN ('proposed', 'accepted', 'in_progress'))
         OR (verifier_human_actor_id = ?
             AND status IN ('proposed', 'accepted', 'in_progress', 'delivered'))
       )
     ORDER BY id`,
  ).all(roomId, targetHumanActorId, targetHumanActorId) as unknown as readonly NextActionRow[];

  const conflicts: DepartureConflict[] = [];
  for (const row of rows) {
    if (row.roomId !== roomId || !isNonEmptyString(row.ownerActorId) ||
      (row.ownerKind !== "human" && row.ownerKind !== "agent") ||
      (row.verifierHumanActorId !== null &&
        !isNonEmptyString(row.verifierHumanActorId))) {
      throw new DepartureCollectionError(
        row.roomId !== roomId ? "cross_room_result" : "malformed_result",
      );
    }
    if (row.ownerKind === "human" && row.ownerActorId === targetHumanActorId &&
      (row.status === "proposed" || row.status === "accepted" ||
        row.status === "in_progress")) {
      conflicts.push(conflict({
        roomId,
        targetHumanActorId,
        subjectId: row.id,
        kind: "next_action",
        title: "project.next_action.owner",
        state: row.status,
        allowedResolutions: row.status === "proposed"
          ? ["transfer", "reject_or_revoke"]
          : ["complete", "transfer", "escalate"],
        sourceRoomId: row.sourceRoomId,
        sourceId: row.sourceId,
        revision: row.revision,
        responsibilityRole: "owner",
      }));
    }
    if (row.verifierHumanActorId === targetHumanActorId &&
      (row.status === "proposed" || row.status === "accepted" ||
        row.status === "in_progress" || row.status === "delivered")) {
      conflicts.push(conflict({
        roomId,
        targetHumanActorId,
        subjectId: row.id,
        kind: "next_action",
        title: "project.next_action.pending_verification",
        state: row.status === "delivered" ? "pending_verification" : row.status,
        allowedResolutions: row.status === "delivered"
          ? ["complete", "transfer", "escalate"] : ["transfer", "escalate"],
        sourceRoomId: row.sourceRoomId,
        sourceId: row.sourceId,
        revision: row.revision,
        responsibilityRole: "verifier",
      }));
    }
  }
  return conflicts;
}

function collectObstacles(
  database: DatabaseSync,
  roomId: string,
  targetHumanActorId: string,
): readonly DepartureConflict[] {
  const rows = database.prepare(
    `SELECT id, room_id AS roomId, source_room_id AS sourceRoomId, source_id AS sourceId,
            revision, kind, owner_kind AS ownerKind, owner_actor_id AS ownerActorId, status
     FROM project_obstacles
     WHERE room_id = ? AND owner_kind = 'human' AND owner_actor_id = ?
       AND source_kind <> 'legacy_v14'
       AND status IN ('open', 'deferred', 'cannot_answer')
     ORDER BY kind, id`,
  ).all(roomId, targetHumanActorId) as unknown as readonly ObstacleRow[];

  return rows.map((row) => {
    if (row.roomId !== roomId || (row.kind !== "blocker" && row.kind !== "open_question") ||
      row.ownerKind !== "human" || row.ownerActorId !== targetHumanActorId ||
      (row.status !== "open" && row.status !== "deferred" &&
        row.status !== "cannot_answer")) {
      throw new DepartureCollectionError(
        row.roomId !== roomId ? "cross_room_result" : "malformed_result",
      );
    }
    return conflict({
      roomId,
      targetHumanActorId,
      subjectId: row.id,
      kind: "blocker_or_open_question",
      title: row.kind === "blocker"
        ? "project.blocker.owner"
        : "project.open_question.owner",
      state: row.status,
      allowedResolutions: ["complete", "transfer", "escalate"],
      sourceRoomId: row.sourceRoomId,
      sourceId: row.sourceId,
      revision: row.revision,
      responsibilityRole: "owner",
    });
  });
}

function collectTransferAcceptances(
  database: DatabaseSync,
  roomId: string,
  targetHumanActorId: string,
): readonly DepartureConflict[] {
  const rows = database.prepare(
    `SELECT id, room_id AS roomId, source_room_id AS sourceRoomId, source_id AS sourceId,
            revision, subject_kind AS subjectKind, subject_id AS subjectId,
            to_owner_kind AS toOwnerKind, to_owner_actor_id AS toOwnerActorId,
            principal_human_actor_id AS principalHumanActorId, status
     FROM project_transfer_proposals
     WHERE room_id = ? AND source_kind <> 'legacy_v14'
       AND ((to_owner_kind = 'human' AND to_owner_actor_id = ?)
            OR (to_owner_kind = 'agent' AND principal_human_actor_id = ?))
       AND status = 'pending'
     ORDER BY id`,
  ).all(roomId, targetHumanActorId, targetHumanActorId) as unknown as readonly TransferProposalRow[];

  return rows.map((row) => {
    if (row.roomId !== roomId ||
      (row.toOwnerKind !== "human" && row.toOwnerKind !== "agent") ||
      (row.toOwnerKind === "human" ? row.toOwnerActorId !== targetHumanActorId
        : row.principalHumanActorId !== targetHumanActorId) || row.status !== "pending" ||
      !isNonEmptyString(row.subjectId) ||
      (row.subjectKind !== "next_action" && row.subjectKind !== "blocker" &&
        row.subjectKind !== "open_question")) {
      throw new DepartureCollectionError(
        row.roomId !== roomId ? "cross_room_result" : "malformed_result",
      );
    }
    return conflict({
      roomId,
      targetHumanActorId,
      subjectId: row.id,
      kind: "acceptance",
      title: "project.transfer.pending_acceptance",
      state: "pending_transfer_acceptance",
      allowedResolutions: ["transfer", "reject_or_revoke"],
      sourceRoomId: row.sourceRoomId,
      sourceId: row.sourceId,
      revision: row.revision,
      responsibilityRole: `transfer_target:${row.subjectKind}`,
    });
  });
}

function collectProjectConfirmations(
  database: DatabaseSync,
  roomId: string,
  targetHumanActorId: string,
): readonly DepartureConflict[] {
  const rows = database.prepare(
    `SELECT confirmation.id, confirmation.room_id AS roomId,
            proposal.source_room_id AS sourceRoomId, proposal.source_id AS sourceId,
            confirmation.revision,
            confirmation.principal_human_actor_id AS principalHumanActorId,
            confirmation.state
     FROM project_confirmations AS confirmation
     JOIN project_fact_proposals AS proposal
       ON proposal.id = confirmation.proposal_id
      AND proposal.room_id = confirmation.room_id
     WHERE confirmation.room_id = ?
       AND confirmation.principal_human_actor_id = ?
       AND confirmation.state = 'pending'
     ORDER BY confirmation.id`,
  ).all(roomId, targetHumanActorId) as unknown as readonly ProjectConfirmationRow[];

  return rows.map((row) => {
    if (row.roomId !== roomId || row.principalHumanActorId !== targetHumanActorId ||
      row.state !== "pending") {
      throw new DepartureCollectionError(
        row.roomId !== roomId ? "cross_room_result" : "malformed_result",
      );
    }
    return conflict({
      roomId,
      targetHumanActorId,
      subjectId: row.id,
      kind: "confirmation",
      title: "project.confirmation.pending",
      state: "pending",
      allowedResolutions: ["reject_or_revoke"],
      sourceRoomId: row.sourceRoomId,
      sourceId: row.sourceId,
      revision: row.revision,
      responsibilityRole: "confirmer",
    });
  });
}

function cloneConflict(value: DepartureConflict): DepartureConflict {
  return Object.freeze({
    conflictId: value.conflictId,
    roomId: value.roomId,
    subjectId: value.subjectId,
    kind: value.kind,
    title: value.title,
    state: value.state,
    allowedResolutions: Object.freeze([...value.allowedResolutions]),
    sourceId: value.sourceId,
    revision: value.revision,
  });
}

function listInTransaction(
  composition: ReturnType<typeof prepareComposition>,
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; targetHumanActorId: string }>,
): AuthorityParticipantEnvelope<DepartureContributionResult> {
  if (!isNonEmptyString(input.roomId) || !isNonEmptyString(input.targetHumanActorId) ||
    transaction.roomId !== input.roomId) {
    return safeError("transaction_mismatch");
  }

  try {
    const conflicts = useAuthorityTransactionDatabase(transaction, (database) =>
      hasProjectDepartureSchema(database) ? [
        ...collectRequests(database, input.roomId, input.targetHumanActorId),
        ...collectNextActions(database, input.roomId, input.targetHumanActorId),
        ...collectObstacles(database, input.roomId, input.targetHumanActorId),
        ...collectTransferAcceptances(database, input.roomId, input.targetHumanActorId),
        ...collectProjectConfirmations(database, input.roomId, input.targetHumanActorId),
      ] : []);

    if (composition.enabled) {
      const pending = invokeAuthorityParticipant({
        feature: PENDING_CONFIRMATION_FEATURE,
        manifest: composition.manifest,
        registrations: composition.registrations,
        tx: transaction,
        roomId: input.roomId,
        invoke: (participant) => participant.listPendingConfirmationsInTransaction(
          transaction,
          input,
        ),
      });
      if (pending.targetHumanActorId !== input.targetHumanActorId) {
        throw new DepartureCollectionError("malformed_result");
      }
      conflicts.push(...pending.conflicts.map(cloneConflict));
    }

    conflicts.sort((left, right) => left.conflictId.localeCompare(right.conflictId));
    const envelope = Object.freeze({
      ok: true as const,
      result: Object.freeze({
        roomId: input.roomId,
        targetHumanActorId: input.targetHumanActorId,
        conflicts: Object.freeze(conflicts),
      }),
    });
    if (!isAuthorityParticipantEnvelope(FEATURE, envelope, input.roomId)) {
      return safeError("malformed_result");
    }
    return envelope;
  } catch (error: unknown) {
    if (error instanceof DepartureCollectionError) return safeError(error.reason);
    if (error instanceof AuthorityParticipantUnavailableError) {
      return safeError(error.safeError.reason);
    }
    if (error instanceof TypeError) return safeError("transaction_mismatch");
    return safeError("participant_threw");
  }
}

export function createDepartureResponsibilityRegistration(
  composition: DepartureResponsibilityComposition,
): ParticipantRegistration<DepartureResponsibilityContributor> {
  const preparedComposition = prepareComposition(composition);
  const participant: DepartureResponsibilityContributor = Object.freeze({
    listInTransaction: (
      transaction: AuthorityTransactionView,
      input: Readonly<{ roomId: string; targetHumanActorId: string }>,
    ) =>
      listInTransaction(preparedComposition, transaction, input),
  });
  return Object.freeze({
    registrationId: REGISTRATION_ID,
    feature: FEATURE,
    version: 1,
    enabled: true,
    participant,
  });
}
