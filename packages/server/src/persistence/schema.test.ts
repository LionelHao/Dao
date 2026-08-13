import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isAgentExecution } from "@native-im/core";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_SCHEMA_V6_STATEMENT_COUNT_FOR_TEST,
  configureAuthorityConnection,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToPreviousVersionForTest,
  migrateAuthorityDatabaseToVersion4ForTest,
  migrateAuthorityDatabaseToVersion3ForTest,
  migrateAuthorityDatabaseToVersion2ForTest,
  readSchemaVersion,
  listSnapshotCacheTables,
  migrateSnapshotCacheDatabase,
  SNAPSHOT_CACHE_BUSY_TIMEOUT_MS,
  SNAPSHOT_CACHE_SCHEMA_VERSION,
  validateSnapshotCacheSchema,
} from "./schema.js";

const AUTHORITY_TABLES = [
  "actors",
  "agent_compensation_requests",
  "agent_execution_attempts",
  "agent_execution_completions",
  "agent_execution_steps",
  "agent_executions",
  "agent_fence_replacements",
  "agent_invocation_intents",
  "agent_judgments",
  "agent_tool_confirmations",
  "agent_tool_dispatches",
  "agent_tool_grants",
  "calibration_signals",
  "events",
  "human_read_receipts",
  "idempotency_records",
  "messages",
  "open_items",
  "outbox_deliveries",
  "room_audit",
  "room_invitations",
  "room_memberships",
  "rooms",
  "schema_migrations",
  "sessions",
  "streams",
] as const;
const V1_MIGRATION_CHECKSUM =
  "34117e7de4fb7c8eb36b5363bc178e45a82b08c668ca712a7b7e5e82343a6358";
const V2_MIGRATION_CHECKSUM =
  "b7521b7e6095e01834c2f4183dc5c04c52848f9c76483c344e111b5c03662c1c";
const V3_MIGRATION_CHECKSUM =
  "0f4ba33b182ae9b5c84874961265a4739a23cc80db4d8c6675af47646ceb81ee";
const V4_MIGRATION_CHECKSUM =
  "28a42b0ccfdc0d5c2eb111bc783cdd30c2678eb162cf9d77dcc2b6b3823f169c";
const V5_MIGRATION_CHECKSUM =
  "3f90cdeb9b7c9e04f432aac809f340033f6d9a2ea1a6a5bd8d9ab50fab8d891d";
const V6_MIGRATION_CHECKSUM =
  "f068c43f2e3e479a4fbf5c36903a3481d2cf6d9f62b3957815359f4084280468";

const V6_INDEXES = [
  "agent_execution_attempts_recovery",
  "agent_execution_attempts_room_enqueue",
  "agent_execution_steps_execution_attempt",
  "agent_executions_recovery",
  "agent_executions_agent_recovery",
  "agent_executions_room_queue",
  "agent_fence_replacements_replacement_old",
  "agent_fence_replacements_replay",
  "agent_tool_confirmations_expiry",
  "agent_tool_dispatches_state",
  "agent_tool_dispatches_one_unsettled",
  "agent_tool_grants_expiry",
  "agent_tool_grants_execution_step",
  "agent_tool_grants_recovery_binding",
  "agent_tool_grants_recovery_expiry",
  "agent_tool_confirmations_recovery_expiry",
] as const;

const STREAMING_KEYSET_INDEXES = [
  "agent_executions_room_id_id",
  "agent_judgments_room_id_id",
  "calibration_signals_room_id_id",
  "messages_room_id_id",
  "open_items_room_id_id",
  "room_memberships_catalog_actor_kind_room",
] as const;

interface LogicalSnapshot {
  readonly schemaVersion: number;
  readonly tables: readonly {
    readonly name: string;
    readonly sql: string | null;
    readonly rows: readonly Record<string, unknown>[];
  }[];
}

