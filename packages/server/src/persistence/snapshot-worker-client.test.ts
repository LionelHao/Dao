import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToPreviousVersionForTest,
  migrateSnapshotCacheDatabase,
} from "./schema.js";
import {
  SNAPSHOT_BUILD_DEADLINE_MS,
  SNAPSHOT_CACHE_QUOTA_BYTES,
  SNAPSHOT_DEFAULT_TTL_MS,
  SNAPSHOT_MAX_PAGE_BYTES,
  SNAPSHOT_MAX_RECORDS_PER_PAGE,
  SNAPSHOT_MAX_WAL_GROWTH_BYTES,
  SNAPSHOT_QUEUE_LIMIT,
  SNAPSHOT_REUSE_MIN_REMAINING_MS,
  SNAPSHOT_SCAN_BATCH_SIZE,
  SnapshotWorkerClientError,
  createSnapshotWorkerClient,
  createSnapshotWorkerClientForTest,
  createSnapshotWorkerClientWithPauseForTest,
  type SnapshotWorkerTransport,
} from "./snapshot-worker-client.js";
import type {
  AuthenticatedSessionContext,
  SnapshotWorkerRequest,
} from "./contracts.js";
import { createWorkerDatabaseClient } from "./worker-database-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function contextFor(suffix: string, familySuffix = suffix): AuthenticatedSessionContext {
  return {
    sessionId: tokenHash(`access-${suffix}`),
    sessionFamilyId: tokenHash(`family-${familySuffix}`),
    principal: { accountId: "account-a", actorId: "human-a" },
  };
}

function seedHuman(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  catalogRevision = 0,
): void {
  database.prepare(
    `INSERT OR IGNORE INTO actors (
       id, kind, display_name, reachability, readiness, tool_permissions_json,
       catalog_revision
     ) VALUES (?, 'human', 'A', 'online', NULL, '[]', ?)`,
  ).run(context.principal.actorId, catalogRevision);
  database.prepare(
    `INSERT OR IGNORE INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
     VALUES ('identity', ?, 0, 1)`,
  ).run(context.principal.actorId);
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
    tokenHash(`refresh-${context.sessionId}`),
  );
}

function seedRoom(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  messageCount = 0,
  body: (index: number) => string = (index) => `message-${index}`,
): void {
  database.prepare(
    "INSERT INTO rooms (id, name, status, created_at) VALUES (?, ?, 'active', ?)",
  ).run(roomId, `Room ${roomId}`, "2026-08-11T00:00:00.000Z");
  database.prepare(
    `INSERT INTO room_memberships (
       room_id, actor_id, kind, role, participation, tool_permissions_json,
       joined_at, configured_at, access_revision
     ) VALUES (?, ?, 'human', 'owner', NULL, '[]', ?, NULL, 7)`,
  ).run(roomId, context.principal.actorId, "2026-08-11T00:00:00.000Z");
  database.prepare(
    `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
     VALUES ('room', ?, ?, 1)`,
  ).run(roomId, messageCount);
  const insert = database.prepare(
    `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
     VALUES (?, ?, ?, 'human', ?, ?)`,
  );
  for (let index = 0; index < messageCount; index += 1) {
    insert.run(`message-${String(index).padStart(4, "0")}`, roomId,
      context.principal.actorId, body(index),
      new Date(Date.UTC(2026, 7, 11, 0, 0, index)).toISOString());
  }
}

async function createDatabaseFixture(options: {
  readonly rooms?: readonly { readonly roomId: string; readonly messageCount?: number;
    readonly body?: (index: number) => string }[];
  readonly contexts?: readonly AuthenticatedSessionContext[];
  readonly catalogRevision?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "native-im-snapshot-"));
  temporaryDirectories.push(directory);
  const authorityPath = join(directory, "authority.sqlite");
  const cachePath = join(directory, "snapshot-cache.sqlite");
  const database = new DatabaseSync(authorityPath);
  migrateAuthorityDatabase(database);
  const contexts = options.contexts ?? [contextFor("a")];
  for (const context of contexts) seedHuman(database, context, options.catalogRevision ?? 0);
  for (const room of options.rooms ?? []) {
    seedRoom(database, contexts[0]!, room.roomId, room.messageCount,
      room.body ?? ((index) => `message-${index}`));
  }
  database.close();
  return { directory, authorityPath, cachePath, contexts };
}

function canonicalJsonForTest(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForTest).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJsonForTest(record[key])}`).join(",")}}`;
  }
  throw new TypeError("unsupported canonical value");
}

