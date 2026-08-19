import { ATTACHMENT_AUTHORITY_LIMITS } from "@native-im/core";
import { types as nodeTypes } from "node:util";
import type { WorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type {
  AttachmentAgentExtractionAuthorization,
  AttachmentDatabaseOperationResult,
} from "./database-contracts.js";
import { isAttachmentDatabaseOperationResult } from "./database-contracts.js";

export class AttachmentAgentExtractionReaderError extends Error {
  constructor(readonly code:
    | "invalid_request"
    | "attachment_forbidden"
    | "attachment_capacity_limited"
    | "storage_unavailable") {
    super(`Agent attachment extraction read rejected: ${code}`);
    this.name = "AttachmentAgentExtractionReaderError";
    delete this.stack;
  }
}

export interface AttachmentAgentExtractionReadPort {
  read(input: Readonly<{
    executionId: string;
    executionGeneration: number;
    attachmentId: string;
    attachmentGeneration: number;
    maximumBytes: number;
  }>): Promise<Readonly<{
    attachmentId: string;
    source: Readonly<{ messageId: string; revision: number }>;
    provenance: Readonly<{
      method: AttachmentAgentExtractionAuthorization["method"];
      tool: AttachmentAgentExtractionAuthorization["tool"];
      version: string;
      pageCount: number | null;
      sha256: string;
      byteSize: number;
    }>;
    text: string;
  }>>;
}

type Value = Record<string, unknown>;

function record(value: unknown): value is Value {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: Value, fields: readonly string[]): boolean {
  return fields.every((field) => Object.hasOwn(value, field)) &&
    Reflect.ownKeys(value).length === fields.length &&
    Reflect.ownKeys(value).every((field) => typeof field === "string" && fields.includes(field));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= ATTACHMENT_AUTHORITY_LIMITS.maxIdentifierUtf16 &&
    value === value.trim() && value.normalize("NFC") === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAuthorization(
  value: AttachmentDatabaseOperationResult,
): value is AttachmentAgentExtractionAuthorization {
  if (!isAttachmentDatabaseOperationResult(value) || !record(value) || !exact(value, [
    "kind", "executionId", "executionGeneration", "agentId", "roomId",
    "roomLifecycleGeneration", "roomAccessRevision", "attachmentId",
    "attachmentGeneration", "sourceMessageId", "sourceRevision", "originalFilename",
    "format", "method", "tool", "toolVersion", "pageCount", "objectKey", "sha256",
    "byteSize",
  ])) return false;
  return (value as Record<string, unknown>).kind === "agent-extraction";
}

function sameAuthorization(
  left: AttachmentAgentExtractionAuthorization,
  right: AttachmentAgentExtractionAuthorization,
): boolean {
  return Reflect.ownKeys(left).every((field) =>
    typeof field === "string" && left[field as keyof typeof left] === right[field as keyof typeof right]) &&
    Reflect.ownKeys(right).length === Reflect.ownKeys(left).length;
}

export function createAttachmentAgentExtractionReader(options: {
  readonly database: Pick<WorkerDatabaseClient, "executeAttachment">;
  readonly objectStore: Readonly<{
    readAuthorizedRange(
      objectKey: string,
      offset: number,
      maximumBytes: number,
    ): Promise<Readonly<{ bytes: Uint8Array; byteSize: number; eof: boolean }>>;
  }>;
  readonly nowMs: () => number;
  readonly chunkBytes?: number;
}): AttachmentAgentExtractionReadPort {
  const chunkBytes = options.chunkBytes ?? ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes;
  if (!positive(chunkBytes) || chunkBytes > ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes) {
    throw new TypeError("Agent attachment extraction chunk limit is invalid");
  }

  async function authorize(input: Readonly<{
    executionId: string;
    executionGeneration: number;
    attachmentId: string;
    attachmentGeneration: number;
  }>): Promise<AttachmentAgentExtractionAuthorization> {
    const now = options.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("Agent attachment extraction clock is invalid");
    }
    const value = await options.database.executeAttachment({
      kind: "agent-extraction-authorize",
      context: {
        kind: "agent-execution",
        executionId: input.executionId,
        expectedExecutionGeneration: input.executionGeneration,
      },
      attachmentId: input.attachmentId,
      expectedAttachmentGeneration: input.attachmentGeneration,
    }, now);
    if (!isAuthorization(value)) {
      throw new AttachmentAgentExtractionReaderError("storage_unavailable");
    }
    return value;
  }

  return Object.freeze({
    async read(input: Readonly<{
      executionId: string;
      executionGeneration: number;
      attachmentId: string;
      attachmentGeneration: number;
      maximumBytes: number;
    }>) {
      if (!record(input) || !exact(input, [
        "executionId", "executionGeneration", "attachmentId", "attachmentGeneration",
        "maximumBytes",
      ]) || !identifier(input.executionId) || !positive(input.executionGeneration) ||
          !identifier(input.attachmentId) || !positive(input.attachmentGeneration) ||
          !positive(input.maximumBytes) ||
          input.maximumBytes > ATTACHMENT_AUTHORITY_LIMITS.maxExtractionArtifactBytes) {
        throw new AttachmentAgentExtractionReaderError("invalid_request");
      }
      const authorityInput = {
        executionId: input.executionId,
        executionGeneration: input.executionGeneration,
        attachmentId: input.attachmentId,
        attachmentGeneration: input.attachmentGeneration,
      };
      const initial = await authorize(authorityInput);
      if (initial.byteSize > input.maximumBytes) {
        throw new AttachmentAgentExtractionReaderError("attachment_capacity_limited");
      }
      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (offset < initial.byteSize) {
        const before = await authorize(authorityInput);
        if (!sameAuthorization(initial, before)) {
          throw new AttachmentAgentExtractionReaderError("attachment_forbidden");
        }
        const maximum = Math.min(chunkBytes, initial.byteSize - offset);
        let range: Readonly<{ bytes: Uint8Array; byteSize: number; eof: boolean }>;
        try {
          range = await options.objectStore.readAuthorizedRange(initial.objectKey, offset, maximum);
        } catch {
          throw new AttachmentAgentExtractionReaderError("storage_unavailable");
        }
        const after = await authorize(authorityInput);
        if (!sameAuthorization(initial, after)) {
          throw new AttachmentAgentExtractionReaderError("attachment_forbidden");
        }
        if (!record(range) || !exact(range, ["bytes", "byteSize", "eof"]) ||
            !nodeTypes.isUint8Array(range.bytes) || range.bytes.byteLength === 0 ||
            range.bytes.byteLength > maximum || range.byteSize !== initial.byteSize ||
            typeof range.eof !== "boolean" ||
            range.eof !== (offset + range.bytes.byteLength === initial.byteSize)) {
          throw new AttachmentAgentExtractionReaderError("storage_unavailable");
        }
        chunks.push(new Uint8Array(range.bytes));
        offset += range.bytes.byteLength;
      }
      const bytes = new Uint8Array(initial.byteSize);
      let cursor = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new AttachmentAgentExtractionReaderError("storage_unavailable");
      }
      return Object.freeze({
        attachmentId: initial.attachmentId,
        source: Object.freeze({
          messageId: initial.sourceMessageId,
          revision: initial.sourceRevision,
        }),
        provenance: Object.freeze({
          method: initial.method,
          tool: initial.tool,
          version: initial.toolVersion,
          pageCount: initial.pageCount,
          sha256: initial.sha256,
          byteSize: initial.byteSize,
        }),
        text,
      });
    },
  });
}
