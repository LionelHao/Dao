import { describe, expect, it, vi } from "vitest";

import { ATTACHMENT_AUTHORITY_IPC_CHANNELS } from "./contracts.js";
import { registerAttachmentAuthorityIpc } from "./ipc.js";

describe("attachment main-frame IPC allowlist", () => {
  it("registers only exact trusted methods, rejects surplus keys, and cleans up", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };
    const frame = {};
    const webContents = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
    const unsubscribe = vi.fn();
    const controller = {
      select: vi.fn(async () => ({ status: "cancelled" as const })),
      upload: vi.fn(() => ({ operationId: "op-1" })),
      cancel: vi.fn(async () => ({ operationId: "op-1" })),
      retryProcessing: vi.fn(() => ({ operationId: "op-2" })),
      status: vi.fn(async () => ({
        type: "attachment.status" as const,
        attachment: {
          attachmentId: "a-1", roomId: "room-1", originalFilename: "safe.txt",
          format: "txt" as const, declaredMime: "text/plain" as const,
          detectedMime: "text/plain" as const, byteSize: 4, sha256: "a".repeat(64),
          uploaderActorId: "human-1", createdAt: "2026-08-19T08:00:00.000Z",
          readyAt: null, processingStatus: "processing" as const, generation: 1,
          sourceMessageId: null, provenance: null,
        },
        sourceEligibility: "unbound" as const,
        accessProjection: "authorized" as const,
      })),
      preview: vi.fn(), download: vi.fn(), removeSelection: vi.fn(async () => undefined),
      subscribe: vi.fn(() => unsubscribe),
    };
    const dispose = registerAttachmentAuthorityIpc({ ipcMain, webContents, controller });
    expect([...handlers.keys()].sort()).toEqual(Object.values(ATTACHMENT_AUTHORITY_IPC_CHANNELS).filter((value) => value !== ATTACHMENT_AUTHORITY_IPC_CHANNELS.authorityInput).sort());

    const select = handlers.get(ATTACHMENT_AUTHORITY_IPC_CHANNELS.select)!;
    await expect(select({ sender: {}, senderFrame: frame })).rejects.toThrow("trusted main frame");
    await expect(select({ sender: webContents, senderFrame: frame }, { unexpected: true })).rejects.toThrow("Invalid Attachment Authority select request");
    await expect(select({ sender: webContents, senderFrame: frame })).resolves.toEqual({ status: "cancelled" });
    controller.select.mockRejectedValueOnce(Object.assign(new Error("/Users/private/report.pdf"), {
      error: { status: 403, code: "attachment_forbidden" },
    }));
    const sanitized = select({ sender: webContents, senderFrame: frame });
    await expect(sanitized).rejects.toMatchObject({
      message: "Attachment Authority failed: 403 attachment_forbidden",
      attachmentError: { status: 403, code: "attachment_forbidden" },
    });
    await expect(sanitized).rejects.not.toThrow("/Users/private/report.pdf");

    const upload = handlers.get(ATTACHMENT_AUTHORITY_IPC_CHANNELS.upload)!;
    expect(() => upload({ sender: webContents, senderFrame: frame }, {
      type: "attachment.upload", roomId: "room-1", selectionHandle: "handle-1", accessToken: "leak",
    })).toThrow("Invalid Attachment Authority upload intent");
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(8);
  });
});
