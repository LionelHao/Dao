declare const agentActorIdBrand: unique symbol;
declare const agentProfileIdBrand: unique symbol;
declare const agentAssignmentIdBrand: unique symbol;

export type AgentActorId = string & { readonly [agentActorIdBrand]: "AgentActorId" };
export type AgentProfileId = string & { readonly [agentProfileIdBrand]: "AgentProfileId" };
export type AgentAssignmentId = string & {
  readonly [agentAssignmentIdBrand]: "AgentAssignmentId";
};

export const AGENT_CAPABILITY_IDS = [
  "room.conversation.read",
  "room.memory.read",
  "room.project.read",
  "room.respond",
] as const;

export type AgentCapabilityId = typeof AGENT_CAPABILITY_IDS[number];

export const AGENT_TOOL_IDS = [
  "http-json.read",
  "repository.git-status",
  "sandbox-file.write",
] as const;

export type AgentToolId = typeof AGENT_TOOL_IDS[number];
export type AgentProfileStatus = "enabled" | "disabled";
export type AgentAssignmentStatus = "current" | "removed";
export type AgentAssignmentParticipation = "active" | "on-mention";
export type AgentAvailability = "ready" | "busy" | "paused" | "noauth";

export interface AgentProfileRecord {
  readonly profileId: AgentProfileId;
  readonly actorId: AgentActorId;
  readonly displayName: string;
  readonly globalResponsibility: string;
  readonly status: AgentProfileStatus;
  readonly capabilityCeiling: readonly AgentCapabilityId[];
  readonly toolCeiling: readonly AgentToolId[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentAssignmentRecord {
  readonly assignmentId: AgentAssignmentId;
  readonly roomId: string;
  readonly profileId: AgentProfileId;
  readonly actorId: AgentActorId;
  readonly roomResponsibility: string;
  readonly status: AgentAssignmentStatus;
  readonly participation: AgentAssignmentParticipation;
  readonly paused: boolean;
  readonly capabilitySubset: readonly AgentCapabilityId[];
  readonly toolSubset: readonly AgentToolId[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly removedAt?: string;
}

export interface AgentAvailabilityFacts {
  readonly profileEnabled: boolean;
  readonly assignmentCurrent: boolean;
  readonly roomActive: boolean;
  readonly accessValid: boolean;
  readonly paused: boolean;
  readonly providerReady: boolean;
  readonly runningExecutionCount: number;
}

export interface RoomAgentProjection {
  readonly assignmentId: AgentAssignmentId;
  readonly roomId: string;
  readonly profileId: AgentProfileId;
  readonly actorId: AgentActorId;
  readonly displayName: string;
  readonly globalResponsibility: string;
  readonly roomResponsibility: string;
  readonly participation: AgentAssignmentParticipation;
  readonly availability: AgentAvailability;
  readonly effectiveCapabilities: readonly AgentCapabilityId[];
  readonly effectiveTools: readonly AgentToolId[];
  readonly profileRevision: number;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly updatedAt: string;
}

type UnknownRecord = Record<string, unknown>;

const capabilityIds = new Set<string>(AGENT_CAPABILITY_IDS);
const toolIds = new Set<string>(AGENT_TOOL_IDS);
const profileStatuses = new Set<AgentProfileStatus>(["enabled", "disabled"]);
const assignmentStatuses = new Set<AgentAssignmentStatus>(["current", "removed"]);
const participations = new Set<AgentAssignmentParticipation>(["active", "on-mention"]);
const availabilities = new Set<AgentAvailability>(["ready", "busy", "paused", "noauth"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value === value.trim() &&
    value.length > 0 && value.length <= maximum;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Number.isFinite(Date.parse(value));
}

function positiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function brandedId(value: unknown): value is string {
  return boundedText(value, 200);
}

function isCanonicalClosedSet(
  value: unknown,
  registry: ReadonlySet<string>,
): value is readonly string[] {
  return Array.isArray(value) && value.every((entry, index) =>
    typeof entry === "string" && registry.has(entry) &&
    (index === 0 || (value[index - 1] as string) < entry));
}

export function asAgentActorId(value: string): AgentActorId {
  if (!brandedId(value)) throw new TypeError("Agent actor ID must be a non-empty canonical ID");
  return value as AgentActorId;
}

export function asAgentProfileId(value: string): AgentProfileId {
  if (!brandedId(value)) throw new TypeError("Agent profile ID must be a non-empty canonical ID");
  return value as AgentProfileId;
}

export function asAgentAssignmentId(value: string): AgentAssignmentId {
  if (!brandedId(value)) throw new TypeError("Agent assignment ID must be a non-empty canonical ID");
  return value as AgentAssignmentId;
}

export function isAgentActorId(value: unknown): value is AgentActorId {
  return brandedId(value);
}

export function isAgentProfileId(value: unknown): value is AgentProfileId {
  return brandedId(value);
}

export function isAgentAssignmentId(value: unknown): value is AgentAssignmentId {
  return brandedId(value);
}

export function isAgentCapabilityId(value: unknown): value is AgentCapabilityId {
  return typeof value === "string" && capabilityIds.has(value);
}

export function isAgentToolId(value: unknown): value is AgentToolId {
  return typeof value === "string" && toolIds.has(value);
}

export function isCanonicalAgentCapabilitySet(
  value: unknown,
): value is readonly AgentCapabilityId[] {
  return isCanonicalClosedSet(value, capabilityIds);
}

export function isCanonicalAgentToolSet(value: unknown): value is readonly AgentToolId[] {
  return isCanonicalClosedSet(value, toolIds);
}

export function canonicalizeAgentCapabilities(
  value: readonly AgentCapabilityId[],
): readonly AgentCapabilityId[] {
  return [...new Set(value)].sort();
}

export function canonicalizeAgentTools(
  value: readonly AgentToolId[],
): readonly AgentToolId[] {
  return [...new Set(value)].sort();
}

export function isAgentProfileRecord(value: unknown): value is AgentProfileRecord {
  return isRecord(value) && exact(value, [
    "profileId", "actorId", "displayName", "globalResponsibility", "status",
    "capabilityCeiling", "toolCeiling", "revision", "createdAt", "updatedAt",
  ]) && isAgentProfileId(value.profileId) && isAgentActorId(value.actorId) &&
    boundedText(value.displayName, 120) && boundedText(value.globalResponsibility, 4_000) &&
    profileStatuses.has(value.status as AgentProfileStatus) &&
    isCanonicalAgentCapabilitySet(value.capabilityCeiling) &&
    isCanonicalAgentToolSet(value.toolCeiling) && positiveRevision(value.revision) &&
    timestamp(value.createdAt) && timestamp(value.updatedAt) && value.createdAt <= value.updatedAt;
}

export function isAgentAssignmentRecord(value: unknown): value is AgentAssignmentRecord {
  if (!isRecord(value) || !exact(value, [
    "assignmentId", "roomId", "profileId", "actorId", "roomResponsibility",
    "status", "participation", "paused", "capabilitySubset", "toolSubset",
    "revision", "createdAt", "updatedAt",
  ], ["removedAt"]) || !isAgentAssignmentId(value.assignmentId) ||
    !boundedText(value.roomId, 200) || !isAgentProfileId(value.profileId) ||
    !isAgentActorId(value.actorId) || !boundedText(value.roomResponsibility, 4_000) ||
    !assignmentStatuses.has(value.status as AgentAssignmentStatus) ||
    !participations.has(value.participation as AgentAssignmentParticipation) ||
    typeof value.paused !== "boolean" ||
    !isCanonicalAgentCapabilitySet(value.capabilitySubset) ||
    !isCanonicalAgentToolSet(value.toolSubset) || !positiveRevision(value.revision) ||
    !timestamp(value.createdAt) || !timestamp(value.updatedAt) || value.createdAt > value.updatedAt) {
    return false;
  }
  return value.status === "removed"
    ? timestamp(value.removedAt) && value.updatedAt <= value.removedAt
    : value.removedAt === undefined;
}

export function isAgentAvailabilityFacts(value: unknown): value is AgentAvailabilityFacts {
  return isRecord(value) && exact(value, [
    "profileEnabled", "assignmentCurrent", "roomActive", "accessValid", "paused",
    "providerReady", "runningExecutionCount",
  ]) && typeof value.profileEnabled === "boolean" &&
    typeof value.assignmentCurrent === "boolean" && typeof value.roomActive === "boolean" &&
    typeof value.accessValid === "boolean" && typeof value.paused === "boolean" &&
    typeof value.providerReady === "boolean" && nonnegativeRevision(value.runningExecutionCount);
}

export function deriveAgentAvailability(
  facts: AgentAvailabilityFacts,
): AgentAvailability | null {
  if (!facts.profileEnabled || !facts.assignmentCurrent || !facts.roomActive || !facts.accessValid) {
    return null;
  }
  if (facts.paused) return "paused";
  if (!facts.providerReady) return "noauth";
  if (facts.runningExecutionCount > 0) return "busy";
  return "ready";
}

export function isRoomAgentProjection(value: unknown): value is RoomAgentProjection {
  return isRecord(value) && exact(value, [
    "assignmentId", "roomId", "profileId", "actorId", "displayName",
    "globalResponsibility", "roomResponsibility", "participation", "availability",
    "effectiveCapabilities", "effectiveTools", "profileRevision", "assignmentRevision",
    "accessRevision", "updatedAt",
  ]) && isAgentAssignmentId(value.assignmentId) && boundedText(value.roomId, 200) &&
    isAgentProfileId(value.profileId) && isAgentActorId(value.actorId) &&
    boundedText(value.displayName, 120) && boundedText(value.globalResponsibility, 4_000) &&
    boundedText(value.roomResponsibility, 4_000) &&
    participations.has(value.participation as AgentAssignmentParticipation) &&
    availabilities.has(value.availability as AgentAvailability) &&
    isCanonicalAgentCapabilitySet(value.effectiveCapabilities) &&
    isCanonicalAgentToolSet(value.effectiveTools) && positiveRevision(value.profileRevision) &&
    positiveRevision(value.assignmentRevision) && nonnegativeRevision(value.accessRevision) &&
    timestamp(value.updatedAt);
}

export function isAssignmentWithinProfileCeiling(
  profile: Pick<AgentProfileRecord, "actorId" | "profileId" | "capabilityCeiling" | "toolCeiling">,
  assignment: Pick<AgentAssignmentRecord,
    "actorId" | "profileId" | "capabilitySubset" | "toolSubset">,
): boolean {
  const capabilities = new Set(profile.capabilityCeiling);
  const tools = new Set(profile.toolCeiling);
  return profile.actorId === assignment.actorId && profile.profileId === assignment.profileId &&
    assignment.capabilitySubset.every((capability) => capabilities.has(capability)) &&
    assignment.toolSubset.every((tool) => tools.has(tool));
}

export function intersectAgentAuthority(
  profile: AgentProfileRecord,
  assignment: AgentAssignmentRecord,
  membershipCapabilities: readonly AgentCapabilityId[],
  membershipTools: readonly AgentToolId[],
): Readonly<{
  effectiveCapabilities: readonly AgentCapabilityId[];
  effectiveTools: readonly AgentToolId[];
}> | null {
  if (!isAgentProfileRecord(profile) || !isAgentAssignmentRecord(assignment) ||
    !isCanonicalAgentCapabilitySet(membershipCapabilities) ||
    !isCanonicalAgentToolSet(membershipTools) ||
    profile.status !== "enabled" || assignment.status !== "current" ||
    !isAssignmentWithinProfileCeiling(profile, assignment)) return null;
  const membershipCapabilitySet = new Set(membershipCapabilities);
  const membershipToolSet = new Set(membershipTools);
  return {
    effectiveCapabilities: assignment.capabilitySubset.filter((id) =>
      membershipCapabilitySet.has(id)),
    effectiveTools: assignment.toolSubset.filter((id) => membershipToolSet.has(id)),
  };
}
