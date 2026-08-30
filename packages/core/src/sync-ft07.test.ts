import { describe, expect, it } from "vitest";
import {
  isAgentProfileProjection,
  isDeploymentAgentProfileRepairSnapshot,
  isDeploymentProviderDisclosure,
  isPersistedDeploymentAgentProfileEvent,
  isRoomAgentAssignmentProjection,
  isRoomAgentAssignmentRepairSnapshot,
  isRoomSyncResult,
} from "./index.js";

const profile = Object.freeze({
  recordVersion: "agent-profile.v1" as const,
  profileId: "profile-1",
  actorId: "agent-1",
  displayName: "Research",
  globalResponsibility: "Research verified sources",
  status: "enabled" as const,
  capabilityCeiling: ["room.conversation.read", "room.respond"] as const,
  toolCeiling: ["repository.git-status"] as const,
  revision: 2,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T01:00:00.000Z",
});

const assignment = Object.freeze({
  recordVersion: "room-agent-assignment.v1" as const,
  assignmentId: "assignment-1",
  roomId: "room-1",
  profileId: "profile-1",
  actorId: "agent-1",
  displayName: "Research",
  globalResponsibility: "Research verified sources",
  roomResponsibility: "Review the migration evidence",
  participation: "on-mention" as const,
  availability: "ready" as const,
  paused: false,
  capabilityCeiling: ["room.conversation.read", "room.respond"] as const,
  capabilitySubset: ["room.conversation.read", "room.respond"] as const,
  effectiveCapabilities: ["room.conversation.read", "room.respond"] as const,
  toolCeiling: ["repository.git-status"] as const,
  toolSubset: ["repository.git-status"] as const,
  effectiveTools: ["repository.git-status"] as const,
  profileRevision: 2,
  assignmentRevision: 3,
  accessRevision: 4,
  updatedAt: "2026-08-24T01:00:00.000Z",
});

describe("FT-07 sync projections", () => {
  it("accepts exact Profile, provider, Assignment and deployment event projections", () => {
    expect(isAgentProfileProjection(profile)).toBe(true);
    expect(isDeploymentProviderDisclosure({
      providerId: "openai",
      modelId: "gpt-5",
      credentialReadiness: "ready",
    })).toBe(true);
    expect(isRoomAgentAssignmentProjection(assignment, "room-1")).toBe(true);
    expect(isPersistedDeploymentAgentProfileEvent({
      eventId: "event-1",
      streamKind: "deployment",
      streamId: "agent-profile",
      streamSeq: 9,
      actorId: "agent-1",
      occurredAt: "2026-08-24T01:00:00.000Z",
      type: "agent-profile.updated",
      payload: { catalogRevision: 9, profile },
    })).toBe(true);
  });

  it.each([
    { ...profile, roomId: "room-secret" },
    { ...profile, credential: "secret-canary" },
    { ...profile, capabilityCeiling: ["unknown"] },
  ])("rejects unsafe or open Profile projection %#", (candidate) => {
    expect(isAgentProfileProjection(candidate)).toBe(false);
  });

  it("rejects Assignment escalation, writable availability inconsistency and cross-room repair", () => {
    expect(isRoomAgentAssignmentProjection({
      ...assignment,
      capabilitySubset: ["room.memory.read"],
    }, "room-1")).toBe(false);
    expect(isRoomAgentAssignmentProjection({
      ...assignment,
      availability: "paused",
      paused: false,
    }, "room-1")).toBe(false);
    expect(isRoomAgentAssignmentRepairSnapshot({
      type: "room-agent-assignment.repair.snapshot",
      requestId: "repair-1",
      roomId: "room-2",
      watermark: 0,
      roomRevision: 5,
      assignments: [assignment],
      provider: {
        providerId: "openai", modelId: "gpt-5", credentialReadiness: "ready",
      },
    })).toBe(false);
  });

  it("keeps deployment repair free of Room and secret fields", () => {
    expect(isDeploymentAgentProfileRepairSnapshot({
      type: "agent-profile.repair.snapshot",
      requestId: "repair-deployment",
      watermark: 9,
      profiles: [profile],
      provider: {
        providerId: "openai", modelId: "gpt-5", credentialReadiness: "noauth",
      },
    })).toBe(true);
    expect(isDeploymentAgentProfileRepairSnapshot({
      type: "agent-profile.repair.snapshot",
      requestId: "repair-deployment",
      watermark: 9,
      profiles: [{ ...profile, roomId: "room-secret" }],
      provider: {
        providerId: "openai", modelId: "gpt-5", credentialReadiness: "ready",
      },
    })).toBe(false);
  });

  it("accepts stable room Assignment changes in delta and rejects forged nested fields", () => {
    const base = {
      eventId: "room-event-1",
      streamKind: "room" as const,
      streamId: "room-1",
      streamSeq: 1,
      roomId: "room-1",
      actorId: "human-owner",
      occurredAt: "2026-08-24T01:00:00.000Z",
      type: "room.agent-assignment.changed" as const,
    };
    const result = (event: unknown) => ({
      type: "room.sync.result",
      requestId: "sync-1",
      mode: "delta",
      events: [event],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 },
      watermark: 1,
      hasMore: false,
    });
    expect(isRoomSyncResult(result({
      ...base,
      payload: { change: "upserted", roomRevision: 5, assignment },
    }))).toBe(true);
    expect(isRoomSyncResult(result({
      ...base,
      payload: {
        change: "upserted",
        roomRevision: 5,
        assignment: { ...assignment, providerSecret: "secret-canary" },
      },
    }))).toBe(false);
  });
});
