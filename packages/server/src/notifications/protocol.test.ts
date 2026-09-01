import { describe, expect, it } from "vitest";
import { parseClientFrame } from "../protocol.js";
import { isNotificationServerFrame, parseNotificationClientFrame } from "./protocol.js";

describe("FT-12 closed Notification WebSocket protocol", () => {
  const frames = [
    { type: "notification.list", requestId: "request-1", roomId: null,
      before: null, limit: 50 },
    { type: "notification.mark-read", requestId: "request-2",
      notificationId: "notification-1", expectedReadRevision: 0 },
    { type: "notification.source.resolve", requestId: "request-3",
      notificationId: "notification-1" },
    { type: "notification.tool-result.acknowledge", requestId: "request-4",
      notificationId: "notification-1" },
    { type: "notification.execution-result.acknowledge", requestId: "request-5",
      notificationId: "notification-execution-1" },
  ] as const;

  it("accepts only the five closed recipient operations", () => {
    for (const frame of frames) {
      expect(parseNotificationClientFrame(frame)).toEqual({ ok: true, frame });
      expect(parseClientFrame(JSON.stringify(frame))).toEqual({ ok: true, frame });
    }
  });

  it("rejects recipient, handled, source metadata, path, and generic action injection", () => {
    for (const injected of [
      { recipientActorId: "human-other" }, { handled: true }, { sourceId: "secret" },
      { path: "/tmp/export" }, { action: "dismiss" }, { token: "secret" },
    ]) {
      expect(parseNotificationClientFrame({ ...frames[1], ...injected })).toMatchObject({ ok: false });
    }
  });

  it("requires the AuthorityWorker identity watermark on bounded list results", () => {
    expect(isNotificationServerFrame({
      type: "notification.list.result", requestId: "request-list",
      notifications: [], hasMore: false, roomBadges: [], identityWatermark: 12,
    })).toBe(true);
    expect(isNotificationServerFrame({
      type: "notification.list.result", requestId: "request-list", notifications: [],
    })).toBe(false);
    expect(isNotificationServerFrame({
      type: "notification.list.result", requestId: "request-list",
      notifications: [], hasMore: false, roomBadges: [], identityWatermark: -1,
    })).toBe(false);
    expect(isNotificationServerFrame({
      type: "notification.tool-result.ack", requestId: "request-4",
      outcome: "acknowledged", projection: {
        recordVersion: "notification.v1", notificationId: "notification-1",
        roomId: "room-1", recipientActorId: "human-1", notificationKind: "tool_result",
        source: { sourceKind: "tool_call", sourceId: "tool-call-1", sourceRevision: 1,
          sourceBoundaryId: "tool-call-1", ordinal: 0 }, dedupeKey: "a".repeat(64),
        createdAt: "2026-08-31T08:00:00.000Z", readAt: null, readRevision: 0,
        handled: true, handledAt: "2026-08-31T08:01:00.000Z", sourceAccessible: true,
        deepLink: { kind: "tool_call", targetId: "tool-call-1" },
        safeProjection: { titleKey: "tool_result", actorId: null },
      },
    })).toBe(true);
    expect(isNotificationServerFrame({
      type: "notification.execution-result.ack", requestId: "request-5",
      outcome: "acknowledged", projection: {
        recordVersion: "notification.v1", notificationId: "notification-execution-1",
        roomId: "room-1", recipientActorId: "human-1",
        notificationKind: "agent_execution_completed",
        source: { sourceKind: "agent_execution", sourceId: "execution-1", sourceRevision: 2,
          sourceBoundaryId: "execution-1", ordinal: 0 }, dedupeKey: "b".repeat(64),
        createdAt: "2026-08-31T08:00:00.000Z", readAt: null, readRevision: 0,
        handled: true, handledAt: "2026-08-31T08:01:00.000Z", sourceAccessible: true,
        deepLink: { kind: "agent_execution", targetId: "execution-1" },
        safeProjection: { titleKey: "agent_execution_completed", actorId: "agent-1" },
      },
    })).toBe(true);
  });
});
