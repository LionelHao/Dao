import { describe, expect, it } from "vitest";
import {
  parseClientFrame,
  PROTOCOL_FIELD_LIMITS,
  ROOM_SYNC_MAX_LIMIT,
} from "./index.js";

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

describe("closed v2 recovery protocol", () => {
  const cursor = { version: 1, roomId: "room-1", afterSeq: 7 } as const;

  it.each([
    { type: "workspace.bootstrap.begin", requestId: "bootstrap-begin" },
    {
      type: "workspace.bootstrap.page",
      requestId: "bootstrap-page",
      snapshotId: "catalog-snapshot",
      afterPage: 0,
    },
    {
      type: "room.sync",
      requestId: "sync",
      roomId: "room-1",
      cursor,
      limit: ROOM_SYNC_MAX_LIMIT,
    },
    { type: "room.repair.begin", requestId: "repair-begin", roomId: "room-1" },
    {
      type: "room.repair.page",
      requestId: "repair-page",
      snapshotId: "room-snapshot",
      afterPage: 0,
    },
    {
      type: "snapshot.complete",
      requestId: "complete-room",
      snapshotId: "room-snapshot",
      version: { kind: "room", roomId: "room-1", watermark: 7 },
      snapshotChecksum: "sha256-room",
    },
    {
      type: "snapshot.complete",
      requestId: "complete-catalog",
      snapshotId: "catalog-snapshot",
      version: { kind: "catalog", catalogRevision: 3 },
      snapshotChecksum: "sha256-catalog",
    },
    {
      type: "room.subscribe.v2",
      requestId: "subscribe-v2",
      roomId: "room-1",
      cursor,
    },
  ])("accepts $type as a closed frame", (frame) => {
    expect(parse(frame)).toEqual({ ok: true, frame });
  });

  it.each([
    {
      name: "an extra bootstrap field",
      frame: { type: "workspace.bootstrap.begin", requestId: "r", roomId: "room-1" },
    },
    {
      name: "a missing requestId",
      frame: { type: "room.repair.begin", roomId: "room-1" },
    },
    {
      name: "a negative page",
      frame: {
        type: "room.repair.page",
        requestId: "r",
        snapshotId: "snapshot-1",
        afterPage: -1,
      },
    },
    {
      name: "a non-safe future page",
      frame: {
        type: "workspace.bootstrap.page",
        requestId: "r",
        snapshotId: "snapshot-1",
        afterPage: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    {
      name: "an unknown cursor version",
      frame: {
        type: "room.sync",
        requestId: "r",
        roomId: "room-1",
        cursor: { version: 2, roomId: "room-1", afterSeq: 0 },
      },
    },
    {
      name: "a cursor for another room",
      frame: {
        type: "room.sync",
        requestId: "r",
        roomId: "room-1",
        cursor: { version: 1, roomId: "room-2", afterSeq: 0 },
      },
    },
    {
      name: "an over-limit sync page size",
      frame: {
        type: "room.sync",
        requestId: "r",
        roomId: "room-1",
        limit: ROOM_SYNC_MAX_LIMIT + 1,
      },
    },
    {
      name: "a cursorless v2 subscription",
      frame: { type: "room.subscribe.v2", requestId: "r", roomId: "room-1" },
    },
    {
      name: "a catalog version with room fields",
      frame: {
        type: "snapshot.complete",
        requestId: "r",
        snapshotId: "snapshot-1",
        version: { kind: "catalog", catalogRevision: 3, roomId: "room-1" },
        snapshotChecksum: "sha256-value",
      },
    },
    {
      name: "a room version with catalog fields",
      frame: {
        type: "snapshot.complete",
        requestId: "r",
        snapshotId: "snapshot-1",
        version: {
          kind: "room",
          roomId: "room-1",
          watermark: 3,
          catalogRevision: 3,
        },
        snapshotChecksum: "sha256-value",
      },
    },
    {
      name: "an oversized snapshot ID",
      frame: {
        type: "room.repair.page",
        requestId: "r",
        snapshotId: "s".repeat(PROTOCOL_FIELD_LIMITS.snapshotId + 1),
        afterPage: 0,
      },
    },
    {
      name: "an oversized checksum",
      frame: {
        type: "snapshot.complete",
        requestId: "r",
        snapshotId: "snapshot-1",
        version: { kind: "catalog", catalogRevision: 3 },
        snapshotChecksum: "c".repeat(PROTOCOL_FIELD_LIMITS.snapshotChecksum + 1),
      },
    },
  ])("rejects $name", ({ frame }) => {
    expect(parse(frame)).toMatchObject({
      ok: false,
      error: { type: "error", status: 400, code: "invalid_request" },
    });
  });

  it("keeps T-0039 cursorless history and subscribe frames valid", () => {
    expect(parse({ type: "room.history", requestId: "history", roomId: "room-1" }))
      .toEqual({
        ok: true,
        frame: { type: "room.history", requestId: "history", roomId: "room-1" },
      });
    expect(parse({ type: "room.subscribe", requestId: "subscribe", roomId: "room-1" }))
      .toEqual({
        ok: true,
        frame: { type: "room.subscribe", requestId: "subscribe", roomId: "room-1" },
      });
  });

  it("accepts only closed T-0041 Agent runtime control frames", () => {
    expect(parse({
      type: "agent.invoke",
      requestId: "invoke-1",
      intent: {
        kind: "direct_mention",
        roomId: "room-1",
        sourceMessageId: "message-1",
        targetAgentId: "agent-1",
      },
    })).toMatchObject({ ok: true, frame: { type: "agent.invoke" } });
    expect(parse({
      type: "agent.interrupt",
      requestId: "interrupt-1",
      executionId: "execution-1",
      reason: "human_cancelled",
    })).toMatchObject({ ok: true, frame: { type: "agent.interrupt" } });
    expect(parse({
      type: "agent.tool.confirm",
      requestId: "confirm-1",
      confirmation: { confirmationId: "confirmation-1", executionId: "execution-1" },
    })).toMatchObject({ ok: true, frame: { type: "agent.tool.confirm" } });
    expect(parse({
      type: "agent.invoke",
      requestId: "invoke-forged",
      intent: {
        kind: "direct_mention",
        roomId: "room-1",
        sourceMessageId: "message-1",
        targetAgentId: "agent-1",
        requesterId: "forged-human",
      },
    })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });
});
