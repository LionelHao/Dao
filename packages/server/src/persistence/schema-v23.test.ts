import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v23-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedV14ProjectRows(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO actors (id, kind, display_name) VALUES
      ('human-v23', 'human', 'Human'),
      ('agent-v23', 'agent', 'Agent');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'human-v23', 0, 1), ('identity', 'agent-v23', 0, 1),
           ('room', 'room-v23', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES ('room-v23', 'Room', 'active', '2026-08-25T00:00:00.000Z', 'human-v23');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-v23', 'human-v23', 'human', 'owner', NULL, '[]',
       '2026-08-25T00:00:00.000Z', NULL, 1),
      ('room-v23', 'agent-v23', 'agent', NULL, 'active', '[]',
       NULL, '2026-08-25T00:00:00.000Z', 1);
    INSERT INTO project_requests VALUES
      ('request-v14', 'room-v23', 'room-v23', 'message-v14', 3,
       'human-v23', 'human-v23', 'pending_acceptance');
    INSERT INTO project_next_actions VALUES
      ('action-v14', 'room-v23', 'room-v23', 'message-v14', 2,
       'agent', 'agent-v23', 'human-v23', 'in_progress');
    INSERT INTO project_obstacles VALUES
      ('obstacle-v14', 'room-v23', 'room-v23', 'message-v14', 4,
       'blocker', 'human', 'human-v23', 'open');
    INSERT INTO project_transfer_proposals VALUES
      ('transfer-v14', 'room-v23', 'room-v23', 'message-v14', 1,
       'next_action', 'action-v14', 'human', 'human-v23', 'pending');
  `);
}

describe("authority SQLite v23 Project Loop authority", () => {
  it("advances append-only from v22 and exposes the canonical Project Loop tables", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 22);
      const history = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_SCHEMA_VERSION).toBe(23);
      expect(readSchemaVersion(database)).toBe(23);
      expect(database.prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version <= 22 ORDER BY version",
      ).all()).toEqual(history);
      expect(listAuthorityTables(database)).toEqual(expect.arrayContaining([
        "project_goals",
        "project_decisions",
        "project_fact_proposals",
        "project_confirmations",
        "project_events",
        "project_command_receipts",
        "project_room_states",
      ]));
    });
  });

  it("upgrades every immutable v1-v22 contract without rewriting history", () => {
    expect(AUTHORITY_SCHEMA_VERSION).toBe(23);
    for (let version = 1; version <= 22; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        const history = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(23);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations WHERE version <= ? ORDER BY version",
        ).all(version)).toEqual(history);
      });
    }
  }, 180_000);

  it("is repeatable and rejects future or tampered schema contracts", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      const history = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      migrateAuthorityDatabase(database);
      expect(database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all()).toEqual(history);
      database.exec("PRAGMA user_version = 24");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/future schema version/i);
    });
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec("PRAGMA writable_schema = ON");
      database.prepare(
        "UPDATE sqlite_schema SET sql = replace(sql, 'pending', 'tampered') WHERE name = 'project_event_outbox'",
      ).run();
      database.exec("PRAGMA writable_schema = OFF");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/physical contract/i);
    });
  });

  it("preserves every v14 departure skeleton row while adding production columns", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 14);
      seedV14ProjectRows(database);
      migrateAuthorityDatabase(database);

      expect(database.prepare(
        `SELECT id, revision, title, source_kind AS sourceKind,
                created_by_actor_id AS createdByActorId,
                source_revision AS sourceRevision, visibility_room_id AS visibilityRoomId
         FROM project_requests`,
      ).get()).toEqual({
        id: "request-v14",
        revision: 3,
        title: "Legacy Request",
        sourceKind: "legacy_v14",
        createdByActorId: "human-v23",
        sourceRevision: null,
        visibilityRoomId: null,
      });
      expect(database.prepare(
        `SELECT id, revision, title, source_kind AS sourceKind,
                created_by_actor_id AS createdByActorId,
                source_revision AS sourceRevision, visibility_room_id AS visibilityRoomId
         FROM project_next_actions`,
      ).get()).toEqual({
        id: "action-v14",
        revision: 2,
        title: "Legacy NextAction",
        sourceKind: "legacy_v14",
        createdByActorId: "agent-v23",
        sourceRevision: null,
        visibilityRoomId: null,
      });
      expect(database.prepare(
        `SELECT id, revision, title, source_kind AS sourceKind,
                created_by_actor_id AS createdByActorId,
                source_revision AS sourceRevision, visibility_room_id AS visibilityRoomId
         FROM project_obstacles`,
      ).get()).toEqual({
        id: "obstacle-v14",
        revision: 4,
        title: "Legacy Obstacle",
        sourceKind: "legacy_v14",
        createdByActorId: "human-v23",
        sourceRevision: null,
        visibilityRoomId: null,
      });
      expect(database.prepare(
        `SELECT id, revision, reason, source_kind AS sourceKind
         FROM project_transfer_proposals`,
      ).get()).toEqual({
        id: "transfer-v14",
        revision: 1,
        reason: "Legacy transfer",
        sourceKind: "legacy_v14",
      });
    });
  }, 30_000);

  it("rejects cross-room and malformed authoritative Project Loop rows", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name) VALUES ('human-v23', 'human', 'Human');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'human-v23', 0, 1), ('room', 'room-v23', 0, 1),
               ('room', 'other-v23', 0, 1);
        INSERT INTO rooms (id, name, status, created_at, owner_actor_id) VALUES
          ('room-v23', 'Room', 'active', CURRENT_TIMESTAMP, 'human-v23'),
          ('other-v23', 'Other', 'active', CURRENT_TIMESTAMP, 'human-v23');
      `);
      expect(() => database.prepare(
        `INSERT INTO project_goals (
           id, room_id, project_id, revision, title, description, status,
           source_room_id, source_id, source_kind, created_by_actor_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, 1, 'Goal', '', 'active', ?, 'source', 'human', ?, ?, ?)`,
      ).run(
        "goal-cross-room", "room-v23", "other-v23", "room-v23", "human-v23",
        "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:00.000Z",
      )).toThrow();
      expect(() => database.prepare(
        `INSERT INTO project_events (
           event_id, room_id, project_id, event_seq, event_type, fact_kind,
           fact_id, fact_revision, actor_kind, actor_id, source_room_id,
           source_id, occurred_at, payload_json
         ) VALUES ('event', 'room-v23', 'room-v23', 1, 'fact.created', 'goal',
                   'goal', 1, 'human', 'human-v23', 'room-v23', 'source',
                   CURRENT_TIMESTAMP, 'not-json')`,
      ).run()).toThrow();
    });
  });

  it("keeps fresh and v22-upgraded physical contracts equivalent and reopens under WAL", () => {
    let freshSql: unknown[] = [];
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      freshSql = database.prepare(
        `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      ).all();
    });
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 22);
      migrateAuthorityDatabase(database);
      expect(database.prepare(
        `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      ).all()).toEqual(freshSql);
    });

    const directory = mkdtempSync(join(tmpdir(), "dao-authority-v23-wal-"));
    const path = join(directory, "authority.sqlite");
    try {
      let database = new DatabaseSync(path);
      database.exec("PRAGMA journal_mode = WAL");
      migrateAuthorityDatabase(database);
      database.close();
      database = new DatabaseSync(path);
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      migrateAuthorityDatabase(database);
      expect(readSchemaVersion(database)).toBe(23);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
