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
const DIGEST = "e".repeat(64);
const directories: string[] = [];
const clients: CompleteWorkerDatabaseClient[] = [];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dao-tenant-worker-"));
  directories.push(directory);
  const databasePath = join(directory, "authority.sqlite");
  const client = await createWorkerDatabaseClient({
    databasePath,
    deploymentProviderDisclosure: {
      providerId: "openai-responses", modelId: "gpt-5", credentialReadiness: "noauth" as const,
      retentionDisabled: true, selectionPolicy: "server-managed-single",
      disclosureRevision: 1, disclosedAt: "2026-08-24T08:00:00.000Z",
    },
  });
  clients.push(client);
  await client.registerActors([
    { id: "human-owner", kind: "human", displayName: "Owner", reachability: "online" },
    { id: "human-admin", kind: "human", displayName: "Admin", reachability: "online" },
  ]);
  const accessTokenHash = hash("owner-access");
  await client.issueSession({
    accountId: "owner-account", actorId: "human-owner", publicSessionId: "owner-public-session",
    device: { id: "owner-device", label: "Owner Mac", platform: "macos" },
    accessTokenHash, refreshTokenHash: hash("owner-refresh"),
    accessExpiresAt: NOW + 1_000_000, refreshExpiresAt: NOW + 2_000_000, now: NOW,
  });
  const session = await client.authenticateSession(accessTokenHash, NOW);
  return { client, session, accessTokenHash };
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Tenant administration AuthorityWorker integration", () => {
  it("forwards bootstrap/admin/Profile list-get-mutation through the v20 single writer with replay", async () => {
    const { client, session } = await fixture();
    const bootstrap = await client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.bootstrap", principalIds: ["human-owner"],
      configurationSha256: DIGEST, now: NOW,
    });
    expect(bootstrap).toEqual({ kind: "tenant-administrator-registry", registry: {
      revision: 1, principalIds: ["human-owner"], configurationDigest: DIGEST,
      updatedAt: "2026-08-24T08:00:00.000Z",
    } });
    await expect(client.executeTenantAdministration({
      version: 1, type: "provider-configuration.disclose", context: session, now: NOW,
    })).resolves.toEqual({ kind: "provider-configuration", provider: {
      providerId: "openai-responses", modelId: "gpt-5", credentialReadiness: "noauth",
      retentionDisabled: true, selectionPolicy: "server-managed-single",
      disclosureRevision: 1, disclosedAt: "2026-08-24T08:00:00.000Z",
    } });
    const context = { ...session, kind: "human" as const, requestId: "profile-create-request",
      idempotencyKey: "profile-create-key" };
    const operation = {
      version: 1 as const, type: "agent-profile.create" as const, context,
      expectedRevision: 0 as const, displayName: "Researcher",
      globalResponsibility: "Verify source evidence",
      capabilityCeiling: ["room.project.read", "room.respond"],
      toolCeiling: ["repository.git-status"], now: NOW,
    };
    const created = await client.executeTenantAdministration(operation);
    await expect(client.executeTenantAdministration(operation)).resolves.toEqual(created);
    expect(created.kind).toBe("agent-profile");
    if (created.kind !== "agent-profile") throw new Error("Profile was not created");
    const updated = await client.executeTenantAdministration({
      version: 1, type: "agent-profile.update",
      context: { ...session, kind: "human", requestId: "profile-update-request",
        idempotencyKey: "profile-update-key" },
      profileId: created.profile.profileId, expectedRevision: 1,
      displayName: "Evidence Researcher", globalResponsibility: "Verify durable evidence",
      capabilityCeiling: ["room.project.read"], toolCeiling: ["repository.git-status"], now: NOW,
    });
    expect(updated).toMatchObject({ kind: "agent-profile",
      profile: { revision: 2, status: "enabled" },
      provider: { credentialReadiness: "noauth" } });
    const disabled = await client.executeTenantAdministration({
      version: 1, type: "agent-profile.disable",
      context: { ...session, kind: "human", requestId: "profile-disable-request",
        idempotencyKey: "profile-disable-key" },
      profileId: created.profile.profileId, expectedRevision: 2, now: NOW,
    });
    expect(disabled).toMatchObject({ kind: "agent-profile",
      profile: { revision: 3, status: "disabled" },
      provider: { credentialReadiness: "noauth" } });
    const enabled = await client.executeTenantAdministration({
      version: 1, type: "agent-profile.enable",
      context: { ...session, kind: "human", requestId: "profile-enable-request",
        idempotencyKey: "profile-enable-key" },
      profileId: created.profile.profileId, expectedRevision: 3, now: NOW,
    });
    expect(enabled).toMatchObject({ kind: "agent-profile",
      profile: { revision: 4, status: "enabled" },
      provider: { credentialReadiness: "noauth" } });
    if (enabled.kind !== "agent-profile") throw new Error("Profile was not enabled");
    const listed = await client.executeTenantAdministration({
      version: 1, type: "agent-profile.list", context: session, now: NOW,
    });
    expect(listed).toMatchObject({ kind: "agent-profiles", profiles: [enabled.profile],
      provider: { providerId: "openai-responses", modelId: "gpt-5",
        credentialReadiness: "noauth", retentionDisabled: true,
        selectionPolicy: "server-managed-single", disclosureRevision: 1,
        disclosedAt: "2026-08-24T08:00:00.000Z" } });
    await expect(client.executeTenantAdministration({
      version: 1, type: "agent-profile.get", context: session,
      profileId: created.profile.profileId, now: NOW,
    })).resolves.toEqual(enabled);
    await expect(client.readActor(created.profile.actorId)).resolves.toMatchObject({
      id: created.profile.actorId, kind: "agent", readiness: "noauth",
    });
    await expect(client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.add",
      context: { ...session, kind: "human", requestId: "admin-add-request",
        idempotencyKey: "admin-add-key" },
      targetPrincipalId: "human-admin", expectedRevision: 1, now: NOW,
    })).resolves.toMatchObject({ kind: "tenant-administrator-registry",
      registry: { revision: 2, principalIds: ["human-admin", "human-owner"] } });
    await expect(client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.bootstrap", principalIds: ["human-owner"],
      configurationSha256: DIGEST, now: NOW,
    })).resolves.toMatchObject({ kind: "tenant-administrator-registry",
      registry: { revision: 2, principalIds: ["human-admin", "human-owner"] } });
  });

  it("rechecks revocation and closes credential mutation without an approved store as 503", async () => {
    const configured = await fixture();
    await expect(configured.client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.list", context: configured.session, now: NOW,
    })).rejects.toMatchObject({ code: "administrator_configuration_unavailable", status: 503 });
    await configured.client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.bootstrap", principalIds: ["human-owner"],
      configurationSha256: DIGEST, now: NOW,
    });
    await expect(configured.client.executeTenantAdministration({
      version: 1, type: "provider-configuration.mutate", context: configured.session, now: NOW,
    })).rejects.toMatchObject({ code: "configuration_unsupported", status: 503 });
    await configured.client.revokeSession(configured.accessTokenHash, NOW + 1);
    await expect(configured.client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.list", context: configured.session, now: NOW + 2,
    })).rejects.toMatchObject({ code: "session_revoked", status: 403 });
  });
});
