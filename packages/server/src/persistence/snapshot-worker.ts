import { createHash, randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
  isAttachmentRepairRecord,
  isAgentExecution,
  isAgentExecutionAttempt,
  isAgentExecutionRetryReceipt,
  isAgentInvocationIntent,
  isCalibrationSignal,
  isLightTask,
  isMessageAuthorityRepairRecord,
  isProjectBoundaryInvocationResult,
  isRoomRepairPage,
  isRouteJob,
  isRouteJudgment,
  isScopedCancellationReceipt,
  isSnapshotVersion,
  isWorkspaceBootstrapPage,
} from "@native-im/core";
import type {
  LegacyAgentExecution,
  OpenItem,
  RoomRepairRecord,
  RoomSummary,
} from "@native-im/core";
import { lifecycleRepairSegmentDescriptor } from
  "../room-governance/lifecycle-repair-descriptor.js";
import { createRoomAssignmentRepairSegmentDescriptor } from
  "../agent-settings/room-assignment-repair-descriptor.js";
import {
  memoryRepairSegmentDescriptor,
  ROOM_MEMORY_REPAIR_KEYSET_LIMIT,
} from "../room-memory/repair-descriptor.js";
import {
  NOTIFICATION_REPAIR_KEYSET_LIMIT,
  readNotificationRepairPage,
} from "../notifications/sqlite-authority.js";
import { readProjectLoopRepairSnapshotDatabaseQuery } from "../project-loop/database-authority.js";
import { createProjectLoopRepairSegmentDescriptor } from "../project-loop/repair-descriptor.js";
import {
  readOperationalMessageRepairPage,
  readOperationalMessageRepairRecord,
} from
  "../message-authority/sqlite-operational-message-projection.js";
import type {
  AuthenticatedSessionContext,
  MaterializedSnapshotManifest,
  SnapshotFallbackReason,
  SnapshotMaterializedPage,
  SnapshotWorkerErrorCode,
  SnapshotWorkerRequest,
  SnapshotWorkerResponse,
  StreamingRepairLease,
  StreamingSnapshotManifest,
} from "./contracts.js";
import { SNAPSHOT_REQUEST_ID_MAX_BYTES } from "./contracts.js";
import {
  configureSnapshotCacheConnection,
  migrateSnapshotCacheDatabase,
  readSchemaVersion,
  SNAPSHOT_CACHE_SCHEMA_VERSION,
  validateSnapshotCachePhysicalSchema,
} from "./schema.js";
import {
  createGuardedClosedRepairProjectionRegistry,
  isPublicToolSafetyRepairRecord,
  type RepairKeysetPageInput,
  type RoomRepairSegmentDescriptor,
} from "./repair-projection-registry.js";

interface SnapshotWorkerData {
  readonly authorityPath: string;
  readonly cachePath: string;
  readonly limits: {
    readonly maxConcurrentBuilds: number;
    readonly queueLimit: number;
    readonly scanBatchSize: number;
    readonly ttlMs: number;
    readonly reuseMinRemainingMs: number;
    readonly cacheQuotaBytes: number;
    readonly buildDeadlineMs: number;
    readonly maxWalGrowthBytes: number;
    readonly maxRecordsPerPage: number;
    readonly maxPageBytes: number;
  };
  readonly pauseState?: SharedArrayBuffer;
  readonly deploymentProviderCredentialReadiness?: "ready" | "noauth";
}

class SnapshotBuildError extends Error {
  constructor(readonly code: SnapshotWorkerErrorCode, message: string) {
    super(message);
  }
}

