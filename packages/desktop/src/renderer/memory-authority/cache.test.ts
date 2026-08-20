import type {
  RoomMemoryRepairRecord,
  RoomMemorySourceView,
  RoomMemoryStatus,
  RoomMemoryVersionProjection,
} from "@native-im/core";
import { describe, expect, it } from "vitest";
import { createMemoryAuthorityCache } from "./cache.js";

const at = "2026-08-19T08:00:00.000Z";
const status = (watermark = 1): RoomMemoryStatus => ({
  roomId: "room-1",
  health: { state: "healthy", reason: "none", memoryWatermark: watermark,
    corpusHead: watermark, lag: 0, lastAttemptAt: at, retryable: false, recoveryRequired: false },
  recoveryGeneration: 1, updatedAt: at,
});
const source: RoomMemorySourceView = {
  roomId: "room-1", sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
  corpusSeq: 1, occurredAt: at, eligibility: "eligible", availability: "readable",
  metadata: { speakerActorId: "human-1", speakerKind: "human", provenance: null },
  navigation: { kind: "message", messageId: "message-1" },
};
const projection = (version = 1): RoomMemoryVersionProjection => ({
  projectionKind: "memory", roomId: "room-1", memoryRecordId: "memory-1", kind: "context",
  currentVersion: { roomId: "room-1", memoryRecordId: "memory-1",
    memoryVersionId: `memory-version-${version}`, version, kind: "context", state: "active",
    derivedText: `Version ${version}`, sourceRefs: [{ sourceKind: "message",
      sourceId: "message:message-1", sourceRevision: 1, eligibility: "eligible", availability: "readable" }],
    createdAt: at, replacesMemoryVersionId: version === 1 ? null : `memory-version-${version - 1}` },
  disputes: [], resolutions: [],
});

describe("Memory Authority authorized complete cache", () => {
  it("purges immediately on accessEpoch advance and fences old async replacement", () => {
    const cache = createMemoryAuthorityCache();
    expect(cache.replace({ roomId: "room-1", accessEpoch: 4,
      projections: [projection()], status: status(), sources: [source] })).toBe(true);
    expect(cache.snapshot("room-1")?.projections).toHaveLength(1);
    cache.advanceEpoch("room-1", 5);
    expect(cache.snapshot("room-1")).toBeUndefined();
    expect(cache.replace({ roomId: "room-1", accessEpoch: 4,
      projections: [projection(2)], status: status(2), sources: [source] })).toBe(false);
    expect(cache.snapshot("room-1")).toBeUndefined();
    expect(cache.epoch("room-1")).toBe(5);
    cache.replace({ roomId: "room-1", accessEpoch: 5,
      projections: [projection(2)], status: status(2), sources: [source] });
    cache.purge("room-1", 4);
    expect(cache.snapshot("room-1")?.accessEpoch).toBe(5);
  });

  it("keeps the last complete authorized cache through offline and failed repair staging", () => {
    const cache = createMemoryAuthorityCache();
    cache.replace({ roomId: "room-1", accessEpoch: 2,
      projections: [projection()], status: status(), sources: [source] });
    cache.beginRepair("room-1", 2, 7);
    cache.stageRepair("room-1", 2, 7, [
      { kind: "memory", roomId: "room-1", value: { recordType: "projection", projection: projection(2) } },
    ]);
    cache.failRepair("room-1", 2, 7);
    expect(cache.snapshot("room-1")?.projections[0]).toMatchObject({
      projectionKind: "memory", currentVersion: { version: 1 },
    });
  });

  it("atomically commits one complete repair and rejects incomplete source coverage", () => {
    const cache = createMemoryAuthorityCache();
    cache.replace({ roomId: "room-1", accessEpoch: 2,
      projections: [projection()], status: status(), sources: [source] });
    const records: readonly RoomMemoryRepairRecord[] = [
      { kind: "memory", roomId: "room-1", value: { recordType: "projection", projection: projection(2) } },
      { kind: "memory", roomId: "room-1", value: { recordType: "status", status: status(2) } },
    ];
    cache.beginRepair("room-1", 2, 8);
    cache.stageRepair("room-1", 2, 8, records);
    expect(() => cache.commitRepair("room-1", 2, 8, [])).toThrow(TypeError);
    expect(cache.snapshot("room-1")?.projections[0]).toMatchObject({ currentVersion: { version: 1 } });
    cache.beginRepair("room-1", 2, 9);
    cache.stageRepair("room-1", 2, 9, records);
    cache.commitRepair("room-1", 2, 9, [source]);
    expect(cache.snapshot("room-1")).toMatchObject({
      accessEpoch: 2,
      projections: [{ currentVersion: { version: 2 } }],
      status: { health: { memoryWatermark: 2 } },
    });
  });

  it("purges projections, sources, and repair staging on revoke", () => {
    const cache = createMemoryAuthorityCache();
    cache.replace({ roomId: "room-1", accessEpoch: 2,
      projections: [projection()], status: status(), sources: [source] });
    cache.beginRepair("room-1", 2, 2);
    cache.purge("room-1", 3);
    expect(cache.snapshot("room-1")).toBeUndefined();
    expect(cache.epoch("room-1")).toBe(3);
    expect(() => cache.stageRepair("room-1", 2, 2, [])).toThrow(TypeError);
  });
});
