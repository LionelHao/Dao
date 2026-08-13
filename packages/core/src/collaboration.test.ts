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

  it("validates open-item and queued execution records without merging them", () => {
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
      status: "queued",
      actionCategory: "model_generation",
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      providerId: "provider-1",
      modelId: "model-1",
      recoveryCursor: 0,
      queuedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    })).toBe(true);
  });

  it("rejects invalid v6 execution states and relations", () => {
    const queuedExecution = {
      id: "execution-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      agentId: "agent-1",
      status: "queued",
      actionCategory: "model_generation",
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      providerId: "provider-1",
      modelId: "model-1",
      recoveryCursor: 0,
      queuedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    expect(isAgentExecution({ ...queuedExecution, unknown: true })).toBe(false);
    expect(isAgentExecution({ ...queuedExecution, toolDispatchPhase: "not_started" })).toBe(false);
    expect(isAgentExecution({ ...queuedExecution, status: "interrupted" })).toBe(false);
    expect(isAgentExecution({ ...queuedExecution, retryOrdinal: 4 })).toBe(false);
    expect(isAgentExecution({
      ...queuedExecution,
      toolDispatchPhase: "dispatched",
      currentToolId: "tool-1",
    })).toBe(false);
    expect(isAgentExecution({
      ...queuedExecution,
      status: "failed",
    })).toBe(false);
    expect(isAgentExecution({
      ...queuedExecution,
      status: "completed",
      startedAt: "2026-08-10T00:00:00.000Z",
      finishedAt: "2026-08-10T00:01:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
    })).toBe(true);
  });

  it("enforces the terminal status optional-field matrix", () => {
    const base = {
      id: "execution-1", roomId: "room-1", sourceMessageId: "message-1", requesterId: "human-1",
      agentId: "agent-1", actionCategory: "model_generation", currentAttemptSeq: 1, retryCycle: 1,
      retryOrdinal: 1, providerId: "provider-1", modelId: "model-1", recoveryCursor: 0,
      queuedAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const byStatus = {
      queued: { ...base, status: "queued" },
      running: { ...base, status: "running", startedAt: "2026-08-10T00:00:01.000Z", updatedAt: "2026-08-10T00:00:01.000Z" },
      completed: { ...base, status: "completed", startedAt: "2026-08-10T00:00:01.000Z", finishedAt: "2026-08-10T00:01:00.000Z", updatedAt: "2026-08-10T00:01:00.000Z" },
      cancelled: { ...base, status: "cancelled", finishedAt: "2026-08-10T00:01:00.000Z", updatedAt: "2026-08-10T00:01:00.000Z", cancellationReason: "user_cancelled" },
      failed: { ...base, status: "failed", startedAt: "2026-08-10T00:00:01.000Z", finishedAt: "2026-08-10T00:01:00.000Z", updatedAt: "2026-08-10T00:01:00.000Z", terminalErrorCode: "provider_error" },
    };
    for (const execution of Object.values(byStatus)) expect(isAgentExecution(execution)).toBe(true);
    for (const [status, execution] of Object.entries(byStatus)) {
      for (const [field, value] of Object.entries({
        resultMessageId: "message-result", cancellationReason: "user_cancelled",
        terminalErrorCode: "provider_error", deadLetteredAt: "2026-08-10T00:01:01.000Z",
      })) {
        const allowed = field === "resultMessageId" ? status === "completed" :
          field === "cancellationReason" ? status === "cancelled" : status === "failed";
        expect(isAgentExecution({
          ...execution,
          ...(field === "deadLetteredAt" && allowed ? { updatedAt: value } : {}),
          [field]: value,
        })).toBe(allowed);
      }
    }
    expect(isAgentExecution({ ...byStatus.cancelled, cancellationReason: undefined })).toBe(false);
    expect(isAgentExecution({ ...byStatus.failed, terminalErrorCode: undefined })).toBe(false);
  });

  it("allows absent tool fields only for tool calls and requires paired tool fields when present", () => {
    const base = {
      id: "execution-1", roomId: "room-1", sourceMessageId: "message-1", requesterId: "human-1",
      agentId: "agent-1", status: "queued", currentAttemptSeq: 1, retryCycle: 1, retryOrdinal: 1,
      providerId: "provider-1", modelId: "model-1", recoveryCursor: 0,
      queuedAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
    };
    expect(isAgentExecution({ ...base, actionCategory: "tool_call" })).toBe(true);
    expect(isAgentExecution({ ...base, actionCategory: "tool_call", toolDispatchPhase: "dispatched" })).toBe(false);
    expect(isAgentExecution({ ...base, actionCategory: "tool_call", currentToolId: "tool-1" })).toBe(false);
    expect(isAgentExecution({ ...base, actionCategory: "tool_call", toolDispatchPhase: "unknown", currentToolId: "tool-1" })).toBe(false);
    expect(isAgentExecution({ ...base, actionCategory: "tool_call", toolDispatchPhase: "dispatched", currentToolId: "" })).toBe(false);
    for (const actionCategory of ["model_generation", "waiting_upstream"] as const) {
      expect(isAgentExecution({ ...base, actionCategory, toolDispatchPhase: "dispatched" })).toBe(false);
      expect(isAgentExecution({ ...base, actionCategory, currentToolId: "tool-1" })).toBe(false);
    }
  });

  it("rejects noncanonical or unordered lifecycle timestamps and conflicting lineage", () => {
    const queued = {
      id: "execution-1", roomId: "room-1", sourceMessageId: "message-1", requesterId: "human-1",
      agentId: "agent-1", status: "queued", actionCategory: "tool_call", toolDispatchPhase: "not_started",
      currentToolId: "tool-1", currentAttemptSeq: 1, retryCycle: 1, retryOrdinal: 1,
      providerId: "provider-1", modelId: "model-1", recoveryCursor: 0,
      queuedAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
    };
    expect(isAgentExecution(queued)).toBe(true);
    expect(isAgentExecution({ ...queued, queuedAt: "2026-08-10T00:00:00Z" })).toBe(false);
    expect(isAgentExecution({ ...queued, toolDispatchPhase: "dispatched" })).toBe(false);
    expect(isAgentExecution({ ...queued, manualRetryOfExecutionId: "execution-1" })).toBe(false);
    expect(isAgentExecution({ ...queued, supersedesExecutionIds: [] })).toBe(false);
    expect(isAgentExecution({ ...queued, supersedesExecutionIds: ["execution-2", "execution-2"] })).toBe(false);
    expect(isAgentExecution({ ...queued, manualRetryOfExecutionId: "execution-2", compensatesExecutionId: "execution-3" })).toBe(false);
    expect(isAgentExecution({
      ...queued, status: "completed", startedAt: "2026-08-10T00:00:02.000Z",
      finishedAt: "2026-08-10T00:00:01.000Z", updatedAt: "2026-08-10T00:00:01.000Z",
    })).toBe(false);
    const withoutTool = { ...queued };
    Reflect.deleteProperty(withoutTool, "toolDispatchPhase");
    Reflect.deleteProperty(withoutTool, "currentToolId");
    const failed = {
      ...withoutTool, status: "failed", actionCategory: "model_generation", startedAt: "2026-08-10T00:00:01.000Z",
      finishedAt: "2026-08-10T00:00:02.000Z", updatedAt: "2026-08-10T00:00:03.000Z",
      terminalErrorCode: "failure", deadLetteredAt: "2026-08-10T00:00:02.500Z",
    };
    expect(isAgentExecution(failed)).toBe(true);
    expect(isAgentExecution({ ...failed, deadLetteredAt: "2026-08-10T00:00:02Z" })).toBe(false);
    expect(isAgentExecution({ ...failed, deadLetteredAt: "2026-08-10T00:00:01.000Z" })).toBe(false);
    expect(isAgentExecution({ ...failed, deadLetteredAt: "2026-08-10T00:00:04.000Z" })).toBe(false);
    expect(isAgentExecution({
      ...withoutTool, actionCategory: "model_generation", status: "running",
      startedAt: "2026-08-10T00:00:01.000Z",
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
