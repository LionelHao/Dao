import type { DatabaseSync } from "node:sqlite";
import type { ProactiveRouteProjectFactsReadiness } from
  "../route-runtime/route-runtime-service.js";

/** Internal, body-free FT-07 routing gate backed only by current FT-09 authority. */
export function readProjectRouteFactsInTransaction(
  database: DatabaseSync,
  roomId: string,
): ProactiveRouteProjectFactsReadiness {
  if (roomId.length === 0) throw new TypeError("Project route facts room was invalid");
  const row = database.prepare(
    `SELECT state.revision AS projectRevision, goal.revision AS goalRevision
     FROM rooms AS room
     JOIN project_room_states AS state ON state.room_id = room.id
     JOIN project_goals AS goal ON goal.room_id = room.id AND goal.status = 'active'
     WHERE room.id = ? AND room.status = 'active'`,
  ).get(roomId);
  if (row === undefined) return Object.freeze({ status: "dependency_unavailable" as const });
  if (typeof row.projectRevision !== "number" || !Number.isSafeInteger(row.projectRevision) ||
      row.projectRevision < 1 || typeof row.goalRevision !== "number" ||
      !Number.isSafeInteger(row.goalRevision) || row.goalRevision < 1) {
    throw new Error("Project route facts authority was corrupt");
  }
  return Object.freeze({ status: "ready" as const,
    goalRevision: row.goalRevision, projectRevision: row.projectRevision });
}
