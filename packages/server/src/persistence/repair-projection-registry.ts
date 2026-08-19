import type { DatabaseSync } from "node:sqlite";

export type RepairProjectionRegistryFailureReason =
  | "invalid_known_kinds"
  | "malformed_descriptor"
  | "missing_kind"
  | "unknown_kind"
  | "duplicate_kind"
  | "duplicate_descriptor_id"
  | "duplicate_order"
  | "cross_kind_record"
  | "unstable_page";

export class RepairProjectionRegistryError extends Error {
  readonly reason: RepairProjectionRegistryFailureReason;

  constructor(reason: RepairProjectionRegistryFailureReason) {
    super(`Repair projection registry rejected: ${reason}`);
    this.name = "RepairProjectionRegistryError";
    this.reason = reason;
  }
}

export interface RepairKeysetPageInput {
  readonly database: DatabaseSync;
  readonly roomId: string;
  readonly watermark: number;
  readonly afterKey: string | undefined;
  readonly limit: number;
}

export interface RoomRepairSegmentDescriptor<
  TKind extends string,
  TRecord extends Readonly<{ kind: TKind }>,
> {
  readonly descriptorId: string;
  readonly descriptorVersion: 1;
  readonly kind: TKind;
  readonly order: number;
  readonly readKeysetPage: (input: RepairKeysetPageInput) => readonly unknown[];
  readonly mapRow: (row: unknown) => TRecord;
  readonly stableKey: (record: TRecord) => string;
}

export interface ReadRegisteredRepairPageInput<TKind extends string>
  extends RepairKeysetPageInput {
  readonly kind: TKind;
}

export interface ClosedRepairProjectionRegistry<
  TKind extends string,
  TRecord extends Readonly<{ kind: TKind }>,
> {
  readonly descriptors: readonly RoomRepairSegmentDescriptor<TKind, TRecord>[];
  descriptorFor(kind: TKind): RoomRepairSegmentDescriptor<TKind, TRecord>;
  readStablePage(input: ReadRegisteredRepairPageInput<TKind>): readonly TRecord[];
}

function reject(reason: RepairProjectionRegistryFailureReason): never {
  throw new RepairProjectionRegistryError(reason);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createClosedRepairProjectionRegistry<
  TKind extends string,
  TRecord extends Readonly<{ kind: TKind }>,
>(options: Readonly<{
  knownKinds: readonly TKind[];
  descriptors: readonly RoomRepairSegmentDescriptor<TKind, TRecord>[];
}>): ClosedRepairProjectionRegistry<TKind, TRecord> {
  if (!Array.isArray(options.knownKinds) || options.knownKinds.length === 0 ||
    !options.knownKinds.every(isNonEmptyString) ||
    new Set(options.knownKinds).size !== options.knownKinds.length) {
    reject("invalid_known_kinds");
  }

  const knownKinds = new Set<string>(options.knownKinds);
  const descriptorIds = new Set<string>();
  const descriptorKinds = new Set<string>();
  const orders = new Set<number>();
  const indexed = new Map<TKind, RoomRepairSegmentDescriptor<TKind, TRecord>>();

  for (const descriptor of options.descriptors) {
    if (typeof descriptor !== "object" || descriptor === null ||
      !isNonEmptyString(descriptor.descriptorId) || descriptor.descriptorVersion !== 1 ||
      !isNonEmptyString(descriptor.kind) || !isNonNegativeSafeInteger(descriptor.order) ||
      typeof descriptor.readKeysetPage !== "function" || typeof descriptor.mapRow !== "function" ||
      typeof descriptor.stableKey !== "function") {
      reject("malformed_descriptor");
    }
    if (!knownKinds.has(descriptor.kind)) reject("unknown_kind");
    if (descriptorIds.has(descriptor.descriptorId)) reject("duplicate_descriptor_id");
    if (descriptorKinds.has(descriptor.kind)) reject("duplicate_kind");
    if (orders.has(descriptor.order)) reject("duplicate_order");
    descriptorIds.add(descriptor.descriptorId);
    descriptorKinds.add(descriptor.kind);
    orders.add(descriptor.order);
    indexed.set(descriptor.kind as TKind, Object.freeze({ ...descriptor }));
  }

  if (options.knownKinds.some((kind) => !indexed.has(kind as TKind))) reject("missing_kind");

  const descriptors = Object.freeze([...indexed.values()].sort((left, right) =>
    left.order - right.order || left.kind.localeCompare(right.kind)));

  const descriptorFor = (kind: TKind): RoomRepairSegmentDescriptor<TKind, TRecord> => {
    const descriptor = indexed.get(kind);
    if (descriptor === undefined) reject("unknown_kind");
    return descriptor;
  };

  return Object.freeze({
    descriptors,
    descriptorFor,
    readStablePage(input: ReadRegisteredRepairPageInput<TKind>): readonly TRecord[] {
      if (!isNonEmptyString(input.roomId) || !isNonNegativeSafeInteger(input.watermark) ||
        !Number.isSafeInteger(input.limit) || input.limit <= 0 ||
        (input.afterKey !== undefined && !isNonEmptyString(input.afterKey))) {
        reject("unstable_page");
      }
      const descriptor = descriptorFor(input.kind);
      const rows = descriptor.readKeysetPage(input);
      if (!Array.isArray(rows) || rows.length > input.limit) reject("unstable_page");

      const records: TRecord[] = [];
      let previousKey = input.afterKey;
      for (const row of rows) {
        const record = descriptor.mapRow(row);
        if (typeof record !== "object" || record === null || record.kind !== input.kind) {
          reject("cross_kind_record");
        }
        const key = descriptor.stableKey(record);
        if (!isNonEmptyString(key) || (previousKey !== undefined && key <= previousKey)) {
          reject("unstable_page");
        }
        previousKey = key;
        records.push(record);
      }
      return Object.freeze(records);
    },
  });
}
