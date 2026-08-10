import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createWorkerDatabaseClient,
  createWorkerDatabaseClientForTest,
  type AuthorityWorkerTransport,
  type WorkerDatabaseClient,
} from "./worker-database-client.js";
import {
  isAuthorityWorkerRequest,
  isAuthorityWorkerResponse,
  type AuthorityWorkerRequest,
  type AuthorityWorkerResponse,
} from "./worker-protocol.js";

const temporaryDirectories = new Set<string>();
const clients = new Set<WorkerDatabaseClient>();
const workers = new Set<Worker>();

function authorityArtifactSnapshot(): string {
  const workspaceRoot = process.cwd();
  const artifactRoots = [
    resolve(workspaceRoot, "packages/core/dist"),
    resolve(workspaceRoot, "packages/server/dist"),
  ];
  const paths: string[] = [];
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        collect(path);
      } else if (entry.isFile()) {
        paths.push(path);
      }
    }
  };
  for (const artifactRoot of artifactRoots) {
    collect(artifactRoot);
  }

  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    const metadata = statSync(path, { bigint: true });
    hash.update(relative(workspaceRoot, path));
    hash.update(metadata.mtimeNs.toString());
    hash.update(metadata.size.toString());
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

const collectedAuthorityArtifactSnapshot = authorityArtifactSnapshot();

afterAll(() => {
  expect(authorityArtifactSnapshot()).toBe(collectedAuthorityArtifactSnapshot);
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "native-im-authority-worker-"));
  temporaryDirectories.add(directory);
  return directory;
}

function databasePath(): string {
  return join(temporaryDirectory(), "authority.sqlite");
}

function trackClient(client: WorkerDatabaseClient): WorkerDatabaseClient {
  clients.add(client);
  return client;
}

async function expectDatabasePathReusable(path: string): Promise<void> {
  const replacement = trackClient(
    await createWorkerDatabaseClient({ databasePath: path }),
  );
  await expect(replacement.inspectSchema()).resolves.toEqual({ version: 3 });
}

async function expectDatabasePathEventuallyReusable(path: string): Promise<void> {
  let coordinatorError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await expectDatabasePathReusable(path);
      return;
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        (error as Error & { code?: string }).code !== "authority_coordinator_exists"
      ) {
        throw error;
      }
      coordinatorError = error;
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    }
  }
  throw coordinatorError;
}

function scriptedWorker(script: string): Worker {
  const worker = new Worker(script, { eval: true });
  workers.add(worker);
  return worker;
}

function workerThatRuns(scriptBody: string): Worker {
  return scriptedWorker(`
    const { parentPort } = require("node:worker_threads");
    if (parentPort === null) throw new Error("missing parent port");
    parentPort.on("message", (request) => {
      if (request.type === "authority.initialize") {
        parentPort.postMessage({
          type: "authority.ready",
          requestId: request.requestId,
          schemaVersion: 3,
        });
        return;
      }
      ${scriptBody}
    });
  `);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => new Error("expected promise to reject"),
    (error: unknown) => error,
  );
}

