import {
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import { createHash } from "node:crypto";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import type {
  AuthorityTransactionView,
  OfflineLeaseInvalidationPort,
  OfflineLeaseInvalidationResult,
  ParticipantRegistration,
} from "../room-governance/private-participant-contracts.js";

export const OFFLINE_READ_LEASE_SCHEMA_STATEMENTS = [
  `CREATE TABLE offline_read_lease_issuances (
    lease_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    account_id TEXT NOT NULL CHECK (length(trim(account_id)) > 0),
    actor_id TEXT NOT NULL REFERENCES actors(id),
    session_family_id TEXT NOT NULL REFERENCES session_families(family_id),
    device_id TEXT NOT NULL CHECK (length(device_id) > 0),
    installation_id TEXT NOT NULL CHECK (length(installation_id) > 0),
    server_subject TEXT NOT NULL CHECK (length(server_subject) > 0),
    key_id TEXT NOT NULL CHECK (length(key_id) > 0),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
    issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms >= 0),
    not_before_ms INTEGER NOT NULL CHECK (not_before_ms >= issued_at_ms),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > not_before_ms),
    revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= issued_at_ms)
  ) STRICT`,
  `CREATE TRIGGER offline_read_lease_issuance_subject_guard
   BEFORE INSERT ON offline_read_lease_issuances
   WHEN COALESCE((SELECT kind FROM actors WHERE id = NEW.actor_id), '') <> 'human'
      OR NOT EXISTS (
        SELECT 1
        FROM room_memberships
        WHERE room_id = NEW.room_id
          AND actor_id = NEW.actor_id
          AND kind = 'human'
      )
      OR NOT EXISTS (
        SELECT 1
        FROM session_families
        WHERE family_id = NEW.session_family_id
          AND account_id = NEW.account_id
          AND actor_id = NEW.actor_id
          AND device_id = NEW.device_id
          AND revoked_at IS NULL
          AND refresh_expires_at >= NEW.expires_at_ms
      )
   BEGIN
     SELECT RAISE(ABORT, 'offline read lease subject is not currently authorized');
   END`,
  `CREATE INDEX offline_read_lease_room_generation_active
   ON offline_read_lease_issuances(
     room_id, lease_generation, revoked_at_ms, expires_at_ms, lease_id
   )`,
  `CREATE TABLE offline_read_lease_invalidations (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 0),
    access_revision INTEGER NOT NULL CHECK (access_revision >= 0),
    lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
    revoked_lease_count INTEGER NOT NULL CHECK (revoked_lease_count >= 0),
    reason TEXT NOT NULL CHECK (reason IN ('room_archived')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (room_id, lifecycle_generation, reason)
  ) STRICT`,
] as const;

export type OfflineReadLeaseValidationReason =
  | "invalid_policy"
  | "invalid_input"
  | "lease_too_long"
  | "subject_unauthorized"
  | "authority_revision_mismatch"
  | "malformed_token"
  | "malformed_claims"
  | "noncanonical_claims"
  | "unknown_key"
  | "bad_signature"
  | "not_yet_valid"
  | "expired"
  | "binding_mismatch";

export class OfflineReadLeaseValidationError extends Error {
  readonly reason: OfflineReadLeaseValidationReason;

  constructor(reason: OfflineReadLeaseValidationReason) {
    super(`Offline read lease rejected: ${reason}`);
    this.name = "OfflineReadLeaseValidationError";
    this.reason = reason;
  }
}

export interface OfflineReadLeaseClaims {
  readonly version: 1;
  readonly keyId: string;
  readonly leaseId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly actorKind: "human";
  readonly sessionFamilyId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly serverSubject: string;
  readonly room: Readonly<{
    roomId: string;
    lifecycleGeneration: number;
    accessRevision: number;
    leaseGeneration: number;
  }>;
  readonly issuedAtMs: number;
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
}

export interface IssuedOfflineReadLease {
  readonly token: string;
  readonly claims: OfflineReadLeaseClaims;
}

export interface OfflineReadLeaseBinding {
  readonly tenantId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly sessionFamilyId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly serverSubject: string;
  readonly roomId: string;
  readonly lifecycleGeneration: number;
  readonly accessRevision: number;
  readonly leaseGeneration: number;
}

export interface OfflineReadLeaseIssueInput {
  readonly roomId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly sessionFamilyId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly requestedLeaseMs: number;
  readonly expectedLifecycleGeneration: number;
  readonly expectedAccessRevision: number;
  readonly expectedLeaseGeneration: number;
}

interface SessionFamilyRow {
  readonly refresh_expires_at: number;
}

interface LeaseAuthorityRow {
  readonly lifecycle_generation: number;
  readonly access_revision: number;
  readonly lease_generation: number;
}

function reject(reason: OfflineReadLeaseValidationReason): never {
  throw new OfflineReadLeaseValidationError(reason);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function assertPositivePolicy(value: unknown): asserts value is number {
  if (!isPositiveInteger(value)) reject("invalid_policy");
}

export class OfflineReadLeaseIssuer {
  readonly #tenantId: string;
  readonly #serverSubject: string;
  readonly #keyId: string;
  readonly #privateKey: KeyObject;
  readonly #maxOfflineReadLeaseMs: number;
  readonly #now: () => number;
  readonly #createLeaseId: () => string;

  constructor(options: Readonly<{
    tenantId: string;
    serverSubject: string;
    keyId: string;
    privateKey: KeyObject;
    maxOfflineReadLeaseMs: number;
    now?: () => number;
    createLeaseId?: () => string;
  }>) {
    assertPositivePolicy(options.maxOfflineReadLeaseMs);
    if (!isNonEmptyString(options.tenantId) || !isNonEmptyString(options.serverSubject) ||
      !isNonEmptyString(options.keyId) || options.privateKey?.type !== "private" ||
      options.privateKey.asymmetricKeyType !== "ed25519") {
      reject("invalid_input");
    }
    this.#tenantId = options.tenantId;
    this.#serverSubject = options.serverSubject;
    this.#keyId = options.keyId;
    this.#privateKey = options.privateKey;
    this.#maxOfflineReadLeaseMs = options.maxOfflineReadLeaseMs;
    this.#now = options.now ?? Date.now;
    this.#createLeaseId = options.createLeaseId ?? randomUUID;
  }

  issueInTransaction(
    transaction: AuthorityTransactionView,
    input: OfflineReadLeaseIssueInput,
  ): IssuedOfflineReadLease {
    if (transaction.roomId !== input.roomId || !isPositiveInteger(input.requestedLeaseMs) ||
      !isNonEmptyString(input.accountId) || !isNonEmptyString(input.actorId) ||
      !isNonEmptyString(input.sessionFamilyId) || !isNonEmptyString(input.deviceId) ||
      !isNonEmptyString(input.installationId) ||
      !isNonNegativeInteger(input.expectedLifecycleGeneration) ||
      !isNonNegativeInteger(input.expectedAccessRevision) ||
      !isNonNegativeInteger(input.expectedLeaseGeneration)) {
      reject("invalid_input");
    }
    if (input.requestedLeaseMs > this.#maxOfflineReadLeaseMs) reject("lease_too_long");
    const now = this.#now();
    if (!isNonNegativeInteger(now)) reject("invalid_input");

    return useAuthorityTransactionDatabase(transaction, (database) => {
      const family = database.prepare(`
        SELECT refresh_expires_at
        FROM session_families
        WHERE family_id = ?
          AND account_id = ?
          AND actor_id = ?
          AND device_id = ?
          AND revoked_at IS NULL
          AND refresh_expires_at > ?
      `).get(
        input.sessionFamilyId,
        input.accountId,
        input.actorId,
        input.deviceId,
        now,
      ) as SessionFamilyRow | undefined;
      if (family === undefined) reject("subject_unauthorized");

      database.prepare(`
        INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
        SELECT membership.room_id, membership.access_revision, 0
        FROM room_memberships AS membership
        JOIN actors AS actor ON actor.id = membership.actor_id
        WHERE membership.room_id = ?
          AND membership.actor_id = ?
          AND membership.kind = 'human'
          AND actor.kind = 'human'
        ON CONFLICT(room_id) DO NOTHING
      `).run(input.roomId, input.actorId);

      const authority = database.prepare(`
        SELECT
          room.archive_generation AS lifecycle_generation,
          access.access_revision,
          access.lease_generation
        FROM rooms AS room
        JOIN room_memberships AS membership
          ON membership.room_id = room.id AND membership.actor_id = ?
        JOIN actors AS actor ON actor.id = membership.actor_id
        JOIN room_access_authority AS access ON access.room_id = room.id
        WHERE room.id = ? AND membership.kind = 'human' AND actor.kind = 'human'
      `).get(input.actorId, input.roomId) as LeaseAuthorityRow | undefined;
      if (authority === undefined) reject("subject_unauthorized");
      if (authority.lifecycle_generation !== input.expectedLifecycleGeneration ||
        authority.access_revision !== input.expectedAccessRevision ||
        authority.lease_generation !== input.expectedLeaseGeneration) {
        reject("authority_revision_mismatch");
      }

      const expiresAtMs = Math.min(now + input.requestedLeaseMs, family.refresh_expires_at);
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) {
        reject("subject_unauthorized");
      }
      const leaseId = this.#createLeaseId();
      if (!isNonEmptyString(leaseId)) reject("invalid_input");
      const claims: OfflineReadLeaseClaims = Object.freeze({
        version: 1,
        keyId: this.#keyId,
        leaseId,
        tenantId: this.#tenantId,
        accountId: input.accountId,
        actorId: input.actorId,
        actorKind: "human",
        sessionFamilyId: input.sessionFamilyId,
        deviceId: input.deviceId,
        installationId: input.installationId,
        serverSubject: this.#serverSubject,
        room: Object.freeze({
          roomId: input.roomId,
          lifecycleGeneration: authority.lifecycle_generation,
          accessRevision: authority.access_revision,
          leaseGeneration: authority.lease_generation,
        }),
        issuedAtMs: now,
        notBeforeMs: now,
        expiresAtMs,
      });
      const canonicalClaims = canonicalizeClaims(claims);
      const signature = signBytes(null, Buffer.from(canonicalClaims), this.#privateKey);

      database.prepare(`
        INSERT INTO offline_read_lease_issuances (
          lease_id, room_id, account_id, actor_id, session_family_id, device_id,
          installation_id, server_subject, key_id, lifecycle_generation,
          access_revision, lease_generation, issued_at_ms, not_before_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        claims.leaseId,
        claims.room.roomId,
        claims.accountId,
        claims.actorId,
        claims.sessionFamilyId,
        claims.deviceId,
        claims.installationId,
        claims.serverSubject,
        claims.keyId,
        claims.room.lifecycleGeneration,
        claims.room.accessRevision,
        claims.room.leaseGeneration,
        claims.issuedAtMs,
        claims.notBeforeMs,
        claims.expiresAtMs,
      );
      return Object.freeze({
        token: `${Buffer.from(canonicalClaims).toString("base64url")}.${signature.toString("base64url")}`,
        claims,
      });
    });
  }
}

export class OfflineReadLeaseVerifier {
  readonly #verificationKeys: ReadonlyMap<string, KeyObject>;
  readonly #now: () => number;

  constructor(options: Readonly<{
    verificationKeys: ReadonlyMap<string, KeyObject>;
    now?: () => number;
  }>) {
    this.#verificationKeys = options.verificationKeys;
    this.#now = options.now ?? Date.now;
  }

  verify(token: string, expected: OfflineReadLeaseBinding): OfflineReadLeaseClaims {
    if (!isNonEmptyString(token)) reject("malformed_token");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
      reject("malformed_token");
    }
    let claimsText: string;
    let signature: Buffer;
    try {
      claimsText = Buffer.from(parts[0]!, "base64url").toString("utf8");
      signature = Buffer.from(parts[1]!, "base64url");
    } catch {
      reject("malformed_token");
    }
    if (Buffer.from(claimsText).toString("base64url") !== parts[0] ||
      signature.toString("base64url") !== parts[1] || signature.length !== 64) {
      reject("malformed_token");
    }
    let claims: unknown;
    try {
      claims = JSON.parse(claimsText);
    } catch {
      reject("malformed_claims");
    }
    if (!isOfflineReadLeaseClaims(claims)) reject("malformed_claims");
    if (canonicalizeClaims(claims) !== claimsText) reject("noncanonical_claims");
    const publicKey = this.#verificationKeys.get(claims.keyId);
    if (publicKey === undefined) reject("unknown_key");
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519" ||
      !verifyBytes(null, Buffer.from(claimsText), publicKey, signature)) {
      reject("bad_signature");
    }
    const now = this.#now();
    if (!isNonNegativeInteger(now)) reject("invalid_input");
    if (now < claims.notBeforeMs) reject("not_yet_valid");
    if (now >= claims.expiresAtMs) reject("expired");
    if (!matchesBinding(claims, expected)) reject("binding_mismatch");
    return claims;
  }
}

function matchesBinding(claims: OfflineReadLeaseClaims, expected: OfflineReadLeaseBinding): boolean {
  return claims.tenantId === expected.tenantId && claims.accountId === expected.accountId &&
    claims.actorId === expected.actorId && claims.sessionFamilyId === expected.sessionFamilyId &&
    claims.deviceId === expected.deviceId && claims.installationId === expected.installationId &&
    claims.serverSubject === expected.serverSubject && claims.room.roomId === expected.roomId &&
    claims.room.lifecycleGeneration === expected.lifecycleGeneration &&
    claims.room.accessRevision === expected.accessRevision &&
    claims.room.leaseGeneration === expected.leaseGeneration;
}

function canonicalizeClaims(claims: OfflineReadLeaseClaims): string {
  return JSON.stringify({
    version: claims.version,
    keyId: claims.keyId,
    leaseId: claims.leaseId,
    tenantId: claims.tenantId,
    accountId: claims.accountId,
    actorId: claims.actorId,
    actorKind: claims.actorKind,
    sessionFamilyId: claims.sessionFamilyId,
    deviceId: claims.deviceId,
    installationId: claims.installationId,
    serverSubject: claims.serverSubject,
    room: {
      roomId: claims.room.roomId,
      lifecycleGeneration: claims.room.lifecycleGeneration,
      accessRevision: claims.room.accessRevision,
      leaseGeneration: claims.room.leaseGeneration,
    },
    issuedAtMs: claims.issuedAtMs,
    notBeforeMs: claims.notBeforeMs,
    expiresAtMs: claims.expiresAtMs,
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isOfflineReadLeaseClaims(value: unknown): value is OfflineReadLeaseClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  if (!hasExactKeys(claims, [
    "version", "keyId", "leaseId", "tenantId", "accountId", "actorId", "actorKind",
    "sessionFamilyId", "deviceId", "installationId", "serverSubject", "room", "issuedAtMs",
    "notBeforeMs", "expiresAtMs",
  ]) || claims.version !== 1 || claims.actorKind !== "human" ||
    ![claims.keyId, claims.leaseId, claims.tenantId, claims.accountId, claims.actorId,
      claims.sessionFamilyId, claims.deviceId, claims.installationId, claims.serverSubject]
      .every(isNonEmptyString) || !isNonNegativeInteger(claims.issuedAtMs) ||
    !isNonNegativeInteger(claims.notBeforeMs) || !isNonNegativeInteger(claims.expiresAtMs) ||
    claims.notBeforeMs < claims.issuedAtMs || claims.expiresAtMs <= claims.notBeforeMs ||
    typeof claims.room !== "object" || claims.room === null || Array.isArray(claims.room)) {
    return false;
  }
  const room = claims.room as Record<string, unknown>;
  return hasExactKeys(room, [
    "roomId", "lifecycleGeneration", "accessRevision", "leaseGeneration",
  ]) && isNonEmptyString(room.roomId) && isNonNegativeInteger(room.lifecycleGeneration) &&
    isNonNegativeInteger(room.accessRevision) && isNonNegativeInteger(room.leaseGeneration);
}

interface ExistingInvalidationRow {
  readonly lifecycle_generation: number;
  readonly lease_generation: number;
  readonly revoked_lease_count: number;
}

interface LeaseGenerationRow {
  readonly access_revision: number;
  readonly lease_generation: number;
}

function offlineInvalidationId(roomId: string, lifecycleGeneration: number): string {
  return `offline-lease-invalidation-${createHash("sha256")
    .update("offline-lease-invalidation\0")
    .update(roomId)
    .update("\0")
    .update(String(lifecycleGeneration))
    .update("\0room_archived")
    .digest("hex")}`;
}

export function createOfflineLeaseInvalidationRegistration(options: Readonly<{
  maxOfflineReadLeaseMs: number;
}>): ParticipantRegistration<OfflineLeaseInvalidationPort> {
  assertPositivePolicy(options.maxOfflineReadLeaseMs);
  const participant: OfflineLeaseInvalidationPort = Object.freeze({
    invalidateOfflineLeasesInTransaction(
      transaction: AuthorityTransactionView,
      input: Readonly<{
        roomId: string;
        lifecycleGeneration: number;
        reason: "room_archived";
      }>,
    ) {
      if (transaction.roomId !== input.roomId ||
        !isNonNegativeInteger(input.lifecycleGeneration) || input.reason !== "room_archived") {
        throw new TypeError("Offline lease invalidation input is invalid");
      }
      return useAuthorityTransactionDatabase(transaction, (database) => {
        const existing = database.prepare(`
          SELECT lifecycle_generation, lease_generation, revoked_lease_count
          FROM offline_read_lease_invalidations
          WHERE room_id = ? AND lifecycle_generation = ? AND reason = ?
        `).get(
          input.roomId,
          input.lifecycleGeneration,
          input.reason,
        ) as ExistingInvalidationRow | undefined;
        if (existing !== undefined) {
          return offlineInvalidationSuccess({
            roomId: input.roomId,
            lifecycleGeneration: existing.lifecycle_generation,
            leaseGeneration: existing.lease_generation,
            revokedLeaseCount: existing.revoked_lease_count,
            maxOfflineReadLeaseMs: options.maxOfflineReadLeaseMs,
          });
        }

        const latest = database.prepare(`
          SELECT MAX(lifecycle_generation) AS lifecycle_generation
          FROM offline_read_lease_invalidations
          WHERE room_id = ?
        `).get(input.roomId) as { lifecycle_generation: number | null };
        if (latest.lifecycle_generation !== null &&
          latest.lifecycle_generation > input.lifecycleGeneration) {
          throw new Error("Offline lease invalidation lifecycle generation is stale");
        }

        database.prepare(`
          INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
          SELECT ?, COALESCE(MAX(access_revision), 0), 0
          FROM room_memberships
          WHERE room_id = ?
          ON CONFLICT(room_id) DO NOTHING
        `).run(input.roomId, input.roomId);
        const generation = database.prepare(`
          UPDATE room_access_authority
          SET lease_generation = lease_generation + 1
          WHERE room_id = ?
          RETURNING access_revision, lease_generation
        `).get(input.roomId) as unknown as LeaseGenerationRow;
        const revoked = database.prepare(`
          UPDATE offline_read_lease_issuances
          SET revoked_at_ms = MAX(
            CAST(unixepoch('subsec') * 1000 AS INTEGER),
            issued_at_ms
          )
          WHERE room_id = ? AND revoked_at_ms IS NULL
            AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        `).run(input.roomId).changes;
        const id = offlineInvalidationId(input.roomId, input.lifecycleGeneration);
        database.prepare(`
          INSERT INTO offline_read_lease_invalidations (
            id, room_id, lifecycle_generation, access_revision, lease_generation,
            revoked_lease_count, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          input.roomId,
          input.lifecycleGeneration,
          generation.access_revision,
          generation.lease_generation,
          revoked,
          input.reason,
        );
        return offlineInvalidationSuccess({
          roomId: input.roomId,
          lifecycleGeneration: input.lifecycleGeneration,
          leaseGeneration: generation.lease_generation,
          revokedLeaseCount: Number(revoked),
          maxOfflineReadLeaseMs: options.maxOfflineReadLeaseMs,
        });
      });
    },
  });

  return Object.freeze({
    registrationId: "dao.access.offline-lease-invalidation.v1",
    feature: "offline-lease-invalidation",
    version: 1,
    enabled: true,
    participant,
  });
}

function offlineInvalidationSuccess(result: OfflineLeaseInvalidationResult) {
  return Object.freeze({ ok: true as const, result: Object.freeze(result) });
}
