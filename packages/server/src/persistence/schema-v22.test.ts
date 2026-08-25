import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V22_INVARIANT_STATEMENT_COUNT_FOR_TEST,
  AUTHORITY_V22_MIGRATION_CHECKSUM_FOR_TEST,
  AUTHORITY_V22_ROLLBACK_ASSERTION_COUNT_FOR_TEST,
  AUTHORITY_V22_STATEMENT_COUNT_FOR_TEST,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v22-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("authority SQLite v22 invocation runtime authority", () => {
  it("upgrades fresh and every immutable v1-v21 schema without rewriting history", () => {
    expect(AUTHORITY_SCHEMA_VERSION).toBe(25);
    for (let version = 1; version <= 21; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        const history = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(25);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations WHERE version <= ? ORDER BY version",
        ).all(version)).toEqual(history);
      });
    }
  }, 180_000);

  it("rolls every v22 statement back to the byte-equivalent v21 contract", () => {
    expect(AUTHORITY_V22_STATEMENT_COUNT_FOR_TEST).toBeGreaterThan(0);
    expect(AUTHORITY_V22_INVARIANT_STATEMENT_COUNT_FOR_TEST).toBeGreaterThan(0);
    expect(AUTHORITY_V22_ROLLBACK_ASSERTION_COUNT_FOR_TEST)
      .toBe(AUTHORITY_V22_STATEMENT_COUNT_FOR_TEST);
    expect(AUTHORITY_V22_MIGRATION_CHECKSUM_FOR_TEST).toMatch(/^[a-f0-9]{64}$/);
    for (let statement = 1; statement <= AUTHORITY_V22_STATEMENT_COUNT_FOR_TEST; statement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, 21);
        const tables = listAuthorityTables(database);
        const history = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        expect(() => migrateAuthorityDatabase(database, { failAfterStatement: statement }))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(21);
        expect(listAuthorityTables(database)).toEqual(tables);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(history);
      });
    }
  }, 180_000);

  it("keeps legacy broad-preemption history separate from scoped cancellation", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      expect(listAuthorityTables(database)).toEqual(expect.arrayContaining([
        "human_preemption_fences",
        "agent_human_fences",
        "legacy_room_wide_preemption_markers",
        "invocation_scoped_cancellation_fences",
      ]));
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM invocation_scoped_cancellation_fences",
      ).get()).toEqual({ count: 0 });
    });
  });

  it("exposes queued legacy executions only through accepted canonical state", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 21);
      database.exec(`
        INSERT INTO actors (id, kind, display_name, tool_permissions_json)
        VALUES ('human-v22', 'human', 'Human', '[]'),
               ('agent-v22', 'agent', 'Agent', '[]');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'human-v22', 0, 1), ('identity', 'agent-v22', 0, 1),
               ('room', 'room-v22', 0, 1);
        INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
        VALUES ('room-v22', 'Room', 'active', CURRENT_TIMESTAMP, 'human-v22');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES
          ('room-v22', 'human-v22', 'human', 'owner', NULL, '[]', CURRENT_TIMESTAMP, NULL, 1),
          ('room-v22', 'agent-v22', 'agent', NULL, 'on-mention', '[]', NULL, CURRENT_TIMESTAMP, 1);
        INSERT INTO agent_profiles (
          id, actor_id, revision, status, capability_ceiling_json,
          tool_ceiling_json, display_name, global_responsibility,
          created_at, updated_at, source_kind
        ) VALUES (
          'profile-v22', 'agent-v22', 1, 'enabled', '[]', '[]', 'Agent',
          'Legacy runtime fixture', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'legacy_v20_migration'
        );
        INSERT INTO agent_profile_revisions (
          profile_id, revision, actor_id, display_name, global_responsibility,
          status, capability_ceiling_json, tool_ceiling_json, changed_at, operation
        ) VALUES (
          'profile-v22', 1, 'agent-v22', 'Agent', 'Legacy runtime fixture',
          'enabled', '[]', '[]', CURRENT_TIMESTAMP, 'legacy_migration'
        );
        INSERT INTO room_agent_assignments (
          id, room_id, profile_id, agent_actor_id, revision, status,
          participation, paused, capability_subset_json, tool_subset_json,
          room_responsibility, created_at, updated_at, source_kind
        ) VALUES (
          'assignment-v22', 'room-v22', 'profile-v22', 'agent-v22', 1, 'current',
          'on-mention', 0, '[]', '[]', 'Legacy runtime fixture',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'legacy_v20_migration'
        );
        INSERT INTO room_agent_assignment_revisions (
          assignment_id, revision, room_id, profile_id, agent_actor_id,
          room_responsibility, status, participation, paused,
          capability_subset_json, tool_subset_json, changed_at, operation
        ) VALUES (
          'assignment-v22', 1, 'room-v22', 'profile-v22', 'agent-v22',
          'Legacy runtime fixture', 'current', 'on-mention', 0, '[]', '[]',
          CURRENT_TIMESTAMP, 'legacy_migration'
        );
        INSERT INTO tenant_administrator_registry
        VALUES (1, 1, '${"0".repeat(64)}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        INSERT INTO tenant_administrators (
          human_actor_id, revision, status, source_kind,
          created_at, updated_at
        ) VALUES ('human-v22', 1, 'active', 'bootstrap', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        INSERT INTO tenant_administrator_revisions (
          human_actor_id, revision, status, operation, changed_at
        ) VALUES ('human-v22', 1, 'active', 'bootstrap', CURRENT_TIMESTAMP);
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('message-v22', 'room-v22', 'human-v22', 'human', 'invoke', CURRENT_TIMESTAMP);
        INSERT INTO message_revisions
        VALUES ('message-v22', 1, 'invoke', CURRENT_TIMESTAMP, 'human-v22');
        INSERT INTO message_envelopes (
          message_id, room_id, message_kind, lifecycle, current_revision,
          revision_count, created_at
        ) VALUES ('message-v22', 'room-v22', 'human', 'active', 1, 1, CURRENT_TIMESTAMP);
        INSERT INTO agent_executions (
          id, room_id, agent_id, trigger_message_id, status, started_at,
          action_category, tool_dispatch_phase, current_attempt_seq, retry_cycle,
          retry_ordinal, recovery_cursor, queued_at, updated_at, execution_generation
        ) VALUES (
          'execution-v22', 'room-v22', 'agent-v22', 'message-v22', 'queued',
          CURRENT_TIMESTAMP, 'model_generation', NULL, 1, 1, 1, 0,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1
        );
        INSERT INTO agent_invocation_intents (
          id, room_id, source_message_id, target_agent_id, requester_actor_id,
          intent_kind, execution_id, created_at, source_revision, lineage_id,
          turn_id, origin_kind, status, claimed_at
        ) VALUES (
          'intent-v22', 'room-v22', 'message-v22', 'agent-v22', 'human-v22',
          'direct_mention', 'execution-v22', CURRENT_TIMESTAMP, 1, 'lineage-v22',
          'legacy', 'legacy_runtime', 'claimed', CURRENT_TIMESTAMP
        );
        INSERT INTO agent_execution_intent_links
        VALUES ('intent-v22', 'execution-v22', 1, NULL, 1, CURRENT_TIMESTAMP);
        INSERT INTO agent_execution_attempts (
          execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
          action_category, recovery_cursor
        ) VALUES ('execution-v22', 1, 1, 1, 'queued', 'model_generation', 0);
      `);
      migrateAuthorityDatabase(database);
      expect(database.prepare(
        `SELECT public_status AS publicStatus, phase
         FROM agent_execution_runtime_states WHERE execution_id = 'execution-v22'`,
      ).get()).toEqual({ publicStatus: "accepted", phase: "queued" });
    });
  });
});
