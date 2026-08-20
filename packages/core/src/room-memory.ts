export const ROOM_MEMORY_LIMITS = Object.freeze({
  identifierUtf16: 256,
  cursorUtf16: 2_048,
  derivedTextUtf8: 4_096,
  safeMetadataUtf8: 4_096,
  reasonUtf8: 2_048,
  errorMessageUtf8: 1_024,
  versionSourceRefs: 64,
  disputeChainEntries: 64,
  rawDeltaEntriesPerPage: 64,
  rawDeltaMetadataUtf8PerPage: 256 * 1_024,
  queryItemsPerPage: 50,
  retryAfterSeconds: 86_400,
});

export type RoomMemoryKind =
  | "goal"
  | "decision"
  | "context"
  | "next_action"
  | "open_question_or_blocker";

export type RoomMemoryNonContextKind = Exclude<RoomMemoryKind, "context">;

export type RoomMemorySourceKind =
  | "message"
  | "message_revision"
  | "message_tombstone"
  | "attachment_extraction"
  | "project_fact_checkpoint";

export type RoomMemorySourceEligibility =
  | "eligible"
  | "excluded_recalled"
  | "excluded_revised"
  | "excluded_revoked"
  | "excluded_unbound"
  | "excluded_unsafe"
  | "unavailable";

export type RoomMemorySourceAvailability =
  | "readable"
  | "tombstone"
  | "metadata_only"
  | "temporarily_unavailable";

export type RoomMemoryVersionState =
  | "proposal"
  | "active"
  | "disputed"
  | "review_required"
  | "resolved"
  | "superseded"
  | "invalidated";

export type RoomMemoryHealthState =
  | "healthy"
  | "catching_up"
  | "noauth"
  | "degraded"
  | "failed";

export type RoomMemoryHealthReason =
  | "none"
  | "backlog"
  | "provider_secret_missing"
  | "provider_timeout_exhausted"
  | "provider_rate_limited_exhausted"
  | "provider_dependency_unavailable"
  | "invalid_provider_output"
  | "provider_output_oversized"
  | "attempt_dead_lettered"
  | "storage_invariant_broken"
  | "checkpoint_discontinuity"
  | "source_invariant_broken";

export type RoomMemorySourceIdentity = Readonly<{
  sourceKind: RoomMemorySourceKind;
  sourceId: string;
  sourceRevision: number;
}>;

export type RoomMemorySourceMetadata = Readonly<{
  speakerActorId: string | null;
  speakerKind: "human" | "agent" | null;
  provenance: string | null;
}>;

export type RoomMemoryAuthorizedReadRef = Readonly<{
  sourceKind: RoomMemorySourceKind;
  opaqueId: string;
}>;

export type RoomMemorySource = RoomMemorySourceIdentity & Readonly<{
  roomId: string;
  corpusSeq: number;
  serverStreamSeq: number;
  occurredAt: string;
  eligibility: RoomMemorySourceEligibility;
  availability: RoomMemorySourceAvailability;
  metadata: RoomMemorySourceMetadata;
  authorizedReadRef: RoomMemoryAuthorizedReadRef;
}>;

export type RoomMemoryVersionSourceRef = RoomMemorySourceIdentity & Readonly<{
  eligibility: RoomMemorySourceEligibility;
  availability: RoomMemorySourceAvailability;
}>;

export type RoomMemoryVersion = Readonly<{
  roomId: string;
  memoryRecordId: string;
  memoryVersionId: string;
  version: number;
  kind: RoomMemoryKind;
  state: RoomMemoryVersionState;
  derivedText: string;
  sourceRefs: readonly RoomMemoryVersionSourceRef[];
  createdAt: string;
  replacesMemoryVersionId: string | null;
}>;

export type RoomMemoryDispute = Readonly<{
  disputeId: string;
  roomId: string;
  memoryRecordId: string;
  memoryVersionId: string;
  operatorActorId: string;
  reason: string;
  status: "open" | "resolved";
  createdAt: string;
}>;

export type RoomMemoryResolutionAction = "resolve" | "re_evaluate";

export type RoomMemoryResolution = Readonly<{
  resolutionId: string;
  disputeId: string;
  roomId: string;
  memoryRecordId: string;
  fromMemoryVersionId: string;
  replacementMemoryVersionId: string;
  operatorActorId: string;
  action: RoomMemoryResolutionAction;
  reason: string;
  resolvedAt: string;
}>;

export type RoomMemoryVersionProjection = Readonly<{
  projectionKind: "memory";
  roomId: string;
  memoryRecordId: string;
  kind: RoomMemoryKind;
  currentVersion: RoomMemoryVersion;
  disputes: readonly RoomMemoryDispute[];
  resolutions: readonly RoomMemoryResolution[];
}>;

export type RoomMemoryConfirmedProjectReference = Readonly<{
  projectionKind: "confirmed-project-reference";
  roomId: string;
  memoryRecordId: string;
  kind: RoomMemoryNonContextKind;
  projectFactId: string;
  projectFactVersion: number;
  derivedText: string;
  confirmedByActorId: string;
  confirmedAt: string;
  sourceRefs: readonly RoomMemoryVersionSourceRef[];
}>;

export type RoomMemoryProjection =
  | RoomMemoryVersionProjection
  | RoomMemoryConfirmedProjectReference;

export type RoomMemoryHealth = Readonly<{
  state: RoomMemoryHealthState;
  reason: RoomMemoryHealthReason;
  memoryWatermark: number;
  corpusHead: number;
  lag: number;
  lastAttemptAt: string | null;
  retryable: boolean;
  recoveryRequired: boolean;
}>;

export type RoomMemoryStatus = Readonly<{
  roomId: string;
  health: RoomMemoryHealth;
  recoveryGeneration: number;
  updatedAt: string;
}>;

