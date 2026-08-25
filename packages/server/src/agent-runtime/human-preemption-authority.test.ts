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
import type { RuntimeRecoveryRecord } from "./contracts.js";

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
      room_id, actor_id, kind, role, participation, joined_at, configured_at,
      access_revision
    ) VALUES
      ('room-1', 'human-1', 'human', 'member', NULL, '2026-08-17T00:00:00.000Z', NULL, 1),
      ('room-1', 'agent-1', 'agent', NULL, 'active', NULL, '2026-08-17T00:00:00.000Z', 1),
      ('room-1', 'agent-2', 'agent', NULL, 'active', NULL, '2026-08-17T00:00:00.000Z', 1);
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

function cloneRuntimeRow(
  database: DatabaseSync,
  table: string,
  sourceWhere: string,
  sourceParameters: readonly (string | number)[],
  overrides: Readonly<Record<string, string | number | null>>,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all()
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
  const overrideValues: (string | number | null)[] = [];
  const selection = columns.map((column) => {
    if (!Object.hasOwn(overrides, column)) return `"${column}"`;
    overrideValues.push(overrides[column]!);
    return "?";
  });
  database.prepare(
    `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(", ")})
     SELECT ${selection.join(", ")} FROM ${table} WHERE ${sourceWhere}`,
  ).run(...overrideValues, ...sourceParameters);
}

