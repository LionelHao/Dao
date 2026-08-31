import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createRoomAssignmentRepairSegmentDescriptor } from
  "./room-assignment-repair-descriptor.js";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE rooms (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, global_responsibility TEXT NOT NULL,
      capability_ceiling_json TEXT NOT NULL, tool_ceiling_json TEXT NOT NULL,
      revision INTEGER NOT NULL, status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL, actor_id TEXT NOT NULL, kind TEXT NOT NULL,
      access_revision INTEGER NOT NULL, tool_permissions_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE room_agent_assignments (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      agent_actor_id TEXT NOT NULL, room_responsibility TEXT NOT NULL,
      participation TEXT NOT NULL, paused INTEGER NOT NULL,
      capability_subset_json TEXT NOT NULL, tool_subset_json TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_executions (agent_id TEXT NOT NULL, status TEXT NOT NULL) STRICT;
    INSERT INTO rooms VALUES ('room-1', 'active');
    INSERT INTO agent_profiles VALUES (
      'profile-1', 'Research', 'Research verified sources',
      '["room.conversation.read","room.respond"]', '["repository.git-status"]',
      2, 'enabled'
    );
    INSERT INTO room_memberships VALUES (
      'room-1', 'agent-1', 'agent', 4, '["repository.git-status"]'
    );
    INSERT INTO room_agent_assignments VALUES (
      'assignment-1', 'room-1', 'profile-1', 'agent-1', 'Review evidence',
      'on-mention', 0, '["room.conversation.read","room.respond"]',
      '["repository.git-status"]', 3, '2026-08-24T01:00:00.000Z', 'current'
    );
  `);
  return db;
}

describe("Room Agent Assignment repair descriptor", () => {
  it("maps the current assignment with server-private provider readiness and a stable key", () => {
    const db = database();
    try {
      const descriptor = createRoomAssignmentRepairSegmentDescriptor("ready");
      const rows = descriptor.readKeysetPage({
        database: db,
        roomId: "room-1",
        watermark: 7,
        afterKey: undefined,
        limit: 10,
      });
      expect(rows).toHaveLength(1);
      const record = descriptor.mapRow(rows[0]);
      expect(record).toMatchObject({
        kind: "room-agent-assignment",
        value: {
          assignmentId: "assignment-1",
          roomId: "room-1",
          profileRevision: 2,
          assignmentRevision: 3,
          accessRevision: 4,
          availability: "ready",
          effectiveTools: ["repository.git-status"],
        },
      });
      expect(descriptor.stableKey(record)).toBe("assignment-1");
      expect(descriptor.readKeysetPage({
        database: db,
        roomId: "room-1",
        watermark: 7,
        afterKey: "assignment-1",
        limit: 10,
      })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("fails closed on corrupt sets and derives noauth/paused/busy availability", () => {
    const db = database();
    try {
      const noauth = createRoomAssignmentRepairSegmentDescriptor("noauth");
      const input = { database: db, roomId: "room-1", watermark: 7,
        afterKey: undefined, limit: 1 } as const;
      expect(noauth.mapRow(noauth.readKeysetPage(input)[0])).toMatchObject({
        value: { availability: "noauth" },
      });

      db.prepare("UPDATE room_agent_assignments SET paused = 1").run();
      expect(noauth.mapRow(noauth.readKeysetPage(input)[0])).toMatchObject({
        value: { availability: "paused" },
      });

      db.prepare("UPDATE room_agent_assignments SET paused = 0").run();
      db.prepare("INSERT INTO agent_executions VALUES ('agent-1', 'running')").run();
      const ready = createRoomAssignmentRepairSegmentDescriptor("ready");
      expect(ready.mapRow(ready.readKeysetPage(input)[0])).toMatchObject({
        value: { availability: "busy" },
      });

      db.prepare(`UPDATE room_agent_assignments
        SET capability_subset_json = '["room.respond","room.conversation.read"]'`).run();
      expect(() => ready.mapRow(ready.readKeysetPage(input)[0])).toThrow(
        "Room Agent Assignment repair projection is invalid",
      );
    } finally {
      db.close();
    }
  });
});