class SnapshotFallback extends Error {
  constructor(readonly reason: SnapshotFallbackReason) {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function responseRequestId(value: unknown): value is string {
  return text(value) && Buffer.byteLength(value, "utf8") <= SNAPSHOT_REQUEST_ID_MAX_BYTES;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validContext(value: unknown): value is AuthenticatedSessionContext {
  return isRecord(value) && exact(value, [
    "sessionId", "sessionFamilyId", "principal",
    ...(Object.hasOwn(value, "deviceId") ? ["deviceId"] : []),
  ]) &&
    text(value.sessionId) && text(value.sessionFamilyId) && isRecord(value.principal) &&
    (!Object.hasOwn(value, "deviceId") || text(value.deviceId)) &&
    exact(value.principal, ["accountId", "actorId"]) &&
    text(value.principal.accountId) && text(value.principal.actorId);
}

function validRepairScope(value: unknown): boolean {
  return isRecord(value) && (
    (value.kind === "room" && exact(value, ["kind", "roomId"]) && text(value.roomId)) ||
    (value.kind === "catalog" && exact(value, ["kind", "principalId"]) && text(value.principalId))
  );
}

function validStreamingLease(value: unknown): value is StreamingRepairLease {
  if (!isRecord(value) || !exact(value, [
    "snapshotId", "principalId", "accountId", "sessionFamilyId", "scope",
    "version", "authorizationRevision", "idleExpiresAt",
    ...(Object.hasOwn(value, "checksum") ? ["checksum"] : []),
    ...(Object.hasOwn(value, "pageCount") ? ["pageCount"] : []),
    ...(Object.hasOwn(value, "lastPage") ? ["lastPage"] : []),
    ...(Object.hasOwn(value, "highestAuthorizedPage") ? ["highestAuthorizedPage"] : []),
  ])) return false;
  const attached = Object.hasOwn(value, "checksum") || Object.hasOwn(value, "pageCount") ||
    Object.hasOwn(value, "lastPage") || Object.hasOwn(value, "highestAuthorizedPage");
  return text(value.snapshotId) && text(value.principalId) && text(value.accountId) &&
    text(value.sessionFamilyId) && validRepairScope(value.scope) &&
    isSnapshotVersion(value.version) && count(value.authorizationRevision) &&
    text(value.idleExpiresAt) &&
    (!attached || (text(value.checksum) && count(value.pageCount) &&
      value.pageCount > 0 && count(value.lastPage) && value.lastPage === value.pageCount - 1 &&
      typeof value.highestAuthorizedPage === "number" &&
      Number.isSafeInteger(value.highestAuthorizedPage) && value.highestAuthorizedPage >= -1 &&
      value.highestAuthorizedPage <= value.lastPage));
}

function isRequest(value: unknown): value is SnapshotWorkerRequest {
  if (!isRecord(value) || !text(value.type) || !text(value.requestId)) return false;
  switch (value.type) {
    case "snapshot.initialize":
    case "snapshot.cache-count":
    case "snapshot.full-validation-count":
    case "snapshot.close":
      return exact(value, ["type", "requestId"]);
    case "snapshot.begin-room":
      return exact(value, ["type", "requestId", "context", "responseRequestId", "roomId", "now"]) &&
        validContext(value.context) && responseRequestId(value.responseRequestId) && text(value.roomId) && count(value.now);
    case "snapshot.begin-catalog":
      return exact(value, ["type", "requestId", "context", "responseRequestId", "now"]) &&
        validContext(value.context) && responseRequestId(value.responseRequestId) && count(value.now);
    case "snapshot.read-page":
      return exact(value, ["type", "requestId", "context", "responseRequestId", "snapshotId", "afterPage", "now"]) &&
        validContext(value.context) && responseRequestId(value.responseRequestId) && text(value.snapshotId) &&
        count(value.afterPage) && count(value.now);
    case "snapshot.begin-streaming":
      return exact(value, ["type", "requestId", "lease", "responseRequestId"]) &&
        validStreamingLease(value.lease) && responseRequestId(value.responseRequestId);
    case "snapshot.read-streaming-page":
      return exact(value, ["type", "requestId", "lease", "responseRequestId", "afterPage"]) &&
        validStreamingLease(value.lease) && responseRequestId(value.responseRequestId) &&
        text(value.lease.checksum) && count(value.afterPage);
    case "snapshot.release-streaming":
      return exact(value, ["type", "requestId", "snapshotId"]) && text(value.snapshotId);
    case "snapshot.invalidate":
      return exact(value, ["type", "requestId", "snapshotId"]) && text(value.snapshotId);
    case "snapshot.invalidate-room":
      return exact(value, [
        "type", "requestId", "roomId", "accessRevision",
        ...(Object.hasOwn(value, "targetActorId") ? ["targetActorId"] : []),
      ]) && text(value.roomId) && count(value.accessRevision) &&
        (!Object.hasOwn(value, "targetActorId") || text(value.targetActorId));
    default:
      return false;
  }
}

function requestIdFrom(value: unknown): string {
  return isRecord(value) && text(value.requestId) ? value.requestId : "invalid";
}

function isWorkerData(value: unknown): value is SnapshotWorkerData {
  if (!isRecord(value) || !text(value.authorityPath) || !text(value.cachePath) ||
      !isRecord(value.limits)) return false;
  const limits = value.limits;
  return ["maxConcurrentBuilds", "queueLimit", "scanBatchSize", "ttlMs",
    "reuseMinRemainingMs", "cacheQuotaBytes", "buildDeadlineMs",
    "maxWalGrowthBytes", "maxRecordsPerPage", "maxPageBytes"]
    .every((key) => typeof limits[key] === "number" && Number.isSafeInteger(limits[key]) &&
      (limits[key] as number) > 0) &&
    (value.pauseState === undefined || value.pauseState instanceof SharedArrayBuffer);
}

if (parentPort === null) throw new Error("SnapshotWorker must run in a worker thread");
if (!isWorkerData(workerData)) throw new Error("Invalid snapshot worker data");

const port = parentPort;
const data = workerData;
let cache: DatabaseSync | undefined;
let initialized = false;
let closed = false;
const requests: unknown[] = [];
let processing = false;
let fixedViewPauseAvailable = data.pauseState !== undefined;
let fullValidationCount = 0;
const streamingSnapshots = new Map<string, StreamingSnapshotState>();

function respond(response: SnapshotWorkerResponse): void {
  port.postMessage(response);
}

function error(requestId: string, code: SnapshotWorkerErrorCode, message: string): void {
  respond({ type: "snapshot.error", requestId, code, message });
}

function removeCacheFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${data.cachePath}${suffix}`, { force: true });
  }
}

function openCache(fullValidation: boolean): DatabaseSync {
  let opened: DatabaseSync | undefined;
  try {
    opened = new DatabaseSync(data.cachePath);
    configureSnapshotCacheConnection(opened);
    const version = readSchemaVersion(opened);
    if (fullValidation && version !== 0 && version !== SNAPSHOT_CACHE_SCHEMA_VERSION) {
      opened.close();
      opened = undefined;
      removeCacheFiles();
      opened = new DatabaseSync(data.cachePath);
      migrateSnapshotCacheDatabase(opened);
      return opened;
    }
    if (fullValidation) migrateSnapshotCacheDatabase(opened);
    else validateSnapshotCachePhysicalSchema(opened);
    return opened;
  } catch (cause: unknown) {
    try { opened?.close(); } catch { /* preserve cause */ }
    throw cause;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new TypeError("Unsupported canonical snapshot value");
}

function canonicalChecksum(kind: "room" | "catalog", values: readonly unknown[]): string {
  return createHash("sha256").update(canonicalJson({ kind, version: 1, values }), "utf8").digest("hex");
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function authorityWalSize(): number {
  return fileSize(`${data.authorityPath}-wal`);
}

function cacheAllocatedBytes(): number {
  if (cache === undefined) return 0;
  const pageCount = Number(cache.prepare("PRAGMA page_count").get()?.page_count);
  const freePages = Number(cache.prepare("PRAGMA freelist_count").get()?.freelist_count);
  const pageSize = Number(cache.prepare("PRAGMA page_size").get()?.page_size);
  if (![pageCount, freePages, pageSize].every(Number.isSafeInteger) ||
      pageCount < 0 || freePages < 0 || freePages > pageCount || pageSize <= 0) {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot cache allocation is corrupt");
  }
  return (pageCount - freePages) * pageSize;
}

function assertBuildSafety(startedAt: number, initialWalBytes: number): void {
  if (performance.now() - startedAt > data.limits.buildDeadlineMs) throw new SnapshotFallback("deadline");
  if (authorityWalSize() - initialWalBytes > data.limits.maxWalGrowthBytes) throw new SnapshotFallback("wal-growth");
}

function establishFixedView(authority: DatabaseSync): void {
  authority.exec("BEGIN DEFERRED");
  authority.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get();
  if (data.pauseState !== undefined && fixedViewPauseAvailable) {
    fixedViewPauseAvailable = false;
    const state = new Int32Array(data.pauseState);
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
    while (Atomics.load(state, 0) !== 2) Atomics.wait(state, 0, 1);
  }
}

function openAuthorityReadView(): DatabaseSync {
  const authority = new DatabaseSync(data.authorityPath, { readOnly: true });
  try {
    authority.exec("PRAGMA query_only = ON");
    const journal = authority.prepare("PRAGMA journal_mode").get()?.journal_mode;
    if (typeof journal !== "string" || journal.toLowerCase() !== "wal") {
      throw new SnapshotBuildError("storage_unavailable", "Authority database is not in WAL mode");
    }
    establishFixedView(authority);
    return authority;
  } catch (cause: unknown) {
    authority.close();
    throw cause;
  }
}

function openAuthorityPreflight(): DatabaseSync {
  const authority = new DatabaseSync(data.authorityPath, { readOnly: true });
  try {
    authority.exec("PRAGMA query_only = ON");
    const journal = authority.prepare("PRAGMA journal_mode").get()?.journal_mode;
    if (typeof journal !== "string" || journal.toLowerCase() !== "wal") {
      throw new SnapshotBuildError("storage_unavailable", "Authority database is not in WAL mode");
    }
    return authority;
  } catch (cause: unknown) {
    authority.close();
    throw cause;
  }
}

interface SessionRow {
  readonly familyId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly accessExpiresAt: number;
  readonly revokedAt: number | null;
}

function requireSession(authority: DatabaseSync, context: AuthenticatedSessionContext, now: number): void {
  const row = authority.prepare(
    `SELECT family_id AS familyId, account_id AS accountId, actor_id AS actorId,
            access_expires_at AS accessExpiresAt, revoked_at AS revokedAt
     FROM sessions WHERE access_token_hash = ?`,
  ).get(context.sessionId) as unknown as SessionRow | undefined;
  if (row === undefined) throw new SnapshotBuildError("invalid_token", "Snapshot token is invalid");
  if (row.familyId !== context.sessionFamilyId || row.accountId !== context.principal.accountId ||
      row.actorId !== context.principal.actorId) {
    throw new SnapshotBuildError("snapshot_forbidden", "Snapshot session family is forbidden");
  }
  if (row.revokedAt !== null) throw new SnapshotBuildError("session_revoked", "Snapshot session is revoked");
  if (now >= row.accessExpiresAt) throw new SnapshotBuildError("token_expired", "Snapshot token is expired");
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new SnapshotBuildError("storage_unavailable", "Snapshot JSON is corrupt");
  try { return JSON.parse(value) as unknown; } catch { throw new SnapshotBuildError("storage_unavailable", "Snapshot JSON is corrupt"); }
}

function canonicalLegacyExecution(row: Record<string, unknown>): LegacyAgentExecution {
  const startedAt = String(row.startedAt);
  const legacyStatus = row.status;
  const status = legacyStatus === "interrupted" ? "cancelled" : legacyStatus;
  if (status !== "queued" && status !== "running" && status !== "completed" && status !== "failed" && status !== "cancelled") {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot execution status is corrupt");
  }
  const completedAt = typeof row.completedAt === "string" ? row.completedAt : startedAt;
  const actionCategory = row.actionCategory === "model_generation" ||
    row.actionCategory === "waiting_upstream" || row.actionCategory === "tool_call"
    ? row.actionCategory : "tool_call";
  const toolDispatchPhase = row.toolDispatchPhase === "not_started" ||
    row.toolDispatchPhase === "dispatched" || row.toolDispatchPhase === "finished"
    ? row.toolDispatchPhase : status === "running" ? "dispatched" : "finished";
  const supersedesExecutionIds = row.supersedesExecutionIdsJson === null ||
    row.supersedesExecutionIdsJson === undefined
    ? undefined
    : parseJson(row.supersedesExecutionIdsJson);
  if (supersedesExecutionIds !== undefined &&
      (!Array.isArray(supersedesExecutionIds) || supersedesExecutionIds.length < 1 ||
       supersedesExecutionIds.length > 32 ||
       !supersedesExecutionIds.every((value) => typeof value === "string" && value.trim().length > 0) ||
       new Set(supersedesExecutionIds).size !== supersedesExecutionIds.length ||
       supersedesExecutionIds.includes(String(row.id)))) {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot execution supersession lineage is corrupt");
  }
  return {
    id: String(row.id),
    roomId: String(row.roomId),
    sourceMessageId: String(row.sourceMessageId),
    requesterId: String(row.requesterId),
    agentId: String(row.agentId),
    toolName: String(row.toolName),
    status,
    actionCategory,
    ...(actionCategory === "tool_call" ? { toolDispatchPhase } : {}),
    currentAttemptSeq: typeof row.currentAttemptSeq === "number" ? row.currentAttemptSeq : 1,
    retryCycle: typeof row.retryCycle === "number" ? row.retryCycle : 1,
    retryOrdinal: row.retryOrdinal === 2 || row.retryOrdinal === 3 ? row.retryOrdinal : 1,
    ...(typeof row.providerId === "string" ? { providerId: row.providerId } : {}),
    ...(typeof row.modelId === "string" ? { modelId: row.modelId } : {}),
    recoveryCursor: typeof row.recoveryCursor === "number" ? row.recoveryCursor : 0,
    queuedAt: typeof row.queuedAt === "string" ? row.queuedAt : startedAt,
    ...(status === "queued" ? {} : { startedAt }),
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : status === "running" ? startedAt : completedAt,
    ...(status === "running" ? {} : { completedAt }),
    ...(status === "cancelled" ? { cancellationReason: typeof row.cancellationReason === "string" ? row.cancellationReason : "legacy_interrupted" } : {}),
    ...(status === "failed" ? { terminalErrorCode: typeof row.terminalErrorCode === "string" ? row.terminalErrorCode : "legacy_failure" } : {}),
    ...(typeof row.deadLetteredAt === "string" ? { deadLetteredAt: row.deadLetteredAt } : {}),
    ...(typeof row.resultMessageId === "string" ? { resultMessageId: row.resultMessageId } : {}),
    ...(status === "queued" && typeof row.nextRetryAt === "string" ? { nextRetryAt: row.nextRetryAt } : {}),
    ...(typeof row.manualRetryOfExecutionId === "string" ? { manualRetryOfExecutionId: row.manualRetryOfExecutionId } : {}),
    ...(typeof row.compensatesExecutionId === "string" ? { compensatesExecutionId: row.compensatesExecutionId } : {}),
    ...(supersedesExecutionIds === undefined ? {} : { supersedesExecutionIds }),
  };
}

function* scanRows(
  authority: DatabaseSync,
  baseSql: string,
  parameter: string,
  keyColumn: string,
  keyField: string,
): Generator<Record<string, unknown>> {
  let lastKey: string | undefined;
  while (true) {
    const statement = authority.prepare(
      `${baseSql}${lastKey === undefined ? "" : ` AND ${keyColumn} > ?`}
       ORDER BY ${keyColumn} LIMIT ?`,
    );
    const rows = statement.all(parameter,
      ...(lastKey === undefined ? [] : [lastKey]), data.limits.scanBatchSize);
    for (const row of rows) yield row;
    if (rows.length < data.limits.scanBatchSize) return;
    const nextKey = rows.at(-1)?.[keyField];
    if (typeof nextKey !== "string") {
      throw new SnapshotBuildError("storage_unavailable", "Snapshot scan key is corrupt");
    }
    lastKey = nextKey;
  }
}

function* catalogRooms(
  authority: DatabaseSync,
  principalId: string,
  recordScanned: () => void,
): Generator<RoomSummary> {
  for (const row of scanRows(authority,
    `SELECT room.id AS roomId, room.name, room.status,
            CASE WHEN membership.actor_id = room.owner_actor_id
              THEN 'owner' ELSE membership.role END AS role
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.actor_id = ? AND membership.kind = 'human'`,
    principalId, "room.id", "roomId")) {
    yield roomSummary(row);
    recordScanned();
  }
}

function roomSummary(row: Record<string, unknown>): RoomSummary {
  if (typeof row.roomId !== "string" || typeof row.name !== "string" ||
      (row.status !== "active" && row.status !== "archived") ||
      (row.role !== "owner" && row.role !== "admin" && row.role !== "member")) {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot room summary is corrupt");
  }
  return {
    roomId: row.roomId,
    name: row.name,
    status: row.status,
    role: row.role,
  };
}

function streamingValues(
  authority: DatabaseSync,
  lease: StreamingRepairLease,
): Iterable<RoomRepairRecord | RoomSummary> {
  return lease.scope.kind === "room"
    ? registeredRoomRecords(
        authority,
        lease.scope.roomId,
        lease.principalId,
        lease.version.kind === "room" ? lease.version.watermark : 0,
        () => undefined,
      )
    : catalogRooms(authority, lease.scope.principalId, () => undefined);
}

interface StreamingCursor {
  readonly segment: number;
  readonly key?: string;
}

interface StreamingSnapshotState {
  readonly manifest: StreamingSnapshotManifest;
  /** One read-only WAL snapshot is retained until the bounded streaming lease is released. */
  readonly authority: DatabaseSync;
  cursor: StreamingCursor | undefined;
  lastServedPage: number;
  replayPage?: {
    readonly page: number;
    readonly values: readonly (RoomRepairRecord | RoomSummary)[];
  };
}

function keysetRows(
  authority: DatabaseSync,
  baseSql: string,
  parameters: readonly string[],
  keyColumn: string,
  lastKey: string | undefined,
  limit: number,
  trackStreamingScan = false,
): readonly Record<string, unknown>[] {
  const statement = authority.prepare(
    `${baseSql}${lastKey === undefined ? "" : ` AND ${keyColumn} > ?`}
     ORDER BY ${keyColumn} LIMIT ?`,
  );
  const rows = statement.all(...parameters, ...(lastKey === undefined ? [] : [lastKey]), limit);
  if (trackStreamingScan && data.pauseState !== undefined) {
    Atomics.add(new Int32Array(data.pauseState), 1, rows.length);
  }
  return rows;
}

function membershipRecord(row: Record<string, unknown>): RoomRepairRecord {
  if (row.kind === "human" && typeof row.actorId === "string" &&
      (row.role === "owner" || row.role === "admin" || row.role === "member") &&
      typeof row.joinedAt === "string") {
    return { kind: "membership", value: { kind: "human", actorId: row.actorId,
      role: row.role, joinedAt: row.joinedAt }};
  }
  if (row.kind === "agent" && typeof row.actorId === "string" &&
      (row.participation === "active" || row.participation === "on-mention") &&
      typeof row.configuredAt === "string") {
    const permissions = parseJson(row.toolPermissionsJson);
    if (Array.isArray(permissions) && permissions.length > 0 && permissions.every(text)) {
      return { kind: "membership", value: { kind: "agent", actorId: row.actorId,
        participation: row.participation, toolPermissions: permissions,
        configuredAt: row.configuredAt }};
    }
  }
  throw new SnapshotBuildError("storage_unavailable", "Snapshot membership is corrupt");
}

function routeJobRecord(row: Record<string, unknown>): RoomRepairRecord {
  const value = {
    id: row.id,
    roomId: row.roomId,
    sourceMessageId: row.sourceMessageId,
    status: row.status,
    currentAttempt: row.currentAttempt,
    topicKey: row.topicKey,
    embeddingModelVersion: row.embeddingModelVersion,
    windowSize: row.windowSize,
    cosineThreshold: row.cosineThreshold,
    roomPhase: row.roomPhase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
    ...(typeof row.terminalErrorCode === "string" ? { terminalErrorCode: row.terminalErrorCode } : {}),
    ...(typeof row.nextRetryAt === "string" ? { nextRetryAt: row.nextRetryAt } : {}),
  };
  if (!isRouteJob(value)) throw new SnapshotBuildError("storage_unavailable", "Snapshot route job is corrupt");
  return { kind: "route-job", value };
}

function routeJudgmentRecord(row: Record<string, unknown>): RoomRepairRecord {
  const value = {
    id: row.id,
    routeJobId: row.routeJobId,
    sourceMessageId: row.sourceMessageId,
    agentId: row.agentId,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    routeAttempt: row.routeAttempt,
    decidedAt: row.decidedAt,
  };
  if (!isRouteJudgment(value)) throw new SnapshotBuildError("storage_unavailable", "Snapshot route judgment is corrupt");
  return { kind: "route-judgment", value };
}

function calibrationRecord(row: Record<string, unknown>): RoomRepairRecord {
  const common = {
    id: String(row.id),
    agentId: String(row.agentId),
    createdAt: String(row.createdAt),
  };
  if (row.sourceMessageId === null && row.actorId === null) {
    if (row.signal !== "👍" && row.signal !== "👎") {
      throw new SnapshotBuildError("storage_unavailable", "Legacy calibration signal is corrupt");
    }
    return { kind: "legacy-unknown-calibration", value: {
      ...common, sourceMessageId: null, actorId: null, emoji: row.signal,
    }};
  }
  if (typeof row.sourceMessageId !== "string" || typeof row.actorId !== "string") {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot calibration is corrupt");
  }
  const value = {
    ...common,
    sourceMessageId: row.sourceMessageId,
    actorId: row.actorId,
    ...(row.signal === "👍" || row.signal === "👎"
      ? { emoji: row.signal }
      : { feedback: row.signal }),
  };
  if (!isCalibrationSignal(value)) {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot calibration signal is corrupt");
  }
  return { kind: "calibration", value };
}

function lightTaskRecord(row: Record<string, unknown>): RoomRepairRecord {
  const criteria = parseJson(row.criteriaJson);
  const task = {
    id: row.id,
    roomId: row.roomId,
    sourceMessageId: row.sourceMessageId,
    title: row.title,
    claimant: row.claimant,
    claimantRoleAtClaim: row.claimantRoleAtClaim,
    verifierRole: row.verifierRole,
    verifierActorId: row.verifierActorId,
    criteria,
    status: row.status,
    createdAt: row.createdAt,
    ...(typeof row.claimedAt === "string" ? { claimedAt: row.claimedAt } : {}),
    ...(typeof row.deliveredAt === "string" ? { deliveredAt: row.deliveredAt } : {}),
    ...(typeof row.verifiedAt === "string" ? { verifiedAt: row.verifiedAt } : {}),
  };
  if (!isLightTask(task)) {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot light task is corrupt");
  }
  return { kind: "light-task", value: task };
}

function toolSafetyRepairRecord(kind: "tool-call" | "tool-confirmation" | "tool-grant" |
  "tool-dispatch" | "tool-review" | "tool-handoff" | "tool-compensation",
  row: Record<string, unknown>): RoomRepairRecord {
  const record = { kind, value: row };
  if (!isPublicToolSafetyRepairRecord(record)) {
    throw new SnapshotBuildError("storage_unavailable", "Tool safety repair record is corrupt");
  }
  return record as RoomRepairRecord;
}

type RoomRepairKind = RoomRepairRecord["kind"];

const ROOM_REPAIR_KIND_MAP = Object.freeze({
  room: true,
  governance: true,
  membership: true,
  "room-agent-assignment": true,
  message: true,
  "timeline-message": true,
  "message-revision": true,
  attachment: true,
  "human-read": true,
  "agent-judgement": true,
  "open-item": true,
  "open-item-agent-failure": true,
  "light-task": true,
  "agent-invocation-intent": true,
  "agent-execution": true,
  "agent-execution-attempt": true,
  "agent-execution-retry": true,
  "agent-scoped-cancellation": true,
  "project-boundary-invocation": true,
  "legacy-agent-execution": true,
  "route-job": true,
  "route-judgment": true,
  calibration: true,
  "legacy-unknown-calibration": true,
  memory: true,
  "project-loop": true,
  "tool-call": true,
  "tool-confirmation": true,
  "tool-grant": true,
  "tool-dispatch": true,
  "tool-review": true,
  "tool-handoff": true,
  "tool-compensation": true,
  notification: true,
} as const satisfies Readonly<Record<RoomRepairKind, true>>);

const ROOM_REPAIR_KINDS = Object.freeze(
  Object.keys(ROOM_REPAIR_KIND_MAP) as RoomRepairKind[],
);

function singleRoomMetadataRow(input: RepairKeysetPageInput): readonly Record<string, unknown>[] {
  if (input.afterKey !== undefined) return [];
  const row = input.database.prepare(
    `SELECT id, name, status, created_at AS createdAt, owner_actor_id AS ownerActorId,
            governance_revision AS governanceRevision,
            archive_generation AS archiveGeneration, archived_at AS archivedAt
     FROM rooms WHERE id = ?`,
  ).get(input.roomId);
  const rows = row === undefined ? [] : [row];
  return rows;
}

function roomMetadataRecord(row: unknown): RoomRepairRecord {
  if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string" ||
      (row.status !== "active" && row.status !== "archived") ||
      typeof row.createdAt !== "string") {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot room metadata is corrupt");
  }
  return { kind: "room", value: {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt,
  }};
}

function humanReadRecord(roomId: string, row: Record<string, unknown>): RoomRepairRecord {
  if (typeof row.actorId !== "string" || typeof row.messageId !== "string" ||
      typeof row.readAt !== "string") {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot receipt is corrupt");
  }
  return { kind: "human-read", value: {
    id: `human-read:${roomId}:${row.actorId}`,
    messageId: row.messageId,
    readerId: row.actorId,
    readAt: row.readAt,
  }};
}

function messageRevisionRecord(row: Record<string, unknown>): RoomRepairRecord {
  const record = {
    kind: "message-revision",
    roomId: row.roomId,
    value: {
      messageId: row.messageId,
      revision: row.revision,
      body: row.body,
      revisedAt: row.revisedAt,
      revisedByActorId: row.revisedByActorId,
    },
  };
  if (!isMessageAuthorityRepairRecord(record)) {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot message revision is corrupt");
  }
  return record;
}

function extractionMethodForRepair(
  format: unknown,
  artifactMethod: unknown,
): "plain-text" | "csv-text" | "office-xml" | "pdf-text" | "ocr" | undefined {
  if (artifactMethod === "ocr-text") return "ocr";
  if (format === "txt") return "plain-text";
  if (format === "csv") return "csv-text";
  if (format === "docx" || format === "xlsx") return "office-xml";
  if (format === "pdf" && artifactMethod === "extracted-text") return "pdf-text";
  return undefined;
}

function extractionToolForRepair(
  method: ReturnType<typeof extractionMethodForRepair>,
): "builtin" | "bounded-zip" | "pdftotext" | "tesseract" | undefined {
  if (method === "plain-text" || method === "csv-text") return "builtin";
  if (method === "office-xml") return "bounded-zip";
  if (method === "pdf-text") return "pdftotext";
  if (method === "ocr") return "tesseract";
  return undefined;
}

function attachmentRepairRecord(row: Record<string, unknown>): RoomRepairRecord {
  const method = extractionMethodForRepair(row.format, row.artifactMethod);
  const tool = extractionToolForRepair(method);
  const pageCount = typeof row.pageEnd === "number" ? row.pageEnd : null;
  const record = {
    kind: "attachment",
    value: {
      attachment: {
        attachmentId: row.attachmentId,
        roomId: row.roomId,
        originalFilename: row.originalFilename,
        format: row.format,
        declaredMime: row.declaredMime,
        detectedMime: row.detectedMime,
        byteSize: row.byteSize,
        sha256: row.sha256,
        uploaderActorId: row.uploaderActorId,
        createdAt: row.createdAt,
        readyAt: row.readyAt,
        processingStatus: "ready",
        generation: row.generation,
        sourceMessageId: row.sourceMessageId,
        provenance: {
          scanner: { kind: "clamav", version: row.scannerVersion },
          extraction: {
            method,
            tool,
            version: row.artifactToolVersion,
            artifactSha256: row.artifactSha256,
            artifactByteSize: row.artifactByteSize,
            pageCount,
          },
          ocr: method === "ocr"
            ? { kind: "tesseract", version: row.artifactToolVersion, pageCount }
            : null,
        },
      },
      sourceEligibility: "bound-active",
    },
  };
  if (!isAttachmentRepairRecord(record)) {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot attachment is corrupt");
  }
  return record;
}

function openItemRecord(row: Record<string, unknown>): RoomRepairRecord {
  return { kind: "open-item", value: {
    id: String(row.id), roomId: String(row.roomId), sourceMessageId: String(row.sourceMessageId),
    requesterId: String(row.requesterId),
    currentOwnerId: row.currentOwnerId === null ? null : String(row.currentOwnerId),
    content: String(row.content), status: row.status as OpenItem["status"],
    origin: row.originKind === "agent_proposal" ? {
      kind: "agent_proposal", proposalKind: String(row.proposalKind) as "risk" | "challenge",
      sourceExecutionId: String(row.sourceExecutionId), reason: String(row.proposalReason),
    } : { kind: String(row.originKind) as "human_mention" | "manual_unfinished" },
    createdAt: String(row.createdAt),
    ...(typeof row.respondedAt === "string" ? { respondedAt: row.respondedAt } : {}),
    transferChain: parseJson(row.transferChainJson) as [],
  }};
}

function openItemFailureRecord(row: Record<string, unknown>): RoomRepairRecord {
  return { kind: "open-item-agent-failure", value: {
    id: String(row.id), openItemId: String(row.openItemId),
    executionId: String(row.executionId), attemptSeq: Number(row.attemptSeq),
    reasonCode: String(row.reasonCode), failedAt: String(row.failedAt),
  }};
}

function roomSegmentRows(
  input: RepairKeysetPageInput,
  baseSql: string,
  keyColumn: string,
): readonly Record<string, unknown>[] {
  return keysetRows(
    input.database,
    baseSql,
    [input.roomId],
    keyColumn,
    input.afterKey,
    input.limit,
  );
}

function invocationIntentRepairRecord(row: Record<string, unknown>): RoomRepairRecord {
  const value = {
    intentId: String(row.intentId),
    lineageId: String(row.lineageId),
    turnId: String(row.turnId),
    roomId: String(row.roomId),
    sourceMessageId: String(row.sourceMessageId),
    sourceRevision: Number(row.sourceRevision),
    targetId: String(row.targetId),
    agentId: String(row.agentId),
    origin: {
      kind: "message_target" as const,
      messageTransactionId: String(row.messageTransactionId),
      targetId: String(row.targetId),
    },
    profileRevision: Number(row.profileRevision),
    assignmentRevision: Number(row.assignmentRevision),
    accessRevision: Number(row.accessRevision),
    status: row.status,
    createdAt: String(row.createdAt),
    ...(typeof row.claimedAt === "string" ? { claimedAt: row.claimedAt } : {}),
    ...(typeof row.cancelledAt === "string" ? { cancelledAt: row.cancelledAt } : {}),
    ...(typeof row.cancellationReason === "string" ? { cancellationReason: row.cancellationReason } : {}),
    ...(typeof row.supersedesIntentId === "string" ? { supersedesIntentId: row.supersedesIntentId } : {}),
  };
  if (!isAgentInvocationIntent(value)) {
    throw new SnapshotBuildError("storage_unavailable", "Invocation intent repair projection is corrupt");
  }
  return { kind: "agent-invocation-intent", value };
}

function canonicalExecutionRepairRecord(row: Record<string, unknown>): RoomRepairRecord {
  const status = row.status;
  const startedAt = typeof row.startedAt === "string" ? row.startedAt : String(row.updatedAt);
  const value = {
    executionId: String(row.executionId), intentId: String(row.intentId),
    lineageId: String(row.lineageId), executionOrdinal: Number(row.executionOrdinal),
    ...(typeof row.retryOfExecutionId === "string" ? { retryOfExecutionId: row.retryOfExecutionId } : {}),
    roomId: String(row.roomId), agentId: String(row.agentId), snapshotId: String(row.snapshotId),
    providerId: String(row.providerId), modelId: String(row.modelId), status,
    phase: row.phase, currentAttemptSeq: Number(row.currentAttemptSeq), version: Number(row.version),
    queuedAt: String(row.queuedAt), ...(status === "accepted" ? {} : { startedAt }),
    updatedAt: String(row.updatedAt),
    ...((status === "completed" || status === "failed" || status === "cancelled")
      ? { completedAt: String(row.completedAt) } : {}),
    ...(status === "cancelled" ? { cancellationReason: row.terminalReason } : {}),
    ...(status === "failed" ? {
      terminalErrorCode: row.terminalErrorCode,
      reviewState: row.reviewState === "needs_review"
        ? row.unresolvedReview === 1 ? "needs_review" as const : "reviewed" as const
        : "not_required" as const,
    } : {}),
    ...(typeof row.deadLetteredAt === "string" ? { deadLetteredAt: row.deadLetteredAt } : {}),
    ...(typeof row.resultMessageId === "string" ? { resultMessageId: row.resultMessageId } : {}),
  };
  if (!isAgentExecution(value)) {
    throw new SnapshotBuildError("storage_unavailable", "Invocation execution repair projection is corrupt");
  }
  return { kind: "agent-execution", value };
}

function canonicalAttemptRepairRecord(row: Record<string, unknown>): RoomRepairRecord {
  const status = row.status;
  const value = {
    executionId: String(row.executionId), intentId: String(row.intentId),
    lineageId: String(row.lineageId), roomId: String(row.roomId), agentId: String(row.agentId),
    attemptSeq: Number(row.attemptSeq), snapshotId: String(row.snapshotId),
    providerId: String(row.providerId), modelId: String(row.modelId), status, phase: row.phase,
    executionVersion: Number(row.executionVersion),
    ...(status === "accepted" ? {} : { startedAt: String(row.startedAt ?? row.updatedAt) }),
    updatedAt: String(row.updatedAt),
    ...((status === "completed" || status === "failed" || status === "cancelled")
      ? { finishedAt: String(row.finishedAt ?? row.updatedAt) } : {}),
    ...(status === "failed" && typeof row.errorCode === "string" ? { errorCode: row.errorCode } : {}),
    ...(status === "failed" && typeof row.nextRetryAt === "string" ? { nextRetryAt: row.nextRetryAt } : {}),
  };
  if (!isAgentExecutionAttempt(value)) {
    throw new SnapshotBuildError("storage_unavailable", "Invocation attempt repair projection is corrupt");
  }
  return { kind: "agent-execution-attempt", value };
}

function retryRepairRecord(row: Record<string, unknown>): RoomRepairRecord {
  const value = {
    requestId: String(row.requestId), sourceExecutionId: String(row.sourceExecutionId),
    executionId: String(row.executionId), intentId: String(row.intentId),
    lineageId: String(row.lineageId), roomId: String(row.roomId),
    executionOrdinal: Number(row.executionOrdinal), snapshotId: String(row.snapshotId),
    status: "accepted" as const, createdAt: String(row.createdAt),
  };
  if (!isAgentExecutionRetryReceipt(value)) {
    throw new SnapshotBuildError("storage_unavailable", "Invocation retry repair projection is corrupt");
  }
  return { kind: "agent-execution-retry", value };
}

function cancellationRepairRecord(row: Record<string, unknown>): RoomRepairRecord {
  const stored = parseJson(row.responseJson);
  const value = isRecord(stored) ? stored.receipt : undefined;
  if (!isScopedCancellationReceipt(value)) {
    throw new SnapshotBuildError("storage_unavailable", "Scoped cancellation repair projection is corrupt");
  }
  return { kind: "agent-scoped-cancellation", value };
}

function projectBoundaryRepairRecord(row: Record<string, unknown>): RoomRepairRecord {
  const value = row.recordKind === "execution"
    ? { boundaryId: String(row.boundaryId), roomId: String(row.roomId),
        status: "execution-state" as const, intentId: String(row.intentId),
        executionId: String(row.executionId), agentId: String(row.agentId),
        executionStatus: row.executionStatus,
        occurredAt: String(row.recordedAt) }
    : row.status === "consumed"
    ? { boundaryId: String(row.boundaryId), roomId: String(row.roomId), status: "intent-created" as const,
        intentId: String(row.intentId), consumedAt: String(row.recordedAt) }
    : { boundaryId: String(row.boundaryId), roomId: String(row.roomId), status: "suppressed" as const,
        reason: row.status === "dependency_unavailable" ? "dependency_unavailable" as const : "boundary_ineligible" as const,
        decidedAt: String(row.recordedAt) };
  if (!isProjectBoundaryInvocationResult(value)) {
    throw new SnapshotBuildError("storage_unavailable", "Project boundary repair projection is corrupt");
  }
  return { kind: "project-boundary-invocation", value };
}

const ROOM_REPAIR_DESCRIPTORS = Object.freeze([
  {
    descriptorId: "dao.repair.room.v1", descriptorVersion: 1, kind: "room", order: 0,
    readKeysetPage: singleRoomMetadataRow,
    mapRow: roomMetadataRecord,
    stableKey: (record: RoomRepairRecord) => String(record.kind === "room" ? record.value.id : ""),
  },
  lifecycleRepairSegmentDescriptor,
  {
    descriptorId: "dao.repair.membership.v1", descriptorVersion: 1, kind: "membership", order: 2,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT membership.actor_id AS actorId, membership.kind,
              CASE WHEN membership.actor_id = room.owner_actor_id
                THEN 'owner' ELSE membership.role END AS role, membership.participation,
              membership.tool_permissions_json AS toolPermissionsJson,
              membership.joined_at AS joinedAt, membership.configured_at AS configuredAt
       FROM room_memberships AS membership
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE membership.room_id = ?`, "membership.actor_id"),
    mapRow: (row: unknown) => membershipRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "membership" ? record.value.actorId : ""),
  },
  createRoomAssignmentRepairSegmentDescriptor(
    data.deploymentProviderCredentialReadiness ?? "noauth",
  ),
  {
    descriptorId: "dao.repair.timeline-message.v1", descriptorVersion: 1,
    kind: "timeline-message", order: 3,
    readKeysetPage: (input: RepairKeysetPageInput) => readOperationalMessageRepairPage(
      input.database,
      { roomId: input.roomId, afterMessageId: input.afterKey, limit: input.limit },
    ),
    mapRow: (row: unknown) => row as Extract<RoomRepairRecord, {
      readonly kind: "timeline-message";
    }>,
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "timeline-message" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.message-revision.v1", descriptorVersion: 1,
    kind: "message-revision", order: 4,
    readKeysetPage: (input: RepairKeysetPageInput) => keysetRows(input.database,
      `SELECT room_id AS roomId, message_id AS messageId, revision, body,
              revised_at AS revisedAt, revised_by_actor_id AS revisedByActorId,
              stable_key AS stableKey
       FROM (
         SELECT envelope.room_id, revision.message_id, revision.revision, revision.body,
                revision.revised_at, revision.revised_by_actor_id,
                printf('%s:%020d', revision.message_id, revision.revision) AS stable_key
         FROM message_revisions AS revision
         JOIN message_envelopes AS envelope
           ON envelope.message_id = revision.message_id
         WHERE envelope.room_id = ? AND envelope.lifecycle = 'active'
           AND envelope.message_kind = 'human'
           AND revision.revision <= envelope.current_revision
       ) WHERE 1 = 1`, [input.roomId], "stable_key", input.afterKey, input.limit),
    mapRow: (row: unknown) => messageRevisionRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => record.kind === "message-revision"
      ? `${record.value.messageId}:${String(record.value.revision).padStart(20, "0")}`
      : "",
  },
  {
    descriptorId: "dao.repair.attachment.v1", descriptorVersion: 1,
    kind: "attachment", order: 5,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT attachment.attachment_id AS attachmentId,
              attachment.room_id AS roomId,
              attachment.original_filename AS originalFilename,
              attachment.format, attachment.declared_mime AS declaredMime,
              attachment.detected_mime AS detectedMime,
              attachment.byte_size AS byteSize, attachment.sha256,
              attachment.uploader_actor_id AS uploaderActorId,
              attachment.created_at AS createdAt, attachment.ready_at AS readyAt,
              attachment.processing_generation AS generation,
              attachment.source_message_id AS sourceMessageId,
              artifact.method AS artifactMethod,
              artifact.tool_version AS artifactToolVersion,
              artifact.sha256 AS artifactSha256,
              artifact.byte_size AS artifactByteSize,
              artifact.page_end AS pageEnd,
              (
                SELECT attempt.adapter_version
                FROM attachment_processing_attempts AS attempt
                WHERE attempt.attachment_id = attachment.attachment_id
                  AND attempt.processing_generation = attachment.processing_generation
                  AND attempt.adapter_kind = 'scanner' AND attempt.status = 'succeeded'
                ORDER BY attempt.attempt_number DESC LIMIT 1
              ) AS scannerVersion
       FROM attachments AS attachment
       JOIN attachment_extraction_artifacts AS artifact
         ON artifact.artifact_id = (
           SELECT candidate.artifact_id
           FROM attachment_extraction_artifacts AS candidate
           WHERE candidate.attachment_id = attachment.attachment_id
             AND candidate.processing_generation = attachment.processing_generation
           ORDER BY candidate.artifact_id LIMIT 1
         )
       JOIN message_envelopes AS envelope
         ON envelope.message_id = attachment.source_message_id
        AND envelope.room_id = attachment.room_id
       WHERE attachment.room_id = ? AND attachment.processing_status = 'ready'
         AND attachment.source_operational_state = 'bound-active'
         AND envelope.lifecycle = 'active'`, "attachment.attachment_id"),
    mapRow: (row: unknown) => attachmentRepairRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => record.kind === "attachment"
      ? record.value.attachment.attachmentId
      : "",
  },
  {
    descriptorId: "dao.repair.human-read.v1", descriptorVersion: 1, kind: "human-read", order: 6,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT room_id AS roomId, actor_id AS actorId, message_id AS messageId, read_at AS readAt
       FROM human_read_receipts WHERE room_id = ?`, "actor_id"),
    mapRow: (row: unknown) => {
      const record = row as Record<string, unknown>;
      return humanReadRecord(String(record.roomId ?? ""), record);
    },
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "human-read" ? record.value.readerId : ""),
  },
  {
    descriptorId: "dao.repair.agent-judgement.v1", descriptorVersion: 1,
    kind: "agent-judgement", order: 7,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      "SELECT id, judgment_json AS json FROM agent_judgments WHERE room_id = ?", "id"),
    mapRow: (row: unknown) => ({
      kind: "agent-judgement",
      value: parseJson((row as Record<string, unknown>).json) as RoomRepairRecord & never,
    }),
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "agent-judgement" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.open-item.v1", descriptorVersion: 1, kind: "open-item", order: 8,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
              requester_actor_id AS requesterId, current_owner_actor_id AS currentOwnerId,
              body AS content, status, created_at AS createdAt,
              responded_at AS respondedAt, transfer_chain_json AS transferChainJson,
              origin_kind AS originKind, proposal_kind AS proposalKind,
              source_execution_id AS sourceExecutionId, proposal_reason AS proposalReason
       FROM open_items WHERE room_id = ?`, "id"),
    mapRow: (row: unknown) => openItemRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => String(record.kind === "open-item" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.open-item-agent-failure.v1", descriptorVersion: 1,
    kind: "open-item-agent-failure", order: 9,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT failure.id, failure.open_item_id AS openItemId,
              failure.execution_id AS executionId, failure.attempt_seq AS attemptSeq,
              failure.reason_code AS reasonCode, failure.failed_at AS failedAt
       FROM open_item_agent_failures AS failure
       JOIN open_items AS item ON item.id = failure.open_item_id
       WHERE item.room_id = ?`, "failure.id"),
    mapRow: (row: unknown) => openItemFailureRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "open-item-agent-failure" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.light-task.v1", descriptorVersion: 1, kind: "light-task", order: 10,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId, title,
              claimant_actor_id AS claimant, claimant_role_at_claim AS claimantRoleAtClaim,
              verifier_role AS verifierRole, verifier_actor_id AS verifierActorId,
              criteria_json AS criteriaJson, status, created_at AS createdAt,
              claimed_at AS claimedAt, delivered_at AS deliveredAt, verified_at AS verifiedAt
       FROM light_tasks WHERE room_id = ?`, "id"),
    mapRow: (row: unknown) => lightTaskRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => String(record.kind === "light-task" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.agent-invocation-intent.v1", descriptorVersion: 1,
    kind: "agent-invocation-intent", order: 100,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT intent.id AS intentId, intent.lineage_id AS lineageId, intent.turn_id AS turnId,
              intent.room_id AS roomId, intent.source_message_id AS sourceMessageId,
              intent.source_revision AS sourceRevision, intent.target_id AS targetId,
              intent.target_agent_id AS agentId, intent.message_transaction_id AS messageTransactionId,
              binding.profile_revision AS profileRevision,
              binding.assignment_revision AS assignmentRevision,
              binding.access_revision AS accessRevision,
              runtime.public_status AS status,
              intent.created_at AS createdAt, runtime.claimed_at AS claimedAt,
              runtime.cancelled_at AS cancelledAt,
              runtime.cancellation_reason AS cancellationReason,
              intent.supersedes_intent_id AS supersedesIntentId
       FROM agent_invocation_intents AS intent
       JOIN agent_invocation_intent_runtime_states AS runtime
         ON runtime.intent_id = intent.id
       JOIN direct_agent_invocation_authority_bindings AS binding ON binding.intent_id = intent.id
       WHERE intent.room_id = ? AND intent.origin_kind = 'message_target'
         AND binding.access_revision > 0`, "intent.id"),
    mapRow: (row: unknown) => invocationIntentRepairRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => record.kind === "agent-invocation-intent"
      ? record.value.intentId : "",
  },
  {
    descriptorId: "dao.repair.agent-execution-canonical.v1", descriptorVersion: 1,
    kind: "agent-execution", order: 101,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT runtime.execution_id AS executionId, runtime.intent_id AS intentId,
              runtime.lineage_id AS lineageId, runtime.execution_ordinal AS executionOrdinal,
              runtime.retry_of_execution_id AS retryOfExecutionId, execution.room_id AS roomId,
              execution.agent_id AS agentId, runtime.snapshot_id AS snapshotId,
              runtime.provider_id AS providerId, runtime.model_id AS modelId,
              runtime.public_status AS status, runtime.phase,
              runtime.current_attempt_seq AS currentAttemptSeq,
              runtime.authority_version AS version, runtime.queued_at AS queuedAt,
              runtime.started_at AS startedAt, runtime.updated_at AS updatedAt,
              runtime.completed_at AS completedAt, runtime.terminal_reason AS terminalReason,
              runtime.terminal_error_code AS terminalErrorCode, runtime.review_state AS reviewState,
              execution.dead_lettered_at AS deadLetteredAt,
              execution.result_message_id AS resultMessageId,
              EXISTS (
                SELECT 1 FROM tool_dispatches_v2 AS dispatch
                JOIN tool_calls_v2 AS call ON call.tool_call_id = dispatch.tool_call_id
                WHERE call.execution_id = runtime.execution_id
                  AND dispatch.state = 'outcome_unknown'
              ) AS unresolvedReview
       FROM agent_execution_runtime_states AS runtime
       JOIN agent_executions AS execution ON execution.id = runtime.execution_id
       WHERE execution.room_id = ? AND runtime.review_state <> 'legacy_review_required'`,
      "runtime.execution_id"),
    mapRow: (row: unknown) => canonicalExecutionRepairRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => record.kind === "agent-execution"
      ? record.value.executionId : "",
  },
  {
    descriptorId: "dao.repair.agent-execution-attempt.v1", descriptorVersion: 1,
    kind: "agent-execution-attempt", order: 102,
    readKeysetPage: (input: RepairKeysetPageInput) => keysetRows(input.database,
      `SELECT attempt.execution_id AS executionId, execution.intent_id AS intentId,
              execution.lineage_id AS lineageId, legacy.room_id AS roomId,
              legacy.agent_id AS agentId, attempt.attempt_seq AS attemptSeq,
              execution.snapshot_id AS snapshotId, execution.provider_id AS providerId,
              execution.model_id AS modelId, attempt.public_status AS status,
              attempt.phase, execution.authority_version AS executionVersion,
              attempt.started_at AS startedAt, execution.updated_at AS updatedAt,
              attempt.finished_at AS finishedAt, attempt.error_code AS errorCode,
              attempt.next_retry_at AS nextRetryAt,
              printf('%s:%020d', attempt.execution_id, attempt.attempt_seq) AS stable_key
       FROM agent_execution_attempt_runtime_states AS attempt
       JOIN agent_execution_runtime_states AS execution ON execution.execution_id = attempt.execution_id
       JOIN agent_executions AS legacy ON legacy.id = attempt.execution_id
       WHERE legacy.room_id = ? AND execution.review_state <> 'legacy_review_required'`,
      [input.roomId], "stable_key", input.afterKey, input.limit),
    mapRow: (row: unknown) => canonicalAttemptRepairRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => record.kind === "agent-execution-attempt"
      ? `${record.value.executionId}:${String(record.value.attemptSeq).padStart(20, "0")}` : "",
  },
  {
    descriptorId: "dao.repair.agent-execution-retry.v1", descriptorVersion: 1,
    kind: "agent-execution-retry", order: 103,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT receipt.request_id AS requestId,
              receipt.source_execution_id AS sourceExecutionId,
              receipt.child_execution_id AS executionId, receipt.intent_id AS intentId,
              runtime.lineage_id AS lineageId, execution.room_id AS roomId,
              receipt.execution_ordinal AS executionOrdinal,
              runtime.snapshot_id AS snapshotId, receipt.committed_at AS createdAt
       FROM invocation_human_retry_receipts AS receipt
       JOIN agent_execution_runtime_states AS runtime
         ON runtime.execution_id = receipt.child_execution_id
       JOIN agent_executions AS execution ON execution.id = receipt.child_execution_id
       WHERE execution.room_id = ?`, "receipt.request_id"),
    mapRow: (row: unknown) => retryRepairRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => record.kind === "agent-execution-retry"
      ? record.value.requestId : "",
  },
  {
    descriptorId: "dao.repair.agent-scoped-cancellation.v1", descriptorVersion: 1,
    kind: "agent-scoped-cancellation", order: 104,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT receipt.request_id AS requestId, receipt.response_json AS responseJson
       FROM invocation_cancellation_receipts AS receipt
       JOIN invocation_scoped_cancellation_fences AS fence ON fence.fence_id = receipt.fence_id
       WHERE fence.room_id = ?`, "receipt.request_id"),
    mapRow: (row: unknown) => cancellationRepairRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => record.kind === "agent-scoped-cancellation"
      ? record.value.requestId : "",
  },
  {
    descriptorId: "dao.repair.project-boundary-invocation.v1", descriptorVersion: 1,
    kind: "project-boundary-invocation", order: 105,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT boundaryId, roomId, recordKind, status, intentId, executionId,
              agentId, executionStatus, recordedAt
       FROM (
         SELECT intent.boundary_id AS boundaryId, intent.room_id AS roomId,
                'execution' AS recordKind, NULL AS status, intent.intent_id AS intentId,
                execution.execution_id AS executionId,
                intent.target_agent_actor_id AS agentId,
                execution.public_status AS executionStatus,
                execution.updated_at AS recordedAt
         FROM project_boundary_agent_invocation_intents AS intent
         JOIN project_boundary_agent_executions AS execution
           ON execution.intent_id = intent.intent_id
         UNION ALL
         SELECT receipt.boundary_id AS boundaryId, receipt.room_id AS roomId,
                'legacy' AS recordKind, receipt.status,
                receipt.invocation_intent_id AS intentId, NULL AS executionId,
                NULL AS agentId, NULL AS executionStatus, receipt.recorded_at AS recordedAt
         FROM project_boundary_invocation_receipts AS receipt
         WHERE NOT EXISTS (
           SELECT 1 FROM project_boundary_agent_invocation_intents AS intent
           WHERE intent.boundary_id = receipt.boundary_id
         )
       ) AS project_boundary_records WHERE roomId = ?`, "boundaryId"),
    mapRow: (row: unknown) => projectBoundaryRepairRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => record.kind === "project-boundary-invocation"
      ? record.value.boundaryId : "",
  },
  {
    descriptorId: "dao.repair.agent-execution.v1", descriptorVersion: 1,
    kind: "legacy-agent-execution", order: 11,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT id, room_id AS roomId, trigger_message_id AS sourceMessageId,
              requester_actor_id AS requesterId, agent_id AS agentId, tool_name AS toolName,
              status, started_at AS startedAt, completed_at AS completedAt,
              result_json AS resultJson, action_category AS actionCategory,
              tool_dispatch_phase AS toolDispatchPhase, current_attempt_seq AS currentAttemptSeq,
              retry_cycle AS retryCycle, retry_ordinal AS retryOrdinal,
              provider_id AS providerId, model_id AS modelId, recovery_cursor AS recoveryCursor,
              queued_at AS queuedAt, updated_at AS updatedAt,
              cancellation_reason AS cancellationReason, terminal_error_code AS terminalErrorCode,
              dead_lettered_at AS deadLetteredAt, result_message_id AS resultMessageId,
              next_retry_at AS nextRetryAt, manual_retry_of_execution_id AS manualRetryOfExecutionId,
              compensates_execution_id AS compensatesExecutionId,
              supersedes_execution_ids_json AS supersedesExecutionIdsJson
       FROM agent_executions WHERE room_id = ?`, "id"),
    mapRow: (row: unknown) => ({
      kind: "legacy-agent-execution",
      value: canonicalLegacyExecution(row as Record<string, unknown>),
    }),
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "legacy-agent-execution" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.route-job.v1", descriptorVersion: 1, kind: "route-job", order: 12,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId, status,
              current_attempt AS currentAttempt, topic_key AS topicKey,
              embedding_model_version AS embeddingModelVersion, window_size AS windowSize,
              cosine_threshold AS cosineThreshold, room_phase AS roomPhase,
              created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt,
              terminal_error_code AS terminalErrorCode, next_retry_at AS nextRetryAt
       FROM route_jobs WHERE room_id = ?`, "id"),
    mapRow: (row: unknown) => routeJobRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) => String(record.kind === "route-job" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.route-judgment.v1", descriptorVersion: 1,
    kind: "route-judgment", order: 13,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT judgment.id, judgment.route_job_id AS routeJobId,
              judgment.source_message_id AS sourceMessageId,
              judgment.agent_id AS agentId, judgment.outcome,
              judgment.reason_code AS reasonCode, judgment.reason_text AS reasonText,
              judgment.route_attempt AS routeAttempt, judgment.decided_at AS decidedAt
       FROM route_judgments AS judgment
       JOIN route_jobs AS route ON route.id = judgment.route_job_id
       WHERE route.room_id = ?`, "judgment.id"),
    mapRow: (row: unknown) => routeJudgmentRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "route-judgment" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.calibration.v1", descriptorVersion: 1, kind: "calibration", order: 14,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT id, source_message_id AS sourceMessageId, actor_id AS actorId,
              agent_id AS agentId, signal, created_at AS createdAt
       FROM calibration_signals
       WHERE room_id = ? AND NOT (source_message_id IS NULL AND actor_id IS NULL)`, "id"),
    mapRow: (row: unknown) => calibrationRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "calibration" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.legacy-unknown-calibration.v1", descriptorVersion: 1,
    kind: "legacy-unknown-calibration", order: 15,
    readKeysetPage: (input: RepairKeysetPageInput) => roomSegmentRows(input,
      `SELECT id, source_message_id AS sourceMessageId, actor_id AS actorId,
              agent_id AS agentId, signal, created_at AS createdAt
       FROM calibration_signals
       WHERE room_id = ? AND source_message_id IS NULL AND actor_id IS NULL`, "id"),
    mapRow: (row: unknown) => calibrationRecord(row as Record<string, unknown>),
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "legacy-unknown-calibration" ? record.value.id : ""),
  },
  {
    descriptorId: "dao.repair.message-deprecated.v1", descriptorVersion: 1,
    kind: "message", order: 16,
    readKeysetPage: () => [],
    mapRow: (): never => {
      throw new SnapshotBuildError(
        "storage_unavailable",
        "Deprecated message repair records cannot be materialized",
      );
    },
    stableKey: (record: RoomRepairRecord) =>
      String(record.kind === "message" ? record.value.id : ""),
  },
  memoryRepairSegmentDescriptor,
  createProjectLoopRepairSegmentDescriptor((database, input) => {
    const result = readProjectLoopRepairSnapshotDatabaseQuery(database, input);
    return { snapshot: result };
  }),
  {
    descriptorId: "dao.repair.tool-call.v1", descriptorVersion: 1,
    kind: "tool-call", order: 19,
    readKeysetPage: (input) => input.database.prepare(
      `SELECT call.tool_call_id AS toolCallId, call.tool_id AS toolId,
              call.safe_preview_json AS safePreview, 'prepared' AS state,
              call.current_version AS version,
              COALESCE(execution.trigger_message_id, call.execution_id) AS sourceRef
       FROM tool_calls_v2 AS call
       JOIN agent_executions AS execution ON execution.id = call.execution_id
       WHERE call.room_id = ? AND call.tool_call_id > ?
       ORDER BY call.tool_call_id LIMIT ?`,
    ).all(input.roomId, input.afterKey ?? "", input.limit),
    mapRow: (row) => toolSafetyRepairRecord("tool-call", row as Record<string, unknown>),
    stableKey: (record) => String(record.kind === "tool-call" ? record.value.toolCallId : ""),
  },
  {
    descriptorId: "dao.repair.tool-confirmation.v1", descriptorVersion: 1,
    kind: "tool-confirmation", order: 20,
    readKeysetPage: (input) => input.database.prepare(
      `SELECT confirmation.confirmation_id AS confirmationId,
              call.tool_call_id AS toolCallId, call.tool_id AS toolId,
              confirmation.state, call.safe_preview_json AS safePreview,
              confirmation.reason AS reasonCode, confirmation.expires_at AS expiresAt,
              confirmation.version,
              confirmation.principal_human_actor_id AS principalActorId,
              actor.display_name AS namedHumanDisplayRef,
              COALESCE(execution.trigger_message_id, call.execution_id) AS sourceRef
       FROM tool_confirmations_v2 AS confirmation
       JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
       JOIN agent_executions AS execution ON execution.id = call.execution_id
       JOIN actors AS actor ON actor.id = confirmation.principal_human_actor_id
       WHERE call.room_id = ? AND confirmation.confirmation_id > ?
       ORDER BY confirmation.confirmation_id LIMIT ?`,
    ).all(input.roomId, input.afterKey ?? "", input.limit),
    mapRow: (row) => toolSafetyRepairRecord("tool-confirmation", row as Record<string, unknown>),
    stableKey: (record) => String(record.kind === "tool-confirmation"
      ? record.value.confirmationId : ""),
  },
  {
    descriptorId: "dao.repair.tool-grant.v1", descriptorVersion: 1,
    kind: "tool-grant", order: 21,
    readKeysetPage: (input) => input.database.prepare(
      `SELECT grant.grant_id AS grantId, grant.tool_call_id AS toolCallId,
              grant.state, grant.reason AS reasonCode, grant.expires_at AS expiresAt,
              grant.version
       FROM tool_grants_v2 AS grant
       JOIN tool_calls_v2 AS call ON call.tool_call_id = grant.tool_call_id
       WHERE call.room_id = ? AND grant.grant_id > ?
       ORDER BY grant.grant_id LIMIT ?`,
    ).all(input.roomId, input.afterKey ?? "", input.limit),
    mapRow: (row) => toolSafetyRepairRecord("tool-grant", row as Record<string, unknown>),
    stableKey: (record) => String(record.kind === "tool-grant" ? record.value.grantId : ""),
  },
  {
    descriptorId: "dao.repair.tool-dispatch.v1", descriptorVersion: 1,
    kind: "tool-dispatch", order: 22,
    readKeysetPage: (input) => input.database.prepare(
      `SELECT dispatch.dispatch_id AS dispatchId,
              dispatch.tool_call_id AS toolCallId, dispatch.state,
              dispatch.reason AS reasonCode, dispatch.version
       FROM tool_dispatches_v2 AS dispatch
       JOIN tool_calls_v2 AS call ON call.tool_call_id = dispatch.tool_call_id
       WHERE call.room_id = ? AND dispatch.dispatch_id > ?
       ORDER BY dispatch.dispatch_id LIMIT ?`,
    ).all(input.roomId, input.afterKey ?? "", input.limit),
    mapRow: (row) => toolSafetyRepairRecord("tool-dispatch", row as Record<string, unknown>),
    stableKey: (record) => String(record.kind === "tool-dispatch" ? record.value.dispatchId : ""),
  },
  {
    descriptorId: "dao.repair.tool-review.v1", descriptorVersion: 1,
    kind: "tool-review", order: 23,
    readKeysetPage: (input) => input.database.prepare(
      `SELECT review.review_id AS reviewId, review.dispatch_id AS dispatchId,
              review.resolution, review.evidence_summary AS evidenceSummary,
              actor.display_name AS namedHumanDisplayRef,
              review.compensation_tool_call_id AS compensationToolCallId,
              review.version
       FROM tool_reviews_v2 AS review
       JOIN tool_dispatches_v2 AS dispatch ON dispatch.dispatch_id = review.dispatch_id
       JOIN tool_calls_v2 AS call ON call.tool_call_id = dispatch.tool_call_id
       JOIN actors AS actor ON actor.id = review.principal_human_actor_id
       WHERE call.room_id = ? AND review.review_id > ?
       ORDER BY review.review_id LIMIT ?`,
    ).all(input.roomId, input.afterKey ?? "", input.limit),
    mapRow: (row) => toolSafetyRepairRecord("tool-review", row as Record<string, unknown>),
    stableKey: (record) => String(record.kind === "tool-review" ? record.value.reviewId : ""),
  },
  {
    descriptorId: "dao.repair.tool-handoff.v1", descriptorVersion: 1,
    kind: "tool-handoff", order: 24,
    readKeysetPage: (input) => input.database.prepare(
      `SELECT handoff.handoff_id AS handoffId,
              handoff.confirmation_id AS confirmationId, handoff.state,
              handoff.to_principal_human_actor_id AS targetActorId,
              actor.display_name AS targetNamedHumanDisplayRef,
              CASE handoff.state WHEN 'offered' THEN 1 ELSE 2 END AS version
       FROM tool_confirmation_handoffs_v2 AS handoff
       JOIN tool_confirmations_v2 AS confirmation
         ON confirmation.confirmation_id = handoff.confirmation_id
       JOIN tool_calls_v2 AS call ON call.tool_call_id = confirmation.tool_call_id
       JOIN actors AS actor ON actor.id = handoff.to_principal_human_actor_id
       WHERE call.room_id = ? AND handoff.handoff_id > ?
       ORDER BY handoff.handoff_id LIMIT ?`,
    ).all(input.roomId, input.afterKey ?? "", input.limit),
    mapRow: (row) => toolSafetyRepairRecord("tool-handoff", row as Record<string, unknown>),
    stableKey: (record) => String(record.kind === "tool-handoff" ? record.value.handoffId : ""),
  },
  {
    descriptorId: "dao.repair.tool-compensation.v1", descriptorVersion: 1,
    kind: "tool-compensation", order: 25,
    readKeysetPage: (input) => input.database.prepare(
      `SELECT lineage.lineage_id AS lineageId,
              lineage.original_dispatch_id AS originalDispatchId,
              lineage.compensation_invocation_id AS compensationInvocationId,
              lineage.compensation_execution_id AS compensationExecutionId,
              lineage.compensation_tool_call_id AS compensationToolCallId,
              CASE
                WHEN dispatch.state IS NOT NULL THEN dispatch.state
                WHEN confirmation.state IN ('rejected','expired') THEN confirmation.state
                ELSE 'pending'
              END AS state,
              COALESCE(dispatch.version, confirmation.version, 1) AS version
       FROM tool_compensation_lineage_v2 AS lineage
       JOIN tool_calls_v2 AS call ON call.tool_call_id = lineage.compensation_tool_call_id
       LEFT JOIN tool_dispatches_v2 AS dispatch
         ON dispatch.tool_call_id = lineage.compensation_tool_call_id
       LEFT JOIN tool_confirmations_v2 AS confirmation
         ON confirmation.tool_call_id = lineage.compensation_tool_call_id
       WHERE call.room_id = ? AND lineage.lineage_id > ?
       ORDER BY lineage.lineage_id LIMIT ?`,
    ).all(input.roomId, input.afterKey ?? "", input.limit),
    mapRow: (row) => toolSafetyRepairRecord("tool-compensation", row as Record<string, unknown>),
    stableKey: (record) => String(record.kind === "tool-compensation"
      ? record.value.lineageId : ""),
  },
  {
    descriptorId: "dao.repair.notification.v1", descriptorVersion: 1,
    kind: "notification", order: 27,
    readKeysetPage: (input: RepairKeysetPageInput) => input.principalActorId === undefined
      ? []
      : readNotificationRepairPage(
          input.database,
          { recipientActorId: input.principalActorId, roomId: input.roomId,
            afterNotificationId: input.afterKey, limit: input.limit },
        ),
    mapRow: (row: unknown) => row as Extract<RoomRepairRecord, {
      readonly kind: "notification";
    }>,
    stableKey: (record) => String(record.kind === "notification"
      ? record.value.notificationId : ""),
  },
] as const satisfies readonly RoomRepairSegmentDescriptor<RoomRepairKind, RoomRepairRecord>[]);

