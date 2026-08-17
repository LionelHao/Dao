import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, unlink } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer, type Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerFrame } from "./protocol.js";
import {
  createClientSyncReplica,
  type ClientAuthorityCache,
  type RoomSubscriptionObserver,
  type SyncTransport,
} from "../../desktop/src/sync/client-sync-replica.js";
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
const childStderr = new WeakMap<ChildProcessWithoutNullStreams, string>();
const stressPageSize = 50;

interface ChildStartOptions {
  readonly directory: string;
  readonly seedAllFacts?: true;
  readonly forceSnapshotFallback?: true;
  readonly snapshotRecordsPerPage?: number;
  readonly readbackOnly?: true;
  readonly inspectMessageIds?: readonly string[];
  readonly seedMixedRoomId?: string;
  readonly emitUnrelatedWarningForTest?: true;
  readonly closeCleanupProbe?: true;
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
    actors,
    identity: {
      accountId: "account-a",
      actorId: "human-a",
      secret: "test-secret",
    },
    invitationSecretKey: Buffer.alloc(32, 7).toString("base64url"),
    ...(options.seedAllFacts === undefined ? {} : { seedAllFacts: true }),
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
    throw error;
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
        reject(new Error("Timed out waiting for the expected WebSocket frame"));
      }, 2_000);
      this.#waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  request(value: { readonly requestId: string }, type: ServerFrame["type"]): Promise<ServerFrame> {
    const response = this.waitFor((frame) => "requestId" in frame &&
      frame.requestId === value.requestId && (frame.type === type || frame.type === "error"));
    this.send(value);
    return response.then((frame) => {
      if (frame.type === "error") {
        throw Object.assign(new Error(frame.code), {
          code: frame.code,
          status: frame.status,
        });
      }
      return frame;
    });
  }

  async login(requestId = "login"): Promise<string> {
    const frame = await this.request({
      type: "auth.login",
      requestId,
      accountId: "account-a",
      secret: "test-secret",
    }, "auth.authenticated");
    if (frame.type !== "auth.authenticated") throw new TypeError("wrong login frame");
    return frame.accessToken;
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

function recordKey(record: RoomRepairRecord): string {
  const value = record.value as unknown as Record<string, unknown>;
  return `${record.kind}:${String(value.id ?? value.actorId ?? "room")}`;
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
  const first = await client.request({
    type: "room.repair.begin",
    requestId: "repair-begin",
    roomId,
  }, "room.repair.page");
  if (!isRoomRepairPage(first)) throw new TypeError("wrong repair frame");
  const records = [...first.records];
  let page = first;
  while (page.hasMore) {
    const next = await client.request({
      type: "room.repair.page",
      requestId: `repair-page-${page.page}`,
      snapshotId: page.snapshotId,
      afterPage: page.page,
    }, "room.repair.page");
    if (!isRoomRepairPage(next)) throw new TypeError("wrong repair page");
    records.push(...next.records);
    page = next;
  }
  return { records, watermark: first.watermark, checksum: first.snapshotChecksum };
}

async function seedDirectory(directory: string): Promise<string> {
  const started = await spawnAuthorityChild({ directory, seedAllFacts: true });
  const client = await JsonWebSocketClient.connect(started.url);
  try {
    await client.login("seed-login");
    return await discoverRoom(client);
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
    expect(packageRoot).not.toHaveProperty("startAuthoritativeServerForTest");
    expect(packageRoot).not.toHaveProperty(
      "createWorkerDatabaseClientWithTransactionFaultForTest",
    );
    await expect(readFile(join(process.cwd(), "packages/server/dist/index.d.ts"), "utf8"))
      .resolves.not.toContain("startAuthoritativeServerForTest");
    await expect(readFile(join(process.cwd(), "packages/server/dist/index.d.ts"), "utf8"))
      .resolves.not.toContain("createWorkerDatabaseClientWithTransactionFaultForTest");
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
      const message = mutated.find((record) => record.kind === "message");
      if (message === undefined || message.kind !== "message") {
        throw new TypeError("Mutation fixture has no message");
      }
      message.value.body = "mutated after transport";
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
        "message",
        "human-read",
        "agent-judgement",
        "open-item",
        "agent-execution",
        "calibration",
      ]));
      expect(snapshot.records.filter((record) => record.kind === "membership")).toHaveLength(2);
      expect(snapshot.records.filter((record) => record.kind === "message")).toHaveLength(2);
      for (const [kind, count] of [
        ["room", 1],
        ["membership", 2],
        ["message", 2],
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
        record.kind === "message" && record.value.authorKind === "human");
      if (source?.kind !== "message") throw new Error("missing human source message");
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
      peer = await JsonWebSocketClient.connect(seeded.url);
      await peer.login("light-task-peer-login");
      const peerRepair = await repairRecords(peer, roomId);
      expect(peerRepair.records.filter((record) =>
        record.kind === "light-task" && record.value.id === taskAck.task.id)).toEqual([
        expect.objectContaining({ kind: "light-task", value: expect.objectContaining({
          status: "todo", criteria: [{ id: "criterion-review", text: "Review is complete", met: false }],
        }) }),
      ]);
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
      ).get(`%${taskAck.task.id}%`)).toEqual({ count: 1 });
      database.close();
    } finally {
      client?.close();
      peer?.close();
      if (first !== undefined) await stopChild(first);
      if (second !== undefined) await stopChild(second);
      await rm(directory, { recursive: true, force: true });
    }
  });

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

      const [liveFrame, exitCode] = await Promise.all([live, childExit(faulted)]);
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
      transportC.beforeMaterializedLastPageReturn = async (page, receivedRecordCount) => {
        materializedLastPageObserved = true;
        observeMaterializedLastPage();
        expect(page.hasMore).toBe(false);
        expect(receivedRecordCount).toBe(mixed.total);
        expect(cacheC.factCount(roomId)).toBe(0);
        await materializedLastPageRelease;
      };
      const requestsBeforeC = transportC.roomRepairRequests;
      const materializedRepairs = Promise.all([
        replicaB.repairRoom(roomId), replicaC.clearAndRestore(),
      ]);
      await materializedLastPagePaused;
      expect(cacheC.factCount(roomId)).toBe(0);
      expect(cacheC.roomChecksum(roomId)).toBeUndefined();
      releaseMaterializedLastPage();
      await materializedRepairs;
      const stressPagesB = transportB.roomRepairRequests - requestsBeforeB;
      const stressPagesC = transportC.roomRepairRequests - requestsBeforeC;
      transportC.beforeMaterializedLastPageReturn = undefined;
      expect(materializedLastPageObserved).toBe(true);
      expect(transportA.roomRepairModes.at(-1)).toBe("streaming");
      const completeStressPages = Math.ceil(mixed.total / stressPageSize);
      expect(stressPagesA).toBe(completeStressPages);
      expect([transportB.roomRepairModes.at(-1), transportC.roomRepairModes.at(-1)])
        .toEqual(["materialized", "materialized"]);
      expect([stressPagesB, stressPagesC]).toEqual([101, 101]);

      expect(mixed.total).toBe(10_010);
      expect(mixed.distinctMembershipActors).toBe(2_000);
      expect(mixed.mixedCounts).toEqual({
        room: 1,
        membership: 2_000,
        message: 3_500,
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
        expect(cache.factCount(roomId)).toBe(mixed.total);
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
  });
});
