import { createHash, randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
  isRoomRepairPage,
  isSnapshotVersion,
  isWorkspaceBootstrapPage,
} from "@native-im/core";
import type {
  RoomRepairRecord,
  RoomSummary,
} from "@native-im/core";
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
  return isRecord(value) && exact(value, ["sessionId", "sessionFamilyId", "principal"]) &&
    text(value.sessionId) && text(value.sessionFamilyId) && isRecord(value.principal) &&
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

function* roomRecords(
  authority: DatabaseSync,
  roomId: string,
  recordScanned: () => void,
): Generator<RoomRepairRecord> {
  const room = authority.prepare(
    "SELECT id, name, status, created_at AS createdAt FROM rooms WHERE id = ?",
  ).get(roomId);
  if (room === undefined || typeof room.id !== "string" || typeof room.name !== "string" ||
      (room.status !== "active" && room.status !== "archived") || typeof room.createdAt !== "string") {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot room metadata is corrupt");
  }
  yield { kind: "room", value: {
    id: room.id, name: room.name, status: room.status, createdAt: room.createdAt,
  }};
  recordScanned();
  for (const row of scanRows(authority,
    `SELECT actor_id AS actorId, kind, role, participation,
            tool_permissions_json AS toolPermissionsJson, joined_at AS joinedAt,
            configured_at AS configuredAt
     FROM room_memberships WHERE room_id = ?`,
    roomId, "actor_id", "actorId")) {
    if (row.kind === "human" && typeof row.actorId === "string" &&
        (row.role === "owner" || row.role === "admin" || row.role === "member") &&
        typeof row.joinedAt === "string") {
      yield { kind: "membership", value: { kind: "human", actorId: row.actorId,
        role: row.role, joinedAt: row.joinedAt }};
    } else if (row.kind === "agent" && typeof row.actorId === "string" &&
        (row.participation === "active" || row.participation === "on-mention" || row.participation === "silent") &&
        typeof row.configuredAt === "string") {
      const permissions = parseJson(row.toolPermissionsJson);
      if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every(text)) {
        throw new SnapshotBuildError("storage_unavailable", "Snapshot membership is corrupt");
      }
      yield { kind: "membership", value: { kind: "agent", actorId: row.actorId,
        participation: row.participation, toolPermissions: permissions,
        configuredAt: row.configuredAt }};
    } else throw new SnapshotBuildError("storage_unavailable", "Snapshot membership is corrupt");
    recordScanned();
  }
  for (const row of scanRows(authority,
    `SELECT id, room_id AS roomId, author_id AS authorId, author_kind AS authorKind,
            body, sent_at AS sentAt FROM messages WHERE room_id = ?`,
    roomId, "id", "id")) {
    if (typeof row.id !== "string" || typeof row.roomId !== "string" || typeof row.authorId !== "string" ||
        (row.authorKind !== "human" && row.authorKind !== "agent") || typeof row.body !== "string" ||
        typeof row.sentAt !== "string") throw new SnapshotBuildError("storage_unavailable", "Snapshot message is corrupt");
    yield { kind: "message", value: { id: row.id, roomId: row.roomId,
      authorId: row.authorId, authorKind: row.authorKind, body: row.body, sentAt: row.sentAt }};
    recordScanned();
  }
  for (const row of scanRows(authority,
    `SELECT actor_id AS actorId, message_id AS messageId, read_at AS readAt
     FROM human_read_receipts WHERE room_id = ?`,
    roomId, "actor_id", "actorId")) {
    if (typeof row.actorId !== "string" || typeof row.messageId !== "string" || typeof row.readAt !== "string")
      throw new SnapshotBuildError("storage_unavailable", "Snapshot receipt is corrupt");
    yield { kind: "human-read", value: { id: `human-read:${roomId}:${row.actorId}`,
      messageId: row.messageId, readerId: row.actorId, readAt: row.readAt }};
    recordScanned();
  }
  for (const row of scanRows(authority,
    "SELECT id, judgment_json AS json FROM agent_judgments WHERE room_id = ?",
    roomId, "id", "id")) {
    yield { kind: "agent-judgement", value: parseJson(row.json) as RoomRepairRecord & never };
    recordScanned();
  }
  for (const row of scanRows(authority,
    `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
            requester_actor_id AS requesterId, assigned_actor_id AS ownerId,
            body AS content, status, created_at AS createdAt,
            responded_at AS respondedAt, transfer_chain_json AS transferChainJson
     FROM open_items WHERE room_id = ?`,
    roomId, "id", "id")) {
    const transferChain = parseJson(row.transferChainJson);
    yield { kind: "open-item", value: {
      id: String(row.id), roomId: String(row.roomId), sourceMessageId: String(row.sourceMessageId),
      requesterId: String(row.requesterId), ownerId: String(row.ownerId), content: String(row.content),
      status: row.status as "pending_response", createdAt: String(row.createdAt),
      ...(typeof row.respondedAt === "string" ? { respondedAt: row.respondedAt } : {}),
      transferChain: transferChain as [],
    }};
    recordScanned();
  }
  for (const row of scanRows(authority,
    `SELECT id, room_id AS roomId, trigger_message_id AS sourceMessageId,
            requester_actor_id AS requesterId, agent_id AS agentId, tool_name AS toolName,
            status, started_at AS startedAt, completed_at AS completedAt,
            result_json AS resultJson
     FROM agent_executions WHERE room_id = ?`,
    roomId, "id", "id")) {
    yield { kind: "agent-execution", value: {
      id: String(row.id), roomId: String(row.roomId), sourceMessageId: String(row.sourceMessageId),
      requesterId: String(row.requesterId), agentId: String(row.agentId), toolName: String(row.toolName),
      status: row.status as "running", startedAt: String(row.startedAt),
      ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
      ...(typeof row.resultJson === "string" ? { result: String(parseJson(row.resultJson)) } : {}),
    }};
    recordScanned();
  }
  for (const row of scanRows(authority,
    `SELECT id, source_message_id AS sourceMessageId, actor_id AS actorId,
            agent_id AS agentId, signal AS emoji, created_at AS createdAt
     FROM calibration_signals WHERE room_id = ?`,
    roomId, "id", "id")) {
    const common = { id: String(row.id), agentId: String(row.agentId),
      emoji: row.emoji as "👍" | "👎", createdAt: String(row.createdAt) };
    if (row.sourceMessageId === null && row.actorId === null) {
      yield { kind: "legacy-unknown-calibration", value: {
        ...common, sourceMessageId: null, actorId: null,
      }};
    } else if (typeof row.sourceMessageId === "string" && typeof row.actorId === "string") {
      yield { kind: "calibration", value: {
        ...common, sourceMessageId: row.sourceMessageId, actorId: row.actorId,
      }};
    } else {
      throw new SnapshotBuildError("storage_unavailable", "Snapshot calibration is corrupt");
    }
    recordScanned();
  }
}

