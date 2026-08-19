import type { SecretProvider } from "../agent-runtime/contracts.js";

export const MEMORY_STEWARD_SCHEMA_VERSION = 1 as const;
export const MEMORY_STEWARD_MAX_SOURCES = 32;
export const MEMORY_STEWARD_MAX_CANDIDATES = 32;
export const MEMORY_STEWARD_MAX_SOURCE_CONTENT_BYTES = 64 * 1_024;
export const MEMORY_STEWARD_MAX_TOTAL_CONTENT_BYTES = 256 * 1_024;
export const MEMORY_STEWARD_MAX_REQUEST_BYTES = 384 * 1_024;
export const MEMORY_STEWARD_MAX_OUTPUT_BYTES = 64 * 1_024;
export const MEMORY_STEWARD_MAX_DERIVED_TEXT_BYTES = 4_096;
export const MEMORY_STEWARD_MAX_SOURCE_REFS = 16;
export const MEMORY_STEWARD_MAX_DEDUPE_KEY_BYTES = 128;
export const MEMORY_STEWARD_TIMEOUT_MS = 60_000;

export type RoomMemorySourceKind =
  | "message"
  | "message_revision"
  | "message_tombstone"
  | "attachment_extraction"
  | "project_fact_checkpoint";

export type RoomMemoryKind =
  | "goal"
  | "decision"
  | "context"
  | "next_action"
  | "open_question_or_blocker";

export type MemoryStewardCandidateOperation = "create" | "replace" | "merge" | "no_change";

export interface FrozenMemoryStewardSource {
  readonly roomId: string;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly sourceKind: RoomMemorySourceKind;
  readonly corpusSeq: number;
  readonly eligibility: "eligible";
  readonly content: string;
}

export interface MemoryStewardProviderInput {
  readonly purpose: "room_memory_steward";
  readonly roomId: string;
  readonly generation: number;
  readonly fromWatermarkExclusive: number;
  readonly toCorpusSeqInclusive: number;
  readonly sources: readonly FrozenMemoryStewardSource[];
}

export interface MemoryStewardSourceRef {
  readonly sourceId: string;
  readonly sourceRevision: number;
}

export interface MemoryStewardCandidate {
  readonly operation: MemoryStewardCandidateOperation;
  readonly kind: RoomMemoryKind;
  readonly derivedText: string;
  readonly sourceRefs: readonly MemoryStewardSourceRef[];
  readonly dedupeKey: string;
  readonly replacesMemoryRecordId: string | null;
}

export interface MemoryStewardPlan {
  readonly schemaVersion: typeof MEMORY_STEWARD_SCHEMA_VERSION;
  readonly candidates: readonly MemoryStewardCandidate[];
}

export interface MemoryStewardReplacementTarget {
  readonly roomId: string;
  readonly memoryRecordId: string;
  readonly kind: RoomMemoryKind;
}

/**
 * These callbacks are an authority seam, not a test fixture. The provider calls
 * source validation both before network I/O and after parsing the response so a
 * source that drifts during model execution cannot produce a committable plan.
 */
export interface MemoryStewardProviderValidators {
  isCurrentEligibleSource(source: FrozenMemoryStewardSource, signal: AbortSignal): boolean | Promise<boolean>;
  isKnownMemoryRecord(target: MemoryStewardReplacementTarget, signal: AbortSignal): boolean | Promise<boolean>;
}

export interface MemoryStewardProvider {
  readonly id: "openai-memory-steward";
  generate(
    input: MemoryStewardProviderInput,
    validators: MemoryStewardProviderValidators,
    signal: AbortSignal,
  ): Promise<MemoryStewardPlan>;
}

export type MemoryStewardProviderErrorCode =
  | "noauth"
  | "input_invalid"
  | "source_stale"
  | "authority_unavailable"
  | "provider_authentication"
  | "provider_timeout"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_rejected"
  | "provider_malformed";

const RETRYABLE_ERRORS = new Set<MemoryStewardProviderErrorCode>([
  "authority_unavailable",
  "provider_timeout",
  "provider_rate_limited",
  "provider_unavailable",
]);

export class MemoryStewardProviderError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: MemoryStewardProviderErrorCode, message: string) {
    super(message);
    this.name = "MemoryStewardProviderError";
    this.retryable = RETRYABLE_ERRORS.has(code);
  }
}

export interface OpenAIMemoryStewardProviderConfig {
  readonly endpoint: string;
  readonly model: string;
  readonly secretProvider: SecretProvider;
}
