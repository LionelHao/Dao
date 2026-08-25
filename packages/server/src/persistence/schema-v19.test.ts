import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V19_STATEMENT_COUNT_FOR_TEST,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

const NOW = "2026-08-21T12:00:00.000Z";

const V19_TABLE_COLUMNS = {
  agent_execution_context_attempts: [
    "execution_id", "attempt_seq", "snapshot_id", "snapshot_generation",
    "reuse_kind", "bound_at",
  ],
  agent_execution_context_bindings: [
    "execution_id", "snapshot_id", "invocation_intent_id",
    "execution_generation", "bound_at",
  ],
  agent_message_citations: [
    "message_id", "ordinal", "execution_id", "snapshot_id", "receipt_id",
    "manifest_item_ordinal", "citation_label_sha256", "source_kind", "source_id",
    "source_revision", "snapshot_generation", "created_at",
  ],
  context_manifest_items: [
    "manifest_id", "snapshot_id", "ordinal", "section", "disposition",
    "canonical_sort_key", "source_label_sha256", "source_kind", "source_id",
    "source_revision", "content_sha256", "original_bytes", "included_bytes",
    "original_tokens", "included_tokens", "reason_code", "segment_json",
    "availability",
  ],
  context_manifests: [
    "manifest_id", "snapshot_id", "manifest_version", "manifest_sha256",
    "canonical_manifest_json", "item_count", "total_original_bytes",
    "total_included_bytes", "total_original_tokens", "total_included_tokens",
    "accounting_json", "created_at",
  ],
  context_manifest_range_sources: [
    "manifest_id", "snapshot_id", "range_ordinal", "range_label_sha256",
    "corpus_seq", "source_kind", "source_id", "source_revision",
    "source_index_sha256", "created_at",
  ],
  context_snapshot_bodies: [
    "snapshot_id", "envelope_schema_version", "canonical_envelope_json",
    "envelope_sha256", "byte_count", "token_count", "created_at",
  ],
  context_snapshot_lineage: [
    "child_snapshot_id", "parent_snapshot_id", "child_execution_id",
    "parent_execution_id", "relation", "created_at",
  ],
  context_snapshot_sources: [
    "snapshot_id", "room_id", "source_kind", "source_id", "source_revision",
    "source_label_sha256", "currently_required", "authorization_revision",
    "created_at",
  ],
  context_snapshot_transitions: [
    "transition_id", "snapshot_id", "from_state", "to_state",
    "from_generation", "to_generation", "reason_code", "transitioned_at",
  ],
  context_snapshots: [
    "snapshot_id", "room_id", "invocation_intent_id", "agent_id",
    "provider_id", "model_id", "compiler_version", "compiler_config_version",
    "estimator_version", "preparation_sha256", "trigger_message_id",
    "trigger_revision", "trigger_reason", "memory_watermark", "corpus_head",
    "raw_delta_from_exclusive", "raw_delta_to_inclusive",
    "room_lifecycle_generation", "membership_access_revision",
    "tool_capability_revision", "budget_json", "manifest_sha256",
    "envelope_sha256", "state", "snapshot_generation", "created_at",
    "invalidated_at", "invalidation_reason", "superseded_at", "retired_at",
    "retain_until", "payload_retention_state",
  ],
  context_source_read_payloads: [
    "read_id", "canonical_result_json", "result_sha256", "byte_count",
    "token_count", "created_at",
  ],
  context_source_read_grants: [
    "grant_id", "execution_id", "attempt_seq", "snapshot_id",
    "snapshot_generation", "tool_id", "parameter_sha256", "issued_at", "expires_at",
  ],
  context_source_read_dispatches: [
    "dispatch_id", "grant_id", "execution_id", "attempt_seq", "call_id",
    "tool_id", "request_sha256", "dispatched_at",
  ],
  context_source_read_receipts: [
    "receipt_id", "read_id", "snapshot_id", "execution_id", "room_id", "attempt_seq",
    "call_id", "dispatch_id", "source_label_sha256",
    "source_kind", "source_id", "source_revision", "snapshot_generation",
    "citation_label_sha256", "result_sha256", "representation", "range_text",
    "content_sha256", "content_bytes", "authorization_epoch", "issued_at",
  ],
  context_source_reads: [
    "read_id", "snapshot_id", "execution_id", "attempt_seq",
    "snapshot_generation", "call_id", "grant_id", "dispatch_id", "tool_id",
    "request_sha256", "source_label_sha256",
    "mode", "source_kind", "source_id", "source_revision",
    "authorization_epoch", "page_size", "page_offset", "cursor_sha256",
    "artifact_sha256", "artifact_range_start", "artifact_range_end", "status",
    "result_sha256", "result_bytes", "result_tokens", "accounted_bytes", "error_code",
    "created_at", "completed_at",
  ],
} as const;

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v19-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function tableColumns(database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info('${table}')`).all()
    .map((row) => String(row.name));
}

function seedV18Facts(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json)
    VALUES ('v19-human', 'human', 'Human', '[]'),
           ('v19-agent', 'agent', 'Agent', '["room-memory.read"]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'v19-human', 0, 1),
           ('identity', 'v19-agent', 0, 1),
           ('room', 'v19-room', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES ('v19-room', 'Room', 'active', '${NOW}', 'v19-human');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('v19-room', 'v19-human', 'human', 'owner', NULL, '[]', '${NOW}', NULL, 0),
      ('v19-room', 'v19-agent', 'agent', NULL, 'active', '["room-memory.read"]',
       NULL, '${NOW}', 0);
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES ('v19-trigger', 'v19-room', 'v19-human', 'human', 'trigger', '${NOW}');
    INSERT INTO message_revisions (
      message_id, revision, body, revised_at, revised_by_actor_id
    ) VALUES ('v19-trigger', 1, 'trigger', '${NOW}', 'v19-human');
    INSERT INTO message_envelopes (
      message_id, room_id, message_kind, lifecycle, current_revision,
      revision_count, created_at, recalled_at, recalled_by_actor_id
    ) VALUES ('v19-trigger', 'v19-room', 'human', 'active', 1, 1,
      '${NOW}', NULL, NULL);
  `);
}

