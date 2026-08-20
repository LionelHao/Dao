import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isRoomMemoryProjection,
  isRoomMemoryStatus,
  type RoomMemoryHealthReason,
  type RoomMemoryKind,
  type RoomMemorySourceAvailability,
  type RoomMemorySourceEligibility,
  type RoomMemorySourceKind,
  type RoomMemoryStatus,
  type RoomMemoryVersionProjection,
  type RoomMemoryVersionSourceRef,
  type RoomMemoryVersionState,
} from "@native-im/core";
import {
  MEMORY_STEWARD_MAX_CANDIDATES,
  MEMORY_STEWARD_MAX_DEDUPE_KEY_BYTES,
  MEMORY_STEWARD_MAX_DERIVED_TEXT_BYTES,
  MEMORY_STEWARD_MAX_SOURCE_REFS,
  MEMORY_STEWARD_SCHEMA_VERSION,
  type MemoryStewardCandidate,
  type MemoryStewardPlan,
} from "./contracts.js";

export type RoomMemoryDatabaseAuthorityErrorCode =
  | "invalid_input"
  | "room_not_found"
  | "record_not_found"
  | "job_not_found"
  | "attempt_not_found"
  | "room_archived"
  | "noauth"
  | "forbidden"
  | "idempotency_conflict"
  | "version_conflict"
  | "generation_conflict"
  | "source_stale"
  | "invalid_plan"
  | "storage_invariant";

export class RoomMemoryDatabaseAuthorityError extends Error {
  public constructor(public readonly code: RoomMemoryDatabaseAuthorityErrorCode) {
    super(code);
    this.name = "RoomMemoryDatabaseAuthorityError";
  }
}

export interface FrozenRoomMemoryJobSource {
  readonly corpusSeq: number;
  readonly sourceKind: RoomMemorySourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly eligibility: RoomMemorySourceEligibility;
  readonly availability: RoomMemorySourceAvailability;
}

export type RoomMemoryJobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled";

export interface RoomMemoryJob {
  readonly jobId: string;
  readonly roomId: string;
  readonly recoveryGeneration: number;
  readonly lifecycleGeneration: number;
  readonly fromWatermarkExclusive: number;
  readonly toCorpusSeqInclusive: number;
  readonly sourceCount: number;
  readonly frozenSources: readonly FrozenRoomMemoryJobSource[];
  readonly status: RoomMemoryJobStatus;
  readonly currentAttempt: number;
  readonly availableAt: string;
  readonly claimedAt: string | null;
  readonly completedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly resultSha256: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RoomMemoryAttemptStatus =
  | "running"
  | "succeeded"
  | "retryable_failed"
  | "terminal_failed"
  | "cancelled";

export interface RoomMemoryAttempt {
  readonly attemptId: string;
  readonly jobId: string;
  readonly roomId: string;
  readonly recoveryGeneration: number;
  readonly attemptNumber: number;
  readonly status: RoomMemoryAttemptStatus;
  readonly inputSha256: string;
  readonly outputSha256: string | null;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly availableAt: string;
}

export interface RoomMemoryQueryResult {
  readonly items: readonly RoomMemoryVersionProjection[];
  readonly nextCursor: string | null;
}

type UnknownRecord = Record<PropertyKey, unknown>;
type SqlRow = Record<string, unknown>;

const MAX_RECEIPT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const KINDS = new Set<RoomMemoryKind>([
  "goal", "decision", "context", "next_action", "open_question_or_blocker",
]);
const STATES = new Set<RoomMemoryVersionState>([
  "proposal", "active", "disputed", "review_required", "resolved", "superseded", "invalidated",
]);
const JOB_STATUSES = new Set<RoomMemoryJobStatus>([
  "queued", "running", "retry_wait", "completed", "failed", "cancelled",
]);
const ATTEMPT_STATUSES = new Set<RoomMemoryAttemptStatus>([
  "running", "succeeded", "retryable_failed", "terminal_failed", "cancelled",
]);
const SOURCE_KINDS = new Set<RoomMemorySourceKind>([
  "message", "message_revision", "message_tombstone", "attachment_extraction", "project_fact_checkpoint",
]);
const SOURCE_ELIGIBILITIES = new Set<RoomMemorySourceEligibility>([
  "eligible", "excluded_recalled", "excluded_revised", "excluded_revoked",
  "excluded_unbound", "excluded_unsafe", "unavailable",
]);
const SOURCE_AVAILABILITIES = new Set<RoomMemorySourceAvailability>([
  "readable", "tombstone", "metadata_only", "temporarily_unavailable",
]);
const FAILURE_CODES = new Set([
  "provider_timeout", "provider_rate_limited", "provider_unavailable",
  "invalid_provider_output", "provider_output_oversized", "attempt_dead_lettered",
  "authority_unavailable", "shutdown", "source_stale",
]);

let savepointOrdinal = 0;

function authorityError(code: RoomMemoryDatabaseAuthorityErrorCode): never {
  throw new RoomMemoryDatabaseAuthorityError(code);
}

function atomic<Result>(database: DatabaseSync, operation: () => Result): Result {
  savepointOrdinal += 1;
  const name = `room_memory_authority_${savepointOrdinal}`;
  database.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    database.exec(`RELEASE ${name}`);
    return result;
  } catch (error: unknown) {
    try {
      database.exec(`ROLLBACK TO ${name}`);
      database.exec(`RELEASE ${name}`);
    } catch {
      // Preserve the authority error that caused the rollback.
    }
    if (error instanceof RoomMemoryDatabaseAuthorityError) throw error;
    throw new RoomMemoryDatabaseAuthorityError("storage_invariant");
  }
}

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length &&
    own.every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}

function allowed(value: UnknownRecord, required: readonly string[], optional: readonly string[]): boolean {
  const keys = [...required, ...optional];
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}

function identifier(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Value(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 64) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function generatedId(prefix: string, ...parts: readonly unknown[]): string {
  return `${prefix}:${sha256(parts)}`;
}

function sqlRow(value: unknown): SqlRow | undefined {
  return record(value) ? value as SqlRow : undefined;
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") authorityError("storage_invariant");
  return value;
}

function nullableString(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") authorityError("storage_invariant");
  return value;
}

function requiredInteger(row: SqlRow, key: string, allowZero = false): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    authorityError("storage_invariant");
  }
  return value;
}

function parseFrozenSources(value: unknown): readonly FrozenRoomMemoryJobSource[] {
  if (typeof value !== "string") authorityError("storage_invariant");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    authorityError("storage_invariant");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32) authorityError("storage_invariant");
  const sources: FrozenRoomMemoryJobSource[] = [];
  for (const item of parsed) {
    if (!record(item) || !exact(item, [
      "corpusSeq", "sourceKind", "sourceId", "sourceRevision", "eligibility", "availability",
    ]) || !positiveInteger(item.corpusSeq) || !SOURCE_KINDS.has(item.sourceKind as RoomMemorySourceKind) ||
        !identifier(item.sourceId) || !positiveInteger(item.sourceRevision) ||
        !SOURCE_ELIGIBILITIES.has(item.eligibility as RoomMemorySourceEligibility) ||
        !SOURCE_AVAILABILITIES.has(item.availability as RoomMemorySourceAvailability)) {
      authorityError("storage_invariant");
    }
    sources.push(Object.freeze({
      corpusSeq: item.corpusSeq,
      sourceKind: item.sourceKind as RoomMemorySourceKind,
      sourceId: item.sourceId,
      sourceRevision: item.sourceRevision,
      eligibility: item.eligibility as RoomMemorySourceEligibility,
      availability: item.availability as RoomMemorySourceAvailability,
    }));
  }
  return Object.freeze(sources);
}

const JOB_SELECT = `
  SELECT job_id AS jobId, room_id AS roomId, recovery_generation AS recoveryGeneration,
         lifecycle_generation AS lifecycleGeneration,
         from_watermark_exclusive AS fromWatermarkExclusive,
         to_corpus_seq_inclusive AS toCorpusSeqInclusive, source_count AS sourceCount,
         frozen_sources_json AS frozenSourcesJson, status, current_attempt AS currentAttempt,
         available_at AS availableAt, claimed_at AS claimedAt, completed_at AS completedAt,
         last_error_code AS lastErrorCode, result_sha256 AS resultSha256,
         created_at AS createdAt, updated_at AS updatedAt
  FROM room_memory_jobs`;

function jobFromRow(value: unknown): RoomMemoryJob {
  const row = sqlRow(value);
  if (row === undefined) authorityError("storage_invariant");
  const status = requiredString(row, "status") as RoomMemoryJobStatus;
  const frozenSources = parseFrozenSources(row.frozenSourcesJson);
  const sourceCount = requiredInteger(row, "sourceCount");
  if (!JOB_STATUSES.has(status) || frozenSources.length !== sourceCount) authorityError("storage_invariant");
  return Object.freeze({
    jobId: requiredString(row, "jobId"),
    roomId: requiredString(row, "roomId"),
    recoveryGeneration: requiredInteger(row, "recoveryGeneration"),
    lifecycleGeneration: requiredInteger(row, "lifecycleGeneration", true),
    fromWatermarkExclusive: requiredInteger(row, "fromWatermarkExclusive", true),
    toCorpusSeqInclusive: requiredInteger(row, "toCorpusSeqInclusive"),
    sourceCount,
    frozenSources,
    status,
    currentAttempt: requiredInteger(row, "currentAttempt", true),
    availableAt: requiredString(row, "availableAt"),
    claimedAt: nullableString(row, "claimedAt"),
    completedAt: nullableString(row, "completedAt"),
    lastErrorCode: nullableString(row, "lastErrorCode"),
    resultSha256: nullableString(row, "resultSha256"),
    createdAt: requiredString(row, "createdAt"),
    updatedAt: requiredString(row, "updatedAt"),
  });
}

export function readRoomMemoryJob(database: DatabaseSync, jobId: string): RoomMemoryJob | undefined {
  if (!identifier(jobId)) authorityError("invalid_input");
  const row = database.prepare(`${JOB_SELECT} WHERE job_id = ?`).get(jobId);
  return row === undefined ? undefined : jobFromRow(row);
}

