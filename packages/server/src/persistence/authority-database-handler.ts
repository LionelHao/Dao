import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Actor,
  AgentExecution,
  ManagedRoom,
  Message,
  PersistedIdentityEvent,
  PersistedRoomEvent,
  RoomSyncRequest,
  RoomSyncResult,
} from "@native-im/core";
import {
  isManagedRoomShape,
  isRoomAuditRecord,
  type RoomAuditRecord,
} from "../room-lifecycle.js";
import {
  parsePersistedIdentityEvent,
  parsePersistedRoomEvent,
  parsePersistentCommand,
  ROOM_SYNC_DEFAULT_LIMIT,
  ROOM_SYNC_MAX_PAGE_BYTES,
  type AgentCollaborationCommand,
  type AgentInvocationInput,
  type AgentRuntimeRecovery,
  type AgentRuntimeRecoveryPage,
  type AgentRuntimeRecoveryPageInput,
  type AgentRuntimeProviderContext,
  type AgentRuntimeToolPlanEntry,
  type CommitExecutionStepInput,
  type CompleteExecutionInput,
  type CompleteCompensationInput,
  type FailExecutionInput,
  type ScheduleRetryInput,
  type InterruptExecutionInput,
  type PrepareToolInput,
  type ToolGrant,
  type ToolConfirmationInput,
  type ToolConfirmation,
  type ResumeConfirmedToolInput,
  type ResumedToolDispatch,
  type DispatchToolInput,
  type SettleToolInput,
  type ToolDispatch,
  type AgentRuntimeCompensationWork,
  type ResumeAgentRuntimeCompensationInput,
  type CancelForHumanFenceInput,
  type AgentWorkerCommandContext,
  type AgentRuntimeWorkerContext,
  type AuthenticatedCommandContext,
  type AuthenticatedSessionContext,
  type CommandAcknowledgement,
  type HumanCollaborationCommand,
  type JsonValue,
  type OutboxDelivery,
  type OutboxDeliveryFailureReason,
  type OutboxDispatchCandidate,
  type PersistentCommand,
  type RoomGovernanceCommand,
  type SnapshotRevalidationRequest,
} from "./contracts.js";
import type { AuthorityWorkerErrorCode } from "./worker-protocol.js";
import type {
  RepairMutationImpact,
  RepairScope,
} from "../fallback-repair-coordinator.js";
import type { SnapshotVersion } from "@native-im/core";

export class AuthorityDatabaseError extends Error {
  constructor(
    readonly code: AuthorityWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthorityDatabaseError";
  }
}

export interface ExecuteHumanDatabaseCommandInput {
  readonly context: AuthenticatedCommandContext;
  readonly command: HumanCollaborationCommand | RoomGovernanceCommand;
  readonly invitationSecret?: {
    readonly tokenHash: string;
    readonly sealedToken: string;
  };
  readonly now: number;
  readonly beforeApply?: (actorId: string) => void;
  readonly afterDomainWrite?: () => void;
  readonly beforeCommit?: () => void;
}

export interface ExecuteAgentDatabaseCommandInput {
  readonly context: AgentWorkerCommandContext;
  readonly command: AgentCollaborationCommand;
  readonly now: number;
  readonly beforeApply?: (actorId: string) => void;
}

export interface DatabaseCommandResult {
  readonly acknowledgement: CommandAcknowledgement;
  readonly disposition: "applied" | "replayed";
}

export interface InvokeAgentRuntimeDatabaseCommandInput {
  readonly context: AuthenticatedCommandContext | AgentWorkerCommandContext;
  readonly input: AgentInvocationInput;
  readonly now: number;
  readonly maxQueuedPerRoom?: number;
}

function fail(code: AuthorityWorkerErrorCode, message: string): never {
  throw new AuthorityDatabaseError(code, message);
}

function unreachableCommand(command: never): never {
  throw new TypeError(`Unreachable persistent command: ${String(command)}`);
}

export class AuthorityRollbackFatalError extends AggregateError {
  constructor(operationError: unknown, rollbackError: unknown) {
    super(
      [operationError, rollbackError],
      "Authority transaction rollback failed",
    );
    this.name = "AuthorityRollbackFatalError";
  }
}

export function runAuthorityImmediateTransaction<Result>(
  database: DatabaseSync,
  operation: () => Result,
  beforeCommit?: () => void,
): Result {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    beforeCommit?.();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError: unknown) {
      throw new AuthorityRollbackFatalError(error, rollbackError);
    }
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON rejects unsupported values");
}

function roomSyncResultWithinPageLimit<Result extends RoomSyncResult>(result: Result): Result {
  if (Buffer.byteLength(canonicalJson(result), "utf8") > ROOM_SYNC_MAX_PAGE_BYTES) {
    return fail("storage_unavailable", "Authority room sync result exceeds the page limit");
  }
  return result;
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("base64url");
}

function businessHash(command: PersistentCommand): string {
  return createHash("sha256").update(canonicalJson(command)).digest("base64url");
}

interface IdempotentCommandInput {
  readonly actorId: string;
  readonly command: PersistentCommand;
  readonly aggregateKind: "room" | "identity";
  readonly aggregateId: string;
  readonly idempotencyKey: string;
  readonly now: number;
  readonly beforeApply?: () => void;
  readonly execute: (
    acceptedAt: string,
    scope: string,
    idempotencyKey: string,
  ) => CommandAcknowledgement;
}

function executeIdempotently(
  database: DatabaseSync,
  input: IdempotentCommandInput,
): DatabaseCommandResult {
  const scope = [
    input.actorId,
    input.command.type,
    input.aggregateKind,
    input.aggregateId,
  ].join("\u0000");
  const requestHash = businessHash(input.command);
  const existing = database
    .prepare(
      `SELECT request_hash AS requestHash, response_json AS responseJson
       FROM idempotency_records WHERE scope = ? AND key = ?`,
    )
    .get(scope, input.idempotencyKey);
  if (existing !== undefined) {
    if (existing.requestHash !== requestHash) {
      return fail("idempotency_conflict", "Idempotency key payload changed");
    }
    if (typeof existing.responseJson !== "string") {
      return fail("storage_unavailable", "Stored idempotency acknowledgement is corrupt");
    }
    return {
      acknowledgement: parseStoredAcknowledgement(existing.responseJson),
      disposition: "replayed",
    };
  }
  input.beforeApply?.();
  const acceptedAt = new Date(input.now).toISOString();
  const acknowledgement = input.execute(
    acceptedAt,
    scope,
    input.idempotencyKey,
  );
  database
    .prepare(
      `INSERT INTO idempotency_records (
         scope, key, request_hash, response_json, status_code,
         created_at, expires_at
       ) VALUES (?, ?, ?, ?, 200, ?, ?)`,
    )
    .run(
      scope,
      input.idempotencyKey,
      requestHash,
      canonicalJson(acknowledgement),
      acceptedAt,
      new Date(input.now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    );
  return { acknowledgement, disposition: "applied" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredAcknowledgement(value: string): CommandAcknowledgement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail("storage_unavailable", "Stored idempotency acknowledgement is corrupt");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join("\u0000") !==
      ["acceptedAt", "aggregateId", "eventIds", "result"].sort().join("\u0000") ||
    typeof parsed.aggregateId !== "string" ||
    parsed.aggregateId.length === 0 ||
    !Array.isArray(parsed.eventIds) ||
    !parsed.eventIds.every((eventId) => typeof eventId === "string" && eventId.length > 0) ||
    typeof parsed.acceptedAt !== "string" ||
    parsed.acceptedAt.length === 0
  ) {
    return fail("storage_unavailable", "Stored idempotency acknowledgement is corrupt");
  }
  return parsed as unknown as CommandAcknowledgement;
}

function requireHumanSession(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  now: number,
): string {
  const session = database
    .prepare(
      `SELECT
         session.family_id AS familyId,
         session.account_id AS accountId,
         session.actor_id AS actorId,
         session.access_expires_at AS accessExpiresAt,
         session.revoked_at AS revokedAt,
         actor.kind AS actorKind
       FROM sessions AS session
       JOIN actors AS actor ON actor.id = session.actor_id
       WHERE session.access_token_hash = ?`,
    )
    .get(context.sessionId);
  if (session === undefined) {
    return fail("invalid_token", "Authority command session was rejected");
  }
  if (
    session.actorKind !== "human" ||
    session.familyId !== context.sessionFamilyId ||
    session.accountId !== context.principal.accountId ||
    session.actorId !== context.principal.actorId
  ) {
    return fail("identity_forbidden", "Authority command identity was rejected");
  }
  if (typeof session.revokedAt === "number") {
    return fail("session_revoked", "Authority command session was revoked");
  }
  if (
    typeof session.accessExpiresAt !== "number" ||
    now >= session.accessExpiresAt
  ) {
    return fail("token_expired", "Authority command session expired");
  }
  return context.principal.actorId;
}

export function revalidateSnapshotDatabaseQuery(
  database: DatabaseSync,
  validation: SnapshotRevalidationRequest,
  now: number,
): void {
  runAuthorityImmediateTransaction(database, () => {
    let actorId: string;
    try {
      actorId = requireHumanSession(database, validation.context, now);
    } catch (error: unknown) {
      if (error instanceof AuthorityDatabaseError && error.code === "identity_forbidden") {
        return fail("snapshot_forbidden", "Snapshot session family was rejected");
      }
      if (error instanceof AuthorityDatabaseError && error.code === "session_revoked") {
        const familyStillActive = database.prepare(
          `SELECT 1 AS present FROM sessions
           WHERE family_id = ? AND account_id = ? AND actor_id = ? AND revoked_at IS NULL
           LIMIT 1`,
        ).get(validation.context.sessionFamilyId,
          validation.context.principal.accountId, validation.context.principal.actorId);
        if (familyStillActive === undefined) {
          return fail("snapshot_family_revoked", "Snapshot session family was revoked");
        }
      }
      throw error;
    }
    if (validation.kind === "catalog") {
      const actor = database.prepare(
        "SELECT catalog_revision AS catalogRevision FROM actors WHERE id = ?",
      ).get(actorId);
      if (typeof actor?.catalogRevision !== "number") {
        return fail("snapshot_forbidden", "Snapshot catalog principal was rejected");
      }
      if (actor.catalogRevision !== validation.catalogRevision) {
        return fail("snapshot_stale", "Snapshot catalog revision changed");
      }
      return;
    }
    const room = database.prepare("SELECT status FROM rooms WHERE id = ?")
      .get(validation.roomId);
    if (room === undefined) {
      return fail("room_not_found", "Snapshot room was not found");
    }
    if (room.status !== "active") {
      return fail("room_archived", "Snapshot room is archived");
    }
    const membership = database.prepare(
      `SELECT access_revision AS accessRevision
       FROM room_memberships
       WHERE room_id = ? AND actor_id = ? AND kind = 'human'`,
    ).get(validation.roomId, actorId);
    if (membership === undefined) {
      return fail("room_forbidden", "Snapshot room membership was rejected");
    }
    if (membership.accessRevision !== validation.accessRevision) {
      return fail("snapshot_stale", "Snapshot room access revision changed");
    }
  });
}

export function inspectStreamingRepairScopeDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  scope: RepairScope,
  now: number,
): { readonly version: SnapshotVersion; readonly authorizationRevision: number } {
  return runAuthorityImmediateTransaction(database, () => {
    const actorId = requireHumanSession(database, context, now);
    if (scope.kind === "catalog") {
      if (scope.principalId !== actorId) {
        return fail("snapshot_forbidden", "Streaming catalog principal was rejected");
      }
      const actor = database.prepare(
        "SELECT catalog_revision AS catalogRevision FROM actors WHERE id = ?",
      ).get(actorId);
      if (typeof actor?.catalogRevision !== "number") {
        return fail("snapshot_forbidden", "Streaming catalog principal was rejected");
      }
      return {
        version: { kind: "catalog", catalogRevision: actor.catalogRevision },
        authorizationRevision: actor.catalogRevision,
      };
    }
    const row = database.prepare(
      `SELECT room.status AS roomStatus,
              membership.access_revision AS accessRevision,
              stream.head_seq AS watermark
       FROM rooms AS room
       JOIN room_memberships AS membership ON membership.room_id = room.id
       JOIN streams AS stream ON stream.stream_kind = 'room' AND stream.stream_id = room.id
       WHERE room.id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
    ).get(scope.roomId, actorId);
    if (row === undefined) {
      const room = database.prepare("SELECT status FROM rooms WHERE id = ?")
        .get(scope.roomId);
      if (room === undefined) return fail("room_not_found", "Streaming room was not found");
      return fail("room_forbidden", "Streaming room membership was rejected");
    }
    if (row.roomStatus !== "active") {
      return fail("room_archived", "Streaming room is archived");
    }
    if (typeof row.accessRevision !== "number" || typeof row.watermark !== "number") {
      return fail("storage_unavailable", "Streaming room version is corrupt");
    }
    return {
      version: { kind: "room", roomId: scope.roomId, watermark: row.watermark },
      authorizationRevision: row.accessRevision,
    };
  });
}

export function validateHumanSessionDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  now: number,
): string {
  return runAuthorityImmediateTransaction(database, () =>
    requireHumanSession(database, context, now));
}

export function repairMutationImpactDatabaseQuery(
  database: DatabaseSync,
  actorId: string,
  command: HumanCollaborationCommand | RoomGovernanceCommand | AgentCollaborationCommand,
): RepairMutationImpact {
  if (command.type === "room.create") {
    return { roomIds: [], catalogPrincipalIds: [actorId] };
  }
  let roomId: string;
  if (command.type === "human.invitation.decide") {
    const invitation = invitationByToken(database, command.payload.token);
    if (typeof invitation.roomId !== "string") {
      return fail("storage_unavailable", "Authority invitation is corrupt");
    }
    roomId = invitation.roomId;
  } else {
    roomId = command.roomId;
  }
  let catalogPrincipalIds: readonly string[] = [];
  if (command.type === "room.rename" || command.type === "room.archive") {
    catalogPrincipalIds = database.prepare(
      `SELECT actor_id AS actorId FROM room_memberships
       WHERE room_id = ? AND kind = 'human' ORDER BY actor_id`,
    ).all(roomId).map((row) => String(row.actorId));
  } else if (command.type === "human.invitation.decide" &&
      command.payload.decision === "accept") {
    catalogPrincipalIds = [actorId];
  } else if (command.type === "human.role.change" || command.type === "member.remove") {
    catalogPrincipalIds = [command.payload.targetActorId];
  }
  return { roomIds: [roomId], catalogPrincipalIds };
}

export function readHistoryDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
): readonly Message[] {
  const actorId = requireHumanSession(database, context, now);
  requireRoomMembership(database, actorId, roomId);
  return database.prepare(
    `SELECT id, room_id AS roomId, author_id AS authorId,
            author_kind AS authorKind, body, sent_at AS sentAt
     FROM messages WHERE room_id = ? ORDER BY sent_at, id`,
  ).all(roomId).map((row) => {
    if (typeof row.id !== "string" || typeof row.roomId !== "string" ||
        typeof row.authorId !== "string" ||
        (row.authorKind !== "human" && row.authorKind !== "agent") ||
        typeof row.body !== "string" || typeof row.sentAt !== "string") {
      return fail("storage_unavailable", "Authority message history is corrupt");
    }
    return {
      id: row.id,
      roomId: row.roomId,
      authorId: row.authorId,
      authorKind: row.authorKind,
      body: row.body,
      sentAt: row.sentAt,
    };
  });
}

function runAuthorityReadTransaction<Result>(
  database: DatabaseSync,
  operation: () => Result,
): Result {
  database.exec("BEGIN");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError: unknown) {
      throw new AuthorityRollbackFatalError(error, rollbackError);
    }
    throw error;
  }
}

function requireActiveHumanRoomMembership(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): void {
  const row = database.prepare(
    `SELECT room.status AS roomStatus
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.room_id = ?
       AND membership.actor_id = ?
       AND membership.kind = 'human'`,
  ).get(roomId, actorId);
  if (row?.roomStatus !== "active") {
    fail("room_forbidden", "Authority room sync access was rejected");
  }
}

function parseRoomSyncEvent(row: Record<string, unknown>): PersistedRoomEvent {
  let payload: unknown;
  try {
    payload = typeof row.payloadJson === "string"
      ? JSON.parse(row.payloadJson) as unknown
      : undefined;
  } catch {
    return fail("storage_unavailable", "Stored room sync event is corrupt");
  }
  const parsed = parsePersistedRoomEvent({
    eventId: row.eventId,
    streamKind: row.streamKind,
    streamId: row.streamId,
    streamSeq: row.streamSeq,
    roomId: row.roomId,
    actorId: row.actorId,
    occurredAt: row.occurredAt,
    type: row.eventType,
    payload,
  });
  return parsed.ok
    ? parsed.value
    : fail("storage_unavailable", "Stored room sync event is corrupt");
}

export function syncRoomDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  request: RoomSyncRequest,
  now: number,
): RoomSyncResult {
  return runAuthorityReadTransaction(database, () => {
    const actorId = requireHumanSession(database, context, now);
    requireActiveHumanRoomMembership(database, actorId, request.roomId);
    const stream = database.prepare(
      `SELECT head_seq AS headSeq, retained_from_seq AS retainedFromSeq
       FROM streams WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(request.roomId);
    if (
      typeof stream?.headSeq !== "number" ||
      !Number.isSafeInteger(stream.headSeq) ||
      stream.headSeq < 0 ||
      typeof stream.retainedFromSeq !== "number" ||
      !Number.isSafeInteger(stream.retainedFromSeq) ||
      stream.retainedFromSeq < 1 ||
      stream.retainedFromSeq > stream.headSeq + 1
    ) {
      return fail("storage_unavailable", "Authority room stream is corrupt");
    }
    const currentHeadSeq = stream.headSeq;
    const retainedFromSeq = stream.retainedFromSeq;
    if (request.cursor === undefined) {
      return roomSyncResultWithinPageLimit({
        type: "room.sync.result",
        requestId: request.requestId,
        mode: "repair_required",
        reason: "cursor_absent",
        retainedFromSeq,
        watermark: currentHeadSeq,
      });
    }
    if (
      request.cursor.roomId !== request.roomId ||
      request.cursor.afterSeq > currentHeadSeq ||
      (request.cursor.watermark !== undefined &&
        request.cursor.watermark > currentHeadSeq)
    ) {
      return fail("invalid_request", "Authority room sync cursor was rejected");
    }
    if (request.cursor.afterSeq < retainedFromSeq - 1) {
      return roomSyncResultWithinPageLimit({
        type: "room.sync.result",
        requestId: request.requestId,
        mode: "repair_required",
        reason: "cursor_expired",
        retainedFromSeq,
        watermark: currentHeadSeq,
      });
    }
    const watermark = request.cursor.watermark ?? currentHeadSeq;

    const limit = request.limit ?? ROOM_SYNC_DEFAULT_LIMIT;
    const rows = database.prepare(
      `SELECT event_id AS eventId, stream_kind AS streamKind,
              stream_id AS streamId, stream_seq AS streamSeq, room_id AS roomId,
              actor_id AS actorId, event_type AS eventType,
              occurred_at AS occurredAt, payload_json AS payloadJson
       FROM events
       WHERE stream_kind = 'room' AND stream_id = ?
         AND stream_seq > ? AND stream_seq <= ?
       ORDER BY stream_seq
       LIMIT ?`,
    ).all(request.roomId, request.cursor.afterSeq, watermark, limit);
    const events: PersistedRoomEvent[] = [];
    let expectedSeq = request.cursor.afterSeq + 1;
    let eventBytesTotal = 0;
    for (const row of rows) {
      const event = parseRoomSyncEvent(row);
      if (
        event.streamSeq !== expectedSeq ||
        event.streamId !== request.roomId ||
        event.roomId !== request.roomId
      ) {
        return fail("storage_unavailable", "Authority room sync sequence is corrupt");
      }
      const eventBytes = Buffer.byteLength(canonicalJson(event), "utf8");
      if (eventBytes > ROOM_SYNC_MAX_PAGE_BYTES) {
        return fail("storage_unavailable", "Authority room sync event exceeds the page limit");
      }
      const candidateAfterSeq = event.streamSeq;
      const candidateHasMore = candidateAfterSeq < watermark;
      const candidateWithoutEvents = {
        type: "room.sync.result" as const,
        requestId: request.requestId,
        mode: "delta" as const,
        events: [],
        nextCursor: {
          version: 1 as const,
          roomId: request.roomId,
          afterSeq: candidateAfterSeq,
          ...(candidateHasMore ? { watermark } : {}),
        },
        watermark,
        hasMore: candidateHasMore,
      };
      const envelopeBytes = Buffer.byteLength(canonicalJson(candidateWithoutEvents), "utf8") - 2;
      const candidateEventsBytes = 2 + eventBytesTotal + eventBytes + events.length;
      if (envelopeBytes + candidateEventsBytes > ROOM_SYNC_MAX_PAGE_BYTES) {
        if (events.length === 0) {
          return fail("storage_unavailable", "Authority room sync result exceeds the page limit");
        }
        break;
      }
      events.push(event);
      eventBytesTotal += eventBytes;
      expectedSeq += 1;
    }
    const afterSeq = events.at(-1)?.streamSeq ?? request.cursor.afterSeq;
    if (events.length === 0 && afterSeq < watermark) {
      return fail("storage_unavailable", "Authority room sync sequence is corrupt");
    }
    const hasMore = afterSeq < watermark;
    return roomSyncResultWithinPageLimit({
      type: "room.sync.result",
      requestId: request.requestId,
      mode: "delta",
      events,
      nextCursor: {
        version: 1,
        roomId: request.roomId,
        afterSeq,
        ...(hasMore ? { watermark } : {}),
      },
      watermark,
      hasMore,
    });
  });
}

export function compactRoomStreamDatabaseCommand(
  database: DatabaseSync,
  roomId: string,
  retainedFromSeq: number,
): { readonly retainedFromSeq: number; readonly headSeq: number } {
  return runAuthorityImmediateTransaction(database, () => {
    const room = database.prepare("SELECT status FROM rooms WHERE id = ?").get(roomId);
    if (room === undefined) {
      return fail("room_not_found", "Authority room was not found");
    }
    if (room.status === "archived") {
      return fail("room_archived", "Authority archived room cannot be compacted");
    }
    if (room.status !== "active") {
      return fail("storage_unavailable", "Authority room is corrupt");
    }
    const stream = database.prepare(
      `SELECT head_seq AS headSeq, retained_from_seq AS currentRetainedFromSeq
       FROM streams
       WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(roomId);
    if (
      typeof stream?.headSeq !== "number" ||
      !Number.isSafeInteger(stream.headSeq) ||
      typeof stream.currentRetainedFromSeq !== "number" ||
      !Number.isSafeInteger(stream.currentRetainedFromSeq)
    ) {
      return fail("storage_unavailable", "Authority room stream is corrupt");
    }
    if (
      retainedFromSeq < stream.currentRetainedFromSeq ||
      retainedFromSeq > stream.headSeq + 1
    ) {
      return fail("invalid_request", "Authority room stream retention was rejected");
    }
    const pendingDelivery = database.prepare(
      `SELECT 1 AS present
       FROM outbox_deliveries AS delivery
       JOIN events AS event ON event.event_id = delivery.event_id
       WHERE event.stream_kind = 'room' AND event.stream_id = ?
         AND event.stream_seq < ? AND delivery.status <> 'dispatched'
       LIMIT 1`,
    ).get(roomId, retainedFromSeq);
    if (pendingDelivery?.present === 1) {
      return fail(
        "room_compaction_blocked",
        "Authority room stream compaction is waiting for pending delivery",
      );
    }
    database.prepare(
      `UPDATE streams SET retained_from_seq = ?
       WHERE stream_kind = 'room' AND stream_id = ?`,
    ).run(retainedFromSeq, roomId);
    database.prepare(
      `DELETE FROM outbox_deliveries
       WHERE status = 'dispatched' AND event_id IN (
         SELECT event_id FROM events
         WHERE stream_kind = 'room' AND stream_id = ? AND stream_seq < ?
       )`,
    ).run(roomId, retainedFromSeq);
    database.prepare(
      `DELETE FROM events
       WHERE stream_kind = 'room' AND stream_id = ? AND stream_seq < ?`,
    ).run(roomId, retainedFromSeq);
    return { retainedFromSeq, headSeq: stream.headSeq };
  });
}

export function readActorDatabaseQuery(
  database: DatabaseSync,
  actorId: string,
): Actor | undefined {
  const row = database.prepare(
    `SELECT id, kind, display_name AS displayName, reachability, readiness,
            tool_permissions_json AS toolPermissionsJson
     FROM actors WHERE id = ?`,
  ).get(actorId);
  if (row === undefined) {
    return undefined;
  }
  if (typeof row.id !== "string" || typeof row.displayName !== "string") {
    return fail("storage_unavailable", "Authority actor is corrupt");
  }
  if (row.kind === "human" &&
      (row.reachability === "online" || row.reachability === "dnd" || row.reachability === "offline")) {
    return {
      id: row.id,
      kind: "human",
      displayName: row.displayName,
      reachability: row.reachability,
    };
  }
  if (row.kind === "agent" &&
      (row.readiness === "ready" || row.readiness === "busy" ||
       row.readiness === "paused" || row.readiness === "noauth") &&
      typeof row.toolPermissionsJson === "string") {
    const toolPermissions: unknown = JSON.parse(row.toolPermissionsJson);
    if (Array.isArray(toolPermissions) &&
        toolPermissions.every((permission) => typeof permission === "string")) {
      return {
        id: row.id,
        kind: "agent",
        displayName: row.displayName,
        readiness: row.readiness,
        toolPermissions,
      };
    }
  }
  return fail("storage_unavailable", "Authority actor is corrupt");
}

export function readRoomDatabaseQuery(
  database: DatabaseSync,
  roomId: string,
): ManagedRoom | undefined {
  const exists = database.prepare("SELECT 1 AS present FROM rooms WHERE id = ?").get(roomId);
  if (exists?.present !== 1) {
    return undefined;
  }
  const room = readManagedRoom(database, roomId);
  return isManagedRoomShape(room)
    ? room
    : fail("storage_unavailable", "Authority room is corrupt");
}

export function canAccessRoomDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
): boolean {
  const actorId = requireHumanSession(database, context, now);
  const membership = database.prepare(
    `SELECT room.status AS roomStatus
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.room_id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
  ).get(roomId, actorId);
  return membership?.roomStatus === "active";
}

export function readRoomAuditDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
): readonly RoomAuditRecord[] {
  const actorId = requireHumanSession(database, context, now);
  requireRoomMembership(database, actorId, roomId);
  return database.prepare(
    `SELECT id, type, room_id AS roomId, actor_id AS actorId,
            result, timestamp, details_json AS detailsJson
     FROM room_audit WHERE room_id = ? ORDER BY rowid`,
  ).all(roomId).map((row) => {
    if (typeof row.detailsJson !== "string") {
      return fail("storage_unavailable", "Authority room audit is corrupt");
    }
    const details: unknown = JSON.parse(row.detailsJson);
    if (typeof details !== "object" || details === null || Array.isArray(details)) {
      return fail("storage_unavailable", "Authority room audit is corrupt");
    }
    const envelopeKeys = new Set(["id", "type", "roomId", "actorId", "result", "timestamp"]);
    if (Object.keys(details).some((key) => envelopeKeys.has(key))) {
      return fail("storage_unavailable", "Authority room audit is corrupt");
    }
    const record: unknown = {
      id: row.id,
      type: row.type,
      roomId: row.roomId,
      actorId: row.actorId,
      result: row.result,
      timestamp: row.timestamp,
      ...details,
    };
    if (!isRoomAuditRecord(record)) {
      return fail("storage_unavailable", "Authority room audit is corrupt");
    }
    return record;
  });
}

function parseOutboxEvent(row: Record<string, unknown>): PersistedRoomEvent | PersistedIdentityEvent {
  let payload: unknown;
  try {
    payload = typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson) : undefined;
  } catch {
    return fail("storage_unavailable", "Stored outbox event payload is corrupt");
  }
  const envelope = {
    eventId: row.eventId,
    streamKind: row.streamKind,
    streamId: row.streamId,
    streamSeq: row.streamSeq,
    actorId: row.actorId,
    occurredAt: row.occurredAt,
    type: row.eventType,
    payload,
  };
  if (row.streamKind === "room") {
    const parsed = parsePersistedRoomEvent({ ...envelope, roomId: row.roomId });
    if (parsed.ok) return parsed.value;
  } else if (row.streamKind === "identity") {
    const parsed = parsePersistedIdentityEvent(envelope);
    if (parsed.ok) return parsed.value;
  }
  return fail("storage_unavailable", "Stored outbox event is corrupt");
}

function isSessionRevokedEvent(
  event: PersistedIdentityEvent,
): event is PersistedIdentityEvent & { readonly type: "identity.session.revoked" } {
  return event.type === "identity.session.revoked";
}

function isRoomAccessChangedEvent(
  event: PersistedIdentityEvent,
): event is PersistedIdentityEvent & { readonly type: "identity.room-access.changed" } {
  return event.type === "identity.room-access.changed";
}

export function listPendingOutboxDatabaseQuery(
  database: DatabaseSync,
  limit: number,
  now: number,
): readonly OutboxDelivery[] {
  const rows = database
    .prepare(
      `SELECT
         delivery.id AS deliveryId,
         delivery.event_id AS eventId,
         delivery.target_kind AS targetKind,
         delivery.target_id AS targetId,
         delivery.stream_seq AS streamSeq,
         delivery.attempts,
         event.stream_kind AS streamKind,
         event.stream_id AS streamId,
         event.room_id AS roomId,
         event.actor_id AS actorId,
         event.event_type AS eventType,
         event.occurred_at AS occurredAt,
         event.payload_json AS payloadJson
       FROM outbox_deliveries AS delivery
       JOIN events AS event
         ON event.event_id = delivery.event_id
        AND event.stream_seq = delivery.stream_seq
       WHERE delivery.status = 'pending'
         AND delivery.available_at <= ?
       ORDER BY delivery.stream_seq, delivery.id
       LIMIT ?`,
    )
    .all(new Date(now).toISOString(), limit) as Record<string, unknown>[];
  return rows.map((row) => {
    if (
      typeof row.deliveryId !== "string" ||
      typeof row.eventId !== "string" ||
      (row.targetKind !== "room" &&
        row.targetKind !== "principal" &&
        row.targetKind !== "session-family") ||
      typeof row.targetId !== "string" ||
      typeof row.streamSeq !== "number" ||
      !Number.isSafeInteger(row.streamSeq) ||
      row.streamSeq < 1 ||
      typeof row.attempts !== "number" ||
      !Number.isSafeInteger(row.attempts) ||
      row.attempts < 0
    ) {
      return fail("storage_unavailable", "Stored outbox delivery is corrupt");
    }
    const event = parseOutboxEvent(row);
    if (event.eventId !== row.eventId || event.streamSeq !== row.streamSeq) {
      return fail("storage_unavailable", "Stored outbox delivery event does not match");
    }
    if (
      row.targetKind === "room" &&
      event.streamKind === "room" &&
      event.roomId === row.targetId
    ) {
      return {
        deliveryId: row.deliveryId,
        eventId: row.eventId,
        targetKind: "room",
        targetId: row.targetId,
        streamSeq: row.streamSeq,
        attempts: row.attempts,
        event,
      };
    }
    if (
      row.targetKind === "principal" &&
      event.streamKind === "identity" &&
      isRoomAccessChangedEvent(event) &&
      event.streamId === row.targetId
    ) {
      return {
        deliveryId: row.deliveryId,
        eventId: row.eventId,
        targetKind: "principal",
        targetId: row.targetId,
        streamSeq: row.streamSeq,
        attempts: row.attempts,
        event,
      };
    }
    if (
      row.targetKind === "session-family" &&
      event.streamKind === "identity" &&
      isSessionRevokedEvent(event) &&
      event.payload.familyId === row.targetId
    ) {
      return {
        deliveryId: row.deliveryId,
        eventId: row.eventId,
        targetKind: "session-family",
        targetId: row.targetId,
        streamSeq: row.streamSeq,
        attempts: row.attempts,
        event,
      };
    }
    return fail("storage_unavailable", "Stored outbox target does not match its event stream");
  });
}

export function authorizeOutboxCandidateDatabaseQuery(
  database: DatabaseSync,
  deliveryId: string,
  candidate: OutboxDispatchCandidate,
  now: number,
): boolean {
  const delivery = database
    .prepare(
      `SELECT target_kind AS targetKind, target_id AS targetId
       FROM outbox_deliveries
       WHERE id = ? AND status = 'pending'`,
    )
    .get(deliveryId);
  if (
    typeof delivery?.targetKind !== "string" ||
    typeof delivery.targetId !== "string"
  ) {
    return false;
  }
  if (delivery.targetKind === "session-family") {
    return candidate.sessionFamilyId === delivery.targetId;
  }
  const sessionParameters = [
    candidate.sessionId,
    candidate.sessionFamilyId,
    candidate.principal.accountId,
    candidate.principal.actorId,
    now,
  ] as const;
  if (delivery.targetKind === "principal") {
    if (candidate.principal.actorId !== delivery.targetId) return false;
    return database
      .prepare(
        `SELECT 1 AS allowed
         FROM sessions AS session
         JOIN actors AS actor ON actor.id = session.actor_id
         WHERE session.access_token_hash = ?
           AND session.family_id = ?
           AND session.account_id = ?
           AND session.actor_id = ?
           AND session.access_expires_at > ?
           AND session.revoked_at IS NULL
           AND actor.kind = 'human'`,
      )
      .get(...sessionParameters)?.allowed === 1;
  }
  if (delivery.targetKind !== "room") return false;
  return database
    .prepare(
      `SELECT 1 AS allowed
       FROM sessions AS session
       JOIN actors AS actor ON actor.id = session.actor_id
       JOIN room_memberships AS membership ON membership.actor_id = session.actor_id
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE session.access_token_hash = ?
         AND session.family_id = ?
         AND session.account_id = ?
         AND session.actor_id = ?
         AND session.access_expires_at > ?
         AND session.revoked_at IS NULL
         AND actor.kind = 'human'
         AND membership.room_id = ?
         AND room.status = 'active'`,
    )
    .get(...sessionParameters, delivery.targetId)?.allowed === 1;
}

export function markOutboxDispatchedDatabaseCommand(
  database: DatabaseSync,
  deliveryId: string,
  now: number,
): void {
  const result = database
    .prepare(
      `UPDATE outbox_deliveries
       SET status = 'dispatched', delivered_at = ?, last_error = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .run(new Date(now).toISOString(), deliveryId);
  if (result.changes === 0) {
    const existing = database
      .prepare("SELECT status FROM outbox_deliveries WHERE id = ?")
      .get(deliveryId);
    if (existing?.status !== "dispatched") {
      return fail("storage_unavailable", "Authority outbox delivery does not exist");
    }
  }
}

export function markOutboxFailedDatabaseCommand(
  database: DatabaseSync,
  deliveryId: string,
  reason: OutboxDeliveryFailureReason,
): void {
  const result = database
    .prepare(
      `UPDATE outbox_deliveries
       SET attempts = attempts + 1, last_error = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(reason, deliveryId);
  if (result.changes === 0) {
    const existing = database
      .prepare("SELECT status FROM outbox_deliveries WHERE id = ?")
      .get(deliveryId);
    if (existing?.status !== "dispatched") {
      return fail("storage_unavailable", "Authority outbox delivery does not exist");
    }
  }
}

function requireRoomMembership(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): void {
  const membership = database
    .prepare(
      `SELECT room.status AS roomStatus
       FROM room_memberships AS membership
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE membership.room_id = ? AND membership.actor_id = ?`,
    )
    .get(roomId, actorId);
  if (membership?.roomStatus !== "active") {
    fail("room_forbidden", "Authority room access was rejected");
  }
}

function requireRoomManager(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): { readonly roomStatus: string; readonly role: string } {
  const membership = database
    .prepare(
      `SELECT room.status AS roomStatus, membership.role
       FROM room_memberships AS membership
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE membership.room_id = ?
         AND membership.actor_id = ?
         AND membership.kind = 'human'`,
    )
    .get(roomId, actorId);
  if (
    typeof membership?.roomStatus !== "string" ||
    (membership.role !== "owner" && membership.role !== "admin")
  ) {
    return fail("room_forbidden", "Authority room governance was rejected");
  }
  return { roomStatus: membership.roomStatus, role: membership.role };
}

function requireRoomOwner(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): { readonly roomStatus: string } {
  const manager = requireRoomManager(database, actorId, roomId);
  if (manager.role !== "owner") {
    return fail("room_forbidden", "Authority room owner permission was rejected");
  }
  return { roomStatus: manager.roomStatus };
}

function invitationByToken(
  database: DatabaseSync,
  token: string,
): Record<string, unknown> {
  const tokenHash = createHash("sha256").update(token).digest("base64url");
  const invitation = database
    .prepare(
      `SELECT
         id, room_id AS roomId, inviter_actor_id AS inviterActorId,
         invitee_actor_id AS inviteeActorId, status, created_at AS createdAt,
         decision_actor_id AS decisionActorId, decided_at AS decidedAt
       FROM room_invitations WHERE token_hash = ?`,
    )
    .get(tokenHash);
  if (invitation === undefined) {
    return fail("invitation_not_found", "Authority invitation was not found");
  }
  return invitation;
}

function readManagedRoom(database: DatabaseSync, roomId: string): JsonValue {
  const row = database
    .prepare(
      `SELECT id, name, status, created_at AS createdAt
       FROM rooms WHERE id = ?`,
    )
    .get(roomId);
  if (
    typeof row?.id !== "string" ||
    typeof row.name !== "string" ||
    (row.status !== "active" && row.status !== "archived") ||
    typeof row.createdAt !== "string"
  ) {
    return fail("room_not_found", "Authority room was not found");
  }
  const members = database
    .prepare(
      `SELECT
         actor_id AS actorId, kind, role, participation,
         tool_permissions_json AS toolPermissionsJson,
         joined_at AS joinedAt, configured_at AS configuredAt
       FROM room_memberships WHERE room_id = ? ORDER BY rowid`,
    )
    .all(roomId)
    .map((member) => {
      if (
        member.kind === "human" &&
        typeof member.actorId === "string" &&
        (member.role === "owner" || member.role === "admin" || member.role === "member") &&
        typeof member.joinedAt === "string"
      ) {
        return {
          kind: "human",
          actorId: member.actorId,
          role: member.role,
          joinedAt: member.joinedAt,
        };
      }
      if (
        member.kind === "agent" &&
        typeof member.actorId === "string" &&
        (member.participation === "active" ||
          member.participation === "on-mention" ||
          member.participation === "silent") &&
        typeof member.toolPermissionsJson === "string" &&
        typeof member.configuredAt === "string"
      ) {
        const toolPermissions: unknown = JSON.parse(member.toolPermissionsJson);
        if (
          !Array.isArray(toolPermissions) ||
          !toolPermissions.every((permission) => typeof permission === "string")
        ) {
          return fail("storage_unavailable", "Authority membership is corrupt");
        }
        return {
          kind: "agent",
          actorId: member.actorId,
          participation: member.participation,
          toolPermissions,
          configuredAt: member.configuredAt,
        };
      }
      return fail("storage_unavailable", "Authority membership is corrupt");
    });
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    members,
    createdAt: row.createdAt,
  };
}

function appendRoomEvent(
  database: DatabaseSync,
  input: {
    readonly eventId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly eventType: string;
    readonly occurredAt: string;
    readonly payload: JsonValue;
  },
): number {
  const stream = database
    .prepare(
      `SELECT head_seq AS headSeq FROM streams
       WHERE stream_kind = 'room' AND stream_id = ?`,
    )
    .get(input.roomId);
  if (typeof stream?.headSeq !== "number") {
    return fail("storage_unavailable", "Authority room stream is missing");
  }
  const streamSeq = stream.headSeq + 1;
  database
    .prepare(
      `UPDATE streams SET head_seq = ?
       WHERE stream_kind = 'room' AND stream_id = ?`,
    )
    .run(streamSeq, input.roomId);
  database
    .prepare(
      `INSERT INTO events (
         event_id, stream_kind, stream_id, stream_seq, room_id,
         actor_id, event_type, occurred_at, payload_json
       ) VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventId,
      input.roomId,
      streamSeq,
      input.roomId,
      input.actorId,
      input.eventType,
      input.occurredAt,
      canonicalJson(input.payload),
    );
  return streamSeq;
}

function appendRoomOutbox(
  database: DatabaseSync,
  eventId: string,
  roomId: string,
  streamSeq: number,
  occurredAt: string,
  scope: string,
  key: string,
): void {
  database
    .prepare(
      `INSERT INTO outbox_deliveries (
         id, event_id, target_kind, target_id, stream_seq, status,
         attempts, available_at, delivered_at, last_error
       ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)`,
    )
    .run(
      stableId("outbox", scope, key, eventId, "room", roomId),
      eventId,
      roomId,
      streamSeq,
      occurredAt,
    );
}

type IdentityEventTypeAndPayload<Event extends PersistedIdentityEvent = PersistedIdentityEvent> =
  Event extends PersistedIdentityEvent
    ? {
        readonly eventType: Event["type"];
        readonly payload: Event["payload"];
      }
    : never;

export type CanonicalIdentityEventInput = {
  readonly eventId: string | ((canonicalPayloadJson: string) => string);
  readonly principalId: string;
  readonly occurredAt: string;
} & IdentityEventTypeAndPayload;

export function appendCanonicalIdentityEvent(
  database: DatabaseSync,
  input: CanonicalIdentityEventInput,
): number {
  const payloadJson = canonicalJson(input.payload);
  const eventId = typeof input.eventId === "function"
    ? input.eventId(payloadJson)
    : input.eventId;
  const stream = database
    .prepare(
      `SELECT head_seq AS headSeq FROM streams
       WHERE stream_kind = 'identity' AND stream_id = ?`,
    )
    .get(input.principalId);
  if (typeof stream?.headSeq !== "number") {
    return fail("storage_unavailable", "Authority identity stream is missing");
  }
  const streamSeq = stream.headSeq + 1;
  database
    .prepare(
      `UPDATE streams SET head_seq = ?
       WHERE stream_kind = 'identity' AND stream_id = ?`,
    )
    .run(streamSeq, input.principalId);
  database
    .prepare(
      `INSERT INTO events (
         event_id, stream_kind, stream_id, stream_seq, room_id,
         actor_id, event_type, occurred_at, payload_json
       ) VALUES (?, 'identity', ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      input.principalId,
      streamSeq,
      input.principalId,
      input.eventType,
      input.occurredAt,
      payloadJson,
    );
  return streamSeq;
}

function appendPrincipalOutbox(
  database: DatabaseSync,
  eventId: string,
  principalId: string,
  streamSeq: number,
  occurredAt: string,
  scope: string,
  key: string,
): void {
  database
    .prepare(
      `INSERT INTO outbox_deliveries (
         id, event_id, target_kind, target_id, stream_seq, status,
         attempts, available_at, delivered_at, last_error
       ) VALUES (?, ?, 'principal', ?, ?, 'pending', 0, ?, NULL, NULL)`,
    )
    .run(
      stableId("outbox", scope, key, eventId, "principal", principalId),
      eventId,
      principalId,
      streamSeq,
      occurredAt,
    );
}

function executeRoomCreate(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "room.create" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const roomId = stableId("room", scope, key);
  const roomEventId = stableId("event", scope, key, "0");
  const identityEventId = stableId("event", scope, key, "1");
  const membership = {
    kind: "human" as const,
    actorId,
    role: "owner" as const,
    joinedAt: acceptedAt,
  };
  const room = {
    id: roomId,
    name: command.payload.name,
    status: "active" as const,
    members: [membership],
    createdAt: acceptedAt,
  };
  database
    .prepare(
      `INSERT INTO rooms (id, name, status, created_at)
       VALUES (?, ?, 'active', ?)`,
    )
    .run(roomId, room.name, acceptedAt);
  database
    .prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, 'human', 'owner', NULL, '[]', ?, NULL, 0)`,
    )
    .run(roomId, actorId, acceptedAt);
  database
    .prepare(
      `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
       VALUES ('room', ?, 0, 1)`,
    )
    .run(roomId);
  database
    .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
    .run(actorId);
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.created', ?, ?, 'created', ?, '{}')`,
    )
    .run(stableId("audit", scope, key), roomId, actorId, acceptedAt);
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId,
    actorId,
    eventType: "room.created",
    occurredAt: acceptedAt,
    payload: { room } as unknown as JsonValue,
  });
  appendRoomOutbox(database, roomEventId, roomId, roomSeq, acceptedAt, scope, key);
  const identitySeq = appendCanonicalIdentityEvent(database, {
    eventId: identityEventId,
    principalId: actorId,
    eventType: "identity.room-access.changed",
    occurredAt: acceptedAt,
    payload: { roomId, change: "joined" },
  });
  appendPrincipalOutbox(
    database,
    identityEventId,
    actorId,
    identitySeq,
    acceptedAt,
    scope,
    key,
  );
  return {
    aggregateId: roomId,
    eventIds: [roomEventId, identityEventId],
    acceptedAt,
    result: { room } as unknown as JsonValue,
  };
}

