import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  attachmentDetectedMime,
  isAttachmentFormat,
  isAttachmentMetadata,
  isAttachmentSafeFilename,
  isAttachmentSha256,
  type AttachmentError,
  type AttachmentExtractionMethod,
  type AttachmentExtractionTool,
  type AttachmentFormat,
  type AttachmentMetadata,
  type AttachmentReadyProvenance,
} from "@native-im/core";
import type {
  AttachmentAccessDecision,
  AttachmentAgentExecutionContext,
  AttachmentAgentExtractionAuthorization,
  AttachmentAuthorityClock,
  AttachmentAuthorityIdFactory,
  AttachmentBindReceipt,
  AttachmentChunkCheckpointReceipt,
  AttachmentHumanContext,
  AttachmentProcessingClaimReceipt,
  AttachmentProcessingCompleteReceipt,
  AttachmentProcessingPlan,
  AttachmentProcessingRecoveryBatch,
  AttachmentProcessingRetryReceipt,
  AttachmentReadyReceipt,
  AttachmentStatusResult,
  AttachmentUploadBeginReceipt,
  AttachmentUploadCancelReceipt,
  AttachmentUploadFinalizeReceipt,
  AttachmentUploadAssemblyPlan,
  AttachmentWorkerContext,
  AttachmentObjectReferenceSnapshot,
} from "./database-contracts.js";
import { IDEMPOTENCY_RECEIPT_TTL_MS } from
  "../persistence/idempotency-lifecycle.js";

type ErrorCode = AttachmentError["code"];
type ErrorStatus = AttachmentError["status"];
type Row = Record<string, unknown>;

export class AttachmentAuthorityDatabaseError extends Error {
  readonly status: ErrorStatus;
  readonly code: ErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(error: AttachmentError) {
    super(`Attachment authority rejected: ${error.code}`);
    this.name = "AttachmentAuthorityDatabaseError";
    this.status = error.status;
    this.code = error.code;
    if ("retryAfterSeconds" in error) this.retryAfterSeconds = error.retryAfterSeconds;
  }
}

function fail(status: ErrorStatus, code: ErrorCode): never {
  throw new AttachmentAuthorityDatabaseError({ status, code } as AttachmentError);
}

function failCapacity(retryAfterSeconds = 60): never {
  throw new AttachmentAuthorityDatabaseError({
    status: 429,
    code: "attachment_capacity_limited",
    retryAfterSeconds,
  });
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Row, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function identifier(
  value: unknown,
  max: number = ATTACHMENT_AUTHORITY_LIMITS.maxIdentifierUtf16,
): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value === value.trim() && value.normalize("NFC") === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function opaqueKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Attachment canonical JSON rejected a value");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function now(clock: AttachmentAuthorityClock): Readonly<{ ms: number; iso: string }> {
  const ms = clock.nowMs();
  if (!Number.isSafeInteger(ms) || ms < 0) throw new TypeError("Attachment clock is invalid");
  return { ms, iso: new Date(ms).toISOString() };
}

function requireHumanContext(value: AttachmentHumanContext): void {
  if (!isRecord(value) || !exact(value, [
    "kind", "sessionId", "sessionFamilyId", "principal",
    ...(Object.hasOwn(value, "deviceId") ? ["deviceId"] : []),
  ]) || value.kind !== "human" || !identifier(value.sessionId) ||
      !identifier(value.sessionFamilyId) || !isRecord(value.principal) ||
      (Object.hasOwn(value, "deviceId") && !identifier(value.deviceId)) ||
      !exact(value.principal, ["accountId", "actorId"]) ||
      !identifier(value.principal.accountId) || !identifier(value.principal.actorId)) {
    throw new TypeError("Attachment Human context is invalid");
  }
}

function requireWorkerContext(value: AttachmentWorkerContext): void {
  if (!isRecord(value) || !exact(value, ["kind", "workerId"]) ||
      value.kind !== "attachment-worker" || !identifier(value.workerId)) {
    throw new TypeError("Attachment worker context is invalid");
  }
}

function requireHumanSession(
  database: DatabaseSync,
  context: AttachmentHumanContext,
  clock: AttachmentAuthorityClock,
): string {
  requireHumanContext(context);
  const current = now(clock);
  const row = database.prepare(`
    SELECT session.family_id AS familyId, session.account_id AS accountId,
           session.actor_id AS actorId, session.access_expires_at AS accessExpiresAt,
           session.revoked_at AS sessionRevokedAt, family.revoked_at AS familyRevokedAt,
           actor.kind AS actorKind
    FROM sessions AS session
    JOIN session_families AS family ON family.family_id = session.family_id
    JOIN actors AS actor ON actor.id = session.actor_id
    WHERE session.access_token_hash = ?
  `).get(context.sessionId);
  if (row === undefined || row.actorKind !== "human" ||
      row.familyId !== context.sessionFamilyId ||
      row.accountId !== context.principal.accountId ||
      row.actorId !== context.principal.actorId || row.sessionRevokedAt !== null ||
      row.familyRevokedAt !== null || typeof row.accessExpiresAt !== "number" ||
      row.accessExpiresAt <= current.ms) {
    return fail(401, "unauthenticated");
  }
  return context.principal.actorId;
}

interface RoomAuthority {
  readonly roomId: string;
  readonly status: "active" | "archived";
  readonly lifecycleGeneration: number;
  readonly accessRevision: number;
}

function readRoomAuthority(
  database: DatabaseSync,
  roomId: string,
  actorId: string,
): RoomAuthority | undefined {
  const row = database.prepare(`
    SELECT room.id AS roomId, room.status,
           room.archive_generation AS lifecycleGeneration,
           CASE
             WHEN access.access_revision IS NULL
               OR membership.access_revision > access.access_revision
             THEN membership.access_revision
             ELSE access.access_revision
           END AS accessRevision
    FROM rooms AS room
    JOIN room_memberships AS membership
      ON membership.room_id = room.id AND membership.actor_id = ?
     AND membership.kind = 'human'
    LEFT JOIN room_access_authority AS access ON access.room_id = room.id
    WHERE room.id = ?
  `).get(actorId, roomId);
  if (row === undefined || (row.status !== "active" && row.status !== "archived") ||
      typeof row.lifecycleGeneration !== "number" || typeof row.accessRevision !== "number") {
    return undefined;
  }
  return {
    roomId,
    status: row.status,
    lifecycleGeneration: row.lifecycleGeneration,
    accessRevision: row.accessRevision,
  };
}

function requireActiveRoomAuthority(
  database: DatabaseSync,
  roomId: string,
  actorId: string,
): RoomAuthority {
  const authority = readRoomAuthority(database, roomId, actorId);
  if (authority === undefined || authority.status !== "active") {
    return fail(403, "room_forbidden");
  }
  return authority;
}

export function runAttachmentAuthorityImmediateTransaction<Result>(
  database: DatabaseSync,
  operation: () => Result,
  beforeCommit?: () => void,
): Result {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    beforeCommit?.();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        "Attachment authority transaction rollback failed",
        { cause: error },
      );
    }
    throw error;
  }
}

type StoredReceipt = Readonly<Record<string, unknown>>;

function parseStoredReceipt(
  value: unknown,
  keys: readonly string[],
): StoredReceipt {
  if (typeof value !== "string") return fail(503, "storage_unavailable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return fail(503, "storage_unavailable");
  }
  if (!isRecord(parsed) || !exact(parsed, keys)) return fail(503, "storage_unavailable");
  return parsed;
}

