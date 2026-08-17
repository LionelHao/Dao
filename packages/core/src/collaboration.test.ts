import { describe, expect, it } from "vitest";
import {
  isBallInCourt,
  isBlueprintBallFact,
  isAgentExecution,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isHumanPreemptionNotice,
  isLightTask,
  isOpenItem,
  isOpenItemAgentFailure,
  isRouteJob,
  isRouteJudgment,
  isRouterProviderInput,
  isRouterPlan,
  isSocialReaction,
  projectBallsInCourt,
} from "./collaboration.js";

describe("canonical collaboration records", () => {
  it("keeps human preemption and replacement lineage closed and separate from failure", () => {
    expect(isHumanPreemptionNotice({
      roomId: "room-1", sourceHumanMessageId: "message-human-1",
      cancelledExecutionIds: ["execution-old-1", "execution-old-2"],
      rerouteStatus: "queued", occurredAt: "2026-08-17T00:00:01.000Z",
    })).toBe(true);
    expect(isHumanPreemptionNotice({
      roomId: "room-1", sourceHumanMessageId: "message-human-1",
      cancelledExecutionIds: ["execution-old-1", "execution-old-1"],
      rerouteStatus: "queued", occurredAt: "2026-08-17T00:00:01.000Z",
    })).toBe(false);
    expect(isHumanPreemptionNotice({
      roomId: "room-1", sourceHumanMessageId: "message-human-1",
      cancelledExecutionIds: [], rerouteStatus: "queued",
      occurredAt: "2026-08-17T00:00:01.000Z", humanWithdrawn: true,
    })).toBe(false);
    const replacement = {
      id: "execution-new-1", roomId: "room-1", sourceMessageId: "message-human-1",
      requesterId: "human-1", agentId: "agent-1", toolName: "model.generate",
      status: "queued", actionCategory: "model_generation", currentAttemptSeq: 1,
      retryCycle: 1, retryOrdinal: 1, recoveryCursor: 0,
      queuedAt: "2026-08-17T00:00:02.000Z", updatedAt: "2026-08-17T00:00:02.000Z",
      supersedesExecutionIds: ["execution-old-1"],
    } as const;
    expect(isAgentExecution(replacement)).toBe(true);
    expect(isAgentExecution({ ...replacement, supersedesExecutionIds: [] })).toBe(false);
    expect(isAgentExecution({
      ...replacement, supersedesExecutionIds: ["execution-old-1", "execution-old-1"],
    })).toBe(false);
  });

  it("projects one closed holder from each authoritative commitment state without text or role inference", () => {
    const openItem = {
      id: "item-1", roomId: "room-1", sourceMessageId: "message-1",
      requesterId: "human-1", currentOwnerId: "agent-1", content: "我来只是正文，不参与推断",
      status: "transferred", origin: { kind: "human_mention" },
      createdAt: "2026-08-17T00:00:00.000Z",
      transferChain: [{
        fromId: "human-2", toId: "agent-1", reason: "明确转交",
        transferredAt: "2026-08-17T00:10:00.000Z",
      }],
    } as const;
    const claimed = {
      id: "task-1", roomId: "room-1", sourceMessageId: "message-2", title: "Ship",
      claimant: "human-2", claimantRoleAtClaim: "member", verifierRole: "owner",
      verifierActorId: null, criteria: [], status: "claimed",
      createdAt: "2026-08-17T00:00:00.000Z", claimedAt: "2026-08-17T00:20:00.000Z",
    } as const;
    const delivered = {
      ...claimed, id: "task-2", status: "delivered", verifierActorId: "human-3",
      deliveredAt: "2026-08-17T00:30:00.000Z",
    } as const;
    const todo = {
      ...claimed, id: "task-todo", claimant: null, claimantRoleAtClaim: null,
      status: "todo", claimedAt: undefined,
    };
    const blueprint = {
      sourceKind: "blueprint-awaiting", sourceId: "T-0100", roomId: "room-1",
      assigneeId: "agent-2", reason: "awaiting authoritative assignee",
      since: "2026-08-10T00:00:00.000Z",
    } as const;
    expect(isBlueprintBallFact(blueprint)).toBe(true);

    const balls = projectBallsInCourt({
      openItems: [openItem], lightTasks: [claimed, delivered, todo], blueprintFacts: [blueprint, blueprint],
      openItemDeadlineMs: 60_000, lightTaskDeadlineMs: 60_000,
    });
    expect(balls).toEqual([
      {
        holderId: "agent-1", roomId: "room-1", sourceKind: "open-item", sourceId: "item-1",
        reason: "open item transferred to current owner", since: "2026-08-17T00:10:00.000Z",
        deadline: "2026-08-17T00:11:00.000Z",
      },
      {
        holderId: "human-2", roomId: "room-1", sourceKind: "light-task", sourceId: "task-1",
        reason: "claimed light task awaits delivery", since: "2026-08-17T00:20:00.000Z",
        deadline: "2026-08-17T00:21:00.000Z",
      },
      {
        holderId: "human-3", roomId: "room-1", sourceKind: "light-task", sourceId: "task-2",
        reason: "delivered light task awaits persisted verifier", since: "2026-08-17T00:30:00.000Z",
        deadline: "2026-08-17T00:31:00.000Z",
      },
      {
        holderId: "agent-2", roomId: "room-1", sourceKind: "blueprint-awaiting", sourceId: "T-0100",
        reason: "awaiting authoritative assignee", since: "2026-08-10T00:00:00.000Z",
        deadline: "2026-08-17T00:00:00.000Z",
      },
    ]);
    expect(balls.every(isBallInCourt)).toBe(true);
    expect(balls.some((ball) => ball.sourceId === "task-todo")).toBe(false);
  });

  it("rejects ambiguous or open-shaped Blueprint facts and closed ball extras", () => {
    expect(isBlueprintBallFact({
      sourceKind: "blueprint-blocked-mention", sourceId: "T-1", roomId: "room-1",
      mentionedActorId: "human-1", reason: "explicit blocked fact", since: "2026-08-17T00:00:00.000Z",
    })).toBe(true);
    expect(isBlueprintBallFact({
      sourceKind: "blueprint-blocked-mention", sourceId: "T-1", roomId: "room-1",
      mentionedActorIds: ["human-1", "human-2"], reason: "ambiguous", since: "2026-08-17T00:00:00.000Z",
    })).toBe(false);
    expect(isBallInCourt({
      holderId: "human-1", roomId: "room-1", sourceKind: "open-item", sourceId: "item-1",
      reason: "awaiting current owner", since: "2026-08-17T00:00:00.000Z",
      deadline: "2026-08-18T00:00:00.000Z", messageText: "我来",
    })).toBe(false);
  });

  it("uses seven days for Blueprint claimed/awaiting and immediate blocked mentions", () => {
    const since = "2026-08-10T00:00:00.000Z";
    const balls = projectBallsInCourt({
      openItems: [], lightTasks: [], openItemDeadlineMs: 1, lightTaskDeadlineMs: 1,
      blueprintFacts: [
        { sourceKind: "blueprint-task", sourceId: "T-1", roomId: "room-1",
          assigneeId: "agent-1", reason: "claimed", since },
        { sourceKind: "blueprint-awaiting", sourceId: "T-2", roomId: "room-1",
          assigneeId: "human-1", reason: "awaiting", since },
        { sourceKind: "blueprint-blocked-mention", sourceId: "T-3", roomId: "room-1",
          mentionedActorId: "human-2", reason: "explicit blocked mention", since },
      ],
    });
    expect(balls.map((ball) => [ball.sourceKind, ball.holderId, ball.deadline])).toEqual([
      ["blueprint-task", "agent-1", "2026-08-17T00:00:00.000Z"],
      ["blueprint-awaiting", "human-1", "2026-08-17T00:00:00.000Z"],
      ["blueprint-blocked-mention", "human-2", since],
    ]);
  });

  it("atomically projects the newest authoritative Blueprint assignee and ignores an older replay", () => {
    const older = {
      sourceKind: "blueprint-awaiting", sourceId: "T-4", roomId: "room-1",
      assigneeId: "human-1", reason: "older authoritative assignee",
      since: "2026-08-10T00:00:00.000Z",
    } as const;
    const newer = {
      ...older, assigneeId: "agent-1", reason: "new authoritative assignee",
      since: "2026-08-11T00:00:00.000Z",
    } as const;
    expect(projectBallsInCourt({
      openItems: [], lightTasks: [], blueprintFacts: [older, newer, older],
      openItemDeadlineMs: 1, lightTaskDeadlineMs: 1,
    })).toEqual([{
      holderId: "agent-1", roomId: "room-1", sourceKind: "blueprint-awaiting", sourceId: "T-4",
      reason: "new authoritative assignee", since: "2026-08-11T00:00:00.000Z",
      deadline: "2026-08-18T00:00:00.000Z",
    }]);
  });

  it("keeps LightTask as a closed four-state fact without GBP planning fields", () => {
    const todo = {
      id: "task-1", roomId: "room-1", sourceMessageId: "message-1",
      title: "Close the release checklist", claimant: null, claimantRoleAtClaim: null,
      verifierRole: "admin", verifierActorId: null,
      criteria: [{ id: "criterion-1", text: "All checks pass", met: false }],
      status: "todo", createdAt: "2026-08-17T00:00:00.000Z",
    } as const;
    expect(isLightTask(todo)).toBe(true);
    expect(isLightTask({ ...todo, deps: ["T-0001"] })).toBe(false);
    expect(isLightTask({ ...todo, status: "blocked" })).toBe(false);
    expect(isLightTask({ ...todo, claimant: "human-1" })).toBe(false);
    const claimed = {
      ...todo, status: "claimed", claimant: "human-1", claimantRoleAtClaim: "member",
      claimedAt: "2026-08-17T00:01:00.000Z",
    } as const;
    expect(isLightTask(claimed)).toBe(true);
    const delivered = {
      ...claimed, status: "delivered", verifierActorId: "human-2",
      deliveredAt: "2026-08-17T00:02:00.000Z",
    } as const;
    expect(isLightTask(delivered)).toBe(true);
    expect(isLightTask({ ...delivered, verifierActorId: "human-1" })).toBe(false);
    expect(isLightTask({ ...delivered, verifierRole: "member" })).toBe(false);
    expect(isLightTask({ ...delivered, criteria: [{ ...delivered.criteria[0], met: true }] })).toBe(true);
    expect(isLightTask({
      ...delivered, status: "verified", verifiedAt: "2026-08-17T00:03:00.000Z",
      criteria: [{ ...delivered.criteria[0], met: true }],
    })).toBe(true);
    expect(isLightTask({ ...delivered, status: "verified", verifiedAt: "2026-08-17T00:03:00.000Z" }))
      .toBe(false);
  });

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
