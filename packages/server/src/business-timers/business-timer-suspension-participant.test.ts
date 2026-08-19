import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  mintAuthorityTransactionView,
  type AuthorityTransactionView,
} from "../room-governance/private-participant-contracts.js";
import {
  BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
  businessTimerDescriptorRegistrations,
  businessTimerFeatureManifest,
  businessTimerSuspensionParticipantRegistration,
  createBallBoundaryBusinessTimerDescriptorRegistration,
  createBusinessTimerSuspensionParticipant,
  createBusinessTimerSuspensionParticipantRegistration,
  createBusinessTimerSuspensionProductionRegistration,
  isBusinessTimerClaimAllowedInTransaction,
  type BusinessTimerDescriptorRegistration,
  type BusinessTimerFeatureManifest,
} from "./business-timer-suspension-participant.js";

const directories: string[] = [];
const t0 = Date.parse("2026-08-19T00:00:00.000Z");
const at = (offset: number): string => new Date(t0 + offset).toISOString();
const policy = { openItemDeadlineMs: 60_000, lightTaskDeadlineMs: 60_000 } as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openDatabase(path?: string): DatabaseSync {
  const resolvedPath = path ?? (() => {
    const directory = mkdtempSync(join(tmpdir(), "dao-business-timers-"));
    directories.push(directory);
    return join(directory, "authority.sqlite");
  })();
  const database = new DatabaseSync(resolvedPath);
  migrateAuthorityDatabase(database);
  database.exec(`
    CREATE TABLE room_business_timer_freeze_batches (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
      suspended_at TEXT NOT NULL,
      suspended_count INTEGER NOT NULL CHECK (suspended_count >= 0),
      resumed_at TEXT,
      resumed_count INTEGER CHECK (resumed_count >= 0),
      descriptor_ids_json TEXT NOT NULL
        CHECK (json_valid(descriptor_ids_json) AND json_type(descriptor_ids_json) = 'array'),
      PRIMARY KEY (room_id, archive_generation),
      CHECK ((resumed_at IS NULL) = (resumed_count IS NULL))
    ) STRICT;
    CREATE TABLE room_business_timer_freezes (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      archive_generation INTEGER NOT NULL CHECK (archive_generation > 0),
      descriptor_id TEXT NOT NULL CHECK (length(trim(descriptor_id)) > 0),
      timer_key TEXT NOT NULL CHECK (length(trim(timer_key)) > 0),
      source_kind TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
      source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
      original_due_at TEXT NOT NULL,
      remaining_ms INTEGER NOT NULL CHECK (remaining_ms >= 0),
      frozen_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('frozen', 'resumed', 'discarded')),
      resumed_due_at TEXT,
      resolved_at TEXT,
      PRIMARY KEY (room_id, archive_generation, timer_key),
      CHECK (
        (state = 'frozen' AND resumed_due_at IS NULL AND resolved_at IS NULL)
        OR (state = 'resumed' AND resumed_due_at IS NOT NULL AND resolved_at IS NOT NULL)
        OR (state = 'discarded' AND resumed_due_at IS NULL AND resolved_at IS NOT NULL)
      )
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, readiness, tool_permissions_json)
    VALUES
      ('human-owner', 'human', 'Owner', NULL, '[]'),
      ('human-2', 'human', 'Human Two', NULL, '[]'),
      ('agent-1', 'agent', 'Agent One', 'ready', '[]');
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-1', 'Room One', 'active', '${at(0)}');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at
    ) VALUES
      ('room-1', 'human-owner', 'human', 'member', NULL, '[]', '${at(0)}', NULL),
      ('room-1', 'human-2', 'human', 'member', NULL, '[]', '${at(0)}', NULL),
      ('room-1', 'agent-1', 'agent', NULL, 'active', '[]', NULL, '${at(0)}');
    UPDATE rooms SET owner_actor_id = 'human-owner', governance_revision = 1 WHERE id = 'room-1';
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES
      ('message-open', 'room-1', 'human-owner', 'human', 'Open', '${at(0)}'),
      ('message-task', 'room-1', 'human-owner', 'human', 'Task', '${at(0)}'),
      ('message-expired', 'room-1', 'human-owner', 'human', 'Expired', '${at(-120_000)}'),
      ('message-done', 'room-1', 'human-owner', 'human', 'Done', '${at(0)}');
    INSERT INTO open_items (
      id, room_id, source_message_id, current_owner_actor_id, status, body,
      created_at, responded_at, requester_actor_id, transfer_chain_json, origin_kind
    ) VALUES
      ('item-live', 'room-1', 'message-open', 'agent-1', 'awaiting', 'Answer',
       '${at(0)}', NULL, 'human-owner', '[]', 'human_mention'),
      ('item-expired', 'room-1', 'message-expired', 'human-2', 'awaiting', 'Late',
       '${at(-120_000)}', NULL, 'human-owner', '[]', 'human_mention'),
      ('item-done', 'room-1', 'message-done', NULL, 'answered', 'Answered',
       '${at(0)}', '${at(10_000)}', 'human-owner', '[]', 'human_mention');
    INSERT INTO light_tasks (
      id, room_id, source_message_id, title, claimant_actor_id,
      claimant_role_at_claim, verifier_role, verifier_actor_id, criteria_json,
      status, created_at, claimed_at, delivered_at, verified_at
    ) VALUES
      ('task-live', 'room-1', 'message-task', 'Ship', 'human-owner',
       'owner', 'member', NULL, '[]', 'claimed', '${at(0)}', '${at(20_000)}', NULL, NULL),
      ('task-done', 'room-1', 'message-done', 'Done', 'human-owner',
       'owner', 'member', 'human-2', '[]', 'verified', '${at(0)}', '${at(0)}',
       '${at(10_000)}', '${at(20_000)}');
  `);
  return database;
}