function executeIdempotently<Receipt extends StoredReceipt>(
  database: DatabaseSync,
  input: Readonly<{
    scope: string;
    key: string;
    businessInput: unknown;
    conflictCode?: "idempotency_conflict" | "upload_offset_conflict";
    clock: AttachmentAuthorityClock;
    receiptKeys: readonly string[];
    execute: (occurredAt: string) => Receipt;
  }>,
): Receipt & Readonly<{ replayed: boolean }> {
  const requestHash = sha256(input.businessInput);
  const current = now(input.clock);
  database.prepare(`
    DELETE FROM idempotency_records
    WHERE scope = ? AND key = ? AND expires_at <= ?
  `).run(input.scope, input.key, current.iso);
  const existing = database.prepare(`
    SELECT request_hash AS requestHash, response_json AS responseJson
    FROM idempotency_records
    WHERE scope = ? AND key = ? AND expires_at > ?
  `).get(input.scope, input.key, current.iso);
  if (existing !== undefined) {
    if (existing.requestHash !== requestHash) {
      return fail(409, input.conflictCode ?? "idempotency_conflict");
    }
    const receipt = parseStoredReceipt(existing.responseJson, input.receiptKeys);
    return { ...receipt, replayed: true } as Receipt & Readonly<{ replayed: boolean }>;
  }
  const receipt = input.execute(current.iso);
  database.prepare(`
    INSERT INTO idempotency_records (
      scope, key, request_hash, response_json, status_code, created_at, expires_at
    ) VALUES (?, ?, ?, ?, 200, ?, ?)
  `).run(
    input.scope,
    input.key,
    requestHash,
    canonicalJson(receipt),
    current.iso,
    new Date(current.ms + IDEMPOTENCY_RECEIPT_TTL_MS).toISOString(),
  );
  return { ...receipt, replayed: false };
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, AttachmentFormat>> = Object.freeze({
  pdf: "pdf", png: "png", jpg: "jpeg", jpeg: "jpeg", docx: "docx",
  xlsx: "xlsx", txt: "txt", csv: "csv",
});

function formatForFilename(filename: string): AttachmentFormat | undefined {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return FORMAT_BY_EXTENSION[extension];
}

function validateBeginCommand(command: Row): AttachmentFormat {
  if (!exact(command, [
    "requestId", "roomId", "uploadKey", "originalFilename", "declaredMime",
    "expectedBytes", "expectedSha256",
  ]) || !identifier(command.requestId, 128) || !identifier(command.roomId) ||
      !identifier(command.uploadKey, 128) || !isAttachmentSafeFilename(command.originalFilename) ||
      !(command.declaredMime === null || typeof command.declaredMime === "string") ||
      !positiveInteger(command.expectedBytes) ||
      command.expectedBytes > ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes ||
      !isAttachmentSha256(command.expectedSha256)) {
    return fail(400, "invalid_request");
  }
  const format = formatForFilename(command.originalFilename);
  if (format === undefined) return fail(415, "attachment_type_unsupported");
  if (command.declaredMime !== null && command.declaredMime !== attachmentDetectedMime(format)) {
    return fail(415, "type_mismatch");
  }
  return format;
}

export function beginAttachmentUploadInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentHumanContext;
    command: import("./database-contracts.js").AttachmentUploadBeginCommand;
    clock: AttachmentAuthorityClock;
    ids: AttachmentAuthorityIdFactory;
  }>,
): AttachmentUploadBeginReceipt {
  const actorId = requireHumanSession(database, input.context, input.clock);
  const format = validateBeginCommand(input.command as unknown as Row);
  const room = requireActiveRoomAuthority(database, input.command.roomId, actorId);
  const businessInput = {
    actorId,
    sessionFamilyId: input.context.sessionFamilyId,
    roomId: input.command.roomId,
    uploadKey: input.command.uploadKey,
    originalFilename: input.command.originalFilename,
    declaredMime: input.command.declaredMime,
    expectedBytes: input.command.expectedBytes,
    expectedSha256: input.command.expectedSha256,
    format,
  };
  return executeIdempotently(database, {
    scope: `${actorId}:attachment.upload.begin:${input.command.roomId}`,
    key: input.command.uploadKey,
    businessInput,
    clock: input.clock,
    receiptKeys: ["uploadId", "acknowledgedBytes", "expectedBytes", "status"],
    execute(occurredAt) {
      const active = database.prepare(`
        SELECT
          COUNT(*) FILTER (
            WHERE uploader_actor_id = ? AND room_id = ?
          ) AS principalRoomCount,
          COUNT(*) AS globalCount
        FROM attachment_uploads
        WHERE status IN ('open', 'finalizing')
      `).get(actorId, input.command.roomId);
      if (typeof active?.principalRoomCount !== "number" ||
          typeof active.globalCount !== "number") {
        return fail(503, "storage_unavailable");
      }
      if (active.principalRoomCount >= 4 || active.globalCount >= 32) return failCapacity();
      const uploadId = input.ids.nextUploadId();
      if (!identifier(uploadId, 128)) throw new TypeError("Attachment upload ID factory is invalid");
      database.prepare(`
        INSERT INTO attachment_uploads (
          upload_id, upload_key, canonical_input_sha256, room_id, uploader_actor_id,
          session_family_id, access_revision, lifecycle_generation, expected_bytes,
          received_bytes, expected_sha256, original_filename, declared_mime, format_hint,
          status, terminal_reason_code, created_at, updated_at, idle_expires_at,
          absolute_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?)
      `).run(
        uploadId,
        input.command.uploadKey,
        sha256(businessInput),
        input.command.roomId,
        actorId,
        input.context.sessionFamilyId,
        room.accessRevision,
        room.lifecycleGeneration,
        input.command.expectedBytes,
        input.command.expectedSha256,
        input.command.originalFilename,
        input.command.declaredMime,
        format,
        occurredAt,
        occurredAt,
        new Date(Date.parse(occurredAt) + 30 * 60 * 1_000).toISOString(),
        new Date(Date.parse(occurredAt) + 24 * 60 * 60 * 1_000).toISOString(),
      );
      return {
        uploadId,
        acknowledgedBytes: 0,
        expectedBytes: input.command.expectedBytes,
        status: "open",
      } as const;
    },
  }) as AttachmentUploadBeginReceipt;
}

interface UploadRow extends Row {
  readonly uploadId: string;
  readonly uploadKey: string;
  readonly roomId: string;
  readonly uploaderActorId: string;
  readonly sessionFamilyId: string;
  readonly accessRevision: number;
  readonly lifecycleGeneration: number;
  readonly expectedBytes: number;
  readonly receivedBytes: number;
  readonly expectedSha256: string;
  readonly originalFilename: string;
  readonly declaredMime: string | null;
  readonly formatHint: AttachmentFormat;
  readonly status: string;
}

function readUpload(database: DatabaseSync, uploadId: string): UploadRow | undefined {
  return database.prepare(`
    SELECT upload_id AS uploadId, upload_key AS uploadKey, room_id AS roomId,
           uploader_actor_id AS uploaderActorId, session_family_id AS sessionFamilyId,
           access_revision AS accessRevision,
           lifecycle_generation AS lifecycleGeneration,
           expected_bytes AS expectedBytes, received_bytes AS receivedBytes,
           expected_sha256 AS expectedSha256, original_filename AS originalFilename,
           declared_mime AS declaredMime, format_hint AS formatHint, status
    FROM attachment_uploads WHERE upload_id = ?
  `).get(uploadId) as UploadRow | undefined;
}

function requireUploadAuthority(
  database: DatabaseSync,
  context: AttachmentHumanContext,
  clock: AttachmentAuthorityClock,
  uploadId: string,
): UploadRow {
  if (!identifier(uploadId, 128)) return fail(400, "invalid_request");
  const actorId = requireHumanSession(database, context, clock);
  const upload = readUpload(database, uploadId);
  if (upload === undefined) return fail(410, "upload_expired");
  if (upload.uploaderActorId !== actorId || upload.sessionFamilyId !== context.sessionFamilyId) {
    return fail(403, "attachment_forbidden");
  }
  const room = requireActiveRoomAuthority(database, upload.roomId, actorId);
  if (room.lifecycleGeneration !== upload.lifecycleGeneration ||
      room.accessRevision !== upload.accessRevision) {
    return fail(403, "attachment_forbidden");
  }
  return upload;
}

