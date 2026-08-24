import type { DatabaseSync } from "node:sqlite";
import type {
  AgentProfileProjection,
  DeploymentProviderDisclosure,
  PersistedDeploymentAgentProfileEvent,
  RoomAgentAssignmentProjection,
} from "@native-im/core";
import type {
  Ft07AgentSettingsClientFrame,
  Ft07AgentSettingsMutationType,
  Ft07AgentSettingsServerFrame,
} from "../ft07-agent-settings-protocol.js";
import type {
  AuthenticatedCommandContext,
  AuthenticatedSessionContext,
} from "../persistence/contracts.js";
import {
  AuthorityDatabaseError,
  executeRoomAssignmentAuthorityOperation,
  executeTenantAdministrationAuthorityOperation,
} from "../persistence/authority-database-handler.js";
import type { TenantAdministrationOperation } from
  "../tenant-administration/authority-protocol.js";
import type { DeploymentProviderDisclosure as AuthorityProvider } from
  "../tenant-administration/authority-service.js";

type Row = Record<string, unknown>;

export interface AgentSettingsWorkerOperation {
  readonly version: 1;
  readonly context: AuthenticatedSessionContext | AuthenticatedCommandContext;
  readonly frame: Ft07AgentSettingsClientFrame;
  readonly now: number;
}

type AssignmentMutationFrame = Extract<Ft07AgentSettingsClientFrame, {
  readonly type: "room-agent-assignment.create" | "room-agent-assignment.update" |
    "room-agent-assignment.pause" | "room-agent-assignment.resume" |
    "room-agent-assignment.remove";
}>;

function fail(message: string): never {
  throw new AuthorityDatabaseError("storage_unavailable", message);
}

function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : fail("FT-07 text is corrupt");
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : fail("FT-07 revision is corrupt");
}

function positive(value: unknown): number {
  const result = count(value);
  return result > 0 ? result : fail("FT-07 positive revision is corrupt");
}

function canonicalSet(value: unknown): readonly string[] {
  if (typeof value !== "string") return fail("FT-07 set is corrupt");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail("FT-07 set is corrupt"); }
  if (!Array.isArray(parsed) || !parsed.every((entry, index) =>
    typeof entry === "string" && entry.length > 0 &&
    (index === 0 || (parsed[index - 1] as string) < entry))) {
    return fail("FT-07 set is non-canonical");
  }
  return Object.freeze(parsed);
}

function profile(value: Readonly<{
  profileId: string; actorId: string; displayName: string; globalResponsibility: string;
  status: "enabled" | "disabled"; capabilityCeiling: readonly string[];
  toolCeiling: readonly string[]; revision: number; createdAt: string; updatedAt: string;
}>): AgentProfileProjection {
  return Object.freeze({ recordVersion: "agent-profile.v1" as const, ...value }) as AgentProfileProjection;
}

function profileFromJson(value: unknown): AgentProfileProjection {
  if (typeof value !== "string") return fail("FT-07 Profile projection is corrupt");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail("FT-07 Profile projection is corrupt"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("FT-07 Profile projection is corrupt");
  }
  const { schemaVersion, ...authority } = parsed as Record<string, unknown>;
  if (schemaVersion !== 1) return fail("FT-07 Profile projection version is corrupt");
  return profile(authority as unknown as Omit<AgentProfileProjection, "recordVersion">);
}

function provider(value: AuthorityProvider | undefined): DeploymentProviderDisclosure {
  if (value === undefined) return fail("FT-07 Provider disclosure is unavailable");
  return Object.freeze({ ...value });
}

function deploymentHead(database: DatabaseSync): Readonly<{ head: number; retained: number }> {
  const row = database.prepare(
    "SELECT head_seq AS head, retained_from_seq AS retained FROM deployment_stream WHERE singleton_id = 1",
  ).get() as Row | undefined;
  if (row === undefined) return fail("FT-07 deployment stream is unavailable");
  return Object.freeze({ head: count(row.head), retained: positive(row.retained) });
}

