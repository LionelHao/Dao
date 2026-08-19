import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BallDeadlinePolicy } from "../ball-runtime/ball-authority-protocol.js";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import {
  isAuthorityTransactionView,
  type AuthorityParticipantEnvelope,
  type AuthorityParticipantFailureReason,
  type AuthorityTransactionView,
  type BusinessTimerSuspensionParticipant,
  type BusinessTimerSuspensionResult,
  type ParticipantRegistration,
} from "../room-governance/private-participant-contracts.js";

const FEATURE = "business-timer-suspension" as const;
const REGISTRATION_ID = "dao.business-timers.suspension.v1";
const DESCRIPTOR_VERSION = 1 as const;
const MAX_DESCRIPTOR_REGISTRATIONS = 16;
const MAX_TIMERS_PER_DESCRIPTOR = 4_096;

export const BALL_BOUNDARY_TIMER_DESCRIPTOR_ID =
  "dao.ball-runtime.business-boundaries.v1" as const;

export type BusinessTimerDescriptorId = typeof BALL_BOUNDARY_TIMER_DESCRIPTOR_ID;
export type BusinessTimerFeatureManifest = Readonly<Record<BusinessTimerDescriptorId, boolean>>;

export interface BusinessTimerDescriptorValue {
  readonly timerKey: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly dueAt: string;
}

export interface BusinessTimerDescriptorResult {
  readonly roomId: string;
  readonly descriptorId: BusinessTimerDescriptorId;
  readonly timers: readonly BusinessTimerDescriptorValue[];
}

export interface BusinessTimerDescriptor {
  listCurrentTimersInTransaction(
    transaction: AuthorityTransactionView,
    input: Readonly<{ roomId: string; archiveGeneration: number }>,
  ): BusinessTimerDescriptorResult;
}

export interface BusinessTimerDescriptorRegistration {
  readonly registrationId: string;
  readonly descriptorId: BusinessTimerDescriptorId;
  readonly version: 1;
  readonly enabled: boolean;
  readonly descriptor?: BusinessTimerDescriptor;
}

export type BusinessTimerClaimDecision =
  | Readonly<{ allowed: true; timerKey: string; dueAt: string }>
  | Readonly<{
      allowed: false;
      reason: "room_archived" | "not_due" | "already_claimed" | "timer_discarded";
    }>;

interface RoomRow {
  readonly status: unknown;
  readonly archiveGeneration: unknown;
  readonly archivedAt: unknown;
}

interface BallSourceRow {
  readonly sourceKind: unknown;
  readonly sourceId: unknown;
  readonly holderActorId: unknown;
  readonly holderKind: unknown;
  readonly sinceAt: unknown;
}

interface SuspensionRow {
  readonly descriptorId: unknown;
  readonly timerKey: unknown;
  readonly sourceKind: unknown;
  readonly sourceId: unknown;
  readonly originalDueAt: unknown;
  readonly remainingMs: unknown;
  readonly state: unknown;
  readonly resumedDueAt: unknown;
}

interface SuspensionBatchRow {
  readonly suspendedAt: unknown;
  readonly suspendedCount: unknown;
  readonly resumedAt: unknown;
  readonly resumedCount: unknown;
  readonly descriptorIdsJson: unknown;
}

interface LatestTimerStateRow {
  readonly state: unknown;
  readonly resumedDueAt: unknown;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTime(value: unknown): value is string {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isSuspendInput(value: unknown): value is Readonly<{
  roomId: string;
  archiveGeneration: number;
  archivedAt: string;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !exactKeys(value, ["roomId", "archiveGeneration", "archivedAt"])) return false;
  const input = value as Record<string, unknown>;
  return nonEmpty(input.roomId) && positiveInteger(input.archiveGeneration) &&
    validTime(input.archivedAt);
}

function isResumeInput(value: unknown): value is Readonly<{
  roomId: string;
  archiveGeneration: number;
  reopenedAt: string;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !exactKeys(value, ["roomId", "archiveGeneration", "reopenedAt"])) return false;
  const input = value as Record<string, unknown>;
  return nonEmpty(input.roomId) && positiveInteger(input.archiveGeneration) &&
    validTime(input.reopenedAt);
}

