import { randomUUID } from "node:crypto";
import type { SnapshotVersion } from "@native-im/core";
import type {
  AuthenticatedSessionContext,
  RepairScope,
  StreamingRepairLease,
} from "./persistence/contracts.js";
export type { RepairScope, StreamingRepairLease } from "./persistence/contracts.js";

export const STREAMING_REPAIR_IDLE_TIMEOUT_MS = 30_000;
export const STREAMING_COMPLETION_TOMBSTONE_MS = 30_000;

export interface RepairMutationImpact {
  readonly roomIds: readonly string[];
  readonly catalogPrincipalIds: readonly string[];
}

export type RepairPreemptionCode =
  | "snapshot_family_revoked"
  | "snapshot_stale"
  | "room_forbidden"
  | "room_archived";

export interface RepairPreemption extends RepairMutationImpact {
  readonly familyIds: readonly string[];
  readonly roomPrincipalIds?: readonly string[];
  readonly code: RepairPreemptionCode;
  readonly now: number;
}

export class FallbackRepairError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 410 | 429 | 503;

  constructor(
    readonly code:
      | RepairPreemptionCode
      | "invalid_request"
      | "snapshot_busy"
      | "snapshot_expired"
      | "snapshot_forbidden"
      | "snapshot_not_found"
      | "repair_barrier_active",
  ) {
    super(code);
    this.name = "FallbackRepairError";
    this.status = code === "invalid_request" ? 400
      : code === "snapshot_not_found" ? 404
      : code === "snapshot_expired" ? 410
      : code === "snapshot_busy" ? 429
      : code === "repair_barrier_active" ? 503
      : code === "snapshot_stale" || code === "room_archived" ? 409
      : 403;
  }
}

interface MutableLease {
  readonly snapshotId: string;
  readonly principalId: string;
  readonly accountId: string;
  readonly sessionFamilyId: string;
  readonly scope: RepairScope;
  readonly version: SnapshotVersion;
  readonly authorizationRevision: number;
  checksum?: string;
  pageCount?: number;
  lastPage?: number;
  highestAuthorizedPage?: number;
  idleExpiresAt: number;
}

interface CompletionTombstone {
  readonly snapshotId: string;
  readonly principalId: string;
  readonly accountId: string;
  readonly sessionFamilyId: string;
  readonly scope: RepairScope;
  readonly version: SnapshotVersion;
  readonly authorizationRevision: number;
  readonly checksum: string;
  readonly pageCount: number;
  readonly lastPage: number;
  readonly retainUntil: number;
}

interface InvalidatedSnapshot {
  readonly code: RepairPreemptionCode;
  readonly retainUntil: number;
  readonly principalId: string;
  readonly accountId: string;
  readonly sessionFamilyId: string;
}

interface ReleasedSnapshot {
  readonly principalId: string;
  readonly accountId: string;
  readonly sessionFamilyId: string;
  readonly retainUntil: number;
}

export interface FallbackRepairCoordinatorOptions {
  readonly idleTimeoutMs?: number;
  readonly tombstoneTtlMs?: number;
  readonly idFactory?: () => string;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sameVersion(left: SnapshotVersion, right: SnapshotVersion): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "room" && right.kind === "room"
    ? left.roomId === right.roomId && left.watermark === right.watermark
    : left.kind === "catalog" && right.kind === "catalog" &&
      left.catalogRevision === right.catalogRevision;
}

function scopeIntersects(scope: RepairScope, impact: RepairMutationImpact): boolean {
  return scope.kind === "room"
    ? impact.roomIds.includes(scope.roomId)
    : impact.catalogPrincipalIds.includes(scope.principalId);
}

function publicLease(lease: MutableLease): StreamingRepairLease {
  return {
    snapshotId: lease.snapshotId,
    principalId: lease.principalId,
    accountId: lease.accountId,
    sessionFamilyId: lease.sessionFamilyId,
    scope: lease.scope,
    version: lease.version,
    authorizationRevision: lease.authorizationRevision,
    ...(lease.checksum === undefined ? {} : { checksum: lease.checksum }),
    ...(lease.pageCount === undefined ? {} : { pageCount: lease.pageCount }),
    ...(lease.lastPage === undefined ? {} : { lastPage: lease.lastPage }),
    ...(lease.highestAuthorizedPage === undefined
      ? {} : { highestAuthorizedPage: lease.highestAuthorizedPage }),
    idleExpiresAt: new Date(lease.idleExpiresAt).toISOString(),
  };
}

