import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isProjectSnapshot } from "@native-im/core";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { listPendingOutboxDatabaseQuery } from "../persistence/authority-database-handler.js";
import type { JsonValue } from "../persistence/contracts.js";
import {
  advanceProjectLoopTimedTransitionsInTransaction,
  executeProjectLoopAuthorityOperation,
  claimDueProjectRemindersDatabaseCommand,
  ProjectLoopAuthorityError,
  readProjectLoopRepairSnapshotDatabaseQuery,
} from "./database-authority.js";
import type { ProjectLoopAuthorityOperation } from "./authority-protocol.js";
import {
  archiveProjectLoopBoundariesInTransaction,
  reopenProjectLoopBoundariesInTransaction,
} from "./boundary-authority.js";

const NOW = Date.parse("2026-08-25T08:00:00.000Z");

function humanContext(idempotencyKey: string, actorId = "human-owner") {
  return {
    kind: "human" as const,
    sessionId: "a".repeat(43),
    sessionFamilyId: "b".repeat(43),
    principal: { accountId: "account-owner", actorId },
    requestId: `request-${idempotencyKey}`,
    idempotencyKey,
  };
}

function agentContext(idempotencyKey: string) {
  return { kind: "agent" as const, agent: { kind: "agent" as const, actorId: "agent-member" },
    requestId: `agent-request-${idempotencyKey}`, idempotencyKey };
}

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-project-loop-authority-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    migrateAuthorityDatabase(database);
    database.exec(`
      INSERT INTO actors (id, kind, display_name) VALUES
        ('human-owner', 'human', 'Owner'),
        ('human-admin', 'human', 'Room Admin'),
        ('human-member', 'human', 'Member'),
        ('human-outsider', 'human', 'Outsider'),
        ('agent-member', 'agent', 'Agent');
      INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
        ('identity', 'human-owner', 0, 1), ('identity', 'human-admin', 0, 1),
        ('identity', 'human-member', 0, 1),
        ('identity', 'human-outsider', 0, 1), ('identity', 'agent-member', 0, 1),
        ('room', 'room-project', 0, 1), ('room', 'room-other', 0, 1);
      INSERT INTO rooms (id, name, status, created_at, owner_actor_id) VALUES
        ('room-project', 'Project', 'active', CURRENT_TIMESTAMP, 'human-owner'),
        ('room-other', 'Other', 'active', CURRENT_TIMESTAMP, 'human-owner');
      INSERT INTO room_memberships (
        room_id, actor_id, kind, role, participation, tool_permissions_json,
        joined_at, configured_at, access_revision
      ) VALUES
        ('room-project', 'human-owner', 'human', 'owner', NULL, '[]', CURRENT_TIMESTAMP, NULL, 1),
        ('room-project', 'human-admin', 'human', 'admin', NULL, '[]', CURRENT_TIMESTAMP, NULL, 1),
        ('room-project', 'human-member', 'human', 'member', NULL, '[]', CURRENT_TIMESTAMP, NULL, 1),
        ('room-project', 'agent-member', 'agent', NULL, 'active', '[]', NULL, CURRENT_TIMESTAMP, 1),
        ('room-other', 'human-owner', 'human', 'owner', NULL, '[]', CURRENT_TIMESTAMP, NULL, 1);
      INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at) VALUES
        ('message-1', 'room-project', 'human-owner', 'human', 'Source', '2026-08-25T07:00:00.000Z'),
        ('message-other', 'room-other', 'human-owner', 'human', 'Other', '2026-08-25T07:00:00.000Z');
      INSERT INTO message_revisions (message_id, revision, body, revised_at, revised_by_actor_id) VALUES
        ('message-1', 1, 'Source', '2026-08-25T07:00:00.000Z', 'human-owner'),
        ('message-other', 1, 'Other', '2026-08-25T07:00:00.000Z', 'human-owner');
      INSERT INTO message_envelopes (
        message_id, room_id, message_kind, lifecycle, current_revision, revision_count, created_at
      ) VALUES
        ('message-1', 'room-project', 'human', 'active', 1, 1, '2026-08-25T07:00:00.000Z'),
        ('message-other', 'room-other', 'human', 'active', 1, 1, '2026-08-25T07:00:00.000Z');
      INSERT INTO agent_profiles (
        id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json,
        display_name, global_responsibility, created_at, updated_at, source_kind
      ) VALUES (
        'profile-agent-member', 'agent-member', 1, 'enabled',
        '["room.project.read","room.respond"]', '[]', 'Project Agent',
        'Deliver Project work', '2026-08-25T07:00:00.000Z',
        '2026-08-25T07:00:00.000Z', 'administrator_command'
      );
      INSERT INTO room_agent_assignments (
        id, room_id, profile_id, agent_actor_id, revision, status, participation,
        paused, capability_subset_json, tool_subset_json, room_responsibility,
        created_at, updated_at, removed_at, source_kind
      ) VALUES (
        'assignment-agent-member', 'room-project', 'profile-agent-member', 'agent-member',
        1, 'current', 'active', 0, '["room.project.read","room.respond"]', '[]',
        'Deliver Project work', '2026-08-25T07:00:00.000Z',
        '2026-08-25T07:00:00.000Z', NULL, 'room_command'
      );
      INSERT INTO agent_profile_revisions (
        profile_id, revision, actor_id, display_name, global_responsibility, status,
        capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id, changed_at, operation
      ) SELECT id, revision, actor_id, display_name, global_responsibility, status,
          capability_ceiling_json, tool_ceiling_json, NULL, updated_at, 'static_bootstrap'
        FROM agent_profiles WHERE id = 'profile-agent-member';
      INSERT INTO room_agent_assignment_revisions (
        assignment_id, revision, room_id, profile_id, agent_actor_id, room_responsibility,
        status, participation, paused, capability_subset_json, tool_subset_json,
        changed_by_human_actor_id, changed_at, operation
      ) SELECT id, revision, room_id, profile_id, agent_actor_id, room_responsibility,
          status, participation, paused, capability_subset_json, tool_subset_json,
          NULL, updated_at, 'legacy_migration'
        FROM room_agent_assignments WHERE id = 'assignment-agent-member';
    `);
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function proposalCreate(idempotencyKey = "goal-propose"): ProjectLoopAuthorityOperation {
  return {
    type: "project-loop.proposal.create",
    context: humanContext(idempotencyKey),
    command: {
      proposalId: "proposal-goal",
      roomId: "room-project",
      projectId: "room-project",
      factKind: "goal",
      factId: "goal-primary",
      baseRevision: 0,
      principalActorId: "human-owner",
      expiresAt: "2026-08-26T08:00:00.000Z",
      payload: { title: "Ship FT-09", description: "Close the Project Loop" },
      source: { roomId: "room-project", sourceId: "message-1", sourceRevision: 1,
        visibility: "room", kind: "message" },
    },
    now: NOW,
  };
}

function createFactProposal(input: {
  proposalId: string; factKind: "decision" | "request" | "next_action" | "blocker" | "open_question";
  factId: string; baseRevision: number; payload: Record<string, JsonValue>;
  principalActorId?: string; actorId?: string;
}): ProjectLoopAuthorityOperation {
  return {
    type: "project-loop.proposal.create",
    context: humanContext(`create-${input.proposalId}`, input.actorId),
    command: {
      proposalId: input.proposalId, roomId: "room-project", projectId: "room-project",
      factKind: input.factKind, factId: input.factId, baseRevision: input.baseRevision,
      principalActorId: input.principalActorId ?? input.actorId ?? "human-owner",
      expiresAt: "2026-08-26T08:00:00.000Z", payload: input.payload,
      source: { roomId: "room-project", sourceId: "message-1",
        sourceRevision: 1, visibility: "room", kind: "message" },
    },
    now: NOW,
  };
}

function resolveFactProposal(proposalId: string, expectedRevision: number,
  resolution: "confirmed" | "rejected" = "confirmed"): ProjectLoopAuthorityOperation {
  return {
    type: "project-loop.proposal.resolve",
    context: humanContext(`resolve-${proposalId}`),
    command: { proposalId, roomId: "room-project", projectId: "room-project",
      expectedRevision, resolution, reason: resolution === "rejected" ? "Not approved" : null },
    now: NOW + expectedRevision,
  };
}

