import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
  useAuthorityTransactionDatabase,
} from "../persistence/authority-transaction-database.js";
import {
  AUTHORITY_PARTICIPANT_FEATURES,
  mintAuthorityTransactionView,
  type AuthorityParticipantEnvelope,
  type AuthorityParticipantFeature,
  type AuthorityTransactionView,
  type DepartureContributionResult,
  type FeatureEnablementManifest,
  type ParticipantRegistration,
  type PendingConfirmationDepartureContributor,
} from "../room-governance/private-participant-contracts.js";
import {
  AuthorityParticipantUnavailableError,
  invokeAuthorityParticipant,
} from "../room-governance/private-participant-registry.js";
import {
  createDepartureResponsibilityRegistration,
  type DepartureResponsibilityComposition,
} from "./departure-responsibility-port.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabase(path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE project_requests (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL CHECK (source_room_id = room_id),
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      requester_human_actor_id TEXT NOT NULL,
      target_human_actor_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending_acceptance', 'accepted', 'rejected', 'cancelled')
      ),
      source_kind TEXT NOT NULL DEFAULT 'message'
    ) STRICT;
    CREATE TABLE project_next_actions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL CHECK (source_room_id = room_id),
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('human', 'agent')),
      owner_actor_id TEXT NOT NULL,
      verifier_human_actor_id TEXT,
      status TEXT NOT NULL CHECK (
        status IN (
          'proposed', 'accepted', 'in_progress', 'delivered', 'done', 'rejected',
          'cancelled'
        )
      ),
      source_kind TEXT NOT NULL DEFAULT 'message',
      CHECK (owner_kind = 'human' OR verifier_human_actor_id IS NOT NULL)
    ) STRICT;
    CREATE TABLE project_obstacles (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL CHECK (source_room_id = room_id),
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      kind TEXT NOT NULL CHECK (kind IN ('blocker', 'open_question')),
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('human', 'agent')),
      owner_actor_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('open', 'resolved', 'deferred', 'cannot_answer')
      ),
      source_kind TEXT NOT NULL DEFAULT 'message'
    ) STRICT;
    CREATE TABLE project_transfer_proposals (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL CHECK (source_room_id = room_id),
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      subject_kind TEXT NOT NULL CHECK (
        subject_kind IN ('next_action', 'blocker', 'open_question')
      ),
      subject_id TEXT NOT NULL,
      to_owner_kind TEXT NOT NULL CHECK (to_owner_kind IN ('human', 'agent')),
      to_owner_actor_id TEXT NOT NULL,
      principal_human_actor_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')
      ),
      source_kind TEXT NOT NULL DEFAULT 'message'
    ) STRICT;
    CREATE TABLE project_fact_proposals (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL CHECK (source_room_id = room_id),
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0)
    ) STRICT;
    CREATE TABLE project_confirmations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      principal_human_actor_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'rejected', 'expired'))
    ) STRICT;
    CREATE TABLE departure_write_probes (
      id TEXT PRIMARY KEY
    ) STRICT;
  `);
  return database;
}

function insertCompleteResponsibilityFixture(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO project_requests VALUES
      ('request-target', 'room-1', 'room-1', 'message-request-target', 2,
       'human-requester', 'human-1', 'pending_acceptance', 'message'),
      ('request-requester', 'room-1', 'room-1', 'message-request-requester', 3,
       'human-1', 'human-target', 'pending_acceptance', 'message'),
      ('request-terminal', 'room-1', 'room-1', 'message-request-terminal', 1,
       'human-1', 'human-target', 'accepted', 'message'),
      ('request-legacy', 'room-1', 'room-1', 'legacy-request', 1,
       'human-1', 'human-target', 'pending_acceptance', 'legacy_v14');
    INSERT INTO project_next_actions VALUES
      ('action-owned', 'room-1', 'room-1', 'message-action-owned', 4,
       'human', 'human-1', NULL, 'in_progress', 'message'),
      ('action-verification', 'room-1', 'room-1', 'execution-action', 5,
       'agent', 'agent-1', 'human-1', 'delivered', 'agent_execution'),
      ('action-verifier-active', 'room-1', 'room-1', 'message-agent-active', 3,
       'agent', 'agent-2', 'human-1', 'in_progress', 'message'),
      ('action-done', 'room-1', 'room-1', 'message-action-done', 2,
       'human', 'human-1', NULL, 'done', 'message'),
      ('action-legacy', 'room-1', 'room-1', 'legacy-action', 1,
       'human', 'human-1', NULL, 'in_progress', 'legacy_v14');
    INSERT INTO project_obstacles VALUES
      ('blocker-1', 'room-1', 'room-1', 'message-blocker', 6,
       'blocker', 'human', 'human-1', 'open', 'message'),
      ('question-1', 'room-1', 'room-1', 'message-question', 7,
       'open_question', 'human', 'human-1', 'deferred', 'message'),
      ('obstacle-resolved', 'room-1', 'room-1', 'message-resolved', 1,
       'blocker', 'human', 'human-1', 'resolved', 'message'),
      ('obstacle-legacy', 'room-1', 'room-1', 'legacy-obstacle', 1,
       'blocker', 'human', 'human-1', 'open', 'legacy_v14');
    INSERT INTO project_transfer_proposals VALUES
      ('transfer-1', 'room-1', 'room-1', 'message-transfer', 8,
       'next_action', 'action-other', 'human', 'human-1', 'human-1', 'pending', 'message'),
      ('transfer-agent', 'room-1', 'room-1', 'message-transfer-agent', 2,
       'next_action', 'action-agent', 'agent', 'agent-3', 'human-1', 'pending', 'message'),
      ('transfer-terminal', 'room-1', 'room-1', 'message-transfer-terminal', 1,
       'blocker', 'blocker-other', 'human', 'human-1', 'human-1', 'rejected', 'message'),
      ('transfer-legacy', 'room-1', 'room-1', 'legacy-transfer', 1,
       'blocker', 'legacy-blocker', 'human', 'human-1', 'human-1', 'pending', 'legacy_v14');
    INSERT INTO project_fact_proposals VALUES
      ('proposal-confirmation', 'room-1', 'room-1', 'message-confirmation', 4);
    INSERT INTO project_confirmations VALUES
      ('confirmation-project', 'room-1', 'proposal-confirmation', 2, 'human-1', 'pending');
  `);
}

