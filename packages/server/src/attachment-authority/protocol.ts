import { createHash } from "node:crypto";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  attachmentDetectedMime,
  isAttachmentSafeFilename,
  isAttachmentSha256,
  type AttachmentDetectedMime,
  type AttachmentError,
  type AttachmentFormat,
} from "@native-im/core";

export const ATTACHMENT_FRAME_MAX_BYTES = 64 * 1_024;

export interface AttachmentUploadBeginFrame {
  readonly type: "attachment.upload.begin";
  readonly requestId: string;
  readonly roomId: string;
  readonly uploadKey: string;
  readonly originalFilename: string;
  readonly declaredMime: AttachmentDetectedMime | null;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
}

export interface AttachmentUploadChunkFrame {
  readonly type: "attachment.upload.chunk";
  readonly requestId: string;
  readonly uploadId: string;
  readonly ordinal: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly chunkSha256: string;
  readonly base64: string;
}

export interface AttachmentUploadFinalizeFrame {
  readonly type: "attachment.upload.finalize";
  readonly requestId: string;
  readonly uploadId: string;
}

export interface AttachmentUploadCancelFrame {
  readonly type: "attachment.upload.cancel";
  readonly requestId: string;
  readonly uploadId: string;
}

export interface AttachmentProcessingRetryFrame {
  readonly type: "attachment.processing.retry";
  readonly requestId: string;
  readonly attachmentId: string;
  readonly expectedGeneration: number;
}

export interface AttachmentStatusQueryFrame {
  readonly type: "attachment.status.query";
  readonly requestId: string;
  readonly attachmentId: string;
}

export interface AttachmentPreviewOpenFrame {
  readonly type: "attachment.preview.open";
  readonly requestId: string;
  readonly attachmentId: string;
  readonly representation: "original" | "safe-text" | "safe-table";
}

export interface AttachmentDownloadOpenFrame {
  readonly type: "attachment.download.open";
  readonly requestId: string;
  readonly attachmentId: string;
}

export interface AttachmentStreamReadFrame {
  readonly type: "attachment.stream.read";
  readonly requestId: string;
  readonly streamId: string;
  readonly offset: number;
  readonly maximumBytes: number;
}

export type AttachmentClientFrame =
  | AttachmentUploadBeginFrame
  | AttachmentUploadChunkFrame
  | AttachmentUploadFinalizeFrame
  | AttachmentUploadCancelFrame
  | AttachmentProcessingRetryFrame
  | AttachmentStatusQueryFrame
  | AttachmentPreviewOpenFrame
  | AttachmentDownloadOpenFrame
  | AttachmentStreamReadFrame;

export type AttachmentProtocolError = AttachmentError & Readonly<{
  message: "Invalid attachment request";
  requestId?: string;
}>;

export type AttachmentClientFrameParseResult =
  | Readonly<{ ok: true; frame: AttachmentClientFrame }>
  | Readonly<{ ok: false; error: AttachmentProtocolError }>;

type UnknownRecord = Record<string, unknown>;

const beginFields = new Set([
  "type", "requestId", "roomId", "uploadKey", "originalFilename", "declaredMime",
  "expectedBytes", "expectedSha256",
]);
const chunkFields = new Set([
  "type", "requestId", "uploadId", "ordinal", "offset", "byteLength", "chunkSha256", "base64",
]);
const uploadOperationFields = new Set(["type", "requestId", "uploadId"]);
const retryFields = new Set(["type", "requestId", "attachmentId", "expectedGeneration"]);
const attachmentOperationFields = new Set(["type", "requestId", "attachmentId"]);
const previewFields = new Set(["type", "requestId", "attachmentId", "representation"]);
const streamReadFields = new Set(["type", "requestId", "streamId", "offset", "maximumBytes"]);
const formatByExtension: Readonly<Record<string, AttachmentFormat>> = Object.freeze({
  pdf: "pdf",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  docx: "docx",
  xlsx: "xlsx",
  txt: "txt",
  csv: "csv",
});

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, fields: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).length === fields.size &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && fields.has(key));
}

