import { describe, expect, it } from "vitest";
import {
  isAgentExecution,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isOpenItem,
  isOpenItemAgentFailure,
  isRouteJob,
  isRouteJudgment,
  isRouterProviderInput,
  isRouterPlan,
  isSocialReaction,
} from "./collaboration.js";

describe("canonical collaboration records", () => {
  it("keeps human reads and agent judgements as closed, distinct records", () => {
    expect(isHumanReadReceipt({
      id: "read-1",
      messageId: "message-1",
      readerId: "human-1",
      readAt: "2026-08-10T00:00:00.000Z",
    })).toBe(true);
    expect(isHumanReadReceipt({
      id: "read-1",
      messageId: "message-1",
      agentId: "agent-1",
      readAt: "2026-08-10T00:00:00.000Z",
    })).toBe(false);
    expect(isHumanReadReceipt(Object.create({
      id: "read-1",
      messageId: "message-1",
      readerId: "human-1",
      readAt: "2026-08-10T00:00:00.000Z",
    }))).toBe(false);

    expect(isAgentJudgement({
      id: "judgement-1",
      messageId: "message-1",
      agentId: "agent-1",
      outcome: "suppressed",
      reason: "同话题冷却期内",
      decidedAt: "2026-08-10T00:00:00.000Z",
    })).toBe(true);
    expect(isAgentJudgement({
      id: "judgement-1",
      messageId: "message-1",
      agentId: "agent-1",
      outcome: "suppressed",
      reason: "",
      decidedAt: "2026-08-10T00:00:00.000Z",
    })).toBe(false);
  });

  it("validates open-item and execution status records without merging them", () => {
    const transferred = {
      id: "item-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      currentOwnerId: "human-3",
      content: "请确认",
      status: "transferred",
      origin: { kind: "human_mention" },
      createdAt: "2026-08-10T00:00:00.000Z",
      transferChain: [{
        fromId: "human-2",
        toId: "human-3",
        reason: "转交",
        transferredAt: "2026-08-10T00:01:00.000Z",
      }],
    } as const;
    expect(isOpenItem(transferred)).toBe(true);
    expect(isOpenItem({ ...transferred, currentOwnerId: "human-2" })).toBe(false);
    expect(isOpenItem({ ...transferred, currentOwnerId: null })).toBe(false);
    expect(isOpenItem({ ...transferred, transferChain: [] })).toBe(false);
    expect(isOpenItem({
      ...transferred,
      status: "awaiting",
      currentOwnerId: "human-2",
      transferChain: [],
    })).toBe(true);
    expect(isOpenItem({
      ...transferred,
      status: "answered",
      currentOwnerId: null,
      respondedAt: "2026-08-10T00:02:00.000Z",
    })).toBe(true);
    expect(isOpenItem({
      ...transferred,
      status: "deferred",
      currentOwnerId: null,
      respondedAt: "2026-08-10T00:02:00.000Z",
    })).toBe(true);
    expect(isOpenItem({ ...transferred, status: "answered", currentOwnerId: "human-3" })).toBe(false);
    expect(isOpenItem({ ...transferred, status: "pending_response" })).toBe(false);
    expect(isOpenItem({
      ...transferred,
      origin: {
        kind: "agent_proposal",
        proposalKind: "risk",
        sourceExecutionId: "execution-1",
        reason: "部署可能丢数据",
      },
    })).toBe(true);
    expect(isOpenItem({
      ...transferred,
      origin: { kind: "agent_proposal", proposalKind: "risk", reason: "缺少 execution" },
    })).toBe(false);
    expect(isOpenItemAgentFailure({
      id: "open-item-failure-1",
      openItemId: "item-1",
      executionId: "execution-1",
      attemptSeq: 3,
      reasonCode: "provider_timeout",
      failedAt: "2026-08-10T00:03:00.000Z",
    })).toBe(true);
    expect(isOpenItemAgentFailure({
      id: "open-item-failure-1",
      openItemId: "item-1",
      executionId: "execution-1",
      attemptSeq: 0,
      reasonCode: "provider_timeout",
      failedAt: "2026-08-10T00:03:00.000Z",
    })).toBe(false);
    expect(isAgentExecution({
      id: "execution-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      agentId: "agent-1",
      toolName: "http-json.read",
      status: "cancelled",
      actionCategory: "tool_call",
      toolDispatchPhase: "not_started",
      currentAttemptSeq: 2,
      retryCycle: 1,
      retryOrdinal: 2,
      recoveryCursor: 1,
      queuedAt: "2026-08-10T00:00:00.000Z",
      startedAt: "2026-08-10T00:00:01.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
      completedAt: "2026-08-10T00:01:00.000Z",
      cancellationReason: "requested_by_human",
    })).toBe(true);
    expect(isAgentExecution({
      id: "execution-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      agentId: "agent-1",
      toolName: "search.web",
      status: "running",
      actionCategory: "model_generation",
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      recoveryCursor: 0,
      queuedAt: "2026-08-10T00:00:00.000Z",
      startedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      result: undefined,
    })).toBe(false);
    expect(isAgentExecution({
      id: "execution-legacy-interrupted",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      agentId: "agent-1",
      toolName: "search.web",
      status: "interrupted",
      startedAt: "2026-08-10T00:00:00.000Z",
    })).toBe(false);
  });

  it("keeps social reactions and calibration signals structurally separate", () => {
    expect(isSocialReaction({
      id: "reaction-1",
      sourceMessageId: "message-human",
      actorId: "human-1",
      emoji: "🎉",
      createdAt: "2026-08-10T00:00:00.000Z",
    })).toBe(true);
    expect(isCalibrationSignal({
      id: "calibration-1",
      sourceMessageId: "message-agent",
      actorId: "human-1",
      agentId: "agent-1",
      emoji: "👎",
      createdAt: "2026-08-10T00:00:00.000Z",
    })).toBe(true);
    expect(isCalibrationSignal({
      id: "calibration-1",
      sourceMessageId: "message-agent",
      actorId: "human-1",
      agentId: "agent-1",
      emoji: "🎉",
      createdAt: "2026-08-10T00:00:00.000Z",
    })).toBe(false);
  });

  it("accepts only closed route jobs, plans, and per-agent final judgments", () => {
    expect(isRouteJob({
      id: "route-1", roomId: "room-1", sourceMessageId: "message-1",
      status: "running", currentAttempt: 2, topicKey: "topic-v1:abc",
      embeddingModelVersion: "dao-topic-embedding-v1", windowSize: 8,
      cosineThreshold: 0.82, roomPhase: "discussion",
      createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:01.000Z",
    })).toBe(true);
    expect(isRouteJob({
      id: "route-1", roomId: "room-1", sourceMessageId: "message-1",
      status: "running", currentAttempt: 2, topicKey: "topic-v1:abc",
      embeddingModelVersion: "changed-silently", windowSize: 9,
      cosineThreshold: 0.7, roomPhase: "discussion",
      createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:01.000Z",
    })).toBe(false);
    expect(isRouterPlan({ candidates: [{
      agentId: "agent-1", trigger: "risk", order: 1,
      reasonCode: "risk_detected", reasonText: "发现权限风险",
    }] })).toBe(true);
    expect(isRouterPlan({ candidates: [
      { agentId: "agent-1", trigger: "risk", order: 1, reasonCode: "risk_detected", reasonText: "one" },
      { agentId: "agent-1", trigger: "domain", order: 2, reasonCode: "domain_match", reasonText: "two" },
    ] })).toBe(false);
    expect(isRouteJudgment({
      id: "route-judgment-1", routeJobId: "route-1", sourceMessageId: "message-1",
      agentId: "agent-1", outcome: "will_respond", reasonCode: "direct_mention",
      reasonText: "direct mandatory address", routeAttempt: 2,
      decidedAt: "2026-08-17T00:00:01.000Z",
    })).toBe(true);
    expect(isRouteJudgment({
      id: "route-judgment-1", routeJobId: "route-1", sourceMessageId: "message-1",
      agentId: "agent-1", outcome: "will_respond", reasonCode: "direct_mention",
      reasonText: "", routeAttempt: 0, decidedAt: "2026-08-17T00:00:01.000Z",
    })).toBe(false);
    const routerInput = {
      purpose: "route_decision",
      roomId: "room-1",
      sourceMessageId: "message-1",
      message: { authorId: "human-1", authorKind: "human", summary: "review migration" },
      roomPhase: "discussion",
      agents: [{
        agentId: "agent-1", participation: "active", role: "agent",
        capabilities: ["review.read"], calibrationScore: 0, hasBall: false,
      }],
      topic: {
        topicKey: "topic-v1:abc", embeddingModelVersion: "dao-topic-embedding-v1",
        windowSize: 8, cosineThreshold: 0.82,
      },
      limits: { timeoutMs: 1_000, maxCandidates: 1, maxOutputBytes: 65_536 },
    } as const;
    expect(isRouterProviderInput(routerInput)).toBe(true);
    expect(isRouterProviderInput({ ...routerInput, visibleConversation: [] })).toBe(false);
    expect(isRouterProviderInput({
      ...routerInput,
      limits: { ...routerInput.limits, timeoutMs: 1_001 },
    })).toBe(false);
  });

  it("keeps weighted route calibration feedback closed and distinct from emoji", () => {
    expect(isCalibrationSignal({
      id: "calibration-useful", sourceMessageId: "message-agent", actorId: "human-1",
      agentId: "agent-1", feedback: "useful", createdAt: "2026-08-17T00:00:00.000Z",
    })).toBe(true);
    expect(isCalibrationSignal({
      id: "calibration-invalid", sourceMessageId: "message-agent", actorId: "human-1",
      agentId: "agent-1", emoji: "👍", feedback: "useful",
      createdAt: "2026-08-17T00:00:00.000Z",
    })).toBe(false);
  });
});
