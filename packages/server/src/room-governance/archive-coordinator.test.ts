import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionSharedAuthorityParticipantComposition } from "../authoritative-server.js";
import { runAuthorityParticipantImmediateTransaction } from "../persistence/authority-database-handler.js";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  AUTHORITY_PARTICIPANT_VERSION,
  type AuthorityTransactionView,
  type FeatureEnablementManifest,
  type ParticipantRegistration,
} from "./private-participant-contracts.js";
import { AuthorityParticipantUnavailableError } from "./private-participant-registry.js";
import {
  ArchiveCoordinatorCommandError,
  coordinateArchiveInTransaction,
  coordinateReopenInTransaction,
  type ArchiveCoordinatorComposition,
} from "./archive-coordinator.js";

const roomId = "room-1";
const ownerId = "human-owner";
const t0 = Date.parse("2026-08-19T00:00:00.000Z");
const at = (offset: number): string => new Date(t0 + offset).toISOString();
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const participantSteps = [
  "archived-message-gate",
  "business-timer-suspension",
  "archive-settlement",
  "runtime-archive-fence",
  "assignment-security-reduction",
  "lifecycle-repair",
  "room-cache-invalidation",
  "offline-lease-invalidation",
] as const;

function openDatabase(options: Readonly<{ withTimer?: boolean }> = {}): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "dao-archive-coordinator-"));
  directories.push(directory);
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  migrateAuthorityDatabase(database);
  database.exec(`
    CREATE TABLE coordinator_probe (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      step TEXT NOT NULL
    ) STRICT;
    INSERT INTO actors (id, kind, display_name, readiness, tool_permissions_json)
    VALUES
      ('human-owner', 'human', 'Owner', NULL, '[]'),
      ('human-member', 'human', 'Member', NULL, '[]'),
      ('agent-1', 'agent', 'Agent', 'ready', '[]');
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-1', 'Room One', 'active', '${at(0)}');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at
    ) VALUES
      ('room-1', 'human-owner', 'human', 'member', NULL, '[]', '${at(0)}', NULL),
      ('room-1', 'human-member', 'human', 'member', NULL, '[]', '${at(0)}', NULL),
      ('room-1', 'agent-1', 'agent', NULL, 'active', '[]', NULL, '${at(0)}');
    UPDATE rooms
    SET owner_actor_id = 'human-owner', governance_revision = 1
    WHERE id = 'room-1';
    UPDATE room_memberships
    SET role = 'owner'
    WHERE room_id = 'room-1' AND actor_id = 'human-owner';
  `);
  if (options.withTimer) {
    database.exec(`
      INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
      VALUES ('message-open', 'room-1', 'human-owner', 'human', 'Open', '${at(0)}');
      INSERT INTO open_items (
        id, room_id, source_message_id, current_owner_actor_id, status, body,
        created_at, responded_at, requester_actor_id, transfer_chain_json, origin_kind
      ) VALUES (
        'item-live', 'room-1', 'message-open', 'agent-1', 'awaiting', 'Answer',
        '${at(0)}', NULL, 'human-owner', '[]', 'human_mention'
      );
    `);
  }
  return database;
}

function runArchive(
  database: DatabaseSync,
  composition: ArchiveCoordinatorComposition,
  expectedGovernanceRevision = 1,
) {
  return runAuthorityParticipantImmediateTransaction(
    database,
    roomId,
    `archive-${expectedGovernanceRevision}-${Math.random()}`,
    (transaction) => coordinateArchiveInTransaction(transaction, {
      roomId,
      actorId: ownerId,
      expectedGovernanceRevision,
      occurredAt: at(30_000),
    }, composition),
  );
}

function runReopen(
  database: DatabaseSync,
  composition: ArchiveCoordinatorComposition,
  expectedGovernanceRevision: number,
  occurredAt = at(300_000),
) {
  return runAuthorityParticipantImmediateTransaction(
    database,
    roomId,
    `reopen-${expectedGovernanceRevision}-${Math.random()}`,
    (transaction) => coordinateReopenInTransaction(transaction, {
      roomId,
      actorId: ownerId,
      expectedGovernanceRevision,
      occurredAt,
    }, composition),
  );
}