const ATTEMPT_SELECT = `
  SELECT attempt_id AS attemptId, job_id AS jobId, room_id AS roomId,
         recovery_generation AS recoveryGeneration, attempt_number AS attemptNumber,
         status, input_sha256 AS inputSha256, output_sha256 AS outputSha256,
         error_code AS errorCode, started_at AS startedAt, finished_at AS finishedAt,
         available_at AS availableAt
  FROM room_memory_attempts`;

function attemptFromRow(value: unknown): RoomMemoryAttempt {
  const row = sqlRow(value);
  if (row === undefined) authorityError("storage_invariant");
  const status = requiredString(row, "status") as RoomMemoryAttemptStatus;
  if (!ATTEMPT_STATUSES.has(status)) authorityError("storage_invariant");
  return Object.freeze({
    attemptId: requiredString(row, "attemptId"),
    jobId: requiredString(row, "jobId"),
    roomId: requiredString(row, "roomId"),
    recoveryGeneration: requiredInteger(row, "recoveryGeneration"),
    attemptNumber: requiredInteger(row, "attemptNumber"),
    status,
    inputSha256: requiredString(row, "inputSha256"),
    outputSha256: nullableString(row, "outputSha256"),
    errorCode: nullableString(row, "errorCode"),
    startedAt: requiredString(row, "startedAt"),
    finishedAt: nullableString(row, "finishedAt"),
    availableAt: requiredString(row, "availableAt"),
  });
}

export function readRoomMemoryAttempt(database: DatabaseSync, attemptId: string): RoomMemoryAttempt | undefined {
  if (!identifier(attemptId)) authorityError("invalid_input");
  const row = database.prepare(`${ATTEMPT_SELECT} WHERE attempt_id = ?`).get(attemptId);
  return row === undefined ? undefined : attemptFromRow(row);
}

function healthReason(health: string, storedReason: string | null): RoomMemoryHealthReason {
  if (health === "healthy") return "none";
  if (health === "catching_up") return "backlog";
  const expected = health === "noauth"
    ? new Set(["provider_secret_missing"])
    : health === "degraded"
      ? new Set([
        "provider_timeout_exhausted", "provider_rate_limited_exhausted",
        "provider_dependency_unavailable", "invalid_provider_output",
        "provider_output_oversized", "attempt_dead_lettered",
      ])
      : new Set(["storage_invariant_broken", "checkpoint_discontinuity", "source_invariant_broken"]);
  if (storedReason === null || !expected.has(storedReason)) authorityError("storage_invariant");
  return storedReason as RoomMemoryHealthReason;
}

export function readRoomMemoryStatus(database: DatabaseSync, roomId: string): RoomMemoryStatus {
  if (!identifier(roomId)) authorityError("invalid_input");
  const row = sqlRow(database.prepare(`
    SELECT room_id AS roomId, memory_watermark AS memoryWatermark,
           corpus_head AS corpusHead, health, health_reason_code AS healthReason,
           recovery_generation AS recoveryGeneration, last_attempt_at AS lastAttemptAt,
           retryable, recovery_required AS recoveryRequired, updated_at AS updatedAt
    FROM room_memory_stewards WHERE room_id = ?
  `).get(roomId));
  if (row === undefined) authorityError("room_not_found");
  const memoryWatermark = requiredInteger(row, "memoryWatermark", true);
  const corpusHead = requiredInteger(row, "corpusHead", true);
  const health = requiredString(row, "health");
  const result: RoomMemoryStatus = Object.freeze({
    roomId: requiredString(row, "roomId"),
    health: Object.freeze({
      state: health as RoomMemoryStatus["health"]["state"],
      reason: healthReason(health, nullableString(row, "healthReason")),
      memoryWatermark,
      corpusHead,
      lag: corpusHead - memoryWatermark,
      lastAttemptAt: nullableString(row, "lastAttemptAt"),
      retryable: row.retryable === 1,
      recoveryRequired: row.recoveryRequired === 1,
    }),
    recoveryGeneration: requiredInteger(row, "recoveryGeneration"),
    updatedAt: requiredString(row, "updatedAt"),
  });
  if (!isRoomMemoryStatus(result)) authorityError("storage_invariant");
  return result;
}

function sourceRefsForVersion(database: DatabaseSync, memoryVersionId: string): readonly RoomMemoryVersionSourceRef[] {
  const rows = database.prepare(`
    SELECT edge.source_kind AS sourceKind, edge.source_id AS sourceId,
           edge.source_revision AS sourceRevision,
           source.eligibility, source.availability
    FROM room_memory_source_edges AS edge
    JOIN room_memory_sources AS source
      ON source.room_id = edge.room_id
     AND source.source_kind = edge.source_kind
     AND source.source_id = edge.source_id
     AND source.source_revision = edge.source_revision
    WHERE edge.memory_version_id = ?
    ORDER BY source.corpus_seq, edge.edge_id
  `).all(memoryVersionId);
  const result: RoomMemoryVersionSourceRef[] = [];
  for (const value of rows) {
    const row = sqlRow(value);
    if (row === undefined) authorityError("storage_invariant");
    const sourceKind = requiredString(row, "sourceKind") as RoomMemorySourceKind;
    const eligibility = requiredString(row, "eligibility") as RoomMemorySourceEligibility;
    const availability = requiredString(row, "availability") as RoomMemorySourceAvailability;
    if (!SOURCE_KINDS.has(sourceKind) || !SOURCE_ELIGIBILITIES.has(eligibility) ||
        !SOURCE_AVAILABILITIES.has(availability)) authorityError("storage_invariant");
    result.push(Object.freeze({
      sourceKind,
      sourceId: requiredString(row, "sourceId"),
      sourceRevision: requiredInteger(row, "sourceRevision"),
      eligibility,
      availability,
    }));
  }
  return Object.freeze(result);
}

function projectionForRecord(database: DatabaseSync, memoryRecordId: string): RoomMemoryVersionProjection {
  const row = sqlRow(database.prepare(`
    SELECT record.memory_record_id AS memoryRecordId, record.room_id AS roomId,
           record.kind, version.memory_version_id AS memoryVersionId,
           version.version_number AS versionNumber, version.state,
           version.derived_text AS derivedText, version.created_at AS createdAt,
           version.replaces_version_id AS replacesMemoryVersionId
    FROM room_memory_records AS record
    JOIN room_memory_versions AS version ON version.memory_version_id = record.current_version_id
    WHERE record.memory_record_id = ?
  `).get(memoryRecordId));
  if (row === undefined) authorityError("record_not_found");
  const roomId = requiredString(row, "roomId");
  const kind = requiredString(row, "kind") as RoomMemoryKind;
  const memoryVersionId = requiredString(row, "memoryVersionId");
  const state = requiredString(row, "state") as RoomMemoryVersionState;
  if (!KINDS.has(kind) || !STATES.has(state)) authorityError("storage_invariant");
  const disputeRows = database.prepare(`
    SELECT dispute.dispute_id AS disputeId, dispute.disputed_version_id AS memoryVersionId,
           dispute.operator_actor_id AS operatorActorId, dispute.reason,
           dispute.created_at AS createdAt,
           CASE WHEN resolution.resolution_id IS NULL THEN 'open' ELSE 'resolved' END AS status
    FROM room_memory_disputes AS dispute
    LEFT JOIN room_memory_resolutions AS resolution ON resolution.dispute_id = dispute.dispute_id
    WHERE dispute.memory_record_id = ?
    ORDER BY dispute.created_at, dispute.dispute_id LIMIT 64
  `).all(memoryRecordId);
  const disputes = disputeRows.map((value) => {
    const dispute = sqlRow(value);
    if (dispute === undefined) authorityError("storage_invariant");
    return Object.freeze({
      disputeId: requiredString(dispute, "disputeId"),
      roomId,
      memoryRecordId,
      memoryVersionId: requiredString(dispute, "memoryVersionId"),
      operatorActorId: requiredString(dispute, "operatorActorId"),
      reason: requiredString(dispute, "reason"),
      status: requiredString(dispute, "status") as "open" | "resolved",
      createdAt: requiredString(dispute, "createdAt"),
    });
  });
  const resolutionRows = database.prepare(`
    SELECT resolution.resolution_id AS resolutionId, resolution.dispute_id AS disputeId,
           resolution.expected_disputed_version_id AS fromMemoryVersionId,
           resolution.replacement_version_id AS replacementMemoryVersionId,
           resolution.operator_actor_id AS operatorActorId, resolution.resolution,
           resolution.reason, resolution.created_at AS resolvedAt
    FROM room_memory_resolutions AS resolution
    WHERE resolution.memory_record_id = ?
    ORDER BY resolution.created_at, resolution.resolution_id LIMIT 64
  `).all(memoryRecordId);
  const resolutions = resolutionRows.map((value) => {
    const resolution = sqlRow(value);
    if (resolution === undefined) authorityError("storage_invariant");
    const replacementMemoryVersionId = nullableString(resolution, "replacementMemoryVersionId");
    if (replacementMemoryVersionId === null) authorityError("storage_invariant");
    return Object.freeze({
      resolutionId: requiredString(resolution, "resolutionId"),
      disputeId: requiredString(resolution, "disputeId"),
      roomId,
      memoryRecordId,
      fromMemoryVersionId: requiredString(resolution, "fromMemoryVersionId"),
      replacementMemoryVersionId,
      operatorActorId: requiredString(resolution, "operatorActorId"),
      action: resolution.resolution === "re_evaluate" ? "re_evaluate" as const : "resolve" as const,
      reason: requiredString(resolution, "reason"),
      resolvedAt: requiredString(resolution, "resolvedAt"),
    });
  });
  const result: RoomMemoryVersionProjection = Object.freeze({
    projectionKind: "memory",
    roomId,
    memoryRecordId,
    kind,
    currentVersion: Object.freeze({
      roomId,
      memoryRecordId,
      memoryVersionId,
      version: requiredInteger(row, "versionNumber"),
      kind,
      state,
      derivedText: requiredString(row, "derivedText"),
      sourceRefs: sourceRefsForVersion(database, memoryVersionId),
      createdAt: requiredString(row, "createdAt"),
      replacesMemoryVersionId: nullableString(row, "replacesMemoryVersionId"),
    }),
    disputes: Object.freeze(disputes),
    resolutions: Object.freeze(resolutions),
  });
  if (!isRoomMemoryProjection(result)) authorityError("storage_invariant");
  return result;
}

