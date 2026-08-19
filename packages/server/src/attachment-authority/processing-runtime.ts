import { createHash } from "node:crypto";
import type { AttachmentExtractionMethod } from "@native-im/core";
import type { WorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type {
  AttachmentProcessingAdapter,
  AttachmentProcessingClaimReceipt,
  AttachmentProcessingAttemptResult,
  AttachmentProcessingPlan,
  AttachmentProcessingRecoveryBatch,
  AttachmentWorkerContext,
} from "./database-contracts.js";
import type { ExtractionToolchain } from "./extraction-adapters.js";
import { AttachmentObjectStore } from "./object-store.js";
import type {
  AttachmentProcessingGenerationPort,
  AttachmentProcessingPipeline,
  AttachmentProcessingResult,
} from "./processing-pipeline.js";
import type { AttachmentProcessingQueuePort } from "./authority-service.js";

const STDOUT_LIMIT = 8 * 1_024 * 1_024;
const STDERR_LIMIT = 64 * 1_024;
const workerContext: AttachmentWorkerContext = Object.freeze({
  kind: "attachment-worker",
  workerId: "attachment-processing-runtime",
});

export interface AttachmentProcessingRuntime extends AttachmentProcessingQueuePort {
  recover(): Promise<number>;
  close(): Promise<void>;
}

export interface AttachmentProcessingRuntimeOptions {
  readonly database: Pick<WorkerDatabaseClient, "executeAttachment">;
  readonly objectStore: AttachmentObjectStore;
  readonly tools: ExtractionToolchain;
  readonly scanner: Readonly<{
    name: "clamav";
    version: string;
    timeoutMs: number;
  }>;
  readonly createPipeline: (
    generation: AttachmentProcessingGenerationPort,
  ) => AttachmentProcessingPipeline;
  readonly nowMs: () => number;
}

function isPlan(value: unknown): value is AttachmentProcessingPlan {
  return typeof value === "object" && value !== null && "stage" in value &&
    "attachmentId" in value && "generation" in value && "format" in value;
}

function isRecovery(value: unknown): value is AttachmentProcessingRecoveryBatch {
  return typeof value === "object" && value !== null && "candidates" in value &&
    Array.isArray(value.candidates);
}

function isClaim(value: unknown): value is AttachmentProcessingClaimReceipt {
  return typeof value === "object" && value !== null && "attemptNumber" in value &&
    "adapterKind" in value;
}

function adapter(
  kind: "scanner" | "extractor" | "ocr",
  name: string,
  version: string,
  timeoutMs: number,
): AttachmentProcessingAdapter {
  return Object.freeze({
    kind,
    name,
    version,
    timeoutMs,
    stdoutLimitBytes: STDOUT_LIMIT,
    stderrLimitBytes: STDERR_LIMIT,
  });
}

function extractionAdapter(
  method: AttachmentExtractionMethod,
  tool: string,
  version: string,
  tools: ExtractionToolchain,
): AttachmentProcessingAdapter {
  return method === "ocr"
    ? adapter("ocr", tool, version, tools.ocrTimeoutMs)
    : adapter("extractor", tool, version, tools.extractTimeoutMs);
}

function stageAdapter(
  plan: AttachmentProcessingPlan,
  options: AttachmentProcessingRuntimeOptions,
): AttachmentProcessingAdapter {
  if (plan.stage === "ocr") {
    return adapter("ocr", "tesseract", options.tools.tesseract.version, options.tools.ocrTimeoutMs);
  }
  const name = plan.format === "txt" || plan.format === "csv"
    ? "builtin"
    : plan.format === "docx" || plan.format === "xlsx"
      ? "bounded-zip"
      : "pdftotext";
  const version = name === "builtin"
    ? "1"
    : name === "bounded-zip"
      ? "fflate-0.8.3+saxes-6.0.0"
      : options.tools.pdftotext.version;
  return adapter("extractor", name, version, options.tools.extractTimeoutMs);
}

function failureCode(result: Exclude<
  AttachmentProcessingResult,
  { status: "ready" | "malware-rejected" | "cancelled" | "superseded" }
>): string {
  return result.reason;
}

function scannerFailure(result: AttachmentProcessingResult): result is Extract<
  AttachmentProcessingResult,
  { status: "retryable-failure" }
> {
  return result.status === "retryable-failure" && [
    "capacity_limited",
    "storage_unavailable",
    "scanner_unavailable",
    "generation_unavailable",
    "processing_unavailable",
  ].includes(result.reason);
}

export function createAttachmentProcessingRuntime(
  options: AttachmentProcessingRuntimeOptions,
): AttachmentProcessingRuntime {
  let closed = false;
  const controllers = new Map<string, AbortController>();
  const running = new Map<string, Promise<void>>();

  function now(): number {
    const value = options.nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Attachment processing clock is invalid");
    }
    return value;
  }

  async function inspect(attachmentId: string, generation: number): Promise<AttachmentProcessingPlan> {
    const result = await options.database.executeAttachment({
      kind: "processing-inspect",
      context: workerContext,
      attachmentId,
      expectedGeneration: generation,
    }, now());
    if (!isPlan(result)) throw new Error("Attachment processing plan was unavailable");
    return result;
  }

  const generationPort: AttachmentProcessingGenerationPort = Object.freeze({
    async check(input: Parameters<AttachmentProcessingGenerationPort["check"]>[0]) {
      if (closed || controllers.get(`${input.attachmentId}:${input.generation}`)?.signal.aborted) {
        return "cancelled";
      }
      try {
        await inspect(input.attachmentId, input.generation);
        return "current";
      } catch {
        return "stale";
      }
    },
  });
  const pipeline = options.createPipeline(generationPort);

  async function claimAndStart(
    plan: AttachmentProcessingPlan,
    processingAdapter: AttachmentProcessingAdapter,
  ): Promise<AttachmentProcessingClaimReceipt> {
    const claimed = await options.database.executeAttachment({
      kind: "processing-claim",
      context: workerContext,
      command: {
        attachmentId: plan.attachmentId,
        expectedGeneration: plan.generation,
        adapter: processingAdapter,
      },
    }, now());
    if (!isClaim(claimed) || claimed.adapterKind !== processingAdapter.kind) {
      throw new Error("Attachment processing claim was unavailable");
    }
    await options.database.executeAttachment({
      kind: "processing-start",
      context: workerContext,
      command: {
        attachmentId: plan.attachmentId,
        expectedGeneration: plan.generation,
        attemptNumber: claimed.attemptNumber,
      },
    }, now());
    return claimed;
  }

  async function complete(
    plan: AttachmentProcessingPlan,
    attempt: AttachmentProcessingClaimReceipt,
    result: AttachmentProcessingAttemptResult,
  ): Promise<void> {
    await options.database.executeAttachment({
      kind: "processing-complete",
      context: workerContext,
      command: {
        attachmentId: plan.attachmentId,
        expectedGeneration: plan.generation,
        attemptNumber: attempt.attemptNumber,
        result,
      },
    }, now());
  }

  async function run(attachmentId: string, expectedGeneration: number, signal: AbortSignal): Promise<void> {
    const plan = await inspect(attachmentId, expectedGeneration);
    let currentAttempt: AttachmentProcessingClaimReceipt;
    const beganWithScanner = plan.stage === "accepted-quarantined" || plan.stage === "scanning";
    if (beganWithScanner) {
      currentAttempt = await claimAndStart(plan, adapter(
        "scanner", options.scanner.name, options.scanner.version, options.scanner.timeoutMs,
      ));
    } else {
      currentAttempt = await claimAndStart(plan, stageAdapter(plan, options));
    }

    const result = await pipeline.process({
      attachmentId: plan.attachmentId,
      generation: plan.generation,
      expectedFormat: plan.format,
      declaredMime: plan.declaredMime,
      signal,
      loadBytes: async () => await options.objectStore.readQuarantineForProcessing(plan.attachmentId),
    });
    if (result.status === "superseded") return;
    if (result.status === "cancelled") {
      await complete(plan, currentAttempt, { status: "cancelled", failureCode: "cancelled" });
      return;
    }
    if (result.status === "malware-rejected") {
      if (!beganWithScanner) {
        await complete(plan, currentAttempt, {
          status: "retryable-failed",
          failureCode: "scanner_revalidation_failed",
        });
        return;
      }
      await complete(plan, currentAttempt, {
        status: "malware-rejected",
        failureCode: "malware_detected",
      });
      return;
    }
    if (beganWithScanner && scannerFailure(result)) {
      await complete(plan, currentAttempt, {
        status: "retryable-failed",
        failureCode: failureCode(result),
      });
      return;
    }
    if (beganWithScanner) {
      await complete(plan, currentAttempt, { status: "succeeded" });
    }

    if (result.status !== "ready") {
      if (beganWithScanner) {
        const failureAdapter = result.status === "retryable-failure" &&
          result.reason.startsWith("ocr")
          ? adapter("ocr", "tesseract", options.tools.tesseract.version, options.tools.ocrTimeoutMs)
          : stageAdapter({ ...plan, stage: "extracting" }, options);
        currentAttempt = await claimAndStart(plan, failureAdapter);
      }
      await complete(plan, currentAttempt, {
        status: result.status === "retryable-failure" ? "retryable-failed" : "nonretryable-failed",
        failureCode: failureCode(result),
      });
      return;
    }

    const provenance = result.provenance.extraction;
    if (beganWithScanner) {
      currentAttempt = await claimAndStart(plan, extractionAdapter(
        provenance.method, provenance.tool, provenance.version, options.tools,
      ));
    }
    const artifactSha256 = createHash("sha256").update(result.extractionBytes).digest("hex");
    if (artifactSha256 !== provenance.artifactSha256 ||
        result.extractionBytes.byteLength !== provenance.artifactByteSize) {
      await complete(plan, currentAttempt, {
        status: "nonretryable-failed",
        failureCode: "extractor_provenance_mismatch",
      });
      return;
    }
    const artifact = await options.objectStore.storeExtractionArtifact({
      bytes: result.extractionBytes,
      sha256: artifactSha256,
    });
    await complete(plan, currentAttempt, {
      status: "succeeded",
      extraction: {
        method: provenance.method,
        tool: provenance.tool,
        version: provenance.version,
        objectKey: artifact.objectKey,
        sha256: artifact.sha256,
        byteSize: artifact.byteLength,
        pageCount: provenance.pageCount,
      },
    });
    const published = await options.objectStore.publishCleanObject({
      attachmentId: plan.attachmentId,
      retainQuarantine: true,
    });
    if (published.byteLength !== plan.byteSize || published.sha256 !== plan.sha256) {
      throw new Error("Attachment publication changed authoritative metadata");
    }
    await options.database.executeAttachment({
      kind: "attachment-ready",
      context: workerContext,
      command: {
        attachmentId: plan.attachmentId,
        expectedGeneration: plan.generation,
        objectKey: published.objectKey,
        byteSize: published.byteLength,
        sha256: published.sha256,
      },
    }, now());
    await options.objectStore.discardQuarantine(plan.attachmentId);
  }

  const runtime: AttachmentProcessingRuntime = {
    async enqueue(input) {
      if (closed) throw new Error("Attachment processing runtime is closed");
      const key = `${input.attachmentId}:${input.generation}`;
      if (running.has(key)) return;
      const controller = new AbortController();
      controllers.set(key, controller);
      const task = run(input.attachmentId, input.generation, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          controllers.delete(key);
          running.delete(key);
        });
      running.set(key, task);
    },
    async recover() {
      if (closed) return 0;
      const result = await options.database.executeAttachment({
        kind: "processing-recover",
        context: workerContext,
        limit: 64,
      }, now());
      if (!isRecovery(result)) throw new Error("Attachment recovery batch was unavailable");
      await Promise.all(result.candidates.map(async (candidate) => {
        await runtime.enqueue({
          attachmentId: candidate.attachmentId,
          generation: candidate.generation,
        });
      }));
      return result.candidates.length;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled(running.values());
      controllers.clear();
      running.clear();
    },
  };
  return Object.freeze(runtime);
}
