import { describe, expect, it } from "vitest";
import type { AgentSettingsSnapshot, RoomAgentAssignmentProjection } from "../../agent-profile-routing/contracts.js";
import {
  applyAgentSettingsAuthorityMessage,
  beginAgentSettingsMutation,
  createAgentSettingsInitialState,
  createAgentSettingsViewModel,
} from "./view-model.js";

function assignment(overrides: Partial<RoomAgentAssignmentProjection> = {}): RoomAgentAssignmentProjection {
  return {
    recordVersion: "room-agent-assignment.v1", assignmentId: "assignment-research", roomId: "room-dao",
    profileId: "profile-research", actorId: "agent-research", displayName: "检索员",
    globalResponsibility: "跨 Room 的资料检索与来源核验", roomResponsibility: "核对迁移资料与引用",
    participation: "on-mention", availability: "ready", paused: false,
    capabilityCeiling: ["room.conversation.read", "room.memory.read"], capabilitySubset: ["room.memory.read"],
    effectiveCapabilities: ["room.memory.read"], toolCeiling: ["http-json.read", "room-memory.read"],
    toolSubset: ["room-memory.read"], effectiveTools: ["room-memory.read"], profileRevision: 4,
    assignmentRevision: 8, accessRevision: 6, ...overrides,
  };
}

function snapshot(overrides: Partial<AgentSettingsSnapshot> = {}): AgentSettingsSnapshot {
  return {
    recordVersion: "agent-settings.snapshot.v1", cursor: 31,
    viewer: { actorId: "human-owner", tenantAdministrator: true, roomRole: "owner" },
    provider: { providerId: "openai", modelId: "gpt-5", credentialStatus: "configured", retentionDisabled: true, selectionPolicy: "server-managed-single" },
    profileCatalog: { status: "available", revision: 4, profiles: [{
      recordVersion: "agent-profile.v1", profileId: "profile-research", actorId: "agent-research",
      displayName: "检索员", globalResponsibility: "跨 Room 的资料检索与来源核验", status: "enabled",
      capabilityCeiling: ["room.conversation.read", "room.memory.read"], toolCeiling: ["http-json.read", "room-memory.read"],
      revision: 4, createdAt: "2026-08-20T08:00:00.000Z", updatedAt: "2026-08-24T08:00:00.000Z",
    }] },
    room: { status: "available", roomId: "room-dao", roomName: "Dao 交付", lifecycle: "active", roomRevision: 12, assignments: [assignment()] },
    ...overrides,
  };
}

