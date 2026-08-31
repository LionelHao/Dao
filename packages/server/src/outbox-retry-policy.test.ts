import { describe, expect, it } from "vitest";
import {
  OUTBOX_DEFAULT_BATCH_SIZE,
  OUTBOX_DEFAULT_MAX_ATTEMPTS,
  createOutboxRetryPolicy,
} from "./outbox-retry-policy.js";

describe("outbox retry policy", () => {
  it("uses deterministic exponential full jitter and terminal attempt eight", () => {
    const policy = createOutboxRetryPolicy({ random: () => 0.5 });

    expect(policy.afterFailure({ priorAttempts: 0, nowMs: 1_000 })).toEqual({
      kind: "retry", attempt: 1, delayMs: 125, availableAtMs: 1_125,
    });
    expect(policy.afterFailure({ priorAttempts: 1, nowMs: 1_000 })).toEqual({
      kind: "retry", attempt: 2, delayMs: 250, availableAtMs: 1_250,
    });
    expect(policy.afterFailure({ priorAttempts: 6, nowMs: 1_000 })).toEqual({
      kind: "retry", attempt: 7, delayMs: 8_000, availableAtMs: 9_000,
    });
    expect(policy.afterFailure({ priorAttempts: 7, nowMs: 1_000 })).toEqual({
      kind: "dead-letter", attempt: OUTBOX_DEFAULT_MAX_ATTEMPTS,
    });
  });

  it("caps the jitter ceiling at thirty seconds", () => {
    const policy = createOutboxRetryPolicy({
      random: () => 0.999,
      baseDelayMs: 20_000,
      capDelayMs: 30_000,
      maxAttempts: 8,
    });
    const result = policy.afterFailure({ priorAttempts: 1, nowMs: 0 });
    expect(result).toMatchObject({ kind: "retry", attempt: 2 });
    if (result.kind !== "retry") throw new Error("expected retry");
    expect(result.delayMs).toBe(29_970);
  });

  it("rejects non-finite, zero, negative, and over-cap configuration", () => {
    const invalid = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];
    for (const baseDelayMs of invalid) {
      expect(() => createOutboxRetryPolicy({ baseDelayMs })).toThrow();
    }
    expect(() => createOutboxRetryPolicy({ capDelayMs: 30_001 })).toThrow();
    expect(() => createOutboxRetryPolicy({ maxAttempts: 9 })).toThrow();
    expect(() => createOutboxRetryPolicy({ batchSize: 101 })).toThrow();
    expect(OUTBOX_DEFAULT_BATCH_SIZE).toBe(100);
  });

  it("rejects an invalid random source instead of producing an unbounded delay", () => {
    for (const value of [-0.1, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const policy = createOutboxRetryPolicy({ random: () => value });
      expect(() => policy.afterFailure({ priorAttempts: 0, nowMs: 0 })).toThrow();
    }
  });
});
