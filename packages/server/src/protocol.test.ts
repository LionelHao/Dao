import { describe, expect, it } from "vitest";
import { parseClientFrame, PROTOCOL_FIELD_LIMITS } from "./index.js";

function parse(value: unknown) {
  return parseClientFrame(JSON.stringify(value));
}

const validDraft = {
  id: "message-1",
  roomId: "room-1",
  body: "hello",
  sentAt: "2026-08-10T00:00:00.000Z",
};

describe("client protocol resource bounds", () => {
  it.each([
    ["requestId", { type: "auth.revoke", requestId: "" }],
    ["accountId", { type: "auth.login", requestId: "r", accountId: "", secret: "s" }],
    ["secret", { type: "auth.login", requestId: "r", accountId: "a", secret: "" }],
    ["accessToken", { type: "auth.resume", requestId: "r", accessToken: "" }],
    ["refreshToken", { type: "auth.refresh", requestId: "r", refreshToken: "" }],
    ["roomId", { type: "room.history", requestId: "r", roomId: "" }],
    ["message.id", { type: "message.send", requestId: "r", message: { ...validDraft, id: "" } }],
    ["message.roomId", { type: "message.send", requestId: "r", message: { ...validDraft, roomId: "" } }],
    ["message.body", { type: "message.send", requestId: "r", message: { ...validDraft, body: "" } }],
    ["message.sentAt", { type: "message.send", requestId: "r", message: { ...validDraft, sentAt: "" } }],
  ])("rejects an empty %s", (_field, frame) => {
    expect(parse(frame)).toMatchObject({
      ok: false,
      error: { type: "error", status: 400, code: "invalid_request" },
    });
  });

  it.each([
    [
      "requestId",
      {
        type: "auth.revoke",
        requestId: "r".repeat(PROTOCOL_FIELD_LIMITS.requestId + 1),
      },
    ],
    [
      "accountId",
      {
        type: "auth.login",
        requestId: "r",
        accountId: "a".repeat(PROTOCOL_FIELD_LIMITS.accountId + 1),
        secret: "s",
      },
    ],
    [
      "secret",
      {
        type: "auth.login",
        requestId: "r",
        accountId: "a",
        secret: "s".repeat(PROTOCOL_FIELD_LIMITS.secret + 1),
      },
    ],
    [
      "token",
      {
        type: "auth.resume",
        requestId: "r",
        accessToken: "t".repeat(PROTOCOL_FIELD_LIMITS.token + 1),
      },
    ],
    [
      "roomId",
      {
        type: "room.subscribe",
        requestId: "r",
        roomId: "x".repeat(PROTOCOL_FIELD_LIMITS.roomId + 1),
      },
    ],
    [
      "messageId",
      {
        type: "message.send",
        requestId: "r",
        message: {
          ...validDraft,
          id: "m".repeat(PROTOCOL_FIELD_LIMITS.messageId + 1),
        },
      },
    ],
    [
      "body",
      {
        type: "message.send",
        requestId: "r",
        message: {
          ...validDraft,
          body: "b".repeat(PROTOCOL_FIELD_LIMITS.body + 1),
        },
      },
    ],
    [
      "sentAt",
      {
        type: "message.send",
        requestId: "r",
        message: {
          ...validDraft,
          sentAt: "t".repeat(PROTOCOL_FIELD_LIMITS.sentAt + 1),
        },
      },
    ],
  ])("rejects an oversized %s without reflecting bounded credentials", (_field, frame) => {
    const parsed = parse(frame);
    expect(parsed).toMatchObject({
      ok: false,
      error: { type: "error", status: 400, code: "invalid_request" },
    });
    expect(JSON.stringify(parsed)).not.toContain("s".repeat(PROTOCOL_FIELD_LIMITS.secret + 1));
    expect(JSON.stringify(parsed)).not.toContain("t".repeat(PROTOCOL_FIELD_LIMITS.token + 1));
  });

  it("accepts fields at their exact maximum length", () => {
    expect(parse({
      type: "message.send",
      requestId: "r".repeat(PROTOCOL_FIELD_LIMITS.requestId),
      message: {
        id: "m".repeat(PROTOCOL_FIELD_LIMITS.messageId),
        roomId: "x".repeat(PROTOCOL_FIELD_LIMITS.roomId),
        body: "b".repeat(PROTOCOL_FIELD_LIMITS.body),
        sentAt: "t".repeat(PROTOCOL_FIELD_LIMITS.sentAt),
      },
    })).toMatchObject({ ok: true });
  });

  it.each([
    {
      field: "accountId and secret",
      frame: {
        type: "auth.login",
        requestId: "r",
        accountId: "a".repeat(PROTOCOL_FIELD_LIMITS.accountId),
        secret: "s".repeat(PROTOCOL_FIELD_LIMITS.secret),
      },
    },
    {
      field: "accessToken",
      frame: {
        type: "auth.resume",
        requestId: "r",
        accessToken: "t".repeat(PROTOCOL_FIELD_LIMITS.token),
      },
    },
    {
      field: "refreshToken",
      frame: {
        type: "auth.refresh",
        requestId: "r",
        refreshToken: "t".repeat(PROTOCOL_FIELD_LIMITS.token),
      },
    },
  ])("accepts maximum-length $field", ({ frame }) => {
    expect(parse(frame)).toMatchObject({ ok: true });
  });

  it.each([
    ["authorId", { authorId: "human-forged" }],
    ["authorKind", { authorKind: "agent" }],
  ])("rejects a client-selected %s as unauthenticated identity tampering", (_field, identity) => {
    expect(
      parse({
        type: "message.send",
        requestId: "identity-tamper",
        message: { ...validDraft, ...identity },
      }),
    ).toMatchObject({
      ok: false,
      error: { type: "error", status: 401, code: "identity_forbidden" },
    });
  });
});
