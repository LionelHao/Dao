import { describe, expect, it } from "vitest";
import {
  isAgentProfileProjection,
  isDeploymentAgentProfileRepairSnapshot,
  isDeploymentProviderDisclosure,
  isPersistedDeploymentAgentProfileEvent,
  isRoomAgentAssignmentProjection,
  isRoomAgentAssignmentRepairSnapshot,
  isRoomRepairPage,
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

const provider = Object.freeze({
  providerId: "openai",
  modelId: "gpt-5",
  credentialReadiness: "ready" as const,
  retentionDisabled: true as const,
  selectionPolicy: "server-managed-single" as const,
  disclosureRevision: 1,
  disclosedAt: "2026-08-24T00:00:00.000Z",
});

describe("FT-07 sync projections", () => {
  it("accepts exact Profile, provider, Assignment and deployment event projections", () => {
    expect(isAgentProfileProjection(profile)).toBe(true);
    expect(isDeploymentProviderDisclosure(provider)).toBe(true);
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
    { ...provider, retentionDisabled: false },
    { ...provider, selectionPolicy: "fallback-enabled" },
    { ...provider, disclosureRevision: 0 },
    { ...provider, disclosureRevision: 1.5 },
    { ...provider, disclosedAt: "2026-08-24T00:00:00Z" },
    { ...provider, disclosedAt: "not-a-time" },
    { ...provider, credentialGeneration: 3 },
    { ...provider, keyVersion: "provider-key-v3" },
  ])("rejects non-authoritative, non-canonical, or secret-adjacent Provider disclosure %#", (candidate) => {
    expect(isDeploymentProviderDisclosure(candidate)).toBe(false);
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
      provider,
    })).toBe(false);
  });

  it("keeps deployment repair free of Room and secret fields", () => {
    expect(isDeploymentAgentProfileRepairSnapshot({
      type: "agent-profile.repair.snapshot",
      requestId: "repair-deployment",
      watermark: 9,
      profiles: [profile],
      provider: { ...provider, credentialReadiness: "noauth" },
    })).toBe(true);
    expect(isDeploymentAgentProfileRepairSnapshot({
      type: "agent-profile.repair.snapshot",
      requestId: "repair-deployment",
      watermark: 9,
      profiles: [{ ...profile, roomId: "room-secret" }],
      provider,
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

  it("treats the current Room Assignment as a closed central repair record", () => {
    const page = (record: unknown) => ({
      type: "room.repair.page",
      requestId: "repair-room-assignment",
      snapshotId: "snapshot-room-assignment",
      roomId: "room-1",
      page: 0,
      records: [record],
      watermark: 9,
      snapshotChecksum: "sha256:assignment",
      hasMore: false,
      mode: "materialized",
      expiresAt: "2026-08-24T02:00:00.000Z",
    });

    expect(isRoomRepairPage(page({
      kind: "room-agent-assignment",
      value: assignment,
    }))).toBe(true);
    expect(isRoomRepairPage(page({
      kind: "room-agent-assignment",
      value: { ...assignment, roomId: "room-2" },
    }))).toBe(false);
    expect(isRoomRepairPage(page({
      kind: "room-agent-assignment",
      value: { ...assignment, providerSecret: "secret-canary" },
    }))).toBe(false);
  });
});
