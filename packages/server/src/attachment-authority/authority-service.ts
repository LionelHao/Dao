import { createHash } from "node:crypto";
import {
  attachmentDetectedMime,
  type AttachmentError,
  type AttachmentProcessingStatus,
} from "@native-im/core";
import type { AuthenticatedCommandContext } from "../persistence/contracts.js";
import type { WorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type { AttachmentAuthorityServerFrame } from "../protocol.js";
import type {
  AttachmentAccessCommand,
  AttachmentAccessDecision,
  AttachmentDatabaseOperation,
  AttachmentDatabaseOperationResult,
  AttachmentHumanContext,
  AttachmentStatusResult,
  AttachmentUploadAssemblyPlan,
} from "./database-contracts.js";
import {
  AttachmentObjectStore,
  AttachmentObjectStoreError,
} from "./object-store.js";
import type { AttachmentClientFrame } from "./protocol.js";
import {
  createAttachmentReadGrantRegistry,
  type AttachmentReadAuthorization,
  type AttachmentReadGrantContext,
} from "./read-grant-registry.js";

export type AttachmentAuthorityCommandResponse = Extract<
  AttachmentAuthorityServerFrame,
  Readonly<{ requestId: string }>
>;

export interface AttachmentAuthorityCommandPort {
  execute(
    context: AuthenticatedCommandContext,
    frame: AttachmentClientFrame,
  ): Promise<AttachmentAuthorityCommandResponse>;
  invalidateFamily(sessionFamilyId: string): void;
  close(): void;
}

export interface AttachmentProcessingQueuePort {
  enqueue(input: Readonly<{ attachmentId: string; generation: number }>): Promise<void>;
}

export class AttachmentAuthorityServiceError extends Error {
  readonly status: AttachmentError["status"];
  readonly code: AttachmentError["code"];
  readonly retryAfterSeconds?: number;

  constructor(error: AttachmentError) {
    super(`Attachment authority service rejected: ${error.code}`);
    this.name = "AttachmentAuthorityServiceError";
    this.status = error.status;
    this.code = error.code;
    if ("retryAfterSeconds" in error) this.retryAfterSeconds = error.retryAfterSeconds;
    delete this.stack;
  }
}

function fail(error: AttachmentError): never {
  throw new AttachmentAuthorityServiceError(error);
}

function humanContext(context: AuthenticatedCommandContext): AttachmentHumanContext {
  return Object.freeze({
    kind: "human",
    sessionId: context.sessionId,
    sessionFamilyId: context.sessionFamilyId,
    principal: Object.freeze({ ...context.principal }),
  });
}

function readContext(context: AuthenticatedCommandContext): AttachmentReadGrantContext {
  return Object.freeze({
    sessionId: context.sessionId,
    sessionFamilyId: context.sessionFamilyId,
    principal: Object.freeze({ ...context.principal }),
  });
}

function partObjectKey(uploadId: string, ordinal: number, sha256: string): string {
  return `part_${createHash("sha256").update(`${uploadId}:${ordinal}:${sha256}`).digest("hex")}`;
}

function canonicalBytes(base64: string, expectedSha256: string): Uint8Array {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64 ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    return fail({ status: 400, code: "invalid_chunk" });
  }
  return bytes;
}

function mapStoreError(error: AttachmentObjectStoreError): never {
  switch (error.reason) {
    case "invalid_chunk":
    case "digest_mismatch":
      return fail({ status: 400, code: "invalid_chunk" });
    case "chunk_too_large":
      return fail({ status: 413, code: "chunk_too_large" });
    case "file_too_large":
      return fail({ status: 413, code: "attachment_too_large" });
    case "chunk_conflict":
    case "chunk_missing":
    case "whole_size_mismatch":
    case "whole_digest_mismatch":
    case "quarantine_conflict":
      return fail({ status: 409, code: "upload_offset_conflict" });
    case "quarantine_missing":
      return fail({ status: 410, code: "upload_expired" });
    case "object_missing":
      return fail({ status: 410, code: "attachment_gone" });
    case "invalid_configuration":
    case "invalid_identity":
    case "object_conflict":
    case "unsafe_store":
    case "storage_unavailable":
      return fail({ status: 503, code: "storage_unavailable" });
  }
}

function denied(decision: Extract<AttachmentAccessDecision, { allowed: false }>): never {
  switch (decision.status) {
    case 401: return fail({ status: 401, code: "unauthenticated" });
    case 403: return fail({ status: 403, code: "attachment_forbidden" });
    case 410: return fail({ status: 410, code: "attachment_gone" });
  }
}

function authorization(
  decision: Extract<AttachmentAccessDecision, { allowed: true }>,
): AttachmentReadAuthorization {
  return Object.freeze({
    attachmentId: decision.attachmentId,
    generation: decision.generation,
    lifecycleGeneration: decision.lifecycleGeneration,
    accessRevision: decision.accessRevision,
    operation: decision.operation,
    representation: decision.representation,
    objectKey: decision.objectKey,
    sha256: decision.sha256,
    byteSize: decision.byteSize,
    ...(decision.operation === "download"
      ? { originalFilename: decision.originalFilename }
      : {}),
  });
}

