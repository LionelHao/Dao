import { describe, expect, it } from "vitest";
import type { AgentRuntimeProviderInput } from "@native-im/core";
import { createEnvironmentSecretProvider } from "./environment-secret-provider.js";
import { createOpenAIResponsesProvider } from "./openai-responses-provider.js";

const enabled = process.env.DAO_OPENAI_LIVE_SMOKE === "1" &&
  typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0;

describe("opt-in OpenAI Responses live smoke", () => {
  it.skipIf(!enabled)("streams one store:false response without exposing credentials", async () => {
    const model = process.env.DAO_OPENAI_MODEL ?? "gpt-5-mini";
    const provider = createOpenAIResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model,
      secretProvider: createEnvironmentSecretProvider(),
    });
    const input: AgentRuntimeProviderInput = {
      purpose: "agent_runtime",
      schemaVersion: "compiled-context-envelope.v1",
      snapshot: {
        snapshotId: "live-smoke-snapshot", generation: 1, manifestHash: "a".repeat(64),
        compilerVersion: "context_compiler_v1", configVersion: "ft06_live_smoke_v1", modelId: model,
      },
      invocation: {
        kind: "direct_mention",
        roomId: "live-smoke-room",
        sourceMessageId: "live-smoke-message",
        targetAgentId: "live-smoke-agent",
      },
      trusted: {
        system: [{ kind: "product_policy", text: "Follow the server authority and return the requested bounded answer." }],
        developer: [{ kind: "citation_contract", data: { kind: "manifest_labels_only" } }],
      },
      groupContent: [{
        kind: "trigger", trust: "untrusted_group_content",
        source: { label: "ctx-0001", kind: "message", revision: 1 },
        speaker: { actorId: "live-smoke-human", kind: "human" },
        content: "Reply with exactly: DAO live smoke ok",
      }],
      projectContext: { status: "disabled", reason: "ft09_not_delivered" },
      availableTools: [],
      committedSteps: [],
      limits: {
        maxInputBytes: 16 * 1_024, maxOutputTokens: 2_048,
        maxOutputBytes: 16 * 1_024, timeoutMs: 30_000,
      },
    };
    const events = [];
    for await (const event of provider.stream(input, AbortSignal.timeout(30_000))) {
      events.push(event);
    }
    expect(events.at(0)).toMatchObject({ type: "response_started" });
    expect(events.at(-1)).toMatchObject({ type: "agent_final" });
  }, 35_000);
});