describe("Project Loop database authority", () => {
  it("reschedules every canonical business timer with Human reopen events and new Ball revisions", () => {
    withDatabase((database) => {
      const roomRevision = () => Number(database.prepare(
        "SELECT revision FROM project_room_states WHERE room_id = 'room-project'",
      ).get()?.revision ?? 0);
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "timer-action-proposal", factKind: "next_action", factId: "timer-action",
        baseRevision: roomRevision(), payload: { title: "Timed action", description: "Ship",
          ownerKind: "human", ownerActorId: "human-member", verifierHumanActorId: null,
          dueAt: "2026-08-27T08:00:00.000Z", deliverable: "Artifact", acceptanceCriteria: [] },
      }));
      executeProjectLoopAuthorityOperation(database, resolveFactProposal("timer-action-proposal", 1));
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition",
        context: humanContext("accept-timer-action", "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
          factId: "timer-action", expectedRevision: 1, transition: "next_action.accept",
          payload: {} }, now: NOW + 8,
      });
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition",
        context: humanContext("transfer-timer-action", "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
          factId: "timer-action", expectedRevision: 2, transition: "next_action.transfer_propose",
          payload: { transferProposalId: "timer-action-transfer", toOwnerKind: "human",
            toOwnerActorId: "human-owner", reason: "Coverage",
            expiresAt: "2026-08-30T08:00:00.000Z" } }, now: NOW + 9,
      });
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "timer-blocker-proposal", factKind: "blocker", factId: "timer-blocker",
        baseRevision: roomRevision(), payload: { title: "Timed blocker", description: "Wait",
          impact: "Risk", resolutionCriteria: "Clear", question: null,
          ownerKind: "human", ownerActorId: "human-member",
          dueAt: "2026-08-28T08:00:00.000Z", reviewAt: null },
      }));
      executeProjectLoopAuthorityOperation(database, resolveFactProposal("timer-blocker-proposal", 1));
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("transfer-timer-blocker", "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "blocker",
          factId: "timer-blocker", expectedRevision: 1, transition: "obstacle.transfer_propose",
          payload: { transferProposalId: "timer-transfer", toOwnerKind: "human",
            toOwnerActorId: "human-owner", reason: "Coverage stale revision",
            expiresAt: "2026-08-30T08:00:00.000Z" } }, now: NOW + 10,
      });
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("escalate-timer-blocker", "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "blocker",
          factId: "timer-blocker", expectedRevision: 1, transition: "obstacle.cannot_answer",
          payload: { reason: "Escalate while transfer remains stale" } }, now: NOW + 11,
      });
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "timer-review-proposal", factKind: "blocker", factId: "timer-review",
        baseRevision: roomRevision(), payload: { title: "Review blocker", description: "Wait",
          impact: "Risk", resolutionCriteria: "Clear", question: null,
          ownerKind: "human", ownerActorId: "human-member",
          dueAt: "2026-08-28T08:00:00.000Z", reviewAt: null },
      }));
      executeProjectLoopAuthorityOperation(database, resolveFactProposal("timer-review-proposal", 1));
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("defer-timer-review", "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "blocker",
          factId: "timer-review", expectedRevision: 1, transition: "obstacle.defer",
          payload: { reason: "Wait", reviewAt: "2026-08-29T08:00:00.000Z" } }, now: NOW + 11,
      });
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition",
        context: humanContext("transfer-deferred-timer-review", "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "blocker",
          factId: "timer-review", expectedRevision: 2, transition: "obstacle.transfer_propose",
          payload: { transferProposalId: "timer-review-current-transfer", toOwnerKind: "human",
            toOwnerActorId: "human-owner", reason: "Coverage current deferred revision",
            expiresAt: "2026-08-30T08:00:00.000Z" } }, now: NOW + 12,
      });
      const before = roomRevision();
      database.prepare("UPDATE rooms SET status = 'archived', archive_generation = 1 WHERE id = 'room-project'").run();
      archiveProjectLoopBoundariesInTransaction(database, { roomId: "room-project",
        actorId: "human-owner", archiveGeneration: 1, previousLifecycleGeneration: 0,
        occurredAt: "2026-08-25T08:00:00.000Z" });
      database.prepare("UPDATE rooms SET status = 'active' WHERE id = 'room-project'").run();
      reopenProjectLoopBoundariesInTransaction(database, { roomId: "room-project",
        actorId: "human-owner", archiveGeneration: 1, previousLifecycleGeneration: 1,
        occurredAt: "2026-09-25T08:00:00.000Z" });
      expect(database.prepare(
        "SELECT revision, due_at AS dueAt FROM project_next_actions WHERE id = 'timer-action'",
      ).get()).toEqual({ revision: 3, dueAt: "2026-09-27T08:00:00.000Z" });
      expect(database.prepare(
        `SELECT revision, due_at AS dueAt, review_at AS reviewAt
         FROM project_obstacles WHERE id = 'timer-review'`,
      ).get()).toEqual({ revision: 3, dueAt: "2026-09-28T08:00:00.000Z",
        reviewAt: "2026-09-29T08:00:00.000Z" });
      expect(database.prepare(
        `SELECT id, revision, subject_revision AS subjectRevision, expires_at AS expiresAt
         FROM project_transfer_proposals WHERE id IN (
           'timer-action-transfer','timer-review-current-transfer','timer-transfer'
         )
         ORDER BY id`,
      ).all()).toEqual([
        { id: "timer-action-transfer", revision: 2, subjectRevision: 3,
          expiresAt: "2026-09-30T08:00:00.000Z" },
        { id: "timer-review-current-transfer", revision: 2, subjectRevision: 3,
          expiresAt: "2026-09-30T08:00:00.000Z" },
        { id: "timer-transfer", revision: 2, subjectRevision: 1,
          expiresAt: "2026-09-30T08:00:00.000Z" },
      ]);
      expect(roomRevision()).toBe(before + 6);
      expect(database.prepare(
        `SELECT authority_kind AS authorityKind, actor_id AS actorId, event_type AS type
         FROM project_events WHERE event_seq > ? ORDER BY event_seq`,
      ).all(before)).toEqual([
        { authorityKind: "human", actorId: "human-owner", type: "fact.transitioned" },
        { authorityKind: "human", actorId: "human-owner", type: "fact.transitioned" },
        { authorityKind: "human", actorId: "human-owner", type: "fact.transitioned" },
        { authorityKind: "human", actorId: "human-owner", type: "fact.transitioned" },
        { authorityKind: "human", actorId: "human-owner", type: "fact.transitioned" },
        { authorityKind: "human", actorId: "human-owner", type: "fact.transitioned" },
      ]);
      expect(database.prepare(
        `SELECT event_type AS type, json_extract(payload_json, '$.revision') AS revision
         FROM events WHERE event_id IN (
           SELECT event_id FROM project_events WHERE event_seq > ?
         ) ORDER BY stream_seq`,
      ).all(before)).toEqual([
        { type: "project.next-action.changed", revision: 3 },
        { type: "project.blocker.changed", revision: 3 },
        { type: "project.blocker.changed", revision: 3 },
        { type: "project.transfer-proposal.changed", revision: 2 },
        { type: "project.transfer-proposal.changed", revision: 2 },
        { type: "project.transfer-proposal.changed", revision: 2 },
      ]);
      expect(database.prepare(
        `SELECT source_kind AS kind, source_revision AS revision FROM project_ball_boundaries
         WHERE status = 'active' AND source_id IN (
           'timer-action','timer-action-transfer','timer-blocker','timer-review',
           'timer-review-current-transfer','timer-transfer'
         ) ORDER BY source_kind, source_id`,
      ).all()).toEqual([
        { kind: "blocker", revision: 3 },
        { kind: "next_action", revision: 3 },
        { kind: "review", revision: 3 },
        { kind: "transfer", revision: 2 },
        { kind: "transfer", revision: 2 },
        { kind: "transfer", revision: 2 },
      ]);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM project_fact_checkpoints WHERE room_id = 'room-project' AND project_revision = ?",
      ).get(before + 6)).toEqual({ count: 1 });
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("accept-reopened-action-transfer"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
          factId: "timer-action", expectedRevision: 3,
          transition: "next_action.transfer_accept",
          payload: { transferProposalId: "timer-action-transfer" } }, now: NOW + 12,
      });
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("accept-reopened-review-transfer"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "blocker",
          factId: "timer-review", expectedRevision: 3,
          transition: "obstacle.transfer_accept",
          payload: { transferProposalId: "timer-review-current-transfer" } }, now: NOW + 13,
      });
      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("reject-stale-reopened-transfer"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "blocker",
          factId: "timer-blocker", expectedRevision: 3,
          transition: "obstacle.transfer_accept",
          payload: { transferProposalId: "timer-transfer" } }, now: NOW + 14,
      })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
      expect(database.prepare(
        `SELECT id, status FROM project_transfer_proposals
         WHERE id IN (
           'timer-action-transfer','timer-review-current-transfer','timer-transfer'
         ) ORDER BY id`,
      ).all()).toEqual([
        { id: "timer-action-transfer", status: "accepted" },
        { id: "timer-review-current-transfer", status: "accepted" },
        { id: "timer-transfer", status: "pending" },
      ]);
    });
  });

  it("creates and confirms a proposal atomically, with replay-safe receipts", () => {
    withDatabase((database) => {
      const proposed = executeProjectLoopAuthorityOperation(database, proposalCreate());
      expect(proposed).toMatchObject({
        kind: "project-loop-mutation",
        roomId: "room-project",
        projectId: "room-project",
        acceptedRevision: 1,
        replayed: false,
      });
      const replayed = executeProjectLoopAuthorityOperation(database, proposalCreate());
      expect(replayed).toEqual({ ...proposed, replayed: true });
      expect(readProjectLoopRepairSnapshotDatabaseQuery(database, {
        roomId: "room-project", projectId: "room-project", watermark: 1,
        afterEventSeq: 0, limit: 50,
      }).confirmations).toEqual([expect.objectContaining({
        confirmationId: "confirmation:proposal-goal", proposalId: "proposal-goal",
        revision: 1, state: "pending", resolvedBy: null, resolvedAt: null,
      })]);

      const confirmed = executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.resolve",
        context: humanContext("goal-confirm"),
        command: {
          proposalId: "proposal-goal",
          roomId: "room-project",
          projectId: "room-project",
          expectedRevision: 1,
          resolution: "confirmed",
          reason: null,
        },
        now: NOW + 1,
      });
      expect(confirmed).toMatchObject({
        kind: "project-loop-mutation",
        acceptedRevision: 2,
        replayed: false,
      });
      expect(readProjectLoopRepairSnapshotDatabaseQuery(database, {
        roomId: "room-project", projectId: "room-project", watermark: 2,
        afterEventSeq: 0, limit: 50,
      }).confirmations).toEqual([expect.objectContaining({
        confirmationId: "confirmation:proposal-goal", proposalId: "proposal-goal",
        revision: 2, state: "confirmed", resolvedBy: { kind: "human", actorId: "human-owner" },
      })]);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM project_goals WHERE status = 'active'",
      ).get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM project_events").get())
        .toEqual({ count: 2 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type LIKE 'project.%'",
      ).get()).toEqual({ count: 2 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_deliveries AS delivery
         JOIN events AS event ON event.event_id = delivery.event_id
         WHERE event.event_type LIKE 'project.%' AND delivery.status = 'pending'`,
      ).get()).toEqual({ count: 2 });
    });
  });

  it("rejects stale, cross-room, outsider and idempotency-conflicting mutations", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, proposalCreate());
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("stale"),
        command: { ...proposalCreate().command, proposalId: "proposal-stale", baseRevision: 99 },
      })).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("cross-room"),
        command: { ...proposalCreate().command, projectId: "room-other" },
      })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("outsider"),
        context: humanContext("outsider", "human-outsider"),
      })).toThrowError(expect.objectContaining({ code: "room_forbidden" }));
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate(),
        command: { ...proposalCreate().command, factId: "different-goal" },
      })).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
    });
  });

  it("resolves provenance and target authority instead of trusting public locators", () => {
    withDatabase((database) => {
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("missing-source"), command: { ...proposalCreate().command,
          proposalId: "missing-source", source: { ...proposalCreate().command.source,
            sourceId: "message-missing" } },
      })).toThrowError(expect.objectContaining({ code: "project_fact_not_found" }));
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("stale-source"), command: { ...proposalCreate().command,
          proposalId: "stale-source", source: { ...proposalCreate().command.source,
            sourceRevision: 2 } },
      })).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("cross-room-source"), command: { ...proposalCreate().command,
          proposalId: "cross-room-source", source: { ...proposalCreate().command.source,
            sourceId: "message-other" } },
      })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
      expect(() => executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "spoof-agent-kind", factKind: "next_action", factId: "spoof-action",
        baseRevision: 0, payload: { title: "Spoof", description: "Wrong kind",
          ownerKind: "agent", ownerActorId: "human-member", verifierHumanActorId: "human-owner",
          dueAt: null, deliverable: "Spoofed delivery", acceptanceCriteria: [] },
      }))).not.toThrow();
      expect(() => executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("spoof-agent-kind", 1)))
        .toThrowError(expect.objectContaining({ code: "invalid_request" }));
    });
  });

  it("resolves by proposal revision and revalidates the pinned source at confirmation", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, proposalCreate());
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "unrelated-decision", factKind: "decision", factId: "decision-unrelated",
        baseRevision: 1, payload: { title: "Unrelated", rationale: "Advance the Project head",
          statement: "Keep the source fence", supersedesDecisionId: null, affectedFactIds: [] },
      }));
      expect(() => executeProjectLoopAuthorityOperation(database, resolveFactProposal("proposal-goal", 1)))
        .not.toThrow();
    });
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, proposalCreate());
      database.prepare(
        `INSERT INTO message_revisions (message_id, revision, body, revised_at, revised_by_actor_id)
         VALUES ('message-1', 2, 'Revised source', '2026-08-25T07:30:00.000Z', 'human-owner')`,
      ).run();
      database.prepare(
        "UPDATE message_envelopes SET current_revision = 2, revision_count = 2 WHERE message_id = 'message-1'",
      ).run();
      expect(() => executeProjectLoopAuthorityOperation(database, resolveFactProposal("proposal-goal", 1)))
        .toThrowError(expect.objectContaining({ code: "revision_conflict" }));
      expect(database.prepare("SELECT COUNT(*) AS count FROM project_goals").get()).toEqual({ count: 0 });
    });
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, proposalCreate());
      database.prepare(
        `INSERT INTO message_recall_fences (
           fence_id, room_id, source_message_id, source_revision, scope_kind,
           invocation_intent_id, execution_id, reason, created_at
         ) VALUES (
           'recall-fence-project-source', 'room-project', 'message-1', 1, 'message',
           NULL, NULL, 'message_recalled', '2026-08-25T07:30:00.000Z'
         )`,
      ).run();
      database.prepare(
        `UPDATE message_envelopes SET lifecycle = 'recalled',
           recalled_at = '2026-08-25T07:30:00.000Z', recalled_by_actor_id = 'human-owner'
         WHERE message_id = 'message-1'`,
      ).run();
      expect(() => executeProjectLoopAuthorityOperation(database, resolveFactProposal("proposal-goal", 1)))
        .toThrowError(expect.objectContaining({ code: "invalid_transition" }));
      expect(database.prepare("SELECT COUNT(*) AS count FROM project_goals").get()).toEqual({ count: 0 });
    });
  });

  it("enforces one active goal, immutable confirmed decisions, and legal transitions", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, proposalCreate());
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.resolve",
        context: humanContext("goal-confirm"),
        command: { proposalId: "proposal-goal", roomId: "room-project", projectId: "room-project",
          expectedRevision: 1, resolution: "confirmed", reason: null },
        now: NOW + 1,
      });
      executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("member-replacement"),
        context: humanContext("member-replacement", "human-member"),
        command: { ...proposalCreate().command, proposalId: "proposal-member-replacement",
          factId: "goal-member-replacement", baseRevision: 2,
          principalActorId: "human-member",
          payload: { ...proposalCreate().command.payload, supersedesGoalId: "goal-primary",
            reason: "Member cannot authorize this replacement." } },
      });
      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.resolve",
        context: humanContext("member-replacement-confirm", "human-member"),
        command: { proposalId: "proposal-member-replacement", roomId: "room-project",
          projectId: "room-project", expectedRevision: 1, resolution: "confirmed", reason: null },
        now: NOW + 2,
      })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
      executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("second-goal"),
        command: { ...proposalCreate().command, proposalId: "proposal-second",
          factId: "goal-second", baseRevision: 3 },
      });
      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.resolve",
        context: humanContext("second-confirm"),
        command: { proposalId: "proposal-second", roomId: "room-project",
          projectId: "room-project", expectedRevision: 4, resolution: "confirmed", reason: null },
        now: NOW + 2,
      })).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition",
        context: humanContext("illegal-transition"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "goal",
          factId: "goal-primary", expectedRevision: 1,
          transition: "next_action.complete", payload: {} },
        now: NOW + 3,
      })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    });
  });

  it("returns a stable bounded snapshot after restart and fails closed on corrupt rows", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, proposalCreate());
      const snapshot = executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.snapshot.read",
        context: humanContext("read"),
        roomId: "room-project",
        projectId: "room-project",
        afterEventSeq: 0,
        limit: 50,
        now: NOW,
      });
      expect(snapshot).toMatchObject({
        kind: "project-loop-snapshot",
        snapshot: { roomId: "room-project", projectId: "room-project", watermark: 1 },
        nextEventSeq: 1,
      });
      expect(snapshot.kind === "project-loop-snapshot" && isProjectSnapshot(snapshot.snapshot)).toBe(true);
      database.prepare(
        "UPDATE streams SET head_seq = 2 WHERE stream_kind = 'room' AND stream_id = 'room-project'",
      ).run();
      const repaired = readProjectLoopRepairSnapshotDatabaseQuery(database, {
        roomId: "room-project", projectId: "room-project", watermark: 2,
        afterEventSeq: 0, limit: 50,
      });
      expect(repaired.watermark).toBe(2);
      expect(isProjectSnapshot(repaired)).toBe(true);
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.prepare(
        "UPDATE project_fact_proposals SET payload_json = 'corrupt' WHERE id = 'proposal-goal'",
      ).run();
      database.exec("PRAGMA ignore_check_constraints = OFF");
      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.snapshot.read",
        context: humanContext("read-corrupt"),
        roomId: "room-project",
        projectId: "room-project",
        afterEventSeq: 0,
        limit: 50,
        now: NOW,
      })).toThrowError(ProjectLoopAuthorityError);
    });
  });

  it("persists the exact immutable reason on both sides of a Goal replacement", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, proposalCreate());
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.resolve", context: humanContext("goal-initial-confirm"),
        command: { proposalId: "proposal-goal", roomId: "room-project",
          projectId: "room-project", expectedRevision: 1, resolution: "confirmed", reason: null },
        now: NOW + 1,
      });
      executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("goal-replacement-propose"),
        command: { ...proposalCreate().command, proposalId: "proposal-goal-replacement",
          factId: "goal-replacement", baseRevision: 2,
          payload: { title: "Ship the corrected scope", description: "Replacement Goal",
            supersedesGoalId: "goal-primary", reason: "The approved scope changed after review." } },
      });
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.resolve", context: humanContext("goal-replacement-confirm"),
        command: { proposalId: "proposal-goal-replacement", roomId: "room-project",
          projectId: "room-project", expectedRevision: 1, resolution: "confirmed", reason: null },
        now: NOW + 3,
      });
      expect(database.prepare(
        `SELECT id, supersede_reason AS reason FROM project_goals ORDER BY id`,
      ).all()).toEqual([
        { id: "goal-primary", reason: "The approved scope changed after review." },
        { id: "goal-replacement", reason: "The approved scope changed after review." },
      ]);
      const snapshot = readProjectLoopRepairSnapshotDatabaseQuery(database, {
        roomId: "room-project", projectId: "room-project", watermark: 4,
        afterEventSeq: 0, limit: 50,
      });
      expect(snapshot.goals.map((goal) => goal.supersedeReason))
        .toEqual(["The approved scope changed after review.",
          "The approved scope changed after review."]);
    });
  });

  it("claims due ordinal zero and each 24-hour bucket exactly once across recovery", () => {
    withDatabase((database) => {
      database.prepare(
        `INSERT INTO project_ball_boundaries (
           boundary_id, room_id, project_id, source_kind, source_id, source_revision,
           holder_kind, holder_actor_id, reason, since, due_at, status
         ) VALUES ('boundary-due', 'room-project', 'room-project', 'next_action',
                   'action-due', 3, 'human', 'human-member', 'Action is due', ?, ?, 'active')`,
      ).run(new Date(NOW - 60_000).toISOString(), new Date(NOW).toISOString());
      expect(claimDueProjectRemindersDatabaseCommand(database, {
        roomId: "room-project", now: NOW, limit: 10,
      })).toMatchObject([{ reminderOrdinal: 0, reminderKind: "initial_due",
        recipientActorId: "human-member" }]);
      expect(claimDueProjectRemindersDatabaseCommand(database, {
        roomId: "room-project", now: NOW, limit: 10,
      })).toEqual([]);
      expect(claimDueProjectRemindersDatabaseCommand(database, {
        roomId: "room-project", now: NOW + 24 * 60 * 60 * 1_000, limit: 10,
      })).toMatchObject([{ reminderOrdinal: 1, reminderKind: "repeat_24h" }]);
      expect(database.prepare(
        "SELECT reminder_ordinal AS ordinal FROM project_due_reminder_claims ORDER BY ordinal",
      ).all()).toEqual([{ ordinal: 0 }, { ordinal: 1 }]);
    });
  });

  it("rejects and supersedes Decisions without mutating confirmed history", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "decision-rejected-proposal", factKind: "decision",
        factId: "decision-rejected", baseRevision: 0,
        payload: { title: "Do not ship", rationale: "Rejected option" },
      }));
      executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("decision-rejected-proposal", 1, "rejected"));
      expect(database.prepare("SELECT COUNT(*) AS count FROM project_decisions").get())
        .toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT proposal.resolution_reason AS proposalReason,
                confirmation.resolution_reason AS confirmationReason
         FROM project_fact_proposals AS proposal
         JOIN project_confirmations AS confirmation ON confirmation.proposal_id = proposal.id
         WHERE proposal.id = 'decision-rejected-proposal'`,
      ).get()).toEqual({ proposalReason: "Not approved", confirmationReason: "Not approved" });

      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "decision-one-proposal", factKind: "decision", factId: "decision-one",
        baseRevision: 2, payload: { title: "Ship A", rationale: "First confirmed choice" },
      }));
      executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("decision-one-proposal", 1));
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "decision-two-proposal", factKind: "decision", factId: "decision-two",
        baseRevision: 4, payload: { title: "Ship B", rationale: "Superseding choice",
          supersedesDecisionId: "decision-one" },
      }));
      executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("decision-two-proposal", 1));

      expect(database.prepare(
        `SELECT id, status, revision, superseded_by_decision_id AS supersededBy
         FROM project_decisions ORDER BY id`,
      ).all()).toEqual([
        { id: "decision-one", status: "superseded", revision: 2, supersededBy: "decision-two" },
        { id: "decision-two", status: "confirmed", revision: 1, supersededBy: null },
      ]);
    });
  });

  it("allows only the Room owner/admin to supersede a Goal or Decision", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, proposalCreate());
      executeProjectLoopAuthorityOperation(database, resolveFactProposal("proposal-goal", 1));
      executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("member-goal-replacement"),
        context: humanContext("member-goal-replacement", "human-member"),
        command: { ...proposalCreate().command, proposalId: "proposal-member-goal",
          factId: "goal-member", baseRevision: 2, principalActorId: "human-member",
          payload: { title: "Member Goal", description: "No governance authority",
            supersedesGoalId: "goal-primary", reason: "Ordinary member attempted replacement" } },
      });
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...resolveFactProposal("proposal-member-goal", 1),
        context: humanContext("member-cannot-supersede-goal", "human-member"),
      })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
      executeProjectLoopAuthorityOperation(database, {
        ...resolveFactProposal("proposal-member-goal", 1, "rejected"),
        context: humanContext("member-rejects-goal", "human-member"),
      });
      executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("admin-goal-replacement"),
        context: humanContext("admin-goal-replacement", "human-admin"),
        command: { ...proposalCreate().command, proposalId: "proposal-admin-goal",
          factId: "goal-admin", baseRevision: 4, principalActorId: "human-admin",
          payload: { title: "Admin Goal", description: "Room governance",
            supersedesGoalId: "goal-primary", reason: "Room Admin selected the replacement" } },
      });
      executeProjectLoopAuthorityOperation(database, {
        ...resolveFactProposal("proposal-admin-goal", 1),
        context: humanContext("admin-can-supersede-goal", "human-admin"),
      });

      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "decision-governance-one", factKind: "decision", factId: "decision-governance-one",
        baseRevision: 6, payload: { title: "Choice A", rationale: "Initial choice" },
      }));
      executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("decision-governance-one", 1));
      executeProjectLoopAuthorityOperation(database, {
        ...createFactProposal({ proposalId: "decision-governance-two", factKind: "decision",
          factId: "decision-governance-member", baseRevision: 8,
          payload: { title: "Choice B", rationale: "Replacement choice",
            supersedesDecisionId: "decision-governance-one" } }),
        context: humanContext("member-proposes-decision-replacement", "human-member"),
        command: { ...createFactProposal({ proposalId: "decision-governance-two", factKind: "decision",
          factId: "decision-governance-member", baseRevision: 8,
          payload: { title: "Choice B", rationale: "Replacement choice",
            supersedesDecisionId: "decision-governance-one" } }).command,
          principalActorId: "human-member" },
      });
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...resolveFactProposal("decision-governance-two", 1),
        context: humanContext("member-cannot-supersede-decision", "human-member"),
      })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
      executeProjectLoopAuthorityOperation(database, {
        ...resolveFactProposal("decision-governance-two", 1, "rejected"),
        context: humanContext("member-rejects-decision", "human-member"),
      });
      executeProjectLoopAuthorityOperation(database, {
        ...createFactProposal({ proposalId: "decision-governance-admin", factKind: "decision",
          factId: "decision-governance-two", baseRevision: 10,
          payload: { title: "Choice B", rationale: "Replacement choice",
            supersedesDecisionId: "decision-governance-one" } }),
        context: humanContext("admin-proposes-decision-replacement", "human-admin"),
        command: { ...createFactProposal({ proposalId: "decision-governance-admin", factKind: "decision",
          factId: "decision-governance-two", baseRevision: 10,
          payload: { title: "Choice B", rationale: "Replacement choice",
            supersedesDecisionId: "decision-governance-one" } }).command,
          principalActorId: "human-admin" },
      });
      executeProjectLoopAuthorityOperation(database, {
        ...resolveFactProposal("decision-governance-admin", 1),
        context: humanContext("admin-can-supersede-decision", "human-admin"),
      });
      expect(database.prepare(
        "SELECT status FROM project_decisions WHERE id = 'decision-governance-two'",
      ).get()).toEqual({ status: "confirmed" });
    });
  });

  it("limits Agent proposals and mutations to a fully eligible Project assignment", () => {
    withDatabase((database) => {
      const agentGoal = {
        ...proposalCreate("agent-goal"), context: agentContext("agent-goal"),
        command: { ...proposalCreate().command, proposalId: "proposal-agent-goal",
          factId: "goal-agent", principalActorId: "human-owner" },
      } satisfies ProjectLoopAuthorityOperation;
      executeProjectLoopAuthorityOperation(database, agentGoal);

      const agentRequest = {
        ...createFactProposal({ proposalId: "agent-request", factKind: "request",
          factId: "request-agent", baseRevision: 1,
          payload: { title: "No", description: "Agents cannot create Requests",
            targetHumanActorId: "human-member", acceptanceMode: "open_question",
            linkedFactKind: null, linkedFactId: null,
            responsibility: { kind: "open_question", responsibilityId: "question-agent",
              title: "No", description: "No", owner: { kind: "human", actorId: "human-member" },
              dueAt: null, impact: "No", question: "No" } } }),
        context: agentContext("agent-request"),
        command: { ...createFactProposal({ proposalId: "agent-request", factKind: "request",
          factId: "request-agent", baseRevision: 1,
          payload: { title: "No", description: "Agents cannot create Requests",
            targetHumanActorId: "human-member", acceptanceMode: "open_question",
            linkedFactKind: null, linkedFactId: null,
            responsibility: { kind: "open_question", responsibilityId: "question-agent",
              title: "No", description: "No", owner: { kind: "human", actorId: "human-member" },
              dueAt: null, impact: "No", question: "No" } } }).command,
          principalActorId: "human-owner" },
      } satisfies ProjectLoopAuthorityOperation;
      expect(() => executeProjectLoopAuthorityOperation(database, agentRequest))
        .toThrowError(expect.objectContaining({ code: "permission_denied" }));

      database.prepare(
        "UPDATE room_agent_assignments SET participation = 'on-mention', revision = revision + 1 WHERE id = 'assignment-agent-member'",
      ).run();
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...agentGoal, context: agentContext("agent-ineligible"),
        command: { ...agentGoal.command, proposalId: "proposal-agent-ineligible",
          factId: "goal-agent-ineligible", baseRevision: 1 },
      })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
    });
  });

  it("lets the target respond, permits governance transfer only, and creates one linked responsibility atomically", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "request-proposal", factKind: "request", factId: "request-one",
        baseRevision: 0, payload: { title: "Take this", description: "Please deliver",
          targetHumanActorId: "human-member", acceptanceMode: "next_action",
          linkedFactKind: null, linkedFactId: null,
          responsibility: { kind: "next_action", responsibilityId: "action-from-request",
            title: "Deliver it", description: "Atomic responsibility",
            owner: { kind: "human", actorId: "human-member" }, dueAt: null,
            deliverable: "Evidence bundle",
            acceptanceCriteria: [{ criterionId: "criterion-action-from-request-1",
              text: "Evidence attached" }], verifier: null } },
      }));
      executeProjectLoopAuthorityOperation(database, resolveFactProposal("request-proposal", 1));
      expect(database.prepare(
        `SELECT holder_actor_id AS holder, reason FROM project_ball_boundaries
         WHERE source_kind = 'request' AND status = 'active'`,
      ).get()).toEqual({ holder: "human-owner", reason: "pending_acceptance" });
      database.exec(`
        INSERT INTO actors (id, kind, display_name) VALUES ('human-peer', 'human', 'Peer');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'human-peer', 0, 1);
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES (
          'room-project', 'human-peer', 'human', 'member', NULL, '[]',
          CURRENT_TIMESTAMP, NULL, 1
        );
      `);

      const transfer = {
        type: "project-loop.fact.transition" as const,
        context: humanContext("request-transfer", "human-owner"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "request" as const,
          factId: "request-one", expectedRevision: 1,
          transition: "request.transfer" as const,
          payload: { reason: "Owner will take it", targetHumanActorId: "human-owner" } },
        now: NOW + 2,
      };
      expect(() => executeProjectLoopAuthorityOperation(database, {
        ...transfer, context: humanContext("request-member-transfer", "human-peer"),
      })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
      const transferred = executeProjectLoopAuthorityOperation(database, transfer);
      expect(transferred).toMatchObject({ acceptedRevision: 3,
      });
      expect(database.prepare(
        "SELECT revision, status, target_human_actor_id AS target FROM project_requests WHERE id = 'request-one'",
      ).get()).toEqual({ revision: 2, status: "pending_acceptance", target: "human-owner" });

      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition",
        context: humanContext("request-admin-reject", "human-admin"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "request",
          factId: "request-one", expectedRevision: 2, transition: "request.reject",
          payload: { reason: "Governance cannot reject for the target" } },
        now: NOW + 3,
      })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
      const adminTransferred = executeProjectLoopAuthorityOperation(database, {
        ...transfer,
        context: humanContext("request-admin-transfer", "human-admin"),
        command: { ...transfer.command, expectedRevision: 2,
          payload: { reason: "Governance handoff", targetHumanActorId: "human-member" } },
        now: NOW + 4,
      });
      expect(adminTransferred).toMatchObject({ acceptedRevision: 4 });

      const accepted = executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition",
        context: humanContext("request-accept", "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "request",
          factId: "request-one", expectedRevision: 3, transition: "request.accept",
          payload: {} },
        now: NOW + 5,
      });
      expect(accepted).toMatchObject({ acceptedRevision: 6, replayed: false,
      });
      expect(accepted.kind === "project-loop-mutation" ? accepted.eventIds : []).toHaveLength(2);
      expect(database.prepare(
        "SELECT id, status, revision FROM project_next_actions WHERE id = 'action-from-request'",
      ).get()).toEqual({ id: "action-from-request", status: "accepted", revision: 1 });
      expect(database.prepare(
        "SELECT event_type AS type, fact_kind AS kind FROM project_events ORDER BY event_seq",
      ).all().slice(-2)).toEqual([
        { type: "fact.created", kind: "next_action" },
        { type: "fact.transitioned", kind: "request" },
      ]);
    });
  });

  it("persists defer, escalation, and accepted Obstacle transfer authority", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "blocker-proposal", factKind: "blocker", factId: "blocker-one",
        baseRevision: 0, payload: { title: "Blocked", description: "Need input", impact: "Ship risk",
          resolutionCriteria: "Input arrives", question: null,
          ownerKind: "human", ownerActorId: "human-member", dueAt: null, reviewAt: null },
      }));
      executeProjectLoopAuthorityOperation(database, resolveFactProposal("blocker-proposal", 1));
      const transition = (key: string, expectedRevision: number, name: ProjectLoopAuthorityOperation extends never ? never :
        "obstacle.defer" | "obstacle.reopen" | "obstacle.cannot_answer" |
        "obstacle.transfer_propose" | "obstacle.transfer_accept", payload: Record<string, string>) =>
        executeProjectLoopAuthorityOperation(database, {
          type: "project-loop.fact.transition", context: humanContext(key, key === "accept-transfer"
            ? "human-owner" : "human-member"),
          command: { roomId: "room-project", projectId: "room-project", factKind: "blocker",
            factId: "blocker-one", expectedRevision, transition: name, payload }, now: NOW + expectedRevision,
        });
      transition("defer", 1, "obstacle.defer", {
        reason: "Wait for review", reviewAt: "2026-08-27T08:00:00.000Z",
      });
      expect(database.prepare(
        `SELECT source_kind AS kind FROM project_ball_boundaries
         WHERE status = 'active' AND source_id = 'blocker-one'`,
      ).get()).toEqual({ kind: "review" });
      transition("reopen", 2, "obstacle.reopen", { reason: "Review arrived" });
      transition("cannot", 3, "obstacle.cannot_answer", { reason: "Needs escalation" });
      transition("propose-transfer", 4, "obstacle.transfer_propose", {
        transferProposalId: "transfer-blocker", toOwnerKind: "human",
        toOwnerActorId: "human-owner", reason: "Owner decides",
        expiresAt: "2026-08-26T08:00:00.000Z",
      });
      const accepted = transition("accept-transfer", 4, "obstacle.transfer_accept", {
        transferProposalId: "transfer-blocker",
      });
      expect(accepted).toMatchObject({ acceptedRevision: 7 });
      expect(database.prepare(
        "SELECT status, escalation_emitted AS escalation FROM project_obstacles WHERE id = 'blocker-one'",
      ).get()).toEqual({ status: "open", escalation: 0 });
      expect(database.prepare(
        "SELECT to_owner_actor_id AS target FROM project_transfer_chain WHERE transfer_id = 'transfer-blocker'",
      ).get()).toEqual({ target: "human-owner" });
    });
  });

  it("binds Agent-owned transfer proposals to the exact owner, verifier, or Room governance Human", () => {
    withDatabase((database) => {
      const currentRevision = () => Number(database.prepare(
        "SELECT revision FROM project_room_states WHERE room_id = 'room-project'",
      ).get()?.revision ?? 0);
      const createAgentObstacle = (id: string) => {
        executeProjectLoopAuthorityOperation(database, createFactProposal({
          proposalId: `proposal-${id}`, factKind: "blocker", factId: id,
          baseRevision: currentRevision(), payload: { title: "Agent blocker",
            description: "Needs reassignment", impact: "Delivery risk",
            resolutionCriteria: "New owner accepts", question: null,
            ownerKind: "agent", ownerActorId: "agent-member", dueAt: null, reviewAt: null },
        }));
        executeProjectLoopAuthorityOperation(database, resolveFactProposal(`proposal-${id}`, 1));
      };
      const obstacleTransfer = (key: string, factId: string,
        context: ReturnType<typeof humanContext> | ReturnType<typeof agentContext>,
        toOwnerKind: "human" | "agent", toOwnerActorId: string) =>
        executeProjectLoopAuthorityOperation(database, {
          type: "project-loop.fact.transition", context: { ...context, idempotencyKey: key },
          command: { roomId: "room-project", projectId: "room-project", factKind: "blocker",
            factId, expectedRevision: 1, transition: "obstacle.transfer_propose",
            payload: { transferProposalId: `transfer-${key}`, toOwnerKind, toOwnerActorId,
              reason: "Reassign unavailable owner", expiresAt: "2026-08-26T08:00:00.000Z" } },
          now: NOW + currentRevision(),
        });

      createAgentObstacle("agent-owned-obstacle");
      expect(() => obstacleTransfer("member-cannot-transfer", "agent-owned-obstacle",
        humanContext("member-cannot-transfer", "human-member"), "human", "human-owner"))
        .toThrowError(expect.objectContaining({ code: "permission_denied" }));
      obstacleTransfer("agent-owner-transfer", "agent-owned-obstacle",
        agentContext("agent-owner-transfer"), "human", "human-member");
      expect(database.prepare(
        `SELECT created_by_actor_id AS proposer, principal_human_actor_id AS principal
         FROM project_transfer_proposals WHERE id = 'transfer-agent-owner-transfer'`,
      ).get()).toEqual({ proposer: "agent-member", principal: "human-member" });

      createAgentObstacle("governance-transfer-obstacle");
      obstacleTransfer("admin-transfer", "governance-transfer-obstacle",
        humanContext("admin-transfer", "human-admin"), "human", "human-owner");
      expect(database.prepare(
        `SELECT created_by_actor_id AS proposer, principal_human_actor_id AS principal
         FROM project_transfer_proposals WHERE id = 'transfer-admin-transfer'`,
      ).get()).toEqual({ proposer: "human-admin", principal: "human-owner" });

      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('human-peer', 'human', 'Peer');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'human-peer', 0, 1);
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES (
          'room-project', 'human-peer', 'human', 'member', NULL, '[]',
          CURRENT_TIMESTAMP, NULL, 1
        );
      `);
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "proposal-requester-transfer", factKind: "blocker",
        factId: "requester-transfer-obstacle", baseRevision: currentRevision(),
        actorId: "human-member", principalActorId: "human-member",
        payload: { title: "Requester blocker", description: "Needs owner reassignment",
          impact: "Delivery risk", resolutionCriteria: "New owner accepts", question: null,
          ownerKind: "human", ownerActorId: "human-owner", dueAt: null, reviewAt: null },
      }));
      executeProjectLoopAuthorityOperation(database, {
        ...resolveFactProposal("proposal-requester-transfer", 1),
        context: humanContext("resolve-requester-transfer", "human-member"),
      });
      expect(() => obstacleTransfer("peer-cannot-transfer", "requester-transfer-obstacle",
        humanContext("peer-cannot-transfer", "human-peer"), "human", "human-member"))
        .toThrowError(expect.objectContaining({ code: "permission_denied" }));
      obstacleTransfer("requester-can-transfer", "requester-transfer-obstacle",
        humanContext("requester-can-transfer", "human-member"), "human", "human-peer");
      expect(database.prepare(
        `SELECT created_by_actor_id AS proposer, principal_human_actor_id AS principal
         FROM project_transfer_proposals WHERE id = 'transfer-requester-can-transfer'`,
      ).get()).toEqual({ proposer: "human-member", principal: "human-peer" });

      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "proposal-stale-agent-target", factKind: "blocker",
        factId: "stale-agent-target", baseRevision: currentRevision(),
        payload: { title: "Human blocker", description: "Needs specialist",
          impact: "Delivery risk", resolutionCriteria: "Specialist accepts", question: null,
          ownerKind: "human", ownerActorId: "human-member", dueAt: null, reviewAt: null },
      }));
      executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("proposal-stale-agent-target", 1));
      obstacleTransfer("stale-agent-target", "stale-agent-target",
        humanContext("stale-agent-target", "human-member"), "agent", "agent-member");
      database.exec(`
        UPDATE room_agent_assignments SET paused = 1, revision = revision + 1
         WHERE id = 'assignment-agent-member';
        UPDATE room_agent_assignment_revisions SET paused = 1
         WHERE assignment_id = 'assignment-agent-member' AND revision = 2;
      `);
      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("accept-stale-agent-target",
          "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "blocker",
          factId: "stale-agent-target", expectedRevision: 1,
          transition: "obstacle.transfer_accept",
          payload: { transferProposalId: "transfer-stale-agent-target" } }, now: NOW + 100,
      })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
    });
  });

  it("uses the designated Human verifier, not an Agent owner, to propose NextAction reassignment", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "agent-reassign-proposal", factKind: "next_action",
        factId: "agent-reassign-action", baseRevision: 0,
        payload: { title: "Agent action", description: "Needs reassignment",
          ownerKind: "agent", ownerActorId: "agent-member",
          verifierHumanActorId: "human-owner", dueAt: null, deliverable: "Result",
          acceptanceCriteria: [] },
      }));
      executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("agent-reassign-proposal", 1));
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("accept-agent-reassign"),
        command: { roomId: "room-project", projectId: "room-project",
          factKind: "next_action", factId: "agent-reassign-action", expectedRevision: 1,
          transition: "next_action.accept", payload: {} }, now: NOW + 2,
      });
      const command = { roomId: "room-project", projectId: "room-project",
        factKind: "next_action" as const, factId: "agent-reassign-action", expectedRevision: 2,
        transition: "next_action.transfer_propose" as const,
        payload: { transferProposalId: "agent-action-transfer", toOwnerKind: "human",
          toOwnerActorId: "human-member", reason: "Verifier reassigns",
          expiresAt: "2026-08-26T08:00:00.000Z" } };
      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: agentContext("agent-self-reassign"),
        command, now: NOW + 3,
      })).toThrowError(expect.objectContaining({ code: "permission_denied" }));
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("verifier-reassign"),
        command, now: NOW + 4,
      });
      expect(database.prepare(
        `SELECT created_by_actor_id AS proposer, principal_human_actor_id AS principal
         FROM project_transfer_proposals WHERE id = 'agent-action-transfer'`,
      ).get()).toEqual({ proposer: "human-owner", principal: "human-member" });
    });
  });

  it("supports Agent delivery with Human acceptance/completion and no Agent done path", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "agent-action-proposal", factKind: "next_action", factId: "agent-action",
        baseRevision: 0, payload: { title: "Prepare evidence", description: "Build the bundle",
          ownerKind: "agent", ownerActorId: "agent-member", verifierHumanActorId: "human-owner",
          dueAt: "2026-08-26T08:00:00.000Z", deliverable: "Evidence bundle",
          acceptanceCriteria: [{ criterionId: "criterion-evidence", text: "Bundle is reviewable" }] },
      }));
      executeProjectLoopAuthorityOperation(database, resolveFactProposal("agent-action-proposal", 1));
      const action = (context: ReturnType<typeof humanContext> | ReturnType<typeof agentContext>,
        key: string, expectedRevision: number,
        transition: "next_action.accept" | "next_action.start" | "next_action.deliver" | "next_action.complete",
        payload: Record<string, JsonValue>) => executeProjectLoopAuthorityOperation(database, {
          type: "project-loop.fact.transition", context: { ...context, idempotencyKey: key },
          command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
            factId: "agent-action", expectedRevision, transition, payload }, now: NOW + expectedRevision,
        });
      action(humanContext("accept-action"), "accept-action", 1, "next_action.accept", {});
      action(agentContext("start-action"), "start-action", 2, "next_action.start", {});
      action(agentContext("deliver-action"), "deliver-action", 3, "next_action.deliver", {
        source: { kind: "message", sourceId: "message-1", sourceRevision: 1,
          roomId: "room-project", visibility: "room" }, summary: "Evidence is ready",
      });
      expect(() => action(agentContext("agent-complete"), "agent-complete", 4,
        "next_action.complete", { completionNote: "Agent cannot verify",
          criteriaSnapshot: [{ criterionId: "criterion-evidence", met: true }] }))
        .toThrowError(expect.objectContaining({ code: "permission_denied" }));
      action(humanContext("complete-action"), "complete-action", 4, "next_action.complete", {
        completionNote: "Verified", criteriaSnapshot: [{ criterionId: "criterion-evidence", met: true }],
      });
      expect(database.prepare(
        `SELECT status, deliverable, delivery_summary AS deliverySummary,
                completed_by_human_actor_id AS completedBy
         FROM project_next_actions WHERE id = 'agent-action'`,
      ).get()).toEqual({ status: "done", deliverable: "Evidence bundle",
        deliverySummary: "Evidence is ready", completedBy: "human-owner" });
      const snapshot = executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.snapshot.read", context: humanContext("agent-action-read"),
        roomId: "room-project", projectId: "room-project", afterEventSeq: 0, limit: 50, now: NOW + 10,
      });
      expect(snapshot.kind === "project-loop-snapshot" && isProjectSnapshot(snapshot.snapshot)).toBe(true);
    });
  });

  it("enforces the Human NextAction completion/verifier contract and owner reopen", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "human-action-proposal", factKind: "next_action", factId: "human-action",
        baseRevision: 0, payload: { title: "Human action", description: "Direct completion",
          ownerKind: "human", ownerActorId: "human-member", verifierHumanActorId: null,
          dueAt: null, deliverable: "Result", acceptanceCriteria: [] },
      }));
      executeProjectLoopAuthorityOperation(database, resolveFactProposal("human-action-proposal", 1));
      const transition = (key: string, actorId: string, expectedRevision: number,
        name: "next_action.accept" | "next_action.start" | "next_action.complete" | "next_action.reopen") =>
        executeProjectLoopAuthorityOperation(database, {
          type: "project-loop.fact.transition", context: humanContext(key, actorId),
          command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
            factId: "human-action", expectedRevision, transition: name,
            payload: name === "next_action.complete" ? { completionNote: "Done", criteriaSnapshot: [] }
              : name === "next_action.reopen" ? { reason: "More work is required" } : {} },
          now: NOW + expectedRevision,
        });
      transition("accept-human-action", "human-member", 1, "next_action.accept");
      transition("start-human-action", "human-member", 2, "next_action.start");
      transition("complete-human-action", "human-member", 3, "next_action.complete");
      transition("reopen-human-action", "human-member", 4, "next_action.reopen");
      expect(database.prepare(
        "SELECT status, status_reason AS reason FROM project_next_actions WHERE id = 'human-action'",
      ).get()).toEqual({ status: "in_progress", reason: null });

      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "verified-action-proposal", factKind: "next_action", factId: "verified-action",
        baseRevision: 6, payload: { title: "Verified action", description: "Needs verifier",
          ownerKind: "human", ownerActorId: "human-member", verifierHumanActorId: "human-owner",
          dueAt: null, deliverable: "Result", acceptanceCriteria: [] },
      }));
      executeProjectLoopAuthorityOperation(database, resolveFactProposal("verified-action-proposal", 1));
      for (const [key, revision, name] of [
        ["accept-verified", 1, "next_action.accept"],
        ["start-verified", 2, "next_action.start"],
      ] as const) executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext(key, "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
          factId: "verified-action", expectedRevision: revision, transition: name, payload: {} },
        now: NOW + revision,
      });
      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition", context: humanContext("premature-verify"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
          factId: "verified-action", expectedRevision: 3, transition: "next_action.complete",
          payload: { completionNote: "Cannot skip delivery", criteriaSnapshot: [] } },
        now: NOW + 3,
      })).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
    });
  });

  it("moves a NextAction owner and Ball only after the exact Human accepts its TransferProposal", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "transfer-action-proposal", factKind: "next_action", factId: "transfer-action",
        baseRevision: 0, payload: { title: "Transfer me", description: "Owner migration",
          ownerKind: "human", ownerActorId: "human-member", verifierHumanActorId: "human-owner",
          dueAt: null, deliverable: "Result", acceptanceCriteria: [] },
      }));
      executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("transfer-action-proposal", 1));
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition",
        context: humanContext("accept-transfer-action", "human-member"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
          factId: "transfer-action", expectedRevision: 1, transition: "next_action.accept",
          payload: {} }, now: NOW + 2,
      });
      const transition = (key: string, actorId: string, expectedRevision: number,
        name: "next_action.transfer_propose" | "next_action.transfer_accept" |
          "next_action.transfer_reject", transferProposalId: string, at = NOW + 10) =>
        executeProjectLoopAuthorityOperation(database, {
          type: "project-loop.fact.transition", context: humanContext(key, actorId),
          command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
            factId: "transfer-action", expectedRevision, transition: name,
            payload: name === "next_action.transfer_propose" ? {
              transferProposalId, toOwnerKind: "human", toOwnerActorId: "human-owner",
              reason: "Owner requested migration", expiresAt: "2026-08-26T08:00:00.000Z",
            } : { transferProposalId } }, now: at,
        });

      transition("propose-action-transfer-reject", "human-member", 2,
        "next_action.transfer_propose", "transfer-action-rejected");
      expect(() => transition("wrong-action-principal", "human-member", 2,
        "next_action.transfer_reject", "transfer-action-rejected"))
        .toThrowError(expect.objectContaining({ code: "permission_denied" }));
      transition("reject-action-transfer", "human-owner", 2,
        "next_action.transfer_reject", "transfer-action-rejected");
      expect(database.prepare(
        "SELECT revision, owner_actor_id AS owner FROM project_next_actions WHERE id = 'transfer-action'",
      ).get()).toEqual({ revision: 2, owner: "human-member" });

      transition("propose-action-transfer-stale", "human-member", 2,
        "next_action.transfer_propose", "transfer-action-stale");
      database.prepare(
        "UPDATE project_transfer_proposals SET subject_revision = 99 WHERE id = 'transfer-action-stale'",
      ).run();
      expect(() => transition("accept-action-transfer-stale", "human-owner", 2,
        "next_action.transfer_accept", "transfer-action-stale"))
        .toThrowError(expect.objectContaining({ code: "permission_denied" }));
      expect(database.prepare(
        "SELECT revision, owner_actor_id AS owner FROM project_next_actions WHERE id = 'transfer-action'",
      ).get()).toEqual({ revision: 2, owner: "human-member" });
      database.prepare(
        "UPDATE project_transfer_proposals SET subject_revision = 2 WHERE id = 'transfer-action-stale'",
      ).run();
      transition("reject-action-transfer-stale", "human-owner", 2,
        "next_action.transfer_reject", "transfer-action-stale");

      transition("propose-action-transfer-expired", "human-member", 2,
        "next_action.transfer_propose", "transfer-action-expired");
      expect(database.prepare(
        `SELECT holder_actor_id AS holder, reason
         FROM project_ball_boundaries
         WHERE source_kind = 'transfer' AND source_id = 'transfer-action-expired'
           AND status = 'active'`,
      ).get()).toEqual({ holder: "human-owner", reason: "transfer_acceptance" });
      transition("accept-action-transfer-expired", "human-owner", 2,
        "next_action.transfer_accept", "transfer-action-expired", NOW + 2 * 86_400_000);
      expect(database.prepare(
        `SELECT action.revision, action.owner_actor_id AS owner, proposal.status
         FROM project_next_actions AS action JOIN project_transfer_proposals AS proposal
           ON proposal.id = 'transfer-action-expired' WHERE action.id = 'transfer-action'`,
      ).get()).toEqual({ revision: 2, owner: "human-member", status: "expired" });
      expect(database.prepare(
        `SELECT holder_actor_id AS holder, reason
         FROM project_ball_boundaries
         WHERE source_kind = 'transfer' AND source_id = 'transfer-action-expired'
           AND status = 'active'`,
      ).get()).toEqual({ holder: "human-member", reason: "escalation" });

      transition("propose-action-transfer-timer-expired", "human-member", 2,
        "next_action.transfer_propose", "transfer-action-timer-expired");
      database.exec("BEGIN IMMEDIATE");
      expect(advanceProjectLoopTimedTransitionsInTransaction(database, {
        now: new Date(NOW + 2 * 86_400_000).toISOString(), limit: 256,
      })).toMatchObject({ expiredTransfers: 1 });
      database.exec("COMMIT");
      expect(() => transition("accept-action-transfer-after-timer", "human-owner", 2,
        "next_action.transfer_accept", "transfer-action-timer-expired", NOW + 2 * 86_400_000 + 1))
        .toThrowError(expect.objectContaining({ code: "permission_denied" }));
      expect(database.prepare(
        `SELECT holder_actor_id AS holder, reason
         FROM project_ball_boundaries
         WHERE source_kind = 'transfer' AND source_id = 'transfer-action-timer-expired'
           AND status = 'active'`,
      ).get()).toEqual({ holder: "human-member", reason: "escalation" });
      expect(database.prepare(
        `SELECT project.authority_kind AS authorityKind, project.actor_id AS actorId,
                project.causal_actor_kind AS causalKind,
                project.causal_actor_id AS causalActorId,
                public.authority_kind AS publicAuthorityKind,
                public.actor_id AS publicActorId,
                audit.authority_kind AS auditAuthorityKind,
                audit.actor_id AS auditActorId,
                public.event_type AS publicType,
                json_extract(public.payload_json, '$.revision') AS publicRevision,
                json_extract(audit.transition_json, '$.transferRevision') AS auditTransferRevision
         FROM project_events AS project
         JOIN events AS public ON public.event_id = project.event_id
         JOIN project_transition_audit AS audit ON audit.event_id = project.event_id
         WHERE json_extract(project.payload_json, '$.transition') = 'transfer_expired'`,
      ).get()).toEqual({ authorityKind: "system_timer", actorId: null,
        causalKind: null, causalActorId: null,
        publicAuthorityKind: "system_timer", publicActorId: null,
        auditAuthorityKind: "system_timer", auditActorId: null,
        publicType: "project.transfer-proposal.changed", publicRevision: 2,
        auditTransferRevision: 2 });
      const timerSnapshot = executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.snapshot.read", context: humanContext("read-timer-authority"),
        roomId: "room-project", projectId: "room-project", afterEventSeq: 0,
        limit: 100, now: NOW + 2 * 86_400_000,
      });
      expect(timerSnapshot.kind === "project-loop-snapshot"
        ? timerSnapshot.events.at(-1)?.transitionAuthority : null)
        .toEqual({ kind: "system_timer" });
      const timerDelivery = listPendingOutboxDatabaseQuery(
        database, 100, NOW + 2 * 86_400_000,
      ).find((delivery) => delivery.event.type === "project.transfer-proposal.changed");
      expect(timerDelivery?.event).toMatchObject({
        transitionAuthority: { kind: "system_timer" },
        causalActor: null,
      });

      transition("propose-action-transfer", "human-member", 2,
        "next_action.transfer_propose", "transfer-action-accepted");
      transition("accept-action-transfer", "human-owner", 2,
        "next_action.transfer_accept", "transfer-action-accepted");
      expect(database.prepare(
        `SELECT revision, owner_actor_id AS owner, status, accepted_by_human_actor_id AS acceptedBy
         FROM project_next_actions WHERE id = 'transfer-action'`,
      ).get()).toEqual({ revision: 3, owner: "human-owner", status: "proposed", acceptedBy: null });
      expect(database.prepare(
        `SELECT from_owner_actor_id AS oldOwner, to_owner_actor_id AS newOwner,
                accepted_by_human_actor_id AS acceptedBy
         FROM project_transfer_chain WHERE transfer_id = 'transfer-action-accepted'`,
      ).get()).toEqual({ oldOwner: "human-member", newOwner: "human-owner",
        acceptedBy: "human-owner" });
      expect(database.prepare(
        `SELECT holder_actor_id AS holder, source_revision AS revision
         FROM project_ball_boundaries WHERE source_id = 'transfer-action' AND status = 'active'`,
      ).get()).toEqual({ holder: "human-owner", revision: 3 });
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition",
        context: humanContext("new-owner-accepts", "human-owner"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "next_action",
          factId: "transfer-action", expectedRevision: 3, transition: "next_action.accept", payload: {} },
        now: NOW + 11,
      });
      expect(database.prepare(
        "SELECT revision, status FROM project_next_actions WHERE id = 'transfer-action'",
      ).get()).toEqual({ revision: 4, status: "accepted" });
    });
  });
});