const ROOM_REPAIR_REGISTRY = createGuardedClosedRepairProjectionRegistry<
  RoomRepairKind,
  RoomRepairRecord
>({
  knownKinds: ROOM_REPAIR_KINDS,
  descriptors: ROOM_REPAIR_DESCRIPTORS,
  recordGuard: (record, roomId): record is RoomRepairRecord => isRoomRepairPage({
    type: "room.repair.page",
    requestId: "registry-record-guard",
    snapshotId: "registry-record-guard",
    roomId,
    page: 0,
    records: [record],
    watermark: 0,
    snapshotChecksum: "registry-record-guard",
    hasMore: false,
    mode: "materialized",
    expiresAt: "1970-01-01T00:00:00.000Z",
  }),
});

function registeredRoomRecords(
  authority: DatabaseSync,
  roomId: string,
  principalActorId: string,
  watermark: number,
  recordScanned: () => void,
): readonly RoomRepairRecord[] {
  const records: RoomRepairRecord[] = [];
  for (const descriptor of ROOM_REPAIR_REGISTRY.descriptors) {
    let afterKey: string | undefined;
    while (true) {
      const page = ROOM_REPAIR_REGISTRY.readStablePage({
        database: authority,
        roomId,
        principalActorId,
        watermark,
        afterKey,
        limit: data.limits.scanBatchSize,
        kind: descriptor.kind,
      });
      for (const record of page) {
        records.push(record);
        recordScanned();
      }
      if (page.length < data.limits.scanBatchSize) break;
      const last = page.at(-1);
      if (last === undefined) break;
      afterKey = descriptor.stableKey(last);
    }
  }
  return Object.freeze(records);
}

