import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("FT-14 diagnostics renderer boundary", () => {
  it("keeps Node/Electron, paths, tokens, and binary capability out of renderer contracts", async () => {
    const root = resolve(import.meta.dirname);
    const sources = await Promise.all([
      readFile(resolve(root, "contracts.ts"), "utf8"),
      readFile(resolve(root, "preload-bridge.ts"), "utf8"),
      readFile(resolve(root, "action-model.ts"), "utf8"),
    ]);
    for (const source of sources) {
      expect(source).not.toMatch(
        /from\s+["'](?:node:|electron)|ipcRenderer|showSaveDialog|openTemporary|Uint8Array|ArrayBuffer|accessToken|sessionToken|destinationPath|artifact bytes/u,
      );
    }
  });
});
