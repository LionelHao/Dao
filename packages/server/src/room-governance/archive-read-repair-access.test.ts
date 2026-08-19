import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionSharedAuthorityParticipantComposition } from "../authoritative-server.js";
import { FallbackRepairCoordinator } from "../fallback-repair-coordinator.js";
import { runAuthorityParticipantImmediateTransaction } from "../persistence/authority-database-handler.js";
import { validateHumanSessionDatabaseQuery } from "../persistence/authority-database-handler.js";
import { mintDatabaseAuthorityTransactionView } from "../persistence/authority-transaction-database.js";
import { releaseDatabaseAuthorityTransactionView } from "../persistence/authority-transaction-database.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  createSnapshotWorkerClient,
  type SnapshotWorkerClient,
} from "../persistence/snapshot-worker-client.js";
import {
  OfflineReadLeaseIssuer,
  OfflineReadLeaseValidationError,
  OfflineReadLeaseVerifier,
} from "../access/offline-lease-invalidation-port.js";
import { coordinateArchiveInTransaction } from "./archive-coordinator.js";
import {
  ArchiveReadRepairAccessAuthority,
  type CurrentOfflineReadLeaseSubject,
} from "./archive-read-repair-access.js";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import type { RoomRepairPage, RoomRepairRecord } from "@native-im/core";

const NOW = 1_800_000_000_000;
const MAX_LEASE_MS = 60_000;
const roomId = "room-archive";
const ownerId = "human-owner";
const readerId = "human-reader";
const directories: string[] = [];

