export const OPERATIONS_WORKER_INVENTORY_VERSION = "dao.operations-workers.v1" as const;

export const OPERATIONS_WORKER_IDS = [
  "agent_runtime",
  "diagnostics_generation",
  "idempotency_janitor",
  "memory_steward",
  "notification",
  "outbox",
  "project_boundary_reminder",
  "repair_snapshot",
  "retention_janitor",
  "room_export",
  "route",
] as const;

export type OperationsWorkerId = typeof OPERATIONS_WORKER_IDS[number];

export type OperationsWorkerPolicy = Readonly<{
  workerId: OperationsWorkerId;
  maxQueue: number;
  maxActive: number;
  maxBatch: number;
  timeoutMs: number;
  maxAttempts: number;
  recoveryScan: true;
  shutdownDrainMs: number;
  backlogWarningMs: number;
  backlogCriticalMs: number;
  archiveBehavior: "continue_security_cleanup" | "freeze_business" | "read_only";
  terminalState: "dead_letter" | "failed" | "human_review";
  metrics: readonly ("attempt" | "backlog" | "duration" | "oldest_age" | "queue_depth" | "state")[];
}>;

const shared = Object.freeze({
  maxAttempts: 8,
  recoveryScan: true as const,
  shutdownDrainMs: 30_000,
  backlogWarningMs: 60_000,
  backlogCriticalMs: 300_000,
  metrics: Object.freeze(["attempt", "backlog", "duration", "oldest_age", "queue_depth", "state"] as const),
});

export const OPERATIONS_WORKER_INVENTORY: readonly OperationsWorkerPolicy[] = Object.freeze([
  { workerId: "agent_runtime", maxQueue: 256, maxActive: 8, maxBatch: 256, timeoutMs: 120_000, ...shared, archiveBehavior: "freeze_business", terminalState: "human_review" },
  { workerId: "diagnostics_generation", maxQueue: 16, maxActive: 1, maxBatch: 10_000, timeoutMs: 30_000, ...shared, archiveBehavior: "read_only", terminalState: "failed" },
  { workerId: "idempotency_janitor", maxQueue: 1, maxActive: 1, maxBatch: 500, timeoutMs: 30_000, ...shared, archiveBehavior: "continue_security_cleanup", terminalState: "dead_letter" },
  { workerId: "memory_steward", maxQueue: 256, maxActive: 4, maxBatch: 100, timeoutMs: 120_000, ...shared, archiveBehavior: "freeze_business", terminalState: "dead_letter" },
  { workerId: "notification", maxQueue: 1_000, maxActive: 4, maxBatch: 100, timeoutMs: 30_000, ...shared, archiveBehavior: "freeze_business", terminalState: "dead_letter" },
  { workerId: "outbox", maxQueue: 10_000, maxActive: 8, maxBatch: 100, timeoutMs: 30_000, ...shared, archiveBehavior: "continue_security_cleanup", terminalState: "dead_letter" },
  { workerId: "project_boundary_reminder", maxQueue: 1_000, maxActive: 4, maxBatch: 100, timeoutMs: 30_000, ...shared, archiveBehavior: "freeze_business", terminalState: "dead_letter" },
  { workerId: "repair_snapshot", maxQueue: 16, maxActive: 4, maxBatch: 256, timeoutMs: 120_000, ...shared, archiveBehavior: "read_only", terminalState: "failed" },
  { workerId: "retention_janitor", maxQueue: 1, maxActive: 1, maxBatch: 100, timeoutMs: 30_000, ...shared, archiveBehavior: "continue_security_cleanup", terminalState: "dead_letter" },
  { workerId: "room_export", maxQueue: 8, maxActive: 2, maxBatch: 256, timeoutMs: 300_000, ...shared, archiveBehavior: "read_only", terminalState: "failed" },
  { workerId: "route", maxQueue: 256, maxActive: 8, maxBatch: 256, timeoutMs: 60_000, ...shared, archiveBehavior: "freeze_business", terminalState: "dead_letter" },
]);

export function requireOperationsWorkerPolicy(workerId: OperationsWorkerId): OperationsWorkerPolicy {
  const policy = OPERATIONS_WORKER_INVENTORY.find((candidate) => candidate.workerId === workerId);
  if (policy === undefined) throw new TypeError("operations worker policy is missing");
  return policy;
}

export type OperationsAlert = Readonly<{
  workerId: OperationsWorkerId;
  severity: "warning" | "critical";
  code: "backlog_warning" | "backlog_critical" | "dead_letter" | "recovery_failed";
  observedAt: string;
  queueDepth: number;
  oldestAgeMs: number;
  attempt?: number;
}>;

export function assertClosedOperationsWorkerInventory(
  inventory: readonly OperationsWorkerPolicy[] = OPERATIONS_WORKER_INVENTORY,
): void {
  const ids = inventory.map((entry) => entry.workerId);
  if (ids.length !== OPERATIONS_WORKER_IDS.length || new Set(ids).size !== ids.length ||
      [...ids].sort().join("\0") !== [...OPERATIONS_WORKER_IDS].sort().join("\0")) {
    throw new TypeError("operations worker inventory is incomplete or duplicated");
  }
  for (const entry of inventory) {
    for (const [key, value] of Object.entries(entry)) {
      if (key.startsWith("max") || key.endsWith("Ms")) {
        if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError("worker bounds must be finite positive integers");
      }
    }
    if (entry.backlogWarningMs >= entry.backlogCriticalMs) {
      throw new TypeError("worker backlog or batch policy is invalid");
    }
  }
}

export function deriveOperationsAlert(
  policy: OperationsWorkerPolicy,
  input: Readonly<{ observedAt: string; queueDepth: number; oldestAgeMs: number; deadLettered?: boolean; attempt?: number }>,
): OperationsAlert | undefined {
  if (!Number.isSafeInteger(input.queueDepth) || input.queueDepth < 0 ||
      !Number.isSafeInteger(input.oldestAgeMs) || input.oldestAgeMs < 0 ||
      !Number.isFinite(Date.parse(input.observedAt)) ||
      new Date(input.observedAt).toISOString() !== input.observedAt) {
    throw new TypeError("operations metric is invalid");
  }
  if (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) ||
      input.attempt < 0 || input.attempt > policy.maxAttempts)) {
    throw new TypeError("operations attempt is invalid");
  }
  const base = { workerId: policy.workerId, observedAt: input.observedAt, queueDepth: input.queueDepth, oldestAgeMs: input.oldestAgeMs };
  if (input.deadLettered === true) return { ...base, severity: "critical", code: "dead_letter", ...(input.attempt === undefined ? {} : { attempt: input.attempt }) };
  if (input.oldestAgeMs >= policy.backlogCriticalMs) return { ...base, severity: "critical", code: "backlog_critical" };
  if (input.oldestAgeMs >= policy.backlogWarningMs) return { ...base, severity: "warning", code: "backlog_warning" };
  return undefined;
}
