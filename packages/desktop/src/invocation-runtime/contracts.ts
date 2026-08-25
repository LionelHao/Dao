import {
  isAgentExecution,
  isAgentExecutionAttempt,
  isAgentExecutionRetryReceipt,
  isProjectBoundaryInvocationResult,
  isScopedCancellationReceipt,
  type AgentExecution,
  type AgentExecutionAttempt,
  type AgentExecutionRetryReceipt,
  type ProjectBoundaryInvocationResult,
  type ScopedCancellationReceipt,
} from "@native-im/core";

export const INVOCATION_IPC_CHANNELS = Object.freeze({
  getSurface: "invocation:get-surface",
  cancel: "invocation:cancel",
  retry: "invocation:retry",
  stateChanged: "invocation:state-changed",
} as const);

export type InvocationControlKind = "cancel" | "retry";
export type InvocationRecoveryAction =
  | "reauthenticate"
  | "request-access"
  | "refresh-authority"
  | "upgrade-client"
  | "retry-later"
  | "repair-room";

export interface InvocationClosedError {
  readonly status: 401 | 403 | 409 | 410 | 429 | 503;
  readonly code:
    | "authentication_required"
    | "access_revoked"
    | "execution_conflict"
    | "protocol_upgrade_required"
    | "rate_limited"
    | "service_unavailable";
  readonly recovery: InvocationRecoveryAction;
  readonly retryAfterSeconds?: number;
}

export type InvocationConnectionState =
  | Readonly<{ status: "online" }>
  | Readonly<{ status: "offline"; asOf: string }>
  | Readonly<{ status: "repairing" }>
  | Readonly<{ status: "repair_failed"; errorCode: string }>
  | Readonly<{ status: "revoked"; scope: "session" | "room"; purgeCompleted: true }>;

export type InvocationOperationState =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      status: "submitting" | "acknowledged";
      requestId: string;
      kind: InvocationControlKind;
      executionId: string;
      expectedVersion: number;
    }>
  | Readonly<{
      status: "failed";
      requestId: string;
      kind: InvocationControlKind;
      executionId: string;
      expectedVersion: number;
      error: InvocationClosedError;
    }>;

export interface InvocationExecutionProjection {
  readonly execution: AgentExecution;
  readonly attempts: readonly AgentExecutionAttempt[];
  readonly sourceLifecycle: "active" | "recalled" | "unknown";
  readonly preservedDispatchIds: readonly string[];
}

export interface InvocationSurfaceState {
  readonly roomId: string;
  readonly connection: InvocationConnectionState;
  readonly executions: readonly InvocationExecutionProjection[];
  readonly retries: readonly AgentExecutionRetryReceipt[];
  readonly cancellations: readonly ScopedCancellationReceipt[];
  readonly projectBoundaries: readonly ProjectBoundaryInvocationResult[];
  readonly operations: readonly InvocationOperationState[];
}

export interface InvocationSurfaceQuery { readonly roomId: string }
export interface InvocationControlRequest {
  readonly roomId: string;
  readonly executionId: string;
  readonly expectedVersion: number;
}
export interface InvocationControlResult {
  readonly requestId: string;
  readonly state: InvocationSurfaceState;
}
export interface InvocationStateEnvelope {
  readonly roomId: string;
  readonly state: InvocationSurfaceState;
}

export interface InvocationBridge {
  getSurface(query: InvocationSurfaceQuery): Promise<InvocationSurfaceState>;
  cancel(request: InvocationControlRequest): Promise<InvocationControlResult>;
  retry(request: InvocationControlRequest): Promise<InvocationControlResult>;
  onStateChanged(listener: (state: InvocationStateEnvelope) => void): () => void;
}