function setLifecycle(
  database: DatabaseSync,
  status: "active" | "archived",
  generation: number,
  time: string,
): void {
  database.prepare(
    `UPDATE rooms
     SET status = ?, archive_generation = ?, archived_at = ?, governance_revision = governance_revision + 1
     WHERE id = 'room-1'`,
  ).run(status, generation, status === "archived" ? time : null);
}

function withTransaction<TResult>(
  database: DatabaseSync,
  operation: (transaction: AuthorityTransactionView) => TResult,
): TResult {
  database.exec("BEGIN IMMEDIATE");
  const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-timers");
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

function productionParticipant() {
  return createBusinessTimerSuspensionParticipant({
    manifest: { [BALL_BOUNDARY_TIMER_DESCRIPTOR_ID]: true },
    registrations: [createBallBoundaryBusinessTimerDescriptorRegistration(policy)],
  });
}

describe("BusinessTimerSuspensionParticipant production provider", () => {
  it("uses the exact enabled production registration and a real enabled Ball descriptor", () => {
    expect(businessTimerSuspensionParticipantRegistration).toEqual({
      registrationId: "dao.business-timers.suspension.v1",
      feature: "business-timer-suspension",
      version: 1,
      enabled: true,
      participant: expect.objectContaining({
        suspendForArchive: expect.any(Function),
        resumeAfterReopen: expect.any(Function),
      }),
    });
    expect(Object.keys(businessTimerSuspensionParticipantRegistration.participant ?? {}))
      .toEqual(["suspendForArchive", "resumeAfterReopen"]);
    expect(businessTimerFeatureManifest).toEqual({
      [BALL_BOUNDARY_TIMER_DESCRIPTOR_ID]: true,
    });
    expect(businessTimerDescriptorRegistrations.map((entry) => ({
      registrationId: entry.registrationId,
      descriptorId: entry.descriptorId,
      version: entry.version,
      enabled: entry.enabled,
    }))).toEqual([{
      registrationId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
      descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
      version: 1,
      enabled: true,
    }]);
  });

  it("freezes non-empty current business timers, persists remaining duration, and resumes once", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-business-timers-"));
    directories.push(directory);
    const path = join(directory, "authority.sqlite");
    let database = openDatabase(path);
    setLifecycle(database, "archived", 1, at(30_000));

    const suspended = withTransaction(database, (transaction) =>
      productionParticipant().suspendForArchive(transaction, {
        roomId: "room-1", archiveGeneration: 1, archivedAt: at(30_000),
      }));
    expect(suspended).toEqual({
      ok: true,
      result: {
        roomId: "room-1",
        archiveGeneration: 1,
        action: "suspended",
        affectedCount: 2,
        timerDescriptorIds: [BALL_BOUNDARY_TIMER_DESCRIPTOR_ID],
      },
    });
    expect(database.prepare(
      `SELECT remaining_ms AS remainingMs, state
       FROM room_business_timer_freezes ORDER BY remaining_ms`,
    ).all()).toEqual([
      { remainingMs: 30_000, state: "frozen" },
      { remainingMs: 50_000, state: "frozen" },
    ]);
    database.close();

    database = new DatabaseSync(path);
    setLifecycle(database, "active", 1, at(300_000));
    const resumed = withTransaction(database, (transaction) =>
      productionParticipant().resumeAfterReopen(transaction, {
        roomId: "room-1", archiveGeneration: 1, reopenedAt: at(300_000),
      }));
    expect(resumed).toEqual({
      ok: true,
      result: {
        roomId: "room-1",
        archiveGeneration: 1,
        action: "resumed",
        affectedCount: 2,
        timerDescriptorIds: [BALL_BOUNDARY_TIMER_DESCRIPTOR_ID],
      },
    });
    expect(database.prepare(
      `SELECT state, resumed_due_at AS resumedDueAt
       FROM room_business_timer_freezes ORDER BY resumed_due_at`,
    ).all()).toEqual([
      { state: "resumed", resumedDueAt: at(330_000) },
      { state: "resumed", resumedDueAt: at(350_000) },
    ]);
    const replay = withTransaction(database, (transaction) =>
      productionParticipant().resumeAfterReopen(transaction, {
        roomId: "room-1", archiveGeneration: 1, reopenedAt: at(999_000),
      }));
    expect(replay).toEqual(resumed);
    database.close();
  });

  it("linearizes claim/fire with archive, blocks frozen work after restart, and never double claims", () => {
    const database = openDatabase();
    try {
      setLifecycle(database, "archived", 2, at(30_000));
      withTransaction(database, (transaction) => {
        expect(productionParticipant().suspendForArchive(transaction, {
          roomId: "room-1", archiveGeneration: 2, archivedAt: at(30_000),
        }).ok).toBe(true);
        expect(isBusinessTimerClaimAllowedInTransaction(transaction, {
          roomId: "room-1",
          descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
          sourceKind: "open-item",
          sourceId: "item-live",
          holderActorId: "agent-1",
          holderKind: "agent",
          sinceAt: at(0),
          defaultDueAt: at(60_000),
          now: t0 + 60_000,
        })).toEqual({ allowed: false, reason: "room_archived" });
      });

      setLifecycle(database, "active", 2, at(300_000));
      withTransaction(database, (transaction) => {
        productionParticipant().resumeAfterReopen(transaction, {
          roomId: "room-1", archiveGeneration: 2, reopenedAt: at(300_000),
        });
        expect(isBusinessTimerClaimAllowedInTransaction(transaction, {
          roomId: "room-1",
          descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
          sourceKind: "open-item",
          sourceId: "item-live",
          holderActorId: "agent-1",
          holderKind: "agent",
          sinceAt: at(0),
          defaultDueAt: at(60_000),
          now: t0 + 329_999,
        })).toEqual({ allowed: false, reason: "not_due" });
        const permit = isBusinessTimerClaimAllowedInTransaction(transaction, {
          roomId: "room-1",
          descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
          sourceKind: "open-item",
          sourceId: "item-live",
          holderActorId: "agent-1",
          holderKind: "agent",
          sinceAt: at(0),
          defaultDueAt: at(60_000),
          now: t0 + 330_000,
        });
        expect(permit).toEqual({ allowed: true, timerKey: expect.any(String), dueAt: at(330_000) });
        if (!permit.allowed) throw new Error("expected timer permit");
        database.prepare(
          `INSERT INTO ball_boundary_claims (
             id, room_id, source_kind, source_id, holder_actor_id, holder_kind,
             reason, since_at, deadline_at, boundary_kind, claimed_at
           ) VALUES ('claim-1', 'room-1', 'open-item', 'item-live', 'agent-1', 'agent',
             'due', ?, ?, 'agent_trigger', ?)`,
        ).run(at(0), permit.dueAt, at(330_000));
        expect(isBusinessTimerClaimAllowedInTransaction(transaction, {
          roomId: "room-1",
          descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
          sourceKind: "open-item",
          sourceId: "item-live",
          holderActorId: "agent-1",
          holderKind: "agent",
          sinceAt: at(0),
          defaultDueAt: at(60_000),
          now: t0 + 331_000,
        })).toEqual({ allowed: false, reason: "already_claimed" });
      });

      setLifecycle(database, "archived", 3, at(340_000));
      const secondArchive = withTransaction(database, (transaction) =>
        productionParticipant().suspendForArchive(transaction, {
          roomId: "room-1", archiveGeneration: 3, archivedAt: at(340_000),
        }));
      expect(secondArchive.ok && secondArchive.result.affectedCount).toBe(1);
    } finally {
      database.close();
    }
  });

  it("serializes an archive CAS and timer claim contender on the same SQLite writer boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-business-timer-race-"));
    directories.push(directory);
    const path = join(directory, "authority.sqlite");
    const database = openDatabase(path);
    const contender = new DatabaseSync(path);
    contender.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN IMMEDIATE");
    const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-archive-race");
    try {
      setLifecycle(database, "archived", 8, at(30_000));
      expect(productionParticipant().suspendForArchive(transaction, {
        roomId: "room-1", archiveGeneration: 8, archivedAt: at(30_000),
      }).ok).toBe(true);
      expect(isBusinessTimerClaimAllowedInTransaction(transaction, {
        roomId: "room-1",
        descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
        sourceKind: "open-item",
        sourceId: "item-live",
        holderActorId: "agent-1",
        holderKind: "agent",
        sinceAt: at(0),
        defaultDueAt: at(60_000),
        now: t0 + 60_000,
      })).toEqual({ allowed: false, reason: "room_archived" });
      expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow(/locked/i);
      releaseDatabaseAuthorityTransactionView(transaction);
      database.exec("COMMIT");

      contender.exec("BEGIN IMMEDIATE");
      const contenderTransaction = mintDatabaseAuthorityTransactionView(
        contender,
        "room-1",
        "tx-claim-after-archive",
      );
      expect(isBusinessTimerClaimAllowedInTransaction(contenderTransaction, {
        roomId: "room-1",
        descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
        sourceKind: "open-item",
        sourceId: "item-live",
        holderActorId: "agent-1",
        holderKind: "agent",
        sinceAt: at(0),
        defaultDueAt: at(60_000),
        now: t0 + 60_000,
      })).toEqual({ allowed: false, reason: "room_archived" });
      releaseDatabaseAuthorityTransactionView(contenderTransaction);
      contender.exec("ROLLBACK");
    } finally {
      releaseDatabaseAuthorityTransactionView(transaction);
      if (database.isTransaction) database.exec("ROLLBACK");
      if (contender.isTransaction) contender.exec("ROLLBACK");
      contender.close();
      database.close();
    }
  });

  it("does not revive expired or terminal work and never pauses security absolute expiry", () => {
    const database = openDatabase();
    try {
      const parameterSha256 = "a".repeat(64);
      database.exec(`
        INSERT INTO session_families (
          family_id, public_id, account_id, actor_id, device_id, device_label,
          platform, created_at, refresh_expires_at, revoked_at
        ) VALUES (
          'family-1', 'public-family-1', 'account-1', 'human-owner', 'device-1',
          'Test device', 'unknown', ${t0}, ${t0 + 900_000}, NULL
        );
        INSERT INTO sessions (
          family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
          access_expires_at, refresh_expires_at, revoked_at
        ) VALUES (
          'family-1', 'account-1', 'human-owner', 'access-hash', 'refresh-hash',
          ${t0 + 90_000}, ${t0 + 900_000}, NULL
        );
        INSERT INTO agent_executions (
          id, room_id, agent_id, status, started_at, tool_name, action_category,
          queued_at, updated_at
        ) VALUES (
          'execution-security', 'room-1', 'agent-1', 'running', '${at(0)}',
          'sandbox-file.write', 'waiting_upstream', '${at(0)}', '${at(0)}'
        );
        INSERT INTO agent_execution_attempts (
          execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
          action_category, started_at, recovery_cursor
        ) VALUES ('execution-security', 1, 1, 1, 'running', 'tool_call', '${at(0)}', 0);
        INSERT INTO agent_execution_grants (
          grant_id, execution_id, attempt_seq, agent_id, room_id, tool_id,
          parameter_sha256, issued_at, expires_at, consumed_at
        ) VALUES (
          'grant-security', 'execution-security', 1, 'agent-1', 'room-1',
          'sandbox-file.write', '${parameterSha256}', '${at(0)}', '${at(90_000)}', NULL
        );
        INSERT INTO tool_confirmations (
          confirmation_id, execution_id, attempt_seq, tool_id, parameter_sha256,
          room_id, human_principal_id, session_family_id, expires_at,
          target, impact, reversibility, consumed_at
        ) VALUES (
          'confirmation-security', 'execution-security', 1, 'sandbox-file.write',
          '${parameterSha256}', 'room-1', 'human-owner', 'family-1', '${at(90_000)}',
          'bounded-target', 'bounded-impact', 'compensatable', NULL
        );
      `);
      const securityExpiries = {
        session: database.prepare(
          `SELECT access_expires_at AS accessExpiresAt,
                  refresh_expires_at AS refreshExpiresAt
           FROM sessions WHERE family_id = 'family-1'`,
        ).get(),
        grant: database.prepare(
          "SELECT expires_at AS expiresAt FROM agent_execution_grants WHERE grant_id = 'grant-security'",
        ).get(),
        confirmation: database.prepare(
          `SELECT expires_at AS expiresAt FROM tool_confirmations
           WHERE confirmation_id = 'confirmation-security'`,
        ).get(),
      };
      setLifecycle(database, "archived", 4, at(30_000));
      const suspended = withTransaction(database, (transaction) =>
        productionParticipant().suspendForArchive(transaction, {
          roomId: "room-1", archiveGeneration: 4, archivedAt: at(30_000),
        }));
      expect(suspended.ok && suspended.result.affectedCount).toBe(2);
      database.exec(`
        UPDATE open_items
        SET status = 'answered', current_owner_actor_id = NULL, responded_at = '${at(40_000)}'
        WHERE id = 'item-live';
      `);
      setLifecycle(database, "active", 4, at(300_000));
      const resumed = withTransaction(database, (transaction) =>
        productionParticipant().resumeAfterReopen(transaction, {
          roomId: "room-1", archiveGeneration: 4, reopenedAt: at(300_000),
        }));
      expect(resumed.ok && resumed.result.affectedCount).toBe(1);
      expect(database.prepare(
        `SELECT state, COUNT(*) AS count
         FROM room_business_timer_freezes GROUP BY state ORDER BY state`,
      ).all()).toEqual([
        { state: "discarded", count: 1 },
        { state: "resumed", count: 1 },
      ]);
      expect({
        session: database.prepare(
          `SELECT access_expires_at AS accessExpiresAt,
                  refresh_expires_at AS refreshExpiresAt
           FROM sessions WHERE family_id = 'family-1'`,
        ).get(),
        grant: database.prepare(
          "SELECT expires_at AS expiresAt FROM agent_execution_grants WHERE grant_id = 'grant-security'",
        ).get(),
        confirmation: database.prepare(
          `SELECT expires_at AS expiresAt FROM tool_confirmations
           WHERE confirmation_id = 'confirmation-security'`,
        ).get(),
      }).toEqual(securityExpiries);
    } finally {
      database.close();
    }
  });

  it("rolls back all descriptor writes and validates enabled/missing/version/duplicate/throw/malformed/cross-room", () => {
    const database = openDatabase();
    setLifecycle(database, "archived", 6, at(30_000));
    database.exec("BEGIN IMMEDIATE");
    const transaction = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-rollback");
    expect(productionParticipant().suspendForArchive(transaction, {
      roomId: "room-1", archiveGeneration: 6, archivedAt: at(30_000),
    }).ok).toBe(true);
    releaseDatabaseAuthorityTransactionView(transaction);
    database.exec("ROLLBACK");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_business_timer_freezes",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_business_timer_freeze_batches",
    ).get()).toEqual({ count: 0 });

    const descriptor = createBallBoundaryBusinessTimerDescriptorRegistration(policy);
    const manifest: BusinessTimerFeatureManifest = { [BALL_BOUNDARY_TIMER_DESCRIPTOR_ID]: true };
    const cases: Array<{
      readonly manifest: BusinessTimerFeatureManifest;
      readonly registrations: readonly unknown[];
      readonly reason: string;
    }> = [
      { manifest, registrations: [], reason: "missing_registration" },
      { manifest, registrations: [{ ...descriptor, version: 2 }], reason: "version_mismatch" },
      { manifest, registrations: [descriptor, descriptor], reason: "duplicate_registration_id" },
      {
        manifest,
        registrations: [{ ...descriptor, enabled: false, descriptor: undefined }],
        reason: "manifest_mismatch",
      },
    ];
    for (const candidate of cases) {
      const participant = createBusinessTimerSuspensionParticipant(candidate);
      const result = withTransaction(database, (tx) => participant.suspendForArchive(tx, {
        roomId: "room-1", archiveGeneration: 6, archivedAt: at(30_000),
      }));
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ reason: candidate.reason }),
      }));
    }

    const unbound = mintAuthorityTransactionView("room-1", "unbound-timer");
    expect(productionParticipant().suspendForArchive(unbound, {
      roomId: "room-1", archiveGeneration: 6, archivedAt: at(30_000),
    })).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ reason: "participant_threw" }),
    }));
    expect(productionParticipant().suspendForArchive(
      { roomId: "room-1", transactionId: "forged" } as never,
      { roomId: "room-1", archiveGeneration: 6, archivedAt: at(30_000) },
    )).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ reason: "transaction_mismatch" }),
    }));
    const extraDto = withTransaction(database, (tx) =>
      productionParticipant().suspendForArchive(tx, {
        roomId: "room-1", archiveGeneration: 6, archivedAt: at(30_000), extra: true,
      } as never));
    expect(extraDto).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ reason: "transaction_mismatch" }),
    }));

    const throwing = vi.fn(() => { throw new Error("sensitive raw timer body"); });
    const invalidDescriptors: Array<{
      readonly registration: BusinessTimerDescriptorRegistration;
      readonly reason: string;
    }> = [
      {
        registration: {
          ...descriptor,
          descriptor: { ...descriptor.descriptor!, listCurrentTimersInTransaction: throwing },
        },
        reason: "participant_threw",
      },
      {
        registration: {
          ...descriptor,
          descriptor: {
            ...descriptor.descriptor!,
            listCurrentTimersInTransaction: () => ({
              roomId: "room-1", descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
              timers: [{ timerKey: "x", dueAt: "not-a-time", secret: "leak" }],
            } as never),
          },
        },
        reason: "malformed_result",
      },
      {
        registration: {
          ...descriptor,
          descriptor: {
            ...descriptor.descriptor!,
            listCurrentTimersInTransaction: () => ({
              roomId: "room-other", descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID, timers: [],
            }),
          },
        },
        reason: "cross_room_result",
      },
    ];
    for (const candidate of invalidDescriptors) {
      const participant = createBusinessTimerSuspensionParticipant({
        manifest,
        registrations: [candidate.registration],
      });
      const result = withTransaction(database, (tx) => participant.suspendForArchive(tx, {
        roomId: "room-1", archiveGeneration: 6, archivedAt: at(30_000),
      }));
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ reason: candidate.reason }),
      }));
      expect(JSON.stringify(result)).not.toContain("sensitive raw timer body");
    }
    database.close();
  });

  it("creates a configurable exact production registration without external adapters", () => {
    const registration = createBusinessTimerSuspensionParticipantRegistration({
      manifest: { [BALL_BOUNDARY_TIMER_DESCRIPTOR_ID]: true },
      registrations: [createBallBoundaryBusinessTimerDescriptorRegistration(policy)],
    });
    expect(registration.registrationId).toBe("dao.business-timers.suspension.v1");
    expect(registration.enabled).toBe(true);
    expect(createBusinessTimerSuspensionProductionRegistration(policy).registrationId)
      .toBe("dao.business-timers.suspension.v1");
  });

  it("persists and replays an empty timer aggregation as a completed archive batch", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-empty-business-timers-"));
    directories.push(directory);
    const path = join(directory, "authority.sqlite");
    let database = openDatabase(path);
    database.exec(`
      DELETE FROM open_items WHERE status IN ('awaiting', 'transferred');
      DELETE FROM light_tasks WHERE status IN ('claimed', 'delivered');
    `);
    setLifecycle(database, "archived", 7, at(30_000));
    const first = withTransaction(database, (transaction) =>
      productionParticipant().suspendForArchive(transaction, {
        roomId: "room-1", archiveGeneration: 7, archivedAt: at(30_000),
      }));
    expect(first.ok && first.result.affectedCount).toBe(0);
    database.close();

    database = new DatabaseSync(path);
    const replay = withTransaction(database, (transaction) =>
      productionParticipant().suspendForArchive(transaction, {
        roomId: "room-1", archiveGeneration: 7, archivedAt: at(30_000),
      }));
    expect(replay).toEqual(first);
    expect(database.prepare(
      "SELECT suspended_count AS count FROM room_business_timer_freeze_batches",
    ).all()).toEqual([{ count: 0 }]);
    database.close();
  });
});
