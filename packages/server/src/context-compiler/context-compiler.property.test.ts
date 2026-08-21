import { describe, expect, it } from "vitest";
import type { ContextCompilerInputV1, ContextSourceCandidateV1 } from "@native-im/core";
import { CONTEXT_COMPILER_CONFIG_V1, compileContextV1 } from "./context-compiler.js";

const PROPERTY_SEEDS = [0x43545806, 0x4d454d07, 0xdecafbad] as const;
const RUNS_PER_SEED = 256;
const LARGE_DELTA_RUNS_PER_SEED = 32;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function shuffle<T>(values: readonly T[], next: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function makeInput(seed: number): ContextCompilerInputV1 {
  const occurredAt = "2026-08-21T00:00:00.000Z";
  const candidates: ContextSourceCandidateV1[] = Array.from({ length: 12 }, (_, index) => ({
    source: { roomId: "room-property", sourceKind: "message", sourceId: `message-${index.toString().padStart(2, "0")}`, revision: 1, corpusSeq: index + 2 },
    body: `${index % 2 === 0 ? "🙂" : "e\u0301"}-${"x".repeat((seed + index) % 300)}`,
    availability: "readable",
    author: { actorId: `human-${index % 3}`, kind: "human", displayName: `Human ${index % 3}` },
    occurredAt,
    replyTo: null,
    mentions: [],
    readRef: `read-${index}`,
  }));
  return {
    version: "context_compiler_input_v1",
    invocation: { invocationId: "invocation-property", executionId: "execution-property", roomId: "room-property",
      intent: { kind: "routed_candidate", sourceMessageId: "message-11", targetAgentId: "agent-property", reasonCode: "domain_match", reasonText: "property route" } },
    agent: { agentId: "agent-property", displayName: "Property Agent", responsibility: { availability: "unavailable", reason: "ft07_not_delivered" } },
    room: { roomId: "room-property", name: "Property", goal: { availability: "unavailable", reason: "ft09_not_delivered" } },
    trigger: {
      triggerType: "message",
      reason: "mention",
      source: { roomId: "room-property", sourceKind: "message", sourceId: "message-11", revision: 1, corpusSeq: 13 },
      body: candidates[11]!.body!,
      author: candidates[11]!.author!,
      occurredAt,
      replyTo: null,
      mentions: [],
      readRef: candidates[11]!.readRef,
    },
    memoryWatermark: 1,
    corpusHead: 13,
    memories: [],
    delta: candidates,
    retrieval: [],
    attachments: [],
    project: { availability: "unavailable", reason: "adapter_unavailable" },
    tools: [],
    trusted: { system: "system", developerPolicy: "developer" },
  };
}

describe("compileContextV1 deterministic properties", () => {
  it(`is permutation-stable for seeds ${PROPERTY_SEEDS.join(",")} with ${RUNS_PER_SEED} runs each`, () => {
    for (const seed of PROPERTY_SEEDS) {
      const input = makeInput(seed);
      const memory = { kind: "context" as const, memoryRecordId: "memory-property", memoryVersionId: "memory-version-property",
        version: 1, body: "stable memory", sourceRefs: [{ roomId: "room-property", sourceKind: "message" as const,
          sourceId: "message-00", revision: 1, corpusSeq: 1 }], availability: "readable" as const };
      const attachment = { ...input.delta[0]!, source: { ...input.delta[0]!.source,
        sourceKind: "attachment_extraction" as const, sourceId: "attachment-property", corpusSeq: 1 }, readRef: "attachment-read" };
      const tool = { id: "property-tool", description: "read authority", effect: "read-only" as const, inputSchemaCanonical: "{}" };
      input.memories = [memory, { ...memory, sourceRefs: [...memory.sourceRefs].reverse() }];
      input.retrieval = [input.delta[0]!, { ...input.delta[0]! }];
      input.attachments = [attachment, { ...attachment }];
      input.tools = [tool, { ...tool }];
      const baseline = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
      expect(baseline.ok).toBe(true);
      for (let run = 0; run < RUNS_PER_SEED; run += 1) {
        const next = random(seed ^ run);
        const permuted = { ...input, delta: shuffle(input.delta, next), memories: shuffle(input.memories, next),
          retrieval: shuffle(input.retrieval, next), attachments: shuffle(input.attachments, next), tools: shuffle(input.tools, next) };
        const result = compileContextV1(permuted, CONTEXT_COMPILER_CONFIG_V1);
        expect(result).toEqual(baseline);
        if (result.ok) {
          expect(result.envelope.accounting.totalTokens).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.hardLimitTokens);
          expect(result.envelope.accounting.envelopeBytes).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.envelopeBytes);
          expect(result.envelope.accounting.inputTokens).toBe(Buffer.byteLength(result.canonicalEnvelope, "utf8"));
          expect(result.envelope.accounting.totalTokens).toBe(
            result.envelope.accounting.inputTokens
              + result.envelope.accounting.outputReserveTokens
              + result.envelope.accounting.toolSchemaReserveTokens,
          );
          expect(Object.values(result.envelope.accounting.sectionTokens).reduce((sum, tokens) => sum + tokens, 0))
            .toBe(result.envelope.accounting.inputTokens);
        }
      }
    }
  }, 30_000);

  it(`keeps large-delta range aggregation stable for ${LARGE_DELTA_RUNS_PER_SEED} runs per seed`, () => {
    for (const seed of PROPERTY_SEEDS) {
      const input = makeInput(seed);
      input.memoryWatermark = 0;
      input.corpusHead = 64;
      input.trigger.source = { roomId: "room-property", sourceKind: "message", sourceId: "large-64", revision: 1, corpusSeq: 64 };
      input.invocation.intent = { ...input.invocation.intent, sourceMessageId: "large-64" };
      input.delta = Array.from({ length: 64 }, (_, index) => ({
        source: { roomId: "room-property", sourceKind: "message", sourceId: `large-${index + 1}`, revision: 1, corpusSeq: index + 1 },
        body: `${seed}:${index}:${"🙂".repeat((index % 7) + 1)}${"x".repeat(256)}`,
        availability: "readable" as const,
        author: { actorId: "human-property", kind: "human" as const, displayName: "Property Human" },
        occurredAt: "2026-08-21T00:00:00.000Z",
        replyTo: null,
        mentions: [],
        readRef: `large-read-${index + 1}`,
      }));
      input.trigger.body = input.delta[63]!.body!;
      input.trigger.author = input.delta[63]!.author!;
      input.trigger.readRef = input.delta[63]!.readRef;
      const baseline = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
      expect(baseline.ok).toBe(true);
      if (!baseline.ok) continue;
      expect(baseline.manifest.items.filter((item) => item.source === null)).toHaveLength(1);
      for (let run = 0; run < LARGE_DELTA_RUNS_PER_SEED; run += 1) {
        const result = compileContextV1({ ...input, delta: shuffle(input.delta, random(seed ^ 0x9e3779b9 ^ run)) }, CONTEXT_COMPILER_CONFIG_V1);
        expect(result).toEqual(baseline);
        if (result.ok) {
          expect(result.envelope.accounting.sectionTokens.manifest).toBe(Buffer.byteLength(result.canonicalManifest, "utf8"));
          expect(result.envelope.accounting.inputTokens).toBe(Buffer.byteLength(result.canonicalEnvelope, "utf8"));
          expect(result.envelope.accounting.totalTokens).toBe(
            result.envelope.accounting.inputTokens
              + result.envelope.accounting.outputReserveTokens
              + result.envelope.accounting.toolSchemaReserveTokens,
          );
          expect(Object.values(result.envelope.accounting.sectionTokens).reduce((sum, tokens) => sum + tokens, 0))
            .toBe(result.envelope.accounting.inputTokens);
          expect(Buffer.byteLength(result.canonicalManifest, "utf8")).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.manifestBytes);
        }
      }
    }
  }, 30_000);
});
