import { describe, expect, it } from "vitest";
import * as importedDomain from "./index.js";

type DomainUnderTest = {
  isActor?: (value: unknown) => boolean;
  isAgentConfigurationRequest?: (value: unknown) => boolean;
  isAgentActor?: (value: unknown) => boolean;
  isAgentRoomMembership?: (value: unknown) => boolean;
  isEvent?: (value: unknown) => boolean;
  isHumanActor?: (value: unknown) => boolean;
  isHumanInvitationRequest?: (value: unknown) => boolean;
  isHumanRoomMembership?: (value: unknown) => boolean;
  isMessageAcceptedAck?: (value: unknown) => boolean;
  isMessageDraft?: (value: unknown) => boolean;
  isMessage?: (value: unknown) => boolean;
  isRoom?: (value: unknown) => boolean;
  isRoomGovernanceView?: (value: unknown) => boolean;
  isDepartureConflictList?: (value: unknown) => boolean;
  isRoomMemorySource?: (value: unknown) => boolean;
  isRoomMemoryVersion?: (value: unknown) => boolean;
  isRoomMemoryHealth?: (value: unknown) => boolean;
  isRoomMemoryRawDeltaPage?: (value: unknown) => boolean;
  isRoomMemoryRequest?: (value: unknown) => boolean;
  isRoomMemoryProtocolFrame?: (value: unknown) => boolean;
  isRoomMemoryRepairRecord?: (value: unknown, expectedRoomId?: string) => boolean;
  isAgentInvocationIntent?: (value: unknown) => boolean;
  isAgentExecution?: (value: unknown) => boolean;
  isAgentExecutionAttempt?: (value: unknown) => boolean;
  isAgentExecutionRetryReceipt?: (value: unknown) => boolean;
  isScopedCancellationReceipt?: (value: unknown) => boolean;
  isProjectBoundaryInvocationResult?: (value: unknown) => boolean;
  isProjectBoundaryInvocationRequest?: (value: unknown) => boolean;
  isLegacyAgentExecution?: (value: unknown) => boolean;
  isLegacyAgentInvocationIntent?: (value: unknown) => boolean;
  isLegacyHumanPreemptionNotice?: (value: unknown) => boolean;
};

const domain = importedDomain as unknown as DomainUnderTest;

describe("FT-08 root exports", () => {
  it("exposes canonical lifecycle guards and explicitly named legacy readers", () => {
    expect(domain.isAgentInvocationIntent).toBeTypeOf("function");
    expect(domain.isAgentExecution).toBeTypeOf("function");
    expect(domain.isAgentExecutionAttempt).toBeTypeOf("function");
    expect(domain.isAgentExecutionRetryReceipt).toBeTypeOf("function");
    expect(domain.isScopedCancellationReceipt).toBeTypeOf("function");
    expect(domain.isProjectBoundaryInvocationResult).toBeTypeOf("function");
    expect(domain.isProjectBoundaryInvocationRequest).toBeTypeOf("function");
    expect(domain.isLegacyAgentExecution).toBeTypeOf("function");
    expect(domain.isLegacyAgentInvocationIntent).toBeTypeOf("function");
    expect(domain.isLegacyHumanPreemptionNotice).toBeTypeOf("function");
  });
});

describe("room memory root exports", () => {
  it("exposes the FT-05 closed contract guards", () => {
    expect(domain.isRoomMemorySource).toBeTypeOf("function");
    expect(domain.isRoomMemoryVersion).toBeTypeOf("function");
    expect(domain.isRoomMemoryHealth).toBeTypeOf("function");
    expect(domain.isRoomMemoryRawDeltaPage).toBeTypeOf("function");
    expect(domain.isRoomMemoryRequest).toBeTypeOf("function");
    expect(domain.isRoomMemoryProtocolFrame).toBeTypeOf("function");
    expect(domain.isRoomMemoryRepairRecord).toBeTypeOf("function");
  });
});

