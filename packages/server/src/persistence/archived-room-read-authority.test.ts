import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AuthenticatedSessionContext } from "./contracts.js";
import {
  canAccessRoomDatabaseQuery,
  inspectStreamingRepairScopeDatabaseQuery,
  readHistoryDatabaseQuery,
  readRoomAuditDatabaseQuery,
  readRoomGovernanceDatabaseQuery,
  revalidateSnapshotDatabaseQuery,
} from "./authority-database-handler.js";
import { migrateAuthorityDatabase } from "./schema.js";

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-archived-read-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    migrateAuthorityDatabase(database);
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

const context: AuthenticatedSessionContext = {
  sessionId: "reader-access",
  sessionFamilyId: "reader-family",
  principal: { accountId: "reader-account", actorId: "reader" },
};

function seedArchivedRoom(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO actors (id, kind, display_name)
    VALUES ('owner', 'human', 'Owner'), ('reader', 'human', 'Reader');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES
      ('identity', 'owner', 0, 1), ('identity', 'reader', 0, 1),
      ('room', 'archived-room', 0, 1);
    INSERT INTO session_families (
      family_id, public_id, account_id, actor_id, device_id, device_label,
      platform, created_at, refresh_expires_at, revoked_at
    ) VALUES (
      'reader-family', 'reader-public', 'reader-account', 'reader',
      'reader-device', 'Reader device', 'macos', 1, 9999999999999, NULL
    );
    INSERT INTO sessions (
      family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
      access_expires_at, refresh_expires_at, revoked_at
    ) VALUES (
      'reader-family', 'reader-account', 'reader', 'reader-access', 'reader-refresh',
      9999999999998, 9999999999999, NULL
    );
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('archived-room', 'Archived', 'active', '2026-08-19T00:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('archived-room', 'owner', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('archived-room', 'reader', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 7);
    UPDATE rooms
    SET owner_actor_id = 'owner', status = 'archived', governance_revision = 4,
        archive_generation = 1, archived_at = '2026-08-19T00:01:00.000Z'
    WHERE id = 'archived-room';
    INSERT INTO room_message_archive_gates (room_id, gate_generation, blocked_at)
    VALUES ('archived-room', 1, '2026-08-19T00:01:00.000Z');
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES (
      'history-message', 'archived-room', 'owner', 'human', 'historical fact',
      '2026-08-19T00:00:30.000Z'
    );
    INSERT INTO room_audit (
      id, type, room_id, actor_id, result, timestamp, details_json
    ) VALUES (
      'archive-audit', 'room.archived', 'archived-room', 'owner', 'archived',
      '2026-08-19T00:01:00.000Z', '{}'
    );
  `);
}

describe("archived Room current-Human read authority", () => {
  it("allows complete archived reads and both repair modes, then denies the removed Human", () => {
    withDatabase((database) => {
      seedArchivedRoom(database);

      expect(canAccessRoomDatabaseQuery(database, context, "archived-room", 2)).toBe(true);
      expect(readHistoryDatabaseQuery(database, context, "archived-room", 2))
        .toHaveLength(1);
      expect(readRoomAuditDatabaseQuery(database, context, "archived-room", 2))
        .toHaveLength(1);
      expect(readRoomGovernanceDatabaseQuery(database, context, "archived-room", 2))
        .toMatchObject({ lifecycle: "archived", archiveGeneration: 1 });
      expect(() => revalidateSnapshotDatabaseQuery(database, {
        kind: "room",
        context,
        roomId: "archived-room",
        accessRevision: 7,
      }, 2)).not.toThrow();
      expect(inspectStreamingRepairScopeDatabaseQuery(database, context, {
        kind: "room", roomId: "archived-room",
      }, 2)).toEqual({
        version: { kind: "room", roomId: "archived-room", watermark: 0 },
        authorizationRevision: 7,
      });

      database.prepare(
        "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
      ).run("archived-room", "reader");

      expect(canAccessRoomDatabaseQuery(database, context, "archived-room", 2)).toBe(false);
      for (const read of [
        () => readHistoryDatabaseQuery(database, context, "archived-room", 2),
        () => readRoomAuditDatabaseQuery(database, context, "archived-room", 2),
        () => readRoomGovernanceDatabaseQuery(database, context, "archived-room", 2),
        () => inspectStreamingRepairScopeDatabaseQuery(database, context, {
          kind: "room", roomId: "archived-room",
        }, 2),
      ]) {
        expect(read).toThrowError(expect.objectContaining({ code: "room_forbidden" }));
      }
    });
  });
});
