import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { mintAuthorityTransactionView } from "../room-governance/private-participant-contracts.js";
import { runAuthorityParticipantImmediateTransaction } from "./authority-database-handler.js";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
  useAuthorityTransactionDatabase,
  withDatabaseAuthorityTransactionView,
} from "./authority-transaction-database.js";
import { migrateAuthorityDatabase } from "./schema.js";

function seedOwnedRoom(database: DatabaseSync): void {
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name)
    VALUES ('owner-1', 'human', 'Owner');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'owner-1', 0, 1), ('room', 'room-1', 0, 1);
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-1', 'Room', 'active', '2026-08-19T00:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES (
      'room-1', 'owner-1', 'human', 'member', NULL, '[]',
      '2026-08-19T00:00:00.000Z', NULL, 0
    );
    UPDATE rooms SET owner_actor_id = 'owner-1' WHERE id = 'room-1';
  `);
}

describe("Authority transaction database capability", () => {
  it("runs feature-local SQL on the bound worker transaction connection", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE proof (value TEXT NOT NULL); BEGIN IMMEDIATE");
      const transaction = mintDatabaseAuthorityTransactionView(
        database,
        "room-1",
        "transaction-1",
      );
      useAuthorityTransactionDatabase(transaction, (boundDatabase) => {
        expect(boundDatabase).toBe(database);
        boundDatabase.prepare("INSERT INTO proof (value) VALUES (?)").run("same-writer");
      });
      releaseDatabaseAuthorityTransactionView(transaction);
      database.exec("COMMIT");
      expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value: "same-writer" });
      expect(() => useAuthorityTransactionDatabase(transaction, () => undefined)).toThrow(
        "database capability is unavailable",
      );
    } finally {
      database.close();
    }
  });

  it("rejects an unbound or reconstructed transaction view", () => {
    const unbound = mintAuthorityTransactionView("room-1", "transaction-1");
    expect(() => useAuthorityTransactionDatabase(unbound, () => undefined)).toThrow(
      "database capability is unavailable",
    );
    expect(() => useAuthorityTransactionDatabase(
      JSON.parse(JSON.stringify(unbound)),
      () => undefined,
    )).toThrow("transaction capability is invalid");
  });

  it("revokes the scoped database binding when participant work throws", () => {
    const database = new DatabaseSync(":memory:");
    let captured: ReturnType<typeof mintDatabaseAuthorityTransactionView> | undefined;
    try {
      expect(() => withDatabaseAuthorityTransactionView(
        database,
        "room-1",
        "transaction-throw",
        (transaction) => {
          captured = transaction;
          throw new Error("participant failed");
        },
      )).toThrow("participant failed");
      expect(captured).toBeDefined();
      expect(() => useAuthorityTransactionDatabase(captured!, () => undefined)).toThrow(
        "database capability is unavailable",
      );
    } finally {
      database.close();
    }
  });

  it("hosts participant SQL in the Authority BEGIN IMMEDIATE commit and rollback boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-authority-participant-host-"));
    const database = new DatabaseSync(join(directory, "authority.sqlite"));
    try {
      seedOwnedRoom(database);
      database.exec("CREATE TABLE participant_proof (value TEXT NOT NULL) STRICT");
      runAuthorityParticipantImmediateTransaction(
        database,
        "room-1",
        "participant-commit",
        (transaction) => useAuthorityTransactionDatabase(transaction, (boundDatabase) => {
          boundDatabase.prepare("INSERT INTO participant_proof (value) VALUES (?)").run("commit");
        }),
      );
      expect(database.prepare("SELECT value FROM participant_proof").all()).toEqual([
        { value: "commit" },
      ]);

      expect(() => runAuthorityParticipantImmediateTransaction(
        database,
        "room-1",
        "participant-rollback",
        (transaction) => useAuthorityTransactionDatabase(transaction, (boundDatabase) => {
          boundDatabase.prepare("INSERT INTO participant_proof (value) VALUES (?)").run("rollback");
          throw new Error("rollback participant");
        }),
      )).toThrow("rollback participant");
      expect(database.prepare("SELECT value FROM participant_proof").all()).toEqual([
        { value: "commit" },
      ]);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
