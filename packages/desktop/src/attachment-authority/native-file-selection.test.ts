import { describe, expect, it, vi } from "vitest";

import {
  createNativeSelectionRegistry,
  NativeSelectionFailure,
  type NativeFileHandle,
  type NativeFileStat,
} from "./native-file-selection.js";

const regular: NativeFileStat = {
  kind: "regular-file",
  byteSize: 4,
  modifiedAtMs: 10,
  device: 1,
  inode: 2,
};

function handle(stat: NativeFileStat = regular): NativeFileHandle {
  return {
    stat: vi.fn(async () => stat),
    read: vi.fn(async () => new Uint8Array()),
    close: vi.fn(async () => undefined),
  };
}

describe("native attachment selection", () => {
  it("preflights one regular non-symlink supported file before reading any body bytes", async () => {
    const opened = handle();
    const fs = {
      lstat: vi.fn(async () => regular),
      openNoFollow: vi.fn(async () => opened),
    };
    const registry = createNativeSelectionRegistry({
      dialog: { showOpenFile: vi.fn(async () => ({ canceled: false, filePaths: ["/private/report.pdf"] })) },
      fs,
      now: () => 1_000,
      randomId: vi.fn()
        .mockReturnValueOnce("selection_opaque_1")
        .mockReturnValueOnce("upload_key_private_1"),
    });

    await expect(registry.select()).resolves.toEqual({
      status: "selected",
      selection: {
        selectionHandle: "selection_opaque_1",
        displayName: "report.pdf",
        format: "pdf",
        declaredMime: "application/pdf",
        byteSize: 4,
        expiresAt: "1970-01-01T00:15:01.000Z",
      },
    });
    expect(fs.openNoFollow).toHaveBeenCalledWith("/private/report.pdf");
    expect(opened.stat).toHaveBeenCalledOnce();
    expect(opened.read).not.toHaveBeenCalled();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(await registry.publicSelection("selection_opaque_1")))
      .not.toMatch(/private|path|upload_key|token|url|base64/u);
  });

  it("rejects size/type/symlink and stat races before opening or reading", async () => {
    const openNoFollow = vi.fn(async () => handle());
    const make = (filePath: string, stat: NativeFileStat) => createNativeSelectionRegistry({
      dialog: { showOpenFile: vi.fn(async () => ({ canceled: false, filePaths: [filePath] })) },
      fs: { lstat: vi.fn(async () => stat), openNoFollow },
      randomId: () => "unused",
    });

    await expect(make("/x/big.pdf", { ...regular, byteSize: 52_428_801 }).select())
      .rejects.toMatchObject<Partial<NativeSelectionFailure>>({
        error: { status: 413, code: "attachment_too_large" },
      });
    await expect(make("/x/payload.exe", regular).select()).rejects.toMatchObject({
      error: { status: 415, code: "attachment_type_unsupported" },
    });
    await expect(make("/x/link.pdf", { ...regular, kind: "symbolic-link" }).select())
      .rejects.toMatchObject({ error: { status: 400, code: "invalid_request" } });
    expect(openNoFollow).not.toHaveBeenCalled();

    const raced = handle({ ...regular, inode: 99 });
    const raceRegistry = createNativeSelectionRegistry({
      dialog: { showOpenFile: async () => ({ canceled: false, filePaths: ["/x/a.pdf"] }) },
      fs: { lstat: async () => regular, openNoFollow: async () => raced },
      randomId: () => "unused",
    });
    await expect(raceRegistry.select()).rejects.toMatchObject({
      error: { status: 409, code: "idempotency_conflict" },
    });
    expect(raced.read).not.toHaveBeenCalled();
    expect(raced.close).toHaveBeenCalledOnce();
  });

  it("caps handles at 16, expires them after 15 minutes, and reuses a private uploadKey", async () => {
    let now = 0;
    let id = 0;
    const registry = createNativeSelectionRegistry({
      dialog: { showOpenFile: async () => ({ canceled: false, filePaths: [`/x/${id}.txt`] }) },
      fs: { lstat: async () => regular, openNoFollow: async () => handle() },
      now: () => now,
      randomId: () => `opaque_${++id}`,
    });
    const selected = [];
    for (let index = 0; index < 16; index += 1) selected.push(await registry.select());
    await expect(registry.select()).rejects.toMatchObject({
      error: { status: 429, code: "attachment_capacity_limited" },
    });
    const first = selected[0];
    if (first.status !== "selected") throw new Error("expected selection");
    const privateA = registry.getPrivateSelection(first.selection.selectionHandle);
    const privateB = registry.getPrivateSelection(first.selection.selectionHandle);
    expect(privateA.uploadKey).toBe(privateB.uploadKey);
    now = 900_001;
    expect(() => registry.getPrivateSelection(first.selection.selectionHandle)).toThrowError(
      expect.objectContaining({ error: { status: 410, code: "upload_expired" } }),
    );
  });

  it.each([
    ["a.pdf", "pdf", "application/pdf"],
    ["a.png", "png", "image/png"],
    ["a.jpg", "jpeg", "image/jpeg"],
    ["a.docx", "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["a.xlsx", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["a.txt", "txt", "text/plain"],
    ["a.csv", "csv", "text/csv"],
  ] as const)("maps supported %s without reading its body", async (name, format, declaredMime) => {
    const opened = handle();
    const registry = createNativeSelectionRegistry({
      dialog: { showOpenFile: async () => ({ canceled: false, filePaths: [`/x/${name}`] }) },
      fs: { lstat: async () => regular, openNoFollow: async () => opened },
      randomId: vi.fn().mockReturnValueOnce(`handle-${format}`).mockReturnValueOnce(`key-${format}`),
    });
    await expect(registry.select()).resolves.toMatchObject({
      status: "selected",
      selection: { displayName: name, format, declaredMime },
    });
    expect(opened.read).not.toHaveBeenCalled();
  });
});
