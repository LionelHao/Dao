import { isProjectRepairRecord, type ProjectRepairRecord, type ProjectSnapshot,
  type RoomRepairRecord } from "@native-im/core";
import type { DatabaseSync } from "node:sqlite";
import type { RepairKeysetPageInput, RoomRepairSegmentDescriptor } from
  "../persistence/repair-projection-registry.js";

export interface ProjectLoopRepairSnapshotReader {
  (database: DatabaseSync, input: Readonly<{ roomId: string; projectId: string; watermark: number;
    afterEventSeq: number; limit: number }>): Readonly<{ snapshot: ProjectSnapshot }>;
}

export function createProjectLoopRepairSegmentDescriptor(
  readSnapshot: ProjectLoopRepairSnapshotReader,
): RoomRepairSegmentDescriptor<RoomRepairRecord["kind"], RoomRepairRecord> {
  return Object.freeze({
    descriptorId: "dao.repair.project-loop.v1",
    descriptorVersion: 1 as const,
    kind: "project-loop" as const,
    order: 18,
    readKeysetPage(input: RepairKeysetPageInput) {
      if (input.afterKey !== undefined) return [];
      const result = readSnapshot(input.database, { roomId: input.roomId, projectId: input.roomId,
        watermark: input.watermark, afterEventSeq: 0, limit: 256 });
      return [{ kind: "project-loop", roomId: input.roomId, value: result.snapshot }];
    },
    mapRow(row: unknown): ProjectRepairRecord {
      if (!isProjectRepairRecord(row)) throw new TypeError("Project Loop repair snapshot is invalid");
      return structuredClone(row);
    },
    stableKey(record: RoomRepairRecord): string {
      if (!isProjectRepairRecord(record)) throw new TypeError("Project Loop repair snapshot is invalid");
      return record.roomId;
    },
  });
}
