import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runAuthorityParticipantImmediateTransaction } from "../persistence/authority-database-handler.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  MEMBER_ACCESS_REVOCATION_V15_REQUIREMENTS,
  MemberAccessRevocationError,
  coordinateMemberAccessRevocationInTransaction,
} from "./member-access-revocation-adapter.js";

const NOW = 1_800_000_000_000;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function installIntegratedV15InvalidationTables(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE room_cache_invalidation_intents;
    CREATE TABLE room_cache_invalidation_intents (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
      access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
      reason TEXT NOT NULL CHECK (reason IN (
        'room_archived', 'member_removed', 'access_revoked'
      )),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      last_error_code TEXT CHECK (
        last_error_code IS NULL OR last_error_code IN ('purge_failed', 'authority_unavailable')
      ),
      target_actor_id TEXT REFERENCES actors(id),
      CHECK (
        (reason = 'room_archived' AND target_actor_id IS NULL) OR
        (reason IN ('member_removed', 'access_revoked') AND target_actor_id IS NOT NULL)
      )
    ) STRICT;
    CREATE UNIQUE INDEX room_cache_target_invalidation_scope_v15
    ON room_cache_invalidation_intents(room_id, target_actor_id, access_revision, reason)
    WHERE reason IN ('member_removed', 'access_revoked') AND target_actor_id IS NOT NULL;
    CREATE INDEX room_cache_invalidation_ready
    ON room_cache_invalidation_intents(status, available_at, created_at, id);

    DROP TABLE offline_read_lease_invalidations;
    CREATE TABLE offline_read_lease_invalidations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
      access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
      lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
      revoked_lease_count INTEGER NOT NULL CHECK (revoked_lease_count >= 0),
      reason TEXT NOT NULL CHECK (reason IN (
        'room_archived', 'member_removed', 'access_revoked'
      )),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      target_actor_id TEXT REFERENCES actors(id),
      CHECK (
        (reason = 'room_archived' AND target_actor_id IS NULL) OR
        (reason IN ('member_removed', 'access_revoked') AND target_actor_id IS NOT NULL)
      )
    ) STRICT;
    CREATE UNIQUE INDEX offline_read_lease_target_invalidation_scope_v15
    ON offline_read_lease_invalidations(room_id, target_actor_id, access_revision, reason)
    WHERE reason IN ('member_removed', 'access_revoked') AND target_actor_id IS NOT NULL;
  `);
}

function installPreV15InvalidationTables(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE room_cache_invalidation_intents;
    CREATE TABLE room_cache_invalidation_intents (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
      access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
      reason TEXT NOT NULL CHECK (reason IN ('room_archived')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      last_error_code TEXT CHECK (
        last_error_code IS NULL OR last_error_code IN ('purge_failed', 'authority_unavailable')
      ),
      UNIQUE (room_id, lifecycle_generation, reason)
    ) STRICT;
    CREATE INDEX room_cache_invalidation_ready
    ON room_cache_invalidation_intents(status, available_at, created_at, id);

    DROP TABLE offline_read_lease_invalidations;
    CREATE TABLE offline_read_lease_invalidations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
      access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
      lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
      revoked_lease_count INTEGER NOT NULL CHECK (revoked_lease_count >= 0),
      reason TEXT NOT NULL CHECK (reason IN ('room_archived')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (room_id, lifecycle_generation, reason)
    ) STRICT;
  `);
}

