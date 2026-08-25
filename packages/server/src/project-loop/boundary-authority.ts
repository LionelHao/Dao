import type { DatabaseSync } from "node:sqlite";
import type { AuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import { useAuthorityTransactionDatabase } from
  "../persistence/authority-transaction-database.js";
import {
  advanceProjectLoopTimedTransitionsInTransaction,
  ProjectLoopAuthorityError,
} from "./database-authority.js";
import type {
  PersistedProjectBoundary,
  ProjectLoopArchiveResult,
  ProjectLoopLifecycleInput,
  ProjectLoopLifecycleTransactionParticipant,
  ProjectLoopReopenResult,
  ProjectReminderAuthorityPort,
  ProjectReminderClaimResult,
  ProjectReminderScanResult,
} from "./project-boundary-runtime-service.js";
import {
  currentProjectReminderOrdinal,
  PROJECT_REMINDER_SCAN_LIMITS,
} from "./project-boundary-runtime-service.js";
import { createHash } from "node:crypto";

export type EligibleProjectBoundary = Readonly<{
  boundaryId: string;
  roomId: string;
  sourceKind: string;
  sourceId: string;
  sourceRevision: number;
  holderKind: "human" | "agent";
  holderActorId: string;
  reason: string;
  dueAt: string | null;
}>;

function boundary(row: Record<string, unknown>): EligibleProjectBoundary {
  if (typeof row.boundaryId !== "string" || typeof row.roomId !== "string" ||
      typeof row.sourceKind !== "string" || typeof row.sourceId !== "string" ||
      typeof row.sourceRevision !== "number" ||
      (row.holderKind !== "human" && row.holderKind !== "agent") ||
      typeof row.holderActorId !== "string" || typeof row.reason !== "string" ||
      (row.dueAt !== null && typeof row.dueAt !== "string")) {
    throw new ProjectLoopAuthorityError("storage_unavailable", "Project boundary row is corrupt");
  }
  return Object.freeze({ boundaryId: row.boundaryId, roomId: row.roomId,
    sourceKind: row.sourceKind, sourceId: row.sourceId, sourceRevision: row.sourceRevision,
    holderKind: row.holderKind, holderActorId: row.holderActorId,
    reason: row.reason, dueAt: row.dueAt });
}

export function listEligibleProjectBoundariesDatabaseQuery(database: DatabaseSync, input: {
  roomId: string; now: number; limit: number;
}): readonly EligibleProjectBoundary[] {
  if (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isSafeInteger(input.limit) ||
      input.limit < 1 || input.limit > 200) {
    throw new ProjectLoopAuthorityError("invalid_request", "Project boundary query is invalid");
  }
  const now = new Date(input.now).toISOString();
  const rows = database.prepare(
    `SELECT boundary_id AS boundaryId, room_id AS roomId, source_kind AS sourceKind,
            source_id AS sourceId, source_revision AS sourceRevision,
            holder_kind AS holderKind, holder_actor_id AS holderActorId, reason, due_at AS dueAt
     FROM project_ball_boundaries
     WHERE room_id = ? AND status = 'active'
       AND (holder_kind = 'agent' OR (due_at IS NOT NULL AND due_at <= ?))
     ORDER BY COALESCE(due_at, since), boundary_id LIMIT ?`,
  ).all(input.roomId, now, input.limit) as readonly Record<string, unknown>[];
  return Object.freeze(rows.map(boundary));
}

export function listConfirmedProjectCheckpointsDatabaseQuery(database: DatabaseSync, input: {
  roomId: string; afterRevision: number; limit: number;
}): readonly Readonly<{ checkpointId: string; projectRevision: number;
  projectionJson: string; projectionSha256: string; createdAt: string }>[] {
  return Object.freeze(database.prepare(
    `SELECT checkpoint_id AS checkpointId, project_revision AS projectRevision,
            projection_json AS projectionJson, projection_sha256 AS projectionSha256,
            created_at AS createdAt
     FROM project_fact_checkpoints WHERE room_id = ? AND project_revision > ?
     ORDER BY project_revision, checkpoint_id LIMIT ?`,
  ).all(input.roomId, input.afterRevision, input.limit) as unknown as readonly Readonly<{
    checkpointId: string; projectRevision: number; projectionJson: string;
    projectionSha256: string; createdAt: string;
  }>[]);
}

type ReminderBoundaryRow = Readonly<{
  boundaryId: string; roomId: string; sourceKind: string; sourceId: string;
  sourceRevision: number; holderKind: "human" | "agent"; holderActorId: string;
  reason: string; since: string; dueAt: string; lifecycleGeneration: number;
}>;

function sourceState(database: DatabaseSync, row: ReminderBoundaryRow):
  Readonly<{ kind: PersistedProjectBoundary["sourceKind"]; current: boolean }> {
  if (row.sourceKind === "next_action") {
    const fact = database.prepare(
      `SELECT revision, status FROM project_next_actions WHERE room_id = ? AND id = ?`,
    ).get(row.roomId, row.sourceId);
    return { kind: "next_action", current: fact?.revision === row.sourceRevision &&
      (fact.status === "accepted" || fact.status === "in_progress" || fact.status === "delivered") };
  }
  if (row.sourceKind === "request") {
    const fact = database.prepare(
      `SELECT revision, status FROM project_requests WHERE room_id = ? AND id = ?`,
    ).get(row.roomId, row.sourceId);
    return { kind: "request", current: fact?.revision === row.sourceRevision &&
      fact.status === "pending_acceptance" };
  }
  if (row.sourceKind === "blocker" || row.sourceKind === "open_question" ||
      row.sourceKind === "review") {
    const fact = database.prepare(
      `SELECT revision, kind, status FROM project_obstacles WHERE room_id = ? AND id = ?`,
    ).get(row.roomId, row.sourceId);
    const kind = fact?.kind === "open_question" ? "open_question" as const : "blocker" as const;
    return { kind, current: fact?.revision === row.sourceRevision &&
      (fact.status === "open" || fact.status === "deferred" || fact.status === "cannot_answer") };
  }
  if (row.sourceKind === "confirmation") {
    if (row.sourceId.startsWith("project-checkpoint:")) {
      const checkpoint = database.prepare(
        `SELECT project_revision AS revision FROM project_fact_checkpoints
         WHERE room_id = ? AND checkpoint_id = ?`,
      ).get(row.roomId, row.sourceId);
      return { kind: "confirmation", current: checkpoint?.revision === row.sourceRevision };
    }
    const proposalId = row.sourceId.startsWith("confirmation:")
      ? row.sourceId.slice("confirmation:".length) : row.sourceId;
    const proposal = database.prepare(
      `SELECT revision, status FROM project_fact_proposals WHERE room_id = ? AND id = ?`,
    ).get(row.roomId, proposalId);
    return { kind: "confirmation", current: proposal?.revision === row.sourceRevision &&
      proposal.status === "pending" };
  }
  if (row.sourceKind === "transfer") {
    const proposal = database.prepare(
      `SELECT revision, status FROM project_transfer_proposals WHERE room_id = ? AND id = ?`,
    ).get(row.roomId, row.sourceId);
    return { kind: "transfer", current: proposal?.revision === row.sourceRevision &&
      (proposal.status === "pending" || proposal.status === "expired") };
  }
  if (row.sourceKind === "due") {
    const parent = database.prepare(
      `SELECT boundary_id AS boundaryId, room_id AS roomId, source_kind AS sourceKind,
              source_id AS sourceId, source_revision AS sourceRevision,
              holder_kind AS holderKind, holder_actor_id AS holderActorId,
              reason, since, due_at AS dueAt, lifecycle_generation AS lifecycleGeneration,
              status
       FROM project_ball_boundaries WHERE boundary_id = ? AND room_id = ?`,
    ).get(row.sourceId, row.roomId) as (ReminderBoundaryRow & { status: string }) | undefined;
    return { kind: "due", current: parent !== undefined && parent.status === "active" &&
      parent.sourceRevision === row.sourceRevision && parent.holderKind === row.holderKind &&
      parent.holderActorId === row.holderActorId && parent.sourceKind !== "due" &&
      sourceState(database, parent).current };
  }
  return { kind: "next_action", current: false };
}

function currentReminderBoundary(database: DatabaseSync, row: ReminderBoundaryRow,
  now: string): PersistedProjectBoundary | undefined {
  const authority = database.prepare(
    `SELECT room.status AS roomStatus, membership.kind AS membershipKind,
            assignment.status AS assignmentStatus, assignment.paused AS assignmentPaused
     FROM rooms AS room
     LEFT JOIN room_memberships AS membership
       ON membership.room_id = room.id AND membership.actor_id = ?
     LEFT JOIN room_agent_assignments AS assignment
       ON assignment.room_id = room.id AND assignment.agent_actor_id = ?
          AND assignment.status = 'current'
     WHERE room.id = ? AND room.archive_generation = ?`,
  ).get(row.holderActorId, row.holderActorId, row.roomId, row.lifecycleGeneration);
  if (authority?.roomStatus !== "active" || authority.membershipKind !== row.holderKind ||
      (row.holderKind === "agent" &&
        (authority.assignmentStatus !== "current" || authority.assignmentPaused !== 0))) return undefined;
  if (row.dueAt > now) return undefined;
  const source = sourceState(database, row);
  if (!source.current) return undefined;
  return Object.freeze({
    recordVersion: "project-boundary.v1", boundaryId: row.boundaryId,
    roomId: row.roomId, projectId: row.roomId,
    boundaryKind: row.sourceKind === "review" ? "review" :
      row.sourceKind === "confirmation" ? "checkpoint" :
      row.sourceKind === "due" || row.sourceKind === "transfer" ? "due" :
      row.holderKind === "agent" ? "agent_ball" : source.kind === "blocker" ||
        source.kind === "open_question" ? "blocker" : "due",
    sourceKind: source.kind, sourceId: row.sourceId, sourceRevision: row.sourceRevision,
    holder: Object.freeze({ kind: row.holderKind, actorId: row.holderActorId }),
    lifecycleGeneration: row.lifecycleGeneration, status: "active",
    confirmed: true, consumed: false,
    dueAt: row.sourceKind === "review" ? null : row.dueAt,
    reviewAt: row.sourceKind === "review" ? row.dueAt : null,
    createdAt: row.since,
  });
}

function reminderRows(database: DatabaseSync, input: Readonly<{
  now: string; limit: number; agentProviderReady: boolean;
}>): ReminderBoundaryRow[] {
  return database.prepare(
    `SELECT boundary.boundary_id AS boundaryId, boundary.room_id AS roomId,
            boundary.source_kind AS sourceKind, boundary.source_id AS sourceId,
            boundary.source_revision AS sourceRevision, boundary.holder_kind AS holderKind,
            boundary.holder_actor_id AS holderActorId, boundary.reason, boundary.since,
            boundary.due_at AS dueAt, boundary.lifecycle_generation AS lifecycleGeneration
     FROM project_ball_boundaries AS boundary
     JOIN rooms AS room ON room.id = boundary.room_id
     WHERE boundary.status = 'active' AND boundary.due_at IS NOT NULL
       AND boundary.source_kind IN ('due', 'review', 'confirmation', 'transfer')
       AND boundary.due_at <= ? AND room.status = 'active'
       AND (? = 1 OR boundary.holder_kind = 'human')
       AND (
         (boundary.holder_kind = 'human' AND EXISTS (
           SELECT 1 FROM room_memberships AS membership
           WHERE membership.room_id = boundary.room_id
             AND membership.actor_id = boundary.holder_actor_id
             AND membership.kind = 'human'
         )) OR
         (boundary.holder_kind = 'agent' AND EXISTS (
           SELECT 1 FROM room_memberships AS membership
           JOIN agent_profiles AS profile
             ON profile.actor_id = membership.actor_id AND profile.status = 'enabled'
           JOIN room_agent_assignments AS assignment
             ON assignment.room_id = membership.room_id
            AND assignment.agent_actor_id = membership.actor_id
            AND assignment.status = 'current' AND assignment.participation = 'active'
            AND assignment.paused = 0
           WHERE membership.room_id = boundary.room_id
             AND membership.actor_id = boundary.holder_actor_id
             AND membership.kind = 'agent' AND membership.participation = 'active'
             AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
                         WHERE value = 'room.project.read')
             AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
                         WHERE value = 'room.respond')
             AND EXISTS (SELECT 1 FROM json_each(profile.capability_ceiling_json)
                         WHERE value = 'room.project.read')
             AND EXISTS (SELECT 1 FROM json_each(profile.capability_ceiling_json)
                         WHERE value = 'room.respond')
         ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM project_due_reminder_claims AS claim
         WHERE claim.room_id = boundary.room_id
           AND claim.boundary_id = boundary.boundary_id
           AND claim.recipient_actor_id = boundary.holder_actor_id
           AND claim.reminder_ordinal = CAST(
             (julianday(?) - julianday(boundary.due_at)) AS INTEGER
           )
           AND claim.reminder_kind = CASE
             WHEN boundary.source_kind = 'review' THEN 'review'
             WHEN CAST((julianday(?) - julianday(boundary.due_at)) AS INTEGER) = 0
               THEN 'initial_due'
             ELSE 'repeat_24h'
           END
       )
     ORDER BY boundary.due_at, boundary.boundary_id LIMIT ?`,
  ).all(input.now, input.agentProviderReady ? 1 : 0, input.now, input.now,
    input.limit) as unknown as ReminderBoundaryRow[];
}

function createReachedDueBoundariesInTransaction(database: DatabaseSync,
  now: string, limit: number, agentProviderReady: boolean): number {
  const rows = database.prepare(
    `SELECT boundary.boundary_id AS boundaryId, boundary.room_id AS roomId,
            boundary.source_kind AS sourceKind, boundary.source_id AS sourceId,
            boundary.source_revision AS sourceRevision, boundary.reason, boundary.since,
            boundary.lifecycle_generation AS lifecycleGeneration,
            boundary.holder_kind AS holderKind, boundary.holder_actor_id AS holderActorId,
            boundary.due_at AS dueAt
     FROM project_ball_boundaries AS boundary
     JOIN rooms AS room ON room.id = boundary.room_id
     WHERE boundary.status = 'active' AND boundary.due_at IS NOT NULL
       AND boundary.due_at <= ? AND room.status = 'active'
       AND boundary.source_kind NOT IN ('due', 'review', 'confirmation', 'transfer')
       AND (? = 1 OR boundary.holder_kind = 'human')
       AND (
         (boundary.holder_kind = 'human' AND EXISTS (
           SELECT 1 FROM room_memberships AS membership
           WHERE membership.room_id = boundary.room_id
             AND membership.actor_id = boundary.holder_actor_id
             AND membership.kind = 'human'
         )) OR
         (boundary.holder_kind = 'agent' AND EXISTS (
           SELECT 1 FROM room_memberships AS membership
           JOIN agent_profiles AS profile
             ON profile.actor_id = membership.actor_id AND profile.status = 'enabled'
           JOIN room_agent_assignments AS assignment
             ON assignment.room_id = membership.room_id
            AND assignment.agent_actor_id = membership.actor_id
            AND assignment.status = 'current' AND assignment.participation = 'active'
            AND assignment.paused = 0
           WHERE membership.room_id = boundary.room_id
             AND membership.actor_id = boundary.holder_actor_id
             AND membership.kind = 'agent' AND membership.participation = 'active'
             AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
                         WHERE value = 'room.project.read')
             AND EXISTS (SELECT 1 FROM json_each(assignment.capability_subset_json)
                         WHERE value = 'room.respond')
             AND EXISTS (SELECT 1 FROM json_each(profile.capability_ceiling_json)
                         WHERE value = 'room.project.read')
             AND EXISTS (SELECT 1 FROM json_each(profile.capability_ceiling_json)
                         WHERE value = 'room.respond')
         ))
       )
       AND NOT EXISTS (
         SELECT 1 FROM project_ball_boundaries AS due
         WHERE due.room_id = boundary.room_id AND due.source_kind = 'due'
           AND due.source_id = boundary.boundary_id AND due.status = 'active'
       )
     ORDER BY boundary.due_at, boundary.boundary_id LIMIT ?`,
  ).all(now, agentProviderReady ? 1 : 0, limit);
  let created = 0;
  for (const row of rows) {
    if (typeof row.boundaryId !== "string" || typeof row.roomId !== "string" ||
        typeof row.sourceRevision !== "number" || typeof row.lifecycleGeneration !== "number" ||
        (row.holderKind !== "human" && row.holderKind !== "agent") ||
        typeof row.holderActorId !== "string" || typeof row.dueAt !== "string") {
      throw new ProjectLoopAuthorityError("storage_unavailable", "Project due boundary row is corrupt");
    }
    const current = sourceState(database, row as ReminderBoundaryRow);
    if (!current.current) {
      database.prepare(
        `UPDATE project_ball_boundaries SET status = 'superseded', released_at = ?
         WHERE boundary_id = ? AND status = 'active'`,
      ).run(now, row.boundaryId);
      continue;
    }
    const boundaryId = `project-ball-${createHash("sha256").update(
      `${row.roomId}\0due\0${row.boundaryId}\0${row.sourceRevision}` +
        `\0${row.lifecycleGeneration}\0${row.holderKind}\0${row.holderActorId}`,
    ).digest("hex")}`;
    database.prepare(
      `INSERT INTO project_ball_boundaries (
         boundary_id, room_id, project_id, source_kind, source_id, source_revision,
         lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at, status
       ) VALUES (?, ?, ?, 'due', ?, ?, ?, ?, ?, 'due', ?, ?, 'active')
       ON CONFLICT(room_id, source_kind, source_id, source_revision, lifecycle_generation)
       DO NOTHING`,
    ).run(boundaryId, row.roomId, row.roomId, row.boundaryId, row.sourceRevision,
      row.lifecycleGeneration, row.holderKind, row.holderActorId, now, row.dueAt);
    created += 1;
  }
  return created;
}

function collectCurrentReminderBoundariesInTransaction(database: DatabaseSync, input: Readonly<{
  now: string; limit: number; agentProviderReady: boolean;
}>): PersistedProjectBoundary[] {
  const current: PersistedProjectBoundary[] = [];
  for (const row of reminderRows(database, input)) {
    const candidate = currentReminderBoundary(database, row, input.now);
    if (candidate !== undefined) {
      current.push(candidate);
      continue;
    }
    database.prepare(
      `UPDATE project_ball_boundaries SET status = 'superseded', released_at = ?
       WHERE boundary_id = ? AND status = 'active'`,
    ).run(input.now, row.boundaryId);
  }
  return current;
}

export type ProjectReminderAgentIntentInput = Readonly<{
  intentId: string; roomId: string; boundaryId: string; sourceKind: string;
  sourceId: string; sourceRevision: number;
  boundaryKind: "due" | "blocker" | "agent_ball";
  agentActorId: string; createdAt: string;
}>;

export type ProjectReminderAgentIntentWriter = (
  database: DatabaseSync,
  input: ProjectReminderAgentIntentInput,
) => void;

export type ProjectReminderDatabaseAdapterOptions = Readonly<{
  /** FT-08-owned writer. It runs synchronously inside this adapter's SQLite transaction. */
  writeAgentInvocationIntentInTransaction: ProjectReminderAgentIntentWriter;
}>;

type ProjectReminderClaimInput = Parameters<ProjectReminderAuthorityPort["claimCurrentBucket"]>[0];

/** The caller owns the surrounding AuthorityWorker transaction. */
export function claimProjectReminderBucketInTransaction(
  database: DatabaseSync,
  input: ProjectReminderClaimInput,
  writeAgentInvocationIntentInTransaction: ProjectReminderAgentIntentWriter,
): ProjectReminderClaimResult {
  const base = { roomId: input.roomId, boundaryId: input.boundaryId,
    reminderOrdinal: input.reminderOrdinal, recipientActorId: input.recipientActorId };
  const raw = database.prepare(
    `SELECT boundary.boundary_id AS boundaryId, boundary.room_id AS roomId,
            boundary.source_kind AS sourceKind, boundary.source_id AS sourceId,
            boundary.source_revision AS sourceRevision, boundary.holder_kind AS holderKind,
            boundary.holder_actor_id AS holderActorId, boundary.reason, boundary.since,
            boundary.due_at AS dueAt, boundary.lifecycle_generation AS lifecycleGeneration
     FROM project_ball_boundaries AS boundary JOIN rooms AS room ON room.id = boundary.room_id
     WHERE boundary.boundary_id = ? AND boundary.room_id = ? AND boundary.status = 'active'`,
  ).get(input.boundaryId, input.roomId) as ReminderBoundaryRow | undefined;
  const current = raw === undefined ? undefined : currentReminderBoundary(database, raw, input.claimedAt);
  const scheduled = current?.boundaryKind === "review" ? current.reviewAt : current?.dueAt;
  const exactOrdinal = scheduled === null || scheduled === undefined ? -1 :
    currentProjectReminderOrdinal(scheduled, input.claimedAt) ?? -1;
  if (current === undefined || current.sourceRevision !== input.sourceRevision ||
      current.lifecycleGeneration !== input.lifecycleGeneration ||
      current.holder.actorId !== input.recipientActorId ||
      (current.holder.kind === "human") !== (input.reminderKind === "human_reminder") ||
      exactOrdinal !== input.reminderOrdinal) {
    return Object.freeze({ status: "ineligible" as const, ...base });
  }
  if (scheduled === null || scheduled === undefined) {
    throw new Error("Current Project reminder boundary has no schedule");
  }
  const reminderKind = current.boundaryKind === "review" ? "review" :
    input.reminderOrdinal === 0 ? "initial_due" : "repeat_24h";
  const claimId = `project-reminder-${createHash("sha256").update(
    `${input.roomId}\0${input.boundaryId}\0${input.sourceRevision}\0${input.lifecycleGeneration}` +
    `\0${reminderKind}\0${input.reminderOrdinal}\0${input.recipientActorId}`,
  ).digest("hex")}`;
  const inserted = database.prepare(
    `INSERT INTO project_due_reminder_claims (
       claim_id, room_id, boundary_id, source_revision, reminder_kind, reminder_ordinal,
       boundary_at, holder_kind, holder_actor_id, recipient_actor_id, status, claimed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)
     ON CONFLICT(room_id, boundary_id, reminder_kind, reminder_ordinal, recipient_actor_id)
     DO NOTHING`,
  ).run(claimId, input.roomId, input.boundaryId, input.sourceRevision, reminderKind,
    input.reminderOrdinal, scheduled, current.holder.kind, current.holder.actorId,
    input.recipientActorId, input.claimedAt);
  if (inserted.changes === 0) {
    return Object.freeze({ status: "duplicate" as const, ...base });
  }
  if (current.holder.kind === "human") {
    const stream = database.prepare(
      `SELECT head_seq AS headSeq FROM streams WHERE stream_kind = 'identity' AND stream_id = ?`,
    ).get(input.recipientActorId);
    if (typeof stream?.headSeq !== "number") throw new Error("Human reminder stream is unavailable");
    const seq = stream.headSeq + 1;
    const advanced = database.prepare(
      `UPDATE streams SET head_seq = ? WHERE stream_kind = 'identity' AND stream_id = ?
         AND head_seq = ?`,
    ).run(seq, input.recipientActorId, stream.headSeq);
    if (advanced.changes !== 1) throw new Error("Human reminder stream compare-and-set failed");
    database.prepare(
      `INSERT INTO events (event_id, stream_kind, stream_id, stream_seq, room_id, actor_id,
         event_type, occurred_at, payload_json)
       VALUES (?, 'identity', ?, ?, NULL, ?, 'project.reminder.due', ?, json(?))`,
    ).run(claimId, input.recipientActorId, seq, input.recipientActorId, input.claimedAt,
      JSON.stringify({ roomId: input.roomId, boundaryId: input.boundaryId,
        sourceKind: current.sourceKind, sourceId: current.sourceId,
        sourceRevision: current.sourceRevision, reminderOrdinal: input.reminderOrdinal }));
    const outboxId = `outbox:${claimId}`;
    database.prepare(
      `INSERT INTO outbox_deliveries (id, event_id, target_kind, target_id, stream_seq,
         status, attempts, available_at, delivered_at, last_error)
       VALUES (?, ?, 'principal', ?, ?, 'pending', 0, ?, NULL, NULL)`,
    ).run(outboxId, claimId, input.recipientActorId, seq, input.claimedAt);
    database.prepare(
      `UPDATE project_due_reminder_claims SET status = 'dispatched', dispatched_at = ?
       WHERE claim_id = ?`,
    ).run(input.claimedAt, claimId);
    return Object.freeze({ status: "claimed" as const, ...base,
      dispatch: Object.freeze({ kind: "human_notification" as const, outboxId }) });
  }
  const intentId = `project-boundary-intent:${createHash("sha256").update(
    `${input.roomId}\0${input.boundaryId}\0${input.sourceRevision}` +
    `\0${input.lifecycleGeneration}\0${input.recipientActorId}`,
  ).digest("hex")}`;
  const existingIntent = database.prepare(
    `SELECT intent_id AS intentId FROM project_boundary_agent_invocation_intents
     WHERE boundary_id = ? AND source_revision = ? AND lifecycle_generation = ?
       AND target_agent_actor_id = ?`,
  ).get(input.boundaryId, input.sourceRevision, input.lifecycleGeneration,
    input.recipientActorId);
  if (existingIntent === undefined) {
    writeAgentInvocationIntentInTransaction(database, {
      intentId, roomId: input.roomId, boundaryId: input.boundaryId,
      sourceKind: current.sourceKind, sourceId: current.sourceId,
      sourceRevision: current.sourceRevision, agentActorId: input.recipientActorId,
      boundaryKind: current.sourceKind === "blocker" || current.sourceKind === "open_question"
          ? "blocker" : "due",
      createdAt: input.claimedAt,
    });
  } else if (existingIntent.intentId !== intentId) {
    throw new Error("Current Project reminder boundary intent identity is corrupt");
  }
  database.prepare(
    `UPDATE project_due_reminder_claims SET status = 'dispatched', dispatched_at = ?
     WHERE claim_id = ?`,
  ).run(input.claimedAt, claimId);
  return Object.freeze({ status: "claimed" as const, ...base,
    dispatch: Object.freeze({ kind: "agent_invocation" as const, intentId }) });
}

/** Bounded global scan executed within one AuthorityWorker-owned transaction. */
export function scanProjectReminderBucketsInTransaction(
  database: DatabaseSync,
  input: Readonly<{ now: string; limit: number; agentProviderReady?: boolean }>,
  writeAgentInvocationIntentInTransaction: ProjectReminderAgentIntentWriter,
): ProjectReminderScanResult {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 ||
      input.limit > PROJECT_REMINDER_SCAN_LIMITS.maxBoundaries ||
      !Number.isFinite(Date.parse(input.now)) || new Date(Date.parse(input.now)).toISOString() !== input.now) {
    throw new TypeError("Project reminder Worker operation input was invalid");
  }
  advanceProjectLoopTimedTransitionsInTransaction(database, {
    now: input.now, limit: input.limit,
  });
  const agentProviderReady = input.agentProviderReady !== false;
  createReachedDueBoundariesInTransaction(database, input.now, input.limit, agentProviderReady);
  const candidates = collectCurrentReminderBoundariesInTransaction(database, {
    now: input.now, limit: input.limit, agentProviderReady,
  });
  const claims: ProjectReminderClaimResult[] = [];
  let ignoredCount = 0;
  for (const candidate of candidates) {
    const scheduled = candidate.boundaryKind === "review" ? candidate.reviewAt : candidate.dueAt;
    if (scheduled === null) { ignoredCount += 1; continue; }
    const ordinal = currentProjectReminderOrdinal(scheduled, input.now);
    if (ordinal === null) { ignoredCount += 1; continue; }
    claims.push(claimProjectReminderBucketInTransaction(database, {
      roomId: candidate.roomId,
      boundaryId: candidate.boundaryId,
      sourceRevision: candidate.sourceRevision,
      lifecycleGeneration: candidate.lifecycleGeneration,
      reminderKind: candidate.holder.kind === "human" ? "human_reminder" : "agent_invocation",
      reminderOrdinal: ordinal,
      recipientActorId: candidate.holder.actorId,
      scheduledAt: new Date(Date.parse(scheduled) + ordinal * 24 * 60 * 60 * 1_000).toISOString(),
      claimedAt: input.now,
    }, writeAgentInvocationIntentInTransaction));
  }
  return Object.freeze({
    scannedCount: candidates.length,
    claimedCount: claims.filter((claim) => claim.status === "claimed").length,
    duplicateCount: claims.filter((claim) => claim.status === "duplicate").length,
    ignoredCount: ignoredCount + claims.filter((claim) => claim.status === "ineligible").length,
    claims: Object.freeze(claims),
  });
}

