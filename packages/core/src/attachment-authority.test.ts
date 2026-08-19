import { describe, expect, it } from "vitest";
import * as core from "./index.js";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  attachmentDetectedMime,
  isAttachmentError,
  isAttachmentFormat,
  isAttachmentMetadata,
  isAttachmentPrivateEvent,
  isAttachmentRepairRecord,
  isAttachmentRoomEvent,
  isAttachmentSafeFilename,
  isAttachmentSha256,
  isAttachmentUiAxes,
  projectAttachmentUiState,
} from "./attachment-authority.js";

const createdAt = "2026-08-19T01:02:03.004Z";
const readyAt = "2026-08-19T01:03:04.005Z";
const sha256 = "a".repeat(64);
const extractionSha256 = "b".repeat(64);

const provenance = {
  scanner: {
    kind: "clamav" as const,
    version: "1.4.3",
  },
  extraction: {
    method: "plain-text" as const,
    tool: "builtin" as const,
    version: "1",
    artifactSha256: extractionSha256,
    artifactByteSize: 96,
    pageCount: null,
  },
  ocr: null,
};

const readyUnbound = {
  attachmentId: "attachment-1",
  roomId: "room-1",
  originalFilename: "requirements.txt",
  format: "txt" as const,
  declaredMime: "text/plain" as const,
  detectedMime: "text/plain" as const,
  byteSize: 128,
  sha256,
  uploaderActorId: "human-1",
  createdAt,
  readyAt,
  processingStatus: "ready" as const,
  generation: 1,
  sourceMessageId: null,
  provenance,
};

const readyBound = {
  ...readyUnbound,
  sourceMessageId: "message-1",
};

function hidden(value: object, key: PropertyKey, injected: unknown): object {
  Object.defineProperty(value, key, {
    configurable: true,
    enumerable: false,
    value: injected,
  });
  return value;
}

