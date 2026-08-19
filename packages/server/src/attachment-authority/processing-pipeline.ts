import { createHash } from "node:crypto";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  isAttachmentReadyProvenance,
  type AttachmentDetectedMime,
  type AttachmentFormat,
  type AttachmentReadyProvenance,
} from "@native-im/core";
import {
  scanWithClamd,
  type ClamdEndpoint,
  type ClamdScanResult,
} from "./clamd-scanner.js";
import {
  AttachmentContentValidationError,
  validateAttachmentContent,
} from "./content-validator.js";
import {
  AttachmentExtractionAdapterError,
  extractValidatedAttachment,
  type ExtractionAdapterStage,
  type ExtractionToolchain,
} from "./extraction-adapters.js";

export const ATTACHMENT_PROCESSING_LIMITS = Object.freeze({
  maxConcurrency: 2,
  maxQueued: 64,
  scannerChunkBytes: 1 * 1_024 * 1_024,
});

export type AttachmentProcessingCheckpoint =
  | "before-read"
  | "before-scan"
  | "after-scan"
  | "after-validation"
  | "before-extract"
  | "after-extract"
  | "before-ocr"
  | "after-ocr"
  | "before-ready";

export interface AttachmentProcessingGenerationPort {
  check(input: Readonly<{
    attachmentId: string;
    generation: number;
    checkpoint: AttachmentProcessingCheckpoint;
  }>): Promise<"current" | "cancelled" | "stale">;
}

export interface AttachmentMalwareScannerPort {
  readonly version: string;
  scan(input: Readonly<{
    bytes: Uint8Array;
    signal?: AbortSignal;
  }>): Promise<ClamdScanResult>;
}

export interface AttachmentProcessingInput {
  readonly attachmentId: string;
  readonly generation: number;
  readonly expectedFormat: AttachmentFormat;
  readonly declaredMime: AttachmentDetectedMime | null;
  readonly loadBytes: (signal: AbortSignal | undefined) => Promise<Uint8Array>;
  readonly signal?: AbortSignal;
}

export type AttachmentProcessingRetryableReason =
  | "capacity_limited"
  | "storage_unavailable"
  | "scanner_unavailable"
  | "extractor_unavailable"
  | "ocr_unavailable"
  | "extractor_timeout"
  | "ocr_timeout"
  | "generation_unavailable"
  | "processing_unavailable";

export type AttachmentProcessingNonretryableReason =
  | "size"
  | "type"
  | "malformed"
  | "encrypted-pdf"
  | "archive-bomb"
  | "image-bomb"
  | "extractor-output-limit"
  | "ocr-output-limit"
  | "extractor-failed"
  | "ocr-failed";

export type AttachmentProcessingResult =
  | Readonly<{
      status: "ready";
      provenance: AttachmentReadyProvenance;
      extractionBytes: Uint8Array;
    }>
  | Readonly<{
      status: "retryable-failure";
      reason: AttachmentProcessingRetryableReason;
    }>
  | Readonly<{
      status: "nonretryable-failure";
      reason: AttachmentProcessingNonretryableReason;
    }>
  | Readonly<{ status: "malware-rejected" }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "superseded" }>;

export interface AttachmentProcessingPipeline {
  process(input: AttachmentProcessingInput): Promise<AttachmentProcessingResult>;
}

export interface AttachmentProcessingPipelineOptions {
  readonly scanner: AttachmentMalwareScannerPort;
  readonly generation: AttachmentProcessingGenerationPort;
  readonly tools: ExtractionToolchain;
  readonly maxConcurrency?: number;
  readonly maxQueued?: number;
}

export interface ProductionAttachmentProcessingPipelineOptions {
  readonly clamd: Readonly<{
    endpoint: ClamdEndpoint;
    timeoutMs: number;
    version: string;
  }>;
  readonly generation: AttachmentProcessingGenerationPort;
  readonly tools: ExtractionToolchain;
  readonly maxConcurrency?: number;
  readonly maxQueued?: number;
}

class AttachmentProcessingControlError extends Error {
  readonly reason: "cancelled" | "superseded" | "generation_unavailable";

  constructor(reason: "cancelled" | "superseded" | "generation_unavailable") {
    super(`Attachment processing stopped: ${reason}`);
    this.name = "AttachmentProcessingControlError";
    delete this.stack;
    this.reason = reason;
  }
}

export class AttachmentProcessingPipelineConfigurationError extends Error {
  constructor() {
    super("Attachment processing pipeline configuration is invalid");
    this.name = "AttachmentProcessingPipelineConfigurationError";
    delete this.stack;
  }
}

type QueueEntry = {
  readonly input: AttachmentProcessingInput;
  readonly resolve: (value: AttachmentProcessingResult) => void;
  onAbort?: () => void;
};

function frozen<T extends AttachmentProcessingResult>(value: T): T {
  return Object.freeze(value);
}

