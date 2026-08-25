import {
  PROJECT_LOOP_LIMITS,
  isProjectActorRef,
  isProjectEvent,
  isProjectSnapshot,
  isProjectSourceRef,
  type ProjectCriterion,
  type ProjectActorRef,
  type ProjectEvent,
  type ProjectHumanRef,
  type ProjectSnapshot,
  type ProjectSourceRef,
} from "@native-im/core";

export const PROJECT_LOOP_PROTOCOL_LIMITS = Object.freeze({
  id: PROJECT_LOOP_LIMITS.identifierUtf16,
  requestId: 128,
  idempotencyKey: 256,
  title: PROJECT_LOOP_LIMITS.titleUtf8,
  text: PROJECT_LOOP_LIMITS.descriptionUtf8,
  reason: PROJECT_LOOP_LIMITS.reasonUtf8,
  criteria: PROJECT_LOOP_LIMITS.criteriaItems,
  events: 256,
  page: 256,
});

export type PublicProjectProposalPayload =
  | Readonly<{ kind: "goal"; title: string; description: string; supersedesGoalId: string | null; reason: string | null }>
  | Readonly<{ kind: "decision"; statement: string; supersedesDecisionId: string | null; affectedFactIds: readonly string[] }>;

type ReadFrame = Readonly<{ type: "project.snapshot.read"; requestId: string; roomId: string; projectId: string; afterEventSeq: number; limit: number }>;
type MutationBase = Readonly<{ requestId: string; idempotencyKey: string; roomId: string; projectId: string }>;
type FactMutationBase = MutationBase & Readonly<{ factId: string; expectedRevision: number }>;

export type ProjectLoopClientFrame =
  | ReadFrame
  | (MutationBase & Readonly<{ type: "project.proposal.create"; proposalId: string; payload: PublicProjectProposalPayload; source: ProjectSourceRef; baseRevision: number | null }>)
  | (MutationBase & Readonly<{ type: "project.proposal.resolve"; proposalId: string; expectedRevision: number; resolution: "confirmed" | "rejected"; reason: string | null }>)
  | (FactMutationBase & Readonly<{ type: "project.request.transition"; action: "accept" }>)
  | (FactMutationBase & Readonly<{ type: "project.request.transition"; action: "reject" | "cancel"; reason: string }>)
  | (FactMutationBase & Readonly<{ type: "project.request.transition"; action: "transfer"; target: ProjectHumanRef; reason: string }>)
  | (FactMutationBase & Readonly<{ type: "project.next-action.transition"; action: "accept" | "start" }>)
  | (FactMutationBase & Readonly<{ type: "project.next-action.transition"; action: "complete"; completionNote: string; criteriaSnapshot: readonly ProjectCriterion[] }>)
  | (FactMutationBase & Readonly<{ type: "project.next-action.transition"; action: "reject" | "cancel" | "reopen"; reason: string }>)
  | (FactMutationBase & Readonly<{ type: "project.next-action.transition"; action: "deliver"; source: ProjectSourceRef; summary: string }>)
  | (FactMutationBase & Readonly<{ type: "project.obstacle.transition"; obstacleKind: "blocker" | "open_question"; action: "resolve"; resultSource: ProjectSourceRef; reason: string }>)
  | (FactMutationBase & Readonly<{ type: "project.obstacle.transition"; obstacleKind: "blocker" | "open_question"; action: "defer"; reason: string; reviewAt: string }>)
  | (FactMutationBase & Readonly<{ type: "project.obstacle.transition"; obstacleKind: "blocker" | "open_question"; action: "cannot_answer" | "reopen"; reason: string }>)
  | (MutationBase & Readonly<{ type: "project.transfer.propose"; transferProposalId: string; subjectKind: "next_action" | "blocker" | "open_question"; subjectId: string; expectedRevision: number; toOwner: ProjectActorRef; reason: string }>)
  | (MutationBase & Readonly<{ type: "project.transfer.resolve"; transferProposalId: string; subjectKind: "next_action" | "blocker" | "open_question"; subjectId: string; expectedRevision: number; resolution: "accepted" | "rejected"; reason: string | null }>);

export type ProjectLoopMutationFrame = Exclude<ProjectLoopClientFrame, ReadFrame>;
export type ProjectLoopFrameParseResult = { readonly ok: true; readonly frame: ProjectLoopClientFrame } |
  { readonly ok: false; readonly requestId?: string };
export type ProjectLoopServerFrame =
  | Readonly<{ type: "project.snapshot"; requestId: string; snapshot: ProjectSnapshot; events: readonly ProjectEvent[]; nextEventSeq: number }>
  | Readonly<{ type: "project.mutation.ack"; requestId: string; roomId: string; projectId: string; acceptedRevision: number; eventIds: readonly string[]; replayed: boolean }>;

type UnknownRecord = Record<string, unknown>;
const FRAME_TYPES = new Set<ProjectLoopClientFrame["type"]>([
  "project.snapshot.read", "project.proposal.create", "project.proposal.resolve",
  "project.request.transition", "project.next-action.transition", "project.obstacle.transition",
  "project.transfer.propose", "project.transfer.resolve",
]);
const FORBIDDEN_FIELDS = new Set([
  "actorId", "tenantId", "principal", "proposer", "requester", "session", "sessionId",
  "sessionFamilyId", "confirmedBy", "resolvedBy",
]);

