import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V14_STATEMENT_COUNT_FOR_TEST,
  AUTHORITY_V15_STATEMENT_COUNT_FOR_TEST,
  configureAuthorityConnection,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  migrateAuthorityDatabaseToVersion14ForTest,
  migrateAuthorityDatabaseToVersion13ForTest,
  migrateAuthorityDatabaseToVersion12ForTest,
  migrateAuthorityDatabaseToVersion11ForTest,
  migrateAuthorityDatabaseToVersion10ForTest,
  migrateAuthorityDatabaseToVersion9ForTest,
  migrateAuthorityDatabaseToVersion8ForTest,
  migrateAuthorityDatabaseToVersion7ForTest,
  migrateAuthorityDatabaseToVersion6ForTest,
  migrateAuthorityDatabaseToVersion5ForTest,
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
  "agent_authority_migration_provenance",
  "agent_execution_attempt_runtime_states",
  "agent_execution_attempts",
  "agent_execution_context_attempts",
  "agent_execution_context_bindings",
  "agent_execution_grants",
  "agent_execution_intent_links",
  "agent_execution_runtime_states",
  "agent_execution_steps",
  "agent_executions",
  "agent_fence_replacements",
  "agent_human_fences",
  "agent_invocation_intent_runtime_states",
  "agent_invocation_intents",
  "agent_judgments",
  "agent_message_citations",
  "agent_message_corrections",
  "agent_message_sources",
  "agent_profile_invalidation_facts",
  "agent_profile_revisions",
  "agent_profiles",
  "attachment_extraction_artifacts",
  "attachment_processing_attempts",
  "attachment_upload_chunks",
  "attachment_uploads",
  "attachments",
  "ball_boundary_claims",
  "calibration_signals",
  "context_manifest_items",
  "context_manifest_range_sources",
  "context_manifests",
  "context_snapshot_bodies",
  "context_snapshot_lineage",
  "context_snapshot_sources",
  "context_snapshot_transitions",
  "context_snapshots",
  "context_source_read_dispatches",
  "context_source_read_grants",
  "context_source_read_payloads",
  "context_source_read_receipts",
  "context_source_reads",
  "deployment_agent_profile_events",
  "deployment_agent_profile_repair_records",
  "deployment_audit",
  "deployment_idempotency_records",
  "deployment_profile_outbox",
  "deployment_stream",
  "direct_agent_invocation_authority_bindings",
  "events",
  "human_preemption_fences",
  "human_read_receipts",
  "human_request_intents",
  "idempotency_records",
  "invocation_cancellation_receipts",
  "invocation_human_retry_receipts",
  "invocation_recovery_cursors",
  "invocation_recovery_queue",
  "invocation_scoped_cancellation_fences",
  "invocation_scoped_cancellation_targets",
  "legacy_room_wide_preemption_markers",
  "light_tasks",
  "message_attachment_links",
  "message_envelopes",
  "message_mentions",
  "message_recall_fences",
  "message_reply_links",
  "message_revisions",
  "message_target_outcomes",
  "message_topics",
  "messages",
  "notification_command_receipts",
  "notifications",
  "offline_read_lease_invalidations",
  "offline_read_lease_issuances",
  "open_item_agent_failures",
  "open_items",
  "outbox_deliveries",
  "privacy_retention_attempts",
  "project_agent_boundary_claims",
  "project_archive_suspensions",
  "project_ball_boundaries",
  "project_boundary_agent_execution_links",
  "project_boundary_agent_executions",
  "project_boundary_agent_invocation_intents",
  "project_boundary_context_sources",
  "project_boundary_invocation_receipts",
  "project_command_receipts",
  "project_confirmations",
  "project_decisions",
  "project_due_reminder_claims",
  "project_event_outbox",
  "project_events",
  "project_fact_checkpoints",
  "project_fact_proposals",
  "project_goals",
  "project_next_actions",
  "project_obstacles",
  "project_requests",
  "project_room_states",
  "project_transfer_chain",
  "project_transfer_proposals",
  "project_transition_audit",
  "room_access_authority",
  "room_agent_assignment_revisions",
  "room_agent_assignments",
  "room_assignment_archive_policies",
  "room_audit",
  "room_business_timer_freeze_batches",
  "room_business_timer_freezes",
  "room_cache_invalidation_intents",
  "room_invitations",
  "room_memberships",
  "room_memory_attempts",
  "room_memory_disputes",
  "room_memory_idempotency",
  "room_memory_jobs",
  "room_memory_project_checkpoint",
  "room_memory_records",
  "room_memory_resolutions",
  "room_memory_source_edges",
  "room_memory_source_transitions",
  "room_memory_sources",
  "room_memory_stewards",
  "room_memory_versions",
  "room_message_archive_gates",
  "rooms",
  "route_attempts",
  "route_calibration_facts",
  "route_calibration_scores",
  "route_candidate_snapshot_agents",
  "route_candidate_snapshots",
  "route_decisions",
  "route_invocation_intents",
  "route_job_agents",
  "route_jobs",
  "route_judgments",
  "route_metrics",
  "routed_agent_invocation_intents",
  "runtime_archive_fence_members",
  "runtime_archive_fences",
  "schema_migrations",
  "session_families",
  "sessions",
  "streams",
  "tenant_administrator_registry",
  "tenant_administrator_revisions",
  "tenant_administrators",
  "tool_archive_settlement_members",
  "tool_archive_settlements",
  "tool_calls_v2",
  "tool_compensation_lineage_v2",
  "tool_confirmation_decisions_v2",
  "tool_confirmation_handoffs_v2",
  "tool_confirmations",
  "tool_confirmations_v2",
  "tool_dispatch_transitions_v2",
  "tool_dispatches",
  "tool_dispatches_v2",
  "tool_grant_transitions_v2",
  "tool_grants_v2",
  "tool_reviews_v2",
  "tool_safety_command_receipts_v2",
  "tool_safety_quarantine_v2",
  "tool_safety_repair_records_v2",
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
const V8_MIGRATION_CHECKSUM =
  "b0eb63981b5ee92cfd51133972e78c4054c3fdf155cee58ce4c029564ed6d1d1";
const V9_MIGRATION_CHECKSUM =
  "802bd498bf342a575fa21fb46e18b7a375259bd40a571844bb375d756c0616b2";
const V10_MIGRATION_CHECKSUM =
  "a7a668d54ddd3636f2e2bafcb7e55be8c9771d56c19a6ca5e3c79027a6647105";
const V11_MIGRATION_CHECKSUM =
  "3ef3ca9216e684ec3d9e4097fe8a2e7148c75d5bb4b23ed7bf5a0eb5edc970a1";
const V12_MIGRATION_CHECKSUM =
  "66276cc21f02f19f5e60758039acd43030ba8a9666b37c0fef65ad30852929fa";
const V13_MIGRATION_CHECKSUM =
  "0d008e577b5514d5fd51fa65c9c31ef51e32e55e09483c8a2e3a707d6ca42e3e";

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
       NULL, '2026-08-09T00:01:00.000Z'),
      ('room-2', 'human-1', 'human', 'owner', NULL, '[]',
       '2026-08-09T01:00:00.000Z', NULL);

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