function fail(
  reason: AuthorityParticipantFailureReason,
): AuthorityParticipantEnvelope<BusinessTimerSuspensionResult> {
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

function isManifest(value: unknown): value is BusinessTimerFeatureManifest {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    exactKeys(value, [BALL_BOUNDARY_TIMER_DESCRIPTOR_ID]) &&
    typeof (value as Record<string, unknown>)[BALL_BOUNDARY_TIMER_DESCRIPTOR_ID] === "boolean";
}

function isDescriptorRegistration(value: unknown): value is BusinessTimerDescriptorRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !exactKeys(value, ["registrationId", "descriptorId", "version", "enabled", "descriptor"])) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!nonEmpty(candidate.registrationId) ||
      candidate.descriptorId !== BALL_BOUNDARY_TIMER_DESCRIPTOR_ID ||
      candidate.version !== DESCRIPTOR_VERSION || typeof candidate.enabled !== "boolean") {
    return false;
  }
  if (!candidate.enabled) return candidate.descriptor === undefined;
  return typeof candidate.descriptor === "object" && candidate.descriptor !== null &&
    !Array.isArray(candidate.descriptor) &&
    exactKeys(candidate.descriptor, ["listCurrentTimersInTransaction"]) &&
    typeof (candidate.descriptor as Record<string, unknown>).listCurrentTimersInTransaction ===
      "function";
}

function parseRegistrations(
  manifest: BusinessTimerFeatureManifest,
  registrations: readonly unknown[],
): ReadonlyMap<BusinessTimerDescriptorId, BusinessTimerDescriptorRegistration> |
  AuthorityParticipantFailureReason {
  if (!isManifest(manifest) || registrations.length > MAX_DESCRIPTOR_REGISTRATIONS) {
    return "invalid_manifest";
  }
  const ids = new Set<string>();
  const byDescriptor = new Map<BusinessTimerDescriptorId, BusinessTimerDescriptorRegistration>();
  for (const candidate of registrations) {
    if (typeof candidate === "object" && candidate !== null && "registrationId" in candidate &&
        typeof candidate.registrationId === "string") {
      if (ids.has(candidate.registrationId)) return "duplicate_registration_id";
      ids.add(candidate.registrationId);
    }
    if (typeof candidate === "object" && candidate !== null && "version" in candidate &&
        candidate.version !== DESCRIPTOR_VERSION) {
      return "version_mismatch";
    }
    if (!isDescriptorRegistration(candidate)) return "malformed_registration";
    if (byDescriptor.has(candidate.descriptorId)) return "duplicate_feature_registration";
    if (manifest[candidate.descriptorId] !== candidate.enabled) return "manifest_mismatch";
    byDescriptor.set(candidate.descriptorId, candidate);
  }
  if (manifest[BALL_BOUNDARY_TIMER_DESCRIPTOR_ID] &&
      !byDescriptor.has(BALL_BOUNDARY_TIMER_DESCRIPTOR_ID)) {
    return "missing_registration";
  }
  return byDescriptor;
}

function readRoom(database: DatabaseSync, roomId: string): RoomRow {
  const room = database.prepare(
    `SELECT status, archive_generation AS archiveGeneration, archived_at AS archivedAt
     FROM rooms WHERE id = ?`,
  ).get(roomId) as RoomRow | undefined;
  if (room === undefined || (room.status !== "active" && room.status !== "archived") ||
      !nonNegativeInteger(room.archiveGeneration) ||
      (room.status === "archived" && !validTime(room.archivedAt)) ||
      (room.status === "active" && room.archivedAt !== null)) {
    throw new Error("Business timer Room authority is unavailable");
  }
  return room;
}

function timerKey(input: Readonly<{
  sourceKind: "open-item" | "light-task";
  sourceId: string;
  holderActorId: string;
  holderKind: "human" | "agent";
  sinceAt: string;
}>): string {
  const boundaryKind = input.holderKind === "agent" ? "agent_trigger" : "human_reminder";
  const digest = createHash("sha256").update(JSON.stringify([
    input.sourceKind,
    input.sourceId,
    input.holderActorId,
    input.sinceAt,
    boundaryKind,
  ])).digest("hex");
  return `${BALL_BOUNDARY_TIMER_DESCRIPTOR_ID}:${digest}`;
}

