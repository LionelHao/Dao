export const EXTERNAL_TOOL_IDS = [
  "http-json.read",
  "repository.git-status",
  "sandbox-file.write",
] as const;

export type ToolId = typeof EXTERNAL_TOOL_IDS[number];

export const INTERNAL_TOOL_SEAM_IDS = [
  "room-memory.read",
  "attachment.read",
  "project.query",
  "project.command",
] as const;

export type InternalToolSeamId = typeof INTERNAL_TOOL_SEAM_IDS[number];

export type ExternalToolDescriptor =
  | Readonly<{
      scope: "external";
      id: "http-json.read" | "repository.git-status";
      effect: "read-only";
      reversibility?: never;
    }>
  | Readonly<{
      scope: "external";
      id: "sandbox-file.write";
      effect: "side-effect";
      reversibility: "compensatable";
    }>;

export type InternalToolSeamDescriptor =
  | Readonly<{
      scope: "internal";
      id: "room-memory.read" | "attachment.read";
      kind: "source-read";
    }>
  | Readonly<{
      scope: "internal";
      id: "project.query";
      kind: "project-query";
    }>
  | Readonly<{
      scope: "internal";
      id: "project.command";
      kind: "project-command";
    }>;

export const TOOL_CANONICALIZER_VERSION = "rfc8785-profile.v1" as const;

export interface ToolCallBinding {
  readonly scope: "internal";
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly executionVersion: number;
  readonly roomId: string;
  readonly agentId: string;
  readonly toolId: ToolId;
  readonly canonicalParameterSha256: string;
  readonly parameterSchemaVersion: string;
  readonly canonicalizerVersion: typeof TOOL_CANONICALIZER_VERSION;
  readonly sourceSnapshotId: string;
  readonly profileRevision: number;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
}

export interface ConfirmationBinding extends ToolCallBinding {
  readonly principalActorId: string;
  readonly sessionFamilyId: string;
  readonly bindingGeneration: number;
  readonly expiresAt: string;
}

interface ConfirmationRecordBase {
  readonly scope: "internal";
  readonly confirmationId: string;
  readonly toolCallId: string;
  readonly version: number;
  readonly bindingGeneration: number;
}

export type ToolConfirmationRecord =
  | Readonly<ConfirmationRecordBase & {
      state: "pending";
      decidedByActorId?: never;
      decidedAt?: never;
      reason?: never;
    }>
  | Readonly<ConfirmationRecordBase & {
      state: "confirmed";
      decidedByActorId: string;
      decidedAt: string;
      reason?: never;
    }>
  | Readonly<ConfirmationRecordBase & {
      state: "rejected";
      decidedByActorId: string;
      decidedAt: string;
      reason: "human_rejected" | "room_archived" | "source_recalled" |
        "params_changed" | "principal_revoked" | "legacy_unbound";
    }>
  | Readonly<ConfirmationRecordBase & {
      state: "expired";
      decidedByActorId?: never;
      decidedAt: string;
      reason: "confirmation_expired";
    }>;

interface GrantRecordBase {
  readonly scope: "internal";
  readonly grantId: string;
  readonly toolCallId: string;
  readonly version: number;
}

export type ToolGrantRecord =
  | Readonly<GrantRecordBase & {
      state: "active";
      expiresAt: string;
      dispatchId?: never;
      claimedAt?: never;
      closedAt?: never;
      reason?: never;
    }>
  | Readonly<GrantRecordBase & {
      state: "claimed";
      dispatchId: string;
      claimedAt: string;
      expiresAt?: never;
      closedAt?: never;
      reason?: never;
    }>
  | Readonly<GrantRecordBase & {
      state: "revoked";
      closedAt: string;
      reason: "permission_reduced" | "room_archived" | "execution_cancelled" |
        "source_recalled" | "shutdown" | "legacy_unbound";
      expiresAt?: never;
      dispatchId?: never;
      claimedAt?: never;
    }>
  | Readonly<GrantRecordBase & {
      state: "expired";
      closedAt: string;
      reason: "grant_expired";
      expiresAt?: never;
      dispatchId?: never;
      claimedAt?: never;
    }>;

interface DispatchRecordBase {
  readonly scope: "internal";
  readonly dispatchId: string;
  readonly grantId: string;
  readonly toolCallId: string;
  readonly version: number;
}

