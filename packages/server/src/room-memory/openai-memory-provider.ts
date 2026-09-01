import { parseBoundedJson } from "./bounded-json-parser.js";
import {
  MEMORY_STEWARD_MAX_CANDIDATES,
  MEMORY_STEWARD_MAX_DEDUPE_KEY_BYTES,
  MEMORY_STEWARD_MAX_DERIVED_TEXT_BYTES,
  MEMORY_STEWARD_MAX_OUTPUT_BYTES,
  MEMORY_STEWARD_MAX_REQUEST_BYTES,
  MEMORY_STEWARD_MAX_SOURCE_CONTENT_BYTES,
  MEMORY_STEWARD_MAX_SOURCE_REFS,
  MEMORY_STEWARD_MAX_SOURCES,
  MEMORY_STEWARD_MAX_TOTAL_CONTENT_BYTES,
  MEMORY_STEWARD_SCHEMA_VERSION,
  MEMORY_STEWARD_TIMEOUT_MS,
  MemoryStewardProviderError,
  type FrozenMemoryStewardSource,
  type MemoryStewardCandidate,
  type MemoryStewardPlan,
  type MemoryStewardProvider,
  type MemoryStewardProviderInput,
  type MemoryStewardProviderValidators,
  type MemoryStewardSourceRef,
  type OpenAIMemoryStewardProviderConfig,
  type RoomMemoryKind,
} from "./contracts.js";
import { encodeNoRetentionOpenAIRequest } from "../privacy-operations/provider-security-policy.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function cancelRejectedResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Rejection remains closed even when the provider body cannot be cancelled.
  }
}

export interface OpenAIMemoryStewardProviderOptions extends OpenAIMemoryStewardProviderConfig {
  /** Deep unit-test seam only. Production composition must leave this unset. */
  readonly testOnlyFetch?: FetchLike;
}

