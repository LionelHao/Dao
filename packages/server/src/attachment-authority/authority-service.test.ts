import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMetadata } from "@native-im/core";
import type { AuthenticatedCommandContext } from "../persistence/contracts.js";
import type {
  AttachmentDatabaseOperation,
  AttachmentDatabaseOperationResult,
} from "./database-contracts.js";
import { AttachmentObjectStore } from "./object-store.js";
import { createAttachmentAuthorityService } from "./authority-service.js";

const roots: string[] = [];
const context: AuthenticatedCommandContext = Object.freeze({
  kind: "human",
  requestId: "transport-request",
  idempotencyKey: "transport-key",
  sessionId: "session-1",
  sessionFamilyId: "family-1",
  principal: Object.freeze({ accountId: "account-1", actorId: "actor-1" }),
});

const readyMetadata: AttachmentMetadata = Object.freeze({
  attachmentId: "attachment-status-1",
  roomId: "room-1",
  originalFilename: "安全报告.pdf",
  format: "pdf",
  declaredMime: "application/pdf",
  detectedMime: "application/pdf",
  byteSize: 65_536,
  sha256: "a".repeat(64),
  uploaderActorId: "actor-1",
  createdAt: "2026-08-19T08:00:00.000Z",
  readyAt: "2026-08-19T08:01:00.000Z",
  processingStatus: "ready",
  generation: 2,
  sourceMessageId: "message-1",
  provenance: Object.freeze({
    scanner: Object.freeze({ kind: "clamav", version: "1.4.3" }),
    extraction: Object.freeze({
      method: "pdf-text", tool: "pdftotext", version: "25.06.0",
      artifactSha256: "b".repeat(64), artifactByteSize: 1_024, pageCount: 2,
    }),
    ocr: null,
  }),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store(): Promise<AttachmentObjectStore> {
  const root = await mkdtemp(join(tmpdir(), "dao-attachment-service-"));
  roots.push(root);
  const value = new AttachmentObjectStore({
    root,
    limits: {
      maxChunkBytes: 32_768,
      maxFileBytes: 50 * 1_024 * 1_024,
      maxExtractionBytes: 8 * 1_024 * 1_024,
      reconcileMaxEntries: 128,
      reconcileMaxBytes: 256 * 1_024 * 1_024,
    },
  });
  await value.initialize();
  return value;
}

function worker(
  execute: (operation: AttachmentDatabaseOperation) => AttachmentDatabaseOperationResult,
) {
  return { executeAttachment: vi.fn(async (operation: AttachmentDatabaseOperation) => execute(operation)) };
}

describe("attachment authority service", () => {
  it("preserves only guarded safe metadata and reauthorization projections in status DTOs", async () => {
    const database = worker((operation) => {
      if (operation.kind !== "status-read") throw new Error("unexpected operation");
      return {
        attachment: readyMetadata,
        sourceEligibility: "bound-active",
        accessProjection: "authorized",
      };
    });
    const service = createAttachmentAuthorityService({
      database,
      objectStore: await store(),
      processor: { enqueue: async () => undefined },
      nowMs: () => 1_000,
      nextGrantId: randomUUID,
    });

    const status = await service.execute(context, {
      type: "attachment.status.query",
      requestId: "status-1",
      attachmentId: readyMetadata.attachmentId,
    });

    expect(status).toEqual({
      type: "attachment.status",
      requestId: "status-1",
      attachment: readyMetadata,
      sourceEligibility: "bound-active",
      accessProjection: "authorized",
    });
    expect(JSON.stringify(status)).not.toMatch(/objectKey|path|token|raw|extractedText|base64/u);
  });

  it("fails closed when the database seam injects storage authority into status metadata", async () => {
    const database = worker(() => ({
      attachment: { ...readyMetadata, objectKey: "object_secret" },
      sourceEligibility: "bound-active",
      accessProjection: "authorized",
    } as unknown as AttachmentDatabaseOperationResult));
    const service = createAttachmentAuthorityService({
      database,
      objectStore: await store(),
      processor: { enqueue: async () => undefined },
      nowMs: () => 1_000,
      nextGrantId: randomUUID,
    });

    await expect(service.execute(context, {
      type: "attachment.status.query", requestId: "status-injected",
      attachmentId: readyMetadata.attachmentId,
    })).rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
  });

  it("closes begin/chunk/finalize across the single writer and quarantine store before enqueue", async () => {
    const bytes = Buffer.from("hello attachment");
    const wholeSha = createHash("sha256").update(bytes).digest("hex");
    const uploadId = randomUUID();
    const attachmentId = randomUUID();
    let acknowledged = 0;
    const database = worker((operation) => {
      switch (operation.kind) {
        case "upload-begin":
          return { uploadId, acknowledgedBytes: acknowledged, expectedBytes: bytes.byteLength,
            status: "open", replayed: false };
        case "upload-chunk":
          acknowledged = operation.command.offset + operation.command.byteLength;
          return { uploadId, ordinal: operation.command.ordinal, acknowledgedBytes: acknowledged,
            expectedBytes: bytes.byteLength, replayed: false };
        case "upload-plan":
          return { uploadId, attachmentId, chunkCount: 1, expectedBytes: bytes.byteLength,
            expectedSha256: wholeSha, format: "txt" };
        case "upload-finalize":
          expect(operation.command.storage).toMatchObject({
            byteSize: bytes.byteLength,
            sha256: wholeSha,
            format: "txt",
            detectedMime: "text/plain",
          });
          return { uploadId, attachmentId, status: "accepted-quarantined", generation: 1,
            privateEventId: "private-event-1", replayed: false };
        default:
          throw new Error(`unexpected ${operation.kind}`);
      }
    });
    const enqueue = vi.fn(async () => undefined);
    const service = createAttachmentAuthorityService({
      database,
      objectStore: await store(),
      processor: { enqueue },
      nowMs: () => 1_000,
      nextGrantId: randomUUID,
    });
    await expect(service.execute(context, {
      type: "attachment.upload.begin",
      requestId: "begin-1",
      roomId: "room-1",
      uploadKey: "upload-key-1",
      originalFilename: "safe.txt",
      declaredMime: "text/plain",
      expectedBytes: bytes.byteLength,
      expectedSha256: wholeSha,
    })).resolves.toEqual({
      type: "attachment.upload.begun",
      requestId: "begin-1",
      uploadId,
      acknowledgedBytes: 0,
    });
    await expect(service.execute(context, {
      type: "attachment.upload.chunk",
      requestId: "chunk-1",
      uploadId,
      ordinal: 0,
      offset: 0,
      byteLength: bytes.byteLength,
      chunkSha256: wholeSha,
      base64: bytes.toString("base64"),
    })).resolves.toEqual({
      type: "attachment.upload.chunk.ack",
      requestId: "chunk-1",
      uploadId,
      acknowledgedBytes: bytes.byteLength,
    });
    await expect(service.execute(context, {
      type: "attachment.upload.finalize",
      requestId: "finalize-1",
      uploadId,
    })).resolves.toEqual({
      type: "attachment.upload.accepted",
      requestId: "finalize-1",
      attachmentId,
      processingStatus: "accepted-quarantined",
    });
    expect(enqueue).toHaveBeenCalledWith({ attachmentId, generation: 1 });
  });

  it("reauthorizes every sequential download grant read and never returns object keys", async () => {
    const bytes = Buffer.from("download-me");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const uploadId = randomUUID();
    const attachmentId = randomUUID();
    const objects = await store();
    await objects.writeChunk({ uploadId, ordinal: 0, bytes, sha256 });
    await objects.assembleQuarantine({
      uploadId, attachmentId, chunkCount: 1, expectedBytes: bytes.byteLength, expectedSha256: sha256,
    });
    const published = await objects.publishCleanObject({ attachmentId });
    const database = worker((operation) => {
      if (operation.kind !== "access-authorize") throw new Error("unexpected operation");
      return {
        allowed: true,
        attachmentId,
        generation: 2,
        lifecycleGeneration: 3,
        accessRevision: 4,
        operation: "download",
        representation: "original",
        originalFilename: "download.txt",
        objectKey: published.objectKey,
        sha256,
        byteSize: bytes.byteLength,
      };
    });
    const service = createAttachmentAuthorityService({
      database,
      objectStore: objects,
      processor: { enqueue: async () => undefined },
      nowMs: () => 1_000,
      nextGrantId: () => "00000000-0000-4000-8000-000000000001",
    });
    const opened = await service.execute(context, {
      type: "attachment.download.open",
      requestId: "download-open",
      attachmentId,
    });
    expect(opened).toEqual({
      type: "attachment.download.opened",
      requestId: "download-open",
      streamId: "00000000-0000-4000-8000-000000000001",
      byteSize: bytes.byteLength,
      originalFilename: "download.txt",
    });
    expect(JSON.stringify(opened)).not.toContain("object_");
    const first = await service.execute(context, {
      type: "attachment.stream.read",
      requestId: "read-1",
      streamId: opened.streamId,
      offset: 0,
      maximumBytes: 4,
    });
    const second = await service.execute(context, {
      type: "attachment.stream.read",
      requestId: "read-2",
      streamId: opened.streamId,
      offset: 4,
      maximumBytes: 32_768,
    });
    expect(first).toMatchObject({ type: "attachment.stream.chunk", byteLength: 4, eof: false });
    expect(second).toMatchObject({ type: "attachment.stream.chunk", byteLength: bytes.byteLength - 4, eof: true });
    expect(Buffer.from(first.base64, "base64").toString()).toBe("down");
    expect(Buffer.from(second.base64, "base64").toString()).toBe("load-me");
    expect(database.executeAttachment).toHaveBeenCalledTimes(3);
  });
});
