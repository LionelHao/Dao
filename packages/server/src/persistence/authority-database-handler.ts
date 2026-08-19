import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentExecution,
  Actor,
  HumanMessageSubmit,
  MessageTargetOutcome,
  DepartureConflictList,
  LightTask,
  ManagedRoom,
  Message,
  OpenItem,
  OpenItemAgentFailure,
  PersistedIdentityEvent,
  PersistedRoomEvent,
  RouteInvocationIntent,
  RouteJob,
  RouteJudgment,
  RoomSyncRequest,
  RoomSyncResult,
} from "@native-im/core";
import {
  isLightTask,
  isAgentFinalMessage,
  isHumanMessageSubmit,
  isMessageRevision,
  isMessageTargetOutcome,
  isUtf16Range,
  isOpenItem,
  projectBallsInCourt,
  type BallInCourt,
  type BallOverdueTrigger,
  type BallSummary,
  type BlueprintBallFact,
  type HumanPreemptionNotice,
  type NeedsActionProjection,
  type ReminderCandidate,
} from "@native-im/core";
import type {
  RuntimeAuthorityOperation,
  RuntimeAuthorityOperationResult,
} from "../agent-runtime/runtime-authority-protocol.js";
import type {
  RouteAuthorityOperation,
  RouteAuthorityOperationResult,
  RouteProviderFailureCode,
} from "../route-runtime/route-authority-protocol.js";
import type {
  BallAuthorityOperation,
  BallAuthorityOperationResult,
} from "../ball-runtime/ball-authority-protocol.js";
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
  type AgentWorkerCommandContext,
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
  type AgentMessageCommitCommand,
  type AgentMessageCommitReceipt,
  type HumanMessageSubmissionReceipt,
  type MessageHistoryPage,
  type MessageHistoryQuery,
  type MessageRecallCommand,
  type MessageRecallExecutionCancellation,
  type MessageRecallReceipt,
  type MessageRevisionCommand,
  type MessageRevisionPage,
  type MessageRevisionQuery,
  type MessageRevisionReceipt,
} from "./contracts.js";
import type { AuthorityWorkerErrorCode } from "./worker-protocol.js";
import type {
  RepairMutationImpact,
  RepairScope,
} from "../fallback-repair-coordinator.js";
import type { SnapshotVersion } from "@native-im/core";
import { assignTopicKey } from "../route-runtime/route-decision.js";
import type { AuthorityTransactionView } from "../room-governance/private-participant-contracts.js";
import { withDatabaseAuthorityTransactionView } from "./authority-transaction-database.js";
import {
  ArchivedMessageMutationBlockedError,
  requireMessageMutationAllowedInTransaction,
} from "../message-authority/archived-message-gate.js";
import {
  readOperationalMessageAuthorityEvent,
  readOperationalTimelineMessage,
} from
  "../message-authority/sqlite-operational-message-projection.js";
import { canStartRuntimeGenerationInTransaction } from "../agent-runtime/runtime-archive-fence-participant.js";
import type { CommittedRoomCacheInvalidationIntent } from "../access/room-cache-invalidation-port.js";
import {
  BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
  isBusinessTimerClaimAllowedInTransaction,
} from "../business-timers/business-timer-suspension-participant.js";
import {
  createDepartureGovernanceCoordinator,
  DepartureGovernanceCommandError,
  type DepartureGovernanceComposition,
  type DepartureMutationAuthorization,
} from "../room-governance/departure-governance.js";
import {
  ArchiveCoordinatorCommandError,
  coordinateArchiveInTransaction,
  coordinateReopenInTransaction,
  type ArchiveCoordinatorComposition,
  type ReopenAfterCommitRescan,
} from "../room-governance/archive-coordinator.js";
import { AuthorityParticipantUnavailableError } from "../room-governance/private-participant-registry.js";
import { insertLegacyMessageAuthorityRecord } from "./message-authority-legacy-adapter.js";
import type { AgentMessageWorkerContext } from "../message-authority/internal-message-capability.js";
import {
  coordinateMemberAccessRevocationInTransaction,
  MemberAccessRevocationError,
} from "../room-governance/member-access-revocation-adapter.js";

export class AuthorityDatabaseError extends Error {
  readonly details?: DepartureConflictList;

  constructor(
    readonly code: AuthorityWorkerErrorCode,
    message: string,
    details?: DepartureConflictList,
  ) {
    super(message);
    this.name = "AuthorityDatabaseError";
    if (details !== undefined) this.details = details;
  }
}

export interface SharedAuthorityParticipantComposition {
  readonly manifest: DepartureGovernanceComposition["manifest"];
  readonly registrations: readonly unknown[];
}

export interface ExecuteHumanDatabaseCommandInput {
  readonly context: AuthenticatedCommandContext;
  readonly command: HumanCollaborationCommand | RoomGovernanceCommand;
  readonly invitationSecret?: {
    readonly tokenHash: string;
    readonly sealedToken: string;
  };
  readonly now: number;
  readonly participantComposition?: SharedAuthorityParticipantComposition;
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
  readonly afterCommitRescan?: ReopenAfterCommitRescan;
}

function fail(code: AuthorityWorkerErrorCode, message: string): never {
  throw new AuthorityDatabaseError(code, message);
}

function failFromGovernanceCoordinator(error: unknown): never {
  if (error instanceof DepartureGovernanceCommandError) {
    throw new AuthorityDatabaseError(error.code, error.message, error.details);
  }
  if (error instanceof ArchiveCoordinatorCommandError) {
    throw new AuthorityDatabaseError(
      error.code === "transaction_mismatch" ? "dependency_unavailable" : error.code,
      error.message,
    );
  }
  if (error instanceof AuthorityParticipantUnavailableError) {
    throw new AuthorityDatabaseError(
      "dependency_unavailable",
      "Authority governance participant was unavailable",
    );
  }
  if (error instanceof MemberAccessRevocationError) {
    const code: AuthorityWorkerErrorCode = error.code === "member_access_revision_conflict"
      ? "room_revision_conflict"
      : error.code === "transaction_mismatch"
        ? "dependency_unavailable"
        : error.code;
    throw new AuthorityDatabaseError(code, "Target member access revocation failed");
  }
  throw error;
}

function requireSharedAuthorityComposition(
  composition: SharedAuthorityParticipantComposition | undefined,
): SharedAuthorityParticipantComposition {
  if (composition === undefined) {
    return fail(
      "dependency_unavailable",
      "Authority governance participant composition is unavailable",
    );
  }
  return composition;
}

function archiveCoordinatorComposition(
  composition: SharedAuthorityParticipantComposition,
): ArchiveCoordinatorComposition {
  return Object.freeze({
    manifest: composition.manifest,
    transactionRegistrations: composition.registrations,
    lifecycleRepairRegistrations: composition.registrations,
    accessInvalidationRegistrations: composition.registrations,
  });
}

function requireMessageMutationAllowed(
  database: DatabaseSync,
  roomId: string,
  mutationKind: "message" | "message_intent",
  transactionId: string,
): void {
  const room = database.prepare(
    "SELECT archive_generation AS archiveGeneration FROM rooms WHERE id = ?",
  ).get(roomId);
  if (typeof room?.archiveGeneration !== "number" ||
    !Number.isSafeInteger(room.archiveGeneration) || room.archiveGeneration < 0) {
    return fail("storage_unavailable", "Authority Room lifecycle proof was unavailable");
  }
  try {
    withDatabaseAuthorityTransactionView(
      database,
      roomId,
      transactionId,
      (transaction) => requireMessageMutationAllowedInTransaction(transaction, {
        roomId,
        mutationKind,
        expectedArchiveGeneration: room.archiveGeneration as number,
      }),
    );
  } catch (error: unknown) {
    if (error instanceof ArchivedMessageMutationBlockedError &&
      error.reason === "room_archived") {
      return fail("room_archived", "Authority Room is archived");
    }
    return fail("dependency_unavailable", "Message mutation gate was unavailable");
  }
}

function currentRoomArchiveGeneration(
  database: DatabaseSync,
  roomId: string,
): number {
  const row = database.prepare(
    "SELECT archive_generation AS archiveGeneration FROM rooms WHERE id = ?",
  ).get(roomId);
  if (typeof row?.archiveGeneration !== "number" ||
      !Number.isSafeInteger(row.archiveGeneration) || row.archiveGeneration < 0) {
    return fail("storage_unavailable", "Authority Room lifecycle proof was unavailable");
  }
  return row.archiveGeneration;
}

function requireRuntimeGenerationAllowed(
  database: DatabaseSync,
  roomId: string,
  archiveGeneration: number,
  transactionId: string,
): void {
  try {
    const allowed = withDatabaseAuthorityTransactionView(
      database,
      roomId,
      transactionId,
      (transaction) => canStartRuntimeGenerationInTransaction(transaction, {
        roomId,
        archiveGeneration,
      }),
    );
    if (!allowed) return fail("room_archived", "Authority Room runtime generation is fenced");
  } catch (error: unknown) {
    if (error instanceof AuthorityDatabaseError) throw error;
    return fail("dependency_unavailable", "Runtime archive fence was unavailable");
  }
}

function requireExecutionRuntimeGenerationAllowed(
  database: DatabaseSync,
  executionId: string,
  transactionId: string,
): Readonly<{ roomId: string; archiveGeneration: number }> {
  const row = database.prepare(
    `SELECT room_id AS roomId, room_archive_generation AS archiveGeneration
     FROM agent_executions WHERE id = ?`,
  ).get(executionId);
  if (typeof row?.roomId !== "string" || typeof row.archiveGeneration !== "number" ||
      !Number.isSafeInteger(row.archiveGeneration) || row.archiveGeneration < 0) {
    return fail("storage_unavailable", "Agent runtime generation proof was unavailable");
  }
  requireRuntimeGenerationAllowed(database, row.roomId, row.archiveGeneration, transactionId);
  return { roomId: row.roomId, archiveGeneration: row.archiveGeneration };
}

function ballFactsForRoom(
  database: DatabaseSync,
  roomId: string,
  blueprintFacts: readonly BlueprintBallFact[],
  openItemDeadlineMs: number,
  lightTaskDeadlineMs: number,
): readonly BallInCourt[] {
  if (blueprintFacts.some((fact) => fact.roomId !== roomId)) {
    return fail("invalid_request", "Blueprint ball facts crossed the requested room");
  }
  const openItems = database.prepare(
    `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
            requester_actor_id AS requesterId, current_owner_actor_id AS currentOwnerId,
            body AS content, status, created_at AS createdAt, responded_at AS respondedAt,
            transfer_chain_json AS transferChainJson, origin_kind AS originKind,
            proposal_kind AS proposalKind, source_execution_id AS sourceExecutionId,
            proposal_reason AS proposalReason
     FROM open_items WHERE room_id = ? ORDER BY id`,
  ).all(roomId).map((row) => {
    let transferChain: unknown;
    try {
      transferChain = typeof row.transferChainJson === "string"
        ? JSON.parse(row.transferChainJson) : undefined;
    } catch {
      return fail("storage_unavailable", "Authority OpenItem transfer chain was corrupt");
    }
    const item = {
      id: row.id, roomId: row.roomId, sourceMessageId: row.sourceMessageId,
      requesterId: row.requesterId, currentOwnerId: row.currentOwnerId, content: row.content,
      status: row.status,
      origin: row.originKind === "agent_proposal" ? {
        kind: "agent_proposal", proposalKind: row.proposalKind,
        sourceExecutionId: row.sourceExecutionId, reason: row.proposalReason,
      } : { kind: row.originKind },
      createdAt: row.createdAt,
      ...(typeof row.respondedAt === "string" ? { respondedAt: row.respondedAt } : {}),
      transferChain,
    };
    if (!isOpenItem(item)) return fail("storage_unavailable", "Authority OpenItem ball fact was corrupt");
    return item;
  });
  const lightTasks = database.prepare(
    `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId, title,
            claimant_actor_id AS claimant, claimant_role_at_claim AS claimantRoleAtClaim,
            verifier_role AS verifierRole, verifier_actor_id AS verifierActorId,
            criteria_json AS criteriaJson, status, created_at AS createdAt,
            claimed_at AS claimedAt, delivered_at AS deliveredAt, verified_at AS verifiedAt
     FROM light_tasks WHERE room_id = ? ORDER BY id`,
  ).all(roomId).map((row) => {
    let criteria: unknown;
    try {
      criteria = typeof row.criteriaJson === "string" ? JSON.parse(row.criteriaJson) : undefined;
    } catch {
      return fail("storage_unavailable", "Authority LightTask criteria were corrupt");
    }
    const task = {
      id: row.id, roomId: row.roomId, sourceMessageId: row.sourceMessageId, title: row.title,
      claimant: row.claimant, claimantRoleAtClaim: row.claimantRoleAtClaim,
      verifierRole: row.verifierRole, verifierActorId: row.verifierActorId,
      criteria, status: row.status, createdAt: row.createdAt,
      ...(typeof row.claimedAt === "string" ? { claimedAt: row.claimedAt } : {}),
      ...(typeof row.deliveredAt === "string" ? { deliveredAt: row.deliveredAt } : {}),
      ...(typeof row.verifiedAt === "string" ? { verifiedAt: row.verifiedAt } : {}),
    };
    if (!isLightTask(task)) return fail("storage_unavailable", "Authority LightTask ball fact was corrupt");
    return task;
  });
  return projectBallsInCourt({
    openItems: openItems.filter((item) => {
      const since = item.status === "transferred"
        ? item.transferChain.at(-1)?.transferredAt
        : item.createdAt;
      return since !== undefined && Number.isFinite(Date.parse(since));
    }),
    lightTasks: lightTasks.filter((task) => {
      const since = task.status === "claimed" ? task.claimedAt
        : task.status === "delivered" ? task.deliveredAt : task.createdAt;
      return since !== undefined && Number.isFinite(Date.parse(since));
    }),
    blueprintFacts, openItemDeadlineMs, lightTaskDeadlineMs,
  });
}

