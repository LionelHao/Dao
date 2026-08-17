import { describe, expect, it } from "vitest";
import {
  isInternalAgentCommandContext,
  mintInternalAgentCommandContext,
  parsePersistedIdentityEvent,
  parsePersistedRoomEvent,
  parsePersistentCommand,
  toAgentWorkerCommandContext,
} from "./contracts.js";

const acceptedCommands: readonly unknown[] = [
  {
    type: "message.send",
    roomId: "room-1",
    payload: { id: "message-1", roomId: "room-1", body: "hello", sentAt: "2026-08-10T00:00:00.000Z" },
  },
  { type: "human.read.record", roomId: "room-1", payload: { messageId: "message-1" } },
  {
    type: "agent.judgment.record",
    roomId: "room-1",
    payload: { messageId: "message-1", outcome: "suppressed", reason: "冷却期" },
  },
  {
    type: "open-item.create",
    roomId: "room-1",
    payload: { sourceMessageId: "message-1", ownerId: "human-2", content: "请确认" },
  },
  {
    type: "open-item.transition",
    roomId: "room-1",
    payload: { itemId: "item-1", action: "transfer", targetId: "human-3", reason: "转交" },
  },
  {
    type: "agent.execution.transition",
    roomId: "room-1",
    payload: {
      executionId: "execution-1",
      sourceMessageId: "message-1",
      toolName: "search.web",
      status: "completed",
      result: "done",
    },
  },
  { type: "calibration.record", roomId: "room-1", payload: { sourceMessageId: "message-agent", emoji: "👍" } },
  { type: "calibration.record", roomId: "room-1", payload: { sourceMessageId: "message-agent", feedback: "useful" } },
  { type: "room.create", payload: { name: "原生 IM" } },
  { type: "room.rename", roomId: "room-1", payload: { name: "新名字" } },
  { type: "room.archive", roomId: "room-1", payload: {} },
  { type: "human.invitation.issue", roomId: "room-1", payload: { inviteeActorId: "human-2" } },
  { type: "human.invitation.decide", payload: { token: "invite-token", decision: "accept" } },
  {
    type: "agent.configure",
    roomId: "room-1",
    payload: { agentId: "agent-1", participation: "on-mention", toolPermissions: ["search.web"] },
  },
  { type: "human.role.change", roomId: "room-1", payload: { targetActorId: "human-2", role: "admin" } },
  { type: "member.remove", roomId: "room-1", payload: { targetActorId: "human-2" } },
];

describe("server-private Agent command capability", () => {
  it("rejects JSON and structurally similar objects but emits a closed cloneable worker context after minting", () => {
    const forged = {
      kind: "agent",
      agent: { actorId: "agent-1", kind: "agent" },
      requestId: "request-1",
      idempotencyKey: "key-1",
    };
    expect(isInternalAgentCommandContext(forged)).toBe(false);
    expect(() => toAgentWorkerCommandContext(forged as never)).toThrowError(
      expect.objectContaining({ code: "agent_capability_forbidden" }),
    );

    const capability = mintInternalAgentCommandContext({
      agentId: "agent-1",
      requestId: "request-1",
      idempotencyKey: "key-1",
    });
    expect(isInternalAgentCommandContext(capability)).toBe(true);
    const wire = toAgentWorkerCommandContext(capability);
    expect(wire).toEqual(forged);
    expect(structuredClone(wire)).toEqual(wire);
    expect(isInternalAgentCommandContext(structuredClone(capability))).toBe(false);
  });
});

const roomEventBase = {
  eventId: "event-1",
  streamKind: "room",
  streamId: "room-1",
  streamSeq: 1,
  roomId: "room-1",
  actorId: "human-1",
  occurredAt: "2026-08-10T00:00:00.000Z",
} as const;

const managedRoom = {
  id: "room-1",
  name: "原生 IM",
  status: "active",
  members: [{ kind: "human", actorId: "human-1", role: "owner", joinedAt: "2026-08-10T00:00:00.000Z" }],
  createdAt: "2026-08-10T00:00:00.000Z",
} as const;

const humanMembership = {
  kind: "human",
  actorId: "human-2",
  role: "member",
  joinedAt: "2026-08-10T00:00:00.000Z",
} as const;

