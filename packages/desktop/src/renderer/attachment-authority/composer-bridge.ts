import type {
  AttachmentAuthorityBridge,
  AttachmentAuthorityBridgeInput,
  AttachmentSelection,
} from "../../attachment-authority/contracts.js";
import type {
  AttachmentError,
  AttachmentMetadata,
  AttachmentProcessingStatus,
} from "@native-im/core";

import { renderAttachmentAuthoritySurface } from "./surface.js";
import {
  createAttachmentAuthorityViewModel,
  mapAttachmentMetadataForView,
  type AccessProjectionAxis,
  type AttachmentAuthorityInput,
  type DurableAttachmentAxis,
  type LocalTransportAxis,
} from "./view-model.js";

export interface AttachmentComposerBridgeOptions {
  readonly accessProjection: () => AccessProjectionAxis;
  readonly onReadyAttachmentIdsChange: (attachmentIds: readonly string[]) => void;
  readonly onSubmissionBlockedChange?: (blocked: boolean) => void;
  readonly onBindRequested?: () => void;
  readonly onAnnouncement?: (message: string) => void;
  readonly reducedMotion?: boolean;
}

export interface AttachmentComposerBridgeController {
  select(): Promise<void>;
  remount(root: HTMLElement): void;
  clearBound(attachmentIds: readonly string[]): void;
  dispose(): void;
}

type ComposerAttachment = {
  selection?: AttachmentSelection;
  operationId?: string;
  retryOperationId?: string;
  attachmentId?: string;
  generation?: number;
  metadata?: AttachmentMetadata;
  localTransport: LocalTransportAxis;
  durable: DurableAttachmentAxis;
  closedError?: AttachmentError;
  revoked: boolean;
};

function durableStatus(
  status: AttachmentProcessingStatus,
  error: AttachmentError | undefined,
): DurableAttachmentAxis {
  switch (status) {
    case "accepted-quarantined":
      return { status, authoritySource: "stable-event" };
    case "processing":
      return { status, phase: "scanning", authoritySource: "stable-event" };
    case "ready":
      return { status, authoritySource: "stable-event" };
    case "retryable-failed":
      return error !== undefined && (error.status === 401 || error.status === 409 ||
          error.status === 429 || error.status === 503)
        ? { status, authoritySource: "stable-event", error }
        : { status, authoritySource: "stable-event" };
    case "nonretryable-failed":
      return error !== undefined && (error.status === 400 || error.status === 410 || error.status === 413 ||
          error.status === 415 || error.status === 422)
        ? { status, authoritySource: "stable-event", error }
        : { status, authoritySource: "stable-event" };
    case "malware-rejected":
      return { status, authoritySource: "stable-event" };
    case "cancelled":
      return { status, authoritySource: "stable-event" };
  }
}

function inputFor(
  item: ComposerAttachment,
  options: AttachmentComposerBridgeOptions,
): AttachmentAuthorityInput {
  const value: AttachmentAuthorityInput = {
    localTransport: item.localTransport,
    durable: item.durable,
    sourceEligibility: "unbound",
    accessProjection: item.revoked ? "permission-revoked" : options.accessProjection(),
    ...(item.revoked ? {} : item.metadata !== undefined ? {
      metadata: mapAttachmentMetadataForView(item.metadata),
    } : item.selection !== undefined ? {
      metadata: {
        displayName: item.selection.displayName,
        byteSize: item.selection.byteSize,
        mediaType: item.selection.declaredMime,
        format: item.selection.format,
      },
    } : {}),
    allowCancel: item.operationId !== undefined,
    ...(item.closedError === undefined ? {} : { closedError: item.closedError }),
    reducedMotion: options.reducedMotion ?? false,
  };
  return value;
}

