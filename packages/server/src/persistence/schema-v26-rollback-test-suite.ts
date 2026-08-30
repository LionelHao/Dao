import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToPreviousVersionForTest,
  readSchemaVersion,
} from "./schema.js";

interface LogicalSnapshot {
  readonly schemaVersion: number;
  readonly tables: readonly {
    readonly name: string;
    readonly sql: string | null;
    readonly rows: readonly Record<string, unknown>[];
  }[];
}

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "native-im-authority-v26-rollback-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function snapshot(database: DatabaseSync): LogicalSnapshot {
  const tables = listAuthorityTables(database).map((name) => {
    const schema = database
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(name);
    return {
      name,
      sql: schema === undefined ? null : String(schema.sql),
      rows: database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    };
  });
  return { schemaVersion: readSchemaVersion(database), tables };
}

export function defineV26RollbackRangeTest(first: number, last: number): void {
  describe("v26 tool-safety migration rollback matrix", () => {
    it(
      `rolls statements ${first}-${last} back with v25 history intact`,
      () => {
        for (
          let failAfterStatement = first;
          failAfterStatement <= last;
          failAfterStatement += 1
        ) {
          withDatabase((database) => {
            migrateAuthorityDatabaseToPreviousVersionForTest(database);
            const before = snapshot(database);

            expect(() => migrateAuthorityDatabase(database, { failAfterStatement }))
              .toThrow(/injected migration failure/i);
            expect(readSchemaVersion(database)).toBe(25);
            expect(snapshot(database)).toEqual(before);
          });
        }
      },
      30_000,
    );
  });
}
