import { createHash, generateKeyPairSync } from "node:crypto";
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
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  AuthorityWorkerClientError,
  createWorkerDatabaseClient,
  createWorkerDatabaseClientWithRollbackFailureForTest,
  createWorkerDatabaseClientForTest,
  type AuthorityWorkerTransport,
  type WorkerDatabaseClient,
} from "./worker-database-client.js";
import {
  AuthorityRollbackFatalError,
  executeHumanDatabaseCommand,
  runAuthorityImmediateTransaction,
} from "./authority-database-handler.js";
import {
  isAuthorityWorkerErrorCode,
  isAuthorityWorkerRequest,
  isAuthorityWorkerResponse,
  type AuthorityWorkerRequest,
  type AuthorityWorkerResponse,
} from "./worker-protocol.js";
import { MAX_ACTIVE_SESSION_FAMILIES } from "./contracts.js";
import {
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToVersion13ForTest,
} from "./schema.js";

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
  await expect(replacement.inspectSchema()).resolves.toEqual({ version: 27 });
}

async function expectDatabasePathEventuallyReusable(path: string): Promise<void> {
  let coordinatorError: unknown;
  const deadline = Date.now() + 2_000;
  do {
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
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  } while (Date.now() < deadline);
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
          schemaVersion: 27,
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
          schemaVersion: 27,
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

class OperationStorageProbeTransport extends EventEmitter implements AuthorityWorkerTransport {
  #failedInspections = 0;

  postMessage(request: AuthorityWorkerRequest): void {
    if (request.type === "authority.initialize") {
      queueMicrotask(() => this.emit("message", {
        type: "authority.ready",
        requestId: request.requestId,
        schemaVersion: 27,
      } satisfies AuthorityWorkerResponse));
      return;
    }
    if (request.type === "authority.close") {
      queueMicrotask(() => this.emit("message", {
        type: "authority.closed",
        requestId: request.requestId,
      } satisfies AuthorityWorkerResponse));
      return;
    }
    if (request.type !== "authority.inspect-schema") throw new Error("unexpected request");
    if (this.#failedInspections < 2) {
      const code = this.#failedInspections === 0
        ? "authority_storage_transient" as const
        : "authority_operation_unavailable" as const;
      this.#failedInspections += 1;
      queueMicrotask(() => this.emit("message", {
        type: "authority.error",
        requestId: request.requestId,
        code,
        message: "Authority database inspection failed",
      } satisfies AuthorityWorkerResponse));
      return;
    }
    queueMicrotask(() => this.emit("message", {
      type: "authority.schema",
      requestId: request.requestId,
      schemaVersion: 27,
    } satisfies AuthorityWorkerResponse));
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class CapabilityProbeTransport extends EventEmitter implements AuthorityWorkerTransport {
  readonly requests: AuthorityWorkerRequest[] = [];

  postMessage(request: AuthorityWorkerRequest): void {
    this.requests.push(request);
    if (request.type === "authority.initialize") {
      queueMicrotask(() => this.emit("message", {
        type: "authority.ready",
        requestId: request.requestId,
        schemaVersion: 27,
      } satisfies AuthorityWorkerResponse));
      return;
    }
    queueMicrotask(() => this.emit("message", {
      type: "authority.command-acknowledged",
      requestId: request.requestId,
      acknowledgement: {
        aggregateId: "forged-write",
        eventIds: ["forged-event"],
        acceptedAt: "2026-08-10T00:00:00.000Z",
        result: {},
      },
    } satisfies AuthorityWorkerResponse));
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class SyncResultProbeTransport extends EventEmitter implements AuthorityWorkerTransport {
  constructor(
    private readonly responseFor: (
      request: Extract<AuthorityWorkerRequest, { readonly type: "authority.sync-room" }>,
    ) => unknown,
  ) {
    super();
  }

  postMessage(request: AuthorityWorkerRequest): void {
    if (request.type === "authority.initialize") {
      queueMicrotask(() => this.emit("message", {
        type: "authority.ready",
        requestId: request.requestId,
        schemaVersion: 27,
      } satisfies AuthorityWorkerResponse));
      return;
    }
    if (request.type !== "authority.sync-room") {
      throw new Error("unexpected sync probe request");
    }
    queueMicrotask(() => this.emit("message", this.responseFor(request)));
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class CompactionResultProbeTransport extends EventEmitter implements AuthorityWorkerTransport {
  constructor(
    private readonly responseFor: (
      request: Extract<AuthorityWorkerRequest, {
        readonly type: "authority.compact-room-stream";
      }>,
    ) => unknown,
  ) {
    super();
  }

  postMessage(request: AuthorityWorkerRequest): void {
    if (request.type === "authority.initialize") {
      queueMicrotask(() => this.emit("message", {
        type: "authority.ready",
        requestId: request.requestId,
        schemaVersion: 27,
      } satisfies AuthorityWorkerResponse));
      return;
    }
    if (request.type !== "authority.compact-room-stream") {
      throw new Error("unexpected compaction probe request");
    }
    queueMicrotask(() => this.emit("message", this.responseFor(request)));
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

class PreviewDeliveryBarrierProbeTransport extends EventEmitter implements AuthorityWorkerTransport {
  readonly requests: AuthorityWorkerRequest[] = [];
  #previewRequest: Extract<AuthorityWorkerRequest, { type: "authority.runtime" }> | undefined;

  postMessage(request: AuthorityWorkerRequest): void {
    this.requests.push(request);
    if (request.type === "authority.initialize") {
      queueMicrotask(() => this.emit("message", {
        type: "authority.ready",
        requestId: request.requestId,
        schemaVersion: 27,
      } satisfies AuthorityWorkerResponse));
      return;
    }
    if (request.type === "authority.close") {
      queueMicrotask(() => this.emit("message", {
        type: "authority.closed",
        requestId: request.requestId,
      } satisfies AuthorityWorkerResponse));
      return;
    }
    if (request.type !== "authority.runtime") throw new Error("unexpected barrier probe request");
    if (request.operation.type === "runtime.preview-authorize") {
      this.#previewRequest = request;
      return;
    }
    queueMicrotask(() => this.emit("message", {
      type: "authority.runtime-result",
      requestId: request.requestId,
      result: { kind: "runtime-recovery", records: [], hasMore: false },
    } satisfies AuthorityWorkerResponse));
  }

  authorizePreview(): void {
    if (this.#previewRequest === undefined) throw new Error("preview request was not posted");
    this.emit("message", {
      type: "authority.runtime-result",
      requestId: this.#previewRequest.requestId,
      result: {
        kind: "preview-authority",
        authorized: true,
        authorityEpoch: "epoch:1",
        subscriptionGeneration: 1,
      },
    } satisfies AuthorityWorkerResponse);
  }

  async terminate(): Promise<number> { return 0; }
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
          schemaVersion: 27,
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
          schemaVersion: 27,
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

class RejectingTerminationTransport
  extends EventEmitter
  implements AuthorityWorkerTransport
{
  postMessage(request: AuthorityWorkerRequest): void {
    if (request.type === "authority.initialize") {
      queueMicrotask(() => {
        this.emit("message", {
          type: "authority.ready",
          requestId: request.requestId,
          schemaVersion: 27,
        } satisfies AuthorityWorkerResponse);
      });
      return;
    }
    queueMicrotask(() => this.emit("messageerror", secretTransportError()));
  }

  async terminate(): Promise<number> {
    throw new Error("transport termination rejected");
  }

  signalExit(): void {
    this.emit("exit", 1);
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
          schemaVersion: 27,
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
      schemaVersion: 27,
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
  it("closes Attachment Authority worker operations and safe result envelopes", () => {
    const operation = {
      kind: "upload-begin" as const,
      context: {
        kind: "human" as const,
        sessionId: "attachment-session",
        sessionFamilyId: "attachment-family",
        principal: { accountId: "attachment-account", actorId: "attachment-actor" },
      },
      command: {
        requestId: "attachment-request",
        roomId: "attachment-room",
        uploadKey: "attachment-upload-key",
        originalFilename: "safe.txt",
        declaredMime: "text/plain" as const,
        expectedBytes: 4,
        expectedSha256: "a".repeat(64),
      },
    };
    expect(isAuthorityWorkerRequest({
      type: "authority.attachment",
      requestId: "worker-attachment-request",
      operation,
      now: 1_000,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.attachment",
      requestId: "worker-attachment-forged",
      operation: { ...operation, path: "/private/leak" },
      now: 1_000,
    })).toBe(false);
    expect(isAuthorityWorkerResponse({
      type: "authority.attachment-result",
      requestId: "worker-attachment-request",
      result: {
        uploadId: "upload-1",
        acknowledgedBytes: 0,
        expectedBytes: 4,
        status: "open",
        replayed: false,
      },
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.attachment-result",
      requestId: "worker-attachment-request",
      result: {
        uploadId: "upload-1",
        acknowledgedBytes: 0,
        expectedBytes: 4,
        status: "open",
        replayed: false,
        rawBytes: "forged",
      },
    })).toBe(false);
    expect(isAuthorityWorkerRequest({
      type: "authority.attachment",
      requestId: "worker-attachment-reconcile",
      operation: {
        kind: "object-references",
        context: { kind: "attachment-worker", workerId: "object-reconciler" },
      },
      now: 1_000,
    })).toBe(true);
    const referenceResult = {
      referencedUploadIds: ["00000000-0000-4000-8000-000000000001"],
      referencedQuarantineAttachmentIds: ["00000000-0000-4000-8000-000000000101"],
      referencedObjectKeys: [`object_${"a".repeat(64)}`],
    };
    expect(isAuthorityWorkerResponse({
      type: "authority.attachment-result",
      requestId: "worker-attachment-reconcile",
      result: referenceResult,
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.attachment-result",
      requestId: "worker-attachment-reconcile-forged",
      result: { ...referenceResult, rawBytes: "forged" },
    })).toBe(false);
  });

  it("rejects symbol and non-enumerable own keys in Message Authority requests", () => {
    const request = {
      type: "authority.message-submit" as const,
      requestId: "message-submit-exact",
      context: {
        kind: "human" as const,
        sessionId: createHash("sha256").update("message-session").digest("base64url"),
        sessionFamilyId: createHash("sha256").update("message-family").digest("base64url"),
        principal: { accountId: "account-1", actorId: "human-1" },
        requestId: "message-submit-command",
        idempotencyKey: "message-submit-key",
      },
      message: {
        messageId: "message-exact",
        roomId: "room-exact",
        body: "@Agent hello",
        mentionedTargets: [{
          id: "target-agent",
          kind: "agent-invocation" as const,
          targetActorId: "agent-1",
          range: { startUtf16: 0, endUtf16: 6 },
        }],
        attachments: [],
      },
      now: 1_000,
    };
    expect(isAuthorityWorkerRequest(request)).toBe(true);

    const symbolExtra = structuredClone(request) as typeof request & Record<PropertyKey, unknown>;
    symbolExtra[Symbol("authority-extra")] = true;
    expect(isAuthorityWorkerRequest(symbolExtra)).toBe(false);

    const nonEnumerableExtra = structuredClone(request) as typeof request &
      Record<PropertyKey, unknown>;
    Object.defineProperty(nonEnumerableExtra.message.mentionedTargets[0], "capability", {
      configurable: true,
      value: "forged",
    });
    expect(isAuthorityWorkerRequest(nonEnumerableExtra)).toBe(false);
  });

  it("accepts a bound device in authenticated commands without weakening exact keys", () => {
    const request = {
      type: "authority.message-submit" as const,
      requestId: "message-submit-device-bound",
      context: {
        kind: "human" as const,
        sessionId: createHash("sha256").update("device-session").digest("base64url"),
        sessionFamilyId: createHash("sha256").update("device-family").digest("base64url"),
        deviceId: "desktop-installation-01",
        principal: { accountId: "account-1", actorId: "human-1" },
        requestId: "device-bound-command",
        idempotencyKey: "device-bound-command",
      },
      message: {
        messageId: "message-device-bound",
        roomId: "room-device-bound",
        body: "hello",
        mentionedTargets: [],
        attachments: [],
      },
      now: 1_000,
    };
    expect(isAuthorityWorkerRequest(request)).toBe(true);
    expect(isAuthorityWorkerRequest({
      ...request,
      context: { ...request.context, deviceId: undefined },
    })).toBe(false);
    expect(isAuthorityWorkerRequest({
      ...request,
      context: { ...request.context, unexpectedBinding: "forged" },
    })).toBe(false);
  });

  it("accepts only exact request variants", () => {
    const repairContext = {
      sessionId: createHash("sha256").update("repair-session").digest("base64url"),
      sessionFamilyId: createHash("sha256").update("repair-family").digest("base64url"),
      principal: { accountId: "repair-account", actorId: "repair-actor" },
    };
    const governanceContext = {
      ...repairContext,
      kind: "human" as const,
      requestId: "governance-command",
      idempotencyKey: "governance-command",
    };
    expect(
      isAuthorityWorkerRequest({
        type: "authority.initialize",
        requestId: "1",
      }),
    ).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.snapshot-revalidate",
      requestId: "snapshot-revalidate",
      validation: {
        kind: "room",
        context: {
          sessionId: createHash("sha256").update("snapshot-session").digest("base64url"),
          sessionFamilyId: createHash("sha256").update("snapshot-family").digest("base64url"),
          principal: { accountId: "account", actorId: "actor" },
        },
        roomId: "room",
        accessRevision: 1,
        watermark: 2,
      },
      now: 1_000,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.snapshot-revalidate",
      requestId: "snapshot-revalidate-extra",
      validation: {
        kind: "catalog",
        context: {
          sessionId: createHash("sha256").update("snapshot-session").digest("base64url"),
          sessionFamilyId: createHash("sha256").update("snapshot-family").digest("base64url"),
          principal: { accountId: "account", actorId: "actor" },
        },
        catalogRevision: 1,
        watermark: 2,
      },
      now: 1_000,
    })).toBe(false);
    expect(isAuthorityWorkerRequest({
      type: "authority.execute-human-governance",
      requestId: "governance-command",
      context: governanceContext,
      command: {
        type: "room.member.remove",
        roomId: "repair-room",
        payload: { targetActorId: "target-human", expectedGovernanceRevision: 3 },
      },
      now: 1_005,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.execute-human-governance",
      requestId: "governance-injected",
      context: governanceContext,
      command: {
        type: "room.member.remove",
        roomId: "repair-room",
        payload: {
          targetActorId: "target-human",
          expectedGovernanceRevision: 3,
          actorId: "forged-owner",
        },
      },
      now: 1_005,
    })).toBe(false);
    expect(isAuthorityWorkerRequest({
      type: "authority.departure-conflicts",
      requestId: "departure-conflicts",
      context: repairContext,
      roomId: "repair-room",
      targetActorId: "target-human",
      now: 1_005,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.repair-acquire",
      requestId: "repair-acquire",
      context: repairContext,
      scope: { kind: "room", roomId: "repair-room" },
      now: 1_000,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.repair-register",
      requestId: "repair-register",
      snapshotId: "repair-snapshot",
      checksum: "repair-checksum",
      pageCount: 3,
      now: 1_001,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.repair-authorize-page",
      requestId: "repair-page",
      context: repairContext,
      snapshotId: "repair-snapshot",
      page: 1,
      now: 1_002,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.repair-complete",
      requestId: "repair-complete",
      context: repairContext,
      snapshotId: "repair-snapshot",
      version: { kind: "room", roomId: "repair-room", watermark: 3 },
      checksum: "repair-checksum",
      now: 1_003,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.repair-release",
      requestId: "repair-release",
      context: repairContext,
      snapshotId: "repair-snapshot",
      now: 1_004,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.repair-acquire",
      requestId: "repair-acquire-extra",
      context: repairContext,
      scope: { kind: "catalog", principalId: "repair-actor", global: true },
      now: 1_000,
    })).toBe(false);
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
    expect(isAuthorityWorkerRequest({
      type: "authority.sessions-list",
      requestId: "sessions-list",
      accessTokenHash: createHash("sha256").update("sessions-access").digest("base64url"),
      now: 1_000,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.session-revoke-target",
      requestId: "session-revoke-target",
      accessTokenHash: createHash("sha256").update("sessions-access").digest("base64url"),
      publicSessionId: "public-session-b",
      now: 1_000,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.session-revoke-target",
      requestId: "session-revoke-target-extra",
      accessTokenHash: createHash("sha256").update("sessions-access").digest("base64url"),
      publicSessionId: "public-session-b",
      familyId: "must-not-cross-boundary",
      now: 1_000,
    })).toBe(false);
    expect(
      isAuthorityWorkerRequest({
        type: "authority.outbox-authorize",
        requestId: "outbox-authorize",
        deliveryId: "delivery-room",
        candidate: {
          connectionId: "connection-1",
          principal: { accountId: "account-li", actorId: "human-li" },
          sessionId: createHash("sha256").update("session-1").digest("base64url"),
          sessionFamilyId: createHash("sha256").update("family-1").digest("base64url"),
          credentialGeneration: 1,
        },
        now: 1_000,
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
    expect(
      isAuthorityWorkerRequest({
        type: "authority.outbox-authorize",
        requestId: "outbox-authorize-extra",
        deliveryId: "delivery-room",
        candidate: {
          connectionId: "connection-1",
          principal: { accountId: "account-li", actorId: "human-li" },
          sessionId: createHash("sha256").update("session-1").digest("base64url"),
          sessionFamilyId: createHash("sha256").update("family-1").digest("base64url"),
          credentialGeneration: 1,
          accessToken: "must-not-cross-worker-boundary",
        },
        now: 1_000,
      }),
    ).toBe(false);
    expect(
      isAuthorityWorkerRequest({
        type: "authority.outbox-failed",
        requestId: "outbox-failed-open-reason",
        deliveryId: "delivery-room",
        reason: "network_error",
      }),
    ).toBe(false);
  });

  it("accepts only exact response variants", () => {
    const governance = {
      roomId: "governance-room",
      projectId: "governance-room",
      lifecycle: "active" as const,
      governanceRevision: 3,
      ownerActorId: "governance-owner",
      archiveGeneration: 1,
    };
    const conflicts = {
      roomId: "governance-room",
      targetActorId: "target-human",
      governanceRevision: 3,
      conflicts: [],
    };
    expect(
      isAuthorityWorkerResponse({
        type: "authority.ready",
        requestId: "1",
        schemaVersion: 27,
      }),
    ).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.ready",
      requestId: "stale-schema",
      schemaVersion: 15,
    })).toBe(false);
    expect(isAuthorityWorkerResponse({
      type: "authority.snapshot-revalidated",
      requestId: "snapshot-revalidated",
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.snapshot-revalidated",
      requestId: "snapshot-revalidated-extra",
      allowed: true,
    })).toBe(false);
    expect(isAuthorityWorkerResponse({
      type: "authority.governance-acknowledged",
      requestId: "governance-ack",
      acknowledgement: { governance, eventIds: ["event-1"], replayed: false },
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.departure-conflicts",
      requestId: "departure-conflicts",
      conflicts,
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.error",
      requestId: "departure-blocked",
      code: "departure_blocked",
      message: "Departure is blocked",
      details: conflicts,
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.error",
      requestId: "departure-blocked-secret",
      code: "departure_blocked",
      message: "Departure is blocked",
      details: { ...conflicts, grant: "secret" },
    })).toBe(false);
    expect(isAuthorityWorkerResponse({
      type: "authority.error",
      requestId: "generic-secret",
      code: "role_forbidden",
      message: "Forbidden",
      details: conflicts,
    })).toBe(false);
    expect(isAuthorityWorkerResponse({
      type: "authority.repair-lease",
      requestId: "repair-lease",
      lease: {
        snapshotId: "repair-snapshot",
        principalId: "repair-actor",
        accountId: "repair-account",
        sessionFamilyId: createHash("sha256").update("repair-family").digest("base64url"),
        scope: { kind: "catalog", principalId: "repair-actor" },
        version: { kind: "catalog", catalogRevision: 4 },
        authorizationRevision: 4,
        checksum: "repair-checksum",
        pageCount: 3,
        lastPage: 2,
        highestAuthorizedPage: 0,
        idleExpiresAt: "2026-08-11T00:00:30.000Z",
      },
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.snapshot-completed",
      requestId: "repair-completed",
      completed: {
        type: "snapshot.completed",
        requestId: "repair-completed",
        snapshotId: "repair-snapshot",
        version: { kind: "catalog", catalogRevision: 4 },
      },
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.repair-released",
      requestId: "repair-released",
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.repair-released",
      requestId: "repair-released-extra",
      released: true,
    })).toBe(false);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.outbox",
        requestId: "outbox-valid",
        deliveries: [{
          deliveryId: "delivery-family",
          eventId: "event-family",
          targetKind: "session-family",
          targetId: "family-revoked",
          streamSeq: 1,
          attempts: 0,
          event: {
            eventId: "event-family",
            streamKind: "identity",
            streamId: "human-revoked",
            streamSeq: 1,
            actorId: "human-revoked",
            occurredAt: "2026-08-11T00:00:00.000Z",
            type: "identity.session.revoked",
            payload: {
              sessionId: "session-revoked",
              familyId: "family-revoked",
              accountId: "account-revoked",
            },
          },
        }],
      }),
    ).toBe(true);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.schema",
        requestId: "2",
        schemaVersion: 27,
      }),
    ).toBe(true);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.closed",
        requestId: "3",
      }),
    ).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.sessions",
      requestId: "sessions",
      sessions: [{
        id: "public-session-a",
        deviceLabel: "Mac A",
        platform: "macos",
        createdAt: "2026-08-18T00:00:00.000Z",
        refreshExpiresAt: "2026-09-18T00:00:00.000Z",
        current: true,
      }],
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.sessions",
      requestId: "sessions-secret",
      sessions: [{
        id: "public-session-a",
        deviceLabel: "Mac A",
        platform: "macos",
        refreshExpiresAt: "2026-09-18T00:00:00.000Z",
        current: true,
        accessTokenHash: createHash("sha256").update("secret").digest("base64url"),
      }],
    })).toBe(false);
    expect(isAuthorityWorkerResponse({
      type: "authority.sessions",
      requestId: "sessions-over-cap",
      sessions: Array.from(
        { length: MAX_ACTIVE_SESSION_FAMILIES + 1 },
        (_, index) => ({
          id: `public-session-${index}`,
          deviceLabel: `Device ${index}`,
          platform: "unknown",
          refreshExpiresAt: "2026-09-18T00:00:00.000Z",
          current: index === 0,
        }),
      ),
    })).toBe(false);
    expect(isAuthorityWorkerResponse({
      type: "authority.session-target-revoked",
      requestId: "target-revoked",
      publicSessionId: "public-session-b",
    })).toBe(true);
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
        type: "authority.error",
        requestId: "session-capacity",
        code: "session_limit_reached",
        message: "Session capacity reached",
      }),
    ).toBe(true);

    expect(
      isAuthorityWorkerResponse({
        type: "authority.schema",
        requestId: "5",
        schemaVersion: 27,
        rows: [],
      }),
    ).toBe(false);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.outbox",
        requestId: "outbox-invalid-family-event",
        deliveries: [{
          deliveryId: "delivery-family",
          eventId: "event-access",
          targetKind: "session-family",
          targetId: "family-revoked",
          streamSeq: 1,
          attempts: 0,
          event: {
            eventId: "event-access",
            streamKind: "identity",
            streamId: "human-revoked",
            streamSeq: 1,
            actorId: "human-revoked",
            occurredAt: "2026-08-11T00:00:00.000Z",
            type: "identity.room-access.changed",
            payload: { roomId: "room-1", change: "removed" },
          },
        }],
      }),
    ).toBe(false);
    expect(
      isAuthorityWorkerResponse({
        type: "authority.outbox",
        requestId: "outbox-invalid-principal-event",
        deliveries: [{
          deliveryId: "delivery-principal",
          eventId: "event-principal-revoked",
          targetKind: "principal",
          targetId: "human-revoked",
          streamSeq: 1,
          attempts: 0,
          event: {
            eventId: "event-principal-revoked",
            streamKind: "identity",
            streamId: "human-revoked",
            streamSeq: 1,
            actorId: "human-revoked",
            occurredAt: "2026-08-11T00:00:00.000Z",
            type: "identity.session.revoked",
            payload: {
              sessionId: "session-revoked",
              familyId: "family-revoked",
              accountId: "account-revoked",
            },
          },
        }],
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
      {
        workerData: {
          databasePath: databasePath(),
          testOnlyAllowMissingSharedAuthorityRecovery: true,
        },
      },
    );
    workers.add(worker);

    let response = once(worker, "message");
    worker.postMessage({ type: "authority.initialize", requestId: "1" });
    await expect(response).resolves.toEqual([
      { type: "authority.ready", requestId: "1", schemaVersion: 27 },
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
      { type: "authority.schema", requestId: "2", schemaVersion: 27 },
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
    await expect(initialized.inspectSchema()).resolves.toEqual({ version: 27 });
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
    await expect(replacement.inspectSchema()).resolves.toEqual({ version: 27 });
  });

  it("rejects a hardlink added while the original database is live", async () => {
    const path = databasePath();
    const aliasPath = join(dirname(path), "authority-live-hardlink.sqlite");
    const original = trackClient(
      await createWorkerDatabaseClient({ databasePath: path }),
    );
    await expect(original.inspectSchema()).resolves.toEqual({ version: 27 });
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
    await expect(original.inspectSchema()).resolves.toEqual({ version: 27 });
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
    await expect(replacement.inspectSchema()).resolves.toEqual({ version: 27 });
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
    await expect(replacement.inspectSchema()).resolves.toEqual({ version: 27 });
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

    await expectDatabasePathReusable(path);
  });

  it("keeps the worker usable after an operation-level storage outage", async () => {
    const transport = new OperationStorageProbeTransport();
    const client = trackClient(await createWorkerDatabaseClientForTest(
      { databasePath: databasePath() },
      () => transport,
    ));

    await expect(client.inspectSchema()).rejects.toMatchObject({
      code: "storage_unavailable",
      status: 503,
    });
    await expect(client.inspectSchema()).rejects.toMatchObject({
      code: "storage_unavailable",
      status: 503,
    });
    await expect(client.inspectSchema()).resolves.toEqual({ version: 27 });
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
    await expect(replacement.inspectSchema()).resolves.toEqual({ version: 27 });
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

  it("keeps a terminal reservation after terminate rejects until an explicit exit", async () => {
    const path = databasePath();
    const transport = new RejectingTerminationTransport();
    const client = trackClient(
      await createWorkerDatabaseClientForTest({ databasePath: path }, () => transport),
    );

    const terminalError = await rejectionOf(client.inspectSchema());
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    const laterError = await rejectionOf(client.inspectSchema());
    const duplicate = await Promise.allSettled([
      createWorkerDatabaseClient({ databasePath: path }),
    ]).then(([result]) => result!);
    if (duplicate.status === "fulfilled") {
      trackClient(duplicate.value);
      await duplicate.value.close();
    }

    expect(terminalError).toMatchObject({ code: "authority_worker_message_error" });
    expect(laterError).toBe(terminalError);
    expect(duplicate.status).toBe("rejected");
    if (duplicate.status === "rejected") {
      expect(duplicate.reason).toMatchObject({ code: "authority_coordinator_exists" });
    }

    transport.signalExit();
    await expectDatabasePathEventuallyReusable(path);
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
    ).resolves.toEqual([{ version: 27 }, { version: 27 }]);
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
  it("holds later authority mutations behind the synchronous preview delivery continuation", async () => {
    const transport = new PreviewDeliveryBarrierProbeTransport();
    const client = trackClient(await createWorkerDatabaseClientForTest(
      { databasePath: databasePath() },
      () => transport,
    ));
    const preview = client.executeRuntimeWithSynchronousDelivery({
      type: "runtime.preview-authorize",
      context: {
        sessionId: "session-preview-barrier",
        sessionFamilyId: "family-preview-barrier",
        principal: { accountId: "account-human-1", actorId: "human-1" },
      },
      roomId: "room-1",
      executionId: "execution-1",
      attemptSeq: 1,
      deliveryKind: "preview",
      subscriptionGeneration: 1,
      now: 1_755_000_000_000,
    }, (result) => {
      expect(result).toMatchObject({ kind: "preview-authority", authorized: true });
      expect(transport.requests.filter(({ type }) => type === "authority.runtime")).toHaveLength(1);
      return undefined;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.requests.filter(({ type }) => type === "authority.runtime")).toHaveLength(1);

    const laterTerminalMutation = client.executeRuntime({
      type: "runtime.recover",
      now: 1_755_000_000_001,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transport.requests.filter(({ type }) => type === "authority.runtime")).toHaveLength(1);

    transport.authorizePreview();
    await preview;
    await laterTerminalMutation;
    expect(transport.requests.filter(({ type }) => type === "authority.runtime")).toHaveLength(2);
    expect(transport.requests.at(-1)).toMatchObject({
      type: "authority.runtime",
      operation: { type: "runtime.recover" },
    });
  });

  it("releases the authority gate when the synchronous delivery continuation throws", async () => {
    const transport = new PreviewDeliveryBarrierProbeTransport();
    const client = trackClient(await createWorkerDatabaseClientForTest(
      { databasePath: databasePath() },
      () => transport,
    ));
    const preview = client.executeRuntimeWithSynchronousDelivery({
      type: "runtime.preview-authorize",
      context: {
        sessionId: "session-preview-throw",
        sessionFamilyId: "family-preview-throw",
        principal: { accountId: "account-human-1", actorId: "human-1" },
      },
      roomId: "room-1", executionId: "execution-1", attemptSeq: 1,
      deliveryKind: "preview", subscriptionGeneration: 1, now: 1_755_000_000_000,
    }, () => { throw new Error("socket closed during synchronous delivery"); });
    const laterMutation = client.executeRuntime({ type: "runtime.recover", now: 1_755_000_000_001 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    transport.authorizePreview();

    await expect(preview).rejects.toThrow("socket closed during synchronous delivery");
    await expect(laterMutation).resolves.toMatchObject({ kind: "runtime-recovery" });
  });

  it("maps the closed Profile fan-out capacity code to 429", () => {
    expect(isAuthorityWorkerErrorCode("profile_fanout_capacity_limited")).toBe(true);
    expect(new AuthorityWorkerClientError(
      "profile_fanout_capacity_limited",
      "Profile Assignment fan-out capacity was exceeded",
    )).toMatchObject({ status: 429, code: "profile_fanout_capacity_limited" });
  });

  it("migrates and idempotently recovers every archived authority participant on restart", async () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    migrateAuthorityDatabaseToVersion13ForTest(legacy);
    legacy.exec(`
      INSERT INTO actors (id, kind, display_name)
      VALUES ('recovery-owner', 'human', 'Recovery Owner');
      INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
      VALUES
        ('identity', 'recovery-owner', 0, 1),
        ('room', 'recovery-room', 0, 1);
      INSERT INTO rooms (id, name, status, created_at)
      VALUES ('recovery-room', 'Recovery Room', 'active', '2026-08-19T00:00:00.000Z');
      INSERT INTO room_memberships (
        room_id, actor_id, kind, role, participation, tool_permissions_json,
        joined_at, configured_at, access_revision
      ) VALUES (
        'recovery-room', 'recovery-owner', 'human', 'member', NULL, '[]',
        '2026-08-19T00:00:00.000Z', NULL, 0
      );
      UPDATE rooms
      SET owner_actor_id = 'recovery-owner', governance_revision = 1
      WHERE id = 'recovery-room';
      UPDATE rooms
      SET status = 'archived', archive_generation = 1,
          archived_at = '2026-08-19T00:01:00.000Z'
      WHERE id = 'recovery-room';
    `);
    legacy.close();

    const options = {
      databasePath: path,
      sharedAuthorityRecovery: {
        ballPolicy: { openItemDeadlineMs: 41_000, lightTaskDeadlineMs: 43_000 },
        maxOfflineReadLeaseMs: 30_000,
      },
    } as const;
    let client = await createWorkerDatabaseClient(options);
    await client.close();
    client = await createWorkerDatabaseClient(options);
    await client.close();

    const recovered = new DatabaseSync(path, { readOnly: true });
    try {
      for (const table of [
        "room_message_archive_gates",
        "room_business_timer_freeze_batches",
        "tool_archive_settlements",
        "runtime_archive_fences",
        "room_assignment_archive_policies",
        "room_cache_invalidation_intents",
        "offline_read_lease_invalidations",
      ]) {
        expect(recovered.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
          .toEqual({ count: 1 });
      }
      expect(recovered.prepare(
        `SELECT suspended_count AS suspendedCount, descriptor_ids_json AS descriptorIds
         FROM room_business_timer_freeze_batches WHERE room_id = 'recovery-room'`,
      ).get()).toEqual({
        suspendedCount: 0,
        descriptorIds: '["dao.ball-runtime.business-boundaries.v1"]',
      });
      expect(recovered.prepare(
        `SELECT access_revision AS accessRevision, lease_generation AS leaseGeneration
         FROM room_access_authority WHERE room_id = 'recovery-room'`,
      ).get()).toEqual({ accessRevision: 1, leaseGeneration: 1 });
    } finally {
      recovered.close();
    }
  });

  it("fires after-domain-write after the message fact but before event, outbox, and idempotency", () => {
    const path = databasePath();
    const context = {
      kind: "human" as const,
      sessionId: "domain-probe-access",
      sessionFamilyId: "domain-probe-family",
      principal: { accountId: "domain-probe-account", actorId: "domain-probe-human" },
      requestId: "domain-probe-request",
      idempotencyKey: "domain-probe-message",
    };
    const database = new DatabaseSync(path);
    migrateAuthorityDatabase(database);
    database.prepare(
      `INSERT INTO actors (id, kind, display_name, reachability, readiness,
         tool_permissions_json, catalog_revision)
       VALUES (?, 'human', 'Probe', 'online', NULL, '[]', 0)`,
    ).run(context.principal.actorId);
    database.prepare(
      "INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES ('identity', ?, 0, 1)",
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO session_families (
         family_id, public_id, account_id, actor_id, device_id, device_label,
         platform, created_at, refresh_expires_at, revoked_at
       ) VALUES (?, 'domain-probe-public', ?, ?, 'probe', 'Probe', 'unknown', 0, 20000, NULL)`,
    ).run(context.sessionFamilyId, context.principal.accountId, context.principal.actorId);
    database.prepare(
      `INSERT INTO sessions (family_id, account_id, actor_id, access_token_hash,
         refresh_token_hash, access_expires_at, refresh_expires_at, revoked_at)
       VALUES (?, ?, ?, ?, 'refresh', 10000, 20000, NULL)`,
    ).run(context.sessionFamilyId, context.principal.accountId,
      context.principal.actorId, context.sessionId);
    database.prepare(
      "INSERT INTO rooms (id, name, status, created_at) VALUES ('domain-probe-room', 'Probe', 'active', 't')",
    ).run();
    database.prepare(
      `INSERT INTO room_memberships (room_id, actor_id, kind, role, participation,
         tool_permissions_json, joined_at, configured_at, access_revision)
       VALUES ('domain-probe-room', ?, 'human', 'member', NULL, '[]', 't', NULL, 0)`,
    ).run(context.principal.actorId);
    database.prepare(
      "UPDATE rooms SET owner_actor_id = ?, governance_revision = 1 WHERE id = 'domain-probe-room'",
    ).run(context.principal.actorId);
    database.prepare(
      "INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES ('room', 'domain-probe-room', 0, 1)",
    ).run();
    const probe = new Error("after-domain-write-probe");
    expect(() => executeHumanDatabaseCommand(database, {
      context,
      command: {
        type: "message.send",
        roomId: "domain-probe-room",
        payload: {
          id: "domain-probe-message",
          roomId: "domain-probe-room",
          body: "probe",
          sentAt: "2026-08-12T00:00:00.000Z",
        },
      },
      now: 1_000,
      afterDomainWrite() {
        expect(database.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get()).toEqual({ count: 0 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get()).toEqual({ count: 0 });
        throw probe;
      },
    })).toThrow(probe);
    expect(database.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
    database.close();
  });

  it("issues a server-signed offline read lease through the real AuthorityWorker", async () => {
    const path = databasePath();
    const context = {
      sessionId: createHash("sha256").update("offline-lease-access").digest("base64url"),
      sessionFamilyId: createHash("sha256").update("offline-lease-family").digest("base64url"),
      principal: { accountId: "offline-account", actorId: "offline-human" },
    };
    const database = new DatabaseSync(path);
    migrateAuthorityDatabase(database);
    database.exec(`
      INSERT INTO actors (id, kind, display_name, reachability, tool_permissions_json)
      VALUES ('offline-human', 'human', 'Offline Human', 'online', '[]');
      INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
      VALUES ('identity', 'offline-human', 0, 1), ('room', 'offline-room', 0, 1);
      INSERT INTO session_families (
        family_id, public_id, account_id, actor_id, device_id, device_label,
        platform, created_at, refresh_expires_at, revoked_at
      ) VALUES (
        '${context.sessionFamilyId}', 'offline-public', 'offline-account', 'offline-human',
        'offline-device', 'Offline Device', 'unknown', 0, 20000, NULL
      );
      INSERT INTO sessions (
        family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
        access_expires_at, refresh_expires_at, revoked_at
      ) VALUES (
        '${context.sessionFamilyId}', 'offline-account', 'offline-human',
        '${context.sessionId}', 'offline-refresh', 10000, 20000, NULL
      );
      INSERT INTO rooms (id, name, status, created_at, owner_actor_id, governance_revision)
      VALUES ('offline-room', 'Offline Room', 'active', 't', 'offline-human', 1);
      INSERT INTO room_memberships (
        room_id, actor_id, kind, role, participation, tool_permissions_json,
        joined_at, configured_at, access_revision
      ) VALUES ('offline-room', 'offline-human', 'human', 'owner', NULL, '[]', 't', NULL, 3);
      INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
      VALUES ('offline-room', 3, 2);
    `);
    database.close();
    const keys = generateKeyPairSync("ed25519");
    const client = await createWorkerDatabaseClient({
      databasePath: path,
      sharedAuthorityRecovery: {
        ballPolicy: { openItemDeadlineMs: 1, lightTaskDeadlineMs: 1 },
        maxOfflineReadLeaseMs: 30_000,
      },
      offlineReadLeaseSigning: {
        tenantId: "offline-tenant",
        serverSubject: "offline-server",
        keyId: "offline-key-1",
        privateKey: keys.privateKey,
      },
    });
    const lease = await client.issueOfflineReadLease(context, "offline-room", 30_000, 1_000);
    expect(lease.claims).toMatchObject({
      tenantId: "offline-tenant",
      accountId: "offline-account",
      actorId: "offline-human",
      sessionFamilyId: context.sessionFamilyId,
      deviceId: "offline-device",
      installationId: "offline-device",
      expiresAtMs: 20_000,
      room: { roomId: "offline-room", lifecycleGeneration: 0,
        accessRevision: 3, leaseGeneration: 2 },
    });
    expect(lease.token.split(".")).toHaveLength(2);
    await client.close();
    const inspection = new DatabaseSync(path, { readOnly: true });
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM offline_read_lease_issuances",
    ).get()).toEqual({ count: 1 });
    inspection.close();
  });

  it("serializes live snapshot revalidation with current session and revision state", async () => {
    const path = databasePath();
    const context = {
      sessionId: createHash("sha256").update("snapshot-access").digest("base64url"),
      sessionFamilyId: createHash("sha256").update("snapshot-family").digest("base64url"),
      principal: { accountId: "snapshot-account", actorId: "snapshot-human" },
    };
    const database = new DatabaseSync(path);
    migrateAuthorityDatabase(database);
    database.prepare(
      `INSERT INTO actors (
         id, kind, display_name, reachability, readiness, tool_permissions_json,
         catalog_revision
       ) VALUES (?, 'human', 'Snapshot Human', 'online', NULL, '[]', 4)`,
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
       VALUES ('identity', ?, 0, 1)`,
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO session_families (
         family_id, public_id, account_id, actor_id, device_id, device_label,
         platform, created_at, refresh_expires_at, revoked_at
       ) VALUES (?, 'snapshot-public', ?, ?, 'snapshot', 'Snapshot', 'unknown', 0, 20000, NULL)`,
    ).run(context.sessionFamilyId, context.principal.accountId, context.principal.actorId);
    database.prepare(
      `INSERT INTO sessions (
         family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
         access_expires_at, refresh_expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, 10000, 20000, NULL)`,
    ).run(context.sessionFamilyId, context.principal.accountId,
      context.principal.actorId, context.sessionId,
      createHash("sha256").update("snapshot-refresh").digest("base64url"));
    database.prepare(
      "INSERT INTO rooms (id, name, status, created_at) VALUES ('snapshot-room', 'Room', 'active', 't')",
    ).run();
    database.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES ('snapshot-room', ?, 'human', 'member', NULL, '[]', 't', NULL, 3)`,
    ).run(context.principal.actorId);
    database.prepare(
      "UPDATE rooms SET owner_actor_id = ?, governance_revision = 1 WHERE id = 'snapshot-room'",
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
       VALUES ('room', 'snapshot-room', 0, 1)`,
    ).run();
    database.close();

    const client = trackClient(await createWorkerDatabaseClient({ databasePath: path }));
    await expect(client.revalidateSnapshot({
      kind: "room", context, roomId: "snapshot-room", accessRevision: 3, watermark: 0,
    }, 1_000)).resolves.toBeUndefined();
    await expect(client.revalidateSnapshot({
      kind: "catalog", context, catalogRevision: 4,
    }, 1_000)).resolves.toBeUndefined();

    const writer = new DatabaseSync(path);
    writer.prepare(
      "UPDATE room_memberships SET access_revision = 4 WHERE room_id = 'snapshot-room' AND actor_id = ?",
    ).run(context.principal.actorId);
    writer.close();
    await expect(client.revalidateSnapshot({
      kind: "room", context, roomId: "snapshot-room", accessRevision: 3, watermark: 0,
    }, 1_000)).rejects.toMatchObject({ status: 409, code: "snapshot_stale" });
  });

  it("preserves both transaction and rollback failures in one internal fatal error", () => {
    const original = new Error("SELECT secret FROM authority at /private/original.sqlite");
    const rollback = new Error("ROLLBACK failed at /private/rollback.sqlite");
    const database = {
      exec(sql: string) {
        if (sql === "ROLLBACK") throw rollback;
      },
    };

    let failure: unknown;
    try {
      runAuthorityImmediateTransaction(database as never, () => { throw original; });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AuthorityRollbackFatalError);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([original, rollback]);
    expect(String(failure)).not.toContain("SELECT secret");
    expect(String(failure)).not.toContain("/private/");
  });

  it("poisons the worker after rollback failure and shares one terminal error", async () => {
    const path = databasePath();
    const client = trackClient(
      await createWorkerDatabaseClientWithRollbackFailureForTest({ databasePath: path }),
    );
    const missingSession = createHash("sha256").update("missing-session").digest("base64url");
    const missingFamily = createHash("sha256").update("missing-family").digest("base64url");
    const current = rejectionOf(client.executeHuman(
      {
        kind: "human",
        sessionId: missingSession,
        sessionFamilyId: missingFamily,
        principal: { accountId: "missing-account", actorId: "missing-actor" },
        requestId: "rollback-current",
        idempotencyKey: "rollback-current",
      },
      { type: "room.create", payload: { name: "must roll back" } },
      1_000,
    ));
    const concurrentPending = rejectionOf(client.inspectSchema());

    const currentError = await current;
    const pendingError = await concurrentPending;
    const laterError = await rejectionOf(client.inspectSchema());

    expect(currentError).toMatchObject({
      code: "storage_unavailable",
      status: 503,
      message: "Authority storage became unavailable",
    });
    expect(pendingError).toBe(currentError);
    expect(laterError).toBe(currentError);
    expect(String(currentError)).not.toContain(path);
    await expectDatabasePathEventuallyReusable(path);
  });

  it("rejects a structurally forged Agent context before posting to the worker", async () => {
    const transport = new CapabilityProbeTransport();
    const client = trackClient(await createWorkerDatabaseClientForTest(
      { databasePath: databasePath() },
      () => transport,
    ));

    await expect(client.executeAgent(
      {
        kind: "agent",
        agent: { actorId: "agent-forged", kind: "agent" },
        requestId: "forged-request",
        idempotencyKey: "forged-key",
      } as never,
      {
        type: "agent.judgment.record",
        roomId: "room-forged",
        payload: {
          messageId: "message-forged",
          outcome: "will_respond",
          reason: "forged",
        },
      },
      1_000,
    )).rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
    expect(transport.requests.map((request) => request.type)).toEqual([
      "authority.initialize",
    ]);
  });

  it("migrates in a real worker while the main event loop remains responsive", async () => {
    const path = databasePath();
    const opening = createWorkerDatabaseClient({ databasePath: path });
    const heartbeat = new Promise<void>((resolve) => setImmediate(resolve));

    await expect(heartbeat).resolves.toBeUndefined();
    const client = trackClient(await opening);
    await expect(client.inspectSchema()).resolves.toEqual({ version: 27 });
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
            code: "invalid_request",
            message: "Request IDs were not monotonic",
          });
          return;
        }
        parentPort.postMessage({
          type: "authority.error",
          requestId: second.requestId,
          code: "invalid_request",
          message: "The second inspection failed",
        });
        setImmediate(() => parentPort.postMessage({
          type: "authority.schema",
          requestId: first.requestId,
          schemaVersion: 27,
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

    await expect(first).resolves.toEqual({ version: 27 });
    await expect(secondRejection).resolves.toMatchObject({
      code: "invalid_request",
      status: 400,
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
        schemaVersion: 27,
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

  it.each([
    "request-id",
    "room-id",
    "first-sequence",
    "empty-skip",
    "event-limit",
    "continuation-watermark",
    "repair-not-expired",
    "duplicate-event-id",
  ] as const)("terminally rejects a room sync result with mismatched %s", async (mismatch) => {
    const path = databasePath();
    const event = (streamSeq: number, roomId = "room-1") => ({
      eventId: `event-${streamSeq}`,
      streamKind: "room" as const,
      streamId: roomId,
      streamSeq,
      roomId,
      actorId: "human-1",
      occurredAt: "2026-08-11T00:00:00.000Z",
      type: "member.removed" as const,
      payload: { targetActorId: "human-2" },
    });
    const transport = new SyncResultProbeTransport((request) => {
      if (mismatch === "repair-not-expired") {
        return {
          type: "authority.room-synced",
          requestId: request.requestId,
          result: {
            type: "room.sync.result",
            requestId: request.request.requestId,
            mode: "repair_required",
            reason: "cursor_expired",
            retainedFromSeq: 5,
            watermark: 10,
          },
        };
      }
      if (mismatch === "room-id") {
        return {
          type: "authority.room-synced",
          requestId: request.requestId,
          result: {
            type: "room.sync.result",
            requestId: request.request.requestId,
            mode: "delta",
            events: [event(1, "room-2")],
            nextCursor: { version: 1, roomId: "room-2", afterSeq: 1 },
            watermark: 1,
            hasMore: false,
          },
        };
      }
      const events = mismatch === "first-sequence"
        ? [event(2)]
        : mismatch === "empty-skip"
          ? []
        : mismatch === "duplicate-event-id"
          ? [event(1), { ...event(2), eventId: "event-1" }]
        : mismatch === "event-limit" || mismatch === "continuation-watermark"
          ? [event(1), event(2)]
          : [event(1)];
      const watermark = mismatch === "first-sequence" || mismatch === "empty-skip"
        ? 2
        : events.length;
      return {
        type: "authority.room-synced",
        requestId: request.requestId,
        result: {
          type: "room.sync.result",
          requestId: mismatch === "request-id" ? "wrong-request" : request.request.requestId,
          mode: "delta",
          events,
          nextCursor: { version: 1, roomId: "room-1", afterSeq: watermark },
          watermark,
          hasMore: false,
        },
      };
    });
    const client = trackClient(await createWorkerDatabaseClientForTest(
      { databasePath: path },
      () => transport,
    ));
    const continuation = mismatch === "continuation-watermark"
      ? { watermark: 1 }
      : {};
    const error = await rejectionOf(client.syncRoom(
      {
        sessionId: createHash("sha256").update("access").digest("base64url"),
        sessionFamilyId: createHash("sha256").update("family").digest("base64url"),
        principal: { accountId: "account-1", actorId: "human-1" },
      },
      {
        type: "room.sync",
        requestId: "sync-request",
        roomId: "room-1",
        cursor: {
          version: 1,
          roomId: "room-1",
          afterSeq: mismatch === "repair-not-expired" ? 5 : 0,
          ...continuation,
        },
        limit: mismatch === "duplicate-event-id" ? 2 : 1,
      },
      1_000,
    ));
    const laterError = await rejectionOf(client.inspectSchema());
    expect(error).toMatchObject({
      status: 503,
      code: "authority_worker_protocol_error",
      message: mismatch === "duplicate-event-id"
        ? "Authority worker sent a malformed response"
        : "Authority worker returned an invalid room-sync result",
    });
    expect(laterError).toBe(error);
    expect(publicErrorSurface(error)).not.toContain("wrong-request");
  });

  it.each(["room-id", "retained-from-seq"] as const)(
    "terminally rejects a room stream compaction result with mismatched %s",
    async (mismatch) => {
      const path = databasePath();
      const transport = new CompactionResultProbeTransport((request) => ({
        type: "authority.room-stream-compacted",
        requestId: request.requestId,
        roomId: mismatch === "room-id" ? "wrong-room" : request.roomId,
        retainedFromSeq: mismatch === "retained-from-seq"
          ? request.retainedFromSeq + 1
          : request.retainedFromSeq,
        headSeq: 5,
      }));
      const client = trackClient(await createWorkerDatabaseClientForTest(
        { databasePath: path },
        () => transport,
      ));

      const error = await rejectionOf(client.compactRoomStream("room-1", 2));
      const laterError = await rejectionOf(client.inspectSchema());

      expect(error).toMatchObject({
        status: 503,
        code: "authority_worker_protocol_error",
        message: "Authority worker returned an invalid room-stream compaction result",
      });
      expect(laterError).toBe(error);
      expect(publicErrorSurface(error)).not.toContain("wrong-room");
    },
  );

  it("fails terminally with a sanitized storage error for an unknown worker error code", async () => {
    const path = databasePath();
    const worker = workerThatRuns(`
      parentPort.postMessage({
        type: "authority.error",
        requestId: request.requestId,
        code: "future_unreviewed_error",
        message: "SELECT secret FROM sessions at /private/authority.sqlite",
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

    expect(pendingError).toMatchObject({
      code: "storage_unavailable",
      status: 503,
      message: "Authority storage became unavailable",
    });
    expect(laterError).toBe(pendingError);
    expect(publicErrorSurface(pendingError)).not.toContain("future_unreviewed_error");
    expect(publicErrorSurface(pendingError)).not.toContain("/private/authority.sqlite");
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
    expect(publicApi).not.toHaveProperty(
      "createWorkerDatabaseClientWithRollbackFailureForTest",
    );
    expect(publicApi).not.toHaveProperty("isAuthorityWorkerRequest");
    expect(publicApi).not.toHaveProperty("isAuthorityWorkerResponse");
  });

  it("narrows the package-root worker client so raw point queries are absent at runtime", async () => {
    const publicApi = await import("../index.js");
    const path = databasePath();
    const client = await publicApi.createWorkerDatabaseClient({ databasePath: path });
    try {
      expect(client).not.toHaveProperty("readActor");
      expect(client).not.toHaveProperty("readRoom");
      expect(client).not.toHaveProperty("executeHuman");
      expect(client).not.toHaveProperty("executeAgent");
      expect(client).not.toHaveProperty("revalidateSnapshot");
      expect(client).not.toHaveProperty("listPendingOutbox");
      expect(client).not.toHaveProperty("authorizeOutboxCandidate");
      expect(client).not.toHaveProperty("markOutboxDispatched");
      expect(client).not.toHaveProperty("markOutboxFailed");
      expect(publicApi).not.toHaveProperty("createSqliteAuthoritativeStore");
      expect(publicApi).not.toHaveProperty("createAuthoritativeRoomLifecycleService");
    } finally {
      await client.close();
    }
    if (existsSync(path)) {
      const database = new DatabaseSync(path, { readOnly: true });
      expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
        .toEqual({ count: 0 });
      database.close();
    }
  });
});
