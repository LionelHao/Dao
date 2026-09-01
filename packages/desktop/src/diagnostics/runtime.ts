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
  isDiagnosticsClosedError,
  type DiagnosticsClosedError,
  type DiagnosticsSaveResult,
} from "./contracts.js";
import {
  DIAGNOSTICS_LIMITS,
  isDiagnosticsAborted,
  isDiagnosticsChunk,
  isDiagnosticsGenerated,
  type DiagnosticsAbortCommand,
  type DiagnosticsAborted,
  type DiagnosticsChunk,
  type DiagnosticsGenerateCommand,
  type DiagnosticsGenerated,
  type DiagnosticsReadCommand,
} from "./stream-contracts.js";

export interface DiagnosticsStreamTransport {
  generate(command: DiagnosticsGenerateCommand): Promise<DiagnosticsGenerated>;
  read(command: DiagnosticsReadCommand): Promise<DiagnosticsChunk>;
  abort(command: DiagnosticsAbortCommand): Promise<DiagnosticsAborted>;
}

export class DiagnosticsRuntimeError extends Error {
  readonly diagnosticsError: DiagnosticsClosedError;

  constructor(error: DiagnosticsClosedError) {
    super(`Diagnostics save failed: ${error.status} ${error.code}`);
    this.name = "DiagnosticsRuntimeError";
    this.diagnosticsError = structuredClone(error);
  }
}

