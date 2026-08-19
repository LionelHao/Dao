import type { DatabaseSync } from "node:sqlite";
import { isRoomMemorySourceIdentity } from "@native-im/core";
import type {
  RoomMemoryAuthorizedReadRef,
  RoomMemorySourceAvailability,
  RoomMemorySourceEligibility,
  RoomMemorySourceKind,
} from "@native-im/core";

export type MemoryCorpusSourceKind = RoomMemorySourceKind;
export type MemoryCorpusEligibility = RoomMemorySourceEligibility;
export type MemoryCorpusAvailability = RoomMemorySourceAvailability;

export type MemoryCorpusSafeMetadata =
  | Readonly<{ authorKind: "human" | "agent"; messageId: string }>
  | Readonly<{ messageId: string; lifecycle: "recalled" }>
  | Readonly<{ attachmentId: string; messageId: string; status: "ready-bound-active" }>
  | Readonly<{ aggregateId: string; version: number }>;

export interface MemoryCorpusSourceIdentity {
  readonly roomId: string;
  readonly sourceKind: MemoryCorpusSourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
}

export interface RegisterMemoryCorpusSourceInput extends MemoryCorpusSourceIdentity {
  readonly serverStreamSeq: number;
  readonly eligibility: MemoryCorpusEligibility;
  readonly availability: MemoryCorpusAvailability;
  readonly sourceActorId: string | null;
  readonly safeMetadata: MemoryCorpusSafeMetadata;
  readonly readReference: string;
  readonly occurredAt: string;
}

export interface MemoryCorpusSource extends Omit<RegisterMemoryCorpusSourceInput, "readReference"> {
  readonly corpusSeq: number;
  readonly authorizedReadRef: RoomMemoryAuthorizedReadRef;
}

export interface TransitionMemoryCorpusSourceInput extends MemoryCorpusSourceIdentity {
  readonly eligibility: Exclude<MemoryCorpusEligibility, "eligible">;
  readonly availability: Exclude<MemoryCorpusAvailability, "readable">;
  readonly occurredAt: string;
}

export interface MemoryCorpusDeltaPage {
  readonly roomId: string;
  readonly fromCorpusSeqExclusive: number;
  readonly frozenCorpusHead: number;
  readonly entries: readonly MemoryCorpusSource[];
  readonly nextCorpusSeq: number;
  readonly hasMore: boolean;
}

export class MemoryCorpusDatabaseError extends Error {
  public constructor(public readonly code:
    | "invalid_input"
    | "room_not_found"
    | "source_not_found"
    | "source_identity_conflict"
    | "corpus_discontinuity"
    | "storage_invariant",
  ) {
    super(code);
    this.name = "MemoryCorpusDatabaseError";
  }
}

type UnknownRecord = Record<PropertyKey, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}

