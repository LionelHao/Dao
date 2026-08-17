import { describe, expect, it, vi } from "vitest";
import type { RouterProviderInput } from "@native-im/core";
import { createOpenAIRouterProvider } from "./openai-router-provider.js";

const input: RouterProviderInput = {
  purpose: "route_decision",
  roomId: "room-1",
  sourceMessageId: "message-1",
  message: { authorId: "human-1", authorKind: "human", summary: "migration risk" },
  roomPhase: "discussion",
  agents: [{
    agentId: "agent-1", participation: "active", role: "agent",
    capabilities: ["review.read"], calibrationScore: 0, hasBall: false,
  }],
  topic: {
    topicKey: "topic-v1:test", embeddingModelVersion: "dao-topic-embedding-v1",
    windowSize: 8, cosineThreshold: 0.82,
  },
  limits: { timeoutMs: 1_000, maxCandidates: 1, maxOutputBytes: 65_536 },
};

function responsePlan(plan: unknown): Response {
  return new Response(JSON.stringify({
    output: [{ content: [{ type: "output_text", text: JSON.stringify(plan) }] }],
  }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

describe("production OpenAI RouterProvider", () => {
  it("sends store:false summary-only input and parses one closed plan", async () => {
    const fetchRequest = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "router-model", store: false });
      expect(JSON.stringify(body)).not.toContain("visibleConversation");
      expect(JSON.stringify(body)).not.toContain("sentinel-secret");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sentinel-secret");
      return responsePlan({ candidates: [{
        agentId: "agent-1", trigger: "risk", order: 1,
        reasonCode: "risk_detected", reasonText: "migration risk",
      }] });
    });
    const provider = createOpenAIRouterProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "router-model",
      secretProvider: { getSecret: () => "sentinel-secret" },
      fetch: fetchRequest,
    });
    await expect(provider.decide(input, new AbortController().signal)).resolves.toEqual({
      candidates: [{
        agentId: "agent-1", trigger: "risk", order: 1,
        reasonCode: "risk_detected", reasonText: "migration risk",
      }],
    });
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it("fails closed with zero fetch calls when the server-side secret is missing", async () => {
    const fetchRequest = vi.fn();
    const provider = createOpenAIRouterProvider({
      endpoint: "https://api.openai.com/v1/responses",
      model: "router-model",
      secretProvider: { getSecret: () => undefined },
      fetch: fetchRequest,
    });
    await expect(provider.decide(input, new AbortController().signal)).rejects.toMatchObject({
      code: "provider_failure",
      message: "Router model authentication is not configured",
    });
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it("rejects malformed, duplicate, and extra-field candidates", async () => {
    const malformed = [
      { candidates: [{ agentId: "agent-1", trigger: "risk", order: 1, reasonCode: "risk_detected", reasonText: "risk", extra: true }] },
      { candidates: [
        { agentId: "agent-1", trigger: "risk", order: 1, reasonCode: "risk_detected", reasonText: "risk" },
        { agentId: "agent-1", trigger: "domain", order: 2, reasonCode: "domain_match", reasonText: "domain" },
      ] },
    ];
    for (const plan of malformed) {
      const provider = createOpenAIRouterProvider({
        endpoint: "https://api.openai.com/v1/responses",
        model: "router-model",
        secretProvider: { getSecret: () => "secret" },
        fetch: async () => responsePlan(plan),
      });
      await expect(provider.decide(input, new AbortController().signal)).rejects.toMatchObject({
        code: "provider_malformed",
      });
    }
  });

  it("rejects a non-JSON or oversized provider response without persisting its body", async () => {
    for (const response of [
      new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response("x".repeat(65_537), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]) {
      const provider = createOpenAIRouterProvider({
        endpoint: "https://api.openai.com/v1/responses",
        model: "router-model",
        secretProvider: { getSecret: () => "secret" },
        fetch: async () => response,
      });
      await expect(provider.decide(input, new AbortController().signal)).rejects.toMatchObject({
        code: "provider_malformed",
      });
    }
  });
});