function createDatabase(v15 = true): Readonly<{
  directory: string;
  path: string;
  database: DatabaseSync;
}> {
  const directory = mkdtempSync(join(tmpdir(), "dao-member-access-revocation-"));
  directories.push(directory);
  const path = join(directory, "authority.sqlite");
  const database = new DatabaseSync(path);
  migrateAuthorityDatabase(database);
  if (v15) {
    installIntegratedV15InvalidationTables(database);
  } else {
    installPreV15InvalidationTables(database);
  }
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
      ('lease-target-expired', 'room-1', 'account-target', 'human-target', 'family-target',
       'device-target', 'installation-target', 'server-1', 'key-1', 0, 5, 2,
       ${NOW - 20_000}, ${NOW - 20_000}, ${NOW - 10_000}),
      ('lease-peer', 'room-1', 'account-peer', 'human-peer', 'family-peer',
       'device-peer', 'installation-peer', 'server-1', 'key-1', 0, 5, 2,
       ${NOW}, ${NOW}, ${NOW + 30_000});
  `);
  return { directory, path, database };
}

function revokeTarget(
  database: DatabaseSync,
  transactionId: string,
  expectedAccessRevision = 5,
) {
  return runAuthorityParticipantImmediateTransaction(
    database,
    "room-1",
    transactionId,
    (transaction) => coordinateMemberAccessRevocationInTransaction(transaction, {
      roomId: "room-1",
      targetActorId: "human-target",
      expectedAccessRevision,
      occurredAtMs: NOW + 1,
    }),
  );
}

describe("FT-02B target access revocation production adapter", () => {
  it("advances only the target revision and persists truthful target invalidations", () => {
    const fixture = createDatabase();
    try {
      expect(revokeTarget(fixture.database, "target-revoke-1")).toMatchObject({
        outcome: "applied",
        roomId: "room-1",
        targetActorId: "human-target",
        lifecycleGeneration: 0,
        targetAccessRevision: 6,
        leaseGeneration: 2,
        revokedLeaseCount: 1,
        cacheInvalidationIntentId: expect.stringMatching(/^member-cache-invalidation-/),
        offlineLeaseInvalidationId: expect.stringMatching(/^member-lease-invalidation-/),
      });
      expect(fixture.database.prepare(`
        SELECT actor_id AS actorId, access_revision AS accessRevision
        FROM room_memberships WHERE room_id = 'room-1' ORDER BY actor_id
      `).all()).toEqual([
        { actorId: "human-owner", accessRevision: 0 },
        { actorId: "human-peer", accessRevision: 3 },
        { actorId: "human-target", accessRevision: 6 },
      ]);
      expect(fixture.database.prepare(`
        SELECT access_revision AS accessRevision, lease_generation AS leaseGeneration
        FROM room_access_authority WHERE room_id = 'room-1'
      `).get()).toEqual({ accessRevision: 5, leaseGeneration: 2 });
      expect(fixture.database.prepare(`
        SELECT room_id AS roomId, lifecycle_generation AS lifecycleGeneration,
               access_revision AS accessRevision, reason,
               target_actor_id AS targetActorId, status
        FROM room_cache_invalidation_intents
      `).get()).toEqual({
        roomId: "room-1",
        lifecycleGeneration: 0,
        accessRevision: 6,
        reason: "member_removed",
        targetActorId: "human-target",
        status: "pending",
      });
      expect(fixture.database.prepare(`
        SELECT room_id AS roomId, lifecycle_generation AS lifecycleGeneration,
               access_revision AS accessRevision, lease_generation AS leaseGeneration,
               revoked_lease_count AS revokedLeaseCount, reason,
               target_actor_id AS targetActorId
        FROM offline_read_lease_invalidations
      `).get()).toEqual({
        roomId: "room-1",
        lifecycleGeneration: 0,
        accessRevision: 6,
        leaseGeneration: 2,
        revokedLeaseCount: 1,
        reason: "member_removed",
        targetActorId: "human-target",
      });
      expect(fixture.database.prepare(`
        SELECT lease_id AS leaseId, revoked_at_ms AS revokedAt
        FROM offline_read_lease_issuances ORDER BY lease_id
      `).all()).toEqual([
        { leaseId: "lease-peer", revokedAt: null },
        { leaseId: "lease-target", revokedAt: NOW + 1 },
        { leaseId: "lease-target-expired", revokedAt: null },
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it("is idempotent after membership deletion and authority restart", () => {
    const fixture = createDatabase();
    const first = revokeTarget(fixture.database, "target-revoke-first");
    expect(first.outcome).toBe("applied");
    fixture.database.prepare(
      "DELETE FROM room_memberships WHERE room_id = 'room-1' AND actor_id = 'human-target'",
    ).run();
    fixture.database.close();

    const restarted = new DatabaseSync(fixture.path);
    try {
      expect(revokeTarget(restarted, "target-revoke-retry")).toEqual({
        ...first,
        outcome: "already_applied",
      });
      expect(restarted.prepare(
        "SELECT COUNT(*) AS count FROM room_cache_invalidation_intents",
      ).get()).toEqual({ count: 1 });
      expect(restarted.prepare(
        "SELECT COUNT(*) AS count FROM offline_read_lease_invalidations",
      ).get()).toEqual({ count: 1 });
      expect(restarted.prepare(
        "SELECT revoked_at_ms AS revokedAt FROM offline_read_lease_issuances WHERE lease_id = 'lease-peer'",
      ).get()).toEqual({ revokedAt: null });
    } finally {
      restarted.close();
    }
  });

  it("rejects a stale target revision without writing partial invalidations", () => {
    const fixture = createDatabase();
    try {
      expect(() => revokeTarget(fixture.database, "target-revoke-stale", 4))
        .toThrow(new MemberAccessRevocationError("member_access_revision_conflict"));
      expect(fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM room_cache_invalidation_intents",
      ).get()).toEqual({ count: 0 });
      expect(fixture.database.prepare(
        "SELECT revoked_at_ms AS revokedAt FROM offline_read_lease_issuances WHERE lease_id = 'lease-target'",
      ).get()).toEqual({ revokedAt: null });
    } finally {
      fixture.database.close();
    }
  });

  it("fails closed when an idempotency row pair is corrupt", () => {
    const fixture = createDatabase();
    try {
      revokeTarget(fixture.database, "target-revoke-before-corruption");
      fixture.database.prepare(`
        UPDATE offline_read_lease_invalidations
        SET access_revision = access_revision + 1
        WHERE target_actor_id = 'human-target'
      `).run();
      expect(() => revokeTarget(fixture.database, "target-revoke-corrupt-retry"))
        .toThrow(new MemberAccessRevocationError("storage_unavailable"));
      expect(fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM offline_read_lease_invalidations",
      ).get()).toEqual({ count: 1 });
      expect(fixture.database.prepare(
        "SELECT revoked_at_ms AS revokedAt FROM offline_read_lease_issuances WHERE lease_id = 'lease-peer'",
      ).get()).toEqual({ revokedAt: null });
    } finally {
      fixture.database.close();
    }
  });

  it("returns a precise blocker on the pre-v15 schema without archive masquerading", () => {
    const fixture = createDatabase(false);
    try {
      expect(revokeTarget(fixture.database, "target-revoke-v14")).toEqual({
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
      expect(fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM room_cache_invalidation_intents",
      ).get()).toEqual({ count: 0 });
      expect(fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM offline_read_lease_invalidations",
      ).get()).toEqual({ count: 0 });
      expect(fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = 'room-1'",
      ).get()).toEqual({ count: 3 });
    } finally {
      fixture.database.close();
    }
  });

  it("tracks the exact integrated v15 target scope", () => {
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
