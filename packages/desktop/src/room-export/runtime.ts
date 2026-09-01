import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  NativeAtomicSaveFileSystemPort,
  NativeSaveDialogPort,
  NativeTemporaryFile,
} from "../attachment-authority/preview-download.js";
import {
  isRoomExportClosedError,
  isRoomExportIdentifier,
  isRoomExportIntent,
  type RoomExportClosedError,
  type RoomExportIntent,
  type RoomExportResult,
} from "./contracts.js";
import {
  ROOM_EXPORT_CATEGORIES,
  ROOM_EXPORT_LIMITS,
  isRoomExportChunk,
  isRoomExportOpened,
  isRoomExportAborted,
  type RoomExportAbortCommand,
  type RoomExportAborted,
  type RoomExportChunk,
  type RoomExportOpenCommand,
  type RoomExportOpened,
  type RoomExportReadCommand,
} from "./stream-contracts.js";

const VERSION = "dao.room-export.v1";
const decoder = new TextDecoder("utf-8", { fatal: true });
const forbiddenKeys = new Set([
  "access_token", "api_key", "authorization", "credential", "credentials",
  "encryption_key", "header", "headers", "hidden_reasoning", "key_material", "password",
  "private_key", "provider_raw_request", "provider_raw_response", "provider_request",
  "provider_response", "refresh_token", "secret", "secrets", "secret_key", "session_token",
]);

export interface RoomExportStreamTransport {
  open(command: RoomExportOpenCommand): Promise<RoomExportOpened>;
  read(command: RoomExportReadCommand): Promise<RoomExportChunk>;
  abort(command: RoomExportAbortCommand): Promise<RoomExportAborted>;
}

export class RoomExportRuntimeError extends Error {
  readonly roomExportError: RoomExportClosedError;
  constructor(error: RoomExportClosedError) {
    super(`Room export failed: ${error.status} ${error.code}`);
    this.name = "RoomExportRuntimeError";
    this.roomExportError = structuredClone(error);
  }
}

export const NODE_ROOM_EXPORT_ATOMIC_FILE_SYSTEM: NativeAtomicSaveFileSystemPort =
Object.freeze<NativeAtomicSaveFileSystemPort>({
  async openTemporary(temporaryPath) {
    const descriptor = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    let closed = false;
    return Object.freeze<NativeTemporaryFile>({
      async write(bytes) {
        if (closed || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
            bytes.byteLength > ROOM_EXPORT_LIMITS.maxChunkBytes) {
          throw new TypeError("Invalid Room export temporary write");
        }
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await descriptor.write(bytes, written, bytes.byteLength - written);
          if (result.bytesWritten <= 0) throw new Error("Room export temporary write made no progress");
          written += result.bytesWritten;
        }
      },
      async sync() {
        if (closed) throw new Error("Room export temporary file is closed");
        await descriptor.sync();
      },
      async close() {
        if (closed) return;
        closed = true;
        await descriptor.close();
      },
    });
  },
  async rename(temporaryPath, destinationPath) {
    await rename(temporaryPath, destinationPath);
    const directory = await open(dirname(destinationPath), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  },
  async remove(temporaryPath) {
    await rm(temporaryPath, { force: true });
  },
});

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonRecord = Record<string, Json>;

function exact(value: JsonRecord, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && required.includes(key));
}

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Readonly<Record<string, Json>>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key]!)}`).join(",")}}`;
}

function normalizedKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function validateJson(value: unknown, depth = 0): value is Json {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100_000 &&
    value.every((item) => validateJson(item, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 100_000 && entries.every(([key, nested]) =>
    !forbiddenKeys.has(normalizedKey(key)) && validateJson(nested, depth + 1));
}

function jsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && validateJson(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidStream(): never {
  throw new RoomExportRuntimeError({ status: 503, code: "room_export_invalid_stream" });
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left); result.set(right, left.byteLength);
  return result;
}

class NdjsonVerifier {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private phase: "header" | "records" | "manifest" = "header";
  private readonly contentHash = createHash("sha256");
  private readonly counts = new Map<string, number>();
  private exportId: string | undefined;
  private watermark: number | undefined;
  private recordCount = 0;
  private contentBytes = 0;
  private totalBytes = 0;

  constructor(private readonly roomId: string) {}

  push(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > ROOM_EXPORT_LIMITS.maxBytes + ROOM_EXPORT_LIMITS.maxLineBytes) invalidStream();
    this.pending = append(this.pending, chunk);
    let newline = this.pending.indexOf(0x0a);
    while (newline >= 0) {
      const raw = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      this.line(raw);
      newline = this.pending.indexOf(0x0a);
    }
    if (this.pending.byteLength > ROOM_EXPORT_LIMITS.maxLineBytes) invalidStream();
  }

  finish(): void {
    if (this.pending.byteLength !== 0 || this.phase !== "manifest") invalidStream();
  }

  private line(raw: Uint8Array): void {
    if (raw.byteLength <= 1 || raw.byteLength > ROOM_EXPORT_LIMITS.maxLineBytes ||
        raw[raw.byteLength - 1] !== 0x0a || raw[raw.byteLength - 2] === 0x0d) invalidStream();
    let text: string;
    let value: unknown;
    try {
      text = decoder.decode(raw.slice(0, -1));
      value = JSON.parse(text) as unknown;
    } catch {
      return invalidStream();
    }
    if (!jsonRecord(value) || canonical(value) !== text || typeof value.type !== "string") invalidStream();
    if (value.type === "header") return this.header(value, raw);
    if (value.type === "record") return this.record(value, raw);
    if (value.type === "manifest") return this.manifest(value);
    return invalidStream();
  }

  private header(value: JsonRecord, raw: Uint8Array): void {
    if (this.phase !== "header" || !exact(value,
      ["type", "version", "exportId", "roomId", "watermark", "startedAt"]) ||
      value.version !== VERSION || !isRoomExportIdentifier(value.exportId) ||
      value.roomId !== this.roomId || !nonnegative(value.watermark) || !timestamp(value.startedAt)) {
      invalidStream();
    }
    this.exportId = value.exportId;
    this.watermark = value.watermark;
    this.phase = "records";
    this.addContent(raw);
  }

  private record(value: JsonRecord, raw: Uint8Array): void {
    if (this.phase !== "records" || !exact(value,
      ["type", "category", "entityId", "revision", "payload"]) ||
      !(ROOM_EXPORT_CATEGORIES as readonly unknown[]).includes(value.category) ||
      !isRoomExportIdentifier(value.entityId) || !nonnegative(value.revision) ||
      !validateJson(value.payload)) invalidStream();
    this.recordCount += 1;
    if (this.recordCount > ROOM_EXPORT_LIMITS.maxRecords) invalidStream();
    const category = value.category as string;
    this.counts.set(category, (this.counts.get(category) ?? 0) + 1);
    this.addContent(raw);
  }

  private manifest(value: JsonRecord): void {
    if (this.phase !== "records" || !exact(value, [
      "type", "version", "exportId", "roomId", "watermark", "recordCount", "byteLength",
      "categories", "contentDigest", "completedAt", "manifestDigest",
    ]) || value.version !== VERSION || value.exportId !== this.exportId ||
      value.roomId !== this.roomId || value.watermark !== this.watermark ||
      value.recordCount !== this.recordCount || value.byteLength !== this.contentBytes ||
      !timestamp(value.completedAt) || typeof value.contentDigest !== "string" ||
      value.contentDigest !== this.contentHash.digest("hex") ||
      typeof value.manifestDigest !== "string" || !Array.isArray(value.categories)) invalidStream();
    const expectedCategories = [...this.counts].sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => ({ category, count }));
    const withoutDigest = { ...value };
    delete withoutDigest.manifestDigest;
    if (canonical(value.categories) !== canonical(expectedCategories) ||
        value.manifestDigest !== digest(canonical(withoutDigest))) invalidStream();
    this.phase = "manifest";
  }

  private addContent(raw: Uint8Array): void {
    this.contentBytes += raw.byteLength;
    if (this.contentBytes > ROOM_EXPORT_LIMITS.maxBytes) invalidStream();
    this.contentHash.update(raw);
  }
}

type ActiveOperation = {
  readonly abort: AbortController;
  readonly epoch: number;
  streamId?: string;
  remoteAborted: boolean;
  remoteDone: boolean;
};

export interface DesktopRoomExportRuntime {
  save(intent: RoomExportIntent): Promise<RoomExportResult>;
  invalidateAuthorizedState(): Promise<void>;
  close(): Promise<void>;
}

function closedError(error: unknown): RoomExportClosedError {
  if (error instanceof RoomExportRuntimeError) return error.roomExportError;
  if (typeof error === "object" && error !== null && "roomExportError" in error &&
      isRoomExportClosedError(error.roomExportError)) return structuredClone(error.roomExportError);
  return { status: 503, code: "storage_unavailable" };
}

function safeFilename(roomId: string, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  const safeRoom = roomId.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "")
    .slice(0, 96) || "room";
  return `dao-room-export-${safeRoom}-${date}.ndjson`;
}

