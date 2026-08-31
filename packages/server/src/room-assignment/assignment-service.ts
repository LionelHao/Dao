import { createHash } from "node:crypto";
import type { AuthenticatedSessionContext } from "../persistence/contracts.js";
import { IDEMPOTENCY_RECEIPT_TTL_MS } from
  "../persistence/idempotency-lifecycle.js";
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
  type AssignmentChangedProjection,
  type RoomAssignmentRepository,
  type SqliteAssignmentRecord,
} from "./sqlite-assignment-repository.js";
import {
  requireAssignmentExpansionAllowedInTransaction,
  requireAssignmentSecurityReductionAllowedInTransaction,
} from "./assignment-security-reduction-participant.js";
import { useAuthorityTransactionDatabase } from
  "../persistence/authority-transaction-database.js";
import { commitInternalScopedProducerInTransaction } from
  "../agent-runtime/internal-scoped-producer-authority.js";

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
  readonly assignmentId: string;
  readonly acceptedRevision: number;
  readonly roomRevision: number;
  readonly eventIds: readonly [string];
}

declare const assignmentProviderReadinessBrand: unique symbol;

export interface AssignmentProviderReadiness {
  readonly [assignmentProviderReadinessBrand]: true;
  readonly actorId: string;
  readonly providerAuthenticated: boolean;
  readonly observedAt: string;
}

const trustedProviderReadiness = new WeakSet<object>();

export function mintAssignmentProviderReadiness(input: Readonly<{
  actorId: string;
  providerAuthenticated: boolean;
  observedAt: string;
}>): AssignmentProviderReadiness {
  if (Object.keys(input).length !== 3 || !Object.hasOwn(input, "actorId") ||
      !Object.hasOwn(input, "providerAuthenticated") || !Object.hasOwn(input, "observedAt") ||
      typeof input.actorId !== "string" || input.actorId.trim().length === 0 ||
      typeof input.providerAuthenticated !== "boolean" ||
      typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new TypeError("Assignment Provider readiness is invalid");
  }
  const readiness = Object.freeze({ ...input });
  trustedProviderReadiness.add(readiness);
  return readiness as AssignmentProviderReadiness;
}

export interface AssignmentRevisionGateInput {
  readonly roomId: string;
  readonly assignmentId: string;
  readonly expectedProfileRevision: number;
  readonly expectedAssignmentRevision: number;
  readonly expectedAccessRevision: number;
  readonly providerReadiness: AssignmentProviderReadiness;
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
  if (Object.keys(result).length !== 6 || typeof result.requestId !== "string" ||
      result.requestId.trim().length === 0 || typeof result.changed !== "boolean" ||
      typeof result.assignmentId !== "string" || result.assignmentId.trim().length === 0 ||
      typeof result.acceptedRevision !== "number" ||
      !Number.isSafeInteger(result.acceptedRevision) || result.acceptedRevision < 1 ||
      typeof result.roomRevision !== "number" || !Number.isSafeInteger(result.roomRevision) ||
      result.roomRevision < 0 ||
      !Array.isArray(result.eventIds) || result.eventIds.length !== 1 ||
      typeof result.eventIds[0] !== "string" || result.eventIds[0].length === 0) {
    return fail(503, "storage_unavailable");
  }
  return parsed as RoomAssignmentCommandResult;
}

function idempotencyScope(request: AssignmentMutationRequest, actorId: string): string {
  return ["room-assignment", actorId, request.roomId, request.kind].join("\u0000");
}

function auditId(request: AssignmentMutationRequest, actorId: string): string {
  return `assignment-audit:${sha256([request.roomId, actorId, request.kind,
    request.idempotencyKey]).slice(0, 40)}`;
}

function assignmentId(request: AssignmentMutationRequest, actorId: string): string {
  return `assignment:${sha256([request.roomId, actorId, request.kind,
    request.idempotencyKey]).slice(0, 40)}`;
}

function requestFingerprint(request: AssignmentMutationRequest, actorId: string): string {
  const business = Object.fromEntries(Object.entries(request).filter(([key]) =>
    key !== "requestId" && key !== "idempotencyKey"));
  return sha256({ principalActorId: actorId, roomId: request.roomId,
    operation: request.kind, business });
}

function eventId(scope: string, key: string): string {
  return `assignment-event:${sha256([scope, key, "room.agent-assignment.changed"]).slice(0, 40)}`;
}

function outboxId(event: string): string {
  return `assignment-outbox:${sha256([event, "room"]).slice(0, 40)}`;
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
    key: request.idempotencyKey,
    requestHash,
    responseJson: JSON.stringify(result),
    statusCode: 200,
    createdAt: timestamp(now),
    expiresAt: timestamp(now + IDEMPOTENCY_RECEIPT_TTL_MS),
  });
}

