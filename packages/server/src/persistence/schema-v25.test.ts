import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V25_MIGRATION_CHECKSUM_FOR_TEST,
  AUTHORITY_V25_STATEMENT_COUNT_FOR_TEST,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

function physical(database: DatabaseSync): unknown[] {
  return database.prepare(
    `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  ).all();
}

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v25-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try { operation(database); } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("authority SQLite v25 Project transition authority", () => {
  it("upgrades v24 append-only and preserves the immutable migration history", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 24);
      database.exec(`
        INSERT INTO actors (id, kind, display_name) VALUES ('human-v24','human','Human');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity','human-v24',0,1), ('room','room-v24',1,1);
        INSERT INTO rooms (id,name,status,created_at,owner_actor_id)
        VALUES ('room-v24','Room','active','2026-08-25T00:00:00.000Z','human-v24');
        INSERT INTO room_memberships (
          room_id,actor_id,kind,role,participation,tool_permissions_json,
          joined_at,configured_at,access_revision
        ) VALUES ('room-v24','human-v24','human','owner',NULL,'[]',
                  '2026-08-25T00:00:00.000Z',NULL,1);
        INSERT INTO project_events (
          event_id,room_id,project_id,event_seq,event_type,fact_kind,fact_id,fact_revision,
          actor_kind,actor_id,source_room_id,source_id,source_kind,source_revision,
          source_visibility,occurred_at,payload_json
        ) VALUES ('event-v24','room-v24','room-v24',1,'fact.created','request','request-v24',1,
                  'human','human-v24','room-v24','source-v24','legacy',1,'room',
                  '2026-08-25T00:00:00.000Z','{}');
        INSERT INTO project_transition_audit (
          audit_id,room_id,project_id,project_revision,event_id,operation,fact_kind,fact_id,
          actor_kind,actor_id,transition_json,occurred_at
        ) VALUES ('audit-v24','room-v24','room-v24',1,'event-v24','fact.created','request',
                  'request-v24','human','human-v24','{}','2026-08-25T00:00:00.000Z');
        INSERT INTO events (
          event_id,stream_kind,stream_id,stream_seq,room_id,actor_id,event_type,occurred_at,payload_json
        ) VALUES ('event-v24','room','room-v24',1,'room-v24','human-v24',
                  'project.request.changed','2026-08-25T00:00:00.000Z','{}');
      `);
      const history = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_SCHEMA_VERSION).toBe(25);
      expect(readSchemaVersion(database)).toBe(25);
      expect(database.prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version <= 24 ORDER BY version",
      ).all()).toEqual(history);
      expect(database.prepare("PRAGMA table_info(project_events)").all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "authority_kind", notnull: 1 }),
          expect.objectContaining({ name: "actor_id", notnull: 0 }),
          expect.objectContaining({ name: "causal_actor_id", notnull: 0 }),
        ]));
      expect(database.prepare(
        `SELECT public.authority_kind AS publicAuthority,
                project.authority_kind AS projectAuthority,
                project.causal_actor_kind AS causalKind,
                project.causal_actor_id AS causalActorId,
                audit.authority_kind AS auditAuthority,
                audit.causal_actor_id AS auditCausalActorId
         FROM events AS public
         JOIN project_events AS project ON project.event_id = public.event_id
         JOIN project_transition_audit AS audit ON audit.event_id = project.event_id
         WHERE public.event_id = 'event-v24'`,
      ).get()).toEqual({ publicAuthority: "human", projectAuthority: "human",
        causalKind: "human", causalActorId: "human-v24", auditAuthority: "human",
        auditCausalActorId: "human-v24" });
      expect(AUTHORITY_V25_MIGRATION_CHECKSUM_FOR_TEST).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("rolls every v25 statement back to the byte-equivalent v24 contract", () => {
    expect(AUTHORITY_V25_STATEMENT_COUNT_FOR_TEST).toBeGreaterThan(0);
    for (let statement = 1; statement <= AUTHORITY_V25_STATEMENT_COUNT_FOR_TEST; statement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, 24);
        const before = physical(database);
        const history = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        expect(() => migrateAuthorityDatabase(database, { failAfterStatement: statement }))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(24);
        expect(physical(database)).toEqual(before);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(history);
        expect(database.prepare("PRAGMA legacy_alter_table").get())
          .toEqual({ legacy_alter_table: 0 });
      });
    }
  }, 180_000);

  it("rejects forged timer authority and preserves fresh/v24-upgraded physical equivalence", () => {
    let freshPhysical: unknown[] = [];
    withDatabase((fresh) => {
      migrateAuthorityDatabase(fresh);
      freshPhysical = physical(fresh);
      fresh.exec(`
        INSERT INTO actors (id, kind, display_name) VALUES ('human-1','human','Human');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity','human-1',0,1), ('room','room-1',0,1);
        INSERT INTO rooms (id,name,status,created_at,owner_actor_id)
        VALUES ('room-1','Room','active','2026-08-25T00:00:00.000Z','human-1');
        INSERT INTO room_memberships (
          room_id,actor_id,kind,role,participation,tool_permissions_json,
          joined_at,configured_at,access_revision
        ) VALUES ('room-1','human-1','human','owner',NULL,'[]','2026-08-25T00:00:00.000Z',NULL,1);
      `);
      expect(() => fresh.prepare(
        `INSERT INTO project_events (
           event_id,room_id,project_id,event_seq,event_type,fact_kind,fact_id,fact_revision,
           authority_kind,actor_kind,actor_id,causal_actor_kind,causal_actor_id,
           source_room_id,source_id,source_kind,source_revision,source_visibility,
           occurred_at,payload_json
         ) VALUES ('forged','room-1','room-1',1,'fact.transitioned','goal','goal-1',1,
                   'system_timer',NULL,NULL,NULL,NULL,'room-1','source-1','legacy',1,
                   'room','2026-08-25T00:00:00.000Z','{"transition":"review_due"}')`,
      ).run()).toThrow(/transition authority is invalid/i);
      expect(() => fresh.prepare(
        `INSERT INTO project_events (
           event_id,room_id,project_id,event_seq,event_type,fact_kind,fact_id,fact_revision,
           authority_kind,actor_kind,actor_id,causal_actor_kind,causal_actor_id,
           source_room_id,source_id,source_kind,source_revision,source_visibility,
           occurred_at,payload_json
         ) VALUES ('forged-transfer','room-1','room-1',1,'fact.transitioned','next_action',
                   'action-1',1,'system_timer',NULL,NULL,NULL,NULL,'room-1','source-1',
                   'legacy',1,'room','2026-08-25T00:00:00.000Z',
                   '{"transition":"transfer_expired","transferProposalId":"transfer-1"}')`,
      ).run()).toThrow(/transition authority is invalid/i);
      fresh.prepare(
        `INSERT INTO project_events (
           event_id,room_id,project_id,event_seq,event_type,fact_kind,fact_id,fact_revision,
           authority_kind,actor_kind,actor_id,causal_actor_kind,causal_actor_id,
           source_room_id,source_id,source_kind,source_revision,source_visibility,
           occurred_at,payload_json
         ) VALUES ('review-event','room-1','room-1',1,'fact.transitioned','blocker',
                   'blocker-1',1,'system_timer',NULL,NULL,NULL,NULL,'room-1','source-1',
                   'legacy',1,'room','2026-08-25T00:00:00.000Z','{"transition":"review_due"}')`,
      ).run();
      fresh.prepare(
        "UPDATE streams SET head_seq = 1 WHERE stream_kind = 'room' AND stream_id = 'room-1'",
      ).run();
      expect(() => fresh.prepare(
        `INSERT INTO events (
           event_id,stream_kind,stream_id,stream_seq,room_id,authority_kind,actor_id,
           event_type,occurred_at,payload_json
         ) VALUES ('review-event','room','room-1',1,'room-1','system_timer',NULL,
                   'project.goal.changed','2026-08-25T00:00:00.000Z','{}')`,
      ).run()).toThrow(/event sequence is outside/i);
      expect(() => fresh.prepare(
        `INSERT INTO events (
           event_id,stream_kind,stream_id,stream_seq,room_id,authority_kind,actor_id,
           event_type,occurred_at,payload_json
         ) VALUES ('review-event','room','room-1',1,'room-1','system_timer',NULL,
                   'project.blocker.changed','2026-08-25T00:00:00.000Z',
                   '{"obstacleId":"different-blocker","revision":1}')`,
      ).run()).toThrow(/event sequence is outside/i);
    });
    withDatabase((upgraded) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(upgraded, 24);
      migrateAuthorityDatabase(upgraded);
      expect(physical(upgraded)).toEqual(freshPhysical);
    });
  });
});
