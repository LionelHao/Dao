import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const rendererSource = resolve(packageRoot, "src/renderer");
const rendererOutput = resolve(packageRoot, "dist/renderer");

await mkdir(rendererOutput, { recursive: true });
await cp(resolve(rendererSource, "index.html"), resolve(rendererOutput, "index.html"));
await cp(resolve(rendererSource, "styles.css"), resolve(rendererOutput, "styles.css"));

