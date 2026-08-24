import { createHash } from "node:crypto";
import type {
  RouteInvocationIntent,
  RouteJudgment,
  RouteReasonCode,
  RouteRoomPhase,
  RouterPlan,
} from "@native-im/core";

export interface RouteDecisionAgent {
  readonly agentId: string;
  readonly participation: "active" | "on-mention";
  readonly calibrationScore: number;
  readonly hasBall: boolean;
}

export interface RouteDecisionInput {
  readonly routeJobId: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly sourceAuthorKind: "human" | "agent";
  readonly routeAttempt: 1 | 2 | 3;
  readonly now: number;
  readonly roomPhase: RouteRoomPhase;
  readonly topicKey: string;
  readonly agents: readonly RouteDecisionAgent[];
  readonly directMentionAgentIds: readonly string[];
  readonly structuredHelpAgentIds: readonly string[];
  readonly recentHumanMessageTimes: readonly number[];
  readonly consecutiveAgentRounds: number;
  readonly cooldownByAgentId: ReadonlyMap<string, number>;
  readonly providerPlan?: RouterPlan;
  readonly providerFailureCode?: string;
}

export interface RouteDecisionResult {
  readonly intents: readonly RouteInvocationIntent[];
  readonly judgments: readonly RouteJudgment[];
}

const minute = 60_000;

function suppression(
  input: RouteDecisionInput,
  agent: RouteDecisionAgent,
  trigger: "domain" | "risk" | "structured_mention" | "ball",
): RouteReasonCode | undefined {
  if (trigger === "ball" || trigger === "structured_mention") return undefined;
  const last = input.cooldownByAgentId.get(agent.agentId);
  if (last !== undefined && input.now - last < 10 * minute) return "cooldown";
  if (input.consecutiveAgentRounds >= 3) return "agent_round_limit";
  if (trigger === "domain") {
    if (agent.calibrationScore <= -3) return "calibration_suppressed";
    if (input.roomPhase === "execution") return "execution_phase";
    const recentHumans = input.recentHumanMessageTimes.filter((time) =>
      time >= input.now - minute && time <= input.now,
    ).length;
    if (recentHumans >= 3 && agent.calibrationScore < 3) return "human_burst_soft_suppression";
  }
  return undefined;
}

export function evaluateRoutePlan(input: RouteDecisionInput): RouteDecisionResult {
  const agents = new Map(input.agents.map((agent) => [agent.agentId, agent]));
  const selected = new Map<string, RouteInvocationIntent>();
  const suppressed = new Map<string, RouteReasonCode>();
  const add = (agentId: string, intent: RouteInvocationIntent): void => {
    if (!agents.has(agentId) || selected.has(agentId)) return;
    selected.set(agentId, intent);
  };
  for (const agentId of input.directMentionAgentIds) {
    add(agentId, {
      kind: "direct_mention", roomId: input.roomId, sourceMessageId: input.sourceMessageId,
      targetAgentId: agentId, reasonCode: "direct_mention", reasonText: "direct mandatory address", priority: 1,
    });
  }
  for (const agentId of input.sourceAuthorKind === "agent" ? input.structuredHelpAgentIds : []) {
    const agent = agents.get(agentId);
    if (agent === undefined) continue;
    add(agentId, {
      kind: "structured_help", roomId: input.roomId, sourceMessageId: input.sourceMessageId,
      targetAgentId: agentId, reasonCode: "structured_help", reasonText: "structured agent help", priority: 2,
    });
  }
  for (const agent of input.agents) {
    if (!agent.hasBall || agent.participation !== "active") continue;
    add(agent.agentId, {
      kind: "routed_candidate", roomId: input.roomId, sourceMessageId: input.sourceMessageId,
      targetAgentId: agent.agentId, reasonCode: "ball_due", reasonText: "structured ball is due", priority: 2,
    });
  }
  for (const candidate of input.providerPlan?.candidates ?? []) {
    const agent = agents.get(candidate.agentId);
    if (agent === undefined || selected.has(candidate.agentId)) continue;
    if (candidate.trigger === "structured_mention" && input.sourceAuthorKind !== "agent") {
      suppressed.set(agent.agentId, "not_selected");
      continue;
    }
    if (agent.participation === "on-mention") {
      suppressed.set(agent.agentId, "participation_on_mention");
      continue;
    }
    const reason = suppression(input, agent, candidate.trigger);
    if (reason !== undefined) {
      suppressed.set(agent.agentId, reason);
      continue;
    }
    add(agent.agentId, {
      kind: candidate.trigger === "structured_mention" ? "structured_help" : "routed_candidate",
      roomId: input.roomId, sourceMessageId: input.sourceMessageId,
      targetAgentId: candidate.agentId, reasonCode: candidate.reasonCode,
      reasonText: candidate.reasonText, priority: 3,
    });
  }
  const decidedAt = new Date(input.now).toISOString();
  const judgments = input.agents.map((agent): RouteJudgment => {
    const intent = selected.get(agent.agentId);
    const reasonCode = intent?.reasonCode ?? suppressed.get(agent.agentId) ??
      (input.providerFailureCode === undefined ? "provider_omitted" : "provider_failed");
    return {
      id: `route-judgment:${input.routeJobId}:${agent.agentId}`,
      routeJobId: input.routeJobId,
      sourceMessageId: input.sourceMessageId,
      agentId: agent.agentId,
      outcome: intent === undefined
        ? (suppressed.has(agent.agentId) ? "suppressed" : "no_response_needed")
        : "will_respond",
      reasonCode,
      reasonText: intent?.reasonText ??
        (input.providerFailureCode === undefined ? `closed route outcome: ${reasonCode}` : `closed provider failure: ${input.providerFailureCode}`),
      routeAttempt: input.routeAttempt,
      decidedAt,
    };
  });
  return { intents: [...selected.values()], judgments };
}

const dimensions = 64;

function embedding(summary: string): readonly number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const normalized = summary.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  for (const token of normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest[0]! % dimensions;
    vector[index] = (vector[index] ?? 0) + ((digest[1]! & 1) === 0 ? 1 : -1);
  }
  return vector;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const a = left[index] ?? 0; const b = right[index] ?? 0;
    dot += a * b; leftNorm += a * a; rightNorm += b * b;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

export function assignTopicKey(
  summary: string,
  recent: readonly { readonly topicKey: string; readonly summary: string }[],
): {
  readonly topicKey: string;
  readonly embeddingModelVersion: "dao-topic-embedding-v1";
  readonly windowSize: 8;
  readonly cosineThreshold: 0.82;
} {
  const current = embedding(summary);
  const visible = recent.slice(-8).reverse();
  const matched = visible.find((entry) => cosine(current, embedding(entry.summary)) >= 0.82);
  const topicKey = matched?.topicKey ?? `topic-v1:${createHash("sha256").update(JSON.stringify(current)).digest("hex").slice(0, 24)}`;
  return { topicKey, embeddingModelVersion: "dao-topic-embedding-v1", windowSize: 8, cosineThreshold: 0.82 };
}