function boundedIdentifier(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value === value.trim() && value.normalize("NFC") === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function requestId(value: unknown): value is string {
  return boundedIdentifier(value, 128);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function error(
  value: UnknownRecord,
  status: AttachmentProtocolError["status"],
  code: AttachmentProtocolError["code"],
): AttachmentClientFrameParseResult {
  const correlation = requestId(value.requestId) ? { requestId: value.requestId } : {};
  return Object.freeze({
    ok: false,
    error: Object.freeze({ status, code, message: "Invalid attachment request", ...correlation }),
  }) as AttachmentClientFrameParseResult;
}

function formatForFilename(filename: string): AttachmentFormat | undefined {
  const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return formatByExtension[extension];
}

function parseBegin(value: UnknownRecord): AttachmentClientFrameParseResult {
  if (!exact(value, beginFields) || !requestId(value.requestId) ||
      !boundedIdentifier(value.roomId) || !boundedIdentifier(value.uploadKey) ||
      !isAttachmentSafeFilename(value.originalFilename) ||
      !(value.declaredMime === null || typeof value.declaredMime === "string") ||
      !positiveInteger(value.expectedBytes) || !isAttachmentSha256(value.expectedSha256)) {
    return error(value, 400, "invalid_request");
  }
  if (value.expectedBytes > ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes) {
    return error(value, 413, "attachment_too_large");
  }
  const format = formatForFilename(value.originalFilename);
  if (format === undefined) return error(value, 415, "attachment_type_unsupported");
  if (value.declaredMime !== null && value.declaredMime !== attachmentDetectedMime(format)) {
    return error(value, 415, "type_mismatch");
  }
  return Object.freeze({ ok: true, frame: Object.freeze({
    type: "attachment.upload.begin" as const,
    requestId: value.requestId,
    roomId: value.roomId,
    uploadKey: value.uploadKey,
    originalFilename: value.originalFilename,
    declaredMime: value.declaredMime as AttachmentDetectedMime | null,
    expectedBytes: value.expectedBytes,
    expectedSha256: value.expectedSha256,
  }) });
}

function decodeCanonicalBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}

function parseChunk(value: UnknownRecord): AttachmentClientFrameParseResult {
  if (!exact(value, chunkFields) || !requestId(value.requestId) ||
      !boundedIdentifier(value.uploadId) || !nonnegativeInteger(value.ordinal) ||
      !nonnegativeInteger(value.offset) || !positiveInteger(value.byteLength) ||
      !isAttachmentSha256(value.chunkSha256)) {
    return error(value, 400, "invalid_chunk");
  }
  if (value.byteLength > ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes) {
    return error(value, 413, "chunk_too_large");
  }
  const bytes = decodeCanonicalBase64(value.base64);
  const maxOrdinal = Math.ceil(
    ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes / ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes,
  );
  if (bytes === undefined || bytes.byteLength !== value.byteLength ||
      value.ordinal >= maxOrdinal || value.offset !== value.ordinal * ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes ||
      value.offset + value.byteLength > ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes ||
      createHash("sha256").update(bytes).digest("hex") !== value.chunkSha256) {
    return error(value, 400, "invalid_chunk");
  }
  const frame: AttachmentUploadChunkFrame = Object.freeze({
    type: "attachment.upload.chunk",
    requestId: value.requestId,
    uploadId: value.uploadId,
    ordinal: value.ordinal,
    offset: value.offset,
    byteLength: value.byteLength,
    chunkSha256: value.chunkSha256,
    base64: value.base64 as string,
  });
  if (Buffer.byteLength(JSON.stringify(frame), "utf8") >= ATTACHMENT_FRAME_MAX_BYTES) {
    return error(value, 413, "chunk_too_large");
  }
  return Object.freeze({ ok: true, frame });
}

function parseUploadOperation(
  value: UnknownRecord,
  type: "attachment.upload.finalize" | "attachment.upload.cancel",
): AttachmentClientFrameParseResult {
  if (!exact(value, uploadOperationFields) || !requestId(value.requestId) ||
      !boundedIdentifier(value.uploadId)) return error(value, 400, "invalid_request");
  return Object.freeze({ ok: true, frame: Object.freeze({ type, requestId: value.requestId, uploadId: value.uploadId }) });
}

function parseAttachmentOperation(
  value: UnknownRecord,
  type: "attachment.status.query" | "attachment.download.open",
): AttachmentClientFrameParseResult {
  if (!exact(value, attachmentOperationFields) || !requestId(value.requestId) ||
      !boundedIdentifier(value.attachmentId)) return error(value, 400, "invalid_request");
  return Object.freeze({ ok: true, frame: Object.freeze({
    type, requestId: value.requestId, attachmentId: value.attachmentId,
  }) });
}

export function parseAttachmentClientFrame(value: unknown): AttachmentClientFrameParseResult {
  if (!isRecord(value) || typeof value.type !== "string") {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ status: 400, code: "invalid_request", message: "Invalid attachment request" }),
    });
  }
  switch (value.type) {
    case "attachment.upload.begin": return parseBegin(value);
    case "attachment.upload.chunk": return parseChunk(value);
    case "attachment.upload.finalize": return parseUploadOperation(value, value.type);
    case "attachment.upload.cancel": return parseUploadOperation(value, value.type);
    case "attachment.processing.retry":
      if (!exact(value, retryFields) || !requestId(value.requestId) ||
          !boundedIdentifier(value.attachmentId) || !positiveInteger(value.expectedGeneration)) {
        return error(value, 400, "invalid_request");
      }
      return Object.freeze({ ok: true, frame: Object.freeze({
        type: value.type, requestId: value.requestId, attachmentId: value.attachmentId,
        expectedGeneration: value.expectedGeneration,
      }) });
    case "attachment.status.query": return parseAttachmentOperation(value, value.type);
    case "attachment.preview.open":
      if (!exact(value, previewFields) || !requestId(value.requestId) ||
          !boundedIdentifier(value.attachmentId) ||
          (value.representation !== "original" && value.representation !== "safe-text" &&
            value.representation !== "safe-table")) {
        return error(value, 400, "invalid_request");
      }
      return Object.freeze({ ok: true, frame: Object.freeze({
        type: value.type, requestId: value.requestId, attachmentId: value.attachmentId,
        representation: value.representation,
      }) });
    case "attachment.download.open": return parseAttachmentOperation(value, value.type);
    case "attachment.stream.read":
      if (!exact(value, streamReadFields) || !requestId(value.requestId) ||
          !boundedIdentifier(value.streamId) || !nonnegativeInteger(value.offset) ||
          !positiveInteger(value.maximumBytes) ||
          value.maximumBytes > ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes) {
        return error(value, 400, "invalid_request");
      }
      return Object.freeze({ ok: true, frame: Object.freeze({
        type: value.type,
        requestId: value.requestId,
        streamId: value.streamId,
        offset: value.offset,
        maximumBytes: value.maximumBytes,
      }) });
    default: return error(value, 400, "invalid_request");
  }
}
