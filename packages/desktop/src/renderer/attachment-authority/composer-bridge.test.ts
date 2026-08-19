import type {
  AttachmentAuthorityBridge,
  AttachmentAuthorityBridgeInput,
} from "../../attachment-authority/contracts.js";
import { describe, expect, it, vi } from "vitest";

import { mountAttachmentComposerBridge } from "./composer-bridge.js";

const remoteReadyStatus = {
  type: "attachment.status" as const,
  attachment: {
    attachmentId: "attachment-remote",
    roomId: "room-1",
    originalFilename: "跨设备报告.pdf",
    format: "pdf" as const,
    declaredMime: "application/pdf" as const,
    detectedMime: "application/pdf" as const,
    byteSize: 65_536,
    sha256: "a".repeat(64),
    uploaderActorId: "human-1",
    createdAt: "2026-08-19T08:00:00.000Z",
    readyAt: "2026-08-19T08:01:00.000Z",
    processingStatus: "ready" as const,
    generation: 2,
    sourceMessageId: null,
    provenance: {
      scanner: { kind: "clamav" as const, version: "1.4.3" },
      extraction: { method: "pdf-text" as const, tool: "pdftotext" as const,
        version: "25.06.0", artifactSha256: "b".repeat(64), artifactByteSize: 1_024, pageCount: 2 },
      ocr: null,
    },
  },
  sourceEligibility: "unbound" as const,
  accessProjection: "authorized" as const,
};

function privateStatus(
  attachmentId: string,
  processingStatus: "accepted-quarantined" | "processing" | "ready" = "ready",
  generation = 1,
): AttachmentAuthorityBridgeInput {
  const ready = processingStatus === "ready";
  return {
    ...remoteReadyStatus,
    attachment: {
      ...remoteReadyStatus.attachment,
      attachmentId,
      processingStatus,
      generation,
      readyAt: ready ? remoteReadyStatus.attachment.readyAt : null,
      provenance: ready ? remoteReadyStatus.attachment.provenance : null,
    },
  };
}

function harness() {
  let listener: ((input: AttachmentAuthorityBridgeInput) => void) | undefined;
  const bridge: AttachmentAuthorityBridge = {
    select: vi.fn(async () => ({
      status: "selected" as const,
      selection: {
        selectionHandle: "selection-1",
        displayName: "安全报告.pdf",
        format: "pdf" as const,
        declaredMime: "application/pdf" as const,
        byteSize: 65_536,
        expiresAt: "2026-08-19T12:00:00.000Z",
      },
    })),
    upload: vi.fn(async () => ({ operationId: "operation-1" })),
    cancel: vi.fn(async () => ({ operationId: "cancel-1" })),
    retryProcessing: vi.fn(async () => ({ operationId: "retry-1" })),
    status: vi.fn(async ({ attachmentId }) =>
      privateStatus(attachmentId, "processing") as Extract<
        AttachmentAuthorityBridgeInput, { type: "attachment.status" }
      >),
    preview: vi.fn(async ({ attachmentId, representation }) => ({
      type: "attachment.preview.policy" as const,
      attachmentId,
      representation,
      nodeIntegration: false as const,
      contextIsolation: true as const,
      sandbox: true as const,
      webSecurity: true as const,
      allowNavigation: false as const,
      allowWindowOpen: false as const,
      allowPermissions: false as const,
      allowExternalProtocols: false as const,
      allowNetwork: false as const,
      ariaLive: "off" as const,
    })),
    download: vi.fn(async ({ attachmentId }) => ({
      type: "attachment.download.saved" as const,
      attachmentId,
    })),
    removeSelection: vi.fn(async () => undefined),
    onAuthorityInput(next) {
      listener = next;
      return () => { listener = undefined; };
    },
  };
  return { bridge, publish: (input: AttachmentAuthorityBridgeInput) => listener?.(input) };
}

