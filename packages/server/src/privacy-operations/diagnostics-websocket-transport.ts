import { createHash, randomUUID } from "node:crypto";
import {
  DIAGNOSTICS_TRANSPORT_MAX_ARTIFACT_BYTES,
  DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES,
  isDiagnosticsTransportServerFrame,
  type DiagnosticsTransportClientFrame,
  type DiagnosticsTransportServerFrame,
} from "@native-im/core";

export type DiagnosticsTransportClosedError = Readonly<{
  status: 401 | 403 | 409 | 410 | 429 | 503;
  code: "authentication_required" | "administrator_required" |
    "diagnostics_stream_conflict" | "diagnostics_artifact_gone" |
    "diagnostics_capacity_limited" | "diagnostics_invalid_artifact" |
    "diagnostics_unavailable";
  retryAfterMs?: number;
}>;

export class DiagnosticsTransportError extends Error {
  readonly diagnosticsError: DiagnosticsTransportClosedError;

  constructor(error: DiagnosticsTransportClosedError) {
    super(`Diagnostics transport failed: ${error.status} ${error.code}`);
    this.name = "DiagnosticsTransportError";
    this.diagnosticsError = Object.freeze({ ...error });
  }
}

export interface DiagnosticsAuthenticatedArtifactTransport {
  /** The outer WebSocket supplies the token from its one authenticated session. */
  generateDiagnostics(accessToken: string, signal: AbortSignal): Promise<Readonly<{
    artifactId: string;
    filename: string;
    mediaType: "application/x-ndjson";
    expiresAt: string;
    manifest: Readonly<{ byteLength: number; sha256: string }>;
  }>>;
  /** Production composition must revalidate the exact session and current Tenant Admin role. */
  readDiagnosticsArtifact(accessToken: string, artifactId: string, signal?: AbortSignal): Promise<Readonly<{
    filename: string;
    mediaType: "application/x-ndjson";
    bytes: Uint8Array;
    expiresAt: string;
  }>>;
}

type ActiveStream = {
  streamId: string;
  artifactId: string;
  filename: string;
  mediaType: "application/x-ndjson";
  byteLength: number;
  sha256: string;
  expiresAt: string;
  offset: number;
};

type PendingOperation = Readonly<{
  controller: AbortController;
  streamId: string;
}>;

function failure(error: DiagnosticsTransportClosedError): never {
  throw new DiagnosticsTransportError(error);
}

