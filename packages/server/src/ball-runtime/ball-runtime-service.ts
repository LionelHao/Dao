import {
  isBlueprintBallFact,
  type BallInCourt,
  type NeedsActionProjection,
  type ReminderCandidate,
} from "@native-im/core";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import type { WorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type { BlueprintBallProjectionPort } from "./contracts.js";
import {
  isBallAuthorityOperationResult,
  type BallAuthorityOperationResult,
  type BallDeadlinePolicy,
} from "./ball-authority-protocol.js";

export interface BallRuntimeService {
  query(context: AuthenticatedSessionContext, roomId: string): Promise<{
    readonly balls: readonly BallInCourt[];
    readonly needsAction: readonly NeedsActionProjection[];
    readonly reminders: readonly ReminderCandidate[];
  }>;
  track(roomId: string): boolean;
  scan(roomId: string): Promise<void>;
  recover(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateBallRuntimeServiceOptions {
  readonly worker: Pick<WorkerDatabaseClient, "executeBall">;
  readonly blueprint: BlueprintBallProjectionPort;
  readonly policy: BallDeadlinePolicy;
  readonly scanIntervalMs?: number;
  readonly blueprintTimeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

function result(value: unknown): BallAuthorityOperationResult {
  if (!isBallAuthorityOperationResult(value)) throw new Error("Authority ball result was malformed");
  return value;
}

export function createBallRuntimeService(options: CreateBallRuntimeServiceOptions): BallRuntimeService {
  const scanIntervalMs = options.scanIntervalMs ?? 1_000;
  const blueprintTimeoutMs = options.blueprintTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(scanIntervalMs) || scanIntervalMs < 250 || scanIntervalMs > 60_000 ||
      !Number.isSafeInteger(blueprintTimeoutMs) || blueprintTimeoutMs < 1 || blueprintTimeoutMs > 5_000) {
    throw new TypeError("Ball runtime bounds were invalid");
  }
  const rooms = new Set<string>();
  const scans = new Map<string, Promise<void>>();
  const controllers = new Set<AbortController>();
  let closed = false;

  const facts = async (roomId: string) => {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error("Blueprint ball read timeout")), blueprintTimeoutMs);
    try {
      const values = await options.blueprint.readRoom(roomId, controller.signal);
      if (values.length > 256 || !values.every(isBlueprintBallFact) ||
          values.some((value) => value.roomId !== roomId)) {
        throw new Error("Blueprint ball projection crossed its closed contract");
      }
      return values;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  };

  const scanRoom = async (roomId: string): Promise<void> => {
    if (closed) return;
    const existing = scans.get(roomId);
    if (existing !== undefined) return existing;
    const task = (async () => {
      const blueprintFacts = await facts(roomId);
      result(await options.worker.executeBall({
        type: "ball.scan-overdue", roomId, blueprintFacts, policy: options.policy, now: Date.now(),
      }));
    })().finally(() => scans.delete(roomId));
    scans.set(roomId, task);
    return task;
  };

  const timer = setInterval(() => {
    if (closed) return;
    for (const roomId of rooms) void scanRoom(roomId).catch((error) => options.onError?.(error));
  }, scanIntervalMs);
  timer.unref();

  const trackRoom = (roomId: string): boolean => {
    if (closed || roomId.trim().length === 0) return false;
    if (!rooms.has(roomId) && rooms.size >= 256) return false;
    rooms.add(roomId);
    return true;
  };

  return Object.freeze({
    async query(context: AuthenticatedSessionContext, roomId: string) {
      if (closed) throw new Error("Ball runtime is closed");
      if (!trackRoom(roomId)) throw new Error("Ball room registry is full");
      await scanRoom(roomId);
      const blueprintFacts = await facts(roomId);
      const value = result(await options.worker.executeBall({
        type: "ball.query", context, roomId, blueprintFacts, policy: options.policy, now: Date.now(),
      }));
      if (value.kind !== "ball-query") throw new Error("Authority returned the wrong ball result");
      return { balls: value.balls, needsAction: value.needsAction, reminders: value.reminders };
    },
    track: trackRoom,
    scan: scanRoom,
    async recover() {
      if (closed) return;
      const value = result(await options.worker.executeBall({ type: "ball.list-rooms", now: Date.now() }));
      if (value.kind !== "ball-rooms") throw new Error("Authority returned the wrong ball recovery result");
      for (const roomId of value.roomIds) rooms.add(roomId);
      await Promise.all([...rooms].map(scanRoom));
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort(new Error("Ball runtime closed"));
      await Promise.allSettled(scans.values());
      rooms.clear();
    },
  });
}