function publicErrorSurface(value: unknown, seen = new Set<object>()): string {
  if (typeof value !== "object" || value === null) {
    return String(value);
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  const fragments = [String(value)];
  for (const property of Object.getOwnPropertyNames(value)) {
    fragments.push(property);
    fragments.push(
      publicErrorSurface((value as Record<string, unknown>)[property], seen),
    );
  }
  return fragments.join("\n");
}

function expectSanitizedError(error: unknown, code: string): void {
  const sentinelFragments = [
    "SELECT token FROM sessions",
    "/private/authority.sqlite",
    "super-secret-token",
  ];
  expect(error).toMatchObject({ code });
  expect((error as { cause?: unknown }).cause).toBeUndefined();
  const surface = publicErrorSurface(error);
  for (const fragment of sentinelFragments) {
    expect(surface).not.toContain(fragment);
  }
}

function secretTransportError(): Error {
  return new Error(
    "SELECT token FROM sessions at /private/authority.sqlite: super-secret-token",
  );
}

class MessageErrorTransport extends EventEmitter implements AuthorityWorkerTransport {
  constructor(private readonly failure = new Error("cannot deserialize")) {
    super();
  }

  postMessage(request: AuthorityWorkerRequest): void {
    if (request.type === "authority.initialize") {
      queueMicrotask(() => {
        this.emit("message", {
          type: "authority.ready",
          requestId: request.requestId,
          schemaVersion: 3,
        } satisfies AuthorityWorkerResponse);
      });
      return;
    }
    queueMicrotask(() => this.emit("messageerror", this.failure));
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class ThrowingPostTransport extends EventEmitter implements AuthorityWorkerTransport {
  constructor(
    private readonly failOn: AuthorityWorkerRequest["type"],
    private readonly failure: Error,
  ) {
    super();
  }

  postMessage(request: AuthorityWorkerRequest): void {
    if (request.type === this.failOn) {
      throw this.failure;
    }
    if (request.type === "authority.initialize") {
      queueMicrotask(() => {
        this.emit("message", {
          type: "authority.ready",
          requestId: request.requestId,
          schemaVersion: 3,
        } satisfies AuthorityWorkerResponse);
      });
    }
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class DeferredTerminationTransport
  extends EventEmitter
  implements AuthorityWorkerTransport
{
  #finishTermination: ((exitCode: number) => void) | undefined;

  postMessage(request: AuthorityWorkerRequest): void {
    if (request.type === "authority.initialize") {
      queueMicrotask(() => {
        this.emit("message", {
          type: "authority.ready",
          requestId: request.requestId,
          schemaVersion: 3,
        } satisfies AuthorityWorkerResponse);
      });
      return;
    }
    queueMicrotask(() => this.emit("messageerror", secretTransportError()));
  }

  terminate(): Promise<number> {
    return new Promise<number>((resolveTermination) => {
      this.#finishTermination = resolveTermination;
    });
  }

  finishTermination(): void {
    this.#finishTermination?.(1);
  }
}

class CloseRaceTransport extends EventEmitter implements AuthorityWorkerTransport {
  #closeRequest: AuthorityWorkerRequest | undefined;
  #inspectRequest: AuthorityWorkerRequest | undefined;
  terminateCalls = 0;

  postMessage(request: AuthorityWorkerRequest): void {
    if (request.type === "authority.initialize") {
      queueMicrotask(() => {
        this.emit("message", {
          type: "authority.ready",
          requestId: request.requestId,
          schemaVersion: 3,
        } satisfies AuthorityWorkerResponse);
      });
      return;
    }
    if (request.type === "authority.inspect-schema") {
      this.#inspectRequest = request;
      return;
    }
    this.#closeRequest = request;
  }

  acknowledgeClose(): void {
    if (this.#closeRequest === undefined) {
      throw new Error("close request was not sent");
    }
    this.emit("message", {
      type: "authority.closed",
      requestId: this.#closeRequest.requestId,
    } satisfies AuthorityWorkerResponse);
  }

  sendLateInspection(): void {
    if (this.#inspectRequest === undefined) {
      throw new Error("inspect request was not sent");
    }
    this.emit("message", {
      type: "authority.schema",
      requestId: this.#inspectRequest.requestId,
      schemaVersion: 3,
    } satisfies AuthorityWorkerResponse);
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return 0;
  }
}

afterEach(async () => {
  await Promise.all(
    [...workers].map(async (worker) => {
      await worker.terminate().catch(() => undefined);
    }),
  );
  workers.clear();

  await Promise.all(
    [...clients].map(async (client) => {
      await client.close().catch(() => undefined);
    }),
  );
  clients.clear();

  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
  temporaryDirectories.clear();
});

describe("AuthorityWorker closed protocol", () => {
  it("accepts only the three exact request variants", () => {
    expect(
      isAuthorityWorkerRequest({
        type: "authority.initialize",
        requestId: "1",
      }),
    ).toBe(true);
    expect(
      isAuthorityWorkerRequest({
        type: "authority.inspect-schema",
        requestId: "2",
      }),
    ).toBe(true);
    expect(
      isAuthorityWorkerRequest({
        type: "authority.close",
        requestId: "3",
      }),
    ).toBe(true);

    expect(
      isAuthorityWorkerRequest({
        type: "authority.inspect-schema",
        requestId: "4",
        operation: "arbitrary-sql",
      }),
    ).toBe(false);
    expect(
      isAuthorityWorkerRequest({
        type: "authority.unknown",
        requestId: "5",
      }),
    ).toBe(false);
  });

  it("accepts only exact response variants", () => {
    expect(
      isAuthorityWorkerResponse({
        type: "authority.ready",
        requestId: "1",
        schemaVersion: 3,
      }),
    ).toBe(true);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.schema",
        requestId: "2",
        schemaVersion: 3,
      }),
    ).toBe(true);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.closed",
        requestId: "3",
      }),
    ).toBe(true);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.error",
        requestId: "4",
        code: "invalid_request",
        message: "Invalid authority worker request",
      }),
    ).toBe(true);

    expect(
      isAuthorityWorkerResponse({
        type: "authority.schema",
        requestId: "5",
        schemaVersion: 3,
        rows: [],
      }),
    ).toBe(false);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.future",
        requestId: "6",
      }),
    ).toBe(false);
  });

  it("rejects a malformed request and continues with the next closed request", async () => {
    const worker = new Worker(
      pathToFileURL(
        resolve(process.cwd(), "packages/server/dist/persistence/authority-worker.js"),
      ),
      { workerData: { databasePath: databasePath() } },
    );
    workers.add(worker);

    let response = once(worker, "message");
    worker.postMessage({ type: "authority.initialize", requestId: "1" });
    await expect(response).resolves.toEqual([
      { type: "authority.ready", requestId: "1", schemaVersion: 3 },
    ]);

    response = once(worker, "message");
    worker.postMessage(undefined);
    await expect(response).resolves.toEqual([
      {
        type: "authority.error",
        requestId: "invalid",
        code: "invalid_request",
        message: "Invalid authority worker request",
      },
    ]);

    response = once(worker, "message");
    worker.postMessage({ type: "authority.inspect-schema", requestId: "2" });
    await expect(response).resolves.toEqual([
      { type: "authority.schema", requestId: "2", schemaVersion: 3 },
    ]);
  });
});

