import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationsWorkerLimiter,
  OperationsWorkerLimitError,
} from "./worker-limiter.js";
import { createRoomDataExport, type RoomExportAuthority } from "./room-export.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("FT-14 production operations worker limiter", () => {
  it("enforces one process-global active and waiting bound", async () => {
    const limiter = createOperationsWorkerLimiter({ maxActive: 2, maxQueue: 2, timeoutMs: 1_000 });
    const releases: Array<() => void> = [];
    const operation = () => limiter.run(async () => new Promise<number>((resolve) => {
      releases.push(() => resolve(releases.length));
    }));

    const admitted = [operation(), operation(), operation(), operation()];
    await vi.waitFor(() => expect(limiter.inspect()).toEqual({ active: 2, queued: 2 }));
    await expect(operation()).rejects.toMatchObject({
      status: 429, code: "operations_capacity_limited",
    });

    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0).forEach((release) => release());
    await expect(Promise.all(admitted)).resolves.toHaveLength(4);
    expect(limiter.inspect()).toEqual({ active: 0, queued: 0 });
  });

  it("returns typed timeouts, aborts work, and retains the permit until cleanup settles", async () => {
    vi.useFakeTimers();
    const limiter = createOperationsWorkerLimiter({ maxActive: 1, maxQueue: 1, timeoutMs: 10 });
    let settle!: () => void;
    const aborted = vi.fn();
    const running = limiter.run(async (signal) => {
      signal.addEventListener("abort", aborted, { once: true });
      await new Promise<void>((resolve) => { settle = resolve; });
      return 1;
    });
    const timedOut = expect(running).rejects.toBeInstanceOf(OperationsWorkerLimitError);
    await vi.advanceTimersByTimeAsync(10);

    await timedOut;
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(limiter.inspect()).toEqual({ active: 1, queued: 0 });
    const queued = limiter.run(async () => 2);
    expect(limiter.inspect()).toEqual({ active: 1, queued: 1 });
    settle();
    await expect(queued).resolves.toBe(2);
    expect(limiter.inspect()).toEqual({ active: 0, queued: 0 });
  });

  it("calls stream return on timeout but does not mark an ordinary consumer return as timed out", async () => {
    vi.useFakeTimers();
    const limiter = createOperationsWorkerLimiter({ maxActive: 1, maxQueue: 1, timeoutMs: 10 });
    const timedOutReturn = vi.fn(async () => ({ done: true, value: undefined }));
    const timedOut = limiter.stream(() => ({
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<number>>(() => undefined), return: timedOutReturn };
      },
    }))[Symbol.asyncIterator]();
    const next = timedOut.next();
    const timedOutNext = expect(next).rejects.toMatchObject({
      status: 503, code: "operations_timeout",
    });
    await vi.advanceTimersByTimeAsync(10);
    await timedOutNext;
    expect(timedOutReturn).toHaveBeenCalledTimes(1);

    const observedAborted: boolean[] = [];
    const ordinary = limiter.stream(async function* (signal) {
      try { yield 1; }
      finally { observedAborted.push(signal.aborted); }
    })[Symbol.asyncIterator]();
    await expect(ordinary.next()).resolves.toEqual({ done: false, value: 1 });
    await ordinary.return?.();
    expect(observedAborted).toEqual([false]);
  });

  it("bounds a never-resolving Room page, releases context, and admits the next peer", async () => {
    vi.useFakeTimers();
    const audit = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    let rejectLatePage!: (error: Error) => void;
    const authority: RoomExportAuthority = {
      async authorize(input) {
        return { ...input, accessRevision: 7, lifecycle: "active", role: "owner" };
      },
      async begin(input) {
        return { exportId: `export-${input.sessionId}`, roomId: input.roomId, watermark: 42,
          accessRevision: input.accessRevision, startedAt: "2026-09-01T00:00:00.000Z" };
      },
      async reauthorize() {},
      readPage() {
        return new Promise((_resolve, reject) => { rejectLatePage = reject; });
      },
      release,
      audit,
    };
    const service = createRoomDataExport({ authority });
    const limiter = createOperationsWorkerLimiter({ maxActive: 1, maxQueue: 1, timeoutMs: 10 });
    const input = (sessionId: string) => ({
      actorId: "owner", roomId: "room-1", sessionFamilyId: "family-1", sessionId,
    });
    const first = limiter.stream((signal) => service.stream(input("one"), signal))[
      Symbol.asyncIterator
    ]();
    await expect(first.next()).resolves.toMatchObject({ done: false });
    const blockedPage = first.next();
    const timedOutPage = expect(blockedPage).rejects.toMatchObject({
      status: 503, code: "operations_timeout",
    });
    const peer = limiter.stream((signal) => service.stream(input("two"), signal))[
      Symbol.asyncIterator
    ]();
    const peerHeader = peer.next();
    expect(limiter.inspect()).toEqual({ active: 1, queued: 1 });

    await vi.advanceTimersByTimeAsync(10);
    await timedOutPage;
    await expect(peerHeader).resolves.toMatchObject({ done: false });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({
      exportId: "export-one",
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      exportId: "export-one", result: "failed", failureCode: "operation_timeout",
    }));

    // A late rejection from the abandoned authority promise is observed by the abort race.
    rejectLatePage(new Error("late worker reply"));
    await Promise.resolve();
    await peer.return?.();
    expect(limiter.inspect()).toEqual({ active: 0, queued: 0 });
  });
});
