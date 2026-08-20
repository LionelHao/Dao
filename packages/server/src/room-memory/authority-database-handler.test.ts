import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isRoomMemoryProtocolFrame } from "@native-im/core";
import { parsePersistedRoomEvent } from "../persistence/contracts.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { AuthorityDatabaseError } from "../persistence/authority-database-handler.js";
import { registerMemoryCorpusSource } from "./corpus-database-authority.js";
import { executeMemoryAuthorityOperation } from "./authority-database-handler.js";
import { isMemoryAuthorityBatch } from "./authority-protocol.js";

const T0 = Date.parse("2026-08-19T00:00:00.000Z");
const T1 = T0 + 60_000;
const context = Object.freeze({
  sessionId: "access-owner",
  sessionFamilyId: "family-owner",
  principal: Object.freeze({ accountId: "account-owner", actorId: "human-owner" }),
});

function fixture(): Readonly<{ database: DatabaseSync; close(): void }> {
  const directory = mkdtempSync(join(tmpdir(), "dao-memory-authority-handler-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json)
    VALUES ('human-owner', 'human', 'Owner', '[]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'human-owner', 0, 1), ('room', 'room-1', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES ('room-1', 'Memory Room', 'active', '2026-08-19T00:00:00.000Z', 'human-owner');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES (
      'room-1', 'human-owner', 'human', 'owner', NULL, '[]',
      '2026-08-19T00:00:00.000Z', NULL, 0
    );
    INSERT INTO session_families (
      family_id, public_id, account_id, actor_id, device_id, device_label,
      platform, created_at, refresh_expires_at, revoked_at
    ) VALUES (
      'family-owner', 'public-family-owner', 'account-owner', 'human-owner',
      'device-owner', 'Owner device', 'unknown', ${T0}, ${T0 + 7_200_000}, NULL
    );
    INSERT INTO sessions (
      family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
      access_expires_at, refresh_expires_at
    ) VALUES (
      'family-owner', 'account-owner', 'human-owner', 'access-owner', 'refresh-owner',
      ${T0 + 3_600_000}, ${T0 + 7_200_000}
    );
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES ('message-1', 'room-1', 'human-owner', 'human', 'The launch date is Friday.',
            '2026-08-19T00:00:00.000Z');
    INSERT INTO message_revisions (message_id, revision, body, revised_at, revised_by_actor_id)
    VALUES ('message-1', 1, 'The launch date is Friday.', '2026-08-19T00:00:00.000Z', 'human-owner');
    INSERT INTO message_envelopes (
      message_id, room_id, message_kind, lifecycle, current_revision,
      revision_count, created_at, recalled_at, recalled_by_actor_id
    ) VALUES (
      'message-1', 'room-1', 'human', 'active', 1, 1,
      '2026-08-19T00:00:00.000Z', NULL, NULL
    );
  `);
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
    occurredAt: "2026-08-19T00:00:00.000Z",
  });
  return {
    database,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function claimed(database: DatabaseSync) {
  const result = executeMemoryAuthorityOperation(database, {
    type: "memory.claim",
    roomId: "room-1",
    jobId: "memory-job:one",
    attemptId: "memory-attempt:one",
    inputSha256: "a".repeat(64),
    batchSize: 32,
    now: T1,
  });
  expect(result.kind).toBe("claimed");
  if (result.kind !== "claimed" || result.batch === null) throw new Error("claim missing");
  expect(isMemoryAuthorityBatch(result.batch)).toBe(true);
  return result.batch;
}

describe("FT-05 AuthorityWorker Room Memory operations", () => {
  it("authorizes a frozen source, atomically advances the watermark, and emits safe stable events", () => {
    const value = fixture();
    try {
      const batch = claimed(value.database);
      const source = executeMemoryAuthorityOperation(value.database, {
        type: "memory.source-authorize",
        batch,
        sourceKind: "message",
        sourceId: "message:message-1",
        sourceRevision: 1,
        now: T1,
      });
      expect(source).toMatchObject({
        kind: "source",
        source: { kind: "message", content: "The launch date is Friday.", corpusSeq: 1 },
      });

      const completed = executeMemoryAuthorityOperation(value.database, {
        type: "memory.complete",
        batch,
        outputSha256: "b".repeat(64),
        plan: {
          schemaVersion: 1,
          candidates: [{
            operation: "create",
            kind: "context",
            derivedText: "Launch is scheduled for Friday.",
            sourceRefs: [{
              sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
            }],
            dedupeKey: "launch-date",
            replacesMemoryRecordId: null,
          }],
        },
        now: T1 + 1,
      });
      expect(completed).toEqual({ kind: "completed", committed: true });
      expect(value.database.prepare(`
        SELECT memory_watermark AS watermark, corpus_head AS head, health
        FROM room_memory_stewards WHERE room_id = 'room-1'
      `).get()).toEqual({ watermark: 1, head: 1, health: "healthy" });

      const rows = value.database.prepare(`
        SELECT event_id AS eventId, stream_kind AS streamKind, stream_id AS streamId,
               stream_seq AS streamSeq, room_id AS roomId, actor_id AS actorId,
               occurred_at AS occurredAt, event_type AS type, payload_json AS payloadJson
        FROM events WHERE event_type LIKE 'room.memory.%' ORDER BY stream_seq
      `).all();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const parsed = parsePersistedRoomEvent({
          eventId: row.eventId,
          streamKind: row.streamKind,
          streamId: row.streamId,
          streamSeq: row.streamSeq,
          roomId: row.roomId,
          actorId: row.actorId,
          occurredAt: row.occurredAt,
          type: row.type,
          payload: JSON.parse(row.payloadJson as string) as unknown,
        });
        expect(parsed.ok).toBe(true);
        expect(JSON.stringify(row)).not.toContain("The launch date is Friday.");
      }
      expect(value.database.prepare(`
        SELECT COUNT(*) AS count FROM outbox_deliveries
        WHERE event_id IN (SELECT event_id FROM events WHERE event_type LIKE 'room.memory.%')
      `).get()).toEqual({ count: 2 });
    } finally {
      value.close();
    }
  });

  it("serves authorized public query/source/dispute/resolve and preserves archived read-only access", () => {
    const value = fixture();
    try {
      const batch = claimed(value.database);
      executeMemoryAuthorityOperation(value.database, {
        type: "memory.complete",
        batch,
        outputSha256: "b".repeat(64),
        plan: {
          schemaVersion: 1,
          candidates: [{
            operation: "create", kind: "context", derivedText: "Friday launch.",
            sourceRefs: [{ sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1 }],
            dedupeKey: "launch", replacesMemoryRecordId: null,
          }],
        },
        now: T1 + 1,
      });
      const page = executeMemoryAuthorityOperation(value.database, {
        type: "memory.public",
        context,
        request: { type: "room.memory.query.v1", requestId: "query-1", roomId: "room-1" },
        now: T1 + 2,
      });
      expect(page.kind).toBe("public");
      if (page.kind !== "public" || page.frame.type !== "room.memory.page.v1") throw new Error("page missing");
      expect(isRoomMemoryProtocolFrame(page.frame)).toBe(true);
      const memoryRecordId = page.frame.items[0]!.memoryRecordId;

      const source = executeMemoryAuthorityOperation(value.database, {
        type: "memory.public",
        context,
        request: {
          type: "room.memory.source.query.v1", requestId: "source-1", roomId: "room-1",
          sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
        },
        now: T1 + 3,
      });
      expect(source).toMatchObject({
        kind: "public",
        frame: { type: "room.memory.source.v1", source: {
          metadata: { speakerActorId: "human-owner", provenance: "message-authority" },
          navigation: { kind: "message", messageId: "message-1" },
        } },
      });

      const disputed = executeMemoryAuthorityOperation(value.database, {
        type: "memory.public",
        context,
        request: {
          type: "room.memory.context.dispute.v1", requestId: "dispute-1", roomId: "room-1",
          memoryRecordId, expectedVersion: 1, reason: "The date is disputed.",
        },
        now: T1 + 4,
      });
      expect(disputed).toMatchObject({
        kind: "public",
        frame: { type: "room.memory.context.dispute.accepted.v1", projection: {
          currentVersion: { state: "disputed", version: 2 },
        } },
      });
      const resolved = executeMemoryAuthorityOperation(value.database, {
        type: "memory.public",
        context,
        request: {
          type: "room.memory.context.resolve.v1", requestId: "resolve-1", roomId: "room-1",
          memoryRecordId, expectedVersion: 2, resolution: "resolve", reason: "Source was rechecked.",
        },
        now: T1 + 5,
      });
      expect(resolved).toMatchObject({
        kind: "public",
        frame: { type: "room.memory.context.resolve.accepted.v1", projection: {
          currentVersion: { state: "active", version: 4 },
        } },
      });

      value.database.exec("UPDATE rooms SET status = 'archived', archive_generation = archive_generation + 1 WHERE id = 'room-1'");
      expect(executeMemoryAuthorityOperation(value.database, {
        type: "memory.public",
        context,
        request: { type: "room.memory.status.query.v1", requestId: "status-archived", roomId: "room-1" },
        now: T1 + 6,
      })).toMatchObject({ kind: "public", frame: { type: "room.memory.status.v1" } });
      expect(() => executeMemoryAuthorityOperation(value.database, {
        type: "memory.public",
        context,
        request: {
          type: "room.memory.context.dispute.v1", requestId: "dispute-archived", roomId: "room-1",
          memoryRecordId, expectedVersion: 4, reason: "Archived mutation.",
        },
        now: T1 + 7,
      })).toThrowError(expect.objectContaining({ code: "room_archived" }));
    } finally {
      value.close();
    }
  });

  it("marks noauth without claiming or advancing and fences a source that becomes recalled", () => {
    const value = fixture();
    try {
      executeMemoryAuthorityOperation(value.database, { type: "memory.mark-noauth", roomId: "room-1", now: T1 });
      expect(executeMemoryAuthorityOperation(value.database, { type: "memory.readiness", roomId: "room-1" }))
        .toMatchObject({ kind: "readiness", readiness: { status: "noauth", memoryWatermark: 0, corpusHead: 1 } });
      const noClaim = executeMemoryAuthorityOperation(value.database, {
        type: "memory.claim", roomId: "room-1", jobId: "memory-job:noauth",
        attemptId: "memory-attempt:noauth", inputSha256: "a".repeat(64), batchSize: 32, now: T1 + 1,
      });
      expect(noClaim).toEqual({ kind: "claimed", batch: null, sources: [] });
      expect(value.database.prepare("SELECT COUNT(*) AS count FROM room_memory_attempts").get()).toEqual({ count: 0 });

      executeMemoryAuthorityOperation(value.database, { type: "memory.mark-ready", roomId: "room-1", now: T1 + 2 });
      const batch = claimed(value.database);
      value.database.exec(`
        UPDATE room_memory_sources SET eligibility = 'excluded_recalled', availability = 'metadata_only'
          WHERE room_id = 'room-1' AND source_kind = 'message' AND source_id = 'message:message-1';
      `);
      expect(() => executeMemoryAuthorityOperation(value.database, {
        type: "memory.source-authorize", batch, sourceKind: "message",
        sourceId: "message:message-1", sourceRevision: 1, now: T1 + 3,
      })).toThrowError(AuthorityDatabaseError);
    } finally {
      value.close();
    }
  });
});
