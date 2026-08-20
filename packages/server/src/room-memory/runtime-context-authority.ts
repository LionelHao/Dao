import { Buffer } from "node:buffer";
import {
  isRoomMemoryRawDeltaPage,
  type RoomMemoryRawDeltaPage,
  type RoomMemorySource,
  type RoomMemoryStatus,
  type RoomMemoryVersionProjection,
} from "@native-im/core";
import type { DatabaseSync } from "node:sqlite";
import { readMemoryCorpusDelta, type MemoryCorpusSource } from "./corpus-database-authority.js";
import { readRoomMemorySnapshot, readRoomMemoryStatus } from "./database-authority.js";

export type RoomMemoryRuntimeContextPage = Readonly<{
  roomId: string;
  status: RoomMemoryStatus;
  injectableSnapshot: readonly RoomMemoryVersionProjection[];
  rawDelta: RoomMemoryRawDeltaPage;
}>;

export class RoomMemoryRuntimeContextError extends Error {
  constructor(readonly code: "invalid_input" | "cursor_stale" | "storage_invariant") {
    super(`Room memory runtime context rejected: ${code}`);
    this.name = "RoomMemoryRuntimeContextError";
  }
}

type Cursor = Readonly<{
  version: 1;
  roomId: string;
  watermark: number;
  head: number;
  after: number;
  authorizationEpoch: number;
}>;

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
        Reflect.ownKeys(parsed).length !== 6) throw new Error("closed cursor");
    const cursor = parsed as Record<string, unknown>;
    if (cursor.version !== 1 || !validIdentifier(cursor.roomId) || !nonnegative(cursor.watermark) ||
        !nonnegative(cursor.head) || !nonnegative(cursor.after) ||
        !nonnegative(cursor.authorizationEpoch) || cursor.watermark > cursor.after ||
        cursor.after > cursor.head) throw new Error("invalid cursor");
    return Object.freeze({ version: 1, roomId: cursor.roomId,
      watermark: cursor.watermark, head: cursor.head, after: cursor.after,
      authorizationEpoch: cursor.authorizationEpoch });
  } catch {
    throw new RoomMemoryRuntimeContextError("invalid_input");
  }
}

function source(value: MemoryCorpusSource): RoomMemorySource {
  const author = "authorKind" in value.safeMetadata ? value.safeMetadata.authorKind : null;
  const result: RoomMemorySource = Object.freeze({
    roomId: value.roomId,
    corpusSeq: value.corpusSeq,
    serverStreamSeq: value.serverStreamSeq,
    sourceKind: value.sourceKind,
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
    occurredAt: value.occurredAt,
    eligibility: value.eligibility,
    availability: value.availability,
    metadata: Object.freeze({
      speakerActorId: author === null ? null : value.sourceActorId,
      speakerKind: author,
      provenance: value.sourceKind === "attachment_extraction"
        ? "ready-bound-active extraction"
        : value.sourceKind === "project_fact_checkpoint" ? "confirmed project checkpoint" : null,
    }),
    authorizedReadRef: structuredClone(value.authorizedReadRef),
  });
  return result;
}

export function readRoomMemoryRuntimeContext(
  database: DatabaseSync,
  input: Readonly<{
    roomId: string;
    authorizationEpoch: number;
    cursor?: string | null;
  }>,
): RoomMemoryRuntimeContextPage {
  if (typeof input !== "object" || input === null || Array.isArray(input) ||
      !Reflect.ownKeys(input).every((key) => typeof key === "string" &&
        ["roomId", "authorizationEpoch", "cursor"].includes(key)) ||
      !Object.hasOwn(input, "roomId") || !Object.hasOwn(input, "authorizationEpoch") ||
      !validIdentifier(input.roomId) || !nonnegative(input.authorizationEpoch) ||
      !(input.cursor === undefined || input.cursor === null ||
        (typeof input.cursor === "string" && Buffer.byteLength(input.cursor, "utf8") <= 2_048))) {
    throw new RoomMemoryRuntimeContextError("invalid_input");
  }
  const status = readRoomMemoryStatus(database, input.roomId);
  const prior = input.cursor === undefined || input.cursor === null ? undefined : decodeCursor(input.cursor);
  if (prior !== undefined && (prior.roomId !== input.roomId ||
      prior.authorizationEpoch !== input.authorizationEpoch ||
      prior.watermark > status.health.memoryWatermark || prior.head > status.health.corpusHead)) {
    throw new RoomMemoryRuntimeContextError("cursor_stale");
  }
  const watermark = prior?.watermark ?? status.health.memoryWatermark;
  const head = prior?.head ?? status.health.corpusHead;
  const after = prior?.after ?? watermark;
  const delta = readMemoryCorpusDelta(database, { roomId: input.roomId,
    fromCorpusSeqExclusive: after, frozenCorpusHead: head, limit: 64 });
  const nextCursor = delta.hasMore ? encodeCursor({ version: 1, roomId: input.roomId,
    watermark, head, after: delta.nextCorpusSeq,
    authorizationEpoch: input.authorizationEpoch }) : null;
  const rawDelta: RoomMemoryRawDeltaPage = Object.freeze({
    roomId: input.roomId,
    fromWatermarkExclusive: watermark,
    toCorpusSeqInclusive: head,
    authorizationEpoch: input.authorizationEpoch,
    cursor: input.cursor ?? null,
    entries: Object.freeze(delta.entries.map(source)),
    nextCursor,
    hasMore: nextCursor !== null,
  });
  if (!isRoomMemoryRawDeltaPage(rawDelta)) {
    throw new RoomMemoryRuntimeContextError("storage_invariant");
  }
  return Object.freeze({ roomId: input.roomId, status,
    injectableSnapshot: readRoomMemorySnapshot(database, input.roomId), rawDelta });
}
