import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  Actor,
  AgentActor,
  AgentConfigurationRequest,
  AgentParticipation,
  AgentRoomMembership,
  HumanActor,
  HumanInvitationRequest,
  HumanRoomMembership,
  ManagedRoom,
  Room,
} from "@native-im/core";
import type { StateStore } from "./state-store.js";
import type {
  AuthenticatedCommandContext,
  AuthenticatedSessionContext,
  CommandAcknowledgement,
  CommandStore,
  SyncQueryStore,
} from "./persistence/contracts.js";

const STATE_FIELDS = new Set(["version", "actors", "rooms", "invitations", "audit"]);
const HUMAN_ACTOR_FIELDS = new Set([
  "id",
  "kind",
  "displayName",
  "reachability",
]);
const AGENT_ACTOR_FIELDS = new Set([
  "id",
  "kind",
  "displayName",
  "readiness",
  "toolPermissions",
]);
const ROOM_FIELDS = new Set(["id", "name", "status", "members", "createdAt"]);
const HUMAN_MEMBERSHIP_FIELDS = new Set(["kind", "actorId", "role", "joinedAt"]);
const AGENT_MEMBERSHIP_FIELDS = new Set([
  "kind",
  "actorId",
  "participation",
  "toolPermissions",
  "configuredAt",
]);
const PENDING_INVITATION_FIELDS = new Set([
  "id",
  "roomId",
  "inviterActorId",
  "inviteeActorId",
  "tokenHash",
  "status",
  "createdAt",
]);
const TERMINAL_INVITATION_FIELDS = new Set([
  ...PENDING_INVITATION_FIELDS,
  "decisionActorId",
  "decidedAt",
]);
const BASE_AUDIT_FIELDS = new Set([
  "id",
  "type",
  "roomId",
  "actorId",
  "result",
  "timestamp",
]);
const TARGET_AUDIT_FIELDS = new Set([...BASE_AUDIT_FIELDS, "targetActorId"]);
const INVITATION_ISSUANCE_AUDIT_FIELDS = new Set([
  ...TARGET_AUDIT_FIELDS,
  "invitationId",
]);
const INVITATION_DECISION_AUDIT_FIELDS = new Set([
  ...TARGET_AUDIT_FIELDS,
  "inviterActorId",
  "invitationId",
]);
const ROLE_CHANGE_AUDIT_FIELDS = new Set([
  ...TARGET_AUDIT_FIELDS,
  "role",
]);
const OWNERSHIP_TRANSFER_AUDIT_FIELDS = new Set([
  ...TARGET_AUDIT_FIELDS,
  "previousOwnerActorId",
  "previousGovernanceRevision",
  "governanceRevision",
]);
const AGENT_CONFIGURATION_AUDIT_FIELDS = new Set([
  ...TARGET_AUDIT_FIELDS,
  "participation",
  "toolPermissions",
]);
const HUMAN_INVITATION_REQUEST_FIELDS = new Set([
  "kind",
  "roomId",
  "inviteeActorId",
]);
const AGENT_CONFIGURATION_REQUEST_FIELDS = new Set([
  "kind",
  "roomId",
  "agentId",
  "participation",
  "toolPermissions",
]);

const humanReachability = new Set(["online", "dnd", "offline"]);
const agentReadiness = new Set(["ready", "busy", "paused", "noauth"]);
const humanRoles = new Set(["owner", "admin", "member"]);
const agentParticipations = new Set<AgentParticipation>([
  "active",
  "on-mention",
]);

export type HumanInvitationStatus = "pending" | "accepted" | "rejected";

export interface HumanInvitationRecord {
  readonly id: string;
  readonly roomId: string;
  readonly inviterActorId: string;
  readonly inviteeActorId: string;
  readonly tokenHash: string;
  readonly status: HumanInvitationStatus;
  readonly createdAt: string;
  readonly decisionActorId?: string;
  readonly decidedAt?: string;
}

export interface IssuedHumanInvitation {
  readonly invitationId: string;
  readonly roomId: string;
  readonly inviterActorId: string;
  readonly inviteeActorId: string;
  readonly token: string;
  readonly createdAt: string;
}

export type RoomAuditType =
  | "room.created"
  | "room.renamed"
  | "room.archived"
  | "room.reopened"
  | "room.human.invited"
  | "room.invitation.accepted"
  | "room.invitation.rejected"
  | "room.agent.configured"
  | "room.member.removed"
  | "room.member.left"
  | "room.member.role.changed"
  | "room.ownership.transferred";

export type RoomAuditResult =
  | "created"
  | "renamed"
  | "archived"
  | "reopened"
  | "pending"
  | "accepted"
  | "rejected"
  | "configured"
  | "removed"
  | "left"
  | "role-changed"
  | "ownership-transferred";

interface BaseRoomAuditRecord<
  Type extends RoomAuditType,
  Result extends RoomAuditResult,
> {
  readonly id: string;
  readonly type: Type;
  readonly roomId: string;
  readonly actorId: string;
  readonly result: Result;
  readonly timestamp: string;
}

interface TargetRoomAuditRecord<
  Type extends RoomAuditType,
  Result extends RoomAuditResult,
> extends BaseRoomAuditRecord<Type, Result> {
  readonly targetActorId: string;
}

export type RoomAuditRecord =
  | BaseRoomAuditRecord<"room.created", "created">
  | BaseRoomAuditRecord<"room.renamed", "renamed">
  | BaseRoomAuditRecord<"room.archived", "archived">
  | BaseRoomAuditRecord<"room.reopened", "reopened">
  | (TargetRoomAuditRecord<"room.human.invited", "pending"> & {
      readonly invitationId: string;
    })
  | (TargetRoomAuditRecord<"room.invitation.accepted", "accepted"> & {
      readonly invitationId: string;
      readonly inviterActorId: string;
    })
  | (TargetRoomAuditRecord<"room.invitation.rejected", "rejected"> & {
      readonly invitationId: string;
      readonly inviterActorId: string;
    })
  | (TargetRoomAuditRecord<"room.agent.configured", "configured"> & {
      readonly participation: AgentParticipation;
      readonly toolPermissions: readonly string[];
    })
  | TargetRoomAuditRecord<"room.member.removed", "removed">
  | TargetRoomAuditRecord<"room.member.left", "left">
  | (TargetRoomAuditRecord<"room.member.role.changed", "role-changed"> & {
      readonly role: "admin" | "member";
    })
  | (TargetRoomAuditRecord<"room.ownership.transferred", "ownership-transferred"> & {
      readonly previousOwnerActorId: string;
      readonly previousGovernanceRevision: number;
      readonly governanceRevision: number;
    });

type RoomAuditInput = RoomAuditRecord extends infer RecordType
  ? RecordType extends RoomAuditRecord
    ? Omit<RecordType, "id">
    : never
  : never;

export interface RoomLifecycleState {
  readonly version: 1;
  readonly actors: readonly Actor[];
  readonly rooms: readonly ManagedRoom[];
  readonly invitations: readonly HumanInvitationRecord[];
  readonly audit: readonly RoomAuditRecord[];
}

export type RoomLifecycleErrorCode =
  | "unauthenticated"
  | "actor_not_found"
  | "human_required"
  | "room_name_invalid"
  | "room_not_found"
  | "room_forbidden"
  | "room_archived"
  | "human_invitation_invalid"
  | "invitee_required"
  | "room_member_exists"
  | "invitation_pending"
  | "invitation_not_found"
  | "invitation_forbidden"
  | "invitation_consumed"
  | "invitation_decision_invalid"
  | "agent_configuration_invalid"
  | "agent_required"
  | "agent_permissions_invalid"
  | "human_member_required"
  | "human_role_invalid"
  | "room_member_not_found"
  | "room_owner_required"
  | "lifecycle_id_conflict"
  | "invitation_token_conflict";

