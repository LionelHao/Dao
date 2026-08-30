import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V16_STATEMENT_COUNT_FOR_TEST,
  listAuthorityTables,
  migrateAuthorityDatabaseToVersion16ForTest,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  migrateAuthorityDatabaseToVersion15ForTest,
  readSchemaVersion,
} from "./schema.js";

const V15_CHECKSUM =
  "41740e7d34f6807248bf7879f34f9026844802dfe5a43f0ee18bf498a24dc0c9";

const V16_TABLE_COLUMNS = {
  agent_execution_intent_links: [
    "intent_id", "execution_id", "execution_ordinal", "retry_of_execution_id",
    "source_revision", "linked_at",
  ],
  agent_invocation_intents: [
    "id", "room_id", "source_message_id", "target_agent_id",
    "requester_actor_id", "intent_kind", "execution_id", "created_at",
    "message_transaction_id", "target_id", "source_revision", "lineage_id",
    "turn_id", "origin_kind", "status", "claimed_at", "cancelled_at",
    "cancellation_reason", "supersedes_intent_id",
  ],
  agent_message_corrections: [
    "correction_message_id", "corrects_message_id", "room_id",
    "agent_actor_id", "created_at",
  ],
  agent_message_sources: [
    "message_id", "room_id", "invocation_intent_id", "execution_id",
    "attempt_seq", "execution_generation", "source_message_id",
    "source_revision", "committed_at",
  ],
  human_request_intents: [
    "id", "room_id", "source_message_id", "target_id", "source_revision",
    "requester_human_actor_id", "target_human_actor_id", "status",
    "created_at", "claimed_at", "cancelled_at", "cancellation_reason",
  ],
  message_attachment_links: [
    "message_id", "room_id", "attachment_id", "operational_state",
  ],
  message_envelopes: [
    "message_id", "room_id", "message_kind", "lifecycle", "current_revision",
    "revision_count", "created_at", "recalled_at", "recalled_by_actor_id",
  ],
  message_mentions: [
    "message_id", "room_id", "target_id", "target_kind", "target_actor_id",
    "range_start_utf16", "range_end_utf16", "target_order",
  ],
  message_recall_fences: [
    "fence_id", "room_id", "source_message_id", "source_revision",
    "scope_kind", "invocation_intent_id", "execution_id", "reason", "created_at",
  ],
  message_reply_links: ["message_id", "room_id", "reply_to_message_id"],
  message_revisions: [
    "message_id", "revision", "body", "revised_at", "revised_by_actor_id",
  ],
  message_target_outcomes: [
    "message_id", "room_id", "target_id", "target_actor_id", "target_kind",
    "status", "request_intent_id", "invocation_intent_id", "rejection_code",
    "created_at",
  ],
} as const;

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v16-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function tableColumns(database: DatabaseSync, tableName: string): readonly string[] {
  return database.prepare(`PRAGMA table_info('${tableName}')`).all()
    .map((row) => String(row.name));
}

