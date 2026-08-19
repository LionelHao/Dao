// @vitest-environment node

import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isAttachmentReadyProvenance } from "@native-im/core";
import type { ExtractionToolchain } from "./extraction-adapters.js";
import {
  createAttachmentProcessingPipeline,
  type AttachmentMalwareScannerPort,
  type AttachmentProcessingGenerationPort,
  type AttachmentProcessingInput,
} from "./processing-pipeline.js";

function unusedTools(): ExtractionToolchain {
  const executable = Object.freeze({
    executable: process.execPath,
    argvPrefix: Object.freeze(["-e", "process.exit(97)"]),
    version: "test-1",
  });
  return {
    cwd: tmpdir(),
    extractTimeoutMs: 2_000,
    ocrTimeoutMs: 2_000,
    ocrLanguage: "eng",
    pdfinfo: executable,
    pdftotext: executable,
    pdftoppm: executable,
    tesseract: executable,
  };
}

function currentGeneration(events?: string[]): AttachmentProcessingGenerationPort {
  return {
    check: async ({ checkpoint }) => {
      events?.push(checkpoint);
      return "current";
    },
  };
}

function textInput(
  attachmentId: string,
  loadBytes: AttachmentProcessingInput["loadBytes"] = async () => Buffer.from("safe text\n"),
  signal?: AbortSignal,
): AttachmentProcessingInput {
  return {
    attachmentId,
    generation: 1,
    expectedFormat: "txt",
    declaredMime: "text/plain",
    loadBytes,
    ...(signal === undefined ? {} : { signal }),
  };
}

describe("FT-04 production attachment processing pipeline", () => {
  it("orders generation gates, ClamD clean, validation, extraction, and ready provenance", async () => {
    const events: string[] = [];
    const scanner: AttachmentMalwareScannerPort = {
      version: "1.5.3",
      scan: async () => {
        events.push("scan");
        return { status: "clean" };
      },
    };
    const source = Buffer.from("safe text\r\n");
    const pipeline = createAttachmentProcessingPipeline({
      scanner,
      generation: currentGeneration(events),
      tools: unusedTools(),
      maxConcurrency: 2,
      maxQueued: 4,
    });
    const result = await pipeline.process(textInput("attachment-sequence", async () => {
      events.push("read");
      return source;
    }));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready");
    expect(Buffer.from(result.extractionBytes).toString("utf8")).toBe("safe text\n");
    expect(result.provenance).toEqual({
      scanner: { kind: "clamav", version: "1.5.3" },
      extraction: {
        method: "plain-text",
        tool: "builtin",
        version: "1",
        artifactSha256: createHash("sha256").update("safe text\n").digest("hex"),
        artifactByteSize: 10,
        pageCount: null,
      },
      ocr: null,
    });
    expect(isAttachmentReadyProvenance(result.provenance)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["extractionBytes", "provenance", "status"]);
    expect(events).toEqual([
      "before-read",
      "read",
      "before-scan",
      "scan",
      "after-scan",
      "after-validation",
      "before-extract",
      "after-extract",
      "before-ready",
    ]);
  });

  it("scans before parsing and treats malware as terminal without validation or extraction", async () => {
    let scanCount = 0;
    const malware = createAttachmentProcessingPipeline({
      scanner: {
        version: "1.5.3",
        scan: async () => {
          scanCount += 1;
          return { status: "malware" };
        },
      },
      generation: currentGeneration(),
      tools: unusedTools(),
    });
    await expect(malware.process(textInput(
      "attachment-malware", async () => Buffer.from([0xff, 0xfe, 0x00]),
    ))).resolves.toEqual({ status: "malware-rejected" });
    expect(scanCount).toBe(1);

    const clean = createAttachmentProcessingPipeline({
      scanner: { version: "1.5.3", scan: async () => ({ status: "clean" }) },
      generation: currentGeneration(),
      tools: unusedTools(),
    });
    await expect(clean.process(textInput(
      "attachment-invalid", async () => Buffer.from([0xff, 0xfe, 0x00]),
    ))).resolves.toEqual({
      status: "nonretryable-failure",
      reason: "malformed",
    });
  });

  it("normalizes unavailable scanner and storage failures without leaking raw paths or stacks", async () => {
    const scannerCanary = "RAW_SCANNER_/private/clamd.sock";
    const scannerFailure = createAttachmentProcessingPipeline({
      scanner: {
        version: "1.5.3",
        scan: async () => {
          throw new Error(scannerCanary);
        },
      },
      generation: currentGeneration(),
      tools: unusedTools(),
    });
    const scanResult = await scannerFailure.process(textInput("attachment-scan-failure"));
    expect(scanResult).toEqual({ status: "retryable-failure", reason: "scanner_unavailable" });
    expect(JSON.stringify(scanResult)).not.toContain(scannerCanary);
    expect(JSON.stringify(scanResult)).not.toContain("/private");

    const storageCanary = "RAW_STORAGE_/private/quarantine/file";
    const storageResult = await scannerFailure.process(textInput(
      "attachment-storage-failure",
      async () => {
        throw new Error(storageCanary);
      },
    ));
    expect(storageResult).toEqual({ status: "retryable-failure", reason: "storage_unavailable" });
    expect(JSON.stringify(storageResult)).not.toContain(storageCanary);
  });

  it("cancels before byte reads and suppresses stale-generation results before READY", async () => {
    let reads = 0;
    const controller = new AbortController();
    controller.abort();
    const cancelled = createAttachmentProcessingPipeline({
      scanner: { version: "1.5.3", scan: async () => ({ status: "clean" }) },
      generation: currentGeneration(),
      tools: unusedTools(),
    });
    await expect(cancelled.process(textInput("attachment-cancelled", async () => {
      reads += 1;
      return Buffer.from("must not read");
    }, controller.signal))).resolves.toEqual({ status: "cancelled" });
    expect(reads).toBe(0);

    const staleGeneration: AttachmentProcessingGenerationPort = {
      check: async ({ checkpoint }) => checkpoint === "before-ready" ? "stale" : "current",
    };
    const stale = createAttachmentProcessingPipeline({
      scanner: { version: "1.5.3", scan: async () => ({ status: "clean" }) },
      generation: staleGeneration,
      tools: unusedTools(),
    });
    await expect(stale.process(textInput("attachment-stale")))
      .resolves.toEqual({ status: "superseded" });
  });

  it("bounds concurrency and its queue while removing queued cancellation", async () => {
    let releaseFirst!: () => void;
    let notifyStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const scanner: AttachmentMalwareScannerPort = {
      version: "1.5.3",
      scan: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        notifyStarted();
        await blocker;
        active -= 1;
        return { status: "clean" };
      },
    };
    const pipeline = createAttachmentProcessingPipeline({
      scanner,
      generation: currentGeneration(),
      tools: unusedTools(),
      maxConcurrency: 1,
      maxQueued: 1,
    });
    const first = pipeline.process(textInput("attachment-first"));
    await firstStarted;
    const queuedController = new AbortController();
    const queued = pipeline.process(textInput(
      "attachment-queued", undefined, queuedController.signal,
    ));
    await expect(pipeline.process(textInput("attachment-overflow"))).resolves.toEqual({
      status: "retryable-failure",
      reason: "capacity_limited",
    });
    queuedController.abort();
    await expect(queued).resolves.toEqual({ status: "cancelled" });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: "ready" });
    expect(maxActive).toBe(1);
  });
});
