import { createHash } from "node:crypto";

export const ROOM_EXPORT_VERSION = "dao.room-export.v1" as const;
export const ROOM_EXPORT_MAX_PAGE_RECORDS = 256;
export const ROOM_EXPORT_MAX_RECORD_BYTES = 1_048_576;
export const ROOM_EXPORT_MAX_RECORDS = 1_000_000;
export const ROOM_EXPORT_MAX_BYTES = 2_147_483_648;

export const ROOM_EXPORT_CATEGORIES = [
  "attachment_inventory",
  "execution_tool_review",
  "membership_governance_audit",
  "memory",
  "message",
  "message_revision",
  "project_fact",
  "recall_audit",
  "source_link",
] as const;

export type RoomExportCategory = typeof ROOM_EXPORT_CATEGORIES[number];
export type RoomExportJson = null | boolean | number | string | readonly RoomExportJson[] | Readonly<{ [key: string]: RoomExportJson }>;

export type RoomExportRecord = Readonly<{
  category: RoomExportCategory;
  entityId: string;
  revision: number;
  payload: RoomExportJson;
}>;

export type RoomExportAuthorization = Readonly<{
  actorId: string;
  roomId: string;
  sessionFamilyId: string;
  sessionId: string;
  accessRevision: number;
  lifecycle: "active" | "archived";
  role: "owner";
}>;

export type RoomExportSnapshot = Readonly<{
  exportId: string;
  roomId: string;
  watermark: number;
  accessRevision: number;
  startedAt: string;
}>;

export class RoomExportError extends Error {
  readonly status = 403;

  constructor(readonly code: "room_export_forbidden") {
    super(code);
    this.name = "RoomExportError";
  }
}

export interface RoomExportAuthority {
  authorize(input: Readonly<{ actorId: string; roomId: string; sessionFamilyId: string; sessionId: string }>): Promise<RoomExportAuthorization>;
  begin(input: RoomExportAuthorization): Promise<RoomExportSnapshot>;
  reauthorize(input: RoomExportAuthorization & Readonly<{ exportId: string; watermark: number }>): Promise<void>;
  readPage(input: Readonly<{
    exportId: string;
    roomId: string;
    watermark: number;
    after?: string;
    limit: number;
  }>): Promise<Readonly<{ records: readonly RoomExportRecord[]; next?: string }>>;
  /** Idempotently releases authorization/snapshot state on every terminal path. */
  release(input: Readonly<{
    authorization: RoomExportAuthorization;
    exportId?: string;
  }>): Promise<void>;
  audit(input: Readonly<{
    exportId: string;
    requesterActorId: string;
    roomId: string;
    watermark: number;
    startedAt: string;
    completedAt?: string;
    manifestDigest?: string;
    result: "started" | "succeeded" | "forbidden" | "failed" | "aborted";
    failureCode?: "access_revoked" | "capacity_exceeded" | "invalid_authority_record" |
      "storage_unavailable" | "client_aborted" | "audit_unavailable" | "operation_timeout";
  }>): Promise<void>;
}

const FORBIDDEN_EXPORT_KEYS = new Set([
  "access_token", "api_key", "authorization", "credential", "credentials",
  "encryption_key", "header", "headers", "hidden_reasoning", "key_material", "password",
  "private_key", "provider_raw_request", "provider_raw_response", "provider_request",
  "provider_response", "refresh_token", "secret", "secrets", "secret_key", "session_token",
]);

function isForbiddenExportKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return FORBIDDEN_EXPORT_KEYS.has(normalized);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function safeId(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function assertNoForbiddenKeys(value: RoomExportJson): void {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("export record number is invalid");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenExportKey(key)) throw new TypeError("export record contains forbidden security material");
    assertNoForbiddenKeys(nested);
  }
}

function isStorageUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (("code" in error && error.code === "storage_unavailable") ||
      ("status" in error && error.status === 503));
}

function isAuditUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "audit_unavailable";
}

function operationTimeout(): Error & Readonly<{ code: "operations_timeout"; status: 503 }> {
  return Object.assign(new Error("Room export operation timed out"), {
    code: "operations_timeout" as const,
    status: 503 as const,
  });
}

function clientAborted(): Error & Readonly<{ code: "client_aborted"; status: 410 }> {
  return Object.assign(new Error("Room export client aborted"), {
    code: "client_aborted" as const,
    status: 410 as const,
  });
}

function isOperationTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "operations_timeout";
}

function isClientAborted(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "client_aborted";
}

function cancellationError(signal: AbortSignal): ReturnType<typeof operationTimeout> |
ReturnType<typeof clientAborted> {
  return isClientAborted(signal.reason) ? clientAborted() : operationTimeout();
}

