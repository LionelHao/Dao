import type { DatabaseSync } from "node:sqlite";
import {
  deriveProjectBallFacts,
  isProjectEvent,
  isProjectSnapshot,
  type ProjectActorRef,
  type ProjectConfirmation,
  type ProjectDecision,
  type ProjectFact,
  type ProjectEvent,
  type ProjectGoal,
  type ProjectNextAction,
  type ProjectObstacle,
  type ProjectProposal,
  type ProjectProposalPayload,
  type ProjectRequest,
  type ProjectSnapshot,
  type ProjectSourceRef,
  type ProjectTransferProposal,
} from "@native-im/core";
import type { JsonValue } from "../persistence/contracts.js";
import { ProjectLoopAuthorityError } from "./database-authority.js";

type Row = Record<string, unknown>;

function fail(message: string): never {
  throw new ProjectLoopAuthorityError("storage_unavailable", message);
}

function parseObject(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "string") return fail("Canonical Project JSON is missing");
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, JsonValue>;
  } catch { return fail("Canonical Project JSON is corrupt"); }
}

function parseArray(value: unknown): readonly JsonValue[] {
  if (typeof value !== "string") return fail("Canonical Project array is missing");
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed as readonly JsonValue[];
  } catch { return fail("Canonical Project array is corrupt"); }
}

function required(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) return fail(`Canonical Project ${key} is missing`);
  return value;
}

function nullable(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return required(row, key);
}

function positive(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return fail(`Canonical Project ${key} is invalid`);
  }
  return value;
}

function actor(kind: unknown, actorId: unknown): ProjectActorRef {
  if ((kind !== "human" && kind !== "agent") || typeof actorId !== "string") {
    return fail("Canonical Project actor is corrupt");
  }
  return Object.freeze({ kind, actorId });
}

function human(actorId: unknown): Readonly<{ kind: "human"; actorId: string }> {
  if (typeof actorId !== "string") return fail("Canonical Project Human is corrupt");
  return Object.freeze({ kind: "human", actorId });
}

function source(row: Row): ProjectSourceRef {
  const kind = row.source_kind;
  if (kind !== "message" && kind !== "attachment" && kind !== "agent_execution" &&
      kind !== "memory" && kind !== "project_fact" && kind !== "legacy") {
    return fail("Canonical Project source kind is corrupt");
  }
  return Object.freeze({ kind, sourceId: required(row, "source_id"),
    sourceRevision: positive(row, "source_revision"), roomId: required(row, "room_id"),
    visibility: "room" as const });
}

function provenance(row: Row) {
  return Object.freeze({ source: source(row),
    proposedBy: actor(row.proposed_by_kind ?? row.created_by_kind,
      row.proposed_by_actor_id ?? row.created_by_actor_id) });
}

function base(row: Row) {
  const roomId = required(row, "room_id");
  return { recordVersion: "project-loop.v1" as const, roomId, projectId: roomId,
    revision: positive(row, "revision"), provenance: provenance(row),
    createdAt: required(row, "created_at"), updatedAt: required(row, "updated_at") };
}

function transitionActor(database: DatabaseSync, roomId: string, kind: string, id: string,
  status: string): { actor: ProjectActorRef | null; at: string | null } {
  if (status === "pending_acceptance" || status === "proposed") return { actor: null, at: null };
  const row = database.prepare(
    `SELECT actor_kind AS kind, actor_id AS actorId, occurred_at AS occurredAt
     FROM project_events WHERE room_id = ? AND fact_kind = ? AND fact_id = ?
       AND event_type = 'fact.transitioned' ORDER BY event_seq DESC LIMIT 1`,
  ).get(roomId, kind, id) as Row | undefined;
  return row === undefined ? { actor: null, at: null }
    : { actor: actor(row.kind, row.actorId), at: required(row, "occurredAt") };
}

