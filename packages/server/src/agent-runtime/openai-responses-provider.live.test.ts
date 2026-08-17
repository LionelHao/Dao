import { describe, expect, it } from "vitest";
import type { AgentRuntimeProviderInput } from "@native-im/core";
import { createEnvironmentSecretProvider } from "./environment-secret-provider.js";
import { createOpenAIResponsesProvider } from "./openai-responses-provider.js";

const enabled = process.env.DAO_OPENAI_LIVE_SMOKE === "1" &&
  typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0;

describe("opt-in OpenAI Responses live smoke", () => {
  it.skipIf(!enabled)("streams one store:false response without exposing credentials", async () => {
    const provider = createOpenAIResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: process.env.DAO_OPENAI_MODEL ?? "gpt-5-mini",
      secretProvider: createEnvironmentSecretProvider(),
    });
    const input: AgentRuntimeProviderInput = {
      purpose: "agent_runtime",
      invocation: {
        kind: "direct_mention",
        roomId: "live-smoke-room",
        sourceMessageId: "live-smoke-message",
        targetAgentId: "live-smoke-agent",
      },
      visibleConversation: [{
        messageId: "live-smoke-message",
        authorId: "live-smoke-human",
        body: "Reply with exactly: DAO live smoke ok",
      }],
      availableTools: [],
      committedSteps: [],
      limits: { maxInputBytes: 16 * 1_024, maxOutputBytes: 16 * 1_024, timeoutMs: 30_000 },
    };
    const events = [];
    for await (const event of provider.stream(input, AbortSignal.timeout(30_000))) {
      events.push(event);
    }
    expect(events.at(0)).toMatchObject({ type: "response_started" });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  }, 35_000);
});
