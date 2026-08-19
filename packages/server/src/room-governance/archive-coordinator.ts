import type { RoomGovernanceView } from "@native-im/core";
import type { DatabaseSync } from "node:sqlite";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import type {
  ArchiveSettlementResult,
  ArchivedMessageGateResult,
  AssignmentSecurityReductionResult,
  AuthorityTransactionView,
  BusinessTimerSuspensionResult,
  FeatureEnablementManifest,
  LifecycleRepairDescriptorResult,
  OfflineLeaseInvalidationResult,
  RoomCacheInvalidationResult,
  RuntimeArchiveFenceResult,
} from "./private-participant-contracts.js";
import {
  AuthorityParticipantUnavailableError,
  invokeAccessInvalidationPort,
  invokeAuthorityParticipant,
  invokeLifecycleRepairDescriptor,
} from "./private-participant-registry.js";

export interface ArchiveCoordinatorComposition {
  readonly manifest: FeatureEnablementManifest;
  readonly transactionRegistrations: readonly unknown[];
  readonly lifecycleRepairRegistrations: readonly unknown[];
  readonly accessInvalidationRegistrations: readonly unknown[];
}

export interface ArchiveCoordinatorCommandInput {
  readonly roomId: string;
  readonly actorId: string;
  readonly expectedGovernanceRevision: number;
  readonly occurredAt: string;
}

export type ArchiveCoordinatorCommandErrorCode =
  | "invalid_request"
  | "room_not_found"
  | "role_forbidden"
  | "room_revision_conflict"
  | "storage_unavailable"
  | "transaction_mismatch";

export class ArchiveCoordinatorCommandError extends Error {
  readonly code: ArchiveCoordinatorCommandErrorCode;

  constructor(code: ArchiveCoordinatorCommandErrorCode, message: string) {
    super(message);
    this.name = "ArchiveCoordinatorCommandError";
    this.code = code;
  }
}

export interface ArchiveCoordinatorParticipants {
  readonly archivedMessageGate: ArchivedMessageGateResult;
  readonly businessTimers: BusinessTimerSuspensionResult;
  readonly toolSafetySettlement: ArchiveSettlementResult;
  readonly runtimeFence: RuntimeArchiveFenceResult;
  readonly assignmentSecurity: AssignmentSecurityReductionResult;
  readonly lifecycleRepair: LifecycleRepairDescriptorResult;
  readonly roomCacheInvalidation: RoomCacheInvalidationResult;
  readonly offlineLeaseInvalidation: OfflineLeaseInvalidationResult;
}

export type ArchiveCoordinatorResult =
  | Readonly<{
      readonly outcome: "applied";
      readonly governance: RoomGovernanceView;
      readonly participants: ArchiveCoordinatorParticipants;
    }>
  | Readonly<{
      readonly outcome: "already_archived";
      readonly governance: RoomGovernanceView;
    }>;

export interface ReopenCoordinatorParticipants {
  readonly businessTimers: BusinessTimerSuspensionResult;
  readonly lifecycleRepair: LifecycleRepairDescriptorResult;
}

export interface ReopenAfterCommitRescan {
  readonly roomId: string;
  readonly lifecycleGeneration: number;
  readonly governanceRevision: number;
  readonly reason: "room_reopened";
}

export type ReopenCoordinatorResult =
  | Readonly<{
      readonly outcome: "applied";
      readonly governance: RoomGovernanceView;
      readonly participants: ReopenCoordinatorParticipants;
      readonly afterCommitRescan: ReopenAfterCommitRescan;
    }>
  | Readonly<{
      readonly outcome: "already_active";
      readonly governance: RoomGovernanceView;
    }>;

interface GovernanceAuthorityRow {
  readonly id: unknown;
  readonly status: unknown;
  readonly ownerActorId: unknown;
  readonly governanceRevision: unknown;
  readonly archiveGeneration: unknown;
  readonly archivedAt: unknown;
  readonly actorKind: unknown;
  readonly membershipKind: unknown;
  readonly membershipRole: unknown;
}

