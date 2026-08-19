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
    uniqueKey: Object.freeze(["room_id", "target_actor_id", "access_revision", "reason"]),
  }),
  offlineLeaseInvalidation: Object.freeze({
    targetColumn: "target_actor_id TEXT REFERENCES actors(id)",
    reasonValue: "member_removed",
    uniqueKey: Object.freeze(["room_id", "target_actor_id", "access_revision", "reason"]),
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

export interface MemberAccessRevocationInput {
  readonly roomId: string;
  readonly targetActorId: string;
  readonly occurredAtMs: number;
}

export type MemberAccessRevocationResult = Readonly<{
  readonly outcome: "schema_capability_blocked";
  readonly blocker: Readonly<{
    readonly code: "target_access_revocation_schema_unavailable";
    readonly minimumSchemaVersion: 15;
    readonly missingCapabilities: readonly MemberAccessRevocationMissingCapability[];
  }>;
}>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function hasMemberRemovedUniqueKey(sql: readonly string[]): boolean {
  return sql.some((definition) => definition.includes("unique") &&
    definition.includes("room_id") && definition.includes("target_actor_id") &&
    definition.includes("access_revision") && definition.includes("reason") &&
    definition.includes("member_removed"));
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
    if (!hasMemberRemovedUniqueKey(sql)) missing.push(capability.uniqueCapability);
  }
  return Object.freeze(missing);
}

export function coordinateMemberAccessRevocationInTransaction(
  transaction: AuthorityTransactionView,
  input: MemberAccessRevocationInput,
): MemberAccessRevocationResult {
  if (transaction.roomId !== input.roomId || !isNonEmptyString(input.roomId) ||
      !isNonEmptyString(input.targetActorId) ||
      !Number.isSafeInteger(input.occurredAtMs) || input.occurredAtMs < 0) {
    throw new TypeError("Member access revocation input is invalid");
  }
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const missing = missingCapabilities(database);
    if (missing.length === 0) {
      throw new Error(
        "Target access revocation schema is present but its v15 production provider is not wired",
      );
    }
    return Object.freeze({
      outcome: "schema_capability_blocked" as const,
      blocker: Object.freeze({
        code: "target_access_revocation_schema_unavailable" as const,
        minimumSchemaVersion: MEMBER_ACCESS_REVOCATION_V15_REQUIREMENTS.minimumSchemaVersion,
        missingCapabilities: missing,
      }),
    });
  });
}