function appendCatalogEvents(
  database: DatabaseSync,
  input: {
    readonly roomId: string;
    readonly change: "updated" | "archived";
    readonly acceptedAt: string;
    readonly scope: string;
    readonly key: string;
    readonly startIndex: number;
  },
): readonly string[] {
  const humans = database
    .prepare(
      `SELECT actor_id AS actorId FROM room_memberships
       WHERE room_id = ? AND kind = 'human' ORDER BY actor_id`,
    )
    .all(input.roomId);
  const eventIds: string[] = [];
  for (const [offset, row] of humans.entries()) {
    if (typeof row.actorId !== "string") {
      return fail("storage_unavailable", "Authority human membership is corrupt");
    }
    database
      .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
      .run(row.actorId);
    const eventId = stableId(
      "event",
      input.scope,
      input.key,
      String(input.startIndex + offset),
    );
    const streamSeq = appendCanonicalIdentityEvent(database, {
      eventId,
      principalId: row.actorId,
      eventType: "identity.room-access.changed",
      occurredAt: input.acceptedAt,
      payload: { roomId: input.roomId, change: input.change },
    });
    appendPrincipalOutbox(
      database,
      eventId,
      row.actorId,
      streamSeq,
      input.acceptedAt,
      input.scope,
      input.key,
    );
    eventIds.push(eventId);
  }
  return eventIds;
}

function executeRenameOrArchive(
  database: DatabaseSync,
  actorId: string,
  command: Extract<
    RoomGovernanceCommand,
    { readonly type: "room.rename" | "room.archive" }
  >,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const manager = requireRoomManager(database, actorId, command.roomId);
  if (manager.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  if (command.type === "room.rename") {
    database.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(
      command.payload.name,
      command.roomId,
    );
  } else {
    database.prepare("UPDATE rooms SET status = 'archived' WHERE id = ?").run(
      command.roomId,
    );
  }
  const eventType = command.type === "room.rename" ? "room.renamed" : "room.archived";
  const auditType = eventType;
  const auditResult = command.type === "room.rename" ? "renamed" : "archived";
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, '{}')`,
    )
    .run(
      stableId("audit", scope, key),
      auditType,
      command.roomId,
      actorId,
      auditResult,
      acceptedAt,
    );
  const room = readManagedRoom(database, command.roomId);
  const roomEventId = stableId("event", scope, key, "0");
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId: command.roomId,
    actorId,
    eventType,
    occurredAt: acceptedAt,
    payload: { room },
  });
  appendRoomOutbox(
    database,
    roomEventId,
    command.roomId,
    roomSeq,
    acceptedAt,
    scope,
    key,
  );
  const catalogEventIds = appendCatalogEvents(database, {
    roomId: command.roomId,
    change: command.type === "room.rename" ? "updated" : "archived",
    acceptedAt,
    scope,
    key,
    startIndex: 1,
  });
  return {
    aggregateId: command.roomId,
    eventIds: [roomEventId, ...catalogEventIds],
    acceptedAt,
    result: { room },
  };
}

function executeAgentConfigure(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "agent.configure" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const manager = requireRoomManager(database, actorId, command.roomId);
  if (manager.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  const agent = database
    .prepare(
      `SELECT kind, tool_permissions_json AS toolPermissionsJson
       FROM actors WHERE id = ?`,
    )
    .get(command.payload.agentId);
  if (agent?.kind !== "agent" || typeof agent.toolPermissionsJson !== "string") {
    return fail("agent_required", "Authority Agent configuration was rejected");
  }
  const allowed: unknown = JSON.parse(agent.toolPermissionsJson);
  if (
    !Array.isArray(allowed) ||
    !command.payload.toolPermissions.every((permission) => allowed.includes(permission))
  ) {
    return fail("agent_permissions_invalid", "Authority Agent permissions were rejected");
  }
  const existing = database
    .prepare(
      `SELECT access_revision AS accessRevision
       FROM room_memberships WHERE room_id = ? AND actor_id = ?`,
    )
    .get(command.roomId, command.payload.agentId);
  const accessRevision = typeof existing?.accessRevision === "number"
    ? existing.accessRevision + 1
    : 1;
  database
    .prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, 'agent', NULL, ?, ?, NULL, ?, ?)
       ON CONFLICT(room_id, actor_id) DO UPDATE SET
         kind = 'agent', role = NULL, participation = excluded.participation,
         tool_permissions_json = excluded.tool_permissions_json,
         joined_at = NULL, configured_at = excluded.configured_at,
         access_revision = excluded.access_revision`,
    )
    .run(
      command.roomId,
      command.payload.agentId,
      command.payload.participation,
      canonicalJson(command.payload.toolPermissions),
      acceptedAt,
      accessRevision,
    );
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.agent.configured', ?, ?, 'configured', ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      command.roomId,
      actorId,
      acceptedAt,
      canonicalJson({
        targetActorId: command.payload.agentId,
        participation: command.payload.participation,
        toolPermissions: command.payload.toolPermissions,
      }),
    );
  const room = readManagedRoom(database, command.roomId);
  const membership = (room as { readonly members: readonly JsonValue[] }).members.find(
    (candidate) =>
      isRecord(candidate) && candidate.actorId === command.payload.agentId,
  );
  if (membership === undefined) {
    return fail("storage_unavailable", "Configured Agent membership is missing");
  }
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "agent.configured",
    occurredAt: acceptedAt,
    payload: { membership },
  });
  appendRoomOutbox(
    database,
    eventId,
    command.roomId,
    streamSeq,
    acceptedAt,
    scope,
    key,
  );
  const identityEventId = stableId("event", scope, key, "1");
  appendCanonicalIdentityEvent(database, {
    eventId: identityEventId,
    principalId: command.payload.agentId,
    eventType: "identity.room-access.changed",
    occurredAt: acceptedAt,
    payload: {
      roomId: command.roomId,
      change: existing === undefined ? "joined" : "updated",
    },
  });
  return {
    aggregateId: command.roomId,
    eventIds: [eventId, identityEventId],
    acceptedAt,
    result: { room },
  };
}