function boundedText(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function safeMetadata(kind: MemoryCorpusSourceKind, value: unknown): value is MemoryCorpusSafeMetadata {
  if (!record(value)) return false;
  if (kind === "message" || kind === "message_revision") {
    return exact(value, ["authorKind", "messageId"]) &&
      (value.authorKind === "human" || value.authorKind === "agent") && boundedText(value.messageId, 256);
  }
  if (kind === "message_tombstone") {
    return exact(value, ["messageId", "lifecycle"]) && boundedText(value.messageId, 256) && value.lifecycle === "recalled";
  }
  if (kind === "attachment_extraction") {
    return exact(value, ["attachmentId", "messageId", "status"]) &&
      boundedText(value.attachmentId, 256) && boundedText(value.messageId, 256) && value.status === "ready-bound-active";
  }
  return exact(value, ["aggregateId", "version"]) && boundedText(value.aggregateId, 256) && positive(value.version);
}

const kinds = new Set<MemoryCorpusSourceKind>([
  "message", "message_revision", "message_tombstone", "attachment_extraction", "project_fact_checkpoint",
]);
const eligibilities = new Set<MemoryCorpusEligibility>([
  "eligible", "excluded_recalled", "excluded_revised", "excluded_revoked", "excluded_unbound", "excluded_unsafe", "unavailable",
]);
const availabilities = new Set<MemoryCorpusAvailability>([
  "readable", "tombstone", "metadata_only", "temporarily_unavailable",
]);

function validStoredReference(kind: MemoryCorpusSourceKind, value: string): boolean {
  if (!boundedText(value, 512) || /(?:https?:\/\/|file:|\/Users\/|\\)/iu.test(value)) return false;
  if (kind === "attachment_extraction") return value.startsWith("attachment-authority:");
  if (kind === "project_fact_checkpoint") return value.startsWith("project-authority:");
  return value.startsWith("message-authority:");
}

function validateInput(input: RegisterMemoryCorpusSourceInput): void {
  if (!record(input) || !exact(input, [
    "roomId", "sourceKind", "sourceId", "sourceRevision", "serverStreamSeq",
    "eligibility", "availability", "sourceActorId", "safeMetadata",
    "readReference", "occurredAt",
  ]) || !boundedText(input.roomId, 256) || !isRoomMemorySourceIdentity({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
  }) ||
      !positive(input.sourceRevision) || !positive(input.serverStreamSeq) || !eligibilities.has(input.eligibility) ||
      !availabilities.has(input.availability) || (input.sourceActorId !== null && !boundedText(input.sourceActorId, 256)) ||
      !safeMetadata(input.sourceKind, input.safeMetadata) || !validStoredReference(input.sourceKind, input.readReference) ||
      !boundedText(input.occurredAt, 64)) {
    throw new MemoryCorpusDatabaseError("invalid_input");
  }
  if (input.sourceKind === "message_tombstone" &&
      (input.eligibility !== "excluded_recalled" || input.availability !== "tombstone")) {
    throw new MemoryCorpusDatabaseError("invalid_input");
  }
}

function parseMetadata(kind: MemoryCorpusSourceKind, value: string): MemoryCorpusSafeMetadata {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new MemoryCorpusDatabaseError("storage_invariant"); }
  if (!safeMetadata(kind, parsed)) throw new MemoryCorpusDatabaseError("storage_invariant");
  return Object.freeze(parsed);
}

function sourceFromRow(row: Record<string, unknown>): MemoryCorpusSource {
  const kind = row.sourceKind as MemoryCorpusSourceKind;
  const eligibility = row.eligibility as MemoryCorpusEligibility;
  const availability = row.availability as MemoryCorpusAvailability;
  if (!kinds.has(kind) || !eligibilities.has(eligibility) || !availabilities.has(availability) ||
      typeof row.roomId !== "string" || typeof row.sourceId !== "string" || !positive(row.sourceRevision) ||
      !positive(row.corpusSeq) || !positive(row.serverStreamSeq) || typeof row.safeMetadataJson !== "string" ||
      (row.sourceActorId !== null && typeof row.sourceActorId !== "string") || typeof row.occurredAt !== "string" ||
      typeof row.readReference !== "string") {
    throw new MemoryCorpusDatabaseError("storage_invariant");
  }
  if (typeof row.readReference !== "string" || !validStoredReference(kind, row.readReference)) {
    throw new MemoryCorpusDatabaseError("storage_invariant");
  }
  return Object.freeze({
    roomId: row.roomId,
    corpusSeq: row.corpusSeq,
    sourceKind: kind,
    sourceId: row.sourceId,
    sourceRevision: row.sourceRevision,
    serverStreamSeq: row.serverStreamSeq,
    eligibility,
    availability,
    sourceActorId: row.sourceActorId as string | null,
    safeMetadata: parseMetadata(kind, row.safeMetadataJson),
    authorizedReadRef: Object.freeze({ sourceKind: kind, opaqueId: row.readReference }),
    occurredAt: row.occurredAt,
  });
}

