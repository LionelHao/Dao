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

const validDevice = {
  id: "desktop-installation-1",
  label: "Test desktop",
  platform: "macos",
} as const;

describe("client protocol resource bounds", () => {
  it("keeps a maximum escaped session list below the Desktop 64 KiB frame bound", () => {
    const escaped = "\"".repeat(PROTOCOL_FIELD_LIMITS.sessionId);
    const frame = {
      type: "auth.sessions",
      requestId: "\0".repeat(PROTOCOL_FIELD_LIMITS.requestId),
      sessions: Array.from({ length: PROTOCOL_FIELD_LIMITS.sessions }, (_, index) => ({
        id: escaped,
        deviceLabel: escaped,
        platform: "windows",
        createdAt: "2026-08-18T00:00:00.000Z",
        refreshExpiresAt: "2026-09-18T00:00:00.000Z",
        current: index === 0,
      })),
    };

    expect(PROTOCOL_FIELD_LIMITS.sessions).toBe(96);
    expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThan(64 * 1_024);
  });

  it("requires a closed device descriptor on auth.login", () => {
    expect(parse({
      type: "auth.login",
      requestId: "login-device",
      accountId: "account-human-1",
      secret: "credential-canary",
      device: { ...validDevice, label: "Lionel's MacBook" },
    })).toEqual({
      ok: true,
      frame: {
        type: "auth.login",
        requestId: "login-device",
        accountId: "account-human-1",
        secret: "credential-canary",
        device: { ...validDevice, label: "Lionel's MacBook" },
      },
    });

    expect(parse({
      type: "auth.login",
      requestId: "missing-device",
      accountId: "account-human-1",
      secret: "credential-canary",
    })).toMatchObject({
      ok: false,
      error: { status: 400, code: "invalid_request", requestId: "missing-device" },
    });
  });

  it.each([
    {
      name: "missing device id",
      device: { label: "MacBook", platform: "macos" },
    },
    {
      name: "empty device id",
      device: { id: "", label: "MacBook", platform: "macos" },
    },
    {
      name: "blank device id",
      device: { id: "   ", label: "MacBook", platform: "macos" },
    },
    {
      name: "empty device label",
      device: { id: "desktop-1", label: "", platform: "macos" },
    },
    {
      name: "blank device label",
      device: { id: "desktop-1", label: "   ", platform: "macos" },
    },
    {
      name: "unknown platform",
      device: { id: "desktop-1", label: "MacBook", platform: "ios" },
    },
    {
      name: "extra device field",
      device: { id: "desktop-1", label: "MacBook", platform: "macos", actorId: "forged" },
    },
    {
      name: "oversized UTF-8 device id",
      device: {
        id: "界".repeat(Math.floor(PROTOCOL_FIELD_LIMITS.deviceId / 3) + 1),
        label: "MacBook",
        platform: "macos",
      },
    },
    {
      name: "oversized UTF-8 device label",
      device: {
        id: "desktop-1",
        label: "界".repeat(Math.floor(PROTOCOL_FIELD_LIMITS.deviceLabel / 3) + 1),
        platform: "macos",
      },
    },
  ])("rejects $name without reflecting the login secret", ({ device }) => {
    const parsed = parse({
      type: "auth.login",
      requestId: "invalid-device",
      accountId: "account-human-1",
      secret: "device-secret-canary",
      device,
    });

    expect(parsed).toMatchObject({
      ok: false,
      error: {
        type: "error",
        status: 400,
        code: "invalid_request",
        requestId: "invalid-device",
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("device-secret-canary");
  });

  it("accepts exact device limits measured in UTF-8 bytes", () => {
    expect(parse({
      type: "auth.login",
      requestId: "device-limits",
      accountId: "account-human-1",
      secret: "secret",
      device: {
        id: "i".repeat(PROTOCOL_FIELD_LIMITS.deviceId),
        label: "l".repeat(PROTOCOL_FIELD_LIMITS.deviceLabel),
        platform: "linux",
      },
    })).toMatchObject({ ok: true });
  });

  it.each([
    {
      frame: { type: "auth.sessions.list", requestId: "sessions-list" },
      expected: { type: "auth.sessions.list", requestId: "sessions-list" },
    },
    {
      frame: {
        type: "auth.session.revoke",
        requestId: "session-revoke",
        sessionId: "public-session-2",
      },
      expected: {
        type: "auth.session.revoke",
        requestId: "session-revoke",
        sessionId: "public-session-2",
      },
    },
  ])("accepts closed $frame.type requests", ({ frame, expected }) => {
    expect(parse(frame)).toEqual({ ok: true, frame: expected });
  });

  it.each([
    {
      name: "list extra field",
      frame: { type: "auth.sessions.list", requestId: "sessions-list", accountId: "forged" },
    },
    {
      name: "list missing requestId",
      frame: { type: "auth.sessions.list" },
    },
    {
      name: "target revoke missing sessionId",
      frame: { type: "auth.session.revoke", requestId: "session-revoke" },
    },
    {
      name: "target revoke empty sessionId",
      frame: { type: "auth.session.revoke", requestId: "session-revoke", sessionId: "" },
    },
    {
      name: "target revoke blank sessionId",
      frame: { type: "auth.session.revoke", requestId: "session-revoke", sessionId: "   " },
    },
    {
      name: "target revoke oversized sessionId",
      frame: {
        type: "auth.session.revoke",
        requestId: "session-revoke",
        sessionId: "s".repeat(PROTOCOL_FIELD_LIMITS.sessionId + 1),
      },
    },
    {
      name: "target revoke extra field",
      frame: {
        type: "auth.session.revoke",
        requestId: "session-revoke",
        sessionId: "public-session-2",
        accessToken: "credential-canary",
      },
    },
  ])("rejects $name as an invalid request", ({ frame }) => {
    const parsed = parse(frame);
    expect(parsed).toMatchObject({
      ok: false,
      error: { type: "error", status: 400, code: "invalid_request" },
    });
    expect(JSON.stringify(parsed)).not.toContain("credential-canary");
  });

  it("accepts only the room-scoped closed ball query frame", () => {
    expect(parse({ type: "ball.query", requestId: "ball-1", roomId: "room-1" }))
      .toEqual({
        ok: true, frame: { type: "ball.query", requestId: "ball-1", roomId: "room-1" },
      });
    expect(parse({
      type: "ball.query", requestId: "ball-1", roomId: "room-1", actorId: "human-2",
    }).ok).toBe(false);
  });

  it.each([
    ["requestId", { type: "auth.revoke", requestId: "" }],
    ["accountId", {
      type: "auth.login", requestId: "r", accountId: "", secret: "s", device: validDevice,
    }],
    ["secret", {
      type: "auth.login", requestId: "r", accountId: "a", secret: "", device: validDevice,
    }],
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
        device: validDevice,
      },
    ],
    [
      "secret",
      {
        type: "auth.login",
        requestId: "r",
        accountId: "a",
        secret: "s".repeat(PROTOCOL_FIELD_LIMITS.secret + 1),
        device: validDevice,
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
        device: validDevice,
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
      type: "invocation.cancel",
      requestId: "cancel-vnext-1",
      executionId: "execution-1",
      expectedVersion: 4,
    })).toEqual({
      ok: true,
      frame: {
        type: "invocation.cancel",
        requestId: "cancel-vnext-1",
        executionId: "execution-1",
        expectedVersion: 4,
      },
    });
    expect(parse({
      type: "invocation.cancel",
      requestId: "cancel-pending-intent",
      intentId: "intent-pending-1",
      expectedVersion: 1,
    })).toEqual({
      ok: true,
      frame: {
        type: "invocation.cancel",
        requestId: "cancel-pending-intent",
        intentId: "intent-pending-1",
        expectedVersion: 1,
      },
    });
    expect(parse({
      type: "invocation.retry",
      requestId: "retry-vnext-1",
      executionId: "execution-1",
      expectedVersion: 5,
    })).toMatchObject({ ok: true, frame: { type: "invocation.retry", expectedVersion: 5 } });
    for (const forged of [
      { type: "invocation.cancel", requestId: "forged-reason", executionId: "execution-1", expectedVersion: 4, reason: "anything" },
      { type: "invocation.cancel", requestId: "forged-agent", executionId: "execution-1", expectedVersion: 4, agentId: "agent-1" },
      { type: "invocation.retry", requestId: "forged-model", executionId: "execution-1", expectedVersion: 4, modelId: "chosen-by-client" },
      { type: "invocation.retry", requestId: "missing-version", executionId: "execution-1" },
      { type: "invocation.cancel", requestId: "zero-version", executionId: "execution-1", expectedVersion: 0 },
      { type: "invocation.cancel", requestId: "both-targets", executionId: "execution-1", intentId: "intent-1", expectedVersion: 4 },
      { type: "invocation.cancel", requestId: "no-target", expectedVersion: 4 },
    ]) {
      expect(parse(forged)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
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

  it("accepts only closed T-0017 human OpenItem frames", () => {
    expect(parse({
      type: "open-item.create",
      requestId: "open-create",
      roomId: "room-1",
      creationKind: "human_mention",
      sourceMessageId: "message-1",
      targetActorId: "human-2",
      content: "请确认权限边界",
    })).toMatchObject({ ok: true, frame: { type: "open-item.create", creationKind: "human_mention" } });
    expect(parse({
      type: "open-item.transition", requestId: "open-transfer", roomId: "room-1",
      itemId: "item-1", action: "transfer", targetActorId: "human-3", reason: "领域转交",
    })).toMatchObject({ ok: true, frame: { type: "open-item.transition", action: "transfer" } });
    expect(parse({
      type: "open-item.transition", requestId: "open-answer", roomId: "room-1",
      itemId: "item-1", action: "answer",
    })).toMatchObject({ ok: true, frame: { type: "open-item.transition", action: "answer" } });
    for (const frame of [
      {
        type: "open-item.create", requestId: "natural-language", roomId: "room-1",
        creationKind: "risk", sourceMessageId: "message-1", targetActorId: "human-2", content: "risk",
      },
      {
        type: "open-item.create", requestId: "forged", roomId: "room-1",
        creationKind: "human_mention", sourceMessageId: "message-1", targetActorId: "human-2",
        content: "risk", requesterId: "human-forged",
      },
      {
        type: "open-item.transition", requestId: "open-defer-no-reason", roomId: "room-1",
        itemId: "item-1", action: "defer",
      },
      {
        type: "open-item.transition", requestId: "open-answer-extra", roomId: "room-1",
        itemId: "item-1", action: "answer", reason: "not closed",
      },
    ]) {
      expect(parse(frame)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
  });

  it("accepts only exact FT-10 Human tool-safety commands", () => {
    const frames = [
      {
        type: "tool.confirmation.decide", requestId: "tool-decide",
        confirmationId: "confirmation-1", expectedVersion: 1, decision: "confirm",
      },
      {
        type: "tool.confirmation.handoff.offer", requestId: "tool-offer",
        confirmationId: "confirmation-1", expectedVersion: 1, targetActorId: "human-2",
      },
      {
        type: "tool.confirmation.handoff.accept", requestId: "tool-accept",
        handoffId: "handoff-1", expectedVersion: 2,
      },
      {
        type: "tool.outcome.review", requestId: "tool-review",
        dispatchId: "dispatch-1", expectedVersion: 3,
        resolution: "accepted_risk", evidenceSummary: "Human checked the target.",
      },
      {
        type: "tool.compensation.propose", requestId: "tool-compensate",
        dispatchId: "dispatch-1", expectedVersion: 3,
      },
    ] as const;
    for (const frame of frames) {
      expect(parse(frame)).toEqual({ ok: true, frame });
    }
    expect(parse({ ...frames[3], resolution: "compensated" })).toMatchObject({
      ok: true, frame: { type: "tool.outcome.review", resolution: "compensated" },
    });

    const forbiddenFields = [
      "roomId", "principalId", "sessionFamilyId", "agentId", "attemptSeq",
      "toolId", "canonicalParameterSha256", "rawParameters", "grantId",
      "dispatchPermit", "capability", "provider", "model", "url", "headers",
      "pathRoot", "sealedPayload",
    ] as const;
    for (const field of forbiddenFields) {
      const parsed = parse({ ...frames[0], [field]: `${field}-canary` });
      expect(parsed).toMatchObject({
        ok: false,
        error: { status: 400, code: "invalid_request", requestId: "tool-decide" },
      });
      expect(JSON.stringify(parsed)).not.toContain(`${field}-canary`);
    }

    for (const invalid of [
      { ...frames[0], expectedVersion: 0 },
      { ...frames[0], decision: "approve" },
      { ...frames[1], targetActorId: "" },
      { ...frames[2], handoffId: "" },
      { ...frames[3], resolution: "undo" },
      { ...frames[3], evidenceSummary: "" },
      { ...frames[4], dispatchId: "" },
    ]) {
      expect(parse(invalid)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
  });

  it("accepts only explicit closed T-0018 LightTask frames", () => {
    expect(parse({
      type: "light-task.intent", requestId: "task-intent", roomId: "room-1",
      sourceMessageId: "message-1", text: "我来做",
    })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(parse({
      type: "light-task.create", requestId: "task-create", roomId: "room-1",
      sourceMessageId: "message-1", title: "完成评审", verifierRole: "owner",
      criteria: [{ id: "criterion-1", text: "评审通过" }],
    })).toMatchObject({ ok: true, frame: { type: "light-task.create", verifierRole: "owner" } });
    expect(parse({
      type: "light-task.transition", requestId: "task-verify", roomId: "room-1",
      taskId: "task-1", action: "verify", emptyCriteriaConfirmed: true,
    })).toMatchObject({ ok: true, frame: { type: "light-task.transition", action: "verify" } });
    expect(parse({
      type: "light-task.criterion.set", requestId: "task-check", roomId: "room-1",
      taskId: "task-1", criterionId: "criterion-1", met: true,
    })).toMatchObject({ ok: true, frame: { type: "light-task.criterion.set", met: true } });
    for (const injected of ["deps", "maturity", "milestone", "blueprintTaskId", "status"]) {
      expect(parse({
        type: "light-task.create", requestId: `task-${injected}`, roomId: "room-1",
        sourceMessageId: "message-1", title: "完成评审", verifierRole: "owner", criteria: [],
        [injected]: injected === "deps" ? [] : "forged",
      })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(parse({
      type: "light-task.transition", requestId: "task-deliver-forged", roomId: "room-1",
      taskId: "task-1", action: "deliver", emptyCriteriaConfirmed: true,
    })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("accepts only closed FT-02A governance CAS frames", () => {
    expect(parse({
      type: "room.governance.get", requestId: "governance-get", roomId: "room-1",
    })).toMatchObject({ ok: true, frame: { type: "room.governance.get" } });
    expect(parse({
      type: "room.ownership.transfer", requestId: "transfer", roomId: "room-1",
      targetActorId: "human-2", expectedGovernanceRevision: 3, idempotencyKey: "transfer-key",
    })).toMatchObject({ ok: true, frame: {
      type: "room.ownership.transfer", expectedGovernanceRevision: 3,
    } });
    expect(parse({
      type: "room.member.role.set", requestId: "role", roomId: "room-1",
      targetActorId: "human-2", role: "admin", expectedGovernanceRevision: 3,
      idempotencyKey: "role-key",
    })).toMatchObject({ ok: true, frame: { type: "room.member.role.set", role: "admin" } });
    for (const frame of [
      {
        type: "room.member.role.set", requestId: "owner-forged", roomId: "room-1",
        targetActorId: "human-2", role: "owner", expectedGovernanceRevision: 3,
        idempotencyKey: "owner-forged",
      },
      {
        type: "room.ownership.transfer", requestId: "missing-cas", roomId: "room-1",
        targetActorId: "human-2", idempotencyKey: "missing-cas",
      },
      {
        type: "room.member.leave", requestId: "extra", roomId: "room-1",
        expectedGovernanceRevision: 3, idempotencyKey: "extra", responsibilityPlan: [],
      },
    ]) {
      expect(parse(frame)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
  });

  it("accepts the closed FT-02B departure query and FT-02B/FT-02C CAS frames", () => {
    expect(parse({
      type: "room.departure.conflicts",
      requestId: "departure-preflight",
      roomId: "room-1",
      targetActorId: "human-2",
    })).toEqual({
      ok: true,
      frame: {
        type: "room.departure.conflicts",
        requestId: "departure-preflight",
        roomId: "room-1",
        targetActorId: "human-2",
      },
    });

    for (const frame of [
      {
        type: "room.member.leave", requestId: "leave", roomId: "room-1",
        expectedGovernanceRevision: 4, idempotencyKey: "leave-key",
      },
      {
        type: "room.member.remove", requestId: "remove", roomId: "room-1",
        targetActorId: "human-2", expectedGovernanceRevision: 4,
        idempotencyKey: "remove-key",
      },
      {
        type: "room.archive", requestId: "archive", roomId: "room-1",
        expectedGovernanceRevision: 4, idempotencyKey: "archive-key",
      },
      {
        type: "room.reopen", requestId: "reopen", roomId: "room-1",
        expectedGovernanceRevision: 5, idempotencyKey: "reopen-key",
      },
    ]) {
      expect(parse(frame)).toEqual({ ok: true, frame });
    }
  });

  it.each([
    ["missing target", {
      type: "room.departure.conflicts", requestId: "missing-target", roomId: "room-1",
    }],
    ["wrong target", {
      type: "room.departure.conflicts", requestId: "wrong-target", roomId: "room-1",
      targetActorId: 42,
    }],
    ["oversized target", {
      type: "room.departure.conflicts", requestId: "large-target", roomId: "room-1",
      targetActorId: "t".repeat(PROTOCOL_FIELD_LIMITS.accountId + 1),
    }],
    ["missing CAS", {
      type: "room.archive", requestId: "missing-cas", roomId: "room-1",
      idempotencyKey: "archive-key",
    }],
    ["wrong CAS", {
      type: "room.reopen", requestId: "wrong-cas", roomId: "room-1",
      expectedGovernanceRevision: "4", idempotencyKey: "reopen-key",
    }],
    ["negative CAS", {
      type: "room.member.leave", requestId: "negative-cas", roomId: "room-1",
      expectedGovernanceRevision: -1, idempotencyKey: "leave-key",
    }],
    ["oversized key", {
      type: "room.member.remove", requestId: "large-key", roomId: "room-1",
      targetActorId: "human-2", expectedGovernanceRevision: 4,
      idempotencyKey: "k".repeat(PROTOCOL_FIELD_LIMITS.requestId + 1),
    }],
    ...["actorId", "role", "principal", "sessionFamilyId", "grant", "capability"].map(
      (field) => [`${field} injection`, {
        type: "room.member.remove", requestId: `injected-${field}`, roomId: "room-1",
        targetActorId: "human-2", expectedGovernanceRevision: 4,
        idempotencyKey: `key-${field}`, [field]: "forged",
      }] as const,
    ),
  ])("rejects FT-02 governance %s", (_name, frame) => {
    expect(parse(frame)).toMatchObject({
      ok: false,
      error: { type: "error", status: 400, code: "invalid_request" },
    });
  });

  it("routes closed FT-04 attachment frames through the production parser", () => {
    expect(parse({
      type: "attachment.upload.begin",
      requestId: "attachment-begin",
      roomId: "room-1",
      uploadKey: "upload-key-1",
      originalFilename: "safe.txt",
      declaredMime: null,
      expectedBytes: 4,
      expectedSha256: "a".repeat(64),
    })).toMatchObject({
      ok: true,
      frame: { type: "attachment.upload.begin", expectedBytes: 4 },
    });
    expect(parse({
      type: "attachment.status.query",
      requestId: "attachment-status",
      attachmentId: "attachment-1",
    })).toMatchObject({ ok: true, frame: { type: "attachment.status.query" } });
    expect(parse({
      type: "attachment.upload.begin",
      requestId: "attachment-too-large",
      roomId: "room-1",
      uploadKey: "upload-key-2",
      originalFilename: "safe.txt",
      declaredMime: "text/plain",
      expectedBytes: 52_428_801,
      expectedSha256: "a".repeat(64),
    })).toEqual({
      ok: false,
      error: {
        type: "error",
        status: 413,
        code: "attachment_too_large",
        message: "Invalid attachment request",
        requestId: "attachment-too-large",
      },
    });
  });

  it("routes only exact FT-05 Room Memory v1 requests", () => {
    const requests = [
      { type: "room.memory.query.v1", requestId: "memory-query", roomId: "room-1", limit: 50 },
      { type: "room.memory.source.query.v1", requestId: "memory-source", roomId: "room-1",
        sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1 },
      { type: "room.memory.context.dispute.v1", requestId: "memory-dispute", roomId: "room-1", memoryRecordId: "memory-1", expectedVersion: 1, reason: "Incorrect context" },
      { type: "room.memory.context.resolve.v1", requestId: "memory-resolve", roomId: "room-1", memoryRecordId: "memory-1", expectedVersion: 2, resolution: "re_evaluate", reason: "Recheck sources" },
      { type: "room.memory.status.query.v1", requestId: "memory-status", roomId: "room-1" },
      { type: "room.memory.retry.v1", requestId: "memory-retry", roomId: "room-1", expectedRecoveryGeneration: 1 },
    ] as const;
    for (const request of requests) expect(parse(request)).toEqual({ ok: true, frame: request });

    for (const request of [
      { ...requests[0], actorId: "forged-human" },
      { ...requests[2], kind: "context" },
      { ...requests[3], confirmed: true },
      { ...requests[4], provider: "fake" },
      { ...requests[5], expectedRecoveryGeneration: -1 },
    ]) expect(parse(request)).toMatchObject({
      ok: false, error: { type: "error", status: 400, code: "invalid_request" },
    });
  });
});
