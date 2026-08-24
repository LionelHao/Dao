import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthoritativeServer } from "../authoritative-server.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function options(directory: string, bootstrapHumanActorIds: readonly string[]) {
  return {
    databasePath: join(directory, "authority.sqlite"),
    snapshotCachePath: join(directory, "snapshot.sqlite"),
    listen: { host: "127.0.0.1", port: 0 },
    actors: [
      { id: "human-owner", kind: "human", displayName: "Owner", reachability: "online" },
      { id: "human-other", kind: "human", displayName: "Other", reachability: "online" },
      { id: "agent-helper", kind: "agent", displayName: "Helper", readiness: "noauth",
        toolPermissions: ["repository.git-status"] },
    ] as const,
    identities: { async verify() { return undefined; } },
    invitationSecretKey: new Uint8Array(32).fill(27),
    sharedAuthority: { maxOfflineReadLeaseMs: 60_000 },
    tenantAdministration: { bootstrapHumanActorIds },
  } as const;
}

describe("authoritative server Tenant Administrator bootstrap composition", () => {
  it("seals explicit Human principals once and refuses a changed restart configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft07-admin-bootstrap-"));
    directories.push(directory);

    const first = await startAuthoritativeServer(options(directory, ["human-owner"]));
    await first.close();
    const replay = await startAuthoritativeServer(options(directory, ["human-owner"]));
    await replay.close();

    const database = new DatabaseSync(join(directory, "authority.sqlite"));
    try {
      expect(database.prepare(
        `SELECT human_actor_id AS actorId, revision, status, source_kind AS sourceKind
         FROM tenant_administrators ORDER BY human_actor_id`,
      ).all()).toEqual([{
        actorId: "human-owner",
        revision: 1,
        status: "active",
        sourceKind: "bootstrap",
      }]);
      expect(database.prepare(
        `SELECT event_kind AS eventKind, principal_human_actor_id AS actorId
         FROM deployment_audit ORDER BY occurred_at`,
      ).all()).toEqual([{ eventKind: "administrator.bootstrap", actorId: null }]);
    } finally {
      database.close();
    }

    await expect(startAuthoritativeServer(options(directory, ["human-other"])))
      .rejects.toMatchObject({ code: "bootstrap_conflict", status: 409 });
  });

  it("fails closed when deployment bootstrap names an Agent principal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft07-agent-admin-bootstrap-"));
    directories.push(directory);
    await expect(startAuthoritativeServer(options(directory, ["agent-helper"])))
      .rejects.toMatchObject({ code: "identity_forbidden", status: 403 });
  });
});
