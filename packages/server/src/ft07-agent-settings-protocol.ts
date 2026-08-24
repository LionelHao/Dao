import {
  isAgentProfileProjection,
  isCanonicalAgentCapabilitySet,
  isCanonicalAgentToolSet,
  isDeploymentAgentProfileRepairSnapshot,
  isDeploymentAgentProfileSyncResult,
  isDeploymentProviderDisclosure,
  isPersistedDeploymentAgentProfileEvent,
  isRoomAgentAssignmentProjection,
  isRoomAgentAssignmentRepairSnapshot,
  type AgentProfileProjection,
  type DeploymentAgentProfileRepairSnapshot,
  type DeploymentAgentProfileSyncResult,
  type DeploymentProviderDisclosure,
  type PersistedDeploymentAgentProfileEvent,
  type RoomAgentAssignmentProjection,
  type RoomAgentAssignmentRepairSnapshot,
} from "@native-im/core";

export const FT07_AGENT_SETTINGS_MUTATIONS = Object.freeze([
  "tenant-administrator.add",
  "tenant-administrator.remove",
  "agent-profile.create",
  "agent-profile.update",
  "agent-profile.enable",
  "agent-profile.disable",
  "room-agent-assignment.create",
  "room-agent-assignment.update",
  "room-agent-assignment.pause",
  "room-agent-assignment.resume",
  "room-agent-assignment.remove",
] as const);

export type Ft07AgentSettingsMutationType = typeof FT07_AGENT_SETTINGS_MUTATIONS[number];

export interface TenantAdministratorRegistryProjection {
  readonly revision: number;
  readonly principalIds: readonly string[];
  readonly configurationDigest: string;
  readonly updatedAt: string;
}

export type Ft07AgentSettingsClientFrame =
  | { readonly type: "tenant-administrator.list"; readonly requestId: string }
  | { readonly type: "agent-profile.list"; readonly requestId: string }
  | { readonly type: "agent-profile.get"; readonly requestId: string; readonly profileId: string }
  | { readonly type: "provider-configuration.disclose"; readonly requestId: string }
  | { readonly type: "agent-profile.repair"; readonly requestId: string }
  | {
      readonly type: "agent-profile.sync";
      readonly requestId: string;
      readonly afterSeq?: number;
      readonly limit?: number;
    }
  | { readonly type: "room-agent-assignment.list"; readonly requestId: string; readonly roomId: string }
  | {
      readonly type: "room-agent-assignment.get";
      readonly requestId: string;
      readonly roomId: string;
      readonly assignmentId: string;
    }
  | { readonly type: "room-agent-assignment.repair"; readonly requestId: string; readonly roomId: string }
  | {
      readonly type: "tenant-administrator.add" | "tenant-administrator.remove";
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly targetPrincipalId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly type: "agent-profile.create";
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly expectedProfileRevision: 0;
      readonly displayName: string;
      readonly globalResponsibility: string;
      readonly capabilityCeiling: readonly string[];
      readonly toolCeiling: readonly string[];
    }
  | {
      readonly type: "agent-profile.update";
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly profileId: string;
      readonly expectedProfileRevision: number;
      readonly displayName: string;
      readonly globalResponsibility: string;
      readonly capabilityCeiling: readonly string[];
      readonly toolCeiling: readonly string[];
    }
  | {
      readonly type: "agent-profile.enable" | "agent-profile.disable";
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly profileId: string;
      readonly expectedProfileRevision: number;
    }
  | {
      readonly type: "room-agent-assignment.create";
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly roomId: string;
      readonly profileId: string;
      readonly expectedRoomRevision: number;
      readonly roomResponsibility: string;
      readonly participation: "active" | "on-mention";
      readonly capabilitySubset: readonly string[];
      readonly toolSubset: readonly string[];
    }
  | {
      readonly type: "room-agent-assignment.update";
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly roomId: string;
      readonly assignmentId: string;
      readonly expectedRoomRevision: number;
      readonly expectedAssignmentRevision: number;
      readonly roomResponsibility: string;
      readonly participation: "active" | "on-mention";
      readonly capabilitySubset: readonly string[];
      readonly toolSubset: readonly string[];
    }
  | {
      readonly type:
        | "room-agent-assignment.pause"
        | "room-agent-assignment.resume"
        | "room-agent-assignment.remove";
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly roomId: string;
      readonly assignmentId: string;
      readonly expectedRoomRevision: number;
      readonly expectedAssignmentRevision: number;
    };

