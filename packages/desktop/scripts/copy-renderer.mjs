import { cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");
const rendererSource = resolve(packageRoot, "src/renderer");
const rendererOutput = resolve(packageRoot, "dist/renderer");
const messageAuthorityOutput = resolve(rendererOutput, "message-authority");

await mkdir(rendererOutput, { recursive: true });
await mkdir(messageAuthorityOutput, { recursive: true });
await build({
  bundle: true,
  entryPoints: [resolve(rendererSource, "main.ts")],
  format: "esm",
  logLevel: "warning",
  outfile: resolve(rendererOutput, "main.js"),
  platform: "browser",
  sourcemap: false,
  target: "chrome138",
});
const rendererBundle = await readFile(resolve(rendererOutput, "main.js"), "utf8");
if (rendererBundle.includes("@native-im/core") ||
    /\brequire\s*\(/u.test(rendererBundle) ||
    /\b(?:node:|electron\b)/u.test(rendererBundle)) {
  throw new Error("Renderer bundle retained a bare or privileged runtime dependency.");
}
await cp(resolve(rendererSource, "index.html"), resolve(rendererOutput, "index.html"));
await cp(resolve(rendererSource, "styles.css"), resolve(rendererOutput, "styles.css"));
await cp(
  resolve(rendererSource, "message-authority/message-authority.css"),
  resolve(messageAuthorityOutput, "message-authority.css"),
);
