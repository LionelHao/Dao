import {
  AUTHORITY_PARTICIPANT_VERSION,
  AUTHORITY_ACCESS_INVALIDATION_FEATURES,
  AUTHORITY_TRANSACTION_PARTICIPANT_FEATURES,
  isAuthorityParticipantEnvelope,
  isAuthorityParticipantFeature,
  isAuthorityTransactionView,
  isFeatureEnablementManifest,
  isParticipantRegistration,
  readParticipantResultRoomId,
  type AuthorityParticipantByFeature,
  type AuthorityAccessInvalidationFeature,
  type AuthorityParticipantFeature,
  type AuthorityParticipantFailureReason,
  type AuthorityParticipantResultByFeature,
  type AuthorityTransactionParticipantFeature,
  type AuthorityTransactionView,
  type FeatureEnablementManifest,
  type ParticipantRegistration,
} from "./private-participant-contracts.js";

export class AuthorityParticipantUnavailableError extends Error {
  readonly safeError;

  constructor(
    dependency: AuthorityParticipantFeature,
    reason: AuthorityParticipantFailureReason,
  ) {
    super(`Authority participant unavailable: ${dependency}/${reason}`);
    this.name = "AuthorityParticipantUnavailableError";
    this.safeError = Object.freeze({
      httpStatus: 503 as const,
      code: "dependency_unavailable" as const,
      dependency,
      reason,
      retryable: true as const,
    });
  }
}

function unavailable(
  dependency: AuthorityParticipantFeature,
  reason: AuthorityParticipantFailureReason,
): never {
  throw new AuthorityParticipantUnavailableError(dependency, reason);
}

function registrationFeature(value: unknown): AuthorityParticipantFeature {
  if (typeof value === "object" && value !== null && "feature" in value) {
    const feature = (value as { readonly feature?: unknown }).feature;
    if (isAuthorityParticipantFeature(feature)) return feature;
  }
  return "departure-responsibility";
}

function parseAndIndex(
  manifest: FeatureEnablementManifest,
  registrations: readonly unknown[],
): Map<AuthorityParticipantFeature, ParticipantRegistration> {
  if (!isFeatureEnablementManifest(manifest)) {
    unavailable("departure-responsibility", "invalid_manifest");
  }

  const registrationIds = new Map<string, AuthorityParticipantFeature>();
  const byFeature = new Map<AuthorityParticipantFeature, ParticipantRegistration>();
  for (const candidate of registrations) {
    const feature = registrationFeature(candidate);
    if (typeof candidate === "object" && candidate !== null && "registrationId" in candidate) {
      const registrationId = (candidate as { readonly registrationId?: unknown }).registrationId;
      if (typeof registrationId === "string" && registrationIds.has(registrationId)) {
        unavailable(registrationIds.get(registrationId) ?? feature, "duplicate_registration_id");
      }
      if (typeof registrationId === "string") registrationIds.set(registrationId, feature);
    }
    if (typeof candidate === "object" && candidate !== null && "version" in candidate &&
      (candidate as { readonly version?: unknown }).version !== AUTHORITY_PARTICIPANT_VERSION) {
      unavailable(feature, "version_mismatch");
    }
    if (!isParticipantRegistration(candidate)) {
      unavailable(feature, "malformed_registration");
    }
    if (byFeature.has(candidate.feature)) {
      unavailable(candidate.feature, "duplicate_feature_registration");
    }
    if (manifest[candidate.feature] !== candidate.enabled) {
      unavailable(candidate.feature, "manifest_mismatch");
    }
    byFeature.set(candidate.feature, candidate);
  }

  return byFeature;
}

function validateRequiredFeatures(
  manifest: FeatureEnablementManifest,
  byFeature: ReadonlyMap<AuthorityParticipantFeature, ParticipantRegistration>,
  features: readonly AuthorityParticipantFeature[],
): void {
  for (const feature of features) {
    if (manifest[feature] && !byFeature.has(feature)) {
      unavailable(feature, "missing_registration");
    }
  }
}

export function assertAuthorityParticipantRegistry(
  manifest: FeatureEnablementManifest,
  registrations: readonly unknown[],
): void {
  const byFeature = parseAndIndex(manifest, registrations);
  validateRequiredFeatures(manifest, byFeature, AUTHORITY_TRANSACTION_PARTICIPANT_FEATURES);
}

