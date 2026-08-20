import { createHash, randomUUID } from "node:crypto";
import {
  isRoomMemoryProtocolFrame,
  type RoomMemoryKind,
  type RoomMemoryRequest,
  type RoomMemorySuccessFrame,
} from "@native-im/core";
import type { WorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type {
  MemoryAuthorityAuthorizedSource,
  MemoryAuthorityBatch,
  MemoryAuthorityOperation,
} from "./authority-protocol.js";
import type { MemoryRuntimeReadiness } from "./runtime-readiness.js";
import type {
  MemoryStewardAuthority,
  MemoryStewardBatch,
  MemoryStewardBatchResult,
} from "./memory-steward-runtime.js";

type Value = Record<string, unknown>;

function record(value: unknown): value is Value {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultKind(value: unknown, kind: string): Value {
  if (!record(value) || value.kind !== kind) throw new TypeError(`Memory authority returned invalid ${kind}`);
  return value;
}

function now(options: { readonly nowMs: () => number }): number {
  const value = options.nowMs();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Memory authority clock was invalid");
  return value;
}

function wireBatch(batch: MemoryStewardBatch): MemoryAuthorityBatch {
  return {
    roomId: batch.roomId,
    jobId: batch.jobId,
    attemptId: batch.attemptId,
    recoveryGeneration: batch.recoveryGeneration,
    fromWatermarkExclusive: batch.fromWatermarkExclusive,
    toCorpusSeqInclusive: batch.toCorpusSeqInclusive,
    sourceCount: batch.sourceCount,
  };
}

type PublicContext = Extract<MemoryAuthorityOperation, { type: "memory.public" }>["context"];

export interface WorkerMemoryAuthority extends MemoryStewardAuthority {
  readonly readReadiness: (roomId: string) => Promise<MemoryRuntimeReadiness>;
  readonly executePublic: (
    context: PublicContext,
    request: RoomMemoryRequest,
  ) => Promise<RoomMemorySuccessFrame>;
  readonly authorizeSource: (
    batch: MemoryStewardBatch,
    source: Readonly<{ sourceKind: MemoryAuthorityAuthorizedSource["sourceKind"]; sourceId: string; sourceRevision: number }>,
    signal: AbortSignal,
  ) => Promise<MemoryAuthorityAuthorizedSource>;
  readonly isKnownRecord: (roomId: string, memoryRecordId: string, kind: RoomMemoryKind, signal: AbortSignal) => Promise<boolean>;
}

export function createWorkerMemoryAuthority(options: {
  readonly worker: Pick<WorkerDatabaseClient, "executeMemory">;
  readonly nowMs: () => number;
  readonly nextId?: () => string;
}): WorkerMemoryAuthority {
  const nextId = options.nextId ?? randomUUID;
  const execute = async (operation: MemoryAuthorityOperation): Promise<unknown> =>
    await options.worker.executeMemory(operation);

  return Object.freeze({
    async discoverReadyRooms(limit: number): Promise<readonly string[]> {
      const result = resultKind(await execute({ type: "memory.discover", limit, now: now(options) }), "rooms");
      if (!Array.isArray(result.roomIds) || !result.roomIds.every((roomId) => typeof roomId === "string")) {
        throw new TypeError("Memory authority returned invalid ready rooms");
      }
      return Object.freeze([...result.roomIds]);
    },
    async claim(roomId: string, batchSize: number): Promise<MemoryStewardBatch | undefined> {
      resultKind(await execute({ type: "memory.mark-ready", roomId, now: now(options) }), "status-updated");
      const jobId = `memory-job:${nextId()}`;
      const attemptId = `memory-attempt:${nextId()}`;
      const inputSha256 = createHash("sha256").update(`${roomId}\u0000${jobId}\u0000${attemptId}`).digest("hex");
      const result = resultKind(await execute({
        type: "memory.claim", roomId, jobId, attemptId, inputSha256, batchSize, now: now(options),
      }), "claimed");
      if (result.batch === null) return undefined;
      if (!record(result.batch)) throw new TypeError("Memory authority returned invalid claim");
      const batch = result.batch as unknown as MemoryAuthorityBatch;
      if (!Array.isArray(result.sources)) throw new TypeError("Memory authority returned invalid frozen sources");
      return Object.freeze({
        roomId: batch.roomId,
        jobId: batch.jobId,
        attemptId: batch.attemptId,
        recoveryGeneration: batch.recoveryGeneration,
        fromWatermarkExclusive: batch.fromWatermarkExclusive,
        toCorpusSeqInclusive: batch.toCorpusSeqInclusive,
        sourceCount: batch.sourceCount,
        sources: Object.freeze(result.sources.map((source) => {
          if (!record(source)) throw new TypeError("Memory authority returned invalid frozen source");
          return Object.freeze(source) as unknown as MemoryStewardBatch["sources"][number];
        })),
      });
    },
    async complete(batch: MemoryStewardBatch, output: MemoryStewardBatchResult): Promise<boolean> {
      const result = resultKind(await execute({
        type: "memory.complete", batch: wireBatch(batch), outputSha256: output.outputSha256,
        plan: output.plan, now: now(options),
      }), "completed");
      return result.committed === true;
    },
    async fail(batch: MemoryStewardBatch, classification: string, retryable: boolean): Promise<void> {
      const errorCode = new Set([
        "provider_timeout", "provider_rate_limited", "provider_unavailable",
        "provider_output_oversized", "authority_unavailable", "source_stale",
      ]).has(classification)
        ? classification as Extract<MemoryAuthorityOperation, { type: "memory.fail" }>["errorCode"]
        : "invalid_provider_output" as const;
      resultKind(await execute({
        type: "memory.fail", batch: wireBatch(batch), errorCode, retryable,
        nextAvailableAt: null, now: now(options),
      }), "settled");
    },
    async markNoauth(roomId: string): Promise<void> {
      resultKind(await execute({ type: "memory.mark-noauth", roomId, now: now(options) }), "status-updated");
    },
    async abandon(batch: MemoryStewardBatch): Promise<void> {
      resultKind(await execute({ type: "memory.abandon", batch: wireBatch(batch), now: now(options) }), "settled");
    },
    async readReadiness(roomId: string): Promise<MemoryRuntimeReadiness> {
      const result = resultKind(await execute({ type: "memory.readiness", roomId }), "readiness");
      if (!record(result.readiness)) throw new TypeError("Memory authority returned invalid readiness");
      return result.readiness as unknown as MemoryRuntimeReadiness;
    },
    async executePublic(context: PublicContext, request: RoomMemoryRequest): Promise<RoomMemorySuccessFrame> {
      const result = resultKind(await execute({ type: "memory.public", context, request, now: now(options) }), "public");
      if (!isRoomMemoryProtocolFrame(result.frame) || result.frame.type === "error" ||
          result.frame.type.endsWith("query.v1") || result.frame.type === "room.memory.context.dispute.v1" ||
          result.frame.type === "room.memory.context.resolve.v1" || result.frame.type === "room.memory.retry.v1") {
        throw new TypeError("Memory authority returned invalid public frame");
      }
      return result.frame as RoomMemorySuccessFrame;
    },
    async authorizeSource(
      batch: MemoryStewardBatch,
      source: Readonly<{
        sourceKind: MemoryAuthorityAuthorizedSource["sourceKind"];
        sourceId: string;
        sourceRevision: number;
      }>,
      signal: AbortSignal,
    ): Promise<MemoryAuthorityAuthorizedSource> {
      if (signal.aborted) throw new DOMException("Memory source authorization aborted", "AbortError");
      const result = resultKind(await execute({
        type: "memory.source-authorize", batch: wireBatch(batch),
        sourceKind: source.sourceKind, sourceId: source.sourceId, sourceRevision: source.sourceRevision,
        now: now(options),
      }), "source");
      if (!record(result.source)) throw new TypeError("Memory authority returned invalid source authorization");
      return result.source as unknown as MemoryAuthorityAuthorizedSource;
    },
    async isKnownRecord(
      roomId: string,
      memoryRecordId: string,
      kind: RoomMemoryKind,
      signal: AbortSignal,
    ): Promise<boolean> {
      if (signal.aborted) throw new DOMException("Memory record authorization aborted", "AbortError");
      const result = resultKind(await execute({ type: "memory.record-known", roomId, memoryRecordId, kind }), "known-record");
      if (typeof result.known !== "boolean") throw new TypeError("Memory authority returned invalid record result");
      return result.known;
    },
  });
}
