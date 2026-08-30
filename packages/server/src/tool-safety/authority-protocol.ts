import type { ToolId, ToolReviewResolution } from "@native-im/core";
import type { AuthenticatedCommandContext } from "../persistence/contracts.js";
import type { ToolDispatchRejectionReason } from "../agent-runtime/tool-permission-matrix.js";

export type ToolSafetyAuthorityOperation =
  | Readonly<{
      type: "tool-safety.read-prepare-binding";
      executionId: string;
      attemptSeq: number;
      toolId: ToolId;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.prepare";
      toolCallId: string;
      invocationId: string;
      executionId: string;
      attemptSeq: number;
      expectedExecutionVersion: number;
      toolId: ToolId;
      canonicalParameterSha256: string;
      parameterSchemaVersion: string;
      canonicalizerVersion: string;
      safePreview: Readonly<Record<string, unknown>>;
      sealedPayload?: Readonly<{
        ciphertext: string;
        keyVersion: string;
        expiresAt: string;
      }>;
      confirmation?: Readonly<{
        confirmationId: string;
        context: AuthenticatedCommandContext;
        bindingGeneration: number;
      }>;
      grantId?: string;
      grantExpiresAt?: string;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.confirmation-decide";
      context: AuthenticatedCommandContext;
      confirmationId: string;
      expectedVersion: number;
      decision: "confirm" | "reject";
      grantId?: string;
      grantExpiresAt?: string;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.claim";
      toolCallId: string;
      invocationId: string;
      executionId: string;
      attemptSeq: number;
      expectedExecutionVersion: number;
      roomId: string;
      agentId: string;
      grantId: string;
      toolId: ToolId;
      canonicalParameterSha256: string;
      canonicalizerVersion: string;
      sourceSnapshotId: string;
      expectedAccessRevision: number;
      expectedRoomLifecycleGeneration: number;
      profileId: string;
      expectedProfileRevision: number;
      assignmentId: string;
      expectedAssignmentRevision: number;
      principalActorId?: string;
      sessionFamilyId?: string;
      bindingGeneration?: number;
      parameters: Readonly<Record<string, unknown>>;
      compensationOfDispatchId?: string;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.handoff-offer";
      context: AuthenticatedCommandContext;
      confirmationId: string;
      expectedVersion: number;
      targetActorId: string;
      handoffId: string;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.handoff-read";
      context: AuthenticatedCommandContext;
      handoffId: string;
      expectedVersion: number;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.handoff-accept";
      context: AuthenticatedCommandContext;
      handoffId: string;
      expectedVersion: number;
      resealedPayload: Readonly<{ ciphertext: string; keyVersion: string; expiresAt: string }>;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.settle";
      dispatchId: string;
      state: "known_succeeded" | "known_failed" | "outcome_unknown";
      summary: Readonly<Record<string, string | number | boolean>>;
      sealedCompensation?: string;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.outcome-review";
      context: AuthenticatedCommandContext;
      dispatchId: string;
      expectedVersion: number;
      resolution: ToolReviewResolution;
      evidenceSummary: string;
      evidenceSha256: string;
      compensationToolCallId?: string;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.compensation-propose";
      context: AuthenticatedCommandContext;
      dispatchId: string;
      expectedVersion: number;
      invocationId: string;
      executionId: string;
      toolCallId: string;
      confirmationId: string;
      canonicalParameterSha256: string;
      sealedReference: Readonly<{ ciphertext: string; keyVersion: string; expiresAt: string }>;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.expire";
      limit: number;
      now: number;
    }>
  | Readonly<{
      type: "tool-safety.recover-execution";
      executionId: string;
      now: number;
    }>;

export interface ToolSafetyClaimBinding {
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly executionVersion: number;
  readonly roomId: string;
  readonly roomLifecycleGeneration: number;
  readonly agentId: string;
  readonly sourceSnapshotId: string;
  readonly accessRevision: number;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly canonicalParameterSha256: string;
  readonly canonicalizerVersion: string;
  readonly toolId: ToolId;
  readonly principalActorId?: string;
  readonly sessionFamilyId?: string;
  readonly bindingGeneration?: number;
}

