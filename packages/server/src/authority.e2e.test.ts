import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, scryptSync } from "node:crypto";
import { access, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createIdentitySessionController,
  type AuthorizedStateInvalidator,
  type IdentityAuthoritySession,
  type IdentitySessionController,
} from "../../desktop/src/identity/controller.js";
import {
  IDENTITY_CONTRACT_LIMITS,
  type IdentityPublicState,
  type IdentityStoredCredentials,
} from "../../desktop/src/identity/contracts.js";
import type { IdentityCredentialVault } from "../../desktop/src/identity/credential-vault.js";
import type { DeviceIdentityStore } from "../../desktop/src/identity/device-identity.js";
import {
  createIdentityWebSocketClient,
  type IdentityWebSocketClient,
  type IdentityWebSocketLike,
} from "../../desktop/src/identity/websocket-client.js";
import { createScryptIdentityAdapter, MAX_ACTIVE_SESSION_FAMILIES } from "./auth.js";
import {
  startAuthoritativeServer,
  type AuthoritativeServer,
} from "./authoritative-server.js";
import { createWorkerDatabaseClient } from "./persistence/worker-database-client.js";
import { createWorkerRuntimeAuthority } from "./agent-runtime/worker-runtime-authority.js";
import type { ServerFrame } from "./protocol.js";
import {
  createClientSyncReplica,
  type ClientAuthorityCache,
  type RoomSubscriptionObserver,
  type SyncTransport,
} from "../../desktop/src/sync/client-sync-replica.js";
import { createDesktopGovernanceRuntime } from "../../desktop/src/governance/production-runtime.js";
import {
  createDesktopMessageAuthorityRuntime,
  type DesktopMessageAuthorityRuntime,
} from "../../desktop/src/message-authority/production-runtime.js";
import type { MessageAuthorityPortInput } from
  "../../desktop/src/message-authority/contracts.js";
import {
  type GovernanceWebSocketLike,
} from "../../desktop/src/governance/websocket-authority.js";
import {
  registerGovernanceIpc,
  type GovernanceIpcMain,
  type GovernanceIpcWebContents,
} from "../../desktop/src/governance/ipc.js";
import {
  createGovernanceBridge,
  type GovernanceIpcRenderer,
} from "../../desktop/src/governance/preload-bridge.js";
import { createDesktopAttachmentAuthorityRuntime } from
  "../../desktop/src/attachment-authority/production-runtime.js";
import type {
  AttachmentAuthorityIpcMain,
  AttachmentAuthorityIpcWebContents,
} from "../../desktop/src/attachment-authority/ipc.js";
import {
  createAttachmentAuthorityBridge,
  type AttachmentAuthorityIpcRenderer,
} from "../../desktop/src/attachment-authority/preload-bridge.js";
import { mountAttachmentComposerBridge } from
  "../../desktop/src/renderer/attachment-authority/composer-bridge.js";
import { mountDesktopRendererEntry } from "../../desktop/src/renderer/entry.js";
import type {
  Actor,
  PersistedRoomEvent,
  RoomCursor,
  RoomRepairPage,
  RoomRepairRecord,
  RoomSyncRequest,
  RoomSyncResult,
  SnapshotCompleted,
  SnapshotVersion,
  WorkspaceBootstrapPage,
} from "@native-im/core";
import { isActor, isRoomRepairPage } from "@native-im/core";

const actors = [
  {
    id: "human-a",
    kind: "human",
    displayName: "Human A",
    reachability: "online",
  },
  {
    id: "agent-a",
    kind: "agent",
    displayName: "Agent A",
    readiness: "ready",
    toolPermissions: ["authority.inspect"],
  },
] as const;
const previewActors = [
  actors[0],
  {
    ...actors[1],
    toolPermissions: ["repository.git-status"],
  },
] as const satisfies readonly Actor[];
const childStderr = new WeakMap<ChildProcessWithoutNullStreams, string>();
const childStdout = new WeakMap<ChildProcessWithoutNullStreams, string>();
const stressPageSize = 50;
const materializedPageSize = 100;

class NodeIdentityWebSocketAdapter implements IdentityWebSocketLike {
  readonly #socket: WebSocket;
  readonly #wrappers = new Map<
    "open" | "message" | "close" | "error",
    Map<(event: unknown) => void, (...args: unknown[]) => void>
  >();

  constructor(endpoint: string) {
    this.#socket = new WebSocket(endpoint);
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void {
    const byListener = this.#wrappers.get(type) ?? new Map();
    const wrapped = (...args: unknown[]): void => {
      if (type === "message") {
        const [data, isBinary] = args;
        listener({
          data: isBinary === true
            ? data
            : Buffer.from(data as Uint8Array).toString("utf8"),
        });
        return;
      }
      listener(args[0] ?? {});
    };
    byListener.set(listener, wrapped);
    this.#wrappers.set(type, byListener);
    this.#socket.on(type, wrapped);
  }

  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void {
    const byListener = this.#wrappers.get(type);
    const wrapped = byListener?.get(listener);
    if (wrapped === undefined) return;
    this.#socket.off(type, wrapped);
    byListener.delete(listener);
    if (byListener.size === 0) this.#wrappers.delete(type);
  }

  send(data: string): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }

  terminate(): void {
    this.#socket.terminate();
  }
}

function createAttachmentIpcHarness(): Readonly<{
  ipcMain: AttachmentAuthorityIpcMain;
  webContents: AttachmentAuthorityIpcWebContents;
  ipcRenderer: AttachmentAuthorityIpcRenderer;
  registeredHandlers(): number;
}> {
  type IpcEvent = Readonly<{ sender: unknown; senderFrame: unknown }>;
  type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;
  type Listener = (event: unknown, input: unknown) => void;
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<Listener>>();
  const mainFrame = Object.freeze({ kind: "attachment-e2e-main-frame" });
  const ipcMain: AttachmentAuthorityIpcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler as Handler);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  const webContents: AttachmentAuthorityIpcWebContents = {
    mainFrame,
    isDestroyed: () => false,
    send(channel, input) {
      for (const listener of listeners.get(channel) ?? []) {
        listener(Object.freeze({ sender: webContents }), structuredClone(input));
      }
    },
  };
  const ipcRenderer: AttachmentAuthorityIpcRenderer = {
    async invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new TypeError("Attachment E2E IPC handler is missing");
      return await handler({ sender: webContents, senderFrame: mainFrame }, ...args);
    },
    on(channel, listener) {
      const current = listeners.get(channel) ?? new Set<Listener>();
      current.add(listener);
      listeners.set(channel, current);
    },
    removeListener(channel, listener) {
      const current = listeners.get(channel);
      current?.delete(listener);
      if (current?.size === 0) listeners.delete(channel);
    },
  };
  return Object.freeze({
    ipcMain,
    webContents,
    ipcRenderer,
    registeredHandlers: () => handlers.size,
  });
}

function createMemoryCredentialVault(initial?: IdentityStoredCredentials): {
  readonly vault: IdentityCredentialVault;
  readonly read: () => IdentityStoredCredentials | undefined;
  readonly clear: ReturnType<typeof vi.fn>;
} {
  let stored = initial === undefined ? undefined : structuredClone(initial);
  const clear = vi.fn(async () => {
    stored = undefined;
  });
  return {
    vault: {
      async load() {
        return stored === undefined ? undefined : structuredClone(stored);
      },
      async save(credentials) {
        stored = structuredClone(credentials);
      },
      clear,
    },
    read: () => stored === undefined ? undefined : structuredClone(stored),
    clear,
  };
}

function createMemoryDevice(
  id: string,
  label: string,
): DeviceIdentityStore {
  return {
    async loadOrCreate() {
      return { id, label, platform: "macos" };
    },
  };
}

function createTrackedInvalidator(): AuthorizedStateInvalidator & {
  readonly invalidate: ReturnType<typeof vi.fn>;
} {
  return { invalidate: vi.fn(async () => undefined) };
}

function createDesktopClientFactory(
  endpoint: string,
  profile: string,
): () => IdentityWebSocketClient {
  let sequence = 0;
  return () => createIdentityWebSocketClient({
    endpoint,
    webSocketFactory: (url) => new NodeIdentityWebSocketAdapter(url),
    requestIdFactory: () => `${profile}-${++sequence}`,
    timeoutMs: 5_000,
  });
}

async function readAllRegularFiles(directory: string): Promise<readonly Buffer[]> {
  const contents: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(...await readAllRegularFiles(path));
    } else if (entry.isFile()) {
      contents.push(await readFile(path));
    }
  }
  return contents;
}

async function readRegularFileEntries(directory: string): Promise<readonly Readonly<{
  path: string;
  bytes: Buffer;
}>[]> {
  const contents: Array<Readonly<{ path: string; bytes: Buffer }>> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(...await readRegularFileEntries(path));
    } else if (entry.isFile()) {
      contents.push(Object.freeze({ path, bytes: await readFile(path) }));
    }
  }
  return contents;
}

async function readAuthorityCheckpointFiles(directory: string): Promise<readonly Readonly<{
  path: string;
  bytes: Buffer;
}>[]> {
  const names = await readdir(directory);
  return await Promise.all(names
    .filter((name) => /^(?:authority|snapshot-cache)\.sqlite(?:-(?:wal|shm))?$/u.test(name))
    .sort()
    .map(async (name) => Object.freeze({
      path: join(directory, name),
      bytes: await readFile(join(directory, name)),
    })));
}

function byteSentinelHits(
  entries: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
  sentinels: readonly string[],
): readonly string[] {
  const hits: string[] = [];
  for (const entry of entries) {
    for (const sentinel of sentinels) {
      if (Buffer.from(entry.bytes).includes(Buffer.from(sentinel, "utf8"))) {
        hits.push(`${entry.path}:${sentinel}`);
      }
    }
  }
  return hits;
}

function jsonSentinelHits(label: string, value: unknown, sentinels: readonly string[]): readonly string[] {
  const encoded = JSON.stringify(value);
  return sentinels.filter((sentinel) => encoded.includes(sentinel))
    .map((sentinel) => `${label}:${sentinel}`);
}

interface ChildStartOptions {
  readonly directory: string;
  readonly actors?: readonly Actor[];
  readonly identities?: readonly {
    readonly accountId: string;
    readonly actorId: string;
    readonly secret: string;
  }[];
  readonly seedAllFacts?: true;
  readonly seedGovernanceRoom?: true;
  readonly forceSnapshotFallback?: true;
  readonly snapshotRecordsPerPage?: number;
  readonly readbackOnly?: true;
  readonly inspectMessageIds?: readonly string[];
  readonly seedMixedRoomId?: string;
  readonly emitUnrelatedWarningForTest?: true;
  readonly closeCleanupProbe?: true;
  readonly seedRuntimeRoomForTest?: true;
  readonly enableAttachmentFixture?: true;
  readonly previewSentinelForTest?: string;
  readonly compactRoom?: {
    readonly roomId: string;
    readonly retainedFromSeq: number;
  };
  readonly faultPoint?:
    | "after-domain-write"
    | "before-commit"
    | "after-commit-before-outbox"
    | "after-send-before-dispatch-mark";
}

function startCommand(options: ChildStartOptions): Record<string, unknown> {
  return {
    type: "start",
    databasePath: join(options.directory, "authority.sqlite"),
    snapshotCachePath: join(options.directory, "snapshot-cache.sqlite"),
    actors: options.actors ?? actors,
    identity: {
      accountId: "account-a",
      actorId: "human-a",
      secret: "test-secret",
    },
    invitationSecretKey: Buffer.alloc(32, 7).toString("base64url"),
    ...(options.identities === undefined ? {} : { identities: options.identities }),
    ...(options.seedAllFacts === undefined ? {} : { seedAllFacts: true }),
    ...(options.seedGovernanceRoom === undefined ? {} : { seedGovernanceRoom: true }),
    ...(options.forceSnapshotFallback === undefined
      ? {}
      : { forceSnapshotFallback: true }),
    ...(options.snapshotRecordsPerPage === undefined
      ? {}
      : { snapshotRecordsPerPage: options.snapshotRecordsPerPage }),
    ...(options.readbackOnly === undefined ? {} : { readbackOnly: true }),
    ...(options.inspectMessageIds === undefined
      ? {}
      : { inspectMessageIds: options.inspectMessageIds }),
    ...(options.seedMixedRoomId === undefined
      ? {}
      : { seedMixedRoomId: options.seedMixedRoomId }),
    ...(options.compactRoom === undefined ? {} : { compactRoom: options.compactRoom }),
    ...(options.faultPoint === undefined ? {} : { faultPoint: options.faultPoint }),
    ...(options.emitUnrelatedWarningForTest === undefined
      ? {} : { emitUnrelatedWarningForTest: true }),
    ...(options.closeCleanupProbe === undefined ? {} : { closeCleanupProbe: true }),
    ...(options.seedRuntimeRoomForTest === undefined
      ? {}
      : { seedRuntimeRoomForTest: true }),
    ...(options.enableAttachmentFixture === undefined
      ? {}
      : { enableAttachmentFixture: true }),
    ...(options.previewSentinelForTest === undefined
      ? {}
      : { previewSentinelForTest: options.previewSentinelForTest }),
  };
}

function unexpectedChildStderr(child: ChildProcessWithoutNullStreams): string {
  const stderr = childStderr.get(child) ?? "";
  const known = /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g;
  return stderr.replace(known, "");
}

function waitForJsonLine(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 2_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Authority child did not emit a JSON line within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(deadline);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(buffered.slice(0, newline)) as unknown);
      } catch (error: unknown) {
        reject(error);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Authority child exited before ready: code=${code} signal=${signal}`));
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stopChild(
  child: ChildProcessWithoutNullStreams,
  termTimeoutMs = 1_000,
  killTimeoutMs = 1_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await childExit(child, termTimeoutMs);
    return;
  } catch {
    child.kill("SIGKILL");
  }
  await childExit(child, killTimeoutMs);
}

async function waitForRouteJudgmentCount(
  directory: string,
  roomId: string,
  expected: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let actual = -1;
  while (Date.now() <= deadline) {
    const database = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
    try {
      const count = database.prepare(
        `SELECT COUNT(*) AS count
         FROM route_judgments AS judgment
         INNER JOIN route_jobs AS job ON job.id = judgment.route_job_id
         WHERE job.room_id = ?`,
      );
      const row = count.get(roomId) as { readonly count: number };
      actual = row.count;
      if (row.count === expected) return;
    } finally {
      database.close();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Route judgments did not settle at ${expected} within ${timeoutMs}ms (actual=${actual})`,
  );
}

