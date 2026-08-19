import { createHash, randomUUID } from "node:crypto";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  isAttachmentError,
  type AttachmentError,
} from "@native-im/core";
import type {
  AttachmentAuthorityBridgeInput,
  AttachmentCancelIntent,
  AttachmentDownloadIntent,
  AttachmentDownloadResult,
  AttachmentOperationReceipt,
  AttachmentPreviewIntent,
  AttachmentPreviewPolicy,
  AttachmentRemoveSelectionIntent,
  AttachmentRetryIntent,
  AttachmentSelectResult,
  AttachmentStatusQuery,
  AttachmentStatusResult,
  AttachmentUploadIntent,
} from "./contracts.js";
import type {
  NativeFileStat,
  NativeSelectionRegistry,
  PrivateAttachmentSelection,
} from "./native-file-selection.js";
import type { PreviewDownloadService } from "./preview-download.js";

export interface AttachmentAuthorityClientPort {
  beginUpload(input: Readonly<{
    requestId: string;
    roomId: string;
    uploadKey: string;
    originalFilename: string;
    format: PrivateAttachmentSelection["format"];
    declaredMime: PrivateAttachmentSelection["declaredMime"];
    byteSize: number;
    sha256: string;
  }>): Promise<Readonly<{ uploadId: string; acknowledgedBytes: number }>>;
  uploadChunk(input: Readonly<{
    requestId: string;
    uploadId: string;
    offset: number;
    bytes: Uint8Array;
  }>): Promise<Readonly<{ uploadId: string; acknowledgedBytes: number }>>;
  finalizeUpload(input: Readonly<{
    requestId: string;
    uploadId: string;
  }>): Promise<Readonly<{
    attachmentId: string;
    processingStatus: "accepted-quarantined";
  }>>;
  cancelUpload(input: Readonly<{ requestId: string; uploadId: string }>): Promise<Readonly<{ status: "cancelled" }>>;
  retryProcessing(input: Readonly<{
    requestId: string;
    attachmentId: string;
    expectedGeneration: number;
  }>): Promise<AttachmentStatusResult>;
  getStatus(input: Readonly<{ requestId: string; attachmentId: string }>): Promise<AttachmentStatusResult>;
  subscribeStatus?(listener: (status: AttachmentStatusResult) => void): () => void;
  close(): void;
}

type ActiveUpload = {
  readonly operationId: string;
  readonly selectionHandle: string;
  readonly abort: AbortController;
  phase: "hashing" | "beginning" | "uploading" | "finalizing";
  readonly beginSettled: Promise<void>;
  readonly settleBegin: () => void;
  uploadId?: string;
};

function fileStillMatches(selection: PrivateAttachmentSelection, actual: NativeFileStat): boolean {
  const expected = selection.expectedStat;
  return actual.kind === "regular-file" && actual.byteSize === expected.byteSize &&
    actual.modifiedAtMs === expected.modifiedAtMs && actual.device === expected.device &&
    actual.inode === expected.inode;
}

function changedFileError(): Error {
  return Object.assign(new Error("Selected attachment changed while being read"), {
    attachmentError: { status: 409, code: "idempotency_conflict" } satisfies AttachmentError,
  });
}

function publicError(error: unknown): AttachmentError {
  if (error && typeof error === "object") {
    const candidate = "error" in error ? error.error :
      "attachmentError" in error ? error.attachmentError : error;
    if (isAttachmentError(candidate)) return structuredClone(candidate);
  }
  return { status: 503, code: "storage_unavailable" };
}

async function digestSelection(
  selections: NativeSelectionRegistry,
  selectionHandle: string,
  abort: AbortSignal,
): Promise<string> {
  const selection = selections.getPrivateSelection(selectionHandle);
  const reader = await selections.openForRead(selectionHandle);
  const digest = createHash("sha256");
  let offset = 0;
  try {
    while (offset < selection.byteSize) {
      if (abort.aborted) throw new Error("cancelled");
      const maximum = Math.min(ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes, selection.byteSize - offset);
      const bytes = await reader.read(offset, maximum);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximum) {
        throw new TypeError("Invalid bounded native file read");
      }
      digest.update(bytes);
      offset += bytes.byteLength;
    }
    if (!fileStillMatches(selection, await reader.stat())) throw changedFileError();
    return digest.digest("hex");
  } finally {
    await reader.close().catch(() => undefined);
  }
}

