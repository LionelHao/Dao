export const PROJECT_LOOP_LIMITS = Object.freeze({
  identifierUtf16: 256,
  titleUtf8: 512,
  descriptionUtf8: 8_192,
  reasonUtf8: 2_048,
  criteriaItems: 32,
  transferEntries: 64,
  affectedFactIds: 64,
  snapshotItemsPerKind: 1_000,
});

export type ProjectActorRef = Readonly<{
  actorId: string;
  kind: "human" | "agent";
}>;

export type ProjectHumanRef = Readonly<{
  actorId: string;
  kind: "human";
}>;

export type ProjectSourceRef = Readonly<{
  kind: "message" | "attachment" | "agent_execution" | "memory" | "project_fact" | "legacy";
  sourceId: string;
  sourceRevision: number;
  roomId: string;
  visibility: "room";
}>;

export type ProjectProvenance = Readonly<{
  source: ProjectSourceRef;
  proposedBy: ProjectActorRef;
}>;

type ProjectFactBase = Readonly<{
  recordVersion: "project-loop.v1";
  roomId: string;
  projectId: string;
  revision: number;
  provenance: ProjectProvenance;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectGoalStatus = "proposed" | "active" | "rejected" | "superseded";
export type ProjectGoal = ProjectFactBase & Readonly<{
  kind: "goal";
  goalId: string;
  title: string;
  description: string;
  status: ProjectGoalStatus;
  confirmedBy: ProjectHumanRef | null;
  confirmedAt: string | null;
  rejectedBy: ProjectHumanRef | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  supersedesGoalId: string | null;
  supersededByGoalId: string | null;
  supersedeReason: string | null;
}>;

export type ProjectDecisionStatus = "proposed" | "confirmed" | "rejected" | "superseded";
export type ProjectDecision = ProjectFactBase & Readonly<{
  kind: "decision";
  decisionId: string;
  statement: string;
  status: ProjectDecisionStatus;
  confirmedBy: ProjectHumanRef | null;
  confirmedAt: string | null;
  rejectedBy: ProjectHumanRef | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  supersedesDecisionId: string | null;
  supersededByDecisionId: string | null;
  supersedeReason: string | null;
  affectedFactIds: readonly string[];
}>;

export type ProjectResponsibilityLink = Readonly<{
  kind: "next_action" | "open_question_or_blocker";
  sourceId: string;
}>;

export type ProjectRequestTransfer = Readonly<{
  from: ProjectHumanRef;
  to: ProjectHumanRef;
  initiatedBy: ProjectActorRef;
  reason: string;
  transferredAt: string;
}>;

export type ProjectRequestStatus = "pending_acceptance" | "accepted" | "rejected" | "cancelled";
export type ProjectRequest = ProjectFactBase & Readonly<{
  kind: "request";
  requestId: string;
  title: string;
  description: string;
  requester: ProjectHumanRef;
  target: ProjectHumanRef;
  acceptanceMode: "next_action" | "open_question" | "blocker";
  status: ProjectRequestStatus;
  resolutionActor: ProjectActorRef | null;
  resolvedAt: string | null;
  responsibilityLink: ProjectResponsibilityLink | null;
  transferChain: readonly ProjectRequestTransfer[];
}>;

export type ProjectCriterion = Readonly<{
  criterionId: string;
  text: string;
}>;

export type ProjectDelivery = Readonly<{
  source: ProjectSourceRef;
  summary: string;
}>;

export type ProjectReassignment = Readonly<{
  from: ProjectActorRef;
  to: ProjectActorRef;
  initiatedBy: ProjectActorRef;
  confirmedBy: ProjectHumanRef;
  reason: string;
  reassignedAt: string;
}>;

export type ProjectNextActionStatus =
  | "proposed" | "accepted" | "rejected" | "in_progress" | "delivered" | "done" | "cancelled";
export type ProjectNextAction = ProjectFactBase & Readonly<{
  kind: "next_action";
  nextActionId: string;
  title: string;
  description: string;
  owner: ProjectActorRef;
  status: ProjectNextActionStatus;
  dueAt: string | null;
  deliverable: string;
  acceptanceCriteria: readonly ProjectCriterion[];
  verifier: ProjectHumanRef | null;
  acceptedBy: ProjectHumanRef | null;
  acceptedAt: string | null;
  delivery: ProjectDelivery | null;
  completedBy: ProjectHumanRef | null;
  completedAt: string | null;
  statusReason: string | null;
  reassignmentChain: readonly ProjectReassignment[];
}>;

export type ProjectObstacleKind = "blocker" | "open_question";
export type ProjectObstacleStatus = "open" | "resolved" | "deferred" | "cannot_answer";
export type ProjectObstacleTransfer = Readonly<{
  from: ProjectActorRef;
  to: ProjectActorRef;
  initiatedBy: ProjectActorRef;
  confirmedBy: ProjectHumanRef;
  reason: string;
  transferredAt: string;
}>;
type ProjectObstacleBase = ProjectFactBase & Readonly<{
  obstacleId: string;
  title: string;
  description: string;
  impact: string;
  owner: ProjectActorRef;
  status: ProjectObstacleStatus;
  dueAt: string | null;
  reviewAt: string | null;
  statusReason: string | null;
  escalationBoundaryId: string | null;
  resultSource: ProjectSourceRef | null;
  transferChain: readonly ProjectObstacleTransfer[];
}>;
export type ProjectBlocker = ProjectObstacleBase & Readonly<{
  kind: "blocker";
  resolutionCriteria: string;
  question: null;
}>;
export type ProjectOpenQuestion = ProjectObstacleBase & Readonly<{
  kind: "open_question";
  resolutionCriteria: null;
  question: string;
}>;
export type ProjectObstacle = ProjectBlocker | ProjectOpenQuestion;

export type ProjectFact =
  | ProjectGoal | ProjectDecision | ProjectRequest | ProjectNextAction | ProjectObstacle;

export type ProjectProposalPayload =
  | Readonly<{
      kind: "goal";
      title: string;
      description: string;
      supersedesGoalId: string | null;
      reason: string | null;
    }>
  | Readonly<{
      kind: "decision";
      statement: string;
      supersedesDecisionId: string | null;
      affectedFactIds: readonly string[];
    }>
  | Readonly<{
      kind: "request";
      title: string;
      description: string;
      requester: ProjectHumanRef;
      target: ProjectHumanRef;
      acceptanceMode: "next_action" | "open_question" | "blocker";
    }>
  | Readonly<{
      kind: "next_action";
      title: string;
      description: string;
      owner: ProjectActorRef;
      dueAt: string | null;
      deliverable: string;
      acceptanceCriteria: readonly ProjectCriterion[];
      verifier: ProjectHumanRef | null;
    }>
  | Readonly<{
      kind: "blocker" | "open_question";
      title: string;
      description: string;
      impact: string;
      resolutionCriteria: string | null;
      question: string | null;
      owner: ProjectActorRef;
      dueAt: string | null;
      reviewAt: string | null;
    }>;

export type ProjectProposalState = "pending" | "confirmed" | "rejected" | "cancelled" | "expired";
export type ProjectProposal = Readonly<{
  recordVersion: "project-loop.v1";
  proposalId: string;
  roomId: string;
  projectId: string;
  revision: number;
  targetKind: ProjectFact["kind"];
  targetId: string;
  baseRevision: number | null;
  payload: ProjectProposalPayload;
  proposer: ProjectActorRef;
  principalActorId: string;
  state: ProjectProposalState;
  provenance: ProjectProvenance;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolutionReason: string | null;
}>;

export type ProjectConfirmationState = "pending" | "confirmed" | "rejected" | "expired";
export type ProjectConfirmation = Readonly<{
  recordVersion: "project-loop.v1";
  confirmationId: string;
  proposalId: string;
  roomId: string;
  projectId: string;
  revision: number;
  principalActorId: string;
  baseRevision: number | null;
  payloadDigest: string;
  state: ProjectConfirmationState;
  createdAt: string;
  expiresAt: string;
  resolvedBy: ProjectHumanRef | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
}>;

export type ProjectTransferProposalStatus = "pending" | "accepted" | "rejected" | "cancelled" | "expired";
export type ProjectTransferProposal = Readonly<{
  recordVersion: "project-loop.v1";
  transferProposalId: string;
  roomId: string;
  projectId: string;
  revision: number;
  subjectKind: "next_action" | "blocker" | "open_question";
  subjectId: string;
  subjectRevision: number;
  fromOwner: ProjectActorRef;
  toOwner: ProjectActorRef;
  proposedBy: ProjectActorRef;
  principalActorId: string;
  reason: string;
  status: ProjectTransferProposalStatus;
  proposedAt: string;
  expiresAt: string;
  resolvedBy: ProjectHumanRef | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
}>;

export type ProjectBallSourceKind =
  | "request" | "next_action" | "blocker" | "open_question" | "proposal" | "confirmation"
  | "transfer" | "due" | "review";
export type ProjectBallBoundaryKind =
  | "pending_acceptance" | "pending_confirmation" | "work" | "delivery_verification"
  | "obstacle" | "transfer_acceptance" | "due" | "review" | "escalation";
export type ProjectBallFact = Readonly<{
  recordVersion: "project-loop.v1";
  ballId: string;
  roomId: string;
  projectId: string;
  sourceKind: ProjectBallSourceKind;
  sourceId: string;
  sourceRevision: number;
  holder: ProjectActorRef;
  since: string;
  reason: string;
  boundaryKind: ProjectBallBoundaryKind;
  boundaryId: string;
  dueAt: string | null;
  reviewAt: string | null;
}>;

type ProjectEventType =
  | "project.goal.changed"
  | "project.decision.changed"
  | "project.request.changed"
  | "project.next-action.changed"
  | "project.blocker.changed"
  | "project.open-question.changed"
  | "project.proposal.changed"
  | "project.confirmation.changed"
  | "project.transfer-proposal.changed"
  | "project.ball.changed";

export type ProjectEvent = Readonly<{
  eventId: string;
  streamKind: "room";
  streamId: string;
  streamSeq: number;
  roomId: string;
  projectId: string;
  actorId: string;
  occurredAt: string;
  type: ProjectEventType;
  payload: ProjectFact | ProjectProposal | ProjectConfirmation | ProjectTransferProposal | ProjectBallFact;
}>;

export type ProjectSnapshot = Readonly<{
  recordVersion: "project-loop.v1";
  roomId: string;
  projectId: string;
  watermark: number;
  goals: readonly ProjectGoal[];
  decisions: readonly ProjectDecision[];
  requests: readonly ProjectRequest[];
  obstacles: readonly ProjectObstacle[];
  nextActions: readonly ProjectNextAction[];
  proposals: readonly ProjectProposal[];
  confirmations: readonly ProjectConfirmation[];
  transferProposals: readonly ProjectTransferProposal[];
  balls: readonly ProjectBallFact[];
  capturedAt: string;
}>;

export type ProjectRepairRecord = Readonly<{
  kind: "project-loop";
  roomId: string;
  value: ProjectSnapshot;
}>;

type UnknownRecord = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, required: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === required.length && ownKeys.every((key) =>
    typeof key === "string" && required.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= PROJECT_LOOP_LIMITS.identifierUtf16 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && utf8Length(value) <= limit;
}

function isNullableText(value: unknown, limit: number): value is string | null {
  return value === null || isText(value, limit);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isBoundedArray(value: unknown, limit: number): value is readonly unknown[] {
  return Array.isArray(value) && value.length <= limit && Reflect.ownKeys(value).every((key) =>
    key === "length" || (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)));
}

function hasUniqueIds(values: readonly unknown[], getId: (value: unknown) => string | null): boolean {
  const ids = new Set<string>();
  for (const value of values) {
    const id = getId(value);
    if (id === null || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

function isIdentifierArray(value: unknown, limit: number): value is readonly string[] {
  return isBoundedArray(value, limit) && hasUniqueIds(value, (item) => isIdentifier(item) ? item : null);
}

export function isProjectActorRef(value: unknown): value is ProjectActorRef {
  return isRecord(value) && hasExactKeys(value, ["actorId", "kind"]) &&
    isIdentifier(value.actorId) && (value.kind === "human" || value.kind === "agent");
}

function isProjectHumanRef(value: unknown): value is ProjectHumanRef {
  return isProjectActorRef(value) && value.kind === "human";
}

export function isProjectSourceRef(value: unknown): value is ProjectSourceRef {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "sourceId", "sourceRevision", "roomId", "visibility",
  ]) && (value.kind === "message" || value.kind === "attachment" || value.kind === "agent_execution" ||
      value.kind === "memory" || value.kind === "project_fact" || value.kind === "legacy") &&
    isIdentifier(value.sourceId) && isPositiveInteger(value.sourceRevision) && isIdentifier(value.roomId) &&
    value.visibility === "room";
}

function isProjectProvenance(value: unknown, roomId: string): value is ProjectProvenance {
  return isRecord(value) && hasExactKeys(value, ["source", "proposedBy"]) &&
    isProjectSourceRef(value.source) && value.source.roomId === roomId && isProjectActorRef(value.proposedBy);
}

function isFactBase(value: UnknownRecord): boolean {
  return value.recordVersion === "project-loop.v1" && isIdentifier(value.roomId) &&
    value.projectId === value.roomId && isPositiveInteger(value.revision) &&
    isProjectProvenance(value.provenance, value.roomId) && isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) && Date.parse(value.updatedAt) >= Date.parse(value.createdAt);
}

export function isProjectGoal(value: unknown): value is ProjectGoal {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordVersion", "roomId", "projectId", "revision", "provenance", "createdAt", "updatedAt",
    "kind", "goalId", "title", "description", "status", "confirmedBy", "confirmedAt",
    "rejectedBy", "rejectedAt", "rejectionReason", "supersedesGoalId", "supersededByGoalId",
    "supersedeReason",
  ]) || !isFactBase(value) || value.kind !== "goal" || !isIdentifier(value.goalId) ||
      !isText(value.title, PROJECT_LOOP_LIMITS.titleUtf8) ||
      !isText(value.description, PROJECT_LOOP_LIMITS.descriptionUtf8) ||
      !(value.confirmedBy === null || isProjectHumanRef(value.confirmedBy)) ||
      !isNullableTimestamp(value.confirmedAt) ||
      !(value.rejectedBy === null || isProjectHumanRef(value.rejectedBy)) ||
      !isNullableTimestamp(value.rejectedAt) ||
      !isNullableText(value.rejectionReason, PROJECT_LOOP_LIMITS.reasonUtf8) ||
      !isNullableIdentifier(value.supersedesGoalId) || !isNullableIdentifier(value.supersededByGoalId) ||
      !isNullableText(value.supersedeReason, PROJECT_LOOP_LIMITS.reasonUtf8)) return false;
  if (value.supersedesGoalId === value.goalId || value.supersededByGoalId === value.goalId) return false;
  const unconfirmed = value.confirmedBy === null && value.confirmedAt === null;
  const confirmed = value.confirmedBy !== null && value.confirmedAt !== null;
  const unrejected = value.rejectedBy === null && value.rejectedAt === null && value.rejectionReason === null;
  const rejected = value.rejectedBy !== null && value.rejectedAt !== null && value.rejectionReason !== null;
  if (value.status === "proposed") return unconfirmed && unrejected && value.supersededByGoalId === null;
  if (value.status === "rejected") return unconfirmed && rejected && value.supersedesGoalId === null &&
    value.supersededByGoalId === null && value.supersedeReason === null;
  if (value.status === "active") return confirmed && unrejected && value.supersededByGoalId === null &&
    (value.supersedesGoalId === null ? value.supersedeReason === null : value.supersedeReason !== null);
  return value.status === "superseded" && confirmed && unrejected &&
    value.supersededByGoalId !== null && value.supersedeReason !== null;
}