function commandError(
  code: ArchiveCoordinatorCommandErrorCode,
  message: string,
): never {
  throw new ArchiveCoordinatorCommandError(code, message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateInput(
  transaction: AuthorityTransactionView,
  input: ArchiveCoordinatorCommandInput,
): void {
  if (transaction.roomId !== input.roomId) {
    commandError("transaction_mismatch", "Archive command transaction does not match the room");
  }
  if (!isNonEmptyString(input.roomId) || !isNonEmptyString(input.actorId) ||
    !isNonNegativeInteger(input.expectedGovernanceRevision) ||
    !isNonEmptyString(input.occurredAt) || !Number.isFinite(Date.parse(input.occurredAt))) {
    commandError("invalid_request", "Archive command input is invalid");
  }
}

function readAuthorityRow(
  database: DatabaseSync,
  roomId: string,
  actorId: string,
): GovernanceAuthorityRow {
  const row = database.prepare(
    `SELECT room.id, room.status, room.owner_actor_id AS ownerActorId,
            room.governance_revision AS governanceRevision,
            room.archive_generation AS archiveGeneration,
            room.archived_at AS archivedAt,
            actor.kind AS actorKind,
            membership.kind AS membershipKind,
            membership.role AS membershipRole
     FROM rooms AS room
     LEFT JOIN room_memberships AS membership
       ON membership.room_id = room.id AND membership.actor_id = ?
     LEFT JOIN actors AS actor ON actor.id = membership.actor_id
     WHERE room.id = ?`,
  ).get(actorId, roomId) as GovernanceAuthorityRow | undefined;
  if (row === undefined) {
    commandError("room_not_found", "Authority room governance was not found");
  }
  return row;
}

function assertAuthorizedHuman(row: GovernanceAuthorityRow): void {
  if (row.actorKind !== "human" || row.membershipKind !== "human" ||
    (row.membershipRole !== "owner" && row.membershipRole !== "admin")) {
    commandError("role_forbidden", "Only the current owner or an admin can change room lifecycle");
  }
}

function governanceFromRow(row: GovernanceAuthorityRow): RoomGovernanceView {
  if (!isNonEmptyString(row.id) || (row.status !== "active" && row.status !== "archived") ||
    !isNonEmptyString(row.ownerActorId) || !isNonNegativeInteger(row.governanceRevision) ||
    !isNonNegativeInteger(row.archiveGeneration) ||
    (row.status === "active" && row.archivedAt !== null) ||
    (row.status === "archived" && !isNonEmptyString(row.archivedAt))) {
    commandError("storage_unavailable", "Authority room governance is corrupt");
  }
  const shared = {
    roomId: row.id,
    projectId: row.id,
    lifecycle: row.status,
    governanceRevision: row.governanceRevision,
    ownerActorId: row.ownerActorId,
    archiveGeneration: row.archiveGeneration,
  };
  return row.status === "archived"
    ? Object.freeze({ ...shared, lifecycle: row.status, archivedAt: row.archivedAt as string })
    : Object.freeze({ ...shared, lifecycle: row.status });
}

function readAuthorizedGovernance(
  database: DatabaseSync,
  input: ArchiveCoordinatorCommandInput,
): RoomGovernanceView {
  const row = readAuthorityRow(database, input.roomId, input.actorId);
  assertAuthorizedHuman(row);
  return governanceFromRow(row);
}

function requireExpectedRevision(
  governance: RoomGovernanceView,
  expectedGovernanceRevision: number,
): void {
  if (governance.governanceRevision !== expectedGovernanceRevision) {
    commandError("room_revision_conflict", "Room governance revision is stale");
  }
}

function requireSingleLifecycleCas(changes: number | bigint): void {
  if (Number(changes) !== 1) {
    commandError("room_revision_conflict", "Room lifecycle changed concurrently");
  }
}

function requireParticipantGeneration(
  feature:
    | "archived-message-gate"
    | "business-timer-suspension"
    | "archive-settlement"
    | "runtime-archive-fence"
    | "assignment-security-reduction"
    | "lifecycle-repair"
    | "room-cache-invalidation"
    | "offline-lease-invalidation",
  actual: number,
  expected: number,
): void {
  if (actual !== expected) {
    throw new AuthorityParticipantUnavailableError(feature, "malformed_result");
  }
}

export function coordinateArchiveInTransaction(
  transaction: AuthorityTransactionView,
  input: ArchiveCoordinatorCommandInput,
  composition: ArchiveCoordinatorComposition,
): ArchiveCoordinatorResult {
  validateInput(transaction, input);
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const before = readAuthorizedGovernance(database, input);
    if (before.lifecycle === "archived") {
      return Object.freeze({ outcome: "already_archived" as const, governance: before });
    }
    requireExpectedRevision(before, input.expectedGovernanceRevision);

    const archiveGeneration = before.archiveGeneration + 1;
    if (!Number.isSafeInteger(archiveGeneration)) {
      commandError("storage_unavailable", "Archive generation is exhausted");
    }
    const lifecycleCas = database.prepare(
      `UPDATE rooms
       SET status = 'archived', archived_at = ?,
           archive_generation = archive_generation + 1,
           governance_revision = governance_revision + 1
       WHERE id = ? AND status = 'active' AND governance_revision = ?`,
    ).run(input.occurredAt, input.roomId, input.expectedGovernanceRevision);
    requireSingleLifecycleCas(lifecycleCas.changes);

    const archivedMessageGate = invokeAuthorityParticipant({
      feature: "archived-message-gate",
      manifest: composition.manifest,
      registrations: composition.transactionRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.blockForArchive(transaction, {
        roomId: input.roomId,
        archiveGeneration,
      }),
    });
    requireParticipantGeneration(
      "archived-message-gate",
      archivedMessageGate.archiveGeneration,
      archiveGeneration,
    );
    requireParticipantGeneration(
      "archived-message-gate",
      archivedMessageGate.gateGeneration,
      archiveGeneration,
    );
    const businessTimers = invokeAuthorityParticipant({
      feature: "business-timer-suspension",
      manifest: composition.manifest,
      registrations: composition.transactionRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.suspendForArchive(transaction, {
        roomId: input.roomId,
        archiveGeneration,
        archivedAt: input.occurredAt,
      }),
    });
    requireParticipantGeneration(
      "business-timer-suspension",
      businessTimers.archiveGeneration,
      archiveGeneration,
    );
    if (businessTimers.action !== "suspended") {
      throw new AuthorityParticipantUnavailableError(
        "business-timer-suspension",
        "malformed_result",
      );
    }
    const toolSafetySettlement = invokeAuthorityParticipant({
      feature: "archive-settlement",
      manifest: composition.manifest,
      registrations: composition.transactionRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.settleUndispatched(transaction, {
        roomId: input.roomId,
        archiveGeneration,
        now: input.occurredAt,
      }),
    });
    requireParticipantGeneration(
      "archive-settlement",
      toolSafetySettlement.archiveGeneration,
      archiveGeneration,
    );
    const runtimeFence = invokeAuthorityParticipant({
      feature: "runtime-archive-fence",
      manifest: composition.manifest,
      registrations: composition.transactionRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.fenceForArchive(transaction, {
        roomId: input.roomId,
        archiveGeneration,
        now: input.occurredAt,
      }),
    });
    requireParticipantGeneration(
      "runtime-archive-fence",
      runtimeFence.archiveGeneration,
      archiveGeneration,
    );
    const assignmentSecurity = invokeAuthorityParticipant({
      feature: "assignment-security-reduction",
      manifest: composition.manifest,
      registrations: composition.transactionRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.reduceForArchive(transaction, {
        roomId: input.roomId,
        archiveGeneration,
        now: input.occurredAt,
      }),
    });
    requireParticipantGeneration(
      "assignment-security-reduction",
      assignmentSecurity.archiveGeneration,
      archiveGeneration,
    );
    const lifecycleRepair = invokeLifecycleRepairDescriptor({
      manifest: composition.manifest,
      registrations: composition.lifecycleRepairRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.describeLifecycleInTransaction(transaction, {
        roomId: input.roomId,
        lifecycleGeneration: archiveGeneration,
      }),
    });
    requireParticipantGeneration(
      "lifecycle-repair",
      lifecycleRepair.lifecycleGeneration,
      archiveGeneration,
    );
    const roomCacheInvalidation = invokeAccessInvalidationPort({
      feature: "room-cache-invalidation",
      manifest: composition.manifest,
      registrations: composition.accessInvalidationRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.invalidateRoomCacheInTransaction(transaction, {
        roomId: input.roomId,
        lifecycleGeneration: archiveGeneration,
        reason: "room_archived",
      }),
    });
    requireParticipantGeneration(
      "room-cache-invalidation",
      roomCacheInvalidation.lifecycleGeneration,
      archiveGeneration,
    );
    const offlineLeaseInvalidation = invokeAccessInvalidationPort({
      feature: "offline-lease-invalidation",
      manifest: composition.manifest,
      registrations: composition.accessInvalidationRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.invalidateOfflineLeasesInTransaction(transaction, {
        roomId: input.roomId,
        lifecycleGeneration: archiveGeneration,
        reason: "room_archived",
      }),
    });
    requireParticipantGeneration(
      "offline-lease-invalidation",
      offlineLeaseInvalidation.lifecycleGeneration,
      archiveGeneration,
    );
    const governance = readAuthorizedGovernance(database, input);
    return Object.freeze({
      outcome: "applied" as const,
      governance,
      participants: Object.freeze({
        archivedMessageGate,
        businessTimers,
        toolSafetySettlement,
        runtimeFence,
        assignmentSecurity,
        lifecycleRepair,
        roomCacheInvalidation,
        offlineLeaseInvalidation,
      }),
    });
  });
}