export type RoomMemoryRawDeltaPage = Readonly<{
  roomId: string;
  fromWatermarkExclusive: number;
  toCorpusSeqInclusive: number;
  authorizationEpoch: number;
  cursor: string | null;
  entries: readonly RoomMemorySource[];
  nextCursor: string | null;
  hasMore: boolean;
}>;

export type RoomMemorySourceNavigation =
  | Readonly<{ kind: "message"; messageId: string }>
  | Readonly<{ kind: "tombstone"; messageId: string }>
  | Readonly<{ kind: "attachment"; attachmentId: string }>
  | Readonly<{ kind: "project_fact"; projectFactId: string }>;

export type RoomMemorySourceView = RoomMemorySourceIdentity & Readonly<{
  roomId: string;
  corpusSeq: number;
  occurredAt: string;
  eligibility: RoomMemorySourceEligibility;
  availability: RoomMemorySourceAvailability;
  metadata: RoomMemorySourceMetadata;
  navigation: RoomMemorySourceNavigation;
}>;

type RoomMemoryPublicAuthorityForbidden = Readonly<{
  actorId?: never;
  principal?: never;
  session?: never;
  sessionFamilyId?: never;
  stewardId?: never;
  memoryWatermark?: never;
  eligibility?: never;
  sourceRevision?: never;
  provider?: never;
  providerMetadata?: never;
}>;

type RoomMemoryPublicMutationAuthorityForbidden = RoomMemoryPublicAuthorityForbidden & Readonly<{
  kind?: never;
  state?: never;
  active?: never;
  confirmed?: never;
  confirmedByActorId?: never;
}>;

export type RoomMemoryQueryRequest = RoomMemoryPublicAuthorityForbidden & Readonly<{
  type: "room.memory.query.v1";
  requestId: string;
  roomId: string;
  cursor?: string | null;
  limit?: number;
  kind?: RoomMemoryKind;
  state?: RoomMemoryVersionState;
}>;

export type RoomMemorySourceQueryRequest = RoomMemoryPublicAuthorityForbidden & Readonly<{
  type: "room.memory.source.query.v1";
  requestId: string;
  roomId: string;
  sourceId: string;
}>;

export type RoomMemoryContextDisputeRequest =
  RoomMemoryPublicMutationAuthorityForbidden & Readonly<{
    type: "room.memory.context.dispute.v1";
    requestId: string;
    roomId: string;
    memoryRecordId: string;
    expectedVersion: number;
    reason: string;
  }>;

export type RoomMemoryContextResolveRequest =
  RoomMemoryPublicMutationAuthorityForbidden & Readonly<{
    type: "room.memory.context.resolve.v1";
    requestId: string;
    roomId: string;
    memoryRecordId: string;
    expectedVersion: number;
    resolution: RoomMemoryResolutionAction;
    reason: string;
  }>;

export type RoomMemoryStatusQueryRequest = RoomMemoryPublicAuthorityForbidden & Readonly<{
  type: "room.memory.status.query.v1";
  requestId: string;
  roomId: string;
}>;

export type RoomMemoryRetryRequest = RoomMemoryPublicMutationAuthorityForbidden & Readonly<{
  type: "room.memory.retry.v1";
  requestId: string;
  roomId: string;
  expectedRecoveryGeneration: number;
}>;

export type RoomMemoryRequest =
  | RoomMemoryQueryRequest
  | RoomMemorySourceQueryRequest
  | RoomMemoryContextDisputeRequest
  | RoomMemoryContextResolveRequest
  | RoomMemoryStatusQueryRequest
  | RoomMemoryRetryRequest;

export type RoomMemoryPageFrame = Readonly<{
  type: "room.memory.page.v1";
  requestId: string;
  roomId: string;
  items: readonly RoomMemoryProjection[];
  nextCursor: string | null;
  status: RoomMemoryStatus;
}>;

export type RoomMemorySourceFrame = Readonly<{
  type: "room.memory.source.v1";
  requestId: string;
  roomId: string;
  source: RoomMemorySourceView;
}>;

export type RoomMemoryContextDisputeAccepted = Readonly<{
  type: "room.memory.context.dispute.accepted.v1";
  requestId: string;
  roomId: string;
  dispute: RoomMemoryDispute;
  projection: RoomMemoryVersionProjection;
}>;

export type RoomMemoryContextResolveAccepted = Readonly<{
  type: "room.memory.context.resolve.accepted.v1";
  requestId: string;
  roomId: string;
  resolution: RoomMemoryResolution;
  projection: RoomMemoryVersionProjection;
}>;

export type RoomMemoryStatusFrame = Readonly<{
  type: "room.memory.status.v1";
  requestId: string;
  roomId: string;
  status: RoomMemoryStatus;
}>;

export type RoomMemoryRetryAccepted = Readonly<{
  type: "room.memory.retry.accepted.v1";
  requestId: string;
  roomId: string;
  recoveryGeneration: number;
  acceptedAt: string;
}>;

export type RoomMemoryErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503;

export type RoomMemoryErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "room_forbidden"
  | "room_not_found"
  | "memory_not_found"
  | "memory_source_not_found"
  | "memory_version_conflict"
  | "memory_recovery_generation_conflict"
  | "room_archived"
  | "memory_source_gone"
  | "protocol_upgrade_required"
  | "memory_capacity_limited"
  | "memory_unavailable"
  | "memory_dependency_unavailable"
  | "repair_barrier_active";

export type RoomMemoryError = Readonly<{
  type: "error";
  status: RoomMemoryErrorStatus;
  code: RoomMemoryErrorCode;
  message: string;
  requestId?: string;
  objectId: string | null;
  retryable: boolean;
  retryAfterSeconds?: number;
}>;

