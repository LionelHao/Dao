import type { DatabaseSync } from "node:sqlite";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import { useAuthorityTransactionDatabase } from
  "../persistence/authority-transaction-database.js";
import type { AuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import type {
  AssignmentParticipation,
  CurrentAssignmentPolicyFacts,
} from "./assignment-policy.js";

export interface SqliteProfileAuthority {
  readonly profileId: string;
  readonly actorId: string;
  readonly revision: number;
  readonly status: "enabled" | "disabled";
  readonly capabilityCeiling: readonly string[];
  readonly toolCeiling: readonly string[];
}

export interface SqliteAssignmentRecord extends CurrentAssignmentPolicyFacts {
  readonly assignmentId: string;
  readonly roomId: string;
  readonly profileId: string;
  readonly actorId: string;
  readonly status: "current" | "removed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly removedAt?: string;
}

export interface SqliteRoomAuthority {
  readonly roomId: string;
  readonly status: "active" | "archived";
  readonly governanceRevision: number;
  readonly archiveGeneration: number;
  readonly role: "owner" | "admin" | "member";
}

export interface AssignmentIdempotencyReceipt {
  readonly requestHash: string;
  readonly responseJson: string;
  readonly statusCode: number;
}

export interface AssignmentRuntimeAuthorityRow {
  readonly assignment: SqliteAssignmentRecord;
  readonly profileRevision: number;
  readonly profileEnabled: boolean;
  readonly roomActive: boolean;
  readonly accessRevision: number;
  readonly accessValid: boolean;
  readonly runningExecutionCount: number;
}

export interface RoomAssignmentRepository {
  authenticate(context: AuthenticatedSessionContext, now: number): boolean;
  readRoomAuthority(actorId: string, roomId: string): SqliteRoomAuthority | undefined;
  readProfile(profileId: string): SqliteProfileAuthority | undefined;
  readAssignment(roomId: string, assignmentId: string): SqliteAssignmentRecord | undefined;
  readCurrentAssignmentForActor(roomId: string, actorId: string): SqliteAssignmentRecord | undefined;
  listAssignments(roomId: string): readonly SqliteAssignmentRecord[];
  readReceipt(scope: string, key: string): AssignmentIdempotencyReceipt | undefined;
  insertReceipt(input: Readonly<{
    scope: string;
    key: string;
    requestHash: string;
    responseJson: string;
    statusCode: number;
    createdAt: string;
    expiresAt: string;
  }>): void;
  insertAssignment(input: Readonly<{
    assignmentId: string;
    roomId: string;
    profile: SqliteProfileAuthority;
    roomResponsibility: string;
    participation: AssignmentParticipation;
    capabilitySubset: readonly string[];
    toolSubset: readonly string[];
    changedBy: string;
    changedAt: string;
  }>): SqliteAssignmentRecord;
  updateAssignment(input: Readonly<{
    assignment: SqliteAssignmentRecord;
    operation: "update" | "pause" | "resume" | "remove";
    roomResponsibility: string;
    participation: AssignmentParticipation;
    paused: boolean;
    status: "current" | "removed";
    capabilitySubset: readonly string[];
    toolSubset: readonly string[];
    changedBy: string;
    changedAt: string;
  }>): SqliteAssignmentRecord;
  advanceRoomRevision(roomId: string, expectedRevision: number): number;
  insertAudit(input: Readonly<{
    auditId: string;
    roomId: string;
    actorId: string;
    assignmentId: string;
    assignmentActorId: string;
    assignmentRevision: number;
    profileRevision: number;
    operation: "create" | "update" | "pause" | "resume" | "remove";
    occurredAt: string;
  }>): void;
  readRuntimeAuthority(roomId: string, assignmentId: string): AssignmentRuntimeAuthorityRow | undefined;
}

type UnknownRow = Record<string, unknown>;

const capabilities = new Set([
  "room.conversation.read", "room.memory.read", "room.project.read", "room.respond",
]);
const tools = new Set([
  "http-json.read", "repository.git-status", "room-memory.read", "sandbox-file.write",
]);

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}

function canonicalSet(value: unknown, allowed: ReadonlySet<string>): readonly string[] {
  if (!text(value)) throw new Error("Agent authority set is unavailable");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry, index) =>
    typeof entry === "string" && allowed.has(entry) &&
    (index === 0 || (parsed[index - 1] as string) < entry))) {
    throw new Error("Agent authority set is corrupt");
  }
  return Object.freeze(parsed);
}

