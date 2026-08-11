import { realpath } from "node:fs/promises";
import { dirname, join, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  isRoomRepairPage,
  isWorkspaceBootstrapPage,
  type RoomRepairPage,
  type WorkspaceBootstrapPage,
} from "@native-im/core";
import type {
  AuthenticatedSessionContext,
  MaterializedSnapshotManifest,
  SnapshotFallbackReason,
  SnapshotMaterializedPage,
  SnapshotRevalidationRequest,
  SnapshotWorkerErrorCode,
  SnapshotWorkerRequest,
  SnapshotWorkerResponse,
} from "./contracts.js";
import { SNAPSHOT_REQUEST_ID_MAX_BYTES } from "./contracts.js";

export const SNAPSHOT_MAX_CONCURRENT_BUILDS = 1;
export const SNAPSHOT_QUEUE_LIMIT = 16;
export const SNAPSHOT_SCAN_BATCH_SIZE = 200;
export const SNAPSHOT_DEFAULT_TTL_MS = 5 * 60_000;
export const SNAPSHOT_REUSE_MIN_REMAINING_MS = 60_000;
export const SNAPSHOT_CACHE_QUOTA_BYTES = 512 * 1_024 * 1_024;
export const SNAPSHOT_BUILD_DEADLINE_MS = 60_000;
export const SNAPSHOT_MAX_WAL_GROWTH_BYTES = 128 * 1_024 * 1_024;
export const SNAPSHOT_MAX_RECORDS_PER_PAGE = 100;
export const SNAPSHOT_MAX_PAGE_BYTES = 256 * 1_024;
export const SNAPSHOT_MAX_REQUEST_ID_BYTES = SNAPSHOT_REQUEST_ID_MAX_BYTES;

export interface SnapshotWorkerSafetyLimits {
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
}

const DEFAULT_LIMITS: SnapshotWorkerSafetyLimits = {
  maxConcurrentBuilds: SNAPSHOT_MAX_CONCURRENT_BUILDS,
  queueLimit: SNAPSHOT_QUEUE_LIMIT,
  scanBatchSize: SNAPSHOT_SCAN_BATCH_SIZE,
  ttlMs: SNAPSHOT_DEFAULT_TTL_MS,
  reuseMinRemainingMs: SNAPSHOT_REUSE_MIN_REMAINING_MS,
  cacheQuotaBytes: SNAPSHOT_CACHE_QUOTA_BYTES,
  buildDeadlineMs: SNAPSHOT_BUILD_DEADLINE_MS,
  maxWalGrowthBytes: SNAPSHOT_MAX_WAL_GROWTH_BYTES,
  maxRecordsPerPage: SNAPSHOT_MAX_RECORDS_PER_PAGE,
  maxPageBytes: SNAPSHOT_MAX_PAGE_BYTES,
};

export interface SnapshotMaterializationFallback {
  readonly kind: "fallback";
  readonly reason: SnapshotFallbackReason;
}

export type SnapshotRoomBeginResult = RoomRepairPage | SnapshotMaterializationFallback;
export type SnapshotCatalogBeginResult = WorkspaceBootstrapPage | SnapshotMaterializationFallback;

export interface SnapshotWorkerClient {
  beginRoomRepair(
    context: AuthenticatedSessionContext,
    requestId: string,
    roomId: string,
  ): Promise<SnapshotRoomBeginResult>;
  readRoomRepairPage(
    context: AuthenticatedSessionContext,
    requestId: string,
    snapshotId: string,
    afterPage: number,
  ): Promise<RoomRepairPage>;
  beginWorkspaceBootstrap(
    context: AuthenticatedSessionContext,
    requestId: string,
  ): Promise<SnapshotCatalogBeginResult>;
  readWorkspaceBootstrapPage(
    context: AuthenticatedSessionContext,
    requestId: string,
    snapshotId: string,
    afterPage: number,
  ): Promise<WorkspaceBootstrapPage>;
  close(): Promise<void>;
}

export interface SnapshotWorkerTransport {
  postMessage(message: SnapshotWorkerRequest): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "messageerror" | "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
  terminate(): Promise<number>;
}