function seedRoomAndLegacyMessages(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO actors (id, kind, display_name) VALUES
      ('v16-human', 'human', 'Same Name'),
      ('v16-agent', 'agent', 'Same Name'),
      ('v16-human-2', 'human', 'Same Name'),
      ('v16-agent-2', 'agent', 'Other Agent');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
      ('identity', 'v16-human', 0, 1),
      ('identity', 'v16-agent', 0, 1),
      ('identity', 'v16-human-2', 0, 1),
      ('identity', 'v16-agent-2', 0, 1),
      ('room', 'v16-room', 0, 1),
      ('room', 'v16-room-2', 0, 1);
    INSERT INTO rooms (id, name, status, created_at) VALUES
      ('v16-room', 'Room', 'active', '2026-08-19T00:00:00.000Z'),
      ('v16-room-2', 'Other', 'active', '2026-08-19T00:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('v16-room', 'v16-human', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('v16-room', 'v16-human-2', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('v16-room', 'v16-agent', 'agent', NULL, 'active', '[]',
       NULL, '2026-08-19T00:00:00.000Z', 0),
      ('v16-room', 'v16-agent-2', 'agent', NULL, 'active', '[]',
       NULL, '2026-08-19T00:00:00.000Z', 0),
      ('v16-room-2', 'v16-human', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0);
    UPDATE rooms SET owner_actor_id = 'v16-human';
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at) VALUES
      ('legacy-human', 'v16-room', 'v16-human', 'human',
       'mail a@b.test and code @agent-id stay plain', '2026-08-19T00:01:00.000Z'),
      ('legacy-agent', 'v16-room', 'v16-agent', 'agent',
       'legacy final', '2026-08-19T00:02:00.000Z'),
      ('other-room-message', 'v16-room-2', 'v16-human', 'human',
       'other room', '2026-08-19T00:03:00.000Z');
  `);
}

function begin(database: DatabaseSync, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seedClaimedAgentExecution(database: DatabaseSync): void {
  begin(database, () => {
    database.prepare(
      `INSERT INTO message_mentions (
         message_id, room_id, target_id, target_kind, target_actor_id,
         range_start_utf16, range_end_utf16, target_order
       ) VALUES ('legacy-human', 'v16-room', 'final-target', 'agent-invocation',
                 'v16-agent', 5, 10, 0)`,
    ).run();
    database.prepare(
      `INSERT INTO agent_invocation_intents (
         id, room_id, source_message_id, target_agent_id, requester_actor_id,
         intent_kind, execution_id, created_at, message_transaction_id,
         target_id, source_revision, lineage_id, turn_id, origin_kind, status
       ) VALUES ('final-intent', 'v16-room', 'legacy-human', 'v16-agent',
                 'v16-human', 'direct_mention', NULL,
                 '2026-08-19T00:10:00.000Z', 'legacy-human', 'final-target', 1,
                 'final-lineage', 'final-turn', 'message_target', 'pending')`,
    ).run();
    database.prepare(
      `INSERT INTO message_target_outcomes (
         message_id, room_id, target_id, target_actor_id, target_kind, status,
         request_intent_id, invocation_intent_id, rejection_code, created_at
       ) VALUES ('legacy-human', 'v16-room', 'final-target', 'v16-agent',
                 'agent-invocation', 'invocation-intent-created', NULL,
                 'final-intent', NULL, '2026-08-19T00:10:00.000Z')`,
    ).run();
  });
  database.prepare(
    `UPDATE agent_invocation_intents
     SET status = 'claimed', claimed_at = '2026-08-19T00:11:00.000Z'
     WHERE id = 'final-intent'`,
  ).run();
  database.exec(`
    INSERT INTO agent_executions (
      id, room_id, room_archive_generation, agent_id, trigger_message_id,
      status, started_at, completed_at, result_json, requester_actor_id,
      tool_name, action_category, tool_dispatch_phase, current_attempt_seq,
      retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
      queued_at, updated_at
    ) VALUES (
      'final-execution', 'v16-room', 0, 'v16-agent', 'legacy-human',
      'running', '2026-08-19T00:11:00.000Z', NULL, NULL, 'v16-human',
      'model.generate', 'model_generation', NULL, 1, 1, 1, NULL, NULL, 0,
      '2026-08-19T00:11:00.000Z', '2026-08-19T00:11:00.000Z'
    );
    INSERT INTO agent_execution_attempts (
      execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
      action_category, started_at, recovery_cursor
    ) VALUES (
      'final-execution', 1, 1, 1, 'running', 'model_generation',
      '2026-08-19T00:11:00.000Z', 0
    );
    INSERT INTO agent_execution_intent_links (
      intent_id, execution_id, execution_ordinal, retry_of_execution_id,
      source_revision, linked_at
    ) VALUES (
      'final-intent', 'final-execution', 1, NULL, 1,
      '2026-08-19T00:11:00.000Z'
    );
  `);
}

function insertAgentMessageSource(
  database: DatabaseSync,
  messageId: string,
  executionGeneration: number,
): void {
  database.prepare(
    `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
     VALUES (?, 'v16-room', 'v16-agent', 'agent', 'durable final',
             '2026-08-19T00:12:00.000Z')`,
  ).run(messageId);
  database.prepare(
    `INSERT INTO message_revisions (
       message_id, revision, body, revised_at, revised_by_actor_id
     ) VALUES (?, 1, 'durable final', '2026-08-19T00:12:00.000Z', 'v16-agent')`,
  ).run(messageId);
  database.prepare(
    `INSERT INTO message_envelopes (
       message_id, room_id, message_kind, lifecycle, current_revision,
       revision_count, created_at, recalled_at, recalled_by_actor_id
     ) VALUES (?, 'v16-room', 'agent-final', 'active', 1, 1,
               '2026-08-19T00:12:00.000Z', NULL, NULL)`,
  ).run(messageId);
  database.prepare(
    `INSERT INTO agent_message_sources (
       message_id, room_id, invocation_intent_id, execution_id, attempt_seq,
       execution_generation, source_message_id, source_revision, committed_at
     ) VALUES (?, 'v16-room', 'final-intent', 'final-execution', 1, ?,
               'legacy-human', 1, '2026-08-19T00:12:00.000Z')`,
  ).run(messageId, executionGeneration);
}

describe("authority SQLite v16 Message Authority", () => {
  it("upgrades every immutable historical schema through the actual v16 contract", () => {
    for (let version = 1; version < 16; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        expect(readSchemaVersion(database)).toBe(version);
        migrateAuthorityDatabaseToVersion16ForTest(database);
        expect(readSchemaVersion(database)).toBe(16);
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations",
        ).get()).toEqual({ count: 16 });
      });
    }
  }, 40_000);

  it("creates the closed v16 tables and indexes without changing the v15 checksum", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion16ForTest(database);

      expect(AUTHORITY_SCHEMA_VERSION).toBe(26);
      expect(AUTHORITY_V16_STATEMENT_COUNT_FOR_TEST).toBe(82);
      expect(readSchemaVersion(database)).toBe(16);
      for (const [table, columns] of Object.entries(V16_TABLE_COLUMNS)) {
        expect(listAuthorityTables(database)).toContain(table);
        expect(tableColumns(database, table)).toEqual(columns);
      }
      expect(tableColumns(database, "agent_executions").at(-1))
        .toBe("execution_generation");
      expect(database.prepare(
        "SELECT name, checksum FROM schema_migrations WHERE version = 15",
      ).get()).toEqual({
        name: "truthful-room-lifecycle-audit-vocabulary",
        checksum: V15_CHECKSUM,
      });
      expect(database.prepare(
        "SELECT name, checksum FROM schema_migrations WHERE version = 16",
      ).get()).toEqual({
        name: "message-authority-vnext",
        checksum: "51e5b5114b90bc8407d7eec86a559da0170cec1ec0bfc1c5587d828a5765f1a7",
      });
      const indexes = database.prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'index' AND name LIKE '%_v16' ORDER BY name`,
      ).all().map((row) => String(row.name));
      expect(indexes).toEqual(expect.arrayContaining([
        "agent_execution_intent_links_intent_ordinal_v16",
        "agent_executions_result_message_binding_v16",
        "agent_invocation_intents_lineage_turn_v16",
        "agent_invocation_intents_message_target_v16",
        "message_envelopes_room_created_v16",
        "message_mentions_semantic_target_v16",
        "message_recall_fences_execution_scope_v16",
        "message_revisions_revised_at_v16",
        "message_target_outcomes_invocation_binding_v16",
        "message_target_outcomes_request_binding_v16",
        "message_target_outcomes_room_message_v16",
      ]));
    });
  });

  it("backfills legacy Human and Agent messages as revision one without semantic side effects", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      const beforeEvents = database.prepare("SELECT COUNT(*) AS count FROM events").get();
      const beforeOutbox = database.prepare(
        "SELECT COUNT(*) AS count FROM outbox_deliveries",
      ).get();

      migrateAuthorityDatabaseToVersion16ForTest(database);

      expect(database.prepare(
        `SELECT message_id AS messageId, room_id AS roomId, message_kind AS messageKind,
                lifecycle, current_revision AS currentRevision,
                revision_count AS revisionCount, created_at AS createdAt
         FROM message_envelopes ORDER BY created_at, message_id`,
      ).all()).toEqual([
        {
          messageId: "legacy-human", roomId: "v16-room", messageKind: "human",
          lifecycle: "active", currentRevision: 1, revisionCount: 1,
          createdAt: "2026-08-19T00:01:00.000Z",
        },
        {
          messageId: "legacy-agent", roomId: "v16-room", messageKind: "agent-final",
          lifecycle: "active", currentRevision: 1, revisionCount: 1,
          createdAt: "2026-08-19T00:02:00.000Z",
        },
        {
          messageId: "other-room-message", roomId: "v16-room-2", messageKind: "human",
          lifecycle: "active", currentRevision: 1, revisionCount: 1,
          createdAt: "2026-08-19T00:03:00.000Z",
        },
      ]);
      expect(database.prepare(
        `SELECT message_id AS messageId, revision, body,
                revised_by_actor_id AS revisedBy
         FROM message_revisions ORDER BY revised_at, message_id`,
      ).all()).toEqual([
        {
          messageId: "legacy-human", revision: 1,
          body: "mail a@b.test and code @agent-id stay plain", revisedBy: "v16-human",
        },
        {
          messageId: "legacy-agent", revision: 1,
          body: "legacy final", revisedBy: "v16-agent",
        },
        {
          messageId: "other-room-message", revision: 1,
          body: "other room", revisedBy: "v16-human",
        },
      ]);
      for (const table of [
        "message_mentions", "message_target_outcomes", "human_request_intents",
      ]) {
        expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
          .toEqual({ count: 0 });
      }
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_invocation_intents").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(beforeEvents);
      expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get())
        .toEqual(beforeOutbox);

      migrateAuthorityDatabaseToVersion16ForTest(database);
      expect(database.prepare("SELECT COUNT(*) AS count FROM message_envelopes").get())
        .toEqual({ count: 3 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM message_revisions").get())
        .toEqual({ count: 3 });
    });
  });

  it("backfills coupled legacy invocation rows into explicit legacy lineage without replaying work", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      database.exec(`
        INSERT INTO agent_executions (
          id, room_id, room_archive_generation, agent_id, trigger_message_id,
          status, started_at, completed_at, result_json, requester_actor_id,
          tool_name, action_category, tool_dispatch_phase, current_attempt_seq,
          retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
          queued_at, updated_at
        ) VALUES (
          'legacy-execution', 'v16-room', 0, 'v16-agent', 'legacy-human',
          'queued', '2026-08-19T00:04:00.000Z', NULL, NULL, 'v16-human',
          'model.generate', 'model_generation', NULL, 1, 1, 1, NULL, NULL, 0,
          '2026-08-19T00:04:00.000Z', '2026-08-19T00:04:00.000Z'
        );
        INSERT INTO agent_execution_attempts (
          execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
          action_category, recovery_cursor
        ) VALUES (
          'legacy-execution', 1, 1, 1, 'queued', 'model_generation', 0
        );
        INSERT INTO agent_invocation_intents (
          id, room_id, source_message_id, target_agent_id, requester_actor_id,
          intent_kind, execution_id, created_at
        ) VALUES (
          'legacy-intent', 'v16-room', 'legacy-human', 'v16-agent', 'v16-human',
          'direct_mention', 'legacy-execution', '2026-08-19T00:04:00.000Z'
        );
      `);
      const beforeEvents = database.prepare("SELECT COUNT(*) AS count FROM events").get();
      const beforeOutbox = database.prepare(
        "SELECT COUNT(*) AS count FROM outbox_deliveries",
      ).get();

      migrateAuthorityDatabaseToVersion16ForTest(database);

      expect(database.prepare(
        `SELECT id, execution_id AS executionId, source_revision AS sourceRevision,
                lineage_id AS lineageId, turn_id AS turnId, origin_kind AS originKind,
                status, claimed_at AS claimedAt, target_id AS targetId
         FROM agent_invocation_intents WHERE id = 'legacy-intent'`,
      ).get()).toEqual({
        id: "legacy-intent", executionId: "legacy-execution", sourceRevision: 1,
        lineageId: "legacy-intent", turnId: "legacy", originKind: "legacy_runtime",
        status: "claimed", claimedAt: "2026-08-19T00:04:00.000Z", targetId: null,
      });
      expect(database.prepare(
        `SELECT intent_id AS intentId, execution_id AS executionId,
                execution_ordinal AS executionOrdinal, source_revision AS sourceRevision
         FROM agent_execution_intent_links`,
      ).all()).toEqual([{
        intentId: "legacy-intent", executionId: "legacy-execution",
        executionOrdinal: 1, sourceRevision: 1,
      }]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM message_target_outcomes").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(beforeEvents);
      expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get())
        .toEqual(beforeOutbox);
    });
  });

  it("accepts legacy runtime intent from its exact Agent source without weakening message targets", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      database.exec(`
        INSERT INTO agent_executions (
          id, room_id, room_archive_generation, agent_id, trigger_message_id,
          status, started_at, completed_at, result_json, requester_actor_id,
          tool_name, action_category, tool_dispatch_phase, current_attempt_seq,
          retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
          queued_at, updated_at
        ) VALUES (
          'backfilled-agent-execution', 'v16-room', 0, 'v16-agent-2', 'legacy-agent',
          'queued', '2026-08-19T00:03:00.000Z', NULL, NULL, 'v16-agent',
          'model.generate', 'model_generation', NULL, 1, 1, 1, NULL, NULL, 0,
          '2026-08-19T00:03:00.000Z', '2026-08-19T00:03:00.000Z'
        );
        INSERT INTO agent_execution_attempts (
          execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
          action_category, recovery_cursor
        ) VALUES (
          'backfilled-agent-execution', 1, 1, 1, 'queued', 'model_generation', 0
        );
        INSERT INTO agent_invocation_intents (
          id, room_id, source_message_id, target_agent_id, requester_actor_id,
          intent_kind, execution_id, created_at
        ) VALUES (
          'backfilled-agent-intent', 'v16-room', 'legacy-agent', 'v16-agent-2',
          'v16-agent', 'direct_mention', 'backfilled-agent-execution',
          '2026-08-19T00:03:00.000Z'
        );
      `);
      migrateAuthorityDatabaseToVersion16ForTest(database);
      expect(database.prepare(
        `SELECT requester_actor_id AS requesterActorId, origin_kind AS originKind
         FROM agent_invocation_intents WHERE id = 'backfilled-agent-intent'`,
      ).get()).toEqual({ requesterActorId: "v16-agent", originKind: "legacy_runtime" });
      database.exec(`
        INSERT INTO agent_executions (
          id, room_id, room_archive_generation, agent_id, trigger_message_id,
          status, started_at, completed_at, result_json, requester_actor_id,
          tool_name, action_category, tool_dispatch_phase, current_attempt_seq,
          retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
          queued_at, updated_at
        ) VALUES (
          'agent-source-execution', 'v16-room', 0, 'v16-agent-2', 'legacy-agent',
          'queued', '2026-08-19T00:04:00.000Z', NULL, NULL, 'v16-agent',
          'model.generate', 'model_generation', NULL, 1, 1, 1, NULL, NULL, 0,
          '2026-08-19T00:04:00.000Z', '2026-08-19T00:04:00.000Z'
        );
        INSERT INTO agent_execution_attempts (
          execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
          action_category, recovery_cursor
        ) VALUES (
          'agent-source-execution', 1, 1, 1, 'queued', 'model_generation', 0
        );
      `);

      expect(() => database.prepare(
        `INSERT INTO agent_invocation_intents (
           id, room_id, source_message_id, target_agent_id, requester_actor_id,
           intent_kind, execution_id, created_at
         ) VALUES (
           'agent-source-intent', 'v16-room', 'legacy-agent', 'v16-agent-2',
           'v16-agent', 'direct_mention', 'agent-source-execution',
           '2026-08-19T00:04:00.000Z'
         )`,
      ).run()).not.toThrow();
      expect(() => database.prepare(
        `INSERT INTO agent_invocation_intents (
           id, room_id, source_message_id, target_agent_id, requester_actor_id,
           intent_kind, execution_id, created_at
         ) VALUES (
           'mismatched-requester', 'v16-room', 'legacy-agent', 'v16-agent-2',
           'v16-human', 'direct_mention', NULL, '2026-08-19T00:05:00.000Z'
         )`,
      ).run()).toThrow(/binding/i);
      expect(() => database.prepare(
        `INSERT INTO agent_invocation_intents (
           id, room_id, source_message_id, target_agent_id, requester_actor_id,
           intent_kind, execution_id, created_at, message_transaction_id,
           target_id, source_revision, lineage_id, turn_id, origin_kind, status
         ) VALUES (
           'agent-message-target', 'v16-room', 'legacy-agent', 'v16-agent-2',
           'v16-agent', 'direct_mention', NULL, '2026-08-19T00:05:00.000Z',
           'legacy-agent', 'target-agent', 1, 'agent-lineage', 'agent-turn',
           'message_target', 'pending'
         )`,
      ).run()).toThrow(/binding/i);
      expect(() => migrateAuthorityDatabaseToVersion16ForTest(database)).not.toThrow();
    });
  });

  it("preserves v15 governance, Provider assignment, cache, lease, and receipt facts", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      database.exec(`
        INSERT INTO agent_profiles (
          id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json
        ) VALUES ('v16-profile', 'v16-agent', 3, 'enabled', '[]', '[]');
        INSERT INTO room_agent_assignments (
          id, room_id, profile_id, agent_actor_id, revision, status,
          participation, paused, capability_subset_json, tool_subset_json
        ) VALUES (
          'v16-assignment', 'v16-room', 'v16-profile', 'v16-agent', 4,
          'current', 'on-mention', 0, '[]', '[]'
        );
        INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
        VALUES ('v16-room', 0, 2);
        INSERT INTO room_cache_invalidation_intents (
          id, room_id, lifecycle_generation, access_revision, reason, target_actor_id
        ) VALUES (
          'v16-cache-fact', 'v16-room', 0, 0, 'access_revoked', 'v16-human-2'
        );
        INSERT INTO offline_read_lease_invalidations (
          id, room_id, lifecycle_generation, access_revision, lease_generation,
          revoked_lease_count, reason, target_actor_id
        ) VALUES (
          'v16-lease-fact', 'v16-room', 0, 0, 2, 1,
          'access_revoked', 'v16-human-2'
        );
        INSERT INTO idempotency_records (
          scope, key, request_hash, response_json, status_code, created_at, expires_at
        ) VALUES (
          'v16-scope', 'v16-key', 'v16-hash', '{"closed":"receipt"}', 200,
          '2026-08-19T00:00:00.000Z', '2026-09-18T00:00:00.000Z'
        );
      `);
      const before = {
        profile: database.prepare("SELECT * FROM agent_profiles").get(),
        assignment: database.prepare("SELECT * FROM room_agent_assignments").get(),
        access: database.prepare("SELECT * FROM room_access_authority").get(),
        cache: database.prepare("SELECT * FROM room_cache_invalidation_intents").get(),
        lease: database.prepare("SELECT * FROM offline_read_lease_invalidations").get(),
        receipt: database.prepare("SELECT * FROM idempotency_records").get(),
      };

      migrateAuthorityDatabaseToVersion16ForTest(database);

      expect({
        profile: database.prepare("SELECT * FROM agent_profiles").get(),
        assignment: database.prepare("SELECT * FROM room_agent_assignments").get(),
        access: database.prepare("SELECT * FROM room_access_authority").get(),
        cache: database.prepare("SELECT * FROM room_cache_invalidation_intents").get(),
        lease: database.prepare("SELECT * FROM offline_read_lease_invalidations").get(),
        receipt: database.prepare("SELECT * FROM idempotency_records").get(),
      }).toEqual(before);
    });
  });

  it("enforces same-Room replies, append-only revisions, and recall lifecycle shape", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      migrateAuthorityDatabaseToVersion16ForTest(database);

      expect(() => database.prepare(
        `INSERT INTO message_reply_links (message_id, room_id, reply_to_message_id)
         VALUES ('legacy-human', 'v16-room', 'other-room-message')`,
      ).run()).toThrow();
      expect(() => database.prepare(
        `UPDATE message_revisions SET body = 'rewritten'
         WHERE message_id = 'legacy-human' AND revision = 1`,
      ).run()).toThrow(/immutable/i);
      expect(() => database.prepare(
        `DELETE FROM message_revisions
         WHERE message_id = 'legacy-human' AND revision = 1`,
      ).run()).toThrow(/immutable/i);
      expect(() => database.prepare(
        `INSERT INTO message_revisions (
           message_id, revision, body, revised_at, revised_by_actor_id
         ) VALUES ('legacy-human', 3, 'skip', '2026-08-19T00:04:00.000Z', 'v16-human')`,
      ).run()).toThrow(/revision sequence/i);

      database.prepare(
        `INSERT INTO message_revisions (
           message_id, revision, body, revised_at, revised_by_actor_id
         ) VALUES ('legacy-human', 2, 'edited', '2026-08-19T00:04:00.000Z', 'v16-human')`,
      ).run();
      database.prepare(
        `UPDATE message_envelopes
         SET current_revision = 2, revision_count = 2
         WHERE message_id = 'legacy-human'`,
      ).run();
      expect(() => database.prepare(
        `UPDATE message_envelopes
         SET lifecycle = 'recalled', recalled_at = NULL,
             recalled_by_actor_id = 'v16-human'
         WHERE message_id = 'legacy-human'`,
      ).run()).toThrow(/recall/i);
    });
  });

  it("keeps the legacy message identity immutable beside its append-only body", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      migrateAuthorityDatabaseToVersion16ForTest(database);

      for (const mutation of [
        "UPDATE messages SET room_id = 'v16-room-2' WHERE id = 'legacy-human'",
        "UPDATE messages SET author_id = 'v16-human-2' WHERE id = 'legacy-human'",
        "UPDATE messages SET author_kind = 'agent' WHERE id = 'legacy-human'",
      ]) {
        expect(() => database.prepare(mutation).run()).toThrow(/immutable/i);
      }
    });
  });

  it("requires every structured target to commit with exactly one closed outcome", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      migrateAuthorityDatabaseToVersion16ForTest(database);

      expect(() => database.prepare(
        `INSERT INTO message_mentions (
           message_id, room_id, target_id, target_kind, target_actor_id,
           range_start_utf16, range_end_utf16, target_order
         ) VALUES ('legacy-human', 'v16-room', 'orphan', 'human-request',
                   'v16-human-2', 0, 4, 0)`,
      ).run()).toThrow();

      begin(database, () => {
        database.prepare(
          `INSERT INTO message_mentions (
             message_id, room_id, target_id, target_kind, target_actor_id,
             range_start_utf16, range_end_utf16, target_order
           ) VALUES ('legacy-human', 'v16-room', 'human-target', 'human-request',
                     'v16-human-2', 0, 4, 0)`,
        ).run();
        database.prepare(
          `INSERT INTO human_request_intents (
             id, room_id, source_message_id, target_id, source_revision,
             requester_human_actor_id, target_human_actor_id, status, created_at
           ) VALUES ('request-intent', 'v16-room', 'legacy-human', 'human-target', 1,
                     'v16-human', 'v16-human-2', 'pending',
                     '2026-08-19T00:05:00.000Z')`,
        ).run();
        database.prepare(
          `INSERT INTO message_target_outcomes (
             message_id, room_id, target_id, target_actor_id, target_kind, status,
             request_intent_id, invocation_intent_id, rejection_code, created_at
           ) VALUES ('legacy-human', 'v16-room', 'human-target', 'v16-human-2',
                     'human-request', 'request-created', 'request-intent', NULL, NULL,
                     '2026-08-19T00:05:00.000Z')`,
        ).run();
      });

      expect(() => begin(database, () => {
        database.prepare(
          `INSERT INTO message_mentions (
             message_id, room_id, target_id, target_kind, target_actor_id,
             range_start_utf16, range_end_utf16, target_order
           ) VALUES ('legacy-human', 'v16-room', 'duplicate-human', 'human-request',
                     'v16-human-2', 5, 9, 1)`,
        ).run();
        database.prepare(
          `INSERT INTO message_target_outcomes (
             message_id, room_id, target_id, target_actor_id, target_kind, status,
             request_intent_id, invocation_intent_id, rejection_code, created_at
           ) VALUES ('legacy-human', 'v16-room', 'duplicate-human', 'v16-human-2',
                     'human-request', 'rejected', NULL, NULL, 'target_not_member',
                     '2026-08-19T00:06:00.000Z')`,
        ).run();
      })).toThrow();
      expect(() => begin(database, () => {
        database.prepare(
          `INSERT INTO message_mentions (
             message_id, room_id, target_id, target_kind, target_actor_id,
             range_start_utf16, range_end_utf16, target_order
           ) VALUES ('legacy-human', 'v16-room', 'overlap', 'agent-invocation',
                     'v16-agent', 3, 8, 1)`,
        ).run();
        database.prepare(
          `INSERT INTO message_target_outcomes (
             message_id, room_id, target_id, target_actor_id, target_kind, status,
             request_intent_id, invocation_intent_id, rejection_code, created_at
           ) VALUES ('legacy-human', 'v16-room', 'overlap', 'v16-agent',
                     'agent-invocation', 'rejected', NULL, NULL,
                     'target_assignment_inactive', '2026-08-19T00:06:00.000Z')`,
        ).run();
      })).toThrow(/overlap/i);
      expect(database.prepare(
        "SELECT status, request_intent_id AS intentId FROM message_target_outcomes",
      ).all()).toEqual([{ status: "request-created", intentId: "request-intent" }]);
    });
  });

  it("rejects cross-Room outcomes and intents without their matching created outcome", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      migrateAuthorityDatabaseToVersion16ForTest(database);

      expect(() => begin(database, () => {
        database.prepare(
          `INSERT INTO message_mentions (
             message_id, room_id, target_id, target_kind, target_actor_id,
             range_start_utf16, range_end_utf16, target_order
           ) VALUES ('legacy-human', 'v16-room', 'cross-room', 'human-request',
                     'v16-human-2', 0, 4, 0)`,
        ).run();
        database.prepare(
          `INSERT INTO message_target_outcomes (
             message_id, room_id, target_id, target_actor_id, target_kind, status,
             request_intent_id, invocation_intent_id, rejection_code, created_at
           ) VALUES ('legacy-human', 'v16-room-2', 'cross-room', 'v16-human-2',
                     'human-request', 'rejected', NULL, NULL, 'target_not_member',
                     '2026-08-19T00:06:00.000Z')`,
        ).run();
      })).toThrow();

      expect(() => begin(database, () => {
        database.prepare(
          `INSERT INTO message_mentions (
             message_id, room_id, target_id, target_kind, target_actor_id,
             range_start_utf16, range_end_utf16, target_order
           ) VALUES ('legacy-human', 'v16-room', 'orphan-intent', 'human-request',
                     'v16-human-2', 0, 4, 0)`,
        ).run();
        database.prepare(
          `INSERT INTO human_request_intents (
             id, room_id, source_message_id, target_id, source_revision,
             requester_human_actor_id, target_human_actor_id, status, created_at
           ) VALUES ('orphan-request', 'v16-room', 'legacy-human', 'orphan-intent', 1,
                     'v16-human', 'v16-human-2', 'pending',
                     '2026-08-19T00:06:00.000Z')`,
        ).run();
        database.prepare(
          `INSERT INTO message_target_outcomes (
             message_id, room_id, target_id, target_actor_id, target_kind, status,
             request_intent_id, invocation_intent_id, rejection_code, created_at
           ) VALUES ('legacy-human', 'v16-room', 'orphan-intent', 'v16-human-2',
                     'human-request', 'rejected', NULL, NULL, 'target_not_member',
                     '2026-08-19T00:06:00.000Z')`,
        ).run();
      })).toThrow();

      begin(database, () => {
        database.prepare(
          `INSERT INTO message_mentions (
             message_id, room_id, target_id, target_kind, target_actor_id,
             range_start_utf16, range_end_utf16, target_order
           ) VALUES ('legacy-human', 'v16-room', 'closed-agent', 'agent-invocation',
                     'v16-agent', 0, 4, 0)`,
        ).run();
        database.prepare(
          `INSERT INTO message_target_outcomes (
             message_id, room_id, target_id, target_actor_id, target_kind, status,
             request_intent_id, invocation_intent_id, rejection_code, created_at
           ) VALUES ('legacy-human', 'v16-room', 'closed-agent', 'v16-agent',
                     'agent-invocation', 'rejected', NULL, NULL,
                     'target_assignment_inactive', '2026-08-19T00:06:00.000Z')`,
        ).run();
      });
      expect(() => database.prepare(
        `INSERT INTO agent_invocation_intents (
           id, room_id, source_message_id, target_agent_id, requester_actor_id,
           intent_kind, execution_id, created_at, message_transaction_id,
           target_id, source_revision, lineage_id, turn_id, origin_kind, status
         ) VALUES ('late-agent-intent', 'v16-room', 'legacy-human', 'v16-agent',
                   'v16-human', 'direct_mention', NULL,
                   '2026-08-19T00:07:00.000Z', 'legacy-human', 'closed-agent', 1,
                   'closed-lineage', 'closed-turn', 'message_target', 'pending')`,
      ).run()).toThrow(/outcome|closed/i);
    });
  });

  it("stores execution-independent invocation intents and source-scoped recall fences", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      migrateAuthorityDatabaseToVersion16ForTest(database);

      begin(database, () => {
        database.prepare(
          `INSERT INTO message_mentions (
             message_id, room_id, target_id, target_kind, target_actor_id,
             range_start_utf16, range_end_utf16, target_order
           ) VALUES ('legacy-human', 'v16-room', 'agent-target', 'agent-invocation',
                     'v16-agent', 5, 10, 0)`,
        ).run();
        database.prepare(
          `INSERT INTO agent_invocation_intents (
             id, room_id, source_message_id, target_agent_id, requester_actor_id,
             intent_kind, execution_id, created_at, message_transaction_id,
             target_id, source_revision, lineage_id, turn_id, origin_kind, status
           ) VALUES ('agent-intent', 'v16-room', 'legacy-human', 'v16-agent',
                     'v16-human', 'direct_mention', NULL,
                     '2026-08-19T00:07:00.000Z', 'legacy-human', 'agent-target', 1,
                     'lineage-1', 'turn-1', 'message_target', 'pending')`,
        ).run();
        database.prepare(
          `INSERT INTO message_target_outcomes (
             message_id, room_id, target_id, target_actor_id, target_kind, status,
             request_intent_id, invocation_intent_id, rejection_code, created_at
           ) VALUES ('legacy-human', 'v16-room', 'agent-target', 'v16-agent',
                     'agent-invocation', 'invocation-intent-created', NULL,
                     'agent-intent', NULL, '2026-08-19T00:07:00.000Z')`,
        ).run();
      });
      expect(database.prepare(
        `SELECT status, execution_id AS executionId FROM agent_invocation_intents
         WHERE id = 'agent-intent'`,
      ).get()).toEqual({ status: "pending", executionId: null });

      database.prepare(
        `INSERT INTO message_recall_fences (
           fence_id, room_id, source_message_id, source_revision, scope_kind,
           invocation_intent_id, execution_id, reason, created_at
         ) VALUES ('message-fence', 'v16-room', 'legacy-human', 1, 'message',
                   NULL, NULL, 'message_recalled', '2026-08-19T00:08:00.000Z')`,
      ).run();
      expect(() => database.prepare(
        `INSERT INTO message_recall_fences (
           fence_id, room_id, source_message_id, source_revision, scope_kind,
           invocation_intent_id, execution_id, reason, created_at
         ) VALUES ('message-fence-2', 'v16-room', 'legacy-human', 1, 'message',
                   NULL, NULL, 'message_recalled', '2026-08-19T00:09:00.000Z')`,
      ).run()).toThrow();
      expect(() => database.prepare(
        "DELETE FROM message_recall_fences WHERE fence_id = 'message-fence'",
      ).run()).toThrow(/immutable/i);
    });
  });

  it("binds a recall fence to the current source revision", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      migrateAuthorityDatabaseToVersion16ForTest(database);

      database.prepare(
        `INSERT INTO message_revisions (
           message_id, revision, body, revised_at, revised_by_actor_id
         ) VALUES ('legacy-human', 2, 'edited', '2026-08-19T00:04:00.000Z', 'v16-human')`,
      ).run();
      database.prepare(
        `UPDATE message_envelopes SET current_revision = 2, revision_count = 2
         WHERE message_id = 'legacy-human'`,
      ).run();

      expect(() => database.prepare(
        `INSERT INTO message_recall_fences (
           fence_id, room_id, source_message_id, source_revision, scope_kind,
           invocation_intent_id, execution_id, reason, created_at
         ) VALUES ('stale-fence', 'v16-room', 'legacy-human', 1, 'message',
                   NULL, NULL, 'message_recalled', '2026-08-19T00:08:00.000Z')`,
      ).run()).toThrow(/fence|revision/i);

      database.prepare(
        `INSERT INTO message_recall_fences (
           fence_id, room_id, source_message_id, source_revision, scope_kind,
           invocation_intent_id, execution_id, reason, created_at
         ) VALUES ('current-fence', 'v16-room', 'legacy-human', 2, 'message',
                   NULL, NULL, 'message_recalled', '2026-08-19T00:08:00.000Z')`,
      ).run();
      database.prepare(
        `UPDATE message_envelopes
         SET lifecycle = 'recalled', recalled_at = '2026-08-19T00:08:00.000Z',
             recalled_by_actor_id = 'v16-human'
         WHERE message_id = 'legacy-human'`,
      ).run();
      expect(database.prepare(
        `SELECT lifecycle, current_revision AS currentRevision
         FROM message_envelopes WHERE message_id = 'legacy-human'`,
      ).get()).toEqual({ lifecycle: "recalled", currentRevision: 2 });
    });
  });

  it("binds Agent final source rows to the current attempt/generation and one final CAS", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion15ForTest(database);
      seedRoomAndLegacyMessages(database);
      migrateAuthorityDatabaseToVersion16ForTest(database);
      seedClaimedAgentExecution(database);

      expect(() => begin(database, () => {
        insertAgentMessageSource(database, "arbitrary-generation-final", 999);
      })).toThrow(/generation|lineage|foreign key/i);

      begin(database, () => {
        insertAgentMessageSource(database, "committed-final", 1);
        database.prepare(
          `UPDATE agent_execution_attempts
           SET status = 'completed', finished_at = '2026-08-19T00:12:00.000Z'
           WHERE execution_id = 'final-execution' AND attempt_seq = 1`,
        ).run();
        database.prepare(
          `UPDATE agent_executions
           SET status = 'completed', completed_at = '2026-08-19T00:12:00.000Z',
               result_message_id = 'committed-final', updated_at = '2026-08-19T00:12:00.000Z'
           WHERE id = 'final-execution'`,
        ).run();
      });

      expect(() => begin(database, () => {
        insertAgentMessageSource(database, "duplicate-final", 2);
      })).toThrow(/final|lineage|unique/i);
      expect(database.prepare(
        `SELECT message_id AS messageId, execution_generation AS executionGeneration
         FROM agent_message_sources`,
      ).all()).toEqual([{ messageId: "committed-final", executionGeneration: 1 }]);
    });
  });

  it("rolls every meaningful v16 statement back with v15 schema, data, version, and history intact", () => {
    for (
      let failAfterStatement = 1;
      failAfterStatement <= AUTHORITY_V16_STATEMENT_COUNT_FOR_TEST;
      failAfterStatement += 1
    ) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToVersion15ForTest(database);
        seedRoomAndLegacyMessages(database);
        const beforeTables = listAuthorityTables(database);
        const beforeMessages = database.prepare(
          "SELECT id, room_id, author_id, author_kind, body, sent_at FROM messages ORDER BY id",
        ).all();
        const beforeHistory = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();

        expect(() => migrateAuthorityDatabaseToVersion16ForTest(database, { failAfterStatement }))
          .toThrow(/injected migration failure/i);

        expect(readSchemaVersion(database)).toBe(15);
        expect(listAuthorityTables(database)).toEqual(beforeTables);
        expect(database.prepare(
          "SELECT id, room_id, author_id, author_kind, body, sent_at FROM messages ORDER BY id",
        ).all()).toEqual(beforeMessages);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(beforeHistory);
        expect(() => migrateAuthorityDatabaseToVersion15ForTest(database)).not.toThrow();
      });
    }
  }, 60_000);
});