function assignment(row: UnknownRow | undefined): SqliteAssignmentRecord | undefined {
  if (row === undefined) return undefined;
  if (!text(row.assignmentId) || !text(row.roomId) || !text(row.profileId) ||
      !text(row.actorId) || row.profileActorId !== row.actorId || row.actorKind !== "agent" ||
      !positive(row.revision) ||
      (row.status !== "current" && row.status !== "removed") ||
      (row.participation !== "active" && row.participation !== "on-mention") ||
      (row.paused !== 0 && row.paused !== 1) || !text(row.roomResponsibility) ||
      row.roomResponsibility.length > 4_000 || !text(row.createdAt) || !text(row.updatedAt) ||
      (row.status === "removed" ? !text(row.removedAt) : row.removedAt !== null)) {
    throw new Error("Room Assignment is corrupt");
  }
  return Object.freeze({
    assignmentId: row.assignmentId,
    roomId: row.roomId,
    profileId: row.profileId,
    actorId: row.actorId,
    revision: row.revision,
    status: row.status,
    participation: row.participation,
    paused: row.paused === 1,
    roomResponsibility: row.roomResponsibility,
    capabilitySubset: canonicalSet(row.capabilitySubsetJson, capabilities),
    toolSubset: canonicalSet(row.toolSubsetJson, tools),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.status === "removed" ? { removedAt: row.removedAt as string } : {}),
  });
}

const assignmentSelect = `
  SELECT assignment.id AS assignmentId, assignment.room_id AS roomId,
         assignment.profile_id AS profileId, assignment.agent_actor_id AS actorId,
         assignment.revision, assignment.status, assignment.participation, assignment.paused,
         assignment.room_responsibility AS roomResponsibility,
         assignment.capability_subset_json AS capabilitySubsetJson,
         assignment.tool_subset_json AS toolSubsetJson, assignment.created_at AS createdAt,
         assignment.updated_at AS updatedAt, assignment.removed_at AS removedAt,
         profile.actor_id AS profileActorId, actor.kind AS actorKind
  FROM room_agent_assignments AS assignment
  JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
  JOIN actors AS actor ON actor.id = assignment.agent_actor_id`;

