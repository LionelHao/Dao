import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { createTenantAdministrationAuthority } from "./authority-service.js";
import { createSqliteTenantAdministrationRepository } from "./sqlite-repository.js";

const NOW = "2026-08-24T07:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DIGEST = "d".repeat(64);
const databases: DatabaseSync[] = [];
const directories: string[] = [];

function fixture(options: Readonly<{
  profileAssignmentFanoutLimit?: number;
  credentialReadiness?: "ready" | "noauth";
}> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dao-tenant-administration-"));
  directories.push(directory);
  const databasePath = join(directory, "authority.sqlite");
  const database = new DatabaseSync(databasePath);
  databases.push(database);
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, reachability, readiness, tool_permissions_json)
    VALUES
      ('human-owner', 'human', 'Owner', 'online', NULL, '[]'),
      ('human-admin', 'human', 'Admin', 'online', NULL, '[]'),
      ('human-member', 'human', 'Member', 'online', NULL, '[]'),
      ('agent-existing', 'agent', 'Agent', NULL, 'ready', '[]');
    INSERT INTO session_families (
      family_id, public_id, account_id, actor_id, device_id, device_label,
      platform, created_at, refresh_expires_at, revoked_at
    ) VALUES
      ('family-owner', 'public-owner', 'owner-account', 'human-owner', 'device-owner',
       'Owner Mac', 'macos', ${NOW_MS}, ${NOW_MS + 1000000}, NULL),
      ('family-admin', 'public-admin', 'admin-account', 'human-admin', 'device-admin',
       'Admin Mac', 'macos', ${NOW_MS}, ${NOW_MS + 1000000}, NULL),
      ('family-member', 'public-member', 'member-account', 'human-member', 'device-member',
       'Member Mac', 'macos', ${NOW_MS}, ${NOW_MS + 1000000}, NULL);
    INSERT INTO sessions (
      family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
      access_expires_at, refresh_expires_at, revoked_at
    ) VALUES
      ('family-owner', 'owner-account', 'human-owner', 'session-owner', 'refresh-owner',
       ${NOW_MS + 1000000}, ${NOW_MS + 1000000}, NULL),
      ('family-admin', 'admin-account', 'human-admin', 'session-admin', 'refresh-admin',
       ${NOW_MS + 1000000}, ${NOW_MS + 1000000}, NULL),
      ('family-member', 'member-account', 'human-member', 'session-member', 'refresh-member',
       ${NOW_MS + 1000000}, ${NOW_MS + 1000000}, NULL);
  `);
  const contexts = new Map<string, AuthenticatedSessionContext>([
    ["owner-token", { sessionId: "session-owner", sessionFamilyId: "family-owner",
      principal: { accountId: "owner-account", actorId: "human-owner" } }],
    ["admin-token", { sessionId: "session-admin", sessionFamilyId: "family-admin",
      principal: { accountId: "admin-account", actorId: "human-admin" } }],
    ["member-token", { sessionId: "session-member", sessionFamilyId: "family-member",
      principal: { accountId: "member-account", actorId: "human-member" } }],
  ]);
  let profileSequence = 0;
  let auditSequence = 0;
  let eventSequence = 0;
  const authority = createTenantAdministrationAuthority({
    sessions: {
      async authenticateSession(token) {
        const context = contexts.get(token.replace("-revoke-race", ""));
        if (context === undefined) throw Object.assign(new Error("invalid_token"), { status: 401 });
        if (token.endsWith("-revoke-race")) {
          database.prepare("UPDATE session_families SET revoked_at = ? WHERE family_id = ?")
            .run(NOW_MS, context.sessionFamilyId);
        }
        return context;
      },
    },
    repository: createSqliteTenantAdministrationRepository({
      database,
      nowMs: () => NOW_MS,
      ...(options.profileAssignmentFanoutLimit === undefined ? {} : {
        profileAssignmentFanoutLimit: options.profileAssignmentFanoutLimit,
      }),
    }),
    providerDisclosure: () => ({
      providerId: "openai-responses", modelId: "gpt-5",
      credentialReadiness: options.credentialReadiness ?? "noauth",
    }),
    capabilities: ["room.project.read", "room.respond"],
    tools: ["repository.git-status", "room-memory.read"],
    clock: () => NOW,
    profileIdFactory: () => `profile-${++profileSequence}`,
    actorIdFactory: () => `agent-${profileSequence}`,
    auditIdFactory: () => `audit-${++auditSequence}`,
    profileEventIdFactory: () => `event-${++eventSequence}`,
  });
  return { authority, database, databasePath };
}

async function createProfile(f: ReturnType<typeof fixture>) {
  await f.authority.bootstrapFromOwnerConfiguration({
    principalIds: ["human-owner"], configurationDigest: DIGEST,
  });
  return f.authority.createProfile(context("create"), {
    expectedRevision: 0,
    displayName: "Researcher",
    globalResponsibility: "Verify source evidence",
    capabilityCeiling: ["room.project.read", "room.respond"],
    toolCeiling: ["repository.git-status", "room-memory.read"],
  });
}

function seedAssignments(
  database: DatabaseSync,
  profile: Awaited<ReturnType<typeof createProfile>>["profile"],
  count: number,
): void {
  for (let index = 1; index <= count; index += 1) {
    const roomId = `room-${index}`;
    const assignmentId = `assignment-${index}`;
    database.prepare(
      `INSERT INTO rooms (id, name, status, created_at)
       VALUES (?, ?, 'active', ?)`,
    ).run(roomId, `Room body sentinel ${index}`, NOW);
    database.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, 'human-owner', 'human', 'member', NULL, '[]', ?, NULL, 0)`,
    ).run(roomId, NOW);
    database.prepare(
      `UPDATE rooms SET owner_actor_id = 'human-owner', governance_revision = ?
       WHERE id = ?`,
    ).run(index, roomId);
    database.prepare(
      `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
       VALUES ('room', ?, 0, 1)`,
    ).run(roomId);
    database.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, 'agent', NULL, 'active', ?, NULL, ?, ?)`,
    ).run(roomId, profile.actorId, JSON.stringify(profile.toolCeiling), NOW, index);
    database.prepare(
      `INSERT INTO room_agent_assignments (
         id, room_id, profile_id, agent_actor_id, revision, status, participation,
         paused, capability_subset_json, tool_subset_json, room_responsibility,
         created_at, updated_at, removed_at, source_kind
       ) VALUES (?, ?, ?, ?, 1, 'current', 'active', 0, ?, ?, ?, ?, ?, NULL,
         'room_command')`,
    ).run(assignmentId, roomId, profile.profileId, profile.actorId,
      JSON.stringify(profile.capabilityCeiling), JSON.stringify(profile.toolCeiling),
      `Room responsibility ${index}`, NOW, NOW);
    database.prepare(
      `INSERT INTO room_agent_assignment_revisions (
         assignment_id, revision, room_id, profile_id, agent_actor_id,
         room_responsibility, status, participation, paused, capability_subset_json,
         tool_subset_json, changed_by_human_actor_id, changed_at, operation
       ) VALUES (?, 1, ?, ?, ?, ?, 'current', 'active', 0, ?, ?,
         'human-owner', ?, 'create')`,
    ).run(assignmentId, roomId, profile.profileId, profile.actorId,
      `Room responsibility ${index}`, JSON.stringify(profile.capabilityCeiling),
      JSON.stringify(profile.toolCeiling), NOW);
  }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const context = (idempotencyKey: string, accessToken = "owner-token") => ({
  accessToken, requestId: `request-${idempotencyKey}`, idempotencyKey,
});

describe("SQLite Tenant Administrator and Global Profile repository", () => {
  it("persists bootstrap/add/remove CAS with immutable revisions and blocks non-admin and last-admin removal", async () => {
    const { authority, database } = fixture();
    await authority.bootstrapFromOwnerConfiguration({
      principalIds: ["human-owner"], configurationDigest: DIGEST,
    });
    await expect(authority.listAdministrators("member-token"))
      .rejects.toMatchObject({ status: 403, code: "administrator_required" });
    const added = await authority.addAdministrator(context("add"), {
      targetPrincipalId: "human-admin", expectedRevision: 1,
    });
    expect(added.registry).toMatchObject({ revision: 2,
      principalIds: ["human-admin", "human-owner"] });
    await authority.removeAdministrator(context("remove", "admin-token"), {
      targetPrincipalId: "human-owner", expectedRevision: 2,
    });
    await expect(authority.removeAdministrator(context("last", "admin-token"), {
      targetPrincipalId: "human-admin", expectedRevision: 3,
    })).rejects.toMatchObject({ status: 409, code: "last_administrator_required" });
    expect(database.prepare(
      "SELECT operation, status FROM tenant_administrator_revisions ORDER BY changed_at, human_actor_id, revision",
    ).all()).toEqual(expect.arrayContaining([
      { operation: "bootstrap", status: "active" },
      { operation: "add", status: "active" },
      { operation: "remove", status: "removed" },
    ]));
    await expect(authority.listAdministrators("admin-token-revoke-race"))
      .rejects.toMatchObject({ status: 403, code: "session_revoked" });
  });

  it("durably creates/updates/transitions a stable Agent and replays without duplicate audit/revision", async () => {
    const { authority, database } = fixture();
    await authority.bootstrapFromOwnerConfiguration({
      principalIds: ["human-owner"], configurationDigest: DIGEST,
    });
    const input = {
      expectedRevision: 0 as const,
      displayName: "Researcher",
      globalResponsibility: "Verify source evidence",
      capabilityCeiling: ["room.project.read", "room.respond"],
      toolCeiling: ["repository.git-status", "room-memory.read"],
    };
    const created = await authority.createProfile(context("create"), input);
    const replay = await authority.createProfile(context("create"), input);
    expect(replay).toEqual(created);
    const updated = await authority.updateProfile(context("update"), {
      profileId: created.profile.profileId, expectedRevision: 1,
      displayName: "Evidence Researcher", globalResponsibility: "Verify durable evidence",
      capabilityCeiling: ["room.project.read"], toolCeiling: ["room-memory.read"],
    });
    await authority.disableProfile(context("disable"), {
      profileId: updated.profile.profileId, expectedRevision: 2,
    });
    const enabled = await authority.enableProfile(context("enable"), {
      profileId: updated.profile.profileId, expectedRevision: 3,
    });
    expect(enabled.profile).toMatchObject({ actorId: created.profile.actorId,
      revision: 4, status: "enabled" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM agent_profile_revisions WHERE profile_id = ?",
    ).get(created.profile.profileId)).toEqual({ count: 4 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM deployment_audit WHERE subject_kind = 'agent_profile'",
    ).get()).toEqual({ count: 4 });
    expect(database.prepare(
      "SELECT head_seq AS headSeq, retained_from_seq AS retainedFromSeq FROM deployment_stream",
    ).get()).toEqual({ headSeq: 4, retainedFromSeq: 1 });
    expect(database.prepare(
      `SELECT event_kind AS eventKind, profile_revision AS revision
       FROM deployment_agent_profile_events ORDER BY stream_seq`,
    ).all()).toEqual([
      { eventKind: "profile.created", revision: 1 },
      { eventKind: "profile.updated", revision: 2 },
      { eventKind: "profile.disabled", revision: 3 },
      { eventKind: "profile.enabled", revision: 4 },
    ]);
    expect(database.prepare(
      `SELECT profile_revision AS revision, record_version AS recordVersion
       FROM deployment_agent_profile_repair_records WHERE profile_id = ?`,
    ).get(created.profile.profileId)).toEqual({ revision: 4, recordVersion: 1 });
    expect(database.prepare(
      `SELECT from_revision AS fromRevision, to_revision AS toRevision, reason,
              invalidated_context_count AS contextCount,
              cancelled_route_intent_count AS routeCount,
              affected_assignment_count AS assignmentCount
       FROM agent_profile_invalidation_facts ORDER BY to_revision`,
    ).all()).toEqual([
      { fromRevision: 1, toRevision: 2, reason: "profile_updated",
        contextCount: 0, routeCount: 0, assignmentCount: 0 },
      { fromRevision: 2, toRevision: 3, reason: "profile_disabled",
        contextCount: 0, routeCount: 0, assignmentCount: 0 },
      { fromRevision: 3, toRevision: 4, reason: "profile_enabled",
        contextCount: 0, routeCount: 0, assignmentCount: 0 },
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM deployment_profile_outbox",
    ).get()).toEqual({ count: 4 });
    const durablePayloads = database.prepare(
      `SELECT payload_json AS payload FROM deployment_agent_profile_events
       UNION ALL
       SELECT projection_json AS payload FROM deployment_agent_profile_repair_records`,
    ).all() as unknown as readonly { readonly payload: string }[];
    expect(JSON.stringify(durablePayloads)).not.toMatch(
      /roomId|roomName|message|member|assignment|secret|credential|apiKey|authorization|token/i,
    );
    expect(database.prepare(
      "SELECT display_name AS displayName FROM actors WHERE id = ?",
    ).get(created.profile.actorId)).toEqual({ displayName: "Evidence Researcher" });
    const query = await authority.queryProfiles("owner-token");
    expect(query.provider).toEqual({ providerId: "openai-responses", modelId: "gpt-5",
      credentialReadiness: "noauth" });
    expect(Object.keys(query)).toEqual(["profiles", "provider"]);
    expect(Object.keys(query.profiles[0]!).sort()).toEqual([
      "actorId", "capabilityCeiling", "createdAt", "displayName", "globalResponsibility",
      "profileId", "revision", "status", "toolCeiling", "updatedAt",
    ]);
    expect(JSON.stringify(query)).not.toMatch(/roomId|messageId|memberId|goalId|assignmentId|secret/i);
    expect(database.prepare(
      "SELECT DISTINCT details_json AS details FROM deployment_audit",
    ).all()).toEqual([{ details: "{}" }]);
    expect(() => database.exec("UPDATE deployment_audit SET details_json = '{\"forged\":true}'"))
      .toThrow(/deployment audit is immutable/i);
    expect(() => database.exec("DELETE FROM deployment_audit"))
      .toThrow(/deployment audit is immutable/i);
    expect(() => database.exec("DELETE FROM deployment_agent_profile_events"))
      .toThrow(/deployment Profile event is immutable/i);
    expect(() => database.exec("DELETE FROM agent_profile_invalidation_facts"))
      .toThrow(/Profile invalidation facts are immutable/i);
  });

  it("binds idempotency replay to the authenticated administrator principal", async () => {
    const { authority } = fixture();
    await authority.bootstrapFromOwnerConfiguration({
      principalIds: ["human-admin", "human-owner"], configurationDigest: DIGEST,
    });
    const input = {
      expectedRevision: 0 as const, displayName: "Researcher",
      globalResponsibility: "Verify source evidence", capabilityCeiling: [], toolCeiling: [],
    };
    await authority.createProfile(context("shared"), input);
    await expect(authority.createProfile(context("shared", "admin-token"), input))
      .rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
  });

  it.each([
    { affected: 0, succeeds: true },
    { affected: 1, succeeds: true },
    { affected: 2, succeeds: true },
    { affected: 3, succeeds: false },
  ])("bounds Profile fan-out before writes for $affected current Assignments", async ({
    affected, succeeds,
  }) => {
    const f = fixture({ profileAssignmentFanoutLimit: 2 });
    const created = await createProfile(f);
    seedAssignments(f.database, created.profile, affected);
    const before = {
      audit: f.database.prepare("SELECT COUNT(*) AS count FROM deployment_audit").get(),
      deploymentEvents: f.database.prepare(
        "SELECT COUNT(*) AS count FROM deployment_agent_profile_events",
      ).get(),
      deploymentOutbox: f.database.prepare(
        "SELECT COUNT(*) AS count FROM deployment_profile_outbox",
      ).get(),
      roomEvents: f.database.prepare("SELECT COUNT(*) AS count FROM events").get(),
      roomOutbox: f.database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get(),
      roomAudit: f.database.prepare("SELECT COUNT(*) AS count FROM room_audit").get(),
      invalidations: f.database.prepare(
        "SELECT COUNT(*) AS count FROM agent_profile_invalidation_facts",
      ).get(),
    };
    const operation = f.authority.updateProfile(context("fanout-update"), {
      profileId: created.profile.profileId,
      expectedRevision: 1,
      displayName: "Bounded Researcher",
      globalResponsibility: "Verify bounded durable evidence",
      capabilityCeiling: ["room.project.read"],
      toolCeiling: ["room-memory.read"],
    });
    if (!succeeds) {
      await expect(operation).rejects.toMatchObject({
        status: 429,
        code: "profile_fanout_capacity_limited",
      });
      expect(f.database.prepare(
        "SELECT revision, display_name AS displayName FROM agent_profiles WHERE id = ?",
      ).get(created.profile.profileId)).toEqual({ revision: 1, displayName: "Researcher" });
      expect(f.database.prepare(
        "SELECT id, revision, capability_subset_json AS capabilities FROM room_agent_assignments ORDER BY id",
      ).all()).toEqual(Array.from({ length: affected }, (_, index) => ({
        id: `assignment-${index + 1}`,
        revision: 1,
        capabilities: '["room.project.read","room.respond"]',
      })));
      expect({
        audit: f.database.prepare("SELECT COUNT(*) AS count FROM deployment_audit").get(),
        deploymentEvents: f.database.prepare(
          "SELECT COUNT(*) AS count FROM deployment_agent_profile_events",
        ).get(),
        deploymentOutbox: f.database.prepare(
          "SELECT COUNT(*) AS count FROM deployment_profile_outbox",
        ).get(),
        roomEvents: f.database.prepare("SELECT COUNT(*) AS count FROM events").get(),
        roomOutbox: f.database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get(),
        roomAudit: f.database.prepare("SELECT COUNT(*) AS count FROM room_audit").get(),
        invalidations: f.database.prepare(
          "SELECT COUNT(*) AS count FROM agent_profile_invalidation_facts",
        ).get(),
      }).toEqual(before);
      return;
    }
    await expect(operation).resolves.toMatchObject({ profile: { revision: 2 } });
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.agent-assignment.changed'",
    ).get()).toEqual({ count: affected });
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE id LIKE 'profile-room-outbox-%'",
    ).get()).toEqual({ count: affected });
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM room_audit WHERE details_json LIKE '%profile-fanout%'",
    ).get()).toEqual({ count: affected });
    expect(f.database.prepare(
      "SELECT affected_assignment_count AS count FROM agent_profile_invalidation_facts WHERE to_revision = 2",
    ).get()).toEqual({ count: affected });
  });

  it("atomically intersects two Room Assignment ceilings and emits closed Room repair facts", async () => {
    const f = fixture({ profileAssignmentFanoutLimit: 2, credentialReadiness: "ready" });
    const created = await createProfile(f);
    seedAssignments(f.database, created.profile, 2);

    const updated = await f.authority.updateProfile(context("two-room-reduction"), {
      profileId: created.profile.profileId,
      expectedRevision: 1,
      displayName: "Evidence Researcher",
      globalResponsibility: "Verify durable evidence",
      capabilityCeiling: ["room.project.read"],
      toolCeiling: ["room-memory.read"],
    });
    expect(updated.profile).toMatchObject({ revision: 2, actorId: created.profile.actorId });
    expect(f.database.prepare(
      `SELECT id, revision, capability_subset_json AS capabilities,
              tool_subset_json AS tools, updated_at AS updatedAt
       FROM room_agent_assignments ORDER BY id`,
    ).all()).toEqual([
      { id: "assignment-1", revision: 2, capabilities: '["room.project.read"]',
        tools: '["room-memory.read"]', updatedAt: NOW },
      { id: "assignment-2", revision: 2, capabilities: '["room.project.read"]',
        tools: '["room-memory.read"]', updatedAt: NOW },
    ]);
    expect(f.database.prepare(
      `SELECT assignment_id AS assignmentId, revision, operation
       FROM room_agent_assignment_revisions WHERE revision = 2 ORDER BY assignment_id`,
    ).all()).toEqual([
      { assignmentId: "assignment-1", revision: 2, operation: "update" },
      { assignmentId: "assignment-2", revision: 2, operation: "update" },
    ]);
    const eventRows = f.database.prepare(
      `SELECT room_id AS roomId, actor_id AS actorId, payload_json AS payload
       FROM events WHERE event_type = 'room.agent-assignment.changed' ORDER BY room_id`,
    ).all() as unknown as readonly { roomId: string; actorId: string; payload: string }[];
    expect(eventRows).toHaveLength(2);
    for (const [index, row] of eventRows.entries()) {
      expect(row.actorId).toBe(created.profile.actorId);
      expect(JSON.parse(row.payload)).toEqual({
        change: "upserted",
        roomRevision: index + 1,
        assignment: {
          recordVersion: "room-agent-assignment.v1",
          assignmentId: `assignment-${index + 1}`,
          roomId: `room-${index + 1}`,
          profileId: created.profile.profileId,
          actorId: created.profile.actorId,
          displayName: "Evidence Researcher",
          globalResponsibility: "Verify durable evidence",
          roomResponsibility: `Room responsibility ${index + 1}`,
          participation: "active",
          availability: "ready",
          paused: false,
          capabilityCeiling: ["room.project.read"],
          capabilitySubset: ["room.project.read"],
          effectiveCapabilities: ["room.project.read"],
          toolCeiling: ["room-memory.read"],
          toolSubset: ["room-memory.read"],
          effectiveTools: ["room-memory.read"],
          profileRevision: 2,
          assignmentRevision: 2,
          accessRevision: index + 1,
          updatedAt: NOW,
        },
      });
      expect(row.payload).not.toMatch(/Room body sentinel|secret|credential|apiKey|authorization/i);
    }
  });

  it("converges rename, disable, enable and replay in every affected Room without identity drift", async () => {
    const f = fixture({ profileAssignmentFanoutLimit: 2, credentialReadiness: "noauth" });
    const created = await createProfile(f);
    seedAssignments(f.database, created.profile, 2);
    const renameCommand = {
      profileId: created.profile.profileId,
      expectedRevision: 1,
      displayName: "Renamed Researcher",
      globalResponsibility: created.profile.globalResponsibility,
      capabilityCeiling: created.profile.capabilityCeiling,
      toolCeiling: created.profile.toolCeiling,
    };
    const renamed = await f.authority.updateProfile(context("rename"), renameCommand);
    await expect(f.authority.updateProfile(context("rename"), renameCommand)).resolves.toEqual(renamed);
    await f.authority.disableProfile(context("disable"), {
      profileId: created.profile.profileId, expectedRevision: 2,
    });
    await f.authority.enableProfile(context("enable"), {
      profileId: created.profile.profileId, expectedRevision: 3,
    });
    expect(f.database.prepare(
      "SELECT display_name AS displayName FROM actors WHERE id = ?",
    ).get(created.profile.actorId)).toEqual({ displayName: "Renamed Researcher" });
    expect(f.database.prepare(
      "SELECT id, revision FROM room_agent_assignments ORDER BY id",
    ).all()).toEqual([
      { id: "assignment-1", revision: 4 },
      { id: "assignment-2", revision: 4 },
    ]);
    const changes = f.database.prepare(
      `SELECT room_id AS roomId, stream_seq AS streamSeq, payload_json AS payload
       FROM events WHERE event_type = 'room.agent-assignment.changed'
       ORDER BY room_id, stream_seq`,
    ).all() as unknown as readonly { roomId: string; streamSeq: number; payload: string }[];
    expect(changes).toHaveLength(6);
    for (const roomId of ["room-1", "room-2"]) {
      const roomChanges = changes.filter((change) => change.roomId === roomId)
        .map((change) => JSON.parse(change.payload) as Record<string, unknown>);
      expect(roomChanges.map((change) => change.change)).toEqual([
        "upserted", "removed", "upserted",
      ]);
      expect(roomChanges[0]).toMatchObject({ assignment: {
        actorId: created.profile.actorId, displayName: "Renamed Researcher",
        availability: "noauth", profileRevision: 2, assignmentRevision: 2,
      } });
      expect(roomChanges[1]).toMatchObject({
        actorId: created.profile.actorId, assignmentRevision: 3,
      });
      expect(roomChanges[2]).toMatchObject({ assignment: {
        actorId: created.profile.actorId, displayName: "Renamed Researcher",
        availability: "noauth", profileRevision: 4, assignmentRevision: 4,
      } });
    }
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM deployment_agent_profile_events",
    ).get()).toEqual({ count: 4 });
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM events",
    ).get()).toEqual({ count: 6 });
  });

  it("rolls Profile, Assignment, audit, event, outbox, repair and replay back on fan-out failure", async () => {
    const f = fixture({ profileAssignmentFanoutLimit: 2 });
    const created = await createProfile(f);
    seedAssignments(f.database, created.profile, 1);
    f.database.exec(`CREATE TRIGGER fail_profile_room_outbox
      BEFORE INSERT ON outbox_deliveries
      WHEN NEW.id LIKE 'profile-room-outbox-%'
      BEGIN SELECT RAISE(ABORT, 'injected profile room outbox failure'); END`);
    await expect(f.authority.updateProfile(context("rollback"), {
      profileId: created.profile.profileId,
      expectedRevision: 1,
      displayName: "Must Roll Back",
      globalResponsibility: "Must roll back every authority fact",
      capabilityCeiling: ["room.project.read"],
      toolCeiling: ["room-memory.read"],
    })).rejects.toThrow(/injected profile room outbox failure/i);
    expect(f.database.prepare(
      "SELECT revision, display_name AS displayName FROM agent_profiles WHERE id = ?",
    ).get(created.profile.profileId)).toEqual({ revision: 1, displayName: "Researcher" });
    expect(f.database.prepare(
      `SELECT revision, capability_subset_json AS capabilities,
              tool_subset_json AS tools FROM room_agent_assignments`,
    ).get()).toEqual({ revision: 1,
      capabilities: '["room.project.read","room.respond"]',
      tools: '["repository.git-status","room-memory.read"]' });
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM room_agent_assignment_revisions",
    ).get()).toEqual({ count: 1 });
    expect(f.database.prepare("SELECT head_seq AS headSeq FROM streams WHERE stream_kind = 'room'").get())
      .toEqual({ headSeq: 0 });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM room_audit").get()).toEqual({ count: 0 });
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM deployment_agent_profile_events",
    ).get()).toEqual({ count: 1 });
    expect(f.database.prepare(
      `SELECT profile_revision AS revision
       FROM deployment_agent_profile_repair_records WHERE profile_id = ?`,
    ).get(created.profile.profileId)).toEqual({ revision: 1 });
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM deployment_audit WHERE subject_kind = 'agent_profile'",
    ).get()).toEqual({ count: 1 });
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM agent_profile_invalidation_facts",
    ).get()).toEqual({ count: 0 });
    expect(f.database.prepare(
      "SELECT COUNT(*) AS count FROM deployment_idempotency_records WHERE idempotency_key = 'rollback'",
    ).get()).toEqual({ count: 0 });
  });

  it("retains fan-out repair authority across WAL close and reopen", async () => {
    const f = fixture({ profileAssignmentFanoutLimit: 2, credentialReadiness: "ready" });
    expect(f.database.prepare("PRAGMA journal_mode = WAL").get()).toEqual({ journal_mode: "wal" });
    const created = await createProfile(f);
    seedAssignments(f.database, created.profile, 2);
    await f.authority.updateProfile(context("wal-restart"), {
      profileId: created.profile.profileId,
      expectedRevision: 1,
      displayName: "Restarted Researcher",
      globalResponsibility: "Survive WAL restart",
      capabilityCeiling: ["room.project.read"],
      toolCeiling: ["room-memory.read"],
    });
    const trackedIndex = databases.indexOf(f.database);
    if (trackedIndex >= 0) databases.splice(trackedIndex, 1);
    f.database.close();
    const reopened = new DatabaseSync(f.databasePath);
    databases.push(reopened);
    expect(reopened.prepare(
      "SELECT revision, display_name AS displayName FROM agent_profiles WHERE id = ?",
    ).get(created.profile.profileId)).toEqual({ revision: 2, displayName: "Restarted Researcher" });
    expect(reopened.prepare(
      "SELECT id, revision, capability_subset_json AS capabilities FROM room_agent_assignments ORDER BY id",
    ).all()).toEqual([
      { id: "assignment-1", revision: 2, capabilities: '["room.project.read"]' },
      { id: "assignment-2", revision: 2, capabilities: '["room.project.read"]' },
    ]);
    expect(reopened.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE event_type = 'room.agent-assignment.changed'`,
    ).get()).toEqual({ count: 2 });
    expect(reopened.prepare(
      "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE status = 'pending'",
    ).get()).toEqual({ count: 2 });
    expect(reopened.prepare(
      "SELECT affected_assignment_count AS count FROM agent_profile_invalidation_facts",
    ).get()).toEqual({ count: 2 });
  });
});