export class RoomLifecycleError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409;
  readonly code: RoomLifecycleErrorCode;

  constructor(
    status: 400 | 401 | 403 | 404 | 409,
    code: RoomLifecycleErrorCode,
  ) {
    super(code);
    this.name = "RoomLifecycleError";
    this.status = status;
    this.code = code;
  }
}

export interface RoomLifecycleServiceOptions {
  readonly actors: readonly Actor[];
  readonly state: StateStore<RoomLifecycleState>;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
  readonly tokenFactory?: () => string;
}

/** T-0039 JSON compatibility adapter. Not an authoritative mutation/query surface. */
export interface RoomLifecycleService {
  createRoom(
    actorId: string,
    input: { readonly name: string },
  ): Promise<ManagedRoom>;
  renameRoom(
    actorId: string,
    roomId: string,
    name: string,
  ): Promise<ManagedRoom>;
  archiveRoom(actorId: string, roomId: string): Promise<ManagedRoom>;
  inviteHuman(
    actorId: string,
    request: HumanInvitationRequest,
  ): Promise<IssuedHumanInvitation>;
  respondToHumanInvitation(
    actorId: string,
    token: string,
    decision: "accept" | "reject",
  ): Promise<HumanInvitationRecord>;
  configureAgent(
    actorId: string,
    request: AgentConfigurationRequest,
  ): Promise<ManagedRoom>;
  setHumanRole(
    actorId: string,
    roomId: string,
    targetActorId: string,
    role: "admin" | "member",
  ): Promise<ManagedRoom>;
  removeMember(
    actorId: string,
    roomId: string,
    targetActorId: string,
  ): Promise<ManagedRoom>;
  canAccess(actorId: string, roomId: string): boolean;
  getActor(actorId: string): Actor | undefined;
  getRoom(roomId: string): ManagedRoom | undefined;
  messageRoom(roomId: string): Room | undefined;
  audit(roomId: string): readonly RoomAuditRecord[];
}

export type T0039CompatibilityRoomLifecycleService = RoomLifecycleService;

export interface AuthoritativeRoomLifecycleServiceOptions {
  readonly commandStore: CommandStore;
  readonly queryStore: Pick<
    SyncQueryStore,
    "readActor" | "readRoom" | "readRoomGovernance" | "canAccessRoom" | "readRoomAudit"
  >;
}

export interface AuthoritativeRoomLifecycleService {
  createRoom(
    context: AuthenticatedCommandContext,
    input: { readonly name: string },
  ): Promise<ManagedRoom>;
  renameRoom(
    context: AuthenticatedCommandContext,
    roomId: string,
    name: string,
  ): Promise<ManagedRoom>;
  archiveRoom(
    context: AuthenticatedCommandContext,
    roomId: string,
  ): Promise<ManagedRoom>;
  inviteHuman(
    context: AuthenticatedCommandContext,
    request: HumanInvitationRequest,
  ): Promise<IssuedHumanInvitation>;
  respondToHumanInvitation(
    context: AuthenticatedCommandContext,
    token: string,
    decision: "accept" | "reject",
  ): Promise<HumanInvitationRecord>;
  configureAgent(
    context: AuthenticatedCommandContext,
    request: AgentConfigurationRequest,
  ): Promise<ManagedRoom>;
  setHumanRole(
    context: AuthenticatedCommandContext,
    roomId: string,
    targetActorId: string,
    role: "admin" | "member",
  ): Promise<ManagedRoom>;
  removeMember(
    context: AuthenticatedCommandContext,
    roomId: string,
    targetActorId: string,
  ): Promise<ManagedRoom>;
  getActor(actorId: string): Promise<Actor | undefined>;
  getRoom(roomId: string): Promise<ManagedRoom | undefined>;
  canAccess(
    context: AuthenticatedCommandContext,
    roomId: string,
  ): Promise<boolean>;
  audit(
    context: AuthenticatedCommandContext,
    roomId: string,
  ): Promise<readonly RoomAuditRecord[]>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(
  value: UnknownRecord,
  allowedFields: ReadonlySet<string>,
): boolean {
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && allowedFields.has(key),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0;
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isTokenHash(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function isStrictHumanActor(value: unknown): value is HumanActor {
  return (
    isRecord(value) &&
    hasOnlyFields(value, HUMAN_ACTOR_FIELDS) &&
    value.kind === "human" &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.displayName) &&
    typeof value.reachability === "string" &&
    humanReachability.has(value.reachability)
  );
}

function isStrictAgentActor(value: unknown): value is AgentActor {
  return (
    isRecord(value) &&
    hasOnlyFields(value, AGENT_ACTOR_FIELDS) &&
    value.kind === "agent" &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.displayName) &&
    typeof value.readiness === "string" &&
    agentReadiness.has(value.readiness) &&
    isStringArray(value.toolPermissions) &&
    hasUniqueStrings(value.toolPermissions)
  );
}

function isStrictActor(value: unknown): value is Actor {
  return isStrictHumanActor(value) || isStrictAgentActor(value);
}

function isHumanMembership(value: unknown): value is HumanRoomMembership {
  return (
    isRecord(value) &&
    hasOnlyFields(value, HUMAN_MEMBERSHIP_FIELDS) &&
    value.kind === "human" &&
    isNonEmptyString(value.actorId) &&
    typeof value.role === "string" &&
    humanRoles.has(value.role) &&
    isIsoTimestamp(value.joinedAt)
  );
}

function isAgentMembership(value: unknown): value is AgentRoomMembership {
  return (
    isRecord(value) &&
    hasOnlyFields(value, AGENT_MEMBERSHIP_FIELDS) &&
    value.kind === "agent" &&
    isNonEmptyString(value.actorId) &&
    typeof value.participation === "string" &&
    agentParticipations.has(value.participation as AgentParticipation) &&
    isNonEmptyStringArray(value.toolPermissions) &&
    hasUniqueStrings(value.toolPermissions) &&
    isIsoTimestamp(value.configuredAt)
  );
}

export function isManagedRoomShape(value: unknown): value is ManagedRoom {
  return (
    isRecord(value) &&
    hasOnlyFields(value, ROOM_FIELDS) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    (value.status === "active" || value.status === "archived") &&
    Array.isArray(value.members) &&
    value.members.every(
      (membership) =>
        isHumanMembership(membership) || isAgentMembership(membership),
    ) &&
    isIsoTimestamp(value.createdAt)
  );
}

function isInvitationShape(value: unknown): value is HumanInvitationRecord {
  if (!isRecord(value)) {
    return false;
  }
  const pending = value.status === "pending";
  const terminal = value.status === "accepted" || value.status === "rejected";
  if (
    (!pending && !terminal) ||
    !hasOnlyFields(
      value,
      pending ? PENDING_INVITATION_FIELDS : TERMINAL_INVITATION_FIELDS,
    ) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.roomId) ||
    !isNonEmptyString(value.inviterActorId) ||
    !isNonEmptyString(value.inviteeActorId) ||
    !isTokenHash(value.tokenHash) ||
    !isIsoTimestamp(value.createdAt)
  ) {
    return false;
  }
  return (
    pending ||
    (isNonEmptyString(value.decisionActorId) && isIsoTimestamp(value.decidedAt))
  );
}