export const NODE_DIAGNOSTICS_ATOMIC_FILE_SYSTEM: NativeAtomicSaveFileSystemPort =
Object.freeze<NativeAtomicSaveFileSystemPort>({
  async openTemporary(temporaryPath) {
    const descriptor = await open(temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    let closed = false;
    return Object.freeze<NativeTemporaryFile>({
      async write(bytes) {
        if (closed || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
            bytes.byteLength > DIAGNOSTICS_LIMITS.maxChunkBytes) {
          throw new TypeError("Invalid diagnostics temporary write");
        }
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await descriptor.write(bytes, written, bytes.byteLength - written);
          if (result.bytesWritten <= 0) throw new Error("Diagnostics temporary write made no progress");
          written += result.bytesWritten;
        }
      },
      async sync() {
        if (closed) throw new Error("Diagnostics temporary file is closed");
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
  async remove(temporaryPath) { await rm(temporaryPath, { force: true }); },
});

const categories = Object.freeze({
  authority: new Set(["authority_ready", "authority_degraded"]),
  cache: new Set(["cache_invalidation_queue"]),
  configuration: new Set(["configuration_present", "configuration_missing"]),
  context_manifest: new Set(["context_manifest_health"]),
  environment_capability: new Set(["capability_present", "capability_missing"]),
  error_classification: new Set(["provider_failure", "storage_failure", "protocol_failure"]),
  outbox: new Set(["authority_outbox_queue"]),
  repair: new Set(["repair_health"]),
  schema: new Set(["authority_schema_current", "current"]),
  worker: new Set(["healthy", "backlog_warning", "backlog_critical", "dead_letter", "closed"]),
} as const);

const metadataFields = Object.freeze({
  authority: new Set(["authorityVersion", "configured"]),
  cache: new Set(["deadLetterCount"]),
  configuration: new Set(["configured"]),
  context_manifest: new Set(["itemCount", "manifestVersion", "sourceCount"]),
  environment_capability: new Set(["available", "capabilityVersion"]),
  error_classification: new Set(["retryable"]),
  outbox: new Set(["deadLetterCount"]),
  repair: new Set(["recordKindCount"]),
  schema: new Set(["configured", "schemaVersion", "version"]),
  worker: new Set(["deadLetterCount", "maxActive", "maxBatch", "maxQueue"]),
} as const);

const states = new Set(["ready", "noauth", "degraded", "pending", "failed",
  "dead_letter", "closed"]);
const sensitiveToken = /(?:^|[._:-])(?:api[_-]?key|authorization|credential|password|secret|session[_-]?token|sk|token)(?:$|[._:-])/iu;
type Category = keyof typeof categories;
type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const decoder = new TextDecoder("utf-8", { fatal: true });

function canonical(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Readonly<Record<string, Json>>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key]!)}`).join(",")}}`;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function safeToken(value: unknown, maximum = 128): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) && !sensitiveToken.test(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function jsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMetadata(value: unknown, category: Category): value is Readonly<Record<string, Json>> {
  if (!jsonRecord(value)) return false;
  return Object.entries(value).every(([key, nested]) =>
    metadataFields[category].has(key as never) &&
    (nested === null || typeof nested === "boolean" ||
      typeof nested === "number" && Number.isFinite(nested) && Math.abs(nested) <= Number.MAX_SAFE_INTEGER));
}

function validEntry(value: unknown): value is Readonly<Record<string, Json>> {
  if (!jsonRecord(value) || !exact(value, ["category", "code", "occurredAt"],
    ["stableId", "state", "sizeBytes", "durationMs", "queueDepth", "attempt", "metadata"])) {
    return false;
  }
  if (typeof value.category !== "string" || !Object.hasOwn(categories, value.category)) return false;
  const category = value.category as Category;
  if (!safeToken(value.code) || !categories[category].has(value.code as never) ||
      !timestamp(value.occurredAt)) return false;
  if (value.stableId !== undefined && !safeToken(value.stableId)) return false;
  if (value.state !== undefined && (!safeToken(value.state, 64) || !states.has(value.state))) return false;
  if (![value.sizeBytes, value.durationMs, value.queueDepth, value.attempt]
    .every((item) => item === undefined || integer(item))) return false;
  return value.metadata === undefined || validMetadata(value.metadata, category);
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left); result.set(right, left.byteLength);
  return result;
}

class DiagnosticsNdjsonVerifier {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private entries = 0;

  push(chunk: Uint8Array): void {
    this.pending = append(this.pending, chunk);
    let newline = this.pending.indexOf(0x0a);
    while (newline >= 0) {
      const raw = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      this.line(raw);
      newline = this.pending.indexOf(0x0a);
    }
    if (this.pending.byteLength > DIAGNOSTICS_LIMITS.maxLineBytes) invalidArtifact();
  }

  finish(): void {
    if (this.pending.byteLength !== 0 || this.entries > DIAGNOSTICS_LIMITS.maxEntries) {
      invalidArtifact();
    }
  }

  private line(raw: Uint8Array): void {
    if (raw.byteLength <= 1 || raw.byteLength > DIAGNOSTICS_LIMITS.maxLineBytes ||
        raw[raw.byteLength - 1] !== 0x0a || raw[raw.byteLength - 2] === 0x0d) invalidArtifact();
    let text: string;
    let value: unknown;
    try {
      text = decoder.decode(raw.slice(0, -1));
      value = JSON.parse(text) as unknown;
    } catch {
      return invalidArtifact();
    }
    if (!validEntry(value) || canonical(value) !== text) invalidArtifact();
    this.entries += 1;
    if (this.entries > DIAGNOSTICS_LIMITS.maxEntries) invalidArtifact();
  }
}

function invalidArtifact(): never {
  throw new DiagnosticsRuntimeError({ status: 503, code: "diagnostics_invalid_artifact" });
}

function closedError(error: unknown): DiagnosticsClosedError {
  if (error instanceof DiagnosticsRuntimeError) return error.diagnosticsError;
  if (typeof error === "object" && error !== null && "diagnosticsError" in error &&
      isDiagnosticsClosedError(error.diagnosticsError)) return structuredClone(error.diagnosticsError);
  return { status: 503, code: "diagnostics_unavailable" };
}

type ActiveOperation = {
  readonly abort: AbortController;
  readonly epoch: number;
  streamId?: string;
  remoteDone: boolean;
  remoteAborted: boolean;
};

export interface DesktopDiagnosticsRuntime {
  save(): Promise<DiagnosticsSaveResult>;
  invalidateAuthorizedState(): Promise<void>;
  close(): Promise<void>;
}

export function createDesktopDiagnosticsRuntime(options: Readonly<{
  transport: DiagnosticsStreamTransport;
  saveDialog: NativeSaveDialogPort;
  fs?: NativeAtomicSaveFileSystemPort;
  randomId?: () => string;
  createRequestId: (operation: "generate" | "read" | "abort") => string;
}>): DesktopDiagnosticsRuntime {
  const fs = options.fs ?? NODE_DIAGNOSTICS_ATOMIC_FILE_SYSTEM;
  const randomId = options.randomId ?? randomUUID;
  const active = new Set<ActiveOperation>();
  let epoch = 0;
  let closed = false;

  function assertActive(run: ActiveOperation): void {
    if (closed || run.abort.signal.aborted || run.epoch !== epoch) {
      throw new DiagnosticsRuntimeError({ status: 410, code: "diagnostics_artifact_gone" });
    }
  }

  async function abortRemote(run: ActiveOperation): Promise<void> {
    if (run.streamId === undefined || run.remoteDone || run.remoteAborted) return;
    run.remoteAborted = true;
    const streamId = run.streamId;
    const requestId = options.createRequestId("abort");
    await options.transport.abort({ type: "diagnostics.abort", requestId,
      streamId }).then((response) => {
      if (!isDiagnosticsAborted(response) || response.requestId !== requestId ||
          response.streamId !== streamId) invalidArtifact();
    }).catch(() => undefined);
  }

  const runtime: DesktopDiagnosticsRuntime = {
    async save() {
      if (closed) {
        throw new DiagnosticsRuntimeError({ status: 410, code: "diagnostics_artifact_gone" });
      }
      const run: ActiveOperation = { abort: new AbortController(), epoch,
        remoteDone: false, remoteAborted: false };
      active.add(run);
      let temporaryPath: string | undefined;
      let file: NativeTemporaryFile | undefined;
      try {
        const generateRequestId = options.createRequestId("generate");
        // The server recognizes the request identity as a provisional stream while generation runs.
        run.streamId = generateRequestId;
        const generated = await options.transport.generate({
          type: "diagnostics.generate", requestId: generateRequestId,
        });
        assertActive(run);
        if (!isDiagnosticsGenerated(generated) || generated.requestId !== generateRequestId ||
            generated.chunkSize !== DIAGNOSTICS_LIMITS.maxChunkBytes) invalidArtifact();
        run.streamId = generated.streamId;
        const destinationPath = await options.saveDialog.chooseDestination(generated.filename);
        assertActive(run);
        if (destinationPath === undefined) {
          await abortRemote(run);
          return Object.freeze({ status: "cancelled" as const });
        }
        if (typeof destinationPath !== "string" || destinationPath.length === 0) {
          throw new TypeError("Invalid native diagnostics destination");
        }
        const temporaryId = randomId();
        if (!/^[A-Za-z0-9-]{1,128}$/u.test(temporaryId)) {
          throw new TypeError("Invalid diagnostics temporary identity");
        }
        temporaryPath = `${destinationPath}.part-${temporaryId}`;
        file = await fs.openTemporary(temporaryPath);
        const verifier = new DiagnosticsNdjsonVerifier();
        const digest = createHash("sha256");
        let offset = 0;
        while (!run.remoteDone) {
          assertActive(run);
          const requestId = options.createRequestId("read");
          const chunk = await options.transport.read({ type: "diagnostics.read", requestId,
            streamId: run.streamId, offset });
          assertActive(run);
          if (!isDiagnosticsChunk(chunk) || chunk.requestId !== requestId ||
              chunk.streamId !== run.streamId || chunk.offset !== offset ||
              chunk.byteLength === 0 && !chunk.eof ||
              offset + chunk.byteLength > generated.byteLength) invalidArtifact();
          const bytes = Uint8Array.from(Buffer.from(chunk.base64, "base64"));
          if (bytes.byteLength !== chunk.byteLength) invalidArtifact();
          verifier.push(bytes);
          digest.update(bytes);
          if (bytes.byteLength > 0) await file.write(bytes);
          offset += bytes.byteLength;
          if (chunk.eof && offset !== generated.byteLength) invalidArtifact();
          run.remoteDone = chunk.eof;
        }
        verifier.finish();
        if (offset !== generated.byteLength || digest.digest("hex") !== generated.sha256) {
          invalidArtifact();
        }
        await file.sync();
        assertActive(run);
        await file.close();
        file = undefined;
        assertActive(run);
        await fs.rename(temporaryPath, destinationPath);
        temporaryPath = undefined;
        return Object.freeze({ status: "saved" as const });
      } catch (error) {
        if (file !== undefined) await file.close().catch(() => undefined);
        if (temporaryPath !== undefined) await fs.remove(temporaryPath).catch(() => undefined);
        await abortRemote(run);
        throw new DiagnosticsRuntimeError(closedError(error));
      } finally {
        active.delete(run);
      }
    },
    async invalidateAuthorizedState() {
      epoch += 1;
      const operations = [...active];
      for (const operation of operations) operation.abort.abort();
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
