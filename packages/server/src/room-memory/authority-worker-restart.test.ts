import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { registerMemoryCorpusSource } from "./corpus-database-authority.js";

describe("FT-05 real AuthorityWorker restart", () => {
  it("recovers the committed monotonic watermark from SQLite without replaying a batch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-memory-worker-restart-"));
    const databasePath = join(directory, "authority.sqlite");
    const database = new DatabaseSync(databasePath);
    migrateAuthorityDatabase(database);
    database.exec(`
      INSERT INTO actors (id, kind, display_name, tool_permissions_json)
      VALUES ('human-owner', 'human', 'Owner', '[]');
      INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
      VALUES ('identity', 'human-owner', 0, 1), ('room', 'room-1', 0, 1);
      INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
      VALUES ('room-1', 'Memory Room', 'active', '2026-08-20T00:00:00.000Z', 'human-owner');
      INSERT INTO room_memberships (
        room_id, actor_id, kind, role, participation, tool_permissions_json,
        joined_at, configured_at, access_revision
      ) VALUES ('room-1', 'human-owner', 'human', 'owner', NULL, '[]',
        '2026-08-20T00:00:00.000Z', NULL, 0);
      INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
      VALUES ('message-1', 'room-1', 'human-owner', 'human', 'Worker restart source',
        '2026-08-20T00:00:00.000Z');
      INSERT INTO message_revisions (message_id, revision, body, revised_at, revised_by_actor_id)
      VALUES ('message-1', 1, 'Worker restart source', '2026-08-20T00:00:00.000Z', 'human-owner');
      INSERT INTO message_envelopes (
        message_id, room_id, message_kind, lifecycle, current_revision,
        revision_count, created_at, recalled_at, recalled_by_actor_id
      ) VALUES ('message-1', 'room-1', 'human', 'active', 1, 1,
        '2026-08-20T00:00:00.000Z', NULL, NULL);
    `);
    registerMemoryCorpusSource(database, { roomId: "room-1", sourceKind: "message",
      sourceId: "message:message-1", sourceRevision: 1, serverStreamSeq: 1,
      eligibility: "eligible", availability: "readable", sourceActorId: "human-owner",
      safeMetadata: { authorKind: "human", messageId: "message-1" },
      readReference: "message-authority:message-1:revision:1",
      occurredAt: "2026-08-20T00:00:00.000Z" });
    database.close();

    let client = await createWorkerDatabaseClient({ databasePath });
    try {
      await expect(client.inspectSchema()).resolves.toEqual({ version: 27 });
      const claim = await client.executeMemory({ type: "memory.claim", roomId: "room-1",
        jobId: "memory-job:restart", attemptId: "memory-attempt:restart",
        inputSha256: "a".repeat(64), batchSize: 32,
        now: Date.parse("2026-08-20T00:01:00.000Z") }) as {
          kind: "claimed";
          batch: { roomId: string; jobId: string; attemptId: string;
            recoveryGeneration: number; fromWatermarkExclusive: number;
            toCorpusSeqInclusive: number; sourceCount: number } | null;
        };
      expect(claim.batch).toMatchObject({ fromWatermarkExclusive: 0,
        toCorpusSeqInclusive: 1, sourceCount: 1 });
      if (claim.batch === null) throw new Error("worker did not claim batch");
      await expect(client.executeMemory({ type: "memory.complete", batch: claim.batch,
        outputSha256: "b".repeat(64), plan: { schemaVersion: 1, candidates: [] },
        now: Date.parse("2026-08-20T00:02:00.000Z") })).resolves.toEqual({
        kind: "completed", committed: true,
      });
      await client.close();

      client = await createWorkerDatabaseClient({ databasePath });
      await expect(client.executeMemory({ type: "memory.readiness", roomId: "room-1" }))
        .resolves.toEqual({ kind: "readiness", readiness: { status: "healthy",
          memoryWatermark: 1, corpusHead: 1, rawDeltaComplete: true,
          injectableSnapshotReadable: true } });
      await expect(client.executeMemory({ type: "memory.claim", roomId: "room-1",
        jobId: "memory-job:must-not-replay", attemptId: "memory-attempt:must-not-replay",
        inputSha256: "c".repeat(64), batchSize: 32,
        now: Date.parse("2026-08-20T00:03:00.000Z") })).resolves.toEqual({
        kind: "claimed", batch: null, sources: [],
      });
    } finally {
      await client.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