export function executeBallAuthorityOperation(
  database: DatabaseSync,
  operation: BallAuthorityOperation,
): BallAuthorityOperationResult {
  return runAuthorityImmediateTransaction(database, () => {
    if (operation.type === "ball.list-rooms") {
      const rows = database.prepare(
        `SELECT DISTINCT room_id AS roomId FROM (
           SELECT room_id FROM open_items WHERE status IN ('awaiting', 'transferred')
           UNION ALL
           SELECT room_id FROM light_tasks WHERE status IN ('claimed', 'delivered')
         ) ORDER BY roomId LIMIT 257`,
      ).all();
      if (rows.length > 256 || !rows.every((row) => typeof row.roomId === "string")) {
        return fail("storage_unavailable", "Ball room recovery exceeded its closed bound");
      }
      return { kind: "ball-rooms", roomIds: rows.map((row) => row.roomId as string) };
    }
    const room = database.prepare("SELECT status FROM rooms WHERE id = ?").get(operation.roomId);
    if (room === undefined) return fail("room_not_found", "Ball room was not found");
    if (room.status !== "active") return fail("room_archived", "Ball room is archived");
    const balls = ballFactsForRoom(
      database,
      operation.roomId,
      operation.blueprintFacts,
      operation.policy.openItemDeadlineMs,
      operation.policy.lightTaskDeadlineMs,
    );
    if (operation.type === "ball.query") {
      const actorId = requireHumanSession(database, operation.context, operation.now);
      requireRoomMembership(database, actorId, operation.roomId);
      const needsAction: NeedsActionProjection[] = balls
        .filter((ball) => ball.holderId === actorId)
        .map((ball) => ({
          roomId: ball.roomId, actorId, ball, overdue: operation.now >= Date.parse(ball.deadline),
        }));
      const reminders: ReminderCandidate[] = needsAction
        .filter((entry) => entry.overdue)
        .map(({ ball }) => ({
          roomId: ball.roomId, recipientId: actorId, sourceKind: ball.sourceKind,
          sourceId: ball.sourceId, dueAt: ball.deadline,
        }));
      return { kind: "ball-query", balls, needsAction, reminders };
    }

    const holderRows = database.prepare(
      `SELECT membership.actor_id AS actorId, actor.kind
       FROM room_memberships AS membership
       JOIN actors AS actor ON actor.id = membership.actor_id
       WHERE membership.room_id = ? ORDER BY membership.actor_id`,
    ).all(operation.roomId);
    const holderKinds = new Map(holderRows.flatMap((row) =>
      typeof row.actorId === "string" && (row.kind === "human" || row.kind === "agent")
        ? [[row.actorId, row.kind] as const] : []));
    const occurredAt = new Date(operation.now).toISOString();
    const agentTriggers: BallOverdueTrigger[] = [];
    const reminders: ReminderCandidate[] = [];
    const ballSummaries: BallSummary[] = [];
    return withDatabaseAuthorityTransactionView(
      database,
      operation.roomId,
      stableId("ball-business-timer-claim", operation.roomId, occurredAt),
      (transaction) => {
    for (const ball of balls) {
      const holderKind = holderKinds.get(ball.holderId);
      if (holderKind === undefined) continue;
      let effectiveBall = ball;
      if (ball.sourceKind === "open-item" || ball.sourceKind === "light-task") {
        const decision = isBusinessTimerClaimAllowedInTransaction(transaction, {
          roomId: ball.roomId,
          descriptorId: BALL_BOUNDARY_TIMER_DESCRIPTOR_ID,
          sourceKind: ball.sourceKind,
          sourceId: ball.sourceId,
          holderActorId: ball.holderId,
          holderKind,
          sinceAt: ball.since,
          defaultDueAt: ball.deadline,
          now: operation.now,
        });
        if (!decision.allowed) continue;
        effectiveBall = { ...ball, deadline: decision.dueAt };
      } else if (operation.now < Date.parse(ball.deadline)) {
        continue;
      }
      const boundaryKind = holderKind === "agent" ? "agent_trigger" : "human_reminder";
      const claimId = stableId(
        "ball-boundary", ball.roomId, ball.sourceKind, ball.sourceId, ball.holderId,
        ball.since, boundaryKind,
      );
      const inserted = database.prepare(
        `INSERT OR IGNORE INTO ball_boundary_claims (
           id, room_id, source_kind, source_id, holder_actor_id, holder_kind,
           reason, since_at, deadline_at, boundary_kind, claimed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        claimId, ball.roomId, ball.sourceKind, ball.sourceId, ball.holderId, holderKind,
        ball.reason.slice(0, 1_024), ball.since, effectiveBall.deadline, boundaryKind, occurredAt,
      );
      if (inserted.changes !== 1) continue;
      if (holderKind === "human") {
        reminders.push({
          roomId: ball.roomId, recipientId: ball.holderId, sourceKind: ball.sourceKind,
          sourceId: ball.sourceId, dueAt: effectiveBall.deadline,
        });
        continue;
      }
      const trigger: BallOverdueTrigger = {
        id: stableId("ball-overdue-trigger", claimId), roomId: ball.roomId,
        agentId: ball.holderId, ball: effectiveBall, triggeredAt: occurredAt,
      };
      const eventId = stableId("ball-overdue-event", trigger.id);
      const streamSeq = appendRoomEvent(database, {
        eventId, roomId: ball.roomId, actorId: ball.holderId,
        eventType: "room.ball.overdue", occurredAt,
        payload: trigger as unknown as JsonValue,
      });
      appendRoomOutbox(database, eventId, ball.roomId, streamSeq, occurredAt, "ball-overdue", trigger.id);
      database.prepare(
        `UPDATE route_job_agents SET has_ball = 1
         WHERE agent_id = ? AND route_job_id IN (
           SELECT id FROM route_jobs WHERE room_id = ? AND status = 'queued'
         )`,
      ).run(ball.holderId, ball.roomId);
      agentTriggers.push(trigger);
      ballSummaries.push({
        agentId: ball.holderId, sourceKind: ball.sourceKind, sourceId: ball.sourceId,
        reason: ball.reason, since: ball.since, deadline: effectiveBall.deadline,
      });
    }
    return { kind: "ball-overdue-scan", agentTriggers, reminders, ballSummaries };
      },
    );
  });
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

function assertCommittedRoomOwnership(database: DatabaseSync): void {
  const hasCanonicalOwner = database
    .prepare("SELECT 1 AS present FROM pragma_table_info('rooms') WHERE name = 'owner_actor_id'")
    .get()?.present === 1;
  if (!hasCanonicalOwner) return;
  const invalid = database.prepare(
    `SELECT room.id
     FROM rooms AS room
     LEFT JOIN room_memberships AS owner
       ON owner.room_id = room.id
      AND owner.actor_id = room.owner_actor_id
      AND owner.kind = 'human'
      AND owner.role = 'owner'
     WHERE room.owner_actor_id IS NULL
        OR owner.actor_id IS NULL
        OR (SELECT COUNT(*) FROM room_memberships AS legacy_owner
            WHERE legacy_owner.room_id = room.id
              AND legacy_owner.kind = 'human'
              AND legacy_owner.role = 'owner') <> 1
     LIMIT 1`,
  ).get();
  if (invalid !== undefined) {
    return fail("storage_unavailable", "Authority room ownership invariant was violated");
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
    assertCommittedRoomOwnership(database);
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

export function runAuthorityParticipantImmediateTransaction<Result>(
  database: DatabaseSync,
  roomId: string,
  transactionId: string,
  operation: (transaction: AuthorityTransactionView) => Result,
  beforeCommit?: () => void,
): Result {
  return runAuthorityImmediateTransaction(
    database,
    () => withDatabaseAuthorityTransactionView(
      database,
      roomId,
      transactionId,
      operation,
    ),
    beforeCommit,
  );
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
    const room = database.prepare(
      `SELECT room.status, stream.head_seq AS watermark
       FROM rooms AS room
       JOIN streams AS stream
         ON stream.stream_kind = 'room' AND stream.stream_id = room.id
       WHERE room.id = ?`,
    )
      .get(validation.roomId);
    if (room === undefined) {
      return fail("room_not_found", "Snapshot room was not found");
    }
    if (room.status !== "active" && room.status !== "archived") {
      return fail("storage_unavailable", "Snapshot room lifecycle is corrupt");
    }
    const membership = database.prepare(
      `SELECT CASE
                WHEN access.access_revision IS NULL OR
                     membership.access_revision > access.access_revision
                  THEN membership.access_revision
                ELSE access.access_revision
              END AS accessRevision
       FROM room_memberships AS membership
       LEFT JOIN room_access_authority AS access ON access.room_id = membership.room_id
       WHERE membership.room_id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
    ).get(validation.roomId, actorId);
    if (membership === undefined) {
      return fail("room_forbidden", "Snapshot room membership was rejected");
    }
    if (membership.accessRevision !== validation.accessRevision) {
      return fail("snapshot_stale", "Snapshot room access revision changed");
    }
    if (room.watermark !== validation.watermark) {
      return fail("snapshot_stale", "Snapshot Room watermark changed");
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
              CASE
                WHEN access.access_revision IS NULL OR
                     membership.access_revision > access.access_revision
                  THEN membership.access_revision
                ELSE access.access_revision
              END AS accessRevision,
              stream.head_seq AS watermark
       FROM rooms AS room
       JOIN room_memberships AS membership ON membership.room_id = room.id
       JOIN streams AS stream ON stream.stream_kind = 'room' AND stream.stream_id = room.id
       LEFT JOIN room_access_authority AS access ON access.room_id = room.id
       WHERE room.id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
    ).get(scope.roomId, actorId);
    if (row === undefined) {
      const room = database.prepare("SELECT status FROM rooms WHERE id = ?")
        .get(scope.roomId);
      if (room === undefined) return fail("room_not_found", "Streaming room was not found");
      return fail("room_forbidden", "Streaming room membership was rejected");
    }
    if (row.roomStatus !== "active" && row.roomStatus !== "archived") {
      return fail("storage_unavailable", "Streaming room lifecycle is corrupt");
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
  } else if (command.type === "human.role.change" || command.type === "member.remove" ||
      command.type === "room.member.remove") {
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
  requireCurrentHumanRoomMembership(database, actorId, roomId);
  const authorityOnly = database.prepare(
    `SELECT 1 AS present
     FROM message_envelopes AS envelope
     WHERE envelope.room_id = ?
       AND (envelope.current_revision > 1 OR envelope.lifecycle = 'recalled')
     UNION ALL
     SELECT 1 AS present
     FROM agent_message_corrections AS correction
     JOIN messages AS message ON message.id = correction.correction_message_id
     WHERE message.room_id = ?
     LIMIT 1`,
  ).get(roomId, roomId);
  if (authorityOnly?.present === 1) {
    return fail(
      "protocol_upgrade_required",
      "Message history requires the Message Authority vNext protocol",
    );
  }
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

function requireSyncHumanRoomMembership(
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
  if (row?.roomStatus !== "active" && row?.roomStatus !== "archived") {
    fail("room_forbidden", "Authority room sync access was rejected");
  }
}

function isMessageAuthorityEventType(
  value: unknown,
): value is "room.message.accepted" | "room.message.revised" | "room.message.recalled" {
  return value === "room.message.accepted" || value === "room.message.revised" ||
    value === "room.message.recalled";
}

function storedMessageEventId(row: Record<string, unknown>): string | undefined {
  if (!isMessageAuthorityEventType(row.eventType) || typeof row.payloadJson !== "string") {
    return undefined;
  }
  try {
    const payload = JSON.parse(row.payloadJson) as unknown;
    return isRecord(payload) && typeof payload.id === "string" && payload.id.length > 0
      ? payload.id
      : undefined;
  } catch {
    return undefined;
  }
}

function isStoredMessageEventPointer(row: Record<string, unknown>): boolean {
  if (!isMessageAuthorityEventType(row.eventType) || typeof row.payloadJson !== "string") {
    return false;
  }
  try {
    const payload = JSON.parse(row.payloadJson) as unknown;
    return isRecord(payload) && Reflect.ownKeys(payload).length === 1 &&
      typeof payload.id === "string" && payload.id.length > 0;
  } catch {
    return false;
  }
}

function messageEventMatchesCurrentProjection(
  database: DatabaseSync,
  row: Record<string, unknown>,
  messageId: string,
  roomId: string,
): boolean {
  const authority = database.prepare(
    `SELECT envelope.lifecycle, envelope.current_revision AS currentRevision,
            envelope.recalled_at AS recalledAt, revision.revised_at AS revisedAt,
            (
              SELECT MAX(event.stream_seq)
              FROM events AS event
              WHERE event.stream_kind = 'room' AND event.stream_id = envelope.room_id
                AND event.event_type IN (
                  'room.message.accepted', 'room.message.revised', 'room.message.recalled'
                )
                AND json_extract(event.payload_json, '$.id') = envelope.message_id
            ) AS latestMessageEventSeq
     FROM message_envelopes AS envelope
     JOIN message_revisions AS revision
       ON revision.message_id = envelope.message_id
      AND revision.revision = envelope.current_revision
     WHERE envelope.message_id = ? AND envelope.room_id = ?`,
  ).get(messageId, roomId);
  if (authority === undefined) return !isStoredMessageEventPointer(row);
  if (row.eventType === "room.message.accepted" && !isStoredMessageEventPointer(row)) {
    return authority.lifecycle === "active" && authority.currentRevision === 1;
  }
  if (typeof row.occurredAt !== "string" || authority.latestMessageEventSeq !== row.streamSeq) {
    return false;
  }
  if (row.eventType === "room.message.accepted") {
    return authority.lifecycle === "active" && authority.currentRevision === 1 &&
      authority.revisedAt === row.occurredAt;
  }
  if (row.eventType === "room.message.revised") {
    return authority.lifecycle === "active" &&
      typeof authority.currentRevision === "number" && authority.currentRevision > 1 &&
      authority.revisedAt === row.occurredAt;
  }
  return row.eventType === "room.message.recalled" && authority.lifecycle === "recalled" &&
    authority.recalledAt === row.occurredAt;
}

function parseRoomSyncEvent(
  database: DatabaseSync,
  row: Record<string, unknown>,
): PersistedRoomEvent {
  let payload: unknown;
  try {
    payload = typeof row.payloadJson === "string"
      ? JSON.parse(row.payloadJson) as unknown
      : undefined;
  } catch {
    return fail("storage_unavailable", "Stored room sync event is corrupt");
  }
  const messageId = storedMessageEventId(row);
  if (messageId !== undefined && isRecord(payload) &&
      Reflect.ownKeys(payload).length === 1 && Object.hasOwn(payload, "id")) {
    return readOperationalMessageAuthorityEvent(database, {
      eventId: row.eventId as string,
      streamKind: row.streamKind as "room",
      streamId: row.streamId as string,
      streamSeq: row.streamSeq as number,
      roomId: row.roomId as string,
      type: row.eventType as "room.message.accepted" | "room.message.revised" |
        "room.message.recalled",
      actorId: row.actorId as string,
      occurredAt: row.occurredAt as string,
    }, messageId);
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
    requireSyncHumanRoomMembership(database, actorId, request.roomId);
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
      const messageId = storedMessageEventId(row);
      if (messageId !== undefined &&
          !messageEventMatchesCurrentProjection(database, row, messageId, request.roomId)) {
        return roomSyncResultWithinPageLimit({
          type: "room.sync.result",
          requestId: request.requestId,
          mode: "repair_required",
          reason: "operational_projection_changed",
          retainedFromSeq,
          watermark: currentHeadSeq,
        });
      }
      const event = parseRoomSyncEvent(database, row);
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

export function readRoomGovernanceDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
): import("@native-im/core").RoomGovernanceView {
  const actorId = requireHumanSession(database, context, now);
  requireCurrentHumanRoomMembership(database, actorId, roomId);
  return readGovernanceView(database, roomId);
}

export function readDepartureConflictsDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  input: { readonly roomId: string; readonly targetActorId: string },
  now: number,
  inputComposition: SharedAuthorityParticipantComposition | undefined,
): DepartureConflictList {
  return runAuthorityReadTransaction(database, () => {
    const actorId = requireHumanSession(database, context, now);
    const composition = requireSharedAuthorityComposition(inputComposition);
    try {
      return withDatabaseAuthorityTransactionView(
        database,
        input.roomId,
        stableId("departure-preflight", actorId, input.roomId, input.targetActorId),
        (transaction) => createDepartureGovernanceCoordinator(composition)
          .preflightInTransaction(transaction, {
            roomId: input.roomId,
            authenticatedHumanActorId: actorId,
            targetHumanActorId: input.targetActorId,
          }),
      );
    } catch (error: unknown) {
      return failFromGovernanceCoordinator(error);
    }
  });
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
  return membership?.roomStatus === "active" || membership?.roomStatus === "archived";
}

export function readRoomAuditDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  roomId: string,
  now: number,
): readonly RoomAuditRecord[] {
  const actorId = requireHumanSession(database, context, now);
  requireCurrentHumanRoomMembership(database, actorId, roomId);
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

function parseOutboxEvent(
  database: DatabaseSync,
  row: Record<string, unknown>,
): PersistedRoomEvent | PersistedIdentityEvent {
  let payload: unknown;
  try {
    payload = typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson) : undefined;
  } catch {
    return fail("storage_unavailable", "Stored outbox event payload is corrupt");
  }
  const messageId = storedMessageEventId(row);
  if (row.streamKind === "room" && messageId !== undefined && isRecord(payload) &&
      Reflect.ownKeys(payload).length === 1 && Object.hasOwn(payload, "id")) {
    return readOperationalMessageAuthorityEvent(database, {
      eventId: row.eventId as string,
      streamKind: "room",
      streamId: row.streamId as string,
      streamSeq: row.streamSeq as number,
      roomId: row.roomId as string,
      type: row.eventType as "room.message.accepted" | "room.message.revised" |
        "room.message.recalled",
      actorId: row.actorId as string,
      occurredAt: row.occurredAt as string,
    }, messageId);
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
    const event = parseOutboxEvent(database, row);
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
      `SELECT delivery.target_kind AS targetKind, delivery.target_id AS targetId,
              event.stream_seq AS streamSeq, event.event_type AS eventType,
              event.occurred_at AS occurredAt,
              event.payload_json AS payloadJson
       FROM outbox_deliveries AS delivery
       JOIN events AS event ON event.event_id = delivery.event_id
       WHERE delivery.id = ? AND delivery.status = 'pending'`,
    )
    .get(deliveryId);
  if (
    typeof delivery?.targetKind !== "string" ||
    typeof delivery.targetId !== "string"
  ) {
    return false;
  }
  const messageId = storedMessageEventId(delivery);
  if (messageId !== undefined && delivery.targetKind === "room" &&
      !messageEventMatchesCurrentProjection(
        database, delivery, messageId, delivery.targetId,
      )) {
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

export function listCommittedRoomCacheInvalidationIntentsDatabaseQuery(
  database: DatabaseSync,
  limit: number,
): readonly CommittedRoomCacheInvalidationIntent[] {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 256) {
    return fail("invalid_request", "Room cache invalidation limit was invalid");
  }
  const rows = database.prepare(
    `SELECT id AS invalidationIntentId, room_id AS roomId,
            lifecycle_generation AS lifecycleGeneration,
            access_revision AS accessRevision, reason,
            target_actor_id AS targetActorId
     FROM room_cache_invalidation_intents
     WHERE status = 'pending' AND available_at <= CURRENT_TIMESTAMP
     ORDER BY available_at, created_at, id
     LIMIT ?`,
  ).all(limit);
  return rows.map((row) => {
    if (typeof row.invalidationIntentId !== "string" ||
        typeof row.roomId !== "string" ||
        typeof row.lifecycleGeneration !== "number" ||
        !Number.isSafeInteger(row.lifecycleGeneration) || row.lifecycleGeneration < 0 ||
        typeof row.accessRevision !== "number" ||
        !Number.isSafeInteger(row.accessRevision) || row.accessRevision < 0 ||
        (row.reason !== "room_archived" && row.reason !== "member_removed" &&
          row.reason !== "access_revoked") ||
        (row.reason === "room_archived" && row.targetActorId !== null) ||
        (row.reason !== "room_archived" && typeof row.targetActorId !== "string")) {
      return fail("storage_unavailable", "Room cache invalidation intent was corrupt");
    }
    const common = {
      invalidationIntentId: row.invalidationIntentId,
      roomId: row.roomId,
      lifecycleGeneration: row.lifecycleGeneration,
      accessRevision: row.accessRevision,
    };
    return row.reason === "room_archived"
      ? { ...common, reason: "room_archived" as const }
      : { ...common, reason: row.reason, targetActorId: row.targetActorId as string };
  });
}

export function markRoomCacheInvalidationCompletedDatabaseCommand(
  database: DatabaseSync,
  invalidationIntentId: string,
): void {
  const updated = database.prepare(
    `UPDATE room_cache_invalidation_intents
     SET status = 'completed', completed_at = CURRENT_TIMESTAMP, last_error_code = NULL
     WHERE id = ? AND status = 'pending'`,
  ).run(invalidationIntentId);
  if (updated.changes === 1) return;
  const existing = database.prepare(
    "SELECT status FROM room_cache_invalidation_intents WHERE id = ?",
  ).get(invalidationIntentId);
  if (existing?.status !== "completed") {
    return fail("storage_unavailable", "Room cache invalidation intent does not exist");
  }
}

export function markRoomCacheInvalidationFailedDatabaseCommand(
  database: DatabaseSync,
  invalidationIntentId: string,
  errorCode: "purge_failed" | "authority_unavailable",
): void {
  const updated = database.prepare(
    `UPDATE room_cache_invalidation_intents
     SET attempts = attempts + 1, last_error_code = ?, available_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'`,
  ).run(errorCode, invalidationIntentId);
  if (updated.changes === 1) return;
  const existing = database.prepare(
    "SELECT status FROM room_cache_invalidation_intents WHERE id = ?",
  ).get(invalidationIntentId);
  if (existing?.status !== "completed" && existing?.status !== "dead_letter") {
    return fail("storage_unavailable", "Room cache invalidation intent does not exist");
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

function requireCurrentHumanRoomMembership(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): void {
  const membership = database.prepare(
    `SELECT room.status AS roomStatus
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     JOIN actors AS actor ON actor.id = membership.actor_id
     WHERE membership.room_id = ? AND membership.actor_id = ?
       AND membership.kind = 'human' AND actor.kind = 'human'`,
  ).get(roomId, actorId);
  if (membership?.roomStatus !== "active" && membership?.roomStatus !== "archived") {
    fail("room_forbidden", "Authority Human room membership was rejected");
  }
}

function requireRoomManager(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
): { readonly roomStatus: string; readonly role: string } {
  const membership = database
    .prepare(
      `SELECT room.status AS roomStatus, membership.role,
              room.owner_actor_id = membership.actor_id AS isOwner
       FROM room_memberships AS membership
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE membership.room_id = ?
         AND membership.actor_id = ?
         AND membership.kind = 'human'`,
    )
    .get(roomId, actorId);
  if (
    typeof membership?.roomStatus !== "string" ||
    (membership.isOwner !== 1 && membership.role !== "admin")
  ) {
    return fail("room_forbidden", "Authority room governance was rejected");
  }
  return { roomStatus: membership.roomStatus, role: membership.isOwner === 1 ? "owner" : "admin" };
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
      `SELECT id, name, status, created_at AS createdAt, owner_actor_id AS ownerActorId
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
          role: member.actorId === row.ownerActorId ? "owner" : member.role,
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

function readGovernanceView(database: DatabaseSync, roomId: string): import("@native-im/core").RoomGovernanceView {
  const row = database.prepare(
    `SELECT id, status, owner_actor_id AS ownerActorId,
            governance_revision AS governanceRevision,
            archive_generation AS archiveGeneration, archived_at AS archivedAt
     FROM rooms WHERE id = ?`,
  ).get(roomId);
  if (typeof row?.id !== "string" || (row.status !== "active" && row.status !== "archived") ||
    typeof row.ownerActorId !== "string" || typeof row.governanceRevision !== "number" ||
    typeof row.archiveGeneration !== "number") {
    return fail("room_not_found", "Authority room governance was not found");
  }
  return {
    roomId: row.id,
    projectId: row.id,
    lifecycle: row.status,
    governanceRevision: row.governanceRevision,
    ownerActorId: row.ownerActorId,
    archiveGeneration: row.archiveGeneration,
    ...(row.status === "archived" && typeof row.archivedAt === "string" ? { archivedAt: row.archivedAt } : {}),
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
       ) VALUES (?, ?, 'human', 'member', NULL, '[]', ?, NULL, 0)`,
    )
    .run(roomId, actorId, acceptedAt);
  database.prepare(
    `UPDATE rooms SET owner_actor_id = ?, governance_revision = 1 WHERE id = ?`,
  ).run(actorId, roomId);
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
    return fail("dependency_unavailable", "Archive settlement and repair dependencies are unavailable");
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

function requireGovernanceRevision(
  database: DatabaseSync,
  roomId: string,
  expectedGovernanceRevision: number,
): void {
  const row = database.prepare(
    "SELECT governance_revision AS governanceRevision FROM rooms WHERE id = ?",
  ).get(roomId);
  if (typeof row?.governanceRevision !== "number") {
    return fail("room_not_found", "Authority room was not found");
  }
  if (row.governanceRevision !== expectedGovernanceRevision) {
    return fail("room_revision_conflict", "Room governance revision is stale");
  }
}

function executeOwnershipTransfer(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "room.ownership.transfer" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const owner = requireRoomOwner(database, actorId, command.roomId);
  if (owner.roomStatus !== "active") return fail("dependency_unavailable", "Archived ownership transfer is not available in FT-02A");
  requireGovernanceRevision(database, command.roomId, command.payload.expectedGovernanceRevision);
  if (command.payload.targetActorId === actorId) {
    return fail("role_forbidden", "Ownership target must be another current Human member");
  }
  const target = database.prepare(
    `SELECT joined_at AS joinedAt FROM room_memberships
     WHERE room_id = ? AND actor_id = ? AND kind = 'human'`,
  ).get(command.roomId, command.payload.targetActorId);
  if (typeof target?.joinedAt !== "string") return fail("member_not_found", "Ownership target was not found");
  database.prepare(
    `UPDATE room_memberships SET role = 'member', access_revision = access_revision + 1
     WHERE room_id = ? AND actor_id = ?`,
  ).run(command.roomId, command.payload.targetActorId);
  database.prepare(
    `UPDATE room_memberships SET access_revision = access_revision + 1
     WHERE room_id = ? AND actor_id = ?`,
  ).run(command.roomId, actorId);
  database.prepare(
    `UPDATE rooms SET owner_actor_id = ?, governance_revision = governance_revision + 1
     WHERE id = ? AND governance_revision = ?`,
  ).run(command.payload.targetActorId, command.roomId, command.payload.expectedGovernanceRevision);
  const governance = readGovernanceView(database, command.roomId);
  database.prepare(
    `INSERT INTO room_audit (id, type, room_id, actor_id, result, timestamp, details_json)
     VALUES (?, 'room.ownership.transferred', ?, ?, 'ownership-transferred', ?, ?)`,
  ).run(stableId("audit", scope, key), command.roomId, actorId, acceptedAt, canonicalJson({
    previousOwnerActorId: actorId,
    targetActorId: command.payload.targetActorId,
    previousGovernanceRevision: command.payload.expectedGovernanceRevision,
    governanceRevision: governance.governanceRevision,
  }));
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId, roomId: command.roomId, actorId, eventType: "room.governance.changed",
    occurredAt: acceptedAt, payload: { governance: governance as unknown as JsonValue },
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  const eventIds = [eventId];
  for (const [index, principalId] of [actorId, command.payload.targetActorId].entries()) {
    database.prepare("UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?").run(principalId);
    const identityEventId = stableId("event", scope, key, String(index + 1));
    const identitySeq = appendCanonicalIdentityEvent(database, {
      eventId: identityEventId, principalId, eventType: "identity.room-access.changed",
      occurredAt: acceptedAt, payload: { roomId: command.roomId, change: "updated" },
    });
    appendPrincipalOutbox(database, identityEventId, principalId, identitySeq, acceptedAt, scope, key);
    eventIds.push(identityEventId);
  }
  return {
    aggregateId: command.roomId, eventIds, acceptedAt,
    result: {
      governance: governance as unknown as JsonValue,
      previousOwnerActorId: actorId,
      room: readManagedRoom(database, command.roomId),
    },
  };
}

function executeHumanRoleChange(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "room.member.role.set" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const manager = requireRoomManager(database, actorId, command.roomId);
  if (manager.role !== "owner") {
    return fail("role_forbidden", "Admin cannot change a peer governance role");
  }
  const owner = { roomStatus: manager.roomStatus };
  if (owner.roomStatus !== "active") {
    return fail("room_archived", "Authority room is archived");
  }
  requireGovernanceRevision(database, command.roomId, command.payload.expectedGovernanceRevision);
  const target = database
    .prepare(
      `SELECT kind, role, joined_at AS joinedAt
       FROM room_memberships WHERE room_id = ? AND actor_id = ?`,
    )
    .get(command.roomId, command.payload.targetActorId);
  if (target?.kind !== "human" || typeof target.joinedAt !== "string") {
    return fail("room_member_not_found", "Authority human member was not found");
  }
  const governance = readGovernanceView(database, command.roomId);
  if (command.payload.targetActorId === governance.ownerActorId) {
    return fail("role_forbidden", "Authority room owner cannot be changed by role-set");
  }
  database
    .prepare(
      `UPDATE room_memberships
       SET role = ?, access_revision = access_revision + 1
       WHERE room_id = ? AND actor_id = ?`,
    )
    .run(command.payload.role, command.roomId, command.payload.targetActorId);
  database.prepare(
    `UPDATE rooms SET governance_revision = governance_revision + 1
     WHERE id = ? AND governance_revision = ?`,
  ).run(command.roomId, command.payload.expectedGovernanceRevision);
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
    eventType: "room.governance.changed",
    occurredAt: acceptedAt,
    payload: {
      governance: readGovernanceView(database, command.roomId) as unknown as JsonValue,
    },
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
    result: {
      room: readManagedRoom(database, command.roomId),
      governance: readGovernanceView(database, command.roomId) as unknown as JsonValue,
      membership,
    },
  };
}

function executeMemberRemove(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "member.remove" }>,
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
    return fail("ownership_transfer_required", "Room owner must transfer ownership before removal");
  }
  const governance = readGovernanceView(database, command.roomId);
  if (target.kind === "human" && command.payload.targetActorId === governance.ownerActorId) {
    return fail("ownership_transfer_required", "Room owner must transfer ownership before removal");
  }
  if (manager.role === "admin" && target.kind === "human" && target.role === "admin") {
    return fail("role_forbidden", "Admin cannot remove a peer admin");
  }
  return fail("dependency_unavailable", "Departure responsibility cleanup is unavailable");
}

function commitClosedDeparture(
  database: DatabaseSync,
  transaction: AuthorityTransactionView,
  authorization: DepartureMutationAuthorization,
  acceptedAt: string,
  scope: string,
  key: string,
  afterDomainWrite?: () => void,
): CommandAcknowledgement {
  const targetActorId = authorization.targetHumanActorId;
  const operationEventType = authorization.operation === "leave"
    ? "room.member.left"
    : "room.member.removed";
  const operationResult = authorization.operation === "leave" ? "left" : "removed";

  const membership = database.prepare(
        `SELECT access_revision AS accessRevision
         FROM room_memberships
         WHERE room_id = ? AND actor_id = ? AND kind = 'human'`,
      ).get(authorization.roomId, targetActorId);
  if (typeof membership?.accessRevision !== "number" ||
      !Number.isSafeInteger(membership.accessRevision) || membership.accessRevision < 0) {
    return fail("storage_unavailable", "Departure target access revision is corrupt");
  }
  const revocation = coordinateMemberAccessRevocationInTransaction(transaction, {
    roomId: authorization.roomId,
    targetActorId,
    expectedAccessRevision: membership.accessRevision,
    occurredAtMs: Date.parse(acceptedAt),
  });
  if (revocation.outcome === "schema_capability_blocked") {
    return fail(
      "dependency_unavailable",
      "Target member access revocation dependency was unavailable",
    );
  }
  const removed = database.prepare(
        `DELETE FROM room_memberships
         WHERE room_id = ? AND actor_id = ? AND kind = 'human'`,
      ).run(authorization.roomId, targetActorId);
  if (removed.changes !== 1) {
    return fail("room_revision_conflict", "Departure membership changed concurrently");
  }
  const revision = database.prepare(
        `UPDATE rooms SET governance_revision = governance_revision + 1
         WHERE id = ? AND governance_revision = ?`,
      ).run(authorization.roomId, authorization.previousGovernanceRevision);
  if (revision.changes !== 1) {
    return fail("room_revision_conflict", "Room governance revision changed concurrently");
  }
  const catalog = database.prepare(
        "UPDATE actors SET catalog_revision = catalog_revision + 1 WHERE id = ?",
      ).run(targetActorId);
  if (catalog.changes !== 1) {
    return fail("storage_unavailable", "Departure target catalog is unavailable");
  }
  database.prepare(
        `INSERT INTO room_audit (
           id, type, room_id, actor_id, result, timestamp, details_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stableId("audit", scope, key),
        operationEventType,
        authorization.roomId,
        authorization.actorId,
        operationResult,
        acceptedAt,
        canonicalJson({ targetActorId }),
      );
  const governance = readGovernanceView(database, authorization.roomId);
  if (governance.governanceRevision !== authorization.nextGovernanceRevision) {
    return fail("storage_unavailable", "Departure governance revision is corrupt");
  }
  const roomEventId = stableId("event", scope, key, "0");
  const roomSeq = appendRoomEvent(database, {
        eventId: roomEventId,
        roomId: authorization.roomId,
        actorId: authorization.actorId,
        eventType: "room.governance.changed",
        occurredAt: acceptedAt,
        payload: { governance } as unknown as JsonValue,
      });
  appendRoomOutbox(
        database,
        roomEventId,
        authorization.roomId,
        roomSeq,
        acceptedAt,
        scope,
        key,
      );
  const identityEventId = stableId("event", scope, key, "1");
  const identitySeq = appendCanonicalIdentityEvent(database, {
        eventId: identityEventId,
        principalId: targetActorId,
        eventType: "identity.room-access.changed",
        occurredAt: acceptedAt,
        payload: { roomId: authorization.roomId, change: "removed" },
      });
  appendPrincipalOutbox(
        database,
        identityEventId,
        targetActorId,
        identitySeq,
        acceptedAt,
        scope,
        key,
      );
  const acknowledgement = {
    aggregateId: authorization.roomId,
    eventIds: [roomEventId],
    acceptedAt,
    result: { governance } as unknown as JsonValue,
  };
  afterDomainWrite?.();
  return acknowledgement;
}

function executeClosedDeparture(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, {
    readonly type: "room.member.leave" | "room.member.remove";
  }>,
  acceptedAt: string,
  scope: string,
  key: string,
  inputComposition: SharedAuthorityParticipantComposition | undefined,
  afterDomainWrite?: () => void,
): CommandAcknowledgement {
  const composition = requireSharedAuthorityComposition(inputComposition);
  const targetActorId = command.type === "room.member.leave"
    ? actorId
    : command.payload.targetActorId;
  try {
    return withDatabaseAuthorityTransactionView(
      database,
      command.roomId,
      stableId("departure-governance", scope, key),
      (transaction) => createDepartureGovernanceCoordinator(composition)
        .coordinateMutationInTransaction(transaction, {
          roomId: command.roomId,
          authenticatedHumanActorId: actorId,
          targetHumanActorId: targetActorId,
          operation: command.type === "room.member.leave" ? "leave" : "remove",
          expectedGovernanceRevision: command.payload.expectedGovernanceRevision,
        }, (authorization) => commitClosedDeparture(
          database,
          transaction,
          authorization,
          acceptedAt,
          scope,
          key,
          afterDomainWrite,
        )),
    );
  } catch (error: unknown) {
    return failFromGovernanceCoordinator(error);
  }
}

function executeClosedLifecycle(
  database: DatabaseSync,
  actorId: string,
  command: Extract<RoomGovernanceCommand, { readonly type: "room.archive" | "room.reopen" }>,
  acceptedAt: string,
  scope: string,
  key: string,
  inputComposition: SharedAuthorityParticipantComposition | undefined,
  onAfterCommitRescan: (rescan: ReopenAfterCommitRescan) => void,
  afterDomainWrite?: () => void,
): CommandAcknowledgement {
  const composition = archiveCoordinatorComposition(
    requireSharedAuthorityComposition(inputComposition),
  );
  try {
    return withDatabaseAuthorityTransactionView(
      database,
      command.roomId,
      stableId("room-lifecycle-governance", scope, key),
      (transaction) => {
        const coordinatorInput = {
          roomId: command.roomId,
          actorId,
          expectedGovernanceRevision: command.payload.expectedGovernanceRevision,
          occurredAt: acceptedAt,
        };
        const result = command.type === "room.archive"
          ? coordinateArchiveInTransaction(transaction, coordinatorInput, composition)
          : coordinateReopenInTransaction(transaction, coordinatorInput, composition);
        if (result.outcome === "already_archived" || result.outcome === "already_active") {
          return {
            aggregateId: command.roomId,
            eventIds: [],
            acceptedAt,
            result: { governance: result.governance } as unknown as JsonValue,
          };
        }

        const auditType = command.type === "room.archive" ? "room.archived" : "room.reopened";
        const auditResult = command.type === "room.archive" ? "archived" : "reopened";
        database.prepare(
          `INSERT INTO room_audit (
             id, type, room_id, actor_id, result, timestamp, details_json
           ) VALUES (?, ?, ?, ?, ?, ?, '{}')`,
        ).run(
          stableId("audit", scope, key),
          auditType,
          command.roomId,
          actorId,
          auditResult,
          acceptedAt,
        );

        const lifecycleEventId = stableId("event", scope, key, "0");
        const lifecycleSeq = appendRoomEvent(database, {
          eventId: lifecycleEventId,
          roomId: command.roomId,
          actorId,
          eventType: auditType,
          occurredAt: acceptedAt,
          payload: command.type === "room.archive"
            ? {
                governance: result.governance,
                archiveGeneration: result.governance.archiveGeneration,
                frozenTimerCount: result.participants.businessTimers.affectedCount,
              } as unknown as JsonValue
            : {
                governance: result.governance,
                archiveGeneration: result.governance.archiveGeneration,
                resumedTimerCount: result.participants.businessTimers.affectedCount,
              } as unknown as JsonValue,
        });
        appendRoomOutbox(
          database,
          lifecycleEventId,
          command.roomId,
          lifecycleSeq,
          acceptedAt,
          scope,
          key,
        );

        const eventIds: string[] = [lifecycleEventId];
        let catalogStartIndex = 1;
        if (command.type === "room.archive" &&
            "assignmentSecurity" in result.participants) {
          const securityEventId = stableId("event", scope, key, "1");
          const securitySeq = appendRoomEvent(database, {
            eventId: securityEventId,
            roomId: command.roomId,
            actorId,
            eventType: "room.security.reduced",
            occurredAt: acceptedAt,
            payload: {
              governance: result.governance,
              archiveGeneration: result.governance.archiveGeneration,
              assignmentRevision: result.participants.assignmentSecurity.assignmentRevision,
            } as unknown as JsonValue,
          });
          appendRoomOutbox(
            database,
            securityEventId,
            command.roomId,
            securitySeq,
            acceptedAt,
            scope,
            key,
          );
          eventIds.push(securityEventId);
          catalogStartIndex = 2;
        } else if ("afterCommitRescan" in result) {
          onAfterCommitRescan(result.afterCommitRescan);
        }
        appendCatalogEvents(database, {
          roomId: command.roomId,
          change: command.type === "room.archive" ? "archived" : "updated",
          acceptedAt,
          scope,
          key,
          startIndex: catalogStartIndex,
        });
        afterDomainWrite?.();
        return {
          aggregateId: command.roomId,
          eventIds,
          acceptedAt,
          result: { governance: result.governance } as unknown as JsonValue,
        };
      },
    );
  } catch (error: unknown) {
    return failFromGovernanceCoordinator(error);
  }
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
  requireMessageMutationAllowed(
    database,
    command.roomId,
    "message",
    stableId("message-gate", scope, key),
  );
  insertLegacyMessageAuthorityRecord(database, message);
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
  if (message.authorKind === "agent") enqueueRouteJobForMessage(database, message, acceptedAt);
  return {
    aggregateId: message.id,
    eventIds: [eventId],
    acceptedAt,
    result: { message: message as unknown as JsonValue },
  };
}

function enqueueRouteJobForMessage(
  database: DatabaseSync,
  message: Message,
  acceptedAt: string,
): void {
  const recentTopics = database.prepare(
    `SELECT topic_key AS topicKey, body AS summary
     FROM (
       SELECT topic.topic_key, prior.body, prior.sent_at, prior.id
       FROM message_topics AS topic
       JOIN messages AS prior ON prior.id = topic.message_id
       WHERE topic.room_id = ? AND prior.id <> ?
       ORDER BY prior.sent_at DESC, prior.id DESC
       LIMIT 8
     )
     ORDER BY sent_at, id`,
  ).all(message.roomId, message.id);
  if (!recentTopics.every((entry) =>
    typeof entry.topicKey === "string" && typeof entry.summary === "string")) {
    return fail("storage_unavailable", "Route topic history was corrupt");
  }
  const topic = assignTopicKey(
    message.body,
    recentTopics as { readonly topicKey: string; readonly summary: string }[],
  );
  database.prepare(
    `INSERT INTO message_topics (
       message_id, room_id, topic_key, embedding_model_version,
       window_size, cosine_threshold, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.roomId,
    topic.topicKey,
    topic.embeddingModelVersion,
    topic.windowSize,
    topic.cosineThreshold,
    acceptedAt,
  );

  const routeJobId = stableId("route-job", message.id);
  database.prepare(
    `INSERT INTO route_jobs (
       id, room_id, source_message_id, status, current_attempt, topic_key,
       embedding_model_version, window_size, cosine_threshold, room_phase,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'queued', 1, ?, ?, ?, ?, 'discussion', ?, ?)`,
  ).run(
    routeJobId,
    message.roomId,
    message.id,
    topic.topicKey,
    topic.embeddingModelVersion,
    topic.windowSize,
    topic.cosineThreshold,
    acceptedAt,
    acceptedAt,
  );
  database.prepare(
    `INSERT INTO route_attempts (route_job_id, attempt_seq, status)
     VALUES (?, 1, 'queued')`,
  ).run(routeJobId);

  const members = database.prepare(
    `SELECT membership.actor_id AS agentId,
            membership.participation,
            actor.display_name AS role,
            actor.tool_permissions_json AS capabilitiesJson,
            COALESCE(score.score, 0) AS calibrationScore
     FROM room_memberships AS membership
     JOIN actors AS actor ON actor.id = membership.actor_id
     LEFT JOIN route_calibration_scores AS score
       ON score.agent_id = membership.actor_id AND score.topic_key = ?
     WHERE membership.room_id = ?
       AND membership.kind = 'agent'
       AND actor.kind = 'agent'
       AND membership.participation IN ('active', 'on-mention', 'silent')
     ORDER BY membership.actor_id`,
  ).all(topic.topicKey, message.roomId);
  for (const member of members) {
    if (typeof member.agentId !== "string" ||
        (member.participation !== "active" && member.participation !== "on-mention" && member.participation !== "silent") ||
        typeof member.role !== "string" || member.role.trim().length === 0 ||
        typeof member.capabilitiesJson !== "string" ||
        typeof member.calibrationScore !== "number") {
      return fail("storage_unavailable", "Route Agent membership snapshot was corrupt");
    }
    const activeBall = database.prepare(
      `SELECT claim.id
       FROM ball_boundary_claims AS claim
       WHERE claim.room_id = ? AND claim.holder_actor_id = ?
         AND claim.boundary_kind = 'agent_trigger' AND claim.route_consumed_at IS NULL
         AND (
           (claim.source_kind = 'open-item' AND EXISTS (
             SELECT 1 FROM open_items AS item
             WHERE item.id = claim.source_id AND item.room_id = claim.room_id
               AND item.current_owner_actor_id = claim.holder_actor_id
               AND item.status IN ('awaiting', 'transferred')
               AND CASE WHEN item.status = 'transferred'
                 THEN json_extract(item.transfer_chain_json, '$[#-1].transferredAt')
                 ELSE item.created_at END = claim.since_at
           ))
           OR (claim.source_kind = 'light-task' AND EXISTS (
             SELECT 1 FROM light_tasks AS task
             WHERE task.id = claim.source_id AND task.room_id = claim.room_id
               AND ((task.status = 'claimed' AND task.claimant_actor_id = claim.holder_actor_id
                     AND task.claimed_at = claim.since_at)
                 OR (task.status = 'delivered' AND task.verifier_actor_id = claim.holder_actor_id
                     AND task.delivered_at = claim.since_at))
           ))
           OR claim.source_kind IN (
             'blueprint-task', 'blueprint-awaiting', 'blueprint-blocked-mention'
           )
         )
       ORDER BY claim.claimed_at, claim.id LIMIT 1`,
    ).get(message.roomId, member.agentId);
    const activeBallId = typeof activeBall?.id === "string" ? activeBall.id : undefined;
    const hasBall = activeBallId !== undefined;
    database.prepare(
      `INSERT INTO route_job_agents (
         route_job_id, agent_id, participation, role, capabilities_json,
         calibration_score, has_ball
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      routeJobId,
      member.agentId,
      member.participation,
      member.role,
      member.capabilitiesJson,
      member.calibrationScore,
      hasBall ? 1 : 0,
    );
    if (hasBall) {
      database.prepare(
        `UPDATE ball_boundary_claims SET route_consumed_at = ?
         WHERE id = ? AND route_consumed_at IS NULL`,
      ).run(acceptedAt, activeBallId);
    }
  }
  if (members.length === 0) {
    database.prepare(
      `UPDATE route_attempts SET status = 'completed', finished_at = ?
       WHERE route_job_id = ? AND attempt_seq = 1`,
    ).run(acceptedAt, routeJobId);
    database.prepare(
      `UPDATE route_jobs SET status = 'completed', updated_at = ?, completed_at = ?
       WHERE id = ?`,
    ).run(acceptedAt, acceptedAt, routeJobId);
  } else {
    appendRouteLifecycleEvent(database, routeJobById(database, routeJobId), acceptedAt, "queued");
  }
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
): "human" | "agent" {
  const member = database
    .prepare("SELECT kind FROM room_memberships WHERE room_id = ? AND actor_id = ?")
    .get(roomId, actorId);
  if (member?.kind !== "human" && member?.kind !== "agent") {
    return fail("member_not_found", "Authority open-item owner is not a room member");
  }
  return member.kind;
}

function executeOpenItemCreate(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand, { readonly type: "open-item.create" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  roomMessageAuthor(database, command.roomId, command.payload.sourceMessageId);
  const targetKind = requireAssignedRoomMember(
    database, command.roomId, command.payload.targetActorId,
  );
  if (command.payload.creationKind === "human_mention" && targetKind !== "human") {
    return fail("invalid_request", "Human mention OpenItems require a human target");
  }
  const item: OpenItem = {
    id: stableId("open-item", scope, key),
    roomId: command.roomId,
    sourceMessageId: command.payload.sourceMessageId,
    requesterId: actorId,
    currentOwnerId: command.payload.targetActorId,
    content: command.payload.content,
    status: "awaiting",
    origin: { kind: command.payload.creationKind },
    createdAt: acceptedAt,
    transferChain: [],
  };
  database
    .prepare(
      `INSERT INTO open_items (
         id, room_id, source_message_id, current_owner_actor_id, status, body,
         created_at, responded_at, requester_actor_id, transfer_chain_json,
         origin_kind, proposal_kind, source_execution_id, proposal_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, '[]', ?, NULL, NULL, NULL)`,
    )
    .run(
      item.id,
      item.roomId,
      item.sourceMessageId,
      item.currentOwnerId,
      item.status,
      item.content,
      item.createdAt,
      item.requesterId,
      item.origin.kind,
    );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.open_item.changed",
    occurredAt: acceptedAt,
    payload: item as unknown as JsonValue,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: item.id,
    eventIds: [eventId],
    acceptedAt,
    result: { item: item as unknown as JsonValue },
  };
}

function readLightTask(database: DatabaseSync, roomId: string, taskId: string): LightTask {
  const row = database.prepare(
    `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId, title,
            claimant_actor_id AS claimant, claimant_role_at_claim AS claimantRoleAtClaim,
            verifier_role AS verifierRole, verifier_actor_id AS verifierActorId,
            criteria_json AS criteriaJson, status, created_at AS createdAt,
            claimed_at AS claimedAt, delivered_at AS deliveredAt, verified_at AS verifiedAt
     FROM light_tasks WHERE id = ?`,
  ).get(taskId);
  if (row?.roomId !== roomId || typeof row.criteriaJson !== "string") {
    return fail("light_task_not_found", "Authority light task was not found");
  }
  let criteria: unknown;
  try {
    criteria = JSON.parse(row.criteriaJson);
  } catch {
    return fail("storage_unavailable", "Authority light task criteria are corrupt");
  }
  const task = {
    id: row.id,
    roomId: row.roomId,
    sourceMessageId: row.sourceMessageId,
    title: row.title,
    claimant: row.claimant,
    claimantRoleAtClaim: row.claimantRoleAtClaim,
    verifierRole: row.verifierRole,
    verifierActorId: row.verifierActorId,
    criteria,
    status: row.status,
    createdAt: row.createdAt,
    ...(typeof row.claimedAt === "string" ? { claimedAt: row.claimedAt } : {}),
    ...(typeof row.deliveredAt === "string" ? { deliveredAt: row.deliveredAt } : {}),
    ...(typeof row.verifiedAt === "string" ? { verifiedAt: row.verifiedAt } : {}),
  };
  if (!isLightTask(task)) {
    return fail("storage_unavailable", "Authority light task is corrupt");
  }
  return task;
}

function currentHumanRoomRole(
  database: DatabaseSync,
  roomId: string,
  actorId: string,
): LightTask["verifierRole"] | undefined {
  const membership = database.prepare(
    `SELECT membership.role, room.status AS roomStatus,
            room.owner_actor_id = membership.actor_id AS isOwner
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.room_id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
  ).get(roomId, actorId);
  if (membership?.roomStatus !== "active" ||
      (membership.role !== "owner" && membership.role !== "admin" &&
       membership.role !== "member")) {
    return undefined;
  }
  return membership.isOwner === 1 ? "owner" : membership.role;
}

function appendLightTaskChanged(
  database: DatabaseSync,
  actorId: string,
  task: LightTask,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: task.roomId,
    actorId,
    eventType: "room.light_task.changed",
    occurredAt: acceptedAt,
    payload: task as unknown as JsonValue,
  });
  appendRoomOutbox(database, eventId, task.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: task.id,
    eventIds: [eventId],
    acceptedAt,
    result: { task: task as unknown as JsonValue },
  };
}

function executeLightTaskCreate(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand, { readonly type: "light-task.create" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  roomMessageAuthor(database, command.roomId, command.payload.sourceMessageId);
  const task: LightTask = {
    id: stableId("light-task", scope, key),
    roomId: command.roomId,
    sourceMessageId: command.payload.sourceMessageId,
    title: command.payload.title,
    claimant: null,
    claimantRoleAtClaim: null,
    verifierRole: command.payload.verifierRole,
    verifierActorId: null,
    criteria: command.payload.criteria.map((criterion) => ({ ...criterion, met: false })),
    status: "todo",
    createdAt: acceptedAt,
  };
  database.prepare(
    `INSERT INTO light_tasks (
       id, room_id, source_message_id, title, claimant_actor_id,
       claimant_role_at_claim, verifier_role, verifier_actor_id, criteria_json,
       status, created_at, claimed_at, delivered_at, verified_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, 'todo', ?, NULL, NULL, NULL)`,
  ).run(
    task.id,
    task.roomId,
    task.sourceMessageId,
    task.title,
    task.verifierRole,
    canonicalJson(task.criteria),
    task.createdAt,
  );
  return appendLightTaskChanged(database, actorId, task, acceptedAt, scope, key);
}

function requireCurrentLightTaskClaimant(
  database: DatabaseSync,
  actorId: string,
  task: LightTask,
): void {
  if (task.claimant !== actorId || currentHumanRoomRole(database, task.roomId, actorId) === undefined) {
    return fail("permission_denied", "Authority light task claimant permission was rejected");
  }
}

function executeLightTaskTransition(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand, { readonly type: "light-task.transition" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const current = readLightTask(database, command.roomId, command.payload.taskId);
  let task: LightTask;
  let updated: { readonly changes: number | bigint };
  if (command.payload.action === "claim") {
    if (current.status !== "todo") {
      return fail("execution_conflict", "Authority light task claim was stale");
    }
    const claimantRoleAtClaim = currentHumanRoomRole(database, command.roomId, actorId);
    if (claimantRoleAtClaim === undefined) {
      return fail("permission_denied", "Authority light task claimant is not a current member");
    }
    task = {
      ...current,
      claimant: actorId,
      claimantRoleAtClaim,
      status: "claimed",
      claimedAt: acceptedAt,
    };
    updated = database.prepare(
      `UPDATE light_tasks
       SET claimant_actor_id = ?, claimant_role_at_claim = ?, status = 'claimed', claimed_at = ?
       WHERE id = ? AND room_id = ? AND status = 'todo'`,
    ).run(actorId, claimantRoleAtClaim, acceptedAt, current.id, command.roomId);
  } else if (command.payload.action === "deliver") {
    if (current.status !== "claimed") {
      return fail("execution_conflict", "Authority light task delivery was stale");
    }
    requireCurrentLightTaskClaimant(database, actorId, current);
    if (current.verifierRole === current.claimantRoleAtClaim) {
      return fail("execution_conflict", "Authority light task verifier role conflicts with claimant role");
    }
    const candidates = database.prepare(
      `SELECT membership.actor_id AS actorId
       FROM room_memberships AS membership
       JOIN actors AS actor ON actor.id = membership.actor_id
       JOIN rooms AS room ON room.id = membership.room_id
       WHERE membership.room_id = ? AND membership.kind = 'human'
         AND ((? = 'owner' AND membership.actor_id = room.owner_actor_id)
           OR (? <> 'owner' AND membership.role = ?))
         AND actor.kind = 'human' AND room.status = 'active'
       ORDER BY membership.actor_id`,
    ).all(command.roomId, current.verifierRole, current.verifierRole, current.verifierRole);
    if (candidates.length !== 1 || typeof candidates[0]?.actorId !== "string" ||
        candidates[0].actorId === current.claimant) {
      return fail("execution_conflict", "Authority light task verifier is not uniquely resolvable");
    }
    task = {
      ...current,
      verifierActorId: candidates[0].actorId,
      status: "delivered",
      deliveredAt: acceptedAt,
    };
    updated = database.prepare(
      `UPDATE light_tasks
       SET verifier_actor_id = ?, status = 'delivered', delivered_at = ?
       WHERE id = ? AND room_id = ? AND status = 'claimed'
         AND claimant_actor_id = ? AND verifier_actor_id IS NULL`,
    ).run(task.verifierActorId, acceptedAt, current.id, command.roomId, current.claimant);
  } else {
    if (current.status !== "delivered") {
      return fail("execution_conflict", "Authority light task verification was stale");
    }
    if (current.claimant === null ||
        currentHumanRoomRole(database, command.roomId, current.claimant) === undefined) {
      return fail("permission_denied", "Authority light task claimant is no longer a current member");
    }
    if (current.verifierActorId !== actorId ||
        currentHumanRoomRole(database, command.roomId, actorId) === undefined) {
      return fail("permission_denied", "Authority light task verifier permission was rejected");
    }
    if (current.criteria.length === 0) {
      if (command.payload.emptyCriteriaConfirmed !== true) {
        return fail("execution_conflict", "Authority light task empty criteria require confirmation");
      }
    } else if (current.criteria.some((criterion) => !criterion.met)) {
      return fail("execution_conflict", "Authority light task criteria are incomplete");
    }
    task = { ...current, status: "verified", verifiedAt: acceptedAt };
    updated = database.prepare(
      `UPDATE light_tasks SET status = 'verified', verified_at = ?
       WHERE id = ? AND room_id = ? AND status = 'delivered'
         AND verifier_actor_id = ? AND criteria_json = ?`,
    ).run(acceptedAt, current.id, command.roomId, actorId, canonicalJson(current.criteria));
  }
  if (updated.changes !== 1) {
    return fail("execution_conflict", "Authority light task transition was stale");
  }
  return appendLightTaskChanged(database, actorId, task, acceptedAt, scope, key);
}

function executeLightTaskCriterionSet(
  database: DatabaseSync,
  actorId: string,
  command: Extract<HumanCollaborationCommand, { readonly type: "light-task.criterion.set" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const current = readLightTask(database, command.roomId, command.payload.taskId);
  if (current.status !== "delivered") {
    return fail("execution_conflict", "Authority light task criteria are not editable");
  }
  if (current.claimant === null ||
      currentHumanRoomRole(database, command.roomId, current.claimant) === undefined) {
    return fail("permission_denied", "Authority light task claimant is no longer a current member");
  }
  if (current.verifierActorId !== actorId ||
      currentHumanRoomRole(database, command.roomId, actorId) === undefined) {
    return fail("permission_denied", "Authority light task verifier permission was rejected");
  }
  const criterionIndex = current.criteria.findIndex(
    (criterion) => criterion.id === command.payload.criterionId,
  );
  if (criterionIndex === -1) {
    return fail("invalid_request", "Authority light task criterion was not found");
  }
  const criteria = current.criteria.map((criterion, index) => index === criterionIndex
    ? { ...criterion, met: command.payload.met }
    : criterion);
  const task: LightTask = { ...current, criteria };
  const updated = database.prepare(
    `UPDATE light_tasks SET criteria_json = ?
     WHERE id = ? AND room_id = ? AND status = 'delivered'
       AND verifier_actor_id = ? AND criteria_json = ?`,
  ).run(
    canonicalJson(criteria), current.id, command.roomId, actorId, canonicalJson(current.criteria),
  );
  if (updated.changes !== 1) {
    return fail("execution_conflict", "Authority light task criterion update was stale");
  }
  return appendLightTaskChanged(database, actorId, task, acceptedAt, scope, key);
}

function executeOpenItemProposal(
  database: DatabaseSync,
  actorId: string,
  command: Extract<AgentCollaborationCommand, { readonly type: "open-item.propose" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  roomMessageAuthor(database, command.roomId, command.payload.sourceMessageId);
  requireAssignedRoomMember(database, command.roomId, command.payload.targetActorId);
  const execution = database.prepare(
    `SELECT room_id AS roomId, trigger_message_id AS sourceMessageId,
            agent_id AS agentId, status
     FROM agent_executions WHERE id = ?`,
  ).get(command.payload.sourceExecutionId);
  if (execution?.roomId !== command.roomId ||
      execution.sourceMessageId !== command.payload.sourceMessageId ||
      execution.agentId !== actorId ||
      (execution.status !== "running" && execution.status !== "completed")) {
    return fail("permission_denied", "Agent OpenItem proposal provenance was rejected");
  }
  const proposalOrigin = {
    kind: "agent_proposal" as const,
    proposalKind: command.payload.proposalKind,
    sourceExecutionId: command.payload.sourceExecutionId,
    reason: command.payload.reason,
  };
  const item: OpenItem = {
    id: stableId("open-item", scope, key),
    roomId: command.roomId,
    sourceMessageId: command.payload.sourceMessageId,
    requesterId: actorId,
    currentOwnerId: command.payload.targetActorId,
    content: command.payload.content,
    status: "awaiting",
    origin: proposalOrigin,
    createdAt: acceptedAt,
    transferChain: [],
  };
  database.prepare(
    `INSERT INTO open_items (
       id, room_id, source_message_id, current_owner_actor_id, status, body,
       created_at, responded_at, requester_actor_id, transfer_chain_json,
       origin_kind, proposal_kind, source_execution_id, proposal_reason
     ) VALUES (?, ?, ?, ?, 'awaiting', ?, ?, NULL, ?, '[]',
       'agent_proposal', ?, ?, ?)`,
  ).run(
    item.id, item.roomId, item.sourceMessageId, item.currentOwnerId, item.content,
    item.createdAt, item.requesterId, proposalOrigin.proposalKind,
    proposalOrigin.sourceExecutionId, proposalOrigin.reason,
  );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId, roomId: command.roomId, actorId,
    eventType: "room.open_item.changed", occurredAt: acceptedAt,
    payload: item as unknown as JsonValue,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: item.id, eventIds: [eventId], acceptedAt,
    result: { item: item as unknown as JsonValue },
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
              requester_actor_id AS requesterId, current_owner_actor_id AS currentOwnerId,
              body AS content, status, created_at AS createdAt,
              responded_at AS respondedAt, transfer_chain_json AS transferChainJson,
              origin_kind AS originKind, proposal_kind AS proposalKind,
              source_execution_id AS sourceExecutionId, proposal_reason AS proposalReason
       FROM open_items WHERE id = ?`,
    )
    .get(command.payload.itemId);
  if (row?.roomId !== command.roomId || typeof row.id !== "string" ||
      typeof row.sourceMessageId !== "string" || typeof row.requesterId !== "string" ||
      (typeof row.currentOwnerId !== "string" && row.currentOwnerId !== null) ||
      typeof row.content !== "string" ||
      typeof row.createdAt !== "string" || typeof row.transferChainJson !== "string") {
    return fail("open_item_not_found", "Authority open item was not found");
  }
  const parsedTransfers: unknown = JSON.parse(row.transferChainJson);
  if (!Array.isArray(parsedTransfers)) {
    return fail("storage_unavailable", "Authority open item transfer chain is corrupt");
  }
  if (row.status === "answered" || row.status === "deferred") {
    return fail("execution_conflict", "Authority OpenItem is already terminal");
  }
  if (row.status !== "awaiting" && row.status !== "transferred" ||
      typeof row.currentOwnerId !== "string") {
    return fail("storage_unavailable", "Authority OpenItem active owner is corrupt");
  }
  const ownerKind = database.prepare("SELECT kind FROM actors WHERE id = ?")
    .get(row.currentOwnerId)?.kind;
  const actorKind = database.prepare("SELECT kind FROM actors WHERE id = ?").get(actorId)?.kind;
  const isRequester = actorKind === "human" && actorId === row.requesterId;
  const isOwner = actorId === row.currentOwnerId;
  if (!isOwner && !isRequester) {
    return fail("permission_denied", "Authority OpenItem transition was forbidden");
  }
  if (actorKind === "agent" && (!isOwner || ownerKind !== "agent" || command.payload.action !== "answer")) {
    return fail("permission_denied", "Agent OpenItem owners can only answer");
  }
  if (isRequester && !isOwner && command.payload.action !== "transfer" &&
      command.payload.action !== "defer") {
    return fail("permission_denied", "OpenItem requester transition was forbidden");
  }
  let currentOwnerId: string | null = row.currentOwnerId;
  let status: "answered" | "deferred" | "transferred";
  let respondedAt: string | undefined;
  let transferChain = parsedTransfers as OpenItem["transferChain"];
  if (command.payload.action === "transfer") {
    const targetId = command.payload.targetActorId;
    const reason = command.payload.reason;
    if (targetId === undefined || reason === undefined) {
      return fail("invalid_request", "Authority open item transfer was rejected");
    }
    requireAssignedRoomMember(database, command.roomId, targetId);
    status = "transferred";
    transferChain = [
      ...transferChain,
      {
        fromId: row.currentOwnerId,
        toId: targetId,
        reason,
        transferredAt: acceptedAt,
      },
    ];
    currentOwnerId = targetId;
  } else {
    status = command.payload.action === "answer" ? "answered" : "deferred";
    currentOwnerId = null;
    respondedAt = acceptedAt;
  }
  const origin: OpenItem["origin"] = row.originKind === "agent_proposal" ? {
    kind: "agent_proposal",
    proposalKind: row.proposalKind as "risk" | "challenge",
    sourceExecutionId: String(row.sourceExecutionId),
    reason: String(row.proposalReason),
  } : { kind: row.originKind as "human_mention" | "manual_unfinished" };
  const item: OpenItem = {
    id: row.id,
    roomId: command.roomId,
    sourceMessageId: row.sourceMessageId,
    requesterId: row.requesterId,
    currentOwnerId,
    content: row.content,
    status,
    origin,
    createdAt: row.createdAt,
    ...(respondedAt === undefined ? {} : { respondedAt }),
    transferChain,
  };
  const updated = database
    .prepare(
      `UPDATE open_items
       SET current_owner_actor_id = ?, status = ?, transfer_chain_json = ?, responded_at = ?
       WHERE id = ? AND status = ? AND current_owner_actor_id = ?
         AND transfer_chain_json = ?`,
    )
    .run(
      currentOwnerId,
      status,
      canonicalJson(transferChain),
      respondedAt ?? null,
      row.id,
      row.status,
      row.currentOwnerId,
      row.transferChainJson,
    );
  if (updated.changes !== 1) {
    return fail("execution_conflict", "Authority OpenItem transition was stale");
  }
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: command.roomId,
    actorId,
    eventType: "room.open_item.changed",
    occurredAt: acceptedAt,
    payload: item as unknown as JsonValue,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: row.id,
    eventIds: [eventId],
    acceptedAt,
    result: { item: item as unknown as JsonValue },
  };
}

function executeOpenItemAgentFailure(
  database: DatabaseSync,
  actorId: string,
  command: Extract<AgentCollaborationCommand, { readonly type: "open-item.agent-failure.record" }>,
  acceptedAt: string,
  scope: string,
  key: string,
): CommandAcknowledgement {
  const failure: OpenItemAgentFailure = {
    id: stableId("open-item-agent-failure", scope, key),
    openItemId: command.payload.itemId,
    executionId: command.payload.executionId,
    attemptSeq: command.payload.attemptSeq,
    reasonCode: command.payload.reasonCode,
    failedAt: acceptedAt,
  };
  const item = database.prepare(
    `SELECT current_owner_actor_id AS currentOwnerId
     FROM open_items WHERE id = ? AND room_id = ?`,
  ).get(failure.openItemId, command.roomId);
  if (item?.currentOwnerId !== actorId) {
    return fail("permission_denied", "OpenItem Agent failure owner was rejected");
  }
  database.prepare(
    `INSERT INTO open_item_agent_failures (
       id, open_item_id, execution_id, attempt_seq, reason_code, failed_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    failure.id, failure.openItemId, failure.executionId, failure.attemptSeq,
    failure.reasonCode, failure.failedAt,
  );
  const eventId = stableId("event", scope, key, "0");
  const streamSeq = appendRoomEvent(database, {
    eventId, roomId: command.roomId, actorId,
    eventType: "room.open_item.agent_attempt_failed",
    occurredAt: acceptedAt, payload: failure as unknown as JsonValue,
  });
  appendRoomOutbox(database, eventId, command.roomId, streamSeq, acceptedAt, scope, key);
  return {
    aggregateId: failure.id, eventIds: [eventId], acceptedAt,
    result: { failure: failure as unknown as JsonValue },
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
    `SELECT message.room_id AS roomId, message.author_id AS authorId,
            message.author_kind AS authorKind, message.body,
            topic.topic_key AS topicKey
     FROM messages AS message
     LEFT JOIN message_topics AS topic ON topic.message_id = message.id
     WHERE message.id = ?`,
  ).get(command.payload.sourceMessageId);
  if (source?.roomId !== command.roomId || source.authorKind !== "agent" ||
      typeof source.authorId !== "string" || typeof source.body !== "string") {
    return fail(
      "calibration_source_invalid",
      "Authority calibration must reference an Agent message",
    );
  }
  let topicKey = typeof source.topicKey === "string" ? source.topicKey : undefined;
  if (topicKey === undefined) {
    const recentTopics = database.prepare(
      `SELECT topic.topic_key AS topicKey, prior.body AS summary
       FROM message_topics AS topic
       JOIN messages AS prior ON prior.id = topic.message_id
       WHERE topic.room_id = ? AND prior.id <> ?
       ORDER BY prior.sent_at DESC, prior.id DESC
       LIMIT 8`,
    ).all(command.roomId, command.payload.sourceMessageId);
    if (!recentTopics.every((entry) =>
      typeof entry.topicKey === "string" && typeof entry.summary === "string")) {
      return fail("storage_unavailable", "Calibration topic history was corrupt");
    }
    const assigned = assignTopicKey(
      source.body,
      recentTopics as { readonly topicKey: string; readonly summary: string }[],
    );
    topicKey = assigned.topicKey;
    database.prepare(
      `INSERT INTO message_topics (
         message_id, room_id, topic_key, embedding_model_version,
         window_size, cosine_threshold, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      command.payload.sourceMessageId,
      command.roomId,
      assigned.topicKey,
      assigned.embeddingModelVersion,
      assigned.windowSize,
      assigned.cosineThreshold,
      acceptedAt,
    );
  }
  const calibration = "emoji" in command.payload
    ? {
        signal: command.payload.emoji,
        kind: command.payload.emoji === "👍" ? "thumbs_up" as const : "thumbs_down" as const,
        weight: command.payload.emoji === "👍" ? 1 : -1,
      }
    : {
        signal: command.payload.feedback,
        kind: command.payload.feedback,
        weight: command.payload.feedback === "useful" ? 2 : -2,
      };
  const signal = {
    id: stableId("calibration", scope, key),
    sourceMessageId: command.payload.sourceMessageId,
    actorId,
    agentId: source.authorId,
    ...(calibration.kind === "thumbs_up" || calibration.kind === "thumbs_down"
      ? { emoji: calibration.signal as "👍" | "👎" }
      : { feedback: calibration.signal as "useful" | "not_needed" }),
    createdAt: acceptedAt,
  };
  if (calibration.kind === "thumbs_up" || calibration.kind === "thumbs_down") {
    database.prepare(
      `INSERT INTO calibration_signals (
         id, room_id, agent_id, judgment_id, signal, created_at,
         source_message_id, actor_id
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      signal.id,
      command.roomId,
      signal.agentId,
      calibration.signal,
      signal.createdAt,
      signal.sourceMessageId,
      signal.actorId,
    );
  }
  database.prepare(
    `INSERT INTO route_calibration_facts (
       fact_id, room_id, source_message_id, human_actor_id,
       agent_id, topic_key, weight, kind, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    signal.id,
    command.roomId,
    signal.sourceMessageId,
    signal.actorId,
    signal.agentId,
    topicKey,
    calibration.weight,
    calibration.kind,
    acceptedAt,
  );
  database.prepare(
    `INSERT INTO route_calibration_scores (agent_id, topic_key, score, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (agent_id, topic_key) DO UPDATE SET
       score = MAX(-4, MIN(4, route_calibration_scores.score + excluded.score)),
       updated_at = excluded.updated_at`,
  ).run(signal.agentId, topicKey, calibration.weight, acceptedAt);
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
  if (command.type === "room.member.role.set" || command.type === "room.ownership.transfer") {
    requireRoomMembership(database, actorId, command.roomId);
    return;
  }
  if (command.type === "human.role.change") {
    requireRoomOwner(database, actorId, command.roomId);
    return;
  }
  if (command.type === "room.member.leave") {
    requireCurrentHumanRoomMembership(database, actorId, command.roomId);
    return;
  }
  if (
    command.type === "room.rename" ||
    command.type === "room.archive" ||
    command.type === "room.reopen" ||
    command.type === "human.invitation.issue" ||
    command.type === "agent.configure" ||
    command.type === "room.member.remove" ||
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
            trigger_message_id AS sourceMessageId, requester_actor_id AS requesterId,
            tool_name AS toolName, status, started_at AS startedAt,
            completed_at AS completedAt, result_json AS resultJson
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
    const roomArchiveGeneration = currentRoomArchiveGeneration(database, command.roomId);
    requireRuntimeGenerationAllowed(
      database,
      command.roomId,
      roomArchiveGeneration,
      stableId("legacy-runtime-gate", command.payload.executionId),
    );
    execution = {
      id: command.payload.executionId,
      roomId: command.roomId,
      sourceMessageId: command.payload.sourceMessageId,
      requesterId,
      agentId,
      toolName: command.payload.toolName,
      status: "running",
      actionCategory: "tool_call",
      toolDispatchPhase: "not_started",
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      recoveryCursor: 0,
      queuedAt: acceptedAt,
      startedAt: acceptedAt,
      updatedAt: acceptedAt,
    };
    database.prepare(
      `INSERT INTO agent_executions (
         id, room_id, room_archive_generation, agent_id, trigger_message_id, status, started_at,
         completed_at, result_json, requester_actor_id, tool_name,
         action_category, tool_dispatch_phase, queued_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?,
                 'tool_call', 'not_started', ?, ?)`,
    ).run(
      command.payload.executionId,
      command.roomId,
      roomArchiveGeneration,
      agentId,
      command.payload.sourceMessageId,
      acceptedAt,
      requesterId,
      command.payload.toolName,
      acceptedAt,
      acceptedAt,
    );
    database.prepare(
      `INSERT INTO agent_execution_attempts (
         execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
         action_category, started_at, recovery_cursor
       ) VALUES (?, 1, 1, 1, 'running', 'tool_call', ?, 0)`,
    ).run(command.payload.executionId, acceptedAt);
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
    requireExecutionRuntimeGenerationAllowed(
      database,
      command.payload.executionId,
      stableId("legacy-runtime-terminal-gate", command.payload.executionId),
    );
    execution = {
      id: command.payload.executionId,
      roomId: command.roomId,
      sourceMessageId: command.payload.sourceMessageId,
      requesterId: current.requesterId,
      agentId,
      toolName: command.payload.toolName,
      status: command.payload.status,
      actionCategory: "tool_call",
      toolDispatchPhase: "finished",
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      recoveryCursor: 0,
      queuedAt: current.startedAt,
      startedAt: current.startedAt,
      updatedAt: acceptedAt,
      completedAt: acceptedAt,
      ...(command.payload.status === "cancelled" ? { cancellationReason: "legacy_interrupt" } : {}),
      ...(command.payload.status === "failed" ? { terminalErrorCode: "legacy_failure" } : {}),
    };
    database.prepare(
      `UPDATE agent_executions
       SET status = ?, completed_at = ?, result_json = ?, updated_at = ?,
           tool_dispatch_phase = 'finished', cancellation_reason = ?, terminal_error_code = ?
       WHERE id = ?`,
    ).run(
      command.payload.status,
      acceptedAt,
      command.payload.result === undefined ? null : canonicalJson(command.payload.result),
      acceptedAt,
      command.payload.status === "cancelled" ? "legacy_interrupt" : null,
      command.payload.status === "failed" ? "legacy_failure" : null,
      command.payload.executionId,
    );
    database.prepare(
      `UPDATE agent_execution_attempts
       SET status = ?, finished_at = ?, error_code = ?
       WHERE execution_id = ? AND attempt_seq = 1 AND status = 'running'`,
    ).run(
      command.payload.status,
      acceptedAt,
      command.payload.status === "cancelled" ? "legacy_interrupt" :
        command.payload.status === "failed" ? "legacy_failure" : null,
      command.payload.executionId,
    );
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

function runtimeExecutionById(database: DatabaseSync, executionId: string): AgentExecution {
  const row = database.prepare(
    `SELECT id, room_id AS roomId, trigger_message_id AS sourceMessageId,
            requester_actor_id AS requesterId, agent_id AS agentId,
            tool_name AS toolName, status, action_category AS actionCategory,
            tool_dispatch_phase AS toolDispatchPhase,
            current_attempt_seq AS currentAttemptSeq, retry_cycle AS retryCycle,
            retry_ordinal AS retryOrdinal, provider_id AS providerId,
            model_id AS modelId, recovery_cursor AS recoveryCursor,
            queued_at AS queuedAt, started_at AS startedAt,
            updated_at AS updatedAt, completed_at AS completedAt,
            cancellation_reason AS cancellationReason,
            terminal_error_code AS terminalErrorCode,
            dead_lettered_at AS deadLetteredAt,
            result_message_id AS resultMessageId,
            next_retry_at AS nextRetryAt,
            manual_retry_of_execution_id AS manualRetryOfExecutionId,
            compensates_execution_id AS compensatesExecutionId,
            supersedes_execution_ids_json AS supersedesExecutionIdsJson
     FROM agent_executions WHERE id = ?`,
  ).get(executionId);
  if (row === undefined) return fail("execution_not_found", "Agent execution was not found");
  if (
    typeof row.id !== "string" || typeof row.roomId !== "string" ||
    typeof row.sourceMessageId !== "string" || typeof row.requesterId !== "string" ||
    typeof row.agentId !== "string" || typeof row.toolName !== "string" ||
    (row.status !== "queued" && row.status !== "running" && row.status !== "completed" && row.status !== "failed" && row.status !== "cancelled") ||
    (row.actionCategory !== "model_generation" && row.actionCategory !== "tool_call" && row.actionCategory !== "waiting_upstream") ||
    typeof row.currentAttemptSeq !== "number" || typeof row.retryCycle !== "number" ||
    (row.retryOrdinal !== 1 && row.retryOrdinal !== 2 && row.retryOrdinal !== 3) ||
    typeof row.recoveryCursor !== "number" || typeof row.queuedAt !== "string" ||
    typeof row.updatedAt !== "string"
  ) return fail("storage_unavailable", "Agent execution was corrupt");
  const status = row.status;
  let supersedesExecutionIds: string[] | undefined;
  if (typeof row.supersedesExecutionIdsJson === "string") {
    try {
      const parsed = JSON.parse(row.supersedesExecutionIdsJson) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32 ||
          !parsed.every((entry) => typeof entry === "string" && entry.trim().length > 0) ||
          new Set(parsed).size !== parsed.length || parsed.includes(row.id)) {
        return fail("storage_unavailable", "Agent execution supersedes lineage was corrupt");
      }
      supersedesExecutionIds = parsed;
    } catch {
      return fail("storage_unavailable", "Agent execution supersedes lineage was corrupt");
    }
  }
  const execution: AgentExecution = {
    id: row.id,
    roomId: row.roomId,
    sourceMessageId: row.sourceMessageId,
    requesterId: row.requesterId,
    agentId: row.agentId,
    toolName: row.toolName,
    status,
    actionCategory: row.actionCategory,
    ...(row.actionCategory === "tool_call" &&
      (row.toolDispatchPhase === "not_started" || row.toolDispatchPhase === "dispatched" || row.toolDispatchPhase === "finished")
      ? { toolDispatchPhase: row.toolDispatchPhase }
      : {}),
    currentAttemptSeq: row.currentAttemptSeq,
    retryCycle: row.retryCycle,
    retryOrdinal: row.retryOrdinal,
    ...(typeof row.providerId === "string" ? { providerId: row.providerId } : {}),
    ...(typeof row.modelId === "string" ? { modelId: row.modelId } : {}),
    recoveryCursor: row.recoveryCursor,
    queuedAt: row.queuedAt,
    ...(status !== "queued" && typeof row.startedAt === "string" ? { startedAt: row.startedAt } : {}),
    updatedAt: row.updatedAt,
    ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
    ...(typeof row.cancellationReason === "string" ? { cancellationReason: row.cancellationReason } : {}),
    ...(typeof row.terminalErrorCode === "string" ? { terminalErrorCode: row.terminalErrorCode } : {}),
    ...(typeof row.deadLetteredAt === "string" ? { deadLetteredAt: row.deadLetteredAt } : {}),
    ...(typeof row.resultMessageId === "string" ? { resultMessageId: row.resultMessageId } : {}),
    ...(typeof row.nextRetryAt === "string" ? { nextRetryAt: row.nextRetryAt } : {}),
    ...(typeof row.manualRetryOfExecutionId === "string" ? { manualRetryOfExecutionId: row.manualRetryOfExecutionId } : {}),
    ...(typeof row.compensatesExecutionId === "string" ? { compensatesExecutionId: row.compensatesExecutionId } : {}),
    ...(supersedesExecutionIds === undefined ? {} : { supersedesExecutionIds }),
  };
  return execution;
}

function appendRuntimeExecutionEvent(
  database: DatabaseSync,
  execution: AgentExecution,
  occurredAt: string,
  transition: string,
  errorCode?: string,
): void {
  const eventId = stableId("runtime", execution.id, String(execution.currentAttemptSeq), transition);
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: execution.roomId,
    actorId: execution.agentId,
    eventType: "room.agent_execution.changed",
    occurredAt,
    payload: execution as unknown as JsonValue,
  });
  appendRoomOutbox(database, eventId, execution.roomId, streamSeq, occurredAt, "runtime", transition);
  const lifecycleType = transition === "queued" || transition === "manual-retry-queued"
    ? "agent.execution.queued"
    : transition === "started"
      ? "agent.execution.started"
      : transition === "retry-scheduled"
        ? "agent.execution.retry-scheduled"
        : transition === "completed"
          ? "agent.execution.completed"
          : transition === "cancelled"
            ? "agent.execution.cancelled"
            : transition === "dead-lettered"
              ? "agent.execution.dead-lettered"
              : transition === "recovered"
                ? "agent.execution.recovered"
                : undefined;
  if (lifecycleType === undefined) return;
  const lifecycleEventId = stableId("runtime-lifecycle", execution.id, String(execution.currentAttemptSeq), transition);
  const lifecycleSeq = appendRoomEvent(database, {
    eventId: lifecycleEventId,
    roomId: execution.roomId,
    actorId: execution.agentId,
    eventType: lifecycleType,
    occurredAt,
    payload: {
      executionId: execution.id,
      attemptSeq: execution.currentAttemptSeq,
      retryCycle: execution.retryCycle,
      retryOrdinal: execution.retryOrdinal,
      actionCategory: execution.actionCategory,
      status: execution.status,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(execution.nextRetryAt === undefined ? {} : { nextRetryAt: execution.nextRetryAt }),
    },
  });
  appendRoomOutbox(
    database,
    lifecycleEventId,
    execution.roomId,
    lifecycleSeq,
    occurredAt,
    "runtime-lifecycle",
    transition,
  );
}

function insertLegacyRuntimeInvocationLineage(
  database: DatabaseSync,
  input: {
    readonly intentId: string;
    readonly roomId: string;
    readonly sourceMessageId: string;
    readonly targetAgentId: string;
    readonly requesterActorId: string;
    readonly intentKind: "direct_mention" | "structured_help" | "routed_candidate";
    readonly executionId: string;
    readonly createdAt: string;
  },
): void {
  database.prepare(
    `INSERT INTO agent_invocation_intents (
       id, room_id, source_message_id, target_agent_id, requester_actor_id,
       intent_kind, execution_id, created_at, message_transaction_id, target_id,
       source_revision, lineage_id, turn_id, origin_kind, status, claimed_at,
       cancelled_at, cancellation_reason, supersedes_intent_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, 'legacy',
               'legacy_runtime', 'claimed', ?, NULL, NULL, NULL)`,
  ).run(
    input.intentId,
    input.roomId,
    input.sourceMessageId,
    input.targetAgentId,
    input.requesterActorId,
    input.intentKind,
    input.executionId,
    input.createdAt,
    input.intentId,
    input.createdAt,
  );
  database.prepare(
    `INSERT INTO agent_execution_intent_links (
       intent_id, execution_id, execution_ordinal, retry_of_execution_id,
       source_revision, linked_at
     ) VALUES (?, ?, 1, NULL, 1, ?)`,
  ).run(input.intentId, input.executionId, input.createdAt);
}

function linkDerivedRuntimeExecution(
  database: DatabaseSync,
  input: {
    readonly sourceExecutionId: string;
    readonly derivedExecutionId: string;
    readonly linkedAt: string;
  },
): void {
  const lineage = database.prepare(
    `SELECT link.intent_id AS intentId, link.source_revision AS sourceRevision,
            COALESCE(MAX(existing.execution_ordinal), 0) + 1 AS executionOrdinal
     FROM agent_execution_intent_links AS link
     JOIN agent_execution_intent_links AS existing ON existing.intent_id = link.intent_id
     WHERE link.execution_id = ?
     GROUP BY link.intent_id, link.source_revision`,
  ).get(input.sourceExecutionId);
  if (typeof lineage?.intentId !== "string" ||
      typeof lineage.sourceRevision !== "number" ||
      typeof lineage.executionOrdinal !== "number") {
    return fail("execution_conflict", "Derived Agent execution lineage was stale");
  }
  database.prepare(
    `INSERT INTO agent_execution_intent_links (
       intent_id, execution_id, execution_ordinal, retry_of_execution_id,
       source_revision, linked_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    lineage.intentId,
    input.derivedExecutionId,
    lineage.executionOrdinal,
    input.sourceExecutionId,
    lineage.sourceRevision,
    input.linkedAt,
  );
}

function requireRuntimeHumanAuthority(
  database: DatabaseSync,
  context: AuthenticatedCommandContext,
  execution: AgentExecution,
  now: number,
): void {
  const actorId = requireHumanSession(database, context, now);
  const membership = database.prepare(
    `SELECT membership.role, room.status AS roomStatus,
            room.owner_actor_id = membership.actor_id AS isOwner
     FROM room_memberships AS membership
     JOIN rooms AS room ON room.id = membership.room_id
     WHERE membership.room_id = ? AND membership.actor_id = ? AND membership.kind = 'human'`,
  ).get(execution.roomId, actorId);
  if (membership?.roomStatus !== "active" ||
      (actorId !== execution.requesterId && membership.isOwner !== 1 && membership.role !== "admin")) {
    return fail("permission_denied", "Agent execution control was forbidden");
  }
}

function routeJobFromRow(row: Record<string, unknown> | undefined): RouteJob {
  if (row === undefined || typeof row.id !== "string" || typeof row.roomId !== "string" ||
      typeof row.sourceMessageId !== "string" ||
      (row.status !== "queued" && row.status !== "running" && row.status !== "completed" &&
        row.status !== "failed" && row.status !== "cancelled") ||
      (row.currentAttempt !== 1 && row.currentAttempt !== 2 && row.currentAttempt !== 3) ||
      typeof row.topicKey !== "string" || row.embeddingModelVersion !== "dao-topic-embedding-v1" ||
      row.windowSize !== 8 || row.cosineThreshold !== 0.82 ||
      (row.roomPhase !== "discussion" && row.roomPhase !== "execution") ||
      typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") {
    return fail("storage_unavailable", "Route job was corrupt");
  }
  return {
    id: row.id,
    roomId: row.roomId,
    sourceMessageId: row.sourceMessageId,
    status: row.status,
    currentAttempt: row.currentAttempt,
    topicKey: row.topicKey,
    embeddingModelVersion: row.embeddingModelVersion,
    windowSize: row.windowSize,
    cosineThreshold: row.cosineThreshold,
    roomPhase: row.roomPhase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
    ...(typeof row.terminalErrorCode === "string" ? { terminalErrorCode: row.terminalErrorCode } : {}),
    ...(typeof row.nextRetryAt === "string" ? { nextRetryAt: row.nextRetryAt } : {}),
  };
}

const routeJobSelect = `SELECT
  id, room_id AS roomId, source_message_id AS sourceMessageId, status,
  current_attempt AS currentAttempt, topic_key AS topicKey,
  embedding_model_version AS embeddingModelVersion, window_size AS windowSize,
  cosine_threshold AS cosineThreshold, room_phase AS roomPhase,
  created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt,
  terminal_error_code AS terminalErrorCode, next_retry_at AS nextRetryAt
FROM route_jobs`;

function routeJobById(database: DatabaseSync, routeJobId: string): RouteJob {
  const row = database.prepare(`${routeJobSelect} WHERE id = ?`).get(routeJobId);
  if (row === undefined) return fail("route_job_not_found", "Route job was not found");
  return routeJobFromRow(row);
}

function routeSourceAuthor(database: DatabaseSync, job: RouteJob): string {
  const source = database.prepare(
    "SELECT author_id AS authorId FROM messages WHERE id = ? AND room_id = ?",
  ).get(job.sourceMessageId, job.roomId);
  if (typeof source?.authorId !== "string") {
    return fail("storage_unavailable", "Route source author was corrupt");
  }
  return source.authorId;
}

function hasPendingHumanPreemptionAfterSource(
  database: DatabaseSync,
  execution: AgentExecution,
): boolean {
  const pending = database.prepare(
    `SELECT 1 AS present
     FROM events AS source_event
     JOIN events AS human_event
       ON human_event.stream_kind = 'room'
      AND human_event.stream_id = source_event.stream_id
      AND human_event.room_id = source_event.room_id
      AND human_event.stream_seq > source_event.stream_seq
      AND human_event.event_type = 'room.message.accepted'
     JOIN messages AS human_message
       ON human_message.id = json_extract(human_event.payload_json, '$.id')
      AND human_message.room_id = human_event.room_id
      AND human_message.author_kind = 'human'
     LEFT JOIN route_jobs AS human_route
       ON human_route.source_message_id = human_message.id
     LEFT JOIN human_preemption_fences AS fence
       ON fence.source_human_message_id = human_message.id
     WHERE source_event.stream_kind = 'room'
       AND source_event.stream_id = ?
       AND source_event.room_id = ?
       AND source_event.event_type = 'room.message.accepted'
       AND json_extract(source_event.payload_json, '$.id') = ?
       AND human_route.id IS NULL
       AND fence.source_human_message_id IS NULL
     ORDER BY human_event.stream_seq LIMIT 1`,
  ).get(execution.roomId, execution.roomId, execution.sourceMessageId);
  return pending?.present === 1;
}

function appendRouteLifecycleEvent(
  database: DatabaseSync,
  job: RouteJob,
  occurredAt: string,
  transition: "queued" | "started" | "retry-scheduled" | "completed" | "failed" | "recovered",
): void {
  const eventId = stableId("route-lifecycle", job.id, String(job.currentAttempt), transition);
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: job.roomId,
    actorId: routeSourceAuthor(database, job),
    eventType: `route.${transition}`,
    occurredAt,
    payload: job as unknown as JsonValue,
  });
  appendRoomOutbox(database, eventId, job.roomId, streamSeq, occurredAt, "route", transition);
}

function appendRouteJudgmentEvent(
  database: DatabaseSync,
  job: RouteJob,
  judgment: RouteJudgment,
  occurredAt: string,
): void {
  const eventId = stableId("route-judgment-event", judgment.id);
  const streamSeq = appendRoomEvent(database, {
    eventId,
    roomId: job.roomId,
    actorId: judgment.agentId,
    eventType: "room.route_judgment.recorded",
    occurredAt,
    payload: judgment as unknown as JsonValue,
  });
  appendRoomOutbox(database, eventId, job.roomId, streamSeq, occurredAt, "route-judgment", judgment.id);
}

function directMentionAgentIds(body: string, agentIds: readonly string[]): readonly string[] {
  const mentioned = new Set<string>();
  for (const match of body.matchAll(/@([\p{L}\p{N}_.:-]+)/gu)) {
    if (match[1] !== undefined) mentioned.add(match[1]);
  }
  return agentIds.filter((agentId) => mentioned.has(agentId));
}

function closeRouteAfterExhaustion(
  database: DatabaseSync,
  job: RouteJob,
  errorCode: RouteProviderFailureCode,
  occurredAt: string,
): RouteJob {
  const agents = database.prepare(
    `SELECT agent_id AS agentId FROM route_job_agents
     WHERE route_job_id = ? ORDER BY agent_id`,
  ).all(job.id);
  for (const agent of agents) {
    if (typeof agent.agentId !== "string") {
      return fail("storage_unavailable", "Route Agent snapshot was corrupt");
    }
    const judgment: RouteJudgment = {
      id: stableId("route-judgment", job.id, agent.agentId),
      routeJobId: job.id,
      sourceMessageId: job.sourceMessageId,
      agentId: agent.agentId,
      outcome: "no_response_needed",
      reasonCode: "provider_failed",
      reasonText: `closed provider failure: ${errorCode}`,
      routeAttempt: job.currentAttempt,
      decidedAt: occurredAt,
    };
    database.prepare(
      `INSERT INTO route_judgments (
         id, route_job_id, source_message_id, agent_id, outcome,
         reason_code, reason_text, route_attempt, decided_at
       ) VALUES (?, ?, ?, ?, 'no_response_needed', 'provider_failed', ?, ?, ?)`,
    ).run(
      judgment.id,
      judgment.routeJobId,
      judgment.sourceMessageId,
      judgment.agentId,
      judgment.reasonText,
      judgment.routeAttempt,
      judgment.decidedAt,
    );
    appendRouteJudgmentEvent(database, job, judgment, occurredAt);
  }
  database.prepare(
    `UPDATE route_jobs
     SET status = 'failed', updated_at = ?, completed_at = ?,
         terminal_error_code = ?, next_retry_at = NULL
     WHERE id = ? AND status = 'running' AND current_attempt = ?`,
  ).run(occurredAt, occurredAt, errorCode, job.id, job.currentAttempt);
  database.prepare(
    `INSERT INTO route_metrics (route_job_id, metric_name, value, recorded_at)
     VALUES (?, 'attempts_exhausted', 1, ?)`,
  ).run(job.id, occurredAt);
  const failed = routeJobById(database, job.id);
  appendRouteLifecycleEvent(database, failed, occurredAt, "failed");
  return failed;
}

function failRouteAttempt(
  database: DatabaseSync,
  job: RouteJob,
  errorCode: RouteProviderFailureCode,
  now: number,
): { readonly job: RouteJob; readonly retryAfterMs?: number } {
  if (job.status !== "running") return fail("route_conflict", "Route attempt was not running");
  const occurredAt = new Date(now).toISOString();
  database.prepare(
    `UPDATE route_attempts
     SET status = 'failed', finished_at = ?, error_code = ?, next_retry_at = NULL
     WHERE route_job_id = ? AND attempt_seq = ? AND status = 'running'`,
  ).run(occurredAt, errorCode, job.id, job.currentAttempt);
  if (job.currentAttempt === 3) {
    return { job: closeRouteAfterExhaustion(database, job, errorCode, occurredAt) };
  }
  const retryAfterMs = job.currentAttempt === 1 ? 250 : 1_000;
  const nextAttempt = (job.currentAttempt + 1) as 2 | 3;
  const nextRetryAt = new Date(now + retryAfterMs).toISOString();
  database.prepare(
    `UPDATE route_jobs
     SET status = 'queued', current_attempt = ?, updated_at = ?, next_retry_at = ?
     WHERE id = ? AND status = 'running' AND current_attempt = ?`,
  ).run(nextAttempt, occurredAt, nextRetryAt, job.id, job.currentAttempt);
  database.prepare(
    `INSERT INTO route_attempts (
       route_job_id, attempt_seq, status, next_retry_at
     ) VALUES (?, ?, 'queued', ?)`,
  ).run(job.id, nextAttempt, nextRetryAt);
  const retry = routeJobById(database, job.id);
  appendRouteLifecycleEvent(database, retry, occurredAt, "retry-scheduled");
  return { job: retry, retryAfterMs };
}

export function executeRouteAuthorityOperation(
  database: DatabaseSync,
  operation: RouteAuthorityOperation,
): RouteAuthorityOperationResult {
  return runAuthorityImmediateTransaction(database, () => {
    const occurredAt = new Date(operation.now).toISOString();
    if (operation.type === "route.claim") {
      const row = database.prepare(
        `${routeJobSelect} WHERE source_message_id = ?`,
      ).get(operation.sourceMessageId);
      if (row === undefined) return fail("route_job_not_found", "Route job was not found");
      const queued = routeJobFromRow(row);
      if (queued.status !== "queued" ||
          (queued.nextRetryAt !== undefined && Date.parse(queued.nextRetryAt) > operation.now)) {
        return fail("route_conflict", "Route job was not claimable");
      }
      const claimed = database.prepare(
        `UPDATE route_jobs SET status = 'running', updated_at = ?, next_retry_at = NULL
         WHERE id = ? AND status = 'queued' AND current_attempt = ?`,
      ).run(occurredAt, queued.id, queued.currentAttempt);
      if (claimed.changes !== 1) return fail("route_conflict", "Route claim was stale");
      database.prepare(
        `UPDATE route_attempts SET status = 'running', started_at = ?, next_retry_at = NULL
         WHERE route_job_id = ? AND attempt_seq = ? AND status = 'queued'`,
      ).run(occurredAt, queued.id, queued.currentAttempt);
      appendRouteLifecycleEvent(database, routeJobById(database, queued.id), occurredAt, "started");

      const message = database.prepare(
        `SELECT author_id AS authorId, author_kind AS authorKind, body, sent_at AS sentAt
         FROM messages WHERE id = ? AND room_id = ?`,
      ).get(queued.sourceMessageId, queued.roomId);
      if (typeof message?.authorId !== "string" ||
          (message.authorKind !== "human" && message.authorKind !== "agent") ||
          typeof message.body !== "string" || typeof message.sentAt !== "string") {
        return fail("storage_unavailable", "Route source message was corrupt");
      }
      const memberRows = database.prepare(
        `SELECT snapshot.agent_id AS agentId, snapshot.participation, snapshot.role,
                snapshot.capabilities_json AS capabilitiesJson,
                snapshot.calibration_score AS calibrationScore,
                snapshot.has_ball AS hasBall
         FROM route_job_agents AS snapshot
         WHERE snapshot.route_job_id = ? ORDER BY snapshot.agent_id`,
      ).all(queued.id);
      const agents = memberRows.map((member) => {
        let capabilities: unknown;
        try {
          capabilities = typeof member.capabilitiesJson === "string"
            ? JSON.parse(member.capabilitiesJson) : undefined;
        } catch {
          return fail("storage_unavailable", "Route capability snapshot was corrupt");
        }
        if (typeof member.agentId !== "string" ||
            (member.participation !== "active" && member.participation !== "on-mention" && member.participation !== "silent") ||
            typeof member.role !== "string" || !Array.isArray(capabilities) ||
            !capabilities.every((entry) => typeof entry === "string") ||
            typeof member.calibrationScore !== "number" ||
            (member.hasBall !== 0 && member.hasBall !== 1)) {
          return fail("storage_unavailable", "Route Agent snapshot was corrupt");
        }
        return {
          agentId: member.agentId,
          participation: member.participation,
          role: member.role,
          capabilities,
          calibrationScore: member.calibrationScore,
          hasBall: member.hasBall === 1,
        } as const;
      });
      const recentHumans = database.prepare(
        `SELECT sent_at AS sentAt FROM messages
         WHERE room_id = ? AND author_kind = 'human' AND sent_at >= ? AND sent_at <= ?
         ORDER BY sent_at`,
      ).all(queued.roomId, new Date(operation.now - 60_000).toISOString(), occurredAt);
      const recentHumanMessageTimes = recentHumans.map((entry) => {
        const parsed = typeof entry.sentAt === "string" ? Date.parse(entry.sentAt) : Number.NaN;
        if (!Number.isFinite(parsed)) return fail("storage_unavailable", "Route human-message clock was corrupt");
        return parsed;
      });
      const recentKinds = database.prepare(
        `SELECT author_kind AS authorKind FROM messages
         WHERE room_id = ? AND (sent_at < ? OR (sent_at = ? AND id <= ?))
         ORDER BY sent_at DESC, id DESC LIMIT 4`,
      ).all(queued.roomId, message.sentAt, message.sentAt, queued.sourceMessageId);
      let consecutiveAgentRounds = 0;
      for (const entry of recentKinds) {
        if (entry.authorKind === "human") break;
        if (entry.authorKind !== "agent") return fail("storage_unavailable", "Route message author was corrupt");
        consecutiveAgentRounds += 1;
      }
      const cooldownRows = database.prepare(
        `SELECT judgment.agent_id AS agentId, MAX(judgment.decided_at) AS decidedAt
         FROM route_judgments AS judgment
         JOIN route_jobs AS prior ON prior.id = judgment.route_job_id
         WHERE prior.room_id = ? AND prior.topic_key = ?
           AND prior.id <> ? AND judgment.outcome = 'will_respond'
         GROUP BY judgment.agent_id ORDER BY judgment.agent_id`,
      ).all(queued.roomId, queued.topicKey, queued.id);
      const cooldownByAgentId = cooldownRows.map((entry) => {
        const lastRespondedAt = typeof entry.decidedAt === "string" ? Date.parse(entry.decidedAt) : Number.NaN;
        if (typeof entry.agentId !== "string" || !Number.isFinite(lastRespondedAt)) {
          return fail("storage_unavailable", "Route cooldown fact was corrupt");
        }
        return { agentId: entry.agentId, lastRespondedAt };
      });
      const running = routeJobById(database, queued.id);
      return {
        kind: "route-claimed",
        job: running,
        providerInput: {
          purpose: "route_decision",
          roomId: running.roomId,
          sourceMessageId: running.sourceMessageId,
          message: {
            authorId: message.authorId,
            authorKind: message.authorKind,
            summary: message.body.slice(0, 4_096),
          },
          roomPhase: running.roomPhase,
          agents,
          topic: {
            topicKey: running.topicKey,
            embeddingModelVersion: running.embeddingModelVersion,
            windowSize: running.windowSize,
            cosineThreshold: running.cosineThreshold,
          },
          limits: {
            timeoutMs: 1_000,
            maxCandidates: Math.min(agents.length, 256),
            maxOutputBytes: 64 * 1_024,
          },
        },
        decisionContext: {
          directMentionAgentIds: directMentionAgentIds(
            message.body,
            agents.map((agent) => agent.agentId),
          ),
          structuredHelpAgentIds: [],
          recentHumanMessageTimes,
          consecutiveAgentRounds,
          cooldownByAgentId,
        },
      };
    }

    if (operation.type === "route.complete") {
      const job = routeJobById(database, operation.routeJobId);
      if (job.status !== "running" || job.currentAttempt !== operation.attempt) {
        return fail("route_conflict", "Route completion was stale");
      }
      const snapshotAgents = database.prepare(
        `SELECT agent_id AS agentId FROM route_job_agents
         WHERE route_job_id = ? ORDER BY agent_id`,
      ).all(job.id).map((entry) => {
        if (typeof entry.agentId !== "string") return fail("storage_unavailable", "Route Agent snapshot was corrupt");
        return entry.agentId;
      });
      const expectedAgents = new Set(snapshotAgents);
      const judgmentByAgent = new Map<string, RouteJudgment>();
      for (const judgment of operation.judgments) {
        if (judgment.routeJobId !== job.id || judgment.sourceMessageId !== job.sourceMessageId ||
            judgment.routeAttempt !== job.currentAttempt || !expectedAgents.has(judgment.agentId) ||
            judgmentByAgent.has(judgment.agentId)) {
          return fail("route_conflict", "Route judgment set was not closed");
        }
        judgmentByAgent.set(judgment.agentId, judgment);
      }
      if (judgmentByAgent.size !== expectedAgents.size) {
        return fail("route_conflict", "Route judgment set omitted an Agent");
      }
      const currentRoom = database.prepare("SELECT status FROM rooms WHERE id = ?").get(job.roomId);
      const acceptedIntents: RouteInvocationIntent[] = [];
      const intentAgents = new Set<string>();
      for (const intent of operation.intents) {
        if (intent.roomId !== job.roomId || intent.sourceMessageId !== job.sourceMessageId ||
            !expectedAgents.has(intent.targetAgentId) || intentAgents.has(intent.targetAgentId)) {
          return fail("route_conflict", "Route invocation intent was invalid");
        }
        intentAgents.add(intent.targetAgentId);
        const membership = database.prepare(
          `SELECT membership.kind, actor.kind AS actorKind
           FROM room_memberships AS membership
           JOIN actors AS actor ON actor.id = membership.actor_id
           WHERE membership.room_id = ? AND membership.actor_id = ?`,
        ).get(job.roomId, intent.targetAgentId);
        if (currentRoom?.status !== "active" || membership?.kind !== "agent" || membership.actorKind !== "agent") {
          const previous = judgmentByAgent.get(intent.targetAgentId)!;
          judgmentByAgent.set(intent.targetAgentId, {
            ...previous,
            outcome: "suppressed",
            reasonCode: "permission_denied",
            reasonText: "current Agent membership permission denied",
          });
          continue;
        }
        acceptedIntents.push(intent);
      }
      if (acceptedIntents.length > 0) {
        requireMessageMutationAllowed(
          database,
          job.roomId,
          "message_intent",
          stableId("route-intent-gate", job.id, String(job.currentAttempt)),
        );
      }
      for (const agentId of snapshotAgents) {
        const judgment = judgmentByAgent.get(agentId)!;
        if ((acceptedIntents.some((intent) => intent.targetAgentId === agentId)) !==
            (judgment.outcome === "will_respond")) {
          return fail("route_conflict", "Route judgment and invocation intent disagreed");
        }
        database.prepare(
          `INSERT INTO route_judgments (
             id, route_job_id, source_message_id, agent_id, outcome,
             reason_code, reason_text, route_attempt, decided_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          judgment.id,
          judgment.routeJobId,
          judgment.sourceMessageId,
          judgment.agentId,
          judgment.outcome,
          judgment.reasonCode,
          judgment.reasonText,
          judgment.routeAttempt,
          judgment.decidedAt,
        );
        appendRouteJudgmentEvent(database, job, judgment, occurredAt);
      }
      for (const intent of acceptedIntents) {
        database.prepare(
          `INSERT INTO route_invocation_intents (
             route_job_id, source_message_id, target_agent_id, intent_kind,
             reason_code, reason_text, priority, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          job.id,
          job.sourceMessageId,
          intent.targetAgentId,
          intent.kind,
          intent.reasonCode,
          intent.reasonText,
          intent.priority,
          occurredAt,
        );
      }
      if (operation.terminalErrorCode === undefined) {
        database.prepare(
          `UPDATE route_attempts SET status = 'completed', finished_at = ?
           WHERE route_job_id = ? AND attempt_seq = ? AND status = 'running'`,
        ).run(occurredAt, job.id, job.currentAttempt);
        database.prepare(
          `UPDATE route_jobs
           SET status = 'completed', updated_at = ?, completed_at = ?, next_retry_at = NULL
           WHERE id = ? AND status = 'running' AND current_attempt = ?`,
        ).run(occurredAt, occurredAt, job.id, job.currentAttempt);
      } else {
        database.prepare(
          `UPDATE route_attempts
           SET status = 'failed', finished_at = ?, error_code = ?
           WHERE route_job_id = ? AND attempt_seq = ? AND status = 'running'`,
        ).run(occurredAt, operation.terminalErrorCode, job.id, job.currentAttempt);
        database.prepare(
          `UPDATE route_jobs
           SET status = 'failed', updated_at = ?, completed_at = ?,
               terminal_error_code = ?, next_retry_at = NULL
           WHERE id = ? AND status = 'running' AND current_attempt = ?`,
        ).run(
          occurredAt,
          occurredAt,
          operation.terminalErrorCode,
          job.id,
          job.currentAttempt,
        );
        database.prepare(
          `INSERT INTO route_metrics (route_job_id, metric_name, value, recorded_at)
           VALUES (?, 'attempts_exhausted', 1, ?)`,
        ).run(job.id, occurredAt);
      }
      const terminalJob = routeJobById(database, job.id);
      appendRouteLifecycleEvent(
        database,
        terminalJob,
        occurredAt,
        operation.terminalErrorCode === undefined ? "completed" : "failed",
      );
      return {
        kind: "route-completed",
        job: terminalJob,
        intents: acceptedIntents,
      };
    }

    if (operation.type === "route.fail") {
      const job = routeJobById(database, operation.routeJobId);
      if (job.currentAttempt !== operation.attempt) return fail("route_conflict", "Route failure was stale");
      const failed = failRouteAttempt(database, job, operation.errorCode, operation.now);
      return { kind: "route-failed", ...failed };
    }

    const runningRows = database.prepare(
      `${routeJobSelect} WHERE status = 'running' ORDER BY created_at, id LIMIT 256`,
    ).all();
    for (const row of runningRows) {
      failRouteAttempt(database, routeJobFromRow(row), "runtime_restarted", operation.now);
    }
    const readyRows = database.prepare(
      `${routeJobSelect}
       WHERE status = 'queued'
       ORDER BY room_id, created_at, id LIMIT 256`,
    ).all();
    return { kind: "route-recovery", jobs: readyRows.map(routeJobFromRow) };
  });
}

export function executeRuntimeAuthorityOperation(
  database: DatabaseSync,
  operation: RuntimeAuthorityOperation,
): RuntimeAuthorityOperationResult {
  return runAuthorityImmediateTransaction(database, () => {
    const occurredAt = new Date(operation.now).toISOString();
    if (operation.type === "runtime.list-pending-human-fences") {
      const rows = database.prepare(
        `SELECT message.id
         FROM messages AS message
         JOIN events AS accepted
           ON accepted.stream_kind = 'room' AND accepted.stream_id = message.room_id
          AND accepted.event_type = 'room.message.accepted'
          AND json_extract(accepted.payload_json, '$.id') = message.id
         LEFT JOIN route_jobs AS route ON route.source_message_id = message.id
         WHERE message.author_kind = 'human' AND route.id IS NULL
         ORDER BY accepted.occurred_at, accepted.stream_seq, message.id LIMIT 256`,
      ).all();
      if (!rows.every((row) => typeof row.id === "string")) {
        return fail("storage_unavailable", "Pending human fence rows were corrupt");
      }
      return {
        kind: "pending-human-fences",
        sourceHumanMessageIds: rows.map((row) => row.id as string),
      };
    }
    if (operation.type === "runtime.cancel-for-human-fence") {
      const source = database.prepare(
        `SELECT message.id, message.room_id AS roomId, message.author_id AS humanActorId,
                event.occurred_at AS acceptedAt
         FROM messages AS message
         JOIN events AS event
           ON event.stream_kind = 'room' AND event.stream_id = message.room_id
          AND event.room_id = message.room_id AND event.actor_id = message.author_id
          AND event.event_type = 'room.message.accepted'
          AND json_extract(event.payload_json, '$.id') = message.id
         WHERE message.id = ? AND message.author_kind = 'human'
         ORDER BY event.stream_seq LIMIT 1`,
      ).get(operation.sourceHumanMessageId);
      if (typeof source?.id !== "string" || typeof source.roomId !== "string" ||
          typeof source.humanActorId !== "string" || typeof source.acceptedAt !== "string") {
        return fail("message_not_found", "Durable human fence message was not found");
      }
      const existing = database.prepare(
        `SELECT cancel_committed_at AS cancelCommittedAt
         FROM human_preemption_fences WHERE source_human_message_id = ?`,
      ).get(source.id);
      if (typeof existing?.cancelCommittedAt === "string") {
        const ids = database.prepare(
          `SELECT execution_id AS executionId FROM agent_human_fences
           WHERE fence_message_id = ? ORDER BY execution_id`,
        ).all(source.id);
        if (!ids.every((row) => typeof row.executionId === "string")) {
          return fail("storage_unavailable", "Human fence replay rows were corrupt");
        }
        const cancelledExecutions = ids.map((row) => runtimeExecutionById(database, row.executionId as string));
        const notice: HumanPreemptionNotice = {
          roomId: source.roomId,
          sourceHumanMessageId: source.id,
          cancelledExecutionIds: cancelledExecutions.map((execution) => execution.id),
          rerouteStatus: "queued",
          occurredAt: existing.cancelCommittedAt,
        };
        return { kind: "human-fence-cancelled", notice, cancelledExecutions };
      }
      const candidates = database.prepare(
        `SELECT id
         FROM agent_executions
         WHERE room_id = ? AND queued_at <= ? AND (
           status = 'queued'
           OR (status = 'running' AND action_category = 'waiting_upstream')
           OR (status = 'running' AND action_category = 'tool_call'
               AND tool_dispatch_phase = 'not_started')
         )
         ORDER BY queued_at, id LIMIT 34`,
      ).all(source.roomId, source.acceptedAt);
      if (candidates.length > 33 || !candidates.every((row) => typeof row.id === "string")) {
        return fail("storage_unavailable", "Human fence candidate set exceeded its bound");
      }
      const cancelledExecutions: AgentExecution[] = [];
      for (const candidate of candidates) {
        const current = runtimeExecutionById(database, candidate.id as string);
        const cancellationReason = `human_preempted:${source.id}`;
        const updated = database.prepare(
          `UPDATE agent_executions
           SET status = 'cancelled', cancellation_reason = ?, completed_at = ?,
               updated_at = ?, next_retry_at = NULL
           WHERE id = ? AND current_attempt_seq = ? AND (
             status = 'queued'
             OR (status = 'running' AND action_category = 'waiting_upstream')
             OR (status = 'running' AND action_category = 'tool_call'
                 AND tool_dispatch_phase = 'not_started')
           )`,
        ).run(cancellationReason, occurredAt, occurredAt, current.id, current.currentAttemptSeq);
        if (updated.changes !== 1) return fail("execution_conflict", "Human fence cancellation was stale");
        database.prepare(
          `UPDATE agent_execution_attempts
           SET status = 'cancelled', finished_at = ?, error_code = 'human_preempted', next_retry_at = NULL
           WHERE execution_id = ? AND attempt_seq = ? AND status IN ('queued', 'running')`,
        ).run(occurredAt, current.id, current.currentAttemptSeq);
        database.prepare(
          `INSERT INTO agent_human_fences (
             fence_message_id, execution_id, old_attempt_seq, cancelled_at
           ) VALUES (?, ?, ?, ?)`,
        ).run(source.id, current.id, current.currentAttemptSeq, occurredAt);
        const cancelled = runtimeExecutionById(database, current.id);
        appendRuntimeExecutionEvent(database, cancelled, occurredAt, "cancelled", "human_preempted");
        cancelledExecutions.push(cancelled);
      }
      database.prepare(
        `INSERT INTO human_preemption_fences (
           source_human_message_id, room_id, human_actor_id, accepted_at,
           cancelled_count, cancel_committed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(source.id, source.roomId, source.humanActorId, source.acceptedAt,
        cancelledExecutions.length, occurredAt);
      const notice: HumanPreemptionNotice = {
        roomId: source.roomId,
        sourceHumanMessageId: source.id,
        cancelledExecutionIds: cancelledExecutions.map((execution) => execution.id),
        rerouteStatus: "queued",
        occurredAt,
      };
      const eventId = stableId("human-preemption", source.id);
      const streamSeq = appendRoomEvent(database, {
        eventId,
        roomId: source.roomId,
        actorId: source.humanActorId,
        eventType: "room.human_preemption.applied",
        occurredAt,
        payload: notice as unknown as JsonValue,
      });
      appendRoomOutbox(database, eventId, source.roomId, streamSeq, occurredAt,
        "human-preemption", source.id);
      return { kind: "human-fence-cancelled", notice, cancelledExecutions };
    }
    if (operation.type === "runtime.create-route-after-human-fence") {
      const fence = database.prepare(
        `SELECT fence.room_id AS roomId, fence.human_actor_id AS humanActorId,
                fence.accepted_at AS acceptedAt, fence.route_job_id AS routeJobId,
                message.body, message.sent_at AS sentAt
         FROM human_preemption_fences AS fence
         JOIN messages AS message ON message.id = fence.source_human_message_id
         WHERE fence.source_human_message_id = ?`,
      ).get(operation.sourceHumanMessageId);
      if (typeof fence?.roomId !== "string" || typeof fence.humanActorId !== "string" ||
          typeof fence.acceptedAt !== "string" || typeof fence.body !== "string" ||
          typeof fence.sentAt !== "string") {
        return fail("execution_conflict", "Human cancellation must commit before route creation");
      }
      if (typeof fence.routeJobId === "string") {
        return {
          kind: "human-fence-route", roomId: fence.roomId,
          sourceHumanMessageId: operation.sourceHumanMessageId,
          routeJobId: fence.routeJobId, replayed: true,
        };
      }
      const message: Message = {
        id: operation.sourceHumanMessageId,
        roomId: fence.roomId,
        authorId: fence.humanActorId,
        authorKind: "human",
        body: fence.body,
        sentAt: fence.sentAt,
      };
      enqueueRouteJobForMessage(database, message, occurredAt);
      const routeJobId = stableId("route-job", message.id);
      const linked = database.prepare(
        `UPDATE human_preemption_fences
         SET route_job_id = ?, route_created_at = ?
         WHERE source_human_message_id = ? AND route_job_id IS NULL`,
      ).run(routeJobId, occurredAt, message.id);
      if (linked.changes !== 1) return fail("execution_conflict", "Human fence route link was stale");
      return {
        kind: "human-fence-route", roomId: message.roomId,
        sourceHumanMessageId: message.id, routeJobId, replayed: false,
      };
    }
    if (operation.type === "runtime.enqueue-fence-replacements") {
      const fenceRoute = database.prepare(
        `SELECT 1 AS present
         FROM route_jobs AS route
         JOIN human_preemption_fences AS fence
           ON fence.source_human_message_id = route.source_message_id
          AND fence.route_job_id = route.id
         WHERE route.id = ?`,
      ).get(operation.routeJobId);
      if (fenceRoute?.present !== 1) {
        return { kind: "human-fence-replacements", executions: [], replayed: false };
      }
      const route = database.prepare(
        `SELECT route.room_id AS roomId, route.source_message_id AS sourceMessageId,
                route.status, source.author_id AS requesterId, intent.intent_kind AS intentKind
         FROM route_jobs AS route
         JOIN messages AS source ON source.id = route.source_message_id
         JOIN route_invocation_intents AS intent
           ON intent.route_job_id = route.id AND intent.target_agent_id = ?
         JOIN route_judgments AS judgment
           ON judgment.route_job_id = route.id AND judgment.agent_id = intent.target_agent_id
          AND judgment.outcome = 'will_respond'
         JOIN human_preemption_fences AS fence
           ON fence.source_human_message_id = route.source_message_id
          AND fence.route_job_id = route.id
         JOIN room_memberships AS membership
           ON membership.room_id = route.room_id AND membership.actor_id = intent.target_agent_id
          AND membership.kind = 'agent'
         JOIN actors AS actor ON actor.id = intent.target_agent_id AND actor.kind = 'agent'
         JOIN rooms AS room ON room.id = route.room_id AND room.status = 'active'
         WHERE route.id = ?`,
      ).get(operation.targetAgentId, operation.routeJobId);
      if (typeof route?.roomId !== "string" || typeof route.sourceMessageId !== "string" ||
          typeof route.requesterId !== "string" ||
          (route.status !== "completed" && route.status !== "failed") ||
          (route.intentKind !== "direct_mention" && route.intentKind !== "structured_help" &&
            route.intentKind !== "routed_candidate")) {
        return fail("execution_conflict", "Fence replacement requires a terminal selected route judgment");
      }
      const existing = database.prepare(
        `SELECT execution_id AS executionId FROM agent_invocation_intents
         WHERE source_message_id = ? AND target_agent_id = ?`,
      ).get(route.sourceMessageId, operation.targetAgentId);
      if (typeof existing?.executionId === "string") {
        requireExecutionRuntimeGenerationAllowed(
          database,
          existing.executionId,
          stableId("fence-replacement-replay-gate", existing.executionId),
        );
        const execution = runtimeExecutionById(database, existing.executionId);
        const replacement = database.prepare(
          `SELECT 1 AS present FROM agent_fence_replacements
           WHERE fence_message_id = ? AND replacement_execution_id = ? LIMIT 1`,
        ).get(route.sourceMessageId, execution.id);
        return {
          kind: "human-fence-replacements",
          executions: replacement?.present === 1 ? [execution] : [],
          replayed: replacement?.present === 1,
        };
      }
      const oldRows = database.prepare(
        `SELECT fence.execution_id AS executionId, fence.old_attempt_seq AS oldAttemptSeq
         FROM agent_human_fences AS fence
         JOIN agent_executions AS old ON old.id = fence.execution_id
         LEFT JOIN agent_fence_replacements AS replacement
           ON replacement.fence_message_id = fence.fence_message_id
          AND replacement.old_execution_id = fence.execution_id
         WHERE fence.fence_message_id = ? AND old.agent_id = ?
           AND replacement.old_execution_id IS NULL
         ORDER BY fence.execution_id LIMIT 33`,
      ).all(route.sourceMessageId, operation.targetAgentId);
      if (!oldRows.every((row) => typeof row.executionId === "string" &&
          typeof row.oldAttemptSeq === "number")) {
        return fail("storage_unavailable", "Fence replacement lineage was corrupt");
      }
      if (oldRows.length === 0) {
        return { kind: "human-fence-replacements", executions: [], replayed: false };
      }
      const queued = database.prepare(
        `SELECT COUNT(*) AS count FROM agent_executions WHERE room_id = ? AND status = 'queued'`,
      ).get(route.roomId);
      if (typeof queued?.count !== "number" || queued.count >= 32) {
        return fail("agent_queue_full", "Agent room queue was full");
      }
      const supersedesExecutionIds = oldRows.map((row) => row.executionId as string);
      const executionId = stableId("fence-replacement", route.sourceMessageId, operation.targetAgentId);
      const intentId = stableId("fence-replacement-intent", route.sourceMessageId, operation.targetAgentId);
      requireMessageMutationAllowed(
        database,
        route.roomId,
        "message_intent",
        stableId("fence-replacement-intent-gate", operation.routeJobId, operation.targetAgentId),
      );
      const roomArchiveGeneration = currentRoomArchiveGeneration(database, route.roomId);
      requireRuntimeGenerationAllowed(
        database,
        route.roomId,
        roomArchiveGeneration,
        stableId("fence-replacement-runtime-gate", executionId),
      );
      database.prepare(
        `INSERT INTO agent_executions (
           id, room_id, room_archive_generation, agent_id, trigger_message_id, status, started_at,
           completed_at, result_json, requester_actor_id, tool_name,
           action_category, tool_dispatch_phase, current_attempt_seq,
           retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
           queued_at, updated_at, supersedes_execution_ids_json
         ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, 'model.generate',
                   'model_generation', NULL, 1, 1, 1, ?, ?, 0, ?, ?, ?)`,
      ).run(executionId, route.roomId, roomArchiveGeneration,
        operation.targetAgentId, route.sourceMessageId,
        occurredAt, route.requesterId, operation.providerId, operation.modelId,
        occurredAt, occurredAt, JSON.stringify(supersedesExecutionIds));
      database.prepare(
        `INSERT INTO agent_execution_attempts (
           execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
           action_category, recovery_cursor
         ) VALUES (?, 1, 1, 1, 'queued', 'model_generation', 0)`,
      ).run(executionId);
      insertLegacyRuntimeInvocationLineage(database, {
        intentId,
        roomId: route.roomId,
        sourceMessageId: route.sourceMessageId,
        targetAgentId: operation.targetAgentId,
        requesterActorId: route.requesterId,
        intentKind: route.intentKind,
        executionId,
        createdAt: occurredAt,
      });
      for (const old of oldRows) {
        database.prepare(
          `INSERT INTO agent_fence_replacements (
             fence_message_id, old_execution_id, old_attempt_seq, route_job_id,
             selected_agent_id, replacement_execution_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(route.sourceMessageId, old.executionId as string, old.oldAttemptSeq as number,
          operation.routeJobId, operation.targetAgentId, executionId, occurredAt);
      }
      const execution = runtimeExecutionById(database, executionId);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "queued");
      return { kind: "human-fence-replacements", executions: [execution], replayed: false };
    }
    if (operation.type === "runtime.read-context") {
      const execution = runtimeExecutionById(database, operation.executionId);
      requireExecutionRuntimeGenerationAllowed(
        database,
        execution.id,
        stableId("runtime-model-generation-gate", execution.id, String(execution.currentAttemptSeq)),
      );
      requireAgentCommandAuthority(database, execution.agentId, execution.roomId);
      const permissionRow = database.prepare(
        `SELECT actor.tool_permissions_json AS capabilityJson,
                membership.tool_permissions_json AS membershipJson,
                membership.participation AS participation, room.status AS roomStatus
         FROM actors AS actor
         JOIN room_memberships AS membership ON membership.actor_id = actor.id
         JOIN rooms AS room ON room.id = membership.room_id
         WHERE actor.id = ? AND membership.room_id = ? AND actor.kind = 'agent' AND membership.kind = 'agent'`,
      ).get(execution.agentId, execution.roomId);
      const capabilities = typeof permissionRow?.capabilityJson === "string"
        ? JSON.parse(permissionRow.capabilityJson) as unknown : [];
      const membershipPermissions = typeof permissionRow?.membershipJson === "string"
        ? JSON.parse(permissionRow.membershipJson) as unknown : [];
      const allowedIds = new Set(["http-json.read", "repository.git-status", "sandbox-file.write"]);
      const toolIds = permissionRow?.roomStatus === "active" && permissionRow.participation === "active" &&
        Array.isArray(capabilities) && Array.isArray(membershipPermissions)
        ? capabilities.filter((entry): entry is "http-json.read" | "repository.git-status" | "sandbox-file.write" =>
            typeof entry === "string" && allowedIds.has(entry) && membershipPermissions.includes(entry))
        : [];
      const messages = database.prepare(
        `SELECT message.id AS messageId, message.author_id AS authorId, revision.body
         FROM (
           SELECT envelope.message_id, envelope.current_revision, envelope.created_at
           FROM message_envelopes AS envelope
           WHERE envelope.room_id = ? AND envelope.lifecycle = 'active'
           ORDER BY envelope.created_at DESC, envelope.message_id DESC LIMIT 64
         ) AS current
         JOIN messages AS message ON message.id = current.message_id
         JOIN message_revisions AS revision
           ON revision.message_id = current.message_id
          AND revision.revision = current.current_revision
         ORDER BY current.created_at, messageId`,
      ).all(execution.roomId);
      if (!messages.every((message) => typeof message.messageId === "string" &&
          typeof message.authorId === "string" && typeof message.body === "string")) {
        return fail("storage_unavailable", "Agent runtime context was corrupt");
      }
      const openItemTargets = database.prepare(
        `SELECT membership.actor_id AS actorId, membership.kind
         FROM room_memberships AS membership
         JOIN rooms AS room ON room.id = membership.room_id
         WHERE membership.room_id = ? AND room.status = 'active'
         ORDER BY membership.actor_id`,
      ).all(execution.roomId);
      if (!openItemTargets.every((target) => typeof target.actorId === "string" &&
          (target.kind === "human" || target.kind === "agent"))) {
        return fail("storage_unavailable", "Agent OpenItem targets were corrupt");
      }
      return {
        kind: "context",
        visibleConversation: messages as { messageId: string; authorId: string; body: string }[],
        toolIds,
        openItemTargets: openItemTargets as { actorId: string; kind: "human" | "agent" }[],
      };
    }
    if (operation.type === "runtime.invoke") {
      const requesterId = operation.context.kind === "human"
        ? requireHumanSession(database, operation.context, operation.now)
        : (() => {
            requireAgentCommandAuthority(database, operation.context.agent.actorId, operation.intent.roomId);
            return operation.context.agent.actorId;
          })();
      const source = database.prepare(
        `SELECT room_id AS roomId, author_id AS authorId FROM messages WHERE id = ?`,
      ).get(operation.intent.sourceMessageId);
      if (source?.roomId !== operation.intent.roomId || source.authorId !== requesterId) {
        return fail("message_not_found", "Agent invocation source message was not found");
      }
      const target = database.prepare(
        `SELECT actor.kind AS actorKind, membership.kind AS membershipKind, room.status AS roomStatus
         FROM room_memberships AS membership
         JOIN actors AS actor ON actor.id = membership.actor_id
         JOIN rooms AS room ON room.id = membership.room_id
         WHERE membership.room_id = ? AND membership.actor_id = ?`,
      ).get(operation.intent.roomId, operation.intent.targetAgentId);
      if (target?.actorKind !== "agent" || target.membershipKind !== "agent" || target.roomStatus !== "active") {
        return fail("permission_denied", "Target Agent membership was forbidden");
      }
      const existing = database.prepare(
        `SELECT execution_id AS executionId, intent_kind AS intentKind
         FROM agent_invocation_intents WHERE source_message_id = ? AND target_agent_id = ?`,
      ).get(operation.intent.sourceMessageId, operation.intent.targetAgentId);
      if (typeof existing?.executionId === "string") {
        requireExecutionRuntimeGenerationAllowed(
          database,
          existing.executionId,
          stableId("runtime-invoke-replay-gate", operation.executionId),
        );
        if (operation.intent.kind === "direct_mention" && existing.intentKind !== "direct_mention") {
          requireMessageMutationAllowed(
            database,
            operation.intent.roomId,
            "message_intent",
            stableId("runtime-intent-upgrade-gate", operation.intentId),
          );
          database.prepare(
            `UPDATE agent_invocation_intents SET intent_kind = 'direct_mention'
             WHERE source_message_id = ? AND target_agent_id = ?`,
          ).run(operation.intent.sourceMessageId, operation.intent.targetAgentId);
        }
        return { kind: "invocation", execution: runtimeExecutionById(database, existing.executionId), replayed: true };
      }
      const queued = database.prepare(
        `SELECT COUNT(*) AS count FROM agent_executions WHERE room_id = ? AND status = 'queued'`,
      ).get(operation.intent.roomId);
      if (typeof queued?.count !== "number" || queued.count >= 32) {
        return fail("agent_queue_full", "Agent room queue was full");
      }
      requireMessageMutationAllowed(
        database,
        operation.intent.roomId,
        "message_intent",
        stableId("runtime-intent-gate", operation.intentId),
      );
      const roomArchiveGeneration = currentRoomArchiveGeneration(database, operation.intent.roomId);
      requireRuntimeGenerationAllowed(
        database,
        operation.intent.roomId,
        roomArchiveGeneration,
        stableId("runtime-invoke-generation-gate", operation.executionId),
      );
      database.prepare(
        `INSERT INTO agent_executions (
           id, room_id, room_archive_generation, agent_id, trigger_message_id, status, started_at,
           completed_at, result_json, requester_actor_id, tool_name,
           action_category, tool_dispatch_phase, current_attempt_seq,
           retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
           queued_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, 'model.generate',
                   'model_generation', NULL, 1, 1, 1, ?, ?, 0, ?, ?)`,
      ).run(
        operation.executionId,
        operation.intent.roomId,
        roomArchiveGeneration,
        operation.intent.targetAgentId,
        operation.intent.sourceMessageId,
        occurredAt,
        requesterId,
        operation.providerId,
        operation.modelId,
        occurredAt,
        occurredAt,
      );
      database.prepare(
        `INSERT INTO agent_execution_attempts (
           execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
           action_category, started_at, finished_at, error_code, next_retry_at,
           recovery_cursor
         ) VALUES (?, 1, 1, 1, 'queued', 'model_generation', NULL, NULL, NULL, NULL, 0)`,
      ).run(operation.executionId);
      insertLegacyRuntimeInvocationLineage(database, {
        intentId: operation.intentId,
        roomId: operation.intent.roomId,
        sourceMessageId: operation.intent.sourceMessageId,
        targetAgentId: operation.intent.targetAgentId,
        requesterActorId: requesterId,
        intentKind: operation.intent.kind,
        executionId: operation.executionId,
        createdAt: occurredAt,
      });
      const execution = runtimeExecutionById(database, operation.executionId);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "queued");
      return { kind: "invocation", execution, replayed: false };
    }

    if (operation.type === "runtime.invoke-routed") {
      const routeIntent = database.prepare(
        `SELECT route.room_id AS roomId, route.source_message_id AS sourceMessageId,
                route.status AS routeStatus, intent.intent_kind AS intentKind,
                source.author_id AS requesterId
         FROM route_jobs AS route
         JOIN route_invocation_intents AS intent ON intent.route_job_id = route.id
         JOIN messages AS source ON source.id = route.source_message_id
         WHERE route.id = ? AND intent.target_agent_id = ?`,
      ).get(operation.routeJobId, operation.intent.targetAgentId);
      if (routeIntent?.roomId !== operation.intent.roomId ||
          routeIntent.sourceMessageId !== operation.intent.sourceMessageId ||
          (routeIntent.routeStatus !== "completed" && routeIntent.routeStatus !== "failed") ||
          routeIntent.intentKind !== operation.intent.kind || typeof routeIntent.requesterId !== "string") {
        return fail("permission_denied", "Routed Agent invocation was not authorized");
      }
      const target = database.prepare(
        `SELECT actor.kind AS actorKind, membership.kind AS membershipKind, room.status AS roomStatus
         FROM room_memberships AS membership
         JOIN actors AS actor ON actor.id = membership.actor_id
         JOIN rooms AS room ON room.id = membership.room_id
         WHERE membership.room_id = ? AND membership.actor_id = ?`,
      ).get(operation.intent.roomId, operation.intent.targetAgentId);
      if (target?.actorKind !== "agent" || target.membershipKind !== "agent" || target.roomStatus !== "active") {
        return fail("permission_denied", "Routed target Agent membership was forbidden");
      }
      const existing = database.prepare(
        `SELECT execution_id AS executionId, intent_kind AS intentKind
         FROM agent_invocation_intents WHERE source_message_id = ? AND target_agent_id = ?`,
      ).get(operation.intent.sourceMessageId, operation.intent.targetAgentId);
      if (typeof existing?.executionId === "string") {
        requireExecutionRuntimeGenerationAllowed(
          database,
          existing.executionId,
          stableId("runtime-routed-replay-gate", operation.executionId),
        );
        if (operation.intent.kind === "direct_mention" && existing.intentKind !== "direct_mention") {
          requireMessageMutationAllowed(
            database,
            operation.intent.roomId,
            "message_intent",
            stableId("routed-intent-upgrade-gate", operation.intentId),
          );
          database.prepare(
            `UPDATE agent_invocation_intents SET intent_kind = 'direct_mention'
             WHERE source_message_id = ? AND target_agent_id = ?`,
          ).run(operation.intent.sourceMessageId, operation.intent.targetAgentId);
        }
        return { kind: "invocation", execution: runtimeExecutionById(database, existing.executionId), replayed: true };
      }
      const queued = database.prepare(
        `SELECT COUNT(*) AS count FROM agent_executions WHERE room_id = ? AND status = 'queued'`,
      ).get(operation.intent.roomId);
      if (typeof queued?.count !== "number" || queued.count >= 32) {
        return fail("agent_queue_full", "Agent room queue was full");
      }
      requireMessageMutationAllowed(
        database,
        operation.intent.roomId,
        "message_intent",
        stableId("routed-intent-gate", operation.intentId),
      );
      const roomArchiveGeneration = currentRoomArchiveGeneration(database, operation.intent.roomId);
      requireRuntimeGenerationAllowed(
        database,
        operation.intent.roomId,
        roomArchiveGeneration,
        stableId("runtime-routed-generation-gate", operation.executionId),
      );
      database.prepare(
        `INSERT INTO agent_executions (
           id, room_id, room_archive_generation, agent_id, trigger_message_id, status, started_at,
           completed_at, result_json, requester_actor_id, tool_name,
           action_category, tool_dispatch_phase, current_attempt_seq,
           retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
           queued_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, 'model.generate',
                   'model_generation', NULL, 1, 1, 1, ?, ?, 0, ?, ?)`,
      ).run(
        operation.executionId,
        operation.intent.roomId,
        roomArchiveGeneration,
        operation.intent.targetAgentId,
        operation.intent.sourceMessageId,
        occurredAt,
        routeIntent.requesterId,
        operation.providerId,
        operation.modelId,
        occurredAt,
        occurredAt,
      );
      database.prepare(
        `INSERT INTO agent_execution_attempts (
           execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
           action_category, started_at, finished_at, error_code, next_retry_at,
           recovery_cursor
         ) VALUES (?, 1, 1, 1, 'queued', 'model_generation', NULL, NULL, NULL, NULL, 0)`,
      ).run(operation.executionId);
      insertLegacyRuntimeInvocationLineage(database, {
        intentId: operation.intentId,
        roomId: operation.intent.roomId,
        sourceMessageId: operation.intent.sourceMessageId,
        targetAgentId: operation.intent.targetAgentId,
        requesterActorId: routeIntent.requesterId,
        intentKind: operation.intent.kind,
        executionId: operation.executionId,
        createdAt: occurredAt,
      });
      const execution = runtimeExecutionById(database, operation.executionId);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "queued");
      return { kind: "invocation", execution, replayed: false };
    }

    if (operation.type === "runtime.claim") {
      const current = runtimeExecutionById(database, operation.executionId);
      if (current.status !== "queued" || current.currentAttemptSeq !== operation.attemptSeq) {
        return fail("execution_conflict", "Agent attempt claim was stale");
      }
      requireExecutionRuntimeGenerationAllowed(
        database,
        current.id,
        stableId("runtime-claim-generation-gate", current.id, String(operation.attemptSeq)),
      );
      if (hasPendingHumanPreemptionAfterSource(database, current)) {
        return fail("execution_conflict", "Agent attempt is behind a durable human fence");
      }
      const updated = database.prepare(
        `UPDATE agent_executions
         SET status = 'running', started_at = ?, updated_at = ?, next_retry_at = NULL
         WHERE id = ? AND current_attempt_seq = ? AND status = 'queued'`,
      ).run(occurredAt, occurredAt, operation.executionId, operation.attemptSeq);
      if (updated.changes !== 1) return fail("execution_conflict", "Agent attempt claim was stale");
      database.prepare(
        `UPDATE agent_execution_attempts SET status = 'running', started_at = ?, next_retry_at = NULL
         WHERE execution_id = ? AND attempt_seq = ? AND status = 'queued'`,
      ).run(occurredAt, operation.executionId, operation.attemptSeq);
      const execution = runtimeExecutionById(database, operation.executionId);
      requireAgentCommandAuthority(database, execution.agentId, execution.roomId);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "started");
      return { kind: "execution", execution };
    }

    if (operation.type === "runtime.complete") {
      const current = runtimeExecutionById(database, operation.executionId);
      requireAgentCommandAuthority(database, current.agentId, current.roomId);
      if (current.status !== "running" || current.currentAttemptSeq !== operation.attemptSeq) {
        return fail("execution_conflict", "Agent completion was stale");
      }
      if ((current.actionCategory === "waiting_upstream" ||
          (current.actionCategory === "tool_call" && current.toolDispatchPhase === "not_started")) &&
          hasPendingHumanPreemptionAfterSource(database, current)) {
        return fail("execution_conflict", "Agent completion is behind a durable human fence");
      }
      requireExecutionRuntimeGenerationAllowed(
        database,
        current.id,
        stableId("runtime-complete-generation-gate", current.id, String(operation.attemptSeq)),
      );
      requireMessageMutationAllowed(
        database,
        current.roomId,
        "message",
        stableId("runtime-complete-message-gate", current.id, String(operation.attemptSeq)),
      );
      const messageEventId = stableId("runtime-message", current.id, String(operation.attemptSeq));
      const message = {
        id: operation.messageId,
        roomId: current.roomId,
        authorId: current.agentId,
        authorKind: "agent" as const,
        body: operation.body,
        sentAt: occurredAt,
      };
      insertLegacyMessageAuthorityRecord(database, message);
      const source = database.prepare(
        `SELECT intent.id AS invocationIntentId,
                intent.source_message_id AS sourceMessageId,
                intent.source_revision AS sourceRevision,
                execution.execution_generation AS executionGeneration
         FROM agent_executions AS execution
         JOIN agent_execution_intent_links AS link
           ON link.execution_id = execution.id
         JOIN agent_invocation_intents AS intent ON intent.id = link.intent_id
         WHERE execution.id = ? AND intent.room_id = execution.room_id
           AND intent.target_agent_id = execution.agent_id
           AND intent.status = 'claimed'`,
      ).get(operation.executionId);
      if (typeof source?.invocationIntentId !== "string" ||
          typeof source.sourceMessageId !== "string" ||
          typeof source.sourceRevision !== "number" ||
          typeof source.executionGeneration !== "number") {
        return fail("execution_conflict", "Agent completion lineage was stale");
      }
      database.prepare(
        `INSERT INTO agent_message_sources (
           message_id, room_id, invocation_intent_id, execution_id, attempt_seq,
           execution_generation, source_message_id, source_revision, committed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        operation.messageId,
        current.roomId,
        source.invocationIntentId,
        operation.executionId,
        operation.attemptSeq,
        source.executionGeneration,
        source.sourceMessageId,
        source.sourceRevision,
        occurredAt,
      );
      const attemptTerminal = database.prepare(
        `UPDATE agent_execution_attempts SET status = 'completed', finished_at = ?
         WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
      ).run(occurredAt, operation.executionId, operation.attemptSeq);
      if (attemptTerminal.changes !== 1) {
        return fail("execution_conflict", "Agent completion attempt CAS was stale");
      }
      const executionTerminal = database.prepare(
        `UPDATE agent_executions
         SET status = 'completed', completed_at = ?, updated_at = ?, result_message_id = ?
         WHERE id = ? AND current_attempt_seq = ? AND execution_generation = ?
           AND status = 'running' AND result_message_id IS NULL`,
      ).run(
        occurredAt,
        occurredAt,
        operation.messageId,
        operation.executionId,
        operation.attemptSeq,
        source.executionGeneration,
      );
      if (executionTerminal.changes !== 1) {
        return fail("execution_conflict", "Agent completion execution CAS was stale");
      }
      const messageSeq = appendRoomEvent(database, {
        eventId: messageEventId,
        roomId: current.roomId,
        actorId: current.agentId,
        eventType: "room.message.accepted",
        occurredAt,
        payload: { id: message.id },
      });
      appendRoomOutbox(database, messageEventId, current.roomId, messageSeq, occurredAt, "runtime", "message");
      enqueueRouteJobForMessage(database, message, occurredAt);
      const execution = runtimeExecutionById(database, operation.executionId);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "completed");
      return { kind: "execution", execution };
    }

    if (operation.type === "runtime.schedule-retry") {
      const current = runtimeExecutionById(database, operation.executionId);
      if (current.status !== "running" || current.currentAttemptSeq !== operation.attemptSeq) {
        return fail("execution_conflict", "Agent retry result was stale");
      }
      requireExecutionRuntimeGenerationAllowed(
        database,
        current.id,
        stableId("runtime-retry-generation-gate", current.id, String(operation.attemptSeq)),
      );
      const shouldRetry = operation.nextRetryAt !== undefined && current.retryOrdinal < 3;
      database.prepare(
        `UPDATE agent_execution_attempts
         SET status = 'failed', finished_at = ?, error_code = ?, next_retry_at = ?
         WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
      ).run(occurredAt, operation.errorCode, operation.nextRetryAt ?? null, current.id, current.currentAttemptSeq);
      if (shouldRetry) {
        const nextAttempt = current.currentAttemptSeq + 1;
        const nextOrdinal = current.retryOrdinal + 1;
        database.prepare(
          `UPDATE agent_executions
           SET status = 'queued', current_attempt_seq = ?, retry_ordinal = ?,
               updated_at = ?, next_retry_at = ?, terminal_error_code = NULL
           WHERE id = ? AND current_attempt_seq = ? AND status = 'running'`,
        ).run(nextAttempt, nextOrdinal, occurredAt, operation.nextRetryAt, current.id, current.currentAttemptSeq);
        database.prepare(
          `INSERT INTO agent_execution_attempts (
             execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
             action_category, started_at, finished_at, error_code, next_retry_at,
             recovery_cursor
           ) VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, ?, ?)`,
        ).run(current.id, nextAttempt, current.retryCycle, nextOrdinal, current.actionCategory, operation.nextRetryAt, current.recoveryCursor);
        const execution = runtimeExecutionById(database, current.id);
        appendRuntimeExecutionEvent(database, execution, occurredAt, "retry-scheduled", operation.errorCode);
        return { kind: "execution", execution };
      }
      database.prepare(
        `UPDATE agent_executions
         SET status = 'failed', completed_at = ?, updated_at = ?,
             terminal_error_code = ?, dead_lettered_at = ?, next_retry_at = NULL
         WHERE id = ? AND current_attempt_seq = ? AND status = 'running'`,
      ).run(occurredAt, occurredAt, operation.errorCode, occurredAt, current.id, current.currentAttemptSeq);
      const execution = runtimeExecutionById(database, current.id);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "dead-lettered", operation.errorCode);
      const ownedItems = database.prepare(
        `SELECT id
         FROM open_items
         WHERE room_id = ? AND current_owner_actor_id = ?
           AND status IN ('awaiting', 'transferred')
           AND (source_execution_id = ? OR source_message_id = ?)
         ORDER BY id`,
      ).all(execution.roomId, execution.agentId, execution.id, execution.sourceMessageId);
      for (const ownedItem of ownedItems) {
        if (typeof ownedItem.id !== "string") {
          return fail("storage_unavailable", "Agent-owned OpenItem linkage was corrupt");
        }
        executeOpenItemAgentFailure(
          database,
          execution.agentId,
          {
            type: "open-item.agent-failure.record",
            roomId: execution.roomId,
            payload: {
              itemId: ownedItem.id,
              executionId: execution.id,
              attemptSeq: operation.attemptSeq,
              reasonCode: operation.errorCode,
            },
          },
          occurredAt,
          "runtime-open-item-failure",
          `${execution.id}:${operation.attemptSeq}:${ownedItem.id}`,
        );
      }
      return { kind: "execution", execution };
    }

    if (operation.type === "runtime.interrupt") {
      const current = runtimeExecutionById(database, operation.executionId);
      requireRuntimeHumanAuthority(database, operation.context, current, operation.now);
      if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
        return { kind: "execution", execution: current };
      }
      database.prepare(
        `UPDATE agent_executions
         SET status = 'cancelled', cancellation_reason = ?, completed_at = ?, updated_at = ?, next_retry_at = NULL
         WHERE id = ? AND current_attempt_seq = ? AND status IN ('queued', 'running')`,
      ).run(operation.reason, occurredAt, occurredAt, current.id, current.currentAttemptSeq);
      database.prepare(
        `UPDATE agent_execution_attempts
         SET status = 'cancelled', finished_at = ?, error_code = ?
         WHERE execution_id = ? AND attempt_seq = ? AND status IN ('queued', 'running')`,
      ).run(occurredAt, operation.reason, current.id, current.currentAttemptSeq);
      const execution = runtimeExecutionById(database, current.id);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "cancelled");
      return { kind: "execution", execution };
    }

    if (operation.type === "runtime.manual-retry") {
      const old = runtimeExecutionById(database, operation.executionId);
      requireRuntimeHumanAuthority(database, operation.context, old, operation.now);
      if (old.status !== "failed" && old.status !== "cancelled") {
        return fail("execution_conflict", "Only terminal Agent executions can be retried");
      }
      const existing = database.prepare(
        `SELECT id FROM agent_executions WHERE manual_retry_of_execution_id = ? ORDER BY queued_at LIMIT 1`,
      ).get(old.id);
      if (typeof existing?.id === "string") {
        requireExecutionRuntimeGenerationAllowed(
          database,
          existing.id,
          stableId("runtime-manual-retry-replay-gate", existing.id),
        );
        return { kind: "invocation", execution: runtimeExecutionById(database, existing.id), replayed: true };
      }
      const roomArchiveGeneration = currentRoomArchiveGeneration(database, old.roomId);
      requireRuntimeGenerationAllowed(
        database,
        old.roomId,
        roomArchiveGeneration,
        stableId("runtime-manual-retry-generation-gate", operation.newExecutionId),
      );
      database.prepare(
        `INSERT INTO agent_executions (
           id, room_id, room_archive_generation, agent_id, trigger_message_id, status, started_at,
           completed_at, result_json, requester_actor_id, tool_name,
           action_category, tool_dispatch_phase, current_attempt_seq,
           retry_cycle, retry_ordinal, provider_id, model_id, recovery_cursor,
           queued_at, updated_at, manual_retry_of_execution_id
         ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, 'model.generate',
                   'model_generation', NULL, 1, 1, 1, ?, ?, 0, ?, ?, ?)`,
      ).run(operation.newExecutionId, old.roomId, roomArchiveGeneration,
        old.agentId, old.sourceMessageId, occurredAt,
        operation.context.principal.actorId, old.providerId ?? "openai-responses", old.modelId ?? "configured", occurredAt, occurredAt, old.id);
      linkDerivedRuntimeExecution(database, {
        sourceExecutionId: old.id,
        derivedExecutionId: operation.newExecutionId,
        linkedAt: occurredAt,
      });
      database.prepare(
        `INSERT INTO agent_execution_attempts (
           execution_id, attempt_seq, retry_cycle, retry_ordinal, status, action_category, recovery_cursor
         ) VALUES (?, 1, 1, 1, 'queued', 'model_generation', 0)`,
      ).run(operation.newExecutionId);
      const execution = runtimeExecutionById(database, operation.newExecutionId);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "manual-retry-queued");
      return { kind: "invocation", execution, replayed: false };
    }

    if (operation.type === "runtime.begin-compensation") {
      const old = runtimeExecutionById(database, operation.executionId);
      const humanId = requireHumanSession(database, operation.context, operation.now);
      if (old.status !== "completed") {
        return fail("execution_conflict", "Only completed side effects can be compensated");
      }
      const authority = database.prepare(
        `SELECT membership.role, room.status AS roomStatus,
                room.owner_actor_id = membership.actor_id AS isOwner,
                confirmation.human_principal_id AS confirmationPrincipalId,
                dispatch.dispatch_id AS oldDispatchId, dispatch.tool_id AS toolId,
                dispatch.parameter_sha256 AS parameterSha256,
                dispatch.sealed_compensation AS sealedCompensation,
                actor.tool_permissions_json AS capabilityJson,
                agent_membership.tool_permissions_json AS membershipJson,
                agent_membership.participation AS participation
         FROM room_memberships AS membership
         JOIN rooms AS room ON room.id = membership.room_id
         JOIN tool_dispatches AS dispatch
           ON dispatch.execution_id = ? AND dispatch.state = 'succeeded'
         JOIN tool_confirmations AS confirmation
           ON confirmation.execution_id = dispatch.execution_id
          AND confirmation.attempt_seq = dispatch.attempt_seq
         JOIN actors AS actor ON actor.id = ? AND actor.kind = 'agent'
         JOIN room_memberships AS agent_membership
           ON agent_membership.room_id = room.id AND agent_membership.actor_id = actor.id
         WHERE membership.room_id = ? AND membership.actor_id = ? AND membership.kind = 'human'
         ORDER BY dispatch.dispatched_at DESC LIMIT 1`,
      ).get(old.id, old.agentId, old.roomId, humanId);
      const capabilities = typeof authority?.capabilityJson === "string"
        ? JSON.parse(authority.capabilityJson) as unknown : [];
      const membershipPermissions = typeof authority?.membershipJson === "string"
        ? JSON.parse(authority.membershipJson) as unknown : [];
      if (authority?.roomStatus !== "active" ||
          (authority.confirmationPrincipalId !== humanId && authority.isOwner !== 1 && authority.role !== "admin") ||
          authority.toolId !== "sandbox-file.write" || typeof authority.parameterSha256 !== "string" ||
          typeof authority.sealedCompensation !== "string" || authority.participation !== "active" ||
          !Array.isArray(capabilities) || !capabilities.includes(authority.toolId) ||
          !Array.isArray(membershipPermissions) || !membershipPermissions.includes(authority.toolId)) {
        return fail("permission_denied", "Compensation authority was forbidden");
      }
      const existing = database.prepare(
        `SELECT id FROM agent_executions WHERE compensates_execution_id = ? ORDER BY queued_at LIMIT 1`,
      ).get(old.id);
      if (typeof existing?.id === "string") {
        requireExecutionRuntimeGenerationAllowed(
          database,
          existing.id,
          stableId("runtime-compensation-replay-gate", existing.id),
        );
        const execution = runtimeExecutionById(database, existing.id);
        const dispatch = database.prepare(
          `SELECT dispatch_id AS dispatchId FROM tool_dispatches WHERE execution_id = ?`,
        ).get(execution.id);
        if (typeof dispatch?.dispatchId !== "string") {
          return fail("storage_unavailable", "Compensation dispatch was corrupt");
        }
        return {
          kind: "compensation",
          execution,
          dispatchId: dispatch.dispatchId,
          toolId: "sandbox-file.write",
          sealedCompensation: authority.sealedCompensation,
          replayed: true,
        };
      }
      const roomArchiveGeneration = currentRoomArchiveGeneration(database, old.roomId);
      requireRuntimeGenerationAllowed(
        database,
        old.roomId,
        roomArchiveGeneration,
        stableId("runtime-compensation-generation-gate", operation.newExecutionId),
      );
      database.prepare(
        `INSERT INTO agent_executions (
           id, room_id, room_archive_generation, agent_id, trigger_message_id, status, started_at,
           requester_actor_id, tool_name, action_category, tool_dispatch_phase,
           current_attempt_seq, retry_cycle, retry_ordinal, recovery_cursor,
           queued_at, updated_at, compensates_execution_id
         ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, 'sandbox-file.write', 'tool_call',
                   'dispatched', 1, 1, 1, 0, ?, ?, ?)`,
      ).run(operation.newExecutionId, old.roomId, roomArchiveGeneration,
        old.agentId, old.sourceMessageId,
        occurredAt, humanId, occurredAt, occurredAt, old.id);
      linkDerivedRuntimeExecution(database, {
        sourceExecutionId: old.id,
        derivedExecutionId: operation.newExecutionId,
        linkedAt: occurredAt,
      });
      database.prepare(
        `INSERT INTO agent_execution_attempts (
           execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
           action_category, started_at, recovery_cursor
         ) VALUES (?, 1, 1, 1, 'running', 'tool_call', ?, 0)`,
      ).run(operation.newExecutionId, occurredAt);
      database.prepare(
        `INSERT INTO agent_execution_grants (
           grant_id, execution_id, attempt_seq, agent_id, room_id, tool_id,
           parameter_sha256, issued_at, expires_at, consumed_at,
           grant_state, grant_revision, grant_changed_at
         ) VALUES (?, ?, 1, ?, ?, 'sandbox-file.write', ?, ?, ?, ?, 'claimed', 1, ?)`,
      ).run(operation.grantId, operation.newExecutionId, old.agentId, old.roomId,
        authority.parameterSha256, occurredAt, occurredAt, occurredAt, occurredAt);
      database.prepare(
        `INSERT INTO tool_dispatches (
           dispatch_id, execution_id, attempt_seq, grant_id, tool_id,
           parameter_sha256, state, dispatched_at
         ) VALUES (?, ?, 1, ?, 'sandbox-file.write', ?, 'dispatched', ?)`,
      ).run(operation.dispatchId, operation.newExecutionId, operation.grantId,
        authority.parameterSha256, occurredAt);
      const execution = runtimeExecutionById(database, operation.newExecutionId);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "started");
      return {
        kind: "compensation",
        execution,
        dispatchId: operation.dispatchId,
        toolId: "sandbox-file.write",
        sealedCompensation: authority.sealedCompensation,
        replayed: false,
      };
    }

    if (operation.type === "runtime.read-pending-confirmation") {
      const current = runtimeExecutionById(database, operation.executionId);
      if (current.status !== "running" || current.actionCategory !== "waiting_upstream") {
        return fail("execution_conflict", "Confirmation targeted a stale Agent execution");
      }
      const pending = database.prepare(
        `SELECT confirmation.expires_at AS expiresAt,
                confirmation.consumed_at AS consumedAt,
                confirmation.confirmation_state AS confirmationState,
                grant.grant_id AS grantId,
                grant.grant_state AS grantState,
                grant.tool_id AS toolId,
                step.tool_call_json AS toolCallJson
         FROM tool_confirmations AS confirmation
         JOIN agent_execution_grants AS grant
           ON grant.execution_id = confirmation.execution_id
          AND grant.attempt_seq = confirmation.attempt_seq
          AND grant.tool_id = confirmation.tool_id
          AND grant.parameter_sha256 = confirmation.parameter_sha256
         JOIN agent_execution_steps AS step
           ON step.execution_id = confirmation.execution_id
          AND step.attempt_seq = confirmation.attempt_seq
          AND step.step_kind = 'tool'
         WHERE confirmation.confirmation_id = ?
           AND confirmation.execution_id = ?
           AND confirmation.confirmation_state = 'pending'
           AND grant.grant_state = 'active'
         ORDER BY step.step_seq DESC LIMIT 1`,
      ).get(operation.confirmationId, current.id);
      if (pending === undefined || pending.consumedAt !== null ||
          pending.confirmationState !== "pending" || pending.grantState !== "active" ||
          typeof pending.expiresAt !== "string" || Date.parse(pending.expiresAt) <= operation.now ||
          typeof pending.grantId !== "string" || typeof pending.toolId !== "string" ||
          typeof pending.toolCallJson !== "string") {
        return fail("confirmation_expired", "Pending tool confirmation was unavailable");
      }
      let toolCall: unknown;
      try {
        toolCall = JSON.parse(pending.toolCallJson) as unknown;
      } catch {
        return fail("storage_unavailable", "Pending tool confirmation was corrupt");
      }
      if (!isRecord(toolCall) || typeof toolCall.callId !== "string" ||
          typeof toolCall.argumentsJson !== "string" || !isRecord(toolCall.parameters)) {
        return fail("storage_unavailable", "Pending tool confirmation was corrupt");
      }
      return {
        kind: "pending-confirmation",
        execution: current,
        grantId: pending.grantId,
        toolId: pending.toolId as "http-json.read" | "repository.git-status" | "sandbox-file.write",
        parameters: toolCall.parameters,
        callId: toolCall.callId,
        argumentsJson: toolCall.argumentsJson,
      };
    }

    if (operation.type === "runtime.prepare-tool") {
      const current = runtimeExecutionById(database, operation.executionId);
      if (current.status !== "running" || current.currentAttemptSeq !== operation.attemptSeq) {
        return fail("execution_conflict", "Tool preparation targeted a stale Agent attempt");
      }
      requireExecutionRuntimeGenerationAllowed(
        database,
        current.id,
        stableId("runtime-tool-prepare-generation-gate", current.id, String(operation.attemptSeq)),
      );
      const permissions = database.prepare(
        `SELECT actor.kind AS actorKind, actor.readiness AS readiness,
                actor.tool_permissions_json AS capabilityJson,
                membership.kind AS membershipKind,
                membership.participation AS participation,
                membership.tool_permissions_json AS membershipPermissionsJson,
                room.status AS roomStatus
         FROM actors AS actor
         JOIN room_memberships AS membership ON membership.actor_id = actor.id
         JOIN rooms AS room ON room.id = membership.room_id
         WHERE actor.id = ? AND membership.room_id = ?`,
      ).get(current.agentId, current.roomId);
      const capability = typeof permissions?.capabilityJson === "string"
        ? JSON.parse(permissions.capabilityJson) as unknown : undefined;
      const membershipPermissions = typeof permissions?.membershipPermissionsJson === "string"
        ? JSON.parse(permissions.membershipPermissionsJson) as unknown : undefined;
      if (permissions?.actorKind !== "agent" || permissions.readiness !== "ready" ||
          permissions.membershipKind !== "agent" || permissions.participation !== "active" ||
          permissions.roomStatus !== "active" || !Array.isArray(capability) ||
          !capability.includes(operation.tool.id) || !Array.isArray(membershipPermissions) ||
          !membershipPermissions.includes(operation.tool.id)) {
        return fail("permission_denied", "Agent tool authority was forbidden");
      }
      const parameterSha256 = createHash("sha256").update(canonicalJson(operation.parameters)).digest("hex");
      if (operation.tool.effect === "side-effecting" &&
          (operation.confirmationId === undefined || operation.confirmationContext === undefined)) {
        return fail("confirmation_forbidden", "Side-effecting tool confirmation was required");
      }
      database.prepare(
        `INSERT INTO agent_execution_grants (
           grant_id, execution_id, attempt_seq, agent_id, room_id, tool_id,
           parameter_sha256, issued_at, expires_at, grant_state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      ).run(operation.grantId, current.id, current.currentAttemptSeq, current.agentId,
        current.roomId, operation.tool.id, parameterSha256, occurredAt, operation.expiresAt);
      if (operation.tool.effect === "side-effecting") {
        const confirmationContext = operation.confirmationContext;
        const confirmationId = operation.confirmationId;
        if (confirmationContext === undefined || confirmationId === undefined) {
          return fail("confirmation_forbidden", "Side-effecting tool confirmation was required");
        }
        const humanId = requireHumanSession(database, confirmationContext, operation.now);
        const humanMembership = database.prepare(
          `SELECT 1 AS present FROM room_memberships
           WHERE room_id = ? AND actor_id = ? AND kind = 'human'`,
        ).get(current.roomId, humanId);
        if (humanMembership?.present !== 1) {
          return fail("confirmation_forbidden", "Tool confirmation principal was forbidden");
        }
        database.prepare(
          `INSERT INTO tool_confirmations (
             confirmation_id, execution_id, attempt_seq, tool_id, parameter_sha256,
             room_id, human_principal_id, session_family_id, expires_at,
             target, impact, reversibility, confirmation_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).run(confirmationId, current.id, current.currentAttemptSeq, operation.tool.id,
          parameterSha256, current.roomId, humanId, confirmationContext.sessionFamilyId,
          operation.expiresAt, operation.tool.id, "bounded-side-effect", operation.tool.reversibility);
        if (operation.providerCall !== undefined) {
          database.prepare(
            `INSERT INTO agent_execution_steps (
               execution_id, attempt_seq, step_seq, step_kind, tool_call_json,
               input_sha256, output_sha256, completed_at
             ) VALUES (?, ?, ?, 'tool', ?, ?, ?, ?)`,
          ).run(
            current.id,
            current.currentAttemptSeq,
            current.recoveryCursor + 1,
            canonicalJson({
              callId: operation.providerCall.callId,
              argumentsJson: operation.providerCall.argumentsJson,
              parameters: operation.parameters,
            }),
            parameterSha256,
            parameterSha256,
            occurredAt,
          );
        }
      }
      database.prepare(
        `UPDATE agent_executions
         SET action_category = ?, tool_name = ?, tool_dispatch_phase = ?, updated_at = ?
         WHERE id = ? AND current_attempt_seq = ? AND status = 'running'`,
      ).run(
        operation.tool.effect === "side-effecting" ? "waiting_upstream" : "tool_call",
        operation.tool.id,
        operation.tool.effect === "side-effecting" ? null : "not_started",
        occurredAt,
        current.id,
        current.currentAttemptSeq,
      );
      database.prepare(
        `UPDATE agent_execution_attempts SET action_category = ?
         WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
      ).run(operation.tool.effect === "side-effecting" ? "waiting_upstream" : "tool_call",
        current.id, current.currentAttemptSeq);
      const execution = runtimeExecutionById(database, current.id);
      appendRuntimeExecutionEvent(database, execution, occurredAt, "tool-prepared");
      if (operation.confirmationId !== undefined) {
        const confirmationEventId = stableId(
          "runtime-confirmation",
          execution.id,
          String(execution.currentAttemptSeq),
          operation.confirmationId,
        );
        const confirmationSeq = appendRoomEvent(database, {
          eventId: confirmationEventId,
          roomId: execution.roomId,
          actorId: execution.agentId,
          eventType: "agent.tool.confirmation-required",
          occurredAt,
          payload: {
            confirmationId: operation.confirmationId,
            executionId: execution.id,
            attemptSeq: execution.currentAttemptSeq,
            toolId: operation.tool.id,
            target: operation.tool.id,
            impact: "bounded-side-effect",
            reversibility: operation.tool.reversibility,
            expiresAt: operation.expiresAt,
          },
        });
        appendRoomOutbox(
          database,
          confirmationEventId,
          execution.roomId,
          confirmationSeq,
          occurredAt,
          "runtime-confirmation",
          operation.confirmationId,
        );
      }
      return {
        kind: "prepared-tool",
        execution,
        grantId: operation.grantId,
        ...(operation.confirmationId === undefined ? {} : {
          confirmationId: operation.confirmationId,
          target: operation.tool.id,
          impact: "bounded-side-effect",
          reversibility: operation.tool.reversibility,
        }),
      };
    }

    if (operation.type === "runtime.claim-tool") {
      const current = runtimeExecutionById(database, operation.executionId);
      if (current.status !== "running" || current.currentAttemptSeq !== operation.attemptSeq ||
          !((current.actionCategory === "tool_call" && current.toolDispatchPhase === "not_started") ||
            current.actionCategory === "waiting_upstream")) {
        return fail("execution_conflict", "Tool claim targeted a stale Agent attempt");
      }
      requireExecutionRuntimeGenerationAllowed(
        database,
        current.id,
        stableId("runtime-tool-dispatch-generation-gate", current.id, String(operation.attemptSeq)),
      );
      const grant = database.prepare(
        `SELECT grant.agent_id AS agentId, grant.room_id AS roomId, grant.tool_id AS toolId,
                grant.parameter_sha256 AS parameterSha256, grant.expires_at AS expiresAt,
                grant.consumed_at AS consumedAt, grant.grant_state AS grantState,
                actor.kind AS actorKind, actor.readiness AS readiness,
                actor.tool_permissions_json AS capabilityJson,
                membership.kind AS membershipKind,
                membership.participation AS participation,
                membership.tool_permissions_json AS membershipPermissionsJson,
                room.status AS roomStatus
         FROM agent_execution_grants AS grant
         JOIN actors AS actor ON actor.id = grant.agent_id
         JOIN room_memberships AS membership
           ON membership.room_id = grant.room_id AND membership.actor_id = grant.agent_id
         JOIN rooms AS room ON room.id = grant.room_id
         WHERE grant.grant_id = ? AND grant.execution_id = ? AND grant.attempt_seq = ?`,
      ).get(operation.grantId, current.id, current.currentAttemptSeq);
      const parameterSha256 = createHash("sha256").update(canonicalJson(operation.parameters)).digest("hex");
      const capability = typeof grant?.capabilityJson === "string"
        ? JSON.parse(grant.capabilityJson) as unknown : undefined;
      const membershipPermissions = typeof grant?.membershipPermissionsJson === "string"
        ? JSON.parse(grant.membershipPermissionsJson) as unknown : undefined;
      if (grant?.agentId !== current.agentId || grant.roomId !== current.roomId ||
          typeof grant.toolId !== "string" || grant.parameterSha256 !== parameterSha256 ||
          typeof grant.expiresAt !== "string" || Date.parse(grant.expiresAt) <= operation.now ||
          grant.consumedAt !== null || grant.grantState !== "active" ||
          grant.actorKind !== "agent" || grant.readiness !== "ready" ||
          grant.membershipKind !== "agent" || grant.participation !== "active" || grant.roomStatus !== "active" ||
          !Array.isArray(capability) || !capability.includes(grant.toolId) ||
          !Array.isArray(membershipPermissions) || !membershipPermissions.includes(grant.toolId)) {
        return fail("permission_denied", "Tool dispatch authority was forbidden");
      }
      if (grant.toolId === "sandbox-file.write") {
        if (current.actionCategory !== "waiting_upstream") {
          return fail("confirmation_forbidden", "Side-effecting tool was not waiting for confirmation");
        }
        if (operation.confirmation === undefined || operation.confirmation.input.executionId !== current.id) {
          return fail("confirmation_forbidden", "Tool confirmation was missing or mismatched");
        }
        const principalId = requireHumanSession(database, operation.confirmation.context, operation.now);
        const confirmation = database.prepare(
          `SELECT execution_id AS executionId, attempt_seq AS attemptSeq, tool_id AS toolId,
                  parameter_sha256 AS parameterSha256, room_id AS roomId,
                  human_principal_id AS principalId, session_family_id AS sessionFamilyId,
                  expires_at AS expiresAt, consumed_at AS consumedAt,
                  confirmation_state AS confirmationState
           FROM tool_confirmations WHERE confirmation_id = ?`,
        ).get(operation.confirmation.input.confirmationId);
        if (confirmation === undefined) return fail("confirmation_forbidden", "Tool confirmation was not found");
        if (confirmation.consumedAt !== null || confirmation.confirmationState !== "pending") {
          return fail("confirmation_replayed", "Tool confirmation was already consumed");
        }
        if (typeof confirmation.expiresAt !== "string" || Date.parse(confirmation.expiresAt) <= operation.now) {
          return fail("confirmation_expired", "Tool confirmation expired");
        }
        if (confirmation.executionId !== current.id || confirmation.attemptSeq !== current.currentAttemptSeq ||
            confirmation.toolId !== grant.toolId || confirmation.parameterSha256 !== parameterSha256 ||
            confirmation.roomId !== current.roomId || confirmation.principalId !== principalId ||
            confirmation.sessionFamilyId !== operation.confirmation.context.sessionFamilyId) {
          return fail("confirmation_forbidden", "Tool confirmation binding was forbidden");
        }
        const consumed = database.prepare(
          `UPDATE tool_confirmations
           SET confirmation_state = 'confirmed', consumed_at = ?,
               confirmation_revision = confirmation_revision + 1,
               confirmation_changed_at = ?
           WHERE confirmation_id = ?
             AND confirmation_state = 'pending' AND consumed_at IS NULL`,
        ).run(occurredAt, occurredAt, operation.confirmation.input.confirmationId);
        if (consumed.changes !== 1) return fail("confirmation_replayed", "Tool confirmation was already consumed");
      } else if (operation.confirmation !== undefined) {
        return fail("confirmation_forbidden", "Read-only tool did not accept confirmation");
      }
      const consumedGrant = database.prepare(
        `UPDATE agent_execution_grants
         SET grant_state = 'claimed', consumed_at = ?,
             grant_revision = grant_revision + 1, grant_changed_at = ?
         WHERE grant_id = ? AND grant_state = 'active' AND consumed_at IS NULL`,
      ).run(occurredAt, occurredAt, operation.grantId);
      if (consumedGrant.changes !== 1) return fail("execution_conflict", "Tool grant was already consumed");
      database.prepare(
        `INSERT INTO tool_dispatches (
           dispatch_id, execution_id, attempt_seq, grant_id, tool_id,
           parameter_sha256, state, dispatched_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'dispatched', ?)`,
      ).run(operation.dispatchId, current.id, current.currentAttemptSeq, operation.grantId,
        grant.toolId, parameterSha256, occurredAt);
      database.prepare(
        `UPDATE agent_executions
         SET action_category = 'tool_call', tool_dispatch_phase = 'dispatched', updated_at = ?
         WHERE id = ? AND current_attempt_seq = ? AND status = 'running'`,
      ).run(occurredAt, current.id, current.currentAttemptSeq);
      return {
        kind: "claimed-tool",
        dispatchId: operation.dispatchId,
        toolId: grant.toolId as "http-json.read" | "repository.git-status" | "sandbox-file.write",
        parameters: operation.parameters,
      };
    }

    if (operation.type === "runtime.settle-tool") {
      const dispatch = database.prepare(
        `SELECT execution_id AS executionId, attempt_seq AS attemptSeq, state
         FROM tool_dispatches WHERE dispatch_id = ?`,
      ).get(operation.dispatchId);
      if (dispatch?.state !== "dispatched" || typeof dispatch.executionId !== "string" ||
          typeof dispatch.attemptSeq !== "number") {
        return fail("execution_conflict", "Tool dispatch settlement was stale");
      }
      database.prepare(
        `UPDATE tool_dispatches
         SET state = ?, settled_at = ?, closed_summary_json = ?, sealed_compensation = ?
         WHERE dispatch_id = ? AND state = 'dispatched'`,
      ).run(operation.state, occurredAt, canonicalJson(operation.summary),
        operation.sealedCompensation ?? null, operation.dispatchId);
      database.prepare(
        `UPDATE agent_executions SET tool_dispatch_phase = 'finished', updated_at = ?
         WHERE id = ? AND current_attempt_seq = ? AND status = 'running'`,
      ).run(occurredAt, dispatch.executionId, dispatch.attemptSeq);
      return { kind: "settled-tool" };
    }

    if (operation.type === "runtime.checkpoint") {
      const current = runtimeExecutionById(database, operation.executionId);
      if (current.status !== "running" || current.currentAttemptSeq !== operation.attemptSeq) {
        return fail("execution_conflict", "Checkpoint targeted a stale Agent attempt");
      }
      requireExecutionRuntimeGenerationAllowed(
        database,
        current.id,
        stableId("runtime-checkpoint-generation-gate", current.id, String(operation.attemptSeq)),
      );
      database.prepare(
        `INSERT INTO agent_execution_steps (
           execution_id, attempt_seq, step_seq, step_kind, input_sha256,
           output_sha256, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(execution_id, attempt_seq, step_seq) DO UPDATE SET
           step_kind = excluded.step_kind,
           input_sha256 = excluded.input_sha256,
           output_sha256 = excluded.output_sha256,
           completed_at = excluded.completed_at`,
      ).run(current.id, current.currentAttemptSeq, operation.stepSeq, operation.kind,
        operation.inputSha256, operation.outputSha256, occurredAt);
      database.prepare(
        `UPDATE agent_execution_attempts SET recovery_cursor = ?
         WHERE execution_id = ? AND attempt_seq = ? AND recovery_cursor < ?`,
      ).run(operation.stepSeq, current.id, current.currentAttemptSeq, operation.stepSeq);
      database.prepare(
        `UPDATE agent_executions SET recovery_cursor = ?, updated_at = ?
         WHERE id = ? AND current_attempt_seq = ? AND recovery_cursor < ?`,
      ).run(operation.stepSeq, occurredAt, current.id, current.currentAttemptSeq, operation.stepSeq);
      return { kind: "checkpoint" };
    }

    const recoverable = database.prepare(
      `SELECT execution.id
       FROM agent_executions AS execution
       JOIN rooms AS room ON room.id = execution.room_id
       WHERE execution.status IN ('queued', 'running')
         AND room.status = 'active'
         AND execution.room_archive_generation = room.archive_generation
       ORDER BY execution.queued_at, execution.id`,
    ).all();
    const records: { execution: AgentExecution; outcome: "enqueue" | "failed" | "fail_outcome_unknown" | "wait_confirmation" }[] = [];
    for (const row of recoverable) {
      if (typeof row.id !== "string") return fail("storage_unavailable", "Recovery execution was corrupt");
      let current = runtimeExecutionById(database, row.id);
      if (current.status === "running") {
        if (current.providerId === undefined) {
          database.prepare(
            `UPDATE agent_execution_attempts
             SET status = 'failed', finished_at = ?, error_code = 'side_effect_outcome_unknown'
             WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
          ).run(occurredAt, current.id, current.currentAttemptSeq);
          database.prepare(
            `UPDATE agent_executions
             SET status = 'failed', completed_at = ?, updated_at = ?,
                 terminal_error_code = 'side_effect_outcome_unknown', dead_lettered_at = ?
             WHERE id = ? AND current_attempt_seq = ? AND status = 'running'`,
          ).run(occurredAt, occurredAt, occurredAt, current.id, current.currentAttemptSeq);
          current = runtimeExecutionById(database, current.id);
          appendRuntimeExecutionEvent(database, current, occurredAt, "recovered", "side_effect_outcome_unknown");
          records.push({ execution: current, outcome: "fail_outcome_unknown" });
          continue;
        }
        if (current.actionCategory === "waiting_upstream") {
          const confirmation = database.prepare(
            `SELECT expires_at AS expiresAt FROM tool_confirmations
             WHERE execution_id = ? AND attempt_seq = ?
               AND confirmation_state = 'pending' AND consumed_at IS NULL
             ORDER BY expires_at DESC LIMIT 1`,
          ).get(current.id, current.currentAttemptSeq);
          if (typeof confirmation?.expiresAt === "string" && Date.parse(confirmation.expiresAt) > operation.now) {
            records.push({ execution: current, outcome: "wait_confirmation" });
            continue;
          }
          database.prepare(
            `UPDATE agent_execution_attempts
             SET status = 'failed', finished_at = ?, error_code = 'confirmation_expired'
             WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
          ).run(occurredAt, current.id, current.currentAttemptSeq);
          database.prepare(
            `UPDATE agent_executions
             SET status = 'failed', completed_at = ?, updated_at = ?,
                 terminal_error_code = 'confirmation_expired', dead_lettered_at = ?
             WHERE id = ? AND current_attempt_seq = ? AND status = 'running'`,
          ).run(occurredAt, occurredAt, occurredAt, current.id, current.currentAttemptSeq);
          current = runtimeExecutionById(database, current.id);
          appendRuntimeExecutionEvent(database, current, occurredAt, "recovered", "confirmation_expired");
          records.push({ execution: current, outcome: "failed" });
          continue;
        }
        const latestDispatch = database.prepare(
          `SELECT tool_id AS toolId, state
           FROM tool_dispatches
           WHERE execution_id = ? AND attempt_seq = ?
           ORDER BY rowid DESC LIMIT 1`,
        ).get(current.id, current.currentAttemptSeq);
        const sideEffectMayHaveOccurred = latestDispatch?.toolId === "sandbox-file.write" &&
          (latestDispatch.state === "dispatched" ||
           latestDispatch.state === "succeeded" ||
           latestDispatch.state === "outcome_unknown");
        if (current.actionCategory === "tool_call" &&
            (current.toolDispatchPhase === "dispatched" || sideEffectMayHaveOccurred)) {
          database.prepare(
            `UPDATE tool_dispatches SET state = 'outcome_unknown', settled_at = ?
             WHERE execution_id = ? AND attempt_seq = ? AND state IN ('dispatched', 'succeeded')`,
          ).run(occurredAt, current.id, current.currentAttemptSeq);
          database.prepare(
            `UPDATE agent_execution_attempts SET status = 'failed', finished_at = ?, error_code = 'side_effect_outcome_unknown'
             WHERE execution_id = ? AND attempt_seq = ?`,
          ).run(occurredAt, current.id, current.currentAttemptSeq);
          database.prepare(
            `UPDATE agent_executions SET status = 'failed', completed_at = ?, updated_at = ?,
                    terminal_error_code = 'side_effect_outcome_unknown', dead_lettered_at = ?
             WHERE id = ?`,
          ).run(occurredAt, occurredAt, occurredAt, current.id);
          current = runtimeExecutionById(database, current.id);
          appendRuntimeExecutionEvent(database, current, occurredAt, "recovered", "side_effect_outcome_unknown");
          records.push({ execution: current, outcome: "fail_outcome_unknown" });
          continue;
        }
        const nextAttempt = current.currentAttemptSeq + 1;
        if (current.retryOrdinal >= 3) {
          database.prepare(
            `UPDATE agent_executions SET status = 'failed', completed_at = ?, updated_at = ?,
                    terminal_error_code = 'runtime_restarted', dead_lettered_at = ? WHERE id = ?`,
          ).run(occurredAt, occurredAt, occurredAt, current.id);
          current = runtimeExecutionById(database, current.id);
          appendRuntimeExecutionEvent(database, current, occurredAt, "recovered", "runtime_restarted");
          records.push({ execution: current, outcome: "fail_outcome_unknown" });
          continue;
        }
        database.prepare(
          `UPDATE agent_execution_attempts SET status = 'failed', finished_at = ?, error_code = 'runtime_restarted'
           WHERE execution_id = ? AND attempt_seq = ?`,
        ).run(occurredAt, current.id, current.currentAttemptSeq);
        database.prepare(
          `UPDATE agent_executions SET status = 'queued', current_attempt_seq = ?, retry_ordinal = retry_ordinal + 1,
                  updated_at = ?, next_retry_at = ? WHERE id = ?`,
        ).run(nextAttempt, occurredAt, occurredAt, current.id);
        database.prepare(
          `INSERT INTO agent_execution_attempts (
             execution_id, attempt_seq, retry_cycle, retry_ordinal, status, action_category, next_retry_at, recovery_cursor
           ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        ).run(current.id, nextAttempt, current.retryCycle, current.retryOrdinal + 1, current.actionCategory, occurredAt, current.recoveryCursor);
        current = runtimeExecutionById(database, current.id);
        appendRuntimeExecutionEvent(database, current, occurredAt, "recovered", "runtime_restarted");
      }
      records.push({ execution: current, outcome: current.actionCategory === "waiting_upstream" ? "wait_confirmation" : "enqueue" });
    }
    return { kind: "recovery", records };
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
          : input.command.type === "open-item.propose"
            ? executeOpenItemProposal(database, agentId, input.command, acceptedAt, scope, key)
            : input.command.type === "open-item.transition"
              ? executeOpenItemTransition(database, agentId, input.command, acceptedAt, scope, key)
              : input.command.type === "open-item.agent-failure.record"
                ? executeOpenItemAgentFailure(database, agentId, input.command, acceptedAt, scope, key)
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
  let afterCommitRescan: ReopenAfterCommitRescan | undefined;
  const result = runAuthorityImmediateTransaction(database, () => {
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
        recheckHumanCommandAuthority(database, actorId, input.command);
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
              : input.command.type === "light-task.create"
                ? executeLightTaskCreate(database, actorId, input.command, acceptedAt, scope, key)
                : input.command.type === "light-task.transition"
                  ? executeLightTaskTransition(database, actorId, input.command, acceptedAt, scope, key)
                  : input.command.type === "light-task.criterion.set"
                    ? executeLightTaskCriterionSet(database, actorId, input.command, acceptedAt, scope, key)
              : input.command.type === "calibration.record"
                ? executeCalibrationRecord(database, actorId, input.command, acceptedAt, scope, key)
            : input.command.type === "room.create"
              ? executeRoomCreate(database, actorId, input.command, acceptedAt, scope, key)
              : input.command.type === "room.rename"
                ? executeRenameOrArchive(database, actorId, input.command, acceptedAt, scope, key)
                : input.command.type === "room.archive" || input.command.type === "room.reopen"
                  ? executeClosedLifecycle(
                      database,
                      actorId,
                      input.command,
                      acceptedAt,
                      scope,
                      key,
                      input.participantComposition,
                      (rescan) => { afterCommitRescan = rescan; },
                      input.afterDomainWrite,
                    )
                : input.command.type === "room.ownership.transfer"
                  ? executeOwnershipTransfer(database, actorId, input.command, acceptedAt, scope, key)
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
                      : input.command.type === "room.member.role.set"
                        ? executeHumanRoleChange(database, actorId, input.command, acceptedAt, scope, key)
                        : input.command.type === "room.member.leave" ||
                            input.command.type === "room.member.remove"
                          ? executeClosedDeparture(
                              database,
                              actorId,
                              input.command,
                              acceptedAt,
                              scope,
                              key,
                              input.participantComposition,
                              input.afterDomainWrite,
                            )
                        : input.command.type === "human.role.change"
                          ? fail("dependency_unavailable", "Legacy or dependency-bound governance path is unavailable")
                        : input.command.type === "member.remove"
                          ? executeMemberRemove(database, actorId, input.command)
                          : unreachableCommand(input.command);
      },
    });
  }, input.beforeCommit);
  return afterCommitRescan === undefined || result.disposition !== "applied"
    ? result
    : { ...result, afterCommitRescan };
}

const MESSAGE_AUTHORITY_DEFAULT_PAGE = 50;
const MESSAGE_AUTHORITY_MAX_PAGE = 200;

type StoredMessageAuthorityReceipt =
  | HumanMessageSubmissionReceipt
  | MessageRevisionReceipt
  | MessageRecallReceipt
  | AgentMessageCommitReceipt;

function authorityExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function messageAuthorityHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

function isMutationReceiptBase(value: unknown): value is {
  readonly messageId: string;
  readonly persistedAt: string;
  readonly eventId: string;
  readonly replayed: boolean;
} {
  return isRecord(value) && typeof value.messageId === "string" && value.messageId.length > 0 &&
    typeof value.persistedAt === "string" && value.persistedAt.length > 0 &&
    typeof value.eventId === "string" && value.eventId.length > 0 &&
    typeof value.replayed === "boolean";
}

function isMessageRecallExecutionCancellation(
  value: unknown,
): value is MessageRecallExecutionCancellation {
  return isRecord(value) && authorityExactKeys(value, [
    "sourceMessageId", "sourceRevision", "invocationIntentId", "executionId",
    "attemptSeq", "cancellationReason", "sideEffectState",
  ]) && typeof value.sourceMessageId === "string" && value.sourceMessageId.length > 0 &&
    Number.isSafeInteger(value.sourceRevision) && Number(value.sourceRevision) > 0 &&
    typeof value.invocationIntentId === "string" && value.invocationIntentId.length > 0 &&
    typeof value.executionId === "string" && value.executionId.length > 0 &&
    Number.isSafeInteger(value.attemptSeq) && Number(value.attemptSeq) > 0 &&
    value.cancellationReason === "message_recalled" &&
    (value.sideEffectState === "none" || value.sideEffectState === "dispatched-retained" ||
      value.sideEffectState === "outcome-unknown-retained");
}

function parseStoredMessageAuthorityReceipt(
  value: string,
  kind: "submit" | "revise" | "recall" | "agent",
): StoredMessageAuthorityReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return fail("storage_unavailable", "Stored message authority receipt is corrupt");
  }
  if (!isRecord(parsed)) {
    return fail("storage_unavailable", "Stored message authority receipt is corrupt");
  }
  const record = parsed as Record<string, unknown>;
  const field = (key: string): unknown => (parsed as Record<string, unknown>)[key];
  if (kind === "submit" && authorityExactKeys(record, [
    "messageId", "persistedAt", "eventId", "replayed", "targetOutcomes",
  ]) && isMutationReceiptBase(record) && Array.isArray(field("targetOutcomes")) &&
      (field("targetOutcomes") as unknown[]).every(isMessageTargetOutcome)) {
    return record as unknown as HumanMessageSubmissionReceipt;
  }
  if (kind === "revise" && authorityExactKeys(record, [
    "messageId", "persistedAt", "eventId", "replayed", "revision",
  ]) && isMutationReceiptBase(record) && Number.isSafeInteger(field("revision")) &&
      Number(field("revision")) > 0) {
    return record as unknown as MessageRevisionReceipt;
  }
  if (kind === "recall" && authorityExactKeys(record, [
    "messageId", "revision", "recalledAt", "eventId", "replayed", "abortTargets",
  ]) && typeof field("messageId") === "string" && String(field("messageId")).length > 0 &&
      Number.isSafeInteger(field("revision")) && Number(field("revision")) > 0 &&
      typeof field("recalledAt") === "string" && String(field("recalledAt")).length > 0 &&
      typeof field("eventId") === "string" && String(field("eventId")).length > 0 &&
      typeof field("replayed") === "boolean" && Array.isArray(field("abortTargets")) &&
      (field("abortTargets") as unknown[]).every(isMessageRecallExecutionCancellation) &&
      new Set((field("abortTargets") as MessageRecallExecutionCancellation[])
        .map((target) => target.executionId)).size ===
        (field("abortTargets") as unknown[]).length) {
    return record as unknown as MessageRecallReceipt;
  }
  if (kind === "agent" && authorityExactKeys(record, [
    "messageId", "persistedAt", "eventId", "replayed", "message",
  ]) && isMutationReceiptBase(record) && isAgentFinalMessage(field("message"))) {
    return record as unknown as AgentMessageCommitReceipt;
  }
  return fail("storage_unavailable", "Stored message authority receipt is corrupt");
}

function executeMessageAuthorityIdempotently<Receipt extends StoredMessageAuthorityReceipt>(
  database: DatabaseSync,
  input: {
    readonly scope: string;
    readonly key: string;
    readonly command: unknown;
    readonly kind: "submit" | "revise" | "recall" | "agent";
    readonly now: number;
    readonly execute: (persistedAt: string) => Receipt;
  },
): Receipt {
  const requestHash = messageAuthorityHash(input.command);
  const existing = database.prepare(
    `SELECT request_hash AS requestHash, response_json AS responseJson
     FROM idempotency_records WHERE scope = ? AND key = ?`,
  ).get(input.scope, input.key);
  if (existing !== undefined) {
    if (existing.requestHash !== requestHash) {
      return fail("idempotency_conflict", "Message authority idempotency payload changed");
    }
    if (typeof existing.responseJson !== "string") {
      return fail("storage_unavailable", "Stored message authority receipt is corrupt");
    }
    const receipt = parseStoredMessageAuthorityReceipt(existing.responseJson, input.kind);
    return { ...receipt, replayed: true } as Receipt;
  }
  const persistedAt = new Date(input.now).toISOString();
  const receipt = input.execute(persistedAt);
  database.prepare(
    `INSERT INTO idempotency_records (
       scope, key, request_hash, response_json, status_code, created_at, expires_at
     ) VALUES (?, ?, ?, ?, 200, ?, ?)`,
  ).run(
    input.scope,
    input.key,
    requestHash,
    canonicalJson(receipt),
    persistedAt,
    new Date(input.now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
  );
  return receipt;
}

function messageAuthorityPageLimit(limit: number | undefined): number {
  if (limit === undefined) return MESSAGE_AUTHORITY_DEFAULT_PAGE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MESSAGE_AUTHORITY_MAX_PAGE) {
    return fail("invalid_parameters", "Message authority page limit was rejected");
  }
  return limit;
}

function requireHumanMessageAuthority(
  database: DatabaseSync,
  actorId: string,
  roomId: string,
  messageId: string,
): {
  readonly lifecycle: "active" | "recalled";
  readonly currentRevision: number;
} {
  const row = database.prepare(
    `SELECT message.author_id AS authorId, message.author_kind AS authorKind,
            envelope.message_kind AS messageKind, envelope.lifecycle,
            envelope.current_revision AS currentRevision
     FROM messages AS message
     JOIN message_envelopes AS envelope ON envelope.message_id = message.id
     WHERE message.id = ? AND message.room_id = ? AND envelope.room_id = ?`,
  ).get(messageId, roomId, roomId);
  if (row === undefined) return fail("message_not_found", "Message was not found");
  if (row.authorKind !== "human" || row.messageKind !== "human") {
    return fail("agent_final_immutable", "Agent final messages are immutable");
  }
  if (row.authorId !== actorId) {
    return fail("permission_denied", "Only the Human message author may mutate it");
  }
  if ((row.lifecycle !== "active" && row.lifecycle !== "recalled") ||
      typeof row.currentRevision !== "number") {
    return fail("storage_unavailable", "Message authority state is corrupt");
  }
  return { lifecycle: row.lifecycle, currentRevision: row.currentRevision };
}

function validateRevisionCommand(command: MessageRevisionCommand): void {
  if (!authorityExactKeys(command, ["roomId", "messageId", "expectedRevision", "body"]) ||
      !isMessageRevision({
        messageId: command.messageId,
        revision: command.expectedRevision,
        body: command.body,
        revisedAt: "1970-01-01T00:00:00.000Z",
        revisedByActorId: "authority-validation",
      }) || typeof command.roomId !== "string" || command.roomId.trim().length === 0) {
    return fail("invalid_parameters", "Message revision command was rejected");
  }
}

function validateRecallCommand(command: MessageRecallCommand): void {
  if (!authorityExactKeys(command, ["roomId", "messageId", "expectedRevision"]) ||
      typeof command.roomId !== "string" || command.roomId.trim().length === 0 ||
      typeof command.messageId !== "string" || command.messageId.trim().length === 0 ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) {
    return fail("invalid_parameters", "Message recall command was rejected");
  }
}

export function submitHumanMessageDatabaseCommand(
  database: DatabaseSync,
  input: {
    readonly context: AuthenticatedCommandContext;
    readonly message: HumanMessageSubmit;
    readonly now: number;
    readonly beforeApply?: () => void;
  },
): HumanMessageSubmissionReceipt {
  return runAuthorityImmediateTransaction(database, () => {
    if (!isHumanMessageSubmit(input.message)) {
      return fail("invalid_parameters", "Structured Human message was rejected");
    }
    if (input.message.attachments.length !== 0) {
      return fail(
        "invalid_parameters",
        "Message attachments require the FT-04 authority validator",
      );
    }
    const actorId = requireHumanSession(database, input.context, input.now);
    requireCurrentHumanRoomMembership(database, actorId, input.message.roomId);
    requireMessageMutationAllowed(
      database,
      input.message.roomId,
      "message",
      stableId("message-v2-gate", actorId, input.message.roomId, input.message.messageId),
    );
    if (input.message.replyToMessageId !== undefined) {
      const reply = database.prepare(
        `SELECT 1 AS present FROM message_envelopes
         WHERE message_id = ? AND room_id = ?`,
      ).get(input.message.replyToMessageId, input.message.roomId);
      if (reply === undefined) return fail("message_not_found", "Reply target was not found");
    }
    const scope = [
      actorId, "message.send.v2", input.message.roomId, input.message.messageId,
    ].join("\u0000");
    return executeMessageAuthorityIdempotently(database, {
      scope,
      key: input.message.messageId,
      command: input.message,
      kind: "submit",
      now: input.now,
      execute(persistedAt) {
        input.beforeApply?.();
        if (database.prepare("SELECT 1 AS present FROM messages WHERE id = ?").get(
          input.message.messageId,
        ) !== undefined) {
          return fail("idempotency_conflict", "Message identity already exists");
        }
        const baseMessage: Message = {
          id: input.message.messageId,
          roomId: input.message.roomId,
          authorId: actorId,
          authorKind: "human",
          body: input.message.body,
          sentAt: persistedAt,
        };
        insertLegacyMessageAuthorityRecord(database, baseMessage);
        const outcomes: MessageTargetOutcome[] = [];
        for (const [targetOrder, target] of input.message.mentionedTargets.entries()) {
          const actor = database.prepare("SELECT kind FROM actors WHERE id = ?").get(
            target.targetActorId,
          );
          if (actor === undefined) {
            return fail("invalid_parameters", "Message target actor was not found");
          }
          database.prepare(
            `INSERT INTO message_mentions (
               message_id, room_id, target_id, target_kind, target_actor_id,
               range_start_utf16, range_end_utf16, target_order
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            input.message.messageId,
            input.message.roomId,
            target.id,
            target.kind,
            target.targetActorId,
            target.range.startUtf16,
            target.range.endUtf16,
            targetOrder,
          );
          const membership = database.prepare(
            `SELECT kind, participation FROM room_memberships
             WHERE room_id = ? AND actor_id = ?`,
          ).get(input.message.roomId, target.targetActorId);
          let outcome: MessageTargetOutcome;
          const expectedActorKind = target.kind === "human-request" ? "human" : "agent";
          if (actor.kind !== expectedActorKind ||
              (membership !== undefined && membership.kind !== expectedActorKind)) {
            outcome = {
              targetId: target.id,
              targetActorId: target.targetActorId,
              kind: target.kind,
              status: "rejected",
              code: "target_kind_mismatch",
            };
          } else if (membership === undefined) {
            outcome = {
              targetId: target.id,
              targetActorId: target.targetActorId,
              kind: target.kind,
              status: "rejected",
              code: "target_not_member",
            };
          } else if (target.kind === "agent-invocation" && membership.participation !== "active") {
            outcome = {
              targetId: target.id,
              targetActorId: target.targetActorId,
              kind: target.kind,
              status: "rejected",
              code: "target_assignment_inactive",
            };
          } else if (target.kind === "human-request") {
            const requestIntentId = stableId(
              "human-request-intent", actorId, input.message.messageId, target.id,
            );
            database.prepare(
              `INSERT INTO human_request_intents (
                 id, room_id, source_message_id, target_id, source_revision,
                 requester_human_actor_id, target_human_actor_id, status,
                 created_at, claimed_at, cancelled_at, cancellation_reason
               ) VALUES (?, ?, ?, ?, 1, ?, ?, 'pending', ?, NULL, NULL, NULL)`,
            ).run(
              requestIntentId,
              input.message.roomId,
              input.message.messageId,
              target.id,
              actorId,
              target.targetActorId,
              persistedAt,
            );
            outcome = {
              targetId: target.id,
              targetActorId: target.targetActorId,
              kind: target.kind,
              status: "request-created",
              requestIntentId,
            };
          } else {
            const invocationIntentId = stableId(
              "agent-invocation-intent", actorId, input.message.messageId, target.id,
            );
            database.prepare(
              `INSERT INTO agent_invocation_intents (
                 id, room_id, source_message_id, target_agent_id,
                 requester_actor_id, intent_kind, execution_id, created_at,
                 message_transaction_id, target_id, source_revision, lineage_id,
                 turn_id, origin_kind, status, claimed_at, cancelled_at,
                 cancellation_reason, supersedes_intent_id
               ) VALUES (?, ?, ?, ?, ?, 'direct_mention', NULL, ?, ?, ?, 1, ?, ?,
                         'message_target', 'pending', NULL, NULL, NULL, NULL)`,
            ).run(
              invocationIntentId,
              input.message.roomId,
              input.message.messageId,
              target.targetActorId,
              actorId,
              persistedAt,
              input.message.messageId,
              target.id,
              stableId("message-lineage", input.message.messageId, target.id),
              stableId("message-turn", input.message.messageId, target.id),
            );
            outcome = {
              targetId: target.id,
              targetActorId: target.targetActorId,
              kind: target.kind,
              status: "invocation-intent-created",
              invocationIntentId,
            };
          }
          database.prepare(
            `INSERT INTO message_target_outcomes (
               message_id, room_id, target_id, target_actor_id, target_kind,
               status, request_intent_id, invocation_intent_id, rejection_code,
               created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            input.message.messageId,
            input.message.roomId,
            target.id,
            target.targetActorId,
            target.kind,
            outcome.status,
            outcome.status === "request-created" ? outcome.requestIntentId : null,
            outcome.status === "invocation-intent-created" ? outcome.invocationIntentId : null,
            outcome.status === "rejected" ? outcome.code : null,
            persistedAt,
          );
          outcomes.push(outcome);
        }
        if (input.message.replyToMessageId !== undefined) {
          database.prepare(
            `INSERT INTO message_reply_links (message_id, room_id, reply_to_message_id)
             VALUES (?, ?, ?)`,
          ).run(input.message.messageId, input.message.roomId, input.message.replyToMessageId);
        }
        const timeline = readOperationalTimelineMessage(database, input.message.messageId);
        if (timeline.authorKind !== "human" || timeline.lifecycle !== "active") {
          return fail("storage_unavailable", "Submitted Human message projection is corrupt");
        }
        const eventId = stableId("message-authority-event", scope, input.message.messageId, "accepted");
        const streamSeq = appendRoomEvent(database, {
          eventId,
          roomId: input.message.roomId,
          actorId,
          eventType: "room.message.accepted",
          occurredAt: persistedAt,
          payload: { id: timeline.id },
        });
        appendRoomOutbox(
          database,
          eventId,
          input.message.roomId,
          streamSeq,
          persistedAt,
          scope,
          input.message.messageId,
        );
        return {
          messageId: input.message.messageId,
          persistedAt,
          targetOutcomes: outcomes,
          eventId,
          replayed: false,
        };
      },
    }) as HumanMessageSubmissionReceipt;
  });
}

export function reviseHumanMessageDatabaseCommand(
  database: DatabaseSync,
  input: {
    readonly context: AuthenticatedCommandContext;
    readonly command: MessageRevisionCommand;
    readonly now: number;
    readonly beforeApply?: () => void;
  },
): MessageRevisionReceipt {
  return runAuthorityImmediateTransaction(database, () => {
    validateRevisionCommand(input.command);
    const actorId = requireHumanSession(database, input.context, input.now);
    requireCurrentHumanRoomMembership(database, actorId, input.command.roomId);
    requireMessageMutationAllowed(
      database,
      input.command.roomId,
      "message",
      stableId("message-revision-gate", actorId, input.command.messageId),
    );
    const authority = requireHumanMessageAuthority(
      database, actorId, input.command.roomId, input.command.messageId,
    );
    const scope = [actorId, "message.revise", input.command.roomId, input.command.messageId].join("\u0000");
    const businessKey = `${input.command.messageId}:revision:${input.command.expectedRevision}`;
    return executeMessageAuthorityIdempotently(database, {
      scope,
      key: businessKey,
      command: input.command,
      kind: "revise",
      now: input.now,
      execute(persistedAt) {
        input.beforeApply?.();
        if (authority.lifecycle !== "active" ||
            authority.currentRevision !== input.command.expectedRevision) {
          return fail("message_version_conflict", "Message revision compare-and-set failed");
        }
        const ranges = database.prepare(
          `SELECT range_start_utf16 AS startUtf16, range_end_utf16 AS endUtf16
           FROM message_mentions WHERE message_id = ? ORDER BY target_order`,
        ).all(input.command.messageId);
        if (ranges.some((range) => !isUtf16Range({
          startUtf16: range.startUtf16,
          endUtf16: range.endUtf16,
        }, input.command.body))) {
          return fail(
            "invalid_parameters",
            "Message revision invalidated a structured mention range",
          );
        }
        const revision = input.command.expectedRevision + 1;
        database.prepare(
          `INSERT INTO message_revisions (
             message_id, revision, body, revised_at, revised_by_actor_id
           ) VALUES (?, ?, ?, ?, ?)`,
        ).run(input.command.messageId, revision, input.command.body, persistedAt, actorId);
        const updated = database.prepare(
          `UPDATE message_envelopes
           SET current_revision = ?, revision_count = ?
           WHERE message_id = ? AND room_id = ? AND message_kind = 'human'
             AND lifecycle = 'active' AND current_revision = ?`,
        ).run(
          revision,
          revision,
          input.command.messageId,
          input.command.roomId,
          input.command.expectedRevision,
        );
        if (updated.changes !== 1) {
          return fail("message_version_conflict", "Message revision compare-and-set failed");
        }
        database.prepare(
          `UPDATE outbox_deliveries
           SET status = 'dispatched', delivered_at = ?,
               last_error = 'superseded_by_message_revision'
           WHERE status = 'pending' AND event_id IN (
             SELECT event_id FROM events
             WHERE stream_kind = 'room' AND stream_id = ?
               AND event_type IN ('room.message.accepted', 'room.message.revised')
               AND json_extract(payload_json, '$.id') = ?
           )`,
        ).run(persistedAt, input.command.roomId, input.command.messageId);
        const timeline = readOperationalTimelineMessage(database, input.command.messageId);
        if (timeline.authorKind !== "human" || timeline.lifecycle !== "active") {
          return fail("storage_unavailable", "Revised Human message projection is corrupt");
        }
        const eventId = stableId("message-authority-event", scope, businessKey);
        const streamSeq = appendRoomEvent(database, {
          eventId,
          roomId: input.command.roomId,
          actorId,
          eventType: "room.message.revised",
          occurredAt: persistedAt,
          payload: { id: timeline.id },
        });
        appendRoomOutbox(
          database, eventId, input.command.roomId, streamSeq, persistedAt,
          scope, businessKey,
        );
        return {
          messageId: input.command.messageId,
          revision,
          persistedAt,
          eventId,
          replayed: false,
        };
      },
    }) as MessageRevisionReceipt;
  });
}

export function recallHumanMessageDatabaseCommand(
  database: DatabaseSync,
  input: {
    readonly context: AuthenticatedCommandContext;
    readonly command: MessageRecallCommand;
    readonly now: number;
    readonly beforeApply?: () => void;
  },
): MessageRecallReceipt {
  return runAuthorityImmediateTransaction(database, () => {
    validateRecallCommand(input.command);
    const actorId = requireHumanSession(database, input.context, input.now);
    requireCurrentHumanRoomMembership(database, actorId, input.command.roomId);
    requireMessageMutationAllowed(
      database,
      input.command.roomId,
      "message",
      stableId("message-recall-gate", actorId, input.command.messageId),
    );
    const authority = requireHumanMessageAuthority(
      database, actorId, input.command.roomId, input.command.messageId,
    );
    const scope = [actorId, "message.recall", input.command.roomId, input.command.messageId].join("\u0000");
    const businessKey = `${input.command.messageId}:recall:${input.command.expectedRevision}`;
    return executeMessageAuthorityIdempotently(database, {
      scope,
      key: businessKey,
      command: input.command,
      kind: "recall",
      now: input.now,
      execute(recalledAt) {
        input.beforeApply?.();
        if (authority.lifecycle !== "active" ||
            authority.currentRevision !== input.command.expectedRevision) {
          return fail("message_version_conflict", "Message recall compare-and-set failed");
        }
        database.prepare(
          `UPDATE human_request_intents
           SET status = 'cancelled', cancelled_at = ?, cancellation_reason = 'message_recalled'
           WHERE source_message_id = ? AND status = 'pending'`,
        ).run(recalledAt, input.command.messageId);
        database.prepare(
          `UPDATE agent_invocation_intents
           SET status = 'cancelled', cancelled_at = ?, cancellation_reason = 'message_recalled'
           WHERE source_message_id = ? AND status = 'pending'`,
        ).run(recalledAt, input.command.messageId);
        database.prepare(
          `INSERT INTO message_recall_fences (
             fence_id, room_id, source_message_id, source_revision, scope_kind,
             invocation_intent_id, execution_id, reason, created_at
           ) VALUES (?, ?, ?, ?, 'message', NULL, NULL, 'message_recalled', ?)`,
        ).run(
          stableId("message-recall-fence", input.command.messageId),
          input.command.roomId,
          input.command.messageId,
          input.command.expectedRevision,
          recalledAt,
        );
        const intents = database.prepare(
          `SELECT id FROM agent_invocation_intents
           WHERE source_message_id = ? ORDER BY id`,
        ).all(input.command.messageId);
        for (const intent of intents) {
          if (typeof intent.id !== "string") {
            return fail("storage_unavailable", "Message invocation intent is corrupt");
          }
          database.prepare(
            `INSERT INTO message_recall_fences (
               fence_id, room_id, source_message_id, source_revision, scope_kind,
               invocation_intent_id, execution_id, reason, created_at
             ) VALUES (?, ?, ?, ?, 'invocation-intent', ?, NULL, 'message_recalled', ?)`,
          ).run(
            stableId("message-recall-intent-fence", input.command.messageId, intent.id),
            input.command.roomId,
            input.command.messageId,
            input.command.expectedRevision,
            intent.id,
            recalledAt,
          );
        }
        const executions = database.prepare(
          `SELECT link.intent_id AS intentId, link.execution_id AS executionId,
                  execution.status, execution.current_attempt_seq AS attemptSeq
           FROM agent_execution_intent_links AS link
           JOIN agent_invocation_intents AS intent ON intent.id = link.intent_id
           JOIN agent_executions AS execution ON execution.id = link.execution_id
           WHERE intent.source_message_id = ?
           ORDER BY link.intent_id, link.execution_ordinal`,
        ).all(input.command.messageId);
        const abortTargets: MessageRecallExecutionCancellation[] = [];
        for (const execution of executions) {
          if (typeof execution.intentId !== "string" || typeof execution.executionId !== "string" ||
              typeof execution.attemptSeq !== "number") {
            return fail("storage_unavailable", "Message execution lineage is corrupt");
          }
          database.prepare(
            `INSERT INTO message_recall_fences (
               fence_id, room_id, source_message_id, source_revision, scope_kind,
               invocation_intent_id, execution_id, reason, created_at
             ) VALUES (?, ?, ?, ?, 'execution', ?, ?, 'message_recalled', ?)`,
          ).run(
            stableId(
              "message-recall-execution-fence",
              input.command.messageId,
              execution.intentId,
              execution.executionId,
            ),
            input.command.roomId,
            input.command.messageId,
            input.command.expectedRevision,
            execution.intentId,
            execution.executionId,
            recalledAt,
          );
          if (execution.status === "queued" || execution.status === "running") {
            const dispatch = database.prepare(
              `SELECT state FROM tool_dispatches
               WHERE execution_id = ? AND attempt_seq = ?
               ORDER BY rowid DESC LIMIT 1`,
            ).get(execution.executionId, execution.attemptSeq);
            const sideEffectState = dispatch?.state === "outcome_unknown"
              ? "outcome-unknown-retained" as const
              : dispatch?.state === "dispatched" || dispatch?.state === "succeeded"
                ? "dispatched-retained" as const
                : "none" as const;
            const cancelled = database.prepare(
              `UPDATE agent_executions
               SET status = 'cancelled', cancellation_reason = 'message_recalled',
                   completed_at = ?, updated_at = ?, next_retry_at = NULL
               WHERE id = ? AND current_attempt_seq = ? AND status IN ('queued', 'running')`,
            ).run(
              recalledAt,
              recalledAt,
              execution.executionId,
              execution.attemptSeq,
            );
            if (cancelled.changes !== 1) {
              return fail("execution_conflict", "Message recall execution cancellation was stale");
            }
            database.prepare(
              `UPDATE agent_execution_attempts
               SET status = 'cancelled', finished_at = ?, error_code = 'message_recalled',
                   next_retry_at = NULL
               WHERE execution_id = ? AND attempt_seq = ? AND status IN ('queued', 'running')`,
            ).run(recalledAt, execution.executionId, execution.attemptSeq);
            const cancelledExecution = runtimeExecutionById(database, execution.executionId);
            appendRuntimeExecutionEvent(
              database,
              cancelledExecution,
              recalledAt,
              "cancelled",
              "message_recalled",
            );
            abortTargets.push({
              sourceMessageId: input.command.messageId,
              sourceRevision: input.command.expectedRevision,
              invocationIntentId: execution.intentId,
              executionId: execution.executionId,
              attemptSeq: execution.attemptSeq,
              cancellationReason: "message_recalled",
              sideEffectState,
            });
          }
        }
        const updated = database.prepare(
          `UPDATE message_envelopes
           SET lifecycle = 'recalled', recalled_at = ?, recalled_by_actor_id = ?
           WHERE message_id = ? AND room_id = ? AND message_kind = 'human'
             AND lifecycle = 'active' AND current_revision = ?`,
        ).run(
          recalledAt,
          actorId,
          input.command.messageId,
          input.command.roomId,
          input.command.expectedRevision,
        );
        if (updated.changes !== 1) {
          return fail("message_version_conflict", "Message recall compare-and-set failed");
        }
        database.prepare(
          `UPDATE message_attachment_links SET operational_state = 'excluded_recalled'
           WHERE message_id = ? AND operational_state = 'active'`,
        ).run(input.command.messageId);
        database.prepare(
          `UPDATE outbox_deliveries
           SET status = 'dispatched', delivered_at = ?,
               last_error = 'superseded_by_message_recall'
           WHERE status = 'pending' AND event_id IN (
             SELECT event_id FROM events
             WHERE stream_kind = 'room' AND stream_id = ?
               AND event_type IN ('room.message.accepted', 'room.message.revised')
               AND json_extract(payload_json, '$.id') = ?
           )`,
        ).run(recalledAt, input.command.roomId, input.command.messageId);
        const timeline = readOperationalTimelineMessage(database, input.command.messageId);
        if (timeline.lifecycle !== "recalled") {
          return fail("storage_unavailable", "Recalled message projection is corrupt");
        }
        const eventId = stableId("message-authority-event", scope, businessKey);
        const streamSeq = appendRoomEvent(database, {
          eventId,
          roomId: input.command.roomId,
          actorId,
          eventType: "room.message.recalled",
          occurredAt: recalledAt,
          payload: { id: timeline.id },
        });
        appendRoomOutbox(
          database, eventId, input.command.roomId, streamSeq, recalledAt,
          scope, businessKey,
        );
        return {
          messageId: input.command.messageId,
          revision: input.command.expectedRevision,
          recalledAt,
          eventId,
          replayed: false,
          abortTargets,
        };
      },
    }) as MessageRecallReceipt;
  });
}

export function readMessageHistoryDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  query: MessageHistoryQuery,
  now: number,
): MessageHistoryPage {
  return runAuthorityReadTransaction(database, () => {
    if (!authorityExactKeys(query, ["roomId"], ["afterMessageId", "limit"]) ||
        typeof query.roomId !== "string" || query.roomId.trim().length === 0 ||
        (query.afterMessageId !== undefined &&
          (typeof query.afterMessageId !== "string" || query.afterMessageId.trim().length === 0))) {
      return fail("invalid_parameters", "Message history query was rejected");
    }
    const actorId = requireHumanSession(database, context, now);
    requireSyncHumanRoomMembership(database, actorId, query.roomId);
    const room = database.prepare(
      `SELECT status, owner_actor_id AS ownerActorId FROM rooms WHERE id = ?`,
    ).get(query.roomId);
    if ((room?.status !== "active" && room?.status !== "archived") ||
        typeof room.ownerActorId !== "string") {
      return fail("storage_unavailable", "Message history Room authority is corrupt");
    }
    const actors = database.prepare(
      `SELECT actor.id AS actorId, actor.kind, actor.display_name AS displayName,
              membership.role, membership.participation
       FROM room_memberships AS membership
       JOIN actors AS actor ON actor.id = membership.actor_id
       WHERE membership.room_id = ?
       ORDER BY actor.id`,
    ).all(query.roomId).map((row) => {
      if (typeof row.actorId !== "string" || row.actorId.length === 0 ||
          typeof row.displayName !== "string" || row.displayName.length === 0 ||
          (row.kind !== "human" && row.kind !== "agent")) {
        return fail("storage_unavailable", "Message history actor projection is corrupt");
      }
      if (row.kind === "human") {
        if (row.role !== "owner" && row.role !== "member" && row.role !== "admin") {
          return fail("storage_unavailable", "Message history Human role is corrupt");
        }
        if ((row.role === "owner") !== (row.actorId === room.ownerActorId)) {
          return fail("storage_unavailable", "Message history Room ownership is corrupt");
        }
        return {
          actorId: row.actorId,
          kind: "human" as const,
          displayName: row.displayName,
          secondaryLabel: row.role === "owner"
            ? "Owner"
            : row.role === "admin" ? "Admin" : "Member",
        };
      }
      if (row.participation !== "active" && row.participation !== "on-mention" &&
          row.participation !== "silent") {
        return fail("storage_unavailable", "Message history Agent assignment is corrupt");
      }
      return {
        actorId: row.actorId,
        kind: "agent" as const,
        displayName: row.displayName,
        secondaryLabel: row.participation === "active"
          ? "Active Agent"
          : row.participation === "on-mention" ? "On-mention Agent" : "Silent Agent",
      };
    });
    const limit = messageAuthorityPageLimit(query.limit);
    let afterCreatedAt: string | undefined;
    if (query.afterMessageId !== undefined) {
      const after = database.prepare(
        `SELECT created_at AS createdAt FROM message_envelopes
         WHERE message_id = ? AND room_id = ?`,
      ).get(query.afterMessageId, query.roomId);
      if (typeof after?.createdAt !== "string") {
        return fail("message_not_found", "Message history cursor was not found");
      }
      afterCreatedAt = after.createdAt;
    }
    const rows = afterCreatedAt === undefined
      ? database.prepare(
          `SELECT message_id AS messageId FROM message_envelopes
           WHERE room_id = ? ORDER BY created_at, message_id LIMIT ?`,
        ).all(query.roomId, limit + 1)
      : database.prepare(
          `SELECT message_id AS messageId FROM message_envelopes
           WHERE room_id = ? AND (created_at > ? OR (created_at = ? AND message_id > ?))
           ORDER BY created_at, message_id LIMIT ?`,
        ).all(query.roomId, afterCreatedAt, afterCreatedAt, query.afterMessageId!, limit + 1);
    const hasMore = rows.length > limit;
    return {
      messages: rows.slice(0, limit).map((row) => typeof row.messageId === "string"
        ? readOperationalTimelineMessage(database, row.messageId)
        : fail("storage_unavailable", "Message history row is corrupt")),
      hasMore,
      lifecycle: room.status,
      actors,
    };
  });
}

export function readMessageRevisionsDatabaseQuery(
  database: DatabaseSync,
  context: AuthenticatedSessionContext,
  query: MessageRevisionQuery,
  now: number,
): MessageRevisionPage {
  return runAuthorityReadTransaction(database, () => {
    if (!authorityExactKeys(query, ["roomId", "messageId"], ["afterRevision", "limit"]) ||
        typeof query.roomId !== "string" || query.roomId.trim().length === 0 ||
        typeof query.messageId !== "string" || query.messageId.trim().length === 0 ||
        (query.afterRevision !== undefined &&
          (!Number.isSafeInteger(query.afterRevision) || query.afterRevision < 0))) {
      return fail("invalid_parameters", "Message revision query was rejected");
    }
    const actorId = requireHumanSession(database, context, now);
    requireSyncHumanRoomMembership(database, actorId, query.roomId);
    const envelope = database.prepare(
      `SELECT message_kind AS messageKind, lifecycle FROM message_envelopes
       WHERE message_id = ? AND room_id = ?`,
    ).get(query.messageId, query.roomId);
    if (envelope === undefined) return fail("message_not_found", "Message was not found");
    if (envelope.messageKind !== "human") {
      return fail("agent_final_immutable", "Agent final messages have no revision query");
    }
    if (envelope.lifecycle === "recalled") return { revisions: [], hasMore: false };
    const limit = messageAuthorityPageLimit(query.limit);
    const rows = database.prepare(
      `SELECT message_id AS messageId, revision, body, revised_at AS revisedAt,
              revised_by_actor_id AS revisedByActorId
       FROM message_revisions WHERE message_id = ? AND revision > ?
       ORDER BY revision LIMIT ?`,
    ).all(query.messageId, query.afterRevision ?? 0, limit + 1);
    const hasMore = rows.length > limit;
    const revisions = rows.slice(0, limit).map((row) => ({
      messageId: row.messageId,
      revision: row.revision,
      body: row.body,
      revisedAt: row.revisedAt,
      revisedByActorId: row.revisedByActorId,
    })).map((revision) => isMessageRevision(revision)
      ? revision
      : fail("storage_unavailable", "Message revision row is corrupt"));
    return { revisions, hasMore };
  });
}

function validateAgentMessageCommand(command: AgentMessageCommitCommand): void {
  if (!authorityExactKeys(command, ["messageId", "roomId", "body"], ["correctsMessageId"]) ||
      !isAgentFinalMessage({
        id: command.messageId,
        roomId: command.roomId,
        authorId: "authority-agent",
        authorKind: "agent",
        createdAt: "1970-01-01T00:00:00.000Z",
        lifecycle: "active",
        finalBody: command.body,
        sourceInvocationIntentId: "authority-intent",
        sourceExecutionId: "authority-execution",
        ...(command.correctsMessageId === undefined
          ? {}
          : { correctsMessageId: command.correctsMessageId }),
      })) {
    return fail("invalid_parameters", "Agent message commit command was rejected");
  }
}

export function commitAgentMessageDatabaseCommand(
  database: DatabaseSync,
  input: {
    readonly context: AgentMessageWorkerContext;
    readonly command: AgentMessageCommitCommand;
    readonly now: number;
    readonly beforeApply?: () => void;
  },
): AgentMessageCommitReceipt {
  return runAuthorityImmediateTransaction(database, () => {
    validateAgentMessageCommand(input.command);
    if (!authorityExactKeys(input.context, [
      "kind", "agent", "invocationIntentId", "executionId", "attemptSeq", "executionGeneration",
    ]) || input.context.kind !== "agent-message" ||
        !authorityExactKeys(input.context.agent, ["actorId", "kind"]) ||
        input.context.agent.kind !== "agent" ||
        typeof input.context.agent.actorId !== "string" || input.context.agent.actorId.length === 0 ||
        typeof input.context.invocationIntentId !== "string" || input.context.invocationIntentId.length === 0 ||
        typeof input.context.executionId !== "string" || input.context.executionId.length === 0 ||
        !Number.isSafeInteger(input.context.attemptSeq) || input.context.attemptSeq < 1 ||
        !Number.isSafeInteger(input.context.executionGeneration) || input.context.executionGeneration < 1) {
      return fail("permission_denied", "Agent message capability binding was rejected");
    }
    const scope = [
      input.context.agent.actorId,
      "agent.message.commit",
      input.command.roomId,
      input.context.invocationIntentId,
      input.context.executionId,
      String(input.context.attemptSeq),
      String(input.context.executionGeneration),
    ].join("\u0000");
    const existingReceipt = database.prepare(
      "SELECT request_hash AS requestHash, response_json AS responseJson FROM idempotency_records WHERE scope = ? AND key = ?",
    ).get(scope, input.command.messageId);
    if (existingReceipt !== undefined) {
      if (existingReceipt.requestHash !== messageAuthorityHash(input.command)) {
        return fail("idempotency_conflict", "Agent message idempotency payload changed");
      }
      if (typeof existingReceipt.responseJson !== "string") {
        return fail("storage_unavailable", "Stored Agent message receipt is corrupt");
      }
      const replay = parseStoredMessageAuthorityReceipt(existingReceipt.responseJson, "agent");
      return { ...replay, replayed: true } as AgentMessageCommitReceipt;
    }
    const lineage = database.prepare(
      `SELECT intent.room_id AS roomId, intent.source_message_id AS sourceMessageId,
              intent.source_revision AS sourceRevision, intent.target_agent_id AS targetAgentId,
              intent.status AS intentStatus, execution.status AS executionStatus,
              execution.current_attempt_seq AS currentAttemptSeq,
              execution.execution_generation AS executionGeneration,
              execution.result_message_id AS resultMessageId,
              room.status AS roomStatus, membership.participation,
              source.lifecycle AS sourceLifecycle
       FROM agent_invocation_intents AS intent
       JOIN agent_execution_intent_links AS link
         ON link.intent_id = intent.id AND link.execution_id = ?
       JOIN agent_executions AS execution ON execution.id = link.execution_id
       JOIN rooms AS room ON room.id = intent.room_id
       JOIN room_memberships AS membership
         ON membership.room_id = intent.room_id
        AND membership.actor_id = intent.target_agent_id
        AND membership.kind = 'agent'
       JOIN message_envelopes AS source ON source.message_id = intent.source_message_id
       WHERE intent.id = ?`,
    ).get(input.context.executionId, input.context.invocationIntentId);
    if (lineage === undefined) {
      return fail("execution_conflict", "Agent message source lineage was not found");
    }
    if (lineage.roomId !== input.command.roomId ||
        lineage.targetAgentId !== input.context.agent.actorId ||
        lineage.intentStatus !== "claimed" || lineage.executionStatus !== "running" ||
        lineage.currentAttemptSeq !== input.context.attemptSeq ||
        lineage.executionGeneration !== input.context.executionGeneration ||
        lineage.resultMessageId !== null || lineage.roomStatus !== "active" ||
        lineage.participation !== "active" || lineage.sourceLifecycle !== "active") {
      return fail("execution_conflict", "Agent message terminal compare-and-set failed");
    }
    if (typeof lineage.sourceMessageId !== "string" ||
        typeof lineage.sourceRevision !== "number") {
      return fail("storage_unavailable", "Agent message source lineage is corrupt");
    }
    const sourceMessageId = lineage.sourceMessageId;
    const sourceRevision = lineage.sourceRevision;
    const fenced = database.prepare(
      `SELECT 1 AS present FROM message_recall_fences
       WHERE source_message_id = ? AND (
         scope_kind = 'message'
         OR (scope_kind = 'invocation-intent' AND invocation_intent_id = ?)
         OR (scope_kind = 'execution' AND invocation_intent_id = ? AND execution_id = ?)
       ) LIMIT 1`,
    ).get(
      sourceMessageId,
      input.context.invocationIntentId,
      input.context.invocationIntentId,
      input.context.executionId,
    );
    if (fenced !== undefined) {
      return fail("execution_conflict", "Agent message source was recalled");
    }
    if (database.prepare("SELECT 1 AS present FROM messages WHERE id = ?").get(
      input.command.messageId,
    ) !== undefined) {
      return fail("idempotency_conflict", "Agent message identity already exists");
    }
    if (input.command.correctsMessageId !== undefined) {
      const correction = database.prepare(
        `SELECT envelope.room_id AS roomId, envelope.message_kind AS messageKind,
                message.author_id AS authorId
         FROM message_envelopes AS envelope
         JOIN messages AS message ON message.id = envelope.message_id
         WHERE envelope.message_id = ?`,
      ).get(input.command.correctsMessageId);
      if (correction?.roomId !== input.command.roomId ||
          correction.messageKind !== "agent-final" ||
          correction.authorId !== input.context.agent.actorId) {
        return fail("agent_final_immutable", "Agent correction target was rejected");
      }
    }
    return executeMessageAuthorityIdempotently(database, {
      scope,
      key: input.command.messageId,
      command: input.command,
      kind: "agent",
      now: input.now,
      execute(persistedAt) {
        input.beforeApply?.();
        database.prepare(
          `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
           VALUES (?, ?, ?, 'agent', ?, ?)`,
        ).run(
          input.command.messageId,
          input.command.roomId,
          input.context.agent.actorId,
          input.command.body,
          persistedAt,
        );
        database.prepare(
          `INSERT INTO message_revisions (
             message_id, revision, body, revised_at, revised_by_actor_id
           ) VALUES (?, 1, ?, ?, ?)`,
        ).run(
          input.command.messageId,
          input.command.body,
          persistedAt,
          input.context.agent.actorId,
        );
        database.prepare(
          `INSERT INTO message_envelopes (
             message_id, room_id, message_kind, lifecycle, current_revision,
             revision_count, created_at, recalled_at, recalled_by_actor_id
           ) VALUES (?, ?, ?, 'active', 1, 1, ?, NULL, NULL)`,
        ).run(
          input.command.messageId,
          input.command.roomId,
          input.command.correctsMessageId === undefined ? "agent-final" : "agent-correction",
          persistedAt,
        );
        database.prepare(
          `INSERT INTO agent_message_sources (
             message_id, room_id, invocation_intent_id, execution_id,
             attempt_seq, execution_generation, source_message_id,
             source_revision, committed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.command.messageId,
          input.command.roomId,
          input.context.invocationIntentId,
          input.context.executionId,
          input.context.attemptSeq,
          input.context.executionGeneration,
          sourceMessageId,
          sourceRevision,
          persistedAt,
        );
        if (input.command.correctsMessageId !== undefined) {
          database.prepare(
            `INSERT INTO agent_message_corrections (
               correction_message_id, corrects_message_id, room_id,
               agent_actor_id, created_at
             ) VALUES (?, ?, ?, ?, ?)`,
          ).run(
            input.command.messageId,
            input.command.correctsMessageId,
            input.command.roomId,
            input.context.agent.actorId,
            persistedAt,
          );
        }
        const attemptUpdated = database.prepare(
          `UPDATE agent_execution_attempts
           SET status = 'completed', finished_at = ?
           WHERE execution_id = ? AND attempt_seq = ? AND status = 'running'`,
        ).run(persistedAt, input.context.executionId, input.context.attemptSeq);
        const executionUpdated = database.prepare(
          `UPDATE agent_executions
           SET status = 'completed', completed_at = ?, updated_at = ?, result_message_id = ?
           WHERE id = ? AND status = 'running' AND current_attempt_seq = ?
             AND execution_generation = ? AND result_message_id IS NULL`,
        ).run(
          persistedAt,
          persistedAt,
          input.command.messageId,
          input.context.executionId,
          input.context.attemptSeq,
          input.context.executionGeneration,
        );
        if (executionUpdated.changes !== 1 || attemptUpdated.changes !== 1) {
          return fail("execution_conflict", "Agent message terminal compare-and-set failed");
        }
        const message = readOperationalTimelineMessage(database, input.command.messageId);
        if (message.authorKind !== "agent") {
          return fail("storage_unavailable", "Agent message projection is corrupt");
        }
        const eventId = stableId("message-authority-event", scope, input.command.messageId);
        const streamSeq = appendRoomEvent(database, {
          eventId,
          roomId: input.command.roomId,
          actorId: input.context.agent.actorId,
          eventType: "room.message.accepted",
          occurredAt: persistedAt,
          payload: { id: message.id },
        });
        appendRoomOutbox(
          database, eventId, input.command.roomId, streamSeq, persistedAt,
          scope, input.command.messageId,
        );
        return {
          messageId: input.command.messageId,
          persistedAt,
          eventId,
          replayed: false,
          message,
        };
      },
    }) as AgentMessageCommitReceipt;
  });
}
