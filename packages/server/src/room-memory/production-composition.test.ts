import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAuthoritativeServerForTest, type AuthoritativeServer } from "../authoritative-server.js";
import { insertLegacyMessageAuthorityRecord } from "../persistence/message-authority-legacy-adapter.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { registerMemoryCorpusSource } from "./corpus-database-authority.js";

describe("FT-05 production composition sentinel", () => {
  let server: AuthoritativeServer | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("starts the public composition noauth with zero fetch, zero fake result, and an unchanged watermark", async () => {
    directory = await mkdtemp(join(tmpdir(), "dao-memory-production-composition-"));
    const databasePath = join(directory, "authority.sqlite");
    const database = new DatabaseSync(databasePath);
    migrateAuthorityDatabase(database);
    database.exec(`
      INSERT INTO actors (id, kind, display_name, reachability, tool_permissions_json)
      VALUES ('human-owner', 'human', 'Owner', 'online', '[]');
      INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
      VALUES ('identity', 'human-owner', 0, 1), ('room', 'room-1', 0, 1);
      INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
      VALUES ('room-1', 'Memory', 'active', '2026-08-20T00:00:00.000Z', 'human-owner');
      INSERT INTO room_memberships (
        room_id, actor_id, kind, role, participation, tool_permissions_json,
        joined_at, configured_at, access_revision
      ) VALUES ('room-1', 'human-owner', 'human', 'owner', NULL, '[]',
        '2026-08-20T00:00:00.000Z', NULL, 0);
    `);
    insertLegacyMessageAuthorityRecord(database, {
      id: "message-1",
      roomId: "room-1",
      authorId: "human-owner",
      authorKind: "human",
      body: "Production noauth source.",
      sentAt: "2026-08-20T00:00:01.000Z",
    });
    registerMemoryCorpusSource(database, {
      roomId: "room-1",
      sourceKind: "message",
      sourceId: "message:message-1",
      sourceRevision: 1,
      serverStreamSeq: 1,
      eligibility: "eligible",
      availability: "readable",
      sourceActorId: "human-owner",
      safeMetadata: { authorKind: "human", messageId: "message-1" },
      readReference: "message-authority:message-1:revision:1",
      occurredAt: "2026-08-20T00:00:01.000Z",
    });
    database.close();

    vi.stubEnv("OPENAI_API_KEY", "");
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    server = await startAuthoritativeServerForTest({
      databasePath,
      snapshotCachePath: join(directory, "snapshot-cache.sqlite"),
      listen: { host: "127.0.0.1", port: 0 },
      actors: [{ id: "human-owner", kind: "human", displayName: "Owner", reachability: "online" }],
      identities: { async verify() { return undefined; } },
      invitationSecretKey: new Uint8Array(32).fill(23),
      sharedAuthority: { maxOfflineReadLeaseMs: 60_000 },
      agentRuntime: { sandboxRoot: join(directory, "agent-sandbox") },
    }, { toolAdapterPathFallbackForTest: true });

    await vi.waitFor(() => {
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(inspection.prepare(`
          SELECT health, memory_watermark AS watermark, corpus_head AS head
          FROM room_memory_stewards WHERE room_id = 'room-1'
        `).get()).toEqual({ health: "noauth", watermark: 0, head: 1 });
      } finally {
        inspection.close();
      }
    }, { timeout: 5_000, interval: 20 });

    const evidence = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(evidence.prepare("SELECT COUNT(*) AS count FROM room_memory_versions").get())
        .toEqual({ count: 0 });
      expect(evidence.prepare("SELECT COUNT(*) AS count FROM room_memory_attempts").get())
        .toEqual({ count: 0 });
    } finally {
      evidence.close();
    }
    expect(fetch).not.toHaveBeenCalled();

    const composition = readFileSync(
      join(process.cwd(), "packages/server/src/authoritative-server.ts"),
      "utf8",
    );
    expect(composition.match(/createOpenAIMemoryStewardProvider\s*\(/gu)).toHaveLength(1);
    expect(composition).not.toMatch(/memory(?:Provider|Steward)(?:ForTest|Fake|Fixture|Noop)/u);
  }, 15_000);
});
