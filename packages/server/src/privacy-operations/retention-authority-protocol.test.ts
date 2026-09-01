import { describe, expect, it } from "vitest";
import {
  isAuthorityWorkerRequest,
  isAuthorityWorkerResponse,
} from "../persistence/worker-protocol.js";
import {
  isPrivacyRetentionAuthorityResult,
  isPrivacyRetentionRunBatchOperation,
} from "./retention-authority-protocol.js";

const now = Date.parse("2026-08-31T00:00:00.000Z");

describe("FT-14 privacy retention AuthorityWorker protocol", () => {
  it("accepts only the closed one-batch operation with a limit at most 100", () => {
    const operation = {
      version: 1,
      type: "privacy.retention.run-batch",
      trigger: "startup_recovery",
      now,
      limit: 100,
    };
    expect(isPrivacyRetentionRunBatchOperation(operation)).toBe(true);
    expect(isAuthorityWorkerRequest({
      type: "authority.privacy-retention",
      requestId: "retention-1",
      operation,
    })).toBe(true);
    expect(isPrivacyRetentionRunBatchOperation({ ...operation, limit: 101 })).toBe(false);
    expect(isPrivacyRetentionRunBatchOperation({ ...operation, limit: 0 })).toBe(false);
    expect(isPrivacyRetentionRunBatchOperation({ ...operation, now: Number.MAX_SAFE_INTEGER })).toBe(false);
    expect(isPrivacyRetentionRunBatchOperation({ ...operation, cursor: "secret-candidate" })).toBe(false);
    expect(isAuthorityWorkerRequest({
      type: "authority.privacy-retention",
      requestId: "retention-1",
      operation: { ...operation, trigger: "manual" },
    })).toBe(false);
  });

  it("accepts only closed aggregate counts without candidate or payload metadata", () => {
    const result = {
      kind: "privacy-retention-batch",
      processed: 2,
      purged: 1,
      retained: 1,
      retried: 0,
      deadLettered: 0,
      hasMore: true,
      queueDepth: 4,
      oldestAgeMs: 5_000,
    };
    expect(isPrivacyRetentionAuthorityResult(result)).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.privacy-retention-result",
      requestId: "retention-1",
      result,
    })).toBe(true);
    expect(isPrivacyRetentionAuthorityResult({ ...result, processed: 3 })).toBe(false);
    expect(isPrivacyRetentionAuthorityResult({ ...result, hasMore: false })).toBe(true);
    expect(isPrivacyRetentionAuthorityResult({ ...result, candidateId: "context-secret" })).toBe(false);
    expect(isPrivacyRetentionAuthorityResult({
      ...result,
      queueDepth: 0,
      hasMore: false,
      oldestAgeMs: 1,
    })).toBe(false);
    expect(isPrivacyRetentionAuthorityResult({
      ...result,
      queueDepth: 0,
      hasMore: true,
      oldestAgeMs: 0,
    })).toBe(false);
  });

  it("distinguishes a runnable tail from a durable future-retry tail", () => {
    const futureRetry = {
      kind: "privacy-retention-batch",
      processed: 1,
      purged: 0,
      retained: 0,
      retried: 1,
      deadLettered: 0,
      hasMore: false,
      queueDepth: 1,
      oldestAgeMs: 2_000,
    };
    expect(isPrivacyRetentionAuthorityResult(futureRetry)).toBe(true);
    expect(isAuthorityWorkerResponse({
      type: "authority.privacy-retention-result",
      requestId: "retention-future-retry",
      result: futureRetry,
    })).toBe(true);
  });
});
