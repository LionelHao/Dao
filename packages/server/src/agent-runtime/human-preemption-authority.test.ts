import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  seedCanonicalAgentProfileFixture,
  seedCanonicalRoomAssignmentFixture,
} from "../fixtures/agent-authority-fixture.js";
import {
  executeHumanDatabaseCommand,
  executeRouteAuthorityOperation,
  executeRuntimeAuthorityOperation,
  recallHumanMessageDatabaseCommand,
} from "../persistence/authority-database-handler.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { createWorkerDatabaseClient } from "../persistence/worker-database-client.js";

const directories: string[] = [];
const accessToken = Buffer.alloc(32, 11).toString("base64url");
const refreshToken = Buffer.alloc(32, 12).toString("base64url");
const familyToken = Buffer.alloc(32, 13).toString("base64url");
const t0 = Date.parse("2026-08-17T00:00:00.000Z");

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "dao-human-preemption-"));
  directories.push(directory);
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json, readiness)
    VALUES
      ('human-1', 'human', 'Human One', '[]', 'ready'),
      ('agent-1', 'agent', 'Agent One', '[]', 'busy'),
      ('agent-2', 'agent', 'Agent Two', '[]', 'busy');
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-1', 'Room', 'active', '2026-08-17T00:00:00.000Z');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES
      ('identity', 'human-1', 0, 1),
      ('identity', 'agent-1', 0, 1),
      ('identity', 'agent-2', 0, 1),
      ('room', 'room-1', 0, 1);
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, joined_at, configured_at
    ) VALUES
      ('room-1', 'human-1', 'human', 'member', NULL, '2026-08-17T00:00:00.000Z', NULL),
      ('room-1', 'agent-1', 'agent', NULL, 'active', NULL, '2026-08-17T00:00:00.000Z'),
      ('room-1', 'agent-2', 'agent', NULL, 'active', NULL, '2026-08-17T00:00:00.000Z');
    UPDATE rooms SET owner_actor_id = 'human-1', governance_revision = 1 WHERE id = 'room-1';
  `);
  const profile1 = seedCanonicalAgentProfileFixture(database, {
    actorId: "agent-1", displayName: "Agent One",
  });
  const profile2 = seedCanonicalAgentProfileFixture(database, {
    actorId: "agent-2", displayName: "Agent Two",
  });
  seedCanonicalRoomAssignmentFixture(database, {
    assignmentId: "assignment-agent-1", roomId: "room-1", profileId: profile1,
    actorId: "agent-1", participation: "active",
  });
  seedCanonicalRoomAssignmentFixture(database, {
    assignmentId: "assignment-agent-2", roomId: "room-1", profileId: profile2,
    actorId: "agent-2", participation: "active",
  });
  database.prepare(
    `INSERT INTO session_families (
       family_id, public_id, account_id, actor_id, device_id, device_label,
       platform, created_at, refresh_expires_at, revoked_at
     ) VALUES (?, ?, 'account-1', 'human-1', 'test', 'Test', 'unknown', ?, ?, NULL)`,
  ).run(familyToken, `test_${familyToken}`, t0, t0 + 7_200_000);
  database.prepare(
    `INSERT INTO sessions (
       family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
       access_expires_at, refresh_expires_at
     ) VALUES (?, 'account-1', 'human-1', ?, ?, ?, ?)`,
  ).run(familyToken, accessToken, refreshToken, t0 + 3_600_000, t0 + 7_200_000);
  return database;
}

const humanContext = {
  kind: "human", sessionId: accessToken, sessionFamilyId: familyToken,
  principal: { accountId: "account-1", actorId: "human-1" },
  requestId: "human-command", idempotencyKey: "human-command",
} as const;
function sendAgentSource(database: DatabaseSync, index: number): string {
  const id = `message-agent-source-${index}`;
  executeHumanDatabaseCommand(database, {
    context: { ...humanContext, requestId: id, idempotencyKey: id },
    command: { type: "message.send", roomId: "room-1", payload: {
      id, roomId: "room-1", body: `source ${index}`,
      sentAt: new Date(t0 + index * 1_000).toISOString(),
    } },
    now: t0 + index * 1_000,
  });
  return id;
}

function invoke(database: DatabaseSync, sourceMessageId: string, executionId: string, targetAgentId: string): void {
  const authority = database.prepare(
    `SELECT profile.id AS profileId, profile.revision AS profileRevision,
            assignment.id AS assignmentId, assignment.revision AS assignmentRevision,
            membership.access_revision AS accessRevision
     FROM agent_profiles AS profile
     JOIN room_agent_assignments AS assignment
       ON assignment.profile_id = profile.id AND assignment.room_id = 'room-1'
      AND assignment.agent_actor_id = profile.actor_id AND assignment.status = 'current'
     JOIN room_memberships AS membership
       ON membership.room_id = assignment.room_id
      AND membership.actor_id = assignment.agent_actor_id
     WHERE profile.actor_id = ?`,
  ).get(targetAgentId) as {
    profileId: string; profileRevision: number; assignmentId: string;
    assignmentRevision: number; accessRevision: number;
  };
  const targetId = `target-${executionId}`;
  const intentId = `intent-${executionId}`;
  const createdAt = new Date(t0 + 10_000).toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(
      `INSERT INTO message_mentions (
         message_id, room_id, target_id, target_kind, target_actor_id,
         range_start_utf16, range_end_utf16, target_order
       ) VALUES (?, 'room-1', ?, 'agent-invocation', ?, 0, 1, 0)`,
    ).run(sourceMessageId, targetId, targetAgentId);
    database.prepare(
      `INSERT INTO agent_invocation_intents (
         id, room_id, source_message_id, target_agent_id, requester_actor_id,
         intent_kind, execution_id, created_at, message_transaction_id, target_id,
         source_revision, lineage_id, turn_id, origin_kind, status
       ) VALUES (?, 'room-1', ?, ?, 'human-1', 'direct_mention', NULL, ?, ?, ?,
                 1, ?, ?, 'message_target', 'pending')`,
    ).run(intentId, sourceMessageId, targetAgentId, createdAt,
      sourceMessageId, targetId, `lineage-${executionId}`, `turn-${executionId}`);
    database.prepare(
      `INSERT INTO direct_agent_invocation_authority_bindings (
         intent_id, profile_id, profile_revision, assignment_id,
         assignment_revision, access_revision
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(intentId, authority.profileId, authority.profileRevision, authority.assignmentId,
      authority.assignmentRevision, authority.accessRevision);
    database.prepare(
      `INSERT INTO message_target_outcomes (
         message_id, room_id, target_id, target_actor_id, target_kind, status,
         request_intent_id, invocation_intent_id, rejection_code, created_at
       ) VALUES (?, 'room-1', ?, ?, 'agent-invocation', 'invocation-intent-created',
                 NULL, ?, NULL, ?)`,
    ).run(sourceMessageId, targetId, targetAgentId, intentId, createdAt);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  executeRuntimeAuthorityOperation(database, {
    type: "runtime.invoke", context: {
      ...humanContext, requestId: `invoke-${executionId}`, idempotencyKey: `invoke-${executionId}`,
    },
    intent: { kind: "direct_mention", roomId: "room-1", sourceMessageId, targetAgentId },
    executionId, intentId, providerId: "provider", modelId: "model",
    now: t0 + 10_000,
  });
}

