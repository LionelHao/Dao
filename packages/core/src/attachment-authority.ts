import { isIsoUtcTimestamp } from "./message-authority.js";

export const ATTACHMENT_AUTHORITY_LIMITS = Object.freeze({
  maxFileBytes: 50 * 1_024 * 1_024,
  maxChunkBytes: 32_768,
  maxFilenameBytes: 255,
  maxIdentifierUtf16: 256,
  maxToolVersionUtf16: 128,
  maxExtractionArtifactBytes: 8 * 1_024 * 1_024,
  maxPageCount: 500,
});

export type AttachmentFormat = "pdf" | "png" | "jpeg" | "docx" | "xlsx" | "txt" | "csv";

export type AttachmentDetectedMime =
  | "application/pdf"
  | "image/png"
  | "image/jpeg"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "text/plain"
  | "text/csv";

export type AttachmentProcessingStatus =
  | "accepted-quarantined"
  | "processing"
  | "ready"
  | "retryable-failed"
  | "nonretryable-failed"
  | "malware-rejected"
  | "cancelled";

export type AttachmentExtractionMethod =
  | "plain-text"
  | "csv-text"
  | "office-xml"
  | "pdf-text"
  | "ocr";

export type AttachmentExtractionTool =
  | "builtin"
  | "bounded-zip"
  | "pdftotext"
  | "tesseract";

export type AttachmentReadyProvenance = Readonly<{
  scanner: Readonly<{
    kind: "clamav";
    version: string;
  }>;
  extraction: Readonly<{
    method: AttachmentExtractionMethod;
    tool: AttachmentExtractionTool;
    version: string;
    artifactSha256: string;
    artifactByteSize: number;
    pageCount: number | null;
  }>;
  ocr: Readonly<{
    kind: "tesseract";
    version: string;
    pageCount: number;
  }> | null;
}>;

export type AttachmentMetadata = Readonly<{
  attachmentId: string;
  roomId: string;
  originalFilename: string;
  format: AttachmentFormat;
  declaredMime: AttachmentDetectedMime | null;
  detectedMime: AttachmentDetectedMime;
  byteSize: number;
  sha256: string;
  uploaderActorId: string;
  createdAt: string;
  readyAt: string | null;
  processingStatus: AttachmentProcessingStatus;
  generation: number;
  sourceMessageId: string | null;
  provenance: AttachmentReadyProvenance | null;
}>;

export type AttachmentLocalTransport =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "selected" }>
  | Readonly<{
      status: "uploading";
      acknowledgedBytes: number;
      totalBytes: number;
    }>
  | Readonly<{
      status: "local-rejected";
      reason: "size" | "type";
    }>
  | Readonly<{ status: "transport-failed" }>;

export type AttachmentNonretryableReason =
  | "size"
  | "type"
  | "malformed"
  | "encrypted-pdf"
  | "archive-bomb"
  | "image-bomb";

export type AttachmentDurableProcessing =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "open" }>
  | Readonly<{ status: "accepted-quarantined" }>
  | Readonly<{
      status: "processing";
      stage: "scan" | "extract" | "ocr";
    }>
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "retryable-failed" }>
  | Readonly<{
      status: "nonretryable-failed";
      reason: AttachmentNonretryableReason;
    }>
  | Readonly<{ status: "malware-rejected" }>
  | Readonly<{ status: "cancelled" }>;

export type AttachmentSourceEligibility = "unbound" | "bound-active" | "excluded-recalled";
export type AttachmentAccessProjection =
  | "authorized"
  | "permission-revoked"
  | "archived-read-only"
  | "offline"
  | "repairing";

export type AttachmentUiAxes = Readonly<{
  localTransport: AttachmentLocalTransport;
  durableProcessing: AttachmentDurableProcessing;
  sourceEligibility: AttachmentSourceEligibility;
  accessProjection: AttachmentAccessProjection;
}>;

export type AttachmentUiState =
  | "local-selected"
  | "uploading"
  | "processing"
  | "ready"
  | "retryable-failure"
  | "nonretryable-failure"
  | "cancelled"
  | "size-type-rejected"
  | "malware-rejected"
  | "permission-revoked";

type AttachmentEventEnvelope<TType extends string, TPayload> = Readonly<{
  eventId: string;
  streamKind: "principal" | "room";
  streamId: string;
  streamSeq: number;
  actorId: string;
  occurredAt: string;
  type: TType;
  payload: TPayload;
}>;

