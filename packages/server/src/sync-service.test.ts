import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedRoomEvent, RoomSyncRequest } from "@native-im/core";
import {
  createSyncService,
  ROOM_SYNC_DEFAULT_LIMIT,
  ROOM_SYNC_MAX_LIMIT,
  ROOM_SYNC_MAX_PAGE_BYTES,
} from "./sync-service.js";
import { createSqliteAuthoritativeStore } from "./persistence/sqlite-authoritative-store.js";
import { migrateAuthorityDatabase } from "./persistence/schema.js";
import { createWorkerDatabaseClient } from "./persistence/worker-database-client.js";
import {
  isAuthorityWorkerRequest,
  isAuthorityWorkerResponse,
} from "./persistence/worker-protocol.js";
import type { AuthenticatedSessionContext } from "./persistence/contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function contextFor(suffix: string): AuthenticatedSessionContext {
  return {
    sessionId: tokenHash(`access-${suffix}`),
    sessionFamilyId: tokenHash(`family-${suffix}`),
    principal: { accountId: `account-${suffix}`, actorId: `human-${suffix}` },
  };
}

function roomEvent(roomId: string, streamSeq: number, body = `event-${streamSeq}`): PersistedRoomEvent {
  return {
    eventId: `${roomId}-event-${streamSeq}`,
    streamKind: "room",
    streamId: roomId,
    streamSeq,
    roomId,
    actorId: "human-a",
    occurredAt: new Date(Date.UTC(2026, 7, 11, 0, 0, streamSeq)).toISOString(),
    type: "room.message.accepted",
    payload: {
      id: `${roomId}-message-${streamSeq}`,
      roomId,
      authorId: "human-a",
      authorKind: "human",
      body,
      sentAt: new Date(Date.UTC(2026, 7, 11, 0, 0, streamSeq)).toISOString(),
    },
  };
}

function smallRoomEvent(roomId: string, streamSeq: number): PersistedRoomEvent {
  return {
    eventId: `e${streamSeq}`,
    streamKind: "room",
    streamId: roomId,
    streamSeq,
    roomId,
    actorId: "human-a",
    occurredAt: "t",
    type: "member.removed",
    payload: { targetActorId: "x" },
  };
}

function canonicalJsonForTest(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
    typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonForTest).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonForTest(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported canonical JSON value");
}

function appendEvent(databasePath: string, event: PersistedRoomEvent): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare(
      `UPDATE streams SET head_seq = ?
       WHERE stream_kind = 'room' AND stream_id = ? AND head_seq = ?`,
    ).run(event.streamSeq, event.roomId, event.streamSeq - 1);
    database.prepare(
      `INSERT INTO events (
         event_id, stream_kind, stream_id, stream_seq, room_id,
         actor_id, event_type, occurred_at, payload_json
       ) VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.eventId,
      event.streamId,
      event.streamSeq,
      event.roomId,
      event.actorId,
      event.type,
      event.occurredAt,
      JSON.stringify(event.payload),
    );
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function appendEvents(
  databasePath: string,
  roomId: string,
  count: number,
  body?: (seq: number) => string,
  eventFactory: (roomId: string, seq: number) => PersistedRoomEvent = roomEvent,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    const advance = database.prepare(
      `UPDATE streams SET head_seq = ?
       WHERE stream_kind = 'room' AND stream_id = ? AND head_seq = ?`,
    );
    const insert = database.prepare(
      `INSERT INTO events (
         event_id, stream_kind, stream_id, stream_seq, room_id,
         actor_id, event_type, occurred_at, payload_json
       ) VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let streamSeq = 1; streamSeq <= count; streamSeq += 1) {
      const event = body === undefined
        ? eventFactory(roomId, streamSeq)
        : roomEvent(roomId, streamSeq, body(streamSeq));
      advance.run(event.streamSeq, event.roomId, event.streamSeq - 1);
      insert.run(
        event.eventId,
        event.streamId,
        event.streamSeq,
        event.roomId,
        event.actorId,
        event.type,
        event.occurredAt,
        JSON.stringify(event.payload),
      );
    }
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

