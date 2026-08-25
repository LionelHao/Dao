import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V20_INVARIANT_STATEMENT_COUNT_FOR_TEST,
  AUTHORITY_V20_MIGRATION_CHECKSUM_FOR_TEST,
  AUTHORITY_V20_ROLLBACK_ASSERTION_COUNT_FOR_TEST,
  AUTHORITY_V20_STATEMENT_COUNT_FOR_TEST,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  migrateAuthorityDatabaseToVersion20ForTest,
  readSchemaVersion,
} from "./schema.js";

const NOW = "2026-08-24T00:00:00.000Z";
const SHA = "a".repeat(64);

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v20-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function schemaArtifact(database: DatabaseSync): readonly unknown[] {
  return database.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  ).all();
}

function seedLegacyStaticAgent(
  database: DatabaseSync,
  participation: "active" | "on-mention" | "silent" = "silent",
  actorTools = '["repository.git-status"]',
  memberTools = actorTools,
): void {
  database.prepare(`
    INSERT INTO actors (id, kind, display_name, readiness, tool_permissions_json)
    VALUES ('legacy-human', 'human', 'Owner', NULL, '[]'),
           ('legacy-agent', 'agent', 'Stable Legacy Name', 'ready', ?)
  `).run(actorTools);
  database.exec(`
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'legacy-human', 0, 1),
           ('identity', 'legacy-agent', 0, 1),
           ('room', 'legacy-room', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES ('legacy-room', 'Legacy Room', 'active', '${NOW}', 'legacy-human');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('legacy-room', 'legacy-human', 'human', 'owner', NULL, '[]', '${NOW}', NULL, 0);
  `);
  database.prepare(`
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES ('legacy-room', 'legacy-agent', 'agent', NULL, ?, ?, NULL, ?, 7)
  `).run(participation, memberTools, NOW);
}