function keysetRoomPage(
  authority: DatabaseSync,
  roomId: string,
  principalActorId: string,
  watermark: number,
  initial: StreamingCursor | undefined,
  limit: number,
): { readonly values: readonly RoomRepairRecord[]; readonly cursor: StreamingCursor } {
  const values: RoomRepairRecord[] = [];
  let segment = initial?.segment ?? 0;
  let key = initial?.key;
  while (values.length < limit && segment < ROOM_REPAIR_REGISTRY.descriptors.length) {
    const descriptor = ROOM_REPAIR_REGISTRY.descriptors[segment];
    if (descriptor === undefined) break;
    const remaining = limit - values.length;
    const descriptorLimit = descriptor.kind === "memory"
      ? Math.min(remaining, ROOM_MEMORY_REPAIR_KEYSET_LIMIT)
      : descriptor.kind === "notification"
        ? Math.min(remaining, NOTIFICATION_REPAIR_KEYSET_LIMIT)
        : remaining;
    const page = ROOM_REPAIR_REGISTRY.readStablePage({
      database: authority,
      roomId,
      principalActorId,
      watermark,
      afterKey: key,
      limit: descriptorLimit,
      kind: descriptor.kind,
    });
    if (descriptor.kind !== "room" && data.pauseState !== undefined) {
      Atomics.add(new Int32Array(data.pauseState), 1, page.length);
    }
    values.push(...page);
    if (page.length < descriptorLimit) {
      segment += 1;
      key = undefined;
      continue;
    }
    const last = page.at(-1);
    if (last === undefined) {
      throw new SnapshotBuildError("storage_unavailable", "Snapshot registry cursor was corrupt");
    }
    key = descriptor.stableKey(last);
  }
  return {
    values: Object.freeze(values),
    cursor: { segment, ...(key === undefined ? {} : { key }) },
  };
}

