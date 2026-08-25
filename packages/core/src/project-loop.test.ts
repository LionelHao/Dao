import { describe, expect, it } from "vitest";
import * as core from "./index.js";
import {
  PROJECT_LOOP_LIMITS,
  canTransitionProjectDecision,
  canTransitionProjectGoal,
  canTransitionProjectNextAction,
  canTransitionProjectObstacle,
  canTransitionProjectRequest,
  canTransitionProjectTransferProposal,
  deriveProjectBallFacts,
  isProjectBallFact,
  isProjectBlocker,
  isProjectConfirmation,
  isProjectDecision,
  isProjectEvent,
  isProjectFact,
  isProjectGoal,
  isProjectNextAction,
  isProjectObstacle,
  isProjectOpenQuestion,
  isProjectProposal,
  isProjectRepairRecord,
  isProjectRequest,
  isProjectRevisionCurrent,
  isProjectSnapshot,
  isProjectTransferProposal,
} from "./project-loop.js";

const at = "2026-08-25T01:02:03.004Z";
const later = "2026-08-25T02:03:04.005Z";
const human1 = { actorId: "human-1", kind: "human" as const };
const human2 = { actorId: "human-2", kind: "human" as const };
const agent1 = { actorId: "agent-1", kind: "agent" as const };
const source = {
  kind: "message" as const,
  sourceId: "message-1",
  sourceRevision: 1,
  roomId: "room-1",
  visibility: "room" as const,
};
const provenance = { source, proposedBy: human1 };
const base = {
  recordVersion: "project-loop.v1" as const,
  roomId: "room-1",
  projectId: "room-1",
  revision: 1,
  provenance,
  createdAt: at,
  updatedAt: at,
};

const goal = {
  ...base,
  kind: "goal" as const,
  goalId: "goal-1",
  title: "Ship Project Loop",
  description: "Deliver the authoritative project loop.",
  status: "active" as const,
  confirmedBy: human1,
  confirmedAt: at,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  supersedesGoalId: null,
  supersededByGoalId: null,
  supersedeReason: null,
};

const proposedDecision = {
  ...base,
  kind: "decision" as const,
  decisionId: "decision-1",
  statement: "Use durable project facts.",
  status: "proposed" as const,
  confirmedBy: null,
  confirmedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  supersedesDecisionId: null,
  supersededByDecisionId: null,
  supersedeReason: null,
  affectedFactIds: [] as const,
};

const pendingRequest = {
  ...base,
  kind: "request" as const,
  requestId: "request-1",
  title: "Review the release",
  description: "Please review the release candidate.",
  requester: human1,
  target: human2,
  acceptanceMode: "next_action" as const,
  status: "pending_acceptance" as const,
  resolutionActor: null,
  resolvedAt: null,
  responsibilityLink: null,
  transferChain: [] as const,
};

const humanAction = {
  ...base,
  kind: "next_action" as const,
  nextActionId: "action-1",
  title: "Review the release",
  description: "Review the release candidate.",
  owner: human2,
  status: "in_progress" as const,
  dueAt: later,
  deliverable: "A written release review",
  acceptanceCriteria: [] as const,
  verifier: null,
  acceptedBy: human2,
  acceptedAt: at,
  delivery: null,
  completedBy: null,
  completedAt: null,
  statusReason: null,
  reassignmentChain: [] as const,
};

const blocker = {
  ...base,
  kind: "blocker" as const,
  obstacleId: "obstacle-1",
  title: "CI access unavailable",
  description: "The CI principal cannot read the project.",
  impact: "The release cannot complete.",
  resolutionCriteria: "CI can read the project.",
  question: null,
  owner: agent1,
  status: "open" as const,
  dueAt: later,
  reviewAt: null,
  statusReason: null,
  escalationBoundaryId: null,
  resultSource: null,
  transferChain: [] as const,
};

