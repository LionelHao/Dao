import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeBallAuthorityOperation,
  executeHumanDatabaseCommand,
  executeRuntimeAuthorityOperation,
} from "../persistence/authority-database-handler.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";

const directories: string[] = [];
const accessToken = Buffer.alloc(32, 1).toString("base64url");
const refreshToken = Buffer.alloc(32, 2).toString("base64url");
const familyToken = Buffer.alloc(32, 3).toString("base64url");
const t0 = Date.parse("2026-08-17T00:00:00.000Z");

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openDatabase(): { readonly path: string; readonly database: DatabaseSync } {
  const directory = mkdtempSync(join(tmpdir(), "dao-ball-authority-"));
  directories.push(directory);
  const path = join(directory, "authority.sqlite");
  const database = new DatabaseSync(path);
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name)
    VALUES
      ('human-1', 'human', 'Human One'),
      ('human-2', 'human', 'Human Two'),
      ('agent-1', 'agent', 'Agent One');
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-1', 'Room', 'active', '2026-08-17T00:00:00.000Z');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES
      ('identity', 'human-1', 0, 1),
      ('identity', 'human-2', 0, 1),
      ('identity', 'agent-1', 0, 1),
      ('room', 'room-1', 0, 1);
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, joined_at, configured_at
    ) VALUES
      ('room-1', 'human-1', 'human', 'owner', NULL, '2026-08-17T00:00:00.000Z', NULL),
      ('room-1', 'human-2', 'human', 'member', NULL, '2026-08-17T00:00:00.000Z', NULL),
      ('room-1', 'agent-1', 'agent', NULL, 'active', NULL, '2026-08-17T00:00:00.000Z');
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES
      ('message-open', 'room-1', 'human-1', 'human', 'Explicit request', '2026-08-17T00:00:00.000Z'),
      ('message-task', 'room-1', 'human-1', 'human', 'Explicit task', '2026-08-17T00:00:00.000Z');
    INSERT INTO open_items (
      id, room_id, source_message_id, current_owner_actor_id, status, body,
      created_at, requester_actor_id, transfer_chain_json, origin_kind
    ) VALUES (
      'item-1', 'room-1', 'message-open', 'agent-1', 'awaiting', 'Answer',
      '2026-08-17T00:00:00.000Z', 'human-1', '[]', 'human_mention'
    );
    INSERT INTO light_tasks (
      id, room_id, source_message_id, title, claimant_actor_id,
      claimant_role_at_claim, verifier_role, criteria_json, status, created_at, claimed_at
    ) VALUES (
      'task-1', 'room-1', 'message-task', 'Ship', 'human-1',
      'owner', 'member', '[]', 'claimed', '2026-08-17T00:00:00.000Z',
      '2026-08-17T00:00:00.000Z'
    );
  `);
  database.prepare(
    `INSERT INTO session_families (
       family_id, public_id, account_id, actor_id, device_id, device_label,
       platform, created_at, refresh_expires_at, revoked_at
     ) VALUES (?, ?, 'account-1', 'human-1', 'test', 'Test', 'unknown', ?, ?, NULL)`,
  ).run(familyToken, `test_${familyToken}`, t0, t0 + 7_200_000);
  database.prepare(
    `INSERT INTO sessions (
       family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
       access_expires_at, refresh_expires_at
     ) VALUES (?, 'account-1', 'human-1', ?, ?, ?, ?)`,
  ).run(familyToken, accessToken, refreshToken, t0 + 3_600_000, t0 + 7_200_000);
  return { path, database };
}

const context = {
  sessionId: accessToken,
  sessionFamilyId: familyToken,
  principal: { accountId: "account-1", actorId: "human-1" },
} as const;
const policy = { openItemDeadlineMs: 60_000, lightTaskDeadlineMs: 60_000 } as const;

describe("real SQLite BallInCourt authority", () => {
  it("queries OpenItem, LightTask, and Blueprint facts while keeping unread independent", () => {
    const { database } = openDatabase();
    const result = executeBallAuthorityOperation(database, {
      type: "ball.query", context, roomId: "room-1", policy, now: t0 + 60_000,
      blueprintFacts: [{
        sourceKind: "blueprint-awaiting", sourceId: "T-100", roomId: "room-1",
        assigneeId: "human-2", reason: "awaiting authoritative assignee",
        since: "2026-08-10T00:00:00.000Z",
      }],
    });
    expect(result.kind).toBe("ball-query");
    if (result.kind !== "ball-query") throw new Error("unexpected result");
    expect(result.balls.map((ball) => [ball.sourceKind, ball.holderId])).toEqual([
      ["open-item", "agent-1"], ["light-task", "human-1"],
      ["blueprint-awaiting", "human-2"],
    ]);
    expect(result.needsAction).toHaveLength(1);
    expect(result.needsAction[0]?.overdue).toBe(true);
    expect(result.reminders).toHaveLength(1);
    database.close();
  });

  it("claims agent trigger and human reminder exactly once across restart", () => {
    const { path, database } = openDatabase();
    const beforeBoundary = executeBallAuthorityOperation(database, {
      type: "ball.scan-overdue", roomId: "room-1", policy, now: t0 + 59_999,
      blueprintFacts: [],
    });
    expect(beforeBoundary).toEqual({
      kind: "ball-overdue-scan", agentTriggers: [], reminders: [], ballSummaries: [],
    });
    const first = executeBallAuthorityOperation(database, {
      type: "ball.scan-overdue", roomId: "room-1", policy, now: t0 + 60_000,
      blueprintFacts: [],
    });
    expect(first.kind).toBe("ball-overdue-scan");
    if (first.kind !== "ball-overdue-scan") throw new Error("unexpected result");
    expect(first.agentTriggers).toHaveLength(1);
    expect(first.ballSummaries).toEqual([expect.objectContaining({
      agentId: "agent-1", sourceKind: "open-item", sourceId: "item-1",
    })]);
    expect(first.reminders).toEqual([expect.objectContaining({ recipientId: "human-1" })]);
    for (const [id, offset] of [["message-route-once", 61_000], ["message-route-again", 62_000]] as const) {
      executeHumanDatabaseCommand(database, {
        context: { ...context, kind: "human", requestId: id, idempotencyKey: id },
        command: { type: "message.send", roomId: "room-1", payload: {
          id, roomId: "room-1", body: "route probe", sentAt: new Date(t0 + offset).toISOString(),
        } },
        now: t0 + offset,
      });
      executeRuntimeAuthorityOperation(database, {
        type: "runtime.cancel-for-human-fence",
        sourceHumanMessageId: id,
        now: t0 + offset + 1,
      });
      executeRuntimeAuthorityOperation(database, {
        type: "runtime.create-route-after-human-fence",
        sourceHumanMessageId: id,
        now: t0 + offset + 2,
      });
    }
    expect(database.prepare(
      `SELECT snapshot.has_ball AS hasBall
       FROM route_job_agents AS snapshot
       JOIN route_jobs AS job ON job.id = snapshot.route_job_id
       WHERE snapshot.agent_id = 'agent-1' ORDER BY job.created_at`,
    ).all()).toEqual([{ hasBall: 1 }, { hasBall: 0 }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ball_boundary_claims").get())
      .toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.ball.overdue'").get())
      .toEqual({ count: 1 });
    database.close();

    const restarted = new DatabaseSync(path);
    migrateAuthorityDatabase(restarted);
    const replay = executeBallAuthorityOperation(restarted, {
      type: "ball.scan-overdue", roomId: "room-1", policy, now: t0 + 120_000,
      blueprintFacts: [],
    });
    expect(replay).toEqual({
      kind: "ball-overdue-scan", agentTriggers: [], reminders: [], ballSummaries: [],
    });
    expect(restarted.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.ball.overdue'").get())
      .toEqual({ count: 1 });
    restarted.close();
  });

  it("atomically changes holder on transfer and refuses a removed principal", () => {
    const { database } = openDatabase();
    database.prepare(
      `UPDATE open_items
       SET current_owner_actor_id = 'human-2', status = 'transferred', transfer_chain_json = ?
       WHERE id = 'item-1'`,
    ).run(JSON.stringify([{
      fromId: "agent-1", toId: "human-2", reason: "handoff",
      transferredAt: "2026-08-17T00:00:30.000Z",
    }]));
    database.exec(`
      UPDATE light_tasks
      SET verifier_actor_id = 'human-2', status = 'delivered',
          delivered_at = '2026-08-17T00:00:30.000Z'
      WHERE id = 'task-1'
    `);
    const transferred = executeBallAuthorityOperation(database, {
      type: "ball.query", context, roomId: "room-1", policy, now: t0 + 30_000,
      blueprintFacts: [],
    });
    if (transferred.kind !== "ball-query") throw new Error("unexpected result");
    expect(transferred.balls.filter((ball) => ball.sourceId === "item-1"))
      .toEqual([expect.objectContaining({ holderId: "human-2" })]);
    expect(transferred.balls.filter((ball) => ball.sourceId === "task-1"))
      .toEqual([expect.objectContaining({ holderId: "human-2", reason: expect.stringContaining("verifier") })]);
    database.prepare("DELETE FROM room_memberships WHERE room_id = 'room-1' AND actor_id = 'human-1'").run();
    expect(() => executeBallAuthorityOperation(database, {
      type: "ball.query", context, roomId: "room-1", policy, now: t0 + 30_000,
      blueprintFacts: [],
    })).toThrow(/room access/i);
    expect(database.prepare("SELECT claimant_actor_id AS claimant FROM light_tasks WHERE id = 'task-1'").get())
      .toEqual({ claimant: "human-1" });
    database.close();
  });
});