function latestTimerState(
  database: DatabaseSync,
  roomId: string,
  descriptorId: BusinessTimerDescriptorId,
  key: string,
  beforeArchiveGeneration?: number,
): LatestTimerStateRow | undefined {
  const condition = beforeArchiveGeneration === undefined ? "" : "AND archive_generation < ?";
  const values = beforeArchiveGeneration === undefined
    ? [roomId, descriptorId, key]
    : [roomId, descriptorId, key, beforeArchiveGeneration];
  const row = database.prepare(
    `SELECT state, resumed_due_at AS resumedDueAt
     FROM room_business_timer_freezes
     WHERE room_id = ? AND descriptor_id = ? AND timer_key = ? ${condition}
     ORDER BY archive_generation DESC LIMIT 1`,
  ).get(...values) as LatestTimerStateRow | undefined;
  if (row !== undefined &&
      (row.state !== "frozen" && row.state !== "resumed" && row.state !== "discarded")) {
    throw new Error("Business timer state is corrupt");
  }
  if (row?.state === "resumed" && !validTime(row.resumedDueAt)) {
    throw new Error("Business timer resumed deadline is corrupt");
  }
  if (row !== undefined && row.state !== "resumed" && row.resumedDueAt !== null) {
    throw new Error("Business timer terminal state is corrupt");
  }
  return row;
}

function effectiveDueAt(
  database: DatabaseSync,
  roomId: string,
  descriptorId: BusinessTimerDescriptorId,
  key: string,
  defaultDueAt: string,
  beforeArchiveGeneration?: number,
): string {
  const latest = latestTimerState(
    database,
    roomId,
    descriptorId,
    key,
    beforeArchiveGeneration,
  );
  return latest?.state === "resumed" ? latest.resumedDueAt as string : defaultDueAt;
}

function ballSources(database: DatabaseSync, roomId: string): readonly BallSourceRow[] {
  return database.prepare(
    `SELECT 'open-item' AS sourceKind,
            item.id AS sourceId,
            item.current_owner_actor_id AS holderActorId,
            actor.kind AS holderKind,
            CASE item.status
              WHEN 'transferred' THEN json_extract(item.transfer_chain_json, '$[#-1].transferredAt')
              ELSE item.created_at
            END AS sinceAt
     FROM open_items AS item
     JOIN room_memberships AS membership
       ON membership.room_id = item.room_id
      AND membership.actor_id = item.current_owner_actor_id
     JOIN actors AS actor ON actor.id = membership.actor_id
     WHERE item.room_id = ? AND item.status IN ('awaiting', 'transferred')
     UNION ALL
     SELECT 'light-task' AS sourceKind,
            task.id AS sourceId,
            CASE task.status
              WHEN 'claimed' THEN task.claimant_actor_id
              ELSE task.verifier_actor_id
            END AS holderActorId,
            actor.kind AS holderKind,
            CASE task.status
              WHEN 'claimed' THEN task.claimed_at
              ELSE task.delivered_at
            END AS sinceAt
     FROM light_tasks AS task
     JOIN room_memberships AS membership
       ON membership.room_id = task.room_id
      AND membership.actor_id = CASE task.status
        WHEN 'claimed' THEN task.claimant_actor_id ELSE task.verifier_actor_id END
     JOIN actors AS actor ON actor.id = membership.actor_id
     WHERE task.room_id = ? AND task.status IN ('claimed', 'delivered')
     ORDER BY sourceKind, sourceId`,
  ).all(roomId, roomId) as unknown as readonly BallSourceRow[];
}

function isAlreadyClaimed(
  database: DatabaseSync,
  input: Readonly<{
    roomId: string;
    sourceKind: "open-item" | "light-task";
    sourceId: string;
    holderActorId: string;
    holderKind: "human" | "agent";
    sinceAt: string;
  }>,
): boolean {
  const boundaryKind = input.holderKind === "agent" ? "agent_trigger" : "human_reminder";
  return database.prepare(
    `SELECT 1 AS present
     FROM ball_boundary_claims
     WHERE room_id = ? AND source_kind = ? AND source_id = ?
       AND holder_actor_id = ? AND since_at = ? AND boundary_kind = ?
     LIMIT 1`,
  ).get(
    input.roomId,
    input.sourceKind,
    input.sourceId,
    input.holderActorId,
    input.sinceAt,
    boundaryKind,
  )?.present === 1;
}

