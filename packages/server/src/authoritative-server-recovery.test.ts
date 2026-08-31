import { describe, expect, it } from "vitest";
import {
  createBoundedDetachedRecovery,
  DetachedRecoveryTerminalError,
} from "./authoritative-server.js";

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("authoritative server detached recovery shutdown", () => {
  it("stops accepting batches and waits for the active invalidation batch", async () => {
    const active = deferred();
    let batches = 0;
    const recovery = createBoundedDetachedRecovery({
      family: "room-cache-invalidation",
      intervalMs: 5,
      shutdownTimeoutMs: 1_000,
      runBatch: () => {
        batches += 1;
        return active.promise;
      },
      onBackgroundFailure: () => undefined,
    });

    const batch = recovery.kick();
    recovery.start();
    const closing = recovery.close();
    expect(batches).toBe(0);
    await Promise.resolve();
    expect(batches).toBe(1);
    expect(await Promise.race([closing.then(() => "closed"), Promise.resolve("pending")]))
      .toBe("pending");
    active.resolve();
    await expect(batch).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(batches).toBe(1);
    await expect(recovery.kick()).resolves.toBeUndefined();
    expect(batches).toBe(1);
  });

  it("fails closed with structured terminal metadata when the active batch exceeds the bound", async () => {
    const active = deferred();
    const recovery = createBoundedDetachedRecovery({
      family: "room-cache-invalidation",
      intervalMs: 1_000,
      shutdownTimeoutMs: 10,
      runBatch: () => active.promise,
      onBackgroundFailure: () => undefined,
    });
    const batch = recovery.kick();
    await Promise.resolve();

    await expect(recovery.close()).rejects.toMatchObject({
      name: "DetachedRecoveryTerminalError",
      code: "detached_recovery_shutdown_failed",
      state: "closed",
      family: "room-cache-invalidation",
      reason: "shutdown_timeout",
    } satisfies Partial<DetachedRecoveryTerminalError>);
    active.resolve();
    await batch;
    await expect(recovery.kick()).resolves.toBeUndefined();
  });

  it("wraps an active batch rejection as a closed terminal shutdown failure", async () => {
    const active = deferred();
    const cause = new Error("sqlite worker closed");
    const recovery = createBoundedDetachedRecovery({
      family: "room-cache-invalidation",
      intervalMs: 1_000,
      shutdownTimeoutMs: 1_000,
      runBatch: () => active.promise,
      onBackgroundFailure: () => undefined,
    });
    const batch = recovery.kick();
    await Promise.resolve();
    const closing = recovery.close();
    active.reject(cause);

    await expect(closing).rejects.toMatchObject({
      code: "detached_recovery_shutdown_failed",
      state: "closed",
      reason: "active_batch_failed",
      terminalCause: cause,
    });
    await expect(batch).rejects.toBe(cause);
  });
});
