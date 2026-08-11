import {
  isActor,
  isAgentExecution,
  isAgentJudgement,
  isAgentRoomMembership,
  isCalibrationSignal,
  isHumanReadReceipt,
  isRoomCursor,
  isHumanRoomMembership,
  isMessage,
  isOpenItem,
} from "@native-im/core";
import type {
  AgentExecutionStatus,
  AgentJudgementOutcome,
  AgentParticipation,
  Actor,
  ManagedRoom,
  Message,
  MessageDraft,
  PersistedIdentityEvent,
  PersistedRoomEvent,
  RoomSyncRequest,
  RoomSyncResult,
} from "@native-im/core";
import type { AuthenticatedPrincipal } from "../auth.js";
import type { RoomAuditRecord } from "../room-lifecycle.js";

export interface AuthenticatedSessionContext {
  readonly sessionId: string;
  readonly sessionFamilyId: string;
  readonly principal: AuthenticatedPrincipal;
}

export interface HashedSessionIssue {
  readonly accountId: string;
  readonly actorId: string;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

export interface HashedSessionRotation {
  readonly currentRefreshTokenHash: string;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly expectedPrincipal?: AuthenticatedPrincipal;
  readonly now: number;
}

export interface IssuedSessionRecord {
  readonly sessionId: string;
  readonly familyId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
}

export interface SessionAuthority {
  issue(input: HashedSessionIssue): Promise<IssuedSessionRecord>;
  authenticate(
    accessTokenHash: string,
    now: number,
  ): Promise<AuthenticatedSessionContext>;
  validateRefresh(
    currentRefreshTokenHash: string,
    expectedPrincipal: AuthenticatedPrincipal | undefined,
    now: number,
  ): Promise<void>;
  rotate(input: HashedSessionRotation): Promise<IssuedSessionRecord>;
  revoke(accessTokenHash: string, now: number): Promise<void>;
}

export interface AuthenticatedCommandContext extends AuthenticatedSessionContext {
  readonly kind: "human";
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface AgentPrincipal {
  readonly actorId: string;
  readonly kind: "agent";
}

const internalCommandAuthority: unique symbol = Symbol("internal-agent-command-authority");
const internalAgentCommandContexts = new WeakSet<object>();

export interface InternalAgentCommandContext {
  readonly kind: "agent";
  readonly [internalCommandAuthority]: true;
  readonly agent: AgentPrincipal;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface AgentWorkerCommandContext {
  readonly kind: "agent";
  readonly agent: AgentPrincipal;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface InternalAgentCommandContextInput {
  readonly agentId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

class AgentCapabilityForbiddenError extends Error {
  readonly status = 403 as const;
  readonly code = "agent_capability_forbidden" as const;

  constructor() {
    super("agent_capability_forbidden");
    this.name = "AgentCapabilityForbiddenError";
  }
}

export function mintInternalAgentCommandContext(
  input: InternalAgentCommandContextInput,
): InternalAgentCommandContext {
  if (
    typeof input.agentId !== "string" ||
    input.agentId.trim().length === 0 ||
    typeof input.requestId !== "string" ||
    input.requestId.trim().length === 0 ||
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.trim().length === 0
  ) {
    throw new TypeError("Internal Agent command context fields must be non-empty");
  }
  const context: InternalAgentCommandContext = Object.freeze({
    kind: "agent",
    [internalCommandAuthority]: true as const,
    agent: Object.freeze({ actorId: input.agentId, kind: "agent" }),
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
  });
  internalAgentCommandContexts.add(context);
  return context;
}

export function isInternalAgentCommandContext(
  value: unknown,
): value is InternalAgentCommandContext {
  return typeof value === "object" && value !== null && internalAgentCommandContexts.has(value);
}

export function toAgentWorkerCommandContext(
  context: InternalAgentCommandContext,
): AgentWorkerCommandContext {
  if (!isInternalAgentCommandContext(context)) {
    throw new AgentCapabilityForbiddenError();
  }
  return Object.freeze({
    kind: "agent",
    agent: Object.freeze({ ...context.agent }),
    requestId: context.requestId,
    idempotencyKey: context.idempotencyKey,
  });
}

type CommandActorFreePayload = {
  readonly actorId?: never;
  readonly agentId?: never;
  readonly authorId?: never;
  readonly authorKind?: never;
};

export type CollaborationCommand =
  | { readonly type: "message.send"; readonly roomId: string; readonly payload: MessageDraft & CommandActorFreePayload }
  | {
      readonly type: "human.read.record";
      readonly roomId: string;
      readonly payload: { readonly messageId: string } & CommandActorFreePayload;
    }
  | {
      readonly type: "agent.judgment.record";
      readonly roomId: string;
      readonly payload: {
        readonly messageId: string;
        readonly outcome: AgentJudgementOutcome;
        readonly reason: string;
      } & CommandActorFreePayload;
    }
  | {
      readonly type: "open-item.create";
      readonly roomId: string;
      readonly payload: {
        readonly sourceMessageId: string;
        readonly ownerId: string;
        readonly content: string;
      } & CommandActorFreePayload;
    }
  | {
      readonly type: "open-item.transition";
      readonly roomId: string;
      readonly payload: {
        readonly itemId: string;
        readonly action: "respond" | "defer" | "transfer";
        readonly targetId?: string;
        readonly reason?: string;
      } & CommandActorFreePayload;
    }
  | {
      readonly type: "agent.execution.transition";
      readonly roomId: string;
      readonly payload: {
        readonly executionId: string;
        readonly sourceMessageId: string;
        readonly toolName: string;
        readonly status: AgentExecutionStatus;
        readonly result?: string;
      } & CommandActorFreePayload;
    }
  | {
      readonly type: "calibration.record";
      readonly roomId: string;
      readonly payload: {
        readonly sourceMessageId: string;
        readonly emoji: "👍" | "👎";
      } & CommandActorFreePayload;
    };

export type HumanCollaborationCommand = Extract<
  CollaborationCommand,
  { readonly type: "message.send" | "human.read.record" | "open-item.create" | "open-item.transition" | "calibration.record" }
>;

export type AgentCollaborationCommand = Extract<
  CollaborationCommand,
  { readonly type: "message.send" | "agent.judgment.record" | "open-item.create" | "open-item.transition" | "agent.execution.transition" }
>;

export type RoomGovernanceCommand =
  | { readonly type: "room.create"; readonly payload: { readonly name: string } }
  | { readonly type: "room.rename"; readonly roomId: string; readonly payload: { readonly name: string } }
  | { readonly type: "room.archive"; readonly roomId: string; readonly payload: Record<string, never> }
  | {
      readonly type: "human.invitation.issue";
      readonly roomId: string;
      readonly payload: { readonly inviteeActorId: string };
    }
  | {
      readonly type: "human.invitation.decide";
      readonly payload: { readonly token: string; readonly decision: "accept" | "reject" };
    }
  | {
      readonly type: "agent.configure";
      readonly roomId: string;
      readonly payload: {
        readonly agentId: string;
        readonly participation: AgentParticipation;
        readonly toolPermissions: readonly string[];
      };
    }
  | {
      readonly type: "human.role.change";
      readonly roomId: string;
      readonly payload: { readonly targetActorId: string; readonly role: "admin" | "member" };
    }
  | {
      readonly type: "member.remove";
      readonly roomId: string;
      readonly payload: { readonly targetActorId: string };
    };

export type PersistentCommand = CollaborationCommand | RoomGovernanceCommand;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CommandAcknowledgement {
  readonly aggregateId: string;
  readonly eventIds: readonly string[];
  readonly acceptedAt: string;
  readonly result: JsonValue;
}

interface OutboxDeliveryBase {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly targetId: string;
  readonly streamSeq: number;
  readonly attempts: number;
}

type PersistedSessionRevokedEvent = PersistedIdentityEvent & {
  readonly type: "identity.session.revoked";
};

type PersistedRoomAccessChangedEvent = PersistedIdentityEvent & {
  readonly type: "identity.room-access.changed";
};

export type OutboxDelivery =
  | (OutboxDeliveryBase & {
      readonly targetKind: "room";
      readonly event: PersistedRoomEvent;
    })
  | (OutboxDeliveryBase & {
      readonly targetKind: "principal";
      readonly event: PersistedRoomAccessChangedEvent;
    })
  | (OutboxDeliveryBase & {
      readonly targetKind: "session-family";
      readonly event: PersistedSessionRevokedEvent;
    });

export interface OutboxDispatchCandidate {
  readonly connectionId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly sessionId: string;
  readonly sessionFamilyId: string;
  readonly credentialGeneration: number;
}

export type OutboxDeliveryFailureReason =
  | "closed"
  | "backpressure"
  | "send_rejected";

export interface CommandStore {
  executeHuman(
    context: AuthenticatedCommandContext,
    command: HumanCollaborationCommand | RoomGovernanceCommand,
  ): Promise<CommandAcknowledgement>;
  executeAgent(
    context: InternalAgentCommandContext,
    command: AgentCollaborationCommand,
  ): Promise<CommandAcknowledgement>;
}

export interface SyncQueryStore {
  syncRoom(context: AuthenticatedSessionContext, request: RoomSyncRequest): Promise<RoomSyncResult>;
  readHistory(context: AuthenticatedSessionContext, roomId: string): Promise<readonly Message[]>;
  readActor(actorId: string): Promise<Actor | undefined>;
  readRoom(roomId: string): Promise<ManagedRoom | undefined>;
  canAccessRoom(context: AuthenticatedSessionContext, roomId: string): Promise<boolean>;
  readRoomAudit(
    context: AuthenticatedSessionContext,
    roomId: string,
  ): Promise<readonly RoomAuditRecord[]>;
  listPendingOutbox(limit: number): Promise<readonly OutboxDelivery[]>;
  authorizeOutboxCandidate(
    delivery: OutboxDelivery,
    candidate: OutboxDispatchCandidate,
  ): Promise<boolean>;
  markOutboxDispatched(deliveryId: string): Promise<void>;
  markOutboxFailed(
    deliveryId: string,
    reason: OutboxDeliveryFailureReason,
  ): Promise<void>;
}

export const ROOM_SYNC_DEFAULT_LIMIT = 100;
export const ROOM_SYNC_MAX_LIMIT = 1_000;
export const ROOM_SYNC_MAX_PAGE_BYTES = 256 * 1_024;

export type ContractParseResult<T, TCode extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: TCode };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function count(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function stringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length;
}

export function parseRoomSyncRequest(
  value: unknown,
): ContractParseResult<RoomSyncRequest, "invalid_request"> {
  if (!isRecord(value)) {
    return { ok: false, code: "invalid_request" };
  }
  const optional = [
    ...(Object.hasOwn(value, "cursor") ? ["cursor"] : []),
    ...(Object.hasOwn(value, "limit") ? ["limit"] : []),
  ];
  if (
    !exact(value, ["type", "requestId", "roomId"], optional) ||
    value.type !== "room.sync" ||
    !text(value.requestId) ||
    !text(value.roomId) ||
    (Object.hasOwn(value, "cursor") && !isRoomCursor(value.cursor)) ||
    (Object.hasOwn(value, "limit") &&
      (!count(value.limit, 1) || value.limit > ROOM_SYNC_MAX_LIMIT))
  ) {
    return { ok: false, code: "invalid_request" };
  }
  return { ok: true, value: value as unknown as RoomSyncRequest };
}

function messageDraft(value: unknown, roomId: string): value is MessageDraft {
  return isRecord(value) && exact(value, ["id", "roomId", "body", "sentAt"]) &&
    text(value.id) && value.roomId === roomId && text(value.body) && text(value.sentAt);
}

function commandEnvelope(value: UnknownRecord, withRoom: boolean): value is UnknownRecord {
  return exact(value, withRoom ? ["type", "roomId", "payload"] : ["type", "payload"]) &&
    text(value.type) && (!withRoom || text(value.roomId)) && isRecord(value.payload);
}

function isCollaborationCommand(value: UnknownRecord): boolean {
  if (!commandEnvelope(value, true)) {
    return false;
  }
  const payload = value.payload as UnknownRecord;
  if (value.type === "message.send") {
    return messageDraft(payload, value.roomId as string);
  }
  if (value.type === "human.read.record") {
    return exact(payload, ["messageId"]) && text(payload.messageId);
  }
  if (value.type === "agent.judgment.record") {
    return exact(payload, ["messageId", "outcome", "reason"]) && text(payload.messageId) &&
      (payload.outcome === "will_respond" || payload.outcome === "no_response_needed" || payload.outcome === "suppressed") &&
      text(payload.reason);
  }
  if (value.type === "open-item.create") {
    return exact(payload, ["sourceMessageId", "ownerId", "content"]) &&
      text(payload.sourceMessageId) && text(payload.ownerId) && text(payload.content);
  }
  if (value.type === "open-item.transition") {
    if (payload.action === "transfer") {
      return exact(payload, ["itemId", "action", "targetId", "reason"]) &&
        text(payload.itemId) && text(payload.targetId) && text(payload.reason);
    }
    return (payload.action === "respond" || payload.action === "defer") &&
      exact(payload, ["itemId", "action"]) && text(payload.itemId);
  }
  if (value.type === "agent.execution.transition") {
    return exact(payload, ["executionId", "sourceMessageId", "toolName", "status"], ["result"]) &&
      text(payload.executionId) && text(payload.sourceMessageId) && text(payload.toolName) &&
      (payload.status === "running" || payload.status === "completed" || payload.status === "interrupted" || payload.status === "failed") &&
      (payload.result === undefined || text(payload.result));
  }
  return value.type === "calibration.record" &&
    exact(payload, ["sourceMessageId", "emoji"]) && text(payload.sourceMessageId) &&
    (payload.emoji === "👍" || payload.emoji === "👎");
}

function isGovernanceCommand(value: UnknownRecord): boolean {
  const withRoom = value.type !== "room.create" && value.type !== "human.invitation.decide";
  if (!commandEnvelope(value, withRoom)) {
    return false;
  }
  const payload = value.payload as UnknownRecord;
  if (value.type === "room.create" || value.type === "room.rename") {
    return exact(payload, ["name"]) && text(payload.name);
  }
  if (value.type === "room.archive") {
    return exact(payload, []);
  }
  if (value.type === "human.invitation.issue") {
    return exact(payload, ["inviteeActorId"]) && text(payload.inviteeActorId);
  }
  if (value.type === "human.invitation.decide") {
    return exact(payload, ["token", "decision"]) && text(payload.token) &&
      (payload.decision === "accept" || payload.decision === "reject");
  }
  if (value.type === "agent.configure") {
    return exact(payload, ["agentId", "participation", "toolPermissions"]) && text(payload.agentId) &&
      (payload.participation === "active" || payload.participation === "on-mention" || payload.participation === "silent") &&
      stringList(payload.toolPermissions);
  }
  if (value.type === "human.role.change") {
    return exact(payload, ["targetActorId", "role"]) && text(payload.targetActorId) &&
      (payload.role === "admin" || payload.role === "member");
  }
  return value.type === "member.remove" && exact(payload, ["targetActorId"]) && text(payload.targetActorId);
}

export function parsePersistentCommand(
  value: unknown,
): ContractParseResult<PersistentCommand, "invalid_command"> {
  return isRecord(value) && (isCollaborationCommand(value) || isGovernanceCommand(value))
    ? { ok: true, value: value as PersistentCommand }
    : { ok: false, code: "invalid_command" };
}

function roomEventEnvelope(value: UnknownRecord): value is UnknownRecord {
  return exact(
    value,
    ["eventId", "streamKind", "streamId", "streamSeq", "roomId", "actorId", "occurredAt", "type", "payload"],
  ) && value.streamKind === "room" && text(value.eventId) && text(value.streamId) &&
    value.streamId === value.roomId && count(value.streamSeq, 1) && text(value.actorId) &&
    text(value.occurredAt) && text(value.type) && isRecord(value.payload);
}

function strictMessage(value: unknown): boolean {
  return isRecord(value) && exact(value, ["id", "roomId", "authorId", "authorKind", "body", "sentAt"]) && isMessage(value) &&
    text(value.id) && text(value.roomId) && text(value.authorId) && text(value.body) && text(value.sentAt);
}

function strictHumanMembership(value: unknown): boolean {
  return isRecord(value) && exact(value, ["kind", "actorId", "role", "joinedAt"]) && isHumanRoomMembership(value) &&
    text(value.actorId) && text(value.joinedAt);
}

function strictAgentMembership(value: unknown): boolean {
  return isRecord(value) && exact(value, ["kind", "actorId", "participation", "toolPermissions", "configuredAt"]) &&
    isAgentRoomMembership(value) && text(value.actorId) && stringList(value.toolPermissions) && text(value.configuredAt);
}

function strictManagedRoom(value: unknown): boolean {
  return isRecord(value) && exact(value, ["id", "name", "status", "members", "createdAt"]) &&
    text(value.id) && text(value.name) && (value.status === "active" || value.status === "archived") &&
    Array.isArray(value.members) && value.members.every((entry) => strictHumanMembership(entry) || strictAgentMembership(entry)) &&
    text(value.createdAt);
}

function validRoomEventPayload(
  type: unknown,
  payload: UnknownRecord,
  roomId: string,
  eventActorId: string,
): boolean {
  if (type === "room.created" || type === "room.renamed" || type === "room.archived") {
    return exact(payload, ["room"]) && strictManagedRoom(payload.room) &&
      (payload.room as { readonly id: string }).id === roomId;
  }
  if (type === "human.invitation.issued") {
    return exact(payload, ["invitationId", "inviteeActorId"]) && text(payload.invitationId) && text(payload.inviteeActorId);
  }
  if (type === "human.invitation.accepted") {
    return exact(payload, ["invitationId", "membership"]) && text(payload.invitationId) && strictHumanMembership(payload.membership);
  }
  if (type === "human.invitation.rejected") {
    return exact(payload, ["invitationId", "targetActorId"]) && text(payload.invitationId) && text(payload.targetActorId);
  }
  if (type === "human.role.changed") {
    return exact(payload, ["membership"]) && strictHumanMembership(payload.membership);
  }
  if (type === "member.removed") {
    return exact(payload, ["targetActorId"]) && text(payload.targetActorId);
  }
  if (type === "agent.configured") {
    return exact(payload, ["membership"]) && strictAgentMembership(payload.membership);
  }
  if (type === "room.message.accepted") {
    return strictMessage(payload) && payload.roomId === roomId && payload.authorId === eventActorId;
  }
  if (type === "room.human_read.recorded") {
    return isHumanReadReceipt(payload) && payload.readerId === eventActorId;
  }
  if (type === "room.agent_judgment.recorded") {
    return isAgentJudgement(payload) && payload.agentId === eventActorId;
  }
  if (type === "room.open_item.changed") {
    return isOpenItem(payload) && payload.roomId === roomId;
  }
  if (type === "room.agent_execution.changed") {
    return isAgentExecution(payload) && payload.roomId === roomId && payload.agentId === eventActorId;
  }
  return type === "room.calibration.recorded" && isCalibrationSignal(payload) && payload.actorId === eventActorId;
}

export function parsePersistedRoomEvent(
  value: unknown,
): ContractParseResult<PersistedRoomEvent, "invalid_event"> {
  return isRecord(value) && roomEventEnvelope(value) && validRoomEventPayload(
    value.type,
    value.payload as UnknownRecord,
    value.roomId as string,
    value.actorId as string,
  )
    ? { ok: true, value: value as unknown as PersistedRoomEvent }
    : { ok: false, code: "invalid_event" };
}

function identityEventEnvelope(value: UnknownRecord): value is UnknownRecord {
  return exact(
    value,
    ["eventId", "streamKind", "streamId", "streamSeq", "actorId", "occurredAt", "type", "payload"],
  ) && value.streamKind === "identity" && text(value.eventId) && text(value.streamId) &&
    value.streamId === value.actorId && count(value.streamSeq, 1) && text(value.actorId) &&
    text(value.occurredAt) && text(value.type) && isRecord(value.payload);
}

function strictActor(value: unknown): boolean {
  if (!isRecord(value) || !isActor(value)) return false;
  return value.kind === "human"
    ? exact(value, ["id", "kind", "displayName", "reachability"])
    : exact(value, ["id", "kind", "displayName", "readiness", "toolPermissions"]);
}

function validIdentityEventPayload(type: unknown, payload: UnknownRecord): boolean {
  if (type === "identity.actor.registered") {
    return exact(payload, ["actor"]) && strictActor(payload.actor);
  }
  if (type === "identity.session.issued" || type === "identity.session.rotated" || type === "identity.session.revoked") {
    return exact(payload, ["sessionId", "familyId", "accountId"]) &&
      text(payload.sessionId) && text(payload.familyId) && text(payload.accountId);
  }
  return type === "identity.room-access.changed" &&
    exact(payload, ["roomId", "change"]) && text(payload.roomId) &&
    (payload.change === "joined" || payload.change === "updated" || payload.change === "removed" || payload.change === "archived");
}

export function parsePersistedIdentityEvent(
  value: unknown,
): ContractParseResult<PersistedIdentityEvent, "invalid_event"> {
  return isRecord(value) && identityEventEnvelope(value) && validIdentityEventPayload(value.type, value.payload as UnknownRecord) &&
    (value.type !== "identity.actor.registered" ||
      (value.payload as { readonly actor: { readonly id: string } }).actor.id === value.streamId)
    ? { ok: true, value: value as unknown as PersistedIdentityEvent }
    : { ok: false, code: "invalid_event" };
}