function manifest(
  enabled: readonly AuthorityParticipantFeature[],
): FeatureEnablementManifest {
  return Object.freeze(Object.fromEntries(
    AUTHORITY_PARTICIPANT_FEATURES.map((feature) => [feature, enabled.includes(feature)]),
  )) as FeatureEnablementManifest;
}

function pendingRegistration(
  implementation: PendingConfirmationDepartureContributor["listPendingConfirmationsInTransaction"],
): ParticipantRegistration<PendingConfirmationDepartureContributor> {
  return Object.freeze({
    registrationId: "dao.tool-safety.pending-confirmation-departure.v1",
    feature: "pending-confirmation-departure" as const,
    version: 1 as const,
    enabled: true,
    participant: Object.freeze({ listPendingConfirmationsInTransaction: implementation }),
  });
}

function pendingResult(
  roomId = "room-1",
  extras: Readonly<Record<string, unknown>> = {},
): AuthorityParticipantEnvelope<DepartureContributionResult> {
  return {
    ok: true,
    result: {
      roomId,
      targetHumanActorId: "human-1",
      conflicts: [{
        conflictId: "pending-confirmation-conflict",
        roomId,
        subjectId: "confirmation-1",
        kind: "confirmation",
        title: "tool.confirmation.pending",
        state: "pending",
        allowedResolutions: ["reject_or_revoke"],
        sourceId: "execution-1",
        revision: 1,
        ...extras,
      }],
    },
  };
}

function withTransaction<TResult>(
  database: DatabaseSync,
  roomId: string,
  operation: (transaction: AuthorityTransactionView) => TResult,
): TResult {
  database.exec("BEGIN IMMEDIATE");
  const transaction = mintDatabaseAuthorityTransactionView(
    database,
    roomId,
    `transaction-${roomId}`,
  );
  try {
    const result = operation(transaction);
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    releaseDatabaseAuthorityTransactionView(transaction);
  }
}

function invokeDeparture(
  database: DatabaseSync,
  composition: DepartureResponsibilityComposition = {
    pendingConfirmation: { enabled: false },
  },
): DepartureContributionResult {
  const registration = createDepartureResponsibilityRegistration(composition);
  return withTransaction(database, "room-1", (transaction) => invokeAuthorityParticipant({
    feature: "departure-responsibility",
    manifest: manifest(["departure-responsibility"]),
    registrations: [registration],
    tx: transaction,
    roomId: "room-1",
    invoke: (participant) => participant.listInTransaction(transaction, {
      roomId: "room-1",
      targetHumanActorId: "human-1",
    }),
  }));
}

