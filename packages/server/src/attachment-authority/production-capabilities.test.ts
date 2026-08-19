import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_ATTACHMENT_VERSIONS,
  PRODUCTION_CLAMD_POLICY,
  probeProductionAttachmentCapabilities,
} from "./production-capabilities.js";

const roots: string[] = [];
const servers: Server[] = [];
const databaseSha256 = "a".repeat(64);

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dao-capability-probe-"));
  roots.push(root);
  return root;
}

async function versionFixture(
  root: string,
  name: string,
  output: string,
  target: "stdout" | "stderr" = "stdout",
): Promise<Readonly<{ executable: string; argv: readonly string[] }>> {
  const fixture = join(root, `${name}.mjs`);
  await writeFile(fixture, `process.${target}.write(${JSON.stringify(output)});\n`, { mode: 0o700 });
  await chmod(fixture, 0o700);
  return { executable: process.execPath, argv: Object.freeze([fixture, "--version"]) };
}

async function clamdFixture(version = "1.5.3"): Promise<Readonly<{
  kind: "tcp";
  host: "127.0.0.1";
  port: number;
}>> {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end(`ClamAV ${version}/27845/Wed Aug 19 09:00:00 2026\0`));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  return { kind: "tcp", host: "127.0.0.1", port: address.port };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FT-04 production attachment capability matrix", () => {
  it("reports only safe ready DTOs for the frozen ClamAV, Poppler, and Tesseract versions", async () => {
    const root = await fixtureRoot();
    const poppler = await versionFixture(root, "poppler", "pdfinfo version 26.07.0\n", "stderr");
    const tesseract = await versionFixture(root, "tesseract", "tesseract 5.5.3\n");
    const endpoint = await clamdFixture();
    const result = await probeProductionAttachmentCapabilities({
      cwd: root,
      timeoutMs: 2_000,
      clamd: {
        endpoint,
        databaseSha256,
        databaseUpdatedAt: "2026-08-19T08:30:00.000Z",
        policy: PRODUCTION_CLAMD_POLICY,
      },
      poppler,
      tesseract,
      now: "2026-08-19T09:00:00.000Z",
    });

    expect(PRODUCTION_ATTACHMENT_VERSIONS).toEqual({
      clamav: ["1.5.3", "1.4.5"],
      poppler: "26.07.0",
      tesseract: "5.5.3",
    });
    expect(PRODUCTION_CLAMD_POLICY).toEqual({
      streamMaxLengthBytes: 55 * 1_024 * 1_024,
      maxFileSizeBytes: 55 * 1_024 * 1_024,
      maxScanSizeBytes: 256 * 1_024 * 1_024,
      maxRecursion: 16,
      maxFiles: 10_000,
      scanTimeoutMs: 120_000,
    });
    expect(result).toEqual({
      status: "ready",
      attachmentReadiness: "ready",
      scanner: {
        status: "ready",
        version: "1.5.3",
        databaseSha256,
        databaseFreshness: "fresh",
        reason: null,
      },
      poppler: { status: "ready", version: "26.07.0", reason: null },
      tesseract: { status: "ready", version: "5.5.3", reason: null },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(process.execPath);
    expect(serialized).not.toContain("executable");
    expect(serialized).not.toContain("argv");
  });

  it("marks missing production dependencies unavailable without fake/no-op readiness", async () => {
    const root = await fixtureRoot();
    const missing = "/definitely/missing/dao-production-tool";
    const endpoint = { kind: "unix" as const, socketPath: join(root, "missing-clamd.sock") };
    const result = await probeProductionAttachmentCapabilities({
      cwd: root,
      timeoutMs: 50,
      clamd: {
        endpoint,
        databaseSha256,
        databaseUpdatedAt: "2026-08-19T08:30:00.000Z",
        policy: PRODUCTION_CLAMD_POLICY,
      },
      poppler: { executable: missing, argv: ["-v"] },
      tesseract: { executable: missing, argv: ["--version"] },
      now: "2026-08-19T09:00:00.000Z",
    });
    expect(result.status).toBe("degraded");
    expect(result.attachmentReadiness).toBe("unavailable");
    expect(result.scanner.status).toBe("unavailable");
    expect(result.poppler).toMatchObject({ status: "unavailable", version: null });
    expect(result.tesseract).toMatchObject({ status: "unavailable", version: null });
    expect(JSON.stringify(result)).not.toContain(missing);
  });

  it("makes a stale ClamAV database unavailable and unsupported versions degraded", async () => {
    const root = await fixtureRoot();
    const poppler = await versionFixture(root, "poppler", "pdfinfo version 25.01.0\n", "stderr");
    const tesseract = await versionFixture(root, "tesseract", "tesseract 5.4.0\n");
    const endpoint = await clamdFixture("1.5.2");
    const result = await probeProductionAttachmentCapabilities({
      cwd: root,
      timeoutMs: 2_000,
      clamd: {
        endpoint,
        databaseSha256,
        databaseUpdatedAt: "2026-08-17T08:00:00.000Z",
        policy: PRODUCTION_CLAMD_POLICY,
      },
      poppler,
      tesseract,
      now: "2026-08-19T09:00:00.000Z",
    });
    expect(result).toMatchObject({
      status: "degraded",
      attachmentReadiness: "unavailable",
      scanner: {
        status: "unavailable",
        version: "1.5.2",
        databaseFreshness: "stale",
        reason: "database_stale",
      },
      poppler: { status: "degraded", version: "25.01.0", reason: "unsupported_version" },
      tesseract: { status: "degraded", version: "5.4.0", reason: "unsupported_version" },
    });
  });
});