describe("authority SQLite v19 Context Snapshot Authority", () => {
  it("upgrades fresh and every immutable v1-v18 schema and restarts idempotently", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_SCHEMA_VERSION).toBe(24);
      expect(readSchemaVersion(database)).toBe(24);
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
        .toEqual({ count: 24 });
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
    });
    for (let version = 1; version <= 18; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(24);
      });
    }
  }, 120_000);

  it("adds only the frozen v19 table family and preserves populated v18 facts", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 18);
      seedV18Facts(database);
      const history = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_V19_STATEMENT_COUNT_FOR_TEST).toBe(89);
      for (const [table, columns] of Object.entries(V19_TABLE_COLUMNS)) {
        expect(listAuthorityTables(database)).toContain(table);
        expect(tableColumns(database, table)).toEqual(columns);
      }
      expect(database.prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version <= 18 ORDER BY version",
      ).all()).toEqual(history);
      expect(database.prepare(
        "SELECT name FROM schema_migrations WHERE version = 19",
      ).get()).toEqual({ name: "context-snapshot-authority" });
      expect(database.prepare(
        "SELECT body FROM messages WHERE id = 'v19-trigger'",
      ).get()).toEqual({ body: "trigger" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM context_snapshots").get())
        .toEqual({ count: 0 });
    });
  });

  it("rolls every v19 statement back to an identical populated v18 database", () => {
    expect(AUTHORITY_V19_STATEMENT_COUNT_FOR_TEST).toBe(89);
    for (let statement = 1;
      statement <= AUTHORITY_V19_STATEMENT_COUNT_FOR_TEST;
      statement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, 18);
        seedV18Facts(database);
        const beforeTables = listAuthorityTables(database);
        const beforeHistory = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        expect(() => migrateAuthorityDatabase(database, { failAfterStatement: statement }))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(18);
        expect(listAuthorityTables(database)).toEqual(beforeTables);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(beforeHistory);
        expect(database.prepare(
          "SELECT id, body FROM messages WHERE id = 'v19-trigger'",
        ).get()).toEqual({ id: "v19-trigger", body: "trigger" });
        expect(database.prepare(
          "SELECT room_id AS roomId, memory_watermark AS watermark FROM room_memory_stewards WHERE room_id = 'v19-room'",
        ).get()).toEqual({ roomId: "v19-room", watermark: 0 });
      });
    }
  }, 180_000);

  it("refuses future, history, and physical v19 tamper", () => {
    withDatabase((database) => {
      database.exec("PRAGMA user_version = 25");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/future schema/i);
    });
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.prepare(
        "UPDATE schema_migrations SET checksum = ? WHERE version = 19",
      ).run("a".repeat(64));
      expect(() => migrateAuthorityDatabase(database)).toThrow(/migration|checksum/i);
    });
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec("DROP TRIGGER context_snapshots_v19_validate_update");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/physical contract/i);
    });
  });
});
