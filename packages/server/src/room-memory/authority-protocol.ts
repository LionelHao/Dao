import {
  isRoomMemoryKind,
  isRoomMemoryRequest,
  type RoomMemoryKind,
  type RoomMemoryRequest,
  type RoomMemorySourceKind,
  type RoomMemorySuccessFrame,
} from "@native-im/core";
import type { AuthenticatedSessionContext, JsonValue } from "../persistence/contracts.js";
import {
  MEMORY_STEWARD_MAX_CANDIDATES,
  MEMORY_STEWARD_MAX_DEDUPE_KEY_BYTES,
  MEMORY_STEWARD_MAX_DERIVED_TEXT_BYTES,
  MEMORY_STEWARD_MAX_SOURCE_REFS,
  MEMORY_STEWARD_SCHEMA_VERSION,
  type MemoryStewardPlan,
} from "./contracts.js";
import type {
  FrozenRoomMemoryJobSource,
  RoomMemoryJob,
} from "./database-authority.js";
import type { MemoryRuntimeReadiness } from "./runtime-readiness.js";

export interface MemoryAuthorityBatch {
  readonly roomId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly recoveryGeneration: number;
  readonly fromWatermarkExclusive: number;
  readonly toCorpusSeqInclusive: number;
  readonly sourceCount: number;
}

export type MemoryAuthorityFailureCode =
  | "provider_timeout"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "invalid_provider_output"
  | "provider_output_oversized"
  | "attempt_dead_lettered"
  | "authority_unavailable"
  | "shutdown"
  | "source_stale";

export type MemoryAuthorityOperation =
  | Readonly<{
      type: "memory.public";
      context: AuthenticatedSessionContext;
      request: RoomMemoryRequest;
      now: number;
    }>
  | Readonly<{ type: "memory.readiness"; roomId: string }>
  | Readonly<{ type: "memory.discover"; limit: number; now: number }>
  | Readonly<{
      type: "memory.claim";
      roomId: string;
      jobId: string;
      attemptId: string;
      inputSha256: string;
      batchSize: number;
      now: number;
    }>
  | Readonly<{
      type: "memory.source-authorize";
      batch: MemoryAuthorityBatch;
      sourceKind: RoomMemorySourceKind;
      sourceId: string;
      sourceRevision: number;
      now: number;
    }>
  | Readonly<{
      type: "memory.record-known";
      roomId: string;
      memoryRecordId: string;
      kind: RoomMemoryKind;
    }>
  | Readonly<{
      type: "memory.complete";
      batch: MemoryAuthorityBatch;
      outputSha256: string;
      plan: MemoryStewardPlan;
      now: number;
    }>
  | Readonly<{
      type: "memory.fail";
      batch: MemoryAuthorityBatch;
      errorCode: MemoryAuthorityFailureCode;
      retryable: boolean;
      nextAvailableAt: string | null;
      now: number;
    }>
  | Readonly<{ type: "memory.mark-noauth"; roomId: string; now: number }>
  | Readonly<{ type: "memory.mark-ready"; roomId: string; now: number }>
  | Readonly<{ type: "memory.abandon"; batch: MemoryAuthorityBatch; now: number }>;

export interface MemoryAuthorityFrozenSource extends FrozenRoomMemoryJobSource {
  readonly roomId: string;
}

export type MemoryAuthorityAuthorizedSource =
  | Readonly<{
      kind: "message";
      roomId: string;
      sourceKind: "message" | "message_revision";
      sourceId: string;
      sourceRevision: number;
      corpusSeq: number;
      content: string;
    }>
  | Readonly<{
      kind: "attachment";
      roomId: string;
      sourceKind: "attachment_extraction";
      sourceId: string;
      sourceRevision: number;
      corpusSeq: number;
      objectKey: string;
      sha256: string;
      byteSize: number;
    }>;

export type MemoryAuthorityOperationResult =
  | Readonly<{ kind: "public"; frame: RoomMemorySuccessFrame }>
  | Readonly<{ kind: "readiness"; readiness: MemoryRuntimeReadiness }>
  | Readonly<{ kind: "rooms"; roomIds: readonly string[] }>
  | Readonly<{
      kind: "claimed";
      batch: MemoryAuthorityBatch | null;
      sources: readonly MemoryAuthorityFrozenSource[];
    }>
  | Readonly<{ kind: "source"; source: MemoryAuthorityAuthorizedSource }>
  | Readonly<{ kind: "known-record"; known: boolean }>
  | Readonly<{ kind: "completed"; committed: boolean }>
  | Readonly<{ kind: "settled"; continueRoom: boolean }>
  | Readonly<{ kind: "status-updated" }>;

type UnknownRecord = Record<PropertyKey, unknown>;
const SOURCE_KINDS = new Set<RoomMemorySourceKind>([
  "message", "message_revision", "message_tombstone", "attachment_extraction", "project_fact_checkpoint",
]);
const FAILURE_CODES = new Set<MemoryAuthorityFailureCode>([
  "provider_timeout", "provider_rate_limited", "provider_unavailable", "invalid_provider_output",
  "provider_output_oversized", "attempt_dead_lettered", "authority_unavailable", "shutdown", "source_stale",
]);

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return nonnegative(value) && value >= 1 && value <= maximum;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function session(value: unknown): value is AuthenticatedSessionContext {
  if (!record(value) || !exact(value, ["sessionId", "sessionFamilyId", "principal"]) ||
      typeof value.sessionId !== "string" || typeof value.sessionFamilyId !== "string" || !record(value.principal)) return false;
  return exact(value.principal, ["accountId", "actorId"]) &&
    identifier(value.principal.accountId) && identifier(value.principal.actorId);
}

