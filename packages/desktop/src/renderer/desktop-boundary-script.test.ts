import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop renderer boundary verifier", () => {
  it("reports every nested production TypeScript source", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../../..");
    const rendererDirectory = resolve(repositoryRoot, "packages/desktop/src/renderer");
    const entries = await readdir(rendererDirectory, {
      recursive: true,
      withFileTypes: true,
    });
    const expectedSourceCount = entries.filter((entry) =>
      entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
    ).length;

    const result = spawnSync(
      process.execPath,
      [resolve(repositoryRoot, "scripts/verify-desktop-boundary.mjs")],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      `${expectedSourceCount} production sources expose no Node/Electron authority`,
    );
  });
});
