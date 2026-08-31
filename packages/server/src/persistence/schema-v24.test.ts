import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V24_MIGRATION_CHECKSUM_FOR_TEST,
  AUTHORITY_V24_ROLLBACK_ASSERTION_COUNT_FOR_TEST,
  AUTHORITY_V24_STATEMENT_COUNT_FOR_TEST,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

const NOW = "2026-08-25T00:00:00.000Z";
const HASH = "a".repeat(64);
const CHECKPOINT_HASH = "b".repeat(64);

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v24-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedProjectBoundaryAuthority(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json) VALUES
      ('human-v24', 'human', 'Human', '[]'),
      ('agent-v24', 'agent', 'Agent', '[]'),
      ('agent-spoof-v24', 'agent', 'Spoof', '[]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
      ('identity', 'human-v24', 0, 1), ('identity', 'agent-v24', 0, 1),
      ('identity', 'agent-spoof-v24', 0, 1), ('room', 'room-v24', 0, 1),
      ('room', 'other-v24', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id) VALUES
      ('room-v24', 'Room', 'active', '${NOW}', 'human-v24'),
      ('other-v24', 'Other', 'active', '${NOW}', 'human-v24');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-v24', 'human-v24', 'human', 'owner', NULL, '[]', '${NOW}', NULL, 1),
      ('room-v24', 'agent-v24', 'agent', NULL, 'active', '[]', NULL, '${NOW}', 7),
      ('room-v24', 'agent-spoof-v24', 'agent', NULL, 'active', '[]', NULL, '${NOW}', 7);
    INSERT INTO agent_profiles (
      id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json,
      display_name, global_responsibility, created_at, updated_at, source_kind
    ) VALUES (
      'profile-v24', 'agent-v24', 3, 'enabled',
      '["room.project.read","room.respond"]', '[]', 'Agent', 'Project delivery',
      '${NOW}', '${NOW}', 'legacy_v20_migration'
    );
    INSERT INTO agent_profile_revisions (
      profile_id, revision, actor_id, display_name, global_responsibility, status,
      capability_ceiling_json, tool_ceiling_json, changed_at, operation
    ) VALUES (
      'profile-v24', 3, 'agent-v24', 'Agent', 'Project delivery', 'enabled',
      '["room.project.read","room.respond"]', '[]', '${NOW}', 'legacy_migration'
    );
    INSERT INTO room_agent_assignments (
      id, room_id, profile_id, agent_actor_id, revision, status, participation,
      paused, capability_subset_json, tool_subset_json, room_responsibility,
      created_at, updated_at, source_kind
    ) VALUES (
      'assignment-v24', 'room-v24', 'profile-v24', 'agent-v24', 5, 'current',
      'active', 0, '["room.project.read","room.respond"]', '[]',
      'Deliver the current Project responsibility', '${NOW}', '${NOW}', 'legacy_v20_migration'
    );
    INSERT INTO room_agent_assignment_revisions (
      assignment_id, revision, room_id, profile_id, agent_actor_id,
      room_responsibility, status, participation, paused,
      capability_subset_json, tool_subset_json, changed_at, operation
    ) VALUES (
      'assignment-v24', 5, 'room-v24', 'profile-v24', 'agent-v24',
      'Deliver the current Project responsibility', 'current', 'active', 0,
      '["room.project.read","room.respond"]', '[]', '${NOW}', 'legacy_migration'
    );
    INSERT INTO project_ball_boundaries (
      boundary_id, room_id, project_id, source_kind, source_id, source_revision,
      lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at,
      status, released_at
    ) VALUES (
      'boundary-v24', 'room-v24', 'room-v24', 'next_action', 'action-v24', 4,
      0, 'agent', 'agent-v24', 'Agent owns the current Project action', '${NOW}',
      '${NOW}', 'active', NULL
    );
    INSERT INTO project_agent_boundary_claims (
      boundary_id, source_revision, room_id, holder_agent_actor_id,
      request_sha256, status, attempted_at, consumed_at
    ) VALUES (
      'boundary-v24', 4, 'room-v24', 'agent-v24', '${HASH}', 'claimed', '${NOW}', NULL
    );
    INSERT INTO project_fact_checkpoints (
      checkpoint_id, room_id, project_id, project_revision, projection_json,
      projection_sha256, created_at
    ) VALUES (
      'checkpoint-v24', 'room-v24', 'room-v24', 9,
      '{"recordVersion":"project-loop.v1"}', '${CHECKPOINT_HASH}', '${NOW}'
    );
  `);
}

function insertIntent(database: DatabaseSync, overrides: Readonly<{
  intentId?: string;
  roomId?: string;
  projectId?: string;
  boundaryId?: string;
  sourceRevision?: number;
  lifecycleGeneration?: number;
  targetAgentActorId?: string;
  profileRevision?: number;
  assignmentRevision?: number;
  accessRevision?: number;
  requestSha256?: string;
}> = {}): void {
  database.prepare(
    `INSERT INTO project_boundary_agent_invocation_intents (
       intent_id, room_id, project_id, boundary_id, boundary_kind, source_kind,
       source_id, source_revision, lifecycle_generation, target_agent_actor_id,
       profile_id, profile_revision, assignment_id, assignment_revision,
       access_revision, lineage_id, turn_id, request_sha256, status,
       authority_version, created_at, claimed_at, cancelled_at,
       cancellation_reason, updated_at
     ) VALUES (?, ?, ?, ?, 'agent_ball', 'next_action', 'action-v24', ?, ?, ?,
               'profile-v24', ?, 'assignment-v24', ?, ?, 'lineage-v24',
               'turn-v24', ?, 'pending', 1, ?, NULL, NULL, NULL, ?)`,
  ).run(
    overrides.intentId ?? "intent-v24",
    overrides.roomId ?? "room-v24",
    overrides.projectId ?? "room-v24",
    overrides.boundaryId ?? "boundary-v24",
    overrides.sourceRevision ?? 4,
    overrides.lifecycleGeneration ?? 0,
    overrides.targetAgentActorId ?? "agent-v24",
    overrides.profileRevision ?? 3,
    overrides.assignmentRevision ?? 5,
    overrides.accessRevision ?? 7,
    overrides.requestSha256 ?? HASH,
    NOW,
    NOW,
  );
}

describe("authority SQLite v24 Project boundary Agent intent lineage", () => {
  it("adds a message-independent durable Project boundary intent lineage", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_SCHEMA_VERSION).toBe(27);
      expect(readSchemaVersion(database)).toBe(27);
      expect(listAuthorityTables(database)).toEqual(expect.arrayContaining([
        "project_boundary_agent_invocation_intents",
        "project_boundary_agent_executions",
        "project_boundary_agent_execution_links",
        "project_boundary_context_sources",
      ]));
    });
  });

  it("upgrades every immutable v1-v23 contract without changing its migration history", () => {
    expect(AUTHORITY_SCHEMA_VERSION).toBe(27);
    for (let version = 1; version <= 23; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        const history = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(27);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations WHERE version <= ? ORDER BY version",
        ).all(version)).toEqual(history);
      });
    }
  }, 180_000);

  it("rolls each v24 statement back to the byte-equivalent v23 contract", () => {
    expect(AUTHORITY_V24_STATEMENT_COUNT_FOR_TEST).toBeGreaterThan(0);
    expect(AUTHORITY_V24_ROLLBACK_ASSERTION_COUNT_FOR_TEST)
      .toBe(AUTHORITY_V24_STATEMENT_COUNT_FOR_TEST);
    expect(AUTHORITY_V24_MIGRATION_CHECKSUM_FOR_TEST).toMatch(/^[a-f0-9]{64}$/);
    for (let statement = 1; statement <= AUTHORITY_V24_STATEMENT_COUNT_FOR_TEST; statement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, 23);
        const physical = database.prepare(
          `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        ).all();
        const history = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        expect(() => migrateAuthorityDatabase(database, { failAfterStatement: statement }))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(23);
        expect(database.prepare(
          `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        ).all()).toEqual(physical);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(history);
      });
    }
  }, 180_000);

  it("freezes exact boundary, source, lifecycle and Agent authority without a synthetic message", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedProjectBoundaryAuthority(database);
      expect(database.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
      expect(() => insertIntent(database, {
        intentId: "intent-stale-source", sourceRevision: 5,
      })).toThrow();
      expect(() => insertIntent(database, {
        intentId: "intent-stale-lifecycle", lifecycleGeneration: 1,
      })).toThrow();
      expect(() => insertIntent(database, {
        intentId: "intent-spoofed-agent", targetAgentActorId: "agent-spoof-v24",
      })).toThrow();
      expect(() => insertIntent(database, {
        intentId: "intent-stale-profile", profileRevision: 2,
      })).toThrow();
      expect(() => insertIntent(database, {
        intentId: "intent-stale-assignment", assignmentRevision: 4,
      })).toThrow();
      expect(() => insertIntent(database, {
        intentId: "intent-stale-access", accessRevision: 6,
      })).toThrow();
      expect(() => insertIntent(database, {
        intentId: "intent-bad-hash", requestSha256: "A".repeat(64),
      })).toThrow();
      insertIntent(database);
      expect(database.prepare(
        `SELECT boundary_id AS boundaryId, source_revision AS sourceRevision,
                lifecycle_generation AS lifecycleGeneration,
                profile_revision AS profileRevision,
                assignment_revision AS assignmentRevision,
                access_revision AS accessRevision, status, authority_version AS authorityVersion
         FROM project_boundary_agent_invocation_intents`,
      ).get()).toEqual({
        boundaryId: "boundary-v24",
        sourceRevision: 4,
        lifecycleGeneration: 0,
        profileRevision: 3,
        assignmentRevision: 5,
        accessRevision: 7,
        status: "pending",
        authorityVersion: 1,
      });
    });
  });

  it("enforces the closed intent state machine and immutable frozen authority", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedProjectBoundaryAuthority(database);
      insertIntent(database);
      expect(() => database.prepare(
        `UPDATE project_boundary_agent_invocation_intents
         SET status = 'claimed', claimed_at = ?, authority_version = 3, updated_at = ?
         WHERE intent_id = 'intent-v24'`,
      ).run(NOW, NOW)).toThrow(/transition is invalid/i);
      database.prepare(
        `UPDATE project_boundary_agent_invocation_intents
         SET status = 'claimed', claimed_at = ?, authority_version = 2, updated_at = ?
         WHERE intent_id = 'intent-v24'`,
      ).run(NOW, NOW);
      expect(() => database.prepare(
        `UPDATE project_boundary_agent_invocation_intents
         SET source_revision = 5, status = 'cancelled', cancelled_at = ?,
             cancellation_reason = 'source_ineligible', authority_version = 3, updated_at = ?
         WHERE intent_id = 'intent-v24'`,
      ).run(NOW, NOW)).toThrow(/transition is invalid/i);
      database.prepare(
        `UPDATE project_boundary_agent_invocation_intents
         SET status = 'cancelled', cancelled_at = ?,
             cancellation_reason = 'boundary_resolved', authority_version = 3, updated_at = ?
         WHERE intent_id = 'intent-v24'`,
      ).run(NOW, NOW);
      expect(() => database.prepare(
        `UPDATE project_boundary_agent_invocation_intents
         SET authority_version = 4, updated_at = ? WHERE intent_id = 'intent-v24'`,
      ).run(NOW)).toThrow(/transition is invalid/i);
      expect(() => database.prepare(
        "DELETE FROM project_boundary_agent_invocation_intents WHERE intent_id = 'intent-v24'",
      ).run()).toThrow(/immutable/i);
    });
  });

  it("binds a five-state Project execution and exact checkpoint context without a message FK", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedProjectBoundaryAuthority(database);
      insertIntent(database);
      database.prepare(
        `UPDATE project_boundary_agent_invocation_intents
         SET status = 'claimed', claimed_at = ?, authority_version = 2, updated_at = ?
         WHERE intent_id = 'intent-v24'`,
      ).run(NOW, NOW);
      database.prepare(
        `INSERT INTO project_boundary_agent_executions (
           execution_id, intent_id, lineage_id, execution_ordinal, retry_of_execution_id,
           room_id, project_id, agent_actor_id, source_revision, lifecycle_generation,
           provider_id, model_id, public_status, phase, current_attempt_seq,
           authority_version, queued_at, started_at, updated_at, completed_at,
           cancellation_reason, terminal_error_code, result_message_id
         ) VALUES (
           'execution-v24', 'intent-v24', 'lineage-v24', 1, NULL,
           'room-v24', 'room-v24', 'agent-v24', 4, 0, 'provider-v24', 'model-v24',
           'accepted', 'queued', 1, 1, ?, NULL, ?, NULL, NULL, NULL, NULL
         )`,
      ).run(NOW, NOW);
      database.prepare(
        `INSERT INTO project_boundary_agent_execution_links (
           intent_id, execution_id, execution_ordinal, retry_of_execution_id,
           source_revision, lifecycle_generation, linked_at
         ) VALUES ('intent-v24', 'execution-v24', 1, NULL, 4, 0, ?)`,
      ).run(NOW);
      database.prepare(
        `INSERT INTO project_boundary_context_sources (
           context_source_id, intent_id, execution_id, execution_ordinal,
           room_id, project_id, checkpoint_id, checkpoint_project_revision,
           checkpoint_projection_sha256, source_kind, source_id, source_revision,
           lifecycle_generation, created_at
         ) VALUES (
           'context-source-v24', 'intent-v24', 'execution-v24', 1,
           'room-v24', 'room-v24', 'checkpoint-v24', 9, ?, 'next_action',
           'action-v24', 4, 0, ?
         )`,
      ).run(CHECKPOINT_HASH, NOW);
      expect(database.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
      expect(() => database.prepare(
        "UPDATE project_boundary_context_sources SET source_revision = 5",
      ).run()).toThrow(/immutable/i);
      database.prepare(
        `UPDATE project_boundary_agent_executions
         SET public_status = 'running', phase = 'model_generation', started_at = ?,
             authority_version = 2, updated_at = ? WHERE execution_id = 'execution-v24'`,
      ).run(NOW, NOW);
      database.prepare(
        `UPDATE project_boundary_agent_executions
         SET public_status = 'completed', phase = 'completed', completed_at = ?,
             authority_version = 3, updated_at = ? WHERE execution_id = 'execution-v24'`,
      ).run(NOW, NOW);
      expect(database.prepare(
        `SELECT public_status AS status, phase, authority_version AS authorityVersion
         FROM project_boundary_agent_executions WHERE execution_id = 'execution-v24'`,
      ).get()).toEqual({ status: "completed", phase: "completed", authorityVersion: 3 });
      expect(() => database.prepare(
        `UPDATE project_boundary_agent_executions
         SET authority_version = 4, updated_at = ? WHERE execution_id = 'execution-v24'`,
      ).run(NOW)).toThrow(/transition is invalid/i);
    });
  });

  it("keeps fresh and v23-upgraded physical contracts equivalent and reopens under WAL", () => {
    let freshSql: unknown[] = [];
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      freshSql = database.prepare(
        `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      ).all();
    });
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 23);
      migrateAuthorityDatabase(database);
      expect(database.prepare(
        `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      ).all()).toEqual(freshSql);
    });

    const directory = mkdtempSync(join(tmpdir(), "dao-authority-v24-wal-"));
    const path = join(directory, "authority.sqlite");
    try {
      let database = new DatabaseSync(path);
      database.exec("PRAGMA journal_mode = WAL");
      migrateAuthorityDatabase(database);
      database.close();
      database = new DatabaseSync(path);
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      migrateAuthorityDatabase(database);
      expect(readSchemaVersion(database)).toBe(27);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