function seedV11SessionCapacity(
  database: DatabaseSync,
  familyCount: number,
  expiredFamilyIndex?: number,
): void {
  database.exec(`
    INSERT INTO actors (id, kind, display_name)
    VALUES ('capacity-migration-human', 'human', 'Capacity Human');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'capacity-migration-human', 0, 1);
  `);
  const insert = database.prepare(
    `INSERT INTO sessions (
       family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
       access_expires_at, refresh_expires_at, revoked_at
     ) VALUES (?, 'capacity-account', 'capacity-migration-human', ?, ?, ?, ?, NULL)`,
  );
  const now = Date.now();
  for (let index = 0; index < familyCount; index += 1) {
    const refreshExpiresAt = index === expiredFamilyIndex
      ? now - 24 * 60 * 60 * 1_000
      : now + 24 * 60 * 60 * 1_000;
    insert.run(
      `capacity-family-${index}`,
      `capacity-access-${index}`,
      `capacity-refresh-${index}`,
      refreshExpiresAt - 1_000,
      refreshExpiresAt,
    );
  }
}

export function registerRecentAuthoritySchemaTests(): void {
describe("authority SQLite schema — recent migrations", () => {
  it("upgrades v13 archived rooms with a durable message gate and leaves active rooms ungated", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion13ForTest(database);
      expect(readSchemaVersion(database)).toBe(13);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES
          ('v14-owner', 'human', 'Owner'),
          ('v14-agent', 'agent', 'Agent');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES
          ('identity', 'v14-owner', 0, 1),
          ('identity', 'v14-agent', 0, 1),
          ('room', 'v14-active', 0, 1),
          ('room', 'v14-archived', 0, 1);
        INSERT INTO rooms (id, name, status, created_at)
        VALUES
          ('v14-active', 'Active', 'active', '2026-08-19T00:00:00.000Z'),
          ('v14-archived', 'Archived', 'active', '2026-08-19T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES
          ('v14-active', 'v14-owner', 'human', 'member', NULL, '[]',
           '2026-08-19T00:00:00.000Z', NULL, 0),
          ('v14-archived', 'v14-owner', 'human', 'member', NULL, '[]',
           '2026-08-19T00:00:00.000Z', NULL, 0);
        UPDATE rooms SET owner_actor_id = 'v14-owner';
        UPDATE rooms
        SET status = 'archived', archive_generation = 4,
            archived_at = '2026-08-19T00:04:00.000Z'
        WHERE id = 'v14-archived';
        INSERT INTO agent_executions (
          id, room_id, agent_id, status, started_at, action_category,
          tool_dispatch_phase, queued_at, updated_at
        ) VALUES
          ('v14-execution-pending', 'v14-active', 'v14-agent', 'running',
           '2026-08-19T00:01:00.000Z', 'waiting_upstream', NULL,
           '2026-08-19T00:01:00.000Z', '2026-08-19T00:01:00.000Z'),
          ('v14-execution-consumed', 'v14-active', 'v14-agent', 'running',
           '2026-08-19T00:01:00.000Z', 'tool_call', 'dispatched',
           '2026-08-19T00:01:00.000Z', '2026-08-19T00:01:00.000Z');
        INSERT INTO agent_execution_attempts (
          execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
          action_category, started_at, recovery_cursor
        ) VALUES
          ('v14-execution-pending', 1, 1, 1, 'running', 'waiting_upstream',
           '2026-08-19T00:01:00.000Z', 0),
          ('v14-execution-consumed', 1, 1, 1, 'running', 'tool_call',
           '2026-08-19T00:01:00.000Z', 0);
        INSERT INTO agent_execution_grants (
          grant_id, execution_id, attempt_seq, agent_id, room_id, tool_id,
          parameter_sha256, issued_at, expires_at, consumed_at
        ) VALUES
          ('v14-grant-pending', 'v14-execution-pending', 1, 'v14-agent',
           'v14-active', 'sandbox-file.write',
           '0000000000000000000000000000000000000000000000000000000000000000',
           '2026-08-19T00:01:00.000Z', '2026-08-19T01:01:00.000Z', NULL),
          ('v14-grant-consumed', 'v14-execution-consumed', 1, 'v14-agent',
           'v14-active', 'sandbox-file.write',
           '1111111111111111111111111111111111111111111111111111111111111111',
           '2026-08-19T00:01:00.000Z', '2026-08-19T01:01:00.000Z',
           '2026-08-19T00:02:00.000Z');
        INSERT INTO tool_confirmations (
          confirmation_id, execution_id, attempt_seq, tool_id, parameter_sha256,
          room_id, human_principal_id, session_family_id, expires_at,
          target, impact, reversibility, consumed_at
        ) VALUES
          ('v14-confirmation-pending', 'v14-execution-pending', 1,
           'sandbox-file.write',
           '0000000000000000000000000000000000000000000000000000000000000000',
           'v14-active', 'v14-owner', 'v14-family', '2026-08-19T01:01:00.000Z',
           'sandbox-file.write', 'bounded-side-effect', 'compensatable', NULL),
          ('v14-confirmation-consumed', 'v14-execution-consumed', 1,
           'sandbox-file.write',
           '1111111111111111111111111111111111111111111111111111111111111111',
           'v14-active', 'v14-owner', 'v14-family', '2026-08-19T01:01:00.000Z',
           'sandbox-file.write', 'bounded-side-effect', 'compensatable',
           '2026-08-19T00:02:00.000Z');
      `);

      migrateAuthorityDatabase(database);

      expect(readSchemaVersion(database)).toBe(29);
      expect(database.prepare(
        `SELECT room_id AS roomId, gate_generation AS gateGeneration,
                blocked_at AS blockedAt
         FROM room_message_archive_gates ORDER BY room_id`,
      ).all()).toEqual([{
        roomId: "v14-archived",
        gateGeneration: 4,
        blockedAt: "2026-08-19T00:04:00.000Z",
      }]);
      expect(database.prepare(
        `SELECT grant_id AS id, grant_state AS state, grant_reason AS reason
         FROM agent_execution_grants ORDER BY grant_id`,
      ).all()).toEqual([
        { id: "v14-grant-consumed", state: "claimed", reason: null },
        { id: "v14-grant-pending", state: "revoked", reason: "legacy_unbound" },
      ]);
      expect(database.prepare(
        `SELECT confirmation_id AS id, confirmation_state AS state,
                confirmation_reason AS reason
         FROM tool_confirmations ORDER BY confirmation_id`,
      ).all()).toEqual([
        { id: "v14-confirmation-consumed", state: "confirmed", reason: null },
        { id: "v14-confirmation-pending", state: "rejected", reason: "legacy_unbound" },
      ]);
      expect(database.prepare(
        `SELECT call.tool_call_id AS toolCallId, confirmation.state AS confirmationState,
                grant.state AS grantState
         FROM tool_calls_v2 AS call
         JOIN tool_grants_v2 AS grant ON grant.tool_call_id = call.tool_call_id
         LEFT JOIN tool_confirmations_v2 AS confirmation
           ON confirmation.tool_call_id = call.tool_call_id
         ORDER BY call.tool_call_id`,
      ).all()).toEqual([
        { toolCallId: "legacy-tool-call:v14-grant-consumed",
          confirmationState: "confirmed", grantState: "claimed" },
        { toolCallId: "legacy-tool-call:v14-grant-pending",
          confirmationState: "rejected", grantState: "revoked" },
      ]);
      expect(database.prepare(
        `SELECT legacy_subject_kind AS kind, legacy_subject_id AS id, reason,
                review_required AS reviewRequired
         FROM tool_safety_quarantine_v2`,
      ).all()).toEqual([{
        kind: "grant", id: "v14-grant-consumed",
        reason: "legacy_needs_review", reviewRequired: 1,
      }]);
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM events WHERE event_type = 'tool.safety.changed'`,
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM tool_safety_repair_records_v2",
      ).get()).toEqual({ count: 0 });
    });
  });

  it("upgrades every historical v13-v26 contract to v27 without rewriting its history", () => {
    expect(AUTHORITY_SCHEMA_VERSION).toBe(29);
    for (let version = 13; version <= 26; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        const history = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(29);
        expect(database.prepare(
          `SELECT version, name, checksum FROM schema_migrations
           WHERE version <= ? ORDER BY version`,
        ).all(version)).toEqual(history);
      });
    }
  }, 30_000);

  it("moves the legacy internal Room-memory seam out of every public v25 tool projection", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 25);

      const affectedTables = [
        "agent_profiles",
        "agent_profile_revisions",
        "room_agent_assignments",
        "room_agent_assignment_revisions",
        "deployment_agent_profile_events",
        "deployment_agent_profile_repair_records",
        "events",
      ] as const;
      const triggers = database.prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'trigger' AND tbl_name IN (${affectedTables.map(() => "?").join(",")})
         ORDER BY name`,
      ).all(...affectedTables) as { readonly name: string; readonly sql: string }[];
      for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
      database.exec(`
        UPDATE actors SET tool_permissions_json = '["room-memory.read"]'
        WHERE id = 'agent-1';
        UPDATE room_memberships SET tool_permissions_json = '["room-memory.read"]'
        WHERE room_id = 'room-1' AND actor_id = 'agent-1';
        UPDATE agent_profiles SET tool_ceiling_json = '["room-memory.read"]'
        WHERE actor_id = 'agent-1';
        UPDATE agent_profile_revisions SET tool_ceiling_json = '["room-memory.read"]'
        WHERE actor_id = 'agent-1';
        UPDATE room_agent_assignments SET tool_subset_json = '["room-memory.read"]'
        WHERE agent_actor_id = 'agent-1';
        UPDATE room_agent_assignment_revisions SET tool_subset_json = '["room-memory.read"]'
        WHERE agent_actor_id = 'agent-1';
        UPDATE deployment_agent_profile_events SET payload_json = json_set(
          payload_json, '$.profile.toolCeiling', json('["room-memory.read"]')
        ) WHERE profile_id = (SELECT id FROM agent_profiles WHERE actor_id = 'agent-1');
        UPDATE deployment_agent_profile_repair_records SET projection_json = json_set(
          projection_json, '$.toolCeiling', json('["room-memory.read"]')
        ) WHERE profile_id = (SELECT id FROM agent_profiles WHERE actor_id = 'agent-1');
        UPDATE events SET payload_json = json_set(
          payload_json,
          '$.assignment.toolCeiling', json('["room-memory.read"]'),
          '$.assignment.toolSubset', json('["room-memory.read"]'),
          '$.assignment.effectiveTools', json('["room-memory.read"]')
        ) WHERE event_type = 'room.agent-assignment.changed'
          AND json_extract(payload_json, '$.assignment.agentActorId') = 'agent-1';
      `);
      const sha256 = (value: string): string =>
        createHash("sha256").update(value, "utf8").digest("hex");
      for (const row of database.prepare(
        `SELECT event_id AS id, payload_json AS json FROM deployment_agent_profile_events
         WHERE profile_id = (SELECT id FROM agent_profiles WHERE actor_id = 'agent-1')`,
      ).all() as { readonly id: string; readonly json: string }[]) {
        database.prepare(
          "UPDATE deployment_agent_profile_events SET payload_sha256 = ? WHERE event_id = ?",
        ).run(sha256(row.json), row.id);
      }
      for (const row of database.prepare(
        `SELECT profile_id AS id, projection_json AS json
         FROM deployment_agent_profile_repair_records
         WHERE profile_id = (SELECT id FROM agent_profiles WHERE actor_id = 'agent-1')`,
      ).all() as { readonly id: string; readonly json: string }[]) {
        database.prepare(
          `UPDATE deployment_agent_profile_repair_records
           SET projection_sha256 = ? WHERE profile_id = ?`,
        ).run(sha256(row.json), row.id);
      }
      for (const trigger of triggers) database.exec(trigger.sql);
      const roomStream = database.prepare(
        `SELECT head_seq AS headSeq FROM streams
         WHERE stream_kind = 'room' AND stream_id = 'room-1'`,
      ).get() as { readonly headSeq: number };
      const assignmentPayload = JSON.stringify({
        assignment: {
          agentActorId: "agent-1",
          capabilityCeiling: [],
          capabilitySubset: [],
          effectiveCapabilities: [],
          toolCeiling: ["room-memory.read"],
          toolSubset: ["room-memory.read"],
          effectiveTools: ["room-memory.read"],
        },
      });
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(
          `UPDATE streams SET head_seq = ?
           WHERE stream_kind = 'room' AND stream_id = 'room-1'`,
        ).run(roomStream.headSeq + 1);
        database.prepare(
          `INSERT INTO events (
             event_id, stream_kind, stream_id, stream_seq, room_id,
             authority_kind, actor_id, event_type, occurred_at, payload_json
           ) VALUES (
             'v25-room-memory-assignment-event', 'room', 'room-1', ?, 'room-1',
             'human', 'human-1', 'room.agent-assignment.changed',
             '2026-08-30T00:00:00.000Z', ?
           )`,
        ).run(roomStream.headSeq + 1, assignmentPayload);
        database.exec("COMMIT");
      } catch (error: unknown) {
        database.exec("ROLLBACK");
        throw error;
      }

      expect(database.prepare(
        "SELECT tool_ceiling_json AS tools FROM agent_profiles WHERE actor_id = 'agent-1'",
      ).get()).toEqual({ tools: '["room-memory.read"]' });
      expect(database.prepare(
        "SELECT tool_subset_json AS tools FROM room_agent_assignments WHERE agent_actor_id = 'agent-1'",
      ).get()).toEqual({ tools: '["room-memory.read"]' });

      migrateAuthorityDatabase(database);

      expect(database.prepare(
        `SELECT capability_ceiling_json AS capabilities, tool_ceiling_json AS tools
         FROM agent_profiles WHERE actor_id = 'agent-1'`,
      ).get()).toEqual({ capabilities: '["room.memory.read"]', tools: '[]' });
      expect(database.prepare(
        `SELECT capability_subset_json AS capabilities, tool_subset_json AS tools
         FROM room_agent_assignments WHERE agent_actor_id = 'agent-1'`,
      ).get()).toEqual({ capabilities: '["room.memory.read"]', tools: '[]' });
      expect(database.prepare(
        `SELECT tool_permissions_json AS actorTools,
                (SELECT tool_permissions_json FROM room_memberships
                 WHERE room_id = 'room-1' AND actor_id = 'agent-1') AS membershipTools
         FROM actors WHERE id = 'agent-1'`,
      ).get()).toEqual({ actorTools: '[]', membershipTools: '[]' });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM agent_profile_revisions
         WHERE tool_ceiling_json LIKE '%room-memory.read%'
            OR capability_ceiling_json NOT LIKE '%room.memory.read%'`,
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM room_agent_assignment_revisions
         WHERE tool_subset_json LIKE '%room-memory.read%'
            OR capability_subset_json NOT LIKE '%room.memory.read%'`,
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT (
           SELECT COUNT(*) FROM deployment_agent_profile_events
           WHERE payload_json LIKE '%room-memory.read%'
         ) + (
           SELECT COUNT(*) FROM deployment_agent_profile_repair_records
           WHERE projection_json LIKE '%room-memory.read%'
         ) + (
           SELECT COUNT(*) FROM events
           WHERE event_type = 'room.agent-assignment.changed'
             AND payload_json LIKE '%room-memory.read%'
         ) AS count`,
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE event_id = 'v25-room-memory-assignment-event'
           AND EXISTS (
             SELECT 1 FROM json_each(payload_json, '$.assignment.capabilityCeiling')
             WHERE value = 'room.memory.read'
           )
           AND EXISTS (
             SELECT 1 FROM json_each(payload_json, '$.assignment.capabilitySubset')
             WHERE value = 'room.memory.read'
           )
           AND EXISTS (
             SELECT 1 FROM json_each(payload_json, '$.assignment.effectiveCapabilities')
             WHERE value = 'room.memory.read'
           )`,
      ).get()).toEqual({ count: 1 });

      expectSqlRejected(database,
        `UPDATE agent_profiles SET tool_ceiling_json = '["room-memory.read"]'
         WHERE actor_id = 'agent-1'`);
      expectSqlRejected(database,
        `UPDATE room_agent_assignments SET tool_subset_json = '["room-memory.read"]'
         WHERE agent_actor_id = 'agent-1'`);
    });
  });

  it("rolls every v14 migration statement back with v13 schema and history intact", () => {
    for (
      let failAfterStatement = 1;
      failAfterStatement <= AUTHORITY_V14_STATEMENT_COUNT_FOR_TEST;
      failAfterStatement += 1
    ) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToVersion13ForTest(database);
        const before = snapshot(database);

        expect(() => migrateAuthorityDatabase(database, { failAfterStatement }))
          .toThrow(/injected migration failure/i);

        expect(readSchemaVersion(database)).toBe(13);
        expect(snapshot(database)).toEqual(before);
      });
    }
  }, 20_000);

  it("rolls every v15 migration statement back with v14 schema and history intact", () => {
    for (
      let failAfterStatement = 1;
      failAfterStatement <= AUTHORITY_V15_STATEMENT_COUNT_FOR_TEST;
      failAfterStatement += 1
    ) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToVersion14ForTest(database);
        const before = snapshot(database);

        expect(() => migrateAuthorityDatabase(database, { failAfterStatement }))
          .toThrow(/injected migration failure/i);

        expect(readSchemaVersion(database)).toBe(14);
        expect(snapshot(database)).toEqual(before);
      });
    }
  }, 20_000);

  it("rejects a same-version message gate that outruns the Room lifecycle generation", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('gate-owner', 'human', 'Owner');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'gate-owner', 0, 1), ('room', 'gate-room', 0, 1);
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('gate-room', 'Room', 'active', '2026-08-19T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES ('gate-room', 'gate-owner', 'human', 'member', NULL, '[]',
                  '2026-08-19T00:00:00.000Z', NULL, 0);
        UPDATE rooms SET owner_actor_id = 'gate-owner' WHERE id = 'gate-room';
        INSERT INTO room_message_archive_gates (room_id, gate_generation, blocked_at)
        VALUES ('gate-room', 1, '2026-08-19T00:00:00.000Z');
      `);

      expect(() => migrateAuthorityDatabase(database)).toThrow(/message archive gates/i);
    });
  });

  it("upgrades v12 ownership into one canonical Human owner without a second Project aggregate", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion12ForTest(database);
      expect(readSchemaVersion(database)).toBe(12);
      database.exec(`
        INSERT INTO actors (id, kind, display_name) VALUES
          ('owner-v12', 'human', 'Owner'), ('member-v12', 'human', 'Member');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
          ('identity', 'owner-v12', 0, 1), ('identity', 'member-v12', 0, 1),
          ('room', 'room-v12', 0, 1);
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('room-v12', 'Room', 'active', '2026-08-18T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES
          ('room-v12', 'owner-v12', 'human', 'owner', NULL, '[]',
           '2026-08-18T00:00:00.000Z', NULL, 0),
          ('room-v12', 'member-v12', 'human', 'member', NULL, '[]',
           '2026-08-18T00:00:00.000Z', NULL, 0);
      `);

      migrateAuthorityDatabase(database);

      expect(readSchemaVersion(database)).toBe(29);
      expect(database.prepare(
        `SELECT id, owner_actor_id AS ownerActorId, governance_revision AS governanceRevision,
                archive_generation AS archiveGeneration, archived_at AS archivedAt
         FROM rooms WHERE id = 'room-v12'`,
      ).get()).toEqual({
        id: "room-v12", ownerActorId: "owner-v12", governanceRevision: 0,
        archiveGeneration: 0, archivedAt: null,
      });
      expect(database.prepare(
        "SELECT actor_id AS actorId, role FROM room_memberships WHERE room_id = 'room-v12' ORDER BY actor_id",
      ).all()).toEqual([
        { actorId: "member-v12", role: "member" },
        { actorId: "owner-v12", role: "owner" },
      ]);
      expect(listAuthorityTables(database)).not.toContain("projects");
    });
  });

  it.each([
    { name: "zero owner", owners: [] as readonly [string, string, string][] },
    { name: "two owners", owners: [["human-a", "human", "owner"], ["human-b", "human", "owner"]] as const },
    { name: "Agent owner", owners: [["agent-a", "agent", "owner"]] as const },
  ])("refuses v12 $name with an atomic zero-write v13 migration", ({ owners }) => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion12ForTest(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name) VALUES
          ('human-a', 'human', 'A'), ('human-b', 'human', 'B'), ('agent-a', 'agent', 'Agent');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
          ('identity', 'human-a', 0, 1), ('identity', 'human-b', 0, 1),
          ('identity', 'agent-a', 0, 1), ('room', 'invalid-owner-room', 0, 1);
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('invalid-owner-room', 'Invalid', 'active', '2026-08-18T00:00:00.000Z');
      `);
      const insert = database.prepare(`INSERT INTO room_memberships (
        room_id, actor_id, kind, role, participation, tool_permissions_json,
        joined_at, configured_at, access_revision
      ) VALUES ('invalid-owner-room', ?, ?, ?, NULL, '[]', '2026-08-18T00:00:00.000Z', NULL, 0)`);
      for (const owner of owners) insert.run(...owner);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database)).toThrow(/exactly one same-room Human owner/i);
      expect(readSchemaVersion(database)).toBe(12);
      expect(snapshot(database)).toEqual(before);
    });
  });

  it("refuses cross-room and non-Human canonical owner updates", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name) VALUES
          ('human-owner-a', 'human', 'A'), ('human-owner-b', 'human', 'B'),
          ('agent-owner', 'agent', 'Agent');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
          ('identity', 'human-owner-a', 0, 1), ('identity', 'human-owner-b', 0, 1),
          ('identity', 'agent-owner', 0, 1), ('room', 'room-a', 0, 1), ('room', 'room-b', 0, 1);
        INSERT INTO rooms (id, name, status, created_at) VALUES
          ('room-a', 'A', 'active', '2026-08-18T00:00:00.000Z'),
          ('room-b', 'B', 'active', '2026-08-18T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES
          ('room-a', 'human-owner-a', 'human', 'member', NULL, '[]', 't', NULL, 0),
          ('room-a', 'agent-owner', 'agent', NULL, 'active', '["read"]', NULL, 't', 0),
          ('room-b', 'human-owner-b', 'human', 'member', NULL, '[]', 't', NULL, 0);
        UPDATE rooms SET owner_actor_id = 'human-owner-a' WHERE id = 'room-a';
        UPDATE rooms SET owner_actor_id = 'human-owner-b' WHERE id = 'room-b';
      `);
      expectSqlRejected(database, "UPDATE rooms SET owner_actor_id = 'human-owner-b' WHERE id = 'room-a'");
      expectSqlRejected(database, "UPDATE rooms SET owner_actor_id = 'agent-owner' WHERE id = 'room-a'");
      expectSqlRejected(database, "UPDATE rooms SET owner_actor_id = NULL WHERE id = 'room-a'");
    });
  });

  it("rolls every v13 migration statement back with schema, data, version, and history intact", () => {
    for (let failAfterStatement = 1; failAfterStatement <= 20; failAfterStatement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToVersion12ForTest(database);
        database.exec(`
          INSERT INTO actors (id, kind, display_name) VALUES ('rollback-owner', 'human', 'Owner');
          INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
            ('identity', 'rollback-owner', 0, 1), ('room', 'rollback-room', 0, 1);
          INSERT INTO rooms (id, name, status, created_at)
          VALUES ('rollback-room', 'Rollback', 'active', '2026-08-18T00:00:00.000Z');
          INSERT INTO room_memberships (
            room_id, actor_id, kind, role, participation, tool_permissions_json,
            joined_at, configured_at, access_revision
          ) VALUES ('rollback-room', 'rollback-owner', 'human', 'owner', NULL, '[]',
                    '2026-08-18T00:00:00.000Z', NULL, 0);
        `);
        const before = snapshot(database);
        expect(() => migrateAuthorityDatabase(database, { failAfterStatement })).toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(12);
        expect(snapshot(database)).toEqual(before);
      });
    }
  });
  it("upgrades v11 session generations into one closed v12 device-family projection", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion11ForTest(database);
      expect(readSchemaVersion(database)).toBe(11);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('human-session-v11', 'human', 'Legacy Human');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'human-session-v11', 0, 1);
        INSERT INTO sessions (
          family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
          access_expires_at, refresh_expires_at, revoked_at
        ) VALUES
          ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'legacy-account', 'human-session-v11', 'legacy-access-1',
           'legacy-refresh-1', 2000, 9000, 1500),
          ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'legacy-account', 'human-session-v11', 'legacy-access-2',
           'legacy-refresh-2', 4000, 12000, NULL);
      `);

      migrateAuthorityDatabase(database);

      expect(AUTHORITY_SCHEMA_VERSION).toBe(29);
      expect(readSchemaVersion(database)).toBe(29);
      expect(tableColumns(database, "session_families")).toEqual([
        "family_id", "public_id", "account_id", "actor_id", "device_id",
        "device_label", "platform", "created_at", "refresh_expires_at", "revoked_at",
      ]);
      const migratedFamilies = database.prepare(
        `SELECT family_id AS familyId, public_id AS publicId, account_id AS accountId,
                actor_id AS actorId, device_id AS deviceId, device_label AS deviceLabel,
                platform, created_at AS createdAt,
                refresh_expires_at AS refreshExpiresAt, revoked_at AS revokedAt
         FROM session_families`,
      ).all();
      expect(migratedFamilies).toEqual([{
        familyId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        publicId: expect.stringMatching(/^[0-9a-f]{64}$/),
        accountId: "legacy-account",
        actorId: "human-session-v11",
        deviceId: "legacy",
        deviceLabel: "Legacy device",
        platform: "unknown",
        createdAt: null,
        refreshExpiresAt: 12_000,
        revokedAt: null,
      }]);
      expect(String(migratedFamilies[0]?.publicId)).not.toContain(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
      expect(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({
        count: 2,
      });
    });
  });

  it("rolls back the v12 family table, version, and migration record atomically", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion11ForTest(database);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database, { failAfterStatement: 1 }))
        .toThrow(/injected migration failure/i);

      expect(readSchemaVersion(database)).toBe(11);
      expect(snapshot(database)).toEqual(before);
      expect(listAuthorityTables(database)).not.toContain("session_families");
    });
  });

  it("atomically rejects an over-cap v11 principal while ignoring expired families", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion11ForTest(database);
      seedV11SessionCapacity(database, 97);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database)).toThrow(
        /active session family capacity exceeds 96/i,
      );
      expect(readSchemaVersion(database)).toBe(11);
      expect(listAuthorityTables(database)).not.toContain("session_families");
      expect(snapshot(database)).toEqual(before);
    });

    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion11ForTest(database);
      seedV11SessionCapacity(database, 97, 0);

      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
      expect(readSchemaVersion(database)).toBe(29);
      expect(database.prepare("SELECT COUNT(*) AS count FROM session_families").get())
        .toEqual({ count: 97 });
    });
  });

  it("rejects cross-principal v11 families and missing v12 family projections", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion11ForTest(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('family-human-a', 'human', 'A'), ('family-human-b', 'human', 'B');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'family-human-a', 0, 1), ('identity', 'family-human-b', 0, 1);
        INSERT INTO sessions (
          family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
          access_expires_at, refresh_expires_at, revoked_at
        ) VALUES
          ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
           'account-a', 'family-human-a', 'access-a', 'refresh-a', 1000, 2000, NULL),
          ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
           'account-b', 'family-human-b', 'access-b', 'refresh-b', 1000, 2000, NULL);
      `);

      expect(() => migrateAuthorityDatabase(database)).toThrow(
        /session generation must match exactly one family principal/i,
      );
      expect(readSchemaVersion(database)).toBe(11);
      expect(listAuthorityTables(database)).not.toContain("session_families");
    });

    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('missing-family-human', 'human', 'Human');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'missing-family-human', 0, 1);
        INSERT INTO session_families (
          family_id, public_id, account_id, actor_id, device_id, device_label,
          platform, created_at, refresh_expires_at, revoked_at
        ) VALUES ('missing-family', 'missing-public', 'missing-account',
                  'missing-family-human', 'device', 'Device', 'unknown', 0, 2000, NULL);
        INSERT INTO sessions (
          family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
          access_expires_at, refresh_expires_at, revoked_at
        ) VALUES ('missing-family', 'missing-account', 'missing-family-human',
                  'missing-access', 'missing-refresh', 1000, 2000, NULL);
        DELETE FROM session_families WHERE family_id = 'missing-family';
      `);

      expect(() => migrateAuthorityDatabase(database)).toThrow(
        /session generation must match exactly one family principal/i,
      );
    });
  });
});
}

export function registerFoundationAuthoritySchemaTests(): void {
describe("authority SQLite schema — foundations", () => {
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

  it("migrates a fresh database through immutable v1-v18 to the complete schema", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);

      expect(AUTHORITY_SCHEMA_VERSION).toBe(29);
      expect(readSchemaVersion(database)).toBe(29);
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
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 7,
          name: "single-route-authority",
          checksum: "4ad86ad359400228cf5428d7bb59c5fc371009904fe50cfedd4641e79e6d4977",
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 8,
          name: "closed-open-item-authority",
          checksum: V8_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 9,
          name: "closed-light-task-authority",
          checksum: V9_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 10,
          name: "ball-in-court-boundaries",
          checksum: V10_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 11,
          name: "hard-human-preemption",
          checksum: V11_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 12,
          name: "authoritative-session-families",
          checksum: V12_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 13,
          name: "room-governance-foundation",
          checksum: V13_MIGRATION_CHECKSUM,
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 14,
          name: "shared-authority-production-providers",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 15,
          name: "truthful-room-lifecycle-audit-vocabulary",
          checksum: "41740e7d34f6807248bf7879f34f9026844802dfe5a43f0ee18bf498a24dc0c9",
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 16,
          name: "message-authority-vnext",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 17,
          name: "attachment-authority-pipeline",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 18,
          name: "room-memory-authority-steward",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 19,
          name: "context-snapshot-authority",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 20,
          name: "agent-profile-routing-authority",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 21,
          name: "direct-invocation-authority-binding",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 22,
          name: "invocation-runtime-authority",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 23,
          name: "project-loop-authority",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 24,
          name: "project-boundary-agent-intent-lineage",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 25,
          name: "project-transition-authority",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 26,
          name: "tool-safety-authority",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 27,
          name: "sync-reliability-lifecycle",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 28,
          name: "recipient-notification-authority",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          applied_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        {
          version: 29,
          name: "privacy-operations-retention-recovery",
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
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
        "authority_kind",
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
        "dead_lettered_at",
      ]);
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
    });
  });

  it("adds immutable v5 scoped keyset indexes and uses them for sparse interleaved scans", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion4ForTest(database);
      expect(readSchemaVersion(database)).toBe(4);
      migrateAuthorityDatabase(database);

      expect(AUTHORITY_SCHEMA_VERSION).toBe(29);
      expect(readSchemaVersion(database)).toBe(29);
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

  it("upgrades historical v5 executions into canonical v6 attempts without losing legacy fields", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion5ForTest(database);
      expect(readSchemaVersion(database)).toBe(5);
      database.exec(`
        INSERT INTO actors (id, kind, display_name, reachability, readiness, tool_permissions_json)
        VALUES
          ('human-v5', 'human', 'Human V5', 'online', NULL, '[]'),
          ('agent-v5', 'agent', 'Agent V5', NULL, 'ready', '["repository.git-status"]');
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('room-v5', 'Room V5', 'active', '2026-08-12T00:00:00.000Z');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES
          ('identity', 'human-v5', 0, 1),
          ('identity', 'agent-v5', 0, 1),
          ('room', 'room-v5', 0, 1);
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES ('room-v5', 'human-v5', 'human', 'owner', NULL, '[]',
                  '2026-08-12T00:00:00.000Z', NULL, 0);
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('message-v5', 'room-v5', 'human-v5', 'human', 'legacy', '2026-08-12T00:00:01.000Z');
        INSERT INTO agent_executions (
          id, room_id, agent_id, trigger_message_id, status, started_at,
          completed_at, result_json, requester_actor_id, tool_name
        ) VALUES
          ('execution-v5-running', 'room-v5', 'agent-v5', 'message-v5', 'running',
           '2026-08-12T00:00:02.000Z', NULL, '{"legacy":true}', 'human-v5', 'repository.git-status'),
          ('execution-v5-interrupted', 'room-v5', 'agent-v5', 'message-v5', 'interrupted',
           '2026-08-12T00:00:03.000Z', '2026-08-12T00:00:04.000Z', '"kept"',
           'human-v5', 'repository.git-status');
      `);

      migrateAuthorityDatabase(database);

      expect(readSchemaVersion(database)).toBe(29);
      expect(database.prepare(
        `SELECT id, status, action_category AS actionCategory,
                tool_dispatch_phase AS toolDispatchPhase,
                current_attempt_seq AS attemptSeq, retry_cycle AS retryCycle,
                retry_ordinal AS retryOrdinal, recovery_cursor AS recoveryCursor,
                queued_at AS queuedAt, updated_at AS updatedAt,
                cancellation_reason AS cancellationReason, result_json AS resultJson
         FROM agent_executions ORDER BY id`,
      ).all()).toEqual([
        {
          id: "execution-v5-interrupted",
          status: "cancelled",
          actionCategory: "tool_call",
          toolDispatchPhase: "finished",
          attemptSeq: 1,
          retryCycle: 1,
          retryOrdinal: 1,
          recoveryCursor: 0,
          queuedAt: "2026-08-12T00:00:03.000Z",
          updatedAt: "2026-08-12T00:00:04.000Z",
          cancellationReason: "legacy_interrupted",
          resultJson: '"kept"',
        },
        {
          id: "execution-v5-running",
          status: "running",
          actionCategory: "tool_call",
          toolDispatchPhase: "dispatched",
          attemptSeq: 1,
          retryCycle: 1,
          retryOrdinal: 1,
          recoveryCursor: 0,
          queuedAt: "2026-08-12T00:00:02.000Z",
          updatedAt: "2026-08-12T00:00:02.000Z",
          cancellationReason: null,
          resultJson: '{"legacy":true}',
        },
      ]);
      expect(database.prepare(
        `SELECT execution_id AS executionId, attempt_seq AS attemptSeq, status,
                action_category AS actionCategory, recovery_cursor AS recoveryCursor
         FROM agent_execution_attempts ORDER BY execution_id`,
      ).all()).toEqual([
        { executionId: "execution-v5-interrupted", attemptSeq: 1, status: "cancelled", actionCategory: "tool_call", recoveryCursor: 0 },
        { executionId: "execution-v5-running", attemptSeq: 1, status: "running", actionCategory: "tool_call", recoveryCursor: 0 },
      ]);
    });
  });

  it("rolls back an injected v6 migration failure as one transaction", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion5ForTest(database);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database, { failAfterStatement: 5 }))
        .toThrow(/injected migration failure/i);

      expect(readSchemaVersion(database)).toBe(5);
      expect(snapshot(database)).toEqual(before);
      expect(listAuthorityTables(database)).not.toContain("agent_execution_attempts");
    });
  });

  it("upgrades immutable v6 to v7 route authority and rolls back an injected v7 failure", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion6ForTest(database);
      expect(readSchemaVersion(database)).toBe(6);
      expect(listAuthorityTables(database)).not.toContain("route_jobs");
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database, { failAfterStatement: 4 }))
        .toThrow(/injected migration failure/i);
      expect(readSchemaVersion(database)).toBe(6);
      expect(snapshot(database)).toEqual(before);

      migrateAuthorityDatabase(database);
      expect(readSchemaVersion(database)).toBe(29);
      expect(tableColumns(database, "route_jobs")).toEqual([
        "id", "room_id", "source_message_id", "status", "current_attempt", "topic_key",
        "embedding_model_version", "window_size", "cosine_threshold", "room_phase",
        "created_at", "updated_at", "completed_at", "terminal_error_code", "next_retry_at",
        "revision", "candidate_snapshot_id",
      ]);
      expectSqlRejected(database, `
        INSERT INTO route_jobs (
          id, room_id, source_message_id, status, current_attempt, topic_key,
          embedding_model_version, window_size, cosine_threshold, room_phase,
          created_at, updated_at
        ) VALUES (
          'route-invalid', 'missing-room', 'missing-message', 'running', 1, 'topic',
          'changed-silently', 9, 0.7, 'discussion', 'now', 'now'
        )
      `);
    });
  });

  it("upgrades canonical v7 OpenItems to closed v8 and rolls back the rebuild atomically", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion7ForTest(database);
      expect(readSchemaVersion(database)).toBe(7);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('human-v7-a', 'human', 'A'), ('human-v7-b', 'human', 'B');
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('room-v7', 'V7', 'active', '2026-08-17T00:00:00.000Z');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES
          ('identity', 'human-v7-a', 0, 1),
          ('identity', 'human-v7-b', 0, 1),
          ('room', 'room-v7', 0, 1);
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, joined_at
        ) VALUES
          ('room-v7', 'human-v7-a', 'human', 'owner', NULL, '2026-08-17T00:00:00.000Z'),
          ('room-v7', 'human-v7-b', 'human', 'member', NULL, '2026-08-17T00:00:00.000Z');
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('message-v7', 'room-v7', 'human-v7-a', 'human', 'source', '2026-08-17T00:00:01.000Z');
        INSERT INTO open_items (
          id, room_id, source_message_id, assigned_actor_id, status, body,
          created_at, resolved_at, requester_actor_id, transfer_chain_json, responded_at
        ) VALUES (
          'item-v7', 'room-v7', 'message-v7', 'human-v7-b', 'pending_response',
          'legacy canonical item', '2026-08-17T00:00:02.000Z', NULL,
          'human-v7-a', '[]', NULL
        );
      `);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database, { failAfterStatement: 6 }))
        .toThrow(/injected migration failure/i);
      expect(readSchemaVersion(database)).toBe(7);
      expect(snapshot(database)).toEqual(before);

      migrateAuthorityDatabase(database);
      expect(readSchemaVersion(database)).toBe(29);
      expect(database.prepare(
        `SELECT id, current_owner_actor_id AS currentOwnerId, status,
                requester_actor_id AS requesterId, origin_kind AS originKind,
                responded_at AS respondedAt
         FROM open_items WHERE id = 'item-v7'`,
      ).get()).toEqual({
        id: "item-v7",
        currentOwnerId: "human-v7-b",
        status: "awaiting",
        requesterId: "human-v7-a",
        originKind: "manual_unfinished",
        respondedAt: null,
      });
      expectSqlRejected(database, `
        INSERT INTO open_items (
          id, room_id, source_message_id, current_owner_actor_id, status, body,
          created_at, responded_at, requester_actor_id, transfer_chain_json,
          origin_kind
        ) VALUES (
          'invalid-terminal-owner', 'room-v7', 'message-v7', 'human-v7-b',
          'answered', 'invalid', 'now', 'now', 'human-v7-a', '[]', 'human_mention'
        )
      `);
      database.prepare(
        `UPDATE open_items
         SET current_owner_actor_id = 'human-v7-a', status = 'transferred',
             transfer_chain_json = ?
         WHERE id = 'item-v7'`,
      ).run(JSON.stringify([{
        fromId: "human-v7-b", toId: "human-v7-a", reason: "handoff",
        transferredAt: "2026-08-17T00:00:02.000Z",
      }]));
      expect(() => database.prepare(
        `UPDATE open_items SET transfer_chain_json = ? WHERE id = 'item-v7'`,
      ).run(JSON.stringify([{
        fromId: "human-v7-b", toId: "human-v7-a", reason: "rewritten",
        transferredAt: "2026-08-17T00:00:02.000Z",
      }]))).toThrow(/canonical open item update is invalid/i);
      database.prepare(
        `UPDATE open_items
         SET current_owner_actor_id = NULL, status = 'answered',
             responded_at = '2026-08-17T00:00:03.000Z'
         WHERE id = 'item-v7'`,
      ).run();
      expect(() => database.prepare(
        `UPDATE open_items
         SET current_owner_actor_id = 'human-v7-a', status = 'transferred', responded_at = NULL
         WHERE id = 'item-v7'`,
      ).run()).toThrow(/canonical open item update is invalid/i);
    });
  });

  it("upgrades immutable v8 to closed v9 LightTasks and rolls back the migration atomically", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion8ForTest(database);
      expect(readSchemaVersion(database)).toBe(8);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('human-v9-owner', 'human', 'Owner'), ('human-v9-member', 'human', 'Member');
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('room-v9', 'V9', 'active', '2026-08-17T00:00:00.000Z');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES
          ('identity', 'human-v9-owner', 0, 1),
          ('identity', 'human-v9-member', 0, 1),
          ('room', 'room-v9', 0, 1);
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, joined_at
        ) VALUES
          ('room-v9', 'human-v9-owner', 'human', 'owner', NULL, '2026-08-17T00:00:00.000Z'),
          ('room-v9', 'human-v9-member', 'human', 'member', NULL, '2026-08-17T00:00:00.000Z');
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('message-v9', 'room-v9', 'human-v9-owner', 'human', 'source',
                '2026-08-17T00:00:01.000Z');
      `);
      const before = snapshot(database);

      expect(() => migrateAuthorityDatabase(database, { failAfterStatement: 2 }))
        .toThrow(/injected migration failure/i);
      expect(readSchemaVersion(database)).toBe(8);
      expect(snapshot(database)).toEqual(before);
      expect(listAuthorityTables(database)).not.toContain("light_tasks");

      migrateAuthorityDatabaseToVersion9ForTest(database);
      expect(readSchemaVersion(database)).toBe(9);
      expect(() => database.prepare(
        `INSERT INTO light_tasks (
           id, room_id, source_message_id, title, verifier_role, criteria_json,
           status, created_at
         ) VALUES ('task-v9-forged', 'room-v9', 'message-v9', 'Forged', 'member', ?,
                   'todo', '2026-08-17T00:00:02.000Z')`,
      ).run(JSON.stringify([{ id: "criterion-1", text: "Reviewed", met: false, deps: [] }])))
        .toThrow(/canonical light task is invalid/i);
      database.prepare(
        `INSERT INTO light_tasks (
           id, room_id, source_message_id, title, verifier_role, criteria_json,
           status, created_at
         ) VALUES ('task-v9', 'room-v9', 'message-v9', 'Ship it', 'member', ?,
                   'todo', '2026-08-17T00:00:02.000Z')`,
      ).run(JSON.stringify([{ id: "criterion-1", text: "Reviewed", met: false }]));
      database.exec(`
        UPDATE light_tasks
        SET claimant_actor_id = 'human-v9-owner', claimant_role_at_claim = 'owner',
            status = 'claimed', claimed_at = '2026-08-17T00:00:03.000Z'
        WHERE id = 'task-v9';
        UPDATE light_tasks
        SET verifier_actor_id = 'human-v9-member', status = 'delivered',
            delivered_at = '2026-08-17T00:00:04.000Z'
        WHERE id = 'task-v9';
      `);
      expect(() => database.exec(`
        UPDATE light_tasks SET status = 'verified', verified_at = '2026-08-17T00:00:05.000Z'
        WHERE id = 'task-v9'
      `)).toThrow();
      database.prepare("UPDATE light_tasks SET criteria_json = ? WHERE id = 'task-v9'")
        .run(JSON.stringify([{ id: "criterion-1", text: "Reviewed", met: true }]));
      database.exec(`
        UPDATE light_tasks SET status = 'verified', verified_at = '2026-08-17T00:00:05.000Z'
        WHERE id = 'task-v9'
      `);
      expect(() => database.exec(`
        UPDATE light_tasks SET criteria_json = '[]' WHERE id = 'task-v9'
      `)).toThrow(/canonical light task update is invalid/i);
    });
  });

  it("upgrades immutable v9 to v10 ball boundaries and rolls back the migration atomically", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion9ForTest(database);
      expect(readSchemaVersion(database)).toBe(9);
      const before = snapshot(database);
      expect(() => migrateAuthorityDatabase(database, { failAfterStatement: 1 }))
        .toThrow(/injected migration failure/i);
      expect(readSchemaVersion(database)).toBe(9);
      expect(snapshot(database)).toEqual(before);
      expect(listAuthorityTables(database)).not.toContain("ball_boundary_claims");

      migrateAuthorityDatabase(database);
      expect(readSchemaVersion(database)).toBe(29);
      expect(tableColumns(database, "ball_boundary_claims")).toEqual([
        "id", "room_id", "source_kind", "source_id", "holder_actor_id", "holder_kind",
        "reason", "since_at", "deadline_at", "boundary_kind", "claimed_at", "route_consumed_at",
      ]);
      expect(database.prepare(
        "SELECT checksum FROM schema_migrations WHERE version = 10",
      ).get()).toEqual({ checksum: V10_MIGRATION_CHECKSUM });
    });
  });

  it("upgrades immutable v10 to v11 human preemption and rolls back atomically", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion10ForTest(database);
      expect(readSchemaVersion(database)).toBe(10);
      database.exec(`
        INSERT INTO actors (id, kind, display_name, tool_permissions_json)
        VALUES ('human-v10', 'human', 'Human', '[]'), ('agent-v10', 'agent', 'Agent', '[]');
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('room-v10', 'Room', 'active', '2026-08-17T00:00:00.000Z');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES
          ('identity', 'human-v10', 0, 1),
          ('identity', 'agent-v10', 0, 1),
          ('room', 'room-v10', 0, 1);
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES ('room-v10', 'human-v10', 'human', 'owner', NULL, '[]',
                  '2026-08-17T00:00:00.000Z', NULL, 0);
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('message-fence-v10', 'room-v10', 'human-v10', 'human', 'fence', '2026-08-17T00:00:00.000Z');
        INSERT INTO agent_executions (
          id, room_id, agent_id, trigger_message_id, status, started_at, completed_at,
          requester_actor_id, tool_name, action_category, tool_dispatch_phase,
          current_attempt_seq, retry_cycle, retry_ordinal, recovery_cursor,
          queued_at, updated_at, cancellation_reason
        ) VALUES
          ('execution-old-v10', 'room-v10', 'agent-v10', 'message-fence-v10', 'cancelled',
           '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:01.000Z', 'human-v10',
           'model.generate', 'waiting_upstream', NULL, 1, 1, 1, 0,
           '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:01.000Z', 'human_preempted'),
          ('execution-replacement-v10', 'room-v10', 'agent-v10', 'message-fence-v10', 'queued',
           '2026-08-17T00:00:02.000Z', NULL, 'human-v10', 'model.generate', 'model_generation', NULL, 1, 1, 1, 0,
           '2026-08-17T00:00:02.000Z', '2026-08-17T00:00:02.000Z', NULL);
        INSERT INTO agent_human_fences (
          fence_message_id, execution_id, old_attempt_seq, cancelled_at
        ) VALUES ('message-fence-v10', 'execution-old-v10', 1, '2026-08-17T00:00:01.000Z');
        INSERT INTO agent_fence_replacements (
          fence_message_id, old_execution_id, old_attempt_seq, route_job_id,
          selected_agent_id, replacement_execution_id, created_at
        ) VALUES (
          'message-fence-v10', 'execution-old-v10', 1, 'route-v10',
          'agent-v10', 'execution-replacement-v10', '2026-08-17T00:00:02.000Z'
        );
      `);
      const before = snapshot(database);
      expect(() => migrateAuthorityDatabase(database, { failAfterStatement: 1 }))
        .toThrow(/injected migration failure/i);
      expect(readSchemaVersion(database)).toBe(10);
      expect(snapshot(database)).toEqual(before);
      expect(listAuthorityTables(database)).not.toContain("human_preemption_fences");
      expect(tableColumns(database, "agent_executions")).not.toContain("supersedes_execution_ids_json");

      migrateAuthorityDatabase(database);
      expect(readSchemaVersion(database)).toBe(29);
      expect(tableColumns(database, "human_preemption_fences")).toEqual([
        "source_human_message_id", "room_id", "human_actor_id", "accepted_at",
        "cancelled_count", "cancel_committed_at", "route_job_id", "route_created_at",
      ]);
      expect(tableColumns(database, "agent_executions")).toContain("supersedes_execution_ids_json");
      expect(database.prepare(
        "SELECT checksum FROM schema_migrations WHERE version = 11",
      ).get()).toEqual({ checksum: V11_MIGRATION_CHECKSUM });
      expect(database.prepare(
        `SELECT old_execution_id AS oldExecutionId,
                replacement_execution_id AS replacementExecutionId
         FROM agent_fence_replacements`,
      ).get()).toEqual({
        oldExecutionId: "execution-old-v10",
        replacementExecutionId: "execution-replacement-v10",
      });
    });
  });

  it("adds complete canonical collaboration columns in immutable v4", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion3ForTest(database);
      expect(readSchemaVersion(database)).toBe(3);

      migrateAuthorityDatabase(database);

      expect(readSchemaVersion(database)).toBe(29);
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

      expect(readSchemaVersion(database)).toBe(29);
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

      expect(readSchemaVersion(database)).toBe(29);
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
        { room_id: "room-2", actor_id: "human-1", access_revision: 0 },
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

      expect(readSchemaVersion(database)).toBe(29);
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
        lastError: "send_rejected",
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
});
}

export function registerIntegrityAuthoritySchemaTests(): void {
describe("authority SQLite schema — integrity", () => {
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
  }, 15_000);

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
        migrateAuthorityDatabase(database);
        tamperSchemaSql(database, tableName, search, replacement);

        expect(() => migrateAuthorityDatabase(database)).toThrow(/unknown schema/i);
      });
    }
  }, 15_000);

  it("enforces actor-kind and cross-room semantics at each database statement", () => {
    withDatabase((database) => {
      createV1Fixture(database);
      seedV1History(database);
      migrateAuthorityDatabase(database);
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
        INSERT INTO session_families (
          family_id, public_id, account_id, actor_id, device_id, device_label,
          platform, created_at, refresh_expires_at, revoked_at
        ) VALUES (
          'family-human', 'public-human', 'human', 'human-1', 'test-device',
          'Test device', 'unknown', 0, 2, NULL
        );
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
          completed_at, result_json, requester_actor_id, tool_name,
          action_category, tool_dispatch_phase, queued_at, updated_at
        ) VALUES ('execution-valid', 'room-1', 'agent-1', 'message-1', 'running',
                  '2026-08-09T01:14:00.000Z', NULL, NULL, 'human-1',
                  'summarize', 'tool_call', 'dispatched',
                  '2026-08-09T01:14:00.000Z', '2026-08-09T01:14:00.000Z');
        INSERT INTO agent_execution_attempts (
          execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
          action_category, started_at, recovery_cursor
        ) VALUES ('execution-valid', 1, 1, 1, 'running', 'tool_call',
                  '2026-08-09T01:14:00.000Z', 0);
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
      database.exec("PRAGMA user_version = 30");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/future schema/i);
      expect(readSchemaVersion(database)).toBe(30);
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
      database.exec("PRAGMA writable_schema = ON");
      database.prepare(
        "UPDATE sqlite_schema SET sql = replace(sql, 'last_error TEXT', 'removed_last_error TEXT') WHERE name = 'outbox_deliveries'",
      ).run();
      database.exec("PRAGMA writable_schema = OFF");

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
}

export function registerDerivedSnapshotSchemaTests(): void {
describe("derived snapshot cache schema", () => {
  it("creates independent v2 WAL/FULL tables without changing authority v16", () => {
    withDatabase((database) => {
      migrateSnapshotCacheDatabase(database);
      expect(SNAPSHOT_CACHE_SCHEMA_VERSION).toBe(2);
      expect(readSchemaVersion(database)).toBe(2);
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
    expect(AUTHORITY_SCHEMA_VERSION).toBe(29);
  });

  it("fails closed on version-two corruption and refuses future versions", () => {
    withDatabase((database) => {
      migrateSnapshotCacheDatabase(database);
      database.exec("ALTER TABLE repair_snapshot_pages DROP COLUMN canonical_bytes");
      expect(() => validateSnapshotCacheSchema(database)).toThrow(/column contract/i);
      expect(() => migrateSnapshotCacheDatabase(database)).toThrow(/column contract/i);
    });
    withDatabase((database) => {
      database.exec("PRAGMA user_version = 3");
      expect(() => migrateSnapshotCacheDatabase(database)).toThrow(/incompatible/i);
      expect(readSchemaVersion(database)).toBe(3);
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
}
