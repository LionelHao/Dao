import { Buffer } from "node:buffer";
import {
  isRoomMemoryRepairRecord,
  type RoomMemoryRepairRecord,
  type RoomRepairRecord,
} from "@native-im/core";
import type {
  RepairKeysetPageInput,
  RoomRepairSegmentDescriptor,
} from "../persistence/repair-projection-registry.js";

export const ROOM_MEMORY_REPAIR_KEYSET_LIMIT = 200;

export type RoomMemoryRepairDescriptorFailureReason =
  | "invalid_input"
  | "malformed_storage";

export class RoomMemoryRepairDescriptorError extends Error {
  readonly reason: RoomMemoryRepairDescriptorFailureReason;

  constructor(reason: RoomMemoryRepairDescriptorFailureReason) {
    super(`Room memory repair descriptor rejected: ${reason}`);
    this.name = "RoomMemoryRepairDescriptorError";
    this.reason = reason;
  }
}

type UnknownRecord = Record<string, unknown>;
type RoomRepairKind = RoomRepairRecord["kind"];

const MEMORY_REPAIR_SQL = `
  SELECT candidate.*
  FROM (
    SELECT
      '0:status' AS stableKey,
      'status' AS recordType,
      steward.room_id AS roomId,
      steward.health AS healthState,
      steward.health_reason_code AS healthReason,
      steward.memory_watermark AS memoryWatermark,
      steward.corpus_head AS corpusHead,
      steward.last_attempt_at AS lastAttemptAt,
      steward.retryable AS retryable,
      steward.recovery_required AS recoveryRequired,
      steward.recovery_generation AS recoveryGeneration,
      steward.updated_at AS updatedAt,
      NULL AS memoryRecordId,
      NULL AS memoryVersionId,
      NULL AS versionNumber,
      NULL AS memoryKind,
      NULL AS versionState,
      NULL AS derivedText,
      NULL AS versionCreatedAt,
      NULL AS replacesMemoryVersionId,
      '[]' AS sourceRefsJson,
      '[]' AS disputesJson,
      '[]' AS resolutionsJson
    FROM room_memory_stewards AS steward
    WHERE steward.room_id = ?1

    UNION ALL

    SELECT
      '1:' || lower(hex(CAST(record.memory_record_id AS BLOB))) AS stableKey,
      'projection' AS recordType,
      record.room_id AS roomId,
      NULL AS healthState,
      NULL AS healthReason,
      NULL AS memoryWatermark,
      NULL AS corpusHead,
      NULL AS lastAttemptAt,
      NULL AS retryable,
      NULL AS recoveryRequired,
      NULL AS recoveryGeneration,
      NULL AS updatedAt,
      record.memory_record_id AS memoryRecordId,
      version.memory_version_id AS memoryVersionId,
      version.version_number AS versionNumber,
      version.kind AS memoryKind,
      version.state AS versionState,
      version.derived_text AS derivedText,
      version.created_at AS versionCreatedAt,
      version.replaces_version_id AS replacesMemoryVersionId,
      COALESCE((
        SELECT json_group_array(json(sourceRefJson))
        FROM (
          SELECT json_object(
            'sourceKind', source.source_kind,
            'sourceId', source.source_id,
            'sourceRevision', source.source_revision,
            'eligibility', source.eligibility,
            'availability', source.availability
          ) AS sourceRefJson
          FROM room_memory_source_edges AS edge
          JOIN room_memory_sources AS source
            ON source.room_id = edge.room_id
           AND source.source_kind = edge.source_kind
           AND source.source_id = edge.source_id
           AND source.source_revision = edge.source_revision
          WHERE edge.memory_version_id = version.memory_version_id
          ORDER BY source.source_kind, source.source_id, source.source_revision
        )
      ), '[]') AS sourceRefsJson,
      COALESCE((
        SELECT json_group_array(json(disputeJson))
        FROM (
          SELECT json_object(
            'disputeId', dispute.dispute_id,
            'roomId', dispute.room_id,
            'memoryRecordId', dispute.memory_record_id,
            'memoryVersionId', dispute.disputed_version_id,
            'operatorActorId', dispute.operator_actor_id,
            'reason', dispute.reason,
            'status', CASE WHEN resolution.dispute_id IS NULL
              THEN 'open' ELSE 'resolved' END,
            'createdAt', dispute.created_at
          ) AS disputeJson
          FROM room_memory_disputes AS dispute
          LEFT JOIN room_memory_resolutions AS resolution
            ON resolution.dispute_id = dispute.dispute_id
          WHERE dispute.memory_record_id = record.memory_record_id
            AND dispute.room_id = record.room_id
          ORDER BY dispute.created_at, dispute.dispute_id
        )
      ), '[]') AS disputesJson,
      COALESCE((
        SELECT json_group_array(json(resolutionJson))
        FROM (
          SELECT json_object(
            'resolutionId', resolution.resolution_id,
            'disputeId', resolution.dispute_id,
            'roomId', resolution.room_id,
            'memoryRecordId', resolution.memory_record_id,
            'fromMemoryVersionId', resolution.expected_disputed_version_id,
            'replacementMemoryVersionId', COALESCE(
              resolution.replacement_version_id,
              resolution.resolution_version_id
            ),
            'operatorActorId', resolution.operator_actor_id,
            'action', CASE WHEN resolution.resolution = 're_evaluate'
              THEN 're_evaluate' ELSE 'resolve' END,
            'reason', resolution.reason,
            'resolvedAt', resolution.created_at
          ) AS resolutionJson
          FROM room_memory_resolutions AS resolution
          WHERE resolution.memory_record_id = record.memory_record_id
            AND resolution.room_id = record.room_id
          ORDER BY resolution.created_at, resolution.resolution_id
        )
      ), '[]') AS resolutionsJson
    FROM room_memory_records AS record
    JOIN room_memory_versions AS version
      ON version.memory_version_id = record.current_version_id
     AND version.memory_record_id = record.memory_record_id
     AND version.room_id = record.room_id
     AND version.kind = record.kind
     AND version.version_number = record.current_version_number
    WHERE record.room_id = ?1
  ) AS candidate
  WHERE candidate.stableKey > ?2
  ORDER BY candidate.stableKey
  LIMIT ?3
`;