export interface CreateSnapshotWorkerClientOptions {
  readonly authorityPath: string;
  readonly cachePath: string;
  readonly revalidate: (request: SnapshotRevalidationRequest) => Promise<void>;
  readonly clock?: () => number;
  readonly limits?: Partial<SnapshotWorkerSafetyLimits>;
}

export type SnapshotWorkerClientErrorCode = SnapshotWorkerErrorCode
  | "snapshot_busy"
  | "snapshot_worker_closed"
  | "snapshot_worker_error"
  | "snapshot_worker_exited"
  | "snapshot_worker_message_error"
  | "snapshot_worker_protocol_error";

export class SnapshotWorkerClientError extends Error {
  readonly status: number;

  constructor(readonly code: SnapshotWorkerClientErrorCode, message: string) {
    super(message);
    this.name = "SnapshotWorkerClientError";
    this.status = snapshotErrorStatus(code);
  }
}

function snapshotErrorStatus(code: SnapshotWorkerClientErrorCode): number {
  switch (code) {
    case "invalid_request": return 400;
    case "invalid_token":
    case "token_expired": return 401;
    case "room_forbidden":
    case "session_revoked":
    case "snapshot_family_revoked":
    case "snapshot_forbidden": return 403;
    case "room_not_found":
    case "snapshot_not_found": return 404;
    case "room_archived":
    case "snapshot_stale": return 409;
    case "snapshot_expired": return 410;
    case "snapshot_busy": return 429;
    default: return 503;
  }
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && Number.isFinite(value) && value > 0;
}

function resolveLimits(
  input: Partial<SnapshotWorkerSafetyLimits> | undefined,
): SnapshotWorkerSafetyLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!positiveSafeInteger(value)) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxConcurrentBuilds !== 1) {
    throw new TypeError("maxConcurrentBuilds must remain fixed at one");
  }
  if (limits.queueLimit !== SNAPSHOT_QUEUE_LIMIT) {
    throw new TypeError("queueLimit must remain fixed at sixteen");
  }
  if (limits.reuseMinRemainingMs > limits.ttlMs) {
    throw new TypeError("reuseMinRemainingMs must not exceed ttlMs");
  }
  return limits;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validResponseRequestId(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes > 0 && bytes <= SNAPSHOT_REQUEST_ID_MAX_BYTES;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isManifest(value: unknown): value is MaterializedSnapshotManifest {
  if (!isRecord(value) || !text(value.snapshotId) || !text(value.principalId) ||
      !text(value.sessionFamilyId) || !text(value.checksum) || !count(value.pageCount) ||
      value.pageCount < 1 || !text(value.expiresAt)) {
    return false;
  }
  if (value.kind === "room") {
    return exact(value, ["snapshotId", "principalId", "sessionFamilyId", "checksum",
      "pageCount", "expiresAt", "kind", "roomId", "accessRevision", "watermark"]) &&
      text(value.roomId) && count(value.accessRevision) && count(value.watermark);
  }
  return value.kind === "catalog" && exact(value, ["snapshotId", "principalId",
    "sessionFamilyId", "checksum", "pageCount", "expiresAt", "kind",
    "catalogRevision"]) && count(value.catalogRevision);
}

function isWorkerErrorCode(value: unknown): value is SnapshotWorkerErrorCode {
  return typeof value === "string" && [
    "invalid_request", "invalid_token", "token_expired", "session_revoked",
    "snapshot_family_revoked",
    "snapshot_expired", "snapshot_forbidden", "snapshot_not_found",
    "snapshot_stale", "room_archived", "room_forbidden", "room_not_found",
    "storage_unavailable",
  ].includes(value);
}

function isWorkerResponse(value: unknown): value is SnapshotWorkerResponse {
  if (!isRecord(value) || !text(value.type) || !text(value.requestId)) return false;
  if (value.type === "snapshot.ready" || value.type === "snapshot.closed" ||
      value.type === "snapshot.invalidated") {
    return exact(value, ["type", "requestId"]);
  }
  if (value.type === "snapshot.page") {
    return exact(value, ["type", "requestId", "page", "manifest"]) &&
      (isRoomRepairPage(value.page) || isWorkspaceBootstrapPage(value.page)) &&
      isManifest(value.manifest) && value.page.snapshotId === value.manifest.snapshotId;
  }
  if (value.type === "snapshot.fallback") {
    return exact(value, ["type", "requestId", "reason"]) &&
      (value.reason === "quota" || value.reason === "deadline" ||
        value.reason === "wal-growth");
  }
  if (value.type === "snapshot.cache-count" || value.type === "snapshot.full-validation-count") {
    return exact(value, ["type", "requestId", "count"]) && count(value.count);
  }
  return value.type === "snapshot.error" &&
    exact(value, ["type", "requestId", "code", "message"]) &&
    isWorkerErrorCode(value.code) && text(value.message);
}

function snapshotWorkerUrl(): URL {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol !== "file:") {
    return pathToFileURL(resolve(process.cwd(), "packages/server/dist/persistence/snapshot-worker.js"));
  }
  if (moduleUrl.pathname.endsWith(".ts")) {
    return new URL("../../dist/persistence/snapshot-worker.js", moduleUrl);
  }
  return new URL("./snapshot-worker.js", moduleUrl);
}