export type RoomMemorySuccessFrame =
  | RoomMemoryPageFrame
  | RoomMemorySourceFrame
  | RoomMemoryContextDisputeAccepted
  | RoomMemoryContextResolveAccepted
  | RoomMemoryStatusFrame
  | RoomMemoryRetryAccepted;

export type RoomMemoryProtocolFrame =
  | RoomMemoryRequest
  | RoomMemorySuccessFrame
  | RoomMemoryError;

type RoomMemoryEventEnvelope<TType extends string, TPayload> = Readonly<{
  eventId: string;
  streamKind: "room";
  streamId: string;
  streamSeq: number;
  roomId: string;
  actorId: string;
  occurredAt: string;
  type: TType;
  payload: TPayload;
}>;

export type RoomMemoryVersionChangedPayload = Readonly<{
  memoryRecordId: string;
  memoryVersionId: string;
  kind: RoomMemoryKind;
  state: RoomMemoryVersionState;
  sourceIds: readonly string[];
  memoryWatermark: number;
}>;

export type RoomMemoryEvent =
  | RoomMemoryEventEnvelope<"room.memory.version.changed", RoomMemoryVersionChangedPayload>
  | RoomMemoryEventEnvelope<"room.memory.health.changed", RoomMemoryStatus>;

export type RoomMemoryRepairValue =
  | Readonly<{ recordType: "projection"; projection: RoomMemoryProjection }>
  | Readonly<{ recordType: "status"; status: RoomMemoryStatus }>;

export type RoomMemoryRepairRecord = Readonly<{
  kind: "memory";
  roomId: string;
  value: RoomMemoryRepairValue;
}>;

type UnknownRecord = Record<string, unknown>;

const memoryKinds = new Set<RoomMemoryKind>([
  "goal",
  "decision",
  "context",
  "next_action",
  "open_question_or_blocker",
]);
const sourceKinds = new Set<RoomMemorySourceKind>([
  "message",
  "message_revision",
  "message_tombstone",
  "attachment_extraction",
  "project_fact_checkpoint",
]);
const sourceEligibility = new Set<RoomMemorySourceEligibility>([
  "eligible",
  "excluded_recalled",
  "excluded_revised",
  "excluded_revoked",
  "excluded_unbound",
  "excluded_unsafe",
  "unavailable",
]);
const sourceAvailability = new Set<RoomMemorySourceAvailability>([
  "readable",
  "tombstone",
  "metadata_only",
  "temporarily_unavailable",
]);
const versionStates = new Set<RoomMemoryVersionState>([
  "proposal",
  "active",
  "disputed",
  "review_required",
  "resolved",
  "superseded",
  "invalidated",
]);
const contextStates = new Set<RoomMemoryVersionState>([
  "active",
  "disputed",
  "review_required",
  "resolved",
  "superseded",
  "invalidated",
]);
const nonContextStates = new Set<RoomMemoryVersionState>([
  "proposal",
  "review_required",
  "superseded",
  "invalidated",
]);
const degradedReasons = new Set<RoomMemoryHealthReason>([
  "provider_timeout_exhausted",
  "provider_rate_limited_exhausted",
  "provider_dependency_unavailable",
  "invalid_provider_output",
  "provider_output_oversized",
  "attempt_dead_lettered",
]);
const failedReasons = new Set<RoomMemoryHealthReason>([
  "storage_invariant_broken",
  "checkpoint_discontinuity",
  "source_invariant_broken",
]);
const canonicalUtcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const stableIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const arrayIndex = /^(0|[1-9]\d*)$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function isClosedArray(value: unknown, maximumLength: number): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) return false;
  if (!Reflect.ownKeys(value).every((key) => {
    if (key === "length") return true;
    return typeof key === "string" && arrayIndex.test(key) && Number(key) < value.length;
  })) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedText(
  value: unknown,
  maximumUtf8: number,
  options: Readonly<{ allowEmpty?: boolean; trim?: boolean }> = {},
): value is string {
  if (typeof value !== "string" || !hasWellFormedUnicode(value) ||
      utf8Length(value) > maximumUtf8) return false;
  if (!options.allowEmpty && value.length === 0) return false;
  return options.trim === false || value === value.trim();
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= ROOM_MEMORY_LIMITS.identifierUtf16 &&
    stableIdentifier.test(value);
}

function isCursor(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > ROOM_MEMORY_LIMITS.cursorUtf16 || !hasWellFormedUnicode(value)) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !canonicalUtcTimestamp.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isSourceKind(value: unknown): value is RoomMemorySourceKind {
  return typeof value === "string" && sourceKinds.has(value as RoomMemorySourceKind);
}

function isSourceEligibility(value: unknown): value is RoomMemorySourceEligibility {
  return typeof value === "string" && sourceEligibility.has(value as RoomMemorySourceEligibility);
}

function isSourceAvailability(value: unknown): value is RoomMemorySourceAvailability {
  return typeof value === "string" && sourceAvailability.has(value as RoomMemorySourceAvailability);
}

function isVersionState(value: unknown): value is RoomMemoryVersionState {
  return typeof value === "string" && versionStates.has(value as RoomMemoryVersionState);
}

function sourceIdMatchesKind(kind: RoomMemorySourceKind, sourceId: string): boolean {
  switch (kind) {
    case "message": return sourceId.startsWith("message:");
    case "message_revision": return sourceId.startsWith("message-revision:");
    case "message_tombstone": return sourceId.startsWith("message-tombstone:");
    case "attachment_extraction": return sourceId.startsWith("attachment-extraction:");
    case "project_fact_checkpoint": return sourceId.startsWith("project-fact:");
  }
}

