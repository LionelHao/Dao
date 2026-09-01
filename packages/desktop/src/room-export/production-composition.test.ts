import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Room export production composition", () => {
  it("uses the shared Message Authority socket and installs only the closed IPC/preload bridge", async () => {
    const [main, preload, adapter] = await Promise.all([
      readFile(resolve(import.meta.dirname, "../main.ts"), "utf8"),
      readFile(resolve(import.meta.dirname, "../preload.ts"), "utf8"),
      readFile(resolve(import.meta.dirname, "websocket-transport.ts"), "utf8"),
    ]);
    expect(main).toContain("createRoomExportWebSocketTransport(messageAuthorityRuntime.transport)");
    expect(main).toContain("createElectronRoomExportSaveDialog");
    expect(main).toContain("registerRoomExportIpc");
    expect(preload).toContain("roomExport: createRoomExportBridge(ipcRenderer)");
    expect(adapter).not.toMatch(/new WebSocket|webSocketFactory|addEventListener|onmessage/iu);
    expect(preload).not.toMatch(/showSaveDialog|base64|streamId|offset|filesystem|node:/iu);
  });
});
