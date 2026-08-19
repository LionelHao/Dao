import type {
  ActiveHumanMessage,
  AgentFinalMessage,
  MessageAuthorityEvent,
  MessageTombstone,
} from "@native-im/core";
import { describe, expect, it } from "vitest";

import {
  OperationalMessageProjectionError,
  projectOperationalMessageAuthorityEvent,
  projectOperationalMessageRepairRecord,
  projectOperationalTimelineMessage,
  type OperationalActiveHumanSource,
  type OperationalAgentMessageSource,
  type OperationalRecalledHumanSource,
} from "./operational-projection.js";

const createdAt = "2026-08-19T08:00:00.000Z";
const revisedAt = "2026-08-19T08:05:00.000Z";
const recalledAt = "2026-08-19T08:10:00.000Z";

function humanSource(): OperationalActiveHumanSource {
  return {
    kind: "active-human",
    envelope: {
      messageId: "message-human-1",
      roomId: "room-1",
      authorId: "human-author",
      authorKind: "human",
      messageKind: "human",
      lifecycle: "active",
      currentRevision: 2,
      revisionCount: 2,
      createdAt,
      recalledAt: null,
    },
    currentRevision: {
      messageId: "message-human-1",
      revision: 2,
      body: "@Sam ask @Sam",
      revisedAt,
      revisedByActorId: "human-author",
    },
    mentionedTargets: [
      {
        id: "target-agent",
        kind: "agent-invocation",
        targetActorId: "actor-agent-sam",
        range: { startUtf16: 9, endUtf16: 13 },
        targetOrder: 1,
      },
      {
        id: "target-human",
        kind: "human-request",
        targetActorId: "actor-human-sam",
        range: { startUtf16: 0, endUtf16: 4 },
        targetOrder: 0,
      },
    ],
    targetOutcomes: [
      {
        targetId: "target-agent",
        targetActorId: "actor-agent-sam",
        kind: "agent-invocation",
        status: "rejected",
        code: "target_assignment_inactive",
      },
      {
        targetId: "target-human",
        targetActorId: "actor-human-sam",
        kind: "human-request",
        status: "request-created",
        requestIntentId: "request-intent-1",
      },
    ],
    reply: { replyToMessageId: "message-parent" },
    attachments: [
      { attachmentId: "attachment-b" },
      { attachmentId: "attachment-a" },
    ],
  };
}

function recalledSource(): OperationalRecalledHumanSource {
  return {
    kind: "recalled-human",
    envelope: {
      messageId: "message-human-1",
      roomId: "room-1",
      authorId: "human-author",
      authorKind: "human",
      messageKind: "human",
      lifecycle: "recalled",
      currentRevision: 2,
      revisionCount: 2,
      createdAt,
      recalledAt,
    },
  };
}

function agentSource(
  correction = false,
): OperationalAgentMessageSource {
  const messageId = correction ? "message-agent-correction" : "message-agent-final";
  return {
    kind: "agent-message",
    envelope: {
      messageId,
      roomId: "room-1",
      authorId: "agent-1",
      authorKind: "agent",
      messageKind: correction ? "agent-correction" : "agent-final",
      lifecycle: "active",
      currentRevision: 1,
      revisionCount: 1,
      createdAt,
      recalledAt: null,
    },
    finalRevision: {
      messageId,
      revision: 1,
      body: correction ? "Corrected final" : "Immutable final",
      revisedAt: createdAt,
      revisedByActorId: "agent-1",
    },
    sourceLineage: {
      messageId,
      roomId: "room-1",
      invocationIntentId: "invocation-intent-1",
      executionId: correction ? "execution-2" : "execution-1",
      sourceMessageId: "message-human-1",
      sourceRevision: 2,
      attemptSeq: correction ? 2 : 1,
      executionGeneration: 1,
    },
    correction: correction
      ? {
          correctionMessageId: messageId,
          correctsMessageId: "message-agent-final",
          roomId: "room-1",
          agentActorId: "agent-1",
        }
      : null,
  };
}

function eventRow(
  type: MessageAuthorityEvent["type"],
  overrides: Partial<{
    eventId: string;
    streamSeq: number;
    actorId: string;
    occurredAt: string;
  }> = {},
) {
  return {
    eventId: "event-1",
    streamKind: "room" as const,
    streamId: "room-1",
    streamSeq: 1,
    roomId: "room-1",
    type,
    actorId: "human-author",
    occurredAt: revisedAt,
    ...overrides,
  };
}

