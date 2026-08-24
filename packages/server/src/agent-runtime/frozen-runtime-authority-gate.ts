import type { DatabaseSync } from "node:sqlite";

type UnknownRow = Record<string, unknown>;

export type FrozenRuntimeAuthorityOrigin = "direct" | "routed";
export type FrozenRuntimeToolId =
  | "http-json.read"
  | "repository.git-status"
  | "room-memory.read"
  | "sandbox-file.write";

export type FrozenRuntimeAuthorityRejection =
  | "handoff_missing"
  | "handoff_ambiguous"
  | "profile_disabled"
  | "profile_revision_stale"
  | "assignment_removed"
  | "assignment_paused"
  | "assignment_inactive"
  | "assignment_revision_stale"
  | "access_revoked"
  | "access_revision_stale"
  | "room_inactive"
  | "provider_unavailable"
  | "authority_corrupt";

export class FrozenRuntimeAuthorityError extends Error {
  constructor(readonly reason: FrozenRuntimeAuthorityRejection) {
    super(`Frozen runtime authority rejected: ${reason}`);
    this.name = "FrozenRuntimeAuthorityError";
  }
}

export interface FrozenRuntimeAuthorityHandoff {
  readonly origin: FrozenRuntimeAuthorityOrigin;
  readonly executionId: string;
  readonly intentId: string;
  readonly roomId: string;
  readonly actorId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
  readonly participation: "active" | "on-mention";
  readonly effectiveToolIds: readonly FrozenRuntimeToolId[];
}

const runtimeToolIds = new Set<FrozenRuntimeToolId>([
  "http-json.read",
  "repository.git-status",
  "room-memory.read",
  "sandbox-file.write",
]);

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function jsonStringArray(value: unknown): readonly string[] {
  if (typeof value !== "string") throw new FrozenRuntimeAuthorityError("authority_corrupt");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new FrozenRuntimeAuthorityError("authority_corrupt");
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new FrozenRuntimeAuthorityError("authority_corrupt");
  }
  return parsed;
}

function readOrigin(database: DatabaseSync, executionId: string): UnknownRow {
  const rows = database.prepare(
    `SELECT intent.id AS intentId, intent.origin_kind AS originKind, intent.status,
            intent.lineage_id AS lineageId, intent.room_id AS roomId,
            intent.source_message_id AS sourceMessageId,
            intent.target_agent_id AS actorId,
            execution.room_id AS executionRoomId, execution.agent_id AS executionActorId
     FROM agent_executions AS execution
     JOIN agent_execution_intent_links AS link ON link.execution_id = execution.id
     JOIN agent_invocation_intents AS intent ON intent.id = link.intent_id
     WHERE execution.id = ?`,
  ).all(executionId) as unknown as UnknownRow[];
  if (rows.length === 0) throw new FrozenRuntimeAuthorityError("handoff_missing");
  if (rows.length !== 1) throw new FrozenRuntimeAuthorityError("handoff_ambiguous");
  const row = rows[0]!;
  if (typeof row.intentId !== "string" || typeof row.roomId !== "string" ||
      typeof row.sourceMessageId !== "string" || typeof row.actorId !== "string" ||
      row.status !== "claimed" || row.executionRoomId !== row.roomId ||
      row.executionActorId !== row.actorId) {
    throw new FrozenRuntimeAuthorityError("authority_corrupt");
  }
  return row;
}