function record(value: unknown): value is UnknownRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && allowed.has(key));
}
function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && Buffer.byteLength(value, "utf8") <= limit;
}
function identifier(value: unknown): value is string { return text(value, PROJECT_LOOP_PROTOCOL_LIMITS.id) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value); }
function integer(value: unknown, positive = false): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0); }
function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function actor(value: unknown): value is ProjectActorRef { return isProjectActorRef(value); }
function human(value: unknown): value is ProjectHumanRef { return isProjectActorRef(value) && value.kind === "human"; }
function mutation(value: UnknownRecord): boolean {
  return text(value.requestId, PROJECT_LOOP_PROTOCOL_LIMITS.requestId) && identifier(value.idempotencyKey) &&
    identifier(value.roomId) && value.projectId === value.roomId && !Reflect.ownKeys(value).some((key) =>
      typeof key === "string" && FORBIDDEN_FIELDS.has(key));
}
function source(value: unknown, roomId: unknown): value is ProjectSourceRef { return isProjectSourceRef(value) && value.roomId === roomId; }
function nullableId(value: unknown): value is string | null { return value === null || identifier(value); }
function nullableText(value: unknown, limit: number): value is string | null { return value === null || text(value, limit); }
function criteria(value: unknown): value is readonly Readonly<{ criterionId: string; text: string }>[] {
  return Array.isArray(value) && value.length <= PROJECT_LOOP_PROTOCOL_LIMITS.criteria &&
    value.every((item) => record(item) && exact(item, ["criterionId", "text"]) &&
      identifier(item.criterionId) && text(item.text, PROJECT_LOOP_PROTOCOL_LIMITS.text)) &&
    new Set(value.map((item) => (item as { criterionId: string }).criterionId)).size === value.length;
}
function identifiers(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= PROJECT_LOOP_LIMITS.affectedFactIds &&
    value.every(identifier) && new Set(value).size === value.length;
}
function proposalPayload(value: unknown): value is PublicProjectProposalPayload {
  if (!record(value)) return false;
  switch (value.kind) {
    case "goal": return exact(value, ["kind", "title", "description", "supersedesGoalId", "reason"]) &&
      text(value.title, PROJECT_LOOP_PROTOCOL_LIMITS.title) && text(value.description, PROJECT_LOOP_PROTOCOL_LIMITS.text) &&
      nullableId(value.supersedesGoalId) && nullableText(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason) &&
      (value.supersedesGoalId === null ? value.reason === null : value.reason !== null);
    case "decision": return exact(value, ["kind", "statement", "supersedesDecisionId", "affectedFactIds"]) &&
      text(value.statement, PROJECT_LOOP_PROTOCOL_LIMITS.text) && nullableId(value.supersedesDecisionId) && identifiers(value.affectedFactIds);
    default: return false;
  }
}

export function isProjectLoopFrameType(value: unknown): value is ProjectLoopClientFrame["type"] { return FRAME_TYPES.has(value as ProjectLoopClientFrame["type"]); }
function fail(requestId: string | undefined): ProjectLoopFrameParseResult { return { ok: false, ...(requestId === undefined ? {} : { requestId }) }; }

