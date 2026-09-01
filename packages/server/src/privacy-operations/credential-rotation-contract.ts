const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATES = new Set([
  "requested",
  "staged",
  "activation_pending",
  "active",
  "failed",
  "rollback_pending",
  "rolled_back",
]);
const RESULTS = new Set([
  "activated",
  "backend_unavailable",
  "backend_conflict",
  "forward_recovered",
  "rolled_back",
  "rejected",
]);
const READINESS_TRANSITIONS = new Set([
  "noauth_to_noauth",
  "noauth_to_ready",
  "ready_to_noauth",
  "ready_to_ready",
]);

export type CredentialRotationState =
  | "requested"
  | "staged"
  | "activation_pending"
  | "active"
  | "failed"
  | "rollback_pending"
  | "rolled_back";

export type CredentialRotationResultClassification =
  | "activated"
  | "backend_unavailable"
  | "backend_conflict"
  | "forward_recovered"
  | "rolled_back"
  | "rejected";

export interface CredentialRotationMetadata {
  readonly rotationId: string;
  readonly providerId: "openai-responses";
  readonly modelId: string;
  readonly generation: number;
  readonly previousGeneration: number;
  readonly keyVersion: string;
  readonly previousKeyVersion: string;
  readonly state: CredentialRotationState;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly resultClassification: CredentialRotationResultClassification | null;
}

export interface CredentialRotationAudit {
  readonly auditId: string;
  readonly actorId: string;
  readonly occurredAt: string;
  readonly providerId: "openai-responses";
  readonly modelId: string;
  readonly generation: number;
  readonly keyVersion: string;
  readonly readinessTransition:
    | "noauth_to_noauth"
    | "noauth_to_ready"
    | "ready_to_noauth"
    | "ready_to_ready";
  readonly resultClassification: CredentialRotationResultClassification;
}

export class CredentialRotationContractError extends Error {
  constructor(readonly reason:
    | "invalid_metadata"
    | "invalid_audit"
    | "invalid_transition"
    | "rotation_not_active") {
    super(`Credential rotation contract rejected: ${reason}`);
    this.name = "CredentialRotationContractError";
  }
}

const ALLOWED_TRANSITIONS: Readonly<Record<CredentialRotationState,
  ReadonlySet<CredentialRotationState>>> = Object.freeze({
  requested: new Set<CredentialRotationState>(["staged", "failed"]),
  staged: new Set<CredentialRotationState>(["activation_pending", "failed", "rollback_pending"]),
  activation_pending: new Set<CredentialRotationState>(["active", "failed", "rollback_pending"]),
  active: new Set<CredentialRotationState>(),
  failed: new Set<CredentialRotationState>(),
  rollback_pending: new Set<CredentialRotationState>(["rolled_back", "active", "failed"]),
  rolled_back: new Set<CredentialRotationState>(),
});

