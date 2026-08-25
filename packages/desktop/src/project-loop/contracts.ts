import {
  PROJECT_LOOP_LIMITS,
  isProjectActorRef,
  isProjectSourceRef,
  isProjectEvent,
  isProjectSnapshot,
  type ProjectEvent,
  type ProjectSnapshot,
} from "@native-im/core";
import type {
  ProjectLoopIntent,
} from "../renderer/project-loop/surface.js";
import type {
  ProjectLoopRemoteState,
} from "../renderer/project-loop/view-model.js";

export const PROJECT_LOOP_IPC_CHANNELS = Object.freeze({
  surface: "project-loop:surface",
  submit: "project-loop:submit",
  stateChanged: "project-loop:state-changed",
} as const);

export type ProjectLoopSurfaceQuery = Readonly<{ roomId: string }>;
export type ProjectLoopSubmitCommand = Readonly<{ roomId: string; intent: ProjectLoopIntent }>;
export type ProjectLoopStateEnvelope = Readonly<{ roomId: string; state: ProjectLoopRemoteState }>;

export interface ProjectLoopBridge {
  getSurface(query: ProjectLoopSurfaceQuery): Promise<ProjectLoopRemoteState>;
  submit(command: ProjectLoopSubmitCommand): Promise<ProjectLoopRemoteState>;
  onStateChanged(listener: (envelope: ProjectLoopStateEnvelope) => void): () => void;
}

export type ProjectSnapshotReadFrame = Readonly<{
  type: "project.snapshot.read";
  requestId: string;
  roomId: string;
  projectId: string;
  afterEventSeq: number;
  limit: number;
}>;
export type ProjectProposalResolveFrame = Readonly<{
  type: "project.proposal.resolve";
  requestId: string;
  idempotencyKey: string;
  roomId: string;
  projectId: string;
  proposalId: string;
  expectedRevision: number;
  resolution: "confirmed" | "rejected";
  reason: string | null;
}>;
export type ProjectRequestTransitionFrame = Readonly<{
  type: "project.request.transition";
  requestId: string;
  idempotencyKey: string;
  roomId: string;
  projectId: string;
  factId: string;
  expectedRevision: number;
}> & (
  | Readonly<{ action: "accept" }>
  | Readonly<{ action: "reject" | "cancel"; reason: string }>
  | Readonly<{ action: "transfer"; target: Readonly<{ kind: "human"; actorId: string }>; reason: string }>
);
export type ProjectNextActionTransitionFrame = Readonly<{
  type: "project.next-action.transition"; requestId: string; idempotencyKey: string;
  roomId: string; projectId: string; factId: string; expectedRevision: number;
}> & (
  | Readonly<{ action: "accept" | "start" }>
  | Readonly<{ action: "complete"; completionNote: string;
      criteriaSnapshot: readonly Readonly<{ criterionId: string; text: string }>[] }>
  | Readonly<{ action: "reject" | "cancel" | "reopen"; reason: string }>
  | Readonly<{ action: "deliver"; source: import("@native-im/core").ProjectSourceRef; summary: string }>
);
export type ProjectObstacleTransitionFrame = Readonly<{
  type: "project.obstacle.transition"; requestId: string; idempotencyKey: string;
  roomId: string; projectId: string; factId: string; expectedRevision: number;
  obstacleKind: "blocker" | "open_question";
}> & (
  | Readonly<{ action: "resolve"; resultSource: import("@native-im/core").ProjectSourceRef; reason: string }>
  | Readonly<{ action: "defer"; reason: string; reviewAt: string }>
  | Readonly<{ action: "cannot_answer" | "reopen"; reason: string }>
);
export type ProjectTransferProposeFrame = Readonly<{
  type: "project.transfer.propose"; requestId: string; idempotencyKey: string;
  roomId: string; projectId: string; transferProposalId: string;
  subjectKind: "next_action" | "blocker" | "open_question"; subjectId: string;
  expectedRevision: number; toOwner: import("@native-im/core").ProjectActorRef; reason: string;
}>;
export type ProjectTransferResolveFrame = Readonly<{
  type: "project.transfer.resolve"; requestId: string; idempotencyKey: string;
  roomId: string; projectId: string; transferProposalId: string;
  subjectKind: "next_action" | "blocker" | "open_question"; subjectId: string;
  expectedRevision: number; resolution: "accepted" | "rejected"; reason: string | null;
}>;
export type ProjectLoopWireRequest = ProjectSnapshotReadFrame | ProjectProposalResolveFrame |
  ProjectRequestTransitionFrame | ProjectNextActionTransitionFrame | ProjectObstacleTransitionFrame |
  ProjectTransferProposeFrame | ProjectTransferResolveFrame;
