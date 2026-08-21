import { describe, expect, it } from "vitest";
import { AUTHORITY_PARTICIPANT_FEATURES } from "./room-governance/private-participant-contracts.js";
import {
  assertAgentRuntimeModelContextCapability,
  createProductionSharedAuthorityParticipantComposition,
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
});
