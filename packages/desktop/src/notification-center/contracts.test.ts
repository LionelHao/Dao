import { describe, expect, it } from "vitest";
import {
  cloneNotificationCenterRemoteState,
  isNotificationListQuery,
  isNotificationListWireResult,
  isNotificationMarkReadIntent,
  isNotificationResolveSourceIntent,
} from "./contracts.js";
import type { NotificationProjection } from "@native-im/core";

function notification(overrides: Partial<NotificationProjection> = {}): NotificationProjection {
  return {
    recordVersion: "notification.v1",
    notificationId: "notification-1",
    roomId: "room-1",
    recipientActorId: "human-1",
    notificationKind: "human_request",
    source: { sourceKind: "project_request", sourceId: "request-1", sourceRevision: 1,
      sourceBoundaryId: "request-1:1", ordinal: 0 },
    dedupeKey: "a".repeat(64),
    createdAt: "2026-08-31T00:00:00.000Z",
    readAt: null,
    readRevision: 0,
    handled: false,
    handledAt: null,
    sourceAccessible: true,
    deepLink: { kind: "request", targetId: "request-1" },
    safeProjection: { titleKey: "human_request", actorId: "human-2" },
    ...overrides,
  };
}

describe("notification center closed Desktop contracts", () => {
  it("accepts only bounded recipient-free list/read/source intents", () => {
    expect(isNotificationListQuery({ roomId: null, before: null, limit: 50 })).toBe(true);
    expect(isNotificationListQuery({ roomId: "room-1", before: {
      createdAt: "2026-08-31T00:00:00.000Z", notificationId: "notification-1",
    }, limit: 1 })).toBe(true);
    expect(isNotificationListQuery({ roomId: null, before: null, limit: 51 })).toBe(false);
    expect(isNotificationListQuery({ roomId: null, before: null, limit: 1,
      recipientActorId: "human-2" })).toBe(false);
    expect(isNotificationMarkReadIntent({ notificationId: "notification-1",
      expectedReadRevision: 0 })).toBe(true);
    expect(isNotificationMarkReadIntent({ notificationId: "notification-1",
      expectedReadRevision: 0, handled: true })).toBe(false);
    expect(isNotificationResolveSourceIntent({ notificationId: "notification-1" })).toBe(true);
    expect(isNotificationResolveSourceIntent({ notificationId: "notification-1",
      sourceId: "request-secret" })).toBe(false);
  });

  it("requires a bounded list and a principal-stream watermark", () => {
    expect(isNotificationListWireResult({ type: "notification.list.result", requestId: "request-1",
      notifications: [notification()], roomBadges: [{ roomId: "room-1", unreadCount: 1,
        unhandledCount: 1 }], hasMore: false, identityWatermark: 9 })).toBe(true);
    expect(isNotificationListWireResult({ type: "notification.list.result", requestId: "request-1",
      notifications: [notification()], roomBadges: [], hasMore: false })).toBe(false);
    expect(isNotificationListWireResult({ type: "notification.list.result", requestId: "request-1",
      notifications: Array.from({ length: 51 }, (_, index) => notification({
        notificationId: `notification-${index}`, dedupeKey: index.toString(16).padStart(64, "0"),
      })), roomBadges: [], hasMore: true, identityWatermark: 9 })).toBe(false);
  });

  it("clones only complete recipient-scoped renderer state", () => {
    const projection = notification();
    const state = { status: "ready" as const, recipientActorId: "human-1",
      notifications: [projection], roomBadges: [{ roomId: "room-1", unreadCount: 1,
        unhandledCount: 1 }], connection: { status: "online" as const },
      operation: { status: "idle" as const }, hasMore: false, page: { offset: 0, limit: 50 } };
    expect(cloneNotificationCenterRemoteState(state)).toEqual(state);
    expect(() => cloneNotificationCenterRemoteState({ ...state, notifications: [
      notification({ recipientActorId: "human-2" }),
    ] })).toThrow(TypeError);
    expect(() => cloneNotificationCenterRemoteState({ ...state, rawBody: "secret" })).toThrow(TypeError);
  });
});
