import {
  isDepartureConflict,
  type DepartureConflict,
} from "@native-im/core";

export const AUTHORITY_PARTICIPANT_VERSION = 1 as const;

export const AUTHORITY_PARTICIPANT_FEATURES = [
  "departure-responsibility",
  "pending-confirmation-departure",
  "archived-message-gate",
  "business-timer-suspension",
  "archive-settlement",
  "runtime-archive-fence",
  "assignment-security-reduction",
  "lifecycle-repair",
  "room-cache-invalidation",
  "offline-lease-invalidation",
] as const;

export const AUTHORITY_TRANSACTION_PARTICIPANT_FEATURES = [
  "departure-responsibility",
  "pending-confirmation-departure",
  "archived-message-gate",
  "business-timer-suspension",
  "archive-settlement",
  "runtime-archive-fence",
  "assignment-security-reduction",
] as const;

export const AUTHORITY_ACCESS_INVALIDATION_FEATURES = [
  "room-cache-invalidation",
  "offline-lease-invalidation",
] as const;

export type AuthorityParticipantFeature = typeof AUTHORITY_PARTICIPANT_FEATURES[number];
export type AuthorityTransactionParticipantFeature =
  typeof AUTHORITY_TRANSACTION_PARTICIPANT_FEATURES[number];
export type AuthorityAccessInvalidationFeature =
  typeof AUTHORITY_ACCESS_INVALIDATION_FEATURES[number];

export type FeatureEnablementManifest = Readonly<
  Record<AuthorityParticipantFeature, boolean>
>;

declare const authorityTransactionViewBrand: unique symbol;

export interface AuthorityTransactionView {
  readonly roomId: string;
  readonly transactionId: string;
  readonly [authorityTransactionViewBrand]: true;
}

const mintedTransactionViews = new WeakSet<object>();

export function mintAuthorityTransactionView(
  roomId: string,
  transactionId: string,
): AuthorityTransactionView {
  if (!isNonEmptyString(roomId) || !isNonEmptyString(transactionId)) {
    throw new TypeError("Authority transaction identity is invalid");
  }
  const view = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(view, {
    roomId: { value: roomId, enumerable: false },
    transactionId: { value: transactionId, enumerable: false },
  });
  Object.freeze(view);
  mintedTransactionViews.add(view);
  return view as unknown as AuthorityTransactionView;
}

export function isAuthorityTransactionView(value: unknown): value is AuthorityTransactionView {
  return isRecord(value) && mintedTransactionViews.has(value);
}

export type AuthorityParticipantFailureReason =
  | "invalid_manifest"
  | "malformed_registration"
  | "missing_registration"
  | "duplicate_registration_id"
  | "duplicate_feature_registration"
  | "version_mismatch"
  | "manifest_mismatch"
  | "transaction_mismatch"
  | "participant_threw"
  | "malformed_result"
  | "cross_room_result";

export interface AuthorityParticipantSafeError {
  readonly httpStatus: 503;
  readonly code: "dependency_unavailable";
  readonly dependency: AuthorityParticipantFeature;
  readonly reason: AuthorityParticipantFailureReason;
  readonly retryable: true;
}

export type AuthorityParticipantEnvelope<TResult> =
  | Readonly<{ readonly ok: true; readonly result: TResult }>
  | Readonly<{ readonly ok: false; readonly error: AuthorityParticipantSafeError }>;

export interface DepartureContributionResult {
  readonly roomId: string;
  readonly targetHumanActorId: string;
  readonly conflicts: readonly DepartureConflict[];
}

export interface ArchivedMessageGateResult {
  readonly roomId: string;
  readonly archiveGeneration: number;
  readonly gateGeneration: number;
  readonly blockedMutationKinds: readonly ("message" | "message_intent")[];
}

export interface BusinessTimerSuspensionResult {
  readonly roomId: string;
  readonly archiveGeneration: number;
  readonly action: "suspended" | "resumed";
  readonly affectedCount: number;
  readonly timerDescriptorIds: readonly string[];
}