export function isProjectDecision(value: unknown): value is ProjectDecision {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordVersion", "roomId", "projectId", "revision", "provenance", "createdAt", "updatedAt",
    "kind", "decisionId", "statement", "status", "confirmedBy", "confirmedAt", "rejectedBy",
    "rejectedAt", "rejectionReason", "supersedesDecisionId", "supersededByDecisionId",
    "supersedeReason", "affectedFactIds",
  ]) || !isFactBase(value) || value.kind !== "decision" || !isIdentifier(value.decisionId) ||
      !isText(value.statement, PROJECT_LOOP_LIMITS.descriptionUtf8) ||
      !(value.confirmedBy === null || isProjectHumanRef(value.confirmedBy)) ||
      !isNullableTimestamp(value.confirmedAt) || !(value.rejectedBy === null || isProjectHumanRef(value.rejectedBy)) ||
      !isNullableTimestamp(value.rejectedAt) ||
      !isNullableText(value.rejectionReason, PROJECT_LOOP_LIMITS.reasonUtf8) ||
      !isNullableIdentifier(value.supersedesDecisionId) || !isNullableIdentifier(value.supersededByDecisionId) ||
      !isNullableText(value.supersedeReason, PROJECT_LOOP_LIMITS.reasonUtf8) ||
      !isIdentifierArray(value.affectedFactIds, PROJECT_LOOP_LIMITS.affectedFactIds)) return false;
  if (value.supersedesDecisionId === value.decisionId || value.supersededByDecisionId === value.decisionId) return false;
  const noConfirmation = value.confirmedBy === null && value.confirmedAt === null;
  const confirmed = value.confirmedBy !== null && value.confirmedAt !== null;
  const noRejection = value.rejectedBy === null && value.rejectedAt === null && value.rejectionReason === null;
  const rejected = value.rejectedBy !== null && value.rejectedAt !== null && value.rejectionReason !== null;
  switch (value.status) {
    case "proposed": return noConfirmation && noRejection && value.supersededByDecisionId === null && value.supersedeReason === null;
    case "confirmed": return confirmed && noRejection && value.supersededByDecisionId === null &&
      (value.supersedesDecisionId === null ? value.supersedeReason === null : value.supersedeReason !== null);
    case "rejected": return noConfirmation && rejected && value.supersedesDecisionId === null &&
      value.supersededByDecisionId === null && value.supersedeReason === null;
    case "superseded": return confirmed && noRejection && value.supersededByDecisionId !== null && value.supersedeReason !== null;
    default: return false;
  }
}