export type AttachmentPrivateEvent = AttachmentEventEnvelope<
  "attachment.private.status-changed",
  Readonly<{ attachment: AttachmentMetadata & Readonly<{ sourceMessageId: null }> }>
> & Readonly<{ streamKind: "principal" }>;

export type AttachmentRoomBoundEvent = AttachmentEventEnvelope<
  "room.attachment.bound",
  Readonly<{
    attachment: AttachmentMetadata & Readonly<{
      processingStatus: "ready";
      sourceMessageId: string;
      readyAt: string;
      provenance: AttachmentReadyProvenance;
    }>;
    sourceEligibility: "bound-active";
  }>
> & Readonly<{
  streamKind: "room";
  roomId: string;
}>;

export type AttachmentRoomExcludedEvent = AttachmentEventEnvelope<
  "room.attachment.excluded",
  Readonly<{
    attachmentId: string;
    sourceMessageId: string;
    generation: number;
    sourceEligibility: "excluded-recalled";
    reason: "message-recalled";
  }>
> & Readonly<{
  streamKind: "room";
  roomId: string;
}>;

export type AttachmentRoomEvent = AttachmentRoomBoundEvent | AttachmentRoomExcludedEvent;

export type AttachmentRepairRecord = Readonly<{
  kind: "attachment";
  value: Readonly<{
    attachment: AttachmentMetadata & Readonly<{
      processingStatus: "ready";
      sourceMessageId: string;
      readyAt: string;
      provenance: AttachmentReadyProvenance;
    }>;
    sourceEligibility: "bound-active";
  }>;
}>;

type AttachmentErrorWithoutRetry<TStatus extends number, TCode extends string> = Readonly<{
  status: TStatus;
  code: TCode;
}>;

export type AttachmentError =
  | AttachmentErrorWithoutRetry<400, "invalid_request" | "invalid_chunk">
  | AttachmentErrorWithoutRetry<401, "unauthenticated">
  | AttachmentErrorWithoutRetry<403, "room_forbidden" | "attachment_forbidden">
  | AttachmentErrorWithoutRetry<409,
      | "idempotency_conflict"
      | "upload_offset_conflict"
      | "attachment_already_bound"
      | "generation_conflict"
      | "attachment_not_ready">
  | AttachmentErrorWithoutRetry<410,
      "upload_expired" | "attachment_gone" | "protocol_upgrade_required">
  | AttachmentErrorWithoutRetry<413, "attachment_too_large" | "chunk_too_large">
  | AttachmentErrorWithoutRetry<415, "attachment_type_unsupported" | "type_mismatch">
  | AttachmentErrorWithoutRetry<422,
      "attachment_malformed" | "encrypted_pdf" | "archive_bomb" | "image_bomb">
  | Readonly<{
      status: 429;
      code: "attachment_capacity_limited";
      retryAfterSeconds: number;
    }>
  | AttachmentErrorWithoutRetry<503,
      | "storage_unavailable"
      | "scanner_unavailable"
      | "extractor_unavailable"
      | "ocr_unavailable"
      | "repair_barrier_active">;

type UnknownRecord = Record<string, unknown>;