const acceptedRoomEvents: readonly unknown[] = [
  { ...roomEventBase, type: "room.created", payload: { room: managedRoom } },
  { ...roomEventBase, type: "room.renamed", payload: { room: { ...managedRoom, name: "新名字" } } },
  { ...roomEventBase, type: "room.archived", payload: { room: { ...managedRoom, status: "archived" } } },
  {
    ...roomEventBase,
    type: "human.invitation.issued",
    payload: { invitationId: "invitation-1", inviteeActorId: "human-2" },
  },
  {
    ...roomEventBase,
    type: "human.invitation.accepted",
    payload: { invitationId: "invitation-1", membership: humanMembership },
  },
  {
    ...roomEventBase,
    type: "human.invitation.rejected",
    payload: { invitationId: "invitation-1", targetActorId: "human-2" },
  },
  { ...roomEventBase, type: "human.role.changed", payload: { membership: { ...humanMembership, role: "admin" } } },
  { ...roomEventBase, type: "member.removed", payload: { targetActorId: "human-2" } },
  {
    ...roomEventBase,
    type: "agent.configured",
    payload: {
      membership: {
        kind: "agent",
        actorId: "agent-1",
        participation: "on-mention",
        toolPermissions: ["search.web"],
        configuredAt: "2026-08-10T00:00:00.000Z",
      },
    },
  },
  {
    ...roomEventBase,
    type: "room.message.accepted",
    payload: {
      id: "message-1",
      roomId: "room-1",
      authorId: "human-1",
      authorKind: "human",
      body: "hello",
      sentAt: "2026-08-10T00:00:00.000Z",
    },
  },
  {
    ...roomEventBase,
    type: "room.human_read.recorded",
    payload: {
      id: "read-1",
      messageId: "message-1",
      readerId: "human-1",
      readAt: "2026-08-10T00:00:00.000Z",
    },
  },
  {
    ...roomEventBase,
    actorId: "agent-1",
    type: "room.agent_judgment.recorded",
    payload: {
      id: "judgement-1",
      messageId: "message-1",
      agentId: "agent-1",
      outcome: "will_respond",
      reason: "命中领域",
      decidedAt: "2026-08-10T00:00:00.000Z",
    },
  },
  {
    ...roomEventBase,
    actorId: "agent-1",
    type: "room.route_judgment.recorded",
    payload: {
      id: "route-judgment-1",
      routeJobId: "route-job-1",
      sourceMessageId: "message-1",
      agentId: "agent-1",
      outcome: "will_respond",
      reasonCode: "direct_mention",
      reasonText: "direct mandatory address",
      routeAttempt: 1,
      decidedAt: "2026-08-10T00:00:00.000Z",
    },
  },
  {
    ...roomEventBase,
    type: "route.completed",
    payload: {
      id: "route-job-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      status: "completed",
      currentAttempt: 1,
      topicKey: "topic-1",
      embeddingModelVersion: "dao-topic-embedding-v1",
      windowSize: 8,
      cosineThreshold: 0.82,
      roomPhase: "discussion",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      completedAt: "2026-08-10T00:00:01.000Z",
    },
  },
  {
    ...roomEventBase,
    type: "room.open_item.changed",
    payload: {
      id: "item-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      ownerId: "human-2",
      content: "请确认",
      status: "pending_response",
      createdAt: "2026-08-10T00:00:00.000Z",
      transferChain: [],
    },
  },
  {
    ...roomEventBase,
    actorId: "agent-1",
    type: "room.agent_execution.changed",
    payload: {
      id: "execution-1",
      roomId: "room-1",
      sourceMessageId: "message-1",
      requesterId: "human-1",
      agentId: "agent-1",
      toolName: "search.web",
      status: "completed",
      actionCategory: "tool_call",
      toolDispatchPhase: "finished",
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      recoveryCursor: 0,
      queuedAt: "2026-08-10T00:00:00.000Z",
      startedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
      completedAt: "2026-08-10T00:01:00.000Z",
    },
  },
  {
    ...roomEventBase,
    type: "room.calibration.recorded",
    payload: {
      id: "calibration-1",
      sourceMessageId: "message-agent",
      actorId: "human-1",
      agentId: "agent-1",
      emoji: "👍",
      createdAt: "2026-08-10T00:00:00.000Z",
    },
  },
];