export interface ArchiveSettlementResult {
  readonly roomId: string;
  readonly archiveGeneration: number;
  readonly rejectedPendingCount: number;
  readonly revokedGrantCount: number;
  readonly fencedWaitingCount: number;
  readonly preservedDispatchedCount: number;
}

export interface RuntimeArchiveFenceResult {
  readonly roomId: string;
  readonly archiveGeneration: number;
  readonly fencedQueuedCount: number;
  readonly fencedWaitingCount: number;
  readonly preservedDispatchedCount: number;
  readonly preservedOutcomeReviewCount: number;
}

export interface AssignmentSecurityReductionResult {
  readonly roomId: string;
  readonly archiveGeneration: number;
  readonly policyVersion: number;
  readonly assignmentRevision: number;
  readonly businessWakeUpCount: 0;
}

export interface LifecycleRepairDescriptorResult {
  readonly roomId: string;
  readonly lifecycleGeneration: number;
  readonly descriptorId: string;
  readonly descriptorVersion: number;
  readonly sortKey: string;
  readonly recordCount: number;
}

export interface RoomCacheInvalidationResult {
  readonly roomId: string;
  readonly lifecycleGeneration: number;
  readonly invalidationIntentId: string;
  readonly accessRevision: number;
}

export interface OfflineLeaseInvalidationResult {
  readonly roomId: string;
  readonly lifecycleGeneration: number;
  readonly leaseGeneration: number;
  readonly revokedLeaseCount: number;
  readonly maxOfflineReadLeaseMs: number;
}

export interface DepartureResponsibilityContributor {
  listInTransaction(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; targetHumanActorId: string }>,
  ): AuthorityParticipantEnvelope<DepartureContributionResult>;
}

export interface PendingConfirmationDepartureContributor {
  listPendingConfirmationsInTransaction(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; targetHumanActorId: string }>,
  ): AuthorityParticipantEnvelope<DepartureContributionResult>;
}

export interface ArchivedMessageGate {
  blockForArchive(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; archiveGeneration: number }>,
  ): AuthorityParticipantEnvelope<ArchivedMessageGateResult>;
}

export interface BusinessTimerSuspensionParticipant {
  suspendForArchive(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; archiveGeneration: number; archivedAt: string }>,
  ): AuthorityParticipantEnvelope<BusinessTimerSuspensionResult>;
  resumeAfterReopen(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; archiveGeneration: number; reopenedAt: string }>,
  ): AuthorityParticipantEnvelope<BusinessTimerSuspensionResult>;
}

export interface ArchiveSettlementParticipant {
  settleUndispatched(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
  ): AuthorityParticipantEnvelope<ArchiveSettlementResult>;
}

export interface RuntimeArchiveFenceParticipant {
  fenceForArchive(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
  ): AuthorityParticipantEnvelope<RuntimeArchiveFenceResult>;
}

export interface AssignmentSecurityReductionParticipant {
  reduceForArchive(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; archiveGeneration: number; now: string }>,
  ): AuthorityParticipantEnvelope<AssignmentSecurityReductionResult>;
}

export interface LifecycleRepairDescriptor {
  describeLifecycleInTransaction(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; lifecycleGeneration: number }>,
  ): AuthorityParticipantEnvelope<LifecycleRepairDescriptorResult>;
}

export interface RoomCacheInvalidationPort {
  invalidateRoomCacheInTransaction(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; lifecycleGeneration: number; reason: "room_archived" }>,
  ): AuthorityParticipantEnvelope<RoomCacheInvalidationResult>;
}

export interface OfflineLeaseInvalidationPort {
  invalidateOfflineLeasesInTransaction(
    tx: AuthorityTransactionView,
    input: Readonly<{ roomId: string; lifecycleGeneration: number; reason: "room_archived" }>,
  ): AuthorityParticipantEnvelope<OfflineLeaseInvalidationResult>;
}