function projection(
  assignment: SqliteAssignmentRecord,
  profile: Readonly<{
    revision: number;
    displayName: string;
    globalResponsibility: string;
    capabilityCeiling: readonly string[];
    toolCeiling: readonly string[];
  }>,
  accessRevision: number,
  availability: "ready" | "busy" | "paused" | "noauth",
  effectiveTools: readonly string[],
): AssignmentChangedProjection {
  return Object.freeze({
    recordVersion: "room-agent-assignment.v1" as const,
    assignmentId: assignment.assignmentId,
    roomId: assignment.roomId,
    profileId: assignment.profileId,
    actorId: assignment.actorId,
    displayName: profile.displayName,
    globalResponsibility: profile.globalResponsibility,
    roomResponsibility: assignment.roomResponsibility,
    participation: assignment.participation,
    availability,
    paused: assignment.paused,
    capabilityCeiling: profile.capabilityCeiling,
    capabilitySubset: assignment.capabilitySubset,
    effectiveCapabilities: assignment.capabilitySubset,
    toolCeiling: profile.toolCeiling,
    toolSubset: assignment.toolSubset,
    effectiveTools,
    profileRevision: profile.revision,
    assignmentRevision: assignment.revision,
    accessRevision,
    updatedAt: assignment.updatedAt,
  });
}

function completeCommand(
  repository: RoomAssignmentRepository,
  context: AuthenticatedSessionContext,
  request: AssignmentMutationRequest,
  requestHash: string,
  scope: string,
  assignment: SqliteAssignmentRecord,
  profile: Readonly<{
    revision: number;
    displayName: string;
    globalResponsibility: string;
    capabilityCeiling: readonly string[];
    toolCeiling: readonly string[];
  }>,
  accessRevision: number,
  changed: boolean,
  roomRevision: number,
  now: number,
  providerAuthenticated: boolean,
): RoomAssignmentCommandResult {
  const occurredAt = timestamp(now);
  const stableEventId = eventId(scope, request.idempotencyKey);
  repository.insertAudit({
    auditId: auditId(request, context.principal.actorId),
    roomId: request.roomId,
    actorId: context.principal.actorId,
    assignmentId: assignment.assignmentId,
    assignmentActorId: assignment.actorId,
    assignmentRevision: assignment.revision,
    profileRevision: profile.revision,
    operation: request.kind,
    occurredAt,
  });
  const runtime = repository.readRuntimeAuthority(request.roomId, assignment.assignmentId);
  if (runtime === undefined) fail(503, "storage_unavailable");
  const availability = deriveAssignmentAvailability({
    profileEnabled: runtime.profileEnabled,
    assignmentCurrent: runtime.assignment.status === "current",
    roomActive: runtime.roomActive,
    membershipCurrent: runtime.accessValid,
    durablePaused: runtime.assignment.paused,
    providerAuthenticated,
    durableRunningExecutionCount: runtime.runningExecutionCount,
  });
  const payload = availability.eligible
    ? Object.freeze({
        change: "upserted" as const,
        roomRevision,
        assignment: projection(
          assignment,
          profile,
          accessRevision,
          availability.availability,
          assignment.toolSubset.filter((tool) => runtime.membershipTools.includes(tool)),
        ),
      })
    : Object.freeze({
        change: "removed" as const,
        roomRevision,
        assignmentId: assignment.assignmentId,
        actorId: assignment.actorId,
        assignmentRevision: assignment.revision,
      });
  repository.appendChangedEvent({
    eventId: stableEventId,
    outboxId: outboxId(stableEventId),
    roomId: request.roomId,
    actorId: context.principal.actorId,
    payload,
    occurredAt,
  });
  const result = Object.freeze({
    requestId: request.requestId,
    changed,
    assignmentId: assignment.assignmentId,
    acceptedRevision: assignment.revision,
    roomRevision,
    eventIds: Object.freeze([stableEventId]) as readonly [string],
  });
  persistReceipt(repository, scope, request, requestHash, result, now);
  return result;
}

