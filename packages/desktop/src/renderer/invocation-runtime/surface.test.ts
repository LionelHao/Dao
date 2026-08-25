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
    mountInvocationSurface(root, bridge, "room-1", { onHostAction: vi.fn() });
    await vi.waitFor(() => expect(root.textContent).toContain("运行中 · 等待确认"));
    const cancelButton = root.querySelector<HTMLButtonElement>("[data-invocation-action='cancel']")!;
    cancelButton.focus();
    cancelButton.click();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ roomId: "room-1",
      executionId: "execution-1", expectedVersion: 2 }));
    expect(root.querySelector("[data-status='running']")).not.toBeNull();
    expect(root.textContent).toContain("等待 stable event / repair");
    expect(document.activeElement).toBe(root.querySelector("[data-execution-id='execution-1']"));
    listener?.({ roomId: "room-1", state: state({ executions: [{ execution: { ...execution,
      status: "cancelled", phase: "cancelled", version: 3, updatedAt: "2026-08-25T00:00:01.000Z",
      completedAt: "2026-08-25T00:00:01.000Z", cancellationReason: "human_cancelled" },
      attempts: [], sourceLifecycle: "active", preservedDispatchIds: ["dispatch-1"] }] }) });
    expect(root.querySelector("[data-status='cancelled']")).not.toBeNull();
    expect(root.textContent).toContain("未宣称撤销");
    expect(root.querySelector<HTMLButtonElement>("button")?.textContent).toContain("重试为新执行");
    expect(document.activeElement).toBe(root.querySelector("[data-execution-id='execution-1']"));
    root.remove();
  });

  it("marks source revision without drifting the frozen execution input", async () => {
    const revised = state({ executions: [{ execution, attempts: [], sourceLifecycle: "revised",
      preservedDispatchIds: [] }] });
    const bridge: InvocationBridge = { getSurface: vi.fn().mockResolvedValue(revised),
      cancel: vi.fn(), retry: vi.fn(), onStateChanged: () => vi.fn() };
    const root = document.createElement("div");
    mountInvocationSurface(root, bridge, "room-1", { onHostAction: vi.fn() });
    await vi.waitFor(() => expect(root.textContent).toContain("SOURCE REVISED"));
    expect(root.textContent).toContain("冻结输入保持不变");
  });

  it("focuses 429 recovery and hands 401/403/410 to closed host callbacks", async () => {
    let listener: ((value: InvocationStateEnvelope) => void) | undefined;
    const cancel = vi.fn().mockResolvedValue({ requestId: "retry-later-2", state: state() });
    const bridge: InvocationBridge = { getSurface: vi.fn().mockResolvedValue(state()),
      cancel, retry: vi.fn(), onStateChanged: (next) => { listener = next; return vi.fn(); } };
    const onHostAction = vi.fn();
    const root = document.createElement("div");
    document.body.append(root);
    mountInvocationSurface(root, bridge, "room-1", { onHostAction });
    await vi.waitFor(() => expect(root.textContent).toContain("运行中"));
    vi.useFakeTimers();
    listener?.({ roomId: "room-1", state: state({ operations: [{ status: "failed",
      requestId: "rate-1", kind: "cancel", executionId: "execution-1", expectedVersion: 2,
      error: { status: 429, code: "rate_limited", recovery: "retry-later",
        retryAfterSeconds: 7 } }] }) });
    const rateRecovery = root.querySelector<HTMLButtonElement>("[data-invocation-recovery='retry-later']");
    expect(rateRecovery?.textContent).toBe("7 秒后重试");
    expect(rateRecovery?.disabled).toBe(true);
    vi.advanceTimersByTime(3_000);
    listener?.({ roomId: "room-1", state: state({ operations: [{ status: "failed",
      requestId: "rate-1", kind: "cancel", executionId: "execution-1", expectedVersion: 2,
      error: { status: 429, code: "rate_limited", recovery: "retry-later",
        retryAfterSeconds: 7 } }] }) });
    const rerenderedRecovery = root.querySelector<HTMLButtonElement>(
      "[data-invocation-recovery='retry-later']",
    );
    expect(rerenderedRecovery?.textContent).toBe("4 秒后重试");
    vi.advanceTimersByTime(3_999);
    expect(rerenderedRecovery?.disabled).toBe(true);
    vi.advanceTimersByTime(1);
    expect(rerenderedRecovery?.disabled).toBe(false);
    expect(rerenderedRecovery?.textContent).toBe("重试控制意图");
    expect(document.activeElement).toBe(rerenderedRecovery);
    rerenderedRecovery?.click();
    await vi.runAllTimersAsync();
    expect(cancel).toHaveBeenCalledWith({ roomId: "room-1",
      executionId: "execution-1", expectedVersion: 2 });
    vi.useRealTimers();

    for (const error of [
      { status: 401, code: "authentication_required", recovery: "reauthenticate" },
      { status: 403, code: "access_revoked", recovery: "request-access" },
      { status: 410, code: "protocol_upgrade_required", recovery: "upgrade-client" },
    ] as const) {
      listener?.({ roomId: "room-1", state: state({ operations: [{ status: "failed",
        requestId: `error-${error.status}`, kind: "cancel", executionId: "execution-1",
        expectedVersion: 2, error }] }) });
      const recovery = root.querySelector<HTMLButtonElement>(
        `[data-invocation-recovery='${error.recovery}']`,
      );
      expect(recovery).not.toBeNull();
      expect(document.activeElement).toBe(recovery);
      recovery?.click();
      expect(onHostAction).toHaveBeenLastCalledWith(error.recovery, {
        roomId: "room-1", executionId: "execution-1",
      });
    }
    root.remove();
  });

  it("renders offline/review/non-colour states and disables writes", async () => {
    let listener: ((value: InvocationStateEnvelope) => void) | undefined;
    const review = state({ connection: { status: "offline", asOf: "2026-08-25T00:01:00.000Z" },
      executions: [{ execution: { ...execution, status: "failed", phase: "failed", version: 3,
        updatedAt: "2026-08-25T00:01:00.000Z", completedAt: "2026-08-25T00:01:00.000Z",
        reviewState: "needs_review" }, attempts: [], sourceLifecycle: "active", preservedDispatchIds: [] }] });
    const bridge: InvocationBridge = { getSurface: vi.fn().mockResolvedValue(review), cancel: vi.fn(),
      retry: vi.fn(), onStateChanged: (next) => { listener = next; return vi.fn(); } };
    const root = document.createElement("div");
    const hostAction = vi.fn();
    document.body.append(root);
    mountInvocationSurface(root, bridge, "room-1", { onHostAction: hostAction });
    await vi.waitFor(() => expect(root.textContent).toContain("离线只读"));
    expect(root.textContent).toContain("! 失败");
    expect(root.textContent).toContain("需要人工审阅");
    expect(root.textContent).toContain("审阅闭合命令尚未接入");
    const reviewAction = root.querySelector<HTMLButtonElement>("[data-invocation-review-action]");
    expect(reviewAction?.textContent).toBe("打开人工审阅入口");
    expect(reviewAction).toBe(document.activeElement);
    reviewAction?.click();
    expect(hostAction).toHaveBeenCalledWith("review-required", {
      roomId: "room-1", executionId: "execution-1",
    });
    expect(root.querySelector<HTMLButtonElement>("[data-invocation-action='retry']")?.disabled).toBe(true);
    listener?.({ roomId: "room-1", state: review });
    expect(document.activeElement).toBe(
      root.querySelector<HTMLButtonElement>("[data-invocation-review-action]"),
    );
    root.remove();
  });
});
