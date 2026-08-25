import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_V23_MIGRATION_CHECKSUM_FOR_TEST,
  AUTHORITY_V23_STATEMENT_COUNT_FOR_TEST,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

describe("authority SQLite v23 Project Loop migration rollback", () => {
  it.each([0, 1])("rolls statement partition %i back to the exact v22 contract", (partition) => {
    expect(AUTHORITY_V23_STATEMENT_COUNT_FOR_TEST).toBeGreaterThan(0);
    expect(AUTHORITY_V23_MIGRATION_CHECKSUM_FOR_TEST).toMatch(/^[a-f0-9]{64}$/);
    const templateDirectory = mkdtempSync(join(tmpdir(), "dao-authority-v22-template-"));
    const templatePath = join(templateDirectory, "authority.sqlite");
    const template = new DatabaseSync(templatePath);
    migrateAuthorityDatabaseToHistoricalVersionForTest(template, 22);
    template.close();
    try {
      for (let statement = 1 + partition; statement <= AUTHORITY_V23_STATEMENT_COUNT_FOR_TEST;
        statement += 2) {
        const directory = mkdtempSync(join(tmpdir(), "dao-authority-v23-rollback-"));
        const path = join(directory, "authority.sqlite");
        copyFileSync(templatePath, path);
        const database = new DatabaseSync(path);
        try {
          const tables = listAuthorityTables(database);
          const history = database.prepare(
            "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
          ).all();
          expect(() => migrateAuthorityDatabase(database, { failAfterStatement: statement }))
            .toThrow(/injected migration failure/i);
          expect(readSchemaVersion(database)).toBe(22);
          expect(listAuthorityTables(database)).toEqual(tables);
          expect(database.prepare(
            "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
          ).all()).toEqual(history);
        } finally {
          database.close();
          rmSync(directory, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(templateDirectory, { recursive: true, force: true });
    }
  }, 180_000);
});
