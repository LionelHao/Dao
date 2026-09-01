import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { executePrivacyRetentionAuthorityOperation } from "./retention-database-handler.js";

const now = Date.parse("2026-08-31T00:00:00.000Z");
const databases = new Set<DatabaseSync>();

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.add(database);
  database.exec(`
    CREATE TABLE context_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      retain_until TEXT,
      payload_retention_state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_executions (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    CREATE TABLE agent_execution_context_bindings (
      execution_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE context_snapshot_bodies (snapshot_id TEXT PRIMARY KEY) STRICT;
    CREATE TRIGGER context_snapshot_body_purged
    AFTER DELETE ON context_snapshot_bodies BEGIN
      UPDATE context_snapshots SET payload_retention_state = 'purged'
      WHERE snapshot_id = OLD.snapshot_id AND payload_retention_state = 'purge_pending';
    END;
    CREATE TABLE context_source_reads (read_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL) STRICT;
    CREATE TABLE context_source_read_payloads (read_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE tool_calls_v2 (
      tool_call_id TEXT PRIMARY KEY,
      sealed_payload_ciphertext TEXT,
      sealed_payload_key_version TEXT,
      sealed_payload_expires_at TEXT
    ) STRICT;
    CREATE TABLE tool_dispatches_v2 (
      dispatch_id TEXT PRIMARY KEY,
      tool_call_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE privacy_retention_attempts (
      category TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      available_at TEXT NOT NULL,
      last_error TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dead_lettered_at TEXT,
      PRIMARY KEY (category, candidate_id)
    ) STRICT;
  `);
  return database;
}

function iso(offsetMs: number): string {
  return new Date(now + offsetMs).toISOString();
}

function addContext(
  database: DatabaseSync,
  id: string,
  dueAt: string,
  status: string,
  withBody = true,
): void {
  database.prepare("INSERT INTO context_snapshots VALUES (?, ?, 'purge_pending')").run(id, dueAt);
  database.prepare("INSERT INTO agent_executions VALUES (?, ?)").run(`execution-${id}`, status);
  database.prepare("INSERT INTO agent_execution_context_bindings VALUES (?, ?)")
    .run(`execution-${id}`, id);
  if (withBody) database.prepare("INSERT INTO context_snapshot_bodies VALUES (?)").run(id);
  database.prepare("INSERT INTO context_source_reads VALUES (?, ?)").run(`read-${id}`, id);
  database.prepare("INSERT INTO context_source_read_payloads VALUES (?)").run(`read-${id}`);
}

