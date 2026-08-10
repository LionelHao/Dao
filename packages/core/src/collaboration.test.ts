import { describe, expect, it } from "vitest";
import {
  isAgentExecution,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isOpenItem,
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
    expect(isOpenItem({
      id: "item-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      ownerId: "human-2",
      content: "请确认",
      status: "transferred",
      createdAt: "2026-08-10T00:00:00.000Z",
      transferChain: [{
        fromId: "human-2",
        toId: "human-3",
        reason: "转交",
        transferredAt: "2026-08-10T00:01:00.000Z",
      }],
    })).toBe(true);
    expect(isAgentExecution({
      id: "execution-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      agentId: "agent-1",
      toolName: "search.web",
      status: "interrupted",
      startedAt: "2026-08-10T00:00:00.000Z",
      completedAt: "2026-08-10T00:01:00.000Z",
    })).toBe(true);
    expect(isAgentExecution({
      id: "execution-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      agentId: "agent-1",
      toolName: "search.web",
      status: "running",
      startedAt: "2026-08-10T00:00:00.000Z",
      result: undefined,
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
});