/** Production SQLite adapter; provider invocation is deliberately outside this transaction seam. */
export function createProjectReminderDatabaseAuthorityPort(database: DatabaseSync,
  options: ProjectReminderDatabaseAdapterOptions): ProjectReminderAuthorityPort {
  return Object.freeze({
    async listEligibleBoundaries(
      input: Parameters<ProjectReminderAuthorityPort["listEligibleBoundaries"]>[0],
    ) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256 ||
          !Number.isFinite(Date.parse(input.now))) throw new TypeError("Project reminder scan is invalid");
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = Object.freeze(collectCurrentReminderBoundariesInTransaction(database, {
          now: input.now, limit: input.limit, agentProviderReady: true,
        }));
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* preserve original */ }
        throw error;
      }
    },
    async claimCurrentBucket(
      input: Parameters<ProjectReminderAuthorityPort["claimCurrentBucket"]>[0],
    ) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = claimProjectReminderBucketInTransaction(
          database, input, options.writeAgentInvocationIntentInTransaction,
        );
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* preserve original */ }
        throw error;
      }
    },
  });
}

type LifecycleBoundaryRow = Readonly<{
  boundaryId: string; roomId: string; sourceKind: string; sourceId: string;
  sourceRevision: number; lifecycleGeneration: number; holderKind: "human" | "agent";
  holderActorId: string; reason: string; since: string; dueAt: string | null;
  releasedAt: string | null;
}>;