function mapGoals(database: DatabaseSync, roomId: string): readonly ProjectGoal[] {
  return Object.freeze((database.prepare(
    `SELECT goal.*, creator.kind AS created_by_kind FROM project_goals AS goal
     JOIN actors AS creator ON creator.id = goal.created_by_actor_id
     WHERE goal.room_id = ? ORDER BY goal.id`,
  ).all(roomId) as Row[]).map((row) => {
    const confirmedBy = human(row.confirmed_by_human_actor_id);
    const value: ProjectGoal = Object.freeze({ ...base(row), kind: "goal",
      goalId: required(row, "id"), title: required(row, "title"),
      description: required(row, "description"), status: row.status as ProjectGoal["status"],
      confirmedBy, confirmedAt: required(row, "created_at"), rejectedBy: null,
      rejectedAt: null, rejectionReason: null, supersedesGoalId: nullable(row, "supersedes_goal_id"),
      supersededByGoalId: nullable(row, "superseded_by_goal_id"),
      supersedeReason: row.status === "superseded" ? "Superseded by a confirmed Goal." :
        row.supersedes_goal_id === null ? null : "Supersedes the prior active Goal." });
    return value;
  }));
}

function proposalPayload(kind: string, raw: Record<string, JsonValue>): ProjectProposalPayload {
  if (kind === "goal") return Object.freeze({ kind, title: String(raw.title),
    description: String(raw.description), supersedesGoalId: raw.supersedesGoalId as string | null ?? null,
    reason: raw.supersedesGoalId === null || raw.supersedesGoalId === undefined ? null :
      typeof raw.reason === "string" ? raw.reason : "Supersedes the prior active Goal." });
  if (kind === "decision") return Object.freeze({ kind, statement: String(raw.statement ?? raw.title),
    supersedesDecisionId: raw.supersedesDecisionId as string | null ?? null,
    affectedFactIds: Array.isArray(raw.affectedFactIds) ? raw.affectedFactIds as string[] : [] });
  if (kind === "request") return Object.freeze({ kind, title: String(raw.title),
    description: String(raw.description), requester: raw.requester as never ??
      { kind: "human", actorId: String(raw.requesterHumanActorId ?? "") },
    target: raw.target as never ?? { kind: "human", actorId: String(raw.targetHumanActorId) },
    acceptanceMode: raw.acceptanceMode as "next_action" | "open_question" | "blocker" });
  if (kind === "next_action") {
    const criteria = Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria :
      typeof raw.acceptanceCriteria === "string" ? JSON.parse(raw.acceptanceCriteria) : [];
    return Object.freeze({ kind, title: String(raw.title), description: String(raw.description),
      owner: raw.owner as never ?? { kind: raw.ownerKind, actorId: raw.ownerActorId },
      dueAt: raw.dueAt as string | null ?? null, deliverable: String(raw.deliverable),
      acceptanceCriteria: criteria as never, verifier: raw.verifier as never ??
        (raw.verifierHumanActorId ? { kind: "human", actorId: raw.verifierHumanActorId } : null) });
  }
  const obstacleKind = kind as "blocker" | "open_question";
  return Object.freeze({ kind: obstacleKind, title: String(raw.title), description: String(raw.description),
    impact: String(raw.impact), resolutionCriteria: obstacleKind === "blocker"
      ? String(raw.resolutionCriteria) : null, question: obstacleKind === "open_question"
      ? String(raw.question) : null, owner: raw.owner as never ??
      { kind: raw.ownerKind, actorId: raw.ownerActorId }, dueAt: raw.dueAt as string | null ?? null,
    reviewAt: raw.reviewAt as string | null ?? null });
}

function mapDecisions(database: DatabaseSync, roomId: string): readonly ProjectDecision[] {
  return Object.freeze((database.prepare(
    `SELECT decision.*, creator.kind AS created_by_kind,
            proposal.payload_json AS proposal_payload_json
     FROM project_decisions AS decision
     JOIN actors AS creator ON creator.id = decision.created_by_actor_id
     LEFT JOIN project_fact_proposals AS proposal ON proposal.room_id = decision.room_id
       AND proposal.fact_kind = 'decision' AND proposal.fact_id = decision.id
       AND proposal.status = 'confirmed'
     WHERE decision.room_id = ? ORDER BY decision.id`,
  ).all(roomId) as Row[]).map((row) => {
    const raw = row.proposal_payload_json === null ? {} : parseObject(row.proposal_payload_json);
    return Object.freeze({ ...base(row), kind: "decision", decisionId: required(row, "id"),
      statement: required(row, "rationale"), status: row.status as ProjectDecision["status"],
      confirmedBy: human(row.confirmed_by_human_actor_id), confirmedAt: required(row, "created_at"),
      rejectedBy: null, rejectedAt: null, rejectionReason: null,
      supersedesDecisionId: nullable(row, "supersedes_decision_id"),
      supersededByDecisionId: nullable(row, "superseded_by_decision_id"),
      supersedeReason: row.status === "superseded" ? "Superseded by a confirmed Decision." : null,
      affectedFactIds: Object.freeze(Array.isArray(raw.affectedFactIds)
        ? raw.affectedFactIds.filter((item): item is string => typeof item === "string") : []) });
  }));
}