function mapped(error: unknown): never {
  if (error instanceof DiagnosticsTransportError) throw error;
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number(error.status) : undefined;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : undefined;
  if (status === 401) failure({ status: 401, code: "authentication_required" });
  if (status === 403) failure({ status: 403, code: "administrator_required" });
  if (status === 410 || status === 404) {
    failure({ status: 410, code: "diagnostics_artifact_gone" });
  }
  if (status === 429 || code === "operations_capacity_limited") {
    const retryAfterMs = typeof error === "object" && error !== null &&
      "retryAfterMs" in error && Number.isSafeInteger(error.retryAfterMs) &&
      Number(error.retryAfterMs) >= 0 ? Number(error.retryAfterMs) : undefined;
    failure({ status: 429, code: "diagnostics_capacity_limited",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }
  failure({ status: 503, code: "diagnostics_unavailable" });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function awaitAbortable<T>(source: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void source.catch(() => undefined);
    return Promise.reject(new DiagnosticsTransportError({
      status: 410, code: "diagnostics_artifact_gone",
    }));
  }
  return new Promise<T>((resolve, reject) => {
    let terminal = false;
    const onAbort = () => {
      if (terminal) return;
      terminal = true;
      signal.removeEventListener("abort", onAbort);
      reject(new DiagnosticsTransportError({ status: 410, code: "diagnostics_artifact_gone" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    source.then((value) => {
      if (terminal) return;
      terminal = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error: unknown) => {
      if (terminal) return;
      terminal = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

/**
 * Connection-private diagnostics state. It creates no listener, scheduler, or persistence writer;
 * the production Message Authority WebSocket owns authentication and lifecycle.
 */
export function createDiagnosticsWebSocketConnection(options: Readonly<{
  authority: DiagnosticsAuthenticatedArtifactTransport;
  createStreamId?: () => string;
}>): Readonly<{
  handle(accessToken: string, frame: DiagnosticsTransportClientFrame):
    Promise<DiagnosticsTransportServerFrame>;
  close(): void;
  inspect(): Readonly<{ active: number; generating: boolean; closed: boolean }>;
  matchesAbort(streamId: string): boolean;
}> {
  const createStreamId = options.createStreamId ?? (() => `diagnostics-stream-${randomUUID()}`);
  let active: ActiveStream | undefined;
  let generation: PendingOperation | undefined;
  let reading: PendingOperation | undefined;
  let closed = false;

  function requireOpen(): void {
    if (closed) failure({ status: 410, code: "diagnostics_artifact_gone" });
  }

  async function generate(
    accessToken: string,
    frame: Extract<DiagnosticsTransportClientFrame, { type: "diagnostics.generate" }>,
  ): Promise<DiagnosticsTransportServerFrame> {
    requireOpen();
    if (active !== undefined || generation !== undefined) {
      failure({ status: 429, code: "diagnostics_capacity_limited" });
    }
    const pending: PendingOperation = {
      controller: new AbortController(), streamId: frame.requestId,
    };
    generation = pending;
    try {
      const result = await awaitAbortable(
        options.authority.generateDiagnostics(accessToken, pending.controller.signal),
        pending.controller.signal,
      ).catch(mapped);
      requireOpen();
      if (pending.controller.signal.aborted) {
        failure({ status: 410, code: "diagnostics_artifact_gone" });
      }
      const streamId = createStreamId();
      const candidate = Object.freeze({
        type: "diagnostics.generated" as const,
        requestId: frame.requestId,
        streamId,
        artifactId: result.artifactId,
        filename: result.filename,
        mediaType: result.mediaType,
        byteLength: result.manifest.byteLength,
        sha256: result.manifest.sha256,
        expiresAt: result.expiresAt,
        chunkSize: DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES,
      });
      if (!isDiagnosticsTransportServerFrame(candidate)) {
        failure({ status: 503, code: "diagnostics_invalid_artifact" });
      }
      active = {
        streamId, artifactId: candidate.artifactId, filename: candidate.filename,
        mediaType: candidate.mediaType, byteLength: candidate.byteLength,
        sha256: candidate.sha256, expiresAt: candidate.expiresAt, offset: 0,
      };
      return candidate;
    } finally {
      if (generation === pending) generation = undefined;
    }
  }

  async function read(
    accessToken: string,
    frame: Extract<DiagnosticsTransportClientFrame, { type: "diagnostics.read" }>,
  ): Promise<DiagnosticsTransportServerFrame> {
    requireOpen();
    const current = active;
    if (current === undefined || current.streamId !== frame.streamId) {
      failure({ status: 410, code: "diagnostics_artifact_gone" });
    }
    if (reading !== undefined || frame.offset !== current.offset) {
      failure({ status: 409, code: "diagnostics_stream_conflict" });
    }
    const pending: PendingOperation = {
      controller: new AbortController(), streamId: current.streamId,
    };
    reading = pending;
    try {
      let artifact: Awaited<ReturnType<
        DiagnosticsAuthenticatedArtifactTransport["readDiagnosticsArtifact"]
      >>;
      try {
        artifact = await awaitAbortable(options.authority.readDiagnosticsArtifact(
          accessToken, current.artifactId, pending.controller.signal,
        ), pending.controller.signal);
      } catch (error) {
        active = undefined;
        mapped(error);
      }
      if ((!(artifact.bytes instanceof Uint8Array) && !Buffer.isBuffer(artifact.bytes)) ||
        artifact.bytes.byteLength > DIAGNOSTICS_TRANSPORT_MAX_ARTIFACT_BYTES ||
        artifact.bytes.byteLength !== current.byteLength || artifact.filename !== current.filename ||
        artifact.mediaType !== current.mediaType || artifact.expiresAt !== current.expiresAt ||
        hash(artifact.bytes) !== current.sha256) {
      active = undefined;
      failure({ status: 503, code: "diagnostics_invalid_artifact" });
    }
      const end = Math.min(frame.offset + DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES,
        artifact.bytes.byteLength);
      const bytes = artifact.bytes.subarray(frame.offset, end);
      const response = Object.freeze({
        type: "diagnostics.chunk" as const,
        requestId: frame.requestId,
        streamId: current.streamId,
        offset: frame.offset,
        byteLength: bytes.byteLength,
        base64: Buffer.from(bytes).toString("base64"),
        eof: end === artifact.bytes.byteLength,
      });
      if (!isDiagnosticsTransportServerFrame(response)) {
        active = undefined;
        failure({ status: 503, code: "diagnostics_invalid_artifact" });
      }
      if (response.eof) active = undefined;
      else current.offset = end;
      return response;
    } finally {
      if (reading === pending) reading = undefined;
    }
  }

  return Object.freeze({
    handle(accessToken, frame) {
      if (frame.type === "diagnostics.generate") return generate(accessToken, frame);
      if (frame.type === "diagnostics.read") return read(accessToken, frame);
      requireOpen();
      if (generation?.streamId === frame.streamId) {
        generation.controller.abort(new Error("diagnostics generation aborted"));
        return Promise.resolve(Object.freeze({
          type: "diagnostics.aborted" as const,
          requestId: frame.requestId,
          streamId: frame.streamId,
        }));
      }
      if (active === undefined || active.streamId !== frame.streamId) {
        failure({ status: 410, code: "diagnostics_artifact_gone" });
      }
      if (reading?.streamId === frame.streamId) {
        reading.controller.abort(new Error("diagnostics read aborted"));
      }
      active = undefined;
      return Promise.resolve(Object.freeze({
        type: "diagnostics.aborted" as const,
        requestId: frame.requestId,
        streamId: frame.streamId,
      }));
    },
    close() {
      if (closed) return;
      closed = true;
      generation?.controller.abort(new Error("diagnostics WebSocket closed"));
      generation = undefined;
      reading?.controller.abort(new Error("diagnostics WebSocket closed"));
      reading = undefined;
      active = undefined;
    },
    inspect: () => Object.freeze({ active: active === undefined ? 0 : 1,
      generating: generation !== undefined, closed }),
    matchesAbort: (streamId) => generation?.streamId === streamId || active?.streamId === streamId,
  });
}