async function createFixture(options: {
  readonly roomId?: string;
  readonly eventCount?: number;
  readonly body?: (seq: number) => string;
  readonly eventFactory?: (roomId: string, seq: number) => PersistedRoomEvent;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "native-im-room-sync-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "authority.sqlite");
  const roomId = options.roomId ?? "room-1";
  const database = new DatabaseSync(databasePath);
  migrateAuthorityDatabase(database);
  const contexts = ["a", "b", "c", "removed"].map(contextFor);
  for (const context of contexts) {
    database.prepare(
      `INSERT INTO actors (id, kind, display_name, reachability, readiness, tool_permissions_json)
       VALUES (?, 'human', ?, 'online', NULL, '[]')`,
    ).run(context.principal.actorId, context.principal.actorId);
    database.prepare(
      `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
       VALUES ('identity', ?, 0, 1)`,
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO session_families (
         family_id, public_id, account_id, actor_id, device_id, device_label,
         platform, created_at, refresh_expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'test', 'Test', 'unknown', 0, 2000000, NULL)`,
    ).run(
      context.sessionFamilyId,
      `test_${context.sessionFamilyId}`,
      context.principal.accountId,
      context.principal.actorId,
    );
    database.prepare(
      `INSERT INTO sessions (
         family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
         access_expires_at, refresh_expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, 1000000, 2000000, NULL)`,
    ).run(
      context.sessionFamilyId,
      context.principal.accountId,
      context.principal.actorId,
      context.sessionId,
      tokenHash(`refresh-${context.principal.actorId}`),
    );
  }
  database.prepare(
    "INSERT INTO rooms (id, name, status, created_at) VALUES (?, 'Sync Room', 'active', ?)",
  ).run(roomId, "2026-08-11T00:00:00.000Z");
  for (const context of contexts.slice(0, 3)) {
    database.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 0)`,
    ).run(roomId, context.principal.actorId, "2026-08-11T00:00:00.000Z");
  }
  database.prepare(
    "UPDATE rooms SET owner_actor_id = ?, governance_revision = 1 WHERE id = ?",
  ).run(contexts[0]!.principal.actorId, roomId);
  database.prepare(
    "INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES ('room', ?, 0, 1)",
  ).run(roomId);
  database.close();
  appendEvents(
    databasePath,
    roomId,
    options.eventCount ?? 0,
    options.body,
    options.eventFactory,
  );

  const client = await createWorkerDatabaseClient({ databasePath });
  const store = createSqliteAuthoritativeStore(client, { clock: () => 2_000 });
  return {
    client,
    contexts,
    databasePath,
    roomId,
    store,
    sync: createSyncService({ store }),
  };
}

function request(
  roomId: string,
  requestId: string,
  afterSeq: number,
  limit?: number,
): RoomSyncRequest {
  return {
    type: "room.sync",
    requestId,
    roomId,
    cursor: { version: 1, roomId, afterSeq },
    ...(limit === undefined ? {} : { limit }),
  };
}

describe("permission-aware retained room sync", () => {
  it("exposes only materialized bootstrap/repair page APIs and preserves current request ids", async () => {
    const fixture = await createFixture();
    const context = fixture.contexts[0];
    if (context === undefined) throw new Error("missing fixture context");
    const snapshotId = "snapshot-service";
    const snapshots = {
      async beginRoomRepair(_context: AuthenticatedSessionContext, requestId: string, roomId: string) {
        return { type: "room.repair.page" as const, requestId, snapshotId, roomId,
          page: 0, records: [], watermark: 0, snapshotChecksum: "checksum",
          hasMore: false, mode: "materialized" as const,
          expiresAt: "2026-08-11T00:05:00.000Z" };
      },
      async readRoomRepairPage(_context: AuthenticatedSessionContext, requestId: string,
        _snapshotId: string, afterPage: number) {
        return { type: "room.repair.page" as const, requestId, snapshotId,
          roomId: fixture.roomId, page: afterPage + 1, records: [], watermark: 0,
          snapshotChecksum: "checksum", hasMore: false, mode: "materialized" as const,
          expiresAt: "2026-08-11T00:05:00.000Z" };
      },
      async beginWorkspaceBootstrap(_context: AuthenticatedSessionContext, requestId: string) {
        return { type: "workspace.bootstrap.page" as const, requestId, snapshotId,
          page: 0, rooms: [], catalogRevision: 0, snapshotChecksum: "checksum",
          hasMore: false, mode: "materialized" as const,
          expiresAt: "2026-08-11T00:05:00.000Z" };
      },
      async readWorkspaceBootstrapPage(_context: AuthenticatedSessionContext, requestId: string,
        _snapshotId: string, afterPage: number) {
        return { type: "workspace.bootstrap.page" as const, requestId, snapshotId,
          page: afterPage + 1, rooms: [], catalogRevision: 0,
          snapshotChecksum: "checksum", hasMore: false, mode: "materialized" as const,
          expiresAt: "2026-08-11T00:05:00.000Z" };
      },
      async completeSnapshot(
        _context: AuthenticatedSessionContext,
        requestId: string,
        completedSnapshotId: string,
        version: { readonly kind: "catalog"; readonly catalogRevision: number },
        checksum: string,
      ) {
        void checksum;
        return { type: "snapshot.completed" as const, requestId,
          snapshotId: completedSnapshotId, version };
      },
      async releaseSnapshot() {},
    };
    const sync = createSyncService({ store: fixture.store, snapshots });

    await expect(sync.beginRoomRepair(context, "room-begin", fixture.roomId))
      .resolves.toMatchObject({ type: "room.repair.page", requestId: "room-begin", page: 0 });
    await expect(sync.readRoomRepairPage(context, "room-next", snapshotId, 0))
      .resolves.toMatchObject({ requestId: "room-next", page: 1 });
    await expect(sync.beginWorkspaceBootstrap(context, "catalog-begin"))
      .resolves.toMatchObject({ type: "workspace.bootstrap.page", requestId: "catalog-begin", page: 0 });
    await expect(sync.readWorkspaceBootstrapPage(context, "catalog-next", snapshotId, 0))
      .resolves.toMatchObject({ requestId: "catalog-next", page: 1 });
    await expect(sync.completeSnapshot(context, "complete", snapshotId,
      { kind: "catalog", catalogRevision: 0 }, "checksum"))
      .resolves.toEqual({ type: "snapshot.completed", requestId: "complete",
        snapshotId, version: { kind: "catalog", catalogRevision: 0 } });
    await expect(sync.releaseSnapshot(context, snapshotId)).resolves.toBeUndefined();
    for (const invalid of ["", " "]) {
      await expect(sync.beginWorkspaceBootstrap(context, invalid))
        .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    await expect(sync.readRoomRepairPage(context, "bad-page", snapshotId, -1))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(sync.completeSnapshot(context, "bad-complete", snapshotId,
      { kind: "room", roomId: "", watermark: 0 }, "checksum"))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(sync.releaseSnapshot(context, " "))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await fixture.client.close();
  });

  it("paginates without gaps and retains three independent client cursors", async () => {
    const fixture = await createFixture({ eventCount: 5 });
    const [contextA, contextB, contextC] = fixture.contexts;
    if (contextA === undefined || contextB === undefined || contextC === undefined) {
      throw new Error("missing fixture contexts");
    }

    const first = await fixture.sync.syncRoom(contextA, request(fixture.roomId, "first", 0, 2));
    expect(first).toMatchObject({ mode: "delta", hasMore: true, watermark: 5 });
    if (first.mode !== "delta") throw new Error("expected delta");
    expect(first.events.map((event) => event.streamSeq)).toEqual([1, 2]);

    const independent = await Promise.all([
      fixture.sync.syncRoom(contextB, request(fixture.roomId, "client-b", 0, 3)),
      fixture.sync.syncRoom(contextC, request(fixture.roomId, "client-c", 0, 1)),
    ]);
    expect(independent.map((result) => result.mode === "delta"
      ? result.events.map((event) => event.streamSeq)
      : [])).toEqual([[1, 2, 3], [1]]);

    const second = await fixture.sync.syncRoom(contextA, {
      type: "room.sync",
      requestId: "second",
      roomId: fixture.roomId,
      cursor: first.nextCursor,
      limit: 10,
    });
    expect(second.mode === "delta" ? second.events.map((event) => event.streamSeq) : [])
      .toEqual([3, 4, 5]);

    await fixture.store.compactRoomStream(fixture.roomId, 4);
    await expect(fixture.sync.syncRoom(
      contextB,
      request(fixture.roomId, "expired", 2),
    )).resolves.toMatchObject({
      type: "room.sync.result",
      requestId: "expired",
      mode: "repair_required",
      reason: "cursor_expired",
      retainedFromSeq: 4,
      watermark: 5,
    });
    await fixture.client.close();
  });

  it("returns explicit repair for absent cursors and honors empty/off-by-one retained windows", async () => {
    const fixture = await createFixture();
    const context = fixture.contexts[0];
    if (context === undefined) throw new Error("missing fixture context");

    await expect(fixture.sync.syncRoom(context, {
      type: "room.sync",
      requestId: "absent",
      roomId: fixture.roomId,
    })).resolves.toEqual({
      type: "room.sync.result",
      requestId: "absent",
      mode: "repair_required",
      reason: "cursor_absent",
      retainedFromSeq: 1,
      watermark: 0,
    });
    await expect(fixture.sync.syncRoom(context, request(fixture.roomId, "empty", 0)))
      .resolves.toMatchObject({ mode: "delta", events: [], hasMore: false, watermark: 0 });

    await fixture.client.close();
    appendEvents(fixture.databasePath, fixture.roomId, 5);
    const client = await createWorkerDatabaseClient({ databasePath: fixture.databasePath });
    const store = createSqliteAuthoritativeStore(client, { clock: () => 2_000 });
    const sync = createSyncService({ store });
    await store.compactRoomStream(fixture.roomId, 4);
    await expect(sync.syncRoom(context, request(fixture.roomId, "edge", 3)))
      .resolves.toMatchObject({ mode: "delta", watermark: 5 });
    await expect(sync.syncRoom(context, request(fixture.roomId, "too-old", 2)))
      .resolves.toMatchObject({ mode: "repair_required", reason: "cursor_expired" });
    await client.close();
  });

  it("rejects future, wrong-room, malformed cursors and closed request schemas", async () => {
    const fixture = await createFixture({ eventCount: 2 });
    const context = fixture.contexts[0];
    if (context === undefined) throw new Error("missing fixture context");

    await expect(fixture.sync.syncRoom(context, request(fixture.roomId, "future", 3)))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    const invalidRequests: readonly unknown[] = [
      { type: "room.other", requestId: "wrong-type", roomId: fixture.roomId },
      { type: "room.sync", requestId: "wrong-room", roomId: fixture.roomId,
        cursor: { version: 1, roomId: "room-other", afterSeq: 0 } },
      { type: "room.sync", requestId: "version", roomId: fixture.roomId,
        cursor: { version: 2, roomId: fixture.roomId, afterSeq: 0 } },
      { type: "room.sync", requestId: "negative", roomId: fixture.roomId,
        cursor: { version: 1, roomId: fixture.roomId, afterSeq: -1 } },
      { type: "room.sync", requestId: "future-watermark", roomId: fixture.roomId,
        cursor: { version: 1, roomId: fixture.roomId, afterSeq: 1, watermark: 3 } },
      { type: "room.sync", requestId: "cursor-extra", roomId: fixture.roomId,
        cursor: { version: 1, roomId: fixture.roomId, afterSeq: 0, extra: true } },
      { type: "room.sync", requestId: "request-extra", roomId: fixture.roomId,
        cursor: { version: 1, roomId: fixture.roomId, afterSeq: 0 }, extra: true },
    ];
    for (const invalid of invalidRequests) {
      await expect(fixture.sync.syncRoom(context, invalid))
        .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    await fixture.client.close();
  });

  it("applies default and maximum count limits and rejects illegal limits", async () => {
    expect(ROOM_SYNC_DEFAULT_LIMIT).toBe(100);
    expect(ROOM_SYNC_MAX_LIMIT).toBe(1_000);
    const fixture = await createFixture({
      roomId: "r",
      eventCount: ROOM_SYNC_MAX_LIMIT + 1,
      eventFactory: smallRoomEvent,
    });
    const context = fixture.contexts[0];
    if (context === undefined) throw new Error("missing fixture context");

    const defaultPage = await fixture.sync.syncRoom(
      context,
      request(fixture.roomId, "default", 0),
    );
    expect(defaultPage.mode === "delta" ? defaultPage.events : []).toHaveLength(100);
    const maxPage = await fixture.sync.syncRoom(
      context,
      request(fixture.roomId, "maximum", 0, ROOM_SYNC_MAX_LIMIT),
    );
    expect(maxPage.mode === "delta" ? maxPage.events : []).toHaveLength(1_000);

    for (const limit of [0, -1, 1.5, ROOM_SYNC_MAX_LIMIT + 1, Number.NaN]) {
      await expect(fixture.sync.syncRoom(context, {
        ...request(fixture.roomId, `limit-${String(limit)}`, 0),
        limit,
      })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    await fixture.client.close();
  });

  it("bounds pages by canonical UTF-8 bytes and fails closed on one oversized event", async () => {
    expect(ROOM_SYNC_MAX_PAGE_BYTES).toBe(256 * 1_024);
    const fixture = await createFixture({
      eventCount: 2,
      body: () => "界".repeat(48_000),
    });
    const context = fixture.contexts[0];
    if (context === undefined) throw new Error("missing fixture context");
    const first = await fixture.sync.syncRoom(
      context,
      request(fixture.roomId, "byte-page", 0, 10),
    );
    expect(first.mode === "delta" ? first.events.map((event) => event.streamSeq) : [])
      .toEqual([1]);
    expect(first).toMatchObject({ mode: "delta", hasMore: true, watermark: 2 });
    expect(Buffer.byteLength(canonicalJsonForTest(first), "utf8"))
      .toBeLessThanOrEqual(ROOM_SYNC_MAX_PAGE_BYTES);
    await fixture.client.close();

    const oversized = await createFixture({
      eventCount: 1,
      body: () => "界".repeat(90_000),
    });
    const oversizedContext = oversized.contexts[0];
    if (oversizedContext === undefined) throw new Error("missing fixture context");
    await expect(oversized.sync.syncRoom(
      oversizedContext,
      request(oversized.roomId, "oversized", 0),
    )).rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
    await expect(oversized.client.close())
      .rejects.toMatchObject({ status: 503, code: "storage_unavailable" });

    const oversizedAfterSmall = await createFixture({
      eventCount: 2,
      body: (seq) => seq === 1 ? "small" : "界".repeat(90_000),
    });
    const oversizedAfterSmallContext = oversizedAfterSmall.contexts[0];
    if (oversizedAfterSmallContext === undefined) throw new Error("missing fixture context");
    await expect(oversizedAfterSmall.sync.syncRoom(
      oversizedAfterSmallContext,
      request(oversizedAfterSmall.roomId, "oversized-after-small", 0, 10),
    )).rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
    await expect(oversizedAfterSmall.client.close())
      .rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
  });

  it("includes the complete canonical result envelope in the page byte limit", async () => {
    const roomId = "room-byte-envelope";
    const requestId = "full-result-byte-bound";
    const baseEvent = roomEvent(roomId, 1, "x");
    const emptyResult = {
      type: "room.sync.result",
      requestId,
      mode: "delta",
      events: [],
      nextCursor: { version: 1, roomId, afterSeq: 1 },
      watermark: 1,
      hasMore: false,
    };
    const emptyResultBytes = Buffer.byteLength(canonicalJsonForTest(emptyResult), "utf8");
    const baseEventBytes = Buffer.byteLength(canonicalJsonForTest(baseEvent), "utf8");
    const bodyLength = ROOM_SYNC_MAX_PAGE_BYTES - emptyResultBytes - baseEventBytes + 2;
    expect(bodyLength).toBeGreaterThan(0);
    const body = "x".repeat(bodyLength);
    const event = roomEvent(roomId, 1, body);
    expect(Buffer.byteLength(canonicalJsonForTest(event), "utf8"))
      .toBeLessThanOrEqual(ROOM_SYNC_MAX_PAGE_BYTES);
    expect(Buffer.byteLength(canonicalJsonForTest({ ...emptyResult, events: [event] }), "utf8"))
      .toBeGreaterThan(ROOM_SYNC_MAX_PAGE_BYTES);

    const fixture = await createFixture({ roomId, eventCount: 1, body: () => body });
    const context = fixture.contexts[0];
    if (context === undefined) throw new Error("missing fixture context");
    await expect(fixture.sync.syncRoom(
      context,
      request(roomId, requestId, 0),
    )).rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
    await expect(fixture.client.close())
      .rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
  });

  it("freezes each page watermark and reads a concurrently appended event on the next page", async () => {
    const fixture = await createFixture({ eventCount: 3 });
    const context = fixture.contexts[0];
    if (context === undefined) throw new Error("missing fixture context");
    let appended = false;
    const interleavedSync = createSyncService({
      store: {
        async syncRoom(receivedContext, receivedRequest) {
          const result = await fixture.store.syncRoom(receivedContext, receivedRequest);
          if (!appended) {
            appendEvent(fixture.databasePath, roomEvent(fixture.roomId, 4));
            appended = true;
          }
          return result;
        },
      },
    });
    const first = await interleavedSync.syncRoom(
      context,
      request(fixture.roomId, "watermark-first", 0, 1),
    );
    if (first.mode !== "delta") throw new Error("expected delta");
    expect(first.events.map((event) => event.streamSeq)).toEqual([1]);
    expect(first.watermark).toBe(3);
    expect(first.nextCursor).toEqual({
      version: 1,
      roomId: fixture.roomId,
      afterSeq: 1,
      watermark: 3,
    });

    const next = await fixture.sync.syncRoom(context, {
      type: "room.sync",
      requestId: "watermark-next",
      roomId: fixture.roomId,
      cursor: first.nextCursor,
      limit: 10,
    });
    expect(next.mode === "delta" ? next.events.map((event) => event.streamSeq) : [])
      .toEqual([2, 3]);
    expect(next).toMatchObject({ mode: "delta", watermark: 3, hasMore: false });
    if (next.mode !== "delta") throw new Error("expected delta");
    expect(next.nextCursor).toEqual({
      version: 1,
      roomId: fixture.roomId,
      afterSeq: 3,
    });

    const later = await fixture.sync.syncRoom(context, {
      type: "room.sync",
      requestId: "watermark-later",
      roomId: fixture.roomId,
      cursor: next.nextCursor,
      limit: 10,
    });
    expect(later.mode === "delta" ? later.events.map((event) => event.streamSeq) : [])
      .toEqual([4]);
    await fixture.client.close();
  });

  it("returns a current repair watermark if compaction expires a fixed continuation", async () => {
    const fixture = await createFixture({ eventCount: 3 });
    const context = fixture.contexts[0];
    if (context === undefined) throw new Error("missing fixture context");
    const first = await fixture.sync.syncRoom(
      context,
      request(fixture.roomId, "repair-chain-first", 0, 1),
    );
    if (first.mode !== "delta") throw new Error("expected delta");
    appendEvent(fixture.databasePath, roomEvent(fixture.roomId, 4));
    await fixture.store.compactRoomStream(fixture.roomId, 5);

    await expect(fixture.sync.syncRoom(context, {
      type: "room.sync",
      requestId: "repair-chain-expired",
      roomId: fixture.roomId,
      cursor: first.nextCursor,
    })).resolves.toEqual({
      type: "room.sync.result",
      requestId: "repair-chain-expired",
      mode: "repair_required",
      reason: "cursor_expired",
      retainedFromSeq: 5,
      watermark: 4,
    });
    await fixture.client.close();
  });

  it("rechecks session and active human membership before cursor semantics", async () => {
    const fixture = await createFixture({ eventCount: 2 });
    const [allowed, , , removed] = fixture.contexts;
    if (allowed === undefined || removed === undefined) throw new Error("missing fixture contexts");
    await expect(fixture.sync.syncRoom(
      removed,
      request(fixture.roomId, "removed", 2),
    )).rejects.toMatchObject({ status: 403, code: "room_forbidden" });

    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("UPDATE rooms SET status = 'archived' WHERE id = ?").run(fixture.roomId);
    database.close();
    await expect(fixture.sync.syncRoom(
      allowed,
      request(fixture.roomId, "archived", 2),
    )).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
    await fixture.client.close();
  });

  it("rejects expired and revoked sessions before reading retained cursors", async () => {
    const fixture = await createFixture({ eventCount: 1 });
    const [expired, revoked] = fixture.contexts;
    if (expired === undefined || revoked === undefined) throw new Error("missing fixture contexts");
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("UPDATE sessions SET access_expires_at = 1000 WHERE access_token_hash = ?")
      .run(expired.sessionId);
    database.prepare("UPDATE sessions SET revoked_at = 1500 WHERE access_token_hash = ?")
      .run(revoked.sessionId);
    database.close();

    await expect(fixture.sync.syncRoom(
      expired,
      request(fixture.roomId, "expired-session", 1),
    )).rejects.toMatchObject({ status: 401, code: "token_expired" });
    await expect(fixture.sync.syncRoom(
      revoked,
      request(fixture.roomId, "revoked-session", 1),
    )).rejects.toMatchObject({ status: 403, code: "session_revoked" });
    await fixture.client.close();
  });

  it("fails closed with a sanitized 503 for event corruption and retained sequence gaps", async () => {
    const corrupt = await createFixture({ eventCount: 1 });
    const corruptContext = corrupt.contexts[0];
    if (corruptContext === undefined) throw new Error("missing fixture context");
    const corruptDatabase = new DatabaseSync(corrupt.databasePath);
    corruptDatabase.exec("DROP TRIGGER events_prevent_update");
    corruptDatabase.prepare("UPDATE events SET payload_json = '{}' WHERE stream_seq = 1").run();
    corruptDatabase.close();
    await expect(corrupt.sync.syncRoom(
      corruptContext,
      request(corrupt.roomId, "corrupt-event", 0),
    )).rejects.toMatchObject({
      status: 503,
      code: "storage_unavailable",
      message: "Stored room sync event is corrupt",
    });
    await expect(corrupt.client.close())
      .rejects.toMatchObject({ status: 503, code: "storage_unavailable" });

    const gap = await createFixture({ eventCount: 3 });
    const gapContext = gap.contexts[0];
    if (gapContext === undefined) throw new Error("missing fixture context");
    const gapDatabase = new DatabaseSync(gap.databasePath);
    gapDatabase.exec("DROP TRIGGER events_validate_delete");
    gapDatabase.prepare("DELETE FROM events WHERE stream_seq = 2").run();
    gapDatabase.close();
    await expect(gap.sync.syncRoom(
      gapContext,
      request(gap.roomId, "sequence-gap", 0),
    )).rejects.toMatchObject({
      status: 503,
      code: "storage_unavailable",
      message: "Authority room sync sequence is corrupt",
    });
    await expect(gap.client.close())
      .rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
  });

  it("compacts only active room streams within bounds and preserves the head", async () => {
    const fixture = await createFixture({ eventCount: 5 });
    const outboxDatabase = new DatabaseSync(fixture.databasePath);
    outboxDatabase.prepare(
      `INSERT INTO outbox_deliveries (
         id, event_id, target_kind, target_id, stream_seq, status,
         attempts, available_at, delivered_at, last_error
       ) VALUES ('old-delivery', ?, 'room', ?, 1, 'dispatched', 1, ?, ?, NULL)`,
    ).run(
      `${fixture.roomId}-event-1`,
      fixture.roomId,
      "2026-08-11T00:00:01.000Z",
      "2026-08-11T00:00:02.000Z",
    );
    outboxDatabase.close();
    await fixture.store.compactRoomStream(fixture.roomId, 6);
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT head_seq AS headSeq, retained_from_seq AS retained FROM streams WHERE stream_kind = 'room' AND stream_id = ?",
    ).get(fixture.roomId)).toEqual({ headSeq: 5, retained: 6 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE stream_kind = 'room' AND stream_id = ?",
    ).get(fixture.roomId)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get())
      .toEqual({ count: 0 });
    database.close();
    for (const retained of [0, 7]) {
      await expect(fixture.store.compactRoomStream(fixture.roomId, retained))
        .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    await expect(fixture.store.compactRoomStream(fixture.roomId, 5))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(fixture.store.compactRoomStream("room-unknown", 1))
      .rejects.toMatchObject({ status: 404, code: "room_not_found" });
    await fixture.client.close();

    const archived = await createFixture({ eventCount: 1 });
    const archivedDatabase = new DatabaseSync(archived.databasePath);
    archivedDatabase.prepare("UPDATE rooms SET status = 'archived' WHERE id = ?")
      .run(archived.roomId);
    archivedDatabase.close();
    await expect(archived.store.compactRoomStream(archived.roomId, 1))
      .rejects.toMatchObject({ status: 409, code: "room_archived" });
    await archived.client.close();
  });

  it("rolls back compaction without deleting pending outbox work", async () => {
    const fixture = await createFixture({ eventCount: 3 });
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare(
      `INSERT INTO outbox_deliveries (
         id, event_id, target_kind, target_id, stream_seq, status,
         attempts, available_at, delivered_at, last_error
       ) VALUES ('pending-delivery', ?, 'room', ?, 1, 'pending', 0, ?, NULL, NULL)`,
    ).run(
      `${fixture.roomId}-event-1`,
      fixture.roomId,
      "2026-08-11T00:00:01.000Z",
    );
    const before = {
      stream: database.prepare(
        `SELECT head_seq AS headSeq, retained_from_seq AS retainedFromSeq
         FROM streams WHERE stream_kind = 'room' AND stream_id = ?`,
      ).get(fixture.roomId),
      events: database.prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
         FROM events WHERE stream_kind = 'room' AND stream_id = ?`,
      ).get(fixture.roomId),
      outbox: database.prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(length(CAST(
                  id || event_id || target_kind || target_id || status AS BLOB
                ))), 0) AS bytes
         FROM outbox_deliveries`,
      ).get(),
    };
    await expect(fixture.store.compactRoomStream(fixture.roomId, 2))
      .rejects.toMatchObject({ status: 409, code: "room_compaction_blocked" });
    expect({
      stream: database.prepare(
        `SELECT head_seq AS headSeq, retained_from_seq AS retainedFromSeq
         FROM streams WHERE stream_kind = 'room' AND stream_id = ?`,
      ).get(fixture.roomId),
      events: database.prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
         FROM events WHERE stream_kind = 'room' AND stream_id = ?`,
      ).get(fixture.roomId),
      outbox: database.prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(length(CAST(
                  id || event_id || target_kind || target_id || status AS BLOB
                ))), 0) AS bytes
         FROM outbox_deliveries`,
      ).get(),
    }).toEqual(before);
    database.close();
    await expect(fixture.client.inspectSchema()).resolves.toEqual({ version: 14 });
    const context = fixture.contexts[0];
    if (context === undefined) throw new Error("missing fixture context");
    await expect(fixture.sync.syncRoom(
      context,
      request(fixture.roomId, "after-blocked-compaction", 0),
    )).resolves.toMatchObject({ mode: "delta", watermark: 3 });
    await expect(fixture.client.close()).resolves.toBeUndefined();
  });

  it("keeps worker sync and compaction wire messages closed", () => {
    const context = contextFor("a");
    const syncRequest = request("room-1", "wire-sync", 0, 2);
    expect(isAuthorityWorkerRequest({
      type: "authority.sync-room",
      requestId: "rpc-sync",
      context,
      request: syncRequest,
      now: 2_000,
    })).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.sync-room",
      requestId: "rpc-sync-extra",
      context,
      request: syncRequest,
      now: 2_000,
      extra: true,
    })).toBe(false);
    expect(isAuthorityWorkerRequest({
      type: "authority.compact-room-stream",
      requestId: "rpc-compact",
      roomId: "room-1",
      retainedFromSeq: 2,
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.room-synced",
      requestId: "rpc-sync",
      result: {
        type: "room.sync.result",
        requestId: "wire-sync",
        mode: "delta",
        events: [],
        nextCursor: { version: 1, roomId: "room-1", afterSeq: 0 },
        watermark: 0,
        hasMore: false,
      },
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.room-stream-compacted",
      requestId: "rpc-compact",
      roomId: "room-1",
      retainedFromSeq: 2,
      headSeq: 5,
    })).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.room-stream-compacted",
      requestId: "rpc-compact-invalid",
      roomId: "room-1",
      retainedFromSeq: 7,
      headSeq: 5,
    })).toBe(false);
    expect(isAuthorityWorkerResponse({
      type: "authority.error",
      requestId: "rpc-compact-blocked",
      code: "room_compaction_blocked",
      message: "Authority room stream compaction is waiting for pending delivery",
    })).toBe(true);
  });
});