function keysetCatalogPage(
  authority: DatabaseSync,
  principalId: string,
  initial: StreamingCursor | undefined,
  limit: number,
): { readonly values: readonly RoomSummary[]; readonly cursor: StreamingCursor } {
  const rows = keysetRows(authority,
    `SELECT room.id AS roomId, room.name, room.status,
            CASE WHEN membership.actor_id = room.owner_actor_id
              THEN 'owner' ELSE membership.role END AS role
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.actor_id = ? AND membership.kind = 'human'`,
    [principalId], "room.id", initial?.key, limit, true);
  return {
    values: rows.map(roomSummary),
    cursor: {
      segment: 0,
      ...(rows.length === 0 ? (initial?.key === undefined ? {} : { key: initial.key })
        : { key: String(rows.at(-1)?.roomId) }),
    },
  };
}

function streamingChecksumAndCount(
  lease: StreamingRepairLease,
): { readonly checksum: string; readonly count: number; readonly authority: DatabaseSync } {
  const authority = openAuthorityReadView();
  try {
    const kind = lease.scope.kind;
    const digest = createHash("sha256");
    digest.update(`{"kind":${JSON.stringify(kind)},"values":[`, "utf8");
    let countValue = 0;
    for (const value of streamingValues(authority, lease)) {
      if (countValue > 0) digest.update(",", "utf8");
      digest.update(canonicalJson(value), "utf8");
      countValue += 1;
    }
    digest.update(`],"version":1}`, "utf8");
    return { checksum: digest.digest("hex"), count: countValue, authority };
  } catch (cause: unknown) {
    try { authority.exec("ROLLBACK"); } catch { /* preserve cause */ }
    authority.close();
    throw cause;
  }
}

