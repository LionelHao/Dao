export interface MemoryStewardBatch {
  readonly roomId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly recoveryGeneration: number;
  readonly fromWatermarkExclusive: number;
  readonly toCorpusSeqInclusive: number;
  readonly sourceCount: number;
}

export interface MemoryStewardBatchResult {
  readonly jobId: string;
  readonly attemptId: string;
  readonly recoveryGeneration: number;
  readonly candidateCount: number;
}

export interface MemoryStewardAuthority {
  readonly discoverReadyRooms: (limit: number) => Promise<readonly string[]>;
  readonly claim: (roomId: string, batchSize: number) => Promise<MemoryStewardBatch | undefined>;
  readonly complete: (batch: MemoryStewardBatch, result: MemoryStewardBatchResult) => Promise<boolean>;
  readonly fail: (batch: MemoryStewardBatch, classification: string, retryable: boolean) => Promise<void>;
  readonly markNoauth: (roomId: string) => Promise<void>;
  readonly abandon?: (batch: MemoryStewardBatch, reason: "shutdown") => Promise<void>;
}

export interface MemoryStewardProvider {
  readonly readiness: () => "ready" | "noauth";
  readonly process: (batch: MemoryStewardBatch, signal: AbortSignal) => Promise<MemoryStewardBatchResult>;
}

export class MemoryStewardRuntimeError extends Error {
  public constructor(
    public readonly classification: string,
    public readonly retryable: boolean,
  ) {
    super(classification);
    this.name = "MemoryStewardRuntimeError";
  }
}

export interface MemoryStewardRuntimeLimits {
  readonly maxConcurrentRooms: number;
  readonly queueCapacity: number;
  readonly batchSize: number;
  readonly timeoutMs: number;
  readonly recoveryScanPage: number;
  readonly maxRecoveryPasses: number;
}

export interface MemoryStewardRuntimeSnapshot {
  readonly queuedRooms: number;
  readonly activeRooms: number;
  readonly recoveryNeeded: boolean;
  readonly stopped: boolean;
}

export interface MemoryStewardRuntime {
  readonly enqueue: (roomId: string) => "accepted" | "deferred";
  readonly recover: () => Promise<void>;
  readonly whenIdle: () => Promise<void>;
  readonly snapshot: () => MemoryStewardRuntimeSnapshot;
  readonly stop: () => Promise<void>;
}

const DEFAULT_LIMITS: MemoryStewardRuntimeLimits = Object.freeze({
  maxConcurrentRooms: 4,
  queueCapacity: 256,
  batchSize: 32,
  timeoutMs: 60_000,
  recoveryScanPage: 128,
  maxRecoveryPasses: 8,
});

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function configuredLimits(input: Partial<MemoryStewardRuntimeLimits> | undefined): MemoryStewardRuntimeLimits {
  const value = { ...DEFAULT_LIMITS, ...input };
  return Object.freeze({
    maxConcurrentRooms: positiveInteger(value.maxConcurrentRooms, "maxConcurrentRooms", 16),
    queueCapacity: positiveInteger(value.queueCapacity, "queueCapacity", 4_096),
    batchSize: positiveInteger(value.batchSize, "batchSize", 64),
    timeoutMs: positiveInteger(value.timeoutMs, "timeoutMs", 120_000),
    recoveryScanPage: positiveInteger(value.recoveryScanPage, "recoveryScanPage", 1_024),
    maxRecoveryPasses: positiveInteger(value.maxRecoveryPasses, "maxRecoveryPasses", 64),
  });
}

function configuredRoomId(roomId: string): string {
  if (roomId.length < 1 || roomId.length > 256) throw new TypeError("roomId must be between 1 and 256 characters");
  return roomId;
}

function classify(error: unknown): MemoryStewardRuntimeError {
  if (error instanceof MemoryStewardRuntimeError) return error;
  return new MemoryStewardRuntimeError("provider_unavailable", true);
}