function executeInvitationIssue(
  database: DatabaseSync,
  actorId: string,
  command: Extract<
    RoomGovernanceCommand,
    { readonly type: "human.invitation.issue" }
  >,
  invitationSecret: {
    readonly tokenHash: string;
    readonly sealedToken: string;
  } | undefined,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const manager = requireRoomManager(database, actorId, command.roomId);
  if (manager.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  if (invitationSecret === undefined) {
    return fail(
      "invitation_secret_unavailable",
      "Invitation secret protection is unavailable",
    );
  }
  const invitee = database
    .prepare("SELECT kind FROM actors WHERE id = ?")
    .get(command.payload.inviteeActorId);
  if (invitee?.kind !== "human") {
    return fail("invitee_required", "Invitation target must be human");
  }
  if (
    database
      .prepare(
        `SELECT 1 FROM room_memberships
         WHERE room_id = ? AND actor_id = ?`,
      )
      .get(command.roomId, command.payload.inviteeActorId) !== undefined
  ) {
    return fail("room_member_exists", "Invitation target is already a room member");
  }
  if (
    database
      .prepare(
        `SELECT 1 FROM room_invitations
         WHERE room_id = ? AND invitee_actor_id = ? AND status = 'pending'`,
      )
      .get(command.roomId, command.payload.inviteeActorId) !== undefined
  ) {
    return fail("invitation_pending", "A pending invitation already exists");
  }
  const invitationId = stableId("invitation", scope, key);
  database
    .prepare(
      `INSERT INTO room_invitations (
         id, room_id, inviter_actor_id, invitee_actor_id, token_hash, status,
         created_at, decision_actor_id, decided_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
    )
    .run(
      invitationId,
      command.roomId,
      actorId,
      command.payload.inviteeActorId,
      invitationSecret.tokenHash,
      acceptedAt,
    );
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.human.invited', ?, ?, 'pending', ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      command.roomId,
      actorId,
      acceptedAt,
      canonicalJson({
        targetActorId: command.payload.inviteeActorId,
        invitationId,
      }),
    );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "human.invitation.issued",
    occurredAt: acceptedAt,
    payload: {
      invitationId,
      inviteeActorId: command.payload.inviteeActorId,
    },
  });
  appendRoomOutbox(
    database,
    eventId,
    command.roomId,
    streamSeq,
    acceptedAt,
    scope,
    key,
  );
  return {
    aggregateId: invitationId,
    eventIds: [eventId],
    acceptedAt,
    result: {
      invitation: {
        invitationId,
        roomId: command.roomId,
        inviterActorId: actorId,
        inviteeActorId: command.payload.inviteeActorId,
        sealedToken: invitationSecret.sealedToken,
        createdAt: acceptedAt,
      },
    },
  };
}

function executeInvitationDecision(
  database: DatabaseSync,
  actorId: string,
  command: Extract<
    RoomGovernanceCommand,
    { readonly type: "human.invitation.decide" }
  >,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const invitation = invitationByToken(database, command.payload.token);
  if (invitation.inviteeActorId !== actorId) {
    return fail("invitation_forbidden", "Authority invitation identity was rejected");
  }
  if (invitation.status !== "pending") {
    return fail("invitation_consumed", "Authority invitation was already consumed");
  }
  if (typeof invitation.id !== "string" || typeof invitation.roomId !== "string") {
    return fail("storage_unavailable", "Authority invitation is corrupt");
  }
  const room = database.prepare("SELECT status FROM rooms WHERE id = ?").get(invitation.roomId);
  if (command.payload.decision === "accept" && room?.status !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  database
    .prepare(
      `UPDATE room_invitations
       SET status = ?, decision_actor_id = ?, decided_at = ?
       WHERE id = ?`,
    )
    .run(
      command.payload.decision === "accept" ? "accepted" : "rejected",
      actorId,
      acceptedAt,
      invitation.id,
    );
  let membership: JsonValue | undefined;
  if (command.payload.decision === "accept") {
    if (
      database
        .prepare("SELECT 1 FROM room_memberships WHERE room_id = ? AND actor_id = ?")
        .get(invitation.roomId, actorId) !== undefined
    ) {
      return fail("room_member_exists", "Invitation target is already a room member");
    }
    database
      .prepare(
        `INSERT INTO room_memberships (
           room_id, actor_id, kind, role, participation, tool_permissions_json,
           joined_at, configured_at, access_revision
         ) VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 0)`,
      )
      .run(invitation.roomId, actorId, acceptedAt);
    database
      .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
      .run(actorId);
    membership = {
      kind: "human",
      actorId,
      role: "member",
      joinedAt: acceptedAt,
    };
  }
  const accepted = command.payload.decision === "accept";
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      accepted ? "room.invitation.accepted" : "room.invitation.rejected",
      invitation.roomId,
      actorId,
      accepted ? "accepted" : "rejected",
      acceptedAt,
      canonicalJson({
        targetActorId: actorId,
        inviterActorId: invitation.inviterActorId,
        invitationId: invitation.id,
      }),
    );
  const roomEventId = stableId("event", scope, key, "0");
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId: invitation.roomId,
    actorId,
    eventType: accepted
      ? "human.invitation.accepted"
      : "human.invitation.rejected",
    occurredAt: acceptedAt,
    payload: accepted
      ? { invitationId: invitation.id, membership: membership as JsonValue }
      : { invitationId: invitation.id, targetActorId: actorId },
  });
  appendRoomOutbox(
    database,
    roomEventId,
    invitation.roomId,
    roomSeq,
    acceptedAt,
    scope,
    key,
  );
  const eventIds = [roomEventId];
  if (accepted) {
    const identityEventId = stableId("event", scope, key, "1");
    const identitySeq = appendCanonicalIdentityEvent(database, {
      eventId: identityEventId,
      principalId: actorId,
      eventType: "identity.room-access.changed",
      occurredAt: acceptedAt,
      payload: { roomId: invitation.roomId, change: "joined" },
    });
    appendPrincipalOutbox(
      database,
      identityEventId,
      actorId,
      identitySeq,
      acceptedAt,
      scope,
      key,
    );
    eventIds.push(identityEventId);
  }
  return {
    aggregateId: invitation.id,
    eventIds,
    acceptedAt,
    result: {
      invitation: {
        id: invitation.id,
        roomId: invitation.roomId,
        inviterActorId: invitation.inviterActorId as JsonValue,
        inviteeActorId: actorId,
        status: accepted ? "accepted" : "rejected",
        createdAt: invitation.createdAt as JsonValue,
        decisionActorId: actorId,
        decidedAt: acceptedAt,
      },
    },
  };
}

function executeHumanRoleChange(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "human.role.change" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const owner = requireRoomOwner(database, actorId, command.roomId);
  if (owner.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  const target = database
    .prepare(
      `SELECT kind, role, joined_at AS joinedAt
       FROM room_memberships WHERE room_id = ? AND actor_id = ?`,
    )
    .get(command.roomId, command.payload.targetActorId);
  if (target?.kind !== "human" || typeof target.joinedAt !== "string") {
    return fail("room_member_not_found", "Authority human member was not found");
  }
  if (target.role === "owner") {
    return fail("room_owner_required", "Authority room owner cannot be reassigned");
  }
  database
    .prepare(
      `UPDATE room_memberships
       SET role = ?, access_revision = access_revision + 1
       WHERE room_id = ? AND actor_id = ?`,
    )
    .run(command.payload.role, command.roomId, command.payload.targetActorId);
  database
    .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
    .run(command.payload.targetActorId);
  const membership = {
    kind: "human",
    actorId: command.payload.targetActorId,
    role: command.payload.role,
    joinedAt: target.joinedAt,
  };
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.member.role.changed', ?, ?, 'role-changed', ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      command.roomId,
      actorId,
      acceptedAt,
      canonicalJson({
        targetActorId: command.payload.targetActorId,
        role: command.payload.role,
      }),
    );
  const roomEventId = stableId("event", scope, key, "0");
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId: command.roomId,
    actorId,
    eventType: "human.role.changed",
    occurredAt: acceptedAt,
    payload: { membership },
  });
  appendRoomOutbox(database, roomEventId, command.roomId, roomSeq, acceptedAt, scope, key);
  const identityEventId = stableId("event", scope, key, "1");
  const identitySeq = appendCanonicalIdentityEvent(database, {
    eventId: identityEventId,
    principalId: command.payload.targetActorId,
    eventType: "identity.room-access.changed",
    occurredAt: acceptedAt,
    payload: { roomId: command.roomId, change: "updated" },
  });
  appendPrincipalOutbox(
    database,
    identityEventId,
    command.payload.targetActorId,
    identitySeq,
    acceptedAt,
    scope,
    key,
  );
  return {
    aggregateId: command.roomId,
    eventIds: [roomEventId, identityEventId],
    acceptedAt,
    result: { room: readManagedRoom(database, command.roomId) },
  };
}

function executeMemberRemove(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "member.remove" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const manager = requireRoomManager(database, actorId, command.roomId);
  if (manager.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  const target = database
    .prepare(
      `SELECT kind, role FROM room_memberships
       WHERE room_id = ? AND actor_id = ?`,
    )
    .get(command.roomId, command.payload.targetActorId);
  if (target === undefined || (target.kind !== "human" && target.kind !== "agent")) {
    return fail("room_member_not_found", "Authority room member was not found");
  }
  if (target.kind === "human" && target.role === "owner") {
    return fail("room_owner_required", "Authority room owner cannot be removed");
  }
  database
    .prepare("DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?")
    .run(command.roomId, command.payload.targetActorId);
  if (target.kind === "human") {
    database
      .prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?")
      .run(command.payload.targetActorId);
  }
  database
    .prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, 'room.member.removed', ?, ?, 'removed', ?, ?)`,
    )
    .run(
      stableId("audit", scope, key),
      command.roomId,
      actorId,
      acceptedAt,
      canonicalJson({ targetActorId: command.payload.targetActorId }),
    );
  const roomEventId = stableId("event", scope, key, "0");
  const roomSeq = appendRoomEvent(database, {
    eventId: roomEventId,
    roomId: command.roomId,
    actorId,
    eventType: "member.removed",
    occurredAt: acceptedAt,
    payload: { targetActorId: command.payload.targetActorId },
  });
  appendRoomOutbox(database, roomEventId, command.roomId, roomSeq, acceptedAt, scope, key);
  const eventIds = [roomEventId];
  {
    const identityEventId = stableId("event", scope, key, "1");
    const identitySeq = appendCanonicalIdentityEvent(database, {
      eventId: identityEventId,
      principalId: command.payload.targetActorId,
      eventType: "identity.room-access.changed",
      occurredAt: acceptedAt,
      payload: { roomId: command.roomId, change: "removed" },
    });
    if (target.kind === "human") {
      appendPrincipalOutbox(
        database,
        identityEventId,
        command.payload.targetActorId,
        identitySeq,
        acceptedAt,
        scope,
        key,
      );
    }
    eventIds.push(identityEventId);
  }
  return {
    aggregateId: command.roomId,
    eventIds,
    acceptedAt,
    result: { room: readManagedRoom(database, command.roomId) },
  };
}

function executeMessageSend(
  database: DatabaseSync,
  actorId: string,
  command: Extract<
    HumanCollaborationCommand | AgentCollaborationCommand,
    { readonly type: "message.send" }
  >,
  acceptedAt: string,
  eventId: string,
  scope: string,
  key: string,
  afterDomainWrite?: () => void,
): CommandAcknowledgement {
  requireRoomMembership(database, actorId, command.roomId);
  const actor = database.prepare("SELECT kind FROM actors WHERE id = ?").get(actorId);
  if (actor?.kind !== "human" && actor?.kind !== "agent") {
    return fail("identity_forbidden", "Message author identity was rejected");
  }
  const message: Message = {
    ...command.payload,
    authorId: actorId,
    authorKind: actor.kind,
  };
  database
    .prepare(
      `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.id,
      message.roomId,
      message.authorId,
      message.authorKind,
      message.body,
      message.sentAt,
    );
  afterDomainWrite?.();
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: message.roomId,
    actorId,
    eventType: "room.message.accepted",
    occurredAt: acceptedAt,
    payload: message as unknown as JsonValue,
  });
  appendRoomOutbox(
    database,
    eventId,
    message.roomId,
    streamSeq,
    acceptedAt,
    scope,
    key,
  );
  return {
    aggregateId: message.id,
    eventIds: [eventId],
    acceptedAt,
    result: { message: message as unknown as JsonValue },
  };
}

function executeHumanRead(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand, { readonly type: "human.read.record" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const message = database
    .prepare("SELECT room_id AS roomId FROM messages WHERE id = ?")
    .get(command.payload.messageId);
  if (message?.roomId !== command.roomId) {
    return fail("message_not_found", "Authority room message was not found");
  }
  const receiptId = stableId("human-read", scope, key);
  database
    .prepare(
      `INSERT INTO human_read_receipts (room_id, actor_id, message_id, read_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(command.roomId, actorId, command.payload.messageId, acceptedAt);
  const receipt = {
    id: receiptId,
    messageId: command.payload.messageId,
    readerId: actorId,
    readAt: acceptedAt,
  };
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.human_read.recorded",
    occurredAt: acceptedAt,
    payload: receipt,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: receiptId,
    eventIds: [eventId],
    acceptedAt,
    result: { receipt },
  };
}

function roomMessageAuthor(
  database: DatabaseSync,
  roomId: string,
  messageId: string,
): string {
  const message = database
    .prepare("SELECT room_id AS roomId, author_id AS authorId FROM messages WHERE id = ?")
    .get(messageId);
  if (message?.roomId !== roomId || typeof message.authorId !== "string") {
    return fail("message_not_found", "Authority room message was not found");
  }
  return message.authorId;
}

function requireAssignedRoomMember(
  database: DatabaseSync,
  roomId: string,
  actorId: string,
): void {
  const member = database
    .prepare("SELECT 1 AS present FROM room_memberships WHERE room_id = ? AND actor_id = ?")
    .get(roomId, actorId);
  if (member?.present !== 1) {
    return fail("member_not_found", "Authority open-item owner is not a room member");
  }
}

function executeOpenItemCreate(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand | AgentCollaborationCommand, { readonly type: "open-item.create" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const requesterId = roomMessageAuthor(
    database,
    command.roomId,
    command.payload.sourceMessageId,
  );
  requireAssignedRoomMember(database, command.roomId, command.payload.ownerId);
  const item = {
    id: stableId("open-item", scope, key),
    roomId: command.roomId,
    sourceMessageId: command.payload.sourceMessageId,
    requesterId,
    ownerId: command.payload.ownerId,
    content: command.payload.content,
    status: "pending_response" as const,
    createdAt: acceptedAt,
    transferChain: [] as readonly JsonValue[],
  };
  database
    .prepare(
      `INSERT INTO open_items (
         id, room_id, source_message_id, assigned_actor_id, status, body,
         created_at, resolved_at, requester_actor_id, transfer_chain_json, responded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, '[]', NULL)`,
    )
    .run(
      item.id,
      item.roomId,
      item.sourceMessageId,
      item.ownerId,
      item.status,
      item.content,
      item.createdAt,
      item.requesterId,
    );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.open_item.changed",
    occurredAt: acceptedAt,
    payload: item,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: item.id,
    eventIds: [eventId],
    acceptedAt,
    result: { item },
  };
}

function executeOpenItemTransition(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand | AgentCollaborationCommand, { readonly type: "open-item.transition" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const row = database
    .prepare(
      `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
              requester_actor_id AS requesterId, assigned_actor_id AS ownerId,
              body AS content, status, created_at AS createdAt,
              responded_at AS respondedAt, transfer_chain_json AS transferChainJson
       FROM open_items WHERE id = ?`,
    )
    .get(command.payload.itemId);
  if (row?.roomId !== command.roomId || typeof row.id !== "string" ||
      typeof row.sourceMessageId !== "string" || typeof row.requesterId !== "string" ||
      typeof row.ownerId !== "string" || typeof row.content !== "string" ||
      typeof row.createdAt !== "string" || typeof row.transferChainJson !== "string") {
    return fail("open_item_not_found", "Authority open item was not found");
  }
  const parsedTransfers: unknown = JSON.parse(row.transferChainJson);
  if (!Array.isArray(parsedTransfers)) {
    return fail("storage_unavailable", "Authority open item transfer chain is corrupt");
  }
  let ownerId = row.ownerId;
  let status: "responded" | "deferred" | "transferred";
  let respondedAt = typeof row.respondedAt === "string" ? row.respondedAt : undefined;
  let transferChain = parsedTransfers as JsonValue[];
  if (command.payload.action === "transfer") {
    const targetId = command.payload.targetId;
    const reason = command.payload.reason;
    if (targetId === undefined || reason === undefined) {
      return fail("invalid_request", "Authority open item transfer was rejected");
    }
    requireAssignedRoomMember(database, command.roomId, targetId);
    status = "transferred";
    transferChain = [
      ...transferChain,
      {
        fromId: ownerId,
        toId: targetId,
        reason,
        transferredAt: acceptedAt,
      },
    ];
    ownerId = targetId;
  } else {
    status = command.payload.action === "respond" ? "responded" : "deferred";
    if (status === "responded") {
      respondedAt = acceptedAt;
    }
  }
  const item = {
    id: row.id,
    roomId: command.roomId,
    sourceMessageId: row.sourceMessageId,
    requesterId: row.requesterId,
    ownerId,
    content: row.content,
    status,
    createdAt: row.createdAt,
    ...(respondedAt === undefined ? {} : { respondedAt }),
    transferChain,
  };
  database
    .prepare(
      `UPDATE open_items
       SET assigned_actor_id = ?, status = ?, resolved_at = ?,
           transfer_chain_json = ?, responded_at = ?
       WHERE id = ?`,
    )
    .run(
      ownerId,
      status,
      status === "responded" ? acceptedAt : null,
      canonicalJson(transferChain),
      respondedAt ?? null,
      row.id,
    );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.open_item.changed",
    occurredAt: acceptedAt,
    payload: item,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: row.id,
    eventIds: [eventId],
    acceptedAt,
    result: { item },
  };
}

function executeCalibrationRecord(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand, { readonly type: "calibration.record" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const source = database.prepare(
    `SELECT room_id AS roomId, author_id AS authorId, author_kind AS authorKind
     FROM messages WHERE id = ?`,
  ).get(command.payload.sourceMessageId);
  if (source?.roomId !== command.roomId || source.authorKind !== "agent" ||
      typeof source.authorId !== "string") {
    return fail(
      "calibration_source_invalid",
      "Authority calibration must reference an Agent message",
    );
  }
  const signal = {
    id: stableId("calibration", scope, key),
    sourceMessageId: command.payload.sourceMessageId,
    actorId,
    agentId: source.authorId,
    emoji: command.payload.emoji,
    createdAt: acceptedAt,
  };
  database.prepare(
    `INSERT INTO calibration_signals (
       id, room_id, agent_id, judgment_id, signal, created_at,
       source_message_id, actor_id
     ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    signal.id,
    command.roomId,
    signal.agentId,
    signal.emoji,
    signal.createdAt,
    signal.sourceMessageId,
    signal.actorId,
  );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.calibration.recorded",
    occurredAt: acceptedAt,
    payload: signal,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: signal.id,
    eventIds: [eventId],
    acceptedAt,
    result: { signal },
  };
}

function recheckHumanCommandAuthority(
  database: DatabaseSync,
  actorId: string,
  command: HumanCollaborationCommand | RoomGovernanceCommand,
): void {
  if (command.type === "room.create") {
    return;
  }
  if (command.type === "human.invitation.decide") {
    const invitation = invitationByToken(database, command.payload.token);
    if (invitation.inviteeActorId !== actorId) {
      return fail("invitation_forbidden", "Authority invitation identity was rejected");
    }
    return;
  }
  if (command.type === "human.role.change") {
    requireRoomOwner(database, actorId, command.roomId);
    return;
  }
  if (
    command.type === "room.rename" ||
    command.type === "room.archive" ||
    command.type === "human.invitation.issue" ||
    command.type === "agent.configure" ||
    command.type === "member.remove"
  ) {
    requireRoomManager(database, actorId, command.roomId);
    return;
  }
  requireRoomMembership(database, actorId, command.roomId);
}

function requireAgentCommandAuthority(
  database: DatabaseSync,
  agentId: string,
  roomId: string,
): void {
  const membership = database
    .prepare(
      `SELECT actor.kind AS actorKind, room.status AS roomStatus
       FROM room_memberships AS membership
       JOIN actors AS actor ON actor.id = membership.actor_id
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE membership.room_id = ?
         AND membership.actor_id = ?
         AND membership.kind = 'agent'`,
    )
    .get(roomId, agentId);
  if (membership?.actorKind !== "agent" || membership.roomStatus !== "active") {
    return fail("room_forbidden", "Authority Agent room access was rejected");
  }
}

function executeAgentJudgment(
  database: DatabaseSync,
  agentId: string,
  command: Extract<AgentCollaborationCommand, { readonly type: "agent.judgment.record" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const message = database
    .prepare("SELECT room_id AS roomId FROM messages WHERE id = ?")
    .get(command.payload.messageId);
  if (message?.roomId !== command.roomId) {
    return fail("message_not_found", "Authority room message was not found");
  }
  const judgmentId = stableId("agent-judgment", scope, key);
  const judgment = {
    id: judgmentId,
    messageId: command.payload.messageId,
    agentId,
    outcome: command.payload.outcome,
    reason: command.payload.reason,
    decidedAt: acceptedAt,
  };
  database
    .prepare(
      `INSERT INTO agent_judgments (
         id, room_id, agent_id, message_id, judgment_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      judgmentId,
      command.roomId,
      agentId,
      command.payload.messageId,
      canonicalJson(judgment),
      acceptedAt,
    );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId: agentId,
    eventType: "room.agent_judgment.recorded",
    occurredAt: acceptedAt,
    payload: judgment,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: judgmentId,
    eventIds: [eventId],
    acceptedAt,
    result: { judgment },
  };
}

function requireAgentToolPermission(
  database: DatabaseSync,
  roomId: string,
  agentId: string,
  toolName: string,
): void {
  const row = database.prepare(
    `SELECT tool_permissions_json AS toolPermissionsJson
     FROM room_memberships
     WHERE room_id = ? AND actor_id = ? AND kind = 'agent'`,
  ).get(roomId, agentId);
  if (typeof row?.toolPermissionsJson !== "string") {
    return fail("room_forbidden", "Authority Agent room access was rejected");
  }
  const parsed: unknown = JSON.parse(row.toolPermissionsJson);
  if (!Array.isArray(parsed) || !parsed.includes(toolName)) {
    return fail("agent_missing_permission", "Authority Agent tool permission was rejected");
  }
}

function executeAgentExecutionTransition(
  database: DatabaseSync,
  agentId: string,
  command: Extract<AgentCollaborationCommand, { readonly type: "agent.execution.transition" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  requireAgentToolPermission(database, command.roomId, agentId, command.payload.toolName);
  const current = database.prepare(
    `SELECT id, room_id AS roomId, agent_id AS agentId,
            source_message_id AS sourceMessageId, requester_actor_id AS requesterId,
            current_tool_id AS toolName, state AS status, started_at AS startedAt
     FROM agent_executions WHERE id = ?`,
  ).get(command.payload.executionId);
  let execution: Record<string, JsonValue>;
  if (current === undefined) {
    if (command.payload.status !== "running") {
      return fail("execution_not_running", "Authority Agent execution must start running");
    }
    const requesterId = roomMessageAuthor(
      database,
      command.roomId,
      command.payload.sourceMessageId,
    );
    execution = {
      id: command.payload.executionId,
      roomId: command.roomId,
      sourceMessageId: command.payload.sourceMessageId,
      requesterId,
      agentId,
      status: "running",
      actionCategory: "tool_call",
      toolDispatchPhase: "dispatched",
      currentToolId: command.payload.toolName,
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      providerId: "legacy-authority",
      modelId: "no-model",
      recoveryCursor: 0,
      queuedAt: acceptedAt,
      startedAt: acceptedAt,
      updatedAt: acceptedAt,
    };
    database.prepare(
      `INSERT INTO agent_executions (
         id, room_id, agent_id, source_message_id, requester_actor_id, state,
         action_category, tool_dispatch_phase, current_tool_id,
         current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
         recovery_cursor, queued_at, started_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'running', 'tool_call', 'dispatched', ?,
                 1, 1, 1, 'legacy-authority', 'no-model', 0, ?, ?, ?)`,
    ).run(
      command.payload.executionId,
      command.roomId,
      agentId,
      command.payload.sourceMessageId,
      requesterId,
      command.payload.toolName,
      acceptedAt,
      acceptedAt,
      acceptedAt,
    );
    database.prepare(
      `INSERT INTO agent_execution_attempts (
         execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
         action_category, tool_dispatch_phase, started_at, finished_at,
         error_code, next_retry_at, recovery_cursor
       ) VALUES (?, ?, 1, 1, 1, 'running', 'tool_call', 'dispatched', ?, NULL, NULL, NULL, 0)`,
    ).run(command.payload.executionId, command.roomId, acceptedAt);
  } else {
    if (current.roomId !== command.roomId || current.agentId !== agentId ||
        current.sourceMessageId !== command.payload.sourceMessageId ||
        current.toolName !== command.payload.toolName ||
        typeof current.requesterId !== "string" || typeof current.startedAt !== "string") {
      return fail("execution_conflict", "Authority Agent execution identity changed");
    }
    if (current.status !== "running" || command.payload.status === "running") {
      return fail("execution_not_running", "Authority Agent execution is not running");
    }
    const status = command.payload.status === "interrupted" ? "cancelled" : command.payload.status;
    execution = {
      id: command.payload.executionId,
      roomId: command.roomId,
      sourceMessageId: command.payload.sourceMessageId,
      requesterId: current.requesterId,
      agentId,
      status,
      actionCategory: "tool_call",
      toolDispatchPhase: "finished",
      currentToolId: command.payload.toolName,
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      providerId: "legacy-authority",
      modelId: "no-model",
      recoveryCursor: 0,
      queuedAt: current.startedAt,
      startedAt: current.startedAt,
      updatedAt: acceptedAt,
      finishedAt: acceptedAt,
      ...(status === "cancelled" ? { cancellationReason: "legacy_interrupted" } : {}),
      ...(status === "failed" ? { terminalErrorCode: "legacy_closed" } : {}),
    };
    database.prepare(
      `UPDATE agent_executions
       SET state = ?, tool_dispatch_phase = 'finished', completed_at = ?,
           updated_at = ?, cancellation_reason = ?, terminal_error_code = ?,
           legacy_result_json = ?
       WHERE id = ?`,
    ).run(
      status,
      acceptedAt,
      acceptedAt,
      status === "cancelled" ? "legacy_interrupted" : null,
      status === "failed" ? "legacy_closed" : null,
      command.payload.result === undefined ? null : canonicalJson(command.payload.result),
      command.payload.executionId,
    );
    database.prepare(
      `UPDATE agent_execution_attempts
       SET state = ?, tool_dispatch_phase = 'finished', finished_at = ?, error_code = ?
       WHERE execution_id = ? AND attempt_seq = 1`,
    ).run(status, acceptedAt, status === "failed" ? "legacy_closed" : null, command.payload.executionId);
  }
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId: agentId,
    eventType: "room.agent_execution.changed",
    occurredAt: acceptedAt,
    payload: execution,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: command.payload.executionId,
    eventIds: [eventId],
    acceptedAt,
    result: { execution },
  };
}

function agentExecutionFromRuntimeRow(row: Record<string, unknown>): AgentExecution {
  const supersedes = typeof row.supersedesExecutionIdsJson === "string"
    ? JSON.parse(row.supersedesExecutionIdsJson) as unknown
    : undefined;
  return {
    id: String(row.id),
    roomId: String(row.roomId),
    sourceMessageId: String(row.sourceMessageId),
    requesterId: String(row.requesterId),
    agentId: String(row.agentId),
    status: row.status as AgentExecution["status"],
    actionCategory: row.actionCategory as AgentExecution["actionCategory"],
    ...(typeof row.toolDispatchPhase === "string"
      ? { toolDispatchPhase: row.toolDispatchPhase as NonNullable<AgentExecution["toolDispatchPhase"]> }
      : {}),
    ...(typeof row.currentToolId === "string" ? { currentToolId: row.currentToolId } : {}),
    currentAttemptSeq: Number(row.currentAttemptSeq),
    retryCycle: Number(row.retryCycle),
    retryOrdinal: Number(row.retryOrdinal) as 1 | 2 | 3,
    providerId: String(row.providerId),
    modelId: String(row.modelId),
    recoveryCursor: Number(row.recoveryCursor),
    queuedAt: String(row.queuedAt),
    ...(typeof row.startedAt === "string" ? { startedAt: row.startedAt } : {}),
    updatedAt: String(row.updatedAt),
    ...(typeof row.finishedAt === "string" ? { finishedAt: row.finishedAt } : {}),
    ...(typeof row.cancellationReason === "string" ? { cancellationReason: row.cancellationReason } : {}),
    ...(typeof row.terminalErrorCode === "string" ? { terminalErrorCode: row.terminalErrorCode } : {}),
    ...(typeof row.deadLetteredAt === "string" ? { deadLetteredAt: row.deadLetteredAt } : {}),
    ...(typeof row.resultMessageId === "string" ? { resultMessageId: row.resultMessageId } : {}),
    ...(typeof row.manualRetryOfExecutionId === "string"
      ? { manualRetryOfExecutionId: row.manualRetryOfExecutionId }
      : {}),
    ...(typeof row.compensatesExecutionId === "string"
      ? { compensatesExecutionId: row.compensatesExecutionId }
      : {}),
    ...(Array.isArray(supersedes) && supersedes.length > 0
      ? { supersedesExecutionIds: supersedes as readonly string[] }
      : {}),
  };
}

const AGENT_RUNTIME_EXECUTION_COLUMNS = `
  id, room_id AS roomId, source_message_id AS sourceMessageId,
  requester_actor_id AS requesterId, agent_id AS agentId,
  state AS status, action_category AS actionCategory,
  tool_dispatch_phase AS toolDispatchPhase, current_tool_id AS currentToolId,
  current_attempt_seq AS currentAttemptSeq, retry_cycle AS retryCycle,
  retry_ordinal AS retryOrdinal, provider_id AS providerId, model_id AS modelId,
  recovery_cursor AS recoveryCursor, queued_at AS queuedAt,
  started_at AS startedAt, updated_at AS updatedAt, completed_at AS finishedAt,
  cancellation_reason AS cancellationReason, terminal_error_code AS terminalErrorCode,
  dead_lettered_at AS deadLetteredAt, result_message_id AS resultMessageId,
  manual_retry_of_execution_id AS manualRetryOfExecutionId,
  compensates_execution_id AS compensatesExecutionId,
  supersedes_execution_ids_json AS supersedesExecutionIdsJson`;

function readAgentRuntimeExecutionRow(
  database: DatabaseSync,
  executionId: string,
): Record<string, unknown> | undefined {
  return database.prepare(
    `SELECT ${AGENT_RUNTIME_EXECUTION_COLUMNS} FROM agent_executions WHERE id = ?`,
  ).get(executionId) as Record<string, unknown> | undefined;
}

function requireHumanExecutionAuthority(
  database: DatabaseSync,
  context: AuthenticatedCommandContext,
  now: number,
  row: Record<string, unknown>,
): string {
  const actorId = requireHumanSession(database, context, now);
  const membership = database.prepare(
    `SELECT role FROM room_memberships
     WHERE room_id = ? AND actor_id = ? AND kind = 'human'`,
  ).get(String(row.roomId), actorId) as { readonly role?: unknown } | undefined;
  if (membership === undefined ||
      (row.requesterId !== actorId && membership.role !== "owner" && membership.role !== "admin")) {
    return fail("room_forbidden", "Agent runtime execution authority was rejected");
  }
  return actorId;
}

export interface InterruptAgentRuntimeDatabaseCommandInput {
  readonly context: AuthenticatedCommandContext;
  readonly input: InterruptExecutionInput;
  readonly now: number;
}

export function interruptAgentRuntimeDatabaseCommand(
  database: DatabaseSync,
  command: InterruptAgentRuntimeDatabaseCommandInput,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const row = readAgentRuntimeExecutionRow(database, command.input.executionId);
    if (row === undefined) return fail("execution_conflict", "Agent runtime execution was not found");
    requireHumanExecutionAuthority(database, command.context, command.now, row);
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      return agentExecutionFromRuntimeRow(row);
    }
    const finishedAt = new Date(command.now).toISOString();
    const executionUpdate = database.prepare(
      `UPDATE agent_executions
       SET state = 'cancelled', completed_at = ?, updated_at = ?, cancellation_reason = ?
       WHERE id = ? AND current_attempt_seq = ? AND state IN ('queued', 'running')`,
    ).run(finishedAt, finishedAt, command.input.reason, command.input.executionId,
      Number(row.currentAttemptSeq));
    if (executionUpdate.changes !== 1) {
      return fail("execution_conflict", "Agent runtime interrupt lost execution CAS");
    }
    const attemptUpdate = database.prepare(
      `UPDATE agent_execution_attempts
       SET state = 'cancelled', finished_at = ?, next_retry_at = NULL
       WHERE execution_id = ? AND attempt_seq = ? AND state IN ('queued', 'running')`,
    ).run(finishedAt, command.input.executionId, Number(row.currentAttemptSeq));
    if (attemptUpdate.changes !== 1) {
      return fail("execution_conflict", "Agent runtime interrupt lost attempt CAS");
    }
    const execution = agentExecutionFromRuntimeRow({
      ...row,
      status: "cancelled",
      updatedAt: finishedAt,
      finishedAt,
      cancellationReason: command.input.reason,
    });
    const eventId = stableId("event", "agent-runtime-interrupt", command.input.executionId,
      String(row.currentAttemptSeq));
    const streamSeq = appendRoomEvent(database, {
      eventId,
      roomId: String(row.roomId),
      actorId: String(row.agentId),
      eventType: "room.agent_execution.changed",
      occurredAt: finishedAt,
      payload: execution as unknown as JsonValue,
    });
    appendRoomOutbox(database, eventId, String(row.roomId), streamSeq, finishedAt,
      "agent-runtime-interrupt", command.input.executionId);
    return execution;
  });
}