const formats = new Set<AttachmentFormat>(["pdf", "png", "jpeg", "docx", "xlsx", "txt", "csv"]);
const detectedMimes: Readonly<Record<AttachmentFormat, AttachmentDetectedMime>> = Object.freeze({
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  csv: "text/csv",
});
const extensions: Readonly<Record<AttachmentFormat, readonly string[]>> = Object.freeze({
  pdf: Object.freeze(["pdf"]),
  png: Object.freeze(["png"]),
  jpeg: Object.freeze(["jpeg", "jpg"]),
  docx: Object.freeze(["docx"]),
  xlsx: Object.freeze(["xlsx"]),
  txt: Object.freeze(["txt"]),
  csv: Object.freeze(["csv"]),
});
const processingStatuses = new Set<AttachmentProcessingStatus>([
  "accepted-quarantined",
  "processing",
  "ready",
  "retryable-failed",
  "nonretryable-failed",
  "malware-rejected",
  "cancelled",
]);
const extractionMethods = new Set<AttachmentExtractionMethod>([
  "plain-text", "csv-text", "office-xml", "pdf-text", "ocr",
]);
const extractionTools = new Set<AttachmentExtractionTool>([
  "builtin", "bounded-zip", "pdftotext", "tesseract",
]);
const sourceEligibilityValues = new Set<AttachmentSourceEligibility>([
  "unbound", "bound-active", "excluded-recalled",
]);
const accessProjectionValues = new Set<AttachmentAccessProjection>([
  "authorized", "permission-revoked", "archived-read-only", "offline", "repairing",
]);
const nonretryableReasons = new Set<AttachmentNonretryableReason>([
  "size", "type", "malformed", "encrypted-pdf", "archive-bomb", "image-bomb",
]);
const forbiddenFilenameCharacters = /[\p{Cc}\p{Cf}/\\]/u;
const schemeOrDrivePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const errorCodesByStatus: Readonly<Record<number, ReadonlySet<string>>> = Object.freeze({
  400: new Set(["invalid_request", "invalid_chunk"]),
  401: new Set(["unauthenticated"]),
  403: new Set(["room_forbidden", "attachment_forbidden"]),
  409: new Set([
    "idempotency_conflict",
    "upload_offset_conflict",
    "attachment_already_bound",
    "generation_conflict",
    "attachment_not_ready",
  ]),
  410: new Set(["upload_expired", "attachment_gone", "protocol_upgrade_required"]),
  413: new Set(["attachment_too_large", "chunk_too_large"]),
  415: new Set(["attachment_type_unsupported", "type_mismatch"]),
  422: new Set(["attachment_malformed", "encrypted_pdf", "archive_bomb", "image_bomb"]),
  429: new Set(["attachment_capacity_limited"]),
  503: new Set([
    "storage_unavailable",
    "scanner_unavailable",
    "extractor_unavailable",
    "ocr_unavailable",
    "repair_barrier_active",
  ]),
});

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= ATTACHMENT_AUTHORITY_LIMITS.maxIdentifierUtf16 &&
    value === value.trim() && value.normalize("NFC") === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= ATTACHMENT_AUTHORITY_LIMITS.maxToolVersionUtf16 &&
    value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function filenameFormat(value: string): AttachmentFormat | undefined {
  const dot = value.lastIndexOf(".");
  if (dot <= 0 || dot === value.length - 1) return undefined;
  const extension = value.slice(dot + 1).toLowerCase();
  for (const format of formats) {
    if (extensions[format].includes(extension)) return format;
  }
  return undefined;
}

export function isAttachmentFormat(value: unknown): value is AttachmentFormat {
  return typeof value === "string" && formats.has(value as AttachmentFormat);
}

export function attachmentDetectedMime(format: AttachmentFormat): AttachmentDetectedMime {
  return detectedMimes[format];
}

export function isAttachmentSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isAttachmentSafeFilename(
  value: unknown,
  expectedFormat?: AttachmentFormat,
): value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      value.normalize("NFC") !== value || value === "." || value === ".." ||
      forbiddenFilenameCharacters.test(value) || schemeOrDrivePrefix.test(value) ||
      new TextEncoder().encode(value).byteLength > ATTACHMENT_AUTHORITY_LIMITS.maxFilenameBytes) {
    return false;
  }
  const actualFormat = filenameFormat(value);
  return actualFormat !== undefined && (expectedFormat === undefined || actualFormat === expectedFormat);
}

function isScannerSummary(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["kind", "version"]) &&
    value.kind === "clamav" && isVersion(value.version);
}

function isExtractionSummary(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "method", "tool", "version", "artifactSha256", "artifactByteSize", "pageCount",
  ]) && extractionMethods.has(value.method as AttachmentExtractionMethod) &&
    extractionTools.has(value.tool as AttachmentExtractionTool) && isVersion(value.version) &&
    isAttachmentSha256(value.artifactSha256) && isNonnegativeSafeInteger(value.artifactByteSize) &&
    value.artifactByteSize <= ATTACHMENT_AUTHORITY_LIMITS.maxExtractionArtifactBytes &&
    (value.pageCount === null ||
      (isPositiveSafeInteger(value.pageCount) &&
        value.pageCount <= ATTACHMENT_AUTHORITY_LIMITS.maxPageCount));
}

function isOcrSummary(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["kind", "version", "pageCount"]) &&
    value.kind === "tesseract" && isVersion(value.version) &&
    isPositiveSafeInteger(value.pageCount) &&
    value.pageCount <= ATTACHMENT_AUTHORITY_LIMITS.maxPageCount;
}

export function isAttachmentReadyProvenance(value: unknown): value is AttachmentReadyProvenance {
  if (!isRecord(value) || !hasExactKeys(value, ["scanner", "extraction", "ocr"]) ||
      !isScannerSummary(value.scanner) || !isExtractionSummary(value.extraction) ||
      !(value.ocr === null || isOcrSummary(value.ocr))) {
    return false;
  }
  const extraction = value.extraction as UnknownRecord;
  return extraction.method === "ocr" ? value.ocr !== null : value.ocr === null;
}

