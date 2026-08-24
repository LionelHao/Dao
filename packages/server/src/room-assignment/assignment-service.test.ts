import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import {
  executeRoomAssignmentCommandInTransaction,
  getRoomAssignmentInTransaction,
  listRoomAssignmentsInTransaction,
  mintAssignmentProviderReadiness,
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
    idempotencyKey: `${requestId}-key`,
    roomId: "room-1",
    expectedRoomRevision: 1,
    profileId,
    participation: "active" as const,
    roomResponsibility: "Review delivery risk",
    capabilitySubset: ["room.project.read", "room.respond"],
    toolSubset: ["repository.git-status", "room-memory.read"],
  };
}

function fixture(filename = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(filename);
  if (filename !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
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
      archive_generation INTEGER NOT NULL CHECK (archive_generation >= 0),
      archived_at TEXT
    ) STRICT;
    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      role TEXT,
      participation TEXT,
      tool_permissions_json TEXT NOT NULL DEFAULT '[]',
      joined_at TEXT,
      configured_at TEXT,
      access_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, actor_id)
    ) STRICT;
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id),
      display_name TEXT NOT NULL,
      global_responsibility TEXT NOT NULL,
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
    CREATE TABLE room_assignment_archive_policies (
      room_id TEXT NOT NULL, archive_generation INTEGER NOT NULL,
      policy_version INTEGER NOT NULL, assignment_revision INTEGER NOT NULL,
      expansion_blocked INTEGER NOT NULL, reduced_at TEXT NOT NULL,
      PRIMARY KEY (room_id, archive_generation)
    ) STRICT;
    CREATE TABLE streams (
      stream_kind TEXT NOT NULL, stream_id TEXT NOT NULL, head_seq INTEGER NOT NULL,
      retained_from_seq INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (stream_kind, stream_id)
    ) STRICT;
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, stream_kind TEXT NOT NULL, stream_id TEXT NOT NULL,
      stream_seq INTEGER NOT NULL, room_id TEXT, actor_id TEXT NOT NULL,
      event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      UNIQUE (event_id, stream_seq)
    ) STRICT;
    CREATE TABLE outbox_deliveries (
      id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL, target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL, stream_seq INTEGER NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL, available_at TEXT NOT NULL, delivered_at TEXT,
      last_error TEXT, PRIMARY KEY (event_id, target_kind, target_id),
      FOREIGN KEY (event_id, stream_seq) REFERENCES events(event_id, stream_seq)
    ) STRICT;
    CREATE TRIGGER events_validate_insert BEFORE INSERT ON events
      WHEN NOT EXISTS (
        SELECT 1 FROM streams AS stream
        WHERE stream.stream_kind = NEW.stream_kind AND stream.stream_id = NEW.stream_id
          AND NEW.stream_seq = stream.head_seq AND NEW.stream_seq >= stream.retained_from_seq
          AND (NEW.stream_seq = stream.retained_from_seq OR EXISTS (
            SELECT 1 FROM events AS previous
            WHERE previous.stream_kind = NEW.stream_kind
              AND previous.stream_id = NEW.stream_id
              AND previous.stream_seq = NEW.stream_seq - 1
          ))
      ) BEGIN SELECT RAISE(ABORT, 'event sequence invalid'); END;
    CREATE TABLE context_snapshots (
      snapshot_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      state TEXT NOT NULL, snapshot_generation INTEGER NOT NULL,
      invalidated_at TEXT, invalidation_reason TEXT
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
  database.prepare("INSERT INTO rooms VALUES (?, ?, 'active', ?, ?, 1, 0, NULL)").run(
    "room-1", "Secret project", "2026-08-24T00:00:00.000Z", "owner",
  );
  database.prepare("INSERT INTO rooms VALUES (?, ?, 'active', ?, ?, 1, 0, NULL)").run(
    "room-2", "Other secret", "2026-08-24T00:00:00.000Z", "tenant-only",
  );
  database.exec("INSERT INTO streams VALUES ('room','room-1',0,1), ('room','room-2',0,1)");
  for (const [roomId, actorId, kind, role, accessRevision] of [
    ["room-1", "owner", "human", "owner", 3],
    ["room-1", "admin", "human", "admin", 3],
    ["room-1", "member", "human", "member", 3],
    ["room-1", "agent-1", "agent", null, 7],
    ["room-1", "agent-2", "agent", null, 9],
    ["room-2", "tenant-only", "human", "owner", 1],
  ] as const) {
    database.prepare("INSERT INTO room_memberships VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)").run(
      roomId, actorId, kind, role, kind === "agent" ? "active" : null,
      "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z", accessRevision,
    );
  }
  database.prepare("INSERT INTO agent_profiles VALUES (?, ?, ?, ?, 2, 'enabled', ?, ?)").run(
    "profile-1", "agent-1", "Review Agent", "Review delivery",
    JSON.stringify(["room.project.read", "room.respond"]),
    JSON.stringify(["repository.git-status", "room-memory.read"]),
  );
  database.prepare("INSERT INTO agent_profiles VALUES (?, ?, ?, ?, 4, 'disabled', ?, ?)").run(
    "profile-2", "agent-2", "Disabled Agent", "Disabled",
    JSON.stringify(["room.respond"]),
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
  const temporaryDirectories: string[] = [];

  beforeEach(() => { database = fixture(); });
  afterEach(() => {
    database.close();
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
  });

  it("creates a stable-actor Assignment with one receipt, audit, and immutable history row", () => {
    const result = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now));
    expect(result).toMatchObject({
      changed: true, acceptedRevision: 1, roomRevision: 2,
      eventIds: [expect.stringMatching(/^assignment-event:/u)],
    });
    expect(result).not.toHaveProperty("assignment");
    const assignment = inTransaction(database, "room-1", (transaction) =>
      getRoomAssignmentInTransaction(
        transaction, context("owner"), "room-1", result.assignmentId, now,
      ));
    expect(assignment).toMatchObject({
      roomId: "room-1", profileId: "profile-1", actorId: "agent-1",
      revision: 1, status: "current", participation: "active", paused: false,
    });
    expect(result.assignmentId).not.toContain("agent-1");
    expect(database.prepare("SELECT governance_revision AS revision FROM rooms WHERE id='room-1'").get())
      .toEqual({ revision: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_agent_assignment_revisions").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_audit").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT event_type AS eventType FROM events WHERE event_id = ?",
    ).get(result.eventIds[0])).toEqual({ eventType: "room.agent-assignment.changed" });
    const event = database.prepare(
      "SELECT payload_json AS payloadJson FROM events WHERE event_id = ?",
    ).get(result.eventIds[0]) as { payloadJson: string };
    expect(JSON.parse(event.payloadJson)).toMatchObject({
      operation: "create",
      changed: true,
      acceptedRevision: 1,
      projection: {
        recordKind: "room-agent-assignment",
        recordVersion: 1,
        roomId: "room-1",
        assignmentId: result.assignmentId,
        actorId: "agent-1",
        profileId: "profile-1",
        profileRevision: 2,
        profileDisplayName: "Review Agent",
        profileGlobalResponsibility: "Review delivery",
        assignmentRevision: 1,
        accessRevision: 8,
      },
    });
    expect(event.payloadJson).not.toContain("Other secret");
    expect(event.payloadJson).not.toMatch(/credential|token|secretvalue/iu);
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get())
      .toEqual({ count: 1 });
    expect(() => database.exec("DELETE FROM room_agent_assignment_revisions"))
      .toThrow("history immutable");
  });

  it("materializes the legacy Agent membership only as an Assignment-derived projection", () => {
    database.exec("DELETE FROM room_memberships WHERE room_id='room-1' AND actor_id='agent-1'");
    const result = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        ...createRequest("projection-create"), participation: "on-mention" as const,
      }, now));
    expect(database.prepare(
      `SELECT kind, participation, tool_permissions_json AS tools,
              access_revision AS accessRevision
       FROM room_memberships WHERE room_id='room-1' AND actor_id='agent-1'`,
    ).get()).toEqual({
      kind: "agent", participation: "on-mention",
      tools: '["repository.git-status","room-memory.read"]', accessRevision: 0,
    });
    const event = database.prepare(
      "SELECT payload_json AS payloadJson FROM events WHERE event_id = ?",
    ).get(result.eventIds[0]) as { payloadJson: string };
    expect(JSON.parse(event.payloadJson).projection.accessRevision).toBe(0);
  });

  it("replays the exact result after authority evolves and rejects changed payload reuse", () => {
    const request = createRequest();
    const first = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), request, now));
    database.exec("UPDATE rooms SET governance_revision = 8 WHERE id = 'room-1'");
    const replay = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        ...request, requestId: "transport-retry",
      }, now + 1));
    expect(replay).toEqual(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_audit").get()).toEqual({ count: 1 });
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        ...request, roomResponsibility: "Changed payload",
      }, now + 2)))).toBe("idempotency_conflict");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("admin"), request, now + 3))))
      .toBe("conflict");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        ...request, idempotencyKey: "different-explicit-key",
      }, now + 4)))).toBe("conflict");
  });

  it("replays its event-bearing receipt after a WAL restart", () => {
    database.close();
    const directory = mkdtempSync(join(tmpdir(), "dao-assignment-wal-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "authority.sqlite");
    database = fixture(filename);
    const request = createRequest("wal-create");
    const first = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), request, now));
    database.close();
    database = new DatabaseSync(filename);
    database.exec("PRAGMA foreign_keys = ON");
    const replay = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        ...request, requestId: "wal-retry",
      }, now + 10));
    expect(replay).toEqual(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get())
      .toEqual({ count: 1 });
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
        kind: "update", requestId: "overflow", idempotencyKey: "overflow-key", roomId: "room-1",
        assignmentId: created.assignmentId,
        expectedRoomRevision: 2, expectedAssignmentRevision: 1,
        participation: "active", roomResponsibility: "Escalated",
        capabilitySubset: ["room.conversation.read"], toolSubset: [],
      }, now + 1)))).toBe("conflict");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("admin"), {
        kind: "pause", requestId: "stale", idempotencyKey: "stale-key", roomId: "room-1",
        assignmentId: created.assignmentId,
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
    database.prepare(
      `INSERT INTO context_snapshots VALUES
       ('snapshot-1', 'room-1', 'agent-1', 'active', 1, NULL, NULL)`,
    ).run();
    const pause = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "pause", requestId: "pause", idempotencyKey: "pause-key", roomId: "room-1",
        assignmentId: created.assignmentId,
        expectedRoomRevision: 2, expectedAssignmentRevision: 1,
      }, now + 1));
    const resume = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "resume", requestId: "resume", idempotencyKey: "resume-key", roomId: "room-1",
        assignmentId: created.assignmentId,
        expectedRoomRevision: 3, expectedAssignmentRevision: pause.acceptedRevision,
      }, now + 2));
    const removed = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "remove", requestId: "remove", idempotencyKey: "remove-key", roomId: "room-1",
        assignmentId: created.assignmentId,
        expectedRoomRevision: 4, expectedAssignmentRevision: resume.acceptedRevision,
      }, now + 3));
    expect(removed).toMatchObject({ acceptedRevision: 4, changed: true });
    expect(database.prepare(
      "SELECT status, paused, revision FROM room_agent_assignments WHERE id = ?",
    ).get(created.assignmentId)).toEqual({ status: "removed", paused: 1, revision: 4 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'agent-1'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_agent_assignments").get())
      .toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT operation FROM room_agent_assignment_revisions ORDER BY revision",
    ).all()).toEqual([
      { operation: "create" }, { operation: "pause" },
      { operation: "resume" }, { operation: "remove" },
    ]);
    expect(database.prepare(
      "SELECT state, snapshot_generation AS generation, invalidation_reason AS reason FROM context_snapshots",
    ).get()).toEqual({ state: "invalidated", generation: 2, reason: "authorization_changed" });
  });

  it("allows only strict security reductions in an archived Room", () => {
    const created = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now));
    database.exec(`UPDATE rooms SET status='archived', archive_generation=1,
      archived_at='2026-08-24T12:00:00.000Z' WHERE id='room-1'`);
    database.exec(`INSERT INTO room_assignment_archive_policies VALUES
      ('room-1', 1, 1, 1, 1, '2026-08-24T12:00:00.000Z')`);
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "resume", requestId: "archived-resume", idempotencyKey: "archived-resume-key", roomId: "room-1",
        assignmentId: created.assignmentId,
        expectedRoomRevision: 2, expectedAssignmentRevision: 1,
      }, now + 1)))).toBe("conflict");
    inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "update", requestId: "archived-reduce", idempotencyKey: "archived-reduce-key", roomId: "room-1",
        assignmentId: created.assignmentId,
        expectedRoomRevision: 2, expectedAssignmentRevision: 1,
        participation: "on-mention", roomResponsibility: "Review delivery risk",
        capabilitySubset: ["room.respond"], toolSubset: ["room-memory.read"],
      }, now + 2));
    expect(inTransaction(database, "room-1", (transaction) => getRoomAssignmentInTransaction(
      transaction, context("owner"), "room-1", created.assignmentId, now + 2,
    ))).toMatchObject({
      participation: "on-mention", capabilitySubset: ["room.respond"],
    });
    expect(database.prepare(
      `SELECT participation, tool_permissions_json AS tools
       FROM room_memberships WHERE room_id='room-1' AND actor_id='agent-1'`,
    ).get()).toEqual({ participation: "on-mention", tools: '["room-memory.read"]' });
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "update", requestId: "archived-expand", idempotencyKey: "archived-expand-key", roomId: "room-1",
        assignmentId: created.assignmentId,
        expectedRoomRevision: 3, expectedAssignmentRevision: 2,
        participation: "active", roomResponsibility: "Review delivery risk",
        capabilitySubset: ["room.project.read", "room.respond"],
        toolSubset: ["repository.git-status", "room-memory.read"],
      }, now + 3)))).toBe("conflict");
    const paused = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "pause", requestId: "archived-pause", idempotencyKey: "archived-pause-key", roomId: "room-1",
        assignmentId: created.assignmentId,
        expectedRoomRevision: 3, expectedAssignmentRevision: 2,
      }, now + 3));
    expect(paused.acceptedRevision).toBe(3);
    const removed = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "remove", requestId: "archived-remove", idempotencyKey: "archived-remove-key", roomId: "room-1",
        assignmentId: created.assignmentId,
        expectedRoomRevision: 4, expectedAssignmentRevision: 3,
      }, now + 4));
    expect(removed.acceptedRevision).toBe(4);
  });

  it("requires the existing archive reduction participant policy and rolls back without it", () => {
    const created = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now));
    database.exec(`UPDATE rooms SET status='archived', archive_generation=1,
      archived_at='2026-08-24T12:00:00.000Z' WHERE id='room-1'`);
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), {
        kind: "pause", requestId: "uncoordinated-pause", idempotencyKey: "uncoordinated-key",
        roomId: "room-1", assignmentId: created.assignmentId,
        expectedRoomRevision: 2, expectedAssignmentRevision: 1,
      }, now + 1)))).toBe("storage_unavailable");
    expect(database.prepare("SELECT revision, paused FROM room_agent_assignments").get())
      .toEqual({ revision: 1, paused: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
  });

  it("returns only current same-Room assignments to current Human members", () => {
    const created = inTransaction(database, "room-1", (transaction) =>
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
    expect(inTransaction(database, "room-1", (transaction) => getRoomAssignmentInTransaction(
      transaction, context("member"), "room-1", created.assignmentId, now,
    ))).toMatchObject({ assignmentId: created.assignmentId });
    expect(errorCode(() => inTransaction(database, "room-2", (transaction) =>
      getRoomAssignmentInTransaction(
        transaction, context("tenant-only"), "room-2", created.assignmentId, now,
      )))).toBe("not_found");
    database.exec("UPDATE sessions SET revoked_at = 1 WHERE actor_id = 'member'");
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      listRoomAssignmentsInTransaction(transaction, context("member"), "room-1", now))))
      .toBe("unauthenticated");
  });

  it("derives availability only after exact Profile/Assignment/access revision recheck", () => {
    const created = inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now));
    const gate = () => inTransaction(database, "room-1", (transaction) =>
      readAssignmentRevisionGateInTransaction(transaction, {
        roomId: "room-1", assignmentId: created.assignmentId,
        expectedProfileRevision: 2, expectedAssignmentRevision: 1,
        expectedAccessRevision: 8, providerReadiness: mintAssignmentProviderReadiness({
          actorId: "agent-1", providerAuthenticated: true,
          observedAt: "2026-08-24T12:00:00.000Z",
        }),
      }));
    expect(gate()).toEqual({ current: true, availability: { eligible: true, availability: "ready" } });
    database.prepare("INSERT INTO agent_executions VALUES ('execution-1','room-1','agent-1','queued')").run();
    expect(gate()).toEqual({ current: true, availability: { eligible: true, availability: "busy" } });
    database.exec("UPDATE room_agent_assignments SET paused=1 WHERE id=(SELECT id FROM room_agent_assignments)");
    expect(inTransaction(database, "room-1", (transaction) =>
      readAssignmentRevisionGateInTransaction(transaction, {
        roomId: "room-1", assignmentId: created.assignmentId,
        expectedProfileRevision: 2, expectedAssignmentRevision: 1,
        expectedAccessRevision: 8, providerReadiness: mintAssignmentProviderReadiness({
          actorId: "agent-1", providerAuthenticated: false,
          observedAt: "2026-08-24T12:00:00.000Z",
        }),
      }))).toEqual({
        current: true, availability: { eligible: true, availability: "paused" },
      });
    database.exec("UPDATE room_agent_assignments SET paused=0");
    expect(inTransaction(database, "room-1", (transaction) =>
      readAssignmentRevisionGateInTransaction(transaction, {
        roomId: "room-1", assignmentId: created.assignmentId,
        expectedProfileRevision: 2, expectedAssignmentRevision: 1,
        expectedAccessRevision: 8, providerReadiness: mintAssignmentProviderReadiness({
          actorId: "agent-1", providerAuthenticated: false,
          observedAt: "2026-08-24T12:00:00.000Z",
        }),
      }))).toEqual({
        current: true, availability: { eligible: true, availability: "noauth" },
      });
    expect(inTransaction(database, "room-1", (transaction) =>
      readAssignmentRevisionGateInTransaction(transaction, {
        roomId: "room-1", assignmentId: created.assignmentId,
        expectedProfileRevision: 2, expectedAssignmentRevision: 1,
        expectedAccessRevision: 9, providerReadiness: mintAssignmentProviderReadiness({
          actorId: "agent-1", providerAuthenticated: true,
          observedAt: "2026-08-24T12:00:00.000Z",
        }),
      }))).toEqual({ current: false });
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      readAssignmentRevisionGateInTransaction(transaction, {
        roomId: "room-1", assignmentId: created.assignmentId,
        expectedProfileRevision: 2, expectedAssignmentRevision: 1,
        expectedAccessRevision: 8,
        providerReadiness: {
          actorId: "agent-1", providerAuthenticated: true,
          observedAt: "2026-08-24T12:00:00.000Z",
        } as ReturnType<typeof mintAssignmentProviderReadiness>,
      })))).toBe("storage_unavailable");
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

  it("rolls assignment, event, stream, audit, invalidation, and receipt back on outbox failure", () => {
    database.exec(`CREATE TRIGGER fail_assignment_outbox BEFORE INSERT ON outbox_deliveries
      BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`);
    expect(errorCode(() => inTransaction(database, "room-1", (transaction) =>
      executeRoomAssignmentCommandInTransaction(transaction, context("owner"), createRequest(), now))))
      .toBe("storage_unavailable");
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_agent_assignments").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT head_seq AS headSeq FROM streams WHERE stream_id='room-1'").get())
      .toEqual({ headSeq: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_audit").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 0 });
  });
});
