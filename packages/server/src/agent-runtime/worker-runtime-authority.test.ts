import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@native-im/core";
import { createSqliteAuthoritativeStore } from "../persistence/sqlite-authoritative-store.js";
import { insertLegacyMessageAuthorityRecord } from "../persistence/message-authority-legacy-adapter.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { createWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import { registerMemoryCorpusSource } from "../room-memory/corpus-database-authority.js";
import { createWorkerRuntimeAuthority } from "./worker-runtime-authority.js";
import { createToolGateway } from "./tool-gateway.js";
import { createRepositoryGitStatusAdapter } from "./tools/repository-git-status.js";
import { createSandboxFileWriteAdapter } from "./tools/sandbox-file-write.js";
import { submitHumanMessageDatabaseCommand } from
  "../persistence/authority-database-handler.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

const actors = [
  { id: "human-runtime", kind: "human", displayName: "Human", reachability: "online" },
  { id: "agent-runtime", kind: "agent", displayName: "Writer Agent", readiness: "ready", toolPermissions: ["sandbox-file.write"] },
  { id: "agent-git", kind: "agent", displayName: "Git Agent", readiness: "ready", toolPermissions: ["repository.git-status"] },
] as const satisfies readonly Actor[];

describe("real AuthorityWorker runtime authority", () => {
  it("persists completion and recovers a running attempt after SQLite/worker restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-runtime-worker-"));
    const databasePath = join(directory, "authority.sqlite");
    let client = await createWorkerDatabaseClient({ databasePath });
    try {
      const store = createSqliteAuthoritativeStore(client);
      await store.registerActors(actors);
      const now = Date.now();
      const session = await client.issueSession({
        accountId: "account-runtime",
        actorId: "human-runtime",
        publicSessionId: "runtime-public-session",
        device: { id: "runtime-test", label: "Runtime test", platform: "unknown" },
        accessTokenHash: hash("access-runtime"),
        refreshTokenHash: hash("refresh-runtime"),
        accessExpiresAt: now + 60_000,
        refreshExpiresAt: now + 120_000,
        now,
      });
      await client.close();

      const database = new DatabaseSync(databasePath);
      migrateAuthorityDatabase(database);
      database.exec(`
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('room-runtime', 'Runtime', 'active', '2026-08-17T00:00:00.000Z');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('room', 'room-runtime', 0, 1);
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES
          ('room-runtime', 'human-runtime', 'human', 'member', NULL, '[]',
           '2026-08-17T00:00:00.000Z', NULL, 0),
          ('room-runtime', 'agent-runtime', 'agent', NULL, 'active', '["sandbox-file.write"]',
           NULL, '2026-08-17T00:00:00.000Z', 0),
          ('room-runtime', 'agent-git', 'agent', NULL, 'active', '["repository.git-status"]',
           NULL, '2026-08-17T00:00:00.000Z', 0);
        UPDATE rooms SET owner_actor_id = 'human-runtime', governance_revision = 1
        WHERE id = 'room-runtime';
        UPDATE agent_profiles
        SET revision = 2, status = 'enabled',
            tool_ceiling_json = CASE actor_id
              WHEN 'agent-runtime' THEN '["sandbox-file.write"]'
              ELSE '["repository.git-status"]' END,
            updated_at = '2026-08-17T00:00:00.000Z',
            source_kind = 'administrator_command'
        WHERE actor_id IN ('agent-runtime', 'agent-git');
        INSERT INTO agent_profile_revisions (
          profile_id, revision, actor_id, display_name, global_responsibility, status,
          capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id,
          changed_at, operation
        ) SELECT id, revision, actor_id, display_name, global_responsibility, status,
                 capability_ceiling_json, tool_ceiling_json, 'human-runtime',
                 '2026-08-17T00:00:00.000Z', 'enable'
          FROM agent_profiles WHERE actor_id IN ('agent-runtime', 'agent-git');
        INSERT INTO room_agent_assignments (
          id, room_id, profile_id, agent_actor_id, revision, status, participation,
          paused, capability_subset_json, tool_subset_json, room_responsibility,
          created_at, updated_at, removed_at, source_kind
        ) SELECT 'assignment:' || actor_id, 'room-runtime', id, actor_id, 1,
                 'current', 'active', 0, '[]', tool_ceiling_json,
                 'Exercise runtime authority.', '2026-08-17T00:00:00.000Z',
                 '2026-08-17T00:00:00.000Z', NULL, 'room_command'
          FROM agent_profiles WHERE actor_id IN ('agent-runtime', 'agent-git');
        INSERT INTO room_agent_assignment_revisions (
          assignment_id, revision, room_id, profile_id, agent_actor_id,
          room_responsibility, status, participation, paused,
          capability_subset_json, tool_subset_json, changed_by_human_actor_id,
          changed_at, operation
        ) SELECT id, revision, room_id, profile_id, agent_actor_id,
                 room_responsibility, status, participation, paused,
                 capability_subset_json, tool_subset_json, 'human-runtime',
                 '2026-08-17T00:00:00.000Z', 'create'
          FROM room_agent_assignments WHERE room_id = 'room-runtime';
      `);
      const directContext = {
        kind: "human" as const,
        sessionId: session.sessionId,
        sessionFamilyId: session.familyId,
        principal: { accountId: session.accountId, actorId: session.actorId },
        requestId: "runtime-direct-fixture",
        idempotencyKey: "runtime-direct-fixture",
      };
      for (let index = 0; index < 70; index += 1) {
        const ordinal = index + 1;
        const directTarget = ordinal === 3 || ordinal === 4 ? "agent-git" : "agent-runtime";
        if (ordinal <= 8) {
          submitHumanMessageDatabaseCommand(database, {
            context: {
              ...directContext,
              requestId: `runtime-direct-${ordinal}`,
              idempotencyKey: `runtime-direct-${ordinal}`,
            },
            message: {
              messageId: `message-runtime-${ordinal}`,
              roomId: "room-runtime",
              body: `@Agent message-${ordinal}`,
              mentionedTargets: [{
                id: `runtime-target-${ordinal}`,
                kind: "agent-invocation",
                targetActorId: directTarget,
                range: { startUtf16: 0, endUtf16: 6 },
              }],
              attachments: [],
            },
            now: now + ordinal,
          });
          continue;
        }
        insertLegacyMessageAuthorityRecord(database, {
          id: `message-runtime-${ordinal}`,
          roomId: "room-runtime",
          authorId: "human-runtime",
          authorKind: "human",
          body: `message-${ordinal}`,
          sentAt: new Date(Date.UTC(2026, 7, 17, 0, 0, ordinal)).toISOString(),
        });
        registerMemoryCorpusSource(database, {
          roomId: "room-runtime",
          sourceKind: "message",
          sourceId: `message:message-runtime-${ordinal}`,
          sourceRevision: 1,
          serverStreamSeq: ordinal,
          eligibility: "eligible",
          availability: "readable",
          sourceActorId: "human-runtime",
          safeMetadata: { authorKind: "human", messageId: `message-runtime-${ordinal}` },
          readReference: `message-authority:message-runtime-${ordinal}:revision:1`,
          occurredAt: new Date(Date.UTC(2026, 7, 17, 0, 0, ordinal)).toISOString(),
        });
      }
      database.exec(`
        INSERT INTO human_preemption_fences (
          source_human_message_id, room_id, human_actor_id, accepted_at,
          cancelled_count, cancel_committed_at
        ) SELECT id, room_id, author_id, sent_at, 0, sent_at
          FROM messages
          WHERE id IN (
            'message-runtime-2', 'message-runtime-3', 'message-runtime-4',
            'message-runtime-5', 'message-runtime-6', 'message-runtime-7',
            'message-runtime-8'
          );
      `);
      insertLegacyMessageAuthorityRecord(database, {
        id: "message-runtime-recalled",
        roomId: "room-runtime",
        authorId: "human-runtime",
        authorKind: "human",
        body: "RECALLED-RUNTIME-CONTEXT-SENTINEL-98F1",
        sentAt: "2026-08-17T00:00:07.000Z",
      });
      database.prepare(
        `INSERT INTO message_recall_fences (
           fence_id, room_id, source_message_id, source_revision, scope_kind,
           invocation_intent_id, execution_id, reason, created_at
         ) VALUES (
           'runtime-recalled-fence', 'room-runtime', 'message-runtime-recalled', 1,
           'message', NULL, NULL, 'message_recalled', '2026-08-17T00:00:08.000Z'
         )`,
      ).run();
      database.prepare(
        `UPDATE message_envelopes
         SET lifecycle = 'recalled', recalled_at = '2026-08-17T00:00:08.000Z',
             recalled_by_actor_id = 'human-runtime'
         WHERE message_id = 'message-runtime-recalled'`,
      ).run();
      database.exec(`
        INSERT INTO agent_executions (
          id, room_id, room_archive_generation, agent_id, trigger_message_id,
          status, started_at, requester_actor_id, tool_name, action_category,
          tool_dispatch_phase, current_attempt_seq, retry_cycle, retry_ordinal,
          recovery_cursor, queued_at, updated_at
        ) VALUES (
          'legacy-collaboration-execution', 'room-runtime', 0, 'agent-runtime',
          'message-runtime-1', 'running', '2026-08-17T00:00:09.000Z',
          'human-runtime', 'sandbox-file.write', 'tool_call', 'not_started',
          1, 1, 1, 0, '2026-08-17T00:00:09.000Z', '2026-08-17T00:00:09.000Z'
        );
        INSERT INTO agent_execution_attempts (
          execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
          action_category, started_at, recovery_cursor
        ) VALUES (
          'legacy-collaboration-execution', 1, 1, 1, 'running', 'tool_call',
          '2026-08-17T00:00:09.000Z', 0
        );
      `);
      database.close();

      const context = {
        ...directContext,
        requestId: "request-runtime-1",
        idempotencyKey: "key-runtime-1",
      };
      client = await createWorkerDatabaseClient({ databasePath });
      await client.executeMemory({
        type: "memory.mark-noauth",
        roomId: "room-runtime",
        now: Date.now(),
      });
      let authority = createWorkerRuntimeAuthority(client);
      const first = await authority.invoke(context, {
        kind: "direct_mention",
        roomId: "room-runtime",
        sourceMessageId: "message-runtime-1",
        targetAgentId: "agent-runtime",
      }, "openai-responses", "configured-model");
      const firstContext = await authority.readContext(first.execution.id);
      expect(firstContext).toMatchObject({
        roomMemory: {
          status: { roomId: "room-runtime", health: { state: "noauth" } },
        },
        openItemTargets: [
          { actorId: "agent-git", kind: "agent" },
          { actorId: "agent-runtime", kind: "agent" },
          { actorId: "human-runtime", kind: "human" },
        ],
      });
      expect(JSON.stringify(firstContext.visibleConversation))
        .not.toContain("RECALLED-RUNTIME-CONTEXT-SENTINEL-98F1");
      expect(firstContext.roomMemory.rawDelta.entries).toHaveLength(64);
      const continuedDelta = await authority.readMemoryDelta(
        first.execution.id,
        firstContext.roomMemory.rawDelta.nextCursor!,
      );
      expect(continuedDelta.entries.map(({ corpusSeq }) => corpusSeq)).toEqual([65, 66, 67, 68, 69, 70]);
      expect(continuedDelta.hasMore).toBe(false);
      const runningFirst = await authority.claim(first.execution.id, 1);
      const completed = await authority.complete(runningFirst.id, 1, "durable answer");
      expect(completed).toMatchObject({ status: "completed", currentAttemptSeq: 1 });

      const second = await authority.invoke({ ...context, requestId: "request-runtime-2", idempotencyKey: "key-runtime-2" }, {
        kind: "direct_mention",
        roomId: "room-runtime",
        sourceMessageId: "message-runtime-2",
        targetAgentId: "agent-runtime",
      }, "openai-responses", "configured-model");
      await authority.claim(second.execution.id, 1);
      await client.close();

      client = await createWorkerDatabaseClient({ databasePath });
      authority = createWorkerRuntimeAuthority(client);
      const recovered = await authority.recover();
      expect(recovered).toEqual([
        expect.objectContaining({
          outcome: "enqueue",
          intent: {
            kind: "direct_mention", roomId: "room-runtime",
            sourceMessageId: "message-runtime-2", targetAgentId: "agent-runtime",
          },
          execution: expect.objectContaining({
            id: second.execution.id,
            status: "queued",
            currentAttemptSeq: 2,
            retryOrdinal: 2,
          }),
        }),
      ]);
      const legacyRead = new DatabaseSync(databasePath, { readOnly: true });
      expect(legacyRead.prepare(
        "SELECT status, current_attempt_seq AS attemptSeq FROM agent_executions WHERE id = ?",
      ).get("legacy-collaboration-execution")).toEqual({ status: "running", attemptSeq: 1 });
      legacyRead.close();
      await expect(authority.complete(second.execution.id, 1, "late stale result"))
        .rejects.toMatchObject({ code: "execution_conflict" });
      const runningSecond = await authority.claim(second.execution.id, 2);
      expect(runningSecond.status).toBe("running");

      const parameters = {
        path: "runtime.txt",
        content: "bounded",
        expectedCurrentSha256: createHash("sha256").update("").digest("hex"),
      };
      const prepared = await authority.prepareTool(
        runningSecond.id,
        2,
        {
          id: "sandbox-file.write",
          displayName: "Sandbox file write",
          effect: "side-effecting",
          reversibility: "compensatable",
        },
        parameters,
        { ...context, requestId: "request-confirm", idempotencyKey: "key-confirm" },
        { callId: "provider-call-write", argumentsJson: JSON.stringify(parameters) },
      );
      await client.close();
      client = await createWorkerDatabaseClient({ databasePath });
      authority = createWorkerRuntimeAuthority(client);
      await expect(authority.recover()).resolves.toEqual([
        expect.objectContaining({
          outcome: "wait_confirmation",
          execution: expect.objectContaining({ id: runningSecond.id, actionCategory: "waiting_upstream" }),
        }),
      ]);
      await expect(authority.readPendingConfirmation(prepared.confirmationId!, runningSecond.id))
        .resolves.toMatchObject({
          execution: { id: runningSecond.id },
          grantId: prepared.grantId,
          toolId: "sandbox-file.write",
          parameters,
          callId: "provider-call-write",
        });
      await expect(authority.claimTool(
        runningSecond.id,
        2,
        prepared.grantId,
        { ...parameters, content: "tampered" },
        {
          context: { ...context, requestId: "request-confirm", idempotencyKey: "key-confirm" },
          input: { confirmationId: prepared.confirmationId!, executionId: runningSecond.id },
        },
      )).rejects.toMatchObject({ code: "permission_denied" });
      const sandboxAdapter = createSandboxFileWriteAdapter({
        root: directory,
        compensationKey: new Uint8Array(32).fill(9),
        maxContentBytes: 1_024,
      });
      const gitAdapter = createRepositoryGitStatusAdapter({
        binaryPath: "/usr/bin/git",
        repositoryRoot: process.cwd(),
        maxOutputBytes: 256 * 1_024,
        timeoutMs: 5_000,
      });
      let gateway = createToolGateway({ authority, adapters: [sandboxAdapter, gitAdapter] });
      const writeOutcome = await gateway.execute({
        executionId: runningSecond.id,
        attemptSeq: 2,
        roomId: runningSecond.roomId,
        agentId: runningSecond.agentId,
        callId: "call-write",
        grantId: prepared.grantId,
        toolId: "sandbox-file.write",
        parameters,
        confirmation: {
          context: { ...context, requestId: "request-confirm", idempotencyKey: "key-confirm" },
          input: { confirmationId: prepared.confirmationId!, executionId: runningSecond.id },
        },
        signal: new AbortController().signal,
      });
      expect(writeOutcome.summary).toMatchObject({ operation: "created", byteCount: 7 });
      const completedWrite = await authority.complete(runningSecond.id, 2, "write completed");
      const compensation = await authority.beginCompensation(
        { ...context, requestId: "request-compensate", idempotencyKey: "key-compensate" },
        completedWrite.id,
      );
      expect(compensation.execution).toMatchObject({
        status: "running",
        compensatesExecutionId: completedWrite.id,
        toolDispatchPhase: "dispatched",
      });
      const compensationOutcome = await sandboxAdapter.compensate!(
        compensation.sealedCompensation,
        new AbortController().signal,
      );
      await authority.settleTool(compensation.dispatchId, "succeeded", compensationOutcome.summary);
      const completedCompensation = await authority.complete(
        compensation.execution.id,
        1,
        "compensation completed",
      );
      expect(completedCompensation.status).toBe("completed");
      expect(existsSync(join(directory, "runtime.txt"))).toBe(false);

      const uncertain = await authority.invoke(
        { ...context, requestId: "request-runtime-6", idempotencyKey: "key-runtime-6" },
        { kind: "direct_mention", roomId: "room-runtime", sourceMessageId: "message-runtime-6", targetAgentId: "agent-runtime" },
        "openai-responses",
        "configured-model",
      );
      const runningUncertain = await authority.claim(uncertain.execution.id, 1);
      const uncertainParameters = {
        path: "uncertain.txt",
        content: "dispatched",
        expectedCurrentSha256: createHash("sha256").update("").digest("hex"),
      };
      const preparedUncertain = await authority.prepareTool(
        runningUncertain.id,
        1,
        sandboxAdapter.descriptor,
        uncertainParameters,
        { ...context, requestId: "request-confirm-uncertain", idempotencyKey: "key-confirm-uncertain" },
      );
      await gateway.execute({
        executionId: runningUncertain.id,
        attemptSeq: 1,
        roomId: runningUncertain.roomId,
        agentId: runningUncertain.agentId,
        callId: "call-uncertain",
        grantId: preparedUncertain.grantId,
        toolId: "sandbox-file.write",
        parameters: uncertainParameters,
        confirmation: {
          context: { ...context, requestId: "request-confirm-uncertain", idempotencyKey: "key-confirm-uncertain" },
          input: { confirmationId: preparedUncertain.confirmationId!, executionId: runningUncertain.id },
        },
        signal: new AbortController().signal,
      });
      await client.close();
      client = await createWorkerDatabaseClient({ databasePath });
      authority = createWorkerRuntimeAuthority(client);
      const recoveredUncertain = await authority.recover();
      expect(recoveredUncertain).toEqual([
        expect.objectContaining({
          outcome: "fail_outcome_unknown",
          execution: expect.objectContaining({
            id: runningUncertain.id,
            status: "failed",
            terminalErrorCode: "side_effect_outcome_unknown",
          }),
        }),
      ]);
      gateway = createToolGateway({ authority, adapters: [sandboxAdapter, gitAdapter] });

      const cancellable = await authority.invoke(
        { ...context, requestId: "request-runtime-7", idempotencyKey: "key-runtime-7" },
        { kind: "direct_mention", roomId: "room-runtime", sourceMessageId: "message-runtime-7", targetAgentId: "agent-runtime" },
        "openai-responses",
        "configured-model",
      );
      const cancelContext = {
        ...context,
        requestId: "request-cancel-runtime-7",
        idempotencyKey: "key-cancel-runtime-7",
      };
      await expect(authority.cancelScoped(
        cancelContext,
        cancellable.execution.id,
        1,
        cancelContext.requestId,
      )).resolves.toMatchObject({
        kind: "scoped-cancellation-committed",
        roomId: "room-runtime",
        reason: "human_cancelled",
        replayed: false,
        effects: [{
          executionId: cancellable.execution.id,
          attemptSeq: 1,
          disposition: "execution_cancelled",
        }],
      });
      await expect(authority.cancelScoped(
        cancelContext,
        cancellable.execution.id,
        1,
        cancelContext.requestId,
      )).resolves.toMatchObject({ replayed: true });
      const shutdownCandidate = await authority.invoke(
        { ...context, requestId: "request-runtime-8", idempotencyKey: "key-runtime-8" },
        { kind: "direct_mention", roomId: "room-runtime", sourceMessageId: "message-runtime-8", targetAgentId: "agent-runtime" },
        "openai-responses",
        "configured-model",
      );
      await expect(authority.shutdown(shutdownCandidate.execution.id, 1)).resolves.toMatchObject({
        id: shutdownCandidate.execution.id,
        status: "cancelled",
        cancellationReason: "runtime_shutdown",
      });

      const third = await authority.invoke(
        { ...context, requestId: "request-runtime-3", idempotencyKey: "key-runtime-3" },
        { kind: "direct_mention", roomId: "room-runtime", sourceMessageId: "message-runtime-3", targetAgentId: "agent-git" },
        "openai-responses",
        "configured-model",
      );
      const runningThird = await authority.claim(third.execution.id, 1);
      const preparedGit = await authority.prepareTool(
        runningThird.id,
        1,
        gitAdapter.descriptor,
        {},
      );
      const gitOutcome = await gateway.execute({
        executionId: runningThird.id,
        attemptSeq: 1,
        roomId: runningThird.roomId,
        agentId: runningThird.agentId,
        callId: "call-git",
        grantId: preparedGit.grantId,
        toolId: "repository.git-status",
        parameters: {},
        signal: new AbortController().signal,
      });
      expect(gitOutcome.summary).toMatchObject({ exitCategory: "success" });

      const openItem = await createSqliteAuthoritativeStore(client).executeHuman(
        { ...context, requestId: "request-open-item-failure", idempotencyKey: "key-open-item-failure" },
        { type: "open-item.create", roomId: "room-runtime", payload: {
          creationKind: "manual_unfinished", sourceMessageId: "message-runtime-5",
          targetActorId: "agent-runtime", content: "Agent must retain this commitment on failure",
        } },
      );
      const fifth = await authority.invoke(
        { ...context, requestId: "request-runtime-5", idempotencyKey: "key-runtime-5" },
        { kind: "direct_mention", roomId: "room-runtime", sourceMessageId: "message-runtime-5", targetAgentId: "agent-runtime" },
        "openai-responses",
        "configured-model",
      );
      await authority.claim(fifth.execution.id, 1);
      const retryTwo = await authority.scheduleRetry(
        fifth.execution.id,
        1,
        "provider_unavailable",
        new Date(Date.now() + 1_000).toISOString(),
      );
      await authority.claim(retryTwo.id, 2);
      const retryThree = await authority.scheduleRetry(
        retryTwo.id,
        2,
        "provider_unavailable",
        new Date(Date.now() + 4_000).toISOString(),
      );
      await authority.claim(retryThree.id, 3);
      const deadLettered = await authority.scheduleRetry(
        retryThree.id,
        3,
        "provider_unavailable",
        undefined,
      );
      expect(deadLettered).toMatchObject({
        status: "failed",
        currentAttemptSeq: 3,
        retryOrdinal: 3,
        terminalErrorCode: "provider_unavailable",
      });
      const failedItem = new DatabaseSync(databasePath, { readOnly: true });
      expect(failedItem.prepare(
        `SELECT status, current_owner_actor_id AS currentOwnerId
         FROM open_items WHERE id = ?`,
      ).get(openItem.aggregateId)).toEqual({ status: "awaiting", currentOwnerId: "agent-runtime" });
      expect(failedItem.prepare(
        `SELECT failure.execution_id AS executionId, failure.attempt_seq AS attemptSeq,
                failure.reason_code AS reasonCode
         FROM open_item_agent_failures AS failure WHERE failure.open_item_id = ?`,
      ).get(openItem.aggregateId)).toEqual({
        executionId: fifth.execution.id, attemptSeq: 3, reasonCode: "provider_unavailable",
      });
      expect(failedItem.prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE event_type = 'room.open_item.agent_attempt_failed'`,
      ).get()).toEqual({ count: 1 });
      failedItem.close();
      const manualRetry = await authority.retry(
        { ...context, requestId: "request-manual-retry", idempotencyKey: "key-manual-retry" },
        deadLettered.id,
      );
      expect(manualRetry.execution).toMatchObject({
        status: "queued",
        manualRetryOfExecutionId: deadLettered.id,
        currentAttemptSeq: 1,
      });
      expect(manualRetry.intent).toEqual({
        kind: "direct_mention", roomId: "room-runtime",
        sourceMessageId: "message-runtime-5", targetAgentId: "agent-runtime",
      });
      expect(manualRetry.execution.id).not.toBe(deadLettered.id);

      const fourth = await authority.invoke(
        { ...context, requestId: "request-runtime-4", idempotencyKey: "key-runtime-4" },
        { kind: "direct_mention", roomId: "room-runtime", sourceMessageId: "message-runtime-4", targetAgentId: "agent-git" },
        "openai-responses",
        "configured-model",
      );
      const runningFourth = await authority.claim(fourth.execution.id, 1);
      const preparedRevoked = await authority.prepareTool(runningFourth.id, 1, gitAdapter.descriptor, {});
      await client.close();
      const revoke = new DatabaseSync(databasePath);
      revoke.prepare(
        `UPDATE room_memberships SET tool_permissions_json = '[]'
         WHERE room_id = 'room-runtime' AND actor_id = 'agent-git'`,
      ).run();
      revoke.close();
      client = await createWorkerDatabaseClient({ databasePath });
      authority = createWorkerRuntimeAuthority(client);
      const deniedExecute = vi.fn();
      const deniedGateway = createToolGateway({
        authority,
        adapters: [{ descriptor: gitAdapter.descriptor, execute: deniedExecute }],
      });
      await expect(deniedGateway.execute({
        executionId: runningFourth.id,
        attemptSeq: 1,
        roomId: runningFourth.roomId,
        agentId: runningFourth.agentId,
        callId: "call-revoked",
        grantId: preparedRevoked.grantId,
        toolId: "repository.git-status",
        parameters: {},
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: "permission_denied" });
      expect(deniedExecute).not.toHaveBeenCalled();

      const history = await client.readMessageHistory({
        sessionId: context.sessionId,
        sessionFamilyId: context.sessionFamilyId,
        principal: context.principal,
      }, { roomId: "room-runtime", limit: 200 }, Date.now());
      expect(history.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          authorKind: "agent",
          finalBody: "durable answer",
        }),
      ]));
      expect(JSON.stringify(history))
        .not.toContain("RECALLED-RUNTIME-CONTEXT-SENTINEL-98F1");
      await client.close();
      const evidence = new DatabaseSync(databasePath);
      expect(evidence.prepare(
        `SELECT grant.consumed_at AS grantConsumedAt,
                confirmation.consumed_at AS confirmationConsumedAt,
                dispatch.state, dispatch.closed_summary_json AS summary
         FROM tool_dispatches AS dispatch
         JOIN agent_execution_grants AS grant ON grant.grant_id = dispatch.grant_id
         JOIN tool_confirmations AS confirmation
           ON confirmation.execution_id = dispatch.execution_id
          AND confirmation.attempt_seq = dispatch.attempt_seq
         WHERE grant.grant_id = ?`,
      ).get(prepared.grantId)).toMatchObject({
        state: "succeeded",
      });
      const consumed = evidence.prepare(
        `SELECT grant.consumed_at AS grantConsumedAt,
                grant.grant_state AS grantState,
                grant.grant_revision AS grantRevision,
                confirmation.consumed_at AS confirmationConsumedAt,
                confirmation.confirmation_state AS confirmationState,
                confirmation.confirmation_revision AS confirmationRevision
         FROM agent_execution_grants AS grant
         JOIN tool_confirmations AS confirmation
           ON confirmation.execution_id = grant.execution_id
          AND confirmation.attempt_seq = grant.attempt_seq
         WHERE grant.grant_id = ?`,
      ).get(prepared.grantId);
      expect(typeof consumed?.grantConsumedAt).toBe("string");
      expect(typeof consumed?.confirmationConsumedAt).toBe("string");
      expect(consumed).toMatchObject({
        grantState: "claimed",
        grantRevision: 1,
        confirmationState: "confirmed",
        confirmationRevision: 1,
      });
      const lifecycleEvents = evidence.prepare(
        `SELECT event_type AS eventType, payload_json AS payloadJson
         FROM events
         WHERE event_type IN ('agent.execution.retry-scheduled', 'agent.execution.dead-lettered')
         ORDER BY stream_seq`,
      ).all();
      expect(lifecycleEvents.map((row) => row.eventType)).toEqual([
        "agent.execution.retry-scheduled",
        "agent.execution.retry-scheduled",
        "agent.execution.dead-lettered",
      ]);
      for (const row of lifecycleEvents) {
        const payload = JSON.parse(String(row.payloadJson)) as Record<string, unknown>;
        expect(payload).toMatchObject({ executionId: fifth.execution.id, errorCode: "provider_unavailable" });
        expect(typeof payload.attemptSeq).toBe("number");
      }
      evidence.close();
    } finally {
      await client.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