function lifecycleRows(database: DatabaseSync, roomId: string, status: "active" | "superseded",
  lifecycleGeneration?: number): LifecycleBoundaryRow[] {
  const suffix = lifecycleGeneration === undefined ? "" : " AND lifecycle_generation = ?";
  const statement = database.prepare(
    `SELECT boundary_id AS boundaryId, room_id AS roomId, source_kind AS sourceKind,
            source_id AS sourceId, source_revision AS sourceRevision,
            lifecycle_generation AS lifecycleGeneration, holder_kind AS holderKind,
            holder_actor_id AS holderActorId, reason, since, due_at AS dueAt,
            released_at AS releasedAt
     FROM project_ball_boundaries WHERE room_id = ? AND status = ?${suffix}
     ORDER BY boundary_id`,
  );
  return (lifecycleGeneration === undefined
    ? statement.all(roomId, status)
    : statement.all(roomId, status, lifecycleGeneration)) as unknown as LifecycleBoundaryRow[];
}

function lifecycleSourceCurrent(database: DatabaseSync, row: LifecycleBoundaryRow): boolean {
  if (row.dueAt === null) {
    const reminderShape = { ...row, dueAt: "1970-01-01T00:00:00.000Z" } as ReminderBoundaryRow;
    return sourceState(database, reminderShape).current;
  }
  return sourceState(database, row as ReminderBoundaryRow).current;
}