const acceptedIdentityEvents: readonly unknown[] = [
  {
    eventId: "identity-event-1",
    streamKind: "identity",
    streamId: "human-1",
    streamSeq: 1,
    actorId: "human-1",
    occurredAt: "2026-08-10T00:00:00.000Z",
    type: "identity.actor.registered",
    payload: {
      actor: { id: "human-1", kind: "human", displayName: "Lionel", reachability: "online" },
    },
  },
  ...(["issued", "rotated", "revoked"] as const).map((action) => ({
    eventId: `identity-event-${action}`,
    streamKind: "identity",
    streamId: "human-1",
    streamSeq: 1,
    actorId: "human-1",
    occurredAt: "2026-08-10T00:00:00.000Z",
    type: `identity.session.${action}`,
    payload: { sessionId: "session-1", familyId: "family-1", accountId: "account-1" },
  })),
  {
    eventId: "identity-event-access",
    streamKind: "identity",
    streamId: "human-1",
    streamSeq: 1,
    actorId: "human-1",
    occurredAt: "2026-08-10T00:00:00.000Z",
    type: "identity.room-access.changed",
    payload: { roomId: "room-1", change: "removed" },
  },
];

describe("closed authority contracts", () => {
  it.each(acceptedCommands)("accepts a canonical command", (command) => {
    expect(parsePersistentCommand(command)).toMatchObject({ ok: true, value: command });
  });

  it.each(acceptedRoomEvents)("accepts a canonical persisted room event", (event) => {
    expect(parsePersistedRoomEvent(event)).toMatchObject({ ok: true, value: event });
  });

  it.each(acceptedIdentityEvents)("accepts a canonical persisted identity event", (event) => {
    expect(parsePersistedIdentityEvent(event)).toMatchObject({ ok: true, value: event });
  });

  it("rejects extra fields at both envelope and payload depth for every accepted command and event", () => {
    for (const command of acceptedCommands) {
      const outer = structuredClone(command) as Record<string, unknown>;
      outer.unexpected = true;
      expect(parsePersistentCommand(outer)).toEqual({ ok: false, code: "invalid_command" });

      const nested = structuredClone(command) as { payload: Record<string, unknown> };
      nested.payload.unexpected = true;
      expect(parsePersistentCommand(nested)).toEqual({ ok: false, code: "invalid_command" });
    }

    for (const event of acceptedRoomEvents) {
      const outer = structuredClone(event) as Record<string, unknown>;
      outer.unexpected = true;
      expect(parsePersistedRoomEvent(outer)).toEqual({ ok: false, code: "invalid_event" });

      const nested = structuredClone(event) as { payload: Record<string, unknown> };
      nested.payload.unexpected = true;
      expect(parsePersistedRoomEvent(nested)).toEqual({ ok: false, code: "invalid_event" });
    }

    for (const event of acceptedIdentityEvents) {
      const outer = structuredClone(event) as Record<string, unknown>;
      outer.unexpected = true;
      expect(parsePersistedIdentityEvent(outer)).toEqual({ ok: false, code: "invalid_event" });

      const nested = structuredClone(event) as { payload: Record<string, unknown> };
      nested.payload.unexpected = true;
      expect(parsePersistedIdentityEvent(nested)).toEqual({ ok: false, code: "invalid_event" });
    }
  });

  it("rejects unknown, extra, empty, and cross-identity command fields", () => {
    expect(parsePersistentCommand(Object.create({
      type: "human.read.record",
      roomId: "room-1",
      payload: { messageId: "message-1" },
    }))).toEqual({ ok: false, code: "invalid_command" });
    expect(parsePersistentCommand({
      type: "agent.judgment.record",
      roomId: "room-1",
      payload: { messageId: "message-1", outcome: "will_respond", reason: "" },
    })).toEqual({ ok: false, code: "invalid_command" });
    expect(parsePersistentCommand({
      type: "human.read.record",
      roomId: "room-1",
      payload: { messageId: "message-1", agentId: "agent-search" },
    })).toEqual({ ok: false, code: "invalid_command" });
    expect(parsePersistentCommand({
      type: "calibration.record",
      roomId: "room-1",
      payload: { sourceMessageId: "message-agent", emoji: "🎉" },
    })).toEqual({ ok: false, code: "invalid_command" });
    expect(parsePersistentCommand({
      type: "message.send",
      roomId: "room-1",
      payload: {
        id: "message-1",
        roomId: "room-1",
        body: "hello",
        sentAt: "2026-08-10T00:00:00.000Z",
        authorId: "human-1",
      },
    })).toEqual({ ok: false, code: "invalid_command" });
  });

  it("correlates room event discriminants with their canonical payloads", () => {
    const base = {
      eventId: "event-1",
      streamKind: "room",
      streamId: "room-1",
      streamSeq: 1,
      roomId: "room-1",
      actorId: "human-1",
      occurredAt: "2026-08-10T00:00:00.000Z",
    };
    expect(parsePersistedRoomEvent({
      ...base,
      type: "room.human_read.recorded",
      payload: {
        id: "read-1",
        messageId: "message-1",
        readerId: "human-1",
        readAt: "2026-08-10T00:00:00.000Z",
      },
    })).toMatchObject({ ok: true });
    expect(parsePersistedRoomEvent({
      ...base,
      type: "room.agent_judgment.recorded",
      payload: {
        id: "read-1",
        messageId: "message-1",
        readerId: "human-1",
        readAt: "2026-08-10T00:00:00.000Z",
      },
    })).toEqual({ ok: false, code: "invalid_event" });
    expect(parsePersistedRoomEvent({
      ...base,
      type: "room.human_read.recorded",
      payload: {
        id: "read-1",
        messageId: "message-1",
        readerId: "human-other",
        readAt: "2026-08-10T00:00:00.000Z",
      },
    })).toEqual({ ok: false, code: "invalid_event" });
    expect(parsePersistedRoomEvent({
      ...base,
      type: "room.message.accepted",
      payload: {
        id: "",
        roomId: "room-1",
        authorId: "human-1",
        authorKind: "human",
        body: "hello",
        sentAt: "2026-08-10T00:00:00.000Z",
      },
    })).toEqual({ ok: false, code: "invalid_event" });
    expect(parsePersistedRoomEvent({
      ...base,
      type: "room.calibration.recorded",
      payload: {
        id: "calibration-1",
        sourceMessageId: "message-agent",
        actorId: "human-1",
        agentId: "agent-1",
        emoji: "🎉",
        createdAt: "2026-08-10T00:00:00.000Z",
      },
    })).toEqual({ ok: false, code: "invalid_event" });
  });

  it("keeps identity events out of the room stream", () => {
    expect(parsePersistedIdentityEvent({
      eventId: "event-identity-1",
      streamKind: "identity",
      streamId: "human-1",
      streamSeq: 1,
      actorId: "human-1",
      occurredAt: "2026-08-10T00:00:00.000Z",
      type: "identity.room-access.changed",
      payload: { roomId: "room-1", change: "removed" },
    })).toMatchObject({ ok: true });
    expect(parsePersistedIdentityEvent({
      eventId: "event-identity-1",
      streamKind: "identity",
      streamId: "human-1",
      streamSeq: 1,
      roomId: "room-1",
      actorId: "human-1",
      occurredAt: "2026-08-10T00:00:00.000Z",
      type: "identity.room-access.changed",
      payload: { roomId: "room-1", change: "removed" },
    })).toEqual({ ok: false, code: "invalid_event" });
    expect(parsePersistedIdentityEvent({
      eventId: "event-identity-1",
      streamKind: "identity",
      streamId: "human-other",
      streamSeq: 1,
      actorId: "human-1",
      occurredAt: "2026-08-10T00:00:00.000Z",
      type: "identity.room-access.changed",
      payload: { roomId: "room-1", change: "removed" },
    })).toEqual({ ok: false, code: "invalid_event" });
    expect(parsePersistedIdentityEvent({
      eventId: "event-identity-1",
      streamKind: "identity",
      streamId: "human-1",
      streamSeq: 1,
      actorId: "human-1",
      occurredAt: "2026-08-10T00:00:00.000Z",
      type: "identity.actor.registered",
      payload: {
        actor: { id: "human-other", kind: "human", displayName: "Other", reachability: "online" },
      },
    })).toEqual({ ok: false, code: "invalid_event" });
  });
});
