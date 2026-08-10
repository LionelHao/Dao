import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  isAuthorityWorkerResponse,
  type AuthorityWorkerRequest,
  type AuthorityWorkerResponse,
} from "./worker-protocol.js";

export interface CreateWorkerDatabaseClientOptions {
  readonly databasePath: string;
}

export interface AuthoritySchemaInspection {
  readonly version: 2;
}

export interface WorkerDatabaseClient {
  inspectSchema(): Promise<AuthoritySchemaInspection>;
  close(): Promise<void>;
}

export interface AuthorityWorkerTransport {
  postMessage(message: AuthorityWorkerRequest): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "messageerror", listener: (error: Error) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
  terminate(): Promise<number>;
}

export class AuthorityWorkerClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AuthorityWorkerClientError";
  }
}

interface PendingRequest {
  readonly requestType: AuthorityWorkerRequest["type"];
  readonly resolve: (response: AuthorityWorkerResponse) => void;
  readonly reject: (error: AuthorityWorkerClientError) => void;
}

type ClientState = "initializing" | "open" | "closing" | "closed" | "failed";

const authorityCoordinatorPaths = new Set<string>();
const MAX_DATABASE_SYMLINK_DEPTH = 32;

function databasePathResolutionError(): AuthorityWorkerClientError {
  return new AuthorityWorkerClientError(
    "storage_unavailable",
    "Authority database path could not be resolved",
  );
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function canonicalizeDatabasePath(
  absolutePath: string,
  visitedSymlinks: Set<string>,
  depth: number,
): Promise<string> {
  if (depth > MAX_DATABASE_SYMLINK_DEPTH) {
    throw databasePathResolutionError();
  }

  let canonicalPath: string | undefined;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    // A dangling final symlink needs lstat/readlink before the nonexistent fallback.
  }
  if (canonicalPath !== undefined) {
    try {
      const pathMetadata = await stat(canonicalPath, { bigint: true });
      if (pathMetadata.isFile() && pathMetadata.nlink > 1n) {
        throw databasePathResolutionError();
      }
    } catch (error: unknown) {
      if (error instanceof AuthorityWorkerClientError) {
        throw error;
      }
      throw databasePathResolutionError();
    }
    return canonicalPath;
  }

  let pathMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    pathMetadata = await lstat(absolutePath);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) {
      throw databasePathResolutionError();
    }
    try {
      const canonicalParent = await realpath(dirname(absolutePath));
      return join(canonicalParent, basename(absolutePath));
    } catch {
      return absolutePath;
    }
  }

  if (!pathMetadata.isSymbolicLink()) {
    throw databasePathResolutionError();
  }
  if (visitedSymlinks.has(absolutePath)) {
    throw databasePathResolutionError();
  }
  visitedSymlinks.add(absolutePath);

  let linkTarget: string;
  try {
    linkTarget = await readlink(absolutePath);
  } catch {
    throw databasePathResolutionError();
  }
  return canonicalizeDatabasePath(
    resolve(dirname(absolutePath), linkTarget),
    visitedSymlinks,
    depth + 1,
  );
}

async function canonicalDatabasePath(databasePath: string): Promise<string> {
  return canonicalizeDatabasePath(resolve(databasePath), new Set<string>(), 0);
}

interface AuthorityCoordinatorReservation {
  readonly databasePath: string;
  release(): void;
}

async function terminateTransport(worker: AuthorityWorkerTransport): Promise<void> {
  try {
    await worker.terminate();
  } catch {
    // Transport teardown is best-effort after its public error is already fixed.
  }
}

async function reserveAuthorityCoordinator(
  databasePath: string,
): Promise<AuthorityCoordinatorReservation> {
  const canonicalPath = await canonicalDatabasePath(databasePath);
  if (authorityCoordinatorPaths.has(canonicalPath)) {
    throw new AuthorityWorkerClientError(
      "authority_coordinator_exists",
      "Authority database coordinator already exists",
    );
  }
  authorityCoordinatorPaths.add(canonicalPath);

  let reserved = true;
  return {
    databasePath: canonicalPath,
    release(): void {
      if (!reserved) {
        return;
      }
      reserved = false;
      authorityCoordinatorPaths.delete(canonicalPath);
    },
  };
}

