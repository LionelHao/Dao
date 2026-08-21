import { describe, expect, it } from "vitest";
import {
  applyMessageAuthorityInput,
  beginMessageMutation,
  beginMessageSubmission,
  buildMentionPickerOptions,
  commitRepairGeneration,
  createMessageAuthorityState,
  failRepairGeneration,
  messageControls,
  retryMessageSubmission,
  type ActiveHumanTimelineMessage,
  type MessageAuthorityState,
  type MessageDraft,
  type MessageTargetOutcome,
  type TimelineMessage,
} from "./view-model.js";

const draft: MessageDraft = {
  messageId: "message-local-1",
  roomId: "room-1",
  body: "请周予和检索员及周予核对字段",
  mentionedTargets: [
    {
      id: "target-human",
      kind: "human-request",
      targetActorId: "human-zhou-a",
      range: { startUtf16: 1, endUtf16: 3 },
    },
    {
      id: "target-agent",
      kind: "agent-invocation",
      targetActorId: "agent-search",
      range: { startUtf16: 4, endUtf16: 7 },
    },
    {
      id: "target-removed",
      kind: "human-request",
      targetActorId: "human-removed",
      range: { startUtf16: 8, endUtf16: 10 },
    },
  ],
  replyToMessageId: "message-source",
  attachments: [],
};

const outcomes: readonly MessageTargetOutcome[] = [
  {
    targetId: "target-human",
    targetActorId: "human-zhou-a",
    kind: "human-request",
    status: "request-created",
    requestIntentId: "request-intent-1",
  },
  {
    targetId: "target-agent",
    targetActorId: "agent-search",
    kind: "agent-invocation",
    status: "invocation-intent-created",
    invocationIntentId: "invocation-intent-1",
  },
  {
    targetId: "target-removed",
    targetActorId: "human-removed",
    kind: "human-request",
    status: "rejected",
    code: "target_not_member",
  },
];

function humanMessage(
  overrides: Partial<ActiveHumanTimelineMessage> = {},
): ActiveHumanTimelineMessage {
  return {
    kind: "human",
    messageId: "message-source",
    roomId: "room-1",
    authorId: "human-viewer",
    createdAt: "2026-08-19T09:00:00.000Z",
    body: "权威消息正文",
    revision: 1,
    revisionCount: 1,
    mentionedTargets: [],
    attachments: [],
    targetOutcomes: [],
    ...overrides,
  };
}

function initial(timeline: readonly TimelineMessage[] = [humanMessage()]): MessageAuthorityState {
  return createMessageAuthorityState({
    roomId: "room-1",
    viewerActorId: "human-viewer",
    lifecycle: "active",
    connection: { status: "online" },
    actors: [
      { actorId: "human-zhou-a", kind: "human", displayName: "周予", secondaryLabel: "产品" },
      { actorId: "human-zhou-b", kind: "human", displayName: "周予", secondaryLabel: "法务" },
      { actorId: "agent-search", kind: "agent", displayName: "检索员", secondaryLabel: "资料检索" },
    ],
    draft,
    timeline,
    executions: [],
    previews: [],
    appliedEventIds: [],
    projectionGeneration: 7,
  });
}

describe("REQ-MSG-003 structured mention picker", () => {
  it("distinguishes duplicate display names with stable actorId and never parses body text", () => {
    const state = initial();
    const options = buildMentionPickerOptions(state, "周予");
    expect(options.map((option) => option.actorId)).toEqual(["human-zhou-a", "human-zhou-b"]);
    expect(options[0]?.accessibleLabel).toContain("产品");
    expect(options[1]?.accessibleLabel).toContain("法务");
    expect(options[0]?.accessibleLabel).toContain("human-zhou-a");

    const plainAtText = createMessageAuthorityState({
      ...state,
      draft: { ...draft, body: "邮箱 a@human-zhou-b.test，代码 @检索员", mentionedTargets: [] },
    });
    expect(plainAtText.draft.mentionedTargets).toEqual([]);
  });
});

