import type { AttachmentAuthorityController } from "./controller.js";
import { isAttachmentError, type AttachmentError } from "@native-im/core";
import {
  ATTACHMENT_AUTHORITY_IPC_CHANNELS,
  cloneAttachmentAuthorityBridgeInput,
  cloneAttachmentDownloadResult,
  cloneAttachmentOperationReceipt,
  cloneAttachmentPreviewPolicy,
  cloneAttachmentSelectResult,
  cloneAttachmentStatusResult,
  isAttachmentCancelIntent,
  isAttachmentDownloadIntent,
  isAttachmentPreviewIntent,
  isAttachmentRemoveSelectionIntent,
  isAttachmentRetryIntent,
  isAttachmentStatusQuery,
  isAttachmentUploadIntent,
} from "./contracts.js";

interface AttachmentAuthorityIpcEvent {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface AttachmentAuthorityIpcMain {
  handle(channel: string, handler: (event: AttachmentAuthorityIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface AttachmentAuthorityIpcWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, input: unknown): void;
}

function trust(event: AttachmentAuthorityIpcEvent, webContents: AttachmentAuthorityIpcWebContents): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new TypeError("Attachment Authority IPC requires the trusted main frame");
  }
}

function publicError(error: unknown): AttachmentError {
  if (typeof error === "object" && error !== null) {
    const candidate = "error" in error ? error.error :
      "attachmentError" in error ? error.attachmentError : error;
    if (isAttachmentError(candidate)) return candidate;
  }
  return { status: 503, code: "storage_unavailable" };
}

export class AttachmentAuthorityIpcError extends Error {
  readonly attachmentError: AttachmentError;
  constructor(error: AttachmentError) {
    super(`Attachment Authority failed: ${error.status} ${error.code}`);
    this.name = "AttachmentAuthorityIpcError";
    this.attachmentError = structuredClone(error);
  }
}

function sanitize(error: unknown): never {
  throw new AttachmentAuthorityIpcError(publicError(error));
}

export function registerAttachmentAuthorityIpc(options: {
  readonly ipcMain: AttachmentAuthorityIpcMain;
  readonly webContents: AttachmentAuthorityIpcWebContents;
  readonly controller: Pick<AttachmentAuthorityController,
    "select" | "upload" | "cancel" | "retryProcessing" | "status" | "preview" |
    "download" | "removeSelection" | "subscribe">;
}): () => void {
  const { ipcMain, webContents, controller } = options;
  ipcMain.handle(ATTACHMENT_AUTHORITY_IPC_CHANNELS.select, async (event, ...args) => {
    trust(event, webContents);
    if (args.length !== 0) throw new TypeError("Invalid Attachment Authority select request");
    try { return cloneAttachmentSelectResult(await controller.select()); } catch (error) { sanitize(error); }
  });
  ipcMain.handle(ATTACHMENT_AUTHORITY_IPC_CHANNELS.upload, (event, ...args) => {
    trust(event, webContents);
    if (args.length !== 1 || !isAttachmentUploadIntent(args[0])) {
      throw new TypeError("Invalid Attachment Authority upload intent");
    }
    try { return cloneAttachmentOperationReceipt(controller.upload(args[0])); } catch (error) { sanitize(error); }
  });
  ipcMain.handle(ATTACHMENT_AUTHORITY_IPC_CHANNELS.cancel, async (event, ...args) => {
    trust(event, webContents);
    if (args.length !== 1 || !isAttachmentCancelIntent(args[0])) {
      throw new TypeError("Invalid Attachment Authority cancel intent");
    }
    try { return cloneAttachmentOperationReceipt(await controller.cancel(args[0])); } catch (error) { sanitize(error); }
  });
  ipcMain.handle(ATTACHMENT_AUTHORITY_IPC_CHANNELS.retryProcessing, (event, ...args) => {
    trust(event, webContents);
    if (args.length !== 1 || !isAttachmentRetryIntent(args[0])) {
      throw new TypeError("Invalid Attachment Authority retry intent");
    }
    try { return cloneAttachmentOperationReceipt(controller.retryProcessing(args[0])); } catch (error) { sanitize(error); }
  });
  ipcMain.handle(ATTACHMENT_AUTHORITY_IPC_CHANNELS.status, async (event, ...args) => {
    trust(event, webContents);
    if (args.length !== 1 || !isAttachmentStatusQuery(args[0])) {
      throw new TypeError("Invalid Attachment Authority status query");
    }
    try { return cloneAttachmentStatusResult(await controller.status(args[0])); } catch (error) { sanitize(error); }
  });
  ipcMain.handle(ATTACHMENT_AUTHORITY_IPC_CHANNELS.preview, async (event, ...args) => {
    trust(event, webContents);
    if (args.length !== 1 || !isAttachmentPreviewIntent(args[0])) {
      throw new TypeError("Invalid Attachment Authority preview intent");
    }
    try { return cloneAttachmentPreviewPolicy(await controller.preview(args[0])); } catch (error) { sanitize(error); }
  });
  ipcMain.handle(ATTACHMENT_AUTHORITY_IPC_CHANNELS.download, async (event, ...args) => {
    trust(event, webContents);
    if (args.length !== 1 || !isAttachmentDownloadIntent(args[0])) {
      throw new TypeError("Invalid Attachment Authority download intent");
    }
    try { return cloneAttachmentDownloadResult(await controller.download(args[0])); } catch (error) { sanitize(error); }
  });
  ipcMain.handle(ATTACHMENT_AUTHORITY_IPC_CHANNELS.removeSelection, async (event, ...args) => {
    trust(event, webContents);
    if (args.length !== 1 || !isAttachmentRemoveSelectionIntent(args[0])) {
      throw new TypeError("Invalid Attachment Authority remove-selection intent");
    }
    try { await controller.removeSelection(args[0]); } catch (error) { sanitize(error); }
  });

  const unsubscribe = controller.subscribe((input) => {
    if (!webContents.isDestroyed()) {
      webContents.send(
        ATTACHMENT_AUTHORITY_IPC_CHANNELS.authorityInput,
        cloneAttachmentAuthorityBridgeInput(input),
      );
    }
  });
  const channels = [
    ATTACHMENT_AUTHORITY_IPC_CHANNELS.select,
    ATTACHMENT_AUTHORITY_IPC_CHANNELS.upload,
    ATTACHMENT_AUTHORITY_IPC_CHANNELS.cancel,
    ATTACHMENT_AUTHORITY_IPC_CHANNELS.retryProcessing,
    ATTACHMENT_AUTHORITY_IPC_CHANNELS.status,
    ATTACHMENT_AUTHORITY_IPC_CHANNELS.preview,
    ATTACHMENT_AUTHORITY_IPC_CHANNELS.download,
    ATTACHMENT_AUTHORITY_IPC_CHANNELS.removeSelection,
  ] as const;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