function authorityWorkerUrl(): URL {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol !== "file:") {
    return pathToFileURL(
      resolve(process.cwd(), "packages/server/dist/persistence/authority-worker.js"),
    );
  }
  if (moduleUrl.pathname.endsWith(".ts")) {
    return new URL("../../dist/persistence/authority-worker.js", moduleUrl);
  }
  return new URL("./authority-worker.js", moduleUrl);
}

function createAuthorityWorker(
  options: CreateWorkerDatabaseClientOptions,
): AuthorityWorkerTransport {
  return new Worker(authorityWorkerUrl(), {
    workerData: { databasePath: options.databasePath },
  });
}

class WorkerDatabaseClientImplementation implements WorkerDatabaseClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #worker: AuthorityWorkerTransport;
  readonly #releaseCoordinator: () => void;
  #nextRequestId = 1n;
  #state: ClientState = "initializing";
  #terminalError: AuthorityWorkerClientError | undefined;
  #closedError: AuthorityWorkerClientError | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(worker: AuthorityWorkerTransport, releaseCoordinator: () => void) {
    this.#worker = worker;
    this.#releaseCoordinator = releaseCoordinator;
    worker.on("message", (message: unknown) => this.#handleMessage(message));
    worker.on("messageerror", () => {
      this.#failTerminal(
        new AuthorityWorkerClientError(
          "authority_worker_message_error",
          "Authority worker response could not be deserialized",
        ),
      );
    });
    worker.on("error", () => {
      this.#failTerminal(
        new AuthorityWorkerClientError(
          "authority_worker_error",
          "Authority worker failed",
        ),
      );
    });
    worker.on("exit", (exitCode: number) => {
      if (this.#state === "closed") {
        return;
      }
      this.#failTerminal(
        new AuthorityWorkerClientError(
          "authority_worker_exited",
          `Authority worker exited before close acknowledgement (exit code ${exitCode})`,
        ),
      );
    });
  }

  async initialize(): Promise<void> {
    const response = await this.#send("authority.initialize");
    if (response.type !== "authority.ready") {
      this.#failProtocol("Authority worker returned the wrong initialization response");
      throw this.#terminalError;
    }
    this.#state = "open";
  }

  inspectSchema(): Promise<AuthoritySchemaInspection> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }

    return this.#send("authority.inspect-schema").then((response) => {
      if (response.type !== "authority.schema") {
        this.#failProtocol("Authority worker returned the wrong schema response");
        throw this.#terminalError;
      }
      return { version: response.schemaVersion };
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    if (this.#state === "closed") {
      return Promise.resolve();
    }

    this.#state = "closing";
    this.#closePromise = this.#send("authority.close")
      .then((response) => {
        if (response.type !== "authority.closed") {
          this.#failProtocol("Authority worker returned the wrong close response");
          throw this.#terminalError;
        }
        this.#state = "closed";
      })
      .catch((error: unknown) => {
        const stableError =
          error instanceof AuthorityWorkerClientError
            ? error
            : new AuthorityWorkerClientError(
                "authority_worker_error",
                "Authority worker close failed",
              );
        throw this.#failTerminal(stableError);
      });
    return this.#closePromise;
  }

  #unavailableError(): AuthorityWorkerClientError | undefined {
    if (this.#state === "closing" || this.#state === "closed") {
      return this.#stableClosedError();
    }
    if (this.#state !== "open") {
      return new AuthorityWorkerClientError(
        "authority_worker_not_ready",
        "Authority worker is not ready",
      );
    }
    return undefined;
  }

  #stableClosedError(): AuthorityWorkerClientError {
    this.#closedError ??= new AuthorityWorkerClientError(
      "authority_worker_closed",
      "Authority worker is closed",
    );
    return this.#closedError;
  }

  #send(requestType: AuthorityWorkerRequest["type"]): Promise<AuthorityWorkerResponse> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }

    const requestId = String(this.#nextRequestId);
    this.#nextRequestId += 1n;
    const request = { type: requestType, requestId } as AuthorityWorkerRequest;

    return new Promise<AuthorityWorkerResponse>((resolve, reject) => {
      this.#pending.set(requestId, { requestType, resolve, reject });
      try {
        this.#worker.postMessage(request);
      } catch {
        this.#failTerminal(
          new AuthorityWorkerClientError(
            "authority_worker_post_failed",
            "Authority worker request could not be sent",
          ),
        );
      }
    });
  }

  #handleMessage(message: unknown): void {
    if (this.#terminalError !== undefined || this.#state === "closed") {
      return;
    }
    if (!isAuthorityWorkerResponse(message)) {
      this.#failProtocol("Authority worker sent a malformed response");
      return;
    }

    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) {
      this.#failProtocol("Authority worker sent a response for an unknown request");
      return;
    }
    if (!this.#responseMatchesRequest(pending.requestType, message.type)) {
      this.#failProtocol("Authority worker response did not match its request");
      return;
    }

    if (message.type === "authority.error") {
      const error = new AuthorityWorkerClientError(message.code, message.message);
      if (
        pending.requestType === "authority.initialize" ||
        pending.requestType === "authority.close"
      ) {
        this.#failTerminal(error);
      } else {
        this.#pending.delete(message.requestId);
        pending.reject(error);
      }
      return;
    }
    if (message.type === "authority.closed") {
      this.#pending.delete(message.requestId);
      this.#state = "closed";
      const closedError = this.#stableClosedError();
      const remaining = [...this.#pending.values()];
      this.#pending.clear();
      for (const request of remaining) {
        request.reject(closedError);
      }
      this.#releaseCoordinator();
      pending.resolve(message);
      return;
    }
    this.#pending.delete(message.requestId);
    pending.resolve(message);
  }

  #responseMatchesRequest(
    requestType: AuthorityWorkerRequest["type"],
    responseType: AuthorityWorkerResponse["type"],
  ): boolean {
    if (responseType === "authority.error") {
      return true;
    }
    return (
      (requestType === "authority.initialize" && responseType === "authority.ready") ||
      (requestType === "authority.inspect-schema" &&
        responseType === "authority.schema") ||
      (requestType === "authority.close" && responseType === "authority.closed")
    );
  }

  #failProtocol(message: string): AuthorityWorkerClientError {
    return this.#failTerminal(
      new AuthorityWorkerClientError("authority_worker_protocol_error", message),
    );
  }

  #rejectTerminal<Result>(): Promise<Result> {
    const error = this.#terminalError;
    if (error === undefined) {
      return Promise.reject(
        new AuthorityWorkerClientError(
          "authority_worker_error",
          "Authority worker failed",
        ),
      );
    }
    return Promise.reject(error);
  }

  #failTerminal(error: AuthorityWorkerClientError): AuthorityWorkerClientError {
    if (this.#state === "closed") {
      return this.#stableClosedError();
    }
    if (this.#terminalError !== undefined) {
      return this.#terminalError;
    }

    this.#terminalError = error;
    this.#state = "failed";
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      request.reject(error);
    }
    void terminateTransport(this.#worker).then(() => {
      this.#releaseCoordinator();
    });
    return error;
  }
}