function readRoomHeadSeq(directory: string, roomId: string): number {
  const database = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
  try {
    const row = database.prepare(
      `SELECT head_seq AS headSeq FROM streams
       WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(roomId) as { readonly headSeq: number } | undefined;
    if (row === undefined || !Number.isSafeInteger(row.headSeq)) {
      throw new Error("Authoritative room stream head was missing");
    }
    return row.headSeq;
  } finally {
    database.close();
  }
}

async function waitForRoomAuthorityQuiescence(
  directory: string,
  roomId: string,
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let previousHead = -1;
  let stableSamples = 0;
  let pendingDeliveries = -1;
  while (Date.now() <= deadline) {
    const database = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
    let headSeq: number;
    try {
      const stream = database.prepare(
        `SELECT head_seq AS headSeq FROM streams
         WHERE stream_kind = 'room' AND stream_id = ?`,
      ).get(roomId) as { readonly headSeq: number } | undefined;
      if (stream === undefined || !Number.isSafeInteger(stream.headSeq)) {
        throw new TypeError("Authority quiescence observed an invalid Room stream");
      }
      headSeq = stream.headSeq;
      const pending = database.prepare(
        `SELECT COUNT(*) AS count
         FROM outbox_deliveries AS delivery
         INNER JOIN events AS event ON event.event_id = delivery.event_id
         WHERE event.stream_kind = 'room' AND event.stream_id = ?
           AND delivery.status <> 'dispatched'`,
      ).get(roomId) as { readonly count: number };
      pendingDeliveries = pending.count;
    } finally {
      database.close();
    }
    stableSamples = pendingDeliveries === 0 && headSeq === previousHead
      ? stableSamples + 1
      : 0;
    if (stableSamples >= 2) return headSeq;
    previousHead = headSeq;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Room authority did not quiesce within ${timeoutMs}ms ` +
      `(head=${previousHead}, pendingDeliveries=${pendingDeliveries})`,
  );
}

async function spawnAuthorityChild(options: ChildStartOptions): Promise<{
  readonly child: ChildProcessWithoutNullStreams;
  readonly url: string;
}> {
  const fixturePath = join(
    process.cwd(),
    "packages/server/dist/fixtures/authority-child.js",
  );
  const child = spawn(process.execPath, [fixturePath], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  childStderr.set(child, "");
  childStdout.set(child, "");
  child.stdout.on("data", (chunk: Buffer) => {
    childStdout.set(child, `${childStdout.get(child) ?? ""}${chunk.toString("utf8")}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    childStderr.set(child, `${childStderr.get(child) ?? ""}${chunk.toString("utf8")}`);
  });
  const ready = waitForJsonLine(child);
  child.stdin.end(`${JSON.stringify(startCommand(options))}\n`);
  let frame: unknown;
  try {
    frame = await ready;
  } catch (error: unknown) {
    await stopChild(child).catch(() => undefined);
    throw new Error(`${String(error)} stderr=${unexpectedChildStderr(child)}`);
  }
  if (typeof frame !== "object" || frame === null ||
      (frame as Record<string, unknown>).type !== "ready" ||
      typeof (frame as Record<string, unknown>).url !== "string") {
    await stopChild(child);
    throw new TypeError("Authority child emitted an invalid ready frame");
  }
  return { child, url: (frame as { readonly url: string }).url };
}

function childExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 2_000,
): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null): void => {
      cleanup();
      resolve(code);
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Authority child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(deadline);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

interface CommandRowCounts {
  readonly messageId: string;
  readonly messages: number;
  readonly events: number;
  readonly idempotency: number;
  readonly outbox: number;
  readonly eventIds: readonly string[];
}

interface AuthorityInspection {
  readonly actors: readonly Actor[];
  readonly commandRows: readonly CommandRowCounts[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommandRowCounts(value: unknown): value is CommandRowCounts {
  return isRecord(value) && typeof value.messageId === "string" &&
    typeof value.messages === "number" && typeof value.events === "number" &&
    typeof value.idempotency === "number" && typeof value.outbox === "number" &&
    Array.isArray(value.eventIds) &&
    value.eventIds.every((eventId) => typeof eventId === "string");
}

async function runAuthorityUtility(options: ChildStartOptions): Promise<unknown> {
  const fixturePath = join(
    process.cwd(),
    "packages/server/dist/fixtures/authority-child.js",
  );
  const child = spawn(process.execPath, [fixturePath], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  childStderr.set(child, "");
  childStdout.set(child, "");
  child.stdout.on("data", (chunk: Buffer) => {
    childStdout.set(child, `${childStdout.get(child) ?? ""}${chunk.toString("utf8")}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    childStderr.set(child, `${childStderr.get(child) ?? ""}${chunk.toString("utf8")}`);
  });
  const framePromise = waitForJsonLine(child);
  child.stdin.end(`${JSON.stringify(startCommand(options))}\n`);
  let frame: unknown;
  try {
    frame = await framePromise;
  } catch (error: unknown) {
    await stopChild(child).catch(() => undefined);
    throw new Error(
      `Authority utility emitted no frame: ${String(error)} stderr=${unexpectedChildStderr(child)}`,
    );
  }
  let exitCode: number | null;
  try {
    exitCode = await childExit(child);
  } catch (error: unknown) {
    await stopChild(child).catch(() => undefined);
    throw new Error(`Authority utility did not exit: ${String(error)}`);
  }
  if (exitCode !== 0 || unexpectedChildStderr(child) !== "") {
    throw new Error(
      `Authority utility failed: code=${exitCode} stderr=${unexpectedChildStderr(child)}`,
    );
  }
  return frame;
}

async function inspectAuthority(
  directory: string,
  messageIds: readonly string[] = [],
): Promise<AuthorityInspection> {
  const frame = await runAuthorityUtility({ directory, inspectMessageIds: messageIds });
  if (!isRecord(frame) || frame.type !== "inspection" || !Array.isArray(frame.actors) ||
      !frame.actors.every(isActor) ||
      !Array.isArray(frame.commandRows) ||
      !frame.commandRows.every(isCommandRowCounts)) {
    throw new TypeError("Authority child emitted an invalid inspection frame");
  }
  return { actors: frame.actors, commandRows: frame.commandRows };
}

async function commandRowCounts(
  directory: string,
  messageId: string,
): Promise<Omit<CommandRowCounts, "messageId">> {
  const inspection = await inspectAuthority(directory, [messageId]);
  const row = inspection.commandRows[0];
  if (row === undefined || row.messageId !== messageId) {
    throw new TypeError("Authority inspection omitted the requested message");
  }
  const { messageId: inspectedMessageId, ...counts } = row;
  if (inspectedMessageId !== messageId) {
    throw new TypeError("Authority inspection returned a different message");
  }
  return counts;
}

interface MixedSeedInspection {
  readonly mixedCounts: Readonly<Record<string, number>>;
  readonly total: number;
  readonly distinctMembershipActors: number;
  readonly watermark: number;
}

async function seedMixedRoomRecords(
  directory: string,
  roomId: string,
): Promise<MixedSeedInspection> {
  const frame = await runAuthorityUtility({ directory, seedMixedRoomId: roomId });
  if (!isRecord(frame) || frame.type !== "mixed-seeded" || !isRecord(frame.mixedCounts) ||
      !Object.values(frame.mixedCounts).every((count) => typeof count === "number") ||
      typeof frame.total !== "number" || typeof frame.distinctMembershipActors !== "number" ||
      typeof frame.watermark !== "number") {
    throw new TypeError("Authority child emitted an invalid mixed-seeded frame");
  }
  return {
    mixedCounts: frame.mixedCounts as Readonly<Record<string, number>>,
    total: frame.total,
    distinctMembershipActors: frame.distinctMembershipActors,
    watermark: frame.watermark,
  };
}

async function compactRoomStream(
  directory: string,
  roomId: string,
  retainedFromSeq: number,
): Promise<void> {
  const frame = await runAuthorityUtility({
    directory,
    compactRoom: { roomId, retainedFromSeq },
  });
  if (!isRecord(frame) || frame.type !== "room-compacted" || Object.keys(frame).length !== 1) {
    throw new TypeError("Authority child emitted an invalid room-compacted frame");
  }
}

class JsonWebSocketClient {
  readonly #socket: WebSocket;
  readonly #frames: ServerFrame[] = [];
  readonly #waiters: Array<{
    readonly predicate: (frame: ServerFrame) => boolean;
    readonly resolve: (frame: ServerFrame) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }> = [];
  readonly #listeners = new Set<(frame: ServerFrame) => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString("utf8")) as ServerFrame;
      for (const listener of this.#listeners) listener(frame);
      const index = this.#waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index < 0) this.#frames.push(frame);
      else {
        const waiter = this.#waiters.splice(index, 1)[0];
        if (waiter !== undefined) {
          clearTimeout(waiter.timeout);
          waiter.resolve(frame);
        }
      }
    });
    socket.on("close", () => {
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("WebSocket closed before the expected frame"));
      }
    });
  }

  static connect(url: string, timeoutMs = 2_000): Promise<JsonWebSocketClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const cleanup = () => {
        clearTimeout(deadline);
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      const onOpen = () => { cleanup(); resolve(new JsonWebSocketClient(socket)); };
      const onError = (error: Error) => { cleanup(); socket.terminate(); reject(error); };
      const deadline = setTimeout(() => {
        cleanup();
        socket.once("error", () => undefined);
        socket.terminate();
        reject(new Error(`WebSocket did not connect within ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
  }

  send(value: unknown): void {
    this.#socket.send(JSON.stringify(value));
  }

  waitFor(predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    const index = this.#frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#frames.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.timeout === timeout);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("Timed out waiting 12 seconds for the expected WebSocket frame"));
      }, 12_000);
      this.#waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  request(value: { readonly requestId: string }, type: ServerFrame["type"]): Promise<ServerFrame> {
    const response = this.waitFor((frame) => "requestId" in frame &&
      frame.requestId === value.requestId && (frame.type === type || frame.type === "error"));
    this.send(value);
    return response.then((frame) => {
      if (frame.type === "error") {
        throw Object.assign(new Error(`${frame.code}: ${frame.message}`), {
          code: frame.code,
          status: frame.status,
        });
      }
      return frame;
    });
  }

  async issueSession(
    requestId = "login",
    identity: Readonly<{ accountId: string; secret: string }> = {
      accountId: "account-a",
      secret: "test-secret",
    },
  ): Promise<{
    readonly accountId: string;
    readonly actorId: string;
    readonly sessionId: string;
    readonly accessToken: string;
    readonly expiresAt: string;
  }> {
    const frame = await this.request({
      type: "auth.login",
      requestId,
      accountId: identity.accountId,
      secret: identity.secret,
      device: {
        id: `authority-e2e-${identity.accountId}`,
        label: `Authority E2E ${identity.accountId}`,
        platform: "unknown",
      },
    }, "auth.authenticated");
    if (frame.type !== "auth.authenticated" || typeof frame.sessionId !== "string" ||
        typeof frame.accessToken !== "string" || typeof frame.expiresAt !== "string") {
      throw new TypeError("wrong login frame");
    }
    return {
      accountId: frame.accountId,
      actorId: frame.actorId,
      sessionId: frame.sessionId,
      accessToken: frame.accessToken,
      expiresAt: frame.expiresAt,
    };
  }

  async login(
    requestId = "login",
    identity: Readonly<{ accountId: string; secret: string }> = {
      accountId: "account-a",
      secret: "test-secret",
    },
  ): Promise<string> {
    return (await this.issueSession(requestId, identity)).accessToken;
  }

  async resume(accessToken: string, requestId = "resume"): Promise<void> {
    const frame = await this.request({
      type: "auth.resume",
      requestId,
      accessToken,
    }, "auth.authenticated");
    if (frame.type !== "auth.authenticated") throw new TypeError("wrong resume frame");
  }

  close(): void {
    this.#socket.close();
  }

  terminate(): void {
    this.#socket.terminate();
  }

  listen(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  frames(): readonly ServerFrame[] {
    return this.#frames;
  }
}

async function loginAuthorityDevice(
  client: JsonWebSocketClient,
  input: {
    readonly requestId: string;
    readonly accountId: string;
    readonly secret: string;
    readonly deviceId: string;
  },
): Promise<IdentityAuthoritySession> {
  const frame = await client.request({
    type: "auth.login",
    requestId: input.requestId,
    accountId: input.accountId,
    secret: input.secret,
    device: {
      id: input.deviceId,
      label: `Authority E2E ${input.deviceId}`,
      platform: "unknown",
    },
  }, "auth.authenticated");
  if (frame.type !== "auth.authenticated") throw new TypeError("wrong device login frame");
  return {
    actorId: frame.actorId,
    sessionId: frame.sessionId,
    accessToken: frame.accessToken,
    expiresAt: frame.expiresAt,
  };
}

function recordKey(record: RoomRepairRecord): string {
  switch (record.kind) {
    case "room": return "room";
    case "governance": return "governance";
    case "membership": return `membership\0${record.value.actorId}`;
    case "message": return `message\0${record.value.id}`;
    case "timeline-message": return `timeline-message\0${record.value.id}`;
    case "message-revision": {
      return `message-revision\0${record.value.messageId}\0${record.value.revision}`;
    }
    case "attachment": return `attachment\0${record.value.attachment.attachmentId}`;
    case "human-read": return `human-read\0${record.value.id}`;
    case "agent-judgement": return `agent-judgement\0${record.value.id}`;
    case "open-item": return `open-item\0${record.value.id}`;
    case "open-item-agent-failure": return `open-item-agent-failure\0${record.value.id}`;
    case "light-task": return `light-task\0${record.value.id}`;
    case "agent-execution": return `agent-execution\0${record.value.id}`;
    case "route-job": return `route-job\0${record.value.id}`;
    case "route-judgment": return `route-judgment\0${record.value.id}`;
    case "calibration": return `calibration\0${record.value.id}`;
    case "legacy-unknown-calibration": return `legacy-calibration\0${record.value.id}`;
  }
}

function canonicalJsonForAuthorityTest(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForAuthorityTest).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJsonForAuthorityTest(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Authority cache contained a non-canonical value");
}

function authoritySnapshotChecksum(kind: "catalog" | "room", values: readonly unknown[]): string {
  return createHash("sha256")
    .update(canonicalJsonForAuthorityTest({ kind, values, version: 1 }), "utf8")
    .digest("hex");
}

class MemoryAuthorityCache implements ClientAuthorityCache {
  readonly #cursors = new Map<string, RoomCursor>();
  readonly #roomCounts = new Map<string, number>();
  readonly #roomStaging = new Map<string, {
    readonly roomId: string;
    readonly records: Map<string, RoomRepairRecord>;
  }>();
  readonly #catalogStaging = new Map<string, WorkspaceBootstrapPage["rooms"]>();
  #catalogRooms: WorkspaceBootstrapPage["rooms"] = [];
  readonly eventIds = new Set<string>();
  readonly appliedEventIds: string[] = [];
  readonly appliedEvents: PersistedRoomEvent[] = [];
  readonly #roomChecksums = new Map<string, string>();
  readonly #roomRecords = new Map<string, Map<string, RoomRepairRecord>>();
  commits = 0;

  roomCursor(roomId: string): RoomCursor | undefined {
    return this.#cursors.get(roomId);
  }
  beginCatalog(snapshotId: string): void {
    this.#catalogStaging.set(snapshotId, []);
  }
  stageCatalogPage(page: WorkspaceBootstrapPage): void {
    this.#catalogStaging.set(page.snapshotId, [
      ...(this.#catalogStaging.get(page.snapshotId) ?? []),
      ...page.rooms,
    ]);
  }
  async finalizeCatalog(snapshotId: string, expectedChecksum: string): Promise<boolean> {
    const rooms = this.#catalogStaging.get(snapshotId);
    return rooms !== undefined && authoritySnapshotChecksum("catalog", rooms) === expectedChecksum &&
      new Set(rooms.map((room) => room.roomId)).size === rooms.length;
  }
  commitCatalog(version: number, checksum: string): void {
    if (!Number.isSafeInteger(version) || checksum.length === 0) {
      throw new Error("Catalog commit metadata is invalid");
    }
    const staged = this.#catalogStaging.values().next().value;
    if (staged !== undefined) this.#catalogRooms = [...staged];
    this.#catalogStaging.clear();
    this.commits += 1;
  }
  *catalogRoomIds(): Iterable<string> {
    for (const room of this.#catalogRooms) yield room.roomId;
  }
  catalogValues(): WorkspaceBootstrapPage["rooms"] {
    return structuredClone(this.#catalogRooms);
  }
  beginRoom(roomId: string, snapshotId: string): void {
    this.#roomStaging.set(snapshotId, { roomId, records: new Map() });
  }
  stageRoomPage(page: RoomRepairPage): void {
    const staged = this.#roomStaging.get(page.snapshotId);
    if (staged === undefined) throw new Error("Room staging is missing");
    for (const record of page.records) {
      staged.records.set(recordKey(record), structuredClone(record));
    }
  }
  async finalizeRoom(snapshotId: string, expectedChecksum: string): Promise<boolean> {
    const staged = this.#roomStaging.get(snapshotId);
    return staged !== undefined &&
      authoritySnapshotChecksum("room", [...staged.records.values()]) === expectedChecksum;
  }
  commitRoom(roomId: string, watermark: number, checksum: string): void {
    if (checksum.length === 0) throw new Error("Room commit checksum is invalid");
    const staged = [...this.#roomStaging.entries()].find(([, value]) => value.roomId === roomId);
    if (staged === undefined) throw new Error("Room staging is missing");
    this.#roomCounts.set(roomId, staged[1].records.size);
    this.#roomChecksums.set(roomId, checksum);
    this.#roomRecords.set(roomId, new Map(staged[1].records));
    this.#roomStaging.delete(staged[0]);
    this.#cursors.set(roomId, { version: 1, roomId, afterSeq: watermark });
    this.commits += 1;
  }
  applyRoomEvents(roomId: string, events: readonly PersistedRoomEvent[], cursor: RoomCursor): void {
    for (const event of events) {
      this.eventIds.add(event.eventId);
      this.appliedEventIds.push(event.eventId);
      this.appliedEvents.push(event);
    }
    this.#cursors.set(roomId, cursor);
  }
  discardSnapshot(snapshotId: string): void {
    this.#roomStaging.delete(snapshotId);
    this.#catalogStaging.delete(snapshotId);
  }
  clear(): void {
    this.#cursors.clear();
    this.#roomCounts.clear();
    this.#roomStaging.clear();
    this.#catalogStaging.clear();
    this.#catalogRooms = [];
    this.#roomChecksums.clear();
    this.#roomRecords.clear();
    this.eventIds.clear();
  }
  factCount(roomId: string): number {
    return this.#roomCounts.get(roomId) ?? 0;
  }
  roomChecksum(roomId: string): string | undefined {
    return this.#roomChecksums.get(roomId);
  }
  roomSignature(roomId: string): string {
    return `${this.factCount(roomId)}:${this.roomChecksum(roomId) ?? "none"}:${this.roomCursor(roomId)?.afterSeq ?? -1}`;
  }
  roomValues(roomId: string): readonly RoomRepairRecord[] {
    return [...(this.#roomRecords.get(roomId)?.values() ?? [])].map((record) =>
      structuredClone(record));
  }
  independentRoomChecksum(roomId: string): string | undefined {
    const values = this.#roomRecords.get(roomId);
    return values === undefined ? undefined : authoritySnapshotChecksum("room", [...values.values()]);
  }
}

class WebSocketSyncTransport implements SyncTransport {
  #client: JsonWebSocketClient;
  #subscriptionObserver: RoomSubscriptionObserver | undefined;
  readonly #materializedRecordsBySnapshot = new Map<string, number>();
  readonly roomRepairModes: Array<RoomRepairPage["mode"]> = [];
  roomRepairRequests = 0;
  beforeStreamingSnapshotComplete: (() => void) | undefined;
  beforeMaterializedLastPageReturn:
    | ((page: RoomRepairPage, receivedRecordCount: number) => Promise<void>)
    | undefined;

  constructor(client: JsonWebSocketClient) {
    this.#client = client;
  }

  replaceClient(client: JsonWebSocketClient): void {
    this.#client = client;
  }

  resume(cursor: RoomCursor): Promise<void> {
    if (this.#subscriptionObserver === undefined) {
      throw new Error("Room subscription observer is missing");
    }
    return this.#subscriptionObserver.retry(cursor);
  }

  async bootstrapBegin(requestId: string): Promise<WorkspaceBootstrapPage> {
    return await this.#client.request({
      type: "workspace.bootstrap.begin", requestId,
    }, "workspace.bootstrap.page") as WorkspaceBootstrapPage;
  }
  async bootstrapPage(requestId: string, snapshotId: string, afterPage: number): Promise<WorkspaceBootstrapPage> {
    return await this.#client.request({
      type: "workspace.bootstrap.page", requestId, snapshotId, afterPage,
    }, "workspace.bootstrap.page") as WorkspaceBootstrapPage;
  }
  async syncRoom(request: RoomSyncRequest): Promise<RoomSyncResult> {
    return await this.#client.request(request, "room.sync.result") as RoomSyncResult;
  }
  async repairRoomBegin(requestId: string, roomId: string): Promise<RoomRepairPage> {
    this.roomRepairRequests += 1;
    const page = await this.#client.request({
      type: "room.repair.begin", requestId, roomId,
    }, "room.repair.page") as RoomRepairPage;
    this.roomRepairModes.push(page.mode);
    await this.pauseBeforeMaterializedLastPageReturn(page);
    return page;
  }
  async repairRoomPage(requestId: string, snapshotId: string, afterPage: number): Promise<RoomRepairPage> {
    this.roomRepairRequests += 1;
    const page = await this.#client.request({
      type: "room.repair.page", requestId, snapshotId, afterPage,
    }, "room.repair.page") as RoomRepairPage;
    await this.pauseBeforeMaterializedLastPageReturn(page);
    return page;
  }
  private async pauseBeforeMaterializedLastPageReturn(page: RoomRepairPage): Promise<void> {
    if (page.mode !== "materialized") return;
    const receivedRecordCount =
      (this.#materializedRecordsBySnapshot.get(page.snapshotId) ?? 0) + page.records.length;
    this.#materializedRecordsBySnapshot.set(page.snapshotId, receivedRecordCount);
    if (!page.hasMore) {
      await this.beforeMaterializedLastPageReturn?.(page, receivedRecordCount);
      this.#materializedRecordsBySnapshot.delete(page.snapshotId);
    }
  }
  async completeSnapshot(
    requestId: string,
    snapshotId: string,
    version: SnapshotVersion,
    snapshotChecksum: string,
  ): Promise<SnapshotCompleted> {
    this.beforeStreamingSnapshotComplete?.();
    return await this.#client.request({
      type: "snapshot.complete", requestId, snapshotId, version, snapshotChecksum,
    }, "snapshot.completed") as SnapshotCompleted;
  }
  async subscribeRoom(
    roomId: string,
    cursor: RoomCursor,
    observer: RoomSubscriptionObserver,
  ) {
    this.#subscriptionObserver = observer;
    let delivery = Promise.resolve();
    const requestId = `subscribe-${roomId}-${cursor.afterSeq}`;
    const unlisten = this.#client.listen((frame) => {
      if (frame.type === "room.event" && frame.event.roomId === roomId) {
        delivery = delivery.then(() => observer.events([frame.event], {
          version: 1,
          roomId,
          afterSeq: frame.event.streamSeq,
        }));
      } else if (frame.type === "room.sync.result" &&
          frame.requestId === requestId && frame.mode === "delta") {
        delivery = delivery.then(() => observer.events(frame.events, frame.nextCursor));
      } else if (frame.type === "room.subscribe.v2.retry" && frame.requestId === requestId) {
        delivery = delivery.then(() => observer.retry(frame.restartFrom));
      }
    });
    const subscribed = await this.#client.request({
      type: "room.subscribe.v2", requestId, roomId, cursor,
    }, "room.subscribed.v2");
    await delivery;
    if (subscribed.type !== "room.subscribed.v2") throw new TypeError("wrong subscribe frame");
    return {
      cursor: subscribed.cursor,
      close() {
        unlisten();
      },
    };
  }
}

async function discoverRoom(client: JsonWebSocketClient): Promise<string> {
  const first = await client.request({
    type: "workspace.bootstrap.begin",
    requestId: "bootstrap-begin",
  }, "workspace.bootstrap.page");
  if (first.type !== "workspace.bootstrap.page") throw new TypeError("wrong bootstrap frame");
  const rooms = [...first.rooms];
  let page = first;
  while (page.hasMore) {
    const next = await client.request({
      type: "workspace.bootstrap.page",
      requestId: `bootstrap-page-${page.page}`,
      snapshotId: page.snapshotId,
      afterPage: page.page,
    }, "workspace.bootstrap.page");
    if (next.type !== "workspace.bootstrap.page") throw new TypeError("wrong bootstrap page");
    rooms.push(...next.rooms);
    page = next;
  }
  expect(rooms).toHaveLength(1);
  return rooms[0]!.roomId;
}

async function repairRecords(client: JsonWebSocketClient, roomId: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const first = await client.request({
        type: "room.repair.begin",
        requestId: `repair-begin-${attempt}`,
        roomId,
      }, "room.repair.page");
      if (!isRoomRepairPage(first)) throw new TypeError("wrong repair frame");
      const records = [...first.records];
      let page = first;
      while (page.hasMore) {
        const next = await client.request({
          type: "room.repair.page",
          requestId: `repair-page-${attempt}-${page.page}`,
          snapshotId: page.snapshotId,
          afterPage: page.page,
        }, "room.repair.page");
        if (!isRoomRepairPage(next)) throw new TypeError("wrong repair page");
        records.push(...next.records);
        page = next;
      }
      return {
        records,
        watermark: first.watermark,
        checksum: first.snapshotChecksum,
        mode: first.mode,
      };
    } catch (error: unknown) {
      if (!isRecord(error) ||
          (error.code !== "snapshot_stale" && error.code !== "storage_unavailable") ||
          attempt === 2) throw error;
    }
  }
  throw new Error("Room repair retry bound was exhausted");
}

function authoritySentinelHits(databasePath: string, sentinel: string): readonly string[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const hits: string[] = [];
    const tables = database.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all() as Array<{ readonly name: string }>;
    for (const { name } of tables) {
      const quotedTable = `"${name.replaceAll('"', '""')}"`;
      const columns = database.prepare(`PRAGMA table_info(${quotedTable})`).all() as
        Array<{ readonly name: string }>;
      for (const column of columns) {
        const quotedColumn = `"${column.name.replaceAll('"', '""')}"`;
        const row = database.prepare(
          `SELECT COUNT(*) AS count FROM ${quotedTable}
           WHERE instr(CAST(${quotedColumn} AS TEXT), ?) > 0`,
        ).get(sentinel) as { readonly count: number };
        if (row.count > 0) hits.push(`${name}.${column.name}:${row.count}`);
      }
    }
    return hits;
  } finally {
    database.close();
  }
}

async function seedDirectory(directory: string): Promise<string> {
  const started = await spawnAuthorityChild({ directory, seedAllFacts: true });
  const client = await JsonWebSocketClient.connect(started.url);
  try {
    await client.login("seed-login");
    const roomId = await discoverRoom(client);
    await waitForRoomAuthorityQuiescence(directory, roomId);
    return roomId;
  } finally {
    client.close();
    await stopChild(started.child);
  }
}

function sendMessage(
  client: JsonWebSocketClient,
  roomId: string,
  messageId: string,
  requestId = `request-${messageId}`,
): void {
  client.send({
    type: "message.send",
    requestId,
    message: {
      id: messageId,
      roomId,
      body: `durable ${messageId}`,
      sentAt: "2026-08-12T10:00:00.000Z",
    },
  });
}

const attachmentRawSentinel = "FT04_E2E_RAW_PDF_SENTINEL";
const attachmentExtractionSentinel = "FT04_E2E_EXTRACTED_TEXT";
const attachmentScannerRawSentinel = "FT04_E2E_SCANNER_RAW_SIGNATURE";
const attachmentScannerPathSentinel = "/private/ft04-e2e/clamd.sock";
const attachmentScannerTokenSentinel = "FT04_E2E_BEARER_TOKEN";
const attachmentForbiddenSentinels = Object.freeze([
  attachmentRawSentinel,
  attachmentExtractionSentinel,
  attachmentScannerRawSentinel,
  attachmentScannerPathSentinel,
  attachmentScannerTokenSentinel,
]);

function attachmentE2ePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    `<< /Padding (${attachmentRawSentinel}${"a".repeat(40_000)}) >>`,
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

describe("authoritative server real-process harness", () => {
  it("bounds silent child cleanup and escalates an ignored SIGTERM to SIGKILL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-silent-child-"));
    const fixturePath = join(process.cwd(), "packages/server/dist/fixtures/authority-child.js");
    const child = spawn(process.execPath, [fixturePath], {
      cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
    });
    const silentReady = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        cleanup();
        reject(new Error("silent child did not initialize within 2 seconds"));
      }, 2_000);
      const onData = (chunk: Buffer): void => {
        if (!chunk.toString("utf8").includes("authority-child-silent-ready")) return;
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        clearTimeout(deadline);
        child.stderr.off("data", onData);
      };
      child.stderr.on("data", onData);
    });
    child.stdin.end(`${JSON.stringify({
      ...startCommand({ directory }),
      suppressJsonForTest: true,
      ignoreSigtermForTest: true,
    })}\n`);
    try {
      await silentReady;
      await expect(waitForJsonLine(child, 20)).rejects.toThrow("within 20ms");
      await expect(stopChild(child, 20, 200)).resolves.toBeUndefined();
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds and terminates a stalled WebSocket connection attempt", async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError("missing TCP port");
    try {
      const outcome = await Promise.race([
        JsonWebSocketClient.connect(`ws://127.0.0.1:${address.port}`, 20)
          .then(() => "connected", (error: unknown) => String(error)),
        new Promise<string>((resolve) => setTimeout(() => resolve("outer-timeout"), 100)),
      ]);
      expect(outcome).toContain("within 20ms");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("exports the authoritative composition root", async () => {
    const module = await import("./authoritative-server.js");
    const packageRoot = await import("./index.js");

    expect(module.startAuthoritativeServer).toBeTypeOf("function");
    expect(packageRoot.AUTHORITATIVE_SERVER_DEFAULT_HOST).toBe("127.0.0.1");
    expect(packageRoot.AUTHORITATIVE_SERVER_DEFAULT_PORT).toBe(8_787);
    // Prevent server issuance/list bounds from exceeding the Desktop frame parser.
    expect(IDENTITY_CONTRACT_LIMITS.sessions).toBe(MAX_ACTIVE_SESSION_FAMILIES);
    expect(packageRoot).not.toHaveProperty("startAuthoritativeServerForTest");
    expect(packageRoot).not.toHaveProperty(
      "createWorkerDatabaseClientWithTransactionFaultForTest",
    );
    await expect(readFile(join(process.cwd(), "packages/server/dist/index.d.ts"), "utf8"))
      .resolves.not.toContain("startAuthoritativeServerForTest");
    await expect(readFile(join(process.cwd(), "packages/server/dist/index.d.ts"), "utf8"))
      .resolves.not.toContain("createWorkerDatabaseClientWithTransactionFaultForTest");
  });

  it("routes message.send.v2 through the production AuthorityWorker and stable Room stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-ft03-message-composition-"));
    let started: Awaited<ReturnType<typeof spawnAuthorityChild>> | undefined;
    let client: JsonWebSocketClient | undefined;
    try {
      started = await spawnAuthorityChild({ directory, seedAllFacts: true });
      client = await JsonWebSocketClient.connect(started.url);
      await client.login("message-v2-production-login");
      const roomId = await discoverRoom(client);
      const head = readRoomHeadSeq(directory, roomId);
      await client.request({
        type: "room.subscribe.v2",
        requestId: "message-v2-production-subscribe",
        roomId,
        cursor: { version: 1, roomId, afterSeq: head },
      }, "room.subscribed.v2");

      const messageId = "message-v2-production";
      await expect(client.request({
        type: "message.send.v2",
        requestId: "message-v2-production-send",
        message: {
          messageId,
          roomId,
          body: "production Message Authority",
          mentionedTargets: [],
          attachments: [],
        },
      }, "message.accepted")).resolves.toMatchObject({
        type: "message.accepted",
        requestId: "message-v2-production-send",
        messageId,
        targetOutcomes: [],
      });
      await expect(client.waitFor((frame) => frame.type === "room.event" &&
        frame.event.roomId === roomId &&
        frame.event.type === "room.message.accepted" &&
        frame.event.payload.id === messageId)).resolves.toMatchObject({
        type: "room.event",
        event: {
          roomId,
          type: "room.message.accepted",
          payload: {
            id: messageId,
            roomId,
            authorId: "human-a",
            authorKind: "human",
            lifecycle: "active",
            currentRevision: {
              messageId,
              revision: 1,
              body: "production Message Authority",
              revisedByActorId: "human-a",
            },
          },
        },
      });
      const history = await client.request({
        type: "room.history.v2",
        requestId: "message-v2-production-history",
        roomId,
      }, "room.history.v2");
      if (history.type !== "room.history.v2") throw new TypeError("wrong message history frame");
      expect(history.roomId).toBe(roomId);
      expect(history.lifecycle).toBe("active");
      expect(history.actors).toEqual(expect.arrayContaining([
        expect.objectContaining({ actorId: "human-a", kind: "human", displayName: "Human A" }),
        expect.objectContaining({ actorId: "agent-a", kind: "agent", displayName: "Agent A" }),
      ]));
      expect(history.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: messageId, authorId: "human-a" }),
      ]));
    } finally {
      client?.close();
      if (started !== undefined) await stopChild(started.child);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("converges a processed attachment through three authenticated clients, stable sync, and repair", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-ft04-e2e-"));
    const clients: JsonWebSocketClient[] = [];
    let started: Awaited<ReturnType<typeof spawnAuthorityChild>> | undefined;
    let desktopRuntime: ReturnType<typeof createDesktopAttachmentAuthorityRuntime> | undefined;
    let composer: ReturnType<typeof mountAttachmentComposerBridge> | undefined;
    let rendererRoot: HTMLElement | undefined;
    const authorityFrames: ServerFrame[] = [];
    const childTranscripts: Array<Readonly<{ stdout: string; stderr: string }>> = [];
    try {
      const bytes = attachmentE2ePdf();
      const selectedPath = join(directory, "e2e-evidence.pdf");
      await writeFile(selectedPath, bytes, { mode: 0o600 });
      started = await spawnAuthorityChild({
        directory,
        seedAllFacts: true,
        enableAttachmentFixture: true,
      });
      const connected = await Promise.all([
        JsonWebSocketClient.connect(started.url),
        JsonWebSocketClient.connect(started.url),
        JsonWebSocketClient.connect(started.url),
      ]);
      clients.push(...connected);
      for (const client of connected) client.listen((frame) => authorityFrames.push(frame));
      const sessions = await Promise.all(connected.map((client, index) => loginAuthorityDevice(client, {
        requestId: `attachment-e2e-login-${index}`,
        accountId: "account-a",
        secret: "test-secret",
        deviceId: `attachment-e2e-device-${index}`,
      })));
      const roomId = await discoverRoom(connected[0]!);
      const head = readRoomHeadSeq(directory, roomId);
      await Promise.all(connected.map((client, index) => client.request({
        type: "room.subscribe.v2",
        requestId: `attachment-e2e-subscribe-${index}`,
        roomId,
        cursor: { version: 1, roomId, afterSeq: head },
      }, "room.subscribed.v2")));

      const privateReady = connected.map((client) => client.waitFor((frame) =>
        frame.type === "attachment.private.status-changed" &&
        frame.payload.attachment.originalFilename === "e2e-evidence.pdf" &&
        frame.payload.attachment.processingStatus === "ready"));

      const ipc = createAttachmentIpcHarness();
      desktopRuntime = createDesktopAttachmentAuthorityRuntime({
        endpoint: started.url,
        session: () => sessions[0],
        webSocketFactory: (endpoint) => new NodeIdentityWebSocketAdapter(endpoint),
        openFileDialog: {
          async showOpenFile() {
            return Object.freeze({ canceled: false, filePaths: Object.freeze([selectedPath]) });
          },
        },
        saveDialog: { chooseDestination: async () => undefined },
        previewHost: { openSandboxed: async () => undefined, closeAll: () => undefined },
        ipcMain: ipc.ipcMain,
        webContents: ipc.webContents,
        timeoutMs: 5_000,
      });
      expect(ipc.registeredHandlers()).toBe(8);
      const bridge = createAttachmentAuthorityBridge(ipc.ipcRenderer);
      const bridgeInputs: unknown[] = [];
      const stopBridgeTrace = bridge.onAuthorityInput((input) => bridgeInputs.push(input));
      const readyIds: string[][] = [];
      let bindRequest: Promise<ServerFrame> | undefined;
      rendererRoot = document.createElement("section");
      document.body.append(rendererRoot);
      composer = mountAttachmentComposerBridge(rendererRoot, bridge, roomId, {
        accessProjection: () => "authorized",
        onReadyAttachmentIdsChange: (attachmentIds) => readyIds.push([...attachmentIds]),
        onBindRequested() {
          const attachmentId = readyIds.at(-1)?.[0];
          if (attachmentId === undefined || bindRequest !== undefined) return;
          bindRequest = connected[0]!.request({
            type: "message.send.v2",
            requestId: "attachment-e2e-bind",
            message: {
              messageId: "message-ft04-e2e",
              roomId,
              body: "Attachment E2E source message",
              mentionedTargets: [],
              attachments: [{ attachmentId }],
            },
          }, "message.accepted");
        },
      });

      await composer.select();
      expect(rendererRoot.dataset.attachmentState).toBe("local-selected");
      expect(rendererRoot.textContent).toContain("e2e-evidence.pdf");
      rendererRoot.querySelector<HTMLButtonElement>("[data-action='upload']")?.click();

      const readyPrivateEvents = await Promise.all(privateReady);
      await vi.waitFor(() => {
        expect(rendererRoot?.dataset.attachmentState).toBe("ready");
        expect(readyIds.at(-1)).toHaveLength(1);
      }, { timeout: 10_000 });
      const attachmentId = readyIds.at(-1)![0]!;
      expect(readyPrivateEvents.every((frame) =>
        frame.type === "attachment.private.status-changed" &&
        frame.payload.attachment.attachmentId === attachmentId &&
        frame.payload.attachment.sourceMessageId === null)).toBe(true);
      const progress = bridgeInputs.filter((input): input is {
        readonly type: "attachment.upload.progress";
        readonly acknowledgedBytes: number;
        readonly totalBytes: number;
      } => isRecord(input) && input.type === "attachment.upload.progress" &&
        typeof input.acknowledgedBytes === "number" && typeof input.totalBytes === "number");
      expect(progress.map((input) => input.acknowledgedBytes)).toEqual([
        32_768,
        bytes.byteLength,
      ]);
      expect(progress.every((input) => input.totalBytes === bytes.byteLength)).toBe(true);
      expect(rendererRoot.querySelector("[data-authority-source='stable-event']")).not.toBeNull();

      const liveBound = connected.map((client) => client.waitFor((frame) =>
        frame.type === "room.event" &&
        frame.event.type === "room.attachment.bound" &&
        frame.event.payload.attachment.attachmentId === attachmentId));
      const liveMessage = connected.map((client) => client.waitFor((frame) =>
        frame.type === "room.event" &&
        frame.event.type === "room.message.accepted" &&
        frame.event.payload.id === "message-ft04-e2e"));
      rendererRoot.querySelector<HTMLButtonElement>("[data-action='bind']")?.click();
      expect(bindRequest).toBeDefined();
      await expect(bindRequest).resolves.toMatchObject({
        type: "message.accepted",
        requestId: "attachment-e2e-bind",
        messageId: "message-ft04-e2e",
      });
      const [boundEvents, messageEvents] = await Promise.all([
        Promise.all(liveBound),
        Promise.all(liveMessage),
      ]);
      expect(new Set(boundEvents.map((frame) =>
        frame.type === "room.event" ? frame.event.eventId : undefined)).size).toBe(1);
      for (const frame of messageEvents) {
        if (frame.type !== "room.event" || frame.event.type !== "room.message.accepted") {
          throw new TypeError("Attachment E2E did not receive the message event");
        }
        expect(frame.event.payload.attachments).toEqual([
          expect.objectContaining({ attachmentId }),
        ]);
      }

      const database = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
      try {
        expect(database.prepare(`
          SELECT attachment.processing_status AS processingStatus,
                 attachment.source_message_id AS sourceMessageId,
                 attachment.source_operational_state AS sourceState,
                 link.operational_state AS linkState,
                 envelope.lifecycle AS messageLifecycle
          FROM attachments AS attachment
          INNER JOIN message_attachment_links AS link
            ON link.attachment_id = attachment.attachment_id
          INNER JOIN message_envelopes AS envelope
            ON envelope.message_id = link.message_id
          WHERE attachment.attachment_id = ?
        `).get(attachmentId)).toEqual({
          processingStatus: "ready",
          sourceMessageId: "message-ft04-e2e",
          sourceState: "bound-active",
          linkState: "active",
          messageLifecycle: "active",
        });
        expect(database.prepare(`
          SELECT adapter_kind AS adapterKind, adapter_name AS adapterName, status
          FROM attachment_processing_attempts
          WHERE attachment_id = ? ORDER BY attempt_number
        `).all(attachmentId)).toEqual([
          { adapterKind: "scanner", adapterName: "clamav", status: "succeeded" },
          { adapterKind: "extractor", adapterName: "pdftotext", status: "succeeded" },
        ]);
        expect(database.prepare(`
          SELECT method, tool_name AS toolName, byte_size AS byteSize
          FROM attachment_extraction_artifacts WHERE attachment_id = ?
        `).get(attachmentId)).toEqual({
          method: "extracted-text",
          toolName: "pdftotext",
          byteSize: Buffer.byteLength(`${attachmentExtractionSentinel}\n`, "utf8"),
        });
        expect(database.prepare(`
          SELECT event_type AS eventType FROM events
          WHERE stream_kind = 'room' AND stream_id = ?
            AND event_type IN ('room.message.accepted', 'room.attachment.bound')
          ORDER BY stream_seq DESC LIMIT 2
        `).all(roomId).map((row) => row.eventType).sort()).toEqual([
          "room.attachment.bound",
          "room.message.accepted",
        ]);
      } finally {
        database.close();
      }
      for (const sentinel of attachmentForbiddenSentinels) {
        expect(authoritySentinelHits(join(directory, "authority.sqlite"), sentinel)).toEqual([]);
      }
      await vi.waitFor(async () => {
        const entries = await readRegularFileEntries(join(directory, "attachment-store"));
        const rawHits = byteSentinelHits(entries, [attachmentRawSentinel]);
        expect(rawHits.length).toBeGreaterThan(0);
        expect(rawHits.some((hit) => hit.includes("/attachment-store/objects/"))).toBe(true);
      }, { timeout: 5_000 });
      const storedEntries = await readRegularFileEntries(join(directory, "attachment-store"));
      const rawObjectHits = byteSentinelHits(storedEntries, [attachmentRawSentinel]);
      const extractionObjectHits = byteSentinelHits(
        storedEntries,
        [attachmentExtractionSentinel],
      );
      expect(rawObjectHits.length).toBeGreaterThan(0);
      expect(rawObjectHits.every((hit) => hit.includes("/attachment-store/"))).toBe(true);
      expect(rawObjectHits.some((hit) => hit.includes("/attachment-store/objects/"))).toBe(true);
      expect(extractionObjectHits).toHaveLength(1);
      expect(extractionObjectHits[0]).toContain("/attachment-store/extractions/");
      expect(byteSentinelHits(storedEntries, [
        attachmentScannerRawSentinel,
        attachmentScannerPathSentinel,
        attachmentScannerTokenSentinel,
      ])).toEqual([]);
      const activeAuthorityCheckpoint = await readAuthorityCheckpointFiles(directory);
      expect(activeAuthorityCheckpoint.map(({ path }) => path)).toEqual(expect.arrayContaining([
        join(directory, "authority.sqlite"),
        join(directory, "authority.sqlite-wal"),
        join(directory, "authority.sqlite-shm"),
      ]));
      expect(byteSentinelHits(activeAuthorityCheckpoint, attachmentForbiddenSentinels)).toEqual([]);
      await unlink(selectedPath);

      composer.dispose();
      composer = undefined;
      stopBridgeTrace();
      desktopRuntime.close();
      desktopRuntime = undefined;
      expect(ipc.registeredHandlers()).toBe(0);
      rendererRoot.remove();
      rendererRoot = undefined;
      for (const client of clients) client.close();
      clients.length = 0;
      const firstChild = started.child;
      await stopChild(firstChild);
      childTranscripts.push(Object.freeze({
        stdout: childStdout.get(firstChild) ?? "",
        stderr: childStderr.get(firstChild) ?? "",
      }));
      started = undefined;

      started = await spawnAuthorityChild({ directory, enableAttachmentFixture: true });
      const restarted = await Promise.all([
        JsonWebSocketClient.connect(started.url),
        JsonWebSocketClient.connect(started.url),
        JsonWebSocketClient.connect(started.url),
      ]);
      clients.push(...restarted);
      for (const client of restarted) client.listen((frame) => authorityFrames.push(frame));
      await Promise.all(restarted.map((client, index) => loginAuthorityDevice(client, {
        requestId: `attachment-e2e-restart-login-${index}`,
        accountId: "account-a",
        secret: "test-secret",
        deviceId: `attachment-e2e-restart-device-${index}`,
      })));
      const syncResults = await Promise.all(restarted.map((client, index) => client.request({
        type: "room.sync",
        requestId: `attachment-e2e-sync-${index}`,
        roomId,
        cursor: { version: 1, roomId, afterSeq: head },
      }, "room.sync.result")));
      for (const result of syncResults) {
        if (result.type !== "room.sync.result" || result.mode !== "delta") {
          throw new TypeError("Attachment E2E sync did not return a retained delta");
        }
        expect(result.events).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "room.message.accepted" }),
          expect.objectContaining({ type: "room.attachment.bound" }),
        ]));
      }
      const histories = await Promise.all(restarted.map((client, index) => client.request({
        type: "room.history.v2",
        requestId: `attachment-e2e-history-${index}`,
        roomId,
      }, "room.history.v2")));
      for (const history of histories) {
        if (history.type !== "room.history.v2") {
          throw new TypeError("Attachment E2E history returned the wrong frame");
        }
        expect(history.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: "message-ft04-e2e",
            attachments: [expect.objectContaining({ attachmentId })],
          }),
        ]));
      }
      await waitForRoomAuthorityQuiescence(directory, roomId);
      const repairs = await Promise.all(restarted.map((client) => repairRecords(client, roomId)));
      expect(repairs.map((repair) => repair.mode)).toEqual([
        "materialized",
        "materialized",
        "materialized",
      ]);
      const attachmentRepairs = repairs.map(({ records }) => records.find((record) =>
        record.kind === "attachment" && record.value.attachment.attachmentId === attachmentId));
      expect(attachmentRepairs.every((record) => record !== undefined)).toBe(true);
      expect(attachmentRepairs[1]).toEqual(attachmentRepairs[0]);
      expect(attachmentRepairs[2]).toEqual(attachmentRepairs[0]);
      expect(attachmentRepairs[0]).toMatchObject({
        kind: "attachment",
        value: {
          sourceEligibility: "bound-active",
          attachment: {
            attachmentId,
            sourceMessageId: "message-ft04-e2e",
            processingStatus: "ready",
            provenance: {
              scanner: { kind: "clamav", version: "1.5.3" },
              extraction: { method: "pdf-text", tool: "pdftotext", version: "26.07.0" },
            },
          },
        },
      });
      expect(new Set(repairs.map((repair) => repair.checksum)).size).toBe(1);
      expect(new Set(repairs.map((repair) => repair.watermark)).size).toBe(1);
      const activeMaterializedCheckpoint = await readAuthorityCheckpointFiles(directory);
      expect(activeMaterializedCheckpoint.map(({ path }) => path)).toEqual(expect.arrayContaining([
        join(directory, "snapshot-cache.sqlite"),
      ]));
      expect(byteSentinelHits(
        activeMaterializedCheckpoint,
        attachmentForbiddenSentinels,
      )).toEqual([]);
      for (const client of clients) client.close();
      clients.length = 0;
      const materializedChild = started.child;
      await stopChild(materializedChild);
      childTranscripts.push(Object.freeze({
        stdout: childStdout.get(materializedChild) ?? "",
        stderr: childStderr.get(materializedChild) ?? "",
      }));
      started = undefined;

      const materializedCheckpoint = await readAuthorityCheckpointFiles(directory);
      expect(materializedCheckpoint.map(({ path }) => path)).toEqual(expect.arrayContaining([
        join(directory, "authority.sqlite"),
        join(directory, "snapshot-cache.sqlite"),
      ]));
      expect(byteSentinelHits(materializedCheckpoint, attachmentForbiddenSentinels)).toEqual([]);
      for (const sentinel of attachmentForbiddenSentinels) {
        expect(authoritySentinelHits(join(directory, "authority.sqlite"), sentinel)).toEqual([]);
        expect(authoritySentinelHits(join(directory, "snapshot-cache.sqlite"), sentinel)).toEqual([]);
      }

      await Promise.all([
        "snapshot-cache.sqlite",
        "snapshot-cache.sqlite-wal",
        "snapshot-cache.sqlite-shm",
      ].map(async (name) => await unlink(join(directory, name)).catch(() => undefined)));
      started = await spawnAuthorityChild({
        directory,
        enableAttachmentFixture: true,
        forceSnapshotFallback: true,
        snapshotRecordsPerPage: 1,
      });
      const streamingClient = await JsonWebSocketClient.connect(started.url);
      clients.push(streamingClient);
      streamingClient.listen((frame) => authorityFrames.push(frame));
      await loginAuthorityDevice(streamingClient, {
        requestId: "attachment-e2e-streaming-login",
        accountId: "account-a",
        secret: "test-secret",
        deviceId: "attachment-e2e-streaming-device",
      });
      const streamingRepair = await repairRecords(streamingClient, roomId);
      expect(streamingRepair.mode).toBe("streaming");
      expect(streamingRepair.records.find((record) =>
        record.kind === "attachment" &&
        record.value.attachment.attachmentId === attachmentId)).toEqual(attachmentRepairs[0]);
      streamingClient.close();
      clients.length = 0;
      const streamingChild = started.child;
      await stopChild(streamingChild);
      childTranscripts.push(Object.freeze({
        stdout: childStdout.get(streamingChild) ?? "",
        stderr: childStderr.get(streamingChild) ?? "",
      }));
      started = undefined;

      const finalCheckpoint = await readAuthorityCheckpointFiles(directory);
      expect(byteSentinelHits(finalCheckpoint, attachmentForbiddenSentinels)).toEqual([]);
      const safeAuthorityEvidence = {
        readyPrivateEvents,
        boundEvents,
        messageEvents,
        bridgeInputs,
        authorityFrames,
        syncResults,
        histories,
        repairs,
        streamingRepair,
      };
      expect(jsonSentinelHits(
        "live-sync-history-repair",
        safeAuthorityEvidence,
        attachmentForbiddenSentinels,
      )).toEqual([]);
      expect(byteSentinelHits(
        childTranscripts.flatMap((transcript, index) => [
          { path: `child-${index}-stdout`, bytes: Buffer.from(transcript.stdout) },
          { path: `child-${index}-stderr`, bytes: Buffer.from(transcript.stderr) },
        ]),
        attachmentForbiddenSentinels,
      )).toEqual([]);
      const repairSnapshotStaleFrames = authorityFrames.filter((frame) =>
        frame.type === "error" &&
        frame.code === "snapshot_stale" &&
        frame.requestId.startsWith("repair-page-"));
      expect(repairSnapshotStaleFrames.length).toBeLessThanOrEqual(2);
      expect(authorityFrames.filter((frame) =>
        frame.type === "error" && !repairSnapshotStaleFrames.includes(frame))).toEqual([]);
    } finally {
      composer?.dispose();
      desktopRuntime?.close();
      rendererRoot?.remove();
      for (const client of clients) client.close();
      if (started !== undefined) await stopChild(started.child).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("replays one structured v2 aggregate after an unconsumed ACK, changed requests, and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-ft03-message-replay-"));
    const messageActors = [
      ...actors,
      { id: "human-b", kind: "human", displayName: "Human B", reachability: "online" },
    ] satisfies readonly Actor[];
    const identities = [
      { accountId: "account-a", actorId: "human-a", secret: "test-secret" },
      { accountId: "account-b", actorId: "human-b", secret: "test-secret-b" },
    ] as const;
    const clients: JsonWebSocketClient[] = [];
    let started: Awaited<ReturnType<typeof spawnAuthorityChild>> | undefined;
    try {
      const seeded = await spawnAuthorityChild({
        directory,
        actors: messageActors,
        identities,
        seedAllFacts: true,
      });
      const seedClient = await JsonWebSocketClient.connect(seeded.url);
      clients.push(seedClient);
      await loginAuthorityDevice(seedClient, {
        requestId: "message-v2-replay-seed-login",
        accountId: "account-a",
        secret: "test-secret",
        deviceId: "message-v2-seed-device",
      });
      const roomId = await discoverRoom(seedClient);
      await waitForRoomAuthorityQuiescence(directory, roomId, 10_000);
      seedClient.close();
      await stopChild(seeded.child);

      const setup = new DatabaseSync(join(directory, "authority.sqlite"));
      setup.prepare(
        `INSERT INTO room_memberships (
           room_id, actor_id, kind, role, participation, tool_permissions_json,
           joined_at, configured_at, access_revision
         ) VALUES (?, 'human-b', 'human', 'member', NULL, '[]', ?, NULL, 0)`,
      ).run(roomId, "2026-08-19T00:00:00.000Z");
      setup.close();

      started = await spawnAuthorityChild({ directory, actors: messageActors, identities });
      const [observerA, sender, observerB] = await Promise.all([
        JsonWebSocketClient.connect(started.url),
        JsonWebSocketClient.connect(started.url),
        JsonWebSocketClient.connect(started.url),
      ]);
      clients.push(observerA, sender, observerB);
      await Promise.all([
        loginAuthorityDevice(observerA, {
          requestId: "message-v2-device-a-login",
          accountId: "account-a",
          secret: "test-secret",
          deviceId: "message-v2-device-a",
        }),
        loginAuthorityDevice(sender, {
          requestId: "message-v2-device-b-login",
          accountId: "account-a",
          secret: "test-secret",
          deviceId: "message-v2-device-b",
        }),
        loginAuthorityDevice(observerB, {
          requestId: "message-v2-human-b-login",
          accountId: "account-b",
          secret: "test-secret-b",
          deviceId: "message-v2-human-b-device",
        }),
      ]);
      await waitForRoomAuthorityQuiescence(directory, roomId, 10_000);
      const head = readRoomHeadSeq(directory, roomId);
      await Promise.all([observerA, observerB].map((client, index) => client.request({
        type: "room.subscribe.v2",
        requestId: `message-v2-replay-subscribe-${index}`,
        roomId,
        cursor: { version: 1, roomId, afterSeq: head },
      }, "room.subscribed.v2")));

      const message = {
        messageId: "message-v2-ack-loss-replay",
        roomId,
        body: "@Human B @Agent A production request",
        mentionedTargets: [
          {
            id: "target-human-b",
            kind: "human-request",
            targetActorId: "human-b",
            range: { startUtf16: 0, endUtf16: 8 },
          },
          {
            id: "target-agent-a",
            kind: "agent-invocation",
            targetActorId: "agent-a",
            range: { startUtf16: 9, endUtf16: 17 },
          },
        ],
        replyToMessageId: "message-human-authority",
        attachments: [],
      } as const;
      const observerAEvent = observerA.waitFor((frame) => frame.type === "room.event" &&
        frame.event.roomId === roomId && frame.event.type === "room.message.accepted" &&
        frame.event.payload.id === message.messageId);
      const observerBEvent = observerB.waitFor((frame) => frame.type === "room.event" &&
        frame.event.roomId === roomId && frame.event.type === "room.message.accepted" &&
        frame.event.payload.id === message.messageId);
      sender.send({
        type: "message.send.v2",
        requestId: "message-v2-unconsumed-ack",
        message,
      });
      let stableEventA: ServerFrame;
      let stableEventB: ServerFrame;
      try {
        [stableEventA, stableEventB] = await Promise.all([observerAEvent, observerBEvent]);
      } catch (error: unknown) {
        throw new Error(`Structured v2 event did not converge: ${JSON.stringify({
          observerA: observerA.frames(),
          sender: sender.frames(),
          observerB: observerB.frames(),
        })}`, { cause: error });
      }
      expect(stableEventA).toEqual(stableEventB);
      if (stableEventA.type !== "room.event") throw new TypeError("wrong stable message event");
      sender.terminate();

      const replayClient = await JsonWebSocketClient.connect(started.url);
      clients.push(replayClient);
      await loginAuthorityDevice(replayClient, {
        requestId: "message-v2-replay-login",
        accountId: "account-a",
        secret: "test-secret",
        deviceId: "message-v2-replay-device",
      });
      const replay = await replayClient.request({
        type: "message.send.v2",
        requestId: "message-v2-replay-new-request",
        message,
      }, "message.accepted");
      expect(replay).toMatchObject({
        type: "message.accepted",
        requestId: "message-v2-replay-new-request",
        messageId: message.messageId,
        targetOutcomes: [
          {
            targetId: "target-human-b",
            targetActorId: "human-b",
            kind: "human-request",
            status: "request-created",
            requestIntentId: expect.any(String),
          },
          {
            targetId: "target-agent-a",
            targetActorId: "agent-a",
            kind: "agent-invocation",
            status: "invocation-intent-created",
            invocationIntentId: expect.any(String),
          },
        ],
      });
      if (replay.type !== "message.accepted") throw new TypeError("wrong replay ACK");

      const changedMessages = [
        { ...message, body: `${message.body}!` },
        {
          ...message,
          mentionedTargets: [
            { ...message.mentionedTargets[0], targetActorId: "human-a" },
            message.mentionedTargets[1],
          ],
        },
        {
          ...message,
          mentionedTargets: [
            { ...message.mentionedTargets[0], range: { startUtf16: 0, endUtf16: 7 } },
            message.mentionedTargets[1],
          ],
        },
        {
          messageId: message.messageId,
          roomId: message.roomId,
          body: message.body,
          mentionedTargets: message.mentionedTargets,
          attachments: message.attachments,
        },
      ] as const;
      for (const [index, changed] of changedMessages.entries()) {
        await expect(replayClient.request({
          type: "message.send.v2",
          requestId: `message-v2-changed-${index}`,
          message: changed,
        }, "message.accepted")).rejects.toMatchObject({
          status: 409,
          code: "idempotency_conflict",
        });
      }

      for (const client of [observerA, observerB, replayClient]) client.close();
      await stopChild(started.child);
      started = await spawnAuthorityChild({ directory, actors: messageActors, identities });
      const restartedClient = await JsonWebSocketClient.connect(started.url);
      clients.push(restartedClient);
      await loginAuthorityDevice(restartedClient, {
        requestId: "message-v2-restart-login",
        accountId: "account-a",
        secret: "test-secret",
        deviceId: "message-v2-restart-device",
      });
      await expect(restartedClient.request({
        type: "message.send.v2",
        requestId: "message-v2-restart-replay",
        message,
      }, "message.accepted")).resolves.toEqual({
        ...replay,
        requestId: "message-v2-restart-replay",
      });
      restartedClient.close();
      await stopChild(started.child);
      started = undefined;

      const database = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
      try {
        expect(database.prepare(
          `SELECT
             (SELECT COUNT(*) FROM messages WHERE id = ?) AS messages,
             (SELECT COUNT(*) FROM message_revisions WHERE message_id = ?) AS revisions,
             (SELECT COUNT(*) FROM message_envelopes WHERE message_id = ?) AS envelopes,
             (SELECT COUNT(*) FROM message_mentions WHERE message_id = ?) AS mentions,
             (SELECT COUNT(*) FROM message_target_outcomes WHERE message_id = ?) AS outcomes,
             (SELECT COUNT(*) FROM human_request_intents WHERE source_message_id = ?) AS humanIntents,
             (SELECT COUNT(*) FROM agent_invocation_intents
                WHERE source_message_id = ? AND origin_kind = 'message_target') AS agentIntents,
             (SELECT COUNT(*) FROM message_reply_links WHERE message_id = ?) AS replyLinks,
             (SELECT COUNT(*) FROM message_attachment_links WHERE message_id = ?) AS attachments,
             (SELECT COUNT(*) FROM events WHERE event_id = ?) AS events,
             (SELECT COUNT(*) FROM outbox_deliveries WHERE event_id = ?) AS outbox,
             (SELECT COUNT(*) FROM idempotency_records WHERE key = ?) AS receipts`,
        ).get(
          message.messageId,
          message.messageId,
          message.messageId,
          message.messageId,
          message.messageId,
          message.messageId,
          message.messageId,
          message.messageId,
          message.messageId,
          stableEventA.event.eventId,
          stableEventA.event.eventId,
          message.messageId,
        )).toEqual({
          messages: 1,
          revisions: 1,
          envelopes: 1,
          mentions: 2,
          outcomes: 2,
          humanIntents: 1,
          agentIntents: 1,
          replyLinks: 1,
          attachments: 0,
          events: 1,
          outbox: 1,
          receipts: 1,
        });
      } finally {
        database.close();
      }
    } finally {
      for (const client of clients) client.close();
      if (started !== undefined) await stopChild(started.child);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps provider preview transient across source recall while preserving completed and dispatched facts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-preview-recall-sentinel-"));
    const databasePath = join(directory, "authority.sqlite");
    const sentinel = "PREVIEW-MUST-STAY-TRANSIENT-7D04FBD1";
    let started: Awaited<ReturnType<typeof spawnAuthorityChild>> | undefined;
    let client: JsonWebSocketClient | undefined;
    let runtimeClient: Awaited<ReturnType<typeof createWorkerDatabaseClient>> | undefined;
    try {
      started = await spawnAuthorityChild({
        directory,
        actors: previewActors,
        seedRuntimeRoomForTest: true,
        previewSentinelForTest: sentinel,
      });
      client = await JsonWebSocketClient.connect(started.url);
      await client.login("preview-recall-login");
      const roomId = await discoverRoom(client);
      await client.request({
        type: "room.subscribe.v2",
        requestId: "preview-recall-subscribe",
        roomId,
        cursor: { version: 1, roomId, afterSeq: readRoomHeadSeq(directory, roomId) },
      }, "room.subscribed.v2");

      const submit = async (messageId: string, body: string): Promise<void> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const receipt = await client!.request({
              type: "message.send.v2",
              requestId: `submit-${messageId}`,
              message: { messageId, roomId, body, mentionedTargets: [], attachments: [] },
            }, "message.accepted");
            expect(receipt).toMatchObject({ messageId, targetOutcomes: [] });
            return;
          } catch (error: unknown) {
            if (!isRecord(error) || error.code !== "storage_unavailable" || attempt === 2) {
              throw error;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          }
        }
        throw new Error("Message submission retry bound was exhausted");
      };
      const invoke = async (messageId: string) => {
        const frame = await client!.request({
          type: "agent.invoke",
          requestId: `invoke-${messageId}`,
          intent: {
            kind: "direct_mention",
            roomId,
            sourceMessageId: messageId,
            targetAgentId: "agent-a",
          },
        }, "agent.execution.ack");
        if (frame.type !== "agent.execution.ack") throw new TypeError("wrong execution ACK");
        return frame.execution;
      };

      const completedSourceId = "message-preview-completed";
      await submit(completedSourceId, "complete before source recall");
      const completedExecution = await invoke(completedSourceId);
      await vi.waitFor(() => {
        const database = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(database.prepare(
            "SELECT status FROM agent_executions WHERE id = ?",
          ).get(completedExecution.id)).toEqual({ status: "completed" });
        } finally {
          database.close();
        }
      });
      await expect(client.request({
        type: "message.recall",
        requestId: "recall-completed-preview-source",
        roomId,
        messageId: completedSourceId,
        expectedRevision: 1,
      }, "message.recall.accepted")).resolves.toMatchObject({
        messageId: completedSourceId,
        revision: 1,
      });

      const previewSourceId = "message-preview-running";
      await submit(previewSourceId, "run a read tool then wait on preview");
      const runningExecution = await invoke(previewSourceId);
      await expect(client.waitFor((frame) =>
        frame.type === "agent.execution.preview" &&
        frame.executionId === runningExecution.id && frame.delta === sentinel,
      )).resolves.toMatchObject({
        type: "agent.execution.preview",
        executionId: runningExecution.id,
        delta: sentinel,
        authoritative: false,
      });

      const beforeRecall = new DatabaseSync(databasePath, { readOnly: true });
      let retainedDispatch: unknown;
      try {
        retainedDispatch = beforeRecall.prepare(
          `SELECT dispatch_id AS dispatchId, state
           FROM tool_dispatches WHERE execution_id = ?`,
        ).get(runningExecution.id);
        expect(retainedDispatch).toEqual(expect.objectContaining({ state: "succeeded" }));
        expect(authoritySentinelHits(databasePath, sentinel)).toEqual([]);
      } finally {
        beforeRecall.close();
      }

      await expect(client.request({
        type: "message.recall",
        requestId: "recall-running-preview-source",
        roomId,
        messageId: previewSourceId,
        expectedRevision: 1,
      }, "message.recall.accepted")).resolves.toMatchObject({
        messageId: previewSourceId,
        revision: 1,
      });

      const history = await client.request({
        type: "room.history.v2",
        requestId: "preview-sentinel-history",
        roomId,
      }, "room.history.v2");
      const revisions = await client.request({
        type: "message.revisions.query",
        requestId: "preview-sentinel-revisions",
        roomId,
        messageId: previewSourceId,
      }, "message.revisions");
      const repair = await repairRecords(client, roomId);
      expect(JSON.stringify({ history, revisions, repair })).not.toContain(sentinel);
      expect(revisions).toMatchObject({ revisions: [] });

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare(
          "SELECT status FROM agent_executions WHERE id = ?",
        ).get(runningExecution.id)).toEqual({ status: "cancelled" });
        expect(database.prepare(
          "SELECT status FROM agent_executions WHERE id = ?",
        ).get(completedExecution.id)).toEqual({ status: "completed" });
        expect(database.prepare(
          `SELECT dispatch_id AS dispatchId, state
           FROM tool_dispatches WHERE execution_id = ?`,
        ).get(runningExecution.id)).toEqual(retainedDispatch);
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM messages
           WHERE author_kind = 'agent' AND body = ?`,
        ).get(sentinel)).toEqual({ count: 0 });
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM messages
           WHERE author_kind = 'agent'`,
        ).get()).toEqual({ count: 1 });
        expect(authoritySentinelHits(databasePath, sentinel)).toEqual([]);
      } finally {
        database.close();
      }

      client.close();
      client = undefined;
      await stopChild(started.child);
      started = undefined;
      runtimeClient = await createWorkerDatabaseClient({ databasePath });
      const runtimeContext = await createWorkerRuntimeAuthority(runtimeClient)
        .readContext(runningExecution.id);
      expect(JSON.stringify(runtimeContext)).not.toContain(sentinel);
      await runtimeClient.close();
      runtimeClient = undefined;
      const durableBytes = Buffer.concat(await readAllRegularFiles(directory));
      expect(durableBytes.includes(Buffer.from(sentinel, "utf8"))).toBe(false);
    } finally {
      await runtimeClient?.close().catch(() => undefined);
      client?.close();
      if (started !== undefined) await stopChild(started.child).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not turn a provider preview into authority data after crash and reconnect repair", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-preview-crash-sentinel-"));
    const databasePath = join(directory, "authority.sqlite");
    const sentinel = "PREVIEW-CRASH-RECONNECT-ZERO-WRITE-58C3";
    let first: Awaited<ReturnType<typeof spawnAuthorityChild>> | undefined;
    let second: Awaited<ReturnType<typeof spawnAuthorityChild>> | undefined;
    let client: JsonWebSocketClient | undefined;
    try {
      first = await spawnAuthorityChild({
        directory,
        actors: previewActors,
        seedRuntimeRoomForTest: true,
        previewSentinelForTest: sentinel,
      });
      client = await JsonWebSocketClient.connect(first.url);
      await client.login("preview-crash-login");
      const roomId = await discoverRoom(client);
      await client.request({
        type: "room.subscribe.v2",
        requestId: "preview-crash-subscribe",
        roomId,
        cursor: { version: 1, roomId, afterSeq: readRoomHeadSeq(directory, roomId) },
      }, "room.subscribed.v2");
      const sourceMessageId = "message-preview-crash-running";
      await client.request({
        type: "message.send.v2",
        requestId: "preview-crash-submit",
        message: {
          messageId: sourceMessageId,
          roomId,
          body: "crash after provider preview",
          mentionedTargets: [],
          attachments: [],
        },
      }, "message.accepted");
      const invoked = await client.request({
        type: "agent.invoke",
        requestId: "preview-crash-invoke",
        intent: {
          kind: "direct_mention",
          roomId,
          sourceMessageId,
          targetAgentId: "agent-a",
        },
      }, "agent.execution.ack");
      if (invoked.type !== "agent.execution.ack") throw new TypeError("wrong execution ACK");
      await client.waitFor((frame) => frame.type === "agent.execution.preview" &&
        frame.executionId === invoked.execution.id && frame.delta === sentinel);

      client.terminate();
      client = undefined;
      first.child.kill("SIGKILL");
      await childExit(first.child);
      first = undefined;
      expect(authoritySentinelHits(databasePath, sentinel)).toEqual([]);

      second = await spawnAuthorityChild({
        directory,
        actors: previewActors,
        readbackOnly: true,
        previewSentinelForTest: sentinel,
      });
      client = await JsonWebSocketClient.connect(second.url);
      await client.login("preview-reconnect-login");
      const repairedRoomId = await discoverRoom(client);
      const repair = await repairRecords(client, repairedRoomId);
      const history = await client.request({
        type: "room.history.v2",
        requestId: "preview-reconnect-history",
        roomId: repairedRoomId,
      }, "room.history.v2");
      expect(JSON.stringify({ repair, history })).not.toContain(sentinel);
      expect(authoritySentinelHits(databasePath, sentinel)).toEqual([]);
      const durableBytes = Buffer.concat(await readAllRegularFiles(directory));
      expect(durableBytes.includes(Buffer.from(sentinel, "utf8"))).toBe(false);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM messages
           WHERE author_kind = 'agent' AND body = ?`,
        ).get(sentinel)).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    } finally {
      client?.close();
      if (first !== undefined) await stopChild(first.child).catch(() => undefined);
      if (second !== undefined) await stopChild(second.child).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("restores three production Desktop message runtimes from an expired cursor through revise, recall, clear, and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-ft03-desktop-repair-"));
    const runtimes: DesktopMessageAuthorityRuntime[] = [];
    const rawClients: JsonWebSocketClient[] = [];
    let started: Awaited<ReturnType<typeof spawnAuthorityChild>> | undefined;
    try {
      const roomId = await seedDirectory(directory);
      const seededHead = readRoomHeadSeq(directory, roomId);
      expect(seededHead).toBeGreaterThan(1);
      await compactRoomStream(directory, roomId, seededHead);

      started = await spawnAuthorityChild({ directory });
      const sessions: IdentityAuthoritySession[] = [];
      for (const deviceId of ["desktop-message-a", "desktop-message-b", "desktop-message-c"]) {
        const loginClient = await JsonWebSocketClient.connect(started.url);
        rawClients.push(loginClient);
        sessions.push(await loginAuthorityDevice(loginClient, {
          requestId: `${deviceId}-login`,
          accountId: "account-a",
          secret: "test-secret",
          deviceId,
        }));
        loginClient.close();
      }

      const socketGroups = sessions.map(() => [] as NodeIdentityWebSocketAdapter[]);
      const inputs = sessions.map(() => [] as MessageAuthorityPortInput[]);
      const active = sessions.map((session, index) => {
        const runtime = createDesktopMessageAuthorityRuntime({
          endpoint: started!.url,
          session: () => session,
          webSocketFactory(endpoint) {
            const socket = new NodeIdentityWebSocketAdapter(endpoint);
            socketGroups[index]!.push(socket);
            return socket;
          },
          timeoutMs: 5_000,
        });
        runtimes.push(runtime);
        runtime.client.subscribe((input) => inputs[index]!.push(structuredClone(input)));
        return runtime;
      });
      const initial = await Promise.all(active.map((runtime, index) =>
        runtime.client.historyV2({
          type: "room.history.v2",
          requestId: `desktop-message-initial-${index}`,
          roomId,
        })));
      expect(initial.every((history) => history.status === "ready")).toBe(true);
      const initialWatermarks = initial.map((history) =>
        history.status === "ready" ? history.watermark : -1);
      expect(new Set(initialWatermarks).size).toBe(1);
      const initialWatermark = initialWatermarks[0]!;
      expect(initialWatermark).toBeGreaterThanOrEqual(seededHead);
      for (const received of inputs) {
        expect(received).toContainEqual({
          type: "message.connection",
          roomId,
          connection: { status: "repairing", watermark: initialWatermark },
        });
      }

      const acceptedBody = "DESKTOP-V2-ACCEPTED-RAW-SENTINEL";
      const revisedBody = "DESKTOP-V2-REVISED-RAW-SENTINEL";
      const messageId = "message-v2-desktop-repair";
      await expect(active[0]!.client.sendV2({
        type: "message.send.v2",
        requestId: "desktop-message-send",
        message: {
          messageId,
          roomId,
          body: acceptedBody,
          mentionedTargets: [],
          attachments: [],
        },
      })).resolves.toMatchObject({
        type: "message.accepted",
        requestId: "desktop-message-send",
        messageId,
      });
      await vi.waitFor(() => {
        expect(inputs.every((received) => received.some((input) =>
          input.type === "room.event" && input.event.type === "room.message.accepted" &&
          input.event.payload.id === messageId))).toBe(true);
      }, { timeout: 10_000 });

      socketGroups[2]!.at(-1)!.terminate();
      await vi.waitFor(() => {
        expect(inputs[2]).toContainEqual({
          type: "message.connection",
          roomId,
          connection: expect.objectContaining({ status: "offline" }),
        });
      }, { timeout: 10_000 });
      await expect(active[0]!.client.revise({
        type: "message.revise",
        requestId: "desktop-message-revise",
        roomId,
        messageId,
        expectedRevision: 1,
        body: revisedBody,
      })).resolves.toMatchObject({
        type: "message.revision.accepted",
        requestId: "desktop-message-revise",
        messageId,
        revision: 2,
      });
      await vi.waitFor(() => {
        expect(inputs.slice(0, 2).every((received) => received.some((input) =>
          input.type === "room.event" && input.event.type === "room.message.revised" &&
          input.event.payload.id === messageId))).toBe(true);
      }, { timeout: 10_000 });

      const reconnected = await active[2]!.client.historyV2({
        type: "room.history.v2",
        requestId: "desktop-message-reconnect-c",
        roomId,
      });
      if (reconnected.status !== "ready") throw new TypeError("Desktop C did not reconnect");
      expect(reconnected.messages).toContainEqual(expect.objectContaining({
        id: messageId,
        lifecycle: "active",
        currentRevision: expect.objectContaining({ revision: 2, body: revisedBody }),
      }));

      active[1]!.clearAndRestore(roomId);
      const cleared = await active[1]!.client.historyV2({
        type: "room.history.v2",
        requestId: "desktop-message-clear-b",
        roomId,
      });
      if (cleared.status !== "ready") throw new TypeError("Desktop B did not clear and restore");
      expect(cleared.generation).toBeGreaterThan(
        initial[1]!.status === "ready" ? initial[1].generation : 0,
      );
      expect(cleared.messages).toContainEqual(expect.objectContaining({
        id: messageId,
        currentRevision: expect.objectContaining({ revision: 2, body: revisedBody }),
      }));

      for (const received of inputs) received.length = 0;
      await expect(active[0]!.client.recall({
        type: "message.recall",
        requestId: "desktop-message-recall",
        roomId,
        messageId,
        expectedRevision: 2,
      })).resolves.toMatchObject({
        type: "message.recall.accepted",
        requestId: "desktop-message-recall",
        messageId,
        revision: 2,
      });
      await vi.waitFor(() => {
        expect(inputs.every((received) => received.some((input) =>
          input.type === "room.event" && input.event.type === "room.message.recalled" &&
          input.event.payload.id === messageId))).toBe(true);
      }, { timeout: 10_000 });
      expect(JSON.stringify(inputs)).not.toContain(acceptedBody);
      expect(JSON.stringify(inputs)).not.toContain(revisedBody);

      for (const runtime of active) runtime.close();
      await stopChild(started.child);
      started = await spawnAuthorityChild({ directory });
      const restarted = sessions.map((session) => {
        const runtime = createDesktopMessageAuthorityRuntime({
          endpoint: started!.url,
          session: () => session,
          webSocketFactory: (endpoint) => new NodeIdentityWebSocketAdapter(endpoint),
          timeoutMs: 5_000,
        });
        runtimes.push(runtime);
        return runtime;
      });
      const finalHistories = await Promise.all(restarted.map((runtime, index) =>
        runtime.client.historyV2({
          type: "room.history.v2",
          requestId: `desktop-message-restart-${index}`,
          roomId,
        })));
      for (const history of finalHistories) {
        if (history.status !== "ready") throw new TypeError("Desktop restart was not ready");
        expect(history.messages).toContainEqual(expect.objectContaining({
          id: messageId,
          lifecycle: "recalled",
        }));
      }
      expect(JSON.stringify(finalHistories)).not.toContain(acceptedBody);
      expect(JSON.stringify(finalHistories)).not.toContain(revisedBody);
    } finally {
      for (const runtime of runtimes) runtime.close();
      for (const client of rawClients) client.close();
      if (started !== undefined) await stopChild(started.child);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("drives three isolated Desktop Identity controllers through real password login and targeted device revocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-ft01-desktop-authority-"));
    const databasePath = join(directory, "authority.sqlite");
    const snapshotCachePath = join(directory, "snapshot-cache.sqlite");
    const accountId = "account-a";
    const passwordCanary = "ft01-password-canary-never-persist-2026";
    const salt = Buffer.from("ft01-scrypt-salt-v1", "utf8");
    const identities = createScryptIdentityAdapter([{
      accountId,
      actorId: "human-a",
      salt: salt.toString("base64url"),
      hash: scryptSync(passwordCanary, salt, 64).toString("base64url"),
    }]);
    const serverOptions = {
      databasePath,
      snapshotCachePath,
      sharedAuthority: { maxOfflineReadLeaseMs: 60_000 },
      listen: { host: "127.0.0.1", port: 0 },
      actors,
      identities,
      invitationSecretKey: new Uint8Array(32).fill(19),
    } as const;
    const profileA = createMemoryCredentialVault();
    const profileB = createMemoryCredentialVault();
    const profileC = createMemoryCredentialVault();
    const invalidatorA = createTrackedInvalidator();
    const invalidatorB = createTrackedInvalidator();
    const invalidatorC = createTrackedInvalidator();
    const observedA: IdentityPublicState[] = [];
    const observedB: IdentityPublicState[] = [];
    const observedC: IdentityPublicState[] = [];
    const observedRestoredA: IdentityPublicState[] = [];
    const observedReloginA: IdentityPublicState[] = [];
    const applicationLogs: unknown[][] = [];
    const logSpies = (["debug", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        applicationLogs.push(values);
      }));
    const controllers: IdentitySessionController[] = [];
    let server: AuthoritativeServer | undefined;

    try {
      server = await startAuthoritativeServer(serverOptions);
      const controllerA = createIdentitySessionController({
        vault: profileA.vault,
        deviceIdentity: createMemoryDevice("installation-a", "FT01 Device A"),
        clientFactory: createDesktopClientFactory(server.url, "desktop-a"),
        authorizedState: invalidatorA,
      });
      const controllerB = createIdentitySessionController({
        vault: profileB.vault,
        deviceIdentity: createMemoryDevice("installation-b", "FT01 Device B"),
        clientFactory: createDesktopClientFactory(server.url, "desktop-b"),
        authorizedState: invalidatorB,
      });
      const controllerC = createIdentitySessionController({
        vault: profileC.vault,
        deviceIdentity: createMemoryDevice("installation-c", "FT01 Device C"),
        clientFactory: createDesktopClientFactory(server.url, "desktop-c"),
        authorizedState: invalidatorC,
      });
      controllers.push(controllerA, controllerB, controllerC);
      controllerA.subscribe((state) => observedA.push(state));
      controllerB.subscribe((state) => observedB.push(state));
      controllerC.subscribe((state) => observedC.push(state));

      await expect(controllerA.initialize()).resolves.toEqual({ status: "signed-out" });
      await expect(controllerB.initialize()).resolves.toEqual({ status: "signed-out" });
      await expect(controllerC.initialize()).resolves.toEqual({ status: "signed-out" });
      await expect(controllerA.login({ accountId, secret: passwordCanary }))
        .resolves.toMatchObject({
          status: "authenticated",
          accountId,
          actorId: "human-a",
          sessions: [{ deviceLabel: "FT01 Device A", current: true }],
        });
      await expect(controllerB.login({ accountId, secret: passwordCanary }))
        .resolves.toMatchObject({ status: "authenticated", accountId, actorId: "human-a" });
      await expect(controllerC.login({ accountId, secret: passwordCanary }))
        .resolves.toMatchObject({ status: "authenticated", accountId, actorId: "human-a" });

      const credentialsA = profileA.read();
      const credentialsB = profileB.read();
      const credentialsC = profileC.read();
      if (credentialsA === undefined || credentialsB === undefined || credentialsC === undefined) {
        throw new TypeError("Desktop profiles did not persist issued credentials");
      }
      expect(credentialsA.sessionId).not.toBe(credentialsB.sessionId);
      expect(new Set([
        credentialsA.sessionId,
        credentialsB.sessionId,
        credentialsC.sessionId,
      ])).toHaveProperty("size", 3);

      const listedA = await controllerA.refreshSessions();
      expect(listedA).toMatchObject({ status: "authenticated", accountId });
      if (listedA.status !== "authenticated") {
        throw new TypeError("Desktop A did not publish authenticated sessions");
      }
      expect(listedA.sessions).toHaveLength(3);
      expect(listedA.sessions.map((session) => session.deviceLabel).sort())
        .toEqual(["FT01 Device A", "FT01 Device B", "FT01 Device C"]);
      expect(listedA.sessions.filter((session) => session.current))
        .toEqual([expect.objectContaining({
          id: credentialsA.sessionId,
          deviceLabel: "FT01 Device A",
        })]);
      const targetB = listedA.sessions.find(
        (session) => session.deviceLabel === "FT01 Device B",
      );
      if (targetB === undefined) throw new TypeError("Desktop B public session was missing");

      const afterRevoke = await controllerA.revokeSession({ sessionId: targetB.id });
      expect(afterRevoke).toMatchObject({ status: "authenticated", accountId });
      if (afterRevoke.status !== "authenticated") {
        throw new TypeError("Desktop A lost authentication after revoking B");
      }
      expect(afterRevoke.sessions).toHaveLength(2);
      expect(afterRevoke.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: credentialsA.sessionId,
          deviceLabel: "FT01 Device A",
          current: true,
        }),
        expect.objectContaining({
          id: credentialsC.sessionId,
          deviceLabel: "FT01 Device C",
          current: false,
        }),
      ]));
      await vi.waitFor(() => {
        expect(controllerB.getState()).toEqual({ status: "revoked", accountId });
        expect(profileB.read()).toBeUndefined();
      }, { timeout: 5_000, interval: 20 });
      expect(profileB.clear).toHaveBeenCalledOnce();
      expect(invalidatorB.invalidate).toHaveBeenCalledOnce();
      expect(invalidatorA.invalidate).not.toHaveBeenCalled();
      expect(invalidatorC.invalidate).not.toHaveBeenCalled();
      await expect(controllerA.refreshSessions()).resolves.toMatchObject({
        status: "authenticated",
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: credentialsA.sessionId, current: true }),
          expect.objectContaining({ id: credentialsC.sessionId, current: false }),
        ]),
      });
      await expect(controllerC.refreshSessions()).resolves.toMatchObject({
        status: "authenticated",
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: credentialsC.sessionId, current: true }),
          expect.objectContaining({ id: credentialsA.sessionId, current: false }),
        ]),
      });

      const sensitiveValues: string[] = [
        passwordCanary,
        credentialsA.accessToken,
        credentialsA.refreshToken,
        credentialsB.accessToken,
        credentialsB.refreshToken,
        credentialsC.accessToken,
        credentialsC.refreshToken,
      ];
      const firstPublicEvidence = JSON.stringify([
        ...observedA,
        ...observedB,
        ...observedC,
        controllerA.getState(),
        controllerB.getState(),
        controllerC.getState(),
      ]);
      for (const sensitive of sensitiveValues) {
        expect(firstPublicEvidence).not.toContain(sensitive);
      }

      controllerA.close();
      controllerB.close();
      controllerC.close();
      await server.close();
      server = undefined;

      const database = new DatabaseSync(databasePath);
      try {
        const familyRows = database.prepare(
          `SELECT device_label AS deviceLabel, revoked_at AS revokedAt
           FROM session_families ORDER BY device_label`,
        ).all() as Array<{ readonly deviceLabel: string; readonly revokedAt: number | null }>;
        expect(familyRows).toEqual([
          { deviceLabel: "FT01 Device A", revokedAt: null },
          { deviceLabel: "FT01 Device B", revokedAt: expect.any(Number) },
          { deviceLabel: "FT01 Device C", revokedAt: null },
        ]);
        const persistedSessions = JSON.stringify(database.prepare(
          "SELECT * FROM sessions ORDER BY family_id, access_token_hash",
        ).all());
        for (const sensitive of sensitiveValues) {
          expect(persistedSessions).not.toContain(sensitive);
        }
        const expired = database.prepare(
          "UPDATE sessions SET access_expires_at = 0 WHERE access_token_hash = ?",
        ).run(createHash("sha256").update(credentialsA.accessToken, "utf8").digest("base64url"));
        expect(expired.changes).toBe(1);
      } finally {
        database.close();
      }

      server = await startAuthoritativeServer(serverOptions);
      const restoredA = createIdentitySessionController({
        vault: profileA.vault,
        deviceIdentity: createMemoryDevice("installation-a", "FT01 Device A"),
        clientFactory: createDesktopClientFactory(server.url, "desktop-a-restored"),
        authorizedState: invalidatorA,
      });
      controllers.push(restoredA);
      restoredA.subscribe((state) => observedRestoredA.push(state));
      const restoredState = await restoredA.initialize();
      expect(restoredState).toMatchObject({
        status: "authenticated",
        accountId,
        actorId: "human-a",
      });
      if (restoredState.status !== "authenticated") {
        throw new TypeError("Desktop A did not restore authenticated state");
      }
      expect(restoredState.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: credentialsA.sessionId,
          deviceLabel: "FT01 Device A",
          current: true,
        }),
        expect.objectContaining({
          id: credentialsC.sessionId,
          deviceLabel: "FT01 Device C",
          current: false,
        }),
      ]));
      const rotatedCredentialsA = profileA.read();
      expect(rotatedCredentialsA).toMatchObject({
        accountId: credentialsA.accountId,
        actorId: credentialsA.actorId,
        sessionId: credentialsA.sessionId,
      });
      expect(rotatedCredentialsA?.accessToken).not.toBe(credentialsA.accessToken);
      expect(rotatedCredentialsA?.refreshToken).not.toBe(credentialsA.refreshToken);
      if (rotatedCredentialsA === undefined) {
        throw new TypeError("Desktop A did not persist refreshed credentials");
      }
      sensitiveValues.push(rotatedCredentialsA.accessToken, rotatedCredentialsA.refreshToken);
      expect(invalidatorA.invalidate).not.toHaveBeenCalled();

      await expect(restoredA.logout()).resolves.toEqual({
        status: "signed-out",
        accountId,
      });
      expect(profileA.read()).toBeUndefined();
      expect(invalidatorA.invalidate).toHaveBeenCalledOnce();
      restoredA.close();

      const reloginA = createIdentitySessionController({
        vault: profileA.vault,
        deviceIdentity: createMemoryDevice("installation-a", "FT01 Device A"),
        clientFactory: createDesktopClientFactory(server.url, "desktop-a-relogin"),
        authorizedState: invalidatorA,
      });
      controllers.push(reloginA);
      reloginA.subscribe((state) => observedReloginA.push(state));
      await expect(reloginA.initialize()).resolves.toEqual({ status: "signed-out" });
      await expect(reloginA.login({ accountId, secret: passwordCanary }))
        .resolves.toMatchObject({ status: "authenticated", accountId, actorId: "human-a" });
      const reloginCredentialsA = profileA.read();
      if (reloginCredentialsA === undefined) {
        throw new TypeError("Desktop A did not persist relogin credentials");
      }
      expect(reloginCredentialsA.sessionId).not.toBe(credentialsA.sessionId);
      sensitiveValues.push(reloginCredentialsA.accessToken, reloginCredentialsA.refreshToken);

      const finalPublicEvidence = JSON.stringify([
        ...observedA,
        ...observedB,
        ...observedC,
        ...observedRestoredA,
        ...observedReloginA,
        restoredA.getState(),
        reloginA.getState(),
      ]);
      const deliveryArtifacts = (await Promise.all([
        "docs/plans/2026-08-18-ft01-identity-session-implementation-plan.md",
        "docs/plans/2026-08-18-ft01-identity-session-acceptance-matrix.md",
        "docs/deliveries/FT-01-Identity-Session-交付说明.md",
      ].map((path) => readFile(join(process.cwd(), path), "utf8")))).join("\n");
      for (const sensitive of sensitiveValues) {
        expect(finalPublicEvidence).not.toContain(sensitive);
        expect(JSON.stringify(applicationLogs)).not.toContain(sensitive);
        expect(deliveryArtifacts).not.toContain(sensitive);
      }

      reloginA.close();
      await server.close();
      server = undefined;
      const diskBytes = Buffer.concat(await readAllRegularFiles(directory));
      for (const sensitive of sensitiveValues) {
        expect(diskBytes.includes(Buffer.from(sensitive, "utf8"))).toBe(false);
      }
    } finally {
      for (const controller of controllers) controller.close();
      await server?.close().catch(() => undefined);
      for (const spy of logSpies) spy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("builds the closed JSON-line child fixture used by restart tests", async () => {
    const fixturePath = join(
      process.cwd(),
      "packages/server/dist/fixtures/authority-child.js",
    );

    await expect(access(fixturePath)).resolves.toBeUndefined();
  });

  it("filters exactly one SQLite warning but rejects an unrelated ExperimentalWarning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-warning-filter-"));
    try {
      await expect(runAuthorityUtility({
        directory,
        inspectMessageIds: [],
        emitUnrelatedWarningForTest: true,
      })).rejects.toThrow("unrelated fixture warning");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exhausts composition cleanup once and reopens the same database after transport failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-close-composition-"));
    try {
      await expect(runAuthorityUtility({ directory, closeCleanupProbe: true })).resolves.toEqual({
        type: "close-cleanup-probed",
        samePromise: true,
        aggregate: true,
        closeCounts: { transport: 1, runtime: 1, snapshots: 1, worker: 1 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a mutated cached record instead of echoing the authority checksum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-cache-mutation-"));
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: JsonWebSocketClient | undefined;
    try {
      const roomId = await seedDirectory(directory);
      const started = await spawnAuthorityChild({ directory });
      child = started.child;
      client = await JsonWebSocketClient.connect(started.url);
      await client.login("cache-mutation-login");
      const authority = await repairRecords(client, roomId);
      const mutated = structuredClone(authority.records);
      const messageIndex = mutated.findIndex((record) => record.kind === "timeline-message" &&
        record.value.lifecycle === "active" && record.value.authorKind === "human");
      const message = mutated[messageIndex];
      if (message === undefined || message.kind !== "timeline-message" ||
          message.value.lifecycle !== "active" || message.value.authorKind !== "human") {
        throw new TypeError("Mutation fixture has no message");
      }
      mutated[messageIndex] = {
        kind: "timeline-message",
        value: {
          ...message.value,
          currentRevision: {
            ...message.value.currentRevision,
            body: "mutated after transport",
          },
        },
      };
      const cache = new MemoryAuthorityCache();
      const snapshotId = "mutated-snapshot";
      cache.beginRoom(roomId, snapshotId);
      cache.stageRoomPage({
        type: "room.repair.page",
        requestId: "mutated-page",
        snapshotId,
        roomId,
        page: 0,
        records: mutated,
        watermark: authority.watermark,
        snapshotChecksum: authority.checksum,
        hasMore: false,
        mode: "materialized",
        expiresAt: "2026-08-12T23:59:59.000Z",
      });
      await expect(cache.finalizeRoom(snapshotId, authority.checksum)).resolves.toBe(false);
    } finally {
      client?.close();
      if (child !== undefined) await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts the compiled child from one closed JSON-line command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-authority-child-"));
    const fixturePath = join(
      process.cwd(),
      "packages/server/dist/fixtures/authority-child.js",
    );
    const child = spawn(process.execPath, [fixturePath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      child.stdin.end(`${JSON.stringify({
        type: "start",
        databasePath: join(directory, "authority.sqlite"),
        snapshotCachePath: join(directory, "snapshot-cache.sqlite"),
        actors: [
          {
            id: "human-a",
            kind: "human",
            displayName: "Human A",
            reachability: "online",
          },
        ],
        identity: {
          accountId: "account-a",
          actorId: "human-a",
          secret: "test-secret",
        },
        invitationSecretKey: Buffer.alloc(32, 7).toString("base64url"),
      })}\n`);

      await expect(waitForJsonLine(child)).resolves.toMatchObject({
        type: "ready",
        url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      });
    } finally {
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads every authoritative fact from a fresh child after normal process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-authority-restart-"));
    let first: ChildProcessWithoutNullStreams | undefined;
    let second: ChildProcessWithoutNullStreams | undefined;
    let client: JsonWebSocketClient | undefined;
    try {
      const seeded = await spawnAuthorityChild({ directory, seedAllFacts: true });
      first = seeded.child;
      client = await JsonWebSocketClient.connect(seeded.url);
      await client.login("seed-readback-login");
      const seededRoomId = await discoverRoom(client);
      await waitForRouteJudgmentCount(directory, seededRoomId, 2);
      const seededSnapshot = await repairRecords(client, seededRoomId);
      client.close();
      await stopChild(first);
      await unlink(join(directory, "snapshot-cache.sqlite")).catch(() => undefined);

      const restarted = await spawnAuthorityChild({ directory, readbackOnly: true });
      second = restarted.child;
      client = await JsonWebSocketClient.connect(restarted.url);
      await client.login();
      const roomId = await discoverRoom(client);
      const snapshot = await repairRecords(client, roomId);
      const kinds = snapshot.records.map((record) => record.kind);

      expect(kinds).toEqual(expect.arrayContaining([
        "room",
        "membership",
        "timeline-message",
        "human-read",
        "agent-judgement",
        "open-item",
        "agent-execution",
        "calibration",
      ]));
      expect(snapshot.records.filter((record) => record.kind === "membership")).toHaveLength(2);
      expect(snapshot.records.filter((record) => record.kind === "timeline-message"))
        .toHaveLength(2);
      for (const [kind, count] of [
        ["room", 1],
        ["membership", 2],
        ["timeline-message", 2],
        ["human-read", 1],
        ["agent-judgement", 1],
        ["open-item", 1],
        ["agent-execution", 1],
        ["calibration", 1],
      ] as const) {
        const restored = snapshot.records.filter((record) => record.kind === kind);
        const seededFacts = seededSnapshot.records.filter((record) => record.kind === kind);
        expect(restored).toHaveLength(count);
        expect(restored).toEqual(seededFacts);
      }
      expect(snapshot.watermark).toBeGreaterThanOrEqual(9);
      expect(roomId).toBe(seededRoomId);
      expect(snapshot).toEqual(seededSnapshot);
      expect((await inspectAuthority(directory)).actors).toEqual([
        actors[1],
        actors[0],
      ]);
    } finally {
      client?.close();
      if (first !== undefined) await stopChild(first);
      if (second !== undefined) await stopChild(second);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists OpenItem and explicit LightTask through WebSocket replay, multi-client repair, and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-open-item-restart-"));
    let first: ChildProcessWithoutNullStreams | undefined;
    let second: ChildProcessWithoutNullStreams | undefined;
    let client: JsonWebSocketClient | undefined;
    let peer: JsonWebSocketClient | undefined;
    try {
      const seeded = await spawnAuthorityChild({ directory, seedAllFacts: true });
      first = seeded.child;
      client = await JsonWebSocketClient.connect(seeded.url);
      await client.login("open-item-login");
      const roomId = await discoverRoom(client);
      const before = await repairRecords(client, roomId);
      const source = before.records.find((record) =>
        record.kind === "timeline-message" && record.value.lifecycle === "active" &&
        record.value.authorKind === "human");
      if (source?.kind !== "timeline-message" || source.value.lifecycle !== "active" ||
          source.value.authorKind !== "human") throw new Error("missing human source message");
      const create = {
        type: "open-item.create" as const,
        requestId: "open-item-create",
        roomId,
        creationKind: "human_mention" as const,
        sourceMessageId: source.value.id,
        targetActorId: "human-a",
        content: "Please close this authoritative request",
      };
      const firstAck = await client.request(create, "open-item.ack");
      if (firstAck.type !== "open-item.ack") throw new Error("wrong OpenItem acknowledgement");
      const replayAck = await client.request(
        { ...create, requestId: "open-item-create-replay" },
        "open-item.ack",
      );
      expect(replayAck).toMatchObject({
        type: "open-item.ack",
        item: { id: firstAck.item.id, status: "awaiting", currentOwnerId: "human-a" },
      });
      const answered = await client.request({
        type: "open-item.transition", requestId: "open-item-answer", roomId,
        itemId: firstAck.item.id, action: "answer",
      }, "open-item.ack");
      expect(answered).toMatchObject({
        type: "open-item.ack", item: { id: firstAck.item.id, status: "answered", currentOwnerId: null },
      });
      await expect(client.request({
        type: "open-item.transition", requestId: "open-item-terminal-conflict", roomId,
        itemId: firstAck.item.id, action: "defer", reason: "too late",
      }, "open-item.ack")).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
      const taskCreate = {
        type: "light-task.create" as const,
        requestId: "light-task-create-stable",
        roomId,
        sourceMessageId: source.value.id,
        title: "Persist explicit commitment",
        verifierRole: "owner" as const,
        criteria: [{ id: "criterion-review", text: "Review is complete" }],
      };
      const taskAck = await client.request(taskCreate, "light-task.ack");
      if (taskAck.type !== "light-task.ack") throw new Error("wrong LightTask acknowledgement");
      const taskReplay = await client.request(taskCreate, "light-task.ack");
      expect(taskReplay).toMatchObject({
        type: "light-task.ack",
        task: { id: taskAck.task.id, status: "todo", claimant: null },
      });
      const claimedTask = await client.request({
        type: "light-task.transition", requestId: "light-task-claim-ball", roomId,
        taskId: taskAck.task.id, action: "claim",
      }, "light-task.ack");
      expect(claimedTask).toMatchObject({
        type: "light-task.ack", task: { id: taskAck.task.id, status: "claimed", claimant: "human-a" },
      });
      const firstBalls = await client.request({
        type: "ball.query", requestId: "ball-query-first", roomId,
      }, "ball.query.result");
      expect(firstBalls).toMatchObject({
        type: "ball.query.result",
        balls: expect.arrayContaining([expect.objectContaining({
          sourceKind: "light-task", sourceId: taskAck.task.id, holderId: "human-a",
        })]),
        needsAction: expect.arrayContaining([expect.objectContaining({ actorId: "human-a", overdue: false })]),
      });
      peer = await JsonWebSocketClient.connect(seeded.url);
      await peer.login("light-task-peer-login");
      const peerRepair = await repairRecords(peer, roomId);
      expect(peerRepair.records.filter((record) =>
        record.kind === "light-task" && record.value.id === taskAck.task.id)).toEqual([
        expect.objectContaining({ kind: "light-task", value: expect.objectContaining({
          status: "claimed", claimant: "human-a",
          criteria: [{ id: "criterion-review", text: "Review is complete", met: false }],
        }) }),
      ]);
      const peerBalls = await peer.request({
        type: "ball.query", requestId: "ball-query-peer", roomId,
      }, "ball.query.result");
      expect(peerBalls).toMatchObject({
        balls: expect.arrayContaining([expect.objectContaining({ sourceId: taskAck.task.id, holderId: "human-a" })]),
      });
      peer.close();
      peer = undefined;
      const current = await repairRecords(client, roomId);
      expect(current.records.filter((record) =>
        record.kind === "open-item" && record.value.id === firstAck.item.id)).toEqual([
        expect.objectContaining({ kind: "open-item", value: expect.objectContaining({ status: "answered" }) }),
      ]);
      client.close();
      await stopChild(first);
      first = undefined;
      await unlink(join(directory, "snapshot-cache.sqlite")).catch(() => undefined);

      const restarted = await spawnAuthorityChild({ directory, readbackOnly: true });
      second = restarted.child;
      client = await JsonWebSocketClient.connect(restarted.url);
      await client.login("open-item-restart-login");
      const repaired = await repairRecords(client, roomId);
      expect(repaired.records.filter((record) =>
        record.kind === "open-item" && record.value.id === firstAck.item.id)).toHaveLength(1);
      expect(repaired.records.filter((record) =>
        record.kind === "light-task" && record.value.id === taskAck.task.id)).toHaveLength(1);
      const restartedBalls = await client.request({
        type: "ball.query", requestId: "ball-query-restarted", roomId,
      }, "ball.query.result");
      expect(restartedBalls).toMatchObject({
        balls: expect.arrayContaining([expect.objectContaining({ sourceId: taskAck.task.id, holderId: "human-a" })]),
        needsAction: expect.arrayContaining([expect.objectContaining({ actorId: "human-a" })]),
      });
      const database = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.open_item.changed' AND payload_json LIKE ?",
      ).get(`%${firstAck.item.id}%`)).toEqual({ count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM open_items WHERE id = ?")
        .get(firstAck.item.id)).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM light_tasks WHERE id = ?")
        .get(taskAck.task.id)).toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.light_task.changed' AND payload_json LIKE ?",
      ).get(`%${taskAck.task.id}%`)).toEqual({ count: 2 });
      database.close();
    } finally {
      client?.close();
      peer?.close();
      if (first !== undefined) await stopChild(first);
      if (second !== undefined) await stopChild(second);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drives the production Desktop entry through IPC, AuthorityWorker, SQLite, and stable Room events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-desktop-governance-"));
    let started: Awaited<ReturnType<typeof spawnAuthorityChild>> | undefined;
    let bootstrapClient: JsonWebSocketClient | undefined;
    let runtime: ReturnType<typeof createDesktopGovernanceRuntime> | undefined;
    let unregisterIpc: (() => void) | undefined;
    let unmountRenderer: (() => void) | undefined;
    try {
      started = await spawnAuthorityChild({ directory, seedGovernanceRoom: true });
      bootstrapClient = await JsonWebSocketClient.connect(started.url);
      const issued = await bootstrapClient.issueSession("desktop-governance-login");
      const roomId = await discoverRoom(bootstrapClient);

      let requestSequence = 0;
      const governanceFrames: string[] = [];
      runtime = createDesktopGovernanceRuntime({
        endpoint: started.url,
        session: () => ({
          actorId: issued.actorId,
          sessionId: issued.sessionId,
          accessToken: issued.accessToken,
          expiresAt: issued.expiresAt,
        }),
        webSocketFactory: (endpoint) => {
          const socket = new WebSocket(endpoint);
          socket.on("message", (raw) => governanceFrames.push(raw.toString("utf8")));
          return socket as unknown as GovernanceWebSocketLike;
        },
        createRequestIdentity: () => {
          const sequence = ++requestSequence;
          return {
            requestId: `desktop-governance-${sequence}`,
            idempotencyKey: `desktop-governance-key-${sequence}`,
          };
        },
        timeoutMs: 5_000,
      });

      type IpcHandler = (
        event: { readonly sender: unknown; readonly senderFrame: unknown },
        ...args: unknown[]
      ) => unknown;
      const handlers = new Map<string, IpcHandler>();
      const rendererListeners = new Map<string, Set<(event: unknown, value: unknown) => void>>();
      const rendererTraffic: unknown[] = [];
      const trustedFrame = Object.freeze({ kind: "main-frame" });
      const webContents: GovernanceIpcWebContents = {
        mainFrame: trustedFrame,
        isDestroyed: () => false,
        send(channel, state) {
          rendererTraffic.push({ direction: "main-to-renderer", channel, state });
          for (const listener of rendererListeners.get(channel) ?? []) listener({}, state);
        },
      };
      const ipcMain: GovernanceIpcMain = {
        handle(channel, handler) {
          if (handlers.has(channel)) throw new TypeError("duplicate Governance IPC handler");
          handlers.set(channel, handler);
        },
        removeHandler(channel) {
          handlers.delete(channel);
        },
      };
      const ipcRenderer: GovernanceIpcRenderer = {
        async invoke(channel, ...args) {
          rendererTraffic.push({ direction: "renderer-to-main", channel, args });
          const handler = handlers.get(channel);
          if (handler === undefined) throw new TypeError("Governance IPC handler is absent");
          return await handler({ sender: webContents, senderFrame: trustedFrame }, ...args);
        },
        on(channel, listener) {
          const listeners = rendererListeners.get(channel) ?? new Set();
          listeners.add(listener);
          rendererListeners.set(channel, listeners);
        },
        removeListener(channel, listener) {
          rendererListeners.get(channel)?.delete(listener);
        },
      };
      unregisterIpc = registerGovernanceIpc({
        ipcMain,
        webContents,
        controller: runtime.controller,
      });
      const bridge = createGovernanceBridge(ipcRenderer);
      const root = document.createElement("main");
      document.body.replaceChildren(root);
      unmountRenderer = mountDesktopRendererEntry(
        root,
        `?governance-room=${encodeURIComponent(roomId)}`,
        undefined,
        bridge,
      );

      expect(root.dataset.governanceRouteContract).toBe("closed-v1");
      await vi.waitFor(() => {
        const archive = root.querySelector<HTMLButtonElement>("[data-archive-room]");
        const evidence = `${root.innerHTML}\n${governanceFrames.join("\n")}`;
        expect(archive, evidence).not.toBeNull();
        expect(archive!.disabled, evidence).toBe(false);
      }, { timeout: 10_000, interval: 20 });

      root.querySelector<HTMLButtonElement>("[data-archive-room]")!.click();
      root.querySelector<HTMLButtonElement>("[data-action='confirm-archive']")!.click();
      await vi.waitFor(() => {
        const evidence = `${root.innerHTML}\n${governanceFrames.join("\n")}`;
        expect(root.querySelector("[data-archived-banner]"), evidence).not.toBeNull();
        expect(root.querySelector("[data-governance-success]")?.textContent, evidence)
          .toContain("归档成功");
      }, { timeout: 10_000, interval: 20 });
      expect(runtime.cache.governanceProjection(roomId)).toMatchObject({
        lifecycle: "archived", governanceRevision: 2, archiveGeneration: 1,
      });

      root.querySelector<HTMLButtonElement>("[data-action='reopen-room']")!.click();
      await vi.waitFor(() => {
        expect(root.querySelector("[data-archived-banner]")).toBeNull();
        expect(root.querySelector("[data-governance-success]")?.textContent).toContain("重开成功");
      }, { timeout: 10_000, interval: 20 });
      expect(runtime.cache.governanceProjection(roomId)).toMatchObject({
        lifecycle: "active", governanceRevision: 3, archiveGeneration: 1,
      });

      const database = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
      try {
        expect(database.prepare(
          `SELECT status, governance_revision AS governanceRevision,
                  archive_generation AS archiveGeneration, archived_at AS archivedAt
             FROM rooms WHERE id = ?`,
        ).get(roomId)).toEqual({
          status: "active", governanceRevision: 3, archiveGeneration: 1, archivedAt: null,
        });
        expect(database.prepare(
          `SELECT type, result FROM room_audit
            WHERE room_id = ? AND type IN ('room.archived', 'room.reopened')
            ORDER BY rowid`,
        ).all(roomId)).toEqual([
          { type: "room.archived", result: "archived" },
          { type: "room.reopened", result: "reopened" },
        ]);
        expect(database.prepare(
          `SELECT event_type AS eventType FROM events
            WHERE room_id = ? AND event_type IN (
              'room.archived', 'room.security.reduced', 'room.reopened'
            ) ORDER BY stream_seq`,
        ).all(roomId)).toEqual([
          { eventType: "room.archived" },
          { eventType: "room.security.reduced" },
          { eventType: "room.reopened" },
        ]);
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM outbox_deliveries
            WHERE event_id IN (
              SELECT event_id FROM events WHERE room_id = ? AND event_type IN (
                'room.archived', 'room.security.reduced', 'room.reopened'
              )
            ) AND status = 'dispatched'`,
        ).get(roomId)).toEqual({ count: 3 });
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM idempotency_records
            WHERE key IN ('desktop-governance-key-1', 'desktop-governance-key-2')`,
        ).get()).toEqual({ count: 2 });
      } finally {
        database.close();
      }

      expect(rendererTraffic.some((entry) => JSON.stringify(entry).includes("governance:get-surface")))
        .toBe(true);
      expect(rendererTraffic.some((entry) => JSON.stringify(entry).includes("governance:submit")))
        .toBe(true);
      const serializedRendererBoundary = JSON.stringify(rendererTraffic);
      expect(serializedRendererBoundary).not.toContain(issued.accessToken);
      expect(root.textContent).not.toContain(issued.accessToken);
      expect(Object.keys(bridge)).toEqual([
        "getSurface", "getDepartureConflicts", "submit", "onStateChanged",
      ]);
    } finally {
      unmountRenderer?.();
      unregisterIpc?.();
      runtime?.close();
      bootstrapClient?.close();
      document.body.replaceChildren();
      if (started !== undefined) await stopChild(started.child);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs governance across crash boundaries, restart, three clients, CAS races, and removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-governance-process-"));
    const governanceActors = [
      actors[0], actors[1],
      { id: "human-b", kind: "human", displayName: "Human B", reachability: "online" },
      { id: "human-c", kind: "human", displayName: "Human C", reachability: "online" },
      { id: "human-d", kind: "human", displayName: "Human D", reachability: "online" },
    ] satisfies readonly Actor[];
    const identities = [
      { accountId: "account-a", actorId: "human-a", secret: "test-secret" },
      { accountId: "account-b", actorId: "human-b", secret: "test-secret-b" },
      { accountId: "account-c", actorId: "human-c", secret: "test-secret-c" },
    ] as const;
    const children: ChildProcessWithoutNullStreams[] = [];
    const clients: JsonWebSocketClient[] = [];
    try {
      const seeded = await spawnAuthorityChild({
        directory, actors: governanceActors, identities, seedGovernanceRoom: true,
      });
      children.push(seeded.child);
      const seedClient = await JsonWebSocketClient.connect(seeded.url);
      clients.push(seedClient);
      await seedClient.login("governance-seed-login");
      const roomId = await discoverRoom(seedClient);
      seedClient.close();
      await stopChild(seeded.child);

      const setup = new DatabaseSync(join(directory, "authority.sqlite"));
      setup.exec("BEGIN IMMEDIATE");
      try {
        const insertMembership = setup.prepare(
          `INSERT INTO room_memberships (
             room_id, actor_id, kind, role, participation, tool_permissions_json,
             joined_at, configured_at, access_revision
           ) VALUES (?, ?, 'human', ?, NULL, '[]', ?, NULL, 0)`,
        );
        insertMembership.run(roomId, "human-b", "member", "2026-08-19T00:00:00.000Z");
        insertMembership.run(roomId, "human-c", "admin", "2026-08-19T00:00:01.000Z");
        insertMembership.run(roomId, "human-d", "member", "2026-08-19T00:00:02.000Z");
        setup.prepare(
          `INSERT INTO project_next_actions (
             id, room_id, source_room_id, source_id, revision, owner_kind,
             owner_actor_id, verifier_human_actor_id, status
           ) VALUES (?, ?, ?, ?, 1, 'human', 'human-c', NULL, 'in_progress')`,
        ).run("governance-conflict-action", roomId, roomId, "governance-source");
        setup.exec("COMMIT");
      } catch (error: unknown) {
        setup.exec("ROLLBACK");
        throw error;
      } finally {
        setup.close();
      }

      for (const [faultPoint, expectedExit, key] of [
        ["after-domain-write", 81, "archive-before-commit"],
        ["after-commit-before-outbox", 83, "archive-ack-lost"],
      ] as const) {
        const faulted = await spawnAuthorityChild({
          directory, actors: governanceActors, identities, faultPoint,
        });
        children.push(faulted.child);
        const faultClient = await JsonWebSocketClient.connect(faulted.url);
        clients.push(faultClient);
        await faultClient.login(`${key}-login`);
        faultClient.send({
          type: "room.archive", requestId: key, roomId,
          expectedGovernanceRevision: 1, idempotencyKey: key,
        });
        let exitCode: number | null;
        try {
          exitCode = await childExit(faulted.child, 5_000);
        } catch (error: unknown) {
          throw new Error(
            `Governance fault did not terminate: ${JSON.stringify(faultClient.frames())}`,
            { cause: error },
          );
        }
        expect(exitCode).toBe(expectedExit);
        const inspected = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
        const room = inspected.prepare(
          "SELECT status, governance_revision AS governanceRevision FROM rooms WHERE id = ?",
        ).get(roomId);
        if (faultPoint === "after-domain-write") {
          expect(room).toEqual({ status: "active", governanceRevision: 1 });
          expect(inspected.prepare(
            "SELECT COUNT(*) AS count FROM idempotency_records WHERE key = ?",
          ).get(key)).toEqual({ count: 0 });
        } else {
          expect(room).toEqual({ status: "archived", governanceRevision: 2 });
          expect(inspected.prepare(
            "SELECT COUNT(*) AS count FROM room_audit WHERE type = 'room.archived'",
          ).get()).toEqual({ count: 1 });
        }
        inspected.close();
      }

      const committed = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
      const archivedEventIds = committed.prepare(
        `SELECT event_id AS eventId FROM events
         WHERE room_id = ? AND event_type IN ('room.archived', 'room.security.reduced')
         ORDER BY stream_seq`,
      ).all(roomId).map((row) => String(row.eventId));
      committed.close();
      expect(archivedEventIds).toHaveLength(2);

      const restarted = await spawnAuthorityChild({
        directory, actors: governanceActors, identities,
      });
      children.push(restarted.child);
      const [owner, ownerPeer, member, admin] = await Promise.all([
        JsonWebSocketClient.connect(restarted.url), JsonWebSocketClient.connect(restarted.url),
        JsonWebSocketClient.connect(restarted.url), JsonWebSocketClient.connect(restarted.url),
      ]);
      clients.push(owner, ownerPeer, member, admin);
      await Promise.all([
        owner.login("owner-login", identities[0]),
        ownerPeer.login("owner-peer-login", identities[0]),
        member.login("member-login", identities[1]),
        admin.login("admin-login", identities[2]),
      ]);
      await expect(owner.request({
        type: "room.archive", requestId: "archive-replay", roomId,
        expectedGovernanceRevision: 1, idempotencyKey: "archive-ack-lost",
      }, "room.governance.ack")).resolves.toMatchObject({
        type: "room.governance.ack", eventIds: archivedEventIds, replayed: true,
        governance: { lifecycle: "archived", governanceRevision: 2, archiveGeneration: 1 },
      });
      const conflictResult = await admin.request({
        type: "room.departure.conflicts", requestId: "conflicts", roomId,
        targetActorId: "human-c",
      }, "room.departure.conflicts.result");
      expect(conflictResult).toMatchObject({
        conflicts: {
          roomId, targetActorId: "human-c",
          conflicts: [expect.objectContaining({ kind: "next_action", revision: 1 })],
        },
      });

      const head = readRoomHeadSeq(directory, roomId);
      for (const [index, client] of [owner, member, admin].entries()) {
        await client.request({
          type: "room.subscribe.v2", requestId: `governance-subscribe-${index}`, roomId,
          cursor: { version: 1, roomId, afterSeq: head },
        }, "room.subscribed.v2");
      }
      await expect(owner.request({
        type: "room.reopen", requestId: "reopen", roomId,
        expectedGovernanceRevision: 2, idempotencyKey: "reopen",
      }, "room.governance.ack")).resolves.toMatchObject({
        eventIds: [expect.any(String)], replayed: false,
        governance: { lifecycle: "active", governanceRevision: 3, archiveGeneration: 1 },
      });
      for (const client of [owner, member, admin]) {
        await client.waitFor((frame) => frame.type === "room.event" &&
          frame.event.type === "room.reopened" && frame.event.roomId === roomId);
      }

      const raced = await Promise.allSettled([
        owner.request({
          type: "room.member.remove", requestId: "remove-d-one", roomId,
          targetActorId: "human-d", expectedGovernanceRevision: 3,
          idempotencyKey: "remove-d-one",
        }, "room.governance.ack"),
        ownerPeer.request({
          type: "room.member.remove", requestId: "remove-d-two", roomId,
          targetActorId: "human-d", expectedGovernanceRevision: 3,
          idempotencyKey: "remove-d-two",
        }, "room.governance.ack"),
      ]);
      expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(raced.find((result) => result.status === "rejected")).toMatchObject({
        status: "rejected", reason: { status: 409, code: "room_revision_conflict" },
      });

      const leave = {
        type: "room.member.leave" as const, requestId: "member-leave", roomId,
        expectedGovernanceRevision: 4, idempotencyKey: "member-leave",
      };
      const left = await member.request(leave, "room.governance.ack");
      expect(left).toMatchObject({ eventIds: [expect.any(String)], replayed: false,
        governance: { governanceRevision: 5 } });
      await expect(member.request({
        type: "room.governance.get", requestId: "removed-read", roomId,
      }, "room.governance")).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
      await expect(member.request({ ...leave, requestId: "member-leave-replay" },
        "room.governance.ack")).resolves.toMatchObject({
        eventIds: left.type === "room.governance.ack" ? left.eventIds : [], replayed: true,
      });

      const beforeBlocked = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
      const blockedCounts = beforeBlocked.prepare(
        `SELECT (SELECT governance_revision FROM rooms WHERE id = ?) AS revision,
                (SELECT COUNT(*) FROM room_audit) AS audits,
                (SELECT COUNT(*) FROM events) AS events,
                (SELECT COUNT(*) FROM outbox_deliveries) AS outbox,
                (SELECT COUNT(*) FROM idempotency_records) AS receipts`,
      ).get(roomId);
      beforeBlocked.close();
      admin.send({
        type: "room.member.leave", requestId: "blocked-admin-leave", roomId,
        expectedGovernanceRevision: 5, idempotencyKey: "blocked-admin-leave",
      });
      await expect(admin.waitFor((frame) => frame.type === "error" &&
        frame.requestId === "blocked-admin-leave")).resolves.toMatchObject({
        status: 409, code: "departure_blocked",
        details: { roomId, targetActorId: "human-c",
          conflicts: [expect.objectContaining({ kind: "next_action" })] },
      });
      const afterBlocked = new DatabaseSync(join(directory, "authority.sqlite"), { readOnly: true });
      expect(afterBlocked.prepare(
        `SELECT (SELECT governance_revision FROM rooms WHERE id = ?) AS revision,
                (SELECT COUNT(*) FROM room_audit) AS audits,
                (SELECT COUNT(*) FROM events) AS events,
                (SELECT COUNT(*) FROM outbox_deliveries) AS outbox,
                (SELECT COUNT(*) FROM idempotency_records) AS receipts`,
      ).get(roomId)).toEqual(blockedCounts);
      expect(afterBlocked.prepare(
        "SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND actor_id = 'human-c'",
      ).get(roomId)).toEqual({ count: 1 });
      afterBlocked.close();
    } finally {
      for (const client of clients) client.close();
      for (const child of children) await stopChild(child).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  for (const [faultPoint, expectedExit] of [
    ["after-domain-write", 81],
    ["before-commit", 82],
  ] as const) {
    it(`${faultPoint} crashes inside the real transaction and leaves zero rows`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `native-im-${faultPoint}-`));
      let faulted: ChildProcessWithoutNullStreams | undefined;
      let restarted: ChildProcessWithoutNullStreams | undefined;
      let client: JsonWebSocketClient | undefined;
      try {
        const roomId = await seedDirectory(directory);
        const started = await spawnAuthorityChild({ directory, faultPoint });
        faulted = started.child;
        client = await JsonWebSocketClient.connect(started.url);
        await client.login("fault-login");
        const messageId = `message-${faultPoint}`;
        sendMessage(client, roomId, messageId);

        await expect(childExit(faulted)).resolves.toBe(expectedExit);
        expect(unexpectedChildStderr(faulted)).toBe("");
        expect(client.frames().some((frame) =>
          frame.type === "message.accepted" && frame.messageId === messageId)).toBe(false);

        const replacement = await spawnAuthorityChild({ directory });
        restarted = replacement.child;
        expect(await commandRowCounts(directory, messageId)).toEqual({
          messages: 0,
          events: 0,
          idempotency: 0,
          outbox: 0,
          eventIds: [],
        });
      } finally {
        client?.close();
        if (faulted !== undefined) await stopChild(faulted);
        if (restarted !== undefined) await stopChild(restarted);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("recovers one stable event after commit-before-outbox and replaying the same key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-after-commit-"));
    let faulted: ChildProcessWithoutNullStreams | undefined;
    let restarted: ChildProcessWithoutNullStreams | undefined;
    let client: JsonWebSocketClient | undefined;
    let replica: ReturnType<typeof createClientSyncReplica> | undefined;
    try {
      const roomId = await seedDirectory(directory);
      const started = await spawnAuthorityChild({
        directory,
        faultPoint: "after-commit-before-outbox",
      });
      faulted = started.child;
      client = await JsonWebSocketClient.connect(started.url);
      await client.login("commit-fault-login");
      const transport = new WebSocketSyncTransport(client);
      const cache = new MemoryAuthorityCache();
      replica = createClientSyncReplica({ transport, cache });
      await replica.restoreWorkspace();
      const recoveryCursor = cache.roomCursor(roomId)!;
      const messageId = "message-after-commit-before-outbox";
      sendMessage(client, roomId, messageId);

      await expect(childExit(faulted)).resolves.toBe(83);
      expect(unexpectedChildStderr(faulted)).toBe("");
      expect(client.frames().some((frame) =>
        frame.type === "message.accepted" && frame.messageId === messageId)).toBe(false);
      const committed = await commandRowCounts(directory, messageId);
      expect(committed).toMatchObject({ messages: 1, events: 1, idempotency: 1, outbox: 1 });

      const replacement = await spawnAuthorityChild({ directory });
      restarted = replacement.child;
      client = await JsonWebSocketClient.connect(replacement.url);
      await client.login("commit-retry-login");
      transport.replaceClient(client);
      await transport.resume(recoveryCursor);
      expect(cache.appliedEventIds.filter((eventId) => eventId === committed.eventIds[0]))
        .toHaveLength(1);
      const accepted = client.request({
        type: "message.send",
        requestId: "commit-retry",
        message: {
          id: messageId,
          roomId,
          body: `durable ${messageId}`,
          sentAt: "2026-08-12T10:00:00.000Z",
        },
      }, "message.accepted");
      await expect(accepted).resolves.toMatchObject({
        type: "message.accepted",
        requestId: "commit-retry",
        messageId,
      });
      expect(await commandRowCounts(directory, messageId)).toEqual(committed);
    } finally {
      replica?.close();
      client?.close();
      if (faulted !== undefined) await stopChild(faulted);
      if (restarted !== undefined) await stopChild(restarted);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays after send-before-dispatch-mark with one replica-visible event ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-after-send-"));
    let faulted: ChildProcessWithoutNullStreams | undefined;
    let restarted: ChildProcessWithoutNullStreams | undefined;
    let sender: JsonWebSocketClient | undefined;
    let receiver: JsonWebSocketClient | undefined;
    let replica: ReturnType<typeof createClientSyncReplica> | undefined;
    try {
      const roomId = await seedDirectory(directory);
      const baseline = await spawnAuthorityChild({ directory });
      receiver = await JsonWebSocketClient.connect(baseline.url);
      await receiver.login("baseline-login");
      const transport = new WebSocketSyncTransport(receiver);
      const cache = new MemoryAuthorityCache();
      replica = createClientSyncReplica({ transport, cache });
      await replica.restoreWorkspace();
      const cursor = cache.roomCursor(roomId)!;
      receiver.close();
      await stopChild(baseline.child);

      const started = await spawnAuthorityChild({
        directory,
        faultPoint: "after-send-before-dispatch-mark",
      });
      faulted = started.child;
      receiver = await JsonWebSocketClient.connect(started.url);
      sender = await JsonWebSocketClient.connect(started.url);
      await receiver.login("receiver-login");
      await sender.login("sender-login");
      transport.replaceClient(receiver);
      await transport.resume(cursor);
      const messageId = "message-after-send-before-mark";
      const live = receiver.waitFor((frame) => frame.type === "room.event" &&
        frame.event.type === "room.message.accepted" && frame.event.payload.id === messageId);
      sendMessage(sender, roomId, messageId);

      const [liveFrame, exitCode] = await Promise.all([live, childExit(faulted, 5_000)]);
      expect(exitCode).toBe(84);
      expect(unexpectedChildStderr(faulted)).toBe("");
      if (liveFrame.type !== "room.event") throw new TypeError("wrong live frame");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const stableEventId = (await commandRowCounts(
        directory,
        messageId,
      )).eventIds[0]!;
      expect(liveFrame.event.eventId).toBe(stableEventId);
      expect(cache.eventIds.has(stableEventId)).toBe(true);

      const replacement = await spawnAuthorityChild({ directory });
      restarted = replacement.child;
      receiver = await JsonWebSocketClient.connect(replacement.url);
      await receiver.login("receiver-restart-login");
      transport.replaceClient(receiver);
      await transport.resume(cursor);
      expect(cache.appliedEventIds.filter((eventId) => eventId === stableEventId)).toHaveLength(1);
      expect(await commandRowCounts(directory, messageId)).toMatchObject({
        messages: 1,
        events: 1,
        idempotency: 1,
        outbox: 1,
        eventIds: [stableEventId],
      });
    } finally {
      replica?.close();
      sender?.close();
      receiver?.close();
      if (faulted !== undefined) await stopChild(faulted);
      if (restarted !== undefined) await stopChild(restarted);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores three independent replicas across live, retained, expired, and clear-cache paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-three-replicas-"));
    let child: ChildProcessWithoutNullStreams | undefined;
    const clients: JsonWebSocketClient[] = [];
    try {
      const roomId = await seedDirectory(directory);
      await compactRoomStream(directory, roomId, 2);

      const started = await spawnAuthorityChild({ directory });
      child = started.child;
      const [clientA, clientB, clientC] = await Promise.all([
        JsonWebSocketClient.connect(started.url),
        JsonWebSocketClient.connect(started.url),
        JsonWebSocketClient.connect(started.url),
      ]);
      clients.push(clientA, clientB, clientC);
      const sharedAccessToken = await clientA.login("replica-a-login");
      await Promise.all([
        clientB.resume(sharedAccessToken, "replica-b-resume"),
        clientC.resume(sharedAccessToken, "replica-c-resume"),
      ]);

      const transportA = new WebSocketSyncTransport(clientA);
      const transportB = new WebSocketSyncTransport(clientB);
      const transportC = new WebSocketSyncTransport(clientC);
      const cacheA = new MemoryAuthorityCache();
      const cacheB = new MemoryAuthorityCache();
      const cacheC = new MemoryAuthorityCache();
      const replicaA = createClientSyncReplica({ transport: transportA, cache: cacheA });
      const replicaB = createClientSyncReplica({ transport: transportB, cache: cacheB });
      const replicaC = createClientSyncReplica({ transport: transportC, cache: cacheC });

      const expired = await transportC.syncRoom({
        type: "room.sync",
        requestId: "expired-cursor-proof",
        roomId,
        cursor: { version: 1, roomId, afterSeq: 0 },
      });
      expect(expired).toMatchObject({
        mode: "repair_required",
        reason: "cursor_expired",
        retainedFromSeq: 2,
      });
      await Promise.all([
        replicaA.restoreWorkspace(),
        replicaB.restoreWorkspace(),
        replicaC.restoreWorkspace(),
      ]);

      const retainedCursor = cacheB.roomCursor(roomId)!;
      const appliedBeforeMiss = cacheB.appliedEvents.length;
      clientB.terminate();
      const missedIds = ["message-b-missed-1", "message-b-missed-2"];
      for (const messageId of missedIds) {
        await clientA.request({
          type: "message.send",
          requestId: `send-${messageId}`,
          message: {
            id: messageId,
            roomId,
            body: messageId,
            sentAt: "2026-08-12T11:00:00.000Z",
          },
        }, "message.accepted");
      }
      const replacementB = await JsonWebSocketClient.connect(started.url);
      clients.push(replacementB);
      await replacementB.resume(sharedAccessToken, "replica-b-resume-login");
      transportB.replaceClient(replacementB);
      await transportB.resume(retainedCursor);
      expect(cacheB.roomCursor(roomId)!.afterSeq).toBeGreaterThan(retainedCursor.afterSeq);
      const recoveredMissed = cacheB.appliedEvents.slice(appliedBeforeMiss);
      const expectedMissedIds = (await Promise.all(missedIds.map((messageId) =>
        commandRowCounts(directory, messageId))))
        .map((counts) => counts.eventIds[0]!);
      const recoveredMessages = recoveredMissed.filter((event) =>
        event.type === "room.message.accepted" && missedIds.includes(event.payload.id));
      expect(recoveredMessages.map((event) => event.eventId)).toEqual(expectedMissedIds);
      expect(recoveredMessages.every((event) => event.streamSeq > retainedCursor.afterSeq)).toBe(true);
      expect(recoveredMissed.some((event) => event.type.startsWith("route."))).toBe(true);
      expect(new Set(recoveredMissed.map((event) => event.eventId)).size)
        .toBe(recoveredMissed.length);

      await replicaC.clearAndRestore();
      const livePromise = clientA.waitFor((frame) => frame.type === "room.event" &&
        frame.event.type === "room.message.accepted" &&
        frame.event.payload.id === "message-a-live");
      const liveAck = clientA.request({
        type: "message.send",
        requestId: "send-a-live",
        message: {
          id: "message-a-live",
          roomId,
          body: "A stays live",
          sentAt: "2026-08-12T11:01:00.000Z",
        },
      }, "message.accepted");
      const liveFrame = await livePromise;
      await liveAck;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (liveFrame.type !== "room.event") throw new TypeError("wrong live event");
      expect(cacheA.eventIds.has(liveFrame.event.eventId)).toBe(true);

      await Promise.all([
        replicaA.clearAndRestore(),
        replicaB.clearAndRestore(),
        replicaC.clearAndRestore(),
      ]);

      const beforeStress = cacheA.roomSignature(roomId);
      for (const client of clients) client.close();
      await stopChild(child);
      const mixed = await seedMixedRoomRecords(directory, roomId);
      const stress = await spawnAuthorityChild({
        directory,
        forceSnapshotFallback: true,
        snapshotRecordsPerPage: stressPageSize,
      });
      child = stress.child;
      const stressA = await JsonWebSocketClient.connect(stress.url);
      clients.push(stressA);
      const stressAccessToken = await stressA.login("stress-a-login");
      await waitForRouteJudgmentCount(
        directory,
        roomId,
        mixed.mixedCounts["route-judgment"] ?? 0,
      );
      transportA.replaceClient(stressA);
      transportA.beforeStreamingSnapshotComplete = () => {
        expect(cacheA.roomSignature(roomId)).toBe(beforeStress);
      };
      const requestsBeforeA = transportA.roomRepairRequests;
      await replicaA.repairRoom(roomId);
      const stressPagesA = transportA.roomRepairRequests - requestsBeforeA;
      transportA.beforeStreamingSnapshotComplete = undefined;

      stressA.close();
      await stopChild(child);
      const materialized = await spawnAuthorityChild({ directory });
      child = materialized.child;
      const [stressB, stressC] = await Promise.all([
        JsonWebSocketClient.connect(materialized.url),
        JsonWebSocketClient.connect(materialized.url),
      ]);
      clients.push(stressB, stressC);
      await Promise.all([
        stressB.resume(stressAccessToken, "stress-b-resume"),
        stressC.resume(stressAccessToken, "stress-c-resume"),
      ]);
      transportB.replaceClient(stressB);
      transportC.replaceClient(stressC);
      const requestsBeforeB = transportB.roomRepairRequests;
      let releaseMaterializedLastPage!: () => void;
      const materializedLastPageRelease = new Promise<void>((resolve) => {
        releaseMaterializedLastPage = resolve;
      });
      let observeMaterializedLastPage!: () => void;
      const materializedLastPagePaused = new Promise<void>((resolve) => {
        observeMaterializedLastPage = resolve;
      });
      let materializedLastPageObserved = false;
      // The mixed fixture count excludes the singleton governance and Memory status records.
      const expectedRepairTotal = mixed.total + 2;
      transportC.beforeMaterializedLastPageReturn = async (page, receivedRecordCount) => {
        materializedLastPageObserved = true;
        observeMaterializedLastPage();
        expect(page.hasMore).toBe(false);
        expect(receivedRecordCount).toBe(expectedRepairTotal);
        expect(cacheC.factCount(roomId)).toBe(0);
        await materializedLastPageRelease;
      };
      const requestsBeforeC = transportC.roomRepairRequests;
      const materializedRepairs = Promise.all([
        replicaB.repairRoom(roomId), replicaC.clearAndRestore(),
      ]);
      await Promise.race([
        materializedLastPagePaused,
        materializedRepairs.then(() => {
          throw new Error("Materialized repairs completed without observing the final page");
        }),
      ]);
      expect(cacheC.factCount(roomId)).toBe(0);
      expect(cacheC.roomChecksum(roomId)).toBeUndefined();
      releaseMaterializedLastPage();
      await materializedRepairs;
      const stressPagesB = transportB.roomRepairRequests - requestsBeforeB;
      const stressPagesC = transportC.roomRepairRequests - requestsBeforeC;
      transportC.beforeMaterializedLastPageReturn = undefined;
      expect(materializedLastPageObserved).toBe(true);
      expect(transportA.roomRepairModes.at(-1)).toBe("streaming");
      const completeStressPages = Math.ceil(expectedRepairTotal / stressPageSize);
      expect(stressPagesA).toBe(completeStressPages);
      expect([transportB.roomRepairModes.at(-1), transportC.roomRepairModes.at(-1)])
        .toEqual(["materialized", "materialized"]);
      const completeMaterializedPages = Math.ceil(expectedRepairTotal / materializedPageSize);
      expect([stressPagesB, stressPagesC])
        .toEqual([completeMaterializedPages, completeMaterializedPages]);

      expect(mixed.total).toBe(13_509);
      expect(mixed.distinctMembershipActors).toBe(2_000);
      expect(mixed.mixedCounts).toEqual({
        room: 1,
        membership: 2_000,
        "timeline-message": 3_500,
        "message-revision": 3_499,
        "human-read": 1_999,
        "agent-judgement": 500,
        "open-item": 500,
        "agent-execution": 500,
        calibration: 1_000,
        "route-job": 5,
        "route-judgment": 5,
      });
      const authoritativeHeadSeq = readRoomHeadSeq(directory, roomId);
      const authorityChecksum = cacheA.roomChecksum(roomId);
      expect(authorityChecksum).toBeTypeOf("string");
      for (const cache of [cacheA, cacheB, cacheC]) {
        expect(cache.factCount(roomId)).toBe(expectedRepairTotal);
        expect(cache.roomChecksum(roomId)).toBe(authorityChecksum);
        expect(cache.independentRoomChecksum(roomId)).toBe(authorityChecksum);
        expect(cache.roomCursor(roomId)?.afterSeq).toBe(authoritativeHeadSeq);
      }
      expect(cacheB.roomValues(roomId)).toEqual(cacheA.roomValues(roomId));
      expect(cacheC.roomValues(roomId)).toEqual(cacheA.roomValues(roomId));
      expect(cacheB.catalogValues()).toEqual(cacheA.catalogValues());
      expect(cacheC.catalogValues()).toEqual(cacheA.catalogValues());

      replicaA.close();
      replicaB.close();
      replicaC.close();
    } finally {
      for (const client of clients) client.close();
      if (child !== undefined) await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