export interface AttachmentAuthorityController {
  select(): Promise<AttachmentSelectResult>;
  upload(intent: AttachmentUploadIntent): AttachmentOperationReceipt;
  cancel(intent: AttachmentCancelIntent): Promise<AttachmentOperationReceipt>;
  retryProcessing(intent: AttachmentRetryIntent): AttachmentOperationReceipt;
  status(query: AttachmentStatusQuery): Promise<AttachmentStatusResult>;
  preview(intent: AttachmentPreviewIntent): Promise<AttachmentPreviewPolicy>;
  download(intent: AttachmentDownloadIntent): Promise<AttachmentDownloadResult>;
  removeSelection(intent: AttachmentRemoveSelectionIntent): Promise<void>;
  subscribe(listener: (input: AttachmentAuthorityBridgeInput) => void): () => void;
  invalidateAuthorizedState(reason: "session_revoked" | "membership_revoked" | "terminal_auth_failure"): void;
  close(): void;
}

export function createAttachmentAuthorityController(options: {
  readonly selections: NativeSelectionRegistry;
  readonly authority: AttachmentAuthorityClientPort;
  readonly previews?: PreviewDownloadService;
  readonly requestId?: () => string;
}): AttachmentAuthorityController {
  const requestId = options.requestId ?? randomUUID;
  const listeners = new Set<(input: AttachmentAuthorityBridgeInput) => void>();
  const uploads = new Map<string, ActiveUpload>();
  const acceptedUploads = new Map<string, Readonly<{ uploadId: string; attachmentId: string }>>();
  let closed = false;
  let authorized = true;
  const stopStatus = options.authority.subscribeStatus?.((status) => observeStatus(status));

  function publish(input: AttachmentAuthorityBridgeInput): void {
    if (closed) return;
    for (const listener of [...listeners]) {
      try { listener(structuredClone(input)); } catch { /* renderer observer is isolated */ }
    }
  }

  function cleanupStatus(status: AttachmentStatusResult): void {
    if (status.attachment.processingStatus === "ready" ||
      status.attachment.processingStatus === "nonretryable-failed" ||
      status.attachment.processingStatus === "malware-rejected" ||
      status.attachment.processingStatus === "cancelled") {
      for (const [operationId, accepted] of acceptedUploads) {
        if (accepted.attachmentId === status.attachment.attachmentId) acceptedUploads.delete(operationId);
      }
    }
  }

  function observeStatus(status: AttachmentStatusResult): void {
    cleanupStatus(status);
    publish(status);
  }

  function assertOpen(): void {
    if (closed || !authorized) throw new Error("Attachment Authority controller is closed");
  }

  async function runUpload(active: ActiveUpload, intent: AttachmentUploadIntent): Promise<void> {
    try {
      const selection = options.selections.getPrivateSelection(intent.selectionHandle);
      const sha256 = await digestSelection(options.selections, intent.selectionHandle, active.abort.signal);
      if (active.abort.signal.aborted) return;
      active.phase = "beginning";
      let begun: Awaited<ReturnType<AttachmentAuthorityClientPort["beginUpload"]>>;
      try {
        begun = await options.authority.beginUpload({
          requestId: requestId(),
          roomId: intent.roomId,
          uploadKey: selection.uploadKey,
          originalFilename: selection.displayName,
          format: selection.format,
          declaredMime: selection.declaredMime,
          byteSize: selection.byteSize,
          sha256,
        });
        active.uploadId = begun.uploadId;
      } finally {
        active.settleBegin();
      }
      if (!Number.isSafeInteger(begun.acknowledgedBytes) || begun.acknowledgedBytes < 0 ||
        begun.acknowledgedBytes > selection.byteSize) {
        throw new TypeError("Invalid Attachment Authority begin ACK");
      }
      if (active.abort.signal.aborted) return;
      active.phase = "uploading";
      let offset = begun.acknowledgedBytes;
      const reader = await options.selections.openForRead(intent.selectionHandle);
      try {
        while (offset < selection.byteSize) {
          if (active.abort.signal.aborted) return;
          const maximum = Math.min(ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes, selection.byteSize - offset);
          const bytes = await reader.read(offset, maximum);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximum) {
            throw new TypeError("Invalid bounded native file read");
          }
          const acknowledged = await options.authority.uploadChunk({
            requestId: requestId(), uploadId: begun.uploadId, offset, bytes: Uint8Array.from(bytes),
          });
          if (active.abort.signal.aborted) return;
          const expected = offset + bytes.byteLength;
          if (acknowledged.uploadId !== begun.uploadId || acknowledged.acknowledgedBytes !== expected) {
            throw Object.assign(new Error("Upload offset conflict"), {
              attachmentError: { status: 409, code: "upload_offset_conflict" } satisfies AttachmentError,
            });
          }
          // Local bytes read is not progress. Only the matching server ACK advances it.
          offset = acknowledged.acknowledgedBytes;
          publish({
            type: "attachment.upload.progress",
            operationId: active.operationId,
            acknowledgedBytes: offset,
            totalBytes: selection.byteSize,
          });
        }
        if (!fileStillMatches(selection, await reader.stat())) throw changedFileError();
      } finally {
        await reader.close().catch(() => undefined);
      }
      if (active.abort.signal.aborted) return;
      active.phase = "finalizing";
      const finalized = await options.authority.finalizeUpload({ requestId: requestId(), uploadId: begun.uploadId });
      if (active.abort.signal.aborted) return;
      publish({
        type: "attachment.upload.accepted",
        operationId: active.operationId,
        attachmentId: finalized.attachmentId,
        processingStatus: finalized.processingStatus,
      });
      acceptedUploads.set(active.operationId, {
        uploadId: begun.uploadId,
        attachmentId: finalized.attachmentId,
      });
      await options.selections.remove(intent.selectionHandle);
    } catch (error) {
      if (!active.abort.signal.aborted) {
        publish({ type: "attachment.operation.error", operationId: active.operationId, error: publicError(error) });
      }
    } finally {
      uploads.delete(active.operationId);
    }
  }

  function requirePreviewService(): PreviewDownloadService {
    if (!options.previews) throw Object.assign(new Error("Attachment preview/download dependency unavailable"), {
      attachmentError: { status: 503, code: "storage_unavailable" } satisfies AttachmentError,
    });
    return options.previews;
  }

  const controller: AttachmentAuthorityController = {
    select() { assertOpen(); return options.selections.select(); },
    upload(intent) {
      assertOpen();
      if (uploads.size >= 1 || acceptedUploads.size >= 16) {
        throw Object.assign(new Error("Attachment upload capacity limited"), {
          attachmentError: {
            status: 429, code: "attachment_capacity_limited", retryAfterSeconds: 1,
          } satisfies AttachmentError,
        });
      }
      options.selections.getPrivateSelection(intent.selectionHandle);
      const operationId = requestId();
      let settleBegin!: () => void;
      const beginSettled = new Promise<void>((resolve) => { settleBegin = resolve; });
      const active: ActiveUpload = {
        operationId, selectionHandle: intent.selectionHandle, abort: new AbortController(),
        phase: "hashing", beginSettled, settleBegin,
      };
      uploads.set(operationId, active);
      void runUpload(active, intent);
      return Object.freeze({ operationId });
    },
    async cancel(intent) {
      assertOpen();
      const active = uploads.get(intent.operationId);
      const acceptedUpload = acceptedUploads.get(intent.operationId);
      if (!active && !acceptedUpload) {
        throw Object.assign(new Error("Attachment operation is gone"), {
          attachmentError: { status: 410, code: "upload_expired" } satisfies AttachmentError,
        });
      }
      let uploadId = acceptedUpload?.uploadId;
      if (active) {
        active.abort.abort();
        await options.selections.remove(active.selectionHandle);
        if (active.phase === "beginning") await active.beginSettled;
        uploadId = active.uploadId;
      }
      if (uploadId) {
        const result = await options.authority.cancelUpload({ requestId: requestId(), uploadId });
        if (result.status !== "cancelled") throw new TypeError("Invalid Attachment Authority cancel ACK");
      }
      uploads.delete(intent.operationId);
      acceptedUploads.delete(intent.operationId);
      publish({ type: "attachment.operation.cancelled", operationId: intent.operationId });
      return Object.freeze({ operationId: intent.operationId });
    },
    retryProcessing(intent) {
      assertOpen();
      const operationId = requestId();
      void options.authority.retryProcessing({
        requestId: requestId(),
        attachmentId: intent.attachmentId,
        expectedGeneration: intent.expectedGeneration,
      })
        .then((result) => publish(result))
        .catch((error) => publish({ type: "attachment.operation.error", operationId, error: publicError(error) }));
      return Object.freeze({ operationId });
    },
    status(query) {
      assertOpen();
      return options.authority.getStatus({ requestId: requestId(), attachmentId: query.attachmentId })
        .then((result) => {
          cleanupStatus(result);
          return result;
        });
    },
    preview(intent) { assertOpen(); return requirePreviewService().preview(intent); },
    download(intent) { assertOpen(); return requirePreviewService().download(intent); },
    removeSelection(intent) { assertOpen(); return options.selections.remove(intent.selectionHandle); },
    subscribe(listener) {
      assertOpen();
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    invalidateAuthorizedState(reason) {
      if (closed || !authorized) return;
      authorized = false;
      for (const active of uploads.values()) active.abort.abort();
      uploads.clear();
      acceptedUploads.clear();
      void options.selections.invalidate();
      void options.previews?.invalidateAuthorizedState();
      stopStatus?.();
      options.authority.close();
      publish({ type: "attachment.authority.revoked", reason });
    },
    close() {
      if (closed) return;
      for (const active of uploads.values()) active.abort.abort();
      uploads.clear();
      acceptedUploads.clear();
      listeners.clear();
      closed = true;
      void options.selections.invalidate();
      void options.previews?.invalidateAuthorizedState();
      stopStatus?.();
      options.authority.close();
    },
  };
  return Object.freeze(controller);
}