const SOURCE_KINDS = new Set([
  "message",
  "message_revision",
  "message_tombstone",
  "attachment_extraction",
  "project_fact_checkpoint",
]);
const MEMORY_KINDS = new Set<RoomMemoryKind>([
  "goal",
  "decision",
  "context",
  "next_action",
  "open_question_or_blocker",
]);
const OPERATIONS = new Set(["create", "replace", "merge", "no_change"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_DEDUPE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const encoder = new TextEncoder();
const FORBIDDEN_DERIVED_TEXT = [
  /\b[a-z][a-z0-9+.-]*:\/\//iu,
  /(?:^|[\s"'`])(?:\/[A-Za-z0-9._~-]+){2,}/u,
  /\b[A-Za-z]:\\(?:[^\\\s]+\\)+/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/iu,
  /\bsk-[A-Za-z0-9_-]{12,}/u,
  /(?:^|\s)(?:sudo\b|rm\s+-rf\b|chmod\b|chown\b|powershell\b|cmd\.exe\b)/iu,
  /<\/?reasoning>|chain[- ]of[- ]thought|hidden reasoning/iu,
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string")) return false;
  const allowed = new Set(expected);
  return keys.every((key) => typeof key === "string" && allowed.has(key));
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function containsForbiddenDerivedText(value: string): boolean {
  return FORBIDDEN_DERIVED_TEXT.some((pattern) => pattern.test(value));
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function invalidInput(): never {
  throw new MemoryStewardProviderError("input_invalid", "Frozen memory provider input was rejected");
}

function validateFrozenInput(input: MemoryStewardProviderInput): readonly FrozenMemoryStewardSource[] {
  if (!isRecord(input) || !exactOwnKeys(input, [
    "purpose",
    "roomId",
    "generation",
    "fromWatermarkExclusive",
    "toCorpusSeqInclusive",
    "sources",
  ]) || input.purpose !== "room_memory_steward" || typeof input.roomId !== "string" ||
      !SAFE_ID.test(input.roomId) || !positiveSafeInteger(input.generation) ||
      !nonNegativeSafeInteger(input.fromWatermarkExclusive) ||
      !positiveSafeInteger(input.toCorpusSeqInclusive) ||
      input.toCorpusSeqInclusive <= input.fromWatermarkExclusive || !Array.isArray(input.sources) ||
      input.sources.length < 1 || input.sources.length > MEMORY_STEWARD_MAX_SOURCES) {
    return invalidInput();
  }

  let totalContentBytes = 0;
  let previousCorpusSeq = input.fromWatermarkExclusive;
  const identities = new Set<string>();
  for (const source of input.sources) {
    if (!isRecord(source) || !exactOwnKeys(source, [
      "roomId",
      "sourceId",
      "sourceRevision",
      "sourceKind",
      "corpusSeq",
      "eligibility",
      "content",
    ]) || source.roomId !== input.roomId || typeof source.sourceId !== "string" ||
        !SAFE_ID.test(source.sourceId) || !positiveSafeInteger(source.sourceRevision) ||
        typeof source.sourceKind !== "string" || !SOURCE_KINDS.has(source.sourceKind) ||
        !positiveSafeInteger(source.corpusSeq) || source.corpusSeq <= previousCorpusSeq ||
        source.corpusSeq > input.toCorpusSeqInclusive || source.eligibility !== "eligible" ||
        typeof source.content !== "string" || !validUnicode(source.content)) {
      return invalidInput();
    }
    const contentBytes = byteLength(source.content);
    if (contentBytes > MEMORY_STEWARD_MAX_SOURCE_CONTENT_BYTES) return invalidInput();
    totalContentBytes += contentBytes;
    if (totalContentBytes > MEMORY_STEWARD_MAX_TOTAL_CONTENT_BYTES) return invalidInput();
    const identity = `${source.sourceKind}\u0000${source.sourceId}\u0000${source.sourceRevision}`;
    if (identities.has(identity)) return invalidInput();
    identities.add(identity);
    previousCorpusSeq = source.corpusSeq;
  }
  return Object.freeze(input.sources.map((source) => Object.freeze({
    roomId: source.roomId,
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    sourceKind: source.sourceKind,
    corpusSeq: source.corpusSeq,
    eligibility: source.eligibility,
    content: source.content,
  })));
}

function validateValidators(validators: MemoryStewardProviderValidators): void {
  if (!isRecord(validators) || !exactOwnKeys(validators, ["isCurrentEligibleSource", "isKnownMemoryRecord"]) ||
      typeof validators.isCurrentEligibleSource !== "function" ||
      typeof validators.isKnownMemoryRecord !== "function") {
    invalidInput();
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch {
    throw new MemoryStewardProviderError("provider_malformed", "Memory provider response body was invalid");
  }
  if (body === null) {
    throw new MemoryStewardProviderError("provider_malformed", "Memory provider response body was missing");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MEMORY_STEWARD_MAX_OUTPUT_BYTES) {
        throw new MemoryStewardProviderError(
          "provider_malformed",
          "Memory provider response exceeded its byte limit",
        );
      }
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    if (error instanceof MemoryStewardProviderError) throw error;
    throw new MemoryStewardProviderError("provider_malformed", "Memory provider response could not be read");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function extractSingularOutputText(envelope: unknown): string {
  if (!isRecord(envelope) || !Array.isArray(envelope.output)) {
    throw new MemoryStewardProviderError("provider_malformed", "Memory provider response envelope was invalid");
  }
  const texts: string[] = [];
  for (const item of envelope.output) {
    if (!isRecord(item)) {
      throw new MemoryStewardProviderError("provider_malformed", "Memory provider output item was invalid");
    }
    if (item.type === "reasoning") continue;
    if (!Array.isArray(item.content)) {
      throw new MemoryStewardProviderError("provider_malformed", "Memory provider output item was rejected");
    }
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
        throw new MemoryStewardProviderError("provider_malformed", "Memory provider content item was rejected");
      }
      texts.push(part.text);
    }
  }
  if (texts.length !== 1 || !validUnicode(texts[0]!)) {
    throw new MemoryStewardProviderError("provider_malformed", "Memory provider output text was not singular");
  }
  return texts[0]!;
}

function freezeRef(
  sourceKind: FrozenMemoryStewardSource["sourceKind"],
  sourceId: string,
  sourceRevision: number,
): MemoryStewardSourceRef {
  return Object.freeze({ sourceKind, sourceId, sourceRevision });
}

function malformedOutput(): never {
  throw new MemoryStewardProviderError("provider_malformed", "Memory provider output was rejected");
}

function validatePlan(
  parsed: unknown,
  frozenSources: readonly FrozenMemoryStewardSource[],
): { readonly plan: MemoryStewardPlan; readonly referenced: readonly FrozenMemoryStewardSource[] } {
  if (!isRecord(parsed) || !exactOwnKeys(parsed, ["schemaVersion", "candidates"]) ||
      parsed.schemaVersion !== MEMORY_STEWARD_SCHEMA_VERSION || !Array.isArray(parsed.candidates) ||
      parsed.candidates.length > MEMORY_STEWARD_MAX_CANDIDATES) {
    return malformedOutput();
  }
  const frozenByIdentity = new Map<string, FrozenMemoryStewardSource>();
  for (const source of frozenSources) {
    frozenByIdentity.set(`${source.sourceKind}\u0000${source.sourceId}\u0000${source.sourceRevision}`, source);
  }
  const referenced = new Map<string, FrozenMemoryStewardSource>();
  const candidateIdentities = new Set<string>();
  const candidates: MemoryStewardCandidate[] = [];
  for (const candidate of parsed.candidates) {
    if (!isRecord(candidate) || !exactOwnKeys(candidate, [
      "operation",
      "kind",
      "derivedText",
      "sourceRefs",
      "dedupeKey",
      "replacesMemoryRecordId",
    ]) || typeof candidate.operation !== "string" || !OPERATIONS.has(candidate.operation) ||
        typeof candidate.kind !== "string" || !MEMORY_KINDS.has(candidate.kind as RoomMemoryKind) ||
        typeof candidate.derivedText !== "string" || !validUnicode(candidate.derivedText) ||
        containsForbiddenDerivedText(candidate.derivedText) ||
        byteLength(candidate.derivedText) < 1 ||
        byteLength(candidate.derivedText) > MEMORY_STEWARD_MAX_DERIVED_TEXT_BYTES ||
        !Array.isArray(candidate.sourceRefs) || candidate.sourceRefs.length < 1 ||
        candidate.sourceRefs.length > MEMORY_STEWARD_MAX_SOURCE_REFS ||
        typeof candidate.dedupeKey !== "string" || !SAFE_DEDUPE_KEY.test(candidate.dedupeKey) ||
        byteLength(candidate.dedupeKey) > MEMORY_STEWARD_MAX_DEDUPE_KEY_BYTES ||
        !(candidate.replacesMemoryRecordId === null ||
          (typeof candidate.replacesMemoryRecordId === "string" && SAFE_ID.test(candidate.replacesMemoryRecordId)))) {
      return malformedOutput();
    }
    const candidateIdentity = `${candidate.kind}\u0000${candidate.dedupeKey}`;
    if (candidateIdentities.has(candidateIdentity)) return malformedOutput();
    candidateIdentities.add(candidateIdentity);

    const refIdentities = new Set<string>();
    const refs: MemoryStewardSourceRef[] = [];
    for (const ref of candidate.sourceRefs) {
      if (!isRecord(ref) || !exactOwnKeys(ref, ["sourceKind", "sourceId", "sourceRevision"]) ||
          typeof ref.sourceKind !== "string" || !SOURCE_KINDS.has(ref.sourceKind) ||
          typeof ref.sourceId !== "string" || !SAFE_ID.test(ref.sourceId) ||
          !positiveSafeInteger(ref.sourceRevision)) {
        return malformedOutput();
      }
      const identity = `${ref.sourceKind}\u0000${ref.sourceId}\u0000${ref.sourceRevision}`;
      const source = frozenByIdentity.get(identity);
      if (source === undefined || refIdentities.has(identity)) return malformedOutput();
      refIdentities.add(identity);
      referenced.set(identity, source);
      refs.push(freezeRef(source.sourceKind, ref.sourceId, ref.sourceRevision));
    }
    candidates.push(Object.freeze({
      operation: candidate.operation as MemoryStewardCandidate["operation"],
      kind: candidate.kind as RoomMemoryKind,
      derivedText: candidate.derivedText,
      sourceRefs: Object.freeze(refs),
      dedupeKey: candidate.dedupeKey,
      replacesMemoryRecordId: candidate.replacesMemoryRecordId,
    }));
  }
  return {
    plan: Object.freeze({
      schemaVersion: MEMORY_STEWARD_SCHEMA_VERSION,
      candidates: Object.freeze(candidates),
    }),
    referenced: Object.freeze([...referenced.values()]),
  };
}

function responseSchema(sources: readonly FrozenMemoryStewardSource[]): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "candidates"],
    properties: {
      schemaVersion: { type: "integer", const: MEMORY_STEWARD_SCHEMA_VERSION },
      candidates: {
        type: "array",
        maxItems: MEMORY_STEWARD_MAX_CANDIDATES,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "operation",
            "kind",
            "derivedText",
            "sourceRefs",
            "dedupeKey",
            "replacesMemoryRecordId",
          ],
          properties: {
            operation: { type: "string", enum: [...OPERATIONS] },
            kind: { type: "string", enum: [...MEMORY_KINDS] },
            derivedText: { type: "string", minLength: 1, maxLength: MEMORY_STEWARD_MAX_DERIVED_TEXT_BYTES },
            sourceRefs: {
              type: "array",
              minItems: 1,
              maxItems: MEMORY_STEWARD_MAX_SOURCE_REFS,
              items: {
                anyOf: sources.map((source) => ({
                  type: "object",
                  additionalProperties: false,
                  required: ["sourceKind", "sourceId", "sourceRevision"],
                  properties: {
                    sourceKind: { type: "string", const: source.sourceKind },
                    sourceId: { type: "string", const: source.sourceId },
                    sourceRevision: { type: "integer", const: source.sourceRevision },
                  },
                })),
              },
            },
            dedupeKey: {
              type: "string",
              minLength: 1,
              maxLength: MEMORY_STEWARD_MAX_DEDUPE_KEY_BYTES,
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
            },
            replacesMemoryRecordId: {
              anyOf: [{
                type: "string",
                minLength: 1,
                maxLength: 256,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$",
              }, { type: "null" }],
            },
          },
        },
      },
    },
  };
}

function closedHttpError(status: number): MemoryStewardProviderError {
  if (status === 401 || status === 403) {
    return new MemoryStewardProviderError("provider_authentication", "Memory provider authentication failed");
  }
  if (status === 408 || status === 504) {
    return new MemoryStewardProviderError("provider_timeout", "Memory provider request timed out");
  }
  if (status === 429) {
    return new MemoryStewardProviderError("provider_rate_limited", "Memory provider rate limit was reached");
  }
  if (status >= 500) {
    return new MemoryStewardProviderError("provider_unavailable", "Memory provider is unavailable");
  }
  return new MemoryStewardProviderError("provider_rejected", "Memory provider rejected the request");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new MemoryStewardProviderError("provider_timeout", "Memory provider request timed out");
  }
}