interface Pending {
  readonly requestType: SnapshotWorkerRequest["type"];
  readonly command: SnapshotWorkerCommand;
  readonly expectedKind?: "room" | "catalog";
  readonly resolve: (response: SnapshotWorkerResponse) => void;
  readonly reject: (error: SnapshotWorkerClientError) => void;
}

interface BuildWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: SnapshotWorkerClientError) => void;
}

class ProcessBuildCoordinator {
  #active = false;
  readonly #waiters: BuildWaiter[] = [];

  constructor(readonly queueLimit: number) {}

  acquire(): Promise<() => void> {
    if (!this.#active) {
      this.#active = true;
      return Promise.resolve(this.#releaseOnce());
    }
    if (this.#waiters.length >= this.queueLimit) {
      return Promise.reject(new SnapshotWorkerClientError(
        "snapshot_busy", "Snapshot worker queue is full"));
    }
    return new Promise((resolvePermit, reject) => {
      this.#waiters.push({ resolve: resolvePermit, reject });
    });
  }

  run(task: () => Promise<SnapshotWorkerResponse>): Promise<SnapshotWorkerResponse> {
    return this.acquire().then(async (release) => {
      try { return await task(); } finally { release(); }
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next === undefined) {
        this.#active = false;
      } else {
        next.resolve(this.#releaseOnce());
      }
    };
  }
}

class ProcessInitializationCoordinator {
  #active = false;
  readonly #waiters: Array<(release: () => void) => void> = [];

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.#acquire();
    try { return await task(); } finally { release(); }
  }

  #acquire(): Promise<() => void> {
    if (!this.#active) {
      this.#active = true;
      return Promise.resolve(this.#releaseOnce());
    }
    return new Promise((resolvePermit) => this.#waiters.push(resolvePermit));
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next === undefined) this.#active = false;
      else next(this.#releaseOnce());
    };
  }
}

const globalProcessBuildCoordinator = new ProcessBuildCoordinator(SNAPSHOT_QUEUE_LIMIT);
interface InitializationRegistration {
  readonly coordinator: ProcessInitializationCoordinator;
  clients: number;
}
const initializationCoordinators = new Map<string, InitializationRegistration>();

function registerInitialization(cachePath: string): {
  readonly coordinator: ProcessInitializationCoordinator;
  readonly unregister: () => void;
} {
  let registration = initializationCoordinators.get(cachePath);
  if (registration === undefined) {
    registration = { coordinator: new ProcessInitializationCoordinator(), clients: 0 };
    initializationCoordinators.set(cachePath, registration);
  }
  registration.clients += 1;
  let registered = true;
  return { coordinator: registration.coordinator, unregister: () => {
    if (!registered) return;
    registered = false;
    registration.clients -= 1;
    if (registration.clients === 0 &&
        initializationCoordinators.get(cachePath) === registration) {
      initializationCoordinators.delete(cachePath);
    }
  } };
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    try {
      return join(await realpath(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

async function processCoordinator(
  authorityPath: string,
  cachePath: string,
  queueLimit: number,
): Promise<{ readonly coordinator: ProcessBuildCoordinator; readonly authorityPath: string;
  readonly cachePath: string }> {
  const [canonicalAuthority, canonicalCache] = await Promise.all([
    canonicalPath(authorityPath), canonicalPath(cachePath),
  ]);
  if (queueLimit !== SNAPSHOT_QUEUE_LIMIT) {
    throw new TypeError("queueLimit must remain fixed at sixteen");
  }
  return { coordinator: globalProcessBuildCoordinator,
    authorityPath: canonicalAuthority, cachePath: canonicalCache };
}

type SnapshotWorkerCommand = SnapshotWorkerRequest extends infer Request
  ? Request extends SnapshotWorkerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

class SnapshotWorkerClientImplementation implements SnapshotWorkerClient {
  readonly #pending = new Map<string, Pending>();
  readonly #worker: SnapshotWorkerTransport;
  readonly #revalidate: CreateSnapshotWorkerClientOptions["revalidate"];
  readonly #clock: () => number;
  readonly #limits: SnapshotWorkerSafetyLimits;
  readonly #buildCoordinator: ProcessBuildCoordinator;
  #nextRequestId = 1;
  #state: "initializing" | "open" | "closing" | "closed" | "failed" = "initializing";
  #terminalError: SnapshotWorkerClientError | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(
    worker: SnapshotWorkerTransport,
    options: CreateSnapshotWorkerClientOptions,
    limits: SnapshotWorkerSafetyLimits,
    buildCoordinator: ProcessBuildCoordinator,
  ) {
    this.#worker = worker;
    this.#revalidate = options.revalidate;
    this.#clock = options.clock ?? Date.now;
    this.#limits = limits;
    this.#buildCoordinator = buildCoordinator;
    worker.on("message", (message) => this.#handle(message));
    worker.on("messageerror", () => this.#failTerminal(new SnapshotWorkerClientError(
      "snapshot_worker_message_error", "Snapshot worker response could not be deserialized")));
    worker.on("error", () => this.#failTerminal(new SnapshotWorkerClientError(
      "snapshot_worker_error", "Snapshot worker failed")));
    worker.on("exit", (exitCode) => {
      if (this.#state !== "closed") this.#failTerminal(new SnapshotWorkerClientError(
        "snapshot_worker_exited", `Snapshot worker exited before close (${exitCode})`));
    });
  }

