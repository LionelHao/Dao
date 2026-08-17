import { describe, expect, it, vi } from "vitest";
import type { AgentExecution } from "@native-im/core";
import { createHumanPreemptionRuntime } from "./human-preemption-runtime.js";

function cancelledExecution(id: string, sourceMessageId: string): AgentExecution {
  return {
    id,
    roomId: "room-1",
    sourceMessageId: "message-old",
    requesterId: "human-1",
    agentId: "agent-1",
    toolName: "openai.responses",
    status: "cancelled",
    actionCategory: "waiting_upstream",
    currentAttemptSeq: 1,
    retryCycle: 1,
    retryOrdinal: 1,
    recoveryCursor: 2,
    queuedAt: "2026-08-17T00:00:00.000Z",
    startedAt: "2026-08-17T00:00:01.000Z",
    updatedAt: "2026-08-17T00:00:02.000Z",
    completedAt: "2026-08-17T00:00:02.000Z",
    cancellationReason: `human_preempted:${sourceMessageId}`,
  };
}

function cancellationResult(sourceMessageId: string) {
  return {
    kind: "human-fence-cancelled",
    notice: {
      roomId: "room-1",
      sourceHumanMessageId: sourceMessageId,
      cancelledExecutionIds: [`execution-${sourceMessageId}`],
      rerouteStatus: "queued",
      occurredAt: "2026-08-17T00:00:02.000Z",
    },
    cancelledExecutions: [cancelledExecution(`execution-${sourceMessageId}`, sourceMessageId)],
  } as const;
}

function routeResult(sourceMessageId: string) {
  return {
    kind: "human-fence-route",
    roomId: "room-1",
    sourceHumanMessageId: sourceMessageId,
    routeJobId: `route-${sourceMessageId}`,
    replayed: false,
  } as const;
}

describe("human preemption runtime", () => {
  it("serializes fences and propagates cancellation only after the authority commit", async () => {
    const order: string[] = [];
    const executeRuntime = vi.fn(async (operation: { type: string; sourceHumanMessageId?: string }) => {
      const source = operation.sourceHumanMessageId!;
      order.push(`${operation.type}:${source}`);
      return operation.type === "runtime.cancel-for-human-fence"
        ? cancellationResult(source)
        : routeResult(source);
    });
    const applyCommittedHumanFence = vi.fn((executions: readonly AgentExecution[]) => {
      order.push(`abort:${executions[0]?.cancellationReason}`);
    });
    const notifyRoute = vi.fn((_roomId: string, sourceMessageId: string) => {
      order.push(`notify:${sourceMessageId}`);
      return true;
    });
    const runtime = createHumanPreemptionRuntime({
      worker: { executeRuntime } as never,
      runtime: { applyCommittedHumanFence },
      notifyRoute,
    });

    await Promise.all([runtime.handle("human-1"), runtime.handle("human-2")]);

    expect(order).toEqual([
      "runtime.cancel-for-human-fence:human-1",
      "abort:human_preempted:human-1",
      "runtime.create-route-after-human-fence:human-1",
      "notify:human-1",
      "runtime.cancel-for-human-fence:human-2",
      "abort:human_preempted:human-2",
      "runtime.create-route-after-human-fence:human-2",
      "notify:human-2",
    ]);
  });

  it("recovers every durable human message without a completed fence route", async () => {
    let scans = 0;
    const executeRuntime = vi.fn(async (operation: { type: string; sourceHumanMessageId?: string }) => {
      if (operation.type === "runtime.list-pending-human-fences") {
        scans += 1;
        return {
          kind: "pending-human-fences",
          sourceHumanMessageIds: scans === 1 ? ["human-recover"] : [],
        };
      }
      const source = operation.sourceHumanMessageId!;
      return operation.type === "runtime.cancel-for-human-fence"
        ? cancellationResult(source)
        : routeResult(source);
    });
    const runtime = createHumanPreemptionRuntime({
      worker: { executeRuntime } as never,
      runtime: { applyCommittedHumanFence: vi.fn() },
      notifyRoute: vi.fn(() => true),
    });

    await expect(runtime.recover()).resolves.toBeUndefined();
    expect(executeRuntime.mock.calls.map(([operation]) => operation.type)).toEqual([
      "runtime.list-pending-human-fences",
      "runtime.cancel-for-human-fence",
      "runtime.create-route-after-human-fence",
      "runtime.list-pending-human-fences",
    ]);
  });

  it("keeps the in-memory queue bounded while leaving overflow recoverable from SQLite", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const executeRuntime = vi.fn(async (operation: { type: string; sourceHumanMessageId?: string }) => {
      if (operation.type === "runtime.cancel-for-human-fence") await blocked;
      const source = operation.sourceHumanMessageId!;
      return operation.type === "runtime.cancel-for-human-fence"
        ? cancellationResult(source)
        : routeResult(source);
    });
    const runtime = createHumanPreemptionRuntime({
      worker: { executeRuntime } as never,
      runtime: { applyCommittedHumanFence: vi.fn() },
      notifyRoute: vi.fn(() => true),
      maxPending: 1,
    });

    const accepted = runtime.handle("human-bounded");
    await expect(runtime.handle("human-overflow")).rejects.toThrow("queue is full");
    release();
    await expect(accepted).resolves.toMatchObject({ sourceHumanMessageId: "human-bounded" });
  });
});
