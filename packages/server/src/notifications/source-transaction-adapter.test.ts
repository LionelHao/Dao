import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  useAuthorityTransactionDatabase,
  withDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import type {
  HumanRequestMessageBinding,
  HumanRequestMessageTransactionParticipant,
} from "../project-loop/message-human-request-participant.js";
import {
  appendNotificationIdentityEventInTransaction,
  readNotificationProjectionById,
} from "./sqlite-authority.js";
import {
  createNotificationAwareHumanRequestParticipant,
  persistNotificationProducerEvidenceBatchInTransaction,
  persistNotificationProducerEvidenceInTransaction,
  projectNotificationSourceTerminalInTransaction,
  recoverNotificationSourceRevocationsInTransaction,
  revokeNotificationSourceInTransaction,
} from "./source-transaction-adapter.js";

const now = "2026-08-31T08:00:00.000Z";
const later = "2026-08-31T09:00:00.000Z";

function setup(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE streams (
      stream_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      head_seq INTEGER NOT NULL,
      earliest_available_seq INTEGER NOT NULL,
      PRIMARY KEY (stream_kind, stream_id)
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      stream_kind TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_seq INTEGER NOT NULL,
      room_id TEXT,
      authority_kind TEXT NOT NULL,
      actor_id TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (stream_kind, stream_id, stream_seq)
    );
    CREATE TABLE outbox_deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      stream_seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      available_at TEXT NOT NULL,
      delivered_at TEXT,
      last_error TEXT
    );
    CREATE TABLE notifications (
      notification_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      recipient_actor_id TEXT NOT NULL,
      notification_kind TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      source_boundary_id TEXT NOT NULL,
      source_ordinal INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      safe_actor_id TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT,
      read_revision INTEGER NOT NULL,
      handled_at TEXT,
      handled_revision INTEGER NOT NULL,
      revoked_at TEXT,
      revoke_reason TEXT,
      UNIQUE(recipient_actor_id, source_boundary_id, notification_kind, source_ordinal)
    );
    CREATE TABLE source_facts (
      source_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO streams VALUES ('identity', 'human-target', 0, 1);
    INSERT INTO streams VALUES ('identity', 'human-requester', 0, 1);
  `);
  return database;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const binding: HumanRequestMessageBinding = Object.freeze({
  roomId: "room-1",
  projectId: "room-1",
  requestIntentId: "request-intent-1",
  sourceMessageId: "message-1",
  sourceRevision: 1,
  requesterHumanActorId: "human-requester",
  targetHumanActorId: "human-target",
  sourceTargetId: "target-1",
  occurredAt: now,
});

function delegate(): HumanRequestMessageTransactionParticipant {
  const requestId = "request-1";
  return Object.freeze({
    createPendingInTransaction(transactionView, value) {
      return withDatabase(transactionView, (database) => {
        const inserted = database.prepare(
          "INSERT INTO source_facts VALUES (?, ?, 'pending') ON CONFLICT DO NOTHING",
        ).run(requestId, value.roomId);
        return Object.freeze({
          status: inserted.changes === 1 ? "created" as const : "replayed" as const,
          roomId: value.roomId,
          requestIntentId: value.requestIntentId,
          requestId,
          eventId: "project-request-event-1",
          boundaryId: "project-request-boundary-1",
          projectRevision: 1,
        });
      });
    },
    cancelPendingForRecallInTransaction(transactionView, value) {
      return withDatabase(transactionView, (database) => {
        database.prepare("UPDATE source_facts SET status = 'cancelled' WHERE source_id = ?")
          .run(requestId);
        return Object.freeze({ roomId: value.roomId, sourceMessageId: value.sourceMessageId,
          cancelledRequestIds: Object.freeze([requestId]), eventIds: Object.freeze([]) });
      });
    },
  });
}

function withDatabase<T>(
  transactionView: Parameters<HumanRequestMessageTransactionParticipant["createPendingInTransaction"]>[0],
  operation: (database: DatabaseSync) => T,
): T {
  // Using the capability is what proves the adapter cannot escape the source transaction.
  return useAuthorityTransactionDatabase(transactionView, operation);
}

describe("FT-12 source transaction notification adapter", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });

  it("commits Human mention and Request notifications with the canonical source participant", () => {
    const database = setup(); databases.push(database);
    const participant = createNotificationAwareHumanRequestParticipant({ delegate: delegate() });
    const create = () => transaction(database, () => withDatabaseAuthorityTransactionView(
      database, binding.roomId, "message-submit-1",
      (view) => participant.createPendingInTransaction(view, binding),
    ));
    expect(create()).toMatchObject({ status: "created", requestId: "request-1" });
    expect(create()).toMatchObject({ status: "replayed", requestId: "request-1" });
    expect(database.prepare(
      `SELECT notification_kind AS kind, handled_at AS handledAt
       FROM notifications ORDER BY notification_kind`,
    ).all()).toEqual([
      { kind: "human_mention", handledAt: null },
      { kind: "human_request", handledAt: null },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get())
      .toEqual({ count: 2 });
  });

  it("rolls the source fact, notification facts, stable events and outbox back together", () => {
    const database = setup(); databases.push(database);
    let appended = 0;
    const participant = createNotificationAwareHumanRequestParticipant({
      delegate: delegate(),
      appendEvent(db, input) {
        appended += 1;
        if (appended === 2) throw new Error("injected second notification event failure");
        return appendNotificationIdentityEventInTransaction(db, input);
      },
    });
    expect(() => transaction(database, () => withDatabaseAuthorityTransactionView(
      database, binding.roomId, "message-submit-fault",
      (view) => participant.createPendingInTransaction(view, binding),
    ))).toThrow("injected second notification event failure");
    for (const table of ["source_facts", "notifications", "events", "outbox_deliveries"]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
        .toEqual({ count: 0 });
    }
  });

  it("projects recall terminal to both facts without treating replay or read as handled", () => {
    const database = setup(); databases.push(database);
    const participant = createNotificationAwareHumanRequestParticipant({ delegate: delegate() });
    transaction(database, () => withDatabaseAuthorityTransactionView(
      database, binding.roomId, "message-submit-1",
      (view) => participant.createPendingInTransaction(view, binding),
    ));
    const recallBinding = Object.freeze({ roomId: binding.roomId,
      sourceMessageId: binding.sourceMessageId, sourceRevision: 2,
      recalledByHumanActorId: binding.requesterHumanActorId, occurredAt: later });
    const recall = () => transaction(database, () => withDatabaseAuthorityTransactionView(
      database, binding.roomId, "message-recall-1",
      (view) => participant.cancelPendingForRecallInTransaction(view, recallBinding),
    ));
    recall();
    recall();
    expect(database.prepare(
      "SELECT handled_at AS handledAt, handled_revision AS revision FROM notifications",
    ).all()).toEqual([
      { handledAt: later, revision: 1 },
      { handledAt: later, revision: 1 },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 4 });
  });

  it("revokes a recalled mention source with one stable recipient event", () => {
    const database = setup(); databases.push(database);
    const participant = createNotificationAwareHumanRequestParticipant({ delegate: delegate() });
    transaction(database, () => withDatabaseAuthorityTransactionView(
      database, binding.roomId, "message-submit-1",
      (view) => participant.createPendingInTransaction(view, binding),
    ));
    expect(transaction(database, () => revokeNotificationSourceInTransaction(database, {
      roomId: binding.roomId,
      sourceKind: "message_mention",
      sourceId: binding.sourceMessageId,
      revokedAt: later,
    }))).toEqual({ matchedCount: 1, revokedCount: 1 });
    expect(database.prepare(
      `SELECT notification_kind AS kind, revoked_at AS revokedAt, revoke_reason AS reason
       FROM notifications ORDER BY notification_kind`,
    ).all()).toEqual([
      { kind: "human_mention", revokedAt: later, reason: "source_inaccessible" },
      { kind: "human_request", revokedAt: null, reason: null },
    ]);
    expect(database.prepare(
      "SELECT event_type AS type FROM events ORDER BY stream_seq",
    ).all()).toContainEqual({ type: "notification.revoked" });
  });

  it("durably revokes an unbounded recalled source and restart-recovers bounded event tails", () => {
    const database = setup(); databases.push(database);
    const insert = database.prepare(
      `INSERT INTO notifications (
         notification_id, room_id, recipient_actor_id, notification_kind, source_kind,
         source_id, source_revision, source_boundary_id, source_ordinal, dedupe_key,
         safe_actor_id, created_at, read_at, read_revision, handled_at, handled_revision,
         revoked_at, revoke_reason
       ) VALUES (?, 'room-1', 'human-target', 'human_mention', 'message_mention',
         'message-many-revisions', ?, ?, 0, ?, NULL, ?, NULL, 0, NULL, 0, NULL, NULL)`,
    );
    transaction(database, () => {
      for (let index = 0; index < 320; index += 1) {
        insert.run(`notification-revision-${index}`, index + 1,
          `message-many-revisions:${index + 1}`, index.toString(16).padStart(64, "0"), now);
      }
      expect(revokeNotificationSourceInTransaction(database, {
        roomId: "room-1", sourceKind: "message_mention",
        sourceId: "message-many-revisions", revokedAt: later,
      })).toEqual({ matchedCount: 320, revokedCount: 320 });
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE revoked_at = ?",
    ).get(later)).toEqual({ count: 320 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'notification.revoked'",
    ).get()).toEqual({ count: 256 });
    expect(readNotificationProjectionById(database, "notification-revision-319")).toBeNull();

    // Separate committed transactions model AuthorityWorker restart/retry boundaries.
    expect(transaction(database, () => recoverNotificationSourceRevocationsInTransaction(
      database, { roomId: "room-1", sourceKind: "message_mention",
        sourceId: "message-many-revisions", limit: 32 },
    ))).toEqual({ recoveredCount: 32, hasMore: true });
    expect(transaction(database, () => recoverNotificationSourceRevocationsInTransaction(
      database, { roomId: "room-1", sourceKind: "message_mention",
        sourceId: "message-many-revisions", limit: 32 },
    ))).toEqual({ recoveredCount: 32, hasMore: false });
    expect(transaction(database, () => recoverNotificationSourceRevocationsInTransaction(
      database, { roomId: "room-1", sourceKind: "message_mention",
        sourceId: "message-many-revisions", limit: 32 },
    ))).toEqual({ recoveredCount: 0, hasMore: false });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'notification.revoked'",
    ).get()).toEqual({ count: 320 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM outbox_deliveries",
    ).get()).toEqual({ count: 320 });
  });

  it("bounds terminal fanout to pending rows and leaves a new source boundary untouched", () => {
    const database = setup(); databases.push(database);
    const insert = database.prepare(
      `INSERT INTO notifications (
         notification_id, room_id, recipient_actor_id, notification_kind, source_kind,
         source_id, source_revision, source_boundary_id, source_ordinal, dedupe_key,
         safe_actor_id, created_at, read_at, read_revision, handled_at, handled_revision,
         revoked_at, revoke_reason
       ) VALUES (?, 'room-1', 'human-target', 'agent_execution_failed', 'agent_execution',
         ?, ?, ?, ?, ?, NULL, ?, NULL, 0, ?, ?, NULL, NULL)`,
    );
    transaction(database, () => {
      for (let index = 0; index < 320; index += 1) {
        insert.run(`notification-handled-${index}`, "execution-old", index + 1,
          "execution-old", index, (index + 1).toString(16).padStart(64, "0"), now, later, 1);
      }
      insert.run("notification-current-pending", "execution-old", 321,
        "execution-old", 321, "a".repeat(64), now, null, 0);
      insert.run("notification-new-revision", "execution-old", 322,
        "execution-new", 0, "b".repeat(64), now, null, 0);
    });
    expect(transaction(database, () => projectNotificationSourceTerminalInTransaction(database, {
      sourceKind: "agent_execution", sourceBoundaryId: "execution-old",
      sourceTerminal: "execution_result_acknowledged_or_recovered", occurredAt: later,
    }))).toEqual({ matchedCount: 1, newlyHandledCount: 1 });
    expect(database.prepare(
      `SELECT notification_id AS notificationId, handled_at AS handledAt
       FROM notifications WHERE notification_id IN (
         'notification-current-pending', 'notification-new-revision'
       ) ORDER BY notification_id`,
    ).all()).toEqual([
      { notificationId: "notification-current-pending", handledAt: later },
      { notificationId: "notification-new-revision", handledAt: null },
    ]);
  });

  it("collapses an exact multi-relation recipient and rejects a conflicting stable fact pre-write", () => {
    const database = setup(); databases.push(database);
    const evidence = {
      kind: "tool_result" as const, roomId: "room-1", roomLifecycle: "active" as const,
      createdAt: now, actorId: "agent-1", toolCallId: "tool-call-1", toolCallRevision: 3,
      exactRelatedHumanActorId: "human-target", relation: "confirmation_principal" as const,
      resultState: "known_succeeded" as const,
    };
    const results = transaction(database, () =>
      persistNotificationProducerEvidenceBatchInTransaction(database, [
        evidence, { ...evidence, relation: "invocation_source" as const },
      ]));
    expect(results).toHaveLength(1);
    expect(results[0]?.projection).toMatchObject({ handled: false,
      recipientActorId: "human-target" });
    expect(() => transaction(database, () =>
      persistNotificationProducerEvidenceBatchInTransaction(database, [
        evidence, { ...evidence, createdAt: later },
      ]))).toThrow("conflicting stable identity");
    expect(database.prepare("SELECT COUNT(*) AS count FROM notifications").get())
      .toEqual({ count: 1 });
  });

  it("suppresses archived/ineligible evidence and bounds source terminal fanout before mutation", () => {
    const database = setup(); databases.push(database);
    expect(transaction(database, () => persistNotificationProducerEvidenceInTransaction(database, {
      kind: "project_due", roomId: "room-1", roomLifecycle: "archived", createdAt: now,
      actorId: null, boundaryId: "due-1", sourceFactId: "action-1", sourceRevision: 1,
      lifecycleGeneration: 1, reminderOrdinal: 0,
      holder: { kind: "human", actorId: "human-target", membership: "active" },
    }))).toBeNull();
    expect(projectNotificationSourceTerminalInTransaction(database, {
      sourceKind: "project_boundary", sourceBoundaryId: "missing",
      sourceTerminal: "project_boundary_released", occurredAt: later,
    })).toEqual({ matchedCount: 0, newlyHandledCount: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM notifications").get())
      .toEqual({ count: 0 });

    const insert = database.prepare(
      `INSERT INTO notifications (
         notification_id, room_id, recipient_actor_id, notification_kind, source_kind,
         source_id, source_revision, source_boundary_id, source_ordinal, dedupe_key,
         safe_actor_id, created_at, read_at, read_revision, handled_at, handled_revision,
         revoked_at, revoke_reason
       ) VALUES (?, 'room-1', ?, 'agent_execution_failed', 'agent_execution',
         'execution-overflow', 1, 'execution-overflow', 0, ?, NULL, ?, NULL, 0, NULL, 0,
         NULL, NULL)`,
    );
    transaction(database, () => {
      for (let index = 0; index < 257; index += 1) {
        insert.run(`notification-overflow-${index}`, `human-overflow-${index}`,
          index.toString(16).padStart(64, "0"), now);
      }
    });
    expect(() => transaction(database, () => projectNotificationSourceTerminalInTransaction(
      database,
      { sourceKind: "agent_execution", sourceBoundaryId: "execution-overflow",
        sourceTerminal: "execution_result_acknowledged_or_recovered", occurredAt: later },
    ))).toThrow("fanout exceeded");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE handled_at IS NOT NULL",
    ).get()).toEqual({ count: 0 });
  });
});
