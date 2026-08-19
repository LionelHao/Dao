import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  invokeAuthorityParticipant,
} from "../room-governance/private-participant-registry.js";
import type {
  FeatureEnablementManifest,
  RuntimeArchiveFenceResult,
} from "../room-governance/private-participant-contracts.js";
import {
  canStartRuntimeGenerationInTransaction,
  createRuntimeArchiveFenceParticipant,
  recoverRuntimeArchiveFenceInTransaction,
  runtimeArchiveFenceParticipantRegistration,
} from "./runtime-archive-fence-participant.js";

const now = "2026-08-19T00:00:00.000Z";
const databases: DatabaseSync[] = [];
const directories: string[] = [];

const manifest: FeatureEnablementManifest = {
  "departure-responsibility": false,
  "pending-confirmation-departure": false,
  "archived-message-gate": false,
  "business-timer-suspension": false,
  "archive-settlement": false,
  "runtime-archive-fence": true,
  "assignment-security-reduction": false,
  "lifecycle-repair": false,
  "room-cache-invalidation": false,
  "offline-lease-invalidation": false,
};

afterEach(() => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // The restart test deliberately closes its first connection.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "dao-runtime-archive-fence-"));
  directories.push(directory);
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  databases.push(database);
  migrateAuthorityDatabase(database);
  const executionColumns = database.prepare("PRAGMA table_info(agent_executions)").all();
  if (!executionColumns.some((column) => column.name === "room_archive_generation")) {
    database.exec(`
      ALTER TABLE agent_executions
        ADD COLUMN room_archive_generation INTEGER NOT NULL DEFAULT 0
        CHECK (room_archive_generation >= 0)
    `);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_archive_fences (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
      fenced_at TEXT NOT NULL,
      fenced_queued_count INTEGER NOT NULL DEFAULT 0 CHECK (fenced_queued_count >= 0),
      fenced_waiting_count INTEGER NOT NULL DEFAULT 0 CHECK (fenced_waiting_count >= 0),
      preserved_dispatched_count INTEGER NOT NULL DEFAULT 0 CHECK (preserved_dispatched_count >= 0),
      preserved_outcome_review_count INTEGER NOT NULL DEFAULT 0 CHECK (preserved_outcome_review_count >= 0),
      PRIMARY KEY (room_id, archive_generation)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS runtime_archive_fence_members (
      room_id TEXT NOT NULL,
      archive_generation INTEGER NOT NULL,
      execution_id TEXT NOT NULL REFERENCES agent_executions(id),
      attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
      disposition TEXT NOT NULL CHECK (disposition IN (
        'cancelled_queued', 'cancelled_waiting',
        'preserved_dispatched', 'preserved_outcome_review'
      )),
      fenced_at TEXT NOT NULL,
      PRIMARY KEY (room_id, archive_generation, execution_id),
      FOREIGN KEY (room_id, archive_generation)
        REFERENCES runtime_archive_fences(room_id, archive_generation),
      FOREIGN KEY (execution_id, attempt_seq)
        REFERENCES agent_execution_attempts(execution_id, attempt_seq)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS runtime_archive_fence_members_execution
      ON runtime_archive_fence_members(execution_id, archive_generation);
    INSERT INTO actors (id, kind, display_name, readiness, tool_permissions_json)
    VALUES
      ('human-1', 'human', 'Human One', NULL, '[]'),
      ('agent-1', 'agent', 'Agent One', 'ready', '["sandbox-file.write"]');
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-1', 'Room One', 'active', '${now}');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at
    ) VALUES
      ('room-1', 'human-1', 'human', 'member', NULL, '[]', '${now}', NULL),
      ('room-1', 'agent-1', 'agent', NULL, 'active', '["sandbox-file.write"]', NULL, '${now}');
    UPDATE rooms SET owner_actor_id = 'human-1', governance_revision = 1
      WHERE id = 'room-1';
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES ('source-1', 'room-1', 'human-1', 'human', 'invoke', '${now}');
  `);
  return database;
}

type ExecutionState =
  | "queued"
  | "running-waiting"
  | "running-model"
  | "dispatched"
  | "outcome-unknown";

function seedExecution(
  database: DatabaseSync,
  id: string,
  state: ExecutionState,
  roomArchiveGeneration = 0,
): void {
  const queued = state === "queued";
  const waiting = state === "running-waiting";
  const model = state === "running-model";
  const actionCategory = waiting ? "waiting_upstream" : model ? "model_generation" : "tool_call";
  const toolDispatchPhase = actionCategory === "tool_call"
    ? (queued ? "not_started" : state === "dispatched" || state === "outcome-unknown"
      ? "dispatched" : "not_started")
    : null;
  database.prepare(
    `INSERT INTO agent_executions (
       id, room_id, agent_id, trigger_message_id, status, started_at,
       requester_actor_id, tool_name, action_category, tool_dispatch_phase,
       queued_at, updated_at, room_archive_generation
     ) VALUES (?, 'room-1', 'agent-1', 'source-1', ?, ?, 'human-1', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    queued ? "queued" : "running",
    now,
    actionCategory === "tool_call" ? "sandbox-file.write" : "model.generate",
    actionCategory,
    toolDispatchPhase,
    now,
    now,
    roomArchiveGeneration,
  );
  database.prepare(
    `INSERT INTO agent_execution_attempts (
       execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
       action_category, started_at, recovery_cursor
     ) VALUES (?, 1, 1, 1, ?, ?, ?, 0)`,
  ).run(id, queued ? "queued" : "running", actionCategory, queued ? null : now);

  if (state !== "dispatched" && state !== "outcome-unknown") return;
  const hash = "a".repeat(64);
  database.prepare(
    `INSERT INTO agent_execution_grants (
       grant_id, execution_id, attempt_seq, agent_id, room_id, tool_id,
       parameter_sha256, issued_at, expires_at, consumed_at
     ) VALUES (?, ?, 1, 'agent-1', 'room-1', 'sandbox-file.write', ?, ?, ?, ?)`,
  ).run(`grant-${id}`, id, hash, now, "2026-08-20T00:00:00.000Z", now);
  database.prepare(
    `INSERT INTO tool_dispatches (
       dispatch_id, execution_id, attempt_seq, grant_id, tool_id,
       parameter_sha256, state, dispatched_at, settled_at
     ) VALUES (?, ?, 1, ?, 'sandbox-file.write', ?, ?, ?, ?)`,
  ).run(
    `dispatch-${id}`,
    id,
    `grant-${id}`,
    hash,
    state === "outcome-unknown" ? "outcome_unknown" : "dispatched",
    now,
    state === "outcome-unknown" ? now : null,
  );
}

function archiveInTransaction(
  database: DatabaseSync,
  archiveGeneration: number,
  commit = true,
  participant = runtimeArchiveFenceParticipantRegistration.participant,
): RuntimeArchiveFenceResult {
  database.exec("BEGIN IMMEDIATE");
  database.prepare(
    `UPDATE rooms
     SET status = 'archived', archive_generation = ?, archived_at = ?
     WHERE id = 'room-1'`,
  ).run(archiveGeneration, now);
  const transaction = mintDatabaseAuthorityTransactionView(
    database,
    "room-1",
    `archive-${archiveGeneration}`,
  );
  try {
    const result = invokeAuthorityParticipant({
      feature: "runtime-archive-fence",
      manifest,
      registrations: [{
        ...runtimeArchiveFenceParticipantRegistration,
        participant,
      }],
      tx: transaction,
      roomId: "room-1",
      invoke: (registered) => registered.fenceForArchive(transaction, {
        roomId: "room-1",
        archiveGeneration,
        now,
      }),
    });
    database.exec(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    releaseDatabaseAuthorityTransactionView(transaction);
  }
}

describe("RuntimeArchiveFence production participant", () => {
  it("terminates every undispatched live execution and preserves dispatched evidence", () => {
    const database = fixture();
    seedExecution(database, "queued", "queued");
    seedExecution(database, "waiting", "running-waiting");
    seedExecution(database, "model", "running-model");
    seedExecution(database, "dispatched", "dispatched");
    seedExecution(database, "unknown", "outcome-unknown");

    expect(archiveInTransaction(database, 1)).toEqual({
      roomId: "room-1",
      archiveGeneration: 1,
      fencedQueuedCount: 1,
      fencedWaitingCount: 2,
      preservedDispatchedCount: 1,
      preservedOutcomeReviewCount: 1,
    });
    expect(database.prepare(
      `SELECT id, status, cancellation_reason AS cancellationReason,
              terminal_error_code AS terminalErrorCode
       FROM agent_executions ORDER BY id`,
    ).all()).toEqual([
      { id: "dispatched", status: "failed", cancellationReason: null,
        terminalErrorCode: "side_effect_outcome_unknown" },
      { id: "model", status: "cancelled", cancellationReason: "room_archived",
        terminalErrorCode: null },
      { id: "queued", status: "cancelled", cancellationReason: "room_archived",
        terminalErrorCode: null },
      { id: "unknown", status: "failed", cancellationReason: null,
        terminalErrorCode: "side_effect_outcome_unknown" },
      { id: "waiting", status: "cancelled", cancellationReason: "room_archived",
        terminalErrorCode: null },
    ]);
    expect(database.prepare(
      "SELECT dispatch_id AS dispatchId, state FROM tool_dispatches ORDER BY dispatch_id",
    ).all()).toEqual([
      { dispatchId: "dispatch-dispatched", state: "outcome_unknown" },
      { dispatchId: "dispatch-unknown", state: "outcome_unknown" },
    ]);
  });

  it("is idempotent, reconstructs without memory, and recovers an invalid late old-generation row", () => {
    let database = fixture();
    seedExecution(database, "queued", "queued");
    const first = archiveInTransaction(database, 1);
    const databasePath = String(database.prepare("PRAGMA database_list").get()?.file);
    database.close();
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    databases.push(database);
    expect(archiveInTransaction(
      database,
      1,
      true,
      createRuntimeArchiveFenceParticipant(),
    )).toEqual(first);

    seedExecution(database, "late-old", "running-model");
    database.exec("BEGIN IMMEDIATE");
    const recoveryTransaction = mintDatabaseAuthorityTransactionView(
      database,
      "room-1",
      "runtime-fence-recovery",
    );
    let recovered: RuntimeArchiveFenceResult | undefined;
    try {
      recovered = recoverRuntimeArchiveFenceInTransaction(recoveryTransaction, {
        roomId: "room-1",
        now,
      });
      database.exec("COMMIT");
    } finally {
      releaseDatabaseAuthorityTransactionView(recoveryTransaction);
    }
    expect(recovered).toMatchObject({ fencedQueuedCount: 1, fencedWaitingCount: 1 });
    expect(database.prepare(
      "SELECT status, cancellation_reason AS reason FROM agent_executions WHERE id = 'late-old'",
    ).get()).toEqual({ status: "cancelled", reason: "room_archived" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM runtime_archive_fence_members",
    ).get()).toEqual({ count: 2 });
  });

  it("rejects stale/new generation starts and admits only the current active generation", () => {
    const database = fixture();
    database.exec("BEGIN IMMEDIATE");
    let transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "admit-active");
    expect(canStartRuntimeGenerationInTransaction(transaction, {
      roomId: "room-1", archiveGeneration: 0,
    })).toBe(true);
    releaseDatabaseAuthorityTransactionView(transaction);
    database.exec("COMMIT");

    archiveInTransaction(database, 1);
    database.exec("BEGIN IMMEDIATE");
    transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "admit-archived");
    expect(canStartRuntimeGenerationInTransaction(transaction, {
      roomId: "room-1", archiveGeneration: 0,
    })).toBe(false);
    expect(canStartRuntimeGenerationInTransaction(transaction, {
      roomId: "room-1", archiveGeneration: 1,
    })).toBe(false);
    releaseDatabaseAuthorityTransactionView(transaction);
    database.exec("COMMIT");

    database.prepare("UPDATE rooms SET status = 'active', archived_at = NULL WHERE id = 'room-1'").run();
    database.exec("BEGIN IMMEDIATE");
    transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "admit-reopened");
    expect(canStartRuntimeGenerationInTransaction(transaction, {
      roomId: "room-1", archiveGeneration: 0,
    })).toBe(false);
    expect(canStartRuntimeGenerationInTransaction(transaction, {
      roomId: "room-1", archiveGeneration: 1,
    })).toBe(true);
    releaseDatabaseAuthorityTransactionView(transaction);
    database.exec("COMMIT");

    seedExecution(database, "generation-1", "queued", 1);
    expect(archiveInTransaction(database, 2)).toMatchObject({
      roomId: "room-1",
      archiveGeneration: 2,
      fencedQueuedCount: 1,
    });
    expect(database.prepare(
      `SELECT status, cancellation_reason AS reason
       FROM agent_executions WHERE id = 'generation-1'`,
    ).get()).toEqual({ status: "cancelled", reason: "room_archived" });
  });

  it("rolls back the fence, execution terminals, dispatch review, and durable counts together", () => {
    const database = fixture();
    seedExecution(database, "queued", "queued");
    seedExecution(database, "dispatched", "dispatched");
    archiveInTransaction(database, 1, false);

    expect(database.prepare(
      "SELECT id, status FROM agent_executions ORDER BY id",
    ).all()).toEqual([
      { id: "dispatched", status: "running" },
      { id: "queued", status: "queued" },
    ]);
    expect(database.prepare("SELECT state FROM tool_dispatches").get()).toEqual({ state: "dispatched" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_archive_fences").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT status, archive_generation AS generation FROM rooms").get())
      .toEqual({ status: "active", generation: 0 });
  });

  it("fails closed for a mismatched generation without synthesizing success", () => {
    const database = fixture();
    seedExecution(database, "queued", "queued");
    database.prepare(
      "UPDATE rooms SET status = 'archived', archive_generation = 2, archived_at = ?",
    ).run(now);
    database.exec("BEGIN IMMEDIATE");
    const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "stale-fence");
    try {
      expect(() => invokeAuthorityParticipant({
        feature: "runtime-archive-fence",
        manifest,
        registrations: [runtimeArchiveFenceParticipantRegistration],
        tx: transaction,
        roomId: "room-1",
        invoke: (participant) => participant.fenceForArchive(transaction, {
          roomId: "room-1", archiveGeneration: 1, now,
        }),
      })).toThrowError(expect.objectContaining({
        safeError: expect.objectContaining({
          dependency: "runtime-archive-fence",
          reason: "participant_threw",
        }),
      }));
      database.exec("ROLLBACK");
    } finally {
      releaseDatabaseAuthorityTransactionView(transaction);
    }
    expect(database.prepare("SELECT status FROM agent_executions WHERE id = 'queued'").get())
      .toEqual({ status: "queued" });
  });
});
