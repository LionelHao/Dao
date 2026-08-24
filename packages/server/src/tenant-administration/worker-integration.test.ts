import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthorityWorkerClientError,
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

async function fixture(withProvider = true) {
  const directory = mkdtempSync(join(tmpdir(), "dao-tenant-worker-"));
  directories.push(directory);
  const databasePath = join(directory, "authority.sqlite");
  const client = await createWorkerDatabaseClient({
    databasePath,
    ...(withProvider ? { deploymentProviderDisclosure: {
      providerId: "openai-responses", modelId: "gpt-5", credentialReadiness: "noauth" as const,
    } } : {}),
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
  return { client, session, accessTokenHash, databasePath };
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
    const context = { ...session, kind: "human" as const, requestId: "profile-create-request",
      idempotencyKey: "profile-create-key" };
    const operation = {
      version: 1 as const, type: "agent-profile.create" as const, context,
      expectedRevision: 0 as const, displayName: "Researcher",
      globalResponsibility: "Verify source evidence",
      capabilityCeiling: ["room.project.read", "room.respond"],
      toolCeiling: ["repository.git-status", "room-memory.read"], now: NOW,
    };
    const created = await client.executeTenantAdministration(operation);
    await expect(client.executeTenantAdministration(operation)).resolves.toEqual(created);
    expect(created.kind).toBe("agent-profile");
    if (created.kind !== "agent-profile") throw new Error("Profile was not created");
    const listed = await client.executeTenantAdministration({
      version: 1, type: "agent-profile.list", context: session, now: NOW,
    });
    expect(listed).toMatchObject({ kind: "agent-profiles", profiles: [created.profile],
      provider: { providerId: "openai-responses", modelId: "gpt-5",
        credentialReadiness: "noauth" } });
    await expect(client.executeTenantAdministration({
      version: 1, type: "agent-profile.get", context: session,
      profileId: created.profile.profileId, now: NOW,
    })).resolves.toEqual(created);
    await expect(client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.add",
      context: { ...session, kind: "human", requestId: "admin-add-request",
        idempotencyKey: "admin-add-key" },
      targetPrincipalId: "human-admin", expectedRevision: 1, now: NOW,
    })).resolves.toMatchObject({ kind: "tenant-administrator-registry",
      registry: { revision: 2, principalIds: ["human-admin", "human-owner"] } });
  });

  it("rechecks revocation and closes unconfigured Provider and credential mutation as 503", async () => {
    const configured = await fixture();
    await configured.client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.bootstrap", principalIds: ["human-owner"],
      configurationSha256: DIGEST, now: NOW,
    });
    await expect(configured.client.executeTenantAdministration({
      version: 1, type: "provider-configuration.mutate", context: configured.session, now: NOW,
    })).rejects.toMatchObject({ code: "credential_mutation_unsupported", status: 503 });
    await configured.client.revokeSession(configured.accessTokenHash, NOW + 1);
    await expect(configured.client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.list", context: configured.session, now: NOW + 2,
    })).rejects.toMatchObject({ code: "session_revoked", status: 403 });

    const unconfigured = await fixture(false);
    await unconfigured.client.executeTenantAdministration({
      version: 1, type: "tenant-administrator.bootstrap", principalIds: ["human-owner"],
      configurationSha256: DIGEST, now: NOW,
    });
    const error = await unconfigured.client.executeTenantAdministration({
      version: 1, type: "provider-configuration.disclose", context: unconfigured.session, now: NOW,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AuthorityWorkerClientError);
    expect(error).toMatchObject({ code: "provider_configuration_unavailable", status: 503 });
    await expect(unconfigured.client.executeTenantAdministration({
      version: 1, type: "agent-profile.create",
      context: { ...unconfigured.session, kind: "human", requestId: "closed-create-request",
        idempotencyKey: "closed-create-key" },
      expectedRevision: 0, displayName: "Must not persist",
      globalResponsibility: "Provider is unavailable", capabilityCeiling: [],
      toolCeiling: [], now: NOW,
    })).rejects.toMatchObject({ code: "provider_configuration_unavailable", status: 503 });
    await unconfigured.client.close();
    clients.splice(clients.indexOf(unconfigured.client), 1);
    const recovered = await createWorkerDatabaseClient({
      databasePath: unconfigured.databasePath,
      deploymentProviderDisclosure: {
        providerId: "openai-responses", modelId: "gpt-5", credentialReadiness: "ready",
      },
    });
    clients.push(recovered);
    await expect(recovered.executeTenantAdministration({
      version: 1, type: "agent-profile.list", context: unconfigured.session, now: NOW,
    })).resolves.toMatchObject({ kind: "agent-profiles", profiles: [] });
  });
});
