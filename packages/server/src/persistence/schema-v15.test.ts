import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V15_STATEMENT_COUNT_FOR_TEST,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  migrateAuthorityDatabaseToPreviousVersionForTest,
  readSchemaVersion,
} from "./schema.js";

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v15-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function authorityTableCounts(database: DatabaseSync): Readonly<Record<string, number>> {
  const tables = database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
     ORDER BY name`,
  ).all();
  return Object.freeze(Object.fromEntries(tables.map((row) => {
    if (typeof row.name !== "string") throw new TypeError("authority table name is corrupt");
    const count = database.prepare(`SELECT COUNT(*) AS count FROM "${row.name}"`).get()?.count;
    if (typeof count !== "number") throw new TypeError("authority table count is corrupt");
    return [row.name, count];
  })));
}

describe("authority SQLite v15 room lifecycle audit vocabulary", () => {
  it("upgrades every immutable historical authority schema through v15", () => {
    for (let version = 1; version < AUTHORITY_SCHEMA_VERSION; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        expect(readSchemaVersion(database)).toBe(version);
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(15);
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations",
        ).get()).toEqual({ count: 15 });
      });
    }
  });

  it("persists truthful member-left and room-reopened audit facts", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);

      expect(AUTHORITY_SCHEMA_VERSION).toBe(15);
      expect(readSchemaVersion(database)).toBe(15);

      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('v15-owner', 'human', 'Owner');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'v15-owner', 0, 1), ('room', 'v15-room', 0, 1);
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('v15-room', 'Lifecycle Room', 'active', '2026-08-19T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES (
          'v15-room', 'v15-owner', 'human', 'member', NULL, '[]',
          '2026-08-19T00:00:00.000Z', NULL, 0
        );
        UPDATE rooms SET owner_actor_id = 'v15-owner' WHERE id = 'v15-room';
        INSERT INTO room_audit (
          id, type, room_id, actor_id, result, timestamp, details_json
        ) VALUES
          ('v15-left', 'room.member.left', 'v15-room', 'v15-owner', 'left',
           '2026-08-19T00:01:00.000Z', '{}'),
          ('v15-reopened', 'room.reopened', 'v15-room', 'v15-owner', 'reopened',
           '2026-08-19T00:02:00.000Z', '{}');
        INSERT INTO room_cache_invalidation_intents (
          id, room_id, lifecycle_generation, access_revision, reason,
          target_actor_id
        ) VALUES (
          'v15-cache-remove', 'v15-room', 0, 1, 'member_removed', 'v15-owner'
        );
        INSERT INTO offline_read_lease_invalidations (
          id, room_id, lifecycle_generation, access_revision, lease_generation,
          revoked_lease_count, reason, target_actor_id
        ) VALUES (
          'v15-lease-remove', 'v15-room', 0, 1, 1, 0,
          'member_removed', 'v15-owner'
        );
      `);

      expect(database.prepare(
        "SELECT type, result FROM room_audit ORDER BY timestamp",
      ).all()).toEqual([
        { type: "room.member.left", result: "left" },
        { type: "room.reopened", result: "reopened" },
      ]);
      expect(database.prepare(
        `SELECT reason, target_actor_id AS targetActorId
         FROM room_cache_invalidation_intents`,
      ).all()).toEqual([{ reason: "member_removed", targetActorId: "v15-owner" }]);
      expect(database.prepare(
        `SELECT reason, target_actor_id AS targetActorId
         FROM offline_read_lease_invalidations`,
      ).all()).toEqual([{ reason: "member_removed", targetActorId: "v15-owner" }]);
    });
  });

  it("rolls every v15 statement back with v14 audit history intact", () => {
    for (
      let failAfterStatement = 1;
      failAfterStatement <= AUTHORITY_V15_STATEMENT_COUNT_FOR_TEST;
      failAfterStatement += 1
    ) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToPreviousVersionForTest(database);
        expect(readSchemaVersion(database)).toBe(14);
        database.exec(`
          INSERT INTO actors (id, kind, display_name)
          VALUES ('rollback-owner', 'human', 'Owner');
          INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
          VALUES
            ('identity', 'rollback-owner', 0, 1),
            ('room', 'rollback-room', 0, 1);
          INSERT INTO rooms (id, name, status, created_at)
          VALUES ('rollback-room', 'Room', 'active', '2026-08-19T00:00:00.000Z');
          INSERT INTO room_memberships (
            room_id, actor_id, kind, role, participation, tool_permissions_json,
            joined_at, configured_at, access_revision
          ) VALUES (
            'rollback-room', 'rollback-owner', 'human', 'member', NULL, '[]',
            '2026-08-19T00:00:00.000Z', NULL, 0
          );
          UPDATE rooms SET owner_actor_id = 'rollback-owner' WHERE id = 'rollback-room';
          INSERT INTO room_audit (
            id, type, room_id, actor_id, result, timestamp, details_json
          ) VALUES (
            'rollback-created', 'room.created', 'rollback-room', 'rollback-owner',
            'created', '2026-08-19T00:00:00.000Z', '{}'
          );
        `);

        expect(() => migrateAuthorityDatabase(database, { failAfterStatement }))
          .toThrow(/injected migration failure/i);

        expect(readSchemaVersion(database)).toBe(14);
        expect(database.prepare(
          "SELECT id, type, result FROM room_audit",
        ).all()).toEqual([{
          id: "rollback-created",
          type: "room.created",
          result: "created",
        }]);
        expect(() => database.exec(`
          INSERT INTO room_audit (
            id, type, room_id, actor_id, result, timestamp, details_json
          ) VALUES (
            'rollback-reopen', 'room.reopened', 'rollback-room', 'rollback-owner',
            'reopened', '2026-08-19T00:01:00.000Z', '{}'
          )
        `)).toThrow(/check constraint/i);
      });
    }
  });

  it("allows remove, re-add, and remove again in one lifecycle generation", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('cycle-owner', 'human', 'Owner'), ('cycle-target', 'human', 'Target');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES
          ('identity', 'cycle-owner', 0, 1),
          ('identity', 'cycle-target', 0, 1),
          ('room', 'cycle-room', 0, 1);
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('cycle-room', 'Cycle Room', 'active', '2026-08-19T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES (
          'cycle-room', 'cycle-owner', 'human', 'member', NULL, '[]',
          '2026-08-19T00:00:00.000Z', NULL, 0
        );
        UPDATE rooms SET owner_actor_id = 'cycle-owner' WHERE id = 'cycle-room';
        INSERT INTO room_cache_invalidation_intents (
          id, room_id, lifecycle_generation, access_revision, reason, target_actor_id
        ) VALUES
          ('cycle-cache-1', 'cycle-room', 0, 1, 'member_removed', 'cycle-target'),
          ('cycle-cache-2', 'cycle-room', 0, 2, 'member_removed', 'cycle-target');
        INSERT INTO offline_read_lease_invalidations (
          id, room_id, lifecycle_generation, access_revision, lease_generation,
          revoked_lease_count, reason, target_actor_id
        ) VALUES
          ('cycle-lease-1', 'cycle-room', 0, 1, 0, 1,
           'member_removed', 'cycle-target'),
          ('cycle-lease-2', 'cycle-room', 0, 2, 0, 1,
           'member_removed', 'cycle-target');
      `);

      expect(database.prepare(
        `SELECT access_revision AS accessRevision
         FROM room_cache_invalidation_intents
         WHERE target_actor_id = 'cycle-target'
         ORDER BY access_revision`,
      ).all()).toEqual([{ accessRevision: 1 }, { accessRevision: 2 }]);
      expect(database.prepare(
        `SELECT access_revision AS accessRevision
         FROM offline_read_lease_invalidations
         WHERE target_actor_id = 'cycle-target'
         ORDER BY access_revision`,
      ).all()).toEqual([{ accessRevision: 1 }, { accessRevision: 2 }]);
    });
  });

  it("preserves complete v14 row counts, provider ledgers, actions, and sealed secrets", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToPreviousVersionForTest(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('preserve-owner', 'human', 'Owner');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES
          ('identity', 'preserve-owner', 0, 1),
          ('room', 'preserve-room', 0, 1);
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('preserve-room', 'Preserve', 'active', '2026-08-19T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES (
          'preserve-room', 'preserve-owner', 'human', 'member', NULL, '[]',
          '2026-08-19T00:00:00.000Z', NULL, 7
        );
        UPDATE rooms
        SET owner_actor_id = 'preserve-owner', status = 'archived',
            governance_revision = 4, archive_generation = 1,
            archived_at = '2026-08-19T00:01:00.000Z'
        WHERE id = 'preserve-room';
        INSERT INTO room_audit (
          id, type, room_id, actor_id, result, timestamp, details_json
        ) VALUES (
          'preserve-audit', 'room.archived', 'preserve-room', 'preserve-owner',
          'archived', '2026-08-19T00:01:00.000Z', '{}'
        );
        INSERT INTO room_message_archive_gates (
          room_id, gate_generation, blocked_at
        ) VALUES ('preserve-room', 1, '2026-08-19T00:01:00.000Z');
        INSERT INTO runtime_archive_fences (
          room_id, archive_generation, fenced_at, fenced_queued_count,
          fenced_waiting_count, preserved_dispatched_count,
          preserved_outcome_review_count
        ) VALUES ('preserve-room', 1, '2026-08-19T00:01:00.000Z', 0, 0, 0, 0);
        INSERT INTO tool_archive_settlements (
          room_id, archive_generation, settled_at, rejected_pending_count,
          revoked_grant_count, fenced_waiting_count, preserved_dispatched_count
        ) VALUES ('preserve-room', 1, '2026-08-19T00:01:00.000Z', 0, 0, 0, 0);
        INSERT INTO room_business_timer_freeze_batches (
          room_id, archive_generation, suspended_at, suspended_count,
          resumed_at, resumed_count, descriptor_ids_json
        ) VALUES ('preserve-room', 1, '2026-08-19T00:01:00.000Z', 0, NULL, NULL, '[]');
        INSERT INTO room_assignment_archive_policies (
          room_id, archive_generation, policy_version, assignment_revision,
          expansion_blocked, reduced_at
        ) VALUES ('preserve-room', 1, 1, 0, 1, '2026-08-19T00:01:00.000Z');
        INSERT INTO project_next_actions (
          id, room_id, source_room_id, source_id, revision, owner_kind,
          owner_actor_id, verifier_human_actor_id, status
        ) VALUES (
          'preserve-action', 'preserve-room', 'preserve-room', 'source-1', 1,
          'human', 'preserve-owner', NULL, 'in_progress'
        );
        INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
        VALUES ('preserve-room', 7, 3);
        INSERT INTO room_cache_invalidation_intents (
          id, room_id, lifecycle_generation, access_revision, reason
        ) VALUES ('preserve-cache', 'preserve-room', 1, 7, 'room_archived');
        INSERT INTO offline_read_lease_invalidations (
          id, room_id, lifecycle_generation, access_revision, lease_generation,
          revoked_lease_count, reason
        ) VALUES ('preserve-lease', 'preserve-room', 1, 7, 3, 0, 'room_archived');
        INSERT INTO idempotency_records (
          scope, key, request_hash, response_json, status_code, created_at, expires_at
        ) VALUES (
          'preserve-scope', 'preserve-key', 'preserve-hash',
          '{"sealedToken":"ciphertext-secret-sentinel-v14"}', 200,
          '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
        );
      `);
      const before = authorityTableCounts(database);

      migrateAuthorityDatabase(database);

      expect(authorityTableCounts(database)).toEqual(before);
      expect(database.prepare(
        "SELECT response_json AS responseJson FROM idempotency_records WHERE key = 'preserve-key'",
      ).get()).toEqual({
        responseJson: '{"sealedToken":"ciphertext-secret-sentinel-v14"}',
      });
      expect(database.prepare(
        `SELECT
           (SELECT COUNT(*) FROM runtime_archive_fences) AS runtimeLedgers,
           (SELECT COUNT(*) FROM tool_archive_settlements) AS toolLedgers,
           (SELECT COUNT(*) FROM room_business_timer_freeze_batches) AS timerLedgers,
           (SELECT COUNT(*) FROM room_assignment_archive_policies) AS assignmentLedgers,
           (SELECT COUNT(*) FROM project_next_actions) AS actions`,
      ).get()).toEqual({
        runtimeLedgers: 1,
        toolLedgers: 1,
        timerLedgers: 1,
        assignmentLedgers: 1,
        actions: 1,
      });
    });
  });

  it("preserves v14 rows and makes the expanded v15 audit immutable", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToPreviousVersionForTest(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('history-owner', 'human', 'Owner');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'history-owner', 0, 1), ('room', 'history-room', 0, 1);
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('history-room', 'Room', 'active', '2026-08-19T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES (
          'history-room', 'history-owner', 'human', 'member', NULL, '[]',
          '2026-08-19T00:00:00.000Z', NULL, 0
        );
        UPDATE rooms SET owner_actor_id = 'history-owner' WHERE id = 'history-room';
        INSERT INTO room_audit (
          id, type, room_id, actor_id, result, timestamp, details_json
        ) VALUES (
          'history-created', 'room.created', 'history-room', 'history-owner',
          'created', '2026-08-19T00:00:00.000Z', '{}'
        );
      `);

      migrateAuthorityDatabase(database);

      expect(database.prepare(
        "SELECT id, type, result FROM room_audit",
      ).all()).toEqual([{
        id: "history-created",
        type: "room.created",
        result: "created",
      }]);
      expect(database.prepare(
        "SELECT name, checksum FROM schema_migrations WHERE version = 15",
      ).get()).toEqual({
        name: "truthful-room-lifecycle-audit-vocabulary",
        checksum: "41740e7d34f6807248bf7879f34f9026844802dfe5a43f0ee18bf498a24dc0c9",
      });
      expect(() => database.prepare(
        "UPDATE room_audit SET details_json = '{}' WHERE id = ?",
      ).run("history-created")).toThrow(/immutable/i);
      expect(() => database.prepare(
        "DELETE FROM room_audit WHERE id = ?",
      ).run("history-created")).toThrow(/immutable/i);
    });
  });
});
