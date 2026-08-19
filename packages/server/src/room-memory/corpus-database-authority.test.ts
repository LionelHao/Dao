import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  MemoryCorpusDatabaseError,
  readMemoryCorpusDelta,
  readMemoryCorpusSource,
  registerMemoryCorpusSource,
  transitionMemoryCorpusSource,
  type RegisterMemoryCorpusSourceInput,
} from "./corpus-database-authority.js";

const NOW = "2026-08-19T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "dao-memory-corpus-"));
  temporaryDirectories.push(directory);
  const value = new DatabaseSync(join(directory, "authority.sqlite"));
  migrateAuthorityDatabase(value);
  value.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json)
    VALUES ('human-1', 'human', 'Human', '[]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'human-1', 0, 1), ('room', 'room-1', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES ('room-1', 'Room', 'active', '${NOW}', 'human-1');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES ('room-1', 'human-1', 'human', 'owner', NULL, '[]', '${NOW}', NULL, 0);
  `);
  return value;
}

function source(index: number, overrides: Partial<RegisterMemoryCorpusSourceInput> = {}): RegisterMemoryCorpusSourceInput {
  return {
    roomId: "room-1",
    sourceKind: "message",
    sourceId: `message:message-${index}`,
    sourceRevision: 1,
    serverStreamSeq: index,
    eligibility: "eligible",
    availability: "readable",
    sourceActorId: "human-1",
    safeMetadata: { authorKind: "human", messageId: `message-${index}` },
    readReference: `message-authority:message-${index}:revision:1`,
    occurredAt: NOW,
    ...overrides,
  };
}

describe("FT-05 full Room corpus source authority", () => {
  it("retains the earliest source by stable identity after more than 64 accepted sources", () => {
    const db = database();
    try {
      for (let index = 1; index <= 70; index += 1) registerMemoryCorpusSource(db, source(index));
      expect(readMemoryCorpusSource(db, {
        roomId: "room-1", sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
      })).toMatchObject({
        corpusSeq: 1,
        sourceId: "message:message-1",
        authorizedReadRef: { sourceKind: "message", opaqueId: "message-authority:message-1:revision:1" },
      });
      expect(db.prepare("SELECT corpus_head AS head FROM room_memory_stewards WHERE room_id = 'room-1'").get())
        .toEqual({ head: 70 });
    } finally { db.close(); }
  });

  it("returns exact replay for the same source and rejects changed identity payload", () => {
    const db = database();
    try {
      expect(registerMemoryCorpusSource(db, source(1))).toMatchObject({ replayed: false, source: { corpusSeq: 1 } });
      expect(registerMemoryCorpusSource(db, source(1))).toMatchObject({ replayed: true, source: { corpusSeq: 1 } });
      expect(() => registerMemoryCorpusSource(db, source(1, { serverStreamSeq: 2 })))
        .toThrowError(MemoryCorpusDatabaseError);
      expect(db.prepare("SELECT COUNT(*) AS count FROM room_memory_sources").get()).toEqual({ count: 1 });
    } finally { db.close(); }
  });

  it("rejects non-canonical source identities and any raw/path field at the corpus boundary", () => {
    const db = database();
    try {
      expect(() => registerMemoryCorpusSource(db, {
        ...source(1),
        sourceId: "message-revision:wrong-kind",
      })).toThrowError(MemoryCorpusDatabaseError);
      expect(() => registerMemoryCorpusSource(db, {
        ...source(1),
        rawBody: "RAW-MESSAGE-CANARY",
      } as RegisterMemoryCorpusSourceInput)).toThrowError(MemoryCorpusDatabaseError);
      expect(() => registerMemoryCorpusSource(db, {
        ...source(1),
        readReference: "file:/Users/secret/message.txt",
      })).toThrowError(MemoryCorpusDatabaseError);
      expect(db.prepare("SELECT COUNT(*) AS count FROM room_memory_sources").get())
        .toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it("orders message, revision, tombstone, and bound extraction sources without storing raw content", () => {
    const db = database();
    try {
      const canaries = {
        rawMessageBody: "RAW-MESSAGE-CANARY",
        rawExtraction: "RAW-EXTRACTION-CANARY",
      };
      registerMemoryCorpusSource(db, source(1));
      registerMemoryCorpusSource(db, source(2, {
        sourceKind: "message_revision", sourceId: "message-revision:message-1", sourceRevision: 2,
        readReference: "message-authority:message-1:revision:2",
        safeMetadata: { authorKind: "human", messageId: "message-1" },
      }));
      registerMemoryCorpusSource(db, source(3, {
        sourceKind: "message_tombstone", sourceId: "message-tombstone:message-1", sourceRevision: 3,
        availability: "tombstone", eligibility: "excluded_recalled",
        readReference: "message-authority:tombstone:message-1:recall:3",
        safeMetadata: { messageId: "message-1", lifecycle: "recalled" },
      }));
      registerMemoryCorpusSource(db, source(4, {
        sourceKind: "attachment_extraction", sourceId: "attachment-extraction:attachment-1", sourceRevision: 4,
        sourceActorId: null,
        readReference: "attachment-authority:attachment-1:generation:4",
        safeMetadata: { attachmentId: "attachment-1", messageId: "message-4", status: "ready-bound-active" },
      }));
      const page = readMemoryCorpusDelta(db, { roomId: "room-1", fromCorpusSeqExclusive: 0, limit: 64 });
      expect(page.entries.map((entry) => entry.sourceKind)).toEqual([
        "message", "message_revision", "message_tombstone", "attachment_extraction",
      ]);
      const serializedIndex = JSON.stringify(db.prepare("SELECT * FROM room_memory_sources ORDER BY corpus_seq").all());
      expect(serializedIndex).not.toContain(canaries.rawMessageBody);
      expect(serializedIndex).not.toContain(canaries.rawExtraction);
      expect(serializedIndex).not.toMatch(/object[_-]?key|token|https?:\/\//iu);
    } finally { db.close(); }
  });

  it("paginates the frozen corpus head without gaps or duplicate source sequence", () => {
    const db = database();
    try {
      for (let index = 1; index <= 130; index += 1) registerMemoryCorpusSource(db, source(index));
      const first = readMemoryCorpusDelta(db, { roomId: "room-1", fromCorpusSeqExclusive: 0, limit: 64 });
      const second = readMemoryCorpusDelta(db, { roomId: "room-1", fromCorpusSeqExclusive: first.nextCorpusSeq, limit: 64, frozenCorpusHead: first.frozenCorpusHead });
      const third = readMemoryCorpusDelta(db, { roomId: "room-1", fromCorpusSeqExclusive: second.nextCorpusSeq, limit: 64, frozenCorpusHead: first.frozenCorpusHead });
      const all = [...first.entries, ...second.entries, ...third.entries];
      expect(all.map((entry) => entry.corpusSeq)).toEqual(Array.from({ length: 130 }, (_, index) => index + 1));
      expect(new Set(all.map((entry) => `${entry.sourceKind}:${entry.sourceId}:${entry.sourceRevision}`)).size).toBe(130);
      expect(third.hasMore).toBe(false);
    } finally { db.close(); }
  });

  it("immediately removes read authority after recall/revoke while retaining a body-free identity", () => {
    const db = database();
    try {
      registerMemoryCorpusSource(db, source(1));
      transitionMemoryCorpusSource(db, {
        roomId: "room-1", sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
        eligibility: "excluded_recalled", availability: "tombstone", occurredAt: NOW,
      });
      expect(readMemoryCorpusSource(db, {
        roomId: "room-1", sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
      })).toMatchObject({
        eligibility: "excluded_recalled",
        availability: "tombstone",
        authorizedReadRef: { sourceKind: "message", opaqueId: "message-authority:message-1:revision:1" },
      });
      const delta = readMemoryCorpusDelta(db, { roomId: "room-1", fromCorpusSeqExclusive: 0, limit: 64 });
      expect(delta.entries[0]).toMatchObject({
        availability: "tombstone",
        authorizedReadRef: { sourceKind: "message", opaqueId: "message-authority:message-1:revision:1" },
      });
      expect(JSON.stringify(delta)).not.toContain("RAW-MESSAGE-CANARY");
    } finally { db.close(); }
  });
});
