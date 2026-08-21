// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  AttachmentAgentExtractionAuthorization,
  AttachmentDatabaseOperation,
  AttachmentDatabaseOperationResult,
} from "./database-contracts.js";
import {
  isAttachmentDatabaseOperation,
  isAttachmentDatabaseOperationResult,
} from "./database-contracts.js";
import {
  AttachmentAgentExtractionReaderError,
  createAttachmentAgentExtractionReader,
} from "./agent-extraction-reader.js";

const SHA = "b".repeat(64);

function authorization(overrides: Partial<AttachmentAgentExtractionAuthorization> = {}):
AttachmentAgentExtractionAuthorization {
  return Object.freeze({
    kind: "agent-extraction",
    executionId: "execution-1",
    executionGeneration: 2,
    agentId: "agent-1",
    roomId: "room-1",
    roomLifecycleGeneration: 3,
    roomAccessRevision: 4,
    attachmentId: "attachment-1",
    attachmentGeneration: 5,
    sourceMessageId: "message-1",
    sourceRevision: 1,
    originalFilename: "evidence.txt",
    format: "txt",
    method: "plain-text",
    tool: "builtin",
    toolVersion: "1",
    pageCount: null,
    objectKey: `extraction_${SHA}`,
    sha256: SHA,
    byteSize: 5,
    ...overrides,
  });
}

