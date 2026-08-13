import { createHash } from "node:crypto";
import type {
  AgentRuntimeProviderInput,
  ProviderAdapter,
  ProviderEvent,
  RuntimeJsonValue,
  SecretProvider,
} from "./contracts.js";

export type OpenAiResponsesProviderErrorCode =
  | "provider_cancelled"
  | "provider_input_too_large"
  | "provider_invalid_request"
  | "provider_invalid_response"
  | "provider_not_configured"
  | "provider_failure"
  | "provider_response_too_large"
  | "provider_unauthorized"
  | "rate_limited"
  | "upstream_timeout"
  | "upstream_unavailable";

export class OpenAiResponsesProviderError extends Error {
  constructor(
    readonly code: OpenAiResponsesProviderErrorCode,
    readonly status: 409 | 429 | 503,
  ) {
    super(code);
    this.name = "OpenAiResponsesProviderError";
  }
}

export interface OpenAiResponsesProviderOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly secretEnvironmentKey: string;
  readonly secretProvider: SecretProvider;
  readonly fetchImpl?: typeof fetch;
  readonly maxEventBytes?: number;
  readonly maxStreamBytes?: number;
}

const DEFAULT_MAX_EVENT_BYTES = 65_536;
const DEFAULT_MAX_STREAM_BYTES = 4 * 1024 * 1024;
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]*$/;
const IGNORED_EVENT_TYPES = new Set([
  "response.queued",
  "response.in_progress",
]);
const NON_TOOL_OUTPUT_ITEM_TYPES = new Set(["message", "reasoning"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function providerError(
  code: OpenAiResponsesProviderErrorCode,
  status: 409 | 429 | 503 = 503,
): OpenAiResponsesProviderError {
  return new OpenAiResponsesProviderError(code, status);
}

function requireEnvironmentKey(value: string): void {
  if (!ENVIRONMENT_KEY.test(value)) {
    throw new TypeError("Secret environment key must be a canonical environment name");
  }
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

export function createEnvironmentSecretProvider(
  environment: NodeJS.ProcessEnv = process.env,
): SecretProvider {
  return {
    read(environmentKey: string): string | undefined {
      requireEnvironmentKey(environmentKey);
      const value = environment[environmentKey];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    },
  };
}

function providerInputPayload(input: AgentRuntimeProviderInput): RuntimeJsonValue {
  return {
    purpose: input.purpose,
    invocation: {
      sourceMessageId: input.invocation.sourceMessageId,
      requesterActorId: input.invocation.requesterActorId,
      targetAgentId: input.invocation.targetAgentId,
      intentKind: input.invocation.intentKind,
    },
    visibleConversation: input.visibleConversation.map((entry) => ({
      messageId: entry.messageId,
      actorId: entry.actorId,
      body: entry.body,
    })),
    committedSteps: input.committedSteps.map((step) => ({
      stepSeq: step.stepSeq,
      kind: step.kind,
      modelInput: step.modelInput,
    })),
  };
}

function providerToolName(toolId: string): string {
  return `tool_${createHash("sha256").update(toolId, "utf8").digest("base64url")}`;
}

function requestBody(
  input: AgentRuntimeProviderInput,
  model: string,
  canonicalToProviderToolNames: ReadonlyMap<string, string>,
): string {
  let serialized: string;
  try {
    const providerInput = JSON.stringify(providerInputPayload(input));
    serialized = JSON.stringify({
      model,
      stream: true,
      store: false,
      input: providerInput,
      tools: input.availableTools.map((tool) => ({
        type: "function",
        name: canonicalToProviderToolNames.get(tool.id),
        description: tool.description,
        parameters: tool.parametersSchema,
        strict: true,
      })),
    });
  } catch {
    throw providerError("provider_invalid_request", 409);
  }
  if (Buffer.byteLength(serialized, "utf8") > input.limits.maxInputBytes) {
    throw providerError("provider_input_too_large", 409);
  }
  return serialized;
}

function mapHttpError(status: number): OpenAiResponsesProviderError {
  if (status === 401 || status === 403) {
    return providerError("provider_unauthorized");
  }
  if (status === 408 || status === 504) {
    return providerError("upstream_timeout");
  }
  if (status === 429) {
    return providerError("rate_limited", 429);
  }
  if (status === 413) {
    return providerError("provider_input_too_large", 409);
  }
  if (status >= 400 && status < 500) {
    return providerError("provider_invalid_request", 409);
  }
  return providerError("upstream_unavailable");
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function parseDataBlock(block: string, maxEventBytes: number): string {
  if (Buffer.byteLength(block, "utf8") > maxEventBytes) {
    throw providerError("provider_response_too_large");
  }
  const data: string[] = [];
  const normalized = block.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    throw providerError("provider_invalid_response");
  }
  for (const line of normalized.split("\n")) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
      continue;
    }
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      continue;
    }
    throw providerError("provider_invalid_response");
  }
  if (data.length === 0) {
    throw providerError("provider_invalid_response");
  }
  return data.join("\n");
}

