import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuthenticationService } from "../auth.js";
import type { CompleteWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import {
  createDiagnosticsAuthorityWorkerAdapter,
  createRoomExportAuthorityWorkerPorts,
  type DiagnosticsArtifactStore,
  type PrivacyOperationsMetadataAuditRecord,
  type PrivacyOperationsMetadataAuditSink,
} from "./data-authority-worker-adapters.js";
import { DIAGNOSTICS_MAX_BYTES } from "./diagnostics.js";
import {
  createPrivacyOperationsProductionIntegration,
  type PrivacyOperationsProductionIntegration,
} from "./production-integration.js";

const MAX_ARTIFACTS = 128;
const MAX_ARTIFACT_STORAGE_BYTES = 32 * 1_048_576;
const MAX_AUDIT_BYTES = 64 * 1_048_576;
const DIAGNOSTICS_SWEEP_BATCH = 32;
const DIAGNOSTICS_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const DIAGNOSTICS_SWEEP_RETRY_MS = 1_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

type ArtifactStoreLimits = Readonly<{
  maxArtifacts?: number;
  maxStorageBytes?: number;
}>;

type ArtifactMetadata = Readonly<{
  artifactId: string;
  actorId: string;
  sessionFamilyId: string;
  sessionId: string;
  filename: string;
  mediaType: "application/x-ndjson";
  byteLength: number;
  expiresAtMs: number;
}>;

function artifactPath(root: string, artifactId: string): string {
  return join(root, `${artifactId}.ndjson`);
}

function metadataPath(root: string, artifactId: string): string {
  return join(root, `${artifactId}.json`);
}

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  });
}

export interface ServerPrivateDiagnosticsArtifactStore extends DiagnosticsArtifactStore {
  sweepExpired(input: Readonly<{ nowMs: number; limit: number }>): Promise<Readonly<{
    removed: number;
    hasMore: boolean;
  }>>;
  read(input: Readonly<{
    actorId: string;
    sessionFamilyId: string;
    sessionId: string;
    artifactId: string;
    nowMs: number;
  }>): Promise<Readonly<{
    filename: string;
    mediaType: "application/x-ndjson";
    bytes: Uint8Array;
    expiresAtMs: number;
  }>>;
}

export async function createDiagnosticsArtifactMaintenance(
  artifacts: Pick<ServerPrivateDiagnosticsArtifactStore, "sweepExpired">,
  startupNowMs: number,
): Promise<Readonly<{ run(nowMs: number): Promise<Readonly<{
  status: "not_due" | "swept";
  removed: number;
  hasMore: boolean;
}>> }>> {
  if (!Number.isSafeInteger(startupNowMs) || startupNowMs < 0) {
    throw new RangeError("Privacy maintenance clock is invalid");
  }
  const startupSweep = await artifacts.sweepExpired({
    nowMs: startupNowMs,
    limit: DIAGNOSTICS_SWEEP_BATCH,
  });
  let hasMore = startupSweep.hasMore;
  let nextSweepAtMs = startupNowMs +
    (startupSweep.hasMore ? DIAGNOSTICS_SWEEP_RETRY_MS : DIAGNOSTICS_SWEEP_INTERVAL_MS);
  return Object.freeze({
    async run(nowMs: number) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new RangeError("Privacy maintenance clock is invalid");
      }
      if (nowMs < nextSweepAtMs) {
        return Object.freeze({ status: "not_due" as const, removed: 0, hasMore });
      }
      try {
        const result = await artifacts.sweepExpired({
          nowMs,
          limit: DIAGNOSTICS_SWEEP_BATCH,
        });
        hasMore = result.hasMore;
        nextSweepAtMs = nowMs +
          (result.hasMore ? DIAGNOSTICS_SWEEP_RETRY_MS : DIAGNOSTICS_SWEEP_INTERVAL_MS);
        return Object.freeze({ status: "swept" as const, ...result });
      } catch (error) {
        nextSweepAtMs = nowMs + DIAGNOSTICS_SWEEP_RETRY_MS;
        throw error;
      }
    },
  });
}

