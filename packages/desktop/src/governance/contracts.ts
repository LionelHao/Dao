import type {
  DepartureConflictList,
  GovernanceClosedError,
  GovernanceCommand,
  GovernanceConnectionState,
  GovernanceIntent,
  GovernanceOperationState,
  GovernanceProjection,
} from "../renderer/governance/view-model.js";

export const GOVERNANCE_IPC_CHANNELS = Object.freeze({
  getSurface: "governance:get-surface",
  getDepartureConflicts: "governance:get-departure-conflicts",
  submit: "governance:submit",
  stateChanged: "governance:state-changed",
} as const);

export interface GovernanceSurfaceQuery { readonly roomId: string }
export interface GovernanceDepartureQuery {
  readonly roomId: string;
  readonly targetActorId: string;
  readonly expectedGovernanceRevision: number;
}
export interface GovernanceMutationRequest {
  readonly roomId: string;
  readonly intent: GovernanceIntent;
}

type ReadyConnection = Exclude<GovernanceConnectionState, { status: "revoked" | "fatal" }>;
export type GovernanceLockedConnection =
  | Extract<GovernanceConnectionState, { status: "revoked" | "fatal" }>
  | { readonly status: "offline"; readonly asOf: string };

export interface GovernanceReadyState {
  readonly status: "ready";
  readonly projection: GovernanceProjection;
  readonly viewerActorId: string;
  readonly connection: ReadyConnection;
  readonly operation: GovernanceOperationState;
  readonly departureConflicts?: DepartureConflictList;
}
export interface GovernanceLockedState {
  readonly status: "locked";
  readonly roomId: string;
  readonly connection: GovernanceLockedConnection;
}
export type GovernanceRemoteState = GovernanceReadyState | GovernanceLockedState;

export type GovernanceAuthoritySnapshot =
  | {
      readonly status: "ready";
      readonly projection: GovernanceProjection;
      readonly viewerActorId: string;
      readonly connection: ReadyConnection;
      readonly departureConflicts?: DepartureConflictList;
    }
  | GovernanceLockedState;

export interface GovernanceStateEnvelope {
  readonly roomId: string;
  readonly state: GovernanceRemoteState;
}
export interface GovernanceSubmitResult {
  readonly requestId: string;
  readonly state: GovernanceRemoteState;
}

export type GovernanceAckResult = "accepted" | "already_archived" | "already_active";
export interface GovernanceAuthorityAck {
  readonly type: "ack";
  readonly requestId: string;
  readonly command: GovernanceCommand;
  readonly result: GovernanceAckResult;
  readonly eventIds: readonly string[];
  readonly replayed: boolean;
  readonly projection: GovernanceProjection;
}

