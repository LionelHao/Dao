import { describe, expect, it } from "vitest";
import {
  CredentialRotationContractError,
  assertCredentialRotationTransition,
  createCredentialRotationAudit,
  createCredentialRotationMetadata,
  freezeProviderExecutionBinding,
  reconcileCredentialRotation,
  type CredentialRotationMetadata,
} from "./credential-rotation-contract.js";

const STARTED_AT = "2026-08-31T12:00:00.000Z";

function metadata(
  state: CredentialRotationMetadata["state"],
): CredentialRotationMetadata {
  return createCredentialRotationMetadata({
    rotationId: "rotation-2",
    providerId: "openai-responses",
    modelId: "gpt-5",
    generation: 2,
    previousGeneration: 1,
    keyVersion: "provider-key-v2",
    previousKeyVersion: "provider-key-v1",
    state,
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    resultClassification: state === "failed" ? "backend_unavailable" : null,
  });
}

describe("FT-14 credential rotation private contract", () => {
  it("accepts only closed secret-free metadata and audit fields", () => {
    const record = metadata("requested");
    expect(Object.keys(record)).toEqual([
      "rotationId", "providerId", "modelId", "generation", "previousGeneration",
      "keyVersion", "previousKeyVersion", "state", "startedAt", "updatedAt",
      "resultClassification",
    ]);
    expect(() => createCredentialRotationMetadata({
      ...record,
      credential: "test-only-canary",
    })).toThrow(CredentialRotationContractError);
    expect(() => createCredentialRotationMetadata({
      ...record,
      credentialHash: "test-only-derived-canary",
    })).toThrow(CredentialRotationContractError);

    const audit = createCredentialRotationAudit({
      auditId: "audit-1",
      actorId: "human-admin",
      occurredAt: STARTED_AT,
      providerId: record.providerId,
      modelId: record.modelId,
      generation: record.generation,
      keyVersion: record.keyVersion,
      readinessTransition: "ready_to_ready",
      resultClassification: "activated",
    });
    expect(audit).toEqual({
      auditId: "audit-1", actorId: "human-admin", occurredAt: STARTED_AT,
      providerId: "openai-responses", modelId: "gpt-5", generation: 2,
      keyVersion: "provider-key-v2", readinessTransition: "ready_to_ready",
      resultClassification: "activated",
    });
    expect(JSON.stringify({ record, audit })).not.toMatch(
      /credential(?:Value|Length|Hash)?|secret|authorization|prefix|suffix/i,
    );
  });

  it("forward-recovers every crash window without exposing a second provider or model", () => {
    expect(reconcileCredentialRotation(metadata("requested"), {
      activeKeyVersion: "provider-key-v1", stagedKeyVersion: null,
    })).toEqual({ action: "stage_target" });
    expect(reconcileCredentialRotation(metadata("requested"), {
      activeKeyVersion: "provider-key-v1", stagedKeyVersion: "provider-key-v2",
    })).toEqual({ action: "persist_staged" });
    expect(reconcileCredentialRotation(metadata("requested"), {
      activeKeyVersion: "provider-key-v2", stagedKeyVersion: null,
    })).toEqual({ action: "persist_active" });
    expect(reconcileCredentialRotation(metadata("staged"), {
      activeKeyVersion: "provider-key-v1", stagedKeyVersion: "provider-key-v2",
    })).toEqual({ action: "activate_target" });
    expect(reconcileCredentialRotation(metadata("activation_pending"), {
      activeKeyVersion: "provider-key-v2", stagedKeyVersion: null,
    })).toEqual({ action: "persist_active" });
    expect(reconcileCredentialRotation(metadata("active"), {
      activeKeyVersion: "provider-key-v1", stagedKeyVersion: "provider-key-v2",
    })).toEqual({ action: "block_readiness", reason: "active_backend_mismatch" });
  });

  it("fails closed on lost staged state, foreign backend versions, or terminal rotation replay", () => {
    expect(reconcileCredentialRotation(metadata("staged"), {
      activeKeyVersion: "provider-key-v1", stagedKeyVersion: null,
    })).toEqual({ action: "persist_failed", reason: "staged_version_missing" });
    expect(reconcileCredentialRotation(metadata("requested"), {
      activeKeyVersion: "provider-key-foreign", stagedKeyVersion: null,
    })).toEqual({ action: "block_readiness", reason: "foreign_backend_version" });
    expect(reconcileCredentialRotation(metadata("failed"), {
      activeKeyVersion: "provider-key-v1", stagedKeyVersion: null,
    })).toEqual({ action: "none" });
    expect(reconcileCredentialRotation(metadata("rolled_back"), {
      activeKeyVersion: "provider-key-v1", stagedKeyVersion: null,
    })).toEqual({ action: "none" });
  });

  it("freezes provider, model, generation and key version for one execution", () => {
    const binding = freezeProviderExecutionBinding(metadata("active"));
    expect(binding).toEqual({
      providerId: "openai-responses",
      modelId: "gpt-5",
      credentialGeneration: 2,
      credentialKeyVersion: "provider-key-v2",
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(() => freezeProviderExecutionBinding(metadata("activation_pending")))
      .toThrow(CredentialRotationContractError);
  });

  it("allows only the bounded rotation lifecycle and keeps terminal records immutable", () => {
    expect(() => assertCredentialRotationTransition("requested", "staged")).not.toThrow();
    expect(() => assertCredentialRotationTransition("staged", "activation_pending")).not.toThrow();
    expect(() => assertCredentialRotationTransition("activation_pending", "active")).not.toThrow();
    expect(() => assertCredentialRotationTransition("staged", "rollback_pending")).not.toThrow();
    expect(() => assertCredentialRotationTransition("rollback_pending", "rolled_back")).not.toThrow();
    expect(() => assertCredentialRotationTransition("requested", "active"))
      .toThrow(CredentialRotationContractError);
    expect(() => assertCredentialRotationTransition("active", "failed"))
      .toThrow(CredentialRotationContractError);
    expect(() => assertCredentialRotationTransition("failed", "requested"))
      .toThrow(CredentialRotationContractError);
  });
});