export function parseProjectLoopClientFrame(value: unknown): ProjectLoopFrameParseResult {
  if (!record(value) || !isProjectLoopFrameType(value.type)) return { ok: false };
  const requestId = text(value.requestId, PROJECT_LOOP_PROTOCOL_LIMITS.requestId) ? value.requestId : undefined;
  if (value.type === "project.snapshot.read") {
    return exact(value, ["type", "requestId", "roomId", "projectId", "afterEventSeq", "limit"]) && requestId !== undefined &&
      identifier(value.roomId) && value.projectId === value.roomId && integer(value.afterEventSeq) &&
      integer(value.limit, true) && value.limit <= PROJECT_LOOP_PROTOCOL_LIMITS.page
      ? { ok: true, frame: value as ReadFrame } : fail(requestId);
  }
  if (!mutation(value)) return fail(requestId);
  let valid = false;
  switch (value.type) {
    case "project.proposal.create": valid = exact(value, ["type", "requestId", "idempotencyKey", "roomId", "projectId", "proposalId", "payload", "source", "baseRevision"]) && identifier(value.proposalId) && proposalPayload(value.payload) && source(value.source, value.roomId) && (value.baseRevision === null || integer(value.baseRevision, true)); break;
    case "project.proposal.resolve": valid = exact(value, ["type", "requestId", "idempotencyKey", "roomId", "projectId", "proposalId", "expectedRevision", "resolution", "reason"]) && identifier(value.proposalId) && integer(value.expectedRevision, true) && (value.resolution === "confirmed" || value.resolution === "rejected") && nullableText(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason) && (value.resolution === "confirmed" ? value.reason === null : value.reason !== null); break;
    case "project.request.transition": {
      const base = ["type", "requestId", "idempotencyKey", "roomId", "projectId", "factId", "expectedRevision", "action"];
      valid = identifier(value.factId) && integer(value.expectedRevision, true) && (value.action === "accept" ? exact(value, base) :
        (value.action === "reject" || value.action === "cancel") ? exact(value, [...base, "reason"]) && text(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason) :
          value.action === "transfer" && exact(value, [...base, "target", "reason"]) && human(value.target) && text(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason)); break;
    }
    case "project.next-action.transition": {
      const base = ["type", "requestId", "idempotencyKey", "roomId", "projectId", "factId", "expectedRevision", "action"];
      valid = identifier(value.factId) && integer(value.expectedRevision, true) &&
        ((value.action === "accept" || value.action === "start") ? exact(value, base) :
          value.action === "complete" ? exact(value, [...base, "completionNote", "criteriaSnapshot"]) &&
            text(value.completionNote, PROJECT_LOOP_PROTOCOL_LIMITS.text) && criteria(value.criteriaSnapshot) :
          (value.action === "reject" || value.action === "cancel" || value.action === "reopen") ? exact(value, [...base, "reason"]) && text(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason) :
            value.action === "deliver" ? exact(value, [...base, "source", "summary"]) && source(value.source, value.roomId) && text(value.summary, PROJECT_LOOP_PROTOCOL_LIMITS.text) :
            false); break;
    }
    case "project.obstacle.transition": {
      const base = ["type", "requestId", "idempotencyKey", "roomId", "projectId", "factId", "expectedRevision", "obstacleKind", "action"];
      valid = identifier(value.factId) && integer(value.expectedRevision, true) && (value.obstacleKind === "blocker" || value.obstacleKind === "open_question") &&
        (value.action === "resolve" ? exact(value, [...base, "resultSource", "reason"]) && source(value.resultSource, value.roomId) && text(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason) :
          value.action === "defer" ? exact(value, [...base, "reason", "reviewAt"]) && text(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason) && timestamp(value.reviewAt) :
            (value.action === "cannot_answer" || value.action === "reopen") &&
              exact(value, [...base, "reason"]) && text(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason)); break;
    }
    case "project.transfer.propose": valid = exact(value, ["type", "requestId", "idempotencyKey", "roomId", "projectId", "transferProposalId", "subjectKind", "subjectId", "expectedRevision", "toOwner", "reason"]) && identifier(value.transferProposalId) && (value.subjectKind === "next_action" || value.subjectKind === "blocker" || value.subjectKind === "open_question") && identifier(value.subjectId) && integer(value.expectedRevision, true) && actor(value.toOwner) && text(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason); break;
    case "project.transfer.resolve": valid = exact(value, ["type", "requestId", "idempotencyKey", "roomId", "projectId", "transferProposalId", "subjectKind", "subjectId", "expectedRevision", "resolution", "reason"]) && identifier(value.transferProposalId) && (value.subjectKind === "next_action" || value.subjectKind === "blocker" || value.subjectKind === "open_question") && identifier(value.subjectId) && integer(value.expectedRevision, true) && (value.resolution === "accepted" || value.resolution === "rejected") && nullableText(value.reason, PROJECT_LOOP_PROTOCOL_LIMITS.reason) && (value.resolution === "accepted" ? value.reason === null : value.reason !== null); break;
  }
  return valid ? { ok: true, frame: value as ProjectLoopClientFrame } : fail(requestId);
}

export function isProjectLoopServerFrame(value: unknown): value is ProjectLoopServerFrame {
  if (!record(value) || !text(value.requestId, PROJECT_LOOP_PROTOCOL_LIMITS.requestId)) return false;
  if (value.type === "project.snapshot") {
    if (!exact(value, ["type", "requestId", "snapshot", "events", "nextEventSeq"]) ||
        !isProjectSnapshot(value.snapshot) || !Array.isArray(value.events) ||
        value.events.length > PROJECT_LOOP_PROTOCOL_LIMITS.events || !integer(value.nextEventSeq)) return false;
    const snapshot = value.snapshot;
    const events = value.events;
    if (!events.every((event) => isProjectEvent(event) && event.roomId === snapshot.roomId)) return false;
    return events.every((event, index) => index === 0 ||
      (event as ProjectEvent).streamSeq > (events[index - 1] as ProjectEvent).streamSeq) &&
      (events.length === 0 || (events.at(-1) as ProjectEvent).streamSeq <= value.nextEventSeq);
  }
  return value.type === "project.mutation.ack" && exact(value, ["type", "requestId", "roomId", "projectId", "acceptedRevision", "eventIds", "replayed"]) && identifier(value.roomId) && value.projectId === value.roomId && integer(value.acceptedRevision, true) && Array.isArray(value.eventIds) && value.eventIds.length >= 1 && value.eventIds.length <= PROJECT_LOOP_PROTOCOL_LIMITS.events && value.eventIds.every(identifier) && new Set(value.eventIds).size === value.eventIds.length && typeof value.replayed === "boolean";
}
