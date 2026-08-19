import { describe, expect, it } from "vitest";
import {
  applyGovernanceAuthorityResponse,
  createGovernanceViewModel,
  type DepartureConflictList,
  type GovernanceProjection,
  type GovernanceSurfaceState,
} from "./view-model.js";

const members = [
  { kind: "human", actorId: "human-owner", displayName: "Owner", role: "member" },
  { kind: "human", actorId: "human-admin-a", displayName: "Admin A", role: "admin" },
  { kind: "human", actorId: "human-admin-b", displayName: "Admin B", role: "admin" },
  { kind: "human", actorId: "human-member", displayName: "Member", role: "member" },
  { kind: "agent", actorId: "agent-ordinary", displayName: "Agent", ordinary: true },
] as const;

function projection(
  lifecycle: GovernanceProjection["lifecycle"] = "active",
): GovernanceProjection {
  return {
    roomId: "room-1",
    projectId: "room-1",
    roomName: "Governed Room",
    lifecycle,
    governanceRevision: lifecycle === "active" ? 7 : 8,
    archiveGeneration: lifecycle === "active" ? 0 : 1,
    ownerActorId: "human-owner",
    ...(lifecycle === "archived"
      ? { archivedAt: "2026-08-19T08:00:00.000Z" }
      : {}),
    members,
  };
}

function state(
  viewerActorId: string,
  lifecycle: GovernanceProjection["lifecycle"] = "active",
): GovernanceSurfaceState {
  return {
    projection: projection(lifecycle),
    viewerActorId,
    connection: { status: "online" },
    operation: { status: "idle" },
    dialog: null,
    reducedMotion: false,
  };
}

const oldConflicts: DepartureConflictList = {
  roomId: "room-1",
  targetActorId: "human-member",
  governanceRevision: 7,
  conflicts: [{
    conflictId: "conflict-old",
    roomId: "room-1",
    subjectId: "request-1",
    kind: "request",
    summary: "Request awaits completion",
    state: "accepted",
    sourceRef: "request-1",
    revision: 1,
    allowedResolutions: ["complete", "transfer"],
  }],
};

describe("governance view-model permission contract", () => {
  it("derives owner/admin/member management without trusting UI-hidden authority", () => {
    const owner = createGovernanceViewModel(state("human-owner"));
    const admin = createGovernanceViewModel(state("human-admin-a"));
    const member = createGovernanceViewModel(state("human-member"));

    expect(owner.viewerRole).toBe("owner");
    expect(owner.member("human-admin-a")?.manageable).toBe(true);
    expect(owner.member("human-member")?.manageable).toBe(true);
    expect(owner.member("agent-ordinary")?.manageable).toBe(true);
    expect(owner.controls.canTransferOwnership).toBe(true);
    expect(owner.controls.canArchive).toBe(true);

    expect(admin.viewerRole).toBe("admin");
    expect(admin.member("human-owner")?.manageable).toBe(false);
    expect(admin.member("human-admin-b")?.manageable).toBe(false);
    expect(admin.member("human-member")?.manageable).toBe(true);
    expect(admin.member("agent-ordinary")?.manageable).toBe(true);
    expect(admin.controls.canTransferOwnership).toBe(false);
    expect(admin.controls.canArchive).toBe(true);

    expect(member.viewerRole).toBe("member");
    expect(member.members.every((entry) => !entry.manageable)).toBe(true);
    expect(member.controls.canArchive).toBe(false);
    expect(member.controls.canSelfLeave).toBe(true);
  });

  it("offers ownership transfer only to current Human members other than the owner", () => {
    const model = createGovernanceViewModel(state("human-owner"));
    expect(model.transferTargets.map((target) => target.actorId)).toEqual([
      "human-admin-a",
      "human-admin-b",
      "human-member",
    ]);
    expect(model.transferTargets.some((target) => target.actorId === "agent-ordinary")).toBe(false);
  });

  it("keeps archived content readable while disabling business controls and allowing reopen", () => {
    const model = createGovernanceViewModel(state("human-admin-a", "archived"));
    expect(model.lifecycle).toBe("archived");
    expect(model.readableSurfaces).toEqual({
      history: true,
      attachments: true,
      projectFacts: true,
      audit: true,
    });
    expect(model.businessControls).toEqual({
      composer: false,
      projectMutation: false,
      agentBusinessControls: false,
    });
    expect(model.controls.canReopen).toBe(true);
    expect(model.controls.canArchive).toBe(false);
  });

  it("fails closed for offline, repair, repair-failed, revoked, and fatal states", () => {
    for (const connection of [
      { status: "offline", asOf: "2026-08-19T08:00:00.000Z", leaseExpiresAt: "2026-08-19T14:00:00.000Z" },
      { status: "repairing", watermark: 42 },
      { status: "repair_failed", errorCode: "snapshot_checksum_mismatch" },
    ] as const) {
      const model = createGovernanceViewModel({ ...state("human-owner"), connection });
      expect(model.mutationsAllowed).toBe(false);
      expect(model.readableSurfaces.history).toBe(true);
      expect(model.businessControls.composer).toBe(false);
    }

    for (const connection of [
      { status: "revoked", scope: "room", purgeCompleted: true },
      { status: "fatal", errorCode: "cache_integrity_failed" },
    ] as const) {
      const model = createGovernanceViewModel({ ...state("human-owner"), connection });
      expect(model.contentLocked).toBe(true);
      expect(model.readableSurfaces.history).toBe(false);
      expect(model.mutationsAllowed).toBe(false);
    }
  });

  it("rejects an inconsistent owner or cross-Room conflict before rendering", () => {
    expect(() => createGovernanceViewModel({
      ...state("human-owner"),
      projection: { ...projection(), ownerActorId: "missing-human" },
    })).toThrow("owner projection is inconsistent");

    expect(() => createGovernanceViewModel({
      ...state("human-owner"),
      departureConflicts: {
        ...oldConflicts,
        conflicts: [{ ...oldConflicts.conflicts[0]!, roomId: "room-other" }],
      },
    })).toThrow("departure conflict crossed Room authority");
  });
});