function nextEventBoundary(buffer: string):
  | { readonly index: number; readonly length: 2 | 4 }
  | undefined {
  const lineFeed = buffer.indexOf("\n\n");
  const carriageReturn = buffer.indexOf("\r\n\r\n");
  if (lineFeed < 0 && carriageReturn < 0) {
    return undefined;
  }
  if (lineFeed >= 0 && (carriageReturn < 0 || lineFeed < carriageReturn)) {
    return { index: lineFeed, length: 2 };
  }
  return { index: carriageReturn, length: 4 };
}

function parseJsonEvent(data: string): Record<string, unknown> & { readonly type: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw providerError("provider_invalid_response");
  }
  if (!isRecord(parsed) || !nonEmptyString(parsed.type)) {
    throw providerError("provider_invalid_response");
  }
  return parsed as Record<string, unknown> & { readonly type: string };
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) {
    throw providerError("provider_invalid_response");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`)
      .join(",")}}`;
  }
  throw providerError("provider_invalid_response");
}

function completedUsage(response: unknown): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly hasToolCalls: boolean;
} {
  if (!isRecord(response) || !isRecord(response.usage) || !Array.isArray(response.output)) {
    throw providerError("provider_invalid_response");
  }
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  if (!nonNegativeSafeInteger(inputTokens) || !nonNegativeSafeInteger(outputTokens)) {
    throw providerError("provider_invalid_response");
  }
  const hasToolCalls = response.output.some(
    (item) => isRecord(item) && item.type === "function_call",
  );
  return { inputTokens, outputTokens, hasToolCalls };
}

async function fetchResponse(
  fetchImpl: typeof fetch,
  endpoint: string,
  body: string,
  secret: string,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body,
      redirect: "error",
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw providerError("provider_cancelled", 409);
    }
    throw providerError("upstream_unavailable");
  }
}

