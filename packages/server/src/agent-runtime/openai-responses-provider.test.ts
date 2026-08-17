import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeProviderInput } from "@native-im/core";
import { AgentRuntimeError } from "./contracts.js";
import { createOpenAIResponsesProvider } from "./openai-responses-provider.js";

const input: AgentRuntimeProviderInput = {
  purpose: "agent_runtime",
  invocation: {
    kind: "direct_mention",
    roomId: "room-1",
    sourceMessageId: "message-1",
    targetAgentId: "agent-1",
  },
  visibleConversation: [{ messageId: "message-1", authorId: "human-1", body: "hello" }],
  availableTools: [],
  committedSteps: [],
  limits: { maxInputBytes: 8_192, maxOutputBytes: 8_192, timeoutMs: 5_000 },
};

function streamResponse(text: string): Response {
  const body = [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":${JSON.stringify(text)}}\n\n`,
    'event: response.completed\ndata: {"type":"response.completed"}\n\n',
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenAI Responses production adapter", () => {
  it("uses native fetch streaming with store:false and keeps the secret inside the adapter", async () => {
    const sentinel = "sk-sentinel-never-persist-4f4e8b1e";
    const fetch = vi.fn(async () => streamResponse("non-fixture"));
    const provider = createOpenAIResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "configured-model",
      secretProvider: { getSecret: () => sentinel },
      fetch,
    });

    const events = [];
    for await (const event of provider.stream(input, new AbortController().signal)) events.push(event);

    expect(events).toEqual([
      { type: "response_started", sequence: 1 },
      { type: "text_delta", sequence: 2, delta: "non-fixture" },
      { type: "completed", sequence: 3 },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${sentinel}` }));
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      model: "configured-model",
      stream: true,
      store: false,
    }));
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("starts no request without a server secret and never falls back to a fixture", async () => {
    const fetch = vi.fn();
    const provider = createOpenAIResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "configured-model",
      secretProvider: { getSecret: () => undefined },
      fetch,
    });
    const consume = async (): Promise<void> => {
      for await (const _event of provider.stream(input, new AbortController().signal)) void _event;
    };
    await expect(consume()).rejects.toMatchObject<Partial<AgentRuntimeError>>({
      code: "agent_configuration_missing",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps HTTP errors to closed codes without response bodies, headers, or secrets", async () => {
    const sentinel = "sk-sentinel-closed-error-51b";
    const provider = createOpenAIResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "configured-model",
      secretProvider: { getSecret: () => sentinel },
      fetch: async () => new Response(`upstream ${sentinel}`, {
        status: 429,
        headers: { "x-secret-debug": sentinel },
      }),
    });
    let thrown: unknown;
    try {
      for await (const _event of provider.stream(input, new AbortController().signal)) void _event;
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "provider_rate_limited" });
    expect(JSON.stringify(thrown)).not.toContain(sentinel);
    expect(String(thrown)).not.toContain(sentinel);
  });
});
