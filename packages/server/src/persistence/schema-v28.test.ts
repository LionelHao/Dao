import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V28_MIGRATION_CHECKSUM_FOR_TEST,
  AUTHORITY_V28_STATEMENT_COUNT_FOR_TEST,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-ft12-schema-v28-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedRecipient(database: DatabaseSync): void {
  database.prepare(
    "INSERT INTO actors (id, kind, display_name) VALUES ('human-1', 'human', 'Human')",
  ).run();
  database.prepare(
    "INSERT INTO rooms (id, name, status, created_at) VALUES ('room-1', 'Room', 'active', ?)",
  ).run("2026-08-31T00:00:00.000Z");
  database.prepare(
    `INSERT INTO room_memberships (
       room_id, actor_id, kind, role, tool_permissions_json, joined_at
     ) VALUES ('room-1', 'human-1', 'human', NULL, '[]', ?)`,
  ).run("2026-08-31T00:00:00.000Z");
}

function insertNotification(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO notifications (
       notification_id, room_id, recipient_actor_id, notification_kind, source_kind,
       source_id, source_revision, source_boundary_id, source_ordinal, dedupe_key,
       safe_actor_id, created_at, read_at, read_revision, handled_at, handled_revision,
       revoked_at, revoke_reason
     ) VALUES (?, 'room-1', 'human-1', 'human_request', 'project_request',
       'request-1', 1, 'request-1', 0, ?, NULL, ?, NULL, 0, NULL, 0, NULL, NULL)`,
  ).run("notification-1", "a".repeat(64), "2026-08-31T00:01:00.000Z");
}

describe("v28 recipient notification authority schema", () => {
  it("migrates v27 append-only and preserves every historical checksum", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 27);
      const before = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 28);
      expect(AUTHORITY_SCHEMA_VERSION).toBe(29);
      expect(readSchemaVersion(database)).toBe(28);
      expect(database.prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version <= 27 ORDER BY version",
      ).all()).toEqual(before);
      expect(database.prepare(
        "SELECT name, checksum FROM schema_migrations WHERE version = 28",
      ).get()).toEqual({
        name: "recipient-notification-authority",
        checksum: AUTHORITY_V28_MIGRATION_CHECKSUM_FOR_TEST,
      });
    });
  });

  it("enforces closed kinds, Human membership, dedupe, and monotone independent state", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 28);
      seedRecipient(database);
      insertNotification(database);
      expect(() => database.prepare(
        "UPDATE notifications SET read_revision = 2, read_at = ? WHERE notification_id = ?",
      ).run("2026-08-31T00:02:00.000Z", "notification-1")).toThrow(/monotonically/i);
      database.prepare(
        "UPDATE notifications SET read_revision = 1, read_at = ? WHERE notification_id = ?",
      ).run("2026-08-31T00:02:00.000Z", "notification-1");
      expect(database.prepare(
        `SELECT read_revision AS readRevision, handled_revision AS handledRevision
         FROM notifications WHERE notification_id = 'notification-1'`,
      ).get()).toEqual({ readRevision: 1, handledRevision: 0 });
      expect(() => database.prepare(
        "UPDATE notifications SET read_revision = 0, read_at = NULL WHERE notification_id = ?",
      ).run("notification-1")).toThrow(/monotonically/i);
      expect(() => database.prepare(
        `INSERT INTO notifications (
          notification_id, room_id, recipient_actor_id, notification_kind, source_kind,
          source_id, source_revision, source_boundary_id, source_ordinal, dedupe_key,
          created_at, read_revision, handled_revision
        ) VALUES ('notification-bad', 'room-1', 'human-1', 'unknown', 'project_request',
          'request-2', 1, 'request-2', 0, ?, ?, 0, 0)`,
      ).run("b".repeat(64), "2026-08-31T00:03:00.000Z")).toThrow();
    });
  });

  it("rolls every v28 statement back to byte-equivalent v27", () => {
    for (let failAfterStatement = 1;
      failAfterStatement <= AUTHORITY_V28_STATEMENT_COUNT_FOR_TEST;
      failAfterStatement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, 27);
        const before = database.prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        ).all();
        const history = database.prepare(
          "SELECT * FROM schema_migrations ORDER BY version",
        ).all();
        expect(() => migrateAuthorityDatabase(database, { failAfterStatement }))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(27);
        expect(database.prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        ).all()).toEqual(before);
        expect(database.prepare("SELECT * FROM schema_migrations ORDER BY version").all())
          .toEqual(history);
      });
    }
  }, 30_000);
});
