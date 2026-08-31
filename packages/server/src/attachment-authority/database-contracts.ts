import type {
  AttachmentDetectedMime,
  AttachmentError,
  AttachmentExtractionMethod,
  AttachmentExtractionTool,
  AttachmentFormat,
  AttachmentMetadata,
  AttachmentSourceEligibility,
} from "@native-im/core";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  isAttachmentFormat,
  isAttachmentMetadata,
  isAttachmentSafeFilename,
  isAttachmentSha256,
} from "@native-im/core";

export interface AttachmentAuthorityClock {
  readonly nowMs: () => number;
}

export interface AttachmentAuthorityIdFactory {
  readonly nextUploadId: () => string;
  readonly attachmentIdForUpload: (uploadId: string) => string;
  readonly nextEventId: (purpose: "private-status" | "room-bound", aggregateId: string) => string;
  readonly nextOutboxId: (
    eventId: string,
    targetKind: "principal" | "room",
    targetId: string,
  ) => string;
  readonly nextExtractionArtifactId: (
    attachmentId: string,
    generation: number,
  ) => string;
}

export interface AttachmentHumanContext {
  readonly kind: "human";
  readonly sessionId: string;
  readonly sessionFamilyId: string;
  readonly principal: Readonly<{
    accountId: string;
    actorId: string;
  }>;
}

export interface AttachmentWorkerContext {
  readonly kind: "attachment-worker";
  readonly workerId: string;
}

/** Server-private authority context for one already-claimed Agent execution. */
export interface AttachmentAgentExecutionContext {
  readonly kind: "agent-execution";
  readonly executionId: string;
  readonly expectedExecutionGeneration: number;
}

export interface AttachmentUploadBeginCommand {
  readonly requestId: string;
  readonly roomId: string;
  readonly uploadKey: string;
  readonly originalFilename: string;
  readonly declaredMime: AttachmentDetectedMime | null;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
}

export interface AttachmentUploadBeginReceipt {
  readonly uploadId: string;
  readonly acknowledgedBytes: number;
  readonly expectedBytes: number;
  readonly status: "open";
  readonly replayed: boolean;
}

export interface AttachmentChunkCheckpointCommand {
  readonly requestId: string;
  readonly uploadId: string;
  readonly ordinal: number;
  readonly offset: number;
  readonly byteLength: number;
  readonly chunkSha256: string;
  readonly partObjectKey: string;
}

export interface AttachmentChunkCheckpointReceipt {
  readonly uploadId: string;
  readonly ordinal: number;
  readonly acknowledgedBytes: number;
  readonly expectedBytes: number;
  readonly replayed: boolean;
}

export interface AttachmentFinalizeStorageMetadata {
  readonly quarantineObjectKey: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly format: AttachmentFormat;
  readonly detectedMime: AttachmentDetectedMime;
}

export interface AttachmentUploadFinalizeCommand {
  readonly requestId: string;
  readonly uploadId: string;
  readonly storage: AttachmentFinalizeStorageMetadata;
}

export interface AttachmentUploadFinalizeReceipt {
  readonly uploadId: string;
  readonly attachmentId: string;
  readonly status: "accepted-quarantined";
  readonly generation: number;
  readonly privateEventId: string;
  readonly replayed: boolean;
}

export interface AttachmentUploadAssemblyPlan {
  readonly uploadId: string;
  readonly attachmentId: string;
  readonly chunkCount: number;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly format: AttachmentFormat;
}

export interface AttachmentUploadCancelCommand {
  readonly requestId: string;
  readonly uploadId: string;
}

export interface AttachmentUploadCancelReceipt {
  readonly uploadId: string;
  readonly attachmentId: string | null;
  readonly replayed: boolean;
}

export interface AttachmentProcessingRetryCommand {
  readonly requestId: string;
  readonly attachmentId: string;
  readonly expectedGeneration: number;
}

export interface AttachmentProcessingRetryReceipt {
  readonly attachmentId: string;
  readonly generation: number;
  readonly replayed: boolean;
}

