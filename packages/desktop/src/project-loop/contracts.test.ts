import { describe, expect, it } from "vitest";
import { isProjectLoopIntent, isProjectLoopRemoteState, isProjectLoopSubmitCommand, isProjectLoopWireError,
  isProjectLoopWireResponse } from "./contracts.js";
import { projectSnapshot } from "./test-fixture.js";

describe("FT-09 Desktop Project Loop closed bridge contracts", () => {
  it("accepts closed proposal and Request intents and rejects principal/excess injection", () => {
    expect(isProjectLoopIntent({ kind: "proposal.resolve", intentId: "i-1", proposalId: "p-1",
      expectedRevision: 1, resolution: "confirmed", reason: null })).toBe(true);
    expect(isProjectLoopIntent({ kind: "request.transition", intentId: "i-2", factId: "r-1",
      expectedRevision: 1, action: "transfer", target: { kind: "human", actorId: "human-2" },
      reason: "handoff" })).toBe(true);
    expect(isProjectLoopIntent({ kind: "request.transition", intentId: "i-2", factId: "r-1",
      expectedRevision: 1, action: "accept", actorId: "forged" })).toBe(false);
    expect(isProjectLoopIntent({ kind: "request.transition", intentId: "i-2", factId: "r-1",
      expectedRevision: 1, action: "transfer", target: { kind: "agent", actorId: "agent-1" },
      reason: "spoof" })).toBe(false);
    expect(isProjectLoopIntent({ kind: "next_action.transition", intentId: "i-3", factId: "a-1",
      expectedRevision: 2, action: "start" })).toBe(true);
    expect(isProjectLoopIntent({ kind: "next_action.transition", intentId: "i-3b", factId: "a-1",
      expectedRevision: 2, action: "complete", completionNote: "n".repeat(300),
      criteriaSnapshot: [{ criterionId: "c-1", text: "c".repeat(300) }] })).toBe(true);
    expect(isProjectLoopIntent({ kind: "obstacle.transition", intentId: "i-4", factId: "b-1",
      expectedRevision: 2, obstacleKind: "blocker", action: "defer", reason: "wait",
      reviewAt: "2026-08-28T00:00:00.000Z" })).toBe(true);
    expect(isProjectLoopIntent({ kind: "obstacle.transition", intentId: "i-4b", factId: "b-1",
      expectedRevision: 3, obstacleKind: "blocker", action: "reopen", reason: "Work resumed" }))
      .toBe(true);
    expect(isProjectLoopIntent({ kind: "transfer.propose", intentId: "i-4c",
      transferProposalId: "t-agent", subjectKind: "blocker", subjectId: "b-1",
      expectedRevision: 3, toOwner: { kind: "agent", actorId: "agent-1" }, reason: "Specialist" }))
      .toBe(true);
    expect(isProjectLoopIntent({ kind: "transfer.resolve", intentId: "i-5",
      transferProposalId: "t-1", subjectKind: "next_action", subjectId: "a-1",
      expectedRevision: 2, resolution: "accepted", reason: null })).toBe(true);
    expect(isProjectLoopIntent({ kind: "obstacle.transition", intentId: "i-6", factId: "b-1",
      expectedRevision: 2, obstacleKind: "open_question", action: "resolve",
      resultSource: { kind: "message", sourceId: "m-1", sourceRevision: 1,
        roomId: "other-room", visibility: "room" }, reason: "done" })).toBe(true);
    expect(isProjectLoopSubmitCommand({ roomId: "room-1", intent: {
      kind: "obstacle.transition", intentId: "i-6", factId: "b-1", expectedRevision: 2,
      obstacleKind: "open_question", action: "resolve", resultSource: { kind: "message",
        sourceId: "m-1", sourceRevision: 1, roomId: "other-room", visibility: "room" }, reason: "done",
    } })).toBe(false);
  });

  it("accepts only canonical snapshot/ACK and correlated closed error shapes", () => {
    expect(isProjectLoopWireResponse({ type: "project.snapshot", requestId: "q-1",
      snapshot: projectSnapshot(), events: [], nextEventSeq: 7 })).toBe(true);
    expect(isProjectLoopWireResponse({ type: "project.mutation.ack", requestId: "q-2",
      roomId: "room-1", projectId: "room-1", acceptedRevision: 8,
      eventIds: ["event-8"], replayed: false })).toBe(true);
    expect(isProjectLoopWireResponse({ type: "project.mutation.ack", requestId: "q-2",
      roomId: "room-1", projectId: "room-1", acceptedRevision: 8,
      eventIds: ["event-8"], replayed: false, fact: { forged: true } })).toBe(false);
    expect(isProjectLoopWireError({ type: "error", status: 429, code: "rate_limited",
      message: "wait", requestId: "q-2", retryAfterSeconds: 4 })).toBe(true);
    expect(isProjectLoopWireError({ type: "error", status: 400, code: "invalid_request",
      message: "invalid target", requestId: "q-3" })).toBe(true);
    expect(isProjectLoopWireError({ type: "error", status: 404, code: "project_fact_not_found",
      message: "missing", requestId: "q-4" })).toBe(true);
    expect(isProjectLoopWireError({ type: "error", status: 410, code: "room_archived",
      message: "archived", requestId: "q-5" })).toBe(true);
    expect(isProjectLoopWireError({ type: "error", status: 403, code: "revision_conflict",
      message: "mismatch", requestId: "q-2" })).toBe(false);
  });

  it("rejects partial, wrong-Room, and hidden authority states", () => {
    const ready = { status: "ready", roomId: "room-1", snapshot: projectSnapshot(),
      viewerActorId: "human-1", connection: { status: "online" }, operation: { status: "idle" } };
    expect(isProjectLoopRemoteState(ready)).toBe(true);
    expect(isProjectLoopRemoteState({ ...ready, roomId: "room-2" })).toBe(false);
    expect(isProjectLoopRemoteState({ ...ready, prompt: "hidden" })).toBe(false);
  });
});
