import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedRoomEvent } from "@native-im/core";
import {
  createOutboxDispatcher,
  type OutboxDispatchStore,
} from "../outbox-dispatcher.js";
import type { OutboxDelivery } from "../persistence/contracts.js";
import { createSubscriptionRegistry } from "../subscription-registry.js";
import { executeNotificationAuthorityOperation } from "./database-authority.js";
import { createNotificationRecallOutboxPreparation } from
  "./outbox-recall-preparation.js";
import { readNotificationRepairPage } from "./sqlite-authority.js";
import { revokeNotificationSourceInTransaction } from "./source-transaction-adapter.js";

const createdAt = "2026-08-31T08:00:00.000Z";
const revokedAt = "2026-08-31T09:00:00.000Z";
const sourceId = "message-many-revisions";

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seed(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE sessions (family_id TEXT, account_id TEXT, actor_id TEXT,
      access_token_hash TEXT PRIMARY KEY, access_expires_at INTEGER, revoked_at TEXT);
    CREATE TABLE rooms (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE room_memberships (room_id TEXT, actor_id TEXT, kind TEXT,
      PRIMARY KEY(room_id, actor_id));
    CREATE TABLE streams (stream_kind TEXT, stream_id TEXT, head_seq INTEGER,
      PRIMARY KEY(stream_kind, stream_id));
    CREATE TABLE events (event_id TEXT PRIMARY KEY, stream_kind TEXT, stream_id TEXT,
      stream_seq INTEGER, room_id TEXT, authority_kind TEXT, actor_id TEXT,
      event_type TEXT, occurred_at TEXT, payload_json TEXT,
      UNIQUE(stream_kind, stream_id, stream_seq));
    CREATE TABLE outbox_deliveries (id TEXT PRIMARY KEY, event_id TEXT UNIQUE,
      target_kind TEXT, target_id TEXT, stream_seq INTEGER, status TEXT, attempts INTEGER,
      available_at TEXT, delivered_at TEXT, last_error TEXT);
    CREATE TABLE notifications (
      notification_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
      recipient_actor_id TEXT NOT NULL, notification_kind TEXT NOT NULL,
      source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
      source_boundary_id TEXT NOT NULL, source_ordinal INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE, safe_actor_id TEXT, created_at TEXT NOT NULL,
      read_at TEXT, read_revision INTEGER NOT NULL, handled_at TEXT,
      handled_revision INTEGER NOT NULL, revoked_at TEXT, revoke_reason TEXT,
      UNIQUE(recipient_actor_id, source_boundary_id, notification_kind, source_ordinal));
    INSERT INTO streams VALUES ('identity', 'human-target', 0);
    INSERT INTO actors VALUES ('human-target', 'human'), ('human-author', 'human');
    INSERT INTO sessions VALUES (
      'family-target', 'account-target', 'human-target', 'access-target',
      ${Date.parse(revokedAt) + 60_000}, NULL);
    INSERT INTO rooms VALUES ('room-1', 'active');
    INSERT INTO room_memberships VALUES ('room-1', 'human-target', 'human');
  `);
  const insert = database.prepare(
    `INSERT INTO notifications (
       notification_id, room_id, recipient_actor_id, notification_kind, source_kind,
       source_id, source_revision, source_boundary_id, source_ordinal, dedupe_key,
       safe_actor_id, created_at, read_at, read_revision, handled_at, handled_revision,
       revoked_at, revoke_reason
     ) VALUES (?, 'room-1', 'human-target', 'human_mention', 'message_mention',
       ?, ?, ?, 0, ?, NULL, ?, NULL, 0, NULL, 0, NULL, NULL)`,
  );
  transaction(database, () => {
    for (let index = 0; index < 320; index += 1) {
      insert.run(`notification-${index}`, sourceId, index + 1, `${sourceId}:${index + 1}`,
        index.toString(16).padStart(64, "0"), createdAt);
    }
    expect(revokeNotificationSourceInTransaction(database, {
      roomId: "room-1", sourceKind: "message_mention", sourceId, revokedAt,
    })).toEqual({ matchedCount: 320, revokedCount: 320 });
    database.prepare(
      `INSERT INTO events VALUES (
         'recall-event', 'room', 'room-1', 1, 'room-1', 'actor', 'human-author',
         'room.message.recalled', ?, json(?))`,
    ).run(revokedAt, JSON.stringify({ id: sourceId }));
    database.prepare(
      `INSERT INTO outbox_deliveries VALUES (
         'outbox:recall-event', 'recall-event', 'room', 'room-1', 1,
         'pending', 0, ?, NULL, NULL)`,
    ).run(revokedAt);
  });
  return database;
}

const recallEvent: PersistedRoomEvent = {
  eventId: "recall-event", streamKind: "room", streamId: "room-1", streamSeq: 1,
  roomId: "room-1", actorId: "human-author", occurredAt: revokedAt,
  type: "room.message.recalled", payload: { id: sourceId },
};

function harness(database: DatabaseSync) {
  const delivery: OutboxDelivery = {
    deliveryId: "outbox:recall-event", eventId: recallEvent.eventId,
    targetKind: "room", targetId: "room-1", streamSeq: 1, attempts: 0,
    event: recallEvent,
  };
  let dispatched = false;
  const failed = vi.fn();
  const store: OutboxDispatchStore = {
    async listPendingOutbox() { return dispatched ? [] : [delivery]; },
    async authorizeOutboxCandidate() { return true; },
    async markOutboxDispatched() { dispatched = true; },
    markOutboxFailed: failed,
  };
  const registry = createSubscriptionRegistry();
  registry.addRoom({ roomId: "room-1", connection: {
    connectionId: "connection-1",
    principal: { accountId: "account-target", actorId: "human-target" },
    sessionId: "session-1", sessionFamilyId: "family-1", credentialGeneration: 1,
    revoke() {},
  } });
  const execute = vi.fn(async (operation) =>
    executeNotificationAuthorityOperation(database, operation));
  return { delivery, store, registry, failed, execute,
    dispatched: () => dispatched };
}

function notificationDurability(database: DatabaseSync) {
  return {
    revoked: database.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE revoked_at IS NOT NULL",
    ).get(),
    events: database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'notification.revoked'",
    ).get(),
    outbox: database.prepare(
      `SELECT COUNT(*) AS count FROM outbox_deliveries AS delivery
       JOIN events AS event ON event.event_id = delivery.event_id
       WHERE event.event_type = 'notification.revoked'`,
    ).get(),
  };
}

describe("FT-12 recalled-source outbox recovery barrier", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });

  it("defers the first poll while completing a 320-row tail, then sends on a clean poll", async () => {
    const database = seed(); databases.push(database);
    const target = harness(database);
    const send = vi.fn(async () => ({ accepted: true as const }));
    const dispatcher = createOutboxDispatcher({
      store: target.store, registry: target.registry, send,
      prepareDelivery: createNotificationRecallOutboxPreparation({ execute: target.execute }),
    });
    expect(notificationDurability(database)).toEqual({
      revoked: { count: 320 }, events: { count: 256 }, outbox: { count: 256 },
    });
    await expect(dispatcher.flushOnce()).resolves.toBe(0);
    expect(target.dispatched()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(notificationDurability(database)).toEqual({
      revoked: { count: 320 }, events: { count: 320 }, outbox: { count: 320 },
    });
    const context = { sessionId: "access-target", sessionFamilyId: "family-target",
      principal: { accountId: "account-target", actorId: "human-target" } };
    expect(executeNotificationAuthorityOperation(database, {
      type: "notification.list", context, roomId: null, before: null,
      limit: 256, now: Date.parse(revokedAt),
    })).toMatchObject({ kind: "list", notifications: [], roomBadges: [] });
    expect(readNotificationRepairPage(database, { recipientActorId: "human-target",
      roomId: "room-1", afterNotificationId: undefined, limit: 256 })).toEqual([]);
    expect(executeNotificationAuthorityOperation(database, {
      type: "notification.resolve-source", context,
      notificationId: "notification-319", now: Date.parse(revokedAt),
    })).toEqual({ kind: "failure", code: "source_inaccessible", status: 410 });
    await expect(dispatcher.flushOnce()).resolves.toBe(1);
    expect(target.dispatched()).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(target.failed).not.toHaveBeenCalled();
    expect(target.delivery.attempts).toBe(0);
  });

  it("survives recovery failure and process reconstruction without consuming retry", async () => {
    const database = seed(); databases.push(database);
    const target = harness(database);
    const failedExecute = vi.fn(async () => {
      throw new Error("injected recovery outage");
    });
    const crashing = createOutboxDispatcher({
      store: target.store, registry: target.registry,
      send: async () => ({ accepted: true }),
      prepareDelivery: createNotificationRecallOutboxPreparation({ execute: failedExecute }),
    });
    await expect(crashing.flushOnce()).rejects.toThrow("injected recovery outage");
    expect(target.dispatched()).toBe(false);
    expect(target.failed).not.toHaveBeenCalled();
    expect(target.delivery.attempts).toBe(0);

    const send = vi.fn(async () => ({ accepted: true as const }));
    const restarted = createOutboxDispatcher({
      store: target.store, registry: target.registry, send,
      prepareDelivery: createNotificationRecallOutboxPreparation({ execute: target.execute }),
    });
    await expect(restarted.flushOnce()).resolves.toBe(0);
    await expect(restarted.flushOnce()).resolves.toBe(1);
    expect(target.dispatched()).toBe(true);
    expect(target.failed).not.toHaveBeenCalled();
    expect(target.delivery.attempts).toBe(0);
    expect(notificationDurability(database)).toEqual({
      revoked: { count: 320 }, events: { count: 320 }, outbox: { count: 320 },
    });
  });
});