function record(transaction: AuthorityTransactionView, step: string): void {
  useAuthorityTransactionDatabase(transaction, (database) => {
    database.prepare("INSERT INTO coordinator_probe (step) VALUES (?)").run(step);
  });
}

function fakeComposition(failAt?: typeof participantSteps[number]): ArchiveCoordinatorComposition {
  const manifest: FeatureEnablementManifest = {
    "departure-responsibility": false,
    "pending-confirmation-departure": false,
    "archived-message-gate": true,
    "business-timer-suspension": true,
    "archive-settlement": true,
    "runtime-archive-fence": true,
    "assignment-security-reduction": true,
    "lifecycle-repair": true,
    "room-cache-invalidation": true,
    "offline-lease-invalidation": true,
  };
  const invoke = <T>(
    transaction: AuthorityTransactionView,
    step: typeof participantSteps[number],
    result: T,
  ) => {
    record(transaction, step);
    if (failAt === step) throw new Error(`fail:${step}`);
    return { ok: true as const, result };
  };
  const registrations: ParticipantRegistration[] = [
    {
      registrationId: "test.archive.gate",
      feature: "archived-message-gate",
      version: AUTHORITY_PARTICIPANT_VERSION,
      enabled: true,
      participant: {
        blockForArchive: (transaction, input) => invoke(
          transaction,
          "archived-message-gate",
          {
            roomId: input.roomId,
            archiveGeneration: input.archiveGeneration,
            gateGeneration: input.archiveGeneration,
            blockedMutationKinds: ["message", "message_intent"] as const,
          },
        ),
      },
    },
    {
      registrationId: "test.archive.timers",
      feature: "business-timer-suspension",
      version: AUTHORITY_PARTICIPANT_VERSION,
      enabled: true,
      participant: {
        suspendForArchive: (transaction, input) => invoke(
          transaction,
          "business-timer-suspension",
          {
            roomId: input.roomId,
            archiveGeneration: input.archiveGeneration,
            action: "suspended" as const,
            affectedCount: 0,
            timerDescriptorIds: [] as const,
          },
        ),
        resumeAfterReopen: (transaction, input) => invoke(
          transaction,
          "business-timer-suspension",
          {
            roomId: input.roomId,
            archiveGeneration: input.archiveGeneration,
            action: "resumed" as const,
            affectedCount: 0,
            timerDescriptorIds: [] as const,
          },
        ),
      },
    },
    {
      registrationId: "test.archive.settlement",
      feature: "archive-settlement",
      version: AUTHORITY_PARTICIPANT_VERSION,
      enabled: true,
      participant: {
        settleUndispatched: (transaction, input) => invoke(
          transaction,
          "archive-settlement",
          {
            roomId: input.roomId,
            archiveGeneration: input.archiveGeneration,
            rejectedPendingCount: 0,
            revokedGrantCount: 0,
            fencedWaitingCount: 0,
            preservedDispatchedCount: 0,
          },
        ),
      },
    },
    {
      registrationId: "test.archive.runtime",
      feature: "runtime-archive-fence",
      version: AUTHORITY_PARTICIPANT_VERSION,
      enabled: true,
      participant: {
        fenceForArchive: (transaction, input) => invoke(
          transaction,
          "runtime-archive-fence",
          {
            roomId: input.roomId,
            archiveGeneration: input.archiveGeneration,
            fencedQueuedCount: 0,
            fencedWaitingCount: 0,
            preservedDispatchedCount: 0,
            preservedOutcomeReviewCount: 0,
          },
        ),
      },
    },
    {
      registrationId: "test.archive.assignment",
      feature: "assignment-security-reduction",
      version: AUTHORITY_PARTICIPANT_VERSION,
      enabled: true,
      participant: {
        reduceForArchive: (transaction, input) => invoke(
          transaction,
          "assignment-security-reduction",
          {
            roomId: input.roomId,
            archiveGeneration: input.archiveGeneration,
            policyVersion: 1,
            assignmentRevision: 1,
            businessWakeUpCount: 0 as const,
          },
        ),
      },
    },
    {
      registrationId: "test.archive.repair",
      feature: "lifecycle-repair",
      version: AUTHORITY_PARTICIPANT_VERSION,
      enabled: true,
      participant: {
        describeLifecycleInTransaction: (transaction, input) => invoke(
          transaction,
          "lifecycle-repair",
          {
            roomId: input.roomId,
            lifecycleGeneration: input.lifecycleGeneration,
            descriptorId: "test.repair.v1",
            descriptorVersion: 1,
            sortKey: input.roomId,
            recordCount: 1,
          },
        ),
      },
    },
    {
      registrationId: "test.archive.cache",
      feature: "room-cache-invalidation",
      version: AUTHORITY_PARTICIPANT_VERSION,
      enabled: true,
      participant: {
        invalidateRoomCacheInTransaction: (transaction, input) => invoke(
          transaction,
          "room-cache-invalidation",
          {
            roomId: input.roomId,
            lifecycleGeneration: input.lifecycleGeneration,
            invalidationIntentId: `cache:${input.roomId}:${input.lifecycleGeneration}`,
            accessRevision: input.lifecycleGeneration,
          },
        ),
      },
    },
    {
      registrationId: "test.archive.lease",
      feature: "offline-lease-invalidation",
      version: AUTHORITY_PARTICIPANT_VERSION,
      enabled: true,
      participant: {
        invalidateOfflineLeasesInTransaction: (transaction, input) => invoke(
          transaction,
          "offline-lease-invalidation",
          {
            roomId: input.roomId,
            lifecycleGeneration: input.lifecycleGeneration,
            leaseGeneration: input.lifecycleGeneration,
            revokedLeaseCount: 0,
            maxOfflineReadLeaseMs: 30_000,
          },
        ),
      },
    },
  ];
  const transactionRegistrations = registrations.slice(0, 5);
  return {
    manifest,
    transactionRegistrations,
    lifecycleRepairRegistrations: registrations.slice(5, 6),
    accessInvalidationRegistrations: registrations.slice(6),
  };
}

