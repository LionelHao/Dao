import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentDatabaseOperation,
  AttachmentDatabaseOperationResult,
  AttachmentProcessingPlan,
} from "./database-contracts.js";
import { AttachmentObjectStore } from "./object-store.js";
import { createAttachmentProcessingRuntime } from "./processing-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dao-processing-runtime-"));
  roots.push(root);
  const store = new AttachmentObjectStore({
    root,
    limits: {
      maxChunkBytes: 32_768,
      maxFileBytes: 50 * 1_024 * 1_024,
      maxExtractionBytes: 8 * 1_024 * 1_024,
      reconcileMaxEntries: 128,
      reconcileMaxBytes: 256 * 1_024 * 1_024,
    },
  });
  await store.initialize();
  const bytes = Buffer.from("hello attachment");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uploadId = randomUUID();
  const attachmentId = randomUUID();
  await store.writeChunk({ uploadId, ordinal: 0, bytes, sha256 });
  await store.assembleQuarantine({
    uploadId,
    attachmentId,
    chunkCount: 1,
    expectedBytes: bytes.byteLength,
    expectedSha256: sha256,
  });
  const plan: AttachmentProcessingPlan = {
    attachmentId,
    generation: 1,
    format: "txt",
    declaredMime: "text/plain",
    byteSize: bytes.byteLength,
    sha256,
    stage: "accepted-quarantined",
  };
  return { store, bytes, plan };
}

const tools = Object.freeze({
  cwd: "/tmp",
  extractTimeoutMs: 60_000,
  ocrTimeoutMs: 180_000,
  ocrLanguage: "eng",
  pdfinfo: { executable: "/bin/false", argvPrefix: [], version: "26.07.0" },
  pdftotext: { executable: "/bin/false", argvPrefix: [], version: "26.07.0" },
  pdftoppm: { executable: "/bin/false", argvPrefix: [], version: "26.07.0" },
  tesseract: { executable: "/bin/false", argvPrefix: [], version: "5.5.3" },
});

describe("attachment processing runtime", () => {
  it("recovers a quarantined attachment and commits scan, extraction, object, then READY", async () => {
    const { store, plan } = await fixture();
    let attempt = 0;
    const operations: AttachmentDatabaseOperation[] = [];
    const executeAttachment = vi.fn(async (
      operation: AttachmentDatabaseOperation,
    ): Promise<AttachmentDatabaseOperationResult> => {
      operations.push(operation);
      switch (operation.kind) {
        case "processing-recover": return { candidates: [plan] };
        case "processing-inspect": return plan;
        case "processing-claim":
          attempt += 1;
          return {
            attachmentId: plan.attachmentId,
            generation: 1,
            attemptNumber: attempt,
            adapterKind: operation.command.adapter.kind,
            replayed: false,
          };
        case "processing-start":
          return {
            attachmentId: plan.attachmentId,
            generation: 1,
            attemptNumber: operation.command.attemptNumber,
            status: "running",
            replayed: false,
          };
        case "processing-complete":
          return {
            attachmentId: plan.attachmentId,
            generation: 1,
            attemptNumber: operation.command.attemptNumber,
            status: operation.command.result.status,
            privateEventId: null,
            replayed: false,
          };
        case "attachment-ready":
          return {
            attachmentId: plan.attachmentId,
            generation: 1,
            status: "ready",
            privateEventId: "ready-event",
            replayed: false,
          };
        default: throw new Error(`unexpected ${operation.kind}`);
      }
    });
    const extractionBytes = Buffer.from("hello attachment\n");
    const artifactSha256 = createHash("sha256").update(extractionBytes).digest("hex");
    const runtime = createAttachmentProcessingRuntime({
      database: { executeAttachment },
      objectStore: store,
      tools,
      scanner: { name: "clamav", version: "1.5.3", timeoutMs: 120_000 },
      nowMs: () => 1_000,
      createPipeline: (generation) => ({
        async process(input) {
          expect(await generation.check({
            attachmentId: input.attachmentId,
            generation: input.generation,
            checkpoint: "before-ready",
          })).toBe("current");
          expect(Buffer.from(await input.loadBytes(input.signal)).toString()).toBe("hello attachment");
          return {
            status: "ready",
            provenance: {
              scanner: { kind: "clamav", version: "1.5.3" },
              extraction: {
                method: "plain-text",
                tool: "builtin",
                version: "1",
                artifactSha256,
                artifactByteSize: extractionBytes.byteLength,
                pageCount: null,
              },
              ocr: null,
            },
            extractionBytes,
          };
        },
      }),
    });

    expect(await runtime.recover()).toBe(1);
    await vi.waitFor(() => {
      expect(operations.some((operation) => operation.kind === "attachment-ready")).toBe(true);
    });
    expect(operations.filter((operation) => operation.kind === "processing-claim")
      .map((operation) => operation.command.adapter.kind)).toEqual(["scanner", "extractor"]);
    const completions = operations.filter((operation) => operation.kind === "processing-complete");
    expect(completions.map((operation) => operation.command.result.status))
      .toEqual(["succeeded", "succeeded"]);
    await expect(store.readQuarantineForProcessing(plan.attachmentId)).rejects.toMatchObject({
      reason: "quarantine_missing",
    });
    await runtime.close();
  });

  it("records malware on the scanner attempt and never publishes an operational object", async () => {
    const { store, plan } = await fixture();
    const operations: AttachmentDatabaseOperation[] = [];
    const runtime = createAttachmentProcessingRuntime({
      database: {
        async executeAttachment(operation): Promise<AttachmentDatabaseOperationResult> {
          operations.push(operation);
          if (operation.kind === "processing-inspect") return plan;
          if (operation.kind === "processing-claim") return {
            attachmentId: plan.attachmentId, generation: 1, attemptNumber: 1,
            adapterKind: "scanner", replayed: false,
          };
          if (operation.kind === "processing-start") return {
            attachmentId: plan.attachmentId, generation: 1, attemptNumber: 1,
            status: "running", replayed: false,
          };
          if (operation.kind === "processing-complete") return {
            attachmentId: plan.attachmentId, generation: 1, attemptNumber: 1,
            status: operation.command.result.status, privateEventId: "malware-event", replayed: false,
          };
          throw new Error(`unexpected ${operation.kind}`);
        },
      },
      objectStore: store,
      tools,
      scanner: { name: "clamav", version: "1.5.3", timeoutMs: 120_000 },
      nowMs: () => 1_000,
      createPipeline: () => ({ async process() { return { status: "malware-rejected" }; } }),
    });
    await runtime.enqueue({ attachmentId: plan.attachmentId, generation: 1 });
    await vi.waitFor(() => {
      const completed = operations.find((operation) => operation.kind === "processing-complete");
      expect(completed?.command.result).toEqual({
        status: "malware-rejected",
        failureCode: "malware_detected",
      });
    });
    expect(operations.some((operation) => operation.kind === "attachment-ready")).toBe(false);
    await runtime.close();
  });
});