function isResponsibilityLink(value: unknown): value is ProjectResponsibilityLink {
  return isRecord(value) && hasExactKeys(value, ["kind", "sourceId"]) &&
    (value.kind === "next_action" || value.kind === "open_question_or_blocker") && isIdentifier(value.sourceId);
}

function isRequestTransfer(value: unknown): value is ProjectRequestTransfer {
  return isRecord(value) && hasExactKeys(value, ["from", "to", "initiatedBy", "reason", "transferredAt"]) &&
    isProjectHumanRef(value.from) && isProjectHumanRef(value.to) &&
    value.from.actorId !== value.to.actorId && isProjectActorRef(value.initiatedBy) &&
    isText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8) && isIsoTimestamp(value.transferredAt);
}

export function isProjectRequest(value: unknown): value is ProjectRequest {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordVersion", "roomId", "projectId", "revision", "provenance", "createdAt", "updatedAt",
    "kind", "requestId", "title", "description", "requester", "target", "acceptanceMode", "status",
    "resolutionActor", "resolvedAt", "responsibilityLink", "transferChain",
  ]) || !isFactBase(value) || value.kind !== "request" || !isIdentifier(value.requestId) ||
      !isText(value.title, PROJECT_LOOP_LIMITS.titleUtf8) ||
      !isText(value.description, PROJECT_LOOP_LIMITS.descriptionUtf8) ||
      !isProjectHumanRef(value.requester) || !isProjectHumanRef(value.target) ||
      !(value.acceptanceMode === "next_action" || value.acceptanceMode === "open_question" ||
        value.acceptanceMode === "blocker") ||
      !(value.resolutionActor === null || isProjectActorRef(value.resolutionActor)) ||
      !isNullableTimestamp(value.resolvedAt) ||
      !(value.responsibilityLink === null || isResponsibilityLink(value.responsibilityLink)) ||
      !isBoundedArray(value.transferChain, PROJECT_LOOP_LIMITS.transferEntries) ||
      !value.transferChain.every(isRequestTransfer)) return false;
  let expectedTarget: string | null = null;
  for (const transfer of value.transferChain as readonly ProjectRequestTransfer[]) {
    if (expectedTarget !== null && transfer.from.actorId !== expectedTarget) return false;
    expectedTarget = transfer.to.actorId;
  }
  if (value.transferChain.length > 0 && expectedTarget !== value.target.actorId) return false;
  const unresolved = value.resolutionActor === null && value.resolvedAt === null;
  const resolved = value.resolutionActor !== null && value.resolvedAt !== null;
  switch (value.status) {
    case "pending_acceptance": return unresolved && value.responsibilityLink === null;
    case "accepted": return resolved && value.resolutionActor?.kind === "human" &&
      value.resolutionActor.actorId === value.target.actorId && value.responsibilityLink !== null &&
      (value.acceptanceMode === "next_action" ? value.responsibilityLink.kind === "next_action" :
        value.responsibilityLink.kind === "open_question_or_blocker");
    case "rejected": return resolved && value.resolutionActor?.kind === "human" &&
      value.resolutionActor.actorId === value.target.actorId && value.responsibilityLink === null;
    case "cancelled": return resolved && value.resolutionActor?.actorId === value.requester.actorId &&
      value.responsibilityLink === null;
    default: return false;
  }
}