function profileEvent(row: Row): PersistedDeploymentAgentProfileEvent {
  const eventKind = text(row.eventKind);
  const type = eventKind === "profile.created" ? "agent-profile.created"
    : eventKind === "profile.updated" ? "agent-profile.updated"
    : eventKind === "profile.enabled" ? "agent-profile.enabled"
    : eventKind === "profile.disabled" ? "agent-profile.disabled"
    : fail("FT-07 Profile event kind is corrupt");
  const streamSeq = positive(row.streamSeq);
  return Object.freeze({
    eventId: text(row.eventId), streamKind: "deployment" as const,
    streamId: "agent-profile" as const, streamSeq, actorId: text(row.actorId),
    occurredAt: text(row.occurredAt), type,
    payload: Object.freeze({ catalogRevision: streamSeq, profile: profileFromJson(row.projectionJson) }),
  });
}

function assignmentProjection(row: Row, readiness: "ready" | "noauth"): RoomAgentAssignmentProjection {
  const paused = row.paused === 1;
  if (!paused && row.paused !== 0) return fail("FT-07 Assignment pause state is corrupt");
  const running = count(row.runningExecutionCount);
  const availability = paused ? "paused" as const
    : readiness === "noauth" ? "noauth" as const
    : running > 0 ? "busy" as const : "ready" as const;
  const capabilityCeiling = canonicalSet(row.capabilityCeilingJson);
  const capabilitySubset = canonicalSet(row.capabilitySubsetJson);
  const toolCeiling = canonicalSet(row.toolCeilingJson);
  const toolSubset = canonicalSet(row.toolSubsetJson);
  const membershipTools = new Set(canonicalSet(row.membershipToolsJson));
  if (capabilitySubset.some((capability) => !capabilityCeiling.includes(capability)) ||
      toolSubset.some((tool) => !toolCeiling.includes(tool))) {
    return fail("FT-07 Assignment exceeds its Profile ceiling");
  }
  const effectiveTools = Object.freeze(toolSubset.filter((tool) => membershipTools.has(tool)));
  return Object.freeze({
    recordVersion: "room-agent-assignment.v1" as const,
    assignmentId: text(row.assignmentId), roomId: text(row.roomId),
    profileId: text(row.profileId), actorId: text(row.actorId),
    displayName: text(row.displayName), globalResponsibility: text(row.globalResponsibility),
    roomResponsibility: text(row.roomResponsibility),
    participation: row.participation === "active" || row.participation === "on-mention"
      ? row.participation : fail("FT-07 Assignment participation is corrupt"),
    availability, paused, capabilityCeiling, capabilitySubset,
    effectiveCapabilities: capabilitySubset, toolCeiling, toolSubset,
    effectiveTools, profileRevision: positive(row.profileRevision),
    assignmentRevision: positive(row.assignmentRevision), accessRevision: count(row.accessRevision),
    updatedAt: text(row.updatedAt),
  }) as RoomAgentAssignmentProjection;
}

const ASSIGNMENT_PROJECTION_SQL = `
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
          WHERE execution.room_id = assignment.room_id
            AND execution.agent_id = assignment.agent_actor_id
            AND execution.status IN ('queued', 'running')) AS runningExecutionCount
  FROM room_agent_assignments AS assignment
  JOIN agent_profiles AS profile ON profile.id = assignment.profile_id
  JOIN rooms AS room ON room.id = assignment.room_id
  JOIN room_memberships AS membership
    ON membership.room_id = assignment.room_id
   AND membership.actor_id = assignment.agent_actor_id AND membership.kind = 'agent'
  WHERE assignment.room_id = ? AND assignment.status = 'current'
    AND profile.status = 'enabled' AND room.status = 'active'`;

function roomAssignments(database: DatabaseSync, roomId: string,
  readiness: "ready" | "noauth"): readonly RoomAgentAssignmentProjection[] {
  const rows = (database.prepare(
    `${ASSIGNMENT_PROJECTION_SQL} ORDER BY assignment.id`,
  ).all(roomId) as unknown) as readonly Row[];
  if (rows.length > 256) return fail("FT-07 Assignment projection exceeds the closed bound");
  return Object.freeze(rows.map((row) => assignmentProjection(row, readiness)));
}

