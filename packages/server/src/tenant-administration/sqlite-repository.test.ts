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

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dao-tenant-administration-"));
  directories.push(directory);
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
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
    repository: createSqliteTenantAdministrationRepository({ database, nowMs: () => NOW_MS }),
    providerDisclosure: () => ({
      providerId: "openai-responses", modelId: "gpt-5", credentialReadiness: "noauth",
    }),
    capabilities: ["room.project.read", "room.respond"],
    tools: ["repository.git-status", "room-memory.read"],
    clock: () => NOW,
    profileIdFactory: () => `profile-${++profileSequence}`,
    actorIdFactory: () => `agent-${profileSequence}`,
    auditIdFactory: () => `audit-${++auditSequence}`,
    profileEventIdFactory: () => `event-${++eventSequence}`,
  });
  return { authority, database };
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
});
