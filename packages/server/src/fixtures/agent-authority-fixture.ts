import type { DatabaseSync } from "node:sqlite";

const FIXTURE_NOW = "2026-08-24T00:00:00.000Z";

export interface CanonicalAgentProfileFixture {
  readonly actorId: string;
  readonly profileId?: string;
  readonly revision?: number;
  readonly displayName?: string;
  readonly status?: "enabled" | "disabled";
  readonly capabilityCeiling?: readonly string[];
  readonly toolCeiling?: readonly string[];
  readonly now?: string;
}

export interface CanonicalRoomAssignmentFixture {
  readonly assignmentId: string;
  readonly roomId: string;
  readonly profileId: string;
  readonly actorId: string;
  readonly revision?: number;
  readonly participation?: "active" | "on-mention";
  readonly paused?: boolean;
  readonly capabilitySubset?: readonly string[];
  readonly toolSubset?: readonly string[];
  readonly now?: string;
}

export interface RoomAssignmentPauseTransitionFixture {
  readonly assignmentId: string;
  readonly expectedRevision: number;
  readonly paused: boolean;
  readonly changedByHumanActorId: string;
  readonly now?: string;
}

export function seedCanonicalAgentProfileFixture(
  database: DatabaseSync,
  fixture: CanonicalAgentProfileFixture,
): string {
  const profileId = fixture.profileId ?? `fixture-profile:${fixture.actorId}`;
  const revision = fixture.revision ?? 1;
  const displayName = fixture.displayName ?? "Fixture Agent";
  const status = fixture.status ?? "enabled";
  const capabilities = JSON.stringify(fixture.capabilityCeiling ?? []);
  const tools = JSON.stringify(fixture.toolCeiling ?? []);
  const now = fixture.now ?? FIXTURE_NOW;
  const responsibility = "Exercise authoritative Agent behavior in a closed test fixture.";
  const existing = database.prepare(
    `SELECT id, revision, display_name AS displayName, status,
            capability_ceiling_json AS capabilities, tool_ceiling_json AS tools
     FROM agent_profiles WHERE actor_id = ?`,
  ).get(fixture.actorId);
  if (existing !== undefined) {
    if (existing.id !== profileId || existing.revision !== revision ||
        existing.displayName !== displayName || existing.status !== status ||
        existing.capabilities !== capabilities || existing.tools !== tools) {
      throw new Error("Agent Profile fixture conflicts with existing authority");
    }
    return profileId;
  }
  database.prepare(
    `INSERT INTO agent_profiles (
       id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json,
       display_name, global_responsibility, created_at, updated_at, source_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy_v20_migration')`,
  ).run(
    profileId,
    fixture.actorId,
    revision,
    status,
    capabilities,
    tools,
    displayName,
    responsibility,
    now,
    now,
  );
  database.prepare(
    `INSERT INTO agent_profile_revisions (
       profile_id, revision, actor_id, display_name, global_responsibility,
       status, capability_ceiling_json, tool_ceiling_json,
       changed_by_human_actor_id, changed_at, operation
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'legacy_migration')`,
  ).run(
    profileId,
    revision,
    fixture.actorId,
    displayName,
    responsibility,
    status,
    capabilities,
    tools,
    now,
  );
  return profileId;
}

export function seedCanonicalRoomAssignmentFixture(
  database: DatabaseSync,
  fixture: CanonicalRoomAssignmentFixture,
): void {
  const revision = fixture.revision ?? 1;
  const participation = fixture.participation ?? "active";
  const paused = fixture.paused === true ? 1 : 0;
  const capabilities = JSON.stringify(fixture.capabilitySubset ?? []);
  const tools = JSON.stringify(fixture.toolSubset ?? []);
  const now = fixture.now ?? FIXTURE_NOW;
  const responsibility = "Exercise authoritative Room behavior in a closed test fixture.";
  database.prepare(
    `INSERT INTO room_agent_assignments (
       id, room_id, profile_id, agent_actor_id, revision, status, participation,
       paused, capability_subset_json, tool_subset_json, room_responsibility,
       created_at, updated_at, removed_at, source_kind
     ) VALUES (?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?, ?, NULL,
       'legacy_v20_migration')`,
  ).run(
    fixture.assignmentId,
    fixture.roomId,
    fixture.profileId,
    fixture.actorId,
    revision,
    participation,
    paused,
    capabilities,
    tools,
    responsibility,
    now,
    now,
  );
  database.prepare(
    `INSERT INTO room_agent_assignment_revisions (
       assignment_id, revision, room_id, profile_id, agent_actor_id,
       room_responsibility, status, participation, paused,
       capability_subset_json, tool_subset_json, changed_by_human_actor_id,
       changed_at, operation
     ) VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, NULL, ?,
       'legacy_migration')`,
  ).run(
    fixture.assignmentId,
    revision,
    fixture.roomId,
    fixture.profileId,
    fixture.actorId,
    responsibility,
    participation,
    paused,
    capabilities,
    tools,
    now,
  );
}

export function transitionRoomAssignmentPauseFixture(
  database: DatabaseSync,
  fixture: RoomAssignmentPauseTransitionFixture,
): void {
  const now = fixture.now ?? FIXTURE_NOW;
  const nextRevision = fixture.expectedRevision + 1;
  const operation = fixture.paused ? "pause" : "resume";
  const changed = database.prepare(
    `UPDATE room_agent_assignments
     SET revision = ?, paused = ?, updated_at = ?, source_kind = 'room_command'
     WHERE id = ? AND revision = ? AND status = 'current'`,
  ).run(
    nextRevision,
    fixture.paused ? 1 : 0,
    now,
    fixture.assignmentId,
    fixture.expectedRevision,
  );
  if (changed.changes !== 1) {
    throw new Error("Room Assignment pause fixture lost its expected revision");
  }
  database.prepare(
    `INSERT INTO room_agent_assignment_revisions (
       assignment_id, revision, room_id, profile_id, agent_actor_id,
       room_responsibility, status, participation, paused,
       capability_subset_json, tool_subset_json, changed_by_human_actor_id,
       changed_at, operation
     )
     SELECT id, revision, room_id, profile_id, agent_actor_id,
       room_responsibility, status, participation, paused,
       capability_subset_json, tool_subset_json, ?, updated_at, ?
     FROM room_agent_assignments WHERE id = ?`,
  ).run(fixture.changedByHumanActorId, operation, fixture.assignmentId);
}
