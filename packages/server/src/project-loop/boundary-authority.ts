import type { DatabaseSync } from "node:sqlite";
import type { AuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import { useAuthorityTransactionDatabase } from
  "../persistence/authority-transaction-database.js";
import { ProjectLoopAuthorityError } from "./database-authority.js";

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
