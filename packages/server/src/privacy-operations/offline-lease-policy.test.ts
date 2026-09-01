import { describe, expect, it } from "vitest";
import {
  OFFLINE_READ_LEASE_HARD_MAX_MS,
  OFFLINE_READ_LEASE_HARD_MIN_MS,
  OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS,
  OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS,
  OfflineReadLeasePolicyError,
  createOfflineReadLeasePolicy,
  parseOfflineReadLeasePolicyEnvironment,
  selectOfflineReadLeaseDuration,
} from "./offline-lease-policy.js";

describe("FT-14 offline read lease release policy", () => {
  it("freezes an eight-hour release default, five-minute minimum, and 24-hour hard maximum", () => {
    expect(OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS).toBe(8 * 60 * 60 * 1_000);
    expect(OFFLINE_READ_LEASE_HARD_MIN_MS).toBe(5 * 60 * 1_000);
    expect(OFFLINE_READ_LEASE_HARD_MAX_MS).toBe(24 * 60 * 60 * 1_000);
    expect(OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS).toBe(OFFLINE_READ_LEASE_HARD_MAX_MS);
    expect(createOfflineReadLeasePolicy({
      maxOfflineReadLeaseMs: OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS,
    })).toEqual({
      defaultLeaseMs: OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS,
      maxOfflineReadLeaseMs: OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS,
      hardMinimumMs: OFFLINE_READ_LEASE_HARD_MIN_MS,
      hardMaximumMs: OFFLINE_READ_LEASE_HARD_MAX_MS,
      clockSkewToleranceMs: 0,
      previousKeyOverlapMs: OFFLINE_READ_LEASE_PREVIOUS_KEY_OVERLAP_MS,
    });
  });

  it("allows deployment policy to shorten or raise the configured ceiling only inside hard bounds", () => {
    expect(createOfflineReadLeasePolicy({ maxOfflineReadLeaseMs: 60 * 60 * 1_000 })).toMatchObject({
      defaultLeaseMs: 60 * 60 * 1_000,
      maxOfflineReadLeaseMs: 60 * 60 * 1_000,
    });
    expect(createOfflineReadLeasePolicy({ maxOfflineReadLeaseMs: OFFLINE_READ_LEASE_HARD_MAX_MS }))
      .toMatchObject({
        defaultLeaseMs: OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS,
        maxOfflineReadLeaseMs: OFFLINE_READ_LEASE_HARD_MAX_MS,
      });
    for (const value of [
      undefined as unknown as number,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      OFFLINE_READ_LEASE_HARD_MIN_MS - 1,
      OFFLINE_READ_LEASE_HARD_MAX_MS + 1,
      1.5,
    ]) {
      expect(() => createOfflineReadLeasePolicy({ maxOfflineReadLeaseMs: value }))
        .toThrow(OfflineReadLeasePolicyError);
    }
    expect(() => createOfflineReadLeasePolicy({} as { maxOfflineReadLeaseMs: number }))
      .toThrow(OfflineReadLeasePolicyError);
  });

  it("requires one canonical server-side deployment value without a hidden missing/zero/NaN/Infinity fallback", () => {
    expect(() => parseOfflineReadLeasePolicyEnvironment({}))
      .toThrow(OfflineReadLeasePolicyError);
    expect(parseOfflineReadLeasePolicyEnvironment({
      DAO_MAX_OFFLINE_READ_LEASE_MS: String(12 * 60 * 60 * 1_000),
    })).toMatchObject({ maxOfflineReadLeaseMs: 12 * 60 * 60 * 1_000 });
    for (const raw of ["", "0", "-1", "NaN", "Infinity", " 3600000", "3600000 ", "1.5", "+3600000"] as const) {
      expect(() => parseOfflineReadLeasePolicyEnvironment({
        DAO_MAX_OFFLINE_READ_LEASE_MS: raw,
      })).toThrow(OfflineReadLeasePolicyError);
    }
  });

  it("uses the server default only when omitted and rejects client requests outside the closed range", () => {
    const policy = createOfflineReadLeasePolicy({ maxOfflineReadLeaseMs: 12 * 60 * 60 * 1_000 });
    expect(selectOfflineReadLeaseDuration(policy, undefined)).toBe(OFFLINE_READ_LEASE_RELEASE_DEFAULT_MS);
    expect(selectOfflineReadLeaseDuration(policy, OFFLINE_READ_LEASE_HARD_MIN_MS))
      .toBe(OFFLINE_READ_LEASE_HARD_MIN_MS);
    expect(selectOfflineReadLeaseDuration(policy, policy.maxOfflineReadLeaseMs))
      .toBe(policy.maxOfflineReadLeaseMs);
    for (const requested of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      OFFLINE_READ_LEASE_HARD_MIN_MS - 1,
      policy.maxOfflineReadLeaseMs + 1,
      1.5,
    ]) {
      expect(() => selectOfflineReadLeaseDuration(policy, requested))
        .toThrow(OfflineReadLeasePolicyError);
    }
  });
});
