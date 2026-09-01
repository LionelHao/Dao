import {
  deriveOperationsAlert,
  OPERATIONS_WORKER_INVENTORY,
  type OperationsAlert,
} from "./worker-inventory.js";

const RETENTION_POLICY = (() => {
  const policy = OPERATIONS_WORKER_INVENTORY.find(
    (entry) => entry.workerId === "retention_janitor",
  );
  if (policy === undefined) {
    throw new TypeError("retention_janitor is missing from the closed worker inventory");
  }
  return policy;
})();

export type HostedOperationsTrigger = "startup_recovery" | "periodic";

export type HostedRetentionBatchResult = Readonly<{
  processed: number;
  purged: number;
  retained: number;
  retried: number;
  deadLettered: number;
  /** True only when another candidate is runnable at this batch's authority clock. */
  hasMore: boolean;
  /** Durable queued candidates, including retries whose available_at is in the future. */
  queueDepth: number;
  oldestAgeMs: number;
}>;

export interface HostedRetentionBatchPort {
  /** Implemented by the AuthorityWorker single writer; performs at most limit candidates. */
  runBatch(input: Readonly<{
    workerId: "retention_janitor";
    limit: number;
    nowMs: number;
    trigger: HostedOperationsTrigger;
    signal: AbortSignal;
  }>): Promise<HostedRetentionBatchResult>;
}

export type OperationsRuntimeAlert = OperationsAlert | Readonly<{
  workerId: "retention_janitor";
  severity: "critical";
  code: "worker_timeout" | "shutdown_timeout" | "invalid_authority_result";
  observedAt: string;
}>;

export interface OperationsRuntimeAlertSink {
  emit(alert: OperationsRuntimeAlert): Promise<void> | void;
}

export type HostedRetentionRunResult =
  | Readonly<{ status: "completed" | "needs_reschedule" } & HostedRetentionBatchResult>
  | Readonly<{ status: "already_running" | "closed" | "timed_out" }>
  | Readonly<{ status: "failed"; failureCode: "authority_unavailable" | "invalid_authority_result" }>;

type BatchSettlement =
  | Readonly<{ kind: "completed"; result: HostedRetentionBatchResult }>
  | Readonly<{ kind: "failed"; failureCode: "authority_unavailable" | "invalid_authority_result" }>;

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCanonicalTimeMs(value: unknown): value is number {
  if (!isNonNegativeInteger(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getTime() === value;
}

function validBatchResult(result: HostedRetentionBatchResult): boolean {
  const counts = [result.processed, result.purged, result.retained, result.retried,
    result.deadLettered, result.queueDepth, result.oldestAgeMs];
  return counts.every(isNonNegativeInteger) && result.processed <= RETENTION_POLICY.maxBatch &&
    result.processed === result.purged + result.retained + result.retried + result.deadLettered &&
    typeof result.hasMore === "boolean";
}

function validBound(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a positive safe integer at most ${maximum}`);
  }
  return value;
}

export function createHostedRetentionOperationsAdapter(options: Readonly<{
  batchPort: HostedRetentionBatchPort;
  alertSink?: OperationsRuntimeAlertSink;
  timeoutMs?: number;
  shutdownDrainMs?: number;
}>): Readonly<{
  run(trigger: HostedOperationsTrigger, nowMs: number): Promise<HostedRetentionRunResult>;
  shutdown(): Promise<Readonly<{ status: "drained" | "shutdown_timeout" }>>;
}> {
  const timeoutMs = validBound(
    options.timeoutMs ?? RETENTION_POLICY.timeoutMs,
    RETENTION_POLICY.timeoutMs,
    "retention worker timeoutMs",
  );
  const shutdownDrainMs = validBound(
    options.shutdownDrainMs ?? RETENTION_POLICY.shutdownDrainMs,
    RETENTION_POLICY.shutdownDrainMs,
    "retention worker shutdownDrainMs",
  );
  const alertSink = options.alertSink ?? { emit() {} };
  let closed = false;
  let activeController: AbortController | undefined;
  let activeDrain: Promise<BatchSettlement> | undefined;

  async function emit(alert: OperationsRuntimeAlert): Promise<void> {
    try {
      await alertSink.emit(Object.freeze(alert));
    } catch {
      // Operational telemetry is not an authority writer and cannot alter a batch result.
    }
  }

  return Object.freeze({
    async run(trigger, nowMs) {
      if (closed) return Object.freeze({ status: "closed" as const });
      if (activeDrain !== undefined) return Object.freeze({ status: "already_running" as const });
      if ((trigger !== "startup_recovery" && trigger !== "periodic") ||
          !isCanonicalTimeMs(nowMs)) {
        return Object.freeze({ status: "failed" as const, failureCode: "invalid_authority_result" as const });
      }

      const controller = new AbortController();
      activeController = controller;
      const settlement: Promise<BatchSettlement> = Promise.resolve().then(async () => {
        try {
          const result = await options.batchPort.runBatch({
            workerId: "retention_janitor",
            limit: RETENTION_POLICY.maxBatch,
            nowMs,
            trigger,
            signal: controller.signal,
          });
          return validBatchResult(result)
            ? Object.freeze({ kind: "completed" as const, result: Object.freeze(result) })
            : Object.freeze({ kind: "failed" as const, failureCode: "invalid_authority_result" as const });
        } catch {
          return Object.freeze({ kind: "failed" as const, failureCode: "authority_unavailable" as const });
        }
      });
      const drain = settlement.finally(() => {
        if (activeDrain === drain) {
          activeDrain = undefined;
          activeController = undefined;
        }
      });
      activeDrain = drain;

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => {
          controller.abort(new Error("retention worker timeout"));
          resolve("timeout");
        }, timeoutMs);
      });
      const winner = await Promise.race([settlement, timeout]);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (winner === "timeout") {
        await emit({
          workerId: "retention_janitor",
          severity: "critical",
          code: "worker_timeout",
          observedAt: new Date(nowMs).toISOString(),
        });
        return Object.freeze({ status: "timed_out" as const });
      }
      if (winner.kind === "failed") {
        if (winner.failureCode === "invalid_authority_result") {
          await emit({
            workerId: "retention_janitor",
            severity: "critical",
            code: "invalid_authority_result",
            observedAt: new Date(nowMs).toISOString(),
          });
        }
        return Object.freeze({ status: "failed" as const, failureCode: winner.failureCode });
      }

      const backlogAlert = deriveOperationsAlert(RETENTION_POLICY, {
        observedAt: new Date(nowMs).toISOString(),
        queueDepth: winner.result.queueDepth,
        oldestAgeMs: winner.result.oldestAgeMs,
        ...(winner.result.deadLettered > 0 ? { deadLettered: true } : {}),
      });
      if (backlogAlert !== undefined) await emit(backlogAlert);
      return Object.freeze({
        status: winner.result.hasMore ? "needs_reschedule" as const : "completed" as const,
        ...winner.result,
      });
    },
    async shutdown() {
      closed = true;
      activeController?.abort(new Error("retention worker shutdown"));
      const drain = activeDrain;
      if (drain === undefined) return Object.freeze({ status: "drained" as const });
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), shutdownDrainMs);
      });
      const winner = await Promise.race([drain.then(() => "drained" as const), timeout]);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (winner === "timeout") {
        await emit({
          workerId: "retention_janitor",
          severity: "critical",
          code: "shutdown_timeout",
          observedAt: new Date().toISOString(),
        });
        return Object.freeze({ status: "shutdown_timeout" as const });
      }
      return Object.freeze({ status: "drained" as const });
    },
  });
}
