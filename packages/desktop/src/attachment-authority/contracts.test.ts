import { describe, expect, it } from "vitest";
import { isAttachmentStatusResult } from "./contracts.js";

const metadata = {
  attachmentId: "attachment-1", roomId: "room-1", originalFilename: "safe.txt",
  format: "txt", declaredMime: "text/plain", detectedMime: "text/plain", byteSize: 4,
  sha256: "a".repeat(64), uploaderActorId: "human-1",
  createdAt: "2026-08-19T08:00:00.000Z", readyAt: null,
  processingStatus: "processing", generation: 1, sourceMessageId: null, provenance: null,
};

describe("Attachment Authority renderer DTO guards", () => {
  it("accepts exact safe metadata and rejects authority secret/byte injection", () => {
    const status = {
      type: "attachment.status", attachment: metadata,
      sourceEligibility: "unbound", accessProjection: "authorized",
    };
    expect(isAttachmentStatusResult(status)).toBe(true);
    for (const injected of [
      { ...status, path: "/private/tmp/report.txt" },
      { ...status, token: "secret" },
      { ...status, attachment: { ...metadata, objectKey: "object_secret" } },
      { ...status, attachment: { ...metadata, raw: "AAAA" } },
      { ...status, attachment: { ...metadata, extractedText: "private contents" } },
    ]) {
      expect(isAttachmentStatusResult(injected)).toBe(false);
    }
  });

  it("requires source eligibility to match the safe metadata source", () => {
    expect(isAttachmentStatusResult({
      type: "attachment.status", attachment: metadata,
      sourceEligibility: "bound-active", accessProjection: "authorized",
    })).toBe(false);
  });
});
