import { execFile, execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolAdapter, ToolInvocation } from "../contracts.js";
import { knownFailure } from "./adapter-outcome.js";

interface RepositoryGitStatusOptions {
  readonly binaryPath: string;
  readonly repositoryRoot: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  /** Deep-test seam for platforms where Node cannot use an open directory as cwd. */
  readonly testOnlyAllowPathFallback?: boolean;
}

interface FileIdentity { readonly dev: bigint; readonly ino: bigint }

function identity(path: string, kind: "file" | "directory"): FileIdentity {
  const metadata = lstatSync(path, { bigint: true });
  if (metadata.isSymbolicLink() || (kind === "file" ? !metadata.isFile() : !metadata.isDirectory())) {
    throw new TypeError(`Configured Git ${kind} identity was rejected`);
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(path: string, expected: FileIdentity, kind: "file" | "directory"): boolean {
  try {
    const current = lstatSync(path, { bigint: true });
    return !current.isSymbolicLink() && (kind === "file" ? current.isFile() : current.isDirectory()) &&
      current.dev === expected.dev && current.ino === expected.ino;
  } catch { return false; }
}

function parsePorcelain(stdout: string): Readonly<{ records: readonly string[]; omitted: number }> {
  if (stdout.includes("\0") || stdout.includes("\r")) throw knownFailure("tool_failure", "Git status output was malformed");
  const source = stdout === "" ? [] : stdout.replace(/\n$/, "").split("\n");
  const records: string[] = [];
  let omitted = 0;
  for (const line of source) {
    if (line.length < 4 || line.length > 4_096 || line[2] !== " " ||
        [...line].some((character) => {
          const code = character.codePointAt(0)!;
          return code <= 8 || (code >= 11 && code <= 31) || code === 127;
        })) {
      throw knownFailure("tool_failure", "Git status output was malformed");
    }
    if (records.length < 256) records.push(line);
    else omitted += 1;
  }
  return Object.freeze({ records: Object.freeze(records), omitted });
}

function probeDescriptorCwd(fdRoot: string, rootFd: number, expected: FileIdentity): boolean {
  try {
    const observed = execFileSync(
      process.execPath,
      ["-e", "const s=require('node:fs').statSync('.',{bigint:true});process.stdout.write(`${s.dev}:${s.ino}`)"],
      {
        cwd: `${fdRoot}/${rootFd}`,
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        maxBuffer: 128,
        timeout: 2_000,
        windowsHide: true,
      },
    );
    return observed === `${expected.dev}:${expected.ino}`;
  } catch {
    return false;
  }
}

function runGit(
  binaryPath: string,
  repositoryRoot: string,
  maxOutputBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(knownFailure("tool_failure", "Git status was cancelled"));
      return;
    }
    let combinedBytes = 0;
    let overflow = false;
    const child = execFile(
      binaryPath,
      ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=no"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
        },
        maxBuffer: maxOutputBytes + 1,
        timeout: timeoutMs,
        signal,
        shell: false,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null || overflow) {
          reject(knownFailure("tool_failure", "Git status execution failed"));
          return;
        }
        resolvePromise(stdout);
      },
    );
    const account = (chunk: Buffer | string) => {
      combinedBytes += Buffer.byteLength(chunk);
      if (combinedBytes > maxOutputBytes && !overflow) {
        overflow = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout?.on("data", account);
    child.stderr?.on("data", account);
  });
}

export function createRepositoryGitStatusAdapter(options: RepositoryGitStatusOptions): ToolAdapter {
  if (!isAbsolute(options.binaryPath) || !isAbsolute(options.repositoryRoot)) {
    throw new TypeError("Git binary and repository root must be absolute configured paths");
  }
  const binaryPath = realpathSync(options.binaryPath);
  const repositoryRoot = resolve(options.repositoryRoot);
  const binaryIdentity = identity(binaryPath, "file");
  const rootIdentity = identity(repositoryRoot, "directory");
  const fdRoot = existsSync("/proc/self/fd") ? "/proc/self/fd" : existsSync("/dev/fd") ? "/dev/fd" : undefined;
  if (fdRoot === undefined) throw new TypeError("Git descriptor-anchored repository access is unavailable");
  const probeFd = openSync(repositoryRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let descriptorCwdReady: boolean;
  try { descriptorCwdReady = probeDescriptorCwd(fdRoot, probeFd, rootIdentity); }
  finally { closeSync(probeFd); }
  if (!descriptorCwdReady && options.testOnlyAllowPathFallback !== true) {
    throw new TypeError("Git descriptor-anchored repository cwd is unavailable; startup refused");
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 128 || options.maxOutputBytes > 1_048_576 ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) {
    throw new TypeError("Git status bounds were invalid");
  }
  return Object.freeze({
    descriptor: Object.freeze({ id: "repository.git-status", displayName: "Repository Git status", effect: "read-only", reversibility: "compensatable" }),
    async execute(invocation: ToolInvocation) {
      if (Object.keys(invocation.parameters).length !== 0) throw knownFailure("invalid_parameters", "Git status accepts no parameters");
      if (!sameIdentity(binaryPath, binaryIdentity, "file") || !sameIdentity(repositoryRoot, rootIdentity, "directory")) {
        throw knownFailure("tool_failure", "Configured Git execution identity changed");
      }
      let rootFd: number;
      try { rootFd = openSync(repositoryRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch { throw knownFailure("tool_failure", "Configured Git repository identity changed"); }
      let run: Promise<string>;
      try {
        const anchored = fstatSync(rootFd, { bigint: true });
        if (anchored.dev !== rootIdentity.dev || anchored.ino !== rootIdentity.ino || !anchored.isDirectory()) {
          throw knownFailure("tool_failure", "Configured Git repository identity changed");
        }
        // execFile resolves cwd during its synchronous spawn setup; the child is
        // therefore anchored to this open directory even if its pathname swaps.
        run = runGit(
          binaryPath,
          descriptorCwdReady ? `${fdRoot}/${rootFd}` : repositoryRoot,
          options.maxOutputBytes,
          options.timeoutMs,
          invocation.signal,
        );
      } finally { closeSync(rootFd); }
      const stdout = await run;
      if (!sameIdentity(repositoryRoot, rootIdentity, "directory")) throw knownFailure("tool_failure", "Configured Git repository identity changed");
      const parsed = parsePorcelain(stdout);
      return {
        outcome: "known_succeeded" as const,
        summary: { exitCategory: "success", lineCount: parsed.records.length, omittedCount: parsed.omitted },
        modelInput: JSON.stringify(parsed),
      };
    },
  });
}
