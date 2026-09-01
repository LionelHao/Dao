import { describe, expect, it } from "vitest";
import {
  consumeNotificationRateLimit,
  createNotificationRateLimitState,
  NOTIFICATION_RATE_LIMIT,
} from "./rate-limit.js";

describe("FT-12 notification connection rate limit", () => {
  it("returns a bounded retryAfterMs and resets only after the fixed window", () => {
    const state = createNotificationRateLimitState();
    for (let index = 0; index < NOTIFICATION_RATE_LIMIT.maxRequests; index += 1) {
      expect(consumeNotificationRateLimit(state, 1_000)).toEqual({ allowed: true });
    }
    expect(consumeNotificationRateLimit(state, 1_001)).toEqual({
      allowed: false,
      retryAfterMs: NOTIFICATION_RATE_LIMIT.windowMs - 1,
    });
    expect(consumeNotificationRateLimit(
      state,
      1_000 + NOTIFICATION_RATE_LIMIT.windowMs,
    )).toEqual({ allowed: true });
  });
});
