import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import {
  mintAuthorityTransactionView,
  type AuthorityTransactionView,
} from "../room-governance/private-participant-contracts.js";
import {
  createPendingConfirmationDepartureContributor,
  pendingConfirmationDepartureContributorRegistration,
} from "./pending-confirmation-departure-contributor.js";

const temporaryDirectories: string[] = [];
const FUTURE = "2099-08-19T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

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
      archive_generation INTEGER NOT NULL DEFAULT 0 CHECK (archive_generation >= 0)
    ) STRICT;
    CREATE TABLE actors (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent'))
    ) STRICT;
    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      PRIMARY KEY (room_id, actor_id)
    ) STRICT;
    CREATE TABLE session_families (
      family_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL REFERENCES actors(id),
      refresh_expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    ) STRICT;
    CREATE TABLE agent_executions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      current_attempt_seq INTEGER NOT NULL CHECK (current_attempt_seq >= 1),
      action_category TEXT NOT NULL CHECK (action_category IN ('model_generation', 'tool_call', 'waiting_upstream'))
    ) STRICT;
    CREATE TABLE agent_execution_attempts (
      execution_id TEXT NOT NULL REFERENCES agent_executions(id),
      attempt_seq INTEGER NOT NULL CHECK (attempt_seq >= 1),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      action_category TEXT NOT NULL CHECK (action_category IN ('model_generation', 'tool_call', 'waiting_upstream')),
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
      human_principal_id TEXT NOT NULL REFERENCES actors(id),
      session_family_id TEXT NOT NULL REFERENCES session_families(family_id),
      expires_at TEXT NOT NULL,
      target TEXT NOT NULL,
      impact TEXT NOT NULL,
      consumed_at TEXT,
      confirmation_state TEXT NOT NULL CHECK (confirmation_state IN ('pending', 'confirmed', 'rejected', 'expired')),
      confirmation_reason TEXT,
      confirmation_revision INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_revision >= 0),
      confirmation_changed_at TEXT,
      FOREIGN KEY (execution_id, attempt_seq)
        REFERENCES agent_execution_attempts(execution_id, attempt_seq)
    ) STRICT;
  `);
  return database;
}

function seedAuthority(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO rooms (id, status) VALUES ('room-1', 'active'), ('room-2', 'active');
    INSERT INTO actors (id, kind) VALUES
      ('human-1', 'human'), ('human-2', 'human'), ('agent-1', 'agent');
    INSERT INTO room_memberships (room_id, actor_id, kind) VALUES
      ('room-1', 'human-1', 'human'), ('room-1', 'human-2', 'human'),
      ('room-1', 'agent-1', 'agent'), ('room-2', 'human-1', 'human'),
      ('room-2', 'agent-1', 'agent');
    INSERT INTO session_families (family_id, actor_id, refresh_expires_at)
    VALUES ('family-1', 'human-1', 4102444800000), ('family-2', 'human-2', 4102444800000);
  `);
}