function assertIdentity(
  subject: Pick<MutableLease, "principalId" | "accountId" | "sessionFamilyId">,
  context: AuthenticatedSessionContext,
): void {
  if (subject.principalId !== context.principal.actorId ||
      subject.accountId !== context.principal.accountId ||
      subject.sessionFamilyId !== context.sessionFamilyId) {
    throw new FallbackRepairError("snapshot_forbidden");
  }
}

export class FallbackRepairCoordinator {
  readonly #leases = new Map<string, MutableLease>();
  readonly #tombstones = new Map<string, CompletionTombstone>();
  readonly #invalidated = new Map<string, InvalidatedSnapshot>();
  readonly #released = new Map<string, ReleasedSnapshot>();
  readonly #idleTimeoutMs: number;
  readonly #tombstoneTtlMs: number;
  readonly #idFactory: () => string;

  constructor(options: FallbackRepairCoordinatorOptions = {}) {
    this.#idleTimeoutMs = options.idleTimeoutMs ?? STREAMING_REPAIR_IDLE_TIMEOUT_MS;
    this.#tombstoneTtlMs = options.tombstoneTtlMs ?? STREAMING_COMPLETION_TOMBSTONE_MS;
    this.#idFactory = options.idFactory ?? randomUUID;
    if (!positiveSafeInteger(this.#idleTimeoutMs) ||
        !positiveSafeInteger(this.#tombstoneTtlMs)) {
      throw new TypeError("Streaming repair timeouts must be positive safe integers");
    }
  }

  acquire(input: {
    readonly context: AuthenticatedSessionContext;
    readonly scope: RepairScope;
    readonly version: SnapshotVersion;
    readonly authorizationRevision: number;
    readonly now: number;
  }): StreamingRepairLease {
    this.#cleanup(input.now);
    if (!Number.isSafeInteger(input.authorizationRevision) ||
        input.authorizationRevision < 0 || !Number.isFinite(input.now)) {
      throw new TypeError("Streaming repair lease input is invalid");
    }
    const impact = input.scope.kind === "room"
      ? { roomIds: [input.scope.roomId], catalogPrincipalIds: [] }
      : { roomIds: [], catalogPrincipalIds: [input.scope.principalId] };
    const existing = [...this.#leases.values()].find((lease) =>
      scopeIntersects(lease.scope, impact));
    if (existing !== undefined && existing.checksum !== undefined &&
        existing.pageCount !== undefined && existing.lastPage !== undefined &&
        existing.highestAuthorizedPage !== undefined &&
        existing.principalId === input.context.principal.actorId &&
        existing.accountId === input.context.principal.accountId &&
        existing.sessionFamilyId === input.context.sessionFamilyId &&
        sameVersion(existing.version, input.version) &&
        existing.authorizationRevision === input.authorizationRevision) {
      existing.idleExpiresAt = input.now + this.#idleTimeoutMs;
      return publicLease(existing);
    }
    if (existing !== undefined) {
      throw new FallbackRepairError("snapshot_busy");
    }
    const snapshotId = this.#idFactory();
    if (snapshotId.length === 0 || this.#leases.has(snapshotId) ||
        this.#tombstones.has(snapshotId) || this.#invalidated.has(snapshotId) ||
        this.#released.has(snapshotId)) {
      throw new TypeError("Streaming repair id factory returned an invalid id");
    }
    const lease: MutableLease = {
      snapshotId,
      principalId: input.context.principal.actorId,
      accountId: input.context.principal.accountId,
      sessionFamilyId: input.context.sessionFamilyId,
      scope: input.scope,
      version: input.version,
      authorizationRevision: input.authorizationRevision,
      idleExpiresAt: input.now + this.#idleTimeoutMs,
    };
    this.#leases.set(snapshotId, lease);
    return publicLease(lease);
  }

  registerChecksum(
    snapshotId: string,
    checksum: string,
    pageCount: number,
    now: number,
  ): StreamingRepairLease {
    if (checksum.length === 0 || !positiveSafeInteger(pageCount)) {
      throw new TypeError("Streaming checksum attachment is invalid");
    }
    const lease = this.#active(snapshotId, now);
    if ((lease.checksum !== undefined && lease.checksum !== checksum) ||
        (lease.pageCount !== undefined && lease.pageCount !== pageCount)) {
      throw new FallbackRepairError("snapshot_stale");
    }
    lease.checksum = checksum;
    lease.pageCount = pageCount;
    lease.lastPage = pageCount - 1;
    lease.highestAuthorizedPage = -1;
    lease.idleExpiresAt = now + this.#idleTimeoutMs;
    return publicLease(lease);
  }

  authorizePage(input: {
    readonly context: AuthenticatedSessionContext;
    readonly snapshotId: string;
    readonly page: number;
    readonly now: number;
  }): StreamingRepairLease {
    const lease = this.#active(input.snapshotId, input.now);
    assertIdentity(lease, input.context);
    if (lease.checksum === undefined || lease.lastPage === undefined ||
        lease.highestAuthorizedPage === undefined) {
      throw new FallbackRepairError("snapshot_stale");
    }
    if (!Number.isSafeInteger(input.page) || input.page < 0 || input.page > lease.lastPage ||
        input.page < lease.highestAuthorizedPage ||
        input.page > lease.highestAuthorizedPage + 1) {
      throw new FallbackRepairError("invalid_request");
    }
    if (input.page === lease.highestAuthorizedPage + 1) {
      lease.highestAuthorizedPage = input.page;
    }
    lease.idleExpiresAt = input.now + this.#idleTimeoutMs;
    return publicLease(lease);
  }

  describe(input: {
    readonly context: AuthenticatedSessionContext;
    readonly snapshotId: string;
    readonly now: number;
  }): StreamingRepairLease {
    const tombstone = this.#tombstones.get(input.snapshotId);
    if (tombstone !== undefined) {
      if (input.now >= tombstone.retainUntil) {
        this.#tombstones.delete(input.snapshotId);
        throw new FallbackRepairError("snapshot_not_found");
      }
      assertIdentity(tombstone, input.context);
      return {
        snapshotId: tombstone.snapshotId,
        principalId: tombstone.principalId,
        accountId: tombstone.accountId,
        sessionFamilyId: tombstone.sessionFamilyId,
        scope: tombstone.scope,
        version: tombstone.version,
        authorizationRevision: tombstone.authorizationRevision,
        checksum: tombstone.checksum,
        pageCount: tombstone.pageCount,
        lastPage: tombstone.lastPage,
        highestAuthorizedPage: tombstone.lastPage,
        idleExpiresAt: new Date(tombstone.retainUntil).toISOString(),
      };
    }
    const lease = this.#active(input.snapshotId, input.now);
    assertIdentity(lease, input.context);
    return publicLease(lease);
  }

  complete(input: {
    readonly context: AuthenticatedSessionContext;
    readonly snapshotId: string;
    readonly version: SnapshotVersion;
    readonly checksum: string;
    readonly now: number;
  }): { readonly snapshotId: string; readonly version: SnapshotVersion } {
    const tombstone = this.#tombstones.get(input.snapshotId);
    if (tombstone !== undefined) {
      if (input.now >= tombstone.retainUntil) {
        this.#tombstones.delete(input.snapshotId);
        throw new FallbackRepairError("snapshot_not_found");
      }
      assertIdentity(tombstone, input.context);
      if (!sameVersion(tombstone.version, input.version) ||
          tombstone.checksum !== input.checksum) {
        throw new FallbackRepairError("snapshot_stale");
      }
      return { snapshotId: tombstone.snapshotId, version: tombstone.version };
    }
    const lease = this.#active(input.snapshotId, input.now);
    assertIdentity(lease, input.context);
    if (lease.checksum === undefined || lease.lastPage === undefined ||
        lease.highestAuthorizedPage !== lease.lastPage ||
        lease.checksum !== input.checksum ||
        !sameVersion(lease.version, input.version)) {
      throw new FallbackRepairError("snapshot_stale");
    }
    this.#leases.delete(lease.snapshotId);
    this.#tombstones.set(lease.snapshotId, {
      snapshotId: lease.snapshotId,
      principalId: lease.principalId,
      accountId: lease.accountId,
      sessionFamilyId: lease.sessionFamilyId,
      scope: lease.scope,
      version: lease.version,
      authorizationRevision: lease.authorizationRevision,
      checksum: lease.checksum,
      pageCount: lease.pageCount!,
      lastPage: lease.lastPage,
      retainUntil: input.now + this.#tombstoneTtlMs,
    });
    return { snapshotId: lease.snapshotId, version: lease.version };
  }