export function recordAttachmentChunkInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentHumanContext;
    command: import("./database-contracts.js").AttachmentChunkCheckpointCommand;
    clock: AttachmentAuthorityClock;
  }>,
): AttachmentChunkCheckpointReceipt {
  const command = input.command;
  if (!isRecord(command) || !exact(command, [
    "requestId", "uploadId", "ordinal", "offset", "byteLength", "chunkSha256",
    "partObjectKey",
  ]) || !identifier(command.requestId, 128) || !identifier(command.uploadId, 128) ||
      !nonnegativeInteger(command.ordinal) || command.ordinal >= 1_600 ||
      !nonnegativeInteger(command.offset) || !positiveInteger(command.byteLength) ||
      command.byteLength > ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes ||
      !isAttachmentSha256(command.chunkSha256) || !opaqueKey(command.partObjectKey)) {
    return fail(400, "invalid_chunk");
  }
  const upload = requireUploadAuthority(database, input.context, input.clock, command.uploadId);
  return executeIdempotently(database, {
    scope: `${upload.uploaderActorId}:attachment.upload.chunk:${upload.uploadId}`,
    key: String(command.ordinal),
    businessInput: {
      uploadId: command.uploadId,
      ordinal: command.ordinal,
      offset: command.offset,
      byteLength: command.byteLength,
      chunkSha256: command.chunkSha256,
      partObjectKey: command.partObjectKey,
    },
    conflictCode: "upload_offset_conflict",
    clock: input.clock,
    receiptKeys: ["uploadId", "ordinal", "acknowledgedBytes", "expectedBytes"],
    execute(occurredAt) {
      if (upload.status !== "open" || command.offset !== upload.receivedBytes ||
          command.offset + command.byteLength > upload.expectedBytes) {
        return fail(409, "upload_offset_conflict");
      }
      database.prepare(`
        INSERT INTO attachment_upload_chunks (
          upload_id, ordinal, byte_offset, byte_length, chunk_sha256,
          part_object_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.uploadId,
        command.ordinal,
        command.offset,
        command.byteLength,
        command.chunkSha256,
        command.partObjectKey,
        occurredAt,
      );
      return {
        uploadId: command.uploadId,
        ordinal: command.ordinal,
        acknowledgedBytes: command.offset + command.byteLength,
        expectedBytes: upload.expectedBytes,
      };
    },
  }) as AttachmentChunkCheckpointReceipt;
}

interface AttachmentRow extends Row {
  readonly attachmentId: string;
  readonly sourceUploadId: string;
  readonly roomId: string;
  readonly uploaderActorId: string;
  readonly originalFilename: string;
  readonly declaredMime: string | null;
  readonly detectedMime: string;
  readonly format: AttachmentFormat;
  readonly byteSize: number;
  readonly sha256: string;
  readonly quarantineObjectKey: string;
  readonly objectKey: string | null;
  readonly processingStatus: string;
  readonly generation: number;
  readonly failureCode: string | null;
  readonly sourceMessageId: string | null;
  readonly sourceState: "unbound" | "bound-active" | "excluded-recalled";
  readonly lifecycleGeneration: number;
  readonly accessRevision: number;
  readonly createdAt: string;
  readonly readyAt: string | null;
}

function readAttachment(database: DatabaseSync, attachmentId: string): AttachmentRow | undefined {
  return database.prepare(`
    SELECT attachment_id AS attachmentId, source_upload_id AS sourceUploadId,
           room_id AS roomId, uploader_actor_id AS uploaderActorId,
           original_filename AS originalFilename, declared_mime AS declaredMime,
           detected_mime AS detectedMime, format, byte_size AS byteSize, sha256,
           quarantine_object_key AS quarantineObjectKey, object_key AS objectKey,
           processing_status AS processingStatus,
           processing_generation AS generation, failure_code AS failureCode,
           source_message_id AS sourceMessageId,
           source_operational_state AS sourceState,
           lifecycle_generation AS lifecycleGeneration,
           access_revision AS accessRevision, created_at AS createdAt,
           ready_at AS readyAt
    FROM attachments WHERE attachment_id = ?
  `).get(attachmentId) as AttachmentRow | undefined;
}

function appendEvent(
  database: DatabaseSync,
  input: Readonly<{
    streamKind: "identity" | "room";
    streamId: string;
    roomId: string | null;
    actorId: string;
    eventType: "attachment.private.status-changed" | "room.attachment.bound";
    occurredAt: string;
    payload: unknown;
    targetKind: "principal" | "room";
    ids: AttachmentAuthorityIdFactory;
    aggregateId: string;
  }>,
): string {
  const stream = database.prepare(`
    SELECT head_seq AS headSeq FROM streams WHERE stream_kind = ? AND stream_id = ?
  `).get(input.streamKind, input.streamId);
  if (typeof stream?.headSeq !== "number") return fail(503, "storage_unavailable");
  const streamSeq = stream.headSeq + 1;
  const eventId = input.ids.nextEventId(
    input.streamKind === "identity" ? "private-status" : "room-bound",
    input.aggregateId,
  );
  const outboxId = input.ids.nextOutboxId(eventId, input.targetKind, input.streamId);
  if (!identifier(eventId) || !identifier(outboxId)) {
    throw new TypeError("Attachment event ID factory is invalid");
  }
  database.prepare(`
    UPDATE streams SET head_seq = ? WHERE stream_kind = ? AND stream_id = ?
  `).run(streamSeq, input.streamKind, input.streamId);
  database.prepare(`
    INSERT INTO events (
      event_id, stream_kind, stream_id, stream_seq, room_id,
      actor_id, event_type, occurred_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    input.streamKind,
    input.streamId,
    streamSeq,
    input.roomId,
    input.actorId,
    input.eventType,
    input.occurredAt,
    canonicalJson(input.payload),
  );
  database.prepare(`
    INSERT INTO outbox_deliveries (
      id, event_id, target_kind, target_id, stream_seq, status,
      attempts, available_at, delivered_at, last_error
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL)
  `).run(
    outboxId,
    eventId,
    input.targetKind,
    input.streamId,
    streamSeq,
    input.occurredAt,
  );
  return eventId;
}

function extractionMethodForSchema(method: AttachmentExtractionMethod): "extracted-text" | "ocr-text" | "table-text" {
  if (method === "ocr") return "ocr-text";
  if (method === "csv-text" || method === "office-xml") return "table-text";
  return "extracted-text";
}

function coreExtractionMethod(
  schemaMethod: string,
  format: AttachmentFormat,
): AttachmentExtractionMethod | undefined {
  if (schemaMethod === "ocr-text") return "ocr";
  if (schemaMethod === "table-text") {
    if (format === "csv") return "csv-text";
    if (format === "xlsx") return "office-xml";
  }
  if (schemaMethod === "extracted-text") {
    if (format === "txt" || format === "csv") return "plain-text";
    if (format === "docx" || format === "xlsx") return "office-xml";
    if (format === "pdf") return "pdf-text";
  }
  return undefined;
}

function readReadyProvenance(
  database: DatabaseSync,
  attachment: AttachmentRow,
): AttachmentReadyProvenance | null {
  const scanner = database.prepare(`
    SELECT adapter_version AS version
    FROM attachment_processing_attempts
    WHERE attachment_id = ? AND processing_generation = ?
      AND adapter_kind = 'scanner' AND status = 'succeeded'
    ORDER BY attempt_number DESC LIMIT 1
  `).get(attachment.attachmentId, attachment.generation);
  const artifact = database.prepare(`
    SELECT method, tool_name AS tool, tool_version AS version,
           sha256, byte_size AS byteSize, page_end AS pageCount
    FROM attachment_extraction_artifacts
    WHERE attachment_id = ? AND processing_generation = ?
    ORDER BY artifact_id LIMIT 1
  `).get(attachment.attachmentId, attachment.generation);
  if (typeof scanner?.version !== "string" || artifact === undefined ||
      typeof artifact.method !== "string" || typeof artifact.tool !== "string" ||
      typeof artifact.version !== "string" || typeof artifact.sha256 !== "string" ||
      typeof artifact.byteSize !== "number") {
    return null;
  }
  const method = coreExtractionMethod(artifact.method, attachment.format);
  const tools = new Set<AttachmentExtractionTool>([
    "builtin", "bounded-zip", "pdftotext", "tesseract",
  ]);
  if (method === undefined || !tools.has(artifact.tool as AttachmentExtractionTool)) return null;
  const pageCount = typeof artifact.pageCount === "number" ? artifact.pageCount : null;
  const extraction = {
    method,
    tool: artifact.tool as AttachmentExtractionTool,
    version: artifact.version,
    artifactSha256: artifact.sha256,
    artifactByteSize: artifact.byteSize,
    pageCount,
  } as const;
  if (method === "ocr") {
    if (pageCount === null || pageCount < 1) return null;
    return {
      scanner: { kind: "clamav", version: scanner.version },
      extraction,
      ocr: { kind: "tesseract", version: artifact.version, pageCount },
    };
  }
  return {
    scanner: { kind: "clamav", version: scanner.version },
    extraction,
    ocr: null,
  };
}

function metadataFromRow(
  database: DatabaseSync,
  attachment: AttachmentRow,
): AttachmentMetadata {
  let processingStatus: AttachmentMetadata["processingStatus"];
  if (attachment.processingStatus === "quarantined") processingStatus = "accepted-quarantined";
  else if (["scanning", "extracting", "ocr"].includes(attachment.processingStatus)) {
    processingStatus = "processing";
  } else if ([
    "ready", "retryable-failed", "nonretryable-failed", "malware-rejected", "cancelled",
  ].includes(attachment.processingStatus)) {
    processingStatus = attachment.processingStatus as AttachmentMetadata["processingStatus"];
  } else {
    return fail(503, "storage_unavailable");
  }
  const provenance = processingStatus === "ready"
    ? readReadyProvenance(database, attachment)
    : null;
  const metadata: AttachmentMetadata = {
    attachmentId: attachment.attachmentId,
    roomId: attachment.roomId,
    originalFilename: attachment.originalFilename,
    format: attachment.format,
    declaredMime: attachment.declaredMime as AttachmentMetadata["declaredMime"],
    detectedMime: attachment.detectedMime as AttachmentMetadata["detectedMime"],
    byteSize: attachment.byteSize,
    sha256: attachment.sha256,
    uploaderActorId: attachment.uploaderActorId,
    createdAt: attachment.createdAt,
    readyAt: attachment.readyAt,
    processingStatus,
    generation: attachment.generation,
    sourceMessageId: attachment.sourceMessageId,
    provenance,
  };
  if (!isAttachmentMetadata(metadata)) return fail(503, "storage_unavailable");
  return Object.freeze(metadata);
}

function appendPrivateStatusEvent(
  database: DatabaseSync,
  attachment: AttachmentRow,
  occurredAt: string,
  ids: AttachmentAuthorityIdFactory,
): string {
  if (attachment.sourceState !== "unbound" || attachment.sourceMessageId !== null) {
    return fail(503, "storage_unavailable");
  }
  return appendEvent(database, {
    streamKind: "identity",
    streamId: attachment.uploaderActorId,
    roomId: null,
    actorId: attachment.uploaderActorId,
    eventType: "attachment.private.status-changed",
    occurredAt,
    payload: { attachment: metadataFromRow(database, attachment) },
    targetKind: "principal",
    ids,
    aggregateId: attachment.attachmentId,
  });
}

export function readAttachmentUploadAssemblyPlanDatabaseQuery(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentHumanContext;
    uploadId: string;
    clock: AttachmentAuthorityClock;
    ids: AttachmentAuthorityIdFactory;
  }>,
): AttachmentUploadAssemblyPlan {
  if (!identifier(input.uploadId, 128)) return fail(400, "invalid_request");
  const actorId = requireHumanSession(database, input.context, input.clock);
  const row = database.prepare(`
    SELECT upload.upload_id AS uploadId, upload.room_id AS roomId,
           upload.uploader_actor_id AS uploaderActorId,
           upload.session_family_id AS sessionFamilyId, upload.status,
           upload.expected_bytes AS expectedBytes,
           upload.received_bytes AS receivedBytes,
           upload.expected_sha256 AS expectedSha256,
           upload.format_hint AS format,
           upload.lifecycle_generation AS lifecycleGeneration,
           upload.access_revision AS accessRevision,
           (SELECT COUNT(*) FROM attachment_upload_chunks AS chunk
            WHERE chunk.upload_id = upload.upload_id) AS chunkCount
    FROM attachment_uploads AS upload WHERE upload.upload_id = ?
  `).get(input.uploadId);
  if (row === undefined || row.uploaderActorId !== actorId ||
      row.sessionFamilyId !== input.context.sessionFamilyId || !identifier(row.roomId)) {
    return fail(410, "upload_expired");
  }
  const room = requireActiveRoomAuthority(database, row.roomId, actorId);
  if (room.lifecycleGeneration !== row.lifecycleGeneration ||
      room.accessRevision !== row.accessRevision) {
    return fail(403, "attachment_forbidden");
  }
  if ((row.status !== "open" && row.status !== "accepted") ||
      !positiveInteger(row.expectedBytes) || row.receivedBytes !== row.expectedBytes ||
      !isAttachmentSha256(row.expectedSha256) || !isAttachmentFormat(row.format) ||
      !positiveInteger(row.chunkCount)) {
    return fail(409, "upload_offset_conflict");
  }
  const attachmentId = input.ids.attachmentIdForUpload(input.uploadId);
  if (!identifier(attachmentId, 128)) {
    throw new TypeError("Attachment ID factory is invalid");
  }
  return Object.freeze({
    uploadId: input.uploadId,
    attachmentId,
    chunkCount: row.chunkCount,
    expectedBytes: row.expectedBytes,
    expectedSha256: row.expectedSha256,
    format: row.format,
  });
}

export function finalizeAttachmentUploadInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentHumanContext;
    command: import("./database-contracts.js").AttachmentUploadFinalizeCommand;
    clock: AttachmentAuthorityClock;
    ids: AttachmentAuthorityIdFactory;
  }>,
): AttachmentUploadFinalizeReceipt {
  const command = input.command;
  if (!isRecord(command) || !exact(command, ["requestId", "uploadId", "storage"]) ||
      !identifier(command.requestId, 128) || !identifier(command.uploadId, 128) ||
      !isRecord(command.storage) || !exact(command.storage, [
        "quarantineObjectKey", "byteSize", "sha256", "format", "detectedMime",
      ]) || !opaqueKey(command.storage.quarantineObjectKey) ||
      !positiveInteger(command.storage.byteSize) || !isAttachmentSha256(command.storage.sha256) ||
      !isAttachmentFormat(command.storage.format) ||
      command.storage.detectedMime !== attachmentDetectedMime(command.storage.format)) {
    return fail(400, "invalid_request");
  }
  const upload = requireUploadAuthority(database, input.context, input.clock, command.uploadId);
  return executeIdempotently(database, {
    scope: `${upload.uploaderActorId}:attachment.upload.finalize:${upload.uploadId}`,
    key: upload.uploadId,
    businessInput: {
      uploadId: command.uploadId,
      storage: command.storage,
    },
    clock: input.clock,
    receiptKeys: [
      "uploadId", "attachmentId", "status", "generation", "privateEventId",
    ],
    execute(occurredAt) {
      if (upload.status !== "open" && upload.status !== "finalizing") {
        return fail(409, "idempotency_conflict");
      }
      if (upload.receivedBytes !== upload.expectedBytes ||
          command.storage.byteSize !== upload.expectedBytes ||
          command.storage.sha256 !== upload.expectedSha256) {
        return fail(422, "attachment_malformed");
      }
      if (command.storage.format !== upload.formatHint ||
          command.storage.detectedMime !== attachmentDetectedMime(upload.formatHint)) {
        return fail(415, "type_mismatch");
      }
      if (upload.status === "open") {
        const transitioned = database.prepare(`
          UPDATE attachment_uploads SET status = 'finalizing', updated_at = ?
          WHERE upload_id = ? AND status = 'open'
        `).run(occurredAt, upload.uploadId);
        if (transitioned.changes !== 1) return fail(409, "idempotency_conflict");
      }
      const attachmentId = input.ids.attachmentIdForUpload(upload.uploadId);
      if (!identifier(attachmentId, 128)) {
        throw new TypeError("Attachment artifact ID factory is invalid");
      }
      database.prepare(`
        INSERT INTO attachments (
          attachment_id, source_upload_id, room_id, uploader_actor_id,
          original_filename, declared_mime, detected_mime, format, byte_size, sha256,
          quarantine_object_key, object_key, processing_status, processing_generation,
          failure_code, source_message_id, source_operational_state, source_bound_at,
          lifecycle_generation, access_revision, created_at, updated_at, ready_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'quarantined', 1,
          NULL, NULL, 'unbound', NULL, ?, ?, ?, ?, NULL
        )
      `).run(
        attachmentId,
        upload.uploadId,
        upload.roomId,
        upload.uploaderActorId,
        upload.originalFilename,
        upload.declaredMime,
        command.storage.detectedMime,
        command.storage.format,
        command.storage.byteSize,
        command.storage.sha256,
        command.storage.quarantineObjectKey,
        upload.lifecycleGeneration,
        upload.accessRevision,
        occurredAt,
        occurredAt,
      );
      database.prepare(`
        UPDATE attachment_uploads SET status = 'accepted', updated_at = ?
        WHERE upload_id = ? AND status = 'finalizing'
      `).run(occurredAt, upload.uploadId);
      const attachment = readAttachment(database, attachmentId);
      if (attachment === undefined) return fail(503, "storage_unavailable");
      const privateEventId = appendPrivateStatusEvent(database, attachment, occurredAt, input.ids);
      return {
        uploadId: upload.uploadId,
        attachmentId,
        status: "accepted-quarantined",
        generation: 1,
        privateEventId,
      } as const;
    },
  }) as AttachmentUploadFinalizeReceipt;
}

function requireAttachmentHumanAuthority(
  database: DatabaseSync,
  context: AttachmentHumanContext,
  clock: AttachmentAuthorityClock,
  attachmentId: string,
): Readonly<{ actorId: string; attachment: AttachmentRow; room: RoomAuthority }> {
  if (!identifier(attachmentId, 128)) return fail(400, "invalid_request");
  const actorId = requireHumanSession(database, context, clock);
  const attachment = readAttachment(database, attachmentId);
  if (attachment === undefined) return fail(410, "attachment_gone");
  if (attachment.uploaderActorId !== actorId) return fail(403, "attachment_forbidden");
  const room = requireActiveRoomAuthority(database, attachment.roomId, actorId);
  if (room.lifecycleGeneration !== attachment.lifecycleGeneration ||
      room.accessRevision !== attachment.accessRevision) {
    return fail(403, "attachment_forbidden");
  }
  return { actorId, attachment, room };
}

export function cancelAttachmentUploadInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentHumanContext;
    command: import("./database-contracts.js").AttachmentUploadCancelCommand;
    clock: AttachmentAuthorityClock;
    ids: AttachmentAuthorityIdFactory;
  }>,
): AttachmentUploadCancelReceipt {
  const command = input.command;
  if (!isRecord(command) || !exact(command, ["requestId", "uploadId"]) ||
      !identifier(command.requestId, 128) || !identifier(command.uploadId, 128)) {
    return fail(400, "invalid_request");
  }
  const upload = requireUploadAuthority(database, input.context, input.clock, command.uploadId);
  return executeIdempotently(database, {
    scope: `${upload.uploaderActorId}:attachment.upload.cancel:${upload.uploadId}`,
    key: upload.uploadId,
    businessInput: { uploadId: upload.uploadId },
    clock: input.clock,
    receiptKeys: ["uploadId", "attachmentId"],
    execute(occurredAt) {
      if (upload.status === "open" || upload.status === "finalizing") {
        database.prepare(`
          UPDATE attachment_uploads
          SET status = 'cancelled', terminal_reason_code = 'upload_cancelled', updated_at = ?
          WHERE upload_id = ? AND status = ?
        `).run(occurredAt, upload.uploadId, upload.status);
        return { uploadId: upload.uploadId, attachmentId: null };
      }
      if (upload.status !== "accepted") return fail(409, "generation_conflict");
      const attachment = database.prepare(`
        SELECT attachment_id AS attachmentId FROM attachments WHERE source_upload_id = ?
      `).get(upload.uploadId);
      if (typeof attachment?.attachmentId !== "string") return fail(503, "storage_unavailable");
      const current = readAttachment(database, attachment.attachmentId);
      if (current === undefined || current.sourceState !== "unbound" ||
          !["quarantined", "scanning", "extracting", "ocr"].includes(current.processingStatus)) {
        return fail(409, "generation_conflict");
      }
      database.prepare(`
        UPDATE attachment_processing_attempts
        SET status = 'cancelled', failure_code = 'cancelled', finished_at = ?
        WHERE attachment_id = ? AND processing_generation = ?
          AND status IN ('queued', 'running')
      `).run(occurredAt, current.attachmentId, current.generation);
      database.prepare(`
        UPDATE attachments SET processing_status = 'cancelled',
          processing_generation = processing_generation + 1,
          failure_code = 'cancelled', updated_at = ?
        WHERE attachment_id = ? AND processing_generation = ?
      `).run(occurredAt, current.attachmentId, current.generation);
      const cancelled = readAttachment(database, current.attachmentId);
      if (cancelled === undefined) return fail(503, "storage_unavailable");
      appendPrivateStatusEvent(database, cancelled, occurredAt, input.ids);
      return { uploadId: upload.uploadId, attachmentId: current.attachmentId };
    },
  }) as AttachmentUploadCancelReceipt;
}