describe("FT-02C archive/reopen coordinator", () => {
  it("applies the lifecycle CAS before invoking archive participants in the fixed order", () => {
    const database = openDatabase();
    try {
      const result = runArchive(database, fakeComposition());
      expect(result.outcome).toBe("applied");
      expect(result.governance).toEqual({
        roomId,
        projectId: roomId,
        lifecycle: "archived",
        governanceRevision: 2,
        ownerActorId: ownerId,
        archivedAt: at(30_000),
        archiveGeneration: 1,
      });
      expect(database.prepare(
        "SELECT step FROM coordinator_probe ORDER BY sequence",
      ).all().map((row) => row.step)).toEqual(participantSteps);
    } finally {
      database.close();
    }
  });

  it.each(participantSteps)("rolls back every write when %s fails", (failAt) => {
    const database = openDatabase();
    try {
      expect(() => runArchive(database, fakeComposition(failAt))).toThrow(
        AuthorityParticipantUnavailableError,
      );
      expect(database.prepare(
        `SELECT status, governance_revision AS governanceRevision,
                archive_generation AS archiveGeneration, archived_at AS archivedAt
         FROM rooms WHERE id = ?`,
      ).get(roomId)).toEqual({
        status: "active",
        governanceRevision: 1,
        archiveGeneration: 0,
        archivedAt: null,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM coordinator_probe").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("enforces role and revision CAS while making fresh terminal-state repeats inert", () => {
    const database = openDatabase();
    const composition = fakeComposition();
    try {
      expect(() => runArchive(database, composition, 0)).toThrowError(
        expect.objectContaining({ code: "room_revision_conflict" }),
      );
      expect(() => runAuthorityParticipantImmediateTransaction(
        database,
        roomId,
        "archive-member",
        (transaction) => coordinateArchiveInTransaction(transaction, {
          roomId,
          actorId: "human-member",
          expectedGovernanceRevision: 1,
          occurredAt: at(30_000),
        }, composition),
      )).toThrowError(expect.objectContaining({ code: "role_forbidden" }));

      expect(runArchive(database, composition, 1).outcome).toBe("applied");
      expect(runArchive(database, composition, 0)).toEqual({
        outcome: "already_archived",
        governance: {
          roomId,
          projectId: roomId,
          lifecycle: "archived",
          governanceRevision: 2,
          ownerActorId: ownerId,
          archivedAt: at(30_000),
          archiveGeneration: 1,
        },
      });
      expect(runReopen(database, composition, 2).outcome).toBe("applied");
      expect(runReopen(database, composition, 0)).toEqual({
        outcome: "already_active",
        governance: {
          roomId,
          projectId: roomId,
          lifecycle: "active",
          governanceRevision: 3,
          ownerActorId: ownerId,
          archiveGeneration: 1,
        },
      });
      const rearchived = runArchive(database, composition, 3);
      expect(rearchived.outcome).toBe("applied");
      expect(rearchived.governance.archiveGeneration).toBe(2);
      expect(rearchived.governance.governanceRevision).toBe(4);
      expect(database.prepare("SELECT COUNT(*) AS count FROM coordinator_probe").get()).toEqual({
        count: 18,
      });
    } finally {
      database.close();
    }
  });

  it("composes the production providers and resumes only preserved business-time remainder", () => {
    const database = openDatabase({ withTimer: true });
    const production = createProductionSharedAuthorityParticipantComposition({
      maxOfflineReadLeaseMs: 30_000,
      ballPolicy: { openItemDeadlineMs: 60_000, lightTaskDeadlineMs: 60_000 },
    });
    const composition: ArchiveCoordinatorComposition = {
      manifest: production.manifest,
      transactionRegistrations: production.registrations,
      lifecycleRepairRegistrations: production.registrations,
      accessInvalidationRegistrations: production.registrations,
    };
    try {
      const archived = runArchive(database, composition);
      expect(archived.outcome).toBe("applied");
      if (archived.outcome !== "applied") throw new Error("archive did not apply");
      expect(archived.participants.businessTimers.affectedCount).toBe(1);
      expect(database.prepare(
        `SELECT remaining_ms AS remainingMs, state
         FROM room_business_timer_freezes`,
      ).get()).toEqual({ remainingMs: 30_000, state: "frozen" });

      const reopened = runReopen(database, composition, 2);
      expect(reopened.outcome).toBe("applied");
      if (reopened.outcome !== "applied") throw new Error("reopen did not apply");
      expect(reopened.participants.businessTimers).toEqual(expect.objectContaining({
        action: "resumed",
        affectedCount: 1,
      }));
      expect(reopened.afterCommitRescan).toEqual({
        roomId,
        lifecycleGeneration: 1,
        governanceRevision: 3,
        reason: "room_reopened",
      });
      expect(database.prepare(
        `SELECT resumed_due_at AS resumedDueAt, state
         FROM room_business_timer_freezes`,
      ).get()).toEqual({ resumedDueAt: at(330_000), state: "resumed" });
    } finally {
      database.close();
    }
  });

  it("rejects a cross-room transaction before reading or mutating authority state", () => {
    const database = openDatabase();
    try {
      expect(() => runAuthorityParticipantImmediateTransaction(
        database,
        "other-room",
        "archive-cross-room",
        (transaction) => coordinateArchiveInTransaction(transaction, {
          roomId,
          actorId: ownerId,
          expectedGovernanceRevision: 1,
          occurredAt: at(30_000),
        }, fakeComposition()),
      )).toThrowError(ArchiveCoordinatorCommandError);
    } finally {
      database.close();
    }
  });
});
