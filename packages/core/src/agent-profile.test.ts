import { describe, expect, it } from "vitest";
import {
  AGENT_CAPABILITY_IDS,
  AGENT_TOOL_IDS,
  asAgentActorId,
  asAgentAssignmentId,
  asAgentProfileId,
  canonicalizeAgentCapabilities,
  canonicalizeAgentTools,
  deriveAgentAvailability,
  intersectAgentAuthority,
  isAgentAssignmentRecord,
  isAgentAvailabilityFacts,
  isAgentProfileRecord,
  isAssignmentWithinProfileCeiling,
  isCanonicalAgentCapabilitySet,
  isCanonicalAgentToolSet,
  isRoomAgentProjection,
  type AgentAssignmentRecord,
  type AgentProfileRecord,
} from "./index.js";

const NOW = "2026-08-24T00:00:00.000Z";
const actorId = asAgentActorId("agent-1");
const profileId = asAgentProfileId("profile-1");
const assignmentId = asAgentAssignmentId("assignment-1");

const profile: AgentProfileRecord = {
  profileId,
  actorId,
  displayName: "Reviewer",
  globalResponsibility: "Review correctness and safety.",
  status: "enabled",
  capabilityCeiling: ["room.conversation.read", "room.respond"],
  toolCeiling: ["http-json.read", "repository.git-status"],
  revision: 2,
  createdAt: NOW,
  updatedAt: NOW,
};

const assignment: AgentAssignmentRecord = {
  assignmentId,
  roomId: "room-1",
  profileId,
  actorId,
  roomResponsibility: "Review the release candidate.",
  status: "current",
  participation: "on-mention",
  paused: false,
  capabilitySubset: ["room.conversation.read", "room.respond"],
  toolSubset: ["repository.git-status"],
  revision: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("FT-07 closed Agent Profile contracts", () => {
  it("accepts exact Profile and Assignment records and rejects derived or unknown keys", () => {
    expect(isAgentProfileRecord(profile)).toBe(true);
    expect(isAgentAssignmentRecord(assignment)).toBe(true);
    expect(isAgentProfileRecord({ ...profile, availability: "ready" })).toBe(false);
    expect(isAgentAssignmentRecord({ ...assignment, readiness: "ready" })).toBe(false);
    expect(isAgentAssignmentRecord({ ...assignment, participation: "silent" })).toBe(false);
    expect(isAgentAssignmentRecord({ ...assignment, roomResponsibility: "  padded  " })).toBe(false);
    expect(isAgentAssignmentRecord({ ...assignment, removedAt: NOW })).toBe(false);
    expect(isAgentAssignmentRecord({
      ...assignment, status: "removed", removedAt: NOW,
    })).toBe(true);
  });

  it("keeps capability and tool registries closed, canonical, sorted, and unique", () => {
    expect(AGENT_CAPABILITY_IDS).toEqual([
      "room.conversation.read", "room.memory.read", "room.project.read", "room.respond",
    ]);
    expect(AGENT_TOOL_IDS).toEqual([
      "http-json.read", "repository.git-status", "sandbox-file.write",
    ]);
    expect(isCanonicalAgentCapabilitySet(["room.memory.read", "room.respond"])).toBe(true);
    expect(isCanonicalAgentCapabilitySet(["room.respond", "room.memory.read"])).toBe(false);
    expect(isCanonicalAgentCapabilitySet(["room.respond", "room.respond"])).toBe(false);
    expect(isCanonicalAgentCapabilitySet(["unknown.read"])).toBe(false);
    expect(isCanonicalAgentToolSet(["http-json.read", "repository.git-status"])).toBe(true);
    expect(isCanonicalAgentToolSet(["repository.git-status", "http-json.read"])).toBe(false);
    expect(isCanonicalAgentToolSet(["shell.exec"])).toBe(false);
    expect(canonicalizeAgentCapabilities([
      "room.respond", "room.conversation.read", "room.respond",
    ])).toEqual(["room.conversation.read", "room.respond"]);
    expect(canonicalizeAgentTools([
      "repository.git-status", "http-json.read", "repository.git-status",
    ])).toEqual(["http-json.read", "repository.git-status"]);
  });

  it("rejects Assignment authority expansion and computes the three-way intersection", () => {
    expect(isAssignmentWithinProfileCeiling(profile, assignment)).toBe(true);
    expect(isAssignmentWithinProfileCeiling(profile, {
      ...assignment, toolSubset: ["sandbox-file.write"],
    })).toBe(false);
    expect(isAssignmentWithinProfileCeiling(profile, {
      ...assignment, actorId: asAgentActorId("agent-other"),
    })).toBe(false);
    expect(intersectAgentAuthority(
      profile,
      assignment,
      ["room.conversation.read"],
      ["repository.git-status", "sandbox-file.write"],
    )).toEqual({
      effectiveCapabilities: ["room.conversation.read"],
      effectiveTools: ["repository.git-status"],
    });
    expect(intersectAgentAuthority(
      { ...profile, status: "disabled" }, assignment,
      ["room.conversation.read"], ["repository.git-status"],
    )).toBeNull();
  });

  it("derives availability from independent facts with the frozen precedence", () => {
    const ready = {
      profileEnabled: true, assignmentCurrent: true, roomActive: true, accessValid: true,
      paused: false, providerReady: true, runningExecutionCount: 0,
    } as const;
    expect(isAgentAvailabilityFacts(ready)).toBe(true);
    expect(deriveAgentAvailability(ready)).toBe("ready");
    expect(deriveAgentAvailability({ ...ready, runningExecutionCount: 1 })).toBe("busy");
    expect(deriveAgentAvailability({
      ...ready, providerReady: false, runningExecutionCount: 1,
    })).toBe("noauth");
    expect(deriveAgentAvailability({
      ...ready, paused: true, providerReady: false, runningExecutionCount: 1,
    })).toBe("paused");
    expect(deriveAgentAvailability({ ...ready, accessValid: false })).toBeNull();
    expect(isAgentAvailabilityFacts({ ...ready, availability: "ready" })).toBe(false);
  });

  it("accepts only an exact, canonical Room projection", () => {
    const projection = {
      assignmentId, roomId: "room-1", profileId, actorId, displayName: "Reviewer",
      globalResponsibility: "Review correctness and safety.",
      roomResponsibility: "Review the release candidate.", participation: "on-mention",
      availability: "ready", effectiveCapabilities: ["room.conversation.read"],
      effectiveTools: ["repository.git-status"], profileRevision: 2,
      assignmentRevision: 3, accessRevision: 4, updatedAt: NOW,
    } as const;
    expect(isRoomAgentProjection(projection)).toBe(true);
    expect(isRoomAgentProjection({ ...projection, providerId: "openai" })).toBe(false);
    expect(isRoomAgentProjection({ ...projection, participation: "silent" })).toBe(false);
    expect(isRoomAgentProjection({
      ...projection, effectiveCapabilities: ["room.respond", "room.conversation.read"],
    })).toBe(false);
  });
});
