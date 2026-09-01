import { describe, expect, it } from "vitest";
import type { NotificationProjection } from "@native-im/core";
import { createNotificationCenterViewModel, type NotificationCenterRemoteState } from "./view-model.js";

const createdAt = "2026-08-31T08:00:00.000Z";
function item(overrides: Partial<NotificationProjection> = {}): NotificationProjection {
  return { recordVersion: "notification.v1", notificationId: "notification-1", roomId: "room-1",
    recipientActorId: "human-1", notificationKind: "human_request",
    source: { sourceKind: "project_request", sourceId: "request-1", sourceRevision: 1,
      sourceBoundaryId: "boundary-1", ordinal: 0 }, dedupeKey: "a".repeat(64), createdAt,
    readAt: null, readRevision: 0, handled: false, handledAt: null, sourceAccessible: true,
    deepLink: { kind: "request", targetId: "request-1" },
    safeProjection: { titleKey: "human_request", actorId: "human-2" }, ...overrides };
}
function ready(overrides: Partial<Extract<NotificationCenterRemoteState, { status: "ready" }>> = {}):
Extract<NotificationCenterRemoteState, { status: "ready" }> {
  return { status: "ready", recipientActorId: "human-1", notifications: [item()],
    roomBadges: [{ roomId: "room-1", unreadCount: 1, unhandledCount: 1 }],
    connection: { status: "online" }, operation: { status: "idle" }, page: { offset: 0, limit: 50 },
    ...overrides };
}

describe("FT-12 J-07 notification view model", () => {
  it("renders loading, complete empty and bounded flat pages", () => {
    expect(createNotificationCenterViewModel({ status: "loading", recipientActorId: "human-1" }).status)
      .toBe("loading");
    expect(createNotificationCenterViewModel(ready({ notifications: [], roomBadges: [] })).status).toBe("empty");
    const notifications = Array.from({ length: 70 }, (_, index) => item({ notificationId: `n-${index}`,
      dedupeKey: index.toString(16).padStart(64, "0") }));
    const vm = createNotificationCenterViewModel(ready({ notifications, page: { offset: 50, limit: 50 } }));
    expect(vm.items).toHaveLength(20); expect(vm.totalCount).toBe(70); expect(vm.hasPreviousPage).toBe(true);
  });

  it("keeps read and handled as independent non-colour states", () => {
    const vm = createNotificationCenterViewModel(ready({ notifications: [
      item(), item({ notificationId: "notification-2", readAt: createdAt, readRevision: 1 }),
      item({ notificationId: "notification-3", readAt: createdAt, readRevision: 1,
        handled: true, handledAt: createdAt }),
    ], roomBadges: [{ roomId: "room-1", unreadCount: 1, unhandledCount: 2 }] }));
    expect(vm.items.map(({ readLabel, handledLabel }) => [readLabel, handledLabel])).toEqual([
      ["未读", "未处理"], ["已读", "未处理"], ["已读", "已处理"],
    ]);
  });

  it("keeps multiple Rooms in one flat recipient list and marks recalled sources as tombstones", () => {
    const vm = createNotificationCenterViewModel(ready({ notifications: [item(), item({
      notificationId: "notification-2", roomId: "room-2", dedupeKey: "b".repeat(64),
    })], roomBadges: [
      { roomId: "room-1", unreadCount: 1, unhandledCount: 1 },
      { roomId: "room-2", unreadCount: 1, unhandledCount: 1 },
    ], sourceResolutions: [{ notificationId: "notification-2", status: "recalled" }] }));
    expect(vm.items.map(({ roomId }) => roomId)).toEqual(["room-1", "room-2"]);
    expect(vm.items[1]).toMatchObject({ sourceStatus: "recalled",
      sourceLabel: "来源已撤回，仅显示 tombstone" });
  });

  it("uses closed title keys and never invents source body/title/HTML", () => {
    const vm = createNotificationCenterViewModel(ready({ notifications: [item({
      notificationKind: "tool_confirmation", safeProjection: { titleKey: "tool_confirmation", actorId: "agent-1" },
      source: { sourceKind: "tool_confirmation", sourceId: "confirmation-1", sourceRevision: 1,
        sourceBoundaryId: "secret-looking-boundary", ordinal: 0 },
      deepLink: { kind: "confirmation", targetId: "confirmation-1" },
    })] }));
    expect(vm.items[0]?.title).toBe("Agent 请求工具确认");
    expect(JSON.stringify(vm.items[0])).not.toContain("confirmation-1:r1");
    expect(JSON.stringify(vm.items[0])).not.toContain("secret-looking-boundary");
  });

  it.each([401, 403, 409, 410, 429, 503] as const)("maps %s to a closed recovery without local success", (status) => {
    const vm = createNotificationCenterViewModel(ready({ operation: { status: "failed", requestId: "request-1",
      notificationId: "notification-1", error: { status, code: `error_${status}`,
        ...(status === 429 ? { retryAfterMs: 12_000 } : {}) } } }));
    expect(vm.operationAnnouncement).not.toBe("");
    expect(vm.recovery).toMatchObject({ status });
    if (status === 429) expect(vm.operationAnnouncement).toContain("12 秒");
  });

  it("hides recipient content on 401 and the affected item/Room badge on 403/410", () => {
    const unauthorized = createNotificationCenterViewModel(ready({ operation: { status: "failed",
      requestId: "request-1", notificationId: "notification-1", error: { status: 401, code: "unauthenticated" } } }));
    expect(unauthorized.items).toEqual([]); expect(unauthorized.roomBadges).toEqual([]);
    for (const status of [403, 410] as const) {
      const vm = createNotificationCenterViewModel(ready({ operation: { status: "failed", requestId: "read-op-1",
        notificationId: "notification-1", error: { status, code: "source_inaccessible" } } }));
      expect(vm.items).toEqual([]); expect(vm.roomBadges).toEqual([]);
      expect(JSON.stringify(vm)).not.toContain("request-1");
    }
  });

  it("keeps the old complete list offline/repairing/repair-failed and disables writes", () => {
    for (const connection of [
      { status: "offline" as const, asOf: createdAt },
      { status: "repairing" as const, watermark: 9 },
      { status: "repair_failed" as const, code: "checksum_mismatch" },
    ]) {
      const vm = createNotificationCenterViewModel(ready({ connection }));
      expect(vm.items).toHaveLength(1); expect(vm.writeDisabled).toBe(true);
    }
  });

  it("takes Room badge counts from the same replica projection and formats overflow accessibly", () => {
    const vm = createNotificationCenterViewModel(ready({ roomBadges: [
      { roomId: "room-1", unreadCount: 101, unhandledCount: 4 },
    ] }));
    expect(vm.roomBadges[0]).toMatchObject({ visibleUnreadCount: "99+", accessibleLabel: "Room room-1，101 条未读，4 条未处理" });
  });
});
