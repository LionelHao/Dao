import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { insertLegacyMessageAuthorityRecord } from
  "../persistence/message-authority-legacy-adapter.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  readOperationalMessageAuthorityEvent,
  readOperationalMessageRepairPage,
  readOperationalMessageRepairRecord,
  readOperationalTimelineMessage,
} from "./sqlite-operational-message-projection.js";

const directories: string[] = [];
const createdAt = "2026-08-19T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openAuthority(): Promise<DatabaseSync> {
  const directory = await mkdtemp(join(tmpdir(), "dao-message-projection-"));
  directories.push(directory);
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (
      id, kind, display_name, reachability, readiness, tool_permissions_json
    ) VALUES
      ('human-author', 'human', 'Author', 'online', NULL, '[]'),
      ('agent-legacy', 'agent', 'Legacy Agent', NULL, 'ready', '[]');
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-1', 'Room', 'active', '${createdAt}');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-1', 'human-author', 'human', 'member', NULL, '[]', '${createdAt}', NULL, 1),
      ('room-1', 'agent-legacy', 'agent', NULL, 'active', '[]', NULL, '${createdAt}', 1);
  `);
  return database;
}

function insertHuman(database: DatabaseSync, id: string, body: string): void {
  insertLegacyMessageAuthorityRecord(database, {
    id,
    roomId: "room-1",
    authorId: "human-author",
    authorKind: "human",
    body,
    sentAt: createdAt,
  });
}

describe("SQLite canonical operational message projection", () => {
  it("reads only the current Human revision and emits the same repair/event payload", async () => {
    const database = await openAuthority();
    insertHuman(database, "message-human", "initial raw body");
    database.prepare(
      `INSERT INTO message_revisions (
         message_id, revision, body, revised_at, revised_by_actor_id
       ) VALUES ('message-human', 2, '@Agent current body', ?, 'human-author')`,
    ).run("2026-08-19T08:05:00.000Z");
    database.prepare(
      `UPDATE message_envelopes
       SET current_revision = 2, revision_count = 2
       WHERE message_id = 'message-human'`,
    ).run();
    database.exec(`
      BEGIN IMMEDIATE;
      INSERT INTO message_mentions (
        message_id, room_id, target_id, target_kind, target_actor_id,
        range_start_utf16, range_end_utf16, target_order
      ) VALUES (
        'message-human', 'room-1', 'target-agent', 'agent-invocation',
        'agent-legacy', 0, 6, 0
      );
      INSERT INTO message_target_outcomes (
        message_id, room_id, target_id, target_actor_id, target_kind,
        status, request_intent_id, invocation_intent_id, rejection_code, created_at
      ) VALUES (
        'message-human', 'room-1', 'target-agent', 'agent-legacy', 'agent-invocation',
        'rejected', NULL, NULL, 'target_assignment_inactive', '${createdAt}'
      );
      COMMIT;
    `);

    const timeline = readOperationalTimelineMessage(database, "message-human");
    expect(timeline).toMatchObject({
      id: "message-human",
      lifecycle: "active",
      currentRevision: { revision: 2, body: "@Agent current body" },
      revisionCount: 2,
      mentionedTargets: [{
        id: "target-agent",
        kind: "agent-invocation",
        targetActorId: "agent-legacy",
        range: { startUtf16: 0, endUtf16: 6 },
      }],
      attachments: [],
      targetOutcomes: [{
        targetId: "target-agent",
        targetActorId: "agent-legacy",
        kind: "agent-invocation",
        status: "rejected",
        code: "target_assignment_inactive",
      }],
    });
    expect(JSON.stringify(timeline)).not.toContain("initial raw body");
    expect(readOperationalMessageRepairRecord(database, "message-human")).toEqual({
      kind: "timeline-message",
      value: timeline,
    });
    expect(readOperationalMessageRepairPage(database, {
      roomId: "room-1",
      afterMessageId: undefined,
      limit: 10,
    })).toEqual([{ kind: "timeline-message", value: timeline }]);
    expect(readOperationalMessageAuthorityEvent(database, {
      eventId: "event-message-human",
      streamKind: "room",
      streamId: "room-1",
      streamSeq: 1,
      roomId: "room-1",
      type: "room.message.revised",
      actorId: "human-author",
      occurredAt: "2026-08-19T08:05:00.000Z",
    }, "message-human").payload).toEqual(timeline);
    database.close();
  });

  it("projects recalled Human authority without selecting or exposing retained raw", async () => {
    const database = await openAuthority();
    insertHuman(database, "message-recalled", "RECALLED-RAW-SENTINEL");
    database.prepare(
      `INSERT INTO message_recall_fences (
         fence_id, room_id, source_message_id, source_revision, scope_kind,
         invocation_intent_id, execution_id, reason, created_at
       ) VALUES (
         'fence-recalled', 'room-1', 'message-recalled', 1, 'message',
         NULL, NULL, 'message_recalled', ?
       )`,
    ).run("2026-08-19T08:10:00.000Z");
    database.prepare(
      `UPDATE message_envelopes
       SET lifecycle = 'recalled', recalled_at = ?, recalled_by_actor_id = 'human-author'
       WHERE message_id = 'message-recalled'`,
    ).run("2026-08-19T08:10:00.000Z");

    const timeline = readOperationalTimelineMessage(database, "message-recalled");
    expect(timeline).toEqual({
      id: "message-recalled",
      roomId: "room-1",
      authorId: "human-author",
      authorKind: "human",
      createdAt,
      lifecycle: "recalled",
      recalledAt: "2026-08-19T08:10:00.000Z",
      revisionCount: 1,
    });
    expect(JSON.stringify(readOperationalMessageRepairRecord(
      database,
      "message-recalled",
    ))).not.toContain("RECALLED-RAW-SENTINEL");
    database.close();
  });

  it("keeps migrated Agent messages immutable with explicit legacy lineage markers", async () => {
    const database = await openAuthority();
    insertLegacyMessageAuthorityRecord(database, {
      id: "message-agent-legacy",
      roomId: "room-1",
      authorId: "agent-legacy",
      authorKind: "agent",
      body: "legacy final",
      sentAt: createdAt,
    });

    expect(readOperationalTimelineMessage(database, "message-agent-legacy")).toEqual({
      id: "message-agent-legacy",
      roomId: "room-1",
      authorId: "agent-legacy",
      authorKind: "agent",
      createdAt,
      lifecycle: "active",
      finalBody: "legacy final",
      sourceInvocationIntentId: "legacy:message-agent-legacy:invocation",
      sourceExecutionId: "legacy:message-agent-legacy:execution",
    });
    database.close();
  });

  it("fails closed when the authority aggregate is missing", async () => {
    const database = await openAuthority();
    expect(() => readOperationalTimelineMessage(database, "missing-message")).toThrow(
      "Operational message projection rejected: invalid_source",
    );
    database.close();
  });
});
