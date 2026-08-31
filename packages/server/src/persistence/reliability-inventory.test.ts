import { describe, expect, it } from "vitest";
import {
  AUTHORITATIVE_OUTBOX_FAMILIES,
  IDEMPOTENCY_RECEIPT_FAMILIES,
} from "./reliability-inventory.js";

describe("FT-13 closed persistence inventory", () => {
  it("enumerates exactly nine receipt families without treating durable facts as TTL receipts", () => {
    expect(IDEMPOTENCY_RECEIPT_FAMILIES).toHaveLength(9);
    expect(IDEMPOTENCY_RECEIPT_FAMILIES.map((entry) => entry.id)).toEqual([
      "generic-command", "deployment-command", "room-memory-command", "tool-safety-command",
      "project-command", "human-cancellation-command", "human-retry-command",
      "project-boundary-domain-receipt", "read-and-source-facts",
    ]);
    expect(new Set(IDEMPOTENCY_RECEIPT_FAMILIES.map((entry) => entry.id)).size).toBe(9);
    expect(IDEMPOTENCY_RECEIPT_FAMILIES.filter((entry) => entry.retention === "permanent")
      .map((entry) => entry.id)).toEqual([
        "project-boundary-domain-receipt", "read-and-source-facts",
      ]);
    expect(IDEMPOTENCY_RECEIPT_FAMILIES.filter((entry) => entry.requiresV27)
      .map((entry) => entry.id)).toEqual([
        "project-command", "human-cancellation-command", "human-retry-command",
      ]);
  });

  it("enumerates four durable post-commit ledgers without mislabeling cursor markers as delivery", () => {
    expect(AUTHORITATIVE_OUTBOX_FAMILIES).toHaveLength(4);
    expect(AUTHORITATIVE_OUTBOX_FAMILIES.map((entry) => entry.id)).toEqual([
      "central", "deployment-profile", "project-shadow", "room-cache-invalidation",
    ]);
    expect(new Set(AUTHORITATIVE_OUTBOX_FAMILIES.map((entry) => entry.table)).size).toBe(4);
    expect(AUTHORITATIVE_OUTBOX_FAMILIES.find((entry) => entry.id === "project-shadow"))
      .toMatchObject({ classification: "terminal-mirror-reserved", consumer: "central-mirror",
        deliveryContract: "central-terminal-mirror", maxAttempts: null,
        terminalState: "mirrored_from_central" });
    expect(AUTHORITATIVE_OUTBOX_FAMILIES.find((entry) => entry.id === "deployment-profile"))
      .toMatchObject({ classification: "authoritative-cursor-marker", requiresV27: true,
        deliveryContract: "authoritative-cursor-recovery", maxAttempts: null,
        terminalState: "dispatched_marker" });
  });

  it.each(IDEMPOTENCY_RECEIPT_FAMILIES)(
    "$id declares a closed key, decoder, stable boundary, and cleanup owner",
    (entry) => {
      expect(entry.scopeKey.length).toBeGreaterThan(0);
      expect(entry.resultDecoder.length).toBeGreaterThan(0);
      expect(entry.stableBoundary.length).toBeGreaterThan(0);
      expect(entry.cleanupAdapter.length).toBeGreaterThan(0);
      if (entry.retention === "permanent") {
        expect(entry.expiryColumn).toBeNull();
        expect(entry.cleanupAdapter).toBe("none-permanent");
      } else {
        expect(entry.expiryColumn).not.toBeNull();
        expect(entry.expiryIndex).not.toBeNull();
        expect(entry.fingerprint).not.toBeNull();
      }
    },
  );

  it.each(AUTHORITATIVE_OUTBOX_FAMILIES.filter(
    (entry) => entry.deliveryContract === "bounded-at-least-once",
  ))(
    "$id declares the bounded at-least-once terminal contract",
    (entry) => {
      expect(entry).toMatchObject({
        batchSize: 100,
        maxAttempts: 8,
        backlogWarningMs: 60_000,
        backlogCriticalMs: 5 * 60_000,
        terminalState: "dead_letter",
      });
      expect(entry.consumer.length).toBeGreaterThan(0);
    },
  );

  it("limits the independent bounded send/retry contract to actual delivery consumers", () => {
    expect(AUTHORITATIVE_OUTBOX_FAMILIES.filter(
      (entry) => entry.deliveryContract === "bounded-at-least-once",
    ).map((entry) => entry.id)).toEqual(["central", "room-cache-invalidation"]);
  });
});