function closeStreamingSnapshot(state: StreamingSnapshotState): void {
  try { state.authority.exec("ROLLBACK"); } catch { /* read view may already be closed */ }
  try { state.authority.close(); } catch { /* release remains idempotent */ }
}

function streamingPageEnvelope(
  manifest: StreamingSnapshotManifest,
  requestId: string,
  page: number,
  values: readonly (RoomRepairRecord | RoomSummary)[],
  idleExpiresAt: string,
): SnapshotMaterializedPage {
  const hasMore = page + 1 < manifest.pageCount;
  if (manifest.kind === "room") {
    const result = {
      type: "room.repair.page" as const,
      requestId,
      snapshotId: manifest.snapshotId,
      roomId: manifest.roomId,
      page,
      records: values as readonly RoomRepairRecord[],
      watermark: manifest.watermark,
      snapshotChecksum: manifest.checksum,
      hasMore,
      mode: "streaming" as const,
      idleExpiresAt,
    };
    if (!isRoomRepairPage(result)) {
      throw new SnapshotBuildError("storage_unavailable", "Streaming room record is corrupt");
    }
    return result;
  }
  const result = {
    type: "workspace.bootstrap.page" as const,
    requestId,
    snapshotId: manifest.snapshotId,
    page,
    rooms: values as readonly RoomSummary[],
    catalogRevision: manifest.catalogRevision,
    snapshotChecksum: manifest.checksum,
    hasMore,
    mode: "streaming" as const,
    idleExpiresAt,
  };
  if (!isWorkspaceBootstrapPage(result)) {
    throw new SnapshotBuildError("storage_unavailable", "Streaming catalog record is corrupt");
  }
  return result;
}

function readStreamingPage(
  state: StreamingSnapshotState,
  lease: StreamingRepairLease,
  requestId: string,
  page: number,
): SnapshotMaterializedPage {
  const manifest = state.manifest;
  if (page < 0 || page >= manifest.pageCount || lease.snapshotId !== manifest.snapshotId ||
      lease.sessionFamilyId !== manifest.sessionFamilyId ||
      lease.principalId !== manifest.principalId ||
      (lease.checksum !== undefined && lease.checksum !== manifest.checksum) ||
      (lease.pageCount !== undefined && lease.pageCount !== manifest.pageCount)) {
    throw new SnapshotBuildError("invalid_request", "Streaming page request is invalid");
  }
  if (state.replayPage?.page === page) {
    return streamingPageEnvelope(
      manifest, requestId, page, state.replayPage.values, lease.idleExpiresAt,
    );
  }
  if (page !== state.lastServedPage + 1) {
    throw new SnapshotBuildError("invalid_request", "Streaming pages must be read continuously");
  }
  const selected = lease.scope.kind === "room"
      ? keysetRoomPage(
          state.authority,
          lease.scope.roomId,
          lease.principalId,
          lease.version.kind === "room" ? lease.version.watermark : 0,
          state.cursor,
          data.limits.maxRecordsPerPage,
        )
      : keysetCatalogPage(
          state.authority, lease.scope.principalId, state.cursor, data.limits.maxRecordsPerPage,
        );
    const expectedCount = page === manifest.pageCount - 1
      ? undefined : data.limits.maxRecordsPerPage;
    if ((expectedCount !== undefined && selected.values.length !== expectedCount) ||
        (page === manifest.pageCount - 1 && selected.values.length === 0 &&
          manifest.pageCount > 1)) {
      throw new SnapshotBuildError("storage_unavailable", "Streaming cursor lost its frozen version");
    }
    state.cursor = selected.cursor;
    state.lastServedPage = page;
    state.replayPage = { page, values: selected.values };
  return streamingPageEnvelope(manifest, requestId, page, selected.values, lease.idleExpiresAt);
}

function beginStreaming(
  request: Extract<SnapshotWorkerRequest, { readonly type: "snapshot.begin-streaming" }>,
): void {
  try {
    if (request.lease.checksum !== undefined) {
      const state = streamingSnapshots.get(request.lease.snapshotId);
      if (state === undefined) {
        throw new SnapshotBuildError("snapshot_not_found", "Streaming snapshot was not found");
      }
      const page = readStreamingPage(state, request.lease, request.responseRequestId, 0);
      respond({
        type: "snapshot.streaming-page", requestId: request.requestId,
        page, manifest: state.manifest,
      });
      return;
    }
    const measured = streamingChecksumAndCount(request.lease);
    const pageCount = Math.max(1, Math.ceil(measured.count / data.limits.maxRecordsPerPage));
    const manifest: StreamingSnapshotManifest = request.lease.scope.kind === "room" &&
        request.lease.version.kind === "room"
      ? {
          snapshotId: request.lease.snapshotId,
          principalId: request.lease.principalId,
          sessionFamilyId: request.lease.sessionFamilyId,
          checksum: measured.checksum,
          pageCount,
          kind: "room",
          roomId: request.lease.scope.roomId,
          accessRevision: request.lease.authorizationRevision,
          watermark: request.lease.version.watermark,
        }
      : request.lease.scope.kind === "catalog" && request.lease.version.kind === "catalog"
        ? {
            snapshotId: request.lease.snapshotId,
            principalId: request.lease.principalId,
            sessionFamilyId: request.lease.sessionFamilyId,
            checksum: measured.checksum,
            pageCount,
            kind: "catalog",
            catalogRevision: request.lease.version.catalogRevision,
          }
        : (() => { throw new SnapshotBuildError("invalid_request", "Streaming version mismatch"); })();
    const state: StreamingSnapshotState = {
      manifest,
      authority: measured.authority,
      cursor: undefined,
      lastServedPage: -1,
    };
    const replaced = streamingSnapshots.get(manifest.snapshotId);
    if (replaced !== undefined) closeStreamingSnapshot(replaced);
    streamingSnapshots.set(manifest.snapshotId, state);
    try {
      const page = readStreamingPage(
        state,
        { ...request.lease, checksum: manifest.checksum, pageCount: manifest.pageCount,
          lastPage: manifest.pageCount - 1, highestAuthorizedPage: -1 },
        request.responseRequestId,
        0,
      );
      respond({ type: "snapshot.streaming-page", requestId: request.requestId, page, manifest });
    } catch (cause: unknown) {
      streamingSnapshots.delete(manifest.snapshotId);
      closeStreamingSnapshot(state);
      throw cause;
    }
  } catch (cause: unknown) {
    if (cause instanceof SnapshotBuildError) error(request.requestId, cause.code, cause.message);
    else error(request.requestId, "storage_unavailable", "Streaming snapshot initialization failed");
  }
}

function handleStreamingRead(
  request: Extract<SnapshotWorkerRequest, { readonly type: "snapshot.read-streaming-page" }>,
): void {
  try {
    const state = streamingSnapshots.get(request.lease.snapshotId);
    if (state === undefined) {
      throw new SnapshotBuildError("snapshot_not_found", "Streaming snapshot was not found");
    }
    const pageNumber = request.afterPage + 1;
    const page = readStreamingPage(
      state, request.lease, request.responseRequestId, pageNumber,
    );
    respond({ type: "snapshot.streaming-page", requestId: request.requestId,
      page, manifest: state.manifest });
  } catch (cause: unknown) {
    if (cause instanceof SnapshotBuildError) error(request.requestId, cause.code, cause.message);
    else error(request.requestId, "storage_unavailable", "Streaming snapshot page failed");
  }
}

function pageEnvelope(
  kind: "room" | "catalog",
  requestId: string,
  snapshotId: string,
  page: number,
  values: readonly unknown[],
  manifestVersion: { readonly watermark: number; readonly roomId: string } | { readonly catalogRevision: number },
  checksum: string,
  expiresAt: string,
  hasMore: boolean,
  enforceByteLimit = true,
): SnapshotMaterializedPage {
  if (kind === "room" && "roomId" in manifestVersion) {
    const result = {
      type: "room.repair.page" as const, requestId, snapshotId,
      roomId: manifestVersion.roomId, page,
      records: values as readonly RoomRepairRecord[], watermark: manifestVersion.watermark,
      snapshotChecksum: checksum, hasMore, mode: "materialized" as const, expiresAt,
    };
    if (!isRoomRepairPage(result)) {
      throw new SnapshotBuildError("storage_unavailable", "Snapshot room record is corrupt");
    }
    if (enforceByteLimit && Buffer.byteLength(canonicalJson(result), "utf8") > data.limits.maxPageBytes) {
      throw new SnapshotFallback("quota");
    }
    return result;
  }
  if (kind === "catalog" && "catalogRevision" in manifestVersion) {
    const result = {
      type: "workspace.bootstrap.page" as const, requestId, snapshotId, page,
      rooms: values as readonly RoomSummary[], catalogRevision: manifestVersion.catalogRevision,
      snapshotChecksum: checksum, hasMore, mode: "materialized" as const, expiresAt,
    };
    if (!isWorkspaceBootstrapPage(result)) {
      throw new SnapshotBuildError("storage_unavailable", "Snapshot catalog record is corrupt");
    }
    if (enforceByteLimit && Buffer.byteLength(canonicalJson(result), "utf8") > data.limits.maxPageBytes) {
      throw new SnapshotFallback("quota");
    }
    return result;
  }
  throw new Error("Snapshot kind/version mismatch");
}