async function authorizeDeployment(database: DatabaseSync, context: AuthenticatedSessionContext,
  now: number, configuredProvider: AuthorityProvider | undefined) {
  return executeTenantAdministrationAuthorityOperation(database, {
    version: 1, type: "agent-profile.list", context, now,
  }, { ...(configuredProvider === undefined ? {} : { provider: configuredProvider }) });
}

function tenantOperation(operation: AgentSettingsWorkerOperation): TenantAdministrationOperation {
  const { frame, context, now } = operation;
  switch (frame.type) {
    case "tenant-administrator.list":
    case "agent-profile.list":
    case "provider-configuration.disclose":
      return { version: 1, type: frame.type, context, now };
    case "agent-profile.get":
      return { version: 1, type: frame.type, context, profileId: frame.profileId, now };
    case "tenant-administrator.add":
    case "tenant-administrator.remove":
      return { version: 1, type: frame.type, context: context as AuthenticatedCommandContext,
        targetPrincipalId: frame.targetPrincipalId, expectedRevision: frame.expectedRevision, now };
    case "agent-profile.create":
      return { version: 1, type: frame.type, context: context as AuthenticatedCommandContext,
        expectedRevision: frame.expectedProfileRevision, displayName: frame.displayName,
        globalResponsibility: frame.globalResponsibility,
        capabilityCeiling: frame.capabilityCeiling, toolCeiling: frame.toolCeiling, now };
    case "agent-profile.update":
      return { version: 1, type: frame.type, context: context as AuthenticatedCommandContext,
        profileId: frame.profileId, expectedRevision: frame.expectedProfileRevision,
        displayName: frame.displayName, globalResponsibility: frame.globalResponsibility,
        capabilityCeiling: frame.capabilityCeiling, toolCeiling: frame.toolCeiling, now };
    case "agent-profile.enable":
    case "agent-profile.disable":
      return { version: 1, type: frame.type, context: context as AuthenticatedCommandContext,
        profileId: frame.profileId, expectedRevision: frame.expectedProfileRevision, now };
    default:
      return fail("FT-07 frame is not a Tenant operation");
  }
}

function wasDeploymentReplay(database: DatabaseSync, operation: TenantAdministrationOperation): boolean {
  if (!("context" in operation) || !("idempotencyKey" in operation.context)) return false;
  const scope = operation.type === "tenant-administrator.add" ? "administrator.add"
    : operation.type === "tenant-administrator.remove" ? "administrator.remove"
    : operation.type === "agent-profile.create" ? "profile.create"
    : operation.type === "agent-profile.update" ? "profile.update"
    : operation.type === "agent-profile.enable" ? "profile.enable" : "profile.disable";
  return database.prepare(
    `SELECT 1 FROM deployment_idempotency_records
     WHERE scope = ? AND idempotency_key = ? AND principal_actor_id = ?`,
  ).get(scope, operation.context.idempotencyKey, operation.context.principal.actorId) !== undefined;
}

function deploymentEventId(database: DatabaseSync, type: Ft07AgentSettingsMutationType,
  revision: number, subjectId: string): string {
  if (type.startsWith("agent-profile.")) {
    const row = database.prepare(
      `SELECT event_id AS eventId FROM deployment_agent_profile_events
       WHERE profile_id = ? AND profile_revision = ?`,
    ).get(subjectId, revision) as Row | undefined;
    return text(row?.eventId);
  }
  const eventKind = type === "tenant-administrator.add" ? "administrator.add" : "administrator.remove";
  const row = database.prepare(
    `SELECT audit_id AS eventId FROM deployment_audit
     WHERE event_kind = ? AND subject_id = ? AND subject_revision = ?`,
  ).get(eventKind, subjectId, revision) as Row | undefined;
  return text(row?.eventId);
}