export function mountAttachmentComposerBridge(
  initialRoot: HTMLElement,
  bridge: AttachmentAuthorityBridge,
  roomId: string,
  options: AttachmentComposerBridgeOptions,
): AttachmentComposerBridgeController {
  let root = initialRoot;
  let disposed = false;
  let item: ComposerAttachment | undefined;
  let uploadStarting = false;
  const queuedInputs: AttachmentAuthorityBridgeInput[] = [];

  const readyIds = (): readonly string[] => item?.attachmentId !== undefined &&
      item.durable.status === "ready" && !item.revoked
    ? [item.attachmentId]
    : [];

  const publishProjection = (): void => {
    options.onReadyAttachmentIdsChange(Object.freeze([...readyIds()]));
    options.onSubmissionBlockedChange?.(item !== undefined && item.durable.status !== "ready");
  };

  const remove = async (): Promise<void> => {
    const previous = item;
    item = undefined;
    root.replaceChildren();
    publishProjection();
    if (previous?.selection !== undefined) {
      await bridge.removeSelection({
        type: "attachment.selection.remove",
        selectionHandle: previous.selection.selectionHandle,
      }).catch(() => undefined);
    }
  };

  const render = (): void => {
    if (disposed) return;
    if (item === undefined) {
      root.replaceChildren();
      return;
    }
    renderAttachmentAuthoritySurface(
      root,
      createAttachmentAuthorityViewModel(inputFor(item, options)),
      {
        onUpload() { void upload(); },
        onCancel() {
          if (item?.operationId === undefined) return;
          void bridge.cancel({ type: "attachment.cancel", operationId: item.operationId })
            .catch(() => undefined);
        },
        onRetry() {
          if (item?.attachmentId === undefined || item.generation === undefined) return;
          void bridge.retryProcessing({
            type: "attachment.processing.retry",
            attachmentId: item.attachmentId,
            expectedGeneration: item.generation,
          }).then((receipt) => {
            if (item !== undefined) item = { ...item, retryOperationId: receipt.operationId };
          }).catch(() => undefined);
        },
        onBind() { options.onBindRequested?.(); },
        onPreview() {
          if (item?.attachmentId === undefined) return;
          void bridge.preview({
            type: "attachment.preview",
            attachmentId: item.attachmentId,
            representation: "safe-rendered",
          }).catch(() => undefined);
        },
        onDownload() {
          if (item?.attachmentId === undefined) return;
          void bridge.download({
            type: "attachment.download",
            attachmentId: item.attachmentId,
          }).catch(() => undefined);
        },
        onRemove() { void remove(); },
        onReauthenticate() { options.onAnnouncement?.("请重新认证后恢复当前 Room 权限"); },
        onRefreshProjection() {
          if (item?.attachmentId === undefined) return;
          void bridge.status({ type: "attachment.status.query", attachmentId: item.attachmentId })
            .then(applyInput).catch(() => undefined);
        },
        onRestartUpload() { void remove().then(() => controller.select()); },
        onSelectReplacement() { void remove().then(() => controller.select()); },
        onUpgradeClient() { options.onAnnouncement?.("当前客户端协议不兼容，请升级后重新上传"); },
      },
    );
  };

  const applyInput = (input: AttachmentAuthorityBridgeInput): void => {
    if (disposed) return;
    if (uploadStarting && item?.operationId === undefined &&
        (input.type === "attachment.upload.progress" ||
          input.type === "attachment.upload.accepted" ||
          input.type === "attachment.operation.error" ||
          input.type === "attachment.operation.cancelled")) {
      queuedInputs.push(input);
      return;
    }
    if (input.type === "attachment.authority.revoked") {
      if (item !== undefined) {
        item = { localTransport: { status: "none" }, durable: { status: "open" }, revoked: true };
        publishProjection();
        render();
      }
      return;
    }
    if (item === undefined) {
      if (input.type !== "attachment.status" || input.sourceEligibility !== "unbound" ||
          input.attachment.roomId !== roomId) return;
      item = {
        attachmentId: input.attachment.attachmentId,
        generation: input.attachment.generation,
        metadata: input.attachment,
        localTransport: { status: "none" },
        durable: durableStatus(input.attachment.processingStatus, undefined),
        revoked: false,
      };
      publishProjection();
      render();
      return;
    }
    if (input.type === "attachment.upload.progress") {
      if (input.operationId !== item.operationId || item.selection === undefined) return;
      item = {
        ...item,
        localTransport: {
          status: "uploading",
          acknowledgedBytes: input.acknowledgedBytes,
          totalBytes: input.totalBytes,
        },
      };
    } else if (input.type === "attachment.upload.accepted") {
      if (input.operationId !== item.operationId) return;
      item = {
        ...item,
        attachmentId: input.attachmentId,
        generation: 1,
        localTransport: { status: "none" },
        durable: { status: "accepted-quarantined", authoritySource: "server-ack" },
      };
    } else if (input.type === "attachment.operation.error") {
      if (input.operationId !== item.operationId && input.operationId !== item.retryOperationId) return;
      item = { ...item, closedError: input.error };
    } else if (input.type === "attachment.operation.cancelled") {
      if (input.operationId !== item.operationId) return;
      item = {
        ...item,
        localTransport: { status: "none" },
        durable: { status: "cancelled", authoritySource: "server-ack" },
      };
    } else {
      if (input.attachment.attachmentId !== item.attachmentId) return;
      if (input.sourceEligibility !== "unbound") {
        item = undefined;
        root.replaceChildren();
        publishProjection();
        return;
      }
      const { closedError, ...current } = item;
      const keepError = input.attachment.processingStatus === "retryable-failed" ||
        input.attachment.processingStatus === "nonretryable-failed";
      item = {
        ...current,
        generation: input.attachment.generation,
        metadata: input.attachment,
        localTransport: { status: "none" },
        durable: durableStatus(input.attachment.processingStatus, closedError),
        ...(keepError && closedError !== undefined ? { closedError } : {}),
      };
    }
    publishProjection();
    render();
  };

  const upload = async (): Promise<void> => {
    if (disposed || item?.selection === undefined || item.operationId !== undefined || uploadStarting) return;
    uploadStarting = true;
    const selection = item.selection;
    item = {
      ...item,
      localTransport: {
        status: "uploading",
        acknowledgedBytes: 0,
        totalBytes: item.selection.byteSize,
      },
    };
    render();
    try {
      const receipt = await bridge.upload({
        type: "attachment.upload",
        roomId,
        selectionHandle: selection.selectionHandle,
      });
      if (disposed || item === undefined) return;
      item = { ...item, operationId: receipt.operationId };
      uploadStarting = false;
      for (const queued of queuedInputs.splice(0)) applyInput(queued);
      render();
    } catch {
      uploadStarting = false;
      if (item !== undefined) {
        item = {
          ...item,
          localTransport: {
            status: "transport-failed",
            error: { status: 503, code: "storage_unavailable" },
          },
        };
        render();
      }
    }
  };

  const unsubscribe = bridge.onAuthorityInput(applyInput);
  const controller: AttachmentComposerBridgeController = {
    async select() {
      if (disposed || item !== undefined) return;
      const result = await bridge.select();
      if (disposed || result.status === "cancelled") return;
      item = {
        selection: result.selection,
        localTransport: { status: "selected" },
        durable: { status: "open" },
        revoked: false,
      };
      publishProjection();
      render();
    },
    remount(nextRoot) {
      root = nextRoot;
      render();
    },
    clearBound(attachmentIds) {
      if (item?.attachmentId === undefined || !attachmentIds.includes(item.attachmentId)) return;
      item = undefined;
      root.replaceChildren();
      publishProjection();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      item = undefined;
      root.replaceChildren();
    },
  };
  return controller;
}