async function validateCurrentSource(
  validator: MemoryStewardProviderValidators["isCurrentEligibleSource"],
  source: FrozenMemoryStewardSource,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let valid: boolean;
  try {
    valid = await validator(source, signal);
  } catch {
    throwIfAborted(signal);
    throw new MemoryStewardProviderError("authority_unavailable", "Memory source authority validation failed");
  }
  throwIfAborted(signal);
  if (!valid) throw new MemoryStewardProviderError("source_stale", "Frozen memory source was no longer eligible");
}

export function createOpenAIMemoryStewardProvider(
  options: OpenAIMemoryStewardProviderOptions,
): MemoryStewardProvider {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "") {
    throw new TypeError("OpenAI Memory endpoint must be a credential-free HTTPS URL");
  }
  const model = options.model.trim();
  if (model.length === 0) throw new TypeError("Memory model must be non-empty");
  const fetchRequest = options.testOnlyFetch ?? globalThis.fetch.bind(globalThis);

  return Object.freeze({
    id: "openai-memory-steward",
    async generate(
      input: MemoryStewardProviderInput,
      validators: MemoryStewardProviderValidators,
      callerSignal: AbortSignal,
    ): Promise<MemoryStewardPlan> {
      let secret: string | undefined;
      try {
        secret = options.secretProvider.getSecret("OPENAI_API_KEY");
      } catch {
        throw new MemoryStewardProviderError("authority_unavailable", "Memory model configuration was unavailable");
      }
      if (secret === undefined || secret.trim().length === 0) {
        throw new MemoryStewardProviderError("noauth", "Memory model authentication is not configured");
      }
      const frozenSources = validateFrozenInput(input);
      validateValidators(validators);
      const roomId = input.roomId;
      const generation = input.generation;
      const fromWatermarkExclusive = input.fromWatermarkExclusive;
      const toCorpusSeqInclusive = input.toCorpusSeqInclusive;
      const sourceValidator = validators.isCurrentEligibleSource.bind(validators);
      const memoryRecordValidator = validators.isKnownMemoryRecord.bind(validators);

      const controller = new AbortController();
      const abortFromCaller = (): void => controller.abort("caller_aborted");
      if (callerSignal.aborted) abortFromCaller();
      else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
      const timeout = setTimeout(() => controller.abort("memory_steward_timeout"), MEMORY_STEWARD_TIMEOUT_MS);
      const signal = controller.signal;

      try {
        for (const source of frozenSources) {
          await validateCurrentSource(sourceValidator, source, signal);
        }
        const promptInput = {
          roomId,
          generation,
          fromWatermarkExclusive,
          toCorpusSeqInclusive,
          sources: frozenSources.map((source) => ({
            sourceId: source.sourceId,
            sourceRevision: source.sourceRevision,
            sourceKind: source.sourceKind,
            corpusSeq: source.corpusSeq,
            content: source.content,
          })),
        };
        let requestBody: string;
        try {
          requestBody = encodeNoRetentionOpenAIRequest({
            adapterId: "openai-memory-steward",
            modelId: model,
            maxBytes: MEMORY_STEWARD_MAX_REQUEST_BYTES,
            body: {
              model,
              store: false,
              input: [{
                role: "user",
                content: [{
                  type: "input_text",
                  text: "Return only schemaVersion 1 room-memory candidates supported by the supplied frozen sources. " +
                    "Never return authority, confirmer, tool, path, URL, secret, or reasoning fields. " +
                    `Frozen batch:\n${JSON.stringify(promptInput)}`,
                }],
              }],
              text: {
                format: {
                  type: "json_schema",
                  name: "room_memory_steward_plan_v1",
                  strict: true,
                  schema: responseSchema(frozenSources),
                },
              },
            },
          });
        } catch {
          invalidInput();
        }
        throwIfAborted(signal);

        let response: Response;
        try {
          response = await fetchRequest(endpoint.toString(), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${secret}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: requestBody,
            signal,
            redirect: "error",
          });
        } catch {
          if (signal.aborted) {
            throw new MemoryStewardProviderError("provider_timeout", "Memory provider request timed out");
          }
          throw new MemoryStewardProviderError(
            "provider_unavailable",
            "Memory provider request could not be completed",
          );
        }
        if (!response.ok) {
          await cancelRejectedResponse(response);
          throw closedHttpError(response.status);
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/json") {
          await cancelRejectedResponse(response);
          throw new MemoryStewardProviderError(
            "provider_malformed",
            "Memory provider response content type was rejected",
          );
        }

        let envelope: unknown;
        try {
          envelope = parseBoundedJson(await readBoundedBody(response), MEMORY_STEWARD_MAX_OUTPUT_BYTES);
        } catch (error: unknown) {
          if (error instanceof MemoryStewardProviderError) throw error;
          throw new MemoryStewardProviderError("provider_malformed", "Memory provider response JSON was invalid");
        }
        const outputText = extractSingularOutputText(envelope);
        let parsedPlan: unknown;
        try {
          parsedPlan = parseBoundedJson(encoder.encode(outputText), MEMORY_STEWARD_MAX_OUTPUT_BYTES);
        } catch {
          throw new MemoryStewardProviderError("provider_malformed", "Memory provider plan JSON was invalid");
        }
        const { plan, referenced } = validatePlan(parsedPlan, frozenSources);
        for (const source of referenced) {
          await validateCurrentSource(sourceValidator, source, signal);
        }
        for (const candidate of plan.candidates) {
          if (candidate.replacesMemoryRecordId === null) continue;
          let known: boolean;
          try {
            known = await memoryRecordValidator({
              roomId,
              memoryRecordId: candidate.replacesMemoryRecordId,
              kind: candidate.kind,
            }, signal);
          } catch {
            throwIfAborted(signal);
            throw new MemoryStewardProviderError(
              "authority_unavailable",
              "Memory record authority validation failed",
            );
          }
          throwIfAborted(signal);
          if (!known) malformedOutput();
        }
        return plan;
      } finally {
        clearTimeout(timeout);
        callerSignal.removeEventListener("abort", abortFromCaller);
      }
    },
  });
}