export type Ft07AgentSettingsServerFrame =
  | {
      readonly type: "tenant-administrator.registry";
      readonly requestId: string;
      readonly registry: TenantAdministratorRegistryProjection;
    }
  | {
      readonly type: "agent-profile.catalog";
      readonly requestId: string;
      readonly catalogRevision: number;
      readonly profiles: readonly AgentProfileProjection[];
      readonly provider: DeploymentProviderDisclosure;
    }
  | {
      readonly type: "agent-profile.detail";
      readonly requestId: string;
      readonly profile: AgentProfileProjection;
      readonly provider: DeploymentProviderDisclosure;
    }
  | {
      readonly type: "provider-configuration.disclosure";
      readonly requestId: string;
      readonly provider: DeploymentProviderDisclosure;
    }
  | {
      readonly type: "room-agent-assignment.catalog";
      readonly requestId: string;
      readonly roomId: string;
      readonly roomRevision: number;
      readonly assignments: readonly RoomAgentAssignmentProjection[];
      readonly provider: DeploymentProviderDisclosure;
    }
  | {
      readonly type: "room-agent-assignment.detail";
      readonly requestId: string;
      readonly roomId: string;
      readonly assignment: RoomAgentAssignmentProjection;
      readonly provider: DeploymentProviderDisclosure;
    }
  | DeploymentAgentProfileRepairSnapshot
  | DeploymentAgentProfileSyncResult
  | RoomAgentAssignmentRepairSnapshot
  | PersistedDeploymentAgentProfileEvent
  | {
      readonly type: "agent-settings.ack";
      readonly requestId: string;
      readonly operation: Ft07AgentSettingsMutationType;
      readonly acceptedRevision: number;
      readonly eventIds: readonly string[];
      readonly replayed: boolean;
    };

export type Ft07FrameParseResult =
  | { readonly ok: true; readonly frame: Ft07AgentSettingsClientFrame }
  | { readonly ok: false; readonly requestId?: string };

type UnknownRecord = Record<string, unknown>;

const QUERY_TYPES = new Set([
  "tenant-administrator.list", "agent-profile.list", "provider-configuration.disclose",
  "agent-profile.repair",
]);
const ROOM_QUERY_TYPES = new Set([
  "room-agent-assignment.list", "room-agent-assignment.repair",
]);
const MUTATION_TYPES = new Set<string>(FT07_AGENT_SETTINGS_MUTATIONS);

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && keys.includes(key));
}

function boundedText(value: unknown, maximumBytes = 256): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function revision(value: unknown, allowZero = false): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1);
}

function canonicalIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 &&
    value.every((entry, index) => boundedText(entry) &&
      (index === 0 || (value[index - 1] as string) < entry));
}

function profileFields(value: UnknownRecord): boolean {
  return boundedText(value.displayName, 120) && boundedText(value.globalResponsibility, 4_000) &&
    isCanonicalAgentCapabilitySet(value.capabilityCeiling) &&
    isCanonicalAgentToolSet(value.toolCeiling);
}

function assignmentFields(value: UnknownRecord): boolean {
  return boundedText(value.roomResponsibility, 4_000) &&
    (value.participation === "active" || value.participation === "on-mention") &&
    isCanonicalAgentCapabilitySet(value.capabilitySubset) &&
    isCanonicalAgentToolSet(value.toolSubset);
}

