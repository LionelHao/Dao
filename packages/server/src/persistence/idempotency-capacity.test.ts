import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cleanupExpiredIdempotencyDatabaseCommand } from
  "./authority-database-handler.js";
import { migrateAuthorityDatabase } from "./schema.js";

const NOW_MS = Date.parse("2026-08-31T00:00:00.000Z");
const TOTAL_RECEIPTS = 50_000;
const EXPIRED_RECEIPTS = 25_001;
const CLEANUP_BATCH_SIZE = 500;

function count(database: DatabaseSync): number {
  const row = database.prepare(
    "SELECT COUNT(*) AS count FROM idempotency_records",
  ).get();
  if (typeof row?.count !== "number") throw new TypeError("receipt count was invalid");
  return row.count;
}

function open(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL");
  return database;
}

describe("idempotency janitor PR capacity", () => {
  it("drains 50k mixed receipts in <=500-row yielding batches and resumes after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft13-idempotency-capacity-"));
    const path = join(directory, "authority.sqlite");
    let database = open(path);
    try {
      migrateAuthorityDatabase(database);
      const insert = database.prepare(
        `INSERT INTO idempotency_records (
           scope, key, request_hash, response_json, status_code, created_at, expires_at
         ) VALUES ('message.send', ?, ?, '{}', 200, ?, ?)`,
      );
      const expiredAt = new Date(NOW_MS).toISOString();
      const liveAt = new Date(NOW_MS + 1).toISOString();
      const createdAt = new Date(NOW_MS - 30 * 24 * 60 * 60 * 1_000).toISOString();
      database.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < TOTAL_RECEIPTS; index += 1) {
        insert.run(
          `capacity-${index.toString().padStart(5, "0")}`,
          index.toString(16).padStart(64, "0"),
          createdAt,
          index < EXPIRED_RECEIPTS ? expiredAt : liveAt,
        );
      }
      database.exec("COMMIT");
      expect(count(database)).toBe(TOTAL_RECEIPTS);

      let deleted = 0;
      let batches = 0;
      let yielded = 0;
      while (true) {
        const result = cleanupExpiredIdempotencyDatabaseCommand(
          database,
          NOW_MS,
          CLEANUP_BATCH_SIZE,
        );
        expect(result.deletedCount).toBeLessThanOrEqual(CLEANUP_BATCH_SIZE);
        deleted += result.deletedCount;
        batches += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        yielded += 1;

        if (batches === 20) {
          database.close();
          database = open(path);
        }
        if (!result.hasMore) break;
      }

      expect(deleted).toBe(EXPIRED_RECEIPTS);
      expect(batches).toBe(Math.ceil(EXPIRED_RECEIPTS / CLEANUP_BATCH_SIZE));
      expect(yielded).toBe(batches);
      expect(count(database)).toBe(TOTAL_RECEIPTS - EXPIRED_RECEIPTS);
      expect(database.prepare(
        "SELECT MIN(expires_at) AS earliest FROM idempotency_records",
      ).get()).toEqual({ earliest: liveAt });
      expect(cleanupExpiredIdempotencyDatabaseCommand(
        database,
        NOW_MS,
        CLEANUP_BATCH_SIZE,
      )).toEqual({ deletedCount: 0, hasMore: false });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
