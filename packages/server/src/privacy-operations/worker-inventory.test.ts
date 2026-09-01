import { describe, expect, it } from "vitest";
import {
  assertClosedOperationsWorkerInventory,
  deriveOperationsAlert,
  OPERATIONS_WORKER_IDS,
  OPERATIONS_WORKER_INVENTORY,
} from "./worker-inventory.js";

describe("FT-14 closed worker operations inventory", () => {
  it("registers every required worker exactly once with finite queue/batch/timeout/retry/shutdown bounds", () => {
    expect(() => assertClosedOperationsWorkerInventory()).not.toThrow();
    expect(OPERATIONS_WORKER_INVENTORY.map((entry) => entry.workerId).sort()).toEqual([...OPERATIONS_WORKER_IDS].sort());
    for (const policy of OPERATIONS_WORKER_INVENTORY) {
      expect(policy.maxQueue).toBeGreaterThan(0);
      expect(policy.maxBatch).toBeGreaterThan(0);
      expect(policy.recoveryScan).toBe(true);
      expect(policy.metrics).toEqual(expect.arrayContaining(["queue_depth", "oldest_age", "attempt", "state"]));
    }
  });

  it("freezes business workers on archive while security cleanup and read-only operations continue", () => {
    const byId = new Map(OPERATIONS_WORKER_INVENTORY.map((policy) => [policy.workerId, policy]));
    expect(byId.get("notification")?.archiveBehavior).toBe("freeze_business");
    expect(byId.get("project_boundary_reminder")?.archiveBehavior).toBe("freeze_business");
    expect(byId.get("retention_janitor")?.archiveBehavior).toBe("continue_security_cleanup");
    expect(byId.get("room_export")?.archiveBehavior).toBe("read_only");
    expect(byId.get("room_export")).toMatchObject({
      maxActive: 2, maxQueue: 8, timeoutMs: 300_000,
    });
    expect(byId.get("diagnostics_generation")).toMatchObject({
      maxActive: 1, maxQueue: 16, timeoutMs: 30_000,
    });
  });

  it("emits only corpus-safe closed backlog/dead-letter metadata at exact thresholds", () => {
    const policy = OPERATIONS_WORKER_INVENTORY.find((entry) => entry.workerId === "outbox")!;
    expect(deriveOperationsAlert(policy, { observedAt: "2026-08-31T00:00:00.000Z", queueDepth: 1, oldestAgeMs: 59_999 })).toBeUndefined();
    expect(deriveOperationsAlert(policy, { observedAt: "2026-08-31T00:00:00.000Z", queueDepth: 2, oldestAgeMs: 60_000 })).toMatchObject({ severity: "warning", code: "backlog_warning" });
    expect(deriveOperationsAlert(policy, { observedAt: "2026-08-31T00:00:00.000Z", queueDepth: 3, oldestAgeMs: 300_000 })).toMatchObject({ severity: "critical", code: "backlog_critical" });
    expect(deriveOperationsAlert(policy, { observedAt: "2026-08-31T00:00:00.000Z", queueDepth: 1, oldestAgeMs: 0, deadLettered: true, attempt: 8 })).toEqual({
      workerId: "outbox", severity: "critical", code: "dead_letter", observedAt: "2026-08-31T00:00:00.000Z", queueDepth: 1, oldestAgeMs: 0, attempt: 8,
    });
    for (const attempt of [-1, 1.5, Number.NaN, policy.maxAttempts + 1]) {
      expect(() => deriveOperationsAlert(policy, {
        observedAt: "2026-08-31T00:00:00.000Z",
        queueDepth: 1,
        oldestAgeMs: 0,
        deadLettered: true,
        attempt,
      })).toThrow("attempt");
    }
  });
});