function cloneQueuedInvocation(
  database: DatabaseSync,
  sourceExecutionId: string,
  sourceIntentId: string,
  ordinal: number,
): void {
  const executionId = `execution-recovery-${String(ordinal).padStart(4, "0")}`;
  const intentId = `intent-recovery-${String(ordinal).padStart(4, "0")}`;
  const targetId = `target-recovery-${String(ordinal).padStart(4, "0")}`;
  const messageId = `message-recovery-${String(ordinal).padStart(4, "0")}`;
  const queuedAt = new Date(t0 + 20_000 + ordinal).toISOString();
  executeHumanDatabaseCommand(database, {
    context: { ...humanContext, requestId: messageId, idempotencyKey: messageId },
    command: { type: "message.send", roomId: "room-1", payload: {
      id: messageId, roomId: "room-1", body: "x", sentAt: queuedAt,
    } },
    now: t0 + 20_000 + ordinal,
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    cloneRuntimeRow(database, "message_mentions", `message_id = (
    SELECT source_message_id FROM agent_invocation_intents WHERE id = ?
  ) AND target_id = (
    SELECT target_id FROM agent_invocation_intents WHERE id = ?
  )`, [sourceIntentId, sourceIntentId], {
    message_id: messageId,
    target_id: targetId,
    range_start_utf16: 0,
    range_end_utf16: 1,
    target_order: 0,
  });
  cloneRuntimeRow(database, "agent_invocation_intents", "id = ?", [sourceIntentId], {
    id: intentId,
    execution_id: null,
    source_message_id: messageId,
    message_transaction_id: messageId,
    target_id: targetId,
    lineage_id: `lineage-recovery-${ordinal}`,
    turn_id: `turn-recovery-${ordinal}`,
    created_at: queuedAt,
    status: "pending",
    claimed_at: null,
  });
  cloneRuntimeRow(database, "direct_agent_invocation_authority_bindings", "intent_id = ?", [sourceIntentId], {
    intent_id: intentId,
  });
  cloneRuntimeRow(database, "message_target_outcomes", "invocation_intent_id = ?", [sourceIntentId], {
    message_id: messageId,
    target_id: targetId,
    invocation_intent_id: intentId,
    created_at: queuedAt,
  });
  cloneRuntimeRow(database, "agent_executions", "id = ?", [sourceExecutionId], {
    id: executionId,
    trigger_message_id: messageId,
    queued_at: queuedAt,
    updated_at: queuedAt,
  });
  cloneRuntimeRow(database, "agent_execution_attempts", "execution_id = ? AND attempt_seq = 1", [sourceExecutionId], {
    execution_id: executionId,
  });
  cloneRuntimeRow(database, "agent_execution_intent_links", "execution_id = ?", [sourceExecutionId], {
    intent_id: intentId,
    execution_id: executionId,
    linked_at: queuedAt,
  });
    database.prepare(
      "UPDATE agent_invocation_intents SET status = 'claimed', claimed_at = ? WHERE id = ?",
    ).run(queuedAt, intentId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

describe("real SQLite human-preemption authority", () => {
  it("drains 257/513/1025 durable recovery candidates by stable 256-row keysets", () => {
    const database = fixture();
    const sourceMessageId = "message-recovery-source";
    executeHumanDatabaseCommand(database, {
      context: { ...humanContext, requestId: sourceMessageId, idempotencyKey: sourceMessageId },
      command: { type: "message.send", roomId: "room-1", payload: {
        id: sourceMessageId,
        roomId: "room-1",
        body: "x".repeat(1_100),
        sentAt: new Date(t0 + 90_000).toISOString(),
      } },
      now: t0 + 90_000,
    });
    invoke(database, sourceMessageId, "execution-recovery-0000", "agent-1");
    const sourceIntentId = database.prepare(
      "SELECT intent_id AS intentId FROM agent_execution_intent_links WHERE execution_id = ?",
    ).get("execution-recovery-0000")?.intentId;
    expect(typeof sourceIntentId).toBe("string");

    let seeded = 1;
    for (const [generation, candidateCount] of [257, 513, 1_025].entries()) {
      while (seeded < candidateCount) {
        cloneQueuedInvocation(
          database,
          "execution-recovery-0000",
          sourceIntentId as string,
          seeded,
        );
        seeded += 1;
      }
      let after: string | undefined;
      const cursors: string[] = [];
      let scans = 0;
      let scanComplete = false;
      const scanNow = t0 + 100_000 + generation * 20_000;
      const leaseOwner = `recovery-worker-${generation}`;
      const leaseExpiresAt = new Date(scanNow + 10_000).toISOString();
      while (!scanComplete) {
        const page = executeRuntimeAuthorityOperation(database, {
          type: "runtime.recovery-scan",
          ...(after === undefined ? {} : { after }),
          limit: 256,
          includeRunning: false,
          leaseOwner,
          leaseExpiresAt,
          now: scanNow,
        });
        expect(page.kind).toBe("recovery-page");
        if (page.kind !== "recovery-page") throw new Error("unexpected recovery result");
        scans += 1;
        cursors.push(...page.candidates.map((candidate) => candidate.cursor));
        after = page.candidates.at(-1)?.cursor;
        scanComplete = page.candidates.length === 0;
      }
      expect(cursors).toHaveLength(candidateCount);
      expect(cursors).toEqual([...cursors].sort());
      expect(new Set(cursors).size).toBe(candidateCount);
      expect(scans).toBe(Math.ceil(candidateCount / 256) + 1);
    }

    let finalAfter: string | undefined;
    const finalCandidates: Array<{
      cursor: string;
      record: RuntimeRecoveryRecord;
    }> = [];
    do {
      const page = executeRuntimeAuthorityOperation(database, {
        type: "runtime.recovery-scan",
        ...(finalAfter === undefined ? {} : { after: finalAfter }),
        limit: 256,
        includeRunning: false,
        leaseOwner: "recovery-worker-final",
        leaseExpiresAt: new Date(t0 + 170_000).toISOString(),
        now: t0 + 160_000,
      });
      expect(page.kind).toBe("recovery-page");
      if (page.kind !== "recovery-page") throw new Error("unexpected recovery result");
      finalCandidates.push(...page.candidates);
      finalAfter = page.candidates.at(-1)?.cursor;
      if (page.candidates.length === 0) break;
    } while (finalAfter !== undefined);
    const success = finalCandidates.find(({ record }) =>
      record.execution.id === "execution-recovery-1024")!;
    const poison = finalCandidates.find(({ record }) =>
      record.execution.id !== success.record.execution.id)!;
    executeRuntimeAuthorityOperation(database, {
      type: "runtime.recovery-isolate",
      cursor: poison.cursor,
      candidateId: poison.record.execution.id,
      leaseOwner: "recovery-worker-final",
      reason: "recovery_candidate_invalid",
      now: t0 + 160_001,
    });
    executeRuntimeAuthorityOperation(database, {
      type: "runtime.claim",
      executionId: success.record.execution.id,
      attemptSeq: success.record.execution.currentAttemptSeq,
      now: t0 + 160_002,
    });
    executeRuntimeAuthorityOperation(database, {
      type: "runtime.recovery-settle",
      cursor: success.cursor,
      candidateId: success.record.execution.id,
      leaseOwner: "recovery-worker-final",
      now: t0 + 160_003,
    });
    expect(database.prepare(
      `SELECT state, failure_code AS failureCode, review_required AS reviewRequired
       FROM invocation_recovery_queue WHERE execution_id = ?`,
    ).get(poison.record.execution.id)).toEqual({
      state: "dead_letter", failureCode: "recovery_candidate_invalid", reviewRequired: 1,
    });
    expect(database.prepare(
      `SELECT state, lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt
       FROM invocation_recovery_queue WHERE execution_id = ?`,
    ).get(success.record.execution.id)).toEqual({
      state: "closed", leaseOwner: null, leaseExpiresAt: null,
    });
  }, 15_000);

  it("atomically leases disjoint pages across workers and reclaims only expired leases", () => {
    const database = fixture();
    const sourceMessageId = "message-recovery-concurrency";
    executeHumanDatabaseCommand(database, {
      context: { ...humanContext, requestId: sourceMessageId, idempotencyKey: sourceMessageId },
      command: { type: "message.send", roomId: "room-1", payload: {
        id: sourceMessageId, roomId: "room-1", body: "x".repeat(300),
        sentAt: new Date(t0 + 90_000).toISOString(),
      } },
      now: t0 + 90_000,
    });
    invoke(database, sourceMessageId, "execution-recovery-0000", "agent-1");
    const sourceIntentId = database.prepare(
      "SELECT intent_id AS intentId FROM agent_execution_intent_links WHERE execution_id = ?",
    ).get("execution-recovery-0000")?.intentId;
    expect(typeof sourceIntentId).toBe("string");
    for (let index = 1; index < 257; index += 1) {
      cloneQueuedInvocation(database, "execution-recovery-0000", sourceIntentId as string, index);
    }
    const databasePath = database.prepare("PRAGMA database_list").get()?.file;
    expect(typeof databasePath).toBe("string");
    const secondWorker = new DatabaseSync(databasePath as string);
    secondWorker.exec("PRAGMA foreign_keys = ON");
    const scanNow = t0 + 100_000;
    try {
      const first = executeRuntimeAuthorityOperation(database, {
        type: "runtime.recovery-scan", limit: 128, includeRunning: false,
        leaseOwner: "worker-a", leaseExpiresAt: new Date(scanNow + 1_000).toISOString(),
        now: scanNow,
      });
      const second = executeRuntimeAuthorityOperation(secondWorker, {
        type: "runtime.recovery-scan", limit: 128, includeRunning: false,
        leaseOwner: "worker-b", leaseExpiresAt: new Date(scanNow + 10_000).toISOString(),
        now: scanNow,
      });
      expect(first.kind).toBe("recovery-page");
      expect(second.kind).toBe("recovery-page");
      if (first.kind !== "recovery-page" || second.kind !== "recovery-page") {
        throw new Error("unexpected recovery result");
      }
      const firstIds = new Set(first.candidates.map(({ record }) => record.execution.id));
      const secondIds = new Set(second.candidates.map(({ record }) => record.execution.id));
      expect(firstIds.size).toBe(128);
      expect(secondIds.size).toBe(128);
      expect([...firstIds].filter((id) => secondIds.has(id))).toEqual([]);
      const tail = executeRuntimeAuthorityOperation(database, {
        type: "runtime.recovery-scan", after: second.candidates.at(-1)!.cursor,
        limit: 1, includeRunning: false, leaseOwner: "worker-a",
        leaseExpiresAt: new Date(scanNow + 1_000).toISOString(), now: scanNow,
      });
      expect(tail.kind).toBe("recovery-page");
      if (tail.kind !== "recovery-page") throw new Error("unexpected recovery result");
      expect(tail.candidates).toHaveLength(1);
      expect(database.prepare(
        `SELECT state, lease_owner AS leaseOwner, COUNT(*) AS candidateCount
         FROM invocation_recovery_queue
         GROUP BY state, lease_owner ORDER BY state, lease_owner`,
      ).all()).toEqual([
        { state: "leased", leaseOwner: "worker-a", candidateCount: 129 },
        { state: "leased", leaseOwner: "worker-b", candidateCount: 128 },
      ]);

      const success = tail.candidates[0]!;
      expect(() => executeRuntimeAuthorityOperation(secondWorker, {
        type: "runtime.recovery-settle", cursor: success.cursor,
        candidateId: success.record.execution.id, leaseOwner: "worker-b", now: scanNow + 1,
      })).toThrow(/lease/i);
      executeRuntimeAuthorityOperation(database, {
        type: "runtime.claim", executionId: success.record.execution.id,
        attemptSeq: success.record.execution.currentAttemptSeq, now: scanNow + 1,
      });
      executeRuntimeAuthorityOperation(database, {
        type: "runtime.schedule-retry",
        executionId: success.record.execution.id,
        attemptSeq: 1,
        errorCode: "provider_timeout",
        nextRetryAt: new Date(scanNow + 3).toISOString(),
        now: scanNow + 2,
      });
      const rescheduled = executeRuntimeAuthorityOperation(secondWorker, {
        type: "runtime.recovery-scan", limit: 1, includeRunning: false,
        leaseOwner: "worker-d", leaseExpiresAt: new Date(scanNow + 1_000).toISOString(),
        now: scanNow + 4,
      });
      expect(rescheduled.kind).toBe("recovery-page");
      if (rescheduled.kind !== "recovery-page") throw new Error("unexpected recovery result");
      expect(rescheduled.candidates).toHaveLength(1);
      expect(rescheduled.candidates[0]?.record.execution).toMatchObject({
        id: success.record.execution.id,
        status: "queued",
        currentAttemptSeq: 2,
      });
      executeRuntimeAuthorityOperation(database, {
        type: "runtime.claim", executionId: success.record.execution.id,
        attemptSeq: 2, now: scanNow + 5,
      });
      const poison = first.candidates[0]!;
      executeRuntimeAuthorityOperation(database, {
        type: "runtime.recovery-isolate", cursor: poison.cursor,
        candidateId: poison.record.execution.id, leaseOwner: "worker-a",
        reason: "recovery_candidate_invalid", now: scanNow + 2,
      });
      const expired = first.candidates[1]!;
      expect(() => executeRuntimeAuthorityOperation(database, {
        type: "runtime.recovery-settle", cursor: expired.cursor,
        candidateId: expired.record.execution.id, leaseOwner: "worker-a",
        now: scanNow + 2_000,
      })).toThrow(/lease/i);

      const reclaimed = executeRuntimeAuthorityOperation(secondWorker, {
        type: "runtime.recovery-scan", limit: 256, includeRunning: false,
        leaseOwner: "worker-c", leaseExpiresAt: new Date(scanNow + 12_000).toISOString(),
        now: scanNow + 2_000,
      });
      expect(reclaimed.kind).toBe("recovery-page");
      if (reclaimed.kind !== "recovery-page") throw new Error("unexpected recovery result");
      const reclaimedIds = new Set(reclaimed.candidates.map(({ record }) => record.execution.id));
      expect(reclaimedIds.size).toBe(127);
      expect(reclaimedIds.has(success.record.execution.id)).toBe(false);
      expect(reclaimedIds.has(poison.record.execution.id)).toBe(false);
      expect([...reclaimedIds].filter((id) => secondIds.has(id))).toEqual([]);
      expect(database.prepare(
        `SELECT state, lease_owner AS leaseOwner, COUNT(*) AS candidateCount
         FROM invocation_recovery_queue
         GROUP BY state, lease_owner ORDER BY state, lease_owner`,
      ).all()).toEqual([
        { state: "closed", leaseOwner: null, candidateCount: 1 },
        { state: "dead_letter", leaseOwner: null, candidateCount: 1 },
        { state: "leased", leaseOwner: "worker-b", candidateCount: 128 },
        { state: "leased", leaseOwner: "worker-c", candidateCount: 127 },
      ]);
    } finally {
      secondWorker.close();
    }
  }, 10_000);

  it("releases a 257-row recovery page across capacity-bound close and restart", () => {
    const database = fixture();
    const sourceMessageId = "message-recovery-close";
    executeHumanDatabaseCommand(database, {
      context: { ...humanContext, requestId: sourceMessageId, idempotencyKey: sourceMessageId },
      command: { type: "message.send", roomId: "room-1", payload: {
        id: sourceMessageId, roomId: "room-1", body: "recover on restart",
        sentAt: new Date(t0 + 90_000).toISOString(),
      } },
      now: t0 + 90_000,
    });
    invoke(database, sourceMessageId, "execution-recovery-close-0000", "agent-1");
    const sourceIntentId = database.prepare(
      "SELECT intent_id AS intentId FROM agent_execution_intent_links WHERE execution_id = ?",
    ).get("execution-recovery-close-0000")?.intentId;
    expect(typeof sourceIntentId).toBe("string");
    for (let index = 1; index < 257; index += 1) {
      cloneQueuedInvocation(
        database,
        "execution-recovery-close-0000",
        sourceIntentId as string,
        index,
      );
    }

    const scanNow = t0 + 100_000;
    const leased = executeRuntimeAuthorityOperation(database, {
      type: "runtime.recovery-scan", limit: 256, includeRunning: false,
      leaseOwner: "closing-worker", leaseExpiresAt: new Date(scanNow + 300_000).toISOString(),
      now: scanNow,
    });
    expect(leased.kind).toBe("recovery-page");
    if (leased.kind !== "recovery-page") throw new Error("unexpected recovery result");
    expect(leased.candidates).toHaveLength(256);

    // Model the durable Room admission ceiling: 32 candidates reached local
    // admission, while the other 224 remain leased only by the recovery page.
    for (const [offset, candidate] of leased.candidates.slice(0, 32).entries()) {
      executeRuntimeAuthorityOperation(database, {
        type: "runtime.shutdown", executionId: candidate.record.execution.id,
        attemptSeq: candidate.record.execution.currentAttemptSeq, now: scanNow + offset + 1,
      });
    }
    const released = executeRuntimeAuthorityOperation(database, {
      type: "runtime.recovery-release", leaseOwner: "closing-worker", now: scanNow + 200,
    });
    expect(released).toEqual({ kind: "recovery-released", released: 224 });
    expect(database.prepare(
      `SELECT state, COUNT(*) AS candidateCount FROM invocation_recovery_queue
       GROUP BY state ORDER BY state`,
    ).all()).toEqual([
      { state: "closed", candidateCount: 32 },
      { state: "pending", candidateCount: 225 },
    ]);

    const restarted = executeRuntimeAuthorityOperation(database, {
      type: "runtime.recovery-scan", limit: 256, includeRunning: false,
      leaseOwner: "restarted-worker", leaseExpiresAt: new Date(scanNow + 600_000).toISOString(),
      now: scanNow + 300,
    });
    expect(restarted.kind).toBe("recovery-page");
    if (restarted.kind !== "recovery-page") throw new Error("unexpected recovery result");
    expect(restarted.candidates).toHaveLength(225);
    expect(new Set(restarted.candidates.map(({ record }) => record.execution.id)).size).toBe(225);
    expect(restarted.candidates.every(({ record }) => record.execution.status === "queued")).toBe(true);

    const terminal = restarted.candidates[0]!;
    executeRuntimeAuthorityOperation(database, {
      type: "runtime.shutdown", executionId: terminal.record.execution.id,
      attemptSeq: terminal.record.execution.currentAttemptSeq, now: scanNow + 301,
    });
    expect(database.prepare(
      `SELECT state, lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt
       FROM invocation_recovery_queue WHERE execution_id = ?`,
    ).get(terminal.record.execution.id)).toEqual({
      state: "closed", leaseOwner: null, leaseExpiresAt: null,
    });
  }, 10_000);

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
      agentProviderReady: true,
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
      type: "route.claim", sourceMessageId: "human-message-1",
      agentProviderReady: true, now: t0 + 20_005,
    });
    if (claim.kind !== "route-claimed") throw new Error("unexpected claim result");
    const completedRoute = executeRouteAuthorityOperation(database, {
      type: "route.complete", routeJobId: claim.job.id, attempt: claim.job.currentAttempt,
      judgments: [
        { id: "judgment-agent-1", routeJobId: claim.job.id, sourceMessageId: "human-message-1",
          agentId: "agent-1", outcome: "will_respond", reasonCode: "domain_match",
          reasonText: "selected after human fence", routeAttempt: 1,
          decidedAt: new Date(t0 + 20_006).toISOString() },
      ],
      intents: [{ kind: "routed_candidate", roomId: "room-1", sourceMessageId: "human-message-1",
        targetAgentId: "agent-1", reasonCode: "domain_match", reasonText: "selected after human fence",
        priority: 3 }],
      agentProviderReady: true,
      now: t0 + 20_006,
    });
    if (completedRoute.kind !== "route-completed" || completedRoute.handoffs.length !== 1) {
      throw new Error("unexpected durable route handoff");
    }
    const durableHandoff = completedRoute.handoffs[0]!;
    database.close();
    database = new DatabaseSync(databasePath);
    migrateAuthorityDatabase(database);
    expect(executeRouteAuthorityOperation(database, {
      type: "route.handoff.recover", now: t0 + 20_006,
    })).toMatchObject({
      kind: "route-handoff-recovery",
      intents: [{
        intentId: durableHandoff.intentId,
        routeJobId: claim.job.id,
        roomId: "room-1",
        actorId: "agent-1",
        status: "pending",
      }],
    });
    executeRouteAuthorityOperation(database, {
      type: "route.handoff.claim", roomId: "room-1",
      intentId: durableHandoff.intentId,
      providerReady: true, now: t0 + 20_006,
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

  it("suppresses a selected Agent when frozen access changes after claim and before completion", () => {
    const database = fixture();
    database.prepare(
      `UPDATE room_memberships SET participation = 'on-mention'
       WHERE room_id = 'room-1' AND actor_id = 'agent-2'`,
    ).run();
    executeHumanDatabaseCommand(database, {
      context: { ...humanContext, requestId: "terminal-revalidation",
        idempotencyKey: "terminal-revalidation" },
      command: { type: "message.send", roomId: "room-1", payload: {
        id: "terminal-revalidation", roomId: "room-1",
        body: "Revalidate authority after provider routing", sentAt: new Date(t0 + 40_000).toISOString(),
      } },
      now: t0 + 40_000,
    });
    executeRuntimeAuthorityOperation(database, {
      type: "runtime.cancel-for-human-fence", sourceHumanMessageId: "terminal-revalidation",
      now: t0 + 40_001,
    });
    executeRuntimeAuthorityOperation(database, {
      type: "runtime.create-route-after-human-fence", sourceHumanMessageId: "terminal-revalidation",
      now: t0 + 40_002,
    });
    const claim = executeRouteAuthorityOperation(database, {
      type: "route.claim", sourceMessageId: "terminal-revalidation",
      agentProviderReady: true, now: t0 + 40_003,
    });
    if (claim.kind !== "route-claimed") throw new Error("unexpected route claim");
    database.prepare(
      `UPDATE room_memberships SET access_revision = access_revision + 1
       WHERE room_id = 'room-1' AND actor_id = 'agent-1'`,
    ).run();
    const completed = executeRouteAuthorityOperation(database, {
      type: "route.complete", routeJobId: claim.job.id, attempt: claim.job.currentAttempt,
      judgments: [{
        id: "terminal-revalidation-judgment", routeJobId: claim.job.id,
        sourceMessageId: "terminal-revalidation", agentId: "agent-1",
        outcome: "will_respond", reasonCode: "domain_match",
        reasonText: "provider selected before authority changed", routeAttempt: claim.job.currentAttempt,
        decidedAt: new Date(t0 + 40_004).toISOString(),
      }],
      intents: [{ kind: "routed_candidate", roomId: "room-1",
        sourceMessageId: "terminal-revalidation", targetAgentId: "agent-1",
        reasonCode: "domain_match", reasonText: "provider selected before authority changed", priority: 1 }],
      agentProviderReady: true,
      now: t0 + 40_004,
    });
    expect(completed).toMatchObject({ kind: "route-completed", intents: [], handoffs: [] });
    expect(database.prepare(
      `SELECT outcome, reason_code AS reasonCode, reason_text AS reasonText
       FROM route_judgments WHERE id = 'terminal-revalidation-judgment'`,
    ).get()).toEqual({ outcome: "suppressed", reasonCode: "permission_denied",
      reasonText: "authority_changed:access_revision_stale" });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM routed_agent_invocation_intents
       WHERE source_message_id = 'terminal-revalidation'`,
    ).get()).toEqual({ count: 0 });
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