export type ToolDispatchState =
  | "prepared" | "claimed" | "dispatched" | "known_succeeded" | "known_failed"
  | "outcome_unknown" | "reviewed";

export type ToolDispatchRecord =
  | Readonly<DispatchRecordBase & { state: "prepared"; occurredAt: string }>
  | Readonly<DispatchRecordBase & { state: "claimed"; occurredAt: string }>
  | Readonly<DispatchRecordBase & { state: "dispatched"; occurredAt: string }>
  | Readonly<DispatchRecordBase & {
      state: "known_succeeded" | "known_failed";
      occurredAt: string;
      outcomeSummarySha256: string;
    }>
  | Readonly<DispatchRecordBase & {
      state: "outcome_unknown";
      occurredAt: string;
      reason: "claim_committed" | "adapter_ambiguous" | "shutdown" | "legacy_needs_review";
    }>
  | Readonly<DispatchRecordBase & {
      state: "reviewed";
      occurredAt: string;
      reviewId: string;
    }>;

export type ToolReviewResolution =
  | "known_succeeded" | "known_failed" | "compensated" | "accepted_risk";

export interface ToolReviewRecord {
  readonly scope: "internal";
  readonly reviewId: string;
  readonly dispatchId: string;
  readonly version: number;
  readonly resolution: ToolReviewResolution;
  readonly reviewedByActorId: string;
  readonly reviewedAt: string;
  readonly evidenceSummarySha256: string;
  readonly compensationInvocationId?: string;
  readonly compensationToolCallId?: string;
}

export interface SafeToolPreview {
  readonly schemaVersion: "tool-safe-preview.v1";
  readonly target: string;
  readonly summary: string;
  readonly impact: string;
  readonly reversibility: "none" | "compensatable" | "unknown";
}

/** Safe display-only surface. It is deliberately not an authority record. */
export interface PublicToolSafetyProjection {
  readonly scope: "public";
  readonly toolCallId: string;
  readonly state: ToolConfirmationRecord["state"] | ToolGrantRecord["state"] |
    ToolDispatchState;
  readonly version: number;
  readonly safePreview: SafeToolPreview;
}

type UnknownRecord = Record<string, unknown>;

const externalIds = new Set<string>(EXTERNAL_TOOL_IDS);
const internalIds = new Set<string>(INTERNAL_TOOL_SEAM_IDS);

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value === value.trim() && value.normalize("NFC") === value;
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function isExternalToolId(value: unknown): value is ToolId {
  return typeof value === "string" && externalIds.has(value);
}

export function isExternalToolDescriptor(value: unknown): value is ExternalToolDescriptor {
  if (!record(value) || value.scope !== "external" || !isExternalToolId(value.id)) return false;
  if (value.id === "sandbox-file.write") {
    return exact(value, ["scope", "id", "effect", "reversibility"]) &&
      value.effect === "side-effect" && value.reversibility === "compensatable";
  }
  return exact(value, ["scope", "id", "effect"]) && value.effect === "read-only";
}

export function assertExternalToolCatalog(
  descriptors: readonly ExternalToolDescriptor[],
): readonly ExternalToolDescriptor[] {
  if (descriptors.length !== EXTERNAL_TOOL_IDS.length) {
    throw new TypeError("Physical tool catalog must contain exactly three adapters");
  }
  const byId = new Map<ToolId, ExternalToolDescriptor>();
  for (const descriptor of descriptors) {
    if (!isExternalToolDescriptor(descriptor) || byId.has(descriptor.id)) {
      throw new TypeError("Physical tool catalog contained an invalid or duplicate adapter");
    }
    byId.set(descriptor.id, descriptor);
  }
  if (EXTERNAL_TOOL_IDS.some((toolId) => !byId.has(toolId))) {
    throw new TypeError("Physical tool catalog omitted a required adapter");
  }
  return Object.freeze(EXTERNAL_TOOL_IDS.map((toolId) => byId.get(toolId)!));
}

export function isInternalToolSeamDescriptor(value: unknown): value is InternalToolSeamDescriptor {
  if (!record(value) || !exact(value, ["scope", "id", "kind"]) ||
      value.scope !== "internal" || typeof value.id !== "string" || !internalIds.has(value.id)) return false;
  if (value.id === "room-memory.read" || value.id === "attachment.read") return value.kind === "source-read";
  if (value.id === "project.query") return value.kind === "project-query";
  return value.id === "project.command" && value.kind === "project-command";
}