function makeRunning(
  database: DatabaseSync,
  executionId: string,
  actionCategory: "model_generation" | "waiting_upstream" | "tool_call",
  toolDispatchPhase?: "not_started" | "dispatched",
): void {
  database.prepare(
    `UPDATE agent_executions
     SET status = 'running', started_at = ?, updated_at = ?, action_category = ?,
         tool_dispatch_phase = ?, tool_name = ?
     WHERE id = ?`,
  ).run(new Date(t0 + 11_000).toISOString(), new Date(t0 + 11_000).toISOString(),
    actionCategory, toolDispatchPhase ?? null,
    actionCategory === "tool_call" ? "sandbox-file.write" : "model.generate", executionId);
  database.prepare(
    `UPDATE agent_execution_attempts SET status = 'running', started_at = ?, action_category = ?
     WHERE execution_id = ? AND attempt_seq = 1`,
  ).run(new Date(t0 + 11_000).toISOString(), actionCategory, executionId);
}

describe("real SQLite human-preemption authority", () => {
  it("never rebuilds or claims legacy Room-wide routes from a recalled Human source", () => {
    const database = fixture();
    const sendHuman = (messageId: string, body: string, offset: number): void => {
      executeHumanDatabaseCommand(database, {
        context: {
          ...humanContext,
          requestId: `send-${messageId}`,
          idempotencyKey: `send-${messageId}`,
        },
        command: { type: "message.send", roomId: "room-1", payload: {
          id: messageId,
          roomId: "room-1",
          body,
          sentAt: new Date(t0 + offset).toISOString(),
        } },
        now: t0 + offset,
      });
    };
    const recallHuman = (messageId: string, offset: number): void => {
      recallHumanMessageDatabaseCommand(database, {
        context: {
          ...humanContext,
          requestId: `recall-${messageId}`,
          idempotencyKey: `recall-${messageId}`,
        },
        command: { roomId: "room-1", messageId, expectedRevision: 1 },
        now: t0 + offset,
      });
    };

    sendHuman("human-recalled-pending", "RECALLED-ROUTE-RAW-PENDING-91C2", 20_000);
    recallHuman("human-recalled-pending", 20_001);
    expect(executeRuntimeAuthorityOperation(database, {
      type: "runtime.list-pending-human-fences",
      now: t0 + 20_002,
    })).toEqual({ kind: "pending-human-fences", sourceHumanMessageIds: [] });

    sendHuman("human-recalled-before-route", "RECALLED-ROUTE-RAW-CREATE-74E1", 21_000);
    executeRuntimeAuthorityOperation(database, {
      type: "runtime.cancel-for-human-fence",
      sourceHumanMessageId: "human-recalled-before-route",
      now: t0 + 21_001,
    });
    recallHuman("human-recalled-before-route", 21_002);
    expect(() => executeRuntimeAuthorityOperation(database, {
      type: "runtime.create-route-after-human-fence",
      sourceHumanMessageId: "human-recalled-before-route",
      now: t0 + 21_003,
    })).toThrow(/recalled|fence|conflict|cancellation.*route/i);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM route_jobs WHERE source_message_id = 'human-recalled-before-route'",
    ).get()).toEqual({ count: 0 });

    sendHuman("human-recalled-before-claim", "RECALLED-ROUTE-RAW-CLAIM-CE38", 22_000);
    executeRuntimeAuthorityOperation(database, {
      type: "runtime.cancel-for-human-fence",
      sourceHumanMessageId: "human-recalled-before-claim",
      now: t0 + 22_001,
    });
    executeRuntimeAuthorityOperation(database, {
      type: "runtime.create-route-after-human-fence",
      sourceHumanMessageId: "human-recalled-before-claim",
      now: t0 + 22_002,
    });
    recallHuman("human-recalled-before-claim", 22_003);
    expect(() => executeRouteAuthorityOperation(database, {
      type: "route.claim",
      sourceMessageId: "human-recalled-before-claim",
      now: t0 + 22_004,
    })).toThrow(/recalled|fence|conflict|no longer active/i);
    expect(database.prepare(
      `SELECT status FROM route_jobs
       WHERE source_message_id = 'human-recalled-before-claim'`,
    ).get()).toEqual({ status: "queued" });
    database.close();
  });

  it("commits the eligibility matrix before route creation, fences late results, and replaces only the selected Agent", () => {
    let database = fixture();
    const sources = [1, 2, 3, 4, 5].map((index) => sendAgentSource(database, index));
    invoke(database, sources[0]!, "execution-queued", "agent-1");
    invoke(database, sources[1]!, "execution-waiting", "agent-1");
    invoke(database, sources[2]!, "execution-tool-not-started", "agent-1");
    invoke(database, sources[3]!, "execution-generating", "agent-2");
    invoke(database, sources[4]!, "execution-tool-dispatched", "agent-2");
    makeRunning(database, "execution-waiting", "waiting_upstream");
    makeRunning(database, "execution-tool-not-started", "tool_call", "not_started");
    makeRunning(database, "execution-generating", "model_generation");
    makeRunning(database, "execution-tool-dispatched", "tool_call", "dispatched");

    executeHumanDatabaseCommand(database, {
      context: { ...humanContext, requestId: "human-message-1", idempotencyKey: "human-message-1" },
      command: { type: "message.send", roomId: "room-1", payload: {
        id: "human-message-1", roomId: "room-1", body: "Human takes the floor",
        sentAt: new Date(t0 + 20_000).toISOString(),
      } },
      now: t0 + 20_000,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM route_jobs WHERE source_message_id = 'human-message-1'",
    ).get()).toEqual({ count: 0 });
    const databasePath = String(database.prepare("PRAGMA database_list").get()?.file);
    database.close();
    database = new DatabaseSync(databasePath);
    migrateAuthorityDatabase(database);
    expect(executeRuntimeAuthorityOperation(database, {
      type: "runtime.list-pending-human-fences", now: t0 + 20_000,
    })).toEqual({
      kind: "pending-human-fences",
      sourceHumanMessageIds: [...sources, "human-message-1"],
    });
    expect(() => executeRuntimeAuthorityOperation(database, {
      type: "runtime.claim", executionId: "execution-queued", attemptSeq: 1,
      now: t0 + 20_001,
    })).toThrow(/human fence|stale|conflict/i);
    expect(() => executeRuntimeAuthorityOperation(database, {
      type: "runtime.complete", executionId: "execution-waiting", attemptSeq: 1,
      messageId: "pre-fence-race-message", body: "must not pass human", now: t0 + 20_001,
    })).toThrow(/human fence|stale|conflict/i);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE id = 'pre-fence-race-message'",
    ).get()).toEqual({ count: 0 });
    expect(executeRuntimeAuthorityOperation(database, {
      type: "runtime.complete", executionId: "execution-generating", attemptSeq: 1,
      messageId: "allowed-generating-message", body: "generation already started", now: t0 + 20_001,
    })).toMatchObject({ kind: "execution", execution: { status: "completed" } });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM route_jobs WHERE source_message_id = 'allowed-generating-message'",
    ).get()).toEqual({ count: 0 });

    const cancelled = executeRuntimeAuthorityOperation(database, {
      type: "runtime.cancel-for-human-fence", sourceHumanMessageId: "human-message-1", now: t0 + 20_001,
    });
    expect(cancelled).toMatchObject({
      kind: "human-fence-cancelled",
      notice: {
        sourceHumanMessageId: "human-message-1", rerouteStatus: "queued",
        cancelledExecutionIds: [
          "execution-queued", "execution-tool-not-started", "execution-waiting",
        ],
      },
    });
    expect(database.prepare(
      `SELECT id, status FROM agent_executions
       WHERE id IN ('execution-generating', 'execution-tool-dispatched') ORDER BY id`,
    ).all()).toEqual([
      { id: "execution-generating", status: "completed" },
      { id: "execution-tool-dispatched", status: "running" },
    ]);
    expect(() => executeRuntimeAuthorityOperation(database, {
      type: "runtime.complete", executionId: "execution-queued", attemptSeq: 1,
      messageId: "late-agent-message", body: "late", now: t0 + 20_002,
    })).toThrow(/running|stale|conflict/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = 'late-agent-message'").get())
      .toEqual({ count: 0 });

    const replayedCancellation = executeRuntimeAuthorityOperation(database, {
      type: "runtime.cancel-for-human-fence", sourceHumanMessageId: "human-message-1", now: t0 + 20_003,
    });
    expect(replayedCancellation).toEqual(cancelled);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.human_preemption.applied'",
    ).get()).toEqual({ count: 1 });

    const routed = executeRuntimeAuthorityOperation(database, {
      type: "runtime.create-route-after-human-fence", sourceHumanMessageId: "human-message-1", now: t0 + 20_004,
    });
    expect(routed).toMatchObject({ kind: "human-fence-route", replayed: false });
    if (routed.kind !== "human-fence-route") throw new Error("unexpected route result");
    const claim = executeRouteAuthorityOperation(database, {
      type: "route.claim", sourceMessageId: "human-message-1", now: t0 + 20_005,
    });
    if (claim.kind !== "route-claimed") throw new Error("unexpected claim result");
    executeRouteAuthorityOperation(database, {
      type: "route.complete", routeJobId: claim.job.id, attempt: claim.job.currentAttempt,
      judgments: [
        { id: "judgment-agent-1", routeJobId: claim.job.id, sourceMessageId: "human-message-1",
          agentId: "agent-1", outcome: "will_respond", reasonCode: "domain_match",
          reasonText: "selected after human fence", routeAttempt: 1,
          decidedAt: new Date(t0 + 20_006).toISOString() },
        { id: "judgment-agent-2", routeJobId: claim.job.id, sourceMessageId: "human-message-1",
          agentId: "agent-2", outcome: "suppressed", reasonCode: "provider_omitted",
          reasonText: "not selected", routeAttempt: 1,
          decidedAt: new Date(t0 + 20_006).toISOString() },
      ],
      intents: [{ kind: "routed_candidate", roomId: "room-1", sourceMessageId: "human-message-1",
        targetAgentId: "agent-1", reasonCode: "domain_match", reasonText: "selected after human fence",
        priority: 3 }],
      now: t0 + 20_006,
    });
    const replacement = executeRuntimeAuthorityOperation(database, {
      type: "runtime.enqueue-fence-replacements", routeJobId: routed.routeJobId,
      targetAgentId: "agent-1", providerId: "provider", modelId: "model", now: t0 + 20_007,
    });
    expect(replacement).toMatchObject({
      kind: "human-fence-replacements", replayed: false,
      executions: [{ status: "queued", retryOrdinal: 1, supersedesExecutionIds: [
        "execution-queued", "execution-tool-not-started", "execution-waiting",
      ] }],
    });
    const replayedReplacement = executeRuntimeAuthorityOperation(database, {
      type: "runtime.enqueue-fence-replacements", routeJobId: routed.routeJobId,
      targetAgentId: "agent-1", providerId: "provider", modelId: "model", now: t0 + 20_008,
    });
    expect(replayedReplacement).toMatchObject({
      kind: "human-fence-replacements", replayed: true,
      executions: [{ id: replacement.kind === "human-fence-replacements"
        ? replacement.executions[0]?.id : "missing" }],
    });
    expect(() => executeRuntimeAuthorityOperation(database, {
      type: "runtime.enqueue-fence-replacements", routeJobId: routed.routeJobId,
      targetAgentId: "agent-2", providerId: "provider", modelId: "model", now: t0 + 20_009,
    })).toThrow(/selected route judgment/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_fence_replacements").get())
      .toEqual({ count: 3 });
    const replacementId = replacement.kind === "human-fence-replacements"
      ? replacement.executions[0]!.id : "missing";
    executeHumanDatabaseCommand(database, {
      context: { ...humanContext, requestId: "human-message-2", idempotencyKey: "human-message-2" },
      command: { type: "message.send", roomId: "room-1", payload: {
        id: "human-message-2", roomId: "room-1", body: "Human continues before replacement runs",
        sentAt: new Date(t0 + 30_000).toISOString(),
      } },
      now: t0 + 30_000,
    });
    const secondCancellation = executeRuntimeAuthorityOperation(database, {
      type: "runtime.cancel-for-human-fence", sourceHumanMessageId: "human-message-2", now: t0 + 30_001,
    });
    expect(secondCancellation).toMatchObject({
      kind: "human-fence-cancelled",
      notice: { cancelledExecutionIds: [replacementId] },
    });
    expect(executeRuntimeAuthorityOperation(database, {
      type: "runtime.create-route-after-human-fence", sourceHumanMessageId: "human-message-2", now: t0 + 30_002,
    })).toMatchObject({ kind: "human-fence-route", replayed: false });
    expect(executeRuntimeAuthorityOperation(database, {
      type: "runtime.cancel-for-human-fence", sourceHumanMessageId: "human-message-2", now: t0 + 30_003,
    })).toEqual(secondCancellation);
    expect(database.prepare(
      `SELECT execution.status, attempt.status AS attemptStatus
       FROM agent_executions AS execution
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = execution.id AND attempt.attempt_seq = execution.current_attempt_seq
       WHERE execution.id = ?`,
    ).get(replacementId)).toEqual({ status: "cancelled", attemptStatus: "cancelled" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.human_preemption.applied'",
    ).get()).toEqual({ count: 2 });
    database.close();
  });

  it("recovers a durable human fence exactly once across real AuthorityWorker restarts", async () => {
    const database = fixture();
    const source = sendAgentSource(database, 1);
    invoke(database, source, "execution-worker-restart", "agent-1");
    executeHumanDatabaseCommand(database, {
      context: { ...humanContext, requestId: "human-worker-restart", idempotencyKey: "human-worker-restart" },
      command: { type: "message.send", roomId: "room-1", payload: {
        id: "human-worker-restart", roomId: "room-1", body: "durable before worker crash",
        sentAt: new Date(t0 + 20_000).toISOString(),
      } },
      now: t0 + 20_000,
    });
    const databasePath = String(database.prepare("PRAGMA database_list").get()?.file);
    database.close();

    let worker = await createWorkerDatabaseClient({ databasePath });
    await expect(worker.executeRuntime({
      type: "runtime.list-pending-human-fences", now: t0 + 20_001,
    })).resolves.toEqual({
      kind: "pending-human-fences", sourceHumanMessageIds: [source, "human-worker-restart"],
    });
    const first = await worker.executeRuntime({
      type: "runtime.cancel-for-human-fence", sourceHumanMessageId: "human-worker-restart",
      now: t0 + 20_002,
    });
    await worker.close();

    worker = await createWorkerDatabaseClient({ databasePath });
    await expect(worker.executeRuntime({
      type: "runtime.cancel-for-human-fence", sourceHumanMessageId: "human-worker-restart",
      now: t0 + 20_003,
    })).resolves.toEqual(first);
    await expect(worker.executeRuntime({
      type: "runtime.create-route-after-human-fence", sourceHumanMessageId: "human-worker-restart",
      now: t0 + 20_004,
    })).resolves.toMatchObject({ kind: "human-fence-route", replayed: false });
    await expect(worker.executeRuntime({
      type: "runtime.list-pending-human-fences", now: t0 + 20_005,
    })).resolves.toEqual({ kind: "pending-human-fences", sourceHumanMessageIds: [source] });
    await worker.close();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare(
      `SELECT execution.status, execution.cancellation_reason AS cancellationReason,
              attempt.status AS attemptStatus
       FROM agent_executions AS execution
       JOIN agent_execution_attempts AS attempt
         ON attempt.execution_id = execution.id AND attempt.attempt_seq = 1
       WHERE execution.id = 'execution-worker-restart'`,
    ).get()).toEqual({
      status: "cancelled",
      cancellationReason: "human_preempted:human-worker-restart",
      attemptStatus: "cancelled",
    });
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM human_preemption_fences WHERE source_human_message_id = 'human-worker-restart'",
    ).get()).toEqual({ count: 1 });
    inspection.close();
  });
});
