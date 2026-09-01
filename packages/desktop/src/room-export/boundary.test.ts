import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Room export Desktop boundary", () => {
  it("keeps Node/Electron capabilities out of contracts and preload", async () => {
    const packageRoot = basename(process.cwd()) === "desktop"
      ? process.cwd() : resolve(process.cwd(), "packages/desktop");
    const sources = await Promise.all([
      readFile(resolve(packageRoot, "src/room-export/contracts.ts"), "utf8"),
      readFile(resolve(packageRoot, "src/room-export/preload-bridge.ts"), "utf8"),
    ]);
    for (const source of sources) {
      expect(source).not.toMatch(
        /from\s+["'](?:node:|electron)|ipcRenderer|showSaveDialog|openTemporary|Uint8Array|bytes/u,
      );
    }
  });
});
