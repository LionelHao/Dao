import { describe, expect, it } from "vitest";
import * as core from "./index.js";
import * as messageAuthority from "./message-authority.js";

const submittedAt = "2026-08-19T01:02:03.004Z";
const revisedAt = "2026-08-19T01:03:04.005Z";

const humanTarget = {
  id: "target-human",
  kind: "human-request" as const,
  targetActorId: "human-2",
  range: { startUtf16: 4, endUtf16: 6 },
};

const agentTarget = {
  id: "target-agent",
  kind: "agent-invocation" as const,
  targetActorId: "agent-1",
  range: { startUtf16: 12, endUtf16: 14 },
};

const submit = {
  messageId: "message-1",
  roomId: "room-1",
  body: "Say @A then @B",
  mentionedTargets: [humanTarget, agentTarget],
  replyToMessageId: "message-parent",
  attachments: [],
};

const humanOutcome = {
  targetId: humanTarget.id,
  targetActorId: humanTarget.targetActorId,
  kind: humanTarget.kind,
  status: "request-created" as const,
  requestIntentId: "request-intent-1",
};

const agentOutcome = {
  targetId: agentTarget.id,
  targetActorId: agentTarget.targetActorId,
  kind: agentTarget.kind,
  status: "invocation-intent-created" as const,
  invocationIntentId: "invocation-intent-1",
};

const revision = {
  messageId: submit.messageId,
  revision: 1,
  body: submit.body,
  revisedAt,
  revisedByActorId: "human-1",
};

const activeHuman = {
  id: submit.messageId,
  roomId: submit.roomId,
  authorId: "human-1",
  authorKind: "human" as const,
  createdAt: submittedAt,
  lifecycle: "active" as const,
  currentRevision: revision,
  revisionCount: 1,
  mentionedTargets: submit.mentionedTargets,
  replyToMessageId: submit.replyToMessageId,
  attachments: submit.attachments,
  targetOutcomes: [humanOutcome, agentOutcome],
};

const agentFinal = {
  id: "message-agent-final",
  roomId: submit.roomId,
  authorId: "agent-1",
  authorKind: "agent" as const,
  createdAt: revisedAt,
  lifecycle: "active" as const,
  finalBody: "Checked and complete.",
  sourceInvocationIntentId: agentOutcome.invocationIntentId,
  sourceExecutionId: "execution-1",
};

const tombstone = {
  id: submit.messageId,
  roomId: submit.roomId,
  authorId: "human-1",
  authorKind: "human" as const,
  createdAt: submittedAt,
  lifecycle: "recalled" as const,
  recalledAt: revisedAt,
  revisionCount: 1,
};

