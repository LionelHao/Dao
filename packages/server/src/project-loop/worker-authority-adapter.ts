import type { JsonValue } from "../persistence/contracts.js";
import type { ProjectSourceRef } from "@native-im/core";
import type {
  ProjectLoopAuthorityOperation,
  ProjectLoopAuthorityResult,
  ProjectLoopFactKind,
} from "./authority-protocol.js";
import type { ProjectLoopAuthorityTransport } from "../project-loop-websocket.js";
import type {
  ProjectLoopClientFrame,
  ProjectLoopServerFrame,
  PublicProjectProposalPayload,
} from "../project-loop-protocol.js";
import type {
  AuthenticatedCommandContext,
  AuthenticatedSessionContext,
} from "../persistence/contracts.js";

const PUBLIC_PROPOSAL_EXPIRY_MS = 15 * 60 * 1_000;

type ReadFrame = Extract<ProjectLoopClientFrame, { readonly type: "project.snapshot.read" }>;
type MutationFrame = Exclude<ProjectLoopClientFrame, ReadFrame>;

export interface ProjectLoopWorkerAuthority {
  executeProjectLoop(operation: ProjectLoopAuthorityOperation): Promise<ProjectLoopAuthorityResult>;
}

function payload(value: PublicProjectProposalPayload): Readonly<Record<string, JsonValue>> {
  if (value.kind === "goal") return value as unknown as Readonly<Record<string, JsonValue>>;
  return Object.freeze({
    title: value.statement,
    rationale: value.statement,
    statement: value.statement,
    supersedesDecisionId: value.supersedesDecisionId,
    affectedFactIds: value.affectedFactIds as unknown as JsonValue,
  });
}

function source(value: ProjectSourceRef) {
  return {
    roomId: value.roomId,
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
    visibility: value.visibility,
    kind: value.kind,
  } as const;
}

function mutationOperation(
  context: AuthenticatedCommandContext,
  frame: MutationFrame,
  now: number,
): ProjectLoopAuthorityOperation {
  if (frame.type === "project.proposal.create") {
    return {
      type: "project-loop.proposal.create",
      context,
      command: {
        proposalId: frame.proposalId,
        roomId: frame.roomId,
        projectId: frame.projectId,
        factKind: frame.payload.kind,
        factId: `fact:${frame.proposalId}`,
        baseRevision: frame.baseRevision ?? 0,
        principalActorId: context.principal.actorId,
        expiresAt: new Date(now + PUBLIC_PROPOSAL_EXPIRY_MS).toISOString(),
        payload: payload(frame.payload),
        source: source(frame.source),
      },
      now,
    };
  }
  if (frame.type === "project.proposal.resolve") {
    return {
      type: "project-loop.proposal.resolve",
      context,
      command: {
        proposalId: frame.proposalId,
        roomId: frame.roomId,
        projectId: frame.projectId,
        expectedRevision: frame.expectedRevision,
        resolution: frame.resolution,
        reason: frame.reason,
      },
      now,
    };
  }

  let factKind: ProjectLoopFactKind;
  let factId: string;
  let expectedRevision: number;
  let transition: Extract<ProjectLoopAuthorityOperation,
    { readonly type: "project-loop.fact.transition" }>["command"]["transition"];
  let transitionPayload: Readonly<Record<string, JsonValue>>;

  if (frame.type === "project.request.transition") {
    factKind = "request";
    factId = frame.factId;
    expectedRevision = frame.expectedRevision;
    transition = `request.${frame.action}`;
    transitionPayload = frame.action === "accept" ? {} : frame.action === "transfer"
      ? { targetHumanActorId: frame.target.actorId, reason: frame.reason }
      : { reason: frame.reason };
  } else if (frame.type === "project.next-action.transition") {
    factKind = "next_action";
    factId = frame.factId;
    expectedRevision = frame.expectedRevision;
    transition = `next_action.${frame.action}`;
    switch (frame.action) {
      case "accept":
      case "start": transitionPayload = {}; break;
      case "complete": transitionPayload = {
        completionNote: frame.completionNote,
        criteriaSnapshot: frame.criteriaSnapshot as unknown as JsonValue,
      }; break;
      case "deliver": transitionPayload = {
        source: source(frame.source), summary: frame.summary,
      }; break;
      case "reject":
      case "cancel":
      case "reopen": transitionPayload = { reason: frame.reason }; break;
    }
  } else if (frame.type === "project.obstacle.transition") {
    factKind = frame.obstacleKind;
    factId = frame.factId;
    expectedRevision = frame.expectedRevision;
    transition = `obstacle.${frame.action}`;
    if (frame.action === "resolve") {
      transitionPayload = { source: source(frame.resultSource), reason: frame.reason };
    } else if (frame.action === "defer") {
      transitionPayload = { reason: frame.reason, reviewAt: frame.reviewAt };
    } else transitionPayload = { reason: frame.reason };
  } else if (frame.type === "project.transfer.propose") {
    factKind = frame.subjectKind;
    factId = frame.subjectId;
    expectedRevision = frame.expectedRevision;
    transition = frame.subjectKind === "next_action"
      ? "next_action.transfer_propose" : "obstacle.transfer_propose";
    transitionPayload = {
      transferProposalId: frame.transferProposalId,
      toOwnerKind: frame.toOwner.kind,
      toOwnerActorId: frame.toOwner.actorId,
      reason: frame.reason,
      expiresAt: new Date(now + PUBLIC_PROPOSAL_EXPIRY_MS).toISOString(),
    };
  } else {
    factKind = frame.subjectKind;
    factId = frame.subjectId;
    expectedRevision = frame.expectedRevision;
    transition = frame.subjectKind === "next_action"
      ? `next_action.transfer_${frame.resolution === "accepted" ? "accept" : "reject"}`
      : `obstacle.transfer_${frame.resolution === "accepted" ? "accept" : "reject"}`;
    transitionPayload = { transferProposalId: frame.transferProposalId };
  }
  return {
    type: "project-loop.fact.transition",
    context,
    command: {
      roomId: frame.roomId,
      projectId: frame.projectId,
      factKind,
      factId,
      expectedRevision,
      transition,
      payload: transitionPayload,
    },
    now,
  };
}

function publicResult(requestId: string, result: ProjectLoopAuthorityResult): ProjectLoopServerFrame {
  return result.kind === "project-loop-snapshot"
    ? { type: "project.snapshot", requestId, snapshot: result.snapshot,
        events: result.events, nextEventSeq: result.nextEventSeq }
    : { type: "project.mutation.ack", requestId, roomId: result.roomId,
        projectId: result.projectId, acceptedRevision: result.acceptedRevision,
        eventIds: result.eventIds, replayed: result.replayed };
}

export function createProjectLoopWorkerAuthorityTransport(
  authority: ProjectLoopWorkerAuthority,
  clock: () => number = Date.now,
): ProjectLoopAuthorityTransport {
  return Object.freeze({
    async executeQuery(context: AuthenticatedSessionContext, frame: ReadFrame) {
      const result = await authority.executeProjectLoop({
        type: "project-loop.snapshot.read",
        context,
        roomId: frame.roomId,
        projectId: frame.projectId,
        afterEventSeq: frame.afterEventSeq,
        limit: frame.limit,
        now: clock(),
      });
      return publicResult(frame.requestId, result);
    },
    async executeMutation(context: AuthenticatedCommandContext, frame: MutationFrame) {
      return publicResult(frame.requestId,
        await authority.executeProjectLoop(mutationOperation(context, frame, clock())));
    },
  });
}