function roomLifecycle(database: DatabaseSync, input: ProjectLoopLifecycleInput,
  expectedStatus: "active" | "archived"): void {
  const room = database.prepare(
    "SELECT status, archive_generation AS generation FROM rooms WHERE id = ?",
  ).get(input.roomId);
  if (room?.status !== expectedStatus || room.generation !== input.archiveGeneration) {
    throw new ProjectLoopAuthorityError("revision_conflict", "Project Room lifecycle changed");
  }
}

/** Must be called inside the same SQLite transaction that commits the Room archive. */
export function archiveProjectLoopBoundariesInTransaction(database: DatabaseSync,
  input: ProjectLoopLifecycleInput): ProjectLoopArchiveResult {
  roomLifecycle(database, input, "archived");
  const prior = lifecycleRows(database, input.roomId, "active", input.previousLifecycleGeneration);
  const allActive = lifecycleRows(database, input.roomId, "active");
  if (allActive.length !== prior.length) {
    throw new ProjectLoopAuthorityError("revision_conflict",
      "Project boundary lifecycle generation changed during archive");
  }
  const suspended = prior.filter((row) => lifecycleSourceCurrent(database, row));
  const state = database.prepare(
    "SELECT revision FROM project_room_states WHERE room_id = ?",
  ).get(input.roomId);
  const projectRevision = typeof state?.revision === "number" ? state.revision : 0;
  database.prepare(
    `INSERT INTO project_archive_suspensions (
       room_id, project_id, archive_generation, suspended_project_revision,
       suspended_at, status, resumed_at
     ) VALUES (?, ?, ?, ?, ?, 'suspended', NULL)`,
  ).run(input.roomId, input.roomId, input.archiveGeneration, projectRevision, input.occurredAt);
  for (const row of prior) {
    const updated = database.prepare(
      `UPDATE project_ball_boundaries SET status = 'superseded', released_at = ?
       WHERE boundary_id = ? AND status = 'active' AND lifecycle_generation = ?`,
    ).run(input.occurredAt, row.boundaryId, input.previousLifecycleGeneration);
    if (updated.changes !== 1) {
      throw new ProjectLoopAuthorityError("revision_conflict", "Project boundary changed during archive");
    }
  }
  return Object.freeze({ roomId: input.roomId, archiveGeneration: input.archiveGeneration,
    lifecycleGeneration: input.archiveGeneration, state: "archived",
    suspendedBoundaryCount: suspended.length,
    terminalBoundaryCount: prior.length - suspended.length });
}

