import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  useAuthorityTransactionDatabase,
} from "../persistence/authority-transaction-database.js";
import type { AuthorityTransactionView } from "./private-participant-contracts.js";

export const MEMBER_ACCESS_REVOCATION_V15_REQUIREMENTS = Object.freeze({
  minimumSchemaVersion: 15,
  cacheInvalidation: Object.freeze({
    targetColumn: "target_actor_id TEXT REFERENCES actors(id)",
    reasonValue: "member_removed",
    uniqueKey: Object.freeze([
      "room_id", "lifecycle_generation", "reason", "COALESCE(target_actor_id, '')",
    ]),
  }),
  offlineLeaseInvalidation: Object.freeze({
    targetColumn: "target_actor_id TEXT REFERENCES actors(id)",
    reasonValue: "member_removed",
    uniqueKey: Object.freeze([
      "room_id", "lifecycle_generation", "reason", "COALESCE(target_actor_id, '')",
    ]),
  }),
  archiveScopeRule: "room_archived requires target_actor_id IS NULL",
  memberScopeRule: "member_removed requires target_actor_id IS NOT NULL",
} as const);

const CAPABILITIES = Object.freeze([
  Object.freeze({
    table: "room_cache_invalidation_intents",
    column: "target_actor_id",
    columnCapability: "room_cache_invalidation_intents.target_actor_id",
    reasonCapability: "room_cache_invalidation_intents.reason:member_removed",
    uniqueCapability: "room_cache_invalidation_intents.member_removed_unique_key",
  }),
  Object.freeze({
    table: "offline_read_lease_invalidations",
    column: "target_actor_id",
    columnCapability: "offline_read_lease_invalidations.target_actor_id",
    reasonCapability: "offline_read_lease_invalidations.reason:member_removed",
    uniqueCapability: "offline_read_lease_invalidations.member_removed_unique_key",
  }),
] as const);

export type MemberAccessRevocationMissingCapability =
  | typeof CAPABILITIES[number]["columnCapability"]
  | typeof CAPABILITIES[number]["reasonCapability"]
  | typeof CAPABILITIES[number]["uniqueCapability"];

export type MemberAccessRevocationErrorCode =
  | "invalid_request"
  | "transaction_mismatch"
  | "room_not_found"
  | "room_forbidden"
  | "member_access_revision_conflict"
  | "storage_unavailable";

export class MemberAccessRevocationError extends Error {
  constructor(readonly code: MemberAccessRevocationErrorCode) {
    super(code);
    this.name = "MemberAccessRevocationError";
  }
}

export interface MemberAccessRevocationInput {
  readonly roomId: string;
  readonly targetActorId: string;
  readonly expectedAccessRevision: number;
  readonly occurredAtMs: number;
}

export interface AppliedMemberAccessRevocation {
  readonly outcome: "applied" | "already_applied";
  readonly roomId: string;
  readonly targetActorId: string;
  readonly lifecycleGeneration: number;
  readonly targetAccessRevision: number;
  readonly leaseGeneration: number;
  readonly revokedLeaseCount: number;
  readonly cacheInvalidationIntentId: string;
  readonly offlineLeaseInvalidationId: string;
}

export type MemberAccessRevocationResult =
  | Readonly<AppliedMemberAccessRevocation>
  | Readonly<{
      readonly outcome: "schema_capability_blocked";
      readonly blocker: Readonly<{
        readonly code: "target_access_revocation_schema_unavailable";
        readonly minimumSchemaVersion: 15;
        readonly missingCapabilities: readonly MemberAccessRevocationMissingCapability[];
      }>;
    }>;

interface RoomAuthorityRow {
  readonly lifecycleGeneration: unknown;
  readonly leaseGeneration: unknown;
}

interface MembershipRow {
  readonly kind: unknown;
  readonly actorKind: unknown;
  readonly accessRevision: unknown;
}

interface CacheInvalidationRow {
  readonly id: unknown;
  readonly lifecycleGeneration: unknown;
  readonly accessRevision: unknown;
  readonly reason: unknown;
  readonly targetActorId: unknown;
  readonly status: unknown;
}