export interface ManualRetryAgentRuntimeDatabaseCommandInput {
  readonly context: AuthenticatedCommandContext;
  readonly executionId: string;
  readonly now: number;
  readonly maxQueuedPerRoom?: number;
}

export function manualRetryAgentRuntimeDatabaseCommand(
  database: DatabaseSync,
  command: ManualRetryAgentRuntimeDatabaseCommandInput,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const old = readAgentRuntimeExecutionRow(database, command.executionId);
    if (old === undefined) return fail("execution_conflict", "Agent runtime execution was not found");
    const requesterId = requireHumanExecutionAuthority(database, command.context, command.now, old);
    if (old.status !== "failed" || typeof old.deadLetteredAt !== "string") {
      return fail("execution_conflict", "Agent runtime manual retry requires a dead-lettered execution");
    }
    const existing = database.prepare(
      `SELECT ${AGENT_RUNTIME_EXECUTION_COLUMNS}
       FROM agent_executions WHERE manual_retry_of_execution_id = ?`,
    ).get(command.executionId) as Record<string, unknown> | undefined;
    if (existing !== undefined) return agentExecutionFromRuntimeRow(existing);
    if (command.maxQueuedPerRoom !== undefined) {
      const outstanding = database.prepare(
        `SELECT COUNT(*) AS count FROM agent_executions
         WHERE room_id = ? AND state IN ('queued', 'running')`,
      ).get(String(old.roomId)) as { readonly count: number };
      if (outstanding.count >= command.maxQueuedPerRoom + 1) {
        return fail("target_busy", "Agent runtime room queue is full");
      }
    }
    const queuedAt = new Date(command.now).toISOString();
    const executionId = stableId("agent-runtime-manual-retry", command.executionId);
    database.prepare(
      `INSERT INTO agent_executions (
         id, room_id, agent_id, source_message_id, requester_actor_id, state,
         action_category, current_attempt_seq, retry_cycle, retry_ordinal,
         provider_id, model_id, recovery_cursor, queued_at, updated_at,
         manual_retry_of_execution_id
       ) VALUES (?, ?, ?, ?, ?, 'queued', 'model_generation', 1, ?, 1, ?, ?, 0, ?, ?, ?)`,
    ).run(executionId, String(old.roomId), String(old.agentId), String(old.sourceMessageId),
      requesterId, Number(old.retryCycle) + 1, String(old.providerId), String(old.modelId),
      queuedAt, queuedAt, command.executionId);
    const execution = agentExecutionFromRuntimeRow({
      id: executionId,
      roomId: old.roomId,
      sourceMessageId: old.sourceMessageId,
      requesterId,
      agentId: old.agentId,
      status: "queued",
      actionCategory: "model_generation",
      currentAttemptSeq: 1,
      retryCycle: Number(old.retryCycle) + 1,
      retryOrdinal: 1,
      providerId: old.providerId,
      modelId: old.modelId,
      recoveryCursor: 0,
      queuedAt,
      updatedAt: queuedAt,
      manualRetryOfExecutionId: command.executionId,
    });
    const eventId = stableId("event", "agent-runtime-manual-retry", command.executionId);
    const streamSeq = appendRoomEvent(database, {
      eventId,
      roomId: String(old.roomId),
      actorId: String(old.agentId),
      eventType: "room.agent_execution.changed",
      occurredAt: queuedAt,
      payload: execution as unknown as JsonValue,
    });
    database.prepare(
      `INSERT INTO agent_execution_attempts (
         execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
         action_category, recovery_cursor, enqueue_stream_seq
       ) VALUES (?, ?, 1, ?, 1, 'queued', 'model_generation', 0, ?)`,
    ).run(executionId, String(old.roomId), Number(old.retryCycle) + 1, streamSeq);
    appendRoomOutbox(database, eventId, String(old.roomId), streamSeq, queuedAt,
      "agent-runtime-manual-retry", executionId);
    return execution;
  });
}

export interface CompensateAgentRuntimeDatabaseCommandInput {
  readonly context: AuthenticatedCommandContext;
  readonly executionId: string;
  readonly dispatchId: string;
  readonly now: number;
  readonly maxQueuedPerRoom?: number;
}

