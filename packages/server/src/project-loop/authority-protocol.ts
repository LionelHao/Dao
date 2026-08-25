import type {
  AgentWorkerCommandContext,
  AuthenticatedCommandContext,
  AuthenticatedSessionContext,
  JsonValue,
} from "../persistence/contracts.js";
import {
  isProjectEvent,
  isProjectSnapshot,
  type ProjectEvent,
  type ProjectSnapshot,
} from "@native-im/core";

export const PROJECT_LOOP_AUTHORITY_LIMITS = Object.freeze({
  idBytes: 128,
  sourceIdBytes: 256,
  titleBytes: 512,
  textBytes: 8_192,
  payloadBytes: 16_384,
  pageLimit: 200,
});

export type ProjectLoopFactKind =
  | "goal" | "decision" | "request" | "next_action" | "blocker" | "open_question";

export type ProjectLoopActorCommandContext =
  | AuthenticatedCommandContext
  | AgentWorkerCommandContext;

export type ProjectLoopSource = Readonly<{
  roomId: string;
  sourceId: string;
  sourceRevision: number;
  visibility: "room";
  kind: "message" | "attachment" | "agent_execution" | "memory" | "project_fact" | "legacy";
}>;

export type ProjectLoopProposalCreateCommand = Readonly<{
  proposalId: string;
  roomId: string;
  projectId: string;
  factKind: ProjectLoopFactKind;
  factId: string;
  baseRevision: number;
  principalActorId: string;
  expiresAt: string;
  payload: Readonly<Record<string, JsonValue>>;
  source: ProjectLoopSource;
}>;

export type ProjectLoopProposalResolveCommand = Readonly<{
  proposalId: string;
  roomId: string;
  projectId: string;
  expectedRevision: number;
  resolution: "confirmed" | "rejected";
  reason: string | null;
}>;

export type ProjectLoopFactTransitionCommand = Readonly<{
  roomId: string;
  projectId: string;
  factKind: ProjectLoopFactKind;
  factId: string;
  expectedRevision: number;
  transition:
    | "request.accept" | "request.reject" | "request.cancel" | "request.transfer"
    | "next_action.accept" | "next_action.start" | "next_action.deliver"
    | "next_action.complete" | "next_action.reopen" | "next_action.cancel"
    | "next_action.reject" | "next_action.transfer_propose"
    | "next_action.transfer_accept" | "next_action.transfer_reject"
    | "obstacle.resolve" | "obstacle.defer" | "obstacle.cannot_answer"
    | "obstacle.reopen" | "obstacle.transfer_propose" | "obstacle.transfer_accept"
    | "obstacle.transfer_reject";
  payload: Readonly<Record<string, JsonValue>>;
}>;

export type ProjectLoopAuthorityOperation =
  | Readonly<{
      type: "project-loop.snapshot.read";
      context: AuthenticatedSessionContext | AuthenticatedCommandContext;
      roomId: string;
      projectId: string;
      afterEventSeq: number;
      limit: number;
      now: number;
    }>
  | Readonly<{
      type: "project-loop.proposal.create";
      context: ProjectLoopActorCommandContext;
      command: ProjectLoopProposalCreateCommand;
      now: number;
    }>
  | Readonly<{
      type: "project-loop.proposal.resolve";
      context: AuthenticatedCommandContext;
      command: ProjectLoopProposalResolveCommand;
      now: number;
    }>
  | Readonly<{
      type: "project-loop.fact.transition";
      context: ProjectLoopActorCommandContext;
      command: ProjectLoopFactTransitionCommand;
      now: number;
    }>;

export type ProjectLoopStoredFact = Readonly<{
  kind: ProjectLoopFactKind;
  id: string;
  roomId: string;
  projectId: string;
  revision: number;
  status: string;
  title: string;
  description: string;
  source: ProjectLoopSource;
  createdAt: string;
  updatedAt: string;
  details: Readonly<Record<string, JsonValue>>;
}>;