interface OfflineInvalidationRow {
  readonly id: unknown;
  readonly lifecycleGeneration: unknown;
  readonly accessRevision: unknown;
  readonly leaseGeneration: unknown;
  readonly revokedLeaseCount: unknown;
  readonly reason: unknown;
  readonly targetActorId: unknown;
}

function fail(code: MemberAccessRevocationErrorCode): never {
  throw new MemberAccessRevocationError(code);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tableColumns(database: DatabaseSync, table: string): ReadonlySet<string> {
  return new Set(database.prepare(`PRAGMA table_info('${table}')`).all()
    .flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}

function definitions(database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND (
      (type = 'table' AND name = ?) OR (type = 'index' AND tbl_name = ?)
    )
    ORDER BY type, name
  `).all(table, table)
    .flatMap((row) => typeof row.sql === "string"
      ? [row.sql.toLowerCase()]
      : []);
}

function hasTargetScopeUniqueKey(sql: readonly string[]): boolean {
  return sql.some((definition) => definition.includes("unique") &&
    definition.includes("room_id") && definition.includes("lifecycle_generation") &&
    definition.includes("reason") && definition.includes("target_actor_id") &&
    definition.includes("coalesce"));
}

function missingCapabilities(
  database: DatabaseSync,
): readonly MemberAccessRevocationMissingCapability[] {
  const missing: MemberAccessRevocationMissingCapability[] = [];
  for (const capability of CAPABILITIES) {
    const columns = tableColumns(database, capability.table);
    const sql = definitions(database, capability.table);
    if (!columns.has(capability.column)) missing.push(capability.columnCapability);
    if (!sql.some((definition) => definition.includes("member_removed"))) {
      missing.push(capability.reasonCapability);
    }
    if (!hasTargetScopeUniqueKey(sql)) missing.push(capability.uniqueCapability);
  }
  return Object.freeze(missing);
}

function deterministicId(
  prefix: "member-cache-invalidation" | "member-lease-invalidation",
  input: MemberAccessRevocationInput,
  lifecycleGeneration: number,
  targetAccessRevision: number,
): string {
  const digest = createHash("sha256")
    .update(prefix)
    .update("\0")
    .update(input.roomId)
    .update("\0")
    .update(input.targetActorId)
    .update("\0")
    .update(String(lifecycleGeneration))
    .update("\0")
    .update(String(targetAccessRevision))
    .update("\0member_removed")
    .digest("hex");
  return `${prefix}-${digest}`;
}

function readRoomAuthority(database: DatabaseSync, roomId: string): Readonly<{
  lifecycleGeneration: number;
  leaseGeneration: number;
}> {
  const row = database.prepare(`
    SELECT room.archive_generation AS lifecycleGeneration,
           COALESCE(access.lease_generation, 0) AS leaseGeneration
    FROM rooms AS room
    LEFT JOIN room_access_authority AS access ON access.room_id = room.id
    WHERE room.id = ?
  `).get(roomId) as RoomAuthorityRow | undefined;
  if (row === undefined) fail("room_not_found");
  if (!isNonNegativeInteger(row.lifecycleGeneration) ||
      !isNonNegativeInteger(row.leaseGeneration)) {
    fail("storage_unavailable");
  }
  return {
    lifecycleGeneration: row.lifecycleGeneration,
    leaseGeneration: row.leaseGeneration,
  };
}

function readExistingInvalidations(
  database: DatabaseSync,
  input: MemberAccessRevocationInput,
  lifecycleGeneration: number,
): Readonly<{
  cache: CacheInvalidationRow | undefined;
  offline: OfflineInvalidationRow | undefined;
}> {
  const cacheRows = database.prepare(`
    SELECT id, lifecycle_generation AS lifecycleGeneration,
           access_revision AS accessRevision, reason,
           target_actor_id AS targetActorId, status
    FROM room_cache_invalidation_intents
    WHERE room_id = ? AND lifecycle_generation = ?
      AND reason = 'member_removed' AND target_actor_id = ?
  `).all(input.roomId, lifecycleGeneration, input.targetActorId) as unknown as CacheInvalidationRow[];
  const offlineRows = database.prepare(`
    SELECT id, lifecycle_generation AS lifecycleGeneration,
           access_revision AS accessRevision, lease_generation AS leaseGeneration,
           revoked_lease_count AS revokedLeaseCount, reason,
           target_actor_id AS targetActorId
    FROM offline_read_lease_invalidations
    WHERE room_id = ? AND lifecycle_generation = ?
      AND reason = 'member_removed' AND target_actor_id = ?
  `).all(input.roomId, lifecycleGeneration, input.targetActorId) as unknown as OfflineInvalidationRow[];
  if (cacheRows.length > 1 || offlineRows.length > 1) fail("storage_unavailable");
  return { cache: cacheRows[0], offline: offlineRows[0] };
}

function existingResult(
  database: DatabaseSync,
  input: MemberAccessRevocationInput,
  room: Readonly<{ lifecycleGeneration: number; leaseGeneration: number }>,
  existing: Readonly<{
    cache: CacheInvalidationRow | undefined;
    offline: OfflineInvalidationRow | undefined;
  }>,
): Readonly<AppliedMemberAccessRevocation> | undefined {
  if (existing.cache === undefined && existing.offline === undefined) return undefined;
  if (existing.cache === undefined || existing.offline === undefined) fail("storage_unavailable");
  const targetAccessRevision = input.expectedAccessRevision + 1;
  if (!Number.isSafeInteger(targetAccessRevision) ||
      existing.cache.id !== deterministicId(
        "member-cache-invalidation", input, room.lifecycleGeneration, targetAccessRevision,
      ) ||
      existing.offline.id !== deterministicId(
        "member-lease-invalidation", input, room.lifecycleGeneration, targetAccessRevision,
      ) ||
      existing.cache.lifecycleGeneration !== room.lifecycleGeneration ||
      existing.offline.lifecycleGeneration !== room.lifecycleGeneration ||
      existing.cache.accessRevision !== targetAccessRevision ||
      existing.offline.accessRevision !== targetAccessRevision ||
      existing.cache.reason !== "member_removed" ||
      existing.offline.reason !== "member_removed" ||
      existing.cache.targetActorId !== input.targetActorId ||
      existing.offline.targetActorId !== input.targetActorId ||
      (existing.cache.status !== "pending" && existing.cache.status !== "completed" &&
        existing.cache.status !== "dead_letter") ||
      existing.offline.leaseGeneration !== room.leaseGeneration ||
      !isNonNegativeInteger(existing.offline.revokedLeaseCount)) {
    fail("storage_unavailable");
  }
  const membership = database.prepare(`
    SELECT membership.kind, actor.kind AS actorKind,
           membership.access_revision AS accessRevision
    FROM room_memberships AS membership
    JOIN actors AS actor ON actor.id = membership.actor_id
    WHERE membership.room_id = ? AND membership.actor_id = ?
  `).get(input.roomId, input.targetActorId) as MembershipRow | undefined;
  if (membership !== undefined &&
      (membership.kind !== "human" || membership.actorKind !== "human" ||
        membership.accessRevision !== targetAccessRevision)) {
    fail("storage_unavailable");
  }
  return Object.freeze({
    outcome: "already_applied" as const,
    roomId: input.roomId,
    targetActorId: input.targetActorId,
    lifecycleGeneration: room.lifecycleGeneration,
    targetAccessRevision,
    leaseGeneration: room.leaseGeneration,
    revokedLeaseCount: existing.offline.revokedLeaseCount,
    cacheInvalidationIntentId: existing.cache.id,
    offlineLeaseInvalidationId: existing.offline.id,
  });
}

function applyRevocation(
  database: DatabaseSync,
  input: MemberAccessRevocationInput,
  room: Readonly<{ lifecycleGeneration: number; leaseGeneration: number }>,
): Readonly<AppliedMemberAccessRevocation> {
  const membership = database.prepare(`
    SELECT membership.kind, actor.kind AS actorKind,
           membership.access_revision AS accessRevision
    FROM room_memberships AS membership
    JOIN actors AS actor ON actor.id = membership.actor_id
    WHERE membership.room_id = ? AND membership.actor_id = ?
  `).get(input.roomId, input.targetActorId) as MembershipRow | undefined;
  if (membership === undefined || membership.kind !== "human" || membership.actorKind !== "human") {
    fail("room_forbidden");
  }
  if (!isNonNegativeInteger(membership.accessRevision)) fail("storage_unavailable");
  if (membership.accessRevision !== input.expectedAccessRevision) {
    fail("member_access_revision_conflict");
  }
  const targetAccessRevision = input.expectedAccessRevision + 1;
  if (!Number.isSafeInteger(targetAccessRevision)) fail("storage_unavailable");
  const revision = database.prepare(`
    UPDATE room_memberships
    SET access_revision = access_revision + 1
    WHERE room_id = ? AND actor_id = ? AND kind = 'human' AND access_revision = ?
    RETURNING access_revision AS accessRevision
  `).get(
    input.roomId,
    input.targetActorId,
    input.expectedAccessRevision,
  );
  if (revision?.accessRevision !== targetAccessRevision) {
    fail("member_access_revision_conflict");
  }
  const cacheId = deterministicId(
    "member-cache-invalidation", input, room.lifecycleGeneration, targetAccessRevision,
  );
  database.prepare(`
    INSERT INTO room_cache_invalidation_intents (
      id, room_id, lifecycle_generation, access_revision, reason, target_actor_id
    ) VALUES (?, ?, ?, ?, 'member_removed', ?)
  `).run(
    cacheId,
    input.roomId,
    room.lifecycleGeneration,
    targetAccessRevision,
    input.targetActorId,
  );
  const revokedLeaseCount = Number(database.prepare(`
    UPDATE offline_read_lease_issuances
    SET revoked_at_ms = MAX(?, issued_at_ms)
    WHERE room_id = ? AND actor_id = ? AND revoked_at_ms IS NULL
      AND expires_at_ms > ?
  `).run(
    input.occurredAtMs,
    input.roomId,
    input.targetActorId,
    input.occurredAtMs,
  ).changes);
  if (!isNonNegativeInteger(revokedLeaseCount)) fail("storage_unavailable");
  const offlineId = deterministicId(
    "member-lease-invalidation", input, room.lifecycleGeneration, targetAccessRevision,
  );
  database.prepare(`
    INSERT INTO offline_read_lease_invalidations (
      id, room_id, lifecycle_generation, access_revision, lease_generation,
      revoked_lease_count, reason, target_actor_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'member_removed', ?)
  `).run(
    offlineId,
    input.roomId,
    room.lifecycleGeneration,
    targetAccessRevision,
    room.leaseGeneration,
    revokedLeaseCount,
    input.targetActorId,
  );
  return Object.freeze({
    outcome: "applied" as const,
    roomId: input.roomId,
    targetActorId: input.targetActorId,
    lifecycleGeneration: room.lifecycleGeneration,
    targetAccessRevision,
    leaseGeneration: room.leaseGeneration,
    revokedLeaseCount,
    cacheInvalidationIntentId: cacheId,
    offlineLeaseInvalidationId: offlineId,
  });
}

export function coordinateMemberAccessRevocationInTransaction(
  transaction: AuthorityTransactionView,
  input: MemberAccessRevocationInput,
): MemberAccessRevocationResult {
  if (transaction.roomId !== input.roomId) fail("transaction_mismatch");
  if (!isNonEmptyString(input.roomId) || !isNonEmptyString(input.targetActorId) ||
      !isNonNegativeInteger(input.expectedAccessRevision) ||
      !isNonNegativeInteger(input.occurredAtMs)) {
    fail("invalid_request");
  }
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const missing = missingCapabilities(database);
    if (missing.length > 0) {
      return Object.freeze({
        outcome: "schema_capability_blocked" as const,
        blocker: Object.freeze({
          code: "target_access_revocation_schema_unavailable" as const,
          minimumSchemaVersion: MEMBER_ACCESS_REVOCATION_V15_REQUIREMENTS.minimumSchemaVersion,
          missingCapabilities: missing,
        }),
      });
    }
    const room = readRoomAuthority(database, input.roomId);
    const existing = existingResult(
      database,
      input,
      room,
      readExistingInvalidations(database, input, room.lifecycleGeneration),
    );
    return existing ?? applyRevocation(database, input, room);
  });
}
