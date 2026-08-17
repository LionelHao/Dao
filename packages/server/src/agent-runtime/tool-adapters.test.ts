import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHttpJsonReadAdapter } from "./tools/http-json-read.js";
import { createRepositoryGitStatusAdapter } from "./tools/repository-git-status.js";
import { createSandboxFileWriteAdapter } from "./tools/sandbox-file-write.js";

const invocation = {
  executionId: "execution-1",
  attemptSeq: 1,
  roomId: "room-1",
  agentId: "agent-1",
  signal: new AbortController().signal,
} as const;

describe("production tool adapters", () => {
  it("reads only configured-origin HTTPS JSON with bounded closed output", async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true,"secret":"body"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const adapter = createHttpJsonReadAdapter({
      origin: "https://data.example.test",
      pathPrefix: "/v1/records/",
      maxResponseBytes: 1_024,
      fetch,
    });
    const outcome = await adapter.execute({
      ...invocation,
      parameters: { path: "42" },
    });
    expect(fetch).toHaveBeenCalledWith("https://data.example.test/v1/records/42", expect.objectContaining({
      method: "GET",
      redirect: "error",
      signal: invocation.signal,
    }));
    expect(outcome.summary).toEqual(expect.objectContaining({ schemaValid: true, statusCategory: "success" }));
    expect(outcome.summary).not.toHaveProperty("body");
    expect(outcome.modelInput).toBe('{"ok":true,"secret":"body"}');
    await expect(adapter.execute({ ...invocation, parameters: { path: "../admin" } }))
      .rejects.toMatchObject({ code: "invalid_parameters" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("executes the configured Git binary with fixed argv and no shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "dao-agent-git-"));
    try {
      execFileSync("/usr/bin/git", ["-C", root, "init", "--quiet"]);
      writeFileSync(join(root, "tracked.txt"), "one", "utf8");
      execFileSync("/usr/bin/git", ["-C", root, "add", "tracked.txt"]);
      execFileSync("/usr/bin/git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "init", "--quiet"]);
      writeFileSync(join(root, "tracked.txt"), "two", "utf8");
      const adapter = createRepositoryGitStatusAdapter({
        binaryPath: "/usr/bin/git",
        repositoryRoot: root,
        maxOutputBytes: 8_192,
        timeoutMs: 2_000,
      });
      const outcome = await adapter.execute({ ...invocation, parameters: {} });
      expect(outcome.summary).toEqual(expect.objectContaining({ exitCategory: "success", lineCount: 1 }));
      expect(outcome.modelInput).toContain("tracked.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes only beneath the sandbox and compensates with a sealed token and hash fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "dao-agent-sandbox-"));
    try {
      const adapter = createSandboxFileWriteAdapter({
        root,
        compensationKey: randomBytes(32),
        maxContentBytes: 1_024,
      });
      const absentHash = createHash("sha256").update("").digest("hex");
      const outcome = await adapter.execute({
        ...invocation,
        parameters: { path: "notes/result.txt", content: "approved", expectedCurrentSha256: absentHash },
      });
      expect(readFileSync(join(root, "notes/result.txt"), "utf8")).toBe("approved");
      expect(outcome.compensationToken).toBeTypeOf("string");
      expect(outcome.compensationToken).not.toContain("approved");
      await adapter.compensate!(outcome.compensationToken!, invocation.signal);
      expect(() => readFileSync(join(root, "notes/result.txt"), "utf8")).toThrow();
      await expect(adapter.execute({
        ...invocation,
        parameters: { path: "../escape.txt", content: "x", expectedCurrentSha256: absentHash },
      })).rejects.toMatchObject({ code: "invalid_parameters" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