export type ProjectSnapshotWireResponse = Readonly<{
  type: "project.snapshot";
  requestId: string;
  snapshot: ProjectSnapshot;
  events: readonly ProjectEvent[];
  nextEventSeq: number;
}>;
export type ProjectMutationAckWireResponse = Readonly<{
  type: "project.mutation.ack";
  requestId: string;
  roomId: string;
  projectId: string;
  acceptedRevision: number;
  eventIds: readonly string[];
  replayed: boolean;
}>;
export type ProjectLoopWireResponse = ProjectSnapshotWireResponse | ProjectMutationAckWireResponse;
export type ProjectLoopWireError = Readonly<{
  type: "error";
  status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503;
  code: "invalid_request" | "unauthenticated" | "room_forbidden" | "permission_denied" |
    "room_not_found" | "project_fact_not_found" |
    "revision_conflict" | "idempotency_conflict" | "invalid_transition" | "room_archived" |
    "rate_limited" | "dependency_unavailable" | "storage_unavailable" | "project_dependency_unavailable";
  message: string;
  requestId: string;
  retryAfterSeconds?: number;
}>;

type UnknownRecord = Record<string, unknown>;
const encoder = new TextEncoder();
function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    encoder.encode(value).byteLength <= 256;
}
function nonemptyText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    encoder.encode(value).byteLength <= limit;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}
function criteria(value: unknown): boolean {
  return Array.isArray(value) && value.length <= PROJECT_LOOP_LIMITS.criteriaItems &&
    value.every((item) => record(item) &&
    exact(item, ["criterionId", "text"]) && id(item.criterionId) &&
    nonemptyText(item.text, PROJECT_LOOP_LIMITS.descriptionUtf8)) &&
    new Set(value.map((item) => (item as { criterionId: string }).criterionId)).size === value.length;
}

