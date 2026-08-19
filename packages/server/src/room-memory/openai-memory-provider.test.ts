import { describe, expect, it, vi } from "vitest";
import type {
  FrozenMemoryStewardSource,
  MemoryStewardProviderInput,
  MemoryStewardProviderValidators,
} from "./contracts.js";
import { MemoryStewardProviderError } from "./contracts.js";
import { createOpenAIMemoryStewardProvider } from "./openai-memory-provider.js";

const source = (overrides: Partial<FrozenMemoryStewardSource> = {}): FrozenMemoryStewardSource => ({
  roomId: "room-1",
  sourceId: "message:message-1",
  sourceRevision: 1,
  sourceKind: "message",
  corpusSeq: 1,
  eligibility: "eligible",
  content: "The launch decision is Friday.",
  ...overrides,
});

const input = (overrides: Partial<MemoryStewardProviderInput> = {}): MemoryStewardProviderInput => ({
  purpose: "room_memory_steward",
  roomId: "room-1",
  generation: 1,
  fromWatermarkExclusive: 0,
  toCorpusSeqInclusive: 1,
  sources: [source()],
  ...overrides,
});

const validators = (overrides: Partial<MemoryStewardProviderValidators> = {}): MemoryStewardProviderValidators => ({
  isCurrentEligibleSource: vi.fn(async () => true),
  isKnownMemoryRecord: vi.fn(async () => true),
  ...overrides,
});

const plan = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  candidates: [{
    operation: "create",
    kind: "context",
    derivedText: "Launch is scheduled for Friday.",
    sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 1 }],
    dedupeKey: "launch-date",
    replacesMemoryRecordId: null,
  }],
  ...overrides,
});

const responsePlan = (value: unknown): Response => new Response(JSON.stringify({
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
}), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });

const provider = (
  fetchForTest: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  secret = "server-secret",
) => createOpenAIMemoryStewardProvider({
  endpoint: "https://api.openai.com/v1/responses",
  model: "memory-model",
  secretProvider: { getSecret: () => secret },
  testOnlyFetch: fetchForTest,
});