describe("REQ-MSG-001 / REQ-UX-007 submission convergence", () => {
  it("accepts only the matching ACK and never calls an invocation intent completed", () => {
    const submitting = beginMessageSubmission(initial(), "request-1");
    const wrong = applyMessageAuthorityInput(submitting, {
      type: "message.accepted",
      requestId: "request-other",
      messageId: draft.messageId,
      persistedAt: "2026-08-19T09:02:00.000Z",
      targetOutcomes: outcomes,
    });
    expect(wrong).toBe(submitting);

    const accepted = applyMessageAuthorityInput(submitting, {
      type: "message.accepted",
      requestId: "request-1",
      messageId: draft.messageId,
      persistedAt: "2026-08-19T09:02:00.000Z",
      targetOutcomes: outcomes,
    });
    expect(accepted.submission.status).toBe("accepted");
    expect(accepted.announcement).toContain("消息已保存");
    expect(accepted.announcement).toContain("Agent调用意图已登记");
    expect(accepted.announcement).not.toContain("Agent已完成");
    expect(accepted.timeline).toHaveLength(1);
  });

  it("converges event-before-ACK, ACK-before-event, ACK loss, and duplicate event to one timeline item", () => {
    const submitting = beginMessageSubmission(initial(), "request-1");
    const acceptedMessage = humanMessage({
      messageId: draft.messageId,
      body: draft.body,
      mentionedTargets: draft.mentionedTargets,
      targetOutcomes: outcomes,
      replyToMessageId: draft.replyToMessageId,
    });
    const viaEvent = applyMessageAuthorityInput(submitting, {
      type: "room.message.accepted",
      eventId: "event-message-1",
      message: acceptedMessage,
    });
    expect(viaEvent.submission.status).toBe("accepted-via-event");
    expect(viaEvent.timeline.filter((entry) => entry.messageId === draft.messageId)).toHaveLength(1);

    const duplicate = applyMessageAuthorityInput(viaEvent, {
      type: "room.message.accepted",
      eventId: "event-message-1",
      message: acceptedMessage,
    });
    expect(duplicate).toBe(viaEvent);

    const lateAck = applyMessageAuthorityInput(duplicate, {
      type: "message.accepted",
      requestId: "request-1",
      messageId: draft.messageId,
      persistedAt: "2026-08-19T09:02:00.000Z",
      targetOutcomes: outcomes,
    });
    expect(lateAck.timeline.filter((entry) => entry.messageId === draft.messageId)).toHaveLength(1);
  });

  it("preserves the exact canonical payload and messageId across retryable failure", () => {
    const submitting = beginMessageSubmission(initial(), "request-1");
    const failed = applyMessageAuthorityInput(submitting, {
      type: "message.error",
      requestId: "request-1",
      status: 503,
      code: "service_unavailable",
    });
    expect(failed.submission.status).toBe("retryable-failure");
    const retried = retryMessageSubmission(failed, "request-2");
    expect(retried.submission.status).toBe("submitting");
    if (retried.submission.status !== "submitting") throw new Error("expected submitting");
    expect(retried.submission.payload).toEqual(draft);
    expect(retried.submission.payload).not.toBe(draft);
    expect(retried.submission.payload.mentionedTargets).toEqual(draft.mentionedTargets);
  });

  it.each([
    [400, "invalid_message"],
    [401, "unauthenticated"],
    [403, "room_forbidden"],
    [404, "reply_target_not_found"],
    [409, "message_version_conflict"],
    [410, "protocol_upgrade_required"],
  ] as const)("keeps the draft for nonretryable %i/%s", (status, code) => {
    const failed = applyMessageAuthorityInput(beginMessageSubmission(initial(), "request-1"), {
      type: "message.error",
      requestId: "request-1",
      status,
      code,
    });
    expect(failed.submission.status).toBe("nonretryable-failure");
    expect(failed.draft).toEqual(draft);
  });

  it("treats 429 as retryable without generating a second messageId", () => {
    const failed = applyMessageAuthorityInput(beginMessageSubmission(initial(), "request-1"), {
      type: "message.error",
      requestId: "request-1",
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 12,
    });
    expect(failed.submission.status).toBe("retryable-failure");
    expect(failed.draft.messageId).toBe(draft.messageId);
  });
});

