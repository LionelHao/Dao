import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRuntimeToolAdapterError,
  createHttpJsonReadTool,
  createRepositoryGitStatusTool,
  createSandboxFileWriteTool,
} from "./tool-adapters.js";

const execFile = promisify((await import("node:child_process")).execFile);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function holdKernelLock(lockPath: string): Promise<{
  readonly release: () => Promise<void>;
  readonly crash: () => Promise<void>;
}> {
  const descriptor = await open(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  const child = spawn(
    "/usr/bin/lockf",
    ["-k", "-t", "0", "/dev/fd/3", process.execPath, "-e",
      "process.stdout.write('locked\\n');process.stdin.resume();" +
      "process.stdin.once('end',()=>process.exit(0));"],
    { stdio: ["pipe", "pipe", "pipe", descriptor.fd] },
  );
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdin === null || stdout === null || stderr === null) {
    child.kill("SIGKILL");
    await descriptor.close();
    throw new Error("lockf test holder did not expose stdio");
  }
  stdin.on("error", () => undefined);
  stderr.resume();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const handleData = (chunk: Buffer): void => {
      cleanup();
      if (chunk.toString("utf8") === "locked\n") resolvePromise();
      else rejectPromise(new Error("lockf test holder emitted invalid readiness"));
    };
    const handleClose = (): void => {
      cleanup();
      rejectPromise(new Error("lockf test holder exited before readiness"));
    };
    const handleError = (error: Error): void => {
      cleanup();
      rejectPromise(error);
    };
    const cleanup = (): void => {
      stdout.off("data", handleData);
      child.off("close", handleClose);
      child.off("error", handleError);
    };
    stdout.once("data", handleData);
    child.once("close", handleClose);
    child.once("error", handleError);
  });
  const stop = async (crash: boolean): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      if (crash) child.kill("SIGKILL");
      else stdin.end();
      await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
    }
    await descriptor.close();
  };
  return {
    release: async () => stop(false),
    crash: async () => stop(true),
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("physical Agent runtime tool adapters", () => {
  it("exposes the three frozen closed descriptors", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-tools-red-"));
    temporaryDirectories.push(root);
    const http = createHttpJsonReadTool({
      origin: "https://api.example.com",
      pathTemplate: "/items/{id}",
      resolveHostname: async () => ["93.184.216.34"],
      fetchImpl: async () => new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
    });
    const git = createRepositoryGitStatusTool({
      gitBinaryPath: "/usr/bin/git",
      repositoryRoot: root,
    });
    const sandbox = createSandboxFileWriteTool({
      root,
      compensationKey: Buffer.alloc(32, 7),
    });

    expect([
      http.descriptor.id,
      git.descriptor.id,
      sandbox.adapter.descriptor.id,
    ]).toEqual(["http-json.read", "repository.git-status", "sandbox-file.write"]);
  });

  it("fills only configured HTTPS path and query parameters and returns bounded JSON", async () => {
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const adapter = createHttpJsonReadTool({
      origin: "https://api.example.com",
      pathTemplate: "/items/{id}",
      queryParameterNames: ["view"],
      resolveHostname: async () => ["93.184.216.34"],
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/problem+json; charset=utf-8" },
        });
      },
    });

    const outcome = await adapter.execute({ id: "a/b?c", view: "full & safe" }, new AbortController().signal);
    expect(requests).toEqual([{
      url: "https://api.example.com/items/a%2Fb%3Fc?view=full+%26+safe",
      init: expect.objectContaining({ method: "GET", redirect: "error" }),
    }]);
    expect(outcome.modelInput).toEqual({ ok: true });
    expect(outcome.closedSummary).toMatch(/^http_json_read:200:11:[0-9a-f]{64}$/u);
  });

  it.each([
    ["private DNS", async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      async () => ["10.0.0.1"], "target_forbidden"],
    ["mapped loopback DNS", async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      async () => ["::ffff:7f00:1"], "target_forbidden"],
    ["IPv6 link-local DNS", async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      async () => ["fe90::1"], "target_forbidden"],
    ["IPv4 benchmark DNS", async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      async () => ["198.18.0.1"], "target_forbidden"],
    ["non JSON", async () => new Response("secret body", { headers: { "content-type": "text/plain" } }),
      async () => ["93.184.216.34"], "tool_failed"],
    ["decompressed overflow", async () => new Response("😀".repeat(20), {
      headers: { "content-type": "application/json" },
    }),
      async () => ["93.184.216.34"], "response_too_large"],
  ] as const)("refuses HTTP JSON %s before exposing a body", async (_label, fetchImpl, resolveHostname, code) => {
    let fetchCalls = 0;
    const adapter = createHttpJsonReadTool({
      origin: "https://api.example.com",
      pathTemplate: "/fixed",
      maxResponseBytes: 32,
      resolveHostname,
      fetchImpl: async (...args) => {
        fetchCalls += 1;
        return fetchImpl(...args);
      },
    });
    await expect(adapter.execute({}, new AbortController().signal))
      .rejects.toMatchObject({ code });
    if (code === "target_forbidden") expect(fetchCalls).toBe(0);
  });

  it("refuses redirects, IP literals, extra parameters, and pre-aborted HTTP work", async () => {
    let fetchCalls = 0;
    const adapter = createHttpJsonReadTool({
      origin: "https://api.example.com",
      pathTemplate: "/fixed",
      resolveHostname: async () => ["93.184.216.34"],
      fetchImpl: async () => {
        fetchCalls += 1;
        const response = new Response("{}", {
          headers: { "content-type": "application/json" },
        });
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    });
    await expect(adapter.execute({ extra: "forged" }, new AbortController().signal))
      .rejects.toMatchObject({ code: "invalid_parameters" });
    await expect(adapter.execute({}, new AbortController().signal))
      .rejects.toMatchObject({ code: "target_forbidden" });
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(adapter.execute({}, controller.signal)).rejects.toThrow("stop");
    expect(fetchCalls).toBe(1);

    expect(() => createHttpJsonReadTool({
      origin: "https://127.0.0.1",
      pathTemplate: "/fixed",
    })).not.toThrow();
    const literal = createHttpJsonReadTool({ origin: "https://127.0.0.1", pathTemplate: "/fixed" });
    await expect(literal.execute({}, new AbortController().signal))
      .rejects.toMatchObject({ code: "target_forbidden" });
  });

  it("aborts blocked DNS and response reads without waiting for the dependency", async () => {
    const dnsController = new AbortController();
    const dns = createHttpJsonReadTool({
      origin: "https://api.example.com",
      pathTemplate: "/fixed",
      resolveHostname: () => new Promise<readonly string[]>(() => undefined),
    });
    const dnsPending = dns.execute({}, dnsController.signal);
    dnsController.abort(new Error("cancel blocked DNS"));
    await expect(dnsPending).rejects.toThrow("cancel blocked DNS");

    let cancelCalls = 0;
    let releaseCalls = 0;
    const readEntered = Promise.withResolvers<void>();
    const reader = {
      read: () => {
        readEntered.resolve();
        return new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined);
      },
      cancel: async () => { cancelCalls += 1; },
      releaseLock: () => { releaseCalls += 1; },
    };
    const response = {
      redirected: false,
      url: "https://api.example.com/fixed",
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: { getReader: () => reader },
    } as unknown as Response;
    const readController = new AbortController();
    const read = createHttpJsonReadTool({
      origin: "https://api.example.com", pathTemplate: "/fixed",
      resolveHostname: async () => ["93.184.216.34"],
      fetchImpl: async () => response,
    });
    const readPending = read.execute({}, readController.signal);
    await readEntered.promise;
    readController.abort(new Error("cancel blocked response read"));
    await expect(readPending).rejects.toThrow("cancel blocked response read");
    expect(cancelCalls).toBeGreaterThanOrEqual(1);
    expect(releaseCalls).toBe(1);
  });

  it("spawns only the fixed Git status command with an allowlisted environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-git-status-"));
    temporaryDirectories.push(root);
    await execFile("/usr/bin/git", ["-C", root, "init", "--quiet"]);
    await writeFile(join(root, "tracked.txt"), "before\n", "utf8");
    await execFile("/usr/bin/git", ["-C", root, "add", "tracked.txt"]);
    await execFile("/usr/bin/git", [
      "-C", root, "-c", "user.name=Native IM Test", "-c", "user.email=test@native.invalid",
      "commit", "--quiet", "-m", "initial",
    ]);
    await writeFile(join(root, "tracked.txt"), "after\n", "utf8");
    await writeFile(join(root, "untracked-secret.txt"), "must not be listed\n", "utf8");
    const calls: Array<{ readonly file: string; readonly args: readonly string[]; readonly options: object }> = [];
    const spawnImpl: typeof spawn = ((file: string, args: readonly string[], options: object) => {
      calls.push({ file, args, options });
      return spawn(file, args, options);
    }) as typeof spawn;
    const adapter = createRepositoryGitStatusTool({
      gitBinaryPath: "/usr/bin/git",
      repositoryRoot: root,
      environment: {
        LANG: "C",
        HOME: "/must-not-cross",
        NATIVE_IM_SENTINEL: "must-not-cross",
      },
      spawnImpl,
    });

    const outcome = await adapter.execute({}, new AbortController().signal);
    const canonicalRoot = resolve(await import("node:fs/promises").then(({ realpath }) => realpath(root)));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      file: "/usr/bin/git",
      args: ["-c", "core.fsmonitor=false", "-C", canonicalRoot, "ls-files", "--stage", "-z"],
      options: expect.objectContaining({
        shell: false,
        env: {
          LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
        },
      }),
    });
    expect(calls[1]).toEqual({
      file: "/usr/bin/git",
      args: ["-C", canonicalRoot, "ls-tree", "-r", "-z", "HEAD"],
      options: expect.objectContaining({
        shell: false,
        env: {
          LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      }),
    });
    expect(outcome.modelInput).toEqual({
      clean: false,
      changes: [{ status: " M", path: "tracked.txt" }],
    });
    expect(JSON.stringify(outcome)).not.toContain("untracked-secret");
    await expect(adapter.execute({ argv: ["-c", "evil"] }, new AbortController().signal))
      .rejects.toMatchObject({ code: "invalid_parameters" });
  });

  it("disables repository-local fsmonitor commands before reading Git status", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-git-fsmonitor-"));
    temporaryDirectories.push(root);
    await execFile("/usr/bin/git", ["-C", root, "init", "--quiet"]);
    const marker = join(root, "fsmonitor-executed");
    const hook = join(root, "fsmonitor.sh");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    await execFile("/usr/bin/git", ["-C", root, "config", "core.fsmonitor", hook]);
    const adapter = createRepositoryGitStatusTool({
      gitBinaryPath: "/usr/bin/git",
      repositoryRoot: root,
    });
    await expect(adapter.execute({}, new AbortController().signal)).resolves.toMatchObject({
      modelInput: { clean: true },
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses every repository-defined clean filter before Git can execute it", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-git-filter-"));
    temporaryDirectories.push(root);
    await execFile("/usr/bin/git", ["-C", root, "init", "--quiet"]);
    const marker = join(root, "filter-executed");
    const filter = join(root, "filter.sh");
    await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
    await writeFile(join(root, ".gitattributes"), "*.txt filter=evil\n", "utf8");
    await writeFile(join(root, "tracked.txt"), "before\n", "utf8");
    await execFile("/usr/bin/git", ["-C", root, "add", ".gitattributes", "tracked.txt"]);
    await execFile("/usr/bin/git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com",
      "commit", "--quiet", "-m", "initial"]);
    await execFile("/usr/bin/git", ["-C", root, "config", "filter.evil.clean", filter]);
    await writeFile(join(root, "tracked.txt"), "after\n", "utf8");
    const adapter = createRepositoryGitStatusTool({
      gitBinaryPath: "/usr/bin/git",
      repositoryRoot: root,
    });
    await expect(adapter.execute({}, new AbortController().signal)).resolves.toMatchObject({
      modelInput: { clean: false, changes: [{ status: " M", path: "tracked.txt" }] },
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not execute a clean filter injected between its two fixed Git reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-git-filter-race-"));
    temporaryDirectories.push(root);
    await execFile("/usr/bin/git", ["-C", root, "init", "--quiet"]);
    const marker = join(root, "filter-race-executed");
    const filter = join(root, "filter-race.sh");
    await writeFile(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
    await writeFile(join(root, ".gitattributes"), "*.txt filter=evil\n", "utf8");
    await writeFile(join(root, "tracked.txt"), "before\n", "utf8");
    await execFile("/usr/bin/git", ["-C", root, "add", ".gitattributes", "tracked.txt"]);
    await execFile("/usr/bin/git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com",
      "commit", "--quiet", "-m", "initial"]);
    await writeFile(join(root, "tracked.txt"), "after\n", "utf8");
    let calls = 0;
    const spawnImpl: typeof spawn = ((file: string, args: readonly string[], options: object) => {
      calls += 1;
      if (calls === 2) {
        execFileSync("/usr/bin/git", ["-C", root, "config", "filter.evil.clean", filter]);
      }
      return spawn(file, args, options);
    }) as typeof spawn;
    const adapter = createRepositoryGitStatusTool({
      gitBinaryPath: "/usr/bin/git", repositoryRoot: root, spawnImpl,
    });
    await expect(adapter.execute({}, new AbortController().signal)).resolves.toMatchObject({
      modelInput: { clean: false },
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates Git abort instead of converting it into a retryable tool failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-git-abort-"));
    temporaryDirectories.push(root);
    const controller = new AbortController();
    controller.abort(new Error("runtime cancelled"));
    const adapter = createRepositoryGitStatusTool({
      gitBinaryPath: "/usr/bin/git",
      repositoryRoot: root,
    });
    await expect(adapter.execute({}, controller.signal)).rejects.toThrow("runtime cancelled");
  });

  it("kills an in-flight Git process and preserves the abort reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-git-inflight-abort-"));
    temporaryDirectories.push(root);
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const spawnImpl: typeof spawn = ((_file: string, _args: readonly string[], options: object) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
      entered.resolve();
      return child;
    }) as typeof spawn;
    const adapter = createRepositoryGitStatusTool({
      gitBinaryPath: "/usr/bin/git",
      repositoryRoot: root,
      spawnImpl,
    });
    const pending = adapter.execute({}, controller.signal);
    await entered.promise;
    controller.abort(new Error("runtime cancelled in flight"));
    await expect(pending).rejects.toThrow("runtime cancelled in flight");
  });

  it("atomically replaces a sandbox file and restores it from a sealed hash-bound compensation", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-write-"));
    temporaryDirectories.push(root);
    const target = join(root, "note.txt");
    await writeFile(target, "before", "utf8");
    const sandbox = createSandboxFileWriteTool({ root, compensationKey: Buffer.alloc(32, 3) });
    const outcome = await sandbox.adapter.execute({
      path: "note.txt",
      content: "after",
      expectedCurrentSha256: hash("before"),
    }, new AbortController().signal);

    expect(await readFile(target, "utf8")).toBe("after");
    expect(outcome.modelInput).toEqual({ path: "note.txt", byteLength: 5, sha256: hash("after") });
    expect(outcome.closedSummary).toBe(`sandbox_write:replace:5:${hash("after")}`);
    expect(outcome.sealedCompensation).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(outcome.sealedCompensation).not.toContain(Buffer.from("before").toString("base64"));

    await expect(sandbox.compensate(outcome.sealedCompensation as string, new AbortController().signal))
      .resolves.toMatchObject({ modelInput: { path: "note.txt", restored: true } });
    expect(await readFile(target, "utf8")).toBe("before");
  });

  it("deletes a compensated creation and refuses compensation after a later human edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-compensation-"));
    temporaryDirectories.push(root);
    const sandbox = createSandboxFileWriteTool({ root, compensationKey: Buffer.alloc(32, 5) });
    const created = await sandbox.adapter.execute({
      path: "created.txt", content: "created", expectedCurrentSha256: null,
    }, new AbortController().signal);
    await sandbox.compensate(created.sealedCompensation as string, new AbortController().signal);
    await expect(readFile(join(root, "created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const replacementTarget = join(root, "replacement.txt");
    await writeFile(replacementTarget, "before", "utf8");
    const replacement = await sandbox.adapter.execute({
      path: "replacement.txt", content: "after", expectedCurrentSha256: hash("before"),
    }, new AbortController().signal);
    await writeFile(replacementTarget, "human edit", "utf8");
    await expect(sandbox.compensate(
      replacement.sealedCompensation as string,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "target_conflict" });
    expect(await readFile(replacementTarget, "utf8")).toBe("human edit");
  });

  it("marks post-effect directory durability failures unknown for writes and compensation", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-durability-"));
    temporaryDirectories.push(root);
    const sandbox = createSandboxFileWriteTool({ root, compensationKey: Buffer.alloc(32, 11) });
    type SyncableHandle = {
      sync(): Promise<void>;
      stat(): Promise<{ isDirectory(): boolean }>;
    };
    const installDirectorySyncFailure = async (failOnDirectorySync = 1) => {
      const descriptor = await open(root, "r");
      const prototype = Object.getPrototypeOf(descriptor) as SyncableHandle;
      await descriptor.close();
      const original = prototype.sync;
      let directorySyncs = 0;
      return vi.spyOn(prototype, "sync").mockImplementation(async function (this: SyncableHandle) {
        if ((await this.stat()).isDirectory() && ++directorySyncs === failOnDirectorySync) {
          throw new Error("directory sync unavailable");
        }
        return original.call(this);
      });
    };

    // The first directory sync persists the write journal; fail the target-name sync.
    const writeSync = await installDirectorySyncFailure(2);
    const writeError = await sandbox.adapter.execute({
      path: "write.txt", content: "after", expectedCurrentSha256: null,
    }, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as AgentRuntimeToolAdapterError,
    );
    writeSync.mockRestore();
    expect(writeError).toMatchObject({
      code: "tool_failed", effectOutcomeUnknown: true,
      sealedCompensation: expect.stringMatching(/^v1\./u),
    });
    expect(await readFile(join(root, "write.txt"), "utf8")).toBe("after");
    expect(await readFile(
      join(root, `.native-im-write-${hash(join(await realpath(root), "write.txt"))}`),
      "utf8",
    )).toBe("after");

    const replaceTarget = join(await realpath(root), "replace.txt");
    const replaceCapture = join(root, `.native-im-capture-${hash(replaceTarget)}`);
    const replaceWrite = join(root, `.native-im-write-${hash(replaceTarget)}`);
    await writeFile(replaceTarget, "before", "utf8");
    // write journal sync, capture sync, then fail the first target-name sync.
    const replaceSync = await installDirectorySyncFailure(3);
    await expect(sandbox.adapter.execute({
      path: "replace.txt", content: "after", expectedCurrentSha256: hash("before"),
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "tool_failed", effectOutcomeUnknown: true,
      sealedCompensation: expect.stringMatching(/^v1\./u),
    });
    replaceSync.mockRestore();
    expect(await readFile(replaceTarget, "utf8")).toBe("after");
    expect(await readFile(replaceCapture, "utf8")).toBe("before");
    expect(await readFile(replaceWrite, "utf8")).toBe("after");
    await expect(sandbox.adapter.execute({
      path: "replace.txt", content: "recovered", expectedCurrentSha256: hash("after"),
    }, new AbortController().signal)).resolves.toMatchObject({
      modelInput: { path: "replace.txt" },
    });
    expect(await readFile(replaceTarget, "utf8")).toBe("recovered");
    await expect(readFile(replaceCapture)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(replaceWrite)).rejects.toMatchObject({ code: "ENOENT" });

    const compensationTarget = join(await realpath(root), "restore.txt");
    const compensationCapture = join(root, `.native-im-capture-${hash(compensationTarget)}`);
    const compensationWrite = join(root, `.native-im-write-${hash(compensationTarget)}`);
    await writeFile(compensationTarget, "before", "utf8");
    const replaced = await sandbox.adapter.execute({
      path: "restore.txt", content: "after", expectedCurrentSha256: hash("before"),
    }, new AbortController().signal);
    // capture sync, write journal sync, then fail the restored target-name sync.
    const restoreWriteSync = await installDirectorySyncFailure(3);
    await expect(sandbox.compensate(
      replaced.sealedCompensation as string,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "tool_failed", effectOutcomeUnknown: true });
    restoreWriteSync.mockRestore();
    expect(await readFile(compensationTarget, "utf8")).toBe("before");
    expect(await readFile(compensationCapture, "utf8")).toBe("after");
    expect(await readFile(compensationWrite, "utf8")).toBe("before");
    await expect(sandbox.adapter.execute({
      path: "restore.txt", content: "recovered", expectedCurrentSha256: hash("before"),
    }, new AbortController().signal)).resolves.toMatchObject({
      modelInput: { path: "restore.txt" },
    });
    expect(await readFile(compensationTarget, "utf8")).toBe("recovered");
    await expect(readFile(compensationCapture)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(compensationWrite)).rejects.toMatchObject({ code: "ENOENT" });

    const created = await sandbox.adapter.execute({
      path: "delete.txt", content: "created", expectedCurrentSha256: null,
    }, new AbortController().signal);
    // First directory sync persists target->journal capture. The second happens after
    // the requested deletion and therefore represents an ambiguous post-effect failure.
    const deleteSync = await installDirectorySyncFailure(2);
    await expect(sandbox.compensate(
      created.sealedCompensation as string,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "tool_failed", effectOutcomeUnknown: true });
    deleteSync.mockRestore();
    await expect(readFile(join(root, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes same-target expected-hash writes so only one compare-and-swap succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-cas-"));
    temporaryDirectories.push(root);
    const target = join(root, "cas.txt");
    await writeFile(target, "before", "utf8");
    const sandbox = createSandboxFileWriteTool({ root, compensationKey: Buffer.alloc(32, 6) });
    const input = (content: string) => sandbox.adapter.execute({
      path: "cas.txt", content, expectedCurrentSha256: hash("before"),
    }, new AbortController().signal);
    const results = await Promise.allSettled([input("first"), input("second")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "target_conflict" }) }),
    ]);
    expect(["first", "second"]).toContain(await readFile(target, "utf8"));
  });

  it("never overwrites a non-cooperating writer after atomically capturing the expected version", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-external-cas-"));
    temporaryDirectories.push(root);
    const canonicalRoot = await realpath(root);
    const forwardTarget = join(canonicalRoot, "forward.txt");
    await writeFile(forwardTarget, "before", "utf8");
    let raceTarget: string | undefined = forwardTarget;
    const sandbox = createSandboxFileWriteTool({
      root,
      compensationKey: Buffer.alloc(32, 6),
      async afterTargetCapture(target) {
        if (target !== raceTarget) return;
        raceTarget = undefined;
        await writeFile(target, "later human edit", "utf8");
      },
    });
    await expect(sandbox.adapter.execute({
      path: "forward.txt", content: "adapter", expectedCurrentSha256: hash("before"),
    }, new AbortController().signal)).rejects.toMatchObject({ code: "target_conflict" });
    expect(await readFile(forwardTarget, "utf8")).toBe("later human edit");

    const replacementTarget = join(canonicalRoot, "compensate.txt");
    await writeFile(replacementTarget, "before", "utf8");
    const written = await sandbox.adapter.execute({
      path: "compensate.txt", content: "adapter", expectedCurrentSha256: hash("before"),
    }, new AbortController().signal);
    raceTarget = replacementTarget;
    await expect(sandbox.compensate(
      written.sealedCompensation as string,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "target_conflict" });
    expect(await readFile(replacementTarget, "utf8")).toBe("later human edit");
  });

  it("linearizes compensation deletion before and preserves a later non-cooperating creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-external-delete-"));
    temporaryDirectories.push(root);
    const target = join(root, "created.txt");
    let injectLaterCreation = false;
    const sandbox = createSandboxFileWriteTool({
      root,
      compensationKey: Buffer.alloc(32, 6),
      async afterTargetCapture(capturedTarget) {
        if (!injectLaterCreation) return;
        injectLaterCreation = false;
        await writeFile(capturedTarget, "later human creation", "utf8");
      },
    });
    const written = await sandbox.adapter.execute({
      path: "created.txt", content: "adapter", expectedCurrentSha256: null,
    }, new AbortController().signal);
    injectLaterCreation = true;
    await expect(sandbox.compensate(
      written.sealedCompensation as string,
      new AbortController().signal,
    )).resolves.toMatchObject({ modelInput: { path: "created.txt", restored: false } });
    expect(await readFile(target, "utf8")).toBe("later human creation");
  });

  it("keeps a later contender out while a fixed target lock owner is still alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-live-lock-"));
    temporaryDirectories.push(root);
    const target = join(root, "blocked.txt");
    await writeFile(target, "before", "utf8");
    const canonicalTarget = join(await realpath(root), "blocked.txt");
    const lockName = `.native-im-lock-${hash(canonicalTarget)}.lock`;
    const holder = await holdKernelLock(join(root, lockName));
    const sandbox = createSandboxFileWriteTool({ root, compensationKey: Buffer.alloc(32, 6) });
    await expect(sandbox.adapter.execute({
      path: "blocked.txt", content: "second", expectedCurrentSha256: hash("before"),
    }, new AbortController().signal)).rejects.toMatchObject({ code: "target_conflict" });
    expect(await readFile(target, "utf8")).toBe("before");
    await holder.release();
    await expect(sandbox.adapter.execute({
      path: "blocked.txt", content: "second", expectedCurrentSha256: hash("before"),
    }, new AbortController().signal)).resolves.toMatchObject({ modelInput: { path: "blocked.txt" } });
  });

  it("releases a crashed kernel lock and keeps its persistent namespace unavailable to user paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-stale-lock-"));
    temporaryDirectories.push(root);
    const target = join(root, "recover.txt");
    await writeFile(target, "before", "utf8");
    const lockName = `.native-im-lock-${hash(join(await realpath(root), "recover.txt"))}.lock`;
    const holder = await holdKernelLock(join(root, lockName));
    await holder.crash();
    const sandbox = createSandboxFileWriteTool({ root, compensationKey: Buffer.alloc(32, 7) });
    await expect(sandbox.adapter.execute({
      path: "recover.txt", content: "after", expectedCurrentSha256: hash("before"),
    }, new AbortController().signal)).resolves.toMatchObject({
      modelInput: { path: "recover.txt" },
    });
    expect(await readdir(root)).toContain(lockName);
    await expect(sandbox.adapter.execute({
      path: ".native-im-lock-user", content: "forged", expectedCurrentSha256: null,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_parameters" });
  });

  it("opens persistent lock inodes without following links or reading oversized records", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-lock-record-"));
    const outside = await mkdtemp(join(tmpdir(), "native-im-sandbox-lock-record-outside-"));
    temporaryDirectories.push(root, outside);
    const sandbox = createSandboxFileWriteTool({ root, compensationKey: Buffer.alloc(32, 7) });
    for (const [path, lockSetup] of [
      ["linked.txt", async (lockPath: string) => {
        const oversized = join(outside, "oversized-record");
        await writeFile(oversized, "x".repeat(1_000_000), "utf8");
        await symlink(oversized, lockPath);
      }],
      ["oversized.txt", async (lockPath: string) => writeFile(lockPath, "x".repeat(1025), "utf8")],
    ] as const) {
      const target = join(await realpath(root), path);
      const lockPath = join(root, `.native-im-lock-${hash(target)}.lock`);
      await lockSetup(lockPath);
      await expect(sandbox.adapter.execute({
        path, content: "after", expectedCurrentSha256: null,
      }, new AbortController().signal)).rejects.toMatchObject({ code: "target_conflict" });
      await expect(readFile(join(root, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("recovers a captured pre-commit version after process loss without overwriting a newer target", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-capture-recovery-"));
    temporaryDirectories.push(root);
    const canonicalRoot = await realpath(root);
    const sandbox = createSandboxFileWriteTool({ root, compensationKey: Buffer.alloc(32, 7) });

    const missingTarget = join(canonicalRoot, "missing.txt");
    const missingCapture = join(
      canonicalRoot,
      `.native-im-capture-${hash(missingTarget)}`,
    );
    await writeFile(missingCapture, "crash version", "utf8");
    await expect(sandbox.adapter.execute({
      path: "missing.txt", content: "after recovery",
      expectedCurrentSha256: hash("crash version"),
    }, new AbortController().signal)).resolves.toMatchObject({
      modelInput: { path: "missing.txt" },
    });
    expect(await readFile(missingTarget, "utf8")).toBe("after recovery");
    await expect(readFile(missingCapture)).rejects.toMatchObject({ code: "ENOENT" });

    const newerTarget = join(canonicalRoot, "newer.txt");
    const staleCapture = join(canonicalRoot, `.native-im-capture-${hash(newerTarget)}`);
    await writeFile(staleCapture, "stale captured version", "utf8");
    await writeFile(newerTarget, "newer external version", "utf8");
    await expect(sandbox.adapter.execute({
      path: "newer.txt", content: "accepted replacement",
      expectedCurrentSha256: hash("newer external version"),
    }, new AbortController().signal)).resolves.toMatchObject({
      modelInput: { path: "newer.txt" },
    });
    expect(await readFile(newerTarget, "utf8")).toBe("accepted replacement");
    await expect(readFile(staleCapture)).rejects.toMatchObject({ code: "ENOENT" });

    const absentTarget = join(canonicalRoot, "uncommitted-create.txt");
    const uncommittedWrite = join(
      canonicalRoot,
      `.native-im-write-${hash(absentTarget)}`,
    );
    await writeFile(uncommittedWrite, "not committed", "utf8");
    await expect(sandbox.adapter.execute({
      path: "uncommitted-create.txt", content: "later request",
      expectedCurrentSha256: null,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "target_conflict" });
    await expect(readFile(absentTarget)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(uncommittedWrite, "utf8")).toBe("not committed");
  });

  it("keeps old bytes reachable across capture and restore directory-sync failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-journal-fsync-"));
    temporaryDirectories.push(root);
    const canonicalRoot = await realpath(root);
    type SyncableHandle = {
      sync(): Promise<void>;
      stat(): Promise<{ isDirectory(): boolean }>;
    };
    const descriptor = await open(root, "r");
    const prototype = Object.getPrototypeOf(descriptor) as SyncableHandle;
    await descriptor.close();
    const originalSync = prototype.sync;
    const failNextDirectorySync = () => {
      let failed = false;
      return vi.spyOn(prototype, "sync").mockImplementation(async function (this: SyncableHandle) {
        if (!failed && (await this.stat()).isDirectory()) {
          failed = true;
          throw new Error("directory sync unavailable");
        }
        return originalSync.call(this);
      });
    };

    const captureTargetPath = join(canonicalRoot, "capture-failure.txt");
    await writeFile(captureTargetPath, "old bytes", "utf8");
    const sandbox = createSandboxFileWriteTool({ root, compensationKey: Buffer.alloc(32, 7) });
    const captureSync = failNextDirectorySync();
    await expect(sandbox.adapter.execute({
      path: "capture-failure.txt", content: "new bytes",
      expectedCurrentSha256: hash("old bytes"),
    }, new AbortController().signal)).rejects.toMatchObject({ code: "tool_failed" });
    captureSync.mockRestore();
    expect(await readFile(captureTargetPath, "utf8")).toBe("old bytes");

    const restoreTargetPath = join(canonicalRoot, "restore-failure.txt");
    const restoreCapturePath = join(
      canonicalRoot,
      `.native-im-capture-${hash(restoreTargetPath)}`,
    );
    await writeFile(restoreCapturePath, "journal bytes", "utf8");
    const restoreSync = failNextDirectorySync();
    await expect(sandbox.adapter.execute({
      path: "restore-failure.txt", content: "new bytes",
      expectedCurrentSha256: hash("journal bytes"),
    }, new AbortController().signal)).rejects.toThrow("directory sync unavailable");
    restoreSync.mockRestore();
    expect(await readFile(restoreTargetPath, "utf8")).toBe("journal bytes");
    expect(await readFile(restoreCapturePath, "utf8")).toBe("journal bytes");
  });

  it("refuses sandbox traversal, symlink parents, stale hashes, and multibyte overflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-guards-"));
    const outside = await mkdtemp(join(tmpdir(), "native-im-sandbox-outside-"));
    temporaryDirectories.push(root, outside);
    await symlink(outside, join(root, "escape"));
    const sandbox = createSandboxFileWriteTool({
      root,
      compensationKey: Buffer.alloc(32, 9),
      maxContentBytes: 8,
    });
    for (const path of ["../outside.txt", "/absolute.txt", "a//b", "a/./b", "escape/file.txt"]) {
      await expect(sandbox.adapter.execute({
        path, content: "safe", expectedCurrentSha256: null,
      }, new AbortController().signal)).rejects.toBeInstanceOf(AgentRuntimeToolAdapterError);
    }
    await writeFile(join(root, "stale.txt"), "current", "utf8");
    await expect(sandbox.adapter.execute({
      path: "stale.txt", content: "next", expectedCurrentSha256: hash("old"),
    }, new AbortController().signal)).rejects.toMatchObject({ code: "target_conflict" });
    await expect(sandbox.adapter.execute({
      path: "large.txt", content: "😀😀😀", expectedCurrentSha256: null,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("refuses an oversized prior state before rename so its sealed token stays persistable", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-im-sandbox-prior-bound-"));
    temporaryDirectories.push(root);
    const target = join(root, "large-prior.txt");
    await writeFile(target, "x".repeat(32_769), "utf8");
    const sandbox = createSandboxFileWriteTool({
      root,
      compensationKey: Buffer.alloc(32, 4),
      maxContentBytes: 32_768,
    });
    await expect(sandbox.adapter.execute({
      path: "large-prior.txt", content: "small", expectedCurrentSha256: hash("x".repeat(32_769)),
    }, new AbortController().signal)).rejects.toMatchObject({ code: "response_too_large" });
    expect(await readFile(target, "utf8")).toBe("x".repeat(32_769));
  });

  const liveHttpUrl = process.env.NATIVE_IM_HTTP_TOOL_LIVE_URL;
  it.skipIf(
    process.env.NATIVE_IM_HTTP_TOOL_LIVE_SMOKE !== "1" || liveHttpUrl === undefined,
  )("reads one explicitly controlled HTTPS JSON target without exposing its body", async () => {
    const url = new URL(liveHttpUrl as string);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
        url.search !== "" || url.hash !== "") {
      throw new TypeError("NATIVE_IM_HTTP_TOOL_LIVE_URL must be one closed HTTPS target");
    }
    const adapter = createHttpJsonReadTool({
      origin: url.origin,
      pathTemplate: url.pathname,
    });
    const outcome = await adapter.execute({}, new AbortController().signal);
    expect(outcome.modelInput).toEqual(expect.any(Object));
    expect(outcome.closedSummary).toMatch(/^http_json_read:2\d\d:\d+:[0-9a-f]{64}$/u);
  });
});