export type AttachmentProcessingDatabaseStage =
  | "accepted-quarantined"
  | "scanning"
  | "extracting"
  | "ocr";

export interface AttachmentProcessingPlan {
  readonly attachmentId: string;
  readonly generation: number;
  readonly format: AttachmentFormat;
  readonly declaredMime: AttachmentDetectedMime | null;
  readonly byteSize: number;
  readonly sha256: string;
  readonly stage: AttachmentProcessingDatabaseStage;
}

export interface AttachmentProcessingRecoveryBatch {
  readonly candidates: readonly AttachmentProcessingPlan[];
}

export interface AttachmentObjectReferenceSnapshot {
  readonly referencedUploadIds: readonly string[];
  readonly referencedQuarantineAttachmentIds: readonly string[];
  readonly referencedObjectKeys: readonly string[];
}

export type AttachmentProcessingAdapter = Readonly<{
  kind: "scanner" | "extractor" | "ocr";
  name: string;
  version: string;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
}>;

export interface AttachmentProcessingClaimCommand {
  readonly attachmentId: string;
  readonly expectedGeneration: number;
  readonly adapter: AttachmentProcessingAdapter;
}

export interface AttachmentProcessingClaimReceipt {
  readonly attachmentId: string;
  readonly generation: number;
  readonly attemptNumber: number;
  readonly adapterKind: AttachmentProcessingAdapter["kind"];
  readonly replayed: boolean;
}

export interface AttachmentProcessingStartCommand {
  readonly attachmentId: string;
  readonly expectedGeneration: number;
  readonly attemptNumber: number;
}

export interface AttachmentExtractionMetadata {
  readonly method: AttachmentExtractionMethod;
  readonly tool: AttachmentExtractionTool;
  readonly version: string;
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly pageCount: number | null;
}

export type AttachmentProcessingAttemptResult =
  | Readonly<{
      status: "succeeded";
      extraction?: AttachmentExtractionMetadata;
    }>
  | Readonly<{
      status: "retryable-failed" | "nonretryable-failed" | "malware-rejected";
      failureCode: string;
    }>
  | Readonly<{
      status: "cancelled";
      failureCode: "cancelled";
    }>;

export interface AttachmentProcessingCompleteCommand {
  readonly attachmentId: string;
  readonly expectedGeneration: number;
  readonly attemptNumber: number;
  readonly result: AttachmentProcessingAttemptResult;
}

export interface AttachmentProcessingCompleteReceipt {
  readonly attachmentId: string;
  readonly generation: number;
  readonly attemptNumber: number;
  readonly status: AttachmentProcessingAttemptResult["status"];
  readonly privateEventId: string | null;
  readonly replayed: boolean;
}

