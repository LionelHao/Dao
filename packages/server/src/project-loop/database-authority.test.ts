import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isProjectSnapshot } from "@native-im/core";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import type { JsonValue } from "../persistence/contracts.js";
import {
  executeProjectLoopAuthorityOperation,
  claimDueProjectRemindersDatabaseCommand,
  ProjectLoopAuthorityError,
  readProjectLoopRepairSnapshotDatabaseQuery,
} from "./database-authority.js";
import type { ProjectLoopAuthorityOperation } from "./authority-protocol.js";

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
        ('human-member', 'human', 'Member'),
        ('human-outsider', 'human', 'Outsider'),
        ('agent-member', 'agent', 'Agent');
      INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
        ('identity', 'human-owner', 0, 1), ('identity', 'human-member', 0, 1),
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
      expectedRevision, resolution },
    now: NOW + expectedRevision,
  };
}

describe("Project Loop database authority", () => {
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

  it("enforces one active goal, immutable confirmed decisions, and legal transitions", () => {
    withDatabase((database) => {
      executeProjectLoopAuthorityOperation(database, proposalCreate());
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.resolve",
        context: humanContext("goal-confirm"),
        command: { proposalId: "proposal-goal", roomId: "room-project", projectId: "room-project",
          expectedRevision: 1, resolution: "confirmed" },
        now: NOW + 1,
      });
      executeProjectLoopAuthorityOperation(database, {
        ...proposalCreate("second-goal"),
        command: { ...proposalCreate().command, proposalId: "proposal-second",
          factId: "goal-second", baseRevision: 2 },
      });
      expect(() => executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.resolve",
        context: humanContext("second-confirm"),
        command: { proposalId: "proposal-second", roomId: "room-project",
          projectId: "room-project", expectedRevision: 3, resolution: "confirmed" },
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

      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "decision-one-proposal", factKind: "decision", factId: "decision-one",
        baseRevision: 2, payload: { title: "Ship A", rationale: "First confirmed choice" },
      }));
      executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("decision-one-proposal", 3));
      executeProjectLoopAuthorityOperation(database, createFactProposal({
        proposalId: "decision-two-proposal", factKind: "decision", factId: "decision-two",
        baseRevision: 4, payload: { title: "Ship B", rationale: "Superseding choice",
          supersedesDecisionId: "decision-one" },
      }));
      executeProjectLoopAuthorityOperation(database,
        resolveFactProposal("decision-two-proposal", 5));

      expect(database.prepare(
        `SELECT id, status, revision, superseded_by_decision_id AS supersededBy
         FROM project_decisions ORDER BY id`,
      ).all()).toEqual([
        { id: "decision-one", status: "superseded", revision: 2, supersededBy: "decision-two" },
        { id: "decision-two", status: "confirmed", revision: 1, supersededBy: null },
      ]);
    });
  });

  it("lets only the current Request target transfer/respond and creates one linked responsibility atomically", () => {
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

      const transfer = {
        type: "project-loop.fact.transition" as const,
        context: humanContext("request-transfer", "human-owner"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "request" as const,
          factId: "request-one", expectedRevision: 1,
          transition: "request.transfer" as const,
          payload: { reason: "Owner will take it", targetHumanActorId: "human-owner" } },
        now: NOW + 2,
      };
      expect(() => executeProjectLoopAuthorityOperation(database, transfer))
        .toThrowError(expect.objectContaining({ code: "permission_denied" }));
      const transferred = executeProjectLoopAuthorityOperation(database, {
        ...transfer, context: humanContext("request-transfer", "human-member"),
      });
      expect(transferred).toMatchObject({ acceptedRevision: 3,
      });
      expect(database.prepare(
        "SELECT revision, status, target_human_actor_id AS target FROM project_requests WHERE id = 'request-one'",
      ).get()).toEqual({ revision: 2, status: "pending_acceptance", target: "human-owner" });

      const accepted = executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.fact.transition",
        context: humanContext("request-accept"),
        command: { roomId: "room-project", projectId: "room-project", factKind: "request",
          factId: "request-one", expectedRevision: 2, transition: "request.accept",
          payload: {} },
        now: NOW + 3,
      });
      expect(accepted).toMatchObject({ acceptedRevision: 5, replayed: false,
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
        "SELECT source_kind AS kind FROM project_ball_boundaries WHERE status = 'active'",
      ).get()).toEqual({ kind: "review" });
      transition("reopen", 2, "obstacle.reopen", { reason: "Review arrived" });
      transition("cannot", 3, "obstacle.cannot_answer", { reason: "Needs escalation" });
      transition("propose-transfer", 4, "obstacle.transfer_propose", {
        transferProposalId: "transfer-blocker", toOwnerKind: "human",
        toOwnerActorId: "human-owner", reason: "Owner decides",
        expiresAt: "2026-08-26T08:00:00.000Z",
      });
      const accepted = transition("accept-transfer", 5, "obstacle.transfer_accept", {
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
});