const SOURCE_SELECT = `
  SELECT room_id AS roomId, corpus_seq AS corpusSeq, source_kind AS sourceKind,
         source_id AS sourceId, source_revision AS sourceRevision,
         server_stream_seq AS serverStreamSeq, eligibility, availability,
         source_actor_id AS sourceActorId, safe_metadata_json AS safeMetadataJson,
         read_reference AS readReference, occurred_at AS occurredAt
  FROM room_memory_sources`;

function sameSource(current: MemoryCorpusSource, storedReadReference: string, input: RegisterMemoryCorpusSourceInput): boolean {
  return current.roomId === input.roomId && current.sourceKind === input.sourceKind && current.sourceId === input.sourceId &&
    current.sourceRevision === input.sourceRevision && current.serverStreamSeq === input.serverStreamSeq &&
    current.eligibility === input.eligibility && current.availability === input.availability &&
    current.sourceActorId === input.sourceActorId && JSON.stringify(current.safeMetadata) === JSON.stringify(input.safeMetadata) &&
    storedReadReference === input.readReference && current.occurredAt === input.occurredAt;
}

export function readMemoryCorpusSource(database: DatabaseSync, identity: MemoryCorpusSourceIdentity): MemoryCorpusSource | undefined {
  const row = database.prepare(`${SOURCE_SELECT}
    WHERE room_id = ? AND source_kind = ? AND source_id = ? AND source_revision = ?`)
    .get(identity.roomId, identity.sourceKind, identity.sourceId, identity.sourceRevision);
  return row === undefined ? undefined : sourceFromRow(row);
}

