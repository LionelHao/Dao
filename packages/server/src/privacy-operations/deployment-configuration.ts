import {
  createOfflineReadLeasePolicy,
  parseOfflineReadLeasePolicyEnvironment,
  type OfflineReadLeasePolicy,
} from "./offline-lease-policy.js";
import {
  createProviderSecurityDisclosure,
  type ProviderSecurityDisclosure,
} from "./provider-security-policy.js";

/**
 * This revision describes the public disclosure shape and policy, not a
 * credential generation. Credential backend versions must never cross this
 * boundary.
 */
export const PROVIDER_SECURITY_DISCLOSURE_REVISION = 1 as const;

export interface PrivacyOperationsDeploymentConfiguration {
  readonly offlineReadLease: OfflineReadLeasePolicy;
  readonly sharedAuthority: Readonly<{
    readonly maxOfflineReadLeaseMs: number;
  }>;
  readonly providerDisclosure: ProviderSecurityDisclosure;
  /** No production mutation port exists until the owner approves a backend. */
  readonly credentialRotation: Readonly<{
    readonly status: "configuration_unsupported";
  }>;
}

function canonicalUtcTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertExactKeys(
  input: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const keys = Reflect.ownKeys(input);
  if (keys.length !== expected.length || keys.some(
    (key) => typeof key !== "string" || !expected.includes(key),
  )) {
    throw new TypeError("Privacy operations deployment configuration is not closed");
  }
}

/**
 * Parses the release environment. Production callers must use this overload:
 * the lease variable is mandatory and malformed/missing values fail startup.
 */
export function parsePrivacyOperationsDeploymentConfiguration(input: Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  modelId: string;
  credentialAvailable: boolean;
  disclosedAt: string;
}>): PrivacyOperationsDeploymentConfiguration {
  assertExactKeys(input as Readonly<Record<string, unknown>>, [
    "environment",
    "modelId",
    "credentialAvailable",
    "disclosedAt",
  ]);
  if (typeof input.modelId !== "string" || input.modelId.trim() !== input.modelId ||
      input.modelId.length === 0 || typeof input.credentialAvailable !== "boolean" ||
      !canonicalUtcTimestamp(input.disclosedAt)) {
    throw new TypeError("Privacy operations deployment configuration is invalid");
  }

  const offlineReadLease = parseOfflineReadLeasePolicyEnvironment(input.environment);
  const providerDisclosure = createProviderSecurityDisclosure({
    modelId: input.modelId,
    readiness: input.credentialAvailable ? "ready" : "noauth",
    disclosureRevision: PROVIDER_SECURITY_DISCLOSURE_REVISION,
    disclosedAt: input.disclosedAt,
  });
  return Object.freeze({
    offlineReadLease,
    sharedAuthority: Object.freeze({
      maxOfflineReadLeaseMs: offlineReadLease.maxOfflineReadLeaseMs,
    }),
    providerDisclosure,
    credentialRotation: Object.freeze({ status: "configuration_unsupported" as const }),
  });
}

/**
 * Validates an already parsed host option before it reaches AuthorityWorker.
 * Embedded/test hosts can use this without pretending an environment default.
 */
export function validatePrivacyOperationsSharedAuthority(input: Readonly<{
  maxOfflineReadLeaseMs: number;
}>): Readonly<{ defaultLeaseMs: number; maxOfflineReadLeaseMs: number }> {
  assertExactKeys(input as Readonly<Record<string, unknown>>, ["maxOfflineReadLeaseMs"]);
  const policy = createOfflineReadLeasePolicy(input);
  return Object.freeze({
    defaultLeaseMs: policy.defaultLeaseMs,
    maxOfflineReadLeaseMs: policy.maxOfflineReadLeaseMs,
  });
}