export type ToolSafetyAuthorityResult =
  | Readonly<{
      kind: "prepare-binding";
      invocationId: string;
      executionId: string;
      attemptSeq: number;
      executionVersion: number;
      roomId: string;
      roomLifecycleGeneration: number;
      agentId: string;
      sourceSnapshotId: string;
      accessRevision: number;
      profileId: string;
      profileRevision: number;
      assignmentId: string;
      assignmentRevision: number;
      toolId: ToolId;
    }>
  | Readonly<{
      kind: "prepared";
      toolCallId: string;
      confirmationId?: string;
      grantId?: string;
      version: number;
      claimBinding?: Readonly<ToolSafetyClaimBinding>;
    }>
  | Readonly<{
      kind: "confirmation-decision";
      confirmationId: string;
      state: "confirmed" | "rejected";
      version: number;
      grantId?: string;
      replayed: boolean;
    }>
  | Readonly<{
      kind: "claimed";
      dispatchId: string;
      toolId: ToolId;
      parameters: Readonly<Record<string, unknown>>;
      compensationToken?: string;
      compensationOfDispatchId?: string;
    }>
  | Readonly<{
      kind: "handoff";
      handoffId: string;
      confirmationId: string;
      state: "offered" | "accepted";
      version: number;
      replayed: boolean;
    }>
  | Readonly<{
      kind: "handoff-binding";
      handoffId: string;
      confirmationId: string;
      confirmationVersion: number;
      toPrincipalActorId: string;
      toSessionFamilyId: string;
      parameterSchemaVersion: string;
      sealedPayload: Readonly<{ ciphertext: string; keyVersion: string; expiresAt: string }>;
      claimBinding: Readonly<ToolSafetyClaimBinding>;
    }>
  | Readonly<{
      kind: "rejected";
      reason: ToolDispatchRejectionReason;
    }>
  | Readonly<{
      kind: "not_replayable";
      state: "claimed" | "dispatched" | "outcome_unknown";
      dispatchId: string;
    }>
  | Readonly<{
      kind: "settled";
      dispatchId: string;
      state: "known_succeeded" | "known_failed" | "outcome_unknown";
      version: number;
      replayed: boolean;
    }>
  | Readonly<{
      kind: "reviewed";
      dispatchId: string;
      reviewId: string;
      resolution: ToolReviewResolution;
      version: number;
      replayed: boolean;
    }>
  | Readonly<{
      kind: "compensation-proposed";
      lineageId: string;
      originalDispatchId: string;
      invocationId: string;
      executionId: string;
      toolCallId: string;
      confirmationId: string;
      version: number;
      replayed: boolean;
    }>
  | Readonly<{ kind: "expired"; confirmations: number; grants: number }>
  | Readonly<{
      kind: "recovery";
      state: "pending" | "confirmed_active" | "outcome_unknown" | "known_succeeded" |
        "known_failed" | "reviewed" | "none";
      toolCallId?: string;
      confirmationId?: string;
      confirmationVersion?: number;
      grantId?: string;
      dispatchId?: string;
      compensationOfDispatchId?: string;
      parameterSchemaVersion?: string;
      sealedPayload?: Readonly<{ ciphertext: string; keyVersion: string; expiresAt: string }>;
      claimBinding?: Readonly<ToolSafetyClaimBinding>;
    }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function context(value: unknown): value is AuthenticatedCommandContext {
  return record(value) && text(value.sessionId) && text(value.sessionFamilyId) &&
    text(value.requestId) && text(value.idempotencyKey) && record(value.principal) &&
    text(value.principal.actorId) && text(value.principal.accountId);
}

