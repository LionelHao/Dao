export type ActorKind = "human" | "agent";

export type HumanReachability = "online" | "dnd" | "offline";
export type AgentReadiness = "ready" | "busy" | "paused" | "noauth";

export interface HumanActor {
  readonly id: string;
  readonly kind: "human";
  readonly displayName: string;
  readonly reachability: HumanReachability;
}

export interface AgentActor {
  readonly id: string;
  readonly kind: "agent";
  readonly displayName: string;
  readonly readiness: AgentReadiness;
  readonly toolPermissions: readonly string[];
}

export type Actor = HumanActor | AgentActor;

export interface Event {
  readonly id: string;
  readonly type: string;
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly roomId: string;
  readonly occurredAt: string;
}

export interface Message {
  readonly id: string;
  readonly roomId: string;
  readonly authorId: string;
  readonly authorKind: ActorKind;
  readonly body: string;
  readonly sentAt: string;
}

export interface MessageAcceptedAck {
  readonly type: "message.accepted";
  readonly requestId: string;
  readonly messageId: string;
  readonly persistedAt: string;
}

export interface Room {
  readonly id: string;
  readonly name: string;
  readonly memberIds: readonly string[];
  readonly createdAt: string;
}

export type HumanRoomRole = "owner" | "admin" | "member";
export type AgentParticipation = "active" | "on-mention" | "silent";
export type RoomStatus = "active" | "archived";

export interface HumanRoomMembership {
  readonly kind: "human";
  readonly actorId: string;
  readonly role: HumanRoomRole;
  readonly joinedAt: string;
  readonly participation?: never;
  readonly toolPermissions?: never;
  readonly configuredAt?: never;
}

export interface AgentRoomMembership {
  readonly kind: "agent";
  readonly actorId: string;
  readonly participation: AgentParticipation;
  readonly toolPermissions: readonly string[];
  readonly configuredAt: string;
  readonly role?: never;
  readonly joinedAt?: never;
}

export interface HumanInvitationRequest {
  readonly kind: "human-invitation";
  readonly roomId: string;
  readonly inviteeActorId: string;
  readonly agentId?: never;
  readonly participation?: never;
  readonly toolPermissions?: never;
}

export interface AgentConfigurationRequest {
  readonly kind: "agent-configuration";
  readonly roomId: string;
  readonly agentId: string;
  readonly participation: AgentParticipation;
  readonly toolPermissions: readonly string[];
  readonly inviteeActorId?: never;
}

export interface MessageDraft {
  readonly id: string;
  readonly roomId: string;
  readonly body: string;
  readonly sentAt: string;
  readonly authorId?: never;
  readonly authorKind?: never;
}

export interface ManagedRoom {
  readonly id: string;
  readonly name: string;
  readonly status: RoomStatus;
  readonly members: readonly (HumanRoomMembership | AgentRoomMembership)[];
  readonly createdAt: string;
}

type UnknownRecord = Record<string, unknown>;

const humanReachability = new Set<HumanReachability>(["online", "dnd", "offline"]);
const agentReadiness = new Set<AgentReadiness>(["ready", "busy", "paused", "noauth"]);
const humanRoomRoles = new Set<HumanRoomRole>(["owner", "admin", "member"]);
const agentParticipations = new Set<AgentParticipation>([
  "active",
  "on-mention",
  "silent",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}

function hasStringArray(value: UnknownRecord, key: string): boolean {
  return Array.isArray(value[key]) && value[key].every((entry) => typeof entry === "string");
}

function hasNonEmptyStringArray(value: UnknownRecord, key: string): boolean {
  return hasStringArray(value, key) && (value[key] as readonly string[]).length > 0;
}

function isActorKind(value: unknown): value is ActorKind {
  return value === "human" || value === "agent";
}

function isHumanReachability(value: unknown): value is HumanReachability {
  return typeof value === "string" && humanReachability.has(value as HumanReachability);
}

function isAgentReadiness(value: unknown): value is AgentReadiness {
  return typeof value === "string" && agentReadiness.has(value as AgentReadiness);
}

function isHumanRoomRole(value: unknown): value is HumanRoomRole {
  return typeof value === "string" && humanRoomRoles.has(value as HumanRoomRole);
}

function isAgentParticipation(value: unknown): value is AgentParticipation {
  return (
    typeof value === "string" && agentParticipations.has(value as AgentParticipation)
  );
}

export function isHumanActor(value: unknown): value is HumanActor {
  return (
    isRecord(value) &&
    value.kind === "human" &&
    hasString(value, "id") &&
    hasString(value, "displayName") &&
    isHumanReachability(value.reachability) &&
    !("readiness" in value) &&
    !("toolPermissions" in value)
  );
}

export function isAgentActor(value: unknown): value is AgentActor {
  return (
    isRecord(value) &&
    value.kind === "agent" &&
    hasString(value, "id") &&
    hasString(value, "displayName") &&
    isAgentReadiness(value.readiness) &&
    hasStringArray(value, "toolPermissions") &&
    !("reachability" in value)
  );
}

export function isActor(value: unknown): value is Actor {
  return isHumanActor(value) || isAgentActor(value);
}

export function isEvent(value: unknown): value is Event {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "type") &&
    hasString(value, "actorId") &&
    isActorKind(value.actorKind) &&
    hasString(value, "roomId") &&
    hasString(value, "occurredAt")
  );
}