function requestTransfers(database: DatabaseSync, roomId: string, id: string) {
  return Object.freeze((database.prepare(
    `SELECT chain.*, initiator.kind AS initiated_by_kind
     FROM project_transfer_chain AS chain
     JOIN actors AS initiator ON initiator.id = chain.accepted_by_human_actor_id
     WHERE chain.room_id = ? AND chain.subject_kind = 'request' AND chain.subject_id = ?
     ORDER BY chain.subject_revision`,
  ).all(roomId, id) as Row[]).map((row) => Object.freeze({
    from: human(row.from_owner_actor_id), to: human(row.to_owner_actor_id),
    initiatedBy: actor(row.initiated_by_kind, row.accepted_by_human_actor_id),
    reason: required(row, "reason"), transferredAt: required(row, "transferred_at"),
  })));
}

function mapRequests(database: DatabaseSync, roomId: string): readonly ProjectRequest[] {
  return Object.freeze((database.prepare(
    `SELECT request.*, creator.kind AS created_by_kind FROM project_requests AS request
     JOIN actors AS creator ON creator.id = request.created_by_actor_id
     WHERE request.room_id = ? AND request.source_kind <> 'legacy_v14'
       AND request.source_revision IS NOT NULL AND request.visibility_room_id = request.room_id
     ORDER BY request.id`,
  ).all(roomId) as Row[]).map((row) => {
    const status = required(row, "status") as ProjectRequest["status"];
    const transition = row.resolution_actor_id === null ?
      transitionActor(database, roomId, "request", required(row, "id"), status) : {
        actor: actor(row.resolution_actor_kind, row.resolution_actor_id),
        at: nullable(row, "resolved_at"),
      };
    return Object.freeze({ ...base(row), kind: "request", requestId: required(row, "id"),
      title: required(row, "title"), description: required(row, "description"),
      requester: human(row.requester_human_actor_id), target: human(row.target_human_actor_id),
      acceptanceMode: required(row, "request_kind") as ProjectRequest["acceptanceMode"], status,
      resolutionActor: transition.actor, resolvedAt: transition.at,
      responsibilityLink: row.linked_fact_id === null ? null : Object.freeze({
        kind: row.linked_fact_kind === "next_action" ? "next_action" as const :
          "open_question_or_blocker" as const, sourceId: required(row, "linked_fact_id") }),
      transferChain: requestTransfers(database, roomId, required(row, "id")) });
  }));
}

