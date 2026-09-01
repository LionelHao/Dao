import { describe, expect, it } from "vitest";
import {
  isTenantAdministrationOperation,
  isTenantAdministrationResult,
} from "./authority-protocol.js";
import {
  isAuthorityWorkerRequest,
  isAuthorityWorkerResponse,
} from "../persistence/worker-protocol.js";

const session = {
  sessionId: "session-1",
  sessionFamilyId: "family-1",
  principal: { accountId: "account-1", actorId: "human-1" },
};
const command = { ...session, kind: "human" as const, requestId: "command-1",
  idempotencyKey: "idempotency-1" };

describe("Tenant administration worker protocol", () => {
  it("accepts exact versioned operations and rejects identity, secret, provider, and Room injection", () => {
    const create = {
      version: 1 as const, type: "agent-profile.create" as const, context: command,
      expectedRevision: 0 as const, displayName: "Researcher",
      globalResponsibility: "Verify sources",
      capabilityCeiling: ["room.project.read", "room.respond"],
      toolCeiling: ["repository.git-status"], now: 1_000,
    };
    expect(isTenantAdministrationOperation(create)).toBe(true);
    for (const injected of [
      { actorId: "forged-agent" }, { roomId: "room-secret" }, { modelId: "forged-model" },
      { credential: "secret-sentinel" }, { availability: "ready" },
    ]) {
      expect(isTenantAdministrationOperation({ ...create, ...injected })).toBe(false);
    }
    expect(isTenantAdministrationOperation({
      version: 1, type: "provider-configuration.mutate", context: session, now: 1_000,
      credential: "secret-sentinel",
    })).toBe(false);
    expect(isTenantAdministrationOperation({ ...create, version: 2 })).toBe(false);
  });

  it("accepts only exact deployment-safe result shapes", () => {
    const provider = { providerId: "openai-responses", modelId: "gpt-5",
      credentialReadiness: "noauth" as const, retentionDisabled: true as const,
      selectionPolicy: "server-managed-single" as const, disclosureRevision: 1,
      disclosedAt: "2026-08-24T00:00:00.000Z" };
    const profile = {
      profileId: "profile-1", actorId: "agent-1", displayName: "Researcher",
      globalResponsibility: "Verify sources", status: "enabled" as const,
      capabilityCeiling: ["room.project.read"], toolCeiling: ["repository.git-status"],
      revision: 1, createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    expect(isTenantAdministrationResult({ kind: "agent-profile", profile, provider })).toBe(true);
    expect(isTenantAdministrationResult({ kind: "agent-profile", profile, provider,
      roomId: "room-secret" })).toBe(false);
    expect(isTenantAdministrationResult({ kind: "provider-configuration",
      provider: { ...provider, credential: "secret-sentinel" } })).toBe(false);
    for (const unsafeProvider of [
      { ...provider, retentionDisabled: false },
      { ...provider, selectionPolicy: "fallback-enabled" },
      { ...provider, disclosureRevision: 0 },
      { ...provider, disclosedAt: "2026-08-24T00:00:00Z" },
      { ...provider, credentialGeneration: 2 },
      { ...provider, keyVersion: "provider-key-v2" },
    ]) {
      expect(isTenantAdministrationResult({ kind: "provider-configuration",
        provider: unsafeProvider })).toBe(false);
    }
    expect(isTenantAdministrationResult({ kind: "agent-profiles", profiles: [profile], provider }))
      .toBe(true);

    const operation = { version: 1 as const, type: "agent-profile.get" as const,
      context: session, profileId: "profile-1", now: 1_000 };
    expect(isAuthorityWorkerRequest({ type: "authority.tenant-administration",
      requestId: "request-1", operation })).toBe(true);
    expect(isAuthorityWorkerRequest({ type: "authority.tenant-administration",
      requestId: "request-1", operation, roomId: "room-secret" })).toBe(false);
    expect(isAuthorityWorkerResponse({ type: "authority.tenant-administration-result",
      requestId: "request-1", result: { kind: "agent-profile", profile, provider } })).toBe(true);
    expect(isAuthorityWorkerResponse({ type: "authority.tenant-administration-result",
      requestId: "request-1", result: { kind: "agent-profile", profile, provider },
      secret: "sentinel" })).toBe(false);
  });
});
