import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import {
  createTenantAdministrationAuthority,
  TenantAdministrationError,
  type DeploymentAuditRecord,
  type GlobalAgentProfile,
  type TenantAdministrationTransaction,
  type TenantAdministratorRegistry,
} from "./authority-service.js";

const NOW = "2026-08-24T06:00:00.000Z";
const BOOTSTRAP_DIGEST = "a".repeat(64);

interface TestState {
  registry?: TenantAdministratorRegistry;
  readonly principalKinds: Map<string, "human" | "agent">;
  readonly currentSessions: Set<string>;
  readonly profiles: Map<string, GlobalAgentProfile>;
  readonly actors: Map<string, "human" | "agent">;
  readonly audits: DeploymentAuditRecord[];
  readonly replay: Map<string, { fingerprint: string; result: unknown }>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fixture() {
  const state: TestState = {
    principalKinds: new Map([
      ["human-owner", "human"],
      ["human-admin", "human"],
      ["human-member", "human"],
      ["agent-existing", "agent"],
    ]),
    currentSessions: new Set(["session-owner", "session-admin", "session-member", "session-agent"]),
    profiles: new Map(), actors: new Map(), audits: [], replay: new Map(),
  };
  const principals = new Map([
    ["owner-token", { sessionId: "session-owner", sessionFamilyId: "family-owner",
      principal: { accountId: "owner-account", actorId: "human-owner" } }],
    ["admin-token", { sessionId: "session-admin", sessionFamilyId: "family-admin",
      principal: { accountId: "admin-account", actorId: "human-admin" } }],
    ["member-token", { sessionId: "session-member", sessionFamilyId: "family-member",
      principal: { accountId: "member-account", actorId: "human-member" } }],
    ["agent-token", { sessionId: "session-agent", sessionFamilyId: "family-agent",
      principal: { accountId: "agent-account", actorId: "agent-existing" } }],
  ] satisfies ReadonlyArray<readonly [string, AuthenticatedSessionContext]>);
  let id = 0;
  const authority = createTenantAdministrationAuthority({
    sessions: {
      authenticateSession: vi.fn(async (accessToken: string) => {
        const context = principals.get(accessToken);
        if (context === undefined) throw Object.assign(new Error("invalid_token"), { status: 401 });
        return context;
      }),
    },
    repository: {
      async transact<TResult>(operation: (transaction: TenantAdministrationTransaction) => TResult) {
        const snapshot = clone({
          registry: state.registry,
          profiles: [...state.profiles], actors: [...state.actors], audits: state.audits,
          replay: [...state.replay],
        });
        const transaction: TenantAdministrationTransaction = {
          requireCurrentSession(context) {
            if (!state.currentSessions.has(context.sessionId)) {
              throw Object.assign(new Error("session_revoked"), { status: 403 });
            }
          },
          principalKind: (principalId) => state.principalKinds.get(principalId),
          readAdministratorRegistry: () => state.registry,
          writeAdministratorRegistry(registry) { state.registry = clone(registry); },
          readProfile: (profileId) => state.profiles.get(profileId),
          listProfiles: () => [...state.profiles.values()],
          createAgentActor(actorId) {
            if (state.actors.has(actorId)) throw new Error("identity collision");
            state.actors.set(actorId, "agent");
          },
          writeProfile(profile) { state.profiles.set(profile.profileId, clone(profile)); },
          readReplay(key) { return state.replay.get(key); },
          writeReplay(key, fingerprint, result) {
            state.replay.set(key, { fingerprint, result: clone(result) });
          },
          appendAudit(record) { state.audits.push(record); },
        };
        try {
          return operation(transaction);
        } catch (error) {
          state.registry = snapshot.registry;
          state.profiles.clear(); for (const entry of snapshot.profiles) state.profiles.set(...entry);
          state.actors.clear(); for (const entry of snapshot.actors) state.actors.set(...entry);
          state.audits.splice(0, state.audits.length,
            ...snapshot.audits.map((record) => Object.freeze(record)));
          state.replay.clear(); for (const entry of snapshot.replay) state.replay.set(...entry);
          throw error;
        }
      },
    },
    providerDisclosure: () => ({
      providerId: "openai-responses", modelId: "gpt-5", credentialReadiness: "ready",
    }),
    capabilities: ["project.read", "route.participate"],
    tools: ["repository.git-status", "room-memory.read"],
    clock: () => NOW,
    profileIdFactory: () => `profile-${++id}`,
    actorIdFactory: () => `agent-${id}`,
    auditIdFactory: () => `audit-${id}-${state.audits.length + 1}`,
  });
  return { authority, state };
}

async function bootstrap(f: ReturnType<typeof fixture>) {
  return f.authority.bootstrapFromOwnerConfiguration({
    principalIds: ["human-owner"], configurationDigest: BOOTSTRAP_DIGEST,
  });
}

const command = (overrides: Partial<{ accessToken: string; requestId: string;
  idempotencyKey: string }> = {}) => ({
  accessToken: "owner-token", requestId: "request-1", idempotencyKey: "idem-1", ...overrides,
});

describe("Tenant Administrator authority", () => {
  it("bootstraps once from an explicit owner-controlled Human principal configuration", async () => {
    const f = fixture();
    const result = await bootstrap(f);
    expect(result).toEqual({ revision: 1, principalIds: ["human-owner"],
      configurationDigest: BOOTSTRAP_DIGEST, updatedAt: NOW });
    await expect(bootstrap(f)).resolves.toEqual(result);
    await expect(f.authority.bootstrapFromOwnerConfiguration({
      principalIds: ["human-admin"], configurationDigest: "b".repeat(64),
    })).rejects.toMatchObject({ status: 409, code: "bootstrap_conflict" });
    const agentBootstrap = fixture();
    await expect(agentBootstrap.authority.bootstrapFromOwnerConfiguration({
      principalIds: ["agent-existing"], configurationDigest: "c".repeat(64),
    })).rejects.toMatchObject({ status: 403, code: "human_principal_required" });
    expect(f.state.audits).toHaveLength(1);
  });

  it("authenticates and revalidates every command, enforces CAS/replay and the last-admin invariant", async () => {
    const f = fixture(); await bootstrap(f);
    const added = await f.authority.addAdministrator(command(), {
      targetPrincipalId: "human-admin", expectedRevision: 1,
    });
    expect(added.registry).toMatchObject({ revision: 2,
      principalIds: ["human-admin", "human-owner"] });
    await expect(f.authority.addAdministrator(command(), {
      targetPrincipalId: "human-admin", expectedRevision: 1,
    })).resolves.toEqual(added);
    await expect(f.authority.addAdministrator(command({ idempotencyKey: "idem-2" }), {
      targetPrincipalId: "human-member", expectedRevision: 1,
    })).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    await expect(f.authority.addAdministrator(command({ idempotencyKey: "idem-agent" }), {
      targetPrincipalId: "agent-existing", expectedRevision: 2,
    })).rejects.toMatchObject({ status: 403, code: "human_principal_required" });
    await expect(f.authority.listAdministrators("member-token"))
      .rejects.toMatchObject({ status: 403, code: "administrator_required" });
    await expect(f.authority.listAdministrators("agent-token"))
      .rejects.toMatchObject({ status: 403, code: "human_principal_required" });
    await expect(f.authority.createProfile(command({
      accessToken: "member-token", idempotencyKey: "member-profile",
    }), {
      expectedRevision: 0, displayName: "Forbidden",
      globalResponsibility: "Must not be created", capabilityCeiling: [], toolCeiling: [],
    })).rejects.toMatchObject({ status: 403, code: "administrator_required" });
    await expect(f.authority.createProfile(command({
      accessToken: "agent-token", idempotencyKey: "agent-profile",
    }), {
      expectedRevision: 0, displayName: "Forbidden",
      globalResponsibility: "Must not be created", capabilityCeiling: [], toolCeiling: [],
    })).rejects.toMatchObject({ status: 403, code: "human_principal_required" });

    const removed = await f.authority.removeAdministrator(command({
      accessToken: "admin-token", idempotencyKey: "remove-owner",
    }), { targetPrincipalId: "human-owner", expectedRevision: 2 });
    expect(removed.registry.principalIds).toEqual(["human-admin"]);
    await expect(f.authority.removeAdministrator(command({
      accessToken: "admin-token", idempotencyKey: "remove-last",
    }), { targetPrincipalId: "human-admin", expectedRevision: 3 }))
      .rejects.toMatchObject({ status: 409, code: "last_administrator_required" });
    f.state.currentSessions.delete("session-admin");
    await expect(f.authority.listAdministrators("admin-token"))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe("Global Agent Profile authority", () => {
  it("creates server-owned stable IDs and supports canonical update/disable/enable with CAS replay", async () => {
    const f = fixture(); await bootstrap(f);
    const created = await f.authority.createProfile(command(), {
      expectedRevision: 0, displayName: "Researcher", globalResponsibility: "Verify sources",
      capabilityCeiling: ["project.read", "route.participate"],
      toolCeiling: ["repository.git-status", "room-memory.read"],
    });
    expect(created.profile).toMatchObject({ profileId: "profile-1", actorId: "agent-1",
      revision: 1, status: "enabled", displayName: "Researcher" });
    expect(f.state.actors.get("agent-1")).toBe("agent");
    const replay = await f.authority.createProfile(command(), {
      expectedRevision: 0, displayName: "Researcher", globalResponsibility: "Verify sources",
      capabilityCeiling: ["project.read", "route.participate"],
      toolCeiling: ["repository.git-status", "room-memory.read"],
    });
    expect(replay).toEqual(created);

    const updated = await f.authority.updateProfile(command({ idempotencyKey: "profile-update" }), {
      profileId: created.profile.profileId, expectedRevision: 1, displayName: "Evidence",
      globalResponsibility: "Verify durable evidence", capabilityCeiling: ["project.read"],
      toolCeiling: ["room-memory.read"],
    });
    expect(updated.profile).toMatchObject({ actorId: "agent-1", revision: 2,
      displayName: "Evidence", capabilityCeiling: ["project.read"] });
    await expect(f.authority.disableProfile(command({ idempotencyKey: "stale-disable" }), {
      profileId: created.profile.profileId, expectedRevision: 1,
    })).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    const disabled = await f.authority.disableProfile(command({ idempotencyKey: "disable" }), {
      profileId: created.profile.profileId, expectedRevision: 2,
    });
    expect(disabled.profile).toMatchObject({ status: "disabled", revision: 3 });
    const enabled = await f.authority.enableProfile(command({ idempotencyKey: "enable" }), {
      profileId: created.profile.profileId, expectedRevision: 3,
    });
    expect(enabled.profile).toMatchObject({ status: "enabled", revision: 4 });
  });

  it("fails closed for unknown/noncanonical authority sets and idempotency-key payload changes", async () => {
    const f = fixture(); await bootstrap(f);
    await expect(f.authority.createProfile(command(), {
      expectedRevision: 0, displayName: "Researcher", globalResponsibility: "Verify sources",
      capabilityCeiling: ["unknown"], toolCeiling: [],
    })).rejects.toMatchObject({ status: 400, code: "invalid_profile" });
    await expect(f.authority.createProfile(command({ idempotencyKey: "sort" }), {
      expectedRevision: 0, displayName: "Researcher", globalResponsibility: "Verify sources",
      capabilityCeiling: ["route.participate", "project.read"], toolCeiling: [],
    })).rejects.toMatchObject({ status: 400, code: "invalid_profile" });
    await f.authority.addAdministrator(command({ idempotencyKey: "shared-key" }), {
      targetPrincipalId: "human-admin", expectedRevision: 1,
    });
    await expect(f.authority.addAdministrator(command({ idempotencyKey: "shared-key" }), {
      targetPrincipalId: "human-member", expectedRevision: 2,
    })).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
  });

  it("discloses only deployment metadata and rejects unsupported secret mutation without retaining it", async () => {
    const f = fixture(); await bootstrap(f);
    const view = await f.authority.queryProfiles("owner-token");
    expect(view).toEqual({ profiles: [], provider: {
      providerId: "openai-responses", modelId: "gpt-5", credentialReadiness: "ready",
    } });
    expect(JSON.stringify(view)).not.toMatch(/room|secret|credentialValue|apiKey/i);
    const sentinel = "sk-secret-sentinel-never-store";
    await expect(f.authority.rejectUnsupportedCredentialMutation("owner-token", {
      providerId: "openai-responses", credential: sentinel,
    })).rejects.toMatchObject({ status: 503, code: "credential_mutation_unsupported" });
    expect(JSON.stringify({ audits: f.state.audits, replay: [...f.state.replay] })).not.toContain(sentinel);
  });

  it("writes immutable deployment-only audit shapes and rolls conflicts back without audit", async () => {
    const f = fixture(); await bootstrap(f);
    await f.authority.createProfile(command(), {
      expectedRevision: 0, displayName: "Researcher", globalResponsibility: "Verify sources",
      capabilityCeiling: [], toolCeiling: [],
    });
    const before = f.state.audits.length;
    await expect(f.authority.updateProfile(command({ idempotencyKey: "bad-cas" }), {
      profileId: "profile-1", expectedRevision: 99, displayName: "Nope",
      globalResponsibility: "Nope", capabilityCeiling: [], toolCeiling: [],
    })).rejects.toBeInstanceOf(TenantAdministrationError);
    expect(f.state.audits).toHaveLength(before);
    for (const audit of f.state.audits) {
      expect(Object.keys(audit).sort()).toEqual([
        "action", "actorId", "auditId", "occurredAt", "requestId", "revision", "targetId",
      ]);
      expect(JSON.stringify(audit)).not.toMatch(/room|message|member|goal|assignment|secret/i);
      expect(Object.isFrozen(audit)).toBe(true);
    }
  });
});
