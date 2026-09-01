import { describe, expect, it } from "vitest";
import {
  isFt07AgentSettingsServerFrame,
  parseFt07AgentSettingsClientFrame,
} from "./ft07-agent-settings-protocol.js";
import { parseClientFrame } from "./protocol.js";

const profileFields = {
  displayName: "Research",
  globalResponsibility: "Review evidence",
  capabilityCeiling: ["room.conversation.read", "room.respond"],
  toolCeiling: ["repository.git-status"],
};

const assignmentFields = {
  roomResponsibility: "Review this Room",
  participation: "on-mention",
  capabilitySubset: ["room.conversation.read"],
  toolSubset: ["repository.git-status"],
};

describe("FT-07 Agent Settings protocol", () => {
  it.each([
    { type: "tenant-administrator.list", requestId: "admins" },
    { type: "agent-profile.list", requestId: "profiles" },
    { type: "agent-profile.get", requestId: "profile", profileId: "profile-1" },
    { type: "provider-configuration.disclose", requestId: "provider" },
    { type: "agent-profile.sync", requestId: "sync-profiles", afterSeq: 7, limit: 64 },
    { type: "agent-profile.repair", requestId: "repair-profile" },
    { type: "room-agent-assignment.list", requestId: "assignments", roomId: "room-1" },
    { type: "room-agent-assignment.get", requestId: "assignment", roomId: "room-1", assignmentId: "assignment-1" },
    { type: "room-agent-assignment.repair", requestId: "repair-room", roomId: "room-1" },
    { type: "tenant-administrator.add", requestId: "admin-add", idempotencyKey: "key-1", targetPrincipalId: "human-2", expectedRevision: 1 },
    { type: "agent-profile.create", requestId: "profile-create", idempotencyKey: "key-2", expectedProfileRevision: 0, ...profileFields },
    { type: "agent-profile.update", requestId: "profile-update", idempotencyKey: "key-3", profileId: "profile-1", expectedProfileRevision: 1, ...profileFields },
    { type: "agent-profile.disable", requestId: "profile-disable", idempotencyKey: "key-4", profileId: "profile-1", expectedProfileRevision: 2 },
    { type: "room-agent-assignment.create", requestId: "assignment-create", idempotencyKey: "key-5", roomId: "room-1", profileId: "profile-1", expectedRoomRevision: 1, ...assignmentFields },
    { type: "room-agent-assignment.update", requestId: "assignment-update", idempotencyKey: "key-6", roomId: "room-1", assignmentId: "assignment-1", expectedRoomRevision: 2, expectedAssignmentRevision: 1, ...assignmentFields },
    { type: "room-agent-assignment.pause", requestId: "assignment-pause", idempotencyKey: "key-7", roomId: "room-1", assignmentId: "assignment-1", expectedRoomRevision: 3, expectedAssignmentRevision: 2 },
  ])("accepts exact $type", (frame) => {
    expect(parseFt07AgentSettingsClientFrame(frame)).toEqual({ ok: true, frame });
  });

  it.each([
    { type: "agent-profile.list", requestId: "profiles", roomId: "room-secret" },
    { type: "agent-profile.sync", requestId: "sync-profiles", afterSeq: -1 },
    { type: "agent-profile.sync", requestId: "sync-profiles", limit: 257 },
    { type: "agent-profile.sync", requestId: "sync-profiles", roomId: "room-secret" },
    { type: "room-agent-assignment.get", requestId: "assignment", roomId: "room-1" },
    { type: "provider-configuration.disclose", requestId: "provider", credential: "secret-canary" },
    { type: "agent-profile.create", requestId: "profile-create", idempotencyKey: "key", expectedProfileRevision: 0, ...profileFields, providerId: "forged" },
    { type: "agent-profile.create", requestId: "profile-create", idempotencyKey: "key", expectedProfileRevision: 0, ...profileFields, capabilityCeiling: ["room.respond", "room.conversation.read"] },
    { type: "room-agent-assignment.create", requestId: "assignment-create", idempotencyKey: "key", roomId: "room-1", profileId: "profile-1", expectedRoomRevision: 1, ...assignmentFields, availability: "ready" },
    { type: "room-agent-assignment.create", requestId: "assignment-create", idempotencyKey: "key", roomId: "room-1", profileId: "profile-1", expectedRoomRevision: 1, ...assignmentFields, participation: "silent" },
  ])("rejects unknown, forged or derived fields %#", (frame) => {
    expect(parseFt07AgentSettingsClientFrame(frame)).toMatchObject({ ok: false });
  });

  it("closes ACKs without treating a returned domain object as the fact", () => {
    expect(isFt07AgentSettingsServerFrame({
      type: "agent-settings.ack",
      requestId: "profile-update",
      operation: "agent-profile.update",
      acceptedRevision: 2,
      eventIds: ["event-1"],
      replayed: false,
    })).toBe(true);
    expect(isFt07AgentSettingsServerFrame({
      type: "agent-settings.ack",
      requestId: "profile-update",
      operation: "agent-profile.update",
      acceptedRevision: 2,
      eventIds: ["event-1"],
      replayed: false,
      profile: { profileId: "forged-fact" },
    })).toBe(false);
    expect(isFt07AgentSettingsServerFrame({
      type: "agent-settings.ack",
      requestId: "profile-update",
      operation: "agent-profile.update",
      acceptedRevision: 2,
      eventIds: [],
      replayed: false,
    })).toBe(false);
  });

  it("is wired into the public decoder and preserves only a bounded requestId on rejection", () => {
    expect(parseClientFrame(JSON.stringify({
      type: "agent-profile.list",
      requestId: "profiles",
    }))).toMatchObject({ ok: true, frame: { type: "agent-profile.list" } });
    const rejected = parseClientFrame(JSON.stringify({
      type: "agent-profile.list",
      requestId: "profiles",
      roomId: "room-secret",
      credential: "secret-canary",
    }));
    expect(rejected).toMatchObject({
      ok: false,
      error: { status: 400, code: "invalid_request", requestId: "profiles" },
    });
    expect(JSON.stringify(rejected)).not.toContain("secret-canary");
    expect(JSON.stringify(rejected)).not.toContain("room-secret");
  });

  it("rejects secret and Room leakage from deployment query frames", () => {
    const base = {
      type: "provider-configuration.disclosure",
      requestId: "provider",
      provider: {
        providerId: "openai",
        modelId: "gpt-5",
        credentialReadiness: "ready",
        retentionDisabled: true,
        selectionPolicy: "server-managed-single",
        disclosureRevision: 1,
        disclosedAt: "2026-08-24T00:00:00.000Z",
      },
    };
    expect(isFt07AgentSettingsServerFrame(base)).toBe(true);
    expect(isFt07AgentSettingsServerFrame({ ...base, credential: "secret-canary" })).toBe(false);
    expect(isFt07AgentSettingsServerFrame({ ...base, roomId: "room-secret" })).toBe(false);
    expect(isFt07AgentSettingsServerFrame({ ...base,
      provider: { ...base.provider, credentialGeneration: 2 } })).toBe(false);
    expect(isFt07AgentSettingsServerFrame({ ...base,
      provider: { ...base.provider, keyVersion: "provider-key-v2" } })).toBe(false);
  });
});