const proposal = {
  recordVersion: "project-loop.v1" as const,
  proposalId: "proposal-1",
  roomId: "room-1",
  projectId: "room-1",
  revision: 1,
  targetKind: "decision" as const,
  targetId: "decision-1",
  baseRevision: 1,
  payload: {
    kind: "decision" as const,
    statement: "Use durable project facts.",
    supersedesDecisionId: null,
    affectedFactIds: [] as const,
  },
  proposer: agent1,
  principalActorId: "human-1",
  state: "pending" as const,
  provenance: { source: { ...source, kind: "agent_execution" as const }, proposedBy: agent1 },
  createdAt: at,
  expiresAt: later,
  resolvedAt: null,
  resolutionReason: null,
};

const transferProposal = {
  recordVersion: "project-loop.v1" as const,
  transferProposalId: "transfer-1",
  roomId: "room-1",
  projectId: "room-1",
  revision: 1,
  subjectKind: "next_action" as const,
  subjectId: "action-1",
  subjectRevision: 1,
  fromOwner: human2,
  toOwner: agent1,
  proposedBy: human2,
  principalActorId: "human-1",
  reason: "The Agent can finish the build.",
  status: "pending" as const,
  proposedAt: at,
  expiresAt: later,
  resolvedBy: null,
  resolvedAt: null,
  resolutionReason: null,
};

const confirmation = {
  recordVersion: "project-loop.v1" as const,
  confirmationId: "confirmation-1",
  proposalId: "proposal-1",
  roomId: "room-1",
  projectId: "room-1",
  revision: 1,
  principalActorId: "human-1",
  baseRevision: 1,
  payloadDigest: "sha256:0123456789abcdef",
  state: "pending" as const,
  createdAt: at,
  expiresAt: later,
  resolvedBy: null,
  resolvedAt: null,
  resolutionReason: null,
};

function hidden<T extends object>(value: T, key: PropertyKey, injected: unknown): T {
  Object.defineProperty(value, key, { configurable: true, enumerable: false, value: injected });
  return value;
}