function listBallTimers(
  database: DatabaseSync,
  input: Readonly<{ roomId: string; archiveGeneration: number }>,
  policy: BallDeadlinePolicy,
): BusinessTimerDescriptorResult {
  const rows = ballSources(database, input.roomId);
  if (rows.length > MAX_TIMERS_PER_DESCRIPTOR) {
    throw new Error("Ball business timers exceeded their bound");
  }
  const timers: BusinessTimerDescriptorValue[] = [];
  for (const row of rows) {
    if ((row.sourceKind !== "open-item" && row.sourceKind !== "light-task") ||
        !nonEmpty(row.sourceId) || !nonEmpty(row.holderActorId) ||
        (row.holderKind !== "human" && row.holderKind !== "agent") || !validTime(row.sinceAt)) {
      throw new Error("Ball business timer source is corrupt");
    }
    const source = {
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      holderActorId: row.holderActorId,
      holderKind: row.holderKind,
      sinceAt: row.sinceAt,
      roomId: input.roomId,
    } as const;
    if (isAlreadyClaimed(database, source)) continue;
    const delay = row.sourceKind === "open-item"
      ? policy.openItemDeadlineMs
      : policy.lightTaskDeadlineMs;
    const defaultDueAt = new Date(Date.parse(row.sinceAt) + delay).toISOString();
    const key = timerKey(source);
    timers.push(Object.freeze({
      timerKey: key,
      sourceKind: row.sourceKind,
      sourceId: row.sourceId,
      dueAt: effectiveDueAt(
        database,
        input.roomId,
        BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
        key,
        defaultDueAt,
        input.archiveGeneration,
      ),
    }));
  }
  timers.sort((left, right) => left.timerKey.localeCompare(right.timerKey));
  return Object.freeze({
    roomId: input.roomId,
    descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
    timers: Object.freeze(timers),
  });
}

function isDescriptorResult(
  value: unknown,
  descriptorId: BusinessTimerDescriptorId,
): value is BusinessTimerDescriptorResult {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !exactKeys(value, ["roomId", "descriptorId", "timers"])) return false;
  const result = value as Record<string, unknown>;
  if (!nonEmpty(result.roomId) || result.descriptorId !== descriptorId ||
      !Array.isArray(result.timers) || result.timers.length > MAX_TIMERS_PER_DESCRIPTOR) {
    return false;
  }
  const keys = new Set<string>();
  for (const candidate of result.timers) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) ||
        !exactKeys(candidate, ["timerKey", "sourceKind", "sourceId", "dueAt"])) return false;
    const timer = candidate as Record<string, unknown>;
    if (!nonEmpty(timer.timerKey) || !timer.timerKey.startsWith(`${descriptorId}:`) ||
        !nonEmpty(timer.sourceKind) || !nonEmpty(timer.sourceId) ||
        !validTime(timer.dueAt) || keys.has(timer.timerKey)) {
      return false;
    }
    keys.add(timer.timerKey);
  }
  return true;
}