function isCriterion(value: unknown): value is ProjectCriterion {
  return isRecord(value) && hasExactKeys(value, ["criterionId", "text"]) &&
    isIdentifier(value.criterionId) && isText(value.text, PROJECT_LOOP_LIMITS.descriptionUtf8);
}

function isCriteria(value: unknown): value is readonly ProjectCriterion[] {
  return isBoundedArray(value, PROJECT_LOOP_LIMITS.criteriaItems) &&
    hasUniqueIds(value, (item) => isCriterion(item) ? item.criterionId : null);
}

function isDelivery(value: unknown, roomId: string): value is ProjectDelivery {
  return isRecord(value) && hasExactKeys(value, ["source", "summary"]) &&
    isProjectSourceRef(value.source) && value.source.roomId === roomId &&
    isText(value.summary, PROJECT_LOOP_LIMITS.descriptionUtf8);
}

function isReassignment(value: unknown): value is ProjectReassignment {
  return isRecord(value) && hasExactKeys(value, [
    "from", "to", "initiatedBy", "confirmedBy", "reason", "reassignedAt",
  ]) &&
    isProjectActorRef(value.from) && isProjectActorRef(value.to) && value.from.actorId !== value.to.actorId &&
    isProjectActorRef(value.initiatedBy) && isProjectHumanRef(value.confirmedBy) &&
    (value.to.kind === "agent" || value.confirmedBy.actorId === value.to.actorId) &&
    isText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8) &&
    isIsoTimestamp(value.reassignedAt);
}

export function isProjectNextAction(value: unknown): value is ProjectNextAction {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordVersion", "roomId", "projectId", "revision", "provenance", "createdAt", "updatedAt",
    "kind", "nextActionId", "title", "description", "owner", "status", "dueAt", "deliverable",
    "acceptanceCriteria",
    "verifier", "acceptedBy", "acceptedAt", "delivery", "completedBy", "completedAt",
    "statusReason", "reassignmentChain",
  ]) || !isFactBase(value) || value.kind !== "next_action" || !isIdentifier(value.nextActionId) ||
      !isText(value.title, PROJECT_LOOP_LIMITS.titleUtf8) ||
      !isText(value.description, PROJECT_LOOP_LIMITS.descriptionUtf8) || !isProjectActorRef(value.owner) ||
      !isNullableTimestamp(value.dueAt) || !isText(value.deliverable, PROJECT_LOOP_LIMITS.descriptionUtf8) ||
      !isCriteria(value.acceptanceCriteria) ||
      !(value.verifier === null || isProjectHumanRef(value.verifier)) ||
      !(value.acceptedBy === null || isProjectHumanRef(value.acceptedBy)) || !isNullableTimestamp(value.acceptedAt) ||
      !(value.delivery === null || isDelivery(value.delivery, value.roomId as string)) ||
      !(value.completedBy === null || isProjectHumanRef(value.completedBy)) ||
      !isNullableTimestamp(value.completedAt) ||
      !isNullableText(value.statusReason, PROJECT_LOOP_LIMITS.reasonUtf8) ||
      !isBoundedArray(value.reassignmentChain, PROJECT_LOOP_LIMITS.transferEntries) ||
      !value.reassignmentChain.every(isReassignment)) return false;
  if (value.owner.kind === "agent" && value.verifier === null) return false;
  if (value.verifier?.actorId === value.owner.actorId) return false;
  if (value.reassignmentChain.length > 0) {
    const last = value.reassignmentChain[value.reassignmentChain.length - 1] as ProjectReassignment;
    if (last.to.actorId !== value.owner.actorId) return false;
  }
  const unaccepted = value.acceptedBy === null && value.acceptedAt === null;
  const accepted = value.acceptedBy !== null && value.acceptedAt !== null;
  if (accepted && (value.owner.kind === "human"
    ? value.acceptedBy?.actorId !== value.owner.actorId
    : value.acceptedBy?.actorId !== value.verifier?.actorId)) return false;
  switch (value.status) {
    case "proposed": return unaccepted && value.delivery === null && value.completedBy === null &&
      value.completedAt === null && value.statusReason === null;
    case "accepted":
    case "in_progress": return accepted && value.delivery === null && value.completedBy === null &&
      value.completedAt === null && value.statusReason === null;
    case "delivered": return accepted && value.delivery !== null && value.completedBy === null &&
      value.completedAt === null && value.statusReason === null && value.verifier !== null;
    case "done": {
      if (!accepted || value.completedBy === null || value.completedAt === null || value.statusReason !== null) return false;
      if (value.verifier !== null) return value.delivery !== null && value.completedBy.actorId === value.verifier.actorId;
      return value.owner.kind === "human" && value.delivery === null && value.completedBy.actorId === value.owner.actorId;
    }
    case "rejected": return unaccepted && value.delivery === null && value.completedBy === null &&
      value.completedAt === null && value.statusReason !== null;
    case "cancelled": return (unaccepted || accepted) && value.completedBy === null && value.completedAt === null &&
      value.statusReason !== null;
    default: return false;
  }
}

function isObstacleTransfer(value: unknown): value is ProjectObstacleTransfer {
  return isRecord(value) && hasExactKeys(value, [
    "from", "to", "initiatedBy", "confirmedBy", "reason", "transferredAt",
  ]) && isProjectActorRef(value.from) && isProjectActorRef(value.to) &&
    value.from.actorId !== value.to.actorId && isProjectActorRef(value.initiatedBy) &&
    isProjectHumanRef(value.confirmedBy) && isText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8) &&
    isIsoTimestamp(value.transferredAt);
}

export function isProjectObstacle(value: unknown): value is ProjectObstacle {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordVersion", "roomId", "projectId", "revision", "provenance", "createdAt", "updatedAt",
    "kind", "obstacleId", "title", "description", "impact", "resolutionCriteria", "question", "owner",
    "status", "dueAt", "reviewAt", "statusReason", "escalationBoundaryId", "resultSource",
    "transferChain",
  ]) || !isFactBase(value) || !(value.kind === "blocker" || value.kind === "open_question") ||
      !isIdentifier(value.obstacleId) ||
      !isText(value.title, PROJECT_LOOP_LIMITS.titleUtf8) ||
      !isText(value.description, PROJECT_LOOP_LIMITS.descriptionUtf8) ||
      !isText(value.impact, PROJECT_LOOP_LIMITS.descriptionUtf8) || !isProjectActorRef(value.owner) ||
      !isNullableText(value.resolutionCriteria, PROJECT_LOOP_LIMITS.descriptionUtf8) ||
      !isNullableText(value.question, PROJECT_LOOP_LIMITS.descriptionUtf8) ||
      !isNullableTimestamp(value.dueAt) || !isNullableTimestamp(value.reviewAt) ||
      !isNullableText(value.statusReason, PROJECT_LOOP_LIMITS.reasonUtf8) ||
      !isNullableIdentifier(value.escalationBoundaryId) ||
      !(value.resultSource === null || (isProjectSourceRef(value.resultSource) &&
        value.resultSource.roomId === value.roomId)) ||
      !isBoundedArray(value.transferChain, PROJECT_LOOP_LIMITS.transferEntries) ||
      !value.transferChain.every(isObstacleTransfer)) return false;
  if (value.kind === "blocker" ? value.resolutionCriteria === null || value.question !== null
    : value.question === null || value.resolutionCriteria !== null) return false;
  if (value.transferChain.length > 0) {
    for (let index = 1; index < value.transferChain.length; index += 1) {
      const previous = value.transferChain[index - 1] as ProjectObstacleTransfer;
      const current = value.transferChain[index] as ProjectObstacleTransfer;
      if (current.from.actorId !== previous.to.actorId) return false;
    }
    const last = value.transferChain[value.transferChain.length - 1] as ProjectObstacleTransfer;
    if (last.to.actorId !== value.owner.actorId) return false;
  }
  switch (value.status) {
    case "open": return value.reviewAt === null && value.statusReason === null &&
      value.escalationBoundaryId === null && value.resultSource === null;
    case "resolved": return value.reviewAt === null && value.statusReason !== null && value.resultSource !== null;
    case "deferred": return value.reviewAt !== null && value.statusReason !== null &&
      value.escalationBoundaryId === null && value.resultSource === null;
    case "cannot_answer": return value.reviewAt === null && value.statusReason !== null &&
      value.escalationBoundaryId !== null && value.resultSource === null;
    default: return false;
  }
}

