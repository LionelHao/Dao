import { ATTACHMENT_AUTHORITY_LIMITS } from "@native-im/core";
import type {
  AttachmentDownloadIntent,
  AttachmentDownloadResult,
  AttachmentPreviewIntent,
  AttachmentPreviewPolicy,
} from "./contracts.js";

export type AttachmentReadGrant = Readonly<{
  grantId: string;
  byteSize: number;
  displayName?: string;
}>;

export interface AttachmentContentAuthorityPort {
  authorizePreview(input: Readonly<{
    attachmentId: string;
    representation: "safe-rendered" | "extracted-text";
  }>): Promise<AttachmentReadGrant>;
  authorizeDownload(input: Readonly<{ attachmentId: string }>): Promise<AttachmentReadGrant>;
  readGrant(grantId: string, offset: number, maximumBytes: number): Promise<Uint8Array>;
}

export interface SandboxedPreviewHostPort {
  openSandboxed(input: Readonly<{
    policy: AttachmentPreviewPolicy;
    byteSize: number;
    read(offset: number, maximumBytes: number): Promise<Uint8Array>;
  }>): Promise<void>;
  closeAll(): void;
}

export interface NativeSaveDialogPort {
  chooseDestination(suggestedName: string): Promise<string | undefined>;
}

export interface NativeTemporaryFile {
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface NativeAtomicSaveFileSystemPort {
  openTemporary(temporaryPath: string): Promise<NativeTemporaryFile>;
  rename(temporaryPath: string, destinationPath: string): Promise<void>;
  remove(temporaryPath: string): Promise<void>;
}

function policy(intent: AttachmentPreviewIntent): AttachmentPreviewPolicy {
  return Object.freeze({
    type: "attachment.preview.policy",
    attachmentId: intent.attachmentId,
    representation: intent.representation,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowNavigation: false,
    allowWindowOpen: false,
    allowPermissions: false,
    allowExternalProtocols: false,
    allowNetwork: false,
    ariaLive: "off",
  });
}

function validateGrant(grant: AttachmentReadGrant): void {
  if (!grant || typeof grant.grantId !== "string" || grant.grantId.length === 0 ||
    !Number.isSafeInteger(grant.byteSize) || grant.byteSize < 0 ||
    grant.byteSize > ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes) {
    throw new TypeError("Invalid bounded Attachment Authority grant");
  }
}

function validateChunk(chunk: Uint8Array, remaining: number, maximum: number): void {
  if (!(chunk instanceof Uint8Array) || (remaining > 0 && chunk.byteLength === 0) ||
    chunk.byteLength > maximum || chunk.byteLength > remaining) {
    throw new TypeError("Invalid bounded Attachment Authority byte chunk");
  }
}

export interface PreviewDownloadService {
  preview(intent: AttachmentPreviewIntent): Promise<AttachmentPreviewPolicy>;
  download(intent: AttachmentDownloadIntent): Promise<AttachmentDownloadResult>;
  invalidateAuthorizedState(): Promise<void>;
}

export function createPreviewDownloadService(options: {
  readonly authority: AttachmentContentAuthorityPort;
  readonly previewHost: SandboxedPreviewHostPort;
  readonly saveDialog: NativeSaveDialogPort;
  readonly fs: NativeAtomicSaveFileSystemPort;
  readonly randomId: () => string;
}): PreviewDownloadService {
  let epoch = 0;
  const active = new Set<AbortController>();

  function operation(): Readonly<{ abort: AbortController; epoch: number }> {
    const abort = new AbortController();
    active.add(abort);
    return { abort, epoch };
  }

  function assertActive(run: Readonly<{ abort: AbortController; epoch: number }>): void {
    if (run.abort.signal.aborted || run.epoch !== epoch) {
      throw new Error("Attachment Authority operation revoked");
    }
  }

  async function read(
    grant: AttachmentReadGrant,
    offset: number,
    maximumBytes: number,
    run: Readonly<{ abort: AbortController; epoch: number }>,
  ): Promise<Uint8Array> {
    assertActive(run);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > grant.byteSize ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 ||
      maximumBytes > ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes) {
      throw new TypeError("Invalid sandbox preview read");
    }
    const maximum = Math.min(maximumBytes, grant.byteSize - offset);
    if (maximum === 0) return new Uint8Array();
    const chunk = await options.authority.readGrant(grant.grantId, offset, maximum);
    assertActive(run);
    validateChunk(chunk, grant.byteSize - offset, maximum);
    return Uint8Array.from(chunk);
  }

  const service: PreviewDownloadService = {
    async preview(intent) {
      const run = operation();
      try {
        // This authorization intentionally occurs on every open, including repeated opens.
        const grant = await options.authority.authorizePreview({
          attachmentId: intent.attachmentId,
          representation: intent.representation,
        });
        assertActive(run);
        validateGrant(grant);
        const previewPolicy = policy(intent);
        await options.previewHost.openSandboxed({
          policy: previewPolicy,
          byteSize: grant.byteSize,
          read: (offset, maximumBytes) => read(grant, offset, maximumBytes, run),
        });
        assertActive(run);
        return previewPolicy;
      } finally {
        active.delete(run.abort);
      }
    },
    async download(intent) {
      const run = operation();
      let temporaryPath: string | undefined;
      let file: NativeTemporaryFile | undefined;
      try {
        // Permission is checked before exposing a native save prompt or touching disk.
        const grant = await options.authority.authorizeDownload({ attachmentId: intent.attachmentId });
        assertActive(run);
        validateGrant(grant);
        if (!grant.displayName || /[\\/]/u.test(grant.displayName)) {
          throw new TypeError("Invalid authorized download filename");
        }
        const destinationPath = await options.saveDialog.chooseDestination(grant.displayName);
        assertActive(run);
        if (destinationPath === undefined) {
          return Object.freeze({
            type: "attachment.download.cancelled" as const,
            attachmentId: intent.attachmentId,
          });
        }
        if (typeof destinationPath !== "string" || destinationPath.length === 0) {
          throw new TypeError("Invalid native save destination");
        }
        temporaryPath = `${destinationPath}.part-${options.randomId()}`;
        file = await options.fs.openTemporary(temporaryPath);
        let offset = 0;
        while (offset < grant.byteSize) {
          const chunk = await read(
            grant,
            offset,
            Math.min(ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes, grant.byteSize - offset),
            run,
          );
          if (chunk.byteLength === 0) throw new Error("Attachment download ended before authorized size");
          await file.write(chunk);
          offset += chunk.byteLength;
          assertActive(run);
        }
        await file.sync();
        assertActive(run);
        await file.close();
        file = undefined;
        assertActive(run);
        await options.fs.rename(temporaryPath, destinationPath);
        temporaryPath = undefined;
        return Object.freeze({
          type: "attachment.download.saved" as const,
          attachmentId: intent.attachmentId,
        });
      } catch (error) {
        if (file) await file.close().catch(() => undefined);
        if (temporaryPath) await options.fs.remove(temporaryPath).catch(() => undefined);
        throw error;
      } finally {
        active.delete(run.abort);
      }
    },
    async invalidateAuthorizedState() {
      epoch += 1;
      for (const operation of active) operation.abort();
      options.previewHost.closeAll();
    },
  };
  return Object.freeze(service);
}