export function isFt07AgentSettingsFrameType(type: unknown): type is string {
  return typeof type === "string" && (QUERY_TYPES.has(type) || ROOM_QUERY_TYPES.has(type) ||
    MUTATION_TYPES.has(type) || type === "agent-profile.get" || type === "agent-profile.sync" ||
    type === "room-agent-assignment.get");
}

export function parseFt07AgentSettingsClientFrame(value: unknown): Ft07FrameParseResult {
  if (!record(value) || !isFt07AgentSettingsFrameType(value.type)) return { ok: false };
  const requestId = boundedText(value.requestId, 128) ? value.requestId : undefined;
  if (QUERY_TYPES.has(value.type as string)) {
    return exact(value, ["type", "requestId"]) && requestId !== undefined
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  if (ROOM_QUERY_TYPES.has(value.type as string)) {
    return exact(value, ["type", "requestId", "roomId"]) && requestId !== undefined &&
      boundedText(value.roomId)
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  if (value.type === "room-agent-assignment.get") {
    return exact(value, ["type", "requestId", "roomId", "assignmentId"]) &&
      requestId !== undefined && boundedText(value.roomId) && boundedText(value.assignmentId)
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  if (value.type === "agent-profile.get") {
    return exact(value, ["type", "requestId", "profileId"]) && requestId !== undefined &&
      boundedText(value.profileId)
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  if (value.type === "agent-profile.sync") {
    const optional = [
      ...(Object.hasOwn(value, "afterSeq") ? ["afterSeq"] : []),
      ...(Object.hasOwn(value, "limit") ? ["limit"] : []),
    ];
    return exact(value, ["type", "requestId", ...optional]) && requestId !== undefined &&
      (!Object.hasOwn(value, "afterSeq") || revision(value.afterSeq, true)) &&
      (!Object.hasOwn(value, "limit") || (revision(value.limit) && (value.limit as number) <= 256))
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  const common = requestId !== undefined && boundedText(value.idempotencyKey, 128);
  if (value.type === "tenant-administrator.add" || value.type === "tenant-administrator.remove") {
    return common && exact(value, [
      "type", "requestId", "idempotencyKey", "targetPrincipalId", "expectedRevision",
    ]) && boundedText(value.targetPrincipalId) && revision(value.expectedRevision)
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  if (value.type === "agent-profile.create") {
    return common && exact(value, [
      "type", "requestId", "idempotencyKey", "expectedProfileRevision", "displayName",
      "globalResponsibility", "capabilityCeiling", "toolCeiling",
    ]) && value.expectedProfileRevision === 0 && profileFields(value)
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  if (value.type === "agent-profile.update") {
    return common && exact(value, [
      "type", "requestId", "idempotencyKey", "profileId", "expectedProfileRevision",
      "displayName", "globalResponsibility", "capabilityCeiling", "toolCeiling",
    ]) && boundedText(value.profileId) && revision(value.expectedProfileRevision) && profileFields(value)
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  if (value.type === "agent-profile.enable" || value.type === "agent-profile.disable") {
    return common && exact(value, [
      "type", "requestId", "idempotencyKey", "profileId", "expectedProfileRevision",
    ]) && boundedText(value.profileId) && revision(value.expectedProfileRevision)
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  if (value.type === "room-agent-assignment.create") {
    return common && exact(value, [
      "type", "requestId", "idempotencyKey", "roomId", "profileId", "expectedRoomRevision",
      "roomResponsibility", "participation", "capabilitySubset", "toolSubset",
    ]) && boundedText(value.roomId) && boundedText(value.profileId) &&
      revision(value.expectedRoomRevision, true) && assignmentFields(value)
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  if (value.type === "room-agent-assignment.update") {
    return common && exact(value, [
      "type", "requestId", "idempotencyKey", "roomId", "assignmentId", "expectedRoomRevision",
      "expectedAssignmentRevision", "roomResponsibility", "participation", "capabilitySubset",
      "toolSubset",
    ]) && boundedText(value.roomId) && boundedText(value.assignmentId) &&
      revision(value.expectedRoomRevision, true) && revision(value.expectedAssignmentRevision) &&
      assignmentFields(value)
      ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
      : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
  }
  return common && exact(value, [
    "type", "requestId", "idempotencyKey", "roomId", "assignmentId", "expectedRoomRevision",
    "expectedAssignmentRevision",
  ]) && boundedText(value.roomId) && boundedText(value.assignmentId) &&
    revision(value.expectedRoomRevision, true) && revision(value.expectedAssignmentRevision)
    ? { ok: true, frame: value as Ft07AgentSettingsClientFrame }
    : { ok: false, ...(requestId === undefined ? {} : { requestId }) };
}

export function isTenantAdministratorRegistryProjection(
  value: unknown,
): value is TenantAdministratorRegistryProjection {
  return record(value) && exact(value, [
    "revision", "principalIds", "configurationDigest", "updatedAt",
  ]) && revision(value.revision) && canonicalIds(value.principalIds) &&
    typeof value.configurationDigest === "string" && /^[a-f0-9]{64}$/.test(value.configurationDigest) &&
    boundedText(value.updatedAt, 64) && Number.isFinite(Date.parse(value.updatedAt));
}

function uniqueIds(value: unknown, maximum = 256): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maximum &&
    value.every((entry) => boundedText(entry)) &&
    new Set(value).size === value.length;
}

export function isFt07AgentSettingsServerFrame(value: unknown): value is Ft07AgentSettingsServerFrame {
  if (!record(value) || typeof value.type !== "string") return false;
  if (isPersistedDeploymentAgentProfileEvent(value) ||
      isDeploymentAgentProfileRepairSnapshot(value) ||
      isDeploymentAgentProfileSyncResult(value) ||
      isRoomAgentAssignmentRepairSnapshot(value)) return true;
  if (!boundedText(value.requestId, 128)) return false;
  switch (value.type) {
    case "tenant-administrator.registry":
      return exact(value, ["type", "requestId", "registry"]) &&
        isTenantAdministratorRegistryProjection(value.registry);
    case "agent-profile.catalog":
      return exact(value, ["type", "requestId", "catalogRevision", "profiles", "provider"]) &&
        revision(value.catalogRevision, true) && Array.isArray(value.profiles) &&
        value.profiles.length <= 256 && value.profiles.every(isAgentProfileProjection) &&
        new Set(value.profiles.map((profile) => profile.profileId)).size === value.profiles.length &&
        isDeploymentProviderDisclosure(value.provider);
    case "agent-profile.detail":
      return exact(value, ["type", "requestId", "profile", "provider"]) &&
        isAgentProfileProjection(value.profile) && isDeploymentProviderDisclosure(value.provider);
    case "provider-configuration.disclosure":
      return exact(value, ["type", "requestId", "provider"]) &&
        isDeploymentProviderDisclosure(value.provider);
    case "room-agent-assignment.catalog":
      return exact(value, [
        "type", "requestId", "roomId", "roomRevision", "assignments", "provider",
      ]) && boundedText(value.roomId) && revision(value.roomRevision, true) &&
        Array.isArray(value.assignments) && value.assignments.length <= 256 &&
        value.assignments.every((assignment) =>
          isRoomAgentAssignmentProjection(assignment, value.roomId as string)) &&
        new Set(value.assignments.map((assignment) => assignment.assignmentId)).size ===
          value.assignments.length && isDeploymentProviderDisclosure(value.provider);
    case "room-agent-assignment.detail":
      return exact(value, ["type", "requestId", "roomId", "assignment", "provider"]) &&
        boundedText(value.roomId) &&
        isRoomAgentAssignmentProjection(value.assignment, value.roomId as string) &&
        isDeploymentProviderDisclosure(value.provider);
    case "agent-settings.ack":
      return exact(value, [
        "type", "requestId", "operation", "acceptedRevision", "eventIds", "replayed",
      ]) && MUTATION_TYPES.has(String(value.operation)) &&
        revision(value.acceptedRevision) && uniqueIds(value.eventIds, 64) &&
        typeof value.replayed === "boolean";
    default:
      return false;
  }
}
