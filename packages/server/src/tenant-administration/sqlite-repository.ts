import type { DatabaseSync } from "node:sqlite";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import type {
  DeploymentAuditRecord,
  GlobalAgentProfile,
  PrincipalKind,
  StoredReplay,
  TenantAdministrationRepository,
  TenantAdministrationTransaction,
  TenantAdministratorRegistry,
} from "./authority-service.js";

export interface SqliteTenantAdministrationRepositoryOptions {
  readonly database: DatabaseSync;
  readonly nowMs?: () => number;
  readonly idempotencyTtlMs?: number;
}

interface RegistryRow {
  readonly revision: unknown;
  readonly configurationDigest: unknown;
  readonly updatedAt: unknown;
}

interface ProfileRow {
  readonly profileId: unknown;
  readonly actorId: unknown;
  readonly displayName: unknown;
  readonly globalResponsibility: unknown;
  readonly status: unknown;
  readonly capabilityCeilingJson: unknown;
  readonly toolCeilingJson: unknown;
  readonly revision: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseCanonicalSet(value: unknown): readonly string[] {
  if (!nonEmpty(value)) throw new Error("deployment authority set is corrupt");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(nonEmpty) ||
      parsed.some((entry, index) => index > 0 && parsed[index - 1]!.localeCompare(entry) >= 0)) {
    throw new Error("deployment authority set is non-canonical");
  }
  return Object.freeze(parsed);
}