function isUploadPlan(result: AttachmentDatabaseOperationResult): result is AttachmentUploadAssemblyPlan {
  return "chunkCount" in result && "expectedSha256" in result && "format" in result;
}

function isAccessDecision(result: AttachmentDatabaseOperationResult): result is AttachmentAccessDecision {
  return "allowed" in result;
}

function isStatusResult(result: AttachmentDatabaseOperationResult): result is AttachmentStatusResult {
  return "attachment" in result && "sourceEligibility" in result;
}

function databaseProtocolFailure(): never {
  return fail({ status: 503, code: "storage_unavailable" });
}

export function createAttachmentAuthorityService(options: {
  readonly database: Pick<WorkerDatabaseClient, "executeAttachment">;
  readonly objectStore: AttachmentObjectStore;
  readonly processor: AttachmentProcessingQueuePort;
  readonly nowMs: () => number;
  readonly nextGrantId: () => string;
}): AttachmentAuthorityCommandPort {
  let closed = false;

  async function executeDatabase(
    operation: AttachmentDatabaseOperation,
  ): Promise<AttachmentDatabaseOperationResult> {
    if (closed) return fail({ status: 503, code: "storage_unavailable" });
    const now = options.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("Attachment authority service clock is invalid");
    }
    return options.database.executeAttachment(operation, now);
  }

  async function authorize(
    context: AttachmentHumanContext,
    command: AttachmentAccessCommand,
  ): Promise<AttachmentReadAuthorization> {
    const result = await executeDatabase({ kind: "access-authorize", context, command });
    if (!isAccessDecision(result)) return databaseProtocolFailure();
    if (!result.allowed) return denied(result);
    return authorization(result);
  }

  const grants = createAttachmentReadGrantRegistry({
    nowMs: options.nowMs,
    nextGrantId: options.nextGrantId,
    async reauthorize(context, current) {
      const human: AttachmentHumanContext = Object.freeze({
        kind: "human",
        sessionId: context.sessionId,
        sessionFamilyId: context.sessionFamilyId,
        principal: context.principal,
      });
      return authorize(human, current.operation === "download"
        ? { attachmentId: current.attachmentId, operation: "download" }
        : {
            attachmentId: current.attachmentId,
            operation: "preview",
            representation: current.representation,
          });
    },
    async readRange(objectKey, offset, maximumBytes) {
      try {
        return await options.objectStore.readAuthorizedRange(objectKey, offset, maximumBytes);
      } catch (error) {
        if (error instanceof AttachmentObjectStoreError) return mapStoreError(error);
        throw error;
      }
    },
  });

  const service: AttachmentAuthorityCommandPort = {
    async execute(context, frame) {
      if (closed) return fail({ status: 503, code: "storage_unavailable" });
      const human = humanContext(context);
      switch (frame.type) {
        case "attachment.upload.begin": {
          const result = await executeDatabase({
            kind: "upload-begin",
            context: human,
            command: {
              requestId: frame.requestId,
              roomId: frame.roomId,
              uploadKey: frame.uploadKey,
              originalFilename: frame.originalFilename,
              declaredMime: frame.declaredMime,
              expectedBytes: frame.expectedBytes,
              expectedSha256: frame.expectedSha256,
            },
          });
          if (!("uploadId" in result) || !("acknowledgedBytes" in result) ||
              !("status" in result) || result.status !== "open") return databaseProtocolFailure();
          return Object.freeze({
            type: "attachment.upload.begun",
            requestId: frame.requestId,
            uploadId: result.uploadId,
            acknowledgedBytes: result.acknowledgedBytes,
          });
        }
        case "attachment.upload.chunk": {
          const bytes = canonicalBytes(frame.base64, frame.chunkSha256);
          try {
            await options.objectStore.writeChunk({
              uploadId: frame.uploadId,
              ordinal: frame.ordinal,
              bytes,
              sha256: frame.chunkSha256,
            });
          } catch (error) {
            if (error instanceof AttachmentObjectStoreError) return mapStoreError(error);
            throw error;
          }
          const result = await executeDatabase({
            kind: "upload-chunk",
            context: human,
            command: {
              requestId: frame.requestId,
              uploadId: frame.uploadId,
              ordinal: frame.ordinal,
              offset: frame.offset,
              byteLength: frame.byteLength,
              chunkSha256: frame.chunkSha256,
              partObjectKey: partObjectKey(frame.uploadId, frame.ordinal, frame.chunkSha256),
            },
          });
          if (!("uploadId" in result) || !("acknowledgedBytes" in result) ||
              "status" in result) return databaseProtocolFailure();
          return Object.freeze({
            type: "attachment.upload.chunk.ack",
            requestId: frame.requestId,
            uploadId: result.uploadId,
            acknowledgedBytes: result.acknowledgedBytes,
          });
        }
        case "attachment.upload.finalize": {
          const plan = await executeDatabase({
            kind: "upload-plan",
            context: human,
            uploadId: frame.uploadId,
          });
          if (!isUploadPlan(plan)) return databaseProtocolFailure();
          try {
            await options.objectStore.assembleQuarantine({
              uploadId: plan.uploadId,
              attachmentId: plan.attachmentId,
              chunkCount: plan.chunkCount,
              expectedBytes: plan.expectedBytes,
              expectedSha256: plan.expectedSha256,
            });
            const result = await executeDatabase({
              kind: "upload-finalize",
              context: human,
              command: {
                requestId: frame.requestId,
                uploadId: frame.uploadId,
                storage: {
                  quarantineObjectKey: `quarantine_${plan.attachmentId}`,
                  byteSize: plan.expectedBytes,
                  sha256: plan.expectedSha256,
                  format: plan.format,
                  detectedMime: attachmentDetectedMime(plan.format),
                },
              },
            });
            if (!("attachmentId" in result) || !("generation" in result) ||
                !("status" in result) || result.status !== "accepted-quarantined") {
              return databaseProtocolFailure();
            }
            await options.processor.enqueue({
              attachmentId: result.attachmentId,
              generation: result.generation,
            });
            return Object.freeze({
              type: "attachment.upload.accepted",
              requestId: frame.requestId,
              attachmentId: result.attachmentId,
              processingStatus: "accepted-quarantined",
            });
          } catch (error) {
            if (error instanceof AttachmentObjectStoreError) return mapStoreError(error);
            throw error;
          }
        }
        case "attachment.upload.cancel": {
          await executeDatabase({
            kind: "upload-cancel",
            context: human,
            command: { requestId: frame.requestId, uploadId: frame.uploadId },
          });
          return Object.freeze({
            type: "attachment.upload.cancelled",
            requestId: frame.requestId,
            status: "cancelled",
          });
        }
        case "attachment.processing.retry": {
          const result = await executeDatabase({
            kind: "processing-retry",
            context: human,
            command: {
              requestId: frame.requestId,
              attachmentId: frame.attachmentId,
              expectedGeneration: frame.expectedGeneration,
            },
          });
          if (!("attachmentId" in result) || !("generation" in result) ||
              "status" in result) return databaseProtocolFailure();
          await options.processor.enqueue({
            attachmentId: result.attachmentId,
            generation: result.generation,
          });
          return Object.freeze({
            type: "attachment.status",
            requestId: frame.requestId,
            attachmentId: result.attachmentId,
            processingStatus: "accepted-quarantined",
            generation: result.generation,
          });
        }
        case "attachment.status.query": {
          const result = await executeDatabase({
            kind: "status-read",
            context: human,
            attachmentId: frame.attachmentId,
          });
          if (!isStatusResult(result)) return databaseProtocolFailure();
          return Object.freeze({
            type: "attachment.status",
            requestId: frame.requestId,
            attachmentId: result.attachment.attachmentId,
            processingStatus: result.attachment.processingStatus as AttachmentProcessingStatus,
            generation: result.attachment.generation,
          });
        }
        case "attachment.preview.open":
        case "attachment.download.open": {
          const current = await authorize(human, frame.type === "attachment.download.open"
            ? { attachmentId: frame.attachmentId, operation: "download" }
            : {
                attachmentId: frame.attachmentId,
                operation: "preview",
                representation: frame.representation,
              });
          const opened = grants.open(readContext(context), current);
          return frame.type === "attachment.download.open"
            ? Object.freeze({
                type: "attachment.download.opened",
                requestId: frame.requestId,
                streamId: opened.streamId,
                byteSize: opened.byteSize,
                originalFilename: opened.originalFilename ?? databaseProtocolFailure(),
              })
            : Object.freeze({
                type: "attachment.preview.opened",
                requestId: frame.requestId,
                streamId: opened.streamId,
                byteSize: opened.byteSize,
              });
        }
        case "attachment.stream.read": {
          const chunk = await grants.read(
            readContext(context), frame.streamId, frame.offset, frame.maximumBytes,
          );
          return Object.freeze({
            type: "attachment.stream.chunk",
            requestId: frame.requestId,
            streamId: chunk.streamId,
            offset: chunk.offset,
            byteLength: chunk.byteSize,
            base64: Buffer.from(chunk.bytes).toString("base64"),
            eof: chunk.eof,
          });
        }
      }
    },
    invalidateFamily(sessionFamilyId) {
      grants.invalidateFamily(sessionFamilyId);
    },
    close() {
      if (closed) return;
      closed = true;
      grants.close();
    },
  };
  return Object.freeze(service);
}
