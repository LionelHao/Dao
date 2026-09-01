export type ProviderAdapterId =
  | "openai-memory-steward"
  | "openai-responses"
  | "openai-router";

export interface ProviderAdapterSecurityDescriptor {
  readonly adapterId: ProviderAdapterId;
  readonly providerId: "openai-responses";
  readonly inputAuthority:
    | "current_eligible_frozen_sources"
    | "frozen_compiled_snapshot"
    | "summary_only_route_input";
  readonly modelPolicy: "fixed_at_startup";
  readonly requestRetention: "store_false";
  readonly rawBodyLogging: "forbidden";
  readonly headerLogging: "forbidden";
  readonly hiddenReasoningPersistence: "forbidden";
  readonly fallbackPolicy: "none";
  readonly automaticModelSwitch: false;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

export const PROVIDER_ADAPTER_SECURITY_INVENTORY: readonly ProviderAdapterSecurityDescriptor[] =
  Object.freeze([
    Object.freeze({
      adapterId: "openai-memory-steward",
      providerId: "openai-responses",
      inputAuthority: "current_eligible_frozen_sources",
      modelPolicy: "fixed_at_startup",
      requestRetention: "store_false",
      rawBodyLogging: "forbidden",
      headerLogging: "forbidden",
      hiddenReasoningPersistence: "forbidden",
      fallbackPolicy: "none",
      automaticModelSwitch: false,
      maxRequestBytes: 384 * 1_024,
      maxResponseBytes: 64 * 1_024,
    }),
    Object.freeze({
      adapterId: "openai-responses",
      providerId: "openai-responses",
      inputAuthority: "frozen_compiled_snapshot",
      modelPolicy: "fixed_at_startup",
      requestRetention: "store_false",
      rawBodyLogging: "forbidden",
      headerLogging: "forbidden",
      hiddenReasoningPersistence: "forbidden",
      fallbackPolicy: "none",
      automaticModelSwitch: false,
      maxRequestBytes: 256 * 1_024,
      maxResponseBytes: 256 * 1_024,
    }),
    Object.freeze({
      adapterId: "openai-router",
      providerId: "openai-responses",
      inputAuthority: "summary_only_route_input",
      modelPolicy: "fixed_at_startup",
      requestRetention: "store_false",
      rawBodyLogging: "forbidden",
      headerLogging: "forbidden",
      hiddenReasoningPersistence: "forbidden",
      fallbackPolicy: "none",
      automaticModelSwitch: false,
      maxRequestBytes: 128 * 1_024,
      maxResponseBytes: 64 * 1_024,
    }),
  ] satisfies readonly ProviderAdapterSecurityDescriptor[]);

const INVENTORY_BY_ID = new Map(
  PROVIDER_ADAPTER_SECURITY_INVENTORY.map((entry) => [entry.adapterId, entry]),
);
const FORBIDDEN_REQUEST_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "credential",
  "credentials",
  "headers",
  "hidden_reasoning",
  "include",
  "password",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "secret",
  "token",
]);

export class ProviderSecurityPolicyError extends Error {
  constructor(readonly reason:
    | "unknown_adapter"
    | "invalid_model"
    | "retention_not_disabled"
    | "forbidden_request_field"
    | "noncanonical_request"
    | "request_too_large") {
    super(`Provider security policy rejected: ${reason}`);
    this.name = "ProviderSecurityPolicyError";
  }
}

function walkJson(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProviderSecurityPolicyError("noncanonical_request");
    return;
  }
  if (typeof value !== "object") {
    throw new ProviderSecurityPolicyError("noncanonical_request");
  }
  if (seen.has(value)) throw new ProviderSecurityPolicyError("noncanonical_request");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) walkJson(entry, seen);
  } else {
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (FORBIDDEN_REQUEST_KEYS.has(key.toLowerCase())) {
        throw new ProviderSecurityPolicyError("forbidden_request_field");
      }
      walkJson(entry, seen);
    }
  }
  seen.delete(value);
}

export function encodeNoRetentionOpenAIRequest(input: Readonly<{
  adapterId: ProviderAdapterId;
  modelId: string;
  body: Readonly<Record<string, unknown>>;
  maxBytes: number;
}>): string {
  const descriptor = INVENTORY_BY_ID.get(input.adapterId);
  if (descriptor === undefined) throw new ProviderSecurityPolicyError("unknown_adapter");
  if (typeof input.modelId !== "string" || input.modelId.length === 0 ||
      input.body.model !== input.modelId) {
    throw new ProviderSecurityPolicyError("invalid_model");
  }
  if (input.body.store !== false) {
    throw new ProviderSecurityPolicyError("retention_not_disabled");
  }
  walkJson(input.body, new Set());
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 ||
      input.maxBytes > descriptor.maxRequestBytes) {
    throw new ProviderSecurityPolicyError("request_too_large");
  }
  const encoded = JSON.stringify(input.body);
  if (Buffer.byteLength(encoded, "utf8") > input.maxBytes) {
    throw new ProviderSecurityPolicyError("request_too_large");
  }
  return encoded;
}

export interface ProviderSecurityDisclosure {
  readonly providerId: "openai-responses";
  readonly modelId: string;
  readonly readiness: "ready" | "noauth";
  readonly retentionDisabled: true;
  readonly selectionPolicy: "server-managed-single";
  readonly disclosureRevision: number;
  readonly disclosedAt: string;
}

export function createProviderSecurityDisclosure(input: Readonly<{
  modelId: string;
  readiness: "ready" | "noauth";
  disclosureRevision: number;
  disclosedAt: string;
}>): ProviderSecurityDisclosure {
  if (typeof input.modelId !== "string" || input.modelId.length === 0 ||
      (input.readiness !== "ready" && input.readiness !== "noauth") ||
      !Number.isSafeInteger(input.disclosureRevision) || input.disclosureRevision < 1 ||
      !Number.isFinite(Date.parse(input.disclosedAt))) {
    throw new TypeError("Provider security disclosure is invalid");
  }
  return Object.freeze({
    providerId: "openai-responses",
    modelId: input.modelId,
    readiness: input.readiness,
    retentionDisabled: true,
    selectionPolicy: "server-managed-single",
    disclosureRevision: input.disclosureRevision,
    disclosedAt: input.disclosedAt,
  });
}
