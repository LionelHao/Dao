import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectBoundaryInvocationRequest, ProviderEvent } from "@native-im/core";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { executeRuntimeAuthorityOperation } from "../persistence/authority-database-handler.js";
import { executeProjectLoopAuthorityOperation } from "../project-loop/database-authority.js";
import {
  archiveProjectLoopBoundariesInTransaction,
  reopenProjectLoopBoundariesInTransaction,
} from "../project-loop/boundary-authority.js";
import {
  beginProjectBoundaryExecutionInTransaction,
  claimProjectBoundaryInvocationInTransaction,
  finishProjectBoundaryExecutionInTransaction,
  listRunnableProjectBoundaryExecutions,
} from "./project-boundary-authority.js";
import { createProjectBoundaryRuntime } from "./project-boundary-runtime.js";

const NOW = "2026-08-25T08:00:00.000Z";
const LATER = "2026-08-25T08:01:00.000Z";
const HASH = "a".repeat(64);
const CHECKPOINT_HASH = "9d153ae68f997cde03d07b1045c220352a3d38295b32cf8801072dcaa8e07c3f";
const directories = new WeakMap<DatabaseSync, string>();

function fixture(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "dao-project-boundary-adversarial-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  directories.set(database, directory);
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json) VALUES
      ('human-owner', 'human', 'Owner', '[]'),
      ('agent-one', 'agent', 'Agent One', '[]'),
      ('agent-two', 'agent', 'Agent Two', '[]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
      ('identity', 'human-owner', 0, 1),
      ('identity', 'agent-one', 0, 1),
      ('identity', 'agent-two', 0, 1),
      ('room', 'room-project', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id) VALUES
      ('room-project', 'Project', 'active', '${NOW}', 'human-owner');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-project', 'human-owner', 'human', 'owner', NULL, '[]', '${NOW}', NULL, 1),
      ('room-project', 'agent-one', 'agent', NULL, 'active', '[]', NULL, '${NOW}', 7),
      ('room-project', 'agent-two', 'agent', NULL, 'active', '[]', NULL, '${NOW}', 1);
    INSERT INTO agent_profiles (
      id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json,
      display_name, global_responsibility, created_at, updated_at, source_kind
    ) VALUES
      ('profile-one', 'agent-one', 3, 'enabled',
       '["room.project.read","room.respond"]', '[]', 'Agent One', 'Project delivery',
       '${NOW}', '${NOW}', 'legacy_v20_migration'),
      ('profile-two', 'agent-two', 1, 'enabled',
       '["room.project.read","room.respond"]', '[]', 'Agent Two', 'Project delivery',
       '${NOW}', '${NOW}', 'legacy_v20_migration');
    INSERT INTO agent_profile_revisions (
      profile_id, revision, actor_id, display_name, global_responsibility, status,
      capability_ceiling_json, tool_ceiling_json, changed_at, operation
    ) VALUES
      ('profile-one', 3, 'agent-one', 'Agent One', 'Project delivery', 'enabled',
       '["room.project.read","room.respond"]', '[]', '${NOW}', 'legacy_migration'),
      ('profile-two', 1, 'agent-two', 'Agent Two', 'Project delivery', 'enabled',
       '["room.project.read","room.respond"]', '[]', '${NOW}', 'legacy_migration');
    INSERT INTO room_agent_assignments (
      id, room_id, profile_id, agent_actor_id, revision, status, participation,
      paused, capability_subset_json, tool_subset_json, room_responsibility,
      created_at, updated_at, source_kind
    ) VALUES
      ('assignment-one', 'room-project', 'profile-one', 'agent-one', 5, 'current',
       'active', 0, '["room.project.read","room.respond"]', '[]', 'Deliver Project work',
       '${NOW}', '${NOW}', 'legacy_v20_migration'),
      ('assignment-two', 'room-project', 'profile-two', 'agent-two', 1, 'current',
       'active', 0, '["room.project.read","room.respond"]', '[]', 'Deliver Project work',
       '${NOW}', '${NOW}', 'legacy_v20_migration');
    INSERT INTO room_agent_assignment_revisions (
      assignment_id, revision, room_id, profile_id, agent_actor_id,
      room_responsibility, status, participation, paused,
      capability_subset_json, tool_subset_json, changed_at, operation
    ) VALUES
      ('assignment-one', 5, 'room-project', 'profile-one', 'agent-one',
       'Deliver Project work', 'current', 'active', 0,
       '["room.project.read","room.respond"]', '[]', '${NOW}', 'legacy_migration'),
      ('assignment-two', 1, 'room-project', 'profile-two', 'agent-two',
       'Deliver Project work', 'current', 'active', 0,
       '["room.project.read","room.respond"]', '[]', '${NOW}', 'legacy_migration');
    INSERT INTO project_next_actions (
      id, room_id, source_room_id, source_id, revision, owner_kind,
      owner_actor_id, verifier_human_actor_id, status
    ) VALUES (
      'action-one', 'room-project', 'room-project', 'legacy-source', 4,
      'agent', 'agent-one', 'human-owner', 'accepted'
    );
    INSERT INTO project_ball_boundaries (
      boundary_id, room_id, project_id, source_kind, source_id, source_revision,
      lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at,
      status, released_at
    ) VALUES (
      'boundary-one', 'room-project', 'room-project', 'next_action', 'action-one', 4,
      0, 'agent', 'agent-one', 'work', '${NOW}', NULL, 'active', NULL
    );
    INSERT INTO project_fact_checkpoints (
      checkpoint_id, room_id, project_id, project_revision, projection_json,
      projection_sha256, created_at
    ) VALUES (
      'checkpoint-one', 'room-project', 'room-project', 9,
      '{"recordVersion":"project-loop.v1"}', '${CHECKPOINT_HASH}', '${NOW}'
    );
  `);
  return database;
}

function close(database: DatabaseSync): void {
  const directory = directories.get(database);
  database.close();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
}

function request(overrides: Partial<ProjectBoundaryInvocationRequest> = {}):
ProjectBoundaryInvocationRequest {
  return {
    purpose: "project_boundary_invocation",
    boundaryId: "boundary-one",
    boundaryKind: "agent_ball",
    projectId: "room-project",
    roomId: "room-project",
    agentId: "agent-one",
    sourceFactId: "action-one",
    sourceFactRevision: 4,
    ...overrides,
  };
}

function claim(database: DatabaseSync,
  boundaryRequest: ProjectBoundaryInvocationRequest = request()) {
  return claimProjectBoundaryInvocationInTransaction(database, {
    request: boundaryRequest,
    requestSha256: HASH,
    attemptedAt: NOW,
    providerId: "provider-one",
    modelId: "model-one",
  });
}

function counts(database: DatabaseSync) {
  return {
    intents: database.prepare(
      "SELECT COUNT(*) AS count FROM project_boundary_agent_invocation_intents",
    ).get(),
    executions: database.prepare(
      "SELECT COUNT(*) AS count FROM project_boundary_agent_executions",
    ).get(),
    messages: database.prepare("SELECT COUNT(*) AS count FROM messages").get(),
  };
}

describe("FT-09 Project boundary adversarial authority", () => {
  it("does not receipt a transient checkpoint outage and admits the boundary after recovery", () => {
    const database = fixture();
    try {
      database.prepare("DELETE FROM project_fact_checkpoints WHERE checkpoint_id = 'checkpoint-one'").run();
      expect(claim(database)).toMatchObject({ status: "suppressed", reason: "boundary_ineligible" });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM project_boundary_invocation_receipts",
      ).get()).toEqual({ count: 0 });
      database.exec(`
        INSERT INTO project_fact_checkpoints (
          checkpoint_id, room_id, project_id, project_revision, projection_json,
          projection_sha256, created_at
        ) VALUES (
          'checkpoint-one', 'room-project', 'room-project', 9,
          '{"recordVersion":"project-loop.v1"}', '${CHECKPOINT_HASH}', '${NOW}'
        )
      `);
      expect(claim(database)).toMatchObject({ status: "intent-created" });
      expect(counts(database).executions).toEqual({ count: 1 });
    } finally {
      close(database);
    }
  });

  it("keeps no-provider scans from claiming Agent work while still delivering Human due reminders", () => {
    const database = fixture();
    try {
      expect(executeRuntimeAuthorityOperation(database, {
        type: "runtime.scan-project-agent-boundaries", providerId: "provider-one",
        modelId: "model-one", agentProviderReady: false, limit: 256, now: Date.parse(NOW),
      })).toMatchObject({ createdCount: 0, suppressedCount: 0 });
      database.exec(`
        INSERT INTO project_next_actions (
          id, room_id, source_room_id, source_id, revision, owner_kind,
          owner_actor_id, verifier_human_actor_id, status
        ) VALUES (
          'action-human', 'room-project', 'room-project', 'legacy-human-source', 1,
          'human', 'human-owner', NULL, 'accepted'
        );
        INSERT INTO project_ball_boundaries (
          boundary_id, room_id, project_id, source_kind, source_id, source_revision,
          lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at,
          status, released_at
        ) VALUES
          ('boundary-human-parent', 'room-project', 'room-project', 'next_action',
           'action-human', 1, 0, 'human', 'human-owner', 'work', '${NOW}', '${NOW}', 'active', NULL),
          ('boundary-human-due', 'room-project', 'room-project', 'due',
           'boundary-human-parent', 1, 0, 'human', 'human-owner', 'due', '${NOW}', '${NOW}', 'active', NULL);
      `);
      expect(executeRuntimeAuthorityOperation(database, {
        type: "runtime.scan-project-reminders", providerId: "provider-one",
        modelId: "model-one", agentProviderReady: false, limit: 256, now: Date.parse(NOW),
      })).toMatchObject({ kind: "project-reminder-scan", result: { claimedCount: 1 } });
      expect(counts(database).intents).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_deliveries
         WHERE target_kind = 'principal' AND target_id = 'human-owner'`,
      ).get()).toEqual({ count: 1 });
    } finally {
      close(database);
    }
  });

  it("creates one message-independent execution, exact-replays it, and closes its CAS state machine", () => {
    const database = fixture();
    try {
      expect(claim(database)).toMatchObject({
        status: "intent-created", boundaryId: "boundary-one", roomId: "room-project",
      });
      expect(counts(database)).toEqual({
        intents: { count: 1 }, executions: { count: 1 }, messages: { count: 0 },
      });
      expect(claim(database)).toMatchObject({ status: "intent-created" });
      expect(counts(database)).toEqual({
        intents: { count: 1 }, executions: { count: 1 }, messages: { count: 0 },
      });

      const [accepted] = listRunnableProjectBoundaryExecutions(database, 10);
      expect(accepted).toMatchObject({ status: "accepted", version: 1,
        sourceRevision: 4, lifecycleGeneration: 0 });
      expect(beginProjectBoundaryExecutionInTransaction(database, {
        executionId: accepted!.executionId, expectedVersion: 99, now: LATER,
      })).toBeNull();
      const running = beginProjectBoundaryExecutionInTransaction(database, {
        executionId: accepted!.executionId, expectedVersion: 1, now: LATER,
      });
      expect(running).toMatchObject({ status: "running", version: 2 });
      expect(finishProjectBoundaryExecutionInTransaction(database, {
        executionId: accepted!.executionId, expectedVersion: 1,
        outcome: "completed", now: LATER,
      })).toBeNull();
      expect(finishProjectBoundaryExecutionInTransaction(database, {
        executionId: accepted!.executionId, expectedVersion: 2,
        outcome: "completed", now: LATER,
      })).toMatchObject({ status: "completed", version: 3 });
      expect(finishProjectBoundaryExecutionInTransaction(database, {
        executionId: accepted!.executionId, expectedVersion: 3,
        outcome: "completed", now: LATER,
      })).toBeNull();
      expect(listRunnableProjectBoundaryExecutions(database, 10)).toEqual([]);
      expect(counts(database).messages).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT json_extract(payload_json, '$.executionStatus') AS status
         FROM events
         WHERE event_type = 'project.boundary.invocation.decided'
           AND json_extract(payload_json, '$.status') = 'execution-state'
         ORDER BY stream_seq`,
      ).all()).toEqual([{ status: "accepted" }, { status: "running" }, { status: "completed" }]);
    } finally {
      close(database);
    }
  });

  it.each([
    ["source resolved", "UPDATE project_next_actions SET status = 'done' WHERE id = 'action-one'"],
    ["source transferred", "UPDATE project_next_actions SET owner_actor_id = 'agent-two' WHERE id = 'action-one'"],
    ["source revision changed", "UPDATE project_next_actions SET revision = 5 WHERE id = 'action-one'"],
    ["membership access revoked", "UPDATE room_memberships SET access_revision = 8 WHERE room_id = 'room-project' AND actor_id = 'agent-one'"],
    ["assignment paused", `UPDATE room_agent_assignments
      SET paused = 1, revision = 6, updated_at = '${LATER}', source_kind = 'room_command'
      WHERE id = 'assignment-one'`],
    ["profile disabled", `UPDATE agent_profiles
      SET status = 'disabled', revision = 4, updated_at = '${LATER}',
          source_kind = 'administrator_command' WHERE id = 'profile-one'`],
    ["boundary superseded", "UPDATE project_ball_boundaries SET status = 'superseded', released_at = '${LATER}' WHERE boundary_id = 'boundary-one'"],
    ["room archived", "UPDATE rooms SET status = 'archived', archive_generation = 1 WHERE id = 'room-project'"],
  ])("cancels before provider when %s", (_name, mutation) => {
    const database = fixture();
    try {
      claim(database);
      const [accepted] = listRunnableProjectBoundaryExecutions(database, 10);
      database.exec(mutation);
      expect(beginProjectBoundaryExecutionInTransaction(database, {
        executionId: accepted!.executionId, expectedVersion: accepted!.version, now: LATER,
      })).toBeNull();
      expect(database.prepare(
        `SELECT public_status AS status, cancellation_reason AS reason
         FROM project_boundary_agent_executions WHERE execution_id = ?`,
      ).get(accepted!.executionId)).toEqual({ status: "cancelled", reason: "source_ineligible" });
      expect(counts(database).messages).toEqual({ count: 0 });
    } finally {
      close(database);
    }
  });

  it("cancels a running execution when transfer/resolve wins the final recheck", () => {
    const database = fixture();
    try {
      claim(database);
      const [accepted] = listRunnableProjectBoundaryExecutions(database, 10);
      const running = beginProjectBoundaryExecutionInTransaction(database, {
        executionId: accepted!.executionId, expectedVersion: 1, now: LATER,
      });
      database.prepare(
        "UPDATE project_next_actions SET owner_actor_id = 'agent-two', revision = 5 WHERE id = 'action-one'",
      ).run();
      expect(finishProjectBoundaryExecutionInTransaction(database, {
        executionId: accepted!.executionId, expectedVersion: running!.version,
        outcome: "completed", now: LATER,
      })).toBeNull();
      expect(database.prepare(
        "SELECT public_status AS status FROM project_boundary_agent_executions WHERE execution_id = ?",
      ).get(accepted!.executionId)).toEqual({ status: "cancelled" });
      expect(counts(database).messages).toEqual({ count: 0 });
    } finally {
      close(database);
    }
  });

  it("atomically consumes a preclaimed but unconsumed boundary during recovery", () => {
    const database = fixture();
    try {
      database.prepare(
        `INSERT INTO project_agent_boundary_claims (
           boundary_id, source_revision, room_id, holder_agent_actor_id,
           request_sha256, status, attempted_at, consumed_at
         ) VALUES ('boundary-one', 4, 'room-project', 'agent-one', ?, 'claimed', ?, NULL)`,
      ).run(HASH, NOW);
      expect(claim(database)).toMatchObject({ status: "intent-created" });
      expect(database.prepare(
        `SELECT status, consumed_at AS consumedAt FROM project_agent_boundary_claims
         WHERE boundary_id = 'boundary-one' AND source_revision = 4`,
      ).get()).toEqual({ status: "consumed", consumedAt: NOW });
      expect(counts(database).executions).toEqual({ count: 1 });
    } finally {
      close(database);
    }
  });

  it("admits one due execution only after the exact due boundary is reached", () => {
    const database = fixture();
    try {
      database.exec(`
        UPDATE project_ball_boundaries SET due_at = '2026-08-25T07:59:59.000Z'
        WHERE boundary_id = 'boundary-one';
        INSERT INTO project_ball_boundaries (
          boundary_id, room_id, project_id, source_kind, source_id, source_revision,
          lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at,
          status, released_at
        ) VALUES (
          'boundary-due', 'room-project', 'room-project', 'due', 'boundary-one', 4,
          0, 'agent', 'agent-one', 'due', '${NOW}',
          '2026-08-25T07:59:59.000Z', 'active', NULL
        )
      `);
      expect(claim(database, request({ boundaryId: "boundary-due", boundaryKind: "due",
        sourceFactId: "boundary-one" })))
        .toMatchObject({ status: "intent-created" });
      expect(counts(database)).toEqual({
        intents: { count: 1 }, executions: { count: 1 }, messages: { count: 0 },
      });
    } finally {
      close(database);
    }
  });

  it("admits a deferred obstacle only when its exact review boundary is reached", () => {
    const database = fixture();
    try {
      database.exec(`
        UPDATE project_ball_boundaries SET status = 'superseded', released_at = '${NOW}'
        WHERE boundary_id = 'boundary-one';
        INSERT INTO project_obstacles (
          id, room_id, source_room_id, source_id, revision, kind,
          owner_kind, owner_actor_id, status, review_at
        ) VALUES (
          'obstacle-one', 'room-project', 'room-project', 'legacy-obstacle-source', 2,
          'blocker', 'agent', 'agent-one', 'deferred', '2026-08-25T07:59:59.000Z'
        );
        INSERT INTO project_ball_boundaries (
          boundary_id, room_id, project_id, source_kind, source_id, source_revision,
          lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at,
          status, released_at
        ) VALUES (
          'boundary-review', 'room-project', 'room-project', 'review', 'obstacle-one', 2,
          0, 'agent', 'agent-one', 'review', '${NOW}',
          '2026-08-25T07:59:59.000Z', 'active', NULL
        );
      `);
      expect(claim(database, request({
        boundaryId: "boundary-review", boundaryKind: "blocker",
        sourceFactId: "obstacle-one", sourceFactRevision: 2,
      }))).toMatchObject({ status: "intent-created" });
      expect(counts(database).executions).toEqual({ count: 1 });
    } finally {
      close(database);
    }
  });

  it("does not terminally consume a future deferred-review boundary during global scans", () => {
    const database = fixture();
    try {
      database.exec(`
        UPDATE project_ball_boundaries SET status = 'superseded', released_at = '${NOW}'
        WHERE boundary_id = 'boundary-one';
        INSERT INTO project_obstacles (
          id, room_id, source_room_id, source_id, revision, kind,
          owner_kind, owner_actor_id, status, review_at,
          title, description, impact, resolution_criteria,
          source_kind, source_revision, created_by_actor_id, visibility_room_id,
          created_at, updated_at
        ) VALUES (
          'obstacle-future', 'room-project', 'room-project', 'legacy-obstacle-source', 2,
          'blocker', 'agent', 'agent-one', 'deferred', '2026-08-25T09:00:00.000Z',
          'Future blocker', 'Wait for review', 'Blocks delivery', 'Resolve it',
          'message', 1, 'human-owner', 'room-project', '${NOW}', '${NOW}'
        );
        INSERT INTO project_ball_boundaries (
          boundary_id, room_id, project_id, source_kind, source_id, source_revision,
          lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at,
          status, released_at
        ) VALUES (
          'boundary-future-review', 'room-project', 'room-project', 'review',
          'obstacle-future', 2, 0, 'agent', 'agent-one', 'review', '${NOW}',
          '2026-08-25T09:00:00.000Z', 'active', NULL
        );
      `);
      expect(executeRuntimeAuthorityOperation(database, {
        type: "runtime.scan-project-agent-boundaries", providerId: "provider-one", agentProviderReady: true,
        modelId: "model-one", limit: 10, now: Date.parse(NOW),
      })).toMatchObject({ createdCount: 0, suppressedCount: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM project_boundary_invocation_receipts",
      ).get()).toEqual({ count: 0 });
      expect(executeRuntimeAuthorityOperation(database, {
        type: "runtime.scan-project-agent-boundaries", providerId: "provider-one", agentProviderReady: true,
        modelId: "model-one", limit: 10, now: Date.parse("2026-08-25T09:00:00.000Z"),
      })).toMatchObject({ createdCount: 1 });
      expect(counts(database).executions).toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT status, revision, review_at AS reviewAt FROM project_obstacles WHERE id = 'obstacle-future'",
      ).get()).toEqual({ status: "open", revision: 3, reviewAt: null });
      expect(database.prepare(
        `SELECT source_kind AS sourceKind, source_revision AS sourceRevision, status
         FROM project_ball_boundaries WHERE source_id = 'obstacle-future'
         ORDER BY source_revision`,
      ).all()).toEqual([
        { sourceKind: "review", sourceRevision: 2, status: "superseded" },
        { sourceKind: "blocker", sourceRevision: 3, status: "active" },
      ]);
    } finally {
      close(database);
    }
  });

  it("creates an independent due execution after the earlier Agent-Ball execution", () => {
    const database = fixture();
    try {
      database.prepare(
        "UPDATE project_ball_boundaries SET due_at = ? WHERE boundary_id = 'boundary-one'",
      ).run("2026-08-25T09:00:00.000Z");
      expect(executeRuntimeAuthorityOperation(database, {
        type: "runtime.scan-project-agent-boundaries", providerId: "provider-one", agentProviderReady: true,
        modelId: "model-one", limit: 10, now: Date.parse(NOW),
      })).toMatchObject({ createdCount: 1, suppressedCount: 0 });
      expect(executeRuntimeAuthorityOperation(database, {
        type: "runtime.scan-project-reminders", providerId: "provider-one", agentProviderReady: true,
        modelId: "model-one", limit: 10, now: Date.parse("2026-08-25T09:00:00.000Z"),
      })).toMatchObject({
        kind: "project-reminder-scan",
        result: { claimedCount: 1, duplicateCount: 0 },
      });
      expect(counts(database).executions).toEqual({ count: 2 });
      expect(database.prepare(
        `SELECT claim.status FROM project_due_reminder_claims AS claim
         JOIN project_ball_boundaries AS boundary ON boundary.boundary_id = claim.boundary_id
         WHERE boundary.source_kind = 'due' AND boundary.source_id = 'boundary-one'
           AND claim.reminder_ordinal = 0`,
      ).get()).toEqual({ status: "dispatched" });
      expect(database.prepare(
        `SELECT boundary_kind AS boundaryKind FROM project_boundary_agent_invocation_intents
         ORDER BY created_at, intent_id`,
      ).all()).toEqual([{ boundaryKind: "agent_ball" }, { boundaryKind: "due" }]);
    } finally {
      close(database);
    }
  });
});

describe("FT-09 pending confirmation Ball adversarial authority", () => {
  it("creates one Human pending-confirmation Ball for a Goal proposal", () => {
    const database = fixture();
    try {
      database.prepare(
        "UPDATE project_ball_boundaries SET status = 'superseded', released_at = ? WHERE boundary_id = 'boundary-one'",
      ).run(NOW);
      database.exec(`
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('message-proposal', 'room-project', 'human-owner', 'human', 'Proposal', '${NOW}');
        INSERT INTO message_revisions (
          message_id, revision, body, revised_at, revised_by_actor_id
        ) VALUES ('message-proposal', 1, 'Proposal', '${NOW}', 'human-owner');
        INSERT INTO message_envelopes (
          message_id, room_id, message_kind, lifecycle, current_revision, revision_count, created_at
        ) VALUES ('message-proposal', 'room-project', 'human', 'active', 1, 1, '${NOW}');
      `);
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.create",
        context: {
          kind: "human", sessionId: "s".repeat(43), sessionFamilyId: "f".repeat(43),
          principal: { accountId: "account-owner", actorId: "human-owner" },
          requestId: "request-proposal", idempotencyKey: "proposal-key",
        },
        command: {
          proposalId: "proposal-goal", roomId: "room-project", projectId: "room-project",
          factKind: "goal", factId: "goal-one", baseRevision: 0,
          principalActorId: "human-owner", expiresAt: "2026-08-26T08:00:00.000Z",
          payload: { title: "Ship FT-09", description: "Close the Project Loop" },
          source: { roomId: "room-project", sourceId: "message-proposal", sourceRevision: 1,
            visibility: "room", kind: "message" },
        },
        now: Date.parse(NOW),
      });
      expect(database.prepare(
        `SELECT source_kind AS sourceKind, source_id AS sourceId,
                source_revision AS sourceRevision, holder_kind AS holderKind,
                holder_actor_id AS holderActorId, reason, status
         FROM project_ball_boundaries
         WHERE room_id = 'room-project' AND source_kind = 'confirmation' AND status = 'active'`,
      ).all()).toEqual([{
        sourceKind: "confirmation", sourceId: "confirmation:proposal-goal", sourceRevision: 1,
        holderKind: "human", holderActorId: "human-owner",
        reason: "pending_confirmation", status: "active",
      }]);
      executeProjectLoopAuthorityOperation(database, {
        type: "project-loop.proposal.resolve",
        context: {
          kind: "human", sessionId: "s".repeat(43), sessionFamilyId: "f".repeat(43),
          principal: { accountId: "account-owner", actorId: "human-owner" },
          requestId: "request-confirm", idempotencyKey: "confirm-key",
        },
        command: {
          proposalId: "proposal-goal", roomId: "room-project", projectId: "room-project",
          expectedRevision: 1, resolution: "confirmed", reason: null,
        },
        now: Date.parse(NOW) + 1,
      });
      expect(database.prepare(
        `SELECT status, released_at AS releasedAt FROM project_ball_boundaries
         WHERE source_kind = 'confirmation' AND source_id = 'confirmation:proposal-goal'`,
      ).get()).toEqual({
        status: "superseded", releasedAt: new Date(Date.parse(NOW) + 1).toISOString(),
      });
      const archivedAt = new Date(Date.parse(NOW) + 2).toISOString();
      database.prepare("UPDATE rooms SET status = 'archived', archive_generation = 1 WHERE id = 'room-project'").run();
      expect(archiveProjectLoopBoundariesInTransaction(database, {
        roomId: "room-project", archiveGeneration: 1, previousLifecycleGeneration: 0,
        occurredAt: archivedAt,
      })).toMatchObject({ suspendedBoundaryCount: 1 });
      const reopenedAt = new Date(Date.parse(NOW) + 3).toISOString();
      database.prepare("UPDATE rooms SET status = 'active' WHERE id = 'room-project'").run();
      expect(reopenProjectLoopBoundariesInTransaction(database, {
        roomId: "room-project", archiveGeneration: 1, previousLifecycleGeneration: 1,
        occurredAt: reopenedAt,
      })).toMatchObject({ replacementBoundaryCount: 1 });
      expect(executeRuntimeAuthorityOperation(database, {
        type: "runtime.scan-project-agent-boundaries", providerId: "provider-one", agentProviderReady: true,
        modelId: "model-one", limit: 10, now: Date.parse(NOW) + 4,
      })).toMatchObject({ createdCount: 1, suppressedCount: 0 });
      expect(database.prepare(
        `SELECT intent.boundary_kind AS boundaryKind, intent.source_id AS sourceId,
                intent.source_revision AS sourceRevision, execution.public_status AS status
         FROM project_boundary_agent_invocation_intents AS intent
         JOIN project_boundary_agent_executions AS execution ON execution.intent_id = intent.intent_id`,
      ).get()).toEqual({
        boundaryKind: "checkpoint", sourceId: "project-checkpoint:room-project:2",
        sourceRevision: 2, status: "accepted",
      });
    } finally {
      close(database);
    }
  });
});

describe("FT-09 Project boundary Provider admission adversarial authority", () => {
  const accepted = Object.freeze({
    intentId: "intent-runtime", executionId: "execution-runtime",
    roomId: "room-project", projectId: "room-project", agentId: "agent-one",
    boundaryId: "boundary-runtime", boundaryKind: "due" as const,
    sourceKind: "next_action", sourceId: "action-one", sourceRevision: 4,
    lifecycleGeneration: 0, profileId: "profile-one", profileRevision: 3,
    assignmentId: "assignment-one", assignmentRevision: 5, accessRevision: 7,
    checkpointId: "checkpoint-one", checkpointRevision: 9,
    checkpointSha256: CHECKPOINT_HASH,
    checkpointProjectionJson: '{"recordVersion":"project-loop.v1"}',
    providerId: "provider-one", modelId: "model-one", status: "accepted" as const,
    version: 1,
  });

  it("makes zero Provider calls when the pre-provider authority recheck rejects", async () => {
    const stream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: "completed", sequence: 1 };
    });
    const authority = { executeRuntime: vi.fn(async (operation: Record<string, unknown>) =>
      operation.type === "runtime.scan-project-boundary-executions"
        ? { kind: "project-boundary-executions", records: [accepted] }
        : { kind: "project-boundary-execution", execution: null }) };
    await createProjectBoundaryRuntime({ authority, provider: { id: "provider-one", stream } }).scan();
    expect(stream).not.toHaveBeenCalled();
    expect(authority.executeRuntime).toHaveBeenCalledTimes(2);
  });

  it("rejects a checkpoint whose bytes do not match its frozen digest before Provider", async () => {
    const stream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: "completed", sequence: 1 };
    });
    const authority = { executeRuntime: vi.fn(async (operation: Record<string, unknown>) => {
      if (operation.type === "runtime.scan-project-boundary-executions") {
        return { kind: "project-boundary-executions", records: [{
          ...accepted, checkpointSha256: "b".repeat(64),
        }] };
      }
      if (operation.type === "runtime.begin-project-boundary-execution") {
        return { kind: "project-boundary-execution", execution: {
          ...accepted, status: "running", version: 2,
        } };
      }
      return { kind: "project-boundary-execution", execution: {
        ...accepted, status: "failed", version: 3,
      } };
    }) };
    await expect(createProjectBoundaryRuntime({
      authority, provider: { id: "provider-one", stream },
    }).scan()).rejects.toThrow("malformed");
    expect(stream).not.toHaveBeenCalled();
    expect(authority.executeRuntime).toHaveBeenCalledTimes(1);
  });
});
