import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import { isParticipantRegistration } from "../room-governance/private-participant-contracts.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  createWorkerDatabaseClient,
  createWorkerRoomCacheInvalidationIntentAuthority,
} from "../persistence/worker-database-client.js";
import {
  ROOM_ACCESS_AUTHORITY_SCHEMA_STATEMENTS,
  ROOM_CACHE_INVALIDATION_SCHEMA_STATEMENTS,
  RoomCacheInvalidationPostCommitDispatcher,
  roomCacheInvalidationRegistration,
  type CommittedRoomCacheInvalidationIntent,
  type RoomCacheInvalidationIntentAuthority,
} from "./room-cache-invalidation-port.js";

function createDatabase(path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE rooms (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      actor_id TEXT NOT NULL,
      access_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, actor_id)
    ) STRICT;
    INSERT INTO rooms VALUES ('room-1');
    INSERT INTO room_memberships VALUES ('room-1', 'human-1', 0);
    ${ROOM_ACCESS_AUTHORITY_SCHEMA_STATEMENTS.join(";\n")};
    ${ROOM_CACHE_INVALIDATION_SCHEMA_STATEMENTS.join(";\n")};
  `);
  return database;
}

describe("room cache invalidation production port", () => {
  it("exports the exact enabled production registration", () => {
    expect(isParticipantRegistration(roomCacheInvalidationRegistration)).toBe(true);
    expect(roomCacheInvalidationRegistration).toMatchObject({
      registrationId: "dao.access.room-cache-invalidation.v1",
      feature: "room-cache-invalidation",
      version: 1,
      enabled: true,
    });
  });

  it("durably appends one replayable transaction-bound intent and rolls it back atomically", () => {
    const database = createDatabase();
    try {
      database.exec("BEGIN IMMEDIATE");
      const tx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-rollback");
      const first = roomCacheInvalidationRegistration.participant
        ?.invalidateRoomCacheInTransaction(tx, {
          roomId: "room-1",
          lifecycleGeneration: 1,
          reason: "room_archived",
        });
      expect(first).toEqual({
        ok: true,
        result: {
          roomId: "room-1",
          lifecycleGeneration: 1,
          invalidationIntentId: expect.stringMatching(/^room-cache-invalidation-/),
          accessRevision: 1,
        },
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_cache_invalidation_intents").get())
        .toEqual({ count: 1 });
      releaseDatabaseAuthorityTransactionView(tx);
      database.exec("ROLLBACK");
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_cache_invalidation_intents").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_access_authority").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("replays the same lifecycle boundary without advancing access revision twice", () => {
    const database = createDatabase();
    try {
      database.exec("BEGIN IMMEDIATE");
      const tx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-replay");
      const participant = roomCacheInvalidationRegistration.participant;
      const input = {
        roomId: "room-1",
        lifecycleGeneration: 2,
        reason: "room_archived" as const,
      };
      const first = participant?.invalidateRoomCacheInTransaction(tx, input);
      const replay = participant?.invalidateRoomCacheInTransaction(tx, input);
      expect(replay).toEqual(first);
      releaseDatabaseAuthorityTransactionView(tx);
      database.exec("COMMIT");
      expect(database.prepare("SELECT access_revision FROM room_access_authority").get())
        .toEqual({ access_revision: 1 });
    } finally {
      database.close();
    }
  });

  it("only purges committed intents and replays a failed purge after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-cache-invalidation-"));
    const path = join(directory, "authority.sqlite");
    let writer: DatabaseSync | undefined;
    let reader: DatabaseSync | undefined;
    try {
      writer = createDatabase(path);
      reader = new DatabaseSync(path);
      writer.exec("BEGIN IMMEDIATE");
      const tx = mintDatabaseAuthorityTransactionView(writer, "room-1", "tx-commit");
      roomCacheInvalidationRegistration.participant?.invalidateRoomCacheInTransaction(tx, {
        roomId: "room-1",
        lifecycleGeneration: 3,
        reason: "room_archived",
      });

      const purged: string[] = [];
      const queue = sqliteQueue(reader);
      let failOnce = true;
      const dispatcher = new RoomCacheInvalidationPostCommitDispatcher({
        authority: queue,
        purge: {
          async purgeCommittedRoom(intent) {
            purged.push(intent.invalidationIntentId);
            if (failOnce) {
              failOnce = false;
              throw new Error("external cache unavailable");
            }
          },
        },
        batchLimit: 10,
      });

      expect(await dispatcher.dispatchReadyBatch()).toEqual({ attempted: 0, completed: 0, failed: 0 });
      expect(purged).toEqual([]);
      releaseDatabaseAuthorityTransactionView(tx);
      writer.exec("COMMIT");

      expect(await dispatcher.dispatchReadyBatch()).toEqual({ attempted: 1, completed: 0, failed: 1 });
      expect(await dispatcher.dispatchReadyBatch()).toEqual({ attempted: 1, completed: 1, failed: 0 });
      expect(purged).toHaveLength(2);
      expect(reader.prepare("SELECT status, attempts FROM room_cache_invalidation_intents").get())
        .toEqual({ status: "completed", attempts: 1 });
      reader.close();
      reader = new DatabaseSync(path);
      expect(await sqliteQueue(reader).listCommittedReady(10)).toEqual([]);
      expect(readFileSync(path).includes(Buffer.from("external cache unavailable"))).toBe(false);
    } finally {
      reader?.close();
      writer?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("dispatches a committed intent through the real AuthorityWorker RPC", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-cache-invalidation-worker-"));
    const path = join(directory, "authority.sqlite");
    const setup = new DatabaseSync(path);
    let worker: Awaited<ReturnType<typeof createWorkerDatabaseClient>> | undefined;
    try {
      migrateAuthorityDatabase(setup);
      setup.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('cache-owner', 'human', 'Cache Owner');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'cache-owner', 0, 1), ('room', 'cache-room', 0, 1);
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('cache-room', 'Cache Room', 'active', '2026-08-19T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES (
          'cache-room', 'cache-owner', 'human', 'member', NULL, '[]',
          '2026-08-19T00:00:00.000Z', NULL, 0
        );
        UPDATE rooms SET owner_actor_id = 'cache-owner' WHERE id = 'cache-room';
      `);
      setup.exec("BEGIN IMMEDIATE");
      const transaction = mintDatabaseAuthorityTransactionView(
        setup,
        "cache-room",
        "worker-rpc-commit",
      );
      roomCacheInvalidationRegistration.participant?.invalidateRoomCacheInTransaction(
        transaction,
        { roomId: "cache-room", lifecycleGeneration: 0, reason: "room_archived" },
      );
      releaseDatabaseAuthorityTransactionView(transaction);
      setup.exec("COMMIT");
      setup.close();

      worker = await createWorkerDatabaseClient({ databasePath: path });
      const purged: string[] = [];
      const dispatcher = new RoomCacheInvalidationPostCommitDispatcher({
        authority: createWorkerRoomCacheInvalidationIntentAuthority(worker),
        purge: {
          async purgeCommittedRoom(intent) {
            purged.push(intent.invalidationIntentId);
          },
        },
        batchLimit: 8,
      });
      await expect(dispatcher.dispatchReadyBatch()).resolves.toEqual({
        attempted: 1,
        completed: 1,
        failed: 0,
      });
      expect(purged).toHaveLength(1);
      await expect(dispatcher.dispatchReadyBatch()).resolves.toEqual({
        attempted: 0,
        completed: 0,
        failed: 0,
      });
    } finally {
      await worker?.close();
      try {
        setup.close();
      } catch {
        // The committed setup connection is already closed on the success path.
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function sqliteQueue(database: DatabaseSync): RoomCacheInvalidationIntentAuthority {
  return {
    async listCommittedReady(limit) {
      return database.prepare(`
        SELECT
          id AS invalidationIntentId,
          room_id AS roomId,
          lifecycle_generation AS lifecycleGeneration,
          access_revision AS accessRevision,
          reason,
          attempts,
          CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS createdAtMs
        FROM room_cache_invalidation_intents
        WHERE status = 'pending'
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `).all(limit) as unknown as readonly CommittedRoomCacheInvalidationIntent[];
    },
    async markCompleted(invalidationIntentId) {
      database.prepare(`
        UPDATE room_cache_invalidation_intents
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(invalidationIntentId);
    },
    async markFailed(input) {
      database.prepare(`
        UPDATE room_cache_invalidation_intents
        SET attempts = ?, last_error_code = ?, available_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(
        input.attempt,
        input.errorCode,
        new Date(input.availableAtMs ?? input.deadLetteredAtMs ?? 0).toISOString(),
        input.invalidationIntentId,
      );
    },
  };
}