function mapNextActions(database: DatabaseSync, roomId: string): readonly ProjectNextAction[] {
  return Object.freeze((database.prepare(
    `SELECT action.*, creator.kind AS created_by_kind FROM project_next_actions AS action
     JOIN actors AS creator ON creator.id = action.created_by_actor_id
     WHERE action.room_id = ? AND action.source_kind <> 'legacy_v14'
       AND action.source_revision IS NOT NULL AND action.visibility_room_id = action.room_id
     ORDER BY action.id`,
  ).all(roomId) as Row[]).map((row) => {
    const status = required(row, "status") as ProjectNextAction["status"];
    const accepted = row.accepted_by_human_actor_id === null ? null : human(row.accepted_by_human_actor_id);
    const delivery = row.delivery_source_kind === null ? null : Object.freeze({
      source: Object.freeze({ kind: required(row, "delivery_source_kind") as ProjectSourceRef["kind"],
        sourceId: required(row, "delivery_source_id"),
        sourceRevision: positive(row, "delivery_source_revision"),
        roomId: required(row, "delivery_source_room_id"), visibility: "room" as const }),
      summary: required(row, "delivery_summary"),
    });
    return Object.freeze({ ...base(row), kind: "next_action", nextActionId: required(row, "id"),
      title: required(row, "title"), description: required(row, "description"),
      owner: actor(row.owner_kind, row.owner_actor_id), status, dueAt: nullable(row, "due_at"),
      deliverable: required(row, "deliverable"), acceptanceCriteria: Object.freeze(parseArray(row.acceptance_criteria) as never),
      verifier: row.verifier_human_actor_id === null ? null : human(row.verifier_human_actor_id),
      acceptedBy: accepted, acceptedAt: accepted === null ? null : required(row, "accepted_at"),
      delivery, completedBy: row.completed_by_human_actor_id === null ? null :
        human(row.completed_by_human_actor_id), completedAt: nullable(row, "completed_at"),
      statusReason: nullable(row, "status_reason"),
      reassignmentChain: Object.freeze([]) });
  }));
}

function obstacleTransfers(database: DatabaseSync, roomId: string, id: string) {
  return Object.freeze((database.prepare(
    `SELECT chain.*, proposal.created_by_actor_id AS initiated_by_actor_id,
            initiator.kind AS initiated_by_kind
     FROM project_transfer_chain AS chain
     JOIN project_transfer_proposals AS proposal ON proposal.id = chain.transfer_id
     JOIN actors AS initiator ON initiator.id = proposal.created_by_actor_id
     WHERE chain.room_id = ? AND chain.subject_kind IN ('blocker','open_question')
       AND chain.subject_id = ? ORDER BY chain.subject_revision`,
  ).all(roomId, id) as Row[]).map((row) => Object.freeze({
    from: actor(row.from_owner_kind, row.from_owner_actor_id),
    to: actor(row.to_owner_kind, row.to_owner_actor_id),
    initiatedBy: actor(row.initiated_by_kind, row.initiated_by_actor_id),
    confirmedBy: human(row.accepted_by_human_actor_id), reason: required(row, "reason"),
    transferredAt: required(row, "transferred_at"),
  })));
}

function mapObstacles(database: DatabaseSync, roomId: string): readonly ProjectObstacle[] {
  return Object.freeze((database.prepare(
    `SELECT obstacle.*, creator.kind AS created_by_kind FROM project_obstacles AS obstacle
     JOIN actors AS creator ON creator.id = obstacle.created_by_actor_id
     WHERE obstacle.room_id = ? AND obstacle.source_kind <> 'legacy_v14'
       AND obstacle.source_revision IS NOT NULL AND obstacle.visibility_room_id = obstacle.room_id
     ORDER BY obstacle.id`,
  ).all(roomId) as Row[]).map((row) => {
    const kind = required(row, "kind") as "blocker" | "open_question";
    const resultSource = row.result_source_kind === null ? null : Object.freeze({
      kind: required(row, "result_source_kind") as ProjectSourceRef["kind"],
      sourceId: required(row, "result_source_id"),
      sourceRevision: positive(row, "result_source_revision"),
      roomId: required(row, "result_source_room_id"), visibility: "room" as const,
    });
    return Object.freeze({ ...base(row), kind, obstacleId: required(row, "id"),
      title: required(row, "title"), description: required(row, "description"),
      impact: required(row, "impact"), resolutionCriteria: kind === "blocker"
        ? required(row, "resolution_criteria") : null,
      question: kind === "open_question" ? required(row, "question") : null,
      owner: actor(row.owner_kind, row.owner_actor_id), status: row.status as ProjectObstacle["status"],
      dueAt: nullable(row, "due_at"), reviewAt: nullable(row, "review_at"),
      statusReason: nullable(row, "status_reason"),
      escalationBoundaryId: nullable(row, "escalation_boundary_id"),
      resultSource, transferChain: obstacleTransfers(database, roomId, required(row, "id")) }) as ProjectObstacle;
  }));
}

