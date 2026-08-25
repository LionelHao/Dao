import { useAuthorityTransactionDatabase } from
  "../persistence/authority-transaction-database.js";
import type { AuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import {
  isTrustedInvocationOrigin,
  type DirectInvocationOrigin,
} from "../route-runtime/trusted-invocation-origin.js";

type UnknownRow = Record<string, unknown>;

export type DirectIntentAuthorityErrorCode =
  | "untrusted_origin"
  | "room_mismatch"
  | "room_archived"
  | "source_stale"
  | "target_not_bound"
  | "profile_unavailable"
  | "profile_revision_stale"
  | "assignment_removed"
  | "assignment_paused"
  | "assignment_revision_stale"
  | "access_revoked"
  | "access_revision_stale"
  | "idempotency_conflict";

export class DirectIntentAuthorityError extends Error {
  readonly code: DirectIntentAuthorityErrorCode;

  constructor(code: DirectIntentAuthorityErrorCode) {
    super(`Direct invocation authority rejected: ${code}`);
    this.name = "DirectIntentAuthorityError";
    this.code = code;
  }
}

export interface DirectIntentAuthorityBinding {
  readonly actorId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly participation: "active" | "on-mention";
}

export interface CreateDirectInvocationIntentInput {
  readonly origin: DirectInvocationOrigin;
  readonly intentId: string;
  readonly requesterActorId: string;
  readonly lineageId: string;
  readonly turnId: string;
  readonly createdAt: string;
}

export interface DirectInvocationIntentResult {
  readonly disposition: "created" | "already-created";
  readonly intentId: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly targetId: string;
  readonly requesterActorId: string;
  readonly createdAt: string;
  readonly binding: DirectIntentAuthorityBinding;
}

export type RoutedIntentCancellationReason =
  | "route_provenance_invalid"
  | "route_revision_stale"
  | "source_revision_stale"
  | "room_archived"
  | "profile_unavailable"
  | "profile_revision_stale"
  | "assignment_removed"
  | "assignment_paused"
  | "assignment_inactive"
  | "assignment_revision_stale"
  | "access_revoked"
  | "access_revision_stale"
  | "noauth"
  | "busy";

export interface RoutedInvocationIntentRecord {
  readonly intentId: string;
  readonly decisionId: string;
  readonly routeJobId: string;
  readonly snapshotId: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly sourceMessageRevision: number;
  readonly actorId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly trigger: "domain" | "risk" | "ball";
  readonly reasonText: string;
  readonly status: "pending" | "claimed" | "cancelled";
  readonly createdAt: string;
  readonly claimedAt?: string;
  readonly cancelledAt?: string;
  readonly cancellationReason?: string;
}

/**
 * The durable accepted-intent boundary. FT-08 may consume this to create an
 * execution, but this module deliberately does not create agent_executions.
 */
export interface AcceptedRoutedIntentHandoff {
  readonly intentId: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly sourceMessageRevision: number;
  readonly actorId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly trigger: "domain" | "risk" | "ball";
  readonly reasonText: string;
}

export interface ClaimRoutedInvocationIntentInput {
  readonly intentId: string;
  readonly claimedAt: string;
  /** AuthorityWorker-derived provider state; this module accepts no client/session token. */
  readonly providerReady: boolean;
}

export type ClaimRoutedInvocationIntentResult = Readonly<{
  disposition: "claimed" | "already-claimed";
  intent: RoutedInvocationIntentRecord;
  handoff: AcceptedRoutedIntentHandoff;
}> | Readonly<{
  disposition: "cancelled" | "already-cancelled";
  intent: RoutedInvocationIntentRecord;
}>;

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exact(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) =>
    Object.hasOwn(value, key));
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function time(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

function requireText(value: unknown, label: string): asserts value is string {
  if (!text(value)) throw new TypeError(`${label} is invalid`);
}

function directFacts(row: UnknownRow | undefined): DirectIntentAuthorityBinding {
  if (row === undefined || row.roomStatus === undefined) {
    throw new DirectIntentAuthorityError("room_archived");
  }
  if (row.roomStatus !== "active") throw new DirectIntentAuthorityError("room_archived");
  if (row.sourceAuthorKind !== "human" || row.sourceMessageKind !== "human" ||
      row.sourceLifecycle !== "active" || row.sourceRoomId !== row.roomId ||
      row.envelopeRoomId !== row.roomId || row.sourceAuthorId !== row.requesterActorId ||
      row.currentRevision !== row.expectedMessageRevision) {
    throw new DirectIntentAuthorityError("source_stale");
  }
  if (row.targetKind !== "agent-invocation" || row.mentionActorId !== row.expectedActorId ||
      row.targetActorKind !== "agent") {
    throw new DirectIntentAuthorityError("target_not_bound");
  }
  if (!text(row.profileId) || row.profileId !== row.expectedProfileId ||
      row.profileActorId !== row.expectedActorId ||
      row.profileStatus !== "enabled") {
    throw new DirectIntentAuthorityError("profile_unavailable");
  }
  if (row.profileRevision !== row.expectedProfileRevision) {
    throw new DirectIntentAuthorityError("profile_revision_stale");
  }
  if (!text(row.assignmentId) || row.assignmentId !== row.expectedAssignmentId ||
      row.assignmentStatus !== "current" ||
      row.assignmentActorId !== row.expectedActorId || row.assignmentProfileId !== row.profileId) {
    throw new DirectIntentAuthorityError("assignment_removed");
  }
  if (row.assignmentPaused === 1) throw new DirectIntentAuthorityError("assignment_paused");
  if (row.assignmentRevision !== row.expectedAssignmentRevision) {
    throw new DirectIntentAuthorityError("assignment_revision_stale");
  }
  if (row.assignmentParticipation !== "active" &&
      row.assignmentParticipation !== "on-mention") {
    throw new DirectIntentAuthorityError("assignment_removed");
  }
  if (row.membershipKind !== "agent") throw new DirectIntentAuthorityError("access_revoked");
  if (row.membershipAccessRevision !== row.expectedAccessRevision) {
    throw new DirectIntentAuthorityError("access_revision_stale");
  }
  if (!positive(row.profileRevision) || !positive(row.assignmentRevision) ||
      !nonnegative(row.membershipAccessRevision)) {
    throw new Error("Direct invocation authority facts are corrupt");
  }
  return Object.freeze({
    actorId: row.expectedActorId as string,
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    assignmentId: row.assignmentId,
    assignmentRevision: row.assignmentRevision,
    accessRevision: row.membershipAccessRevision,
    participation: row.assignmentParticipation,
  });
}

function readDirectFacts(
  database: import("node:sqlite").DatabaseSync,
  roomId: string,
  requesterActorId: string,
  origin: DirectInvocationOrigin,
): DirectIntentAuthorityBinding {
  const row = database.prepare(
    `SELECT room.id AS roomId, room.status AS roomStatus,
            source.room_id AS sourceRoomId, source.author_id AS sourceAuthorId,
            source.author_kind AS sourceAuthorKind, envelope.room_id AS envelopeRoomId,
            envelope.message_kind AS sourceMessageKind,
            envelope.lifecycle AS sourceLifecycle, envelope.current_revision AS currentRevision,
            mention.target_kind AS targetKind, mention.target_actor_id AS mentionActorId,
            target.kind AS targetActorKind, profile.id AS profileId,
            profile.actor_id AS profileActorId, profile.revision AS profileRevision,
            profile.status AS profileStatus, assignment.id AS assignmentId,
            assignment.profile_id AS assignmentProfileId,
            assignment.agent_actor_id AS assignmentActorId,
            assignment.revision AS assignmentRevision,
            assignment.status AS assignmentStatus,
            assignment.participation AS assignmentParticipation,
            assignment.paused AS assignmentPaused,
            membership.kind AS membershipKind,
            membership.access_revision AS membershipAccessRevision,
            ? AS requesterActorId, ? AS expectedMessageRevision,
            ? AS expectedActorId, ? AS expectedProfileId, ? AS expectedProfileRevision,
            ? AS expectedAssignmentId, ? AS expectedAssignmentRevision,
            ? AS expectedAccessRevision
     FROM rooms AS room
     LEFT JOIN messages AS source
       ON source.id = ? AND source.room_id = room.id
     LEFT JOIN message_envelopes AS envelope
       ON envelope.message_id = source.id AND envelope.room_id = room.id
     LEFT JOIN message_mentions AS mention
       ON mention.message_id = source.id AND mention.room_id = room.id AND mention.target_id = ?
     LEFT JOIN actors AS target ON target.id = mention.target_actor_id
     LEFT JOIN agent_profiles AS profile
       ON profile.id = ? AND profile.actor_id = mention.target_actor_id
     LEFT JOIN room_agent_assignments AS assignment
       ON assignment.id = ? AND assignment.room_id = room.id
      AND assignment.agent_actor_id = mention.target_actor_id
     LEFT JOIN room_memberships AS membership
       ON membership.room_id = room.id AND membership.actor_id = mention.target_actor_id
     WHERE room.id = ?`,
  ).get(
    requesterActorId, origin.messageRevision, origin.targetActorId, origin.profileId,
    origin.profileRevision, origin.assignmentId, origin.assignmentRevision, origin.accessRevision,
    origin.messageId, origin.targetOutcomeId, origin.profileId, origin.assignmentId, roomId,
  ) as UnknownRow | undefined;
  return directFacts(row);
}

function sameDirectIntent(row: UnknownRow | undefined, input: CreateDirectInvocationIntentInput): boolean {
  return row !== undefined && row.id === input.intentId && row.roomId === input.origin.roomId &&
    row.sourceMessageId === input.origin.messageId &&
    row.targetAgentId === input.origin.targetActorId &&
    row.requesterActorId === input.requesterActorId && row.intentKind === "direct_mention" &&
    row.createdAt === input.createdAt && row.messageTransactionId === input.origin.messageId &&
    row.targetId === input.origin.targetOutcomeId && row.sourceRevision === 1 &&
    row.lineageId === input.lineageId && row.turnId === input.turnId &&
    row.originKind === "message_target" &&
    (row.status === "pending" || row.status === "claimed" || row.status === "cancelled");
}

function readPersistedDirectBinding(
  database: import("node:sqlite").DatabaseSync,
  intentId: string,
): DirectIntentAuthorityBinding {
  const row = database.prepare(
    `SELECT intent.target_agent_id AS actorId,
            binding.profile_id AS profileId,
            binding.profile_revision AS profileRevision,
            binding.assignment_id AS assignmentId,
            binding.assignment_revision AS assignmentRevision,
            binding.access_revision AS accessRevision,
            assignment_revision.participation
     FROM direct_agent_invocation_authority_bindings AS binding
     JOIN agent_invocation_intents AS intent ON intent.id = binding.intent_id
     JOIN room_agent_assignment_revisions AS assignment_revision
       ON assignment_revision.assignment_id = binding.assignment_id
      AND assignment_revision.revision = binding.assignment_revision
     WHERE binding.intent_id = ?`,
  ).get(intentId) as UnknownRow | undefined;
  if (row === undefined || !text(row.actorId) || !text(row.profileId) ||
      !positive(row.profileRevision) || !text(row.assignmentId) ||
      !positive(row.assignmentRevision) || !nonnegative(row.accessRevision) ||
      (row.participation !== "active" && row.participation !== "on-mention")) {
    throw new DirectIntentAuthorityError("target_not_bound");
  }
  return Object.freeze({
    actorId: row.actorId,
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    assignmentId: row.assignmentId,
    assignmentRevision: row.assignmentRevision,
    accessRevision: row.accessRevision,
    participation: row.participation,
  });
}

export function createDirectInvocationIntent(
  transaction: AuthorityTransactionView,
  input: CreateDirectInvocationIntentInput,
): DirectInvocationIntentResult {
  if (!exact(input, [
    "origin", "intentId", "requesterActorId", "lineageId", "turnId", "createdAt",
  ])) throw new TypeError("Direct invocation input is invalid");
  if (!isTrustedInvocationOrigin(input.origin) || input.origin.kind !== "message_target") {
    throw new DirectIntentAuthorityError("untrusted_origin");
  }
  if (transaction.roomId !== input.origin.roomId) {
    throw new DirectIntentAuthorityError("room_mismatch");
  }
  requireText(input.intentId, "Direct intent id");
  requireText(input.requesterActorId, "Direct requester");
  requireText(input.lineageId, "Direct lineage");
  requireText(input.turnId, "Direct turn");
  if (!time(input.createdAt)) throw new TypeError("Direct intent time is invalid");
  // v16 message-target intents are created with the original structured message transaction.
  if (input.origin.messageRevision !== 1) {
    throw new DirectIntentAuthorityError("source_stale");
  }

  return useAuthorityTransactionDatabase(transaction, (database) => {
    const existing = database.prepare(
      `SELECT id, room_id AS roomId, source_message_id AS sourceMessageId,
              target_agent_id AS targetAgentId, requester_actor_id AS requesterActorId,
              intent_kind AS intentKind, created_at AS createdAt,
              message_transaction_id AS messageTransactionId, target_id AS targetId,
              source_revision AS sourceRevision, lineage_id AS lineageId, turn_id AS turnId,
              origin_kind AS originKind, status
       FROM agent_invocation_intents
       WHERE room_id = ? AND (id = ? OR (message_transaction_id = ? AND target_id = ?))
       LIMIT 1`,
    ).get(
      transaction.roomId, input.intentId, input.origin.messageId, input.origin.targetOutcomeId,
    ) as UnknownRow | undefined;
    if (existing !== undefined) {
      if (!sameDirectIntent(existing, input)) {
        throw new DirectIntentAuthorityError("idempotency_conflict");
      }
      const binding = readPersistedDirectBinding(database, input.intentId);
      return Object.freeze({
        disposition: "already-created" as const,
        intentId: input.intentId,
        roomId: transaction.roomId,
        sourceMessageId: input.origin.messageId,
        targetId: input.origin.targetOutcomeId,
        requesterActorId: input.requesterActorId,
        createdAt: input.createdAt,
        binding,
      });
    }

    const binding = readDirectFacts(
      database,
      transaction.roomId,
      input.requesterActorId,
      input.origin,
    );

    database.prepare(
      `INSERT INTO agent_invocation_intents (
         id, room_id, source_message_id, target_agent_id, requester_actor_id,
         intent_kind, execution_id, created_at, message_transaction_id, target_id,
         source_revision, lineage_id, turn_id, origin_kind, status, claimed_at,
         cancelled_at, cancellation_reason, supersedes_intent_id
       ) VALUES (?, ?, ?, ?, ?, 'direct_mention', NULL, ?, ?, ?, 1, ?, ?,
                 'message_target', 'pending', NULL, NULL, NULL, NULL)`,
    ).run(
      input.intentId, transaction.roomId, input.origin.messageId, input.origin.targetActorId,
      input.requesterActorId, input.createdAt, input.origin.messageId,
      input.origin.targetOutcomeId, input.lineageId, input.turnId,
    );
    database.prepare(
      `INSERT INTO direct_agent_invocation_authority_bindings (
         intent_id, profile_id, profile_revision, assignment_id,
         assignment_revision, access_revision
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.intentId,
      binding.profileId,
      binding.profileRevision,
      binding.assignmentId,
      binding.assignmentRevision,
      binding.accessRevision,
    );
    return Object.freeze({
      disposition: "created" as const,
      intentId: input.intentId,
      roomId: transaction.roomId,
      sourceMessageId: input.origin.messageId,
      targetId: input.origin.targetOutcomeId,
      requesterActorId: input.requesterActorId,
      createdAt: input.createdAt,
      binding,
    });
  });
}

function routedIntent(row: UnknownRow | undefined): RoutedInvocationIntentRecord | undefined {
  if (row === undefined) return undefined;
  if (!text(row.intentId) || !text(row.decisionId) || !text(row.routeJobId) ||
      !text(row.snapshotId) || !text(row.roomId) || !text(row.sourceMessageId) ||
      !positive(row.sourceMessageRevision) || !text(row.actorId) || !text(row.profileId) ||
      !positive(row.profileRevision) || !text(row.assignmentId) ||
      !positive(row.assignmentRevision) || !nonnegative(row.accessRevision) ||
      (row.trigger !== "domain" && row.trigger !== "risk" && row.trigger !== "ball") ||
      !text(row.reasonText) ||
      (row.status !== "pending" && row.status !== "claimed" && row.status !== "cancelled") ||
      !time(row.createdAt) || (row.claimedAt !== null && !time(row.claimedAt)) ||
      (row.cancelledAt !== null && !time(row.cancelledAt)) ||
      (row.cancellationReason !== null && !text(row.cancellationReason))) {
    throw new Error("Routed invocation intent is corrupt");
  }
  return Object.freeze({
    intentId: row.intentId,
    decisionId: row.decisionId,
    routeJobId: row.routeJobId,
    snapshotId: row.snapshotId,
    roomId: row.roomId,
    sourceMessageId: row.sourceMessageId,
    sourceMessageRevision: row.sourceMessageRevision,
    actorId: row.actorId,
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    assignmentId: row.assignmentId,
    assignmentRevision: row.assignmentRevision,
    accessRevision: row.accessRevision,
    trigger: row.trigger,
    reasonText: row.reasonText,
    status: row.status,
    createdAt: row.createdAt,
    ...(row.claimedAt === null ? {} : { claimedAt: row.claimedAt as string }),
    ...(row.cancelledAt === null ? {} : { cancelledAt: row.cancelledAt as string }),
    ...(row.cancellationReason === null ? {} : {
      cancellationReason: row.cancellationReason as string,
    }),
  });
}

const routedIntentSelect = `
  SELECT id AS intentId, route_decision_id AS decisionId, route_job_id AS routeJobId,
         snapshot_id AS snapshotId, room_id AS roomId, source_message_id AS sourceMessageId,
         source_message_revision AS sourceMessageRevision,
         target_agent_actor_id AS actorId, profile_id AS profileId,
         profile_revision AS profileRevision, assignment_id AS assignmentId,
         assignment_revision AS assignmentRevision, access_revision AS accessRevision,
         trigger_kind AS trigger, reason_text AS reasonText, status, created_at AS createdAt,
         claimed_at AS claimedAt, cancelled_at AS cancelledAt,
         cancellation_reason AS cancellationReason
  FROM routed_agent_invocation_intents`;

function readRoutedIntentFromDatabase(
  database: import("node:sqlite").DatabaseSync,
  roomId: string,
  intentId: string,
): RoutedInvocationIntentRecord | undefined {
  return routedIntent(database.prepare(
    `${routedIntentSelect} WHERE room_id = ? AND id = ?`,
  ).get(roomId, intentId) as UnknownRow | undefined);
}

export function readRoutedInvocationIntent(
  transaction: AuthorityTransactionView,
  intentId: string,
): RoutedInvocationIntentRecord | undefined {
  requireText(intentId, "Routed intent id");
  return useAuthorityTransactionDatabase(transaction, (database) =>
    readRoutedIntentFromDatabase(database, transaction.roomId, intentId));
}

export function readPendingRoutedInvocationIntents(
  transaction: AuthorityTransactionView,
  limit = 256,
): readonly RoutedInvocationIntentRecord[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new TypeError("Routed intent recovery limit is invalid");
  }
  return useAuthorityTransactionDatabase(transaction, (database) => Object.freeze(
    (database.prepare(
      `${routedIntentSelect}
       WHERE room_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT ?`,
    ).all(transaction.roomId, limit) as unknown as UnknownRow[]).map((row) => routedIntent(row)!),
  ));
}

/**
 * Restart seam: pending rows are the queue. No in-memory lease is required, so
 * a new AuthorityWorker discovers the same bounded Room-local set.
 */
export function recoverPendingRoutedInvocationIntents(
  transaction: AuthorityTransactionView,
  limit = 256,
): readonly RoutedInvocationIntentRecord[] {
  return readPendingRoutedInvocationIntents(transaction, limit);
}

interface RoutedClaimFacts extends UnknownRow {
  readonly provenanceValid: number;
}

function readClaimFacts(
  database: import("node:sqlite").DatabaseSync,
  roomId: string,
  intentId: string,
): RoutedClaimFacts | undefined {
  return database.prepare(
    `SELECT intent.id AS intentId, room.status AS roomStatus,
            decision.expected_route_job_revision AS expectedRouteJobRevision,
            job.revision AS routeJobRevision,
            source.author_kind AS sourceAuthorKind,
            envelope.message_kind AS sourceMessageKind,
            envelope.lifecycle AS sourceLifecycle,
            envelope.current_revision AS currentSourceRevision,
            profile.actor_id AS profileActorId, profile.revision AS currentProfileRevision,
            profile.status AS profileStatus,
            assignment.profile_id AS assignmentProfileId,
            assignment.agent_actor_id AS assignmentActorId,
            assignment.revision AS currentAssignmentRevision,
            assignment.status AS assignmentStatus,
            assignment.participation AS assignmentParticipation,
            assignment.paused AS assignmentPaused,
            membership.kind AS membershipKind,
            membership.access_revision AS currentAccessRevision,
            (SELECT COUNT(*) FROM agent_executions AS execution
             WHERE execution.agent_id = intent.target_agent_actor_id
               AND execution.status = 'running') AS runningExecutionCount,
            CASE WHEN decision.id IS NOT NULL AND decision.outcome = 'selected'
              AND snapshot.id IS NOT NULL AND snapshot.room_id = intent.room_id
              AND snapshot.source_message_id = intent.source_message_id
              AND snapshot.source_message_revision = intent.source_message_revision
              AND snapshot.source_author_kind = 'human'
              AND snapshot.source_message_kind = 'human'
              AND job.id IS NOT NULL AND job.room_id = intent.room_id
              AND job.source_message_id = intent.source_message_id
              AND job.candidate_snapshot_id = intent.snapshot_id
              AND candidate.agent_actor_id IS NOT NULL
              AND candidate.participation = 'active' AND candidate.availability = 'ready'
              THEN 1 ELSE 0 END AS provenanceValid
     FROM routed_agent_invocation_intents AS intent
     LEFT JOIN rooms AS room ON room.id = intent.room_id
     LEFT JOIN route_decisions AS decision
       ON decision.id = intent.route_decision_id
      AND decision.route_job_id = intent.route_job_id
      AND decision.snapshot_id = intent.snapshot_id
     LEFT JOIN route_candidate_snapshots AS snapshot
       ON snapshot.id = intent.snapshot_id AND snapshot.route_job_id = intent.route_job_id
     LEFT JOIN route_jobs AS job ON job.id = intent.route_job_id
     LEFT JOIN route_candidate_snapshot_agents AS candidate
       ON candidate.snapshot_id = intent.snapshot_id
      AND candidate.route_job_id = intent.route_job_id
      AND candidate.agent_actor_id = intent.target_agent_actor_id
      AND candidate.profile_id = intent.profile_id
      AND candidate.profile_revision = intent.profile_revision
      AND candidate.assignment_id = intent.assignment_id
      AND candidate.assignment_revision = intent.assignment_revision
      AND candidate.access_revision = intent.access_revision
     LEFT JOIN messages AS source
       ON source.id = intent.source_message_id AND source.room_id = intent.room_id
     LEFT JOIN message_envelopes AS envelope
       ON envelope.message_id = intent.source_message_id AND envelope.room_id = intent.room_id
     LEFT JOIN agent_profiles AS profile ON profile.id = intent.profile_id
     LEFT JOIN room_agent_assignments AS assignment ON assignment.id = intent.assignment_id
     LEFT JOIN room_memberships AS membership
       ON membership.room_id = intent.room_id
      AND membership.actor_id = intent.target_agent_actor_id
     WHERE intent.room_id = ? AND intent.id = ?`,
  ).get(roomId, intentId) as RoutedClaimFacts | undefined;
}

function cancellationReason(
  intent: RoutedInvocationIntentRecord,
  facts: RoutedClaimFacts | undefined,
  providerReady: boolean,
): RoutedIntentCancellationReason | undefined {
  if (facts === undefined || facts.provenanceValid !== 1) return "route_provenance_invalid";
  if (facts.routeJobRevision !== facts.expectedRouteJobRevision) return "route_revision_stale";
  if (facts.sourceAuthorKind !== "human" || facts.sourceMessageKind !== "human" ||
      facts.sourceLifecycle !== "active" || facts.currentSourceRevision !== intent.sourceMessageRevision) {
    return "source_revision_stale";
  }
  if (facts.roomStatus !== "active") return "room_archived";
  if (facts.profileActorId !== intent.actorId || facts.profileStatus !== "enabled") {
    return "profile_unavailable";
  }
  if (facts.currentProfileRevision !== intent.profileRevision) return "profile_revision_stale";
  if (facts.assignmentActorId !== intent.actorId || facts.assignmentProfileId !== intent.profileId ||
      facts.assignmentStatus !== "current") return "assignment_removed";
  if (facts.assignmentPaused === 1) return "assignment_paused";
  if (facts.assignmentParticipation !== "active") return "assignment_inactive";
  if (facts.currentAssignmentRevision !== intent.assignmentRevision) {
    return "assignment_revision_stale";
  }
  if (facts.membershipKind !== "agent") return "access_revoked";
  if (facts.currentAccessRevision !== intent.accessRevision) return "access_revision_stale";
  if (!providerReady) return "noauth";
  if (typeof facts.runningExecutionCount !== "number" || facts.runningExecutionCount > 0) {
    return "busy";
  }
  return undefined;
}

function handoff(intent: RoutedInvocationIntentRecord): AcceptedRoutedIntentHandoff {
  return Object.freeze({
    intentId: intent.intentId,
    roomId: intent.roomId,
    sourceMessageId: intent.sourceMessageId,
    sourceMessageRevision: intent.sourceMessageRevision,
    actorId: intent.actorId,
    profileId: intent.profileId,
    profileRevision: intent.profileRevision,
    assignmentId: intent.assignmentId,
    assignmentRevision: intent.assignmentRevision,
    accessRevision: intent.accessRevision,
    trigger: intent.trigger,
    reasonText: intent.reasonText,
  });
}

export function claimRoutedInvocationIntent(
  transaction: AuthorityTransactionView,
  input: ClaimRoutedInvocationIntentInput,
): ClaimRoutedInvocationIntentResult {
  if (!exact(input, ["intentId", "claimedAt", "providerReady"])) {
    throw new TypeError("Routed intent claim input is invalid");
  }
  requireText(input.intentId, "Routed intent id");
  if (!time(input.claimedAt)) throw new TypeError("Routed intent claim time is invalid");
  if (typeof input.providerReady !== "boolean") {
    throw new TypeError("Routed intent provider authority is invalid");
  }
  return useAuthorityTransactionDatabase(transaction, (database) => {
    const current = readRoutedIntentFromDatabase(database, transaction.roomId, input.intentId);
    if (current === undefined) throw new Error("Routed invocation intent is unavailable");
    if (current.status === "claimed") {
      return Object.freeze({
        disposition: "already-claimed" as const,
        intent: current,
        handoff: handoff(current),
      });
    }
    if (current.status === "cancelled") {
      return Object.freeze({ disposition: "already-cancelled" as const, intent: current });
    }

    const reason = cancellationReason(
      current,
      readClaimFacts(database, transaction.roomId, input.intentId),
      input.providerReady,
    );
    if (reason !== undefined) {
      const result = database.prepare(
        `UPDATE routed_agent_invocation_intents
         SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ?
         WHERE room_id = ? AND id = ? AND status = 'pending'`,
      ).run(input.claimedAt, reason, transaction.roomId, input.intentId);
      if (result.changes !== 1) throw new Error("Routed invocation intent changed concurrently");
      return Object.freeze({
        disposition: "cancelled" as const,
        intent: readRoutedIntentFromDatabase(database, transaction.roomId, input.intentId)!,
      });
    }

    const result = database.prepare(
      `UPDATE routed_agent_invocation_intents
       SET status = 'claimed', claimed_at = ?
       WHERE room_id = ? AND id = ? AND status = 'pending'`,
    ).run(input.claimedAt, transaction.roomId, input.intentId);
    if (result.changes !== 1) throw new Error("Routed invocation intent changed concurrently");
    const claimed = readRoutedIntentFromDatabase(database, transaction.roomId, input.intentId)!;
    return Object.freeze({
      disposition: "claimed" as const,
      intent: claimed,
      handoff: handoff(claimed),
    });
  });
}