type UnknownRecord = Record<string, unknown>;
function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function isError(value: unknown): value is InvocationClosedError {
  if (!record(value) || !exact(value, ["status", "code", "recovery"], ["retryAfterSeconds"]) ||
      !positive(value.status) || !text(value.code) || !text(value.recovery)) return false;
  const allowed = new Map<number, readonly [string, InvocationRecoveryAction]>([
    [401, ["authentication_required", "reauthenticate"]],
    [403, ["access_revoked", "request-access"]],
    [409, ["execution_conflict", "refresh-authority"]],
    [410, ["protocol_upgrade_required", "upgrade-client"]],
    [429, ["rate_limited", "retry-later"]],
    [503, ["service_unavailable", "repair-room"]],
  ]);
  const expected = allowed.get(value.status);
  return expected?.[0] === value.code && expected[1] === value.recovery &&
    (value.retryAfterSeconds === undefined || positive(value.retryAfterSeconds));
}
function isConnection(value: unknown): value is InvocationConnectionState {
  if (!record(value) || typeof value.status !== "string") return false;
  if (value.status === "online" || value.status === "repairing") return exact(value, ["status"]);
  if (value.status === "offline") return exact(value, ["status", "asOf"]) && text(value.asOf);
  if (value.status === "repair_failed") {
    return exact(value, ["status", "errorCode"]) && text(value.errorCode);
  }
  return value.status === "revoked" && exact(value, ["status", "scope", "purgeCompleted"]) &&
    (value.scope === "session" || value.scope === "room") && value.purgeCompleted === true;
}
function isOperation(value: unknown): value is InvocationOperationState {
  if (!record(value) || typeof value.status !== "string") return false;
  if (value.status === "idle") return exact(value, ["status"]);
  if (!exact(value, ["status", "requestId", "kind", "executionId", "expectedVersion"],
    value.status === "failed" ? ["error"] : []) || !text(value.requestId) ||
      (value.kind !== "cancel" && value.kind !== "retry") || !text(value.executionId) ||
      !positive(value.expectedVersion)) return false;
  return value.status === "submitting" || value.status === "acknowledged" ||
    (value.status === "failed" && isError(value.error));
}
function isExecutionProjection(value: unknown): value is InvocationExecutionProjection {
  return record(value) && exact(value, [
    "execution", "attempts", "sourceLifecycle", "preservedDispatchIds",
  ]) && isAgentExecution(value.execution) && Array.isArray(value.attempts) &&
    value.attempts.every((attempt) => isAgentExecutionAttempt(attempt) &&
      attempt.executionId === (value.execution as AgentExecution).executionId) &&
    (value.sourceLifecycle === "active" || value.sourceLifecycle === "recalled" ||
      value.sourceLifecycle === "unknown") && Array.isArray(value.preservedDispatchIds) &&
    value.preservedDispatchIds.every(text) &&
    new Set(value.preservedDispatchIds).size === value.preservedDispatchIds.length;
}

export function isInvocationSurfaceQuery(value: unknown): value is InvocationSurfaceQuery {
  return record(value) && exact(value, ["roomId"]) && text(value.roomId);
}
export function isInvocationControlRequest(value: unknown): value is InvocationControlRequest {
  return record(value) && exact(value, ["roomId", "executionId", "expectedVersion"]) &&
    text(value.roomId) && text(value.executionId) && positive(value.expectedVersion);
}
export function isInvocationSurfaceState(value: unknown): value is InvocationSurfaceState {
  return record(value) && exact(value, [
    "roomId", "connection", "executions", "retries", "cancellations", "projectBoundaries", "operations",
  ]) && text(value.roomId) && isConnection(value.connection) && Array.isArray(value.executions) &&
    value.executions.every(isExecutionProjection) && Array.isArray(value.retries) &&
    value.retries.every((entry) => isAgentExecutionRetryReceipt(entry) && entry.roomId === value.roomId) &&
    Array.isArray(value.cancellations) && value.cancellations.every((entry) =>
      isScopedCancellationReceipt(entry) && entry.roomId === value.roomId) &&
    Array.isArray(value.projectBoundaries) && value.projectBoundaries.every((entry) =>
      isProjectBoundaryInvocationResult(entry) && entry.roomId === value.roomId) &&
    Array.isArray(value.operations) && value.operations.every(isOperation);
}
export function isInvocationControlResult(value: unknown): value is InvocationControlResult {
  return record(value) && exact(value, ["requestId", "state"]) && text(value.requestId) &&
    isInvocationSurfaceState(value.state);
}
export function isInvocationStateEnvelope(value: unknown): value is InvocationStateEnvelope {
  return record(value) && exact(value, ["roomId", "state"]) && text(value.roomId) &&
    isInvocationSurfaceState(value.state) && value.state.roomId === value.roomId;
}

export function cloneInvocationSurfaceState(value: unknown): InvocationSurfaceState {
  if (!isInvocationSurfaceState(value)) throw new TypeError("Invocation surface state is not closed");
  return structuredClone(value);
}
export function cloneInvocationControlResult(value: unknown): InvocationControlResult {
  if (!isInvocationControlResult(value)) throw new TypeError("Invocation control result is not closed");
  return structuredClone(value);
}
export function cloneInvocationStateEnvelope(value: unknown): InvocationStateEnvelope {
  if (!isInvocationStateEnvelope(value)) throw new TypeError("Invocation state envelope is not closed");
  return structuredClone(value);
}