function sourceIdentityKey(value: RoomMemorySourceIdentity): string {
  return `${value.sourceKind}\u0000${value.sourceId}\u0000${value.sourceRevision}`;
}

export function isRoomMemoryKind(value: unknown): value is RoomMemoryKind {
  return typeof value === "string" && memoryKinds.has(value as RoomMemoryKind);
}

export function isRoomMemorySourceIdentity(value: unknown): value is RoomMemorySourceIdentity {
  return isRecord(value) && hasExactKeys(value, ["sourceKind", "sourceId", "sourceRevision"]) &&
    isSourceKind(value.sourceKind) && isIdentifier(value.sourceId) &&
    sourceIdMatchesKind(value.sourceKind, value.sourceId) &&
    isPositiveSafeInteger(value.sourceRevision);
}

function isRoomMemorySourceMetadata(value: unknown): value is RoomMemorySourceMetadata {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["speakerActorId", "speakerKind", "provenance"],
  )) return false;
  const speakerPairValid =
    (value.speakerActorId === null && value.speakerKind === null) ||
    (isIdentifier(value.speakerActorId) &&
      (value.speakerKind === "human" || value.speakerKind === "agent"));
  return speakerPairValid &&
    (value.provenance === null || isBoundedText(
      value.provenance,
      ROOM_MEMORY_LIMITS.safeMetadataUtf8,
    ));
}

function isAuthorizedReadRef(
  value: unknown,
  source: RoomMemorySourceIdentity,
): value is RoomMemoryAuthorizedReadRef {
  return isRecord(value) && hasExactKeys(value, ["sourceKind", "opaqueId"]) &&
    value.sourceKind === source.sourceKind && isIdentifier(value.opaqueId);
}

function isValidEligibilityAvailability(
  kind: RoomMemorySourceKind,
  eligibility: RoomMemorySourceEligibility,
  availability: RoomMemorySourceAvailability,
): boolean {
  if (kind === "message_tombstone") {
    return availability === "tombstone" &&
      (eligibility === "eligible" || eligibility === "excluded_recalled");
  }
  if (availability === "tombstone") return false;
  if (eligibility === "eligible") return availability === "readable";
  return true;
}

export function isRoomMemorySource(value: unknown): value is RoomMemorySource {
  if (!isRecord(value) || !hasExactKeys(value, [
    "roomId",
    "corpusSeq",
    "sourceKind",
    "sourceId",
    "sourceRevision",
    "serverStreamSeq",
    "occurredAt",
    "eligibility",
    "availability",
    "metadata",
    "authorizedReadRef",
  ]) || !isIdentifier(value.roomId) || !isPositiveSafeInteger(value.corpusSeq) ||
      !isPositiveSafeInteger(value.serverStreamSeq) || !isIsoUtcTimestamp(value.occurredAt) ||
      !isSourceEligibility(value.eligibility) || !isSourceAvailability(value.availability) ||
      !isRoomMemorySourceMetadata(value.metadata)) return false;
  const identity = {
    sourceKind: value.sourceKind,
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
  };
  return isRoomMemorySourceIdentity(identity) &&
    isValidEligibilityAvailability(identity.sourceKind, value.eligibility, value.availability) &&
    isAuthorizedReadRef(value.authorizedReadRef, identity);
}

function isRoomMemoryVersionSourceRef(value: unknown): value is RoomMemoryVersionSourceRef {
  if (!isRecord(value) || !hasExactKeys(value, [
    "sourceKind", "sourceId", "sourceRevision", "eligibility", "availability",
  ]) || !isSourceEligibility(value.eligibility) || !isSourceAvailability(value.availability)) {
    return false;
  }
  const identity = {
    sourceKind: value.sourceKind,
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
  };
  return isRoomMemorySourceIdentity(identity) &&
    isValidEligibilityAvailability(identity.sourceKind, value.eligibility, value.availability);
}

function hasValidVersionState(kind: RoomMemoryKind, state: RoomMemoryVersionState): boolean {
  return kind === "context" ? contextStates.has(state) : nonContextStates.has(state);
}

export function isRoomMemoryVersion(value: unknown): value is RoomMemoryVersion {
  if (!isRecord(value) || !hasExactKeys(value, [
    "roomId",
    "memoryRecordId",
    "memoryVersionId",
    "version",
    "kind",
    "state",
    "derivedText",
    "sourceRefs",
    "createdAt",
    "replacesMemoryVersionId",
  ]) || !isIdentifier(value.roomId) || !isIdentifier(value.memoryRecordId) ||
      !isIdentifier(value.memoryVersionId) || !isPositiveSafeInteger(value.version) ||
      !isRoomMemoryKind(value.kind) || !isVersionState(value.state) ||
      !hasValidVersionState(value.kind, value.state) ||
      !isBoundedText(value.derivedText, ROOM_MEMORY_LIMITS.derivedTextUtf8) ||
      !isClosedArray(value.sourceRefs, ROOM_MEMORY_LIMITS.versionSourceRefs) ||
      value.sourceRefs.length === 0 || !isIsoUtcTimestamp(value.createdAt) ||
      !(value.replacesMemoryVersionId === null || isIdentifier(value.replacesMemoryVersionId)) ||
      value.replacesMemoryVersionId === value.memoryVersionId) return false;
  const identities = new Set<string>();
  return value.sourceRefs.every((sourceRef) => {
    if (!isRoomMemoryVersionSourceRef(sourceRef)) return false;
    const key = sourceIdentityKey(sourceRef);
    if (identities.has(key)) return false;
    identities.add(key);
    return true;
  });
}