export async function createServerPrivateDiagnosticsArtifactStore(
  root: string,
  limits: ArtifactStoreLimits = {},
): Promise<ServerPrivateDiagnosticsArtifactStore> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const maxArtifacts = limits.maxArtifacts ?? MAX_ARTIFACTS;
  const maxStorageBytes = limits.maxStorageBytes ?? MAX_ARTIFACT_STORAGE_BYTES;
  if (!Number.isSafeInteger(maxArtifacts) || maxArtifacts < 1 ||
      !Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < DIAGNOSTICS_MAX_BYTES) {
    throw new RangeError("Diagnostics artifact storage limits are invalid");
  }
  const metadata = new Map<string, ArtifactMetadata>();

  function isMetadata(value: unknown, artifactId: string): value is ArtifactMetadata {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 8 && record.artifactId === artifactId &&
      SAFE_ID.test(artifactId) && typeof record.actorId === "string" && SAFE_ID.test(record.actorId) &&
      typeof record.sessionFamilyId === "string" && SAFE_ID.test(record.sessionFamilyId) &&
      typeof record.sessionId === "string" && SAFE_ID.test(record.sessionId) &&
      typeof record.filename === "string" && Buffer.byteLength(record.filename, "utf8") <= 256 &&
      record.mediaType === "application/x-ndjson" &&
      Number.isSafeInteger(record.byteLength) && Number(record.byteLength) >= 0 &&
      Number(record.byteLength) <= DIAGNOSTICS_MAX_BYTES &&
      Number.isSafeInteger(record.expiresAtMs) && Number(record.expiresAtMs) >= 0;
  }

  async function load(artifactId: string): Promise<ArtifactMetadata | undefined> {
    const cached = metadata.get(artifactId);
    if (cached !== undefined) return cached;
    try {
      const parsed: unknown = JSON.parse(await readFile(metadataPath(root, artifactId), "utf8"));
      if (!isMetadata(parsed, artifactId)) return undefined;
      metadata.set(artifactId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  async function discardId(artifactId: string): Promise<void> {
    metadata.delete(artifactId);
    await Promise.all([
      removeIfPresent(artifactPath(root, artifactId)),
      removeIfPresent(metadataPath(root, artifactId)),
    ]);
  }

  const entries = await readdir(root);
  const sidecarIds = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith(".tmp")) {
      await removeIfPresent(join(root, entry));
      continue;
    }
    if (!entry.endsWith(".json")) continue;
    const artifactId = entry.slice(0, -".json".length);
    const record = await load(artifactId);
    if (record === undefined) throw new Error("Diagnostics artifact metadata is corrupt");
    sidecarIds.add(artifactId);
    const data = await stat(artifactPath(root, artifactId)).catch(() => undefined);
    if (data === undefined || !data.isFile() || data.size !== record.byteLength) {
      throw new Error("Diagnostics artifact data is corrupt");
    }
  }
  for (const entry of entries) {
    if (!entry.endsWith(".ndjson")) continue;
    const artifactId = entry.slice(0, -".ndjson".length);
    if (!sidecarIds.has(artifactId)) await removeIfPresent(join(root, entry));
  }
  const initialBytes = [...metadata.values()].reduce((sum, record) => sum + record.byteLength, 0);
  if (metadata.size > maxArtifacts || initialBytes > maxStorageBytes) {
    throw new RangeError("Diagnostics artifact storage is over its closed bound");
  }

  let mutation = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutation.then(operation, operation);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async function sweepExpired(nowMs: number, limit: number): Promise<Readonly<{
    removed: number;
    hasMore: boolean;
  }>> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > DIAGNOSTICS_SWEEP_BATCH) {
      throw new RangeError("Diagnostics artifact sweep bounds are invalid");
    }
    let removed = 0;
    for (const current of metadata.values()) {
      if (current.expiresAtMs > nowMs) continue;
      if (removed >= limit) break;
      await discardId(current.artifactId);
      removed += 1;
    }
    const hasMore = [...metadata.values()].some((current) => current.expiresAtMs <= nowMs);
    return Object.freeze({ removed, hasMore });
  }

  return Object.freeze({
    commit(input: Parameters<DiagnosticsArtifactStore["commit"]>[0]) {
      return exclusive(async () => {
      if (input.bytes.byteLength > DIAGNOSTICS_MAX_BYTES ||
          input.manifest.byteLength !== input.bytes.byteLength) {
        throw new RangeError("Diagnostics artifact exceeds its closed bound");
      }
      await sweepExpired(Date.now(), DIAGNOSTICS_SWEEP_BATCH);
      let totalBytes = 0;
      for (const current of metadata.values()) {
        totalBytes += current.byteLength;
      }
      if (metadata.size >= maxArtifacts || totalBytes + input.bytes.byteLength > maxStorageBytes) {
        throw new RangeError("Diagnostics artifact storage is full");
      }
      const artifactId = `diagnostics-${randomUUID()}`;
      const record: ArtifactMetadata = Object.freeze({
        artifactId,
        actorId: input.principal.actorId,
        sessionFamilyId: input.principal.sessionFamilyId,
        sessionId: input.principal.sessionId,
        filename: input.filename,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
        expiresAtMs: input.expiresAtMs,
      });
      const nonce = randomUUID();
      const dataTemp = join(root, `.${artifactId}.${nonce}.data.tmp`);
      const metadataTemp = join(root, `.${artifactId}.${nonce}.meta.tmp`);
      try {
        const data = await open(dataTemp, "wx", 0o600);
        try { await data.writeFile(input.bytes); await data.sync(); } finally { await data.close(); }
        const meta = await open(metadataTemp, "wx", 0o600);
        try { await meta.writeFile(JSON.stringify(record), "utf8"); await meta.sync(); } finally { await meta.close(); }
        await rename(dataTemp, artifactPath(root, artifactId));
        await rename(metadataTemp, metadataPath(root, artifactId));
        metadata.set(artifactId, record);
        return Object.freeze({ artifactId, byteLength: input.bytes.byteLength });
      } catch (error) {
        await Promise.all([
          removeIfPresent(dataTemp),
          removeIfPresent(metadataTemp),
          removeIfPresent(artifactPath(root, artifactId)),
          removeIfPresent(metadataPath(root, artifactId)),
        ]);
        throw error;
      }
      });
    },
    discard(input: Parameters<DiagnosticsArtifactStore["discard"]>[0]) {
      return exclusive(async () => {
      const record = await load(input.artifactId);
      if (record !== undefined && (record.actorId !== input.principal.actorId ||
          record.sessionFamilyId !== input.principal.sessionFamilyId ||
          record.sessionId !== input.principal.sessionId)) {
        throw new Error("Diagnostics artifact binding changed");
      }
      await discardId(input.artifactId);
      });
    },
    read(input: Parameters<ServerPrivateDiagnosticsArtifactStore["read"]>[0]) {
      return exclusive(async () => {
      const record = await load(input.artifactId);
      if (record === undefined || record.actorId !== input.actorId ||
          record.sessionFamilyId !== input.sessionFamilyId || record.sessionId !== input.sessionId) {
        throw Object.assign(new Error("Diagnostics artifact is unavailable"), { status: 404 });
      }
      if (record.expiresAtMs <= input.nowMs) {
        await discardId(record.artifactId);
        throw Object.assign(new Error("Diagnostics artifact expired"), { status: 410 });
      }
      const bytes = await readFile(artifactPath(root, record.artifactId));
      if (bytes.byteLength !== record.byteLength || bytes.byteLength > DIAGNOSTICS_MAX_BYTES) {
        await discardId(record.artifactId);
        throw Object.assign(new Error("Diagnostics artifact is corrupt"), { status: 503 });
      }
      return Object.freeze({
        filename: record.filename,
        mediaType: record.mediaType,
        bytes: new Uint8Array(bytes),
        expiresAtMs: record.expiresAtMs,
      });
      });
    },
    sweepExpired(input: Parameters<ServerPrivateDiagnosticsArtifactStore["sweepExpired"]>[0]) {
      return exclusive(() => sweepExpired(input.nowMs, input.limit));
    },
  });
}

