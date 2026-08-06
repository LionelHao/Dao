import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const coreDirectory = resolve(repositoryRoot, "packages/core");
const packageJson = JSON.parse(
  await readFile(resolve(coreDirectory, "package.json"), "utf8"),
);
const dependencies = Object.keys(packageJson.dependencies ?? {});
const prohibitedDependency = /^(?:fs|net|http|https|undici|axios|pg|postgres|mysql2|mongodb|redis|sqlite3|better-sqlite3)$/;
const disallowedDependencies = dependencies.filter((dependency) =>
  prohibitedDependency.test(dependency),
);
const source = await readFile(resolve(coreDirectory, "src/index.ts"), "utf8");
const prohibitedImport = /from\s+["'](?:node:)?(?:fs|net|http|https)["']/;

if (disallowedDependencies.length > 0 || prohibitedImport.test(source)) {
  throw new Error(
    `@native-im/core must remain zero-I/O. Disallowed entries: ${disallowedDependencies.join(", ") || "source import"}`,
  );
}

console.log("@native-im/core boundary check passed: no I/O dependencies or imports.");