describe("FT-09 Project Loop closed core contracts", () => {
  it("exports the complete canonical surface without replacing legacy work contracts", () => {
    expect(core.PROJECT_LOOP_LIMITS).toBe(PROJECT_LOOP_LIMITS);
    expect(core.isProjectGoal).toBe(isProjectGoal);
    expect(core.isProjectDecision).toBe(isProjectDecision);
    expect(core.isProjectRequest).toBe(isProjectRequest);
    expect(core.isProjectObstacle).toBe(isProjectObstacle);
    expect(core.isProjectNextAction).toBe(isProjectNextAction);
    expect(core.isProjectProposal).toBe(isProjectProposal);
    expect(core.isProjectSnapshot).toBe(isProjectSnapshot);
    expect(core.isOpenItem).toBeTypeOf("function");
    expect(core.isLightTask).toBeTypeOf("function");
  });

  it("accepts exact room-scoped canonical facts and rejects excess, hidden, oversized, and cross-room data", () => {
    expect(isProjectGoal(goal)).toBe(true);
    expect(isProjectGoal({
      ...goal,
      status: "proposed",
      confirmedBy: null,
      confirmedAt: null,
    })).toBe(true);
    expect(isProjectDecision(proposedDecision)).toBe(true);
    expect(isProjectDecision({ ...proposedDecision, status: "confirmed", confirmedBy: human1,
      confirmedAt: at, supersedesDecisionId: "decision-0", supersedeReason: "New evidence" })).toBe(true);
    expect(isProjectDecision({ ...proposedDecision, status: "confirmed", confirmedBy: human1,
      confirmedAt: at, supersedesDecisionId: "decision-0", supersedeReason: null })).toBe(false);
    expect(isProjectRequest(pendingRequest)).toBe(true);
    expect(isProjectNextAction(humanAction)).toBe(true);
    expect(isProjectObstacle(blocker)).toBe(true);
    expect([goal, proposedDecision, pendingRequest, humanAction, blocker].every(isProjectFact)).toBe(true);

    expect(isProjectGoal({ ...goal, projectId: "project-2" })).toBe(false);
    expect(isProjectGoal({ ...goal, revision: 0 })).toBe(false);
    expect(isProjectGoal({ ...goal, title: "x".repeat(PROJECT_LOOP_LIMITS.titleUtf8 + 1) })).toBe(false);
    expect(isProjectGoal({ ...goal, token: "secret" })).toBe(false);
    expect(isProjectGoal(hidden({ ...goal }, "providerMetadata", "secret"))).toBe(false);
    expect(isProjectDecision({ ...proposedDecision, confirmedBy: human1 })).toBe(false);
    expect(isProjectDecision({ ...proposedDecision, affectedFactIds: ["fact-1", "fact-1"] })).toBe(false);
    expect(isProjectRequest({ ...pendingRequest, target: agent1 })).toBe(false);
    expect(isProjectRequest({ ...pendingRequest, acceptanceMode: "information" })).toBe(false);
    expect(isProjectRequest({ ...pendingRequest, provenance: { ...provenance, source: { ...source, roomId: "room-2" } } })).toBe(false);
    expect(isProjectRequest({ ...pendingRequest, provenance: {
      ...provenance, source: { ...source, kind: "project_boundary" },
    } })).toBe(false);
    expect(isProjectNextAction({ ...humanAction, verifier: human2 })).toBe(false);
    expect(isProjectObstacle({ ...blocker, status: "deferred", reviewAt: null, statusReason: "later" })).toBe(false);
    expect(isProjectObstacle({ ...blocker, status: "cannot_answer", statusReason: "unknown", escalationBoundaryId: null })).toBe(false);
    expect(isProjectBlocker(blocker)).toBe(true);
    expect(isProjectOpenQuestion({
      ...blocker,
      kind: "open_question",
      resolutionCriteria: null,
      question: "Which CI principal should own access?",
    })).toBe(true);
    expect(isProjectOpenQuestion({ ...blocker, kind: "open_question" })).toBe(false);
  });

  it("enforces confirmation, transfer, delivery, and terminal-state invariants", () => {
    expect(isProjectProposal(proposal)).toBe(true);
    expect(isProjectConfirmation(confirmation)).toBe(true);
    expect(isProjectTransferProposal(transferProposal)).toBe(true);
    expect(isProjectProposal({ ...proposal, principalActorId: "" })).toBe(false);
    expect(isProjectProposal({ ...proposal, payload: { ...proposal.payload, kind: "goal" } })).toBe(false);
    expect(isProjectConfirmation({ ...confirmation, projectId: "project-2" })).toBe(false);
    expect(isProjectConfirmation({ ...confirmation, state: "confirmed", resolvedBy: null })).toBe(false);
    expect(isProjectTransferProposal({ ...transferProposal, subjectRevision: 0 })).toBe(false);
    expect(isProjectTransferProposal({ ...transferProposal, fromOwner: agent1 })).toBe(false);

    const acceptedRequest = {
      ...pendingRequest,
      revision: 2,
      status: "accepted" as const,
      resolutionActor: human2,
      resolvedAt: later,
      responsibilityLink: { kind: "next_action" as const, sourceId: "action-1" },
      updatedAt: later,
    };
    expect(isProjectRequest(acceptedRequest)).toBe(true);
    expect(isProjectRequest({ ...acceptedRequest, responsibilityLink: null })).toBe(false);

    const deliveredAgentAction = {
      ...humanAction,
      owner: agent1,
      verifier: human1,
      acceptedBy: human1,
      status: "delivered" as const,
      delivery: { source: { ...source, sourceId: "message-2" }, summary: "Build ready" },
    };
    expect(isProjectNextAction(deliveredAgentAction)).toBe(true);
    expect(isProjectNextAction({ ...deliveredAgentAction, verifier: null })).toBe(false);
    expect(isProjectNextAction({ ...deliveredAgentAction, status: "done", completedBy: agent1, completedAt: later })).toBe(false);

    const reassignedAndAccepted = {
      ...humanAction,
      revision: 2,
      owner: human1,
      acceptedBy: human1,
      acceptedAt: later,
      status: "accepted" as const,
      updatedAt: later,
      reassignmentChain: [{
        from: human2,
        to: human1,
        initiatedBy: human2,
        confirmedBy: human1,
        reason: "Move work to the available owner",
        reassignedAt: at,
      }],
    };
    expect(isProjectNextAction(reassignedAndAccepted)).toBe(true);
  });

  it("enumerates legal and illegal transitions, including the Human direct-done exception", () => {
    expect(canTransitionProjectGoal("proposed", "active")).toBe(true);
    expect(canTransitionProjectGoal("active", "superseded")).toBe(true);
    expect(canTransitionProjectGoal("rejected", "active")).toBe(false);
    expect(canTransitionProjectDecision("proposed", "confirmed")).toBe(true);
    expect(canTransitionProjectDecision("proposed", "rejected")).toBe(true);
    expect(canTransitionProjectDecision("confirmed", "superseded")).toBe(true);
    expect(canTransitionProjectDecision("confirmed", "rejected")).toBe(false);

    expect(canTransitionProjectRequest("pending_acceptance", "accepted")).toBe(true);
    expect(canTransitionProjectRequest("pending_acceptance", "pending_acceptance", "transfer")).toBe(true);
    expect(canTransitionProjectRequest("accepted", "cancelled")).toBe(false);

    expect(canTransitionProjectNextAction("proposed", "accepted", { ownerKind: "agent", hasVerifier: true })).toBe(true);
    expect(canTransitionProjectNextAction("in_progress", "done", { ownerKind: "human", hasVerifier: false })).toBe(true);
    expect(canTransitionProjectNextAction("in_progress", "done", { ownerKind: "human", hasVerifier: true })).toBe(false);
    expect(canTransitionProjectNextAction("in_progress", "done", { ownerKind: "agent", hasVerifier: true })).toBe(false);
    expect(canTransitionProjectNextAction("done", "in_progress", { ownerKind: "human", hasVerifier: false }, "reopen")).toBe(true);
    expect(canTransitionProjectNextAction("cancelled", "proposed", { ownerKind: "human", hasVerifier: false }, "reassign")).toBe(false);

    expect(canTransitionProjectObstacle("open", "deferred")).toBe(true);
    expect(canTransitionProjectObstacle("deferred", "open", "review_due")).toBe(true);
    expect(canTransitionProjectObstacle("cannot_answer", "open", "transfer")).toBe(true);
    expect(canTransitionProjectObstacle("resolved", "open", "transfer")).toBe(false);
    expect(canTransitionProjectObstacle("resolved", "open", "reopen")).toBe(true);
    expect(canTransitionProjectTransferProposal("pending", "accepted")).toBe(true);
    expect(canTransitionProjectTransferProposal("accepted", "rejected")).toBe(false);
    expect(isProjectRevisionCurrent(4, 4)).toBe(true);
    expect(isProjectRevisionCurrent(4, 3)).toBe(false);
    expect(isProjectRevisionCurrent(0, 0)).toBe(false);
  });

  it("derives one deterministic Ball per active source and migrates responsibility", () => {
    const balls = deriveProjectBallFacts({
      roomId: "room-1",
      projectId: "room-1",
      requests: [pendingRequest],
      nextActions: [humanAction],
      obstacles: [blocker],
      proposals: [proposal],
      confirmations: [confirmation],
      transferProposals: [transferProposal],
    });
    expect(balls).toHaveLength(5);
    expect(new Set(balls.map((ball) => `${ball.sourceKind}:${ball.sourceId}`)).size).toBe(5);
    expect(balls.every(isProjectBallFact)).toBe(true);
    expect(isProjectBallFact({ ...balls[0], sourceRevision: 0 })).toBe(false);
    expect(isProjectBallFact({ ...balls[0], boundaryKind: "message" })).toBe(false);
    expect(balls.find((ball) => ball.sourceKind === "request")?.holder).toEqual(human1);
    expect(balls.find((ball) => ball.sourceKind === "next_action")?.holder).toEqual(human2);
    expect(balls.find((ball) => ball.sourceKind === "blocker")?.holder).toEqual(agent1);
    expect(balls.find((ball) => ball.sourceKind === "confirmation")?.holder).toEqual(human1);
    expect(balls.find((ball) => ball.sourceKind === "transfer")?.holder).toEqual(human1);
    expect(deriveProjectBallFacts({
      roomId: "room-1",
      projectId: "room-2",
      requests: [], nextActions: [], obstacles: [], proposals: [], confirmations: [], transferProposals: [],
    })).toEqual([]);
    expect(deriveProjectBallFacts({
      roomId: "room-1",
      projectId: "room-1",
      requests: [{ ...pendingRequest, roomId: "room-2", projectId: "room-2" }],
      nextActions: [], obstacles: [], proposals: [], confirmations: [], transferProposals: [],
    })).toEqual([]);
  });

  it("validates stable events, snapshots, and repair records as closed cross-linked projections", () => {
    const balls = deriveProjectBallFacts({
      roomId: "room-1", projectId: "room-1", requests: [pendingRequest],
      nextActions: [humanAction], obstacles: [blocker], proposals: [proposal],
      confirmations: [confirmation], transferProposals: [transferProposal],
    });
    const event = {
      eventId: "event-1",
      streamKind: "room" as const,
      streamId: "room-1",
      streamSeq: 7,
      roomId: "room-1",
      projectId: "room-1",
      actorId: "human-1",
      occurredAt: at,
      type: "project.request.changed" as const,
      payload: pendingRequest,
    };
    const snapshot = {
      recordVersion: "project-loop.v1" as const,
      roomId: "room-1",
      projectId: "room-1",
      watermark: 7,
      goals: [goal],
      decisions: [proposedDecision],
      requests: [pendingRequest],
      obstacles: [blocker],
      nextActions: [humanAction],
      proposals: [proposal],
      confirmations: [confirmation],
      transferProposals: [transferProposal],
      balls,
      capturedAt: later,
    };
    expect(isProjectEvent(event)).toBe(true);
    expect(isProjectSnapshot(snapshot)).toBe(true);
    expect(isProjectRepairRecord({ kind: "project-loop", roomId: "room-1", value: snapshot }, "room-1")).toBe(true);
    expect(isProjectEvent({ ...event, streamId: "room-2" })).toBe(false);
    expect(isProjectEvent({ ...event, type: "project.request.changed", payload: goal })).toBe(false);
    expect(isProjectSnapshot({ ...snapshot, goals: [goal, { ...goal, goalId: "goal-2" }] })).toBe(false);
    expect(isProjectSnapshot({ ...snapshot, requests: [pendingRequest, pendingRequest] })).toBe(false);
    expect(isProjectSnapshot({ ...snapshot, transferProposals: [
      transferProposal,
      { ...transferProposal, transferProposalId: "transfer-2" },
    ] })).toBe(false);
    expect(isProjectSnapshot({ ...snapshot, balls: balls.map((item, index) =>
      index === 0 ? { ...item, holder: human2 } : item) })).toBe(false);
    expect(isProjectRepairRecord({ kind: "project-loop", roomId: "room-2", value: snapshot }, "room-2")).toBe(false);
    expect(isProjectRepairRecord({ kind: "project-loop", roomId: "room-1", value: { ...snapshot, prompt: "hidden" } })).toBe(false);
  });
});