describe("Message Authority vNext closed guards", () => {
  it("exports the authority contracts from the Core package root", () => {
    expect(core.isHumanMessageSubmit).toBe(messageAuthority.isHumanMessageSubmit);
    expect(core.isTimelineMessage).toBe(messageAuthority.isTimelineMessage);
    expect(core.isMessageAuthorityEvent).toBe(messageAuthority.isMessageAuthorityEvent);
    expect(core.isMessageAuthorityRepairRecord)
      .toBe(messageAuthority.isMessageAuthorityRepairRecord);
  });

  it("accepts exact UTF-16 ranges, targets and attachment references", () => {
    expect(messageAuthority.isUtf16Range({ startUtf16: 3, endUtf16: 5 }, "😀 @A"))
      .toBe(true);
    expect(messageAuthority.isMentionTarget({
      ...humanTarget,
      range: { startUtf16: 3, endUtf16: 5 },
    }, "😀 @A")).toBe(true);
    expect(messageAuthority.isAttachmentReference({ attachmentId: "attachment-1" }))
      .toBe(true);

    expect(messageAuthority.isUtf16Range({ startUtf16: 1, endUtf16: 2 }, "😀 @A"))
      .toBe(false);
    expect(messageAuthority.isUtf16Range({ startUtf16: 3, endUtf16: 6 }, "😀 @A"))
      .toBe(false);
    expect(messageAuthority.isUtf16Range({ startUtf16: 3, endUtf16: 3 }, "😀 @A"))
      .toBe(false);
    expect(messageAuthority.isMentionTarget({ ...humanTarget, displayName: "duplicate" }))
      .toBe(false);
    expect(messageAuthority.isAttachmentReference({
      attachmentId: "attachment-1",
      filename: "secret.txt",
    })).toBe(false);
  });

  it("accepts an authorless submit and rejects injection, malformed IDs and extra keys", () => {
    expect(messageAuthority.isHumanMessageSubmit(submit)).toBe(true);
    expect(messageAuthority.isHumanMessageSubmit(submit, {
      expectedRoomId: submit.roomId,
      replyTargetRoomId: submit.roomId,
    })).toBe(true);
    expect(messageAuthority.isHumanMessageSubmit(submit, {
      expectedRoomId: submit.roomId,
      replyTargetRoomId: "room-2",
    })).toBe(false);

    for (const [key, value] of [
      ["authorId", "agent-1"],
      ["authorKind", "agent"],
      ["actorId", "agent-1"],
      ["principal", "human-1"],
      ["session", "session-1"],
      ["capability", "forged"],
      ["runtimeKind", "direct_mention"],
    ] as const) {
      expect(messageAuthority.isHumanMessageSubmit({ ...submit, [key]: value })).toBe(false);
    }

    expect(messageAuthority.isHumanMessageSubmit({ ...submit, messageId: " " })).toBe(false);
    expect(messageAuthority.isHumanMessageSubmit({ ...submit, roomId: "" })).toBe(false);
    expect(messageAuthority.isHumanMessageSubmit({ ...submit, body: "  ", mentionedTargets: [] }))
      .toBe(false);
    expect(messageAuthority.isHumanMessageSubmit({ ...submit, replyToMessageId: "" }))
      .toBe(false);
  });

  it("rejects out-of-bounds, split-surrogate, overlapping, unsorted and duplicate targets", () => {
    expect(messageAuthority.isHumanMessageSubmit({
      ...submit,
      mentionedTargets: [{ ...agentTarget, range: { startUtf16: 13, endUtf16: 15 } }],
    })).toBe(false);
    expect(messageAuthority.isHumanMessageSubmit({
      ...submit,
      mentionedTargets: [agentTarget, humanTarget],
    })).toBe(false);
    expect(messageAuthority.isHumanMessageSubmit({
      ...submit,
      mentionedTargets: [humanTarget, { ...agentTarget, range: { startUtf16: 5, endUtf16: 9 } }],
    })).toBe(false);
    expect(messageAuthority.isHumanMessageSubmit({
      ...submit,
      mentionedTargets: [humanTarget, { ...agentTarget, id: humanTarget.id }],
    })).toBe(false);
    expect(messageAuthority.isHumanMessageSubmit({
      ...submit,
      mentionedTargets: [humanTarget, {
        ...agentTarget,
        kind: humanTarget.kind,
        targetActorId: humanTarget.targetActorId,
      }],
    })).toBe(false);
    expect(messageAuthority.isHumanMessageSubmit({
      ...submit,
      body: "😀 @A",
      mentionedTargets: [{ ...humanTarget, range: { startUtf16: 1, endUtf16: 2 } }],
    })).toBe(false);
  });

  it("rejects duplicate attachment IDs without widening the FT-04 seam", () => {
    expect(messageAuthority.isHumanMessageSubmit({
      ...submit,
      attachments: [{ attachmentId: "attachment-1" }],
    })).toBe(true);
    expect(messageAuthority.isHumanMessageSubmit({
      ...submit,
      attachments: [
        { attachmentId: "attachment-1" },
        { attachmentId: "attachment-1" },
      ],
    })).toBe(false);
    expect(messageAuthority.isHumanMessageSubmit({
      ...submit,
      attachments: [{ attachmentId: "attachment-1", url: "file:///private/raw" }],
    })).toBe(false);
  });

  it("keeps target outcome discriminants closed and identifiers non-empty", () => {
    expect(messageAuthority.isMessageTargetOutcome(humanOutcome)).toBe(true);
    expect(messageAuthority.isMessageTargetOutcome(agentOutcome)).toBe(true);
    expect(messageAuthority.isMessageTargetOutcome({
      targetId: "target-agent-missing",
      targetActorId: "agent-missing",
      kind: "agent-invocation",
      status: "rejected",
      code: "target_assignment_inactive",
    })).toBe(true);

    expect(messageAuthority.isMessageTargetOutcome({
      ...humanOutcome,
      invocationIntentId: "injected",
    })).toBe(false);
    expect(messageAuthority.isMessageTargetOutcome({
      ...agentOutcome,
      executionId: "not-an-outcome",
    })).toBe(false);
    expect(messageAuthority.isMessageTargetOutcome({
      targetId: "target-1",
      targetActorId: "agent-1",
      kind: "agent-invocation",
      status: "rejected",
      code: "arbitrary_error",
    })).toBe(false);
  });

  it("accepts only canonical UTC revisions and matching active Human projections", () => {
    expect(messageAuthority.isMessageRevision(revision)).toBe(true);
    expect(messageAuthority.isActiveHumanMessage(activeHuman)).toBe(true);

    expect(messageAuthority.isMessageRevision({ ...revision, revisedAt: "2026-08-19" }))
      .toBe(false);
    expect(messageAuthority.isMessageRevision({ ...revision, revisedAt: "2026-08-19T01:03:04+00:00" }))
      .toBe(false);
    expect(messageAuthority.isMessageRevision({ ...revision, revision: 0 })).toBe(false);
    expect(messageAuthority.isActiveHumanMessage({
      ...activeHuman,
      currentRevision: { ...revision, messageId: "message-other" },
    })).toBe(false);
    expect(messageAuthority.isActiveHumanMessage({
      ...activeHuman,
      currentRevision: { ...revision, revisedByActorId: "human-other" },
    })).toBe(false);
    expect(messageAuthority.isActiveHumanMessage({ ...activeHuman, revisionCount: 2 }))
      .toBe(false);
    expect(messageAuthority.isActiveHumanMessage({
      ...activeHuman,
      targetOutcomes: [humanOutcome],
    })).toBe(false);
    expect(messageAuthority.isActiveHumanMessage({
      ...activeHuman,
      createdAt: "not-a-date",
    })).toBe(false);
  });

  it("keeps Human, Agent final/correction and tombstone projections disjoint", () => {
    expect(messageAuthority.isTimelineMessage(activeHuman)).toBe(true);
    expect(messageAuthority.isAgentFinalMessage(agentFinal)).toBe(true);
    expect(messageAuthority.isTimelineMessage(agentFinal)).toBe(true);
    expect(messageAuthority.isMessageTombstone(tombstone)).toBe(true);
    expect(messageAuthority.isTimelineMessage(tombstone)).toBe(true);
    expect(messageAuthority.isAgentFinalMessage({
      ...agentFinal,
      id: "message-agent-correction",
      correctsMessageId: agentFinal.id,
    })).toBe(true);
    expect(messageAuthority.isAgentFinalMessage(agentFinal, {
      expectedRoomId: submit.roomId,
      sourceInvocationRoomId: submit.roomId,
      sourceExecutionRoomId: submit.roomId,
    })).toBe(true);
    expect(messageAuthority.isAgentFinalMessage(agentFinal, {
      sourceInvocationRoomId: "room-2",
    })).toBe(false);
    expect(messageAuthority.isAgentFinalMessage({
      ...agentFinal,
      id: "message-agent-correction",
      correctsMessageId: agentFinal.id,
    }, {
      correctionTargetRoomId: "room-2",
      correctionTargetAuthorId: agentFinal.authorId,
    })).toBe(false);

    for (const forbidden of [
      { body: submit.body },
      { mentionedTargets: submit.mentionedTargets },
      { attachments: [] },
      { replyToMessageId: "message-parent" },
    ]) {
      expect(messageAuthority.isMessageTombstone({ ...tombstone, ...forbidden })).toBe(false);
      expect(messageAuthority.isAgentFinalMessage({ ...agentFinal, ...forbidden })).toBe(false);
    }
    expect(messageAuthority.isAgentFinalMessage({
      ...agentFinal,
      correctsMessageId: agentFinal.id,
    })).toBe(false);
    expect(messageAuthority.isMessageTombstone({
      ...tombstone,
      recalledAt: "2026-08-18T23:59:59.999Z",
    })).toBe(false);
  });

  it("guards stable message events with exact keys and same-Room authority", () => {
    const acceptedEvent = {
      eventId: "event-1",
      streamKind: "room" as const,
      streamId: submit.roomId,
      streamSeq: 1,
      roomId: submit.roomId,
      type: "room.message.accepted" as const,
      actorId: activeHuman.authorId,
      occurredAt: revisedAt,
      payload: activeHuman,
    };
    expect(messageAuthority.isMessageAuthorityEvent(acceptedEvent)).toBe(true);
    expect(messageAuthority.isMessageAuthorityEvent({
      ...acceptedEvent,
      type: "room.message.revised",
    })).toBe(true);
    expect(messageAuthority.isMessageAuthorityEvent({
      ...acceptedEvent,
      type: "room.message.recalled",
      payload: tombstone,
    })).toBe(true);
    expect(messageAuthority.isMessageAuthorityEvent({
      ...acceptedEvent,
      payload: agentFinal,
      actorId: agentFinal.authorId,
    })).toBe(true);

    expect(messageAuthority.isMessageAuthorityEvent({
      ...acceptedEvent,
      roomId: "room-2",
    })).toBe(false);
    expect(messageAuthority.isMessageAuthorityEvent({
      ...acceptedEvent,
      actorId: "human-forged",
    })).toBe(false);
    expect(messageAuthority.isMessageAuthorityEvent({
      ...acceptedEvent,
      type: "room.message.recalled",
    })).toBe(false);
    expect(messageAuthority.isMessageAuthorityEvent({ ...acceptedEvent, sql: "SELECT raw" }))
      .toBe(false);
  });

  it("guards operational repair records without allowing recalled raw content", () => {
    expect(messageAuthority.isMessageAuthorityRepairRecord({
      kind: "timeline-message",
      value: activeHuman,
    }, submit.roomId)).toBe(true);
    expect(messageAuthority.isMessageAuthorityRepairRecord({
      kind: "timeline-message",
      value: tombstone,
    }, submit.roomId)).toBe(true);
    expect(messageAuthority.isMessageAuthorityRepairRecord({
      kind: "message-revision",
      roomId: submit.roomId,
      value: revision,
    }, submit.roomId)).toBe(true);

    expect(messageAuthority.isMessageAuthorityRepairRecord({
      kind: "timeline-message",
      value: activeHuman,
    }, "room-2")).toBe(false);
    expect(messageAuthority.isMessageAuthorityRepairRecord({
      kind: "message-revision",
      roomId: "room-2",
      value: revision,
    }, submit.roomId)).toBe(false);
    expect(messageAuthority.isMessageAuthorityRepairRecord({
      kind: "timeline-message",
      value: { ...tombstone, body: "recalled raw sentinel" },
    }, submit.roomId)).toBe(false);
  });
});
