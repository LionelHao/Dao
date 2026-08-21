import type { AgentRuntimeProviderInput, ProviderEvent } from "@native-im/core";
import {
  canonicalJson,
  isCompiledProviderEnvelopeV1,
  type CompiledGroupContentBlockV1,
  type CompiledProviderEnvelopeV1,
  type CompiledProviderToolDescriptorV1,
  type CompiledProviderToolIdV1,
} from "./compiled-provider-envelope.js";
import { AgentRuntimeError, type SecretProvider } from "./contracts.js";
import {
  AGENT_FINAL_DRAFT_SCHEMA,
  parseAgentFinalDraftV1,
  type AgentFinalProviderEventV1,
} from "./provider-final.js";
import { parseOpenAIResponseSse } from "./sse-parser.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface OpenAIResponsesProviderOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly secretProvider: SecretProvider;
  readonly fetch?: FetchLike;
  readonly maxSseBufferBytes?: number;
}

export type OpenAIResponsesProviderEventV1 = ProviderEvent | AgentFinalProviderEventV1;

/**
 * Transitional local overload. The core contract is migrated by the integration slice; the
 * legacy overload keeps this isolated slice structurally assignable until that migration lands.
 * Runtime validation nevertheless rejects the legacy visibleConversation payload.
 */
