import type { AgentRuntimeProviderInput, ProviderEvent, ToolDescriptor } from "@native-im/core";
import { AgentRuntimeError, type ProviderAdapter, type SecretProvider } from "./contracts.js";
import { parseOpenAIResponseSse } from "./sse-parser.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface OpenAIResponsesProviderOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly secretProvider: SecretProvider;
  readonly fetch?: FetchLike;
  readonly maxSseBufferBytes?: number;
}

function configuredText(value: string, field: string): string {
  if (value.trim().length === 0) throw new TypeError(`${field} must be non-empty`);
  return value;
}

const OPEN_ITEM_PROPOSAL_FUNCTION = "dao_propose_open_item";

function functionName(tool: ToolDescriptor | ToolDescriptor["id"] | "open-item.propose"): string {
  const id = typeof tool === "string" ? tool : tool.id;
  return id === "open-item.propose"
    ? OPEN_ITEM_PROPOSAL_FUNCTION
    : id.replaceAll(".", "_").replaceAll("-", "_");
}

function functionParameters(tool: ToolDescriptor): Readonly<Record<string, unknown>> {
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
  return { type: "object", properties: {}, additionalProperties: false };
}

async function* responseBodyChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
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

export function createOpenAIResponsesProvider(
  options: OpenAIResponsesProviderOptions,
): ProviderAdapter {
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

  return Object.freeze({
    id: "openai-responses",
    async *stream(input: AgentRuntimeProviderInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      if (input.purpose !== "agent_runtime") {
        throw new AgentRuntimeError("provider_failure", "Provider input purpose was rejected");
      }
      const secret = options.secretProvider.getSecret("OPENAI_API_KEY");
      if (secret === undefined || secret.length === 0) {
        throw new AgentRuntimeError(
          "agent_configuration_missing",
          "Agent model authentication is not configured",
        );
      }
      const conversationInput: unknown[] = input.visibleConversation.map((entry) => ({
        role: "user",
        content: [{ type: "input_text", text: entry.body }],
      }));
      for (const continuation of input.toolContinuations ?? []) {
        conversationInput.push({
          type: "function_call",
          call_id: continuation.callId,
          name: functionName(continuation.toolId),
          arguments: continuation.argumentsJson,
        });
        conversationInput.push({
          type: "function_call_output",
          call_id: continuation.callId,
          output: continuation.modelInput,
        });
      }
      const requestBody = JSON.stringify({
        model,
        stream: true,
        store: false,
        input: conversationInput,
        tools: [
          ...input.availableTools.map((tool) => ({
            type: "function",
            name: functionName(tool),
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
      if (!response.ok) throw closedHttpError(response.status);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "text/event-stream" || response.body === null) {
        throw new AgentRuntimeError("provider_malformed", "Provider stream content type was rejected");
      }

      let outputBytes = 0;
      for await (const event of parseOpenAIResponseSse(responseBodyChunks(response.body), {
        maxBufferedBytes: maxSseBufferBytes,
      })) {
        if (event.type === "text_delta" || event.type === "tool_call_delta") {
          outputBytes += Buffer.byteLength(event.delta, "utf8");
          if (outputBytes > input.limits.maxOutputBytes) {
            throw new AgentRuntimeError("provider_malformed", "Provider output exceeded its byte limit");
          }
        }
        yield event;
      }
    },
  });
}