  blockingLease(impact: RepairMutationImpact, now: number): StreamingRepairLease | undefined {
    return this.blockingLeases(impact, now)[0];
  }

  blockingLeases(impact: RepairMutationImpact, now: number): readonly StreamingRepairLease[] {
    this.#cleanup(now);
    return [...this.#leases.values()]
      .filter((candidate) => scopeIntersects(candidate.scope, impact))
      .map(publicLease);
  }

  preemptAfterCommit(preemption: RepairPreemption): void {
    const retainedUntil = preemption.now + this.#tombstoneTtlMs;
    for (const lease of [...this.#leases.values()]) {
      if (preemption.familyIds.includes(lease.sessionFamilyId) ||
          (scopeIntersects(lease.scope, preemption) &&
            (lease.scope.kind !== "room" || preemption.roomPrincipalIds === undefined ||
              preemption.roomPrincipalIds.includes(lease.principalId)))) {
        this.#leases.delete(lease.snapshotId);
        this.#invalidated.set(lease.snapshotId, {
          code: preemption.code,
          retainUntil: retainedUntil,
          principalId: lease.principalId,
          accountId: lease.accountId,
          sessionFamilyId: lease.sessionFamilyId,
        });
      }
    }
    for (const tombstone of [...this.#tombstones.values()]) {
      if (preemption.familyIds.includes(tombstone.sessionFamilyId) ||
          (scopeIntersects(tombstone.scope, preemption) &&
            (tombstone.scope.kind !== "room" || preemption.roomPrincipalIds === undefined ||
              preemption.roomPrincipalIds.includes(tombstone.principalId)))) {
        this.#tombstones.delete(tombstone.snapshotId);
        this.#invalidated.set(tombstone.snapshotId, {
          code: preemption.code,
          retainUntil: retainedUntil,
          principalId: tombstone.principalId,
          accountId: tombstone.accountId,
          sessionFamilyId: tombstone.sessionFamilyId,
        });
      }
    }
  }

  releaseOwned(input: {
    readonly context: AuthenticatedSessionContext;
    readonly snapshotId: string;
    readonly now: number;
  }): void {
    this.#cleanup(input.now);
    const released = this.#released.get(input.snapshotId);
    if (released !== undefined) {
      assertIdentity(released, input.context);
      return;
    }
    const completed = this.#tombstones.get(input.snapshotId);
    if (completed !== undefined) {
      assertIdentity(completed, input.context);
      return;
    }
    const invalidated = this.#invalidated.get(input.snapshotId);
    if (invalidated !== undefined) {
      assertIdentity(invalidated, input.context);
      return;
    }
    const lease = this.#active(input.snapshotId, input.now);
    assertIdentity(lease, input.context);
    this.#leases.delete(input.snapshotId);
    this.#released.set(input.snapshotId, {
      principalId: lease.principalId,
      accountId: lease.accountId,
      sessionFamilyId: lease.sessionFamilyId,
      retainUntil: input.now + this.#tombstoneTtlMs,
    });
  }

  releaseAll(): void {
    this.#leases.clear();
    this.#tombstones.clear();
    this.#invalidated.clear();
    this.#released.clear();
  }

  #active(snapshotId: string, now: number): MutableLease {
    const invalidated = this.#invalidated.get(snapshotId);
    if (invalidated !== undefined) {
      if (now < invalidated.retainUntil) throw new FallbackRepairError(invalidated.code);
      this.#invalidated.delete(snapshotId);
    }
    const lease = this.#leases.get(snapshotId);
    if (lease === undefined) throw new FallbackRepairError("snapshot_not_found");
    if (lease.checksum !== undefined && now >= lease.idleExpiresAt) {
      this.#leases.delete(snapshotId);
      throw new FallbackRepairError("snapshot_expired");
    }
    return lease;
  }

  #cleanup(now: number): void {
    for (const [snapshotId, lease] of this.#leases) {
      if (lease.checksum !== undefined && now >= lease.idleExpiresAt) {
        this.#leases.delete(snapshotId);
      }
    }
    for (const [snapshotId, tombstone] of this.#tombstones) {
      if (now >= tombstone.retainUntil) this.#tombstones.delete(snapshotId);
    }
    for (const [snapshotId, invalidated] of this.#invalidated) {
      if (now >= invalidated.retainUntil) this.#invalidated.delete(snapshotId);
    }
    for (const [snapshotId, released] of this.#released) {
      if (now >= released.retainUntil) this.#released.delete(snapshotId);
    }
  }
}