export async function createPrivacyOperationsMetadataAuditFileSink(
  path: string,
  options: Readonly<{ maxBytes?: number }> = {},
): Promise<PrivacyOperationsMetadataAuditSink> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const maxBytes = options.maxBytes ?? MAX_AUDIT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Privacy audit storage limit is invalid");
  }
  let mutation = Promise.resolve();
  function containsForbiddenKey(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    if (Array.isArray(value)) return value.some(containsForbiddenKey);
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
      /^(bytes|payload|body|credential|secret|sessionToken|providerRequest|providerResponse)$/iu
        .test(key) || containsForbiddenKey(nested));
  }
  return Object.freeze({
    async append(record: PrivacyOperationsMetadataAuditRecord) {
      const previous = mutation;
      let release!: () => void;
      mutation = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
      const serialized = `${JSON.stringify(record)}\n`;
      if (containsForbiddenKey(record)) {
        throw new TypeError("Privacy audit contains forbidden material");
      }
      const current = await stat(path).catch(() => undefined);
      if ((current?.size ?? 0) + Buffer.byteLength(serialized) > maxBytes) {
        throw Object.assign(new Error("Privacy audit storage is full"), { status: 503 });
      }
      const file = await open(path, "a", 0o600);
      try { await file.writeFile(serialized, "utf8"); await file.sync(); } finally { await file.close(); }
      } finally {
        release();
      }
    },
  });
}