export function compensateAgentRuntimeDatabaseCommand(
  database: DatabaseSync,
  command: CompensateAgentRuntimeDatabaseCommandInput,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const original = readAgentRuntimeExecutionRow(database, command.executionId);
    if (original === undefined || original.status === "queued" || original.status === "running") {
      return fail("execution_conflict", "Agent runtime compensation requires a terminal execution");
    }
    const actorId = requireHumanSession(database, command.context, command.now);
    const membership = database.prepare(
      `SELECT role FROM room_memberships
       WHERE room_id = ? AND actor_id = ? AND kind = 'human'`,
    ).get(String(original.roomId), actorId) as { readonly role?: unknown } | undefined;
    if (membership === undefined) {
      return fail("room_forbidden", "Agent runtime compensation membership was rejected");
    }
    const sideEffect = database.prepare(
      `SELECT confirmation.human_principal_id AS humanPrincipalId,
              dispatch.id AS dispatchId, dispatch.tool_id AS toolId,
              dispatch.parameter_hash AS parameterHash,
              dispatch.sealed_compensation AS sealedCompensation,
              confirmation.target AS target, confirmation.impact AS impact
       FROM agent_tool_dispatches AS dispatch
       JOIN agent_tool_grants AS grant ON grant.id = dispatch.grant_id
       JOIN agent_tool_confirmations AS confirmation ON confirmation.grant_id = grant.id
       WHERE dispatch.execution_id = ? AND dispatch.id = ?
         AND dispatch.state = 'succeeded'
         AND dispatch.sealed_compensation IS NOT NULL
         AND length(trim(dispatch.sealed_compensation)) > 0
         AND confirmation.reversibility = 'compensatable'
       ORDER BY grant.tool_call_step_seq DESC
       LIMIT 1`,
    ).get(command.executionId, command.dispatchId) as {
      readonly humanPrincipalId?: unknown;
      readonly dispatchId?: unknown;
      readonly toolId?: unknown;
      readonly parameterHash?: unknown;
      readonly sealedCompensation?: unknown;
      readonly target?: unknown;
      readonly impact?: unknown;
    } | undefined;
    if (sideEffect === undefined) {
      return fail("execution_conflict", "Agent runtime execution has no compensatable side effect");
    }
    if (sideEffect.humanPrincipalId !== actorId &&
        membership.role !== "owner" && membership.role !== "admin") {
      return fail("room_forbidden", "Agent runtime compensation authority was rejected");
    }
    const existingRequest = database.prepare(
      `SELECT execution_id AS executionId
       FROM agent_compensation_requests
       WHERE original_dispatch_id = ?`,
    ).get(command.dispatchId) as { readonly executionId?: unknown } | undefined;
    if (typeof existingRequest?.executionId === "string") {
      const existing = readAgentRuntimeExecutionRow(database, existingRequest.executionId);
      if (existing === undefined) {
        return fail("storage_unavailable", "Agent runtime compensation replay was corrupt");
      }
      return agentExecutionFromRuntimeRow(existing);
    }
    if (typeof sideEffect.toolId !== "string" ||
        typeof sideEffect.sealedCompensation !== "string" ||
        typeof sideEffect.target !== "string" || typeof sideEffect.impact !== "string") {
      return fail("storage_unavailable", "Agent runtime compensation binding was corrupt");
    }
    requireAgentCommandAuthority(database, String(original.agentId), String(original.roomId));
    if (command.maxQueuedPerRoom !== undefined) {
      const outstanding = database.prepare(
        `SELECT COUNT(*) AS count FROM agent_executions
         WHERE room_id = ? AND state IN ('queued', 'running')`,
      ).get(String(original.roomId)) as { readonly count: number };
      if (outstanding.count >= command.maxQueuedPerRoom + 1) {
        return fail("target_busy", "Agent runtime room queue is full");
      }
    }
    const queuedAt = new Date(command.now).toISOString();
    const executionId = stableId("agent-runtime-compensation", command.executionId, command.dispatchId);
    database.prepare(
      `INSERT INTO agent_executions (
         id, room_id, agent_id, source_message_id, requester_actor_id, state,
         action_category, current_attempt_seq, retry_cycle, retry_ordinal,
         provider_id, model_id, recovery_cursor, queued_at, updated_at,
         compensates_execution_id
       ) VALUES (?, ?, ?, ?, ?, 'queued', 'model_generation', 1, 1, 1, ?, ?, 0, ?, ?, ?)`,
    ).run(executionId, String(original.roomId), String(original.agentId),
      String(original.sourceMessageId), actorId, String(original.providerId),
      String(original.modelId), queuedAt, queuedAt, command.executionId);
    const execution = agentExecutionFromRuntimeRow({
      id: executionId,
      roomId: original.roomId,
      sourceMessageId: original.sourceMessageId,
      requesterId: actorId,
      agentId: original.agentId,
      status: "queued",
      actionCategory: "model_generation",
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      providerId: original.providerId,
      modelId: original.modelId,
      recoveryCursor: 0,
      queuedAt,
      updatedAt: queuedAt,
      compensatesExecutionId: command.executionId,
    });
    const eventId = stableId(
      "event", "agent-runtime-compensation", command.executionId, command.dispatchId,
    );
    const streamSeq = appendRoomEvent(database, {
      eventId,
      roomId: String(original.roomId),
      actorId: String(original.agentId),
      eventType: "room.agent_execution.changed",
      occurredAt: queuedAt,
      payload: execution as unknown as JsonValue,
    });
    database.prepare(
      `INSERT INTO agent_execution_attempts (
         execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
         action_category, recovery_cursor, enqueue_stream_seq
       ) VALUES (?, ?, 1, 1, 1, 'queued', 'model_generation', 0, ?)`,
    ).run(executionId, String(original.roomId), streamSeq);
    database.prepare(
      `INSERT INTO agent_compensation_requests (
         execution_id, original_execution_id, original_dispatch_id,
         requester_actor_id, session_family_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(executionId, command.executionId, String(sideEffect.dispatchId), actorId,
      command.context.sessionFamilyId, queuedAt);
    appendRoomOutbox(database, eventId, String(original.roomId), streamSeq, queuedAt,
      "agent-runtime-compensation", executionId);
    return execution;
  });
}

export function resumeAgentRuntimeCompensationDatabaseCommand(
  database: DatabaseSync,
  input: ResumeAgentRuntimeCompensationInput,
  agentId: string,
): AgentRuntimeCompensationWork {
  return runAuthorityImmediateTransaction(database, () => {
    const now = new Date(input.now).toISOString();
    const executionBinding = readAgentRuntimeExecutionRow(database, input.executionId);
    const compensationBinding = database.prepare(
      `SELECT request.original_execution_id AS originalExecutionId,
              request.original_dispatch_id AS originalDispatchId,
              request.requester_actor_id AS compensationRequesterId,
              request.session_family_id AS compensationSessionFamilyId,
              original.state AS originalState,
              dispatch.tool_id AS compensationToolId,
              dispatch.sealed_compensation AS sealedCompensation,
              confirmation.target AS compensationTarget,
              confirmation.impact AS compensationImpact,
              confirmation.reversibility AS compensationReversibility
       FROM agent_executions AS execution
       JOIN agent_compensation_requests AS request ON request.execution_id = execution.id
       JOIN agent_executions AS original ON original.id = request.original_execution_id
       JOIN agent_tool_dispatches AS dispatch ON dispatch.id = request.original_dispatch_id
       JOIN agent_tool_grants AS grant ON grant.id = dispatch.grant_id
       JOIN agent_tool_confirmations AS confirmation ON confirmation.grant_id = grant.id
       WHERE execution.id = ?`,
    ).get(input.executionId) as Record<string, unknown> | undefined;
    const binding = executionBinding === undefined || compensationBinding === undefined
      ? undefined
      : { ...executionBinding, ...compensationBinding };
    if (binding !== undefined && binding.agentId !== agentId) {
      return fail("agent_capability_forbidden", "Agent runtime compensation capability was rejected");
    }
    if (binding === undefined || Number(binding.currentAttemptSeq) !== input.attemptSeq || binding.status !== "running" ||
        binding.actionCategory !== "model_generation" || Number(binding.recoveryCursor) !== 0 ||
        binding.compensatesExecutionId !== binding.originalExecutionId ||
        binding.originalState === "queued" || binding.originalState === "running" ||
        binding.compensationReversibility !== "compensatable" ||
        typeof binding.compensationToolId !== "string" ||
        typeof binding.sealedCompensation !== "string" || binding.sealedCompensation.length === 0 ||
        typeof binding.compensationRequesterId !== "string" ||
        typeof binding.compensationSessionFamilyId !== "string" ||
        typeof binding.compensationTarget !== "string" || typeof binding.compensationImpact !== "string") {
      return fail("execution_conflict", "Agent runtime compensation binding was rejected");
    }
    requireAgentCommandAuthority(database, agentId, String(binding.roomId));
    requireAgentToolPermission(database, String(binding.roomId), agentId, binding.compensationToolId);
    const activeFamily = database.prepare(
      `SELECT 1 AS present FROM sessions
       WHERE family_id = ? AND actor_id = ? AND revoked_at IS NULL
         AND access_expires_at > ? LIMIT 1`,
    ).get(binding.compensationSessionFamilyId, binding.compensationRequesterId, input.now);
    if (activeFamily === undefined) {
      return fail("session_revoked", "Agent runtime compensation session is no longer active");
    }
    if (database.prepare(
      `SELECT 1 AS present FROM agent_tool_dispatches
       WHERE execution_id = ? AND attempt_seq = ? LIMIT 1`,
    ).get(input.executionId, input.attemptSeq) !== undefined) {
      return fail("execution_conflict", "Agent runtime compensation was already dispatched");
    }
    const canonicalToolCall = {
      toolId: binding.compensationToolId,
      parameters: { compensationOfDispatchId: String(binding.originalDispatchId) },
      remainingCalls: [],
    } satisfies JsonValue;
    const parameterHash = createHash("sha256").update(binding.sealedCompensation).digest("hex");
    const toolPlanHash = createHash("sha256").update(canonicalJson(canonicalToolCall)).digest("hex");
    const grantId = stableId("agent-runtime-compensation-grant", input.executionId);
    const confirmationId = stableId("agent-runtime-compensation-confirmation", input.executionId);
    const dispatchId = stableId("agent-runtime-tool-dispatch", grantId);
    const expiresAt = new Date(input.now + 1).toISOString();
    const executionUpdate = database.prepare(
      `UPDATE agent_executions SET action_category = 'tool_call', recovery_cursor = 1,
         tool_dispatch_phase = 'dispatched', current_tool_id = ?, updated_at = ?
       WHERE id = ? AND state = 'running' AND current_attempt_seq = ?
         AND action_category = 'model_generation' AND recovery_cursor = 0
         AND tool_dispatch_phase IS NULL AND current_tool_id IS NULL`,
    ).run(binding.compensationToolId, now, input.executionId, input.attemptSeq);
    const attemptUpdate = database.prepare(
      `UPDATE agent_execution_attempts SET action_category = 'tool_call', recovery_cursor = 1,
         tool_dispatch_phase = 'dispatched'
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
         AND action_category = 'model_generation' AND recovery_cursor = 0
         AND tool_dispatch_phase IS NULL`,
    ).run(input.executionId, input.attemptSeq);
    if (executionUpdate.changes !== 1 || attemptUpdate.changes !== 1) {
      return fail("execution_conflict", "Agent runtime compensation claim was stale");
    }
    database.prepare(
      `INSERT INTO agent_execution_steps (
         execution_id, attempt_seq, step_seq, step_kind, canonical_tool_call_json,
         input_sha256, output_sha256, completed_at
       ) VALUES (?, ?, 1, 'tool_call', ?, ?, ?, ?)`,
    ).run(input.executionId, input.attemptSeq, canonicalJson(canonicalToolCall),
      parameterHash, parameterHash, now);
    database.prepare(
      `INSERT INTO agent_tool_grants (
         id, execution_id, attempt_seq, tool_call_step_seq, agent_id, room_id, tool_id,
         parameter_hash, tool_plan_hash, confirmation_requirement, issued_at, expires_at, consumed_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'side_effect', ?, ?, ?)`,
    ).run(grantId, input.executionId, input.attemptSeq, agentId, String(binding.roomId),
      binding.compensationToolId, parameterHash, toolPlanHash, now, expiresAt, now);
    database.prepare(
      `INSERT INTO agent_tool_confirmations (
         id, execution_id, attempt_seq, grant_id, tool_id, parameter_hash, room_id,
         human_principal_id, session_family_id, target, impact, reversibility,
         expires_at, consumed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'compensatable', ?, ?)`,
    ).run(confirmationId, input.executionId, input.attemptSeq, grantId,
      binding.compensationToolId, parameterHash, String(binding.roomId),
      binding.compensationRequesterId, binding.compensationSessionFamilyId,
      `compensate:${binding.compensationTarget}`, `compensate:${binding.compensationImpact}`,
      expiresAt, now);
    database.prepare(
      `INSERT INTO agent_tool_dispatches (
         id, execution_id, attempt_seq, grant_id, tool_id, parameter_hash, state, dispatched_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?)`,
    ).run(dispatchId, input.executionId, input.attemptSeq, grantId,
      binding.compensationToolId, parameterHash, now);
    const executionRow = readAgentRuntimeExecutionRow(database, input.executionId);
    if (executionRow === undefined) return fail("storage_unavailable", "Agent runtime compensation disappeared");
    const execution = agentExecutionFromRuntimeRow(executionRow);
    const eventId = stableId("event", "agent-runtime-compensation-dispatched", input.executionId);
    const streamSeq = appendRoomEvent(database, {
      eventId, roomId: String(execution.roomId), actorId: agentId,
      eventType: "room.agent_execution.changed", occurredAt: now,
      payload: execution as unknown as JsonValue,
    });
    appendRoomOutbox(database, eventId, String(execution.roomId), streamSeq, now,
      "agent-runtime-compensation-dispatched", input.executionId);
    return {
      execution,
      dispatch: {
        id: dispatchId, executionId: input.executionId, attemptSeq: input.attemptSeq,
        grantId, toolId: binding.compensationToolId, parameterHash,
        state: "dispatched", dispatchedAt: now,
      },
      sealedCompensation: binding.sealedCompensation,
    };
  });
}

function recoverAgentRuntimeExecutionDatabaseCommand(
  database: DatabaseSync,
  now: number,
  agentId: string,
  onlyExecutionId: string,
): readonly AgentRuntimeRecovery[] {
  const recovered: AgentExecution[] = [];
  const recoveryAt = new Date(now).toISOString();
  const expiredConfirmations = database.prepare(
    `SELECT execution.id AS executionId, execution.current_attempt_seq AS attemptSeq
     FROM agent_executions AS execution
     JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = execution.id
      AND attempt.attempt_seq = execution.current_attempt_seq
     JOIN agent_tool_grants AS grant INDEXED BY agent_tool_grants_execution_step
       ON grant.execution_id = execution.id
      AND grant.attempt_seq = execution.current_attempt_seq
      AND grant.tool_call_step_seq = execution.recovery_cursor
      AND grant.confirmation_requirement = 'side_effect'
      AND grant.consumed_at IS NULL
     LEFT JOIN agent_tool_confirmations AS confirmation
       ON confirmation.grant_id = grant.id AND confirmation.consumed_at IS NULL
     WHERE execution.state = 'running' AND attempt.state = 'running'
       AND execution.action_category = 'waiting_upstream'
       AND execution.tool_dispatch_phase IS NULL
       AND attempt.action_category = 'waiting_upstream'
       AND attempt.tool_dispatch_phase IS NULL
       AND execution.agent_id = ?
       AND execution.id = ?
       AND (grant.expires_at <= ? OR confirmation.expires_at <= ?)
     LIMIT 2`,
  ).all(agentId, onlyExecutionId, recoveryAt, recoveryAt) as unknown as readonly {
    readonly executionId: string;
    readonly attemptSeq: number;
  }[];
  if (expiredConfirmations.length > 1) {
    return fail("storage_unavailable", "Agent runtime confirmation recovery binding was ambiguous");
  }
  for (const candidate of expiredConfirmations) {
    recovered.push(runAuthorityImmediateTransaction(database, () => {
      const execution = readAgentRuntimeExecutionRow(database, candidate.executionId);
      if (execution === undefined || execution.status !== "running" ||
          Number(execution.currentAttemptSeq) !== candidate.attemptSeq ||
          execution.actionCategory !== "waiting_upstream" || execution.toolDispatchPhase !== null) {
        return fail("execution_conflict", "Agent runtime confirmation recovery lost execution CAS");
      }
      const attemptUpdate = database.prepare(
        `UPDATE agent_execution_attempts
         SET state = 'failed', finished_at = ?, error_code = 'confirmation_expired'
         WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
           AND action_category = 'waiting_upstream' AND tool_dispatch_phase IS NULL`,
      ).run(recoveryAt, candidate.executionId, candidate.attemptSeq);
      const executionUpdate = database.prepare(
        `UPDATE agent_executions
         SET state = 'failed', completed_at = ?, updated_at = ?,
             terminal_error_code = 'confirmation_expired'
         WHERE id = ? AND current_attempt_seq = ? AND state = 'running'
           AND action_category = 'waiting_upstream' AND tool_dispatch_phase IS NULL`,
      ).run(recoveryAt, recoveryAt, candidate.executionId, candidate.attemptSeq);
      if (attemptUpdate.changes !== 1 || executionUpdate.changes !== 1) {
        return fail("execution_conflict", "Agent runtime confirmation recovery lost atomic CAS");
      }
      const failed = agentExecutionFromRuntimeRow({
        ...execution, status: "failed", finishedAt: recoveryAt,
        updatedAt: recoveryAt, terminalErrorCode: "confirmation_expired",
      });
      const eventId = stableId("event", "agent-runtime-confirmation-expired",
        candidate.executionId, String(candidate.attemptSeq));
      const streamSeq = appendRoomEvent(database, {
        eventId, roomId: String(execution.roomId), actorId: String(execution.agentId),
        eventType: "room.agent_execution.changed", occurredAt: recoveryAt,
        payload: failed as unknown as JsonValue,
      });
      appendRoomOutbox(database, eventId, String(execution.roomId), streamSeq, recoveryAt,
        "agent-runtime-confirmation-expired", candidate.executionId);
      return failed;
    }));
  }
  const ambiguousSideEffects = database.prepare(
    `SELECT execution.id AS executionId, execution.current_attempt_seq AS attemptSeq,
            dispatch.id AS dispatchId
     FROM agent_executions AS execution
     JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = execution.id AND attempt.attempt_seq = execution.current_attempt_seq
     JOIN agent_tool_grants AS grant INDEXED BY agent_tool_grants_execution_step
       ON grant.execution_id = execution.id
      AND grant.attempt_seq = execution.current_attempt_seq
      AND grant.tool_call_step_seq = execution.recovery_cursor
      AND grant.confirmation_requirement = 'side_effect'
     JOIN agent_tool_dispatches AS dispatch
       ON dispatch.grant_id = grant.id
      AND dispatch.execution_id = execution.id
      AND dispatch.attempt_seq = execution.current_attempt_seq
     WHERE execution.state = 'running' AND attempt.state = 'running'
       AND execution.action_category = 'tool_call'
       AND execution.tool_dispatch_phase = 'dispatched'
       AND attempt.tool_dispatch_phase = 'dispatched'
       AND dispatch.state = 'dispatched'
       AND execution.agent_id = ?
       AND execution.id = ?
     LIMIT 2`,
  ).all(agentId, onlyExecutionId) as unknown as readonly {
    readonly executionId: string;
    readonly attemptSeq: number;
    readonly dispatchId: string;
  }[];
  if (ambiguousSideEffects.length > 1) {
    return fail("storage_unavailable", "Agent runtime unsettled side-effect binding was ambiguous");
  }
  for (const candidate of ambiguousSideEffects) {
    recovered.push(runAuthorityImmediateTransaction(database, () => {
      const execution = readAgentRuntimeExecutionRow(database, candidate.executionId);
      if (execution === undefined || execution.status !== "running" ||
          Number(execution.currentAttemptSeq) !== candidate.attemptSeq ||
          execution.actionCategory !== "tool_call" || execution.toolDispatchPhase !== "dispatched") {
        return fail("execution_conflict", "Agent runtime side-effect recovery lost execution CAS");
      }
      const finishedAt = new Date(now).toISOString();
      const dispatchUpdate = database.prepare(
        `UPDATE agent_tool_dispatches
         SET state = 'outcome_unknown', settled_at = ?, closed_summary = 'runtime_restarted'
         WHERE id = ? AND execution_id = ? AND attempt_seq = ? AND state = 'dispatched'`,
      ).run(finishedAt, candidate.dispatchId, candidate.executionId, candidate.attemptSeq);
      const attemptUpdate = database.prepare(
        `UPDATE agent_execution_attempts
         SET state = 'failed', tool_dispatch_phase = 'finished', finished_at = ?,
             error_code = 'side_effect_outcome_unknown'
         WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
           AND action_category = 'tool_call' AND tool_dispatch_phase = 'dispatched'`,
      ).run(finishedAt, candidate.executionId, candidate.attemptSeq);
      const executionUpdate = database.prepare(
        `UPDATE agent_executions
         SET state = 'failed', tool_dispatch_phase = 'finished', completed_at = ?,
             updated_at = ?, terminal_error_code = 'side_effect_outcome_unknown'
         WHERE id = ? AND current_attempt_seq = ? AND state = 'running'
           AND action_category = 'tool_call' AND tool_dispatch_phase = 'dispatched'`,
      ).run(finishedAt, finishedAt, candidate.executionId, candidate.attemptSeq);
      if (dispatchUpdate.changes !== 1 || attemptUpdate.changes !== 1 || executionUpdate.changes !== 1) {
        return fail("execution_conflict", "Agent runtime side-effect recovery lost atomic CAS");
      }
      const failed = agentExecutionFromRuntimeRow({
        ...execution, status: "failed", toolDispatchPhase: "finished",
        finishedAt, updatedAt: finishedAt,
        terminalErrorCode: "side_effect_outcome_unknown",
      });
      const eventId = stableId("event", "agent-runtime-side-effect-unknown",
        candidate.executionId, String(candidate.attemptSeq));
      const streamSeq = appendRoomEvent(database, {
        eventId, roomId: String(execution.roomId), actorId: String(execution.agentId),
        eventType: "room.agent_execution.changed", occurredAt: finishedAt,
        payload: failed as unknown as JsonValue,
      });
      appendRoomOutbox(database, eventId, String(execution.roomId), streamSeq, finishedAt,
        "agent-runtime-side-effect-unknown", candidate.dispatchId);
      return failed;
    }));
  }
  const settledSideEffects = database.prepare(
    `SELECT DISTINCT execution.id AS executionId,
            execution.current_attempt_seq AS attemptSeq,
            dispatch.id AS dispatchId, dispatch.state AS dispatchState
     FROM agent_executions AS execution
     JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = execution.id AND attempt.attempt_seq = execution.current_attempt_seq
     JOIN agent_tool_grants AS grant INDEXED BY agent_tool_grants_execution_step
       ON grant.execution_id = execution.id
      AND grant.attempt_seq = execution.current_attempt_seq
      AND grant.tool_call_step_seq = execution.recovery_cursor
      AND grant.confirmation_requirement = 'side_effect'
     JOIN agent_tool_dispatches AS dispatch
       ON dispatch.grant_id = grant.id
      AND dispatch.execution_id = execution.id
      AND dispatch.attempt_seq = execution.current_attempt_seq
     WHERE execution.state = 'running' AND attempt.state = 'running'
       AND execution.action_category = 'tool_call'
       AND execution.tool_dispatch_phase = 'finished'
       AND attempt.action_category = 'tool_call'
       AND attempt.tool_dispatch_phase = 'finished'
       AND dispatch.state IN ('succeeded', 'failed')
       AND execution.agent_id = ?
       AND execution.id = ?
     LIMIT 2`,
  ).all(agentId, onlyExecutionId) as unknown as readonly {
    readonly executionId: string;
    readonly attemptSeq: number;
    readonly dispatchId: string;
    readonly dispatchState: "succeeded" | "failed";
  }[];
  if (settledSideEffects.length > 1) {
    return fail("storage_unavailable", "Agent runtime settled side-effect binding was ambiguous");
  }
  for (const candidate of settledSideEffects) {
    recovered.push(runAuthorityImmediateTransaction(database, () => {
      const execution = readAgentRuntimeExecutionRow(database, candidate.executionId);
      if (execution === undefined || execution.status !== "running" ||
          Number(execution.currentAttemptSeq) !== candidate.attemptSeq ||
          execution.actionCategory !== "tool_call" || execution.toolDispatchPhase !== "finished") {
        return fail("execution_conflict", "Agent runtime settled side-effect recovery lost execution CAS");
      }
      const terminalErrorCode = candidate.dispatchState === "failed"
        ? "tool_failure"
        : "side_effect_reconciliation_required";
      const attemptChanged = database.prepare(
        `UPDATE agent_execution_attempts
         SET state = 'failed', finished_at = ?, error_code = ?
         WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
           AND action_category = 'tool_call' AND tool_dispatch_phase = 'finished'`,
      ).run(recoveryAt, terminalErrorCode, candidate.executionId, candidate.attemptSeq);
      const executionChanged = database.prepare(
        `UPDATE agent_executions
         SET state = 'failed', completed_at = ?, updated_at = ?, terminal_error_code = ?
         WHERE id = ? AND current_attempt_seq = ? AND state = 'running'
           AND action_category = 'tool_call' AND tool_dispatch_phase = 'finished'`,
      ).run(recoveryAt, recoveryAt, terminalErrorCode,
        candidate.executionId, candidate.attemptSeq);
      if (attemptChanged.changes !== 1 || executionChanged.changes !== 1) {
        return fail("execution_conflict", "Agent runtime settled side-effect recovery lost atomic CAS");
      }
      const failed = agentExecutionFromRuntimeRow({
        ...execution, status: "failed", finishedAt: recoveryAt,
        updatedAt: recoveryAt, terminalErrorCode,
      });
      const eventId = stableId("event", "agent-runtime-side-effect-reconciliation",
        candidate.executionId, String(candidate.attemptSeq));
      const streamSeq = appendRoomEvent(database, {
        eventId, roomId: String(execution.roomId), actorId: String(execution.agentId),
        eventType: "room.agent_execution.changed", occurredAt: recoveryAt,
        payload: failed as unknown as JsonValue,
      });
      appendRoomOutbox(database, eventId, String(execution.roomId), streamSeq, recoveryAt,
        "agent-runtime-side-effect-reconciliation", candidate.dispatchId);
      return failed;
    }));
  }
  const running = database.prepare(
    `SELECT execution.id AS executionId, execution.current_attempt_seq AS attemptSeq
     FROM agent_executions AS execution
     JOIN agent_execution_attempts AS attempt
       ON attempt.execution_id = execution.id AND attempt.attempt_seq = execution.current_attempt_seq
     WHERE execution.state = 'running' AND attempt.state = 'running'
       AND (execution.action_category = 'model_generation'
         OR (execution.action_category = 'tool_call' AND (
           (execution.tool_dispatch_phase = 'not_started' AND NOT EXISTS (
             SELECT 1 FROM agent_tool_grants AS waiting_grant
             WHERE waiting_grant.execution_id = execution.id
               AND waiting_grant.attempt_seq = execution.current_attempt_seq
               AND waiting_grant.confirmation_requirement = 'side_effect'
               AND waiting_grant.consumed_at IS NULL
           ))
           OR (execution.tool_dispatch_phase IN ('dispatched', 'finished') AND EXISTS (
             SELECT 1 FROM agent_tool_grants AS grant
             WHERE grant.execution_id = execution.id
               AND grant.attempt_seq = execution.current_attempt_seq
               AND grant.confirmation_requirement = 'read_only'
           ))
       )))
       AND execution.agent_id = ?
       AND execution.id = ?
     ORDER BY execution.room_id, execution.queued_at, execution.id`,
  ).all(agentId, onlyExecutionId) as unknown as readonly { readonly executionId: string; readonly attemptSeq: number }[];
  for (const candidate of running) {
    recovered.push(scheduleAgentRuntimeRetryDatabaseCommand(database, {
      runtime: { kind: "runtime", runtimeId: "recovery", agentId },
      input: {
        executionId: candidate.executionId,
        attemptSeq: candidate.attemptSeq,
        errorCode: "runtime_restarted",
        now,
      },
      allowSettledSideEffectRecovery: true,
    }));
  }
  const queued = database.prepare(
    `SELECT ${AGENT_RUNTIME_EXECUTION_COLUMNS}
     FROM agent_executions AS execution
     WHERE execution.state = 'queued'
       AND execution.agent_id = ?
       AND execution.id = ?
       AND EXISTS (
         SELECT 1 FROM agent_execution_attempts AS attempt
         WHERE attempt.execution_id = execution.id
           AND attempt.attempt_seq = execution.current_attempt_seq
           AND attempt.state = 'queued'
       )
     ORDER BY (
       SELECT attempt.enqueue_stream_seq FROM agent_execution_attempts AS attempt
       WHERE attempt.execution_id = execution.id
         AND attempt.attempt_seq = execution.current_attempt_seq
     )`,
  ).all(agentId, onlyExecutionId) as readonly Record<string, unknown>[];
  const seen = new Set(recovered.map((execution) => execution.id));
  for (const row of queued) {
    if (!seen.has(String(row.id))) recovered.push(agentExecutionFromRuntimeRow(row));
  }
  const retrySchedule = database.prepare(
    `SELECT next_retry_at AS nextRetryAt
     FROM agent_execution_attempts
     WHERE execution_id = ? AND attempt_seq = ?`,
  );
  return recovered.map((execution) => {
    if (execution.status !== "queued") return { execution };
    const schedule = retrySchedule.get(
      execution.id,
      execution.currentAttemptSeq,
    ) as { readonly nextRetryAt?: number | null } | undefined;
    return schedule?.nextRetryAt === null || schedule?.nextRetryAt === undefined
      ? { execution }
      : { execution, nextRetryAt: schedule.nextRetryAt };
  });
}

type RecoveryBranch = 0 | 1;

interface RecoveryCursorPayload {
  readonly version: 1;
  readonly branch: RecoveryBranch;
  readonly afterExecutionId: string;
}

function encodeRecoveryCursor(payload: RecoveryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeRecoveryCursor(cursor: string | undefined): RecoveryCursorPayload {
  if (cursor === undefined) return { version: 1, branch: 0, afterExecutionId: "" };
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        Object.keys(value).sort().join("\0") !== "afterExecutionId\0branch\0version") {
      return fail("execution_conflict", "Agent runtime recovery cursor was invalid");
    }
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !Number.isInteger(record.branch) ||
        Number(record.branch) < 0 || Number(record.branch) > 1 ||
        typeof record.afterExecutionId !== "string") {
      return fail("execution_conflict", "Agent runtime recovery cursor was invalid");
    }
    return value as RecoveryCursorPayload;
  } catch (error: unknown) {
    if (error instanceof AuthorityDatabaseError) throw error;
    return fail("execution_conflict", "Agent runtime recovery cursor was invalid");
  }
}

function recoveryCandidateIds(
  database: DatabaseSync,
  agentId: string,
  now: number,
  cursor: RecoveryCursorPayload,
  limit: number,
): readonly string[] {
  const sql = cursor.branch === 0
    ? `SELECT execution.id
       FROM agent_executions AS execution INDEXED BY agent_executions_agent_state_id
       WHERE execution.agent_id = ? AND execution.state = 'queued'
         AND execution.id > ?
       ORDER BY execution.id LIMIT ?`
    : `SELECT execution.id
       FROM agent_executions AS execution INDEXED BY agent_executions_agent_state_id
       WHERE execution.agent_id = ? AND execution.state = 'running'
         AND execution.id > ?
       ORDER BY execution.id LIMIT ?`;
  return database.prepare(sql).all(agentId, cursor.afterExecutionId, limit)
    .map((row) => String(row.id));
}

export function recoverAgentRuntimePageDatabaseCommand(
  database: DatabaseSync,
  input: AgentRuntimeRecoveryPageInput,
  agentId: string,
): AgentRuntimeRecoveryPage {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
    return fail("execution_conflict", "Agent runtime recovery page limit was invalid");
  }
  const cursor = decodeRecoveryCursor(input.cursor);
  const candidateIds = recoveryCandidateIds(database, agentId, input.now, cursor, input.limit);
  const recoveries = candidateIds.flatMap((executionId) =>
    recoverAgentRuntimeExecutionDatabaseCommand(database, input.now, agentId, executionId));
  if (candidateIds.length === input.limit) {
    return {
      recoveries,
      nextCursor: encodeRecoveryCursor({
        version: 1,
        branch: cursor.branch,
        afterExecutionId: candidateIds[candidateIds.length - 1] ?? cursor.afterExecutionId,
      }),
    };
  }
  if (cursor.branch < 1) {
    return {
      recoveries,
      nextCursor: encodeRecoveryCursor({
        version: 1,
        branch: (cursor.branch + 1) as RecoveryBranch,
        afterExecutionId: "",
      }),
    };
  }
  return { recoveries };
}

function toolGrantFromRow(row: Record<string, unknown>): ToolGrant {
  return {
    id: String(row.id), executionId: String(row.executionId), attemptSeq: Number(row.attemptSeq),
    toolCallStepSeq: Number(row.toolCallStepSeq),
    agentId: String(row.agentId), roomId: String(row.roomId), toolId: String(row.toolId),
    parameterHash: String(row.parameterHash), toolPlanHash: String(row.toolPlanHash),
    confirmationRequirement: row.confirmationRequirement as ToolGrant["confirmationRequirement"],
    issuedAt: String(row.issuedAt), expiresAt: String(row.expiresAt),
    ...(typeof row.consumedAt === "string" ? { consumedAt: row.consumedAt } : {}),
  };
}

function toolConfirmationFromRow(row: Record<string, unknown>): ToolConfirmation {
  return {
    id: String(row.id), executionId: String(row.executionId), attemptSeq: Number(row.attemptSeq),
    grantId: String(row.grantId),
    toolId: String(row.toolId), parameterHash: String(row.parameterHash),
    toolPlanHash: String(row.toolPlanHash), roomId: String(row.roomId),
    humanPrincipalId: String(row.humanPrincipalId), sessionFamilyId: String(row.sessionFamilyId),
    target: String(row.target), impact: String(row.impact),
    reversibility: row.reversibility as ToolConfirmation["reversibility"],
    expiresAt: String(row.expiresAt),
    ...(typeof row.consumedAt === "string" ? { consumedAt: row.consumedAt } : {}),
  };
}

function toolDispatchFromRow(row: Record<string, unknown>): ToolDispatch {
  return {
    id: String(row.id), executionId: String(row.executionId), attemptSeq: Number(row.attemptSeq),
    grantId: String(row.grantId), toolId: String(row.toolId), parameterHash: String(row.parameterHash),
    state: row.state as ToolDispatch["state"], dispatchedAt: String(row.dispatchedAt),
    ...(typeof row.settledAt === "string" ? { settledAt: row.settledAt } : {}),
    ...(typeof row.closedSummary === "string" ? { closedSummary: row.closedSummary } : {}),
    ...(typeof row.sealedCompensation === "string" ? { sealedCompensation: row.sealedCompensation } : {}),
  };
}

export function prepareAgentRuntimeToolDatabaseCommand(
  database: DatabaseSync,
  input: PrepareToolInput,
  agentId: string,
): ToolGrant {
  return runAuthorityImmediateTransaction(database, () => {
    const execution = readAgentRuntimeExecutionRow(database, input.executionId);
    if (execution !== undefined && execution.agentId !== agentId) {
      return fail("agent_capability_forbidden", "Agent runtime tool preparation agent was rejected");
    }
    if (execution === undefined || execution.status !== "running" ||
        Number(execution.currentAttemptSeq) !== input.attemptSeq || execution.agentId !== agentId) {
      return fail("execution_conflict", "Agent runtime tool preparation lost execution CAS");
    }
    if (Number(execution.recoveryCursor) !== input.toolCallStepSeq) {
      return fail("execution_conflict", "Agent runtime tool preparation lost tool-call cursor");
    }
    const toolCallStep = database.prepare(
      `SELECT canonical_tool_call_json AS canonicalToolCall,
              output_sha256 AS parameterHash
       FROM agent_execution_steps
       WHERE execution_id = ? AND attempt_seq = ? AND step_seq = ?
         AND step_kind = 'tool_call'`,
    ).get(input.executionId, input.attemptSeq, input.toolCallStepSeq) as
      | { readonly canonicalToolCall: string; readonly parameterHash: string }
      | undefined;
    if (toolCallStep === undefined || toolCallStep.parameterHash !== input.parameterHash) {
      return fail("execution_conflict", "Agent runtime tool grant did not bind the tool-call step");
    }
    let canonicalToolCall: unknown;
    try {
      canonicalToolCall = JSON.parse(toolCallStep.canonicalToolCall);
    } catch {
      return fail("execution_conflict", "Agent runtime tool-call checkpoint was corrupt");
    }
    if (createHash("sha256").update(canonicalJson(canonicalToolCall)).digest("hex") !==
        input.toolPlanHash) {
      return fail("execution_conflict", "Agent runtime tool plan did not bind the tool-call step");
    }
    requireAgentCommandAuthority(database, String(execution.agentId), String(execution.roomId));
    requireAgentToolPermission(database, String(execution.roomId), String(execution.agentId), input.toolId);
    const unsettledDispatch = database.prepare(
      `SELECT 1 AS present FROM agent_tool_dispatches
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'dispatched' LIMIT 1`,
    ).get(input.executionId, input.attemptSeq);
    if (unsettledDispatch !== undefined) {
      return fail("execution_conflict", "Agent runtime attempt already has an unsettled tool dispatch");
    }
    const grantId = stableId("agent-runtime-tool-grant", input.executionId, String(input.attemptSeq),
      String(input.toolCallStepSeq),
      input.toolId, input.parameterHash);
    const existing = database.prepare(
      `SELECT id, execution_id AS executionId, attempt_seq AS attemptSeq,
              tool_call_step_seq AS toolCallStepSeq, agent_id AS agentId,
              room_id AS roomId, tool_id AS toolId, parameter_hash AS parameterHash,
              tool_plan_hash AS toolPlanHash,
              confirmation_requirement AS confirmationRequirement,
              issued_at AS issuedAt, expires_at AS expiresAt, consumed_at AS consumedAt
       FROM agent_tool_grants WHERE id = ?`,
    ).get(grantId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      const grant = toolGrantFromRow(existing);
      if (grant.confirmationRequirement !== input.confirmationRequirement ||
          grant.toolPlanHash !== input.toolPlanHash ||
          grant.expiresAt !== new Date(input.expiresAt).toISOString()) {
        return fail("idempotency_conflict", "Agent runtime tool grant payload changed");
      }
      const replayStateMatches = input.confirmationRequirement === "side_effect"
        ? execution.actionCategory === "waiting_upstream" && execution.toolDispatchPhase === null &&
          execution.currentToolId === null
        : execution.actionCategory === "tool_call" && execution.toolDispatchPhase === "not_started" &&
          execution.currentToolId === input.toolId;
      if (!replayStateMatches) {
        return fail("execution_conflict", "Agent runtime tool grant replay lost execution phase");
      }
      return grant;
    }
    if (execution.actionCategory !== "tool_call" ||
        execution.toolDispatchPhase !== "not_started" || execution.currentToolId !== input.toolId) {
      return fail("execution_conflict", "Agent runtime tool preparation requires an unstarted tool call");
    }
    const issuedAt = new Date(input.now).toISOString();
    const expiresAt = new Date(input.expiresAt).toISOString();
    database.prepare(
      `INSERT INTO agent_tool_grants (
         id, execution_id, attempt_seq, tool_call_step_seq, agent_id, room_id, tool_id,
         parameter_hash, tool_plan_hash, confirmation_requirement, issued_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(grantId, input.executionId, input.attemptSeq, input.toolCallStepSeq,
      String(execution.agentId),
      String(execution.roomId), input.toolId, input.parameterHash, input.toolPlanHash,
      input.confirmationRequirement, issuedAt, expiresAt);
    if (input.confirmationRequirement === "side_effect") {
      const attemptChanged = database.prepare(
        `UPDATE agent_execution_attempts
         SET action_category = 'waiting_upstream', tool_dispatch_phase = NULL
         WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
           AND action_category = 'tool_call' AND tool_dispatch_phase = 'not_started'`,
      ).run(input.executionId, input.attemptSeq);
      const executionChanged = database.prepare(
        `UPDATE agent_executions
         SET action_category = 'waiting_upstream', tool_dispatch_phase = NULL,
             current_tool_id = NULL, updated_at = ?
         WHERE id = ? AND current_attempt_seq = ? AND state = 'running'
           AND action_category = 'tool_call' AND tool_dispatch_phase = 'not_started'
           AND current_tool_id = ?`,
      ).run(issuedAt, input.executionId, input.attemptSeq, input.toolId);
      if (attemptChanged.changes !== 1 || executionChanged.changes !== 1) {
        return fail("execution_conflict", "Agent runtime confirmation wait lost atomic CAS");
      }
      const confirmationRequired = {
        roomId: String(execution.roomId), agentId: String(execution.agentId),
        executionId: input.executionId, attemptSeq: input.attemptSeq, grantId,
        toolId: input.toolId, parameterHash: input.parameterHash, expiresAt,
      };
      const eventId = stableId("event", "agent-runtime-tool-confirmation-required", grantId);
      const streamSeq = appendRoomEvent(database, {
        eventId, roomId: String(execution.roomId), actorId: String(execution.agentId),
        eventType: "room.agent_tool_confirmation.required", occurredAt: issuedAt,
        payload: confirmationRequired,
      });
      appendRoomOutbox(database, eventId, String(execution.roomId), streamSeq, issuedAt,
        "agent-runtime-tool-confirmation-required", grantId);
    }
    return {
      id: grantId, executionId: input.executionId, attemptSeq: input.attemptSeq,
      toolCallStepSeq: input.toolCallStepSeq,
      agentId: String(execution.agentId), roomId: String(execution.roomId), toolId: input.toolId,
      parameterHash: input.parameterHash,
      toolPlanHash: input.toolPlanHash,
      confirmationRequirement: input.confirmationRequirement,
      issuedAt, expiresAt,
    };
  });
}

