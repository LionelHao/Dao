import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToVersion3ForTest,
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
  type StreamingRepairAuthority,
  type SnapshotWorkerTransport,
} from "./snapshot-worker-client.js";
import type {
  AuthenticatedSessionContext,
  SnapshotWorkerRequest,
  StreamingRepairLease,
} from "./contracts.js";
import { mintInternalAgentCommandContext } from "./contracts.js";
import {
  createLegacyMessageAuthorityInserter,
  insertLegacyMessageAuthorityRecord,
} from "./message-authority-legacy-adapter.js";
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
    `INSERT OR IGNORE INTO session_families (
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
    tokenHash(`refresh-${context.sessionId}`),
  );
}

function seedRoom(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  messageCount = 0,
  body: (index: number) => string = (index) => `message-${index}`,
  agentMessage?: { readonly index: number; readonly actorId: string },
): void {
  database.prepare(
    "INSERT INTO rooms (id, name, status, created_at) VALUES (?, ?, 'active', ?)",
  ).run(roomId, `Room ${roomId}`, "2026-08-11T00:00:00.000Z");
  database.prepare(
    `INSERT INTO room_memberships (
       room_id, actor_id, kind, role, participation, tool_permissions_json,
       joined_at, configured_at, access_revision
     ) VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 7)`,
  ).run(roomId, context.principal.actorId, "2026-08-11T00:00:00.000Z");
  database.prepare(
    "UPDATE rooms SET owner_actor_id = ?, governance_revision = 1 WHERE id = ?",
  ).run(context.principal.actorId, roomId);
  database.prepare(
    `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
     VALUES ('room', ?, ?, 1)`,
  ).run(roomId, messageCount);
  const insertMessage = createLegacyMessageAuthorityInserter(database);
  for (let index = 0; index < messageCount; index += 1) {
    const agentAuthored = agentMessage?.index === index;
    insertMessage({
      id: `message-${String(index).padStart(4, "0")}`,
      roomId,
      authorId: agentAuthored ? agentMessage.actorId : context.principal.actorId,
      authorKind: agentAuthored ? "agent" : "human",
      body: body(index),
      sentAt: new Date(Date.UTC(2026, 7, 11, 0, 0, index)).toISOString(),
    });
  }
}

function seedClosedMixedStressRecords(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
): void {
  database.prepare(
    `INSERT OR IGNORE INTO actors (
       id, kind, display_name, reachability, readiness, tool_permissions_json
     ) VALUES ('stress-agent', 'agent', 'Stress Agent', NULL, 'ready', '["review.read"]')`,
  ).run();
  database.prepare(
    `INSERT OR IGNORE INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
     VALUES ('identity', 'stress-agent', 0, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO room_memberships (
       room_id, actor_id, kind, role, participation, tool_permissions_json,
       joined_at, configured_at, access_revision
     ) VALUES (?, 'stress-agent', 'agent', NULL, 'active', '["review.read"]',
       NULL, '2026-08-11T00:00:00.000Z', 1)`,
  ).run(roomId);
  database.prepare(
    `INSERT INTO human_read_receipts (room_id, actor_id, message_id, read_at)
     VALUES (?, ?, 'message-0000', '2026-08-11T01:00:00.000Z')`,
  ).run(roomId, context.principal.actorId);
  const judgment = { id: "stress-judgment", messageId: "message-0000",
    agentId: "stress-agent", outcome: "will_respond", reason: "stress",
    decidedAt: "2026-08-11T01:00:01.000Z" };
  database.prepare(
    `INSERT INTO agent_judgments (
       id, room_id, agent_id, message_id, judgment_json, created_at
     ) VALUES ('stress-judgment', ?, 'stress-agent', 'message-0000', ?, ?)`,
  ).run(roomId, JSON.stringify(judgment), judgment.decidedAt);
  database.prepare(
    `INSERT INTO open_items (
       id, room_id, source_message_id, current_owner_actor_id, status, body,
       created_at, responded_at, requester_actor_id, transfer_chain_json,
       origin_kind, proposal_kind, source_execution_id, proposal_reason
     ) VALUES ('stress-open', ?, 'message-0000', 'stress-agent', 'awaiting',
       'stress item', '2026-08-11T01:00:02.000Z', NULL, ?, '[]',
       'manual_unfinished', NULL, NULL, NULL)`,
  ).run(roomId, context.principal.actorId);
  database.prepare(
    `INSERT INTO light_tasks (
       id, room_id, source_message_id, title, verifier_role, criteria_json,
       status, created_at
     ) VALUES ('stress-light-task', ?, 'message-0000', 'stress task', 'owner', ?,
       'todo', '2026-08-11T01:00:02.500Z')`,
  ).run(roomId, JSON.stringify([{ id: "stress-criterion", text: "checked", met: false }]));
  database.prepare(
    `INSERT INTO agent_executions (
       id, room_id, agent_id, trigger_message_id, status, started_at,
       completed_at, result_json, requester_actor_id, tool_name,
       action_category, tool_dispatch_phase, queued_at, updated_at
     ) VALUES ('stress-execution', ?, 'stress-agent', 'message-0000', 'completed',
       '2026-08-11T01:00:03.000Z', '2026-08-11T01:00:04.000Z', '"ok"', ?, 'review',
       'tool_call', 'finished', '2026-08-11T01:00:03.000Z', '2026-08-11T01:00:04.000Z')`,
  ).run(roomId, context.principal.actorId);
  database.prepare(
    `INSERT INTO calibration_signals (
       id, room_id, agent_id, judgment_id, signal, created_at, source_message_id, actor_id
     ) VALUES ('stress-calibration', ?, 'stress-agent', NULL, '👍',
       '2026-08-11T01:00:05.000Z', 'message-9999', ?)`,
  ).run(roomId, context.principal.actorId);
}

async function createDatabaseFixture(options: {
  readonly rooms?: readonly { readonly roomId: string; readonly messageCount?: number;
    readonly body?: (index: number) => string;
    readonly agentMessage?: { readonly index: number; readonly actorId: string } }[];
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
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const context of contexts) seedHuman(database, context, options.catalogRevision ?? 0);
    for (const room of options.rooms ?? []) {
      if (room.agentMessage !== undefined) {
        database.prepare(
          `INSERT OR IGNORE INTO actors (
             id, kind, display_name, reachability, readiness, tool_permissions_json
           ) VALUES (?, 'agent', 'Stress Agent', NULL, 'ready', '["review.read"]')`,
        ).run(room.agentMessage.actorId);
      }
    }
    for (const room of options.rooms ?? []) {
      seedRoom(database, contexts[0]!, room.roomId, room.messageCount,
        room.body ?? ((index) => `message-${index}`), room.agentMessage);
    }
    database.exec("COMMIT");
  } catch (cause: unknown) {
    database.exec("ROLLBACK");
    throw cause;
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
    expect(page0.records.map((record) => record.kind)).toEqual(["room", "governance"]);
    expect(page0.records[1]).toMatchObject({ kind: "governance", value: {
      roomId: "room-page", projectId: "room-page", ownerActorId: context.principal.actorId,
    } });

    const page1 = await client.readRoomRepairPage(
      context, "read-page-one", page0.snapshotId, 0,
    );
    expect(page1).toMatchObject({ requestId: "read-page-one", page: 1, hasMore: true });
    expect(page1.snapshotChecksum).toBe(page0.snapshotChecksum);
    const page2 = await client.readRoomRepairPage(
      context, "read-page-two", page0.snapshotId, 1,
    );
    expect(page2).toMatchObject({ requestId: "read-page-two", page: 2, hasMore: true });
    const page3 = await client.readRoomRepairPage(
      context, "read-page-three", page0.snapshotId, 2,
    );
    expect(page3).toMatchObject({ requestId: "read-page-three", page: 3, hasMore: false });
    await expect(client.readRoomRepairPage(context, "past-end", page0.snapshotId, 3))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(client.readRoomRepairPage(context, "negative", page0.snapshotId, -1))
      .rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await client.close();
  });

  it("stores message references without raw bodies in the materialized cache or WAL", async () => {
    const raw = "MATERIALIZED-MESSAGE-RAW-SENTINEL-4E71";
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "room-reference-cache", messageCount: 1, body: () => raw }],
    });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: async () => undefined,
      clock: () => 2_000,
      limits: { maxRecordsPerPage: 1 },
    });
    try {
      await expect(client.beginRoomRepair(
        fixture.contexts[0]!, "reference-cache", "room-reference-cache",
      )).resolves.toMatchObject({ mode: "materialized" });
      const cache = new DatabaseSync(fixture.cachePath, { readOnly: true });
      const payloads = cache.prepare(
        "SELECT payload_json AS payloadJson FROM repair_snapshot_pages ORDER BY page_number",
      ).all();
      cache.close();
      expect(JSON.stringify(payloads)).not.toContain(raw);
      const physical = await Promise.all(["", "-wal", "-shm"].map(async (suffix) =>
        readFile(`${fixture.cachePath}${suffix}`).catch(() => Buffer.alloc(0))));
      expect(Buffer.concat(physical).includes(Buffer.from(raw))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("rejects a materialized continuation before hydration when the Room watermark changed", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{
        roomId: "room-stale-message-cache",
        messageCount: 1,
        body: () => "STALE-MATERIALIZED-MESSAGE-SENTINEL-8B2C",
      }],
    });
    const context = fixture.contexts[0]!;
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: async () => undefined,
      clock: () => 2_000,
      limits: { maxRecordsPerPage: 1 },
    });
    try {
      const page0 = await client.beginRoomRepair(
        context, "stale-cache-begin", "room-stale-message-cache",
      );
      if ("kind" in page0 && page0.kind === "fallback") throw new Error("unexpected fallback");
      const authority = new DatabaseSync(fixture.authorityPath);
      authority.prepare(
        `INSERT INTO message_recall_fences (
           fence_id, room_id, source_message_id, source_revision, scope_kind,
           invocation_intent_id, execution_id, reason, created_at
         ) VALUES (
           'stale-cache-fence', 'room-stale-message-cache', 'message-0000', 1,
           'message', NULL, NULL, 'message_recalled', '2026-08-11T00:01:00.000Z'
         )`,
      ).run();
      authority.prepare(
        `UPDATE message_envelopes
         SET lifecycle = 'recalled', recalled_at = '2026-08-11T00:01:00.000Z',
             recalled_by_actor_id = ?
         WHERE message_id = 'message-0000'`,
      ).run(context.principal.actorId);
      authority.prepare(
        `UPDATE streams SET head_seq = head_seq + 1
         WHERE stream_kind = 'room' AND stream_id = 'room-stale-message-cache'`,
      ).run();
      authority.close();

      await expect(client.readRoomRepairPage(
        context, "stale-cache-next", page0.snapshotId, 0,
      )).rejects.toMatchObject({ code: "snapshot_stale" });
    } finally {
      await client.close();
    }
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
    insertLegacyMessageAuthorityRecord(database, {
      id: "message-agent", roomId: "room-mixed", authorId: "agent-a",
      authorKind: "agent", body: "agent answer", sentAt: "2026-08-11T00:00:03.000Z",
    });
    insertLegacyMessageAuthorityRecord(database, {
      id: "message-human", roomId: "room-mixed", authorId: context.principal.actorId,
      authorKind: "human", body: "question", sentAt: "2026-08-11T00:00:02.000Z",
    });
    insertLegacyMessageAuthorityRecord(database, {
      id: "message-recalled", roomId: "room-mixed", authorId: context.principal.actorId,
      authorKind: "human", body: "RECALLED-SNAPSHOT-RAW-SENTINEL",
      sentAt: "2026-08-11T00:00:02.500Z",
    });
    database.prepare(
      `INSERT INTO message_recall_fences (
         fence_id, room_id, source_message_id, source_revision, scope_kind,
         invocation_intent_id, execution_id, reason, created_at
       ) VALUES (
         'fence-message-recalled', 'room-mixed', 'message-recalled', 1, 'message',
         NULL, NULL, 'message_recalled', '2026-08-11T00:00:03.500Z'
       )`,
    ).run();
    database.prepare(
      `UPDATE message_envelopes
       SET lifecycle = 'recalled', recalled_at = '2026-08-11T00:00:03.500Z',
           recalled_by_actor_id = ?
       WHERE message_id = 'message-recalled'`,
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
         id, room_id, source_message_id, current_owner_actor_id, status, body,
         created_at, responded_at, requester_actor_id, transfer_chain_json,
         origin_kind, proposal_kind, source_execution_id, proposal_reason
       ) VALUES ('open-a', 'room-mixed', 'message-human', 'agent-a',
         'awaiting', 'respond', '2026-08-11T00:00:06.000Z', NULL, ?, '[]',
         'manual_unfinished', NULL, NULL, NULL)`,
    ).run(context.principal.actorId);
    database.prepare(
      `INSERT INTO light_tasks (
         id, room_id, source_message_id, title, verifier_role, criteria_json,
         status, created_at
       ) VALUES ('light-task-a', 'room-mixed', 'message-human', '完成评审', 'owner', ?,
         'todo', '2026-08-11T00:00:06.500Z')`,
    ).run(JSON.stringify([{ id: "criterion-a", text: "评审通过", met: false }]));
    database.prepare(
      `INSERT INTO agent_executions (
         id, room_id, agent_id, trigger_message_id, status, started_at,
         completed_at, result_json, requester_actor_id, tool_name,
         action_category, tool_dispatch_phase, queued_at, updated_at,
         terminal_error_code, dead_lettered_at
       ) VALUES ('execution-a', 'room-mixed', 'agent-a', 'message-human', 'failed',
         '2026-08-11T00:00:07.000Z', '2026-08-11T00:00:08.000Z', NULL, ?, 'tool',
         'tool_call', 'finished', '2026-08-11T00:00:07.000Z', '2026-08-11T00:00:08.000Z',
         'provider_failure', '2026-08-11T00:00:08.000Z')`,
    ).run(context.principal.actorId);
    database.exec(`
      INSERT INTO agent_execution_attempts (
        execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
        action_category, started_at, finished_at, error_code, recovery_cursor
      ) VALUES ('execution-a', 1, 1, 1, 'failed', 'tool_call',
        '2026-08-11T00:00:07.000Z', '2026-08-11T00:00:08.000Z', 'provider_failure', 0);
      INSERT INTO open_item_agent_failures (
        id, open_item_id, execution_id, attempt_seq, reason_code, failed_at
      ) VALUES ('open-failure-a', 'open-a', 'execution-a', 1,
        'provider_failure', '2026-08-11T00:00:08.000Z');
    `);
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
      "room", "governance", "membership", "membership", "timeline-message",
      "timeline-message", "timeline-message", "human-read", "agent-judgement", "open-item",
      "open-item-agent-failure", "light-task", "agent-execution", "calibration",
    ]);
    const timelineMessages = page.records.filter((record) =>
      record.kind === "timeline-message").map((record) => record.value);
    expect(timelineMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "message-human", lifecycle: "active",
        currentRevision: expect.objectContaining({ body: "question" }) }),
      expect.objectContaining({ id: "message-agent", authorKind: "agent",
        finalBody: "agent answer" }),
      {
        id: "message-recalled", roomId: "room-mixed",
        authorId: context.principal.actorId, authorKind: "human",
        createdAt: "2026-08-11T00:00:02.500Z", lifecycle: "recalled",
        recalledAt: "2026-08-11T00:00:03.500Z", revisionCount: 1,
      },
    ]));
    expect(JSON.stringify(page)).not.toContain("RECALLED-SNAPSHOT-RAW-SENTINEL");
    expect(page.records.find((record) => record.kind === "light-task"))
      .toMatchObject({ kind: "light-task", value: {
        id: "light-task-a", status: "todo", claimant: null, verifierRole: "owner",
        criteria: [{ id: "criterion-a", text: "评审通过", met: false }],
      } });
    expect(page.records.find((record) => record.kind === "open-item-agent-failure"))
      .toEqual({ kind: "open-item-agent-failure", value: {
        id: "open-failure-a", openItemId: "open-a", executionId: "execution-a",
        attemptSeq: 1, reasonCode: "provider_failure", failedAt: "2026-08-11T00:00:08.000Z",
      } });
    await client.close();
  });

  it("materializes migrated v3 calibration as explicit legacy unknowns without invented ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-snapshot-v3-calibration-"));
    temporaryDirectories.push(directory);
    const authorityPath = join(directory, "authority.sqlite");
    const cachePath = join(directory, "snapshot-cache.sqlite");
    const context = contextFor("legacy-calibration");
    const database = new DatabaseSync(authorityPath);
    migrateAuthorityDatabaseToVersion3ForTest(database);
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
    const maxPageBytes = 2_000;
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
    expect(pages.flatMap((entry) => entry.records)).toHaveLength(6);
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

  it("purges only committed same-Room snapshots through the production cache adapter", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [
        { roomId: "room-purge", messageCount: 2 },
        { roomId: "room-preserve", messageCount: 0 },
      ],
    });
    const context = fixture.contexts[0]!;
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: async () => undefined,
      clock: () => 2_000,
    });
    const purged = await client.beginRoomRepair(context, "purge-build", "room-purge");
    const preserved = await client.beginRoomRepair(context, "preserve-build", "room-preserve");
    if (("kind" in purged && purged.kind === "fallback") ||
        ("kind" in preserved && preserved.kind === "fallback")) {
      throw new Error("unexpected fallback");
    }

    await client.purgeCommittedRoom({
      invalidationIntentId: "intent-room-purge",
      roomId: "room-purge",
      lifecycleGeneration: 1,
      accessRevision: 7,
      reason: "room_archived",
    });
    await expect(client.readRoomRepairPage(
      context,
      "purged-read",
      purged.snapshotId,
      0,
    )).rejects.toMatchObject({ status: 404, code: "snapshot_not_found" });
    await expect(client.beginRoomRepair(
      context,
      "preserved-reuse",
      "room-preserve",
    )).resolves.toMatchObject({ snapshotId: preserved.snapshotId });
    await client.close();
  });

  it("purges only the removed Human cache slice for a targeted invalidation", async () => {
    const target = contextFor("target");
    const peer = {
      ...contextFor("peer"),
      principal: { accountId: "account-peer", actorId: "human-peer" },
    };
    const fixture = await createDatabaseFixture({
      contexts: [target, peer],
      rooms: [{ roomId: "room-target-purge", messageCount: 1 }],
    });
    const authority = new DatabaseSync(fixture.authorityPath);
    authority.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 7)`,
    ).run("room-target-purge", peer.principal.actorId, "2026-08-11T00:00:00.000Z");
    authority.close();

    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: async () => undefined,
      clock: () => 2_000,
    });
    const targetSnapshot = await client.beginRoomRepair(
      target,
      "target-build",
      "room-target-purge",
    );
    const peerSnapshot = await client.beginRoomRepair(
      peer,
      "peer-build",
      "room-target-purge",
    );
    if (("kind" in targetSnapshot && targetSnapshot.kind === "fallback") ||
        ("kind" in peerSnapshot && peerSnapshot.kind === "fallback")) {
      throw new Error("unexpected fallback");
    }

    await client.purgeCommittedRoom({
      invalidationIntentId: "intent-target-purge",
      roomId: "room-target-purge",
      lifecycleGeneration: 0,
      accessRevision: 8,
      reason: "member_removed",
      targetActorId: target.principal.actorId,
    });
    await expect(client.readRoomRepairPage(
      target,
      "target-invalidated",
      targetSnapshot.snapshotId,
      0,
    )).rejects.toMatchObject({ status: 404, code: "snapshot_not_found" });
    await expect(client.beginRoomRepair(
      peer,
      "peer-reuse",
      "room-target-purge",
    )).resolves.toMatchObject({ snapshotId: peerSnapshot.snapshotId });
    await client.close();
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

  it("keeps main/AuthorityWorker responsive and preserves a snapshot when unsafe removal fails closed", async () => {
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
    seedRoom(seed, owner, "race-room", 8);
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
    await expect(authority.executeHuman({
      ...owner, kind: "human", requestId: "remove-target",
      idempotencyKey: "remove-target",
    }, { type: "member.remove", roomId: "race-room",
      payload: { targetActorId: target.principal.actorId } }, 2_001))
      .rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
    paused.hooks.continueBuild();

    await expect(beginning).resolves.toMatchObject({ mode: "materialized", page: 0 });
    await expect(paused.client.cacheCountForTest()).resolves.toBe(1);
    await paused.client.close();
    await authority.close();
  });

  it("revalidates every later page and preserves cache after unsafe removal fails closed", async () => {
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
    await expect(authority.executeHuman({ ...owner, kind: "human", requestId: "page-remove",
      idempotencyKey: "page-remove" }, { type: "member.remove", roomId: "page-auth-room",
      payload: { targetActorId: target.principal.actorId } }, 2_001))
      .rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
    await expect(paused.client.readRoomRepairPage(
      target, "page-auth-one", page0.snapshotId, 0,
    )).resolves.toMatchObject({ page: 1 });
    await expect(paused.client.cacheCountForTest()).resolves.toBe(1);
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
    future.exec("CREATE TABLE future_cache (value TEXT) STRICT; PRAGMA user_version = 3");
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

  it("rebuilds a v1 cache before serving so legacy raw page payloads cannot survive upgrade", async () => {
    const raw = "LEGACY-SNAPSHOT-CACHE-RAW-SENTINEL-7C19";
    const fixture = await createDatabaseFixture();
    const legacy = new DatabaseSync(fixture.cachePath);
    migrateSnapshotCacheDatabase(legacy);
    legacy.prepare(
      `INSERT INTO repair_snapshots (
         snapshot_id, kind, principal_id, session_family_id, room_id,
         access_revision, watermark, catalog_revision, checksum, page_count,
         expires_at, reuse_key, complete, invalid
       ) VALUES (
         'legacy-v1-raw', 'catalog', 'human-a', 'legacy-family', NULL,
         NULL, NULL, 0, 'legacy-checksum', 1, 999999, 'legacy-reuse', 1, 0
       )`,
    ).run();
    const legacyPayload = JSON.stringify([{ kind: "message", value: { body: raw } }]);
    legacy.prepare(
      `INSERT INTO repair_snapshot_pages (
         snapshot_id, page_number, payload_json, canonical_bytes
       ) VALUES ('legacy-v1-raw', 0, ?, ?)`,
    ).run(legacyPayload, Buffer.byteLength(legacyPayload));
    legacy.exec("PRAGMA user_version = 1");
    legacy.close();

    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: async () => undefined,
      clock: () => 2_000,
    });
    try {
      await expect((client as typeof client & { cacheCountForTest(): Promise<number> })
        .cacheCountForTest()).resolves.toBe(0);
      const physical = await Promise.all(["", "-wal", "-shm"].map(async (suffix) =>
        readFile(`${fixture.cachePath}${suffix}`).catch(() => Buffer.alloc(0))));
      expect(Buffer.concat(physical).includes(Buffer.from(raw))).toBe(false);
    } finally {
      await client.close();
    }
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

  it("automatically streams after quota fallback and fences only the repaired room", async () => {
    const original = contextFor("stream-original", "stream-family");
    const refreshed = contextFor("stream-refreshed", "stream-family");
    const otherFamily = contextFor("stream-other", "stream-other-family");
    const fixture = await createDatabaseFixture({
      contexts: [original, refreshed, otherFamily],
      rooms: [
        { roomId: "stream-room", messageCount: 10_000,
          agentMessage: { index: 9_999, actorId: "stress-agent" } },
        { roomId: "unrelated-room", messageCount: 0 },
      ],
    });
    const normalized = new DatabaseSync(fixture.authorityPath);
    normalized.prepare(
      "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room'",
    ).run();
    seedClosedMixedStressRecords(normalized, original, "stream-room");
    normalized.close();
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
      streamingAuthority: authority,
      clock: () => 2_000,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 500 },
    });

    const page0 = await client.beginRoomRepair(original, "stream-page-0", "stream-room");
    expect(page0).toMatchObject({
      type: "room.repair.page",
      requestId: "stream-page-0",
      page: 0,
      mode: "streaming",
      watermark: 0,
      hasMore: true,
    });
    if ("kind" in page0 || page0.mode !== "streaming") {
      throw new Error("expected automatic streaming fallback");
    }

    const humanCommand = {
      ...original,
      kind: "human" as const,
      requestId: "barrier-message",
      idempotencyKey: "barrier-message",
    };
    await expect(authority.executeHuman(humanCommand, {
      type: "message.send",
      roomId: "stream-room",
      payload: {
        id: "barrier-message",
        roomId: "stream-room",
        body: "must not persist",
        sentAt: "2026-08-11T00:00:00.000Z",
      },
    }, 2_001)).rejects.toMatchObject({
      status: 503,
      code: "repair_barrier_active",
      retryAfterMs: 250,
    });
    await expect(authority.executeAgent(mintInternalAgentCommandContext({
      agentId: "stress-agent",
      requestId: "barrier-agent-message",
      idempotencyKey: "barrier-agent-message",
    }), {
      type: "message.send",
      roomId: "stream-room",
      payload: {
        id: "barrier-agent-message",
        roomId: "stream-room",
        body: "agent must not persist",
        sentAt: "2026-08-11T00:00:00.500Z",
      },
    }, 2_001)).rejects.toMatchObject({
      status: 503,
      code: "repair_barrier_active",
      retryAfterMs: 250,
    });
    await expect(authority.executeHuman({
      ...humanCommand,
      requestId: "unrelated-message",
      idempotencyKey: "unrelated-message",
    }, {
      type: "message.send",
      roomId: "unrelated-room",
      payload: {
        id: "unrelated-message",
        roomId: "unrelated-room",
        body: "allowed",
        sentAt: "2026-08-11T00:00:01.000Z",
      },
    }, 2_001)).resolves.toMatchObject({ aggregateId: "unrelated-message" });

    await expect(client.readRoomRepairPage(
      otherFamily, "other-family", page0.snapshotId, 0,
    )).rejects.toMatchObject({ status: 403, code: "snapshot_forbidden" });
    await expect(client.completeSnapshot(
      refreshed,
      "stream-complete-too-early",
      page0.snapshotId,
      { kind: "room", roomId: "stream-room", watermark: 0 },
      page0.snapshotChecksum,
    )).rejects.toMatchObject({ status: 409, code: "snapshot_stale" });
    const records = [...page0.records];
    let page = page0;
    while (page.hasMore) {
      page = await client.readRoomRepairPage(
        refreshed,
        `stream-page-${page.page + 1}`,
        page.snapshotId,
        page.page,
      );
      expect(page.mode).toBe("streaming");
      records.push(...page.records);
    }
    expect(records).toHaveLength(10_010);
    expect(new Set(records.map((record) => record.kind))).toEqual(new Set([
      "room", "governance", "membership", "timeline-message", "human-read", "agent-judgement",
      "open-item", "light-task", "agent-execution", "calibration",
    ]));
    expect(page0.snapshotChecksum).toBe(createHash("sha256")
      .update(canonicalJsonForTest({ kind: "room", values: records, version: 1 }), "utf8")
      .digest("hex"));

    await expect(client.completeSnapshot(
      refreshed,
      "stream-complete",
      page0.snapshotId,
      { kind: "room", roomId: "stream-room", watermark: 0 },
      page0.snapshotChecksum,
    )).resolves.toEqual({
      type: "snapshot.completed",
      requestId: "stream-complete",
      snapshotId: page0.snapshotId,
      version: { kind: "room", roomId: "stream-room", watermark: 0 },
    });
    await expect(client.completeSnapshot(
      refreshed,
      "stream-complete-replay",
      page0.snapshotId,
      { kind: "room", roomId: "stream-room", watermark: 0 },
      page0.snapshotChecksum,
    )).resolves.toMatchObject({ requestId: "stream-complete-replay" });

    await expect(authority.executeHuman({
      ...humanCommand,
      requestId: "after-complete",
      idempotencyKey: "after-complete",
    }, {
      type: "message.send",
      roomId: "stream-room",
      payload: {
        id: "after-complete",
        roomId: "stream-room",
        body: "accepted after complete",
        sentAt: "2026-08-11T00:00:02.000Z",
      },
    }, 2_002)).resolves.toMatchObject({ aggregateId: "after-complete" });

    await authority.revokeSession(original.sessionId, 2_003);
    await expect(client.completeSnapshot(
      original,
      "stream-complete-after-revoke",
      page0.snapshotId,
      { kind: "room", roomId: "stream-room", watermark: 0 },
      page0.snapshotChecksum,
    )).rejects.toMatchObject({ status: 403, code: "snapshot_family_revoked" });

    const inspection = new DatabaseSync(fixture.authorityPath, { readOnly: true });
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE id = 'barrier-message'",
    ).get()?.count).toBe(0);
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_id LIKE '%barrier-message%'",
    ).get()?.count).toBe(0);
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE event_id LIKE '%barrier-message%'",
    ).get()?.count).toBe(0);
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE id = 'barrier-agent-message'",
    ).get()?.count).toBe(0);
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_id LIKE '%barrier-agent-message%'",
    ).get()?.count).toBe(0);
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE event_id LIKE '%barrier-agent-message%'",
    ).get()?.count).toBe(0);
    inspection.close();
    await client.close();
    await authority.close();
  }, 60_000);

  it("replays exact idempotency before the barrier and reports conflicts as 409", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "idempotency-barrier-room", messageCount: 2 }],
    });
    const context = fixture.contexts[0]!;
    const normalized = new DatabaseSync(fixture.authorityPath);
    normalized.prepare(
      "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room' AND stream_id = ?",
    ).run("idempotency-barrier-room");
    normalized.close();
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const commandContext = {
      ...context,
      kind: "human" as const,
      requestId: "idempotency-before-barrier-first",
      idempotencyKey: "idempotency-before-barrier-message",
    };
    const command = {
      type: "message.send" as const,
      roomId: "idempotency-barrier-room",
      payload: {
        id: "idempotency-before-barrier-message",
        roomId: "idempotency-barrier-room",
        body: "stable replay",
        sentAt: "2026-08-11T00:00:00.000Z",
      },
    };
    const first = await authority.executeHuman(commandContext, command, 2_000);
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, 2_001),
      streamingAuthority: authority,
      clock: () => 2_001,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
    });
    const page0 = await client.beginRoomRepair(
      context, "idempotency-before-barrier-zero", "idempotency-barrier-room",
    );
    if ("kind" in page0) throw new Error("expected streaming page zero");

    await expect(authority.executeHuman({
      ...commandContext,
      requestId: "idempotency-before-barrier-replay",
    }, command, 2_002)).resolves.toEqual(first);
    await expect(authority.executeHuman({
      ...commandContext,
      requestId: "idempotency-before-barrier-conflict",
    }, {
      ...command,
      payload: { ...command.payload, body: "changed payload" },
    }, 2_002)).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await client.close();
    await authority.close();
  });

  it.each(["deadline", "wal-growth"] as const)(
    "automatically streams after %s materialization fallback",
    async (reason) => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: `automatic-${reason}`, messageCount: 10_000,
          agentMessage: { index: 9_999, actorId: "stress-agent" } }],
      });
      const context = fixture.contexts[0]!;
      const normalized = new DatabaseSync(fixture.authorityPath);
      normalized.prepare(
        "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room'",
      ).run();
      seedClosedMixedStressRecords(normalized, context, `automatic-${reason}`);
      normalized.close();
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const paused = await createSnapshotWorkerClientWithPauseForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
        limits: reason === "deadline"
          ? { buildDeadlineMs: 1, maxRecordsPerPage: 500 }
          : { maxWalGrowthBytes: 1, maxRecordsPerPage: 500 },
      });
      const beginning = paused.client.beginRoomRepair(
        context, `automatic-${reason}-zero`, `automatic-${reason}`,
      );
      await paused.hooks.waitForFixedView();
      if (reason === "deadline") {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      } else {
        const writer = new DatabaseSync(fixture.authorityPath);
        writer.prepare("UPDATE actors SET display_name = 'WAL fallback' WHERE id = ?")
          .run(context.principal.actorId);
        writer.close();
      }
      paused.hooks.continueBuild();

      const page0 = await beginning;
      expect(page0).toMatchObject({
        type: "room.repair.page",
        requestId: `automatic-${reason}-zero`,
        mode: "streaming",
        page: 0,
        watermark: 0,
      });
      if ("kind" in page0 || page0.mode !== "streaming") {
        throw new Error(`expected ${reason} to use automatic streaming fallback`);
      }
      const records = [...page0.records];
      let page = page0;
      while (page.hasMore) {
        page = await paused.client.readRoomRepairPage(
          context,
          `automatic-${reason}-${page.page + 1}`,
          page.snapshotId,
          page.page,
        );
        expect(page).toMatchObject({
          mode: "streaming",
          watermark: 0,
        });
        records.push(...page.records);
      }
      expect(records).toHaveLength(10_010);
      expect(new Set(records.map((record) => record.kind))).toEqual(new Set([
        "room", "governance", "membership", "timeline-message", "human-read", "agent-judgement",
        "open-item", "light-task", "agent-execution", "calibration",
      ]));
      expect(page0.snapshotChecksum).toBe(createHash("sha256")
        .update(canonicalJsonForTest({ kind: "room", values: records, version: 1 }), "utf8")
        .digest("hex"));
      await expect(paused.client.completeSnapshot(
        context,
        `automatic-${reason}-complete`,
        page0.snapshotId,
        { kind: "room", roomId: `automatic-${reason}`, watermark: 0 },
        page0.snapshotChecksum,
      )).resolves.toMatchObject({
        type: "snapshot.completed",
        version: { kind: "room", roomId: `automatic-${reason}`, watermark: 0 },
      });
      await paused.client.close();
      await authority.close();
    },
  );

  it("rejects streaming page jumps before scanning and replays only the same continuation", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "keyset-room", messageCount: 8 }],
    });
    const context = fixture.contexts[0]!;
    const baseLease = {
      snapshotId: "keyset-snapshot",
      principalId: context.principal.actorId,
      accountId: context.principal.accountId,
      sessionFamilyId: context.sessionFamilyId,
      scope: { kind: "room" as const, roomId: "keyset-room" },
      version: { kind: "room" as const, roomId: "keyset-room", watermark: 8 },
      authorizationRevision: 7,
      idleExpiresAt: "2026-08-11T00:00:30.000Z",
    };
    let attachedLease = baseLease;
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: async () => undefined,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
      streamingAuthority: {
        async acquireStreamingRepair() { return baseLease; },
        async registerStreamingRepair(snapshotId, checksum, pageCount) {
          attachedLease = {
            ...baseLease,
            snapshotId,
            checksum,
            pageCount,
            lastPage: pageCount - 1,
            highestAuthorizedPage: 0,
          };
          return attachedLease;
        },
        async authorizeStreamingRepairPage() { return attachedLease; },
        async completeStreamingRepair(_context, snapshotId, version) {
          return { type: "snapshot.completed" as const, requestId: "internal",
            snapshotId, version };
        },
        async releaseStreamingRepair() {},
      },
      clock: () => 2_000,
    });
    const page0 = await client.beginRoomRepair(context, "keyset-zero", "keyset-room");
    if ("kind" in page0 || page0.mode !== "streaming") throw new Error("expected streaming");

    await expect(client.readRoomRepairPage(
      context, "keyset-skip", page0.snapshotId, 1,
    )).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    const page1 = await client.readRoomRepairPage(
      context, "keyset-one", page0.snapshotId, 0,
    );
    const replay = await client.readRoomRepairPage(
      context, "keyset-one-replay", page0.snapshotId, 0,
    );
    expect(replay).toEqual({ ...page1, requestId: "keyset-one-replay" });
    await client.close();
  });

  it("keyset-scans only one new page for a later streaming continuation", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "keyset-scan-room", messageCount: 400 }],
    });
    const context = fixture.contexts[0]!;
    const normalized = new DatabaseSync(fixture.authorityPath);
    normalized.prepare(
      "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room'",
    ).run();
    normalized.close();
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const paused = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
      streamingAuthority: authority,
      clock: () => 2_000,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 100 },
    });
    const beginning = paused.client.beginRoomRepair(
      context, "keyset-scan-zero", "keyset-scan-room",
    );
    await paused.hooks.waitForFixedView();
    paused.hooks.continueBuild();
    const page0 = await beginning;
    if ("kind" in page0 || page0.mode !== "streaming") throw new Error("expected streaming");
    expect(paused.hooks.streamingPageScanCount()).toBe(99);

    await paused.client.readRoomRepairPage(
      context, "keyset-scan-one", page0.snapshotId, 0,
    );
    expect(paused.hooks.streamingPageScanCount()).toBe(199);
    await paused.client.close();
    await authority.close();
  });

  it("fences only one principal catalog and completes by catalog revision", async () => {
    const alice: AuthenticatedSessionContext = {
      sessionId: tokenHash("catalog-alice-access"),
      sessionFamilyId: tokenHash("catalog-alice-family"),
      principal: { accountId: "catalog-alice-account", actorId: "catalog-alice" },
    };
    const bob: AuthenticatedSessionContext = {
      sessionId: tokenHash("catalog-bob-access"),
      sessionFamilyId: tokenHash("catalog-bob-family"),
      principal: { accountId: "catalog-bob-account", actorId: "catalog-bob" },
    };
    const fixture = await createDatabaseFixture({
      contexts: [alice, bob],
      rooms: [{ roomId: "catalog-room" }],
      catalogRevision: 8,
    });
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
      streamingAuthority: authority,
      clock: () => 2_000,
      limits: { cacheQuotaBytes: 1 },
    });
    const page0 = await client.beginWorkspaceBootstrap(alice, "catalog-stream-0");
    expect(page0).toMatchObject({
      type: "workspace.bootstrap.page",
      mode: "streaming",
      catalogRevision: 8,
      page: 0,
      hasMore: false,
    });
    if ("kind" in page0 || page0.mode !== "streaming") {
      throw new Error("expected catalog streaming fallback");
    }
    await expect(authority.executeHuman({
      ...alice, kind: "human", requestId: "alice-create", idempotencyKey: "alice-create",
    }, { type: "room.create", payload: { name: "Blocked Alice room" } }, 2_001))
      .rejects.toMatchObject({ status: 503, code: "repair_barrier_active" });
    await expect(authority.executeHuman({
      ...bob, kind: "human", requestId: "bob-create", idempotencyKey: "bob-create",
    }, { type: "room.create", payload: { name: "Allowed Bob room" } }, 2_001))
      .resolves.toMatchObject({ acceptedAt: new Date(2_001).toISOString() });
    await expect(client.completeSnapshot(
      alice,
      "wrong-catalog-complete",
      page0.snapshotId,
      { kind: "room", roomId: "catalog-room", watermark: 8 },
      page0.snapshotChecksum,
    )).rejects.toMatchObject({ status: 409, code: "snapshot_stale" });
    await expect(client.completeSnapshot(
      alice,
      "catalog-complete",
      page0.snapshotId,
      { kind: "catalog", catalogRevision: 8 },
      page0.snapshotChecksum,
    )).resolves.toMatchObject({
      type: "snapshot.completed",
      requestId: "catalog-complete",
      version: { kind: "catalog", catalogRevision: 8 },
    });
    await expect(authority.executeHuman({
      ...alice, kind: "human", requestId: "alice-after", idempotencyKey: "alice-after",
    }, { type: "room.create", payload: { name: "Allowed after complete" } }, 2_002))
      .resolves.toBeDefined();
    await expect(client.completeSnapshot(
      alice,
      "catalog-complete-after-revision",
      page0.snapshotId,
      { kind: "catalog", catalogRevision: 8 },
      page0.snapshotChecksum,
    )).rejects.toMatchObject({ status: 409, code: "snapshot_stale" });
    await client.close();
    await authority.close();
  });

  it.each([
    { governance: "family revoke", terminalCode: "snapshot_family_revoked", status: 403 },
    { governance: "member removal", terminalCode: "snapshot_stale", status: 409 },
    { governance: "role downgrade", terminalCode: "snapshot_stale", status: 409 },
    { governance: "room archive", terminalCode: "room_archived", status: 409 },
  ] as const)(
    "applies or fails closed for $governance before touching the affected catalog lease",
    async ({ governance, terminalCode, status }) => {
      const owner: AuthenticatedSessionContext = {
        sessionId: tokenHash(`catalog-governance-owner-access-${governance}`),
        sessionFamilyId: tokenHash(`catalog-governance-owner-family-${governance}`),
        principal: {
          accountId: `catalog-governance-owner-account-${governance}`,
          actorId: `catalog-governance-owner-${governance}`,
        },
      };
      const target: AuthenticatedSessionContext = {
        sessionId: tokenHash(`catalog-governance-target-access-${governance}`),
        sessionFamilyId: tokenHash(`catalog-governance-target-family-${governance}`),
        principal: {
          accountId: `catalog-governance-target-account-${governance}`,
          actorId: `catalog-governance-target-${governance}`,
        },
      };
      const roomId = `catalog-governance-room-${governance}`;
      const secondRoomId = `${roomId}-z`;
      const fixture = await createDatabaseFixture({ contexts: [owner, target] });
      const seeded = new DatabaseSync(fixture.authorityPath);
      seedRoom(seeded, owner, roomId);
      seedRoom(seeded, owner, secondRoomId);
      seeded.prepare(
        `INSERT INTO room_memberships (
           room_id, actor_id, kind, role, participation, tool_permissions_json,
           joined_at, configured_at, access_revision
         ) VALUES (?, ?, 'human', 'admin', NULL, '[]', ?, NULL, 4)`,
      ).run(roomId, target.principal.actorId, "2026-08-11T00:00:00.000Z");
      seeded.prepare(
        `INSERT INTO room_memberships (
           room_id, actor_id, kind, role, participation, tool_permissions_json,
           joined_at, configured_at, access_revision
         ) VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 2)`,
      ).run(secondRoomId, target.principal.actorId, "2026-08-11T00:00:01.000Z");
      seeded.close();

      const authority = await createWorkerDatabaseClient({
        databasePath: fixture.authorityPath,
      });
      const client = await createSnapshotWorkerClient({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
        limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 1 },
      });
      const page0 = await client.beginWorkspaceBootstrap(
        target,
        `catalog-governance-zero-${governance}`,
      );
      if ("kind" in page0 || page0.mode !== "streaming") {
        throw new Error("expected catalog streaming fallback");
      }

      if (governance === "family revoke") {
        await authority.revokeSession(target.sessionId, 2_001);
      } else {
        const command = governance === "member removal"
          ? {
              type: "member.remove" as const,
              roomId,
              payload: { targetActorId: target.principal.actorId },
            }
          : governance === "role downgrade"
            ? {
                type: "room.member.role.set" as const,
                roomId,
                payload: {
                  targetActorId: target.principal.actorId,
                  role: "member" as const,
                  expectedGovernanceRevision: 1,
                },
              }
            : {
                type: "room.archive" as const,
                roomId,
                payload: { expectedGovernanceRevision: 1 },
              };
        const execution = expect(authority.executeHuman({
          ...owner,
          kind: "human",
          requestId: `catalog-governance-${governance}`,
          idempotencyKey: `catalog-governance-${governance}`,
        }, command, 2_001));
        if (governance === "member removal") {
          await execution.rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
          await expect(client.readWorkspaceBootstrapPage(
            target, `catalog-governance-after-${governance}`, page0.snapshotId, 0,
          )).resolves.toMatchObject({ mode: "streaming", page: 1 });
          const inspected = new DatabaseSync(fixture.authorityPath, { readOnly: true });
          expect(inspected.prepare(
            "SELECT role FROM room_memberships WHERE room_id = ? AND actor_id = ?",
          ).get(roomId, target.principal.actorId)?.role).toBe("admin");
          expect(inspected.prepare("SELECT status FROM rooms WHERE id = ?").get(roomId)?.status)
            .toBe("active");
          inspected.close();
          await client.close();
          await authority.close();
          return;
        }
        await execution.resolves.toBeDefined();
      }

      await expect(client.readWorkspaceBootstrapPage(
        target,
        `catalog-governance-after-${governance}`,
        page0.snapshotId,
        0,
      )).rejects.toMatchObject({ status, code: terminalCode });

      const inspected = new DatabaseSync(fixture.authorityPath, { readOnly: true });
      if (governance === "family revoke") {
        expect(inspected.prepare(
          "SELECT revoked_at AS revokedAt FROM sessions WHERE access_token_hash = ?",
        ).get(target.sessionId)?.revokedAt).toBe(2_001);
      } else if (governance === "member removal") {
        expect(inspected.prepare(
          "SELECT 1 FROM room_memberships WHERE room_id = ? AND actor_id = ?",
        ).get(roomId, target.principal.actorId)).toBeUndefined();
      } else if (governance === "role downgrade") {
        expect(inspected.prepare(
          "SELECT role FROM room_memberships WHERE room_id = ? AND actor_id = ?",
        ).get(roomId, target.principal.actorId)?.role).toBe("member");
      } else {
        expect(inspected.prepare("SELECT status FROM rooms WHERE id = ?")
          .get(roomId)?.status).toBe("archived");
      }
      inspected.close();
      await client.close();
      await authority.close();
    },
  );

  it("releases an idle or disconnected streaming barrier", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "release-stream-room", messageCount: 2 }],
    });
    const normalized = new DatabaseSync(fixture.authorityPath);
    normalized.prepare(
      "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room'",
    ).run();
    normalized.close();
    const context = fixture.contexts[0]!;
    let now = 2_000;
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const createClient = () => createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, now),
      streamingAuthority: authority,
      clock: () => now,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
    });
    const idleClient = await createClient();
    const idlePage = await idleClient.beginRoomRepair(
      context, "idle-release-zero", "release-stream-room",
    );
    if ("kind" in idlePage || idlePage.mode !== "streaming") {
      throw new Error("expected streaming");
    }
    now = 32_000;
    await expect(idleClient.readRoomRepairPage(
      context, "idle-release-one", idlePage.snapshotId, 0,
    )).rejects.toMatchObject({ status: 410, code: "snapshot_expired" });

    const commandContext = {
      ...context,
      kind: "human" as const,
      requestId: "after-idle-release",
      idempotencyKey: "after-idle-release",
    };
    await expect(authority.executeHuman(commandContext, {
      type: "message.send",
      roomId: "release-stream-room",
      payload: {
        id: "after-idle-release",
        roomId: "release-stream-room",
        body: "idle lease released",
        sentAt: "2026-08-11T00:00:03.000Z",
      },
    }, now)).resolves.toMatchObject({ aggregateId: "after-idle-release" });
    await idleClient.close();

    now = 33_000;
    const disconnectedClient = await createClient();
    const disconnectedPage = await disconnectedClient.beginRoomRepair(
      context, "disconnect-release-zero", "release-stream-room",
    );
    if ("kind" in disconnectedPage || disconnectedPage.mode !== "streaming") {
      throw new Error("expected streaming");
    }
    await disconnectedClient.close();
    await expect(authority.executeHuman({
      ...commandContext,
      requestId: "after-disconnect-release",
      idempotencyKey: "after-disconnect-release",
    }, {
      type: "message.send",
      roomId: "release-stream-room",
      payload: {
        id: "after-disconnect-release",
        roomId: "release-stream-room",
        body: "disconnect lease released",
        sentAt: "2026-08-11T00:00:04.000Z",
      },
    }, now)).resolves.toMatchObject({ aggregateId: "after-disconnect-release" });
    await authority.close();
  });

  it("releases only an owner-matched snapshot and leaves another connection barrier active", async () => {
    const owner = contextFor("release-owner", "release-owner-family");
    const otherFamily = contextFor("release-other", "release-other-family");
    const fixture = await createDatabaseFixture({
      contexts: [owner, otherFamily],
      rooms: [
        { roomId: "release-scope-a", messageCount: 0 },
        { roomId: "release-scope-b", messageCount: 0 },
      ],
    });
    const normalized = new DatabaseSync(fixture.authorityPath);
    normalized.prepare("UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room'").run();
    normalized.close();
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
      streamingAuthority: authority,
      clock: () => 2_000,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
    });
    const pageA = await client.beginRoomRepair(owner, "release-a-zero", "release-scope-a");
    const pageB = await client.beginRoomRepair(owner, "release-b-zero", "release-scope-b");
    if ("kind" in pageA || "kind" in pageB ||
        pageA.mode !== "streaming" || pageB.mode !== "streaming") {
      throw new Error("expected two streaming leases");
    }

    await expect(client.releaseSnapshot(otherFamily, pageA.snapshotId))
      .rejects.toMatchObject({ status: 403, code: "snapshot_forbidden" });
    await expect(client.releaseSnapshot(owner, pageA.snapshotId)).resolves.toBeUndefined();
    await expect(client.releaseSnapshot(owner, pageA.snapshotId)).resolves.toBeUndefined();
    const commandContext = {
      ...owner,
      kind: "human" as const,
      requestId: "release-scope-write-a",
      idempotencyKey: "release-scope-write-a",
    };
    await expect(authority.executeHuman(commandContext, {
      type: "message.send",
      roomId: "release-scope-a",
      payload: {
        id: "release-scope-write-a",
        roomId: "release-scope-a",
        body: "released scope",
        sentAt: "2026-08-11T00:00:01.000Z",
      },
    }, 2_001)).resolves.toMatchObject({ aggregateId: "release-scope-write-a" });
    await expect(authority.executeHuman({
      ...commandContext,
      requestId: "release-scope-write-b",
      idempotencyKey: "release-scope-write-b",
    }, {
      type: "message.send",
      roomId: "release-scope-b",
      payload: {
        id: "release-scope-write-b",
        roomId: "release-scope-b",
        body: "still blocked",
        sentAt: "2026-08-11T00:00:02.000Z",
      },
    }, 2_001)).rejects.toMatchObject({ status: 503, code: "repair_barrier_active" });
    await client.close();
    await authority.close();
  });

  it.each([
    { name: "member removal", command: (roomId: string, targetId: string) => ({
      type: "member.remove" as const, roomId, payload: { targetActorId: targetId },
    }) },
    { name: "role downgrade", command: (roomId: string, targetId: string) => ({
      type: "room.member.role.set" as const, roomId,
      payload: { targetActorId: targetId, role: "member" as const, expectedGovernanceRevision: 1 },
    }) },
    { name: "room archive", command: (roomId: string, targetId: string) => {
      void targetId;
      return {
        type: "room.archive" as const,
        roomId,
        payload: { expectedGovernanceRevision: 1 },
      };
    } },
  ])("applies or fails $name closed before touching the affected lease", async ({ command }) => {
    const owner: AuthenticatedSessionContext = {
      sessionId: tokenHash(`preempt-owner-access-${command.name}`),
      sessionFamilyId: tokenHash(`preempt-owner-family-${command.name}`),
      principal: { accountId: "preempt-owner-account", actorId: "preempt-owner" },
    };
    const target: AuthenticatedSessionContext = {
      sessionId: tokenHash(`preempt-target-access-${command.name}`),
      sessionFamilyId: tokenHash(`preempt-target-family-${command.name}`),
      principal: { accountId: "preempt-target-account", actorId: "preempt-target" },
    };
    const fixture = await createDatabaseFixture({ contexts: [owner, target] });
    const seeded = new DatabaseSync(fixture.authorityPath);
    seedRoom(seeded, owner, "preempt-room", 2);
    seeded.prepare(
      "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room' AND stream_id = 'preempt-room'",
    ).run();
    seeded.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES ('preempt-room', ?, 'human', 'admin', NULL, '[]', 't', NULL, 4)`,
    ).run(target.principal.actorId);
    seeded.close();
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
      streamingAuthority: authority,
      clock: () => 2_000,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
    });
    const page0 = await client.beginRoomRepair(target, "preempt-page-0", "preempt-room");
    if ("kind" in page0 || page0.mode !== "streaming") throw new Error("expected streaming");

    const governanceCommand = command("preempt-room", target.principal.actorId);
    const execution = expect(authority.executeHuman({
      ...owner,
      kind: "human",
      requestId: `preempt-${command.name}`,
      idempotencyKey: `preempt-${command.name}`,
    }, governanceCommand, 2_001));
    if (governanceCommand.type === "member.remove" ||
        governanceCommand.type === "room.member.role.set") {
      await execution.rejects.toMatchObject({
        status: 503,
        code: governanceCommand.type === "room.member.role.set"
          ? "repair_barrier_active"
          : "dependency_unavailable",
      });
      await expect(client.readRoomRepairPage(
        target, "preempt-after", page0.snapshotId, 0,
      )).resolves.toMatchObject({ mode: "streaming", page: 1 });
      const inspected = new DatabaseSync(fixture.authorityPath, { readOnly: true });
      expect(inspected.prepare(
        "SELECT role FROM room_memberships WHERE room_id = 'preempt-room' AND actor_id = ?",
      ).get(target.principal.actorId)?.role).toBe("admin");
      expect(inspected.prepare("SELECT status FROM rooms WHERE id = 'preempt-room'").get()?.status)
        .toBe("active");
      inspected.close();
      await client.close();
      await authority.close();
      return;
    }
    await execution.resolves.toBeDefined();
    await expect(client.readRoomRepairPage(
      target, "preempt-after", page0.snapshotId, 0,
    )).rejects.toMatchObject({ status: expect.any(Number),
      code: expect.stringMatching(/snapshot_stale|room_archived|room_forbidden/) });

    const inspected = new DatabaseSync(fixture.authorityPath, { readOnly: true });
    if (command("preempt-room", target.principal.actorId).type === "member.remove") {
      expect(inspected.prepare(
        "SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = 'preempt-room' AND actor_id = ?",
      ).get(target.principal.actorId)?.count).toBe(0);
    } else if (command("preempt-room", target.principal.actorId).type === "room.archive") {
      expect(inspected.prepare("SELECT status FROM rooms WHERE id = 'preempt-room'").get()?.status)
        .toBe("archived");
    } else {
      expect(inspected.prepare(
        "SELECT role FROM room_memberships WHERE room_id = 'preempt-room' AND actor_id = ?",
      ).get(target.principal.actorId)?.role).toBe("member");
    }
    inspected.close();
    await client.close();
    await authority.close();
  });

  it.each([
    { type: "member.remove", behavior: "rejected legacy removal is retried" },
    { type: "room.archive", behavior: "an applied archive is exactly replayed" },
  ] as const)(
    "does not preempt a newly acquired lease when $behavior",
    async ({ type }) => {
      const owner: AuthenticatedSessionContext = {
        sessionId: tokenHash(`replay-owner-access-${type}`),
        sessionFamilyId: tokenHash(`replay-owner-family-${type}`),
        principal: { accountId: `replay-owner-account-${type}`, actorId: `replay-owner-${type}` },
      };
      const target: AuthenticatedSessionContext = {
        sessionId: tokenHash(`replay-target-access-${type}`),
        sessionFamilyId: tokenHash(`replay-target-family-${type}`),
        principal: { accountId: `replay-target-account-${type}`, actorId: `replay-target-${type}` },
      };
      const fixture = await createDatabaseFixture({ contexts: [owner, target] });
      const roomId = `replay-preempt-${type}`;
      const seeded = new DatabaseSync(fixture.authorityPath);
      seedRoom(seeded, owner, roomId, 2);
      seeded.prepare(
        "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room' AND stream_id = ?",
      ).run(roomId);
      seeded.prepare(
        `INSERT INTO room_memberships (
           room_id, actor_id, kind, role, participation, tool_permissions_json,
           joined_at, configured_at, access_revision
         ) VALUES (?, ?, 'human', 'admin', NULL, '[]', 't', NULL, 4)`,
      ).run(roomId, target.principal.actorId);
      seeded.close();
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const command = type === "member.remove"
        ? { type, roomId, payload: { targetActorId: target.principal.actorId } }
        : { type, roomId, payload: { expectedGovernanceRevision: 1 } };
      const commandContext = {
        ...owner,
        kind: "human" as const,
        requestId: `replay-preempt-first-${type}`,
        idempotencyKey: `replay-preempt-${type}`,
      };
      const firstArchive = type === "room.archive"
        ? await authority.executeHuman(commandContext, command, 2_000)
        : undefined;
      if (type === "member.remove") {
        await expect(authority.executeHuman(commandContext, command, 2_000))
          .rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
      }
      const client = await createSnapshotWorkerClient({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_001),
        streamingAuthority: authority,
        clock: () => 2_001,
        limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
      });
      const page0 = await client.beginRoomRepair(
        target, `replay-preempt-zero-${type}`, roomId,
      );
      if ("kind" in page0) throw new Error("expected streaming page zero");
      const replay = authority.executeHuman({
        ...commandContext,
        requestId: `replay-preempt-second-${type}`,
      }, command, 2_002);
      if (type === "member.remove") {
        await expect(replay).rejects.toMatchObject({
          status: 503, code: "dependency_unavailable",
        });
      } else {
        await expect(replay).resolves.toEqual(firstArchive);
      }
      await expect(client.readRoomRepairPage(
        target, `replay-preempt-one-${type}`, page0.snapshotId, 0,
      )).resolves.toMatchObject({ mode: "streaming", page: 1 });
      await client.close();
      await authority.close();
    },
  );

  it.each(["member", "admin"] as const)(
    "keeps member-to-%s role changes behind the ordinary repair barrier",
    async (role) => {
      const owner: AuthenticatedSessionContext = {
        sessionId: tokenHash(`role-gate-owner-access-${role}`),
        sessionFamilyId: tokenHash(`role-gate-owner-family-${role}`),
        principal: { accountId: "role-gate-owner-account", actorId: "role-gate-owner" },
      };
      const target: AuthenticatedSessionContext = {
        sessionId: tokenHash(`role-gate-target-access-${role}`),
        sessionFamilyId: tokenHash(`role-gate-target-family-${role}`),
        principal: { accountId: "role-gate-target-account", actorId: "role-gate-target" },
      };
      const fixture = await createDatabaseFixture({ contexts: [owner, target] });
      const seeded = new DatabaseSync(fixture.authorityPath);
      seedRoom(seeded, owner, "role-gate-room", 2);
      seeded.prepare(
        "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room' AND stream_id = 'role-gate-room'",
      ).run();
      seeded.prepare(
        `INSERT INTO room_memberships (
           room_id, actor_id, kind, role, participation, tool_permissions_json,
           joined_at, configured_at, access_revision
         ) VALUES ('role-gate-room', ?, 'human', 'member', NULL, '[]', 't', NULL, 4)`,
      ).run(target.principal.actorId);
      seeded.close();
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const client = await createSnapshotWorkerClient({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
        limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
      });
      const page0 = await client.beginRoomRepair(
        target, `role-gate-${role}-zero`, "role-gate-room",
      );
      if ("kind" in page0 || page0.mode !== "streaming") throw new Error("expected streaming");

      await expect(authority.executeHuman({
        ...owner,
        kind: "human",
        requestId: `role-gate-${role}`,
        idempotencyKey: `role-gate-${role}`,
      }, {
        type: "room.member.role.set",
        roomId: "role-gate-room",
        payload: {
          targetActorId: target.principal.actorId,
          role,
          expectedGovernanceRevision: 1,
        },
      }, 2_001)).rejects.toMatchObject({
        status: 503,
        code: "repair_barrier_active",
      });
      const inspected = new DatabaseSync(fixture.authorityPath, { readOnly: true });
      expect(inspected.prepare(
        "SELECT role FROM room_memberships WHERE room_id = 'role-gate-room' AND actor_id = ?",
      ).get(target.principal.actorId)?.role).toBe("member");
      inspected.close();
      await client.close();
      await authority.close();
    },
  );

  it("lets session-family revoke preempt a streaming lease", async () => {
    const fixture = await createDatabaseFixture({ rooms: [{ roomId: "revoke-stream-room", messageCount: 2 }] });
    const normalized = new DatabaseSync(fixture.authorityPath);
    normalized.prepare(
      "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room' AND stream_id = 'revoke-stream-room'",
    ).run();
    normalized.close();
    const context = fixture.contexts[0]!;
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
      streamingAuthority: authority, clock: () => 2_000,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
    });
    const page0 = await client.beginRoomRepair(context, "revoke-stream-0", "revoke-stream-room");
    if ("kind" in page0 || page0.mode !== "streaming") throw new Error("expected streaming");
    await authority.revokeSession(context.sessionId, 2_001);
    await expect(client.readRoomRepairPage(
      context, "revoke-stream-1", page0.snapshotId, 0,
    )).rejects.toMatchObject({ status: 403, code: "snapshot_family_revoked" });
    await client.close();
    await authority.close();
  });

  it("lets refresh rotate through a barrier and continue on a new session in the same family", async () => {
    const fixture = await createDatabaseFixture({ rooms: [{ roomId: "refresh-stream-room", messageCount: 2 }] });
    const original = fixture.contexts[0]!;
    const normalized = new DatabaseSync(fixture.authorityPath);
    normalized.prepare(
      "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room' AND stream_id = 'refresh-stream-room'",
    ).run();
    normalized.prepare(
      "UPDATE sessions SET access_expires_at = 2001 WHERE access_token_hash = ?",
    ).run(original.sessionId);
    normalized.close();
    let now = 2_000;
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const client = await createSnapshotWorkerClient({
      authorityPath: fixture.authorityPath, cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, now),
      streamingAuthority: authority, clock: () => now,
      limits: { cacheQuotaBytes: 1, maxRecordsPerPage: 2 },
    });
    const page0 = await client.beginRoomRepair(original, "refresh-stream-0", "refresh-stream-room");
    if ("kind" in page0 || page0.mode !== "streaming") throw new Error("expected streaming");
    now = 2_002;
    const currentRefreshTokenHash = tokenHash(`refresh-${original.sessionId}`);
    await authority.validateSessionRefresh(
      currentRefreshTokenHash, original.principal, now,
    );
    const rotated = await authority.rotateSession({
      currentRefreshTokenHash,
      accessTokenHash: tokenHash("refresh-stream-next-access"),
      refreshTokenHash: tokenHash("refresh-stream-next-refresh"),
      accessExpiresAt: 1_000_000,
      refreshExpiresAt: 2_000_000,
      expectedPrincipal: original.principal,
      now,
    });
    const refreshed: AuthenticatedSessionContext = {
      sessionId: rotated.sessionId,
      sessionFamilyId: rotated.familyId,
      principal: original.principal,
    };
    let page = await client.readRoomRepairPage(
      refreshed, "refresh-stream-1", page0.snapshotId, 0,
    );
    expect(page).toMatchObject({ mode: "streaming", page: 1 });
    while (page.hasMore) {
      page = await client.readRoomRepairPage(
        refreshed, `refresh-stream-${page.page + 1}`, page.snapshotId, page.page,
      );
    }
    await client.close();
    await authority.close();
  });

  describe("paused streaming checksum lifecycle", () => {
    class PausedChecksumTransport extends EventEmitter implements SnapshotWorkerTransport {
      #streamingRequest:
        | Extract<SnapshotWorkerRequest, { readonly type: "snapshot.begin-streaming" }>
        | undefined;
      #checksumReached: (() => void) | undefined;
      readonly checksumReached = new Promise<void>((resolve) => {
        this.#checksumReached = resolve;
      });
      checksumPasses = 0;
      materializedAttempts = 0;
      releaseRequests = 0;
      terminateCount = 0;

      get snapshotId(): string {
        const request = this.#streamingRequest;
        if (request === undefined) throw new Error("streaming checksum was not started");
        return request.lease.snapshotId;
      }

      postMessage(request: SnapshotWorkerRequest): void {
        if (request.type === "snapshot.initialize") {
          queueMicrotask(() => this.emit("message", {
            type: "snapshot.ready", requestId: request.requestId,
          }));
          return;
        }
        if (request.type === "snapshot.begin-room" || request.type === "snapshot.begin-catalog") {
          this.materializedAttempts += 1;
          queueMicrotask(() => this.emit("message", {
            type: "snapshot.fallback", requestId: request.requestId, reason: "quota",
          }));
          return;
        }
        if (request.type === "snapshot.cache-count") {
          queueMicrotask(() => this.emit("message", {
            type: "snapshot.cache-count", requestId: request.requestId, count: 0,
          }));
          return;
        }
        if (request.type === "snapshot.begin-streaming") {
          if (this.#streamingRequest !== undefined) {
            if (request.lease.snapshotId !== this.#streamingRequest.lease.snapshotId ||
                request.lease.checksum !== "paused-checksum" || request.lease.pageCount !== 2) {
              throw new Error("streaming retry did not reuse the attached snapshot");
            }
            this.#emitPage0(request);
            return;
          }
          this.checksumPasses += 1;
          this.#streamingRequest = request;
          this.#checksumReached?.();
          return;
        }
        if (request.type === "snapshot.read-streaming-page") {
          const lease = request.lease;
          queueMicrotask(() => this.emit("message", {
            type: "snapshot.streaming-page",
            requestId: request.requestId,
            manifest: {
              snapshotId: lease.snapshotId,
              principalId: lease.principalId,
              sessionFamilyId: lease.sessionFamilyId,
              checksum: "paused-checksum",
              pageCount: 2,
              kind: "room",
              roomId: "paused-checksum-room",
              accessRevision: lease.authorizationRevision,
              watermark: 0,
            },
            page: {
              type: "room.repair.page",
              requestId: request.responseRequestId,
              snapshotId: lease.snapshotId,
              roomId: "paused-checksum-room",
              page: 1,
              records: [],
              watermark: 0,
              snapshotChecksum: "paused-checksum",
              hasMore: false,
              mode: "streaming",
              idleExpiresAt: lease.idleExpiresAt,
            },
          }));
          return;
        }
        if (request.type === "snapshot.release-streaming") {
          this.releaseRequests += 1;
          queueMicrotask(() => this.emit("message", {
            type: "snapshot.streaming-released", requestId: request.requestId,
          }));
          return;
        }
        if (request.type === "snapshot.close") {
          queueMicrotask(() => this.emit("message", {
            type: "snapshot.closed", requestId: request.requestId,
          }));
        }
      }

      continueChecksum(): void {
        const request = this.#streamingRequest;
        if (request === undefined) {
          throw new Error("streaming checksum was not paused");
        }
        this.#emitPage0(request);
      }

      #emitPage0(
        request: Extract<SnapshotWorkerRequest, { readonly type: "snapshot.begin-streaming" }>,
      ): void {
        const lease = request.lease;
        if (lease.scope.kind === "catalog" && lease.version.kind === "catalog") {
          queueMicrotask(() => this.emit("message", {
            type: "snapshot.streaming-page",
            requestId: request.requestId,
            manifest: {
              snapshotId: lease.snapshotId,
              principalId: lease.principalId,
              sessionFamilyId: lease.sessionFamilyId,
              checksum: "paused-checksum",
              pageCount: 2,
              kind: "catalog",
              catalogRevision: lease.version.catalogRevision,
            },
            page: {
              type: "workspace.bootstrap.page",
              requestId: request.responseRequestId,
              snapshotId: lease.snapshotId,
              page: 0,
              rooms: [],
              catalogRevision: lease.version.catalogRevision,
              snapshotChecksum: "paused-checksum",
              hasMore: true,
              mode: "streaming",
              idleExpiresAt: lease.idleExpiresAt,
            },
          }));
          return;
        }
        if (lease.scope.kind !== "room" || lease.version.kind !== "room") {
          throw new Error("streaming scope and version do not match");
        }
        queueMicrotask(() => this.emit("message", {
          type: "snapshot.streaming-page",
          requestId: request.requestId,
          manifest: {
            snapshotId: lease.snapshotId,
            principalId: lease.principalId,
            sessionFamilyId: lease.sessionFamilyId,
            checksum: "paused-checksum",
            pageCount: 2,
            kind: "room",
            roomId: lease.scope.roomId,
            accessRevision: lease.authorizationRevision,
            watermark: lease.version.watermark,
          },
          page: {
            type: "room.repair.page",
            requestId: request.responseRequestId,
            snapshotId: lease.snapshotId,
            roomId: lease.scope.roomId,
            page: 0,
            records: [],
            watermark: lease.version.watermark,
            snapshotChecksum: "paused-checksum",
            hasMore: true,
            mode: "streaming",
            idleExpiresAt: lease.idleExpiresAt,
          },
        }));
      }

      async terminate(): Promise<number> {
        this.terminateCount += 1;
        return 0;
      }
    }

    it("does not reuse a pre-attach checksum operation from a refreshed session", async () => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: "checksum-preattach-room" }],
      });
      const original = fixture.contexts[0]!;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
      }, () => transport);
      const beginning = client.beginRoomRepair(
        original, "checksum-preattach-zero", "checksum-preattach-room",
      );
      await transport.checksumReached;
      const rotated = await authority.rotateSession({
        currentRefreshTokenHash: tokenHash(`refresh-${original.sessionId}`),
        accessTokenHash: tokenHash("checksum-preattach-next-access"),
        refreshTokenHash: tokenHash("checksum-preattach-next-refresh"),
        accessExpiresAt: 1_000_000,
        refreshExpiresAt: 2_000_000,
        expectedPrincipal: original.principal,
        now: 2_000,
      });
      const refreshed: AuthenticatedSessionContext = {
        sessionId: rotated.sessionId,
        sessionFamilyId: rotated.familyId,
        principal: original.principal,
      };

      await expect(client.beginRoomRepair(
        refreshed, "checksum-preattach-refreshed", "checksum-preattach-room",
      )).rejects.toMatchObject({ status: 429, code: "snapshot_busy" });
      expect(transport.checksumPasses).toBe(1);
      expect(transport.materializedAttempts).toBe(2);
      await client.close();
      transport.continueChecksum();
      await expect(beginning).rejects.toMatchObject({ code: "snapshot_worker_closed" });
      await authority.close();
    });

    it("retains an attached checksum when rotation revokes the old page-zero session", async () => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: "checksum-rotate-room" }],
      });
      const original = fixture.contexts[0]!;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
      }, () => transport);
      const beginning = client.beginRoomRepair(
        original, "checksum-rotate-old", "checksum-rotate-room",
      );
      await transport.checksumReached;
      const rotated = await authority.rotateSession({
        currentRefreshTokenHash: tokenHash(`refresh-${original.sessionId}`),
        accessTokenHash: tokenHash("checksum-rotate-next-access"),
        refreshTokenHash: tokenHash("checksum-rotate-next-refresh"),
        accessExpiresAt: 1_000_000,
        refreshExpiresAt: 2_000_000,
        expectedPrincipal: original.principal,
        now: 2_000,
      });
      const refreshed: AuthenticatedSessionContext = {
        sessionId: rotated.sessionId,
        sessionFamilyId: rotated.familyId,
        principal: original.principal,
      };
      transport.continueChecksum();
      await expect(beginning).rejects.toMatchObject({ status: 403, code: "session_revoked" });

      const page0 = await client.beginRoomRepair(
        refreshed, "checksum-rotate-new", "checksum-rotate-room",
      );
      if ("kind" in page0) throw new Error("expected attached streaming page zero");
      expect(page0).toMatchObject({
        mode: "streaming",
        page: 0,
        snapshotId: transport.snapshotId,
        snapshotChecksum: "paused-checksum",
      });
      expect(transport.materializedAttempts).toBe(1);
      expect(transport.checksumPasses).toBe(1);
      await client.close();
      await authority.close();
    });

    it("does not publish a continuation whose authorization returns after explicit release", async () => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: "paused-checksum-room" }],
      });
      const context = fixture.contexts[0]!;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      let pageOneReachedResolve: (() => void) | undefined;
      const pageOneReached = new Promise<void>((resolve) => { pageOneReachedResolve = resolve; });
      let continuePageOne: (() => void) | undefined;
      const pageOneGate = new Promise<void>((resolve) => { continuePageOne = resolve; });
      const delayedAuthority: StreamingRepairAuthority = {
        acquireStreamingRepair: (session, scope, now) =>
          authority.acquireStreamingRepair(session, scope, now),
        registerStreamingRepair: (snapshotId, checksum, pageCount, now) =>
          authority.registerStreamingRepair(snapshotId, checksum, pageCount, now),
        async authorizeStreamingRepairPage(session, snapshotId, page, now) {
          const authorized = await authority.authorizeStreamingRepairPage(
            session, snapshotId, page, now,
          );
          if (page === 1) {
            pageOneReachedResolve?.();
            await pageOneGate;
          }
          return authorized;
        },
        completeStreamingRepair: (session, snapshotId, version, checksum, now) =>
          authority.completeStreamingRepair(session, snapshotId, version, checksum, now),
        releaseStreamingRepair: (session, snapshotId, now) =>
          authority.releaseStreamingRepair(session, snapshotId, now),
      };
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: delayedAuthority,
        clock: () => 2_000,
      }, () => transport);
      const beginning = client.beginRoomRepair(
        context, "delayed-authorize-zero", "paused-checksum-room",
      );
      await transport.checksumReached;
      transport.continueChecksum();
      const page0 = await beginning;
      if ("kind" in page0) throw new Error("expected streaming page zero");
      const reading = client.readRoomRepairPage(
        context, "delayed-authorize-one", page0.snapshotId, 0,
      );
      await pageOneReached;
      await client.releaseSnapshot(context, page0.snapshotId);
      continuePageOne?.();
      await expect(reading).rejects.toMatchObject({ code: "snapshot_not_found" });
      expect(transport.releaseRequests).toBe(1);
      await client.close();
      await authority.close();
    });

    it("clears worker state when continuation authorization observes idle expiry", async () => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: "paused-checksum-room" }],
      });
      const context = fixture.contexts[0]!;
      let now = 2_000;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, now),
        streamingAuthority: authority,
        clock: () => now,
      }, () => transport);
      const beginning = client.beginRoomRepair(
        context, "continuation-expiry-zero", "paused-checksum-room",
      );
      await transport.checksumReached;
      transport.continueChecksum();
      const page0 = await beginning;
      if ("kind" in page0) throw new Error("expected streaming page zero");
      now = 32_000;
      await expect(client.readRoomRepairPage(
        context, "continuation-expiry-one", page0.snapshotId, 0,
      )).rejects.toMatchObject({ status: 410, code: "snapshot_expired" });
      expect(transport.releaseRequests).toBe(1);
      await expect(authority.executeHuman({
        ...context,
        kind: "human",
        requestId: "continuation-expiry-write",
        idempotencyKey: "continuation-expiry-write",
      }, {
        type: "message.send",
        roomId: "paused-checksum-room",
        payload: {
          id: "continuation-expiry-write",
          roomId: "paused-checksum-room",
          body: "expired lease released",
          sentAt: "2026-08-11T00:00:00.000Z",
        },
      }, now)).resolves.toBeDefined();
      await client.close();
      await authority.close();
    });

    it("clears worker state when continuation authorization observes family preemption", async () => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: "paused-checksum-room" }],
      });
      const context = fixture.contexts[0]!;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
      }, () => transport);
      const beginning = client.beginRoomRepair(
        context, "continuation-preempt-zero", "paused-checksum-room",
      );
      await transport.checksumReached;
      transport.continueChecksum();
      const page0 = await beginning;
      if ("kind" in page0) throw new Error("expected streaming page zero");
      await authority.revokeSession(context.sessionId, 2_001);
      await expect(client.readRoomRepairPage(
        context, "continuation-preempt-one", page0.snapshotId, 0,
      )).rejects.toMatchObject({ status: 403, code: "snapshot_family_revoked" });
      expect(transport.releaseRequests).toBe(1);
      await client.close();
      await authority.close();
    });

    it("rejects a continuation when the worker fails before its queued response", async () => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: "paused-checksum-room" }],
      });
      const context = fixture.contexts[0]!;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
      }, () => transport);
      const beginning = client.beginRoomRepair(
        context, "continuation-terminal-zero", "paused-checksum-room",
      );
      await transport.checksumReached;
      transport.continueChecksum();
      const page0 = await beginning;
      if ("kind" in page0) throw new Error("expected streaming page zero");
      const reading = client.readRoomRepairPage(
        context, "continuation-terminal-one", page0.snapshotId, 0,
      );
      transport.emit("error", new Error("continuation worker failure"));
      await expect(reading).rejects.toMatchObject({ code: "snapshot_worker_error" });
      expect(transport.terminateCount).toBe(1);
      await authority.close();
    });

    it("releases a room lease when closed during the checksum pass", async () => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: "checksum-close-room" }],
      });
      const context = fixture.contexts[0]!;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
      }, () => transport);
      const beginning = client.beginRoomRepair(
        context, "checksum-close-room-zero", "checksum-close-room",
      );
      await transport.checksumReached;
      const command = (requestId: string) => authority.executeHuman({
        ...context, kind: "human" as const, requestId, idempotencyKey: requestId,
      }, {
        type: "message.send" as const,
        roomId: "checksum-close-room",
        payload: {
          id: requestId,
          roomId: "checksum-close-room",
          body: "lease lifecycle",
          sentAt: "2026-08-11T00:00:00.000Z",
        },
      }, 2_000);
      await expect(command("checksum-close-room-blocked"))
        .rejects.toMatchObject({ status: 503, code: "repair_barrier_active" });

      await client.close();
      expect(transport.releaseRequests).toBe(1);
      await expect(command("checksum-close-room-released")).resolves.toBeDefined();
      transport.continueChecksum();
      await expect(beginning).rejects.toMatchObject({ code: "snapshot_worker_closed" });
      await expect(command("checksum-close-room-still-released")).resolves.toBeDefined();
      await authority.close();
    });

    it("releases a catalog lease when closed during the checksum pass", async () => {
      const fixture = await createDatabaseFixture();
      const context = fixture.contexts[0]!;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
      }, () => transport);
      const beginning = client.beginWorkspaceBootstrap(context, "checksum-close-catalog-zero");
      await transport.checksumReached;
      const createRoom = (requestId: string) => authority.executeHuman({
        ...context, kind: "human" as const, requestId, idempotencyKey: requestId,
      }, {
        type: "room.create" as const,
        payload: { name: requestId },
      }, 2_000);
      await expect(createRoom("checksum-close-catalog-blocked"))
        .rejects.toMatchObject({ status: 503, code: "repair_barrier_active" });

      await client.close();
      expect(transport.releaseRequests).toBe(1);
      await expect(createRoom("checksum-close-catalog-released")).resolves.toBeDefined();
      transport.continueChecksum();
      await expect(beginning).rejects.toMatchObject({ code: "snapshot_worker_closed" });
      await expect(createRoom("checksum-close-catalog-still-released")).resolves.toBeDefined();
      await authority.close();
    });

    it("releases an acquired lease when the worker fails during the checksum pass", async () => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: "checksum-terminal-room" }],
      });
      const context = fixture.contexts[0]!;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
      }, () => transport);
      const beginning = client.beginRoomRepair(
        context, "checksum-terminal-zero", "checksum-terminal-room",
      );
      await transport.checksumReached;
      transport.emit("error", new Error("worker failed during checksum"));
      await expect(beginning).rejects.toMatchObject({ code: "snapshot_worker_error" });
      expect(transport.terminateCount).toBe(1);

      await expect(authority.executeHuman({
        ...context,
        kind: "human",
        requestId: "checksum-terminal-released",
        idempotencyKey: "checksum-terminal-released",
      }, {
        type: "message.send",
        roomId: "checksum-terminal-room",
        payload: {
          id: "checksum-terminal-released",
          roomId: "checksum-terminal-room",
          body: "terminal release",
          sentAt: "2026-08-11T00:00:00.000Z",
        },
      }, 2_000)).resolves.toBeDefined();
      transport.continueChecksum();
      await authority.close();
    });

    it("releases worker state when explicitly released during the checksum pass", async () => {
      const fixture = await createDatabaseFixture({
        rooms: [{ roomId: "checksum-explicit-room" }],
      });
      const context = fixture.contexts[0]!;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transport = new PausedChecksumTransport();
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, 2_000),
        streamingAuthority: authority,
        clock: () => 2_000,
      }, () => transport);
      const beginning = client.beginRoomRepair(
        context, "checksum-explicit-zero", "checksum-explicit-room",
      );
      await transport.checksumReached;
      await client.releaseSnapshot(context, transport.snapshotId);
      expect(transport.releaseRequests).toBe(1);
      transport.continueChecksum();
      await expect(beginning).rejects.toMatchObject({ code: "snapshot_not_found" });
      await expect(authority.executeHuman({
        ...context,
        kind: "human",
        requestId: "checksum-explicit-released",
        idempotencyKey: "checksum-explicit-released",
      }, {
        type: "message.send",
        roomId: "checksum-explicit-room",
        payload: {
          id: "checksum-explicit-released",
          roomId: "checksum-explicit-room",
          body: "explicit release",
          sentAt: "2026-08-11T00:00:00.000Z",
        },
      }, 2_000)).resolves.toBeDefined();
      await client.close();
      await authority.close();
    });

    it("releases only this client's unauthorized page-zero lease on close", async () => {
      const owner = contextFor("close-owner", "close-owner-family");
      const target: AuthenticatedSessionContext = {
        sessionId: tokenHash("close-target-access"),
        sessionFamilyId: tokenHash("close-target-family"),
        principal: { accountId: "close-target-account", actorId: "close-target" },
      };
      const fixture = await createDatabaseFixture({
        contexts: [owner, target],
        rooms: [{ roomId: "close-room-a" }, { roomId: "close-room-b" }],
      });
      const seeded = new DatabaseSync(fixture.authorityPath);
      const insertMembership = seeded.prepare(
        `INSERT INTO room_memberships (
           room_id, actor_id, kind, role, participation, tool_permissions_json,
           joined_at, configured_at, access_revision
         ) VALUES (?, ?, 'human', 'member', NULL, '[]', 't', NULL, 1)`,
      );
      insertMembership.run("close-room-a", target.principal.actorId);
      insertMembership.run("close-room-b", target.principal.actorId);
      seeded.prepare(
        "UPDATE sessions SET access_expires_at = 2001 WHERE access_token_hash = ?",
      ).run(target.sessionId);
      seeded.close();
      let now = 2_000;
      const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
      const transportA = new PausedChecksumTransport();
      const transportB = new PausedChecksumTransport();
      const clientA = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: fixture.cachePath,
        revalidate: (validation) => authority.revalidateSnapshot(validation, now),
        streamingAuthority: authority,
        clock: () => now,
      }, () => transportA);
      const clientB = await createSnapshotWorkerClientForTest({
        authorityPath: fixture.authorityPath,
        cachePath: join(fixture.directory, "snapshot-cache-b.sqlite"),
        revalidate: (validation) => authority.revalidateSnapshot(validation, now),
        streamingAuthority: authority,
        clock: () => now,
      }, () => transportB);
      const beginningA = clientA.beginRoomRepair(target, "close-a-zero", "close-room-a");
      const beginningB = clientB.beginRoomRepair(target, "close-b-zero", "close-room-b");
      await Promise.all([transportA.checksumReached, transportB.checksumReached]);
      now = 2_002;
      transportA.continueChecksum();
      transportB.continueChecksum();
      await expect(beginningA).rejects.toMatchObject({ status: 401, code: "token_expired" });
      await expect(beginningB).rejects.toMatchObject({ status: 401, code: "token_expired" });

      await clientA.close();
      const commandContext = {
        ...owner,
        kind: "human" as const,
        requestId: "close-write-a",
        idempotencyKey: "close-write-a",
      };
      await expect(authority.executeHuman(commandContext, {
        type: "message.send",
        roomId: "close-room-a",
        payload: { id: "close-write-a", roomId: "close-room-a", body: "released",
          sentAt: "2026-08-11T00:00:00.000Z" },
      }, now)).resolves.toMatchObject({ aggregateId: "close-write-a" });
      await expect(authority.executeHuman({
        ...commandContext,
        requestId: "close-write-b-blocked",
        idempotencyKey: "close-write-b-blocked",
      }, {
        type: "message.send",
        roomId: "close-room-b",
        payload: { id: "close-write-b-blocked", roomId: "close-room-b", body: "blocked",
          sentAt: "2026-08-11T00:00:01.000Z" },
      }, now)).rejects.toMatchObject({ status: 503, code: "repair_barrier_active" });
      await clientB.close();
      await expect(authority.executeHuman({
        ...commandContext,
        requestId: "close-write-b",
        idempotencyKey: "close-write-b",
      }, {
        type: "message.send",
        roomId: "close-room-b",
        payload: { id: "close-write-b", roomId: "close-room-b", body: "released",
          sentAt: "2026-08-11T00:00:02.000Z" },
      }, now)).resolves.toMatchObject({ aggregateId: "close-write-b" });
      await authority.close();
    });

    it("retains a paused checksum after token expiry and reuses it after refresh", async () => {

    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "paused-checksum-room" }],
    });
    const original = fixture.contexts[0]!;
    const seeded = new DatabaseSync(fixture.authorityPath);
    seeded.prepare(
      "UPDATE sessions SET access_expires_at = 2001 WHERE access_token_hash = ?",
    ).run(original.sessionId);
    seeded.close();
    let now = 2_000;
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    const transport = new PausedChecksumTransport();
    const client = await createSnapshotWorkerClientForTest({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, now),
      streamingAuthority: authority,
      clock: () => now,
    }, () => transport);
    const beginning = client.beginRoomRepair(
      original, "paused-checksum-zero", "paused-checksum-room",
    );
    await transport.checksumReached;
    const concurrentBeginning = client.beginRoomRepair(
      original, "paused-checksum-concurrent-zero", "paused-checksum-room",
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    now = 2_002;
    transport.continueChecksum();
    await expect(beginning).rejects.toMatchObject({ status: 401, code: "token_expired" });
    expect(await concurrentBeginning).toMatchObject({ status: 401, code: "token_expired" });
    const currentRefreshTokenHash = tokenHash(`refresh-${original.sessionId}`);
    const rotated = await authority.rotateSession({
      currentRefreshTokenHash,
      accessTokenHash: tokenHash("paused-checksum-next-access"),
      refreshTokenHash: tokenHash("paused-checksum-next-refresh"),
      accessExpiresAt: 1_000_000,
      refreshExpiresAt: 2_000_000,
      expectedPrincipal: original.principal,
      now,
    });
    const refreshed: AuthenticatedSessionContext = {
      sessionId: rotated.sessionId,
      sessionFamilyId: rotated.familyId,
      principal: original.principal,
    };

    const page0 = await client.beginRoomRepair(
      refreshed, "paused-checksum-retry-zero", "paused-checksum-room",
    );
    expect(page0).toMatchObject({ mode: "streaming", page: 0, hasMore: true });
    if ("kind" in page0) throw new Error("expected streaming page");
    expect(page0.snapshotId).toBe(transport.snapshotId);
    expect(transport.checksumPasses).toBe(1);
    expect(transport.materializedAttempts).toBe(1);
    await expect(client.readRoomRepairPage(
      refreshed, "paused-checksum-one", page0.snapshotId, 0,
    )).resolves.toMatchObject({ mode: "streaming", page: 1, hasMore: false });
    await client.close();
    await authority.close();
    });
  });

  it("reuses an unauthorized deadline fallback before a second materialized scan", async () => {
    const fixture = await createDatabaseFixture({
      rooms: [{ roomId: "deadline-retry-room", messageCount: 400 }],
    });
    const original = fixture.contexts[0]!;
    const normalized = new DatabaseSync(fixture.authorityPath);
    normalized.prepare(
      "UPDATE streams SET head_seq = 0 WHERE stream_kind = 'room' AND stream_id = ?",
    ).run("deadline-retry-room");
    normalized.close();
    const authority = await createWorkerDatabaseClient({ databasePath: fixture.authorityPath });
    let failPage0 = true;
    let registered: Awaited<ReturnType<StreamingRepairAuthority["registerStreamingRepair"]>> | undefined;
    const streamingAuthority: StreamingRepairAuthority = {
      acquireStreamingRepair: (context, scope, now) =>
        authority.acquireStreamingRepair(context, scope, now),
      async registerStreamingRepair(snapshotId, checksum, pageCount, now) {
        registered = await authority.registerStreamingRepair(snapshotId, checksum, pageCount, now);
        return registered;
      },
      async authorizeStreamingRepairPage(context, snapshotId, page, now) {
        if (failPage0) {
          failPage0 = false;
          throw Object.assign(new Error("expired at page zero"), {
            code: "token_expired", status: 401,
          });
        }
        return authority.authorizeStreamingRepairPage(context, snapshotId, page, now);
      },
      completeStreamingRepair: (context, snapshotId, version, checksum, now) =>
        authority.completeStreamingRepair(context, snapshotId, version, checksum, now),
      releaseStreamingRepair: (context, snapshotId, now) =>
        authority.releaseStreamingRepair(context, snapshotId, now),
    };
    let now = 2_000;
    const paused = await createSnapshotWorkerClientWithPauseForTest({
      authorityPath: fixture.authorityPath,
      cachePath: fixture.cachePath,
      revalidate: (validation) => authority.revalidateSnapshot(validation, now),
      streamingAuthority,
      clock: () => now,
      limits: { buildDeadlineMs: 1, maxRecordsPerPage: 100 },
    });
    const beginning = paused.client.beginRoomRepair(
      original, "deadline-retry-zero", "deadline-retry-room",
    );
    await paused.hooks.waitForFixedView();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    paused.hooks.continueBuild();
    await expect(beginning).rejects.toMatchObject({ status: 401, code: "token_expired" });
    if (registered === undefined) throw new Error("streaming checksum was not attached");
    now = 2_002;
    const rotated = await authority.rotateSession({
      currentRefreshTokenHash: tokenHash(`refresh-${original.sessionId}`),
      accessTokenHash: tokenHash("deadline-retry-next-access"),
      refreshTokenHash: tokenHash("deadline-retry-next-refresh"),
      accessExpiresAt: 1_000_000,
      refreshExpiresAt: 2_000_000,
      expectedPrincipal: original.principal,
      now,
    });
    const refreshed: AuthenticatedSessionContext = {
      sessionId: rotated.sessionId,
      sessionFamilyId: rotated.familyId,
      principal: original.principal,
    };
    const page0 = await paused.client.beginRoomRepair(
      refreshed, "deadline-retry-refreshed-zero", "deadline-retry-room",
    );
    if ("kind" in page0) throw new Error("expected streaming retry page");
    expect(page0).toMatchObject({
      mode: "streaming",
      page: 0,
      snapshotId: registered.snapshotId,
      snapshotChecksum: registered.checksum,
    });
    const hooks = paused.hooks as typeof paused.hooks & {
      materializedBuildCount(): number;
    };
    expect(hooks.materializedBuildCount()).toBe(1);
    await paused.client.close();
    await authority.close();
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

  it.each(["room", "catalog"] as const)(
    "fails terminally when a streaming %s envelope is internally valid but lease-mismatched",
    async (kind) => {
      const context = contextFor(`stream-envelope-${kind}`);
      const expectedRoomId = "stream-envelope-room";
      const snapshotId = `stream-envelope-${kind}-snapshot`;
      const baseLease = {
        snapshotId,
        principalId: context.principal.actorId,
        accountId: context.principal.accountId,
        sessionFamilyId: context.sessionFamilyId,
        scope: kind === "room"
          ? { kind, roomId: expectedRoomId }
          : { kind, principalId: context.principal.actorId },
        version: kind === "room"
          ? { kind, roomId: expectedRoomId, watermark: 7 }
          : { kind, catalogRevision: 11 },
        authorizationRevision: kind === "room" ? 3 : 11,
        idleExpiresAt: "2026-08-11T00:00:30.000Z",
      } as StreamingRepairLease;
      class LeaseMismatchedStreamingTransport extends EventEmitter
        implements SnapshotWorkerTransport {
        postMessage(request: SnapshotWorkerRequest): void {
          queueMicrotask(() => {
            if (request.type === "snapshot.initialize") {
              this.emit("message", { type: "snapshot.ready", requestId: request.requestId });
              return;
            }
            if (request.type === "snapshot.begin-room" ||
                request.type === "snapshot.begin-catalog") {
              this.emit("message", {
                type: "snapshot.fallback", requestId: request.requestId, reason: "quota",
              });
              return;
            }
            if (request.type === "snapshot.cache-count") {
              this.emit("message", {
                type: "snapshot.cache-count", requestId: request.requestId, count: 0,
              });
              return;
            }
            if (request.type !== "snapshot.begin-streaming") return;
            if (kind === "room") {
              this.emit("message", {
                type: "snapshot.streaming-page",
                requestId: request.requestId,
                manifest: {
                  snapshotId,
                  principalId: context.principal.actorId,
                  sessionFamilyId: context.sessionFamilyId,
                  checksum: "stream-envelope-checksum",
                  pageCount: 1,
                  kind: "room",
                  roomId: "wrong-room",
                  accessRevision: 99,
                  watermark: 8,
                },
                page: {
                  type: "room.repair.page",
                  requestId: request.responseRequestId,
                  snapshotId,
                  roomId: "wrong-room",
                  page: 0,
                  records: [],
                  watermark: 8,
                  snapshotChecksum: "stream-envelope-checksum",
                  hasMore: false,
                  mode: "streaming",
                  idleExpiresAt: request.lease.idleExpiresAt,
                },
              });
              return;
            }
            this.emit("message", {
              type: "snapshot.streaming-page",
              requestId: request.requestId,
              manifest: {
                snapshotId,
                principalId: context.principal.actorId,
                sessionFamilyId: context.sessionFamilyId,
                checksum: "stream-envelope-checksum",
                pageCount: 1,
                kind: "catalog",
                catalogRevision: 12,
              },
              page: {
                type: "workspace.bootstrap.page",
                requestId: request.responseRequestId,
                snapshotId,
                page: 0,
                rooms: [],
                catalogRevision: 12,
                snapshotChecksum: "stream-envelope-checksum",
                hasMore: false,
                mode: "streaming",
                idleExpiresAt: request.lease.idleExpiresAt,
              },
            });
          });
        }
        async terminate(): Promise<number> { return 0; }
      }
      const authority: StreamingRepairAuthority = {
        async acquireStreamingRepair() { return baseLease; },
        async registerStreamingRepair(_id, checksum, pageCount) {
          return { ...baseLease, checksum, pageCount, lastPage: 0, highestAuthorizedPage: -1 };
        },
        async authorizeStreamingRepairPage() {
          return { ...baseLease, checksum: "stream-envelope-checksum", pageCount: 1,
            lastPage: 0, highestAuthorizedPage: 0 };
        },
        async completeStreamingRepair(_session, id, version) {
          return { type: "snapshot.completed", requestId: "internal", snapshotId: id, version };
        },
        async releaseStreamingRepair() {},
      };
      const client = await createSnapshotWorkerClientForTest({
        authorityPath: "/not-opened/stream-envelope-authority.sqlite",
        cachePath: "/not-opened/stream-envelope-cache.sqlite",
        revalidate: async () => undefined,
        streamingAuthority: authority,
      }, () => new LeaseMismatchedStreamingTransport());
      const result = kind === "room"
        ? client.beginRoomRepair(context, "stream-envelope-room", expectedRoomId)
        : client.beginWorkspaceBootstrap(context, "stream-envelope-catalog");
      await expect(result).rejects.toMatchObject({
        status: 503,
        code: "snapshot_worker_protocol_error",
      });
    },
  );

  it("keeps raw snapshot worker, cache path, and fault hooks off the package root", async () => {
    const publicApi: Record<string, unknown> = await import("../index.js");
    expect(publicApi).not.toHaveProperty("createSnapshotWorkerClient");
    expect(publicApi).not.toHaveProperty("createSnapshotWorkerClientForTest");
    expect(publicApi).not.toHaveProperty("createSnapshotWorkerClientWithPauseForTest");
    expect(publicApi).not.toHaveProperty("SNAPSHOT_CACHE_SCHEMA_VERSION");
  });
});