  async initialize(): Promise<void> {
    const response = await this.#send({ type: "snapshot.initialize" });
    if (response.type !== "snapshot.ready") throw this.#protocol("Wrong initialization response");
    this.#state = "open";
  }

  async beginRoomRepair(context: AuthenticatedSessionContext, requestId: string, roomId: string): Promise<SnapshotRoomBeginResult> {
    if (!validResponseRequestId(requestId)) throw new SnapshotWorkerClientError(
      "invalid_request", "Snapshot request id is invalid");
    const shared = await this.#buildCoordinator.run(() => this.#sendBuild({
        type: "snapshot.begin-room", context, responseRequestId: requestId,
        roomId, now: this.#clock(),
      }));
    if (shared.type === "snapshot.fallback") return { kind: "fallback", reason: shared.reason };
    const response = shared.type === "snapshot.page"
      ? { ...shared, page: { ...shared.page, requestId } } : shared;
    return this.#authorizedPage(response, context, "room") as Promise<RoomRepairPage>;
  }

  async readRoomRepairPage(context: AuthenticatedSessionContext, requestId: string, snapshotId: string, afterPage: number): Promise<RoomRepairPage> {
    if (!validResponseRequestId(requestId)) throw new SnapshotWorkerClientError(
      "invalid_request", "Snapshot request id is invalid");
    const response = await this.#send({ type: "snapshot.read-page", context,
      responseRequestId: requestId, snapshotId, afterPage, now: this.#clock() }, "room");
    const page = await this.#authorizedPage(response, context, "room");
    if (!isRoomRepairPage(page)) throw this.#protocol("Wrong room page response");
    return page;
  }

  async beginWorkspaceBootstrap(context: AuthenticatedSessionContext, requestId: string): Promise<SnapshotCatalogBeginResult> {
    if (!validResponseRequestId(requestId)) throw new SnapshotWorkerClientError(
      "invalid_request", "Snapshot request id is invalid");
    const shared = await this.#buildCoordinator.run(() => this.#sendBuild({
      type: "snapshot.begin-catalog", context,
      responseRequestId: requestId, now: this.#clock(),
    }));
    if (shared.type === "snapshot.fallback") return { kind: "fallback", reason: shared.reason };
    const response = shared.type === "snapshot.page"
      ? { ...shared, page: { ...shared.page, requestId } } : shared;
    return this.#authorizedPage(response, context, "catalog") as Promise<WorkspaceBootstrapPage>;
  }

  async readWorkspaceBootstrapPage(context: AuthenticatedSessionContext, requestId: string, snapshotId: string, afterPage: number): Promise<WorkspaceBootstrapPage> {
    if (!validResponseRequestId(requestId)) throw new SnapshotWorkerClientError(
      "invalid_request", "Snapshot request id is invalid");
    const response = await this.#send({ type: "snapshot.read-page", context,
      responseRequestId: requestId, snapshotId, afterPage, now: this.#clock() }, "catalog");
    const page = await this.#authorizedPage(response, context, "catalog");
    if (!isWorkspaceBootstrapPage(page)) throw this.#protocol("Wrong catalog page response");
    return page;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#terminalError !== undefined) return Promise.reject(this.#terminalError);
    this.#state = "closing";
    this.#closePromise = this.#send({ type: "snapshot.close" }).then((response) => {
      if (response.type !== "snapshot.closed") throw this.#protocol("Wrong close response");
      this.#state = "closed";
    });
    return this.#closePromise;
  }

  async cacheCountForTest(): Promise<number> {
    const response = await this.#send({ type: "snapshot.cache-count" });
    if (response.type !== "snapshot.cache-count") throw this.#protocol("Wrong cache count response");
    return response.count;
  }

  async fullValidationCountForTest(): Promise<number> {
    const response = await this.#send({ type: "snapshot.full-validation-count" });
    if (response.type !== "snapshot.full-validation-count") {
      throw this.#protocol("Wrong full-validation count response");
    }
    return response.count;
  }

  async #sendBuild(command: Extract<SnapshotWorkerCommand,
    { readonly type: "snapshot.begin-room" | "snapshot.begin-catalog" }>): Promise<SnapshotWorkerResponse> {
    const response = await this.#send(command);
    // The worker posts the build response before its dispatch finally closes SQLite.
    // A following command is processed only after that finally; cache-count closes
    // its own connection before responding and therefore acts as an ownership barrier.
    await this.#send({ type: "snapshot.cache-count" });
    return response;
  }

  async #authorizedPage(response: SnapshotWorkerResponse, context: AuthenticatedSessionContext, kind: "room" | "catalog"): Promise<SnapshotMaterializedPage> {
    if (response.type !== "snapshot.page" || response.manifest.kind !== kind) {
      throw this.#protocol("Wrong materialized page response");
    }
    const request: SnapshotRevalidationRequest = response.manifest.kind === "room"
      ? { kind: "room", context, roomId: response.manifest.roomId,
          accessRevision: response.manifest.accessRevision }
      : { kind: "catalog", context, catalogRevision: response.manifest.catalogRevision };
    try {
      await this.#revalidate(request);
    } catch (error: unknown) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      if (["snapshot_family_revoked", "room_forbidden", "room_not_found",
        "room_archived", "snapshot_stale"].includes(code ?? "")) {
        try {
          await this.#send({ type: "snapshot.invalidate", snapshotId: response.manifest.snapshotId });
        } catch {
          // Preserve the authorization failure.
        }
      }
      throw error;
    }
    return response.page;
  }

  #send(command: SnapshotWorkerCommand, expectedKind?: "room" | "catalog"): Promise<SnapshotWorkerResponse> {
    if (this.#terminalError !== undefined) return Promise.reject(this.#terminalError);
    if (this.#state === "closed" || (this.#state === "closing" && command.type !== "snapshot.close")) {
      return Promise.reject(new SnapshotWorkerClientError("snapshot_worker_closed", "Snapshot worker is closed"));
    }
    if (this.#pending.size > this.#limits.queueLimit) {
      return Promise.reject(new SnapshotWorkerClientError("snapshot_busy", "Snapshot worker queue is full"));
    }
    const requestId = String(this.#nextRequestId++);
    const request = { ...command, requestId } as SnapshotWorkerRequest;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { requestType: request.type, command,
        ...(expectedKind === undefined ? {} : { expectedKind }), resolve, reject });
      try {
        this.#worker.postMessage(request);
      } catch {
        this.#failTerminal(new SnapshotWorkerClientError("snapshot_worker_error", "Snapshot worker request failed"));
      }
    });
  }

  #handle(value: unknown): void {
    if (!isWorkerResponse(value)) {
      this.#failTerminal(new SnapshotWorkerClientError("snapshot_worker_protocol_error", "Malformed snapshot worker response"));
      return;
    }
    const pending = this.#pending.get(value.requestId);
    if (pending === undefined) {
      this.#failTerminal(new SnapshotWorkerClientError("snapshot_worker_protocol_error", "Unknown snapshot response request"));
      return;
    }
    if (!this.#correlates(pending, value)) {
      this.#failTerminal(new SnapshotWorkerClientError(
        "snapshot_worker_protocol_error", "Snapshot worker response did not match its request"));
      return;
    }
    this.#pending.delete(value.requestId);
    if (value.type === "snapshot.error") {
      const workerError = new SnapshotWorkerClientError(value.code, value.message);
      if (value.code === "storage_unavailable" ||
          pending.requestType === "snapshot.initialize" ||
          pending.requestType === "snapshot.close") {
        pending.reject(this.#failTerminal(workerError));
      } else {
        pending.reject(workerError);
      }
      return;
    }
    if (value.type === "snapshot.closed") {
      this.#state = "closed";
    }
    pending.resolve(value);
  }

  #correlates(pending: Pending, response: SnapshotWorkerResponse): boolean {
    if (response.type === "snapshot.error") return true;
    const command = pending.command;
    if (command.type === "snapshot.initialize") return response.type === "snapshot.ready";
    if (command.type === "snapshot.close") return response.type === "snapshot.closed";
    if (command.type === "snapshot.invalidate") return response.type === "snapshot.invalidated";
    if (command.type === "snapshot.cache-count") return response.type === "snapshot.cache-count";
    if (command.type === "snapshot.full-validation-count") {
      return response.type === "snapshot.full-validation-count";
    }
    if (command.type === "snapshot.begin-room") {
      if (response.type === "snapshot.fallback") return true;
      return response.type === "snapshot.page" && response.manifest.kind === "room" &&
        response.manifest.principalId === command.context.principal.actorId &&
        response.manifest.sessionFamilyId === command.context.sessionFamilyId &&
        response.manifest.roomId === command.roomId && isRoomRepairPage(response.page) &&
        response.page.roomId === command.roomId && response.page.page === 0 &&
        response.page.requestId === command.responseRequestId &&
        response.page.watermark === response.manifest.watermark &&
        response.page.snapshotChecksum === response.manifest.checksum &&
        response.page.expiresAt === response.manifest.expiresAt &&
        response.page.hasMore === (response.manifest.pageCount > 1);
    }
    if (command.type === "snapshot.begin-catalog") {
      if (response.type === "snapshot.fallback") return true;
      return response.type === "snapshot.page" && response.manifest.kind === "catalog" &&
        response.manifest.principalId === command.context.principal.actorId &&
        response.manifest.sessionFamilyId === command.context.sessionFamilyId &&
        isWorkspaceBootstrapPage(response.page) && response.page.page === 0 &&
        response.page.requestId === command.responseRequestId &&
        response.page.catalogRevision === response.manifest.catalogRevision &&
        response.page.snapshotChecksum === response.manifest.checksum &&
        response.page.expiresAt === response.manifest.expiresAt &&
        response.page.hasMore === (response.manifest.pageCount > 1);
    }
    if (response.type !== "snapshot.page" || response.manifest.kind !== pending.expectedKind ||
        response.page.snapshotId !== command.snapshotId ||
        response.page.page !== command.afterPage + 1 ||
        response.page.requestId !== command.responseRequestId) return false;
    if (response.page.snapshotChecksum !== response.manifest.checksum ||
        response.page.expiresAt !== response.manifest.expiresAt ||
        response.page.hasMore !== (response.page.page + 1 < response.manifest.pageCount) ||
        response.manifest.principalId !== command.context.principal.actorId ||
        response.manifest.sessionFamilyId !== command.context.sessionFamilyId) return false;
    if (pending.expectedKind === "room") {
      return response.manifest.kind === "room" && isRoomRepairPage(response.page) &&
        response.page.roomId === response.manifest.roomId &&
        response.page.watermark === response.manifest.watermark;
    }
    return response.manifest.kind === "catalog" && isWorkspaceBootstrapPage(response.page) &&
      response.page.catalogRevision === response.manifest.catalogRevision;
  }

  #protocol(message: string): SnapshotWorkerClientError {
    return this.#failTerminal(new SnapshotWorkerClientError("snapshot_worker_protocol_error", message));
  }

  #failTerminal(error: SnapshotWorkerClientError): SnapshotWorkerClientError {
    if (this.#terminalError !== undefined) return this.#terminalError;
    this.#terminalError = error;
    this.#state = "failed";
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const item of pending) item.reject(error);
    void this.#worker.terminate().catch(() => undefined);
    return error;
  }
}