function mapProposals(database: DatabaseSync, roomId: string): readonly ProjectProposal[] {
  return Object.freeze((database.prepare(
    `SELECT proposal.* FROM project_fact_proposals AS proposal
     WHERE room_id = ? ORDER BY id`,
  ).all(roomId) as Row[]).map((row) => {
    const raw = parseObject(row.payload_json);
    if (row.fact_kind === "request") {
      raw.requester = raw.requester ?? { kind: "human", actorId: row.proposed_by_actor_id as string };
      raw.target = raw.target ?? { kind: "human", actorId: raw.targetHumanActorId as string };
    }
    return Object.freeze({ recordVersion: "project-loop.v1", proposalId: required(row, "id"),
      roomId, projectId: roomId, revision: positive(row, "revision"),
      targetKind: required(row, "fact_kind") as ProjectFact["kind"], targetId: required(row, "fact_id"),
      baseRevision: row.base_revision === 0 ? null : positive(row, "base_revision"),
      payload: proposalPayload(required(row, "fact_kind"), raw),
      proposer: actor(row.proposed_by_kind, row.proposed_by_actor_id),
      principalActorId: required(row, "principal_human_actor_id"),
      state: required(row, "status") as ProjectProposal["state"],
      provenance: Object.freeze({ source: source(row),
        proposedBy: actor(row.proposed_by_kind, row.proposed_by_actor_id) }),
      createdAt: required(row, "created_at"), expiresAt: required(row, "expires_at"),
      resolvedAt: nullable(row, "resolved_at"), resolutionReason: nullable(row, "resolution_reason") });
  }));
}

function mapConfirmations(database: DatabaseSync, roomId: string): readonly ProjectConfirmation[] {
  return Object.freeze((database.prepare(
    `SELECT confirmation.* FROM project_confirmations AS confirmation
     WHERE confirmation.room_id = ? ORDER BY confirmation.id`,
  ).all(roomId) as Row[]).map((row) => Object.freeze({ recordVersion: "project-loop.v1",
    confirmationId: required(row, "id"), proposalId: required(row, "proposal_id"), roomId,
    projectId: roomId, revision: positive(row, "revision"),
    principalActorId: required(row, "principal_human_actor_id"),
    baseRevision: row.base_revision === 0 ? null : positive(row, "base_revision"),
    payloadDigest: required(row, "payload_digest"),
    state: required(row, "state") as ProjectConfirmation["state"],
    createdAt: required(row, "created_at"), expiresAt: required(row, "expires_at"),
    resolvedBy: row.resolved_by_human_actor_id === null ? null : human(row.resolved_by_human_actor_id),
    resolvedAt: nullable(row, "resolved_at"), resolutionReason: nullable(row, "resolution_reason") })));
}

function mapTransfers(database: DatabaseSync, roomId: string): readonly ProjectTransferProposal[] {
  const rows = database.prepare(
    `SELECT transfer.*, proposer.kind AS proposed_by_kind
     FROM project_transfer_proposals AS transfer
     LEFT JOIN actors AS proposer ON proposer.id = transfer.created_by_actor_id
     WHERE transfer.room_id = ? AND transfer.source_kind <> 'legacy_v14' ORDER BY transfer.id`,
  ).all(roomId) as Row[];
  return Object.freeze(rows.map((row) => Object.freeze({ recordVersion: "project-loop.v1",
    transferProposalId: required(row, "id"), roomId, projectId: roomId,
    revision: positive(row, "revision"), subjectKind: required(row, "subject_kind") as never,
    subjectId: required(row, "subject_id"), subjectRevision: positive(row, "subject_revision"),
    fromOwner: actor(row.from_owner_kind, row.from_owner_actor_id),
    toOwner: actor(row.to_owner_kind, row.to_owner_actor_id),
    proposedBy: actor(row.proposed_by_kind, row.created_by_actor_id),
    principalActorId: required(row, "principal_human_actor_id"), reason: required(row, "reason"),
    status: required(row, "status") as ProjectTransferProposal["status"],
    proposedAt: required(row, "created_at"), expiresAt: required(row, "expires_at"),
    resolvedBy: row.resolved_by_human_actor_id === null ? null : human(row.resolved_by_human_actor_id),
    resolvedAt: nullable(row, "resolved_at"), resolutionReason: nullable(row, "resolution_reason") })));
}

