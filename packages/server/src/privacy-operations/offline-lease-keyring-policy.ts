import { OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS } from "./offline-lease-policy.js";

export type OfflineLeaseKeyringPolicyErrorReason =
  | "invalid_keyring"
  | "inactive_signing_key"
  | "invalid_clock";

export class OfflineLeaseKeyringPolicyError extends Error {
  constructor(readonly reason: OfflineLeaseKeyringPolicyErrorReason) {
    super(`Offline lease keyring policy rejected: ${reason}`);
    this.name = "OfflineLeaseKeyringPolicyError";
  }
}

export interface ActiveOfflineLeaseSigningKey {
  readonly keyId: string;
  readonly activatedAtMs: number;
}

export interface PreviousOfflineLeaseVerificationKey {
  readonly keyId: string;
  /** The old key must never issue a lease at or after this instant. */
  readonly issuanceCutoffMs: number;
  /** Verification is rejected at this exact boundary. */
  readonly verificationCutoffMs: number;
}

export interface OfflineLeaseKeyringPolicy {
  readonly active: ActiveOfflineLeaseSigningKey;
  readonly previous?: PreviousOfflineLeaseVerificationKey;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function keyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function invalid(): never {
  throw new OfflineLeaseKeyringPolicyError("invalid_keyring");
}

/**
 * Validates metadata only. Signing/verification key material remains in the
 * server-private key backend and must never be placed in this object.
 */
export function createOfflineLeaseKeyringPolicy(
  input: Readonly<{
    active: ActiveOfflineLeaseSigningKey;
    previous?: PreviousOfflineLeaseVerificationKey;
  }>,
): OfflineLeaseKeyringPolicy {
  if (typeof input !== "object" || input === null || !keyId(input.active?.keyId) ||
      !timestamp(input.active?.activatedAtMs)) {
    return invalid();
  }
  const previous = input.previous;
  if (previous !== undefined) {
    if (!keyId(previous.keyId) || previous.keyId === input.active.keyId ||
        !timestamp(previous.issuanceCutoffMs) || !timestamp(previous.verificationCutoffMs) ||
        previous.issuanceCutoffMs !== input.active.activatedAtMs ||
        previous.verificationCutoffMs !==
          previous.issuanceCutoffMs + OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS ||
        !Number.isSafeInteger(previous.verificationCutoffMs)) {
      return invalid();
    }
  }
  return Object.freeze({
    active: Object.freeze({ ...input.active }),
    ...(previous === undefined ? {} : { previous: Object.freeze({ ...previous }) }),
  });
}

export function requireActiveOfflineLeaseSigningKey(
  policy: OfflineLeaseKeyringPolicy,
  nowMs: number,
  requestedKeyId: string = policy.active.keyId,
): ActiveOfflineLeaseSigningKey {
  if (!timestamp(nowMs)) throw new OfflineLeaseKeyringPolicyError("invalid_clock");
  if (requestedKeyId !== policy.active.keyId) {
    throw new OfflineLeaseKeyringPolicyError("inactive_signing_key");
  }
  if (nowMs < policy.active.activatedAtMs) {
    throw new OfflineLeaseKeyringPolicyError("inactive_signing_key");
  }
  return policy.active;
}

export function verificationKeyIdsAt(
  policy: OfflineLeaseKeyringPolicy,
  nowMs: number,
): readonly string[] {
  if (!timestamp(nowMs)) throw new OfflineLeaseKeyringPolicyError("invalid_clock");
  const ids = policy.previous !== undefined && nowMs < policy.previous.verificationCutoffMs
    ? [policy.previous.keyId, policy.active.keyId]
    : [policy.active.keyId];
  return Object.freeze(ids);
}
