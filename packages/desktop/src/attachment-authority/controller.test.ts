import { describe, expect, it, vi } from "vitest";

import { createAttachmentAuthorityController } from "./controller.js";
import { createNativeSelectionRegistry } from "./native-file-selection.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const bytes = new Uint8Array(40_000).fill(7);
  const ack = deferred<{ uploadId: string; acknowledgedBytes: number }>();
  let reads = 0;
  const selections = createNativeSelectionRegistry({
    dialog: { showOpenFile: async () => ({ canceled: false, filePaths: ["/x/report.pdf"] }) },
    fs: {
      lstat: async () => ({ kind: "regular-file", byteSize: bytes.byteLength, modifiedAtMs: 1, device: 1, inode: 1 }),
      openNoFollow: async () => ({
        stat: async () => ({ kind: "regular-file", byteSize: bytes.byteLength, modifiedAtMs: 1, device: 1, inode: 1 }),
        read: async (offset, length) => {
          reads += 1;
          return bytes.slice(offset, offset + length);
        },
        close: async () => undefined,
      }),
    },
    randomId: vi.fn()
      .mockReturnValueOnce("selection_handle_1")
      .mockReturnValueOnce("stable_upload_key_1"),
  });
  const authority = {
    beginUpload: vi.fn(async () => ({ uploadId: "upload-1", acknowledgedBytes: 0 })),
    uploadChunk: vi.fn()
      .mockImplementationOnce(() => ack.promise)
      .mockResolvedValueOnce({ uploadId: "upload-1", acknowledgedBytes: 40_000 }),
    finalizeUpload: vi.fn(async () => ({
      attachmentId: "attachment-1", processingStatus: "accepted-quarantined" as const,
    })),
    cancelUpload: vi.fn(async () => ({ status: "cancelled" as const })),
    retryProcessing: vi.fn(),
    getStatus: vi.fn(),
    close: vi.fn(),
  };
  return { selections, authority, ack, getReads: () => reads };
}

describe("attachment upload controller", () => {
  it("reads at most 32 KiB and publishes progress only after the matching server ACK", async () => {
    const { selections, authority, ack } = fixture();
    const result = await selections.select();
    if (result.status !== "selected") throw new Error("expected selection");
    const events: unknown[] = [];
    const controller = createAttachmentAuthorityController({
      selections,
      authority,
      requestId: () => "operation-1",
    });
    controller.subscribe((event) => events.push(event));
    expect(controller.upload({
      type: "attachment.upload",
      roomId: "room-1",
      selectionHandle: result.selection.selectionHandle,
    })).toEqual({ operationId: "operation-1" });

    await vi.waitFor(() => expect(authority.uploadChunk).toHaveBeenCalledOnce());
    expect(authority.uploadChunk.mock.calls[0]?.[0].bytes).toHaveLength(32_768);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "attachment.upload.progress" }));
    ack.resolve({ uploadId: "upload-1", acknowledgedBytes: 32_768 });
    await vi.waitFor(() => expect(authority.finalizeUpload).toHaveBeenCalledOnce());
    expect(events).toContainEqual({
      type: "attachment.upload.progress",
      operationId: "operation-1",
      acknowledgedBytes: 32_768,
      totalBytes: 40_000,
    });
    expect(events).toContainEqual({
      type: "attachment.upload.accepted",
      operationId: "operation-1",
      attachmentId: "attachment-1",
      processingStatus: "accepted-quarantined",
    });
    expect(authority.beginUpload.mock.calls[0]?.[0].uploadKey).toBe("stable_upload_key_1");
  });

  it("closes the reader, sends authoritative cancel, and invalidation kills all state", async () => {
    const { selections, authority } = fixture();
    const result = await selections.select();
    if (result.status !== "selected") throw new Error("expected selection");
    const controller = createAttachmentAuthorityController({ selections, authority, requestId: () => "op-1" });
    controller.upload({ type: "attachment.upload", roomId: "room-1", selectionHandle: result.selection.selectionHandle });
    await vi.waitFor(() => expect(authority.uploadChunk).toHaveBeenCalledOnce());
    await controller.cancel({ type: "attachment.cancel", operationId: "op-1" });
    expect(authority.cancelUpload).toHaveBeenCalledWith(expect.objectContaining({ uploadId: "upload-1" }));
    expect(() => selections.getPrivateSelection(result.selection.selectionHandle)).toThrow();

    controller.invalidateAuthorizedState("session_revoked");
    expect(authority.close).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight begin ACK before claiming cancellation", async () => {
    const { selections, authority } = fixture();
    const begun = deferred<{ uploadId: string; acknowledgedBytes: number }>();
    authority.beginUpload.mockImplementationOnce(() => begun.promise);
    const result = await selections.select();
    if (result.status !== "selected") throw new Error("expected selection");
    const events: unknown[] = [];
    const controller = createAttachmentAuthorityController({ selections, authority, requestId: () => "op-begin" });
    controller.subscribe((event) => events.push(event));
    controller.upload({ type: "attachment.upload", roomId: "room-1", selectionHandle: result.selection.selectionHandle });
    await vi.waitFor(() => expect(authority.beginUpload).toHaveBeenCalledOnce());
    const cancelling = controller.cancel({ type: "attachment.cancel", operationId: "op-begin" });
    expect(events).not.toContainEqual({ type: "attachment.operation.cancelled", operationId: "op-begin" });
    begun.resolve({ uploadId: "upload-after-cancel", acknowledgedBytes: 0 });
    await expect(cancelling).resolves.toEqual({ operationId: "op-begin" });
    expect(authority.cancelUpload).toHaveBeenCalledWith(expect.objectContaining({ uploadId: "upload-after-cancel" }));
    expect(events).toContainEqual({ type: "attachment.operation.cancelled", operationId: "op-begin" });
  });

  it("retains upload authority for processing cancellation after accepted quarantine", async () => {
    const { selections, authority, ack } = fixture();
    const result = await selections.select();
    if (result.status !== "selected") throw new Error("expected selection");
    const events: unknown[] = [];
    const controller = createAttachmentAuthorityController({ selections, authority, requestId: () => "op-accepted" });
    controller.subscribe((event) => events.push(event));
    controller.upload({ type: "attachment.upload", roomId: "room-1", selectionHandle: result.selection.selectionHandle });
    await vi.waitFor(() => expect(authority.uploadChunk).toHaveBeenCalledOnce());
    ack.resolve({ uploadId: "upload-1", acknowledgedBytes: 32_768 });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "attachment.upload.accepted" })));
    await expect(controller.cancel({ type: "attachment.cancel", operationId: "op-accepted" }))
      .resolves.toEqual({ operationId: "op-accepted" });
    expect(authority.cancelUpload).toHaveBeenCalledWith(expect.objectContaining({ uploadId: "upload-1" }));
  });
});