function* catalogRooms(
  authority: DatabaseSync,
  principalId: string,
  recordScanned: () => void,
): Generator<RoomSummary> {
  for (const row of scanRows(authority,
    `SELECT room.id AS roomId, room.name, room.status, membership.role
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.actor_id = ? AND membership.kind = 'human' AND room.status = 'active'`,
    principalId, "room.id", "roomId")) {
    yield {
      roomId: String(row.roomId), name: String(row.name), status: row.status as "active",
      role: row.role as "owner" | "admin" | "member",
    };
    recordScanned();
  }
}

function streamingValues(
  authority: DatabaseSync,
  lease: StreamingRepairLease,
): Iterable<RoomRepairRecord | RoomSummary> {
  return lease.scope.kind === "room"
    ? roomRecords(authority, lease.scope.roomId, () => undefined)
    : catalogRooms(authority, lease.scope.principalId, () => undefined);
}

interface StreamingCursor {
  readonly segment: number;
  readonly key?: string;
}

interface StreamingSnapshotState {
  readonly manifest: StreamingSnapshotManifest;
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
): readonly Record<string, unknown>[] {
  const statement = authority.prepare(
    `${baseSql}${lastKey === undefined ? "" : ` AND ${keyColumn} > ?`}
     ORDER BY ${keyColumn} LIMIT ?`,
  );
  const rows = statement.all(...parameters, ...(lastKey === undefined ? [] : [lastKey]), limit);
  if (data.pauseState !== undefined) {
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
      (row.participation === "active" || row.participation === "on-mention" ||
        row.participation === "silent") && typeof row.configuredAt === "string") {
    const permissions = parseJson(row.toolPermissionsJson);
    if (Array.isArray(permissions) && permissions.length > 0 && permissions.every(text)) {
      return { kind: "membership", value: { kind: "agent", actorId: row.actorId,
        participation: row.participation, toolPermissions: permissions,
        configuredAt: row.configuredAt }};
    }
  }
  throw new SnapshotBuildError("storage_unavailable", "Snapshot membership is corrupt");
}