export function retryAttachmentProcessingInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentHumanContext;
    command: import("./database-contracts.js").AttachmentProcessingRetryCommand;
    clock: AttachmentAuthorityClock;
    ids: AttachmentAuthorityIdFactory;
  }>,
): AttachmentProcessingRetryReceipt {
  const command = input.command;
  if (!isRecord(command) || !exact(command, [
    "requestId", "attachmentId", "expectedGeneration",
  ]) || !identifier(command.requestId, 128) || !identifier(command.attachmentId, 128) ||
      !positiveInteger(command.expectedGeneration)) return fail(400, "invalid_request");
  const authority = requireAttachmentHumanAuthority(
    database, input.context, input.clock, command.attachmentId,
  );
  return executeIdempotently(database, {
    scope: `${authority.actorId}:attachment.processing.retry:${command.attachmentId}`,
    key: `${command.attachmentId}:${command.expectedGeneration}`,
    businessInput: {
      attachmentId: command.attachmentId,
      expectedGeneration: command.expectedGeneration,
    },
    clock: input.clock,
    receiptKeys: ["attachmentId", "generation"],
    execute(occurredAt) {
      const current = readAttachment(database, command.attachmentId);
      if (current === undefined || current.generation !== command.expectedGeneration ||
          current.processingStatus !== "retryable-failed" || current.sourceState !== "unbound") {
        return fail(409, "generation_conflict");
      }
      database.prepare(`
        UPDATE attachments SET processing_status = 'quarantined',
          processing_generation = processing_generation + 1,
          failure_code = NULL, updated_at = ?
        WHERE attachment_id = ? AND processing_generation = ?
          AND processing_status = 'retryable-failed'
      `).run(occurredAt, command.attachmentId, command.expectedGeneration);
      const retried = readAttachment(database, command.attachmentId);
      if (retried === undefined) return fail(503, "storage_unavailable");
      appendPrivateStatusEvent(database, retried, occurredAt, input.ids);
      return { attachmentId: command.attachmentId, generation: retried.generation };
    },
  }) as AttachmentProcessingRetryReceipt;
}