export function isToolConfirmationRecord(value: unknown): value is ToolConfirmationRecord {
  if (!record(value) || value.scope !== "internal" || !id(value.confirmationId) ||
      !id(value.toolCallId) || !revision(value.version) || !revision(value.bindingGeneration)) return false;
  const base = ["scope", "confirmationId", "toolCallId", "state", "version", "bindingGeneration"];
  switch (value.state) {
    case "pending": return exact(value, base);
    case "confirmed": return exact(value, [...base, "decidedByActorId", "decidedAt"]) &&
      id(value.decidedByActorId) && timestamp(value.decidedAt);
    case "rejected": return exact(value, [...base, "decidedByActorId", "decidedAt", "reason"]) &&
      id(value.decidedByActorId) && timestamp(value.decidedAt) &&
      ["human_rejected", "room_archived", "source_recalled", "params_changed",
        "principal_revoked", "legacy_unbound"].includes(String(value.reason));
    case "expired": return exact(value, [...base, "decidedAt", "reason"]) &&
      timestamp(value.decidedAt) && value.reason === "confirmation_expired";
    default: return false;
  }
}

export function isToolGrantRecord(value: unknown): value is ToolGrantRecord {
  if (!record(value) || value.scope !== "internal" || !id(value.grantId) ||
      !id(value.toolCallId) || !revision(value.version)) return false;
  const base = ["scope", "grantId", "toolCallId", "state", "version"];
  switch (value.state) {
    case "active": return exact(value, [...base, "expiresAt"]) && timestamp(value.expiresAt);
    case "claimed": return exact(value, [...base, "dispatchId", "claimedAt"]) &&
      id(value.dispatchId) && timestamp(value.claimedAt);
    case "revoked": return exact(value, [...base, "closedAt", "reason"]) && timestamp(value.closedAt) &&
      ["permission_reduced", "room_archived", "execution_cancelled", "source_recalled",
        "shutdown", "legacy_unbound"].includes(String(value.reason));
    case "expired": return exact(value, [...base, "closedAt", "reason"]) &&
      timestamp(value.closedAt) && value.reason === "grant_expired";
    default: return false;
  }
}

export function isToolDispatchRecord(value: unknown): value is ToolDispatchRecord {
  if (!record(value) || value.scope !== "internal" || !id(value.dispatchId) ||
      !id(value.grantId) || !id(value.toolCallId) || !revision(value.version)) return false;
  const base = ["scope", "dispatchId", "grantId", "toolCallId", "state", "version", "occurredAt"];
  if (!timestamp(value.occurredAt)) return false;
  switch (value.state) {
    case "prepared":
    case "claimed":
    case "dispatched": return exact(value, base);
    case "known_succeeded":
    case "known_failed": return exact(value, [...base, "outcomeSummarySha256"]) &&
      sha256(value.outcomeSummarySha256);
    case "outcome_unknown": return exact(value, [...base, "reason"]) &&
      ["claim_committed", "adapter_ambiguous", "shutdown", "legacy_needs_review"]
        .includes(String(value.reason));
    case "reviewed": return exact(value, [...base, "reviewId"]) && id(value.reviewId);
    default: return false;
  }
}

export function isToolReviewRecord(value: unknown): value is ToolReviewRecord {
  if (!record(value) || !exact(value, [
    "scope", "reviewId", "dispatchId", "version", "resolution", "reviewedByActorId",
    "reviewedAt", "evidenceSummarySha256",
  ], ["compensationInvocationId", "compensationToolCallId"]) || value.scope !== "internal" ||
      !id(value.reviewId) || !id(value.dispatchId) || !revision(value.version) ||
      !["known_succeeded", "known_failed", "compensated", "accepted_risk"].includes(String(value.resolution)) ||
      !id(value.reviewedByActorId) || !timestamp(value.reviewedAt) || !sha256(value.evidenceSummarySha256)) return false;
  if (value.resolution === "compensated") {
    return id(value.compensationInvocationId) && id(value.compensationToolCallId);
  }
  return value.compensationInvocationId === undefined && value.compensationToolCallId === undefined;
}

/** An original physical toolCall is never a generic retry unit once prepared. */
export function isOriginalToolCallRetryEligible(record: ToolDispatchRecord): false {
  void record;
  return false;
}