function insertConfirmation(database: DatabaseSync, input: Readonly<{
  id: string;
  roomId?: string;
  principalId?: string;
  familyId?: string;
  expiresAt?: string;
  confirmationState?: "pending" | "confirmed" | "rejected" | "expired";
  grantState?: "active" | "claimed" | "revoked" | "expired";
  executionStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
  attemptStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
  actionCategory?: "model_generation" | "tool_call" | "waiting_upstream";
  consumed?: boolean;
  target?: string;
  impact?: string;
}>): void {
  const roomId = input.roomId ?? "room-1";
  const principalId = input.principalId ?? "human-1";
  const familyId = input.familyId ?? "family-1";
  const executionStatus = input.executionStatus ?? "running";
  const attemptStatus = input.attemptStatus ?? "running";
  const actionCategory = input.actionCategory ?? "waiting_upstream";
  const confirmationState = input.confirmationState ?? "pending";
  const grantState = input.grantState ?? "active";
  const consumedAt = input.consumed === true ? "2026-08-19T00:00:00.000Z" : null;
  const executionId = `execution-${input.id}`;
  const parameterSha256 = "a".repeat(64);
  database.prepare(
    `INSERT INTO agent_executions (
       id, room_id, status, current_attempt_seq, action_category
     ) VALUES (?, ?, ?, 1, ?)`,
  ).run(executionId, roomId, executionStatus, actionCategory);
  database.prepare(
    `INSERT INTO agent_execution_attempts (
       execution_id, attempt_seq, status, action_category
     ) VALUES (?, 1, ?, ?)`,
  ).run(executionId, attemptStatus, actionCategory);
  database.prepare(
    `INSERT INTO agent_execution_grants (
       grant_id, execution_id, attempt_seq, room_id, tool_id, parameter_sha256,
       consumed_at, grant_state, grant_changed_at
     ) VALUES (?, ?, 1, ?, 'sandbox-file.write', ?, ?, ?, '2026-08-19T00:00:00.000Z')`,
  ).run(`grant-${input.id}`, executionId, roomId, parameterSha256, consumedAt, grantState);
  database.prepare(
    `INSERT INTO tool_confirmations (
       confirmation_id, execution_id, attempt_seq, tool_id, parameter_sha256,
       room_id, human_principal_id, session_family_id, expires_at, target, impact,
       consumed_at, confirmation_state, confirmation_changed_at
     ) VALUES (?, ?, 1, 'sandbox-file.write', ?, ?, ?, ?, ?, ?, ?, ?, ?,
       '2026-08-19T00:00:00.000Z')`,
  ).run(
    input.id,
    executionId,
    parameterSha256,
    roomId,
    principalId,
    familyId,
    input.expiresAt ?? FUTURE,
    input.target ?? "safe target",
    input.impact ?? "bounded impact",
    consumedAt,
    confirmationState,
  );
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

describe("PendingConfirmationDepartureContributor production provider", () => {
  it("has the exact enabled production registration", () => {
    expect(pendingConfirmationDepartureContributorRegistration).toEqual({
      registrationId: "dao.tool-safety.pending-confirmation-departure.v1",
      feature: "pending-confirmation-departure",
      version: 1,
      enabled: true,
      participant: expect.objectContaining({
        listPendingConfirmationsInTransaction: expect.any(Function),
      }),
    });
    expect(Object.keys(pendingConfirmationDepartureContributorRegistration.participant ?? {}))
      .toEqual(["listPendingConfirmationsInTransaction"]);
  });

  it("reads an uncommitted non-empty confirmation from the bound writer and survives restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-pending-departure-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "authority.sqlite");
    const database = createDatabase(path);
    const observer = new DatabaseSync(path);
    seedAuthority(database);
    database.exec("BEGIN IMMEDIATE");
    const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-1");
    try {
      insertConfirmation(database, { id: "confirmation-current" });
      const envelope = createPendingConfirmationDepartureContributor()
        .listPendingConfirmationsInTransaction(transaction, {
          roomId: "room-1",
          targetHumanActorId: "human-1",
        });
      expect(envelope.ok).toBe(true);
      if (!envelope.ok) throw new Error("expected pending confirmation contribution");
      expect(envelope.result.conflicts).toHaveLength(1);
      expect(observer.prepare("SELECT COUNT(*) AS count FROM tool_confirmations").get())
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
      const result = withTransaction(restarted, "room-1", (nextTransaction) =>
        createPendingConfirmationDepartureContributor()
          .listPendingConfirmationsInTransaction(nextTransaction, {
            roomId: "room-1",
            targetHumanActorId: "human-1",
          }));
      expect(result).toMatchObject({ ok: true, result: { conflicts: [{ state: "pending" }] } });
    } finally {
      restarted.close();
    }
  });

  it("requires every approved binding and excludes expired, claimed, rejected, other-principal, and terminal facts", () => {
    const database = createDatabase();
    seedAuthority(database);
    insertConfirmation(database, { id: "current" });
    insertConfirmation(database, { id: "expired", expiresAt: PAST });
    insertConfirmation(database, { id: "expired-state", confirmationState: "expired" });
    insertConfirmation(database, { id: "rejected", confirmationState: "rejected" });
    insertConfirmation(database, { id: "revoked-grant", grantState: "revoked" });
    insertConfirmation(database, { id: "expired-grant", grantState: "expired" });
    insertConfirmation(database, {
      id: "claimed", confirmationState: "confirmed", grantState: "claimed", consumed: true,
    });
    insertConfirmation(database, {
      id: "terminal", executionStatus: "cancelled", attemptStatus: "cancelled",
    });
    insertConfirmation(database, { id: "other-principal", principalId: "human-2", familyId: "family-2" });
    insertConfirmation(database, { id: "other-room", roomId: "room-2" });
    try {
      const changesBefore = database.prepare("SELECT total_changes() AS count").get();
      const envelope = withTransaction(database, "room-1", (transaction) =>
        createPendingConfirmationDepartureContributor()
          .listPendingConfirmationsInTransaction(transaction, {
            roomId: "room-1",
            targetHumanActorId: "human-1",
          }));
      expect(envelope).toEqual({
        ok: true,
        result: {
          roomId: "room-1",
          targetHumanActorId: "human-1",
          conflicts: [{
            conflictId: expect.stringMatching(/^ft10-confirmation-[0-9a-f]{32}$/),
            roomId: "room-1",
            subjectId: "current",
            kind: "confirmation",
            title: "Pending tool confirmation",
            state: "pending",
            allowedResolutions: ["transfer", "escalate", "reject_or_revoke"],
            sourceId: "current",
            revision: 0,
          }],
        },
      });
      expect(database.prepare("SELECT total_changes() AS count").get()).toEqual(changesBefore);
    } finally {
      database.close();
    }
  });

  it("returns closed failures for invalid capability, cross-room input, and malformed binding without writes", () => {
    const database = createDatabase();
    seedAuthority(database);
    insertConfirmation(database, { id: "malformed" });
    database.prepare(
      "UPDATE agent_execution_grants SET parameter_sha256 = ? WHERE grant_id = 'grant-malformed'",
    ).run("b".repeat(64));
    const participant = createPendingConfirmationDepartureContributor();
    try {
      const invalid = participant.listPendingConfirmationsInTransaction(
        mintAuthorityTransactionView("room-1", "forged-tx"),
        { roomId: "room-1", targetHumanActorId: "human-1" },
      );
      expect(invalid).toMatchObject({
        ok: false,
        error: { dependency: "pending-confirmation-departure", reason: "participant_threw" },
      });

      const crossRoom = withTransaction(database, "room-1", (transaction) =>
        participant.listPendingConfirmationsInTransaction(transaction, {
          roomId: "room-2",
          targetHumanActorId: "human-1",
        }));
      expect(crossRoom).toMatchObject({
        ok: false,
        error: { reason: "transaction_mismatch" },
      });

      const malformed = withTransaction(database, "room-1", (transaction) =>
        participant.listPendingConfirmationsInTransaction(transaction, {
          roomId: "room-1",
          targetHumanActorId: "human-1",
        }));
      expect(malformed).toMatchObject({
        ok: false,
        error: { reason: "participant_threw" },
      });
      expect(database.prepare(
        "SELECT confirmation_state AS state FROM tool_confirmations WHERE confirmation_id = 'malformed'",
      ).get()).toEqual({ state: "pending" });
    } finally {
      database.close();
    }
  });

  it("emits a closed conflict that never includes params, session family, target, impact, or canaries", () => {
    const database = createDatabase();
    seedAuthority(database);
    const canary = "SECRET_PARAMS_SESSION_FAMILY_AND_BODY_CANARY";
    insertConfirmation(database, { id: "safe-conflict", target: canary, impact: canary });
    try {
      const envelope = withTransaction(database, "room-1", (transaction) =>
        createPendingConfirmationDepartureContributor()
          .listPendingConfirmationsInTransaction(transaction, {
            roomId: "room-1",
            targetHumanActorId: "human-1",
          }));
      expect(envelope.ok).toBe(true);
      expect(JSON.stringify(envelope)).not.toContain(canary);
      expect(JSON.stringify(envelope)).not.toContain("family-1");
      expect(JSON.stringify(envelope)).not.toContain("parameterSha256");
      if (envelope.ok) {
        expect(Object.keys(envelope.result.conflicts[0] ?? {}).sort()).toEqual([
          "allowedResolutions", "conflictId", "kind", "revision", "roomId", "sourceId",
          "state", "subjectId", "title",
        ]);
      }
    } finally {
      database.close();
    }
  });
});