export function isRoomMemoryDispute(value: unknown): value is RoomMemoryDispute {
  return isRecord(value) && hasExactKeys(value, [
    "disputeId",
    "roomId",
    "memoryRecordId",
    "memoryVersionId",
    "operatorActorId",
    "reason",
    "status",
    "createdAt",
  ]) && isIdentifier(value.disputeId) && isIdentifier(value.roomId) &&
    isIdentifier(value.memoryRecordId) && isIdentifier(value.memoryVersionId) &&
    isIdentifier(value.operatorActorId) &&
    isBoundedText(value.reason, ROOM_MEMORY_LIMITS.reasonUtf8) &&
    (value.status === "open" || value.status === "resolved") &&
    isIsoUtcTimestamp(value.createdAt);
}

export function isRoomMemoryResolution(value: unknown): value is RoomMemoryResolution {
  return isRecord(value) && hasExactKeys(value, [
    "resolutionId",
    "disputeId",
    "roomId",
    "memoryRecordId",
    "fromMemoryVersionId",
    "replacementMemoryVersionId",
    "operatorActorId",
    "action",
    "reason",
    "resolvedAt",
  ]) && isIdentifier(value.resolutionId) && isIdentifier(value.disputeId) &&
    isIdentifier(value.roomId) && isIdentifier(value.memoryRecordId) &&
    isIdentifier(value.fromMemoryVersionId) && isIdentifier(value.replacementMemoryVersionId) &&
    value.fromMemoryVersionId !== value.replacementMemoryVersionId &&
    isIdentifier(value.operatorActorId) &&
    (value.action === "resolve" || value.action === "re_evaluate") &&
    isBoundedText(value.reason, ROOM_MEMORY_LIMITS.reasonUtf8) &&
    isIsoUtcTimestamp(value.resolvedAt);
}

function isVersionProjection(value: unknown): value is RoomMemoryVersionProjection {
  if (!isRecord(value) || !hasExactKeys(value, [
    "projectionKind",
    "roomId",
    "memoryRecordId",
    "kind",
    "currentVersion",
    "disputes",
    "resolutions",
  ]) || value.projectionKind !== "memory" || !isIdentifier(value.roomId) ||
      !isIdentifier(value.memoryRecordId) || !isRoomMemoryKind(value.kind) ||
      !isRoomMemoryVersion(value.currentVersion) ||
      value.currentVersion.roomId !== value.roomId ||
      value.currentVersion.memoryRecordId !== value.memoryRecordId ||
      value.currentVersion.kind !== value.kind ||
      !isClosedArray(value.disputes, ROOM_MEMORY_LIMITS.disputeChainEntries) ||
      !isClosedArray(value.resolutions, ROOM_MEMORY_LIMITS.disputeChainEntries)) return false;

  const disputeIds = new Set<string>();
  const disputesById = new Map<string, RoomMemoryDispute>();
  let openDisputes = 0;
  for (const candidate of value.disputes) {
    if (!isRoomMemoryDispute(candidate) || candidate.roomId !== value.roomId ||
        candidate.memoryRecordId !== value.memoryRecordId || disputeIds.has(candidate.disputeId)) {
      return false;
    }
    disputeIds.add(candidate.disputeId);
    disputesById.set(candidate.disputeId, candidate);
    if (candidate.status === "open") {
      if (candidate.memoryVersionId !== value.currentVersion.memoryVersionId) return false;
      openDisputes += 1;
    }
  }
  if ((value.currentVersion.state === "disputed") !== (openDisputes > 0)) return false;

  const resolutionIds = new Set<string>();
  const resolvedDisputeIds = new Set<string>();
  for (const candidate of value.resolutions) {
    const resolvedDispute = isRoomMemoryResolution(candidate)
      ? disputesById.get(candidate.disputeId)
      : undefined;
    if (!isRoomMemoryResolution(candidate) || candidate.roomId !== value.roomId ||
        candidate.memoryRecordId !== value.memoryRecordId ||
        resolutionIds.has(candidate.resolutionId) || resolvedDispute?.status !== "resolved" ||
        resolvedDisputeIds.has(candidate.disputeId)) {
      return false;
    }
    resolutionIds.add(candidate.resolutionId);
    resolvedDisputeIds.add(candidate.disputeId);
  }
  return value.disputes.every((candidate) =>
    isRoomMemoryDispute(candidate) &&
    (candidate.status === "open" || resolvedDisputeIds.has(candidate.disputeId)));
}

function isConfirmedProjectReference(
  value: unknown,
): value is RoomMemoryConfirmedProjectReference {
  if (!isRecord(value) || !hasExactKeys(value, [
    "projectionKind",
    "roomId",
    "memoryRecordId",
    "kind",
    "projectFactId",
    "projectFactVersion",
    "derivedText",
    "confirmedByActorId",
    "confirmedAt",
    "sourceRefs",
  ]) || value.projectionKind !== "confirmed-project-reference" ||
      !isIdentifier(value.roomId) || !isIdentifier(value.memoryRecordId) ||
      !isRoomMemoryKind(value.kind) || value.kind === "context" ||
      !isIdentifier(value.projectFactId) || !isPositiveSafeInteger(value.projectFactVersion) ||
      !isBoundedText(value.derivedText, ROOM_MEMORY_LIMITS.derivedTextUtf8) ||
      !isIdentifier(value.confirmedByActorId) || !isIsoUtcTimestamp(value.confirmedAt) ||
      !isClosedArray(value.sourceRefs, ROOM_MEMORY_LIMITS.versionSourceRefs) ||
      value.sourceRefs.length === 0) return false;
  const identities = new Set<string>();
  return value.sourceRefs.every((sourceRef) => {
    if (!isRoomMemoryVersionSourceRef(sourceRef)) return false;
    const key = sourceIdentityKey(sourceRef);
    if (identities.has(key)) return false;
    identities.add(key);
    return true;
  });
}

