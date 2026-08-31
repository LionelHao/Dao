import {
  isRoomAgentAssignmentProjection,
  type RoomRepairRecord,
} from "@native-im/core";
import type {
  RepairKeysetPageInput,
  RoomRepairSegmentDescriptor,
} from "../persistence/repair-projection-registry.js";

type AssignmentRepairRecord = Extract<RoomRepairRecord, {
  readonly kind: "room-agent-assignment";
}>;

type Row = Record<string, unknown>;

function invalid(): never {
  throw new TypeError("Room Agent Assignment repair projection is invalid");
}

function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : invalid();
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalid();
}

function positive(value: unknown): number {
  const result = count(value);
  return result > 0 ? result : invalid();
}

function canonicalSet(value: unknown): readonly string[] {
  if (typeof value !== "string") return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid();
  }
  if (!Array.isArray(parsed) || !parsed.every((entry, index) =>
    typeof entry === "string" && entry.length > 0 &&
    (index === 0 || (parsed[index - 1] as string) < entry))) {
    return invalid();
  }
  return Object.freeze(parsed);
}

function assignmentRecord(
  row: Row,
  credentialReadiness: "ready" | "noauth",
): AssignmentRepairRecord {
  const paused = row.paused === 1;
  if (!paused && row.paused !== 0) return invalid();
  const running = count(row.runningExecutionCount);
  const capabilityCeiling = canonicalSet(row.capabilityCeilingJson);
  const capabilitySubset = canonicalSet(row.capabilitySubsetJson);
  const toolCeiling = canonicalSet(row.toolCeilingJson);
  const toolSubset = canonicalSet(row.toolSubsetJson);
  const membershipTools = new Set(canonicalSet(row.membershipToolsJson));
  if (capabilitySubset.some((value) => !capabilityCeiling.includes(value)) ||
      toolSubset.some((value) => !toolCeiling.includes(value))) return invalid();

  const value = Object.freeze({
    recordVersion: "room-agent-assignment.v1" as const,
    assignmentId: text(row.assignmentId),
    roomId: text(row.roomId),
    profileId: text(row.profileId),
    actorId: text(row.actorId),
    displayName: text(row.displayName),
    globalResponsibility: text(row.globalResponsibility),
    roomResponsibility: text(row.roomResponsibility),
    participation: row.participation === "active" || row.participation === "on-mention"
      ? row.participation
      : invalid(),
    availability: paused
      ? "paused" as const
      : credentialReadiness === "noauth"
        ? "noauth" as const
        : running > 0
          ? "busy" as const
          : "ready" as const,
    paused,
    capabilityCeiling,
    capabilitySubset,
    effectiveCapabilities: capabilitySubset,
    toolCeiling,
    toolSubset,
    effectiveTools: Object.freeze(toolSubset.filter((value) => membershipTools.has(value))),
    profileRevision: positive(row.profileRevision),
    assignmentRevision: positive(row.assignmentRevision),
    accessRevision: count(row.accessRevision),
    updatedAt: text(row.updatedAt),
  });
  if (!isRoomAgentAssignmentProjection(value, value.roomId)) return invalid();
  return Object.freeze({ kind: "room-agent-assignment" as const, value });
}

export function createRoomAssignmentRepairSegmentDescriptor(
  credentialReadiness: "ready" | "noauth",
): RoomRepairSegmentDescriptor<RoomRepairRecord["kind"], RoomRepairRecord> {
  if (credentialReadiness !== "ready" && credentialReadiness !== "noauth") return invalid();
  return Object.freeze({
    descriptorId: "dao.repair.room-agent-assignment.v1",
    descriptorVersion: 1 as const,
    kind: "room-agent-assignment" as const,
    order: 26,
    readKeysetPage(input: RepairKeysetPageInput) {
      return input.database.prepare(`
        SELECT assignment.id AS assignmentId, assignment.room_id AS roomId,
               assignment.profile_id AS profileId, assignment.agent_actor_id AS actorId,
               assignment.room_responsibility AS roomResponsibility,
               assignment.participation, assignment.paused,
               assignment.capability_subset_json AS capabilitySubsetJson,
               assignment.tool_subset_json AS toolSubsetJson,
               assignment.revision AS assignmentRevision, assignment.updated_at AS updatedAt,
               profile.display_name AS displayName,
               profile.global_responsibility AS globalResponsibility,
               profile.capability_ceiling_json AS capabilityCeilingJson,
               profile.tool_ceiling_json AS toolCeilingJson,
               profile.revision AS profileRevision,
               membership.access_revision AS accessRevision,
               membership.tool_permissions_json AS membershipToolsJson,
               (SELECT COUNT(*) FROM agent_executions AS execution
                WHERE execution.agent_id = assignment.agent_actor_id
                  AND execution.status = 'running') AS runningExecutionCount
        FROM room_agent_assignments AS assignment
        JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
        JOIN rooms AS room ON room.id = assignment.room_id
        JOIN room_memberships AS membership
          ON membership.room_id = assignment.room_id
         AND membership.actor_id = assignment.agent_actor_id
         AND membership.kind = 'agent'
        WHERE assignment.room_id = ? AND assignment.status = 'current'
          AND profile.status = 'enabled' AND room.status = 'active'
          AND assignment.id > ?
        ORDER BY assignment.id
        LIMIT ?
      `).all(input.roomId, input.afterKey ?? "", input.limit);
    },
    mapRow(row: unknown): AssignmentRepairRecord {
      if (typeof row !== "object" || row === null || Array.isArray(row)) return invalid();
      return assignmentRecord(row as Row, credentialReadiness);
    },
    stableKey(record: RoomRepairRecord): string {
      if (record.kind !== "room-agent-assignment" ||
          !isRoomAgentAssignmentProjection(record.value)) return invalid();
      return record.value.assignmentId;
    },
  });
}