function createRepository(database: DatabaseSync): RoomAssignmentRepository {
  const repository: RoomAssignmentRepository = {
    authenticate(context, now) {
      if (!Number.isSafeInteger(now) || now < 0) return false;
      const row = database.prepare(
        `SELECT 1 AS valid
         FROM sessions AS session
         JOIN session_families AS family ON family.family_id = session.family_id
         JOIN actors AS actor ON actor.id = session.actor_id
         WHERE session.access_token_hash = ? AND session.family_id = ?
           AND session.account_id = ? AND session.actor_id = ? AND actor.kind = 'human'
           AND session.revoked_at IS NULL AND session.access_expires_at > ?
           AND family.account_id = session.account_id AND family.actor_id = session.actor_id
           AND family.revoked_at IS NULL AND family.refresh_expires_at > ?`,
      ).get(
        context.sessionId,
        context.sessionFamilyId,
        context.principal.accountId,
        context.principal.actorId,
        now,
        now,
      ) as UnknownRow | undefined;
      return row?.valid === 1;
    },
    readRoomAuthority(actorId, roomId) {
      const row = database.prepare(
        `SELECT room.id AS roomId, room.status,
                room.governance_revision AS governanceRevision,
                room.archive_generation AS archiveGeneration,
                CASE WHEN room.owner_actor_id = membership.actor_id THEN 'owner'
                     ELSE membership.role END AS role
         FROM rooms AS room
         JOIN room_memberships AS membership
           ON membership.room_id = room.id AND membership.actor_id = ?
         JOIN actors AS actor ON actor.id = membership.actor_id
         WHERE room.id = ? AND membership.kind = 'human' AND actor.kind = 'human'`,
      ).get(actorId, roomId) as UnknownRow | undefined;
      if (row === undefined) return undefined;
      if (row.roomId !== roomId || (row.status !== "active" && row.status !== "archived") ||
          !nonnegative(row.governanceRevision) || !nonnegative(row.archiveGeneration) ||
          (row.role !== "owner" && row.role !== "admin" && row.role !== "member")) {
        throw new Error("Room Assignment ACL authority is corrupt");
      }
      return Object.freeze({
        roomId,
        status: row.status,
        governanceRevision: row.governanceRevision,
        archiveGeneration: row.archiveGeneration,
        role: row.role,
      });
    },
    readProfile(profileId) {
      const row = database.prepare(
        `SELECT profile.id AS profileId, profile.actor_id AS actorId,
                actor.kind AS actorKind, profile.revision, profile.status,
                capability_ceiling_json AS capabilityCeilingJson,
                tool_ceiling_json AS toolCeilingJson
         FROM agent_profiles AS profile
         JOIN actors AS actor ON actor.id = profile.actor_id
         WHERE profile.id = ?`,
      ).get(profileId) as UnknownRow | undefined;
      if (row === undefined) return undefined;
      if (row.profileId !== profileId || !text(row.actorId) || row.actorKind !== "agent" ||
          !positive(row.revision) ||
          (row.status !== "enabled" && row.status !== "disabled")) {
        throw new Error("Agent Profile authority is corrupt");
      }
      return Object.freeze({
        profileId,
        actorId: row.actorId,
        revision: row.revision,
        status: row.status,
        capabilityCeiling: canonicalSet(row.capabilityCeilingJson, capabilities),
        toolCeiling: canonicalSet(row.toolCeilingJson, tools),
      });
    },
    readAssignment(roomId, assignmentId) {
      return assignment(database.prepare(
        `${assignmentSelect} WHERE assignment.room_id = ? AND assignment.id = ?`,
      ).get(roomId, assignmentId) as UnknownRow | undefined);
    },
    readCurrentAssignmentForActor(roomId, actorId) {
      return assignment(database.prepare(
        `${assignmentSelect} WHERE assignment.room_id = ?
         AND assignment.agent_actor_id = ? AND assignment.status = 'current'`,
      ).get(roomId, actorId) as UnknownRow | undefined);
    },
    listAssignments(roomId) {
      return Object.freeze((database.prepare(
        `${assignmentSelect} WHERE assignment.room_id = ?
         AND assignment.status = 'current' ORDER BY assignment.id`,
      ).all(roomId) as unknown as UnknownRow[]).map((row) => assignment(row)!));
    },
    readReceipt(scope, key) {
      const row = database.prepare(
        `SELECT request_hash AS requestHash, response_json AS responseJson,
                status_code AS statusCode
         FROM idempotency_records WHERE scope = ? AND key = ?`,
      ).get(scope, key) as UnknownRow | undefined;
      if (row === undefined) return undefined;
      if (!text(row.requestHash) || !text(row.responseJson) || !nonnegative(row.statusCode)) {
        throw new Error("Room Assignment idempotency receipt is corrupt");
      }
      return Object.freeze({
        requestHash: row.requestHash,
        responseJson: row.responseJson,
        statusCode: row.statusCode,
      });
    },
    insertReceipt(input) {
      database.prepare(
        `INSERT INTO idempotency_records (
           scope, key, request_hash, response_json, status_code, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.scope, input.key, input.requestHash, input.responseJson, input.statusCode,
        input.createdAt, input.expiresAt,
      );
    },
    insertAssignment(input) {
      database.prepare(
        `INSERT INTO room_agent_assignments (
           id, room_id, profile_id, agent_actor_id, revision, status, participation,
           paused, capability_subset_json, tool_subset_json, room_responsibility,
           created_at, updated_at, removed_at, source_kind
         ) VALUES (?, ?, ?, ?, 1, 'current', ?, 0, ?, ?, ?, ?, ?, NULL, 'room_command')`,
      ).run(
        input.assignmentId, input.roomId, input.profile.profileId, input.profile.actorId,
        input.participation, JSON.stringify(input.capabilitySubset),
        JSON.stringify(input.toolSubset), input.roomResponsibility, input.changedAt, input.changedAt,
      );
      database.prepare(
        `INSERT INTO room_agent_assignment_revisions (
           assignment_id, revision, room_id, profile_id, agent_actor_id,
           room_responsibility, status, participation, paused, capability_subset_json,
           tool_subset_json, changed_by_human_actor_id, changed_at, operation
         ) VALUES (?, 1, ?, ?, ?, ?, 'current', ?, 0, ?, ?, ?, ?, 'create')`,
      ).run(
        input.assignmentId, input.roomId, input.profile.profileId, input.profile.actorId,
        input.roomResponsibility, input.participation, JSON.stringify(input.capabilitySubset),
        JSON.stringify(input.toolSubset), input.changedBy, input.changedAt,
      );
      return repository.readAssignment(input.roomId, input.assignmentId)!;
    },
    updateAssignment(input) {
      const revision = input.assignment.revision + 1;
      const removedAt = input.status === "removed" ? input.changedAt : null;
      const result = database.prepare(
        `UPDATE room_agent_assignments
         SET revision = ?, status = ?, participation = ?, paused = ?,
             capability_subset_json = ?, tool_subset_json = ?, room_responsibility = ?,
             updated_at = ?, removed_at = ?, source_kind = 'room_command'
         WHERE id = ? AND room_id = ? AND revision = ? AND status = 'current'`,
      ).run(
        revision, input.status, input.participation, input.paused ? 1 : 0,
        JSON.stringify(input.capabilitySubset), JSON.stringify(input.toolSubset),
        input.roomResponsibility, input.changedAt, removedAt, input.assignment.assignmentId,
        input.assignment.roomId, input.assignment.revision,
      );
      if (result.changes !== 1) throw new Error("Room Assignment CAS changed concurrently");
      database.prepare(
        `INSERT INTO room_agent_assignment_revisions (
           assignment_id, revision, room_id, profile_id, agent_actor_id,
           room_responsibility, status, participation, paused, capability_subset_json,
           tool_subset_json, changed_by_human_actor_id, changed_at, operation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.assignment.assignmentId, revision, input.assignment.roomId,
        input.assignment.profileId, input.assignment.actorId, input.roomResponsibility,
        input.status, input.participation, input.paused ? 1 : 0,
        JSON.stringify(input.capabilitySubset), JSON.stringify(input.toolSubset),
        input.changedBy, input.changedAt, input.operation,
      );
      return repository.readAssignment(input.assignment.roomId, input.assignment.assignmentId)!;
    },
    advanceRoomRevision(roomId, expectedRevision) {
      const result = database.prepare(
        `UPDATE rooms SET governance_revision = governance_revision + 1
         WHERE id = ? AND governance_revision = ?`,
      ).run(roomId, expectedRevision);
      if (result.changes !== 1) throw new Error("Room governance CAS changed concurrently");
      return expectedRevision + 1;
    },
    insertAudit(input) {
      database.prepare(
        `INSERT INTO room_audit (
           id, type, room_id, actor_id, result, timestamp, details_json
         ) VALUES (?, 'room.agent.configured', ?, ?, 'configured', ?, ?)`,
      ).run(
        input.auditId, input.roomId, input.actorId, input.occurredAt,
        JSON.stringify({
          assignmentId: input.assignmentId,
          actorId: input.assignmentActorId,
          assignmentRevision: input.assignmentRevision,
          profileRevision: input.profileRevision,
          operation: input.operation,
        }),
      );
    },
    readRuntimeAuthority(roomId, assignmentId) {
      const row = database.prepare(
        `SELECT profile.revision AS profileRevision, profile.status AS profileStatus,
                room.status AS roomStatus, membership.access_revision AS accessRevision,
                CASE WHEN membership.kind = 'agent' THEN 1 ELSE 0 END AS accessValid,
                (SELECT COUNT(*) FROM agent_executions AS execution
                 WHERE execution.room_id = assignment.room_id
                   AND execution.agent_id = assignment.agent_actor_id
                   AND execution.status = 'running') AS runningExecutionCount
         FROM room_agent_assignments AS assignment
         JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
         JOIN rooms AS room ON room.id = assignment.room_id
         LEFT JOIN room_memberships AS membership
           ON membership.room_id = assignment.room_id
          AND membership.actor_id = assignment.agent_actor_id
         WHERE assignment.room_id = ? AND assignment.id = ?`,
      ).get(roomId, assignmentId) as UnknownRow | undefined;
      const current = repository.readAssignment(roomId, assignmentId);
      if (row === undefined || current === undefined) return undefined;
      if (!positive(row.profileRevision) ||
          (row.profileStatus !== "enabled" && row.profileStatus !== "disabled") ||
          (row.roomStatus !== "active" && row.roomStatus !== "archived") ||
          !nonnegative(row.accessRevision) || (row.accessValid !== 0 && row.accessValid !== 1) ||
          !nonnegative(row.runningExecutionCount)) {
        throw new Error("Room Assignment runtime authority is corrupt");
      }
      return Object.freeze({
        assignment: current,
        profileRevision: row.profileRevision,
        profileEnabled: row.profileStatus === "enabled",
        roomActive: row.roomStatus === "active",
        accessRevision: row.accessRevision,
        accessValid: row.accessValid === 1,
        runningExecutionCount: row.runningExecutionCount,
      });
    },
  };
  return Object.freeze(repository);
}

export function withSqliteRoomAssignmentRepository<TResult>(
  transaction: AuthorityTransactionView,
  operation: (repository: RoomAssignmentRepository) => TResult,
): TResult {
  return useAuthorityTransactionDatabase(transaction, (database) =>
    operation(createRepository(database)));
}
