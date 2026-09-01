import { describe, expect, it, vi } from "vitest";
import type { NotificationProjection, NotificationReadAck } from "@native-im/core";
import { createNotificationCenterBridge, type NotificationReadAuthorityPort } from "./bridge-adapter.js";
import type { NotificationCenterConnection, NotificationCenterRemoteState } from "./view-model.js";

const createdAt = "2026-08-31T08:00:00.000Z";
function item(): NotificationProjection {
  return { recordVersion: "notification.v1", notificationId: "notification-1", roomId: "room-1",
    recipientActorId: "human-1", notificationKind: "human_request",
    source: { sourceKind: "project_request", sourceId: "request-1", sourceRevision: 1,
      sourceBoundaryId: "boundary-1", ordinal: 0 }, dedupeKey: "a".repeat(64), createdAt,
    readAt: null, readRevision: 0, handled: false, handledAt: null, sourceAccessible: true,
    deepLink: { kind: "request", targetId: "request-1" },
    safeProjection: { titleKey: "human_request", actorId: "human-2" } };
}
function state(connection: NotificationCenterConnection = { status: "online" }):
Extract<NotificationCenterRemoteState, { status: "ready" }> {
  return { status: "ready", recipientActorId: "human-1", notifications: [item()],
    roomBadges: [{ roomId: "room-1", unreadCount: 1, unhandledCount: 1 }], connection,
    operation: { status: "idle" }, page: { offset: 0, limit: 50 } };
}
function ack(overrides: Partial<NotificationReadAck> = {}): NotificationReadAck {
  return { type: "notification.read.ack", requestId: "request-1", notificationId: "notification-1",
    roomId: "room-1", recipientActorId: "human-1", outcome: "read", readAt: createdAt,
    readRevision: 1, eventId: "event-read-1", ...overrides };
}

describe("FT-12 notification center authority bridge", () => {
  it.each([
    { status: "offline" as const, asOf: createdAt },
    { status: "repairing" as const, watermark: 9 },
    { status: "repair_failed" as const, code: "checksum_mismatch" },
    { status: "archived" as const, roomIds: ["room-1"] },
  ])("stops $status read intents before the authority transport", async (connection) => {
    const authority: NotificationReadAuthorityPort = { markRead: vi.fn() };
    const bridge = createNotificationCenterBridge({ initialState: state(connection), authority,
      createRequestId: () => "request-1" });
    expect(await bridge.markRead("notification-1", 0)).toMatchObject({ status: "blocked" });
    expect(authority.markRead).not.toHaveBeenCalled();
  });

  it("correlates a closed ACK but leaves visible read authority to the stable event/repair", async () => {
    const authority: NotificationReadAuthorityPort = { markRead: vi.fn().mockResolvedValue(ack()) };
    const remote = state();
    const bridge = createNotificationCenterBridge({ initialState: remote, authority,
      createRequestId: () => "request-1" });
    expect(await bridge.markRead("notification-1", 0)).toEqual({ status: "acknowledged", ack: ack() });
    expect(authority.markRead).toHaveBeenCalledWith({ requestId: "request-1",
      notificationId: "notification-1", expectedReadRevision: 0 });
    expect(remote.notifications[0]?.readAt).toBeNull();
  });

  it("rejects mismatched ACKs and duplicate/stale local intents without forging read", async () => {
    const authority: NotificationReadAuthorityPort = { markRead: vi.fn().mockResolvedValue(
      ack({ recipientActorId: "human-other" })) };
    const bridge = createNotificationCenterBridge({ initialState: state(), authority,
      createRequestId: () => "request-1" });
    await expect(bridge.markRead("notification-1", 0)).rejects.toThrow(/mismatched closed ACK/);
    bridge.update({ ...state(), notifications: [{ ...item(), readAt: createdAt, readRevision: 1 }] });
    expect(await bridge.markRead("notification-1", 1)).toEqual({ status: "blocked", reason: "already_read" });
    expect(authority.markRead).toHaveBeenCalledTimes(1);
  });
});
