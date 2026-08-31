import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  IDEMPOTENCY_RECEIPT_TTL_MS,
  idempotencyReceiptExpiresAt,
  isIdempotencyReceiptReplayable,
  requireIdempotencyCleanupLimit,
} from "./idempotency-lifecycle.js";

describe("idempotency lifecycle", () => {
  it("replays strictly before 30d and expires at the exact boundary", () => {
    const acceptedAt = Date.parse("2026-08-01T00:00:00.000Z");
    const expiresAt = idempotencyReceiptExpiresAt(acceptedAt);
    expect(expiresAt).toBe(acceptedAt + 30 * 24 * 60 * 60 * 1_000);
    expect(isIdempotencyReceiptReplayable(expiresAt - 1, expiresAt)).toBe(true);
    expect(isIdempotencyReceiptReplayable(expiresAt, expiresAt)).toBe(false);
    expect(isIdempotencyReceiptReplayable(expiresAt + 1, expiresAt)).toBe(false);
    expect(IDEMPOTENCY_RECEIPT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1_000);
  });

  it("enforces the 500-row writer batch ceiling", () => {
    expect(IDEMPOTENCY_CLEANUP_BATCH_SIZE).toBe(500);
    expect(requireIdempotencyCleanupLimit(1)).toBe(1);
    expect(requireIdempotencyCleanupLimit(500)).toBe(500);
    for (const limit of [0, -1, 501, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => requireIdempotencyCleanupLimit(limit)).toThrow();
    }
  });
});