export function isAttachmentMetadata(value: unknown): value is AttachmentMetadata {
  if (!isRecord(value) || !hasExactKeys(value, [
    "attachmentId",
    "roomId",
    "originalFilename",
    "format",
    "declaredMime",
    "detectedMime",
    "byteSize",
    "sha256",
    "uploaderActorId",
    "createdAt",
    "readyAt",
    "processingStatus",
    "generation",
    "sourceMessageId",
    "provenance",
  ]) || !isIdentifier(value.attachmentId) || !isIdentifier(value.roomId) ||
      !isAttachmentFormat(value.format) ||
      !isAttachmentSafeFilename(value.originalFilename, value.format) ||
      !(value.declaredMime === null || value.declaredMime === attachmentDetectedMime(value.format)) ||
      value.detectedMime !== attachmentDetectedMime(value.format) ||
      !isPositiveSafeInteger(value.byteSize) ||
      value.byteSize > ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes ||
      !isAttachmentSha256(value.sha256) || !isIdentifier(value.uploaderActorId) ||
      !isIsoUtcTimestamp(value.createdAt) ||
      !processingStatuses.has(value.processingStatus as AttachmentProcessingStatus) ||
      !isPositiveSafeInteger(value.generation) ||
      !(value.sourceMessageId === null || isIdentifier(value.sourceMessageId))) {
    return false;
  }
  if (value.processingStatus === "ready") {
    return isIsoUtcTimestamp(value.readyAt) &&
      Date.parse(value.readyAt) >= Date.parse(value.createdAt) &&
      isAttachmentReadyProvenance(value.provenance);
  }
  return value.readyAt === null && value.provenance === null && value.sourceMessageId === null;
}

function isLocalTransport(value: unknown): value is AttachmentLocalTransport {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "none":
    case "selected":
    case "transport-failed":
      return hasExactKeys(value, ["status"]);
    case "uploading":
      return hasExactKeys(value, ["status", "acknowledgedBytes", "totalBytes"]) &&
        isNonnegativeSafeInteger(value.acknowledgedBytes) &&
        isPositiveSafeInteger(value.totalBytes) &&
        value.totalBytes <= ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes &&
        value.acknowledgedBytes <= value.totalBytes;
    case "local-rejected":
      return hasExactKeys(value, ["status", "reason"]) &&
        (value.reason === "size" || value.reason === "type");
    default:
      return false;
  }
}

function isDurableProcessing(value: unknown): value is AttachmentDurableProcessing {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "none":
    case "open":
    case "accepted-quarantined":
    case "ready":
    case "retryable-failed":
    case "malware-rejected":
    case "cancelled":
      return hasExactKeys(value, ["status"]);
    case "processing":
      return hasExactKeys(value, ["status", "stage"]) &&
        (value.stage === "scan" || value.stage === "extract" || value.stage === "ocr");
    case "nonretryable-failed":
      return hasExactKeys(value, ["status", "reason"]) &&
        nonretryableReasons.has(value.reason as AttachmentNonretryableReason);
    default:
      return false;
  }
}

export function isAttachmentUiAxes(value: unknown): value is AttachmentUiAxes {
  if (!isRecord(value) || !hasExactKeys(value, [
    "localTransport", "durableProcessing", "sourceEligibility", "accessProjection",
  ]) || !isLocalTransport(value.localTransport) ||
      !isDurableProcessing(value.durableProcessing) ||
      !sourceEligibilityValues.has(value.sourceEligibility as AttachmentSourceEligibility) ||
      !accessProjectionValues.has(value.accessProjection as AttachmentAccessProjection)) {
    return false;
  }
  if (value.sourceEligibility !== "unbound" &&
      (value.durableProcessing as AttachmentDurableProcessing).status !== "ready") {
    return false;
  }
  return true;
}

