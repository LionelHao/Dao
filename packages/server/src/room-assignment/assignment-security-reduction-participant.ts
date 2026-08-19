import type { DatabaseSync } from "node:sqlite";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import {
  isAuthorityTransactionView,
  type AssignmentSecurityReductionParticipant,
  type AssignmentSecurityReductionResult,
  type AuthorityParticipantEnvelope,
  type AuthorityParticipantFailureReason,
  type AuthorityTransactionView,
  type ParticipantRegistration,
} from "../room-governance/private-participant-contracts.js";

const FEATURE = "assignment-security-reduction" as const;
const REGISTRATION_ID = "dao.room-assignment.security-reduction.v1";
const MAX_ASSIGNMENTS_PER_ROOM = 1_024;

interface RoomRow {
  readonly status: unknown;
  readonly archiveGeneration: unknown;
  readonly archivedAt: unknown;
}

interface AssignmentAuthorityRow {
  readonly assignmentId: unknown;
  readonly roomId: unknown;
  readonly agentActorId: unknown;
  readonly actorKind: unknown;
  readonly assignmentRevision: unknown;
  readonly assignmentStatus: unknown;
  readonly participation: unknown;
  readonly paused: unknown;
  readonly capabilitySubsetJson: unknown;
  readonly toolSubsetJson: unknown;
  readonly profileId: unknown;
  readonly profileActorId: unknown;
  readonly profileRevision: unknown;
  readonly profileStatus: unknown;
  readonly capabilityCeilingJson: unknown;
  readonly toolCeilingJson: unknown;
}

interface PolicyRow {
  readonly policyVersion: unknown;
  readonly assignmentRevision: unknown;
  readonly expansionBlocked: unknown;
  readonly reducedAt: unknown;
}