function readBatch(
  database: DatabaseSync,
  roomId: string,
  archiveGeneration: number,
): Readonly<{
  suspendedAt: string;
  suspendedCount: number;
  resumedAt: string | null;
  resumedCount: number | null;
  descriptorIds: readonly string[];
}> | undefined {
  const row = database.prepare(
    `SELECT suspended_at AS suspendedAt, suspended_count AS suspendedCount,
            resumed_at AS resumedAt, resumed_count AS resumedCount,
            descriptor_ids_json AS descriptorIdsJson
     FROM room_business_timer_freeze_batches
     WHERE room_id = ? AND archive_generation = ?`,
  ).get(roomId, archiveGeneration) as SuspensionBatchRow | undefined;
  if (row === undefined) return undefined;
  if (!validTime(row.suspendedAt) || !nonNegativeInteger(row.suspendedCount) ||
      !nonEmpty(row.descriptorIdsJson) ||
      !((row.resumedAt === null && row.resumedCount === null) ||
        (validTime(row.resumedAt) && nonNegativeInteger(row.resumedCount)))) {
    throw new Error("Business timer suspension batch is corrupt");
  }
  const descriptorIds: unknown = JSON.parse(row.descriptorIdsJson);
  if (!Array.isArray(descriptorIds) || !descriptorIds.every(nonEmpty) ||
      new Set(descriptorIds).size !== descriptorIds.length ||
      descriptorIds.some((id) => id !== BALL_BOUNDARY_TIMER_DESCRIPTOR_ID) ||
      descriptorIds.some((id, index) => index > 0 && descriptorIds[index - 1]! >= id)) {
    throw new Error("Business timer suspension descriptor set is corrupt");
  }
  const timerCounts = database.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN state = 'frozen' THEN 1 ELSE 0 END), 0) AS frozen,
            COALESCE(SUM(CASE WHEN state = 'resumed' THEN 1 ELSE 0 END), 0) AS resumed
     FROM room_business_timer_freezes
     WHERE room_id = ? AND archive_generation = ?`,
  ).get(roomId, archiveGeneration);
  if (!nonNegativeInteger(timerCounts?.total) || !nonNegativeInteger(timerCounts?.frozen) ||
      !nonNegativeInteger(timerCounts?.resumed) || timerCounts.total !== row.suspendedCount ||
      (row.resumedAt === null && timerCounts.frozen !== timerCounts.total) ||
      (row.resumedAt !== null &&
        (timerCounts.frozen !== 0 || timerCounts.resumed !== row.resumedCount))) {
    throw new Error("Business timer suspension batch does not match its timers");
  }
  return Object.freeze({
    suspendedAt: row.suspendedAt,
    suspendedCount: row.suspendedCount,
    resumedAt: row.resumedAt,
    resumedCount: row.resumedCount,
    descriptorIds: Object.freeze(descriptorIds),
  });
}

function invokeDescriptors(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; archiveGeneration: number }>,
  registrations: ReadonlyMap<BusinessTimerDescriptorId, BusinessTimerDescriptorRegistration>,
): BusinessTimerDescriptorResult[] | AuthorityParticipantFailureReason {
  const results: BusinessTimerDescriptorResult[] = [];
  for (const [descriptorId, registration] of registrations) {
    if (!registration.enabled || registration.descriptor === undefined) continue;
    let candidate: unknown;
    try {
      candidate = registration.descriptor.listCurrentTimersInTransaction(transaction, input);
    } catch {
      return "participant_threw";
    }
    if (!isDescriptorResult(candidate, descriptorId)) {
      if (typeof candidate === "object" && candidate !== null && "roomId" in candidate &&
          typeof candidate.roomId === "string" && candidate.roomId !== input.roomId) {
        return "cross_room_result";
      }
      return "malformed_result";
    }
    if (candidate.roomId !== input.roomId) return "cross_room_result";
    results.push(candidate);
  }
  return results.sort((left, right) => left.descriptorId.localeCompare(right.descriptorId));
}

function result(
  roomId: string,
  archiveGeneration: number,
  action: "suspended" | "resumed",
  affectedCount: number,
  descriptorIds: readonly string[],
): BusinessTimerSuspensionResult {
  return Object.freeze({
    roomId,
    archiveGeneration,
    action,
    affectedCount,
    timerDescriptorIds: Object.freeze([...descriptorIds]),
  });
}

export function createBusinessTimerSuspensionParticipant(options: Readonly<{
  manifest: BusinessTimerFeatureManifest;
  registrations: readonly unknown[];
}>): BusinessTimerSuspensionParticipant {
  return Object.freeze({
    suspendForArchive(
      transaction: AuthorityTransactionView,
      input: Readonly<{ roomId: string; archiveGeneration: number; archivedAt: string }>,
    ) {
      if (!isSuspendInput(input) || !isAuthorityTransactionView(transaction) ||
          input.roomId !== transaction.roomId) {
        return fail("transaction_mismatch");
      }
      try {
        const parsed = parseRegistrations(options.manifest, options.registrations);
        if (typeof parsed === "string") return fail(parsed);
        const descriptorIds = [...parsed.values()]
          .filter((registration) => registration.enabled)
          .map((registration) => registration.descriptorId)
          .sort();
        return useAuthorityTransactionDatabase(transaction, (database) => {
          const room = readRoom(database, input.roomId);
          if (room.status !== "archived" || room.archiveGeneration !== input.archiveGeneration ||
              room.archivedAt !== input.archivedAt) return fail("transaction_mismatch");
          const batch = readBatch(database, input.roomId, input.archiveGeneration);
          if (batch !== undefined) {
            if (batch.suspendedAt !== input.archivedAt || batch.resumedAt !== null) {
              return fail("transaction_mismatch");
            }
            return Object.freeze({
              ok: true as const,
              result: result(
                input.roomId,
                input.archiveGeneration,
                "suspended",
                batch.suspendedCount,
                batch.descriptorIds,
              ),
            });
          }
          const descriptorResults = invokeDescriptors(transaction, input, parsed);
          if (typeof descriptorResults === "string") return fail(descriptorResults);
          const archivedAt = Date.parse(input.archivedAt);
          for (const descriptorResult of descriptorResults) {
            for (const timer of descriptorResult.timers) {
              const remainingMs = Date.parse(timer.dueAt) - archivedAt;
              if (remainingMs <= 0) continue;
              database.prepare(
                `INSERT INTO room_business_timer_freezes (
                   room_id, archive_generation, descriptor_id, timer_key,
                   source_kind, source_id, original_due_at, remaining_ms, frozen_at, state,
                   resumed_due_at, resolved_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'frozen', NULL, NULL)`,
              ).run(
                input.roomId,
                input.archiveGeneration,
                descriptorResult.descriptorId,
                timer.timerKey,
                timer.sourceKind,
                timer.sourceId,
                timer.dueAt,
                remainingMs,
                input.archivedAt,
              );
            }
          }
          const affectedCount = database.prepare(
            `SELECT COUNT(*) AS count
             FROM room_business_timer_freezes
             WHERE room_id = ? AND archive_generation = ? AND state = 'frozen'`,
          ).get(input.roomId, input.archiveGeneration)?.count;
          if (!nonNegativeInteger(affectedCount)) throw new Error("Timer count is corrupt");
          database.prepare(
            `INSERT INTO room_business_timer_freeze_batches (
               room_id, archive_generation, suspended_at, suspended_count,
               resumed_at, resumed_count, descriptor_ids_json
             ) VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
          ).run(
            input.roomId,
            input.archiveGeneration,
            input.archivedAt,
            affectedCount,
            JSON.stringify(descriptorIds),
          );
          return Object.freeze({
            ok: true as const,
            result: result(
              input.roomId,
              input.archiveGeneration,
              "suspended",
              affectedCount,
              descriptorIds,
            ),
          });
        });
      } catch {
        return fail("participant_threw");
      }
    },

    resumeAfterReopen(
      transaction: AuthorityTransactionView,
      input: Readonly<{ roomId: string; archiveGeneration: number; reopenedAt: string }>,
    ) {
      if (!isResumeInput(input) || !isAuthorityTransactionView(transaction) ||
          input.roomId !== transaction.roomId) {
        return fail("transaction_mismatch");
      }
      try {
        const parsed = parseRegistrations(options.manifest, options.registrations);
        if (typeof parsed === "string") return fail(parsed);
        const descriptorIds = [...parsed.values()]
          .filter((registration) => registration.enabled)
          .map((registration) => registration.descriptorId)
          .sort();
        return useAuthorityTransactionDatabase(transaction, (database) => {
          const room = readRoom(database, input.roomId);
          if (room.status !== "active" || room.archiveGeneration !== input.archiveGeneration) {
            return fail("transaction_mismatch");
          }
          const batch = readBatch(database, input.roomId, input.archiveGeneration);
          if (batch === undefined) throw new Error("Business timer suspension batch is unavailable");
          if (JSON.stringify(batch.descriptorIds) !== JSON.stringify(descriptorIds)) {
            return fail("manifest_mismatch");
          }
          if (batch.resumedAt !== null && batch.resumedCount !== null) {
            return Object.freeze({
              ok: true as const,
              result: result(
                input.roomId,
                input.archiveGeneration,
                "resumed",
                batch.resumedCount,
                batch.descriptorIds,
              ),
            });
          }
          const descriptorResults = invokeDescriptors(transaction, input, parsed);
          if (typeof descriptorResults === "string") return fail(descriptorResults);
          const current = new Map<string, Set<string>>();
          for (const descriptorResult of descriptorResults) {
            current.set(
              descriptorResult.descriptorId,
              new Set(descriptorResult.timers.map((timer) => timer.timerKey)),
            );
          }
          const rows = database.prepare(
            `SELECT descriptor_id AS descriptorId, timer_key AS timerKey,
                    source_kind AS sourceKind, source_id AS sourceId,
                    original_due_at AS originalDueAt, remaining_ms AS remainingMs,
                    state, resumed_due_at AS resumedDueAt
             FROM room_business_timer_freezes
             WHERE room_id = ? AND archive_generation = ? AND state = 'frozen'
             ORDER BY descriptor_id, timer_key`,
          ).all(input.roomId, input.archiveGeneration) as unknown as readonly SuspensionRow[];
          if (rows.length > MAX_DESCRIPTOR_REGISTRATIONS * MAX_TIMERS_PER_DESCRIPTOR) {
            throw new Error("Business timer resume exceeded its bound");
          }
          for (const row of rows) {
            if (row.descriptorId !== BALL_BOUNDARY_TIMER_DESCRIPTOR_ID ||
                !nonEmpty(row.timerKey) || !nonEmpty(row.sourceKind) || !nonEmpty(row.sourceId) ||
                !validTime(row.originalDueAt) ||
                !nonNegativeInteger(row.remainingMs) || row.state !== "frozen" ||
                row.resumedDueAt !== null) {
              throw new Error("Business timer suspension row is corrupt");
            }
            const remainsCurrent = current.get(row.descriptorId)?.has(row.timerKey) === true;
            if (!remainsCurrent) {
              database.prepare(
                `UPDATE room_business_timer_freezes
                 SET state = 'discarded', resolved_at = ?
                 WHERE room_id = ? AND archive_generation = ?
                   AND descriptor_id = ? AND timer_key = ? AND state = 'frozen'`,
              ).run(
                input.reopenedAt,
                input.roomId,
                input.archiveGeneration,
                row.descriptorId,
                row.timerKey,
              );
              continue;
            }
            const resumedDueAt = new Date(Date.parse(input.reopenedAt) + row.remainingMs).toISOString();
            database.prepare(
              `UPDATE room_business_timer_freezes
               SET state = 'resumed', resumed_due_at = ?, resolved_at = ?
               WHERE room_id = ? AND archive_generation = ?
                 AND descriptor_id = ? AND timer_key = ? AND state = 'frozen'`,
            ).run(
              resumedDueAt,
              input.reopenedAt,
              input.roomId,
              input.archiveGeneration,
              row.descriptorId,
              row.timerKey,
            );
          }
          const affectedCount = database.prepare(
            `SELECT COUNT(*) AS count
             FROM room_business_timer_freezes
             WHERE room_id = ? AND archive_generation = ? AND state = 'resumed'`,
          ).get(input.roomId, input.archiveGeneration)?.count;
          if (!nonNegativeInteger(affectedCount)) throw new Error("Timer count is corrupt");
          const updated = database.prepare(
            `UPDATE room_business_timer_freeze_batches
             SET resumed_at = ?, resumed_count = ?
             WHERE room_id = ? AND archive_generation = ?
               AND resumed_at IS NULL AND resumed_count IS NULL`,
          ).run(input.reopenedAt, affectedCount, input.roomId, input.archiveGeneration);
          if (updated.changes !== 1) throw new Error("Business timer resume lost linearization");
          return Object.freeze({
            ok: true as const,
            result: result(
              input.roomId,
              input.archiveGeneration,
              "resumed",
              affectedCount,
              descriptorIds,
            ),
          });
        });
      } catch {
        return fail("participant_threw");
      }
    },
  });
}

