import type { SnapshotCompleted } from "@native-im/core";
import type { DatabaseSync } from "node:sqlite";
import {
  OfflineReadLeaseValidationError,
  type OfflineReadLeaseClaims,
  type OfflineReadLeaseVerifier,
} from "../access/offline-lease-invalidation-port.js";
import {
  FallbackRepairCoordinator,
  FallbackRepairError,
} from "../fallback-repair-coordinator.js";
import type {
  AuthenticatedSessionContext,
  RepairScope,
  SnapshotRevalidationRequest,
  StreamingRepairLease,
} from "../persistence/contracts.js";
import type { StreamingRepairAuthority } from "../persistence/snapshot-worker-client.js";

export type ArchiveReadRepairAccessErrorCode =
  | "invalid_request"
  | "room_not_found"
  | "room_forbidden"
  | "snapshot_stale"
  | "storage_unavailable";

export class ArchiveReadRepairAccessError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 503;

  constructor(readonly code: ArchiveReadRepairAccessErrorCode) {
    super(code);
    this.name = "ArchiveReadRepairAccessError";
    this.status = code === "invalid_request" ? 400
      : code === "room_forbidden" ? 403
      : code === "room_not_found" ? 404
      : code === "snapshot_stale" ? 409
      : 503;
  }
}

export interface ArchivedRoomAccessProof {
  readonly roomId: string;
  readonly actorId: string;
  readonly lifecycle: "active" | "archived";
  readonly lifecycleGeneration: number;
  readonly membershipAccessRevision: number;
  readonly accessRevision: number;
  readonly leaseGeneration: number;
  readonly fixedWatermark: number;
}

export interface ArchivedRoomProjectionPort<TResult> {
  read(database: DatabaseSync, proof: ArchivedRoomAccessProof): TResult;
}

export interface CurrentOfflineReadLeaseSubject {
  readonly tenantId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly sessionFamilyId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly serverSubject: string;
  readonly roomId: string;
}

interface RoomAccessRow {
  readonly roomStatus: unknown;
  readonly lifecycleGeneration: unknown;
  readonly membershipAccessRevision: unknown;
  readonly roomAccessRevision: unknown;
  readonly leaseGeneration: unknown;
  readonly watermark: unknown;
}

interface RepairProof extends ArchivedRoomAccessProof {
  readonly accountId: string;
  readonly sessionFamilyId: string;
}

export interface ArchiveReadRepairAccessAuthorityOptions {
  readonly database: DatabaseSync;
  readonly reauthenticate: (
    database: DatabaseSync,
    context: AuthenticatedSessionContext,
    now: number,
  ) => string;
  readonly repairs: FallbackRepairCoordinator;
}