function readDirect(database: DatabaseSync, executionId: string, origin: UnknownRow): UnknownRow {
  const row = database.prepare(
    `SELECT binding.profile_id AS profileId,
            binding.profile_revision AS profileRevision,
            binding.assignment_id AS assignmentId,
            binding.assignment_revision AS assignmentRevision,
            binding.access_revision AS accessRevision,
            frozen_profile.actor_id AS frozenProfileActorId,
            frozen_profile.status AS frozenProfileStatus,
            frozen_profile.tool_ceiling_json AS frozenToolCeilingJson,
            frozen_assignment.room_id AS frozenAssignmentRoomId,
            frozen_assignment.profile_id AS frozenAssignmentProfileId,
            frozen_assignment.agent_actor_id AS frozenAssignmentActorId,
            frozen_assignment.status AS frozenAssignmentStatus,
            frozen_assignment.participation AS frozenParticipation,
            frozen_assignment.paused AS frozenAssignmentPaused,
            frozen_assignment.tool_subset_json AS frozenToolSubsetJson,
            profile.actor_id AS profileActorId,
            profile.revision AS currentProfileRevision,
            profile.status AS profileStatus,
            assignment.room_id AS assignmentRoomId,
            assignment.profile_id AS assignmentProfileId,
            assignment.agent_actor_id AS assignmentActorId,
            assignment.revision AS currentAssignmentRevision,
            assignment.status AS assignmentStatus,
            assignment.participation AS currentParticipation,
            assignment.paused AS assignmentPaused,
            membership.kind AS membershipKind,
            membership.participation AS membershipParticipation,
            membership.access_revision AS currentAccessRevision,
            membership.tool_permissions_json AS membershipToolsJson,
            room.status AS roomStatus, actor.kind AS actorKind
     FROM direct_agent_invocation_authority_bindings AS binding
     JOIN agent_profile_revisions AS frozen_profile
       ON frozen_profile.profile_id = binding.profile_id
      AND frozen_profile.revision = binding.profile_revision
     JOIN room_agent_assignment_revisions AS frozen_assignment
       ON frozen_assignment.assignment_id = binding.assignment_id
      AND frozen_assignment.revision = binding.assignment_revision
     LEFT JOIN agent_profiles AS profile ON profile.id = binding.profile_id
     LEFT JOIN room_agent_assignments AS assignment ON assignment.id = binding.assignment_id
     LEFT JOIN room_memberships AS membership
       ON membership.room_id = ? AND membership.actor_id = ?
     LEFT JOIN rooms AS room ON room.id = ?
     LEFT JOIN actors AS actor ON actor.id = ?
     WHERE binding.intent_id = ?`,
  ).get(origin.roomId as string, origin.actorId as string, origin.roomId as string,
    origin.actorId as string, origin.intentId as string) as
    UnknownRow | undefined;
  if (row === undefined) throw new FrozenRuntimeAuthorityError("handoff_missing");
  return { ...row, intentId: origin.intentId, executionId, roomId: origin.roomId,
    actorId: origin.actorId, origin: "direct" };
}

function readRouted(database: DatabaseSync, executionId: string, origin: UnknownRow): UnknownRow {
  if (typeof origin.lineageId !== "string") {
    throw new FrozenRuntimeAuthorityError("handoff_missing");
  }
  const row = database.prepare(
    `SELECT routed.id AS intentId, routed.profile_id AS profileId,
            routed.profile_revision AS profileRevision,
            routed.assignment_id AS assignmentId,
            routed.assignment_revision AS assignmentRevision,
            routed.access_revision AS accessRevision,
            frozen_profile.actor_id AS frozenProfileActorId,
            frozen_profile.status AS frozenProfileStatus,
            frozen_profile.tool_ceiling_json AS frozenToolCeilingJson,
            frozen_assignment.room_id AS frozenAssignmentRoomId,
            frozen_assignment.profile_id AS frozenAssignmentProfileId,
            frozen_assignment.agent_actor_id AS frozenAssignmentActorId,
            frozen_assignment.status AS frozenAssignmentStatus,
            frozen_assignment.participation AS frozenParticipation,
            frozen_assignment.paused AS frozenAssignmentPaused,
            frozen_assignment.tool_subset_json AS frozenToolSubsetJson,
            profile.actor_id AS profileActorId,
            profile.revision AS currentProfileRevision,
            profile.status AS profileStatus,
            assignment.room_id AS assignmentRoomId,
            assignment.profile_id AS assignmentProfileId,
            assignment.agent_actor_id AS assignmentActorId,
            assignment.revision AS currentAssignmentRevision,
            assignment.status AS assignmentStatus,
            assignment.participation AS currentParticipation,
            assignment.paused AS assignmentPaused,
            membership.kind AS membershipKind,
            membership.participation AS membershipParticipation,
            membership.access_revision AS currentAccessRevision,
            membership.tool_permissions_json AS membershipToolsJson,
            room.status AS roomStatus, actor.kind AS actorKind
     FROM routed_agent_invocation_intents AS routed
     JOIN agent_profile_revisions AS frozen_profile
       ON frozen_profile.profile_id = routed.profile_id
      AND frozen_profile.revision = routed.profile_revision
     JOIN room_agent_assignment_revisions AS frozen_assignment
       ON frozen_assignment.assignment_id = routed.assignment_id
      AND frozen_assignment.revision = routed.assignment_revision
     LEFT JOIN agent_profiles AS profile ON profile.id = routed.profile_id
     LEFT JOIN room_agent_assignments AS assignment ON assignment.id = routed.assignment_id
     LEFT JOIN room_memberships AS membership
       ON membership.room_id = routed.room_id
      AND membership.actor_id = routed.target_agent_actor_id
     LEFT JOIN rooms AS room ON room.id = routed.room_id
     LEFT JOIN actors AS actor ON actor.id = routed.target_agent_actor_id
     WHERE routed.id = ? AND routed.status = 'claimed'
       AND routed.room_id = ? AND routed.source_message_id = ?
       AND routed.target_agent_actor_id = ?`,
  ).get(origin.lineageId, origin.roomId as string, origin.sourceMessageId as string,
    origin.actorId as string) as
    UnknownRow | undefined;
  if (row === undefined) throw new FrozenRuntimeAuthorityError("handoff_missing");
  return { ...row, executionId, roomId: origin.roomId, actorId: origin.actorId,
    origin: "routed" };
}

