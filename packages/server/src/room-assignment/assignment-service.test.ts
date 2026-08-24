import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import {
  executeRoomAssignmentCommandInTransaction,
  listRoomAssignmentsInTransaction,
  readAssignmentRevisionGateInTransaction,
  RoomAssignmentServiceError,
} from "./assignment-service.js";

const now = Date.parse("2026-08-24T12:00:00.000Z");

function context(actorId: string): AuthenticatedSessionContext {
  return {
    sessionId: `access-${actorId}`,
    sessionFamilyId: `family-${actorId}`,
    principal: { accountId: `account-${actorId}`, actorId },
  };
}

function createRequest(requestId = "create-1", profileId = "profile-1") {
  return {
    kind: "create" as const,
    requestId,
    roomId: "room-1",
    expectedRoomRevision: 1,
    profileId,
    participation: "active" as const,
    roomResponsibility: "Review delivery risk",
    capabilitySubset: ["room.project.read", "room.respond"],
    toolSubset: ["repository.git-status", "room-memory.read"],
  };
}

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE actors (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      display_name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE session_families (
      family_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES actors(id),
      refresh_expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    ) STRICT;
    CREATE TABLE sessions (
      family_id TEXT NOT NULL REFERENCES session_families(family_id),
      account_id TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES actors(id),
      access_token_hash TEXT PRIMARY KEY,
      access_expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    ) STRICT;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL REFERENCES actors(id),
      governance_revision INTEGER NOT NULL CHECK (governance_revision >= 0),
      archive_generation INTEGER NOT NULL CHECK (archive_generation >= 0)
    ) STRICT;
    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      role TEXT,
      access_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, actor_id)
    ) STRICT;
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id),
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
      capability_ceiling_json TEXT NOT NULL,
      tool_ceiling_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE room_agent_assignments (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
      agent_actor_id TEXT NOT NULL REFERENCES actors(id),
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN ('current', 'removed')),
      participation TEXT NOT NULL CHECK (participation IN ('active', 'on-mention')),
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      capability_subset_json TEXT NOT NULL,
      tool_subset_json TEXT NOT NULL,
      room_responsibility TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      removed_at TEXT,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('room_command'))
    ) STRICT;
    CREATE UNIQUE INDEX one_current_assignment
      ON room_agent_assignments(room_id, agent_actor_id) WHERE status = 'current';
    CREATE TABLE room_agent_assignment_revisions (
      assignment_id TEXT NOT NULL REFERENCES room_agent_assignments(id),
      revision INTEGER NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
      agent_actor_id TEXT NOT NULL REFERENCES actors(id),
      room_responsibility TEXT NOT NULL,
      status TEXT NOT NULL,
      participation TEXT NOT NULL,
      paused INTEGER NOT NULL,
      capability_subset_json TEXT NOT NULL,
      tool_subset_json TEXT NOT NULL,
      changed_by_human_actor_id TEXT NOT NULL REFERENCES actors(id),
      changed_at TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create','update','pause','resume','remove')),
      PRIMARY KEY (assignment_id, revision)
    ) STRICT;
    CREATE TRIGGER assignment_history_update
      BEFORE UPDATE ON room_agent_assignment_revisions
      BEGIN SELECT RAISE(ABORT, 'history immutable'); END;
    CREATE TRIGGER assignment_history_delete
      BEFORE DELETE ON room_agent_assignment_revisions
      BEGIN SELECT RAISE(ABORT, 'history immutable'); END;
    CREATE TABLE room_audit (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type = 'room.agent.configured'),
      room_id TEXT NOT NULL REFERENCES rooms(id),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      result TEXT NOT NULL CHECK (result = 'configured'),
      timestamp TEXT NOT NULL,
      details_json TEXT NOT NULL CHECK (json_valid(details_json))
    ) STRICT;
    CREATE TABLE idempotency_records (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      status_code INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    ) STRICT;
    CREATE TABLE agent_executions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      agent_id TEXT NOT NULL REFERENCES actors(id),
      status TEXT NOT NULL
    ) STRICT;
  `);
  for (const [id, kind] of [
    ["owner", "human"], ["admin", "human"], ["member", "human"],
    ["tenant-only", "human"], ["agent-1", "agent"], ["agent-2", "agent"],
  ] as const) {
    database.prepare("INSERT INTO actors VALUES (?, ?, ?)").run(id, kind, id);
    if (kind === "human") {
      database.prepare("INSERT INTO session_families VALUES (?, ?, ?, ?, NULL)").run(
        `family-${id}`, `account-${id}`, id, now + 100_000,
      );
      database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL)").run(
        `family-${id}`, `account-${id}`, id, `access-${id}`, now + 50_000,
      );
    }
  }
  database.prepare("INSERT INTO rooms VALUES (?, ?, 'active', ?, ?, 1, 0)").run(
    "room-1", "Secret project", "2026-08-24T00:00:00.000Z", "owner",
  );
  database.prepare("INSERT INTO rooms VALUES (?, ?, 'active', ?, ?, 1, 0)").run(
    "room-2", "Other secret", "2026-08-24T00:00:00.000Z", "tenant-only",
  );
  for (const [roomId, actorId, kind, role, accessRevision] of [
    ["room-1", "owner", "human", "owner", 3],
    ["room-1", "admin", "human", "admin", 3],
    ["room-1", "member", "human", "member", 3],
    ["room-1", "agent-1", "agent", null, 7],
    ["room-1", "agent-2", "agent", null, 9],
    ["room-2", "tenant-only", "human", "owner", 1],
  ] as const) {
    database.prepare("INSERT INTO room_memberships VALUES (?, ?, ?, ?, ?)").run(
      roomId, actorId, kind, role, accessRevision,
    );
  }
  database.prepare("INSERT INTO agent_profiles VALUES (?, ?, 2, 'enabled', ?, ?)").run(
    "profile-1", "agent-1",
    JSON.stringify(["room.project.read", "room.respond"]),
    JSON.stringify(["repository.git-status", "room-memory.read"]),
  );
  database.prepare("INSERT INTO agent_profiles VALUES (?, ?, 4, 'disabled', ?, ?)").run(
    "profile-2", "agent-2", JSON.stringify(["room.respond"]),
    JSON.stringify(["room-memory.read"]),
  );
  return database;
}

function inTransaction<T>(database: DatabaseSync, roomId: string, operation: (transaction: ReturnType<
  typeof mintDatabaseAuthorityTransactionView>) => T): T {
  database.exec("BEGIN IMMEDIATE");
  const transaction = mintDatabaseAuthorityTransactionView(database, roomId, `tx-${Math.random()}`);
  try {
    const result = operation(transaction);
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    releaseDatabaseAuthorityTransactionView(transaction);
  }
}

function errorCode(operation: () => unknown): string | undefined {
  try {
    operation();
  } catch (error: unknown) {
    return error instanceof RoomAssignmentServiceError ? error.code : undefined;
  }
  return undefined;
}

describe("SQLite Room Assignment repository and service", () => {
  let database: DatabaseSync;

  beforeEach(() => { database = fixture(); });
  afterEach(() => { database.close(); });

  it("creates a stable-actor Assignment with one receipt, audit, and immutable history row", () => {
    const result = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now));
    expect(result).toMatchObject({ changed: true, roomRevision: 2 });
    expect(result.assignment).toMatchObject({
      roomId: "room-1", profileId: "profile-1", actorId: "agent-1",
      revision: 1, status: "current", participation: "active", paused: false,
    });
    expect(result.assignment.assignmentId).not.toContain("agent-1");
    expect(database.prepare("SELECT governance_revision AS revision FROM rooms WHERE id='room-1'").get())
      .toEqual({ revision: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_agent_assignment_revisions").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_audit").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 1 });
    expect(() => database.exec("DELETE FROM room_agent_assignment_revisions"))
      .toThrow("history immutable");
  });

  it("replays the exact result after authority evolves and rejects changed payload reuse", () => {
    const request = createRequest();
    const first = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), request, now));
    database.exec("UPDATE rooms SET governance_revision = 8 WHERE id = 'room-1'");
    const replay = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), request, now + 1));
    expect(replay).toEqual(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_audit").get()).toEqual({ count: 1 });
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        ...request, roomResponsibility: "Changed payload",
      }, now + 2)))).toBe("idempotency_conflict");
  });

  it("requires a current Human session and current Room owner/admin role", () => {
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("member"), createRequest(), now))))
      .toBe("forbidden");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(
        transaction, context("tenant-only"), createRequest(), now,
      )))).toBe("forbidden");
    database.exec("UPDATE sessions SET revoked_at = 1 WHERE actor_id = 'owner'");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now))))
      .toBe("unauthenticated");
  });

  it("allows an admin but enforces Profile ceilings and Room/Assignment CAS", () => {
    const created = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(
        transaction, context("admin"), createRequest("admin-create"), now,
      ));
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("admin"), {
        kind: "update", requestId: "overflow", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 2, expectedAssignmentRevision: 1,
        participation: "active", roomResponsibility: "Escalated",
        capabilitySubset: ["room.conversation.read"], toolSubset: [],
      }, now + 1)))).toBe("conflict");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("admin"), {
        kind: "pause", requestId: "stale", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 1, expectedAssignmentRevision: 1,
      }, now + 2)))).toBe("conflict");
    expect(database.prepare("SELECT revision FROM room_agent_assignments").get())
      .toEqual({ revision: 1 });
  });

  it("fails closed when stable Profile and Agent actor identity no longer bind", () => {
    database.exec("UPDATE agent_profiles SET actor_id='owner' WHERE id='profile-1'");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now))))
      .toBe("storage_unavailable");
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_agent_assignments").get())
      .toEqual({ count: 0 });
  });

  it("appends pause/resume/remove history and never deletes the stable Assignment", () => {
    const created = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now));
    const pause = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "pause", requestId: "pause", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 2, expectedAssignmentRevision: 1,
      }, now + 1));
    const resume = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "resume", requestId: "resume", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 3, expectedAssignmentRevision: pause.assignment.revision,
      }, now + 2));
    const removed = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "remove", requestId: "remove", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 4, expectedAssignmentRevision: resume.assignment.revision,
      }, now + 3));
    expect(removed.assignment).toMatchObject({ status: "removed", paused: true, revision: 4 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_agent_assignments").get())
      .toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT operation FROM room_agent_assignment_revisions ORDER BY revision",
    ).all()).toEqual([
      { operation: "create" }, { operation: "pause" },
      { operation: "resume" }, { operation: "remove" },
    ]);
  });

  it("allows only strict security reductions in an archived Room", () => {
    const created = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now));
    database.exec("UPDATE rooms SET status='archived', archive_generation=1 WHERE id='room-1'");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "resume", requestId: "archived-resume", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 2, expectedAssignmentRevision: 1,
      }, now + 1)))).toBe("conflict");
    const reduced = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "update", requestId: "archived-reduce", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 2, expectedAssignmentRevision: 1,
        participation: "on-mention", roomResponsibility: "Review delivery risk",
        capabilitySubset: ["room.respond"], toolSubset: ["room-memory.read"],
      }, now + 2));
    expect(reduced.assignment).toMatchObject({
      participation: "on-mention", capabilitySubset: ["room.respond"],
    });
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "update", requestId: "archived-expand", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 3, expectedAssignmentRevision: 2,
        participation: "active", roomResponsibility: "Review delivery risk",
        capabilitySubset: ["room.project.read", "room.respond"],
        toolSubset: ["repository.git-status", "room-memory.read"],
      }, now + 3)))).toBe("conflict");
    const paused = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "pause", requestId: "archived-pause", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 3, expectedAssignmentRevision: 2,
      }, now + 3));
    expect(paused.assignment.paused).toBe(true);
    const removed = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "remove", requestId: "archived-remove", roomId: "room-1",
        assignmentId: created.assignment.assignmentId,
        expectedRoomRevision: 4, expectedAssignmentRevision: 3,
      }, now + 4));
    expect(removed.assignment.status).toBe("removed");
  });

  it("returns only current same-Room assignments to current Human members", () => {
    inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now));
    expect(inTransaction(database, "room-1", (transaction) =>
      listRoomAssignmentsInTransaction(transaction, context("member"), "room-1", now)))
      .toHaveLength(1);
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      listRoomAssignmentsInTransaction(transaction, context("tenant-only"), "room-1", now))))
      .toBe("forbidden");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      listRoomAssignmentsInTransaction(transaction, context("tenant-only"), "room-2", now))))
      .toBe("forbidden");
  });

  it("derives availability only after exact Profile/Assignment/access revision recheck", () => {
    const created = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now));
    const gate = () => inTransaction(database, "room-1", (transaction) =>
      readAssignmentRevisionGateInTransaction(transaction, {
        roomId: "room-1", assignmentId: created.assignment.assignmentId,
        expectedProfileRevision: 2, expectedAssignmentRevision: 1,
        expectedAccessRevision: 7, providerReady: true,
      }));
    expect(gate()).toEqual({ current: true, availability: { eligible: true, availability: "ready" } });
    database.prepare("INSERT INTO agent_executions VALUES ('execution-1','room-1','agent-1','running')").run();
    expect(gate()).toEqual({ current: true, availability: { eligible: true, availability: "busy" } });
    database.exec("UPDATE room_agent_assignments SET paused=1 WHERE id=(SELECT id FROM room_agent_assignments)");
    expect(gate()).toEqual({ current: true, availability: { eligible: true, availability: "paused" } });
    database.exec("UPDATE room_agent_assignments SET paused=0");
    expect(inTransaction(database, "room-1", (transaction) =>
      readAssignmentRevisionGateInTransaction(transaction, {
        roomId: "room-1", assignmentId: created.assignment.assignmentId,
        expectedProfileRevision: 2, expectedAssignmentRevision: 1,
        expectedAccessRevision: 7, providerReady: false,
      }))).toEqual({
        current: true, availability: { eligible: true, availability: "noauth" },
      });
    expect(inTransaction(database, "room-1", (transaction) =>
      readAssignmentRevisionGateInTransaction(transaction, {
        roomId: "room-1", assignmentId: created.assignment.assignmentId,
        expectedProfileRevision: 2, expectedAssignmentRevision: 1,
        expectedAccessRevision: 8, providerReady: true,
      }))).toEqual({ current: false });
    database.exec("DELETE FROM room_memberships WHERE room_id='room-1' AND actor_id='agent-1'");
    expect(gate()).toEqual({ current: false });
  });

  it("rejects released or cross-Room Authority transaction capabilities", () => {
    const released = mintDatabaseAuthorityTransactionView(database, "room-1", "released");
    releaseDatabaseAuthorityTransactionView(released);
    expect(errorCode(() => executeRoomAssignmentCommandInTransaction(
      released, context("owner"), createRequest(), now,
    ))).toBe("storage_unavailable");
    const wrongRoom = mintDatabaseAuthorityTransactionView(database, "room-2", "wrong-room");
    try {
      expect(errorCode(() => executeRoomAssignmentCommandInTransaction(
        wrongRoom, context("owner"), createRequest(), now,
      ))).toBe("invalid_request");
    } finally {
      releaseDatabaseAuthorityTransactionView(wrongRoom);
    }
  });

  it("relies on the caller's Authority transaction for full rollback", () => {
    database.exec(`CREATE TRIGGER fail_assignment_audit BEFORE INSERT ON room_audit
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now))))
      .toBe("storage_unavailable");
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_agent_assignments").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_agent_assignment_revisions").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT governance_revision AS revision FROM rooms WHERE id='room-1'").get())
      .toEqual({ revision: 1 });
  });
});
