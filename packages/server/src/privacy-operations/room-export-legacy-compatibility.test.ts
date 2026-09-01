import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
} from "../persistence/schema.js";
import { importLegacyState } from "../persistence/legacy-importer.js";
import { executeHumanDatabaseCommand } from "../persistence/authority-database-handler.js";
import {
  executePrivacyDataAuthorityOperation,
} from "./data-authority-database-handler.js";
import type { RoomExportRecord } from "./room-export.js";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const STARTED_AT = new Date(NOW).toISOString();
const directories = new Set<string>();

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dao-room-export-legacy-"));
  directories.add(directory);
  return directory;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function readAll(database: DatabaseSync, input: Readonly<{
  actorId: string;
  sessionFamilyId: string;
  sessionId: string;
  roomId: string;
  watermark?: number;
}>): RoomExportRecord[] {
  const binding = database.prepare(
    `SELECT room.status AS lifecycle, membership.access_revision AS accessRevision,
            stream.head_seq AS watermark
     FROM rooms AS room
     JOIN room_memberships AS membership
       ON membership.room_id = room.id AND membership.actor_id = ?
     JOIN streams AS stream ON stream.stream_kind = 'room' AND stream.stream_id = room.id
     WHERE room.id = ?`,
  ).get(input.actorId, input.roomId) as {
    lifecycle: "active" | "archived"; accessRevision: number; watermark: number;
  };
  const records: RoomExportRecord[] = [];
  let after: string | undefined;
  do {
    const page = executePrivacyDataAuthorityOperation(database, {
      version: 1,
      type: "privacy.room-export.read-page",
      ...input,
      tenantId: "deployment-singleton",
      accessRevision: binding.accessRevision,
      lifecycle: binding.lifecycle,
      exportId: "export-legacy-compatibility",
      watermark: input.watermark ?? binding.watermark,
      startedAt: STARTED_AT,
      ...(after === undefined ? {} : { after }),
      limit: 100,
      now: NOW,
    });
    if (page.kind !== "room-export-page") throw new Error("unexpected privacy result");
    records.push(...page.records);
    after = page.next;
  } while (after !== undefined);
  return records;
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

describe("Room export compatibility for immutable pre-event authority facts", () => {
  it("exports populated v1 messages and governance after the real v1-to-v29 migration", () => {
    const directory = temporaryDirectory();
    const database = new DatabaseSync(join(directory, "authority.sqlite"));
    try {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 1);
      database.exec(`
        INSERT INTO actors (id, kind, display_name) VALUES
          ('owner-v1', 'human', 'Owner'), ('other-v1', 'human', 'Other');
        INSERT INTO sessions (
          family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
          access_expires_at, refresh_expires_at, revoked_at
        ) VALUES (
          'family-v1', 'account-v1', 'owner-v1', 'access-v1', 'refresh-v1',
          ${NOW + 60_000}, ${NOW + 120_000}, NULL
        );
        INSERT INTO rooms (id, name, status, created_at) VALUES
          ('room-v1', 'Legacy room', 'active', '2026-08-01T00:00:00.000Z'),
          ('room-other-v1', 'Other room', 'active', '2026-08-01T00:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at
        ) VALUES
          ('room-v1', 'owner-v1', 'human', 'owner', NULL, '[]',
           '2026-08-01T00:00:00.000Z', NULL),
          ('room-other-v1', 'other-v1', 'human', 'owner', NULL, '[]',
           '2026-08-01T00:00:00.000Z', NULL);
        INSERT INTO room_audit (
          id, type, room_id, actor_id, result, timestamp, details_json
        ) VALUES
          ('audit-v1', 'room.created', 'room-v1', 'owner-v1', 'created',
           '2026-08-01T00:00:00.000Z', '{"topicKey":"legacy-room"}'),
          ('audit-other-v1', 'room.created', 'room-other-v1', 'other-v1', 'created',
           '2026-08-01T00:00:00.000Z', '{}');
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at) VALUES
          ('message-v1', 'room-v1', 'owner-v1', 'human', 'v1 historical body',
           '2026-08-01T00:01:00.000Z'),
          ('message-other-v1', 'room-other-v1', 'other-v1', 'human', 'cross-room body',
           '2026-08-01T00:01:00.000Z');
      `);
      migrateAuthorityDatabase(database);

      const futureDated = executeHumanDatabaseCommand(database, {
        context: {
          kind: "human",
          sessionId: "access-v1",
          sessionFamilyId: "family-v1",
          principal: { accountId: "account-v1", actorId: "owner-v1" },
          requestId: "future-dated-message-request",
          idempotencyKey: "future-dated-message-request",
        },
        command: {
          type: "message.send",
          roomId: "room-v1",
          payload: {
            id: "future-dated-message",
            roomId: "room-v1",
            body: "future-dated accepted body",
            sentAt: "2026-09-02T00:00:00.000Z",
          },
        },
        now: NOW - 1_000,
      });
      expect(futureDated.acknowledgement.acceptedAt).toBe("2026-08-31T23:59:59.000Z");

      const records = readAll(database, {
        actorId: "owner-v1", sessionFamilyId: "family-v1", sessionId: "access-v1",
        roomId: "room-v1",
      });
      expect(records).toContainEqual(expect.objectContaining({
        category: "message", entityId: "message-v1", revision: 1,
      }));
      expect(records).toContainEqual(expect.objectContaining({
        category: "message_revision", entityId: "message-v1:revision:1",
        payload: expect.objectContaining({ body: "v1 historical body", isCurrent: 1 }),
      }));
      expect(records).toContainEqual(expect.objectContaining({
        category: "message", entityId: "future-dated-message", revision: 1,
      }));
      expect(records).toContainEqual(expect.objectContaining({
        category: "message_revision", entityId: "future-dated-message:revision:1",
        payload: expect.objectContaining({ body: "future-dated accepted body" }),
      }));
      expect(records).toContainEqual(expect.objectContaining({
        category: "membership_governance_audit", entityId: "audit:audit-v1", revision: 0,
      }));
      expect(JSON.stringify(records)).not.toContain("cross-room body");

      const sent = executeHumanDatabaseCommand(database, {
        context: {
          kind: "human",
          sessionId: "access-v1",
          sessionFamilyId: "family-v1",
          principal: { accountId: "account-v1", actorId: "owner-v1" },
          requestId: "post-watermark-message-request",
          idempotencyKey: "post-watermark-message-request",
        },
        command: {
          type: "message.send",
          roomId: "room-v1",
          payload: {
            id: "post-watermark-message",
            roomId: "room-v1",
            body: "post-watermark-body",
            // Client time is deliberately before the fixed snapshot start while the
            // authoritative acceptance event is appended after watermark zero.
            sentAt: "2026-08-01T00:02:00.000Z",
          },
        },
        now: NOW + 1_000,
      });
      expect(sent.acknowledgement.acceptedAt).toBe("2026-09-01T00:00:01.000Z");
      expect(database.prepare(
        `SELECT revision.revised_at AS revisedAt, event.occurred_at AS acceptedAt
         FROM message_revisions AS revision
         JOIN events AS event
           ON event.stream_id = 'room-v1' AND event.event_type = 'room.message.accepted'
          AND json_extract(event.payload_json, '$.id') = revision.message_id
         WHERE revision.message_id = 'post-watermark-message'`,
      ).get()).toEqual({
        revisedAt: "2026-08-01T00:02:00.000Z",
        acceptedAt: "2026-09-01T00:00:01.000Z",
      });
      database.exec(`
        INSERT INTO room_audit (
          id, type, room_id, actor_id, result, timestamp, details_json
        ) VALUES ('post-watermark-audit', 'room.renamed', 'room-v1', 'owner-v1',
          'renamed', '2026-08-01T00:03:00.000Z', '{"name":"post-watermark"}');
        UPDATE streams SET head_seq = 3
        WHERE stream_kind = 'room' AND stream_id = 'room-v1';
        INSERT INTO events (
          event_id, stream_kind, stream_id, stream_seq, room_id, actor_id,
          event_type, occurred_at, payload_json
        ) VALUES ('post-watermark-audit-event', 'room', 'room-v1', 3, 'room-v1',
          'owner-v1', 'room.renamed', '2026-08-01T00:03:00.000Z',
          '{"name":"post-watermark"}');
      `);
      const oldWatermarkRecords = readAll(database, {
        actorId: "owner-v1", sessionFamilyId: "family-v1", sessionId: "access-v1",
        roomId: "room-v1", watermark: 1,
      });
      expect(oldWatermarkRecords).not.toContainEqual(expect.objectContaining({
        category: "message", entityId: "post-watermark-message",
      }));
      expect(oldWatermarkRecords).not.toContainEqual(expect.objectContaining({
        category: "message_revision", entityId: "post-watermark-message:revision:1",
      }));
      expect(JSON.stringify(oldWatermarkRecords)).not.toContain("post-watermark");
    } finally {
      database.close();
    }
  });

  it("exports real legacy-import messages and audits from a zero-watermark room", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "authority.sqlite");
    const sessionFilePath = join(directory, "sessions.json");
    const roomFilePath = join(directory, "rooms.json");
    const messageFilePath = join(directory, "messages.jsonl");
    const familyId = hash("legacy-family");
    const accessTokenHash = hash("legacy-access");
    writeFileSync(sessionFilePath, JSON.stringify({
      version: 1,
      sessions: [{
        familyId, accountId: "legacy-account", actorId: "legacy-owner",
        accessTokenHash, refreshTokenHash: hash("legacy-refresh"),
        accessExpiresAt: NOW + 60_000, refreshExpiresAt: NOW + 120_000,
      }],
    }));
    writeFileSync(roomFilePath, JSON.stringify({
      version: 1,
      actors: [{ id: "legacy-owner", kind: "human", displayName: "Owner",
        reachability: "online" }],
      rooms: [{
        id: "legacy-room", name: "Imported", status: "active",
        members: [{ kind: "human", actorId: "legacy-owner", role: "owner",
          joinedAt: "2026-08-02T00:00:00.000Z" }],
        createdAt: "2026-08-02T00:00:00.000Z",
      }],
      invitations: [],
      audit: [{
        id: "legacy-audit", type: "room.created", roomId: "legacy-room",
        actorId: "legacy-owner", result: "created",
        timestamp: "2026-08-02T00:00:00.000Z",
      }],
    }));
    writeFileSync(messageFilePath, `${JSON.stringify({
      id: "legacy-message", roomId: "legacy-room", authorId: "legacy-owner",
      authorKind: "human", body: "legacy imported body",
      sentAt: "2026-08-02T00:01:00.000Z",
    })}\n`);
    await importLegacyState({ databasePath, sessionFilePath, roomFilePath, messageFilePath });

    const database = new DatabaseSync(databasePath);
    try {
      expect(database.prepare(
        "SELECT head_seq AS headSeq FROM streams WHERE stream_kind='room' AND stream_id='legacy-room'",
      ).get()).toEqual({ headSeq: 0 });
      const records = readAll(database, {
        actorId: "legacy-owner", sessionFamilyId: familyId, sessionId: accessTokenHash,
        roomId: "legacy-room",
      });
      expect(records.filter(({ category }) => category === "message")).toHaveLength(1);
      expect(records).toContainEqual(expect.objectContaining({
        category: "message_revision", entityId: "legacy-message:revision:1",
        payload: expect.objectContaining({ body: "legacy imported body" }),
      }));
      expect(records).toContainEqual(expect.objectContaining({
        category: "membership_governance_audit", entityId: "audit:legacy-audit", revision: 0,
      }));
    } finally {
      database.close();
    }
  });
});
