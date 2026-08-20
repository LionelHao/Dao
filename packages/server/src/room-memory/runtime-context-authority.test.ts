import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRoomMemoryRawDeltaPage } from "@native-im/core";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { registerMemoryCorpusSource } from "./corpus-database-authority.js";
import { beginRoomMemoryAttempt, commitRoomMemoryPlan, createRoomMemoryJob,
  invalidateRoomMemorySource } from "./database-authority.js";
import { readRoomMemoryRuntimeContext, RoomMemoryRuntimeContextError } from "./runtime-context-authority.js";

function source(database: DatabaseSync, ordinal: number): void {
  registerMemoryCorpusSource(database, { roomId: "room-1", sourceKind: "message",
    sourceId: `message:message-${ordinal}`, sourceRevision: 1, serverStreamSeq: ordinal,
    eligibility: "eligible", availability: "readable", sourceActorId: "human-owner",
    safeMetadata: { authorKind: "human", messageId: `message-${ordinal}` },
    readReference: `message-authority:message-${ordinal}:revision:1`,
    occurredAt: "2026-08-20T00:00:00.000Z" });
}

describe("FT-05 server-private runtime memory seam", () => {
  it("returns active snapshot plus a fixed-head ordered raw delta without raw bodies", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-memory-runtime-context-"));
    const database = new DatabaseSync(join(directory, "authority.sqlite"));
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
    `);
    try {
      for (let ordinal = 1; ordinal <= 130; ordinal += 1) source(database, ordinal);
      const job = createRoomMemoryJob(database, { roomId: "room-1", jobId: "job-1",
        batchSize: 32, availableAt: "2026-08-20T00:01:00.000Z",
        createdAt: "2026-08-20T00:01:00.000Z" })!;
      const attempt = beginRoomMemoryAttempt(database, { roomId: "room-1", jobId: job.jobId,
        attemptId: "attempt-1", inputSha256: "a".repeat(64),
        startedAt: "2026-08-20T00:01:00.000Z" })!;
      commitRoomMemoryPlan(database, { roomId: "room-1", jobId: job.jobId,
        attemptId: attempt.attemptId, recoveryGeneration: job.recoveryGeneration,
        outputSha256: "b".repeat(64), committedAt: "2026-08-20T00:02:00.000Z",
        plan: { schemaVersion: 1, candidates: [{ operation: "create", kind: "context",
          derivedText: "Validated context.", sourceRefs: [{ sourceKind: "message",
            sourceId: "message:message-1", sourceRevision: 1 }], dedupeKey: "runtime-context",
          replacesMemoryRecordId: null }] } });

      const first = readRoomMemoryRuntimeContext(database, { roomId: "room-1",
        authorizationEpoch: 7 });
      expect(first.injectableSnapshot).toHaveLength(1);
      expect(first.status.health).toMatchObject({ state: "catching_up", memoryWatermark: 32,
        corpusHead: 130, lag: 98 });
      expect(first.rawDelta.entries).toHaveLength(64);
      expect(first.rawDelta.entries[0]?.corpusSeq).toBe(33);
      expect(first.rawDelta.entries.at(-1)?.corpusSeq).toBe(96);
      expect(first.rawDelta.hasMore).toBe(true);
      expect(isRoomMemoryRawDeltaPage(first.rawDelta)).toBe(true);
      expect(JSON.stringify(first)).not.toMatch(/Validated source body|rawBody|content/iu);

      source(database, 131);
      const advancedJob = createRoomMemoryJob(database, { roomId: "room-1", jobId: "job-2",
        batchSize: 32, availableAt: "2026-08-20T00:02:10.000Z",
        createdAt: "2026-08-20T00:02:10.000Z" })!;
      const advancedAttempt = beginRoomMemoryAttempt(database, { roomId: "room-1",
        jobId: advancedJob.jobId, attemptId: "attempt-2", inputSha256: "c".repeat(64),
        startedAt: "2026-08-20T00:02:10.000Z" })!;
      commitRoomMemoryPlan(database, { roomId: "room-1", jobId: advancedJob.jobId,
        attemptId: advancedAttempt.attemptId,
        recoveryGeneration: advancedJob.recoveryGeneration, outputSha256: "d".repeat(64),
        committedAt: "2026-08-20T00:02:20.000Z",
        plan: { schemaVersion: 1, candidates: [] } });
      const second = readRoomMemoryRuntimeContext(database, { roomId: "room-1",
        authorizationEpoch: 7, cursor: first.rawDelta.nextCursor });
      expect(second.rawDelta.entries.map(({ corpusSeq }) => corpusSeq)).toEqual(
        Array.from({ length: 34 }, (_value, index) => 97 + index),
      );
      expect(second.rawDelta.toCorpusSeqInclusive).toBe(130);
      expect(second.rawDelta.hasMore).toBe(false);
      expect(() => readRoomMemoryRuntimeContext(database, { roomId: "room-1",
        authorizationEpoch: 8, cursor: first.rawDelta.nextCursor })).toThrowError(
        new RoomMemoryRuntimeContextError("cursor_stale"),
      );

      invalidateRoomMemorySource(database, { roomId: "room-1", sourceKind: "message",
        sourceId: "message:message-1", sourceRevision: 1,
        eligibility: "excluded_recalled", availability: "metadata_only",
        occurredAt: "2026-08-20T00:03:00.000Z" });
      const recalled = readRoomMemoryRuntimeContext(database, { roomId: "room-1",
        authorizationEpoch: 9 });
      expect(recalled.injectableSnapshot).toEqual([]);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