describe("FT-04 Attachment Authority Core contracts", () => {
  it("exports the closed Attachment Authority surface from the Core package root", () => {
    expect(core.isAttachmentMetadata).toBe(isAttachmentMetadata);
    expect(core.isAttachmentPrivateEvent).toBe(isAttachmentPrivateEvent);
    expect(core.isAttachmentRoomEvent).toBe(isAttachmentRoomEvent);
    expect(core.isAttachmentRepairRecord).toBe(isAttachmentRepairRecord);
    expect(core.projectAttachmentUiState).toBe(projectAttachmentUiState);
  });

  it("closes formats, canonical MIME values, hashes, sizes, and safe filenames", () => {
    expect(ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes).toBe(52_428_800);
    expect(ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes).toBe(32_768);
    expect([
      "pdf", "png", "jpeg", "docx", "xlsx", "txt", "csv",
    ].every(isAttachmentFormat)).toBe(true);
    expect(isAttachmentFormat("jpg")).toBe(false);
    expect(attachmentDetectedMime("pdf")).toBe("application/pdf");
    expect(attachmentDetectedMime("jpeg")).toBe("image/jpeg");
    expect(isAttachmentSha256(sha256)).toBe(true);
    expect(isAttachmentSha256(sha256.toUpperCase())).toBe(false);
    expect(isAttachmentSha256(` ${sha256}`)).toBe(false);

    for (const filename of [
      "brief.pdf", "diagram.PNG", "photo.jpeg", "photo.jpg", "sheet.xlsx",
      "notes.txt", "values.csv", "合同.docx",
    ]) {
      expect(isAttachmentSafeFilename(filename)).toBe(true);
    }
    for (const filename of [
      "", " brief.pdf", "brief.pdf ", ".", "..", "../brief.pdf", "a\\brief.pdf",
      "file:///tmp/brief.pdf", "https://example.test/brief.pdf", "C:\\brief.pdf",
      "brief.exe", "brief.pdf\0.exe", "safe\u202Efdp.exe",
    ]) {
      expect(isAttachmentSafeFilename(filename)).toBe(false);
    }
  });

  it("accepts safe exact metadata and rejects type mismatch, malformed values, and every extra key", () => {
    expect(isAttachmentMetadata(readyUnbound)).toBe(true);
    expect(isAttachmentMetadata(readyBound)).toBe(true);

    for (const candidate of [
      { ...readyUnbound, detectedMime: "application/pdf" },
      { ...readyUnbound, declaredMime: "application/pdf" },
      { ...readyUnbound, originalFilename: "requirements.pdf" },
      { ...readyUnbound, byteSize: 0 },
      { ...readyUnbound, byteSize: ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes + 1 },
      { ...readyUnbound, sha256: "A".repeat(64) },
      { ...readyUnbound, generation: 0 },
      { ...readyUnbound, readyAt: null },
      { ...readyUnbound, createdAt: "not-a-time" },
      { ...readyUnbound, path: "/tmp/requirements.txt" },
      { ...readyUnbound, url: "https://example.test/a" },
      { ...readyUnbound, token: "secret" },
      { ...readyUnbound, bytes: "raw" },
      { ...readyUnbound, extractedText: "leak" },
      { ...readyUnbound, rawScannerOutput: "leak" },
    ]) {
      expect(isAttachmentMetadata(candidate)).toBe(false);
    }

    const symbol = Symbol("path");
    expect(isAttachmentMetadata({ ...readyUnbound, [symbol]: "/tmp/file" })).toBe(false);
    expect(isAttachmentMetadata(hidden({ ...readyUnbound }, "token", "secret"))).toBe(false);
  });

  it("requires ready provenance only for ready metadata and keeps summaries bounded and closed", () => {
    const processing = {
      ...readyUnbound,
      readyAt: null,
      processingStatus: "processing" as const,
      provenance: null,
    };
    expect(isAttachmentMetadata(processing)).toBe(true);
    expect(isAttachmentMetadata({ ...processing, provenance })).toBe(false);
    expect(isAttachmentMetadata({ ...processing, sourceMessageId: "message-1" })).toBe(false);
    expect(isAttachmentMetadata({ ...readyUnbound, provenance: null })).toBe(false);
    expect(isAttachmentMetadata({
      ...readyUnbound,
      provenance: {
        ...provenance,
        extraction: { ...provenance.extraction, extractedText: "forbidden" },
      },
    })).toBe(false);
    expect(isAttachmentMetadata({
      ...readyUnbound,
      provenance: {
        ...provenance,
        scanner: { ...provenance.scanner, rawOutput: "forbidden" },
      },
    })).toBe(false);
  });

  it("validates exact four-axis inputs and deterministically maps every approved J-02 state", () => {
    const axes = {
      localTransport: { status: "selected" as const },
      durableProcessing: { status: "none" as const },
      sourceEligibility: "unbound" as const,
      accessProjection: "authorized" as const,
    };
    expect(isAttachmentUiAxes(axes)).toBe(true);
    expect(projectAttachmentUiState(axes)).toBe("local-selected");
    expect(projectAttachmentUiState({
      ...axes,
      localTransport: {
        status: "uploading",
        acknowledgedBytes: 32_768,
        totalBytes: 65_536,
      },
      durableProcessing: { status: "open" },
    })).toBe("uploading");
    expect(projectAttachmentUiState({
      ...axes,
      durableProcessing: { status: "accepted-quarantined" },
    })).toBe("processing");
    expect(projectAttachmentUiState({
      ...axes,
      durableProcessing: { status: "processing", stage: "ocr" },
    })).toBe("processing");
    expect(projectAttachmentUiState({
      ...axes,
      durableProcessing: { status: "ready" },
    })).toBe("ready");
    expect(projectAttachmentUiState({
      ...axes,
      localTransport: { status: "transport-failed" },
    })).toBe("retryable-failure");
    expect(projectAttachmentUiState({
      ...axes,
      durableProcessing: { status: "retryable-failed" },
    })).toBe("retryable-failure");
    expect(projectAttachmentUiState({
      ...axes,
      durableProcessing: { status: "nonretryable-failed", reason: "encrypted-pdf" },
    })).toBe("nonretryable-failure");
    expect(projectAttachmentUiState({
      ...axes,
      durableProcessing: { status: "cancelled" },
    })).toBe("cancelled");
    expect(projectAttachmentUiState({
      ...axes,
      localTransport: { status: "local-rejected", reason: "type" },
    })).toBe("size-type-rejected");
    expect(projectAttachmentUiState({
      ...axes,
      durableProcessing: { status: "nonretryable-failed", reason: "type" },
    })).toBe("size-type-rejected");
    expect(projectAttachmentUiState({
      ...axes,
      durableProcessing: { status: "malware-rejected" },
    })).toBe("malware-rejected");
    expect(projectAttachmentUiState({
      ...axes,
      accessProjection: "permission-revoked",
      durableProcessing: { status: "malware-rejected" },
    })).toBe("permission-revoked");
  });

  it("treats archive, offline, repairing, and recall as orthogonal capability modifiers", () => {
    const ready = {
      localTransport: { status: "none" as const },
      durableProcessing: { status: "ready" as const },
      sourceEligibility: "bound-active" as const,
      accessProjection: "authorized" as const,
    };
    expect(projectAttachmentUiState({ ...ready, accessProjection: "archived-read-only" }))
      .toBe("ready");
    expect(projectAttachmentUiState({ ...ready, accessProjection: "offline" })).toBe("ready");
    expect(projectAttachmentUiState({ ...ready, accessProjection: "repairing" })).toBe("ready");
    expect(projectAttachmentUiState({ ...ready, sourceEligibility: "excluded-recalled" }))
      .toBeUndefined();
    expect(projectAttachmentUiState({
      ...ready,
      sourceEligibility: "excluded-recalled",
      accessProjection: "permission-revoked",
    })).toBe("permission-revoked");
  });

  it("rejects impossible, unbounded, injected, and malformed axis combinations", () => {
    const base = {
      localTransport: { status: "uploading", acknowledgedBytes: 2, totalBytes: 1 },
      durableProcessing: { status: "open" },
      sourceEligibility: "unbound",
      accessProjection: "authorized",
    };
    expect(isAttachmentUiAxes(base)).toBe(false);
    expect(isAttachmentUiAxes({
      ...base,
      localTransport: { status: "selected", path: "/tmp/file.pdf" },
    })).toBe(false);
    expect(isAttachmentUiAxes({
      ...base,
      localTransport: { status: "none" },
      durableProcessing: { status: "ready", token: "secret" },
    })).toBe(false);
    expect(isAttachmentUiAxes({
      localTransport: { status: "none" },
      durableProcessing: { status: "none" },
      sourceEligibility: "bound-active",
      accessProjection: "authorized",
    })).toBe(false);
  });

  it("accepts uploader-private events without exposing unbound metadata to a Room stream", () => {
    const event = {
      eventId: "event-private-1",
      streamKind: "principal" as const,
      streamId: "human-1",
      streamSeq: 1,
      actorId: "human-1",
      occurredAt: readyAt,
      type: "attachment.private.status-changed" as const,
      payload: { attachment: readyUnbound },
    };
    expect(isAttachmentPrivateEvent(event)).toBe(true);
    expect(isAttachmentPrivateEvent({ ...event, roomId: "room-1" })).toBe(false);
    expect(isAttachmentPrivateEvent({
      ...event,
      payload: { attachment: { ...readyUnbound, sourceMessageId: "message-1" } },
    })).toBe(false);
    expect(isAttachmentRoomEvent(event)).toBe(false);
  });

  it("accepts only bound/excluded Room events with safe exact payloads", () => {
    const bound = {
      eventId: "event-bound-1",
      streamKind: "room" as const,
      streamId: "room-1",
      streamSeq: 7,
      roomId: "room-1",
      actorId: "human-1",
      occurredAt: readyAt,
      type: "room.attachment.bound" as const,
      payload: {
        attachment: readyBound,
        sourceEligibility: "bound-active" as const,
      },
    };
    const excluded = {
      ...bound,
      eventId: "event-excluded-1",
      streamSeq: 8,
      type: "room.attachment.excluded" as const,
      payload: {
        attachmentId: readyBound.attachmentId,
        sourceMessageId: readyBound.sourceMessageId,
        generation: readyBound.generation,
        sourceEligibility: "excluded-recalled" as const,
        reason: "message-recalled" as const,
      },
    };
    expect(isAttachmentRoomEvent(bound)).toBe(true);
    expect(isAttachmentRoomEvent(excluded)).toBe(true);
    expect(isAttachmentRoomEvent({ ...bound, streamId: "room-2" })).toBe(false);
    expect(isAttachmentRoomEvent({
      ...bound,
      payload: { ...bound.payload, attachment: readyUnbound },
    })).toBe(false);
    expect(isAttachmentRoomEvent({
      ...excluded,
      payload: { ...excluded.payload, extractedText: "forbidden" },
    })).toBe(false);
  });

  it("repairs only ready bound-active metadata and never unbound or recalled artifacts", () => {
    const record = {
      kind: "attachment" as const,
      value: {
        attachment: readyBound,
        sourceEligibility: "bound-active" as const,
      },
    };
    expect(isAttachmentRepairRecord(record, "room-1")).toBe(true);
    expect(isAttachmentRepairRecord(record, "room-2")).toBe(false);
    expect(isAttachmentRepairRecord({
      ...record,
      value: { ...record.value, attachment: readyUnbound },
    })).toBe(false);
    expect(isAttachmentRepairRecord({
      ...record,
      value: { ...record.value, sourceEligibility: "excluded-recalled" },
    })).toBe(false);
    expect(isAttachmentRepairRecord({ ...record, path: "/objects/a" })).toBe(false);
  });

  it("closes every approved status/code combination and retry hint", () => {
    const accepted = [
      { status: 400, code: "invalid_request" },
      { status: 400, code: "invalid_chunk" },
      { status: 401, code: "unauthenticated" },
      { status: 403, code: "room_forbidden" },
      { status: 403, code: "attachment_forbidden" },
      { status: 409, code: "idempotency_conflict" },
      { status: 409, code: "upload_offset_conflict" },
      { status: 409, code: "attachment_already_bound" },
      { status: 409, code: "generation_conflict" },
      { status: 409, code: "attachment_not_ready" },
      { status: 410, code: "upload_expired" },
      { status: 410, code: "attachment_gone" },
      { status: 410, code: "protocol_upgrade_required" },
      { status: 413, code: "attachment_too_large" },
      { status: 413, code: "chunk_too_large" },
      { status: 415, code: "attachment_type_unsupported" },
      { status: 415, code: "type_mismatch" },
      { status: 422, code: "attachment_malformed" },
      { status: 422, code: "encrypted_pdf" },
      { status: 422, code: "archive_bomb" },
      { status: 422, code: "image_bomb" },
      { status: 429, code: "attachment_capacity_limited", retryAfterSeconds: 3 },
      { status: 503, code: "storage_unavailable" },
      { status: 503, code: "scanner_unavailable" },
      { status: 503, code: "extractor_unavailable" },
      { status: 503, code: "ocr_unavailable" },
      { status: 503, code: "repair_barrier_active" },
    ] as const;
    expect(accepted.every(isAttachmentError)).toBe(true);
    expect(isAttachmentError({ status: 400, code: "scanner_unavailable" })).toBe(false);
    expect(isAttachmentError({ status: 429, code: "attachment_capacity_limited" })).toBe(false);
    expect(isAttachmentError({
      status: 503,
      code: "scanner_unavailable",
      retryAfterSeconds: 2,
    })).toBe(false);
    expect(isAttachmentError({
      status: 403,
      code: "attachment_forbidden",
      path: "/private/object",
    })).toBe(false);
    expect(isAttachmentError({
      status: 422,
      code: "attachment_malformed",
      rawOutput: "tool stderr",
    })).toBe(false);
  });
});
