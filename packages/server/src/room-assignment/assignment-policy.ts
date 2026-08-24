export type AssignmentParticipation = "active" | "on-mention";
export type AssignmentAvailability = "ready" | "busy" | "paused" | "noauth";
export type AssignmentMutationKind = "create" | "update" | "pause" | "resume" | "remove";

export interface AssignmentMutationRequest {
  readonly kind: AssignmentMutationKind;
  readonly requestId: string;
  readonly roomId: string;
  readonly expectedRoomRevision: number;
  readonly expectedAssignmentRevision?: number;
  readonly profileId?: string;
  readonly participation?: AssignmentParticipation;
  readonly roomResponsibility?: string;
  readonly capabilitySubset?: readonly string[];
  readonly toolSubset?: readonly string[];
}

export interface CurrentAssignmentPolicyFacts {
  readonly revision: number;
  readonly participation: AssignmentParticipation;
  readonly roomResponsibility: string;
  readonly paused: boolean;
  readonly capabilitySubset: readonly string[];
  readonly toolSubset: readonly string[];
}

export interface AssignmentMutationAuthority {
  readonly authenticatedActorKind: "human" | "agent";
  readonly roomRole: "owner" | "admin" | "member" | null;
  readonly roomStatus: "active" | "archived";
  readonly roomRevision: number;
  readonly profileStatus: "enabled" | "disabled";
  readonly capabilityCeiling: readonly string[];
  readonly toolCeiling: readonly string[];
  readonly currentAssignment: CurrentAssignmentPolicyFacts | null;
}

export type AssignmentMutationDenial =
  | "forbidden"
  | "room_revision_conflict"
  | "assignment_revision_conflict"
  | "assignment_exists"
  | "assignment_not_found"
  | "profile_disabled"
  | "profile_ceiling_exceeded"
  | "archived_expansion_forbidden";

export type AssignmentMutationDecision = Readonly<{
  allowed: true;
  securityReduction: boolean;
}> | Readonly<{
  allowed: false;
  reason: AssignmentMutationDenial;
}>;

export interface AssignmentAvailabilityFacts {
  readonly profileEnabled: boolean;
  readonly assignmentCurrent: boolean;
  readonly roomActive: boolean;
  readonly membershipCurrent: boolean;
  readonly durablePaused: boolean;
  readonly providerAuthenticated: boolean;
  readonly durableRunningExecutionCount: number;
}

export type AssignmentAvailabilityProjection = Readonly<{
  eligible: false;
}> | Readonly<{
  eligible: true;
  availability: AssignmentAvailability;
}>;

export interface AssignmentExecutionGateInput extends AssignmentAvailabilityFacts {
  readonly stage: "intent-admission" | "execution";
  readonly participation: AssignmentParticipation;
  readonly origin: "direct" | "routed" | "project-boundary";
  readonly profileCapabilities: readonly string[];
  readonly assignmentCapabilities: readonly string[];
  readonly membershipCapabilities: readonly string[];
  readonly profileTools: readonly string[];
  readonly assignmentTools: readonly string[];
  readonly membershipTools: readonly string[];
}

export type AssignmentExecutionGate = Readonly<{
  allowed: false;
  effectiveCapabilities: readonly [];
  effectiveTools: readonly [];
}> | Readonly<{
  allowed: true;
  admission: "start" | "queue";
  effectiveCapabilities: readonly string[];
  effectiveTools: readonly string[];
}>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveRevision(value: unknown): value is number {
  return revision(value) && value > 0;
}

function canonicalSet(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length &&
    value.every((entry, index) => index === 0 || value[index - 1]!.localeCompare(entry) < 0);
}

function subset(left: readonly string[], right: readonly string[]): boolean {
  const ceiling = new Set(right);
  return left.every((entry) => ceiling.has(entry));
}

function intersection(...sets: readonly (readonly string[])[]): readonly string[] {
  if (sets.length === 0) return Object.freeze([]);
  const [first, ...rest] = sets;
  return Object.freeze((first ?? []).filter((entry) => rest.every((set) => set.includes(entry))));
}

function requestKeys(value: UnknownRecord): readonly string[] | undefined {
  const common = ["kind", "requestId", "roomId", "expectedRoomRevision"];
  if (value.kind === "create") {
    return [...common, "profileId", "participation", "roomResponsibility", "capabilitySubset", "toolSubset"];
  }
  if (value.kind === "update") {
    return [...common, "expectedAssignmentRevision", "participation", "roomResponsibility", "capabilitySubset", "toolSubset"];
  }
  if (value.kind === "pause" || value.kind === "resume" || value.kind === "remove") {
    return [...common, "expectedAssignmentRevision"];
  }
  return undefined;
}