function assignmentRequest(frame: AssignmentMutationFrame) {
  const kind = frame.type.slice("room-agent-assignment.".length) as
    "create" | "update" | "pause" | "resume" | "remove";
  return {
    kind, requestId: frame.requestId, idempotencyKey: frame.idempotencyKey,
    roomId: frame.roomId, expectedRoomRevision: frame.expectedRoomRevision,
    ...(frame.type === "room-agent-assignment.create" ? {
      profileId: frame.profileId, roomResponsibility: frame.roomResponsibility,
      participation: frame.participation, capabilitySubset: frame.capabilitySubset,
      toolSubset: frame.toolSubset,
    } : {
      assignmentId: frame.assignmentId, expectedAssignmentRevision: frame.expectedAssignmentRevision,
      ...(frame.type === "room-agent-assignment.update" ? {
        roomResponsibility: frame.roomResponsibility, participation: frame.participation,
        capabilitySubset: frame.capabilitySubset, toolSubset: frame.toolSubset,
      } : {}),
    }),
  };
}

export async function executeAgentSettingsWorkerOperation(
  database: DatabaseSync,
  operation: AgentSettingsWorkerOperation,
  configuredProvider: AuthorityProvider | undefined,
): Promise<Ft07AgentSettingsServerFrame> {
  const { frame, context, now } = operation;
  const disclosure = provider(configuredProvider);
  if (frame.type === "agent-profile.sync") {
    await authorizeDeployment(database, context, now, configuredProvider);
    const { head, retained } = deploymentHead(database);
    if (frame.afterSeq === undefined) return { type: "agent-profile.sync.result",
      requestId: frame.requestId, mode: "repair_required", reason: "cursor_absent",
      retainedFromSeq: retained, watermark: head };
    if (frame.afterSeq < retained - 1 || frame.afterSeq > head) {
      return { type: "agent-profile.sync.result", requestId: frame.requestId,
        mode: "repair_required", reason: frame.afterSeq > head ? "projection_changed" : "cursor_expired",
        retainedFromSeq: retained, watermark: head };
    }
    const limit = frame.limit ?? 100;
    const rows = database.prepare(
      `SELECT event.event_id AS eventId, event.stream_seq AS streamSeq,
              event.actor_id AS actorId, event.event_kind AS eventKind,
              event.occurred_at AS occurredAt,
              json_extract(event.payload_json, '$.profile') AS projectionJson
       FROM deployment_agent_profile_events AS event
       WHERE event.stream_seq > ? ORDER BY event.stream_seq LIMIT ?`,
    ).all(frame.afterSeq, limit) as unknown as readonly Row[];
    const events = Object.freeze(rows.map(profileEvent));
    const nextCursor = events.at(-1)?.streamSeq ?? frame.afterSeq;
    return { type: "agent-profile.sync.result", requestId: frame.requestId, mode: "delta",
      events, nextCursor, watermark: head, hasMore: nextCursor < head };
  }
  if (frame.type === "agent-profile.repair") {
    await authorizeDeployment(database, context, now, configuredProvider);
    const profiles = Object.freeze((database.prepare(
      `SELECT projection_json AS projectionJson FROM deployment_agent_profile_repair_records
       ORDER BY profile_id`,
    ).all() as unknown as readonly Row[]).map((row) => profileFromJson(row.projectionJson)));
    if (profiles.length > 256) return fail("FT-07 Profile repair exceeds the closed bound");
    return { type: "agent-profile.repair.snapshot", requestId: frame.requestId,
      watermark: deploymentHead(database).head, profiles, provider: disclosure };
  }
  if (frame.type === "room-agent-assignment.repair") {
    executeRoomAssignmentAuthorityOperation(database, { version: 1,
      type: "room-assignment.list", context, roomId: frame.roomId, now });
    const room = database.prepare(
      `SELECT governance_revision AS roomRevision FROM rooms WHERE id = ?`,
    ).get(frame.roomId) as Row | undefined;
    const stream = database.prepare(
      `SELECT head_seq AS watermark FROM streams WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(frame.roomId) as Row | undefined;
    return { type: "room-agent-assignment.repair.snapshot", requestId: frame.requestId,
      roomId: frame.roomId, watermark: count(stream?.watermark),
      roomRevision: count(room?.roomRevision),
      assignments: roomAssignments(database, frame.roomId, disclosure.credentialReadiness),
      provider: disclosure };
  }
  if (frame.type.startsWith("room-agent-assignment.")) {
    if (frame.type === "room-agent-assignment.list" || frame.type === "room-agent-assignment.get") {
      executeRoomAssignmentAuthorityOperation(database,
        frame.type === "room-agent-assignment.list"
          ? { version: 1, type: "room-assignment.list", context, roomId: frame.roomId, now }
          : { version: 1, type: "room-assignment.get", context, roomId: frame.roomId,
              assignmentId: frame.assignmentId, now });
      const room = database.prepare("SELECT governance_revision AS revision FROM rooms WHERE id = ?")
        .get(frame.roomId) as Row | undefined;
      const assignments = roomAssignments(database, frame.roomId, disclosure.credentialReadiness);
      if (frame.type === "room-agent-assignment.list") return {
        type: "room-agent-assignment.catalog", requestId: frame.requestId, roomId: frame.roomId,
        roomRevision: count(room?.revision), assignments, provider: disclosure,
      };
      const selected = assignments.find((entry) => entry.assignmentId === frame.assignmentId);
      if (selected === undefined) throw new AuthorityDatabaseError("assignment_gone",
        "Room Assignment is not visible");
      return { type: "room-agent-assignment.detail", requestId: frame.requestId,
        roomId: frame.roomId, assignment: selected, provider: disclosure };
    }
    const mutationFrame = frame as AssignmentMutationFrame;
    const request = assignmentRequest(mutationFrame);
    const scope = ["room-assignment", context.principal.actorId,
      mutationFrame.roomId, request.kind].join("\0");
    const replayed = database.prepare("SELECT 1 FROM idempotency_records WHERE scope = ? AND key = ?")
      .get(scope, mutationFrame.idempotencyKey) !== undefined;
    const result = executeRoomAssignmentAuthorityOperation(database, { version: 1,
      type: "room-assignment.mutate", context, request, now }, disclosure.credentialReadiness);
    if (result.kind !== "room-assignment-command") return fail("FT-07 Assignment ACK is unavailable");
    return { type: "agent-settings.ack", requestId: mutationFrame.requestId,
      operation: mutationFrame.type,
      acceptedRevision: result.acknowledgement.acceptedRevision,
      eventIds: result.acknowledgement.eventIds, replayed };
  }
  const tenant = tenantOperation(operation);
  const replayed = wasDeploymentReplay(database, tenant);
  const result = await executeTenantAdministrationAuthorityOperation(database, tenant,
    { ...(configuredProvider === undefined ? {} : { provider: configuredProvider }) });
  if (frame.type === "tenant-administrator.list" && result.kind === "tenant-administrator-registry") {
    return { type: "tenant-administrator.registry", requestId: frame.requestId,
      registry: result.registry };
  }
  if (frame.type === "agent-profile.list" && result.kind === "agent-profiles") {
    return { type: "agent-profile.catalog", requestId: frame.requestId,
      catalogRevision: deploymentHead(database).head,
      profiles: Object.freeze(result.profiles.map(profile)), provider: result.provider };
  }
  if (frame.type === "agent-profile.get" && result.kind === "agent-profile") {
    return { type: "agent-profile.detail", requestId: frame.requestId,
      profile: profile(result.profile), provider: result.provider };
  }
  if (frame.type === "provider-configuration.disclose" && result.kind === "provider-configuration") {
    return { type: "provider-configuration.disclosure", requestId: frame.requestId,
      provider: result.provider };
  }
  if ((frame.type === "tenant-administrator.add" ||
      frame.type === "tenant-administrator.remove") &&
      result.kind === "tenant-administrator-registry") {
    return { type: "agent-settings.ack", requestId: frame.requestId, operation: frame.type,
      acceptedRevision: result.registry.revision,
      eventIds: Object.freeze([deploymentEventId(database, frame.type,
        result.registry.revision, frame.targetPrincipalId)]), replayed };
  }
  if ((frame.type === "agent-profile.create" || frame.type === "agent-profile.update" ||
      frame.type === "agent-profile.enable" || frame.type === "agent-profile.disable") &&
      result.kind === "agent-profile") {
    return { type: "agent-settings.ack", requestId: frame.requestId, operation: frame.type,
      acceptedRevision: result.profile.revision,
      eventIds: Object.freeze([deploymentEventId(database, frame.type,
        result.profile.revision, result.profile.profileId)]), replayed };
  }
  return fail("FT-07 authority returned an uncorrelated result");
}