function validatePolicy(policy: BallDeadlinePolicy): void {
  if (!nonNegativeInteger(policy.openItemDeadlineMs) ||
      !nonNegativeInteger(policy.lightTaskDeadlineMs)) {
    throw new TypeError("Ball business timer policy is invalid");
  }
}

export function createBallBoundaryBusinessTimerDescriptorRegistration(
  policy: BallDeadlinePolicy,
): BusinessTimerDescriptorRegistration {
  validatePolicy(policy);
  const descriptor = Object.freeze({
    listCurrentTimersInTransaction(
      transaction: AuthorityTransactionView,
      input: Readonly<{ roomId: string; archiveGeneration: number }>,
    ): BusinessTimerDescriptorResult {
      if (!isAuthorityTransactionView(transaction) || !nonEmpty(input.roomId) ||
          input.roomId !== transaction.roomId ||
          !positiveInteger(input.archiveGeneration)) {
        throw new TypeError("Ball business timer descriptor input is invalid");
      }
      return useAuthorityTransactionDatabase(
        transaction,
        (database) => listBallTimers(database, input, policy),
      );
    },
  });
  return Object.freeze({
    registrationId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
    descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
    version: DESCRIPTOR_VERSION,
    enabled: true,
    descriptor,
  });
}

export function createBusinessTimerSuspensionParticipantRegistration(options: Readonly<{
  manifest: BusinessTimerFeatureManifest;
  registrations: readonly unknown[];
}>): ParticipantRegistration<BusinessTimerSuspensionParticipant> {
  return Object.freeze({
    registrationId: REGISTRATION_ID,
    feature: FEATURE,
    version: 1,
    enabled: true,
    participant: createBusinessTimerSuspensionParticipant(options),
  });
}