export interface AssignmentSecurityReductionPermit {
  readonly roomId: string;
  readonly archiveGeneration: number;
  readonly assignmentRevision: number;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTime(value: unknown): value is string {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isReductionInput(value: unknown): value is Readonly<{
  roomId: string;
  archiveGeneration: number;
  now: string;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !exactKeys(value, ["roomId", "archiveGeneration", "now"])) return false;
  const input = value as Record<string, unknown>;
  return nonEmpty(input.roomId) && positiveInteger(input.archiveGeneration) &&
    validTime(input.now);
}

function fail(
  reason: AuthorityParticipantFailureReason,
): AuthorityParticipantEnvelope<AssignmentSecurityReductionResult> {
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

function parseCanonicalStringSet(value: unknown): readonly string[] {
  if (!nonEmpty(value)) throw new Error("Assignment authority set is unavailable");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(nonEmpty) ||
      new Set(parsed).size !== parsed.length ||
      parsed.some((entry, index) => index > 0 && parsed[index - 1]!.localeCompare(entry) >= 0)) {
    throw new Error("Assignment authority set is non-canonical");
  }
  return parsed;
}

function isSubset(subset: readonly string[], ceiling: readonly string[]): boolean {
  const allowed = new Set(ceiling);
  return subset.every((entry) => allowed.has(entry));
}

function readRoom(
  database: DatabaseSync,
  roomId: string,
): RoomRow {
  const room = database.prepare(
    `SELECT status, archive_generation AS archiveGeneration, archived_at AS archivedAt
     FROM rooms WHERE id = ?`,
  ).get(roomId) as RoomRow | undefined;
  if (room === undefined || (room.status !== "active" && room.status !== "archived") ||
      !nonNegativeInteger(room.archiveGeneration) ||
      (room.status === "archived" && !validTime(room.archivedAt)) ||
      (room.status === "active" && room.archivedAt !== null)) {
    throw new Error("Room assignment lifecycle authority is unavailable");
  }
  return room;
}

function currentAssignmentRevision(database: DatabaseSync, roomId: string): number {
  const rows = database.prepare(
    `SELECT assignment.id AS assignmentId,
            assignment.room_id AS roomId,
            assignment.agent_actor_id AS agentActorId,
            actor.kind AS actorKind,
            assignment.revision AS assignmentRevision,
            assignment.status AS assignmentStatus,
            assignment.participation,
            assignment.paused,
            assignment.capability_subset_json AS capabilitySubsetJson,
            assignment.tool_subset_json AS toolSubsetJson,
            profile.id AS profileId,
            profile.actor_id AS profileActorId,
            profile.revision AS profileRevision,
            profile.status AS profileStatus,
            profile.capability_ceiling_json AS capabilityCeilingJson,
            profile.tool_ceiling_json AS toolCeilingJson
     FROM room_agent_assignments AS assignment
     JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
     JOIN actors AS actor ON actor.id = assignment.agent_actor_id
     WHERE assignment.room_id = ? AND assignment.status = 'current'
     ORDER BY assignment.id
     LIMIT ?`,
  ).all(roomId, MAX_ASSIGNMENTS_PER_ROOM + 1) as unknown as readonly AssignmentAuthorityRow[];
  if (rows.length > MAX_ASSIGNMENTS_PER_ROOM) {
    throw new Error("Room assignment authority exceeded its bound");
  }

  let revision = 0;
  for (const row of rows) {
    if (!nonEmpty(row.assignmentId) || row.roomId !== roomId ||
        !nonEmpty(row.agentActorId) || row.actorKind !== "agent" ||
        !positiveInteger(row.assignmentRevision) || row.assignmentStatus !== "current" ||
        (row.participation !== "active" && row.participation !== "on-mention") ||
        (row.paused !== 0 && row.paused !== 1) || !nonEmpty(row.profileId) ||
        row.profileActorId !== row.agentActorId || !positiveInteger(row.profileRevision) ||
        (row.profileStatus !== "enabled" && row.profileStatus !== "disabled")) {
      throw new Error("Room assignment authority is corrupt");
    }
    const capabilitySubset = parseCanonicalStringSet(row.capabilitySubsetJson);
    const toolSubset = parseCanonicalStringSet(row.toolSubsetJson);
    const capabilityCeiling = parseCanonicalStringSet(row.capabilityCeilingJson);
    const toolCeiling = parseCanonicalStringSet(row.toolCeilingJson);
    if (!isSubset(capabilitySubset, capabilityCeiling) || !isSubset(toolSubset, toolCeiling)) {
      throw new Error("Room assignment exceeds its Global Profile authority");
    }
    revision = Math.max(revision, row.assignmentRevision);
  }
  return revision;
}

function readPolicy(
  database: DatabaseSync,
  roomId: string,
  archiveGeneration: number,
): PolicyRow | undefined {
  const row = database.prepare(
    `SELECT policy_version AS policyVersion,
            assignment_revision AS assignmentRevision,
            expansion_blocked AS expansionBlocked,
            reduced_at AS reducedAt
     FROM room_assignment_archive_policies
     WHERE room_id = ? AND archive_generation = ?`,
  ).get(roomId, archiveGeneration) as PolicyRow | undefined;
  if (row !== undefined && (!positiveInteger(row.policyVersion) ||
      !nonNegativeInteger(row.assignmentRevision) || row.expansionBlocked !== 1 ||
      !validTime(row.reducedAt))) {
    throw new Error("Room assignment archive policy is corrupt");
  }
  return row;
}

function reduceDatabase(
  database: DatabaseSync,
  input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
): AssignmentSecurityReductionResult {
  const room = readRoom(database, input.roomId);
  if (room.status !== "archived" || room.archiveGeneration !== input.archiveGeneration ||
      !validTime(input.now)) {
    throw new Error("Room assignment archive generation is stale");
  }

  const assignmentRevision = currentAssignmentRevision(database, input.roomId);
  const previous = readPolicy(database, input.roomId, input.archiveGeneration);
  if (previous !== undefined) {
    return Object.freeze({
      roomId: input.roomId,
      archiveGeneration: input.archiveGeneration,
      policyVersion: previous.policyVersion as number,
      assignmentRevision: previous.assignmentRevision as number,
      businessWakeUpCount: 0 as const,
    });
  }

  const latest = database.prepare(
    `SELECT COALESCE(MAX(policy_version), 0) AS policyVersion
     FROM room_assignment_archive_policies WHERE room_id = ?`,
  ).get(input.roomId)?.policyVersion;
  if (!nonNegativeInteger(latest) || latest >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Room assignment policy version is unavailable");
  }
  const policyVersion = latest + 1;
  database.prepare(
    `INSERT INTO room_assignment_archive_policies (
       room_id, archive_generation, policy_version, assignment_revision,
       expansion_blocked, reduced_at
     ) VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(
    input.roomId,
    input.archiveGeneration,
    policyVersion,
    assignmentRevision,
    input.now,
  );
  return Object.freeze({
    roomId: input.roomId,
    archiveGeneration: input.archiveGeneration,
    policyVersion,
    assignmentRevision,
    businessWakeUpCount: 0 as const,
  });
}

export function createAssignmentSecurityReductionParticipant(): AssignmentSecurityReductionParticipant {
  return Object.freeze({
    reduceForArchive(
      transaction: AuthorityTransactionView,
      input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
    ) {
      if (!isReductionInput(input) || !isAuthorityTransactionView(transaction) ||
          input.roomId !== transaction.roomId) {
        return fail("transaction_mismatch");
      }
      try {
        const result = useAuthorityTransactionDatabase(
          transaction,
          (database) => reduceDatabase(database, input),
        );
        return Object.freeze({ ok: true as const, result });
      } catch {
        return fail("participant_threw");
      }
    },
  });
}

export function requireAssignmentExpansionAllowedInTransaction(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; expectedArchiveGeneration: number }>,
): boolean {
  if (!isAuthorityTransactionView(transaction) || !nonEmpty(input.roomId) ||
      input.roomId !== transaction.roomId ||
      !nonNegativeInteger(input.expectedArchiveGeneration)) {
    throw new TypeError("Assignment expansion gate input is invalid");
  }
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const room = readRoom(database, input.roomId);
    currentAssignmentRevision(database, input.roomId);
    if (room.archiveGeneration !== input.expectedArchiveGeneration) return false;
    if (room.status !== "active") {
      const policy = readPolicy(database, input.roomId, room.archiveGeneration as number);
      if (policy === undefined) throw new Error("Assignment archive policy is unavailable");
      return false;
    }
    return true;
  });
}

export function requireAssignmentSecurityReductionAllowedInTransaction(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; expectedArchiveGeneration: number }>,
): AssignmentSecurityReductionPermit {
  if (!isAuthorityTransactionView(transaction) || !nonEmpty(input.roomId) ||
      input.roomId !== transaction.roomId ||
      !nonNegativeInteger(input.expectedArchiveGeneration)) {
    throw new TypeError("Assignment security reduction gate input is invalid");
  }
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const room = readRoom(database, input.roomId);
    if (room.archiveGeneration !== input.expectedArchiveGeneration) {
      throw new Error("Assignment security reduction generation is stale");
    }
    const assignmentRevision = currentAssignmentRevision(database, input.roomId);
    if (room.status === "archived" &&
        readPolicy(database, input.roomId, input.expectedArchiveGeneration) === undefined) {
      throw new Error("Assignment archive policy is unavailable");
    }
    return Object.freeze({
      roomId: input.roomId,
      archiveGeneration: input.expectedArchiveGeneration,
      assignmentRevision,
    });
  });
}

const productionAssignmentSecurityReductionParticipant =
  createAssignmentSecurityReductionParticipant();

export const assignmentSecurityReductionParticipantRegistration:
  ParticipantRegistration<AssignmentSecurityReductionParticipant> = Object.freeze({
    registrationId: REGISTRATION_ID,
    feature: FEATURE,
    version: 1,
    enabled: true,
    participant: productionAssignmentSecurityReductionParticipant,
  });
