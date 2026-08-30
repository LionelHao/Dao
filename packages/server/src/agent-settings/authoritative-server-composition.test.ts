import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startAuthoritativeServerForTest, type AuthoritativeServer } from "../authoritative-server.js";

const directories: string[] = [];
const servers: AuthoritativeServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => { sockets.push(socket); resolve(socket); });
    socket.once("error", reject);
  });
}

function request(socket: WebSocket, frame: Readonly<{ requestId: string }>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error(`Timed out waiting for ${frame.requestId}`));
    }, 10_000);
    const receive = (raw: Buffer): void => {
      const response = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (response.requestId !== frame.requestId) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(response);
    };
    socket.on("message", receive);
    socket.send(JSON.stringify(frame));
  });
}

async function login(socket: WebSocket, suffix: string): Promise<void> {
  await expect(request(socket, { type: "auth.login", requestId: `login-${suffix}`,
    accountId: "owner-account", secret: "owner-secret",
    device: { id: `device-${suffix}`, label: `Device ${suffix}`, platform: "macos" } } as never))
    .resolves.toMatchObject({ type: "auth.authenticated", actorId: "human-owner" });
}

describe("authoritative server FT-07 production composition", () => {
  it("serves real multi-client WS query/mutation/sync/repair instead of the closed 503 fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft07-production-ws-"));
    directories.push(directory);
    const server = await startAuthoritativeServerForTest({
      databasePath: join(directory, "authority.sqlite"),
      snapshotCachePath: join(directory, "snapshots.sqlite"),
      listen: { host: "127.0.0.1", port: 0 },
      actors: [{ id: "human-owner", kind: "human", displayName: "Owner",
        reachability: "online" }],
      identities: { async verify(credentials) {
        return credentials.accountId === "owner-account" && credentials.secret === "owner-secret"
          ? { accountId: "owner-account", actorId: "human-owner" } : undefined;
      } },
      invitationSecretKey: new Uint8Array(32).fill(19),
      sharedAuthority: { maxOfflineReadLeaseMs: 60_000 },
      tenantAdministration: { bootstrapHumanActorIds: ["human-owner"] },
    }, { toolAdapterPathFallbackForTest: true });
    servers.push(server);
    const writer = await connect(server.url);
    const reader = await connect(server.url);
    await Promise.all([login(writer, "writer"), login(reader, "reader")]);

    await expect(request(reader, { type: "tenant-administrator.list", requestId: "admins" } as never))
      .resolves.toMatchObject({ type: "tenant-administrator.registry",
        registry: { revision: 1, principalIds: ["human-owner"] } });
    const command = { type: "agent-profile.create", requestId: "profile-create",
      idempotencyKey: "profile-key", expectedProfileRevision: 0,
      displayName: "Researcher", globalResponsibility: "Verify production composition",
      capabilityCeiling: ["room.respond"], toolCeiling: ["room-memory.read"] } as const;
    const accepted = await request(writer, command);
    expect(accepted).toMatchObject({ type: "agent-settings.ack",
      operation: "agent-profile.create", acceptedRevision: 1,
      eventIds: [expect.stringMatching(/^deployment-profile-event-/)], replayed: false });
    await expect(request(writer, command)).resolves.toEqual({ ...accepted, replayed: true });
    await expect(request(reader, { type: "agent-profile.list", requestId: "profiles" } as never))
      .resolves.toMatchObject({ type: "agent-profile.catalog", catalogRevision: 1,
        profiles: [{ recordVersion: "agent-profile.v1", displayName: "Researcher" }] });
    await expect(request(reader, { type: "agent-profile.sync", requestId: "profile-sync",
      afterSeq: 0, limit: 10 } as never)).resolves.toMatchObject({
        type: "agent-profile.sync.result", mode: "delta", nextCursor: 1,
        events: [{ eventId: (accepted.eventIds as string[])[0] }],
      });
    await expect(request(reader,
      { type: "agent-profile.repair", requestId: "profile-repair" } as never))
      .resolves.toMatchObject({ type: "agent-profile.repair.snapshot", watermark: 1,
        profiles: [{ displayName: "Researcher" }] });
  });
});
