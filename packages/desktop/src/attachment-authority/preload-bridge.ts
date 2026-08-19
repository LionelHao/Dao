import {
  ATTACHMENT_AUTHORITY_IPC_CHANNELS,
  cloneAttachmentAuthorityBridgeInput,
  cloneAttachmentDownloadResult,
  cloneAttachmentOperationReceipt,
  cloneAttachmentPreviewPolicy,
  cloneAttachmentSelectResult,
  cloneAttachmentStatusResult,
  isAttachmentAuthorityBridgeInput,
  isAttachmentCancelIntent,
  isAttachmentDownloadIntent,
  isAttachmentPreviewIntent,
  isAttachmentRemoveSelectionIntent,
  isAttachmentRetryIntent,
  isAttachmentStatusQuery,
  isAttachmentUploadIntent,
  type AttachmentAuthorityBridge,
  type AttachmentAuthorityBridgeInput,
  type AttachmentCancelIntent,
  type AttachmentDownloadIntent,
  type AttachmentPreviewIntent,
  type AttachmentRemoveSelectionIntent,
  type AttachmentRetryIntent,
  type AttachmentStatusQuery,
  type AttachmentUploadIntent,
} from "./contracts.js";

type Listener = (event: unknown, input: unknown) => void;

export interface AttachmentAuthorityIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
}

export function createAttachmentAuthorityBridge(ipc: AttachmentAuthorityIpcRenderer): AttachmentAuthorityBridge {
  return Object.freeze({
    async select() {
      return cloneAttachmentSelectResult(await ipc.invoke(ATTACHMENT_AUTHORITY_IPC_CHANNELS.select));
    },
    async upload(intent: AttachmentUploadIntent) {
      if (!isAttachmentUploadIntent(intent)) throw new TypeError("Invalid Attachment Authority upload intent");
      return cloneAttachmentOperationReceipt(await ipc.invoke(ATTACHMENT_AUTHORITY_IPC_CHANNELS.upload, intent));
    },
    async cancel(intent: AttachmentCancelIntent) {
      if (!isAttachmentCancelIntent(intent)) throw new TypeError("Invalid Attachment Authority cancel intent");
      return cloneAttachmentOperationReceipt(await ipc.invoke(ATTACHMENT_AUTHORITY_IPC_CHANNELS.cancel, intent));
    },
    async retryProcessing(intent: AttachmentRetryIntent) {
      if (!isAttachmentRetryIntent(intent)) throw new TypeError("Invalid Attachment Authority retry intent");
      return cloneAttachmentOperationReceipt(await ipc.invoke(ATTACHMENT_AUTHORITY_IPC_CHANNELS.retryProcessing, intent));
    },
    async status(query: AttachmentStatusQuery) {
      if (!isAttachmentStatusQuery(query)) throw new TypeError("Invalid Attachment Authority status query");
      return cloneAttachmentStatusResult(await ipc.invoke(ATTACHMENT_AUTHORITY_IPC_CHANNELS.status, query));
    },
    async preview(intent: AttachmentPreviewIntent) {
      if (!isAttachmentPreviewIntent(intent)) throw new TypeError("Invalid Attachment Authority preview intent");
      return cloneAttachmentPreviewPolicy(await ipc.invoke(ATTACHMENT_AUTHORITY_IPC_CHANNELS.preview, intent));
    },
    async download(intent: AttachmentDownloadIntent) {
      if (!isAttachmentDownloadIntent(intent)) throw new TypeError("Invalid Attachment Authority download intent");
      return cloneAttachmentDownloadResult(await ipc.invoke(ATTACHMENT_AUTHORITY_IPC_CHANNELS.download, intent));
    },
    async removeSelection(intent: AttachmentRemoveSelectionIntent) {
      if (!isAttachmentRemoveSelectionIntent(intent)) {
        throw new TypeError("Invalid Attachment Authority remove-selection intent");
      }
      const result = await ipc.invoke(ATTACHMENT_AUTHORITY_IPC_CHANNELS.removeSelection, intent);
      if (result !== undefined) throw new TypeError("Invalid Attachment Authority remove-selection result");
    },
    onAuthorityInput(listener: (input: AttachmentAuthorityBridgeInput) => void) {
      if (typeof listener !== "function") throw new TypeError("Invalid Attachment Authority listener");
      const wrapped: Listener = (_event, input) => {
        if (isAttachmentAuthorityBridgeInput(input)) listener(cloneAttachmentAuthorityBridgeInput(input));
      };
      ipc.on(ATTACHMENT_AUTHORITY_IPC_CHANNELS.authorityInput, wrapped);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        ipc.removeListener(ATTACHMENT_AUTHORITY_IPC_CHANNELS.authorityInput, wrapped);
      };
    },
  });
}
