import { describe, expect, it } from "vitest";
import {
  isAgentSettingsAuthorityMessage,
  isAgentSettingsMutationIntent,
  isAgentSettingsSnapshot,
  type AgentSettingsSnapshot,
} from "./contracts.js";

export function profile(overrides: Record<string, unknown> = {}) {
  return {
    recordVersion: "agent-profile.v1",
    profileId: "profile-research",
    actorId: "agent-research",
    displayName: "检索员",
    globalResponsibility: "跨 Room 的资料检索与来源核验",
    status: "enabled",
    capabilityCeiling: ["room.conversation.read", "room.memory.read"],
    toolCeiling: ["http-json.read"],
    revision: 4,
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
    ...overrides,
  };
}

export function assignment(overrides: Record<string, unknown> = {}) {
  return {
    recordVersion: "room-agent-assignment.v1",
    assignmentId: "assignment-research",
    roomId: "room-dao",
    profileId: "profile-research",
    actorId: "agent-research",
    displayName: "检索员",
    globalResponsibility: "跨 Room 的资料检索与来源核验",
    roomResponsibility: "核对迁移资料与引用",
    participation: "on-mention",
    availability: "ready",
    paused: false,
    capabilityCeiling: ["room.conversation.read", "room.memory.read"],
    capabilitySubset: ["room.memory.read"],
    effectiveCapabilities: ["room.memory.read"],
    toolCeiling: ["http-json.read"],
    toolSubset: [],
    effectiveTools: [],
    profileRevision: 4,
    assignmentRevision: 8,
    accessRevision: 6,
    ...overrides,
  };
}

export function snapshot(overrides: Record<string, unknown> = {}): AgentSettingsSnapshot {
  return {
    recordVersion: "agent-settings.snapshot.v1",
    cursor: 31,
    viewer: {
      actorId: "human-owner",
      tenantAdministrator: true,
      roomRole: "owner",
    },
    provider: {
      providerId: "openai",
      modelId: "gpt-5",
      credentialStatus: "configured",
      retentionDisabled: true,
      selectionPolicy: "server-managed-single",
    },
    profileCatalog: {
      status: "available",
      revision: 4,
      profiles: [profile()],
    },
    room: {
      status: "available",
      roomId: "room-dao",
      roomName: "Dao 交付",
      lifecycle: "active",
      roomRevision: 12,
      assignments: [assignment()],
    },
    ...overrides,
  } as AgentSettingsSnapshot;
}

describe("FT-07 public Profile / Assignment DTO guards", () => {
  it("accepts the exact split authority snapshot without provider secret or writable availability", () => {
    expect(isAgentSettingsSnapshot(snapshot())).toBe(true);
    expect(JSON.stringify(snapshot())).not.toMatch(/api[_-]?key|credentialValue|secret/u);
  });

  it.each([
    snapshot({ forged: true }),
    snapshot({ provider: { ...snapshot().provider, apiKey: "must-not-cross" } }),
    snapshot({ room: { ...snapshot().room, assignments: [assignment({ participation: "silent" })] } }),
    snapshot({ room: { ...snapshot().room, assignments: [assignment({ availability: "degraded" })] } }),
    snapshot({ room: { ...snapshot().room, assignments: [assignment({ paused: true, availability: "ready" })] } }),
    snapshot({ room: { ...snapshot().room, assignments: [assignment({ toolSubset: ["sandbox-file.write"] })] } }),
    snapshot({ room: { ...snapshot().room, assignments: [assignment({ effectiveTools: ["http-json.read"] })] } }),
    snapshot({ room: { ...snapshot().room, assignments: [assignment({ capabilitySubset: ["room.memory.read", "room.memory.read"] })] } }),
    snapshot({ room: { ...snapshot().room, assignments: [assignment({ capabilitySubset: ["room.memory.read", "room.conversation.read"] })] } }),
  ])("rejects malformed, expanded or non-canonical authority data", (candidate) => {
    expect(isAgentSettingsSnapshot(candidate)).toBe(false);
  });

  it("does not expose the deployment profile catalog to a non-administrator", () => {
    expect(isAgentSettingsSnapshot(snapshot({
      viewer: { actorId: "human-owner", tenantAdministrator: false, roomRole: "owner" },
      profileCatalog: { status: "forbidden" },
    }))).toBe(true);
    expect(isAgentSettingsSnapshot(snapshot({
      viewer: { actorId: "human-owner", tenantAdministrator: false, roomRole: "owner" },
    }))).toBe(false);
    expect(isAgentSettingsSnapshot(snapshot({
      viewer: { actorId: "tenant-admin", tenantAdministrator: true, roomRole: null },
      room: { status: "forbidden", roomId: "room-dao" },
    }))).toBe(true);
    expect(isAgentSettingsSnapshot(snapshot({
      viewer: { actorId: "tenant-admin", tenantAdministrator: true, roomRole: null },
    }))).toBe(false);
  });

  it("accepts only management intents and rejects derived/provider/client authority injection", () => {
    expect(isAgentSettingsMutationIntent({
      command: "assignment.update",
      roomId: "room-dao",
      assignmentId: "assignment-research",
      expectedRoomRevision: 12,
      expectedAssignmentRevision: 8,
      roomResponsibility: "核对迁移资料与引用",
      participation: "active",
      capabilitySubset: ["room.memory.read"],
      toolSubset: [],
    })).toBe(true);
    for (const injected of [
      { availability: "ready" },
      { providerId: "other" },
      { modelId: "fallback" },
      { origin: "routed" },
      { participation: "silent" },
    ]) {
      expect(isAgentSettingsMutationIntent({
        command: "assignment.pause",
        roomId: "room-dao",
        assignmentId: "assignment-research",
        expectedRoomRevision: 12,
        expectedAssignmentRevision: 8,
        ...injected,
      })).toBe(false);
    }
  });

  it("accepts the initial authoritative membership access revision", () => {
    expect(isAgentSettingsSnapshot(snapshot({
      room: {
        ...snapshot().room,
        assignments: [assignment({ accessRevision: 0 })],
      },
    }))).toBe(true);
  });

  it("guards ACK, closed error, stable event and atomic repair messages", () => {
    const messages = [
      {
        type: "ack",
        requestId: "request-1",
        command: "assignment.pause",
        replayed: false,
        acceptedRevision: 9,
        eventIds: ["event-1"],
      },
      {
        type: "error",
        requestId: "request-1",
        command: "assignment.pause",
        error: { status: 409, code: "assignment_revision_conflict" },
      },
      {
        type: "stable-event",
        eventId: "event-1",
        cursor: 32,
        causationRequestId: "request-1",
        event: { kind: "assignment.upserted", roomRevision: 13, assignment: assignment({ availability: "paused", paused: true, assignmentRevision: 9 }) },
      },
      { type: "repair-started", generation: 3, watermark: 40 },
      { type: "repair-completed", generation: 3, watermark: 40, snapshot: snapshot({ cursor: 40 }) },
      { type: "repair-failed", generation: 3, watermark: 40, errorCode: "snapshot_hash_mismatch" },
      { type: "access-revoked", scope: "room", purgeCompleted: true },
    ];
    expect(messages.every(isAgentSettingsAuthorityMessage)).toBe(true);
    expect(isAgentSettingsAuthorityMessage({ ...messages[0], eventIds: ["event-1", "event-1"] })).toBe(false);
    expect(isAgentSettingsAuthorityMessage({ ...messages[2], cursor: 0 })).toBe(false);
    expect(isAgentSettingsAuthorityMessage({ ...messages[4], snapshot: snapshot({ cursor: 39 }) })).toBe(false);
  });
});
