export const NOTIFICATION_RATE_LIMIT = Object.freeze({
  maxRequests: 64,
  windowMs: 10_000,
});

export type NotificationRateLimitState = {
  windowStartedAt: number | null;
  requestCount: number;
};

export function createNotificationRateLimitState(): NotificationRateLimitState {
  return { windowStartedAt: null, requestCount: 0 };
}

export function consumeNotificationRateLimit(
  state: NotificationRateLimitState,
  now: number,
): Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterMs: number }> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("Notification rate-limit time was invalid");
  }
  if (state.windowStartedAt === null || now < state.windowStartedAt ||
      now - state.windowStartedAt >= NOTIFICATION_RATE_LIMIT.windowMs) {
    state.windowStartedAt = now;
    state.requestCount = 1;
    return Object.freeze({ allowed: true as const });
  }
  if (state.requestCount < NOTIFICATION_RATE_LIMIT.maxRequests) {
    state.requestCount += 1;
    return Object.freeze({ allowed: true as const });
  }
  return Object.freeze({ allowed: false as const,
    retryAfterMs: Math.max(1, NOTIFICATION_RATE_LIMIT.windowMs - (now - state.windowStartedAt)) });
}