function withDatabase<Result>(operation: (database: DatabaseSync) => Result): Result {
  const directory = mkdtempSync(join(tmpdir(), "native-im-authority-schema-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));

  try {
    return operation(database);
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function tableColumns(database: DatabaseSync, tableName: string): readonly string[] {
  return database
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String(row.name));
}

function queryPlanDetails(
  database: DatabaseSync,
  sql: string,
  ...parameters: readonly (string | number)[]
): readonly string[] {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => String(row.detail));
}

function databaseWithoutTransactionState(database: DatabaseSync): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === "isTransaction") {
        throw new Error("Node 22.13 does not expose DatabaseSync.isTransaction");
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function databaseWithFailingRollback(database: DatabaseSync): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (sql === "ROLLBACK") {
            throw new Error("simulated rollback failure");
          }
          target.exec(sql);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function databaseWithSchemaChangeBeforeBegin(database: DatabaseSync): DatabaseSync {
  let changed = false;
  return new Proxy(database, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (!changed && sql === "BEGIN IMMEDIATE") {
            changed = true;
            target.exec("DROP TABLE sessions");
          }
          target.exec(sql);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function databaseWithCorruptedOutboxDdl(database: DatabaseSync): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          const statement = sql.startsWith("CREATE TABLE outbox_deliveries")
            ? sql.replace("    last_error TEXT,\n", "")
            : sql;
          target.exec(statement);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function tamperSchemaSql(
  database: DatabaseSync,
  tableName: string,
  search: string,
  replacement: string,
): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(tableName);
  if (row === undefined || typeof row.sql !== "string") {
    throw new Error(`missing schema SQL for ${tableName}`);
  }
  const tampered = row.sql.replace(search, replacement);
  if (tampered === row.sql) {
    throw new Error(`schema probe did not match ${tableName}`);
  }

  if (!/^[a-z_]+$/.test(tableName)) {
    throw new Error("unsafe schema probe table name");
  }
  const triggers = database
    .prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`,
    )
    .all(tableName)
    .map((trigger) => String(trigger.sql));
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec(`DROP TABLE "${tableName}"`);
  database.exec(tampered);
  for (const trigger of triggers) {
    database.exec(trigger);
  }
}

function expectSqlRejected(database: DatabaseSync, sql: string): void {
  expect(() => database.exec(sql)).toThrow();
}

function createV1Fixture(
  database: DatabaseSync,
  checksum = V1_MIGRATION_CHECKSUM,
): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE actors (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      display_name TEXT NOT NULL,
      reachability TEXT,
      readiness TEXT,
      tool_permissions_json TEXT NOT NULL DEFAULT '[]'
    ) STRICT;

    CREATE TABLE sessions (
      family_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES actors(id),
      access_token_hash TEXT PRIMARY KEY,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      access_expires_at INTEGER NOT NULL,
      refresh_expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    ) STRICT;

    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      role TEXT,
      participation TEXT,
      tool_permissions_json TEXT NOT NULL DEFAULT '[]',
      joined_at TEXT,
      configured_at TEXT,
      PRIMARY KEY (room_id, actor_id)
    ) STRICT;

    CREATE TABLE room_invitations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      inviter_actor_id TEXT NOT NULL REFERENCES actors(id),
      invitee_actor_id TEXT NOT NULL REFERENCES actors(id),
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
      created_at TEXT NOT NULL,
      decision_actor_id TEXT REFERENCES actors(id),
      decided_at TEXT
    ) STRICT;

    CREATE TABLE room_audit (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN (
        'room.created', 'room.renamed', 'room.archived', 'room.human.invited',
        'room.invitation.accepted', 'room.invitation.rejected',
        'room.agent.configured', 'room.member.removed', 'room.member.role.changed'
      )),
      room_id TEXT NOT NULL REFERENCES rooms(id),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      result TEXT NOT NULL CHECK (result IN (
        'created', 'renamed', 'archived', 'pending', 'accepted', 'rejected',
        'configured', 'removed', 'role-changed'
      )),
      timestamp TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    ) STRICT;

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      author_id TEXT NOT NULL REFERENCES actors(id),
      author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
      body TEXT NOT NULL,
      sent_at TEXT NOT NULL
    ) STRICT;
  `);
  database
    .prepare(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at)
       VALUES (1, 'initial-authority', ?, '2026-08-10T00:00:00.000Z')`,
    )
    .run(checksum);
  database.exec("PRAGMA user_version = 1");
}

function seedV1History(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO actors (
      id, kind, display_name, reachability, readiness, tool_permissions_json
    ) VALUES
      ('human-1', 'human', 'Ada', 'online', NULL, '[]'),
      ('agent-1', 'agent', 'Sage', NULL, 'ready', '["summarize"]');

    INSERT INTO rooms (id, name, status, created_at) VALUES
      ('room-1', 'Launch', 'active', '2026-08-09T00:00:00.000Z'),
      ('room-2', 'Review', 'active', '2026-08-09T01:00:00.000Z');

    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at
    ) VALUES
      ('room-1', 'human-1', 'human', 'owner', NULL, '[]',
       '2026-08-09T00:00:00.000Z', NULL),
      ('room-1', 'agent-1', 'agent', NULL, 'active', '["summarize"]',
       NULL, '2026-08-09T00:01:00.000Z');

    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES (
      'message-1', 'room-1', 'human-1', 'human', 'legacy history',
      '2026-08-09T00:02:00.000Z'
    );
  `);
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

function seedV6ToolExecution(database: DatabaseSync): void {
  const hash = "a".repeat(64);
  database.exec(`
    INSERT INTO actors (id, kind, display_name) VALUES
      ('v6-human', 'human', 'V6 Human'), ('v6-agent', 'agent', 'V6 Agent'),
      ('v6-agent-2', 'agent', 'V6 Agent 2');
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('v6-room', 'V6', 'active', '2026-08-13T00:00:00.000Z');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'v6-human', 0, 1), ('identity', 'v6-agent', 0, 1),
           ('identity', 'v6-agent-2', 0, 1), ('room', 'v6-room', 0, 1);
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES ('v6-message', 'v6-room', 'v6-human', 'human', 'invoke',
            '2026-08-13T00:00:00.000Z');
    INSERT INTO agent_executions (
      id, room_id, agent_id, source_message_id, requester_actor_id, state,
      action_category, tool_dispatch_phase, current_tool_id,
      current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
      recovery_cursor, queued_at, started_at, updated_at
    ) VALUES (
      'v6-execution', 'v6-room', 'v6-agent', 'v6-message', 'v6-human',
      'running', 'tool_call', 'dispatched', 'summarize', 1, 1, 1,
      'test-provider', 'test-model', 1, '2026-08-13T00:00:00.000Z',
      '2026-08-13T00:00:01.000Z', '2026-08-13T00:00:01.000Z'
    );
    INSERT INTO agent_execution_attempts (
      execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
      action_category, tool_dispatch_phase, started_at, finished_at,
      error_code, next_retry_at, recovery_cursor
    ) VALUES (
      'v6-execution', 'v6-room', 1, 1, 1, 'running', 'tool_call', 'dispatched',
      '2026-08-13T00:00:01.000Z', NULL, NULL, NULL, 1
    );
    INSERT INTO agent_execution_steps (
      execution_id, attempt_seq, step_seq, step_kind, canonical_tool_call_json,
      input_sha256, output_sha256, completed_at
    ) VALUES (
      'v6-execution', 1, 1, 'tool_call', '{"toolId":"summarize"}',
      '${hash}', '${hash}', '2026-08-13T00:00:01.000Z'
    );
    INSERT INTO agent_tool_grants (
      id, execution_id, attempt_seq, tool_call_step_seq, agent_id, room_id, tool_id,
      parameter_hash, tool_plan_hash, confirmation_requirement, issued_at, expires_at, consumed_at
    ) VALUES (
      'v6-grant', 'v6-execution', 1, 1, 'v6-agent', 'v6-room', 'summarize',
      '${hash}', '${hash}', 'read_only', '2026-08-13T00:00:01.000Z', '2026-08-13T00:01:01.000Z', NULL
    );
    INSERT INTO agent_tool_dispatches (
      id, execution_id, attempt_seq, grant_id, tool_id, parameter_hash,
      state, dispatched_at, settled_at, closed_summary, sealed_compensation
    ) VALUES (
      'v6-dispatch', 'v6-execution', 1, 'v6-grant', 'summarize', '${hash}',
      'dispatched', '2026-08-13T00:00:02.000Z', NULL, NULL, NULL
    );
  `);
}

describe("authority SQLite schema", () => {
  it("configures and verifies the durability and concurrency pragmas", () => {
    withDatabase((database) => {
      database.exec("PRAGMA foreign_keys = OFF");

      configureAuthorityConnection(database);

      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(database.prepare("PRAGMA synchronous").get()).toEqual({
        synchronous: 2,
      });
      const busyTimeout = Number(database.prepare("PRAGMA busy_timeout").get()?.timeout);
      expect(busyTimeout).toBeGreaterThan(0);
      expect(busyTimeout).toBeLessThanOrEqual(5_000);
    });
  });

  it("migrates a fresh database through immutable v1-v6 to the complete schema", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);

      expect(AUTHORITY_SCHEMA_VERSION).toBe(6);
      expect(readSchemaVersion(database)).toBe(6);
      expect(listAuthorityTables(database)).toEqual(AUTHORITY_TABLES);
      expect(
        database
          .prepare(
            "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
          )
          .all(),
      ).toEqual([
        {
          version: 1,
          name: "initial-authority",
          checksum: V1_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 2,
          name: "collaboration-facts-and-streams",
          checksum: V2_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 3,
          name: "closed-outbox-targets",
          checksum: V3_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 4,
          name: "canonical-collaboration-facts",
          checksum: V4_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 5,
          name: "streaming-keyset-indexes",
          checksum: V5_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 6,
          name: "agent-runtime-authority",
          checksum: V6_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ]);
      expect(tableColumns(database, "actors")).toContain("catalog_revision");
      expect(tableColumns(database, "room_memberships")).toContain(
        "access_revision",
      );
      expect(tableColumns(database, "streams")).toEqual([
        "stream_kind",
        "stream_id",
        "head_seq",
        "retained_from_seq",
      ]);
      expect(tableColumns(database, "events")).toEqual([
        "event_id",
        "stream_kind",
        "stream_id",
        "stream_seq",
        "room_id",
        "actor_id",
        "event_type",
        "occurred_at",
        "payload_json",
      ]);
      expect(tableColumns(database, "idempotency_records")).toEqual([
        "scope",
        "key",
        "request_hash",
        "response_json",
        "status_code",
        "created_at",
        "expires_at",
      ]);
      expect(tableColumns(database, "outbox_deliveries")).toEqual([
        "id",
        "event_id",
        "target_kind",
        "target_id",
        "stream_seq",
        "status",
        "attempts",
        "available_at",
        "delivered_at",
        "last_error",
      ]);
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
    });
  });

  it("migrates fresh and every immutable historical version through v6", () => {
    const createHistoricalDatabase = (
      database: DatabaseSync,
      version: 1 | 2 | 3 | 4 | 5,
    ): void => {
      createV1Fixture(database);
      seedV1History(database);
      if (version >= 2) migrateAuthorityDatabaseToVersion2ForTest(database);
      if (version >= 3) migrateAuthorityDatabaseToVersion3ForTest(database);
      if (version >= 4) migrateAuthorityDatabaseToVersion4ForTest(database);
      if (version >= 5) migrateAuthorityDatabaseToPreviousVersionForTest(database);
    };

    for (const version of [1, 2, 3, 4, 5] as const) {
      withDatabase((database) => {
        createHistoricalDatabase(database, version);
        expect(readSchemaVersion(database)).toBe(version);

        migrateAuthorityDatabase(database);

        expect(AUTHORITY_SCHEMA_VERSION).toBe(6);
        expect(readSchemaVersion(database)).toBe(6);
        expect(listAuthorityTables(database)).toEqual(AUTHORITY_TABLES);
        expect(database.prepare(
          "SELECT id, kind, display_name FROM actors WHERE id IN ('human-1', 'agent-1') ORDER BY id",
        ).all()).toEqual([
          { id: "agent-1", kind: "agent", display_name: "Sage" },
          { id: "human-1", kind: "human", display_name: "Ada" },
        ]);
        expect(database.prepare(
          "SELECT room_id, author_id, body FROM messages WHERE id = 'message-1'",
        ).get()).toEqual({ room_id: "room-1", author_id: "human-1", body: "legacy history" });
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (" +
                V6_INDEXES.map(() => "?").join(", ") +
                ") ORDER BY name",
            )
            .all(...V6_INDEXES)
            .map((row) => String(row.name)),
        ).toEqual([...V6_INDEXES].sort());
        expect(
          database
            .prepare("SELECT checksum FROM schema_migrations WHERE version = 5")
            .get(),
        ).toEqual({ checksum: V5_MIGRATION_CHECKSUM });
      });
    }
  });

  it("rebuilds legitimate v5 executions into closed v6 attempts", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToPreviousVersionForTest(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('legacy-human', 'human', 'Legacy Human'),
               ('legacy-agent', 'agent', 'Legacy Agent');
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('legacy-room', 'Legacy', 'active', '2026-08-13T00:00:00.000Z');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'legacy-human', 0, 1),
               ('identity', 'legacy-agent', 0, 1),
               ('room', 'legacy-room', 0, 1);
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('legacy-message', 'legacy-room', 'legacy-human', 'human',
                'legacy invocation', '2026-08-13T00:00:01.000Z');
        INSERT INTO agent_executions (
          id, room_id, agent_id, trigger_message_id, status, started_at,
          completed_at, result_json, requester_actor_id, tool_name
        ) VALUES
          ('legacy-completed', 'legacy-room', 'legacy-agent', 'legacy-message',
           'completed', '2026-08-13T00:00:02.000Z',
           '2026-08-13T00:00:03.000Z', '{"ok":true}', 'legacy-human', 'summarize'),
          ('legacy-failed', 'legacy-room', 'legacy-agent', 'legacy-message',
           'failed', '2026-08-13T00:00:04.000Z',
           '2026-08-13T00:00:05.000Z', '{"error":"legacy"}', 'legacy-human', 'summarize'),
          ('legacy-interrupted', 'legacy-room', 'legacy-agent', 'legacy-message',
           'interrupted', '2026-08-13T00:00:06.000Z', NULL, NULL,
           'legacy-human', 'summarize'),
          ('legacy-running', 'legacy-room', 'legacy-agent', 'legacy-message',
           'running', '2026-08-13T00:00:07.000Z', NULL, NULL,
           'legacy-human', 'summarize');
      `);

      migrateAuthorityDatabase(database);

      expect(
        database
          .prepare(
            `SELECT state AS status, current_attempt_seq AS currentAttemptSeq,
                    retry_cycle AS retryCycle, retry_ordinal AS retryOrdinal,
                    action_category AS actionCategory,
                    tool_dispatch_phase AS toolDispatchPhase,
                    terminal_error_code AS terminalErrorCode
             FROM agent_executions WHERE id = 'legacy-running'`,
          )
          .get(),
      ).toMatchObject({
        status: "failed",
        currentAttemptSeq: 1,
        retryCycle: 1,
        retryOrdinal: 1,
        actionCategory: "tool_call",
        toolDispatchPhase: "finished",
        terminalErrorCode: "side_effect_outcome_unknown",
      });
      expect(
        database
          .prepare(
            `SELECT state, action_category, tool_dispatch_phase, error_code
             FROM agent_execution_attempts
             WHERE execution_id = 'legacy-running' AND attempt_seq = 1`,
          )
          .get(),
      ).toEqual({
        state: "failed",
        action_category: "tool_call",
        tool_dispatch_phase: "finished",
        error_code: "side_effect_outcome_unknown",
      });
      expect(
        database
          .prepare(
            `SELECT state, cancellation_reason, legacy_result_json AS resultJson,
                    current_tool_id AS toolId
             FROM agent_executions WHERE id = 'legacy-interrupted'`,
          )
          .get(),
      ).toEqual({
        state: "cancelled",
        cancellation_reason: "legacy_interrupted",
        resultJson: null,
        toolId: "summarize",
      });
      expect(
        database
          .prepare(
            "SELECT legacy_result_json AS resultJson FROM agent_executions WHERE id = 'legacy-completed'",
          )
          .get(),
      ).toEqual({ resultJson: '{"ok":true}' });
    });
  });

  it("fails closed for legacy completed or failed rows without completion and preserves interrupted/running completion timestamps", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToPreviousVersionForTest(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('legacy-human-null', 'human', 'Legacy Human'),
               ('legacy-agent-null', 'agent', 'Legacy Agent');
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('legacy-null-room', 'Legacy', 'active', '2026-08-13T00:00:00.000Z');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'legacy-human-null', 0, 1),
               ('identity', 'legacy-agent-null', 0, 1),
               ('room', 'legacy-null-room', 0, 1);
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('legacy-null-message', 'legacy-null-room', 'legacy-human-null',
                'human', 'legacy', '2026-08-13T00:00:00.000Z');
        INSERT INTO agent_executions (
          id, room_id, agent_id, trigger_message_id, status, started_at,
          completed_at, result_json, requester_actor_id, tool_name
        ) VALUES
          ('legacy-completed-null', 'legacy-null-room', 'legacy-agent-null',
           'legacy-null-message', 'completed', '2026-08-13T00:00:01.000Z',
           NULL, NULL, 'legacy-human-null', 'tool'),
          ('legacy-failed-null', 'legacy-null-room', 'legacy-agent-null',
           'legacy-null-message', 'failed', '2026-08-13T00:00:02.000Z',
           NULL, NULL, 'legacy-human-null', 'tool');
      `);
      const before = snapshot(database);
      expect(() => migrateAuthorityDatabase(database)).toThrow();
      expect(snapshot(database)).toEqual(before);
    });

    withDatabase((database) => {
      migrateAuthorityDatabaseToPreviousVersionForTest(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('legacy-human-preserve', 'human', 'Legacy Human'),
               ('legacy-agent-preserve', 'agent', 'Legacy Agent');
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('legacy-preserve-room', 'Legacy', 'active', '2026-08-13T00:00:00.000Z');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'legacy-human-preserve', 0, 1),
               ('identity', 'legacy-agent-preserve', 0, 1),
               ('room', 'legacy-preserve-room', 0, 1);
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('legacy-preserve-message', 'legacy-preserve-room',
                'legacy-human-preserve', 'human', 'legacy',
                '2026-08-13T00:00:00.000Z');
        INSERT INTO agent_executions (
          id, room_id, agent_id, trigger_message_id, status, started_at,
          completed_at, result_json, requester_actor_id, tool_name
        ) VALUES
          ('legacy-interrupted-preserve', 'legacy-preserve-room',
           'legacy-agent-preserve', 'legacy-preserve-message', 'interrupted',
           '2026-08-13T00:00:01.000Z', '2026-08-13T00:00:02.000Z',
           '{"legacy":"interrupted"}', 'legacy-human-preserve', 'tool-interrupted'),
          ('legacy-running-preserve', 'legacy-preserve-room',
           'legacy-agent-preserve', 'legacy-preserve-message', 'running',
           '2026-08-13T00:00:03.000Z', '2026-08-13T00:00:04.000Z',
           '{"legacy":"running"}', 'legacy-human-preserve', 'tool-running');
      `);
      migrateAuthorityDatabase(database);
      expect(
        database.prepare(
          `SELECT id, source_message_id, requester_actor_id, started_at,
                  completed_at, updated_at, current_tool_id, legacy_result_json
           FROM agent_executions
           WHERE id IN ('legacy-interrupted-preserve', 'legacy-running-preserve')
           ORDER BY id`,
        ).all(),
      ).toEqual([
        {
          id: "legacy-interrupted-preserve",
          source_message_id: "legacy-preserve-message",
          requester_actor_id: "legacy-human-preserve",
          started_at: "2026-08-13T00:00:01.000Z",
          completed_at: "2026-08-13T00:00:02.000Z",
          updated_at: "2026-08-13T00:00:02.000Z",
          current_tool_id: "tool-interrupted",
          legacy_result_json: '{"legacy":"interrupted"}',
        },
        {
          id: "legacy-running-preserve",
          source_message_id: "legacy-preserve-message",
          requester_actor_id: "legacy-human-preserve",
          started_at: "2026-08-13T00:00:03.000Z",
          completed_at: "2026-08-13T00:00:04.000Z",
          updated_at: "2026-08-13T00:00:04.000Z",
          current_tool_id: "tool-running",
          legacy_result_json: '{"legacy":"running"}',
        },
      ]);
    });
  });

  it("rolls every v6 statement back to v5 without changing data", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToPreviousVersionForTest(database);
      const before = snapshot(database);
      const statementCount = AUTHORITY_SCHEMA_V6_STATEMENT_COUNT_FOR_TEST;

      for (let failAfterStatement = 1; failAfterStatement <= statementCount; failAfterStatement += 1) {
        expect(() =>
          migrateAuthorityDatabase(database, { failAfterStatement }),
        ).toThrow(/injected migration failure/i);
        expect(snapshot(database)).toEqual(before);
      }
    });
  });

  it("refuses missing v6 indexes and corrupted v6 execution facts on startup", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec("DROP INDEX agent_tool_dispatches_state");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/physical contract/i);
    });

    const corruptions: readonly ((database: DatabaseSync) => void)[] = [
      (database) => {
        database.exec("PRAGMA ignore_check_constraints = ON");
        database.exec("UPDATE agent_executions SET state = 'invalid' WHERE id = 'v6-execution'");
        database.exec("PRAGMA ignore_check_constraints = OFF");
      },
      (database) => {
        database.exec("PRAGMA ignore_check_constraints = ON");
        database.exec(
          "UPDATE agent_execution_attempts SET retry_ordinal = 4 WHERE execution_id = 'v6-execution' AND attempt_seq = 1",
        );
        database.exec("PRAGMA ignore_check_constraints = OFF");
      },
      (database) => {
        database.exec("PRAGMA ignore_check_constraints = ON");
        database.exec(
          "UPDATE agent_execution_attempts SET state = 'queued', started_at = NULL, tool_dispatch_phase = 'not_started', enqueue_stream_seq = 0 WHERE execution_id = 'v6-execution' AND attempt_seq = 1",
        );
        database.exec("PRAGMA ignore_check_constraints = OFF");
      },
      (database) => {
        database.exec("PRAGMA foreign_keys = OFF");
        database.exec(
          "UPDATE agent_tool_dispatches SET grant_id = 'missing-grant' WHERE id = 'v6-dispatch'",
        );
        database.exec("PRAGMA foreign_keys = ON");
      },
    ];
    for (const corrupt of corruptions) {
      withDatabase((database) => {
        migrateAuthorityDatabase(database);
        database.exec(`
          INSERT INTO actors (id, kind, display_name) VALUES
            ('v6-human', 'human', 'V6 Human'), ('v6-agent', 'agent', 'V6 Agent');
          INSERT INTO rooms (id, name, status, created_at)
          VALUES ('v6-room', 'V6', 'active', '2026-08-13T00:00:00.000Z');
          INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
          VALUES ('identity', 'v6-human', 0, 1), ('identity', 'v6-agent', 0, 1),
                 ('room', 'v6-room', 0, 1);
          INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
          VALUES ('v6-message', 'v6-room', 'v6-human', 'human', 'invoke',
                  '2026-08-13T00:00:00.000Z');
          INSERT INTO agent_executions (
            id, room_id, agent_id, source_message_id, requester_actor_id, state,
            action_category, tool_dispatch_phase, current_tool_id,
            current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
            recovery_cursor, queued_at, started_at, updated_at
          ) VALUES (
            'v6-execution', 'v6-room', 'v6-agent', 'v6-message', 'v6-human',
            'running', 'tool_call', 'dispatched', 'summarize', 1, 1, 1,
            'test-provider', 'test-model', 1, '2026-08-13T00:00:00.000Z',
            '2026-08-13T00:00:01.000Z', '2026-08-13T00:00:01.000Z'
          );
          INSERT INTO agent_execution_attempts (
            execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
            action_category, tool_dispatch_phase, started_at, finished_at,
            error_code, next_retry_at, recovery_cursor
          ) VALUES (
            'v6-execution', 'v6-room', 1, 1, 1, 'running', 'tool_call', 'dispatched',
            '2026-08-13T00:00:01.000Z', NULL, NULL, NULL, 1
          );
          INSERT INTO agent_execution_steps (
            execution_id, attempt_seq, step_seq, step_kind, canonical_tool_call_json,
            input_sha256, output_sha256, completed_at
          ) VALUES (
            'v6-execution', 1, 1, 'tool_call', '{"toolId":"summarize"}',
            '${"a".repeat(64)}', '${"a".repeat(64)}', '2026-08-13T00:00:01.000Z'
          );
          INSERT INTO agent_tool_grants (
            id, execution_id, attempt_seq, tool_call_step_seq, agent_id, room_id, tool_id,
            parameter_hash, tool_plan_hash, confirmation_requirement, issued_at, expires_at, consumed_at
          ) VALUES (
            'v6-grant', 'v6-execution', 1, 1, 'v6-agent', 'v6-room', 'summarize',
            '${"a".repeat(64)}', '${"a".repeat(64)}', 'read_only', '2026-08-13T00:00:01.000Z',
            '2026-08-13T00:01:01.000Z', NULL
          );
          INSERT INTO agent_tool_dispatches (
            id, execution_id, attempt_seq, grant_id, tool_id, parameter_hash,
            state, dispatched_at, settled_at, closed_summary, sealed_compensation
          ) VALUES (
            'v6-dispatch', 'v6-execution', 1, 'v6-grant', 'summarize',
            '${"a".repeat(64)}', 'dispatched', '2026-08-13T00:00:02.000Z', NULL,
            NULL, NULL
          );
        `);
        corrupt(database);
        expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);
      });
    }
  });

  it("refuses C1 attempt, intent, grant, dispatch, lineage, and fence corruption", () => {
    const corruptions: readonly {
      readonly name: string;
      readonly corrupt: (database: DatabaseSync) => void;
    }[] = [
      {
        name: "attempt sequence beyond execution current",
        corrupt(database) {
          database.exec(`
            INSERT INTO agent_execution_attempts (
              execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
              action_category, tool_dispatch_phase, started_at, finished_at,
              error_code, next_retry_at, recovery_cursor
            ) VALUES (
              'v6-execution', 'v6-room', 2, 1, 2, 'completed', 'tool_call', 'finished',
              '2026-08-13T00:00:02.000Z', '2026-08-13T00:00:03.000Z',
              NULL, NULL, 0
            )
          `);
        },
      },
      {
        name: "nonterminal attempt below current",
        corrupt(database) {
          database.exec(
            "UPDATE agent_executions SET current_attempt_seq = 2, retry_ordinal = 2 WHERE id = 'v6-execution'",
          );
          database.exec(`
            INSERT INTO agent_execution_attempts (
              execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
              action_category, tool_dispatch_phase, started_at, finished_at,
              error_code, next_retry_at, recovery_cursor
            ) VALUES (
              'v6-execution', 'v6-room', 2, 1, 2, 'running', 'tool_call', 'dispatched',
              '2026-08-13T00:00:02.000Z', NULL, NULL, NULL, 0
            )
          `);
        },
      },
      {
        name: "intent target does not bind execution agent",
        corrupt(database) {
          database.exec(`
            INSERT INTO agent_invocation_intents (
              id, source_message_id, target_agent_id, intent_kind, execution_id, created_at
            ) VALUES (
              'v6-intent', 'v6-message', 'v6-agent-2', 'direct_mention',
              'v6-execution', '2026-08-13T00:00:00.000Z'
            )
          `);
        },
      },
      {
        name: "grant actor does not bind execution agent",
        corrupt(database) {
          database.exec("UPDATE agent_tool_grants SET agent_id = 'v6-agent-2' WHERE id = 'v6-grant'");
        },
      },
      {
        name: "dispatch exists on a model attempt",
        corrupt(database) {
          database.exec("PRAGMA ignore_check_constraints = ON");
          database.exec(`
            UPDATE agent_execution_attempts
            SET action_category = 'model_generation', tool_dispatch_phase = NULL
            WHERE execution_id = 'v6-execution' AND attempt_seq = 1
          `);
          database.exec("PRAGMA ignore_check_constraints = OFF");
        },
      },
      {
        name: "self manual retry lineage",
        corrupt(database) {
          database.exec("UPDATE agent_executions SET manual_retry_of_execution_id = id WHERE id = 'v6-execution'");
        },
      },
      {
        name: "malformed supersedes lineage JSON",
        corrupt(database) {
          database.exec("PRAGMA ignore_check_constraints = ON");
          database.exec("UPDATE agent_executions SET supersedes_execution_ids_json = '{' WHERE id = 'v6-execution'");
          database.exec("PRAGMA ignore_check_constraints = OFF");
        },
      },
      {
        name: "fence replacement references a running old attempt",
        corrupt(database) {
          database.exec(`
            INSERT INTO agent_fence_replacements (
              id, fence_message_id, old_execution_id, old_attempt_seq,
              route_job_id, selected_agent_id, expected_judgment_id,
              replacement_execution_id, created_at
            ) VALUES (
              'v6-fence', 'v6-message', 'v6-execution', 1,
              NULL, NULL, NULL, NULL,
              '2026-08-13T00:00:03.000Z'
            )
          `);
        },
      },
    ];

    for (const { name, corrupt } of corruptions) {
      withDatabase((database) => {
        migrateAuthorityDatabase(database);
        seedV6ToolExecution(database);
        corrupt(database);
        expect(() => migrateAuthorityDatabase(database), name).toThrow(/integrity|invariant/i);
      });
    }
  });

  it("seeks one exact confirmation recovery binding with 10000 expired waits", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedV6ToolExecution(database);
      database.exec(`
        WITH RECURSIVE seq(value) AS (
          VALUES (1) UNION ALL SELECT value + 1 FROM seq WHERE value < 10000
        )
        INSERT INTO agent_executions (
          id, room_id, agent_id, source_message_id, requester_actor_id, state,
          action_category, current_attempt_seq, retry_cycle, retry_ordinal,
          provider_id, model_id, recovery_cursor, queued_at, started_at, updated_at
        )
        SELECT printf('expired-wait-%05d', value), 'v6-room', 'v6-agent',
               'v6-message', 'v6-human', 'running', 'waiting_upstream',
               1, 1, 1, 'test-provider', 'test-model', 1,
               '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:01.000Z',
               '2026-08-13T00:00:01.000Z'
        FROM seq;
        INSERT INTO agent_execution_attempts (
          execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
          action_category, started_at, recovery_cursor
        )
        SELECT id, room_id, 1, 1, 1, 'running', 'waiting_upstream',
               '2026-08-13T00:00:01.000Z', 1
        FROM agent_executions WHERE id LIKE 'expired-wait-%';
        INSERT INTO agent_execution_steps (
          execution_id, attempt_seq, step_seq, step_kind, canonical_tool_call_json,
          input_sha256, output_sha256, completed_at
        )
        SELECT id, 1, 1, 'tool_call', '{"toolId":"summarize"}',
               '${"a".repeat(64)}', '${"a".repeat(64)}',
               '2026-08-13T00:00:01.000Z'
        FROM agent_executions WHERE id LIKE 'expired-wait-%';
        INSERT INTO agent_tool_grants (
          id, execution_id, attempt_seq, tool_call_step_seq, agent_id, room_id,
          tool_id, parameter_hash, tool_plan_hash, confirmation_requirement,
          issued_at, expires_at
        )
        SELECT 'grant-' || id, id, 1, 1, 'v6-agent', 'v6-room', 'summarize',
               '${"a".repeat(64)}', '${"a".repeat(64)}', 'side_effect',
               '2026-08-13T00:00:01.000Z', '2026-08-13T00:00:02.000Z'
        FROM agent_executions WHERE id LIKE 'expired-wait-%';
      `);
      const plan = queryPlanDetails(database, `
        SELECT execution.id
        FROM agent_executions AS execution
        JOIN agent_execution_attempts AS attempt
          ON attempt.execution_id = execution.id
         AND attempt.attempt_seq = execution.current_attempt_seq
        JOIN agent_tool_grants AS grant INDEXED BY agent_tool_grants_execution_step
          ON grant.execution_id = execution.id
         AND grant.attempt_seq = execution.current_attempt_seq
         AND grant.tool_call_step_seq = execution.recovery_cursor
         AND grant.confirmation_requirement = 'side_effect'
         AND grant.consumed_at IS NULL
        LEFT JOIN agent_tool_confirmations AS confirmation
          ON confirmation.grant_id = grant.id AND confirmation.consumed_at IS NULL
        WHERE execution.state = 'running' AND attempt.state = 'running'
          AND execution.action_category = 'waiting_upstream'
          AND execution.tool_dispatch_phase IS NULL
          AND attempt.action_category = 'waiting_upstream'
          AND attempt.tool_dispatch_phase IS NULL
          AND execution.agent_id = ?
          AND execution.id = ?
          AND (grant.expires_at <= ? OR confirmation.expires_at <= ?)
        LIMIT 2
      `, "v6-agent", "expired-wait-10000", "2026-08-13T00:00:03.000Z",
      "2026-08-13T00:00:03.000Z");
      expect(plan.some((detail) =>
        detail.includes("agent_tool_grants_execution_step") &&
        /execution_id=\? AND attempt_seq=\? AND tool_call_step_seq=\?/i.test(detail),
      )).toBe(true);
      expect(plan.some((detail) =>
        detail.includes("sqlite_autoindex_agent_tool_confirmations") &&
        detail.includes("grant_id=?"),
      )).toBe(true);
      expect(plan.join("\n")).not.toMatch(/SCAN grant|SCAN confirmation|AUTOMATIC|TEMP B-TREE/);
    });
  });

  it("allows a durable fence before routing and requires the routing tuple to be all-or-none", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedV6ToolExecution(database);

      expect(() => database.exec(`
        INSERT INTO agent_fence_replacements (
          id, fence_message_id, old_execution_id, old_attempt_seq,
          route_job_id, selected_agent_id, expected_judgment_id,
          replacement_execution_id, created_at
        ) VALUES (
          'v6-staged-fence', 'v6-message', 'v6-execution', 1,
          NULL, NULL, NULL, NULL, '2026-08-13T00:00:03.000Z'
        )
      `)).not.toThrow();
      expect(() => database.exec(`
        INSERT INTO agent_fence_replacements (
          id, fence_message_id, old_execution_id, old_attempt_seq,
          route_job_id, selected_agent_id, expected_judgment_id,
          replacement_execution_id, created_at
        ) VALUES (
          'v6-partial-fence', 'v6-message', 'v6-execution', 1,
          'route-1', NULL, NULL, NULL, '2026-08-13T00:00:04.000Z'
        )
      `)).toThrow();
    });
  });

  it("physically refuses an execution without its required source message", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedV6ToolExecution(database);
      expect(() => database.exec(
        "UPDATE agent_executions SET source_message_id = NULL WHERE id = 'v6-execution'",
      )).toThrow(/NOT NULL/i);
    });
  });

  it("physically rejects the core-visible empty, noncanonical, and unsafe v6 boundaries", () => {
    const updates = [
      "UPDATE agent_executions SET current_tool_id = ' ' WHERE id = 'v6-execution'",
      "UPDATE agent_executions SET updated_at = '2026-08-13T00:00:01Z' WHERE id = 'v6-execution'",
      "UPDATE agent_executions SET current_attempt_seq = 9007199254740992 WHERE id = 'v6-execution'",
      `UPDATE agent_executions
       SET state = 'cancelled', completed_at = '2026-08-13T00:00:02.000Z',
           updated_at = '2026-08-13T00:00:02.000Z', cancellation_reason = ''
       WHERE id = 'v6-execution'`,
    ] as const;
    for (const update of updates) {
      withDatabase((database) => {
        migrateAuthorityDatabase(database);
        seedV6ToolExecution(database);
        expect(() => database.exec(update)).toThrow(/CHECK/i);
      });
    }
    expect(isAgentExecution({
      id: "execution", roomId: "room", sourceMessageId: "source", requesterId: "human", agentId: "agent",
      status: "queued", actionCategory: "tool_call", toolDispatchPhase: "not_started", currentToolId: " ",
      currentAttemptSeq: 1, retryCycle: 1, retryOrdinal: 1, providerId: "provider", modelId: "model",
      recoveryCursor: 0, queuedAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z",
    })).toBe(false);
  });

  it("rejects every NULL-producing 24-byte timestamp both physically and on restart", () => {
    const invalid = "2026-99-99T99:99:99.999Z";
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedV6ToolExecution(database);
      expect(() => database.prepare(
        "UPDATE agent_executions SET updated_at = ? WHERE id = 'v6-execution'",
      ).run(invalid)).toThrow(/CHECK/i);
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.prepare(
        "UPDATE agent_executions SET updated_at = ? WHERE id = 'v6-execution'",
      ).run(invalid);
      database.exec("PRAGMA ignore_check_constraints = OFF");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);
    });
  });

  it.each(["closed_summary", "sealed_compensation"] as const)(
    "bounds dispatch %s to 65536 UTF-8 bytes physically and on restart",
    (column) => {
      withDatabase((database) => {
        migrateAuthorityDatabase(database);
        seedV6ToolExecution(database);
        expect(() => database.prepare(
          `UPDATE agent_tool_dispatches SET ${column} = ? WHERE id = 'v6-dispatch'`,
        ).run("好".repeat(21_846))).toThrow(/CHECK/i);
        database.exec("PRAGMA ignore_check_constraints = ON");
        database.prepare(
          `UPDATE agent_tool_dispatches SET ${column} = ? WHERE id = 'v6-dispatch'`,
        ).run("好".repeat(21_846));
        database.exec("PRAGMA ignore_check_constraints = OFF");
        expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);
      });
    },
  );

  it("requires a routed fence for every superseded execution and closes intent timestamps", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedV6ToolExecution(database);
      database.exec(`
        DELETE FROM agent_tool_dispatches WHERE id = 'v6-dispatch';
        DELETE FROM agent_tool_grants WHERE id = 'v6-grant';
        UPDATE agent_execution_attempts
        SET state = 'cancelled', tool_dispatch_phase = 'not_started',
            finished_at = '2026-08-13T00:00:02.000Z'
        WHERE execution_id = 'v6-execution' AND attempt_seq = 1;
        UPDATE agent_executions
        SET state = 'cancelled', tool_dispatch_phase = 'not_started',
            completed_at = '2026-08-13T00:00:02.000Z', updated_at = '2026-08-13T00:00:02.000Z',
            cancellation_reason = 'fenced'
        WHERE id = 'v6-execution';
        INSERT INTO agent_executions (
          id, room_id, agent_id, source_message_id, requester_actor_id, state,
          action_category, tool_dispatch_phase, current_tool_id,
          current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
          recovery_cursor, queued_at, started_at, updated_at, supersedes_execution_ids_json
        ) VALUES ('v6-unfenced-replacement', 'v6-room', 'v6-agent', 'v6-message', 'v6-human',
          'queued', 'model_generation', NULL, NULL, 1, 1, 1, 'provider', 'model', 0,
          '2026-08-13T00:00:03.000Z', NULL, '2026-08-13T00:00:03.000Z', '["v6-execution"]');
        INSERT INTO agent_execution_attempts (
          execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
          action_category, tool_dispatch_phase, started_at, finished_at,
          error_code, next_retry_at, recovery_cursor, enqueue_stream_seq
        ) VALUES ('v6-unfenced-replacement', 'v6-room', 1, 1, 1, 'queued', 'model_generation', NULL,
                  NULL, NULL, NULL, NULL, 0, 1);
      `);
      expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);
    });
    withDatabase((database) => {
      const invalid = "2026-99-99T99:99:99.999Z";
      migrateAuthorityDatabase(database);
      seedV6ToolExecution(database);
      expect(() => database.prepare(`INSERT INTO agent_invocation_intents (
        id, source_message_id, target_agent_id, intent_kind, execution_id, created_at
      ) VALUES ('intent-time', 'v6-message', 'v6-agent', 'direct_mention', 'v6-execution', ?)`).run(invalid))
        .toThrow(/CHECK/i);
      database.prepare(`INSERT INTO agent_invocation_intents (
        id, source_message_id, target_agent_id, intent_kind, execution_id, created_at
      ) VALUES ('intent-time', 'v6-message', 'v6-agent', 'direct_mention', 'v6-execution',
                '2026-08-13T00:00:03.000Z')`).run();
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.prepare("UPDATE agent_invocation_intents SET created_at = ? WHERE id = 'intent-time'")
        .run(invalid);
      database.exec("PRAGMA ignore_check_constraints = OFF");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);
    });
  });

  it("accepts string supersedes lineage and a matching routed fence replacement", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedV6ToolExecution(database);
      database.exec(`
        DELETE FROM agent_tool_dispatches WHERE id = 'v6-dispatch';
        DELETE FROM agent_tool_grants WHERE id = 'v6-grant';
        UPDATE agent_execution_attempts
        SET state = 'cancelled', tool_dispatch_phase = 'not_started',
            finished_at = '2026-08-13T00:00:02.000Z'
        WHERE execution_id = 'v6-execution' AND attempt_seq = 1;
        UPDATE agent_executions
        SET state = 'cancelled', cancellation_reason = 'legacy_interrupted', tool_dispatch_phase = 'not_started',
            completed_at = '2026-08-13T00:00:02.000Z',
            updated_at = '2026-08-13T00:00:02.000Z'
        WHERE id = 'v6-execution';
        INSERT INTO agent_judgments (
          id, room_id, agent_id, message_id, judgment_json, created_at
        ) VALUES (
          'v6-judgment', 'v6-room', 'v6-agent', 'v6-message',
          '{"outcome":"will_respond"}',
          '2026-08-13T00:00:03.000Z'
        );
        INSERT INTO agent_executions (
          id, room_id, agent_id, source_message_id, requester_actor_id, state,
          action_category, tool_dispatch_phase, current_tool_id,
          current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
          recovery_cursor, queued_at, started_at, updated_at,
          supersedes_execution_ids_json
        ) VALUES (
          'v6-replacement', 'v6-room', 'v6-agent', 'v6-message', 'v6-human',
          'queued', 'tool_call', 'not_started', 'summarize', 1, 1, 1,
          'test-provider', 'test-model', 0, '2026-08-13T00:00:03.000Z', NULL,
          '2026-08-13T00:00:03.000Z', '["v6-execution"]'
        );
        INSERT INTO agent_execution_attempts (
          execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
          action_category, tool_dispatch_phase, started_at, finished_at,
          error_code, next_retry_at, recovery_cursor, enqueue_stream_seq
        ) VALUES (
          'v6-replacement', 'v6-room', 1, 1, 1, 'queued', 'tool_call', 'not_started',
          NULL, NULL, NULL, NULL, 0, 1
        );
        INSERT INTO agent_fence_replacements (
          id, fence_message_id, old_execution_id, old_attempt_seq,
          route_job_id, selected_agent_id, expected_judgment_id,
          replacement_execution_id, created_at
        ) VALUES (
          'v6-routed-fence', 'v6-message', 'v6-execution', 1,
          'route-1', 'v6-agent', 'v6-judgment', 'v6-replacement',
          '2026-08-13T00:00:03.000Z'
        );
      `);
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
    });
  });

  it("refuses non-string supersedes lineage elements", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedV6ToolExecution(database);
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.exec("UPDATE agent_executions SET supersedes_execution_ids_json = '[1]' WHERE id = 'v6-execution'");
      database.exec("PRAGMA ignore_check_constraints = OFF");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);
    });
  });

  it("refuses a fence whose cancelled old attempt, judgment, or replacement violates the frozen fence contract", () => {
    const corruptions: readonly {
      readonly name: string;
      readonly corrupt: (database: DatabaseSync) => void;
    }[] = [
      {
        name: "model generation had started before cancellation",
        corrupt(database) {
          database.exec(`
            UPDATE agent_execution_attempts
            SET action_category = 'model_generation', tool_dispatch_phase = NULL,
                started_at = '2026-08-13T00:00:01.000Z'
            WHERE execution_id = 'v6-execution' AND attempt_seq = 1;
            UPDATE agent_executions
            SET action_category = 'model_generation', tool_dispatch_phase = NULL,
                current_tool_id = NULL
            WHERE id = 'v6-execution';
          `);
        },
      },
      {
        name: "tool dispatch had started before cancellation",
        corrupt(database) {
          database.exec(`
            UPDATE agent_execution_attempts SET tool_dispatch_phase = 'dispatched'
            WHERE execution_id = 'v6-execution' AND attempt_seq = 1;
            UPDATE agent_executions SET tool_dispatch_phase = 'dispatched'
            WHERE id = 'v6-execution';
          `);
        },
      },
      {
        name: "judgment does not belong to the fence message",
        corrupt(database) {
          database.exec(`
            INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
            VALUES ('v6-other-message', 'v6-room', 'v6-human', 'human', 'other',
                    '2026-08-13T00:00:04.000Z');
            UPDATE agent_judgments SET message_id = 'v6-other-message'
            WHERE id = 'v6-judgment';
          `);
        },
      },
      {
        name: "judgment outcome is not will respond",
        corrupt(database) {
          database.exec("UPDATE agent_judgments SET judgment_json = '{\"outcome\":\"decline\"}' WHERE id = 'v6-judgment'");
        },
      },
      {
        name: "judgment JSON has no outcome",
        corrupt(database) {
          database.exec("UPDATE agent_judgments SET judgment_json = '{}' WHERE id = 'v6-judgment'");
        },
      },
      {
        name: "judgment outcome is null",
        corrupt(database) {
          database.exec("UPDATE agent_judgments SET judgment_json = '{\"outcome\":null}' WHERE id = 'v6-judgment'");
        },
      },
      {
        name: "replacement is no longer queued",
        corrupt(database) {
          database.exec(`
            UPDATE agent_execution_attempts
            SET state = 'running', started_at = '2026-08-13T00:00:04.000Z'
            WHERE execution_id = 'v6-replacement' AND attempt_seq = 1;
            UPDATE agent_executions
            SET state = 'running', started_at = '2026-08-13T00:00:04.000Z',
                updated_at = '2026-08-13T00:00:04.000Z'
            WHERE id = 'v6-replacement';
          `);
        },
      },
      {
        name: "replacement consumes retry ordinal two",
        corrupt(database) {
          database.exec(`
            UPDATE agent_execution_attempts SET retry_ordinal = 2
            WHERE execution_id = 'v6-replacement' AND attempt_seq = 1;
            UPDATE agent_executions SET retry_ordinal = 2
            WHERE id = 'v6-replacement';
          `);
        },
      },
    ];

    for (const { name, corrupt } of corruptions) {
      withDatabase((database) => {
        migrateAuthorityDatabase(database);
        seedV6ToolExecution(database);
        database.exec(`
          DELETE FROM agent_tool_dispatches WHERE id = 'v6-dispatch';
          DELETE FROM agent_tool_grants WHERE id = 'v6-grant';
          UPDATE agent_execution_attempts
          SET state = 'cancelled', tool_dispatch_phase = 'not_started',
              finished_at = '2026-08-13T00:00:02.000Z'
          WHERE execution_id = 'v6-execution' AND attempt_seq = 1;
          UPDATE agent_executions
          SET state = 'cancelled', cancellation_reason = 'legacy_interrupted', tool_dispatch_phase = 'not_started',
              completed_at = '2026-08-13T00:00:02.000Z',
              updated_at = '2026-08-13T00:00:02.000Z'
          WHERE id = 'v6-execution';
          INSERT INTO agent_judgments (
            id, room_id, agent_id, message_id, judgment_json, created_at
          ) VALUES (
            'v6-judgment', 'v6-room', 'v6-agent', 'v6-message',
            '{"outcome":"will_respond"}', '2026-08-13T00:00:03.000Z'
          );
          INSERT INTO agent_executions (
            id, room_id, agent_id, source_message_id, requester_actor_id, state,
            action_category, tool_dispatch_phase, current_tool_id,
            current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
            recovery_cursor, queued_at, started_at, updated_at,
            supersedes_execution_ids_json
          ) VALUES (
            'v6-replacement', 'v6-room', 'v6-agent', 'v6-message', 'v6-human',
            'queued', 'tool_call', 'not_started', 'summarize', 1, 1, 1,
            'test-provider', 'test-model', 0, '2026-08-13T00:00:03.000Z', NULL,
            '2026-08-13T00:00:03.000Z', '["v6-execution"]'
          );
          INSERT INTO agent_execution_attempts (
            execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
            action_category, tool_dispatch_phase, started_at, finished_at,
            error_code, next_retry_at, recovery_cursor, enqueue_stream_seq
          ) VALUES (
            'v6-replacement', 'v6-room', 1, 1, 1, 'queued', 'tool_call', 'not_started',
            NULL, NULL, NULL, NULL, 0, 1
          );
          INSERT INTO agent_fence_replacements (
            id, fence_message_id, old_execution_id, old_attempt_seq,
            route_job_id, selected_agent_id, expected_judgment_id,
            replacement_execution_id, created_at
          ) VALUES (
            'v6-routed-fence', 'v6-message', 'v6-execution', 1,
            'route-1', 'v6-agent', 'v6-judgment', 'v6-replacement',
            '2026-08-13T00:00:03.000Z'
          );
        `);
        corrupt(database);
        expect(() => migrateAuthorityDatabase(database), name).toThrow(/integrity|invariant/i);
      });
    }
  });

  it("adds immutable v5 scoped keyset indexes and uses them for sparse interleaved scans", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion4ForTest(database);
      expect(readSchemaVersion(database)).toBe(4);
      migrateAuthorityDatabaseToPreviousVersionForTest(database);

      expect(readSchemaVersion(database)).toBe(5);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'index' AND name IN (${STREAMING_KEYSET_INDEXES.map(() => "?").join(", ")})
             ORDER BY name`,
          )
          .all(...STREAMING_KEYSET_INDEXES)
          .map((row) => String(row.name)),
      ).toEqual([...STREAMING_KEYSET_INDEXES].sort());

      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('actor-a', 'human', 'Actor A'), ('actor-b', 'human', 'Actor B');
        INSERT INTO rooms (id, name, status, created_at)
        VALUES
          ('room-a-1', 'A1', 'active', '2026-08-11T00:00:00.000Z'),
          ('room-a-2', 'A2', 'active', '2026-08-11T00:00:01.000Z'),
          ('room-b-1', 'B1', 'active', '2026-08-11T00:00:02.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, joined_at
        ) VALUES
          ('room-a-1', 'actor-a', 'human', 'member', NULL,
           '2026-08-11T00:01:00.000Z'),
          ('room-b-1', 'actor-b', 'human', 'member', NULL,
           '2026-08-11T00:01:01.000Z'),
          ('room-a-2', 'actor-a', 'human', 'member', NULL,
           '2026-08-11T00:01:02.000Z');
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES
          ('001', 'room-a-1', 'actor-a', 'human', 'a-1',
           '2026-08-11T00:02:00.000Z'),
          ('002', 'room-b-1', 'actor-b', 'human', 'b-1',
           '2026-08-11T00:02:01.000Z'),
          ('003', 'room-a-1', 'actor-a', 'human', 'a-2',
           '2026-08-11T00:02:02.000Z');
      `);

      expect(
        database
          .prepare(
            `SELECT id FROM messages
             WHERE room_id = ? AND id > ? ORDER BY id LIMIT 1`,
          )
          .all("room-a-1", "001"),
      ).toEqual([{ id: "003" }]);
      expect(
        database
          .prepare(
            `SELECT room_id AS roomId FROM room_memberships
             WHERE actor_id = ? AND kind = 'human' AND room_id > ?
             ORDER BY room_id LIMIT 1`,
          )
          .all("actor-a", "room-a-1"),
      ).toEqual([{ roomId: "room-a-2" }]);

      const roomScans = [
        ["messages", "messages_room_id_id"],
        ["agent_judgments", "agent_judgments_room_id_id"],
        ["open_items", "open_items_room_id_id"],
        ["agent_executions", "agent_executions_room_id_id"],
        ["calibration_signals", "calibration_signals_room_id_id"],
      ] as const;
      for (const [table, index] of roomScans) {
        expect(
          queryPlanDetails(
            database,
            `SELECT id FROM ${table}
             WHERE room_id = ? AND id > ? ORDER BY id LIMIT 50`,
            "room-a-1",
            "001",
          ).join("\n"),
        ).toContain(index);
      }
      expect(
        queryPlanDetails(
          database,
          `SELECT room_id FROM room_memberships
           WHERE actor_id = ? AND kind = 'human' AND room_id > ?
           ORDER BY room_id LIMIT 50`,
          "actor-a",
          "room-a-1",
        ).join("\n"),
      ).toContain("room_memberships_catalog_actor_kind_room");
    });
  });

  it("indexes reverse routed-fence lineage lookups", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      expect(queryPlanDetails(
        database,
        `SELECT 1 FROM agent_fence_replacements
         WHERE replacement_execution_id = ? AND old_execution_id = ?`,
        "replacement", "old",
      ).some((detail) => /SEARCH agent_fence_replacements USING .*agent_fence_replacements_replacement_old/i.test(detail))).toBe(true);
    });
  });

  it("adds complete canonical collaboration columns in immutable v4", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion3ForTest(database);
      expect(readSchemaVersion(database)).toBe(3);

      migrateAuthorityDatabaseToVersion4ForTest(database);

      expect(readSchemaVersion(database)).toBe(4);
      expect(tableColumns(database, "open_items")).toEqual(
        expect.arrayContaining([
          "requester_actor_id",
          "transfer_chain_json",
          "responded_at",
        ]),
      );
      expect(tableColumns(database, "agent_executions")).toEqual(
        expect.arrayContaining(["requester_actor_id", "tool_name"]),
      );
      expect(tableColumns(database, "calibration_signals")).toEqual(
        expect.arrayContaining(["source_message_id", "actor_id"]),
      );
    });
  });

  it("keeps a valid legacy v3 calibration explicitly unknown across v4 migration", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      migrateAuthorityDatabaseToVersion3ForTest(database);
      database.exec(`
        INSERT INTO agent_judgments (
          id, room_id, agent_id, message_id, judgment_json, created_at
        ) VALUES (
          'judgment-v3', 'room-1', 'agent-1', 'message-1',
          '{"outcome":"will_respond","reason":"legacy reason"}',
          '2026-08-09T03:00:00.000Z'
        );
        INSERT INTO calibration_signals (
          id, room_id, agent_id, judgment_id, signal, created_at
        ) VALUES (
          'signal-v3', 'room-1', 'agent-1', 'judgment-v3', '👍',
          '2026-08-09T03:01:00.000Z'
        );
      `);

      migrateAuthorityDatabase(database);

      expect(readSchemaVersion(database)).toBe(6);
      expect(database.prepare(
        `SELECT source_message_id AS sourceMessageId, actor_id AS actorId
         FROM calibration_signals WHERE id = 'signal-v3'`,
      ).get()).toEqual({ sourceMessageId: null, actorId: null });
    });
  });

  it("rejects canonical calibration corruption inserted while v4 triggers were absent", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      migrateAuthorityDatabase(database);
      const triggerNames = [
        "calibration_signals_v4_validate_insert",
        "calibration_signals_v4_validate_update",
      ] as const;
      const triggerSql = triggerNames.map((name) => {
        const row = database.prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
        ).get(name);
        if (typeof row?.sql !== "string") {
          throw new Error(`missing v4 calibration trigger ${name}`);
        }
        return row.sql;
      });
      for (const name of triggerNames) {
        database.exec(`DROP TRIGGER "${name}"`);
      }
      database.exec(`
        INSERT INTO calibration_signals (
          id, room_id, agent_id, judgment_id, signal, created_at,
          source_message_id, actor_id
        ) VALUES (
          'corrupt-canonical-signal', 'room-1', 'agent-1', NULL, '👍',
          '2026-08-10T00:00:00.000Z', 'message-1', 'agent-1'
        )
      `);
      for (const sql of triggerSql) {
        database.exec(sql);
      }

      expect(() => migrateAuthorityDatabase(database)).toThrow(/invariant/i);
    });
  });

  it("upgrades v1 history with zero revisions and one stream per room and actor", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);

      migrateAuthorityDatabase(database);

      expect(readSchemaVersion(database)).toBe(6);
      expect(
        database.prepare("SELECT id, catalog_revision FROM actors ORDER BY id").all(),
      ).toEqual([
        { id: "agent-1", catalog_revision: 0 },
        { id: "human-1", catalog_revision: 0 },
      ]);
      expect(
        database
          .prepare(
            `SELECT room_id, actor_id, access_revision
             FROM room_memberships ORDER BY room_id, actor_id`,
          )
          .all(),
      ).toEqual([
        { room_id: "room-1", actor_id: "agent-1", access_revision: 0 },
        { room_id: "room-1", actor_id: "human-1", access_revision: 0 },
      ]);
      expect(
        database
          .prepare(
            `SELECT stream_kind, stream_id, head_seq, retained_from_seq
             FROM streams ORDER BY stream_kind, stream_id`,
          )
          .all(),
      ).toEqual([
        { stream_kind: "identity", stream_id: "agent-1", head_seq: 0, retained_from_seq: 1 },
        { stream_kind: "identity", stream_id: "human-1", head_seq: 0, retained_from_seq: 1 },
        { stream_kind: "room", stream_id: "room-1", head_seq: 0, retained_from_seq: 1 },
        { stream_kind: "room", stream_id: "room-2", head_seq: 0, retained_from_seq: 1 },
      ]);
      expect(
        database.prepare("SELECT id, body, sent_at FROM messages").get(),
      ).toEqual({
        id: "message-1",
        body: "legacy history",
        sent_at: "2026-08-09T00:02:00.000Z",
      });
    });
  });

  it("upgrades immutable v2 outbox destinations into closed v3 targets", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion2ForTest(database);
      expect(readSchemaVersion(database)).toBe(2);
      expect(tableColumns(database, "outbox_deliveries")).toContain("destination");
      expect(
        database
          .prepare("SELECT checksum FROM schema_migrations WHERE version = 2")
          .get(),
      ).toEqual({ checksum: V2_MIGRATION_CHECKSUM });

      database.exec(`
        INSERT INTO actors (
          id, kind, display_name, reachability, readiness,
          tool_permissions_json, catalog_revision
        ) VALUES ('human-v2', 'human', 'V2 Human', 'online', NULL, '[]', 0);
        INSERT INTO streams (
          stream_kind, stream_id, head_seq, retained_from_seq
        ) VALUES ('identity', 'human-v2', 1, 1);
        INSERT INTO events (
          event_id, stream_kind, stream_id, stream_seq, room_id,
          actor_id, event_type, occurred_at, payload_json
        ) VALUES (
          'event-v2', 'identity', 'human-v2', 1, NULL,
          'human-v2', 'identity.session.revoked',
          '2026-08-10T00:00:00.000Z', '{}'
        );
        INSERT INTO outbox_deliveries (
          id, event_id, destination, status, attempts,
          available_at, delivered_at, last_error
        ) VALUES (
          'outbox-v2', 'event-v2', 'session-family:family-v2',
          'pending', 2, '2026-08-10T00:00:00.000Z', NULL, 'retry'
        );
      `);

      migrateAuthorityDatabase(database);

      expect(readSchemaVersion(database)).toBe(6);
      expect(
        database
          .prepare(
            `SELECT
               id,
               event_id AS eventId,
               target_kind AS targetKind,
               target_id AS targetId,
               stream_seq AS streamSeq,
               status,
               attempts,
               last_error AS lastError
             FROM outbox_deliveries`,
          )
          .get(),
      ).toEqual({
        id: "outbox-v2",
        eventId: "event-v2",
        targetKind: "session-family",
        targetId: "family-v2",
        streamSeq: 1,
        status: "pending",
        attempts: 2,
        lastError: "retry",
      });
    });
  });

  it("rolls back v3 when a legacy outbox target is not closed", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion2ForTest(database);
      database.exec(`
        INSERT INTO actors (
          id, kind, display_name, reachability, readiness,
          tool_permissions_json, catalog_revision
        ) VALUES ('human-v2', 'human', 'V2 Human', 'online', NULL, '[]', 0);
        INSERT INTO streams (
          stream_kind, stream_id, head_seq, retained_from_seq
        ) VALUES ('identity', 'human-v2', 1, 1);
        INSERT INTO events (
          event_id, stream_kind, stream_id, stream_seq, room_id,
          actor_id, event_type, occurred_at, payload_json
        ) VALUES (
          'event-v2', 'identity', 'human-v2', 1, NULL,
          'human-v2', 'identity.session.revoked',
          '2026-08-10T00:00:00.000Z', '{}'
        );
        INSERT INTO outbox_deliveries (
          id, event_id, destination, status, attempts,
          available_at, delivered_at, last_error
        ) VALUES (
          'outbox-v2', 'event-v2', 'broadcast:everyone',
          'pending', 0, '2026-08-10T00:00:00.000Z', NULL, NULL
        );
      `);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database)).toThrow();

      expect(readSchemaVersion(database)).toBe(2);
      expect(snapshot(database)).toEqual(before);
    });
  });

  it("rolls back a failed v2 migration without changing v1 schema or data", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      const before = snapshot(database);

      expect(() =>
        migrateAuthorityDatabase(database, { failAfterStatement: 11 }),
      ).toThrow(/injected migration failure/i);

      expect(snapshot(database)).toEqual(before);
      expect(listAuthorityTables(database)).not.toContain("outbox_deliveries");
      expect(tableColumns(database, "actors")).not.toContain("catalog_revision");
    });
  });

  it("owns transaction state without requiring post-22.13 DatabaseSync APIs", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      const before = snapshot(database);

      expect(() =>
        migrateAuthorityDatabase(databaseWithoutTransactionState(database), {
          failAfterStatement: 11,
        }),
      ).toThrow(/injected migration failure/i);

      expect(snapshot(database)).toEqual(before);
    });
  });

  it("preserves the migration error and exposes a secondary rollback failure", () => {
    withDatabase((database) => {
      createV1Fixture(database);

      let thrown: unknown;
      try {
        migrateAuthorityDatabase(databaseWithFailingRollback(database), {
          failAfterStatement: 11,
        });
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      if (!(thrown instanceof AggregateError)) {
        throw new Error("expected migration and rollback failures");
      }
      expect(thrown.cause).toMatchObject({
        message: expect.stringMatching(/injected migration failure/i),
      });
      expect(thrown.errors).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(/injected migration failure/i),
        }),
        expect.objectContaining({ message: "simulated rollback failure" }),
      ]);
    });
  });

  it("validates the starting schema only after acquiring the write transaction", () => {
    withDatabase((database) => {
      createV1Fixture(database);

      expect(() =>
        migrateAuthorityDatabase(databaseWithSchemaChangeBeforeBegin(database)),
      ).toThrow(/unknown schema/i);

      expect(readSchemaVersion(database)).toBe(1);
      expect(listAuthorityTables(database)).not.toContain("outbox_deliveries");
    });
  });

  it("rolls back when final schema integrity fails before commit", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      const before = snapshot(database);

      expect(() =>
        migrateAuthorityDatabase(databaseWithCorruptedOutboxDdl(database)),
      ).toThrow(/unknown schema|no column/i);

      expect(snapshot(database)).toEqual(before);
    });
  });

  it("rejects invalid v1 authority data without advancing or changing history", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      database.exec(`
        INSERT INTO actors (
          id, kind, display_name, reachability, readiness, tool_permissions_json
        ) VALUES ('agent-session', 'agent', 'Agent', NULL, 'ready', '[]');
        INSERT INTO sessions (
          family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
          access_expires_at, refresh_expires_at, revoked_at
        ) VALUES (
          'family-1', 'agent-account', 'agent-session', 'access-1', 'refresh-1',
          1, 2, NULL
        );
      `);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);

      expect(snapshot(database)).toEqual(before);
    });

    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      database.exec(`
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES (
          'message-kind-mismatch', 'room-1', 'human-1', 'agent', 'invalid',
          '2026-08-09T00:03:00.000Z'
        )
      `);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);

      expect(snapshot(database)).toEqual(before);
    });

    withDatabase((database) => {
      createV1Fixture(database);
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec(`
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES (
          'message-orphan', 'missing-room', 'missing-actor', 'human', 'invalid',
          '2026-08-09T00:04:00.000Z'
        )
      `);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);

      expect(snapshot(database)).toEqual(before);
    });
  });

  it("rejects missing, orphaned, mistyped, or negative v2 authority state", () => {
    const corruptions: readonly ((database: DatabaseSync) => void)[] = [
      (database) => {
        database.exec(
          "DELETE FROM streams WHERE stream_kind = 'identity' AND stream_id = 'human-1'",
        );
      },
      (database) => {
        database.exec(
          "DELETE FROM streams WHERE stream_kind = 'room' AND stream_id = 'room-1'",
        );
      },
      (database) => {
        database.exec(
          `INSERT INTO streams (
             stream_kind, stream_id, head_seq, retained_from_seq
           ) VALUES ('identity', 'orphan-actor', 0, 1)`,
        );
      },
      (database) => {
        database.exec(
          `UPDATE streams SET stream_kind = 'identity'
           WHERE stream_kind = 'room' AND stream_id = 'room-1'`,
        );
      },
      (database) => {
        database.exec("PRAGMA ignore_check_constraints = ON");
        database.exec("UPDATE actors SET catalog_revision = -1 WHERE id = 'human-1'");
        database.exec("PRAGMA ignore_check_constraints = OFF");
      },
      (database) => {
        database.exec("PRAGMA ignore_check_constraints = ON");
        database.exec(
          `UPDATE room_memberships SET access_revision = -1
           WHERE room_id = 'room-1' AND actor_id = 'human-1'`,
        );
        database.exec("PRAGMA ignore_check_constraints = OFF");
      },
    ];

    for (const corrupt of corruptions) {
      withDatabase((database) => {
        createV1Fixture(database);
        seedV1History(database);
        migrateAuthorityDatabase(database);
        corrupt(database);
        const before = snapshot(database);

        expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant/i);

        expect(snapshot(database)).toEqual(before);
      });
    }
  });

  it("rejects physical schema tampering beyond matching table and column names", () => {
    const probes = [
      ["rooms", "status TEXT NOT NULL", "status BLOB NOT NULL"],
      ["rooms", "status TEXT NOT NULL", "status TEXT"],
      [
        "actors",
        "tool_permissions_json TEXT NOT NULL DEFAULT '[]'",
        "tool_permissions_json TEXT NOT NULL DEFAULT '{}'",
      ],
      ["rooms", "id TEXT PRIMARY KEY", "id TEXT UNIQUE"],
      [
        "messages",
        "room_id TEXT NOT NULL REFERENCES rooms(id)",
        "room_id TEXT NOT NULL REFERENCES actors(id)",
      ],
      [
        "sessions",
        "refresh_token_hash TEXT NOT NULL UNIQUE",
        "refresh_token_hash TEXT NOT NULL",
      ],
      [
        "streams",
        "retained_from_seq <= head_seq + 1",
        "retained_from_seq <= head_seq + 2",
      ],
    ] as const;

    for (const [tableName, search, replacement] of probes) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToPreviousVersionForTest(database);
        tamperSchemaSql(database, tableName, search, replacement);

        expect(() => migrateAuthorityDatabase(database)).toThrow(/unknown schema/i);
      });
    }
  });

  it("enforces actor-kind and cross-room semantics at each database statement", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      migrateAuthorityDatabaseToPreviousVersionForTest(database);
      database.exec(`
        INSERT INTO actors (
          id, kind, display_name, reachability, readiness, tool_permissions_json
        ) VALUES ('agent-2', 'agent', 'Second Agent', NULL, 'ready', '[]');
        INSERT INTO streams (
          stream_kind, stream_id, head_seq, retained_from_seq
        ) VALUES ('identity', 'agent-2', 0, 1);
      `);

      expectSqlRejected(
        database,
        `INSERT INTO sessions (
           family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
           access_expires_at, refresh_expires_at, revoked_at
         ) VALUES ('family-agent', 'agent', 'agent-1', 'access-agent',
                   'refresh-agent', 1, 2, NULL)`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO room_memberships (
           room_id, actor_id, kind, role, participation, tool_permissions_json,
           joined_at, configured_at, access_revision
         ) VALUES ('room-2', 'human-1', 'agent', NULL, 'active', '[]', NULL,
                   '2026-08-09T01:01:00.000Z', 0)`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
         VALUES ('message-kind-invalid', 'room-1', 'human-1', 'agent', 'invalid',
                 '2026-08-09T01:02:00.000Z')`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO room_invitations (
           id, room_id, inviter_actor_id, invitee_actor_id, token_hash, status,
           created_at, decision_actor_id, decided_at
         ) VALUES ('invite-agent-source', 'room-1', 'agent-1', 'human-1',
                   'token-agent-source', 'pending',
                   '2026-08-09T01:03:00.000Z', NULL, NULL)`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO room_invitations (
           id, room_id, inviter_actor_id, invitee_actor_id, token_hash, status,
           created_at, decision_actor_id, decided_at
         ) VALUES ('invite-agent-target', 'room-1', 'human-1', 'agent-1',
                   'token-agent-target', 'pending',
                   '2026-08-09T01:04:00.000Z', NULL, NULL)`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO human_read_receipts (room_id, actor_id, message_id, read_at)
         VALUES ('room-1', 'agent-1', 'message-1',
                 '2026-08-09T01:05:00.000Z')`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO human_read_receipts (room_id, actor_id, message_id, read_at)
         VALUES ('room-2', 'human-1', 'message-1',
                 '2026-08-09T01:06:00.000Z')`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO agent_judgments (
           id, room_id, agent_id, message_id, judgment_json, created_at
         ) VALUES ('judgment-human', 'room-1', 'human-1', 'message-1', '{}',
                   '2026-08-09T01:07:00.000Z')`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO agent_judgments (
           id, room_id, agent_id, message_id, judgment_json, created_at
         ) VALUES ('judgment-room', 'room-2', 'agent-1', 'message-1', '{}',
                   '2026-08-09T01:08:00.000Z')`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO agent_executions (
           id, room_id, agent_id, trigger_message_id, status, started_at,
           completed_at, result_json
         ) VALUES ('execution-human', 'room-1', 'human-1', 'message-1',
                   'running', '2026-08-09T01:09:00.000Z', NULL, NULL)`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO agent_executions (
           id, room_id, agent_id, trigger_message_id, status, started_at,
           completed_at, result_json
         ) VALUES ('execution-room', 'room-2', 'agent-1', 'message-1',
                   'running', '2026-08-09T01:10:00.000Z', NULL, NULL)`,
      );

      database.exec(`
        INSERT INTO sessions (
          family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
          access_expires_at, refresh_expires_at, revoked_at
        ) VALUES ('family-human', 'human', 'human-1', 'access-human',
                  'refresh-human', 1, 2, NULL);
        INSERT INTO room_invitations (
          id, room_id, inviter_actor_id, invitee_actor_id, token_hash, status,
          created_at, decision_actor_id, decided_at
        ) VALUES ('invite-valid', 'room-1', 'human-1', 'human-1', 'token-valid',
                  'pending', '2026-08-09T01:11:00.000Z', NULL, NULL);
        INSERT INTO human_read_receipts (room_id, actor_id, message_id, read_at)
        VALUES ('room-1', 'human-1', 'message-1',
                '2026-08-09T01:12:00.000Z');
        INSERT INTO agent_judgments (
          id, room_id, agent_id, message_id, judgment_json, created_at
        ) VALUES ('judgment-valid', 'room-1', 'agent-1', 'message-1', '{}',
                  '2026-08-09T01:13:00.000Z');
        INSERT INTO agent_executions (
          id, room_id, agent_id, trigger_message_id, status, started_at,
          completed_at, result_json, requester_actor_id, tool_name
        ) VALUES ('execution-valid', 'room-1', 'agent-1', 'message-1', 'running',
                  '2026-08-09T01:14:00.000Z', NULL, NULL, 'human-1',
                  'summarize');
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('message-agent', 'room-1', 'agent-1', 'agent', 'agent answer',
                '2026-08-09T01:14:30.000Z');
        INSERT INTO calibration_signals (
          id, room_id, agent_id, judgment_id, signal, created_at,
          source_message_id, actor_id
        ) VALUES ('signal-valid', 'room-1', 'agent-1', NULL, '👍',
                  '2026-08-09T01:15:00.000Z', 'message-agent', 'human-1');
      `);

      expectSqlRejected(
        database,
        `INSERT INTO calibration_signals (
           id, room_id, agent_id, judgment_id, signal, created_at
         ) VALUES ('signal-missing-canonical', 'room-1', 'agent-1',
                   'judgment-valid', '👍', '2026-08-09T01:15:30.000Z')`,
      );

      expectSqlRejected(
        database,
        "UPDATE sessions SET actor_id = 'agent-1' WHERE access_token_hash = 'access-human'",
      );
      expectSqlRejected(
        database,
        `UPDATE room_memberships SET kind = 'agent', role = NULL,
           participation = 'active', joined_at = NULL,
           configured_at = '2026-08-09T01:16:00.000Z'
         WHERE room_id = 'room-1' AND actor_id = 'human-1'`,
      );
      expectSqlRejected(
        database,
        "UPDATE messages SET author_kind = 'agent' WHERE id = 'message-1'",
      );
      expectSqlRejected(
        database,
        "UPDATE room_invitations SET inviter_actor_id = 'agent-1' WHERE id = 'invite-valid'",
      );
      expectSqlRejected(
        database,
        `UPDATE human_read_receipts SET actor_id = 'agent-1'
         WHERE room_id = 'room-1' AND actor_id = 'human-1'`,
      );
      expectSqlRejected(
        database,
        "UPDATE agent_judgments SET room_id = 'room-2' WHERE id = 'judgment-valid'",
      );
      expectSqlRejected(
        database,
        "UPDATE agent_executions SET agent_id = 'human-1' WHERE id = 'execution-valid'",
      );
      expectSqlRejected(
        database,
        "UPDATE calibration_signals SET agent_id = 'agent-2' WHERE id = 'signal-valid'",
      );
      expectSqlRejected(
        database,
        "UPDATE actors SET kind = 'agent' WHERE id = 'human-1'",
      );
    });
  });

  it("enforces event bounds and JSON payloads at each database statement", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      migrateAuthorityDatabase(database);

      expectSqlRejected(
        database,
        `INSERT INTO events (
           event_id, stream_kind, stream_id, stream_seq, room_id, actor_id,
           event_type, occurred_at, payload_json
         ) VALUES ('event-early', 'room', 'room-1', 1, 'room-1', 'human-1',
                   'room.message.accepted', '2026-08-09T02:00:00.000Z', '{}')`,
      );

      database.exec(
        `UPDATE streams SET head_seq = 1
         WHERE stream_kind = 'room' AND stream_id = 'room-1'`,
      );
      expectSqlRejected(
        database,
        `INSERT INTO events (
           event_id, stream_kind, stream_id, stream_seq, room_id, actor_id,
           event_type, occurred_at, payload_json
         ) VALUES ('event-json', 'room', 'room-1', 1, 'room-1', 'human-1',
                   'room.message.accepted', '2026-08-09T02:01:00.000Z', 'not-json')`,
      );
    });
  });

  it("rejects committed event gaps, out-of-bounds rows, and corrupt payloads", () => {
    const corruptions: readonly ((database: DatabaseSync) => void)[] = [
      (database) => {
        database.exec(
          `UPDATE streams SET head_seq = 2
           WHERE stream_kind = 'room' AND stream_id = 'room-1'`,
        );
      },
      (database) => {
        database.exec(
          `UPDATE streams SET head_seq = 1
           WHERE stream_kind = 'room' AND stream_id = 'room-1'`,
        );
        database.exec("PRAGMA ignore_check_constraints = ON");
        database.exec(`
          INSERT INTO events (
            event_id, stream_kind, stream_id, stream_seq, room_id, actor_id,
            event_type, occurred_at, payload_json
          ) VALUES ('event-corrupt-json', 'room', 'room-1', 1, 'room-1',
                    'human-1', 'room.message.accepted',
                    '2026-08-09T02:02:00.000Z', 'not-json')
        `);
        database.exec("PRAGMA ignore_check_constraints = OFF");
      },
    ];

    for (const corrupt of corruptions) {
      withDatabase((database) => {
        createV1Fixture(database);
        seedV1History(database);
        migrateAuthorityDatabase(database);
        corrupt(database);
        const before = snapshot(database);

        expect(() => migrateAuthorityDatabase(database)).toThrow(/integrity|invariant|unknown schema/i);

        expect(snapshot(database)).toEqual(before);
      });
    }
  });

  it("rejects invalid fault options before changing the database", () => {
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

    for (const failAfterStatement of invalidValues) {
      withDatabase((database) => {
        expect(() =>
          migrateAuthorityDatabase(database, { failAfterStatement }),
        ).toThrow(TypeError);
        expect(readSchemaVersion(database)).toBe(0);
        expect(listAuthorityTables(database)).toEqual([]);
      });
    }
  });

  it("refuses unknown and future schemas", () => {
    withDatabase((database) => {
      database.exec("CREATE TABLE unknown_history (id TEXT PRIMARY KEY) STRICT");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/unknown schema/i);
      expect(listAuthorityTables(database)).toEqual(["unknown_history"]);
    });

    withDatabase((database) => {
      database.exec("PRAGMA user_version = 7");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/future schema/i);
      expect(readSchemaVersion(database)).toBe(7);
    });
  });

  it("refuses v3 schemas with missing or unexpected authority tables", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec("DROP TABLE calibration_signals");

      expect(() => migrateAuthorityDatabase(database)).toThrow(/unknown schema/i);
    });

    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec("CREATE TABLE unexpected_authority_data (id TEXT) STRICT");

      expect(() => migrateAuthorityDatabase(database)).toThrow(/unknown schema/i);
    });
  });

  it("refuses v3 tables that are missing required contract columns", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec("ALTER TABLE outbox_deliveries DROP COLUMN last_error");

      expect(() => migrateAuthorityDatabase(database)).toThrow(/unknown schema/i);
    });
  });

  it("refuses altered migration history and computes deterministic checksums", () => {
    const first = withDatabase((database) => {
      migrateAuthorityDatabase(database);
      return database
        .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
        .all();
    });
    const second = withDatabase((database) => {
      migrateAuthorityDatabase(database);
      return database
        .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
        .all();
    });
    expect(second).toEqual(first);

    withDatabase((database) => {
      createV1Fixture(database, "0".repeat(64));
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database)).toThrow(/checksum/i);

      expect(snapshot(database)).toEqual(before);
    });
  });
});

describe("derived snapshot cache schema", () => {
  it("creates independent v1 WAL/FULL tables without changing authority v5", () => {
    withDatabase((database) => {
      migrateSnapshotCacheDatabase(database);
      expect(SNAPSHOT_CACHE_SCHEMA_VERSION).toBe(1);
      expect(readSchemaVersion(database)).toBe(1);
      expect(listSnapshotCacheTables(database)).toEqual([
        "expired_snapshot_tombstones",
        "repair_snapshot_pages",
        "repair_snapshots",
      ]);
      expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(database.prepare("PRAGMA synchronous").get()?.synchronous).toBe(2);
      expect(database.prepare("PRAGMA busy_timeout").get()?.timeout)
        .toBe(SNAPSHOT_CACHE_BUSY_TIMEOUT_MS);
      expect(() => validateSnapshotCacheSchema(database)).not.toThrow();
    });
    expect(AUTHORITY_SCHEMA_VERSION).toBe(6);
  });

  it("fails closed on version-one corruption and refuses future versions", () => {
    withDatabase((database) => {
      migrateSnapshotCacheDatabase(database);
      database.exec("ALTER TABLE repair_snapshot_pages DROP COLUMN canonical_bytes");
      expect(() => validateSnapshotCacheSchema(database)).toThrow(/column contract/i);
      expect(() => migrateSnapshotCacheDatabase(database)).toThrow(/column contract/i);
    });
    withDatabase((database) => {
      database.exec("PRAGMA user_version = 2");
      expect(() => migrateSnapshotCacheDatabase(database)).toThrow(/incompatible/i);
      expect(readSchemaVersion(database)).toBe(2);
    });
  });

  it("rejects same-column physical contract and foreign-key corruption", () => {
    withDatabase((database) => {
      migrateSnapshotCacheDatabase(database);
      database.exec("DROP INDEX repair_snapshots_reuse");
      expect(() => validateSnapshotCacheSchema(database)).toThrow(/physical contract/i);
    });
    withDatabase((database) => {
      migrateSnapshotCacheDatabase(database);
      database.exec(`
        PRAGMA foreign_keys = OFF;
        ALTER TABLE repair_snapshot_pages RENAME TO repair_snapshot_pages_old;
        CREATE TABLE repair_snapshot_pages (
          snapshot_id TEXT,
          page_number INTEGER,
          payload_json TEXT,
          canonical_bytes INTEGER
        ) STRICT;
        DROP TABLE repair_snapshot_pages_old;
        PRAGMA foreign_keys = ON;
      `);
      expect(() => validateSnapshotCacheSchema(database)).toThrow(/physical contract/i);
    });
    withDatabase((database) => {
      migrateSnapshotCacheDatabase(database);
      database.exec("PRAGMA foreign_keys = OFF");
      database.prepare(
        `INSERT INTO repair_snapshot_pages (
           snapshot_id, page_number, payload_json, canonical_bytes
         ) VALUES ('missing', 0, '[]', 2)`,
      ).run();
      database.exec("PRAGMA foreign_keys = ON");
      expect(() => validateSnapshotCacheSchema(database)).toThrow(/integrity/i);
    });
  });
});
