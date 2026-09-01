import type { OperationsWorkerPolicy } from "./worker-inventory.js";

export type OperationsWorkerLimitErrorCode =
  | "operations_capacity_limited"
  | "operations_timeout";

export class OperationsWorkerLimitError extends Error {
  readonly status: 429 | 503;

  constructor(readonly code: OperationsWorkerLimitErrorCode) {
    super(`Operations worker rejected: ${code}`);
    this.name = "OperationsWorkerLimitError";
    this.status = code === "operations_capacity_limited" ? 429 : 503;
  }
}

type Permit = Readonly<{ release(): void }>;

export interface OperationsWorkerLimiter {
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  stream<T>(operation: (signal: AbortSignal) => AsyncIterable<T>): AsyncIterable<T>;
  inspect(): Readonly<{ active: number; queued: number }>;
}

export function createOperationsWorkerLimiter(
  policy: Pick<OperationsWorkerPolicy, "maxActive" | "maxQueue" | "timeoutMs">,
): OperationsWorkerLimiter {
  let active = 0;
  const queued: Array<Readonly<{
    resolve: (permit: Permit) => void;
  }>> = [];

  function release(): void {
    active -= 1;
    const next = queued.shift();
    if (next === undefined) return;
    active += 1;
    next.resolve(Object.freeze({ release }));
  }

  function acquire(): Promise<Permit> {
    if (active < policy.maxActive) {
      active += 1;
      return Promise.resolve(Object.freeze({ release }));
    }
    if (queued.length >= policy.maxQueue) {
      return Promise.reject(new OperationsWorkerLimitError("operations_capacity_limited"));
    }
    return new Promise<Permit>((resolve) => queued.push({ resolve }));
  }

  function deadline(controller: AbortController): Readonly<{
    promise: Promise<never>;
    clear(): void;
  }> {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OperationsWorkerLimitError("operations_timeout"));
      }, policy.timeoutMs);
      timer.unref?.();
    });
    return Object.freeze({ promise, clear: () => clearTimeout(timer) });
  }

  return Object.freeze({
    async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const permit = await acquire();
      const controller = new AbortController();
      const limit = deadline(controller);
      let timedOut = false;
      const running = Promise.resolve().then(() => operation(controller.signal));
      try {
        return await Promise.race([running, limit.promise]);
      } catch (error) {
        timedOut = error instanceof OperationsWorkerLimitError &&
          error.code === "operations_timeout";
        throw error;
      } finally {
        limit.clear();
        if (timedOut) void running.finally(() => permit.release()).catch(() => undefined);
        else permit.release();
      }
    },
    async *stream<T>(operation: (signal: AbortSignal) => AsyncIterable<T>): AsyncIterable<T> {
      const permit = await acquire();
      const controller = new AbortController();
      const limit = deadline(controller);
      const iterator = operation(controller.signal)[Symbol.asyncIterator]();
      let timedOut = false;
      try {
        while (true) {
          let next: IteratorResult<T>;
          try {
            next = await Promise.race([iterator.next(), limit.promise]);
          } catch (error) {
            timedOut = error instanceof OperationsWorkerLimitError &&
              error.code === "operations_timeout";
            throw error;
          }
          if (next.done === true) return;
          yield next.value;
        }
      } finally {
        limit.clear();
        let cleanup: Promise<unknown>;
        try { cleanup = Promise.resolve(iterator.return?.()); }
        catch (error) { cleanup = Promise.reject(error); }
        if (timedOut) void cleanup.finally(() => permit.release()).catch(() => undefined);
        else {
          try { await cleanup; } finally { permit.release(); }
        }
      }
    },
    inspect: () => Object.freeze({ active, queued: queued.length }),
  });
}