function requireWorkerAttachmentAuthority(
  database: DatabaseSync,
  context: AttachmentWorkerContext,
  attachmentId: string,
  expectedGeneration: number,
): AttachmentRow {
  requireWorkerContext(context);
  if (!identifier(attachmentId, 128) || !positiveInteger(expectedGeneration)) {
    throw new TypeError("Attachment worker command is invalid");
  }
  const attachment = readAttachment(database, attachmentId);
  if (attachment === undefined) return fail(410, "attachment_gone");
  if (attachment.generation !== expectedGeneration) return fail(409, "generation_conflict");
  const authority = database.prepare(`
    SELECT room.status, room.archive_generation AS lifecycleGeneration,
           CASE
             WHEN access.access_revision IS NULL
               OR membership.access_revision > access.access_revision
             THEN membership.access_revision
             ELSE access.access_revision
           END AS accessRevision,
           family.revoked_at AS familyRevokedAt
    FROM attachments AS attachment
    JOIN attachment_uploads AS upload ON upload.upload_id = attachment.source_upload_id
    JOIN session_families AS family ON family.family_id = upload.session_family_id
    JOIN rooms AS room ON room.id = attachment.room_id
    JOIN room_memberships AS membership
      ON membership.room_id = attachment.room_id
     AND membership.actor_id = attachment.uploader_actor_id
     AND membership.kind = 'human'
    LEFT JOIN room_access_authority AS access ON access.room_id = room.id
    WHERE attachment.attachment_id = ?
  `).get(attachmentId);
  if (authority === undefined || authority.status !== "active" ||
      authority.familyRevokedAt !== null ||
      authority.lifecycleGeneration !== attachment.lifecycleGeneration ||
      authority.accessRevision !== attachment.accessRevision ||
      attachment.sourceState !== "unbound") {
    return fail(403, "attachment_forbidden");
  }
  return attachment;
}

export function readAttachmentProcessingPlanDatabaseQuery(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentWorkerContext;
    attachmentId: string;
    expectedGeneration: number;
  }>,
): AttachmentProcessingPlan {
  const attachment = requireWorkerAttachmentAuthority(
    database, input.context, input.attachmentId, input.expectedGeneration,
  );
  const stage = attachment.processingStatus === "quarantined"
    ? "accepted-quarantined"
    : attachment.processingStatus;
  if (!["accepted-quarantined", "scanning", "extracting", "ocr"].includes(stage) ||
      (attachment.declaredMime !== null &&
        attachment.declaredMime !== attachmentDetectedMime(attachment.format))) {
    return fail(409, "generation_conflict");
  }
  return Object.freeze({
    attachmentId: attachment.attachmentId,
    generation: attachment.generation,
    format: attachment.format,
    declaredMime: attachment.declaredMime as AttachmentProcessingPlan["declaredMime"],
    byteSize: attachment.byteSize,
    sha256: attachment.sha256,
    stage: stage as AttachmentProcessingPlan["stage"],
  });
}

export function listRecoverableAttachmentProcessingDatabaseQuery(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentWorkerContext;
    limit: number;
  }>,
): AttachmentProcessingRecoveryBatch {
  requireWorkerContext(input.context);
  if (!positiveInteger(input.limit) || input.limit > 64) {
    throw new TypeError("Attachment recovery limit is invalid");
  }
  const rows = database.prepare(`
    SELECT attachment_id AS attachmentId, processing_generation AS generation
    FROM attachments
    WHERE processing_status IN ('quarantined', 'scanning', 'extracting', 'ocr')
      AND source_operational_state = 'unbound' AND source_message_id IS NULL
    ORDER BY updated_at, attachment_id LIMIT ?
  `).all(input.limit);
  const candidates: AttachmentProcessingPlan[] = [];
  for (const row of rows) {
    if (!identifier(row.attachmentId, 128) || !positiveInteger(row.generation)) {
      return fail(503, "storage_unavailable");
    }
    try {
      candidates.push(readAttachmentProcessingPlanDatabaseQuery(database, {
        context: input.context,
        attachmentId: row.attachmentId,
        expectedGeneration: row.generation,
      }));
    } catch (error) {
      if (error instanceof AttachmentAuthorityDatabaseError &&
          (error.status === 403 || error.status === 409 || error.status === 410)) continue;
      throw error;
    }
  }
  return Object.freeze({ candidates: Object.freeze(candidates) });
}

export function readAttachmentObjectReferencesDatabaseQuery(
  database: DatabaseSync,
  input: Readonly<{ context: AttachmentWorkerContext }>,
): AttachmentObjectReferenceSnapshot {
  requireWorkerContext(input.context);
  const maximumReferences = 100_000;
  const read = (
    sql: string,
    field: string,
    validate: (value: unknown) => boolean,
  ): readonly string[] => {
    const rows = database.prepare(sql).all(maximumReferences + 1);
    if (rows.length > maximumReferences) return fail(503, "storage_unavailable");
    const values: string[] = [];
    for (const row of rows) {
      const value = row[field];
      if (!validate(value) || typeof value !== "string") {
        return fail(503, "storage_unavailable");
      }
      values.push(value);
    }
    return Object.freeze(values);
  };
  const referencedUploadIds = read(`
    SELECT upload_id AS uploadId FROM attachment_uploads
    WHERE status IN ('open', 'finalizing')
    ORDER BY upload_id LIMIT ?
  `, "uploadId", (value) => identifier(value, 128));
  const referencedQuarantineAttachmentIds = read(`
    SELECT attachment_id AS attachmentId FROM attachments
    WHERE processing_status IN (
      'quarantined', 'scanning', 'extracting', 'ocr', 'retryable-failed'
    )
    ORDER BY attachment_id LIMIT ?
  `, "attachmentId", (value) => identifier(value, 128));
  const referencedObjectKeys = read(`
    SELECT object_key AS objectKey FROM attachments WHERE object_key IS NOT NULL
    UNION
    SELECT object_key AS objectKey FROM attachment_extraction_artifacts
    ORDER BY objectKey LIMIT ?
  `, "objectKey", (value) => typeof value === "string" &&
    /^(?:object|extraction)_[0-9a-f]{64}$/u.test(value));
  return Object.freeze({
    referencedUploadIds,
    referencedQuarantineAttachmentIds,
    referencedObjectKeys,
  });
}

function validateAdapter(adapter: Row): void {
  if (!exact(adapter, [
    "kind", "name", "version", "timeoutMs", "stdoutLimitBytes", "stderrLimitBytes",
  ]) || !["scanner", "extractor", "ocr"].includes(String(adapter.kind)) ||
      !identifier(adapter.name, 128) || !identifier(adapter.version, 128) ||
      !positiveInteger(adapter.timeoutMs) || adapter.timeoutMs > 300_000 ||
      !nonnegativeInteger(adapter.stdoutLimitBytes) || adapter.stdoutLimitBytes > 8_388_608 ||
      !nonnegativeInteger(adapter.stderrLimitBytes) || adapter.stderrLimitBytes > 65_536) {
    throw new TypeError("Attachment processing adapter is invalid");
  }
}

export function claimAttachmentProcessingAttemptInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentWorkerContext;
    command: import("./database-contracts.js").AttachmentProcessingClaimCommand;
    clock: AttachmentAuthorityClock;
    ids: AttachmentAuthorityIdFactory;
  }>,
): AttachmentProcessingClaimReceipt {
  const command = input.command;
  if (!isRecord(command) || !exact(command, [
    "attachmentId", "expectedGeneration", "adapter",
  ]) || !identifier(command.attachmentId, 128) ||
      !positiveInteger(command.expectedGeneration) || !isRecord(command.adapter)) {
    throw new TypeError("Attachment processing claim is invalid");
  }
  validateAdapter(command.adapter);
  const attachment = requireWorkerAttachmentAuthority(
    database, input.context, command.attachmentId, command.expectedGeneration,
  );
  const existing = database.prepare(`
    SELECT attempt_number AS attemptNumber, adapter_name AS name,
           adapter_version AS version, timeout_ms AS timeoutMs,
           stdout_limit_bytes AS stdoutLimitBytes,
           stderr_limit_bytes AS stderrLimitBytes, status
    FROM attachment_processing_attempts
    WHERE attachment_id = ? AND processing_generation = ? AND adapter_kind = ?
    ORDER BY attempt_number DESC LIMIT 1
  `).get(command.attachmentId, command.expectedGeneration, command.adapter.kind);
  if (existing !== undefined) {
    if (existing.name !== command.adapter.name || existing.version !== command.adapter.version ||
        existing.timeoutMs !== command.adapter.timeoutMs ||
        existing.stdoutLimitBytes !== command.adapter.stdoutLimitBytes ||
        existing.stderrLimitBytes !== command.adapter.stderrLimitBytes ||
        (existing.status !== "queued" && existing.status !== "running")) {
      return fail(409, "generation_conflict");
    }
    return {
      attachmentId: command.attachmentId,
      generation: command.expectedGeneration,
      attemptNumber: existing.attemptNumber as number,
      adapterKind: command.adapter.kind,
      replayed: true,
    };
  }
  const stage = command.adapter.kind === "scanner"
    ? "scanning"
    : command.adapter.kind === "extractor" ? "extracting" : "ocr";
  const validCurrent = command.adapter.kind === "scanner"
    ? ["quarantined", "scanning"]
    : command.adapter.kind === "extractor"
      ? ["scanning", "extracting"]
      : ["scanning", "extracting", "ocr"];
  if (!validCurrent.includes(attachment.processingStatus)) return fail(409, "generation_conflict");
  const attemptNumber = Number(database.prepare(`
    SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attemptNumber
    FROM attachment_processing_attempts
    WHERE attachment_id = ? AND processing_generation = ?
  `).get(command.attachmentId, command.expectedGeneration)?.attemptNumber);
  if (!positiveInteger(attemptNumber)) return fail(503, "storage_unavailable");
  database.prepare(`
    INSERT INTO attachment_processing_attempts (
      attachment_id, processing_generation, attempt_number, adapter_kind,
      adapter_name, adapter_version, status, failure_code, timeout_ms,
      stdout_limit_bytes, stderr_limit_bytes, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?, NULL, NULL)
  `).run(
    command.attachmentId,
    command.expectedGeneration,
    attemptNumber,
    command.adapter.kind,
    command.adapter.name,
    command.adapter.version,
    command.adapter.timeoutMs,
    command.adapter.stdoutLimitBytes,
    command.adapter.stderrLimitBytes,
  );
  if (attachment.processingStatus !== stage) {
    const occurredAt = now(input.clock).iso;
    database.prepare(`
      UPDATE attachments SET processing_status = ?, updated_at = ?
      WHERE attachment_id = ? AND processing_generation = ?
    `).run(stage, occurredAt, command.attachmentId, command.expectedGeneration);
    const updated = readAttachment(database, command.attachmentId);
    if (updated === undefined) return fail(503, "storage_unavailable");
    appendPrivateStatusEvent(database, updated, occurredAt, input.ids);
  }
  return {
    attachmentId: command.attachmentId,
    generation: command.expectedGeneration,
    attemptNumber,
    adapterKind: command.adapter.kind,
    replayed: false,
  };
}

export function startAttachmentProcessingAttemptInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentWorkerContext;
    command: import("./database-contracts.js").AttachmentProcessingStartCommand;
    clock: AttachmentAuthorityClock;
  }>,
): Readonly<{
  attachmentId: string;
  generation: number;
  attemptNumber: number;
  status: "running";
  replayed: boolean;
}> {
  const command = input.command;
  if (!isRecord(command) || !exact(command, [
    "attachmentId", "expectedGeneration", "attemptNumber",
  ]) || !identifier(command.attachmentId, 128) || !positiveInteger(command.expectedGeneration) ||
      !positiveInteger(command.attemptNumber)) {
    throw new TypeError("Attachment processing start is invalid");
  }
  requireWorkerAttachmentAuthority(
    database, input.context, command.attachmentId, command.expectedGeneration,
  );
  const attempt = database.prepare(`
    SELECT status FROM attachment_processing_attempts
    WHERE attachment_id = ? AND processing_generation = ? AND attempt_number = ?
  `).get(command.attachmentId, command.expectedGeneration, command.attemptNumber);
  if (attempt?.status === "running") {
    return {
      attachmentId: command.attachmentId,
      generation: command.expectedGeneration,
      attemptNumber: command.attemptNumber,
      status: "running",
      replayed: true,
    };
  }
  if (attempt?.status !== "queued") return fail(409, "generation_conflict");
  database.prepare(`
    UPDATE attachment_processing_attempts SET status = 'running', started_at = ?
    WHERE attachment_id = ? AND processing_generation = ? AND attempt_number = ?
      AND status = 'queued'
  `).run(
    now(input.clock).iso,
    command.attachmentId,
    command.expectedGeneration,
    command.attemptNumber,
  );
  return {
    attachmentId: command.attachmentId,
    generation: command.expectedGeneration,
    attemptNumber: command.attemptNumber,
    status: "running",
    replayed: false,
  };
}

function validateExtraction(
  extraction: Row,
  adapterKind: string,
): void {
  if (!exact(extraction, [
    "method", "tool", "version", "objectKey", "sha256", "byteSize", "pageCount",
  ]) || !["plain-text", "csv-text", "office-xml", "pdf-text", "ocr"].includes(
    String(extraction.method),
  ) || !["builtin", "bounded-zip", "pdftotext", "tesseract"].includes(
    String(extraction.tool),
  ) || !identifier(extraction.version, 128) || !opaqueKey(extraction.objectKey) ||
      !isAttachmentSha256(extraction.sha256) || !nonnegativeInteger(extraction.byteSize) ||
      extraction.byteSize > ATTACHMENT_AUTHORITY_LIMITS.maxExtractionArtifactBytes ||
      !(extraction.pageCount === null || (positiveInteger(extraction.pageCount) &&
        extraction.pageCount <= ATTACHMENT_AUTHORITY_LIMITS.maxPageCount)) ||
      (adapterKind === "ocr" &&
        (extraction.method !== "ocr" || extraction.tool !== "tesseract" ||
          extraction.pageCount === null)) ||
      (adapterKind === "extractor" && extraction.method === "ocr")) {
    throw new TypeError("Attachment extraction metadata is invalid");
  }
}

function storedExtractionMatches(
  database: DatabaseSync,
  attachmentId: string,
  generation: number,
  extraction: Row,
): boolean {
  const artifact = database.prepare(`
    SELECT method, tool_name AS tool, tool_version AS version,
           object_key AS objectKey, sha256, byte_size AS byteSize,
           page_start AS pageStart, page_end AS pageCount
    FROM attachment_extraction_artifacts
    WHERE attachment_id = ? AND processing_generation = ?
    ORDER BY artifact_id DESC LIMIT 1
  `).get(attachmentId, generation);
  return artifact !== undefined &&
    artifact.method === extractionMethodForSchema(
      extraction.method as AttachmentExtractionMethod,
    ) && artifact.tool === extraction.tool && artifact.version === extraction.version &&
    artifact.objectKey === extraction.objectKey && artifact.sha256 === extraction.sha256 &&
    artifact.byteSize === extraction.byteSize && artifact.pageCount === extraction.pageCount &&
    artifact.pageStart === (extraction.pageCount === null ? null : 1);
}

export function completeAttachmentProcessingAttemptInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentWorkerContext;
    command: import("./database-contracts.js").AttachmentProcessingCompleteCommand;
    clock: AttachmentAuthorityClock;
    ids: AttachmentAuthorityIdFactory;
  }>,
): AttachmentProcessingCompleteReceipt {
  const command = input.command;
  if (!isRecord(command) || !exact(command, [
    "attachmentId", "expectedGeneration", "attemptNumber", "result",
  ]) || !identifier(command.attachmentId, 128) || !positiveInteger(command.expectedGeneration) ||
      !positiveInteger(command.attemptNumber) || !isRecord(command.result) ||
      typeof command.result.status !== "string") {
    throw new TypeError("Attachment processing completion is invalid");
  }
  requireWorkerAttachmentAuthority(
    database, input.context, command.attachmentId, command.expectedGeneration,
  );
  const attempt = database.prepare(`
    SELECT adapter_kind AS adapterKind, status, failure_code AS failureCode
    FROM attachment_processing_attempts
    WHERE attachment_id = ? AND processing_generation = ? AND attempt_number = ?
  `).get(command.attachmentId, command.expectedGeneration, command.attemptNumber);
  if (attempt === undefined || typeof attempt.adapterKind !== "string") {
    return fail(409, "generation_conflict");
  }
  if (command.result.status === "succeeded") {
    if (attempt.adapterKind === "scanner") {
      if (Object.hasOwn(command.result, "extraction")) {
        throw new TypeError("Scanner success cannot contain extraction metadata");
      }
    } else {
      if (!isRecord(command.result.extraction)) {
        throw new TypeError("Extraction success requires provenance metadata");
      }
      validateExtraction(command.result.extraction, attempt.adapterKind);
    }
    if (attempt.status !== "running") {
      const exactReplay = attempt.status === "succeeded" &&
        (attempt.adapterKind === "scanner" || storedExtractionMatches(
          database,
          command.attachmentId,
          command.expectedGeneration,
          command.result.extraction as unknown as Row,
        ));
      if (!exactReplay) return fail(409, "generation_conflict");
      return {
        attachmentId: command.attachmentId,
        generation: command.expectedGeneration,
        attemptNumber: command.attemptNumber,
        status: "succeeded",
        privateEventId: null,
        replayed: true,
      };
    }
    const occurredAt = now(input.clock).iso;
    database.prepare(`
      UPDATE attachment_processing_attempts
      SET status = 'succeeded', finished_at = ?
      WHERE attachment_id = ? AND processing_generation = ? AND attempt_number = ?
        AND status = 'running'
    `).run(
      occurredAt,
      command.attachmentId,
      command.expectedGeneration,
      command.attemptNumber,
    );
    if (attempt.adapterKind !== "scanner") {
      const extraction = command.result.extraction;
      if (extraction === undefined) throw new TypeError("Extraction metadata is missing");
      const artifactId = input.ids.nextExtractionArtifactId(
        command.attachmentId, command.expectedGeneration,
      );
      if (!identifier(artifactId, 128)) {
        throw new TypeError("Attachment extraction ID factory is invalid");
      }
      const pageStart = extraction.pageCount === null ? null : 1;
      database.prepare(`
        INSERT INTO attachment_extraction_artifacts (
          artifact_id, attachment_id, processing_generation, method, tool_name,
          tool_version, object_key, sha256, byte_size, page_start, page_end,
          range_start, range_end, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        artifactId,
        command.attachmentId,
        command.expectedGeneration,
        extractionMethodForSchema(extraction.method),
        extraction.tool,
        extraction.version,
        extraction.objectKey,
        extraction.sha256,
        extraction.byteSize,
        pageStart,
        extraction.pageCount,
        occurredAt,
      );
    }
    return {
      attachmentId: command.attachmentId,
      generation: command.expectedGeneration,
      attemptNumber: command.attemptNumber,
      status: "succeeded",
      privateEventId: null,
      replayed: false,
    };
  }
  if (!exact(command.result, ["status", "failureCode"]) ||
      !identifier(command.result.failureCode, 128) ||
      !["retryable-failed", "nonretryable-failed", "malware-rejected", "cancelled"].includes(
        command.result.status,
      ) || (command.result.status === "malware-rejected" &&
        (attempt.adapterKind !== "scanner" || command.result.failureCode !== "malware_detected")) ||
      (command.result.status === "cancelled" && command.result.failureCode !== "cancelled")) {
    throw new TypeError("Attachment processing failure result is invalid");
  }
  if (attempt.status !== "running") {
    if (attempt.status !== command.result.status ||
        attempt.failureCode !== command.result.failureCode) {
      return fail(409, "generation_conflict");
    }
    const privateEventId = latestPrivateEventId(database, command.attachmentId);
    if (privateEventId === undefined) return fail(503, "storage_unavailable");
    return {
      attachmentId: command.attachmentId,
      generation: command.expectedGeneration,
      attemptNumber: command.attemptNumber,
      status: command.result.status,
      privateEventId,
      replayed: true,
    };
  }
  const occurredAt = now(input.clock).iso;
  database.prepare(`
    UPDATE attachment_processing_attempts
    SET status = ?, failure_code = ?, finished_at = ?
    WHERE attachment_id = ? AND processing_generation = ? AND attempt_number = ?
      AND status = 'running'
  `).run(
    command.result.status,
    command.result.failureCode,
    occurredAt,
    command.attachmentId,
    command.expectedGeneration,
    command.attemptNumber,
  );
  const nextGeneration = command.result.status === "cancelled"
    ? command.expectedGeneration + 1
    : command.expectedGeneration;
  database.prepare(`
    UPDATE attachments SET processing_status = ?, processing_generation = ?,
      failure_code = ?, updated_at = ?
    WHERE attachment_id = ? AND processing_generation = ?
  `).run(
    command.result.status,
    nextGeneration,
    command.result.failureCode,
    occurredAt,
    command.attachmentId,
    command.expectedGeneration,
  );
  const updated = readAttachment(database, command.attachmentId);
  if (updated === undefined) return fail(503, "storage_unavailable");
  const privateEventId = appendPrivateStatusEvent(database, updated, occurredAt, input.ids);
  return {
    attachmentId: command.attachmentId,
    generation: updated.generation,
    attemptNumber: command.attemptNumber,
    status: command.result.status,
    privateEventId,
    replayed: false,
  };
}

function latestPrivateEventId(
  database: DatabaseSync,
  attachmentId: string,
): string | undefined {
  const row = database.prepare(`
    SELECT event_id AS eventId FROM events
    WHERE stream_kind = 'identity'
      AND event_type = 'attachment.private.status-changed'
      AND json_extract(payload_json, '$.attachment.attachmentId') = ?
    ORDER BY stream_seq DESC LIMIT 1
  `).get(attachmentId);
  return typeof row?.eventId === "string" ? row.eventId : undefined;
}

export function markAttachmentReadyInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentWorkerContext;
    command: import("./database-contracts.js").AttachmentReadyCommand;
    clock: AttachmentAuthorityClock;
    ids: AttachmentAuthorityIdFactory;
  }>,
): AttachmentReadyReceipt {
  const command = input.command;
  if (!isRecord(command) || !exact(command, [
    "attachmentId", "expectedGeneration", "objectKey", "byteSize", "sha256",
  ]) || !identifier(command.attachmentId, 128) || !positiveInteger(command.expectedGeneration) ||
      !opaqueKey(command.objectKey) || !positiveInteger(command.byteSize) ||
      !isAttachmentSha256(command.sha256)) {
    throw new TypeError("Attachment ready metadata is invalid");
  }
  const attachment = requireWorkerAttachmentAuthority(
    database, input.context, command.attachmentId, command.expectedGeneration,
  );
  if (attachment.processingStatus === "ready") {
    if (attachment.objectKey !== command.objectKey || attachment.byteSize !== command.byteSize ||
        attachment.sha256 !== command.sha256) return fail(409, "generation_conflict");
    const privateEventId = latestPrivateEventId(database, command.attachmentId);
    if (privateEventId === undefined) return fail(503, "storage_unavailable");
    return {
      attachmentId: command.attachmentId,
      generation: command.expectedGeneration,
      status: "ready",
      privateEventId,
      replayed: true,
    };
  }
  if (!["extracting", "ocr"].includes(attachment.processingStatus) ||
      attachment.byteSize !== command.byteSize || attachment.sha256 !== command.sha256 ||
      readReadyProvenance(database, attachment) === null) {
    return fail(409, "attachment_not_ready");
  }
  const occurredAt = now(input.clock).iso;
  try {
    database.prepare(`
      UPDATE attachments SET processing_status = 'ready', object_key = ?,
        ready_at = ?, updated_at = ?
      WHERE attachment_id = ? AND processing_generation = ?
        AND processing_status IN ('extracting', 'ocr')
    `).run(
      command.objectKey,
      occurredAt,
      occurredAt,
      command.attachmentId,
      command.expectedGeneration,
    );
  } catch (error: unknown) {
    if (error instanceof Error && /provenance|processing|ready/iu.test(error.message)) {
      return fail(409, "attachment_not_ready");
    }
    throw error;
  }
  const ready = readAttachment(database, command.attachmentId);
  if (ready === undefined || ready.processingStatus !== "ready") {
    return fail(409, "attachment_not_ready");
  }
  const privateEventId = appendPrivateStatusEvent(database, ready, occurredAt, input.ids);
  return {
    attachmentId: command.attachmentId,
    generation: command.expectedGeneration,
    status: "ready",
    privateEventId,
    replayed: false,
  };
}

function attachmentStatusAuthorization(
  database: DatabaseSync,
  context: AttachmentHumanContext,
  clock: AttachmentAuthorityClock,
  attachment: AttachmentRow,
): "authorized" | "archived-read-only" {
  const actorId = requireHumanSession(database, context, clock);
  const room = readRoomAuthority(database, attachment.roomId, actorId);
  if (room === undefined) return fail(403, "attachment_forbidden");
  if (attachment.sourceState === "unbound") {
    if (actorId !== attachment.uploaderActorId || room.status !== "active" ||
        room.lifecycleGeneration !== attachment.lifecycleGeneration ||
        room.accessRevision !== attachment.accessRevision) {
      return fail(403, "attachment_forbidden");
    }
    return "authorized";
  }
  if (attachment.sourceState !== "bound-active" || attachment.sourceMessageId === null) {
    return fail(403, "attachment_forbidden");
  }
  const operational = database.prepare(`
    SELECT 1 AS allowed
    FROM message_attachment_links AS link
    JOIN message_envelopes AS envelope ON envelope.message_id = link.message_id
    WHERE link.attachment_id = ? AND link.message_id = ? AND link.room_id = ?
      AND link.operational_state = 'active' AND envelope.lifecycle = 'active'
  `).get(attachment.attachmentId, attachment.sourceMessageId, attachment.roomId)?.allowed === 1;
  if (!operational) return fail(403, "attachment_forbidden");
  return room.status === "archived" ? "archived-read-only" : "authorized";
}

export function readAttachmentStatusDatabaseQuery(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentHumanContext;
    attachmentId: string;
    clock: AttachmentAuthorityClock;
  }>,
): AttachmentStatusResult {
  if (!identifier(input.attachmentId, 128)) return fail(400, "invalid_request");
  const attachment = readAttachment(database, input.attachmentId);
  if (attachment === undefined) return fail(410, "attachment_gone");
  const accessProjection = attachmentStatusAuthorization(
    database, input.context, input.clock, attachment,
  );
  return Object.freeze({
    attachment: metadataFromRow(database, attachment),
    sourceEligibility: attachment.sourceState,
    accessProjection,
  });
}

export function authorizeAgentAttachmentExtractionDatabaseQuery(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentAgentExecutionContext;
    attachmentId: string;
    expectedAttachmentGeneration: number;
  }>,
): AttachmentAgentExtractionAuthorization {
  if (!isRecord(input.context) || !exact(input.context, [
    "kind", "executionId", "expectedExecutionGeneration",
  ]) || input.context.kind !== "agent-execution" ||
      !identifier(input.context.executionId, 128) ||
      !positiveInteger(input.context.expectedExecutionGeneration) ||
      !identifier(input.attachmentId, 128) ||
      !positiveInteger(input.expectedAttachmentGeneration)) {
    return fail(400, "invalid_request");
  }
  const execution = database.prepare(`
    SELECT execution.id AS executionId,
           execution.execution_generation AS executionGeneration,
           execution.agent_id AS agentId,
           execution.room_id AS roomId,
           room.archive_generation AS roomLifecycleGeneration,
           CASE
             WHEN access.access_revision IS NULL
               OR membership.access_revision > access.access_revision
             THEN membership.access_revision
             ELSE access.access_revision
           END AS roomAccessRevision
    FROM agent_executions AS execution
    JOIN actors AS actor ON actor.id = execution.agent_id AND actor.kind = 'agent'
    JOIN rooms AS room ON room.id = execution.room_id
      AND room.status = 'active'
      AND room.archive_generation = execution.room_archive_generation
    JOIN room_memberships AS membership
      ON membership.room_id = execution.room_id
     AND membership.actor_id = execution.agent_id
     AND membership.kind = 'agent'
    JOIN room_agent_assignments AS assignment
      ON assignment.room_id = execution.room_id
     AND assignment.agent_actor_id = execution.agent_id
     AND assignment.status = 'current' AND assignment.paused = 0
    JOIN agent_profiles AS profile
      ON profile.id = assignment.profile_id
     AND profile.actor_id = execution.agent_id AND profile.status = 'enabled'
    LEFT JOIN room_access_authority AS access ON access.room_id = execution.room_id
    WHERE execution.id = ? AND execution.status = 'running'
      AND execution.execution_generation = ?
  `).get(input.context.executionId, input.context.expectedExecutionGeneration);
  if (execution === undefined || typeof execution.executionGeneration !== "number" ||
      typeof execution.agentId !== "string" || typeof execution.roomId !== "string" ||
      typeof execution.roomLifecycleGeneration !== "number" ||
      typeof execution.roomAccessRevision !== "number") {
    return fail(403, "attachment_forbidden");
  }
  const attachment = readAttachment(database, input.attachmentId);
  if (attachment === undefined) return fail(410, "attachment_gone");
  if (attachment.generation !== input.expectedAttachmentGeneration) {
    return fail(409, "generation_conflict");
  }
  if (attachment.roomId !== execution.roomId || attachment.processingStatus !== "ready" ||
      attachment.sourceState !== "bound-active" || attachment.sourceMessageId === null) {
    return fail(403, "attachment_forbidden");
  }
  const source = database.prepare(`
    SELECT envelope.current_revision AS sourceRevision
    FROM message_attachment_links AS link
    JOIN message_envelopes AS envelope
      ON envelope.message_id = link.message_id AND envelope.room_id = link.room_id
    WHERE link.attachment_id = ? AND link.message_id = ? AND link.room_id = ?
      AND link.operational_state = 'active' AND envelope.lifecycle = 'active'
  `).get(attachment.attachmentId, attachment.sourceMessageId, attachment.roomId);
  if (typeof source?.sourceRevision !== "number" || !positiveInteger(source.sourceRevision)) {
    return fail(403, "attachment_forbidden");
  }
  const artifact = database.prepare(`
    SELECT method, tool_name AS tool, tool_version AS toolVersion,
           object_key AS objectKey, sha256, byte_size AS byteSize,
           page_end AS pageCount
    FROM attachment_extraction_artifacts
    WHERE attachment_id = ? AND processing_generation = ?
    ORDER BY artifact_id LIMIT 1
  `).get(attachment.attachmentId, attachment.generation);
  if (artifact === undefined || typeof artifact.method !== "string" ||
      typeof artifact.tool !== "string" || typeof artifact.toolVersion !== "string" ||
      !identifier(artifact.toolVersion, 128) || typeof artifact.objectKey !== "string" ||
      typeof artifact.sha256 !== "string" || !isAttachmentSha256(artifact.sha256) ||
      artifact.objectKey !== `extraction_${artifact.sha256}` ||
      typeof artifact.byteSize !== "number" || !nonnegativeInteger(artifact.byteSize) ||
      artifact.byteSize > ATTACHMENT_AUTHORITY_LIMITS.maxExtractionArtifactBytes ||
      !(artifact.pageCount === null || (typeof artifact.pageCount === "number" &&
        positiveInteger(artifact.pageCount) &&
        artifact.pageCount <= ATTACHMENT_AUTHORITY_LIMITS.maxPageCount))) {
    return fail(503, "storage_unavailable");
  }
  const method = coreExtractionMethod(artifact.method, attachment.format);
  const tools = new Set<AttachmentExtractionTool>([
    "builtin", "bounded-zip", "pdftotext", "tesseract",
  ]);
  if (method === undefined || !tools.has(artifact.tool as AttachmentExtractionTool)) {
    return fail(503, "storage_unavailable");
  }
  return Object.freeze({
    kind: "agent-extraction",
    executionId: input.context.executionId,
    executionGeneration: execution.executionGeneration,
    agentId: execution.agentId,
    roomId: execution.roomId,
    roomLifecycleGeneration: execution.roomLifecycleGeneration,
    roomAccessRevision: execution.roomAccessRevision,
    attachmentId: attachment.attachmentId,
    attachmentGeneration: attachment.generation,
    sourceMessageId: attachment.sourceMessageId,
    sourceRevision: source.sourceRevision,
    originalFilename: attachment.originalFilename,
    format: attachment.format,
    method,
    tool: artifact.tool as AttachmentExtractionTool,
    toolVersion: artifact.toolVersion,
    pageCount: artifact.pageCount as number | null,
    objectKey: artifact.objectKey,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
  });
}

function existingBoundEvent(
  database: DatabaseSync,
  attachmentId: string,
  messageId: string,
): string | undefined {
  const row = database.prepare(`
    SELECT event_id AS eventId FROM events
    WHERE stream_kind = 'room' AND event_type = 'room.attachment.bound'
      AND json_extract(payload_json, '$.attachment.attachmentId') = ?
      AND json_extract(payload_json, '$.attachment.sourceMessageId') = ?
    ORDER BY stream_seq LIMIT 1
  `).get(attachmentId, messageId);
  return typeof row?.eventId === "string" ? row.eventId : undefined;
}

export function bindAttachmentToMessageInTransaction(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentHumanContext;
    command: import("./database-contracts.js").AttachmentBindCommand;
    clock: AttachmentAuthorityClock;
    ids: AttachmentAuthorityIdFactory;
  }>,
): AttachmentBindReceipt {
  const command = input.command;
  if (!isRecord(command) || !exact(command, [
    "requestId", "roomId", "messageId", "attachmentId",
  ]) || !identifier(command.requestId, 128) || !identifier(command.roomId) ||
      !identifier(command.messageId) || !identifier(command.attachmentId)) {
    return fail(400, "invalid_request");
  }
  const actorId = requireHumanSession(database, input.context, input.clock);
  const attachment = readAttachment(database, command.attachmentId);
  if (attachment === undefined) return fail(410, "attachment_gone");
  if (attachment.sourceState === "bound-active" &&
      attachment.sourceMessageId === command.messageId && attachment.roomId === command.roomId) {
    const roomEventId = existingBoundEvent(database, command.attachmentId, command.messageId);
    if (roomEventId === undefined) return fail(503, "storage_unavailable");
    return {
      attachmentId: command.attachmentId,
      messageId: command.messageId,
      sourceEligibility: "bound-active",
      roomEventId,
      replayed: true,
    };
  }
  if (attachment.sourceState !== "unbound" || attachment.sourceMessageId !== null) {
    return fail(409, "attachment_already_bound");
  }
  if (attachment.processingStatus !== "ready") return fail(409, "attachment_not_ready");
  if (attachment.roomId !== command.roomId || attachment.uploaderActorId !== actorId) {
    return fail(403, "attachment_forbidden");
  }
  const room = requireActiveRoomAuthority(database, command.roomId, actorId);
  if (room.lifecycleGeneration !== attachment.lifecycleGeneration ||
      room.accessRevision !== attachment.accessRevision) {
    return fail(403, "attachment_forbidden");
  }
  const message = database.prepare(`
    SELECT message.author_id AS authorId, message.author_kind AS authorKind,
           envelope.lifecycle, envelope.message_kind AS messageKind
    FROM messages AS message
    JOIN message_envelopes AS envelope ON envelope.message_id = message.id
    WHERE message.id = ? AND message.room_id = ? AND envelope.room_id = ?
  `).get(command.messageId, command.roomId, command.roomId);
  if (message?.authorId !== actorId || message.authorKind !== "human" ||
      message.messageKind !== "human" || message.lifecycle !== "active") {
    return fail(403, "attachment_forbidden");
  }
  database.prepare(`
    INSERT INTO message_attachment_links (
      message_id, room_id, attachment_id, operational_state
    ) VALUES (?, ?, ?, 'active')
  `).run(command.messageId, command.roomId, command.attachmentId);
  const bound = readAttachment(database, command.attachmentId);
  if (bound === undefined || bound.sourceState !== "bound-active" ||
      bound.sourceMessageId !== command.messageId) {
    return fail(503, "storage_unavailable");
  }
  const occurredAt = now(input.clock).iso;
  const roomEventId = appendEvent(database, {
    streamKind: "room",
    streamId: command.roomId,
    roomId: command.roomId,
    actorId,
    eventType: "room.attachment.bound",
    occurredAt,
    payload: {
      attachment: metadataFromRow(database, bound),
      sourceEligibility: "bound-active",
    },
    targetKind: "room",
    ids: input.ids,
    aggregateId: command.attachmentId,
  });
  return {
    attachmentId: command.attachmentId,
    messageId: command.messageId,
    sourceEligibility: "bound-active",
    roomEventId,
    replayed: false,
  };
}

function deny(
  status: 401 | 403 | 410,
  code: "unauthenticated" | "attachment_forbidden" | "attachment_gone",
): AttachmentAccessDecision {
  return Object.freeze({ allowed: false, status, code });
}

export function authorizeAttachmentAccessDatabaseQuery(
  database: DatabaseSync,
  input: Readonly<{
    context: AttachmentHumanContext;
    command: import("./database-contracts.js").AttachmentAccessCommand;
    clock: AttachmentAuthorityClock;
  }>,
): AttachmentAccessDecision {
  const command = input.command;
  if (!isRecord(command) || !identifier(command.attachmentId) ||
      (command.operation !== "preview" && command.operation !== "download")) {
    throw new TypeError("Attachment access command is invalid");
  }
  if (command.operation === "preview" &&
      (command.representation !== "original" && command.representation !== "safe-text" &&
        command.representation !== "safe-table")) {
    throw new TypeError("Attachment preview representation is invalid");
  }
  let actorId: string;
  try {
    actorId = requireHumanSession(database, input.context, input.clock);
  } catch (error: unknown) {
    if (error instanceof AttachmentAuthorityDatabaseError && error.status === 401) {
      return deny(401, "unauthenticated");
    }
    throw error;
  }
  const attachment = readAttachment(database, command.attachmentId);
  if (attachment === undefined) return deny(410, "attachment_gone");
  const room = readRoomAuthority(database, attachment.roomId, actorId);
  if (room === undefined || attachment.processingStatus !== "ready") {
    return deny(403, "attachment_forbidden");
  }
  if (attachment.sourceState === "unbound") {
    if (attachment.uploaderActorId !== actorId || room.status !== "active" ||
        room.lifecycleGeneration !== attachment.lifecycleGeneration ||
        room.accessRevision !== attachment.accessRevision) {
      return deny(403, "attachment_forbidden");
    }
  } else if (attachment.sourceState === "bound-active" && attachment.sourceMessageId !== null) {
    const active = database.prepare(`
      SELECT 1 AS allowed
      FROM message_attachment_links AS link
      JOIN message_envelopes AS envelope ON envelope.message_id = link.message_id
      WHERE link.attachment_id = ? AND link.message_id = ? AND link.room_id = ?
        AND link.operational_state = 'active' AND envelope.lifecycle = 'active'
    `).get(attachment.attachmentId, attachment.sourceMessageId, attachment.roomId)?.allowed === 1;
    if (!active) return deny(403, "attachment_forbidden");
  } else {
    return deny(403, "attachment_forbidden");
  }
  const representation = command.operation === "download" ? "original" : command.representation;
  let objectKey: string | null = attachment.objectKey;
  let artifactSha = attachment.sha256;
  let artifactBytes = attachment.byteSize;
  if (representation !== "original") {
    const methodPredicate = representation === "safe-table"
      ? "AND method = 'table-text'"
      : "";
    const artifact = database.prepare(`
      SELECT object_key AS objectKey, sha256, byte_size AS byteSize
      FROM attachment_extraction_artifacts
      WHERE attachment_id = ? AND processing_generation = ? ${methodPredicate}
      ORDER BY artifact_id LIMIT 1
    `).get(attachment.attachmentId, attachment.generation);
    if (typeof artifact?.objectKey !== "string" || typeof artifact.sha256 !== "string" ||
        typeof artifact.byteSize !== "number") return deny(410, "attachment_gone");
    objectKey = artifact.objectKey;
    artifactSha = artifact.sha256;
    artifactBytes = artifact.byteSize;
  }
  if (objectKey === null || !opaqueKey(objectKey) ||
      !isAttachmentSafeFilename(attachment.originalFilename)) {
    return deny(410, "attachment_gone");
  }
  return Object.freeze({
    allowed: true,
    attachmentId: attachment.attachmentId,
    generation: attachment.generation,
    lifecycleGeneration: room.lifecycleGeneration,
    accessRevision: room.accessRevision,
    operation: command.operation,
    representation,
    originalFilename: attachment.originalFilename,
    objectKey,
    sha256: artifactSha,
    byteSize: artifactBytes,
  });
}
