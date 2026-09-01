import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deriveNotificationProducerIntent } from "./producer-matrix.js";
import {
  appendNotificationIdentityEventInTransaction,
  listNotificationProjections,
  markNotificationHandledInTransaction,
  markNotificationReadInTransaction,
  persistNotificationInTransaction,
  readNotificationRepairPage,
  revokeNotificationsForRecipientInTransaction,
} from "./sqlite-authority.js";

const createdAt = "2026-08-31T08:00:00.000Z";
const later = "2026-08-31T08:05:00.000Z";

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE rooms (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE room_memberships (room_id TEXT, actor_id TEXT, kind TEXT,
      PRIMARY KEY(room_id, actor_id));
    CREATE TABLE streams (stream_kind TEXT, stream_id TEXT, head_seq INTEGER,
      PRIMARY KEY(stream_kind, stream_id));
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, stream_kind TEXT, stream_id TEXT, stream_seq INTEGER,
      room_id TEXT, authority_kind TEXT, actor_id TEXT, event_type TEXT,
      occurred_at TEXT, payload_json TEXT, UNIQUE(stream_kind,stream_id,stream_seq)
    );
    CREATE TABLE outbox_deliveries (
      id TEXT PRIMARY KEY, event_id TEXT, target_kind TEXT, target_id TEXT,
      stream_seq INTEGER, status TEXT, attempts INTEGER, available_at TEXT,
      delivered_at TEXT, last_error TEXT
    );
    CREATE TABLE notifications (
      notification_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      recipient_actor_id TEXT NOT NULL,
      notification_kind TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
      source_boundary_id TEXT NOT NULL,
      source_ordinal INTEGER NOT NULL CHECK(source_ordinal >= 0),
      dedupe_key TEXT NOT NULL UNIQUE,
      safe_actor_id TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT,
      read_revision INTEGER NOT NULL CHECK(read_revision >= 0),
      handled_at TEXT,
      handled_revision INTEGER NOT NULL CHECK(handled_revision >= 0),
      revoked_at TEXT,
      revoke_reason TEXT,
      UNIQUE(recipient_actor_id, source_boundary_id, notification_kind, source_ordinal)
    );
    INSERT INTO actors VALUES
      ('human-target','human'), ('human-other','human'), ('human-author','human');
    INSERT INTO rooms VALUES ('room-1','active');
    INSERT INTO room_memberships VALUES
      ('room-1','human-target','human'), ('room-1','human-other','human');
    INSERT INTO streams VALUES ('identity','human-target',0), ('identity','human-other',0);
  `);
  return database;
}

function notification(requestId = "request-1", revision = 1) {
  return deriveNotificationProducerIntent({
    kind: "human_request", roomId: "room-1", roomLifecycle: "active", createdAt,
    recipientRelation: "target_pending", requestId, requestRevision: revision,
    requestBoundaryOrdinal: 0, stableTargetHumanActorId: "human-target",
    targetMembership: "active", requestStatus: "pending_acceptance", actorId: "human-author",
  })!;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("FT-12 SQLite Notification authority", () => {
  it("commits one fact/event/outbox and database-deduplicates replay", () => {
    const database = fixture();
    try {
      const fact = notification();
      const created = transaction(database, () => persistNotificationInTransaction(
        database, fact, appendNotificationIdentityEventInTransaction,
      ));
      const duplicate = transaction(database, () => persistNotificationInTransaction(
        database, fact, appendNotificationIdentityEventInTransaction,
      ));
      expect(created).toMatchObject({ outcome: "created", projection: fact });
      expect(duplicate).toEqual({ outcome: "duplicate", projection: fact,
        eventId: created.eventId, streamSeq: created.streamSeq });
      expect(database.prepare("SELECT COUNT(*) AS count FROM notifications").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get())
        .toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it("rolls the fact back when stable event/outbox append fails", () => {
    const database = fixture();
    try {
      expect(() => transaction(database, () => persistNotificationInTransaction(
        database, notification(), () => { throw new Error("event unavailable"); },
      ))).toThrow("event unavailable");
      for (const table of ["notifications", "events", "outbox_deliveries"]) {
        expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
          .toEqual({ count: 0 });
      }
    } finally { database.close(); }
  });

  it("persists recipient read CAS with one stable event and zero handled mutation", () => {
    const database = fixture();
    try {
      transaction(database, () => persistNotificationInTransaction(
        database, notification(), appendNotificationIdentityEventInTransaction));
      const result = transaction(database, () => markNotificationReadInTransaction(database, {
        notificationId: notification().notificationId,
        principal: { kind: "human", actorId: "human-target" }, session: "active",
        membership: "active", sourceAccessible: true, availability: "ready",
        expectedReadRevision: 0, readAt: later,
      }, appendNotificationIdentityEventInTransaction));
      expect(result).toMatchObject({ outcome: "read",
        projection: { readAt: later, readRevision: 1, handled: false, handledAt: null } });
      expect(database.prepare(
        "SELECT read_revision AS readRevision, handled_revision AS handledRevision FROM notifications",
      ).get()).toEqual({ readRevision: 1, handledRevision: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    } finally { database.close(); }
  });

  it("rejects another recipient before writes and derives handled independently", () => {
    const database = fixture();
    try {
      const fact = notification();
      transaction(database, () => persistNotificationInTransaction(
        database, fact, appendNotificationIdentityEventInTransaction));
      expect(() => transaction(database, () => markNotificationReadInTransaction(database, {
        notificationId: fact.notificationId,
        principal: { kind: "human", actorId: "human-other" }, session: "active",
        membership: "active", sourceAccessible: true, availability: "ready",
        expectedReadRevision: 0, readAt: later,
      }, appendNotificationIdentityEventInTransaction))).toThrow("recipient");
      expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });

      const handled = transaction(database, () => markNotificationHandledInTransaction(database, {
        notificationId: fact.notificationId, sourceBoundaryId: fact.source.sourceBoundaryId,
        sourceTerminal: "request_terminal", occurredAt: later,
      }, appendNotificationIdentityEventInTransaction));
      expect(handled).toMatchObject({ handled: true, handledAt: later,
        readAt: null, readRevision: 0 });
      expect(database.prepare(
        "SELECT read_revision AS readRevision, handled_revision AS handledRevision FROM notifications",
      ).get()).toEqual({ readRevision: 0, handledRevision: 1 });
    } finally { database.close(); }
  });

  it("filters cross-recipient and revoked facts with a minimal revoke event", () => {
    const database = fixture();
    try {
      const fact = notification();
      transaction(database, () => persistNotificationInTransaction(
        database, fact, appendNotificationIdentityEventInTransaction));
      expect(listNotificationProjections(database, {
        recipientActorId: "human-other", roomId: null, before: null, limit: 20,
      })).toEqual([]);
      const revoked = transaction(database, () => revokeNotificationsForRecipientInTransaction(
        database, { roomId: "room-1", recipientActorId: "human-target",
          reason: "membership_revoked", revokedAt: later, limit: 20 },
        appendNotificationIdentityEventInTransaction,
      ));
      expect(revoked).toEqual({ revokedCount: 1, hasMore: false });
      expect(listNotificationProjections(database, {
        recipientActorId: "human-target", roomId: null, before: null, limit: 20,
      })).toEqual([]);
      const revokePayload = database.prepare(
        "SELECT payload_json AS payload FROM events WHERE event_type = 'notification.revoked'",
      ).get()?.payload;
      expect(JSON.parse(String(revokePayload))).toEqual({
        notificationId: fact.notificationId, roomId: "room-1",
        recipientActorId: "human-target", reason: "membership_revoked",
      });
    } finally { database.close(); }
  });

  it("immediately omits facts after membership removal while retaining authorized archive history", () => {
    const database = fixture();
    try {
      const fact = notification();
      transaction(database, () => persistNotificationInTransaction(
        database, fact, appendNotificationIdentityEventInTransaction));
      const list = () => listNotificationProjections(database, {
        recipientActorId: "human-target", roomId: null, before: null, limit: 20,
      });
      expect(list()).toEqual([fact]);
      database.prepare(
        "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
      ).run("room-1", "human-target");
      expect(list()).toEqual([]);
      database.prepare(
        "INSERT INTO room_memberships VALUES (?, ?, 'human')",
      ).run("room-1", "human-target");
      expect(list()).toEqual([fact]);
      database.prepare("UPDATE rooms SET status = 'archived' WHERE id = ?").run("room-1");
      expect(list()).toEqual([fact]);
    } finally { database.close(); }
  });

  it("repairs only the authenticated recipient and omits revoked facts", () => {
    const database = fixture();
    try {
      const fact = notification();
      transaction(database, () => persistNotificationInTransaction(
        database, fact, appendNotificationIdentityEventInTransaction));
      expect(readNotificationRepairPage(database, {
        recipientActorId: "human-other", roomId: "room-1",
        afterNotificationId: undefined, limit: 20,
      })).toEqual([]);
      expect(readNotificationRepairPage(database, {
        recipientActorId: "human-target", roomId: "room-1",
        afterNotificationId: undefined, limit: 20,
      })).toEqual([{ kind: "notification", value: fact }]);
      transaction(database, () => revokeNotificationsForRecipientInTransaction(
        database, { roomId: "room-1", recipientActorId: "human-target",
          reason: "source_inaccessible", revokedAt: later, limit: 20 },
        appendNotificationIdentityEventInTransaction,
      ));
      expect(readNotificationRepairPage(database, {
        recipientActorId: "human-target", roomId: "room-1",
        afterNotificationId: undefined, limit: 20,
      })).toEqual([]);
    } finally { database.close(); }
  });

  it("pages 10k recipient facts with a bounded keyset and no duplicates", () => {
    const database = fixture();
    try {
      const insert = database.prepare(`INSERT INTO notifications (
        notification_id, room_id, recipient_actor_id, notification_kind, source_kind,
        source_id, source_revision, source_boundary_id, source_ordinal, dedupe_key,
        safe_actor_id, created_at, read_at, read_revision, handled_at, handled_revision,
        revoked_at, revoke_reason
      ) VALUES (?, 'room-1', 'human-target', 'human_request', 'project_request', ?, 1,
        ?, 0, ?, 'human-author', ?, NULL, 0, NULL, 0, NULL, NULL)`);
      transaction(database, () => {
        for (let index = 0; index < 10_000; index += 1) {
          const key = index.toString(16).padStart(64, "0");
          const id = index.toString().padStart(5, "0");
          insert.run(`notification-${id}`, `request-${id}`, `boundary-${id}`, key,
            `2026-08-31T${String(Math.floor(index / 3_600)).padStart(2, "0")}:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`);
        }
      });
      const seen = new Set<string>();
      let before: Readonly<{ createdAt: string; notificationId: string }> | null = null;
      while (true) {
        const page = listNotificationProjections(database, {
          recipientActorId: "human-target", roomId: null, before, limit: 127,
        });
        if (page.length === 0) break;
        for (const item of page) seen.add(item.notificationId);
        const tail = page.at(-1)!;
        before = { createdAt: tail.createdAt, notificationId: tail.notificationId };
      }
      expect(seen.size).toBe(10_000);
    } finally { database.close(); }
  });
});