/** Must be called inside the same SQLite transaction that commits the Room reopen. */
export function reopenProjectLoopBoundariesInTransaction(database: DatabaseSync,
  input: ProjectLoopLifecycleInput): ProjectLoopReopenResult {
  roomLifecycle(database, input, "active");
  const suspension = database.prepare(
    `SELECT suspended_at AS suspendedAt FROM project_archive_suspensions
     WHERE room_id = ? AND archive_generation = ? AND status = 'suspended'`,
  ).get(input.roomId, input.archiveGeneration);
  if (typeof suspension?.suspendedAt !== "string") {
    throw new ProjectLoopAuthorityError("revision_conflict", "Project archive suspension is unavailable");
  }
  const suspendedAtMs = Date.parse(suspension.suspendedAt);
  const reopenedAtMs = Date.parse(input.occurredAt);
  if (!Number.isFinite(suspendedAtMs) || reopenedAtMs < suspendedAtMs) {
    throw new ProjectLoopAuthorityError("revision_conflict", "Project archive duration is invalid");
  }
  const resumeTimer = (scheduledAt: unknown): string => {
    if (typeof scheduledAt !== "string" || !Number.isFinite(Date.parse(scheduledAt))) {
      throw new ProjectLoopAuthorityError("storage_unavailable", "Project business timer is corrupt");
    }
    return new Date(reopenedAtMs + Math.max(0, Date.parse(scheduledAt) - suspendedAtMs)).toISOString();
  };
  const reviewTimers = database.prepare(
    `SELECT id, review_at AS scheduledAt FROM project_obstacles
     WHERE room_id = ? AND status = 'deferred' AND review_at IS NOT NULL
     ORDER BY id`,
  ).all(input.roomId);
  for (const timer of reviewTimers) {
    if (typeof timer.id !== "string" || typeof timer.scheduledAt !== "string") {
      throw new ProjectLoopAuthorityError("storage_unavailable", "Project review timer row is corrupt");
    }
    const scheduledAt = timer.scheduledAt;
    database.prepare(
      `UPDATE project_obstacles SET review_at = ?
       WHERE room_id = ? AND id = ? AND status = 'deferred' AND review_at = ?`,
    ).run(resumeTimer(scheduledAt), input.roomId, timer.id, scheduledAt);
  }
  const transferTimers = database.prepare(
    `SELECT id, expires_at AS scheduledAt FROM project_transfer_proposals
     WHERE room_id = ? AND status = 'pending' AND expires_at IS NOT NULL
     ORDER BY id`,
  ).all(input.roomId);
  for (const timer of transferTimers) {
    if (typeof timer.id !== "string" || typeof timer.scheduledAt !== "string") {
      throw new ProjectLoopAuthorityError("storage_unavailable", "Project transfer timer row is corrupt");
    }
    const scheduledAt = timer.scheduledAt;
    database.prepare(
      `UPDATE project_transfer_proposals SET expires_at = ?
       WHERE room_id = ? AND id = ? AND status = 'pending' AND expires_at = ?`,
    ).run(resumeTimer(scheduledAt), input.roomId, timer.id, scheduledAt);
  }
  const latest = new Map<string, LifecycleBoundaryRow>();
  for (const row of lifecycleRows(database, input.roomId, "superseded")) {
    if (row.lifecycleGeneration >= input.archiveGeneration || row.releasedAt !== suspension.suspendedAt ||
        !lifecycleSourceCurrent(database, row)) continue;
    const key = `${row.sourceKind}\0${row.sourceId}\0${row.sourceRevision}`;
    const current = latest.get(key);
    if (current === undefined || current.lifecycleGeneration < row.lifecycleGeneration) latest.set(key, row);
  }
  const prior = [...latest.values()].sort((left, right) => left.boundaryId.localeCompare(right.boundaryId));
  let replacements = 0;
  for (const row of prior) {
    const remaining = row.dueAt === null ? null :
      Math.max(0, Date.parse(row.dueAt) - Date.parse(suspension.suspendedAt));
    const resumedDueAt = remaining === null ? null :
      new Date(Date.parse(input.occurredAt) + remaining).toISOString();
    const boundaryId = `project-ball-${createHash("sha256")
      .update(`${row.roomId}\0${row.sourceKind}\0${row.sourceId}\0${row.sourceRevision}` +
        `\0${input.archiveGeneration}\0${row.holderKind}\0${row.holderActorId}`)
      .digest("hex")}`;
    database.prepare(
      `INSERT INTO project_ball_boundaries (
         boundary_id, room_id, project_id, source_kind, source_id, source_revision,
         lifecycle_generation, holder_kind, holder_actor_id, reason, since, due_at,
         status, released_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL)`,
    ).run(boundaryId, row.roomId, row.roomId, row.sourceKind, row.sourceId,
      row.sourceRevision, input.archiveGeneration, row.holderKind, row.holderActorId,
      row.reason, input.occurredAt, resumedDueAt);
    replacements += 1;
  }
  database.prepare(
    `UPDATE project_archive_suspensions SET status = 'resumed', resumed_at = ?
     WHERE room_id = ? AND archive_generation = ? AND status = 'suspended'`,
  ).run(input.occurredAt, input.roomId, input.archiveGeneration);
  return Object.freeze({ roomId: input.roomId, archiveGeneration: input.archiveGeneration,
    lifecycleGeneration: input.archiveGeneration, state: "active",
    resumedBoundaryCount: replacements, replacementBoundaryCount: replacements });
}