function reject(reason: RoomMemoryRepairDescriptorFailureReason): never {
  throw new RoomMemoryRepairDescriptorError(reason);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStableKey(value: string): boolean {
  return value === "0:status" || /^1:[0-9a-f]+$/u.test(value);
}

function validateReadInput(input: RepairKeysetPageInput): void {
  if (!isIdentifier(input.roomId) || !isNonnegativeSafeInteger(input.watermark) ||
      !Number.isSafeInteger(input.limit) || input.limit < 1 ||
      input.limit > ROOM_MEMORY_REPAIR_KEYSET_LIMIT ||
      (input.afterKey !== undefined && !isStableKey(input.afterKey))) {
    reject("invalid_input");
  }
}

function parseJsonArray(value: unknown): readonly unknown[] {
  if (typeof value !== "string") reject("malformed_storage");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) reject("malformed_storage");
    return parsed;
  } catch {
    return reject("malformed_storage");
  }
}

function sqliteBoolean(value: unknown): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  return reject("malformed_storage");
}

function statusReason(state: unknown, reason: unknown): unknown {
  if (state === "healthy" && reason === null) return "none";
  if (state === "catching_up" && reason === null) return "backlog";
  return reason;
}

function mapStatusRow(row: UnknownRecord): RoomMemoryRepairRecord {
  const memoryWatermark = row.memoryWatermark;
  const corpusHead = row.corpusHead;
  const record = {
    kind: "memory" as const,
    roomId: row.roomId,
    value: {
      recordType: "status" as const,
      status: {
        roomId: row.roomId,
        health: {
          state: row.healthState,
          reason: statusReason(row.healthState, row.healthReason),
          memoryWatermark,
          corpusHead,
          lag: typeof memoryWatermark === "number" && typeof corpusHead === "number"
            ? corpusHead - memoryWatermark
            : Number.NaN,
          lastAttemptAt: row.lastAttemptAt,
          retryable: sqliteBoolean(row.retryable),
          recoveryRequired: sqliteBoolean(row.recoveryRequired),
        },
        recoveryGeneration: row.recoveryGeneration,
        updatedAt: row.updatedAt,
      },
    },
  };
  if (!isRoomMemoryRepairRecord(record)) reject("malformed_storage");
  return Object.freeze(record);
}

function mapProjectionRow(row: UnknownRecord): RoomMemoryRepairRecord {
  const record = {
    kind: "memory" as const,
    roomId: row.roomId,
    value: {
      recordType: "projection" as const,
      projection: {
        projectionKind: "memory" as const,
        roomId: row.roomId,
        memoryRecordId: row.memoryRecordId,
        kind: row.memoryKind,
        currentVersion: {
          roomId: row.roomId,
          memoryRecordId: row.memoryRecordId,
          memoryVersionId: row.memoryVersionId,
          version: row.versionNumber,
          kind: row.memoryKind,
          state: row.versionState,
          derivedText: row.derivedText,
          sourceRefs: parseJsonArray(row.sourceRefsJson),
          createdAt: row.versionCreatedAt,
          replacesMemoryVersionId: row.replacesMemoryVersionId,
        },
        disputes: parseJsonArray(row.disputesJson),
        resolutions: parseJsonArray(row.resolutionsJson),
      },
    },
  };
  if (!isRoomMemoryRepairRecord(record)) reject("malformed_storage");
  return Object.freeze(record);
}

function readMemoryKeysetPage(input: RepairKeysetPageInput): readonly unknown[] {
  validateReadInput(input);
  const afterKey = input.afterKey ?? "";
  const rows = input.database.prepare(MEMORY_REPAIR_SQL).all(
    input.roomId,
    afterKey,
    input.limit,
  );
  if (rows.length > input.limit) reject("malformed_storage");
  return rows;
}

function mapMemoryRow(row: unknown): RoomMemoryRepairRecord {
  if (!isRecord(row)) reject("malformed_storage");
  if (row.recordType === "status") return mapStatusRow(row);
  if (row.recordType === "projection") return mapProjectionRow(row);
  return reject("malformed_storage");
}

function memoryStableKey(record: RoomRepairRecord): string {
  if (!isRoomMemoryRepairRecord(record)) reject("malformed_storage");
  if (record.value.recordType === "status") return "0:status";
  return `1:${Buffer.from(
    record.value.projection.memoryRecordId,
    "utf8",
  ).toString("hex")}`;
}

export const memoryRepairSegmentDescriptor = Object.freeze({
  descriptorId: "dao.repair.memory.v1",
  descriptorVersion: 1,
  kind: "memory",
  order: 17,
  readKeysetPage: readMemoryKeysetPage,
  mapRow: mapMemoryRow,
  stableKey: memoryStableKey,
}) satisfies RoomRepairSegmentDescriptor<RoomRepairKind, RoomRepairRecord>;
