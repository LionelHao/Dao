export const OUTBOX_DEFAULT_BASE_DELAY_MS = 250;
export const OUTBOX_DEFAULT_CAP_DELAY_MS = 30_000;
export const OUTBOX_DEFAULT_MAX_ATTEMPTS = 8;
export const OUTBOX_DEFAULT_BATCH_SIZE = 100;

const OUTBOX_HARD_CAP_DELAY_MS = 30_000;
const OUTBOX_HARD_MAX_ATTEMPTS = 8;
const OUTBOX_HARD_BATCH_SIZE = 100;

export type OutboxFailureDecision = Readonly<{
  kind: "retry";
  attempt: number;
  delayMs: number;
  availableAtMs: number;
}> | Readonly<{
  kind: "dead-letter";
  attempt: number;
}>;

export interface OutboxRetryPolicy {
  readonly batchSize: number;
  readonly maxAttempts: number;
  afterFailure(input: Readonly<{ priorAttempts: number; nowMs: number }>): OutboxFailureDecision;
}

export interface OutboxRetryPolicyOptions {
  readonly baseDelayMs?: number;
  readonly capDelayMs?: number;
  readonly maxAttempts?: number;
  readonly batchSize?: number;
  readonly random?: () => number;
}

function positiveSafeInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer at most ${maximum}`);
  }
  return value;
}

export function createOutboxRetryPolicy(
  options: OutboxRetryPolicyOptions = {},
): OutboxRetryPolicy {
  const baseDelayMs = positiveSafeInteger(
    options.baseDelayMs ?? OUTBOX_DEFAULT_BASE_DELAY_MS,
    "baseDelayMs",
    OUTBOX_HARD_CAP_DELAY_MS,
  );
  const capDelayMs = positiveSafeInteger(
    options.capDelayMs ?? OUTBOX_DEFAULT_CAP_DELAY_MS,
    "capDelayMs",
    OUTBOX_HARD_CAP_DELAY_MS,
  );
  if (baseDelayMs > capDelayMs) {
    throw new RangeError("baseDelayMs must not exceed capDelayMs");
  }
  const maxAttempts = positiveSafeInteger(
    options.maxAttempts ?? OUTBOX_DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
    OUTBOX_HARD_MAX_ATTEMPTS,
  );
  const batchSize = positiveSafeInteger(
    options.batchSize ?? OUTBOX_DEFAULT_BATCH_SIZE,
    "batchSize",
    OUTBOX_HARD_BATCH_SIZE,
  );
  const random = options.random ?? Math.random;

  return Object.freeze({
    batchSize,
    maxAttempts,
    afterFailure(input: Readonly<{ priorAttempts: number; nowMs: number }>): OutboxFailureDecision {
      if (!Number.isSafeInteger(input.priorAttempts) || input.priorAttempts < 0 ||
          !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
        throw new RangeError("outbox failure state is invalid");
      }
      const attempt = input.priorAttempts + 1;
      if (attempt >= maxAttempts) return Object.freeze({ kind: "dead-letter", attempt });
      const jitter = random();
      if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) {
        throw new RangeError("outbox random source must return a finite value in [0, 1)");
      }
      const exponentialCeiling = baseDelayMs * 2 ** input.priorAttempts;
      const ceilingMs = Math.min(capDelayMs, exponentialCeiling);
      const delayMs = Math.floor(ceilingMs * jitter);
      if (input.nowMs > Number.MAX_SAFE_INTEGER - delayMs) {
        throw new RangeError("outbox retry timestamp exceeds the safe integer range");
      }
      return Object.freeze({
        kind: "retry",
        attempt,
        delayMs,
        availableAtMs: input.nowMs + delayMs,
      });
    },
  });
}
