import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkerDatabaseClient,
  type CompleteWorkerDatabaseClient,
} from "../persistence/worker-database-client.js";

const NOW = Date.parse("2026-08-24T08:00:00.000Z");
const directories: string[] = [];
const clients: CompleteWorkerDatabaseClient[] = [];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function createClient(databasePath: string): Promise<CompleteWorkerDatabaseClient> {
  const client = await createWorkerDatabaseClient({
    databasePath,
    deploymentProviderDisclosure: {
      providerId: "openai-responses", modelId: "gpt-5", credentialReadiness: "noauth",
    },
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Room Assignment AuthorityWorker integration", () => {
  it("commits, replays, queries, and reopens the v1 single-writer operation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-assignment-worker-"));
    directories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    let client = await createClient(databasePath);
    await client.registerActors([
      { id: "human-owner", kind: "human", displayName: "Owner", reachability: "online" },
    ]);
    const accessTokenHash = hash("owner-access");
    await client.issueSession({
      accountId: "owner-account", actorId: "human-owner", publicSessionId: "owner-public-session",
      device: { id: "owner-device", label: "Owner Mac", platform: "macos" },
      accessTokenHash, refreshTokenHash: hash("owner-refresh"),
      accessExpiresAt: NOW + 1_000_000, refreshExpiresAt: NOW + 2_000_000, now: NOW,
    });
    const session = await client.authenticateSession(accessTokenHash, NOW);
    const room = await client.executeHuman({
      ...session, kind: "human", requestId: "create-room-request",
      idempotencyKey: "create-room-key",
    }, { type: "room.create", payload: { name: "Assignment Room" } }, NOW);
    const roomId = room.aggregateId;
    await client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.bootstrap", principalIds: ["human-owner"],
      configurationSha256: "d".repeat(64), now: NOW,
    });
    const profile = await client.executeTenantAdministration({
      version: 1, type: "agent-profile.create",
      context: { ...session, kind: "human", requestId: "profile-request",
        idempotencyKey: "profile-key" },
      expectedRevision: 0, displayName: "Reviewer",
      globalResponsibility: "Review durable evidence",
      capabilityCeiling: ["room.respond"], toolCeiling: ["room-memory.read"], now: NOW,
    });
    if (profile.kind !== "agent-profile") throw new Error("Profile was not created");
    const governance = await client.readRoomGovernance(session, roomId, NOW);
    const operation = {
      version: 1 as const, type: "room-assignment.mutate" as const, context: session, now: NOW,
      request: {
        kind: "create" as const, requestId: "assignment-request", idempotencyKey: "assignment-key",
        roomId, expectedRoomRevision: governance.governanceRevision,
        profileId: profile.profile.profileId, participation: "on-mention" as const,
        roomResponsibility: "Review this Room", capabilitySubset: ["room.respond"],
        toolSubset: ["room-memory.read"],
      },
    };
    const created = await client.executeRoomAssignment(operation);
    await expect(client.executeRoomAssignment(operation)).resolves.toEqual(created);
    expect(created).toMatchObject({ kind: "room-assignment-command",
      acknowledgement: { acceptedRevision: 1, eventIds: [expect.any(String)] } });
    if (created.kind !== "room-assignment-command") throw new Error("Assignment was not created");
    await expect(client.executeRoomAssignment({
      version: 1, type: "room-assignment.get", context: session, roomId,
      assignmentId: created.acknowledgement.assignmentId, now: NOW,
    })).resolves.toMatchObject({ kind: "room-assignment",
      assignment: { participation: "on-mention", toolSubset: ["room-memory.read"] } });
    await expect(client.executeRoomAssignment({
      version: 1, type: "room-assignment.list", context: session, roomId, now: NOW,
    })).resolves.toMatchObject({ kind: "room-assignments", assignments: [{
      assignmentId: created.acknowledgement.assignmentId,
    }] });

    await client.close();
    clients.splice(clients.indexOf(client), 1);
    client = await createClient(databasePath);
    await expect(client.executeRoomAssignment(operation)).resolves.toEqual(created);
  });
});