export function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "roomId") &&
    hasString(value, "authorId") &&
    isActorKind(value.authorKind) &&
    hasString(value, "body") &&
    hasString(value, "sentAt")
  );
}

export function isMessageAcceptedAck(value: unknown): value is MessageAcceptedAck {
  return (
    isRecord(value) &&
    value.type === "message.accepted" &&
    hasString(value, "requestId") &&
    hasString(value, "messageId") &&
    hasString(value, "persistedAt")
  );
}

export function isRoom(value: unknown): value is Room {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "name") &&
    hasStringArray(value, "memberIds") &&
    hasString(value, "createdAt")
  );
}

export function isHumanRoomMembership(value: unknown): value is HumanRoomMembership {
  return (
    isRecord(value) &&
    value.kind === "human" &&
    hasString(value, "actorId") &&
    isHumanRoomRole(value.role) &&
    hasString(value, "joinedAt") &&
    !("participation" in value) &&
    !("toolPermissions" in value) &&
    !("configuredAt" in value)
  );
}

export function isAgentRoomMembership(value: unknown): value is AgentRoomMembership {
  return (
    isRecord(value) &&
    value.kind === "agent" &&
    hasString(value, "actorId") &&
    isAgentParticipation(value.participation) &&
    hasNonEmptyStringArray(value, "toolPermissions") &&
    hasString(value, "configuredAt") &&
    !("role" in value) &&
    !("joinedAt" in value)
  );
}

export function isHumanInvitationRequest(
  value: unknown,
): value is HumanInvitationRequest {
  return (
    isRecord(value) &&
    value.kind === "human-invitation" &&
    hasString(value, "roomId") &&
    hasString(value, "inviteeActorId") &&
    !("agentId" in value) &&
    !("participation" in value) &&
    !("toolPermissions" in value)
  );
}

export function isAgentConfigurationRequest(
  value: unknown,
): value is AgentConfigurationRequest {
  return (
    isRecord(value) &&
    value.kind === "agent-configuration" &&
    hasString(value, "roomId") &&
    hasString(value, "agentId") &&
    isAgentParticipation(value.participation) &&
    hasNonEmptyStringArray(value, "toolPermissions") &&
    !("inviteeActorId" in value)
  );
}

export function isMessageDraft(value: unknown): value is MessageDraft {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "roomId") &&
    hasString(value, "body") &&
    hasString(value, "sentAt") &&
    !("authorId" in value) &&
    !("authorKind" in value)
  );
}

export {
  isAgentExecution,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isOpenItem,
  isSocialReaction,
} from "./collaboration.js";
export type {
  AgentExecution,
  AgentExecutionStatus,
  AgentJudgement,
  AgentJudgementOutcome,
  CalibrationSignal,
  HumanReadReceipt,
  OpenItem,
  OpenItemStatus,
  OpenItemTransfer,
  SocialReaction,
} from "./collaboration.js";
export {
  isRoomCursor,
  isRoomRepairPage,
  isRoomSyncResult,
  isSnapshotCompleted,
  isSnapshotVersion,
  isWorkspaceBootstrapPage,
} from "./sync.js";
export type {
  PersistedIdentityEvent,
  PersistedRoomEvent,
  LegacyUnknownCalibrationSignal,
  RoomCursor,
  RoomRepairPage,
  RoomRepairRecord,
  RoomSummary,
  RoomSyncRequest,
  RoomSyncResult,
  SnapshotCompleted,
  SnapshotDeliveryMode,
  SnapshotVersion,
  WorkspaceBootstrapPage,
} from "./sync.js";