export function registerMemoryCorpusSource(
  database: DatabaseSync,
  input: RegisterMemoryCorpusSourceInput,
): { readonly source: MemoryCorpusSource; readonly replayed: boolean } {
  validateInput(input);
  const existingRow = database.prepare(`${SOURCE_SELECT}
    WHERE room_id = ? AND source_kind = ? AND source_id = ? AND source_revision = ?`)
    .get(input.roomId, input.sourceKind, input.sourceId, input.sourceRevision);
  const existing = existingRow === undefined ? undefined : sourceFromRow(existingRow);
  if (existing !== undefined) {
    if (typeof existingRow?.readReference !== "string" || !sameSource(existing, existingRow.readReference, input)) {
      throw new MemoryCorpusDatabaseError("source_identity_conflict");
    }
    return Object.freeze({ source: existing, replayed: true });
  }
  const steward = database.prepare(
    "SELECT corpus_head AS corpusHead FROM room_memory_stewards WHERE room_id = ?",
  ).get(input.roomId);
  if (typeof steward?.corpusHead !== "number" || !Number.isSafeInteger(steward.corpusHead) || steward.corpusHead < 0) {
    throw new MemoryCorpusDatabaseError("room_not_found");
  }
  const corpusSeq = steward.corpusHead + 1;
  database.prepare(`
    INSERT INTO room_memory_sources (
      room_id, corpus_seq, source_kind, source_id, source_revision,
      server_stream_seq, eligibility, availability, source_actor_id,
      safe_metadata_json, read_reference, occurred_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.roomId, corpusSeq, input.sourceKind, input.sourceId, input.sourceRevision,
    input.serverStreamSeq, input.eligibility, input.availability, input.sourceActorId,
    JSON.stringify(input.safeMetadata), input.readReference, input.occurredAt, input.occurredAt,
  );
  const created = readMemoryCorpusSource(database, input);
  if (created === undefined || created.corpusSeq !== corpusSeq) throw new MemoryCorpusDatabaseError("storage_invariant");
  return Object.freeze({ source: created, replayed: false });
}

export function transitionMemoryCorpusSource(
  database: DatabaseSync,
  input: TransitionMemoryCorpusSourceInput,
): MemoryCorpusSource {
  if (!record(input) || !exact(input, [
    "roomId", "sourceKind", "sourceId", "sourceRevision",
    "eligibility", "availability", "occurredAt",
  ]) || !boundedText(input.roomId, 256) || !isRoomMemorySourceIdentity({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceRevision: input.sourceRevision,
  }) || !boundedText(input.occurredAt, 64) || !eligibilities.has(input.eligibility) ||
      !availabilities.has(input.availability)) {
    throw new MemoryCorpusDatabaseError("invalid_input");
  }
  const current = readMemoryCorpusSource(database, input);
  if (current === undefined) throw new MemoryCorpusDatabaseError("source_not_found");
  if (current.eligibility === input.eligibility && current.availability === input.availability) return current;
  database.prepare(`
    UPDATE room_memory_sources
    SET eligibility = ?, availability = ?, updated_at = ?
    WHERE room_id = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
  `).run(
    input.eligibility, input.availability, input.occurredAt,
    input.roomId, input.sourceKind, input.sourceId, input.sourceRevision,
  );
  const transitioned = readMemoryCorpusSource(database, input);
  if (transitioned === undefined) throw new MemoryCorpusDatabaseError("storage_invariant");
  return transitioned;
}

export function readMemoryCorpusDelta(database: DatabaseSync, input: {
  readonly roomId: string;
  readonly fromCorpusSeqExclusive: number;
  readonly limit: number;
  readonly frozenCorpusHead?: number;
}): MemoryCorpusDeltaPage {
  if (!record(input) || !exact(input, input.frozenCorpusHead === undefined
    ? ["roomId", "fromCorpusSeqExclusive", "limit"]
    : ["roomId", "fromCorpusSeqExclusive", "limit", "frozenCorpusHead"]) ||
      !boundedText(input.roomId, 256) || !Number.isSafeInteger(input.fromCorpusSeqExclusive) || input.fromCorpusSeqExclusive < 0 ||
      !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64 ||
      (input.frozenCorpusHead !== undefined && (!Number.isSafeInteger(input.frozenCorpusHead) || input.frozenCorpusHead < 0))) {
    throw new MemoryCorpusDatabaseError("invalid_input");
  }
  const steward = database.prepare("SELECT corpus_head AS corpusHead FROM room_memory_stewards WHERE room_id = ?").get(input.roomId);
  if (typeof steward?.corpusHead !== "number" || !Number.isSafeInteger(steward.corpusHead)) {
    throw new MemoryCorpusDatabaseError("room_not_found");
  }
  const frozenCorpusHead = input.frozenCorpusHead ?? steward.corpusHead;
  if (frozenCorpusHead > steward.corpusHead || input.fromCorpusSeqExclusive > frozenCorpusHead) {
    throw new MemoryCorpusDatabaseError("corpus_discontinuity");
  }
  const rows = database.prepare(`${SOURCE_SELECT}
    WHERE room_id = ? AND corpus_seq > ? AND corpus_seq <= ?
    ORDER BY corpus_seq LIMIT ?`)
    .all(input.roomId, input.fromCorpusSeqExclusive, frozenCorpusHead, input.limit);
  const entries = rows.map(sourceFromRow);
  if (entries.length > 0 && entries[0]?.corpusSeq !== input.fromCorpusSeqExclusive + 1) {
    throw new MemoryCorpusDatabaseError("corpus_discontinuity");
  }
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]?.corpusSeq !== entries[index - 1]!.corpusSeq + 1) {
      throw new MemoryCorpusDatabaseError("corpus_discontinuity");
    }
  }
  const nextCorpusSeq = entries.at(-1)?.corpusSeq ?? input.fromCorpusSeqExclusive;
  return Object.freeze({
    roomId: input.roomId,
    fromCorpusSeqExclusive: input.fromCorpusSeqExclusive,
    frozenCorpusHead,
    entries: Object.freeze(entries),
    nextCorpusSeq,
    hasMore: nextCorpusSeq < frozenCorpusHead,
  });
}
