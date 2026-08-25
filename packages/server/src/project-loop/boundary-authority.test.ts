import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  archiveProjectLoopBoundariesInTransaction,
  createProjectReminderDatabaseAuthorityPort,
  reopenProjectLoopBoundariesInTransaction,
} from "./boundary-authority.js";
import { scanCurrentProjectReminderBuckets } from "./project-boundary-runtime-service.js";

const now = "2026-08-25T08:00:00.000Z";

function fixture(holderKind: "human" | "agent" = "human") {
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
      boundary_id TEXT PRIMARY KEY, room_id TEXT, project_id TEXT, source_kind TEXT, source_id TEXT,
      source_revision INTEGER, lifecycle_generation INTEGER, holder_kind TEXT, holder_actor_id TEXT, reason TEXT,
      since TEXT, due_at TEXT, status TEXT, released_at TEXT
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
    CREATE TABLE project_room_states (room_id TEXT PRIMARY KEY, revision INTEGER);
    CREATE TABLE project_archive_suspensions (
      room_id TEXT, project_id TEXT, archive_generation INTEGER,
      suspended_project_revision INTEGER, suspended_at TEXT, status TEXT, resumed_at TEXT,
      PRIMARY KEY(room_id,archive_generation)
    );
    CREATE TABLE streams (
      stream_kind TEXT, stream_id TEXT, head_seq INTEGER, PRIMARY KEY(stream_kind,stream_id)
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, stream_kind TEXT, stream_id TEXT, stream_seq INTEGER,
      room_id TEXT, actor_id TEXT, event_type TEXT, occurred_at TEXT, payload_json TEXT
    );
    CREATE TABLE outbox_deliveries (
      id TEXT PRIMARY KEY, event_id TEXT, target_kind TEXT, target_id TEXT, stream_seq INTEGER,
      status TEXT, attempts INTEGER, available_at TEXT, delivered_at TEXT, last_error TEXT
    );
    INSERT INTO rooms VALUES ('room-1','active',4);
    INSERT INTO project_room_states VALUES ('room-1',7);
    INSERT INTO room_memberships VALUES ('room-1','holder-1','${holderKind}','active');
    INSERT INTO project_next_actions VALUES ('action-1','room-1',3,'accepted');
    INSERT INTO project_ball_boundaries VALUES (
      'boundary-parent','room-1','room-1','next_action','action-1',3,4,'${holderKind}','holder-1',
      'due','2026-08-24T08:00:00.000Z','${now}','active',NULL
    );
    INSERT INTO project_ball_boundaries VALUES (
      'boundary-1','room-1','room-1','due','boundary-parent',3,4,'${holderKind}','holder-1',
      'due','2026-08-24T08:00:00.000Z','${now}','active',NULL
    );
    INSERT INTO streams VALUES ('identity','holder-1',0);
  `);
  if (holderKind === "agent") {
    database.exec(`
      INSERT INTO agent_profiles VALUES
        ('holder-1','enabled','["room.project.read","room.respond"]');
      INSERT INTO room_agent_assignments VALUES
        ('room-1','holder-1','current','active',0,'["room.project.read","room.respond"]')
    `);
  }
  return database;
}

describe("FT-09 database reminder authority", () => {
  it("does not let more than 256 paused Agent candidates starve a later Human reminder", async () => {
    const database = fixture();
    try {
      const membership = database.prepare("INSERT INTO room_memberships VALUES ('room-1', ?, 'agent', 'active')");
      const profile = database.prepare(
        `INSERT INTO agent_profiles VALUES
         (?, 'enabled', '["room.project.read","room.respond"]')`,
      );
      const assignment = database.prepare(
        `INSERT INTO room_agent_assignments VALUES
         ('room-1', ?, 'current', 'active', 1, '["room.project.read","room.respond"]')`,
      );
      const action = database.prepare(
        "INSERT INTO project_next_actions VALUES (?, 'room-1', 1, 'accepted')",
      );
      const boundary = database.prepare(
        `INSERT INTO project_ball_boundaries VALUES
         (?, 'room-1', 'room-1', ?, ?, 1, 4, 'agent', ?, 'due',
          '2026-08-23T08:00:00.000Z', ?, 'active', NULL)`,
      );
      for (let index = 0; index < 300; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const actorId = `agent-paused-${suffix}`;
        const actionId = `action-paused-${suffix}`;
        const parentId = `a-parent-paused-${suffix}`;
        membership.run(actorId); profile.run(actorId); assignment.run(actorId); action.run(actionId);
        boundary.run(parentId, "next_action", actionId, actorId, now);
        boundary.run(`a-due-paused-${suffix}`, "due", parentId, actorId, now);
      }
      const authority = createProjectReminderDatabaseAuthorityPort(database, {
        writeAgentInvocationIntentInTransaction: vi.fn(),
      });
      await expect(authority.listEligibleBoundaries({ now, limit: 1 })).resolves.toEqual([
        expect.objectContaining({ boundaryId: "boundary-1", holder: { kind: "human", actorId: "holder-1" } }),
      ]);
    } finally { database.close(); }
  });

  it("globally scans, atomically writes a Human outbox, and deduplicates recovery", async () => {
    const database = fixture();
    try {
      const authority = createProjectReminderDatabaseAuthorityPort(database, {
        writeAgentInvocationIntentInTransaction() {
          throw new Error("Human reminder must not create Agent work");
        },
      });
      await expect(scanCurrentProjectReminderBuckets({ authority, now, limit: 10 }))
        .resolves.toMatchObject({ scannedCount: 1, claimedCount: 1 });
      await expect(scanCurrentProjectReminderBuckets({ authority, now, limit: 10 }))
        .resolves.toMatchObject({ scannedCount: 0, claimedCount: 0, duplicateCount: 0 });
      expect(database.prepare(
        `SELECT event.event_type AS type, delivery.target_kind AS targetKind,
                delivery.target_id AS targetId
         FROM events AS event JOIN outbox_deliveries AS delivery ON delivery.event_id = event.event_id`,
      ).get()).toEqual({ type: "project.reminder.due", targetKind: "principal",
        targetId: "holder-1" });
    } finally { database.close(); }
  });

  it("rechecks lifecycle, assignment and source revision and creates zero Agent work when stale", async () => {
    const database = fixture("agent");
    const writeIntent = vi.fn();
    try {
      const authority = createProjectReminderDatabaseAuthorityPort(database, {
        writeAgentInvocationIntentInTransaction: writeIntent,
      });
      database.prepare("UPDATE project_next_actions SET revision = 4 WHERE id = 'action-1'").run();
      await expect(authority.listEligibleBoundaries({ now, limit: 10 })).resolves.toEqual([]);
      expect(writeIntent).not.toHaveBeenCalled();
      expect(database.prepare("SELECT COUNT(*) AS count FROM project_due_reminder_claims").get())
        .toEqual({ count: 0 });
      database.prepare("UPDATE project_next_actions SET revision = 3 WHERE id = 'action-1'").run();
      database.prepare("UPDATE room_agent_assignments SET paused = 1").run();
      await expect(authority.listEligibleBoundaries({ now, limit: 10 })).resolves.toEqual([]);
      expect(writeIntent).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it("creates one durable FT-08 Agent intent and recovery scan creates zero additional work", async () => {
    const database = fixture("agent");
    database.exec("CREATE TABLE ft08_intents (id TEXT PRIMARY KEY, boundary_id TEXT, created_at TEXT)");
    const writeIntent = vi.fn((db: DatabaseSync, input: { intentId: string;
      boundaryId: string; createdAt: string }) => {
      db.prepare("INSERT INTO ft08_intents VALUES (?, ?, ?)")
        .run(input.intentId, input.boundaryId, input.createdAt);
    });
    try {
      const authority = createProjectReminderDatabaseAuthorityPort(database, {
        writeAgentInvocationIntentInTransaction: writeIntent,
      });
      await expect(scanCurrentProjectReminderBuckets({ authority, now, limit: 10 }))
        .resolves.toMatchObject({ claimedCount: 1, duplicateCount: 0 });
      await expect(scanCurrentProjectReminderBuckets({ authority, now, limit: 10 }))
        .resolves.toMatchObject({ scannedCount: 0, claimedCount: 0, duplicateCount: 0 });
      expect(writeIntent).toHaveBeenCalledTimes(1);
      expect(database.prepare("SELECT COUNT(*) AS count FROM ft08_intents").get())
        .toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it("rolls back the claim when the FT-08 durable intent writer fails", async () => {
    const database = fixture("agent");
    try {
      const authority = createProjectReminderDatabaseAuthorityPort(database, {
        writeAgentInvocationIntentInTransaction() { throw new Error("intent fault"); },
      });
      await expect(scanCurrentProjectReminderBuckets({ authority, now, limit: 10 }))
        .rejects.toThrow("intent fault");
      expect(database.prepare("SELECT COUNT(*) AS count FROM project_due_reminder_claims").get())
        .toEqual({ count: 0 });
    } finally { database.close(); }
  });
});

describe("FT-09 database lifecycle participant", () => {
  it("supersedes old generation, preserves remaining duration, and reopens without burst", async () => {
    const database = fixture();
    try {
      database.prepare("DELETE FROM project_ball_boundaries WHERE source_kind = 'due'").run();
      database.prepare("UPDATE project_ball_boundaries SET due_at = ?")
        .run("2026-08-27T08:00:00.000Z");
      database.prepare("UPDATE rooms SET status = 'archived', archive_generation = 5").run();
      expect(archiveProjectLoopBoundariesInTransaction(database, {
        roomId: "room-1", archiveGeneration: 5, previousLifecycleGeneration: 4, occurredAt: now,
      })).toMatchObject({ lifecycleGeneration: 5, suspendedBoundaryCount: 1 });
      database.prepare("UPDATE rooms SET status = 'active'").run();
      const reopenedAt = "2026-09-25T08:00:00.000Z";
      expect(reopenProjectLoopBoundariesInTransaction(database, {
        roomId: "room-1", archiveGeneration: 5, previousLifecycleGeneration: 5,
        occurredAt: reopenedAt,
      })).toMatchObject({ lifecycleGeneration: 5, replacementBoundaryCount: 1 });
      expect(database.prepare(
        `SELECT lifecycle_generation AS generation, status, due_at AS dueAt
         FROM project_ball_boundaries ORDER BY lifecycle_generation`,
      ).all()).toEqual([
        { generation: 4, status: "superseded", dueAt: "2026-08-27T08:00:00.000Z" },
        { generation: 5, status: "active", dueAt: "2026-09-27T08:00:00.000Z" },
      ]);
      const authority = createProjectReminderDatabaseAuthorityPort(database, {
        writeAgentInvocationIntentInTransaction: vi.fn(),
      });
      await expect(authority.listEligibleBoundaries({ now: reopenedAt, limit: 10 }))
        .resolves.toEqual([]);
    } finally { database.close(); }
  });

  it("does not revive a responsibility that became terminal while archived", () => {
    const database = fixture();
    try {
      database.prepare("DELETE FROM project_ball_boundaries WHERE source_kind = 'due'").run();
      database.prepare("UPDATE rooms SET status = 'archived', archive_generation = 5").run();
      archiveProjectLoopBoundariesInTransaction(database, {
        roomId: "room-1", archiveGeneration: 5, previousLifecycleGeneration: 4, occurredAt: now,
      });
      database.prepare("UPDATE project_next_actions SET status = 'done'").run();
      database.prepare("UPDATE rooms SET status = 'active'").run();
      expect(reopenProjectLoopBoundariesInTransaction(database, {
        roomId: "room-1", archiveGeneration: 5, previousLifecycleGeneration: 5,
        occurredAt: "2026-09-25T08:00:00.000Z",
      })).toMatchObject({ resumedBoundaryCount: 0, replacementBoundaryCount: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM project_ball_boundaries WHERE status = 'active'",
      ).get()).toEqual({ count: 0 });
    } finally { database.close(); }
  });
});
