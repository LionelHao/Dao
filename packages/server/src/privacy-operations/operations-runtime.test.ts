import { describe, expect, it, vi } from "vitest";
import {
  createHostedRetentionOperationsAdapter,
  type HostedRetentionBatchPort,
  type OperationsRuntimeAlert,
} from "./operations-runtime.js";

describe("FT-14 host-driven retention worker adapter", () => {
  it("runs exactly one AuthorityWorker-owned bounded batch and returns tail reschedule intent", async () => {
    const runBatch = vi.fn(async () => ({
      processed: 100,
      purged: 80,
      retained: 20,
      retried: 0,
      deadLettered: 0,
      hasMore: true,
      queueDepth: 101,
      oldestAgeMs: 60_000,
    }));
    const alerts: OperationsRuntimeAlert[] = [];
    const runtime = createHostedRetentionOperationsAdapter({
      batchPort: { runBatch },
      alertSink: { emit(alert) { alerts.push(alert); } },
      timeoutMs: 1_000,
    });

    const result = await runtime.run("startup_recovery", 1_000);

    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(runBatch).toHaveBeenCalledWith(expect.objectContaining({
      workerId: "retention_janitor",
      limit: 100,
      trigger: "startup_recovery",
      signal: expect.any(AbortSignal),
    }));
    expect(result).toEqual(expect.objectContaining({
      status: "needs_reschedule",
      processed: 100,
    }));
    expect(alerts).toContainEqual(expect.objectContaining({
      code: "backlog_warning",
      queueDepth: 101,
      oldestAgeMs: 60_000,
    }));
  });

  it("never hot-loops a batch tail and refuses a concurrent single-writer run", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const runBatch = vi.fn(async () => {
      await pending;
      return { processed: 1, purged: 1, retained: 0, retried: 0, deadLettered: 0, hasMore: true, queueDepth: 1, oldestAgeMs: 1 };
    });
    const runtime = createHostedRetentionOperationsAdapter({ batchPort: { runBatch }, timeoutMs: 1_000 });

    const first = runtime.run("periodic", 1_000);
    await Promise.resolve();
    await expect(runtime.run("periodic", 1_001)).resolves.toEqual({ status: "already_running" });
    release();
    await expect(first).resolves.toMatchObject({ status: "needs_reschedule" });
    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  it("aborts at the worker timeout, reports only closed metrics, and blocks overlap until drain", async () => {
    let observedSignal: AbortSignal | undefined;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const alerts: OperationsRuntimeAlert[] = [];
    const batchPort: HostedRetentionBatchPort = { async runBatch(input) {
      observedSignal = input.signal;
      await pending;
      return { processed: 0, purged: 0, retained: 0, retried: 0, deadLettered: 0, hasMore: false, queueDepth: 0, oldestAgeMs: 0 };
    } };
    const runtime = createHostedRetentionOperationsAdapter({
      batchPort,
      timeoutMs: 5,
      alertSink: { emit(alert) { alerts.push(alert); } },
    });

    await expect(runtime.run("periodic", 1_000)).resolves.toEqual({ status: "timed_out" });
    expect(observedSignal?.aborted).toBe(true);
    await expect(runtime.run("periodic", 1_001)).resolves.toEqual({ status: "already_running" });
    expect(alerts).toEqual([expect.objectContaining({
      workerId: "retention_janitor",
      code: "worker_timeout",
    })]);
    expect(JSON.stringify(alerts)).not.toMatch(/payload|message|secret|token|path/i);
    release();
  });

  it("performs bounded shutdown drain and never accepts later work", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createHostedRetentionOperationsAdapter({
      batchPort: { async runBatch() {
        await pending;
        return { processed: 0, purged: 0, retained: 0, retried: 0, deadLettered: 0, hasMore: false, queueDepth: 0, oldestAgeMs: 0 };
      } },
      timeoutMs: 1_000,
      shutdownDrainMs: 5,
    });
    void runtime.run("periodic", 1_000);
    await Promise.resolve();

    await expect(runtime.shutdown()).resolves.toEqual({ status: "shutdown_timeout" });
    await expect(runtime.run("periodic", 1_001)).resolves.toEqual({ status: "closed" });
    release();
  });

  it("rejects malformed or over-batch Authority results instead of losing the tail", async () => {
    const runtime = createHostedRetentionOperationsAdapter({
      batchPort: { async runBatch() {
        return { processed: 101, purged: 101, retained: 0, retried: 0, deadLettered: 0, hasMore: false, queueDepth: 0, oldestAgeMs: 0 };
      } },
      timeoutMs: 1_000,
    });

    await expect(runtime.run("periodic", 1_000)).resolves.toEqual({
      status: "failed",
      failureCode: "invalid_authority_result",
    });
    await expect(runtime.run("periodic", Number.MAX_SAFE_INTEGER)).resolves.toEqual({
      status: "failed",
      failureCode: "invalid_authority_result",
    });
  });
});
