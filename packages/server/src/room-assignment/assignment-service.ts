import { createHash } from "node:crypto";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import type { AuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import {
  deriveAssignmentAvailability,
  evaluateAssignmentMutation,
  isAssignmentMutationRequest,
  type AssignmentAvailabilityProjection,
  type AssignmentMutationDenial,
  type AssignmentMutationRequest,
} from "./assignment-policy.js";
import {
  withSqliteRoomAssignmentRepository,
  type RoomAssignmentRepository,
  type SqliteAssignmentRecord,
} from "./sqlite-assignment-repository.js";

export type RoomAssignmentServiceErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "gone"
  | "conflict"
  | "idempotency_conflict"
  | "storage_unavailable";

export class RoomAssignmentServiceError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 503,
    readonly code: RoomAssignmentServiceErrorCode,
  ) {
    super(`Room Assignment operation failed (${code})`);
    this.name = "RoomAssignmentServiceError";
  }
}

export interface RoomAssignmentCommandResult {
  readonly requestId: string;
  readonly changed: boolean;
  readonly roomRevision: number;
  readonly assignment: SqliteAssignmentRecord;
}

export interface AssignmentRevisionGateInput {
  readonly roomId: string;
  readonly assignmentId: string;
  readonly expectedProfileRevision: number;
  readonly expectedAssignmentRevision: number;
  readonly expectedAccessRevision: number;
  readonly providerReady: boolean;
}

export type AssignmentRevisionGateResult = Readonly<{
  current: false;
}> | Readonly<{
  current: true;
  availability: AssignmentAvailabilityProjection;
}>;

function fail(
  status: RoomAssignmentServiceError["status"],
  code: RoomAssignmentServiceErrorCode,
): never {
  throw new RoomAssignmentServiceError(status, code);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function timestamp(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) fail(400, "invalid_request");
  return new Date(now).toISOString();
}

function statusForDenial(reason: AssignmentMutationDenial): 403 | 409 {
  return reason === "forbidden" ? 403 : 409;
}

function parseReceipt(value: string): RoomAssignmentCommandResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail(503, "storage_unavailable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(503, "storage_unavailable");
  }
  const result = parsed as Record<string, unknown>;
  if (Object.keys(result).length !== 4 || typeof result.requestId !== "string" ||
      typeof result.changed !== "boolean" || typeof result.roomRevision !== "number" ||
      typeof result.assignment !== "object" || result.assignment === null) {
    return fail(503, "storage_unavailable");
  }
  return parsed as RoomAssignmentCommandResult;
}

function idempotencyScope(roomId: string, actorId: string): string {
  return `room-assignment:${roomId}:${actorId}`;
}

function auditId(request: AssignmentMutationRequest, actorId: string): string {
  return `assignment-audit:${sha256([request.roomId, actorId, request.requestId]).slice(0, 40)}`;
}

function assignmentId(request: AssignmentMutationRequest, actorId: string): string {
  return `assignment:${sha256([request.roomId, actorId, request.requestId]).slice(0, 40)}`;
}

function requireAuthenticatedRoom(
  repository: RoomAssignmentRepository,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
) {
  if (!repository.authenticate(context, now)) fail(401, "unauthenticated");
  const authority = repository.readRoomAuthority(context.principal.actorId, roomId);
  if (authority === undefined) fail(403, "forbidden");
  return authority;
}

function persistReceipt(
  repository: RoomAssignmentRepository,
  scope: string,
  request: AssignmentMutationRequest,
  requestHash: string,
  result: RoomAssignmentCommandResult,
  now: number,
): void {
  repository.insertReceipt({
    scope,
    key: request.requestId,
    requestHash,
    responseJson: JSON.stringify(result),
    statusCode: 200,
    createdAt: timestamp(now),
    expiresAt: timestamp(now + 24 * 60 * 60 * 1_000),
  });
}

