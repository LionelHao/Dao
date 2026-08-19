import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export const PROCESS_RUNNER_LIMITS = Object.freeze({
  maxStdoutBytes: 8 * 1_024 * 1_024,
  maxStderrBytes: 64 * 1_024,
  maxStdinBytes: 50 * 1_024 * 1_024,
  maxTimeoutMs: 180_000,
  maxArguments: 64,
  maxArgumentBytes: 4_096,
  killGraceMs: 100,
});

export type BoundedProcessFailureReason =
  | "invalid_configuration"
  | "unavailable"
  | "timed_out"
  | "aborted"
  | "stdout_limit_exceeded"
  | "stderr_limit_exceeded"
  | "nonzero_exit";

export class BoundedProcessError extends Error {
  readonly reason: BoundedProcessFailureReason;
  readonly retryable: boolean;

  constructor(reason: BoundedProcessFailureReason) {
    super(`Attachment process failed: ${reason}`);
    this.name = "BoundedProcessError";
    delete this.stack;
    this.reason = reason;
    this.retryable = reason === "unavailable" || reason === "timed_out" || reason === "aborted";
  }
}

export interface BoundedProcessOptions {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly stdin?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface BoundedProcessResult {
  readonly exitCode: 0;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

const controlledEnvironment = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
});

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalAbsolutePath(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

function byteSequence(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) &&
    (value as { readonly BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === 1;
}

function validOptions(options: BoundedProcessOptions, argv: readonly string[]): boolean {
  return canonicalAbsolutePath(options.executable) && canonicalAbsolutePath(options.cwd) &&
    Array.isArray(options.argv) && argv.length <= PROCESS_RUNNER_LIMITS.maxArguments &&
    argv.every((argument) => typeof argument === "string" && !argument.includes("\0") &&
      new TextEncoder().encode(argument).byteLength <= PROCESS_RUNNER_LIMITS.maxArgumentBytes) &&
    positiveSafeInteger(options.timeoutMs) && options.timeoutMs <= PROCESS_RUNNER_LIMITS.maxTimeoutMs &&
    positiveSafeInteger(options.stdoutLimitBytes) &&
    options.stdoutLimitBytes <= PROCESS_RUNNER_LIMITS.maxStdoutBytes &&
    positiveSafeInteger(options.stderrLimitBytes) &&
    options.stderrLimitBytes <= PROCESS_RUNNER_LIMITS.maxStderrBytes &&
    (options.stdin === undefined ||
      (byteSequence(options.stdin) && options.stdin.byteLength <= PROCESS_RUNNER_LIMITS.maxStdinBytes));
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): ReturnType<typeof setTimeout> {
  const sendSignal = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process may have exited between the state check and the group signal.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Process termination is best effort after a terminal normalized result was selected.
    }
  };
  sendSignal("SIGTERM");
  const killTimer = setTimeout(() => sendSignal("SIGKILL"), PROCESS_RUNNER_LIMITS.killGraceMs);
  killTimer.unref();
  return killTimer;
}

export async function runBoundedProcess(
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  const argv = Object.freeze([...options.argv]);
  if (!validOptions(options, argv)) throw new BoundedProcessError("invalid_configuration");
  if (options.signal?.aborted === true) throw new BoundedProcessError("aborted");

  return await new Promise<BoundedProcessResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.executable, argv, {
        cwd: options.cwd,
        env: controlledEnvironment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rejectPromise(new BoundedProcessError("unavailable"));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: BoundedProcessFailureReason | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const selectFailure = (reason: BoundedProcessFailureReason): void => {
      if (failure !== undefined) return;
      failure = reason;
      killTimer = terminateProcessTree(child);
    };

    const timeout = setTimeout(() => selectFailure("timed_out"), options.timeoutMs);
    const onAbort = (): void => selectFailure("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.stdoutLimitBytes) {
        selectFailure("stdout_limit_exceeded");
      } else if (failure === undefined) {
        stdoutChunks.push(Buffer.from(chunk));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.stderrLimitBytes) {
        selectFailure("stderr_limit_exceeded");
      } else if (failure === undefined) {
        stderrChunks.push(Buffer.from(chunk));
      }
    });
    child.stdin.on("error", () => undefined);
    if (options.stdin === undefined) child.stdin.end();
    else child.stdin.end(Buffer.from(options.stdin));

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.once("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new BoundedProcessError(failure ?? "unavailable"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure !== undefined) {
        rejectPromise(new BoundedProcessError(failure));
      } else if (code !== 0) {
        rejectPromise(new BoundedProcessError("nonzero_exit"));
      } else {
        resolvePromise(Object.freeze({
          exitCode: 0 as const,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes),
          stderr: Buffer.concat(stderrChunks, stderrBytes),
        }));
      }
    });
  });
}
