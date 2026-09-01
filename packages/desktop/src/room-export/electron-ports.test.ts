import { describe, expect, it, vi } from "vitest";

import { createElectronRoomExportSaveDialog } from "./electron-ports.js";

describe("Electron Room export save dialog", () => {
  it("accepts only a safe NDJSON filename and keeps the selected path main-private", async () => {
    const parent = { isDestroyed: () => false };
    const showSaveDialog = vi.fn(async () => ({ canceled: false,
      filePath: "/private/dao-room-export-room-1.ndjson" }));
    const port = createElectronRoomExportSaveDialog({ parentWindow: parent,
      dialog: { showSaveDialog } });
    await expect(port.chooseDestination("dao-room-export-room-1-2026-09-01.ndjson"))
      .resolves.toBe("/private/dao-room-export-room-1.ndjson");
    expect(showSaveDialog).toHaveBeenCalledWith(parent, {
      title: "导出 Room 数据",
      defaultPath: "dao-room-export-room-1-2026-09-01.ndjson",
      properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"],
      filters: [{ name: "NDJSON", extensions: ["ndjson"] }],
    });
    for (const unsafe of ["../escape.ndjson", "nested/export.ndjson", "export.json", "", "a".repeat(256)]) {
      await expect(port.chooseDestination(unsafe)).rejects.toThrow("filename is not closed");
    }
    expect(showSaveDialog).toHaveBeenCalledOnce();
  });

  it("returns undefined on native cancellation", async () => {
    const port = createElectronRoomExportSaveDialog({ parentWindow: { isDestroyed: () => false },
      dialog: { showSaveDialog: vi.fn(async () => ({ canceled: true })) } });
    await expect(port.chooseDestination("dao-room-export-room-1-2026-09-01.ndjson"))
      .resolves.toBeUndefined();
  });
});
