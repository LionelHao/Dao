import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(packageRoot, "dist/preload.cjs");

await build({
  bundle: true,
  entryPoints: [resolve(packageRoot, "src/preload.ts")],
  external: ["electron"],
  format: "cjs",
  logLevel: "warning",
  outfile: outputPath,
  platform: "node",
  sourcemap: false,
  target: "node22",
});

const bundle = await readFile(outputPath, "utf8");

if (/^\s*import\s/mu.test(bundle) || /\bexport\s+\{/u.test(bundle)) {
  throw new Error("Sandbox preload bundle must be CommonJS, not ESM.");
}

if (!bundle.includes('require("electron")')) {
  throw new Error("Sandbox preload bundle must retain Electron as an external module.");
}