export function isProjectFact(value: unknown): value is ProjectFact {
  return isProjectGoal(value) || isProjectDecision(value) || isProjectRequest(value) ||
    isProjectNextAction(value) || isProjectObstacle(value);
}

export function isProjectBlocker(value: unknown): value is ProjectBlocker {
  return isProjectObstacle(value) && value.kind === "blocker";
}

export function isProjectOpenQuestion(
  value: unknown,
): value is ProjectOpenQuestion {
  return isProjectObstacle(value) && value.kind === "open_question";
}

function isProposalPayload(value: unknown): value is ProjectProposalPayload {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "goal": return hasExactKeys(value, ["kind", "title", "description", "supersedesGoalId", "reason"]) &&
      isText(value.title, PROJECT_LOOP_LIMITS.titleUtf8) &&
      isText(value.description, PROJECT_LOOP_LIMITS.descriptionUtf8) &&
      isNullableIdentifier(value.supersedesGoalId) && isNullableText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8) &&
      (value.supersedesGoalId === null ? value.reason === null : value.reason !== null);
    case "decision": return hasExactKeys(value, ["kind", "statement", "supersedesDecisionId", "affectedFactIds"]) &&
      isText(value.statement, PROJECT_LOOP_LIMITS.descriptionUtf8) &&
      isNullableIdentifier(value.supersedesDecisionId) &&
      isIdentifierArray(value.affectedFactIds, PROJECT_LOOP_LIMITS.affectedFactIds);
    case "request": return hasExactKeys(value, [
      "kind", "title", "description", "requester", "target", "acceptanceMode",
    ]) &&
      isText(value.title, PROJECT_LOOP_LIMITS.titleUtf8) &&
      isText(value.description, PROJECT_LOOP_LIMITS.descriptionUtf8) &&
      isProjectHumanRef(value.requester) && isProjectHumanRef(value.target) &&
      (value.acceptanceMode === "next_action" || value.acceptanceMode === "open_question" ||
        value.acceptanceMode === "blocker");
    case "next_action": return hasExactKeys(value, [
      "kind", "title", "description", "owner", "dueAt", "deliverable", "acceptanceCriteria", "verifier",
    ]) && isText(value.title, PROJECT_LOOP_LIMITS.titleUtf8) &&
      isText(value.description, PROJECT_LOOP_LIMITS.descriptionUtf8) && isProjectActorRef(value.owner) &&
      isNullableTimestamp(value.dueAt) && isText(value.deliverable, PROJECT_LOOP_LIMITS.descriptionUtf8) &&
      isCriteria(value.acceptanceCriteria) &&
      (value.verifier === null || isProjectHumanRef(value.verifier)) &&
      (value.owner.kind === "human" || value.verifier !== null) &&
      value.owner.actorId !== value.verifier?.actorId;
    case "blocker":
    case "open_question": return hasExactKeys(value, [
      "kind", "title", "description", "impact", "resolutionCriteria", "question", "owner", "dueAt", "reviewAt",
    ]) &&
      isText(value.title, PROJECT_LOOP_LIMITS.titleUtf8) &&
      isText(value.description, PROJECT_LOOP_LIMITS.descriptionUtf8) &&
      isText(value.impact, PROJECT_LOOP_LIMITS.descriptionUtf8) && isProjectActorRef(value.owner) &&
      isNullableText(value.resolutionCriteria, PROJECT_LOOP_LIMITS.descriptionUtf8) &&
      isNullableText(value.question, PROJECT_LOOP_LIMITS.descriptionUtf8) &&
      (value.kind === "blocker" ? value.resolutionCriteria !== null && value.question === null :
        value.question !== null && value.resolutionCriteria === null) &&
      isNullableTimestamp(value.dueAt) && isNullableTimestamp(value.reviewAt);
    default: return false;
  }
}

export function isProjectProposal(value: unknown): value is ProjectProposal {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordVersion", "proposalId", "roomId", "projectId", "revision", "targetKind", "targetId", "baseRevision",
    "payload", "proposer", "principalActorId", "state", "provenance", "createdAt", "expiresAt",
    "resolvedAt", "resolutionReason",
  ]) || value.recordVersion !== "project-loop.v1" || !isIdentifier(value.proposalId) ||
      !isIdentifier(value.roomId) || value.projectId !== value.roomId || !isPositiveInteger(value.revision) ||
      !isIdentifier(value.targetId) ||
      !(value.baseRevision === null || isPositiveInteger(value.baseRevision)) || !isProposalPayload(value.payload) ||
      value.targetKind !== value.payload.kind || !isProjectActorRef(value.proposer) ||
      !isIdentifier(value.principalActorId) || !isProjectProvenance(value.provenance, value.roomId) ||
      value.provenance.proposedBy.actorId !== value.proposer.actorId ||
      value.provenance.proposedBy.kind !== value.proposer.kind ||
      !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.expiresAt) ||
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt) || !isNullableTimestamp(value.resolvedAt) ||
      !isNullableText(value.resolutionReason, PROJECT_LOOP_LIMITS.reasonUtf8)) return false;
  if (value.state === "pending") return value.resolvedAt === null && value.resolutionReason === null;
  if (value.state === "confirmed") return value.resolvedAt !== null;
  return (value.state === "rejected" || value.state === "cancelled" || value.state === "expired") &&
    value.resolvedAt !== null && value.resolutionReason !== null;
}