async function abortableAuthorityCall<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
  onLateSuccess?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (signal?.aborted === true) throw cancellationError(signal);
  if (signal === undefined) return operation();
  let rejectAborted!: (error: unknown) => void;
  let cancelled = false;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = () => {
    cancelled = true;
    rejectAborted(cancellationError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // Promise.race installs rejection handlers on the underlying authority promise. If it
  // settles after cancellation, it cannot produce an unhandled rejection.
  try {
    const pending = operation();
    if (onLateSuccess !== undefined) {
      void pending.then(async (value) => {
        if (cancelled) await onLateSuccess(value);
      }).catch(() => undefined);
    }
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function safeRoomExportAudit(
  authority: RoomExportAuthority,
  input: Parameters<RoomExportAuthority["audit"]>[0],
): Promise<void> {
  try { await authority.audit(input); } catch { /* terminal cleanup must continue */ }
}

function encodeLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonical(value)}\n`);
}

function normalizeRecord(record: RoomExportRecord): Readonly<{ record: RoomExportRecord; line: Uint8Array; digest: string }> {
  if (!(ROOM_EXPORT_CATEGORIES as readonly string[]).includes(record.category) || !safeId(record.entityId) ||
      !Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new TypeError("export authority record identity is invalid");
  }
  assertNoForbiddenKeys(record.payload);
  const line = encodeLine({ type: "record", ...record });
  if (line.byteLength > ROOM_EXPORT_MAX_RECORD_BYTES) throw new RangeError("export record byte limit exceeded");
  return Object.freeze({ record, line, digest: createHash("sha256").update(line).digest("hex") });
}

export function createRoomDataExport(options: Readonly<{
  authority: RoomExportAuthority;
  now?: () => Date;
}>): Readonly<{
  stream(input: Readonly<{ actorId: string; roomId: string; sessionFamilyId: string;
    sessionId: string }>, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}> {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async *stream(input, signal) {
      let authorization: RoomExportAuthorization | undefined;
      let snapshot: RoomExportSnapshot | undefined;
      let snapshotValidated = false;
      let terminalAudited = false;
      try {
        try {
          authorization = await abortableAuthorityCall(signal,
            () => options.authority.authorize(input),
            (lateAuthorization) => options.authority.release({
              authorization: lateAuthorization,
            }));
        } catch (error) {
          if (isOperationTimeout(error) || isClientAborted(error)) throw error;
          // Zero bytes are emitted before owner/session/membership authorization succeeds.
          throw new RoomExportError("room_export_forbidden");
        }
        if (authorization.actorId !== input.actorId || authorization.roomId !== input.roomId ||
            authorization.sessionFamilyId !== input.sessionFamilyId ||
            authorization.sessionId !== input.sessionId || authorization.role !== "owner") {
          throw new RoomExportError("room_export_forbidden");
        }
        const authorized = authorization;
        snapshot = await abortableAuthorityCall(signal,
          () => options.authority.begin(authorized),
          (lateSnapshot) => options.authority.release({
            authorization: authorized,
            exportId: lateSnapshot.exportId,
          }));
        if (snapshot.roomId !== input.roomId || snapshot.accessRevision !== authorization.accessRevision ||
            !Number.isSafeInteger(snapshot.watermark) || snapshot.watermark < 0 || !safeId(snapshot.exportId) ||
            !Number.isFinite(Date.parse(snapshot.startedAt)) ||
            new Date(snapshot.startedAt).toISOString() !== snapshot.startedAt) {
          throw new Error("room_export_invalid_snapshot");
        }
        snapshotValidated = true;
        const activeSnapshot = snapshot;
        try {
          await abortableAuthorityCall(signal, () => options.authority.audit({
            exportId: activeSnapshot.exportId, requesterActorId: input.actorId, roomId: input.roomId,
            watermark: activeSnapshot.watermark, startedAt: activeSnapshot.startedAt, result: "started",
          }));
        } catch (error) {
          if (isOperationTimeout(error) || isClientAborted(error)) throw error;
          throw Object.assign(new Error("Room export audit is unavailable"), {
            code: "audit_unavailable",
            status: 503,
          });
        }
        const digest = createHash("sha256");
        const counts = new Map<RoomExportCategory, number>();
        let recordCount = 0;
        let byteLength = 0;
        let after: string | undefined;
        const header = encodeLine({
          type: "header", version: ROOM_EXPORT_VERSION, exportId: activeSnapshot.exportId,
          roomId: activeSnapshot.roomId, watermark: activeSnapshot.watermark,
          startedAt: activeSnapshot.startedAt,
        });
        await abortableAuthorityCall(signal, () => options.authority.reauthorize({
          ...authorized, exportId: activeSnapshot.exportId, watermark: activeSnapshot.watermark,
        }));
        digest.update(header); byteLength += header.byteLength; yield header;
        while (true) {
          await abortableAuthorityCall(signal, () => options.authority.reauthorize({
            ...authorized, exportId: activeSnapshot.exportId, watermark: activeSnapshot.watermark,
          }));
          const page = await abortableAuthorityCall(signal, () => options.authority.readPage({
            exportId: activeSnapshot.exportId, roomId: input.roomId,
            watermark: activeSnapshot.watermark,
            ...(after === undefined ? {} : { after }),
            limit: ROOM_EXPORT_MAX_PAGE_RECORDS,
          }));
          if (page.records.length > ROOM_EXPORT_MAX_PAGE_RECORDS ||
              (page.next !== undefined && (!safeId(page.next) || page.next === after)) ||
              (page.records.length === 0 && page.next !== undefined)) {
            throw new TypeError("export page contract is invalid");
          }
          for (const source of page.records) {
            const normalized = normalizeRecord(source);
            recordCount += 1;
            byteLength += normalized.line.byteLength;
            if (recordCount > ROOM_EXPORT_MAX_RECORDS || byteLength > ROOM_EXPORT_MAX_BYTES) {
              throw new RangeError("export capacity exceeded");
            }
            digest.update(normalized.line);
            counts.set(source.category, (counts.get(source.category) ?? 0) + 1);
            yield normalized.line;
          }
          if (page.next === undefined) break;
          after = page.next;
        }
        await abortableAuthorityCall(signal, () => options.authority.reauthorize({
          ...authorized, exportId: activeSnapshot.exportId, watermark: activeSnapshot.watermark,
        }));
        const contentDigest = digest.digest("hex");
        const completedAt = now().toISOString();
        const manifest = {
          type: "manifest", version: ROOM_EXPORT_VERSION, exportId: activeSnapshot.exportId,
          roomId: input.roomId, watermark: activeSnapshot.watermark, recordCount, byteLength,
          categories: [...counts].sort(([left], [right]) => left.localeCompare(right))
            .map(([category, count]) => ({ category, count })),
          contentDigest, completedAt,
        };
        const manifestDigest = createHash("sha256").update(canonical(manifest)).digest("hex");
        const successAudit = Promise.resolve().then(() => options.authority.audit({
          exportId: activeSnapshot.exportId, requesterActorId: input.actorId,
          roomId: input.roomId, watermark: activeSnapshot.watermark,
          startedAt: activeSnapshot.startedAt, completedAt,
          manifestDigest, result: "succeeded",
        }));
        try {
          await abortableAuthorityCall(signal, () => successAudit);
          terminalAudited = true;
        } catch (error) {
          if (isOperationTimeout(error) || isClientAborted(error)) {
            // A late success may already be durable, so cancellation cannot append a
            // contradictory terminal. A late rejection owns the cancellation terminal.
            terminalAudited = true;
            const cancelled = error;
            void successAudit.catch(() => safeRoomExportAudit(options.authority, {
              exportId: activeSnapshot.exportId, requesterActorId: input.actorId,
              roomId: input.roomId, watermark: activeSnapshot.watermark,
              startedAt: activeSnapshot.startedAt,
              result: isClientAborted(cancelled) ? "aborted" : "failed",
              failureCode: isClientAborted(cancelled) ? "client_aborted" : "operation_timeout",
            }));
            throw error;
          }
          throw Object.assign(new Error("Room export audit is unavailable"), {
            code: "audit_unavailable",
            status: 503,
          });
        }
        // The manifest makes the stream independently usable, so publish it only after
        // the durable terminal success audit has been accepted.
        yield encodeLine({ ...manifest, manifestDigest });
      } catch (error) {
        const failureCode = isOperationTimeout(error) ? "operation_timeout" :
          isClientAborted(error) ? "client_aborted" :
          error instanceof RangeError ? "capacity_exceeded" :
          error instanceof TypeError ? "invalid_authority_record" :
            isAuditUnavailable(error) ? "audit_unavailable" :
              isStorageUnavailable(error) ? "storage_unavailable" : "access_revoked";
        if (snapshot !== undefined && snapshotValidated && !terminalAudited) {
          const terminalAudit = safeRoomExportAudit(options.authority, {
            exportId: snapshot.exportId, requesterActorId: input.actorId, roomId: input.roomId,
            watermark: snapshot.watermark, startedAt: snapshot.startedAt,
            result: isClientAborted(error) ? "aborted" : "failed", failureCode,
          });
          terminalAudited = true;
          if (isOperationTimeout(error) || isClientAborted(error)) void terminalAudit;
          else await terminalAudit;
        }
        throw error;
      } finally {
        if (authorization !== undefined) {
          if (snapshot !== undefined && snapshotValidated && !terminalAudited) {
            const terminalAudit = safeRoomExportAudit(options.authority, {
              exportId: snapshot.exportId, requesterActorId: input.actorId, roomId: input.roomId,
              watermark: snapshot.watermark, startedAt: snapshot.startedAt,
              result: signal?.aborted === true && !isClientAborted(signal.reason)
                ? "failed" : "aborted",
              failureCode: signal?.aborted === true && !isClientAborted(signal.reason)
                ? "operation_timeout" : "client_aborted",
            });
            terminalAudited = true;
            if (signal?.aborted === true) void terminalAudit;
            else await terminalAudit;
          }
          let released: Promise<void>;
          try {
            released = Promise.resolve(options.authority.release({
              authorization,
              ...(snapshot === undefined ? {} : { exportId: snapshot.exportId }),
            })).catch(() => undefined);
          } catch {
            released = Promise.resolve();
          }
          if (signal?.aborted === true) void released;
          else await released;
        }
      }
    },
  });
}