function execute(
  repository: RoomAssignmentRepository,
  context: AuthenticatedSessionContext,
  request: AssignmentMutationRequest,
  now: number,
): RoomAssignmentCommandResult {
  const room = requireAuthenticatedRoom(repository, context, request.roomId, now);
  if (room.role !== "owner" && room.role !== "admin") fail(403, "forbidden");

  const scope = idempotencyScope(request.roomId, context.principal.actorId);
  const requestHash = sha256(request);
  const receipt = repository.readReceipt(scope, request.requestId);
  if (receipt !== undefined) {
    if (receipt.requestHash !== requestHash) fail(409, "idempotency_conflict");
    return parseReceipt(receipt.responseJson);
  }

  let current: SqliteAssignmentRecord | undefined;
  let profileId: string;
  if (request.kind === "create") {
    profileId = request.profileId!;
  } else {
    current = repository.readAssignment(request.roomId, request.assignmentId!);
    if (current === undefined) fail(404, "not_found");
    if (current.status === "removed") {
      if (request.kind !== "remove") fail(410, "gone");
      if (current.revision !== request.expectedAssignmentRevision) fail(409, "conflict");
      const stable = Object.freeze({
        requestId: request.requestId,
        changed: false,
        roomRevision: room.governanceRevision,
        assignment: current,
      });
      persistReceipt(repository, scope, request, requestHash, stable, now);
      return stable;
    }
    profileId = current.profileId;
  }
  const profile = repository.readProfile(profileId);
  if (profile === undefined) fail(404, "not_found");
  if (request.kind === "create") {
    current = repository.readCurrentAssignmentForActor(request.roomId, profile.actorId);
  }

  const decision = evaluateAssignmentMutation(request, {
    authenticatedActorKind: "human",
    roomRole: room.role,
    roomStatus: room.status,
    roomRevision: room.governanceRevision,
    profileStatus: profile.status,
    capabilityCeiling: profile.capabilityCeiling,
    toolCeiling: profile.toolCeiling,
    currentAssignment: current ?? null,
  });
  if (!decision.allowed) fail(statusForDenial(decision.reason),
    decision.reason === "forbidden" ? "forbidden" : "conflict");

  const changedAt = timestamp(now);
  if (current !== undefined &&
      ((request.kind === "pause" && current.paused) ||
       (request.kind === "resume" && !current.paused))) {
    const stable = Object.freeze({
      requestId: request.requestId,
      changed: false,
      roomRevision: room.governanceRevision,
      assignment: current,
    });
    persistReceipt(repository, scope, request, requestHash, stable, now);
    return stable;
  }

  let updated: SqliteAssignmentRecord;
  if (request.kind === "create") {
    updated = repository.insertAssignment({
      assignmentId: assignmentId(request, profile.actorId),
      roomId: request.roomId,
      profile,
      roomResponsibility: request.roomResponsibility!,
      participation: request.participation!,
      capabilitySubset: request.capabilitySubset!,
      toolSubset: request.toolSubset!,
      changedBy: context.principal.actorId,
      changedAt,
    });
  } else {
    const existing = current!;
    updated = repository.updateAssignment({
      assignment: existing,
      operation: request.kind,
      roomResponsibility: request.kind === "update"
        ? request.roomResponsibility!
        : existing.roomResponsibility,
      participation: request.kind === "update" ? request.participation! : existing.participation,
      paused: request.kind === "pause" || request.kind === "remove"
        ? true
        : request.kind === "resume" ? false : existing.paused,
      status: request.kind === "remove" ? "removed" : "current",
      capabilitySubset: request.kind === "update"
        ? request.capabilitySubset!
        : existing.capabilitySubset,
      toolSubset: request.kind === "update" ? request.toolSubset! : existing.toolSubset,
      changedBy: context.principal.actorId,
      changedAt,
    });
  }
  const roomRevision = repository.advanceRoomRevision(request.roomId, room.governanceRevision);
  repository.insertAudit({
    auditId: auditId(request, context.principal.actorId),
    roomId: request.roomId,
    actorId: context.principal.actorId,
    assignmentId: updated.assignmentId,
    assignmentActorId: updated.actorId,
    assignmentRevision: updated.revision,
    profileRevision: profile.revision,
    operation: request.kind,
    occurredAt: changedAt,
  });
  const result = Object.freeze({
    requestId: request.requestId,
    changed: true,
    roomRevision,
    assignment: updated,
  });
  persistReceipt(repository, scope, request, requestHash, result, now);
  return result;
}

export function executeRoomAssignmentCommandInTransaction(
  transaction: AuthorityTransactionView,
  context: AuthenticatedSessionContext,
  request: unknown,
  now: number,
): RoomAssignmentCommandResult {
  if (!isAssignmentMutationRequest(request) || transaction.roomId !== request.roomId) {
    return fail(400, "invalid_request");
  }
  try {
    return withSqliteRoomAssignmentRepository(transaction, (repository) =>
      execute(repository, context, request, now));
  } catch (error: unknown) {
    if (error instanceof RoomAssignmentServiceError) throw error;
    return fail(503, "storage_unavailable");
  }
}

export function listRoomAssignmentsInTransaction(
  transaction: AuthorityTransactionView,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
): readonly SqliteAssignmentRecord[] {
  if (transaction.roomId !== roomId) return fail(403, "forbidden");
  try {
    return withSqliteRoomAssignmentRepository(transaction, (repository) => {
      requireAuthenticatedRoom(repository, context, roomId, now);
      return repository.listAssignments(roomId);
    });
  } catch (error: unknown) {
    if (error instanceof RoomAssignmentServiceError) throw error;
    return fail(503, "storage_unavailable");
  }
}

export function readAssignmentRevisionGateInTransaction(
  transaction: AuthorityTransactionView,
  input: AssignmentRevisionGateInput,
): AssignmentRevisionGateResult {
  if (transaction.roomId !== input.roomId) return Object.freeze({ current: false as const });
  try {
    return withSqliteRoomAssignmentRepository(transaction, (repository) => {
      const authority = repository.readRuntimeAuthority(input.roomId, input.assignmentId);
      if (authority === undefined || authority.profileRevision !== input.expectedProfileRevision ||
          authority.assignment.revision !== input.expectedAssignmentRevision ||
          authority.accessRevision !== input.expectedAccessRevision) {
        return Object.freeze({ current: false as const });
      }
      return Object.freeze({
        current: true as const,
        availability: deriveAssignmentAvailability({
          profileEnabled: authority.profileEnabled,
          assignmentCurrent: authority.assignment.status === "current",
          roomActive: authority.roomActive,
          membershipCurrent: authority.accessValid,
          durablePaused: authority.assignment.paused,
          providerAuthenticated: input.providerReady,
          durableRunningExecutionCount: authority.runningExecutionCount,
        }),
      });
    });
  } catch {
    return Object.freeze({ current: false as const });
  }
}