export function isProjectConfirmation(value: unknown): value is ProjectConfirmation {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordVersion", "confirmationId", "proposalId", "roomId", "projectId", "revision", "principalActorId",
    "baseRevision", "payloadDigest", "state", "createdAt", "expiresAt", "resolvedBy", "resolvedAt",
    "resolutionReason",
  ]) || value.recordVersion !== "project-loop.v1" || !isIdentifier(value.confirmationId) ||
      !isIdentifier(value.proposalId) || !isIdentifier(value.roomId) || value.projectId !== value.roomId ||
      !isPositiveInteger(value.revision) ||
      !isIdentifier(value.principalActorId) || !(value.baseRevision === null || isPositiveInteger(value.baseRevision)) ||
      typeof value.payloadDigest !== "string" || !/^sha256:[0-9a-f]{16,128}$/.test(value.payloadDigest) ||
      !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.expiresAt) ||
      Date.parse(value.expiresAt) <= Date.parse(value.createdAt) ||
      !(value.resolvedBy === null || isProjectHumanRef(value.resolvedBy)) ||
      !isNullableTimestamp(value.resolvedAt) ||
      !isNullableText(value.resolutionReason, PROJECT_LOOP_LIMITS.reasonUtf8)) return false;
  if (value.state === "pending") return value.resolvedBy === null && value.resolvedAt === null && value.resolutionReason === null;
  if (value.state === "confirmed") return value.resolvedBy?.actorId === value.principalActorId && value.resolvedAt !== null;
  if (value.state === "rejected") return value.resolvedBy?.actorId === value.principalActorId &&
    value.resolvedAt !== null && value.resolutionReason !== null;
  return value.state === "expired" && value.resolvedBy === null && value.resolvedAt !== null &&
    value.resolutionReason !== null;
}

export function isProjectTransferProposal(value: unknown): value is ProjectTransferProposal {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordVersion", "transferProposalId", "roomId", "projectId", "revision", "subjectKind", "subjectId",
    "subjectRevision", "fromOwner", "toOwner", "proposedBy", "principalActorId", "reason", "status",
    "proposedAt", "expiresAt", "resolvedBy", "resolvedAt", "resolutionReason",
  ]) || value.recordVersion !== "project-loop.v1" || !isIdentifier(value.transferProposalId) ||
      !isIdentifier(value.roomId) || value.projectId !== value.roomId || !isPositiveInteger(value.revision) ||
      !(value.subjectKind === "next_action" || value.subjectKind === "blocker" ||
        value.subjectKind === "open_question") ||
      !isIdentifier(value.subjectId) || !isPositiveInteger(value.subjectRevision) ||
      !isProjectActorRef(value.fromOwner) || !isProjectActorRef(value.toOwner) ||
      value.fromOwner.actorId === value.toOwner.actorId || !isProjectActorRef(value.proposedBy) ||
      !isIdentifier(value.principalActorId) || !isText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8) ||
      !isIsoTimestamp(value.proposedAt) || !isIsoTimestamp(value.expiresAt) ||
      Date.parse(value.expiresAt) <= Date.parse(value.proposedAt) ||
      !(value.resolvedBy === null || isProjectHumanRef(value.resolvedBy)) ||
      !isNullableTimestamp(value.resolvedAt) ||
      !isNullableText(value.resolutionReason, PROJECT_LOOP_LIMITS.reasonUtf8)) return false;
  if (value.status === "pending") return value.resolvedBy === null && value.resolvedAt === null &&
    value.resolutionReason === null;
  if (value.status === "accepted") return value.resolvedBy?.actorId === value.principalActorId &&
    value.resolvedAt !== null;
  if (value.status === "rejected") return value.resolvedBy?.actorId === value.principalActorId &&
    value.resolvedAt !== null && value.resolutionReason !== null;
  return (value.status === "cancelled" || value.status === "expired") &&
    value.resolvedAt !== null && value.resolutionReason !== null;
}

export function isProjectBallFact(value: unknown): value is ProjectBallFact {
  return isRecord(value) && hasExactKeys(value, [
    "recordVersion", "ballId", "roomId", "projectId", "sourceKind", "sourceId", "holder",
    "sourceRevision", "since", "reason", "boundaryKind", "boundaryId", "dueAt", "reviewAt",
  ]) && value.recordVersion === "project-loop.v1" && isIdentifier(value.ballId) &&
    isIdentifier(value.roomId) && value.projectId === value.roomId &&
    (value.sourceKind === "request" || value.sourceKind === "next_action" || value.sourceKind === "blocker" ||
      value.sourceKind === "open_question" || value.sourceKind === "proposal" ||
      value.sourceKind === "confirmation" || value.sourceKind === "transfer" || value.sourceKind === "due" ||
      value.sourceKind === "review") && isIdentifier(value.sourceId) && isPositiveInteger(value.sourceRevision) &&
    isProjectActorRef(value.holder) && isIsoTimestamp(value.since) &&
    isText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8) &&
    (value.boundaryKind === "pending_acceptance" || value.boundaryKind === "pending_confirmation" ||
      value.boundaryKind === "work" || value.boundaryKind === "delivery_verification" ||
      value.boundaryKind === "obstacle" || value.boundaryKind === "transfer_acceptance" ||
      value.boundaryKind === "due" || value.boundaryKind === "review" || value.boundaryKind === "escalation") &&
    isIdentifier(value.boundaryId) && isNullableTimestamp(value.dueAt) && isNullableTimestamp(value.reviewAt);
}

export function canTransitionProjectDecision(from: ProjectDecisionStatus, to: ProjectDecisionStatus): boolean {
  return (from === "proposed" && (to === "confirmed" || to === "rejected")) ||
    (from === "confirmed" && to === "superseded");
}

export function canTransitionProjectGoal(from: ProjectGoalStatus, to: ProjectGoalStatus): boolean {
  return (from === "proposed" && (to === "active" || to === "rejected")) ||
    (from === "active" && to === "superseded");
}

export function canTransitionProjectRequest(
  from: ProjectRequestStatus,
  to: ProjectRequestStatus,
  operation: "status" | "transfer" = "status",
): boolean {
  if (operation === "transfer") return from === "pending_acceptance" && to === "pending_acceptance";
  return from === "pending_acceptance" && (to === "accepted" || to === "rejected" || to === "cancelled");
}

export type ProjectNextActionOwnerContract = Readonly<{
  ownerKind: ProjectActorRef["kind"];
  hasVerifier: boolean;
}>;

export function canTransitionProjectNextAction(
  from: ProjectNextActionStatus,
  to: ProjectNextActionStatus,
  contract: ProjectNextActionOwnerContract,
  operation: "status" | "reopen" | "reassign" = "status",
): boolean {
  if (contract.ownerKind === "agent" && !contract.hasVerifier) return false;
  if (operation === "reassign") {
    return to === "proposed" && (from === "proposed" || from === "accepted" || from === "in_progress" ||
      from === "delivered" || from === "done");
  }
  if (operation === "reopen") return to === "in_progress" && (from === "delivered" || from === "done");
  switch (from) {
    case "proposed": return to === "accepted" || to === "rejected" || to === "cancelled";
    case "accepted": return to === "in_progress" || to === "cancelled";
    case "in_progress": return to === "delivered" || to === "cancelled" ||
      (to === "done" && contract.ownerKind === "human" && !contract.hasVerifier);
    case "delivered": return to === "done" || to === "cancelled";
    default: return false;
  }
}

export function canTransitionProjectObstacle(
  from: ProjectObstacleStatus,
  to: ProjectObstacleStatus,
  operation: "status" | "review_due" | "transfer" | "reopen" = "status",
): boolean {
  if (operation === "review_due") return from === "deferred" && to === "open";
  if (operation === "transfer") return (from === "open" || from === "deferred" || from === "cannot_answer") && to === "open";
  if (operation === "reopen") return from === "resolved" && to === "open";
  if (from === "open") return to === "resolved" || to === "deferred" || to === "cannot_answer";
  if (from === "cannot_answer") return to === "resolved";
  return false;
}

