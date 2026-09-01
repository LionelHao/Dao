import { describe, expect, it } from "vitest";
import {
  parsePrivacyOperationsDeploymentConfiguration,
  PROVIDER_SECURITY_DISCLOSURE_REVISION,
  validatePrivacyOperationsSharedAuthority,
} from "./deployment-configuration.js";
import {
  OFFLINE_READ_LEASE_HARD_MAX_MS,
  OFFLINE_READ_LEASE_HARD_MIN_MS,
  OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS,
} from "./offline-lease-policy.js";

const DISCLOSED_AT = "2026-08-31T12:00:00.000Z";

describe("FT-14 release deployment configuration", () => {
  it("requires the explicit release lease setting and wires the validated value to sharedAuthority", () => {
    const configuration = parsePrivacyOperationsDeploymentConfiguration({
      environment: {
        DAO_MAX_OFFLINE_READ_LEASE_MS: String(OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS),
      },
      modelId: "gpt-5",
      credentialAvailable: true,
      disclosedAt: DISCLOSED_AT,
    });
    expect(configuration.sharedAuthority).toEqual({
      maxOfflineReadLeaseMs: OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS,
    });
    expect(configuration.offlineReadLease).toMatchObject({
      hardMinimumMs: OFFLINE_READ_LEASE_HARD_MIN_MS,
      hardMaximumMs: OFFLINE_READ_LEASE_HARD_MAX_MS,
      defaultLeaseMs: OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS,
      clockSkewToleranceMs: 0,
    });
  });

  it.each([
    {},
    { DAO_MAX_OFFLINE_READ_LEASE_MS: "0" },
    { DAO_MAX_OFFLINE_READ_LEASE_MS: "300000.5" },
    { DAO_MAX_OFFLINE_READ_LEASE_MS: "Infinity" },
    { DAO_MAX_OFFLINE_READ_LEASE_MS: String(OFFLINE_READ_LEASE_HARD_MIN_MS - 1) },
    { DAO_MAX_OFFLINE_READ_LEASE_MS: String(OFFLINE_READ_LEASE_HARD_MAX_MS + 1) },
  ])("fails closed before composition for a missing or invalid release lease %#", (environment) => {
    expect(() => parsePrivacyOperationsDeploymentConfiguration({
      environment,
      modelId: "gpt-5",
      credentialAvailable: false,
      disclosedAt: DISCLOSED_AT,
    })).toThrow();
  });

  it("exposes only public provider facts with a stable disclosure revision and server time", () => {
    const configuration = parsePrivacyOperationsDeploymentConfiguration({
      environment: {
        DAO_MAX_OFFLINE_READ_LEASE_MS: String(OFFLINE_READ_LEASE_HARD_MAX_MS),
        OPENAI_API_KEY: "must-never-cross",
      },
      modelId: "gpt-5",
      credentialAvailable: false,
      disclosedAt: DISCLOSED_AT,
    });
    expect(configuration.providerDisclosure).toEqual({
      providerId: "openai-responses",
      modelId: "gpt-5",
      readiness: "noauth",
      retentionDisabled: true,
      selectionPolicy: "server-managed-single",
      disclosureRevision: PROVIDER_SECURITY_DISCLOSURE_REVISION,
      disclosedAt: DISCLOSED_AT,
    });
    expect(configuration.credentialRotation).toEqual({
      status: "configuration_unsupported",
    });
    expect(JSON.stringify(configuration)).not.toContain("must-never-cross");
    expect(JSON.stringify(configuration)).not.toMatch(
      /keyVersion|credentialGeneration|secretMetadata|credentialValue/,
    );
  });

  it("validates embedded host options against the same 5m..24h release bounds", () => {
    expect(validatePrivacyOperationsSharedAuthority({
      maxOfflineReadLeaseMs: OFFLINE_READ_LEASE_HARD_MIN_MS,
    })).toEqual({
      defaultLeaseMs: OFFLINE_READ_LEASE_HARD_MIN_MS,
      maxOfflineReadLeaseMs: OFFLINE_READ_LEASE_HARD_MIN_MS,
    });
    expect(validatePrivacyOperationsSharedAuthority({
      maxOfflineReadLeaseMs: OFFLINE_READ_LEASE_HARD_MAX_MS,
    })).toEqual({
      defaultLeaseMs: OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS,
      maxOfflineReadLeaseMs: OFFLINE_READ_LEASE_HARD_MAX_MS,
    });
    expect(() => validatePrivacyOperationsSharedAuthority({
      maxOfflineReadLeaseMs: 60_000,
    })).toThrow();
  });

  it("rejects non-canonical timestamps and extra configuration surfaces", () => {
    expect(() => parsePrivacyOperationsDeploymentConfiguration({
      environment: { DAO_MAX_OFFLINE_READ_LEASE_MS: "28800000" },
      modelId: "gpt-5",
      credentialAvailable: true,
      disclosedAt: "2026-08-31T12:00:00Z",
    })).toThrow();
    expect(() => parsePrivacyOperationsDeploymentConfiguration({
      environment: { DAO_MAX_OFFLINE_READ_LEASE_MS: "28800000" },
      modelId: "gpt-5",
      credentialAvailable: true,
      disclosedAt: DISCLOSED_AT,
      credentialGeneration: 7,
    } as never)).toThrow("not closed");
  });
});
