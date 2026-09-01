import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  seedCanonicalAgentProfileFixture,
  seedCanonicalRoomAssignmentFixture,
} from "../fixtures/agent-authority-fixture.js";
import { createWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";

const temporaryDirectories = new Set<string>();
const now = Date.parse("2026-09-01T00:00:00.000Z");

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dao-retention-real-worker-"));
  temporaryDirectories.add(directory);
  return join(directory, "authority.sqlite");
}

function seedOneClosedBoundaryCandidate(path: string): void {
  const database = new DatabaseSync(path);
  try {
    migrateAuthorityDatabase(database);
    const createdAt = new Date(now - 10_000).toISOString();
    database.exec(`
      INSERT INTO actors (
        id, kind, display_name, reachability, readiness, tool_permissions_json
      ) VALUES
        ('agent-retention', 'agent', 'Retention Agent', NULL, 'ready',
         '["sandbox-file.write"]'),
        ('human-retention', 'human', 'Retention Human', 'online', NULL, '[]');
      INSERT INTO rooms (
        id, name, status, created_at, owner_actor_id, governance_revision
      ) VALUES (
        'room-retention', 'Retention Room', 'active', '${createdAt}',
        'human-retention', 1
      );
      INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
      VALUES
        ('identity', 'agent-retention', 0, 1),
        ('identity', 'human-retention', 0, 1),
        ('room', 'room-retention', 0, 1);
      INSERT INTO session_families (
        family_id, public_id, account_id, actor_id, device_id, device_label,
        platform, created_at, refresh_expires_at, revoked_at
      ) VALUES (
        'family-retention', 'public-retention', 'account-retention',
        'human-retention', 'device-retention', 'Retention Device', 'unknown',
        ${now - 10_000}, ${now + 86_400_000}, NULL
      );
      INSERT INTO sessions (
        family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
        access_expires_at, refresh_expires_at, revoked_at
      ) VALUES (
        'family-retention', 'account-retention', 'human-retention',
        'access-retention', 'refresh-retention', ${now + 3_600_000},
        ${now + 86_400_000}, NULL
      );
      INSERT INTO room_memberships (
        room_id, actor_id, kind, role, participation, tool_permissions_json,
        joined_at, configured_at, access_revision
      ) VALUES
        ('room-retention', 'human-retention', 'human', 'owner', NULL, '[]',
         '${createdAt}', NULL, 1),
        ('room-retention', 'agent-retention', 'agent', NULL, 'active',
         '["sandbox-file.write"]', NULL, '${createdAt}', 1);
      INSERT INTO agent_executions (
        id, room_id, agent_id, status, started_at, completed_at,
        action_category, tool_dispatch_phase, queued_at, updated_at
      ) VALUES (
        'execution-retention', 'room-retention', 'agent-retention',
        'completed', '${createdAt}', '${createdAt}', 'tool_call', 'finished',
        '${createdAt}', '${createdAt}'
      );
      INSERT INTO agent_execution_attempts (
        execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
        action_category, recovery_cursor
      ) VALUES (
        'execution-retention', 1, 1, 1, 'completed', 'tool_call', 0
      );
    `);
    const profileId = seedCanonicalAgentProfileFixture(database, {
      actorId: "agent-retention",
      toolCeiling: ["sandbox-file.write"],
      now: createdAt,
    });
    seedCanonicalRoomAssignmentFixture(database, {
      assignmentId: "assignment-retention",
      roomId: "room-retention",
      profileId,
      actorId: "agent-retention",
      toolSubset: ["sandbox-file.write"],
      now: createdAt,
    });
    database.prepare(
      `INSERT INTO tool_calls_v2 (
         tool_call_id, invocation_id, execution_id, attempt_seq, execution_version,
         room_id, agent_id, tool_id, canonical_parameter_sha256,
         parameter_schema_version, canonicalizer_version, source_snapshot_id,
         profile_revision, assignment_revision, access_revision, safe_preview_json,
         sealed_payload_ciphertext, sealed_payload_key_version,
         sealed_payload_expires_at, binding_generation, current_version, created_at,
         legacy_origin
       ) VALUES (
         'retention-fail-once', 'invocation-retention', 'execution-retention', 1, 1,
         'room-retention', 'agent-retention', 'sandbox-file.write', ?,
         'schema-v1', 'canonical-v1', 'snapshot-retention',
         1, 1, 1, '{}', 'sealed-ciphertext', 'key-v1', ?, 1, 1, ?, NULL
       )`,
    ).run("a".repeat(64), "0",
      new Date(now - 10_000).toISOString());
    database.prepare(
      `INSERT INTO tool_confirmations_v2 (
         confirmation_id, tool_call_id, principal_human_actor_id,
         session_family_id, binding_generation, state, reason, expires_at,
         version, created_at, changed_at
       ) VALUES (
         'confirmation-retention', 'retention-fail-once', 'human-retention',
         'family-retention', 1, 'confirmed', NULL, ?, 1, ?, ?
       )`,
    ).run(new Date(now + 86_400_000).toISOString(),
      new Date(now - 9_000).toISOString(), new Date(now - 8_000).toISOString());
    database.prepare(
      `INSERT INTO tool_grants_v2 (
         grant_id, tool_call_id, confirmation_id, state, reason, issued_at,
         expires_at, claimed_at, version, changed_at
       ) VALUES (
         'grant-retention', 'retention-fail-once', 'confirmation-retention',
         'claimed', NULL, ?, ?, ?, 1, ?
       )`,
    ).run(new Date(now - 8_000).toISOString(), new Date(now + 86_400_000).toISOString(),
      new Date(now - 7_000).toISOString(), new Date(now - 7_000).toISOString());
    database.prepare(
      `INSERT INTO tool_dispatches_v2 (
         dispatch_id, tool_call_id, grant_id, state, reason, safe_summary_json,
         sealed_compensation_ciphertext, prepared_at, claimed_at, dispatched_at,
         settled_at, version, changed_at
       ) VALUES (
         'dispatch-retention', 'retention-fail-once', 'grant-retention',
         'known_succeeded', NULL, '{}', NULL, ?, ?, ?, ?, 1, ?
       )`,
    ).run(...Array.from({ length: 5 }, () => new Date(now - 5_000).toISOString()));
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`Retention real-worker seed has foreign key violations: ${JSON.stringify(violations)}`);
    }
    migrateAuthorityDatabase(database);
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("FT-14 retention real AuthorityWorker retry", () => {
  it("keeps the shared Authority healthy across one closed boundary failure and future retries", async () => {
    const path = databasePath();
    seedOneClosedBoundaryCandidate(path);
    const client = await createWorkerDatabaseClient({ databasePath: path });
    const signal = new AbortController().signal;
    try {
      await expect(client.runBatch({
        workerId: "retention_janitor", trigger: "periodic", nowMs: now,
        limit: 100, signal,
      })).resolves.toEqual({
        processed: 1, purged: 0, retained: 0, retried: 1, deadLettered: 0,
        hasMore: false, queueDepth: 1, oldestAgeMs: 0,
      });

      // The future retry is durable but not runnable, and neither valid response poisons
      // this worker's shared protocol channel.
      await expect(client.inspectSchema()).resolves.toEqual({ version: 29 });
      await expect(client.runBatch({
        workerId: "retention_janitor", trigger: "periodic", nowMs: now + 1_999,
        limit: 100, signal,
      })).resolves.toMatchObject({
        processed: 0, hasMore: false, queueDepth: 1,
      });
      await expect(client.inspectSchema()).resolves.toEqual({ version: 29 });

      await expect(client.runBatch({
        workerId: "retention_janitor", trigger: "periodic", nowMs: now + 2_000,
        limit: 100, signal,
      })).resolves.toEqual({
        processed: 1, purged: 0, retained: 0, retried: 1, deadLettered: 0,
        hasMore: false, queueDepth: 1, oldestAgeMs: 0,
      });
      await expect(client.inspectSchema()).resolves.toEqual({ version: 29 });
    } finally {
      await client.close();
    }

    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspection.prepare(
        `SELECT sealed_payload_ciphertext AS ciphertext,
                sealed_payload_key_version AS keyVersion,
                sealed_payload_expires_at AS expiresAt
         FROM tool_calls_v2 WHERE tool_call_id = 'retention-fail-once'`,
      ).get()).toEqual({ ciphertext: "sealed-ciphertext", keyVersion: "key-v1", expiresAt: "0" });
      expect(inspection.prepare(
        `SELECT status, attempts FROM privacy_retention_attempts
         WHERE category = 'tool_sealed_side_effect_payload'
           AND candidate_id = 'retention-fail-once'`,
      ).get()).toEqual({ status: "pending", attempts: 2 });
    } finally {
      inspection.close();
    }
  });
});