function paginate(
  kind: "room" | "catalog", snapshotId: string,
  values: readonly unknown[], version: { readonly watermark: number; readonly roomId: string } | { readonly catalogRevision: number },
  checksum: string, expiresAt: string,
): readonly (readonly unknown[])[] {
  const sizingRequestId = "x".repeat(SNAPSHOT_REQUEST_ID_MAX_BYTES);
  if (values.length === 0) {
    const empty = pageEnvelope(kind, sizingRequestId, snapshotId, 0, [], version, checksum,
      expiresAt, false, false);
    if (Buffer.byteLength(canonicalJson(empty), "utf8") > data.limits.maxPageBytes) {
      throw new SnapshotFallback("quota");
    }
    return [[]];
  }
  const pages: unknown[][] = [];
  let page: unknown[] = [];
  for (const value of values) {
    const candidate = [...page, value];
    const hasMore = pages.reduce((sum, item) => sum + item.length, 0) + candidate.length < values.length;
    const envelope = pageEnvelope(kind, sizingRequestId, snapshotId, pages.length, candidate,
      version, checksum, expiresAt, hasMore, false);
    const fits = candidate.length <= data.limits.maxRecordsPerPage &&
      Buffer.byteLength(canonicalJson(envelope), "utf8") <= data.limits.maxPageBytes;
    if (!fits && page.length > 0) {
      pages.push(page);
      page = [value];
      const single = pageEnvelope(kind, sizingRequestId, snapshotId, pages.length, page,
        version, checksum, expiresAt,
        pages.reduce((sum, item) => sum + item.length, 0) + 1 < values.length, false);
      if (Buffer.byteLength(canonicalJson(single), "utf8") > data.limits.maxPageBytes)
        throw new SnapshotFallback("quota");
    } else if (!fits) throw new SnapshotFallback("quota");
    else page = candidate;
  }
  pages.push(page);
  return pages;
}

function cleanupExpired(now: number): void {
  if (cache === undefined) return;
  cache.exec("BEGIN IMMEDIATE");
  try {
    cache.prepare("DELETE FROM expired_snapshot_tombstones WHERE retain_until <= ?")
      .run(now);
    cache.prepare(
      `INSERT INTO expired_snapshot_tombstones (snapshot_id, retain_until)
       SELECT snapshot_id, expires_at + ? FROM repair_snapshots WHERE expires_at <= ?
       ON CONFLICT(snapshot_id) DO UPDATE SET retain_until = excluded.retain_until`,
    ).run(data.limits.ttlMs, now);
    cache.prepare("DELETE FROM repair_snapshots WHERE expires_at <= ?").run(now);
    cache.exec("COMMIT");
  } catch (cause: unknown) {
    try { cache.exec("ROLLBACK"); } catch { /* preserve cause */ }
    throw cause;
  }
}

type ManifestRow = Record<string, unknown>;

function manifestFromRow(row: ManifestRow): MaterializedSnapshotManifest {
  const base = {
    snapshotId: String(row.snapshotId), principalId: String(row.principalId),
    sessionFamilyId: String(row.sessionFamilyId), checksum: String(row.checksum),
    pageCount: Number(row.pageCount), expiresAt: new Date(Number(row.expiresAt)).toISOString(),
  };
  return row.kind === "room" ? { ...base, kind: "room", roomId: String(row.roomId),
    accessRevision: Number(row.accessRevision), watermark: Number(row.watermark) }
    : { ...base, kind: "catalog", catalogRevision: Number(row.catalogRevision) };
}

function readManifest(snapshotId: string): MaterializedSnapshotManifest | undefined {
  const row = cache?.prepare(
    `SELECT snapshot_id AS snapshotId, kind, principal_id AS principalId,
            session_family_id AS sessionFamilyId, room_id AS roomId,
            access_revision AS accessRevision, watermark, catalog_revision AS catalogRevision,
            checksum, page_count AS pageCount, expires_at AS expiresAt
     FROM repair_snapshots WHERE snapshot_id = ? AND complete = 1 AND invalid = 0`,
  ).get(snapshotId);
  return row === undefined ? undefined : manifestFromRow(row);
}

function pageFromCache(manifest: MaterializedSnapshotManifest, requestId: string, pageNumber: number): SnapshotMaterializedPage {
  const row = cache?.prepare(
    "SELECT payload_json AS payloadJson FROM repair_snapshot_pages WHERE snapshot_id = ? AND page_number = ?",
  ).get(manifest.snapshotId, pageNumber);
  if (typeof row?.payloadJson !== "string") throw new SnapshotBuildError("storage_unavailable", "Snapshot page is missing");
  const storedValues = parseJson(row.payloadJson);
  if (!Array.isArray(storedValues)) {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot page is corrupt");
  }
  const values = manifest.kind === "room"
    ? hydrateRoomPageReferences(manifest, storedValues)
    : storedValues;
  const version = manifest.kind === "room"
    ? { roomId: manifest.roomId, watermark: manifest.watermark }
    : { catalogRevision: manifest.catalogRevision };
  return pageEnvelope(manifest.kind, requestId, manifest.snapshotId, pageNumber, values,
    version, manifest.checksum, manifest.expiresAt, pageNumber + 1 < manifest.pageCount);
}

function cachedPageValues(
  kind: "room" | "catalog",
  values: readonly unknown[],
): readonly unknown[] {
  if (kind === "catalog") return values;
  return values.map((value) => {
    if (isRecord(value) && value.kind === "timeline-message" && isRecord(value.value) &&
        typeof value.value.id === "string" && value.value.id.length > 0) {
      const projectionVersion = value.value.lifecycle === "recalled" &&
          typeof value.value.revisionCount === "number"
        ? `recalled:${value.value.revisionCount}`
        : value.value.authorKind === "human" && isRecord(value.value.currentRevision) &&
            typeof value.value.currentRevision.revision === "number" &&
            typeof value.value.revisionCount === "number"
          ? `human:${value.value.currentRevision.revision}:${value.value.revisionCount}`
          : value.value.authorKind === "agent" &&
              typeof value.value.sourceExecutionId === "string"
            ? `agent:${value.value.sourceExecutionId}`
            : undefined;
      if (projectionVersion === undefined) {
        throw new SnapshotBuildError(
          "storage_unavailable", "Snapshot message projection version is corrupt",
        );
      }
      return {
        kind: "timeline-message-reference",
        messageId: value.value.id,
        projectionVersion,
      };
    }
    if (isRecord(value) && value.kind === "message-revision" &&
        typeof value.roomId === "string" && isRecord(value.value) &&
        typeof value.value.messageId === "string" &&
        typeof value.value.revision === "number") {
      return {
        kind: "message-revision-reference",
        roomId: value.roomId,
        messageId: value.value.messageId,
        revision: value.value.revision,
      };
    }
    if (isRecord(value) && value.kind === "attachment" && isRecord(value.value) &&
        isRecord(value.value.attachment) &&
        typeof value.value.attachment.attachmentId === "string") {
      return {
        kind: "attachment-reference",
        attachmentId: value.value.attachment.attachmentId,
        generation: value.value.attachment.generation,
      };
    }
    return value;
  });
}

function hydrateMessageRevisionReference(
  authority: DatabaseSync,
  roomId: string,
  messageId: string,
  revision: number,
): RoomRepairRecord {
  const row = authority.prepare(`
    SELECT envelope.room_id AS roomId, revision.message_id AS messageId,
           revision.revision, revision.body, revision.revised_at AS revisedAt,
           revision.revised_by_actor_id AS revisedByActorId
    FROM message_revisions AS revision
    JOIN message_envelopes AS envelope ON envelope.message_id = revision.message_id
    WHERE envelope.room_id = ? AND envelope.lifecycle = 'active'
      AND envelope.message_kind = 'human' AND revision.message_id = ?
      AND revision.revision = ? AND revision.revision <= envelope.current_revision
  `).get(roomId, messageId, revision);
  if (!isRecord(row)) {
    throw new SnapshotBuildError("snapshot_stale", "Snapshot revision reference is stale");
  }
  return messageRevisionRecord(row);
}

function hydrateAttachmentReference(
  authority: DatabaseSync,
  roomId: string,
  attachmentId: string,
): RoomRepairRecord {
  const row = authority.prepare(`
    SELECT attachment.attachment_id AS attachmentId,
           attachment.room_id AS roomId,
           attachment.original_filename AS originalFilename,
           attachment.format, attachment.declared_mime AS declaredMime,
           attachment.detected_mime AS detectedMime,
           attachment.byte_size AS byteSize, attachment.sha256,
           attachment.uploader_actor_id AS uploaderActorId,
           attachment.created_at AS createdAt, attachment.ready_at AS readyAt,
           attachment.processing_generation AS generation,
           attachment.source_message_id AS sourceMessageId,
           artifact.method AS artifactMethod,
           artifact.tool_version AS artifactToolVersion,
           artifact.sha256 AS artifactSha256,
           artifact.byte_size AS artifactByteSize,
           artifact.page_end AS pageEnd,
           (
             SELECT attempt.adapter_version
             FROM attachment_processing_attempts AS attempt
             WHERE attempt.attachment_id = attachment.attachment_id
               AND attempt.processing_generation = attachment.processing_generation
               AND attempt.adapter_kind = 'scanner' AND attempt.status = 'succeeded'
             ORDER BY attempt.attempt_number DESC LIMIT 1
           ) AS scannerVersion
    FROM attachments AS attachment
    JOIN attachment_extraction_artifacts AS artifact
      ON artifact.artifact_id = (
        SELECT candidate.artifact_id
        FROM attachment_extraction_artifacts AS candidate
        WHERE candidate.attachment_id = attachment.attachment_id
          AND candidate.processing_generation = attachment.processing_generation
        ORDER BY candidate.artifact_id LIMIT 1
      )
    JOIN message_envelopes AS envelope
      ON envelope.message_id = attachment.source_message_id
     AND envelope.room_id = attachment.room_id
    WHERE attachment.room_id = ? AND attachment.attachment_id = ?
      AND attachment.processing_status = 'ready'
      AND attachment.source_operational_state = 'bound-active'
      AND envelope.lifecycle = 'active'
  `).get(roomId, attachmentId);
  if (!isRecord(row)) {
    throw new SnapshotBuildError("snapshot_stale", "Snapshot attachment reference is stale");
  }
  return attachmentRepairRecord(row);
}

function hydrateRoomPageReferences(
  manifest: Extract<MaterializedSnapshotManifest, { readonly kind: "room" }>,
  values: readonly unknown[],
): readonly unknown[] {
  const authority = openAuthorityPreflight();
  try {
    return values.map((value) => {
      if (isRecord(value) && value.kind === "timeline-message-reference" &&
          exact(value, ["kind", "messageId", "projectionVersion"]) &&
          text(value.messageId) && text(value.projectionVersion)) {
        const record = readOperationalMessageRepairRecord(authority, value.messageId);
        if (record.value.roomId !== manifest.roomId) {
          throw new SnapshotBuildError(
            "storage_unavailable", "Snapshot message reference escaped its Room",
          );
        }
        const currentVersion = record.value.lifecycle === "recalled"
          ? `recalled:${record.value.revisionCount}`
          : record.value.authorKind === "human"
            ? `human:${record.value.currentRevision.revision}:${record.value.revisionCount}`
            : `agent:${record.value.sourceExecutionId}`;
        if (currentVersion !== value.projectionVersion) {
          throw new SnapshotBuildError(
            "snapshot_stale", "Snapshot message projection reference is stale",
          );
        }
        return record;
      }
      if (isRecord(value) && value.kind === "message-revision-reference" &&
          exact(value, ["kind", "roomId", "messageId", "revision"]) &&
          value.roomId === manifest.roomId && text(value.messageId) &&
          Number.isSafeInteger(value.revision) && Number(value.revision) > 0) {
        return hydrateMessageRevisionReference(
          authority,
          manifest.roomId,
          value.messageId,
          Number(value.revision),
        );
      }
      if (isRecord(value) && value.kind === "attachment-reference" &&
          exact(value, ["kind", "attachmentId", "generation"]) &&
          text(value.attachmentId) && Number.isSafeInteger(value.generation) &&
          Number(value.generation) > 0) {
        const record = hydrateAttachmentReference(authority, manifest.roomId, value.attachmentId);
        if (record.kind !== "attachment") {
          throw new SnapshotBuildError(
            "storage_unavailable", "Snapshot attachment projection kind is corrupt",
          );
        }
        if (record.value.attachment.generation !== value.generation) {
          throw new SnapshotBuildError(
            "snapshot_stale", "Snapshot attachment projection reference is stale",
          );
        }
        return record;
      }
      if (isRecord(value) &&
          (value.kind === "timeline-message" || value.kind === "timeline-message-reference" ||
           value.kind === "message-revision" ||
           value.kind === "message-revision-reference" ||
           value.kind === "attachment" || value.kind === "attachment-reference")) {
        throw new SnapshotBuildError(
          "storage_unavailable", "Snapshot authority reference is corrupt",
        );
      }
      return value;
    });
  } finally {
    authority.close();
  }
}

function findReusable(reuseKey: string, now: number): MaterializedSnapshotManifest | undefined {
  const row = cache?.prepare(
    `SELECT snapshot_id AS snapshotId, kind, principal_id AS principalId,
            session_family_id AS sessionFamilyId, room_id AS roomId,
            access_revision AS accessRevision, watermark, catalog_revision AS catalogRevision,
            checksum, page_count AS pageCount, expires_at AS expiresAt
     FROM repair_snapshots
     WHERE reuse_key = ? AND complete = 1 AND invalid = 0 AND expires_at - ? >= ?
     ORDER BY expires_at DESC LIMIT 1`,
  ).get(reuseKey, now, data.limits.reuseMinRemainingMs);
  return row === undefined ? undefined : manifestFromRow(row);
}

