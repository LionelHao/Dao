import { describe, expect, it } from "vitest";
import { AgentRuntimeError } from "./contracts.js";
import { parseOpenAIResponseSse } from "./sse-parser.js";

async function collect(chunks: readonly string[]): Promise<readonly unknown[]> {
  async function* source(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield new TextEncoder().encode(chunk);
  }
  const events: unknown[] = [];
  for await (const event of parseOpenAIResponseSse(source(), { maxBufferedBytes: 4_096 })) {
    events.push(event);
  }
  return events;
}

describe("closed OpenAI Responses SSE parser", () => {
  it("handles arbitrary chunk boundaries and emits one ordered started/completed stream", async () => {
    await expect(collect([
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\nevent: response.output_text.de",
      "lta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hel\"}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
    ])).resolves.toEqual([
      { type: "response_started", sequence: 1 },
      { type: "text_delta", sequence: 2, delta: "hel" },
      { type: "text_delta", sequence: 3, delta: "lo" },
      { type: "completed", sequence: 4 },
    ]);
  });

  it.each([
    ["delta before start", "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n"],
    ["duplicate start", "event: response.created\ndata: {\"type\":\"response.created\"}\n\nevent: response.created\ndata: {\"type\":\"response.created\"}\n\n"],
    ["missing completion", "event: response.created\ndata: {\"type\":\"response.created\"}\n\n"],
    ["unknown semantic event", "event: response.created\ndata: {\"type\":\"response.created\"}\n\nevent: response.magic\ndata: {\"type\":\"response.magic\"}\n\n"],
  ])("fails closed for %s", async (_name, stream) => {
    await expect(collect([stream])).rejects.toMatchObject<Partial<AgentRuntimeError>>({
      code: "provider_malformed",
    });
  });

  it("bounds the unfinished SSE buffer", async () => {
    await expect(collect([`event: response.created\ndata: ${"x".repeat(5_000)}`]))
      .rejects.toMatchObject({ code: "provider_malformed" });
  });

  it("closes function-call identity before accepting bounded argument deltas", async () => {
    await expect(collect([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"repository_git_status"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","call_id":"call-1","delta":"{}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ])).resolves.toEqual([
      { type: "response_started", sequence: 1 },
      { type: "tool_call_started", sequence: 2, callId: "call-1", toolName: "repository_git_status" },
      { type: "tool_call_delta", sequence: 3, callId: "call-1", delta: "{}" },
      { type: "completed", sequence: 4 },
    ]);
  });
});