function auditExpectation(type: unknown): {
  readonly fields: ReadonlySet<string>;
  readonly result: RoomAuditResult;
} | undefined {
  switch (type) {
    case "room.created":
      return { fields: BASE_AUDIT_FIELDS, result: "created" };
    case "room.renamed":
      return { fields: BASE_AUDIT_FIELDS, result: "renamed" };
    case "room.archived":
      return { fields: BASE_AUDIT_FIELDS, result: "archived" };
    case "room.reopened":
      return { fields: BASE_AUDIT_FIELDS, result: "reopened" };
    case "room.human.invited":
      return { fields: INVITATION_ISSUANCE_AUDIT_FIELDS, result: "pending" };
    case "room.invitation.accepted":
      return {
        fields: INVITATION_DECISION_AUDIT_FIELDS,
        result: "accepted",
      };
    case "room.invitation.rejected":
      return {
        fields: INVITATION_DECISION_AUDIT_FIELDS,
        result: "rejected",
      };
    case "room.agent.configured":
      return { fields: AGENT_CONFIGURATION_AUDIT_FIELDS, result: "configured" };
    case "room.member.removed":
      return { fields: TARGET_AUDIT_FIELDS, result: "removed" };
    case "room.member.left":
      return { fields: TARGET_AUDIT_FIELDS, result: "left" };
    case "room.member.role.changed":
      return { fields: ROLE_CHANGE_AUDIT_FIELDS, result: "role-changed" };
    case "room.ownership.transferred":
      return {
        fields: OWNERSHIP_TRANSFER_AUDIT_FIELDS,
        result: "ownership-transferred",
      };
    default:
      return undefined;
  }
}

export function isRoomAuditRecord(value: unknown): value is RoomAuditRecord {
  if (!isRecord(value)) {
    return false;
  }
  const expectation = auditExpectation(value.type);
  return (
    expectation !== undefined &&
    hasOnlyFields(value, expectation.fields) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.actorId) &&
    value.result === expectation.result &&
    isIsoTimestamp(value.timestamp) &&
    (!expectation.fields.has("targetActorId") ||
      isNonEmptyString(value.targetActorId)) &&
    (!expectation.fields.has("inviterActorId") ||
      isNonEmptyString(value.inviterActorId)) &&
    (!expectation.fields.has("invitationId") ||
      isNonEmptyString(value.invitationId)) &&
    (!expectation.fields.has("role") ||
      value.role === "admin" ||
      value.role === "member") &&
    (!expectation.fields.has("previousOwnerActorId") ||
      isNonEmptyString(value.previousOwnerActorId)) &&
    (!expectation.fields.has("previousGovernanceRevision") ||
      (typeof value.previousGovernanceRevision === "number" &&
        Number.isSafeInteger(value.previousGovernanceRevision) &&
        value.previousGovernanceRevision >= 0)) &&
    (!expectation.fields.has("governanceRevision") ||
      (typeof value.governanceRevision === "number" &&
        Number.isSafeInteger(value.governanceRevision) &&
        typeof value.previousGovernanceRevision === "number" &&
        value.governanceRevision > value.previousGovernanceRevision)) &&
    (!expectation.fields.has("participation") ||
      (typeof value.participation === "string" &&
        agentParticipations.has(value.participation as AgentParticipation))) &&
    (!expectation.fields.has("toolPermissions") ||
      (isNonEmptyStringArray(value.toolPermissions) &&
        hasUniqueStrings(value.toolPermissions)))
  );
}

export function isRoomLifecycleState(value: unknown): value is RoomLifecycleState {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, STATE_FIELDS) ||
    value.version !== 1 ||
    !Array.isArray(value.actors) ||
    !value.actors.every(isStrictActor) ||
    !Array.isArray(value.rooms) ||
    !value.rooms.every(isManagedRoomShape) ||
    !Array.isArray(value.invitations) ||
    !value.invitations.every(isInvitationShape) ||
    !Array.isArray(value.audit) ||
    !value.audit.every(isRoomAuditRecord)
  ) {
    return false;
  }

  const actorsById = new Map<string, Actor>();
  for (const actor of value.actors) {
    if (actorsById.has(actor.id)) {
      return false;
    }
    actorsById.set(actor.id, actor);
  }

  const roomsById = new Map<string, ManagedRoom>();
  const entityIds = new Set(actorsById.keys());
  for (const room of value.rooms) {
    if (entityIds.has(room.id)) {
      return false;
    }
    entityIds.add(room.id);
    roomsById.set(room.id, room);

    const memberIds = new Set<string>();
    let ownerCount = 0;
    for (const membership of room.members) {
      const actor = actorsById.get(membership.actorId);
      if (
        memberIds.has(membership.actorId) ||
        actor === undefined ||
        actor.kind !== membership.kind
      ) {
        return false;
      }
      memberIds.add(membership.actorId);

      if (membership.kind === "human") {
        if (membership.role === "owner") {
          ownerCount += 1;
        }
      } else {
        if (
          actor.kind !== "agent" ||
          !membership.toolPermissions.every((permission) =>
            actor.toolPermissions.includes(permission),
          )
        ) {
          return false;
        }
      }
    }
    if (ownerCount !== 1) {
      return false;
    }
  }

  const tokenHashes = new Set<string>();
  const pendingInvitees = new Set<string>();
  const invitationsById = new Map<string, HumanInvitationRecord>();
  for (const invitation of value.invitations) {
    if (
      entityIds.has(invitation.id) ||
      tokenHashes.has(invitation.tokenHash) ||
      !roomsById.has(invitation.roomId)
    ) {
      return false;
    }
    const inviter = actorsById.get(invitation.inviterActorId);
    const invitee = actorsById.get(invitation.inviteeActorId);
    if (
      inviter?.kind !== "human" ||
      invitee?.kind !== "human" ||
      (invitation.status !== "pending" &&
        (invitation.decisionActorId !== invitation.inviteeActorId ||
          invitation.decidedAt === undefined ||
          Date.parse(invitation.decidedAt) < Date.parse(invitation.createdAt)))
    ) {
      return false;
    }
    if (invitation.status === "pending") {
      const pendingKey = `${invitation.roomId}\u0000${invitation.inviteeActorId}`;
      const room = roomsById.get(invitation.roomId);
      if (
        pendingInvitees.has(pendingKey) ||
        room?.members.some(
          (membership) => membership.actorId === invitation.inviteeActorId,
        )
      ) {
        return false;
      }
      pendingInvitees.add(pendingKey);
    }
    entityIds.add(invitation.id);
    tokenHashes.add(invitation.tokenHash);
    invitationsById.set(invitation.id, invitation);
  }

  const issuanceAuditCounts = new Map<string, number>();
  const decisionAuditCounts = new Map<string, number>();
  for (const record of value.audit) {
    if (
      entityIds.has(record.id) ||
      !roomsById.has(record.roomId) ||
      !actorsById.has(record.actorId) ||
      ("targetActorId" in record &&
        !actorsById.has(record.targetActorId)) ||
      ("inviterActorId" in record &&
        actorsById.get(record.inviterActorId)?.kind !== "human") ||
      !isAuditSemanticallyConsistent(record, actorsById)
    ) {
      return false;
    }
    if (record.type === "room.human.invited") {
      const invitation = invitationsById.get(record.invitationId);
      if (
        invitation === undefined ||
        record.roomId !== invitation.roomId ||
        record.actorId !== invitation.inviterActorId ||
        record.targetActorId !== invitation.inviteeActorId ||
        record.timestamp !== invitation.createdAt
      ) {
        return false;
      }
      issuanceAuditCounts.set(
        invitation.id,
        (issuanceAuditCounts.get(invitation.id) ?? 0) + 1,
      );
    } else if (
      record.type === "room.invitation.accepted" ||
      record.type === "room.invitation.rejected"
    ) {
      const invitation = invitationsById.get(record.invitationId);
      const expectedStatus =
        record.type === "room.invitation.accepted" ? "accepted" : "rejected";
      if (
        invitation === undefined ||
        invitation.status !== expectedStatus ||
        record.roomId !== invitation.roomId ||
        record.actorId !== invitation.inviteeActorId ||
        record.targetActorId !== invitation.inviteeActorId ||
        record.inviterActorId !== invitation.inviterActorId ||
        record.timestamp !== invitation.decidedAt
      ) {
        return false;
      }
      decisionAuditCounts.set(
        invitation.id,
        (decisionAuditCounts.get(invitation.id) ?? 0) + 1,
      );
    }
    entityIds.add(record.id);
  }

  for (const invitation of value.invitations) {
    if (
      issuanceAuditCounts.get(invitation.id) !== 1 ||
      (invitation.status === "pending"
        ? (decisionAuditCounts.get(invitation.id) ?? 0) !== 0
        : decisionAuditCounts.get(invitation.id) !== 1)
    ) {
      return false;
    }
  }

  const auditsByRoom = new Map<string, RoomAuditRecord[]>();
  for (const record of value.audit) {
    const roomAudit = auditsByRoom.get(record.roomId) ?? [];
    roomAudit.push(record);
    auditsByRoom.set(record.roomId, roomAudit);
  }
  for (const room of value.rooms) {
    if (
      !isRoomAuthorityReachable(
        room,
        auditsByRoom.get(room.id) ?? [],
        invitationsById,
        actorsById,
      )
    ) {
      return false;
    }
  }

  return true;
}

