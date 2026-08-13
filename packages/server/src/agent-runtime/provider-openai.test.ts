import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  OpenAiResponsesProviderError,
  createEnvironmentSecretProvider,
  createOpenAiResponsesProvider,
} from "./provider-openai.js";
import type {
  AgentRuntimeProviderInput,
  ProviderEvent,
} from "./contracts.js";

const SENTINEL = "sk-native-im-provider-sentinel-7Qf3wK9z";
const GIT_STATUS_PROVIDER_NAME = `tool_${createHash("sha256")
  .update("repository.git-status", "utf8")
  .digest("base64url")}`;

const input: AgentRuntimeProviderInput = {
  purpose: "agent_runtime",
  invocation: {
    sourceMessageId: "message-1",
    requesterActorId: "human-1",
    targetAgentId: "agent-1",
    intentKind: "direct_mention",
  },
  visibleConversation: [
    {
      messageId: "message-1",
      actorId: "human-1",
      body: "Please inspect the repository.",
    },
  ],
  availableTools: [
    {
      id: "repository.git-status",
      description: "Read repository status",
      confirmationRequirement: "read_only",
      parametersSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
  committedSteps: [],
  limits: {
    maxInputBytes: 65_536,
    maxOutputBytes: 65_536,
    maxToolCalls: 8,
  },
};

function sse(...events: readonly unknown[]): string {
  return events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function chunkedResponse(
  body: string,
  chunkSizes: readonly number[] = [1, 2, 5, 3, 8],
): Response {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  let chunkIndex = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const size = chunkSizes[chunkIndex % chunkSizes.length] ?? 1;
        chunkIndex += 1;
        const end = Math.min(offset + size, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function providerWith(
  response: Response,
  inspectRequest?: (input: RequestInfo | URL, init?: RequestInit) => void,
  options?: { readonly maxEventBytes?: number; readonly maxStreamBytes?: number },
) {
  const fetchImpl: typeof fetch = async (request, init) => {
    inspectRequest?.(request, init);
    return response;
  };
  return createOpenAiResponsesProvider({
    endpoint: "https://api.openai.com/v1/responses",
    model: "gpt-5-mini",
    secretEnvironmentKey: "OPENAI_API_KEY",
    secretProvider: createEnvironmentSecretProvider({ OPENAI_API_KEY: SENTINEL }),
    fetchImpl,
    ...options,
  });
}

describe("OpenAI Responses provider", () => {
  it("parses chunk-split text, tool, usage and completion events exactly once", async () => {
    let requestBody = "";
    let authorization = "";
    const provider = providerWith(
      chunkedResponse(
        sse(
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "response-1" },
          },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: {
              type: "message",
              id: "message-output-1",
              content: [{ type: "output_text", text: "hello world" }],
            },
          },
          {
            type: "response.content_part.added",
            sequence_number: 2,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            part: { type: "output_text", text: "" },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 3,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            delta: "hello ",
          },
          {
            type: "response.output_text.delta",
            sequence_number: 4,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            delta: "world",
          },
          {
            type: "response.output_text.done",
            sequence_number: 5,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            text: "hello world",
          },
          {
            type: "response.content_part.done",
            sequence_number: 6,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            part: { type: "output_text", text: "hello world" },
          },
          {
            type: "response.output_item.done",
            sequence_number: 7,
            output_index: 0,
            item: {
              type: "message",
              id: "message-output-1",
              content: [{ type: "output_text", text: "hello world" }],
            },
          },
          {
            type: "response.output_item.added",
            sequence_number: 8,
            output_index: 1,
            item: {
              type: "function_call",
              id: "item-1",
              call_id: "call-1",
              name: GIT_STATUS_PROVIDER_NAME,
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 9,
            output_index: 1,
            item_id: "item-1",
            delta: "{\"path\":",
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 10,
            output_index: 1,
            item_id: "item-1",
            delta: "\".\"}",
          },
          {
            type: "response.function_call_arguments.done",
            sequence_number: 11,
            output_index: 1,
            item_id: "item-1",
            name: GIT_STATUS_PROVIDER_NAME,
            arguments: "{\"path\":\".\"}",
          },
          {
            type: "response.output_item.done",
            sequence_number: 12,
            output_index: 1,
            item: {
              type: "function_call",
              id: "item-1",
              call_id: "call-1",
              name: GIT_STATUS_PROVIDER_NAME,
              arguments: "{\"path\":\".\"}",
            },
          },
          {
            type: "response.completed",
            sequence_number: 13,
            response: {
              id: "response-1",
              usage: { input_tokens: 12, output_tokens: 7 },
              output: [
                {
                  id: "message-output-1",
                  type: "message",
                  content: [{ type: "output_text", text: "hello world" }],
                },
                {
                  id: "item-1",
                  type: "function_call",
                  call_id: "call-1",
                  name: GIT_STATUS_PROVIDER_NAME,
                  arguments: "{\"path\":\".\"}",
                },
              ],
            },
          },
        ),
      ),
      (_request, init) => {
        requestBody = String(init?.body ?? "");
        authorization = new Headers(init?.headers).get("authorization") ?? "";
      },
    );

    await expect(collect(provider.stream(input, new AbortController().signal))).resolves.toEqual([
      { type: "response_started" },
      { type: "text_delta", delta: "hello " },
      { type: "text_delta", delta: "world" },
      {
        type: "tool_call_delta",
        callId: "call-1",
        toolId: "repository.git-status",
        argumentsDelta: "{\"path\":",
      },
      {
        type: "tool_call_delta",
        callId: "call-1",
        toolId: "repository.git-status",
        argumentsDelta: "\".\"}",
      },
      { type: "usage", inputTokens: 12, outputTokens: 7 },
      { type: "completed", finishReason: "tool_calls" },
    ]);

    expect(authorization).toBe(`Bearer ${SENTINEL}`);
    expect(requestBody).not.toContain(SENTINEL);
    expect(JSON.parse(requestBody)).toMatchObject({
      model: "gpt-5-mini",
      stream: true,
      store: false,
    });
    const parsedRequest = JSON.parse(requestBody) as {
      readonly tools: readonly { readonly name: string }[];
    };
    expect(parsedRequest.tools).toHaveLength(1);
    expect(parsedRequest.tools[0]?.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(parsedRequest.tools[0]?.name).not.toContain(".");
  });

  it("maps provider-safe function names back to canonical dotted tool IDs", async () => {
    let providerToolName = "";
    const dynamicFetch: typeof fetch = async (request, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        readonly tools: readonly { readonly name: string }[];
      };
      providerToolName = body.tools[0]?.name ?? "";
      return chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: {
              type: "function_call",
              id: "item-1",
              call_id: "call-1",
              name: providerToolName,
              arguments: "{}",
            },
          },
          {
            type: "response.function_call_arguments.done",
            sequence_number: 3,
            output_index: 0,
            item_id: "item-1",
            name: providerToolName,
            arguments: "{}",
          },
          {
            type: "response.output_item.done",
            sequence_number: 4,
            output_index: 0,
            item: {
              type: "function_call",
              id: "item-1",
              call_id: "call-1",
              name: providerToolName,
              arguments: "{}",
            },
          },
          {
            type: "response.completed",
            sequence_number: 5,
            response: {
              id: "response-1",
              usage: { input_tokens: 1, output_tokens: 1 },
              output: [
                {
                  type: "function_call",
                  id: "item-1",
                  call_id: "call-1",
                  name: providerToolName,
                  arguments: "{}",
                },
              ],
            },
          },
        ),
      );
    };
    const mappedProvider = createOpenAiResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "gpt-5-mini",
      secretEnvironmentKey: "OPENAI_API_KEY",
      secretProvider: createEnvironmentSecretProvider({ OPENAI_API_KEY: SENTINEL }),
      fetchImpl: dynamicFetch,
    });

    const events = await collect(mappedProvider.stream(input, new AbortController().signal));
    expect(providerToolName).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(events).toContainEqual({
      type: "tool_call_delta",
      callId: "call-1",
      toolId: "repository.git-status",
      argumentsDelta: "{}",
    });
  });

  it("ignores only closed forward-compatible metadata events", async () => {
    const provider = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          { type: "response.in_progress", sequence_number: 2, response: {} },
          {
            type: "response.completed",
            sequence_number: 3,
            response: {
              id: "response-1",
              usage: { input_tokens: 1, output_tokens: 1 },
              output: [],
            },
          },
        ),
      ),
    );

    await expect(collect(provider.stream(input, new AbortController().signal))).resolves.toEqual([
      { type: "response_started" },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it.each([
    ["text before start", sse({ type: "response.output_text.delta", sequence_number: 1, delta: "x" })],
    [
      "duplicate start",
      sse(
        { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
        { type: "response.created", sequence_number: 2, response: { id: "response-1" } },
      ),
    ],
    [
      "duplicate completion",
      sse(
        { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
        {
          type: "response.completed",
          sequence_number: 2,
          response: { id: "response-1", usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
        },
        {
          type: "response.completed",
          sequence_number: 3,
          response: { id: "response-1", usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
        },
      ),
    ],
    [
      "non-monotonic sequence",
      sse(
        { type: "response.created", sequence_number: 2, response: { id: "response-1" } },
        { type: "response.output_text.delta", sequence_number: 1, delta: "x" },
      ),
    ],
    [
      "unknown event",
      sse(
        { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
        { type: "response.future.magic", sequence_number: 2 },
      ),
    ],
    [
      "unknown tool item",
      sse(
        { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
        {
          type: "response.function_call_arguments.delta",
          sequence_number: 2,
          item_id: "missing",
          delta: "{}",
        },
      ),
    ],
    [
      "unknown output item kind",
      sse(
        { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
        {
          type: "response.output_item.added",
          sequence_number: 2,
          item: { id: "unknown-1", type: "future_unknown_item" },
        },
        {
          type: "response.completed",
          sequence_number: 3,
          response: { id: "response-1", usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
        },
      ),
    ],
  ])("fails closed for %s", async (_name, body) => {
    const provider = providerWith(chunkedResponse(body));
    await expect(collect(provider.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_invalid_response",
      status: 503,
    });
  });

  it("rejects malformed JSON, truncated streams and non-SSE content", async () => {
    const malformed = providerWith(chunkedResponse("data: {not-json}\n\n"));
    await expect(collect(malformed.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_invalid_response",
    });

    const truncated = providerWith(
      chunkedResponse(sse({ type: "response.created", sequence_number: 1, response: { id: "response-1" } })),
    );
    await expect(collect(truncated.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_invalid_response",
    });

    const nonSse = providerWith(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(collect(nonSse.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_invalid_response",
    });
  });

  it("parses CRLF event boundaries even when the CR and LF arrive in different chunks", async () => {
    const body = sse(
      { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
      {
        type: "response.completed",
        sequence_number: 2,
        response: { id: "response-1", usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
      },
    ).replaceAll("\n", "\r\n");
    const provider = providerWith(chunkedResponse(body, [1]));

    await expect(collect(provider.stream(input, new AbortController().signal))).resolves.toEqual([
      { type: "response_started" },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("requires semantic done events to match accumulated text and tool arguments", async () => {
    const textConflict = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: {
              type: "message",
              id: "message-output-1",
              content: [{ type: "refusal", refusal: "cannot comply" }],
            },
          },
          {
            type: "response.content_part.added",
            sequence_number: 3,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            part: { type: "output_text", text: "" },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 4,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            delta: "actual",
          },
          {
            type: "response.output_text.done",
            sequence_number: 5,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            text: "conflict",
          },
        ),
      ),
    );
    await expect(collect(textConflict.stream(input, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_invalid_response" });

    const toolConflict = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: {
              type: "function_call",
              id: "tool-output-1",
              call_id: "call-1",
              name: GIT_STATUS_PROVIDER_NAME,
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 3,
            output_index: 0,
            item_id: "tool-output-1",
            delta: "{}",
          },
          {
            type: "response.function_call_arguments.done",
            sequence_number: 4,
            output_index: 0,
            item_id: "tool-output-1",
            name: GIT_STATUS_PROVIDER_NAME,
            arguments: "{\"conflict\":true}",
          },
        ),
      ),
    );
    await expect(collect(toolConflict.stream(input, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("emits and counts non-empty initial content and arguments", async () => {
    const initialText = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: {
              type: "message",
              id: "message-output-1",
              content: [{ type: "refusal", refusal: "cannot comply" }],
            },
          },
          {
            type: "response.content_part.added",
            sequence_number: 3,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            part: { type: "output_text", text: "initial" },
          },
          {
            type: "response.output_text.done",
            sequence_number: 4,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            text: "initial",
          },
          {
            type: "response.content_part.done",
            sequence_number: 5,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            part: { type: "output_text", text: "initial" },
          },
          {
            type: "response.output_item.done",
            sequence_number: 6,
            output_index: 0,
            item: {
              type: "message",
              id: "message-output-1",
              content: [{ type: "output_text", text: "initial" }],
            },
          },
          {
            type: "response.completed",
            sequence_number: 7,
            response: {
              id: "response-1",
              usage: { input_tokens: 1, output_tokens: 1 },
              output: [
                {
                  type: "message",
                  id: "message-output-1",
                  content: [{ type: "output_text", text: "initial" }],
                },
              ],
            },
          },
        ),
      ),
    );
    const events = await collect(initialText.stream(input, new AbortController().signal));
    expect(events).toContainEqual({ type: "text_delta", delta: "initial" });

    const tooSmall: AgentRuntimeProviderInput = {
      ...input,
      limits: { ...input.limits, maxOutputBytes: 6 },
    };
    const initialTool = createOpenAiResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "gpt-5-mini",
      secretEnvironmentKey: "OPENAI_API_KEY",
      secretProvider: createEnvironmentSecretProvider({ OPENAI_API_KEY: SENTINEL }),
      fetchImpl: async (_request, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          readonly tools: readonly { readonly name: string }[];
        };
        const name = body.tools[0]?.name ?? "";
        return chunkedResponse(
          sse(
            { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
            {
              type: "response.output_item.added",
              sequence_number: 2,
              output_index: 0,
              item: {
                type: "function_call",
                id: "item-1",
                call_id: "call-1",
                name,
                arguments: "{\"a\":1}",
              },
            },
          ),
        );
      },
    });
    await expect(collect(initialTool.stream(tooSmall, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_response_too_large" });
  });

  it("rejects contradictory message content at output item done and completed", async () => {
    const provider = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: { type: "message", id: "message-output-1" },
          },
          {
            type: "response.content_part.added",
            sequence_number: 3,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            part: { type: "output_text", text: "safe" },
          },
          {
            type: "response.output_text.done",
            sequence_number: 4,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            text: "safe",
          },
          {
            type: "response.content_part.done",
            sequence_number: 5,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            part: { type: "output_text", text: "safe" },
          },
          {
            type: "response.output_item.done",
            sequence_number: 6,
            output_index: 0,
            item: {
              type: "message",
              id: "message-output-1",
              content: [{ type: "output_text", text: "evil" }],
            },
          },
        ),
      ),
    );
    await expect(collect(provider.stream(input, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it.each([
    [
      "response identity mismatch",
      sse(
        { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
        {
          type: "response.completed",
          sequence_number: 2,
          response: {
            id: "response-2",
            usage: { input_tokens: 1, output_tokens: 1 },
            output: [],
          },
        },
      ),
    ],
    [
      "nonzero first output index",
      sse(
        { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
        {
          type: "response.output_item.added",
          sequence_number: 2,
          output_index: 5,
          item: { type: "message", id: "message-output-1" },
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 5,
          item: { type: "message", id: "message-output-1", content: [] },
        },
        {
          type: "response.completed",
          sequence_number: 4,
          response: {
            id: "response-1",
            usage: { input_tokens: 1, output_tokens: 1 },
            output: [{ type: "message", id: "message-output-1", content: [] }],
          },
        },
      ),
    ],
    [
      "swapped final output order",
      sse(
        { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
        {
          type: "response.output_item.added",
          sequence_number: 2,
          output_index: 0,
          item: { type: "message", id: "message-output-1" },
        },
        {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 0,
          item: { type: "message", id: "message-output-1", content: [] },
        },
        {
          type: "response.output_item.added",
          sequence_number: 4,
          output_index: 1,
          item: { type: "message", id: "message-output-2" },
        },
        {
          type: "response.output_item.done",
          sequence_number: 5,
          output_index: 1,
          item: { type: "message", id: "message-output-2", content: [] },
        },
        {
          type: "response.completed",
          sequence_number: 6,
          response: {
            id: "response-1",
            usage: { input_tokens: 1, output_tokens: 1 },
            output: [
              { type: "message", id: "message-output-2", content: [] },
              { type: "message", id: "message-output-1", content: [] },
            ],
          },
        },
      ),
    ],
  ])("rejects %s", async (_name, body) => {
    const provider = providerWith(chunkedResponse(body));
    await expect(collect(provider.stream(input, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("maps a refusal stream to bounded text while validating refusal.done", async () => {
    const provider = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: { type: "message", id: "message-output-1" },
          },
          {
            type: "response.content_part.added",
            sequence_number: 3,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            part: { type: "refusal", refusal: "" },
          },
          {
            type: "response.refusal.delta",
            sequence_number: 4,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            delta: "cannot comply",
          },
          {
            type: "response.refusal.done",
            sequence_number: 5,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            refusal: "cannot comply",
          },
          {
            type: "response.content_part.done",
            sequence_number: 6,
            output_index: 0,
            item_id: "message-output-1",
            content_index: 0,
            part: { type: "refusal", refusal: "cannot comply" },
          },
          {
            type: "response.output_item.done",
            sequence_number: 7,
            output_index: 0,
            item: {
              type: "message",
              id: "message-output-1",
              content: [{ type: "refusal", refusal: "cannot comply" }],
            },
          },
          {
            type: "response.completed",
            sequence_number: 8,
            response: {
              id: "response-1",
              usage: { input_tokens: 1, output_tokens: 2 },
              output: [
                {
                  type: "message",
                  id: "message-output-1",
                  content: [{ type: "refusal", refusal: "cannot comply" }],
                },
              ],
            },
          },
        ),
      ),
    );
    await expect(collect(provider.stream(input, new AbortController().signal))).resolves.toContainEqual({
      type: "text_delta",
      delta: "cannot comply",
    });
  });

  it.each([
    [401, "provider_unauthorized", 503],
    [400, "provider_invalid_request", 409],
    [404, "provider_invalid_request", 409],
    [413, "provider_input_too_large", 409],
    [422, "provider_invalid_request", 409],
    [429, "rate_limited", 429],
    [500, "upstream_unavailable", 503],
  ] as const)("maps HTTP %i to a sanitized closed error", async (status, code, expectedStatus) => {
    const provider = providerWith(
      new Response(`provider body ${SENTINEL}`, {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

    let thrown: unknown;
    try {
      await collect(provider.stream(input, new AbortController().signal));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OpenAiResponsesProviderError);
    expect(thrown).toMatchObject({ code, status: expectedStatus });
    expect(String(thrown)).not.toContain(SENTINEL);
    expect(JSON.stringify(thrown)).not.toContain(SENTINEL);
  });

  it("enforces per-event and total stream byte limits", async () => {
    const eventLimited = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          { type: "response.output_text.delta", sequence_number: 2, delta: "0123456789" },
        ),
      ),
      undefined,
      { maxEventBytes: 60, maxStreamBytes: 10_000 },
    );
    await expect(collect(eventLimited.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_response_too_large",
    });

    const streamLimited = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          { type: "response.output_text.delta", sequence_number: 2, delta: "x" },
        ),
      ),
      undefined,
      { maxEventBytes: 1_000, maxStreamBytes: 100 },
    );
    await expect(collect(streamLimited.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_response_too_large",
    });
  });

  it("rejects an undelimited event at the event limit instead of the stream limit", async () => {
    const provider = providerWith(
      chunkedResponse(`data: ${"x".repeat(80)}`, [8]),
      undefined,
      { maxEventBytes: 64, maxStreamBytes: 1_000 },
    );
    await expect(collect(provider.stream(input, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_response_too_large" });
  });

  it("counts the complete request including tools before calling fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = createOpenAiResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "gpt-5-mini",
      secretEnvironmentKey: "OPENAI_API_KEY",
      secretProvider: createEnvironmentSecretProvider({ OPENAI_API_KEY: SENTINEL }),
      fetchImpl,
    });
    const oversized: AgentRuntimeProviderInput = {
      ...input,
      availableTools: [
        {
          ...input.availableTools[0]!,
          description: "x".repeat(10_000),
        },
      ],
      limits: { ...input.limits, maxInputBytes: 1_000 },
    };

    await expect(collect(provider.stream(oversized, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_input_too_large", status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces the execution logical output and tool-call budgets", async () => {
    const outputLimited = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: {
              type: "function_call",
              id: "item-1",
              call_id: "call-1",
              name: GIT_STATUS_PROVIDER_NAME,
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 3,
            output_index: 0,
            item_id: "item-1",
            delta: "1234",
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 4,
            output_index: 0,
            item_id: "item-1",
            delta: "5678",
          },
        ),
      ),
    );
    const smallOutput: AgentRuntimeProviderInput = {
      ...input,
      limits: { ...input.limits, maxOutputBytes: 7 },
    };
    await expect(collect(outputLimited.stream(smallOutput, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_response_too_large" });

    const toolLimited = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: {
              type: "function_call",
              id: "item-1",
              call_id: "call-1",
              name: GIT_STATUS_PROVIDER_NAME,
              arguments: "",
            },
          },
          {
            type: "response.output_item.added",
            sequence_number: 3,
            output_index: 1,
            item: {
              type: "function_call",
              id: "item-2",
              call_id: "call-2",
              name: GIT_STATUS_PROVIDER_NAME,
              arguments: "",
            },
          },
          {
            type: "response.completed",
            sequence_number: 4,
            response: {
              id: "response-1",
              usage: { input_tokens: 1, output_tokens: 1 },
              output: [{ type: "function_call" }],
            },
          },
        ),
      ),
    );
    const oneTool: AgentRuntimeProviderInput = {
      ...input,
      limits: { ...input.limits, maxToolCalls: 1 },
    };
    await expect(collect(toolLimited.stream(oneTool, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_response_too_large" });
  });

  it.each([
    ["unavailable tool", "item-1", "call-1", "tool_unavailable"],
    ["duplicate call id", "item-2", "call-1", GIT_STATUS_PROVIDER_NAME],
  ])("rejects an %s before yielding its arguments", async (name, itemId, callId, toolId) => {
    const prefix =
      name === "duplicate call id"
        ? [
            {
              type: "response.output_item.added",
              sequence_number: 2,
              output_index: 0,
              item: {
                type: "function_call",
                id: "item-1",
                call_id: "call-1",
                name: GIT_STATUS_PROVIDER_NAME,
                arguments: "",
              },
            },
          ]
        : [];
    const provider = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          ...prefix,
          {
            type: "response.output_item.added",
            sequence_number: prefix.length + 2,
            output_index: prefix.length,
            item: {
              type: "function_call",
              id: itemId,
              call_id: callId,
              name: toolId,
              arguments: "",
            },
          },
          {
            type: "response.completed",
            sequence_number: prefix.length + 3,
            response: {
              id: "response-1",
              usage: { input_tokens: 1, output_tokens: 1 },
              output: [{ type: "function_call" }],
            },
          },
        ),
      ),
    );

    await expect(collect(provider.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_invalid_response",
    });
  });

  it("propagates AbortSignal and returns a closed cancelled error", async () => {
    const entered = Promise.withResolvers<void>();
    const fetchImpl: typeof fetch = async (_request, init) => {
      entered.resolve();
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    };
    const provider = createOpenAiResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "gpt-5-mini",
      secretEnvironmentKey: "OPENAI_API_KEY",
      secretProvider: createEnvironmentSecretProvider({ OPENAI_API_KEY: SENTINEL }),
      fetchImpl,
    });
    const controller = new AbortController();
    const pending = collect(provider.stream(input, controller.signal));
    await entered.promise;
    controller.abort(new Error(`private ${SENTINEL}`));

    await expect(pending).rejects.toMatchObject({ code: "provider_cancelled", status: 409 });
    await expect(pending).rejects.not.toThrow(SENTINEL);
  });

  it("does not yield already-buffered events after cancellation", async () => {
    const provider = providerWith(
      chunkedResponse(
        sse(
          { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
          { type: "response.output_text.delta", sequence_number: 2, delta: "must-not-yield" },
        ),
        [1_000_000],
      ),
    );
    const controller = new AbortController();
    const iterator = provider.stream(input, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "response_started" },
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "provider_cancelled" });
  });

  it("cancels response bodies for HTTP and content-type refusal paths", async () => {
    const httpCancelled = vi.fn();
    const httpBody = new ReadableStream<Uint8Array>({ cancel: httpCancelled });
    const httpProvider = providerWith(new Response(httpBody, { status: 400 }));
    await expect(collect(httpProvider.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_invalid_request",
    });
    expect(httpCancelled).toHaveBeenCalledTimes(1);

    const typeCancelled = vi.fn();
    const typeBody = new ReadableStream<Uint8Array>({ cancel: typeCancelled });
    const typeProvider = providerWith(
      new Response(typeBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(collect(typeProvider.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_invalid_response",
    });
    expect(typeCancelled).toHaveBeenCalledTimes(1);
  });

  it("maps official stream error events to terminal sanitized provider_failure", async () => {
    for (const body of [
      sse({ type: "error", sequence_number: 1, code: "bad_request", message: SENTINEL }),
      sse(
        { type: "response.created", sequence_number: 1, response: { id: "response-1" } },
        { type: "response.failed", sequence_number: 2, response: { error: SENTINEL } },
      ),
    ]) {
      const provider = providerWith(chunkedResponse(body));
      let thrown: unknown;
      try {
        await collect(provider.stream(input, new AbortController().signal));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "provider_failure", status: 409 });
      expect(String(thrown)).not.toContain(SENTINEL);
    }
  });

  it("maps deeply nested JSON to a closed invalid-response error", async () => {
    const nested = `${"[".repeat(12_000)}null${"]".repeat(12_000)}`;
    const body = [
      `data: {"type":"response.created","sequence_number":1,"response":{"id":"response-1"}}\n\n`,
      `data: {"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"type":"message","id":"message-output-1"}}\n\n`,
      `data: {"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":{"type":"message","id":"message-output-1","content":[],"extra":${nested}}}\n\n`,
    ].join("");
    const provider = providerWith(
      chunkedResponse(body, [4_096]),
      undefined,
      { maxEventBytes: 65_536, maxStreamBytes: 100_000 },
    );

    await expect(collect(provider.stream(input, new AbortController().signal)))
      .rejects.toMatchObject({ code: "provider_invalid_response", status: 503 });
  });

  it("reads environment secrets on demand without serializing them", () => {
    const environment: NodeJS.ProcessEnv = { OPENAI_API_KEY: SENTINEL };
    const secrets = createEnvironmentSecretProvider(environment);

    expect(secrets.read("OPENAI_API_KEY")).toBe(SENTINEL);
    environment.OPENAI_API_KEY = "rotated-secret";
    expect(secrets.read("OPENAI_API_KEY")).toBe("rotated-secret");
    expect(JSON.stringify(secrets)).not.toContain(SENTINEL);
    expect(() => secrets.read("INVALID-NAME")).toThrow(TypeError);
  });

  it("rejects non-HTTPS endpoints and missing secrets before fetch", async () => {
    expect(() =>
      createOpenAiResponsesProvider({
        endpoint: "http://api.openai.com/v1/responses",
        model: "gpt-5-mini",
        secretEnvironmentKey: "OPENAI_API_KEY",
        secretProvider: createEnvironmentSecretProvider({ OPENAI_API_KEY: SENTINEL }),
        fetchImpl: vi.fn<typeof fetch>(),
      }),
    ).toThrow(TypeError);

    const fetchImpl = vi.fn<typeof fetch>();
    const provider = createOpenAiResponsesProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "gpt-5-mini",
      secretEnvironmentKey: "OPENAI_API_KEY",
      secretProvider: createEnvironmentSecretProvider({}),
      fetchImpl,
    });
    await expect(collect(provider.stream(input, new AbortController().signal))).rejects.toMatchObject({
      code: "provider_not_configured",
      status: 503,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
