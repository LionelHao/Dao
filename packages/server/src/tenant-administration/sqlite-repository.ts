import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import type {
  CredentialReadiness,
  DeploymentAuditRecord,
  DeploymentProfileMutationRecord,
  GlobalAgentProfile,
  PrincipalKind,
  StoredReplay,
  TenantAdministrationRepository,
  TenantAdministrationTransaction,
  TenantAdministratorRegistry,
} from "./authority-service.js";
import { TenantAdministrationError } from "./authority-service.js";

export interface SqliteTenantAdministrationRepositoryOptions {
  readonly database: DatabaseSync;
  readonly nowMs?: () => number;
  readonly idempotencyTtlMs?: number;
  readonly profileAssignmentFanoutLimit?: number;
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
export const DEFAULT_PROFILE_ASSIGNMENT_FANOUT_LIMIT = 64;

interface AssignmentFanoutTarget {
  readonly assignmentId: string;
  readonly roomId: string;
  readonly profileId: string;
  readonly actorId: string;
  readonly revision: number;
  readonly participation: "active" | "on-mention";
  readonly paused: boolean;
  readonly roomResponsibility: string;
  readonly capabilitySubset: readonly string[];
  readonly toolSubset: readonly string[];
  readonly membershipTools: readonly string[];
  readonly createdAt: string;
  readonly roomStatus: "active" | "archived";
  readonly roomRevision: number;
  readonly accessRevision: number | null;
  readonly accessValid: boolean;
  readonly runningExecutionCount: number;
}

interface AppliedProfileFanout {
  readonly profileId: string;
  readonly fromProfileRevision: number;
  readonly toProfileRevision: number;
  readonly credentialReadiness: CredentialReadiness;
  readonly targets: readonly AssignmentFanoutTarget[];
  readonly invalidatedContextCount: number;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function intersect(
  subset: readonly string[],
  ceiling: readonly string[],
): readonly string[] {
  const allowed = new Set(ceiling);
  return Object.freeze(subset.filter((entry) => allowed.has(entry)));
}

function roomAssignmentProjection(
  profile: GlobalAgentProfile,
  target: AssignmentFanoutTarget,
  credentialReadiness: CredentialReadiness,
): Readonly<Record<string, unknown>> {
  const availability = target.paused ? "paused"
    : credentialReadiness === "noauth" ? "noauth"
    : target.runningExecutionCount > 0 ? "busy" : "ready";
  return Object.freeze({
    recordVersion: "room-agent-assignment.v1",
    assignmentId: target.assignmentId,
    roomId: target.roomId,
    profileId: profile.profileId,
    actorId: profile.actorId,
    displayName: profile.displayName,
    globalResponsibility: profile.globalResponsibility,
    roomResponsibility: target.roomResponsibility,
    participation: target.participation,
    availability,
    paused: target.paused,
    capabilityCeiling: profile.capabilityCeiling,
    capabilitySubset: target.capabilitySubset,
    effectiveCapabilities: target.capabilitySubset,
    toolCeiling: profile.toolCeiling,
    toolSubset: target.toolSubset,
    effectiveTools: intersect(target.toolSubset, target.membershipTools),
    profileRevision: profile.revision,
    assignmentRevision: target.revision,
    accessRevision: target.accessRevision ?? 0,
    updatedAt: profile.updatedAt,
  });
}

function appendRoomProfileFanout(
  database: DatabaseSync,
  record: DeploymentProfileMutationRecord,
  fanout: AppliedProfileFanout,
): void {
  const { profile } = record;
  for (const target of fanout.targets) {
    const eventId = `profile-room-event-${sha256(`${record.eventId}\0${target.assignmentId}`)}`;
    const visible = profile.status === "enabled" && target.roomStatus === "active" &&
      target.accessValid && target.accessRevision !== null;
    const payload = visible
      ? { change: "upserted", roomRevision: target.roomRevision,
          assignment: roomAssignmentProjection(profile, target, fanout.credentialReadiness) }
      : { change: "removed", roomRevision: target.roomRevision,
          assignmentId: target.assignmentId, actorId: target.actorId,
          assignmentRevision: target.revision };
    const stream = database.prepare(
      `SELECT head_seq AS headSeq FROM streams
       WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(target.roomId) as { readonly headSeq?: unknown } | undefined;
    if (!nonNegativeInteger(stream?.headSeq) || stream.headSeq >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Profile fan-out Room stream is unavailable");
    }
    const streamSeq = stream.headSeq + 1;
    const advanced = database.prepare(
      `UPDATE streams SET head_seq = ?
       WHERE stream_kind = 'room' AND stream_id = ? AND head_seq = ?`,
    ).run(streamSeq, target.roomId, stream.headSeq);
    if (advanced.changes !== 1) {
      throw new Error("Profile fan-out Room stream changed concurrently");
    }
    database.prepare(
      `INSERT INTO events (
         event_id, stream_kind, stream_id, stream_seq, room_id,
         actor_id, event_type, occurred_at, payload_json
       ) VALUES (?, 'room', ?, ?, ?, ?, 'room.agent-assignment.changed', ?, ?)`,
    ).run(eventId, target.roomId, streamSeq, target.roomId, target.actorId,
      record.occurredAt, JSON.stringify(payload));
    database.prepare(
      `INSERT INTO outbox_deliveries (
         id, event_id, target_kind, target_id, stream_seq, status,
         attempts, available_at, delivered_at, last_error
       ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
    ).run(`profile-room-outbox-${sha256(eventId)}`, eventId, target.roomId,
      streamSeq, record.occurredAt);
    database.prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.agent.configured', ?, ?, 'configured', ?, ?)`,
    ).run(`profile-room-audit-${sha256(eventId)}`, target.roomId, target.actorId,
      record.occurredAt, JSON.stringify({
        operation: "profile-fanout",
        reason: record.eventKind,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        assignmentId: target.assignmentId,
        assignmentRevision: target.revision,
      }));
  }
}

function deploymentProfileProjection(record: DeploymentProfileMutationRecord): string {
  const { profile } = record;
  return JSON.stringify({
    schemaVersion: 1,
    profileId: profile.profileId,
    actorId: profile.actorId,
    displayName: profile.displayName,
    globalResponsibility: profile.globalResponsibility,
    status: profile.status,
    capabilityCeiling: profile.capabilityCeiling,
    toolCeiling: profile.toolCeiling,
    revision: profile.revision,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  });
}

function appendDeploymentProfileMutation(
  database: DatabaseSync,
  record: DeploymentProfileMutationRecord,
  fanout?: AppliedProfileFanout,
): void {
  const { profile } = record;
  let invalidatedContextCount = 0;
  let cancelledRouteIntentCount = 0;
  let affectedAssignmentCount = 0;
  if (record.previousRevision !== null) {
    if (fanout === undefined || fanout.profileId !== profile.profileId ||
        fanout.fromProfileRevision !== record.previousRevision ||
        fanout.toProfileRevision !== profile.revision) {
      throw new Error("Profile Assignment fan-out plan is unavailable");
    }
    affectedAssignmentCount = fanout.targets.length;
    invalidatedContextCount = fanout.invalidatedContextCount + Number(database.prepare(
      `UPDATE context_snapshots
       SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
           invalidated_at = ?, invalidation_reason = 'authorization_changed'
       WHERE agent_id = ? AND state = 'active'`,
    ).run(record.occurredAt, profile.actorId).changes);
    cancelledRouteIntentCount = Number(database.prepare(
      `UPDATE routed_agent_invocation_intents
       SET status = 'cancelled', cancelled_at = ?,
           cancellation_reason = 'profile_revision_changed'
       WHERE profile_id = ? AND profile_revision = ? AND status = 'pending'`,
    ).run(record.occurredAt, profile.profileId, record.previousRevision).changes);
    const reason = record.eventKind === "profile.updated" ? "profile_updated"
      : record.eventKind === "profile.disabled" ? "profile_disabled" : "profile_enabled";
    database.prepare(
      `INSERT INTO agent_profile_invalidation_facts (
         invalidation_id, profile_id, from_revision, to_revision, reason,
         invalidated_context_count, cancelled_route_intent_count,
         affected_assignment_count, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`profile-invalidation-${sha256(record.eventId)}`, profile.profileId,
      record.previousRevision, profile.revision, reason, invalidatedContextCount,
      cancelledRouteIntentCount, affectedAssignmentCount, record.occurredAt);
    appendRoomProfileFanout(database, record, fanout);
  }

  const stream = database.prepare(
    `UPDATE deployment_stream SET head_seq = head_seq + 1
     WHERE singleton_id = 1 RETURNING head_seq AS streamSeq`,
  ).get() as { readonly streamSeq?: unknown } | undefined;
  if (typeof stream?.streamSeq !== "number" || !positiveInteger(stream.streamSeq)) {
    throw new Error("Deployment Profile stream is unavailable");
  }
  const projectionJson = deploymentProfileProjection(record);
  const payloadJson = JSON.stringify({
    schemaVersion: 1,
    eventId: record.eventId,
    eventKind: record.eventKind,
    occurredAt: record.occurredAt,
    profile: JSON.parse(projectionJson) as unknown,
  });
  database.prepare(
    `INSERT INTO deployment_agent_profile_events (
       event_id, stream_seq, profile_id, profile_revision, actor_id, event_kind,
       occurred_at, payload_json, payload_sha256
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(record.eventId, stream.streamSeq, profile.profileId, profile.revision,
    profile.actorId, record.eventKind, record.occurredAt, payloadJson, sha256(payloadJson));
  database.prepare(
    `INSERT INTO deployment_agent_profile_repair_records (
       profile_id, profile_revision, record_version, event_id, stream_seq,
       projection_json, projection_sha256, updated_at
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       profile_revision = excluded.profile_revision,
       event_id = excluded.event_id,
       stream_seq = excluded.stream_seq,
       projection_json = excluded.projection_json,
       projection_sha256 = excluded.projection_sha256,
       updated_at = excluded.updated_at`,
  ).run(profile.profileId, profile.revision, record.eventId, stream.streamSeq,
    projectionJson, sha256(projectionJson), record.occurredAt);
  const administrators = database.prepare(
    `SELECT human_actor_id AS principalId FROM tenant_administrators
     WHERE status = 'active' ORDER BY human_actor_id`,
  ).all() as unknown as readonly { readonly principalId?: unknown }[];
  for (const administrator of administrators) {
    if (!nonEmpty(administrator.principalId)) {
      throw new Error("Deployment Profile outbox recipient is corrupt");
    }
    const outboxId = `deployment-profile-outbox-${sha256(
      `${record.eventId}\0${administrator.principalId}`,
    )}`;
    database.prepare(
      `INSERT INTO deployment_profile_outbox (
         id, event_id, recipient_human_actor_id, stream_seq, status, attempts,
         available_at, delivered_at, last_error
       ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL)`,
    ).run(outboxId, record.eventId, administrator.principalId,
      stream.streamSeq, record.occurredAt);
  }
}

export function createSqliteTenantAdministrationRepository(
  options: SqliteTenantAdministrationRepositoryOptions,
): TenantAdministrationRepository {
  const database = options.database;
  const nowMs = options.nowMs ?? Date.now;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const profileAssignmentFanoutLimit = options.profileAssignmentFanoutLimit ??
    DEFAULT_PROFILE_ASSIGNMENT_FANOUT_LIMIT;
  if (!Number.isSafeInteger(idempotencyTtlMs) || idempotencyTtlMs <= 0) {
    throw new TypeError("deployment idempotency TTL must be positive");
  }
  if (!Number.isSafeInteger(profileAssignmentFanoutLimit) ||
      profileAssignmentFanoutLimit <= 0 || profileAssignmentFanoutLimit > 256) {
    throw new TypeError("Profile Assignment fan-out limit must be between 1 and 256");
  }

  return Object.freeze({
    async transact<TResult>(operation: (transaction: TenantAdministrationTransaction) => TResult) {
      database.exec("BEGIN IMMEDIATE");
      let currentSession: AuthenticatedSessionContext | undefined;
      let appliedProfileFanout: AppliedProfileFanout | undefined;
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
          writeProfile(profile, credentialReadiness) {
            if (currentSession === undefined) {
              throw new Error("Profile write requires current session");
            }
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
              if (credentialReadiness !== "ready" && credentialReadiness !== "noauth") {
                throw new Error("Profile Assignment fan-out credential readiness is unavailable");
              }
              if (profile.actorId !== previous.actorId || profile.createdAt !== previous.createdAt ||
                  profile.revision !== previous.revision + 1) {
                throw new Error("Global Agent Profile identity or CAS is invalid");
              }
              const countRow = database.prepare(
                `SELECT COUNT(*) AS count FROM room_agent_assignments
                 WHERE profile_id = ? AND status = 'current'`,
              ).get(profile.profileId) as { readonly count?: unknown } | undefined;
              if (!nonNegativeInteger(countRow?.count)) {
                throw new Error("Profile Assignment fan-out count is corrupt");
              }
              if (countRow.count > profileAssignmentFanoutLimit) {
                throw new TenantAdministrationError(429, "profile_fanout_capacity_limited");
              }
              const rows = database.prepare(
                `SELECT assignment.id AS assignmentId, assignment.room_id AS roomId,
                        assignment.profile_id AS profileId,
                        assignment.agent_actor_id AS actorId, assignment.revision,
                        assignment.participation, assignment.paused,
                        assignment.room_responsibility AS roomResponsibility,
                        assignment.capability_subset_json AS capabilitySubsetJson,
                        assignment.tool_subset_json AS toolSubsetJson,
                        assignment.created_at AS createdAt,
                        room.status AS roomStatus,
                        room.governance_revision AS roomRevision,
                        membership.kind AS membershipKind,
                        membership.access_revision AS accessRevision,
                        membership.tool_permissions_json AS membershipToolsJson,
                        (SELECT COUNT(*) FROM agent_executions AS execution
                         WHERE execution.room_id = assignment.room_id
                           AND execution.agent_id = assignment.agent_actor_id
                           AND execution.status IN ('queued', 'running')) AS runningExecutionCount
                 FROM room_agent_assignments AS assignment
                 JOIN rooms AS room ON room.id = assignment.room_id
                 LEFT JOIN room_memberships AS membership
                   ON membership.room_id = assignment.room_id
                  AND membership.actor_id = assignment.agent_actor_id
                 WHERE assignment.profile_id = ? AND assignment.status = 'current'
                 ORDER BY assignment.room_id, assignment.id`,
              ).all(profile.profileId) as unknown as readonly Record<string, unknown>[];
              if (rows.length !== countRow.count) {
                throw new Error("Profile Assignment fan-out enumeration changed concurrently");
              }
              const targets: AssignmentFanoutTarget[] = [];
              let invalidatedContextCount = 0;
              for (const row of rows) {
                if (!nonEmpty(row.assignmentId) || !nonEmpty(row.roomId) ||
                    row.profileId !== profile.profileId || row.actorId !== profile.actorId ||
                    !positiveInteger(row.revision) ||
                    (row.participation !== "active" && row.participation !== "on-mention") ||
                    (row.paused !== 0 && row.paused !== 1) ||
                    !nonEmpty(row.roomResponsibility) || !nonEmpty(row.createdAt) ||
                    (row.roomStatus !== "active" && row.roomStatus !== "archived") ||
                    !nonNegativeInteger(row.roomRevision) ||
                    (row.membershipKind !== null && row.membershipKind !== "agent") ||
                    (row.accessRevision !== null && !nonNegativeInteger(row.accessRevision)) ||
                    (row.membershipKind === "agent" ? typeof row.membershipToolsJson !== "string"
                      : row.membershipToolsJson !== null) ||
                    !nonNegativeInteger(row.runningExecutionCount)) {
                  throw new Error("Profile Assignment fan-out authority is corrupt");
                }
                const capabilitySubset = intersect(
                  parseCanonicalSet(row.capabilitySubsetJson), profile.capabilityCeiling,
                );
                const toolSubset = intersect(
                  parseCanonicalSet(row.toolSubsetJson), profile.toolCeiling,
                );
                const revision = row.revision + 1;
                const updated = database.prepare(
                  `UPDATE room_agent_assignments
                   SET revision = ?, capability_subset_json = ?, tool_subset_json = ?,
                       updated_at = ?
                   WHERE id = ? AND profile_id = ? AND revision = ? AND status = 'current'`,
                ).run(revision, JSON.stringify(capabilitySubset), JSON.stringify(toolSubset),
                  profile.updatedAt, row.assignmentId, profile.profileId, row.revision);
                if (updated.changes !== 1) {
                  throw new Error("Profile Assignment fan-out CAS failed");
                }
                database.prepare(
                  `INSERT INTO room_agent_assignment_revisions (
                     assignment_id, revision, room_id, profile_id, agent_actor_id,
                     room_responsibility, status, participation, paused,
                     capability_subset_json, tool_subset_json, changed_by_human_actor_id,
                     changed_at, operation
                   ) VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?, 'update')`,
                ).run(row.assignmentId, revision, row.roomId, profile.profileId, profile.actorId,
                  row.roomResponsibility, row.participation, row.paused,
                  JSON.stringify(capabilitySubset), JSON.stringify(toolSubset),
                  currentSession.principal.actorId, profile.updatedAt);
                invalidatedContextCount += Number(database.prepare(
                  `UPDATE context_snapshots
                   SET state = 'invalidated', snapshot_generation = snapshot_generation + 1,
                       invalidated_at = ?, invalidation_reason = 'authorization_changed'
                   WHERE room_id = ? AND agent_id = ? AND state = 'active'`,
                ).run(profile.updatedAt, row.roomId, profile.actorId).changes);
                targets.push(Object.freeze({
                  assignmentId: row.assignmentId,
                  roomId: row.roomId,
                  profileId: profile.profileId,
                  actorId: profile.actorId,
                  revision,
                  participation: row.participation,
                  paused: row.paused === 1,
                  roomResponsibility: row.roomResponsibility,
                  capabilitySubset,
                  toolSubset,
                  membershipTools: row.membershipKind === "agent"
                    ? parseCanonicalSet(row.membershipToolsJson) : Object.freeze([]),
                  createdAt: row.createdAt,
                  roomStatus: row.roomStatus,
                  roomRevision: row.roomRevision,
                  accessRevision: row.accessRevision,
                  accessValid: row.membershipKind === "agent",
                  runningExecutionCount: row.runningExecutionCount,
                }));
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
              appliedProfileFanout = Object.freeze({
                profileId: profile.profileId,
                fromProfileRevision: previous.revision,
                toProfileRevision: profile.revision,
                credentialReadiness,
                targets: Object.freeze(targets),
                invalidatedContextCount,
              });
            }
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
          appendProfileMutation(record) {
            if (currentSession === undefined) {
              throw new Error("Profile event requires current session");
            }
            appendDeploymentProfileMutation(database, record, appliedProfileFanout);
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
