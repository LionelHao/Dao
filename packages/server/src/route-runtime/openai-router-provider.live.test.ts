import { describe, expect, it } from "vitest";
import type { RouterProviderInput } from "@native-im/core";
import { createEnvironmentSecretProvider } from "../agent-runtime/environment-secret-provider.js";
import { createOpenAIRouterProvider } from "./openai-router-provider.js";

const enabled = process.env.DAO_OPENAI_LIVE_SMOKE === "1" &&
  typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0;

describe("opt-in OpenAI Router live smoke", () => {
  it.skipIf(!enabled)("returns one real store:false closed route plan", async () => {
    const provider = createOpenAIRouterProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: process.env.DAO_OPENAI_MODEL ?? "gpt-5-mini",
      secretProvider: createEnvironmentSecretProvider(),
    });
    const input: RouterProviderInput = {
      purpose: "route_decision",
      roomId: "live-router-room",
      sourceMessageId: "live-router-message",
      message: {
        authorId: "live-router-human",
        authorKind: "human",
        summary: "Assess the irreversible data-loss risk in this database migration.",
      },
      roomPhase: "discussion",
      agents: [{
        agentId: "live-router-agent",
        participation: "active",
        role: "database reviewer",
        capabilities: ["database.review"],
        calibrationScore: 0,
        hasBall: false,
      }],
      topic: {
        topicKey: "topic-v1:live-router",
        embeddingModelVersion: "dao-topic-embedding-v1",
        windowSize: 8,
        cosineThreshold: 0.82,
      },
      limits: { timeoutMs: 1_000, maxCandidates: 1, maxOutputBytes: 64 * 1_024 },
    };

    const plan = await provider.decide(input, AbortSignal.timeout(30_000));

    expect(plan.candidates.length).toBeLessThanOrEqual(1);
    expect(plan.candidates.every((candidate) => candidate.agentId === "live-router-agent"))
      .toBe(true);
  }, 35_000);
});
