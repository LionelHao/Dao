import { describe, expect, it } from "vitest";
import {
  deriveAssignmentAvailability,
  evaluateAssignmentExecutionGate,
  evaluateAssignmentMutation,
  isAssignmentMutationRequest,
  type AssignmentMutationAuthority,
  type AssignmentMutationRequest,
} from "./assignment-policy.js";

const createRequest: AssignmentMutationRequest = {
  kind: "create",
  requestId: "request-1",
  idempotencyKey: "key-1",
  roomId: "room-1",
  expectedRoomRevision: 4,
  profileId: "profile-1",
  participation: "active",
  roomResponsibility: "Review deployment risk",
  capabilitySubset: ["room.project.read", "room.respond"],
  toolSubset: ["repository.git-status"],
};

const authority: AssignmentMutationAuthority = {
  authenticatedActorKind: "human",
  roomRole: "owner",
  roomStatus: "active",
  roomRevision: 4,
  profileStatus: "enabled",
  capabilityCeiling: ["room.project.read", "room.respond"],
  toolCeiling: ["repository.git-status", "room-memory.read"],
  currentAssignment: null,
};

describe("Room Assignment request and authority policy", () => {
  it("accepts only exact active/on-mention request contracts", () => {
    expect(isAssignmentMutationRequest(createRequest)).toBe(true);
    expect(isAssignmentMutationRequest({ ...createRequest, participation: "on-mention" })).toBe(true);
    expect(isAssignmentMutationRequest({ ...createRequest, participation: "silent" })).toBe(false);
    const withoutIdempotencyKey = { ...createRequest } as Record<string, unknown>;
    delete withoutIdempotencyKey.idempotencyKey;
    expect(isAssignmentMutationRequest(withoutIdempotencyKey)).toBe(false);
    expect(isAssignmentMutationRequest({ ...createRequest, availability: "ready" })).toBe(false);
    expect(isAssignmentMutationRequest({
      kind: "pause", requestId: "request-2", idempotencyKey: "key-2", roomId: "room-1",
      assignmentId: "assignment-1", expectedRoomRevision: 4, expectedAssignmentRevision: 2,
    })).toBe(true);
    expect(isAssignmentMutationRequest({
      kind: "pause", requestId: "request-2", idempotencyKey: "key-2", roomId: "room-1",
      assignmentId: "assignment-1", expectedRoomRevision: 4,
      expectedAssignmentRevision: 2, paused: true,
    })).toBe(false);
    expect(isAssignmentMutationRequest({
      kind: "pause", requestId: "request-2", idempotencyKey: "key-2", roomId: "room-1",
      assignmentId: "assignment-1", expectedRoomRevision: 4, expectedAssignmentRevision: 0,
    })).toBe(false);
    expect(isAssignmentMutationRequest({
      ...createRequest, roomResponsibility: "x".repeat(4_000),
    })).toBe(true);
    expect(isAssignmentMutationRequest({
      ...createRequest, roomResponsibility: "x".repeat(4_001),
    })).toBe(false);
  });

  it.each(["member", null] as const)("forbids a current %s from mutation", (roomRole) => {
    expect(evaluateAssignmentMutation(createRequest, { ...authority, roomRole }))
      .toEqual({ allowed: false, reason: "forbidden" });
  });

  it("forbids Agent principals and deployment admins without a Room owner/admin role", () => {
    expect(evaluateAssignmentMutation(createRequest, {
      ...authority, authenticatedActorKind: "agent",
    })).toEqual({ allowed: false, reason: "forbidden" });
    expect(evaluateAssignmentMutation(createRequest, { ...authority, roomRole: null }))
      .toEqual({ allowed: false, reason: "forbidden" });
  });

  it("enforces Room and Assignment revision CAS before writes", () => {
    expect(evaluateAssignmentMutation(createRequest, { ...authority, roomRevision: 5 }))
      .toEqual({ allowed: false, reason: "room_revision_conflict" });
    expect(evaluateAssignmentMutation({
      kind: "pause", requestId: "request-2", idempotencyKey: "key-2", roomId: "room-1",
      assignmentId: "assignment-1", expectedRoomRevision: 4, expectedAssignmentRevision: 7,
    }, {
      ...authority,
      currentAssignment: {
        revision: 8, participation: "active", roomResponsibility: "Reviewer", paused: false,
        capabilitySubset: ["room.project.read"], toolSubset: ["repository.git-status"],
      },
    })).toEqual({ allowed: false, reason: "assignment_revision_conflict" });
  });

  it("intersects Assignment grants with the Global Profile ceiling", () => {
    expect(evaluateAssignmentMutation({
      ...createRequest, capabilitySubset: ["room.project.read", "room.respond", "room.admin"],
    }, authority)).toEqual({ allowed: false, reason: "profile_ceiling_exceeded" });
    expect(evaluateAssignmentMutation({
      ...createRequest, toolSubset: ["repository.git-status", "shell.exec"],
    }, authority)).toEqual({ allowed: false, reason: "profile_ceiling_exceeded" });
  });

  it("allows only pause, remove, and subset/participation reductions while archived", () => {
    const archived: AssignmentMutationAuthority = {
      ...authority,
      roomStatus: "archived",
      currentAssignment: {
        revision: 3, participation: "active", roomResponsibility: "Reviewer", paused: false,
        capabilitySubset: ["room.project.read", "room.respond"],
        toolSubset: ["repository.git-status", "room-memory.read"],
      },
    };
    const base = {
      requestId: "request-3", idempotencyKey: "key-3", roomId: "room-1",
      expectedRoomRevision: 4,
      assignmentId: "assignment-1", expectedAssignmentRevision: 3,
    } as const;
    expect(evaluateAssignmentMutation({ kind: "pause", ...base }, archived))
      .toEqual({ allowed: true, securityReduction: true });
    expect(evaluateAssignmentMutation({ kind: "remove", ...base }, archived))
      .toEqual({ allowed: true, securityReduction: true });
    expect(evaluateAssignmentMutation({ kind: "resume", ...base }, archived))
      .toEqual({ allowed: false, reason: "archived_expansion_forbidden" });
    expect(evaluateAssignmentMutation({
      kind: "update", ...base, participation: "on-mention", roomResponsibility: "Reviewer",
      capabilitySubset: ["room.project.read"], toolSubset: ["repository.git-status"],
    }, archived)).toEqual({ allowed: true, securityReduction: true });
    expect(evaluateAssignmentMutation({
      kind: "update", ...base, participation: "active", roomResponsibility: "Reviewer",
      capabilitySubset: ["room.project.read", "room.respond"],
      toolSubset: ["repository.git-status", "room-memory.read"],
    }, archived)).toEqual({ allowed: false, reason: "archived_expansion_forbidden" });
    expect(evaluateAssignmentMutation({
      kind: "update", ...base, participation: "active", roomResponsibility: "Changed role",
      capabilitySubset: ["room.project.read"], toolSubset: ["repository.git-status"],
    }, archived)).toEqual({ allowed: false, reason: "archived_expansion_forbidden" });
    expect(evaluateAssignmentMutation({
      kind: "update", ...base, participation: "active", roomResponsibility: "Reviewer",
      capabilitySubset: ["room.project.read", "room.respond"],
      toolSubset: ["repository.git-status", "room-memory.read", "sandbox-file.write"],
    }, { ...archived, toolCeiling: [...archived.toolCeiling, "sandbox-file.write"] }))
      .toEqual({ allowed: false, reason: "archived_expansion_forbidden" });
  });
});