describe("room governance guards", () => {
  const governance = {
    roomId: "room-1", projectId: "room-1", lifecycle: "active",
    governanceRevision: 2, ownerActorId: "human-1", archiveGeneration: 0,
  };

  it("enforces Room=Project and a closed governance projection", () => {
    expect(domain.isRoomGovernanceView?.(governance)).toBe(true);
    expect(domain.isRoomGovernanceView?.({ ...governance, projectId: "project-2" })).toBe(false);
    expect(domain.isRoomGovernanceView?.({ ...governance, ownerRole: "owner" })).toBe(false);
    expect(domain.isRoomGovernanceView?.({ ...governance, lifecycle: "archived" })).toBe(false);
    expect(domain.isRoomGovernanceView?.({
      ...governance, lifecycle: "archived", archivedAt: "2026-08-18T00:00:00.000Z",
    })).toBe(true);
  });

  it("rejects cross-room, duplicate and secret-bearing departure conflicts", () => {
    const conflict = {
      conflictId: "conflict-1", roomId: "room-1", subjectId: "human-2",
      kind: "confirmation", title: "Pending confirmation", state: "pending",
      allowedResolutions: ["reject_or_revoke"], sourceId: "confirmation-1", revision: 1,
    };
    const list = { roomId: "room-1", targetActorId: "human-2", governanceRevision: 2, conflicts: [conflict] };
    expect(domain.isDepartureConflictList?.(list)).toBe(true);
    expect(domain.isDepartureConflictList?.({ ...list, conflicts: [{ ...conflict, roomId: "room-2" }] })).toBe(false);
    expect(domain.isDepartureConflictList?.({ ...list, conflicts: [{ ...conflict, grant: "secret" }] })).toBe(false);
    expect(domain.isDepartureConflictList?.({ ...list, conflicts: [conflict, conflict] })).toBe(false);
  });
});

