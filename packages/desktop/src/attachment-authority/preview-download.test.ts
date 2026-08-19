import { describe, expect, it, vi } from "vitest";

import { createPreviewDownloadService } from "./preview-download.js";

describe("closed preview/download authority", () => {
  it("reauthorizes each preview and returns policy only, never a URL or bytes", async () => {
    const authority = {
      authorizePreview: vi.fn(async () => ({ grantId: "private-preview-grant", byteSize: 2 })),
      authorizeDownload: vi.fn(),
      readGrant: vi.fn(async () => new Uint8Array([1, 2])),
    };
    const previewHost = { openSandboxed: vi.fn(async () => undefined), closeAll: vi.fn() };
    const service = createPreviewDownloadService({
      authority,
      previewHost,
      saveDialog: { chooseDestination: vi.fn() },
      fs: { openTemporary: vi.fn(), rename: vi.fn(), remove: vi.fn() },
      randomId: () => "temp",
    });

    const first = await service.preview({ type: "attachment.preview", attachmentId: "attachment-1", representation: "safe-rendered" });
    const second = await service.preview({ type: "attachment.preview", attachmentId: "attachment-1", representation: "safe-rendered" });
    expect(authority.authorizePreview).toHaveBeenCalledTimes(2);
    expect(previewHost.openSandboxed).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      type: "attachment.preview.policy",
      attachmentId: "attachment-1",
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
    expect(JSON.stringify(first)).not.toMatch(/url|grant|token|path|bytes|base64|buffer/iu);
  });

  it("reauthorizes before save dialog and commits via temp write, fsync, close, atomic rename", async () => {
    const order: string[] = [];
    const authority = {
      authorizePreview: vi.fn(),
      authorizeDownload: vi.fn(async () => { order.push("authorize"); return { grantId: "private", byteSize: 3, displayName: "report.pdf" }; }),
      readGrant: vi.fn(async (_grant: string, offset: number) => offset === 0 ? new Uint8Array([1, 2, 3]) : new Uint8Array()),
    };
    const file = {
      write: vi.fn(async () => { order.push("write"); }),
      sync: vi.fn(async () => { order.push("fsync"); }),
      close: vi.fn(async () => { order.push("close"); }),
    };
    const service = createPreviewDownloadService({
      authority,
      previewHost: { openSandboxed: vi.fn(), closeAll: vi.fn() },
      saveDialog: { chooseDestination: vi.fn(async () => { order.push("dialog"); return "/chosen/report.pdf"; }) },
      fs: {
        openTemporary: vi.fn(async () => { order.push("temp"); return file; }),
        rename: vi.fn(async () => { order.push("rename"); }),
        remove: vi.fn(),
      },
      randomId: () => "opaque-temp",
    });
    await expect(service.download({ type: "attachment.download", attachmentId: "attachment-1" }))
      .resolves.toEqual({ type: "attachment.download.saved", attachmentId: "attachment-1" });
    expect(order).toEqual(["authorize", "dialog", "temp", "write", "fsync", "close", "rename"]);
  });

  it("does not open a dialog or write after reauthorization fails", async () => {
    const chooseDestination = vi.fn();
    const openTemporary = vi.fn();
    const service = createPreviewDownloadService({
      authority: {
        authorizePreview: vi.fn(),
        authorizeDownload: vi.fn(async () => { throw Object.assign(new Error("forbidden"), { attachmentError: { status: 403, code: "attachment_forbidden" } }); }),
        readGrant: vi.fn(),
      },
      previewHost: { openSandboxed: vi.fn(), closeAll: vi.fn() },
      saveDialog: { chooseDestination },
      fs: { openTemporary, rename: vi.fn(), remove: vi.fn() },
      randomId: () => "temp",
    });
    await expect(service.download({ type: "attachment.download", attachmentId: "attachment-1" })).rejects.toThrow("forbidden");
    expect(chooseDestination).not.toHaveBeenCalled();
    expect(openTemporary).not.toHaveBeenCalled();
  });

  it("revocation aborts active reads, removes the temporary file, and closes previews", async () => {
    let release!: (value: Uint8Array) => void;
    const pendingRead = new Promise<Uint8Array>((resolve) => { release = resolve; });
    const remove = vi.fn(async () => undefined);
    const rename = vi.fn();
    const closeAll = vi.fn();
    const readGrant = vi.fn(async () => pendingRead);
    const service = createPreviewDownloadService({
      authority: {
        authorizePreview: vi.fn(),
        authorizeDownload: vi.fn(async () => ({ grantId: "private", byteSize: 3, displayName: "report.pdf" })),
        readGrant,
      },
      previewHost: { openSandboxed: vi.fn(), closeAll },
      saveDialog: { chooseDestination: vi.fn(async () => "/chosen/report.pdf") },
      fs: {
        openTemporary: vi.fn(async () => ({
          write: vi.fn(async () => undefined),
          sync: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        })),
        rename,
        remove,
      },
      randomId: () => "temp",
    });
    const download = service.download({ type: "attachment.download", attachmentId: "attachment-1" });
    await vi.waitFor(() => expect(readGrant).toHaveBeenCalledOnce());
    await service.invalidateAuthorizedState();
    release(new Uint8Array([1, 2, 3]));
    await expect(download).rejects.toThrow("revoked");
    expect(remove).toHaveBeenCalledWith("/chosen/report.pdf.part-temp");
    expect(rename).not.toHaveBeenCalled();
    expect(closeAll).toHaveBeenCalledOnce();
  });
});