type WorkerFactory = (
  options: CreateSnapshotWorkerClientOptions,
  limits: SnapshotWorkerSafetyLimits,
  pauseState?: SharedArrayBuffer,
) => SnapshotWorkerTransport;

function realWorkerFactory(
  options: CreateSnapshotWorkerClientOptions,
  limits: SnapshotWorkerSafetyLimits,
  pauseState?: SharedArrayBuffer,
): SnapshotWorkerTransport {
  return new Worker(snapshotWorkerUrl(), { workerData: {
    authorityPath: options.authorityPath,
    cachePath: options.cachePath,
    limits,
    ...(pauseState === undefined ? {} : { pauseState }),
  }});
}

async function createClient(
  options: CreateSnapshotWorkerClientOptions,
  factory: WorkerFactory,
  pauseState?: SharedArrayBuffer,
): Promise<SnapshotWorkerClientImplementation> {
  if (options.authorityPath.length === 0 || options.cachePath.length === 0) {
    throw new TypeError("Snapshot paths must be non-empty");
  }
  const limits = resolveLimits(options.limits);
  const canonical = await processCoordinator(
    options.authorityPath, options.cachePath, limits.queueLimit,
  );
  const canonicalOptions = { ...options, authorityPath: canonical.authorityPath,
    cachePath: canonical.cachePath };
  const initialization = registerInitialization(canonical.cachePath);
  try {
    const client = new SnapshotWorkerClientImplementation(
      factory(canonicalOptions, limits, pauseState), canonicalOptions, limits,
      canonical.coordinator,
    );
    await initialization.coordinator.run(() => client.initialize());
    return client;
  } finally {
    initialization.unregister();
  }
}

