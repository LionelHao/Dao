import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { AgentRuntimeError, type ToolAdapter, type ToolInvocation } from "../contracts.js";

interface RepositoryGitStatusOptions {
  readonly binaryPath: string;
  readonly repositoryRoot: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

function runGit(options: RepositoryGitStatusOptions, signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      options.binaryPath,
      ["-C", options.repositoryRoot, "status", "--porcelain=v1", "--untracked-files=no"],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
        maxBuffer: options.maxOutputBytes,
        timeout: options.timeoutMs,
        signal,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new AgentRuntimeError("tool_failure", "Git status execution failed"));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

export function createRepositoryGitStatusAdapter(options: RepositoryGitStatusOptions): ToolAdapter {
  if (!isAbsolute(options.binaryPath) || !isAbsolute(options.repositoryRoot)) {
    throw new TypeError("Git binary and repository root must be absolute configured paths");
  }
  const repositoryRoot = resolve(options.repositoryRoot);
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 128 || options.maxOutputBytes > 1_048_576 ||
      !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) {
    throw new TypeError("Git status bounds were invalid");
  }
  const configured = { ...options, repositoryRoot };
  return Object.freeze({
    descriptor: Object.freeze({
      id: "repository.git-status",
      displayName: "Repository Git status",
      effect: "read-only",
      reversibility: "compensatable",
    }),
    async execute(invocation: ToolInvocation) {
      if (Object.keys(invocation.parameters).length !== 0) {
        throw new AgentRuntimeError("invalid_parameters", "Git status accepts no parameters");
      }
      const stdout = await runGit(configured, invocation.signal);
      const lineCount = stdout.length === 0 ? 0 : stdout.trimEnd().split("\n").length;
      return {
        summary: { exitCategory: "success", lineCount },
        modelInput: stdout,
      };
    },
  });
}