export interface AttachmentReadyCommand {
  readonly attachmentId: string;
  readonly expectedGeneration: number;
  readonly objectKey: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface AttachmentReadyReceipt {
  readonly attachmentId: string;
  readonly generation: number;
  readonly status: "ready";
  readonly privateEventId: string;
  readonly replayed: boolean;
}

export interface AttachmentBindCommand {
  readonly requestId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly attachmentId: string;
}

export interface AttachmentBindReceipt {
  readonly attachmentId: string;
  readonly messageId: string;
  readonly sourceEligibility: "bound-active";
  readonly roomEventId: string;
  readonly replayed: boolean;
}

export interface AttachmentStatusResult {
  readonly attachment: AttachmentMetadata;
  readonly sourceEligibility: AttachmentSourceEligibility;
  readonly accessProjection: "authorized" | "archived-read-only";
}

export type AttachmentAccessCommand =
  | Readonly<{
      attachmentId: string;
      operation: "preview";
      representation: "original" | "safe-text" | "safe-table";
    }>
  | Readonly<{
      attachmentId: string;
      operation: "download";
    }>;

export type AttachmentAccessDecision =
  | Readonly<{
      allowed: false;
      status: 401 | 403 | 410;
      code: "unauthenticated" | "attachment_forbidden" | "attachment_gone";
    }>
  | Readonly<{
      allowed: true;
      attachmentId: string;
      generation: number;
      lifecycleGeneration: number;
      accessRevision: number;
      operation: "preview" | "download";
      representation: "original" | "safe-text" | "safe-table";
      originalFilename: string;
      objectKey: string;
      sha256: string;
      byteSize: number;
    }>;

/**
 * Opaque storage authority returned only across the AuthorityWorker boundary.
 * Public protocols/events/repair must never expose objectKey or extracted text.
 */
export interface AttachmentAgentExtractionAuthorization {
  readonly kind: "agent-extraction";
  readonly executionId: string;
  readonly executionGeneration: number;
  readonly agentId: string;
  readonly roomId: string;
  readonly roomLifecycleGeneration: number;
  readonly roomAccessRevision: number;
  readonly attachmentId: string;
  readonly attachmentGeneration: number;
  readonly sourceMessageId: string;
  readonly sourceRevision: number;
  readonly originalFilename: string;
  readonly format: AttachmentFormat;
  readonly method: AttachmentExtractionMethod;
  readonly tool: AttachmentExtractionTool;
  readonly toolVersion: string;
  readonly pageCount: number | null;
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export type AttachmentDatabaseFailure = AttachmentError;

export type AttachmentDatabaseOperation =
  | Readonly<{ kind: "upload-begin"; context: AttachmentHumanContext; command: AttachmentUploadBeginCommand }>
  | Readonly<{ kind: "upload-chunk"; context: AttachmentHumanContext; command: AttachmentChunkCheckpointCommand }>
  | Readonly<{ kind: "upload-plan"; context: AttachmentHumanContext; uploadId: string }>
  | Readonly<{ kind: "upload-finalize"; context: AttachmentHumanContext; command: AttachmentUploadFinalizeCommand }>
  | Readonly<{ kind: "upload-cancel"; context: AttachmentHumanContext; command: AttachmentUploadCancelCommand }>
  | Readonly<{ kind: "processing-retry"; context: AttachmentHumanContext; command: AttachmentProcessingRetryCommand }>
  | Readonly<{
      kind: "processing-inspect";
      context: AttachmentWorkerContext;
      attachmentId: string;
      expectedGeneration: number;
    }>
  | Readonly<{
      kind: "processing-recover";
      context: AttachmentWorkerContext;
      limit: number;
    }>
  | Readonly<{
      kind: "object-references";
      context: AttachmentWorkerContext;
    }>
  | Readonly<{ kind: "processing-claim"; context: AttachmentWorkerContext; command: AttachmentProcessingClaimCommand }>
  | Readonly<{ kind: "processing-start"; context: AttachmentWorkerContext; command: AttachmentProcessingStartCommand }>
  | Readonly<{ kind: "processing-complete"; context: AttachmentWorkerContext; command: AttachmentProcessingCompleteCommand }>
  | Readonly<{ kind: "attachment-ready"; context: AttachmentWorkerContext; command: AttachmentReadyCommand }>
  | Readonly<{ kind: "status-read"; context: AttachmentHumanContext; attachmentId: string }>
  | Readonly<{ kind: "access-authorize"; context: AttachmentHumanContext; command: AttachmentAccessCommand }>
  | Readonly<{
      kind: "agent-extraction-authorize";
      context: AttachmentAgentExecutionContext;
      attachmentId: string;
      expectedAttachmentGeneration: number;
    }>;

export type AttachmentDatabaseOperationResult =
  | AttachmentUploadBeginReceipt
  | AttachmentChunkCheckpointReceipt
  | AttachmentUploadAssemblyPlan
  | AttachmentUploadFinalizeReceipt
  | AttachmentUploadCancelReceipt
  | AttachmentProcessingRetryReceipt
  | AttachmentProcessingPlan
  | AttachmentProcessingRecoveryBatch
  | AttachmentObjectReferenceSnapshot
  | AttachmentProcessingClaimReceipt
  | Readonly<{
      attachmentId: string;
      generation: number;
      attemptNumber: number;
      status: "running";
      replayed: boolean;
    }>
  | AttachmentProcessingCompleteReceipt
  | AttachmentReadyReceipt
  | AttachmentStatusResult
  | AttachmentAccessDecision
  | AttachmentAgentExtractionAuthorization;

type UnknownRecord = Record<string, unknown>;

function resultRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function resultExact(value: UnknownRecord, fields: readonly string[]): boolean {
  return fields.every((field) => Object.hasOwn(value, field)) &&
    Reflect.ownKeys(value).length === fields.length &&
    Reflect.ownKeys(value).every((field) => typeof field === "string" && fields.includes(field));
}

function resultId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function resultPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function resultNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAttachmentHumanContextValue(value: unknown): value is AttachmentHumanContext {
  return resultRecord(value) && resultExact(value, [
    "kind", "sessionId", "sessionFamilyId", "principal",
    ...(Object.hasOwn(value, "deviceId") ? ["deviceId"] : []),
  ]) && value.kind === "human" && resultId(value.sessionId) &&
    resultId(value.sessionFamilyId) && resultRecord(value.principal) &&
    (!Object.hasOwn(value, "deviceId") || resultId(value.deviceId)) &&
    resultExact(value.principal, ["accountId", "actorId"]) &&
    resultId(value.principal.accountId) && resultId(value.principal.actorId);
}

function isAttachmentWorkerContextValue(value: unknown): value is AttachmentWorkerContext {
  return resultRecord(value) && resultExact(value, ["kind", "workerId"]) &&
    value.kind === "attachment-worker" && resultId(value.workerId);
}

function isAttachmentAgentExecutionContextValue(
  value: unknown,
): value is AttachmentAgentExecutionContext {
  return resultRecord(value) && resultExact(value, [
    "kind", "executionId", "expectedExecutionGeneration",
  ]) && value.kind === "agent-execution" && resultId(value.executionId) &&
    resultPositive(value.expectedExecutionGeneration);
}

export function isAttachmentDatabaseOperation(value: unknown): value is AttachmentDatabaseOperation {
  if (!resultRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "upload-plan":
      return resultExact(value, ["kind", "context", "uploadId"]) &&
        isAttachmentHumanContextValue(value.context) && resultId(value.uploadId);
    case "status-read":
      return resultExact(value, ["kind", "context", "attachmentId"]) &&
        isAttachmentHumanContextValue(value.context) && resultId(value.attachmentId);
    case "agent-extraction-authorize":
      return resultExact(value, [
        "kind", "context", "attachmentId", "expectedAttachmentGeneration",
      ]) && isAttachmentAgentExecutionContextValue(value.context) &&
        resultId(value.attachmentId) && resultPositive(value.expectedAttachmentGeneration);
    case "processing-inspect":
      return resultExact(value, ["kind", "context", "attachmentId", "expectedGeneration"]) &&
        isAttachmentWorkerContextValue(value.context) && resultId(value.attachmentId) &&
        resultPositive(value.expectedGeneration);
    case "processing-recover":
      return resultExact(value, ["kind", "context", "limit"]) &&
        isAttachmentWorkerContextValue(value.context) && resultPositive(value.limit) &&
        value.limit <= 64;
    case "object-references":
      return resultExact(value, ["kind", "context"]) &&
        isAttachmentWorkerContextValue(value.context);
    case "upload-begin":
    case "upload-chunk":
    case "upload-finalize":
    case "upload-cancel":
    case "processing-retry":
    case "access-authorize":
      return resultExact(value, ["kind", "context", "command"]) &&
        isAttachmentHumanContextValue(value.context) && resultRecord(value.command);
    case "processing-claim":
    case "processing-start":
    case "processing-complete":
    case "attachment-ready":
      return resultExact(value, ["kind", "context", "command"]) &&
        isAttachmentWorkerContextValue(value.context) && resultRecord(value.command);
    default:
      return false;
  }
}

export function isAttachmentDatabaseOperationResult(
  value: unknown,
): value is AttachmentDatabaseOperationResult {
  if (!resultRecord(value)) return false;
  if (resultExact(value, [
    "attachmentId", "generation", "format", "declaredMime", "byteSize", "sha256", "stage",
  ])) {
    return resultId(value.attachmentId) && resultPositive(value.generation) &&
      isAttachmentFormat(value.format) &&
      (value.declaredMime === null || typeof value.declaredMime === "string") &&
      resultPositive(value.byteSize) && isAttachmentSha256(value.sha256) &&
      ["accepted-quarantined", "scanning", "extracting", "ocr"].includes(String(value.stage));
  }
  if (resultExact(value, ["candidates"])) {
    return Array.isArray(value.candidates) && value.candidates.length <= 64 &&
      value.candidates.every((candidate) => isAttachmentDatabaseOperationResult(candidate) &&
        resultRecord(candidate) && Object.hasOwn(candidate, "stage"));
  }
  if (resultExact(value, [
    "referencedUploadIds", "referencedQuarantineAttachmentIds", "referencedObjectKeys",
  ])) {
    const safeList = (candidate: unknown, guard: (entry: unknown) => boolean): boolean =>
      Array.isArray(candidate) && candidate.length <= 100_000 && candidate.every(guard) &&
      candidate.every((entry, index) => index === 0 || String(candidate[index - 1]) < String(entry));
    return safeList(value.referencedUploadIds, resultId) &&
      safeList(value.referencedQuarantineAttachmentIds, resultId) &&
      safeList(value.referencedObjectKeys, (entry) => typeof entry === "string" &&
        /^(?:object|extraction)_[0-9a-f]{64}$/u.test(entry));
  }
  if (resultExact(value, ["uploadId", "acknowledgedBytes", "expectedBytes", "status", "replayed"])) {
    return resultId(value.uploadId) && resultNonnegative(value.acknowledgedBytes) &&
      resultPositive(value.expectedBytes) && value.status === "open" &&
      typeof value.replayed === "boolean";
  }
  if (resultExact(value, ["uploadId", "ordinal", "acknowledgedBytes", "expectedBytes", "replayed"])) {
    return resultId(value.uploadId) && resultNonnegative(value.ordinal) &&
      resultPositive(value.acknowledgedBytes) && resultPositive(value.expectedBytes) &&
      typeof value.replayed === "boolean";
  }
  if (resultExact(value, [
    "uploadId", "attachmentId", "chunkCount", "expectedBytes", "expectedSha256", "format",
  ])) {
    return resultId(value.uploadId) && resultId(value.attachmentId) &&
      resultPositive(value.chunkCount) && resultPositive(value.expectedBytes) &&
      isAttachmentSha256(value.expectedSha256) && isAttachmentFormat(value.format);
  }
  if (resultExact(value, [
    "uploadId", "attachmentId", "status", "generation", "privateEventId", "replayed",
  ])) {
    return resultId(value.uploadId) && resultId(value.attachmentId) &&
      value.status === "accepted-quarantined" && resultPositive(value.generation) &&
      resultId(value.privateEventId) && typeof value.replayed === "boolean";
  }
  if (resultExact(value, ["uploadId", "attachmentId", "replayed"])) {
    return resultId(value.uploadId) &&
      (value.attachmentId === null || resultId(value.attachmentId)) &&
      typeof value.replayed === "boolean";
  }
  if (resultExact(value, ["attachmentId", "generation", "replayed"])) {
    return resultId(value.attachmentId) && resultPositive(value.generation) &&
      typeof value.replayed === "boolean";
  }
  if (resultExact(value, [
    "attachmentId", "generation", "attemptNumber", "adapterKind", "replayed",
  ])) {
    return resultId(value.attachmentId) && resultPositive(value.generation) &&
      resultPositive(value.attemptNumber) &&
      (value.adapterKind === "scanner" || value.adapterKind === "extractor" ||
        value.adapterKind === "ocr") && typeof value.replayed === "boolean";
  }
  if (resultExact(value, [
    "attachmentId", "generation", "attemptNumber", "status", "replayed",
  ])) {
    return resultId(value.attachmentId) && resultPositive(value.generation) &&
      resultPositive(value.attemptNumber) && value.status === "running" &&
      typeof value.replayed === "boolean";
  }
  if (resultExact(value, [
    "attachmentId", "generation", "attemptNumber", "status", "privateEventId", "replayed",
  ])) {
    return resultId(value.attachmentId) && resultPositive(value.generation) &&
      resultPositive(value.attemptNumber) && [
        "succeeded", "retryable-failed", "nonretryable-failed", "malware-rejected", "cancelled",
      ].includes(String(value.status)) &&
      (value.privateEventId === null || resultId(value.privateEventId)) &&
      typeof value.replayed === "boolean";
  }
  if (resultExact(value, [
    "attachmentId", "generation", "status", "privateEventId", "replayed",
  ])) {
    return resultId(value.attachmentId) && resultPositive(value.generation) &&
      value.status === "ready" && resultId(value.privateEventId) &&
      typeof value.replayed === "boolean";
  }
  if (resultExact(value, ["attachment", "sourceEligibility", "accessProjection"])) {
    return isAttachmentMetadata(value.attachment) && [
      "unbound", "bound-active", "excluded-recalled",
    ].includes(String(value.sourceEligibility)) &&
      (value.accessProjection === "authorized" || value.accessProjection === "archived-read-only");
  }
  if (resultExact(value, ["allowed", "status", "code"])) {
    return value.allowed === false &&
      ((value.status === 401 && value.code === "unauthenticated") ||
        (value.status === 403 && value.code === "attachment_forbidden") ||
        (value.status === 410 && value.code === "attachment_gone"));
  }
  if (resultExact(value, [
    "allowed", "attachmentId", "generation", "lifecycleGeneration", "accessRevision",
    "operation", "representation", "originalFilename", "objectKey", "sha256", "byteSize",
  ])) {
    return value.allowed === true && resultId(value.attachmentId) &&
      resultPositive(value.generation) && resultNonnegative(value.lifecycleGeneration) &&
      resultNonnegative(value.accessRevision) &&
      (value.operation === "preview" || value.operation === "download") &&
      (value.representation === "original" || value.representation === "safe-text" ||
        value.representation === "safe-table") && isAttachmentSafeFilename(value.originalFilename) &&
      typeof value.objectKey === "string" && /^(?:object|extraction)_[0-9a-f]{64}$/u.test(value.objectKey) &&
      isAttachmentSha256(value.sha256) && resultPositive(value.byteSize);
  }
  if (resultExact(value, [
    "kind", "executionId", "executionGeneration", "agentId", "roomId",
    "roomLifecycleGeneration", "roomAccessRevision", "attachmentId",
    "attachmentGeneration", "sourceMessageId", "sourceRevision", "originalFilename",
    "format", "method", "tool", "toolVersion", "pageCount", "objectKey", "sha256",
    "byteSize",
  ])) {
    return value.kind === "agent-extraction" && resultId(value.executionId) &&
      resultPositive(value.executionGeneration) && resultId(value.agentId) &&
      resultId(value.roomId) && resultNonnegative(value.roomLifecycleGeneration) &&
      resultNonnegative(value.roomAccessRevision) && resultId(value.attachmentId) &&
      resultPositive(value.attachmentGeneration) && resultId(value.sourceMessageId) &&
      resultPositive(value.sourceRevision) && isAttachmentSafeFilename(value.originalFilename) &&
      isAttachmentFormat(value.format) && [
        "plain-text", "csv-text", "office-xml", "pdf-text", "ocr",
      ].includes(String(value.method)) && [
        "builtin", "bounded-zip", "pdftotext", "tesseract",
      ].includes(String(value.tool)) && resultId(value.toolVersion) &&
      (value.pageCount === null || resultPositive(value.pageCount)) &&
      typeof value.objectKey === "string" && /^extraction_[0-9a-f]{64}$/u.test(value.objectKey) &&
      isAttachmentSha256(value.sha256) && value.objectKey === `extraction_${value.sha256}` &&
      resultNonnegative(value.byteSize) &&
      value.byteSize <= ATTACHMENT_AUTHORITY_LIMITS.maxExtractionArtifactBytes &&
      (value.pageCount === null || value.pageCount <= ATTACHMENT_AUTHORITY_LIMITS.maxPageCount);
  }
  return false;
}
