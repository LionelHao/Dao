import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import type { AuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import { mintDirectInvocationOrigin } from "../route-runtime/trusted-invocation-origin.js";
import {
  DirectIntentAuthorityError,
  claimRoutedInvocationIntent,
  createDirectInvocationIntent,
  readPendingRoutedInvocationIntents,
  readRoutedInvocationIntent,
  recoverPendingRoutedInvocationIntents,
} from "./durable-trusted-intent-authority.js";

const NOW = "2026-08-24T09:00:00.000Z";

function installFixture(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE rooms (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL) STRICT;
    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL, actor_id TEXT NOT NULL, kind TEXT NOT NULL,
      participation TEXT, access_revision INTEGER NOT NULL,
      PRIMARY KEY (room_id, actor_id)
    ) STRICT;
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE room_agent_assignments (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      agent_actor_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
      participation TEXT NOT NULL, paused INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE agent_profile_revisions (
      profile_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_id TEXT NOT NULL,
      PRIMARY KEY (profile_id, revision)
    ) STRICT;
    CREATE TABLE room_agent_assignment_revisions (
      assignment_id TEXT NOT NULL, revision INTEGER NOT NULL, room_id TEXT NOT NULL,
      profile_id TEXT NOT NULL, agent_actor_id TEXT NOT NULL,
      participation TEXT NOT NULL,
      PRIMARY KEY (assignment_id, revision)
    ) STRICT;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, author_id TEXT NOT NULL,
      author_kind TEXT NOT NULL
    ) STRICT;
    CREATE TABLE message_revisions (
      message_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (message_id, revision)
    ) STRICT;
    CREATE TABLE message_envelopes (
      message_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, message_kind TEXT NOT NULL,
      lifecycle TEXT NOT NULL, current_revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE message_mentions (
      message_id TEXT NOT NULL, room_id TEXT NOT NULL, target_id TEXT NOT NULL,
      target_kind TEXT NOT NULL, target_actor_id TEXT NOT NULL,
      PRIMARY KEY (message_id, target_id)
    ) STRICT;
    CREATE TABLE agent_invocation_intents (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL, requester_actor_id TEXT NOT NULL,
      intent_kind TEXT NOT NULL, execution_id TEXT, created_at TEXT NOT NULL,
      message_transaction_id TEXT, target_id TEXT, source_revision INTEGER NOT NULL,
      lineage_id TEXT, turn_id TEXT, origin_kind TEXT NOT NULL, status TEXT NOT NULL,
      claimed_at TEXT, cancelled_at TEXT, cancellation_reason TEXT,
      supersedes_intent_id TEXT,
      UNIQUE (message_transaction_id, target_id)
    ) STRICT;
    CREATE TABLE direct_agent_invocation_authority_bindings (
      intent_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
      profile_revision INTEGER NOT NULL, assignment_id TEXT NOT NULL,
      assignment_revision INTEGER NOT NULL, access_revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE route_jobs (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      revision INTEGER NOT NULL, candidate_snapshot_id TEXT
    ) STRICT;
    CREATE TABLE route_candidate_snapshots (
      id TEXT PRIMARY KEY, route_job_id TEXT NOT NULL, room_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL, source_message_revision INTEGER NOT NULL,
      source_author_kind TEXT NOT NULL, source_message_kind TEXT NOT NULL
    ) STRICT;
    CREATE TABLE route_candidate_snapshot_agents (
      snapshot_id TEXT NOT NULL, route_job_id TEXT NOT NULL, agent_actor_id TEXT NOT NULL,
      profile_id TEXT NOT NULL, profile_revision INTEGER NOT NULL,
      assignment_id TEXT NOT NULL, assignment_revision INTEGER NOT NULL,
      access_revision INTEGER NOT NULL, participation TEXT NOT NULL,
      availability TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, agent_actor_id)
    ) STRICT;
    CREATE TABLE route_decisions (
      id TEXT PRIMARY KEY, route_job_id TEXT NOT NULL, expected_route_job_revision INTEGER NOT NULL,
      snapshot_id TEXT NOT NULL, outcome TEXT NOT NULL
    ) STRICT;
    CREATE TABLE routed_agent_invocation_intents (
      id TEXT PRIMARY KEY, route_decision_id TEXT NOT NULL, route_job_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      source_message_revision INTEGER NOT NULL, target_agent_actor_id TEXT NOT NULL,
      profile_id TEXT NOT NULL, profile_revision INTEGER NOT NULL,
      assignment_id TEXT NOT NULL, assignment_revision INTEGER NOT NULL,
      access_revision INTEGER NOT NULL, trigger_kind TEXT NOT NULL,
      reason_text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      claimed_at TEXT, cancelled_at TEXT, cancellation_reason TEXT,
      UNIQUE (route_decision_id, target_agent_actor_id)
    ) STRICT;
    CREATE TABLE agent_executions (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;

    INSERT INTO rooms VALUES ('room-1', 'active'), ('room-2', 'active');
    INSERT INTO actors VALUES
      ('human-1', 'human'), ('agent-a', 'agent'), ('agent-b', 'agent');
    INSERT INTO room_memberships VALUES
      ('room-1', 'human-1', 'human', NULL, 3),
      ('room-1', 'agent-a', 'agent', 'active', 5),
      ('room-1', 'agent-b', 'agent', 'active', 6);
    INSERT INTO agent_profiles VALUES
      ('profile-a', 'agent-a', 7, 'enabled'),
      ('profile-b', 'agent-b', 8, 'enabled');
    INSERT INTO room_agent_assignments VALUES
      ('assignment-a', 'room-1', 'profile-a', 'agent-a', 11, 'current', 'active', 0),
      ('assignment-b', 'room-1', 'profile-b', 'agent-b', 12, 'current', 'active', 0);
    INSERT INTO agent_profile_revisions VALUES
      ('profile-a', 7, 'agent-a'), ('profile-b', 8, 'agent-b');
    INSERT INTO room_agent_assignment_revisions VALUES
      ('assignment-a', 11, 'room-1', 'profile-a', 'agent-a', 'active'),
      ('assignment-b', 12, 'room-1', 'profile-b', 'agent-b', 'active');
    INSERT INTO messages VALUES ('message-1', 'room-1', 'human-1', 'human');
    INSERT INTO message_revisions VALUES ('message-1', 1);
    INSERT INTO message_envelopes VALUES
      ('message-1', 'room-1', 'human', 'active', 1);
    INSERT INTO message_mentions VALUES
      ('message-1', 'room-1', 'target-a', 'agent-invocation', 'agent-a');
    INSERT INTO route_jobs VALUES ('job-1', 'room-1', 'message-1', 4, 'snapshot-1');
    INSERT INTO route_candidate_snapshots VALUES
      ('snapshot-1', 'job-1', 'room-1', 'message-1', 1, 'human', 'human');
    INSERT INTO route_candidate_snapshot_agents VALUES
      ('snapshot-1', 'job-1', 'agent-a', 'profile-a', 7, 'assignment-a', 11, 5,
       'active', 'ready'),
      ('snapshot-1', 'job-1', 'agent-b', 'profile-b', 8, 'assignment-b', 12, 6,
       'active', 'ready');
    INSERT INTO route_decisions VALUES ('decision-1', 'job-1', 4, 'snapshot-1', 'selected');
    INSERT INTO routed_agent_invocation_intents VALUES
      ('intent-a', 'decision-1', 'job-1', 'snapshot-1', 'room-1', 'message-1', 1,
       'agent-a', 'profile-a', 7, 'assignment-a', 11, 5, 'domain', 'Domain fit',
       'pending', '2026-08-24T08:00:00.000Z', NULL, NULL, NULL),
      ('intent-b', 'decision-1', 'job-1', 'snapshot-1', 'room-1', 'message-1', 1,
       'agent-b', 'profile-b', 8, 'assignment-b', 12, 6, 'risk', 'Risk owner',
       'pending', '2026-08-24T08:01:00.000Z', NULL, NULL, NULL);
  `);
}

describe("durable trusted intent Authority transaction", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    installFixture(database);
  });

  afterEach(() => database.close());

  function transact<T>(
    roomId: string,
    operation: (transaction: AuthorityTransactionView) => T,
  ): T {
    const transaction = mintDatabaseAuthorityTransactionView(database, roomId, `tx-${roomId}`);
    try {
      return operation(transaction);
    } finally {
      releaseDatabaseAuthorityTransactionView(transaction);
    }
  }

  it("creates an on-mention direct intent from trusted exact binding in the same transaction", () => {
    database.exec("UPDATE room_agent_assignments SET participation = 'on-mention' WHERE id = 'assignment-a'");
    const origin = mintDirectInvocationOrigin({
      kind: "message_target", roomId: "room-1", messageId: "message-1", messageRevision: 1,
      targetOutcomeId: "target-a", targetActorId: "agent-a", profileId: "profile-a",
      profileRevision: 7, assignmentId: "assignment-a", assignmentRevision: 11,
      accessRevision: 5,
    });

    const result = transact("room-1", (transaction) => createDirectInvocationIntent(transaction, {
      origin, intentId: "direct-a", requesterActorId: "human-1", lineageId: "lineage-a",
      turnId: "turn-a", createdAt: NOW,
    }));

    expect(result.disposition).toBe("created");
    expect(result.binding).toEqual({
      actorId: "agent-a", profileId: "profile-a", profileRevision: 7,
      assignmentId: "assignment-a", assignmentRevision: 11, accessRevision: 5,
      participation: "on-mention",
    });
    expect(database.prepare(
      "SELECT status, origin_kind AS originKind, target_id AS targetId FROM agent_invocation_intents",
    ).get()).toEqual({ status: "pending", originKind: "message_target", targetId: "target-a" });
    expect(database.prepare(
      `SELECT profile_id AS profileId, profile_revision AS profileRevision,
              assignment_id AS assignmentId, assignment_revision AS assignmentRevision,
              access_revision AS accessRevision
       FROM direct_agent_invocation_authority_bindings`,
    ).get()).toEqual({
      profileId: "profile-a", profileRevision: 7,
      assignmentId: "assignment-a", assignmentRevision: 11, accessRevision: 5,
    });
  });

  it("rejects structural origin forgery and cross-Room probing without writing", () => {
    const forged = {
      kind: "message_target", roomId: "room-1", messageId: "message-1", messageRevision: 1,
      targetOutcomeId: "target-a", targetActorId: "agent-a", profileId: "profile-a",
      profileRevision: 7, assignmentId: "assignment-a", assignmentRevision: 11,
      accessRevision: 5,
    } as ReturnType<typeof mintDirectInvocationOrigin>;
    expect(() => transact("room-1", (transaction) => createDirectInvocationIntent(transaction, {
      origin: forged, intentId: "forged", requesterActorId: "human-1", lineageId: "lineage",
      turnId: "turn", createdAt: NOW,
    }))).toThrowError(DirectIntentAuthorityError);

    const trusted = mintDirectInvocationOrigin({ ...forged });
    expect(() => transact("room-2", (transaction) => createDirectInvocationIntent(transaction, {
      origin: trusted, intentId: "cross-room", requesterActorId: "human-1",
      lineageId: "lineage", turnId: "turn", createdAt: NOW,
    }))).toThrowError(/room_mismatch/);
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_invocation_intents").get())
      .toEqual({ count: 0 });
  });

  it("fails direct creation closed on stale Profile, Assignment, or access revisions", () => {
    const cases = [
      ["profileRevision", 6, "profile_revision_stale"],
      ["assignmentRevision", 10, "assignment_revision_stale"],
      ["accessRevision", 4, "access_revision_stale"],
    ] as const;
    for (const [field, value, code] of cases) {
      const origin = mintDirectInvocationOrigin({
        kind: "message_target", roomId: "room-1", messageId: "message-1", messageRevision: 1,
        targetOutcomeId: "target-a", targetActorId: "agent-a", profileId: "profile-a",
        profileRevision: 7, assignmentId: "assignment-a", assignmentRevision: 11,
        accessRevision: 5, [field]: value,
      });
      expect(() => transact("room-1", (transaction) => createDirectInvocationIntent(transaction, {
        origin, intentId: `direct-${field}`, requesterActorId: "human-1",
        lineageId: `lineage-${field}`, turnId: `turn-${field}`, createdAt: NOW,
      }))).toThrowError(expect.objectContaining({ code }));
    }
    const wrongProfile = mintDirectInvocationOrigin({
      kind: "message_target", roomId: "room-1", messageId: "message-1", messageRevision: 1,
      targetOutcomeId: "target-a", targetActorId: "agent-a", profileId: "profile-b",
      profileRevision: 8, assignmentId: "assignment-a", assignmentRevision: 11,
      accessRevision: 5,
    });
    expect(() => transact("room-1", (transaction) => createDirectInvocationIntent(transaction, {
      origin: wrongProfile, intentId: "wrong-profile", requesterActorId: "human-1",
      lineageId: "lineage-profile", turnId: "turn-profile", createdAt: NOW,
    }))).toThrowError(expect.objectContaining({ code: "profile_unavailable" }));
    const wrongAssignment = mintDirectInvocationOrigin({
      kind: "message_target", roomId: "room-1", messageId: "message-1", messageRevision: 1,
      targetOutcomeId: "target-a", targetActorId: "agent-a", profileId: "profile-a",
      profileRevision: 7, assignmentId: "assignment-b", assignmentRevision: 12,
      accessRevision: 5,
    });
    expect(() => transact("room-1", (transaction) => createDirectInvocationIntent(transaction, {
      origin: wrongAssignment, intentId: "wrong-assignment", requesterActorId: "human-1",
      lineageId: "lineage-assignment", turnId: "turn-assignment", createdAt: NOW,
    }))).toThrowError(expect.objectContaining({ code: "assignment_removed" }));
  });

  it("is idempotent only for the same exact direct intent", () => {
    const origin = mintDirectInvocationOrigin({
      kind: "message_target", roomId: "room-1", messageId: "message-1", messageRevision: 1,
      targetOutcomeId: "target-a", targetActorId: "agent-a", profileId: "profile-a",
      profileRevision: 7, assignmentId: "assignment-a", assignmentRevision: 11,
      accessRevision: 5,
    });
    const input = { origin, intentId: "direct-a", requesterActorId: "human-1",
      lineageId: "lineage-a", turnId: "turn-a", createdAt: NOW } as const;
    transact("room-1", (transaction) => createDirectInvocationIntent(transaction, input));
    expect(transact("room-1", (transaction) =>
      createDirectInvocationIntent(transaction, input)).disposition).toBe("already-created");
    expect(() => transact("room-1", (transaction) => createDirectInvocationIntent(transaction, {
      ...input, intentId: "different-id",
    }))).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
  });

  it("replays the immutable direct binding after Profile rename and authority reduction", () => {
    const origin = mintDirectInvocationOrigin({
      kind: "message_target", roomId: "room-1", messageId: "message-1", messageRevision: 1,
      targetOutcomeId: "target-a", targetActorId: "agent-a", profileId: "profile-a",
      profileRevision: 7, assignmentId: "assignment-a", assignmentRevision: 11,
      accessRevision: 5,
    });
    const input = { origin, intentId: "direct-race", requesterActorId: "human-1",
      lineageId: "lineage-race", turnId: "turn-race", createdAt: NOW } as const;
    const created = transact("room-1", (transaction) =>
      createDirectInvocationIntent(transaction, input));
    database.exec(`
      UPDATE agent_profiles SET revision = 8, status = 'disabled' WHERE id = 'profile-a';
      UPDATE room_agent_assignments
      SET revision = 12, status = 'removed', paused = 1 WHERE id = 'assignment-a';
      UPDATE room_memberships SET access_revision = 6 WHERE room_id = 'room-1' AND actor_id = 'agent-a';
    `);
    const replayed = transact("room-1", (transaction) =>
      createDirectInvocationIntent(transaction, input));
    expect(replayed.disposition).toBe("already-created");
    expect(replayed.binding).toEqual(created.binding);
  });

  it("reads pending routed intents in stable bounded Room-local order", () => {
    expect(transact("room-1", (transaction) =>
      readPendingRoutedInvocationIntents(transaction, 1)).map((intent) => intent.intentId))
      .toEqual(["intent-a"]);
    expect(() => transact("room-1", (transaction) =>
      readPendingRoutedInvocationIntents(transaction, 257))).toThrow(/limit/);
    expect(transact("room-2", (transaction) =>
      readPendingRoutedInvocationIntents(transaction, 2))).toEqual([]);
  });

  it("claims a valid routed intent once and returns an execution-free durable handoff", () => {
    const claimed = transact("room-1", (transaction) => claimRoutedInvocationIntent(transaction, {
      intentId: "intent-a", claimedAt: NOW, providerReady: true,
    }));
    expect(claimed.disposition).toBe("claimed");
    expect(claimed.handoff).toMatchObject({
      intentId: "intent-a", actorId: "agent-a", profileId: "profile-a",
      assignmentId: "assignment-a", accessRevision: 5,
    });
    expect(claimed.handoff).not.toHaveProperty("executionId");

    const repeated = transact("room-1", (transaction) => claimRoutedInvocationIntent(transaction, {
      intentId: "intent-a", claimedAt: "2026-08-24T10:00:00.000Z", providerReady: false,
    }));
    expect(repeated.disposition).toBe("already-claimed");
    expect(repeated.intent.claimedAt).toBe(NOW);
    expect(() => transact("room-1", (transaction) => claimRoutedInvocationIntent(transaction, {
      intentId: "intent-b", claimedAt: NOW, providerReady: true,
      clientToken: "not-authority",
    } as Parameters<typeof claimRoutedInvocationIntent>[1]))).toThrow(/claim input/);
  });

  it.each([
    ["paused", "UPDATE room_agent_assignments SET paused = 1 WHERE id = 'assignment-a'", true,
      "assignment_paused"],
    ["removed", "UPDATE room_agent_assignments SET status = 'removed' WHERE id = 'assignment-a'", true,
      "assignment_removed"],
    ["profile stale", "UPDATE agent_profiles SET revision = 8 WHERE id = 'profile-a'", true,
      "profile_revision_stale"],
    ["assignment stale", "UPDATE room_agent_assignments SET revision = 12 WHERE id = 'assignment-a'", true,
      "assignment_revision_stale"],
    ["access revoked", "DELETE FROM room_memberships WHERE room_id = 'room-1' AND actor_id = 'agent-a'", true,
      "access_revoked"],
    ["access stale", "UPDATE room_memberships SET access_revision = 6 WHERE room_id = 'room-1' AND actor_id = 'agent-a'", true,
      "access_revision_stale"],
    ["noauth", "SELECT 1", false, "noauth"],
    ["busy", "INSERT INTO agent_executions VALUES ('execution-a', 'room-1', 'agent-a', 'running')", true,
      "busy"],
  ])("cancels %s at claim without choosing a fallback", (_label, mutation, providerReady, reason) => {
    database.exec(mutation);
    const result = transact("room-1", (transaction) => claimRoutedInvocationIntent(transaction, {
      intentId: "intent-a", claimedAt: NOW, providerReady,
    }));
    expect(result.disposition).toBe("cancelled");
    expect(result.intent).toMatchObject({
      actorId: "agent-a", status: "cancelled", cancellationReason: reason,
    });
    expect(database.prepare(
      "SELECT status FROM routed_agent_invocation_intents WHERE id = 'intent-b'",
    ).get()).toEqual({ status: "pending" });
  });

  it("cancels forged database provenance before authority and availability gates", () => {
    database.exec("UPDATE routed_agent_invocation_intents SET snapshot_id = 'forged-snapshot' WHERE id = 'intent-a'");
    const result = transact("room-1", (transaction) => claimRoutedInvocationIntent(transaction, {
      intentId: "intent-a", claimedAt: NOW, providerReady: true,
    }));
    expect(result.intent.cancellationReason).toBe("route_provenance_invalid");
  });

  it("isolates targets so one cancellation cannot roll back another claim", () => {
    database.exec("UPDATE room_agent_assignments SET paused = 1 WHERE id = 'assignment-a'");
    const a = transact("room-1", (transaction) => claimRoutedInvocationIntent(transaction, {
      intentId: "intent-a", claimedAt: NOW, providerReady: true,
    }));
    const b = transact("room-1", (transaction) => claimRoutedInvocationIntent(transaction, {
      intentId: "intent-b", claimedAt: NOW, providerReady: true,
    }));
    expect([a.disposition, b.disposition]).toEqual(["cancelled", "claimed"]);
  });

  it("rediscovers pending intents after releasing and recreating the worker transaction capability", () => {
    const first = transact("room-1", (transaction) =>
      readPendingRoutedInvocationIntents(transaction, 2));
    expect(first).toHaveLength(2);
    const restarted = transact("room-1", (transaction) =>
      recoverPendingRoutedInvocationIntents(transaction, 2));
    expect(restarted.map((intent) => intent.intentId)).toEqual(["intent-a", "intent-b"]);
    expect(transact("room-1", (transaction) =>
      readRoutedInvocationIntent(transaction, "intent-a")?.status)).toBe("pending");
  });
});
