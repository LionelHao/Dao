import { describe, expect, it } from "vitest";
import type { RouterPlan } from "@native-im/core";
import { assignTopicKey, evaluateRoutePlan, type RouteDecisionInput } from "./route-decision.js";

const now = Date.parse("2026-08-17T12:00:00.000Z");

function input(overrides: Partial<RouteDecisionInput> = {}): RouteDecisionInput {
  return {
    routeJobId: "route-1",
    roomId: "room-1",
    sourceMessageId: "message-1",
    sourceAuthorKind: "agent",
    routeAttempt: 1,
    now,
    roomPhase: "discussion",
    topicKey: "topic-1",
    agents: [
      { agentId: "direct", participation: "on-mention", calibrationScore: 0, hasBall: false },
      { agentId: "mention", participation: "on-mention", calibrationScore: 0, hasBall: false },
      { agentId: "active", participation: "active", calibrationScore: 0, hasBall: false },
    ],
    directMentionAgentIds: [],
    structuredHelpAgentIds: [],
    recentHumanMessageTimes: [],
    consecutiveAgentRounds: 0,
    cooldownByAgentId: new Map(),
    providerPlan: { candidates: [] },
    ...overrides,
  };
}

describe("single RouteJob deterministic decision layer", () => {
  it("merges direct mention before structured help and provider candidates without duplicates", () => {
    const plan: RouterPlan = { candidates: [
      { agentId: "active", trigger: "risk", order: 1, reasonCode: "risk_detected", reasonText: "risk" },
      { agentId: "mention", trigger: "structured_mention", order: 2, reasonCode: "structured_help", reasonText: "provider duplicate" },
    ] };
    const result = evaluateRoutePlan(input({
      directMentionAgentIds: ["direct", "mention"],
      structuredHelpAgentIds: ["mention"],
      providerPlan: plan,
    }));
    expect(result.intents.map((intent) => [intent.targetAgentId, intent.kind, intent.priority]))
      .toEqual([
        ["direct", "direct_mention", 1],
        ["mention", "direct_mention", 1],
        ["active", "routed_candidate", 3],
      ]);
    expect(new Set(result.intents.map((intent) => intent.targetAgentId)).size).toBe(3);
  });

  it("excludes on-mention from proactive routing while preserving a trusted structured target", () => {
    const providerPlan: RouterPlan = { candidates: [
      { agentId: "mention", trigger: "domain", order: 2, reasonCode: "domain_match", reasonText: "domain" },
      { agentId: "active", trigger: "domain", order: 3, reasonCode: "domain_match", reasonText: "domain" },
    ] };
    const result = evaluateRoutePlan(input({ structuredHelpAgentIds: ["mention"], providerPlan }));
    expect(result.intents.map((intent) => intent.targetAgentId)).toEqual(["mention", "active"]);
    expect(result.judgments.find((value) => value.agentId === "direct")).toMatchObject({
      outcome: "no_response_needed", reasonCode: "provider_omitted",
    });
  });

  it("accepts structured help only from an Agent-authored source", () => {
    const result = evaluateRoutePlan(input({
      sourceAuthorKind: "human",
      structuredHelpAgentIds: ["mention"],
      providerPlan: { candidates: [{
        agentId: "active",
        trigger: "structured_mention",
        order: 1,
        reasonCode: "structured_help",
        reasonText: "untrusted human-origin structured help",
      }] },
    }));

    expect(result.intents).toEqual([]);
    expect(result.judgments.find((value) => value.agentId === "mention"))
      .toMatchObject({ outcome: "no_response_needed", reasonCode: "provider_omitted" });
    expect(result.judgments.find((value) => value.agentId === "active"))
      .toMatchObject({ outcome: "suppressed", reasonCode: "not_selected" });
  });

  it("suppresses domain at the third human message in 60 seconds but score +3 pierces only that soft gate", () => {
    const providerPlan: RouterPlan = { candidates: [
      { agentId: "active", trigger: "domain", order: 1, reasonCode: "domain_match", reasonText: "domain" },
    ] };
    const burst = [now - 60_000, now - 20_000, now];
    expect(evaluateRoutePlan(input({ recentHumanMessageTimes: burst, providerPlan })).judgments[2])
      .toMatchObject({ outcome: "suppressed", reasonCode: "human_burst_soft_suppression" });
    const agents = input().agents.map((agent) => agent.agentId === "active"
      ? { ...agent, calibrationScore: 3 }
      : agent);
    expect(evaluateRoutePlan(input({ agents, recentHumanMessageTimes: burst, providerPlan })).judgments[2])
      .toMatchObject({ outcome: "will_respond", reasonCode: "domain_match" });
  });

  it("keeps risk, structured mention, and ball triggers during execution phase", () => {
    const providerPlan: RouterPlan = { candidates: [
      { agentId: "active", trigger: "domain", order: 1, reasonCode: "domain_match", reasonText: "domain" },
    ] };
    const agents = input().agents.map((agent) => agent.agentId === "active" ? { ...agent, hasBall: true } : agent);
    const result = evaluateRoutePlan(input({
      roomPhase: "execution", agents, structuredHelpAgentIds: ["mention"], providerPlan,
    }));
    expect(result.intents.map((intent) => intent.targetAgentId)).toEqual(["mention", "active"]);
    expect(result.intents.find((intent) => intent.targetAgentId === "active")?.reasonCode).toBe("ball_due");
  });

  it("applies 10 minute cooldown, three agent rounds, and negative calibration to proactive candidates", () => {
    const providerPlan: RouterPlan = { candidates: [
      { agentId: "active", trigger: "domain", order: 1, reasonCode: "domain_match", reasonText: "domain" },
    ] };
    expect(evaluateRoutePlan(input({
      providerPlan, cooldownByAgentId: new Map([["active", now - 10 * 60_000 + 1]]),
    })).judgments[2]).toMatchObject({ reasonCode: "cooldown" });
    expect(evaluateRoutePlan(input({ providerPlan, consecutiveAgentRounds: 3 })).judgments[2])
      .toMatchObject({ reasonCode: "agent_round_limit" });
    const agents = input().agents.map((agent) => agent.agentId === "active"
      ? { ...agent, calibrationScore: -3 }
      : agent);
    expect(evaluateRoutePlan(input({ providerPlan, agents })).judgments[2])
      .toMatchObject({ reasonCode: "calibration_suppressed" });
  });

  it("keeps the 60-second, 10-minute, and three-round boundaries deterministic", () => {
    const domain: RouterPlan = { candidates: [{
      agentId: "active", trigger: "domain", order: 1,
      reasonCode: "domain_match", reasonText: "domain",
    }] };
    expect(evaluateRoutePlan(input({
      providerPlan: domain,
      recentHumanMessageTimes: [now - 60_000, now - 1],
    })).judgments[2]).toMatchObject({ outcome: "will_respond" });
    expect(evaluateRoutePlan(input({
      providerPlan: domain,
      recentHumanMessageTimes: [now - 60_001, now - 30_000, now],
    })).judgments[2]).toMatchObject({ outcome: "will_respond" });
    expect(evaluateRoutePlan(input({
      providerPlan: domain,
      recentHumanMessageTimes: [now - 60_000, now - 30_000, now],
    })).judgments[2]).toMatchObject({ reasonCode: "human_burst_soft_suppression" });
    expect(evaluateRoutePlan(input({
      providerPlan: domain,
      cooldownByAgentId: new Map([["active", now - 10 * 60_000]]),
    })).judgments[2]).toMatchObject({ outcome: "will_respond" });
    expect(evaluateRoutePlan(input({ providerPlan: domain, consecutiveAgentRounds: 2 })).judgments[2])
      .toMatchObject({ outcome: "will_respond" });
    expect(evaluateRoutePlan(input({ providerPlan: domain, consecutiveAgentRounds: 3 })).judgments[2])
      .toMatchObject({ reasonCode: "agent_round_limit" });
  });

  it("persists one closed judgment for every snapshotted agent on provider failure or omission", () => {
    const failed = evaluateRoutePlan(input({ providerFailureCode: "provider_timeout" }));
    expect(failed.judgments).toHaveLength(3);
    expect(failed.judgments.every((value) => value.reasonCode === "provider_failed")).toBe(true);
    const omitted = evaluateRoutePlan(input({
      directMentionAgentIds: ["direct"], providerFailureCode: "provider_malformed",
    }));
    expect(omitted.judgments.find((value) => value.agentId === "direct")?.reasonCode).toBe("direct_mention");
    expect(omitted.judgments.filter((value) => value.reasonCode === "provider_failed")).toHaveLength(2);
  });

  it("assigns stable versioned topics from only eight visible summaries", () => {
    const first = assignTopicKey("database migration safety", []);
    const same = assignTopicKey("database migration safety", [{ topicKey: first.topicKey, summary: "database migration safety" }]);
    const different = assignTopicKey("illustrated plant animation", [{ topicKey: first.topicKey, summary: "database migration safety" }]);
    expect(first).toMatchObject({ embeddingModelVersion: "dao-topic-embedding-v1", windowSize: 8, cosineThreshold: 0.82 });
    expect(same.topicKey).toBe(first.topicKey);
    expect(different.topicKey).not.toBe(first.topicKey);
    expect(assignTopicKey("database migration safety", Array.from({ length: 9 }, (_, index) => ({
      topicKey: `old-${index}`, summary: index === 0 ? "database migration safety" : `unrelated ${index}`,
    }))).topicKey).not.toBe("old-0");
  });
});
