import type { PersistedRoomEvent, RoomRepairPage, RoomRepairRecord } from "@native-im/core";
import { describe, expect, it, vi } from "vitest";
import { authoritySnapshotChecksum, createDesktopAuthorityCache } from "./authority-cache.js";
import { projectSnapshot } from "../project-loop/test-fixture.js";

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
  it("restores only a complete encrypted actor-bound cache and purges it on revocation", async () => {
    let stored: unknown;
    let clearCount = 0;
    const persistence = {
      async load() { return structuredClone(stored); },
      async save(value: unknown) { stored = structuredClone(value); },
      async clear() { stored = undefined; clearCount += 1; },
    };
    const snapshot = projectSnapshot();
    const persistedRecords: readonly RoomRepairRecord[] = [
      ...records, { kind: "project-loop", roomId: "room-1", value: snapshot },
    ];
    const checksum = authoritySnapshotChecksum("room", persistedRecords);
    const first = createDesktopAuthorityCache(() => "2026-08-25T05:00:00.000Z", persistence);
    await first.restore("human-1");
    first.beginRoom("room-1", "snapshot-persist");
    first.stageRoomPage({ ...page(), snapshotId: "snapshot-persist", records: persistedRecords,
      watermark: snapshot.watermark, snapshotChecksum: checksum });
    expect(await first.finalizeRoom("snapshot-persist", checksum)).toBe(true);
    first.commitRoom("room-1", snapshot.watermark, checksum);
    await vi.waitFor(() => expect(stored).toBeDefined());

    const restarted = createDesktopAuthorityCache(() => "2026-08-25T05:01:00.000Z", persistence);
    await expect(restarted.restore("human-1")).resolves.toBe(true);
    expect(restarted.roomCursor("room-1")?.afterSeq).toBe(snapshot.watermark);
    expect(restarted.roomRepairRecords("room-1")?.find((record) => record.kind === "project-loop"))
      .toEqual({ kind: "project-loop", roomId: "room-1", value: snapshot });
    restarted.clear();
    await vi.waitFor(() => expect(clearCount).toBeGreaterThan(0));
    expect(stored).toBeUndefined();
  });

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

  it("invalidates the Project repair record on a stable Project event for fixed-watermark repair", async () => {
    const snapshot = projectSnapshot();
    const projectRecords: readonly RoomRepairRecord[] = [
      ...records, { kind: "project-loop", roomId: "room-1", value: snapshot },
    ];
    const checksum = authoritySnapshotChecksum("room", projectRecords);
    const cache = createDesktopAuthorityCache();
    cache.beginRoom("room-1", "project-snapshot");
    cache.stageRoomPage({ ...page(), snapshotId: "project-snapshot", records: projectRecords,
      snapshotChecksum: checksum });
    expect(await cache.finalizeRoom("project-snapshot", checksum)).toBe(true);
    cache.commitRoom("room-1", snapshot.watermark, checksum);
    expect(cache.roomRepairRecords("room-1")?.some((record) => record.kind === "project-loop")).toBe(true);
    const request = snapshot.requests[0]!;
    cache.applyRoomEvents("room-1", [{
      eventId: "project-event-8", streamKind: "room", streamId: "room-1", streamSeq: 8,
      roomId: "room-1", projectId: "room-1", actorId: "human-2",
      occurredAt: "2026-08-25T03:03:04.005Z", type: "project.request.changed", payload: request,
    }], { version: 1, roomId: "room-1", afterSeq: 8 });
    expect(cache.roomRepairRecords("room-1")?.some((record) => record.kind === "project-loop")).toBe(false);
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

  it("projects every canonical invocation stable event onto the same identities used by repair", async () => {
    const occurredAt = "2026-08-25T00:00:00.000Z";
    const intent = {
      intentId: "intent-1", lineageId: "lineage-1", turnId: "turn-1", roomId: "room-1",
      sourceMessageId: "message-1", sourceRevision: 1, targetId: "target-1", agentId: "agent-1",
      origin: { kind: "message_target" as const, messageTransactionId: "message-1", targetId: "target-1" },
      profileRevision: 1, assignmentRevision: 1, accessRevision: 1,
      status: "claimed" as const, createdAt: occurredAt, claimedAt: occurredAt,
    };
    const execution = {
      executionId: "execution-1", intentId: intent.intentId, lineageId: intent.lineageId,
      executionOrdinal: 1, roomId: intent.roomId, agentId: intent.agentId,
      snapshotId: "snapshot-1", providerId: "provider-1", modelId: "model-1",
      status: "running" as const, phase: "waiting_confirmation" as const,
      currentAttemptSeq: 1, version: 2, queuedAt: occurredAt, startedAt: occurredAt,
      updatedAt: occurredAt,
    };
    const attempt = {
      executionId: execution.executionId, intentId: intent.intentId, lineageId: intent.lineageId,
      roomId: intent.roomId, agentId: intent.agentId, attemptSeq: 1,
      snapshotId: execution.snapshotId, providerId: execution.providerId, modelId: execution.modelId,
      status: "running" as const, phase: "waiting_confirmation" as const,
      executionVersion: 2, startedAt: occurredAt, updatedAt: occurredAt,
    };
    const retry = {
      requestId: "retry-1", sourceExecutionId: execution.executionId,
      executionId: "execution-2", intentId: intent.intentId, lineageId: intent.lineageId,
      roomId: intent.roomId, executionOrdinal: 2, snapshotId: execution.snapshotId,
      status: "accepted" as const, createdAt: occurredAt,
    };
    const cancellation = {
      requestId: "cancel-1", fenceId: "fence-1", roomId: intent.roomId,
      lineageId: intent.lineageId,
      scope: { kind: "execution" as const, executionId: execution.executionId, expectedVersion: 2 },
      reason: "human_cancelled" as const,
      intentOutcomes: [{ intentId: intent.intentId, outcome: "already_claimed" as const }],
      executionOutcomes: [{ executionId: execution.executionId, outcome: "cancelled" as const, version: 3 }],
      rejectedConfirmationIds: ["confirmation-1"], revokedGrantIds: ["grant-1"],
      preservedDispatchIds: [], committedAt: occurredAt,
    };
    const boundary = {
      boundaryId: "boundary-1", roomId: intent.roomId, status: "suppressed" as const,
      reason: "dependency_unavailable" as const, decidedAt: occurredAt,
    };
    const cache = createDesktopAuthorityCache();
    const seed = page();
    cache.beginRoom("room-1", seed.snapshotId);
    cache.stageRoomPage(seed);
    expect(await cache.finalizeRoom(seed.snapshotId, seed.snapshotChecksum)).toBe(true);
    cache.commitRoom("room-1", seed.watermark, seed.snapshotChecksum);
    const event = <T extends PersistedRoomEvent["type"]>(
      streamSeq: number,
      type: T,
      payload: Extract<PersistedRoomEvent, { readonly type: T }>["payload"],
    ): Extract<PersistedRoomEvent, { readonly type: T }> => ({
      eventId: `event-${streamSeq}`, streamKind: "room", streamId: "room-1", streamSeq,
      roomId: "room-1", actorId: type.startsWith("agent.execution") ? "agent-1" : "human-1",
      occurredAt, type, payload,
    } as Extract<PersistedRoomEvent, { readonly type: T }>);
    const events = [
      event(10, "agent.invocation.intent.changed", intent),
      event(11, "agent.execution.changed", execution),
      event(12, "agent.execution.attempt.changed", attempt),
      event(13, "agent.execution.retry.accepted", retry),
      event(14, "agent.invocation.scoped-cancellation.committed", cancellation),
      event(15, "project.boundary.invocation.decided", boundary),
    ];
    cache.applyRoomEvents("room-1", events, { version: 1, roomId: "room-1", afterSeq: 15 });

    expect(cache.roomRepairRecords("room-1")?.slice(-6)).toEqual([
      { kind: "agent-invocation-intent", value: intent },
      { kind: "agent-execution", value: execution },
      { kind: "agent-execution-attempt", value: attempt },
      { kind: "agent-execution-retry", value: retry },
      { kind: "agent-scoped-cancellation", value: cancellation },
      { kind: "project-boundary-invocation", value: boundary },
    ]);
  });
});