function isManagerMembership(
  membership: HumanRoomMembership | AgentRoomMembership | undefined,
): boolean {
  return (
    membership?.kind === "human" &&
    (membership.role === "owner" || membership.role === "admin")
  );
}

function isSameMembership(
  actual: HumanRoomMembership | AgentRoomMembership,
  expected: HumanRoomMembership | AgentRoomMembership,
): boolean {
  if (
    actual.kind !== expected.kind ||
    actual.actorId !== expected.actorId
  ) {
    return false;
  }
  if (actual.kind === "human" && expected.kind === "human") {
    return actual.role === expected.role && actual.joinedAt === expected.joinedAt;
  }
  if (actual.kind === "agent" && expected.kind === "agent") {
    return (
      actual.participation === expected.participation &&
      actual.configuredAt === expected.configuredAt &&
      actual.toolPermissions.length === expected.toolPermissions.length &&
      actual.toolPermissions.every(
        (permission, index) => permission === expected.toolPermissions[index],
      )
    );
  }
  return false;
}

function isRoomAuthorityReachable(
  room: ManagedRoom,
  audit: readonly RoomAuditRecord[],
  invitationsById: ReadonlyMap<string, HumanInvitationRecord>,
  actorsById: ReadonlyMap<string, Actor>,
): boolean {
  const owner = room.members.find(
    (membership): membership is HumanRoomMembership =>
      membership.kind === "human" && membership.role === "owner",
  );
  const creationRecords = audit.filter(
    (record) => record.type === "room.created",
  );
  const creation = creationRecords[0];
  if (
    owner === undefined ||
    creationRecords.length !== 1 ||
    creation === undefined ||
    audit[0] !== creation ||
    creation.actorId !== owner.actorId ||
    creation.timestamp !== room.createdAt ||
    owner.joinedAt !== room.createdAt
  ) {
    return false;
  }

  const memberships = new Map<
    string,
    HumanRoomMembership | AgentRoomMembership
  >([[owner.actorId, { ...owner }]]);
  const pendingInvitations = new Set<string>();
  const pendingInvitees = new Set<string>();
  let isActive = true;
  let previousTimestamp = room.createdAt;

  for (let index = 0; index < audit.length; index += 1) {
    const record = audit[index];
    if (record === undefined) {
      return false;
    }
    if (
      Date.parse(record.timestamp) < Date.parse(previousTimestamp) ||
      Date.parse(record.timestamp) < Date.parse(room.createdAt)
    ) {
      return false;
    }
    previousTimestamp = record.timestamp;

    switch (record.type) {
      case "room.created":
        if (index !== 0 || record !== creation) {
          return false;
        }
        break;
      case "room.renamed":
        if (!isActive || !isManagerMembership(memberships.get(record.actorId))) {
          return false;
        }
        break;
      case "room.archived":
        if (!isActive || !isManagerMembership(memberships.get(record.actorId))) {
          return false;
        }
        isActive = false;
        break;
      case "room.reopened":
        if (isActive || !isManagerMembership(memberships.get(record.actorId))) {
          return false;
        }
        isActive = true;
        break;
      case "room.human.invited": {
        const invitation = invitationsById.get(record.invitationId);
        const pendingKey = `${record.roomId}\u0000${record.targetActorId}`;
        if (
          !isActive ||
          !isManagerMembership(memberships.get(record.actorId)) ||
          invitation === undefined ||
          memberships.has(record.targetActorId) ||
          pendingInvitations.has(record.invitationId) ||
          pendingInvitees.has(pendingKey)
        ) {
          return false;
        }
        pendingInvitations.add(record.invitationId);
        pendingInvitees.add(pendingKey);
        break;
      }
      case "room.invitation.accepted":
      case "room.invitation.rejected": {
        const invitation = invitationsById.get(record.invitationId);
        const pendingKey = `${record.roomId}\u0000${record.targetActorId}`;
        if (
          invitation === undefined ||
          !pendingInvitations.has(record.invitationId) ||
          !pendingInvitees.has(pendingKey) ||
          (record.type === "room.invitation.accepted" &&
            (!isActive || memberships.has(record.targetActorId)))
        ) {
          return false;
        }
        pendingInvitations.delete(record.invitationId);
        pendingInvitees.delete(pendingKey);
        if (record.type === "room.invitation.accepted") {
          memberships.set(record.targetActorId, {
            kind: "human",
            actorId: record.targetActorId,
            role: "member",
            joinedAt: record.timestamp,
          });
        }
        break;
      }
      case "room.agent.configured":
        if (
          !isActive ||
          !isManagerMembership(memberships.get(record.actorId)) ||
          actorsById.get(record.targetActorId)?.kind !== "agent"
        ) {
          return false;
        }
        memberships.set(record.targetActorId, {
          kind: "agent",
          actorId: record.targetActorId,
          participation: record.participation,
          toolPermissions: [...record.toolPermissions],
          configuredAt: record.timestamp,
        });
        break;
      case "room.member.left":
      case "room.member.removed": {
        const target = memberships.get(record.targetActorId);
        if (
          (record.type === "room.member.left"
            ? record.actorId !== record.targetActorId
            : !isManagerMembership(memberships.get(record.actorId))) ||
          target === undefined ||
          (target.kind === "human" && target.role === "owner")
        ) {
          return false;
        }
        memberships.delete(record.targetActorId);
        break;
      }
      case "room.ownership.transferred": {
        const previousOwner = memberships.get(record.previousOwnerActorId);
        const target = memberships.get(record.targetActorId);
        if (record.actorId !== record.previousOwnerActorId ||
          previousOwner?.kind !== "human" || previousOwner.role !== "owner" ||
          target?.kind !== "human" || target.role === "owner") {
          return false;
        }
        memberships.set(record.previousOwnerActorId, { ...previousOwner, role: "member" });
        memberships.set(record.targetActorId, { ...target, role: "owner" });
        break;
      }
      case "room.member.role.changed": {
        const manager = memberships.get(record.actorId);
        const target = memberships.get(record.targetActorId);
        if (
          !isActive ||
          manager?.kind !== "human" ||
          manager.role !== "owner" ||
          target?.kind !== "human" ||
          target.role === "owner" ||
          target.role === record.role
        ) {
          return false;
        }
        memberships.set(record.targetActorId, { ...target, role: record.role });
        break;
      }
    }
  }

  const pendingInvitationIds = new Set(
    [...invitationsById.values()]
      .filter(
        (invitation) =>
          invitation.roomId === room.id && invitation.status === "pending",
      )
      .map((invitation) => invitation.id),
  );
  if (
    isActive !== (room.status === "active") ||
    pendingInvitationIds.size !== pendingInvitations.size ||
    [...pendingInvitationIds].some((id) => !pendingInvitations.has(id)) ||
    memberships.size !== room.members.length
  ) {
    return false;
  }

  return room.members.every((membership) => {
    const replayed = memberships.get(membership.actorId);
    return replayed !== undefined && isSameMembership(membership, replayed);
  });
}

