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
  type ArchivedMessageGateResult,
  type AuthorityTransactionView,
} from "../room-governance/private-participant-contracts.js";
import {
  ArchivedMessageMutationBlockedError,
  archivedMessageGateRegistration,
  createArchivedMessageGate,
  requireMessageMutationAllowedInTransaction,
} from "./archived-message-gate.js";

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
    CREATE TABLE room_message_archive_gates (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id),
      gate_generation INTEGER NOT NULL CHECK (gate_generation > 0),
      blocked_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE business_message_mutations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('message', 'message_intent'))
    ) STRICT;
  `);
  return database;
}

function insertRoom(
  database: DatabaseSync,
  roomId: string,
  status: "active" | "archived" = "active",
  archiveGeneration = status === "archived" ? 1 : 0,
): void {
  database.prepare(
    `INSERT INTO rooms (id, status, archive_generation, archived_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    roomId,
    status,
    archiveGeneration,
    status === "archived" ? "2026-08-19T00:00:00.000Z" : null,
  );
}

function withTransaction<TResult>(
  database: DatabaseSync,
  roomId: string,
  operation: (transaction: AuthorityTransactionView) => TResult,
): TResult {
  database.exec("BEGIN IMMEDIATE");
  const transaction = mintDatabaseAuthorityTransactionView(
    database,
    roomId,
    `transaction-${roomId}`,
  );
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

function blockForArchive(
  database: DatabaseSync,
  roomId: string,
  archiveGeneration: number,
): ArchivedMessageGateResult {
  return withTransaction(database, roomId, (transaction) => {
    const result = createArchivedMessageGate().blockForArchive(transaction, {
      roomId,
      archiveGeneration,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected archive gate success");
    return result.result;
  });
}

function expectBlocked(
  operation: () => unknown,
  reason: ArchivedMessageMutationBlockedError["reason"],
): void {
  try {
    operation();
    throw new Error("expected message mutation to be blocked");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ArchivedMessageMutationBlockedError);
    expect((error as ArchivedMessageMutationBlockedError).code).toBe(
      "message_mutation_blocked",
    );
    expect((error as ArchivedMessageMutationBlockedError).reason).toBe(reason);
    expect(Object.keys(error as object)).toEqual(["code", "reason"]);
  }
}

describe("ArchivedMessageGate production participant", () => {
  it("has the exact enabled production registration", () => {
    expect(archivedMessageGateRegistration).toEqual({
      registrationId: "dao.message-authority.archived-message-gate.v1",
      feature: "archived-message-gate",
      version: 1,
      enabled: true,
      participant: expect.objectContaining({
        blockForArchive: expect.any(Function),
      }),
    });
    expect(Object.keys(archivedMessageGateRegistration.participant ?? {})).toEqual([
      "blockForArchive",
    ]);
  });

  it("writes a non-empty durable generation on the bound writer and is idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-message-gate-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "authority.sqlite");
    const database = createDatabase(path);
    const observer = new DatabaseSync(path);
    try {
      insertRoom(database, "room-1", "archived", 4);
      database.exec("BEGIN IMMEDIATE");
      const transaction = mintDatabaseAuthorityTransactionView(
        database,
        "room-1",
        "transaction-1",
      );
      const envelope = createArchivedMessageGate().blockForArchive(transaction, {
        roomId: "room-1",
        archiveGeneration: 4,
      });
      expect(envelope).toEqual({
        ok: true,
        result: {
          roomId: "room-1",
          archiveGeneration: 4,
          gateGeneration: 4,
          blockedMutationKinds: ["message", "message_intent"],
        },
      });
      expect(database.prepare(
        "SELECT gate_generation AS gateGeneration FROM room_message_archive_gates",
      ).get()).toEqual({ gateGeneration: 4 });
      expect(observer.prepare(
        "SELECT COUNT(*) AS count FROM room_message_archive_gates",
      ).get()).toEqual({ count: 0 });
      releaseDatabaseAuthorityTransactionView(transaction);
      database.exec("COMMIT");
      expect(observer.prepare(
        "SELECT gate_generation AS gateGeneration FROM room_message_archive_gates",
      ).get()).toEqual({ gateGeneration: 4 });

      const firstBlockedAt = observer.prepare(
        "SELECT blocked_at AS blockedAt FROM room_message_archive_gates",
      ).get();
      expect(blockForArchive(database, "room-1", 4).gateGeneration).toBe(4);
      expect(observer.prepare(
        "SELECT blocked_at AS blockedAt FROM room_message_archive_gates",
      ).get()).toEqual(firstBlockedAt);
    } finally {
      observer.close();
      database.close();
    }
  });

  it("blocks both business message and message intent mutations after archive", () => {
    const database = createDatabase();
    try {
      insertRoom(database, "room-1", "archived", 1);
      database.prepare(
        `INSERT INTO business_message_mutations (id, room_id, mutation_kind)
         VALUES ('historical-message', 'room-1', 'message')`,
      ).run();
      blockForArchive(database, "room-1", 1);

      withTransaction(database, "room-1", (transaction) => {
        for (const mutationKind of ["message", "message_intent"] as const) {
          expectBlocked(() => {
            requireMessageMutationAllowedInTransaction(transaction, {
              roomId: "room-1",
              mutationKind,
              expectedArchiveGeneration: 1,
            });
            database.prepare(
              `INSERT INTO business_message_mutations (id, room_id, mutation_kind)
               VALUES (?, ?, ?)`,
            ).run(`new-${mutationKind}`, "room-1", mutationKind);
          }, "room_archived");
        }
      });
      expect(database.prepare(
        `SELECT id, mutation_kind AS mutationKind FROM business_message_mutations
         ORDER BY id`,
      ).all()).toEqual([{ id: "historical-message", mutationKind: "message" }]);
    } finally {
      database.close();
    }
  });

  it("allows both mutation kinds only for the current active generation", () => {
    const database = createDatabase();
    try {
      insertRoom(database, "room-1");
      withTransaction(database, "room-1", (transaction) => {
        expect(requireMessageMutationAllowedInTransaction(transaction, {
          roomId: "room-1",
          mutationKind: "message",
          expectedArchiveGeneration: 0,
        })).toEqual({ roomId: "room-1", mutationKind: "message", archiveGeneration: 0 });
        expect(requireMessageMutationAllowedInTransaction(transaction, {
          roomId: "room-1",
          mutationKind: "message_intent",
          expectedArchiveGeneration: 0,
        })).toEqual({
          roomId: "room-1",
          mutationKind: "message_intent",
          archiveGeneration: 0,
        });
      });
    } finally {
      database.close();
    }
  });

  it("fails closed for stale generations, cross-room capabilities, and unavailable storage", () => {
    const database = createDatabase();
    try {
      insertRoom(database, "room-1", "active", 2);
      withTransaction(database, "room-1", (transaction) => {
        expectBlocked(() => requireMessageMutationAllowedInTransaction(transaction, {
          roomId: "room-1",
          mutationKind: "message",
          expectedArchiveGeneration: 1,
        }), "generation_mismatch");
        expectBlocked(() => requireMessageMutationAllowedInTransaction(transaction, {
          roomId: "room-2",
          mutationKind: "message",
          expectedArchiveGeneration: 2,
        }), "transaction_mismatch");
      });

      const unbound = mintAuthorityTransactionView("room-1", "unbound");
      expectBlocked(() => requireMessageMutationAllowedInTransaction(unbound, {
        roomId: "room-1",
        mutationKind: "message",
        expectedArchiveGeneration: 2,
      }), "gate_unavailable");

      database.exec("DROP TABLE room_message_archive_gates");
      withTransaction(database, "room-1", (transaction) => {
        expectBlocked(() => requireMessageMutationAllowedInTransaction(transaction, {
          roomId: "room-1",
          mutationKind: "message_intent",
          expectedArchiveGeneration: 2,
        }), "gate_unavailable");
      });
    } finally {
      database.close();
    }
  });

  it("rejects stale archive input and never moves a durable gate backwards", () => {
    const database = createDatabase();
    try {
      insertRoom(database, "room-1", "archived", 3);
      expect(blockForArchive(database, "room-1", 3).gateGeneration).toBe(3);

      const result = withTransaction(database, "room-1", (transaction) =>
        createArchivedMessageGate().blockForArchive(transaction, {
          roomId: "room-1",
          archiveGeneration: 2,
        }));
      expect(result).toEqual({
        ok: false,
        error: {
          httpStatus: 503,
          code: "dependency_unavailable",
          dependency: "archived-message-gate",
          reason: "transaction_mismatch",
          retryable: true,
        },
      });
      expect(database.prepare(
        "SELECT gate_generation AS gateGeneration FROM room_message_archive_gates",
      ).get()).toEqual({ gateGeneration: 3 });
    } finally {
      database.close();
    }
  });

  it("survives provider reconstruction and does not leak a rolled-back gate", () => {
    const database = createDatabase();
    try {
      insertRoom(database, "room-1");
      database.exec("BEGIN IMMEDIATE");
      const transaction = mintDatabaseAuthorityTransactionView(
        database,
        "room-1",
        "transaction-rollback",
      );
      database.prepare(
        `UPDATE rooms SET status = 'archived', archive_generation = 1,
          archived_at = '2026-08-19T00:00:00.000Z' WHERE id = 'room-1'`,
      ).run();
      expect(createArchivedMessageGate().blockForArchive(transaction, {
        roomId: "room-1",
        archiveGeneration: 1,
      }).ok).toBe(true);
      releaseDatabaseAuthorityTransactionView(transaction);
      database.exec("ROLLBACK");

      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM room_message_archive_gates",
      ).get()).toEqual({ count: 0 });
      withTransaction(database, "room-1", (freshTransaction) => {
        expect(requireMessageMutationAllowedInTransaction(freshTransaction, {
          roomId: "room-1",
          mutationKind: "message",
          expectedArchiveGeneration: 0,
        })).toEqual({ roomId: "room-1", mutationKind: "message", archiveGeneration: 0 });
      });

      database.prepare(
        `UPDATE rooms SET status = 'archived', archive_generation = 1,
          archived_at = '2026-08-19T00:00:00.000Z' WHERE id = 'room-1'`,
      ).run();
      blockForArchive(database, "room-1", 1);
      withTransaction(database, "room-1", (freshTransaction) => {
        expectBlocked(() => requireMessageMutationAllowedInTransaction(freshTransaction, {
          roomId: "room-1",
          mutationKind: "message",
          expectedArchiveGeneration: 1,
        }), "room_archived");
      });
    } finally {
      database.close();
    }
  });
});