describe("domain kernel guards", () => {
  it("distinguishes human reachability from agent readiness and guards all core records", () => {
    const human = {
      id: "human-lionel",
      kind: "human",
      displayName: "Lionel",
      reachability: "dnd",
    };
    const agent = {
      id: "agent-architecture",
      kind: "agent",
      displayName: "Architecture agent",
      readiness: "busy",
      toolPermissions: ["repository.read"],
    };

    expect(domain.isHumanActor).toBeTypeOf("function");
    expect(domain.isAgentActor).toBeTypeOf("function");
    expect(domain.isActor).toBeTypeOf("function");
    expect(domain.isEvent).toBeTypeOf("function");
    expect(domain.isMessage).toBeTypeOf("function");
    expect(domain.isRoom).toBeTypeOf("function");

    expect(domain.isHumanActor?.(human)).toBe(true);
    expect(domain.isAgentActor?.(agent)).toBe(true);
    expect(domain.isActor?.(human)).toBe(true);
    expect(domain.isActor?.(agent)).toBe(true);
    expect(domain.isAgentActor?.({ ...agent, readiness: "online" })).toBe(false);
    expect(domain.isHumanActor?.({ ...human, readiness: "ready" })).toBe(false);
    expect(
      domain.isEvent?.({
        id: "event-1",
        type: "room.created",
        actorId: human.id,
        actorKind: human.kind,
        roomId: "room-1",
        occurredAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      domain.isMessage?.({
        id: "message-1",
        roomId: "room-1",
        authorId: agent.id,
        authorKind: agent.kind,
        body: "I am ready.",
        sentAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      domain.isRoom?.({
        id: "room-1",
        name: "Native IM",
        memberIds: [human.id, agent.id],
        createdAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("accepts acknowledgements only after message persistence", () => {
    expect(
      domain.isMessageAcceptedAck?.({
        type: "message.accepted",
        requestId: "req-1",
        messageId: "message-1",
        persistedAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      domain.isMessageAcceptedAck?.({
        type: "message.accepted",
        requestId: "req-1",
        messageId: "message-1",
      }),
    ).toBe(false);
  });

  it("keeps human invitations distinct from agent configuration", () => {
    const humanJoin = {
      kind: "human-invitation",
      roomId: "room-1",
      inviteeActorId: "human-2",
    };
    const agentJoin = {
      kind: "agent-configuration",
      roomId: "room-1",
      agentId: "agent-search",
      participation: "active",
      toolPermissions: ["search"],
    };

    expect(domain.isHumanInvitationRequest).toBeTypeOf("function");
    expect(domain.isAgentConfigurationRequest).toBeTypeOf("function");
    expect(domain.isHumanInvitationRequest?.(humanJoin)).toBe(true);
    expect(domain.isAgentConfigurationRequest?.(agentJoin)).toBe(true);
    expect(domain.isHumanInvitationRequest?.(agentJoin)).toBe(false);
    expect(domain.isAgentConfigurationRequest?.(humanJoin)).toBe(false);
    expect(
      domain.isAgentConfigurationRequest?.({
        ...agentJoin,
        toolPermissions: [],
      }),
    ).toBe(false);
  });

  it.each([
    ["agentId", "agent-search"],
    ["participation", "active"],
    ["toolPermissions", ["search"]],
  ])("rejects %s on human invitations", (field, value) => {
    expect(
      domain.isHumanInvitationRequest?.({
        kind: "human-invitation",
        roomId: "room-1",
        inviteeActorId: "human-2",
        [field]: value,
      }),
    ).toBe(false);
  });

  it.each([["inviteeActorId", "human-2"]])(
    "rejects %s on agent configurations",
    (field, value) => {
      expect(
        domain.isAgentConfigurationRequest?.({
          kind: "agent-configuration",
          roomId: "room-1",
          agentId: "agent-search",
          participation: "active",
          toolPermissions: ["search"],
          [field]: value,
        }),
      ).toBe(false);
    },
  );

  it("keeps human and agent room memberships distinct", () => {
    const humanMembership = {
      kind: "human",
      actorId: "human-2",
      role: "member",
      joinedAt: "2026-08-09T00:00:00.000Z",
    };
    const agentMembership = {
      kind: "agent",
      actorId: "agent-search",
      participation: "active",
      toolPermissions: ["search"],
      configuredAt: "2026-08-09T00:00:00.000Z",
    };

    expect(domain.isHumanRoomMembership).toBeTypeOf("function");
    expect(domain.isAgentRoomMembership).toBeTypeOf("function");
    expect(domain.isHumanRoomMembership?.(humanMembership)).toBe(true);
    expect(domain.isAgentRoomMembership?.(agentMembership)).toBe(true);
    expect(domain.isHumanRoomMembership?.(agentMembership)).toBe(false);
    expect(domain.isAgentRoomMembership?.(humanMembership)).toBe(false);
    expect(
      domain.isAgentRoomMembership?.({
        ...agentMembership,
        toolPermissions: [],
      }),
    ).toBe(false);
  });

  it.each([
    ["participation", "active"],
    ["toolPermissions", ["search"]],
    ["configuredAt", "2026-08-09T00:00:00.000Z"],
  ])("rejects %s on human room memberships", (field, value) => {
    expect(
      domain.isHumanRoomMembership?.({
        kind: "human",
        actorId: "human-2",
        role: "member",
        joinedAt: "2026-08-09T00:00:00.000Z",
        [field]: value,
      }),
    ).toBe(false);
  });

  it.each([
    ["role", "member"],
    ["joinedAt", "2026-08-09T00:00:00.000Z"],
  ])("rejects %s on agent room memberships", (field, value) => {
    expect(
      domain.isAgentRoomMembership?.({
        kind: "agent",
        actorId: "agent-search",
        participation: "active",
        toolPermissions: ["search"],
        configuredAt: "2026-08-09T00:00:00.000Z",
        [field]: value,
      }),
    ).toBe(false);
  });

  it("accepts only authorless message drafts", () => {
    expect(domain.isMessageDraft).toBeTypeOf("function");
    expect(
      domain.isMessageDraft?.({
        id: "message-1",
        roomId: "room-1",
        body: "由会话决定作者",
        sentAt: "2026-08-09T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      domain.isMessageDraft?.({
        id: "message-forged",
        roomId: "room-1",
        authorId: "human-2",
        body: "冒充",
        sentAt: "2026-08-09T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      domain.isMessageDraft?.({
        id: "message-forged-kind",
        roomId: "room-1",
        authorKind: "human",
        body: "冒充",
        sentAt: "2026-08-09T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});
