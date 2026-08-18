import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const rendererDirectory = resolve(repositoryRoot, "packages/desktop/src/renderer");
const prohibitedImport = /(?:from\s+|import\s*\()["'](?:electron|node:|fs(?:\/|["'])|path(?:\/|["'])|child_process(?:\/|["'])|net(?:\/|["'])|http(?:\/|["'])|https(?:\/|["']))/u;
const prohibitedGlobal = /\b(?:require|process|Buffer|__dirname|__filename)\b/u;

const entries = await readdir(rendererDirectory, { withFileTypes: true });
const productionSources = entries
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts"),
  )
  .map((entry) => resolve(rendererDirectory, entry.name));

const violations = [];
for (const filePath of productionSources) {
  const source = await readFile(filePath, "utf8");
  if (prohibitedImport.test(source) || prohibitedGlobal.test(source)) {
    violations.push(filePath.slice(repositoryRoot.length + 1));
  }
}

if (violations.length > 0) {
  throw new Error(
    `Desktop renderer must remain outside Node/Electron authority: ${violations.join(", ")}`,
  );
}

console.log(
  `Desktop renderer boundary check passed: ${productionSources.length} production sources expose no Node/Electron authority.`,
);