export function createOpenAiResponsesProvider(
  options: OpenAiResponsesProviderOptions,
): ProviderAdapter {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new TypeError("OpenAI Responses endpoint must be an HTTPS URL without credentials");
  }
  if (!nonEmptyString(options.model)) {
    throw new TypeError("OpenAI Responses model must be non-empty");
  }
  requireEnvironmentKey(options.secretEnvironmentKey);
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
  const maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  requirePositiveSafeInteger(maxEventBytes, "maxEventBytes");
  requirePositiveSafeInteger(maxStreamBytes, "maxStreamBytes");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    id: "openai-responses",

    async *stream(
      input: AgentRuntimeProviderInput,
      signal: AbortSignal,
    ): AsyncIterable<ProviderEvent> {
      if (signal.aborted) {
        throw providerError("provider_cancelled", 409);
      }
      requirePositiveSafeInteger(input.limits.maxInputBytes, "maxInputBytes");
      requirePositiveSafeInteger(input.limits.maxOutputBytes, "maxOutputBytes");
      requirePositiveSafeInteger(input.limits.maxToolCalls, "maxToolCalls");
      const secret = options.secretProvider.read(options.secretEnvironmentKey);
      if (secret === undefined) {
        throw providerError("provider_not_configured");
      }
      const canonicalToProviderToolNames = new Map<string, string>();
      const providerToCanonicalToolNames = new Map<string, string>();
      for (const tool of input.availableTools) {
        if (!nonEmptyString(tool.id) || canonicalToProviderToolNames.has(tool.id)) {
          throw providerError("provider_invalid_request", 409);
        }
        const mappedName = providerToolName(tool.id);
        if (providerToCanonicalToolNames.has(mappedName)) {
          throw providerError("provider_invalid_request", 409);
        }
        canonicalToProviderToolNames.set(tool.id, mappedName);
        providerToCanonicalToolNames.set(mappedName, tool.id);
      }
      const body = requestBody(input, options.model, canonicalToProviderToolNames);
      const response = await fetchResponse(
        fetchImpl,
        endpoint.href,
        body,
        secret,
        signal,
      );
      if (!response.ok) {
        await cancelResponseBody(response);
        throw mapHttpError(response.status);
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "text/event-stream" || response.body === null) {
        await cancelResponseBody(response);
        throw providerError("provider_invalid_response");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let streamBytes = 0;
      let started = false;
      let completed = false;
      let responseId: string | undefined;
      let lastSequence = -1;
      let outputBytes = 0;
      const callIds = new Set<string>();
      const outputIndexes = new Set<number>();
      type TrackedOutputItem =
        | {
            readonly type: "message" | "reasoning";
            readonly outputIndex: number;
            done: boolean;
            doneCanonical?: string;
          }
        | {
            readonly type: "function_call";
            readonly outputIndex: number;
            readonly callId: string;
            readonly toolId: string;
            arguments: string;
            argumentsDone: boolean;
            done: boolean;
            doneCanonical?: string;
          };
      type TrackedContentPart = {
        readonly itemId: string;
        readonly outputIndex: number;
        readonly contentIndex: number;
        readonly type: "output_text" | "refusal";
        value: string;
        valueDone: boolean;
        done: boolean;
      };
      const outputItems = new Map<string, TrackedOutputItem>();
      const contentParts = new Map<string, TrackedContentPart>();

      const ensureNotAborted = (): void => {
        if (signal.aborted) {
          throw providerError("provider_cancelled", 409);
        }
      };
      const contentKey = (itemId: string, contentIndex: number): string =>
        `${itemId}\u0000${contentIndex}`;
      const requireIdentity = (
        event: Record<string, unknown>,
      ): { readonly itemId: string; readonly outputIndex: number } => {
        if (!nonEmptyString(event.item_id) || !nonNegativeSafeInteger(event.output_index)) {
          throw providerError("provider_invalid_response");
        }
        const item = outputItems.get(event.item_id);
        if (item === undefined || item.outputIndex !== event.output_index) {
          throw providerError("provider_invalid_response");
        }
        return { itemId: event.item_id, outputIndex: event.output_index };
      };
      const appendOutput = (delta: string): void => {
        outputBytes += Buffer.byteLength(delta, "utf8");
        if (outputBytes > input.limits.maxOutputBytes) {
          throw providerError("provider_response_too_large");
        }
      };
      const appendFinalSuffix = function* (
        current: string,
        finalValue: string,
        eventFactory: (suffix: string) => ProviderEvent,
      ): Generator<ProviderEvent> {
        if (!finalValue.startsWith(current)) {
          throw providerError("provider_invalid_response");
        }
        const suffix = finalValue.slice(current.length);
        if (suffix.length > 0) {
          appendOutput(suffix);
          ensureNotAborted();
          yield eventFactory(suffix);
        }
      };
      const validateCompletedOutput = (responseValue: unknown): {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly hasToolCalls: boolean;
      } => {
        const usage = completedUsage(responseValue);
        if (
          !isRecord(responseValue) ||
          responseValue.id !== responseId ||
          !Array.isArray(responseValue.output)
        ) {
          throw providerError("provider_invalid_response");
        }
        if (responseValue.output.length !== outputItems.size) {
          throw providerError("provider_invalid_response");
        }
        const seen = new Set<string>();
        for (const [outputIndex, rawItem] of responseValue.output.entries()) {
          if (!isRecord(rawItem) || !nonEmptyString(rawItem.id) || !nonEmptyString(rawItem.type)) {
            throw providerError("provider_invalid_response");
          }
          const tracked = outputItems.get(rawItem.id);
          if (
            tracked === undefined ||
            tracked.outputIndex !== outputIndex ||
            tracked.type !== rawItem.type ||
            !tracked.done ||
            seen.has(rawItem.id)
          ) {
            throw providerError("provider_invalid_response");
          }
          if (
            tracked.type === "function_call" &&
            (rawItem.call_id !== tracked.callId ||
              providerToCanonicalToolNames.get(String(rawItem.name)) !== tracked.toolId ||
              rawItem.arguments !== tracked.arguments ||
              !tracked.argumentsDone)
          ) {
            throw providerError("provider_invalid_response");
          }
          if (tracked.doneCanonical !== canonicalJson(rawItem)) {
            throw providerError("provider_invalid_response");
          }
          seen.add(rawItem.id);
        }
        for (const part of contentParts.values()) {
          if (!part.valueDone || !part.done) {
            throw providerError("provider_invalid_response");
          }
        }
        return usage;
      };

      const translate = function* (data: string): Generator<ProviderEvent> {
        ensureNotAborted();
        if (data === "[DONE]") {
          if (!completed) {
            throw providerError("provider_invalid_response");
          }
          return;
        }
        const event = parseJsonEvent(data);
        if (!nonNegativeSafeInteger(event.sequence_number) || event.sequence_number <= lastSequence) {
          throw providerError("provider_invalid_response");
        }
        lastSequence = event.sequence_number;

        if (
          event.type === "error" ||
          event.type === "response.failed" ||
          event.type === "response.incomplete"
        ) {
          throw providerError("provider_failure", 409);
        }

        if (event.type === "response.created") {
          if (
            started ||
            completed ||
            !isRecord(event.response) ||
            !nonEmptyString(event.response.id)
          ) {
            throw providerError("provider_invalid_response");
          }
          started = true;
          responseId = event.response.id;
          ensureNotAborted();
          yield { type: "response_started" };
          return;
        }
        if (!started || completed) {
          throw providerError("provider_invalid_response");
        }
        if (event.type === "response.output_text.delta") {
          const identity = requireIdentity(event);
          if (!nonNegativeSafeInteger(event.content_index) || typeof event.delta !== "string") {
            throw providerError("provider_invalid_response");
          }
          const part = contentParts.get(contentKey(identity.itemId, event.content_index));
          if (
            part === undefined ||
            part.outputIndex !== identity.outputIndex ||
            part.type !== "output_text" ||
            part.valueDone
          ) {
            throw providerError("provider_invalid_response");
          }
          appendOutput(event.delta);
          part.value += event.delta;
          ensureNotAborted();
          yield { type: "text_delta", delta: event.delta };
          return;
        }
        if (event.type === "response.output_item.added") {
          if (!isRecord(event.item) || !nonNegativeSafeInteger(event.output_index)) {
            throw providerError("provider_invalid_response");
          }
          if (
            typeof event.item.type !== "string" ||
            (!NON_TOOL_OUTPUT_ITEM_TYPES.has(event.item.type) &&
              event.item.type !== "function_call")
          ) {
            throw providerError("provider_invalid_response");
          }
          if (
            !nonEmptyString(event.item.id) ||
            outputItems.has(event.item.id) ||
            outputIndexes.has(event.output_index) ||
            event.output_index !== outputItems.size
          ) {
            throw providerError("provider_invalid_response");
          }
          if (event.item.type !== "function_call") {
            outputItems.set(event.item.id, {
              type: event.item.type as "message" | "reasoning",
              outputIndex: event.output_index,
              done: false,
            });
            outputIndexes.add(event.output_index);
            return;
          }
          if (
            !nonEmptyString(event.item.id) ||
            !nonEmptyString(event.item.call_id) ||
            !nonEmptyString(event.item.name) ||
            typeof event.item.arguments !== "string" ||
            callIds.has(event.item.call_id) ||
            !providerToCanonicalToolNames.has(event.item.name)
          ) {
            throw providerError("provider_invalid_response");
          }
          const toolCallCount = [...outputItems.values()].filter(
            (item) => item.type === "function_call",
          ).length;
          if (toolCallCount >= input.limits.maxToolCalls) {
            throw providerError("provider_response_too_large");
          }
          const canonicalToolId = providerToCanonicalToolNames.get(event.item.name);
          if (canonicalToolId === undefined) {
            throw providerError("provider_invalid_response");
          }
          outputItems.set(event.item.id, {
            type: "function_call",
            outputIndex: event.output_index,
            callId: event.item.call_id,
            toolId: canonicalToolId,
            arguments: event.item.arguments,
            argumentsDone: false,
            done: false,
          });
          outputIndexes.add(event.output_index);
          if (event.item.arguments.length > 0) {
            appendOutput(event.item.arguments);
            ensureNotAborted();
            yield {
              type: "tool_call_delta",
              callId: event.item.call_id,
              toolId: canonicalToolId,
              argumentsDelta: event.item.arguments,
            };
          }
          callIds.add(event.item.call_id);
          return;
        }
        if (event.type === "response.content_part.added") {
          const identity = requireIdentity(event);
          if (
            !nonNegativeSafeInteger(event.content_index) ||
            !isRecord(event.part) ||
            (event.part.type !== "output_text" && event.part.type !== "refusal")
          ) {
            throw providerError("provider_invalid_response");
          }
          const initial =
            event.part.type === "output_text" ? event.part.text : event.part.refusal;
          const key = contentKey(identity.itemId, event.content_index);
          if (typeof initial !== "string" || contentParts.has(key)) {
            throw providerError("provider_invalid_response");
          }
          contentParts.set(key, {
            itemId: identity.itemId,
            outputIndex: identity.outputIndex,
            contentIndex: event.content_index,
            type: event.part.type,
            value: initial,
            valueDone: false,
            done: false,
          });
          if (initial.length > 0) {
            appendOutput(initial);
            ensureNotAborted();
            yield { type: "text_delta", delta: initial };
          }
          return;
        }
        if (event.type === "response.refusal.delta") {
          const identity = requireIdentity(event);
          if (!nonNegativeSafeInteger(event.content_index) || typeof event.delta !== "string") {
            throw providerError("provider_invalid_response");
          }
          const part = contentParts.get(contentKey(identity.itemId, event.content_index));
          if (part === undefined || part.type !== "refusal" || part.valueDone) {
            throw providerError("provider_invalid_response");
          }
          appendOutput(event.delta);
          part.value += event.delta;
          ensureNotAborted();
          yield { type: "text_delta", delta: event.delta };
          return;
        }
        if (event.type === "response.function_call_arguments.delta") {
          const identity = requireIdentity(event);
          if (typeof event.delta !== "string") {
            throw providerError("provider_invalid_response");
          }
          const toolCall = outputItems.get(identity.itemId);
          if (toolCall === undefined || toolCall.type !== "function_call" || toolCall.argumentsDone) {
            throw providerError("provider_invalid_response");
          }
          appendOutput(event.delta);
          toolCall.arguments += event.delta;
          ensureNotAborted();
          yield {
            type: "tool_call_delta",
            callId: toolCall.callId,
            toolId: toolCall.toolId,
            argumentsDelta: event.delta,
          };
          return;
        }
        if (event.type === "response.output_text.done" || event.type === "response.refusal.done") {
          const identity = requireIdentity(event);
          if (!nonNegativeSafeInteger(event.content_index)) {
            throw providerError("provider_invalid_response");
          }
          const part = contentParts.get(contentKey(identity.itemId, event.content_index));
          const expectedType = event.type === "response.output_text.done" ? "output_text" : "refusal";
          const finalValue = event.type === "response.output_text.done" ? event.text : event.refusal;
          if (
            part === undefined ||
            part.type !== expectedType ||
            part.valueDone ||
            typeof finalValue !== "string"
          ) {
            throw providerError("provider_invalid_response");
          }
          yield* appendFinalSuffix(part.value, finalValue, (suffix) => ({
            type: "text_delta",
            delta: suffix,
          }));
          part.value = finalValue;
          part.valueDone = true;
          return;
        }
        if (event.type === "response.function_call_arguments.done") {
          const identity = requireIdentity(event);
          const toolCall = outputItems.get(identity.itemId);
          if (
            toolCall === undefined ||
            toolCall.type !== "function_call" ||
            toolCall.argumentsDone ||
            providerToCanonicalToolNames.get(String(event.name)) !== toolCall.toolId ||
            typeof event.arguments !== "string"
          ) {
            throw providerError("provider_invalid_response");
          }
          yield* appendFinalSuffix(toolCall.arguments, event.arguments, (suffix) => ({
            type: "tool_call_delta",
            callId: toolCall.callId,
            toolId: toolCall.toolId,
            argumentsDelta: suffix,
          }));
          toolCall.arguments = event.arguments;
          toolCall.argumentsDone = true;
          return;
        }
        if (event.type === "response.content_part.done") {
          const identity = requireIdentity(event);
          if (!nonNegativeSafeInteger(event.content_index) || !isRecord(event.part)) {
            throw providerError("provider_invalid_response");
          }
          const part = contentParts.get(contentKey(identity.itemId, event.content_index));
          const finalValue = event.part.type === "output_text" ? event.part.text : event.part.refusal;
          if (
            part === undefined ||
            part.done ||
            !part.valueDone ||
            event.part.type !== part.type ||
            finalValue !== part.value
          ) {
            throw providerError("provider_invalid_response");
          }
          part.done = true;
          return;
        }
        if (event.type === "response.output_item.done") {
          if (!isRecord(event.item) || !nonNegativeSafeInteger(event.output_index) || !nonEmptyString(event.item.id)) {
            throw providerError("provider_invalid_response");
          }
          const tracked = outputItems.get(event.item.id);
          const completedItemId = event.item.id;
          if (
            tracked === undefined ||
            tracked.done ||
            tracked.outputIndex !== event.output_index ||
            tracked.type !== event.item.type
          ) {
            throw providerError("provider_invalid_response");
          }
          if (tracked.type === "function_call") {
            if (
              !tracked.argumentsDone ||
              event.item.call_id !== tracked.callId ||
              providerToCanonicalToolNames.get(String(event.item.name)) !== tracked.toolId ||
              event.item.arguments !== tracked.arguments
            ) {
              throw providerError("provider_invalid_response");
            }
          } else {
            const itemParts = [...contentParts.values()]
              .filter((part) => part.itemId === completedItemId)
              .sort((left, right) => left.contentIndex - right.contentIndex);
            if (itemParts.some((part) => !part.done)) {
              throw providerError("provider_invalid_response");
            }
            if (tracked.type === "message") {
              if (!Array.isArray(event.item.content) || event.item.content.length !== itemParts.length) {
                throw providerError("provider_invalid_response");
              }
              for (const [index, part] of itemParts.entries()) {
                const rawPart = event.item.content[index];
                const rawValue =
                  isRecord(rawPart) && rawPart.type === "output_text"
                    ? rawPart.text
                    : isRecord(rawPart) && rawPart.type === "refusal"
                      ? rawPart.refusal
                      : undefined;
                if (
                  !isRecord(rawPart) ||
                  rawPart.type !== part?.type ||
                  rawValue !== part.value ||
                  part.contentIndex !== index
                ) {
                  throw providerError("provider_invalid_response");
                }
              }
            }
          }
          tracked.doneCanonical = canonicalJson(event.item);
          tracked.done = true;
          return;
        }
        if (event.type === "response.completed") {
          const usage = validateCompletedOutput(event.response);
          completed = true;
          ensureNotAborted();
          yield {
            type: "usage",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          };
          ensureNotAborted();
          yield {
            type: "completed",
            finishReason: usage.hasToolCalls ? "tool_calls" : "stop",
          };
          return;
        }
        if (IGNORED_EVENT_TYPES.has(event.type)) {
          return;
        }
        throw providerError("provider_invalid_response");
      };

      try {
        while (true) {
          ensureNotAborted();
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch {
            if (signal.aborted) {
              throw providerError("provider_cancelled", 409);
            }
            throw providerError("upstream_unavailable");
          }
          if (result.done) {
            break;
          }
          ensureNotAborted();
          streamBytes += result.value.byteLength;
          if (streamBytes > maxStreamBytes) {
            throw providerError("provider_response_too_large");
          }
          try {
            buffer += decoder.decode(result.value, { stream: true });
          } catch {
            throw providerError("provider_invalid_response");
          }
          let boundary = nextEventBoundary(buffer);
          while (boundary !== undefined) {
            const block = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary.length);
            if (block.length > 0) {
              const data = parseDataBlock(block, maxEventBytes);
              ensureNotAborted();
              yield* translate(data);
            }
            boundary = nextEventBoundary(buffer);
          }
          if (Buffer.byteLength(buffer, "utf8") > maxEventBytes) {
            throw providerError("provider_response_too_large");
          }
        }
        try {
          buffer += decoder.decode();
        } catch {
          throw providerError("provider_invalid_response");
        }
        if (buffer.trim().length > 0 || !started || !completed) {
          throw providerError("provider_invalid_response");
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}