const DEFAULT_BALL_DEADLINE_POLICY = Object.freeze({
  openItemDeadlineMs: 24 * 60 * 60 * 1_000,
  lightTaskDeadlineMs: 24 * 60 * 60 * 1_000,
});

export const businessTimerFeatureManifest: BusinessTimerFeatureManifest =
  Object.freeze({ [BALL_BOUNDARY_TIMER_DESCRIPTOR_ID]: true });

export const businessTimerDescriptorRegistrations:
  readonly BusinessTimerDescriptorRegistration[] = Object.freeze([
    createBallBoundaryBusinessTimerDescriptorRegistration(DEFAULT_BALL_DEADLINE_POLICY),
  ]);

export function createBusinessTimerSuspensionProductionRegistration(
  policy: BallDeadlinePolicy,
): ParticipantRegistration<BusinessTimerSuspensionParticipant> {
  return createBusinessTimerSuspensionParticipantRegistration({
    manifest: businessTimerFeatureManifest,
    registrations: [createBallBoundaryBusinessTimerDescriptorRegistration(policy)],
  });
}

export const businessTimerSuspensionParticipantRegistration =
  createBusinessTimerSuspensionParticipantRegistration({
    manifest: businessTimerFeatureManifest,
    registrations: businessTimerDescriptorRegistrations,
  });