function isAuditSemanticallyConsistent(
  record: RoomAuditRecord,
  actorsById: ReadonlyMap<string, Actor>,
): boolean {
  const actor = actorsById.get(record.actorId);

  switch (record.type) {
    case "room.created":
    case "room.renamed":
    case "room.archived":
    case "room.reopened":
      return actor?.kind === "human";
    case "room.human.invited":
      return (
        actor?.kind === "human" &&
        actorsById.get(record.targetActorId)?.kind === "human"
      );
    case "room.invitation.accepted":
    case "room.invitation.rejected":
      return (
        actor?.kind === "human" &&
        actorsById.get(record.targetActorId)?.kind === "human" &&
        record.actorId === record.targetActorId
      );
    case "room.agent.configured":
      {
        const target = actorsById.get(record.targetActorId);
        return (
          actor?.kind === "human" &&
          target?.kind === "agent" &&
          record.toolPermissions.every((permission) =>
            target.toolPermissions.includes(permission),
          )
        );
      }
    case "room.member.removed":
      return (
        actor?.kind === "human" && actorsById.has(record.targetActorId)
      );
    case "room.member.left":
      return actor?.kind === "human" && record.actorId === record.targetActorId;
    case "room.member.role.changed":
      return (
        actor?.kind === "human" &&
        actorsById.get(record.targetActorId)?.kind === "human"
      );
    case "room.ownership.transferred":
      return actor?.kind === "human" &&
        actorsById.get(record.targetActorId)?.kind === "human" &&
        record.actorId === record.previousOwnerActorId;
  }
}

function cloneActor(actor: Actor): Actor {
  return actor.kind === "human"
    ? { ...actor }
    : { ...actor, toolPermissions: [...actor.toolPermissions] };
}

function cloneMembership(
  membership: HumanRoomMembership | AgentRoomMembership,
): HumanRoomMembership | AgentRoomMembership {
  return membership.kind === "human"
    ? { ...membership }
    : { ...membership, toolPermissions: [...membership.toolPermissions] };
}

function cloneRoom(room: ManagedRoom): ManagedRoom {
  return { ...room, members: room.members.map(cloneMembership) };
}

function cloneInvitation(invitation: HumanInvitationRecord): HumanInvitationRecord {
  return { ...invitation };
}

function cloneAudit(record: RoomAuditRecord): RoomAuditRecord {
  return record.type === "room.agent.configured"
    ? { ...record, toolPermissions: [...record.toolPermissions] }
    : { ...record };
}

function cloneState(value: RoomLifecycleState): RoomLifecycleState {
  return {
    version: 1,
    actors: value.actors.map(cloneActor),
    rooms: value.rooms.map(cloneRoom),
    invitations: value.invitations.map(cloneInvitation),
    audit: value.audit.map(cloneAudit),
  };
}

function isHumanInvitationRequestStrict(
  value: unknown,
): value is HumanInvitationRequest {
  return (
    isRecord(value) &&
    hasOnlyFields(value, HUMAN_INVITATION_REQUEST_FIELDS) &&
    value.kind === "human-invitation" &&
    isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.inviteeActorId)
  );
}

function isAgentConfigurationRequestStrict(
  value: unknown,
): value is AgentConfigurationRequest {
  return (
    isRecord(value) &&
    hasOnlyFields(value, AGENT_CONFIGURATION_REQUEST_FIELDS) &&
    value.kind === "agent-configuration" &&
    isNonEmptyString(value.roomId) &&
    isNonEmptyString(value.agentId) &&
    typeof value.participation === "string" &&
    agentParticipations.has(value.participation as AgentParticipation) &&
    isStringArray(value.toolPermissions)
  );
}

function routedRoomId(value: unknown): string | undefined {
  return isRecord(value) && isNonEmptyString(value.roomId)
    ? value.roomId
    : undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function normalizedName(name: unknown): string {
  if (typeof name !== "string") {
    throw new RoomLifecycleError(400, "room_name_invalid");
  }
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new RoomLifecycleError(400, "room_name_invalid");
  }
  return normalized;
}

function authoritativeSession(
  context: AuthenticatedCommandContext,
): AuthenticatedSessionContext {
  return {
    sessionId: context.sessionId,
    sessionFamilyId: context.sessionFamilyId,
    principal: context.principal,
  };
}

function acknowledgementRecord(
  acknowledgement: CommandAcknowledgement,
  key: "room" | "invitation",
): unknown {
  return isRecord(acknowledgement.result)
    ? acknowledgement.result[key]
    : undefined;
}

function authoritativeRoom(acknowledgement: CommandAcknowledgement): ManagedRoom {
  const room = acknowledgementRecord(acknowledgement, "room");
  if (!isManagedRoomShape(room)) {
    throw new TypeError("Authoritative room acknowledgement is invalid");
  }
  return cloneRoom(room);
}

function authoritativeIssuedInvitation(
  acknowledgement: CommandAcknowledgement,
): IssuedHumanInvitation {
  const invitation = acknowledgementRecord(acknowledgement, "invitation");
  if (
    !isRecord(invitation) ||
    !hasOnlyFields(
      invitation,
      new Set([
        "invitationId",
        "roomId",
        "inviterActorId",
        "inviteeActorId",
        "token",
        "createdAt",
      ]),
    ) ||
    !isNonEmptyString(invitation.invitationId) ||
    !isNonEmptyString(invitation.roomId) ||
    !isNonEmptyString(invitation.inviterActorId) ||
    !isNonEmptyString(invitation.inviteeActorId) ||
    !isNonEmptyString(invitation.token) ||
    !isIsoTimestamp(invitation.createdAt)
  ) {
    throw new TypeError("Authoritative invitation acknowledgement is invalid");
  }
  return {
    invitationId: invitation.invitationId,
    roomId: invitation.roomId,
    inviterActorId: invitation.inviterActorId,
    inviteeActorId: invitation.inviteeActorId,
    token: invitation.token,
    createdAt: invitation.createdAt,
  };
}

function authoritativeInvitationDecision(
  acknowledgement: CommandAcknowledgement,
  token: string,
): HumanInvitationRecord {
  const invitation = acknowledgementRecord(acknowledgement, "invitation");
  if (
    !isRecord(invitation) ||
    !hasOnlyFields(
      invitation,
      new Set([
        "id",
        "roomId",
        "inviterActorId",
        "inviteeActorId",
        "status",
        "createdAt",
        "decisionActorId",
        "decidedAt",
      ]),
    ) ||
    !isNonEmptyString(invitation.id) ||
    !isNonEmptyString(invitation.roomId) ||
    !isNonEmptyString(invitation.inviterActorId) ||
    !isNonEmptyString(invitation.inviteeActorId) ||
    (invitation.status !== "accepted" && invitation.status !== "rejected") ||
    !isIsoTimestamp(invitation.createdAt) ||
    !isNonEmptyString(invitation.decisionActorId) ||
    !isIsoTimestamp(invitation.decidedAt)
  ) {
    throw new TypeError("Authoritative invitation decision is invalid");
  }
  return {
    id: invitation.id,
    roomId: invitation.roomId,
    inviterActorId: invitation.inviterActorId,
    inviteeActorId: invitation.inviteeActorId,
    tokenHash: hashToken(token),
    status: invitation.status,
    createdAt: invitation.createdAt,
    decisionActorId: invitation.decisionActorId,
    decidedAt: invitation.decidedAt,
  };
}

