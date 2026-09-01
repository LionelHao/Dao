import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V29_MIGRATION_CHECKSUM_FOR_TEST,
  AUTHORITY_V29_STATEMENT_COUNT_FOR_TEST,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-ft14-schema-v29-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("v29 privacy operations retention recovery schema", () => {
  it("migrates v28 append-only and preserves every historical checksum", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 28);
      const before = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_SCHEMA_VERSION).toBe(29);
      expect(readSchemaVersion(database)).toBe(29);
      expect(database.prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version <= 28 ORDER BY version",
      ).all()).toEqual(before);
      expect(database.prepare(
        "SELECT name, checksum FROM schema_migrations WHERE version = 29",
      ).get()).toEqual({
        name: "privacy-operations-retention-recovery",
        checksum: AUTHORITY_V29_MIGRATION_CHECKSUM_FOR_TEST,
      });
    });
  });

  it("enforces the bounded pending to dead-letter lifecycle", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.prepare(
        `INSERT INTO privacy_retention_attempts (
           category, candidate_id, status, attempts, available_at, last_error,
           updated_at, dead_lettered_at
         ) VALUES ('context_snapshot_payload', 'snapshot-1', 'pending', 7, ?,
           'purge_failed', ?, NULL)`,
      ).run("2026-08-31T00:00:01.000Z", "2026-08-31T00:00:00.000Z");
      database.prepare(
        `UPDATE privacy_retention_attempts
         SET status = 'dead_letter', attempts = 8, available_at = ?, updated_at = ?,
             dead_lettered_at = ?
         WHERE category = 'context_snapshot_payload' AND candidate_id = 'snapshot-1'`,
      ).run("2026-08-31T00:00:02.000Z", "2026-08-31T00:00:01.000Z",
        "2026-08-31T00:00:01.000Z");
      expect(database.prepare(
        "SELECT status, attempts FROM privacy_retention_attempts",
      ).get()).toEqual({ status: "dead_letter", attempts: 8 });
      expect(() => database.prepare(
        "UPDATE privacy_retention_attempts SET attempts = 8 WHERE candidate_id = 'snapshot-1'",
      ).run()).toThrow(/transition is invalid/i);
    });
  });

  it("rolls every v29 statement back to byte-equivalent v28", () => {
    for (let failAfterStatement = 1;
      failAfterStatement <= AUTHORITY_V29_STATEMENT_COUNT_FOR_TEST;
      failAfterStatement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, 28);
        const before = database.prepare(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        ).all();
        const history = database.prepare(
          "SELECT * FROM schema_migrations ORDER BY version",
        ).all();
        expect(() => migrateAuthorityDatabase(database, { failAfterStatement }))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(28);
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
