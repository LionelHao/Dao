import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import {
  isAssignmentMutationRequest,
  type AssignmentMutationRequest,
} from "./assignment-policy.js";
import type { RoomAssignmentCommandResult } from "./assignment-service.js";
import type { SqliteAssignmentRecord } from "./sqlite-assignment-repository.js";

export const ROOM_ASSIGNMENT_OPERATION_VERSION = 1 as const;

export type RoomAssignmentOperation =
  | {
      readonly version: 1;
      readonly type: "room-assignment.mutate";
      readonly context: AuthenticatedSessionContext;
      readonly request: AssignmentMutationRequest;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "room-assignment.list";
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly now: number;
    }
  | {
      readonly version: 1;
      readonly type: "room-assignment.get";
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly assignmentId: string;
      readonly now: number;
    };

export type RoomAssignmentResult =
  | { readonly kind: "room-assignment-command"; readonly acknowledgement: RoomAssignmentCommandResult }
  | { readonly kind: "room-assignment"; readonly assignment: SqliteAssignmentRecord }
  | { readonly kind: "room-assignments"; readonly assignments: readonly SqliteAssignmentRecord[] };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 4_096;
}

function revision(value: unknown, allowZero = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    (allowZero ? value >= 0 : value > 0);
}

function context(value: unknown): value is AuthenticatedSessionContext {
  return record(value) && exact(value, ["sessionId", "sessionFamilyId", "principal",
    ...(Object.hasOwn(value, "deviceId") ? ["deviceId"] : [])]) &&
    text(value.sessionId) && text(value.sessionFamilyId) && record(value.principal) &&
    (!Object.hasOwn(value, "deviceId") || text(value.deviceId)) &&
    exact(value.principal, ["accountId", "actorId"]) && text(value.principal.accountId) &&
    text(value.principal.actorId);
}

function canonicalSet(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry, index) =>
    text(entry) && (index === 0 || (value[index - 1] as string).localeCompare(entry) < 0));
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assignment(value: unknown): value is SqliteAssignmentRecord {
  if (!record(value)) return false;
  const removed = value.status === "removed";
  return exact(value, [
    "assignmentId", "roomId", "profileId", "actorId", "revision", "status",
    "participation", "paused", "roomResponsibility", "capabilitySubset", "toolSubset",
    "createdAt", "updatedAt", ...(removed ? ["removedAt"] : []),
  ]) && text(value.assignmentId) && text(value.roomId) && text(value.profileId) &&
    text(value.actorId) && revision(value.revision) &&
    (value.status === "current" || value.status === "removed") &&
    (value.participation === "active" || value.participation === "on-mention") &&
    typeof value.paused === "boolean" && text(value.roomResponsibility) &&
    canonicalSet(value.capabilitySubset) && canonicalSet(value.toolSubset) &&
    timestamp(value.createdAt) && timestamp(value.updatedAt) &&
    (!removed || timestamp(value.removedAt));
}

function acknowledgement(value: unknown): value is RoomAssignmentCommandResult {
  return record(value) && exact(value, [
    "requestId", "changed", "assignmentId", "acceptedRevision", "roomRevision", "eventIds",
  ]) && text(value.requestId) && typeof value.changed === "boolean" &&
    text(value.assignmentId) && revision(value.acceptedRevision) &&
    revision(value.roomRevision, true) && Array.isArray(value.eventIds) &&
    value.eventIds.length === 1 && text(value.eventIds[0]);
}

export function isRoomAssignmentOperation(value: unknown): value is RoomAssignmentOperation {
  if (!record(value) || value.version !== 1 || typeof value.type !== "string" ||
      !context(value.context) || !revision(value.now, true)) return false;
  switch (value.type) {
    case "room-assignment.mutate":
      return exact(value, ["version", "type", "context", "request", "now"]) &&
        isAssignmentMutationRequest(value.request);
    case "room-assignment.list":
      return exact(value, ["version", "type", "context", "roomId", "now"]) && text(value.roomId);
    case "room-assignment.get":
      return exact(value, [
        "version", "type", "context", "roomId", "assignmentId", "now",
      ]) && text(value.roomId) && text(value.assignmentId);
    default:
      return false;
  }
}

export function isRoomAssignmentResult(value: unknown): value is RoomAssignmentResult {
  if (!record(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "room-assignment-command":
      return exact(value, ["kind", "acknowledgement"]) && acknowledgement(value.acknowledgement);
    case "room-assignment":
      return exact(value, ["kind", "assignment"]) && assignment(value.assignment);
    case "room-assignments":
      return exact(value, ["kind", "assignments"]) && Array.isArray(value.assignments) &&
        value.assignments.every(assignment);
    default:
      return false;
  }
}
