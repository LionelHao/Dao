import { describe, expect, it } from "vitest";
import type { AuthenticatedSessionContext } from "./persistence/contracts.js";
import {
  FallbackRepairCoordinator,
  type RepairMutationImpact,
} from "./fallback-repair-coordinator.js";

function context(
  actorId: string,
  familyId = `family-${actorId}`,
  sessionId = `session-${actorId}`,
): AuthenticatedSessionContext {
  return {
    sessionId,
    sessionFamilyId: familyId,
    principal: { accountId: `account-${actorId}`, actorId },
  };
}

const noImpact: RepairMutationImpact = {
  roomIds: [],
  catalogPrincipalIds: [],
};

describe("FallbackRepairCoordinator", () => {
  it("blocks only mutations intersecting the leased room or actor catalog", () => {
    let serial = 0;
    const coordinator = new FallbackRepairCoordinator({
      idFactory: () => `stream-${++serial}`,
    });
    const room = coordinator.acquire({
      context: context("alice"),
      scope: { kind: "room", roomId: "room-a" },
      version: { kind: "room", roomId: "room-a", watermark: 9 },
      authorizationRevision: 3,
      now: 1_000,
    });
    const catalog = coordinator.acquire({
      context: context("bob"),
      scope: { kind: "catalog", principalId: "bob" },
      version: { kind: "catalog", catalogRevision: 4 },
      authorizationRevision: 4,
      now: 1_000,
    });

    expect(coordinator.blockingLease({
      roomIds: ["room-a"], catalogPrincipalIds: [],
    }, 1_001)?.snapshotId).toBe(room.snapshotId);
    expect(coordinator.blockingLease({
      roomIds: [], catalogPrincipalIds: ["bob"],
    }, 1_001)?.snapshotId).toBe(catalog.snapshotId);
    expect(coordinator.blockingLease({
      roomIds: ["room-b"], catalogPrincipalIds: ["carol"],
    }, 1_001)).toBeUndefined();
    expect(coordinator.blockingLease(noImpact, 1_001)).toBeUndefined();
  });

  it("binds continuation to a session family while allowing a refreshed session", () => {
    const coordinator = new FallbackRepairCoordinator({ idFactory: () => "stream-family" });
    const original = context("alice", "family-a", "expired-session");
    const lease = coordinator.acquire({
      context: original,
      scope: { kind: "room", roomId: "room-a" },
      version: { kind: "room", roomId: "room-a", watermark: 2 },
      authorizationRevision: 7,
      now: 1_000,
    });
    expect(coordinator.registerChecksum(lease.snapshotId, "checksum-a", 1, 1_100))
      .toMatchObject({ highestAuthorizedPage: -1 });

    expect(coordinator.acquire({
      context: context("alice", "family-a", "fresh-session"),
      scope: { kind: "room", roomId: "room-a" },
      version: { kind: "room", roomId: "room-a", watermark: 2 },
      authorizationRevision: 7,
      now: 1_150,
    })).toMatchObject({ snapshotId: lease.snapshotId, checksum: "checksum-a" });

    expect(coordinator.authorizePage({
      context: context("alice", "family-a", "fresh-session"),
      snapshotId: lease.snapshotId,
      page: 0,
      now: 1_200,
    }).idleExpiresAt).toBe(new Date(31_200).toISOString());
    expect(() => coordinator.authorizePage({
      context: context("alice", "family-other", "other-session"),
      snapshotId: lease.snapshotId,
      page: 0,
      now: 1_300,
    })).toThrowError(expect.objectContaining({ code: "snapshot_forbidden", status: 403 }));
  });

  it("expires an idle lease after thirty seconds and releases it", () => {
    const coordinator = new FallbackRepairCoordinator({ idFactory: () => "stream-idle" });
    const lease = coordinator.acquire({
      context: context("alice"),
      scope: { kind: "room", roomId: "room-a" },
      version: { kind: "room", roomId: "room-a", watermark: 0 },
      authorizationRevision: 0,
      now: 1_000,
    });
    coordinator.registerChecksum(lease.snapshotId, "checksum", 1, 1_000);
    expect(coordinator.blockingLease({ roomIds: ["room-a"], catalogPrincipalIds: [] }, 30_999))
      .toBeDefined();
    expect(() => coordinator.authorizePage({
      context: context("alice"), snapshotId: lease.snapshotId, page: 0, now: 31_000,
    })).toThrowError(expect.objectContaining({ code: "snapshot_expired", status: 410 }));
    expect(coordinator.blockingLease({ roomIds: ["room-a"], catalogPrincipalIds: [] }, 31_000))
      .toBeUndefined();
  });

  it("starts the idle deadline only after the stable checksum pass", () => {
    const coordinator = new FallbackRepairCoordinator({ idFactory: () => "stream-long-checksum" });
    const lease = coordinator.acquire({
      context: context("alice"),
      scope: { kind: "room", roomId: "room-a" },
      version: { kind: "room", roomId: "room-a", watermark: 0 },
      authorizationRevision: 0,
      now: 1_000,
    });

    expect(coordinator.registerChecksum(lease.snapshotId, "checksum", 1, 61_000).idleExpiresAt)
      .toBe(new Date(91_000).toISOString());
    expect(coordinator.blockingLease({
      roomIds: ["room-a"], catalogPrincipalIds: [],
    }, 90_999)).toBeDefined();
  });

  it("preempts only matching access-reducing scopes and revoked families", () => {
    let serial = 0;
    const coordinator = new FallbackRepairCoordinator({
      idFactory: () => `stream-preempt-${++serial}`,
    });
    const aliceRoom = coordinator.acquire({
      context: context("alice", "family-alice"),
      scope: { kind: "room", roomId: "room-a" },
      version: { kind: "room", roomId: "room-a", watermark: 2 },
      authorizationRevision: 1,
      now: 1_000,
    });
    const bobCatalog = coordinator.acquire({
      context: context("bob", "family-bob"),
      scope: { kind: "catalog", principalId: "bob" },
      version: { kind: "catalog", catalogRevision: 4 },
      authorizationRevision: 4,
      now: 1_000,
    });
    coordinator.registerChecksum(bobCatalog.snapshotId, "checksum-bob", 1, 1_000);
    coordinator.preemptAfterCommit({
      roomIds: ["room-a"],
      catalogPrincipalIds: [],
      familyIds: [],
      code: "snapshot_stale",
      now: 1_001,
    });
    expect(() => coordinator.authorizePage({
      context: context("alice", "family-alice"),
      snapshotId: aliceRoom.snapshotId,
      page: 0,
      now: 1_001,
    })).toThrowError(expect.objectContaining({ code: "snapshot_stale", status: 409 }));
    expect(coordinator.authorizePage({
      context: context("bob", "family-bob"),
      snapshotId: bobCatalog.snapshotId,
      page: 0,
      now: 1_001,
    })).toBeDefined();

    coordinator.preemptAfterCommit({
      roomIds: [], catalogPrincipalIds: [], familyIds: ["family-bob"],
      code: "snapshot_family_revoked",
      now: 1_002,
    });
    expect(() => coordinator.authorizePage({
      context: context("bob", "family-bob"),
      snapshotId: bobCatalog.snapshotId,
      page: 0,
      now: 1_002,
    })).toThrowError(expect.objectContaining({ code: "snapshot_family_revoked", status: 403 }));
  });

  it("requires catalogRevision for catalog completion and reauthorizes tombstone replay", () => {
    const coordinator = new FallbackRepairCoordinator({ idFactory: () => "stream-catalog" });
    const lease = coordinator.acquire({
      context: context("alice"),
      scope: { kind: "catalog", principalId: "alice" },
      version: { kind: "catalog", catalogRevision: 11 },
      authorizationRevision: 11,
      now: 1_000,
    });
    coordinator.registerChecksum(lease.snapshotId, "checksum-catalog", 1, 1_001);

    expect(() => coordinator.complete({
      context: context("alice"), snapshotId: lease.snapshotId,
      version: { kind: "room", roomId: "room-a", watermark: 11 },
      checksum: "checksum-catalog", now: 1_002,
    })).toThrowError(expect.objectContaining({ code: "snapshot_stale", status: 409 }));
    expect(() => coordinator.complete({
      context: context("alice"), snapshotId: lease.snapshotId,
      version: { kind: "catalog", catalogRevision: 11 },
      checksum: "checksum-catalog", now: 1_003,
    })).toThrowError(expect.objectContaining({ code: "snapshot_stale", status: 409 }));
    coordinator.authorizePage({
      context: context("alice"), snapshotId: lease.snapshotId, page: 0, now: 1_004,
    });
    expect(coordinator.complete({
      context: context("alice"), snapshotId: lease.snapshotId,
      version: { kind: "catalog", catalogRevision: 11 },
      checksum: "checksum-catalog", now: 1_005,
    })).toMatchObject({ snapshotId: lease.snapshotId, version: { kind: "catalog", catalogRevision: 11 } });
    expect(coordinator.blockingLease({ roomIds: [], catalogPrincipalIds: ["alice"] }, 1_006))
      .toBeUndefined();
    expect(coordinator.complete({
      context: context("alice", "family-alice", "refreshed"),
      snapshotId: lease.snapshotId,
      version: { kind: "catalog", catalogRevision: 11 },
      checksum: "checksum-catalog", now: 1_007,
    })).toMatchObject({ snapshotId: lease.snapshotId });
    expect(() => coordinator.complete({
      context: context("alice", "family-other"),
      snapshotId: lease.snapshotId,
      version: { kind: "catalog", catalogRevision: 11 },
      checksum: "checksum-catalog", now: 1_008,
    })).toThrowError(expect.objectContaining({ code: "snapshot_forbidden", status: 403 }));
  });

  it("requires the last page to be continuously authorized before completion", () => {
    const coordinator = new FallbackRepairCoordinator({ idFactory: () => "stream-pages" });
    const lease = coordinator.acquire({
      context: context("alice"),
      scope: { kind: "room", roomId: "room-a" },
      version: { kind: "room", roomId: "room-a", watermark: 3 },
      authorizationRevision: 1,
      now: 1_000,
    });
    expect(coordinator.registerChecksum(lease.snapshotId, "checksum-pages", 3, 1_001))
      .toMatchObject({ highestAuthorizedPage: -1 });

    expect(() => coordinator.complete({
      context: context("alice"), snapshotId: lease.snapshotId,
      version: { kind: "room", roomId: "room-a", watermark: 3 },
      checksum: "checksum-pages", now: 1_002,
    })).toThrowError(expect.objectContaining({ code: "snapshot_stale", status: 409 }));
    expect(coordinator.authorizePage({
      context: context("alice"), snapshotId: lease.snapshotId, page: 0, now: 1_003,
    })).toMatchObject({ highestAuthorizedPage: 0, lastPage: 2 });
    expect(() => coordinator.authorizePage({
      context: context("alice"), snapshotId: lease.snapshotId, page: 2, now: 1_004,
    })).toThrowError(expect.objectContaining({ code: "invalid_request", status: 400 }));
    expect(coordinator.authorizePage({
      context: context("alice"), snapshotId: lease.snapshotId, page: 1, now: 1_005,
    })).toMatchObject({ highestAuthorizedPage: 1, lastPage: 2 });
    expect(coordinator.authorizePage({
      context: context("alice"), snapshotId: lease.snapshotId, page: 1, now: 1_006,
    })).toMatchObject({ highestAuthorizedPage: 1 });
    expect(coordinator.authorizePage({
      context: context("alice"), snapshotId: lease.snapshotId, page: 2, now: 1_007,
    })).toMatchObject({ highestAuthorizedPage: 2 });
    expect(coordinator.complete({
      context: context("alice"), snapshotId: lease.snapshotId,
      version: { kind: "room", roomId: "room-a", watermark: 3 },
      checksum: "checksum-pages", now: 1_008,
    })).toMatchObject({ snapshotId: lease.snapshotId });
  });

  it("replays through retainUntil minus one and returns explicit 404 at retainUntil", () => {
    const coordinator = new FallbackRepairCoordinator({
      idFactory: () => "stream-tombstone-boundary",
      tombstoneTtlMs: 10,
    });
    const lease = coordinator.acquire({
      context: context("alice"),
      scope: { kind: "catalog", principalId: "alice" },
      version: { kind: "catalog", catalogRevision: 4 },
      authorizationRevision: 4,
      now: 1_000,
    });
    coordinator.registerChecksum(lease.snapshotId, "checksum-boundary", 1, 1_001);
    coordinator.authorizePage({
      context: context("alice"), snapshotId: lease.snapshotId, page: 0, now: 1_002,
    });
    coordinator.complete({
      context: context("alice"), snapshotId: lease.snapshotId,
      version: { kind: "catalog", catalogRevision: 4 },
      checksum: "checksum-boundary", now: 1_003,
    });

    expect(coordinator.complete({
      context: context("alice"), snapshotId: lease.snapshotId,
      version: { kind: "catalog", catalogRevision: 4 },
      checksum: "checksum-boundary", now: 1_012,
    })).toMatchObject({ snapshotId: lease.snapshotId });
    expect(() => coordinator.complete({
      context: context("alice"), snapshotId: lease.snapshotId,
      version: { kind: "catalog", catalogRevision: 4 },
      checksum: "checksum-boundary", now: 1_013,
    })).toThrowError(expect.objectContaining({
      code: "snapshot_not_found",
      status: 404,
    }));
    expect(() => coordinator.describe({
      context: context("alice"), snapshotId: "never-existed", now: 1_013,
    })).toThrowError(expect.objectContaining({
      code: "snapshot_not_found",
      status: 404,
    }));
  });

  it("releases every unfinished lease on process shutdown", () => {
    let serial = 0;
    const coordinator = new FallbackRepairCoordinator({ idFactory: () => `stream-${++serial}` });
    coordinator.acquire({
      context: context("alice"), scope: { kind: "room", roomId: "room-a" },
      version: { kind: "room", roomId: "room-a", watermark: 0 },
      authorizationRevision: 0, now: 1_000,
    });
    coordinator.acquire({
      context: context("bob"), scope: { kind: "catalog", principalId: "bob" },
      version: { kind: "catalog", catalogRevision: 0 },
      authorizationRevision: 0, now: 1_000,
    });
    coordinator.releaseAll();
    expect(coordinator.blockingLease({
      roomIds: ["room-a"], catalogPrincipalIds: ["bob"],
    }, 1_001)).toBeUndefined();
  });
});