export function readCanonicalProjectSnapshotDatabaseQuery(database: DatabaseSync, input: {
  roomId: string; projectId: string; watermark: number; capturedAt: string;
}): ProjectSnapshot {
  if (input.projectId !== input.roomId) return fail("Room must equal Project");
  const goals = mapGoals(database, input.roomId);
  const decisions = mapDecisions(database, input.roomId);
  const requests = mapRequests(database, input.roomId);
  const nextActions = mapNextActions(database, input.roomId);
  const obstacles = mapObstacles(database, input.roomId);
  const proposals = mapProposals(database, input.roomId);
  const confirmations = mapConfirmations(database, input.roomId);
  const transferProposals = mapTransfers(database, input.roomId);
  const balls = deriveProjectBallFacts({ roomId: input.roomId, projectId: input.projectId,
    requests, nextActions, obstacles, proposals, confirmations, transferProposals });
  const snapshot: ProjectSnapshot = Object.freeze({ recordVersion: "project-loop.v1",
    roomId: input.roomId, projectId: input.roomId, watermark: input.watermark, goals,
    decisions, requests, obstacles, nextActions, proposals, confirmations, transferProposals,
    balls, capturedAt: input.capturedAt });
  if (!isProjectSnapshot(snapshot)) return fail("Canonical Project snapshot invariant failed");
  return snapshot;
}

export function readCanonicalProjectEventPayloadDatabaseQuery(database: DatabaseSync, input: {
  roomId: string; factKind: ProjectFact["kind"]; factId: string; entity: "fact" | "proposal";
}): ProjectFact | ProjectProposal {
  if (input.entity === "proposal") {
    const proposal = mapProposals(database, input.roomId).find((item) => item.targetId === input.factId &&
      item.targetKind === input.factKind);
    return proposal ?? fail("Canonical Project proposal event payload is missing");
  }
  const facts: readonly ProjectFact[] = input.factKind === "goal" ? mapGoals(database, input.roomId)
    : input.factKind === "decision" ? mapDecisions(database, input.roomId)
      : input.factKind === "request" ? mapRequests(database, input.roomId)
        : input.factKind === "next_action" ? mapNextActions(database, input.roomId)
          : mapObstacles(database, input.roomId);
  const fact = facts.find((item) => item.kind === input.factKind &&
    ("goalId" in item ? item.goalId : "decisionId" in item ? item.decisionId :
      "requestId" in item ? item.requestId : "nextActionId" in item ? item.nextActionId : item.obstacleId) === input.factId);
  return fact ?? fail("Canonical Project fact event payload is missing");
}

export function readCanonicalProjectEventsDatabaseQuery(database: DatabaseSync, input: {
  roomId: string; afterStreamSeq: number; limit: number;
}): readonly ProjectEvent[] {
  const rows = database.prepare(
    `SELECT event_id AS eventId, stream_id AS streamId, stream_seq AS streamSeq,
            room_id AS roomId, actor_id AS actorId, event_type AS type,
            occurred_at AS occurredAt, payload_json AS payloadJson
     FROM events WHERE stream_kind = 'room' AND stream_id = ? AND stream_seq > ?
       AND event_type LIKE 'project.%'
     ORDER BY stream_seq, event_id LIMIT ?`,
  ).all(input.roomId, input.afterStreamSeq, input.limit) as Row[];
  return Object.freeze(rows.map((row) => {
    const roomId = required(row, "roomId");
    const event: ProjectEvent = Object.freeze({ eventId: required(row, "eventId"),
      streamKind: "room", streamId: required(row, "streamId"), streamSeq: positive(row, "streamSeq"),
      roomId, projectId: roomId, actorId: required(row, "actorId"),
      occurredAt: required(row, "occurredAt"), type: required(row, "type") as ProjectEvent["type"],
      payload: parseObject(row.payloadJson) as unknown as ProjectEvent["payload"] });
    if (!isProjectEvent(event)) return fail("Canonical Project event invariant failed");
    return event;
  }));
}
