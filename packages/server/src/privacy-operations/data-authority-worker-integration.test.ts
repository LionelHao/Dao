import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { executeHumanDatabaseCommand } from "../persistence/authority-database-handler.js";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import { executeRoomAssignmentCommandInTransaction } from
  "../room-assignment/assignment-service.js";
import {
  executePrivacyDataAuthorityOperation,
  PrivacyDataAuthorityError,
} from "./data-authority-database-handler.js";
import type { PrivacyDataAuthorityWorkerPort } from "./data-authority-worker-adapters.js";
import { createDiagnosticsService } from "./diagnostics-service.js";
import {
  createDiagnosticsAuthorityWorkerAdapter,
  createRoomExportAuthorityWorkerPorts,
} from "./data-authority-worker-adapters.js";
import { createRoomExportAuthorityAdapter } from "./room-export-authority-adapter.js";
import {
  createRoomDataExport,
  ROOM_EXPORT_MAX_RECORD_BYTES,
  RoomExportError,
} from "./room-export.js";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const directories = new Set<string>();

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dao-privacy-data-"));
  directories.add(directory);
  return join(directory, "authority.sqlite");
}

function addHumanSession(database: DatabaseSync, actorId: string): void {
  database.prepare(
    `INSERT INTO actors (id, kind, display_name) VALUES (?, 'human', ?)`,
  ).run(actorId, actorId);
  database.prepare(
    `INSERT INTO session_families (
       family_id, public_id, account_id, actor_id, device_id, device_label,
       platform, created_at, refresh_expires_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, 'Test device', 'unknown', ?, ?, NULL)`,
  ).run(`family-${actorId}`, `public-${actorId}`, `account-${actorId}`, actorId,
    `device-${actorId}`, NOW - 1_000, NOW + 60_000);
  database.prepare(
    `INSERT INTO sessions (
       family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
       access_expires_at, refresh_expires_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(`family-${actorId}`, `account-${actorId}`, actorId, `access-${actorId}`,
    `refresh-${actorId}`, NOW + 30_000, NOW + 60_000);
  if (actorId === "owner") {
    database.prepare(
      `INSERT INTO sessions (
         family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
         access_expires_at, refresh_expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(`family-${actorId}`, `account-${actorId}`, actorId, "access-owner-peer",
      "refresh-owner-peer", NOW + 30_000, NOW + 60_000);
  }
}

function seedAuthority(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  migrateAuthorityDatabase(database);
  const messageOccurredAt = new Date(NOW - 500).toISOString();
  addHumanSession(database, "admin");
  addHumanSession(database, "owner");
  addHumanSession(database, "outsider");
  database.prepare(
    `INSERT INTO tenant_administrator_registry (
       singleton_id, revision, bootstrap_configuration_sha256, initialized_at, updated_at
     ) VALUES (1, 1, ?, ?, ?)`,
  ).run("0".repeat(64), new Date(NOW - 1_000).toISOString(), new Date(NOW - 1_000).toISOString());
  database.prepare(
    `INSERT INTO tenant_administrators (
       human_actor_id, revision, status, source_kind, created_by_human_actor_id,
       created_at, updated_at, removed_at
     ) VALUES ('admin', 1, 'active', 'bootstrap', NULL, ?, ?, NULL)`,
  ).run(new Date(NOW - 1_000).toISOString(), new Date(NOW - 1_000).toISOString());
  database.prepare(
    `INSERT INTO tenant_administrator_revisions (
       human_actor_id, revision, status, operation, changed_by_human_actor_id, changed_at
     ) VALUES ('admin', 1, 'active', 'bootstrap', NULL, ?)`,
  ).run(new Date(NOW - 1_000).toISOString());
  database.prepare(
    `INSERT INTO tenant_administrators (
       human_actor_id, revision, status, source_kind, created_by_human_actor_id,
       created_at, updated_at, removed_at
     ) VALUES ('owner', 1, 'active', 'bootstrap', NULL, ?, ?, NULL)`,
  ).run(new Date(NOW - 1_000).toISOString(), new Date(NOW - 1_000).toISOString());

  database.prepare(
    `INSERT INTO rooms (id, name, status, created_at)
     VALUES ('room-1', 'Room one', 'active', ?)`,
  ).run(new Date(NOW - 2_000).toISOString());
  database.prepare(
    `INSERT INTO room_memberships (
       room_id, actor_id, kind, role, participation, joined_at, access_revision
     ) VALUES ('room-1', 'owner', 'human', 'member', 'active', ?, 7)`,
  ).run(new Date(NOW - 2_000).toISOString());
  database.prepare("UPDATE rooms SET owner_actor_id = 'owner' WHERE id = 'room-1'").run();
  database.prepare(
    `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
     VALUES ('room', 'room-1', 0, 1)`,
  ).run();
  database.prepare(
    "UPDATE streams SET head_seq = 1 WHERE stream_kind = 'room' AND stream_id = 'room-1'",
  ).run();
  database.prepare(
    `INSERT INTO room_audit (id, type, room_id, actor_id, result, timestamp, details_json)
     VALUES ('audit-room-created', 'room.created', 'room-1', 'owner', 'created', ?, '{}')`,
  ).run(new Date(NOW - 2_000).toISOString());
  database.prepare(
    `INSERT INTO events (
       event_id, stream_kind, stream_id, stream_seq, room_id, authority_kind,
       actor_id, event_type, occurred_at, payload_json
     ) VALUES (
       'event-room-created', 'room', 'room-1', 1, 'room-1', 'human',
       'owner', 'room.created', ?, '{}'
     )`,
  ).run(new Date(NOW - 2_000).toISOString());
  database.prepare(
    "UPDATE streams SET head_seq = 2 WHERE stream_kind = 'room' AND stream_id = 'room-1'",
  ).run();
  database.prepare(
    `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
     VALUES ('message-1', 'room-1', 'owner', 'human', 'room-corpus-sentinel', ?)`,
  ).run(messageOccurredAt);
  database.prepare(
    `INSERT INTO message_revisions (
       message_id, revision, body, revised_at, revised_by_actor_id
     ) VALUES ('message-1', 1, 'room-corpus-sentinel', ?, 'owner')`,
  ).run(messageOccurredAt);
  database.prepare(
    `INSERT INTO message_envelopes (
       message_id, room_id, message_kind, lifecycle, current_revision,
       revision_count, created_at, recalled_at, recalled_by_actor_id
     ) VALUES ('message-1', 'room-1', 'human', 'active', 1, 1, ?, NULL, NULL)`,
  ).run(messageOccurredAt);
  database.prepare(
    `INSERT INTO events (
       event_id, stream_kind, stream_id, stream_seq, room_id, authority_kind,
       actor_id, event_type, occurred_at, payload_json
     ) VALUES (
       'event-message-1', 'room', 'room-1', 2, 'room-1', 'human',
       'owner', 'room.message.accepted', ?, ?
     )`,
  ).run(messageOccurredAt, JSON.stringify({ id: "message-1" }));
  return database;
}

function seedRealGovernanceProducers(database: DatabaseSync): void {
  for (const actorId of ["invitee-accept", "invitee-reject"]) {
    addHumanSession(database, actorId);
    database.prepare(
      `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
       VALUES ('identity', ?, 0, 1)`,
    ).run(actorId);
  }
  database.prepare(
    `INSERT INTO actors (id, kind, display_name, tool_permissions_json)
     VALUES ('agent-review', 'agent', 'Review Agent', '["review.read"]')`,
  ).run();
  database.prepare(
    `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
     VALUES ('identity', 'agent-review', 0, 1)`,
  ).run();

  const context = (actorId: string, requestId: string) => ({
    kind: "human" as const,
    sessionId: `access-${actorId}`,
    sessionFamilyId: `family-${actorId}`,
    principal: { accountId: `account-${actorId}`, actorId },
    requestId,
    idempotencyKey: requestId,
  });
  executeHumanDatabaseCommand(database, {
    context: context("owner", "configure-agent"),
    command: { type: "agent.configure", roomId: "room-1", payload: {
      agentId: "agent-review", participation: "active", toolPermissions: ["review.read"],
    } },
    now: NOW - 400,
  });
  database.prepare(
    `INSERT INTO agent_profiles (
       id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json,
       display_name, global_responsibility, created_at, updated_at, source_kind
     ) VALUES ('profile-review', 'agent-review', 1, 'enabled', '[]', '[]',
       'Review Agent', 'Review room work', ?, ?, 'administrator_command')`,
  ).run(new Date(NOW - 500).toISOString(), new Date(NOW - 500).toISOString());
  database.prepare(
    `INSERT INTO agent_profile_revisions (
       profile_id, revision, actor_id, display_name, global_responsibility, status,
       capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id,
       changed_at, operation
     ) VALUES ('profile-review', 1, 'agent-review', 'Review Agent', 'Review room work',
       'enabled', '[]', '[]', 'owner', ?, 'create')`,
  ).run(new Date(NOW - 500).toISOString());
  const governanceRevision = (database.prepare(
    "SELECT governance_revision AS value FROM rooms WHERE id = 'room-1'",
  ).get() as { value: number }).value;
  database.exec("BEGIN IMMEDIATE");
  const transaction = mintDatabaseAuthorityTransactionView(
    database, "room-1", "privacy-export-assignment-producer",
  );
  try {
    executeRoomAssignmentCommandInTransaction(transaction, context("owner", "assignment-create"), {
      kind: "create", requestId: "assignment-create", idempotencyKey: "assignment-create-key",
      roomId: "room-1", expectedRoomRevision: governanceRevision,
      profileId: "profile-review", participation: "active",
      roomResponsibility: "Review room work", capabilitySubset: [], toolSubset: [],
    }, NOW - 400);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    releaseDatabaseAuthorityTransactionView(transaction);
  }
  for (const [actorId, decision, offset] of [
    ["invitee-accept", "accept", 300],
    ["invitee-reject", "reject", 200],
  ] as const) {
    const token = `${actorId}-token`;
    executeHumanDatabaseCommand(database, {
      context: context("owner", `invite-${actorId}`),
      command: { type: "human.invitation.issue", roomId: "room-1", payload: {
        inviteeActorId: actorId,
      } },
      invitationSecret: {
        tokenHash: createHash("sha256").update(token).digest("base64url"),
        sealedToken: `sealed-${actorId}`,
      },
      // Two real commands from the same actor deliberately share one timestamp.
      // The export projection must pair each immutable audit with exactly one event.
      now: NOW - 350,
    });
    executeHumanDatabaseCommand(database, {
      context: context(actorId, `decide-${actorId}`),
      command: { type: "human.invitation.decide", payload: { token, decision } },
      now: NOW - offset + 50,
    });
  }
}

function sqliteWorker(database: DatabaseSync): PrivacyDataAuthorityWorkerPort {
  return {
    async executePrivacyData(operation) {
      try {
        return executePrivacyDataAuthorityOperation(database, operation);
      } catch (error) {
        if (error instanceof PrivacyDataAuthorityError) {
          Object.assign(error, {
            status: error.code === "storage_unavailable" ? 503 : 403,
          });
        }
        throw error;
      }
    },
  };
}

async function firstError(stream: AsyncIterable<Uint8Array>): Promise<unknown> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    await iterator.next();
    return undefined;
  } catch (error) {
    return error;
  }
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

