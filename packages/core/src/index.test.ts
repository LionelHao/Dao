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
};

const domain = importedDomain as unknown as DomainUnderTest;

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
      domain.isHumanInvitationRequest?.({
        ...humanJoin,
        agentId: "agent-search",
        participation: "active",
        toolPermissions: ["search"],
      }),
    ).toBe(false);
    expect(
      domain.isAgentConfigurationRequest?.({
        ...agentJoin,
        inviteeActorId: "human-2",
      }),
    ).toBe(false);
  });

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
      domain.isHumanRoomMembership?.({
        ...humanMembership,
        participation: "active",
        toolPermissions: ["search"],
      }),
    ).toBe(false);
    expect(
      domain.isAgentRoomMembership?.({
        ...agentMembership,
        role: "member",
        joinedAt: "2026-08-09T00:00:00.000Z",
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