export interface AuthorityParticipantByFeature {
  readonly "departure-responsibility": DepartureResponsibilityContributor;
  readonly "pending-confirmation-departure": PendingConfirmationDepartureContributor;
  readonly "archived-message-gate": ArchivedMessageGate;
  readonly "business-timer-suspension": BusinessTimerSuspensionParticipant;
  readonly "archive-settlement": ArchiveSettlementParticipant;
  readonly "runtime-archive-fence": RuntimeArchiveFenceParticipant;
  readonly "assignment-security-reduction": AssignmentSecurityReductionParticipant;
  readonly "lifecycle-repair": LifecycleRepairDescriptor;
  readonly "room-cache-invalidation": RoomCacheInvalidationPort;
  readonly "offline-lease-invalidation": OfflineLeaseInvalidationPort;
}

export interface AuthorityParticipantResultByFeature {
  readonly "departure-responsibility": DepartureContributionResult;
  readonly "pending-confirmation-departure": DepartureContributionResult;
  readonly "archived-message-gate": ArchivedMessageGateResult;
  readonly "business-timer-suspension": BusinessTimerSuspensionResult;
  readonly "archive-settlement": ArchiveSettlementResult;
  readonly "runtime-archive-fence": RuntimeArchiveFenceResult;
  readonly "assignment-security-reduction": AssignmentSecurityReductionResult;
  readonly "lifecycle-repair": LifecycleRepairDescriptorResult;
  readonly "room-cache-invalidation": RoomCacheInvalidationResult;
  readonly "offline-lease-invalidation": OfflineLeaseInvalidationResult;
}

export interface ParticipantRegistration<
  TParticipant = AuthorityParticipantByFeature[AuthorityParticipantFeature],
> {
  readonly registrationId: string;
  readonly feature: AuthorityParticipantFeature;
  readonly version: 1;
  readonly enabled: boolean;
  readonly participant?: TParticipant;
}

const featureSet = new Set<string>(AUTHORITY_PARTICIPANT_FEATURES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isUniqueStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length;
}

export function isAuthorityParticipantFeature(
  value: unknown,
): value is AuthorityParticipantFeature {
  return typeof value === "string" && featureSet.has(value);
}

export function isFeatureEnablementManifest(
  value: unknown,
): value is FeatureEnablementManifest {
  return isRecord(value) && hasExactKeys(value, AUTHORITY_PARTICIPANT_FEATURES) &&
    AUTHORITY_PARTICIPANT_FEATURES.every((feature) => typeof value[feature] === "boolean");
}

function isParticipantForFeature(
  feature: AuthorityParticipantFeature,
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  const methods: Record<AuthorityParticipantFeature, readonly string[]> = {
    "departure-responsibility": ["listInTransaction"],
    "pending-confirmation-departure": ["listPendingConfirmationsInTransaction"],
    "archived-message-gate": ["blockForArchive"],
    "business-timer-suspension": ["suspendForArchive", "resumeAfterReopen"],
    "archive-settlement": ["settleUndispatched"],
    "runtime-archive-fence": ["fenceForArchive"],
    "assignment-security-reduction": ["reduceForArchive"],
    "lifecycle-repair": ["describeLifecycleInTransaction"],
    "room-cache-invalidation": ["invalidateRoomCacheInTransaction"],
    "offline-lease-invalidation": ["invalidateOfflineLeasesInTransaction"],
  };
  const expected = methods[feature];
  return hasExactKeys(value, expected) && expected.every((method) => typeof value[method] === "function");
}

export function isParticipantRegistration(
  value: unknown,
): value is ParticipantRegistration {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["registrationId", "feature", "version", "enabled"],
    ["participant"],
  ) || !isNonEmptyString(value.registrationId) || !isAuthorityParticipantFeature(value.feature) ||
    value.version !== AUTHORITY_PARTICIPANT_VERSION || typeof value.enabled !== "boolean") {
    return false;
  }
  if (!value.enabled) return value.participant === undefined;
  return isParticipantForFeature(value.feature, value.participant);
}

