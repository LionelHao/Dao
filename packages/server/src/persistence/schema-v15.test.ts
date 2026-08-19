import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V15_STATEMENT_COUNT_FOR_TEST,
  migrateAuthorityDatabase,
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

describe("authority SQLite v15 room lifecycle audit vocabulary", () => {
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
      `);

      expect(database.prepare(
        "SELECT type, result FROM room_audit ORDER BY timestamp",
      ).all()).toEqual([
        { type: "room.member.left", result: "left" },
        { type: "room.reopened", result: "reopened" },
      ]);
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
        checksum: "5d8370e193813ac80ba3962bb34946e148f5ae96d0025bf57ae5b89cf1755e2d",
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