export type ProjectLoopStoredProposal = Readonly<{
  id: string;
  roomId: string;
  projectId: string;
  revision: number;
  factKind: ProjectLoopFactKind;
  factId: string;
  baseRevision: number;
  status: "pending" | "confirmed" | "rejected" | "cancelled" | "expired";
  payload: Readonly<Record<string, JsonValue>>;
  source: ProjectLoopSource;
  proposedBy: Readonly<{ kind: "human" | "agent"; actorId: string }>;
  principalHumanActorId?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectLoopStoredEvent = Readonly<{
  eventId: string;
  roomId: string;
  projectId: string;
  eventSeq: number;
  eventType: "proposal.created" | "proposal.confirmed" | "proposal.rejected" |
    "fact.created" | "fact.transitioned";
  factKind: ProjectLoopFactKind;
  factId: string;
  factRevision: number;
  transitionAuthority:
    | Readonly<{ kind: "human" | "agent"; actorId: string }>
    | Readonly<{ kind: "system_timer" }>;
  causalActor: Readonly<{ kind: "human" | "agent"; actorId: string }>;
  source: ProjectLoopSource;
  occurredAt: string;
  payload: Readonly<Record<string, JsonValue>>;
}>;

export type ProjectLoopAuthorityResult =
  | Readonly<{
      kind: "project-loop-snapshot";
      snapshot: ProjectSnapshot;
      events: readonly ProjectEvent[];
      nextEventSeq: number;
    }>
  | Readonly<{
      kind: "project-loop-mutation";
      roomId: string;
      projectId: string;
      acceptedRevision: number;
      eventIds: readonly string[];
      replayed: boolean;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFactKind(value: unknown): value is ProjectLoopFactKind {
  return value === "goal" || value === "decision" || value === "request" ||
    value === "next_action" || value === "blocker" || value === "open_question";
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}

function isPayload(value: unknown): value is Readonly<Record<string, JsonValue>> {
  if (!isRecord(value) || !Object.values(value).every(isJson)) return false;
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= PROJECT_LOOP_AUTHORITY_LIMITS.payloadBytes; }
  catch { return false; }
}

function isSource(value: unknown, roomId: string): value is ProjectLoopSource {
  return isRecord(value) && exact(value, ["roomId", "sourceId", "sourceRevision", "visibility", "kind"]) &&
    value.roomId === roomId && text(value.sourceId, PROJECT_LOOP_AUTHORITY_LIMITS.sourceIdBytes) &&
    integer(value.sourceRevision) && value.sourceRevision > 0 && value.visibility === "room" &&
    (value.kind === "message" || value.kind === "attachment" || value.kind === "agent_execution" ||
      value.kind === "memory" || value.kind === "project_fact" || value.kind === "legacy");
}

function transitionPayload(kind: ProjectLoopFactKind, transition: unknown,
  payload: Readonly<Record<string, JsonValue>>, roomId: string): boolean {
  const keys = Object.keys(payload).sort();
  const exactPayload = (expected: readonly string[]) => {
    const sorted = [...expected].sort();
    return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
  };
  if (kind === "request") {
    if (transition === "request.accept") return exactPayload([]);
    if (transition === "request.transfer") return exactPayload(["reason", "targetHumanActorId"]);
    return (transition === "request.reject" || transition === "request.cancel") && exactPayload(["reason"]);
  }
  if (kind === "next_action") {
    if (transition === "next_action.transfer_propose") {
      return exactPayload(["expiresAt", "reason", "toOwnerActorId", "toOwnerKind", "transferProposalId"]);
    }
    if (transition === "next_action.transfer_accept" || transition === "next_action.transfer_reject") {
      return exactPayload(["transferProposalId"]);
    }
    if (transition === "next_action.deliver") return exactPayload(["source", "summary"]) &&
      isSource(payload.source, roomId) && text(payload.summary, PROJECT_LOOP_AUTHORITY_LIMITS.textBytes);
    if (transition === "next_action.complete") return exactPayload(["completionNote", "criteriaSnapshot"]) &&
      text(payload.completionNote, PROJECT_LOOP_AUTHORITY_LIMITS.textBytes) && Array.isArray(payload.criteriaSnapshot);
    if (transition === "next_action.reopen") return exactPayload(["reason"]);
    if (transition === "next_action.cancel" || transition === "next_action.reject") {
      return exactPayload(["reason"]) && text(payload.reason, PROJECT_LOOP_AUTHORITY_LIMITS.textBytes);
    }
    return (transition === "next_action.accept" || transition === "next_action.start") && exactPayload([]);
  }
  if (kind === "blocker" || kind === "open_question") {
    if (transition === "obstacle.defer") return exactPayload(["reason", "reviewAt"]);
    if (transition === "obstacle.cannot_answer") return exactPayload(["reason"]);
    if (transition === "obstacle.reopen") return exactPayload(["reason"]);
    if (transition === "obstacle.transfer_propose") {
      return exactPayload(["expiresAt", "reason", "toOwnerActorId", "toOwnerKind", "transferProposalId"]);
    }
    if (transition === "obstacle.transfer_accept" || transition === "obstacle.transfer_reject") {
      return exactPayload(["transferProposalId"]);
    }
    return transition === "obstacle.resolve" && exactPayload(["reason", "source"]) &&
      text(payload.reason, PROJECT_LOOP_AUTHORITY_LIMITS.textBytes) && isSource(payload.source, roomId);
  }
  return false;
}

function isPrincipal(value: unknown): boolean {
  return isRecord(value) && exact(value, ["accountId", "actorId"]) &&
    text(value.accountId, 256) && text(value.actorId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes);
}

function isSessionContext(value: unknown): boolean {
  return isRecord(value) && exact(value, ["sessionId", "sessionFamilyId", "principal"]) &&
    text(value.sessionId, 256) && text(value.sessionFamilyId, 256) && isPrincipal(value.principal);
}

function isHumanContext(value: unknown): boolean {
  return isRecord(value) && exact(value, [
    "kind", "sessionId", "sessionFamilyId", "principal", "requestId", "idempotencyKey",
  ]) && value.kind === "human" && text(value.sessionId, 256) && text(value.sessionFamilyId, 256) &&
    isPrincipal(value.principal) && text(value.requestId, 256) && text(value.idempotencyKey, 256);
}

function isAgentContext(value: unknown): boolean {
  return isRecord(value) && exact(value, ["kind", "agent", "requestId", "idempotencyKey"]) &&
    value.kind === "agent" && isRecord(value.agent) && exact(value.agent, ["actorId", "kind"]) &&
    value.agent.kind === "agent" && text(value.agent.actorId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) &&
    text(value.requestId, 256) && text(value.idempotencyKey, 256);
}

function isActorContext(value: unknown): boolean {
  return isHumanContext(value) || isAgentContext(value);
}

export function isProjectLoopAuthorityOperation(value: unknown): value is ProjectLoopAuthorityOperation {
  if (!isRecord(value) || typeof value.type !== "string" || !integer(value.now)) return false;
  if (value.type === "project-loop.snapshot.read") {
    return exact(value, ["type", "context", "roomId", "projectId", "afterEventSeq", "limit", "now"]) &&
      (isSessionContext(value.context) || isHumanContext(value.context)) &&
      text(value.roomId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) && value.projectId === value.roomId &&
      integer(value.afterEventSeq) && integer(value.limit) && value.limit > 0 &&
      value.limit <= PROJECT_LOOP_AUTHORITY_LIMITS.pageLimit;
  }
  if (value.type === "project-loop.proposal.create") {
    if (!exact(value, ["type", "context", "command", "now"]) || !isActorContext(value.context) ||
        !isRecord(value.command) || !exact(value.command, [
          "proposalId", "roomId", "projectId", "factKind", "factId", "baseRevision",
          "principalActorId", "expiresAt", "payload", "source",
        ])) return false;
    return text(value.command.proposalId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) &&
      text(value.command.roomId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) &&
      value.command.projectId === value.command.roomId && isFactKind(value.command.factKind) &&
      text(value.command.factId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) && integer(value.command.baseRevision) &&
      text(value.command.principalActorId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) &&
      typeof value.command.expiresAt === "string" && Number.isFinite(Date.parse(value.command.expiresAt)) &&
      isPayload(value.command.payload) && isSource(value.command.source, value.command.roomId);
  }
  if (value.type === "project-loop.proposal.resolve") {
    return exact(value, ["type", "context", "command", "now"]) && isHumanContext(value.context) &&
      isRecord(value.command) && exact(value.command, [
        "proposalId", "roomId", "projectId", "expectedRevision", "resolution", "reason",
      ]) && text(value.command.proposalId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) &&
      text(value.command.roomId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) &&
      value.command.projectId === value.command.roomId && integer(value.command.expectedRevision) &&
      ((value.command.resolution === "confirmed" && value.command.reason === null) ||
        (value.command.resolution === "rejected" &&
          text(value.command.reason, PROJECT_LOOP_AUTHORITY_LIMITS.textBytes)));
  }
  return value.type === "project-loop.fact.transition" &&
    exact(value, ["type", "context", "command", "now"]) && isActorContext(value.context) &&
    isRecord(value.command) && exact(value.command, [
      "roomId", "projectId", "factKind", "factId", "expectedRevision", "transition", "payload",
    ]) && text(value.command.roomId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) &&
    value.command.projectId === value.command.roomId && isFactKind(value.command.factKind) &&
    text(value.command.factId, PROJECT_LOOP_AUTHORITY_LIMITS.idBytes) && integer(value.command.expectedRevision) &&
    text(value.command.transition, 64) && isPayload(value.command.payload) &&
    transitionPayload(value.command.factKind, value.command.transition, value.command.payload,
      value.command.roomId);
}

export function projectLoopAuthorityResultAsJson(result: ProjectLoopAuthorityResult): JsonValue {
  return result as unknown as JsonValue;
}

export function isProjectLoopAuthorityResult(value: unknown): value is ProjectLoopAuthorityResult {
  if (!isRecord(value)) return false;
  if (value.kind === "project-loop-mutation") {
    return exact(value, ["kind", "roomId", "projectId", "acceptedRevision", "eventIds", "replayed"]) &&
      typeof value.roomId === "string" && value.projectId === value.roomId &&
      integer(value.acceptedRevision) && Array.isArray(value.eventIds) &&
      value.eventIds.every((eventId) => typeof eventId === "string") && typeof value.replayed === "boolean";
  }
  return value.kind === "project-loop-snapshot" &&
    exact(value, ["kind", "snapshot", "events", "nextEventSeq"]) && isProjectSnapshot(value.snapshot) &&
    Array.isArray(value.events) && value.events.every(isProjectEvent) && integer(value.nextEventSeq);
}
