/**
 * FT-14 release policy for server-signed offline read leases.
 *
 * The client never receives a policy override. It may request a shorter duration,
 * but the server selects the authoritative duration from this closed policy.
 */
export const OFFLINE_READ_LEASE_HARD_MIN_MS = 5 * 60 * 1_000;
export const OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS = 8 * 60 * 60 * 1_000;
export const OFFLINE_READ_LEASE_HARD_MAX_MS = 24 * 60 * 60 * 1_000;
export const OFFLINE_READ_LEASE_CLOCK_SKEW_TOLERANCE_MS = 0;
export const OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS = OFFLINE_READ_LEASE_HARD_MAX_MS;

export type OfflineReadLeasePolicyErrorReason =
  | "invalid_deployment_policy"
  | "invalid_requested_duration"
  | "requested_duration_too_short"
  | "requested_duration_too_long";

export class OfflineReadLeasePolicyError extends Error {
  constructor(readonly reason: OfflineReadLeasePolicyErrorReason) {
    super(`Offline read lease policy rejected: ${reason}`);
    this.name = "OfflineReadLeasePolicyError";
  }
}

export interface OfflineReadLeasePolicy {
  readonly defaultLeaseMs: number;
  readonly maxOfflineReadLeaseMs: number;
  readonly hardMinimumMs: typeof OFFLINE_READ_LEASE_HARD_MIN_MS;
  readonly hardMaximumMs: typeof OFFLINE_READ_LEASE_HARD_MAX_MS;
  /** Expiry has no grace. A skewed client fails closed instead of extending exposure. */
  readonly clockSkewToleranceMs: typeof OFFLINE_READ_LEASE_CLOCK_SKEW_TOLERANCE_MS;
  /** At most one previous verification key may remain usable for this bounded interval. */
  readonly previousKeyOverlapMs: typeof OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS;
}

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Number.isFinite(value);
}

function deploymentMaximum(value: unknown): number {
  if (!finiteInteger(value) || value < OFFLINE_READ_LEASE_HARD_MIN_MS ||
      value > OFFLINE_READ_LEASE_HARD_MAX_MS) {
    throw new OfflineReadLeasePolicyError("invalid_deployment_policy");
  }
  return value;
}

export function createOfflineReadLeasePolicy(
  options: Readonly<{ maxOfflineReadLeaseMs: number }>,
): OfflineReadLeasePolicy {
  const configuredMaximum = deploymentMaximum(options.maxOfflineReadLeaseMs);
  return Object.freeze({
    defaultLeaseMs: Math.min(OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS, configuredMaximum),
    maxOfflineReadLeaseMs: configuredMaximum,
    hardMinimumMs: OFFLINE_READ_LEASE_HARD_MIN_MS,
    hardMaximumMs: OFFLINE_READ_LEASE_HARD_MAX_MS,
    clockSkewToleranceMs: OFFLINE_READ_LEASE_CLOCK_SKEW_TOLERANCE_MS,
    previousKeyOverlapMs: OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS,
  });
}

export function parseOfflineReadLeasePolicyEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): OfflineReadLeasePolicy {
  const raw = environment.DAO_MAX_OFFLINE_READ_LEASE_MS;
  if (raw === undefined) {
    throw new OfflineReadLeasePolicyError("invalid_deployment_policy");
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new OfflineReadLeasePolicyError("invalid_deployment_policy");
  }
  const value = Number(raw);
  return createOfflineReadLeasePolicy({ maxOfflineReadLeaseMs: value });
}

export function selectOfflineReadLeaseDuration(
  policy: OfflineReadLeasePolicy,
  requestedLeaseMs: number | undefined,
): number {
  const selected = requestedLeaseMs ?? policy.defaultLeaseMs;
  if (!finiteInteger(selected)) {
    throw new OfflineReadLeasePolicyError("invalid_requested_duration");
  }
  if (selected < policy.hardMinimumMs) {
    throw new OfflineReadLeasePolicyError("requested_duration_too_short");
  }
  if (selected > policy.maxOfflineReadLeaseMs || selected > policy.hardMaximumMs) {
    throw new OfflineReadLeasePolicyError("requested_duration_too_long");
  }
  return selected;
}