export function createMemoryStewardRuntime(options: {
  readonly authority: MemoryStewardAuthority;
  readonly provider: MemoryStewardProvider;
  readonly limits?: Partial<MemoryStewardRuntimeLimits>;
}): MemoryStewardRuntime {
  const limits = configuredLimits(options.limits);
  const queue: string[] = [];
  const queued = new Set<string>();
  const active = new Set<string>();
  const pendingWake = new Set<string>();
  const controllers = new Set<AbortController>();
  const idleWaiters = new Set<() => void>();
  let stopped = false;
  let recoveryNeeded = false;
  let pumpScheduled = false;

  const resolveIdle = (): void => {
    if (queue.length !== 0 || active.size !== 0 || pumpScheduled) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const schedulePump = (): void => {
    if (pumpScheduled || stopped) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  };

  const enqueue = (inputRoomId: string): "accepted" | "deferred" => {
    const roomId = configuredRoomId(inputRoomId);
    if (stopped) return "deferred";
    if (active.has(roomId)) {
      pendingWake.add(roomId);
      return "accepted";
    }
    if (queued.has(roomId)) return "accepted";
    if (queue.length >= limits.queueCapacity) {
      recoveryNeeded = true;
      return "deferred";
    }
    queued.add(roomId);
    queue.push(roomId);
    schedulePump();
    return "accepted";
  };

  const invokeProvider = async (batch: MemoryStewardBatch): Promise<MemoryStewardBatchResult> => {
    const controller = new AbortController();
    controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeShutdownAbort: (() => void) | undefined;
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new MemoryStewardRuntimeError("provider_timeout", true));
        }, limits.timeoutMs);
        timer.unref?.();
      });
      const shutdown = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          if (!timedOut) reject(new MemoryStewardRuntimeError("shutdown", false));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeShutdownAbort = () => controller.signal.removeEventListener("abort", onAbort);
      });
      const provider = options.provider.process(batch, controller.signal);
      return await Promise.race([provider, timeout, shutdown]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeShutdownAbort?.();
      controllers.delete(controller);
    }
  };

  const processRoom = async (roomId: string): Promise<boolean> => {
    if (stopped) return false;
    if (options.provider.readiness() === "noauth") {
      await options.authority.markNoauth(roomId);
      return false;
    }
    const batch = await options.authority.claim(roomId, limits.batchSize);
    if (batch === undefined) return false;
    if (batch.roomId !== roomId) {
      await options.authority.fail(batch, "authority_cross_room_claim", false);
      return false;
    }
    try {
      const output = await invokeProvider(batch);
      if (stopped) {
        await options.authority.abandon?.(batch, "shutdown");
        return false;
      }
      if (output.jobId !== batch.jobId || output.attemptId !== batch.attemptId ||
          output.recoveryGeneration !== batch.recoveryGeneration) {
        await options.authority.fail(batch, "late_or_mismatched_generation", false);
        return false;
      }
      return await options.authority.complete(batch, output);
    } catch (error: unknown) {
      const failure = classify(error);
      if (failure.classification === "shutdown") {
        await options.authority.abandon?.(batch, "shutdown");
        return false;
      }
      await options.authority.fail(batch, failure.classification, failure.retryable);
      return false;
    }
  };

  function pump(): void {
    if (stopped) {
      resolveIdle();
      return;
    }
    while (active.size < limits.maxConcurrentRooms && queue.length > 0) {
      const roomId = queue.shift();
      if (roomId === undefined) break;
      queued.delete(roomId);
      if (active.has(roomId)) {
        pendingWake.add(roomId);
        continue;
      }
      active.add(roomId);
      void processRoom(roomId).then((continueRoom) => {
        active.delete(roomId);
        const explicitlyWoken = pendingWake.delete(roomId);
        if (!stopped && (continueRoom || explicitlyWoken)) enqueue(roomId);
      }).catch(() => {
        active.delete(roomId);
        recoveryNeeded = true;
      }).finally(() => {
        schedulePump();
        resolveIdle();
      });
    }
    resolveIdle();
  }

  return Object.freeze({
    enqueue,
    async recover(): Promise<void> {
      if (stopped) return;
      recoveryNeeded = false;
      for (let pass = 0; pass < limits.maxRecoveryPasses; pass += 1) {
        const rooms = await options.authority.discoverReadyRooms(limits.recoveryScanPage);
        if (rooms.length === 0) break;
        let deferred = false;
        for (const roomId of rooms) {
          if (enqueue(roomId) === "deferred") deferred = true;
        }
        if (deferred) {
          recoveryNeeded = true;
          break;
        }
        if (rooms.length < limits.recoveryScanPage) break;
        if (pass === limits.maxRecoveryPasses - 1) recoveryNeeded = true;
      }
    },
    whenIdle(): Promise<void> {
      if (queue.length === 0 && active.size === 0 && !pumpScheduled) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    snapshot(): MemoryStewardRuntimeSnapshot {
      return Object.freeze({ queuedRooms: queue.length, activeRooms: active.size, recoveryNeeded, stopped });
    },
    async stop(): Promise<void> {
      stopped = true;
      queue.length = 0;
      queued.clear();
      pendingWake.clear();
      for (const controller of controllers) controller.abort();
      await (active.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.add(resolve)));
      resolveIdle();
    },
  });
}
