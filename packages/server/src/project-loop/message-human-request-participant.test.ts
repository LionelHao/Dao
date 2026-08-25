import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import type { AuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import {
  HumanRequestMessageParticipantError,
  createSqliteHumanRequestMessageParticipant,
  isHumanRequestCompanionPayload,
  type HumanRequestMessageBinding,
} from "./message-human-request-participant.js";

const databases: DatabaseSync[] = [];
const at = "2026-08-25T02:03:04.005Z";
const binding: HumanRequestMessageBinding = Object.freeze({
  roomId: "room-1",
  projectId: "room-1",
  requestIntentId: "request-intent-1",
  sourceMessageId: "message-1",
  sourceRevision: 1,
  requesterHumanActorId: "human-requester",
  targetHumanActorId: "human-target",
  sourceTargetId: "target-1",
  occurredAt: at,
});
const frozenResponsibility = Object.freeze({
  kind: "open_question" as const,
  responsibilityId: `project-open-question-${createHash("sha256")
    .update("dao.ft09.human-request.v1\0room-1\0request-intent-1\0target-1").digest("hex")}`,
  title: "Answer the open question" as const,
  description: "Provide the answer needed to resolve the structured Human Request." as const,
  impact: "The Project Loop is waiting for this answer." as const,
  question: "What answer resolves this structured Human Request?" as const,
  owner: Object.freeze({ kind: "human" as const, actorId: "human-target" }),
  dueAt: null,
  reviewAt: null,
});
const frozenResponsibilityJson = JSON.stringify({
  description: frozenResponsibility.description,
  dueAt: null,
  impact: frozenResponsibility.impact,
  kind: frozenResponsibility.kind,
  owner: { actorId: "human-target", kind: "human" },
  question: frozenResponsibility.question,
  responsibilityId: frozenResponsibility.responsibilityId,
  reviewAt: null,
  title: frozenResponsibility.title,
});
const payload = Object.freeze({
  title: "Clarification requested" as const,
  description: "A structured Human Request is awaiting an answer." as const,
  acceptanceMode: "open_question" as const,
  frozenResponsibility,
  frozenResponsibilityJson,
  frozenResponsibilitySha256: createHash("sha256").update(frozenResponsibilityJson).digest("hex"),
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL) STRICT;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, archive_generation INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE streams (
      stream_kind TEXT NOT NULL, stream_id TEXT NOT NULL, head_seq INTEGER NOT NULL,
      retained_from_seq INTEGER NOT NULL, PRIMARY KEY(stream_kind, stream_id)
    ) STRICT;
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, stream_kind TEXT NOT NULL, stream_id TEXT NOT NULL,
      stream_seq INTEGER NOT NULL, room_id TEXT, authority_kind TEXT NOT NULL,
      actor_id TEXT,
      event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      UNIQUE(stream_kind, stream_id, stream_seq)
    ) STRICT;
    CREATE TABLE outbox_deliveries (
      id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL, target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL, stream_seq INTEGER NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL, available_at TEXT NOT NULL, delivered_at TEXT,
      last_error TEXT, PRIMARY KEY(event_id, target_kind, target_id)
    ) STRICT;
    CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, author_id TEXT NOT NULL) STRICT;
    CREATE TABLE message_envelopes (
      message_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, message_kind TEXT NOT NULL,
      lifecycle TEXT NOT NULL, current_revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE human_request_intents (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      target_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
      requester_human_actor_id TEXT NOT NULL, target_human_actor_id TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_requests (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, source_room_id TEXT NOT NULL,
      source_id TEXT NOT NULL, revision INTEGER NOT NULL,
      requester_human_actor_id TEXT NOT NULL, target_human_actor_id TEXT NOT NULL,
      status TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
      request_kind TEXT NOT NULL, linked_fact_kind TEXT, linked_fact_id TEXT,
      source_kind TEXT NOT NULL, created_by_actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source_revision INTEGER NOT NULL,
      visibility_room_id TEXT NOT NULL, source_request_intent_id TEXT,
      source_target_id TEXT, frozen_responsibility_json TEXT,
      frozen_responsibility_sha256 TEXT, resolution_actor_kind TEXT,
      resolution_actor_id TEXT, resolved_at TEXT,
      UNIQUE(room_id, source_request_intent_id)
    ) STRICT;
    CREATE TABLE project_room_states (
      room_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
      event_head_seq INTEGER NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_events (
      event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL, event_type TEXT NOT NULL, fact_kind TEXT NOT NULL,
      fact_id TEXT NOT NULL, fact_revision INTEGER NOT NULL, authority_kind TEXT NOT NULL,
      actor_kind TEXT, actor_id TEXT, causal_actor_kind TEXT NOT NULL,
      causal_actor_id TEXT NOT NULL, source_room_id TEXT NOT NULL, source_id TEXT NOT NULL,
      source_kind TEXT NOT NULL, source_revision INTEGER NOT NULL,
      source_visibility TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      UNIQUE(room_id, event_seq)
    ) STRICT;
    CREATE TABLE project_event_outbox (
      event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, event_seq INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL, dispatched_at TEXT
    ) STRICT;
    CREATE TABLE project_transition_audit (
      audit_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL, fact_kind TEXT NOT NULL, fact_id TEXT NOT NULL,
      authority_kind TEXT NOT NULL, actor_kind TEXT, actor_id TEXT,
      causal_actor_kind TEXT NOT NULL, causal_actor_id TEXT NOT NULL,
      transition_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL, UNIQUE(room_id, project_revision)
    ) STRICT;
    CREATE TABLE project_ball_boundaries (
      boundary_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL,
      source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
      lifecycle_generation INTEGER NOT NULL,
      holder_kind TEXT NOT NULL, holder_actor_id TEXT NOT NULL, reason TEXT NOT NULL,
      since TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL, released_at TEXT
    ) STRICT;
    CREATE TABLE project_transfer_chain (
      transfer_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, subject_revision INTEGER NOT NULL,
      from_owner_kind TEXT NOT NULL, from_owner_actor_id TEXT NOT NULL,
      to_owner_kind TEXT NOT NULL, to_owner_actor_id TEXT NOT NULL,
      accepted_by_human_actor_id TEXT NOT NULL, reason TEXT NOT NULL,
      transferred_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_fact_checkpoints (
      checkpoint_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT NOT NULL,
      project_revision INTEGER NOT NULL, projection_json TEXT NOT NULL,
      projection_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(room_id, project_revision)
    ) STRICT;
  `);
  db.prepare("INSERT INTO actors VALUES (?, 'human')").run(binding.requesterHumanActorId);
  db.prepare("INSERT INTO actors VALUES (?, 'human')").run(binding.targetHumanActorId);
  db.prepare("INSERT INTO actors VALUES ('human-next', 'human')").run();
  db.prepare("INSERT INTO rooms VALUES (?, 'active', 0)").run(binding.roomId);
  db.prepare("INSERT INTO streams VALUES ('room', ?, 0, 1)").run(binding.roomId);
  db.prepare("INSERT INTO messages VALUES (?, ?, ?)").run(
    binding.sourceMessageId, binding.roomId, binding.requesterHumanActorId,
  );
  db.prepare("INSERT INTO message_envelopes VALUES (?, ?, 'human', 'active', 1)").run(
    binding.sourceMessageId, binding.roomId,
  );
  db.prepare("INSERT INTO human_request_intents VALUES (?, ?, ?, ?, 1, ?, ?, 'pending')").run(
    binding.requestIntentId, binding.roomId, binding.sourceMessageId, binding.sourceTargetId,
    binding.requesterHumanActorId, binding.targetHumanActorId,
  );
  return db;
}

function checkpoint(database: DatabaseSync, roomId: string, revision: number, occurredAt: string): void {
  const projection = JSON.stringify({ roomId, projectId: roomId, revision });
  database.prepare(
    `INSERT INTO project_fact_checkpoints (
       checkpoint_id, room_id, project_id, project_revision, projection_json,
       projection_sha256, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`project-checkpoint:${roomId}:${revision}`, roomId, roomId, revision, projection,
    createHash("sha256").update(projection).digest("hex"), occurredAt);
}

function withTransaction<T>(
  db: DatabaseSync,
  operation: (transaction: AuthorityTransactionView) => T,
): T {
  db.exec("BEGIN IMMEDIATE");
  const transaction = mintDatabaseAuthorityTransactionView(db, binding.roomId, "message-submit-1");
  try {
    const result = operation(transaction);
    releaseDatabaseAuthorityTransactionView(transaction);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    releaseDatabaseAuthorityTransactionView(transaction);
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("FT-03 structured @Human to canonical Request transaction participant", () => {
  it("accepts only an explicit closed companion payload and has no body/actor spoof surface", () => {
    expect(isHumanRequestCompanionPayload(payload)).toBe(true);
    expect(isHumanRequestCompanionPayload({ ...payload, body: "@Human please infer this" })).toBe(false);
    expect(isHumanRequestCompanionPayload({ ...payload, requesterHumanActorId: "agent-spoof" })).toBe(false);
    expect(isHumanRequestCompanionPayload({ ...payload, acceptanceMode: "information" })).toBe(false);
    expect(isHumanRequestCompanionPayload({ ...payload, title: " " })).toBe(false);
    expect(payload).toEqual({
      title: "Clarification requested",
      description: "A structured Human Request is awaiting an answer.",
      acceptanceMode: "open_question",
      frozenResponsibility: {
        kind: "open_question",
        responsibilityId: expect.stringMatching(/^project-open-question-[a-f0-9]{64}$/),
        title: "Answer the open question",
        description: "Provide the answer needed to resolve the structured Human Request.",
        owner: { kind: "human", actorId: binding.targetHumanActorId },
        impact: "The Project Loop is waiting for this answer.",
        question: "What answer resolves this structured Human Request?",
        dueAt: null,
        reviewAt: null,
      },
      frozenResponsibilityJson: expect.stringMatching(/^\{/),
      frozenResponsibilitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(payload)).not.toContain("message body");
  });

  it("fails closed before writes when the required companion payload is unavailable", () => {
    const db = database();
    const participant = createSqliteHumanRequestMessageParticipant({
      resolveCompanionPayload: () => null,
      writeCheckpointInTransaction: checkpoint,
    });
    expect(() => withTransaction(db, (transaction) =>
      participant.createPendingInTransaction(transaction, binding),
    )).toThrowError(HumanRequestMessageParticipantError);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_requests").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_events").get()).toEqual({ count: 0 });
  });

  it("atomically binds one pending Request to intent/message revision/target and appends authority proof", () => {
    const db = database();
    const participant = createSqliteHumanRequestMessageParticipant({
      resolveCompanionPayload: (candidate) => candidate.requestIntentId === binding.requestIntentId
        ? payload : null,
      writeCheckpointInTransaction: checkpoint,
    });
    const result = withTransaction(db, (transaction) =>
      participant.createPendingInTransaction(transaction, binding),
    );
    expect(result).toMatchObject({ status: "created", requestId: expect.stringMatching(/\S/),
      eventId: expect.stringMatching(/^project-event-/), projectRevision: 1 });
    expect(db.prepare(
      `SELECT source_id AS sourceId, source_revision AS sourceRevision,
              source_request_intent_id AS requestIntentId, source_target_id AS sourceTargetId,
              requester_human_actor_id AS requester, target_human_actor_id AS target,
              status, request_kind AS requestKind, linked_fact_id AS linkedFactId
       FROM project_requests`,
    ).get()).toEqual({
      sourceId: binding.sourceMessageId, sourceRevision: 1,
      requestIntentId: binding.requestIntentId, sourceTargetId: binding.sourceTargetId,
      requester: binding.requesterHumanActorId, target: binding.targetHumanActorId,
      status: "pending_acceptance", requestKind: "open_question", linkedFactId: null,
    });
    expect(db.prepare(
      `SELECT holder_kind AS holderKind, holder_actor_id AS holderActorId, reason, status
       FROM project_ball_boundaries`,
    ).get()).toEqual({
      holderKind: "human", holderActorId: binding.requesterHumanActorId,
      reason: "pending_acceptance", status: "active",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_event_outbox").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_transition_audit").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_fact_checkpoints").get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT event_type AS eventType FROM events WHERE event_id = ?",
    ).get(result.eventId)).toEqual({ eventType: "project.request.changed" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get()).toEqual({ count: 1 });
  });

  it("replays the exact binding without duplicating request/event/outbox and rejects drift", () => {
    const db = database();
    const participant = createSqliteHumanRequestMessageParticipant({
      resolveCompanionPayload: () => payload,
      writeCheckpointInTransaction: checkpoint,
    });
    const first = withTransaction(db, (transaction) =>
      participant.createPendingInTransaction(transaction, binding));
    const replay = withTransaction(db, (transaction) =>
      participant.createPendingInTransaction(transaction, binding));
    expect(replay).toEqual({ ...first, status: "replayed" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_requests").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_events").get()).toEqual({ count: 1 });
    expect(() => withTransaction(db, (transaction) =>
      participant.createPendingInTransaction(transaction, {
        ...binding, targetHumanActorId: binding.requesterHumanActorId,
      }),
    )).toThrowError(HumanRequestMessageParticipantError);
  });

  it("observes AuthorityWorker ordering and rolls back all participant writes on later fault", () => {
    const db = database();
    const participant = createSqliteHumanRequestMessageParticipant({
      resolveCompanionPayload: () => payload,
      writeCheckpointInTransaction: checkpoint,
    });
    expect(() => withTransaction(db, (transaction) => {
      participant.createPendingInTransaction(transaction, binding);
      throw new Error("fault after Project Request");
    })).toThrow("fault after Project Request");
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_requests").get()).toEqual({ count: 0 });
    db.prepare("UPDATE message_envelopes SET lifecycle = 'recalled'").run();
    db.prepare("UPDATE human_request_intents SET status = 'cancelled'").run();
    expect(() => withTransaction(db, (transaction) =>
      participant.createPendingInTransaction(transaction, binding),
    )).toThrowError(HumanRequestMessageParticipantError);
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_requests").get()).toEqual({ count: 0 });
  });

  it("cancels a created pending Request and releases its requester Ball when recall wins next", () => {
    const db = database();
    const participant = createSqliteHumanRequestMessageParticipant({
      resolveCompanionPayload: () => payload,
      writeCheckpointInTransaction: checkpoint,
    });
    const created = withTransaction(db, (transaction) =>
      participant.createPendingInTransaction(transaction, binding),
    );
    db.prepare(
      `UPDATE project_requests
       SET target_human_actor_id = 'human-next', revision = 2
       WHERE id = ?`,
    ).run(created.requestId);
    db.prepare(
      `UPDATE project_ball_boundaries
       SET status = 'superseded', released_at = ? WHERE source_id = ?`,
    ).run("2026-08-25T02:03:04.500Z", created.requestId);
    db.prepare(
      `INSERT INTO project_ball_boundaries VALUES (
         'boundary-transfer', ?, ?, 'request', ?, 2, 0, 'human', ?, 'pending_acceptance',
         ?, NULL, 'active', NULL
       )`,
    ).run(binding.roomId, binding.roomId, created.requestId,
      binding.requesterHumanActorId, "2026-08-25T02:03:04.500Z");
    db.prepare(
      `INSERT INTO project_transfer_chain VALUES (
         'transfer-1', ?, ?, 'request', ?, 2, 'human', ?, 'human', 'human-next', ?,
         'A different Human should answer', ?
       )`,
    ).run(binding.roomId, binding.roomId, created.requestId,
      binding.targetHumanActorId, binding.targetHumanActorId,
      "2026-08-25T02:03:04.500Z");
    db.prepare("UPDATE human_request_intents SET status = 'cancelled'").run();
    const cancelled = withTransaction(db, (transaction) =>
      participant.cancelPendingForRecallInTransaction(transaction, {
        roomId: binding.roomId,
        sourceMessageId: binding.sourceMessageId,
        sourceRevision: binding.sourceRevision,
        recalledByHumanActorId: binding.requesterHumanActorId,
        occurredAt: "2026-08-25T02:03:05.006Z",
      }),
    );
    expect(cancelled).toEqual({
      roomId: binding.roomId,
      sourceMessageId: binding.sourceMessageId,
      cancelledRequestIds: [created.requestId],
      eventIds: [expect.stringMatching(/^project-event-/)],
    });
    expect(db.prepare(
      `SELECT status, revision, resolution_actor_id AS resolutionActorId,
              resolved_at AS resolvedAt FROM project_requests`,
    ).get()).toEqual({ status: "cancelled", revision: 3,
      resolutionActorId: binding.requesterHumanActorId,
      resolvedAt: "2026-08-25T02:03:05.006Z" });
    expect(db.prepare(
      `SELECT status, released_at AS releasedAt FROM project_ball_boundaries
       ORDER BY source_revision DESC LIMIT 1`,
    ).get()).toEqual({ status: "released", releasedAt: "2026-08-25T02:03:05.006Z" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_events").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_fact_checkpoints").get())
      .toEqual({ count: 2 });
    const shared = db.prepare(
      `SELECT payload_json AS payloadJson FROM events
       WHERE event_type = 'project.request.changed' ORDER BY stream_seq DESC LIMIT 1`,
    ).get();
    expect(typeof shared?.payloadJson === "string" ? JSON.parse(shared.payloadJson) : null)
      .toMatchObject({
        revision: 3,
        target: { actorId: "human-next", kind: "human" },
        transferChain: [{
          from: { actorId: binding.targetHumanActorId, kind: "human" },
          to: { actorId: "human-next", kind: "human" },
          initiatedBy: { actorId: binding.targetHumanActorId, kind: "human" },
          reason: "A different Human should answer",
        }],
      });
  });
});