function safeVersion(value: string): boolean {
  return value.length > 0 && value.length <= 128 && value === value.trim() &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function contentFailure(error: AttachmentContentValidationError): AttachmentProcessingResult {
  switch (error.code) {
    case "attachment_too_large":
      return frozen({ status: "nonretryable-failure", reason: "size" });
    case "attachment_type_unsupported":
    case "type_mismatch":
      return frozen({ status: "nonretryable-failure", reason: "type" });
    case "encrypted_pdf":
      return frozen({ status: "nonretryable-failure", reason: "encrypted-pdf" });
    case "archive_bomb":
      return frozen({ status: "nonretryable-failure", reason: "archive-bomb" });
    case "image_bomb":
      return frozen({ status: "nonretryable-failure", reason: "image-bomb" });
    case "attachment_malformed":
      return frozen({ status: "nonretryable-failure", reason: "malformed" });
  }
}

function adapterFailure(error: AttachmentExtractionAdapterError): AttachmentProcessingResult {
  if (error.reason === "cancelled") return frozen({ status: "cancelled" });
  if (error.reason === "timed_out") {
    return frozen({
      status: "retryable-failure",
      reason: error.stage === "ocr" ? "ocr_timeout" : "extractor_timeout",
    });
  }
  if (error.retryable) {
    return frozen({
      status: "retryable-failure",
      reason: error.stage === "ocr" ? "ocr_unavailable" : "extractor_unavailable",
    });
  }
  if (error.reason === "output_limit") {
    return frozen({
      status: "nonretryable-failure",
      reason: error.stage === "ocr" ? "ocr-output-limit" : "extractor-output-limit",
    });
  }
  return frozen({
    status: "nonretryable-failure",
    reason: error.stage === "ocr" ? "ocr-failed" : "extractor-failed",
  });
}

function controlFailure(error: AttachmentProcessingControlError): AttachmentProcessingResult {
  if (error.reason === "cancelled") return frozen({ status: "cancelled" });
  if (error.reason === "superseded") return frozen({ status: "superseded" });
  return frozen({ status: "retryable-failure", reason: "generation_unavailable" });
}

class BoundedAttachmentProcessingPipeline implements AttachmentProcessingPipeline {
  readonly #options: AttachmentProcessingPipelineOptions;
  readonly #maxConcurrency: number;
  readonly #maxQueued: number;
  readonly #queue: QueueEntry[] = [];
  #active = 0;

  constructor(options: AttachmentProcessingPipelineOptions) {
    const maxConcurrency = options.maxConcurrency ?? ATTACHMENT_PROCESSING_LIMITS.maxConcurrency;
    const maxQueued = options.maxQueued ?? ATTACHMENT_PROCESSING_LIMITS.maxQueued;
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 ||
        maxConcurrency > ATTACHMENT_PROCESSING_LIMITS.maxConcurrency ||
        !Number.isSafeInteger(maxQueued) || maxQueued < 0 ||
        maxQueued > ATTACHMENT_PROCESSING_LIMITS.maxQueued) {
      throw new AttachmentProcessingPipelineConfigurationError();
    }
    this.#options = options;
    this.#maxConcurrency = maxConcurrency;
    this.#maxQueued = maxQueued;
  }

  async process(input: AttachmentProcessingInput): Promise<AttachmentProcessingResult> {
    if (input.signal?.aborted === true) return frozen({ status: "cancelled" });
    return await new Promise<AttachmentProcessingResult>((resolve) => {
      const entry: QueueEntry = { input, resolve };
      if (this.#active < this.#maxConcurrency) {
        this.#start(entry);
        return;
      }
      if (this.#queue.length >= this.#maxQueued) {
        resolve(frozen({ status: "retryable-failure", reason: "capacity_limited" }));
        return;
      }
      const onAbort = (): void => {
        const index = this.#queue.indexOf(entry);
        if (index === -1) return;
        this.#queue.splice(index, 1);
        resolve(frozen({ status: "cancelled" }));
      };
      entry.onAbort = onAbort;
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  #start(entry: QueueEntry): void {
    entry.input.signal?.removeEventListener("abort", entry.onAbort ?? (() => undefined));
    this.#active += 1;
    void this.#run(entry.input).then(entry.resolve, () => {
      entry.resolve(frozen({ status: "retryable-failure", reason: "processing_unavailable" }));
    }).finally(() => {
      this.#active -= 1;
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrency && this.#queue.length > 0) {
      const entry = this.#queue.shift()!;
      this.#start(entry);
    }
  }

  async #checkpoint(
    input: AttachmentProcessingInput,
    checkpoint: AttachmentProcessingCheckpoint,
  ): Promise<void> {
    if (input.signal?.aborted === true) throw new AttachmentProcessingControlError("cancelled");
    let result: "current" | "cancelled" | "stale";
    try {
      result = await this.#options.generation.check({
        attachmentId: input.attachmentId,
        generation: input.generation,
        checkpoint,
      });
    } catch {
      throw new AttachmentProcessingControlError("generation_unavailable");
    }
    if (result === "cancelled") throw new AttachmentProcessingControlError("cancelled");
    if (result === "stale") throw new AttachmentProcessingControlError("superseded");
    if (result !== "current") throw new AttachmentProcessingControlError("generation_unavailable");
  }

  async #run(input: AttachmentProcessingInput): Promise<AttachmentProcessingResult> {
    try {
      await this.#checkpoint(input, "before-read");
      let bytes: Uint8Array;
      try {
        bytes = await input.loadBytes(input.signal);
      } catch {
        if (input.signal?.aborted === true) return frozen({ status: "cancelled" });
        return frozen({ status: "retryable-failure", reason: "storage_unavailable" });
      }
      if (bytes.byteLength > ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes) {
        return frozen({ status: "nonretryable-failure", reason: "size" });
      }

      await this.#checkpoint(input, "before-scan");
      let scan: ClamdScanResult;
      try {
        scan = await this.#options.scanner.scan({
          bytes,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        if (input.signal?.aborted === true) return frozen({ status: "cancelled" });
        return frozen({ status: "retryable-failure", reason: "scanner_unavailable" });
      }
      await this.#checkpoint(input, "after-scan");
      if (scan.status === "malware") return frozen({ status: "malware-rejected" });
      if (scan.status !== "clean" || !safeVersion(this.#options.scanner.version)) {
        return frozen({ status: "retryable-failure", reason: "scanner_unavailable" });
      }

      let validation;
      try {
        validation = await validateAttachmentContent({
          bytes,
          expectedFormat: input.expectedFormat,
          declaredMime: input.declaredMime,
        });
      } catch (error) {
        if (error instanceof AttachmentContentValidationError) return contentFailure(error);
        return frozen({ status: "nonretryable-failure", reason: "malformed" });
      }
      await this.#checkpoint(input, "after-validation");

      let extraction;
      try {
        extraction = await extractValidatedAttachment({
          bytes,
          validation,
          tools: this.#options.tools,
          checkpoint: async (stage: ExtractionAdapterStage, phase: "before" | "after") => {
            await this.#checkpoint(input, `${phase}-${stage}`);
          },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        if (error instanceof AttachmentProcessingControlError) return controlFailure(error);
        if (error instanceof AttachmentExtractionAdapterError) return adapterFailure(error);
        return frozen({ status: "nonretryable-failure", reason: "extractor-failed" });
      }

      await this.#checkpoint(input, "before-ready");
      const extractionBytes = Buffer.from(extraction.extractionBytes);
      const provenance: AttachmentReadyProvenance = Object.freeze({
        scanner: Object.freeze({ kind: "clamav", version: this.#options.scanner.version }),
        extraction: Object.freeze({
          method: extraction.method,
          tool: extraction.tool,
          version: extraction.version,
          artifactSha256: createHash("sha256").update(extractionBytes).digest("hex"),
          artifactByteSize: extractionBytes.byteLength,
          pageCount: extraction.pageCount,
        }),
        ocr: extraction.ocr,
      });
      if (!isAttachmentReadyProvenance(provenance)) {
        return frozen({ status: "nonretryable-failure", reason: "extractor-failed" });
      }
      return frozen({ status: "ready", provenance, extractionBytes });
    } catch (error) {
      if (error instanceof AttachmentProcessingControlError) return controlFailure(error);
      return frozen({ status: "retryable-failure", reason: "processing_unavailable" });
    }
  }
}

export function createAttachmentProcessingPipeline(
  options: AttachmentProcessingPipelineOptions,
): AttachmentProcessingPipeline {
  return new BoundedAttachmentProcessingPipeline(options);
}

async function* abortableScannerBody(
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength;
    offset += ATTACHMENT_PROCESSING_LIMITS.scannerChunkBytes) {
    if (signal?.aborted === true) throw new AttachmentProcessingControlError("cancelled");
    yield bytes.subarray(offset, Math.min(
      bytes.byteLength,
      offset + ATTACHMENT_PROCESSING_LIMITS.scannerChunkBytes,
    ));
  }
}

export function createProductionAttachmentProcessingPipeline(
  options: ProductionAttachmentProcessingPipelineOptions,
): AttachmentProcessingPipeline {
  const scanner: AttachmentMalwareScannerPort = Object.freeze({
    version: options.clamd.version,
    scan: async ({ bytes, signal }: Parameters<AttachmentMalwareScannerPort["scan"]>[0]) =>
      await scanWithClamd({
        endpoint: options.clamd.endpoint,
        timeoutMs: options.clamd.timeoutMs,
        body: abortableScannerBody(bytes, signal),
      }),
  });
  return createAttachmentProcessingPipeline({
    scanner,
    generation: options.generation,
    tools: options.tools,
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
    ...(options.maxQueued === undefined ? {} : { maxQueued: options.maxQueued }),
  });
}