describe("Assignment availability and execution gate", () => {
  const readyFacts = {
    profileEnabled: true,
    assignmentCurrent: true,
    roomActive: true,
    membershipCurrent: true,
    durablePaused: false,
    providerAuthenticated: true,
    durableRunningExecutionCount: 0,
  } as const;

  it("derives ineligible separately and uses paused > noauth > busy > ready precedence", () => {
    expect(deriveAssignmentAvailability({ ...readyFacts, profileEnabled: false }))
      .toEqual({ eligible: false });
    expect(deriveAssignmentAvailability({ ...readyFacts, durableRunningExecutionCount: 1 }))
      .toEqual({ eligible: true, availability: "busy" });
    expect(deriveAssignmentAvailability({
      ...readyFacts, providerAuthenticated: false, durableRunningExecutionCount: 1,
    })).toEqual({ eligible: true, availability: "noauth" });
    expect(deriveAssignmentAvailability({
      ...readyFacts, durablePaused: true, providerAuthenticated: false,
      durableRunningExecutionCount: 1,
    })).toEqual({ eligible: true, availability: "paused" });
    expect(deriveAssignmentAvailability(readyFacts))
      .toEqual({ eligible: true, availability: "ready" });
  });

  it("uses only restart-safe durable/derived inputs", () => {
    expect(() => deriveAssignmentAvailability({
      ...readyFacts, durableRunningExecutionCount: -1,
    })).toThrow("Running execution count is invalid");
    expect(Object.keys(readyFacts).sort()).toEqual([
      "assignmentCurrent", "durablePaused", "durableRunningExecutionCount", "membershipCurrent",
      "profileEnabled", "providerAuthenticated", "roomActive",
    ]);
  });

  it("gives an on-mention direct invocation the full approved intersection", () => {
    const result = evaluateAssignmentExecutionGate({
      ...readyFacts,
      stage: "execution",
      participation: "on-mention",
      origin: "direct",
      profileCapabilities: ["room.project.read", "room.respond"],
      assignmentCapabilities: ["room.project.read", "room.respond"],
      membershipCapabilities: ["room.respond"],
      profileTools: ["repository.git-status", "room-memory.read"],
      assignmentTools: ["repository.git-status", "room-memory.read"],
      membershipTools: ["repository.git-status"],
    });
    expect(result).toEqual({
      allowed: true,
      admission: "start",
      effectiveCapabilities: ["room.respond"],
      effectiveTools: ["repository.git-status"],
    });
  });

  it("queues busy direct work but excludes busy routed/project work", () => {
    const base = {
      ...readyFacts,
      stage: "intent-admission" as const,
      participation: "on-mention" as const,
      origin: "routed" as const,
      profileCapabilities: ["room.respond"], assignmentCapabilities: ["room.respond"],
      membershipCapabilities: ["room.respond"], profileTools: ["room-memory.read"],
      assignmentTools: ["room-memory.read"], membershipTools: ["room-memory.read"],
    };
    expect(evaluateAssignmentExecutionGate(base).allowed).toBe(false);
    const busyDirect = evaluateAssignmentExecutionGate({
      ...base, origin: "direct", durableRunningExecutionCount: 1,
    });
    expect(busyDirect).toEqual({
      allowed: true,
      admission: "queue",
      effectiveCapabilities: ["room.respond"],
      effectiveTools: ["room-memory.read"],
    });
    expect(evaluateAssignmentExecutionGate({
      ...base, participation: "active", origin: "routed", durableRunningExecutionCount: 1,
    }).allowed).toBe(false);
    expect(evaluateAssignmentExecutionGate({
      ...base, participation: "active", origin: "project-boundary",
      durableRunningExecutionCount: 1,
    }).allowed).toBe(false);
    expect(evaluateAssignmentExecutionGate({
      ...base, stage: "execution", origin: "direct", durableRunningExecutionCount: 1,
    }).allowed).toBe(false);
  });

  it("denies direct invocation while paused or noauth", () => {
    const base = {
      ...readyFacts,
      stage: "intent-admission" as const,
      participation: "on-mention" as const,
      origin: "direct" as const,
      profileCapabilities: ["room.respond"], assignmentCapabilities: ["room.respond"],
      membershipCapabilities: ["room.respond"], profileTools: ["room-memory.read"],
      assignmentTools: ["room-memory.read"], membershipTools: ["room-memory.read"],
    };
    expect(evaluateAssignmentExecutionGate({ ...base, durablePaused: true }).allowed).toBe(false);
    expect(evaluateAssignmentExecutionGate({ ...base, providerAuthenticated: false }).allowed).toBe(false);
  });
});
