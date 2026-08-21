import { AgentRuntimeError } from "./contracts.js";

export interface AgentFinalDraftV1 {
  readonly body: string;
  readonly citations: readonly string[];
}

export interface AgentFinalProviderEventV1 extends AgentFinalDraftV1 {
  readonly type: "agent_final";
  readonly sequence: number;
}

export const AGENT_FINAL_DRAFT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    body: Object.freeze({ type: "string", minLength: 1, maxLength: 262_144 }),
    citations: Object.freeze({
      type: "array",
      maxItems: 128,
      items: Object.freeze({ type: "string", minLength: 1, maxLength: 256 }),
    }),
  }),
  required: Object.freeze(["body", "citations"]),
  additionalProperties: false,
});

function malformed(): AgentRuntimeError {
  return new AgentRuntimeError("provider_malformed", "Provider final output was malformed");
}

function label(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && value.normalize("NFC") === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

export function parseAgentFinalDraftV1(raw: string): AgentFinalDraftV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw malformed();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2 ||
      !Object.hasOwn(value, "body") || !Object.hasOwn(value, "citations")) throw malformed();
  const final = value as Record<string, unknown>;
  if (typeof final.body !== "string" || final.body.length === 0 ||
      Buffer.byteLength(final.body, "utf8") > 262_144 || !Array.isArray(final.citations) ||
      final.citations.length > 128 || !final.citations.every(label)) throw malformed();
  return Object.freeze({
    body: final.body,
    citations: Object.freeze([...final.citations] as string[]),
  });
}