const readerContext: AuthenticatedSessionContext = {
  sessionId: "access-reader",
  sessionFamilyId: "family-reader",
  principal: { accountId: "account-reader", actorId: readerId },
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(messageCount = 8): Readonly<{
  directory: string;
  authorityPath: string;
  database: DatabaseSync;
}> {
  const directory = mkdtempSync(join(tmpdir(), "dao-archive-read-repair-"));
  directories.push(directory);
  const authorityPath = join(directory, "authority.sqlite");
  const database = new DatabaseSync(authorityPath);
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, readiness, tool_permissions_json)
    VALUES
      ('human-owner', 'human', 'Owner', NULL, '[]'),
      ('human-reader', 'human', 'Reader', NULL, '[]'),
      ('human-outsider', 'human', 'Outsider', NULL, '[]'),
      ('agent-1', 'agent', 'Agent', 'ready', '["project.read"]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES
      ('identity', 'human-owner', 0, 1),
      ('identity', 'human-reader', 0, 1),
      ('identity', 'human-outsider', 0, 1),
      ('identity', 'agent-1', 0, 1),
      ('room', 'room-archive', ${messageCount}, 1);
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-archive', 'Archive', 'active', '2026-08-19T00:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-archive', 'human-owner', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('room-archive', 'human-reader', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 7),
      ('room-archive', 'agent-1', 'agent', NULL, 'active', '["project.read"]',
       NULL, '2026-08-19T00:00:00.000Z', 0);
    UPDATE rooms
    SET owner_actor_id = 'human-owner', governance_revision = 1
    WHERE id = 'room-archive';
    UPDATE room_memberships
    SET role = 'owner'
    WHERE room_id = 'room-archive' AND actor_id = 'human-owner';
    INSERT INTO session_families (
      family_id, public_id, account_id, actor_id, device_id, device_label,
      platform, created_at, refresh_expires_at, revoked_at
    ) VALUES
      ('family-reader', 'public-reader', 'account-reader', 'human-reader',
       'device-reader', 'Reader Device', 'unknown', ${NOW - 1_000}, ${NOW + 300_000}, NULL),
      ('family-outsider', 'public-outsider', 'account-outsider', 'human-outsider',
       'device-outsider', 'Outsider Device', 'unknown', ${NOW - 1_000}, ${NOW + 300_000}, NULL);
    INSERT INTO sessions (
      family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
      access_expires_at, refresh_expires_at, revoked_at
    ) VALUES
      ('family-reader', 'account-reader', 'human-reader', 'access-reader', 'refresh-reader',
       ${NOW + 120_000}, ${NOW + 300_000}, NULL),
      ('family-outsider', 'account-outsider', 'human-outsider', 'access-outsider', 'refresh-outsider',
       ${NOW + 120_000}, ${NOW + 300_000}, NULL);
    INSERT INTO room_audit (id, type, room_id, actor_id, result, timestamp, details_json)
    VALUES ('audit-created', 'room.created', 'room-archive', 'human-owner', 'created',
            '2026-08-19T00:00:00.000Z', '{}');
  `);
  const insertMessage = database.prepare(
    `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
     VALUES (?, 'room-archive', 'human-reader', 'human', ?, ?)`,
  );
  for (let index = 0; index < messageCount; index += 1) {
    insertMessage.run(
      `message-${String(index).padStart(2, "0")}`,
      `history-${index}`,
      new Date(Date.UTC(2026, 7, 19, 0, 0, index)).toISOString(),
    );
  }
  if (messageCount > 0) {
    database.exec(`
      INSERT INTO open_items (
        id, room_id, source_message_id, current_owner_actor_id, status, body,
        created_at, responded_at, requester_actor_id, transfer_chain_json, origin_kind
      ) VALUES (
        'item-project', 'room-archive', 'message-00', 'agent-1', 'awaiting',
        'project fact', '2026-08-19T00:00:00.000Z', NULL, 'human-reader', '[]',
        'human_mention'
      );
    `);
  }
  return { directory, authorityPath, database };
}

function authority(database: DatabaseSync, serial = "repair") {
  let next = 0;
  return new ArchiveReadRepairAccessAuthority({
    database,
    reauthenticate: validateHumanSessionDatabaseQuery,
    repairs: new FallbackRepairCoordinator({
      idFactory: () => `${serial}-${++next}`,
    }),
  });
}

function archive(database: DatabaseSync): void {
  const production = createProductionSharedAuthorityParticipantComposition({
    maxOfflineReadLeaseMs: MAX_LEASE_MS,
    ballPolicy: { openItemDeadlineMs: 60_000, lightTaskDeadlineMs: 60_000 },
  });
  runAuthorityParticipantImmediateTransaction(
    database,
    roomId,
    "archive-read-repair",
    (transaction) => coordinateArchiveInTransaction(transaction, {
      roomId,
      actorId: ownerId,
      expectedGovernanceRevision: 1,
      occurredAt: "2026-08-19T00:00:30.000Z",
    }, {
      manifest: production.manifest,
      transactionRegistrations: production.registrations,
      lifecycleRepairRegistrations: production.registrations,
      accessInvalidationRegistrations: production.registrations,
    }),
  );
}

async function collectRoomRepair(
  client: SnapshotWorkerClient,
  requestPrefix: string,
): Promise<Readonly<{
  pages: readonly RoomRepairPage[];
  records: readonly RoomRepairRecord[];
}>> {
  const first = await client.beginRoomRepair(readerContext, `${requestPrefix}-0`, roomId);
  if ("kind" in first) throw new Error(`unexpected fallback: ${first.reason}`);
  const pages = [first];
  const records = [...first.records];
  let page = first;
  while (page.hasMore) {
    page = await client.readRoomRepairPage(
      readerContext,
      `${requestPrefix}-${page.page + 1}`,
      page.snapshotId,
      page.page,
    );
    pages.push(page);
    records.push(...page.records);
  }
  return { pages, records };
}

function leaseSubject(): CurrentOfflineReadLeaseSubject {
  return {
    tenantId: "tenant-1",
    accountId: "account-reader",
    actorId: readerId,
    sessionFamilyId: "family-reader",
    deviceId: "device-reader",
    installationId: "installation-reader",
    serverSubject: "server-1",
    roomId,
  };
}

describe("FT-02C archived read/repair/cache/lease integration", () => {
  it("allows only a current Human member to read archived history, project facts, and audit", () => {
    const fixture = createFixture(2);
    const access = authority(fixture.database, "read");
    archive(fixture.database);
    let reads = 0;
    const projection = {
      read(database: DatabaseSync, proof: { readonly roomId: string }) {
        reads += 1;
        return {
          history: database.prepare(
            "SELECT body FROM messages WHERE room_id = ? ORDER BY id",
          ).all(proof.roomId).map((row) => row.body),
          projectFacts: database.prepare(
            "SELECT id FROM open_items WHERE room_id = ? ORDER BY id",
          ).all(proof.roomId).map((row) => row.id),
          audit: database.prepare(
            "SELECT type FROM room_audit WHERE room_id = ? ORDER BY rowid",
          ).all(proof.roomId).map((row) => row.type),
        };
      },
    };
    expect(access.readArchivedProjection(readerContext, roomId, NOW, projection)).toEqual({
      history: ["history-0", "history-1"],
      projectFacts: ["item-project"],
      audit: ["room.created"],
    });
    expect(reads).toBe(1);

    fixture.database.prepare(
      "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
    ).run(roomId, readerId);
    expect(() => access.readArchivedProjection(readerContext, roomId, NOW, projection))
      .toThrowError(expect.objectContaining({ code: "room_forbidden", status: 403 }));
    expect(reads).toBe(1);

    const outsider: AuthenticatedSessionContext = {
      sessionId: "access-outsider",
      sessionFamilyId: "family-outsider",
      principal: { accountId: "account-outsider", actorId: "human-outsider" },
    };
    expect(() => access.readArchivedProjection(outsider, roomId, NOW, projection))
      .toThrowError(expect.objectContaining({ code: "room_forbidden", status: 403 }));
    expect(reads).toBe(1);
    fixture.database.close();
  });

  it("produces identical archived materialized and streaming records at one fixed watermark", async () => {
    const fixture = createFixture(8);
    archive(fixture.database);
    const access = authority(fixture.database, "parity");
    const materialized = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: join(fixture.directory, "materialized.sqlite"),
      revalidate: (request) => access.revalidateMaterializedSnapshot(request, NOW),
      streamingAuthority: access,
      clock: () => NOW,
      limits: { maxRecordsPerPage: 3 },
    });
    const streaming = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: join(fixture.directory, "streaming.sqlite"),
      revalidate: (request) => access.revalidateMaterializedSnapshot(request, NOW),
      streamingAuthority: access,
      clock: () => NOW,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 3 },
    });
    try {
      const materializedResult = await collectRoomRepair(materialized, "materialized");
      expect(materializedResult.pages.every((page) => page.mode === "materialized")).toBe(true);
      const streamingResult = await collectRoomRepair(streaming, "streaming");
      expect(streamingResult.pages.every((page) => page.mode === "streaming")).toBe(true);
      expect(streamingResult.records).toEqual(materializedResult.records);
      expect(streamingResult.pages[0]?.snapshotChecksum)
        .toBe(materializedResult.pages[0]?.snapshotChecksum);
      expect(streamingResult.pages.map((page) => page.watermark))
        .toEqual(materializedResult.pages.map((page) => page.watermark));
      expect(streamingResult.records).toContainEqual(expect.objectContaining({
        kind: "governance",
        value: expect.objectContaining({ lifecycle: "archived", archiveGeneration: 1 }),
      }));
      const last = streamingResult.pages.at(-1)!;
      await streaming.completeSnapshot(
        readerContext,
        "streaming-complete",
        last.snapshotId,
        { kind: "room", roomId, watermark: last.watermark },
        last.snapshotChecksum,
      );
    } finally {
      await materialized.close();
      await streaming.close();
      fixture.database.close();
    }
  });

  it("preempts an active streaming view on archive, then permits a new archived read-only repair", async () => {
    const fixture = createFixture(8);
    const access = authority(fixture.database, "preempt");
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: join(fixture.directory, "preempt.sqlite"),
      revalidate: (request) => access.revalidateMaterializedSnapshot(request, NOW),
      streamingAuthority: access,
      clock: () => NOW,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
    });
    try {
      const first = await client.beginRoomRepair(readerContext, "active-page-0", roomId);
      if ("kind" in first || first.mode !== "streaming") throw new Error("expected streaming");
      expect(access.blockingRoomRepair(roomId, NOW)?.snapshotId).toBe(first.snapshotId);

      archive(fixture.database);
      access.preemptArchiveAfterCommit(roomId, NOW + 1);
      await expect(client.readRoomRepairPage(
        readerContext, "active-page-1", first.snapshotId, 0,
      )).rejects.toMatchObject({ status: 409, code: "snapshot_stale" });

      const archived = await client.beginRoomRepair(readerContext, "archived-page-0", roomId);
      expect(archived).toMatchObject({ mode: "streaming", page: 0 });
      if ("kind" in archived) throw new Error("unexpected fallback");
      expect(archived.records).toContainEqual(expect.objectContaining({
        kind: "room",
        value: expect.objectContaining({ status: "archived" }),
      }));
    } finally {
      await client.close();
      fixture.database.close();
    }
  });

  it("preempts removed principals and revoked session families without exposing another page", async () => {
    const fixture = createFixture(1);
    try {
      archive(fixture.database);
      const access = authority(fixture.database, "revocation");
      const lease = await access.acquireStreamingRepair(
        readerContext, { kind: "room", roomId }, NOW,
      );
      access.preemptMemberRemovalAfterCommit(roomId, readerId, NOW + 1);
      await expect(access.authorizeStreamingRepairPage(
        readerContext, lease.snapshotId, 0, NOW + 1,
      )).rejects.toMatchObject({ status: 403, code: "room_forbidden" });

      const next = await access.acquireStreamingRepair(
        readerContext, { kind: "room", roomId }, NOW + 2,
      );
      access.preemptSessionFamilyAfterCommit("family-reader", NOW + 3);
      await expect(access.authorizeStreamingRepairPage(
        readerContext, next.snapshotId, 0, NOW + 3,
      )).rejects.toMatchObject({ status: 403, code: "snapshot_family_revoked" });
    } finally {
      fixture.database.close();
    }
  });

  it("binds offline archived reads to durable current revisions across restart, expiry, and revoke", () => {
    const fixture = createFixture(1);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const issuer = new OfflineReadLeaseIssuer({
      tenantId: "tenant-1",
      serverSubject: "server-1",
      keyId: "key-1",
      privateKey,
      maxOfflineReadLeaseMs: MAX_LEASE_MS,
      now: () => NOW,
      createLeaseId: () => "lease-before-archive",
    });
    fixture.database.exec("BEGIN IMMEDIATE");
    const transaction = mintDatabaseAuthorityTransactionView(
      fixture.database, roomId, "lease-before-archive",
    );
    const issued = issuer.issueInTransaction(transaction, {
      roomId,
      accountId: "account-reader",
      actorId: readerId,
      sessionFamilyId: "family-reader",
      deviceId: "device-reader",
      installationId: "installation-reader",
      requestedLeaseMs: 30_000,
      expectedLifecycleGeneration: 0,
      expectedAccessRevision: 7,
      expectedLeaseGeneration: 0,
    });
    releaseDatabaseAuthorityTransactionView(transaction);
    fixture.database.exec("COMMIT");
    archive(fixture.database);
    const proofBeforeRestart = authority(fixture.database).readCurrentArchivedAccessProof(
      readerId, roomId,
    );
    expect(proofBeforeRestart).toMatchObject({
      lifecycleGeneration: 1,
      accessRevision: 8,
      leaseGeneration: 1,
    });
    expect(fixture.database.prepare(`
      SELECT lifecycle_generation AS lifecycleGeneration,
             access_revision AS accessRevision, status
      FROM room_cache_invalidation_intents
      WHERE room_id = ?
    `).get(roomId)).toEqual({
      lifecycleGeneration: 1,
      accessRevision: 8,
      status: "pending",
    });
    fixture.database.close();

    const restarted = new DatabaseSync(fixture.authorityPath);
    expect(restarted.prepare(`
      SELECT lifecycle_generation AS lifecycleGeneration,
             access_revision AS accessRevision, status
      FROM room_cache_invalidation_intents
      WHERE room_id = ?
    `).get(roomId)).toEqual({
      lifecycleGeneration: 1,
      accessRevision: 8,
      status: "pending",
    });
    const verifier = new OfflineReadLeaseVerifier({
      verificationKeys: new Map([["key-1", publicKey]]),
      now: () => NOW + 1,
    });
    expect(() => authority(restarted).verifyCurrentArchivedOfflineLease(
      verifier, issued.token, leaseSubject(),
    )).toThrow(new OfflineReadLeaseValidationError("binding_mismatch"));

    const archivedIssuer = new OfflineReadLeaseIssuer({
      tenantId: "tenant-1",
      serverSubject: "server-1",
      keyId: "key-1",
      privateKey,
      maxOfflineReadLeaseMs: MAX_LEASE_MS,
      now: () => NOW + 2,
      createLeaseId: () => "lease-archived",
    });
    restarted.exec("BEGIN IMMEDIATE");
    const archivedTx = mintDatabaseAuthorityTransactionView(
      restarted, roomId, "lease-archived",
    );
    const archivedLease = archivedIssuer.issueInTransaction(archivedTx, {
      roomId,
      accountId: "account-reader",
      actorId: readerId,
      sessionFamilyId: "family-reader",
      deviceId: "device-reader",
      installationId: "installation-reader",
      requestedLeaseMs: 30_000,
      expectedLifecycleGeneration: 1,
      expectedAccessRevision: 8,
      expectedLeaseGeneration: 1,
    });
    releaseDatabaseAuthorityTransactionView(archivedTx);
    restarted.exec("COMMIT");
    const archivedVerifier = new OfflineReadLeaseVerifier({
      verificationKeys: new Map([["key-1", publicKey]]),
      now: () => NOW + 2,
    });
    expect(authority(restarted).verifyCurrentArchivedOfflineLease(
      archivedVerifier, archivedLease.token, leaseSubject(),
    ).leaseId).toBe("lease-archived");
    expect(() => authority(restarted).verifyCurrentArchivedOfflineLease(
      new OfflineReadLeaseVerifier({
        verificationKeys: new Map([["key-1", publicKey]]),
        now: () => NOW + 30_002,
      }),
      archivedLease.token,
      leaseSubject(),
    )).toThrow(new OfflineReadLeaseValidationError("expired"));

    restarted.prepare(
      "UPDATE offline_read_lease_issuances SET revoked_at_ms = ? WHERE lease_id = ?",
    ).run(NOW + 3, "lease-archived");
    expect(() => authority(restarted).verifyCurrentArchivedOfflineLease(
      archivedVerifier, archivedLease.token, leaseSubject(),
    )).toThrow(new OfflineReadLeaseValidationError("subject_unauthorized"));
    restarted.close();
  });
});
