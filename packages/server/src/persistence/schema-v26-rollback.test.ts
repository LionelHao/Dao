import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_V26_STATEMENT_COUNT_FOR_TEST,
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

describe("v26 tool-safety migration rollback matrix", () => {
  const chunkSize = 20;
  const chunks = Array.from(
    { length: Math.ceil(AUTHORITY_V26_STATEMENT_COUNT_FOR_TEST / chunkSize) },
    (_, index) => ({
      first: index * chunkSize + 1,
      last: Math.min((index + 1) * chunkSize, AUTHORITY_V26_STATEMENT_COUNT_FOR_TEST),
    }),
  );

  for (const chunk of chunks) {
    it(
      `rolls statements ${chunk.first}-${chunk.last} back with v25 history intact`,
      () => {
        for (
          let failAfterStatement = chunk.first;
          failAfterStatement <= chunk.last;
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
  }
});
