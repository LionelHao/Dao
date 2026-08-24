import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSyncService } from "../sync-service.js";
import {
  createWorkerDatabaseClient,
  type CompleteWorkerDatabaseClient,
} from "../persistence/worker-database-client.js";
import { WorkerAgentSettingsAdapter } from "./worker-agent-settings-adapter.js";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const directories: string[] = [];
const clients: CompleteWorkerDatabaseClient[] = [];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function open(databasePath: string) {
  const worker = await createWorkerDatabaseClient({
    databasePath,
    deploymentProviderDisclosure: {
      providerId: "openai-responses", modelId: "gpt-5", credentialReadiness: "ready",
    },
  });
  clients.push(worker);
  return worker;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("WorkerAgentSettingsAdapter production composition", () => {
  it("persists exact ACKs and converges Profile/Assignment sync and repair across WAL restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-ft07-agent-settings-"));
    directories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    let worker = await open(databasePath);
    await worker.registerActors([
      { id: "human-owner", kind: "human", displayName: "Owner", reachability: "online" },
      { id: "human-outsider", kind: "human", displayName: "Outsider", reachability: "online" },
    ]);
    async function session(actorId: string, accountId: string) {
      const accessTokenHash = hash(`${actorId}-access`);
      await worker.issueSession({ accountId, actorId, publicSessionId: `${actorId}-session`,
        device: { id: `${actorId}-device`, label: actorId, platform: "macos" },
        accessTokenHash, refreshTokenHash: hash(`${actorId}-refresh`),
        accessExpiresAt: NOW + 1_000_000, refreshExpiresAt: NOW + 2_000_000, now: NOW });
      return worker.authenticateSession(accessTokenHash, NOW);
    }
    const owner = await session("human-owner", "owner-account");
    const outsider = await session("human-outsider", "outsider-account");
    await worker.executeTenantAdministration({ version: 1,
      type: "tenant-administrator.bootstrap", principalIds: ["human-owner"],
      configurationSha256: "a".repeat(64), now: NOW });
    const room = await worker.executeHuman({ ...owner, kind: "human", requestId: "room-request",
      idempotencyKey: "room-key" }, { type: "room.create", payload: { name: "FT-07 Room" } }, NOW);
    const governance = await worker.readRoomGovernance(owner, room.aggregateId, NOW);
    const adapter = new WorkerAgentSettingsAdapter(worker, () => NOW);
    const profileCommand = { type: "agent-profile.create" as const,
      requestId: "profile-create", idempotencyKey: "profile-key", expectedProfileRevision: 0 as const,
      displayName: "Researcher", globalResponsibility: "Verify evidence",
      capabilityCeiling: ["room.respond"] as const, toolCeiling: ["room-memory.read"] as const };
    const profileAck = await adapter.executeMutation({ ...owner, kind: "human",
      requestId: profileCommand.requestId, idempotencyKey: profileCommand.idempotencyKey }, profileCommand);
    expect(profileAck).toMatchObject({ type: "agent-settings.ack", operation: "agent-profile.create",
      acceptedRevision: 1, eventIds: [expect.stringMatching(/^deployment-profile-event-/)],
      replayed: false });
    await expect(adapter.executeMutation({ ...owner, kind: "human",
      requestId: profileCommand.requestId, idempotencyKey: profileCommand.idempotencyKey }, profileCommand))
      .resolves.toEqual({ ...profileAck, replayed: true });
    const profiles = await adapter.executeQuery(owner,
      { type: "agent-profile.list", requestId: "profile-list" });
    expect(profiles).toMatchObject({ type: "agent-profile.catalog", catalogRevision: 1,
      profiles: [{ recordVersion: "agent-profile.v1" }] });
    if (profiles.type !== "agent-profile.catalog") throw new Error("Profile catalog unavailable");
    const profile = profiles.profiles[0]!;

    const assignmentCommand = { type: "room-agent-assignment.create" as const,
      requestId: "assignment-create", idempotencyKey: "assignment-key", roomId: room.aggregateId,
      profileId: profile.profileId, expectedRoomRevision: governance.governanceRevision,
      roomResponsibility: "Review this Room", participation: "on-mention" as const,
      capabilitySubset: ["room.respond"] as const, toolSubset: ["room-memory.read"] as const };
    const assignmentAck = await adapter.executeMutation({ ...owner, kind: "human",
      requestId: assignmentCommand.requestId, idempotencyKey: assignmentCommand.idempotencyKey },
    assignmentCommand);
    expect(assignmentAck).toMatchObject({ type: "agent-settings.ack",
      operation: "room-agent-assignment.create", acceptedRevision: 1,
      eventIds: [expect.stringMatching(/^assignment-event:/)], replayed: false });
    const catalog = await adapter.executeQuery(owner, { type: "room-agent-assignment.list",
      requestId: "assignment-list", roomId: room.aggregateId });
    expect(catalog).toMatchObject({ type: "room-agent-assignment.catalog", roomId: room.aggregateId,
      roomRevision: governance.governanceRevision + 1, assignments: [{ availability: "ready", paused: false,
        profileRevision: 1, assignmentRevision: 1, accessRevision: 0 }] });
    await expect(worker.listPendingOutbox(100, NOW + 1_000)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({
        event: expect.objectContaining({
          eventId: assignmentAck.eventIds[0],
          type: "room.agent-assignment.changed",
        }),
      })]),
    );

    const sync = createSyncService({ store: { async syncRoom() { throw new Error("unused"); } },
      agentSettings: adapter });
    await expect(sync.syncAgentProfiles(owner, "sync-absent"))
      .resolves.toMatchObject({ mode: "repair_required", reason: "cursor_absent", watermark: 1 });
    await expect(sync.syncAgentProfiles(owner, "sync-delta", 0, 10))
      .resolves.toMatchObject({ mode: "delta", nextCursor: 1, watermark: 1,
        events: [{ eventId: profileAck.eventIds[0], payload: { profile } }] });
    const profileRepair = await sync.repairAgentProfiles(owner, "profile-repair");
    const assignmentRepair = await sync.repairRoomAgentAssignments(
      owner, "assignment-repair", room.aggregateId);
    expect(profileRepair.profiles).toEqual([profile]);
    expect(assignmentRepair).toMatchObject({ watermark: 2,
      roomRevision: governance.governanceRevision + 1,
      assignments: [{ assignmentId: assignmentAck.type === "agent-settings.ack"
        ? expect.any(String) : "unreachable" }] });
    await expect(sync.repairAgentProfiles(outsider, "forbidden-profile"))
      .rejects.toMatchObject({ code: "administrator_required", status: 403 });
    await expect(sync.repairRoomAgentAssignments(outsider, "forbidden-room", room.aggregateId))
      .rejects.toMatchObject({ code: "room_forbidden", status: 403 });

    await worker.close();
    clients.splice(clients.indexOf(worker), 1);
    worker = await open(databasePath);
    const restarted = new WorkerAgentSettingsAdapter(worker, () => NOW);
    await expect(restarted.executeMutation({ ...owner, kind: "human",
      requestId: assignmentCommand.requestId, idempotencyKey: assignmentCommand.idempotencyKey },
    assignmentCommand)).resolves.toEqual({ ...assignmentAck, replayed: true });
    await expect(restarted.repairAgentProfiles(owner, "restart-profile-repair"))
      .resolves.toMatchObject({ watermark: 1, profiles: [profile] });
    await expect(restarted.repairRoomAgentAssignments(owner, "restart-room-repair", room.aggregateId))
      .resolves.toEqual({ ...assignmentRepair, requestId: "restart-room-repair" });

    await worker.close();
    clients.splice(clients.indexOf(worker), 1);
    const database = new DatabaseSync(databasePath);
    database.prepare(
      `UPDATE room_memberships SET tool_permissions_json = '[]'
       WHERE room_id = ? AND actor_id = ?`,
    ).run(room.aggregateId, profile.actorId);
    database.close();
    worker = await open(databasePath);
    const policyRestricted = new WorkerAgentSettingsAdapter(worker, () => NOW);
    await expect(policyRestricted.executeQuery(owner, {
      type: "room-agent-assignment.list", requestId: "membership-tool-policy", roomId: room.aggregateId,
    })).resolves.toMatchObject({ assignments: [{
      toolCeiling: ["room-memory.read"], toolSubset: ["room-memory.read"], effectiveTools: [],
    }] });
  });
});
