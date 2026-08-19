import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DepartureConflict } from "@native-im/core";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
  useAuthorityTransactionDatabase,
} from "../persistence/authority-transaction-database.js";
import { createDepartureResponsibilityRegistration } from "../project-loop/departure-responsibility-port.js";
import { pendingConfirmationDepartureContributorRegistration } from "../tool-safety/pending-confirmation-departure-contributor.js";
import {
  AUTHORITY_PARTICIPANT_FEATURES,
  type AuthorityParticipantEnvelope,
  type AuthorityParticipantFeature,
  type AuthorityTransactionView,
  type DepartureContributionResult,
  type DepartureResponsibilityContributor,
  type FeatureEnablementManifest,
  type ParticipantRegistration,
} from "./private-participant-contracts.js";
import { AuthorityParticipantUnavailableError } from "./private-participant-registry.js";
import {
  DepartureGovernanceCommandError,
  createDepartureGovernanceCoordinator,
  type DepartureGovernanceComposition,
  type DepartureMutationAuthorization,
} from "./departure-governance.js";

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function manifest(
  enabled: readonly AuthorityParticipantFeature[] = ["departure-responsibility"],
): FeatureEnablementManifest {
  return Object.freeze(Object.fromEntries(
    AUTHORITY_PARTICIPANT_FEATURES.map((feature) => [feature, enabled.includes(feature)]),
  )) as FeatureEnablementManifest;
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE actors (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent'))
    ) STRICT;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      governance_revision INTEGER NOT NULL CHECK (governance_revision >= 0),
      owner_actor_id TEXT NOT NULL REFERENCES actors(id)
    ) STRICT;
    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      role TEXT CHECK (role IN ('owner', 'admin', 'member')),
      PRIMARY KEY (room_id, actor_id)
    ) STRICT;
    CREATE TABLE project_requests (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      requester_human_actor_id TEXT NOT NULL,
      target_human_actor_id TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_next_actions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      verifier_human_actor_id TEXT,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_obstacles (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_actor_id TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_transfer_proposals (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_room_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      to_owner_kind TEXT NOT NULL,
      to_owner_actor_id TEXT NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE session_families (
      family_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      refresh_expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    ) STRICT;
    CREATE TABLE agent_executions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_attempt_seq INTEGER NOT NULL,
      action_category TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_execution_attempts (
      execution_id TEXT NOT NULL,
      attempt_seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      action_category TEXT NOT NULL,
      PRIMARY KEY (execution_id, attempt_seq)
    ) STRICT;
    CREATE TABLE agent_execution_grants (
      grant_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      attempt_seq INTEGER NOT NULL,
      room_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      parameter_sha256 TEXT NOT NULL,
      consumed_at TEXT,
      grant_state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE tool_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      attempt_seq INTEGER NOT NULL,
      tool_id TEXT NOT NULL,
      parameter_sha256 TEXT NOT NULL,
      room_id TEXT NOT NULL,
      human_principal_id TEXT NOT NULL,
      session_family_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      confirmation_state TEXT NOT NULL,
      confirmation_revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE departure_commit_probe (
      id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_actor_id TEXT NOT NULL,
      governance_revision INTEGER NOT NULL
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO actors VALUES
      ('human-owner', 'human'),
      ('human-admin', 'human'),
      ('human-peer-admin', 'human'),
      ('human-member', 'human'),
      ('human-other', 'human'),
      ('agent-1', 'agent');
    INSERT INTO rooms VALUES ('room-1', 'active', 7, 'human-owner');
    INSERT INTO room_memberships VALUES
      ('room-1', 'human-owner', 'human', 'owner'),
      ('room-1', 'human-admin', 'human', 'admin'),
      ('room-1', 'human-peer-admin', 'human', 'admin'),
      ('room-1', 'human-member', 'human', 'member'),
      ('room-1', 'agent-1', 'agent', NULL);
  `);
  return database;
}

function productionComposition(): DepartureGovernanceComposition {
  return Object.freeze({
    manifest: manifest(),
    registrations: Object.freeze([
      createDepartureResponsibilityRegistration({
        pendingConfirmation: {
          enabled: true,
          registrations: [pendingConfirmationDepartureContributorRegistration],
        },
      }),
    ]),
  });
}

function withTransaction<TResult>(
  database: DatabaseSync,
  operation: (transaction: AuthorityTransactionView) => TResult,
): TResult {
  database.exec("BEGIN IMMEDIATE");
  const transaction = mintDatabaseAuthorityTransactionView(
    database,
    "room-1",
    `departure-transaction-${Math.random()}`,
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

function expectCommandError(
  operation: () => unknown,
  status: DepartureGovernanceCommandError["status"],
  code: DepartureGovernanceCommandError["code"],
): DepartureGovernanceCommandError {
  try {
    operation();
    throw new Error("expected departure governance rejection");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DepartureGovernanceCommandError);
    expect(error).toMatchObject({ status, code });
    return error as DepartureGovernanceCommandError;
  }
}

function conflict(overrides: Partial<DepartureConflict> = {}): DepartureConflict {
  return {
    conflictId: "conflict-1",
    roomId: "room-1",
    subjectId: "request-1",
    kind: "acceptance",
    title: "project.request.pending_acceptance.target",
    state: "pending_acceptance",
    allowedResolutions: ["transfer", "reject_or_revoke"],
    sourceId: "message-1",
    revision: 1,
    ...overrides,
  };
}

function customComposition(
  implementation: DepartureResponsibilityContributor["listInTransaction"],
): DepartureGovernanceComposition {
  const registration: ParticipantRegistration<DepartureResponsibilityContributor> = {
    registrationId: "test.departure-responsibility.v1",
    feature: "departure-responsibility",
    version: 1,
    enabled: true,
    participant: { listInTransaction: implementation },
  };
  return { manifest: manifest(), registrations: [registration] };
}

describe("FT-02B departure governance", () => {
  it("returns an authorized, read-only, closed preflight from the real aggregate provider", () => {
    const database = createDatabase();
    database.prepare(
      `INSERT INTO project_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "request-1", "room-1", "room-1", "message-1", 3,
      "human-owner", "human-member", "pending_acceptance",
    );
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    const before = database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM room_memberships) AS memberships,
         (SELECT COUNT(*) FROM departure_commit_probe) AS probes,
         (SELECT governance_revision FROM rooms WHERE id = 'room-1') AS governanceRevision`,
    ).get();

    const result = withTransaction(database, (transaction) =>
      coordinator.preflightInTransaction(transaction, {
        roomId: "room-1",
        authenticatedHumanActorId: "human-owner",
        targetHumanActorId: "human-member",
      }));

    expect(result).toMatchObject({
      roomId: "room-1",
      targetActorId: "human-member",
      governanceRevision: 7,
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      roomId: "room-1",
      subjectId: "request-1",
      kind: "acceptance",
      revision: 3,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.conflicts)).toBe(true);
    expect(database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM room_memberships) AS memberships,
         (SELECT COUNT(*) FROM departure_commit_probe) AS probes,
         (SELECT governance_revision FROM rooms WHERE id = 'room-1') AS governanceRevision`,
    ).get()).toEqual(before);
  });

  it("consumes the real FT-10 contributor only through the aggregate departure port", () => {
    const database = createDatabase();
    const parameterHash = "a".repeat(64);
    database.prepare(
      `INSERT INTO session_families VALUES (?, ?, ?, NULL)`,
    ).run("family-member", "human-member", Date.now() + 60_000);
    database.prepare(
      `INSERT INTO agent_executions VALUES (?, ?, ?, ?, ?)`,
    ).run("execution-1", "room-1", "running", 1, "waiting_upstream");
    database.prepare(
      `INSERT INTO agent_execution_attempts VALUES (?, ?, ?, ?)`,
    ).run("execution-1", 1, "running", "waiting_upstream");
    database.prepare(
      `INSERT INTO agent_execution_grants VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      "grant-1", "execution-1", 1, "room-1", "sandbox-file.write",
      parameterHash, "active",
    );
    database.prepare(
      `INSERT INTO tool_confirmations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      "confirmation-1", "execution-1", 1, "sandbox-file.write", parameterHash,
      "room-1", "human-member", "family-member",
      new Date(Date.now() + 60_000).toISOString(), "pending", 2,
    );
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());

    const result = withTransaction(database, (transaction) =>
      coordinator.preflightInTransaction(transaction, {
        roomId: "room-1",
        authenticatedHumanActorId: "human-member",
        targetHumanActorId: "human-member",
      }));

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      roomId: "room-1",
      subjectId: "confirmation-1",
      kind: "confirmation",
      state: "pending",
      allowedResolutions: ["transfer", "escalate", "reject_or_revoke"],
      revision: 2,
    });
  });

  it("authorizes preflight only for self or a caller allowed to remove the target", () => {
    const database = createDatabase();
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    withTransaction(database, (transaction) => {
      expect(coordinator.preflightInTransaction(transaction, {
        roomId: "room-1",
        authenticatedHumanActorId: "human-member",
        targetHumanActorId: "human-member",
      }).conflicts).toEqual([]);
      expect(coordinator.preflightInTransaction(transaction, {
        roomId: "room-1",
        authenticatedHumanActorId: "human-admin",
        targetHumanActorId: "human-member",
      }).conflicts).toEqual([]);
      expectCommandError(() => coordinator.preflightInTransaction(transaction, {
        roomId: "room-1",
        authenticatedHumanActorId: "human-member",
        targetHumanActorId: "human-admin",
      }), 403, "role_forbidden");
      expectCommandError(() => coordinator.preflightInTransaction(transaction, {
        roomId: "room-1",
        authenticatedHumanActorId: "human-admin",
        targetHumanActorId: "human-peer-admin",
      }), 403, "role_forbidden");
      expectCommandError(() => coordinator.preflightInTransaction(transaction, {
        roomId: "room-1",
        authenticatedHumanActorId: "agent-1",
        targetHumanActorId: "human-member",
      }), 403, "role_forbidden");
    });
  });

  it("rechecks immediately before the commit callback and returns the latest 409 conflicts", () => {
    const database = createDatabase();
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    const commit = vi.fn();

    const error = expectCommandError(() => withTransaction(database, (transaction) => {
      const attempt = coordinator.beginMutationInTransaction(transaction, {
        operation: "leave",
        roomId: "room-1",
        authenticatedHumanActorId: "human-member",
        targetHumanActorId: "human-member",
        expectedGovernanceRevision: 7,
      });
      useAuthorityTransactionDatabase(transaction, (txDatabase) => {
        txDatabase.prepare(
          `INSERT INTO project_next_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "action-new", "room-1", "room-1", "message-new", 1,
          "human", "human-member", null, "in_progress",
        );
      });
      coordinator.finalizeMutationInTransaction(transaction, attempt, commit);
    }), 409, "departure_blocked");

    expect(error.details).toMatchObject({
      roomId: "room-1",
      targetActorId: "human-member",
      governanceRevision: 7,
    });
    expect(error.details?.conflicts).toHaveLength(1);
    expect(error.details?.conflicts[0]).toMatchObject({
      subjectId: "action-new",
      state: "in_progress",
      revision: 1,
    });
    expect(commit).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM project_next_actions").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM departure_commit_probe").get()).toEqual({ count: 0 });
  });

  it("passes a one-shot, server-derived authorization to a synchronous commit callback", () => {
    const database = createDatabase();
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());

    const result = withTransaction(database, (transaction) =>
      coordinator.coordinateMutationInTransaction(transaction, {
        operation: "remove",
        roomId: "room-1",
        authenticatedHumanActorId: "human-owner",
        targetHumanActorId: "human-member",
        expectedGovernanceRevision: 7,
      }, (authorization) => {
        expect(authorization).toEqual({
          operation: "remove",
          roomId: "room-1",
          actorId: "human-owner",
          actorRole: "owner",
          targetHumanActorId: "human-member",
          targetRole: "member",
          lifecycle: "active",
          previousGovernanceRevision: 7,
          nextGovernanceRevision: 8,
        } satisfies DepartureMutationAuthorization);
        useAuthorityTransactionDatabase(transaction, (txDatabase) => {
          txDatabase.prepare(
            "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
          ).run(authorization.roomId, authorization.targetHumanActorId);
          txDatabase.prepare(
            "UPDATE rooms SET governance_revision = ? WHERE id = ?",
          ).run(authorization.nextGovernanceRevision, authorization.roomId);
          txDatabase.prepare(
            `INSERT INTO departure_commit_probe VALUES (?, ?, ?, ?, ?)`,
          ).run(
            "commit-1", authorization.operation, authorization.actorId,
            authorization.targetHumanActorId, authorization.nextGovernanceRevision,
          );
        });
        return Object.freeze({ eventIds: Object.freeze(["event-1"]), replayed: false });
      }));

    expect(result).toEqual({ eventIds: ["event-1"], replayed: false });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'human-member'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT governance_revision AS governanceRevision FROM rooms WHERE id = 'room-1'",
    ).get()).toEqual({ governanceRevision: 8 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM departure_commit_probe").get()).toEqual({ count: 1 });
  });

  it("enforces self-leave, owner transfer-before-leave, and the Human remove role matrix", () => {
    const database = createDatabase();
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    withTransaction(database, (transaction) => {
      expectCommandError(() => coordinator.beginMutationInTransaction(transaction, {
        operation: "leave", roomId: "room-1",
        authenticatedHumanActorId: "human-owner", targetHumanActorId: "human-owner",
        expectedGovernanceRevision: 7,
      }), 409, "ownership_transfer_required");
      expectCommandError(() => coordinator.beginMutationInTransaction(transaction, {
        operation: "leave", roomId: "room-1",
        authenticatedHumanActorId: "human-admin", targetHumanActorId: "human-member",
        expectedGovernanceRevision: 7,
      }), 403, "role_forbidden");
      expectCommandError(() => coordinator.beginMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-member", targetHumanActorId: "human-admin",
        expectedGovernanceRevision: 7,
      }), 403, "role_forbidden");
      expectCommandError(() => coordinator.beginMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-admin", targetHumanActorId: "human-peer-admin",
        expectedGovernanceRevision: 7,
      }), 403, "role_forbidden");
      expectCommandError(() => coordinator.beginMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-owner", targetHumanActorId: "agent-1",
        expectedGovernanceRevision: 7,
      }), 403, "role_forbidden");
      expect(coordinator.beginMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-owner", targetHumanActorId: "human-admin",
        expectedGovernanceRevision: 7,
      })).toBeDefined();
      expect(coordinator.beginMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-admin", targetHumanActorId: "human-member",
        expectedGovernanceRevision: 7,
      })).toBeDefined();
    });
  });

  it("permits the former owner to leave after an ownership transfer", () => {
    const database = createDatabase();
    database.exec(`
      UPDATE room_memberships SET role = 'member' WHERE actor_id = 'human-owner';
      UPDATE room_memberships SET role = 'owner' WHERE actor_id = 'human-other';
      INSERT INTO room_memberships VALUES ('room-1', 'human-other', 'human', 'owner');
      UPDATE rooms SET owner_actor_id = 'human-other', governance_revision = 8 WHERE id = 'room-1';
    `);
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    withTransaction(database, (transaction) => {
      const attempt = coordinator.beginMutationInTransaction(transaction, {
        operation: "leave", roomId: "room-1",
        authenticatedHumanActorId: "human-owner", targetHumanActorId: "human-owner",
        expectedGovernanceRevision: 8,
      });
      expect(attempt).toBeDefined();
    });
  });

  it("permits Human safety reduction while archived without inventing business work", () => {
    const database = createDatabase();
    database.prepare("UPDATE rooms SET status = 'archived' WHERE id = 'room-1'").run();
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    withTransaction(database, (transaction) => {
      const attempt = coordinator.beginMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-owner", targetHumanActorId: "human-member",
        expectedGovernanceRevision: 7,
      });
      expect(attempt).toBeDefined();
    });
  });

  it("fails stale governance CAS before either responsibility collect or commit", () => {
    const database = createDatabase();
    const list = vi.fn((): AuthorityParticipantEnvelope<DepartureContributionResult> => ({
      ok: true,
      result: { roomId: "room-1", targetHumanActorId: "human-member", conflicts: [] },
    }));
    const coordinator = createDepartureGovernanceCoordinator(customComposition(list));
    withTransaction(database, (transaction) => {
      expectCommandError(() => coordinator.beginMutationInTransaction(transaction, {
        operation: "leave", roomId: "room-1",
        authenticatedHumanActorId: "human-member", targetHumanActorId: "human-member",
        expectedGovernanceRevision: 6,
      }), 409, "room_revision_conflict");
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("rechecks role and CAS at finalize and never reuses or serializes an attempt", () => {
    const database = createDatabase();
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    withTransaction(database, (transaction) => {
      const attempt = coordinator.beginMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-admin", targetHumanActorId: "human-member",
        expectedGovernanceRevision: 7,
      });
      expect(JSON.stringify(attempt)).toBe("{}");
      useAuthorityTransactionDatabase(transaction, (txDatabase) => {
        txDatabase.prepare(
          "UPDATE room_memberships SET role = 'admin' WHERE actor_id = 'human-member'",
        ).run();
        txDatabase.prepare(
          "UPDATE rooms SET governance_revision = 8 WHERE id = 'room-1'",
        ).run();
      });
      expectCommandError(() => coordinator.finalizeMutationInTransaction(
        transaction,
        attempt,
        vi.fn(),
      ), 409, "room_revision_conflict");
    });
  });

  it("consumes each transaction-bound attempt exactly once", () => {
    const database = createDatabase();
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    withTransaction(database, (transaction) => {
      const attempt = coordinator.beginMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-owner", targetHumanActorId: "human-member",
        expectedGovernanceRevision: 7,
      });
      expect(coordinator.finalizeMutationInTransaction(
        transaction,
        attempt,
        () => "committed-in-host",
      )).toBe("committed-in-host");
      expect(() => coordinator.finalizeMutationInTransaction(
        transaction,
        attempt,
        () => "must-not-run",
      )).toThrow(AuthorityParticipantUnavailableError);
    });
  });

  it("rejects async commit callbacks so authority writes cannot escape the transaction", () => {
    const database = createDatabase();
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    expect(() => withTransaction(database, (transaction) =>
      coordinator.coordinateMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-owner", targetHumanActorId: "human-member",
        expectedGovernanceRevision: 7,
      }, async () => ({ eventIds: ["late-event"] })))).toThrow(TypeError);
    expect(database.prepare("SELECT COUNT(*) AS count FROM departure_commit_probe").get()).toEqual({ count: 0 });
  });

  it("lets the single Authority transaction roll back a failing host commit in full", () => {
    const database = createDatabase();
    const coordinator = createDepartureGovernanceCoordinator(productionComposition());
    expect(() => withTransaction(database, (transaction) =>
      coordinator.coordinateMutationInTransaction(transaction, {
        operation: "remove", roomId: "room-1",
        authenticatedHumanActorId: "human-owner", targetHumanActorId: "human-member",
        expectedGovernanceRevision: 7,
      }, (authorization) => {
        useAuthorityTransactionDatabase(transaction, (txDatabase) => {
          txDatabase.prepare(
            "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
          ).run(authorization.roomId, authorization.targetHumanActorId);
          txDatabase.prepare(
            "UPDATE rooms SET governance_revision = ? WHERE id = ?",
          ).run(authorization.nextGovernanceRevision, authorization.roomId);
          txDatabase.prepare(
            `INSERT INTO departure_commit_probe VALUES (?, ?, ?, ?, ?)`,
          ).run(
            "commit-that-rolls-back", authorization.operation, authorization.actorId,
            authorization.targetHumanActorId, authorization.nextGovernanceRevision,
          );
        });
        throw new Error("host audit append failed");
      }))).toThrow("host audit append failed");
    expect(database.prepare(
      "SELECT role FROM room_memberships WHERE actor_id = 'human-member'",
    ).get()).toEqual({ role: "member" });
    expect(database.prepare(
      "SELECT governance_revision AS governanceRevision FROM rooms WHERE id = 'room-1'",
    ).get()).toEqual({ governanceRevision: 7 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM departure_commit_probe").get()).toEqual({ count: 0 });
  });

  it.each([
    ["missing", { manifest: manifest(), registrations: [] }, "missing_registration"],
    ["throw", customComposition(() => { throw new Error("secret sql stack"); }), "participant_threw"],
    ["malformed", customComposition(() => ({
      ok: true,
      result: { roomId: "room-1", targetHumanActorId: "human-member", conflicts: [conflict({ revision: 0 })] },
    })), "malformed_result"],
    ["cross-room", customComposition(() => ({
      ok: true,
      result: { roomId: "room-2", targetHumanActorId: "human-member", conflicts: [conflict({ roomId: "room-2" })] },
    })), "cross_room_result"],
  ] as const)("fails %s aggregate provider closed as a safe 503", (_name, composition, reason) => {
    const database = createDatabase();
    const coordinator = createDepartureGovernanceCoordinator(composition);
    try {
      withTransaction(database, (transaction) => coordinator.preflightInTransaction(transaction, {
        roomId: "room-1",
        authenticatedHumanActorId: "human-member",
        targetHumanActorId: "human-member",
      }));
      throw new Error("expected dependency failure");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AuthorityParticipantUnavailableError);
      expect((error as AuthorityParticipantUnavailableError).safeError).toEqual({
        httpStatus: 503,
        code: "dependency_unavailable",
        dependency: "departure-responsibility",
        reason,
        retryable: true,
      });
      expect(String(error)).not.toContain("secret sql stack");
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM departure_commit_probe").get()).toEqual({ count: 0 });
  });
});
