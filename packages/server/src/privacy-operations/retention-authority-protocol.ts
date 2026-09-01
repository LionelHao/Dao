import type {
  HostedOperationsTrigger,
  HostedRetentionBatchResult,
} from "./operations-runtime.js";

export const PRIVACY_RETENTION_MAX_BATCH_SIZE = 100 as const;

export type PrivacyRetentionRunBatchOperation = Readonly<{
  version: 1;
  type: "privacy.retention.run-batch";
  trigger: HostedOperationsTrigger;
  now: number;
  limit: number;
}>;

export type PrivacyRetentionAuthorityResult = Readonly<{
  kind: "privacy-retention-batch";
}> & HostedRetentionBatchResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCanonicalTimeMs(value: unknown): value is number {
  if (!isNonNegativeInteger(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() === value;
}

export function isPrivacyRetentionRunBatchOperation(
  value: unknown,
): value is PrivacyRetentionRunBatchOperation {
  return isRecord(value) && hasExactKeys(value, ["version", "type", "trigger", "now", "limit"]) &&
    value.version === 1 && value.type === "privacy.retention.run-batch" &&
    (value.trigger === "startup_recovery" || value.trigger === "periodic") &&
    isCanonicalTimeMs(value.now) && Number.isSafeInteger(value.limit) &&
    Number(value.limit) >= 1 && Number(value.limit) <= PRIVACY_RETENTION_MAX_BATCH_SIZE;
}

export function isPrivacyRetentionAuthorityResult(
  value: unknown,
): value is PrivacyRetentionAuthorityResult {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "processed", "purged", "retained", "retried", "deadLettered",
    "hasMore", "queueDepth", "oldestAgeMs",
  ]) || value.kind !== "privacy-retention-batch" || typeof value.hasMore !== "boolean") {
    return false;
  }
  const counts = [
    value.processed, value.purged, value.retained, value.retried,
    value.deadLettered, value.queueDepth, value.oldestAgeMs,
  ];
  return counts.every(isNonNegativeInteger) && Number(value.processed) <= PRIVACY_RETENTION_MAX_BATCH_SIZE &&
    Number(value.processed) === Number(value.purged) + Number(value.retained) +
      Number(value.retried) + Number(value.deadLettered) &&
    // hasMore means a tail is runnable at this operation's `now`; queueDepth is the
    // durable tail and may contain only future retry rows. An empty durable queue can
    // never be runnable and has no meaningful oldest age.
    (Number(value.queueDepth) > 0 ||
      (value.hasMore === false && Number(value.oldestAgeMs) === 0));
}