describe("canonical operational message projection", () => {
  it("projects the current Human revision with frozen structured links and actorId targets", () => {
    const projection = projectOperationalTimelineMessage(humanSource()) as ActiveHumanMessage;

    expect(projection).toEqual({
      id: "message-human-1",
      roomId: "room-1",
      authorId: "human-author",
      authorKind: "human",
      createdAt,
      lifecycle: "active",
      currentRevision: {
        messageId: "message-human-1",
        revision: 2,
        body: "@Sam ask @Sam",
        revisedAt,
        revisedByActorId: "human-author",
      },
      revisionCount: 2,
      mentionedTargets: [
        {
          id: "target-human",
          kind: "human-request",
          targetActorId: "actor-human-sam",
          range: { startUtf16: 0, endUtf16: 4 },
        },
        {
          id: "target-agent",
          kind: "agent-invocation",
          targetActorId: "actor-agent-sam",
          range: { startUtf16: 9, endUtf16: 13 },
        },
      ],
      replyToMessageId: "message-parent",
      attachments: [
        { attachmentId: "attachment-a" },
        { attachmentId: "attachment-b" },
      ],
      targetOutcomes: [
        {
          targetId: "target-human",
          targetActorId: "actor-human-sam",
          kind: "human-request",
          status: "request-created",
          requestIntentId: "request-intent-1",
        },
        {
          targetId: "target-agent",
          targetActorId: "actor-agent-sam",
          kind: "agent-invocation",
          status: "rejected",
          code: "target_assignment_inactive",
        },
      ],
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.mentionedTargets)).toBe(true);
    expect(projection.mentionedTargets.map(({ targetActorId }) => targetActorId)).toEqual([
      "actor-human-sam",
      "actor-agent-sam",
    ]);
  });

  it("projects recalled Human messages as body-free tombstones and rejects hidden raw rows", () => {
    const tombstone = projectOperationalTimelineMessage(recalledSource()) as MessageTombstone;

    expect(tombstone).toEqual({
      id: "message-human-1",
      roomId: "room-1",
      authorId: "human-author",
      authorKind: "human",
      createdAt,
      lifecycle: "recalled",
      recalledAt,
      revisionCount: 2,
    });
    expect(JSON.stringify(tombstone)).not.toContain("body");
    expect(JSON.stringify(tombstone)).not.toContain("mentionedTargets");
    expect(JSON.stringify(tombstone)).not.toContain("attachments");

    expect(() => projectOperationalTimelineMessage({
      ...recalledSource(),
      rawRevisions: [{ body: "RECALLED-RAW-SENTINEL" }],
    } as unknown as OperationalRecalledHumanSource)).toThrow(
      new OperationalMessageProjectionError("invalid_source"),
    );
  });

  it("projects immutable Agent final and correction lineage without mutating the original final", () => {
    const final = projectOperationalTimelineMessage(agentSource()) as AgentFinalMessage;
    const correction = projectOperationalTimelineMessage(agentSource(true)) as AgentFinalMessage;

    expect(final).toEqual({
      id: "message-agent-final",
      roomId: "room-1",
      authorId: "agent-1",
      authorKind: "agent",
      createdAt,
      lifecycle: "active",
      finalBody: "Immutable final",
      sourceInvocationIntentId: "invocation-intent-1",
      sourceExecutionId: "execution-1",
    });
    expect(correction).toEqual({
      id: "message-agent-correction",
      roomId: "room-1",
      authorId: "agent-1",
      authorKind: "agent",
      createdAt,
      lifecycle: "active",
      finalBody: "Corrected final",
      sourceInvocationIntentId: "invocation-intent-1",
      sourceExecutionId: "execution-2",
      correctsMessageId: "message-agent-final",
    });
    expect(final.finalBody).toBe("Immutable final");

    const broken = agentSource(true);
    expect(() => projectOperationalTimelineMessage({
      ...broken,
      correction: null,
    })).toThrow(new OperationalMessageProjectionError("invalid_source"));
  });

  it("uses the same canonical payload for history, stable event, and repair", () => {
    const source = humanSource();
    const timeline = projectOperationalTimelineMessage(source);
    const event = projectOperationalMessageAuthorityEvent(
      eventRow("room.message.revised"),
      source,
    );
    const repair = projectOperationalMessageRepairRecord(source);

    expect(event.payload).toEqual(timeline);
    expect(repair).toEqual({ kind: "timeline-message", value: timeline });
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(Object.isFrozen(repair.value)).toBe(true);
  });

  it("fails closed when event type, authority actor, room, or source rows disagree", () => {
    expect(() => projectOperationalMessageAuthorityEvent(
      eventRow("room.message.recalled"),
      humanSource(),
    )).toThrow(new OperationalMessageProjectionError("invalid_event"));
    expect(() => projectOperationalMessageAuthorityEvent(
      eventRow("room.message.revised", { actorId: "someone-else" }),
      humanSource(),
    )).toThrow(new OperationalMessageProjectionError("invalid_event"));

    const source = humanSource();
    expect(() => projectOperationalTimelineMessage({
      ...source,
      currentRevision: { ...source.currentRevision, messageId: "other-message" },
    })).toThrow(new OperationalMessageProjectionError("invalid_projection"));
  });
});