function execute(
  transaction: AuthorityTransactionView,
  repository: RoomAssignmentRepository,
  context: AuthenticatedSessionContext,
  request: AssignmentMutationRequest,
  now: number,
  providerAuthenticated: boolean,
): RoomAssignmentCommandResult {
  const room = requireAuthenticatedRoom(repository, context, request.roomId, now);
  if (room.role !== "owner" && room.role !== "admin") fail(403, "forbidden");

  const scope = idempotencyScope(request, context.principal.actorId);
  const requestHash = requestFingerprint(request, context.principal.actorId);
  const receipt = repository.readReceipt(scope, request.idempotencyKey, now);
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
      return fail(410, "gone");
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

  if (decision.securityReduction) {
    requireAssignmentSecurityReductionAllowedInTransaction(transaction, {
      roomId: request.roomId, expectedArchiveGeneration: room.archiveGeneration,
    });
    if (current === undefined) fail(503, "storage_unavailable");
    const authority = request.kind === "remove"
      ? { kind: "membership" as const, reason: "membership_revoked" as const,
          capability: "membership_authority" as const }
      : request.kind === "pause"
        ? { kind: "assignment" as const, reason: "assignment_revoked" as const,
            capability: "assignment_authority" as const }
        : { kind: "capability" as const, reason: "capability_revoked" as const,
            capability: "assignment_authority" as const };
    useAuthorityTransactionDatabase(transaction, (database) => {
      commitInternalScopedProducerInTransaction(database, {
        producerId: "room-assignment-authority",
        requestId: request.requestId,
        capability: authority.capability,
        actorId: context.principal.actorId,
        roomId: request.roomId,
        scope: { kind: "agent_authority", agentId: current!.actorId,
          authority: authority.kind, authorityRevision: current!.revision + 1 },
        reason: authority.reason,
        occurredAt: timestamp(now),
      });
    });
  } else if (!requireAssignmentExpansionAllowedInTransaction(transaction, {
    roomId: request.roomId, expectedArchiveGeneration: room.archiveGeneration,
  })) {
    fail(409, "conflict");
  }

  const changedAt = timestamp(now);
  if (current !== undefined &&
      ((request.kind === "pause" && current.paused) ||
       (request.kind === "resume" && !current.paused))) {
    const runtime = repository.readRuntimeAuthority(request.roomId, current.assignmentId);
    if (runtime === undefined) fail(503, "storage_unavailable");
    return completeCommand(
      repository, context, request, requestHash, scope, current, profile,
      runtime.accessRevision, false, room.governanceRevision, now, providerAuthenticated,
    );
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
  const accessRevision = repository.synchronizeMembershipProjection({
    assignment: updated,
    changedAt,
  });
  const roomRevision = repository.advanceRoomRevision(request.roomId, room.governanceRevision);
  repository.invalidateAssignmentContext({
    roomId: request.roomId,
    actorId: updated.actorId,
    invalidatedAt: changedAt,
  });
  return completeCommand(
    repository, context, request, requestHash, scope, updated, profile,
    accessRevision, true, roomRevision, now, providerAuthenticated,
  );
}

export function executeRoomAssignmentCommandInTransaction(
  transaction: AuthorityTransactionView,
  context: AuthenticatedSessionContext,
  request: unknown,
  now: number,
  providerAuthenticated = false,
): RoomAssignmentCommandResult {
  if (!isAssignmentMutationRequest(request) || transaction.roomId !== request.roomId) {
    return fail(400, "invalid_request");
  }
  try {
    return withSqliteRoomAssignmentRepository(transaction, (repository) =>
      execute(transaction, repository, context, request, now, providerAuthenticated));
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

export function getRoomAssignmentInTransaction(
  transaction: AuthorityTransactionView,
  context: AuthenticatedSessionContext,
  roomId: string,
  assignmentId: string,
  now: number,
): SqliteAssignmentRecord {
  if (transaction.roomId !== roomId || typeof assignmentId !== "string" ||
      assignmentId.trim().length === 0) return fail(403, "forbidden");
  try {
    return withSqliteRoomAssignmentRepository(transaction, (repository) => {
      requireAuthenticatedRoom(repository, context, roomId, now);
      const assignment = repository.readAssignment(roomId, assignmentId);
      if (assignment === undefined) return fail(404, "not_found");
      if (assignment.status === "removed") return fail(410, "gone");
      return assignment;
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
      if (!trustedProviderReadiness.has(input.providerReadiness) ||
          input.providerReadiness.actorId !== authority.assignment.actorId) {
        return fail(503, "storage_unavailable");
      }
      return Object.freeze({
        current: true as const,
        availability: deriveAssignmentAvailability({
          profileEnabled: authority.profileEnabled,
          assignmentCurrent: authority.assignment.status === "current",
          roomActive: authority.roomActive,
          membershipCurrent: authority.accessValid,
          durablePaused: authority.assignment.paused,
          providerAuthenticated: input.providerReadiness.providerAuthenticated,
          durableRunningExecutionCount: authority.runningExecutionCount,
        }),
      });
    });
  } catch (error: unknown) {
    if (error instanceof RoomAssignmentServiceError) throw error;
    return Object.freeze({ current: false as const });
  }
}
