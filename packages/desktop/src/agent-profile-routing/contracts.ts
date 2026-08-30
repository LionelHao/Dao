/**
 * Renderer-safe FT-07 transport contract.
 *
 * This boundary intentionally contains display metadata, stable identifiers and
 * authority revisions only. Provider credentials, internal invocation origins,
 * writable availability and server capability tokens cannot be represented.
 */

export type AgentProfileStatus = "enabled" | "disabled";
export type AgentParticipation = "active" | "on-mention";
export type AgentAvailability = "ready" | "busy" | "paused" | "noauth";
export type AgentCapabilityId =
  | "room.conversation.read"
  | "room.memory.read"
  | "room.project.read"
  | "room.respond";
export type AgentToolId =
  | "http-json.read"
  | "repository.git-status"
  | "sandbox-file.write";

export interface AgentProfileProjection {
  readonly recordVersion: "agent-profile.v1";
  readonly profileId: string;
  readonly actorId: string;
  readonly displayName: string;
  readonly globalResponsibility: string;
  readonly status: AgentProfileStatus;
  readonly capabilityCeiling: readonly AgentCapabilityId[];
  readonly toolCeiling: readonly AgentToolId[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoomAgentAssignmentProjection {
  readonly recordVersion: "room-agent-assignment.v1";
  readonly assignmentId: string;
  readonly roomId: string;
  readonly profileId: string;
  readonly actorId: string;
  readonly displayName: string;
  readonly globalResponsibility: string;
  readonly roomResponsibility: string;
  readonly participation: AgentParticipation;
  readonly availability: AgentAvailability;
  readonly paused: boolean;
  readonly capabilityCeiling: readonly AgentCapabilityId[];
  readonly capabilitySubset: readonly AgentCapabilityId[];
  readonly effectiveCapabilities: readonly AgentCapabilityId[];
  readonly toolCeiling: readonly AgentToolId[];
  readonly toolSubset: readonly AgentToolId[];
  readonly effectiveTools: readonly AgentToolId[];
  readonly profileRevision: number;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
}

export interface AgentSettingsViewerProjection {
  readonly actorId: string;
  readonly tenantAdministrator: boolean;
  readonly roomRole: "owner" | "admin" | "member" | null;
}

export interface ProviderModelDisclosure {
  readonly providerId: string;
  readonly modelId: string;
  readonly credentialStatus: "configured" | "missing";
  readonly retentionDisabled: true;
  readonly selectionPolicy: "server-managed-single";
}

export type AgentProfileCatalogProjection =
  | {
      readonly status: "available";
      readonly revision: number;
      readonly profiles: readonly AgentProfileProjection[];
    }
  | { readonly status: "forbidden" };

export interface RoomAgentSettingsAvailableProjection {
  readonly status: "available";
  readonly roomId: string;
  readonly roomName: string;
  readonly lifecycle: "active" | "archived";
  readonly roomRevision: number;
  readonly assignments: readonly RoomAgentAssignmentProjection[];
}

export type RoomAgentSettingsProjection =
  | RoomAgentSettingsAvailableProjection
  | { readonly status: "forbidden"; readonly roomId: string };

export interface AgentSettingsSnapshot {
  readonly recordVersion: "agent-settings.snapshot.v1";
  readonly cursor: number;
  readonly viewer: AgentSettingsViewerProjection;
  readonly provider: ProviderModelDisclosure;
  readonly profileCatalog: AgentProfileCatalogProjection;
  readonly room: RoomAgentSettingsProjection;
}

export type AgentSettingsCommand =
  | "profile.create"
  | "profile.update"
  | "profile.disable"
  | "profile.enable"
  | "assignment.create"
  | "assignment.update"
  | "assignment.pause"
  | "assignment.resume"
  | "assignment.remove";

interface ProfileEditableFields {
  readonly displayName: string;
  readonly globalResponsibility: string;
  readonly capabilityCeiling: readonly AgentCapabilityId[];
  readonly toolCeiling: readonly AgentToolId[];
}

interface AssignmentEditableFields {
  readonly roomResponsibility: string;
  readonly participation: AgentParticipation;
  readonly capabilitySubset: readonly AgentCapabilityId[];
  readonly toolSubset: readonly AgentToolId[];
}

export type AgentSettingsMutationIntent =
  | ({ readonly command: "profile.create" } & ProfileEditableFields)
  | ({
      readonly command: "profile.update";
      readonly profileId: string;
      readonly expectedProfileRevision: number;
    } & ProfileEditableFields)
  | {
      readonly command: "profile.disable" | "profile.enable";
      readonly profileId: string;
      readonly expectedProfileRevision: number;
    }
  | ({
      readonly command: "assignment.create";
      readonly roomId: string;
      readonly profileId: string;
      readonly expectedRoomRevision: number;
    } & AssignmentEditableFields)
  | ({
      readonly command: "assignment.update";
      readonly roomId: string;
      readonly assignmentId: string;
      readonly expectedRoomRevision: number;
      readonly expectedAssignmentRevision: number;
    } & AssignmentEditableFields)
  | {
      readonly command: "assignment.pause" | "assignment.resume" | "assignment.remove";
      readonly roomId: string;
      readonly assignmentId: string;
      readonly expectedRoomRevision: number;
      readonly expectedAssignmentRevision: number;
    };

export type AgentSettingsClosedError =
  | { readonly status: 400; readonly code: "invalid_request" | "unknown_field" | "invalid_subset" }
  | { readonly status: 401; readonly code: "authentication_required" | "session_revoked" }
  | { readonly status: 403; readonly code: "role_forbidden" | "profile_forbidden" | "room_forbidden" | "access_revoked" }
  | { readonly status: 409; readonly code: "profile_revision_conflict" | "assignment_revision_conflict" | "room_revision_conflict" | "capability_ceiling_conflict" | "room_archived" }
  | { readonly status: 410; readonly code: "profile_gone" | "assignment_gone" | "snapshot_expired" | "protocol_upgrade_required" }
  | { readonly status: 429; readonly code: "capacity_limited" | "rate_limited"; readonly retryAfterSeconds?: number }
  | { readonly status: 503; readonly code: "authority_unavailable" | "provider_readiness_unavailable" | "repair_unavailable" };

export interface AgentSettingsAck {
  readonly type: "ack";
  readonly requestId: string;
  readonly command: AgentSettingsCommand;
  readonly replayed: boolean;
  readonly acceptedRevision: number;
  readonly eventIds: readonly string[];
}

export interface AgentSettingsErrorMessage {
  readonly type: "error";
  readonly requestId: string;
  readonly command: AgentSettingsCommand;
  readonly error: AgentSettingsClosedError;
}

export type AgentSettingsStableEventPayload =
  | { readonly kind: "profile.upserted"; readonly catalogRevision: number; readonly profile: AgentProfileProjection }
  | { readonly kind: "assignment.upserted"; readonly roomRevision: number; readonly assignment: RoomAgentAssignmentProjection }
  | { readonly kind: "assignment.removed"; readonly roomId: string; readonly roomRevision: number; readonly assignmentId: string; readonly actorId: string; readonly assignmentRevision: number };

export interface AgentSettingsStableEvent {
  readonly type: "stable-event";
  readonly eventId: string;
  readonly cursor: number;
  readonly causationRequestId?: string;
  readonly event: AgentSettingsStableEventPayload;
}

export type AgentSettingsAuthorityMessage =
  | { readonly type: "snapshot"; readonly snapshot: AgentSettingsSnapshot }
  | AgentSettingsAck
  | AgentSettingsErrorMessage
  | AgentSettingsStableEvent
  | { readonly type: "offline"; readonly asOf: string; readonly leaseExpiresAt: string }
  | { readonly type: "online" }
  | { readonly type: "repair-started"; readonly generation: number; readonly watermark: number }
  | { readonly type: "repair-completed"; readonly generation: number; readonly watermark: number; readonly snapshot: AgentSettingsSnapshot }
  | { readonly type: "repair-failed"; readonly generation: number; readonly watermark: number; readonly errorCode: string }
  | { readonly type: "access-revoked"; readonly scope: "room" | "session"; readonly purgeCompleted: boolean };

export interface AgentSettingsMutationRequest {
  readonly requestId: string;
  readonly intent: AgentSettingsMutationIntent;
}

export interface AgentSettingsBridge {
  getSnapshot(input: { readonly roomId: string }): Promise<AgentSettingsSnapshot>;
  submit(input: AgentSettingsMutationRequest): Promise<AgentSettingsAuthorityMessage>;
  onAuthorityMessage(listener: (message: AgentSettingsAuthorityMessage) => void): () => void;
}

type UnknownRecord = Record<PropertyKey, unknown>;
const profileStatuses = new Set(["enabled", "disabled"]);
const participations = new Set(["active", "on-mention"]);
const availabilities = new Set(["ready", "busy", "paused", "noauth"]);
const capabilities = new Set<AgentCapabilityId>([
  // Keep this duplicate closed list byte-for-byte aligned with Core until the
  // integration branch can import the just-landed FT-07 Core registry.
  "room.conversation.read", "room.memory.read", "room.project.read", "room.respond",
]);
const tools = new Set<AgentToolId>([
  "http-json.read", "repository.git-status", "sandbox-file.write",
]);
const commands = new Set<AgentSettingsCommand>([
  "profile.create", "profile.update", "profile.disable", "profile.enable",
  "assignment.create", "assignment.update", "assignment.pause", "assignment.resume", "assignment.remove",
]);

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function bounded(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum;
}

function timestamp(value: unknown): value is string {
  return bounded(value, 64) && Number.isFinite(Date.parse(value));
}

function revision(value: unknown, allowZero = false): value is number {
  return Number.isSafeInteger(value) && (value as number) >= (allowZero ? 0 : 1);
}

function canonicalClosedList<T extends string>(value: unknown, closed: ReadonlySet<T>): value is readonly T[] {
  return Array.isArray(value) && value.length <= closed.size &&
    value.every((item) => typeof item === "string" && closed.has(item as T)) &&
    value.every((item, index) => index === 0 || (value[index - 1] as string) < item);
}

function subset<T>(candidate: readonly T[], ceiling: readonly T[]): boolean {
  const allowed = new Set(ceiling);
  return candidate.every((value) => allowed.has(value));
}

export function isAgentProfileProjection(value: unknown): value is AgentProfileProjection {
  return record(value) && exact(value, [
    "recordVersion", "profileId", "actorId", "displayName", "globalResponsibility", "status",
    "capabilityCeiling", "toolCeiling", "revision", "createdAt", "updatedAt",
  ]) && value.recordVersion === "agent-profile.v1" && bounded(value.profileId) && bounded(value.actorId) &&
    bounded(value.displayName, 128) && bounded(value.globalResponsibility, 4_000) &&
    typeof value.status === "string" && profileStatuses.has(value.status) &&
    canonicalClosedList(value.capabilityCeiling, capabilities) && canonicalClosedList(value.toolCeiling, tools) &&
    revision(value.revision) && timestamp(value.createdAt) && timestamp(value.updatedAt);
}

export function isRoomAgentAssignmentProjection(value: unknown): value is RoomAgentAssignmentProjection {
  if (!record(value) || !exact(value, [
    "recordVersion", "assignmentId", "roomId", "profileId", "actorId", "displayName",
    "globalResponsibility", "roomResponsibility", "participation", "availability", "paused",
    "capabilityCeiling", "capabilitySubset", "effectiveCapabilities", "toolCeiling", "toolSubset",
    "effectiveTools", "profileRevision", "assignmentRevision", "accessRevision",
  ]) || value.recordVersion !== "room-agent-assignment.v1" || !bounded(value.assignmentId) ||
      !bounded(value.roomId) || !bounded(value.profileId) || !bounded(value.actorId) ||
      !bounded(value.displayName, 128) || !bounded(value.globalResponsibility, 4_000) ||
      !bounded(value.roomResponsibility, 4_000) || typeof value.participation !== "string" ||
      !participations.has(value.participation) || typeof value.availability !== "string" ||
      !availabilities.has(value.availability) || typeof value.paused !== "boolean" ||
      !canonicalClosedList(value.capabilityCeiling, capabilities) ||
      !canonicalClosedList(value.capabilitySubset, capabilities) ||
      !canonicalClosedList(value.effectiveCapabilities, capabilities) ||
      !canonicalClosedList(value.toolCeiling, tools) || !canonicalClosedList(value.toolSubset, tools) ||
      !canonicalClosedList(value.effectiveTools, tools) || !revision(value.profileRevision) ||
      !revision(value.assignmentRevision) || !revision(value.accessRevision, true)) return false;
  if (value.paused !== (value.availability === "paused")) return false;
  return subset(value.capabilitySubset, value.capabilityCeiling) &&
    subset(value.effectiveCapabilities, value.capabilitySubset) &&
    subset(value.toolSubset, value.toolCeiling) && subset(value.effectiveTools, value.toolSubset);
}

function isViewer(value: unknown): value is AgentSettingsViewerProjection {
  return record(value) && exact(value, ["actorId", "tenantAdministrator", "roomRole"]) &&
    bounded(value.actorId) && typeof value.tenantAdministrator === "boolean" &&
    (value.roomRole === null || value.roomRole === "owner" || value.roomRole === "admin" || value.roomRole === "member");
}

function isProvider(value: unknown): value is ProviderModelDisclosure {
  return record(value) && exact(value, [
    "providerId", "modelId", "credentialStatus", "retentionDisabled", "selectionPolicy",
  ]) && bounded(value.providerId, 128) && bounded(value.modelId, 256) &&
    (value.credentialStatus === "configured" || value.credentialStatus === "missing") &&
    value.retentionDisabled === true && value.selectionPolicy === "server-managed-single";
}

function isProfileCatalog(value: unknown, tenantAdministrator: boolean): value is AgentProfileCatalogProjection {
  if (!record(value)) return false;
  if (!tenantAdministrator) return exact(value, ["status"]) && value.status === "forbidden";
  if (!exact(value, ["status", "revision", "profiles"]) || value.status !== "available" ||
      !revision(value.revision, true) || !Array.isArray(value.profiles) || value.profiles.length > 256 ||
      !value.profiles.every(isAgentProfileProjection)) return false;
  const profiles = value.profiles as readonly AgentProfileProjection[];
  return new Set(profiles.map((profile) => profile.profileId)).size === profiles.length &&
    new Set(profiles.map((profile) => profile.actorId)).size === profiles.length;
}

export function isAgentSettingsSnapshot(value: unknown): value is AgentSettingsSnapshot {
  if (!record(value) || !exact(value, ["recordVersion", "cursor", "viewer", "provider", "profileCatalog", "room"]) ||
      value.recordVersion !== "agent-settings.snapshot.v1" || !revision(value.cursor, true) ||
      !isViewer(value.viewer) || !isProvider(value.provider) ||
      !isProfileCatalog(value.profileCatalog, value.viewer.tenantAdministrator) || !record(value.room)) return false;
  if (value.viewer.roomRole === null) {
    return exact(value.room, ["status", "roomId"]) && value.room.status === "forbidden" && bounded(value.room.roomId);
  }
  if (!exact(value.room, ["status", "roomId", "roomName", "lifecycle", "roomRevision", "assignments"]) ||
      value.room.status !== "available" || !bounded(value.room.roomId) || !bounded(value.room.roomName, 256) ||
      (value.room.lifecycle !== "active" && value.room.lifecycle !== "archived") ||
      !revision(value.room.roomRevision, true) || !Array.isArray(value.room.assignments) ||
      value.room.assignments.length > 256 || !value.room.assignments.every(isRoomAgentAssignmentProjection)) return false;
  const room = value.room;
  const assignments = room.assignments as readonly RoomAgentAssignmentProjection[];
  return assignments.every((assignment) => assignment.roomId === room.roomId) &&
    new Set(assignments.map((assignment) => assignment.assignmentId)).size === assignments.length &&
    new Set(assignments.map((assignment) => assignment.actorId)).size === assignments.length;
}

function profileFields(value: UnknownRecord): boolean {
  return bounded(value.displayName, 128) && bounded(value.globalResponsibility, 4_000) &&
    canonicalClosedList(value.capabilityCeiling, capabilities) && canonicalClosedList(value.toolCeiling, tools);
}

function assignmentFields(value: UnknownRecord): boolean {
  return bounded(value.roomResponsibility, 4_000) && typeof value.participation === "string" &&
    participations.has(value.participation) && canonicalClosedList(value.capabilitySubset, capabilities) &&
    canonicalClosedList(value.toolSubset, tools);
}

export function isAgentSettingsMutationIntent(value: unknown): value is AgentSettingsMutationIntent {
  if (!record(value) || typeof value.command !== "string" || !commands.has(value.command as AgentSettingsCommand)) return false;
  switch (value.command) {
    case "profile.create":
      return exact(value, ["command", "displayName", "globalResponsibility", "capabilityCeiling", "toolCeiling"]) && profileFields(value);
    case "profile.update":
      return exact(value, ["command", "profileId", "expectedProfileRevision", "displayName", "globalResponsibility", "capabilityCeiling", "toolCeiling"]) &&
        bounded(value.profileId) && revision(value.expectedProfileRevision) && profileFields(value);
    case "profile.disable": case "profile.enable":
      return exact(value, ["command", "profileId", "expectedProfileRevision"]) && bounded(value.profileId) && revision(value.expectedProfileRevision);
    case "assignment.create":
      return exact(value, ["command", "roomId", "profileId", "expectedRoomRevision", "roomResponsibility", "participation", "capabilitySubset", "toolSubset"]) &&
        bounded(value.roomId) && bounded(value.profileId) && revision(value.expectedRoomRevision, true) && assignmentFields(value);
    case "assignment.update":
      return exact(value, ["command", "roomId", "assignmentId", "expectedRoomRevision", "expectedAssignmentRevision", "roomResponsibility", "participation", "capabilitySubset", "toolSubset"]) &&
        bounded(value.roomId) && bounded(value.assignmentId) && revision(value.expectedRoomRevision, true) && revision(value.expectedAssignmentRevision) && assignmentFields(value);
    case "assignment.pause": case "assignment.resume": case "assignment.remove":
      return exact(value, ["command", "roomId", "assignmentId", "expectedRoomRevision", "expectedAssignmentRevision"]) &&
        bounded(value.roomId) && bounded(value.assignmentId) && revision(value.expectedRoomRevision, true) && revision(value.expectedAssignmentRevision);
  }
  return false;
}

export function isAgentSettingsClosedError(value: unknown): value is AgentSettingsClosedError {
  if (!record(value) || typeof value.status !== "number" || typeof value.code !== "string") return false;
  const retry = value.status === 429;
  if (!exact(value, ["status", "code"], retry ? ["retryAfterSeconds"] : [])) return false;
  const codes: Readonly<Record<number, ReadonlySet<string>>> = {
    400: new Set(["invalid_request", "unknown_field", "invalid_subset"]),
    401: new Set(["authentication_required", "session_revoked"]),
    403: new Set(["role_forbidden", "profile_forbidden", "room_forbidden", "access_revoked"]),
    409: new Set(["profile_revision_conflict", "assignment_revision_conflict", "room_revision_conflict", "capability_ceiling_conflict", "room_archived"]),
    410: new Set(["profile_gone", "assignment_gone", "snapshot_expired", "protocol_upgrade_required"]),
    429: new Set(["capacity_limited", "rate_limited"]),
    503: new Set(["authority_unavailable", "provider_readiness_unavailable", "repair_unavailable"]),
  };
  return codes[value.status]?.has(value.code) === true &&
    (value.retryAfterSeconds === undefined || revision(value.retryAfterSeconds, true));
}

function isCommand(value: unknown): value is AgentSettingsCommand {
  return typeof value === "string" && commands.has(value as AgentSettingsCommand);
}

function uniqueTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 64 && value.every((item) => bounded(item)) &&
    new Set(value).size === value.length;
}

function isStableEventPayload(value: unknown): value is AgentSettingsStableEventPayload {
  if (!record(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "profile.upserted": return exact(value, ["kind", "catalogRevision", "profile"]) && revision(value.catalogRevision) && isAgentProfileProjection(value.profile);
    case "assignment.upserted": return exact(value, ["kind", "roomRevision", "assignment"]) && revision(value.roomRevision) && isRoomAgentAssignmentProjection(value.assignment);
    case "assignment.removed": return exact(value, ["kind", "roomId", "roomRevision", "assignmentId", "actorId", "assignmentRevision"]) && bounded(value.roomId) && revision(value.roomRevision) && bounded(value.assignmentId) && bounded(value.actorId) && revision(value.assignmentRevision);
    default: return false;
  }
}

export function isAgentSettingsAuthorityMessage(value: unknown): value is AgentSettingsAuthorityMessage {
  if (!record(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "snapshot": return exact(value, ["type", "snapshot"]) && isAgentSettingsSnapshot(value.snapshot);
    case "ack": return exact(value, ["type", "requestId", "command", "replayed", "acceptedRevision", "eventIds"]) &&
      bounded(value.requestId) && isCommand(value.command) && typeof value.replayed === "boolean" &&
      revision(value.acceptedRevision, true) && uniqueTextList(value.eventIds);
    case "error": return exact(value, ["type", "requestId", "command", "error"]) && bounded(value.requestId) &&
      isCommand(value.command) && isAgentSettingsClosedError(value.error);
    case "stable-event": return exact(value, ["type", "eventId", "cursor", "event"], ["causationRequestId"]) &&
      bounded(value.eventId) && revision(value.cursor) &&
      (value.causationRequestId === undefined || bounded(value.causationRequestId)) && isStableEventPayload(value.event);
    case "offline": return exact(value, ["type", "asOf", "leaseExpiresAt"]) && timestamp(value.asOf) && timestamp(value.leaseExpiresAt);
    case "online": return exact(value, ["type"]);
    case "repair-started": return exact(value, ["type", "generation", "watermark"]) && revision(value.generation) && revision(value.watermark, true);
    case "repair-completed": return exact(value, ["type", "generation", "watermark", "snapshot"]) && revision(value.generation) &&
      revision(value.watermark, true) && isAgentSettingsSnapshot(value.snapshot) && value.snapshot.cursor === value.watermark;
    case "repair-failed": return exact(value, ["type", "generation", "watermark", "errorCode"]) && revision(value.generation) &&
      revision(value.watermark, true) && bounded(value.errorCode);
    case "access-revoked": return exact(value, ["type", "scope", "purgeCompleted"]) &&
      (value.scope === "room" || value.scope === "session") && typeof value.purgeCompleted === "boolean";
    default: return false;
  }
}