function isSafeError(value: unknown): value is AuthorityParticipantSafeError {
  return isRecord(value) && hasExactKeys(
    value,
    ["httpStatus", "code", "dependency", "reason", "retryable"],
  ) && value.httpStatus === 503 && value.code === "dependency_unavailable" &&
    isAuthorityParticipantFeature(value.dependency) && value.retryable === true &&
    [
      "invalid_manifest", "malformed_registration", "missing_registration",
      "duplicate_registration_id", "duplicate_feature_registration", "version_mismatch",
      "manifest_mismatch", "transaction_mismatch", "participant_threw",
      "malformed_result", "cross_room_result",
    ].includes(value.reason as string);
}

function isDepartureResult(value: unknown): value is DepartureContributionResult {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["roomId", "targetHumanActorId", "conflicts"],
  ) || !isNonEmptyString(value.roomId) || !isNonEmptyString(value.targetHumanActorId) ||
    !Array.isArray(value.conflicts) || !value.conflicts.every((conflict) =>
      isDepartureConflict(conflict) && conflict.roomId === value.roomId)) return false;
  const conflictIds = value.conflicts.map((conflict) => conflict.conflictId);
  return new Set(conflictIds).size === conflictIds.length;
}

function isArchivedMessageGateResult(value: unknown): value is ArchivedMessageGateResult {
  return isRecord(value) && hasExactKeys(
    value,
    ["roomId", "archiveGeneration", "gateGeneration", "blockedMutationKinds"],
  ) && isNonEmptyString(value.roomId) && isNonNegativeInteger(value.archiveGeneration) &&
    isNonNegativeInteger(value.gateGeneration) && Array.isArray(value.blockedMutationKinds) &&
    value.blockedMutationKinds.length === 2 &&
    new Set(value.blockedMutationKinds).size === 2 &&
    value.blockedMutationKinds.every((kind) => kind === "message" || kind === "message_intent");
}

function isBusinessTimerResult(value: unknown): value is BusinessTimerSuspensionResult {
  return isRecord(value) && hasExactKeys(
    value,
    ["roomId", "archiveGeneration", "action", "affectedCount", "timerDescriptorIds"],
  ) && isNonEmptyString(value.roomId) && isNonNegativeInteger(value.archiveGeneration) &&
    (value.action === "suspended" || value.action === "resumed") &&
    isNonNegativeInteger(value.affectedCount) && isUniqueStrings(value.timerDescriptorIds);
}

function hasRoomGenerationAndCounts(
  value: unknown,
  countKeys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(
    value,
    ["roomId", "archiveGeneration", ...countKeys],
  ) && isNonEmptyString(value.roomId) && isNonNegativeInteger(value.archiveGeneration) &&
    countKeys.every((key) => isNonNegativeInteger(value[key]));
}

function isArchiveSettlementResult(value: unknown): value is ArchiveSettlementResult {
  return hasRoomGenerationAndCounts(value, [
    "rejectedPendingCount", "revokedGrantCount", "fencedWaitingCount",
    "preservedDispatchedCount",
  ]);
}

function isRuntimeArchiveFenceResult(value: unknown): value is RuntimeArchiveFenceResult {
  return hasRoomGenerationAndCounts(value, [
    "fencedQueuedCount", "fencedWaitingCount", "preservedDispatchedCount",
    "preservedOutcomeReviewCount",
  ]);
}

