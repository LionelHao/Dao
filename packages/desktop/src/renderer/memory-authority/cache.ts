import {
  isRoomMemoryProjection,
  isRoomMemoryRepairRecord,
  isRoomMemorySourceView,
  isRoomMemoryStatus,
  type RoomMemoryProjection,
  type RoomMemoryRepairRecord,
  type RoomMemorySourceView,
  type RoomMemoryStatus,
  type RoomMemoryVersionSourceRef,
} from "@native-im/core";

export type MemoryAuthorityCompleteSnapshot = Readonly<{
  roomId: string;
  accessEpoch: number;
  projections: readonly RoomMemoryProjection[];
  status: RoomMemoryStatus;
  sources: readonly RoomMemorySourceView[];
}>;

export interface MemoryAuthorityCache {
  replace(input: MemoryAuthorityCompleteSnapshot): boolean;
  snapshot(roomId: string): MemoryAuthorityCompleteSnapshot | undefined;
  epoch(roomId: string): number | undefined;
  advanceEpoch(roomId: string, accessEpoch: number): void;
  beginRepair(roomId: string, accessEpoch: number, generation: number): void;
  stageRepair(
    roomId: string,
    accessEpoch: number,
    generation: number,
    records: readonly RoomMemoryRepairRecord[],
  ): void;
  commitRepair(
    roomId: string,
    accessEpoch: number,
    generation: number,
    sources: readonly RoomMemorySourceView[],
  ): void;
  failRepair(roomId: string, accessEpoch: number, generation: number): void;
  purge(roomId: string, accessEpoch: number): void;
}

type RepairStage = {
  readonly roomId: string;
  readonly accessEpoch: number;
  readonly generation: number;
  records: RoomMemoryRepairRecord[];
};

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function sourceKey(source: Pick<RoomMemorySourceView, "sourceKind" | "sourceId" | "sourceRevision">): string {
  return `${source.sourceKind}\u0000${source.sourceId}\u0000${source.sourceRevision}`;
}

function projectionKey(projection: RoomMemoryProjection): string {
  return `${projection.projectionKind}\u0000${projection.memoryRecordId}`;
}

function sourceRefs(projection: RoomMemoryProjection): readonly RoomMemoryVersionSourceRef[] {
  return projection.projectionKind === "memory"
    ? projection.currentVersion.sourceRefs
    : projection.sourceRefs;
}

function validateComplete(input: MemoryAuthorityCompleteSnapshot): void {
  if (!isIdentifier(input.roomId) || !isPositiveSafeInteger(input.accessEpoch) ||
      !Array.isArray(input.projections) || input.projections.length > 5_000 ||
      !Array.isArray(input.sources) || input.sources.length > 50_000 ||
      !isRoomMemoryStatus(input.status) || input.status.roomId !== input.roomId) {
    throw new TypeError("Invalid complete Memory Authority snapshot");
  }
  const projectionKeys = new Set<string>();
  for (const projection of input.projections) {
    if (!isRoomMemoryProjection(projection) || projection.roomId !== input.roomId) {
      throw new TypeError("Invalid Memory Authority projection");
    }
    const key = projectionKey(projection);
    if (projectionKeys.has(key)) throw new TypeError("Duplicate Memory Authority projection");
    projectionKeys.add(key);
  }
  const sources = new Map<string, RoomMemorySourceView>();
  for (const source of input.sources) {
    if (!isRoomMemorySourceView(source) || source.roomId !== input.roomId) {
      throw new TypeError("Invalid Memory Authority source");
    }
    const key = sourceKey(source);
    if (sources.has(key)) throw new TypeError("Duplicate Memory Authority source");
    sources.set(key, source);
  }
  for (const projection of input.projections) {
    for (const sourceRef of sourceRefs(projection)) {
      const exactSource = sources.get(sourceKey(sourceRef));
      if (exactSource === undefined || exactSource.eligibility !== sourceRef.eligibility ||
          exactSource.availability !== sourceRef.availability) {
        throw new TypeError("Incomplete or stale Memory Authority source coverage");
      }
    }
  }
}

function cloneSnapshot(input: MemoryAuthorityCompleteSnapshot): MemoryAuthorityCompleteSnapshot {
  return structuredClone(input);
}

function repairKey(roomId: string, accessEpoch: number, generation: number): string {
  return `${roomId}\u0000${accessEpoch}\u0000${generation}`;
}