export function createProjectLoopLifecycleDatabaseTransactionParticipant(
  database: DatabaseSync,
): ProjectLoopLifecycleTransactionParticipant {
  return Object.freeze({
    archiveInTransaction: (input: ProjectLoopLifecycleInput) =>
      archiveProjectLoopBoundariesInTransaction(database, input),
    reopenInTransaction: (input: ProjectLoopLifecycleInput) =>
      reopenProjectLoopBoundariesInTransaction(database, input),
  });
}

export function listCanonicalResponsibilitiesInTransaction(transaction: AuthorityTransactionView,
  input: { roomId: string; actorId: string }): readonly Readonly<{
    kind: "request" | "next_action" | "blocker" | "open_question";
    id: string; revision: number; status: string;
  }>[] {
  return useAuthorityTransactionDatabase(transaction, (database) => Object.freeze([
    ...database.prepare(
      `SELECT 'request' AS kind, id, revision, status FROM project_requests
       WHERE room_id = ? AND source_kind <> 'legacy_v14' AND
         (requester_human_actor_id = ? OR target_human_actor_id = ?)
         AND status = 'pending_acceptance' ORDER BY id`,
    ).all(input.roomId, input.actorId, input.actorId),
    ...database.prepare(
      `SELECT 'next_action' AS kind, id, revision, status FROM project_next_actions
       WHERE room_id = ? AND source_kind <> 'legacy_v14' AND
         (owner_actor_id = ? OR verifier_human_actor_id = ?)
         AND status IN ('proposed', 'accepted', 'in_progress', 'delivered') ORDER BY id`,
    ).all(input.roomId, input.actorId, input.actorId),
    ...database.prepare(
      `SELECT kind, id, revision, status FROM project_obstacles
       WHERE room_id = ? AND source_kind <> 'legacy_v14' AND owner_actor_id = ?
         AND status IN ('open', 'deferred', 'cannot_answer') ORDER BY kind, id`,
    ).all(input.roomId, input.actorId),
  ] as unknown as readonly Readonly<{
    kind: "request" | "next_action" | "blocker" | "open_question";
    id: string; revision: number; status: string;
  }>[]));
}
