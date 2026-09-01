import { describe, expect, it } from "vitest";
import {
  PROVIDER_ADAPTER_SECURITY_INVENTORY,
  ProviderSecurityPolicyError,
  createProviderSecurityDisclosure,
  encodeNoRetentionOpenAIRequest,
} from "./provider-security-policy.js";

describe("FT-14 closed Provider no-retention inventory", () => {
  it("enumerates every production OpenAI adapter with fixed Provider/model and bounded bodies", () => {
    expect(PROVIDER_ADAPTER_SECURITY_INVENTORY).toEqual([
      expect.objectContaining({
        adapterId: "openai-memory-steward",
        inputAuthority: "current_eligible_frozen_sources",
        requestRetention: "store_false",
        fallbackPolicy: "none",
      }),
      expect.objectContaining({
        adapterId: "openai-responses",
        inputAuthority: "frozen_compiled_snapshot",
        requestRetention: "store_false",
        fallbackPolicy: "none",
      }),
      expect.objectContaining({
        adapterId: "openai-router",
        inputAuthority: "summary_only_route_input",
        requestRetention: "store_false",
        fallbackPolicy: "none",
      }),
    ]);
    for (const descriptor of PROVIDER_ADAPTER_SECURITY_INVENTORY) {
      expect(descriptor).toMatchObject({
        providerId: "openai-responses",
        modelPolicy: "fixed_at_startup",
        requestRetention: "store_false",
        rawBodyLogging: "forbidden",
        headerLogging: "forbidden",
        hiddenReasoningPersistence: "forbidden",
        fallbackPolicy: "none",
        automaticModelSwitch: false,
      });
      expect(descriptor.maxRequestBytes).toBeGreaterThan(0);
      expect(descriptor.maxResponseBytes).toBeGreaterThan(0);
    }
  });

  it("encodes only finite bounded JSON with mandatory store:false and no credential-shaped field", () => {
    expect(encodeNoRetentionOpenAIRequest({
      adapterId: "openai-router",
      modelId: "gpt-5",
      body: { model: "gpt-5", store: false, input: [] },
      maxBytes: 128 * 1_024,
    })).toBe('{"model":"gpt-5","store":false,"input":[]}');

    for (const body of [
      { model: "gpt-5", store: true, input: [] },
      { model: "gpt-5", input: [] },
      { model: "other", store: false, input: [] },
      { model: "gpt-5", store: false, previous_response_id: "response-1", input: [] },
      { model: "gpt-5", store: false, input: [], authorization: "test-only-canary" },
      { model: "gpt-5", store: false, input: [{ apiKey: "test-only-canary" }] },
      { model: "gpt-5", store: false, input: [], temperature: Number.NaN },
    ]) {
      expect(() => encodeNoRetentionOpenAIRequest({
        adapterId: "openai-router", modelId: "gpt-5", body, maxBytes: 128 * 1_024,
      })).toThrow(ProviderSecurityPolicyError);
    }
    expect(() => encodeNoRetentionOpenAIRequest({
      adapterId: "openai-router",
      modelId: "gpt-5",
      body: { model: "gpt-5", store: false, input: ["x".repeat(1024)] },
      maxBytes: 64,
    })).toThrow(ProviderSecurityPolicyError);
  });

  it("builds the user-visible disclosure without internal credential metadata", () => {
    const disclosure = createProviderSecurityDisclosure({
      modelId: "gpt-5",
      readiness: "ready",
      disclosureRevision: 7,
      disclosedAt: "2026-08-31T12:00:00.000Z",
    });
    expect(disclosure).toEqual({
      providerId: "openai-responses",
      modelId: "gpt-5",
      readiness: "ready",
      retentionDisabled: true,
      selectionPolicy: "server-managed-single",
      disclosureRevision: 7,
      disclosedAt: "2026-08-31T12:00:00.000Z",
    });
    expect(JSON.stringify(disclosure)).not.toMatch(
      /generation|keyVersion|credential|secret|endpoint|path|token/i,
    );
  });
});