describe("J-02 Attachment Authority composer bridge", () => {
  it("creates a bindable composer item from uploader-private status on another device", () => {
    const authority = harness();
    const root = document.createElement("section");
    const ready = vi.fn();
    const composer = mountAttachmentComposerBridge(root, authority.bridge, "room-1", {
      accessProjection: () => "authorized",
      onReadyAttachmentIdsChange: ready,
    });

    authority.publish(remoteReadyStatus);

    expect(root.dataset.attachmentState).toBe("ready");
    expect(root.textContent).toContain("跨设备报告.pdf");
    expect(root.textContent).toContain("application/pdf");
    expect(root.textContent).toContain("SHA-256");
    expect(root.textContent).toContain("ClamAV 1.4.3");
    expect(root.querySelector("[data-action='bind']")).not.toBeNull();
    expect(ready).toHaveBeenLastCalledWith(["attachment-remote"]);
    expect(root.innerHTML).not.toMatch(/selectionHandle|path|token|objectKey|extractedText/u);
    composer.dispose();
  });

  it("keeps ACK progress and processing private, and adds only stable READY to the message draft", async () => {
    const authority = harness();
    const root = document.createElement("section");
    const ready = vi.fn();
    const composer = mountAttachmentComposerBridge(root, authority.bridge, "room-1", {
      accessProjection: () => "authorized",
      onReadyAttachmentIdsChange: ready,
      reducedMotion: true,
    });

    await composer.select();
    expect(root.dataset.attachmentState).toBe("local-selected");
    expect(root.textContent).toContain("安全报告.pdf");
    expect(root.querySelector("[data-authority-source='local-transient']")).not.toBeNull();
    expect(ready).not.toHaveBeenCalledWith(["attachment-1"]);

    root.querySelector<HTMLButtonElement>("[data-action='upload']")?.click();
    await vi.waitFor(() => expect(authority.bridge.upload).toHaveBeenCalledOnce());
    authority.publish({
      type: "attachment.upload.progress",
      operationId: "operation-1",
      acknowledgedBytes: 32_768,
      totalBytes: 65_536,
    });
    expect(root.querySelector<HTMLProgressElement>("progress")?.value).toBe(32_768);
    expect(ready).not.toHaveBeenCalledWith(["attachment-1"]);

    authority.publish({
      type: "attachment.upload.accepted",
      operationId: "operation-1",
      attachmentId: "attachment-1",
      processingStatus: "accepted-quarantined",
    });
    expect(root.dataset.attachmentState).toBe("processing");
    expect(root.querySelector("[data-authority-source='server-ack']")).not.toBeNull();
    expect(ready).not.toHaveBeenCalledWith(["attachment-1"]);

    authority.publish(privateStatus("attachment-1"));
    expect(root.dataset.attachmentState).toBe("ready");
    expect(root.querySelector("[data-authority-source='stable-event']")).not.toBeNull();
    expect(ready).toHaveBeenLastCalledWith(["attachment-1"]);

    composer.dispose();
  });

  it("purges safe metadata and ready draft references on authority revoke", async () => {
    const authority = harness();
    const root = document.createElement("section");
    const ready = vi.fn();
    const composer = mountAttachmentComposerBridge(root, authority.bridge, "room-1", {
      accessProjection: () => "authorized",
      onReadyAttachmentIdsChange: ready,
    });
    await composer.select();
    root.querySelector<HTMLButtonElement>("[data-action='upload']")?.click();
    await vi.waitFor(() => expect(authority.bridge.upload).toHaveBeenCalledOnce());
    authority.publish({
      type: "attachment.upload.accepted",
      operationId: "operation-1",
      attachmentId: "attachment-1",
      processingStatus: "accepted-quarantined",
    });
    authority.publish(privateStatus("attachment-1"));
    authority.publish({ type: "attachment.authority.revoked", reason: "membership_revoked" });

    expect(root.textContent).not.toContain("安全报告.pdf");
    expect(root.dataset.attachmentState).toBe("permission-revoked");
    expect(ready).toHaveBeenLastCalledWith([]);
    composer.dispose();
  });
});