describe("FT-07 Agent Settings authority state", () => {
  it("keeps ACK pending and changes stable facts only after a matching stable event", () => {
    const ready = applyAgentSettingsAuthorityMessage(createAgentSettingsInitialState(), {
      type: "snapshot",
      snapshot: snapshot(),
    });
    const submitting = beginAgentSettingsMutation(ready, {
      requestId: "request-1",
      intent: {
        command: "assignment.pause",
        roomId: "room-dao",
        assignmentId: "assignment-research",
        expectedRoomRevision: 12,
        expectedAssignmentRevision: 8,
      },
    });
    const acknowledged = applyAgentSettingsAuthorityMessage(submitting, {
      type: "ack",
      requestId: "request-1",
      command: "assignment.pause",
      replayed: false,
      acceptedRevision: 9,
      eventIds: ["event-1"],
    });
    expect(acknowledged.operation.status).toBe("acknowledged");
    expect(acknowledged.snapshot?.room.assignments[0]?.availability).toBe("ready");

    const converged = applyAgentSettingsAuthorityMessage(acknowledged, {
      type: "stable-event",
      eventId: "event-1",
      cursor: 32,
      causationRequestId: "request-1",
      event: {
        kind: "assignment.upserted",
        roomRevision: 13,
        assignment: assignment({ availability: "paused", paused: true, assignmentRevision: 9 }),
      },
    });
    expect(converged.operation.status).toBe("succeeded");
    expect(converged.snapshot?.room.assignments[0]?.availability).toBe("paused");
  });

  it("retains the last complete projection through offline/repair failure and flips repair atomically", () => {
    const ready = applyAgentSettingsAuthorityMessage(createAgentSettingsInitialState(), {
      type: "snapshot", snapshot: snapshot(),
    });
    const repairing = applyAgentSettingsAuthorityMessage(ready, {
      type: "repair-started", generation: 7, watermark: 50,
    });
    expect(repairing.snapshot).toBe(ready.snapshot);
    expect(createAgentSettingsViewModel(repairing).writeLocked).toBe(true);
    const failed = applyAgentSettingsAuthorityMessage(repairing, {
      type: "repair-failed", generation: 7, watermark: 50, errorCode: "projection_hash_mismatch",
    });
    expect(failed.snapshot).toBe(ready.snapshot);
    expect(createAgentSettingsViewModel(failed).visibleState).toBe("repair-failed");
    const repaired = applyAgentSettingsAuthorityMessage(repairing, {
      type: "repair-completed", generation: 7, watermark: 50, snapshot: snapshot({ cursor: 50 }),
    });
    expect(repaired.snapshot?.cursor).toBe(50);
    expect(repaired.connection.status).toBe("online");
  });

  it("purges Profile/Assignment facts on revoke and never leaks them from the view model", () => {
    const ready = applyAgentSettingsAuthorityMessage(createAgentSettingsInitialState(), {
      type: "snapshot", snapshot: snapshot(),
    });
    const revoked = applyAgentSettingsAuthorityMessage(ready, {
      type: "access-revoked", scope: "session", purgeCompleted: true,
    });
    const model = createAgentSettingsViewModel(revoked);
    expect(revoked.snapshot).toBeUndefined();
    expect(model.visibleState).toBe("revoked");
    expect(model.profiles).toEqual([]);
    expect(model.assignments).toEqual([]);
  });

  it("separates Tenant Administrator Profile authority from Room assignment authority", () => {
    const tenantOnly = createAgentSettingsViewModel({
      ...createAgentSettingsInitialState(),
      query: { status: "ready" },
      snapshot: snapshot({
        viewer: { actorId: "tenant-admin", tenantAdministrator: true, roomRole: null },
        room: { status: "forbidden", roomId: "room-dao" },
      }),
    });
    expect(tenantOnly.permissions.canManageProfiles).toBe(true);
    expect(tenantOnly.permissions.canManageAssignments).toBe(false);

    const ownerOnly = createAgentSettingsViewModel({
      ...createAgentSettingsInitialState(),
      query: { status: "ready" },
      snapshot: snapshot({
        viewer: { actorId: "room-owner", tenantAdministrator: false, roomRole: "owner" },
        profileCatalog: { status: "forbidden" },
      }),
    });
    expect(ownerOnly.permissions.canManageProfiles).toBe(false);
    expect(ownerOnly.permissions.canManageAssignments).toBe(true);
    expect(ownerOnly.profiles).toEqual([]);
  });

  it.each([
    [400, "invalid_request", "修正输入"],
    [401, "authentication_required", "重新认证"],
    [403, "role_forbidden", "查看权限"],
    [409, "assignment_revision_conflict", "载入最新版本"],
    [410, "assignment_gone", "刷新权威状态"],
    [429, "capacity_limited", "稍后重试"],
    [503, "authority_unavailable", "重试"],
  ] as const)("maps %s/%s to a finite recovery", (status, code, recovery) => {
    const model = createAgentSettingsViewModel({
      ...createAgentSettingsInitialState(),
      query: {
        status: "failed",
        requestId: "query-1",
        error: { status, code } as never,
      },
    });
    expect(model.error?.recoveryLabel).toBe(recovery);
    expect(model.focusTarget).toBe("error-summary");
  });

  it("shows empty and archived read-only branches without inventing Agent facts", () => {
    const empty = createAgentSettingsViewModel({
      ...createAgentSettingsInitialState(),
      query: { status: "ready" },
      snapshot: snapshot({
        profileCatalog: { status: "available", revision: 0, profiles: [] },
        room: { ...snapshot().room, assignments: [] },
      }),
    });
    expect(empty.visibleState).toBe("empty");
    const archived = createAgentSettingsViewModel({
      ...createAgentSettingsInitialState(),
      query: { status: "ready" },
      snapshot: snapshot({ room: { ...snapshot().room, lifecycle: "archived" } }),
    });
    expect(archived.visibleState).toBe("archived-read-only");
    expect(archived.assignments[0]?.actions.map((action) => action.command)).toEqual([
      "assignment.pause", "assignment.remove",
    ]);
  });
});
