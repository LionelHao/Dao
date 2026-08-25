import { describe, expect, it } from "vitest";
import { isProjectLoopIntent, isProjectLoopRemoteState, isProjectLoopWireError,
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
