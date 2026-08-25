import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createProjectLoopRepairSegmentDescriptor } from "./repair-descriptor.js";

const snapshot = { recordVersion: "project-loop.v1" as const, roomId: "room-1", projectId: "room-1",
  watermark: 7, goals: [], decisions: [], requests: [], obstacles: [], nextActions: [], proposals: [],
  confirmations: [], transferProposals: [], balls: [], capturedAt: "2026-08-25T00:00:00.000Z" };

describe("FT-09 Project Loop stable repair descriptor", () => {
  it("reads one canonical Room===Project record through the frozen-watermark authority seam", () => {
    const reader = vi.fn(() => ({ snapshot }));
    const descriptor = createProjectLoopRepairSegmentDescriptor(reader);
    const database = new DatabaseSync(":memory:");
    const rows = descriptor.readKeysetPage({ database, roomId: "room-1", watermark: 7,
      afterKey: undefined, limit: 1 });
    expect(reader).toHaveBeenCalledWith(database, { roomId: "room-1", projectId: "room-1",
      watermark: 7, afterEventSeq: 0, limit: 256 });
    expect(rows).toEqual([{ kind: "project-loop", roomId: "room-1", value: snapshot }]);
    expect(descriptor.stableKey(descriptor.mapRow(rows[0]))).toBe("room-1");
    expect(descriptor.readKeysetPage({ database, roomId: "room-1", watermark: 7,
      afterKey: "room-1", limit: 1 })).toEqual([]);
    database.close();
  });

  it("rejects malformed or cross-room authority results instead of emitting partial repair", () => {
    const descriptor = createProjectLoopRepairSegmentDescriptor(() => ({ snapshot }));
    expect(() => descriptor.mapRow({ kind: "project-loop", roomId: "room-2", value: snapshot })).toThrow();
    expect(() => descriptor.mapRow({ kind: "project-loop", roomId: "room-1",
      value: { ...snapshot, proposals: [{ proposalId: "forged" }] } })).toThrow();
  });
});
