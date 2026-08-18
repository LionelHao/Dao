import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "..");
const electronCli = resolve(packageRoot, "node_modules/electron/cli.js");
const entryPoint = resolve(packageRoot, "dist/main.js");
const userDataDirectory = await mkdtemp(resolve(tmpdir(), "dao-ft01-electron-smoke-"));
const expectedLine = "Native IM desktop Identity surface started.";
let output = "";
let timeout;

const child = spawn(
  process.execPath,
  [electronCli, entryPoint, `--user-data-dir=${userDataDirectory}`],
  { cwd: packageRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
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
    `Electron smoke did not reach Identity startup. Output: ${output}`,
  )), 15_000);
});

try {
  await Promise.race([
    started,
    timedOut,
    exited.then(({ code, signal }) => {
      throw new Error(
        `Electron exited before Identity startup (code=${code}, signal=${signal}). Output: ${output}`,
      );
    }),
  ]);
  console.log("Electron Identity smoke passed: sandbox preload and renderer loaded.");
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await exited;
  await rm(userDataDirectory, { force: true, recursive: true });
}