export function isBusinessTimerClaimAllowedInTransaction(
  transaction: AuthorityTransactionView,
  input: Readonly<{
    roomId: string;
    descriptorId: BusinessTimerDescriptorId;
    sourceKind: "open-item" | "light-task";
    sourceId: string;
    holderActorId: string;
    holderKind: "human" | "agent";
    sinceAt: string;
    defaultDueAt: string;
    now: number;
  }>,
): BusinessTimerClaimDecision {
  if (!isAuthorityTransactionView(transaction) || !nonEmpty(input.roomId) ||
      input.roomId !== transaction.roomId ||
      input.descriptorId !== BALL_BOUNDARY_TIMER_DESCRIPTOR_ID ||
      (input.sourceKind !== "open-item" && input.sourceKind !== "light-task") ||
      !nonEmpty(input.sourceId) || !nonEmpty(input.holderActorId) ||
      (input.holderKind !== "human" && input.holderKind !== "agent") ||
      !validTime(input.sinceAt) || !validTime(input.defaultDueAt) ||
      !Number.isSafeInteger(input.now) || input.now < 0) {
    throw new TypeError("Business timer claim gate input is invalid");
  }
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const room = readRoom(database, input.roomId);
    if (room.status !== "active") {
      return Object.freeze({ allowed: false as const, reason: "room_archived" as const });
    }
    const key = timerKey(input);
    const latest = latestTimerState(database, input.roomId, input.descriptorId, key);
    if (latest?.state === "frozen") {
      return Object.freeze({ allowed: false as const, reason: "room_archived" as const });
    }
    if (latest?.state === "discarded") {
      return Object.freeze({ allowed: false as const, reason: "timer_discarded" as const });
    }
    if (isAlreadyClaimed(database, input)) {
      return Object.freeze({ allowed: false as const, reason: "already_claimed" as const });
    }
    const dueAt = latest?.state === "resumed"
      ? latest.resumedDueAt as string
      : input.defaultDueAt;
    if (input.now < Date.parse(dueAt)) {
      return Object.freeze({ allowed: false as const, reason: "not_due" as const });
    }
    return Object.freeze({ allowed: true as const, timerKey: key, dueAt });
  });
}
