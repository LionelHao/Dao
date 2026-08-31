import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
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
  const directory = mkdtempSync(join(tmpdir(), "dao-ft13-v27-rollback-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function snapshot(database: DatabaseSync): LogicalSnapshot {
  const tables = listAuthorityTables(database).map((name) => ({
    name,
    sql: (database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(name)?.sql as string | null | undefined) ?? null,
    rows: database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
  }));
  return { schemaVersion: readSchemaVersion(database), tables };
}

export function defineV27RollbackRangeTest(first: number, last: number): void {
  describe("v27 sync reliability migration rollback matrix", () => {
    const cases: { readonly first: number; readonly last: number }[] = [];
    for (let caseFirst = first; caseFirst <= last; caseFirst += 13) {
      cases.push({ first: caseFirst, last: Math.min(caseFirst + 12, last) });
    }
    it.each(cases)("rolls statements $first-$last back with v26 history intact", (range) => {
      for (let failAfterStatement = range.first;
        failAfterStatement <= range.last;
        failAfterStatement += 1) {
        withDatabase((database) => {
          migrateAuthorityDatabaseToHistoricalVersionForTest(database, 26);
          const before = snapshot(database);
          expect(() => migrateAuthorityDatabase(database, { failAfterStatement }))
            .toThrow(/injected migration failure/i);
          expect(readSchemaVersion(database)).toBe(26);
          expect(snapshot(database)).toEqual(before);
        });
      }
    }, 30_000);
  });
}
