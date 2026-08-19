import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import {
  createClosedRepairProjectionRegistry,
} from "../persistence/repair-projection-registry.js";
import {
  lifecycleRepairDescriptorRegistration,
  lifecycleRepairSegmentDescriptor,
} from "./lifecycle-repair-descriptor.js";

function createDatabase(path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      governance_revision INTEGER NOT NULL CHECK (governance_revision >= 0),
      archive_generation INTEGER NOT NULL CHECK (archive_generation >= 0),
      archived_at TEXT
    ) STRICT;
  `);
  return database;
}

function insertRoom(
  database: DatabaseSync,
  input: Readonly<{
    roomId: string;
    status: "active" | "archived";
    governanceRevision: number;
    archiveGeneration: number;
  }>,
): void {
  database.prepare(`
    INSERT INTO rooms (
      id, name, status, created_at, owner_actor_id, governance_revision,
      archive_generation, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.roomId,
    `Room ${input.roomId}`,
    input.status,
    "2026-08-19T00:00:00.000Z",
    "human-owner",
    input.governanceRevision,
    input.archiveGeneration,
    input.status === "archived" ? "2026-08-19T01:00:00.000Z" : null,
  );
}

describe("production lifecycle repair descriptor", () => {
  it("registers the exact shared participant and FT-13 descriptor contracts", () => {
    expect(lifecycleRepairDescriptorRegistration).toMatchObject({
      registrationId: "dao.room-governance.lifecycle-repair.v1",
      feature: "lifecycle-repair",
      version: 1,
      enabled: true,
    });
    expect(lifecycleRepairSegmentDescriptor).toMatchObject({
      descriptorId: "dao.repair.governance.v1",
      descriptorVersion: 1,
      kind: "governance",
      order: 1,
    });
  });

  it("maps the real archived lifecycle row through the same stable descriptor used by repair", () => {
    const database = createDatabase();
    insertRoom(database, {
      roomId: "room-archived",
      status: "archived",
      governanceRevision: 7,
      archiveGeneration: 3,
    });
    const registry = createClosedRepairProjectionRegistry({
      knownKinds: ["governance"] as const,
      descriptors: [lifecycleRepairSegmentDescriptor],
    });

    expect(registry.readStablePage({
      kind: "governance",
      database,
      roomId: "room-archived",
      watermark: 12,
      afterKey: undefined,
      limit: 1,
    })).toEqual([{
      kind: "governance",
      value: {
        roomId: "room-archived",
        projectId: "room-archived",
        lifecycle: "archived",
        governanceRevision: 7,
        ownerActorId: "human-owner",
        archiveGeneration: 3,
        archivedAt: "2026-08-19T01:00:00.000Z",
      },
    }]);
    expect(registry.readStablePage({
      kind: "governance",
      database,
      roomId: "room-archived",
      watermark: 12,
      afterKey: "room-archived",
      limit: 1,
    })).toEqual([]);
    database.close();
  });

  it("describes the transaction-local lifecycle generation and replays deterministically", () => {
    const database = createDatabase();
    insertRoom(database, {
      roomId: "room-1",
      status: "archived",
      governanceRevision: 4,
      archiveGeneration: 2,
    });
    const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-1");
    const participant = lifecycleRepairDescriptorRegistration.participant!;

    const first = participant.describeLifecycleInTransaction(transaction, {
      roomId: "room-1",
      lifecycleGeneration: 2,
    });
    const replay = participant.describeLifecycleInTransaction(transaction, {
      roomId: "room-1",
      lifecycleGeneration: 2,
    });

    expect(first).toEqual({
      ok: true,
      result: {
        roomId: "room-1",
        lifecycleGeneration: 2,
        descriptorId: "dao.repair.governance.v1",
        descriptorVersion: 1,
        sortKey: "room-1",
        recordCount: 1,
      },
    });
    expect(replay).toEqual(first);
    releaseDatabaseAuthorityTransactionView(transaction);
    database.close();
  });

  it("fails closed for a cross-room or stale generation capability without writes", () => {
    const database = createDatabase();
    insertRoom(database, {
      roomId: "room-1",
      status: "active",
      governanceRevision: 1,
      archiveGeneration: 0,
    });
    insertRoom(database, {
      roomId: "room-2",
      status: "archived",
      governanceRevision: 2,
      archiveGeneration: 1,
    });
    const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-1");
    const participant = lifecycleRepairDescriptorRegistration.participant!;

    expect(participant.describeLifecycleInTransaction(transaction, {
      roomId: "room-2",
      lifecycleGeneration: 1,
    })).toMatchObject({ ok: false, error: { reason: "transaction_mismatch" } });
    expect(participant.describeLifecycleInTransaction(transaction, {
      roomId: "room-1",
      lifecycleGeneration: 1,
    })).toMatchObject({ ok: false, error: { reason: "transaction_mismatch" } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 2 });
    releaseDatabaseAuthorityTransactionView(transaction);
    database.close();
  });

  it("rebuilds the descriptor from durable state after reopening SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-lifecycle-repair-"));
    const path = join(directory, "authority.sqlite");
    try {
      const writer = createDatabase(path);
      insertRoom(writer, {
        roomId: "room-restart",
        status: "active",
        governanceRevision: 9,
        archiveGeneration: 4,
      });
      writer.close();

      const reopened = new DatabaseSync(path);
      const row = lifecycleRepairSegmentDescriptor.readKeysetPage({
        database: reopened,
        roomId: "room-restart",
        watermark: 20,
        afterKey: undefined,
        limit: 1,
      })[0];
      expect(lifecycleRepairSegmentDescriptor.mapRow(row)).toMatchObject({
        kind: "governance",
        value: { lifecycle: "active", archiveGeneration: 4 },
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