describe("governance requestId / authority convergence contract", () => {
  it("does not change lifecycle on local submit or ACK and changes only on matched projection", () => {
    const submitting: GovernanceSurfaceState = {
      ...state("human-owner", "archived"),
      operation: {
        status: "submitting",
        requestId: "request-reopen-1",
        command: "room.reopen",
      },
    };

    const wrongAck = applyGovernanceAuthorityResponse(submitting, {
      type: "ack",
      requestId: "request-other",
      command: "room.reopen",
    });
    expect(wrongAck).toBe(submitting);
    expect(wrongAck.projection.lifecycle).toBe("archived");

    const acknowledged = applyGovernanceAuthorityResponse(submitting, {
      type: "ack",
      requestId: "request-reopen-1",
      command: "room.reopen",
    });
    expect(acknowledged.operation.status).toBe("acknowledged");
    expect(acknowledged.projection.lifecycle).toBe("archived");

    const wrongProjection = applyGovernanceAuthorityResponse(acknowledged, {
      type: "projection",
      requestId: "request-other",
      projection: { ...projection("active"), governanceRevision: 9, archiveGeneration: 1 },
    });
    expect(wrongProjection).toBe(acknowledged);

    const converged = applyGovernanceAuthorityResponse(acknowledged, {
      type: "projection",
      requestId: "request-reopen-1",
      projection: { ...projection("active"), governanceRevision: 9, archiveGeneration: 1 },
    });
    expect(converged.operation.status).toBe("succeeded");
    expect(converged.projection.lifecycle).toBe("active");
  });

  it("replaces stale preflight conflicts with the final 409 authority list", () => {
    const latest: DepartureConflictList = {
      ...oldConflicts,
      governanceRevision: 8,
      conflicts: [{
        conflictId: "conflict-new",
        roomId: "room-1",
        subjectId: "confirmation-1",
        kind: "pending_confirmation",
        summary: "Tool confirmation still awaits its bound Human",
        state: "pending",
        sourceRef: "confirmation-1",
        revision: 2,
        allowedResolutions: ["reject_or_revoke"],
      }],
    };
    const current: GovernanceSurfaceState = {
      ...state("human-admin-a"),
      departureConflicts: oldConflicts,
      operation: {
        status: "submitting",
        requestId: "request-remove-1",
        command: "room.member.remove",
      },
    };
    const failed = applyGovernanceAuthorityResponse(current, {
      type: "error",
      requestId: "request-remove-1",
      status: 409,
      code: "departure_blocked",
      details: latest,
    });
    expect(failed.operation.status).toBe("failed");
    expect(failed.departureConflicts).toEqual(latest);
    expect(failed.departureConflicts?.conflicts.map((entry) => entry.conflictId))
      .toEqual(["conflict-new"]);
  });
});
