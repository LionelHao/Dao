import { describe, expect, it, vi } from "vitest";
import type { MemoryStewardProvider as ClosedMemoryStewardProvider } from "./contracts.js";
import { createMemoryStewardProviderAdapter } from "./steward-provider-adapter.js";
import type { MemoryStewardBatch } from "./memory-steward-runtime.js";

function batch(sources: MemoryStewardBatch["sources"]): MemoryStewardBatch {
  return {
    roomId: "room-1",
    jobId: "job-1",
    attemptId: "attempt-1",
    recoveryGeneration: 1,
    fromWatermarkExclusive: 0,
    toCorpusSeqInclusive: sources.length,
    sourceCount: sources.length,
    sources,
  };
}

const messageSource = Object.freeze({
  corpusSeq: 1,
  sourceKind: "message" as const,
  sourceId: "message:message-1",
  sourceRevision: 1,
  eligibility: "eligible" as const,
  availability: "readable" as const,
});

describe("FT-05 production memory steward provider adapter", () => {
  it("sends only current eligible sources while preserving the full batch watermark", async () => {
    const generate = vi.fn<ClosedMemoryStewardProvider["generate"]>(async () => ({
      schemaVersion: 1,
      candidates: [{
        operation: "create",
        kind: "context",
        derivedText: "Friday launch.",
        sourceRefs: [{
          sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
        }],
        dedupeKey: "launch",
        replacesMemoryRecordId: null,
      }],
    }));
    const authorizeSource = vi.fn(async () => ({
      kind: "message" as const,
      roomId: "room-1",
      sourceKind: "message" as const,
      sourceId: "message:message-1",
      sourceRevision: 1,
      corpusSeq: 1,
      content: "The launch is Friday.",
    }));
    const adapter = createMemoryStewardProviderAdapter({
      authority: { authorizeSource, isKnownRecord: vi.fn(async () => true) },
      provider: { id: "openai-memory-steward", generate },
      readiness: () => "ready",
    });
    const output = await adapter.process(batch([
      messageSource,
      {
        corpusSeq: 2,
        sourceKind: "message_tombstone",
        sourceId: "message-tombstone:message-2",
        sourceRevision: 1,
        eligibility: "excluded_recalled",
        availability: "tombstone",
      },
    ]), new AbortController().signal);

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]![0]).toMatchObject({
      fromWatermarkExclusive: 0,
      toCorpusSeqInclusive: 2,
      sources: [{ corpusSeq: 1, content: "The launch is Friday." }],
    });
    expect(output).toMatchObject({ candidateCount: 1, plan: { schemaVersion: 1 } });
    expect(output.outputSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("advances an invalidation-only batch with an empty plan and zero Provider calls", async () => {
    const generate = vi.fn<ClosedMemoryStewardProvider["generate"]>();
    const adapter = createMemoryStewardProviderAdapter({
      authority: {
        authorizeSource: vi.fn(),
        isKnownRecord: vi.fn(async () => false),
      },
      provider: { id: "openai-memory-steward", generate },
      readiness: () => "ready",
    });
    const output = await adapter.process(batch([{
      corpusSeq: 1,
      sourceKind: "message_tombstone",
      sourceId: "message-tombstone:message-1",
      sourceRevision: 1,
      eligibility: "excluded_recalled",
      availability: "tombstone",
    }]), new AbortController().signal);
    expect(generate).not.toHaveBeenCalled();
    expect(output.plan).toEqual({ schemaVersion: 1, candidates: [] });
  });

  it("reauthorizes attachment extraction before and after every bounded range", async () => {
    const bytes = new TextEncoder().encode("attachment text");
    const authorization = Object.freeze({
      kind: "attachment" as const,
      roomId: "room-1",
      sourceKind: "attachment_extraction" as const,
      sourceId: "attachment-extraction:attachment-1",
      sourceRevision: 1,
      corpusSeq: 1,
      objectKey: "extraction_deadbeef",
      sha256: "a".repeat(64),
      byteSize: bytes.byteLength,
    });
    const authorizeSource = vi.fn(async () => authorization);
    const readAuthorizedRange = vi.fn(async (_key: string, offset: number, maximum: number) => {
      const chunk = bytes.slice(offset, offset + maximum);
      return { bytes: chunk, byteSize: bytes.byteLength, eof: offset + chunk.byteLength === bytes.byteLength };
    });
    const generate = vi.fn<ClosedMemoryStewardProvider["generate"]>(async () => ({
      schemaVersion: 1,
      candidates: [],
    }));
    const adapter = createMemoryStewardProviderAdapter({
      authority: { authorizeSource, isKnownRecord: vi.fn(async () => false) },
      provider: { id: "openai-memory-steward", generate },
      readiness: () => "ready",
      objectStore: { readAuthorizedRange },
      chunkBytes: 4,
    });
    await adapter.process(batch([{
      corpusSeq: 1,
      sourceKind: "attachment_extraction",
      sourceId: "attachment-extraction:attachment-1",
      sourceRevision: 1,
      eligibility: "eligible",
      availability: "readable",
    }]), new AbortController().signal);
    expect(readAuthorizedRange).toHaveBeenCalledTimes(4);
    expect(authorizeSource).toHaveBeenCalledTimes(1 + 4 * 2);
    expect(generate.mock.calls[0]![0].sources[0]?.content).toBe("attachment text");
  });
});