function isAssignmentSecurityReductionResult(
  value: unknown,
): value is AssignmentSecurityReductionResult {
  return isRecord(value) && hasExactKeys(
    value,
    [
      "roomId", "archiveGeneration", "policyVersion", "assignmentRevision",
      "businessWakeUpCount",
    ],
  ) && isNonEmptyString(value.roomId) && isNonNegativeInteger(value.archiveGeneration) &&
    isPositiveInteger(value.policyVersion) && isNonNegativeInteger(value.assignmentRevision) &&
    value.businessWakeUpCount === 0;
}

function isLifecycleRepairDescriptorResult(
  value: unknown,
): value is LifecycleRepairDescriptorResult {
  return isRecord(value) && hasExactKeys(
    value,
    [
      "roomId", "lifecycleGeneration", "descriptorId", "descriptorVersion", "sortKey",
      "recordCount",
    ],
  ) && isNonEmptyString(value.roomId) && isNonNegativeInteger(value.lifecycleGeneration) &&
    isNonEmptyString(value.descriptorId) && isPositiveInteger(value.descriptorVersion) &&
    isNonEmptyString(value.sortKey) && isNonNegativeInteger(value.recordCount);
}

function isRoomCacheInvalidationResult(value: unknown): value is RoomCacheInvalidationResult {
  return isRecord(value) && hasExactKeys(
    value,
    ["roomId", "lifecycleGeneration", "invalidationIntentId", "accessRevision"],
  ) && isNonEmptyString(value.roomId) && isNonNegativeInteger(value.lifecycleGeneration) &&
    isNonEmptyString(value.invalidationIntentId) && isNonNegativeInteger(value.accessRevision);
}

function isOfflineLeaseInvalidationResult(
  value: unknown,
): value is OfflineLeaseInvalidationResult {
  return isRecord(value) && hasExactKeys(
    value,
    [
      "roomId", "lifecycleGeneration", "leaseGeneration", "revokedLeaseCount",
      "maxOfflineReadLeaseMs",
    ],
  ) && isNonEmptyString(value.roomId) && isNonNegativeInteger(value.lifecycleGeneration) &&
    isNonNegativeInteger(value.leaseGeneration) && isNonNegativeInteger(value.revokedLeaseCount) &&
    isPositiveInteger(value.maxOfflineReadLeaseMs);
}

export function isAuthorityParticipantResult<
  TFeature extends AuthorityParticipantFeature,
>(
  feature: TFeature,
  value: unknown,
): value is AuthorityParticipantResultByFeature[TFeature] {
  const guards: Record<AuthorityParticipantFeature, (candidate: unknown) => boolean> = {
    "departure-responsibility": isDepartureResult,
    "pending-confirmation-departure": isDepartureResult,
    "archived-message-gate": isArchivedMessageGateResult,
    "business-timer-suspension": isBusinessTimerResult,
    "archive-settlement": isArchiveSettlementResult,
    "runtime-archive-fence": isRuntimeArchiveFenceResult,
    "assignment-security-reduction": isAssignmentSecurityReductionResult,
    "lifecycle-repair": isLifecycleRepairDescriptorResult,
    "room-cache-invalidation": isRoomCacheInvalidationResult,
    "offline-lease-invalidation": isOfflineLeaseInvalidationResult,
  };
  return guards[feature](value);
}

export function isAuthorityParticipantEnvelope<
  TFeature extends AuthorityParticipantFeature,
>(
  feature: TFeature,
  value: unknown,
  expectedRoomId: string,
): value is AuthorityParticipantEnvelope<AuthorityParticipantResultByFeature[TFeature]> {
  if (!isRecord(value)) return false;
  if (value.ok === false) {
    return hasExactKeys(value, ["ok", "error"]) && isSafeError(value.error) &&
      value.error.dependency === feature;
  }
  return value.ok === true && hasExactKeys(value, ["ok", "result"]) &&
    isAuthorityParticipantResult(feature, value.result) && value.result.roomId === expectedRoomId;
}

export function readParticipantResultRoomId(value: unknown): string | undefined {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) return undefined;
  return isNonEmptyString(value.result.roomId) ? value.result.roomId : undefined;
}