describe("FT-14 production privacy data AuthorityWorker ports", () => {
  it("authorizes only Tenant Administrator diagnostics and never reads Room corpus", async () => {
    const path = databasePath();
    const database = seedAuthority(path);
    const worker = sqliteWorker(database);
    const committed: Uint8Array[] = [];
    const audit = { append: vi.fn(async () => {}) };
    const authority = createDiagnosticsAuthorityWorkerAdapter({
      worker,
      nowMs: () => NOW,
      artifacts: {
        async commit(input) {
          committed.push(input.bytes);
          return { artifactId: "diagnostics-artifact-1", byteLength: input.bytes.byteLength };
        },
        async discard() {},
      },
      audit,
    });
    try {
      const service = createDiagnosticsService({ authority, now: () => new Date(NOW) });
      await expect(service.generate({
        actorId: "outsider",
        sessionFamilyId: "family-outsider",
        sessionId: "access-outsider",
      })).rejects.toMatchObject({ code: "forbidden" });
      expect(committed).toHaveLength(0);

      await expect(service.generate({
        actorId: "admin",
        sessionFamilyId: "family-admin",
        sessionId: "access-admin",
      })).resolves.toMatchObject({ artifactId: "diagnostics-artifact-1" });
      expect(committed).toHaveLength(1);
      expect(new TextDecoder().decode(committed[0])).not.toContain("room-corpus-sentinel");
      expect(JSON.stringify(audit.append.mock.calls)).not.toContain("room-corpus-sentinel");
      expect(JSON.stringify(audit.append.mock.calls)).not.toContain("bytes");
    } finally {
      database.close();
    }
  });

  it.each(["admin", "outsider"])(
    "returns 403 and zero bytes when %s has no owner membership",
    async (actorId) => {
      const path = databasePath();
      const database = seedAuthority(path);
      const worker = sqliteWorker(database);
      const authority = createRoomExportAuthorityAdapter(createRoomExportAuthorityWorkerPorts({
        worker,
        nowMs: () => NOW,
        audit: { async append() {} },
      }));
      try {
        const error = await firstError(createRoomDataExport({ authority }).stream({
          actorId,
          roomId: "room-1",
          sessionFamilyId: `family-${actorId}`,
          sessionId: `access-${actorId}`,
        }));
        expect(error).toBeInstanceOf(RoomExportError);
        expect(error).toMatchObject({ status: 403, code: "room_export_forbidden" });
      } finally {
        database.close();
      }
    },
  );

  it("allows a dual-role Tenant Administrator owner and rechecks exact session before finalizing", async () => {
    const path = databasePath();
    const database = seedAuthority(path);
    const worker = sqliteWorker(database);
    const audits: unknown[] = [];
    const authority = createRoomExportAuthorityAdapter(createRoomExportAuthorityWorkerPorts({
      worker,
      nowMs: () => NOW,
      audit: { async append(record) { audits.push(record); } },
    }));
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of createRoomDataExport({
        authority,
        now: () => new Date(NOW + 1_000),
      }).stream({
        actorId: "owner", roomId: "room-1", sessionFamilyId: "family-owner",
        sessionId: "access-owner",
      })) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(6);
      expect(chunks.every((chunk) => chunk.byteLength <= ROOM_EXPORT_MAX_RECORD_BYTES)).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(chunks[0]))).toMatchObject({
        type: "header",
        roomId: "room-1",
        watermark: 2,
      });
      const records = chunks.slice(1, -1).map((chunk) =>
        JSON.parse(new TextDecoder().decode(chunk)) as { category: string; payload: unknown });
      expect(records.filter((record) =>
        record.category === "membership_governance_audit")).toHaveLength(2);
      expect(records.some((record) => record.category === "membership_governance_audit" &&
        JSON.stringify(record.payload).includes("governance_audit"))).toBe(true);
      expect(records.some((record) => record.category === "message_revision" &&
        JSON.stringify(record.payload).includes("room-corpus-sentinel"))).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(chunks.at(-1)!))).toMatchObject({
        type: "manifest",
        watermark: 2,
        recordCount: 4,
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(audits)).not.toContain("room-corpus-sentinel");

      const iterator = createRoomDataExport({ authority }).stream({
        actorId: "owner",
        roomId: "room-1",
        sessionFamilyId: "family-owner",
        sessionId: "access-owner",
      })[Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(false);
      expect((await iterator.next()).done).toBe(false);
      expect((await iterator.next()).done).toBe(false);
      expect((await iterator.next()).done).toBe(false);
      expect((await iterator.next()).done).toBe(false);
      database.prepare(
        "UPDATE sessions SET revoked_at = ? WHERE access_token_hash = 'access-owner'",
      ).run(NOW);
      await expect(iterator.next()).rejects.toThrow("room export authorization changed");

      const peer = database.prepare(
        `SELECT revoked_at AS revokedAt FROM sessions
         WHERE access_token_hash = 'access-owner-peer'`,
      ).get();
      expect(peer).toEqual({ revokedAt: null });
      const exactSessionError = await firstError(createRoomDataExport({ authority }).stream({
        actorId: "owner", roomId: "room-1", sessionFamilyId: "family-owner",
        sessionId: "access-owner",
      }));
      expect(exactSessionError).toMatchObject({ status: 403, code: "room_export_forbidden" });
    } finally {
      database.close();
    }
  });

  it("exports real configure/invite/accept/reject governance producers with actor and details at the fixed watermark", async () => {
    const path = databasePath();
    const database = seedAuthority(path);
    seedRealGovernanceProducers(database);
    const authority = createRoomExportAuthorityAdapter(createRoomExportAuthorityWorkerPorts({
      worker: sqliteWorker(database),
      nowMs: () => NOW,
      audit: { async append() {} },
    }));
    try {
      const iterator = createRoomDataExport({ authority }).stream({
        actorId: "owner", roomId: "room-1", sessionFamilyId: "family-owner",
        sessionId: "access-owner",
      })[Symbol.asyncIterator]();
      const header = JSON.parse(new TextDecoder().decode((await iterator.next()).value)) as {
        type: string; watermark: number;
      };
      expect(header).toEqual(expect.objectContaining({ type: "header", watermark: 8 }));

      const lateAt = new Date(NOW - 100).toISOString();
      const postWatermarkSeq = header.watermark + 1;
      database.prepare(
        "UPDATE streams SET head_seq = ? WHERE stream_kind = 'room' AND stream_id = 'room-1'",
      ).run(postWatermarkSeq);
      database.prepare(
        `INSERT INTO room_audit (id, type, room_id, actor_id, result, timestamp, details_json)
         VALUES ('audit-after-watermark', 'room.human.invited', 'room-1', 'owner',
           'pending', ?, '{"targetActorId":"must-not-export"}')`,
      ).run(lateAt);
      database.prepare(
        `INSERT INTO events (
           event_id, stream_kind, stream_id, stream_seq, room_id, authority_kind,
           actor_id, event_type, occurred_at, payload_json
         ) VALUES ('event-after-watermark', 'room', 'room-1', ?, 'room-1', 'human',
           'owner', 'human.invitation.issued', ?, '{"inviteeActorId":"must-not-export"}')`,
      ).run(postWatermarkSeq, lateAt);

      const records: Array<Readonly<{
        category: string; entityId: string; payload: Record<string, unknown>;
      }>> = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const value = JSON.parse(new TextDecoder().decode(next.value)) as {
          type: string;
          category?: string;
          entityId?: string;
          payload?: Record<string, unknown>;
        };
        if (value.type === "record" && value.category !== undefined &&
            value.entityId !== undefined && value.payload !== undefined) {
          records.push({ category: value.category, entityId: value.entityId, payload: value.payload });
        }
      }
      const governance = records.filter(({ category }) =>
        category === "membership_governance_audit").map(({ payload }) => payload);
      const producerPairs = [
        ["room.agent.configured", "agent.configured", "owner", "agent-review"],
        ["room.human.invited", "human.invitation.issued", "owner", "invitee-accept"],
        ["room.invitation.accepted", "human.invitation.accepted", "invitee-accept", "invitee-accept"],
        ["room.invitation.rejected", "human.invitation.rejected", "invitee-reject", "invitee-reject"],
      ] as const;
      for (const [auditType, eventType, actorId, targetActorId] of producerPairs) {
        expect(governance).toContainEqual(expect.objectContaining({
          recordKind: "governance_audit", type: auditType, actorId,
          details: expect.objectContaining({ targetActorId }),
        }));
        expect(governance).toContainEqual(expect.objectContaining({
          recordKind: "room_governance_snapshot", eventType, actorId,
          details: expect.any(Object),
        }));
      }
      const sameMillisecondInvites = records.filter(({ category, payload }) =>
        category === "membership_governance_audit" &&
        payload.recordKind === "governance_audit" && payload.type === "room.human.invited");
      expect(sameMillisecondInvites).toHaveLength(2);
      expect(new Set(sameMillisecondInvites.map(({ entityId }) => entityId)).size).toBe(2);
      expect(governance).toContainEqual(expect.objectContaining({
        recordKind: "governance_audit", type: "room.agent.configured", actorId: "owner",
        details: expect.objectContaining({ assignmentId: expect.any(String) }),
      }));
      expect(governance).toContainEqual(expect.objectContaining({
        recordKind: "room_governance_snapshot",
        eventType: "room.agent-assignment.changed", actorId: "owner",
      }));
      const sameMillisecondAgentAudits = records.filter(({ category, payload }) =>
        category === "membership_governance_audit" &&
        payload.recordKind === "governance_audit" && payload.type === "room.agent.configured");
      expect(sameMillisecondAgentAudits).toHaveLength(2);
      expect(new Set(sameMillisecondAgentAudits.map(({ entityId }) => entityId)).size).toBe(2);
      expect(JSON.stringify(governance)).not.toContain("must-not-export");
    } finally {
      database.close();
    }
  });
});