export function coordinateReopenInTransaction(
  transaction: AuthorityTransactionView,
  input: ArchiveCoordinatorCommandInput,
  composition: ArchiveCoordinatorComposition,
): ReopenCoordinatorResult {
  validateInput(transaction, input);
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const before = readAuthorizedGovernance(database, input);
    if (before.lifecycle === "active") {
      return Object.freeze({ outcome: "already_active" as const, governance: before });
    }
    requireExpectedRevision(before, input.expectedGovernanceRevision);

    const lifecycleCas = database.prepare(
      `UPDATE rooms
       SET status = 'active', archived_at = NULL,
           governance_revision = governance_revision + 1
       WHERE id = ? AND status = 'archived' AND governance_revision = ?
         AND archive_generation = ?`,
    ).run(input.roomId, input.expectedGovernanceRevision, before.archiveGeneration);
    requireSingleLifecycleCas(lifecycleCas.changes);

    const businessTimers = invokeAuthorityParticipant({
      feature: "business-timer-suspension",
      manifest: composition.manifest,
      registrations: composition.transactionRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.resumeAfterReopen(transaction, {
        roomId: input.roomId,
        archiveGeneration: before.archiveGeneration,
        reopenedAt: input.occurredAt,
      }),
    });
    requireParticipantGeneration(
      "business-timer-suspension",
      businessTimers.archiveGeneration,
      before.archiveGeneration,
    );
    if (businessTimers.action !== "resumed") {
      throw new AuthorityParticipantUnavailableError(
        "business-timer-suspension",
        "malformed_result",
      );
    }
    const lifecycleRepair = invokeLifecycleRepairDescriptor({
      manifest: composition.manifest,
      registrations: composition.lifecycleRepairRegistrations,
      tx: transaction,
      roomId: input.roomId,
      invoke: (participant) => participant.describeLifecycleInTransaction(transaction, {
        roomId: input.roomId,
        lifecycleGeneration: before.archiveGeneration,
      }),
    });
    requireParticipantGeneration(
      "lifecycle-repair",
      lifecycleRepair.lifecycleGeneration,
      before.archiveGeneration,
    );
    const governance = readAuthorizedGovernance(database, input);
    return Object.freeze({
      outcome: "applied" as const,
      governance,
      participants: Object.freeze({ businessTimers, lifecycleRepair }),
      afterCommitRescan: Object.freeze({
        roomId: input.roomId,
        lifecycleGeneration: governance.archiveGeneration,
        governanceRevision: governance.governanceRevision,
        reason: "room_reopened" as const,
      }),
    });
  });
}
