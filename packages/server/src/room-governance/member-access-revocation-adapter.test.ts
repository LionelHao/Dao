import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runAuthorityParticipantImmediateTransaction } from "../persistence/authority-database-handler.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  MEMBER_ACCESS_REVOCATION_V15_REQUIREMENTS,
  coordinateMemberAccessRevocationInTransaction,
} from "./member-access-revocation-adapter.js";

const NOW = 1_800_000_000_000;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createV14Database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "dao-member-access-revocation-"));
  directories.push(directory);
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, readiness, tool_permissions_json)
    VALUES
      ('human-owner', 'human', 'Owner', NULL, '[]'),
      ('human-target', 'human', 'Target', NULL, '[]'),
      ('human-peer', 'human', 'Peer', NULL, '[]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES
      ('identity', 'human-owner', 0, 1),
      ('identity', 'human-target', 0, 1),
      ('identity', 'human-peer', 0, 1),
      ('room', 'room-1', 0, 1);
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-1', 'Room', 'active', '2026-08-19T00:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-1', 'human-owner', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('room-1', 'human-target', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 5),
      ('room-1', 'human-peer', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 3);
    UPDATE rooms SET owner_actor_id = 'human-owner' WHERE id = 'room-1';
    UPDATE room_memberships SET role = 'owner'
    WHERE room_id = 'room-1' AND actor_id = 'human-owner';
    INSERT INTO session_families (
      family_id, public_id, account_id, actor_id, device_id, device_label,
      platform, created_at, refresh_expires_at, revoked_at
    ) VALUES
      ('family-target', 'public-target', 'account-target', 'human-target',
       'device-target', 'Target device', 'unknown', ${NOW - 1_000}, ${NOW + 60_000}, NULL),
      ('family-peer', 'public-peer', 'account-peer', 'human-peer',
       'device-peer', 'Peer device', 'unknown', ${NOW - 1_000}, ${NOW + 60_000}, NULL);
    INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
    VALUES ('room-1', 5, 2);
    INSERT INTO offline_read_lease_issuances (
      lease_id, room_id, account_id, actor_id, session_family_id, device_id,
      installation_id, server_subject, key_id, lifecycle_generation,
      access_revision, lease_generation, issued_at_ms, not_before_ms, expires_at_ms
    ) VALUES
      ('lease-target', 'room-1', 'account-target', 'human-target', 'family-target',
       'device-target', 'installation-target', 'server-1', 'key-1', 0, 5, 2,
       ${NOW}, ${NOW}, ${NOW + 30_000}),
      ('lease-peer', 'room-1', 'account-peer', 'human-peer', 'family-peer',
       'device-peer', 'installation-peer', 'server-1', 'key-1', 0, 5, 2,
       ${NOW}, ${NOW}, ${NOW + 30_000});
  `);
  return database;
}

describe("FT-02B target access revocation schema adapter", () => {
  it("fails closed on v14 without masquerading a member removal as room_archived", () => {
    const database = createV14Database();
    try {
      const result = runAuthorityParticipantImmediateTransaction(
        database,
        "room-1",
        "member-remove-target-access",
        (transaction) => coordinateMemberAccessRevocationInTransaction(transaction, {
          roomId: "room-1",
          targetActorId: "human-target",
          occurredAtMs: NOW + 1,
        }),
      );

      expect(result).toEqual({
        outcome: "schema_capability_blocked",
        blocker: {
          code: "target_access_revocation_schema_unavailable",
          minimumSchemaVersion: 15,
          missingCapabilities: [
            "room_cache_invalidation_intents.target_actor_id",
            "room_cache_invalidation_intents.reason:member_removed",
            "room_cache_invalidation_intents.member_removed_unique_key",
            "offline_read_lease_invalidations.target_actor_id",
            "offline_read_lease_invalidations.reason:member_removed",
            "offline_read_lease_invalidations.member_removed_unique_key",
          ],
        },
      });
      expect(database.prepare(`
        SELECT lease_id AS leaseId, revoked_at_ms AS revokedAt
        FROM offline_read_lease_issuances ORDER BY lease_id
      `).all()).toEqual([
        { leaseId: "lease-peer", revokedAt: null },
        { leaseId: "lease-target", revokedAt: null },
      ]);
      expect(database.prepare(
        "SELECT access_revision AS accessRevision, lease_generation AS leaseGeneration FROM room_access_authority",
      ).get()).toEqual({ accessRevision: 5, leaseGeneration: 2 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM room_cache_invalidation_intents",
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM offline_read_lease_invalidations",
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = 'room-1'",
      ).get()).toEqual({ count: 3 });
    } finally {
      database.close();
    }
  });

  it("publishes the exact v15 target-scoping columns, enums, and partial unique keys", () => {
    expect(MEMBER_ACCESS_REVOCATION_V15_REQUIREMENTS).toEqual({
      minimumSchemaVersion: 15,
      cacheInvalidation: {
        targetColumn: "target_actor_id TEXT REFERENCES actors(id)",
        reasonValue: "member_removed",
        uniqueKey: ["room_id", "target_actor_id", "access_revision", "reason"],
      },
      offlineLeaseInvalidation: {
        targetColumn: "target_actor_id TEXT REFERENCES actors(id)",
        reasonValue: "member_removed",
        uniqueKey: ["room_id", "target_actor_id", "access_revision", "reason"],
      },
      archiveScopeRule: "room_archived requires target_actor_id IS NULL",
      memberScopeRule: "member_removed requires target_actor_id IS NOT NULL",
    });
  });
});