function profileFromRow(row: ProfileRow | undefined): GlobalAgentProfile | undefined {
  if (row === undefined) return undefined;
  if (!nonEmpty(row.profileId) || !nonEmpty(row.actorId) || !nonEmpty(row.displayName) ||
      !nonEmpty(row.globalResponsibility) ||
      (row.status !== "enabled" && row.status !== "disabled") ||
      !positiveInteger(row.revision) || !nonEmpty(row.createdAt) || !nonEmpty(row.updatedAt)) {
    throw new Error("Global Agent Profile authority is corrupt");
  }
  return Object.freeze({
    profileId: row.profileId,
    actorId: row.actorId,
    displayName: row.displayName,
    globalResponsibility: row.globalResponsibility,
    status: row.status,
    capabilityCeiling: parseCanonicalSet(row.capabilityCeilingJson),
    toolCeiling: parseCanonicalSet(row.toolCeilingJson),
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function queryProfile(database: DatabaseSync, profileId: string): GlobalAgentProfile | undefined {
  return profileFromRow(database.prepare(
    `SELECT id AS profileId, actor_id AS actorId, display_name AS displayName,
            global_responsibility AS globalResponsibility, status,
            capability_ceiling_json AS capabilityCeilingJson,
            tool_ceiling_json AS toolCeilingJson, revision,
            created_at AS createdAt, updated_at AS updatedAt
     FROM agent_profiles WHERE id = ?`,
  ).get(profileId) as ProfileRow | undefined);
}

function registry(database: DatabaseSync): TenantAdministratorRegistry | undefined {
  const row = database.prepare(
    `SELECT revision, bootstrap_configuration_sha256 AS configurationDigest,
            updated_at AS updatedAt
     FROM tenant_administrator_registry WHERE singleton_id = 1`,
  ).get() as RegistryRow | undefined;
  if (row === undefined) return undefined;
  if (!positiveInteger(row.revision) || typeof row.configurationDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.configurationDigest) || !nonEmpty(row.updatedAt)) {
    throw new Error("Tenant Administrator registry is corrupt");
  }
  const rows = database.prepare(
    `SELECT human_actor_id AS principalId
     FROM tenant_administrators WHERE status = 'active' ORDER BY human_actor_id`,
  ).all() as unknown as readonly { readonly principalId: unknown }[];
  if (rows.length === 0 || !rows.every((entry) => nonEmpty(entry.principalId))) {
    throw new Error("Tenant Administrator registry has no active Human principal");
  }
  return Object.freeze({
    revision: row.revision,
    principalIds: Object.freeze(rows.map((entry) => entry.principalId as string)),
    configurationDigest: row.configurationDigest,
    updatedAt: row.updatedAt,
  });
}

function exactContextRow(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  now: number,
): boolean {
  const row = database.prepare(
    `SELECT actor.kind AS actorKind
     FROM sessions AS session
     JOIN session_families AS family
       ON family.family_id = session.family_id
      AND family.account_id = session.account_id
      AND family.actor_id = session.actor_id
     JOIN actors AS actor ON actor.id = session.actor_id
     WHERE session.access_token_hash = ? AND session.family_id = ?
       AND session.account_id = ? AND session.actor_id = ?
       AND session.revoked_at IS NULL AND family.revoked_at IS NULL
       AND session.access_expires_at > ?`,
  ).get(context.sessionId, context.sessionFamilyId, context.principal.accountId,
    context.principal.actorId, now) as { readonly actorKind?: unknown } | undefined;
  return row?.actorKind === "human";
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function createSqliteTenantAdministrationRepository(
  options: SqliteTenantAdministrationRepositoryOptions,
): TenantAdministrationRepository {
  const database = options.database;
  const nowMs = options.nowMs ?? Date.now;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  if (!Number.isSafeInteger(idempotencyTtlMs) || idempotencyTtlMs <= 0) {
    throw new TypeError("deployment idempotency TTL must be positive");
  }

  return Object.freeze({
    async transact<TResult>(operation: (transaction: TenantAdministrationTransaction) => TResult) {
      database.exec("BEGIN IMMEDIATE");
      let currentSession: AuthenticatedSessionContext | undefined;
      try {
        const transaction: TenantAdministrationTransaction = {
          requireCurrentSession(context) {
            if (!exactContextRow(database, context, nowMs())) {
              throw Object.assign(new Error("session_revoked"), { status: 403, code: "session_revoked" });
            }
            currentSession = context;
          },
          principalKind(principalId): PrincipalKind | undefined {
            const row = database.prepare("SELECT kind FROM actors WHERE id = ?").get(principalId) as
              { readonly kind?: unknown } | undefined;
            return row?.kind === "human" || row?.kind === "agent" ? row.kind : undefined;
          },
          readAdministratorRegistry() {
            return registry(database);
          },
          writeAdministratorRegistry(next) {
            const previous = registry(database);
            if (previous === undefined) {
              database.prepare(
                `INSERT INTO tenant_administrator_registry (
                   singleton_id, revision, bootstrap_configuration_sha256, initialized_at, updated_at
                 ) VALUES (1, ?, ?, ?, ?)`,
              ).run(next.revision, next.configurationDigest, next.updatedAt, next.updatedAt);
              for (const principalId of next.principalIds) {
                database.prepare(
                  `INSERT INTO tenant_administrators (
                     human_actor_id, revision, status, source_kind, created_by_human_actor_id,
                     created_at, updated_at, removed_at
                   ) VALUES (?, 1, 'active', 'bootstrap', NULL, ?, ?, NULL)`,
                ).run(principalId, next.updatedAt, next.updatedAt);
                database.prepare(
                  `INSERT INTO tenant_administrator_revisions (
                     human_actor_id, revision, status, operation,
                     changed_by_human_actor_id, changed_at
                   ) VALUES (?, 1, 'active', 'bootstrap', NULL, ?)`,
                ).run(principalId, next.updatedAt);
              }
              return;
            }
            if (currentSession === undefined || next.revision !== previous.revision + 1 ||
                next.configurationDigest !== previous.configurationDigest) {
              throw new Error("Tenant Administrator registry write is not authorized");
            }
            const added = next.principalIds.filter((id) => !previous.principalIds.includes(id));
            const removed = previous.principalIds.filter((id) => !next.principalIds.includes(id));
            if (added.length + removed.length !== 1 ||
                !sameSet([...next.principalIds].sort(), next.principalIds)) {
              throw new Error("Tenant Administrator mutation must change one canonical binding");
            }
            const principalId = (added[0] ?? removed[0])!;
            const old = database.prepare(
              `SELECT revision, status FROM tenant_administrators WHERE human_actor_id = ?`,
            ).get(principalId) as { readonly revision?: unknown; readonly status?: unknown } | undefined;
            const bindingRevision = old === undefined ? 1 : Number(old.revision) + 1;
            const operationKind = added.length === 1 ? "add" : "remove";
            const status = added.length === 1 ? "active" : "removed";
            if (old === undefined) {
              database.prepare(
                `INSERT INTO tenant_administrators (
                   human_actor_id, revision, status, source_kind, created_by_human_actor_id,
                   created_at, updated_at, removed_at
                 ) VALUES (?, ?, 'active', 'administrator_command', ?, ?, ?, NULL)`,
              ).run(principalId, bindingRevision, currentSession.principal.actorId,
                next.updatedAt, next.updatedAt);
            } else {
              database.prepare(
                `UPDATE tenant_administrators
                 SET revision = ?, status = ?, source_kind = 'administrator_command',
                     updated_at = ?, removed_at = ?
                 WHERE human_actor_id = ?`,
              ).run(bindingRevision, status, next.updatedAt,
                status === "removed" ? next.updatedAt : null, principalId);
            }
            database.prepare(
              `INSERT INTO tenant_administrator_revisions (
                 human_actor_id, revision, status, operation,
                 changed_by_human_actor_id, changed_at
               ) VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(principalId, bindingRevision, status, operationKind,
              currentSession.principal.actorId, next.updatedAt);
            const updated = database.prepare(
              `UPDATE tenant_administrator_registry
               SET revision = ?, updated_at = ?
               WHERE singleton_id = 1 AND revision = ?`,
            ).run(next.revision, next.updatedAt, previous.revision);
            if (updated.changes !== 1) throw new Error("Tenant Administrator registry CAS failed");
          },
          readProfile(profileId) {
            return queryProfile(database, profileId);
          },
          listProfiles() {
            const rows = database.prepare(
              `SELECT id AS profileId, actor_id AS actorId, display_name AS displayName,
                      global_responsibility AS globalResponsibility, status,
                      capability_ceiling_json AS capabilityCeilingJson,
                      tool_ceiling_json AS toolCeilingJson, revision,
                      created_at AS createdAt, updated_at AS updatedAt
               FROM agent_profiles ORDER BY id`,
            ).all() as unknown as readonly ProfileRow[];
            return rows.map((row) => profileFromRow(row)!);
          },
          createAgentActor(actorId, displayName) {
            database.prepare(
              `INSERT INTO actors (
                 id, kind, display_name, reachability, readiness, tool_permissions_json
               ) VALUES (?, 'agent', ?, NULL, 'noauth', '[]')`,
            ).run(actorId, displayName);
            database.prepare(
              `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
               VALUES ('identity', ?, 0, 1)`,
            ).run(actorId);
          },
          writeProfile(profile) {
            const previous = queryProfile(database, profile.profileId);
            const capabilityJson = JSON.stringify(profile.capabilityCeiling);
            const toolJson = JSON.stringify(profile.toolCeiling);
            let operationKind: "create" | "update" | "enable" | "disable";
            if (previous === undefined) {
              operationKind = "create";
              database.prepare(
                `INSERT INTO agent_profiles (
                   id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json,
                   display_name, global_responsibility, created_at, updated_at, source_kind
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'administrator_command')`,
              ).run(profile.profileId, profile.actorId, profile.revision, profile.status,
                capabilityJson, toolJson, profile.displayName, profile.globalResponsibility,
                profile.createdAt, profile.updatedAt);
            } else {
              if (profile.actorId !== previous.actorId || profile.createdAt !== previous.createdAt ||
                  profile.revision !== previous.revision + 1) {
                throw new Error("Global Agent Profile identity or CAS is invalid");
              }
              operationKind = profile.status !== previous.status
                ? (profile.status === "enabled" ? "enable" : "disable") : "update";
              const updated = database.prepare(
                `UPDATE agent_profiles
                 SET revision = ?, status = ?, capability_ceiling_json = ?, tool_ceiling_json = ?,
                     display_name = ?, global_responsibility = ?, updated_at = ?,
                     source_kind = 'administrator_command'
                 WHERE id = ? AND revision = ?`,
              ).run(profile.revision, profile.status, capabilityJson, toolJson,
                profile.displayName, profile.globalResponsibility, profile.updatedAt,
                profile.profileId, previous.revision);
              if (updated.changes !== 1) throw new Error("Global Agent Profile CAS failed");
              database.prepare("UPDATE actors SET display_name = ? WHERE id = ? AND kind = 'agent'")
                .run(profile.displayName, profile.actorId);
            }
            if (currentSession === undefined) throw new Error("Profile write requires current session");
            database.prepare(
              `INSERT INTO agent_profile_revisions (
                 profile_id, revision, actor_id, display_name, global_responsibility, status,
                 capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id,
                 changed_at, operation
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(profile.profileId, profile.revision, profile.actorId, profile.displayName,
              profile.globalResponsibility, profile.status, capabilityJson, toolJson,
              currentSession.principal.actorId, profile.updatedAt, operationKind);
          },
          readReplay(key): StoredReplay | undefined {
            const separator = key.indexOf("\0");
            if (separator < 1) throw new Error("Deployment replay key is invalid");
            const scope = key.slice(0, separator);
            const idempotencyKey = key.slice(separator + 1);
            const row = database.prepare(
              `SELECT principal_actor_id AS principalActorId, request_sha256 AS fingerprint,
                      response_json AS responseJson, expires_at_ms AS expiresAt
               FROM deployment_idempotency_records
               WHERE scope = ? AND idempotency_key = ?`,
            ).get(scope, idempotencyKey) as {
              readonly principalActorId?: unknown; readonly fingerprint?: unknown;
              readonly responseJson?: unknown; readonly expiresAt?: unknown;
            } | undefined;
            if (row === undefined) {
              return undefined;
            }
            if (typeof row.expiresAt === "number" && row.expiresAt <= nowMs()) {
              database.prepare(
                `DELETE FROM deployment_idempotency_records
                 WHERE scope = ? AND idempotency_key = ? AND expires_at_ms <= ?`,
              ).run(scope, idempotencyKey, nowMs());
              return undefined;
            }
            if (currentSession === undefined || row.principalActorId !== currentSession.principal.actorId ||
                !nonEmpty(row.fingerprint) || !nonEmpty(row.responseJson)) {
              throw Object.assign(new Error("idempotency_conflict"), {
                status: 409, code: "idempotency_conflict",
              });
            }
            return Object.freeze({ fingerprint: row.fingerprint, result: JSON.parse(row.responseJson) });
          },
          writeReplay(key, requestFingerprint, result) {
            if (currentSession === undefined) throw new Error("Deployment replay requires current session");
            const separator = key.indexOf("\0");
            const scope = key.slice(0, separator);
            const idempotencyKey = key.slice(separator + 1);
            const createdAt = nowMs();
            database.prepare(
              `INSERT INTO deployment_idempotency_records (
                 scope, idempotency_key, principal_actor_id, request_sha256, response_json,
                 status_code, created_at_ms, expires_at_ms
               ) VALUES (?, ?, ?, ?, ?, 200, ?, ?)`,
            ).run(scope, idempotencyKey, currentSession.principal.actorId, requestFingerprint,
              JSON.stringify(result), createdAt, createdAt + idempotencyTtlMs);
          },
          appendAudit(record: DeploymentAuditRecord) {
            const subjectKind = record.action.startsWith("administrator.")
              ? "tenant_administrator" : "agent_profile";
            database.prepare(
              `INSERT INTO deployment_audit (
                 audit_id, event_kind, principal_human_actor_id, subject_kind, subject_id,
                 subject_revision, request_id, occurred_at, details_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
            ).run(record.auditId, record.action, record.actorId, subjectKind,
              record.targetId, record.revision, record.requestId, record.occurredAt);
          },
        };
        const result = operation(transaction);
        database.exec("COMMIT");
        return result;
      } catch (error: unknown) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  });
}