export function projectAttachmentUiState(value: AttachmentUiAxes): AttachmentUiState | undefined {
  if (!isAttachmentUiAxes(value)) return undefined;
  if (value.accessProjection === "permission-revoked") return "permission-revoked";
  if (value.sourceEligibility === "excluded-recalled") return undefined;

  const durable = value.durableProcessing;
  if (durable.status === "malware-rejected") return "malware-rejected";
  if (durable.status === "nonretryable-failed") {
    return durable.reason === "size" || durable.reason === "type"
      ? "size-type-rejected"
      : "nonretryable-failure";
  }
  if (durable.status === "cancelled") return "cancelled";
  if (durable.status === "retryable-failed" ||
      value.localTransport.status === "transport-failed") {
    return "retryable-failure";
  }
  if (durable.status === "accepted-quarantined" || durable.status === "processing") {
    return "processing";
  }
  if (durable.status === "ready") return "ready";
  if (value.localTransport.status === "local-rejected") return "size-type-rejected";
  if (durable.status === "open" || value.localTransport.status === "uploading") {
    return "uploading";
  }
  if (value.localTransport.status === "selected") return "local-selected";
  return undefined;
}

const eventEnvelopeKeys = [
  "eventId", "streamKind", "streamId", "streamSeq", "actorId", "occurredAt", "type", "payload",
] as const;

function isEventEnvelope(value: UnknownRecord): boolean {
  return isIdentifier(value.eventId) && isIdentifier(value.streamId) &&
    isPositiveSafeInteger(value.streamSeq) && isIdentifier(value.actorId) &&
    isIsoUtcTimestamp(value.occurredAt);
}

export function isAttachmentPrivateEvent(value: unknown): value is AttachmentPrivateEvent {
  if (!isRecord(value) || !hasExactKeys(value, eventEnvelopeKeys) || !isEventEnvelope(value) ||
      value.streamKind !== "principal" ||
      value.type !== "attachment.private.status-changed" || !isRecord(value.payload) ||
      !hasExactKeys(value.payload, ["attachment"]) ||
      !isAttachmentMetadata(value.payload.attachment)) {
    return false;
  }
  const attachment = value.payload.attachment;
  return attachment.sourceMessageId === null &&
    value.streamId === attachment.uploaderActorId && value.actorId === attachment.uploaderActorId;
}

function isRoomEventEnvelope(value: UnknownRecord): boolean {
  return hasExactKeys(value, [...eventEnvelopeKeys, "roomId"]) && isEventEnvelope(value) &&
    value.streamKind === "room" && isIdentifier(value.roomId) && value.streamId === value.roomId;
}

export function isAttachmentRoomEvent(value: unknown): value is AttachmentRoomEvent {
  if (!isRecord(value) || !isRoomEventEnvelope(value) || !isRecord(value.payload)) return false;
  if (value.type === "room.attachment.bound") {
    if (!hasExactKeys(value.payload, ["attachment", "sourceEligibility"]) ||
        value.payload.sourceEligibility !== "bound-active" ||
        !isAttachmentMetadata(value.payload.attachment)) {
      return false;
    }
    const attachment = value.payload.attachment;
    return attachment.processingStatus === "ready" && attachment.sourceMessageId !== null &&
      attachment.roomId === value.roomId && attachment.uploaderActorId === value.actorId;
  }
  if (value.type === "room.attachment.excluded") {
    return hasExactKeys(value.payload, [
      "attachmentId", "sourceMessageId", "generation", "sourceEligibility", "reason",
    ]) && isIdentifier(value.payload.attachmentId) && isIdentifier(value.payload.sourceMessageId) &&
      isPositiveSafeInteger(value.payload.generation) &&
      value.payload.sourceEligibility === "excluded-recalled" &&
      value.payload.reason === "message-recalled";
  }
  return false;
}

export function isAttachmentRepairRecord(
  value: unknown,
  expectedRoomId?: string,
): value is AttachmentRepairRecord {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "value"]) ||
      value.kind !== "attachment" || !isRecord(value.value) ||
      !hasExactKeys(value.value, ["attachment", "sourceEligibility"]) ||
      value.value.sourceEligibility !== "bound-active" ||
      !isAttachmentMetadata(value.value.attachment)) {
    return false;
  }
  const attachment = value.value.attachment;
  return attachment.processingStatus === "ready" && attachment.sourceMessageId !== null &&
    (expectedRoomId === undefined || attachment.roomId === expectedRoomId);
}

export function isAttachmentError(value: unknown): value is AttachmentError {
  if (!isRecord(value) || !isPositiveSafeInteger(value.status) || typeof value.code !== "string") {
    return false;
  }
  const allowedCodes = errorCodesByStatus[value.status];
  if (allowedCodes === undefined || !allowedCodes.has(value.code)) return false;
  if (value.status === 429) {
    return hasExactKeys(value, ["status", "code", "retryAfterSeconds"]) &&
      isPositiveSafeInteger(value.retryAfterSeconds) && value.retryAfterSeconds <= 86_400;
  }
  return hasExactKeys(value, ["status", "code"]);
}