export function isRoomMemoryProjection(value: unknown): value is RoomMemoryProjection {
  return isVersionProjection(value) || isConfirmedProjectReference(value);
}

export function isRoomMemoryHealth(value: unknown): value is RoomMemoryHealth {
  if (!isRecord(value) || !hasExactKeys(value, [
    "state",
    "reason",
    "memoryWatermark",
    "corpusHead",
    "lag",
    "lastAttemptAt",
    "retryable",
    "recoveryRequired",
  ]) || !isNonnegativeSafeInteger(value.memoryWatermark) ||
      !isNonnegativeSafeInteger(value.corpusHead) ||
      !isNonnegativeSafeInteger(value.lag) || value.memoryWatermark > value.corpusHead ||
      value.lag !== value.corpusHead - value.memoryWatermark ||
      !(value.lastAttemptAt === null || isIsoUtcTimestamp(value.lastAttemptAt)) ||
      typeof value.retryable !== "boolean" || typeof value.recoveryRequired !== "boolean") {
    return false;
  }
  switch (value.state) {
    case "healthy":
      return value.reason === "none" && value.lag === 0 &&
        value.retryable === false && value.recoveryRequired === false;
    case "catching_up":
      return value.reason === "backlog" && value.lag > 0 && value.recoveryRequired === false;
    case "noauth":
      return value.reason === "provider_secret_missing" && value.recoveryRequired === false;
    case "degraded":
      return typeof value.reason === "string" &&
        degradedReasons.has(value.reason as RoomMemoryHealthReason) &&
        value.recoveryRequired === false;
    case "failed":
      return typeof value.reason === "string" &&
        failedReasons.has(value.reason as RoomMemoryHealthReason) && value.recoveryRequired === true;
    default:
      return false;
  }
}

export function isRoomMemoryStatus(value: unknown): value is RoomMemoryStatus {
  return isRecord(value) && hasExactKeys(value, [
    "roomId", "health", "recoveryGeneration", "updatedAt",
  ]) && isIdentifier(value.roomId) && isRoomMemoryHealth(value.health) &&
    isNonnegativeSafeInteger(value.recoveryGeneration) && isIsoUtcTimestamp(value.updatedAt);
}

export function isRoomMemoryRawDeltaPage(value: unknown): value is RoomMemoryRawDeltaPage {
  if (!isRecord(value) || !hasExactKeys(value, [
    "roomId",
    "fromWatermarkExclusive",
    "toCorpusSeqInclusive",
    "authorizationEpoch",
    "cursor",
    "entries",
    "nextCursor",
    "hasMore",
  ]) || !isIdentifier(value.roomId) ||
      !isNonnegativeSafeInteger(value.fromWatermarkExclusive) ||
      !isNonnegativeSafeInteger(value.toCorpusSeqInclusive) ||
      value.toCorpusSeqInclusive < value.fromWatermarkExclusive ||
      !isNonnegativeSafeInteger(value.authorizationEpoch) ||
      !(value.cursor === null || isCursor(value.cursor)) ||
      !isClosedArray(value.entries, ROOM_MEMORY_LIMITS.rawDeltaEntriesPerPage) ||
      !(value.nextCursor === null || isCursor(value.nextCursor)) ||
      typeof value.hasMore !== "boolean" ||
      value.hasMore !== (value.nextCursor !== null)) return false;

  if ((value.toCorpusSeqInclusive === value.fromWatermarkExclusive) !==
      (value.entries.length === 0)) return false;
  let previousSeq = value.fromWatermarkExclusive;
  for (const entry of value.entries) {
    if (!isRoomMemorySource(entry) || entry.roomId !== value.roomId ||
        entry.corpusSeq <= previousSeq || entry.corpusSeq > value.toCorpusSeqInclusive) return false;
    previousSeq = entry.corpusSeq;
  }
  return utf8Length(JSON.stringify(value.entries)) <=
    ROOM_MEMORY_LIMITS.rawDeltaMetadataUtf8PerPage;
}

function isSourceNavigation(
  value: unknown,
  sourceKind: RoomMemorySourceKind,
): value is RoomMemorySourceNavigation {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (sourceKind === "message" || sourceKind === "message_revision") {
    return hasExactKeys(value, ["kind", "messageId"]) && value.kind === "message" &&
      isIdentifier(value.messageId);
  }
  if (sourceKind === "message_tombstone") {
    return hasExactKeys(value, ["kind", "messageId"]) && value.kind === "tombstone" &&
      isIdentifier(value.messageId);
  }
  if (sourceKind === "attachment_extraction") {
    return hasExactKeys(value, ["kind", "attachmentId"]) && value.kind === "attachment" &&
      isIdentifier(value.attachmentId);
  }
  return hasExactKeys(value, ["kind", "projectFactId"]) && value.kind === "project_fact" &&
    isIdentifier(value.projectFactId);
}

export function isRoomMemorySourceView(value: unknown): value is RoomMemorySourceView {
  if (!isRecord(value) || !hasExactKeys(value, [
    "roomId",
    "corpusSeq",
    "sourceKind",
    "sourceId",
    "sourceRevision",
    "occurredAt",
    "eligibility",
    "availability",
    "metadata",
    "navigation",
  ]) || !isIdentifier(value.roomId) || !isPositiveSafeInteger(value.corpusSeq) ||
      !isIsoUtcTimestamp(value.occurredAt) || !isSourceEligibility(value.eligibility) ||
      !isSourceAvailability(value.availability) || !isRoomMemorySourceMetadata(value.metadata)) {
    return false;
  }
  const identity = {
    sourceKind: value.sourceKind,
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
  };
  return isRoomMemorySourceIdentity(identity) &&
    isValidEligibilityAvailability(identity.sourceKind, value.eligibility, value.availability) &&
    isSourceNavigation(value.navigation, identity.sourceKind);
}