function messageRecord(row: Record<string, unknown>): RoomRepairRecord {
  if (typeof row.id !== "string" || typeof row.roomId !== "string" ||
      typeof row.authorId !== "string" ||
      (row.authorKind !== "human" && row.authorKind !== "agent") ||
      typeof row.body !== "string" || typeof row.sentAt !== "string") {
    throw new SnapshotBuildError("storage_unavailable", "Snapshot message is corrupt");
  }
  return { kind: "message", value: { id: row.id, roomId: row.roomId,
    authorId: row.authorId, authorKind: row.authorKind, body: row.body, sentAt: row.sentAt }};
}

function keysetRoomPage(
  authority: DatabaseSync,
  roomId: string,
  initial: StreamingCursor | undefined,
  limit: number,
): { readonly values: readonly RoomRepairRecord[]; readonly cursor: StreamingCursor } {
  const values: RoomRepairRecord[] = [];
  let segment = initial?.segment ?? 0;
  let key = initial?.key;
  const append = (
    rows: readonly Record<string, unknown>[],
    keyOf: (row: Record<string, unknown>) => string,
    recordOf: (row: Record<string, unknown>) => RoomRepairRecord,
  ): void => {
    const requested = limit - values.length;
    for (const row of rows) {
      values.push(recordOf(row));
      key = keyOf(row);
    }
    if (rows.length < requested) {
      segment += 1;
      key = undefined;
    }
  };

  while (values.length < limit && segment < 8) {
    if (segment === 0) {
      const room = authority.prepare(
        "SELECT id, name, status, created_at AS createdAt FROM rooms WHERE id = ?",
      ).get(roomId);
      if (room === undefined || typeof room.id !== "string" || typeof room.name !== "string" ||
          (room.status !== "active" && room.status !== "archived") ||
          typeof room.createdAt !== "string") {
        throw new SnapshotBuildError("storage_unavailable", "Snapshot room metadata is corrupt");
      }
      if (key === undefined) {
        values.push({ kind: "room", value: { id: room.id, name: room.name,
          status: room.status, createdAt: room.createdAt }});
        if (data.pauseState !== undefined) {
          Atomics.add(new Int32Array(data.pauseState), 1, 1);
        }
      }
      segment = 1;
      key = undefined;
      continue;
    }
    const remaining = limit - values.length;
    if (segment === 1) {
      append(keysetRows(authority,
        `SELECT actor_id AS actorId, kind, role, participation,
                tool_permissions_json AS toolPermissionsJson, joined_at AS joinedAt,
                configured_at AS configuredAt
         FROM room_memberships WHERE room_id = ?`, [roomId], "actor_id", key, remaining),
      (row) => String(row.actorId), membershipRecord);
    } else if (segment === 2) {
      append(keysetRows(authority,
        `SELECT id, room_id AS roomId, author_id AS authorId, author_kind AS authorKind,
                body, sent_at AS sentAt FROM messages WHERE room_id = ?`,
        [roomId], "id", key, remaining), (row) => String(row.id), messageRecord);
    } else if (segment === 3) {
      append(keysetRows(authority,
        `SELECT actor_id AS actorId, message_id AS messageId, read_at AS readAt
         FROM human_read_receipts WHERE room_id = ?`,
        [roomId], "actor_id", key, remaining), (row) => String(row.actorId), (row) => {
          if (typeof row.actorId !== "string" || typeof row.messageId !== "string" ||
              typeof row.readAt !== "string") {
            throw new SnapshotBuildError("storage_unavailable", "Snapshot receipt is corrupt");
          }
          return { kind: "human-read", value: { id: `human-read:${roomId}:${row.actorId}`,
            messageId: row.messageId, readerId: row.actorId, readAt: row.readAt }};
        });
    } else if (segment === 4) {
      append(keysetRows(authority,
        "SELECT id, judgment_json AS json FROM agent_judgments WHERE room_id = ?",
        [roomId], "id", key, remaining), (row) => String(row.id), (row) =>
          ({ kind: "agent-judgement", value: parseJson(row.json) as RoomRepairRecord & never }));
    } else if (segment === 5) {
      append(keysetRows(authority,
        `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
                requester_actor_id AS requesterId, assigned_actor_id AS ownerId,
                body AS content, status, created_at AS createdAt,
                responded_at AS respondedAt, transfer_chain_json AS transferChainJson
         FROM open_items WHERE room_id = ?`, [roomId], "id", key, remaining),
      (row) => String(row.id), (row) => ({ kind: "open-item", value: {
        id: String(row.id), roomId: String(row.roomId), sourceMessageId: String(row.sourceMessageId),
        requesterId: String(row.requesterId), ownerId: String(row.ownerId),
        content: String(row.content), status: row.status as "pending_response",
        createdAt: String(row.createdAt),
        ...(typeof row.respondedAt === "string" ? { respondedAt: row.respondedAt } : {}),
        transferChain: parseJson(row.transferChainJson) as [],
      }}));
    } else if (segment === 6) {
      append(keysetRows(authority,
        `SELECT id, room_id AS roomId, trigger_message_id AS sourceMessageId,
                requester_actor_id AS requesterId, agent_id AS agentId, tool_name AS toolName,
                status, started_at AS startedAt, completed_at AS completedAt,
                result_json AS resultJson
         FROM agent_executions WHERE room_id = ?`, [roomId], "id", key, remaining),
      (row) => String(row.id), (row) => ({ kind: "agent-execution", value: {
        id: String(row.id), roomId: String(row.roomId), sourceMessageId: String(row.sourceMessageId),
        requesterId: String(row.requesterId), agentId: String(row.agentId),
        toolName: String(row.toolName), status: row.status as "running",
        startedAt: String(row.startedAt),
        ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
        ...(typeof row.resultJson === "string"
          ? { result: String(parseJson(row.resultJson)) } : {}),
      }}));
    } else {
      append(keysetRows(authority,
        `SELECT id, source_message_id AS sourceMessageId, actor_id AS actorId,
                agent_id AS agentId, signal AS emoji, created_at AS createdAt
         FROM calibration_signals WHERE room_id = ?`, [roomId], "id", key, remaining),
      (row) => String(row.id), (row) => {
        const common = { id: String(row.id), agentId: String(row.agentId),
          emoji: row.emoji as "👍" | "👎", createdAt: String(row.createdAt) };
        if (row.sourceMessageId === null && row.actorId === null) {
          return { kind: "legacy-unknown-calibration", value: {
            ...common, sourceMessageId: null, actorId: null,
          }};
        }
        if (typeof row.sourceMessageId === "string" && typeof row.actorId === "string") {
          return { kind: "calibration", value: {
            ...common, sourceMessageId: row.sourceMessageId, actorId: row.actorId,
          }};
        }
        throw new SnapshotBuildError("storage_unavailable", "Snapshot calibration is corrupt");
      });
    }
  }
  return { values, cursor: { segment, ...(key === undefined ? {} : { key }) } };
}