export function assertCredentialRotationTransition(
  current: CredentialRotationState,
  next: CredentialRotationState,
): void {
  if (!ALLOWED_TRANSITIONS[current].has(next)) {
    throw new CredentialRotationContractError("invalid_transition");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function id(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function time(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createCredentialRotationMetadata(input: unknown): CredentialRotationMetadata {
  if (!isRecord(input) || !exact(input, [
    "rotationId", "providerId", "modelId", "generation", "previousGeneration",
    "keyVersion", "previousKeyVersion", "state", "startedAt", "updatedAt",
    "resultClassification",
  ]) || !id(input.rotationId) || input.providerId !== "openai-responses" ||
      !id(input.modelId) || !generation(input.generation) || !generation(input.previousGeneration) ||
      input.generation !== input.previousGeneration + 1 || !id(input.keyVersion) ||
      !id(input.previousKeyVersion) || input.keyVersion === input.previousKeyVersion ||
      typeof input.state !== "string" || !STATES.has(input.state) || !time(input.startedAt) ||
      !time(input.updatedAt) || Date.parse(input.updatedAt) < Date.parse(input.startedAt) ||
      !(input.resultClassification === null ||
        (typeof input.resultClassification === "string" && RESULTS.has(input.resultClassification))) ||
      (input.state === "failed" && input.resultClassification === null)) {
    throw new CredentialRotationContractError("invalid_metadata");
  }
  return Object.freeze({
    rotationId: input.rotationId,
    providerId: input.providerId,
    modelId: input.modelId,
    generation: input.generation,
    previousGeneration: input.previousGeneration,
    keyVersion: input.keyVersion,
    previousKeyVersion: input.previousKeyVersion,
    state: input.state as CredentialRotationState,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    resultClassification: input.resultClassification as CredentialRotationResultClassification | null,
  });
}

export function createCredentialRotationAudit(input: unknown): CredentialRotationAudit {
  if (!isRecord(input) || !exact(input, [
    "auditId", "actorId", "occurredAt", "providerId", "modelId", "generation", "keyVersion",
    "readinessTransition", "resultClassification",
  ]) || !id(input.auditId) || !id(input.actorId) || !time(input.occurredAt) ||
      input.providerId !== "openai-responses" || !id(input.modelId) ||
      !generation(input.generation) || input.generation < 1 || !id(input.keyVersion) ||
      typeof input.readinessTransition !== "string" ||
      !READINESS_TRANSITIONS.has(input.readinessTransition) ||
      typeof input.resultClassification !== "string" || !RESULTS.has(input.resultClassification)) {
    throw new CredentialRotationContractError("invalid_audit");
  }
  return Object.freeze({
    auditId: input.auditId,
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    providerId: input.providerId,
    modelId: input.modelId,
    generation: input.generation,
    keyVersion: input.keyVersion,
    readinessTransition: input.readinessTransition as CredentialRotationAudit["readinessTransition"],
    resultClassification: input.resultClassification as CredentialRotationResultClassification,
  });
}

export interface CredentialBackendObservation {
  readonly activeKeyVersion: string | null;
  readonly stagedKeyVersion: string | null;
}

export type CredentialRotationRecoveryDecision =
  | Readonly<{ action: "stage_target" | "persist_staged" | "activate_target" |
    "persist_active" | "discard_target" | "persist_rolled_back" | "none" }>
  | Readonly<{ action: "persist_failed"; reason: "staged_version_missing" }>
  | Readonly<{ action: "block_readiness";
    reason: "foreign_backend_version" | "active_backend_mismatch" }>;

function observationVersion(value: unknown): value is string | null {
  return value === null || id(value);
}

/** Pure restart reconciliation. It never carries or asks for credential material. */
export function reconcileCredentialRotation(
  metadata: CredentialRotationMetadata,
  backend: CredentialBackendObservation,
): CredentialRotationRecoveryDecision {
  if (!observationVersion(backend.activeKeyVersion) ||
      !observationVersion(backend.stagedKeyVersion)) {
    return Object.freeze({ action: "block_readiness", reason: "foreign_backend_version" });
  }
  if (metadata.state === "failed" || metadata.state === "rolled_back") {
    return Object.freeze({ action: "none" });
  }
  if (metadata.state === "active") {
    return backend.activeKeyVersion === metadata.keyVersion
      ? Object.freeze({ action: "none" })
      : Object.freeze({ action: "block_readiness", reason: "active_backend_mismatch" });
  }
  if (metadata.state === "rollback_pending") {
    if (backend.activeKeyVersion === metadata.keyVersion) {
      return Object.freeze({ action: "persist_active" });
    }
    if (backend.activeKeyVersion !== metadata.previousKeyVersion) {
      return Object.freeze({ action: "block_readiness", reason: "foreign_backend_version" });
    }
    return backend.stagedKeyVersion === metadata.keyVersion
      ? Object.freeze({ action: "discard_target" })
      : Object.freeze({ action: "persist_rolled_back" });
  }
  if (backend.activeKeyVersion === metadata.keyVersion) {
    return Object.freeze({ action: "persist_active" });
  }
  if (backend.activeKeyVersion !== metadata.previousKeyVersion) {
    return Object.freeze({ action: "block_readiness", reason: "foreign_backend_version" });
  }
  if (metadata.state === "requested") {
    if (backend.stagedKeyVersion === null) return Object.freeze({ action: "stage_target" });
    return backend.stagedKeyVersion === metadata.keyVersion
      ? Object.freeze({ action: "persist_staged" })
      : Object.freeze({ action: "block_readiness", reason: "foreign_backend_version" });
  }
  if (backend.stagedKeyVersion === metadata.keyVersion) {
    return Object.freeze({ action: "activate_target" });
  }
  if (backend.stagedKeyVersion === null) {
    return Object.freeze({ action: "persist_failed", reason: "staged_version_missing" });
  }
  return Object.freeze({ action: "block_readiness", reason: "foreign_backend_version" });
}

export interface FrozenProviderExecutionBinding {
  readonly providerId: "openai-responses";
  readonly modelId: string;
  readonly credentialGeneration: number;
  readonly credentialKeyVersion: string;
}

export function freezeProviderExecutionBinding(
  metadata: CredentialRotationMetadata,
): FrozenProviderExecutionBinding {
  if (metadata.state !== "active") {
    throw new CredentialRotationContractError("rotation_not_active");
  }
  return Object.freeze({
    providerId: metadata.providerId,
    modelId: metadata.modelId,
    credentialGeneration: metadata.generation,
    credentialKeyVersion: metadata.keyVersion,
  });
}

/**
 * Production backend capability required by the shared integration owner.
 * No implementation exists in this repository yet; in-memory/environment/file
 * substitutes do not satisfy this durable, versioned, restart-recoverable port.
 */
export interface ProductionCredentialSecretBackend {
  observe(providerId: "openai-responses"): Promise<CredentialBackendObservation>;
  stage(input: Readonly<{
    rotationId: string;
    providerId: "openai-responses";
    keyVersion: string;
    secretMaterial: ServerPrivateSecretMaterial;
  }>): Promise<void>;
  activate(input: Readonly<{
    rotationId: string;
    providerId: "openai-responses";
    keyVersion: string;
  }>): Promise<void>;
  discard(input: Readonly<{
    rotationId: string;
    providerId: "openai-responses";
    keyVersion: string;
  }>): Promise<void>;
}

/** One-shot server-private material; implementations must zeroize after use. */
export interface ServerPrivateSecretMaterial {
  consume<TResult>(operation: (bytes: Uint8Array) => Promise<TResult>): Promise<TResult>;
}
