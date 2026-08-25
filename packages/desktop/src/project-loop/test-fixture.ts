import { deriveProjectBallFacts, type ProjectSnapshot } from "@native-im/core";

const at = "2026-08-25T01:02:03.004Z";
const later = "2026-08-25T02:03:04.005Z";
const human1 = { actorId: "human-1", kind: "human" as const };
const human2 = { actorId: "human-2", kind: "human" as const };
const agent1 = { actorId: "agent-1", kind: "agent" as const };
const source = { kind: "message" as const, sourceId: "message-1", sourceRevision: 1,
  roomId: "room-1", visibility: "room" as const };
const provenance = { source, proposedBy: human1 };
const request = { recordVersion: "project-loop.v1" as const, roomId: "room-1", projectId: "room-1",
  revision: 3, provenance, createdAt: at, updatedAt: at, kind: "request" as const,
  requestId: "request-1", title: "Review release", description: "Review the release candidate",
  requester: human1, target: human2, acceptanceMode: "next_action" as const,
  status: "pending_acceptance" as const, resolutionActor: null, resolvedAt: null,
  responsibilityLink: null, transferChain: [] as const };
const proposal = { recordVersion: "project-loop.v1" as const, proposalId: "proposal-1",
  roomId: "room-1", projectId: "room-1", revision: 4, targetKind: "decision" as const,
  targetId: "decision-1", baseRevision: null, payload: { kind: "decision" as const,
    statement: "Use stable project events", supersedesDecisionId: null, affectedFactIds: [] as const },
  proposer: agent1, principalActorId: "human-1", state: "pending" as const,
  provenance: { source: { ...source, kind: "agent_execution" as const }, proposedBy: agent1 },
  createdAt: at, expiresAt: later, resolvedAt: null, resolutionReason: null };

export function projectSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  const transferProposals = [] as const;
  const balls = deriveProjectBallFacts({ roomId: "room-1", projectId: "room-1", requests: [request],
    nextActions: [], obstacles: [], proposals: [proposal], confirmations: [], transferProposals });
  return { recordVersion: "project-loop.v1", roomId: "room-1", projectId: "room-1", watermark: 7,
    goals: [], decisions: [], requests: [request], obstacles: [], nextActions: [], proposals: [proposal],
    confirmations: [], transferProposals, balls, capturedAt: later, ...overrides };
}