function addTool(database: DatabaseSync, id: string, dueAt: string, state: string): void {
  database.prepare("INSERT INTO tool_calls_v2 VALUES (?, ?, ?, ?)")
    .run(id, `ciphertext-${id}`, `key-${id}`, dueAt);
  database.prepare("INSERT INTO tool_dispatches_v2 VALUES (?, ?, ?)")
    .run(`dispatch-${id}`, id, state);
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("FT-14 privacy retention database authority", () => {
  it("purges one bounded cross-category batch and reports the durable tail", () => {
    const database = createDatabase();
    addContext(database, "archived-context", iso(-3_000), "completed");
    addTool(database, "safe-tool", iso(-2_000), "known_succeeded");
    addContext(database, "terminal-context", iso(-1_000), "failed", false);
    addContext(database, "running-context", iso(-20_000), "running");
    addTool(database, "unknown-tool", iso(-20_000), "outcome_unknown");
    addTool(database, "future-tool", iso(1), "reviewed");

    expect(executePrivacyRetentionAuthorityOperation(database, {
      version: 1,
      type: "privacy.retention.run-batch",
      trigger: "periodic",
      now,
      limit: 2,
    })).toEqual({
      kind: "privacy-retention-batch",
      processed: 2,
      purged: 2,
      retained: 0,
      retried: 0,
      deadLettered: 0,
      hasMore: true,
      queueDepth: 1,
      oldestAgeMs: 1_000,
    });

    expect(database.prepare(
      "SELECT payload_retention_state AS state FROM context_snapshots WHERE snapshot_id = ?",
    ).get("archived-context")).toEqual({ state: "purged" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM context_source_read_payloads WHERE read_id = ?",
    ).get("read-archived-context")).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT sealed_payload_ciphertext AS ciphertext,
              sealed_payload_key_version AS keyVersion,
              sealed_payload_expires_at AS expiresAt
       FROM tool_calls_v2 WHERE tool_call_id = ?`,
    ).get("safe-tool")).toEqual({ ciphertext: null, keyVersion: null, expiresAt: null });
    expect(database.prepare(
      "SELECT sealed_payload_ciphertext AS ciphertext FROM tool_calls_v2 WHERE tool_call_id = ?",
    ).get("unknown-tool")).toEqual({ ciphertext: "ciphertext-unknown-tool" });

    expect(executePrivacyRetentionAuthorityOperation(database, {
      version: 1,
      type: "privacy.retention.run-batch",
      trigger: "startup_recovery",
      now,
      limit: 100,
    })).toEqual({
      kind: "privacy-retention-batch",
      processed: 1,
      purged: 1,
      retained: 0,
      retried: 0,
      deadLettered: 0,
      hasMore: false,
      queueDepth: 0,
      oldestAgeMs: 0,
    });
  });

  it("durably retries a malformed persisted boundary and never treats recovery states as purgeable", () => {
    const database = createDatabase();
    addContext(database, "invalid-boundary", "0", "completed");
    addTool(database, "review-required", iso(-60_000), "outcome_unknown");

    expect(executePrivacyRetentionAuthorityOperation(database, {
      version: 1,
      type: "privacy.retention.run-batch",
      trigger: "periodic",
      now,
      limit: 100,
    })).toEqual({
      kind: "privacy-retention-batch",
      processed: 1,
      purged: 0,
      retained: 0,
      retried: 1,
      deadLettered: 0,
      hasMore: false,
      queueDepth: 1,
      oldestAgeMs: 0,
    });
    expect(database.prepare(
      "SELECT payload_retention_state AS state FROM context_snapshots WHERE snapshot_id = ?",
    ).get("invalid-boundary")).toEqual({ state: "purge_pending" });
    expect(database.prepare(
      "SELECT sealed_payload_ciphertext AS ciphertext FROM tool_calls_v2 WHERE tool_call_id = ?",
    ).get("review-required")).toEqual({ ciphertext: "ciphertext-review-required" });
  });

  it("moves 100 malformed boundaries aside so a valid tail advances in the next batch", () => {
    const database = createDatabase();
    for (let index = 0; index < 100; index += 1) {
      addContext(database, `malformed-${String(index).padStart(3, "0")}`, "0", "completed");
    }
    addContext(database, "valid-tail", iso(-1), "completed");

    expect(executePrivacyRetentionAuthorityOperation(database, {
      version: 1, type: "privacy.retention.run-batch", trigger: "periodic",
      now, limit: 100,
    })).toEqual({
      kind: "privacy-retention-batch", processed: 100, purged: 0, retained: 0,
      retried: 100, deadLettered: 0, hasMore: true, queueDepth: 101,
      oldestAgeMs: 0,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM privacy_retention_attempts WHERE status = 'pending'",
    ).get()).toEqual({ count: 100 });

    expect(executePrivacyRetentionAuthorityOperation(database, {
      version: 1, type: "privacy.retention.run-batch", trigger: "periodic",
      now, limit: 100,
    })).toEqual({
      kind: "privacy-retention-batch", processed: 1, purged: 1, retained: 0,
      retried: 0, deadLettered: 0, hasMore: false, queueDepth: 100,
      oldestAgeMs: 0,
    });
    expect(database.prepare(
      "SELECT payload_retention_state AS state FROM context_snapshots WHERE snapshot_id = 'valid-tail'",
    ).get()).toEqual({ state: "purged" });
  });

  it("rejects an oversized batch before touching storage", () => {
    const database = createDatabase();
    expect(() => executePrivacyRetentionAuthorityOperation(database, {
      version: 1,
      type: "privacy.retention.run-batch",
      trigger: "periodic",
      now,
      limit: 101,
    })).toThrow("Privacy retention authority operation is invalid");
  });

  it("durably retries one broken candidate, continues the tail, and dead-letters at eight", () => {
    const database = createDatabase();
    addContext(database, "broken", iso(-2_000), "completed");
    addContext(database, "tail", iso(-1_000), "completed");
    database.exec(`
      CREATE TRIGGER reject_broken_retention
      BEFORE DELETE ON context_snapshot_bodies
      WHEN OLD.snapshot_id = 'broken'
      BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END;
    `);

    let runNow = now;
    expect(executePrivacyRetentionAuthorityOperation(database, {
      version: 1, type: "privacy.retention.run-batch", trigger: "periodic",
      now: runNow, limit: 100,
    })).toMatchObject({ processed: 2, purged: 1, retried: 1, deadLettered: 0,
      hasMore: false, queueDepth: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM context_snapshot_bodies WHERE snapshot_id = 'broken'",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT payload_retention_state AS state FROM context_snapshots WHERE snapshot_id = 'tail'",
    ).get()).toEqual({ state: "purged" });

    for (let attempt = 2; attempt <= 8; attempt += 1) {
      runNow += 2 ** (attempt - 1) * 1_000;
      const result = executePrivacyRetentionAuthorityOperation(database, {
        version: 1, type: "privacy.retention.run-batch", trigger: "periodic",
        now: runNow, limit: 100,
      });
      expect(result).toMatchObject({ processed: 1, purged: 0,
        retried: attempt === 8 ? 0 : 1,
        deadLettered: attempt === 8 ? 1 : 0 });
    }
    expect(database.prepare(
      `SELECT status, attempts, last_error AS lastError,
              dead_lettered_at IS NOT NULL AS deadLettered
       FROM privacy_retention_attempts
       WHERE category = 'context_snapshot_payload' AND candidate_id = 'broken'`,
    ).get()).toEqual({ status: "dead_letter", attempts: 8,
      lastError: "purge_failed", deadLettered: 1 });
    expect(executePrivacyRetentionAuthorityOperation(database, {
      version: 1, type: "privacy.retention.run-batch", trigger: "startup_recovery",
      now: runNow + 24 * 60 * 60 * 1_000, limit: 100,
    })).toMatchObject({ processed: 0, queueDepth: 0, hasMore: false });
  });
});
