export const IDEMPOTENCY_RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 500;

function nonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function idempotencyReceiptExpiresAt(acceptedAtMs: number): number {
  nonnegativeSafeInteger(acceptedAtMs, "acceptedAtMs");
  if (acceptedAtMs > Number.MAX_SAFE_INTEGER - IDEMPOTENCY_RECEIPT_TTL_MS) {
    throw new RangeError("idempotency receipt expiry exceeds the safe integer range");
  }
  return acceptedAtMs + IDEMPOTENCY_RECEIPT_TTL_MS;
}

export function isIdempotencyReceiptReplayable(nowMs: number, expiresAtMs: number): boolean {
  nonnegativeSafeInteger(nowMs, "nowMs");
  nonnegativeSafeInteger(expiresAtMs, "expiresAtMs");
  return nowMs < expiresAtMs;
}

export function requireIdempotencyCleanupLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > IDEMPOTENCY_CLEANUP_BATCH_SIZE) {
    throw new RangeError(
      `idempotency cleanup limit must be between 1 and ${IDEMPOTENCY_CLEANUP_BATCH_SIZE}`,
    );
  }
  return limit;
}