describe("authority SQLite v20 Agent Profile and Routing Authority", () => {
  it("upgrades fresh and every immutable v1-v19 schema and restarts idempotently", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_SCHEMA_VERSION).toBe(22);
      expect(readSchemaVersion(database)).toBe(22);
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
        .toEqual({ count: 22 });
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
    });
    for (let version = 1; version <= 19; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(22);
      });
    }
  }, 150_000);

  it("preserves all v1-v19 history and produces an equivalent fresh physical schema", () => {
    let freshArtifact: readonly unknown[] = [];
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      freshArtifact = schemaArtifact(database);
    });
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 19);
      const history = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      migrateAuthorityDatabase(database);
      expect(schemaArtifact(database)).toEqual(freshArtifact);
      expect(database.prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version <= 19 ORDER BY version",
      ).all()).toEqual(history);
      expect(database.prepare(
        "SELECT name FROM schema_migrations WHERE version = 20",
      ).get()).toEqual({ name: "agent-profile-routing-authority" });
    });
  });

  it("backfills static Agents and quarantines legacy silent without changing stable identity", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 19);
      seedLegacyStaticAgent(database);
      migrateAuthorityDatabase(database);
      expect(database.prepare(`
        SELECT profile.actor_id AS actorId, profile.display_name AS displayName,
               profile.status, profile.tool_ceiling_json AS toolCeilingJson,
               profile.source_kind AS sourceKind
        FROM agent_profiles AS profile WHERE profile.actor_id = 'legacy-agent'
      `).get()).toEqual({
        actorId: "legacy-agent", displayName: "Stable Legacy Name", status: "enabled",
        toolCeilingJson: '["repository.git-status"]', sourceKind: "legacy_v20_migration",
      });
      expect(database.prepare(`
        SELECT participation, paused, tool_subset_json AS toolSubsetJson,
               source_kind AS sourceKind
        FROM room_agent_assignments
        WHERE room_id = 'legacy-room' AND agent_actor_id = 'legacy-agent'
      `).get()).toEqual({
        participation: "on-mention", paused: 1,
        toolSubsetJson: '["repository.git-status"]', sourceKind: "legacy_v20_migration",
      });
      expect(database.prepare(`
        SELECT participation FROM room_memberships
        WHERE room_id = 'legacy-room' AND actor_id = 'legacy-agent'
      `).get()).toEqual({ participation: "on-mention" });
      expect(database.prepare(`
        SELECT profile_id AS profileId, assignment_id AS assignmentId,
               review_required AS reviewRequired
        FROM agent_authority_migration_provenance
        WHERE source_kind = 'legacy_silent_assignment'
      `).get()).toEqual({
        profileId: "legacy-profile:legacy-agent",
        assignmentId: "legacy-assignment:legacy-room:legacy-agent",
        reviewRequired: 1,
      });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM agent_profile_revisions
        WHERE actor_id = 'legacy-agent' AND operation = 'legacy_migration'
      `).get()).toEqual({ count: 1 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM room_agent_assignment_revisions
        WHERE agent_actor_id = 'legacy-agent' AND operation = 'legacy_migration'
      `).get()).toEqual({ count: 1 });
    });
  });

  it("fails closed on unknown legacy grants while preserving actor and Room provenance", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 19);
      seedLegacyStaticAgent(database, "active", '["shell.exec"]', '["shell.exec"]');
      migrateAuthorityDatabase(database);
      expect(database.prepare(`
        SELECT actor_id AS actorId, display_name AS displayName, status,
               tool_ceiling_json AS toolCeilingJson
        FROM agent_profiles WHERE actor_id = 'legacy-agent'
      `).get()).toEqual({
        actorId: "legacy-agent", displayName: "Stable Legacy Name",
        status: "disabled", toolCeilingJson: "[]",
      });
      expect(database.prepare(`
        SELECT paused, tool_subset_json AS toolSubsetJson
        FROM room_agent_assignments WHERE agent_actor_id = 'legacy-agent'
      `).get()).toEqual({ paused: 1, toolSubsetJson: "[]" });
      expect(database.prepare(`
        SELECT review_required AS reviewRequired
        FROM agent_authority_migration_provenance
        WHERE source_kind = 'legacy_actor_profile' AND actor_id = 'legacy-agent'
      `).get()).toEqual({ reviewRequired: 1 });
    });
  });

  it("extends the populated v14 Profile/Assignment seam without replacing stable IDs", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 19);
      seedLegacyStaticAgent(database, "on-mention");
      database.exec(`
        INSERT INTO agent_profiles (
          id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json
        ) VALUES ('existing-profile', 'legacy-agent', 4, 'enabled', '[]',
          '["repository.git-status"]');
        INSERT INTO room_agent_assignments (
          id, room_id, profile_id, agent_actor_id, revision, status, participation,
          paused, capability_subset_json, tool_subset_json
        ) VALUES ('existing-assignment', 'legacy-room', 'existing-profile',
          'legacy-agent', 6, 'current', 'on-mention', 0, '[]',
          '["repository.git-status"]');
      `);
      migrateAuthorityDatabase(database);
      expect(database.prepare(`
        SELECT id, actor_id AS actorId, revision, display_name AS displayName,
               global_responsibility AS globalResponsibility
        FROM agent_profiles WHERE actor_id = 'legacy-agent'
      `).get()).toEqual({
        id: "existing-profile", actorId: "legacy-agent", revision: 4,
        displayName: "Stable Legacy Name",
        globalResponsibility: "Review migrated Agent configuration before use.",
      });
      expect(database.prepare(`
        SELECT id, profile_id AS profileId, agent_actor_id AS actorId, revision,
               participation, paused FROM room_agent_assignments
        WHERE room_id = 'legacy-room' AND agent_actor_id = 'legacy-agent'
      `).get()).toEqual({
        id: "existing-assignment", profileId: "existing-profile", actorId: "legacy-agent",
        revision: 6, participation: "on-mention", paused: 0,
      });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM agent_profiles WHERE actor_id = 'legacy-agent'
      `).get()).toEqual({ count: 1 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM room_agent_assignments
        WHERE room_id = 'legacy-room' AND agent_actor_id = 'legacy-agent'
      `).get()).toEqual({ count: 1 });
    });
  });

  it("rolls every v20 statement back to the identical populated v19 database", () => {
    expect(AUTHORITY_V20_STATEMENT_COUNT_FOR_TEST).toBe(97);
    expect(AUTHORITY_V20_INVARIANT_STATEMENT_COUNT_FOR_TEST).toBe(60);
    expect(AUTHORITY_V20_ROLLBACK_ASSERTION_COUNT_FOR_TEST).toBe(97);
    expect(AUTHORITY_V20_MIGRATION_CHECKSUM_FOR_TEST)
      .toBe("f4b4f080c7f5815cc6f399b5775a083514493cec675c04abd98a13cae0226b7f");
    for (let statement = 1; statement <= AUTHORITY_V20_STATEMENT_COUNT_FOR_TEST; statement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, 19);
        seedLegacyStaticAgent(database);
        const beforeTables = listAuthorityTables(database);
        const beforeHistory = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        expect(() => migrateAuthorityDatabaseToVersion20ForTest(
          database,
          { failAfterStatement: statement },
        ))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(19);
        expect(listAuthorityTables(database)).toEqual(beforeTables);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(beforeHistory);
        expect(database.prepare(`
          SELECT display_name AS displayName, readiness, tool_permissions_json AS tools
          FROM actors WHERE id = 'legacy-agent'
        `).get()).toEqual({
          displayName: "Stable Legacy Name", readiness: "ready",
          tools: '["repository.git-status"]',
        });
        expect(database.prepare(`
          SELECT participation FROM room_memberships
          WHERE room_id = 'legacy-room' AND actor_id = 'legacy-agent'
        `).get()).toEqual({ participation: "silent" });
      });
    }
  }, 240_000);

  it("enforces Human-only administration, registry CAS, last-admin, audit secrecy, and history", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name, tool_permissions_json)
        VALUES ('admin-1', 'human', 'Admin 1', '[]'),
               ('admin-2', 'human', 'Admin 2', '[]'),
               ('not-admin-agent', 'agent', 'Agent', '[]');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'admin-1', 0, 1), ('identity', 'admin-2', 0, 1),
               ('identity', 'not-admin-agent', 0, 1);
        INSERT INTO agent_profiles (
          id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json,
          display_name, global_responsibility, created_at, updated_at, source_kind
        ) VALUES ('not-admin-profile', 'not-admin-agent', 1, 'disabled', '[]', '[]',
          'Agent', 'Not an administrator.', '${NOW}', '${NOW}', 'static_bootstrap');
        INSERT INTO agent_profile_revisions (
          profile_id, revision, actor_id, display_name, global_responsibility, status,
          capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id,
          changed_at, operation
        ) VALUES ('not-admin-profile', 1, 'not-admin-agent', 'Agent',
          'Not an administrator.', 'disabled', '[]', '[]', NULL, '${NOW}', 'legacy_migration');
        INSERT INTO tenant_administrator_registry (
          singleton_id, revision, bootstrap_configuration_sha256, initialized_at, updated_at
        ) VALUES (1, 1, '${SHA}', '${NOW}', '${NOW}');
        INSERT INTO tenant_administrators (
          human_actor_id, revision, status, source_kind, created_by_human_actor_id,
          created_at, updated_at, removed_at
        ) VALUES ('admin-1', 1, 'active', 'bootstrap', NULL, '${NOW}', '${NOW}', NULL);
        INSERT INTO tenant_administrator_revisions (
          human_actor_id, revision, status, operation, changed_by_human_actor_id, changed_at
        ) VALUES ('admin-1', 1, 'active', 'bootstrap', NULL, '${NOW}');
      `);
      expect(() => database.exec(`
        INSERT INTO tenant_administrators (
          human_actor_id, revision, status, source_kind, created_by_human_actor_id,
          created_at, updated_at, removed_at
        ) VALUES ('not-admin-agent', 1, 'active', 'administrator_command', 'admin-1',
          '${NOW}', '${NOW}', NULL)
      `)).toThrow(/Human authority/i);
      expect(() => database.exec(`
        UPDATE tenant_administrators SET revision = 2, status = 'removed',
          updated_at = '${NOW}', removed_at = '${NOW}' WHERE human_actor_id = 'admin-1'
      `)).toThrow(/transition/i);
      database.exec(`
        INSERT INTO tenant_administrators (
          human_actor_id, revision, status, source_kind, created_by_human_actor_id,
          created_at, updated_at, removed_at
        ) VALUES ('admin-2', 1, 'active', 'administrator_command', 'admin-1',
          '${NOW}', '${NOW}', NULL);
        UPDATE tenant_administrator_registry SET revision = 2, updated_at = '${NOW}'
        WHERE singleton_id = 1;
        UPDATE tenant_administrators SET revision = 2, status = 'removed',
          updated_at = '${NOW}', removed_at = '${NOW}' WHERE human_actor_id = 'admin-1';
        INSERT INTO tenant_administrator_revisions (
          human_actor_id, revision, status, operation, changed_by_human_actor_id, changed_at
        ) VALUES ('admin-1', 2, 'removed', 'remove', 'admin-2', '${NOW}');
      `);
      expect(() => database.exec(`
        INSERT INTO deployment_audit (
          audit_id, event_kind, principal_human_actor_id, subject_kind, subject_id,
          subject_revision, request_id, occurred_at, details_json
        ) VALUES ('audit-secret', 'profile.update', 'admin-2', 'agent_profile',
          'profile-1', 1, 'request-1', '${NOW}', '{"apiKey":"sentinel"}')
      `)).toThrow(/secret boundary/i);
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
    });
  });

  it("binds deployment Profile events, administrator outbox, repair, and invalidation facts", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 19);
      seedLegacyStaticAgent(database, "active");
      migrateAuthorityDatabase(database);
      database.exec(`
        INSERT INTO tenant_administrator_registry (
          singleton_id, revision, bootstrap_configuration_sha256, initialized_at, updated_at
        ) VALUES (1, 1, '${SHA}', '${NOW}', '${NOW}');
        INSERT INTO tenant_administrators (
          human_actor_id, revision, status, source_kind, created_by_human_actor_id,
          created_at, updated_at, removed_at
        ) VALUES ('legacy-human', 1, 'active', 'bootstrap', NULL, '${NOW}', '${NOW}', NULL);
        INSERT INTO tenant_administrator_revisions (
          human_actor_id, revision, status, operation, changed_by_human_actor_id, changed_at
        ) VALUES ('legacy-human', 1, 'active', 'bootstrap', NULL, '${NOW}');
        UPDATE deployment_stream SET head_seq = 1 WHERE singleton_id = 1;
        INSERT INTO deployment_agent_profile_events (
          event_id, stream_seq, profile_id, profile_revision, actor_id, event_kind,
          occurred_at, payload_json, payload_sha256
        ) VALUES ('profile-event-1', 1, 'legacy-profile:legacy-agent', 1, 'legacy-agent',
          'profile.created', '${NOW}',
          '{"profileId":"legacy-profile:legacy-agent","actorId":"legacy-agent","revision":1}',
          '${SHA}');
        INSERT INTO deployment_profile_outbox (
          id, event_id, recipient_human_actor_id, stream_seq, status, attempts,
          available_at, delivered_at, last_error
        ) VALUES ('profile-outbox-1', 'profile-event-1', 'legacy-human', 1,
          'pending', 0, '${NOW}', NULL, NULL);
        INSERT INTO deployment_agent_profile_repair_records (
          profile_id, profile_revision, record_version, event_id, stream_seq,
          projection_json, projection_sha256, updated_at
        ) VALUES ('legacy-profile:legacy-agent', 1, 1, 'profile-event-1', 1,
          '{"profileId":"legacy-profile:legacy-agent","actorId":"legacy-agent","revision":1}',
          '${SHA}', '${NOW}');
        UPDATE agent_profiles SET revision = 2, display_name = 'Renamed Agent',
          updated_at = '${NOW}' WHERE id = 'legacy-profile:legacy-agent';
        INSERT INTO agent_profile_revisions (
          profile_id, revision, actor_id, display_name, global_responsibility, status,
          capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id,
          changed_at, operation
        ) SELECT id, revision, actor_id, display_name, global_responsibility, status,
          capability_ceiling_json, tool_ceiling_json, 'legacy-human', '${NOW}', 'update'
          FROM agent_profiles WHERE id = 'legacy-profile:legacy-agent';
        UPDATE deployment_stream SET head_seq = 2 WHERE singleton_id = 1;
        INSERT INTO deployment_agent_profile_events (
          event_id, stream_seq, profile_id, profile_revision, actor_id, event_kind,
          occurred_at, payload_json, payload_sha256
        ) VALUES ('profile-event-2', 2, 'legacy-profile:legacy-agent', 2, 'legacy-agent',
          'profile.updated', '${NOW}',
          '{"profileId":"legacy-profile:legacy-agent","actorId":"legacy-agent","revision":2}',
          '${SHA}');
        UPDATE deployment_agent_profile_repair_records SET profile_revision = 2,
          event_id = 'profile-event-2', stream_seq = 2,
          projection_json =
            '{"profileId":"legacy-profile:legacy-agent","actorId":"legacy-agent","revision":2}',
          projection_sha256 = '${SHA}', updated_at = '${NOW}'
          WHERE profile_id = 'legacy-profile:legacy-agent';
        INSERT INTO agent_profile_invalidation_facts (
          invalidation_id, profile_id, from_revision, to_revision, reason,
          invalidated_context_count, cancelled_route_intent_count,
          affected_assignment_count, occurred_at
        ) VALUES ('profile-invalidation-2', 'legacy-profile:legacy-agent', 1, 2,
          'profile_updated', 0, 0, 1, '${NOW}');
      `);
      expect(database.prepare(
        "SELECT head_seq AS headSeq FROM deployment_stream WHERE singleton_id = 1",
      ).get()).toEqual({ headSeq: 2 });
      expect(database.prepare(`
        SELECT profile_revision AS profileRevision, stream_seq AS streamSeq
        FROM deployment_agent_profile_repair_records
        WHERE profile_id = 'legacy-profile:legacy-agent'
      `).get()).toEqual({ profileRevision: 2, streamSeq: 2 });
      expect(() => database.exec(`
        UPDATE deployment_agent_profile_events SET payload_json = '{}'
        WHERE event_id = 'profile-event-1'
      `)).toThrow(/immutable/i);
      expect(() => database.exec(`
        DELETE FROM deployment_profile_outbox WHERE id = 'profile-outbox-1'
      `)).toThrow(/immutable/i);
    });
  });

  it("enforces canonical Profile/Assignment sets and trusted route-to-intent provenance", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 19);
      seedLegacyStaticAgent(database, "active");
      database.exec(`
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('route-message', 'legacy-room', 'legacy-human', 'human', 'route', '${NOW}');
        INSERT INTO message_revisions (
          message_id, revision, body, revised_at, revised_by_actor_id
        ) VALUES ('route-message', 1, 'route', '${NOW}', 'legacy-human');
        INSERT INTO message_envelopes (
          message_id, room_id, message_kind, lifecycle, current_revision,
          revision_count, created_at, recalled_at, recalled_by_actor_id
        ) VALUES ('route-message', 'legacy-room', 'human', 'active', 1, 1,
          '${NOW}', NULL, NULL);
      `);
      migrateAuthorityDatabase(database);
      const profile = database.prepare(
        "SELECT id, revision FROM agent_profiles WHERE actor_id = 'legacy-agent'",
      ).get() as { readonly id: string; readonly revision: number };
      const assignment = database.prepare(
        "SELECT id, revision FROM room_agent_assignments WHERE agent_actor_id = 'legacy-agent'",
      ).get() as { readonly id: string; readonly revision: number };
      expect(() => database.prepare(`
        UPDATE agent_profiles
        SET revision = revision + 1, tool_ceiling_json = '["shell.exec"]', updated_at = ?
        WHERE id = ?
      `).run(NOW, profile.id)).toThrow(/authority set/i);
      database.prepare(`
        INSERT INTO route_jobs (
          id, room_id, source_message_id, status, current_attempt, topic_key,
          embedding_model_version, window_size, cosine_threshold, room_phase,
          created_at, updated_at, completed_at, terminal_error_code, next_retry_at,
          revision, candidate_snapshot_id
        ) VALUES ('route-v20', 'legacy-room', 'route-message', 'running', 1, 'topic',
          'dao-topic-embedding-v1', 8, 0.82, 'discussion', ?, ?, NULL, NULL, NULL, 1, NULL)
      `).run(NOW, NOW);
      database.prepare(`
        INSERT INTO route_candidate_snapshots (
          id, route_job_id, room_id, room_revision, source_message_id,
          source_message_revision, source_author_kind, source_message_kind,
          snapshot_version, candidate_count, snapshot_sha256, created_at
        ) VALUES ('snapshot-v20', 'route-v20', 'legacy-room', 1, 'route-message', 1,
          'human', 'human', 1, 1, ?, ?)
      `).run(SHA, NOW);
      database.prepare(
        "UPDATE route_jobs SET candidate_snapshot_id = 'snapshot-v20' WHERE id = 'route-v20'",
      ).run();
      database.prepare(`
        INSERT INTO route_candidate_snapshot_agents (
          snapshot_id, route_job_id, agent_actor_id, profile_id, profile_revision,
          assignment_id, assignment_revision, access_revision, participation,
          availability, room_responsibility, effective_capabilities_json,
          effective_tools_json, calibration_score, has_ball, goal_fact_revision,
          project_fact_revision, ball_fact_revision, candidate_order
        ) VALUES ('snapshot-v20', 'route-v20', 'legacy-agent', ?, ?, ?, ?, 7,
          'active', 'ready', 'Review route', '[]', '["repository.git-status"]',
          0, 0, 1, NULL, NULL, 0)
      `).run(profile.id, profile.revision, assignment.id, assignment.revision);
      database.exec(`
        INSERT INTO route_decisions (
          id, route_job_id, expected_route_job_revision, snapshot_id,
          outcome, reason_code, decided_at
        ) VALUES ('decision-v20', 'route-v20', 1, 'snapshot-v20',
          'selected', 'selected', '${NOW}')
      `);
      database.prepare(`
        INSERT INTO routed_agent_invocation_intents (
          id, route_decision_id, route_job_id, snapshot_id, room_id,
          source_message_id, source_message_revision, target_agent_actor_id,
          profile_id, profile_revision, assignment_id, assignment_revision,
          access_revision, trigger_kind, reason_text, status, created_at,
          claimed_at, cancelled_at, cancellation_reason
        ) VALUES ('intent-v20', 'decision-v20', 'route-v20', 'snapshot-v20',
          'legacy-room', 'route-message', 1, 'legacy-agent', ?, ?, ?, ?, 7,
          'domain', 'responsibility match', 'pending', ?, NULL, NULL, NULL)
      `).run(profile.id, profile.revision, assignment.id, assignment.revision, NOW);
      expect(() => database.prepare(`
        INSERT INTO routed_agent_invocation_intents (
          id, route_decision_id, route_job_id, snapshot_id, room_id,
          source_message_id, source_message_revision, target_agent_actor_id,
          profile_id, profile_revision, assignment_id, assignment_revision,
          access_revision, trigger_kind, reason_text, status, created_at,
          claimed_at, cancelled_at, cancellation_reason
        ) VALUES ('forged-intent', 'decision-v20', 'route-v20', 'snapshot-v20',
          'legacy-room', 'route-message', 1, 'legacy-agent', ?, 999, ?, ?, 7,
          'domain', 'forged', 'pending', ?, NULL, NULL, NULL)
      `).run(profile.id, assignment.id, assignment.revision, NOW)).toThrow(/candidate snapshot/i);
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
    });
  });

  it("refuses future, migration-history, and physical-contract tamper", () => {
    withDatabase((database) => {
      database.exec("PRAGMA user_version = 23");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/future schema/i);
    });
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 20")
        .run("b".repeat(64));
      expect(() => migrateAuthorityDatabase(database)).toThrow(/migration|checksum/i);
    });
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec("DROP TRIGGER route_decisions_v20_immutable_update");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/physical contract/i);
    });
  });

  it("reopens v20 under WAL with migrated pause and provenance intact", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-authority-v20-wal-"));
    const path = join(directory, "authority.sqlite");
    try {
      const first = new DatabaseSync(path);
      migrateAuthorityDatabaseToHistoricalVersionForTest(first, 19);
      seedLegacyStaticAgent(first);
      migrateAuthorityDatabase(first);
      first.close();
      const reopened = new DatabaseSync(path);
      try {
        migrateAuthorityDatabase(reopened);
        expect(reopened.prepare(`
          SELECT participation, paused FROM room_agent_assignments
          WHERE agent_actor_id = 'legacy-agent'
        `).get()).toEqual({ participation: "on-mention", paused: 1 });
        expect(reopened.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