describe("server-private Agent attachment extraction reader", () => {
  it("keeps the worker operation and opaque result contracts exact", () => {
    const operation = {
      kind: "agent-extraction-authorize",
      context: {
        kind: "agent-execution",
        executionId: "execution-1",
        expectedExecutionGeneration: 2,
      },
      attachmentId: "attachment-1",
      expectedAttachmentGeneration: 5,
    } as const;
    expect(isAttachmentDatabaseOperation(operation)).toBe(true);
    expect(isAttachmentDatabaseOperation({ ...operation, objectKey: `extraction_${SHA}` }))
      .toBe(false);
    expect(isAttachmentDatabaseOperationResult(authorization())).toBe(true);
    expect(isAttachmentDatabaseOperationResult({
      ...authorization(),
      objectKey: `extraction_${"a".repeat(64)}`,
    })).toBe(false);
    const hidden = { ...operation } as Record<PropertyKey, unknown>;
    Object.defineProperty(hidden, "path", { value: "/tmp/private", enumerable: false });
    expect(isAttachmentDatabaseOperation(hidden)).toBe(false);
  });

  it("reauthorizes before and after every bounded range and returns source/provenance", async () => {
    const expected = authorization();
    const executeAttachment = vi.fn(async (
      operation: AttachmentDatabaseOperation,
    ): Promise<AttachmentDatabaseOperationResult> => {
      expect(operation).toEqual({
        kind: "agent-extraction-authorize",
        context: {
          kind: "agent-execution",
          executionId: "execution-1",
          expectedExecutionGeneration: 2,
        },
        attachmentId: "attachment-1",
        expectedAttachmentGeneration: 5,
      });
      return expected;
    });
    const readAuthorizedRange = vi.fn(async (_key: string, offset: number, maximum: number) => {
      const bytes = new TextEncoder().encode("hello").slice(offset, offset + maximum);
      return { bytes, byteSize: 5, eof: offset + bytes.byteLength === 5 };
    });
    const reader = createAttachmentAgentExtractionReader({
      database: { executeAttachment },
      objectStore: { readAuthorizedRange },
      nowMs: () => 1,
      chunkBytes: 2,
    });
    const result = await reader.read({
      executionId: "execution-1",
      executionGeneration: 2,
      attachmentId: "attachment-1",
      attachmentGeneration: 5,
      maximumBytes: 5,
    });
    expect(result).toEqual({
      attachmentId: "attachment-1",
      source: { messageId: "message-1", revision: 1 },
      provenance: {
        method: "plain-text", tool: "builtin", version: "1", pageCount: null,
        sha256: SHA, byteSize: 5,
      },
      text: "hello",
    });
    expect(readAuthorizedRange).toHaveBeenCalledTimes(3);
    expect(executeAttachment).toHaveBeenCalledTimes(7);
    expect(JSON.stringify(result)).not.toContain("objectKey");
    expect(JSON.stringify(result)).not.toContain("extraction_");
  });

  it("reads reauthorized UTF-8-safe extraction segments without loading the full artifact", async () => {
    const artifact = new TextEncoder().encode("A💙B");
    const expected = authorization({ byteSize: artifact.byteLength });
    const executeAttachment = vi.fn(async () => expected);
    const readAuthorizedRange = vi.fn(async (_key: string, offset: number, maximum: number) => {
      const bytes = artifact.slice(offset, offset + maximum);
      return {
        bytes,
        byteSize: artifact.byteLength,
        eof: offset + bytes.byteLength === artifact.byteLength,
      };
    });
    const reader = createAttachmentAgentExtractionReader({
      database: { executeAttachment },
      objectStore: { readAuthorizedRange },
      nowMs: () => 1,
    });

    const first = await reader.readSegment({
      executionId: "execution-1",
      executionGeneration: 2,
      attachmentId: "attachment-1",
      attachmentGeneration: 5,
      offset: 0,
      maximumBytes: 4,
    });
    const second = await reader.readSegment({
      executionId: "execution-1",
      executionGeneration: 2,
      attachmentId: "attachment-1",
      attachmentGeneration: 5,
      offset: first.segment.endByte,
      maximumBytes: 5,
    });

    expect(first).toMatchObject({
      text: "A",
      segment: { startByte: 0, endByte: 1, eof: false },
      provenance: { sha256: SHA, byteSize: artifact.byteLength },
    });
    expect(second).toMatchObject({
      text: "💙B",
      segment: { startByte: 1, endByte: artifact.byteLength, eof: true },
    });
    expect(readAuthorizedRange).toHaveBeenNthCalledWith(1, `extraction_${SHA}`, 0, 4);
    expect(readAuthorizedRange).toHaveBeenNthCalledWith(2, `extraction_${SHA}`, 1, 5);
    expect(executeAttachment).toHaveBeenCalledTimes(6);
  });

  it("reads zero bytes when initial authorization is denied", async () => {
    const denied = new Error("attachment_forbidden");
    const readAuthorizedRange = vi.fn();
    const reader = createAttachmentAgentExtractionReader({
      database: { executeAttachment: vi.fn(async () => { throw denied; }) },
      objectStore: { readAuthorizedRange },
      nowMs: () => 1,
    });
    await expect(reader.read({
      executionId: "execution-1", executionGeneration: 2,
      attachmentId: "attachment-1", attachmentGeneration: 5, maximumBytes: 5,
    })).rejects.toBe(denied);
    expect(readAuthorizedRange).not.toHaveBeenCalled();
  });

  it("discards a range if recall, revoke, archive, or generation changes during the read", async () => {
    const expected = authorization();
    let calls = 0;
    const readAuthorizedRange = vi.fn(async () => ({
      bytes: new TextEncoder().encode("hello"), byteSize: 5, eof: true,
    }));
    const reader = createAttachmentAgentExtractionReader({
      database: {
        executeAttachment: vi.fn(async () => {
          calls += 1;
          return calls < 3 ? expected : authorization({ roomAccessRevision: 6 });
        }),
      },
      objectStore: { readAuthorizedRange },
      nowMs: () => 1,
    });
    await expect(reader.read({
      executionId: "execution-1", executionGeneration: 2,
      attachmentId: "attachment-1", attachmentGeneration: 5, maximumBytes: 5,
    })).rejects.toMatchObject({
      constructor: AttachmentAgentExtractionReaderError,
      code: "attachment_forbidden",
    });
    expect(readAuthorizedRange).toHaveBeenCalledTimes(1);
  });

  it("fails closed on oversized or malformed UTF-8 extraction artifacts", async () => {
    const expected = authorization();
    const base = {
      database: { executeAttachment: vi.fn(async () => expected) },
      nowMs: () => 1,
    };
    const oversized = createAttachmentAgentExtractionReader({
      ...base,
      objectStore: { readAuthorizedRange: vi.fn() },
    });
    await expect(oversized.read({
      executionId: "execution-1", executionGeneration: 2,
      attachmentId: "attachment-1", attachmentGeneration: 5, maximumBytes: 4,
    })).rejects.toMatchObject({ code: "attachment_capacity_limited" });

    const malformed = createAttachmentAgentExtractionReader({
      ...base,
      objectStore: {
        readAuthorizedRange: vi.fn(async () => ({
          bytes: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), byteSize: 5, eof: true,
        })),
      },
    });
    await expect(malformed.read({
      executionId: "execution-1", executionGeneration: 2,
      attachmentId: "attachment-1", attachmentGeneration: 5, maximumBytes: 5,
    })).rejects.toMatchObject({ code: "storage_unavailable" });

    const malformedSegment = createAttachmentAgentExtractionReader({
      ...base,
      objectStore: {
        readAuthorizedRange: vi.fn(async () => ({
          bytes: new Uint8Array([0x41, 0xff, 0xff, 0xff, 0xff]),
          byteSize: 5,
          eof: true,
        })),
      },
    });
    await expect(malformedSegment.readSegment({
      executionId: "execution-1", executionGeneration: 2,
      attachmentId: "attachment-1", attachmentGeneration: 5,
      offset: 0, maximumBytes: 5,
    })).rejects.toMatchObject({ code: "storage_unavailable" });
  });
});
