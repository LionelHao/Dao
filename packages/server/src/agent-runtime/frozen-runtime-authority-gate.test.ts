import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  FrozenRuntimeAuthorityError,
  requireFrozenRuntimeAuthority,
} from "./frozen-runtime-authority-gate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function installFixture(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE rooms (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    CREATE TABLE actors (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, readiness TEXT NOT NULL
    ) STRICT;
    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL, actor_id TEXT NOT NULL, kind TEXT NOT NULL,
      participation TEXT, access_revision INTEGER NOT NULL,
      tool_permissions_json TEXT NOT NULL,
      PRIMARY KEY (room_id, actor_id)
    ) STRICT;
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_profile_revisions (
      profile_id TEXT NOT NULL, revision INTEGER NOT NULL, actor_id TEXT NOT NULL,
      status TEXT NOT NULL, tool_ceiling_json TEXT NOT NULL,
      PRIMARY KEY (profile_id, revision)
    ) STRICT;
    CREATE TABLE room_agent_assignments (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      agent_actor_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
      participation TEXT NOT NULL, paused INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE room_agent_assignment_revisions (
      assignment_id TEXT NOT NULL, revision INTEGER NOT NULL, room_id TEXT NOT NULL,
      profile_id TEXT NOT NULL, agent_actor_id TEXT NOT NULL, status TEXT NOT NULL,
      participation TEXT NOT NULL, paused INTEGER NOT NULL,
      tool_subset_json TEXT NOT NULL, PRIMARY KEY (assignment_id, revision)
    ) STRICT;
    CREATE TABLE agent_invocation_intents (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL, origin_kind TEXT NOT NULL, lineage_id TEXT,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE direct_agent_invocation_authority_bindings (
      intent_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
      profile_revision INTEGER NOT NULL, assignment_id TEXT NOT NULL,
      assignment_revision INTEGER NOT NULL, access_revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE routed_agent_invocation_intents (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, source_message_id TEXT NOT NULL,
      target_agent_actor_id TEXT NOT NULL, profile_id TEXT NOT NULL,
      profile_revision INTEGER NOT NULL, assignment_id TEXT NOT NULL,
      assignment_revision INTEGER NOT NULL, access_revision INTEGER NOT NULL,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_executions (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_execution_intent_links (
      intent_id TEXT NOT NULL, execution_id TEXT NOT NULL
    ) STRICT;

    INSERT INTO rooms VALUES ('room-1', 'active');
    INSERT INTO actors VALUES ('agent-1', 'agent', 'ready');
    INSERT INTO room_memberships VALUES (
      'room-1', 'agent-1', 'agent', 'on-mention', 5,
      '["http-json.read","repository.git-status","room-memory.read","sandbox-file.write"]'
    );
    INSERT INTO agent_profiles VALUES ('profile-1', 'agent-1', 7, 'enabled');
    INSERT INTO agent_profile_revisions VALUES
      ('profile-1', 7, 'agent-1', 'enabled',
       '["repository.git-status","sandbox-file.write","room-memory.read","http-json.read"]');
    INSERT INTO room_agent_assignments VALUES
      ('assignment-1', 'room-1', 'profile-1', 'agent-1', 11,
       'current', 'on-mention', 0);
    INSERT INTO room_agent_assignment_revisions VALUES
      ('assignment-1', 11, 'room-1', 'profile-1', 'agent-1', 'current',
       'on-mention', 0,
       '["http-json.read","repository.git-status","room-memory.read","sandbox-file.write"]');
    INSERT INTO agent_invocation_intents VALUES
      ('direct-intent', 'room-1', 'message-1', 'agent-1', 'message_target', NULL, 'claimed'),
      ('routed-lineage', 'room-1', 'message-2', 'agent-1', 'legacy_runtime', 'routed-intent', 'claimed');
    INSERT INTO direct_agent_invocation_authority_bindings VALUES
      ('direct-intent', 'profile-1', 7, 'assignment-1', 11, 5);
    INSERT INTO routed_agent_invocation_intents VALUES
      ('routed-intent', 'room-1', 'message-2', 'agent-1',
       'profile-1', 7, 'assignment-1', 11, 5, 'claimed');
    INSERT INTO agent_executions VALUES
      ('direct-execution', 'room-1', 'agent-1'),
      ('routed-execution', 'room-1', 'agent-1');
    INSERT INTO agent_execution_intent_links VALUES
      ('direct-intent', 'direct-execution'),
      ('routed-lineage', 'routed-execution');
  `);
}

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  installFixture(database);
  return database;
}

function expectReason(database: DatabaseSync, executionId: string, reason: string): void {
  expect(() => requireFrozenRuntimeAuthority(database, executionId)).toThrowError(
    expect.objectContaining<FrozenRuntimeAuthorityError>({ reason }),
  );
}

describe("server-private frozen runtime Authority handoff gate", () => {
  it("retains all frozen effective tools for an on-mention direct handoff", () => {
    const database = fixture();
    expect(requireFrozenRuntimeAuthority(database, "direct-execution")).toEqual({
      origin: "direct",
      executionId: "direct-execution",
      intentId: "direct-intent",
      roomId: "room-1",
      actorId: "agent-1",
      profileId: "profile-1",
      profileRevision: 7,
      assignmentId: "assignment-1",
      assignmentRevision: 11,
      accessRevision: 5,
      participation: "on-mention",
      effectiveToolIds: [
        "repository.git-status", "sandbox-file.write", "room-memory.read", "http-json.read",
      ],
    });
    database.close();
  });

  it("reads routed frozen facts only from the routed handoff and requires active", () => {
    const database = fixture();
    database.exec(`
      DELETE FROM direct_agent_invocation_authority_bindings;
      UPDATE room_agent_assignments SET participation = 'active';
      UPDATE room_agent_assignment_revisions SET participation = 'active';
      UPDATE room_memberships SET participation = 'active';
    `);
    expect(requireFrozenRuntimeAuthority(database, "routed-execution")).toMatchObject({
      origin: "routed", intentId: "routed-intent", participation: "active",
    });
    database.exec(`UPDATE room_agent_assignments SET participation = 'on-mention'`);
    expectReason(database, "routed-execution", "assignment_inactive");
    database.close();
  });

  it.each([
    ["profile disable", "UPDATE agent_profiles SET status = 'disabled'", "profile_disabled"],
    ["profile reduction race", "UPDATE agent_profiles SET revision = 8", "profile_revision_stale"],
    ["Assignment remove", "UPDATE room_agent_assignments SET status = 'removed'", "assignment_removed"],
    ["Assignment pause", "UPDATE room_agent_assignments SET paused = 1", "assignment_paused"],
    ["Assignment revision race", "UPDATE room_agent_assignments SET revision = 12", "assignment_revision_stale"],
    ["membership revoke", "DELETE FROM room_memberships", "access_revoked"],
    ["membership participation race", "UPDATE room_memberships SET participation = 'active'", "assignment_inactive"],
    ["access revision race", "UPDATE room_memberships SET access_revision = 6", "access_revision_stale"],
    ["Room archived", "UPDATE rooms SET status = 'archived'", "room_inactive"],
  ])("fails closed after %s", (_label, mutation, reason) => {
    const database = fixture();
    database.exec(mutation);
    expectReason(database, "direct-execution", reason);
    database.close();
  });

  it("does not treat legacy mutable actor readiness as Provider authority", () => {
    const database = fixture();
    database.exec("UPDATE actors SET readiness = 'noauth'");
    expect(requireFrozenRuntimeAuthority(database, "direct-execution")).toMatchObject({
      origin: "direct", intentId: "direct-intent",
    });
    database.close();
  });

  it("intersects frozen Profile and Assignment tools with current membership policy", () => {
    const database = fixture();
    database.exec(`
      UPDATE room_memberships
      SET tool_permissions_json = '["repository.git-status","room-memory.read"]'
    `);
    expect(requireFrozenRuntimeAuthority(database, "direct-execution").effectiveToolIds)
      .toEqual(["repository.git-status", "room-memory.read"]);
    database.close();
  });

  it("fails closed when either origin lacks its own immutable handoff", () => {
    const database = fixture();
    database.exec("DELETE FROM direct_agent_invocation_authority_bindings");
    expectReason(database, "direct-execution", "handoff_missing");
    database.exec("UPDATE routed_agent_invocation_intents SET status = 'cancelled'");
    expectReason(database, "routed-execution", "handoff_missing");
    database.close();
  });

  it("replays the same frozen direct handoff after WAL close and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-frozen-runtime-gate-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "authority.sqlite");
    let database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL");
    installFixture(database);
    const before = requireFrozenRuntimeAuthority(database, "direct-execution");
    database.close();

    database = new DatabaseSync(path);
    expect(requireFrozenRuntimeAuthority(database, "direct-execution")).toEqual(before);
    database.close();
  });
});
