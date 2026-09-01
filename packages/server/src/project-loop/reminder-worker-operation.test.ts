import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createProjectReminderWorkerOperation,
  executeProjectReminderWorkerOperation,
} from "./reminder-worker-operation.js";

const now = "2026-08-25T08:00:00.000Z";

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE rooms (id TEXT PRIMARY KEY, status TEXT, archive_generation INTEGER);
    CREATE TABLE room_memberships (room_id TEXT, actor_id TEXT, kind TEXT, participation TEXT);
    CREATE TABLE agent_profiles (actor_id TEXT, status TEXT, capability_ceiling_json TEXT);
    CREATE TABLE room_agent_assignments (
      room_id TEXT, agent_actor_id TEXT, status TEXT, participation TEXT, paused INTEGER,
      capability_subset_json TEXT
    );
    CREATE TABLE project_next_actions (id TEXT, room_id TEXT, revision INTEGER, status TEXT);
    CREATE TABLE project_requests (id TEXT, room_id TEXT, revision INTEGER, status TEXT);
    CREATE TABLE project_obstacles (id TEXT, room_id TEXT, revision INTEGER, kind TEXT, status TEXT);
    CREATE TABLE project_ball_boundaries (
      boundary_id TEXT PRIMARY KEY, room_id TEXT, project_id TEXT, source_kind TEXT,
      source_id TEXT, source_revision INTEGER, lifecycle_generation INTEGER,
      holder_kind TEXT, holder_actor_id TEXT, reason TEXT, since TEXT, due_at TEXT,
      status TEXT, released_at TEXT
    );
    CREATE TABLE project_due_reminder_claims (
      claim_id TEXT PRIMARY KEY, room_id TEXT, boundary_id TEXT, source_revision INTEGER,
      reminder_kind TEXT, reminder_ordinal INTEGER, boundary_at TEXT, holder_kind TEXT,
      holder_actor_id TEXT, recipient_actor_id TEXT, status TEXT, claimed_at TEXT,
      dispatched_at TEXT,
      UNIQUE(room_id,boundary_id,reminder_kind,reminder_ordinal,recipient_actor_id)
    );
    CREATE TABLE project_boundary_agent_invocation_intents (
      intent_id TEXT PRIMARY KEY, boundary_id TEXT, source_revision INTEGER,
      lifecycle_generation INTEGER, target_agent_actor_id TEXT
    );
    CREATE TABLE streams (
      stream_kind TEXT, stream_id TEXT, head_seq INTEGER, PRIMARY KEY(stream_kind,stream_id)
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, stream_kind TEXT, stream_id TEXT, stream_seq INTEGER,
      room_id TEXT, authority_kind TEXT, actor_id TEXT, event_type TEXT,
      occurred_at TEXT, payload_json TEXT
    );
    CREATE TABLE outbox_deliveries (
      id TEXT PRIMARY KEY, event_id TEXT, target_kind TEXT, target_id TEXT, stream_seq INTEGER,
      status TEXT, attempts INTEGER, available_at TEXT, delivered_at TEXT, last_error TEXT
    );
    CREATE TABLE notifications (
      notification_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
      recipient_actor_id TEXT NOT NULL, notification_kind TEXT NOT NULL,
      source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
      source_boundary_id TEXT NOT NULL, source_ordinal INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE, safe_actor_id TEXT, created_at TEXT NOT NULL,
      read_at TEXT, read_revision INTEGER NOT NULL, handled_at TEXT,
      handled_revision INTEGER NOT NULL, revoked_at TEXT, revoke_reason TEXT,
      UNIQUE(recipient_actor_id, source_boundary_id, notification_kind, source_ordinal)
    );
    CREATE TABLE ft08_intents (id TEXT PRIMARY KEY, boundary_id TEXT, created_at TEXT);
    INSERT INTO rooms VALUES ('room-agent','active',3), ('room-human','active',1);
    INSERT INTO room_memberships VALUES
      ('room-agent','agent-1','agent','active'), ('room-human','human-1','human','active');
    INSERT INTO agent_profiles VALUES
      ('agent-1','enabled','["room.project.read","room.respond"]');
    INSERT INTO room_agent_assignments VALUES
      ('room-agent','agent-1','current','active',0,'["room.project.read","room.respond"]');
    INSERT INTO project_next_actions VALUES
      ('action-agent','room-agent',2,'accepted'), ('action-human','room-human',4,'accepted');
    INSERT INTO project_ball_boundaries VALUES
      ('parent-agent','room-agent','room-agent','next_action','action-agent',2,3,
       'agent','agent-1','due','2026-08-24T08:00:00.000Z', '${now}', 'active',NULL),
      ('parent-human','room-human','room-human','next_action','action-human',4,1,
       'human','human-1','due','2026-08-24T08:00:00.000Z', '${now}', 'active',NULL);
    INSERT INTO project_ball_boundaries VALUES
      ('boundary-agent','room-agent','room-agent','due','parent-agent',2,3,
       'agent','agent-1','due','2026-08-24T08:00:00.000Z', '${now}', 'active',NULL),
      ('boundary-human','room-human','room-human','due','parent-human',4,1,
       'human','human-1','due','2026-08-24T08:00:00.000Z', '${now}', 'active',NULL);
    INSERT INTO streams VALUES ('identity','human-1',0);
  `);
  return database;
}

function writer(database: DatabaseSync, input: {
  intentId: string; boundaryId: string; createdAt: string;
}): void {
  database.prepare("INSERT INTO ft08_intents VALUES (?, ?, ?)")
    .run(input.intentId, input.boundaryId, input.createdAt);
}

describe("FT-09 global Project reminder Worker operation", () => {
  it("scans globally and returns durable Human and Agent claims", async () => {
    const database = fixture();
    try {
      const result = await executeProjectReminderWorkerOperation(database, { now, limit: 10 }, writer);
      expect(result).toMatchObject({ scannedCount: 2, claimedCount: 2,
        duplicateCount: 0, ignoredCount: 0 });
      expect(result.claims).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "claimed", roomId: "room-agent",
          boundaryId: "boundary-agent",
          dispatch: expect.objectContaining({ kind: "agent_invocation" }) }),
        expect.objectContaining({ status: "claimed", roomId: "room-human",
          boundaryId: "boundary-human",
          dispatch: expect.objectContaining({ kind: "human_notification" }) }),
      ]));
      expect(database.prepare("SELECT COUNT(*) AS count FROM ft08_intents").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get())
        .toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it("binds synchronously and restart scans return only duplicate claims", async () => {
    const database = fixture();
    const durableWriter = vi.fn(writer);
    try {
      const operation = createProjectReminderWorkerOperation(database, durableWriter);
      await operation.execute({ now, limit: 10 });
      await expect(operation.execute({ now, limit: 10 })).resolves.toMatchObject({
        scannedCount: 0, claimedCount: 0, duplicateCount: 0, ignoredCount: 0,
      });
      expect(durableWriter).toHaveBeenCalledTimes(1);
    } finally { database.close(); }
  });

  it("rejects invalid bounds before reading or writing", async () => {
    const database = fixture();
    const durableWriter = vi.fn(writer);
    try {
      const operation = createProjectReminderWorkerOperation(database, durableWriter);
      for (const limit of [0, 257, 1.5]) {
        await expect(operation.execute({ now, limit })).rejects.toThrow("invalid");
      }
      await expect(operation.execute({ now: "not-a-time", limit: 1 })).rejects.toThrow("invalid");
      expect(durableWriter).not.toHaveBeenCalled();
      expect(database.prepare("SELECT COUNT(*) AS count FROM project_due_reminder_claims").get())
        .toEqual({ count: 0 });
    } finally { database.close(); }
  });
});
