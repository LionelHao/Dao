import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORITY_PARTICIPANT_FEATURES } from "./room-governance/private-participant-contracts.js";
import {
  assertAgentRuntimeModelContextCapability,
  createAgentProviderReadinessProbe,
  createProductionSharedAuthorityParticipantComposition,
  startAuthoritativeServerForTest,
} from "./authoritative-server.js";

const EXPECTED_REGISTRATIONS = [
  "dao.project-loop.departure-responsibility.v1",
  "dao.tool-safety.pending-confirmation-departure.v1",
  "dao.message-authority.archived-message-gate.v1",
  "dao.business-timers.suspension.v1",
  "dao.tool-safety.archive-settlement.v1",
  "dao.agent-runtime.archive-fence.v1",
  "dao.room-assignment.security-reduction.v1",
  "dao.room-governance.lifecycle-repair.v1",
  "dao.access.room-cache-invalidation.v1",
  "dao.access.offline-lease-invalidation.v1",
] as const;

describe("production shared-authority participant composition", () => {
  it("registers every enabled feature exactly once with the effective Ball policy", () => {
    const composition = createProductionSharedAuthorityParticipantComposition({
      maxOfflineReadLeaseMs: 30_000,
      ballPolicy: { openItemDeadlineMs: 41_000, lightTaskDeadlineMs: 43_000 },
    });

    expect(Object.keys(composition.manifest)).toEqual([...AUTHORITY_PARTICIPANT_FEATURES]);
    expect(Object.values(composition.manifest)).toEqual(
      AUTHORITY_PARTICIPANT_FEATURES.map(() => true),
    );
    expect(composition.registrations.map((registration) =>
      (registration as { readonly registrationId: string }).registrationId,
    )).toEqual(EXPECTED_REGISTRATIONS);
    expect(new Set(EXPECTED_REGISTRATIONS).size).toBe(EXPECTED_REGISTRATIONS.length);
  });

  it("keeps AuthorityWorker alive after runtime safety cleanup fails and retries close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-close-fence-"));
    const closedStages: string[] = [];
    let rejectRuntimeStage = true;
    try {
      const server = await startAuthoritativeServerForTest({
        databasePath: join(directory, "authority.sqlite"),
        snapshotCachePath: join(directory, "snapshot-cache.sqlite"),
        sharedAuthority: { maxOfflineReadLeaseMs: 60_000 },
        listen: { host: "127.0.0.1", port: 0 },
        actors: [
          { id: "human-a", kind: "human", displayName: "Human A", reachability: "online" },
          { id: "agent-a", kind: "agent", displayName: "Agent A", readiness: "ready",
            toolPermissions: ["authority.inspect"] },
        ],
        identities: { verify: async () => undefined },
        invitationSecretKey: new Uint8Array(32).fill(17),
      }, {
        toolAdapterPathFallbackForTest: true,
        afterCloseForTest: {
          runtime() {
            closedStages.push("runtime");
            if (rejectRuntimeStage) {
              rejectRuntimeStage = false;
              throw new Error("runtime safety settlement timed out");
            }
          },
          worker() { closedStages.push("worker"); },
        },
      });

      await expect(server.close()).rejects.toThrow(/cleanup failed/u);
      expect(closedStages).toEqual(["runtime"]);
      await expect(server.close()).resolves.toBeUndefined();
      expect(closedStages).toEqual(["runtime", "runtime", "worker"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when deployment lease policy is missing or invalid", () => {
    expect(() => createProductionSharedAuthorityParticipantComposition({
      maxOfflineReadLeaseMs: 0,
      ballPolicy: { openItemDeadlineMs: 41_000, lightTaskDeadlineMs: 43_000 },
    })).toThrow(/invalid_policy/i);
  });

  it("fails startup capability validation for unknown or undersized model windows", () => {
    expect(assertAgentRuntimeModelContextCapability({ model: "gpt-5-mini" }))
      .toBeGreaterThanOrEqual(65_536);
    expect(() => assertAgentRuntimeModelContextCapability({ model: "unknown-model" }))
      .toThrow(/missing or below 65536/u);
    expect(() => assertAgentRuntimeModelContextCapability({
      model: "deployment-model", configuredContextWindowTokens: 65_535,
    })).toThrow(/missing or below 65536/u);
    expect(assertAgentRuntimeModelContextCapability({
      model: "deployment-model", configuredContextWindowTokens: 65_536,
    })).toBe(65_536);
  });

  it("rechecks Project Agent Provider readiness after credential rotation", () => {
    let credential: string | undefined;
    const readiness = createAgentProviderReadinessProbe({
      providerConfigured: false,
      secretProvider: { getSecret: () => credential },
    });
    expect(readiness()).toBe(false);
    credential = "injected-after-startup";
    expect(readiness()).toBe(true);
    credential = undefined;
    expect(readiness()).toBe(false);
    expect(createAgentProviderReadinessProbe({
      providerConfigured: true,
      secretProvider: { getSecret: () => undefined },
    })()).toBe(true);
  });
});