export function canTransitionProjectTransferProposal(
  from: ProjectTransferProposalStatus,
  to: ProjectTransferProposalStatus,
): boolean {
  return from === "pending" &&
    (to === "accepted" || to === "rejected" || to === "cancelled" || to === "expired");
}

export function isProjectRevisionCurrent(currentRevision: number, expectedRevision: number): boolean {
  return isPositiveInteger(currentRevision) && isPositiveInteger(expectedRevision) && currentRevision === expectedRevision;
}

export type ProjectBallDerivationInput = Readonly<{
  roomId: string;
  projectId: string;
  requests: readonly ProjectRequest[];
  nextActions: readonly ProjectNextAction[];
  obstacles: readonly ProjectObstacle[];
  proposals: readonly ProjectProposal[];
  confirmations: readonly ProjectConfirmation[];
  transferProposals: readonly ProjectTransferProposal[];
  now?: string;
}>;

function ballId(
  sourceKind: ProjectBallSourceKind,
  sourceId: string,
  sourceRevision: number,
  boundaryKind: ProjectBallBoundaryKind,
  boundaryId: string,
): string {
  return `ball:${sourceKind}:${sourceId}:r${sourceRevision}:${boundaryKind}:${boundaryId}`;
}

function appendBall(
  output: ProjectBallFact[], roomId: string, sourceKind: ProjectBallSourceKind, sourceId: string,
  sourceRevision: number, holder: ProjectActorRef, since: string, reason: string,
  boundaryKind: ProjectBallBoundaryKind, boundaryId: string, dueAt: string | null, reviewAt: string | null,
): void {
  output.push({
    recordVersion: "project-loop.v1",
    ballId: ballId(sourceKind, sourceId, sourceRevision, boundaryKind, boundaryId),
    roomId,
    projectId: roomId,
    sourceKind,
    sourceId,
    sourceRevision,
    holder,
    since,
    reason,
    boundaryKind,
    boundaryId,
    dueAt,
    reviewAt,
  });
}

export function deriveProjectBallFacts(input: ProjectBallDerivationInput): readonly ProjectBallFact[] {
  if (!isIdentifier(input.roomId) || input.projectId !== input.roomId ||
      (input.now !== undefined && !isIsoTimestamp(input.now))) return [];
  const facts = [...input.requests, ...input.nextActions, ...input.obstacles];
  if (!facts.every((fact) => isProjectFact(fact) && fact.roomId === input.roomId) ||
      !input.proposals.every((item) => isProjectProposal(item) && item.roomId === input.roomId) ||
      !input.confirmations.every((item) => isProjectConfirmation(item) && item.roomId === input.roomId) ||
      !input.transferProposals.every((item) => isProjectTransferProposal(item) &&
        item.roomId === input.roomId)) return [];
  const output: ProjectBallFact[] = [];
  for (const request of input.requests) {
    if (request.status === "pending_acceptance") {
      appendBall(output, input.roomId, "request", request.requestId, request.revision,
        request.requester, request.updatedAt,
        "Request awaits target acceptance; responsibility remains with the requester.",
        "pending_acceptance", `request-r${request.revision}`, null, null);
    }
  }
  for (const action of input.nextActions) {
    let holder: ProjectActorRef | null = null;
    let reason = "";
    if (action.status === "proposed") {
      holder = action.owner.kind === "human" ? action.owner : action.verifier;
      reason = "NextAction awaits owner or Human principal acceptance.";
    } else if (action.status === "accepted" || action.status === "in_progress") {
      holder = action.owner;
      reason = "NextAction is owned and requires progress.";
    } else if (action.status === "delivered") {
      holder = action.verifier;
      reason = "Delivered NextAction awaits Human verification.";
    }
    if (holder !== null) appendBall(output, input.roomId, "next_action", action.nextActionId,
      action.revision, holder, action.updatedAt, reason,
      action.status === "delivered" ? "delivery_verification" : "work",
      `next-action-r${action.revision}`, action.dueAt, null);
    if (holder !== null && input.now !== undefined && action.dueAt !== null &&
        Date.parse(input.now) >= Date.parse(action.dueAt)) {
      appendBall(output, input.roomId, "due", action.nextActionId, action.revision, holder, action.dueAt,
        "NextAction due boundary reached.", "due", `due:${action.dueAt}`, action.dueAt, null);
    }
  }
  for (const obstacle of input.obstacles) {
    const reviewDue = obstacle.status === "deferred" && input.now !== undefined && obstacle.reviewAt !== null &&
      Date.parse(input.now) >= Date.parse(obstacle.reviewAt);
    if (obstacle.status === "open" || obstacle.status === "cannot_answer" || reviewDue) {
      appendBall(output, input.roomId, obstacle.kind, obstacle.obstacleId, obstacle.revision, obstacle.owner,
        reviewDue ? obstacle.reviewAt as string : obstacle.updatedAt,
        reviewDue ? "Deferred obstacle review boundary reached." :
          obstacle.status === "cannot_answer" ? "Obstacle requires one bounded escalation." :
            "Obstacle owner must resolve, defer, or escalate.",
        reviewDue ? "review" : obstacle.status === "cannot_answer" ? "escalation" : "obstacle",
        `obstacle-r${obstacle.revision}${reviewDue ? ":review" : ""}`, obstacle.dueAt, obstacle.reviewAt);
    }
  }
  const pendingConfirmationProposalIds = new Set(input.confirmations
    .filter((item) => item.state === "pending").map((item) => item.proposalId));
  for (const proposal of input.proposals) {
    if (proposal.state === "pending" && !pendingConfirmationProposalIds.has(proposal.proposalId)) {
      appendBall(output, input.roomId, "proposal", proposal.proposalId, proposal.revision,
        { actorId: proposal.principalActorId, kind: "human" }, proposal.createdAt,
        "Project proposal awaits its named Human principal.", "pending_confirmation",
        `proposal:${proposal.proposalId}`, proposal.expiresAt, null);
    }
  }
  for (const item of input.confirmations) {
    if (item.state === "pending") appendBall(output, input.roomId, "confirmation", item.confirmationId,
      item.revision,
      { actorId: item.principalActorId, kind: "human" }, item.createdAt,
      "Project confirmation awaits its named Human principal.", "pending_confirmation",
      `confirmation:${item.confirmationId}`, item.expiresAt, null);
  }
  for (const transfer of input.transferProposals) {
    if (transfer.status === "pending") appendBall(output, input.roomId, "transfer",
      transfer.transferProposalId, transfer.revision,
      { actorId: transfer.principalActorId, kind: "human" }, transfer.proposedAt,
      "Transfer proposal awaits target acceptance or Human principal confirmation.",
      "transfer_acceptance", `transfer:${transfer.transferProposalId}`, transfer.expiresAt, null);
  }
  return output.sort((left, right) => left.ballId.localeCompare(right.ballId));
}

