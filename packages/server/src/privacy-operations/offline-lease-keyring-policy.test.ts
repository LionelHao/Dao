import { describe, expect, it } from "vitest";
import {
  OfflineLeaseKeyringPolicyError,
  createOfflineLeaseKeyringPolicy,
  requireActiveOfflineLeaseSigningKey,
  verificationKeyIdsAt,
} from "./offline-lease-keyring-policy.js";
import { OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS } from "./offline-lease-policy.js";

const ACTIVATED_AT = 1_800_000_000_000;

describe("FT-14 offline lease signing-key rotation policy", () => {
  it("allows one active key and at most one bounded previous key", () => {
    const policy = createOfflineLeaseKeyringPolicy({
      active: { keyId: "lease-key-v2", activatedAtMs: ACTIVATED_AT },
      previous: {
        keyId: "lease-key-v1",
        issuanceCutoffMs: ACTIVATED_AT,
        verificationCutoffMs: ACTIVATED_AT + OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS,
      },
    });
    expect(requireActiveOfflineLeaseSigningKey(policy, ACTIVATED_AT, "lease-key-v2")).toEqual({
      keyId: "lease-key-v2", activatedAtMs: ACTIVATED_AT,
    });
    expect(verificationKeyIdsAt(policy, ACTIVATED_AT))
      .toEqual(["lease-key-v1", "lease-key-v2"]);
    expect(verificationKeyIdsAt(
      policy,
      ACTIVATED_AT + OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS - 1,
    )).toEqual(["lease-key-v1", "lease-key-v2"]);
    expect(verificationKeyIdsAt(
      policy,
      ACTIVATED_AT + OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS,
    )).toEqual(["lease-key-v2"]);
  });

  it("does not allow the previous key to issue a new lease or survive its exact cutoff", () => {
    const policy = createOfflineLeaseKeyringPolicy({
      active: { keyId: "lease-key-v2", activatedAtMs: ACTIVATED_AT },
      previous: {
        keyId: "lease-key-v1",
        issuanceCutoffMs: ACTIVATED_AT,
        verificationCutoffMs: ACTIVATED_AT + OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS,
      },
    });
    expect(() => requireActiveOfflineLeaseSigningKey(policy, ACTIVATED_AT - 1, "lease-key-v2"))
      .toThrow(OfflineLeaseKeyringPolicyError);
    expect(requireActiveOfflineLeaseSigningKey(policy, ACTIVATED_AT, "lease-key-v2").keyId)
      .toBe("lease-key-v2");
    expect(() => requireActiveOfflineLeaseSigningKey(policy, ACTIVATED_AT, "lease-key-v1"))
      .toThrow(OfflineLeaseKeyringPolicyError);
    expect(() => verificationKeyIdsAt(policy, Number.POSITIVE_INFINITY))
      .toThrow(OfflineLeaseKeyringPolicyError);
  });

  it("preserves the future-activation fail-closed boundary after policy reconstruction", () => {
    const input = { active: { keyId: "lease-key-v2", activatedAtMs: ACTIVATED_AT } } as const;
    for (const policy of [
      createOfflineLeaseKeyringPolicy(input),
      createOfflineLeaseKeyringPolicy(input),
    ]) {
      expect(() => requireActiveOfflineLeaseSigningKey(
        policy, ACTIVATED_AT - 1, "lease-key-v2",
      )).toThrow(OfflineLeaseKeyringPolicyError);
      expect(requireActiveOfflineLeaseSigningKey(
        policy, ACTIVATED_AT, "lease-key-v2",
      )).toEqual(input.active);
    }
  });

  it("rejects duplicate IDs, invalid timestamps, and overlap beyond the hard limit", () => {
    const invalid = [
      {
        active: { keyId: "same", activatedAtMs: ACTIVATED_AT },
        previous: { keyId: "same", issuanceCutoffMs: ACTIVATED_AT,
          verificationCutoffMs: ACTIVATED_AT + OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS },
      },
      {
        active: { keyId: "v2", activatedAtMs: ACTIVATED_AT },
        previous: { keyId: "v1", issuanceCutoffMs: ACTIVATED_AT + 1,
          verificationCutoffMs: ACTIVATED_AT + OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS },
      },
      {
        active: { keyId: "v2", activatedAtMs: ACTIVATED_AT },
        previous: { keyId: "v1", issuanceCutoffMs: ACTIVATED_AT,
          verificationCutoffMs: ACTIVATED_AT + OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS + 1 },
      },
      { active: { keyId: "", activatedAtMs: ACTIVATED_AT } },
      { active: { keyId: "v2", activatedAtMs: Number.NaN } },
    ] as const;
    for (const value of invalid) {
      expect(() => createOfflineLeaseKeyringPolicy(value))
        .toThrow(OfflineLeaseKeyringPolicyError);
    }
  });
});