export function readRoomMemorySnapshot(
  database: DatabaseSync,
  roomId: string,
): readonly RoomMemoryVersionProjection[] {
  if (!identifier(roomId)) authorityError("invalid_input");
  readRoomMemoryStatus(database, roomId);
  const rows = database.prepare(`
    SELECT record.memory_record_id AS memoryRecordId
    FROM room_memory_records AS record
    JOIN room_memory_versions AS version ON version.memory_version_id = record.current_version_id
    WHERE record.room_id = ? AND record.kind = 'context' AND version.state = 'active'
    ORDER BY record.memory_record_id
  `).all(roomId);
  return Object.freeze(rows.map((value) => {
    const row = sqlRow(value);
    if (row === undefined) authorityError("storage_invariant");
    return projectionForRecord(database, requiredString(row, "memoryRecordId"));
  }));
}

export function queryRoomMemory(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly limit: number;
  readonly cursor?: string | null;
  readonly kind?: RoomMemoryKind;
  readonly state?: RoomMemoryVersionState;
}): RoomMemoryQueryResult {
  if (!record(input) || !allowed(input, ["roomId", "limit"], ["cursor", "kind", "state"]) ||
      !identifier(input.roomId) || !positiveInteger(input.limit, 50) ||
      !(input.cursor === undefined || input.cursor === null || identifier(input.cursor)) ||
      !(input.kind === undefined || KINDS.has(input.kind)) ||
      !(input.state === undefined || STATES.has(input.state))) authorityError("invalid_input");
  readRoomMemoryStatus(database, input.roomId);
  const rows = database.prepare(`
    SELECT record.memory_record_id AS memoryRecordId
    FROM room_memory_records AS record
    JOIN room_memory_versions AS version ON version.memory_version_id = record.current_version_id
    WHERE record.room_id = ? AND record.memory_record_id > ?
      AND (? IS NULL OR record.kind = ?)
      AND (? IS NULL OR version.state = ?)
    ORDER BY record.memory_record_id LIMIT ?
  `).all(
    input.roomId,
    input.cursor ?? "",
    input.kind ?? null,
    input.kind ?? null,
    input.state ?? null,
    input.state ?? null,
    input.limit + 1,
  );
  const hasMore = rows.length > input.limit;
  const selected = hasMore ? rows.slice(0, input.limit) : rows;
  const items = selected.map((value) => {
    const row = sqlRow(value);
    if (row === undefined) authorityError("storage_invariant");
    return projectionForRecord(database, requiredString(row, "memoryRecordId"));
  });
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: hasMore ? items.at(-1)?.memoryRecordId ?? null : null,
  });
}

function roomAndSteward(database: DatabaseSync, roomId: string): SqlRow {
  const row = sqlRow(database.prepare(`
    SELECT room.id AS roomId, room.status AS roomStatus,
           room.archive_generation AS archiveGeneration,
           steward.lifecycle_generation AS lifecycleGeneration,
           steward.recovery_generation AS recoveryGeneration,
           steward.memory_watermark AS memoryWatermark,
           steward.corpus_head AS corpusHead, steward.health
    FROM rooms AS room
    JOIN room_memory_stewards AS steward ON steward.room_id = room.id
    WHERE room.id = ?
  `).get(roomId));
  if (row === undefined) authorityError("room_not_found");
  return row;
}

function cancelStaleLifecycleWork(database: DatabaseSync, room: SqlRow, occurredAt: string): SqlRow {
  const roomId = requiredString(room, "roomId");
  const generation = requiredInteger(room, "recoveryGeneration");
  const lifecycle = requiredInteger(room, "archiveGeneration", true);
  const stale = database.prepare(`
    SELECT job_id AS jobId, status FROM room_memory_jobs
    WHERE room_id = ? AND recovery_generation = ? AND lifecycle_generation <> ?
    ORDER BY created_at
  `).all(roomId, generation, lifecycle);
  if (stale.length === 0) return room;
  for (const value of stale) {
    const job = sqlRow(value);
    if (job === undefined) authorityError("storage_invariant");
    const jobId = requiredString(job, "jobId");
    const status = requiredString(job, "status") as RoomMemoryJobStatus;
    if (status === "running") {
      database.prepare(`
        UPDATE room_memory_attempts
        SET status = 'cancelled', error_code = 'room_lifecycle_changed', finished_at = ?
        WHERE job_id = ? AND status = 'running'
      `).run(occurredAt, jobId);
    }
    if (status === "queued" || status === "running" || status === "retry_wait") {
      database.prepare(`
        UPDATE room_memory_jobs
        SET status = 'cancelled', completed_at = ?, last_error_code = 'room_lifecycle_changed', updated_at = ?
        WHERE job_id = ?
      `).run(occurredAt, occurredAt, jobId);
    }
  }
  const watermark = requiredInteger(room, "memoryWatermark", true);
  const head = requiredInteger(room, "corpusHead", true);
  database.prepare(`
    UPDATE room_memory_stewards
    SET recovery_generation = recovery_generation + 1,
        health = ?, health_reason_code = NULL, retryable = 0, recovery_required = 0,
        updated_at = ?
    WHERE room_id = ? AND recovery_generation = ?
  `).run(watermark === head ? "healthy" : "catching_up", occurredAt, roomId, generation);
  return roomAndSteward(database, roomId);
}

export function discoverRoomMemoryReadyRooms(
  database: DatabaseSync,
  limit: number,
): readonly string[] {
  if (!positiveInteger(limit, 1_024)) authorityError("invalid_input");
  const rows = database.prepare(`
    SELECT steward.room_id AS roomId
    FROM room_memory_stewards AS steward
    JOIN rooms AS room ON room.id = steward.room_id
    WHERE room.status = 'active' AND steward.memory_watermark < steward.corpus_head
      AND steward.health = 'catching_up'
      AND NOT EXISTS (
        SELECT 1 FROM room_memory_jobs AS job
        WHERE job.room_id = steward.room_id
          AND job.recovery_generation = steward.recovery_generation
          AND job.lifecycle_generation = room.archive_generation
          AND job.status IN ('queued', 'running', 'retry_wait')
      )
    ORDER BY steward.room_id LIMIT ?
  `).all(limit);
  return Object.freeze(rows.map((value) => {
    const row = sqlRow(value);
    if (row === undefined) authorityError("storage_invariant");
    return requiredString(row, "roomId");
  }));
}

