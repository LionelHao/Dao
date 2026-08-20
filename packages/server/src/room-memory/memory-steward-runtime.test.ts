import { describe, expect, it, vi } from "vitest";
import {
  MemoryStewardRuntimeError,
  createMemoryStewardRuntime,
  type MemoryStewardAuthority,
  type MemoryStewardBatch,
  type MemoryStewardBatchResult,
  type MemoryStewardProvider,
} from "./memory-steward-runtime.js";

function batch(roomId: string, ordinal: number): MemoryStewardBatch {
  return {
    roomId,
    jobId: `${roomId}-job-${ordinal}`,
    attemptId: `${roomId}-attempt-${ordinal}`,
    recoveryGeneration: 1,
    fromWatermarkExclusive: ordinal - 1,
    toCorpusSeqInclusive: ordinal,
    sourceCount: 1,
  };
}

function result(value: MemoryStewardBatch): MemoryStewardBatchResult {
  return { jobId: value.jobId, attemptId: value.attemptId, recoveryGeneration: value.recoveryGeneration, candidateCount: 1 };
}

function authority(seed: Readonly<Record<string, readonly MemoryStewardBatch[]>>): MemoryStewardAuthority & {
  readonly claims: MemoryStewardBatch[];
  readonly completions: MemoryStewardBatch[];
  readonly failures: { batch: MemoryStewardBatch; classification: string; retryable: boolean }[];
  readonly noauth: string[];
  readonly ready: string[];
} {
  const pending = new Map(Object.entries(seed).map(([roomId, entries]) => [roomId, [...entries]]));
  const claims: MemoryStewardBatch[] = [];
  const completions: MemoryStewardBatch[] = [];
  const failures: { batch: MemoryStewardBatch; classification: string; retryable: boolean }[] = [];
  const noauth: string[] = [];
  const ready = [...pending.keys()];
  return {
    claims, completions, failures, noauth, ready,
    async discoverReadyRooms(limit) {
      return ready.filter((roomId) => (pending.get(roomId)?.length ?? 0) > 0).slice(0, limit);
    },
    async claim(roomId, batchSize) {
      expect(batchSize).toBe(32);
      const value = pending.get(roomId)?.shift();
      if (value !== undefined) claims.push(value);
      return value;
    },
    async complete(value, output) {
      expect(output).toEqual(result(value));
      completions.push(value);
      return true;
    },
    async fail(value, classification, retryable) {
      failures.push({ batch: value, classification, retryable });
    },
    async markNoauth(roomId) { noauth.push(roomId); },
  };
}

describe("FT-05 Memory Steward bounded scheduler", () => {
  it("does not claim or call a provider when the shared secret is unavailable", async () => {
    const store = authority({ "room-a": [batch("room-a", 1)] });
    const provider: MemoryStewardProvider = {
      readiness: () => "noauth",
      process: vi.fn(),
    };
    const runtime = createMemoryStewardRuntime({ authority: store, provider });
    expect(runtime.enqueue("room-a")).toBe("accepted");
    await runtime.whenIdle();
    expect(store.claims).toEqual([]);
    expect(provider.process).not.toHaveBeenCalled();
    expect(store.noauth).toEqual(["room-a"]);
    expect(runtime.snapshot()).toMatchObject({ queuedRooms: 0, activeRooms: 0 });
  });

  it("serializes a Room, limits cross-Room work to four, and drains every tail batch", async () => {
    const rooms = ["room-a", "room-b", "room-c", "room-d", "room-e"];
    const store = authority(Object.fromEntries(rooms.map((roomId) => [roomId, [batch(roomId, 1), batch(roomId, 2)]])));
    let active = 0;
    let maximum = 0;
    const activeRooms = new Set<string>();
    const provider: MemoryStewardProvider = {
      readiness: () => "ready",
      async process(value) {
        expect(activeRooms.has(value.roomId)).toBe(false);
        activeRooms.add(value.roomId);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        active -= 1;
        activeRooms.delete(value.roomId);
        return result(value);
      },
    };
    const runtime = createMemoryStewardRuntime({ authority: store, provider });
    for (const roomId of rooms) expect(runtime.enqueue(roomId)).toBe("accepted");
    await runtime.whenIdle();
    expect(maximum).toBe(4);
    expect(store.completions).toHaveLength(10);
    for (const roomId of rooms) {
      expect(store.completions.filter((entry) => entry.roomId === roomId).map((entry) => entry.toCorpusSeqInclusive)).toEqual([1, 2]);
    }
  });

  it("persists a timeout classification, aborts the provider, and ignores a late result", async () => {
    const value = batch("room-timeout", 1);
    const store = authority({ "room-timeout": [value] });
    let lateResolve: ((output: MemoryStewardBatchResult) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const provider: MemoryStewardProvider = {
      readiness: () => "ready",
      process(input, signal) {
        observedSignal = signal;
        return new Promise((resolve) => { lateResolve = resolve; });
      },
    };
    const runtime = createMemoryStewardRuntime({ authority: store, provider, limits: { timeoutMs: 5 } });
    runtime.enqueue("room-timeout");
    await runtime.whenIdle();
    expect(observedSignal?.aborted).toBe(true);
    expect(store.failures).toEqual([{ batch: value, classification: "provider_timeout", retryable: true }]);
    lateResolve?.(result(value));
    await Promise.resolve();
    expect(store.completions).toEqual([]);
  });

  it("fails malformed output terminally without a hot retry or checkpoint completion", async () => {
    const value = batch("room-invalid", 1);
    const store = authority({ "room-invalid": [value] });
    const provider: MemoryStewardProvider = {
      readiness: () => "ready",
      async process() { throw new MemoryStewardRuntimeError("invalid_output", false); },
    };
    const runtime = createMemoryStewardRuntime({ authority: store, provider });
    runtime.enqueue("room-invalid");
    await runtime.whenIdle();
    expect(store.failures).toEqual([{ batch: value, classification: "invalid_output", retryable: false }]);
    expect(store.completions).toEqual([]);
    expect(store.claims).toHaveLength(1);
  });

  it("defers an in-memory overflow to durable recovery instead of rejecting authority work", async () => {
    const store = authority({ "room-a": [batch("room-a", 1)], "room-b": [batch("room-b", 1)] });
    let release: (() => void) | undefined;
    const provider: MemoryStewardProvider = {
      readiness: () => "ready",
      async process(value) {
        if (value.roomId === "room-a") await new Promise<void>((resolve) => { release = resolve; });
        return result(value);
      },
    };
    const runtime = createMemoryStewardRuntime({
      authority: store, provider, limits: { maxConcurrentRooms: 1, queueCapacity: 1 },
    });
    expect(runtime.enqueue("room-a")).toBe("accepted");
    await vi.waitFor(() => expect(store.claims).toHaveLength(1));
    expect(runtime.enqueue("room-b")).toBe("accepted");
    expect(runtime.enqueue("room-overflow")).toBe("deferred");
    expect(runtime.snapshot().recoveryNeeded).toBe(true);
    release?.();
    await runtime.whenIdle();
    await runtime.recover();
    await runtime.whenIdle();
    expect(store.completions.map((entry) => entry.roomId)).toEqual(["room-a", "room-b"]);
    expect(runtime.snapshot().recoveryNeeded).toBe(false);
  });
});