function keysetCatalogPage(
  authority: DatabaseSync,
  principalId: string,
  initial: StreamingCursor | undefined,
  limit: number,
): { readonly values: readonly RoomSummary[]; readonly cursor: StreamingCursor } {
  const rows = keysetRows(authority,
    `SELECT room.id AS roomId, room.name, room.status, membership.role
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.actor_id = ? AND membership.kind = 'human' AND room.status = 'active'`,
    [principalId], "room.id", initial?.key, limit);
  return {
    values: rows.map((row) => ({
      roomId: String(row.roomId), name: String(row.name), status: row.status as "active",
      role: row.role as "owner" | "admin" | "member",
    })),
    cursor: {
      segment: 0,
      ...(rows.length === 0 ? (initial?.key === undefined ? {} : { key: initial.key })
        : { key: String(rows.at(-1)?.roomId) }),
    },
  };
}

function streamingChecksumAndCount(
  lease: StreamingRepairLease,
): { readonly checksum: string; readonly count: number } {
  const authority = openAuthorityPreflight();
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
    return { checksum: digest.digest("hex"), count: countValue };
  } finally {
    authority.close();
  }
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
  const authority = openAuthorityPreflight();
  try {
    const selected = lease.scope.kind === "room"
      ? keysetRoomPage(
          authority, lease.scope.roomId, state.cursor, data.limits.maxRecordsPerPage,
        )
      : keysetCatalogPage(
          authority, lease.scope.principalId, state.cursor, data.limits.maxRecordsPerPage,
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
  } finally {
    authority.close();
  }
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
      cursor: undefined,
      lastServedPage: -1,
    };
    streamingSnapshots.set(manifest.snapshotId, state);
    const page = readStreamingPage(
      state,
      { ...request.lease, checksum: manifest.checksum, pageCount: manifest.pageCount,
        lastPage: manifest.pageCount - 1, highestAuthorizedPage: -1 },
      request.responseRequestId,
      0,
    );
    respond({ type: "snapshot.streaming-page", requestId: request.requestId, page, manifest });
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
  const values = parseJson(row.payloadJson);
  if (!Array.isArray(values)) throw new SnapshotBuildError("storage_unavailable", "Snapshot page is corrupt");
  const version = manifest.kind === "room"
    ? { roomId: manifest.roomId, watermark: manifest.watermark }
    : { catalogRevision: manifest.catalogRevision };
  return pageEnvelope(manifest.kind, requestId, manifest.snapshotId, pageNumber, values,
    version, manifest.checksum, manifest.expiresAt, pageNumber + 1 < manifest.pageCount);
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
        `SELECT room.status AS roomStatus, membership.access_revision AS accessRevision,
                stream.head_seq AS watermark
         FROM rooms AS room
         JOIN room_memberships AS membership ON membership.room_id = room.id
         JOIN streams AS stream ON stream.stream_kind = 'room' AND stream.stream_id = room.id
         WHERE room.id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
      ).get(request.roomId, request.context.principal.actorId);
      if (row === undefined) return undefined;
      if (row.roomStatus !== "active") return undefined;
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
  const payloads = pages.map((page) => canonicalJson(page));
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
        `SELECT room.status AS roomStatus, membership.access_revision AS accessRevision,
                stream.head_seq AS watermark
         FROM rooms AS room
         JOIN room_memberships AS membership ON membership.room_id = room.id
         JOIN streams AS stream ON stream.stream_kind = 'room' AND stream.stream_id = room.id
         WHERE room.id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
      ).get(request.roomId, request.context.principal.actorId);
      if (row === undefined) {
        const exists = authority.prepare("SELECT status FROM rooms WHERE id = ?").get(request.roomId);
        if (exists === undefined) throw new SnapshotBuildError("room_not_found", "Snapshot room was not found");
        throw new SnapshotBuildError("room_forbidden", "Snapshot room is forbidden");
      }
      if (row.roomStatus !== "active") throw new SnapshotBuildError("room_archived", "Snapshot room is archived");
      const accessRevision = Number(row.accessRevision);
      const watermark = Number(row.watermark);
      reuseKey = canonicalJson([request.context.principal.actorId, request.context.sessionFamilyId,
        request.roomId, watermark, accessRevision]);
      const reusable = findReusable(reuseKey, request.now);
      if (reusable !== undefined) {
        authority.exec("COMMIT"); readTransactionOpen = false;
        return pageFromCache(reusable, request.responseRequestId, 0);
      }
      values = [...roomRecords(authority, request.roomId, recordScanned)];
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
