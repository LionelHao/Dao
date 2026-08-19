import type { PersistedRoomEvent, RoomRepairPage, RoomRepairRecord } from "@native-im/core";
import { describe, expect, it } from "vitest";
import { authoritySnapshotChecksum, createDesktopAuthorityCache } from "./authority-cache.js";

const records: readonly RoomRepairRecord[] = [
  {
    kind: "room",
    value: {
      id: "room-1", name: "Alpha", status: "active", createdAt: "2026-08-19T00:00:00.000Z",
    },
  },
  {
    kind: "governance",
    value: {
      roomId: "room-1", projectId: "room-1", lifecycle: "active",
      governanceRevision: 7, ownerActorId: "owner-1", archiveGeneration: 0,
    },
  },
  {
    kind: "membership",
    value: { kind: "human", actorId: "owner-1", role: "owner", joinedAt: "2026-08-19T00:00:00.000Z" },
  },
  {
    kind: "membership",
    value: { kind: "human", actorId: "member-1", role: "member", joinedAt: "2026-08-19T00:00:00.000Z" },
  },
];

function page(): RoomRepairPage {
  return {
    type: "room.repair.page", requestId: "repair-1", snapshotId: "snapshot-1",
    roomId: "room-1", page: 0, records, watermark: 9,
    snapshotChecksum: authoritySnapshotChecksum("room", records),
    hasMore: false, mode: "materialized", expiresAt: "2026-08-19T00:05:00.000Z",
  };
}

