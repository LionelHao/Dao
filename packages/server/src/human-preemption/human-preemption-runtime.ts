import {
  isAgentExecution,
  isHumanPreemptionNotice,
  type AgentExecution,
  type HumanPreemptionNotice,
} from "@native-im/core";
import type { AgentRuntimeService } from "../agent-runtime/agent-runtime-service.js";
import type { WorkerDatabaseClient } from "../persistence/worker-database-client.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CancelledFence {
  readonly notice: HumanPreemptionNotice;
  readonly cancelledExecutions: readonly AgentExecution[];
}

interface CreatedFenceRoute {
  readonly roomId: string;
  readonly sourceHumanMessageId: string;
  readonly routeJobId: string;
  readonly replayed: boolean;
}

export interface HumanPreemptionRuntime {
  handle(sourceHumanMessageId: string): Promise<CreatedFenceRoute>;
  recover(): Promise<void>;
}

export interface CreateHumanPreemptionRuntimeOptions {
  readonly worker: Pick<WorkerDatabaseClient, "executeRuntime">;
  readonly runtime: Pick<AgentRuntimeService, "applyCommittedHumanFence">;
  readonly notifyRoute: (roomId: string, sourceMessageId: string) => boolean;
  readonly maxPending?: number;
  readonly maxRecoveryBatches?: number;
}

function cancelledResult(value: unknown): CancelledFence {
  if (!record(value) || value.kind !== "human-fence-cancelled" ||
      !isHumanPreemptionNotice(value.notice) || !Array.isArray(value.cancelledExecutions) ||
      !value.cancelledExecutions.every(isAgentExecution) ||
      value.cancelledExecutions.some((execution) => execution.status !== "cancelled")) {
    throw new Error("Authority human fence cancellation result was malformed");
  }
  return {
    notice: value.notice,
    cancelledExecutions: value.cancelledExecutions,
  };
}

function routeResult(value: unknown): CreatedFenceRoute {
  if (!record(value) || value.kind !== "human-fence-route" ||
      typeof value.roomId !== "string" || value.roomId.trim().length === 0 ||
      typeof value.sourceHumanMessageId !== "string" || value.sourceHumanMessageId.trim().length === 0 ||
      typeof value.routeJobId !== "string" || value.routeJobId.trim().length === 0 ||
      typeof value.replayed !== "boolean") {
    throw new Error("Authority human fence route result was malformed");
  }
  return value as unknown as CreatedFenceRoute;
}

function pendingResult(value: unknown): readonly string[] {
  if (!record(value) || value.kind !== "pending-human-fences" ||
      !Array.isArray(value.sourceHumanMessageIds) || value.sourceHumanMessageIds.length > 256 ||
      !value.sourceHumanMessageIds.every((entry) => typeof entry === "string" && entry.trim().length > 0) ||
      new Set(value.sourceHumanMessageIds).size !== value.sourceHumanMessageIds.length) {
    throw new Error("Authority pending human fence result was malformed");
  }
  return value.sourceHumanMessageIds;
}

export function createHumanPreemptionRuntime(
  options: CreateHumanPreemptionRuntimeOptions,
): HumanPreemptionRuntime {
  const maxPending = options.maxPending ?? 256;
  const maxRecoveryBatches = options.maxRecoveryBatches ?? 32;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 256 ||
      !Number.isSafeInteger(maxRecoveryBatches) || maxRecoveryBatches < 1 || maxRecoveryBatches > 32) {
    throw new TypeError("Human preemption runtime bounds were invalid");
  }
  let tail = Promise.resolve();
  let pending = 0;

  const process = async (sourceHumanMessageId: string): Promise<CreatedFenceRoute> => {
    const cancelled = cancelledResult(await options.worker.executeRuntime({
      type: "runtime.cancel-for-human-fence",
      sourceHumanMessageId,
      now: Date.now(),
    }));
    // The AuthorityWorker cancellation transaction is committed before any AbortSignal propagates.
    options.runtime.applyCommittedHumanFence(cancelled.cancelledExecutions);
    const route = routeResult(await options.worker.executeRuntime({
      type: "runtime.create-route-after-human-fence",
      sourceHumanMessageId,
      now: Date.now(),
    }));
    options.notifyRoute(route.roomId, route.sourceHumanMessageId);
    return route;
  };

  const service: HumanPreemptionRuntime = {
    handle(sourceHumanMessageId) {
      if (sourceHumanMessageId.trim().length === 0) {
        return Promise.reject(new TypeError("Human fence message id must be non-empty"));
      }
      if (pending >= maxPending) {
        return Promise.reject(new Error("Human preemption queue is full; durable recovery is required"));
      }
      pending += 1;
      const result = tail.then(() => process(sourceHumanMessageId));
      tail = result.then(() => undefined, () => undefined).finally(() => {
        pending -= 1;
      });
      return result;
    },
    async recover() {
      for (let batch = 0; batch < maxRecoveryBatches; batch += 1) {
        const sourceHumanMessageIds = pendingResult(await options.worker.executeRuntime({
          type: "runtime.list-pending-human-fences",
          now: Date.now(),
        }));
        if (sourceHumanMessageIds.length === 0) return;
        for (const sourceHumanMessageId of sourceHumanMessageIds) {
          await service.handle(sourceHumanMessageId);
        }
      }
      throw new Error("Human preemption recovery exceeded its bounded batch limit");
    },
  };
  return Object.freeze(service);
}