function validate(row: UnknownRow): FrozenRuntimeAuthorityHandoff {
  const origin = row.origin;
  if ((origin !== "direct" && origin !== "routed") || typeof row.executionId !== "string" ||
      typeof row.intentId !== "string" || typeof row.roomId !== "string" ||
      typeof row.actorId !== "string" || typeof row.profileId !== "string" ||
      !positive(row.profileRevision) || typeof row.assignmentId !== "string" ||
      !positive(row.assignmentRevision) || !nonnegative(row.accessRevision)) {
    throw new FrozenRuntimeAuthorityError("authority_corrupt");
  }
  if (row.roomStatus !== "active") throw new FrozenRuntimeAuthorityError("room_inactive");
  if (row.actorKind !== "agent" || row.membershipKind !== "agent") {
    throw new FrozenRuntimeAuthorityError("access_revoked");
  }
  if (row.currentAccessRevision !== row.accessRevision) {
    throw new FrozenRuntimeAuthorityError("access_revision_stale");
  }
  if (row.profileActorId !== row.actorId || row.frozenProfileActorId !== row.actorId ||
      row.frozenProfileStatus !== "enabled" ||
      row.profileStatus !== "enabled") {
    throw new FrozenRuntimeAuthorityError("profile_disabled");
  }
  if (row.currentProfileRevision !== row.profileRevision) {
    throw new FrozenRuntimeAuthorityError("profile_revision_stale");
  }
  if (row.assignmentRoomId !== row.roomId || row.assignmentProfileId !== row.profileId ||
      row.assignmentActorId !== row.actorId || row.frozenAssignmentRoomId !== row.roomId ||
      row.frozenAssignmentProfileId !== row.profileId ||
      row.frozenAssignmentActorId !== row.actorId || row.assignmentStatus !== "current") {
    throw new FrozenRuntimeAuthorityError("assignment_removed");
  }
  if (row.assignmentPaused === 1) throw new FrozenRuntimeAuthorityError("assignment_paused");
  if (row.currentAssignmentRevision !== row.assignmentRevision) {
    throw new FrozenRuntimeAuthorityError("assignment_revision_stale");
  }
  if (row.frozenAssignmentStatus !== "current" || row.frozenAssignmentPaused !== 0 ||
      (row.frozenParticipation !== "active" && row.frozenParticipation !== "on-mention")) {
    throw new FrozenRuntimeAuthorityError("authority_corrupt");
  }
  if (row.currentParticipation !== row.frozenParticipation ||
      row.membershipParticipation !== row.frozenParticipation ||
      (origin === "routed" && row.currentParticipation !== "active")) {
    throw new FrozenRuntimeAuthorityError("assignment_inactive");
  }
  const ceiling = jsonStringArray(row.frozenToolCeilingJson);
  const subset = jsonStringArray(row.frozenToolSubsetJson);
  const membershipTools = jsonStringArray(row.membershipToolsJson);
  const effectiveToolIds = Object.freeze(ceiling.filter(
    (toolId): toolId is FrozenRuntimeToolId =>
      runtimeToolIds.has(toolId as FrozenRuntimeToolId) && subset.includes(toolId) &&
      membershipTools.includes(toolId),
  ));
  return Object.freeze({
    origin,
    executionId: row.executionId,
    intentId: row.intentId,
    roomId: row.roomId,
    actorId: row.actorId,
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    assignmentId: row.assignmentId,
    assignmentRevision: row.assignmentRevision,
    accessRevision: row.accessRevision,
    participation: row.frozenParticipation,
    effectiveToolIds,
  });
}

/**
 * Server-private execution handoff gate. Direct and routed authority are kept in
 * separate durable tables and converge only after their frozen facts are read.
 */
export function requireFrozenRuntimeAuthority(
  database: DatabaseSync,
  executionId: string,
): FrozenRuntimeAuthorityHandoff {
  const origin = readOrigin(database, executionId);
  if (origin.originKind === "message_target") {
    return validate(readDirect(database, executionId, origin));
  }
  if (origin.originKind === "legacy_runtime") {
    return validate(readRouted(database, executionId, origin));
  }
  throw new FrozenRuntimeAuthorityError("handoff_missing");
}
