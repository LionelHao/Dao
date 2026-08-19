import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const packageRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");
async function runElectron(entryPoint, expectedLine, label) {
  const userDataDirectory = await mkdtemp(resolve(tmpdir(), "dao-ft04-electron-smoke-"));
  let output = "";
  let timeout;
  const child = spawn(
    electronBinary,
    [entryPoint, `--user-data-dir=${userDataDirectory}`, "--use-mock-keychain"],
    {
      cwd: packageRoot,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const started = new Promise((resolveStart) => {
    const collect = (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-8_192);
      if (output.includes(expectedLine)) resolveStart();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
  });
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(
      `${label} did not reach its startup contract. Output: ${output}`,
    )), 20_000);
  });
  try {
    await Promise.race([
      started,
      timedOut,
      exited.then(({ code, signal }) => {
        throw new Error(
          `${label} exited early (code=${code}, signal=${signal}). Output: ${output}`,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") child.kill("SIGTERM");
      else if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    }
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise((resolveStop) => setTimeout(() => resolveStop(false), 2_000)),
    ]);
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") child.kill("SIGKILL");
      else if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      await exited;
    }
    await rm(userDataDirectory, { force: true, recursive: true });
  }
}

await runElectron(
  resolve(packageRoot, "dist/main.js"),
  "Native IM desktop Identity surface started.",
  "Electron attachmentAuthority app bridge smoke",
);
await runElectron(
  resolve(packageRoot, "scripts/smoke-attachment-preview.mjs"),
  "Electron Attachment native selection and preview security smoke passed.",
  "Electron Attachment native selection and preview sandbox smoke",
);
console.log("Electron attachmentAuthority smoke passed: app bridge, native selection, and secure preview loaded.");