export interface GovernanceAuthorityCommand extends GovernanceMutationRequest {
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface GovernanceBridge {
  getSurface(query: GovernanceSurfaceQuery): Promise<GovernanceRemoteState>;
  getDepartureConflicts(query: GovernanceDepartureQuery): Promise<DepartureConflictList>;
  submit(request: GovernanceMutationRequest): Promise<GovernanceSubmitResult>;
  onStateChanged(listener: (state: GovernanceStateEnvelope) => void): () => void;
}

type RecordValue = Record<string, unknown>;
const commands = new Set<GovernanceCommand>([
  "room.ownership.transfer", "room.member.leave", "room.member.remove", "room.archive", "room.reopen",
]);
const conflictKinds = new Set([
  "request", "next_action", "blocker_or_open_question", "pending_acceptance",
  "pending_verification", "pending_confirmation",
]);
const resolutions = new Set(["complete", "transfer", "escalate", "reject_or_revoke"]);

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function isMember(value: unknown): boolean {
  if (!record(value) || !text(value.actorId) || !text(value.displayName)) return false;
  return value.kind === "human"
    ? keys(value, ["kind", "actorId", "displayName", "role"]) &&
      (value.role === "admin" || value.role === "member")
    : value.kind === "agent" && keys(value, ["kind", "actorId", "displayName", "ordinary"]) &&
      typeof value.ordinary === "boolean";
}
export function isGovernanceProjection(value: unknown): value is GovernanceProjection {
  if (!record(value) || !keys(value, [
    "roomId", "projectId", "roomName", "lifecycle", "governanceRevision",
    "archiveGeneration", "ownerActorId", "members",
  ], ["archivedAt"]) || !text(value.roomId) || value.projectId !== value.roomId ||
      !text(value.roomName) || !text(value.ownerActorId) || !revision(value.governanceRevision) ||
      !revision(value.archiveGeneration) || !Array.isArray(value.members) || value.members.length > 512 ||
      !value.members.every(isMember)) return false;
  if (value.lifecycle !== "active" && value.lifecycle !== "archived") return false;
  if (value.lifecycle === "archived" ? !text(value.archivedAt) : value.archivedAt !== undefined) return false;
  const actorIds = value.members.map((member) => (member as { actorId: string }).actorId);
  return new Set(actorIds).size === actorIds.length && value.members.filter((member) =>
    (member as { kind: string; actorId: string }).kind === "human" &&
    (member as { actorId: string }).actorId === value.ownerActorId).length === 1;
}

function isConflict(value: unknown): boolean {
  return record(value) && keys(value, [
    "conflictId", "roomId", "subjectId", "kind", "summary", "state", "sourceRef",
    "revision", "allowedResolutions",
  ]) && text(value.conflictId) && text(value.roomId) && text(value.subjectId) &&
    typeof value.kind === "string" && conflictKinds.has(value.kind) && text(value.summary) &&
    text(value.state) && text(value.sourceRef) && revision(value.revision) && value.revision > 0 &&
    Array.isArray(value.allowedResolutions) && value.allowedResolutions.length > 0 &&
    value.allowedResolutions.every((item) => typeof item === "string" && resolutions.has(item));
}
export function isDepartureConflictList(value: unknown): value is DepartureConflictList {
  return record(value) && keys(value, [
    "roomId", "targetActorId", "governanceRevision", "conflicts",
  ]) && text(value.roomId) && text(value.targetActorId) && revision(value.governanceRevision) &&
    Array.isArray(value.conflicts) && value.conflicts.length <= 512 && value.conflicts.every(isConflict) &&
    value.conflicts.every((item) => (item as { roomId: string }).roomId === value.roomId) &&
    new Set(value.conflicts.map((item) => (item as { conflictId: string }).conflictId)).size === value.conflicts.length;
}

function isConnection(value: unknown, locked: boolean): boolean {
  if (!record(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "online": return !locked && keys(value, ["status"]);
    case "offline": return locked
      ? keys(value, ["status", "asOf"]) && text(value.asOf)
      : keys(value, ["status", "asOf", "leaseExpiresAt"]) && text(value.asOf) && text(value.leaseExpiresAt);
    case "repairing": return !locked && keys(value, ["status", "watermark"]) && revision(value.watermark);
    case "repair_failed": return !locked && keys(value, ["status", "errorCode"]) && text(value.errorCode);
    case "revoked": return locked && keys(value, ["status", "scope", "purgeCompleted"]) &&
      (value.scope === "room" || value.scope === "session") && typeof value.purgeCompleted === "boolean";
    case "fatal": return locked && keys(value, ["status", "errorCode"]) && text(value.errorCode);
    default: return false;
  }
}

function isClosedError(value: unknown): value is GovernanceClosedError {
  if (!record(value) || typeof value.status !== "number" || !text(value.code)) return false;
  const base = keys(value, ["status", "code"], value.status === 429 ? ["retryAfterSeconds"] : []);
  if (!base) {
    return value.status === 409 && value.code === "departure_blocked" &&
      keys(value, ["status", "code", "details"]) && isDepartureConflictList(value.details);
  }
  const allowed: Record<number, ReadonlySet<string>> = {
    401: new Set(["authentication_required", "session_revoked"]),
    403: new Set(["role_forbidden", "access_revoked"]),
    404: new Set(["member_not_found", "room_not_found"]),
    409: new Set(["room_revision_conflict", "ownership_transfer_required", "room_archived"]),
    410: new Set(["snapshot_expired"]),
    429: new Set(["rate_limited"]),
    503: new Set(["dependency_unavailable", "service_unavailable", "repair_unavailable"]),
  };
  return allowed[value.status]?.has(value.code) === true &&
    (value.retryAfterSeconds === undefined || revision(value.retryAfterSeconds));
}

function isOperation(value: unknown): value is GovernanceOperationState {
  if (!record(value) || typeof value.status !== "string") return false;
  if (value.status === "idle") return keys(value, ["status"]);
  if (!keys(value, ["status", "requestId", "command"], value.status === "failed" ? ["error"] : []) ||
      !text(value.requestId) || typeof value.command !== "string" || !commands.has(value.command as GovernanceCommand)) {
    return false;
  }
  if (value.status === "failed") {
    return keys(value, ["status", "requestId", "command", "error"]) && isClosedError(value.error);
  }
  return value.status === "submitting" || value.status === "acknowledged" || value.status === "succeeded";
}

export function isGovernanceRemoteState(value: unknown): value is GovernanceRemoteState {
  if (!record(value) || value.status === "locked") {
    return record(value) && value.status === "locked" && keys(value, ["status", "roomId", "connection"]) &&
      text(value.roomId) && isConnection(value.connection, true);
  }
  return value.status === "ready" && keys(value, [
    "status", "projection", "viewerActorId", "connection", "operation",
  ], ["departureConflicts"]) && isGovernanceProjection(value.projection) && text(value.viewerActorId) &&
    isConnection(value.connection, false) && isOperation(value.operation) &&
    (value.departureConflicts === undefined || isDepartureConflictList(value.departureConflicts));
}

export function isGovernanceAuthoritySnapshot(value: unknown): value is GovernanceAuthoritySnapshot {
  if (record(value) && value.status === "locked") return isGovernanceRemoteState(value);
  return record(value) && value.status === "ready" && keys(value, [
    "status", "projection", "viewerActorId", "connection",
  ], ["departureConflicts"]) && isGovernanceProjection(value.projection) && text(value.viewerActorId) &&
    isConnection(value.connection, false) &&
    (value.departureConflicts === undefined || isDepartureConflictList(value.departureConflicts));
}

export function isGovernanceSurfaceQuery(value: unknown): value is GovernanceSurfaceQuery {
  return record(value) && keys(value, ["roomId"]) && text(value.roomId);
}
export function isGovernanceDepartureQuery(value: unknown): value is GovernanceDepartureQuery {
  return record(value) && keys(value, ["roomId", "targetActorId", "expectedGovernanceRevision"]) &&
    text(value.roomId) && text(value.targetActorId) && revision(value.expectedGovernanceRevision);
}
function isIntent(value: unknown): value is GovernanceIntent {
  if (!record(value) || typeof value.command !== "string" || !commands.has(value.command as GovernanceCommand) ||
      !revision(value.expectedGovernanceRevision)) return false;
  const targeted = value.command === "room.ownership.transfer" || value.command === "room.member.remove";
  return targeted
    ? keys(value, ["command", "expectedGovernanceRevision", "targetActorId"]) && text(value.targetActorId)
    : keys(value, ["command", "expectedGovernanceRevision"]);
}
export function isGovernanceMutationRequest(value: unknown): value is GovernanceMutationRequest {
  return record(value) && keys(value, ["roomId", "intent"]) && text(value.roomId) && isIntent(value.intent);
}
export function isGovernanceSubmitResult(value: unknown): value is GovernanceSubmitResult {
  return record(value) && keys(value, ["requestId", "state"]) && text(value.requestId) &&
    isGovernanceRemoteState(value.state);
}
export function isGovernanceStateEnvelope(value: unknown): value is GovernanceStateEnvelope {
  return record(value) && keys(value, ["roomId", "state"]) && text(value.roomId) &&
    isGovernanceRemoteState(value.state) &&
    (value.state.status === "locked" ? value.state.roomId : value.state.projection.roomId) === value.roomId;
}
export function isGovernanceAuthorityAck(value: unknown): value is GovernanceAuthorityAck {
  return record(value) && keys(value, [
    "type", "requestId", "command", "result", "eventIds", "projection", "replayed",
  ]) && value.type === "ack" && text(value.requestId) && typeof value.command === "string" &&
    commands.has(value.command as GovernanceCommand) &&
    (value.result === "accepted" || value.result === "already_archived" || value.result === "already_active") &&
    typeof value.replayed === "boolean" &&
    Array.isArray(value.eventIds) && value.eventIds.length <= 64 && value.eventIds.every(text) &&
    new Set(value.eventIds).size === value.eventIds.length && isGovernanceProjection(value.projection) &&
    (value.result === "accepted" ? value.eventIds.length > 0 : value.eventIds.length === 0);
}

function clone<T>(value: T): T { return structuredClone(value); }
export function cloneGovernanceRemoteState(value: unknown): GovernanceRemoteState {
  if (!isGovernanceRemoteState(value)) throw new TypeError("Governance remote state is not closed");
  return clone(value);
}
export function cloneGovernanceAuthoritySnapshot(value: unknown): GovernanceAuthoritySnapshot {
  if (!isGovernanceAuthoritySnapshot(value)) throw new TypeError("Governance authority snapshot is not closed");
  return clone(value);
}
export function cloneDepartureConflictList(value: unknown): DepartureConflictList {
  if (!isDepartureConflictList(value)) throw new TypeError("Departure conflict list is not closed");
  return clone(value);
}
export function cloneGovernanceSubmitResult(value: unknown): GovernanceSubmitResult {
  if (!isGovernanceSubmitResult(value)) throw new TypeError("Governance submit result is not closed");
  return clone(value);
}
export function cloneGovernanceStateEnvelope(value: unknown): GovernanceStateEnvelope {
  if (!isGovernanceStateEnvelope(value)) throw new TypeError("Governance state envelope is not closed");
  return clone(value);
}
export function cloneGovernanceAuthorityAck(value: unknown): GovernanceAuthorityAck {
  if (!isGovernanceAuthorityAck(value)) throw new TypeError("Governance authority ACK is not closed");
  return clone(value);
}
