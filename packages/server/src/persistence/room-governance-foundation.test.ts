import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@native-im/core";
import { createAuthenticationService, type IdentityAdapter } from "../auth.js";
import { createSqliteAuthoritativeStore } from "./sqlite-authoritative-store.js";
import { createWorkerDatabaseClient } from "./worker-database-client.js";

const actors = ["owner", "target", "peer"].map((id) => ({
  id: `human-${id}`,
  kind: "human" as const,
  displayName: id,
  reachability: "online" as const,
})) satisfies readonly Actor[];

const identities: IdentityAdapter = {
  async verify(credentials) {
    const actor = actors.find((candidate) => credentials.accountId === `account-${candidate.id}`);
    return credentials.secret === "correct" && actor !== undefined
      ? { accountId: credentials.accountId, actorId: actor.id }
      : undefined;
  },
};

function tokenFactory(): () => string {
  let sequence = 0;
  return () => `governance-token-${sequence++}`;
}

function authorityCounts(databasePath: string): unknown {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      rooms: database.prepare(
        "SELECT owner_actor_id AS ownerActorId, governance_revision AS governanceRevision, status FROM rooms",
      ).all(),
      memberships: database.prepare(
        "SELECT actor_id AS actorId, kind, role, access_revision AS accessRevision FROM room_memberships ORDER BY actor_id",
      ).all(),
      audits: database.prepare("SELECT COUNT(*) AS count FROM room_audit").get(),
      events: database.prepare("SELECT COUNT(*) AS count FROM events").get(),
      outbox: database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get(),
      idempotency: database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get(),
    };
  } finally {
    database.close();
  }
}

describe("FT-02A room governance foundation", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "native-im-ft02a-"));
    directories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client, { clock: () => 2_000 });
    await authority.registerActors(actors);
    const auth = createAuthenticationService({
      actors: { getActor: (actorId) => actors.find((actor) => actor.id === actorId) },
      identities,
      authority,
      clock: () => 1_000,
      tokenFactory: tokenFactory(),
    });
    const sessions = new Map<string, Awaited<ReturnType<typeof auth.authenticateSession>>>();
    for (const actor of actors) {
      const issued = await auth.login({ accountId: `account-${actor.id}`, secret: "correct" });
      sessions.set(actor.id, await auth.authenticateSession(issued.accessToken));
    }
    const owner = sessions.get("human-owner")!;
    const created = await authority.executeHuman({
      ...owner, kind: "human", requestId: "create", idempotencyKey: "create",
    }, { type: "room.create", payload: { name: "Governance" } });
    await client.close();
    const database = new DatabaseSync(databasePath);
    const joinedAt = "2026-08-18T00:00:00.000Z";
    database.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 0)`,
    ).run(created.aggregateId, "human-target", joinedAt);
    database.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 0)`,
    ).run(created.aggregateId, "human-peer", joinedAt);
    database.close();
    const commandClient = await createWorkerDatabaseClient({ databasePath });
    const commandAuthority = createSqliteAuthoritativeStore(commandClient, { clock: () => 2_000 });
    return {
      authority: commandAuthority,
      client: commandClient,
      databasePath,
      roomId: created.aggregateId,
      sessions,
    };
  }

  it("transfers ownership atomically with CAS, idempotency, audit, event, outbox and Room=Project", async () => {
    const value = await fixture();
    const owner = value.sessions.get("human-owner")!;
    const context = {
      ...owner, kind: "human" as const, requestId: "transfer-1", idempotencyKey: "transfer-key",
    };
    const command = {
      type: "room.ownership.transfer" as const,
      roomId: value.roomId,
      payload: { targetActorId: "human-target", expectedGovernanceRevision: 1 },
    };
    const first = await value.authority.executeHuman(context, command);
    const replay = await value.authority.executeHuman({ ...context, requestId: "transfer-replay" }, command);
    expect(replay).toEqual(first);
    expect(await value.authority.readRoomGovernance(owner, value.roomId)).toEqual({
      roomId: value.roomId,
      projectId: value.roomId,
      lifecycle: "active",
      governanceRevision: 2,
      ownerActorId: "human-target",
      archiveGeneration: 0,
    });
    await value.client.close();
    const database = new DatabaseSync(value.databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_audit WHERE type = 'room.ownership.transferred'",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.governance.changed'",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE event_id IN (SELECT event_id FROM events WHERE event_type = 'room.governance.changed')",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM room_memberships WHERE kind = 'human' AND role = 'owner'",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    ).get()).toEqual({ count: 0 });
    database.close();
  });

  it("rejects stale role CAS with zero writes and forbids admin changes to owner or peer admin", async () => {
    const value = await fixture();
    const owner = value.sessions.get("human-owner")!;
    const ownerContext = { ...owner, kind: "human" as const };
    await value.authority.executeHuman({ ...ownerContext, requestId: "promote", idempotencyKey: "promote" }, {
      type: "room.member.role.set", roomId: value.roomId,
      payload: { targetActorId: "human-target", role: "admin", expectedGovernanceRevision: 1 },
    });
    const beforeStale = authorityCounts(value.databasePath);
    await expect(value.authority.executeHuman({
      ...ownerContext, requestId: "stale", idempotencyKey: "stale",
    }, {
      type: "room.member.role.set", roomId: value.roomId,
      payload: { targetActorId: "human-peer", role: "admin", expectedGovernanceRevision: 1 },
    })).rejects.toMatchObject({ status: 409, code: "room_revision_conflict" });
    expect(authorityCounts(value.databasePath)).toEqual(beforeStale);
    const admin = value.sessions.get("human-target")!;
    await expect(value.authority.executeHuman({
      ...admin, kind: "human", requestId: "admin-role", idempotencyKey: "admin-role",
    }, {
      type: "room.member.role.set", roomId: value.roomId,
      payload: { targetActorId: "human-owner", role: "member", expectedGovernanceRevision: 2 },
    })).rejects.toMatchObject({ status: 403, code: "role_forbidden" });
    expect(authorityCounts(value.databasePath)).toEqual(beforeStale);
    await value.client.close();
  });

  it("fails legacy departure and archive paths closed without authoritative writes", async () => {
    const value = await fixture();
    const owner = value.sessions.get("human-owner")!;
    const member = value.sessions.get("human-target")!;
    const before = authorityCounts(value.databasePath);
    await expect(value.authority.executeHuman({
      ...owner, kind: "human", requestId: "owner-leave", idempotencyKey: "owner-leave",
    }, {
      type: "room.member.leave", roomId: value.roomId, payload: { expectedGovernanceRevision: 1 },
    })).rejects.toMatchObject({ status: 409, code: "ownership_transfer_required" });
    await expect(value.authority.executeHuman({
      ...member, kind: "human", requestId: "member-leave", idempotencyKey: "member-leave",
    }, {
      type: "room.member.leave", roomId: value.roomId, payload: { expectedGovernanceRevision: 1 },
    })).rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
    for (const [requestId, command] of [
      ["remove", { type: "member.remove", roomId: value.roomId, payload: { targetActorId: "human-target" } }],
      ["archive", { type: "room.archive", roomId: value.roomId, payload: {} }],
      ["reopen", { type: "room.reopen", roomId: value.roomId, payload: { expectedGovernanceRevision: 1 } }],
    ] as const) {
      await expect(value.authority.executeHuman({
        ...owner, kind: "human", requestId, idempotencyKey: requestId,
      }, command)).rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
    }
    expect(authorityCounts(value.databasePath)).toEqual(before);
    await value.client.close();
  });
});