function isRequestBase(value: UnknownRecord): boolean {
  return isIdentifier(value.requestId) && isIdentifier(value.roomId);
}

export function isRoomMemoryRequest(value: unknown): value is RoomMemoryRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "room.memory.query.v1":
      return hasExactKeys(value, ["type", "requestId", "roomId"], [
        "cursor", "limit", "kind", "state",
      ]) && isRequestBase(value) &&
        (value.cursor === undefined || value.cursor === null || isCursor(value.cursor)) &&
        (value.limit === undefined ||
          (isPositiveSafeInteger(value.limit) && value.limit <= ROOM_MEMORY_LIMITS.queryItemsPerPage)) &&
        (value.kind === undefined || isRoomMemoryKind(value.kind)) &&
        (value.state === undefined || isVersionState(value.state));
    case "room.memory.source.query.v1":
      return hasExactKeys(value, ["type", "requestId", "roomId", "sourceId"]) &&
        isRequestBase(value) && isIdentifier(value.sourceId);
    case "room.memory.context.dispute.v1":
      return hasExactKeys(value, [
        "type", "requestId", "roomId", "memoryRecordId", "expectedVersion", "reason",
      ]) && isRequestBase(value) && isIdentifier(value.memoryRecordId) &&
        isPositiveSafeInteger(value.expectedVersion) &&
        isBoundedText(value.reason, ROOM_MEMORY_LIMITS.reasonUtf8);
    case "room.memory.context.resolve.v1":
      return hasExactKeys(value, [
        "type",
        "requestId",
        "roomId",
        "memoryRecordId",
        "expectedVersion",
        "resolution",
        "reason",
      ]) && isRequestBase(value) && isIdentifier(value.memoryRecordId) &&
        isPositiveSafeInteger(value.expectedVersion) &&
        (value.resolution === "resolve" || value.resolution === "re_evaluate") &&
        isBoundedText(value.reason, ROOM_MEMORY_LIMITS.reasonUtf8);
    case "room.memory.status.query.v1":
      return hasExactKeys(value, ["type", "requestId", "roomId"]) && isRequestBase(value);
    case "room.memory.retry.v1":
      return hasExactKeys(value, [
        "type", "requestId", "roomId", "expectedRecoveryGeneration",
      ]) && isRequestBase(value) && isNonnegativeSafeInteger(value.expectedRecoveryGeneration);
    default:
      return false;
  }
}