type AuthorityWorkerFactory = (databasePath: string) => AuthorityWorkerTransport;

async function createClient(
  options: CreateWorkerDatabaseClientOptions,
  workerFactory: AuthorityWorkerFactory,
): Promise<WorkerDatabaseClient> {
  const reservation = await reserveAuthorityCoordinator(options.databasePath);
  let worker: AuthorityWorkerTransport;
  try {
    worker = workerFactory(reservation.databasePath);
  } catch {
    reservation.release();
    throw new AuthorityWorkerClientError(
      "authority_worker_error",
      "Authority worker failed",
    );
  }

  let client: WorkerDatabaseClientImplementation;
  try {
    client = new WorkerDatabaseClientImplementation(worker, reservation.release);
  } catch {
    await terminateTransport(worker);
    reservation.release();
    throw new AuthorityWorkerClientError(
      "authority_worker_error",
      "Authority worker failed",
    );
  }

  try {
    await client.initialize();
    return client;
  } catch (error: unknown) {
    if (error instanceof AuthorityWorkerClientError) {
      throw error;
    }
    await terminateTransport(worker);
    reservation.release();
    throw new AuthorityWorkerClientError(
      "authority_worker_error",
      "Authority worker failed",
    );
  }
}

export function createWorkerDatabaseClient(
  options: CreateWorkerDatabaseClientOptions,
): Promise<WorkerDatabaseClient> {
  return createClient(options, (databasePath) =>
    createAuthorityWorker({ databasePath }),
  );
}

// Module-local test seam. It is intentionally absent from the package root export.
export function createWorkerDatabaseClientForTest(
  _options: CreateWorkerDatabaseClientOptions,
  workerFactory: AuthorityWorkerFactory,
): Promise<WorkerDatabaseClient> {
  return createClient(_options, workerFactory);
}
