import { describe, expect, it } from "vitest";
import { parseClientFrame, PROTOCOL_FIELD_LIMITS } from "../protocol.js";

function parse(value: unknown) {
  return parseClientFrame(JSON.stringify(value));
}

const message = {
  messageId: "message-1",
  roomId: "room-1",
  body: "Hi @Alex",
  mentionedTargets: [{
    id: "target-1",
    kind: "agent-invocation" as const,
    targetActorId: "agent-1",
    range: { startUtf16: 3, endUtf16: 8 },
  }],
  replyToMessageId: "message-parent",
  attachments: [],
};

describe("Message Authority vNext public protocol", () => {
  it("accepts the exact authorless message.send.v2 frame", () => {
    expect(parse({ type: "message.send.v2", requestId: "send-1", message })).toEqual({
      ok: true,
      frame: { type: "message.send.v2", requestId: "send-1", message },
    });
  });

  it.each([
    ["authorId", "agent-1"],
    ["authorKind", "agent"],
    ["actorId", "agent-1"],
    ["principal", "human-1"],
    ["session", "session-1"],
    ["sessionFamilyId", "family-1"],
    ["capability", "forged"],
    ["runtimeKind", "direct_mention"],
    ["provider", "forged"],
    ["model", "forged"],
  ])("rejects injected %s without reflecting the value", (field, injected) => {
    const result = parse({
      type: "message.send.v2",
      requestId: "send-injected",
      message: { ...message, [field]: injected },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { status: 400, code: "author_fields_forbidden", requestId: "send-injected" },
    });
    expect(JSON.stringify(result)).not.toContain(injected);
  });

  it.each([
    {
      name: "split surrogate range",
      candidate: {
        ...message,
        body: "😀 @A",
        mentionedTargets: [{
          ...message.mentionedTargets[0],
          range: { startUtf16: 1, endUtf16: 2 },
        }],
      },
    },
    {
      name: "nested target extra key",
      candidate: {
        ...message,
        mentionedTargets: [{ ...message.mentionedTargets[0], displayName: "Alex" }],
      },
    },
    {
      name: "duplicate semantic target",
      candidate: {
        ...message,
        body: "@A then @B",
        mentionedTargets: [
          { ...message.mentionedTargets[0], range: { startUtf16: 0, endUtf16: 2 } },
          { ...message.mentionedTargets[0], id: "target-2", range: { startUtf16: 8, endUtf16: 10 } },
        ],
      },
    },
  ])("returns mention_entity_invalid for $name", ({ candidate }) => {
    expect(parse({ type: "message.send.v2", requestId: "send-mention", message: candidate }))
      .toMatchObject({
        ok: false,
        error: { status: 400, code: "mention_entity_invalid", requestId: "send-mention" },
      });
  });

  it("accepts closed attachment references for FT-04 AuthorityWorker binding", () => {
    const attachmentMessage = {
      ...message,
      attachments: [{ attachmentId: "attachment-1" }],
    };
    expect(parse({
      type: "message.send.v2",
      requestId: "send-attachment",
      message: attachmentMessage,
    })).toEqual({
      ok: true,
      frame: {
        type: "message.send.v2",
        requestId: "send-attachment",
        message: attachmentMessage,
      },
    });
    expect(parse({
      type: "message.send.v2",
      requestId: "send-attachment-forged",
      message: {
        ...message,
        attachments: [{ attachmentId: "attachment-1", path: "/tmp/private" }],
      },
    })).toMatchObject({ ok: false, error: { code: "invalid_message" } });
  });

  it.each([
    {
      frame: {
        type: "message.revise",
        requestId: "revise-1",
        roomId: "room-1",
        messageId: "message-1",
        expectedRevision: 1,
        body: "revised body",
      },
    },
    {
      frame: {
        type: "message.recall",
        requestId: "recall-1",
        roomId: "room-1",
        messageId: "message-1",
        expectedRevision: 2,
      },
    },
    {
      frame: {
        type: "room.history.v2",
        requestId: "history-1",
        roomId: "room-1",
        afterMessageId: "message-0",
        limit: 50,
      },
    },
    {
      frame: {
        type: "message.revisions.query",
        requestId: "revisions-1",
        roomId: "room-1",
        messageId: "message-1",
        afterRevision: 1,
        limit: 25,
      },
    },
  ])("accepts exact $frame.type", ({ frame }) => {
    expect(parse(frame)).toEqual({ ok: true, frame });
  });

  it.each([
    {
      name: "revise author injection",
      frame: {
        type: "message.revise", requestId: "bad-revise", roomId: "room-1",
        messageId: "message-1", expectedRevision: 1, body: "body", authorId: "human-2",
      },
    },
    {
      name: "recall zero revision",
      frame: {
        type: "message.recall", requestId: "bad-recall", roomId: "room-1",
        messageId: "message-1", expectedRevision: 0,
      },
    },
    {
      name: "history oversized limit",
      frame: {
        type: "room.history.v2", requestId: "bad-history", roomId: "room-1",
        limit: 101,
      },
    },
    {
      name: "revision oversized limit",
      frame: {
        type: "message.revisions.query", requestId: "bad-revisions", roomId: "room-1",
        messageId: "message-1", limit: 101,
      },
    },
  ])("rejects $name with invalid_request", ({ frame }) => {
    expect(parse(frame)).toMatchObject({
      ok: false,
      error: { status: 400, code: "invalid_request", requestId: frame.requestId },
    });
  });

  it("publishes bounded collection limits", () => {
    expect(PROTOCOL_FIELD_LIMITS.messageTargets).toBe(64);
    expect(PROTOCOL_FIELD_LIMITS.messageAttachments).toBe(64);
    expect(PROTOCOL_FIELD_LIMITS.historyPage).toBe(100);
    expect(PROTOCOL_FIELD_LIMITS.revisionPage).toBe(100);
  });

  it.each(["agent.message.final.commit", "agent.message.correction.commit"])(
    "does not expose public %s",
    (type) => {
      expect(parse({
        type,
        requestId: "forged-agent-message",
        roomId: "room-1",
        body: "forged",
        agentId: "agent-1",
        capability: "forged",
      })).toMatchObject({
        ok: false,
        error: { status: 400, code: "invalid_request", requestId: "forged-agent-message" },
      });
    },
  );
});
