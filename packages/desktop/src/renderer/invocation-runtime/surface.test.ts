import { describe, expect, it, vi } from "vitest";
import type { InvocationBridge, InvocationStateEnvelope, InvocationSurfaceState } from "../../invocation-runtime/contracts.js";
import { mountInvocationSurface } from "./surface.js";

const execution = {
  executionId: "execution-1", intentId: "intent-1", lineageId: "lineage-1", executionOrdinal: 1,
  roomId: "room-1", agentId: "agent-1", snapshotId: "snapshot-1", providerId: "provider-1",
  modelId: "model-1", status: "running" as const, phase: "waiting_confirmation" as const,
  currentAttemptSeq: 1, version: 2, queuedAt: "2026-08-25T00:00:00.000Z",
  startedAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
};
function state(overrides: Partial<InvocationSurfaceState> = {}): InvocationSurfaceState {
  return { roomId: "room-1", connection: { status: "online" }, executions: [{ execution,
    attempts: [], sourceLifecycle: "active", preservedDispatchIds: [] }], retries: [],
    cancellations: [], projectBoundaries: [], operations: [], ...overrides };
}

describe("production Invocation surface", () => {
  it("submits scoped expectedVersion control but waits for authority state before changing the card", async () => {
    let listener: ((value: InvocationStateEnvelope) => void) | undefined;
    const cancel = vi.fn().mockResolvedValue({ requestId: "cancel-1", state: state({ operations: [{
      status: "acknowledged", requestId: "cancel-1", kind: "cancel", executionId: "execution-1",
      expectedVersion: 2,
    }] }) });
    const bridge: InvocationBridge = { getSurface: vi.fn().mockResolvedValue(state()), cancel,
      retry: vi.fn(), onStateChanged: (next) => { listener = next; return vi.fn(); } };
    const root = document.createElement("div");
    document.body.append(root);
    mountInvocationSurface(root, bridge, "room-1");
    await vi.waitFor(() => expect(root.textContent).toContain("运行中 · 等待确认"));
    root.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ roomId: "room-1",
      executionId: "execution-1", expectedVersion: 2 }));
    expect(root.querySelector("[data-status='running']")).not.toBeNull();
    expect(root.textContent).toContain("等待 stable event / repair");
    listener?.({ roomId: "room-1", state: state({ executions: [{ execution: { ...execution,
      status: "cancelled", phase: "cancelled", version: 3, updatedAt: "2026-08-25T00:00:01.000Z",
      completedAt: "2026-08-25T00:00:01.000Z", cancellationReason: "human_cancelled" },
      attempts: [], sourceLifecycle: "active", preservedDispatchIds: ["dispatch-1"] }] }) });
    expect(root.querySelector("[data-status='cancelled']")).not.toBeNull();
    expect(root.textContent).toContain("未宣称撤销");
    expect(root.querySelector<HTMLButtonElement>("button")?.textContent).toContain("重试为新执行");
    root.remove();
  });

  it("renders offline/review/non-colour states and disables writes", async () => {
    const review = state({ connection: { status: "offline", asOf: "2026-08-25T00:01:00.000Z" },
      executions: [{ execution: { ...execution, status: "failed", phase: "failed", version: 3,
        updatedAt: "2026-08-25T00:01:00.000Z", completedAt: "2026-08-25T00:01:00.000Z",
        reviewState: "needs_review" }, attempts: [], sourceLifecycle: "active", preservedDispatchIds: [] }] });
    const bridge: InvocationBridge = { getSurface: vi.fn().mockResolvedValue(review), cancel: vi.fn(),
      retry: vi.fn(), onStateChanged: () => vi.fn() };
    const root = document.createElement("div");
    document.body.append(root);
    mountInvocationSurface(root, bridge, "room-1");
    await vi.waitFor(() => expect(root.textContent).toContain("离线只读"));
    expect(root.textContent).toContain("! 失败");
    expect(root.textContent).toContain("需要人工审阅");
    expect(root.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(root.querySelector("[role='alert']")).toBe(document.activeElement);
    root.remove();
  });
});
