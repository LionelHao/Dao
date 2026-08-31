import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V27_MIGRATION_CHECKSUM_FOR_TEST,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

function withDatabase<Result>(operation: (database: DatabaseSync) => Result): Result {
  const directory = mkdtempSync(join(tmpdir(), "dao-ft13-schema-v27-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    return operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function columns(database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info('${table}')`).all()
    .map((row) => String(row.name));
}

describe("v27 sync reliability lifecycle schema", () => {
  it("migrates fresh and every supported historical schema to immutable v27", () => {
    expect(AUTHORITY_SCHEMA_VERSION).toBe(27);
    expect(AUTHORITY_V27_MIGRATION_CHECKSUM_FOR_TEST).toMatch(/^[0-9a-f]{64}$/);
    for (let version = 1; version <= 26; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(27);
        const migration = database.prepare(
          "SELECT name, checksum FROM schema_migrations WHERE version = 27",
        ).get();
        expect(migration).toEqual({
          name: "sync-reliability-lifecycle",
          checksum: AUTHORITY_V27_MIGRATION_CHECKSUM_FOR_TEST,
        });
      });
    }
  }, 30_000);

  it("adds bounded outbox terminal state and every current receipt expiry scan", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      expect(columns(database, "outbox_deliveries")).toContain("dead_lettered_at");
      expect(columns(database, "deployment_profile_outbox")).toContain("dead_lettered_at");
      expect(columns(database, "room_cache_invalidation_intents")).toContain("dead_lettered_at");
      expect(columns(database, "project_event_outbox")).toEqual(expect.arrayContaining([
        "last_error",
        "dead_lettered_at",
      ]));
      expect(columns(database, "project_command_receipts")).toContain("expires_at");
      expect(columns(database, "invocation_cancellation_receipts")).toContain("expires_at");
      expect(columns(database, "invocation_human_retry_receipts")).toContain("expires_at");

      const indexes = database.prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE '%_v27' ORDER BY name`,
      ).all().map((row) => String(row.name));
      expect(indexes).toEqual(expect.arrayContaining([
        "deployment_idempotency_records_expiry_v27",
        "deployment_profile_outbox_dead_letter_v27",
        "deployment_profile_outbox_pending_v27",
        "idempotency_records_expiry_v27",
        "invocation_cancellation_receipts_expiry_v27",
        "invocation_human_retry_receipts_expiry_v27",
        "outbox_deliveries_dead_letter_v27",
        "outbox_deliveries_pending_v27",
        "project_command_receipts_expiry_v27",
        "project_event_outbox_dead_letter_v27",
        "project_event_outbox_pending_v27",
        "room_cache_invalidation_dead_letter_v27",
        "room_cache_invalidation_ready_v27",
        "room_memory_idempotency_expiry_v27",
        "tool_safety_command_receipts_expiry_v27",
      ]));
    });
  });

  it("keeps v1-v26 migration checksums byte-for-byte unchanged", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 26);
      const before = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      migrateAuthorityDatabase(database);
      const after = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version <= 26 ORDER BY version",
      ).all();
      expect(after).toEqual(before);
    });
  });
});