function jsonObject(value: unknown, max = 1024 * 1024): value is Readonly<Record<string, unknown>> {
  if (!record(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= max; } catch { return false; }
}

const toolIds = new Set<ToolId>(["http-json.read", "repository.git-status", "sandbox-file.write"]);

export function isToolSafetyAuthorityOperation(value: unknown): value is ToolSafetyAuthorityOperation {
  if (!record(value) || !text(value.type)) return false;
  if (value.type === "tool-safety.read-prepare-binding") {
    return exact(value, ["type", "executionId", "attemptSeq", "toolId", "now"]) &&
      text(value.executionId) && integer(value.attemptSeq, 1) &&
      toolIds.has(value.toolId as ToolId) && integer(value.now);
  }
  if (value.type === "tool-safety.prepare") {
    const optional = ["sealedPayload", "confirmation", "grantId", "grantExpiresAt"]
      .filter((key) => Object.hasOwn(value, key));
    return exact(value, ["type", "toolCallId", "invocationId", "executionId", "attemptSeq",
      "expectedExecutionVersion", "toolId", "canonicalParameterSha256", "parameterSchemaVersion",
      "canonicalizerVersion", "safePreview", "now"], optional) &&
      text(value.toolCallId) && text(value.invocationId) && text(value.executionId) &&
      integer(value.attemptSeq, 1) && integer(value.expectedExecutionVersion, 1) &&
      toolIds.has(value.toolId as ToolId) && typeof value.canonicalParameterSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(value.canonicalParameterSha256) && text(value.parameterSchemaVersion) &&
      text(value.canonicalizerVersion) && jsonObject(value.safePreview, 8_192) && integer(value.now) &&
      (!Object.hasOwn(value, "sealedPayload") || (record(value.sealedPayload) &&
        exact(value.sealedPayload, ["ciphertext", "keyVersion", "expiresAt"]) &&
        text(value.sealedPayload.ciphertext, 1024 * 1024 + 256) && text(value.sealedPayload.keyVersion, 64) &&
        text(value.sealedPayload.expiresAt))) &&
      (!Object.hasOwn(value, "confirmation") || (record(value.confirmation) &&
        exact(value.confirmation, ["confirmationId", "context", "bindingGeneration"]) &&
        text(value.confirmation.confirmationId) && context(value.confirmation.context) &&
        integer(value.confirmation.bindingGeneration, 1))) &&
      (!Object.hasOwn(value, "grantId") || text(value.grantId)) &&
      (!Object.hasOwn(value, "grantExpiresAt") || text(value.grantExpiresAt));
  }
  if (value.type === "tool-safety.confirmation-decide") {
    const optional = ["grantId", "grantExpiresAt"].filter((key) => Object.hasOwn(value, key));
    return exact(value, ["type", "context", "confirmationId", "expectedVersion", "decision", "now"], optional) &&
      context(value.context) && text(value.confirmationId) && integer(value.expectedVersion, 1) &&
      (value.decision === "confirm" || value.decision === "reject") && integer(value.now) &&
      (!Object.hasOwn(value, "grantId") || text(value.grantId)) &&
      (!Object.hasOwn(value, "grantExpiresAt") || text(value.grantExpiresAt));
  }
  if (value.type === "tool-safety.claim") {
    const optional = ["principalActorId", "sessionFamilyId", "bindingGeneration",
      "compensationOfDispatchId"]
      .filter((key) => Object.hasOwn(value, key));
    return exact(value, ["type", "toolCallId", "invocationId", "executionId", "attemptSeq",
      "expectedExecutionVersion", "roomId", "agentId", "grantId", "toolId",
      "canonicalParameterSha256", "canonicalizerVersion", "sourceSnapshotId",
      "expectedAccessRevision", "expectedRoomLifecycleGeneration", "profileId",
      "expectedProfileRevision", "assignmentId", "expectedAssignmentRevision", "parameters", "now"], optional) &&
      [value.toolCallId, value.invocationId, value.executionId, value.roomId, value.agentId,
        value.grantId, value.canonicalizerVersion, value.sourceSnapshotId,
        value.profileId, value.assignmentId].every((entry) => text(entry)) &&
      integer(value.attemptSeq, 1) && integer(value.expectedExecutionVersion, 1) &&
      integer(value.expectedAccessRevision) && integer(value.expectedRoomLifecycleGeneration) &&
      integer(value.expectedProfileRevision, 1) && integer(value.expectedAssignmentRevision, 1) &&
      toolIds.has(value.toolId as ToolId) && typeof value.canonicalParameterSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(value.canonicalParameterSha256) && jsonObject(value.parameters) &&
      (!Object.hasOwn(value, "principalActorId") || text(value.principalActorId)) &&
      (!Object.hasOwn(value, "sessionFamilyId") || text(value.sessionFamilyId)) &&
      (!Object.hasOwn(value, "bindingGeneration") || integer(value.bindingGeneration, 1)) &&
      (!Object.hasOwn(value, "compensationOfDispatchId") || text(value.compensationOfDispatchId)) &&
      integer(value.now);
  }
  if (value.type === "tool-safety.handoff-offer") {
    return exact(value, ["type", "context", "confirmationId", "expectedVersion",
      "targetActorId", "handoffId", "now"]) && context(value.context) &&
      text(value.confirmationId) && integer(value.expectedVersion, 1) &&
      text(value.targetActorId) && text(value.handoffId) && integer(value.now);
  }
  if (value.type === "tool-safety.handoff-read") {
    return exact(value, ["type", "context", "handoffId", "expectedVersion", "now"]) &&
      context(value.context) && text(value.handoffId) && integer(value.expectedVersion, 1) &&
      integer(value.now);
  }
  if (value.type === "tool-safety.handoff-accept") {
    return exact(value, ["type", "context", "handoffId", "expectedVersion",
      "resealedPayload", "now"]) && context(value.context) && text(value.handoffId) &&
      integer(value.expectedVersion, 1) && record(value.resealedPayload) &&
      exact(value.resealedPayload, ["ciphertext", "keyVersion", "expiresAt"]) &&
      text(value.resealedPayload.ciphertext, 1024 * 1024 + 256) &&
      text(value.resealedPayload.keyVersion, 64) && text(value.resealedPayload.expiresAt) &&
      integer(value.now);
  }
  if (value.type === "tool-safety.settle") {
    const optional = Object.hasOwn(value, "sealedCompensation") ? ["sealedCompensation"] : [];
    return exact(value, ["type", "dispatchId", "state", "summary", "now"], optional) &&
      text(value.dispatchId) && ["known_succeeded", "known_failed", "outcome_unknown"].includes(String(value.state)) &&
      jsonObject(value.summary, 8_192) && Object.values(value.summary).every((entry) =>
        typeof entry === "string" || typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry))) &&
      (!Object.hasOwn(value, "sealedCompensation") || text(value.sealedCompensation, 1024 * 1024)) &&
      integer(value.now);
  }
  if (value.type === "tool-safety.outcome-review") {
    const optional = Object.hasOwn(value, "compensationToolCallId") ? ["compensationToolCallId"] : [];
    return exact(value, ["type", "context", "dispatchId", "expectedVersion", "resolution",
      "evidenceSummary", "evidenceSha256", "now"], optional) && context(value.context) &&
      text(value.dispatchId) && integer(value.expectedVersion, 1) &&
      ["known_succeeded", "known_failed", "compensated", "accepted_risk"].includes(String(value.resolution)) &&
      typeof value.evidenceSummary === "string" && Buffer.byteLength(value.evidenceSummary, "utf8") <= 8_192 &&
      typeof value.evidenceSha256 === "string" && /^[0-9a-f]{64}$/u.test(value.evidenceSha256) &&
      (!Object.hasOwn(value, "compensationToolCallId") || text(value.compensationToolCallId)) && integer(value.now);
  }
  if (value.type === "tool-safety.compensation-propose") {
    return exact(value, ["type", "context", "dispatchId", "expectedVersion",
      "invocationId", "executionId", "toolCallId", "confirmationId",
      "canonicalParameterSha256", "sealedReference", "now"]) &&
      context(value.context) && text(value.dispatchId) && integer(value.expectedVersion, 1) &&
      text(value.invocationId) && text(value.executionId) && text(value.toolCallId) &&
      text(value.confirmationId) && typeof value.canonicalParameterSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(value.canonicalParameterSha256) &&
      record(value.sealedReference) && exact(value.sealedReference,
        ["ciphertext", "keyVersion", "expiresAt"]) &&
      text(value.sealedReference.ciphertext, 512) &&
      value.sealedReference.keyVersion === "dao-compensation-reference.v1" &&
      text(value.sealedReference.expiresAt) && integer(value.now);
  }
  if (value.type === "tool-safety.expire") {
    return exact(value, ["type", "limit", "now"]) &&
      integer(value.limit, 1) && value.limit <= 500 && integer(value.now);
  }
  return value.type === "tool-safety.recover-execution" &&
    exact(value, ["type", "executionId", "now"]) && text(value.executionId) && integer(value.now);
}
