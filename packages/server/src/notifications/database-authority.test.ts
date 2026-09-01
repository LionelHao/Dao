import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { deriveNotificationProducerIntent } from "./producer-matrix.js";
import { executeNotificationAuthorityOperation } from "./database-authority.js";
import {
  authorizeOutboxCandidateDatabaseQuery,
} from "../persistence/authority-database-handler.js";

const occurredAt = "2026-08-31T08:00:00.000Z";
const now = Date.parse(occurredAt);
const context = Object.freeze({
  sessionId: "access-hash", sessionFamilyId: "family-hash",
  principal: Object.freeze({ accountId: "account-1", actorId: "human-1" }),
});

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE sessions (family_id TEXT, account_id TEXT, actor_id TEXT,
      access_token_hash TEXT PRIMARY KEY, access_expires_at INTEGER, revoked_at INTEGER);
    CREATE TABLE rooms (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE room_memberships (room_id TEXT, actor_id TEXT, kind TEXT,
      PRIMARY KEY(room_id, actor_id));
    CREATE TABLE streams (stream_kind TEXT, stream_id TEXT, head_seq INTEGER,
      PRIMARY KEY(stream_kind, stream_id));
    CREATE TABLE events (event_id TEXT PRIMARY KEY, stream_kind TEXT, stream_id TEXT,
      stream_seq INTEGER, room_id TEXT, authority_kind TEXT, actor_id TEXT,
      event_type TEXT, occurred_at TEXT, payload_json TEXT,
      UNIQUE(stream_kind, stream_id, stream_seq));
    CREATE TABLE outbox_deliveries (id TEXT PRIMARY KEY, event_id TEXT, target_kind TEXT,
      target_id TEXT, stream_seq INTEGER, status TEXT, attempts INTEGER,
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
    CREATE TABLE notification_command_receipts (
      recipient_actor_id TEXT, request_id TEXT, command_kind TEXT, request_sha256 TEXT,
      notification_id TEXT, response_json TEXT, committed_at TEXT, expires_at TEXT,
      PRIMARY KEY(recipient_actor_id, request_id));
    CREATE TABLE tool_calls_v2 (tool_call_id TEXT PRIMARY KEY, room_id TEXT NOT NULL);
    CREATE TABLE tool_dispatches_v2 (
      dispatch_id TEXT PRIMARY KEY, tool_call_id TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE agent_executions (id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
      status TEXT NOT NULL, current_attempt_seq INTEGER NOT NULL);
    CREATE TABLE project_boundary_agent_executions (execution_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL, public_status TEXT NOT NULL, authority_version INTEGER NOT NULL);
    INSERT INTO actors VALUES ('human-1','human'), ('human-2','human'), ('author-1','human'),
      ('agent-1','agent');
    INSERT INTO sessions VALUES
      ('family-hash','account-1','human-1','access-hash',${now + 60_000},NULL),
      ('family-2','account-2','human-2','access-2',${now + 60_000},NULL);
    INSERT INTO rooms VALUES ('room-1','active');
    INSERT INTO room_memberships VALUES
      ('room-1','human-1','human'), ('room-1','human-2','human');
    INSERT INTO streams VALUES ('identity','human-1',0), ('identity','human-2',0);
  `);
  return database;
}

function fact() {
  return deriveNotificationProducerIntent({
    kind: "human_request", roomId: "room-1", roomLifecycle: "active", createdAt: occurredAt,
    recipientRelation: "target_pending", requestId: "request-1", requestRevision: 1,
    requestBoundaryOrdinal: 0, stableTargetHumanActorId: "human-1",
    targetMembership: "active", requestStatus: "pending_acceptance", actorId: "author-1",
  })!;
}

function toolResultFact() {
  return deriveNotificationProducerIntent({
    kind: "tool_result", roomId: "room-1", roomLifecycle: "active", createdAt: occurredAt,
    toolCallId: "tool-call-1", toolCallRevision: 2,
    exactRelatedHumanActorId: "human-1", relation: "invocation_source",
    resultState: "known_succeeded", actorId: null,
  })!;
}

function executionResultFact(
  kind: "agent_execution_completed" | "agent_execution_failed" = "agent_execution_completed",
) {
  return deriveNotificationProducerIntent({
    kind, roomId: "room-1", roomLifecycle: "active", createdAt: occurredAt,
    executionId: "execution-1", executionVersion: 2,
    sourceHumanRecipientActorId: "human-1", recipientRelation: "invocation_source",
    executionStatus: kind === "agent_execution_completed" ? "completed" : "failed",
    actorId: "agent-1",
  })!;
}

describe("FT-12 Notification AuthorityWorker database operation", () => {
  it("commits create/list/read receipt and stable identity event without ACK projection shortcut", () => {
    const database = fixture();
    try {
      expect(executeNotificationAuthorityOperation(database, {
        type: "notification.create", fact: fact(),
      })).toMatchObject({ kind: "created", projection: { readAt: null, handled: false } });
      expect(executeNotificationAuthorityOperation(database, {
        type: "notification.list", context, roomId: null, before: null, limit: 20, now,
      })).toMatchObject({ kind: "list", identityWatermark: 1, hasMore: false,
        roomBadges: [{ roomId: "room-1", unreadCount: 1, unhandledCount: 1 }],
        notifications: [{ notificationId: fact().notificationId }] });
      const operation = { type: "notification.mark-read" as const, context,
        commandRequestId: "command-1", notificationId: fact().notificationId,
        expectedReadRevision: 0, occurredAt, now };
      const first = executeNotificationAuthorityOperation(database, operation);
      const replay = executeNotificationAuthorityOperation(database, operation);
      expect(first).toMatchObject({ kind: "read", ack: { outcome: "read", readRevision: 1 } });
      expect(replay).toEqual(first);
      expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM notification_command_receipts").get())
        .toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it("returns zero cross-recipient metadata and disables writes for archived Rooms", () => {
    const database = fixture();
    try {
      executeNotificationAuthorityOperation(database, { type: "notification.create", fact: fact() });
      const other = { sessionId: "access-2", sessionFamilyId: "family-2",
        principal: { accountId: "account-2", actorId: "human-2" } };
      expect(executeNotificationAuthorityOperation(database, {
        type: "notification.list", context: other, roomId: null, before: null, limit: 20, now,
      })).toEqual({ kind: "list", notifications: [], hasMore: false,
        roomBadges: [], identityWatermark: 0 });
      database.prepare("UPDATE rooms SET status = 'archived' WHERE id = 'room-1'").run();
      expect(executeNotificationAuthorityOperation(database, {
        type: "notification.mark-read", context, commandRequestId: "command-2",
        notificationId: fact().notificationId, expectedReadRevision: 0, occurredAt, now,
      })).toEqual({ kind: "failure", code: "room_archived", status: 409 });
    } finally { database.close(); }
  });

  it("rechecks Room membership before dispatching a pending notification projection", () => {
    const database = fixture();
    try {
      executeNotificationAuthorityOperation(database, {
        type: "notification.create", fact: fact(),
      });
      const delivery = database.prepare(
        "SELECT id FROM outbox_deliveries WHERE target_kind = 'principal'",
      ).get();
      if (typeof delivery?.id !== "string") throw new Error("notification delivery missing");
      const candidate = {
        connectionId: "connection-1",
        ...context,
        credentialGeneration: 1,
      };
      expect(authorizeOutboxCandidateDatabaseQuery(
        database, delivery.id, candidate, now,
      )).toBe(true);

      database.prepare(
        "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
      ).run("room-1", "human-1");
      expect(authorizeOutboxCandidateDatabaseQuery(
        database, delivery.id, candidate, now,
      )).toBe(false);
    } finally { database.close(); }
  });

  it("acknowledges only a recipient-owned terminal known tool result", () => {
    const database = fixture();
    try {
      database.exec(`
        INSERT INTO tool_calls_v2 VALUES ('tool-call-1','room-1');
        INSERT INTO tool_dispatches_v2 VALUES ('dispatch-1','tool-call-1','outcome_unknown');
      `);
      executeNotificationAuthorityOperation(database, {
        type: "notification.create", fact: toolResultFact(),
      });
      const operation = {
        type: "notification.acknowledge-tool-result" as const,
        context,
        commandRequestId: "tool-result-ack-1",
        notificationId: toolResultFact().notificationId,
        occurredAt,
        now,
      };
      expect(executeNotificationAuthorityOperation(database, operation)).toEqual({
        kind: "failure", code: "revision_conflict", status: 409,
      });
      database.prepare(
        "UPDATE tool_dispatches_v2 SET state = 'known_succeeded' WHERE dispatch_id = 'dispatch-1'",
      ).run();
      const other = { sessionId: "access-2", sessionFamilyId: "family-2",
        principal: { accountId: "account-2", actorId: "human-2" } };
      expect(executeNotificationAuthorityOperation(database, {
        ...operation, context: other,
      })).toEqual({ kind: "failure", code: "forbidden", status: 403 });
      const first = executeNotificationAuthorityOperation(database, operation);
      expect(first).toMatchObject({ kind: "acknowledged", outcome: "acknowledged",
        projection: { handled: true, readAt: null } });
      expect(executeNotificationAuthorityOperation(database, operation)).toMatchObject({
        kind: "acknowledged", outcome: "already_acknowledged",
        projection: { handled: true, readAt: null },
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'notification.handled'",
      ).get()).toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it.each([
    ["agent_execution_completed", "completed"],
    ["agent_execution_failed", "failed"],
  ] as const)("acknowledges a recipient-owned current %s source once without marking it read",
    (kind, status) => {
      const database = fixture();
      try {
        if (kind === "agent_execution_completed") {
          database.prepare("INSERT INTO agent_executions VALUES (?, 'room-1', ?, 2)")
            .run("execution-1", status);
        } else {
          database.prepare(
            "INSERT INTO project_boundary_agent_executions VALUES (?, 'room-1', ?, 2)",
          ).run("execution-1", status);
        }
        const projection = executionResultFact(kind);
        executeNotificationAuthorityOperation(database, { type: "notification.create", fact: projection });
        const operation = { type: "notification.acknowledge-execution-result" as const,
          context, commandRequestId: `execution-${status}-ack-1`,
          notificationId: projection.notificationId, occurredAt, now };
        expect(executeNotificationAuthorityOperation(database, operation)).toMatchObject({
          kind: "acknowledged", outcome: "acknowledged",
          projection: { notificationKind: kind, handled: true, readAt: null, readRevision: 0 },
        });
        expect(executeNotificationAuthorityOperation(database, operation)).toMatchObject({
          kind: "acknowledged", outcome: "already_acknowledged",
          projection: { handled: true, readAt: null, readRevision: 0 },
        });
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM events WHERE event_type = 'notification.handled'",
        ).get()).toEqual({ count: 1 });
      } finally { database.close(); }
    });

  it("rejects cross-recipient, non-terminal, stale-revision, and missing execution sources", () => {
    const database = fixture();
    try {
      database.prepare("INSERT INTO agent_executions VALUES ('execution-1','room-1','running',1)").run();
      const projection = executionResultFact();
      executeNotificationAuthorityOperation(database, { type: "notification.create", fact: projection });
      const operation = { type: "notification.acknowledge-execution-result" as const,
        context, commandRequestId: "execution-ack-guard", notificationId: projection.notificationId,
        occurredAt, now };
      expect(executeNotificationAuthorityOperation(database, { ...operation,
        context: { ...context, sessionId: "missing-session" } })).toEqual({
        kind: "failure", code: "unauthenticated", status: 401,
      });
      expect(executeNotificationAuthorityOperation(database, operation)).toEqual({
        kind: "failure", code: "revision_conflict", status: 409,
      });
      database.prepare("UPDATE agent_executions SET status = 'completed' WHERE id = 'execution-1'").run();
      expect(executeNotificationAuthorityOperation(database, operation)).toEqual({
        kind: "failure", code: "revision_conflict", status: 409,
      });
      database.prepare("UPDATE agent_executions SET current_attempt_seq = 2 WHERE id = 'execution-1'").run();
      const other = { sessionId: "access-2", sessionFamilyId: "family-2",
        principal: { accountId: "account-2", actorId: "human-2" } };
      expect(executeNotificationAuthorityOperation(database, { ...operation, context: other }))
        .toEqual({ kind: "failure", code: "forbidden", status: 403 });
      database.prepare("DELETE FROM agent_executions WHERE id = 'execution-1'").run();
      expect(executeNotificationAuthorityOperation(database, operation)).toEqual({
        kind: "failure", code: "source_inaccessible", status: 410,
      });
    } finally { database.close(); }
  });

  it("revokes an inaccessible source atomically and returns 410", () => {
    const database = fixture();
    try {
      executeNotificationAuthorityOperation(database, {
        type: "notification.create", fact: toolResultFact(),
      });
      expect(executeNotificationAuthorityOperation(database, {
        type: "notification.resolve-source", context,
        notificationId: toolResultFact().notificationId, now,
      })).toEqual({ kind: "failure", code: "source_inaccessible", status: 410 });
      expect(database.prepare(
        "SELECT revoked_at AS revokedAt, revoke_reason AS revokeReason FROM notifications",
      ).get()).toEqual({
        revokedAt: occurredAt,
        revokeReason: "source_inaccessible",
      });
      expect(database.prepare(
        "SELECT event_type AS eventType FROM events WHERE event_type = 'notification.revoked'",
      ).get()).toEqual({ eventType: "notification.revoked" });
      expect(database.prepare(
        "SELECT target_kind AS targetKind, target_id AS targetId FROM outbox_deliveries",
      ).get()).toEqual({ targetKind: "principal", targetId: "human-1" });
    } finally { database.close(); }
  });
});
