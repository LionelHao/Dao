import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export default function buildAuthorityWorkerBeforeTests(): void {
  try {
    const requireFromWorkspace = createRequire(resolve(process.cwd(), "package.json"));
    const typescriptPath = requireFromWorkspace.resolve("typescript/bin/tsc");
    execFileSync(
      process.execPath,
      [typescriptPath, "-b", "--force", "packages/server/tsconfig.json"],
      { cwd: process.cwd(), stdio: "pipe" },
    );
  } catch {
    throw new Error("Vitest authority worker build failed");
  }
}
