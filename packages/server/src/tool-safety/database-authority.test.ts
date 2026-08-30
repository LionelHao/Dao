// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TOOL_CANONICALIZER_VERSION } from "@native-im/core";
import { parseToolParameters } from "../agent-runtime/tool-parameters.js";
import {
  seedCanonicalAgentProfileFixture,
  seedCanonicalRoomAssignmentFixture,
} from "../fixtures/agent-authority-fixture.js";
import type { AuthenticatedCommandContext } from "../persistence/contracts.js";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { createArchiveToolSafetyParticipant } from "./archive-tool-safety-participant.js";
import {
  executeToolSafetyAuthorityOperationInTransaction,
  settleToolSafetyExecutionFenceInTransaction,
  settleToolSafetyPrincipalFenceInTransaction,
} from "./database-authority.js";
import type { ToolSafetyAuthorityOperation } from "./authority-protocol.js";

const NOW = Date.parse("2026-08-30T08:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HASH = "a".repeat(64);

function testDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "dao-ft10-authority-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  return {
    database,
    close(): void {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url");
}

function context(
  idempotencyKey: string,
  identity: Readonly<{
    actorId: string;
    accountId: string;
    familyId: string;
    sessionId: string;
  }> = {
    actorId: "human-ft10",
    accountId: "account-ft10",
    familyId: "family-ft10",
    sessionId: "access-ft10",
  },
): AuthenticatedCommandContext {
  return {
    kind: "human",
    sessionId: identity.sessionId,
    sessionFamilyId: identity.familyId,
    principal: { accountId: identity.accountId, actorId: identity.actorId },
    requestId: `request-${idempotencyKey}`,
    idempotencyKey,
  };
}

function transact(
  database: DatabaseSync,
  operation: ToolSafetyAuthorityOperation,
) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = executeToolSafetyAuthorityOperationInTransaction(database, operation);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function seedAuthority(database: DatabaseSync): void {
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json, readiness)
    VALUES ('human-ft10', 'human', 'Human FT10', '[]', 'ready'),
           ('human-ft10-b', 'human', 'Human FT10 B', '[]', 'ready'),
           ('agent-ft10', 'agent', 'Agent FT10', '["sandbox-file.write"]', 'busy');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'human-ft10', 0, 1),
           ('identity', 'human-ft10-b', 0, 1),
           ('identity', 'agent-ft10', 0, 1),
           ('room', 'room-ft10', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES ('room-ft10', 'FT10', 'active', '${NOW_ISO}', 'human-ft10');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-ft10', 'human-ft10', 'human', 'owner', NULL, '[]', '${NOW_ISO}', NULL, 0),
      ('room-ft10', 'human-ft10-b', 'human', 'member', NULL, '[]', '${NOW_ISO}', NULL, 0),
      ('room-ft10', 'agent-ft10', 'agent', NULL, 'active',
       '["sandbox-file.write"]', NULL, '${NOW_ISO}', 0);
    INSERT INTO session_families (
      family_id, public_id, account_id, actor_id, device_id, device_label,
      platform, created_at, refresh_expires_at, revoked_at
    ) VALUES ('family-ft10', 'public-ft10', 'account-ft10', 'human-ft10',
              'device-ft10', 'Test device', 'unknown', ${NOW}, ${NOW + 3_600_000}, NULL),
             ('family-ft10-b', 'public-ft10-b', 'account-ft10-b', 'human-ft10-b',
              'device-ft10-b', 'Test device B', 'unknown', ${NOW}, ${NOW + 3_600_000}, NULL);
    INSERT INTO sessions (
      family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
      access_expires_at, refresh_expires_at
    ) VALUES ('family-ft10', 'account-ft10', 'human-ft10', 'access-ft10',
              'refresh-ft10', ${NOW + 1_800_000}, ${NOW + 3_600_000}),
             ('family-ft10-b', 'account-ft10-b', 'human-ft10-b', 'access-ft10-b',
              'refresh-ft10-b', ${NOW + 1_800_000}, ${NOW + 3_600_000});
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES ('message-ft10', 'room-ft10', 'human-ft10', 'human', 'run the tool', '${NOW_ISO}');
    INSERT INTO message_revisions (
      message_id, revision, body, revised_at, revised_by_actor_id
    ) VALUES ('message-ft10', 1, 'run the tool', '${NOW_ISO}', 'human-ft10');
    INSERT INTO message_envelopes (
      message_id, room_id, message_kind, lifecycle, current_revision,
      revision_count, created_at, recalled_at, recalled_by_actor_id
    ) VALUES ('message-ft10', 'room-ft10', 'human', 'active', 1, 1,
              '${NOW_ISO}', NULL, NULL);
  `);
  const profileId = seedCanonicalAgentProfileFixture(database, {
    actorId: "agent-ft10",
    profileId: "profile-ft10",
    displayName: "Agent FT10",
    capabilityCeiling: ["room.conversation.read", "room.respond"],
    toolCeiling: ["sandbox-file.write"],
    now: NOW_ISO,
  });
  seedCanonicalRoomAssignmentFixture(database, {
    assignmentId: "assignment-ft10",
    roomId: "room-ft10",
    profileId,
    actorId: "agent-ft10",
    participation: "active",
    capabilitySubset: ["room.conversation.read", "room.respond"],
    toolSubset: ["sandbox-file.write"],
    now: NOW_ISO,
  });
  database.exec(`
    BEGIN IMMEDIATE;
    INSERT INTO message_mentions (
      message_id, room_id, target_id, target_kind, target_actor_id,
      range_start_utf16, range_end_utf16, target_order
    ) VALUES ('message-ft10', 'room-ft10', 'target-ft10', 'agent-invocation',
              'agent-ft10', 0, 3, 0);
    INSERT INTO agent_invocation_intents (
      id, room_id, source_message_id, target_agent_id, requester_actor_id,
      intent_kind, execution_id, created_at, message_transaction_id, target_id,
      source_revision, lineage_id, turn_id, origin_kind, status, claimed_at
    ) VALUES ('intent-ft10', 'room-ft10', 'message-ft10', 'agent-ft10', 'human-ft10',
              'direct_mention', NULL, '${NOW_ISO}', 'message-ft10', 'target-ft10',
              1, 'lineage-ft10', 'turn-ft10', 'message_target', 'pending', NULL);
    INSERT INTO direct_agent_invocation_authority_bindings (
      intent_id, profile_id, profile_revision, assignment_id,
      assignment_revision, access_revision
    ) VALUES ('intent-ft10', 'profile-ft10', 1, 'assignment-ft10', 1, 0);
    UPDATE agent_invocation_intents
    SET status = 'claimed', claimed_at = '${NOW_ISO}' WHERE id = 'intent-ft10';
    UPDATE agent_invocation_intent_runtime_states
    SET public_status = 'claimed', authority_version = authority_version + 1,
        claimed_at = '${NOW_ISO}', updated_at = '${NOW_ISO}'
    WHERE intent_id = 'intent-ft10' AND public_status = 'pending';
    INSERT INTO message_target_outcomes (
      message_id, room_id, target_id, target_actor_id, target_kind, status,
      request_intent_id, invocation_intent_id, rejection_code, created_at
    ) VALUES ('message-ft10', 'room-ft10', 'target-ft10', 'agent-ft10',
              'agent-invocation', 'invocation-intent-created', NULL, 'intent-ft10',
              NULL, '${NOW_ISO}');
    INSERT INTO agent_executions (
      id, room_id, room_archive_generation, agent_id, trigger_message_id,
      status, started_at, requester_actor_id, tool_name, action_category,
      current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
      recovery_cursor, queued_at, updated_at
    ) VALUES ('execution-ft10', 'room-ft10', 0, 'agent-ft10', 'message-ft10',
              'running', '${NOW_ISO}', 'human-ft10', 'model.generate', 'model_generation',
              1, 1, 1, 'provider-ft10', 'model-ft10', 0, '${NOW_ISO}', '${NOW_ISO}');
    INSERT INTO agent_execution_attempts (
      execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
      action_category, started_at, recovery_cursor
    ) VALUES ('execution-ft10', 1, 1, 1, 'running', 'model_generation', '${NOW_ISO}', 0);
    INSERT INTO agent_execution_intent_links (
      intent_id, execution_id, execution_ordinal, retry_of_execution_id,
      source_revision, linked_at
    ) VALUES ('intent-ft10', 'execution-ft10', 1, NULL, 1, '${NOW_ISO}');
    INSERT INTO context_snapshots (
      snapshot_id, room_id, invocation_intent_id, agent_id, provider_id, model_id,
      compiler_version, compiler_config_version, estimator_version,
      preparation_sha256, trigger_message_id, trigger_revision, trigger_reason,
      memory_watermark, corpus_head, raw_delta_from_exclusive, raw_delta_to_inclusive,
      room_lifecycle_generation, membership_access_revision, tool_capability_revision,
      budget_json, manifest_sha256, envelope_sha256, state, snapshot_generation,
      created_at, payload_retention_state
    ) VALUES ('snapshot-ft10', 'room-ft10', 'intent-ft10', 'agent-ft10',
              'provider-ft10', 'model-ft10', 'compiler-v1', 'config-v1',
              'deterministic_utf8_v1', '${HASH}', 'message-ft10', 1, 'direct_mention',
              0, 0, 0, 0, 0, 0, 0, '{}', '${HASH}', '${HASH}', 'active', 1,
              '${NOW_ISO}', 'required');
    INSERT INTO agent_execution_context_bindings (
      execution_id, snapshot_id, invocation_intent_id, execution_generation, bound_at
    ) VALUES ('execution-ft10', 'snapshot-ft10', 'intent-ft10', 1, '${NOW_ISO}');
    INSERT INTO agent_execution_context_attempts (
      execution_id, attempt_seq, snapshot_id, snapshot_generation, reuse_kind, bound_at
    ) VALUES ('execution-ft10', 1, 'snapshot-ft10', 1, 'first', '${NOW_ISO}');
    UPDATE agent_execution_runtime_states
    SET phase = 'model_generation', authority_version = authority_version + 1,
        updated_at = '${NOW_ISO}'
    WHERE execution_id = 'execution-ft10';
    UPDATE agent_execution_attempt_runtime_states
    SET phase = 'model_generation', attempt_version = attempt_version + 1
    WHERE execution_id = 'execution-ft10' AND attempt_seq = 1;
    COMMIT;
  `);
}

function prepareAndClaim(database: DatabaseSync) {
  const parameters = parseToolParameters({
    toolId: "sandbox-file.write",
    argumentsJson: JSON.stringify({
      path: "notes/ft10.txt",
      content: "hello",
      expectedCurrentSha256: EMPTY_SHA256,
    }),
  });
  const binding = transact(database, {
    type: "tool-safety.read-prepare-binding",
    executionId: "execution-ft10",
    attemptSeq: 1,
    toolId: "sandbox-file.write",
    now: NOW + 1_000,
  });
  expect(binding).toMatchObject({ kind: "prepare-binding", executionVersion: 3 });
  if (binding.kind !== "prepare-binding") throw new Error("missing prepare binding");
  const prepared = transact(database, {
    type: "tool-safety.prepare",
    toolCallId: "tool-call-ft10",
    invocationId: binding.invocationId,
    executionId: binding.executionId,
    attemptSeq: binding.attemptSeq,
    expectedExecutionVersion: binding.executionVersion,
    toolId: "sandbox-file.write",
    canonicalParameterSha256: parameters.canonicalParameterSha256,
    parameterSchemaVersion: parameters.schemaVersion,
    canonicalizerVersion: parameters.canonicalizerVersion,
    safePreview: parameters.safePreview,
    sealedPayload: {
      ciphertext: "sealed-parameters-ft10",
      keyVersion: "test-key-v1",
      expiresAt: new Date(NOW + 240_000).toISOString(),
    },
    confirmation: {
      confirmationId: "confirmation-ft10",
      context: context("prepare"),
      bindingGeneration: 1,
    },
    now: NOW + 1_000,
  });
  expect(prepared).toMatchObject({
    kind: "prepared",
    confirmationId: "confirmation-ft10",
    claimBinding: { executionVersion: 4, sourceSnapshotId: "snapshot-ft10" },
  });
  if (prepared.kind !== "prepared" || prepared.claimBinding === undefined) {
    throw new Error("missing prepared claim binding");
  }
  const decision = transact(database, {
    type: "tool-safety.confirmation-decide",
    context: context("confirm"),
    confirmationId: "confirmation-ft10",
    expectedVersion: 1,
    decision: "confirm",
    grantId: "grant-ft10",
    grantExpiresAt: new Date(NOW + 30_000).toISOString(),
    now: NOW + 2_000,
  });
  expect(decision).toMatchObject({
    kind: "confirmation-decision",
    state: "confirmed",
    version: 2,
    grantId: "grant-ft10",
  });
  const claim = transact(database, {
    type: "tool-safety.claim",
    ...prepared.claimBinding,
    expectedExecutionVersion: prepared.claimBinding.executionVersion,
    expectedAccessRevision: prepared.claimBinding.accessRevision,
    expectedRoomLifecycleGeneration: prepared.claimBinding.roomLifecycleGeneration,
    expectedProfileRevision: prepared.claimBinding.profileRevision,
    expectedAssignmentRevision: prepared.claimBinding.assignmentRevision,
    grantId: "grant-ft10",
    parameters: parameters.parsed,
    now: NOW + 3_000,
  });
  expect(claim).toMatchObject({
    kind: "claimed",
    toolId: "sandbox-file.write",
    parameters: parameters.parsed,
  });
  if (claim.kind !== "claimed") throw new Error("missing dispatch claim");
  return claim;
}

describe("FT-10 SQLite tool-safety authority", () => {
  it("commits an exact Human decision, one-shot durable claim, settlement, and public repair events", () => {
    const fixture = testDatabase();
    const { database } = fixture;
    try {
      seedAuthority(database);
      const claim = prepareAndClaim(database);
      const replay = transact(database, {
        type: "tool-safety.claim",
        toolCallId: "tool-call-ft10",
        invocationId: "intent-ft10",
        executionId: "execution-ft10",
        attemptSeq: 1,
        expectedExecutionVersion: 4,
        roomId: "room-ft10",
        agentId: "agent-ft10",
        grantId: "grant-ft10",
        toolId: "sandbox-file.write",
        canonicalParameterSha256: "0".repeat(64),
        canonicalizerVersion: TOOL_CANONICALIZER_VERSION,
        sourceSnapshotId: "snapshot-ft10",
        expectedAccessRevision: 0,
        expectedRoomLifecycleGeneration: 0,
        profileId: "profile-ft10",
        expectedProfileRevision: 1,
        assignmentId: "assignment-ft10",
        expectedAssignmentRevision: 1,
        parameters: {},
        now: NOW + 4_000,
      });
      expect(replay).toEqual({
        kind: "not_replayable",
        state: "claimed",
        dispatchId: claim.dispatchId,
      });
      expect(transact(database, {
        type: "tool-safety.settle",
        dispatchId: claim.dispatchId,
        expectedVersion: 2,
        state: "known_succeeded",
        summary: { outcome: "written" },
        sealedCompensation: "opaque-compensation-token",
        now: NOW + 5_000,
      })).toMatchObject({ kind: "settled", state: "known_succeeded", version: 3 });
      expect(database.prepare(
        `SELECT decision, principal_human_actor_id AS principalActorId,
                session_family_id AS familyId
         FROM tool_confirmation_decisions_v2`,
      ).get()).toEqual({
        decision: "confirmed",
        principalActorId: "human-ft10",
        familyId: "family-ft10",
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'tool.safety.changed'",
      ).get()).toEqual({ count: 7 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE target_kind = 'room'",
      ).get()).toEqual({ count: 7 });
      expect(database.prepare(
        "SELECT MAX(instr(projection_json, 'hello')) AS leaked FROM tool_safety_repair_records_v2",
      ).get()).toEqual({ leaked: 0 });
    } finally {
      fixture.close();
    }
  });

  it("atomically freezes a live parent when a side-effect settlement is outcome unknown", () => {
    const fixture = testDatabase();
    const { database } = fixture;
    try {
      seedAuthority(database);
      const claim = prepareAndClaim(database);
      expect(transact(database, {
        type: "tool-safety.settle",
        dispatchId: claim.dispatchId,
        expectedVersion: 2,
        state: "outcome_unknown",
        summary: { outcome: "unknown" },
        now: NOW + 5_000,
      })).toMatchObject({ kind: "settled", state: "outcome_unknown", version: 3 });
      expect(database.prepare(
        `SELECT execution.status, execution.terminal_error_code AS terminalErrorCode,
                attempt.status AS attemptStatus, attempt.error_code AS attemptErrorCode,
                runtime.public_status AS publicStatus, runtime.phase,
                runtime.review_state AS reviewState,
                attempt_runtime.public_status AS attemptPublicStatus,
                attempt_runtime.phase AS attemptPhase
         FROM agent_executions AS execution
         JOIN agent_execution_attempts AS attempt
           ON attempt.execution_id = execution.id AND attempt.attempt_seq = 1
         JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = execution.id
         JOIN agent_execution_attempt_runtime_states AS attempt_runtime
           ON attempt_runtime.execution_id = execution.id AND attempt_runtime.attempt_seq = 1
         WHERE execution.id = 'execution-ft10'`,
      ).get()).toEqual({
        status: "failed", terminalErrorCode: "side_effect_outcome_unknown",
        attemptStatus: "failed", attemptErrorCode: "side_effect_outcome_unknown",
        publicStatus: "failed", phase: "failed", reviewState: "needs_review",
        attemptPublicStatus: "failed", attemptPhase: "failed",
      });
    } finally {
      fixture.close();
    }
  });

  it("creates compensation as a new execution and toolCall without mutating the original dispatch", () => {
    const fixture = testDatabase();
    const { database } = fixture;
    try {
      seedAuthority(database);
      const original = prepareAndClaim(database);
      expect(transact(database, {
        type: "tool-safety.settle",
        dispatchId: original.dispatchId,
        expectedVersion: 2,
        state: "known_succeeded",
        summary: { outcome: "written" },
        sealedCompensation: "opaque-compensation-token",
        now: NOW + 5_000,
      })).toMatchObject({ kind: "settled", state: "known_succeeded", version: 3 });

      const proposalContext = context("propose-compensation");
      const suffix = stableId("human-ft10", proposalContext.idempotencyKey,
        original.dispatchId, "3");
      const canonicalReference = JSON.stringify({
        operation: "compensate",
        originalDispatchId: original.dispatchId,
      });
      const proposal = transact(database, {
        type: "tool-safety.compensation-propose",
        context: proposalContext,
        dispatchId: original.dispatchId,
        expectedVersion: 3,
        invocationId: `tool-compensation-invocation-${suffix}`,
        executionId: `tool-compensation-execution-${suffix}`,
        toolCallId: `tool-compensation-call-${suffix}`,
        confirmationId: `tool-compensation-confirmation-${suffix}`,
        canonicalParameterSha256: createHash("sha256").update(canonicalReference).digest("hex"),
        sealedReference: {
          ciphertext: createHash("sha256")
            .update(`reference\0${canonicalReference}`).digest("base64url"),
          keyVersion: "dao-compensation-reference.v1",
          expiresAt: new Date(NOW + 240_000).toISOString(),
        },
        now: NOW + 6_000,
      });
      expect(proposal).toMatchObject({
        kind: "compensation-proposed",
        originalDispatchId: original.dispatchId,
        version: 1,
      });
      if (proposal.kind !== "compensation-proposed") throw new Error("missing compensation");
      expect(transact(database, {
        type: "tool-safety.compensation-propose",
        context: proposalContext,
        dispatchId: original.dispatchId,
        expectedVersion: 3,
        invocationId: `tool-compensation-invocation-${suffix}`,
        executionId: `tool-compensation-execution-${suffix}`,
        toolCallId: `tool-compensation-call-${suffix}`,
        confirmationId: `tool-compensation-confirmation-${suffix}`,
        canonicalParameterSha256: createHash("sha256").update(canonicalReference).digest("hex"),
        sealedReference: {
          ciphertext: createHash("sha256")
            .update(`reference\0${canonicalReference}`).digest("base64url"),
          keyVersion: "dao-compensation-reference.v1",
          expiresAt: new Date(NOW + 245_000).toISOString(),
        },
        now: NOW + 6_500,
      })).toMatchObject({
        kind: "compensation-proposed",
        originalDispatchId: original.dispatchId,
        version: 1,
        replayed: true,
      });
      const compensationGrantId = "grant-ft10-compensation";
      expect(transact(database, {
        type: "tool-safety.confirmation-decide",
        context: context("confirm-compensation"),
        confirmationId: proposal.confirmationId,
        expectedVersion: 1,
        decision: "confirm",
        grantId: compensationGrantId,
        grantExpiresAt: new Date(NOW + 30_000).toISOString(),
        now: NOW + 7_000,
      })).toMatchObject({ kind: "confirmation-decision", state: "confirmed", version: 2 });
      const compensationClaim = transact(database, {
        type: "tool-safety.claim",
        toolCallId: proposal.toolCallId,
        invocationId: proposal.invocationId,
        executionId: proposal.executionId,
        attemptSeq: 1,
        expectedExecutionVersion: 2,
        roomId: "room-ft10",
        agentId: "agent-ft10",
        grantId: compensationGrantId,
        toolId: "sandbox-file.write",
        canonicalParameterSha256: createHash("sha256").update(canonicalReference).digest("hex"),
        canonicalizerVersion: TOOL_CANONICALIZER_VERSION,
        sourceSnapshotId: "snapshot-ft10",
        expectedAccessRevision: 0,
        expectedRoomLifecycleGeneration: 0,
        profileId: "profile-ft10",
        expectedProfileRevision: 1,
        assignmentId: "assignment-ft10",
        expectedAssignmentRevision: 1,
        principalActorId: "human-ft10",
        sessionFamilyId: "family-ft10",
        bindingGeneration: 1,
        parameters: {},
        compensationOfDispatchId: original.dispatchId,
        now: NOW + 8_000,
      });
      expect(compensationClaim).toMatchObject({
        kind: "claimed",
        compensationToken: "opaque-compensation-token",
        compensationOfDispatchId: original.dispatchId,
      });
      if (compensationClaim.kind !== "claimed") throw new Error("missing compensation claim");
      expect(transact(database, {
        type: "tool-safety.settle",
        dispatchId: compensationClaim.dispatchId,
        expectedVersion: 2,
        state: "known_succeeded",
        summary: { outcome: "restored" },
        now: NOW + 9_000,
      })).toMatchObject({ kind: "settled", state: "known_succeeded", version: 3 });
      expect(database.prepare(
        "SELECT state, version FROM tool_dispatches_v2 WHERE dispatch_id = ?",
      ).get(original.dispatchId)).toEqual({ state: "known_succeeded", version: 3 });
      expect(database.prepare(
        "SELECT status, compensates_execution_id AS compensates FROM agent_executions WHERE id = ?",
      ).get(proposal.executionId)).toEqual({
        status: "completed",
        compensates: "execution-ft10",
      });
      expect(database.prepare("PRAGMA foreign_key_check").get()).toBeUndefined();
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.prepare(
        `SELECT runtime.snapshot_id AS compensationSnapshot,
                original_call.source_snapshot_id AS originalSnapshot
         FROM tool_compensation_lineage_v2 AS lineage
         JOIN agent_execution_runtime_states AS runtime
           ON runtime.execution_id = lineage.compensation_execution_id
         JOIN tool_dispatches_v2 AS original
           ON original.dispatch_id = lineage.original_dispatch_id
         JOIN tool_calls_v2 AS original_call
           ON original_call.tool_call_id = original.tool_call_id`,
      ).get()).toEqual({
        compensationSnapshot: "snapshot-ft10",
        originalSnapshot: "snapshot-ft10",
      });
    } finally {
      fixture.close();
    }
  });

  it("settles cancellation and principal/session fences fail-closed in the same transaction", () => {
    const fixture = testDatabase();
    const { database } = fixture;
    try {
      seedAuthority(database);
      prepareAndClaim(database);
      database.exec("BEGIN IMMEDIATE");
      const executionFence = settleToolSafetyExecutionFenceInTransaction(
        database, "execution-ft10", "execution_cancelled", new Date(NOW + 5_000).toISOString(),
      );
      database.exec("COMMIT");
      expect(executionFence).toMatchObject({
        rejectedConfirmationIds: [],
        revokedGrantIds: [],
        preservedDispatchIds: [expect.any(String)],
      });
      expect(database.prepare(
        "SELECT state, reason FROM tool_dispatches_v2",
      ).get()).toEqual({ state: "outcome_unknown", reason: "execution_cancelled" });
      expect(database.prepare(
        `SELECT execution.status, execution.terminal_error_code AS terminalErrorCode,
                runtime.public_status AS publicStatus, runtime.phase,
                runtime.review_state AS reviewState
         FROM agent_executions AS execution
         JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = execution.id
         WHERE execution.id = 'execution-ft10'`,
      ).get()).toEqual({
        status: "failed", terminalErrorCode: "side_effect_outcome_unknown",
        publicStatus: "failed", phase: "failed", reviewState: "needs_review",
      });
      const dispatchId = executionFence.preservedDispatchIds[0]!;
      expect(transact(database, {
        type: "tool-safety.settle",
        dispatchId,
        expectedVersion: 2,
        state: "known_succeeded",
        summary: { outcome: "late_known" },
        sealedCompensation: "opaque-late-compensation",
        now: NOW + 6_000,
      })).toMatchObject({ kind: "settled", state: "known_succeeded", version: 4 });
      expect(database.prepare(
        `SELECT dispatch.state, execution.status,
                runtime.public_status AS publicStatus, runtime.phase
         FROM tool_dispatches_v2 AS dispatch
         JOIN tool_calls_v2 AS call ON call.tool_call_id = dispatch.tool_call_id
         JOIN agent_executions AS execution ON execution.id = call.execution_id
         JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = execution.id
         WHERE dispatch.dispatch_id = ?`,
      ).get(dispatchId)).toEqual({
        state: "known_succeeded", status: "failed", publicStatus: "failed", phase: "failed",
      });

      const secondFixture = testDatabase();
      const { database: second } = secondFixture;
      try {
        seedAuthority(second);
        const parameters = parseToolParameters({
          toolId: "sandbox-file.write",
          argumentsJson: JSON.stringify({
            path: "notes/fence.txt", content: "pending", expectedCurrentSha256: EMPTY_SHA256,
          }),
        });
        const binding = transact(second, {
          type: "tool-safety.read-prepare-binding", executionId: "execution-ft10",
          attemptSeq: 1, toolId: "sandbox-file.write", now: NOW + 1_000,
        });
        if (binding.kind !== "prepare-binding") throw new Error("missing binding");
        transact(second, {
          type: "tool-safety.prepare", toolCallId: "tool-call-pending",
          invocationId: binding.invocationId, executionId: binding.executionId,
          attemptSeq: 1, expectedExecutionVersion: binding.executionVersion,
          toolId: "sandbox-file.write",
          canonicalParameterSha256: parameters.canonicalParameterSha256,
          parameterSchemaVersion: parameters.schemaVersion,
          canonicalizerVersion: parameters.canonicalizerVersion,
          safePreview: parameters.safePreview,
          sealedPayload: { ciphertext: "sealed", keyVersion: "test",
            expiresAt: new Date(NOW + 240_000).toISOString() },
          confirmation: { confirmationId: "confirmation-pending",
            context: context("pending"), bindingGeneration: 1 },
          now: NOW + 1_000,
        });
        second.exec("BEGIN IMMEDIATE");
        const principalFence = settleToolSafetyPrincipalFenceInTransaction(
          second, "human-ft10", "family-ft10", new Date(NOW + 2_000).toISOString(),
        );
        second.exec("COMMIT");
        expect(principalFence.rejectedConfirmationIds).toEqual(["confirmation-pending"]);
        expect(second.prepare(
          "SELECT state, reason FROM tool_confirmations_v2 WHERE confirmation_id = 'confirmation-pending'",
        ).get()).toEqual({ state: "rejected", reason: "principal_revoked" });
      } finally {
        secondFixture.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("recovers a crash-after-claim as review-only unknown and validates exact Human evidence", () => {
    const fixture = testDatabase();
    const { database } = fixture;
    try {
      seedAuthority(database);
      const claim = prepareAndClaim(database);
      expect(transact(database, {
        type: "tool-safety.recover-execution",
        executionId: "execution-ft10",
        now: NOW + 5_000,
      })).toEqual({
        kind: "recovery",
        state: "outcome_unknown",
        toolCallId: "tool-call-ft10",
        dispatchId: claim.dispatchId,
      });
      expect(database.prepare(
        "SELECT state, version FROM tool_dispatches_v2 WHERE dispatch_id = ?",
      ).get(claim.dispatchId)).toEqual({ state: "outcome_unknown", version: 3 });

      const evidenceSummary = "Human checked the target and confirmed no durable write exists.";
      expect(() => transact(database, {
        type: "tool-safety.outcome-review",
        context: context("review-invalid-hash"),
        dispatchId: claim.dispatchId,
        expectedVersion: 3,
        resolution: "known_failed",
        evidenceSummary,
        evidenceSha256: "0".repeat(64),
        now: NOW + 6_000,
      })).toThrow(/evidence/i);
      const evidenceSha256 = createHash("sha256").update(evidenceSummary).digest("hex");
      expect(transact(database, {
        type: "tool-safety.outcome-review",
        context: context("review-known-failed"),
        dispatchId: claim.dispatchId,
        expectedVersion: 3,
        resolution: "known_failed",
        evidenceSummary,
        evidenceSha256,
        now: NOW + 7_000,
      })).toMatchObject({
        kind: "reviewed",
        dispatchId: claim.dispatchId,
        resolution: "known_failed",
        version: 4,
        replayed: false,
      });
      expect(database.prepare(
        `SELECT dispatch.state, review.principal_human_actor_id AS reviewer,
                review.evidence_sha256 AS evidenceSha256
         FROM tool_dispatches_v2 AS dispatch
         JOIN tool_reviews_v2 AS review ON review.dispatch_id = dispatch.dispatch_id
         WHERE dispatch.dispatch_id = ?`,
      ).get(claim.dispatchId)).toEqual({
        state: "reviewed",
        reviewer: "human-ft10",
        evidenceSha256,
      });
    } finally {
      fixture.close();
    }
  });

  it("repairs a historical outcome_unknown whose parent closure did not commit", () => {
    const fixture = testDatabase();
    const { database } = fixture;
    try {
      seedAuthority(database);
      const claim = prepareAndClaim(database);
      const changedAt = new Date(NOW + 4_000).toISOString();
      database.prepare(
        `UPDATE tool_dispatches_v2 SET state = 'outcome_unknown', reason = 'adapter_ambiguous',
           settled_at = ?, version = 3, changed_at = ? WHERE dispatch_id = ?`,
      ).run(changedAt, changedAt, claim.dispatchId);

      expect(transact(database, {
        type: "tool-safety.recover-execution", executionId: "execution-ft10", now: NOW + 5_000,
      })).toMatchObject({ kind: "recovery", state: "outcome_unknown", dispatchId: claim.dispatchId });
      expect(database.prepare(
        `SELECT execution.status, execution.terminal_error_code AS terminalErrorCode,
                runtime.public_status AS publicStatus, runtime.phase,
                runtime.review_state AS reviewState
         FROM agent_executions AS execution
         JOIN agent_execution_runtime_states AS runtime ON runtime.execution_id = execution.id
         WHERE execution.id = 'execution-ft10'`,
      ).get()).toEqual({
        status: "failed", terminalErrorCode: "side_effect_outcome_unknown",
        publicStatus: "failed", phase: "failed", reviewState: "needs_review",
      });
    } finally {
      fixture.close();
    }
  });

  it("hands a pending confirmation to one exact authenticated Human binding", () => {
    const fixture = testDatabase();
    const { database } = fixture;
    const secondHuman = {
      actorId: "human-ft10-b",
      accountId: "account-ft10-b",
      familyId: "family-ft10-b",
      sessionId: "access-ft10-b",
    } as const;
    try {
      seedAuthority(database);
      const parameters = parseToolParameters({
        toolId: "sandbox-file.write",
        argumentsJson: JSON.stringify({
          path: "notes/handoff.txt",
          content: "handoff",
          expectedCurrentSha256: EMPTY_SHA256,
        }),
      });
      const binding = transact(database, {
        type: "tool-safety.read-prepare-binding",
        executionId: "execution-ft10",
        attemptSeq: 1,
        toolId: "sandbox-file.write",
        now: NOW + 1_000,
      });
      if (binding.kind !== "prepare-binding") throw new Error("missing binding");
      expect(transact(database, {
        type: "tool-safety.prepare",
        toolCallId: "tool-call-handoff",
        invocationId: binding.invocationId,
        executionId: binding.executionId,
        attemptSeq: binding.attemptSeq,
        expectedExecutionVersion: binding.executionVersion,
        toolId: "sandbox-file.write",
        canonicalParameterSha256: parameters.canonicalParameterSha256,
        parameterSchemaVersion: parameters.schemaVersion,
        canonicalizerVersion: parameters.canonicalizerVersion,
        safePreview: parameters.safePreview,
        sealedPayload: {
          ciphertext: "sealed-handoff-original",
          keyVersion: "test-key-v1",
          expiresAt: new Date(NOW + 240_000).toISOString(),
        },
        confirmation: {
          confirmationId: "confirmation-handoff",
          context: context("prepare-handoff"),
          bindingGeneration: 1,
        },
        now: NOW + 1_000,
      })).toMatchObject({ kind: "prepared", confirmationId: "confirmation-handoff" });

      database.prepare(
        `INSERT INTO tool_safety_command_receipts_v2 (
           principal_actor_id, command_kind, idempotency_key, request_sha256,
           response_json, committed_at, expires_at
         ) VALUES ('human-ft10', 'handoff_offer', 'offer-handoff', ?, '{}', ?, ?)`,
      ).run("0".repeat(64), new Date(NOW - 2_000).toISOString(),
        new Date(NOW - 1_000).toISOString());

      expect(transact(database, {
        type: "tool-safety.handoff-offer",
        context: context("offer-handoff"),
        confirmationId: "confirmation-handoff",
        expectedVersion: 1,
        targetActorId: secondHuman.actorId,
        handoffId: "handoff-ft10",
        now: NOW + 2_000,
      })).toMatchObject({ kind: "handoff", state: "offered", replayed: false });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM tool_safety_command_receipts_v2
         WHERE principal_actor_id = 'human-ft10' AND command_kind = 'handoff_offer'
           AND idempotency_key = 'offer-handoff' AND expires_at > ?`,
      ).get(new Date(NOW + 2_000).toISOString())).toEqual({ count: 1 });
      expect(transact(database, {
        type: "tool-safety.handoff-read",
        context: context("read-handoff", secondHuman),
        handoffId: "handoff-ft10",
        expectedVersion: 1,
        now: NOW + 3_000,
      })).toMatchObject({
        kind: "handoff-binding",
        toPrincipalActorId: secondHuman.actorId,
        toSessionFamilyId: secondHuman.familyId,
        claimBinding: {
          principalActorId: "human-ft10",
          sessionFamilyId: "family-ft10",
          bindingGeneration: 1,
        },
      });
      expect(transact(database, {
        type: "tool-safety.handoff-accept",
        context: context("accept-handoff", secondHuman),
        handoffId: "handoff-ft10",
        expectedVersion: 1,
        resealedPayload: {
          ciphertext: "sealed-handoff-target",
          keyVersion: "test-key-v1",
          expiresAt: new Date(NOW + 240_000).toISOString(),
        },
        now: NOW + 4_000,
      })).toMatchObject({ kind: "handoff", state: "accepted", version: 2 });
      const repairedConfirmation = database.prepare(
        `SELECT version, projection_json AS projectionJson
         FROM tool_safety_repair_records_v2
         WHERE kind = 'tool-confirmation' AND record_id = 'confirmation-handoff'`,
      ).get() as { version: number; projectionJson: string };
      expect(repairedConfirmation.version).toBe(2);
      expect(JSON.parse(repairedConfirmation.projectionJson)).toMatchObject({
        confirmationId: "confirmation-handoff",
        state: "pending",
        version: 2,
        namedHumanDisplayRef: "Human FT10 B",
      });
      expect(transact(database, {
        type: "tool-safety.handoff-read",
        context: context("accept-handoff", secondHuman),
        handoffId: "handoff-ft10",
        expectedVersion: 1,
        now: NOW + 4_500,
      })).toMatchObject({ kind: "handoff", state: "accepted", version: 2, replayed: true });
      expect(() => transact(database, {
        type: "tool-safety.confirmation-decide",
        context: context("stale-original-human"),
        confirmationId: "confirmation-handoff",
        expectedVersion: 2,
        decision: "reject",
        now: NOW + 5_000,
      })).toThrow(/principal.*forbidden/i);
      expect(transact(database, {
        type: "tool-safety.confirmation-decide",
        context: context("confirm-handoff", secondHuman),
        confirmationId: "confirmation-handoff",
        expectedVersion: 2,
        decision: "confirm",
        grantId: "grant-handoff",
        grantExpiresAt: new Date(NOW + 30_000).toISOString(),
        now: NOW + 6_000,
      })).toMatchObject({ kind: "confirmation-decision", state: "confirmed", version: 3 });
      expect(() => transact(database, {
        type: "tool-safety.confirmation-decide",
        context: context("cross-session-duplicate", secondHuman),
        confirmationId: "confirmation-handoff",
        expectedVersion: 3,
        decision: "confirm",
        grantId: "grant-handoff-duplicate",
        grantExpiresAt: new Date(NOW + 31_000).toISOString(),
        now: NOW + 6_500,
      })).toThrow(/already terminal/i);
      expect(transact(database, {
        type: "tool-safety.recover-execution",
        executionId: "execution-ft10",
        now: NOW + 7_000,
      })).toMatchObject({
        kind: "recovery",
        state: "confirmed_active",
        grantId: "grant-handoff",
        claimBinding: {
          principalActorId: secondHuman.actorId,
          sessionFamilyId: secondHuman.familyId,
          bindingGeneration: 2,
        },
      });
    } finally {
      fixture.close();
    }
  });

  it("archives v2 pending authority with a stable event and outbox delivery in one transaction", () => {
    const fixture = testDatabase();
    const { database } = fixture;
    try {
      seedAuthority(database);
      const parameters = parseToolParameters({
        toolId: "sandbox-file.write",
        argumentsJson: JSON.stringify({
          path: "notes/archive.txt",
          content: "archive",
          expectedCurrentSha256: EMPTY_SHA256,
        }),
      });
      const binding = transact(database, {
        type: "tool-safety.read-prepare-binding",
        executionId: "execution-ft10",
        attemptSeq: 1,
        toolId: "sandbox-file.write",
        now: NOW + 1_000,
      });
      if (binding.kind !== "prepare-binding") throw new Error("missing binding");
      transact(database, {
        type: "tool-safety.prepare",
        toolCallId: "tool-call-archive",
        invocationId: binding.invocationId,
        executionId: binding.executionId,
        attemptSeq: binding.attemptSeq,
        expectedExecutionVersion: binding.executionVersion,
        toolId: "sandbox-file.write",
        canonicalParameterSha256: parameters.canonicalParameterSha256,
        parameterSchemaVersion: parameters.schemaVersion,
        canonicalizerVersion: parameters.canonicalizerVersion,
        safePreview: parameters.safePreview,
        sealedPayload: {
          ciphertext: "sealed-archive",
          keyVersion: "test-key-v1",
          expiresAt: new Date(NOW + 240_000).toISOString(),
        },
        confirmation: {
          confirmationId: "confirmation-archive",
          context: context("prepare-archive"),
          bindingGeneration: 1,
        },
        now: NOW + 1_000,
      });
      const occurredAt = new Date(NOW + 2_000).toISOString();
      database.exec("BEGIN IMMEDIATE");
      const transaction = mintDatabaseAuthorityTransactionView(
        database, "room-ft10", "archive-tool-safety-v2",
      );
      try {
        database.prepare(
          `UPDATE rooms SET status = 'archived', archive_generation = 1, archived_at = ?
           WHERE id = 'room-ft10' AND status = 'active'`,
        ).run(occurredAt);
        const result = createArchiveToolSafetyParticipant().settleUndispatched(transaction, {
          roomId: "room-ft10",
          archiveGeneration: 1,
          now: occurredAt,
        });
        expect(result).toMatchObject({ ok: true, result: { rejectedPendingCount: 1 } });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        releaseDatabaseAuthorityTransactionView(transaction);
      }
      expect(database.prepare(
        `SELECT state, reason FROM tool_confirmations_v2
         WHERE confirmation_id = 'confirmation-archive'`,
      ).get()).toEqual({ state: "rejected", reason: "room_archived" });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE event_type = 'tool.safety.changed'
           AND json_extract(payload_json, '$.kind') = 'tool-confirmation'
           AND json_extract(payload_json, '$.value.confirmationId') = 'confirmation-archive'
           AND json_extract(payload_json, '$.value.state') = 'rejected'`,
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_deliveries AS delivery
         JOIN events AS event ON event.event_id = delivery.event_id
         WHERE event.event_type = 'tool.safety.changed'
           AND json_extract(event.payload_json, '$.value.confirmationId') = 'confirmation-archive'
           AND json_extract(event.payload_json, '$.value.state') = 'rejected'`,
      ).get()).toEqual({ count: 1 });
    } finally {
      fixture.close();
    }
  });
});