export function createSnapshotWorkerClient(
  options: CreateSnapshotWorkerClientOptions,
): Promise<SnapshotWorkerClient> {
  return createClient(options, realWorkerFactory);
}

// Deep-only deterministic integration seam; intentionally absent from package root.
export async function createSnapshotWorkerClientWithPauseForTest(
  options: CreateSnapshotWorkerClientOptions,
): Promise<{
  readonly client: SnapshotWorkerClient & { cacheCountForTest(): Promise<number> };
  readonly hooks: { waitForFixedView(): Promise<void>; fixedViewReached(): boolean;
    continueBuild(): void };
}> {
  const pauseState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(pauseState);
  const client = await createClient(options, realWorkerFactory, pauseState);
  return {
    client,
    hooks: {
      async waitForFixedView(): Promise<void> {
        while (Atomics.load(state, 0) === 0) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
        }
      },
      fixedViewReached(): boolean {
        return Atomics.load(state, 0) !== 0;
      },
      continueBuild(): void {
        Atomics.store(state, 0, 2);
        Atomics.notify(state, 0);
      },
    },
  };
}

// Deep-only malformed-envelope seam; intentionally absent from package root.
export function createSnapshotWorkerClientForTest(
  options: CreateSnapshotWorkerClientOptions,
  factory: WorkerFactory,
): Promise<SnapshotWorkerClient> {
  return createClient(options, factory);
}