export function isAssignmentMutationRequest(value: unknown): value is AssignmentMutationRequest {
  if (!record(value)) return false;
  const keys = requestKeys(value);
  if (keys === undefined || !exact(value, keys) || !text(value.requestId) ||
      !text(value.roomId) || !revision(value.expectedRoomRevision)) return false;
  if (value.kind === "create" || value.kind === "update") {
    if (!text(value.roomResponsibility) || value.roomResponsibility.length > 4_000 ||
        (value.participation !== "active" && value.participation !== "on-mention") ||
        !canonicalSet(value.capabilitySubset) || !canonicalSet(value.toolSubset)) return false;
  }
  if (value.kind === "create") return text(value.profileId);
  return positiveRevision(value.expectedAssignmentRevision);
}

function deny(reason: AssignmentMutationDenial): AssignmentMutationDecision {
  return Object.freeze({ allowed: false as const, reason });
}

export function evaluateAssignmentMutation(
  request: AssignmentMutationRequest,
  authority: AssignmentMutationAuthority,
): AssignmentMutationDecision {
  if (authority.authenticatedActorKind !== "human" ||
      (authority.roomRole !== "owner" && authority.roomRole !== "admin")) return deny("forbidden");
  if (authority.roomRevision !== request.expectedRoomRevision) return deny("room_revision_conflict");
  const current = authority.currentAssignment;
  if (request.kind === "create") {
    if (current !== null) return deny("assignment_exists");
    if (authority.roomStatus === "archived") return deny("archived_expansion_forbidden");
    if (authority.profileStatus !== "enabled") return deny("profile_disabled");
    if (!subset(request.capabilitySubset ?? [], authority.capabilityCeiling) ||
        !subset(request.toolSubset ?? [], authority.toolCeiling)) return deny("profile_ceiling_exceeded");
    return Object.freeze({ allowed: true as const, securityReduction: false });
  }
  if (current === null) return deny("assignment_not_found");
  if (current.revision !== request.expectedAssignmentRevision) return deny("assignment_revision_conflict");
  if (request.kind === "pause" || request.kind === "remove") {
    return Object.freeze({ allowed: true as const, securityReduction: true });
  }
  if (request.kind === "resume") {
    if (authority.roomStatus === "archived") return deny("archived_expansion_forbidden");
    if (authority.profileStatus !== "enabled") return deny("profile_disabled");
    return Object.freeze({ allowed: true as const, securityReduction: false });
  }
  const capabilities = request.capabilitySubset ?? [];
  const tools = request.toolSubset ?? [];
  if (!subset(capabilities, authority.capabilityCeiling) ||
      !subset(tools, authority.toolCeiling)) return deny("profile_ceiling_exceeded");
  const participationReduced = current.participation === "active" &&
    request.participation === "on-mention";
  const participationExpanded = current.participation === "on-mention" &&
    request.participation === "active";
  const isReduction = subset(capabilities, current.capabilitySubset) &&
    subset(tools, current.toolSubset) && !participationExpanded &&
    request.roomResponsibility === current.roomResponsibility;
  const isStrictReduction = isReduction && (participationReduced ||
    capabilities.length < current.capabilitySubset.length || tools.length < current.toolSubset.length);
  if (authority.roomStatus === "archived" && !isStrictReduction) {
    return deny("archived_expansion_forbidden");
  }
  return Object.freeze({
    allowed: true as const,
    securityReduction: isStrictReduction,
  });
}

export function deriveAssignmentAvailability(
  facts: AssignmentAvailabilityFacts,
): AssignmentAvailabilityProjection {
  if (!Number.isSafeInteger(facts.durableRunningExecutionCount) ||
      facts.durableRunningExecutionCount < 0) throw new TypeError("Running execution count is invalid");
  if (!facts.profileEnabled || !facts.assignmentCurrent || !facts.roomActive ||
      !facts.membershipCurrent) return Object.freeze({ eligible: false as const });
  if (facts.durablePaused) return Object.freeze({ eligible: true as const, availability: "paused" as const });
  if (!facts.providerAuthenticated) return Object.freeze({ eligible: true as const, availability: "noauth" as const });
  if (facts.durableRunningExecutionCount > 0) {
    return Object.freeze({ eligible: true as const, availability: "busy" as const });
  }
  return Object.freeze({ eligible: true as const, availability: "ready" as const });
}

export function evaluateAssignmentExecutionGate(
  input: AssignmentExecutionGateInput,
): AssignmentExecutionGate {
  const availability = deriveAssignmentAvailability(input);
  const originAllowsParticipation = input.origin === "direct" || input.participation === "active";
  const availabilityAllowsOrigin = availability.eligible &&
    (availability.availability === "ready" ||
      (input.stage === "intent-admission" && input.origin === "direct" &&
        availability.availability === "busy"));
  if (!availabilityAllowsOrigin || !originAllowsParticipation) {
    return Object.freeze({
      allowed: false as const,
      effectiveCapabilities: Object.freeze([]) as readonly [],
      effectiveTools: Object.freeze([]) as readonly [],
    });
  }
  return Object.freeze({
    allowed: true as const,
    admission: availability.availability === "busy" ? "queue" as const : "start" as const,
    effectiveCapabilities: intersection(
      input.profileCapabilities,
      input.assignmentCapabilities,
      input.membershipCapabilities,
    ),
    effectiveTools: intersection(input.profileTools, input.assignmentTools, input.membershipTools),
  });
}