export function createAuthoritativeRoomLifecycleService(
  options: AuthoritativeRoomLifecycleServiceOptions,
): AuthoritativeRoomLifecycleService {
  return {
    async createRoom(context, input) {
      return authoritativeRoom(await options.commandStore.executeHuman(context, {
        type: "room.create",
        payload: { name: normalizedName(isRecord(input) ? input.name : undefined) },
      }));
    },

    async renameRoom(context, roomId, name) {
      return authoritativeRoom(await options.commandStore.executeHuman(context, {
        type: "room.rename",
        roomId,
        payload: { name: normalizedName(name) },
      }));
    },

    async archiveRoom(context, roomId) {
      const governance = await options.queryStore.readRoomGovernance(context, roomId);
      await options.commandStore.executeHuman(context, {
        type: "room.archive",
        roomId,
        payload: { expectedGovernanceRevision: governance.governanceRevision },
      });
      const room = await options.queryStore.readRoom(roomId);
      if (room === undefined || !isManagedRoomShape(room) || room.status !== "archived") {
        throw new TypeError("Authoritative archive acknowledgement is invalid");
      }
      return room;
    },

    async inviteHuman(context, request) {
      if (!isHumanInvitationRequestStrict(request)) {
        throw new RoomLifecycleError(400, "human_invitation_invalid");
      }
      return authoritativeIssuedInvitation(await options.commandStore.executeHuman(context, {
        type: "human.invitation.issue",
        roomId: request.roomId,
        payload: { inviteeActorId: request.inviteeActorId },
      }));
    },

    async respondToHumanInvitation(context, token, decision) {
      if (!isNonEmptyString(token) || (decision !== "accept" && decision !== "reject")) {
        throw new RoomLifecycleError(400, "invitation_decision_invalid");
      }
      const acknowledgement = await options.commandStore.executeHuman(context, {
        type: "human.invitation.decide",
        payload: { token, decision },
      });
      return authoritativeInvitationDecision(acknowledgement, token);
    },

    async configureAgent(context, request) {
      if (!isAgentConfigurationRequestStrict(request)) {
        throw new RoomLifecycleError(400, "agent_configuration_invalid");
      }
      return authoritativeRoom(await options.commandStore.executeHuman(context, {
        type: "agent.configure",
        roomId: request.roomId,
        payload: {
          agentId: request.agentId,
          participation: request.participation,
          toolPermissions: request.toolPermissions,
        },
      }));
    },

    async setHumanRole(context, roomId, targetActorId, role) {
      if (!isNonEmptyString(targetActorId) || (role !== "admin" && role !== "member")) {
        throw new RoomLifecycleError(400, "human_role_invalid");
      }
      return authoritativeRoom(await options.commandStore.executeHuman(context, {
        type: "human.role.change",
        roomId,
        payload: { targetActorId, role },
      }));
    },

    async removeMember(context, roomId, targetActorId) {
      if (!isNonEmptyString(targetActorId)) {
        throw new RoomLifecycleError(400, "room_member_not_found");
      }
      return authoritativeRoom(await options.commandStore.executeHuman(context, {
        type: "member.remove",
        roomId,
        payload: { targetActorId },
      }));
    },

    getActor(actorId) {
      return options.queryStore.readActor(actorId);
    },

    getRoom(roomId) {
      return options.queryStore.readRoom(roomId);
    },

    canAccess(context, roomId) {
      return options.queryStore.canAccessRoom(authoritativeSession(context), roomId);
    },

    audit(context, roomId) {
      return options.queryStore.readRoomAudit(authoritativeSession(context), roomId);
    },
  };
}

