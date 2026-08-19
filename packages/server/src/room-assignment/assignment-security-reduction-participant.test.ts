import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  mintAuthorityTransactionView,
  type AuthorityTransactionView,
} from "../room-governance/private-participant-contracts.js";
import {
  assignmentSecurityReductionParticipantRegistration,
  createAssignmentSecurityReductionParticipant,
  requireAssignmentExpansionAllowedInTransaction,
  requireAssignmentSecurityReductionAllowedInTransaction,
} from "./assignment-security-reduction-participant.js";

const directories: string[] = [];
const now = "2026-08-19T01:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openDatabase(path?: string): DatabaseSync {
  const resolvedPath = path ?? (() => {
    const directory = mkdtempSync(join(tmpdir(), "dao-room-assignment-"));
    directories.push(directory);
    return join(directory, "authority.sqlite");
  })();
  const database = new DatabaseSync(resolvedPath);
  migrateAuthorityDatabase(database);
  database.exec(`
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id),
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
      capability_ceiling_json TEXT NOT NULL
        CHECK (json_valid(capability_ceiling_json) AND json_type(capability_ceiling_json) = 'array'),
      tool_ceiling_json TEXT NOT NULL
        CHECK (json_valid(tool_ceiling_json) AND json_type(tool_ceiling_json) = 'array')
    ) STRICT;
    CREATE TABLE room_agent_assignments (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
      agent_actor_id TEXT NOT NULL REFERENCES actors(id),
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN ('current', 'removed')),
      participation TEXT NOT NULL CHECK (participation IN ('active', 'on-mention')),
      capability_subset_json TEXT NOT NULL
        CHECK (json_valid(capability_subset_json) AND json_type(capability_subset_json) = 'array'),
      tool_subset_json TEXT NOT NULL
        CHECK (json_valid(tool_subset_json) AND json_type(tool_subset_json) = 'array'),
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      UNIQUE (room_id, agent_actor_id)
    ) STRICT;
    CREATE TABLE room_assignment_archive_policies (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
      policy_version INTEGER NOT NULL CHECK (policy_version > 0),
      assignment_revision INTEGER NOT NULL CHECK (assignment_revision >= 0),
      expansion_blocked INTEGER NOT NULL CHECK (expansion_blocked = 1),
      reduced_at TEXT NOT NULL,
      PRIMARY KEY (room_id, archive_generation),
      UNIQUE (room_id, policy_version)
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, readiness, tool_permissions_json)
    VALUES
      ('human-owner', 'human', 'Owner', NULL, '[]'),
      ('agent-1', 'agent', 'Agent One', 'ready', '["repository.git-status","sandbox-file.write"]');
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-1', 'Room One', 'active', '2026-08-19T00:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at
    ) VALUES
      ('room-1', 'human-owner', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL),
      ('room-1', 'agent-1', 'agent', NULL, 'active', '["repository.git-status"]',
       NULL, '2026-08-19T00:00:00.000Z');
    UPDATE rooms
    SET owner_actor_id = 'human-owner', governance_revision = 1
    WHERE id = 'room-1';
    INSERT INTO agent_profiles (
      id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json
    ) VALUES (
      'profile-1', 'agent-1', 4, 'enabled', '["project.read","route.participate"]',
      '["repository.git-status","sandbox-file.write"]'
    );
    INSERT INTO room_agent_assignments (
      id, room_id, profile_id, agent_actor_id, revision, status, participation,
      capability_subset_json, tool_subset_json, paused
    ) VALUES (
      'assignment-1', 'room-1', 'profile-1', 'agent-1', 7, 'current', 'active',
      '["project.read"]', '["repository.git-status"]', 0
    );
  `);
  return database;
}

function archive(database: DatabaseSync, generation = 3): void {
  database.prepare(
    `UPDATE rooms
     SET status = 'archived', archive_generation = ?, archived_at = ?, governance_revision = governance_revision + 1
     WHERE id = 'room-1'`,
  ).run(generation, now);
}

function withTransaction<TResult>(
  database: DatabaseSync,
  operation: (transaction: AuthorityTransactionView) => TResult,
): TResult {
  database.exec("BEGIN IMMEDIATE");
  const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-assignment");
  try {
    const result = operation(transaction);
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    releaseDatabaseAuthorityTransactionView(transaction);
  }
}

