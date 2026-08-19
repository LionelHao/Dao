import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  BoundedProcessError,
  PROCESS_RUNNER_LIMITS,
  runBoundedProcess,
} from "./process-runner.js";

const base = {
  executable: process.execPath,
  cwd: tmpdir(),
  timeoutMs: 2_000,
  stdoutLimitBytes: 1_024,
  stderrLimitBytes: 1_024,
} as const;

describe("FT-04 bounded production process runner", () => {
  it("uses shell:false, a fixed argv copy, a controlled cwd, and a minimal environment", async () => {
    process.env.DAO_PROCESS_SECRET_SENTINEL = "must-not-cross";
    const argv = [
      "-e",
      "process.stdout.write(JSON.stringify({cwd:process.cwd(),secret:process.env.DAO_PROCESS_SECRET_SENTINEL??null,lang:process.env.LANG}))",
    ];
    try {
      const pending = runBoundedProcess({ ...base, argv });
      argv[1] = "process.exit(97)";
      const result = await pending;
      expect(JSON.parse(Buffer.from(result.stdout).toString("utf8"))).toEqual({
        cwd: await realpath(tmpdir()),
        secret: null,
        lang: "C",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.byteLength).toBe(0);
    } finally {
      delete process.env.DAO_PROCESS_SECRET_SENTINEL;
    }
  });

  it("rejects non-absolute executables and unbounded configuration before spawning", async () => {
    await expect(runBoundedProcess({ ...base, executable: "node", argv: ["--version"] }))
      .rejects.toMatchObject({ reason: "invalid_configuration" });
    await expect(runBoundedProcess({
      ...base,
      argv: ["--version"],
      stdoutLimitBytes: PROCESS_RUNNER_LIMITS.maxStdoutBytes + 1,
    })).rejects.toMatchObject({ reason: "invalid_configuration" });
  });

  it("kills a real child process at the timeout and reports no command or path", async () => {
    const started = Date.now();
    const executableCanary = `${process.execPath}-must-not-leak`;
    const failure = await runBoundedProcess({
      ...base,
      argv: ["-e", "setInterval(() => undefined, 10_000)"],
      timeoutMs: 40,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoundedProcessError);
    expect(failure).toMatchObject({ reason: "timed_out", retryable: true });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.stringify(failure)).not.toContain(process.execPath);
    expect(JSON.stringify(failure)).not.toContain(executableCanary);
  });

  it("kills real children crossing the stdout and stderr caps without retaining raw output", async () => {
    const stdoutCanary = "RAW_STDOUT_MUST_NOT_LEAK";
    const stderrCanary = "RAW_STDERR_MUST_NOT_LEAK";
    const stdoutFailure = await runBoundedProcess({
      ...base,
      argv: ["-e", `process.stdout.write("${stdoutCanary}".repeat(128))`],
      stdoutLimitBytes: 32,
    }).catch((error: unknown) => error);
    const stderrFailure = await runBoundedProcess({
      ...base,
      argv: ["-e", `process.stderr.write("${stderrCanary}".repeat(128))`],
      stderrLimitBytes: 32,
    }).catch((error: unknown) => error);

    expect(stdoutFailure).toMatchObject({ reason: "stdout_limit_exceeded" });
    expect(stderrFailure).toMatchObject({ reason: "stderr_limit_exceeded" });
    expect(JSON.stringify(stdoutFailure)).not.toContain(stdoutCanary);
    expect(JSON.stringify(stderrFailure)).not.toContain(stderrCanary);
  });

  it("normalizes spawn and non-zero failures without raw stderr, argv, stack, or executable path", async () => {
    const rawCanary = "ADAPTER_RAW_CANARY";
    const failure = await runBoundedProcess({
      ...base,
      argv: ["-e", `process.stderr.write("${rawCanary}");process.exit(9)`],
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: "nonzero_exit", retryable: false });
    expect((failure as Error).stack).toBeUndefined();
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(rawCanary);
    expect(serialized).not.toContain(process.execPath);
    expect(serialized).not.toContain("process.exit");

    const unavailable = await runBoundedProcess({
      ...base,
      executable: "/definitely/not/installed/dao-tool",
      argv: ["--version"],
    }).catch((error: unknown) => error);
    expect(unavailable).toMatchObject({ reason: "unavailable", retryable: true });
    expect(JSON.stringify(unavailable)).not.toContain("/definitely/not/installed");
  });
});