describe("REQ-MSG-004/005/006/007/008 timeline authority", () => {
  it("applies a higher revision without changing frozen reply, targets, attachments, or outcomes", () => {
    const original = humanMessage({
      mentionedTargets: draft.mentionedTargets,
      replyToMessageId: "message-reply",
      attachments: [{ attachmentId: "attachment-1" }],
      targetOutcomes: outcomes,
    });
    const revised = applyMessageAuthorityInput(initial([original]), {
      type: "room.message.revised",
      eventId: "event-revised-2",
      messageId: original.messageId,
      revision: 2,
      body: "修订后的正文",
      revisedAt: "2026-08-19T09:03:00.000Z",
    });
    const message = revised.timeline[0];
    expect(message?.kind).toBe("human");
    if (message?.kind !== "human") throw new Error("expected human");
    expect(message.body).toBe("修订后的正文");
    expect(message.revisionCount).toBe(2);
    expect(message.mentionedTargets).toEqual(original.mentionedTargets);
    expect(message.replyToMessageId).toBe(original.replyToMessageId);
    expect(message.attachments).toEqual(original.attachments);
    expect(message.targetOutcomes).toEqual(original.targetOutcomes);
  });

  it("replaces a recalled message with a body-free tombstone and keeps replies safe", () => {
    const state = initial([
      humanMessage(),
      humanMessage({ messageId: "message-replying", replyToMessageId: "message-source" }),
    ]);
    const recalled = applyMessageAuthorityInput(state, {
      type: "room.message.recalled",
      eventId: "event-recalled-1",
      tombstone: {
        kind: "tombstone",
        messageId: "message-source",
        roomId: "room-1",
        authorId: "human-viewer",
        createdAt: "2026-08-19T09:00:00.000Z",
        recalledAt: "2026-08-19T09:04:00.000Z",
        revisionCount: 1,
      },
    });
    expect(recalled.timeline[0]).toEqual(expect.objectContaining({ kind: "tombstone" }));
    expect(recalled.timeline[0]).not.toHaveProperty("body");
    expect(recalled.timeline[1]?.replyToMessageId).toBe("message-source");
  });

  it("adds immutable Agent final/correction only from stable projection events and keeps preview transient", () => {
    const withPreview = applyMessageAuthorityInput(initial(), {
      type: "agent.preview",
      executionId: "execution-1",
      attemptSeq: 1,
      agentId: "agent-search",
      delta: "PREVIEW-SENTINEL",
      authoritative: false,
    });
    expect(withPreview.timeline.map((entry) => JSON.stringify(entry)).join(" ")).not.toContain("PREVIEW-SENTINEL");
    expect(withPreview.previews[0]?.delta).toBe("PREVIEW-SENTINEL");

    const final = applyMessageAuthorityInput(withPreview, {
      type: "room.message.accepted",
      eventId: "event-final-1",
      message: {
        kind: "agent-final",
        messageId: "message-agent-final",
        roomId: "room-1",
        authorId: "agent-search",
        createdAt: "2026-08-19T09:05:00.000Z",
        finalBody: "最终结论",
        sourceInvocationIntentId: "invocation-intent-1",
        sourceExecutionId: "execution-1",
        citations: [],
      },
    });
    const corrected = applyMessageAuthorityInput(final, {
      type: "room.message.accepted",
      eventId: "event-correction-1",
      message: {
        kind: "agent-final",
        messageId: "message-agent-correction",
        roomId: "room-1",
        authorId: "agent-search",
        createdAt: "2026-08-19T09:06:00.000Z",
        finalBody: "更正后的结论",
        sourceInvocationIntentId: "invocation-intent-1",
        sourceExecutionId: "execution-2",
        citations: [],
        correctsMessageId: "message-agent-final",
      },
    });
    expect(corrected.timeline.map((entry) => entry.messageId))
      .toEqual(["message-source", "message-agent-final", "message-agent-correction"]);
  });
});

