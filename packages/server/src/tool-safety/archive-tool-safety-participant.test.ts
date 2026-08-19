import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import {
  mintAuthorityTransactionView,
  type ArchiveSettlementResult,
  type AuthorityTransactionView,
} from "../room-governance/private-participant-contracts.js";
import {
  archiveToolSafetyParticipantRegistration,
  createArchiveToolSafetyParticipant,
} from "./archive-tool-safety-participant.js";

const NOW = "2026-08-19T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabase(path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      archive_generation INTEGER NOT NULL CHECK (archive_generation >= 0),
      archived_at TEXT
    ) STRICT;
    CREATE TABLE agent_executions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      current_attempt_seq INTEGER NOT NULL CHECK (current_attempt_seq >= 1),
      action_category TEXT NOT NULL CHECK (action_category IN ('model_generation', 'tool_call', 'waiting_upstream')),
      tool_dispatch_phase TEXT CHECK (tool_dispatch_phase IS NULL OR tool_dispatch_phase IN ('not_started', 'dispatched', 'finished')),
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      cancellation_reason TEXT,
      terminal_error_code TEXT,
      dead_lettered_at TEXT,
      next_retry_at TEXT
    ) STRICT;
    CREATE TABLE agent_execution_attempts (
      execution_id TEXT NOT NULL REFERENCES agent_executions(id),
      attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      action_category TEXT NOT NULL CHECK (action_category IN ('model_generation', 'tool_call', 'waiting_upstream')),
      finished_at TEXT,
      error_code TEXT,
      next_retry_at TEXT,
      PRIMARY KEY (execution_id, attempt_seq)
    ) STRICT;
    CREATE TABLE agent_execution_grants (
      grant_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      attempt_seq INTEGER NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      tool_id TEXT NOT NULL,
      parameter_sha256 TEXT NOT NULL,
      consumed_at TEXT,
      grant_state TEXT NOT NULL CHECK (grant_state IN ('active', 'claimed', 'revoked', 'expired')),
      grant_reason TEXT,
      grant_revision INTEGER NOT NULL DEFAULT 0 CHECK (grant_revision >= 0),
      grant_changed_at TEXT,
      FOREIGN KEY (execution_id, attempt_seq)
        REFERENCES agent_execution_attempts(execution_id, attempt_seq)
    ) STRICT;
    CREATE TABLE tool_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      attempt_seq INTEGER NOT NULL,
      tool_id TEXT NOT NULL,
      parameter_sha256 TEXT NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      human_principal_id TEXT NOT NULL,
      session_family_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      confirmation_state TEXT NOT NULL CHECK (confirmation_state IN ('pending', 'confirmed', 'rejected', 'expired')),
      confirmation_reason TEXT,
      confirmation_revision INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_revision >= 0),
      confirmation_changed_at TEXT,
      FOREIGN KEY (execution_id, attempt_seq)
        REFERENCES agent_execution_attempts(execution_id, attempt_seq)
    ) STRICT;
    CREATE TABLE tool_dispatches (
      dispatch_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      attempt_seq INTEGER NOT NULL,
      grant_id TEXT NOT NULL UNIQUE REFERENCES agent_execution_grants(grant_id),
      state TEXT NOT NULL CHECK (state IN ('claimed', 'dispatched', 'succeeded', 'failed', 'outcome_unknown', 'reviewed')),
      FOREIGN KEY (execution_id, attempt_seq)
        REFERENCES agent_execution_attempts(execution_id, attempt_seq)
    ) STRICT;
    CREATE TABLE tool_archive_settlements (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
      settled_at TEXT NOT NULL,
      rejected_pending_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_pending_count >= 0),
      revoked_grant_count INTEGER NOT NULL DEFAULT 0 CHECK (revoked_grant_count >= 0),
      fenced_waiting_count INTEGER NOT NULL DEFAULT 0 CHECK (fenced_waiting_count >= 0),
      preserved_dispatched_count INTEGER NOT NULL DEFAULT 0 CHECK (preserved_dispatched_count >= 0),
      PRIMARY KEY (room_id, archive_generation)
    ) STRICT;
    CREATE TABLE tool_archive_settlement_members (
      room_id TEXT NOT NULL,
      archive_generation INTEGER NOT NULL,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('confirmation', 'grant', 'execution', 'dispatch')),
      subject_id TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN (
        'rejected_pending', 'revoked_unclaimed', 'fenced_waiting', 'preserved_dispatched'
      )),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (room_id, archive_generation, subject_kind, subject_id),
      FOREIGN KEY (room_id, archive_generation)
        REFERENCES tool_archive_settlements(room_id, archive_generation)
    ) STRICT;
  `);
  return database;
}

function seedRoom(database: DatabaseSync, roomId = "room-1", generation = 3): void {
  database.prepare(
    `INSERT INTO rooms (id, status, archive_generation, archived_at)
     VALUES (?, 'archived', ?, ?)`,
  ).run(roomId, generation, NOW);
}

function insertToolWork(database: DatabaseSync, input: Readonly<{
  id: string;
  roomId?: string;
  executionStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
  attemptStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
  actionCategory?: "model_generation" | "tool_call" | "waiting_upstream";
  dispatchPhase?: null | "not_started" | "dispatched" | "finished";
  confirmationState?: "pending" | "confirmed" | "rejected" | "expired";
  grantState?: "active" | "claimed" | "revoked" | "expired";
  dispatchState?: "claimed" | "dispatched" | "succeeded" | "failed" | "outcome_unknown" | "reviewed";
}>): void {
  const roomId = input.roomId ?? "room-1";
  const actionCategory = input.actionCategory ?? "waiting_upstream";
  const executionStatus = input.executionStatus ?? "running";
  const attemptStatus = input.attemptStatus ?? "running";
  const confirmationState = input.confirmationState ?? "pending";
  const grantState = input.grantState ?? "active";
  const parameterSha256 = "c".repeat(64);
  const consumedAt = grantState === "claimed" ? NOW : null;
  database.prepare(
    `INSERT INTO agent_executions (
       id, room_id, status, current_attempt_seq, action_category, tool_dispatch_phase,
       updated_at, completed_at, cancellation_reason, terminal_error_code
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `execution-${input.id}`,
    roomId,
    executionStatus,
    actionCategory,
    input.dispatchPhase ?? (actionCategory === "tool_call" ? "not_started" : null),
    NOW,
    ["completed", "failed", "cancelled"].includes(executionStatus) ? NOW : null,
    executionStatus === "cancelled" ? "already_cancelled" : null,
    executionStatus === "failed" ? "already_failed" : null,
  );
  database.prepare(
    `INSERT INTO agent_execution_attempts (
       execution_id, attempt_seq, status, action_category, finished_at, error_code
     ) VALUES (?, 1, ?, ?, ?, ?)`,
  ).run(
    `execution-${input.id}`,
    attemptStatus,
    actionCategory,
    ["completed", "failed", "cancelled"].includes(attemptStatus) ? NOW : null,
    attemptStatus === "failed" ? "already_failed" : null,
  );
  database.prepare(
    `INSERT INTO agent_execution_grants (
       grant_id, execution_id, attempt_seq, room_id, tool_id, parameter_sha256,
       consumed_at, grant_state, grant_changed_at
     ) VALUES (?, ?, 1, ?, 'sandbox-file.write', ?, ?, ?, ?)`,
  ).run(
    `grant-${input.id}`,
    `execution-${input.id}`,
    roomId,
    parameterSha256,
    consumedAt,
    grantState,
    NOW,
  );
  database.prepare(
    `INSERT INTO tool_confirmations (
       confirmation_id, execution_id, attempt_seq, tool_id, parameter_sha256,
       room_id, human_principal_id, session_family_id, expires_at, consumed_at,
       confirmation_state, confirmation_changed_at
     ) VALUES (?, ?, 1, 'sandbox-file.write', ?, ?, 'human-1', 'family-1',
       '2099-08-19T00:00:00.000Z', ?, ?, ?)`,
  ).run(
    `confirmation-${input.id}`,
    `execution-${input.id}`,
    parameterSha256,
    roomId,
    consumedAt,
    confirmationState,
    NOW,
  );
  if (input.dispatchState !== undefined) {
    database.prepare(
      `INSERT INTO tool_dispatches (
         dispatch_id, execution_id, attempt_seq, grant_id, state
       ) VALUES (?, ?, 1, ?, ?)`,
    ).run(
      `dispatch-${input.id}`,
      `execution-${input.id}`,
      `grant-${input.id}`,
      input.dispatchState,
    );
  }
}

