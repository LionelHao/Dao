import { describe, expect, it } from "vitest";
import type { ProjectLoopAuthorityOperation, ProjectLoopAuthorityResult } from
  "./authority-protocol.js";
import { createProjectLoopWorkerAuthorityTransport } from "./worker-authority-adapter.js";

const now = Date.parse("2026-08-25T04:00:00.000Z");
const session = {
  sessionId: "session-1",
  sessionFamilyId: "family-1",
  principal: { accountId: "account-1", actorId: "human-1" },
};
const context = {
  ...session,
  kind: "human" as const,
  requestId: "request-1",
  idempotencyKey: "idem-1",
};
const base = { requestId: "request-1", idempotencyKey: "idem-1",
  roomId: "room-1", projectId: "room-1" };
const source = { kind: "message" as const, sourceId: "message-1", sourceRevision: 2,
  roomId: "room-1", visibility: "room" as const };

function harness(result?: ProjectLoopAuthorityResult) {
  const operations: ProjectLoopAuthorityOperation[] = [];
  return {
    operations,
    transport: createProjectLoopWorkerAuthorityTransport({
      async executeProjectLoop(operation) {
        operations.push(operation);
        return result ?? { kind: "project-loop-mutation", roomId: "room-1",
          projectId: "room-1", acceptedRevision: 4, eventIds: ["event-4"], replayed: false };
      },
    }, () => now),
  };
}

describe("Project Loop production Worker adapter", () => {
  it("maps snapshot reads and returns only the public snapshot envelope", async () => {
    const snapshot = { recordVersion: "project-loop.v1" as const, roomId: "room-1",
      projectId: "room-1", watermark: 0, goals: [], decisions: [], requests: [], obstacles: [],
      nextActions: [], proposals: [], confirmations: [], transferProposals: [], balls: [],
      capturedAt: "2026-08-25T04:00:00.000Z" };
    const { operations, transport } = harness({ kind: "project-loop-snapshot", snapshot,
      events: [], nextEventSeq: 0 });
    await expect(transport.executeQuery(session, { type: "project.snapshot.read",
      requestId: "read-1", roomId: "room-1", projectId: "room-1",
      afterEventSeq: 3, limit: 40 })).resolves.toEqual({
      type: "project.snapshot", requestId: "read-1", snapshot, events: [], nextEventSeq: 0,
    });
    expect(operations).toEqual([{ type: "project-loop.snapshot.read", context: session,
      roomId: "room-1", projectId: "room-1", afterEventSeq: 3, limit: 40, now }]);
  });

  it("binds Human proposals to the authenticated principal and server expiry", async () => {
    const { operations, transport } = harness();
    await transport.executeMutation(context, { ...base, type: "project.proposal.create",
      proposalId: "proposal-1", baseRevision: 3, source,
      payload: { kind: "decision", statement: "Keep immutable history",
        supersedesDecisionId: null, affectedFactIds: [] } });
    expect(operations[0]).toMatchObject({
      type: "project-loop.proposal.create", context,
      command: { proposalId: "proposal-1", factKind: "decision", factId: "fact:proposal-1",
        baseRevision: 3, principalActorId: "human-1",
        expiresAt: "2026-08-25T04:15:00.000Z", source,
        payload: { title: "Keep immutable history", rationale: "Keep immutable history",
          statement: "Keep immutable history", supersedesDecisionId: null,
          affectedFactIds: [] } },
    });
  });

  it("preserves the Human rejection reason in the authority command", async () => {
    const { operations, transport } = harness();
    await transport.executeMutation(context, { ...base, type: "project.proposal.resolve",
      proposalId: "proposal-1", expectedRevision: 3, resolution: "rejected",
      reason: "Source no longer supports this conclusion" });
    expect(operations).toEqual([{ type: "project-loop.proposal.resolve", context,
      command: { proposalId: "proposal-1", roomId: "room-1", projectId: "room-1",
        expectedRevision: 3, resolution: "rejected",
        reason: "Source no longer supports this conclusion" }, now }]);
  });

  it.each([
    [{ ...base, type: "project.request.transition" as const, factId: "request-1",
      expectedRevision: 2, action: "transfer" as const,
      target: { kind: "human" as const, actorId: "human-2" }, reason: "handoff" },
    { factKind: "request", factId: "request-1", transition: "request.transfer",
      payload: { targetHumanActorId: "human-2", reason: "handoff" } }],
    [{ ...base, type: "project.next-action.transition" as const, factId: "action-1",
      expectedRevision: 2, action: "complete" as const, completionNote: "verified",
      criteriaSnapshot: [{ criterionId: "criterion-1", text: "green" }] },
    { factKind: "next_action", factId: "action-1", transition: "next_action.complete",
      payload: { completionNote: "verified",
        criteriaSnapshot: [{ criterionId: "criterion-1", text: "green" }] } }],
    [{ ...base, type: "project.obstacle.transition" as const, factId: "question-1",
      expectedRevision: 2, obstacleKind: "open_question" as const,
      action: "resolve" as const, resultSource: source, reason: "answered" },
    { factKind: "open_question", factId: "question-1", transition: "obstacle.resolve",
      payload: { source, reason: "answered" } }],
    [{ ...base, type: "project.transfer.propose" as const, transferProposalId: "transfer-1",
      subjectKind: "next_action" as const, subjectId: "action-1", expectedRevision: 2,
      toOwner: { kind: "human" as const, actorId: "human-2" }, reason: "handoff" },
    { factKind: "next_action", factId: "action-1", transition: "next_action.transfer_propose",
      payload: { transferProposalId: "transfer-1", toOwnerKind: "human",
        toOwnerActorId: "human-2", reason: "handoff", expiresAt: "2026-08-25T04:15:00.000Z" } }],
    [{ ...base, type: "project.transfer.resolve" as const, transferProposalId: "transfer-1",
      subjectKind: "blocker" as const, subjectId: "blocker-1", expectedRevision: 2,
      resolution: "accepted" as const, reason: null },
    { factKind: "blocker", factId: "blocker-1", transition: "obstacle.transfer_accept",
      payload: { transferProposalId: "transfer-1" } }],
  ])("maps a public transition to one canonical fact transition %#", async (frame, command) => {
    const { operations, transport } = harness();
    await expect(transport.executeMutation(context, frame)).resolves.toEqual({
      type: "project.mutation.ack", requestId: "request-1", roomId: "room-1",
      projectId: "room-1", acceptedRevision: 4, eventIds: ["event-4"], replayed: false,
    });
    expect(operations[0]).toMatchObject({ type: "project-loop.fact.transition", context,
      command: { roomId: "room-1", projectId: "room-1", expectedRevision: 2, ...command } });
  });
});