export function createMemoryAuthorityCache(): MemoryAuthorityCache {
  const epochs = new Map<string, number>();
  const snapshots = new Map<string, MemoryAuthorityCompleteSnapshot>();
  const repairs = new Map<string, RepairStage>();

  const requireCurrentRepair = (roomId: string, accessEpoch: number, generation: number): RepairStage => {
    if (!isIdentifier(roomId) || !isPositiveSafeInteger(accessEpoch) ||
        !isNonnegativeSafeInteger(generation) || epochs.get(roomId) !== accessEpoch) {
      throw new TypeError("Stale Memory Authority repair");
    }
    const repair = repairs.get(repairKey(roomId, accessEpoch, generation));
    if (repair === undefined) throw new TypeError("Unknown Memory Authority repair");
    return repair;
  };

  const cache: MemoryAuthorityCache = {
    replace(input): boolean {
      const currentEpoch = epochs.get(input.roomId);
      if (currentEpoch !== undefined && input.accessEpoch < currentEpoch) return false;
      validateComplete(input);
      if (currentEpoch === undefined || input.accessEpoch > currentEpoch) {
        snapshots.delete(input.roomId);
        for (const [key, repair] of repairs) {
          if (repair.roomId === input.roomId) repairs.delete(key);
        }
        epochs.set(input.roomId, input.accessEpoch);
      }
      snapshots.set(input.roomId, cloneSnapshot(input));
      return true;
    },
    snapshot(roomId): MemoryAuthorityCompleteSnapshot | undefined {
      const snapshot = snapshots.get(roomId);
      return snapshot === undefined ? undefined : cloneSnapshot(snapshot);
    },
    epoch(roomId): number | undefined {
      return epochs.get(roomId);
    },
    advanceEpoch(roomId, accessEpoch): void {
      if (!isIdentifier(roomId) || !isPositiveSafeInteger(accessEpoch)) {
        throw new TypeError("Invalid Memory Authority access epoch");
      }
      const current = epochs.get(roomId);
      if (current !== undefined && accessEpoch <= current) return;
      epochs.set(roomId, accessEpoch);
      snapshots.delete(roomId);
      for (const [key, repair] of repairs) {
        if (repair.roomId === roomId) repairs.delete(key);
      }
    },
    beginRepair(roomId, accessEpoch, generation): void {
      if (!isIdentifier(roomId) || !isPositiveSafeInteger(accessEpoch) ||
          !isNonnegativeSafeInteger(generation) || epochs.get(roomId) !== accessEpoch) {
        throw new TypeError("Stale Memory Authority repair");
      }
      for (const [key, repair] of repairs) {
        if (repair.roomId === roomId && repair.accessEpoch === accessEpoch) repairs.delete(key);
      }
      repairs.set(repairKey(roomId, accessEpoch, generation), {
        roomId,
        accessEpoch,
        generation,
        records: [],
      });
    },
    stageRepair(roomId, accessEpoch, generation, records): void {
      const repair = requireCurrentRepair(roomId, accessEpoch, generation);
      if (!Array.isArray(records) || repair.records.length + records.length > 5_000 ||
          !records.every((record) => isRoomMemoryRepairRecord(record, roomId))) {
        throw new TypeError("Invalid Memory Authority repair records");
      }
      repair.records.push(...structuredClone(records));
    },
    commitRepair(roomId, accessEpoch, generation, sources): void {
      const repair = requireCurrentRepair(roomId, accessEpoch, generation);
      const projections: RoomMemoryProjection[] = [];
      const statuses: RoomMemoryStatus[] = [];
      for (const record of repair.records) {
        if (record.value.recordType === "projection") projections.push(record.value.projection);
        else statuses.push(record.value.status);
      }
      if (statuses.length !== 1) throw new TypeError("Repair must contain exactly one Memory status");
      const status = statuses[0];
      if (status === undefined) throw new TypeError("Repair status unavailable");
      const snapshot: MemoryAuthorityCompleteSnapshot = {
        roomId,
        accessEpoch,
        projections,
        status,
        sources,
      };
      validateComplete(snapshot);
      snapshots.set(roomId, cloneSnapshot(snapshot));
      repairs.delete(repairKey(roomId, accessEpoch, generation));
    },
    failRepair(roomId, accessEpoch, generation): void {
      requireCurrentRepair(roomId, accessEpoch, generation);
      repairs.delete(repairKey(roomId, accessEpoch, generation));
    },
    purge(roomId, accessEpoch): void {
      if (!isIdentifier(roomId) || !isPositiveSafeInteger(accessEpoch)) {
        throw new TypeError("Invalid Memory Authority purge epoch");
      }
      const current = epochs.get(roomId);
      if (current !== undefined && accessEpoch < current) return;
      epochs.set(roomId, accessEpoch);
      snapshots.delete(roomId);
      for (const [key, repair] of repairs) {
        if (repair.roomId === roomId) repairs.delete(key);
      }
    },
  };
  return Object.freeze(cache);
}