export interface ConfirmAgentRuntimeToolDatabaseCommandInput {
  readonly context: AuthenticatedCommandContext;
  readonly input: ToolConfirmationInput;
  readonly now: number;
}

export function confirmAgentRuntimeToolDatabaseCommand(
  database: DatabaseSync,
  command: ConfirmAgentRuntimeToolDatabaseCommandInput,
): ToolConfirmation {
  return runAuthorityImmediateTransaction(database, () => {
    const execution = readAgentRuntimeExecutionRow(database, command.input.executionId);
    if (execution === undefined) return fail("execution_conflict", "Agent runtime execution was not found");
    const humanPrincipalId = requireHumanExecutionAuthority(database, command.context, command.now, execution);
    if (execution.status !== "running" || Number(execution.currentAttemptSeq) !== command.input.attemptSeq ||
        execution.actionCategory !== "waiting_upstream" || execution.toolDispatchPhase !== null ||
        execution.currentToolId !== null ||
        command.input.expiresAt <= command.now) {
      return fail("execution_conflict", "Agent runtime tool confirmation lost execution CAS");
    }
    const expiredGrant = database.prepare(
      `SELECT 1 AS present FROM agent_tool_grants
       WHERE execution_id = ? AND attempt_seq = ? AND tool_id = ? AND parameter_hash = ?
         AND confirmation_requirement = 'side_effect' AND consumed_at IS NULL AND expires_at <= ?`,
    ).get(command.input.executionId, command.input.attemptSeq, command.input.toolId,
      command.input.parameterHash, new Date(command.now).toISOString());
    if (expiredGrant !== undefined) {
      return fail("confirmation_expired", "Agent runtime tool confirmation grant expired");
    }
    const grant = database.prepare(
      `SELECT id, tool_plan_hash AS toolPlanHash FROM agent_tool_grants
       WHERE execution_id = ? AND attempt_seq = ? AND tool_id = ? AND parameter_hash = ?
         AND confirmation_requirement = 'side_effect'
         AND consumed_at IS NULL AND expires_at > ?`,
    ).get(command.input.executionId, command.input.attemptSeq, command.input.toolId,
      command.input.parameterHash, new Date(command.now).toISOString());
    if (grant === undefined) return fail("execution_conflict", "Agent runtime tool grant was unavailable");
    const grantId = String((grant as { readonly id: unknown }).id);
    const toolPlanHash = String((grant as { readonly toolPlanHash: unknown }).toolPlanHash);
    const confirmationId = stableId("agent-runtime-tool-confirmation", grantId,
      humanPrincipalId, command.context.sessionFamilyId);
    const existing = database.prepare(
      `SELECT confirmation.id, confirmation.execution_id AS executionId,
              confirmation.attempt_seq AS attemptSeq, confirmation.grant_id AS grantId,
              confirmation.tool_id AS toolId,
              confirmation.parameter_hash AS parameterHash, confirmation.room_id AS roomId,
              confirmation.human_principal_id AS humanPrincipalId,
              confirmation.session_family_id AS sessionFamilyId,
              confirmation.target, confirmation.impact, confirmation.reversibility,
              confirmation.expires_at AS expiresAt,
              confirmation.consumed_at AS consumedAt, grant.tool_plan_hash AS toolPlanHash
       FROM agent_tool_confirmations AS confirmation
       JOIN agent_tool_grants AS grant ON grant.id = confirmation.grant_id
       WHERE confirmation.id = ?`,
    ).get(confirmationId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      const confirmation = toolConfirmationFromRow(existing);
      if (confirmation.target !== command.input.target || confirmation.impact !== command.input.impact ||
          confirmation.reversibility !== command.input.reversibility ||
          confirmation.expiresAt !== new Date(command.input.expiresAt).toISOString()) {
        return fail("idempotency_conflict", "Agent runtime tool confirmation payload changed");
      }
      return confirmation;
    }
    const expiresAt = new Date(command.input.expiresAt).toISOString();
    database.prepare(
      `INSERT INTO agent_tool_confirmations (
         id, execution_id, attempt_seq, grant_id, tool_id, parameter_hash, room_id,
         human_principal_id, session_family_id, target, impact, reversibility, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(confirmationId, command.input.executionId, command.input.attemptSeq, grantId,
      command.input.toolId,
      command.input.parameterHash, String(execution.roomId), humanPrincipalId,
      command.context.sessionFamilyId, command.input.target, command.input.impact,
      command.input.reversibility, expiresAt);
    return {
      id: confirmationId, executionId: command.input.executionId,
      grantId,
      attemptSeq: command.input.attemptSeq, toolId: command.input.toolId,
      parameterHash: command.input.parameterHash, roomId: String(execution.roomId),
      toolPlanHash,
      humanPrincipalId, sessionFamilyId: command.context.sessionFamilyId,
      target: command.input.target, impact: command.input.impact,
      reversibility: command.input.reversibility, expiresAt,
    };
  });
}

export function resumeConfirmedAgentRuntimeToolDatabaseCommand(
  database: DatabaseSync,
  input: ResumeConfirmedToolInput,
  agentId: string,
): ResumedToolDispatch {
  const binding = database.prepare(
    `SELECT confirmation.execution_id AS executionId,
            confirmation.attempt_seq AS attemptSeq,
            confirmation.tool_id AS toolId,
            confirmation.parameter_hash AS parameterHash,
            confirmation.room_id AS roomId,
            grant.id AS grantId,
            grant.tool_plan_hash AS toolPlanHash,
            step.canonical_tool_call_json AS canonicalToolCall
     FROM agent_tool_confirmations AS confirmation
     JOIN agent_tool_grants AS grant
       ON grant.id = confirmation.grant_id
      AND grant.execution_id = confirmation.execution_id
      AND grant.attempt_seq = confirmation.attempt_seq
     JOIN agent_executions AS execution ON execution.id = confirmation.execution_id
     JOIN agent_execution_steps AS step
      ON step.execution_id = confirmation.execution_id
      AND step.attempt_seq = confirmation.attempt_seq
      AND step.step_seq = grant.tool_call_step_seq
      AND step.step_kind = 'tool_call'
      AND json_extract(step.canonical_tool_call_json, '$.toolId') = confirmation.tool_id
      AND step.output_sha256 = confirmation.parameter_hash
     WHERE confirmation.id = ? AND execution.agent_id = ?
     ORDER BY step.step_seq DESC LIMIT 1`,
  ).get(input.confirmationId, agentId) as Record<string, unknown> | undefined;
  if (binding === undefined) {
    return fail("execution_conflict", "Agent runtime confirmed tool binding was unavailable");
  }
  if (
    binding.executionId !== input.executionId ||
    binding.attemptSeq !== input.attemptSeq ||
    binding.toolId !== input.toolId ||
    binding.parameterHash !== input.parameterHash ||
    binding.toolPlanHash !== input.toolPlanHash ||
    binding.roomId !== input.roomId
  ) {
    return fail("execution_conflict", "Agent runtime confirmed tool input binding was rejected");
  }
  let canonicalToolCall: unknown;
  try {
    canonicalToolCall = JSON.parse(String(binding.canonicalToolCall));
  } catch {
    return fail("storage_unavailable", "Agent runtime confirmed tool parameters were corrupt");
  }
  if (typeof canonicalToolCall !== "object" || canonicalToolCall === null ||
      !Object.hasOwn(canonicalToolCall, "parameters")) {
    return fail("execution_conflict", "Agent runtime confirmed tool parameters were unavailable");
  }
  const parameters = (canonicalToolCall as { readonly parameters: JsonValue }).parameters;
  const remainingCallsValue = Object.hasOwn(canonicalToolCall, "remainingCalls")
    ? (canonicalToolCall as { readonly remainingCalls?: unknown }).remainingCalls
    : [];
  if (!Array.isArray(remainingCallsValue) || remainingCallsValue.some((entry) =>
    typeof entry !== "object" || entry === null || Array.isArray(entry) ||
    Object.keys(entry).sort().join("\0") !== "callId\0parameters\0toolId" ||
    typeof (entry as { readonly callId?: unknown }).callId !== "string" ||
    (entry as { readonly callId: string }).callId.length === 0 ||
    typeof (entry as { readonly toolId?: unknown }).toolId !== "string" ||
    (entry as { readonly toolId: string }).toolId.length === 0
  )) {
    return fail("storage_unavailable", "Agent runtime confirmed tool plan was corrupt");
  }
  const remainingCalls = remainingCallsValue as readonly AgentRuntimeToolPlanEntry[];
  if (createHash("sha256").update(canonicalJson(parameters)).digest("hex") !== binding.parameterHash) {
    return fail("storage_unavailable", "Agent runtime confirmed tool parameters failed integrity validation");
  }
  if (createHash("sha256").update(canonicalJson(canonicalToolCall)).digest("hex") !== binding.toolPlanHash) {
    return fail("storage_unavailable", "Agent runtime confirmed tool plan failed integrity validation");
  }
  const existingDispatch = database.prepare(
    `SELECT 1 AS present FROM agent_tool_dispatches WHERE grant_id = ? LIMIT 1`,
  ).get(String(binding.grantId));
  if (existingDispatch !== undefined) {
    return fail("execution_conflict", "Agent runtime confirmed tool was already dispatched");
  }
  const dispatch = dispatchAgentRuntimeToolDatabaseCommand(database, {
    executionId: input.executionId,
    attemptSeq: input.attemptSeq,
    grantId: String(binding.grantId),
    toolId: input.toolId,
    parameterHash: input.parameterHash,
    confirmationRequirement: "side_effect",
    confirmationId: input.confirmationId,
    now: input.now,
  }, agentId);
  const execution = readAgentRuntimeExecutionRow(database, String(binding.executionId));
  if (execution === undefined) {
    return fail("storage_unavailable", "Agent runtime confirmed tool execution disappeared");
  }
  return {
    confirmationId: input.confirmationId,
    execution: agentExecutionFromRuntimeRow(execution),
    dispatch,
    parameters,
    remainingCalls,
    toolPlanHash: String(binding.toolPlanHash),
  };
}

export function dispatchAgentRuntimeToolDatabaseCommand(
  database: DatabaseSync,
  input: DispatchToolInput,
  agentId: string,
): ToolDispatch {
  return runAuthorityImmediateTransaction(database, () => {
    const execution = readAgentRuntimeExecutionRow(database, input.executionId);
    if (execution !== undefined && execution.agentId !== agentId) {
      return fail("agent_capability_forbidden", "Agent runtime tool dispatch agent was rejected");
    }
    if (execution === undefined || execution.status !== "running" ||
        Number(execution.currentAttemptSeq) !== input.attemptSeq || execution.agentId !== agentId) {
      return fail("execution_conflict", "Agent runtime tool dispatch lost execution CAS");
    }
    requireAgentCommandAuthority(database, String(execution.agentId), String(execution.roomId));
    requireAgentToolPermission(database, String(execution.roomId), String(execution.agentId), input.toolId);
    const now = new Date(input.now).toISOString();
    const grant = database.prepare(
      `SELECT id, execution_id AS executionId, attempt_seq AS attemptSeq, agent_id AS agentId,
              room_id AS roomId, tool_id AS toolId, parameter_hash AS parameterHash,
              confirmation_requirement AS confirmationRequirement,
              issued_at AS issuedAt, expires_at AS expiresAt, consumed_at AS consumedAt
       FROM agent_tool_grants WHERE id = ?`,
    ).get(input.grantId) as Record<string, unknown> | undefined;
    const grantIdentityMatches = grant !== undefined && grant.executionId === input.executionId &&
      Number(grant.attemptSeq) === input.attemptSeq && grant.agentId === execution.agentId &&
      grant.roomId === execution.roomId && grant.toolId === input.toolId &&
      grant.parameterHash === input.parameterHash &&
      grant.confirmationRequirement === input.confirmationRequirement;
    if (grantIdentityMatches && typeof grant.expiresAt === "string" && grant.expiresAt <= now) {
      return fail("confirmation_expired", "Agent runtime tool grant expired before dispatch");
    }
    if (grant === undefined || grant.executionId !== input.executionId ||
        Number(grant.attemptSeq) !== input.attemptSeq || grant.agentId !== execution.agentId ||
        grant.roomId !== execution.roomId || grant.toolId !== input.toolId ||
        grant.parameterHash !== input.parameterHash || typeof grant.consumedAt === "string" ||
        typeof grant.expiresAt !== "string" || grant.expiresAt <= now ||
        grant.confirmationRequirement !== input.confirmationRequirement ||
        (grant.confirmationRequirement === "read_only" &&
          (execution.actionCategory !== "tool_call" || execution.toolDispatchPhase !== "not_started" ||
            execution.currentToolId !== input.toolId)) ||
        (grant.confirmationRequirement === "side_effect" &&
          (execution.actionCategory !== "waiting_upstream" || execution.toolDispatchPhase !== null ||
            execution.currentToolId !== null))) {
      return fail("execution_conflict", "Agent runtime tool grant was rejected");
    }
    if (input.confirmationRequirement === "side_effect") {
      const confirmation = database.prepare(
        `SELECT id, human_principal_id AS humanPrincipalId,
                session_family_id AS sessionFamilyId, expires_at AS expiresAt,
                consumed_at AS consumedAt FROM agent_tool_confirmations
         WHERE id = ? AND execution_id = ? AND attempt_seq = ? AND tool_id = ?
           AND parameter_hash = ? AND room_id = ?`,
      ).get(input.confirmationId, input.executionId, input.attemptSeq, input.toolId,
        input.parameterHash, String(execution.roomId)) as Record<string, unknown> | undefined;
      if (confirmation !== undefined && typeof confirmation.expiresAt === "string" &&
          confirmation.expiresAt <= now) {
        return fail("confirmation_expired", "Agent runtime tool confirmation expired before dispatch");
      }
      if (confirmation === undefined || typeof confirmation.consumedAt === "string") {
        return fail("execution_conflict", "Agent runtime tool confirmation was rejected");
      }
      const activeFamily = database.prepare(
        `SELECT 1 AS present FROM sessions
         WHERE family_id = ? AND actor_id = ? AND revoked_at IS NULL
           AND access_expires_at > ? LIMIT 1`,
      ).get(String(confirmation.sessionFamilyId), String(confirmation.humanPrincipalId), input.now);
      if (activeFamily === undefined) {
        return fail("session_revoked", "Agent runtime tool confirmation session is no longer active");
      }
      const consumedConfirmation = database.prepare(
        `UPDATE agent_tool_confirmations SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`,
      ).run(now, input.confirmationId);
      if (consumedConfirmation.changes !== 1) return fail("execution_conflict", "Agent runtime tool confirmation replayed");
    }
    const consumedGrant = database.prepare(
      `UPDATE agent_tool_grants SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`,
    ).run(now, input.grantId);
    const executionUpdate = database.prepare(
      `UPDATE agent_executions SET action_category = 'tool_call',
         tool_dispatch_phase = 'dispatched', current_tool_id = ?, updated_at = ?
       WHERE id = ? AND state = 'running' AND current_attempt_seq = ?
         AND action_category = ? AND tool_dispatch_phase IS ?`,
    ).run(input.toolId, now, input.executionId, input.attemptSeq,
      input.confirmationRequirement === "side_effect" ? "waiting_upstream" : "tool_call",
      input.confirmationRequirement === "side_effect" ? null : "not_started");
    const attemptUpdate = database.prepare(
      `UPDATE agent_execution_attempts SET action_category = 'tool_call',
         tool_dispatch_phase = 'dispatched'
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
         AND action_category = ? AND tool_dispatch_phase IS ?`,
    ).run(input.executionId, input.attemptSeq,
      input.confirmationRequirement === "side_effect" ? "waiting_upstream" : "tool_call",
      input.confirmationRequirement === "side_effect" ? null : "not_started");
    if (consumedGrant.changes !== 1 || executionUpdate.changes !== 1 || attemptUpdate.changes !== 1) {
      return fail("execution_conflict", "Agent runtime tool dispatch lost atomic CAS");
    }
    const dispatchId = stableId("agent-runtime-tool-dispatch", input.grantId);
    database.prepare(
      `INSERT INTO agent_tool_dispatches (
         id, execution_id, attempt_seq, grant_id, tool_id, parameter_hash, state, dispatched_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?)`,
    ).run(dispatchId, input.executionId, input.attemptSeq, input.grantId, input.toolId,
      input.parameterHash, now);
    const changedExecution = agentExecutionFromRuntimeRow({
      ...execution, actionCategory: "tool_call", toolDispatchPhase: "dispatched",
      currentToolId: input.toolId, updatedAt: now,
    });
    const eventId = stableId("event", "agent-runtime-tool-dispatch", dispatchId);
    const streamSeq = appendRoomEvent(database, {
      eventId, roomId: String(execution.roomId), actorId: String(execution.agentId),
      eventType: "room.agent_execution.changed", occurredAt: now,
      payload: changedExecution as unknown as JsonValue,
    });
    appendRoomOutbox(database, eventId, String(execution.roomId), streamSeq, now,
      "agent-runtime-tool-dispatch", dispatchId);
    return {
      id: dispatchId, executionId: input.executionId, attemptSeq: input.attemptSeq,
      grantId: input.grantId, toolId: input.toolId, parameterHash: input.parameterHash,
      state: "dispatched", dispatchedAt: now,
    };
  });
}

export function settleAgentRuntimeToolDatabaseCommand(
  database: DatabaseSync,
  input: SettleToolInput,
  agentId: string,
): ToolDispatch {
  return runAuthorityImmediateTransaction(database, () => {
    const existing = database.prepare(
      `SELECT dispatch.id, dispatch.execution_id AS executionId, dispatch.attempt_seq AS attemptSeq,
              dispatch.grant_id AS grantId, dispatch.tool_id AS toolId,
              dispatch.parameter_hash AS parameterHash, dispatch.state,
              dispatch.dispatched_at AS dispatchedAt, dispatch.settled_at AS settledAt,
              dispatch.closed_summary AS closedSummary, dispatch.sealed_compensation AS sealedCompensation,
              grant.agent_id AS agentId
       FROM agent_tool_dispatches AS dispatch
       JOIN agent_tool_grants AS grant ON grant.id = dispatch.grant_id
       WHERE dispatch.id = ?`,
    ).get(input.dispatchId) as Record<string, unknown> | undefined;
    if (existing === undefined || existing.executionId !== input.executionId ||
        Number(existing.attemptSeq) !== input.attemptSeq || existing.grantId !== input.grantId ||
        existing.agentId !== agentId) {
      if (existing?.agentId !== undefined && existing.agentId !== agentId) {
        return fail("agent_capability_forbidden", "Agent runtime tool settlement agent was rejected");
      }
      return fail("execution_conflict", "Agent runtime tool settlement identity was rejected");
    }
    if (existing.state !== "dispatched") {
      const settled = toolDispatchFromRow(existing);
      if (settled.state !== input.outcome || settled.closedSummary !== input.closedSummary ||
          settled.sealedCompensation !== input.sealedCompensation) {
        return fail("idempotency_conflict", "Agent runtime tool settlement payload changed");
      }
      return settled;
    }
    const settledAt = new Date(input.now).toISOString();
    const grant = database.prepare(
      `SELECT confirmation_requirement AS confirmationRequirement,
              agent_id AS agentId, room_id AS roomId
       FROM agent_tool_grants WHERE id = ?`,
    ).get(input.grantId) as Record<string, unknown> | undefined;
    if (grant === undefined) return fail("storage_unavailable", "Agent runtime tool grant is inconsistent");
    if (grant.agentId !== agentId) {
      return fail("agent_capability_forbidden", "Agent runtime tool settlement agent was rejected");
    }
    const updated = database.prepare(
      `UPDATE agent_tool_dispatches
       SET state = ?, settled_at = ?, closed_summary = ?, sealed_compensation = ?
       WHERE id = ? AND state = 'dispatched'`,
    ).run(input.outcome, settledAt, input.closedSummary ?? null,
      input.sealedCompensation ?? null, input.dispatchId);
    if (updated.changes !== 1) return fail("execution_conflict", "Agent runtime tool settlement lost CAS");
    database.prepare(
      `UPDATE agent_executions SET tool_dispatch_phase = 'finished', updated_at = ?
       WHERE id = ? AND state = 'running' AND current_attempt_seq = ?
         AND action_category = 'tool_call' AND tool_dispatch_phase = 'dispatched'`,
    ).run(settledAt, input.executionId, input.attemptSeq);
    database.prepare(
      `UPDATE agent_execution_attempts SET tool_dispatch_phase = 'finished'
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
         AND action_category = 'tool_call' AND tool_dispatch_phase = 'dispatched'`,
    ).run(input.executionId, input.attemptSeq);
    if (grant?.confirmationRequirement === "side_effect" &&
        (input.outcome === "failed" || input.outcome === "outcome_unknown")) {
      const terminalErrorCode = input.outcome === "failed"
        ? "tool_failure"
        : "side_effect_outcome_unknown";
      const execution = readAgentRuntimeExecutionRow(database, input.executionId);
      if (execution?.status === "running" && Number(execution.currentAttemptSeq) === input.attemptSeq) {
        const attemptChanged = database.prepare(
          `UPDATE agent_execution_attempts
           SET state = 'failed', tool_dispatch_phase = 'finished', finished_at = ?,
               error_code = ?
           WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'`,
        ).run(settledAt, terminalErrorCode, input.executionId, input.attemptSeq);
        const executionChanged = database.prepare(
          `UPDATE agent_executions
           SET state = 'failed', tool_dispatch_phase = 'finished', completed_at = ?, updated_at = ?,
               terminal_error_code = ?
           WHERE id = ? AND current_attempt_seq = ? AND state = 'running'`,
        ).run(settledAt, settledAt, terminalErrorCode, input.executionId, input.attemptSeq);
        if (attemptChanged.changes !== 1 || executionChanged.changes !== 1) {
          return fail("execution_conflict", "Agent runtime unknown side-effect settlement lost CAS");
        }
        const failed = agentExecutionFromRuntimeRow({
          ...execution, status: "failed", toolDispatchPhase: "finished",
          finishedAt: settledAt, updatedAt: settledAt,
          terminalErrorCode,
        });
        const eventId = stableId("event", "agent-runtime-side-effect-unknown",
          input.executionId, String(input.attemptSeq));
        const streamSeq = appendRoomEvent(database, {
          eventId, roomId: String(execution.roomId), actorId: String(execution.agentId),
          eventType: "room.agent_execution.changed", occurredAt: settledAt,
          payload: failed as unknown as JsonValue,
        });
        appendRoomOutbox(database, eventId, String(execution.roomId), streamSeq, settledAt,
          "agent-runtime-side-effect-unknown", input.dispatchId);
      }
    }
    const settledDispatch: ToolDispatch = {
      ...toolDispatchFromRow(existing), state: input.outcome, settledAt,
      ...(input.closedSummary === undefined ? {} : { closedSummary: input.closedSummary }),
      ...(input.sealedCompensation === undefined ? {} : { sealedCompensation: input.sealedCompensation }),
    };
    const observableDispatch = {
      id: settledDispatch.id,
      executionId: settledDispatch.executionId,
      roomId: String(grant.roomId),
      agentId: String(grant.agentId),
      attemptSeq: settledDispatch.attemptSeq,
      grantId: settledDispatch.grantId,
      toolId: settledDispatch.toolId,
      parameterHash: settledDispatch.parameterHash,
      state: settledDispatch.state,
      dispatchedAt: settledDispatch.dispatchedAt,
      settledAt,
      ...(settledDispatch.closedSummary === undefined
        ? {}
        : { closedSummary: settledDispatch.closedSummary }),
    };
    const settlementEventId = stableId("event", "agent-runtime-tool-settlement", input.dispatchId);
    const settlementStreamSeq = appendRoomEvent(database, {
      eventId: settlementEventId, roomId: String(grant.roomId), actorId: String(grant.agentId),
      eventType: "room.agent_tool_dispatch.changed", occurredAt: settledAt,
      payload: observableDispatch as unknown as JsonValue,
    });
    appendRoomOutbox(database, settlementEventId, String(grant.roomId), settlementStreamSeq, settledAt,
      "agent-runtime-tool-settlement", input.dispatchId);
    return settledDispatch;
  });
}

export function readAgentRuntimeExecutionDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  executionId: string,
  now: number,
): AgentExecution {
  const actorId = requireHumanSession(database, context, now);
  const execution = readAgentRuntimeExecutionRow(database, executionId);
  if (execution === undefined) return fail("execution_conflict", "Agent runtime execution was not found");
  requireRoomMembership(database, actorId, String(execution.roomId));
  return agentExecutionFromRuntimeRow(execution);
}

export function loadAgentRuntimeProviderContextDatabaseQuery(
  database: DatabaseSync,
  executionId: string,
  agentId: string,
): AgentRuntimeProviderContext {
  const execution = readAgentRuntimeExecutionRow(database, executionId);
  if (execution === undefined || execution.agentId !== agentId) {
    return fail("agent_capability_forbidden", "Agent runtime provider context was rejected");
  }
  const intent = database.prepare(
    `SELECT intent.source_message_id AS sourceMessageId,
            execution.requester_actor_id AS requesterActorId,
            intent.target_agent_id AS targetAgentId,
            intent.intent_kind AS intentKind,
            message.author_id AS actorId, message.body AS body
     FROM agent_invocation_intents AS intent
     JOIN agent_executions AS execution ON execution.id = intent.execution_id
     JOIN messages AS message ON message.id = intent.source_message_id
     WHERE intent.execution_id = ?`,
  ).get(executionId) as Record<string, unknown> | undefined;
  if (intent === undefined || typeof intent.sourceMessageId !== "string" ||
      typeof intent.requesterActorId !== "string" || intent.targetAgentId !== agentId ||
      !["direct_mention", "structured_help", "routed_candidate"].includes(
        String(intent.intentKind),
      ) || typeof intent.actorId !== "string" || typeof intent.body !== "string") {
    return fail("storage_unavailable", "Agent runtime invocation context is corrupt");
  }
  const rows = database.prepare(
    `SELECT step_seq AS stepSeq, step_kind AS kind,
            canonical_tool_call_json AS canonicalToolCall,
            bounded_tool_result_json AS boundedToolResult,
            input_sha256 AS inputSha256, output_sha256 AS outputSha256
     FROM agent_execution_steps
     WHERE execution_id = ? AND attempt_seq = ? AND step_seq <= ?
     ORDER BY step_seq`,
  ).all(executionId, Number(execution.currentAttemptSeq), Number(execution.recoveryCursor));
  const committedSteps = rows.map((row) => {
    const stepSeq = Number(row.stepSeq);
    if (!Number.isSafeInteger(stepSeq) || stepSeq <= 0 ||
        !["model_generation", "tool_call", "tool_result"].includes(String(row.kind))) {
      return fail("storage_unavailable", "Agent runtime checkpoint context is corrupt");
    }
    let modelInput: JsonValue;
    try {
      modelInput = row.kind === "tool_call"
        ? JSON.parse(String(row.canonicalToolCall)) as JsonValue
        : row.kind === "tool_result"
          ? JSON.parse(String(row.boundedToolResult)) as JsonValue
          : { inputSha256: String(row.inputSha256), outputSha256: String(row.outputSha256) };
    } catch {
      return fail("storage_unavailable", "Agent runtime checkpoint JSON is corrupt");
    }
    return { stepSeq, kind: row.kind as "model_generation" | "tool_call" | "tool_result", modelInput };
  });
  return {
    invocation: {
      sourceMessageId: intent.sourceMessageId,
      requesterActorId: intent.requesterActorId,
      targetAgentId: agentId,
      intentKind: intent.intentKind as "direct_mention" | "structured_help" | "routed_candidate",
    },
    visibleConversation: [{
      messageId: intent.sourceMessageId, actorId: intent.actorId, body: intent.body,
    }],
    committedSteps,
  };
}

