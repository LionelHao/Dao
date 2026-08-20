import { describe, expect, it } from "vitest";
import { createEnvironmentSecretProvider } from "../agent-runtime/environment-secret-provider.js";
import type { MemoryStewardProviderInput } from "./contracts.js";
import { createOpenAIMemoryStewardProvider } from "./openai-memory-provider.js";

const enabled = process.env.DAO_OPENAI_LIVE_SMOKE === "1" &&
  typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0;

describe("opt-in OpenAI Memory Steward live smoke", () => {
  it.skipIf(!enabled)("returns one real store:false closed memory plan", async () => {
    const provider = createOpenAIMemoryStewardProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: process.env.DAO_OPENAI_MODEL ?? "gpt-5-mini",
      secretProvider: createEnvironmentSecretProvider(),
    });
    const frozen: MemoryStewardProviderInput = {
      purpose: "room_memory_steward",
      roomId: "live-memory-room",
      generation: 1,
      fromWatermarkExclusive: 0,
      toCorpusSeqInclusive: 1,
      sources: [{
        roomId: "live-memory-room",
        sourceId: "message:live-memory-message",
        sourceRevision: 1,
        sourceKind: "message",
        corpusSeq: 1,
        eligibility: "eligible",
        content: "The team decided to launch the migration on Friday.",
      }],
    };
    const result = await provider.generate(frozen, {
      isCurrentEligibleSource: async () => true,
      isKnownMemoryRecord: async () => false,
    }, AbortSignal.timeout(70_000));

    expect(result.schemaVersion).toBe(1);
    expect(result.candidates.length).toBeLessThanOrEqual(32);
    expect(result.candidates.every((candidate) => candidate.sourceRefs.every(
      (ref) => ref.sourceId === "message:live-memory-message" && ref.sourceRevision === 1,
    ))).toBe(true);
  }, 75_000);
});
