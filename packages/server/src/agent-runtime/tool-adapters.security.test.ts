import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHttpJsonReadAdapter } from "./tools/http-json-read.js";
import { createRepositoryGitStatusAdapter } from "./tools/repository-git-status.js";
import { createSandboxFileWriteAdapter } from "./tools/sandbox-file-write.js";

const invocation = (toolId: "http-json.read" | "repository.git-status" | "sandbox-file.write", parameters: Readonly<Record<string, unknown>>, signal = new AbortController().signal) => ({
  executionId: "execution-security",
  attemptSeq: 1,
  roomId: "room-security",
  agentId: "agent-security",
  callId: "call-security",
  grantId: "grant-security",
  dispatchId: "dispatch-security",
  toolId,
  parameters,
  signal,
} as const);

const absentHash = createHash("sha256").update("").digest("hex");

describe("FT-10 production adapter security", () => {
  it("fails production startup when descriptor-relative child traversal cannot be proven", () => {
    const root = mkdtempSync(join(tmpdir(), "dao-sandbox-readiness-"));
    try {
      const construct = () => createSandboxFileWriteAdapter({
        root,
        compensationKey: randomBytes(32),
        maxContentBytes: 1_024,
      });
      if (process.platform === "linux") expect(construct).not.toThrow();
      else expect(construct).toThrow(/descriptor-relative child traversal.*startup refused/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for private HTTP targets, rebound DNS, encodings and excessive JSON shape", async () => {
    expect(() => createHttpJsonReadAdapter({
      origin: "https://127.0.0.1",
      pathPrefix: "/v1/",
      maxResponseBytes: 1_024,
    })).toThrow(/IP literal|public/i);

    const fetch = vi.fn(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json", "content-encoding": "compress" },
    }));
    const encoded = createHttpJsonReadAdapter({
      origin: "https://data.example.test",
      pathPrefix: "/v1/",
      maxResponseBytes: 1_024,
      fetch,
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    await expect(encoded.execute(invocation("http-json.read", { path: "record" })))
      .rejects.toMatchObject({ outcome: "known_failed" });

    const shaped = createHttpJsonReadAdapter({
      origin: "https://data.example.test",
      pathPrefix: "/v1/",
      maxResponseBytes: 1_024,
      maxJsonDepth: 2,
      fetch: async () => new Response('{"a":{"b":{"c":1}}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    await expect(shaped.execute(invocation("http-json.read", { path: "record" })))
      .rejects.toMatchObject({ outcome: "known_failed" });

    const rebound = createHttpJsonReadAdapter({
      origin: "https://data.example.test",
      pathPrefix: "/v1/",
      maxResponseBytes: 1_024,
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await expect(rebound.execute(invocation("http-json.read", { path: "record" })))
      .rejects.toMatchObject({ outcome: "known_failed" });
  });

  it("conservatively rejects IPv6 transition, embedded, scoped, and special-purpose targets", async () => {
    const rejected = [
      "::192.168.1.1", // deprecated IPv4-compatible
      "::ffff:c0a8:101", // hexadecimal IPv4-mapped
      "64:ff9b::c0a8:101", // well-known NAT64
      "64:ff9b:1::c0a8:101", // local-use NAT64
      "2002:c0a8:0101::", // 6to4
      "2001::c0a8:101", // Teredo / IETF protocol assignment
      "100::1", // discard-only
      "3fff::1", // documentation
      "5f00::1", // segment-routing special-purpose block
      "fec0::1", // deprecated site-local
      "2620:4f:8000::1", // special-purpose AS112 service prefix
      "fe80::1%lo0", // scoped link-local
    ] as const;
    for (const address of rejected) {
      const adapter = createHttpJsonReadAdapter({
        origin: "https://data.example.test",
        pathPrefix: "/v1/",
        maxResponseBytes: 1_024,
        fetch: async () => new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        resolveHost: async () => [{ address, family: 6 }],
      });
      await expect(adapter.execute(invocation("http-json.read", { path: "record" })), address)
        .rejects.toMatchObject({ outcome: "known_failed" });
    }

    const publicIpv6 = createHttpJsonReadAdapter({
      origin: "https://data.example.test",
      pathPrefix: "/v1/",
      maxResponseBytes: 1_024,
      fetch: async () => new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      resolveHost: async () => [{ address: "2606:4700:4700::1111", family: 6 }],
    });
    await expect(publicIpv6.execute(invocation("http-json.read", { path: "record" })))
      .resolves.toMatchObject({ outcome: "known_succeeded" });
  });

  it("bounds declared and streamed HTTP bytes and applies one total abort deadline", async () => {
    const declared = createHttpJsonReadAdapter({
      origin: "https://data.example.test",
      pathPrefix: "/v1/",
      maxResponseBytes: 128,
      fetch: async () => new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "129" },
      }),
    });
    await expect(declared.execute(invocation("http-json.read", { path: "record" })))
      .rejects.toMatchObject({ outcome: "known_failed" });

    const streamed = createHttpJsonReadAdapter({
      origin: "https://data.example.test",
      pathPrefix: "/v1/",
      maxResponseBytes: 128,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(129)); controller.close(); },
      }), { headers: { "content-type": "application/json" } }),
    });
    await expect(streamed.execute(invocation("http-json.read", { path: "record" })))
      .rejects.toMatchObject({ outcome: "known_failed" });

    let observedAbort = false;
    const deadline = createHttpJsonReadAdapter({
      origin: "https://data.example.test",
      pathPrefix: "/v1/",
      maxResponseBytes: 128,
      timeoutMs: 100,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { observedAbort = true; reject(new Error("aborted")); }, { once: true });
      }),
    });
    await expect(deadline.execute(invocation("http-json.read", { path: "record" })))
      .rejects.toMatchObject({ outcome: "known_failed" });
    expect(observedAbort).toBe(true);

    const fetchAfterDns = vi.fn();
    const hungDns = createHttpJsonReadAdapter({
      origin: "https://data.example.test",
      pathPrefix: "/v1/",
      maxResponseBytes: 128,
      timeoutMs: 100,
      fetch: fetchAfterDns,
      resolveHost: async () => await new Promise<never>(() => undefined),
    });
    const before = Date.now();
    await expect(hungDns.execute(invocation("http-json.read", { path: "record" })))
      .rejects.toMatchObject({ outcome: "known_failed" });
    expect(Date.now() - before).toBeLessThan(500);
    expect(fetchAfterDns).not.toHaveBeenCalled();
  });

  it("pins Git root identity and returns bounded parsed records instead of raw output", async () => {
    const parent = mkdtempSync(join(tmpdir(), "dao-git-security-"));
    const root = join(parent, "repo");
    const replacement = join(parent, "replacement");
    try {
      mkdirSync(root);
      mkdirSync(replacement);
      execFileSync("/usr/bin/git", ["-C", root, "init", "--quiet"]);
      execFileSync("/usr/bin/git", ["-C", replacement, "init", "--quiet"]);
      const adapter = createRepositoryGitStatusAdapter({
        binaryPath: "/usr/bin/git",
        repositoryRoot: root,
        maxOutputBytes: 8_192,
        timeoutMs: 2_000,
        testOnlyAllowPathFallback: process.platform !== "linux",
      });
      rmSync(root, { recursive: true });
      symlinkSync(replacement, root);
      await expect(adapter.execute(invocation("repository.git-status", {})))
        .rejects.toMatchObject({ outcome: "known_failed" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("fails Git production startup when descriptor-anchored cwd is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "dao-git-readiness-"));
    try {
      const construct = () => createRepositoryGitStatusAdapter({
        binaryPath: "/usr/bin/git",
        repositoryRoot: root,
        maxOutputBytes: 8_192,
        timeoutMs: 2_000,
      });
      if (process.platform === "linux") expect(construct).not.toThrow();
      else expect(construct).toThrow(/descriptor-anchored repository cwd.*startup refused/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overrides repository-local core.fsmonitor so Git cannot launch an arbitrary process", async () => {
    const parent = mkdtempSync(join(tmpdir(), "dao-git-fsmonitor-"));
    const root = join(parent, "repo");
    const monitor = join(parent, "malicious-fsmonitor.sh");
    const marker = join(parent, "fsmonitor-ran");
    try {
      mkdirSync(root);
      execFileSync("/usr/bin/git", ["-C", root, "init", "--quiet"]);
      writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`);
      chmodSync(monitor, 0o700);
      execFileSync("/usr/bin/git", ["-C", root, "config", "core.fsmonitor", monitor]);
      execFileSync("/usr/bin/git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=no"]);
      expect(readFileSync(marker, "utf8")).toBe("");
      rmSync(marker);
      const adapter = createRepositoryGitStatusAdapter({
        binaryPath: "/usr/bin/git",
        repositoryRoot: root,
        maxOutputBytes: 8_192,
        timeoutMs: 2_000,
        testOnlyAllowPathFallback: process.platform !== "linux",
      });
      await expect(adapter.execute(invocation("repository.git-status", {})))
        .resolves.toMatchObject({ outcome: "known_succeeded" });
      expect(() => readFileSync(marker)).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("uses descriptor-anchored sandbox traversal and rejects symlinks and hardlinks", async () => {
    const parent = mkdtempSync(join(tmpdir(), "dao-sandbox-security-"));
    const root = join(parent, "root");
    const outside = join(parent, "outside");
    try {
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(outside, join(root, "linked"));
      const adapter = createSandboxFileWriteAdapter({
        root,
        compensationKey: randomBytes(32),
        maxContentBytes: 1_024,
        testOnlyAllowPathFallback: process.platform !== "linux",
      });
      await expect(adapter.execute(invocation("sandbox-file.write", {
        path: "linked/escape.txt", content: "escape", expectedCurrentSha256: absentHash,
      }))).rejects.toMatchObject({ outcome: "known_failed" });
      expect(() => readFileSync(join(outside, "escape.txt"))).toThrow();

      writeFileSync(join(root, "original.txt"), "same");
      linkSync(join(root, "original.txt"), join(root, "hardlink.txt"));
      await expect(adapter.execute(invocation("sandbox-file.write", {
        path: "hardlink.txt",
        content: "changed",
        expectedCurrentSha256: createHash("sha256").update("same").digest("hex"),
      }))).rejects.toMatchObject({ outcome: "known_failed" });
      expect(readFileSync(join(root, "original.txt"), "utf8")).toBe("same");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("bounds sandbox preimages and refuses compensation across a postimage hash change", async () => {
    const root = mkdtempSync(join(tmpdir(), "dao-sandbox-preimage-"));
    try {
      writeFileSync(join(root, "large.txt"), "12345");
      const adapter = createSandboxFileWriteAdapter({
        root,
        compensationKey: randomBytes(32),
        maxContentBytes: 1_024,
        maxPreimageBytes: 4,
        testOnlyAllowPathFallback: process.platform !== "linux",
      });
      await expect(adapter.execute(invocation("sandbox-file.write", {
        path: "large.txt",
        content: "new",
        expectedCurrentSha256: createHash("sha256").update("12345").digest("hex"),
      }))).rejects.toMatchObject({ outcome: "known_failed" });

      const normal = createSandboxFileWriteAdapter({
        root, compensationKey: randomBytes(32), maxContentBytes: 1_024,
        testOnlyAllowPathFallback: process.platform !== "linux",
      });
      const written = await normal.execute(invocation("sandbox-file.write", {
        path: "new.txt", content: "first", expectedCurrentSha256: absentHash,
      }));
      writeFileSync(join(root, "new.txt"), "later-user-change");
      await expect(normal.compensate!(written.compensationToken!, new AbortController().signal))
        .rejects.toMatchObject({ outcome: "known_failed", code: "execution_conflict" });
      expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("later-user-change");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies faults after sandbox rename as ambiguous and preserves the real postimage", async () => {
    const root = mkdtempSync(join(tmpdir(), "dao-sandbox-ambiguous-"));
    try {
      const adapter = createSandboxFileWriteAdapter({
        root,
        compensationKey: randomBytes(32),
        maxContentBytes: 1_024,
        testOnlyAllowPathFallback: process.platform !== "linux",
        testHooks: { afterRename() { throw new Error("fault-after-rename"); } },
      });
      await expect(adapter.execute(invocation("sandbox-file.write", {
        path: "uncertain.txt", content: "did-write", expectedCurrentSha256: absentHash,
      }))).rejects.toMatchObject({ outcome: "ambiguous" });
      expect(readFileSync(join(root, "uncertain.txt"), "utf8")).toBe("did-write");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports abort before rename as known failure without mutating the target", async () => {
    const root = mkdtempSync(join(tmpdir(), "dao-sandbox-abort-"));
    try {
      const adapter = createSandboxFileWriteAdapter({
        root,
        compensationKey: randomBytes(32),
        maxContentBytes: 1_024,
        testOnlyAllowPathFallback: process.platform !== "linux",
      });
      const controller = new AbortController();
      controller.abort();
      await expect(adapter.execute(invocation("sandbox-file.write", {
        path: "abort.txt", content: "never", expectedCurrentSha256: absentHash,
      }, controller.signal))).rejects.toMatchObject({ outcome: "known_failed" });
      expect(() => readFileSync(join(root, "abort.txt"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the sandbox real-time deadline before a hung pre-rename boundary can mutate", async () => {
    const root = mkdtempSync(join(tmpdir(), "dao-sandbox-deadline-"));
    try {
      const adapter = createSandboxFileWriteAdapter({
        root,
        compensationKey: randomBytes(32),
        maxContentBytes: 1_024,
        timeoutMs: 100,
        testOnlyAllowPathFallback: process.platform !== "linux",
        testHooks: { beforeRename: async () => await new Promise<void>(() => undefined) },
      });
      const before = Date.now();
      await expect(adapter.execute(invocation("sandbox-file.write", {
        path: "deadline.txt", content: "never", expectedCurrentSha256: absentHash,
      }))).rejects.toMatchObject({ outcome: "ambiguous" });
      expect(Date.now() - before).toBeLessThan(500);
      expect(() => readFileSync(join(root, "deadline.txt"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
