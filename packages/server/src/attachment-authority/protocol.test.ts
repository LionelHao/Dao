import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  type AttachmentDetectedMime,
} from "@native-im/core";
import {
  ATTACHMENT_FRAME_MAX_BYTES,
  parseAttachmentClientFrame,
} from "./protocol.js";

const sha256 = createHash("sha256").update("attachment").digest("hex");

const begin = {
  type: "attachment.upload.begin",
  requestId: "request-1",
  roomId: "room-1",
  uploadKey: "upload-key-1",
  originalFilename: "notes.txt",
  declaredMime: "text/plain" as AttachmentDetectedMime,
  expectedBytes: 42,
  expectedSha256: sha256,
};

describe("attachment client protocol", () => {
  it("parses the closed begin frame and rejects server-owned or path-shaped fields", () => {
    expect(parseAttachmentClientFrame(begin)).toEqual({ ok: true, frame: begin });
    for (const injected of [
      { path: "/tmp/notes.txt" },
      { attachmentId: "forged" },
      { uploaderActorId: "forged" },
      { sourceMessageId: "forged" },
      { objectKey: "forged" },
      { sessionFamilyId: "forged" },
      { token: "secret" },
      { url: "https://example.test/upload" },
    ]) {
      const result = parseAttachmentClientFrame({ ...begin, ...injected });
      expect(result).toMatchObject({ ok: false, error: { status: 400, code: "invalid_request" } });
    }
  });

  it("enforces canonical filename, MIME, byte and digest boundaries", () => {
    expect(parseAttachmentClientFrame({ ...begin, declaredMime: null })).toMatchObject({ ok: true });
    for (const changed of [
      { originalFilename: "../notes.txt" },
      { originalFilename: "notes.exe" },
      { declaredMime: "application/octet-stream" },
      { expectedBytes: 0 },
      { expectedBytes: ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes + 1 },
      { expectedSha256: "A".repeat(64) },
      { uploadKey: "" },
    ]) {
      expect(parseAttachmentClientFrame({ ...begin, ...changed })).toMatchObject({ ok: false });
    }
  });

  it("parses a canonical 32 KiB chunk below the existing 64 KiB websocket ceiling", () => {
    const bytes = Buffer.alloc(ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes, 0xa5);
    const frame = {
      type: "attachment.upload.chunk",
      requestId: "r".repeat(128),
      uploadId: "upload-1",
      ordinal: 1599,
      offset: ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes - bytes.byteLength,
      byteLength: bytes.byteLength,
      chunkSha256: createHash("sha256").update(bytes).digest("hex"),
      base64: bytes.toString("base64"),
    };
    expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThan(ATTACHMENT_FRAME_MAX_BYTES);
    expect(parseAttachmentClientFrame(frame)).toEqual({ ok: true, frame });
  });

  it("rejects noncanonical base64, changed length/hash shape, oversize and extra chunk fields", () => {
    const bytes = Buffer.from("chunk");
    const frame = {
      type: "attachment.upload.chunk",
      requestId: "request-2",
      uploadId: "upload-1",
      ordinal: 0,
      offset: 0,
      byteLength: bytes.byteLength,
      chunkSha256: createHash("sha256").update(bytes).digest("hex"),
      base64: bytes.toString("base64"),
    };
    expect(parseAttachmentClientFrame(frame)).toMatchObject({ ok: true });
    for (const changed of [
      { base64: "@@@" },
      { base64: `${frame.base64}\n` },
      { byteLength: bytes.byteLength + 1 },
      { chunkSha256: "short" },
      { ordinal: -1 },
      { offset: -1 },
      { base64: Buffer.alloc(ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes + 1).toString("base64"),
        byteLength: ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes + 1 },
      { path: "/tmp/chunk" },
    ]) {
      expect(parseAttachmentClientFrame({ ...frame, ...changed })).toMatchObject({ ok: false });
    }
  });

  it("parses finalize, cancel, retry, status, preview, download and bounded grant reads as exact operations", () => {
    const frames = [
      { type: "attachment.upload.finalize", requestId: "r1", uploadId: "upload-1" },
      { type: "attachment.upload.cancel", requestId: "r2", uploadId: "upload-1" },
      { type: "attachment.processing.retry", requestId: "r3", attachmentId: "attachment-1", expectedGeneration: 2 },
      { type: "attachment.status.query", requestId: "r4", attachmentId: "attachment-1" },
      { type: "attachment.preview.open", requestId: "r5", attachmentId: "attachment-1", representation: "safe-text" },
      { type: "attachment.download.open", requestId: "r6", attachmentId: "attachment-1" },
      { type: "attachment.stream.read", requestId: "r7", streamId: "stream-1", offset: 0, maximumBytes: 32 * 1_024 },
    ] as const;
    for (const frame of frames) expect(parseAttachmentClientFrame(frame)).toEqual({ ok: true, frame });
    for (const frame of frames) {
      expect(parseAttachmentClientFrame({ ...frame, token: "secret" })).toMatchObject({ ok: false });
    }
    for (const maximumBytes of [0, ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes + 1, 1.5]) {
      expect(parseAttachmentClientFrame({
        type: "attachment.stream.read",
        requestId: "r8",
        streamId: "stream-1",
        offset: 0,
        maximumBytes,
      })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
  });

  it("uses stable closed status/code pairs and never echoes unsafe input", () => {
    const result = parseAttachmentClientFrame({
      ...begin,
      originalFilename: "/Users/person/secret.txt",
    });
    expect(result).toEqual({
      ok: false,
      error: {
        status: 400,
        code: "invalid_request",
        message: "Invalid attachment request",
        requestId: "request-1",
      },
    });
    expect(JSON.stringify(result)).not.toContain("/Users/person");
  });
});