export function cancelAgentRuntimeForHumanFenceDatabaseCommand(
  database: DatabaseSync,
  input: CancelForHumanFenceInput,
  agentId: string,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const execution = readAgentRuntimeExecutionRow(database, input.executionId);
    if (execution === undefined || execution.agentId !== agentId) {
      return fail("agent_capability_forbidden", "Agent runtime fence agent was rejected");
    }
    const fenceMessage = database.prepare(
      `SELECT room_id AS roomId, author_id AS authorId, author_kind AS authorKind
       FROM messages WHERE id = ?`,
    ).get(input.fenceMessageId) as Record<string, unknown> | undefined;
    if (fenceMessage === undefined) {
      return fail("message_not_found", "Agent runtime fence message was not an accepted human message");
    }
    if (fenceMessage.roomId !== execution.roomId || fenceMessage.authorKind !== "human") {
      return fail("message_not_found", "Agent runtime fence message was not an accepted human message");
    }
    const fenceAuthorId = String(fenceMessage.authorId);
    const toolDispatchPhase = typeof execution.toolDispatchPhase === "string"
      ? execution.toolDispatchPhase
      : null;
    const existing = database.prepare(
      `SELECT 1 AS present FROM agent_fence_replacements
       WHERE fence_message_id = ? AND old_execution_id = ? AND old_attempt_seq = ?`,
    ).get(input.fenceMessageId, input.executionId, Number(execution.currentAttemptSeq));
    if (existing !== undefined) return agentExecutionFromRuntimeRow(execution);
    const eligible = execution.status === "queued" ||
      (execution.status === "running" && execution.actionCategory === "waiting_upstream") ||
      (execution.status === "running" && execution.actionCategory === "tool_call" &&
        execution.toolDispatchPhase === "not_started");
    if (!eligible) return fail("execution_conflict", "Agent runtime execution is not human-fence eligible");
    const finishedAt = new Date(input.now).toISOString();
    const executionUpdate = database.prepare(
      `UPDATE agent_executions SET state = 'cancelled', completed_at = ?, updated_at = ?,
         cancellation_reason = 'human_fence'
       WHERE id = ? AND current_attempt_seq = ? AND state = ? AND action_category = ?
         AND tool_dispatch_phase IS ?`,
    ).run(finishedAt, finishedAt, input.executionId, Number(execution.currentAttemptSeq),
      String(execution.status), String(execution.actionCategory), toolDispatchPhase);
    const attemptUpdate = database.prepare(
      `UPDATE agent_execution_attempts SET state = 'cancelled', finished_at = ?, next_retry_at = NULL
       WHERE execution_id = ? AND attempt_seq = ? AND state = ? AND action_category = ?
         AND tool_dispatch_phase IS ?`,
    ).run(finishedAt, input.executionId, Number(execution.currentAttemptSeq),
      String(execution.status), String(execution.actionCategory), toolDispatchPhase);
    if (executionUpdate.changes !== 1 || attemptUpdate.changes !== 1) {
      return fail("execution_conflict", "Agent runtime human fence lost CAS");
    }
    const fenceId = stableId("agent-runtime-human-fence", input.fenceMessageId,
      input.executionId, String(execution.currentAttemptSeq));
    database.prepare(
      `INSERT INTO agent_fence_replacements (
         id, fence_message_id, old_execution_id, old_attempt_seq, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(fenceId, input.fenceMessageId, input.executionId,
      Number(execution.currentAttemptSeq), finishedAt);
    const cancelled = agentExecutionFromRuntimeRow({
      ...execution, status: "cancelled", finishedAt, updatedAt: finishedAt,
      cancellationReason: "human_fence",
    });
    const eventId = stableId("event", "agent-runtime-human-fence", fenceId);
    const streamSeq = appendRoomEvent(database, {
      eventId, roomId: String(execution.roomId), actorId: fenceAuthorId,
      eventType: "room.agent_execution.changed", occurredAt: finishedAt,
      payload: cancelled as unknown as JsonValue,
    });
    appendRoomOutbox(database, eventId, String(execution.roomId), streamSeq, finishedAt,
      "agent-runtime-human-fence", fenceId);
    return cancelled;
  });
}

export interface ClaimNextAgentRuntimeDatabaseCommandInput {
  readonly runtime: AgentRuntimeWorkerContext;
  readonly roomId: string;
  readonly now: number;
}

export interface CommitAgentRuntimeStepDatabaseCommandInput {
  readonly runtime: AgentRuntimeWorkerContext;
  readonly input: CommitExecutionStepInput;
}
export interface ScheduleAgentRuntimeRetryDatabaseCommandInput {
  readonly runtime: AgentRuntimeWorkerContext;
  readonly input: ScheduleRetryInput;
  /** Server-private restart path for a side effect whose durable outcome is already settled. */
  readonly allowSettledSideEffectRecovery?: true;
}

export function scheduleAgentRuntimeRetryDatabaseCommand(
  database: DatabaseSync,
  command: ScheduleAgentRuntimeRetryDatabaseCommandInput,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const { input } = command;
    const current = database.prepare(
      `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
              requester_actor_id AS requesterId, agent_id AS agentId,
              state AS status, action_category AS actionCategory,
              tool_dispatch_phase AS toolDispatchPhase, current_tool_id AS currentToolId,
              current_attempt_seq AS currentAttemptSeq, retry_cycle AS retryCycle,
              retry_ordinal AS retryOrdinal, provider_id AS providerId, model_id AS modelId,
              recovery_cursor AS recoveryCursor, queued_at AS queuedAt,
              started_at AS startedAt, updated_at AS updatedAt
       FROM agent_executions
       WHERE id = ? AND state = 'running' AND current_attempt_seq = ?`,
    ).get(input.executionId, input.attemptSeq) as Record<string, unknown> | undefined;
    if (current === undefined) {
      return fail("execution_conflict", "Agent runtime retry lost execution CAS");
    }
    if (current.agentId !== command.runtime.agentId) {
      return fail("agent_capability_forbidden", "Agent runtime retry agent was rejected");
    }
    const sideEffect = database.prepare(
      `SELECT 1 AS present FROM agent_tool_grants
       WHERE execution_id = ? AND attempt_seq = ?
         AND confirmation_requirement = 'side_effect'
       LIMIT 1`,
    ).get(input.executionId, input.attemptSeq);
    const settledSideEffect = database.prepare(
      `SELECT 1 AS present
       FROM agent_tool_dispatches AS dispatch
       JOIN agent_tool_grants AS grant ON grant.id = dispatch.grant_id
       WHERE dispatch.execution_id = ? AND dispatch.attempt_seq = ?
         AND grant.confirmation_requirement = 'side_effect'
         AND dispatch.state IN ('succeeded', 'failed')
       LIMIT 1`,
    ).get(input.executionId, input.attemptSeq);
    const hasDurableToolResult = database.prepare(
      `SELECT 1 AS present FROM agent_execution_steps
       WHERE execution_id = ? AND attempt_seq = ? AND step_kind = 'tool_result'
       LIMIT 1`,
    ).get(input.executionId, input.attemptSeq) !== undefined;
    const canRecoverSettledSideEffect = command.allowSettledSideEffectRecovery === true &&
      settledSideEffect !== undefined &&
      ((current.actionCategory === "tool_call" && current.toolDispatchPhase === "finished") ||
       (current.actionCategory === "model_generation" && hasDurableToolResult));
    if (sideEffect !== undefined && !canRecoverSettledSideEffect) {
      return fail("execution_conflict", "Side-effecting Agent runtime attempts cannot auto retry");
    }
    const retryOrdinal = Number(current.retryOrdinal);
    const finishedAt = new Date(input.now).toISOString();
    database.prepare(
      `UPDATE agent_tool_dispatches
       SET state = 'outcome_unknown', settled_at = ?, closed_summary = 'runtime_restarted'
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'dispatched'
         AND EXISTS (
           SELECT 1 FROM agent_tool_grants AS grant
           WHERE grant.id = agent_tool_dispatches.grant_id
             AND grant.confirmation_requirement = 'read_only'
         )`,
    ).run(finishedAt, input.executionId, input.attemptSeq);
    const closedAttempt = database.prepare(
      `UPDATE agent_execution_attempts
       SET state = 'failed', finished_at = ?, error_code = ?
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'`,
    ).run(finishedAt, input.errorCode, input.executionId, input.attemptSeq);
    if (closedAttempt.changes !== 1) {
      return fail("execution_conflict", "Agent runtime retry lost attempt CAS");
    }

    if (retryOrdinal === 3) {
      const terminal = database.prepare(
        `UPDATE agent_executions
         SET state = 'failed', completed_at = ?, updated_at = ?,
             terminal_error_code = ?, dead_lettered_at = ?
         WHERE id = ? AND state = 'running' AND current_attempt_seq = ?`,
      ).run(finishedAt, finishedAt, input.errorCode, finishedAt, input.executionId, input.attemptSeq);
      if (terminal.changes !== 1) {
        return fail("execution_conflict", "Agent runtime dead-letter lost execution CAS");
      }
      const execution = agentExecutionFromRuntimeRow({
        ...current,
        status: "failed",
        updatedAt: finishedAt,
        finishedAt,
        terminalErrorCode: input.errorCode,
        deadLetteredAt: finishedAt,
      });
      const eventId = stableId("event", "agent-runtime-dead-letter", input.executionId, String(input.attemptSeq));
      const streamSeq = appendRoomEvent(database, {
        eventId,
        roomId: String(current.roomId),
        actorId: String(current.agentId),
        eventType: "room.agent_execution.changed",
        occurredAt: finishedAt,
        payload: execution as unknown as JsonValue,
      });
      appendRoomOutbox(database, eventId, String(current.roomId), streamSeq, finishedAt,
        "agent-runtime-dead-letter", input.executionId);
      return execution;
    }

    const nextAttemptSeq = input.attemptSeq + 1;
    const nextRetryOrdinal = (retryOrdinal + 1) as 2 | 3;
    const nextRetryAt = input.now + (retryOrdinal === 1 ? 1_000 : 4_000);
    const queued = database.prepare(
      `UPDATE agent_executions
       SET state = 'queued', action_category = 'model_generation',
           tool_dispatch_phase = NULL, current_tool_id = NULL,
           current_attempt_seq = ?, retry_ordinal = ?, recovery_cursor = 0,
           started_at = NULL, completed_at = NULL, cancellation_reason = NULL,
           terminal_error_code = NULL, dead_lettered_at = NULL, result_message_id = NULL,
           updated_at = ?
       WHERE id = ? AND state = 'running' AND current_attempt_seq = ?`,
    ).run(nextAttemptSeq, nextRetryOrdinal, finishedAt, input.executionId, input.attemptSeq);
    if (queued.changes !== 1) {
      return fail("execution_conflict", "Agent runtime retry lost execution CAS");
    }
    const execution = agentExecutionFromRuntimeRow({
      ...current,
      status: "queued",
      actionCategory: "model_generation",
      toolDispatchPhase: null,
      currentToolId: null,
      currentAttemptSeq: nextAttemptSeq,
      retryOrdinal: nextRetryOrdinal,
      recoveryCursor: 0,
      startedAt: null,
      updatedAt: finishedAt,
    });
    const eventId = stableId("event", "agent-runtime-retry", input.executionId, String(nextAttemptSeq));
    const streamSeq = appendRoomEvent(database, {
      eventId,
      roomId: String(current.roomId),
      actorId: String(current.agentId),
      eventType: "room.agent_execution.changed",
      occurredAt: finishedAt,
      payload: execution as unknown as JsonValue,
    });
    database.prepare(
      `INSERT INTO agent_execution_attempts (
         execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
         action_category, tool_dispatch_phase, started_at, finished_at,
         error_code, next_retry_at, recovery_cursor, enqueue_stream_seq
       ) VALUES (?, ?, ?, ?, ?, 'queued', 'model_generation', NULL, NULL, NULL, NULL, ?, 0, ?)`,
    ).run(input.executionId, String(current.roomId), nextAttemptSeq, Number(current.retryCycle), nextRetryOrdinal,
      nextRetryAt, streamSeq);
    appendRoomOutbox(database, eventId, String(current.roomId), streamSeq, finishedAt,
      "agent-runtime-retry", input.executionId);
    return execution;
  });
}

export interface FailAgentRuntimeExecutionDatabaseCommandInput {
  readonly runtime: AgentRuntimeWorkerContext;
  readonly input: FailExecutionInput;
}

export function failAgentRuntimeExecutionDatabaseCommand(
  database: DatabaseSync,
  command: FailAgentRuntimeExecutionDatabaseCommandInput,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const { input } = command;
    const current = database.prepare(
      `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
              requester_actor_id AS requesterId, agent_id AS agentId,
              state AS status, action_category AS actionCategory,
              tool_dispatch_phase AS toolDispatchPhase, current_tool_id AS currentToolId,
              current_attempt_seq AS currentAttemptSeq, retry_cycle AS retryCycle,
              retry_ordinal AS retryOrdinal, provider_id AS providerId, model_id AS modelId,
              recovery_cursor AS recoveryCursor, queued_at AS queuedAt,
              started_at AS startedAt, updated_at AS updatedAt,
              completed_at AS finishedAt, cancellation_reason AS cancellationReason,
              terminal_error_code AS terminalErrorCode, dead_lettered_at AS deadLetteredAt,
              result_message_id AS resultMessageId,
              manual_retry_of_execution_id AS manualRetryOfExecutionId,
              compensates_execution_id AS compensatesExecutionId,
              supersedes_execution_ids_json AS supersedesExecutionIdsJson
       FROM agent_executions WHERE id = ?`,
    ).get(input.executionId) as Record<string, unknown> | undefined;
    if (current === undefined || Number(current.currentAttemptSeq) !== input.attemptSeq) {
      return fail("execution_conflict", "Agent runtime terminal failure lost execution CAS");
    }
    if (current.agentId !== command.runtime.agentId) {
      return fail("agent_capability_forbidden", "Agent runtime terminal failure agent was rejected");
    }
    if (current.status === "failed") {
      if (current.terminalErrorCode !== input.errorCode) {
        return fail("idempotency_conflict", "Agent runtime terminal failure payload changed");
      }
      return agentExecutionFromRuntimeRow(current);
    }
    if (current.status !== "running") {
      return fail("execution_conflict", "Agent runtime terminal failure requires a running execution");
    }
    const finishedAt = new Date(input.now).toISOString();
    const closedAttempt = database.prepare(
      `UPDATE agent_execution_attempts
       SET state = 'failed', finished_at = ?, error_code = ?
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'`,
    ).run(finishedAt, input.errorCode, input.executionId, input.attemptSeq);
    if (closedAttempt.changes !== 1) {
      return fail("execution_conflict", "Agent runtime terminal failure lost attempt CAS");
    }
    const terminal = database.prepare(
      `UPDATE agent_executions
       SET state = 'failed', completed_at = ?, updated_at = ?, terminal_error_code = ?
       WHERE id = ? AND state = 'running' AND current_attempt_seq = ?`,
    ).run(finishedAt, finishedAt, input.errorCode, input.executionId, input.attemptSeq);
    if (terminal.changes !== 1) {
      return fail("execution_conflict", "Agent runtime terminal failure lost execution CAS");
    }
    const execution = agentExecutionFromRuntimeRow({
      ...current,
      status: "failed",
      finishedAt,
      updatedAt: finishedAt,
      terminalErrorCode: input.errorCode,
    });
    const eventId = stableId(
      "event",
      "agent-runtime-terminal-failure",
      input.executionId,
      String(input.attemptSeq),
    );
    const streamSeq = appendRoomEvent(database, {
      eventId,
      roomId: String(current.roomId),
      actorId: String(current.agentId),
      eventType: "room.agent_execution.changed",
      occurredAt: finishedAt,
      payload: execution as unknown as JsonValue,
    });
    appendRoomOutbox(
      database,
      eventId,
      String(current.roomId),
      streamSeq,
      finishedAt,
      "agent-runtime-terminal-failure",
      input.executionId,
    );
    return execution;
  });
}

export function commitAgentRuntimeStepDatabaseCommand(
  database: DatabaseSync,
  command: CommitAgentRuntimeStepDatabaseCommandInput,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const { input } = command;
    const current = database.prepare(`SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
      requester_actor_id AS requesterId, agent_id AS agentId, provider_id AS providerId, model_id AS modelId,
      current_attempt_seq AS currentAttemptSeq, retry_cycle AS retryCycle, retry_ordinal AS retryOrdinal,
      action_category AS actionCategory, tool_dispatch_phase AS toolDispatchPhase,
      current_tool_id AS currentToolId, recovery_cursor AS recoveryCursor,
      queued_at AS queuedAt, started_at AS startedAt, updated_at AS updatedAt
      FROM agent_executions WHERE id = ? AND state = 'running' AND current_attempt_seq = ?`).get(input.executionId, input.attemptSeq) as Record<string, unknown> | undefined;
    if (current === undefined) return fail("execution_conflict", "Agent runtime checkpoint lost execution CAS");
    if (current.agentId !== command.runtime.agentId) {
      return fail("agent_capability_forbidden", "Agent runtime checkpoint agent was rejected");
    }
    if (input.stepKind === "model_generation" && current.actionCategory !== "model_generation") {
      return fail("execution_conflict", "Agent runtime model checkpoint requires model generation");
    }
    if (input.stepKind === "tool_call" && current.actionCategory !== "model_generation") {
      return fail("execution_conflict", "Agent runtime tool-call checkpoint requires model generation");
    }
    if (input.stepKind === "tool_result") {
      const currentToolId = typeof current.currentToolId === "string" ? current.currentToolId : null;
      const settledTool = database.prepare(
        `SELECT dispatch.state AS dispatchState, dispatch.tool_id AS toolId
         FROM agent_tool_dispatches AS dispatch
         JOIN agent_tool_grants AS grant ON grant.id = dispatch.grant_id
         JOIN agent_execution_steps AS tool_call
           ON tool_call.execution_id = dispatch.execution_id
          AND tool_call.attempt_seq = dispatch.attempt_seq
          AND tool_call.step_seq = ?
          AND tool_call.step_kind = 'tool_call'
         WHERE dispatch.id = ? AND dispatch.execution_id = ? AND dispatch.attempt_seq = ?
           AND dispatch.tool_id = ?
           AND grant.execution_id = dispatch.execution_id
           AND grant.attempt_seq = dispatch.attempt_seq
           AND grant.tool_id = dispatch.tool_id
           AND dispatch.state = 'succeeded'
           AND json_extract(tool_call.canonical_tool_call_json, '$.toolId') = dispatch.tool_id
           AND dispatch.dispatched_at >= tool_call.completed_at`,
      ).get(input.stepSeq - 1, input.dispatchId, input.executionId, input.attemptSeq,
        currentToolId);
      if (current.actionCategory !== "tool_call" || current.toolDispatchPhase !== "finished" ||
          currentToolId === null || settledTool === undefined) {
        return fail("execution_conflict", "Agent runtime tool result requires a safely settled dispatch");
      }
    }
    const changed = input.stepKind === "tool_result"
      ? database.prepare(`UPDATE agent_execution_attempts
          SET recovery_cursor = ?, action_category = 'model_generation', tool_dispatch_phase = NULL
          WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
            AND recovery_cursor = ? AND action_category = 'tool_call'
            AND tool_dispatch_phase = 'finished'`).run(
          input.stepSeq, input.executionId, input.attemptSeq, input.stepSeq - 1,
        )
      : input.stepKind === "tool_call"
        ? database.prepare(`UPDATE agent_execution_attempts
            SET recovery_cursor = ?, action_category = 'tool_call', tool_dispatch_phase = 'not_started'
            WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
              AND recovery_cursor = ? AND action_category = 'model_generation'
              AND tool_dispatch_phase IS NULL`).run(
            input.stepSeq, input.executionId, input.attemptSeq, input.stepSeq - 1,
          )
        : database.prepare(`UPDATE agent_execution_attempts SET recovery_cursor = ?
          WHERE execution_id = ? AND attempt_seq = ? AND state = 'running' AND recovery_cursor = ?`).run(
          input.stepSeq, input.executionId, input.attemptSeq, input.stepSeq - 1,
        );
    if (changed.changes !== 1) return fail("execution_conflict", "Agent runtime checkpoint lost attempt CAS");
    database.prepare(`INSERT INTO agent_execution_steps (execution_id, attempt_seq, step_seq, step_kind, canonical_tool_call_json, bounded_tool_result_json, dispatch_id, input_sha256, output_sha256, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(input.executionId, input.attemptSeq, input.stepSeq, input.stepKind,
      input.stepKind === "tool_call" ? canonicalJson(input.canonicalToolCall) : null,
      input.stepKind === "tool_result" ? canonicalJson(input.boundedToolResult) : null,
      input.stepKind === "tool_result" ? input.dispatchId : null,
      input.inputSha256, input.outputSha256, new Date(input.now).toISOString());
    const completedAt = new Date(input.now).toISOString();
    const executionChanged = input.stepKind === "tool_result"
      ? database.prepare(`UPDATE agent_executions
          SET recovery_cursor = ?, action_category = 'model_generation',
              tool_dispatch_phase = NULL, current_tool_id = NULL, updated_at = ?
          WHERE id = ? AND current_attempt_seq = ? AND state = 'running'
            AND action_category = 'tool_call' AND tool_dispatch_phase = 'finished'`).run(
          input.stepSeq, completedAt, input.executionId, input.attemptSeq,
        )
      : input.stepKind === "tool_call"
        ? database.prepare(`UPDATE agent_executions
            SET recovery_cursor = ?, action_category = 'tool_call',
                tool_dispatch_phase = 'not_started', current_tool_id = ?, updated_at = ?
            WHERE id = ? AND current_attempt_seq = ? AND state = 'running'
              AND action_category = 'model_generation' AND tool_dispatch_phase IS NULL
              AND current_tool_id IS NULL`).run(
            input.stepSeq, input.canonicalToolCall.toolId, completedAt,
            input.executionId, input.attemptSeq,
          )
        : database.prepare(`UPDATE agent_executions SET recovery_cursor = ?, updated_at = ?
          WHERE id = ? AND current_attempt_seq = ? AND state = 'running'`).run(
          input.stepSeq, completedAt, input.executionId, input.attemptSeq,
        );
    if (executionChanged.changes !== 1) {
      return fail("execution_conflict", "Agent runtime checkpoint lost execution transition CAS");
    }
    const execution = agentExecutionFromRuntimeRow({
      ...current, status: "running",
      ...(input.stepKind === "tool_result"
        ? { actionCategory: "model_generation", toolDispatchPhase: null, currentToolId: null }
        : input.stepKind === "tool_call"
          ? { actionCategory: "tool_call", toolDispatchPhase: "not_started",
              currentToolId: input.canonicalToolCall.toolId }
        : {}),
      recoveryCursor: input.stepSeq, updatedAt: completedAt,
    });
    const eventId = stableId("event", "agent-runtime-checkpoint", input.executionId,
      String(input.attemptSeq), String(input.stepSeq));
    const streamSeq = appendRoomEvent(database, {
      eventId, roomId: String(current.roomId), actorId: String(current.agentId),
      eventType: "room.agent_execution.changed", occurredAt: completedAt,
      payload: execution as unknown as JsonValue,
    });
    appendRoomOutbox(database, eventId, String(current.roomId), streamSeq, completedAt,
      "agent-runtime-checkpoint", input.executionId);
    return execution;
  });
}

export function completeAgentRuntimeExecutionDatabaseCommand(
  database: DatabaseSync,
  input: CompleteExecutionInput,
  agentId: string,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const requestHash = createHash("sha256").update(canonicalJson({
      messageId: input.messageId, body: input.body, sentAt: input.sentAt,
    })).digest("hex");
    const completion = database.prepare(
      `SELECT request_hash AS requestHash, message_id AS messageId
       FROM agent_execution_completions
       WHERE execution_id = ? AND attempt_seq = ?`,
    ).get(input.executionId, input.attemptSeq) as Record<string, unknown> | undefined;
    if (completion !== undefined) {
      if (completion.requestHash !== requestHash || completion.messageId !== input.messageId) {
        return fail("idempotency_conflict", "Agent runtime completion payload changed");
      }
      const replay = readAgentRuntimeExecutionRow(database, input.executionId);
      if (replay === undefined || replay.status !== "completed" || replay.agentId !== agentId ||
          replay.resultMessageId !== input.messageId) {
        return fail("storage_unavailable", "Agent runtime completion record is inconsistent");
      }
      return agentExecutionFromRuntimeRow(replay);
    }
    const current = readAgentRuntimeExecutionRow(database, input.executionId);
    if (current !== undefined && current.agentId !== agentId) {
      return fail("agent_capability_forbidden", "Agent runtime completion agent was rejected");
    }
    if (current === undefined || current.status !== "running" || current.agentId !== agentId ||
        Number(current.currentAttemptSeq) !== input.attemptSeq ||
        current.actionCategory !== "model_generation") {
      return fail("execution_conflict", "Agent runtime completion lost execution CAS");
    }
    requireAgentCommandAuthority(database, String(current.agentId), String(current.roomId));
    const completedAt = new Date(input.now).toISOString();
    database.prepare(
      `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
       VALUES (?, ?, ?, 'agent', ?, ?)`,
    ).run(input.messageId, String(current.roomId), String(current.agentId), input.body, input.sentAt);
    database.prepare(
      `INSERT INTO agent_execution_completions (
         execution_id, attempt_seq, message_id, request_hash, completed_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(input.executionId, input.attemptSeq, input.messageId, requestHash, completedAt);
    const attemptChanged = database.prepare(
      `UPDATE agent_execution_attempts
       SET state = 'completed', finished_at = ?
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
         AND action_category = 'model_generation'`,
    ).run(completedAt, input.executionId, input.attemptSeq);
    const executionChanged = database.prepare(
      `UPDATE agent_executions
       SET state = 'completed', completed_at = ?, updated_at = ?, result_message_id = ?
       WHERE id = ? AND current_attempt_seq = ? AND state = 'running'
         AND action_category = 'model_generation'`,
    ).run(completedAt, completedAt, input.messageId, input.executionId, input.attemptSeq);
    if (attemptChanged.changes !== 1 || executionChanged.changes !== 1) {
      return fail("execution_conflict", "Agent runtime completion lost atomic CAS");
    }
    const message: Message = {
      id: input.messageId, roomId: String(current.roomId), authorId: String(current.agentId),
      authorKind: "agent", body: input.body, sentAt: input.sentAt,
    };
    const messageEventId = stableId("event", "agent-runtime-complete-message", input.messageId);
    const messageStreamSeq = appendRoomEvent(database, {
      eventId: messageEventId, roomId: String(current.roomId), actorId: String(current.agentId),
      eventType: "room.message.accepted", occurredAt: completedAt,
      payload: message as unknown as JsonValue,
    });
    appendRoomOutbox(database, messageEventId, String(current.roomId), messageStreamSeq, completedAt,
      "agent-runtime-complete-message", input.messageId);
    const execution = agentExecutionFromRuntimeRow({
      ...current, status: "completed", finishedAt: completedAt, updatedAt: completedAt,
      resultMessageId: input.messageId,
    });
    const executionEventId = stableId("event", "agent-runtime-complete", input.executionId,
      String(input.attemptSeq));
    const executionStreamSeq = appendRoomEvent(database, {
      eventId: executionEventId, roomId: String(current.roomId), actorId: String(current.agentId),
      eventType: "room.agent_execution.changed", occurredAt: completedAt,
      payload: execution as unknown as JsonValue,
    });
    appendRoomOutbox(database, executionEventId, String(current.roomId), executionStreamSeq, completedAt,
      "agent-runtime-complete", input.executionId);
    return execution;
  });
}