function findReusableForRequest(
  request: Extract<SnapshotWorkerRequest,
    { readonly type: "snapshot.begin-room" | "snapshot.begin-catalog" }>,
): SnapshotMaterializedPage | undefined {
  const authority = openAuthorityPreflight();
  try {
    requireSession(authority, request.context, request.now);
    let reuseKey: string;
    if (request.type === "snapshot.begin-room") {
      const row = authority.prepare(
        `SELECT room.status AS roomStatus,
                CASE WHEN access.access_revision IS NULL OR
                          membership.access_revision > access.access_revision
                  THEN membership.access_revision ELSE access.access_revision END AS accessRevision,
                stream.head_seq AS watermark
         FROM rooms AS room
         JOIN room_memberships AS membership ON membership.room_id = room.id
         JOIN streams AS stream ON stream.stream_kind = 'room' AND stream.stream_id = room.id
         LEFT JOIN room_access_authority AS access ON access.room_id = room.id
         WHERE room.id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
      ).get(request.roomId, request.context.principal.actorId);
      if (row === undefined) return undefined;
      if (row.roomStatus !== "active" && row.roomStatus !== "archived") return undefined;
      reuseKey = canonicalJson([request.context.principal.actorId,
        request.context.sessionFamilyId, request.roomId,
        Number(row.watermark), Number(row.accessRevision)]);
    } else {
      const actor = authority.prepare(
        "SELECT catalog_revision AS catalogRevision FROM actors WHERE id = ?",
      ).get(request.context.principal.actorId);
      if (typeof actor?.catalogRevision !== "number") return undefined;
      reuseKey = canonicalJson([request.context.principal.actorId,
        request.context.sessionFamilyId, actor.catalogRevision]);
    }
    const reusable = findReusable(reuseKey, request.now);
    return reusable === undefined ? undefined
      : pageFromCache(reusable, request.responseRequestId, 0);
  } finally {
    authority.close();
  }
}

function persistSnapshot(manifest: MaterializedSnapshotManifest, reuseKey: string, pages: readonly (readonly unknown[])[]): void {
  if (cache === undefined) throw new SnapshotBuildError("storage_unavailable", "Snapshot cache is unavailable");
  const payloads = pages.map((page) => canonicalJson(cachedPageValues(manifest.kind, page)));
  const incomingBytes = payloads.reduce((sum, payload) => sum + Buffer.byteLength(payload, "utf8"), 0);
  if (cacheAllocatedBytes() + incomingBytes > data.limits.cacheQuotaBytes) throw new SnapshotFallback("quota");
  cache.exec("BEGIN IMMEDIATE");
  try {
    cache.prepare(
      `INSERT INTO repair_snapshots (
         snapshot_id, kind, principal_id, session_family_id, room_id,
         access_revision, watermark, catalog_revision, checksum, page_count,
         expires_at, reuse_key, complete, invalid
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    ).run(manifest.snapshotId, manifest.kind, manifest.principalId,
      manifest.sessionFamilyId, manifest.kind === "room" ? manifest.roomId : null,
      manifest.kind === "room" ? manifest.accessRevision : null,
      manifest.kind === "room" ? manifest.watermark : null,
      manifest.kind === "catalog" ? manifest.catalogRevision : null,
      manifest.checksum, manifest.pageCount, Date.parse(manifest.expiresAt), reuseKey);
    const insert = cache.prepare(
      `INSERT INTO repair_snapshot_pages (snapshot_id, page_number, payload_json, canonical_bytes)
       VALUES (?, ?, ?, ?)`,
    );
    payloads.forEach((payload, pageNumber) => insert.run(manifest.snapshotId, pageNumber,
      payload, Buffer.byteLength(payload, "utf8")));
    cache.prepare("UPDATE repair_snapshots SET complete = 1 WHERE snapshot_id = ?")
      .run(manifest.snapshotId);
    if (cacheAllocatedBytes() > data.limits.cacheQuotaBytes) {
      throw new SnapshotFallback("quota");
    }
    cache.exec("COMMIT");
  } catch (cause: unknown) {
    try { cache.exec("ROLLBACK"); } catch { /* preserve cause */ }
    throw cause;
  }
}

function build(
  request: Extract<SnapshotWorkerRequest, { readonly type: "snapshot.begin-room" | "snapshot.begin-catalog" }>,
): SnapshotMaterializedPage {
  cleanupExpired(request.now);
  const reusable = findReusableForRequest(request);
  if (reusable !== undefined) return reusable;
  if (data.pauseState !== undefined) {
    Atomics.add(new Int32Array(data.pauseState), 2, 1);
  }
  const startedAt = performance.now();
  const initialWalBytes = authorityWalSize();
  const authority = openAuthorityReadView();
  let readTransactionOpen = true;
  try {
    requireSession(authority, request.context, request.now);
    let scannedRecords = 0;
    const recordScanned = (): void => {
      scannedRecords += 1;
      if (scannedRecords % data.limits.scanBatchSize === 0) {
        assertBuildSafety(startedAt, initialWalBytes);
      }
    };
    let values: readonly unknown[];
    let version: { readonly roomId: string; readonly watermark: number } | { readonly catalogRevision: number };
    let reuseKey: string;
    if (request.type === "snapshot.begin-room") {
      const row = authority.prepare(
        `SELECT room.status AS roomStatus,
                CASE WHEN access.access_revision IS NULL OR
                          membership.access_revision > access.access_revision
                  THEN membership.access_revision ELSE access.access_revision END AS accessRevision,
                stream.head_seq AS watermark
         FROM rooms AS room
         JOIN room_memberships AS membership ON membership.room_id = room.id
         JOIN streams AS stream ON stream.stream_kind = 'room' AND stream.stream_id = room.id
         LEFT JOIN room_access_authority AS access ON access.room_id = room.id
         WHERE room.id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
      ).get(request.roomId, request.context.principal.actorId);
      if (row === undefined) {
        const exists = authority.prepare("SELECT status FROM rooms WHERE id = ?").get(request.roomId);
        if (exists === undefined) throw new SnapshotBuildError("room_not_found", "Snapshot room was not found");
        throw new SnapshotBuildError("room_forbidden", "Snapshot room is forbidden");
      }
      if (row.roomStatus !== "active" && row.roomStatus !== "archived") {
        throw new SnapshotBuildError("storage_unavailable", "Snapshot room lifecycle is corrupt");
      }
      const accessRevision = Number(row.accessRevision);
      const watermark = Number(row.watermark);
      reuseKey = canonicalJson([request.context.principal.actorId, request.context.sessionFamilyId,
        request.roomId, watermark, accessRevision]);
      const reusable = findReusable(reuseKey, request.now);
      if (reusable !== undefined) {
        authority.exec("COMMIT"); readTransactionOpen = false;
        return pageFromCache(reusable, request.responseRequestId, 0);
      }
      values = registeredRoomRecords(
        authority,
        request.roomId,
        request.context.principal.actorId,
        watermark,
        recordScanned,
      );
      version = { roomId: request.roomId, watermark };
      const checksum = canonicalChecksum("room", values);
      const snapshotId = randomUUID();
      const expiresAt = new Date(request.now + data.limits.ttlMs).toISOString();
      const pages = paginate("room", snapshotId, values, version, checksum, expiresAt);
      const manifest: MaterializedSnapshotManifest = { snapshotId,
        principalId: request.context.principal.actorId,
        sessionFamilyId: request.context.sessionFamilyId, checksum,
        pageCount: pages.length, expiresAt, kind: "room", roomId: request.roomId,
        accessRevision, watermark };
      assertBuildSafety(startedAt, initialWalBytes);
      persistSnapshot(manifest, reuseKey, pages);
      authority.exec("COMMIT"); readTransactionOpen = false;
      return pageFromCache(manifest, request.responseRequestId, 0);
    }
    const actor = authority.prepare("SELECT catalog_revision AS catalogRevision FROM actors WHERE id = ?")
      .get(request.context.principal.actorId);
    if (actor === undefined) throw new SnapshotBuildError("snapshot_forbidden", "Snapshot principal is forbidden");
    const catalogRevision = Number(actor.catalogRevision);
    reuseKey = canonicalJson([request.context.principal.actorId, request.context.sessionFamilyId, catalogRevision]);
    const reusable = findReusable(reuseKey, request.now);
    if (reusable !== undefined) {
      authority.exec("COMMIT"); readTransactionOpen = false;
      return pageFromCache(reusable, request.responseRequestId, 0);
    }
    values = [...catalogRooms(authority, request.context.principal.actorId, recordScanned)];
    version = { catalogRevision };
    const checksum = canonicalChecksum("catalog", values);
    const snapshotId = randomUUID();
    const expiresAt = new Date(request.now + data.limits.ttlMs).toISOString();
    const pages = paginate("catalog", snapshotId, values, version, checksum, expiresAt);
    const manifest: MaterializedSnapshotManifest = { snapshotId,
      principalId: request.context.principal.actorId,
      sessionFamilyId: request.context.sessionFamilyId, checksum,
      pageCount: pages.length, expiresAt, kind: "catalog", catalogRevision };
    assertBuildSafety(startedAt, initialWalBytes);
    persistSnapshot(manifest, reuseKey, pages);
    authority.exec("COMMIT"); readTransactionOpen = false;
    return pageFromCache(manifest, request.responseRequestId, 0);
  } catch (cause: unknown) {
    if (readTransactionOpen) { try { authority.exec("ROLLBACK"); } catch { /* preserve cause */ } }
    throw cause;
  } finally {
    authority.close();
  }
}

function handleBegin(request: Extract<SnapshotWorkerRequest, { readonly type: "snapshot.begin-room" | "snapshot.begin-catalog" }>): void {
  try {
    const page = build(request);
    const manifest = readManifest(page.snapshotId);
    if (manifest === undefined) throw new SnapshotBuildError("storage_unavailable", "Snapshot manifest disappeared");
    respond({ type: "snapshot.page", requestId: request.requestId, page, manifest });
  } catch (cause: unknown) {
    if (cause instanceof SnapshotFallback) {
      respond({ type: "snapshot.fallback", requestId: request.requestId, reason: cause.reason });
    } else if (cause instanceof SnapshotBuildError) error(request.requestId, cause.code, cause.message);
    else error(request.requestId, "storage_unavailable", "Snapshot materialization failed");
  }
}

function handleRead(request: Extract<SnapshotWorkerRequest, { readonly type: "snapshot.read-page" }>): void {
  try {
    const manifest = readManifest(request.snapshotId);
    if (manifest === undefined) {
      const tombstone = cache?.prepare(
        "SELECT retain_until AS retainUntil FROM expired_snapshot_tombstones WHERE snapshot_id = ?",
      ).get(request.snapshotId);
      if (typeof tombstone?.retainUntil === "number" && tombstone.retainUntil > request.now) {
        throw new SnapshotBuildError("snapshot_expired", "Snapshot is expired");
      }
      throw new SnapshotBuildError("snapshot_not_found", "Snapshot was not found");
    }
    if (manifest.principalId !== request.context.principal.actorId ||
        manifest.sessionFamilyId !== request.context.sessionFamilyId) {
      throw new SnapshotBuildError("snapshot_forbidden", "Snapshot family is forbidden");
    }
    if (Date.parse(manifest.expiresAt) <= request.now) {
      cleanupExpired(request.now);
      throw new SnapshotBuildError("snapshot_expired", "Snapshot is expired");
    }
    if (request.afterPage >= manifest.pageCount - 1) {
      throw new SnapshotBuildError("invalid_request", "Snapshot page is out of order");
    }
    const page = pageFromCache(manifest, request.responseRequestId, request.afterPage + 1);
    respond({ type: "snapshot.page", requestId: request.requestId, page, manifest });
  } catch (cause: unknown) {
    if (cause instanceof SnapshotBuildError) error(request.requestId, cause.code, cause.message);
    else error(request.requestId, "storage_unavailable", "Snapshot page read failed");
  }
}

function dispatch(value: unknown): void {
  if (!isRequest(value)) { error(requestIdFrom(value), "invalid_request", "Invalid snapshot request"); return; }
  if (value.type === "snapshot.initialize") {
    if (closed || initialized) { error(value.requestId, "storage_unavailable", "Snapshot worker already initialized"); return; }
    try {
      fullValidationCount += 1;
      cache = openCache(true);
      cache.close();
      cache = undefined;
      initialized = true;
      respond({ type: "snapshot.ready", requestId: value.requestId });
    }
    catch { error(value.requestId, "storage_unavailable", "Snapshot cache initialization failed"); }
    return;
  }
  if (!initialized || closed) { error(value.requestId, "storage_unavailable", "Snapshot worker is unavailable"); return; }
  if (value.type === "snapshot.close") {
    closed = true;
    for (const state of streamingSnapshots.values()) closeStreamingSnapshot(state);
    streamingSnapshots.clear();
    respond({ type: "snapshot.closed", requestId: value.requestId }); port.close();
    return;
  }
  if (value.type === "snapshot.begin-streaming") {
    beginStreaming(value);
    return;
  }
  if (value.type === "snapshot.read-streaming-page") {
    handleStreamingRead(value);
    return;
  }
  if (value.type === "snapshot.release-streaming") {
    const state = streamingSnapshots.get(value.snapshotId);
    if (state !== undefined) closeStreamingSnapshot(state);
    streamingSnapshots.delete(value.snapshotId);
    respond({ type: "snapshot.streaming-released", requestId: value.requestId });
    return;
  }
  try {
    cache = openCache(false);
    if (value.type === "snapshot.begin-room" || value.type === "snapshot.begin-catalog") { handleBegin(value); return; }
    if (value.type === "snapshot.read-page") { handleRead(value); return; }
    if (value.type === "snapshot.invalidate") {
      cache.prepare("DELETE FROM repair_snapshots WHERE snapshot_id = ?").run(value.snapshotId);
      respond({ type: "snapshot.invalidated", requestId: value.requestId }); return;
    }
    if (value.type === "snapshot.invalidate-room") {
      cache.prepare(
        `DELETE FROM repair_snapshots
         WHERE kind = 'room' AND room_id = ? AND access_revision <= ?
           AND (? IS NULL OR principal_id = ?)`,
      ).run(
        value.roomId,
        value.accessRevision,
        value.targetActorId ?? null,
        value.targetActorId ?? null,
      );
      respond({ type: "snapshot.room-invalidated", requestId: value.requestId }); return;
    }
    const countValue = value.type === "snapshot.full-validation-count"
      ? fullValidationCount
      : Number(cache.prepare("SELECT COUNT(*) AS count FROM repair_snapshots").get()?.count);
    cache.close();
    cache = undefined;
    respond(value.type === "snapshot.full-validation-count"
      ? { type: "snapshot.full-validation-count", requestId: value.requestId, count: countValue }
      : { type: "snapshot.cache-count", requestId: value.requestId, count: countValue });
  } catch {
    error(value.requestId, "storage_unavailable", "Snapshot cache operation failed");
  } finally {
    cache?.close();
    cache = undefined;
  }
}

function drain(): void {
  if (processing) return;
  processing = true;
  try { while (requests.length > 0) dispatch(requests.shift()); }
  finally { processing = false; }
}

port.on("message", (request: unknown) => { requests.push(request); drain(); });
port.on("messageerror", () => { throw new Error("Snapshot worker could not deserialize request"); });