describe("AssignmentSecurityReductionParticipant production provider", () => {
  it("uses the exact enabled production registration", () => {
    expect(assignmentSecurityReductionParticipantRegistration).toEqual({
      registrationId: "dao.room-assignment.security-reduction.v1",
      feature: "assignment-security-reduction",
      version: 1,
      enabled: true,
      participant: expect.objectContaining({ reduceForArchive: expect.any(Function) }),
    });
    expect(Object.keys(assignmentSecurityReductionParticipantRegistration.participant ?? {}))
      .toEqual(["reduceForArchive"]);
  });

  it("records a real Profile/Assignment revision and durable generation without business wake-up", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-assignment-reduction-"));
    directories.push(directory);
    const path = join(directory, "authority.sqlite");
    const database = openDatabase(path);
    const observer = new DatabaseSync(path);
    try {
      archive(database);
      database.exec("BEGIN IMMEDIATE");
      const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-live");
      const envelope = createAssignmentSecurityReductionParticipant().reduceForArchive(transaction, {
        roomId: "room-1",
        archiveGeneration: 3,
        now,
      });
      expect(envelope).toEqual({
        ok: true,
        result: {
          roomId: "room-1",
          archiveGeneration: 3,
          policyVersion: 1,
          assignmentRevision: 7,
          businessWakeUpCount: 0,
        },
      });
      expect(database.prepare(
        `SELECT policy_version AS policyVersion, assignment_revision AS assignmentRevision,
                expansion_blocked AS expansionBlocked
         FROM room_assignment_archive_policies`,
      ).get()).toEqual({ policyVersion: 1, assignmentRevision: 7, expansionBlocked: 1 });
      expect(observer.prepare(
        "SELECT COUNT(*) AS count FROM room_assignment_archive_policies",
      ).get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM route_jobs").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_executions").get()).toEqual({ count: 0 });
      releaseDatabaseAuthorityTransactionView(transaction);
      database.exec("COMMIT");
      expect(observer.prepare(
        "SELECT COUNT(*) AS count FROM room_assignment_archive_policies",
      ).get()).toEqual({ count: 1 });
    } finally {
      observer.close();
      database.close();
    }
  });

  it("is idempotent across rollback and restart and keeps expansion closed while allowing reduction", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-assignment-restart-"));
    directories.push(directory);
    const path = join(directory, "authority.sqlite");
    let database = openDatabase(path);
    archive(database, 5);

    database.exec("BEGIN IMMEDIATE");
    const rolledBack = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-rollback");
    const first = createAssignmentSecurityReductionParticipant().reduceForArchive(rolledBack, {
      roomId: "room-1", archiveGeneration: 5, now,
    });
    expect(first.ok).toBe(true);
    releaseDatabaseAuthorityTransactionView(rolledBack);
    database.exec("ROLLBACK");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_assignment_archive_policies",
    ).get()).toEqual({ count: 0 });

    const committed = withTransaction(database, (transaction) =>
      createAssignmentSecurityReductionParticipant().reduceForArchive(transaction, {
        roomId: "room-1", archiveGeneration: 5, now,
      }));
    expect(committed.ok && committed.result).toEqual(expect.objectContaining({
      policyVersion: 1,
      assignmentRevision: 7,
      businessWakeUpCount: 0,
    }));
    database.close();

    database = new DatabaseSync(path);
    const replay = withTransaction(database, (transaction) =>
      createAssignmentSecurityReductionParticipant().reduceForArchive(transaction, {
        roomId: "room-1", archiveGeneration: 5, now: "2026-08-19T02:00:00.000Z",
      }));
    expect(replay).toEqual(committed);
    withTransaction(database, (transaction) => {
      expect(requireAssignmentExpansionAllowedInTransaction(transaction, {
        roomId: "room-1", expectedArchiveGeneration: 5,
      })).toBe(false);
      expect(requireAssignmentSecurityReductionAllowedInTransaction(transaction, {
        roomId: "room-1", expectedArchiveGeneration: 5,
      })).toEqual({ roomId: "room-1", archiveGeneration: 5, assignmentRevision: 7 });
    });
    database.prepare(
      `UPDATE room_agent_assignments
       SET tool_subset_json = '[]', revision = revision + 1
       WHERE id = 'assignment-1'`,
    ).run();
    expect(database.prepare(
      `SELECT tool_subset_json AS tools, revision
       FROM room_agent_assignments WHERE id = 'assignment-1'`,
    ).get()).toEqual({ tools: "[]", revision: 8 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM route_jobs").get()).toEqual({ count: 0 });
    database.close();
  });

  it("fails closed for invalid capabilities, cross-room input, corrupt authority, and missing schema", () => {
    const database = openDatabase();
    try {
      archive(database);
      const unbound = mintAuthorityTransactionView("room-1", "unbound");
      expect(createAssignmentSecurityReductionParticipant().reduceForArchive(unbound, {
        roomId: "room-1", archiveGeneration: 3, now,
      })).toEqual(expect.objectContaining({ ok: false }));
      expect(createAssignmentSecurityReductionParticipant().reduceForArchive(
        { roomId: "room-1", transactionId: "forged" } as never,
        { roomId: "room-1", archiveGeneration: 3, now },
      )).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ reason: "transaction_mismatch" }),
      }));

      withTransaction(database, (transaction) => {
        expect(createAssignmentSecurityReductionParticipant().reduceForArchive(transaction, {
          roomId: "room-other", archiveGeneration: 3, now,
        })).toEqual(expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ reason: "transaction_mismatch" }),
        }));
        expect(createAssignmentSecurityReductionParticipant().reduceForArchive(transaction, {
          roomId: "room-1", archiveGeneration: 3, now, extra: true,
        } as never)).toEqual(expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ reason: "transaction_mismatch" }),
        }));
      });

      database.prepare(
        `UPDATE room_agent_assignments
         SET capability_subset_json = '["project.read","admin.escalate"]'
         WHERE id = 'assignment-1'`,
      ).run();
      const corrupt = withTransaction(database, (transaction) =>
        createAssignmentSecurityReductionParticipant().reduceForArchive(transaction, {
          roomId: "room-1", archiveGeneration: 3, now,
        }));
      expect(corrupt).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ reason: "participant_threw" }),
      }));
    } finally {
      database.close();
    }

    const missing = new DatabaseSync(":memory:");
    missing.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, archive_generation INTEGER NOT NULL,
        archived_at TEXT
      ) STRICT;
      INSERT INTO rooms VALUES ('room-1', 'archived', 1, '${now}');
    `);
    try {
      const result = withTransaction(missing, (transaction) =>
        createAssignmentSecurityReductionParticipant().reduceForArchive(transaction, {
          roomId: "room-1", archiveGeneration: 1, now,
        }));
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ reason: "participant_threw" }),
      }));
    } finally {
      missing.close();
    }
  });
});