export interface AuthenticatedPrivacyOperationsTransport {
  generateDiagnostics(accessToken: string, signal?: AbortSignal):
    ReturnType<PrivacyOperationsProductionIntegration["generateDiagnostics"]>;
  readDiagnosticsArtifact(accessToken: string, artifactId: string): Promise<Readonly<{
    filename: string;
    mediaType: "application/x-ndjson";
    bytes: Uint8Array;
    expiresAt: string;
  }>>;
  streamRoomExport(accessToken: string, roomId: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  runMaintenance(nowMs: number): Promise<Readonly<{
    status: "not_due" | "swept";
    removed: number;
    hasMore: boolean;
  }>>;
  close(): Promise<void>;
}

export async function createAuthenticatedPrivacyOperationsTransport(options: Readonly<{
  auth: Pick<AuthenticationService, "authenticateSession">;
  worker: CompleteWorkerDatabaseClient;
  artifactRoot: string;
  auditPath: string;
}>): Promise<AuthenticatedPrivacyOperationsTransport> {
  const artifacts = await createServerPrivateDiagnosticsArtifactStore(options.artifactRoot);
  const diagnosticsMaintenance = await createDiagnosticsArtifactMaintenance(artifacts, Date.now());
  const audit = await createPrivacyOperationsMetadataAuditFileSink(options.auditPath);
  const diagnosticsAuthority = createDiagnosticsAuthorityWorkerAdapter({
    worker: options.worker,
    artifacts,
    audit,
  });
  const runtime = createPrivacyOperationsProductionIntegration({
    diagnosticsAuthority,
    roomExportAuthority: createRoomExportAuthorityWorkerPorts({ worker: options.worker, audit }),
    retentionBatchPort: options.worker,
  });

  async function session(accessToken: string) {
    if (Buffer.byteLength(accessToken, "utf8") > 4096 || accessToken.length === 0) {
      throw Object.assign(new Error("Authentication is required"), { status: 401 });
    }
    return options.auth.authenticateSession(accessToken);
  }

  return Object.freeze({
    async generateDiagnostics(accessToken: string, signal?: AbortSignal) {
      const current = await session(accessToken);
      return runtime.generateDiagnostics({
        actorId: current.principal.actorId,
        sessionFamilyId: current.sessionFamilyId,
        sessionId: current.sessionId,
      }, signal);
    },
    async readDiagnosticsArtifact(accessToken: string, artifactId: string) {
      if (!SAFE_ID.test(artifactId)) throw Object.assign(new Error("Artifact is invalid"), { status: 400 });
      const current = await session(accessToken);
      try {
        await diagnosticsAuthority.authorize({
          actorId: current.principal.actorId,
          sessionFamilyId: current.sessionFamilyId,
          sessionId: current.sessionId,
        });
      } catch {
        throw Object.assign(new Error("Tenant Administrator authorization is required"), {
          status: 403,
          code: "administrator_required",
        });
      }
      const artifact = await artifacts.read({
        actorId: current.principal.actorId,
        sessionFamilyId: current.sessionFamilyId,
        sessionId: current.sessionId,
        artifactId,
        nowMs: Date.now(),
      });
      return Object.freeze({ ...artifact, expiresAt: new Date(artifact.expiresAtMs).toISOString() });
    },
    async *streamRoomExport(accessToken: string, roomId: string, signal?: AbortSignal) {
      if (!SAFE_ID.test(roomId)) throw Object.assign(new Error("Room is invalid"), { status: 400 });
      const current = await session(accessToken);
      for await (const chunk of runtime.streamRoomExport({
        actorId: current.principal.actorId,
        sessionFamilyId: current.sessionFamilyId,
        sessionId: current.sessionId,
        roomId,
      }, signal)) yield chunk;
    },
    async runMaintenance(nowMs: number) {
      return diagnosticsMaintenance.run(nowMs);
    },
    async close() { await runtime.shutdown(); },
  });
}