describe("production Desktop authority cache", () => {
  it("commits only verified repair records and builds a closed actorId-fallback projection", async () => {
    const cache = createDesktopAuthorityCache(() => "2026-08-19T00:00:10.000Z");
    const repair = page();
    cache.beginRoom("room-1", repair.snapshotId);
    cache.stageRoomPage(repair);
    await expect(cache.finalizeRoom(repair.snapshotId, "wrong")).resolves.toBe(false);
    await expect(cache.finalizeRoom(repair.snapshotId, repair.snapshotChecksum)).resolves.toBe(true);
    cache.commitRoom("room-1", repair.watermark, repair.snapshotChecksum);

    expect(cache.governanceProjection("room-1")).toEqual({
      roomId: "room-1", projectId: "room-1", roomName: "Alpha", lifecycle: "active",
      governanceRevision: 7, archiveGeneration: 0, ownerActorId: "owner-1",
      members: [
        { kind: "human", actorId: "owner-1", displayName: "owner-1", role: "member" },
        { kind: "human", actorId: "member-1", displayName: "member-1", role: "member" },
      ],
    });
    expect(cache.updatedAt("room-1")).toBe("2026-08-19T00:00:10.000Z");
  });

  it("applies stable lifecycle projection events without inventing local lifecycle", async () => {
    const cache = createDesktopAuthorityCache();
    const repair = page();
    cache.beginRoom("room-1", repair.snapshotId);
    cache.stageRoomPage(repair);
    expect(await cache.finalizeRoom(repair.snapshotId, repair.snapshotChecksum)).toBe(true);
    cache.commitRoom("room-1", 9, repair.snapshotChecksum);
    const archivedGovernance = {
      roomId: "room-1", projectId: "room-1", lifecycle: "archived" as const,
      governanceRevision: 8, ownerActorId: "owner-1", archiveGeneration: 1,
      archivedAt: "2026-08-19T00:01:00.000Z",
    };
    const events: readonly PersistedRoomEvent[] = [
      {
        eventId: "event-room-archived", streamKind: "room", streamId: "room-1", streamSeq: 10,
        roomId: "room-1", actorId: "owner-1", occurredAt: "2026-08-19T00:01:00.000Z",
        type: "room.archived", payload: {
          governance: archivedGovernance, archiveGeneration: 1, frozenTimerCount: 0,
        },
      },
      {
        eventId: "event-room-reopened", streamKind: "room", streamId: "room-1", streamSeq: 11,
        roomId: "room-1", actorId: "owner-1", occurredAt: "2026-08-19T00:02:00.000Z",
        type: "room.reopened",
        payload: { governance: {
          roomId: "room-1", projectId: "room-1", lifecycle: "active",
          governanceRevision: 9, ownerActorId: "owner-1", archiveGeneration: 1,
        }, archiveGeneration: 1, resumedTimerCount: 0 },
      },
    ];
    cache.applyRoomEvents("room-1", [events[0]!], { version: 1, roomId: "room-1", afterSeq: 10 });
    expect(cache.governanceProjection("room-1")).toMatchObject({
      lifecycle: "archived", governanceRevision: 8, archiveGeneration: 1,
      archivedAt: "2026-08-19T00:01:00.000Z",
    });
    cache.applyRoomEvents("room-1", [events[1]!], { version: 1, roomId: "room-1", afterSeq: 11 });
    expect(cache.governanceProjection("room-1")).toMatchObject({
      lifecycle: "active", governanceRevision: 9, archiveGeneration: 1,
    });
  });

  it("keeps memory repair identities distinct and invalidates stale projections on minimal events", async () => {
    const memoryRecords: readonly RoomRepairRecord[] = [
      ...records,
      {
        kind: "memory", roomId: "room-1", value: { recordType: "status", status: {
          roomId: "room-1", health: {
            state: "healthy", reason: "none", memoryWatermark: 9, corpusHead: 9,
            lag: 0, lastAttemptAt: null, retryable: false, recoveryRequired: false,
          }, recoveryGeneration: 1, updatedAt: "2026-08-19T00:00:00.000Z",
        } },
      },
      {
        kind: "memory", roomId: "room-1", value: { recordType: "projection", projection: {
          projectionKind: "memory", roomId: "room-1", memoryRecordId: "memory-1",
          kind: "context", currentVersion: {
            roomId: "room-1", memoryRecordId: "memory-1", memoryVersionId: "memory-version-1",
            version: 1, kind: "context", state: "active", derivedText: "Safe derived context",
            sourceRefs: [{
              sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
              eligibility: "eligible", availability: "readable",
            }], createdAt: "2026-08-19T00:00:00.000Z", replacesMemoryVersionId: null,
          }, disputes: [], resolutions: [],
        } },
      },
    ];
    const cache = createDesktopAuthorityCache();
    cache.beginRoom("room-1", "memory-snapshot");
    cache.stageRoomPage({
      ...page(), snapshotId: "memory-snapshot", records: memoryRecords,
      snapshotChecksum: authoritySnapshotChecksum("room", memoryRecords),
    });
    expect(await cache.finalizeRoom(
      "memory-snapshot", authoritySnapshotChecksum("room", memoryRecords),
    )).toBe(true);
    cache.commitRoom("room-1", 9, authoritySnapshotChecksum("room", memoryRecords));
    expect(cache.roomRepairRecords("room-1")?.filter((record) => record.kind === "memory"))
      .toHaveLength(2);

    const events: readonly PersistedRoomEvent[] = [{
      eventId: "memory-version-event", streamKind: "room", streamId: "room-1", streamSeq: 10,
      roomId: "room-1", actorId: "memory-service", occurredAt: "2026-08-19T00:01:00.000Z",
      type: "room.memory.version.changed", payload: {
        memoryRecordId: "memory-1", memoryVersionId: "memory-version-2", kind: "context",
        state: "disputed", sourceIds: ["message:message-1"], memoryWatermark: 9,
      },
    }, {
      eventId: "memory-health-event", streamKind: "room", streamId: "room-1", streamSeq: 11,
      roomId: "room-1", actorId: "memory-service", occurredAt: "2026-08-19T00:02:00.000Z",
      type: "room.memory.health.changed", payload: {
        roomId: "room-1", health: {
          state: "degraded", reason: "invalid_provider_output", memoryWatermark: 9,
          corpusHead: 10, lag: 1, lastAttemptAt: "2026-08-19T00:02:00.000Z",
          retryable: true, recoveryRequired: false,
        }, recoveryGeneration: 1, updatedAt: "2026-08-19T00:02:00.000Z",
      },
    }];
    cache.applyRoomEvents("room-1", events, { version: 1, roomId: "room-1", afterSeq: 11 });
    const currentMemory = cache.roomRepairRecords("room-1")
      ?.filter((record) => record.kind === "memory");
    expect(currentMemory).toHaveLength(1);
    expect(currentMemory?.[0]).toMatchObject({
      value: { recordType: "status", status: { health: { state: "degraded" } } },
    });
  });
});
