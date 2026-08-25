import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { submitHumanMessageDatabaseCommand } from
  "../persistence/authority-database-handler.js";
import { useAuthorityTransactionDatabase } from
  "../persistence/authority-transaction-database.js";
import {
  HumanRequestMessageParticipantError,
  type HumanRequestMessageBinding,
  type HumanRequestMessageTransactionParticipant,
} from "./message-human-request-participant.js";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
const accessToken = Buffer.alloc(32, 41).toString("base64url");
const refreshToken = Buffer.alloc(32, 42).toString("base64url");
const familyToken = Buffer.alloc(32, 43).toString("base64url");
const now = Date.parse("2026-08-25T03:04:05.006Z");

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "dao-message-request-participant-"));
  directories.push(directory);
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  databases.push(database);
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json, readiness)
    VALUES
      ('human-requester', 'human', 'Requester', '[]', 'ready'),
      ('human-target', 'human', 'Target', '[]', 'ready'),
      ('human-nonmember', 'human', 'Nonmember', '[]', 'ready');
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-request', 'Request Room', 'active', '2026-08-25T00:00:00.000Z');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES
      ('identity', 'human-requester', 0, 1),
      ('identity', 'human-target', 0, 1),
      ('identity', 'human-nonmember', 0, 1),
      ('room', 'room-request', 0, 1);
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, joined_at, configured_at,
      access_revision
    ) VALUES
      ('room-request', 'human-requester', 'human', 'member', NULL,
       '2026-08-25T00:00:00.000Z', NULL, 1),
      ('room-request', 'human-target', 'human', 'member', NULL,
       '2026-08-25T00:00:00.000Z', NULL, 1);
    UPDATE rooms SET owner_actor_id = 'human-requester', governance_revision = 1
    WHERE id = 'room-request';
    CREATE TABLE request_participant_proof (
      request_intent_id TEXT PRIMARY KEY, source_message_id TEXT NOT NULL,
      target_actor_id TEXT NOT NULL
    ) STRICT;
  `);
  database.prepare(
    `INSERT INTO session_families (
       family_id, public_id, account_id, actor_id, device_id, device_label,
       platform, created_at, refresh_expires_at, revoked_at
     ) VALUES (?, ?, 'account-requester', 'human-requester', 'test', 'Test',
               'unknown', ?, ?, NULL)`,
  ).run(familyToken, `test_${familyToken}`, now - 1_000, now + 7_200_000);
  database.prepare(
    `INSERT INTO sessions (
       family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
       access_expires_at, refresh_expires_at
     ) VALUES (?, 'account-requester', 'human-requester', ?, ?, ?, ?)`,
  ).run(familyToken, accessToken, refreshToken, now + 3_600_000, now + 7_200_000);
  return database;
}

const context = {
  kind: "human" as const,
  sessionId: accessToken,
  sessionFamilyId: familyToken,
  principal: { accountId: "account-requester", actorId: "human-requester" },
  requestId: "message-request",
  idempotencyKey: "message-request",
};

const message = {
  messageId: "message-request-1",
  roomId: "room-request",
  body: "@Target @Missing please review",
  mentionedTargets: [
    {
      id: "target-valid",
      kind: "human-request" as const,
      targetActorId: "human-target",
      range: { startUtf16: 0, endUtf16: 7 },
    },
    {
      id: "target-invalid",
      kind: "human-request" as const,
      targetActorId: "human-nonmember",
      range: { startUtf16: 8, endUtf16: 16 },
    },
  ],
  attachments: [],
};

function proofParticipant(
  bindings: HumanRequestMessageBinding[],
  fault = false,
): HumanRequestMessageTransactionParticipant {
  return Object.freeze({
    createPendingInTransaction(transaction, binding) {
      bindings.push(Object.freeze({ ...binding }));
      useAuthorityTransactionDatabase(transaction, (database) => {
        database.prepare(
          `INSERT INTO request_participant_proof (
             request_intent_id, source_message_id, target_actor_id
           ) VALUES (?, ?, ?)`,
        ).run(binding.requestIntentId, binding.sourceMessageId, binding.targetHumanActorId);
      });
      if (fault) {
        throw new HumanRequestMessageParticipantError(
          "storage_unavailable",
          "Injected Project Request fault",
        );
      }
      return Object.freeze({
        status: "created" as const,
        roomId: binding.roomId,
        requestIntentId: binding.requestIntentId,
        requestId: `request:${binding.requestIntentId}`,
        eventId: `event:${binding.requestIntentId}`,
        boundaryId: `boundary:${binding.requestIntentId}`,
        projectRevision: 1,
      });
    },
    cancelPendingForRecallInTransaction(_transaction, binding) {
      return Object.freeze({
        roomId: binding.roomId,
        sourceMessageId: binding.sourceMessageId,
        cancelledRequestIds: Object.freeze([]),
        eventIds: Object.freeze([]),
      });
    },
  });
}

describe("message authority Project Request participant adapter", () => {
  it("isolates invalid targets, passes no body/author spoof fields, and does not imply acceptance", () => {
    const database = fixture();
    const bindings: HumanRequestMessageBinding[] = [];
    const receipt = submitHumanMessageDatabaseCommand(database, {
      context,
      message,
      now,
      humanRequestParticipant: proofParticipant(bindings),
    });
    expect(receipt.targetOutcomes).toEqual([
      {
        targetId: "target-valid", targetActorId: "human-target", kind: "human-request",
        status: "request-created", requestIntentId: expect.stringMatching(/\S/),
      },
      {
        targetId: "target-invalid", targetActorId: "human-nonmember", kind: "human-request",
        status: "rejected", code: "target_not_member",
      },
    ]);
    expect(bindings).toHaveLength(1);
    expect(Reflect.ownKeys(bindings[0]!)).toEqual([
      "roomId", "projectId", "requestIntentId", "sourceMessageId", "sourceRevision",
      "requesterHumanActorId", "targetHumanActorId", "sourceTargetId", "occurredAt",
    ]);
    expect(JSON.stringify(bindings[0])).not.toContain(message.body);
    expect(database.prepare(
      "SELECT status FROM human_request_intents WHERE source_message_id = ?",
    ).all(message.messageId)).toEqual([{ status: "pending" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM request_participant_proof").get())
      .toEqual({ count: 1 });
  });

  it("replays the exact message receipt without re-entering or duplicating the participant", () => {
    const database = fixture();
    const bindings: HumanRequestMessageBinding[] = [];
    const participant = proofParticipant(bindings);
    const first = submitHumanMessageDatabaseCommand(database, {
      context, message, now, humanRequestParticipant: participant,
    });
    const replay = submitHumanMessageDatabaseCommand(database, {
      context: { ...context, requestId: "message-request-replay" },
      message,
      now: now + 1,
      humanRequestParticipant: participant,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(bindings).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM request_participant_proof").get())
      .toEqual({ count: 1 });
  });

  it("rolls message, intent, target outcome, event and participant writes back together", () => {
    const database = fixture();
    expect(() => submitHumanMessageDatabaseCommand(database, {
      context,
      message: { ...message, mentionedTargets: [message.mentionedTargets[0]!] },
      now,
      humanRequestParticipant: proofParticipant([], true),
    })).toThrowError(expect.objectContaining({ code: "dependency_unavailable" }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?")
      .get(message.messageId)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM human_request_intents")
      .get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM message_target_outcomes")
      .get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM request_participant_proof")
      .get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE stream_id = 'room-request'")
      .get()).toEqual({ count: 0 });
  });
});