describe("production OpenAI MemoryStewardProvider", () => {
  it("sends one bounded store:false strict json_schema request and returns a frozen closed plan", async () => {
    const fetchForTest = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({ model: "memory-model", store: false });
      expect(request).not.toHaveProperty("tools");
      expect(request).not.toHaveProperty("reasoning");
      expect(request).not.toHaveProperty("url");
      expect(JSON.stringify(request)).not.toContain("server-secret");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret");
      const text = request.text as { format: Record<string, unknown> };
      expect(text.format).toMatchObject({
        type: "json_schema",
        name: "room_memory_steward_plan_v1",
        strict: true,
      });
      const schema = text.format.schema as Record<string, unknown>;
      expect(schema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["schemaVersion", "candidates"],
      });
      expect(init?.redirect).toBe("error");
      return responsePlan(plan());
    });
    const sourceValidator = vi.fn(async () => true);
    const result = await provider(fetchForTest).generate(
      input(),
      validators({ isCurrentEligibleSource: sourceValidator }),
      new AbortController().signal,
    );

    expect(result).toEqual(plan());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(result.candidates[0]?.sourceRefs)).toBe(true);
    expect(fetchForTest).toHaveBeenCalledTimes(1);
    expect(sourceValidator).toHaveBeenCalledTimes(2);
  });

  it("fails noauth before validation or fetch and has no fixture fallback", async () => {
    const fetchForTest = vi.fn();
    const sourceValidator = vi.fn(async () => true);
    const noauthProvider = createOpenAIMemoryStewardProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "memory-model",
      secretProvider: { getSecret: () => undefined },
      testOnlyFetch: fetchForTest,
    });
    await expect(noauthProvider.generate(
      input(),
      validators({ isCurrentEligibleSource: sourceValidator }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "noauth", retryable: false });
    expect(sourceValidator).not.toHaveBeenCalled();
    expect(fetchForTest).not.toHaveBeenCalled();
  });

  it("closes a SecretProvider failure without leaking its raw error", async () => {
    const fetchForTest = vi.fn();
    const secretFailure = createOpenAIMemoryStewardProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "memory-model",
      secretProvider: { getSecret: () => { throw new Error("secret-provider-sentinel"); } },
      testOnlyFetch: fetchForTest,
    });
    await expect(secretFailure.generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({
      code: "authority_unavailable",
      message: "Memory model configuration was unavailable",
    });
    expect(fetchForTest).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-Room", input({ sources: [source({ roomId: "room-2" })] })],
    ["ineligible", input({ sources: [source({ eligibility: "excluded_recalled" as "eligible" })] })],
    ["stale revision", input({ sources: [source({ sourceRevision: 0 })] })],
    ["extra source authority", input({ sources: [{ ...source(), tool: "shell" } as FrozenMemoryStewardSource] })],
  ])("rejects an invalid frozen %s input with zero fetch calls", async (_name, badInput) => {
    const fetchForTest = vi.fn();
    await expect(provider(fetchForTest).generate(
      badInput,
      validators(),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "input_invalid" });
    expect(fetchForTest).not.toHaveBeenCalled();
  });

  it("fails stale before fetch and revalidates referenced sources after the response", async () => {
    const beforeFetch = vi.fn(async () => false);
    const fetchForTest = vi.fn(async () => responsePlan(plan()));
    await expect(provider(fetchForTest).generate(
      input(),
      validators({ isCurrentEligibleSource: beforeFetch }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "source_stale" });
    expect(fetchForTest).not.toHaveBeenCalled();

    const afterResponse = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(provider(fetchForTest).generate(
      input(),
      validators({ isCurrentEligibleSource: afterResponse }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "source_stale" });
    expect(fetchForTest).toHaveBeenCalledTimes(1);
  });

  it("defensively snapshots the frozen batch before an authority callback can mutate caller objects", async () => {
    const mutableSource = source();
    const mutableInput = input({ sources: [mutableSource] });
    const sourceValidator = vi.fn(async (validated: FrozenMemoryStewardSource) => {
      expect(validated.roomId).toBe("room-1");
      (mutableSource as { roomId: string }).roomId = "room-mutated";
      (mutableSource as { content: string }).content = "mutated content";
      (mutableInput as { roomId: string }).roomId = "room-mutated";
      return true;
    });
    const fetchForTest = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      expect(body).toContain("room-1");
      expect(body).toContain("The launch decision is Friday.");
      expect(body).not.toContain("room-mutated");
      expect(body).not.toContain("mutated content");
      return responsePlan(plan());
    });
    await expect(provider(fetchForTest).generate(
      mutableInput,
      validators({ isCurrentEligibleSource: sourceValidator }),
      new AbortController().signal,
    )).resolves.toEqual(plan());
    expect(sourceValidator.mock.calls.every(([validated]) => validated.roomId === "room-1")).toBe(true);
    expect(sourceValidator.mock.calls.every(([validated]) => Object.isFrozen(validated))).toBe(true);
  });

  it.each([
    ["unknown source", plan({ candidates: [{
      operation: "create", kind: "context", derivedText: "x",
      sourceRefs: [{ sourceId: "message:unknown", sourceRevision: 1 }],
      dedupeKey: "unknown", replacesMemoryRecordId: null,
    }] })],
    ["stale source revision", plan({ candidates: [{
      operation: "create", kind: "context", derivedText: "x",
      sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 2 }],
      dedupeKey: "stale", replacesMemoryRecordId: null,
    }] })],
    ["unknown field", plan({ candidates: [{
      operation: "create", kind: "context", derivedText: "x",
      sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 1 }],
      dedupeKey: "extra", replacesMemoryRecordId: null, reasoning: "hidden",
    }] })],
    ["duplicate candidate", plan({ candidates: [
      {
        operation: "create", kind: "context", derivedText: "x",
        sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 1 }],
        dedupeKey: "same-key", replacesMemoryRecordId: null,
      },
      {
        operation: "create", kind: "context", derivedText: "y",
        sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 1 }],
        dedupeKey: "same-key", replacesMemoryRecordId: null,
      },
    ] })],
  ])("rejects a closed output with %s", async (_name, badPlan) => {
    await expect(provider(async () => responsePlan(badPlan)).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_malformed" });
  });

  it.each(["authority", "tool", "path", "url", "secret", "reasoning"])(
    "rejects the forbidden extra output field %s",
    async (field) => {
      const candidate = {
        operation: "create", kind: "context", derivedText: "x",
        sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 1 }],
        dedupeKey: `extra-${field}`, replacesMemoryRecordId: null,
        [field]: "forbidden",
      };
      await expect(provider(async () => responsePlan(plan({ candidates: [candidate] }))).generate(
        input(), validators(), new AbortController().signal,
      )).rejects.toMatchObject({ code: "provider_malformed" });
    },
  );

  it.each([
    "Open https://example.com/private",
    "Read /Users/alice/.ssh/id_ed25519",
    "Read C:\\Users\\alice\\secret.txt",
    "Use Bearer provider-token-value",
    "The key is sk-proj-1234567890abcdef",
    "Run rm -rf ./workspace",
    "<reasoning>hidden chain of thought</reasoning>",
  ])("rejects forbidden authority/tool/path/URL/secret/reasoning content inside derived text", async (derivedText) => {
    const candidate = {
      operation: "create", kind: "context", derivedText,
      sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 1 }],
      dedupeKey: "forbidden-derived-content", replacesMemoryRecordId: null,
    };
    await expect(provider(async () => responsePlan(plan({ candidates: [candidate] }))).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_malformed" });
  });

  it("rejects duplicate JSON keys in both the Responses envelope and the closed plan", async () => {
    const duplicateEnvelope = new Response(
      '{"output":[],"output":[]}',
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(provider(async () => duplicateEnvelope).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_malformed" });

    const duplicatePlan = new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text:
        '{"schemaVersion":1,"candidates":[],"candidates":[]}' }] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    await expect(provider(async () => duplicatePlan).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_malformed" });
  });

  it("rejects a transport tool call while safely ignoring a transport reasoning item", async () => {
    const toolResponse = new Response(JSON.stringify({
      output: [
        { type: "reasoning", encrypted_content: "opaque" },
        { type: "function_call", name: "shell", arguments: "{}" },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(plan()) }] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
    await expect(provider(async () => toolResponse).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_malformed" });

    const reasoningResponse = new Response(JSON.stringify({
      output: [
        { type: "reasoning", encrypted_content: "opaque" },
        { type: "message", content: [{ type: "output_text", text: JSON.stringify(plan()) }] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
    await expect(provider(async () => reasoningResponse).generate(
      input(), validators(), new AbortController().signal,
    )).resolves.toEqual(plan());
  });

  it("enforces candidate, derived text, source ref, and total output byte limits", async () => {
    const candidate = {
      operation: "create", kind: "context", derivedText: "x",
      sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 1 }],
      dedupeKey: "bounded", replacesMemoryRecordId: null,
    };
    const malformed = [
      plan({ candidates: Array.from({ length: 33 }, (_, index) => ({ ...candidate, dedupeKey: `key-${index}` })) }),
      plan({ candidates: [{ ...candidate, derivedText: "界".repeat(1_366) }] }),
      plan({ candidates: [{ ...candidate, sourceRefs: Array.from({ length: 17 }, () => candidate.sourceRefs[0]) }] }),
    ];
    for (const value of malformed) {
      await expect(provider(async () => responsePlan(value)).generate(
        input(), validators(), new AbortController().signal,
      )).rejects.toMatchObject({ code: "provider_malformed" });
    }

    const oversized = new Response("x".repeat(65_537), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(provider(async () => oversized).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_malformed" });
  });

  it("accepts the exact candidate and UTF-8 derived text bounds", async () => {
    const exact = plan({ candidates: Array.from({ length: 32 }, (_, index) => ({
      operation: "create",
      kind: "context",
      derivedText: index === 0 ? `${"界".repeat(1_365)}a` : `candidate ${index}`,
      sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 1 }],
      dedupeKey: `exact-${index}`,
      replacesMemoryRecordId: null,
    })) });
    await expect(provider(async () => responsePlan(exact)).generate(
      input(), validators(), new AbortController().signal,
    )).resolves.toMatchObject({ schemaVersion: 1, candidates: expect.arrayContaining([
      expect.objectContaining({ derivedText: `${"界".repeat(1_365)}a` }),
    ]) });
  });

  it("enforces per-source, total content, and serialized request byte limits before fetch", async () => {
    const cases = [
      input({ sources: [source({ content: "x".repeat(65_537) })] }),
      input({
        toCorpusSeqInclusive: 5,
        sources: Array.from({ length: 5 }, (_, index) => source({
          sourceId: `message:message-${index}`,
          corpusSeq: index + 1,
          content: "x".repeat(60_000),
        })),
      }),
      input({
        toCorpusSeqInclusive: 4,
        sources: Array.from({ length: 4 }, (_, index) => source({
          sourceId: `message:escaped-${index}`,
          corpusSeq: index + 1,
          content: "\\".repeat(65_536),
        })),
      }),
    ];
    for (const badInput of cases) {
      const fetchForTest = vi.fn();
      await expect(provider(fetchForTest).generate(
        badInput, validators(), new AbortController().signal,
      )).rejects.toMatchObject({ code: "input_invalid" });
      expect(fetchForTest).not.toHaveBeenCalled();
    }
  });

  it("rejects an unknown replacement memory record through the authority validator", async () => {
    const replacementPlan = plan({ candidates: [{
      operation: "replace", kind: "context", derivedText: "updated",
      sourceRefs: [{ sourceId: "message:message-1", sourceRevision: 1 }],
      dedupeKey: "launch-date", replacesMemoryRecordId: "memory-unknown",
    }] });
    const targetValidator = vi.fn(async () => false);
    await expect(provider(async () => responsePlan(replacementPlan)).generate(
      input(),
      validators({ isKnownMemoryRecord: targetValidator }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_malformed" });
    expect(targetValidator).toHaveBeenCalledWith({
      roomId: "room-1", memoryRecordId: "memory-unknown", kind: "context",
    }, expect.any(AbortSignal));
  });

  it.each([
    [401, "provider_authentication", false],
    [403, "provider_authentication", false],
    [408, "provider_timeout", true],
    [429, "provider_rate_limited", true],
    [500, "provider_unavailable", true],
    [503, "provider_unavailable", true],
    [400, "provider_rejected", false],
  ])("maps HTTP %i without reading error headers or body", async (status, code, retryable) => {
    const response = {
      ok: false,
      status,
      get headers(): Headers { throw new Error("headers must not be read"); },
      get body(): ReadableStream<Uint8Array> { throw new Error("body must not be read"); },
    } as Response;
    await expect(provider(async () => response).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({ code, retryable });
  });

  it("maps network and abort failures without exposing the adapter error", async () => {
    const sentinel = "raw-provider-secret-error";
    await expect(provider(async () => { throw new Error(sentinel); }).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({
      code: "provider_unavailable",
      message: "Memory provider request could not be completed",
    });

    const controller = new AbortController();
    const generate = provider(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(sentinel)), { once: true });
    })).generate(input(), validators(), controller.signal);
    controller.abort();
    await expect(generate).rejects.toMatchObject({ code: "provider_timeout" });
  });

  it("rejects fatal UTF-8 in a successful response as closed malformed output", async () => {
    const response = new Response(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(provider(async () => response).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toMatchObject({ code: "provider_malformed" });
  });

  it("rejects credential-bearing endpoints and empty models synchronously", () => {
    expect(() => createOpenAIMemoryStewardProvider({
      endpoint: "http://api.openai.com/v1/responses", model: "model",
      secretProvider: { getSecret: () => "secret" },
    })).toThrow(TypeError);
    expect(() => createOpenAIMemoryStewardProvider({
      endpoint: "https://user:password@api.openai.com/v1/responses", model: "model",
      secretProvider: { getSecret: () => "secret" },
    })).toThrow(TypeError);
    expect(() => createOpenAIMemoryStewardProvider({
      endpoint: "https://api.openai.com/v1/responses", model: "   ",
      secretProvider: { getSecret: () => "secret" },
    })).toThrow(TypeError);
  });

  it("exports only closed safe errors", async () => {
    await expect(provider(async () => responsePlan({ schemaVersion: 1, candidates: "bad" })).generate(
      input(), validators(), new AbortController().signal,
    )).rejects.toBeInstanceOf(MemoryStewardProviderError);
  });
});
