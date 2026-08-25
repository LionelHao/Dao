import { describe, expect, it } from "vitest";
import { isProjectLoopServerFrame, parseProjectLoopClientFrame } from "./project-loop-protocol.js";
import { parseClientFrame } from "./protocol.js";

const source = { kind: "message" as const, sourceId: "message-1", sourceRevision: 1,
  roomId: "room-1", visibility: "room" as const };
const mutation = { requestId: "mutation-1", idempotencyKey: "idem-1",
  roomId: "room-1", projectId: "room-1" };
const fact = { ...mutation, factId: "fact-1", expectedRevision: 1 };

describe("FT-09 Project Loop protocol", () => {
  it.each([
    { type: "project.snapshot.read", requestId: "snapshot-1", roomId: "room-1", projectId: "room-1", afterEventSeq: 0, limit: 64 },
    { ...mutation, type: "project.proposal.create", proposalId: "proposal-1", baseRevision: null,
      source, payload: { kind: "decision", statement: "Use immutable events",
        supersedesDecisionId: null, affectedFactIds: [] } },
    { ...mutation, type: "project.proposal.resolve", proposalId: "proposal-1",
      expectedRevision: 1, resolution: "confirmed", reason: null },
    { ...fact, type: "project.request.transition", action: "accept" },
    { ...fact, type: "project.request.transition", action: "transfer",
      target: { actorId: "human-2", kind: "human" }, reason: "Owner changed" },
    { ...fact, type: "project.next-action.transition", action: "start" },
    { ...fact, type: "project.next-action.transition", action: "complete",
      completionNote: "Verified", criteriaSnapshot: [{ criterionId: "criterion-1", text: "Smoke green" }] },
    { ...fact, type: "project.next-action.transition", action: "deliver", source, summary: "Build ready" },
    { ...fact, type: "project.obstacle.transition", obstacleKind: "blocker", action: "defer",
      reason: "Wait for vendor", reviewAt: "2026-08-26T00:00:00.000Z" },
    { ...mutation, type: "project.transfer.propose", transferProposalId: "transfer-1",
      subjectKind: "blocker", subjectId: "blocker-1", expectedRevision: 1,
      toOwner: { actorId: "human-2", kind: "human" }, reason: "Domain owner" },
    { ...mutation, type: "project.transfer.resolve", transferProposalId: "transfer-1",
      subjectKind: "blocker", subjectId: "blocker-1", expectedRevision: 1,
      resolution: "accepted", reason: null },
  ])("accepts exact $type/$action frames", (frame) => {
    expect(parseProjectLoopClientFrame(frame)).toEqual({ ok: true, frame });
  });

  it.each([
    { type: "project.snapshot.read", requestId: "x", roomId: "room-1", projectId: "room-2", afterEventSeq: 0, limit: 1 },
    { ...mutation, type: "project.proposal.resolve", proposalId: "proposal-1", expectedRevision: 1,
      resolution: "confirmed", reason: null, actorId: "forged-human" },
    { ...mutation, type: "project.proposal.create", proposalId: "proposal-1", baseRevision: null,
      source: { ...source, roomId: "room-2" }, payload: { kind: "decision", statement: "x",
        supersedesDecisionId: null, affectedFactIds: [] } },
    { ...mutation, type: "project.proposal.create", proposalId: "proposal-1", baseRevision: null,
      source, payload: { kind: "request", title: "x", description: "x",
        requester: { actorId: "human-1", kind: "human" }, target: { actorId: "human-2", kind: "human" },
        acceptanceMode: "next_action" } },
    { ...mutation, type: "project.proposal.create", proposalId: "proposal-agent-owner", baseRevision: null,
      source, payload: { kind: "next_action", title: "x", description: "x",
        owner: { actorId: "agent-forged", kind: "agent" }, dueAt: null, deliverable: "x",
        acceptanceCriteria: [], verifier: { actorId: "human-1", kind: "human" } } },
    { ...mutation, type: "project.proposal.create", proposalId: "proposal-nested-extra", baseRevision: null,
      source, payload: { kind: "blocker", title: "x", description: "x", impact: "x",
        resolutionCriteria: "x", question: null,
        owner: { actorId: "human-1", kind: "human", agentId: "forged" }, dueAt: null, reviewAt: null } },
    { ...fact, type: "project.request.transition", action: "accept", reason: "excess" },
    { ...fact, type: "project.next-action.transition", action: "deliver", source,
      summary: "ok", verifierActorId: "forged" },
    { ...fact, type: "project.next-action.transition", action: "reassign",
      owner: { actorId: "agent-2", kind: "agent" }, verifier: null, reason: "invalid Agent contract" },
    { ...mutation, type: "project.transfer.propose", transferProposalId: "transfer-agent",
      subjectKind: "blocker", subjectId: "blocker-1", expectedRevision: 1,
      toOwner: { actorId: "agent-forged", kind: "agent" }, reason: "spoof" },
    { ...fact, type: "project.obstacle.transition", obstacleKind: "open_question",
      action: "defer", reason: "later", reviewAt: "not-time" },
    { ...mutation, type: "project.transfer.resolve", transferProposalId: "transfer-1",
      subjectKind: "blocker", subjectId: "blocker-1", expectedRevision: 1,
      resolution: "rejected", reason: null },
    { ...fact, type: "project.next-action.transition", action: "complete" },
    { ...mutation, type: "project.proposal.create", proposalId: "proposal-1", baseRevision: null,
      source, payload: { kind: "decision", statement: "界".repeat(3_000),
        supersedesDecisionId: null, affectedFactIds: [] } },
  ])("rejects cross-room, principal spoof, illegal variants and excess/oversized fields %#", (frame) => {
    expect(parseProjectLoopClientFrame(frame)).toMatchObject({ ok: false });
  });

  it("is wired into the public decoder without reflecting rejected payloads", () => {
    expect(parseClientFrame(JSON.stringify({ type: "project.snapshot.read", requestId: "public-1",
      roomId: "room-1", projectId: "room-1", afterEventSeq: 0, limit: 32 })))
      .toMatchObject({ ok: true, frame: { type: "project.snapshot.read" } });
    const rejected = parseClientFrame(JSON.stringify({ type: "project.snapshot.read", requestId: "public-1",
      roomId: "room-secret", projectId: "room-secret", afterEventSeq: 0, limit: 32,
      credential: "secret-canary" }));
    expect(rejected).toMatchObject({ ok: false,
      error: { status: 400, code: "invalid_request", requestId: "public-1" } });
    expect(JSON.stringify(rejected)).not.toContain("secret-canary");
    expect(JSON.stringify(rejected)).not.toContain("room-secret");
  });

  it("uses canonical snapshot/event/fact guards in server frames", () => {
    const snapshot = { recordVersion: "project-loop.v1", roomId: "room-1", projectId: "room-1",
      watermark: 0, goals: [], decisions: [], requests: [], obstacles: [], nextActions: [],
      proposals: [], confirmations: [], transferProposals: [], balls: [],
      capturedAt: "2026-08-25T00:00:00.000Z" };
    expect(isProjectLoopServerFrame({ type: "project.snapshot", requestId: "snapshot-1",
      snapshot, events: [], nextEventSeq: 0 })).toBe(true);
    expect(isProjectLoopServerFrame({ type: "project.snapshot", requestId: "snapshot-1",
      snapshot: { ...snapshot, decisions: [{ kind: "decision", statement: "forged" }] },
      events: [], nextEventSeq: 0 })).toBe(false);
    expect(isProjectLoopServerFrame({ type: "project.mutation.ack", requestId: "mutation-1",
      roomId: "room-1", projectId: "room-1", acceptedRevision: 2,
      eventIds: ["event-2"], replayed: false })).toBe(true);
    expect(isProjectLoopServerFrame({ type: "project.mutation.ack", requestId: "mutation-1",
      roomId: "room-1", projectId: "room-2", acceptedRevision: 2,
      eventIds: [], replayed: false })).toBe(false);
    expect(isProjectLoopServerFrame({ type: "project.mutation.ack", requestId: "mutation-1",
      roomId: "room-1", projectId: "room-1", acceptedRevision: 2,
      eventIds: ["event-2"], replayed: false, proposal: { proposalId: "not-stable" } })).toBe(false);
  });
});