function createJobInTransaction(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly jobId: string;
  readonly batchSize: number;
  readonly availableAt: string;
  readonly createdAt: string;
}): RoomMemoryJob | undefined {
  let room = roomAndSteward(database, input.roomId);
  if (requiredString(room, "roomStatus") !== "active") authorityError("room_archived");
  room = cancelStaleLifecycleWork(database, room, input.createdAt);
  const health = requiredString(room, "health");
  if (health === "noauth") return undefined;
  if (health !== "healthy" && health !== "catching_up") return undefined;
  const watermark = requiredInteger(room, "memoryWatermark", true);
  const head = requiredInteger(room, "corpusHead", true);
  if (watermark >= head) return undefined;
  const current = database.prepare(`${JOB_SELECT}
    WHERE room_id = ? AND recovery_generation = ? AND lifecycle_generation = ?
      AND status IN ('queued', 'running', 'retry_wait')
    ORDER BY created_at LIMIT 1`).get(
    input.roomId,
    requiredInteger(room, "recoveryGeneration"),
    requiredInteger(room, "archiveGeneration", true),
  );
  if (current !== undefined) return jobFromRow(current);
  const to = Math.min(head, watermark + input.batchSize, watermark + 32);
  const rows = database.prepare(`
    SELECT corpus_seq AS corpusSeq, source_kind AS sourceKind, source_id AS sourceId,
           source_revision AS sourceRevision, eligibility, availability
    FROM room_memory_sources
    WHERE room_id = ? AND corpus_seq > ? AND corpus_seq <= ?
    ORDER BY corpus_seq
  `).all(input.roomId, watermark, to);
  if (rows.length !== to - watermark) authorityError("storage_invariant");
  const frozenSources = rows.map((value, index): FrozenRoomMemoryJobSource => {
    const source = sqlRow(value);
    if (source === undefined || requiredInteger(source, "corpusSeq") !== watermark + index + 1) {
      authorityError("storage_invariant");
    }
    return Object.freeze({
      corpusSeq: requiredInteger(source, "corpusSeq"),
      sourceKind: requiredString(source, "sourceKind") as RoomMemorySourceKind,
      sourceId: requiredString(source, "sourceId"),
      sourceRevision: requiredInteger(source, "sourceRevision"),
      eligibility: requiredString(source, "eligibility") as RoomMemorySourceEligibility,
      availability: requiredString(source, "availability") as RoomMemorySourceAvailability,
    });
  });
  database.prepare(`
    INSERT INTO room_memory_jobs (
      job_id, room_id, recovery_generation, lifecycle_generation,
      from_watermark_exclusive, to_corpus_seq_inclusive, source_count,
      frozen_sources_json, status, current_attempt, available_at, claimed_at,
      completed_at, last_error_code, result_sha256, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(
    input.jobId,
    input.roomId,
    requiredInteger(room, "recoveryGeneration"),
    requiredInteger(room, "archiveGeneration", true),
    watermark,
    to,
    frozenSources.length,
    JSON.stringify(frozenSources),
    input.availableAt,
    input.createdAt,
    input.createdAt,
  );
  const created = readRoomMemoryJob(database, input.jobId);
  if (created === undefined) authorityError("storage_invariant");
  return created;
}

export function createRoomMemoryJob(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly jobId: string;
  readonly batchSize: number;
  readonly availableAt: string;
  readonly createdAt: string;
}): RoomMemoryJob | undefined {
  if (!record(input) || !exact(input, ["roomId", "jobId", "batchSize", "availableAt", "createdAt"]) ||
      !identifier(input.roomId) || !identifier(input.jobId) || !positiveInteger(input.batchSize, 32) ||
      !isoTimestamp(input.availableAt) || !isoTimestamp(input.createdAt)) authorityError("invalid_input");
  return atomic(database, () => createJobInTransaction(database, input));
}

function beginAttemptInTransaction(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly inputSha256: string;
  readonly startedAt: string;
}): RoomMemoryAttempt | undefined {
  const room = roomAndSteward(database, input.roomId);
  if (requiredString(room, "roomStatus") !== "active") authorityError("room_archived");
  if (requiredString(room, "health") === "noauth") return undefined;
  const existing = readRoomMemoryAttempt(database, input.attemptId);
  if (existing !== undefined) {
    if (existing.roomId !== input.roomId || existing.jobId !== input.jobId ||
        existing.inputSha256 !== input.inputSha256 || existing.startedAt !== input.startedAt) {
      authorityError("idempotency_conflict");
    }
    return existing;
  }
  const job = readRoomMemoryJob(database, input.jobId);
  if (job === undefined || job.roomId !== input.roomId) authorityError("job_not_found");
  if (job.recoveryGeneration !== requiredInteger(room, "recoveryGeneration") ||
      job.lifecycleGeneration !== requiredInteger(room, "archiveGeneration", true)) {
    authorityError("generation_conflict");
  }
  if (job.status !== "queued" && job.status !== "retry_wait") authorityError("generation_conflict");
  if (Date.parse(job.availableAt) > Date.parse(input.startedAt)) return undefined;
  database.prepare(`
    INSERT INTO room_memory_attempts (
      attempt_id, job_id, room_id, recovery_generation, attempt_number,
      status, input_sha256, output_sha256, error_code, started_at, finished_at, available_at
    ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, ?, NULL, ?)
  `).run(
    input.attemptId, input.jobId, input.roomId, job.recoveryGeneration,
    job.currentAttempt + 1, input.inputSha256, input.startedAt, job.availableAt,
  );
  const created = readRoomMemoryAttempt(database, input.attemptId);
  if (created === undefined) authorityError("storage_invariant");
  return created;
}

export function beginRoomMemoryAttempt(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly inputSha256: string;
  readonly startedAt: string;
}): RoomMemoryAttempt | undefined {
  if (!record(input) || !exact(input, ["roomId", "jobId", "attemptId", "inputSha256", "startedAt"]) ||
      !identifier(input.roomId) || !identifier(input.jobId) || !identifier(input.attemptId) ||
      !sha256Value(input.inputSha256) || !isoTimestamp(input.startedAt)) authorityError("invalid_input");
  return atomic(database, () => beginAttemptInTransaction(database, input));
}

export function markRoomMemoryNoauth(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly occurredAt: string;
}): RoomMemoryStatus {
  if (!record(input) || !exact(input, ["roomId", "occurredAt"]) ||
      !identifier(input.roomId) || !isoTimestamp(input.occurredAt)) authorityError("invalid_input");
  return atomic(database, () => {
    roomAndSteward(database, input.roomId);
    database.prepare(`
      UPDATE room_memory_stewards
      SET health = 'noauth', health_reason_code = 'provider_secret_missing',
          retryable = 0, recovery_required = 0, updated_at = ?
      WHERE room_id = ?
    `).run(input.occurredAt, input.roomId);
    return readRoomMemoryStatus(database, input.roomId);
  });
}

export function markRoomMemoryProviderReady(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly occurredAt: string;
}): RoomMemoryStatus {
  if (!record(input) || !exact(input, ["roomId", "occurredAt"]) ||
      !identifier(input.roomId) || !isoTimestamp(input.occurredAt)) authorityError("invalid_input");
  return atomic(database, () => {
    const room = roomAndSteward(database, input.roomId);
    if (requiredString(room, "health") === "noauth") {
      const watermark = requiredInteger(room, "memoryWatermark", true);
      const head = requiredInteger(room, "corpusHead", true);
      database.prepare(`
        UPDATE room_memory_stewards
        SET health = ?, health_reason_code = NULL, retryable = 0, recovery_required = 0,
            updated_at = ?
        WHERE room_id = ?
      `).run(watermark === head ? "healthy" : "catching_up", input.occurredAt, input.roomId);
    }
    return readRoomMemoryStatus(database, input.roomId);
  });
}

function exhaustedReason(errorCode: string): RoomMemoryHealthReason {
  switch (errorCode) {
    case "provider_timeout": return "provider_timeout_exhausted";
    case "provider_rate_limited": return "provider_rate_limited_exhausted";
    case "provider_unavailable":
    case "authority_unavailable": return "provider_dependency_unavailable";
    case "provider_output_oversized": return "provider_output_oversized";
    case "attempt_dead_lettered": return "attempt_dead_lettered";
    default: return "invalid_provider_output";
  }
}

export type SettleRoomMemoryAttemptInput =
  | Readonly<{
    outcome: "retryable_failure";
    roomId: string;
    jobId: string;
    attemptId: string;
    recoveryGeneration: number;
    errorCode: string;
    finishedAt: string;
    nextAvailableAt: string;
  }>
  | Readonly<{
    outcome: "terminal_failure" | "cancelled";
    roomId: string;
    jobId: string;
    attemptId: string;
    recoveryGeneration: number;
    errorCode: string;
    finishedAt: string;
  }>;

export function settleRoomMemoryAttempt(
  database: DatabaseSync,
  input: SettleRoomMemoryAttemptInput,
): RoomMemoryJob {
  const keys = input.outcome === "retryable_failure"
    ? ["outcome", "roomId", "jobId", "attemptId", "recoveryGeneration", "errorCode", "finishedAt", "nextAvailableAt"]
    : ["outcome", "roomId", "jobId", "attemptId", "recoveryGeneration", "errorCode", "finishedAt"];
  if (!record(input) || !exact(input, keys) ||
      (input.outcome !== "retryable_failure" && input.outcome !== "terminal_failure" && input.outcome !== "cancelled") ||
      !identifier(input.roomId) || !identifier(input.jobId) || !identifier(input.attemptId) ||
      !positiveInteger(input.recoveryGeneration) || !FAILURE_CODES.has(input.errorCode) ||
      !isoTimestamp(input.finishedAt) ||
      (input.outcome === "retryable_failure" && !isoTimestamp(input.nextAvailableAt))) authorityError("invalid_input");
  return atomic(database, () => {
    const job = readRoomMemoryJob(database, input.jobId);
    const attempt = readRoomMemoryAttempt(database, input.attemptId);
    if (job === undefined || job.roomId !== input.roomId) authorityError("job_not_found");
    if (attempt === undefined || attempt.jobId !== input.jobId || attempt.roomId !== input.roomId) {
      authorityError("attempt_not_found");
    }
    const room = roomAndSteward(database, input.roomId);
    if (attempt.status !== "running" || job.status !== "running" ||
        attempt.attemptNumber !== job.currentAttempt ||
        input.recoveryGeneration !== job.recoveryGeneration ||
        job.recoveryGeneration !== requiredInteger(room, "recoveryGeneration")) {
      authorityError("generation_conflict");
    }
    const attemptStatus = input.outcome === "retryable_failure"
      ? "retryable_failed"
      : input.outcome === "terminal_failure" ? "terminal_failed" : "cancelled";
    database.prepare(`
      UPDATE room_memory_attempts
      SET status = ?, error_code = ?, finished_at = ?
      WHERE attempt_id = ?
    `).run(attemptStatus, input.errorCode, input.finishedAt, input.attemptId);
    if (input.outcome === "retryable_failure" && attempt.attemptNumber < 3) {
      database.prepare(`
        UPDATE room_memory_jobs
        SET status = 'retry_wait', available_at = ?, last_error_code = ?, updated_at = ?
        WHERE job_id = ?
      `).run(input.nextAvailableAt, input.errorCode, input.finishedAt, input.jobId);
      database.prepare(`
        UPDATE room_memory_stewards
        SET last_attempt_at = ?, retryable = 1, updated_at = ?
        WHERE room_id = ?
      `).run(input.finishedAt, input.finishedAt, input.roomId);
    } else {
      database.prepare(`
        UPDATE room_memory_jobs
        SET status = ?, completed_at = ?, last_error_code = ?, updated_at = ?
        WHERE job_id = ?
      `).run(input.outcome === "cancelled" ? "cancelled" : "failed", input.finishedAt, input.errorCode, input.finishedAt, input.jobId);
      if (input.outcome !== "cancelled") {
        database.prepare(`
          UPDATE room_memory_stewards
          SET health = 'degraded', health_reason_code = ?, last_attempt_at = ?,
              retryable = ?, recovery_required = 0, updated_at = ?
          WHERE room_id = ?
        `).run(
          exhaustedReason(input.errorCode),
          input.finishedAt,
          input.outcome === "retryable_failure" ? 1 : 0,
          input.finishedAt,
          input.roomId,
        );
      }
    }
    const settled = readRoomMemoryJob(database, input.jobId);
    if (settled === undefined) authorityError("storage_invariant");
    return settled;
  });
}

function validateSourceRef(value: unknown): value is Readonly<{ sourceId: string; sourceRevision: number }> {
  return record(value) && exact(value, ["sourceId", "sourceRevision"]) &&
    identifier(value.sourceId) && positiveInteger(value.sourceRevision);
}

function validateCandidate(value: unknown): value is MemoryStewardCandidate {
  if (!record(value) || !exact(value, [
    "operation", "kind", "derivedText", "sourceRefs", "dedupeKey", "replacesMemoryRecordId",
  ]) || (value.operation !== "create" && value.operation !== "replace" && value.operation !== "merge" &&
      value.operation !== "no_change") || !KINDS.has(value.kind as RoomMemoryKind) ||
      !boundedText(value.derivedText, MEMORY_STEWARD_MAX_DERIVED_TEXT_BYTES) ||
      !Array.isArray(value.sourceRefs) || value.sourceRefs.length < 1 ||
      value.sourceRefs.length > MEMORY_STEWARD_MAX_SOURCE_REFS ||
      typeof value.dedupeKey !== "string" || value.dedupeKey.length < 1 ||
      Buffer.byteLength(value.dedupeKey, "utf8") > MEMORY_STEWARD_MAX_DEDUPE_KEY_BYTES ||
      !/^[ -~]+$/u.test(value.dedupeKey) ||
      !(value.replacesMemoryRecordId === null || identifier(value.replacesMemoryRecordId)) ||
      ((value.operation === "create") !== (value.replacesMemoryRecordId === null) && value.operation !== "no_change")) {
    return false;
  }
  const identities = new Set<string>();
  return value.sourceRefs.every((sourceRef) => {
    if (!validateSourceRef(sourceRef)) return false;
    const key = `${sourceRef.sourceId}\0${sourceRef.sourceRevision}`;
    if (identities.has(key)) return false;
    identities.add(key);
    return true;
  });
}

function validatePlan(value: unknown): asserts value is MemoryStewardPlan {
  if (!record(value) || !exact(value, ["schemaVersion", "candidates"]) ||
      value.schemaVersion !== MEMORY_STEWARD_SCHEMA_VERSION || !Array.isArray(value.candidates) ||
      value.candidates.length > MEMORY_STEWARD_MAX_CANDIDATES) authorityError("invalid_plan");
  const identities = new Set<string>();
  for (const candidate of value.candidates) {
    if (!validateCandidate(candidate)) authorityError("invalid_plan");
    const identity = `${candidate.kind}\0${candidate.dedupeKey}`;
    if (identities.has(identity)) authorityError("invalid_plan");
    identities.add(identity);
  }
}

interface CurrentRecordRow {
  readonly memoryRecordId: string;
  readonly kind: RoomMemoryKind;
  readonly dedupeKey: string;
  readonly currentVersionId: string;
  readonly currentVersionNumber: number;
  readonly state: RoomMemoryVersionState;
  readonly derivedText: string;
}

function currentRecord(database: DatabaseSync, roomId: string, memoryRecordId: string): CurrentRecordRow | undefined {
  const row = sqlRow(database.prepare(`
    SELECT record.memory_record_id AS memoryRecordId, record.kind, record.dedupe_key AS dedupeKey,
           record.current_version_id AS currentVersionId,
           record.current_version_number AS currentVersionNumber,
           version.state, version.derived_text AS derivedText
    FROM room_memory_records AS record
    JOIN room_memory_versions AS version ON version.memory_version_id = record.current_version_id
    WHERE record.room_id = ? AND record.memory_record_id = ?
  `).get(roomId, memoryRecordId));
  if (row === undefined) return undefined;
  const kind = requiredString(row, "kind") as RoomMemoryKind;
  const state = requiredString(row, "state") as RoomMemoryVersionState;
  if (!KINDS.has(kind) || !STATES.has(state)) authorityError("storage_invariant");
  return Object.freeze({
    memoryRecordId: requiredString(row, "memoryRecordId"),
    kind,
    dedupeKey: requiredString(row, "dedupeKey"),
    currentVersionId: requiredString(row, "currentVersionId"),
    currentVersionNumber: requiredInteger(row, "currentVersionNumber"),
    state,
    derivedText: requiredString(row, "derivedText"),
  });
}

interface EligibleSourceRow {
  readonly sourceKind: RoomMemorySourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
}

function eligibleSourceForRef(
  database: DatabaseSync,
  roomId: string,
  sourceId: string,
  sourceRevision: number,
): EligibleSourceRow {
  const rows = database.prepare(`
    SELECT source_kind AS sourceKind, source_id AS sourceId, source_revision AS sourceRevision
    FROM room_memory_sources
    WHERE room_id = ? AND source_id = ? AND source_revision = ?
      AND eligibility = 'eligible' AND availability = 'readable'
  `).all(roomId, sourceId, sourceRevision);
  if (rows.length !== 1) authorityError("source_stale");
  const row = sqlRow(rows[0]);
  if (row === undefined) authorityError("storage_invariant");
  return Object.freeze({
    sourceKind: requiredString(row, "sourceKind") as RoomMemorySourceKind,
    sourceId: requiredString(row, "sourceId"),
    sourceRevision: requiredInteger(row, "sourceRevision"),
  });
}

function insertVersionWithEdges(database: DatabaseSync, input: {
  readonly memoryVersionId: string;
  readonly memoryRecordId: string;
  readonly roomId: string;
  readonly versionNumber: number;
  readonly kind: RoomMemoryKind;
  readonly state: RoomMemoryVersionState;
  readonly derivedText: string;
  readonly originKind: "steward" | "human_resolution" | "source_invalidation";
  readonly createdByActorId: string | null;
  readonly sourceJobId: string | null;
  readonly replacesVersionId: string | null;
  readonly sources: readonly EligibleSourceRow[];
  readonly createdAt: string;
}): void {
  if (input.sources.length < 1 || input.sources.length > 16) authorityError("invalid_plan");
  database.prepare(`
    INSERT INTO room_memory_versions (
      memory_version_id, memory_record_id, room_id, version_number, kind, state,
      derived_text, proposal_id, origin_kind, created_by_actor_id, source_job_id,
      replaces_version_id, source_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.memoryVersionId, input.memoryRecordId, input.roomId, input.versionNumber,
    input.kind, input.state, input.derivedText,
    input.kind === "context" ? null : generatedId("memory-proposal", input.memoryVersionId),
    input.originKind, input.createdByActorId, input.sourceJobId, input.replacesVersionId,
    input.sources.length, input.createdAt,
  );
  for (const source of input.sources) {
    database.prepare(`
      INSERT INTO room_memory_source_edges (
        edge_id, memory_version_id, memory_record_id, room_id,
        source_kind, source_id, source_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generatedId("memory-edge", input.memoryVersionId, source.sourceKind, source.sourceId, source.sourceRevision),
      input.memoryVersionId, input.memoryRecordId, input.roomId,
      source.sourceKind, source.sourceId, source.sourceRevision, input.createdAt,
    );
  }
}

function candidateSources(
  database: DatabaseSync,
  roomId: string,
  job: RoomMemoryJob,
  candidate: MemoryStewardCandidate,
): readonly EligibleSourceRow[] {
  const frozen = new Map<string, FrozenRoomMemoryJobSource[]>();
  for (const source of job.frozenSources) {
    const key = `${source.sourceId}\0${source.sourceRevision}`;
    const values = frozen.get(key) ?? [];
    values.push(source);
    frozen.set(key, values);
  }
  return Object.freeze(candidate.sourceRefs.map((ref) => {
    const values = frozen.get(`${ref.sourceId}\0${ref.sourceRevision}`);
    if (values?.length !== 1 || values[0]?.eligibility !== "eligible" ||
        values[0].availability !== "readable") authorityError("source_stale");
    const current = eligibleSourceForRef(database, roomId, ref.sourceId, ref.sourceRevision);
    if (current.sourceKind !== values[0].sourceKind) authorityError("source_stale");
    return current;
  }));
}

function applyCandidate(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly job: RoomMemoryJob;
  readonly candidate: MemoryStewardCandidate;
  readonly candidateIndex: number;
  readonly committedAt: string;
}): string | undefined {
  const sources = candidateSources(database, input.roomId, input.job, input.candidate);
  if (input.candidate.operation === "no_change") {
    if (input.candidate.replacesMemoryRecordId !== null) {
      const target = currentRecord(database, input.roomId, input.candidate.replacesMemoryRecordId);
      if (target === undefined || target.kind !== input.candidate.kind) authorityError("invalid_plan");
    }
    return undefined;
  }
  if (input.candidate.operation === "create") {
    const duplicate = database.prepare(`
      SELECT memory_record_id FROM room_memory_records
      WHERE room_id = ? AND kind = ? AND dedupe_key = ?
    `).get(input.roomId, input.candidate.kind, input.candidate.dedupeKey);
    if (duplicate !== undefined) authorityError("invalid_plan");
    const memoryRecordId = generatedId(
      `memory-record:${input.candidate.kind}`,
      input.roomId,
      input.candidate.dedupeKey,
    );
    database.prepare(`
      INSERT INTO room_memory_records (
        memory_record_id, room_id, kind, dedupe_key, current_version_id,
        current_version_number, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)
    `).run(
      memoryRecordId, input.roomId, input.candidate.kind, input.candidate.dedupeKey,
      input.committedAt, input.committedAt,
    );
    const memoryVersionId = generatedId(
      "memory-version",
      input.job.jobId,
      input.candidateIndex,
      "create",
    );
    insertVersionWithEdges(database, {
      memoryVersionId,
      memoryRecordId,
      roomId: input.roomId,
      versionNumber: 1,
      kind: input.candidate.kind,
      state: input.candidate.kind === "context" ? "active" : "proposal",
      derivedText: input.candidate.derivedText,
      originKind: "steward",
      createdByActorId: null,
      sourceJobId: input.job.jobId,
      replacesVersionId: null,
      sources,
      createdAt: input.committedAt,
    });
    return memoryRecordId;
  }
  const targetId = input.candidate.replacesMemoryRecordId;
  if (targetId === null) authorityError("invalid_plan");
  const target = currentRecord(database, input.roomId, targetId);
  if (target === undefined || target.kind !== input.candidate.kind ||
      target.dedupeKey !== input.candidate.dedupeKey || target.state === "disputed") {
    authorityError("invalid_plan");
  }
  let versionNumber = target.currentVersionNumber;
  let replacesVersionId = target.currentVersionId;
  if (target.state === "active" || target.state === "proposal" || target.state === "review_required") {
    versionNumber += 1;
    const transitionVersionId = generatedId(
      "memory-version",
      input.job.jobId,
      input.candidateIndex,
      "superseded",
    );
    insertVersionWithEdges(database, {
      memoryVersionId: transitionVersionId,
      memoryRecordId: target.memoryRecordId,
      roomId: input.roomId,
      versionNumber,
      kind: target.kind,
      state: "superseded",
      derivedText: target.derivedText,
      originKind: "steward",
      createdByActorId: null,
      sourceJobId: input.job.jobId,
      replacesVersionId,
      sources,
      createdAt: input.committedAt,
    });
    replacesVersionId = transitionVersionId;
  }
  versionNumber += 1;
  insertVersionWithEdges(database, {
    memoryVersionId: generatedId("memory-version", input.job.jobId, input.candidateIndex, "replacement"),
    memoryRecordId: target.memoryRecordId,
    roomId: input.roomId,
    versionNumber,
    kind: target.kind,
    state: target.kind === "context" ? "active" : "proposal",
    derivedText: input.candidate.derivedText,
    originKind: "steward",
    createdByActorId: null,
    sourceJobId: input.job.jobId,
    replacesVersionId,
    sources,
    createdAt: input.committedAt,
  });
  return target.memoryRecordId;
}

export interface CommitRoomMemoryPlanResult {
  readonly replayed: boolean;
  readonly projections: readonly RoomMemoryVersionProjection[];
  readonly memoryWatermark: number;
}

export function commitRoomMemoryPlan(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly recoveryGeneration: number;
  readonly outputSha256: string;
  readonly plan: MemoryStewardPlan;
  readonly committedAt: string;
}): CommitRoomMemoryPlanResult {
  if (!record(input) || !exact(input, [
    "roomId", "jobId", "attemptId", "recoveryGeneration", "outputSha256", "plan", "committedAt",
  ]) || !identifier(input.roomId) || !identifier(input.jobId) || !identifier(input.attemptId) ||
      !positiveInteger(input.recoveryGeneration) || !sha256Value(input.outputSha256) ||
      !isoTimestamp(input.committedAt)) authorityError("invalid_input");
  validatePlan(input.plan);
  return atomic(database, () => {
    const job = readRoomMemoryJob(database, input.jobId);
    const attempt = readRoomMemoryAttempt(database, input.attemptId);
    if (job === undefined || job.roomId !== input.roomId) authorityError("job_not_found");
    if (attempt === undefined || attempt.jobId !== input.jobId || attempt.roomId !== input.roomId) {
      authorityError("attempt_not_found");
    }
    if (job.status === "completed") {
      if (job.resultSha256 !== input.outputSha256 || attempt.outputSha256 !== input.outputSha256 ||
          job.recoveryGeneration !== input.recoveryGeneration) authorityError("idempotency_conflict");
      const rows = database.prepare(`
        SELECT DISTINCT memory_record_id AS memoryRecordId
        FROM room_memory_versions WHERE source_job_id = ? ORDER BY memory_record_id
      `).all(input.jobId);
      const projections = rows.map((value) => {
        const row = sqlRow(value);
        if (row === undefined) authorityError("storage_invariant");
        return projectionForRecord(database, requiredString(row, "memoryRecordId"));
      });
      return Object.freeze({
        replayed: true,
        projections: Object.freeze(projections),
        memoryWatermark: job.toCorpusSeqInclusive,
      });
    }
    const room = roomAndSteward(database, input.roomId);
    if (requiredString(room, "roomStatus") !== "active") authorityError("room_archived");
    if (job.status !== "running" || attempt.status !== "running" ||
        attempt.attemptNumber !== job.currentAttempt ||
        input.recoveryGeneration !== job.recoveryGeneration ||
        job.recoveryGeneration !== requiredInteger(room, "recoveryGeneration") ||
        job.lifecycleGeneration !== requiredInteger(room, "archiveGeneration", true) ||
        job.fromWatermarkExclusive !== requiredInteger(room, "memoryWatermark", true)) {
      authorityError("generation_conflict");
    }
    const changed = new Set<string>();
    for (const [candidateIndex, candidate] of input.plan.candidates.entries()) {
      const memoryRecordId = applyCandidate(database, {
        roomId: input.roomId,
        job,
        candidate,
        candidateIndex,
        committedAt: input.committedAt,
      });
      if (memoryRecordId !== undefined) changed.add(memoryRecordId);
    }
    database.prepare(`
      UPDATE room_memory_attempts
      SET status = 'succeeded', output_sha256 = ?, finished_at = ?
      WHERE attempt_id = ?
    `).run(input.outputSha256, input.committedAt, input.attemptId);
    database.prepare(`
      UPDATE room_memory_jobs
      SET status = 'completed', completed_at = ?, result_sha256 = ?, updated_at = ?
      WHERE job_id = ?
    `).run(input.committedAt, input.outputSha256, input.committedAt, input.jobId);
    const head = requiredInteger(room, "corpusHead", true);
    database.prepare(`
      UPDATE room_memory_stewards
      SET memory_watermark = ?, health = ?, health_reason_code = NULL,
          last_attempt_at = ?, retryable = 0, recovery_required = 0, updated_at = ?
      WHERE room_id = ?
    `).run(
      job.toCorpusSeqInclusive,
      job.toCorpusSeqInclusive === head ? "healthy" : "catching_up",
      input.committedAt,
      input.committedAt,
      input.roomId,
    );
    const projections = [...changed].sort().map((memoryRecordId) => projectionForRecord(database, memoryRecordId));
    return Object.freeze({
      replayed: false,
      projections: Object.freeze(projections),
      memoryWatermark: job.toCorpusSeqInclusive,
    });
  });
}

export interface InvalidateRoomMemorySourceResult {
  readonly replayed: boolean;
  readonly projections: readonly RoomMemoryVersionProjection[];
}

export function invalidateRoomMemorySource(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly sourceKind: RoomMemorySourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly eligibility: Exclude<RoomMemorySourceEligibility, "eligible">;
  readonly availability: Exclude<RoomMemorySourceAvailability, "readable">;
  readonly occurredAt: string;
}): InvalidateRoomMemorySourceResult {
  if (!record(input) || !exact(input, [
    "roomId", "sourceKind", "sourceId", "sourceRevision", "eligibility", "availability", "occurredAt",
  ]) || !identifier(input.roomId) || !SOURCE_KINDS.has(input.sourceKind) || !identifier(input.sourceId) ||
      !positiveInteger(input.sourceRevision) || !SOURCE_ELIGIBILITIES.has(input.eligibility) ||
      !SOURCE_AVAILABILITIES.has(input.availability) ||
      (input.sourceKind === "message_tombstone" && input.availability !== "tombstone") ||
      (input.sourceKind !== "message_tombstone" && input.availability === "tombstone") ||
      !isoTimestamp(input.occurredAt)) authorityError("invalid_input");
  return atomic(database, () => {
    const source = sqlRow(database.prepare(`
      SELECT eligibility, availability FROM room_memory_sources
      WHERE room_id = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
    `).get(input.roomId, input.sourceKind, input.sourceId, input.sourceRevision));
    if (source === undefined) authorityError("source_stale");
    if (source.eligibility === input.eligibility && source.availability === input.availability) {
      return Object.freeze({ replayed: true, projections: Object.freeze([]) });
    }
    if (source.eligibility !== "eligible" || source.availability !== "readable") {
      authorityError("source_stale");
    }
    const impactedRows = database.prepare(`
      SELECT record.memory_record_id AS memoryRecordId
      FROM room_memory_records AS record
      JOIN room_memory_versions AS version ON version.memory_version_id = record.current_version_id
      JOIN room_memory_source_edges AS edge ON edge.memory_version_id = version.memory_version_id
      WHERE record.room_id = ? AND edge.source_kind = ? AND edge.source_id = ?
        AND edge.source_revision = ?
      ORDER BY record.memory_record_id
    `).all(input.roomId, input.sourceKind, input.sourceId, input.sourceRevision);
    const changed: string[] = [];
    for (const value of impactedRows) {
      const impacted = sqlRow(value);
      if (impacted === undefined) authorityError("storage_invariant");
      const memoryRecordId = requiredString(impacted, "memoryRecordId");
      const current = currentRecord(database, input.roomId, memoryRecordId);
      if (current === undefined) authorityError("storage_invariant");
      const refs = sourceRefsForVersion(database, current.currentVersionId);
      const remaining = refs
        .filter((ref) => !(ref.sourceKind === input.sourceKind && ref.sourceId === input.sourceId &&
          ref.sourceRevision === input.sourceRevision))
        .filter((ref) => ref.eligibility === "eligible" && ref.availability === "readable")
        .map((ref) => eligibleSourceForRef(database, input.roomId, ref.sourceId, ref.sourceRevision));
      let state: "review_required" | "invalidated" | undefined;
      if (current.state === "active" || current.state === "proposal") {
        state = remaining.length > 0 ? "review_required" : "invalidated";
      } else if (current.state === "disputed") {
        state = "invalidated";
      } else if (current.state === "review_required" && remaining.length === 0) {
        state = "invalidated";
      }
      if (state === undefined) continue;
      const transitionSources = remaining.length > 0
        ? remaining
        : [eligibleSourceForRef(database, input.roomId, input.sourceId, input.sourceRevision)];
      insertVersionWithEdges(database, {
        memoryVersionId: generatedId(
          "memory-version",
          "source-invalidation",
          current.currentVersionId,
          input.sourceKind,
          input.sourceId,
          input.sourceRevision,
        ),
        memoryRecordId,
        roomId: input.roomId,
        versionNumber: current.currentVersionNumber + 1,
        kind: current.kind,
        state,
        derivedText: current.derivedText,
        originKind: "source_invalidation",
        createdByActorId: null,
        sourceJobId: null,
        replacesVersionId: current.currentVersionId,
        sources: transitionSources,
        createdAt: input.occurredAt,
      });
      changed.push(memoryRecordId);
    }
    database.prepare(`
      UPDATE room_memory_sources
      SET eligibility = ?, availability = ?, updated_at = ?
      WHERE room_id = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
    `).run(
      input.eligibility, input.availability, input.occurredAt,
      input.roomId, input.sourceKind, input.sourceId, input.sourceRevision,
    );
    return Object.freeze({
      replayed: false,
      projections: Object.freeze(changed.map((recordId) => projectionForRecord(database, recordId))),
    });
  });
}

type ReceiptScope = "memory_dispute" | "memory_resolve" | "memory_retry";

function receipt(database: DatabaseSync, scope: ReceiptScope, requestId: string, nowMs: number): SqlRow | undefined {
  const row = sqlRow(database.prepare(`
    SELECT room_id AS roomId, actor_id AS actorId, request_sha256 AS requestSha256,
           response_json AS responseJson, status_code AS statusCode,
           created_at_ms AS createdAtMs, expires_at_ms AS expiresAtMs
    FROM room_memory_idempotency WHERE scope = ? AND idempotency_key = ?
  `).get(scope, requestId));
  if (row !== undefined && requiredInteger(row, "expiresAtMs") <= nowMs) {
    database.prepare("DELETE FROM room_memory_idempotency WHERE scope = ? AND idempotency_key = ?")
      .run(scope, requestId);
    return undefined;
  }
  return row;
}

function receiptResponse(row: SqlRow): UnknownRecord {
  const json = requiredString(row, "responseJson");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    authorityError("storage_invariant");
  }
  if (!record(parsed)) authorityError("storage_invariant");
  return parsed;
}

function insertReceipt(database: DatabaseSync, input: {
  readonly scope: ReceiptScope;
  readonly requestId: string;
  readonly roomId: string;
  readonly actorId: string;
  readonly requestSha256: string;
  readonly response: UnknownRecord;
  readonly occurredAtMs: number;
}): void {
  database.prepare(`
    INSERT INTO room_memory_idempotency (
      scope, idempotency_key, room_id, actor_id, request_sha256,
      response_json, status_code, created_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 200, ?, ?)
  `).run(
    input.scope, input.requestId, input.roomId, input.actorId, input.requestSha256,
    JSON.stringify(input.response), input.occurredAtMs, input.occurredAtMs + MAX_RECEIPT_AGE_MS,
  );
}

function currentHumanMembership(database: DatabaseSync, roomId: string, actorId: string): SqlRow {
  const row = sqlRow(database.prepare(`
    SELECT membership.role, room.status AS roomStatus
    FROM room_memberships AS membership
    JOIN actors AS actor ON actor.id = membership.actor_id
    JOIN rooms AS room ON room.id = membership.room_id
    WHERE membership.room_id = ? AND membership.actor_id = ?
      AND membership.kind = 'human' AND actor.kind = 'human'
  `).get(roomId, actorId));
  if (row === undefined) authorityError("forbidden");
  if (requiredString(row, "roomStatus") !== "active") authorityError("room_archived");
  return row;
}

function eligibleSourcesFromRefs(
  database: DatabaseSync,
  roomId: string,
  refs: readonly Readonly<{ sourceId: string; sourceRevision: number }>[],
): readonly EligibleSourceRow[] {
  if (refs.length < 1 || refs.length > 16) authorityError("invalid_input");
  const seen = new Set<string>();
  return Object.freeze(refs.map((ref) => {
    const key = `${ref.sourceId}\0${ref.sourceRevision}`;
    if (seen.has(key)) authorityError("invalid_input");
    seen.add(key);
    return eligibleSourceForRef(database, roomId, ref.sourceId, ref.sourceRevision);
  }));
}

export interface DisputeRoomMemoryContextResult {
  readonly replayed: boolean;
  readonly dispute: RoomMemoryVersionProjection["disputes"][number];
  readonly projection: RoomMemoryVersionProjection;
}

export function disputeRoomMemoryContext(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly memoryRecordId: string;
  readonly expectedVersion: number;
  readonly reason: string;
  readonly occurredAt: string;
}): DisputeRoomMemoryContextResult {
  if (!record(input) || !exact(input, [
    "roomId", "actorId", "requestId", "memoryRecordId", "expectedVersion", "reason", "occurredAt",
  ]) || !identifier(input.roomId) || !identifier(input.actorId) || !identifier(input.requestId) ||
      !identifier(input.memoryRecordId) || !positiveInteger(input.expectedVersion) ||
      !boundedText(input.reason, 2_048) || !isoTimestamp(input.occurredAt)) authorityError("invalid_input");
  const requestSha256 = sha256({
    roomId: input.roomId,
    actorId: input.actorId,
    memoryRecordId: input.memoryRecordId,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
  });
  const occurredAtMs = Date.parse(input.occurredAt);
  return atomic(database, () => {
    const replay = receipt(database, "memory_dispute", input.requestId, occurredAtMs);
    if (replay !== undefined) {
      if (requiredString(replay, "requestSha256") !== requestSha256 ||
          requiredString(replay, "roomId") !== input.roomId || requiredString(replay, "actorId") !== input.actorId) {
        authorityError("idempotency_conflict");
      }
      const response = receiptResponse(replay);
      if (!exact(response, ["memoryRecordId", "disputeId"]) ||
          !identifier(response.memoryRecordId) || !identifier(response.disputeId)) authorityError("storage_invariant");
      const projection = projectionForRecord(database, response.memoryRecordId);
      const dispute = projection.disputes.find((candidate) => candidate.disputeId === response.disputeId);
      if (dispute === undefined) authorityError("storage_invariant");
      return Object.freeze({ replayed: true, dispute, projection });
    }
    currentHumanMembership(database, input.roomId, input.actorId);
    const current = currentRecord(database, input.roomId, input.memoryRecordId);
    if (current === undefined) authorityError("record_not_found");
    if (current.kind !== "context" || current.state !== "active" ||
        current.currentVersionNumber !== input.expectedVersion) authorityError("version_conflict");
    const sources = eligibleSourcesFromRefs(
      database,
      input.roomId,
      sourceRefsForVersion(database, current.currentVersionId).map((ref) => ({
        sourceId: ref.sourceId,
        sourceRevision: ref.sourceRevision,
      })),
    );
    const disputeId = generatedId("memory-dispute", input.roomId, input.requestId);
    const disputedVersionId = generatedId("memory-version", disputeId, "disputed");
    insertVersionWithEdges(database, {
      memoryVersionId: disputedVersionId,
      memoryRecordId: input.memoryRecordId,
      roomId: input.roomId,
      versionNumber: current.currentVersionNumber + 1,
      kind: "context",
      state: "disputed",
      derivedText: current.derivedText,
      originKind: "human_resolution",
      createdByActorId: input.actorId,
      sourceJobId: null,
      replacesVersionId: current.currentVersionId,
      sources,
      createdAt: input.occurredAt,
    });
    database.prepare(`
      INSERT INTO room_memory_disputes (
        dispute_id, room_id, memory_record_id, expected_version_id,
        disputed_version_id, expected_version_number, operator_kind,
        operator_actor_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'human', ?, ?, ?)
    `).run(
      disputeId, input.roomId, input.memoryRecordId, current.currentVersionId,
      disputedVersionId, input.expectedVersion, input.actorId, input.reason, input.occurredAt,
    );
    insertReceipt(database, {
      scope: "memory_dispute",
      requestId: input.requestId,
      roomId: input.roomId,
      actorId: input.actorId,
      requestSha256,
      response: { memoryRecordId: input.memoryRecordId, disputeId },
      occurredAtMs,
    });
    const projection = projectionForRecord(database, input.memoryRecordId);
    const dispute = projection.disputes.find((candidate) => candidate.disputeId === disputeId);
    if (dispute === undefined) authorityError("storage_invariant");
    return Object.freeze({ replayed: false, dispute, projection });
  });
}

export interface RoomMemoryReevaluationProof {
  readonly jobId: string;
  readonly attemptId: string;
  readonly recoveryGeneration: number;
  readonly resultSha256: string;
}

function validateReevaluationProof(value: unknown): value is RoomMemoryReevaluationProof {
  return record(value) && exact(value, ["jobId", "attemptId", "recoveryGeneration", "resultSha256"]) &&
    identifier(value.jobId) && identifier(value.attemptId) && positiveInteger(value.recoveryGeneration) &&
    sha256Value(value.resultSha256);
}

function proveReevaluation(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly disputeCreatedAt: string;
  readonly proof: RoomMemoryReevaluationProof;
}): void {
  const row = sqlRow(database.prepare(`
    SELECT job.status AS jobStatus, job.completed_at AS completedAt,
           job.result_sha256 AS resultSha256, job.recovery_generation AS recoveryGeneration,
           attempt.status AS attemptStatus, attempt.output_sha256 AS attemptOutputSha256
    FROM room_memory_jobs AS job
    JOIN room_memory_attempts AS attempt ON attempt.job_id = job.job_id
    WHERE job.room_id = ? AND job.job_id = ? AND attempt.attempt_id = ?
  `).get(input.roomId, input.proof.jobId, input.proof.attemptId));
  if (row === undefined || row.jobStatus !== "completed" || row.attemptStatus !== "succeeded" ||
      requiredInteger(row, "recoveryGeneration") !== input.proof.recoveryGeneration ||
      row.resultSha256 !== input.proof.resultSha256 || row.attemptOutputSha256 !== input.proof.resultSha256 ||
      Date.parse(requiredString(row, "completedAt")) <= Date.parse(input.disputeCreatedAt)) {
    authorityError("forbidden");
  }
}

export interface ResolveRoomMemoryContextResult {
  readonly replayed: boolean;
  readonly resolution: RoomMemoryVersionProjection["resolutions"][number];
  readonly projection: RoomMemoryVersionProjection;
}

export function resolveRoomMemoryContext(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly memoryRecordId: string;
  readonly expectedVersion: number;
  readonly action: "resolve" | "re_evaluate";
  readonly reason: string;
  readonly replacementDerivedText: string;
  readonly sourceRefs: readonly Readonly<{ sourceId: string; sourceRevision: number }>[];
  readonly reevaluationProof: RoomMemoryReevaluationProof | null;
  readonly occurredAt: string;
}): ResolveRoomMemoryContextResult {
  if (!record(input) || !exact(input, [
    "roomId", "actorId", "requestId", "memoryRecordId", "expectedVersion", "action", "reason",
    "replacementDerivedText", "sourceRefs", "reevaluationProof", "occurredAt",
  ]) || !identifier(input.roomId) || !identifier(input.actorId) || !identifier(input.requestId) ||
      !identifier(input.memoryRecordId) || !positiveInteger(input.expectedVersion) ||
      (input.action !== "resolve" && input.action !== "re_evaluate") ||
      !boundedText(input.reason, 2_048) ||
      !boundedText(input.replacementDerivedText, MEMORY_STEWARD_MAX_DERIVED_TEXT_BYTES) ||
      !Array.isArray(input.sourceRefs) || !input.sourceRefs.every(validateSourceRef) ||
      !(input.reevaluationProof === null || validateReevaluationProof(input.reevaluationProof)) ||
      !isoTimestamp(input.occurredAt)) authorityError("invalid_input");
  const requestSha256 = sha256({
    roomId: input.roomId,
    actorId: input.actorId,
    memoryRecordId: input.memoryRecordId,
    expectedVersion: input.expectedVersion,
    action: input.action,
    reason: input.reason,
    replacementDerivedText: input.replacementDerivedText,
    sourceRefs: input.sourceRefs,
    reevaluationProof: input.reevaluationProof,
  });
  const occurredAtMs = Date.parse(input.occurredAt);
  return atomic(database, () => {
    const replay = receipt(database, "memory_resolve", input.requestId, occurredAtMs);
    if (replay !== undefined) {
      if (requiredString(replay, "requestSha256") !== requestSha256 ||
          requiredString(replay, "roomId") !== input.roomId || requiredString(replay, "actorId") !== input.actorId) {
        authorityError("idempotency_conflict");
      }
      const response = receiptResponse(replay);
      if (!exact(response, ["memoryRecordId", "resolutionId"]) ||
          !identifier(response.memoryRecordId) || !identifier(response.resolutionId)) authorityError("storage_invariant");
      const projection = projectionForRecord(database, response.memoryRecordId);
      const resolution = projection.resolutions.find((candidate) => candidate.resolutionId === response.resolutionId);
      if (resolution === undefined) authorityError("storage_invariant");
      return Object.freeze({ replayed: true, resolution, projection });
    }
    const membership = currentHumanMembership(database, input.roomId, input.actorId);
    const current = currentRecord(database, input.roomId, input.memoryRecordId);
    if (current === undefined) authorityError("record_not_found");
    if (current.kind !== "context" || current.state !== "disputed" ||
        current.currentVersionNumber !== input.expectedVersion) authorityError("version_conflict");
    const dispute = sqlRow(database.prepare(`
      SELECT dispute_id AS disputeId, operator_actor_id AS operatorActorId,
             created_at AS createdAt
      FROM room_memory_disputes
      WHERE memory_record_id = ? AND disputed_version_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM room_memory_resolutions
          WHERE room_memory_resolutions.dispute_id = room_memory_disputes.dispute_id
        )
    `).get(input.memoryRecordId, current.currentVersionId));
    if (dispute === undefined) authorityError("version_conflict");
    const originalDisputer = requiredString(dispute, "operatorActorId") === input.actorId;
    const role = requiredString(membership, "role");
    if (!originalDisputer) {
      if ((role !== "owner" && role !== "admin") || input.reevaluationProof === null) authorityError("forbidden");
      proveReevaluation(database, {
        roomId: input.roomId,
        disputeCreatedAt: requiredString(dispute, "createdAt"),
        proof: input.reevaluationProof,
      });
    }
    const sources = eligibleSourcesFromRefs(database, input.roomId, input.sourceRefs);
    const resolutionId = generatedId("memory-resolution", input.roomId, input.requestId);
    const resolutionVersionId = generatedId("memory-version", resolutionId, "resolved");
    insertVersionWithEdges(database, {
      memoryVersionId: resolutionVersionId,
      memoryRecordId: input.memoryRecordId,
      roomId: input.roomId,
      versionNumber: current.currentVersionNumber + 1,
      kind: "context",
      state: "resolved",
      derivedText: current.derivedText,
      originKind: "human_resolution",
      createdByActorId: input.actorId,
      sourceJobId: input.reevaluationProof?.jobId ?? null,
      replacesVersionId: current.currentVersionId,
      sources,
      createdAt: input.occurredAt,
    });
    const replacementVersionId = generatedId("memory-version", resolutionId, "replacement");
    insertVersionWithEdges(database, {
      memoryVersionId: replacementVersionId,
      memoryRecordId: input.memoryRecordId,
      roomId: input.roomId,
      versionNumber: current.currentVersionNumber + 2,
      kind: "context",
      state: "active",
      derivedText: input.replacementDerivedText,
      originKind: "human_resolution",
      createdByActorId: input.actorId,
      sourceJobId: input.reevaluationProof?.jobId ?? null,
      replacesVersionId: resolutionVersionId,
      sources,
      createdAt: input.occurredAt,
    });
    database.prepare(`
      INSERT INTO room_memory_resolutions (
        resolution_id, dispute_id, room_id, memory_record_id,
        expected_disputed_version_id, resolution_version_id, replacement_version_id,
        operator_kind, operator_actor_id, resolution, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?, ?)
    `).run(
      resolutionId,
      requiredString(dispute, "disputeId"),
      input.roomId,
      input.memoryRecordId,
      current.currentVersionId,
      resolutionVersionId,
      replacementVersionId,
      input.actorId,
      input.action === "re_evaluate" ? "re_evaluate" : "replace",
      input.reason,
      input.occurredAt,
    );
    insertReceipt(database, {
      scope: "memory_resolve",
      requestId: input.requestId,
      roomId: input.roomId,
      actorId: input.actorId,
      requestSha256,
      response: { memoryRecordId: input.memoryRecordId, resolutionId },
      occurredAtMs,
    });
    const projection = projectionForRecord(database, input.memoryRecordId);
    const resolution = projection.resolutions.find((candidate) => candidate.resolutionId === resolutionId);
    if (resolution === undefined) authorityError("storage_invariant");
    return Object.freeze({ replayed: false, resolution, projection });
  });
}

export interface ManualRetryRoomMemoryResult {
  readonly replayed: boolean;
  readonly recoveryGeneration: number;
  readonly job: RoomMemoryJob;
  readonly attempt: RoomMemoryAttempt;
}

export function manualRetryRoomMemory(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly expectedRecoveryGeneration: number;
  readonly jobId: string;
  readonly attemptId: string;
  readonly inputSha256: string;
  readonly batchSize: number;
  readonly acceptedAt: string;
}): ManualRetryRoomMemoryResult {
  if (!record(input) || !exact(input, [
    "roomId", "actorId", "requestId", "expectedRecoveryGeneration", "jobId", "attemptId",
    "inputSha256", "batchSize", "acceptedAt",
  ]) || !identifier(input.roomId) || !identifier(input.actorId) || !identifier(input.requestId) ||
      !positiveInteger(input.expectedRecoveryGeneration) || !identifier(input.jobId) ||
      !identifier(input.attemptId) || !sha256Value(input.inputSha256) ||
      !positiveInteger(input.batchSize, 32) || !isoTimestamp(input.acceptedAt)) authorityError("invalid_input");
  const requestSha256 = sha256({
    roomId: input.roomId,
    actorId: input.actorId,
    expectedRecoveryGeneration: input.expectedRecoveryGeneration,
    jobId: input.jobId,
    attemptId: input.attemptId,
    inputSha256: input.inputSha256,
    batchSize: input.batchSize,
  });
  const acceptedAtMs = Date.parse(input.acceptedAt);
  return atomic(database, () => {
    const replay = receipt(database, "memory_retry", input.requestId, acceptedAtMs);
    if (replay !== undefined) {
      if (requiredString(replay, "requestSha256") !== requestSha256 ||
          requiredString(replay, "roomId") !== input.roomId || requiredString(replay, "actorId") !== input.actorId) {
        authorityError("idempotency_conflict");
      }
      const response = receiptResponse(replay);
      if (!exact(response, ["recoveryGeneration", "jobId", "attemptId"]) ||
          !positiveInteger(response.recoveryGeneration) || !identifier(response.jobId) ||
          !identifier(response.attemptId)) authorityError("storage_invariant");
      const job = readRoomMemoryJob(database, response.jobId);
      const attempt = readRoomMemoryAttempt(database, response.attemptId);
      if (job === undefined || attempt === undefined) authorityError("storage_invariant");
      return Object.freeze({
        replayed: true,
        recoveryGeneration: response.recoveryGeneration,
        job,
        attempt,
      });
    }
    currentHumanMembership(database, input.roomId, input.actorId);
    const room = roomAndSteward(database, input.roomId);
    const generation = requiredInteger(room, "recoveryGeneration");
    const watermark = requiredInteger(room, "memoryWatermark", true);
    const head = requiredInteger(room, "corpusHead", true);
    const health = requiredString(room, "health");
    if (generation !== input.expectedRecoveryGeneration) authorityError("generation_conflict");
    if (health === "noauth") authorityError("noauth");
    if ((health !== "degraded" && health !== "failed") || watermark >= head) authorityError("generation_conflict");
    database.prepare(`
      UPDATE room_memory_stewards
      SET recovery_generation = recovery_generation + 1,
          health = 'catching_up', health_reason_code = NULL,
          retryable = 0, recovery_required = 0, updated_at = ?
      WHERE room_id = ? AND recovery_generation = ?
    `).run(input.acceptedAt, input.roomId, generation);
    const job = createJobInTransaction(database, {
      roomId: input.roomId,
      jobId: input.jobId,
      batchSize: input.batchSize,
      availableAt: input.acceptedAt,
      createdAt: input.acceptedAt,
    });
    if (job === undefined) authorityError("storage_invariant");
    const attempt = beginAttemptInTransaction(database, {
      roomId: input.roomId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      inputSha256: input.inputSha256,
      startedAt: input.acceptedAt,
    });
    if (attempt === undefined) authorityError("storage_invariant");
    const runningJob = readRoomMemoryJob(database, input.jobId);
    if (runningJob === undefined) authorityError("storage_invariant");
    const recoveryGeneration = generation + 1;
    insertReceipt(database, {
      scope: "memory_retry",
      requestId: input.requestId,
      roomId: input.roomId,
      actorId: input.actorId,
      requestSha256,
      response: { recoveryGeneration, jobId: input.jobId, attemptId: input.attemptId },
      occurredAtMs: acceptedAtMs,
    });
    return Object.freeze({ replayed: false, recoveryGeneration, job: runningJob, attempt });
  });
}
