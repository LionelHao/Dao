import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import {
  MEMORY_STEWARD_MAX_SOURCE_CONTENT_BYTES,
  MEMORY_STEWARD_MAX_TOTAL_CONTENT_BYTES,
  MemoryStewardProviderError,
  type FrozenMemoryStewardSource,
  type MemoryStewardPlan,
  type MemoryStewardProvider as ClosedMemoryStewardProvider,
} from "./contracts.js";
import {
  MemoryStewardRuntimeError,
  type MemoryStewardBatch,
  type MemoryStewardBatchResult,
  type MemoryStewardProvider,
} from "./memory-steward-runtime.js";
import type { WorkerMemoryAuthority } from "./worker-memory-authority.js";

const encoder = new TextEncoder();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entry = value as Record<string, unknown>;
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(entry[key])}`).join(",")}}`;
  }
  throw new TypeError("Memory provider adapter rejected a non-JSON value");
}

function sameAuthorization(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function boundedUtf8(value: string, maximumBytes: number): string {
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).byteLength <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

function classify(error: unknown): MemoryStewardRuntimeError {
  if (error instanceof MemoryStewardRuntimeError) return error;
  if (error instanceof MemoryStewardProviderError) {
    if (error.code === "noauth") return new MemoryStewardRuntimeError("provider_unavailable", false);
    if (error.code === "source_stale") return new MemoryStewardRuntimeError("source_stale", false);
    if (error.code === "provider_malformed" || error.code === "provider_rejected" || error.code === "input_invalid") {
      return new MemoryStewardRuntimeError("invalid_provider_output", false);
    }
    return new MemoryStewardRuntimeError(error.code, error.retryable);
  }
  return new MemoryStewardRuntimeError("authority_unavailable", true);
}

export function createMemoryStewardProviderAdapter(options: {
  readonly authority: Pick<WorkerMemoryAuthority, "authorizeSource" | "isKnownRecord">;
  readonly provider: ClosedMemoryStewardProvider;
  readonly readiness: () => "ready" | "noauth";
  readonly objectStore?: Readonly<{
    readAuthorizedRange(
      objectKey: string,
      offset: number,
      maximumBytes: number,
    ): Promise<Readonly<{ bytes: Uint8Array; byteSize: number; eof: boolean }>>;
  }>;
  readonly chunkBytes?: number;
}): MemoryStewardProvider {
  const chunkBytes = options.chunkBytes ?? 64 * 1_024;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 256 * 1_024) {
    throw new TypeError("Memory provider adapter chunk limit was invalid");
  }

  async function readAttachment(
    batch: MemoryStewardBatch,
    descriptor: MemoryStewardBatch["sources"][number],
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<string> {
    const first = await options.authority.authorizeSource(batch, {
      sourceKind: "attachment_extraction",
      sourceId: descriptor.sourceId,
      sourceRevision: descriptor.sourceRevision,
    }, signal);
    if (first.kind !== "attachment" || first.byteSize < 1 || options.objectStore === undefined) {
      throw new MemoryStewardRuntimeError("authority_unavailable", true);
    }
    const targetBytes = Math.min(first.byteSize, maximumBytes);
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < targetBytes) {
      if (signal.aborted) throw new MemoryStewardRuntimeError("shutdown", false);
      const before = await options.authority.authorizeSource(batch, {
        sourceKind: "attachment_extraction", sourceId: descriptor.sourceId,
        sourceRevision: descriptor.sourceRevision,
      }, signal);
      if (!sameAuthorization(first, before)) throw new MemoryStewardRuntimeError("source_stale", false);
      const maximum = Math.min(chunkBytes, targetBytes - offset);
      const range = await options.objectStore.readAuthorizedRange(first.objectKey, offset, maximum);
      const after = await options.authority.authorizeSource(batch, {
        sourceKind: "attachment_extraction", sourceId: descriptor.sourceId,
        sourceRevision: descriptor.sourceRevision,
      }, signal);
      if (!sameAuthorization(first, after) || !nodeTypes.isUint8Array(range.bytes) ||
          range.bytes.byteLength < 1 || range.bytes.byteLength > maximum || range.byteSize !== first.byteSize ||
          typeof range.eof !== "boolean" || range.eof !== (offset + range.bytes.byteLength === first.byteSize)) {
        throw new MemoryStewardRuntimeError("source_stale", false);
      }
      chunks.push(new Uint8Array(range.bytes));
      offset += range.bytes.byteLength;
    }
    const bytes = new Uint8Array(offset);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new MemoryStewardRuntimeError("invalid_provider_output", false);
    }
  }

  async function frozenSources(batch: MemoryStewardBatch, signal: AbortSignal): Promise<readonly FrozenMemoryStewardSource[]> {
    const eligible = batch.sources.filter((source) =>
      source.eligibility === "eligible" && source.availability === "readable" &&
      (source.sourceKind === "message" || source.sourceKind === "message_revision" ||
        source.sourceKind === "attachment_extraction"));
    const result: FrozenMemoryStewardSource[] = [];
    let remainingBytes = MEMORY_STEWARD_MAX_TOTAL_CONTENT_BYTES;
    for (const [index, descriptor] of eligible.entries()) {
      const remainingSources = eligible.length - index;
      const maximumBytes = Math.min(
        MEMORY_STEWARD_MAX_SOURCE_CONTENT_BYTES,
        Math.max(1, Math.floor(remainingBytes / remainingSources)),
      );
      let content: string;
      if (descriptor.sourceKind === "attachment_extraction") {
        content = await readAttachment(batch, descriptor, maximumBytes, signal);
      } else {
        if (descriptor.sourceKind !== "message" && descriptor.sourceKind !== "message_revision") {
          throw new MemoryStewardRuntimeError("source_stale", false);
        }
        const authorized = await options.authority.authorizeSource(batch, {
          sourceKind: descriptor.sourceKind,
          sourceId: descriptor.sourceId,
          sourceRevision: descriptor.sourceRevision,
        }, signal);
        if (authorized.kind !== "message") throw new MemoryStewardRuntimeError("source_stale", false);
        content = boundedUtf8(authorized.content, maximumBytes);
      }
      const used = encoder.encode(content).byteLength;
      remainingBytes -= used;
      result.push(Object.freeze({
        roomId: batch.roomId,
        sourceId: descriptor.sourceId,
        sourceRevision: descriptor.sourceRevision,
        sourceKind: descriptor.sourceKind,
        corpusSeq: descriptor.corpusSeq,
        eligibility: "eligible" as const,
        content,
      }));
    }
    return Object.freeze(result);
  }

  return Object.freeze({
    readiness: options.readiness,
    async process(batch: MemoryStewardBatch, signal: AbortSignal): Promise<MemoryStewardBatchResult> {
      try {
        const sources = await frozenSources(batch, signal);
        const plan: MemoryStewardPlan = sources.length === 0
          ? Object.freeze({ schemaVersion: 1 as const, candidates: Object.freeze([]) })
          : await options.provider.generate({
              purpose: "room_memory_steward",
              roomId: batch.roomId,
              generation: batch.recoveryGeneration,
              fromWatermarkExclusive: batch.fromWatermarkExclusive,
              toCorpusSeqInclusive: batch.toCorpusSeqInclusive,
              sources,
            }, {
              async isCurrentEligibleSource(source, validatorSignal) {
                const authorized = await options.authority.authorizeSource(batch, {
                  sourceKind: source.sourceKind as "message" | "message_revision" | "attachment_extraction",
                  sourceId: source.sourceId,
                  sourceRevision: source.sourceRevision,
                }, validatorSignal);
                return authorized.roomId === source.roomId && authorized.sourceKind === source.sourceKind &&
                  authorized.sourceId === source.sourceId && authorized.sourceRevision === source.sourceRevision &&
                  authorized.corpusSeq === source.corpusSeq;
              },
              isKnownMemoryRecord(target, validatorSignal) {
                return options.authority.isKnownRecord(
                  target.roomId, target.memoryRecordId, target.kind, validatorSignal,
                );
              },
            }, signal);
        const outputSha256 = createHash("sha256").update(canonicalJson(plan)).digest("hex");
        return Object.freeze({
          jobId: batch.jobId,
          attemptId: batch.attemptId,
          recoveryGeneration: batch.recoveryGeneration,
          candidateCount: plan.candidates.length,
          outputSha256,
          plan,
        });
      } catch (error: unknown) {
        throw classify(error);
      }
    },
  });
}
