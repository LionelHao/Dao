import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V21_INVARIANT_STATEMENT_COUNT_FOR_TEST,
  AUTHORITY_V21_MIGRATION_CHECKSUM_FOR_TEST,
  AUTHORITY_V21_ROLLBACK_ASSERTION_COUNT_FOR_TEST,
  AUTHORITY_V21_STATEMENT_COUNT_FOR_TEST,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

const NOW = "2026-08-24T12:00:00.000Z";

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v21-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedAuthority(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json)
    VALUES ('human-v21', 'human', 'Human', '[]'),
           ('agent-v21', 'agent', 'Agent before rename', '[]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'human-v21', 0, 1), ('identity', 'agent-v21', 0, 1),
           ('room', 'room-v21', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES ('room-v21', 'Room', 'active', '${NOW}', 'human-v21');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-v21', 'human-v21', 'human', 'owner', NULL, '[]', '${NOW}', NULL, 1),
      ('room-v21', 'agent-v21', 'agent', NULL, 'on-mention', '[]', NULL, '${NOW}', 7);
  `);
}

function seedStructuredDirectIntent(database: DatabaseSync): {
  readonly profileId: string;
  readonly assignmentId: string;
} {
  const profile = database.prepare(
    "SELECT id FROM agent_profiles WHERE actor_id = 'agent-v21'",
  ).get();
  const assignment = database.prepare(
    `SELECT id FROM room_agent_assignments
     WHERE room_id = 'room-v21' AND agent_actor_id = 'agent-v21' AND status = 'current'`,
  ).get();
  if (typeof profile?.id !== "string" || typeof assignment?.id !== "string") {
    throw new Error("v21 fixture authority was not migrated");
  }
  database.exec(`BEGIN IMMEDIATE;
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES ('message-v21', 'room-v21', 'human-v21', 'human', '@Agent', '${NOW}');
    INSERT INTO message_revisions (
      message_id, revision, body, revised_at, revised_by_actor_id
    ) VALUES ('message-v21', 1, '@Agent', '${NOW}', 'human-v21');
    INSERT INTO message_envelopes (
      message_id, room_id, message_kind, lifecycle, current_revision,
      revision_count, created_at, recalled_at, recalled_by_actor_id
    ) VALUES ('message-v21', 'room-v21', 'human', 'active', 1, 1, '${NOW}', NULL, NULL);
    INSERT INTO message_mentions (
      message_id, room_id, target_id, target_kind, target_actor_id,
      range_start_utf16, range_end_utf16, target_order
    ) VALUES ('message-v21', 'room-v21', 'target-v21', 'agent-invocation',
              'agent-v21', 0, 6, 0);
    INSERT INTO agent_invocation_intents (
      id, room_id, source_message_id, target_agent_id, requester_actor_id,
      intent_kind, execution_id, created_at, message_transaction_id, target_id,
      source_revision, lineage_id, turn_id, origin_kind, status, claimed_at,
      cancelled_at, cancellation_reason, supersedes_intent_id
    ) VALUES ('intent-v21', 'room-v21', 'message-v21', 'agent-v21', 'human-v21',
              'direct_mention', NULL, '${NOW}', 'message-v21', 'target-v21', 1,
              'lineage-v21', 'turn-v21', 'message_target', 'pending', NULL, NULL, NULL, NULL);
  `);
  return { profileId: profile.id, assignmentId: assignment.id };
}

describe("authority SQLite v21 immutable direct invocation bindings", () => {
  it("upgrades fresh and every immutable v1-v20 schema without rewriting history", () => {
    expect(AUTHORITY_SCHEMA_VERSION).toBe(22);
    for (let version = 1; version <= 20; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        const history = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(22);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations WHERE version <= ? ORDER BY version",
        ).all(version)).toEqual(history);
      });
    }
  }, 180_000);

  it("rolls every v21 statement back to the byte-equivalent v20 contract", () => {
    expect(AUTHORITY_V21_STATEMENT_COUNT_FOR_TEST).toBe(6);
    expect(AUTHORITY_V21_INVARIANT_STATEMENT_COUNT_FOR_TEST).toBe(6);
    expect(AUTHORITY_V21_ROLLBACK_ASSERTION_COUNT_FOR_TEST).toBe(6);
    expect(AUTHORITY_V21_MIGRATION_CHECKSUM_FOR_TEST)
      .toBe("9bd9188cd3b415361fd503e31fc14ca76b23de8d752f61e273335088b37eb603");
    for (let statement = 1; statement <= AUTHORITY_V21_STATEMENT_COUNT_FOR_TEST; statement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, 20);
        const tables = listAuthorityTables(database);
        const history = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        expect(() => migrateAuthorityDatabase(database, { failAfterStatement: statement }))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(20);
        expect(listAuthorityTables(database)).toEqual(tables);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(history);
      });
    }
  });

  it("binds on-mention direct intent to exact revisions and preserves them across reduction", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 19);
      seedAuthority(database);
      migrateAuthorityDatabase(database);
      const authority = seedStructuredDirectIntent(database);
      database.prepare(
        `INSERT INTO direct_agent_invocation_authority_bindings (
           intent_id, profile_id, profile_revision, assignment_id,
           assignment_revision, access_revision
         ) VALUES ('intent-v21', ?, 1, ?, 1, 7)`,
      ).run(authority.profileId, authority.assignmentId);
      database.prepare(
        `INSERT INTO message_target_outcomes (
           message_id, room_id, target_id, target_actor_id, target_kind,
           status, request_intent_id, invocation_intent_id, rejection_code, created_at
         ) VALUES ('message-v21', 'room-v21', 'target-v21', 'agent-v21',
                   'agent-invocation', 'invocation-intent-created', NULL,
                   'intent-v21', NULL, ?)`,
      ).run(NOW);
      database.exec("COMMIT");

      database.prepare(
        `UPDATE agent_profiles SET display_name = 'Agent after rename', revision = 2,
                 status = 'disabled', updated_at = ? WHERE id = ?`,
      ).run(NOW, authority.profileId);
      database.prepare(
        `INSERT INTO agent_profile_revisions (
           profile_id, revision, actor_id, display_name, global_responsibility,
           status, capability_ceiling_json, tool_ceiling_json,
           changed_by_human_actor_id, changed_at, operation
         ) SELECT id, revision, actor_id, display_name, global_responsibility,
                  status, capability_ceiling_json, tool_ceiling_json,
                  'human-v21', ?, 'disable'
           FROM agent_profiles WHERE id = ?`,
      ).run(NOW, authority.profileId);
      database.prepare(
        `UPDATE room_agent_assignments SET revision = 2, paused = 1,
                 updated_at = ? WHERE id = ?`,
      ).run(NOW, authority.assignmentId);
      database.prepare(
        `INSERT INTO room_agent_assignment_revisions (
           assignment_id, revision, room_id, profile_id, agent_actor_id,
           room_responsibility, status, participation, paused,
           capability_subset_json, tool_subset_json, changed_by_human_actor_id,
           changed_at, operation
         ) SELECT id, revision, room_id, profile_id, agent_actor_id,
                  room_responsibility, status, participation, paused,
                  capability_subset_json, tool_subset_json, 'human-v21', ?, 'pause'
           FROM room_agent_assignments WHERE id = ?`,
      ).run(NOW, authority.assignmentId);
      database.exec(`
        UPDATE room_memberships SET access_revision = 8
        WHERE room_id = 'room-v21' AND actor_id = 'agent-v21';
        UPDATE agent_invocation_intents SET status = 'claimed', claimed_at = '${NOW}'
        WHERE id = 'intent-v21';
      `);
      expect(database.prepare(
        `SELECT profile_revision AS profileRevision,
                assignment_revision AS assignmentRevision,
                access_revision AS accessRevision
         FROM direct_agent_invocation_authority_bindings WHERE intent_id = 'intent-v21'`,
      ).get()).toEqual({ profileRevision: 1, assignmentRevision: 1, accessRevision: 7 });
      expect(() => database.prepare(
        "UPDATE direct_agent_invocation_authority_bindings SET access_revision = 8 WHERE intent_id = 'intent-v21'",
      ).run()).toThrow(/immutable/i);
    });
  });

  it("rejects stale or forged binding and an accepted outcome without a binding", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 19);
      seedAuthority(database);
      migrateAuthorityDatabase(database);
      const authority = seedStructuredDirectIntent(database);
      expect(() => database.prepare(
        `INSERT INTO direct_agent_invocation_authority_bindings
         VALUES ('intent-v21', ?, 1, ?, 1, 6)`,
      ).run(authority.profileId, authority.assignmentId)).toThrow(/invalid or stale/i);
      expect(() => database.prepare(
        `INSERT INTO message_target_outcomes (
           message_id, room_id, target_id, target_actor_id, target_kind,
           status, request_intent_id, invocation_intent_id, rejection_code, created_at
         ) VALUES ('message-v21', 'room-v21', 'target-v21', 'agent-v21',
                   'agent-invocation', 'invocation-intent-created', NULL,
                   'intent-v21', NULL, ?)`,
      ).run(NOW)).toThrow(/lacks immutable authority binding/i);
      database.exec("ROLLBACK");
    });
  });

  it("reopens under WAL and retains the immutable direct binding", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-authority-v21-wal-"));
    const path = join(directory, "authority.sqlite");
    try {
      const first = new DatabaseSync(path);
      migrateAuthorityDatabaseToHistoricalVersionForTest(first, 19);
      seedAuthority(first);
      migrateAuthorityDatabase(first);
      const authority = seedStructuredDirectIntent(first);
      first.prepare(
        `INSERT INTO direct_agent_invocation_authority_bindings
         VALUES ('intent-v21', ?, 1, ?, 1, 7)`,
      ).run(authority.profileId, authority.assignmentId);
      first.prepare(
        `INSERT INTO message_target_outcomes (
           message_id, room_id, target_id, target_actor_id, target_kind,
           status, request_intent_id, invocation_intent_id, rejection_code, created_at
         ) VALUES ('message-v21', 'room-v21', 'target-v21', 'agent-v21',
                   'agent-invocation', 'invocation-intent-created', NULL,
                   'intent-v21', NULL, ?)`,
      ).run(NOW);
      first.exec("COMMIT");
      first.close();
      const reopened = new DatabaseSync(path);
      try {
        migrateAuthorityDatabase(reopened);
        expect(reopened.prepare(
          "SELECT access_revision AS accessRevision FROM direct_agent_invocation_authority_bindings",
        ).get()).toEqual({ accessRevision: 7 });
        expect(reopened.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