function isPageFrame(value: UnknownRecord): value is UnknownRecord & RoomMemoryPageFrame {
  if (!hasExactKeys(value, [
    "type", "requestId", "roomId", "items", "nextCursor", "status",
  ]) || value.type !== "room.memory.page.v1" || !isRequestBase(value) ||
      !isClosedArray(value.items, ROOM_MEMORY_LIMITS.queryItemsPerPage) ||
      !(value.nextCursor === null || isCursor(value.nextCursor)) ||
      !isRoomMemoryStatus(value.status) || value.status.roomId !== value.roomId) return false;
  const keys = new Set<string>();
  return value.items.every((item) => {
    if (!isRoomMemoryProjection(item) || item.roomId !== value.roomId) return false;
    const key = `${item.projectionKind}\u0000${item.memoryRecordId}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function isSourceFrame(value: UnknownRecord): value is UnknownRecord & RoomMemorySourceFrame {
  return hasExactKeys(value, ["type", "requestId", "roomId", "source"]) &&
    value.type === "room.memory.source.v1" && isRequestBase(value) &&
    isRoomMemorySourceView(value.source) && value.source.roomId === value.roomId;
}

function isDisputeAccepted(
  value: UnknownRecord,
): value is UnknownRecord & RoomMemoryContextDisputeAccepted {
  return hasExactKeys(value, [
    "type", "requestId", "roomId", "dispute", "projection",
  ]) && value.type === "room.memory.context.dispute.accepted.v1" && isRequestBase(value) &&
    isRoomMemoryDispute(value.dispute) && value.dispute.roomId === value.roomId &&
    isVersionProjection(value.projection) && value.projection.roomId === value.roomId &&
    value.projection.memoryRecordId === value.dispute.memoryRecordId &&
    value.projection.currentVersion.state === "disputed" &&
    value.projection.currentVersion.memoryVersionId === value.dispute.memoryVersionId &&
    value.dispute.status === "open" &&
    value.projection.disputes.some((candidate) =>
      candidate.disputeId === (value.dispute as RoomMemoryDispute).disputeId);
}

function isResolveAccepted(
  value: UnknownRecord,
): value is UnknownRecord & RoomMemoryContextResolveAccepted {
  return hasExactKeys(value, [
    "type", "requestId", "roomId", "resolution", "projection",
  ]) && value.type === "room.memory.context.resolve.accepted.v1" && isRequestBase(value) &&
    isRoomMemoryResolution(value.resolution) && value.resolution.roomId === value.roomId &&
    isVersionProjection(value.projection) && value.projection.roomId === value.roomId &&
    value.projection.memoryRecordId === value.resolution.memoryRecordId &&
    value.projection.currentVersion.memoryVersionId ===
      value.resolution.replacementMemoryVersionId &&
    value.projection.resolutions.some((candidate) =>
      candidate.resolutionId === (value.resolution as RoomMemoryResolution).resolutionId);
}

function isStatusFrame(value: UnknownRecord): value is UnknownRecord & RoomMemoryStatusFrame {
  return hasExactKeys(value, ["type", "requestId", "roomId", "status"]) &&
    value.type === "room.memory.status.v1" && isRequestBase(value) &&
    isRoomMemoryStatus(value.status) && value.status.roomId === value.roomId;
}

function isRetryAccepted(value: UnknownRecord): value is UnknownRecord & RoomMemoryRetryAccepted {
  return hasExactKeys(value, [
    "type", "requestId", "roomId", "recoveryGeneration", "acceptedAt",
  ]) && value.type === "room.memory.retry.accepted.v1" && isRequestBase(value) &&
    isNonnegativeSafeInteger(value.recoveryGeneration) && isIsoUtcTimestamp(value.acceptedAt);
}

const errorCodesByStatus: Readonly<Record<RoomMemoryErrorStatus, ReadonlySet<RoomMemoryErrorCode>>> = {
  400: new Set(["invalid_request"]),
  401: new Set(["unauthenticated"]),
  403: new Set(["room_forbidden"]),
  404: new Set(["room_not_found", "memory_not_found", "memory_source_not_found"]),
  409: new Set(["memory_version_conflict", "memory_recovery_generation_conflict"]),
  410: new Set(["room_archived", "memory_source_gone", "protocol_upgrade_required"]),
  429: new Set(["memory_capacity_limited"]),
  503: new Set([
    "memory_unavailable", "memory_dependency_unavailable", "repair_barrier_active",
  ]),
};

export function isRoomMemoryError(value: unknown): value is RoomMemoryError {
  if (!isRecord(value) || !hasExactKeys(value, [
    "type", "status", "code", "message", "objectId", "retryable",
  ], ["requestId", "retryAfterSeconds"]) || value.type !== "error" ||
      !isPositiveSafeInteger(value.status) ||
      !Object.hasOwn(errorCodesByStatus, value.status) || typeof value.code !== "string" ||
      !errorCodesByStatus[value.status as RoomMemoryErrorStatus].has(value.code as RoomMemoryErrorCode) ||
      !isBoundedText(value.message, ROOM_MEMORY_LIMITS.errorMessageUtf8) ||
      !(value.requestId === undefined || isIdentifier(value.requestId)) ||
      !(value.objectId === null || isIdentifier(value.objectId)) ||
      typeof value.retryable !== "boolean") return false;
  const hasRetryAfter = Object.hasOwn(value, "retryAfterSeconds");
  if (hasRetryAfter && (!isPositiveSafeInteger(value.retryAfterSeconds) ||
      value.retryAfterSeconds > ROOM_MEMORY_LIMITS.retryAfterSeconds)) return false;
  if (value.status === 429) return value.retryable && hasRetryAfter;
  return true;
}

export function isRoomMemoryProtocolFrame(value: unknown): value is RoomMemoryProtocolFrame {
  if (isRoomMemoryRequest(value) || isRoomMemoryError(value)) return true;
  if (!isRecord(value)) return false;
  return isPageFrame(value) || isSourceFrame(value) || isDisputeAccepted(value) ||
    isResolveAccepted(value) || isStatusFrame(value) || isRetryAccepted(value);
}

function isEventEnvelope(value: UnknownRecord): boolean {
  return isIdentifier(value.eventId) && value.streamKind === "room" &&
    isIdentifier(value.streamId) && isPositiveSafeInteger(value.streamSeq) &&
    isIdentifier(value.roomId) && value.streamId === value.roomId &&
    isIdentifier(value.actorId) && isIsoUtcTimestamp(value.occurredAt);
}

function isVersionChangedPayload(value: unknown): value is RoomMemoryVersionChangedPayload {
  if (!isRecord(value) || !hasExactKeys(value, [
    "memoryRecordId",
    "memoryVersionId",
    "kind",
    "state",
    "sourceIds",
    "memoryWatermark",
  ]) || !isIdentifier(value.memoryRecordId) || !isIdentifier(value.memoryVersionId) ||
      !isRoomMemoryKind(value.kind) || !isVersionState(value.state) ||
      !hasValidVersionState(value.kind, value.state) ||
      !isClosedArray(value.sourceIds, ROOM_MEMORY_LIMITS.versionSourceRefs) ||
      value.sourceIds.length === 0 || !isNonnegativeSafeInteger(value.memoryWatermark)) {
    return false;
  }
  const ids = new Set<string>();
  return value.sourceIds.every((sourceId) => {
    if (!isIdentifier(sourceId) || ids.has(sourceId)) return false;
    ids.add(sourceId);
    return true;
  });
}

export function isRoomMemoryEvent(value: unknown): value is RoomMemoryEvent {
  if (!isRecord(value) || !hasExactKeys(value, [
    "eventId",
    "streamKind",
    "streamId",
    "streamSeq",
    "roomId",
    "actorId",
    "occurredAt",
    "type",
    "payload",
  ]) || !isEventEnvelope(value)) return false;
  if (value.type === "room.memory.version.changed") {
    return isVersionChangedPayload(value.payload);
  }
  return value.type === "room.memory.health.changed" && isRoomMemoryStatus(value.payload) &&
    value.payload.roomId === value.roomId;
}

export function isRoomMemoryRepairRecord(
  value: unknown,
  expectedRoomId?: string,
): value is RoomMemoryRepairRecord {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "roomId", "value"]) ||
      value.kind !== "memory" || !isIdentifier(value.roomId) ||
      (expectedRoomId !== undefined && value.roomId !== expectedRoomId) || !isRecord(value.value)) {
    return false;
  }
  if (value.value.recordType === "projection") {
    return hasExactKeys(value.value, ["recordType", "projection"]) &&
      isRoomMemoryProjection(value.value.projection) &&
      value.value.projection.roomId === value.roomId;
  }
  return value.value.recordType === "status" &&
    hasExactKeys(value.value, ["recordType", "status"]) &&
    isRoomMemoryStatus(value.value.status) && value.value.status.roomId === value.roomId;
}