describe("durable materialized snapshot worker", () => {
  it("uses the fixed production safety limits and returns empty catalog page zero", async () => {
    expect({
      buildDeadlineMs: SNAPSHOT_BUILD_DEADLINE_MS,
      cacheQuotaBytes: SNAPSHOT_CACHE_QUOTA_BYTES,
      maxPageBytes: SNAPSHOT_MAX_PAGE_BYTES,
      maxRecordsPerPage: SNAPSHOT_MAX_RECORDS_PER_PAGE,
      maxWalGrowthBytes: SNAPSHOT_MAX_WAL_GROWTH_BYTES,
      queueLimit: SNAPSHOT_QUEUE_LIMIT,
      reuseMinRemainingMs: SNAPSHOT_REUSE_MIN_REMAINING_MS,
      scanBatchSize: SNAPSHOT_SCAN_BATCH_SIZE,
      ttlMs: SNAPSHOT_DEFAULT_TTL_MS,
    }).toEqual({
      buildDeadlineMs: 60_000,
      cacheQuotaBytes: 512 * 1_024 * 1_024,
      maxPageBytes: 256 * 1_024,
      maxRecordsPerPage: 100,
      maxWalGrowthBytes: 128 * 1_024 * 1_024,
      queueLimit: 16,
      reuseMinRemainingMs: 60_000,
      scanBatchSize: 200,
      ttlMs: 5 * 60_000,
    });

    const directory = await mkdtemp(join(tmpdir(), "native-im-snapshot-red-"));
    temporaryDirectories.push(directory);
    const authorityPath = join(directory, "authority.sqlite");
    const cachePath = join(directory, "snapshot-cache.sqlite");
    const database = new DatabaseSync(authorityPath);
    migrateAuthorityDatabase(database);
    const context = {
      sessionId: tokenHash("access-a"),
      sessionFamilyId: tokenHash("family-a"),
      principal: { accountId: "account-a", actorId: "human-a" },
    };
    database.prepare(
      `INSERT INTO actors (
         id, kind, display_name, reachability, readiness, tool_permissions_json
       ) VALUES (?, 'human', 'A', 'online', NULL, '[]')`,
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
       VALUES ('identity', ?, 0, 1)`,
    ).run(context.principal.actorId);
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
      tokenHash("refresh-a"),
    );
    database.close();

    const client = await createSnapshotWorkerClient({
      authorityPath,
      cachePath,
      revalidate: async () => undefined,
      clock: () => 2_000,
    });
    await expect(client.beginWorkspaceBootstrap(context, "request-a"))
      .resolves.toMatchObject({
        type: "workspace.bootstrap.page",
        requestId: "request-a",
        page: 0,
        rooms: [],
        catalogRevision: 0,
        mode: "materialized",
        hasMore: false,
      });
    await client.close();
  });

  it("initializes two real workers concurrently against one cold cache", async () => {
    const fixture = await createDatabaseFixture();
    const options = {
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    };
    const results = await Promise.allSettled([
      createSnapshotWorkerClient(options),
      createSnapshotWorkerClient(options),
    ]);
    try {
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const clients = results.flatMap((result) => result.status === "fulfilled"
        ? [result.value] : []);
      await expect(Promise.all(clients.map((client, index) =>
        client.beginWorkspaceBootstrap(fixture.contexts[0]!, `cold-cache-${index}`))))
        .resolves.toHaveLength(2);
    } finally {
      await Promise.all(results.flatMap((result) => result.status === "fulfilled"
        ? [result.value.close()] : []));
    }
  });

  it("runs full cache integrity validation once per worker lifecycle", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "validation-count-room", messageCount: 3 }],
    });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { maxRecordsPerPage: 1 },
    });
    const deep = client as typeof client & {
      fullValidationCountForTest(): Promise<number>;
      cacheCountForTest(): Promise<number>;
    };
    await expect(deep.fullValidationCountForTest()).resolves.toBe(1);
    const page0 = await client.beginRoomRepair(
      fixture.contexts[0]!, "validation-count-0", "validation-count-room");
    if ("kind" in page0 && page0.kind === "fallback") throw new Error("unexpected fallback");
    await client.readRoomRepairPage(
      fixture.contexts[0]!, "validation-count-1", page0.snapshotId, 0);
    await deep.cacheCountForTest();
    await expect(deep.fullValidationCountForTest()).resolves.toBe(1);
    await client.close();
  });

  it("still detects same-version physical tampering on a later page read", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "light-validation-room", messageCount: 2 }],
    });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { maxRecordsPerPage: 1 },
    });
    const page0 = await client.beginRoomRepair(
      fixture.contexts[0]!, "light-validation-0", "light-validation-room");
    if ("kind" in page0 && page0.kind === "fallback") throw new Error("unexpected fallback");
    const tampered = new DatabaseSync(fixture.cachePath);
    tampered.exec("DROP INDEX repair_snapshots_reuse");
    tampered.close();
    await expect(client.readRoomRepairPage(
      fixture.contexts[0]!, "light-validation-1", page0.snapshotId, 0,
    )).rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
  });

  it("materializes room page zero and 0-based continuations with current request ids", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "room-page", messageCount: 4 }],
    });
    const context = fixture.contexts[0]!;
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: async () => undefined,
      clock: () => 2_000,
      limits: { maxRecordsPerPage: 2 },
    });
    const page0 = await client.beginRoomRepair(context, "begin-room", "room-page");
    if ("kind" in page0 && page0.kind === "fallback") throw new Error("unexpected fallback");
    expect(page0).toMatchObject({
      type: "room.repair.page", requestId: "begin-room", roomId: "room-page",
      page: 0, watermark: 4, mode: "materialized", hasMore: true,
    });
    expect(page0.records.map((record) => record.kind)).toEqual(["room", "membership"]);

    const page1 = await client.readRoomRepairPage(
      context, "read-page-one", page0.snapshotId, 0,
    );
    expect(page1).toMatchObject({ requestId: "read-page-one", page: 1, hasMore: true });
    expect(page1.snapshotChecksum).toBe(page0.snapshotChecksum);
    const page2 = await client.readRoomRepairPage(
      context, "read-page-two", page0.snapshotId, 1,
    );
    expect(page2).toMatchObject({ requestId: "read-page-two", page: 2, hasMore: false });
    await expect(client.readRoomRepairPage(context, "past-end", page0.snapshotId, 2))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(client.readRoomRepairPage(context, "negative", page0.snapshotId, -1))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await client.close();
  });

  it("materializes every closed room repair record in stable table/entity order", async () => {
    const fixture = await createDatabaseFixture({ rooms: [{ roomId: "room-mixed" }] });
    const context = fixture.contexts[0]!;
    const database = new DatabaseSync(fixture.authorityPath);
    database.prepare(
      `INSERT INTO actors (id, kind, display_name, reachability, readiness, tool_permissions_json)
       VALUES ('agent-a', 'agent', 'Agent', NULL, 'ready', '["tool"]')`,
    ).run();
    database.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES ('room-mixed', 'agent-a', 'agent', NULL, 'active', '["tool"]',
         NULL, '2026-08-11T00:00:01.000Z', 0)`,
    ).run();
    database.prepare(
      `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
       VALUES
       ('message-agent', 'room-mixed', 'agent-a', 'agent', 'agent answer', '2026-08-11T00:00:03.000Z'),
       ('message-human', 'room-mixed', ?, 'human', 'question', '2026-08-11T00:00:02.000Z')`,
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO human_read_receipts (room_id, actor_id, message_id, read_at)
       VALUES ('room-mixed', ?, 'message-agent', '2026-08-11T00:00:04.000Z')`,
    ).run(context.principal.actorId);
    const judgment = { id: "judgment-a", messageId: "message-human", agentId: "agent-a",
      outcome: "will_respond", reason: "addressed", decidedAt: "2026-08-11T00:00:05.000Z" };
    database.prepare(
      `INSERT INTO agent_judgments (
         id, room_id, agent_id, message_id, judgment_json, created_at
       ) VALUES ('judgment-a', 'room-mixed', 'agent-a', 'message-human', ?, ?)`,
    ).run(JSON.stringify(judgment), judgment.decidedAt);
    database.prepare(
      `INSERT INTO open_items (
         id, room_id, source_message_id, assigned_actor_id, status, body,
         created_at, resolved_at, requester_actor_id, transfer_chain_json, responded_at
       ) VALUES ('open-a', 'room-mixed', 'message-human', 'agent-a',
         'pending_response', 'respond', '2026-08-11T00:00:06.000Z', NULL, ?, '[]', NULL)`,
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO agent_executions (
         id, room_id, agent_id, trigger_message_id, status, started_at,
         completed_at, result_json, requester_actor_id, tool_name
       ) VALUES ('execution-a', 'room-mixed', 'agent-a', 'message-human', 'completed',
         '2026-08-11T00:00:07.000Z', '2026-08-11T00:00:08.000Z', '"ok"', ?, 'tool')`,
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO calibration_signals (
         id, room_id, agent_id, judgment_id, signal, created_at, source_message_id, actor_id
       ) VALUES ('calibration-a', 'room-mixed', 'agent-a', NULL, '👍',
         '2026-08-11T00:00:09.000Z', 'message-agent', ?)`,
    ).run(context.principal.actorId);
    database.close();
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    });
    const page = await client.beginRoomRepair(context, "mixed", "room-mixed");
    if ("kind" in page && page.kind === "fallback") throw new Error("unexpected fallback");
    expect(page.hasMore).toBe(false);
    expect(page.records.map((record) => record.kind)).toEqual([
      "room", "membership", "membership", "message", "message", "human-read",
      "agent-judgement", "open-item", "agent-execution", "calibration",
    ]);
    await client.close();
  });

  it("materializes migrated v3 calibration as explicit legacy unknowns without invented ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-snapshot-v3-calibration-"));
    temporaryDirectories.push(directory);
    const authorityPath = join(directory, "authority.sqlite");
    const cachePath = join(directory, "snapshot-cache.sqlite");
    const context = contextFor("legacy-calibration");
    const database = new DatabaseSync(authorityPath);
    migrateAuthorityDatabaseToPreviousVersionForTest(database);
    database.exec(`
      INSERT INTO actors (
        id, kind, display_name, reachability, readiness, tool_permissions_json,
        catalog_revision
      ) VALUES
        ('human-a', 'human', 'Human', 'online', NULL, '[]', 0),
        ('agent-legacy', 'agent', 'Agent', NULL, 'ready', '[]', 0);
      INSERT INTO rooms (id, name, status, created_at)
      VALUES ('room-legacy', 'Legacy', 'active', '2026-08-09T00:00:00.000Z');
      INSERT INTO room_memberships (
        room_id, actor_id, kind, role, participation, tool_permissions_json,
        joined_at, configured_at, access_revision
      ) VALUES
        ('room-legacy', 'human-a', 'human', 'owner', NULL, '[]',
         '2026-08-09T00:00:00.000Z', NULL, 7),
        ('room-legacy', 'agent-legacy', 'agent', NULL, 'active', '["tool"]',
         '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', 0);
      INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
      VALUES ('room', 'room-legacy', 0, 1),
        ('identity', 'human-a', 0, 1), ('identity', 'agent-legacy', 0, 1);
      INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
      VALUES ('message-legacy', 'room-legacy', 'agent-legacy', 'agent', 'legacy',
        '2026-08-09T03:00:00.000Z');
      INSERT INTO agent_judgments (
        id, room_id, agent_id, message_id, judgment_json, created_at
      ) VALUES ('judgment-legacy', 'room-legacy', 'agent-legacy', 'message-legacy',
        '{"id":"judgment-legacy","messageId":"message-legacy","agentId":"agent-legacy","outcome":"will_respond","reason":"legacy","decidedAt":"2026-08-09T03:00:30.000Z"}',
        '2026-08-09T03:00:30.000Z');
      INSERT INTO calibration_signals (
        id, room_id, agent_id, judgment_id, signal, created_at
      ) VALUES ('calibration-legacy', 'room-legacy', 'agent-legacy',
        'judgment-legacy', '👍', '2026-08-09T03:01:00.000Z');
    `);
    database.prepare(
      `INSERT INTO sessions (
         family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
         access_expires_at, refresh_expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, 1000000, 2000000, NULL)`,
    ).run(context.sessionFamilyId, context.principal.accountId,
      context.principal.actorId, context.sessionId, tokenHash("legacy-refresh"));
    migrateAuthorityDatabase(database);
    database.close();

    const client = await createSnapshotWorkerClient({ authorityPath, cachePath,
      revalidate: async () => undefined, clock: () => 2_000 });
    const page = await client.beginRoomRepair(context, "legacy-calibration", "room-legacy");
    if ("kind" in page && page.kind === "fallback") throw new Error("unexpected fallback");
    expect(page.records.find((record) => record.kind.includes("calibration"))).toEqual({
      kind: "legacy-unknown-calibration",
      value: {
        id: "calibration-legacy", sourceMessageId: null, actorId: null,
        agentId: "agent-legacy", emoji: "👍", createdAt: "2026-08-09T03:01:00.000Z",
      },
    });
    await client.close();
  });

  it("materializes nonempty catalog pages without room history or watermark", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "room-a" }, { roomId: "room-b" }],
      catalogRevision: 9,
    });
    const context = fixture.contexts[0]!;
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { maxRecordsPerPage: 1 },
    });
    const page0 = await client.beginWorkspaceBootstrap(context, "catalog-zero");
    if ("kind" in page0 && page0.kind === "fallback") throw new Error("unexpected fallback");
    expect(page0).toMatchObject({ page: 0, requestId: "catalog-zero",
      catalogRevision: 9, hasMore: true });
    expect(page0.rooms).toEqual([{ roomId: "room-a", name: "Room room-a",
      status: "active", role: "owner" }]);
    expect(page0).not.toHaveProperty("watermark");
    const page1 = await client.readWorkspaceBootstrapPage(
      context, "catalog-one", page0.snapshotId, 0,
    );
    expect(page1).toMatchObject({ page: 1, requestId: "catalog-one", hasMore: false });
    expect(page1.rooms[0]?.roomId).toBe("room-b");
    await client.close();
  });

  it("enforces record count and complete canonical UTF-8 page bytes", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "room-bytes", messageCount: 3, body: () => "界".repeat(120) }],
    });
    const context = fixture.contexts[0]!;
    const maxPageBytes = 1_100;
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { maxRecordsPerPage: 2, maxPageBytes },
    });
    const first = await client.beginRoomRepair(context, "bytes-zero", "room-bytes");
    if ("kind" in first && first.kind === "fallback") throw new Error("unexpected fallback");
    const pages = [first];
    let page = first;
    while (page.hasMore) {
      page = await client.readRoomRepairPage(
        context, `bytes-${page.page + 1}`, first.snapshotId, page.page,
      );
      pages.push(page);
    }
    expect(pages.every((entry) => entry.records.length <= 2)).toBe(true);
    expect(pages.every((entry) =>
      Buffer.byteLength(canonicalJsonForTest(entry), "utf8") <= maxPageBytes)).toBe(true);
    expect(pages.flatMap((entry) => entry.records)).toHaveLength(5);
    await client.close();
  });

  it("never returns an oversized empty page or continuation after request-id rebinding", async () => {
    const empty = await createDatabaseFixture();
    const emptyClient = await createSnapshotWorkerClient({
      authorityPath: empty.authorityPath, cachePath: empty.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { maxPageBytes: 1 },
    });
    await expect(emptyClient.beginWorkspaceBootstrap(empty.contexts[0]!, "empty"))
      .resolves.toEqual({ kind: "fallback", reason: "quota" });
    await emptyClient.close();

    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "request-id-room", messageCount: 2 }],
    });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { maxRecordsPerPage: 1 },
    });
    const page0 = await client.beginRoomRepair(
      fixture.contexts[0]!, "short", "request-id-room");
    if ("kind" in page0 && page0.kind === "fallback") throw new Error("unexpected fallback");
    await expect(client.readRoomRepairPage(
      fixture.contexts[0]!, "x".repeat(129), page0.snapshotId, 0,
    )).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await client.close();
  });

  it("reuses committed snapshots only within one family and supports two consumers", async () => {
    const sameFamilyA = contextFor("a", "shared");
    const sameFamilyB = contextFor("b", "shared");
    const otherFamily = contextFor("c", "other");
    const fixture = await createDatabaseFixture({
      contexts: [sameFamilyA, sameFamilyB, otherFamily],
      rooms: [{ roomId: "room-shared", messageCount: 2 }],
    });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { maxRecordsPerPage: 2 },
    });
    const [first, second] = await Promise.all([
      client.beginRoomRepair(sameFamilyA, "consumer-a", "room-shared"),
      client.beginRoomRepair(sameFamilyB, "consumer-b", "room-shared"),
    ]);
    if (("kind" in first && first.kind === "fallback") ||
        ("kind" in second && second.kind === "fallback")) throw new Error("unexpected fallback");
    expect(second.snapshotId).toBe(first.snapshotId);
    await expect(client.readRoomRepairPage(
      otherFamily, "other-family", first.snapshotId, 0,
    )).rejects.toMatchObject({ status: 403, code: "snapshot_forbidden" });
    const [retryA, retryB] = await Promise.all([
      client.readRoomRepairPage(sameFamilyA, "retry-a", first.snapshotId, 0),
      client.readRoomRepairPage(sameFamilyB, "retry-b", first.snapshotId, 0),
    ]);
    expect(retryA.records).toEqual(retryB.records);
    await client.close();
  });

  it("continues after restart and same-family refresh, then expires and cleans only expired", async () => {
    let now = 2_000;
    const original = contextFor("a", "shared");
    const refreshed = contextFor("refresh", "shared");
    const fixture = await createDatabaseFixture({
      contexts: [original, refreshed], rooms: [{ roomId: "room-restart", messageCount: 2 }],
    });
    let client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => now,
      limits: { maxRecordsPerPage: 2, ttlMs: 120_000, reuseMinRemainingMs: 60_000 },
    });
    const first = await client.beginRoomRepair(original, "restart-zero", "room-restart");
    if ("kind" in first && first.kind === "fallback") throw new Error("unexpected fallback");
    await client.close();
    client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => now,
      limits: { maxRecordsPerPage: 2, ttlMs: 120_000, reuseMinRemainingMs: 60_000 },
    });
    await expect(client.readRoomRepairPage(refreshed, "after-restart", first.snapshotId, 0))
      .resolves.toMatchObject({ page: 1, requestId: "after-restart" });
    now = 122_000;
    await expect(client.readRoomRepairPage(refreshed, "expired", first.snapshotId, 0))
      .rejects.toMatchObject({ status: 410, code: "snapshot_expired" });
    await client.close();
    const cache = new DatabaseSync(fixture.cachePath, { readOnly: true });
    expect(cache.prepare("SELECT COUNT(*) AS count FROM repair_snapshots").get()?.count).toBe(0);
    cache.close();
  });

  it("keeps an expired snapshot at 410 after cleanup removed its manifest and pages", async () => {
    let now = 2_000;
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "expired-room", messageCount: 2 }],
    });
    const context = fixture.contexts[0]!;
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => now,
      limits: { maxRecordsPerPage: 1, ttlMs: 120_000, reuseMinRemainingMs: 60_000 },
    });
    const first = await client.beginRoomRepair(context, "expiry-build", "expired-room");
    if ("kind" in first && first.kind === "fallback") throw new Error("unexpected fallback");
    now = 122_001;
    await client.beginWorkspaceBootstrap(context, "cleanup-trigger");
    await expect(client.readRoomRepairPage(context, "expired-once", first.snapshotId, 0))
      .rejects.toMatchObject({ status: 410, code: "snapshot_expired" });
    await expect(client.readRoomRepairPage(context, "expired-twice", first.snapshotId, 0))
      .rejects.toMatchObject({ status: 410, code: "snapshot_expired" });
    await client.close();
  });

  it("builds a new single-flight snapshot below the reuse window without deleting the live old one", async () => {
    let now = 2_000;
    const fixture = await createDatabaseFixture({ rooms: [{ roomId: "room-reuse", messageCount: 1 }] });
    const context = fixture.contexts[0]!;
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => now,
      limits: { ttlMs: 120_000, reuseMinRemainingMs: 60_000 },
    });
    const first = await client.beginRoomRepair(context, "reuse-first", "room-reuse");
    if ("kind" in first && first.kind === "fallback") throw new Error("unexpected fallback");
    now = 62_001;
    const second = await client.beginRoomRepair(context, "reuse-second", "room-reuse");
    if ("kind" in second && second.kind === "fallback") throw new Error("unexpected fallback");
    expect(second.snapshotId).not.toBe(first.snapshotId);
    await client.close();
    const cache = new DatabaseSync(fixture.cachePath, { readOnly: true });
    expect(cache.prepare("SELECT COUNT(*) AS count FROM repair_snapshots").get()?.count).toBe(2);
    cache.close();
  });

  it("keeps checksum stable across restart and canonical property insertion order", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "room-checksum", messageCount: 1 }],
    });
    const context = fixture.contexts[0]!;
    const options = {
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    };
    let client = await createSnapshotWorkerClient(options);
    const first = await client.beginRoomRepair(context, "checksum-a", "room-checksum");
    if ("kind" in first && first.kind === "fallback") throw new Error("unexpected fallback");
    await client.close();
    client = await createSnapshotWorkerClient(options);
    const second = await client.beginRoomRepair({
      principal: { actorId: context.principal.actorId, accountId: context.principal.accountId },
      sessionFamilyId: context.sessionFamilyId,
      sessionId: context.sessionId,
    }, "checksum-b", "room-checksum");
    if ("kind" in second && second.kind === "fallback") throw new Error("unexpected fallback");
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.snapshotChecksum).toBe(first.snapshotChecksum);
    await client.close();
  });

  it("keeps main/AuthorityWorker responsive and deletes a snapshot when final authorization loses", async () => {
    const owner: AuthenticatedSessionContext = {
      sessionId: tokenHash("race-owner-access"),
      sessionFamilyId: tokenHash("race-owner-family"),
      principal: { accountId: "race-owner-account", actorId: "race-owner" },
    };
    const target: AuthenticatedSessionContext = {
      sessionId: tokenHash("race-target-access"),
      sessionFamilyId: tokenHash("race-target-family"),
      principal: { accountId: "race-target-account", actorId: "race-target" },
    };
    const fixture = await createDatabaseFixture({ contexts: [owner, target] });
    const seed = new DatabaseSync(fixture.authorityPath);
    seedRoom(seed, owner, "race-room", 9_998);
    seed.prepare(
      "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room' AND stream_id = 'race-room'",
    ).run();
    seed.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES ('race-room', ?, 'human', 'member', NULL, '[]', 't', NULL, 5)`,
    ).run(target.principal.actorId);
    seed.close();
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const paused = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
      clock: () => 2_000,
    });

    const beginning = paused.client.beginRoomRepair(target, "race-begin", "race-room");
    await paused.hooks.waitForFixedView();
    const heartbeat = new Promise<void>((resolve) => setImmediate(resolve));
    const unrelatedCommit = authority.executeHuman({
      ...owner, kind: "human", requestId: "unrelated-create",
      idempotencyKey: "unrelated-create",
    }, { type: "room.create", payload: { name: "Unrelated" } }, 2_000);
    await expect(Promise.all([heartbeat, unrelatedCommit])).resolves.toBeDefined();
    await authority.executeHuman({
      ...owner, kind: "human", requestId: "remove-target",
      idempotencyKey: "remove-target",
    }, { type: "member.remove", roomId: "race-room",
      payload: { targetActorId: target.principal.actorId } }, 2_001);
    paused.hooks.continueBuild();

    await expect(beginning).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
    await expect(paused.client.cacheCountForTest()).resolves.toBe(0);
    await paused.client.close();
    await authority.close();
  });

  it("revalidates every later page and invalidates cache after membership removal", async () => {
    const owner: AuthenticatedSessionContext = {
      sessionId: tokenHash("page-owner-access"), sessionFamilyId: tokenHash("page-owner-family"),
      principal: { accountId: "page-owner-account", actorId: "page-owner" },
    };
    const target: AuthenticatedSessionContext = {
      sessionId: tokenHash("page-target-access"), sessionFamilyId: tokenHash("page-target-family"),
      principal: { accountId: "page-target-account", actorId: "page-target" },
    };
    const fixture = await createDatabaseFixture({ contexts: [owner, target] });
    const seed = new DatabaseSync(fixture.authorityPath);
    seedRoom(seed, owner, "page-auth-room", 2);
    seed.prepare("UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room' AND stream_id = 'page-auth-room'").run();
    seed.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES ('page-auth-room', ?, 'human', 'member', NULL, '[]', 't', NULL, 5)`,
    ).run(target.principal.actorId);
    seed.close();
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const paused = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
      clock: () => 2_000, limits: { maxRecordsPerPage: 2 },
    });
    const beginning = paused.client.beginRoomRepair(target, "page-auth-zero", "page-auth-room");
    await paused.hooks.waitForFixedView();
    paused.hooks.continueBuild();
    const page0 = await beginning;
    if ("kind" in page0 && page0.kind === "fallback") throw new Error("unexpected fallback");
    await authority.executeHuman({ ...owner, kind: "human", requestId: "page-remove",
      idempotencyKey: "page-remove" }, { type: "member.remove", roomId: "page-auth-room",
      payload: { targetActorId: target.principal.actorId } }, 2_001);
    await expect(paused.client.readRoomRepairPage(
      target, "page-auth-one", page0.snapshotId, 0,
    )).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
    await expect(paused.client.cacheCountForTest()).resolves.toBe(0);
    await paused.client.close();
    await authority.close();
  });

  it("does not invalidate a family snapshot when only an old token is revoked", async () => {
    const current = contextFor("current", "shared-token-family");
    const old = contextFor("old", "shared-token-family");
    const fixture = await createDatabaseFixture({
      contexts: [current, old],
      rooms: [{ roomId: "token-scope-room", messageCount: 2 }],
    });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      clock: () => 2_000,
      limits: { maxRecordsPerPage: 1 },
      revalidate: async ({ context }) => {
        if (context.sessionId === old.sessionId) {
          throw new SnapshotWorkerClientError(
            "session_revoked", "Authority command session was revoked");
        }
      },
    });
    const page0 = await client.beginRoomRepair(current, "token-build", "token-scope-room");
    if ("kind" in page0 && page0.kind === "fallback") throw new Error("unexpected fallback");
    await expect(client.readRoomRepairPage(old, "old-token", page0.snapshotId, 0))
      .rejects.toMatchObject({ status: 403, code: "session_revoked" });
    await expect(client.readRoomRepairPage(current, "current-token", page0.snapshotId, 0))
      .resolves.toMatchObject({ snapshotId: page0.snapshotId, page: 1 });
    await expect((client as typeof client & { cacheCountForTest(): Promise<number> })
      .cacheCountForTest()).resolves.toBe(1);
    await client.close();
  });

  it("rebuilds a future derived schema but fails closed on same-version corruption", async () => {
    const fixture = await createDatabaseFixture();
    const future = new DatabaseSync(fixture.cachePath);
    future.exec("CREATE TABLE future_cache (value TEXT) STRICT; PRAGMA user_version = 2");
    future.close();
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    });
    await expect(client.beginWorkspaceBootstrap(fixture.contexts[0]!, "future-rebuilt"))
      .resolves.toMatchObject({ page: 0, rooms: [] });
    await client.close();
    const rebuilt = new DatabaseSync(fixture.cachePath);
    rebuilt.exec("ALTER TABLE repair_snapshot_pages DROP COLUMN canonical_bytes");
    rebuilt.close();
    await expect(createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined,
    })).rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
    await Promise.all(["", "-wal", "-shm"].map((suffix) =>
      rm(`${fixture.cachePath}${suffix}`, { force: true })));
    const retry = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    });
    await expect(retry.beginWorkspaceBootstrap(fixture.contexts[0]!, "retry-after-init-error"))
      .resolves.toMatchObject({ page: 0 });
    await retry.close();
  });

  it("rejects disabled or nonfinite safety limits at construction", async () => {
    const fixture = await createDatabaseFixture();
    const invalidValues = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of invalidValues) {
      await expect(createSnapshotWorkerClient({
        authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
        revalidate: async () => undefined,
        limits: { buildDeadlineMs: value },
      })).rejects.toBeInstanceOf(TypeError);
    }
    await expect(createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined,
      limits: { maxConcurrentBuilds: 2 },
    })).rejects.toBeInstanceOf(TypeError);
  });

  it("returns closed internal quota, deadline, and WAL-growth fallback signals", async () => {
    const fixture = await createDatabaseFixture({ rooms: [{ roomId: "fallback-room", messageCount: 400 }] });
    const context = fixture.contexts[0]!;
    const quota = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { cacheQuotaBytes: 1 },
    });
    await expect(quota.beginWorkspaceBootstrap(context, "quota"))
      .resolves.toEqual({ kind: "fallback", reason: "quota" });
    await quota.close();
    const quotaCache = new DatabaseSync(fixture.cachePath, { readOnly: true });
    expect(quotaCache.prepare("SELECT COUNT(*) AS count FROM repair_snapshots").get()?.count)
      .toBe(0);
    quotaCache.close();

    const deadlineCache = join(fixture.directory, "deadline-cache.sqlite");
    const deadline = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: fixture.authorityPath, cachePath: deadlineCache,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { buildDeadlineMs: 1 },
    });
    const deadlineBuild = deadline.client.beginRoomRepair(context, "deadline", "fallback-room");
    await deadline.hooks.waitForFixedView();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    deadline.hooks.continueBuild();
    await expect(deadlineBuild).resolves.toEqual({ kind: "fallback", reason: "deadline" });
    await deadline.client.close();

    const walCache = join(fixture.directory, "wal-cache.sqlite");
    const wal = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: fixture.authorityPath, cachePath: walCache,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { maxWalGrowthBytes: 1 },
    });
    const walBuild = wal.client.beginWorkspaceBootstrap(context, "wal-growth");
    await wal.hooks.waitForFixedView();
    const writer = new DatabaseSync(fixture.authorityPath);
    writer.prepare("UPDATE actors SET display_name = 'WAL growth' WHERE id = ?")
      .run(context.principal.actorId);
    writer.close();
    wal.hooks.continueBuild();
    await expect(walBuild).resolves.toEqual({ kind: "fallback", reason: "wal-growth" });
    await wal.client.close();
  });

  it("reclaims expired logical quota without deleting an active snapshot", async () => {
    const fixture = await createDatabaseFixture();
    const cache = new DatabaseSync(fixture.cachePath);
    migrateSnapshotCacheDatabase(cache);
    const insertManifest = cache.prepare(
      `INSERT INTO repair_snapshots (
         snapshot_id, kind, principal_id, session_family_id, room_id,
         access_revision, watermark, catalog_revision, checksum, page_count,
         expires_at, reuse_key, complete, invalid
       ) VALUES (?, 'catalog', ?, ?, NULL, NULL, NULL, 99, ?, 1, ?, ?, 1, 0)`,
    );
    const insertPage = cache.prepare(
      `INSERT INTO repair_snapshot_pages (
         snapshot_id, page_number, payload_json, canonical_bytes
       ) VALUES (?, 0, ?, ?)`,
    );
    insertManifest.run("expired-filler", "other", "expired-family", "expired", 1_000,
      "expired-reuse");
    const filler = JSON.stringify(["x".repeat(400_000)]);
    insertPage.run("expired-filler", filler, Buffer.byteLength(filler));
    insertManifest.run("active-snapshot", "other", "active-family", "active", 1_000_000,
      "active-reuse");
    insertPage.run("active-snapshot", "[]", 2);
    cache.close();

    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
      limits: { cacheQuotaBytes: 128 * 1_024 },
    });
    await expect(client.beginWorkspaceBootstrap(fixture.contexts[0]!, "quota-after-ttl"))
      .resolves.toMatchObject({ page: 0, mode: "materialized" });
    await client.close();

    const inspected = new DatabaseSync(fixture.cachePath, { readOnly: true });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM repair_snapshots").get()?.count)
      .toBe(2);
    expect(inspected.prepare(
      "SELECT 1 AS present FROM repair_snapshots WHERE snapshot_id = 'active-snapshot'",
    ).get()).toEqual({ present: 1 });
    expect(inspected.prepare(
      "SELECT 1 AS present FROM repair_snapshots WHERE snapshot_id = 'expired-filler'",
    ).get()).toBeUndefined();
    inspected.close();
  });

  it("rejects queue overflow with 429 while a real build is paused", async () => {
    const blockerFixture = await createDatabaseFixture({ rooms: [{ roomId: "queue-blocker" }] });
    const fixture = await createDatabaseFixture({ rooms: Array.from({ length: 18 }, (_, index) => ({
      roomId: `queue-room-${index}`, messageCount: 0,
    })) });
    const context = fixture.contexts[0]!;
    const paused = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: blockerFixture.authorityPath, cachePath: blockerFixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    });
    const second = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    });
    const first = paused.client.beginRoomRepair(
      blockerFixture.contexts[0]!, "queue-blocker", "queue-blocker");
    await paused.hooks.waitForFixedView();
    const queued = Array.from({ length: 16 }, (_, index) =>
      second.beginRoomRepair(context, `queue-${index + 1}`, `queue-room-${index + 1}`));
    await expect(second.beginRoomRepair(context, "queue-overflow", "queue-room-17"))
      .rejects.toMatchObject({ status: 429, code: "snapshot_busy" });
    paused.hooks.continueBuild();
    await expect(Promise.all([first, ...queued])).resolves.toHaveLength(17);
    await paused.client.close();
    await second.close();
  });

  it("serializes builds globally across independent authority/cache identities", async () => {
    const firstFixture = await createDatabaseFixture({ rooms: [{ roomId: "parallel-a" }] });
    const secondFixture = await createDatabaseFixture({ rooms: [{ roomId: "parallel-b" }] });
    const first = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: firstFixture.authorityPath, cachePath: firstFixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    });
    const second = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: secondFixture.authorityPath, cachePath: secondFixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    });
    const firstBuild = first.client.beginRoomRepair(
      firstFixture.contexts[0]!, "parallel-first", "parallel-a");
    const secondBuild = second.client.beginRoomRepair(
      secondFixture.contexts[0]!, "parallel-second", "parallel-b");
    await first.hooks.waitForFixedView();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(first.hooks.fixedViewReached()).toBe(true);
    const secondReachedWhileFirstActive = second.hooks.fixedViewReached();
    first.hooks.continueBuild();
    await second.hooks.waitForFixedView();
    second.hooks.continueBuild();
    await expect(Promise.all([firstBuild, secondBuild])).resolves.toHaveLength(2);
    await first.client.close();
    await second.client.close();
    expect(secondReachedWhileFirstActive).toBe(false);
  });

  it("shares one process-level build slot and queue across clients for the same canonical paths", async () => {
    const fixture = await createDatabaseFixture({ rooms: [{ roomId: "global-room", messageCount: 1 }] });
    const context = fixture.contexts[0]!;
    const options = {
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: async () => undefined,
      clock: () => 2_000,
    };
    const first = await createSnapshotWorkerClientWithPauseForTest(options);
    const second = await createSnapshotWorkerClientWithPauseForTest(options);
    const firstBuild = first.client.beginRoomRepair(context, "global-first", "global-room");
    const secondBuild = second.client.beginRoomRepair(context, "global-second", "global-room");
    await first.hooks.waitForFixedView();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondReachedWhileFirstActive = second.hooks.fixedViewReached();
    first.hooks.continueBuild();
    await expect(Promise.all([firstBuild, secondBuild])).resolves.toHaveLength(2);
    await first.client.close();
    await second.client.close();

    expect(secondReachedWhileFirstActive).toBe(false);
    const replacement = await createSnapshotWorkerClient(options);
    await expect(replacement.beginWorkspaceBootstrap(context, "global-replacement"))
      .resolves.toMatchObject({ page: 0 });
    await replacement.close();
  });

  it("fails terminally on malformed worker envelopes", async () => {
    class MalformedTransport extends EventEmitter implements SnapshotWorkerTransport {
      postMessage(request: SnapshotWorkerRequest): void {
        queueMicrotask(() => this.emit("message", request.type === "snapshot.initialize"
          ? { type: "snapshot.ready", requestId: request.requestId }
          : { type: "snapshot.page", requestId: request.requestId, unexpected: true }));
      }
      async terminate(): Promise<number> { return 0; }
    }
    const transport = new MalformedTransport();
    const client = await createSnapshotWorkerClientForTest({
      authorityPath: "/not-opened/authority.sqlite",
      cachePath: "/not-opened/cache.sqlite",
      revalidate: async () => undefined,
    }, () => transport);
    const first = await client.beginWorkspaceBootstrap(contextFor("malformed"), "malformed")
      .then(() => undefined, (error: unknown) => error);
    const later = await client.beginWorkspaceBootstrap(contextFor("malformed"), "later")
      .then(() => undefined, (error: unknown) => error);
    expect(first).toMatchObject({ status: 503, code: "snapshot_worker_protocol_error" });
    expect(later).toBe(first);

    const fixture = await createDatabaseFixture({ rooms: [{ roomId: "after-terminal" }] });
    const replacement = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: async () => undefined, clock: () => 2_000,
    });
    const replacementBuild = replacement.client.beginRoomRepair(
      fixture.contexts[0]!, "after-terminal", "after-terminal");
    await replacement.hooks.waitForFixedView();
    replacement.hooks.continueBuild();
    await expect(replacementBuild).resolves.toMatchObject({ page: 0 });
    await replacement.client.close();
  });

  it("fails terminally when a valid worker envelope is correlated to the wrong operation", async () => {
    class MismatchedTransport extends EventEmitter implements SnapshotWorkerTransport {
      postMessage(request: SnapshotWorkerRequest): void {
        queueMicrotask(() => {
          if (request.type === "snapshot.initialize") {
            this.emit("message", { type: "snapshot.ready", requestId: request.requestId });
            return;
          }
          if (request.type === "snapshot.begin-room") {
            const snapshotId = "malicious-snapshot";
            this.emit("message", {
              type: "snapshot.page", requestId: request.requestId,
              manifest: {
                snapshotId, principalId: request.context.principal.actorId,
                sessionFamilyId: request.context.sessionFamilyId, checksum: "checksum",
                pageCount: 2, expiresAt: "2026-08-11T01:00:00.000Z", kind: "room",
                roomId: request.roomId, accessRevision: 7, watermark: 0,
              },
              page: {
                type: "room.repair.page", requestId: request.responseRequestId,
                snapshotId, roomId: request.roomId, page: 1, records: [], watermark: 0,
                snapshotChecksum: "checksum", hasMore: true, mode: "materialized",
                expiresAt: "2026-08-11T01:00:00.000Z",
              },
            });
          }
        });
      }
      async terminate(): Promise<number> { return 0; }
    }
    const client = await createSnapshotWorkerClientForTest({
      authorityPath: "/not-opened/authority-mismatch.sqlite",
      cachePath: "/not-opened/cache-mismatch.sqlite",
      revalidate: async () => undefined,
    }, () => new MismatchedTransport());
    await expect(client.beginRoomRepair(
      contextFor("mismatch"), "public-request", "room-mismatch",
    )).rejects.toMatchObject({ status: 503, code: "snapshot_worker_protocol_error" });
  });

  it("keeps raw snapshot worker, cache path, and fault hooks off the package root", async () => {
    const publicApi: Record<string, unknown> = await import("../index.js");
    expect(publicApi).not.toHaveProperty("createSnapshotWorkerClient");
    expect(publicApi).not.toHaveProperty("createSnapshotWorkerClientForTest");
    expect(publicApi).not.toHaveProperty("createSnapshotWorkerClientWithPauseForTest");
    expect(publicApi).not.toHaveProperty("SNAPSHOT_CACHE_SCHEMA_VERSION");
  });
});