function reject(code: ArchiveReadRepairAccessErrorCode): never {
  throw new ArchiveReadRepairAccessError(code);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function errorCode(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "code" in value &&
    typeof (value as { readonly code?: unknown }).code === "string"
    ? (value as { readonly code: string }).code
    : undefined;
}

export class ArchiveReadRepairAccessAuthority implements StreamingRepairAuthority {
  readonly #database: DatabaseSync;
  readonly #reauthenticate: ArchiveReadRepairAccessAuthorityOptions["reauthenticate"];
  readonly #repairs: FallbackRepairCoordinator;
  readonly #proofBySnapshot = new Map<string, RepairProof>();

  constructor(options: ArchiveReadRepairAccessAuthorityOptions) {
    this.#database = options.database;
    this.#reauthenticate = options.reauthenticate;
    this.#repairs = options.repairs;
  }

  readArchivedProjection<TResult>(
    context: AuthenticatedSessionContext,
    roomId: string,
    now: number,
    projection: ArchivedRoomProjectionPort<TResult>,
  ): TResult {
    const actorId = this.#reauthenticate(this.#database, context, now);
    const proof = this.#readRoomProof(actorId, roomId, true);
    return projection.read(this.#database, proof);
  }

  readCurrentArchivedAccessProof(actorId: string, roomId: string): ArchivedRoomAccessProof {
    return this.#readRoomProof(actorId, roomId, true);
  }

  async revalidateMaterializedSnapshot(
    request: SnapshotRevalidationRequest,
    now: number,
  ): Promise<void> {
    const actorId = this.#reauthenticate(this.#database, request.context, now);
    if (request.kind === "catalog") {
      if (actorId !== request.context.principal.actorId) reject("room_forbidden");
      const row = this.#database.prepare(
        "SELECT catalog_revision AS catalogRevision FROM actors WHERE id = ? AND kind = 'human'",
      ).get(actorId);
      if (!nonNegativeInteger(row?.catalogRevision)) reject("room_forbidden");
      if (row.catalogRevision !== request.catalogRevision) reject("snapshot_stale");
      return;
    }
    const proof = this.#readRoomProof(actorId, request.roomId, false);
    if (proof.accessRevision !== request.accessRevision) reject("snapshot_stale");
  }

  async acquireStreamingRepair(
    context: AuthenticatedSessionContext,
    scope: RepairScope,
    now: number,
  ): Promise<StreamingRepairLease> {
    if (scope.kind !== "room") throw new FallbackRepairError("invalid_request");
    const actorId = this.#reauthenticate(this.#database, context, now);
    const proof = this.#readRoomProof(actorId, scope.roomId, false);
    const lease = this.#repairs.acquire({
      context,
      scope,
      version: { kind: "room", roomId: scope.roomId, watermark: proof.fixedWatermark },
      authorizationRevision: proof.accessRevision,
      now,
    });
    this.#proofBySnapshot.set(lease.snapshotId, {
      ...proof,
      accountId: context.principal.accountId,
      sessionFamilyId: context.sessionFamilyId,
    });
    return lease;
  }

  async registerStreamingRepair(
    snapshotId: string,
    checksum: string,
    pageCount: number,
    now: number,
  ): Promise<StreamingRepairLease> {
    return this.#repairs.registerChecksum(snapshotId, checksum, pageCount, now);
  }

  async authorizeStreamingRepairPage(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    page: number,
    now: number,
  ): Promise<StreamingRepairLease> {
    this.#repairs.describe({ context, snapshotId, now });
    this.#revalidateStreamingProof(context, snapshotId, now);
    return this.#repairs.authorizePage({ context, snapshotId, page, now });
  }

  async completeStreamingRepair(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    version: StreamingRepairLease["version"],
    checksum: string,
    now: number,
  ): Promise<SnapshotCompleted> {
    this.#repairs.describe({ context, snapshotId, now });
    this.#revalidateStreamingProof(context, snapshotId, now);
    const completed = this.#repairs.complete({ context, snapshotId, version, checksum, now });
    this.#proofBySnapshot.delete(snapshotId);
    return {
      type: "snapshot.completed",
      requestId: "archive-read-repair-internal",
      snapshotId: completed.snapshotId,
      version: completed.version,
    };
  }

  async releaseStreamingRepair(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    now: number,
  ): Promise<void> {
    this.#repairs.releaseOwned({ context, snapshotId, now });
    this.#proofBySnapshot.delete(snapshotId);
  }

  blockingRoomRepair(roomId: string, now: number): StreamingRepairLease | undefined {
    return this.#repairs.blockingLease({ roomIds: [roomId], catalogPrincipalIds: [] }, now);
  }

  preemptArchiveAfterCommit(roomId: string, now: number): void {
    this.#repairs.preemptAfterCommit({
      roomIds: [roomId],
      catalogPrincipalIds: [],
      familyIds: [],
      code: "snapshot_stale",
      now,
    });
  }

  preemptMemberRemovalAfterCommit(roomId: string, actorId: string, now: number): void {
    this.#repairs.preemptAfterCommit({
      roomIds: [roomId],
      catalogPrincipalIds: [actorId],
      familyIds: [],
      roomPrincipalIds: [actorId],
      code: "room_forbidden",
      now,
    });
  }

  preemptSessionFamilyAfterCommit(sessionFamilyId: string, now: number): void {
    this.#repairs.preemptAfterCommit({
      roomIds: [],
      catalogPrincipalIds: [],
      familyIds: [sessionFamilyId],
      code: "snapshot_family_revoked",
      now,
    });
  }

  verifyCurrentArchivedOfflineLease(
    verifier: OfflineReadLeaseVerifier,
    token: string,
    subject: CurrentOfflineReadLeaseSubject,
  ): OfflineReadLeaseClaims {
    const proof = this.#readRoomProof(subject.actorId, subject.roomId, true);
    const family = this.#database.prepare(
      `SELECT 1 AS present
       FROM session_families
       WHERE family_id = ? AND account_id = ? AND actor_id = ? AND device_id = ?
         AND revoked_at IS NULL`,
    ).get(
      subject.sessionFamilyId,
      subject.accountId,
      subject.actorId,
      subject.deviceId,
    );
    if (family?.present !== 1) {
      throw new OfflineReadLeaseValidationError("subject_unauthorized");
    }
    const claims = verifier.verify(token, {
      ...subject,
      lifecycleGeneration: proof.lifecycleGeneration,
      accessRevision: proof.accessRevision,
      leaseGeneration: proof.leaseGeneration,
    });
    const issuance = this.#database.prepare(
      `SELECT 1 AS present
       FROM offline_read_lease_issuances
       WHERE lease_id = ? AND room_id = ? AND account_id = ? AND actor_id = ?
         AND session_family_id = ? AND device_id = ? AND installation_id = ?
         AND server_subject = ? AND lifecycle_generation = ? AND access_revision = ?
         AND lease_generation = ? AND revoked_at_ms IS NULL
         AND expires_at_ms = ?`,
    ).get(
      claims.leaseId,
      subject.roomId,
      subject.accountId,
      subject.actorId,
      subject.sessionFamilyId,
      subject.deviceId,
      subject.installationId,
      subject.serverSubject,
      proof.lifecycleGeneration,
      proof.accessRevision,
      proof.leaseGeneration,
      claims.expiresAtMs,
    );
    if (issuance?.present !== 1) {
      throw new OfflineReadLeaseValidationError("subject_unauthorized");
    }
    return claims;
  }

  #readRoomProof(
    actorId: string,
    roomId: string,
    requireArchived: boolean,
  ): ArchivedRoomAccessProof {
    const row = this.#database.prepare(
      `SELECT room.status AS roomStatus,
              room.archive_generation AS lifecycleGeneration,
              membership.access_revision AS membershipAccessRevision,
              access.access_revision AS roomAccessRevision,
              access.lease_generation AS leaseGeneration,
              stream.head_seq AS watermark
       FROM rooms AS room
       JOIN room_memberships AS membership
         ON membership.room_id = room.id AND membership.actor_id = ?
       JOIN actors AS actor ON actor.id = membership.actor_id
       JOIN streams AS stream
         ON stream.stream_kind = 'room' AND stream.stream_id = room.id
       LEFT JOIN room_access_authority AS access ON access.room_id = room.id
       WHERE room.id = ? AND membership.kind = 'human' AND actor.kind = 'human'`,
    ).get(actorId, roomId) as RoomAccessRow | undefined;
    if (row === undefined) {
      const room = this.#database.prepare("SELECT 1 AS present FROM rooms WHERE id = ?").get(roomId);
      if (room === undefined) reject("room_not_found");
      reject("room_forbidden");
    }
    if ((row.roomStatus !== "active" && row.roomStatus !== "archived") ||
      !nonNegativeInteger(row.lifecycleGeneration) ||
      !nonNegativeInteger(row.membershipAccessRevision) ||
      !nonNegativeInteger(row.watermark)) {
      reject("storage_unavailable");
    }
    if (requireArchived && row.roomStatus !== "archived") reject("room_forbidden");
    if (row.roomStatus === "archived" &&
      (!nonNegativeInteger(row.roomAccessRevision) || !nonNegativeInteger(row.leaseGeneration))) {
      reject("storage_unavailable");
    }
    const accessRevision = nonNegativeInteger(row.roomAccessRevision)
      ? Math.max(row.roomAccessRevision, row.membershipAccessRevision)
      : row.membershipAccessRevision;
    const leaseGeneration = nonNegativeInteger(row.leaseGeneration) ? row.leaseGeneration : 0;
    return Object.freeze({
      roomId,
      actorId,
      lifecycle: row.roomStatus,
      lifecycleGeneration: row.lifecycleGeneration,
      membershipAccessRevision: row.membershipAccessRevision,
      accessRevision,
      leaseGeneration,
      fixedWatermark: row.watermark,
    });
  }

  #revalidateStreamingProof(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    now: number,
  ): void {
    const expected = this.#proofBySnapshot.get(snapshotId);
    if (expected === undefined) throw new FallbackRepairError("snapshot_not_found");
    let actorId: string;
    try {
      actorId = this.#reauthenticate(this.#database, context, now);
    } catch (cause: unknown) {
      if (errorCode(cause) === "session_revoked") {
        this.preemptSessionFamilyAfterCommit(context.sessionFamilyId, now);
        this.#repairs.describe({ context, snapshotId, now });
      }
      throw cause;
    }
    let current: ArchivedRoomAccessProof;
    try {
      current = this.#readRoomProof(actorId, expected.roomId, false);
    } catch (cause: unknown) {
      if (errorCode(cause) === "room_forbidden") {
        this.preemptMemberRemovalAfterCommit(expected.roomId, expected.actorId, now);
        this.#repairs.describe({ context, snapshotId, now });
      }
      throw cause;
    }
    if (actorId !== expected.actorId || context.principal.accountId !== expected.accountId ||
      context.sessionFamilyId !== expected.sessionFamilyId ||
      current.lifecycle !== expected.lifecycle ||
      current.lifecycleGeneration !== expected.lifecycleGeneration ||
      current.membershipAccessRevision !== expected.membershipAccessRevision ||
      current.accessRevision !== expected.accessRevision ||
      current.leaseGeneration !== expected.leaseGeneration) {
      this.#repairs.preemptAfterCommit({
        roomIds: [expected.roomId],
        catalogPrincipalIds: [],
        familyIds: [],
        roomPrincipalIds: [expected.actorId],
        code: "snapshot_stale",
        now,
      });
      this.#repairs.describe({ context, snapshotId, now });
    }
  }
}