export function createDesktopRoomExportRuntime(options: Readonly<{
  transport: RoomExportStreamTransport;
  saveDialog: NativeSaveDialogPort;
  fs?: NativeAtomicSaveFileSystemPort;
  randomId?: () => string;
  createRequestId: (operation: "open" | "read" | "abort") => string;
  now?: () => Date;
}>): DesktopRoomExportRuntime {
  const fs = options.fs ?? NODE_ROOM_EXPORT_ATOMIC_FILE_SYSTEM;
  const randomId = options.randomId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const active = new Set<ActiveOperation>();
  let epoch = 0;
  let closed = false;

  function assertActive(run: ActiveOperation): void {
    if (closed || run.abort.signal.aborted || run.epoch !== epoch) {
      throw new RoomExportRuntimeError({ status: 410, code: "room_export_access_revoked" });
    }
  }

  async function abortRemote(run: ActiveOperation): Promise<void> {
    if (run.streamId === undefined || run.remoteDone || run.remoteAborted) return;
    run.remoteAborted = true;
    const requestId = options.createRequestId("abort");
    await options.transport.abort({ type: "room-export.abort", requestId,
      streamId: run.streamId }).then((result) => {
      if (!isRoomExportAborted(result) || result.requestId !== requestId ||
          result.streamId !== run.streamId) invalidStream();
    }).catch(() => undefined);
  }

  const runtime: DesktopRoomExportRuntime = {
    async save(intent) {
      if (!isRoomExportIntent(intent)) throw new TypeError("Invalid Room export intent");
      if (closed) throw new RoomExportRuntimeError({ status: 410, code: "room_export_access_revoked" });
      const run: ActiveOperation = { abort: new AbortController(), epoch,
        remoteAborted: false, remoteDone: false };
      active.add(run);
      let temporaryPath: string | undefined;
      let file: NativeTemporaryFile | undefined;
      try {
        const openRequestId = options.createRequestId("open");
        // The authenticated server binds this request identity as a provisional
        // stream alias, allowing invalidate/close to preempt a pending open.
        run.streamId = openRequestId;
        const opened = await options.transport.open({ type: "room-export.open",
          requestId: openRequestId, roomId: intent.roomId });
        assertActive(run);
        if (!isRoomExportOpened(opened) || opened.requestId !== openRequestId ||
            opened.roomId !== intent.roomId || opened.chunkSize !== ROOM_EXPORT_LIMITS.maxChunkBytes) {
          invalidStream();
        }
        run.streamId = opened.streamId;
        const destinationPath = await options.saveDialog.chooseDestination(safeFilename(intent.roomId, now()));
        assertActive(run);
        if (destinationPath === undefined) {
          await abortRemote(run);
          return Object.freeze({ status: "cancelled" as const, roomId: intent.roomId });
        }
        if (typeof destinationPath !== "string" || destinationPath.length === 0) {
          throw new TypeError("Invalid native Room export destination");
        }
        const temporaryId = randomId();
        if (!/^[A-Za-z0-9-]{1,128}$/u.test(temporaryId)) {
          throw new TypeError("Invalid Room export temporary identity");
        }
        temporaryPath = `${destinationPath}.part-${temporaryId}`;
        file = await fs.openTemporary(temporaryPath);
        const verifier = new NdjsonVerifier(intent.roomId);
        let offset = 0;
        while (!run.remoteDone) {
          assertActive(run);
          const requestId = options.createRequestId("read");
          const chunk = await options.transport.read({ type: "room-export.read", requestId,
            streamId: run.streamId, offset });
          assertActive(run);
          if (!isRoomExportChunk(chunk) || chunk.requestId !== requestId ||
              chunk.streamId !== run.streamId || chunk.offset !== offset) invalidStream();
          const bytes = Uint8Array.from(Buffer.from(chunk.base64, "base64"));
          if (bytes.byteLength !== chunk.byteLength) invalidStream();
          verifier.push(bytes);
          if (bytes.byteLength > 0) await file.write(bytes);
          offset += bytes.byteLength;
          assertActive(run);
          run.remoteDone = chunk.eof;
        }
        verifier.finish();
        await file.sync();
        assertActive(run);
        await file.close();
        file = undefined;
        assertActive(run);
        await fs.rename(temporaryPath, destinationPath);
        temporaryPath = undefined;
        return Object.freeze({ status: "saved" as const, roomId: intent.roomId });
      } catch (error) {
        if (file !== undefined) await file.close().catch(() => undefined);
        if (temporaryPath !== undefined) await fs.remove(temporaryPath).catch(() => undefined);
        await abortRemote(run);
        throw new RoomExportRuntimeError(closedError(error));
      } finally {
        active.delete(run);
      }
    },
    async invalidateAuthorizedState() {
      epoch += 1;
      const operations = [...active];
      for (const run of operations) run.abort.abort();
      await Promise.all(operations.map(abortRemote));
    },
    async close() {
      if (closed) return;
      closed = true;
      await runtime.invalidateAuthorizedState();
    },
  };
  return Object.freeze(runtime);
}