export function isProjectEvent(value: unknown): value is ProjectEvent {
  if (!isRecord(value) || !hasExactKeys(value, [
    "eventId", "streamKind", "streamId", "streamSeq", "roomId", "projectId", "actorId",
    "occurredAt", "type", "payload",
  ]) || !isIdentifier(value.eventId) || value.streamKind !== "room" || !isIdentifier(value.roomId) ||
      value.streamId !== value.roomId || value.projectId !== value.roomId || !isPositiveInteger(value.streamSeq) ||
      !isIdentifier(value.actorId) || !isIsoTimestamp(value.occurredAt)) return false;
  switch (value.type) {
    case "project.goal.changed": return isProjectGoal(value.payload) && value.payload.roomId === value.roomId;
    case "project.decision.changed": return isProjectDecision(value.payload) && value.payload.roomId === value.roomId;
    case "project.request.changed": return isProjectRequest(value.payload) && value.payload.roomId === value.roomId;
    case "project.next-action.changed": return isProjectNextAction(value.payload) && value.payload.roomId === value.roomId;
    case "project.blocker.changed": return isProjectBlocker(value.payload) && value.payload.roomId === value.roomId;
    case "project.open-question.changed": return isProjectOpenQuestion(value.payload) && value.payload.roomId === value.roomId;
    case "project.proposal.changed": return isProjectProposal(value.payload) && value.payload.roomId === value.roomId;
    case "project.confirmation.changed": return isProjectConfirmation(value.payload) && value.payload.roomId === value.roomId;
    case "project.transfer-proposal.changed": return isProjectTransferProposal(value.payload) &&
      value.payload.roomId === value.roomId;
    case "project.ball.changed": return isProjectBallFact(value.payload) && value.payload.roomId === value.roomId;
    default: return false;
  }
}

function arraysEqual(left: readonly ProjectBallFact[], right: readonly ProjectBallFact[]): boolean {
  return JSON.stringify([...left].sort((a, b) => a.ballId.localeCompare(b.ballId))) ===
    JSON.stringify([...right].sort((a, b) => a.ballId.localeCompare(b.ballId)));
}

export function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordVersion", "roomId", "projectId", "watermark", "goals", "decisions", "requests",
    "obstacles", "nextActions", "proposals", "confirmations", "transferProposals", "balls", "capturedAt",
  ]) || value.recordVersion !== "project-loop.v1" || !isIdentifier(value.roomId) ||
      value.projectId !== value.roomId || !isNonnegativeInteger(value.watermark) || !isIsoTimestamp(value.capturedAt)) return false;
  const groups: ReadonlyArray<readonly unknown[]> = [
    value.goals as readonly unknown[], value.decisions as readonly unknown[], value.requests as readonly unknown[],
    value.obstacles as readonly unknown[], value.nextActions as readonly unknown[], value.proposals as readonly unknown[],
    value.confirmations as readonly unknown[], value.transferProposals as readonly unknown[],
    value.balls as readonly unknown[],
  ];
  if (!groups.every((items) => isBoundedArray(items, PROJECT_LOOP_LIMITS.snapshotItemsPerKind))) return false;
  if (!(value.goals as readonly unknown[]).every((item) => isProjectGoal(item) && item.roomId === value.roomId) ||
      !(value.decisions as readonly unknown[]).every((item) => isProjectDecision(item) && item.roomId === value.roomId) ||
      !(value.requests as readonly unknown[]).every((item) => isProjectRequest(item) && item.roomId === value.roomId) ||
      !(value.obstacles as readonly unknown[]).every((item) => isProjectObstacle(item) && item.roomId === value.roomId) ||
      !(value.nextActions as readonly unknown[]).every((item) => isProjectNextAction(item) && item.roomId === value.roomId) ||
      !(value.proposals as readonly unknown[]).every((item) => isProjectProposal(item) && item.roomId === value.roomId) ||
      !(value.confirmations as readonly unknown[]).every((item) => isProjectConfirmation(item) && item.roomId === value.roomId) ||
      !(value.transferProposals as readonly unknown[]).every((item) =>
        isProjectTransferProposal(item) && item.roomId === value.roomId) ||
      !(value.balls as readonly unknown[]).every((item) => isProjectBallFact(item) && item.roomId === value.roomId)) return false;
  const idGroups: ReadonlyArray<readonly [readonly unknown[], (item: unknown) => string | null]> = [
    [value.goals as readonly unknown[], (item) => isProjectGoal(item) ? item.goalId : null],
    [value.decisions as readonly unknown[], (item) => isProjectDecision(item) ? item.decisionId : null],
    [value.requests as readonly unknown[], (item) => isProjectRequest(item) ? item.requestId : null],
    [value.obstacles as readonly unknown[], (item) => isProjectObstacle(item) ? item.obstacleId : null],
    [value.nextActions as readonly unknown[], (item) => isProjectNextAction(item) ? item.nextActionId : null],
    [value.proposals as readonly unknown[], (item) => isProjectProposal(item) ? item.proposalId : null],
    [value.confirmations as readonly unknown[], (item) => isProjectConfirmation(item) ? item.confirmationId : null],
    [value.transferProposals as readonly unknown[], (item) => isProjectTransferProposal(item)
      ? item.transferProposalId : null],
    [value.balls as readonly unknown[], (item) => isProjectBallFact(item) ? item.ballId : null],
  ];
  if (!idGroups.every(([items, getter]) => hasUniqueIds(items, getter))) return false;
  if ((value.goals as readonly ProjectGoal[]).filter((item) => item.status === "active").length > 1) return false;
  const proposalIds = new Set((value.proposals as readonly ProjectProposal[]).map((item) => item.proposalId));
  if (!(value.confirmations as readonly ProjectConfirmation[]).every((item) => proposalIds.has(item.proposalId))) return false;
  const activeTransferSubjects = new Set<string>();
  for (const item of value.transferProposals as readonly ProjectTransferProposal[]) {
    if (item.status !== "pending") continue;
    const subjectKey = `${item.subjectKind}:${item.subjectId}`;
    if (activeTransferSubjects.has(subjectKey)) return false;
    activeTransferSubjects.add(subjectKey);
  }
  const actionIds = new Set((value.nextActions as readonly ProjectNextAction[]).map((item) => item.nextActionId));
  const obstacleIds = new Set((value.obstacles as readonly ProjectObstacle[]).map((item) => item.obstacleId));
  if (!(value.requests as readonly ProjectRequest[]).every((item) => item.responsibilityLink === null ||
      (item.responsibilityLink.kind === "next_action" ? actionIds.has(item.responsibilityLink.sourceId) :
        obstacleIds.has(item.responsibilityLink.sourceId)))) return false;
  const expectedBalls = deriveProjectBallFacts({
    roomId: value.roomId as string,
    projectId: value.projectId as string,
    requests: value.requests as readonly ProjectRequest[],
    nextActions: value.nextActions as readonly ProjectNextAction[],
    obstacles: value.obstacles as readonly ProjectObstacle[],
    proposals: value.proposals as readonly ProjectProposal[],
    confirmations: value.confirmations as readonly ProjectConfirmation[],
    transferProposals: value.transferProposals as readonly ProjectTransferProposal[],
  });
  return arraysEqual(value.balls as readonly ProjectBallFact[], expectedBalls);
}

export function isProjectRepairRecord(
  value: unknown,
  expectedRoomId?: string,
): value is ProjectRepairRecord {
  return isRecord(value) && hasExactKeys(value, ["kind", "roomId", "value"]) &&
    value.kind === "project-loop" && isIdentifier(value.roomId) &&
    (expectedRoomId === undefined || value.roomId === expectedRoomId) &&
    isProjectSnapshot(value.value) && value.value.roomId === value.roomId;
}