describe("J-07 offline / repair / access authority", () => {
  it("keeps the old complete projection during repair and after repair failure", () => {
    const state = initial();
    const repairing = applyMessageAuthorityInput(state, {
      type: "repair.started",
      watermark: 91,
    });
    expect(repairing.timeline).toBe(state.timeline);
    expect(repairing.connection.status).toBe("repairing");
    const failed = failRepairGeneration(repairing, "snapshot_checksum_mismatch");
    expect(failed.timeline).toBe(state.timeline);
    expect(failed.connection.status).toBe("repair-failed");
  });

  it("atomically swaps only a complete repair generation", () => {
    const state = applyMessageAuthorityInput(initial(), { type: "repair.started", watermark: 91 });
    const repaired = commitRepairGeneration(state, {
      generation: 8,
      watermark: 91,
      timeline: [humanMessage({ messageId: "message-repaired" })],
      executions: [],
      appliedEventIds: ["event-repaired"],
    });
    expect(repaired.projectionGeneration).toBe(8);
    expect(repaired.timeline.map((entry) => entry.messageId)).toEqual(["message-repaired"]);
    expect(repaired.connection.status).toBe("online");
  });

  it.each([
    { status: "offline", asOf: "2026-08-19T08:00:00.000Z" },
    { status: "repairing", watermark: 91 },
    { status: "repair-failed", errorCode: "snapshot_checksum_mismatch" },
  ] as const)("disables writes in $status while retaining authorized complete content", (connection) => {
    const state = createMessageAuthorityState({ ...initial(), connection });
    expect(state.timeline).toHaveLength(1);
    expect(state.composerEnabled).toBe(false);
  });
});

describe("edit/recall control authority", () => {
  it("offers controls only to the author of an active Human message in an active online Room", () => {
    const state = initial();
    expect(messageControls(state, state.timeline[0]!)).toEqual({ canRevise: true, canRecall: true });
    expect(messageControls(
      createMessageAuthorityState({ ...state, viewerActorId: "human-other" }),
      state.timeline[0]!,
    )).toEqual({ canRevise: false, canRecall: false });
    expect(messageControls(
      createMessageAuthorityState({ ...state, lifecycle: "archived" }),
      state.timeline[0]!,
    )).toEqual({ canRevise: false, canRecall: false });
  });

  it("correlates mutation ACK/errors without treating ACK as a projection", () => {
    const pending = beginMessageMutation(initial(), {
      kind: "revise", requestId: "revise-1", messageId: "message-source",
      expectedRevision: 1, body: "losing body",
    });
    const unrelated = applyMessageAuthorityInput(pending, {
      type: "message.error", requestId: "other-request",
      status: 409, code: "message_version_conflict",
    });
    expect(unrelated).toBe(pending);

    const acknowledged = applyMessageAuthorityInput(pending, {
      type: "message.revision.accepted", requestId: "revise-1",
      messageId: "message-source", revision: 2,
      persistedAt: "2026-08-19T09:01:00.000Z",
    });
    expect(acknowledged.mutation.status).toBe("acknowledged");
    expect((acknowledged.timeline[0] as ActiveHumanTimelineMessage).body)
      .toBe("权威消息正文");
    expect(acknowledged.announcement).toContain("ACK 不会替换 projection");

    const projected = applyMessageAuthorityInput(acknowledged, {
      type: "room.message.revised", eventId: "event-revised-2",
      messageId: "message-source", revision: 2, body: "winning body",
      revisedAt: "2026-08-19T09:01:00.000Z",
    });
    expect(projected.mutation.status).toBe("idle");
    expect((projected.timeline[0] as ActiveHumanTimelineMessage).body).toBe("winning body");

    const recall = beginMessageMutation(initial(), {
      kind: "recall", requestId: "recall-1", messageId: "message-source",
      expectedRevision: 1,
    });
    const failed = applyMessageAuthorityInput(recall, {
      type: "message.error", requestId: "recall-1",
      status: 503, code: "dependency_unavailable",
    });
    expect(failed.mutation).toMatchObject({
      status: "failed", requestId: "recall-1",
      error: { status: 503, code: "dependency_unavailable" },
    });
    expect((failed.timeline[0] as ActiveHumanTimelineMessage).body).toBe("权威消息正文");
  });
});
