import { isRoomGovernanceView, type RoomRepairRecord } from "@native-im/core";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import type {
  RepairKeysetPageInput,
  RoomRepairSegmentDescriptor,
} from "../persistence/repair-projection-registry.js";
import type {
  AuthorityParticipantEnvelope,
  AuthorityParticipantFailureReason,
  AuthorityTransactionView,
  LifecycleRepairDescriptor,
  LifecycleRepairDescriptorResult,
  ParticipantRegistration,
} from "./private-participant-contracts.js";

const FEATURE = "lifecycle-repair" as const;
const DESCRIPTOR_ID = "dao.repair.governance.v1";

type RoomRepairKind = RoomRepairRecord["kind"];

interface LifecycleRow {
  readonly id: unknown;
  readonly status: unknown;
  readonly ownerActorId: unknown;
  readonly governanceRevision: unknown;
  readonly archiveGeneration: unknown;
  readonly archivedAt: unknown;
}

class LifecycleRepairInputMismatchError extends Error {
  constructor() {
    super("Lifecycle repair input does not match authority state");
    Object.defineProperty(this, "name", { value: "LifecycleRepairInputMismatchError" });
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readLifecycleRow(
  input: RepairKeysetPageInput,
): readonly LifecycleRow[] {
  if (input.afterKey !== undefined || input.limit < 1) return [];
  const row = input.database.prepare(
    `SELECT id, status, owner_actor_id AS ownerActorId,
            governance_revision AS governanceRevision,
            archive_generation AS archiveGeneration, archived_at AS archivedAt
     FROM rooms WHERE id = ?`,
  ).get(input.roomId) as LifecycleRow | undefined;
  return row === undefined ? [] : [row];
}

function mapLifecycleRow(row: unknown): RoomRepairRecord {
  if (typeof row !== "object" || row === null) {
    throw new LifecycleRepairInputMismatchError();
  }
  const value = row as LifecycleRow;
  const governance = {
    roomId: value.id,
    projectId: value.id,
    lifecycle: value.status,
    governanceRevision: value.governanceRevision,
    ownerActorId: value.ownerActorId,
    archiveGeneration: value.archiveGeneration,
    ...(value.status === "archived" ? { archivedAt: value.archivedAt } : {}),
  };
  if (!isRoomGovernanceView(governance)) {
    throw new LifecycleRepairInputMismatchError();
  }
  return Object.freeze({ kind: "governance" as const, value: Object.freeze(governance) });
}

function lifecycleStableKey(record: RoomRepairRecord): string {
  if (record.kind !== "governance" || !isRoomGovernanceView(record.value)) {
    throw new LifecycleRepairInputMismatchError();
  }
  return record.value.roomId;
}

export const lifecycleRepairSegmentDescriptor = Object.freeze({
  descriptorId: DESCRIPTOR_ID,
  descriptorVersion: 1,
  kind: "governance",
  order: 1,
  readKeysetPage: readLifecycleRow,
  mapRow: mapLifecycleRow,
  stableKey: lifecycleStableKey,
}) satisfies RoomRepairSegmentDescriptor<RoomRepairKind, RoomRepairRecord>;

function fail(
  reason: AuthorityParticipantFailureReason,
): AuthorityParticipantEnvelope<LifecycleRepairDescriptorResult> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      httpStatus: 503 as const,
      code: "dependency_unavailable" as const,
      dependency: FEATURE,
      reason,
      retryable: true as const,
    }),
  });
}

function describeLifecycleInTransaction(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; lifecycleGeneration: number }>,
): AuthorityParticipantEnvelope<LifecycleRepairDescriptorResult> {
  if (!isNonEmptyString(input.roomId) ||
    !isNonNegativeInteger(input.lifecycleGeneration) ||
    transaction.roomId !== input.roomId) {
    return fail("transaction_mismatch");
  }

  try {
    return useAuthorityTransactionDatabase(transaction, (database) => {
      const rows = lifecycleRepairSegmentDescriptor.readKeysetPage({
        database,
        roomId: input.roomId,
        watermark: 0,
        afterKey: undefined,
        limit: 1,
      });
      if (rows.length !== 1) throw new LifecycleRepairInputMismatchError();
      const record = lifecycleRepairSegmentDescriptor.mapRow(rows[0]);
      if (record.kind !== "governance" ||
        record.value.archiveGeneration !== input.lifecycleGeneration) {
        throw new LifecycleRepairInputMismatchError();
      }
      return Object.freeze({
        ok: true as const,
        result: Object.freeze({
          roomId: input.roomId,
          lifecycleGeneration: input.lifecycleGeneration,
          descriptorId: lifecycleRepairSegmentDescriptor.descriptorId,
          descriptorVersion: lifecycleRepairSegmentDescriptor.descriptorVersion,
          sortKey: lifecycleRepairSegmentDescriptor.stableKey(record),
          recordCount: 1,
        }),
      });
    });
  } catch (error: unknown) {
    return fail(error instanceof LifecycleRepairInputMismatchError
      ? "transaction_mismatch"
      : "participant_threw");
  }
}

export function createLifecycleRepairDescriptor(): LifecycleRepairDescriptor {
  return Object.freeze({ describeLifecycleInTransaction });
}

const productionLifecycleRepairDescriptor = createLifecycleRepairDescriptor();

export const lifecycleRepairDescriptorRegistration:
ParticipantRegistration<LifecycleRepairDescriptor> = Object.freeze({
  registrationId: "dao.room-governance.lifecycle-repair.v1",
  feature: FEATURE,
  version: 1,
  enabled: true,
  participant: productionLifecycleRepairDescriptor,
});