export interface OpenAIResponsesProviderAdapterV1 {
  readonly id: string;
  stream(input: CompiledProviderEnvelopeV1, signal: AbortSignal): AsyncIterable<OpenAIResponsesProviderEventV1>;
  stream(input: AgentRuntimeProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

function configuredText(value: string, field: string): string {
  if (value.trim().length === 0) throw new TypeError(`${field} must be non-empty`);
  return value;
}

const OPEN_ITEM_PROPOSAL_FUNCTION = "dao_propose_open_item";

function functionName(tool: CompiledProviderToolIdV1 | "open-item.propose"): string {
  return tool === "open-item.propose"
    ? OPEN_ITEM_PROPOSAL_FUNCTION
    : tool.replaceAll(".", "_").replaceAll("-", "_");
}

function functionParameters(tool: CompiledProviderToolDescriptorV1): Readonly<Record<string, unknown>> {
  if (tool.id === "http-json.read") {
    return {
      type: "object",
      properties: { path: { type: "string", pattern: "^[A-Za-z0-9._~-]+$", maxLength: 256 } },
      required: ["path"],
      additionalProperties: false,
    };
  }
  if (tool.id === "sandbox-file.write") {
    return {
      type: "object",
      properties: {
        path: { type: "string", maxLength: 512 },
        content: { type: "string", maxLength: 262_144 },
        expectedCurrentSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["path", "content", "expectedCurrentSha256"],
      additionalProperties: false,
    };
  }
  if (tool.id === "room-memory.read") {
    return {
      type: "object",
      properties: {
        snapshotId: { type: "string", minLength: 1, maxLength: 256 },
        sourceLabel: { type: "string", minLength: 1, maxLength: 256 },
        mode: {
          type: "string",
          enum: ["source", "neighbors", "attachment_segment", "memory_sources", "project_object"],
        },
        pageSize: { type: "integer", minimum: 1, maximum: 8 },
        cursor: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["snapshotId", "sourceLabel", "mode"],
      additionalProperties: false,
    };
  }
  return { type: "object", properties: {}, additionalProperties: false };
}

function groupRole(_block: CompiledGroupContentBlockV1): "user" {
  return "user";
}

function buildProviderInput(input: CompiledProviderEnvelopeV1): unknown[] {
  const providerInput: unknown[] = [
    {
      role: "system",
      content: [{
        type: "input_text",
        text: canonicalJson({ schemaVersion: "trusted-system.v1", blocks: input.trusted.system }),
      }],
    },
    {
      role: "developer",
      content: [{
        type: "input_text",
        text: canonicalJson({
          schemaVersion: "trusted-developer.v1",
          snapshot: input.snapshot,
          invocation: input.invocation,
          projectContext: input.projectContext,
          blocks: input.trusted.developer,
        }),
      }],
    },
    ...input.groupContent.map((block) => ({
      role: groupRole(block),
      content: [{
        type: "input_text",
        text: canonicalJson({
          schemaVersion: "untrusted-group-content.v1",
          trust: "untrusted_group_content",
          data: block,
        }),
      }],
    })),
  ];
  for (const continuation of input.toolContinuations ?? []) {
    providerInput.push({
      type: "function_call",
      call_id: continuation.callId,
      name: functionName(continuation.toolId),
      arguments: continuation.argumentsJson,
    });
    providerInput.push({
      type: "function_call_output",
      call_id: continuation.callId,
      output: continuation.modelInput,
    });
  }
  return providerInput;
}

async function* responseBodyChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function cancelResponseBody(response: Response): void {
  if (response.body !== null) void response.body.cancel().catch(() => undefined);
}

function closedHttpError(status: number): AgentRuntimeError {
  if (status === 401 || status === 403) {
    return new AgentRuntimeError("provider_authentication", "Provider authentication failed");
  }
  if (status === 408 || status === 504) {
    return new AgentRuntimeError("provider_timeout", "Provider request timed out");
  }
  if (status === 429) {
    return new AgentRuntimeError("provider_rate_limited", "Provider rate limit was reached");
  }
  if (status >= 500) {
    return new AgentRuntimeError("provider_unavailable", "Provider is unavailable");
  }
  return new AgentRuntimeError("provider_failure", "Provider rejected the request");
}

function malformed(message: string): AgentRuntimeError {
  return new AgentRuntimeError("provider_malformed", message);
}

export function createOpenAIResponsesProvider(
  options: OpenAIResponsesProviderOptions,
): OpenAIResponsesProviderAdapterV1 {
  const endpoint = new URL(configuredText(options.endpoint, "endpoint"));
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "") {
    throw new TypeError("OpenAI Responses endpoint must be a credential-free HTTPS URL");
  }
  const model = configuredText(options.model, "model");
  const fetchRequest = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxSseBufferBytes = options.maxSseBufferBytes ?? 256 * 1_024;
  if (!Number.isSafeInteger(maxSseBufferBytes) || maxSseBufferBytes < 1_024 || maxSseBufferBytes > 1_024 * 1_024) {
    throw new TypeError("maxSseBufferBytes must be between 1024 and 1048576");
  }

  const adapter = Object.freeze({
    id: "openai-responses",
    async *stream(
      rawInput: AgentRuntimeProviderInput | CompiledProviderEnvelopeV1,
      signal: AbortSignal,
    ): AsyncIterable<OpenAIResponsesProviderEventV1> {
      if (!isCompiledProviderEnvelopeV1(rawInput) || rawInput.snapshot.modelId !== model) {
        throw new AgentRuntimeError("provider_failure", "Compiled Provider input was rejected");
      }
      const input = rawInput;
      const secret = options.secretProvider.getSecret("OPENAI_API_KEY");
      if (secret === undefined || secret.length === 0) {
        throw new AgentRuntimeError(
          "agent_configuration_missing",
          "Agent model authentication is not configured",
        );
      }
      const requestBody = JSON.stringify({
        model,
        stream: true,
        store: false,
        max_output_tokens: input.limits.maxOutputTokens,
        parallel_tool_calls: false,
        input: buildProviderInput(input),
        tools: [
          ...input.availableTools.map((tool) => ({
            type: "function",
            name: functionName(tool.id),
            description: tool.displayName,
            strict: true,
            parameters: functionParameters(tool),
          })),
          ...((input.openItemTargets?.length ?? 0) === 0 ? [] : [{
            type: "function",
            name: OPEN_ITEM_PROPOSAL_FUNCTION,
            description: "Create a structured risk or challenge OpenItem for a current room member; never infer targets from prose.",
            strict: true,
            parameters: {
              type: "object",
              properties: {
                proposalKind: { type: "string", enum: ["risk", "challenge"] },
                targetActorId: { type: "string", enum: input.openItemTargets!.map((target) => target.actorId) },
                sourceMessageId: { type: "string", enum: [input.invocation.sourceMessageId] },
                reason: { type: "string", minLength: 1, maxLength: 2_048 },
                content: { type: "string", minLength: 1, maxLength: 32_768 },
              },
              required: ["proposalKind", "targetActorId", "sourceMessageId", "reason", "content"],
              additionalProperties: false,
            },
          }]),
        ],
        text: {
          format: {
            type: "json_schema",
            name: "AgentFinalDraftV1",
            strict: true,
            schema: AGENT_FINAL_DRAFT_SCHEMA,
          },
        },
      });
      if (Buffer.byteLength(requestBody, "utf8") > input.limits.maxInputBytes) {
        throw new AgentRuntimeError("invalid_parameters", "Provider input exceeded its byte limit");
      }

      let response: Response;
      try {
        response = await fetchRequest(endpoint.toString(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: requestBody,
          signal,
          redirect: "error",
        });
      } catch (error: unknown) {
        if (signal.aborted) {
          throw new AgentRuntimeError("provider_timeout", "Provider request was aborted");
        }
        void error;
        throw new AgentRuntimeError("provider_unavailable", "Provider request could not be completed");
      }
      if (!response.ok) {
        cancelResponseBody(response);
        throw closedHttpError(response.status);
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "text/event-stream" || response.body === null) {
        cancelResponseBody(response);
        throw malformed("Provider stream content type was rejected");
      }

      let outputBytes = 0;
      let finalText = "";
      let sawToolCall = false;
      let outputSequence = 0;
      for await (const event of parseOpenAIResponseSse(responseBodyChunks(response.body), {
        maxBufferedBytes: maxSseBufferBytes,
      })) {
        if (event.type === "text_delta" || event.type === "tool_call_delta") {
          outputBytes += Buffer.byteLength(event.delta, "utf8");
          if (outputBytes > input.limits.maxOutputBytes) {
            throw malformed("Provider output exceeded its byte limit");
          }
        }
        if (event.type === "text_delta") {
          if (sawToolCall) throw malformed("Provider mixed tool calls and final output");
          finalText += event.delta;
          continue;
        }
        if (event.type === "tool_call_started" || event.type === "tool_call_delta") {
          if (finalText.length > 0) throw malformed("Provider mixed tool calls and final output");
          sawToolCall = true;
          yield Object.freeze({ ...event, sequence: ++outputSequence });
          continue;
        }
        if (event.type === "completed") {
          if (sawToolCall) {
            yield Object.freeze({ ...event, sequence: ++outputSequence });
          } else {
            const final = parseAgentFinalDraftV1(finalText);
            yield Object.freeze({
              type: "agent_final",
              sequence: ++outputSequence,
              body: final.body,
              citations: final.citations,
            });
          }
          continue;
        }
        yield Object.freeze({ ...event, sequence: ++outputSequence });
      }
    },
  });
  return adapter as OpenAIResponsesProviderAdapterV1;
}