export function isMemoryAuthorityBatch(value: unknown): value is MemoryAuthorityBatch {
  return record(value) && exact(value, [
    "roomId", "jobId", "attemptId", "recoveryGeneration", "fromWatermarkExclusive",
    "toCorpusSeqInclusive", "sourceCount",
  ]) && identifier(value.roomId) && identifier(value.jobId) && identifier(value.attemptId) &&
    positive(value.recoveryGeneration) && nonnegative(value.fromWatermarkExclusive) &&
    positive(value.toCorpusSeqInclusive) && value.toCorpusSeqInclusive > value.fromWatermarkExclusive &&
    positive(value.sourceCount, 32) &&
    value.sourceCount === value.toCorpusSeqInclusive - value.fromWatermarkExclusive;
}

function sourceIdentity(value: UnknownRecord): boolean {
  return SOURCE_KINDS.has(value.sourceKind as RoomMemorySourceKind) && identifier(value.sourceId) &&
    positive(value.sourceRevision);
}

function plan(value: unknown): value is MemoryStewardPlan {
  if (!record(value) || !exact(value, ["schemaVersion", "candidates"]) ||
      value.schemaVersion !== MEMORY_STEWARD_SCHEMA_VERSION || !Array.isArray(value.candidates) ||
      value.candidates.length > MEMORY_STEWARD_MAX_CANDIDATES) return false;
  return value.candidates.every((candidate) => {
    if (!record(candidate) || !exact(candidate, [
      "operation", "kind", "derivedText", "sourceRefs", "dedupeKey", "replacesMemoryRecordId",
    ]) || !["create", "replace", "merge", "no_change"].includes(candidate.operation as string) ||
        !isRoomMemoryKind(candidate.kind) || typeof candidate.derivedText !== "string" ||
        Buffer.byteLength(candidate.derivedText, "utf8") > MEMORY_STEWARD_MAX_DERIVED_TEXT_BYTES ||
        !Array.isArray(candidate.sourceRefs) || candidate.sourceRefs.length < 1 ||
        candidate.sourceRefs.length > MEMORY_STEWARD_MAX_SOURCE_REFS ||
        typeof candidate.dedupeKey !== "string" || candidate.dedupeKey.length < 1 ||
        Buffer.byteLength(candidate.dedupeKey, "utf8") > MEMORY_STEWARD_MAX_DEDUPE_KEY_BYTES ||
        !(candidate.replacesMemoryRecordId === null || identifier(candidate.replacesMemoryRecordId))) return false;
    return candidate.sourceRefs.every((sourceRef) => record(sourceRef) &&
      exact(sourceRef, ["sourceKind", "sourceId", "sourceRevision"]) && sourceIdentity(sourceRef) &&
      positive(sourceRef.sourceRevision));
  });
}

export function isMemoryAuthorityOperation(value: unknown): value is MemoryAuthorityOperation {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "memory.public") return exact(value, ["type", "context", "request", "now"]) &&
    session(value.context) && isRoomMemoryRequest(value.request) && nonnegative(value.now);
  if (value.type === "memory.readiness") return exact(value, ["type", "roomId"]) && identifier(value.roomId);
  if (value.type === "memory.discover") return exact(value, ["type", "limit", "now"]) &&
    positive(value.limit, 1024) && nonnegative(value.now);
  if (value.type === "memory.claim") return exact(value, [
    "type", "roomId", "jobId", "attemptId", "inputSha256", "batchSize", "now",
  ]) && identifier(value.roomId) && identifier(value.jobId) && identifier(value.attemptId) &&
    sha256(value.inputSha256) && positive(value.batchSize, 32) && nonnegative(value.now);
  if (value.type === "memory.source-authorize") return exact(value, [
    "type", "batch", "sourceKind", "sourceId", "sourceRevision", "now",
  ]) && isMemoryAuthorityBatch(value.batch) && sourceIdentity(value) && nonnegative(value.now);
  if (value.type === "memory.record-known") return exact(value, ["type", "roomId", "memoryRecordId", "kind"]) &&
    identifier(value.roomId) && identifier(value.memoryRecordId) && isRoomMemoryKind(value.kind);
  if (value.type === "memory.complete") return exact(value, ["type", "batch", "outputSha256", "plan", "now"]) &&
    isMemoryAuthorityBatch(value.batch) && sha256(value.outputSha256) && plan(value.plan) && nonnegative(value.now);
  if (value.type === "memory.fail") return exact(value, [
    "type", "batch", "errorCode", "retryable", "nextAvailableAt", "now",
  ]) && isMemoryAuthorityBatch(value.batch) && FAILURE_CODES.has(value.errorCode as MemoryAuthorityFailureCode) &&
    typeof value.retryable === "boolean" && (value.nextAvailableAt === null || timestamp(value.nextAvailableAt)) &&
    nonnegative(value.now);
  if (value.type === "memory.mark-noauth" || value.type === "memory.mark-ready") {
    return exact(value, ["type", "roomId", "now"]) && identifier(value.roomId) && nonnegative(value.now);
  }
  return value.type === "memory.abandon" && exact(value, ["type", "batch", "now"]) &&
    isMemoryAuthorityBatch(value.batch) && nonnegative(value.now);
}

export function memoryResultAsJson(result: MemoryAuthorityOperationResult): JsonValue {
  return result as unknown as JsonValue;
}

export function memoryJobAsBatch(job: RoomMemoryJob, attemptId: string): MemoryAuthorityBatch {
  return Object.freeze({
    roomId: job.roomId,
    jobId: job.jobId,
    attemptId,
    recoveryGeneration: job.recoveryGeneration,
    fromWatermarkExclusive: job.fromWatermarkExclusive,
    toCorpusSeqInclusive: job.toCorpusSeqInclusive,
    sourceCount: job.sourceCount,
  });
}