/** Creates the isolated T-0039 JSON compatibility adapter. */
export async function createRoomLifecycleService(
  options: RoomLifecycleServiceOptions,
): Promise<RoomLifecycleService> {
  const seedActors = options.actors.map(cloneActor);
  const emptyState: RoomLifecycleState = {
    version: 1,
    actors: seedActors,
    rooms: [],
    invitations: [],
    audit: [],
  };
  if (!isRoomLifecycleState(emptyState)) {
    throw new TypeError("actors must be unique, closed, valid authority records");
  }

  const clock = options.clock ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const tokenFactory =
    options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));

  let loadedState: RoomLifecycleState | undefined;
  let initializationFailure: { readonly error: unknown } | undefined;
  await options.state.load().then(
    (loaded) => {
      if (loaded !== undefined && !isRoomLifecycleState(loaded)) {
        initializationFailure = {
          error: new TypeError("room lifecycle store returned invalid state"),
        };
        return;
      }
      loadedState = loaded;
    },
    (error: unknown) => {
      initializationFailure = { error };
    },
  );
  if (initializationFailure !== undefined) {
    throw initializationFailure.error;
  }
  let state = cloneState(loadedState ?? emptyState);
  let operationQueue = Promise.resolve();

  function runExclusive<Result>(
    operation: (current: RoomLifecycleState) => Promise<Result> | Result,
  ): Promise<Result> {
    const result = operationQueue.then(async () => {
      return operation(state);
    });
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function persist(nextState: RoomLifecycleState): Promise<void> {
    if (!isRoomLifecycleState(nextState)) {
      throw new TypeError("room lifecycle mutation produced invalid state");
    }
    await options.state.save(cloneState(nextState));
    state = cloneState(nextState);
  }

  function timestamp(): string {
    const value = clock();
    if (!Number.isFinite(value)) {
      throw new RangeError("clock must return a finite timestamp");
    }
    return new Date(value).toISOString();
  }

  function roomNow(current: RoomLifecycleState, roomId: string): string {
    const wallClock = timestamp();
    const room = current.rooms.find((candidate) => candidate.id === roomId);
    const authorityTimestamps = [
      wallClock,
      ...(room === undefined
        ? []
        : [
            room.createdAt,
            ...room.members.map((membership) =>
              membership.kind === "human"
                ? membership.joinedAt
                : membership.configuredAt,
            ),
          ]),
      ...current.invitations
        .filter((invitation) => invitation.roomId === roomId)
        .flatMap((invitation) =>
          invitation.decidedAt === undefined
            ? [invitation.createdAt]
            : [invitation.createdAt, invitation.decidedAt],
        ),
      ...current.audit
        .filter((record) => record.roomId === roomId)
        .map((record) => record.timestamp),
    ];
    return new Date(
      Math.max(...authorityTimestamps.map((value) => Date.parse(value))),
    ).toISOString();
  }

  function requireActor(current: RoomLifecycleState, actorId: string): Actor {
    if (!isNonEmptyString(actorId)) {
      throw new RoomLifecycleError(401, "unauthenticated");
    }
    const actor = current.actors.find((candidate) => candidate.id === actorId);
    if (actor === undefined) {
      throw new RoomLifecycleError(404, "actor_not_found");
    }
    return actor;
  }

  function requireAuthenticatedActor(
    current: RoomLifecycleState,
    actorId: string,
  ): Actor {
    if (!isNonEmptyString(actorId)) {
      throw new RoomLifecycleError(401, "unauthenticated");
    }
    const actor = current.actors.find((candidate) => candidate.id === actorId);
    if (actor === undefined) {
      throw new RoomLifecycleError(401, "unauthenticated");
    }
    return actor;
  }

  function requireRoom(current: RoomLifecycleState, roomId: string): ManagedRoom {
    const room = current.rooms.find((candidate) => candidate.id === roomId);
    if (room === undefined) {
      throw new RoomLifecycleError(404, "room_not_found");
    }
    return room;
  }

  function requireManager(
    current: RoomLifecycleState,
    actorId: string,
    roomId: string,
  ): ManagedRoom {
    const actor = requireAuthenticatedActor(current, actorId);
    const room = requireRoom(current, roomId);
    const membership = room.members.find(
      (candidate) => candidate.actorId === actor.id,
    );
    if (
      actor.kind !== "human" ||
      membership?.kind !== "human" ||
      (membership.role !== "owner" && membership.role !== "admin")
    ) {
      throw new RoomLifecycleError(403, "room_forbidden");
    }
    return room;
  }

  function requireActive(room: ManagedRoom): void {
    if (room.status === "archived") {
      throw new RoomLifecycleError(409, "room_archived");
    }
  }

  function usedEntityIds(current: RoomLifecycleState): Set<string> {
    return new Set([
      ...current.actors.map((actor) => actor.id),
      ...current.rooms.map((room) => room.id),
      ...current.invitations.map((invitation) => invitation.id),
      ...current.audit.map((record) => record.id),
    ]);
  }

  function nextEntityId(usedIds: Set<string>): string {
    const id = idFactory();
    if (!isNonEmptyString(id) || usedIds.has(id)) {
      throw new RoomLifecycleError(409, "lifecycle_id_conflict");
    }
    usedIds.add(id);
    return id;
  }

  function auditRecord(
    usedIds: Set<string>,
    input: RoomAuditInput,
  ): RoomAuditRecord {
    return { id: nextEntityId(usedIds), ...input } as RoomAuditRecord;
  }

  return {
    createRoom(actorId, input): Promise<ManagedRoom> {
      return runExclusive(async (current) => {
        const actor = requireAuthenticatedActor(current, actorId);
        if (actor.kind !== "human") {
          throw new RoomLifecycleError(400, "human_required");
        }
        const name = normalizedName(isRecord(input) ? input.name : undefined);
        const now = timestamp();
        const usedIds = usedEntityIds(current);
        const room: ManagedRoom = {
          id: nextEntityId(usedIds),
          name,
          status: "active",
          members: [
            {
              kind: "human",
              actorId: actor.id,
              role: "owner",
              joinedAt: now,
            },
          ],
          createdAt: now,
        };
        const audit = auditRecord(usedIds, {
          type: "room.created",
          roomId: room.id,
          actorId: actor.id,
          result: "created",
          timestamp: now,
        });
        await persist({
          ...current,
          rooms: [...current.rooms, room],
          audit: [...current.audit, audit],
        });
        return cloneRoom(room);
      });
    },

    renameRoom(actorId, roomId, requestedName): Promise<ManagedRoom> {
      return runExclusive(async (current) => {
        const room = requireManager(current, actorId, roomId);
        requireActive(room);
        const name = normalizedName(requestedName);
        const now = roomNow(current, roomId);
        const usedIds = usedEntityIds(current);
        const renamed = { ...room, name };
        const audit = auditRecord(usedIds, {
          type: "room.renamed",
          roomId,
          actorId,
          result: "renamed",
          timestamp: now,
        });
        await persist({
          ...current,
          rooms: current.rooms.map((candidate) =>
            candidate.id === roomId ? renamed : candidate,
          ),
          audit: [...current.audit, audit],
        });
        return cloneRoom(renamed);
      });
    },

    archiveRoom(actorId, roomId): Promise<ManagedRoom> {
      return runExclusive(async (current) => {
        const room = requireManager(current, actorId, roomId);
        if (room.status === "archived") {
          return cloneRoom(room);
        }
        const now = roomNow(current, room.id);
        const usedIds = usedEntityIds(current);
        const archived: ManagedRoom = { ...room, status: "archived" };
        const audit = auditRecord(usedIds, {
          type: "room.archived",
          roomId,
          actorId,
          result: "archived",
          timestamp: now,
        });
        await persist({
          ...current,
          rooms: current.rooms.map((candidate) =>
            candidate.id === roomId ? archived : candidate,
          ),
          audit: [...current.audit, audit],
        });
        return cloneRoom(archived);
      });
    },

    inviteHuman(actorId, request): Promise<IssuedHumanInvitation> {
      return runExclusive(async (current) => {
        requireAuthenticatedActor(current, actorId);
        const roomId = routedRoomId(request);
        if (roomId === undefined) {
          throw new RoomLifecycleError(400, "human_invitation_invalid");
        }
        const room = requireManager(current, actorId, roomId);
        if (!isHumanInvitationRequestStrict(request)) {
          throw new RoomLifecycleError(400, "human_invitation_invalid");
        }
        requireActive(room);
        const invitee = requireActor(current, request.inviteeActorId);
        if (invitee.kind !== "human") {
          throw new RoomLifecycleError(400, "invitee_required");
        }
        if (
          room.members.some(
            (membership) => membership.actorId === request.inviteeActorId,
          )
        ) {
          throw new RoomLifecycleError(409, "room_member_exists");
        }
        if (
          current.invitations.some(
            (invitation) =>
              invitation.roomId === room.id &&
              invitation.inviteeActorId === invitee.id &&
              invitation.status === "pending",
          )
        ) {
          throw new RoomLifecycleError(409, "invitation_pending");
        }

        const token = tokenFactory();
        if (!isNonEmptyString(token)) {
          throw new RoomLifecycleError(409, "invitation_token_conflict");
        }
        const tokenHash = hashToken(token);
        if (
          current.invitations.some(
            (invitation) => invitation.tokenHash === tokenHash,
          )
        ) {
          throw new RoomLifecycleError(409, "invitation_token_conflict");
        }

        const now = roomNow(current, room.id);
        const usedIds = usedEntityIds(current);
        const invitation: HumanInvitationRecord = {
          id: nextEntityId(usedIds),
          roomId: room.id,
          inviterActorId: actorId,
          inviteeActorId: invitee.id,
          tokenHash,
          status: "pending",
          createdAt: now,
        };
        const audit = auditRecord(usedIds, {
          type: "room.human.invited",
          roomId: room.id,
          actorId,
          targetActorId: invitee.id,
          invitationId: invitation.id,
          result: "pending",
          timestamp: now,
        });
        await persist({
          ...current,
          invitations: [...current.invitations, invitation],
          audit: [...current.audit, audit],
        });
        return {
          invitationId: invitation.id,
          roomId: invitation.roomId,
          inviterActorId: invitation.inviterActorId,
          inviteeActorId: invitation.inviteeActorId,
          token,
          createdAt: invitation.createdAt,
        };
      });
    },

    respondToHumanInvitation(actorId, token, decision): Promise<HumanInvitationRecord> {
      return runExclusive(async (current) => {
        requireAuthenticatedActor(current, actorId);
        if (!isNonEmptyString(token)) {
          throw new RoomLifecycleError(404, "invitation_not_found");
        }
        const tokenHash = hashToken(token);
        const invitation = current.invitations.find(
          (candidate) => candidate.tokenHash === tokenHash,
        );
        if (invitation === undefined) {
          throw new RoomLifecycleError(404, "invitation_not_found");
        }
        if (invitation.inviteeActorId !== actorId) {
          throw new RoomLifecycleError(403, "invitation_forbidden");
        }
        if (decision !== "accept" && decision !== "reject") {
          throw new RoomLifecycleError(400, "invitation_decision_invalid");
        }
        if (invitation.status !== "pending") {
          throw new RoomLifecycleError(409, "invitation_consumed");
        }
        const room = requireRoom(current, invitation.roomId);
        if (decision === "accept") {
          requireActive(room);
        }
        if (
          decision === "accept" &&
          room.members.some((membership) => membership.actorId === actorId)
        ) {
          throw new RoomLifecycleError(409, "room_member_exists");
        }

        const now = roomNow(current, room.id);
        const terminal: HumanInvitationRecord = {
          ...invitation,
          status: decision === "accept" ? "accepted" : "rejected",
          decisionActorId: actorId,
          decidedAt: now,
        };
        const updatedRoom: ManagedRoom =
          decision === "accept"
            ? {
                ...room,
                members: [
                  ...room.members,
                  {
                    kind: "human",
                    actorId,
                    role: "member",
                    joinedAt: now,
                  },
                ],
              }
            : room;
        const usedIds = usedEntityIds(current);
        const audit =
          decision === "accept"
            ? auditRecord(usedIds, {
                type: "room.invitation.accepted",
                roomId: room.id,
                actorId,
                targetActorId: actorId,
                inviterActorId: invitation.inviterActorId,
                invitationId: invitation.id,
                result: "accepted",
                timestamp: now,
              })
            : auditRecord(usedIds, {
                type: "room.invitation.rejected",
                roomId: room.id,
                actorId,
                targetActorId: actorId,
                inviterActorId: invitation.inviterActorId,
                invitationId: invitation.id,
                result: "rejected",
                timestamp: now,
              });
        await persist({
          ...current,
          rooms:
            decision === "accept"
              ? current.rooms.map((candidate) =>
                  candidate.id === room.id ? updatedRoom : candidate,
                )
              : current.rooms,
          invitations: current.invitations.map((candidate) =>
            candidate.id === invitation.id ? terminal : candidate,
          ),
          audit: [...current.audit, audit],
        });
        return cloneInvitation(terminal);
      });
    },

    configureAgent(actorId, request): Promise<ManagedRoom> {
      return runExclusive(async (current) => {
        requireAuthenticatedActor(current, actorId);
        const roomId = routedRoomId(request);
        if (roomId === undefined) {
          throw new RoomLifecycleError(400, "agent_configuration_invalid");
        }
        const room = requireManager(current, actorId, roomId);
        if (!isAgentConfigurationRequestStrict(request)) {
          throw new RoomLifecycleError(400, "agent_configuration_invalid");
        }
        requireActive(room);
        const agent = requireActor(current, request.agentId);
        if (agent.kind !== "agent") {
          throw new RoomLifecycleError(400, "agent_required");
        }
        if (
          request.toolPermissions.length === 0 ||
          !hasUniqueStrings(request.toolPermissions) ||
          !request.toolPermissions.every((permission) =>
            agent.toolPermissions.includes(permission),
          )
        ) {
          throw new RoomLifecycleError(400, "agent_permissions_invalid");
        }

        const now = roomNow(current, roomId);
        const membership: AgentRoomMembership = {
          kind: "agent",
          actorId: agent.id,
          participation: request.participation,
          toolPermissions: [...request.toolPermissions],
          configuredAt: now,
        };
        const memberIndex = room.members.findIndex(
          (candidate) => candidate.actorId === agent.id,
        );
        const members = [...room.members];
        if (memberIndex === -1) {
          members.push(membership);
        } else {
          members[memberIndex] = membership;
        }
        const configured: ManagedRoom = { ...room, members };
        const usedIds = usedEntityIds(current);
        const audit = auditRecord(usedIds, {
          type: "room.agent.configured",
          roomId: room.id,
          actorId,
          targetActorId: agent.id,
          participation: request.participation,
          toolPermissions: [...request.toolPermissions],
          result: "configured",
          timestamp: now,
        });
        await persist({
          ...current,
          rooms: current.rooms.map((candidate) =>
            candidate.id === room.id ? configured : candidate,
          ),
          audit: [...current.audit, audit],
        });
        return cloneRoom(configured);
      });
    },

    setHumanRole(actorId, roomId, targetActorId, role): Promise<ManagedRoom> {
      return runExclusive(async (current) => {
        const room = requireManager(current, actorId, roomId);
        const actorMembership = room.members.find(
          (membership) => membership.actorId === actorId,
        );
        if (
          actorMembership?.kind !== "human" ||
          actorMembership.role !== "owner"
        ) {
          throw new RoomLifecycleError(403, "room_forbidden");
        }
        requireActive(room);
        if (role !== "admin" && role !== "member") {
          throw new RoomLifecycleError(400, "human_role_invalid");
        }
        const target = room.members.find(
          (membership) => membership.actorId === targetActorId,
        );
        if (target === undefined) {
          throw new RoomLifecycleError(404, "room_member_not_found");
        }
        if (target.kind !== "human") {
          throw new RoomLifecycleError(400, "human_member_required");
        }
        if (target.role === "owner") {
          throw new RoomLifecycleError(409, "room_owner_required");
        }
        if (target.role === role) {
          return cloneRoom(room);
        }

        const updated: ManagedRoom = {
          ...room,
          members: room.members.map((membership) =>
            membership.actorId === targetActorId
              ? { ...target, role }
              : membership,
          ),
        };
        const now = roomNow(current, roomId);
        const usedIds = usedEntityIds(current);
        const audit = auditRecord(usedIds, {
          type: "room.member.role.changed",
          roomId,
          actorId,
          targetActorId,
          role,
          result: "role-changed",
          timestamp: now,
        });
        await persist({
          ...current,
          rooms: current.rooms.map((candidate) =>
            candidate.id === roomId ? updated : candidate,
          ),
          audit: [...current.audit, audit],
        });
        return cloneRoom(updated);
      });
    },

    removeMember(actorId, roomId, targetActorId): Promise<ManagedRoom> {
      return runExclusive(async (current) => {
        const room = requireManager(current, actorId, roomId);
        requireActive(room);
        const target = room.members.find(
          (membership) => membership.actorId === targetActorId,
        );
        if (target === undefined) {
          throw new RoomLifecycleError(404, "room_member_not_found");
        }
        if (
          target.kind === "human" &&
          target.role === "owner" &&
          room.members.filter(
            (membership) =>
              membership.kind === "human" && membership.role === "owner",
          ).length === 1
        ) {
          throw new RoomLifecycleError(409, "room_owner_required");
        }

        const removed: ManagedRoom = {
          ...room,
          members: room.members.filter(
            (membership) => membership.actorId !== targetActorId,
          ),
        };
        const now = roomNow(current, roomId);
        const usedIds = usedEntityIds(current);
        const audit = auditRecord(usedIds, {
          type: "room.member.removed",
          roomId,
          actorId,
          targetActorId,
          result: "removed",
          timestamp: now,
        });
        await persist({
          ...current,
          rooms: current.rooms.map((candidate) =>
            candidate.id === roomId ? removed : candidate,
          ),
          audit: [...current.audit, audit],
        });
        return cloneRoom(removed);
      });
    },

    canAccess(actorId, roomId): boolean {
      const room = state.rooms.find((candidate) => candidate.id === roomId);
      return (
        state.actors.some((actor) => actor.id === actorId) &&
        room?.status === "active" &&
        room.members.some((membership) => membership.actorId === actorId)
      );
    },

    getActor(actorId): Actor | undefined {
      const actor = state.actors.find((candidate) => candidate.id === actorId);
      return actor === undefined ? undefined : cloneActor(actor);
    },

    getRoom(roomId): ManagedRoom | undefined {
      const room = state.rooms.find((candidate) => candidate.id === roomId);
      return room === undefined ? undefined : cloneRoom(room);
    },

    messageRoom(roomId): Room | undefined {
      const room = state.rooms.find((candidate) => candidate.id === roomId);
      if (room === undefined || room.status === "archived") {
        return undefined;
      }
      return {
        id: room.id,
        name: room.name,
        memberIds: room.members.map((membership) => membership.actorId),
        createdAt: room.createdAt,
      };
    },

    audit(roomId): readonly RoomAuditRecord[] {
      return state.audit
        .filter((record) => record.roomId === roomId)
        .map(cloneAudit);
    },
  };
}
