import type { ProviderEvent } from "@native-im/core";
import { AgentRuntimeError } from "./contracts.js";

interface SseParserLimits {
  readonly maxBufferedBytes: number;
}

type JsonRecord = Record<string, unknown>;

const ignorableMetadataEvents = new Set([
  "response.queued",
  "response.in_progress",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.done",
  "response.function_call_arguments.done",
]);

function malformed(): AgentRuntimeError {
  return new AgentRuntimeError("provider_malformed", "Provider stream was malformed");
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(data: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!record(parsed)) throw malformed();
    return parsed;
  } catch (error: unknown) {
    if (error instanceof AgentRuntimeError) throw error;
    throw malformed();
  }
}

export async function* parseOpenAIResponseSse(
  chunks: AsyncIterable<Uint8Array>,
  limits: SseParserLimits,
): AsyncIterable<ProviderEvent> {
  if (!Number.isSafeInteger(limits.maxBufferedBytes) || limits.maxBufferedBytes < 256) {
    throw new TypeError("maxBufferedBytes must be a bounded positive integer");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let started = false;
  let completed = false;
  let sequence = 0;

  const parseFrame = (frame: string): ProviderEvent | undefined => {
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.length === 0 || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const rawValue = separator === -1 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") {
        if (eventName !== undefined || value.length === 0) throw malformed();
        eventName = value;
      } else if (field === "data") {
        dataLines.push(value);
      } else if (field !== "id" && field !== "retry") {
        throw malformed();
      }
    }
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      if (!completed) throw malformed();
      return undefined;
    }
    const payload = parseJson(data);
    const type = payload.type;
    if (typeof type !== "string" || (eventName !== undefined && eventName !== type)) {
      throw malformed();
    }
    if (type === "response.created") {
      if (started || completed) throw malformed();
      started = true;
      sequence += 1;
      return { type: "response_started", sequence };
    }
    if (!started || completed) throw malformed();
    if (type === "response.output_text.delta") {
      if (typeof payload.delta !== "string" || payload.delta.length === 0) throw malformed();
      sequence += 1;
      return { type: "text_delta", sequence, delta: payload.delta };
    }
    if (type === "response.output_item.added") {
      if (!record(payload.item) || payload.item.type !== "function_call" ||
          typeof payload.item.name !== "string" || payload.item.name.length === 0) {
        return undefined;
      }
      const callId = typeof payload.item.call_id === "string"
        ? payload.item.call_id
        : typeof payload.item.id === "string" ? payload.item.id : undefined;
      if (callId === undefined || callId.length === 0) throw malformed();
      sequence += 1;
      return { type: "tool_call_started", sequence, callId, toolName: payload.item.name };
    }
    if (type === "response.function_call_arguments.delta") {
      const callId = typeof payload.call_id === "string"
        ? payload.call_id
        : typeof payload.item_id === "string" ? payload.item_id : undefined;
      if (callId === undefined || callId.length === 0 || typeof payload.delta !== "string") {
        throw malformed();
      }
      sequence += 1;
      return { type: "tool_call_delta", sequence, callId, delta: payload.delta };
    }
    if (type === "response.completed") {
      completed = true;
      sequence += 1;
      return { type: "completed", sequence };
    }
    if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      throw new AgentRuntimeError("provider_failure", "Provider stream failed");
    }
    if (ignorableMetadataEvents.has(type)) return undefined;
    throw malformed();
  };

  try {
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
      if (Buffer.byteLength(buffer, "utf8") > limits.maxBufferedBytes) throw malformed();
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed !== undefined) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
  } catch (error: unknown) {
    if (error instanceof AgentRuntimeError) throw error;
    throw malformed();
  }

  if (buffer.trim().length > 0) {
    const parsed = parseFrame(buffer);
    if (parsed !== undefined) yield parsed;
  }
  if (!started || !completed) throw malformed();
}