export function completeAgentRuntimeCompensationDatabaseCommand(
  database: DatabaseSync,
  input: CompleteCompensationInput,
  agentId: string,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const requestHash = createHash("sha256").update(canonicalJson({
      dispatchId: input.dispatchId,
      grantId: input.grantId,
      boundedToolResult: input.boundedToolResult,
      inputSha256: input.inputSha256,
      outputSha256: input.outputSha256,
      closedSummary: input.closedSummary,
      messageId: input.messageId,
      body: input.body,
      sentAt: input.sentAt,
    })).digest("hex");
    const completion = database.prepare(
      `SELECT request_hash AS requestHash, message_id AS messageId
       FROM agent_execution_completions
       WHERE execution_id = ? AND attempt_seq = ?`,
    ).get(input.executionId, input.attemptSeq) as Record<string, unknown> | undefined;
    if (completion !== undefined) {
      if (completion.requestHash !== requestHash || completion.messageId !== input.messageId) {
        return fail("idempotency_conflict", "Agent runtime compensation completion payload changed");
      }
      const replay = readAgentRuntimeExecutionRow(database, input.executionId);
      if (replay === undefined || replay.status !== "completed" || replay.agentId !== agentId ||
          replay.resultMessageId !== input.messageId || replay.compensatesExecutionId === undefined) {
        return fail("storage_unavailable", "Agent runtime compensation completion record is inconsistent");
      }
      return agentExecutionFromRuntimeRow(replay);
    }
    const current = readAgentRuntimeExecutionRow(database, input.executionId);
    if (current !== undefined && current.agentId !== agentId) {
      return fail("agent_capability_forbidden", "Agent runtime compensation completion agent was rejected");
    }
    const outputHash = createHash("sha256")
      .update(canonicalJson(input.boundedToolResult))
      .digest("hex");
    const binding = database.prepare(
      `SELECT dispatch.state AS dispatchState, dispatch.parameter_hash AS parameterHash,
              dispatch.tool_id AS toolId, dispatch.dispatched_at AS dispatchedAt,
              grant.confirmation_requirement AS confirmationRequirement,
              grant.room_id AS roomId, grant.agent_id AS agentId,
              step.step_kind AS stepKind
       FROM agent_tool_dispatches AS dispatch
       JOIN agent_tool_grants AS grant ON grant.id = dispatch.grant_id
       JOIN agent_execution_steps AS step
         ON step.execution_id = dispatch.execution_id
        AND step.attempt_seq = dispatch.attempt_seq
        AND step.step_seq = grant.tool_call_step_seq
       JOIN agent_compensation_requests AS compensation
         ON compensation.execution_id = dispatch.execution_id
       WHERE dispatch.id = ? AND dispatch.execution_id = ? AND dispatch.attempt_seq = ?
         AND dispatch.grant_id = ?`,
    ).get(input.dispatchId, input.executionId, input.attemptSeq, input.grantId) as
      Record<string, unknown> | undefined;
    if (current === undefined || current.status !== "running" || current.agentId !== agentId ||
        current.compensatesExecutionId === undefined ||
        Number(current.currentAttemptSeq) !== input.attemptSeq ||
        current.actionCategory !== "tool_call" || current.toolDispatchPhase !== "dispatched" ||
        Number(current.recoveryCursor) !== 1 || binding === undefined ||
        binding.dispatchState !== "dispatched" || binding.confirmationRequirement !== "side_effect" ||
        binding.agentId !== agentId || binding.roomId !== current.roomId ||
        binding.toolId !== current.currentToolId || binding.stepKind !== "tool_call" ||
        binding.parameterHash !== input.inputSha256 || outputHash !== input.outputSha256) {
      return fail("execution_conflict", "Agent runtime compensation completion binding was rejected");
    }
    requireAgentCommandAuthority(database, agentId, String(current.roomId));
    const completedAt = new Date(input.now).toISOString();
    const settled = database.prepare(
      `UPDATE agent_tool_dispatches
       SET state = 'succeeded', settled_at = ?, closed_summary = ?
       WHERE id = ? AND state = 'dispatched'`,
    ).run(completedAt, input.closedSummary, input.dispatchId);
    if (settled.changes !== 1) {
      return fail("execution_conflict", "Agent runtime compensation settlement lost CAS");
    }
    database.prepare(
      `INSERT INTO agent_execution_steps (
         execution_id, attempt_seq, step_seq, step_kind, bounded_tool_result_json,
         dispatch_id, input_sha256, output_sha256, completed_at
       ) VALUES (?, ?, 2, 'tool_result', ?, ?, ?, ?, ?)`,
    ).run(input.executionId, input.attemptSeq, canonicalJson(input.boundedToolResult),
      input.dispatchId, input.inputSha256, input.outputSha256, completedAt);
    database.prepare(
      `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
       VALUES (?, ?, ?, 'agent', ?, ?)`,
    ).run(input.messageId, String(current.roomId), agentId, input.body, input.sentAt);
    database.prepare(
      `INSERT INTO agent_execution_completions (
         execution_id, attempt_seq, message_id, request_hash, completed_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(input.executionId, input.attemptSeq, input.messageId, requestHash, completedAt);
    const attemptChanged = database.prepare(
      `UPDATE agent_execution_attempts
       SET state = 'completed', action_category = 'model_generation',
           tool_dispatch_phase = NULL, recovery_cursor = 2, finished_at = ?
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'running'
         AND action_category = 'tool_call' AND tool_dispatch_phase = 'dispatched'
         AND recovery_cursor = 1`,
    ).run(completedAt, input.executionId, input.attemptSeq);
    const executionChanged = database.prepare(
      `UPDATE agent_executions
       SET state = 'completed', action_category = 'model_generation',
           tool_dispatch_phase = NULL, current_tool_id = NULL, recovery_cursor = 2,
           completed_at = ?, updated_at = ?, result_message_id = ?
       WHERE id = ? AND current_attempt_seq = ? AND state = 'running'
         AND action_category = 'tool_call' AND tool_dispatch_phase = 'dispatched'
         AND recovery_cursor = 1`,
    ).run(completedAt, completedAt, input.messageId, input.executionId, input.attemptSeq);
    if (attemptChanged.changes !== 1 || executionChanged.changes !== 1) {
      return fail("execution_conflict", "Agent runtime compensation completion lost atomic CAS");
    }
    const continued = agentExecutionFromRuntimeRow({
      ...current,
      status: "running",
      actionCategory: "model_generation",
      toolDispatchPhase: null,
      currentToolId: null,
      recoveryCursor: 2,
      updatedAt: completedAt,
    });
    const dispatchEventId = stableId("event", "agent-runtime-tool-settlement", input.dispatchId);
    const dispatchStreamSeq = appendRoomEvent(database, {
      eventId: dispatchEventId,
      roomId: String(current.roomId),
      actorId: agentId,
      eventType: "room.agent_tool_dispatch.changed",
      occurredAt: completedAt,
      payload: {
        id: input.dispatchId,
        executionId: input.executionId,
        roomId: String(current.roomId),
        agentId,
        attemptSeq: input.attemptSeq,
        grantId: input.grantId,
        toolId: String(binding.toolId),
        parameterHash: String(binding.parameterHash),
        state: "succeeded",
        dispatchedAt: String(binding.dispatchedAt),
        settledAt: completedAt,
        closedSummary: input.closedSummary,
      },
    });
    appendRoomOutbox(database, dispatchEventId, String(current.roomId), dispatchStreamSeq,
      completedAt, "agent-runtime-tool-settlement", input.dispatchId);
    const checkpointEventId = stableId("event", "agent-runtime-checkpoint", input.executionId,
      String(input.attemptSeq), "2");
    const checkpointStreamSeq = appendRoomEvent(database, {
      eventId: checkpointEventId,
      roomId: String(current.roomId),
      actorId: agentId,
      eventType: "room.agent_execution.changed",
      occurredAt: completedAt,
      payload: continued as unknown as JsonValue,
    });
    appendRoomOutbox(database, checkpointEventId, String(current.roomId), checkpointStreamSeq,
      completedAt, "agent-runtime-checkpoint", input.executionId);
    const message: Message = {
      id: input.messageId,
      roomId: String(current.roomId),
      authorId: agentId,
      authorKind: "agent",
      body: input.body,
      sentAt: input.sentAt,
    };
    const messageEventId = stableId("event", "agent-runtime-complete-message", input.messageId);
    const messageStreamSeq = appendRoomEvent(database, {
      eventId: messageEventId,
      roomId: String(current.roomId),
      actorId: agentId,
      eventType: "room.message.accepted",
      occurredAt: completedAt,
      payload: message as unknown as JsonValue,
    });
    appendRoomOutbox(database, messageEventId, String(current.roomId), messageStreamSeq,
      completedAt, "agent-runtime-complete-message", input.messageId);
    const execution = agentExecutionFromRuntimeRow({
      ...continued,
      status: "completed",
      finishedAt: completedAt,
      updatedAt: completedAt,
      resultMessageId: input.messageId,
    });
    const executionEventId = stableId("event", "agent-runtime-complete", input.executionId,
      String(input.attemptSeq));
    const executionStreamSeq = appendRoomEvent(database, {
      eventId: executionEventId,
      roomId: String(current.roomId),
      actorId: agentId,
      eventType: "room.agent_execution.changed",
      occurredAt: completedAt,
      payload: execution as unknown as JsonValue,
    });
    appendRoomOutbox(database, executionEventId, String(current.roomId), executionStreamSeq,
      completedAt, "agent-runtime-complete", input.executionId);
    return execution;
  });
}

export function claimNextAgentRuntimeDatabaseCommand(
  database: DatabaseSync,
  input: ClaimNextAgentRuntimeDatabaseCommandInput,
): AgentExecution | undefined {
  return runAuthorityImmediateTransaction(database, () => {
    const active = database.prepare(
      `SELECT 1 AS present FROM agent_executions
       WHERE room_id = ? AND state = 'running' LIMIT 1`,
    ).get(input.roomId);
    if (active !== undefined) return undefined;
    const current = database.prepare(
      `SELECT execution.id, execution.room_id AS roomId,
              execution.source_message_id AS sourceMessageId,
              execution.requester_actor_id AS requesterId, execution.agent_id AS agentId,
              execution.provider_id AS providerId, execution.model_id AS modelId,
              execution.current_attempt_seq AS currentAttemptSeq, execution.retry_cycle AS retryCycle,
              execution.retry_ordinal AS retryOrdinal, execution.recovery_cursor AS recoveryCursor,
              execution.queued_at AS queuedAt
       FROM agent_execution_attempts AS attempt
       JOIN agent_executions AS execution
         ON execution.id = attempt.execution_id AND execution.current_attempt_seq = attempt.attempt_seq
       WHERE attempt.room_id = ? AND attempt.state = 'queued' AND execution.state = 'queued'
         AND (attempt.next_retry_at IS NULL OR attempt.next_retry_at <= ?)
       ORDER BY attempt.enqueue_stream_seq ASC LIMIT 1`,
    ).get(input.roomId, input.now) as Record<string, unknown> | undefined;
    if (current === undefined) return undefined;
    if (current.agentId !== input.runtime.agentId) return undefined;
    const startedAt = new Date(input.now).toISOString();
    const updateExecution = database.prepare(
      `UPDATE agent_executions
       SET state = 'running', started_at = ?, updated_at = ?
       WHERE id = ? AND state = 'queued' AND current_attempt_seq = ?`,
    ).run(startedAt, startedAt, String(current.id), Number(current.currentAttemptSeq));
    if (updateExecution.changes !== 1) return undefined;
    const updateAttempt = database.prepare(
      `UPDATE agent_execution_attempts
       SET state = 'running', started_at = ?
       WHERE execution_id = ? AND attempt_seq = ? AND state = 'queued'`,
    ).run(startedAt, String(current.id), Number(current.currentAttemptSeq));
    if (updateAttempt.changes !== 1) {
      throw new Error("Agent runtime claim lost attempt CAS");
    }
    const execution = agentExecutionFromRuntimeRow({
      ...current, status: "running", actionCategory: "model_generation", startedAt, updatedAt: startedAt,
    });
    const eventId = stableId("event", "agent-runtime-claim", String(current.id), String(current.currentAttemptSeq));
    const streamSeq = appendRoomEvent(database, {
      eventId, roomId: input.roomId, actorId: String(current.agentId),
      eventType: "room.agent_execution.changed", occurredAt: startedAt,
      payload: execution as unknown as JsonValue,
    });
    appendRoomOutbox(database, eventId, input.roomId, streamSeq, startedAt,
      "agent-runtime-claim", String(current.id));
    return execution;
  });
}

export function invokeAgentRuntimeDatabaseCommand(
  database: DatabaseSync,
  input: InvokeAgentRuntimeDatabaseCommandInput,
): AgentExecution {
  return runAuthorityImmediateTransaction(database, () => {
    const requesterId = input.context.kind === "human"
      ? requireHumanSession(database, input.context, input.now)
      : input.context.agent.actorId;
    if (input.context.kind === "human") {
      requireRoomMembership(database, requesterId, input.input.roomId);
    } else {
      requireAgentCommandAuthority(database, requesterId, input.input.roomId);
    }
    const source = database.prepare(
      `SELECT room_id AS roomId, author_id AS authorId FROM messages WHERE id = ?`,
    ).get(input.input.sourceMessageId) as Record<string, unknown> | undefined;
    if (source?.roomId !== input.input.roomId || source.authorId !== requesterId) {
      return fail("message_not_found", "Agent runtime source message was not authorized");
    }
    const target = database.prepare(
      `SELECT actor.readiness, membership.participation, membership.configured_at AS configuredAt
       FROM actors AS actor
       JOIN room_memberships AS membership ON membership.actor_id = actor.id
       WHERE actor.id = ? AND actor.kind = 'agent' AND membership.room_id = ?
         AND membership.kind = 'agent'`,
    ).get(input.input.targetAgentId, input.input.roomId) as Record<string, unknown> | undefined;
    const directMandatory = input.input.intentKind === "direct_mention";
    if (target === undefined || target.configuredAt === null ||
        target.readiness === "paused" || target.readiness === "noauth" ||
        (!directMandatory && target.participation !== "active")) {
      return fail("room_member_not_found", "Agent runtime target Agent is not executable");
    }
    const existing = database.prepare(
      `SELECT execution.id, execution.room_id AS roomId,
              execution.source_message_id AS sourceMessageId,
              execution.requester_actor_id AS requesterId, execution.agent_id AS agentId,
              execution.state AS status, execution.action_category AS actionCategory,
              execution.current_attempt_seq AS currentAttemptSeq, execution.retry_cycle AS retryCycle,
              execution.retry_ordinal AS retryOrdinal, execution.provider_id AS providerId,
              execution.model_id AS modelId, execution.recovery_cursor AS recoveryCursor,
              execution.queued_at AS queuedAt, execution.updated_at AS updatedAt,
              intent.intent_kind AS intentKind
       FROM agent_invocation_intents AS intent
       JOIN agent_executions AS execution ON execution.id = intent.execution_id
       WHERE intent.source_message_id = ? AND intent.target_agent_id = ?`,
    ).get(input.input.sourceMessageId, input.input.targetAgentId) as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      if (existing.roomId !== input.input.roomId || existing.requesterId !== requesterId ||
          existing.providerId !== input.input.providerId || existing.modelId !== input.input.modelId) {
        return fail("idempotency_conflict", "Agent runtime invocation payload conflicts with its intent");
      }
      const priority = { routed_candidate: 1, structured_help: 2, direct_mention: 3 } as const;
      const oldKind = existing.intentKind as keyof typeof priority;
      if (priority[input.input.intentKind] > priority[oldKind]) {
        database.prepare(
          `UPDATE agent_invocation_intents SET intent_kind = ?
           WHERE source_message_id = ? AND target_agent_id = ? AND intent_kind = ?`,
        ).run(input.input.intentKind, input.input.sourceMessageId, input.input.targetAgentId, oldKind);
      }
      return agentExecutionFromRuntimeRow(existing);
    }
    if (input.maxQueuedPerRoom !== undefined) {
      const outstanding = database.prepare(
        `SELECT COUNT(*) AS count FROM agent_executions
         WHERE room_id = ? AND state IN ('queued', 'running')`,
      ).get(input.input.roomId) as { readonly count: number };
      if (outstanding.count >= input.maxQueuedPerRoom + 1) {
        return fail("target_busy", "Agent runtime room queue is full");
      }
    }
    const acceptedAt = new Date(input.now).toISOString();
    const executionId = stableId(
      "agent-runtime-execution", input.input.sourceMessageId, input.input.targetAgentId,
    );
    database.prepare(
      `INSERT INTO agent_executions (
        id, room_id, agent_id, source_message_id, requester_actor_id, state,
        action_category, tool_dispatch_phase, current_tool_id, current_attempt_seq,
        retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
        queued_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 'model_generation', NULL, NULL, 1, 1, 1, ?, ?, 0, ?, ?)`,
    ).run(executionId, input.input.roomId, input.input.targetAgentId,
      input.input.sourceMessageId, requesterId, input.input.providerId, input.input.modelId,
      acceptedAt, acceptedAt);
    const execution = agentExecutionFromRuntimeRow({
      id: executionId, roomId: input.input.roomId, sourceMessageId: input.input.sourceMessageId,
      requesterId, agentId: input.input.targetAgentId, status: "queued", actionCategory: "model_generation",
      currentAttemptSeq: 1, retryCycle: 1, retryOrdinal: 1, providerId: input.input.providerId,
      modelId: input.input.modelId, recoveryCursor: 0, queuedAt: acceptedAt, updatedAt: acceptedAt,
    });
    const eventId = stableId("event", "agent-runtime-invoke", executionId);
    const streamSeq = appendRoomEvent(database, {
      eventId, roomId: input.input.roomId, actorId: input.input.targetAgentId,
      eventType: "room.agent_execution.changed", occurredAt: acceptedAt,
      payload: execution as unknown as JsonValue,
    });
    database.prepare(
      `INSERT INTO agent_execution_attempts (
        execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state, action_category,
        tool_dispatch_phase, started_at, finished_at, error_code, next_retry_at, recovery_cursor,
        enqueue_stream_seq
      ) VALUES (?, ?, 1, 1, 1, 'queued', 'model_generation', NULL, NULL, NULL, NULL, NULL, 0, ?)`,
    ).run(executionId, input.input.roomId, streamSeq);
    database.prepare(
      `INSERT INTO agent_invocation_intents (
        id, source_message_id, target_agent_id, intent_kind, execution_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(stableId("agent-runtime-intent", input.input.sourceMessageId, input.input.targetAgentId),
      input.input.sourceMessageId, input.input.targetAgentId, input.input.intentKind, executionId, acceptedAt);
    appendRoomOutbox(database, eventId, input.input.roomId, streamSeq, acceptedAt,
      "agent-runtime-invoke", executionId);
    return execution;
  });
}

export function executeAgentDatabaseCommand(
  database: DatabaseSync,
  input: ExecuteAgentDatabaseCommandInput,
): DatabaseCommandResult {
  return runAuthorityImmediateTransaction(database, () => {
    const parsed = parsePersistentCommand(input.command);
    if (!parsed.ok) {
      return fail("invalid_request", "Authority Agent command payload was rejected");
    }
    const agentId = input.context.agent.actorId;
    requireAgentCommandAuthority(database, agentId, input.command.roomId);
    return executeIdempotently(database, {
      actorId: agentId,
      command: input.command,
      aggregateKind: "room",
      aggregateId: input.command.roomId,
      idempotencyKey: input.command.type === "message.send"
        ? input.command.payload.id
        : input.context.idempotencyKey,
      now: input.now,
      beforeApply() {
        input.beforeApply?.(agentId);
      },
      execute(acceptedAt, scope, key) {
        return input.command.type === "message.send"
          ? executeMessageSend(
              database,
              agentId,
              input.command,
              acceptedAt,
              stableId("event", scope, key, "0"),
              scope,
              key,
            )
          : input.command.type === "agent.judgment.record"
          ? executeAgentJudgment(
              database,
              agentId,
              input.command,
              acceptedAt,
              scope,
              key,
            )
          : input.command.type === "open-item.create"
            ? executeOpenItemCreate(database, agentId, input.command, acceptedAt, scope, key)
            : input.command.type === "open-item.transition"
              ? executeOpenItemTransition(database, agentId, input.command, acceptedAt, scope, key)
              : input.command.type === "agent.execution.transition"
                ? executeAgentExecutionTransition(
                    database,
                    agentId,
                    input.command,
                    acceptedAt,
                    scope,
                    key,
                  )
                : unreachableCommand(input.command);
      },
    });
  });
}

export function executeHumanDatabaseCommand(
  database: DatabaseSync,
  input: ExecuteHumanDatabaseCommandInput,
): DatabaseCommandResult {
  return runAuthorityImmediateTransaction(database, () => {
    const parsed = parsePersistentCommand(input.command);
    if (!parsed.ok) {
      return fail("invalid_request", "Authority command payload was rejected");
    }
    const actorId = requireHumanSession(database, input.context, input.now);
    const aggregateKind = input.command.type === "room.create" ? "identity" : "room";
    const aggregateId = input.command.type === "room.create"
      ? actorId
      : input.command.type === "human.invitation.decide"
        ? (() => {
            const invitation = invitationByToken(database, input.command.payload.token);
            return typeof invitation.roomId === "string"
              ? invitation.roomId
              : fail("storage_unavailable", "Authority invitation is corrupt");
          })()
        : input.command.roomId;
    recheckHumanCommandAuthority(database, actorId, input.command);
    return executeIdempotently(database, {
      actorId,
      command: input.command,
      aggregateKind,
      aggregateId,
      idempotencyKey: input.command.type === "message.send"
        ? input.command.payload.id
        : input.context.idempotencyKey,
      now: input.now,
      beforeApply() {
        input.beforeApply?.(actorId);
      },
      execute(acceptedAt, scope, key) {
        const eventId = stableId("event", scope, key, "0");
        return input.command.type === "message.send"
          ? executeMessageSend(
              database,
              actorId,
              input.command,
              acceptedAt,
              eventId,
              scope,
              key,
              input.afterDomainWrite,
            )
          : input.command.type === "human.read.record"
            ? executeHumanRead(database, actorId, input.command, acceptedAt, scope, key)
            : input.command.type === "open-item.create"
              ? executeOpenItemCreate(database, actorId, input.command, acceptedAt, scope, key)
            : input.command.type === "open-item.transition"
              ? executeOpenItemTransition(database, actorId, input.command, acceptedAt, scope, key)
              : input.command.type === "calibration.record"
                ? executeCalibrationRecord(database, actorId, input.command, acceptedAt, scope, key)
            : input.command.type === "room.create"
              ? executeRoomCreate(database, actorId, input.command, acceptedAt, scope, key)
              : input.command.type === "room.rename" || input.command.type === "room.archive"
                ? executeRenameOrArchive(database, actorId, input.command, acceptedAt, scope, key)
                : input.command.type === "agent.configure"
                  ? executeAgentConfigure(database, actorId, input.command, acceptedAt, scope, key)
                  : input.command.type === "human.invitation.issue"
                    ? executeInvitationIssue(
                        database,
                        actorId,
                        input.command,
                        input.invitationSecret,
                        acceptedAt,
                        scope,
                        key,
                      )
                    : input.command.type === "human.invitation.decide"
                      ? executeInvitationDecision(database, actorId, input.command, acceptedAt, scope, key)
                      : input.command.type === "human.role.change"
                        ? executeHumanRoleChange(database, actorId, input.command, acceptedAt, scope, key)
                        : input.command.type === "member.remove"
                          ? executeMemberRemove(database, actorId, input.command, acceptedAt, scope, key)
                          : unreachableCommand(input.command);
      },
    });
  }, input.beforeCommit);
}