export function isProjectLoopSurfaceQuery(value: unknown): value is ProjectLoopSurfaceQuery {
  return record(value) && exact(value, ["roomId"]) && id(value.roomId);
}
export function isProjectLoopIntent(value: unknown): value is ProjectLoopIntent {
  if (!record(value) || !id(value.intentId) || !count(value.expectedRevision)) return false;
  if (value.kind === "proposal.resolve") return exact(value, [
    "kind", "intentId", "proposalId", "expectedRevision", "resolution", "reason",
  ]) && id(value.proposalId) && ((value.resolution === "confirmed" && value.reason === null) ||
      (value.resolution === "rejected" && nonemptyText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8)));
  if (value.kind === "request.transition" && id(value.factId)) {
    const base = ["kind", "intentId", "factId", "expectedRevision", "action"];
    if (value.action === "accept") return exact(value, base);
    if (value.action === "reject" || value.action === "cancel") {
      return exact(value, [...base, "reason"]) &&
        nonemptyText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8);
    }
    return value.action === "transfer" && exact(value, [...base, "target", "reason"]) &&
      nonemptyText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8) &&
      record(value.target) && exact(value.target, ["kind", "actorId"]) && value.target.kind === "human" &&
      id(value.target.actorId);
  }
  if (value.kind === "next_action.transition" && id(value.factId)) {
    const base = ["kind", "intentId", "factId", "expectedRevision", "action"];
    if (value.action === "accept" || value.action === "start") return exact(value, base);
    if (value.action === "reject" || value.action === "cancel" || value.action === "reopen") {
      return exact(value, [...base, "reason"]) &&
        nonemptyText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8);
    }
    if (value.action === "complete") return exact(value, [...base, "completionNote", "criteriaSnapshot"]) &&
      nonemptyText(value.completionNote, PROJECT_LOOP_LIMITS.descriptionUtf8) && criteria(value.criteriaSnapshot);
    return value.action === "deliver" && exact(value, [...base, "source", "summary"]) &&
      isProjectSourceRef(value.source) && nonemptyText(value.summary, PROJECT_LOOP_LIMITS.descriptionUtf8);
  }
  if (value.kind === "obstacle.transition" && id(value.factId) &&
      (value.obstacleKind === "blocker" || value.obstacleKind === "open_question")) {
    const base = ["kind", "intentId", "factId", "expectedRevision", "obstacleKind", "action"];
    if (value.action === "resolve") return exact(value, [...base, "resultSource", "reason"]) &&
      isProjectSourceRef(value.resultSource) && nonemptyText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8);
    if (value.action === "defer") return exact(value, [...base, "reason", "reviewAt"]) &&
      nonemptyText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8) && timestamp(value.reviewAt);
    return (value.action === "cannot_answer" || value.action === "reopen") &&
      exact(value, [...base, "reason"]) &&
      nonemptyText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8);
  }
  if (value.kind === "transfer.propose") return exact(value, ["kind", "intentId", "transferProposalId",
    "subjectKind", "subjectId", "expectedRevision", "toOwner", "reason"]) &&
    id(value.transferProposalId) && ["next_action", "blocker", "open_question"].includes(String(value.subjectKind)) &&
    id(value.subjectId) && isProjectActorRef(value.toOwner) &&
    nonemptyText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8);
  return value.kind === "transfer.resolve" && exact(value, ["kind", "intentId", "transferProposalId",
    "subjectKind", "subjectId", "expectedRevision", "resolution", "reason"]) &&
    id(value.transferProposalId) && ["next_action", "blocker", "open_question"].includes(String(value.subjectKind)) &&
    id(value.subjectId) && (value.resolution === "accepted" || value.resolution === "rejected") &&
    (value.resolution === "accepted" ? value.reason === null :
      nonemptyText(value.reason, PROJECT_LOOP_LIMITS.reasonUtf8));
}
export function isProjectLoopSubmitCommand(value: unknown): value is ProjectLoopSubmitCommand {
  if (!record(value) || !exact(value, ["roomId", "intent"]) || !id(value.roomId) ||
      !isProjectLoopIntent(value.intent)) return false;
  return value.intent.kind === "next_action.transition" && value.intent.action === "deliver"
    ? value.intent.source.roomId === value.roomId
    : value.intent.kind === "obstacle.transition" && value.intent.action === "resolve"
      ? value.intent.resultSource.roomId === value.roomId
      : true;
}
export function isProjectLoopRemoteState(value: unknown): value is ProjectLoopRemoteState {
  if (!record(value) || !id(value.roomId) || typeof value.status !== "string") return false;
  if (value.status === "loading") return exact(value, ["status", "roomId"]);
  if (value.status === "locked") return exact(value, ["status", "roomId", "error"]) &&
    record(value.error) && exact(value.error, ["status", "code"]) &&
    (value.error.status === 401 || value.error.status === 410 || value.error.status === 503) && id(value.error.code);
  if (value.status !== "ready" || !exact(value, [
    "status", "roomId", "snapshot", "viewerActorId", "connection", "operation",
  ]) || !isProjectSnapshot(value.snapshot) || value.snapshot.roomId !== value.roomId ||
      !id(value.viewerActorId) || !record(value.connection) || !record(value.operation)) return false;
  const connection = value.connection;
  const connectionValid = connection.status === "online" && exact(connection, ["status"])
    || connection.status === "repairing" && exact(connection, ["status"])
    || connection.status === "offline" && exact(connection, ["status", "asOf"]) && id(connection.asOf)
    || connection.status === "repair_failed" && exact(connection, ["status", "code"]) && id(connection.code);
  const operation = value.operation;
  const operationValid = operation.status === "idle" && exact(operation, ["status"])
    || operation.status === "submitting" && exact(operation, ["status", "intentId"]) && id(operation.intentId)
    || operation.status === "acknowledged" && exact(operation, ["status", "intentId", "acceptedRevision"]) &&
      id(operation.intentId) && count(operation.acceptedRevision)
    || operation.status === "failed" && exact(operation, ["status", "intentId", "error"]) &&
      id(operation.intentId) && record(operation.error) &&
      exact(operation.error, ["status", "code"], ["retryAfterSeconds"]) &&
      [400, 401, 403, 404, 409, 410, 429, 503].includes(operation.error.status as number) &&
      id(operation.error.code) &&
      (operation.error.retryAfterSeconds === undefined || count(operation.error.retryAfterSeconds));
  return Boolean(connectionValid && operationValid);
}
export function cloneProjectLoopRemoteState(value: unknown): ProjectLoopRemoteState {
  if (!isProjectLoopRemoteState(value)) throw new TypeError("Invalid Project Loop remote state");
  return structuredClone(value);
}
export function cloneProjectLoopSubmitCommand(value: unknown): ProjectLoopSubmitCommand {
  if (!isProjectLoopSubmitCommand(value)) throw new TypeError("Invalid Project Loop submit command");
  return structuredClone(value);
}
export function isProjectLoopWireResponse(value: unknown): value is ProjectLoopWireResponse {
  if (!record(value) || !id(value.requestId)) return false;
  if (value.type === "project.snapshot") {
    if (!exact(value, ["type", "requestId", "snapshot", "events", "nextEventSeq"]) ||
        !isProjectSnapshot(value.snapshot) || !Array.isArray(value.events)) return false;
    const snapshot = value.snapshot;
    return value.events.length <= 256 && value.events.every((event) =>
      isProjectEvent(event) && event.roomId === snapshot.roomId) && count(value.nextEventSeq);
  }
  return value.type === "project.mutation.ack" && exact(value, [
    "type", "requestId", "roomId", "projectId", "acceptedRevision", "eventIds", "replayed",
  ]) && id(value.roomId) && value.projectId === value.roomId && count(value.acceptedRevision) &&
    value.acceptedRevision > 0 && Array.isArray(value.eventIds) && value.eventIds.length > 0 &&
    value.eventIds.length <= 256 && value.eventIds.every(id) &&
    new Set(value.eventIds).size === value.eventIds.length && typeof value.replayed === "boolean";
}
export function isProjectLoopWireError(value: unknown): value is ProjectLoopWireError {
  if (!record(value) || !exact(value, ["type", "status", "code", "message", "requestId"],
    ["retryAfterSeconds"]) || value.type !== "error" || !id(value.requestId) ||
    typeof value.message !== "string" || value.message.length === 0) return false;
  const pairs = new Set([
    "400:invalid_request", "401:unauthenticated", "403:room_forbidden", "403:permission_denied",
    "404:room_not_found",
    "404:project_fact_not_found", "409:revision_conflict", "409:idempotency_conflict",
    "409:invalid_transition", "410:room_archived", "503:dependency_unavailable",
    "429:rate_limited", "503:storage_unavailable", "503:project_dependency_unavailable",
  ]);
  return pairs.has(`${String(value.status)}:${String(value.code)}`) &&
    (value.retryAfterSeconds === undefined || count(value.retryAfterSeconds));
}