function withTransaction<TResult>(
  database: DatabaseSync,
  roomId: string,
  operation: (transaction: AuthorityTransactionView) => TResult,
): TResult {
  database.exec("BEGIN IMMEDIATE");
  const transaction = mintDatabaseAuthorityTransactionView(database, roomId, `tx-${roomId}`);
  try {
    const result = operation(transaction);
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    releaseDatabaseAuthorityTransactionView(transaction);
  }
}

function settle(database: DatabaseSync, roomId = "room-1", generation = 3): ArchiveSettlementResult {
  const envelope = withTransaction(database, roomId, (transaction) =>
    createArchiveToolSafetyParticipant().settleUndispatched(transaction, {
      roomId,
      archiveGeneration: generation,
      now: NOW,
    }));
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) throw new Error("expected archive tool settlement");
  return envelope.result;
}

describe("ArchiveToolSafetyParticipant production provider", () => {
  it("has the exact enabled production registration", () => {
    expect(archiveToolSafetyParticipantRegistration).toEqual({
      registrationId: "dao.tool-safety.archive-settlement.v1",
      feature: "archive-settlement",
      version: 1,
      enabled: true,
      participant: expect.objectContaining({ settleUndispatched: expect.any(Function) }),
    });
    expect(Object.keys(archiveToolSafetyParticipantRegistration.participant ?? {}))
      .toEqual(["settleUndispatched"]);
  });

  it("rejects pending, revokes active, fences waiting, preserves every dispatch truth, and calls no adapter", () => {
    const database = createDatabase();
    seedRoom(database);
    insertToolWork(database, { id: "pending" });
    insertToolWork(database, {
      id: "confirmed-unclaimed", confirmationState: "confirmed", actionCategory: "tool_call",
    });
    insertToolWork(database, {
      id: "dispatched", confirmationState: "confirmed", grantState: "claimed",
      actionCategory: "tool_call", dispatchPhase: "dispatched", dispatchState: "dispatched",
    });
    insertToolWork(database, {
      id: "unknown", confirmationState: "confirmed", grantState: "claimed",
      executionStatus: "failed", attemptStatus: "failed", actionCategory: "tool_call",
      dispatchPhase: "finished", dispatchState: "outcome_unknown",
    });
    insertToolWork(database, {
      id: "succeeded", confirmationState: "confirmed", grantState: "claimed",
      executionStatus: "completed", attemptStatus: "completed", actionCategory: "tool_call",
      dispatchPhase: "finished", dispatchState: "succeeded",
    });
    insertToolWork(database, {
      id: "review", confirmationState: "confirmed", grantState: "claimed",
      executionStatus: "failed", attemptStatus: "failed", actionCategory: "tool_call",
      dispatchPhase: "finished", dispatchState: "reviewed",
    });
    const adapter = vi.fn();
    try {
      const result = settle(database);
      expect(result).toEqual({
        roomId: "room-1",
        archiveGeneration: 3,
        rejectedPendingCount: 1,
        revokedGrantCount: 2,
        fencedWaitingCount: 2,
        preservedDispatchedCount: 4,
      });
      expect(adapter).not.toHaveBeenCalled();
      expect(database.prepare(
        `SELECT confirmation_state AS state, confirmation_reason AS reason
         FROM tool_confirmations WHERE confirmation_id = 'confirmation-pending'`,
      ).get()).toEqual({ state: "rejected", reason: "room_archived" });
      expect(database.prepare(
        `SELECT grant_state AS state, grant_reason AS reason
         FROM agent_execution_grants WHERE grant_id = 'grant-confirmed-unclaimed'`,
      ).get()).toEqual({ state: "revoked", reason: "room_archived" });
      expect(database.prepare(
        `SELECT status, cancellation_reason AS reason
         FROM agent_executions WHERE id = 'execution-pending'`,
      ).get()).toEqual({ status: "cancelled", reason: "room_archived" });
      expect(database.prepare(
        "SELECT state FROM tool_dispatches WHERE dispatch_id = 'dispatch-dispatched'",
      ).get()).toEqual({ state: "dispatched" });
      expect(database.prepare(
        "SELECT state FROM tool_dispatches WHERE dispatch_id = 'dispatch-unknown'",
      ).get()).toEqual({ state: "outcome_unknown" });
      expect(database.prepare(
        "SELECT state FROM tool_dispatches WHERE dispatch_id = 'dispatch-review'",
      ).get()).toEqual({ state: "reviewed" });
      expect(database.prepare(
        "SELECT state FROM tool_dispatches WHERE dispatch_id = 'dispatch-succeeded'",
      ).get()).toEqual({ state: "succeeded" });
    } finally {
      database.close();
    }
  });

  it("commits on the same writer, is invisible before commit, and replays the durable ledger after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-tool-settlement-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "authority.sqlite");
    const database = createDatabase(path);
    const observer = new DatabaseSync(path);
    seedRoom(database);
    insertToolWork(database, { id: "pending" });
    database.exec("BEGIN IMMEDIATE");
    const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-1");
    try {
      const envelope = createArchiveToolSafetyParticipant().settleUndispatched(transaction, {
        roomId: "room-1", archiveGeneration: 3, now: NOW,
      });
      expect(envelope).toMatchObject({ ok: true, result: { rejectedPendingCount: 1 } });
      expect(observer.prepare("SELECT COUNT(*) AS count FROM tool_archive_settlements").get())
        .toEqual({ count: 0 });
      releaseDatabaseAuthorityTransactionView(transaction);
      database.exec("COMMIT");
    } finally {
      releaseDatabaseAuthorityTransactionView(transaction);
      observer.close();
      database.close();
    }
    const restarted = new DatabaseSync(path);
    try {
      expect(settle(restarted)).toEqual({
        roomId: "room-1",
        archiveGeneration: 3,
        rejectedPendingCount: 1,
        revokedGrantCount: 1,
        fencedWaitingCount: 1,
        preservedDispatchedCount: 0,
      });
      expect(restarted.prepare("SELECT COUNT(*) AS count FROM tool_archive_settlement_members").get())
        .toEqual({ count: 3 });
    } finally {
      restarted.close();
    }
  });

  it("rolls all settlement facts back with the surrounding authority transaction", () => {
    const database = createDatabase();
    seedRoom(database);
    insertToolWork(database, { id: "pending" });
    database.exec("BEGIN IMMEDIATE");
    const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-rollback");
    try {
      const envelope = createArchiveToolSafetyParticipant().settleUndispatched(transaction, {
        roomId: "room-1", archiveGeneration: 3, now: NOW,
      });
      expect(envelope.ok).toBe(true);
      releaseDatabaseAuthorityTransactionView(transaction);
      database.exec("ROLLBACK");
    } finally {
      releaseDatabaseAuthorityTransactionView(transaction);
    }
    try {
      expect(database.prepare(
        "SELECT confirmation_state AS state FROM tool_confirmations WHERE confirmation_id = 'confirmation-pending'",
      ).get()).toEqual({ state: "pending" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM tool_archive_settlements").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("preserves a closed prior-attempt confirmation and grant while settling the current attempt", () => {
    const database = createDatabase();
    seedRoom(database);
    insertToolWork(database, {
      id: "prior-closed",
      confirmationState: "rejected",
      grantState: "revoked",
      attemptStatus: "cancelled",
    });
    database.prepare(
      `INSERT INTO agent_execution_attempts (
         execution_id, attempt_seq, status, action_category
       ) VALUES ('execution-prior-closed', 2, 'running', 'waiting_upstream')`,
    ).run();
    database.prepare(
      `UPDATE agent_executions
       SET current_attempt_seq = 2
       WHERE id = 'execution-prior-closed'`,
    ).run();
    try {
      expect(settle(database)).toEqual({
        roomId: "room-1",
        archiveGeneration: 3,
        rejectedPendingCount: 0,
        revokedGrantCount: 0,
        fencedWaitingCount: 1,
        preservedDispatchedCount: 0,
      });
      expect(database.prepare(
        `SELECT confirmation_state AS state, consumed_at AS consumedAt,
                confirmation_revision AS revision
         FROM tool_confirmations
         WHERE confirmation_id = 'confirmation-prior-closed'`,
      ).get()).toEqual({ state: "rejected", consumedAt: null, revision: 0 });
      expect(database.prepare(
        `SELECT grant_state AS state, consumed_at AS consumedAt,
                grant_revision AS revision
         FROM agent_execution_grants
         WHERE grant_id = 'grant-prior-closed'`,
      ).get()).toEqual({ state: "revoked", consumedAt: null, revision: 0 });
      expect(database.prepare(
        `SELECT status, cancellation_reason AS reason, current_attempt_seq AS attemptSeq
         FROM agent_executions
         WHERE id = 'execution-prior-closed'`,
      ).get()).toEqual({ status: "cancelled", reason: "room_archived", attemptSeq: 2 });
    } finally {
      database.close();
    }
  });

  it("still fails closed when a pending confirmation targets a non-current attempt", () => {
    const database = createDatabase();
    seedRoom(database);
    insertToolWork(database, { id: "stale-pending" });
    database.prepare(
      `INSERT INTO agent_execution_attempts (
         execution_id, attempt_seq, status, action_category
       ) VALUES ('execution-stale-pending', 2, 'running', 'waiting_upstream')`,
    ).run();
    database.prepare(
      `UPDATE agent_executions
       SET current_attempt_seq = 2
       WHERE id = 'execution-stale-pending'`,
    ).run();
    try {
      const envelope = withTransaction(database, "room-1", (transaction) =>
        createArchiveToolSafetyParticipant().settleUndispatched(transaction, {
          roomId: "room-1",
          archiveGeneration: 3,
          now: NOW,
        }));
      expect(envelope).toMatchObject({
        ok: false,
        error: { dependency: "archive-settlement", reason: "participant_threw" },
      });
      expect(database.prepare(
        `SELECT confirmation_state AS state
         FROM tool_confirmations
         WHERE confirmation_id = 'confirmation-stale-pending'`,
      ).get()).toEqual({ state: "pending" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM tool_archive_settlements").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("linearizes both archive-before-claim and claim-before-archive with adapter zero-call on rejection", () => {
    const archiveFirst = createDatabase();
    seedRoom(archiveFirst);
    insertToolWork(archiveFirst, { id: "race" });
    const adapter = vi.fn();
    try {
      settle(archiveFirst);
      const claimed = archiveFirst.prepare(
        `UPDATE agent_execution_grants
         SET grant_state = 'claimed', consumed_at = ?
         WHERE grant_id = 'grant-race' AND grant_state = 'active' AND consumed_at IS NULL`,
      ).run(NOW);
      if (claimed.changes === 1) adapter();
      expect(claimed.changes).toBe(0);
      expect(adapter).not.toHaveBeenCalled();
    } finally {
      archiveFirst.close();
    }

    const claimFirst = createDatabase();
    seedRoom(claimFirst);
    insertToolWork(claimFirst, { id: "race", confirmationState: "confirmed" });
    try {
      withTransaction(claimFirst, "room-1", () => {
        expect(claimFirst.prepare(
          `UPDATE agent_execution_grants
           SET grant_state = 'claimed', consumed_at = ?
           WHERE grant_id = 'grant-race' AND grant_state = 'active' AND consumed_at IS NULL`,
        ).run(NOW).changes).toBe(1);
        claimFirst.prepare(
          `UPDATE tool_confirmations SET consumed_at = ?
           WHERE confirmation_id = 'confirmation-race' AND consumed_at IS NULL`,
        ).run(NOW);
        claimFirst.prepare(
          `INSERT INTO tool_dispatches (dispatch_id, execution_id, attempt_seq, grant_id, state)
           VALUES ('dispatch-race', 'execution-race', 1, 'grant-race', 'claimed')`,
        ).run();
      });
      expect(settle(claimFirst)).toMatchObject({
        rejectedPendingCount: 0,
        revokedGrantCount: 0,
        fencedWaitingCount: 0,
        preservedDispatchedCount: 1,
      });
      expect(claimFirst.prepare(
        "SELECT state FROM tool_dispatches WHERE dispatch_id = 'dispatch-race'",
      ).get()).toEqual({ state: "claimed" });
    } finally {
      claimFirst.close();
    }
  });

  it("fails closed for invalid capability, cross-room input, stale generation, and malformed facts", () => {
    const database = createDatabase();
    seedRoom(database);
    seedRoom(database, "room-2", 1);
    insertToolWork(database, { id: "malformed" });
    database.prepare(
      "UPDATE agent_execution_grants SET parameter_sha256 = ? WHERE grant_id = 'grant-malformed'",
    ).run("d".repeat(64));
    const participant = createArchiveToolSafetyParticipant();
    try {
      expect(participant.settleUndispatched(
        mintAuthorityTransactionView("room-1", "forged"),
        { roomId: "room-1", archiveGeneration: 3, now: NOW },
      )).toMatchObject({ ok: false, error: { reason: "participant_threw" } });
      expect(withTransaction(database, "room-1", (transaction) =>
        participant.settleUndispatched(transaction, {
          roomId: "room-2", archiveGeneration: 1, now: NOW,
        }))).toMatchObject({ ok: false, error: { reason: "transaction_mismatch" } });
      expect(withTransaction(database, "room-1", (transaction) =>
        participant.settleUndispatched(transaction, {
          roomId: "room-1", archiveGeneration: 2, now: NOW,
        }))).toMatchObject({ ok: false, error: { reason: "transaction_mismatch" } });
      expect(withTransaction(database, "room-1", (transaction) =>
        participant.settleUndispatched(transaction, {
          roomId: "room-1", archiveGeneration: 3, now: NOW,
        }))).toMatchObject({ ok: false, error: { reason: "participant_threw" } });
      expect(database.prepare("SELECT COUNT(*) AS count FROM tool_archive_settlements").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