export function assertLifecycleRepairDescriptorRegistration(
  manifest: FeatureEnablementManifest,
  registrations: readonly unknown[],
): void {
  const byFeature = parseAndIndex(manifest, registrations);
  validateRequiredFeatures(manifest, byFeature, ["lifecycle-repair"]);
}

export function assertAccessInvalidationPortRegistrations(
  manifest: FeatureEnablementManifest,
  registrations: readonly unknown[],
): void {
  const byFeature = parseAndIndex(manifest, registrations);
  validateRequiredFeatures(manifest, byFeature, AUTHORITY_ACCESS_INVALIDATION_FEATURES);
}

export function assertSharedAuthorityParticipantComposition(
  manifest: FeatureEnablementManifest,
  registrations: readonly unknown[],
): void {
  const byFeature = parseAndIndex(manifest, registrations);
  validateRequiredFeatures(manifest, byFeature, AUTHORITY_TRANSACTION_PARTICIPANT_FEATURES);
  validateRequiredFeatures(manifest, byFeature, ["lifecycle-repair"]);
  validateRequiredFeatures(manifest, byFeature, AUTHORITY_ACCESS_INVALIDATION_FEATURES);
}

export function invokeAuthorityParticipant<
  TFeature extends AuthorityTransactionParticipantFeature,
>(options: Readonly<{
  feature: TFeature;
  manifest: FeatureEnablementManifest;
  registrations: readonly unknown[];
  tx: AuthorityTransactionView;
  roomId: string;
  invoke: (
    participant: AuthorityParticipantByFeature[TFeature],
  ) => unknown;
}>): AuthorityParticipantResultByFeature[TFeature] {
  return invokeRegisteredFeature(options, AUTHORITY_TRANSACTION_PARTICIPANT_FEATURES);
}

export function invokeLifecycleRepairDescriptor(options: Readonly<{
  manifest: FeatureEnablementManifest;
  registrations: readonly unknown[];
  tx: AuthorityTransactionView;
  roomId: string;
  invoke: (
    participant: AuthorityParticipantByFeature["lifecycle-repair"],
  ) => unknown;
}>): AuthorityParticipantResultByFeature["lifecycle-repair"] {
  return invokeRegisteredFeature(
    { ...options, feature: "lifecycle-repair" },
    ["lifecycle-repair"],
  );
}

export function invokeAccessInvalidationPort<
  TFeature extends AuthorityAccessInvalidationFeature,
>(options: Readonly<{
  feature: TFeature;
  manifest: FeatureEnablementManifest;
  registrations: readonly unknown[];
  tx: AuthorityTransactionView;
  roomId: string;
  invoke: (
    participant: AuthorityParticipantByFeature[TFeature],
  ) => unknown;
}>): AuthorityParticipantResultByFeature[TFeature] {
  return invokeRegisteredFeature(options, AUTHORITY_ACCESS_INVALIDATION_FEATURES);
}

function invokeRegisteredFeature<TFeature extends AuthorityParticipantFeature>(
  options: Readonly<{
    feature: TFeature;
    manifest: FeatureEnablementManifest;
    registrations: readonly unknown[];
    tx: AuthorityTransactionView;
    roomId: string;
    invoke: (
      participant: AuthorityParticipantByFeature[TFeature],
    ) => unknown;
  }>,
  requiredFeatures: readonly AuthorityParticipantFeature[],
): AuthorityParticipantResultByFeature[TFeature] {
  const byFeature = parseAndIndex(options.manifest, options.registrations);
  validateRequiredFeatures(options.manifest, byFeature, requiredFeatures);
  if (!isAuthorityTransactionView(options.tx) || options.tx.roomId !== options.roomId) {
    unavailable(options.feature, "transaction_mismatch");
  }
  const registration = byFeature.get(options.feature);
  if (!registration?.enabled || registration.participant === undefined) {
    unavailable(options.feature, "missing_registration");
  }

  let envelope: unknown;
  try {
    envelope = options.invoke(
      registration.participant as AuthorityParticipantByFeature[TFeature],
    );
  } catch {
    unavailable(options.feature, "participant_threw");
  }
  if (!isAuthorityParticipantEnvelope(options.feature, envelope, options.roomId)) {
    if (readParticipantResultRoomId(envelope) !== undefined &&
      readParticipantResultRoomId(envelope) !== options.roomId) {
      unavailable(options.feature, "cross_room_result");
    }
    unavailable(options.feature, "malformed_result");
  }
  if (!envelope.ok) {
    throw new AuthorityParticipantUnavailableError(
      options.feature,
      envelope.error.reason,
    );
  }
  return envelope.result;
}