function expectUnavailable(
  operation: () => unknown,
  dependency: AuthorityParticipantFeature,
  reason: AuthorityParticipantUnavailableError["safeError"]["reason"],
): void {
  try {
    operation();
    throw new Error("expected participant rejection");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AuthorityParticipantUnavailableError);
    expect((error as AuthorityParticipantUnavailableError).safeError).toEqual({
      httpStatus: 503,
      code: "dependency_unavailable",
      dependency,
      reason,
      retryable: true,
    });
  }
}

describe("FT-09A departure responsibility production aggregate", () => {
  it("treats an explicitly absent legacy Project schema as empty but fails closed for v24 corruption", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(`
        CREATE TABLE project_requests (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          status TEXT NOT NULL
        ) STRICT;
      `);
      expect(invokeDeparture(legacy)).toEqual({
        roomId: "room-1",
        targetHumanActorId: "human-1",
        conflicts: [],
      });

      legacy.exec("PRAGMA user_version = 24");
      expectUnavailable(() => invokeDeparture(legacy),
        "departure-responsibility", "malformed_result");
    } finally {
      legacy.close();
    }
  });

  it("registers the exact production feature and reads every real non-empty responsibility class", () => {
    const database = createDatabase();
    try {
      insertCompleteResponsibilityFixture(database);
      const registration = createDepartureResponsibilityRegistration({
        pendingConfirmation: { enabled: false },
      });
      expect(registration.registrationId).toBe(
        "dao.project-loop.departure-responsibility.v1",
      );
      expect(registration.feature).toBe("departure-responsibility");
      expect(registration.version).toBe(1);
      expect(registration.enabled).toBe(true);
      expect(Object.keys(registration.participant ?? {})).toEqual(["listInTransaction"]);

      const result = invokeDeparture(database);
      expect(result.roomId).toBe("room-1");
      expect(result.targetHumanActorId).toBe("human-1");
      expect(result.conflicts).toHaveLength(10);
      expect(result.conflicts.map((conflict) => conflict.title).sort()).toEqual([
        "project.blocker.owner",
        "project.confirmation.pending",
        "project.next_action.owner",
        "project.next_action.pending_verification",
        "project.next_action.pending_verification",
        "project.open_question.owner",
        "project.request.pending_acceptance.requester",
        "project.request.pending_acceptance.target",
        "project.transfer.pending_acceptance",
        "project.transfer.pending_acceptance",
      ]);
      expect(result.conflicts.map((conflict) => conflict.kind).sort()).toEqual([
        "acceptance",
        "acceptance",
        "acceptance",
        "blocker_or_open_question",
        "blocker_or_open_question",
        "confirmation",
        "next_action",
        "next_action",
        "next_action",
        "request",
      ]);
      expect(result.conflicts.every((conflict) =>
        Object.keys(conflict).sort().join(",") === [
          "allowedResolutions", "conflictId", "kind", "revision", "roomId", "sourceId",
          "state", "subjectId", "title",
        ].sort().join(",")
      )).toBe(true);
      expect(result.conflicts.map((conflict) => conflict.sourceId).sort()).toEqual([
        "execution-action",
        "message-action-owned",
        "message-agent-active",
        "message-blocker",
        "message-confirmation",
        "message-question",
        "message-request-requester",
        "message-request-target",
        "message-transfer",
        "message-transfer-agent",
      ]);
      expect(JSON.stringify(result)).not.toContain("body");
      expect(JSON.stringify(result)).not.toContain("parameter");
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      database.close();
    }
  });

  it("uses the same writer, rolls back cleanly, and keeps committed conflict IDs stable after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-departure-responsibility-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "authority.sqlite");
    const database = createDatabase(path);
    const observer = new DatabaseSync(path);
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare(
        `INSERT INTO project_requests (
           id, room_id, source_room_id, source_id, revision,
           requester_human_actor_id, target_human_actor_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "request-transaction", "room-1", "room-1", "message-transaction", 1,
        "human-requester", "human-1", "pending_acceptance",
      );
      const transaction = mintDatabaseAuthorityTransactionView(
        database,
        "room-1",
        "transaction-rollback",
      );
      const envelope = createDepartureResponsibilityRegistration({
        pendingConfirmation: { enabled: false },
      }).participant?.listInTransaction(transaction, {
        roomId: "room-1",
        targetHumanActorId: "human-1",
      });
      expect(envelope?.ok).toBe(true);
      expect(envelope?.ok && envelope.result.conflicts).toHaveLength(1);
      expect(observer.prepare("SELECT COUNT(*) AS count FROM project_requests").get())
        .toEqual({ count: 0 });
      releaseDatabaseAuthorityTransactionView(transaction);
      database.exec("ROLLBACK");
      database.close();

      const restartedAfterRollback = new DatabaseSync(path);
      expect(invokeDeparture(restartedAfterRollback).conflicts).toEqual([]);
      restartedAfterRollback.prepare(
        `INSERT INTO project_requests (
           id, room_id, source_room_id, source_id, revision,
           requester_human_actor_id, target_human_actor_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "request-transaction", "room-1", "room-1", "message-transaction", 1,
        "human-requester", "human-1", "pending_acceptance",
      );
      const beforeRestart = invokeDeparture(restartedAfterRollback);
      restartedAfterRollback.close();

      const restartedAfterCommit = new DatabaseSync(path);
      const afterRestart = invokeDeparture(restartedAfterCommit);
      expect(afterRestart).toEqual(beforeRestart);
      expect(invokeDeparture(restartedAfterCommit)).toEqual(afterRestart);
      const oldConflictId = afterRestart.conflicts[0]?.conflictId;
      restartedAfterCommit.prepare(
        "UPDATE project_requests SET revision = 2 WHERE id = 'request-transaction'",
      ).run();
      expect(invokeDeparture(restartedAfterCommit).conflicts[0]?.conflictId)
        .not.toBe(oldConflictId);
      restartedAfterCommit.close();
    } finally {
      observer.close();
      if (database.isOpen) database.close();
    }
  });

  it("fails closed for invalid, released, and cross-room transaction capabilities without writes", () => {
    const database = createDatabase();
    try {
      insertCompleteResponsibilityFixture(database);
      const before = database.prepare("SELECT * FROM project_requests ORDER BY id").all();
      const participant = createDepartureResponsibilityRegistration({
        pendingConfirmation: { enabled: false },
      }).participant!;
      const ordinaryView = mintAuthorityTransactionView("room-1", "unbound");
      const unavailable = participant.listInTransaction(ordinaryView, {
        roomId: "room-1",
        targetHumanActorId: "human-1",
      });
      expect(unavailable).toEqual({
        ok: false,
        error: {
          httpStatus: 503,
          code: "dependency_unavailable",
          dependency: "departure-responsibility",
          reason: "transaction_mismatch",
          retryable: true,
        },
      });

      database.exec("BEGIN IMMEDIATE");
      const released = mintDatabaseAuthorityTransactionView(database, "room-1", "released");
      releaseDatabaseAuthorityTransactionView(released);
      expect(participant.listInTransaction(released, {
        roomId: "room-1",
        targetHumanActorId: "human-1",
      })).toMatchObject({ ok: false, error: { reason: "transaction_mismatch" } });
      const valid = mintDatabaseAuthorityTransactionView(database, "room-1", "cross-room");
      expect(participant.listInTransaction(valid, {
        roomId: "room-2",
        targetHumanActorId: "human-1",
      })).toMatchObject({ ok: false, error: { reason: "transaction_mismatch" } });
      releaseDatabaseAuthorityTransactionView(valid);
      database.exec("ROLLBACK");
      expect(database.prepare("SELECT * FROM project_requests ORDER BY id").all()).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("fails closed instead of leaking a corrupt cross-room project source reference", () => {
    const database = createDatabase();
    try {
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.prepare(
        `INSERT INTO project_requests (
           id, room_id, source_room_id, source_id, revision,
           requester_human_actor_id, target_human_actor_id, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "request-cross-room", "room-1", "room-2", "message-room-2", 1,
        "human-requester", "human-1", "pending_acceptance",
      );
      database.exec("PRAGMA ignore_check_constraints = OFF");
      expectUnavailable(() => invokeDeparture(database),
        "departure-responsibility", "cross_room_result");
      expect(database.prepare("SELECT COUNT(*) AS count FROM project_requests").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM departure_write_probes").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("aggregates an enabled FT-10 contributor and rejects missing/version/duplicate composition", () => {
    const database = createDatabase();
    try {
      const valid = pendingRegistration(() => pendingResult());
      const result = invokeDeparture(database, {
        pendingConfirmation: { enabled: true, registrations: [valid] },
      });
      expect(result.conflicts).toEqual([
        expect.objectContaining({
          subjectId: "confirmation-1",
          kind: "confirmation",
          title: "tool.confirmation.pending",
        }),
      ]);

      expectUnavailable(() => createDepartureResponsibilityRegistration({
        pendingConfirmation: { enabled: true, registrations: [] },
      }), "pending-confirmation-departure", "missing_registration");
      expectUnavailable(() => createDepartureResponsibilityRegistration({
        pendingConfirmation: {
          enabled: true,
          registrations: [{ ...valid, version: 2 }],
        },
      } as unknown as DepartureResponsibilityComposition),
      "pending-confirmation-departure", "version_mismatch");
      expectUnavailable(() => createDepartureResponsibilityRegistration({
        pendingConfirmation: { enabled: true, registrations: [valid, valid] },
      }), "pending-confirmation-departure", "duplicate_registration_id");
      expectUnavailable(() => createDepartureResponsibilityRegistration({
        pendingConfirmation: {
          enabled: true,
          registrations: [valid, {
            ...valid,
            registrationId: "duplicate-feature-registration",
          }],
        },
      }), "pending-confirmation-departure", "duplicate_feature_registration");
    } finally {
      database.close();
    }
  });

  it("rolls back all writes when an enabled contributor throws, is malformed, leaks keys, or crosses rooms", () => {
    const cases: readonly [
      string,
      ParticipantRegistration<PendingConfirmationDepartureContributor>,
      AuthorityParticipantUnavailableError["safeError"]["reason"],
    ][] = [
      ["throws", pendingRegistration((transaction) => {
        useAuthorityTransactionDatabase(transaction, (database) => {
          database.prepare("INSERT INTO departure_write_probes VALUES ('threw')").run();
        });
        throw new Error("raw SQL and secret must not escape");
      }), "participant_threw"],
      ["malformed envelope", pendingRegistration(() => ({ ok: true, result: [] }) as never),
        "malformed_result"],
      ["extra sensitive key", pendingRegistration(() => pendingResult("room-1", {
        rawToolParameters: "do-not-leak",
      })), "malformed_result"],
      ["cross room", pendingRegistration(() => pendingResult("room-2")),
        "cross_room_result"],
    ];

    for (const [label, externalRegistration, reason] of cases) {
      const database = createDatabase();
      try {
        const aggregateRegistration = createDepartureResponsibilityRegistration({
          pendingConfirmation: {
            enabled: true,
            registrations: [externalRegistration],
          },
        });
        expectUnavailable(() => withTransaction(database, "room-1", (transaction) =>
          invokeAuthorityParticipant({
            feature: "departure-responsibility",
            manifest: manifest(["departure-responsibility", "pending-confirmation-departure"]),
            registrations: [aggregateRegistration, externalRegistration],
            tx: transaction,
            roomId: "room-1",
            invoke: (participant) => participant.listInTransaction(transaction, {
              roomId: "room-1",
              targetHumanActorId: "human-1",
            }),
          })), "departure-responsibility", reason);
        expect(database.prepare("SELECT COUNT(*) AS count FROM departure_write_probes").get(), label)
          .toEqual({ count: 0 });
      } finally {
        database.close();
      }
    }
  });

  it("preserves shared registry rejection for missing, duplicate, and malformed aggregate registration", () => {
    const database = createDatabase();
    try {
      const valid = createDepartureResponsibilityRegistration({
        pendingConfirmation: { enabled: false },
      });
      withTransaction(database, "room-1", (transaction) => {
        expectUnavailable(() => invokeAuthorityParticipant({
          feature: "departure-responsibility",
          manifest: manifest(["departure-responsibility"]),
          registrations: [],
          tx: transaction,
          roomId: "room-1",
          invoke: () => ({ ok: true }),
        }), "departure-responsibility", "missing_registration");
        expectUnavailable(() => invokeAuthorityParticipant({
          feature: "departure-responsibility",
          manifest: manifest(["departure-responsibility"]),
          registrations: [valid, valid],
          tx: transaction,
          roomId: "room-1",
          invoke: () => ({ ok: true }),
        }), "departure-responsibility", "duplicate_registration_id");
        expectUnavailable(() => invokeAuthorityParticipant({
          feature: "departure-responsibility",
          manifest: manifest(["departure-responsibility"]),
          registrations: [{ ...valid, unexpected: "sensitive" }],
          tx: transaction,
          roomId: "room-1",
          invoke: () => ({ ok: true }),
        }), "departure-responsibility", "malformed_registration");
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM departure_write_probes").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