describe("authority database coordinator registry", () => {
  it("atomically rejects one of two concurrent clients for the same exact path", async () => {
    const path = databasePath();
    const results = await Promise.allSettled([
      createWorkerDatabaseClient({ databasePath: path }),
      createWorkerDatabaseClient({ databasePath: path }),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<WorkerDatabaseClient> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    trackClient(fulfilled[0]!.value);
    expect(rejected[0]!.reason).toMatchObject({
      code: "authority_coordinator_exists",
      message: "Authority database coordinator already exists",
    });
    expect(String(rejected[0]!.reason)).not.toContain(path);
  });

  it("treats relative and absolute spellings as the same path", async () => {
    const absolutePath = databasePath();
    const relativePath = relative(process.cwd(), absolutePath);
    const client = trackClient(
      await createWorkerDatabaseClient({ databasePath: absolutePath }),
    );

    const error = await rejectionOf(
      createWorkerDatabaseClient({ databasePath: relativePath }),
    );

    expect(error).toMatchObject({ code: "authority_coordinator_exists" });
    await client.close();
  });

  it("treats a symlink alias to an existing database as the same path", async () => {
    const path = databasePath();
    const aliasPath = join(dirname(path), "authority-alias.sqlite");
    const client = trackClient(
      await createWorkerDatabaseClient({ databasePath: path }),
    );
    symlinkSync(path, aliasPath);

    const error = await rejectionOf(
      createWorkerDatabaseClient({ databasePath: aliasPath }),
    );

    expect(error).toMatchObject({ code: "authority_coordinator_exists" });
    await client.close();
  });

  it("rejects every hardlink spelling before spawning and recovers after unlink", async () => {
    const path = databasePath();
    const aliasPath = join(dirname(path), "authority-hardlink.sqlite");
    const initialized = trackClient(
      await createWorkerDatabaseClient({ databasePath: path }),
    );
    await expect(initialized.inspectSchema()).resolves.toEqual({ version: 3 });
    await initialized.close();
    linkSync(path, aliasPath);

    let spawnCount = 0;
    const mustNotSpawn = (): AuthorityWorkerTransport => {
      spawnCount += 1;
      throw secretTransportError();
    };
    const originalError = await rejectionOf(
      createWorkerDatabaseClientForTest({ databasePath: path }, mustNotSpawn),
    );
    const aliasError = await rejectionOf(
      createWorkerDatabaseClientForTest({ databasePath: aliasPath }, mustNotSpawn),
    );

    expect(spawnCount).toBe(0);
    for (const error of [originalError, aliasError]) {
      expect(error).toMatchObject({
        code: "storage_unavailable",
        message: "Authority database path could not be resolved",
      });
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      expect(publicErrorSurface(error)).not.toContain(path);
      expect(publicErrorSurface(error)).not.toContain(aliasPath);
    }

    unlinkSync(aliasPath);
    const replacement = trackClient(
      await createWorkerDatabaseClient({ databasePath: path }),
    );
    await expect(replacement.inspectSchema()).resolves.toEqual({ version: 3 });
  });

  it("rejects a hardlink added while the original database is live", async () => {
    const path = databasePath();
    const aliasPath = join(dirname(path), "authority-live-hardlink.sqlite");
    const original = trackClient(
      await createWorkerDatabaseClient({ databasePath: path }),
    );
    await expect(original.inspectSchema()).resolves.toEqual({ version: 3 });
    linkSync(path, aliasPath);

    let spawnCount = 0;
    const aliasError = await rejectionOf(
      createWorkerDatabaseClientForTest({ databasePath: aliasPath }, () => {
        spawnCount += 1;
        throw secretTransportError();
      }),
    );

    expect(spawnCount).toBe(0);
    expect(aliasError).toMatchObject({
      code: "storage_unavailable",
      message: "Authority database path could not be resolved",
    });
    expect((aliasError as { cause?: unknown }).cause).toBeUndefined();
    expect(publicErrorSurface(aliasError)).not.toContain(path);
    expect(publicErrorSurface(aliasError)).not.toContain(aliasPath);
    await expect(original.inspectSchema()).resolves.toEqual({ version: 3 });
  });

  it("atomically reserves a dangling relative symlink chain with its future target", async () => {
    const directory = temporaryDirectory();
    const targetPath = join(directory, "authority.sqlite");
    const firstAliasPath = join(directory, "authority-alias.sqlite");
    const chainAliasPath = join(directory, "authority-chain.sqlite");
    symlinkSync("authority.sqlite", firstAliasPath);
    symlinkSync("authority-alias.sqlite", chainAliasPath);

    const results = await Promise.allSettled([
      createWorkerDatabaseClient({ databasePath: targetPath }),
      createWorkerDatabaseClient({ databasePath: chainAliasPath }),
    ]);
    const fulfilledIndex = results.findIndex(
      (result) => result.status === "fulfilled",
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<WorkerDatabaseClient> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = trackClient(fulfilled[0]!.value);
    expect(rejected[0]!.reason).toMatchObject({
      code: "authority_coordinator_exists",
      message: "Authority database coordinator already exists",
    });
    expect(rejected[0]!.reason).not.toMatchObject({ code: "storage_unavailable" });
    expect(String(rejected[0]!.reason)).not.toContain(targetPath);
    expect(String(rejected[0]!.reason)).not.toContain(chainAliasPath);

    await winner.close();
    const otherPath = fulfilledIndex === 0 ? chainAliasPath : targetPath;
    const replacement = trackClient(
      await createWorkerDatabaseClient({ databasePath: otherPath }),
    );
    await expect(replacement.inspectSchema()).resolves.toEqual({ version: 3 });
  });

  it("rejects a symlink cycle with a stable path-free error", async () => {
    const directory = temporaryDirectory();
    const firstPath = join(directory, "authority-cycle-a.sqlite");
    const secondPath = join(directory, "authority-cycle-b.sqlite");
    symlinkSync("authority-cycle-b.sqlite", firstPath);
    symlinkSync("authority-cycle-a.sqlite", secondPath);

    const error = await rejectionOf(
      createWorkerDatabaseClient({ databasePath: firstPath }),
    );

    expect(error).toMatchObject({
      code: "storage_unavailable",
      message: "Authority database path could not be resolved",
    });
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(String(error)).not.toContain(firstPath);
    expect(String(error)).not.toContain(secondPath);
  });

  it("allows the same canonical path to be opened after a successful close", async () => {
    const path = databasePath();
    const first = trackClient(
      await createWorkerDatabaseClient({ databasePath: path }),
    );
    await first.close();

    const replacement = trackClient(
      await createWorkerDatabaseClient({ databasePath: path }),
    );
    await expect(replacement.inspectSchema()).resolves.toEqual({ version: 3 });
  });

  it("releases the path after initialization failure so a retry can succeed", async () => {
    const path = databasePath();
    const worker = scriptedWorker(`
      const { parentPort } = require("node:worker_threads");
      if (parentPort === null) throw new Error("missing parent port");
      parentPort.on("message", (request) => {
        parentPort.postMessage({
          type: "authority.error",
          requestId: request.requestId,
          code: "storage_unavailable",
          message: "Authority database initialization failed",
        });
      });
    `);
    const firstError = await rejectionOf(
      createWorkerDatabaseClientForTest({ databasePath: path }, () => worker),
    );
    expect(firstError).toMatchObject({ code: "storage_unavailable" });

    await expectDatabasePathEventuallyReusable(path);
  });

  it("releases the path after a worker crash so a replacement can start", async () => {
    const path = databasePath();
    const worker = workerThatRuns("// Deliberately leave inspect requests pending.");
    const client = trackClient(
      await createWorkerDatabaseClientForTest({ databasePath: path }, () => worker),
    );
    const pendingRejection = rejectionOf(client.inspectSchema());

    await worker.terminate();
    await expect(pendingRejection).resolves.toMatchObject({
      code: "authority_worker_exited",
    });
    const replacement = trackClient(
      await createWorkerDatabaseClient({ databasePath: path }),
    );
    await expect(replacement.inspectSchema()).resolves.toEqual({ version: 3 });
  });

  it("keeps the path reserved until terminal transport teardown completes", async () => {
    const path = databasePath();
    const transport = new DeferredTerminationTransport();
    const client = trackClient(
      await createWorkerDatabaseClientForTest({ databasePath: path }, () => transport),
    );
    const terminalRejection = rejectionOf(client.inspectSchema());
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));

    const pendingBeforeTeardown = await Promise.race([
      terminalRejection.then((error) => ({ status: "rejected" as const, error })),
      new Promise<{ readonly status: "pending" }>((resolvePending) =>
        setImmediate(() => resolvePending({ status: "pending" })),
      ),
    ]);
    const laterRejection = rejectionOf(client.inspectSchema());
    const laterBeforeTeardown = await Promise.race([
      laterRejection.then((error) => ({ status: "rejected" as const, error })),
      new Promise<{ readonly status: "pending" }>((resolvePending) =>
        setImmediate(() => resolvePending({ status: "pending" })),
      ),
    ]);

    const duplicate = await Promise.allSettled([
      createWorkerDatabaseClient({ databasePath: path }),
    ]).then(([result]) => result!);
    if (duplicate.status === "fulfilled") {
      trackClient(duplicate.value);
      await duplicate.value.close();
    }

    transport.finishTermination();
    const terminalError = await terminalRejection;
    const laterError = await laterRejection;
    await expectDatabasePathEventuallyReusable(path);

    expect(pendingBeforeTeardown).toEqual({
      status: "rejected",
      error: terminalError,
    });
    expect(laterBeforeTeardown).toEqual({
      status: "rejected",
      error: terminalError,
    });
    expect(terminalError).toMatchObject({ code: "authority_worker_message_error" });
    expect(laterError).toBe(terminalError);
    expect(duplicate.status).toBe("rejected");
    if (duplicate.status === "rejected") {
      expect(duplicate.reason).toMatchObject({
        code: "authority_coordinator_exists",
      });
    }
  });

  it("allows different canonical database paths concurrently", async () => {
    const [first, second] = await Promise.all([
      createWorkerDatabaseClient({ databasePath: databasePath() }),
      createWorkerDatabaseClient({ databasePath: databasePath() }),
    ]);
    trackClient(first);
    trackClient(second);

    await expect(
      Promise.all([first.inspectSchema(), second.inspectSchema()]),
    ).resolves.toEqual([{ version: 3 }, { version: 3 }]);
  });
});

describe("public worker transport errors", () => {
  it("sanitizes an error thrown while constructing the worker transport", async () => {
    const path = databasePath();
    const error = await rejectionOf(
      createWorkerDatabaseClientForTest({ databasePath: path }, () => {
        throw secretTransportError();
      }),
    );

    expectSanitizedError(error, "authority_worker_error");
    await expectDatabasePathEventuallyReusable(path);
  });

  it("sanitizes an error thrown while posting initialization", async () => {
    const path = databasePath();
    const transport = new ThrowingPostTransport(
      "authority.initialize",
      secretTransportError(),
    );
    const error = await rejectionOf(
      createWorkerDatabaseClientForTest({ databasePath: path }, () => transport),
    );

    expectSanitizedError(error, "authority_worker_post_failed");
    await expectDatabasePathEventuallyReusable(path);
  });

  it("sanitizes an uncaught worker error", async () => {
    const path = databasePath();
    const worker = workerThatRuns(`
      throw new Error(
        "SELECT token FROM sessions at /private/authority.sqlite: super-secret-token"
      );
    `);
    const client = trackClient(
      await createWorkerDatabaseClientForTest({ databasePath: path }, () => worker),
    );

    const error = await rejectionOf(client.inspectSchema());

    expectSanitizedError(error, "authority_worker_error");
    await expectDatabasePathEventuallyReusable(path);
  });

  it("sanitizes a worker message deserialization error", async () => {
    const path = databasePath();
    const transport = new MessageErrorTransport(secretTransportError());
    const client = trackClient(
      await createWorkerDatabaseClientForTest({ databasePath: path }, () => transport),
    );

    const error = await rejectionOf(client.inspectSchema());

    expectSanitizedError(error, "authority_worker_message_error");
    await expectDatabasePathEventuallyReusable(path);
  });

  it("sanitizes a post failure during close and releases the coordinator", async () => {
    const path = databasePath();
    const transport = new ThrowingPostTransport(
      "authority.close",
      secretTransportError(),
    );
    const client = trackClient(
      await createWorkerDatabaseClientForTest({ databasePath: path }, () => transport),
    );

    const error = await rejectionOf(client.close());

    expectSanitizedError(error, "authority_worker_post_failed");
    await expectDatabasePathEventuallyReusable(path);
  });
});

describe("WorkerDatabaseClient", () => {
  it("migrates in a real worker while the main event loop remains responsive", async () => {
    const path = databasePath();
    const opening = createWorkerDatabaseClient({ databasePath: path });
    const heartbeat = new Promise<void>((resolve) => setImmediate(resolve));

    await expect(heartbeat).resolves.toBeUndefined();
    const client = trackClient(await opening);
    await expect(client.inspectSchema()).resolves.toEqual({ version: 3 });
  });

  it("correlates concurrent responses to monotonically increasing request IDs", async () => {
    const worker = workerThatRuns(`
      if (!Array.isArray(globalThis.inspectRequests)) globalThis.inspectRequests = [];
      globalThis.inspectRequests.push(request);
      if (globalThis.inspectRequests.length === 2) {
        const [first, second] = globalThis.inspectRequests;
        if (first.requestId !== "2" || second.requestId !== "3") {
          parentPort.postMessage({
            type: "authority.error",
            requestId: first.requestId,
            code: "request_ids_not_monotonic",
            message: "Request IDs were not monotonic",
          });
          return;
        }
        parentPort.postMessage({
          type: "authority.error",
          requestId: second.requestId,
          code: "second_inspect_failed",
          message: "The second inspection failed",
        });
        setImmediate(() => parentPort.postMessage({
          type: "authority.schema",
          requestId: first.requestId,
          schemaVersion: 3,
        }));
      }
    `);
    const client = trackClient(
      await createWorkerDatabaseClientForTest(
        { databasePath: databasePath() },
        () => worker,
      ),
    );

    const first = client.inspectSchema();
    const secondRejection = rejectionOf(client.inspectSchema());

    await expect(first).resolves.toEqual({ version: 3 });
    await expect(secondRejection).resolves.toMatchObject({
      code: "second_inspect_failed",
    });
  });

  it("atomically rejects pending and later calls with one stable exit error", async () => {
    const worker = workerThatRuns("// Deliberately leave inspect requests pending.");
    const client = trackClient(
      await createWorkerDatabaseClientForTest(
        { databasePath: databasePath() },
        () => worker,
      ),
    );
    const firstPendingRejection = rejectionOf(client.inspectSchema());
    const secondPendingRejection = rejectionOf(client.inspectSchema());

    await worker.terminate();
    const pendingError = await firstPendingRejection;
    const secondPendingError = await secondPendingRejection;
    const laterError = await rejectionOf(client.inspectSchema());
    const closeError = await rejectionOf(client.close());

    expect(pendingError).toMatchObject({ code: "authority_worker_exited" });
    expect(secondPendingError).toBe(pendingError);
    expect(laterError).toBe(pendingError);
    expect(closeError).toBe(pendingError);
  });

  it("turns an uncaught worker error into one stable terminal failure", async () => {
    const worker = workerThatRuns('throw new Error("simulated worker crash");');
    const client = trackClient(
      await createWorkerDatabaseClientForTest(
        { databasePath: databasePath() },
        () => worker,
      ),
    );

    const pendingError = await rejectionOf(client.inspectSchema());
    const laterError = await rejectionOf(client.inspectSchema());

    expect(pendingError).toMatchObject({ code: "authority_worker_error" });
    expect(laterError).toBe(pendingError);
  });

  it("turns message deserialization failure into one stable terminal failure", async () => {
    const transport = new MessageErrorTransport();
    const client = trackClient(
      await createWorkerDatabaseClientForTest(
        { databasePath: databasePath() },
        () => transport,
      ),
    );

    const pendingError = await rejectionOf(client.inspectSchema());
    const laterError = await rejectionOf(client.inspectSchema());

    expect(pendingError).toMatchObject({ code: "authority_worker_message_error" });
    expect(laterError).toBe(pendingError);
  });

  it("fails atomically when a worker sends an extra response field", async () => {
    const path = databasePath();
    const worker = workerThatRuns(`
      parentPort.postMessage({
        type: "authority.schema",
        requestId: request.requestId,
        schemaVersion: 3,
        extra: true,
      });
    `);
    const client = trackClient(
      await createWorkerDatabaseClientForTest(
        { databasePath: path },
        () => worker,
      ),
    );

    const pendingError = await rejectionOf(client.inspectSchema());
    const laterError = await rejectionOf(client.inspectSchema());

    expect(pendingError).toMatchObject({ code: "authority_worker_protocol_error" });
    expect(laterError).toBe(pendingError);
    await expectDatabasePathEventuallyReusable(path);
  });

  it("acknowledges close after shutdown and treats double close as idempotent", async () => {
    const client = trackClient(
      await createWorkerDatabaseClient({ databasePath: databasePath() }),
    );

    const firstClose = client.close();
    const secondClose = client.close();

    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.inspectSchema()).rejects.toMatchObject({
      code: "authority_worker_closed",
    });
  });

  it("keeps a closed client monotonic after late error events", async () => {
    const transport = new CloseRaceTransport();
    const client = trackClient(
      await createWorkerDatabaseClientForTest(
        { databasePath: databasePath() },
        () => transport,
      ),
    );

    const closing = client.close();
    transport.acknowledgeClose();
    await closing;
    const closedError = await rejectionOf(client.inspectSchema());

    transport.emit("error", secretTransportError());
    transport.emit("messageerror", secretTransportError());
    const afterLateEvents = await rejectionOf(client.inspectSchema());

    expect(closedError).toMatchObject({ code: "authority_worker_closed" });
    expect(afterLateEvents).toBe(closedError);
    expect(transport.terminateCalls).toBe(0);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("rejects all pending work when close is acknowledged first", async () => {
    const transport = new CloseRaceTransport();
    const client = trackClient(
      await createWorkerDatabaseClientForTest(
        { databasePath: databasePath() },
        () => transport,
      ),
    );
    const pendingInspection = rejectionOf(client.inspectSchema());
    const closing = client.close();

    transport.acknowledgeClose();
    await closing;
    const pendingBeforeLateResponse = await Promise.race([
      pendingInspection.then((error) => ({ status: "rejected" as const, error })),
      new Promise<{ readonly status: "pending" }>((resolvePending) =>
        setImmediate(() => resolvePending({ status: "pending" })),
      ),
    ]);
    const closedError = await rejectionOf(client.inspectSchema());
    transport.sendLateInspection();
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    const afterLateResponse = await rejectionOf(client.inspectSchema());

    expect(pendingBeforeLateResponse).toEqual({
      status: "rejected",
      error: closedError,
    });
    expect(afterLateResponse).toBe(closedError);
    expect(transport.terminateCalls).toBe(0);
  });

  it("reports initialization failure without leaking a path or an unhandled rejection", async () => {
    const invalidDatabasePath = databasePath().replace(/authority\.sqlite$/, "missing/db.sqlite");
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const client = trackClient(
        await createWorkerDatabaseClient({ databasePath: invalidDatabasePath }),
      );
      expect(existsSync(invalidDatabasePath)).toBe(false);
      const error = await rejectionOf(client.inspectSchema());
      await new Promise<void>((resolve) => setImmediate(resolve));
      const laterError = await rejectionOf(client.inspectSchema());

      expect(error).toMatchObject({ code: "storage_unavailable" });
      expect(laterError).toBe(error);
      expect(String(error)).not.toContain(invalidDatabasePath);
      expect(unhandled).toEqual([]);
      mkdirSync(dirname(invalidDatabasePath), { recursive: true });
      await expectDatabasePathEventuallyReusable(invalidDatabasePath);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not expose test controls or the worker protocol from the package", async () => {
    const publicApi: Record<string, unknown> = await import("../index.js");

    expect(publicApi).not.toHaveProperty("createWorkerDatabaseClientForTest");
    expect(publicApi).not.toHaveProperty("isAuthorityWorkerRequest");
    expect(publicApi).not.toHaveProperty("isAuthorityWorkerResponse");
  });
});
