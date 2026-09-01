import { describe, expect, it } from "vitest";
import type { NotificationProjection, NotificationStableEvent } from "@native-im/core";
import {
  applyNotificationEvent,
  advanceNotificationIdentityCursor,
  beginNotificationRepair,
  commitNotificationRepair,
  createNotificationReplica,
  failNotificationRepair,
  installNotificationListBootstrap,
  markNotificationReplicaOffline,
  stageNotificationRepairPage,
  stageNotificationRepairRecord,
} from "./replica.js";

const createdAt = "2026-08-31T08:00:00.000Z";
function projection(overrides: Partial<NotificationProjection> = {}): NotificationProjection {
  return {
    recordVersion: "notification.v1",
    notificationId: "notification-1",
    roomId: "room-1",
    recipientActorId: "human-1",
    notificationKind: "human_request",
    source: { sourceKind: "project_request", sourceId: "request-1", sourceRevision: 1,
      sourceBoundaryId: "request-1:r1", ordinal: 0 },
    dedupeKey: "a".repeat(64),
    createdAt,
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
function event(type: NotificationStableEvent["type"], value = projection(), streamSeq = 1): NotificationStableEvent {
  if (type === "notification.revoked") {
    return { type, eventId: `event-${streamSeq}`, streamKind: "identity", streamId: "human-1",
      streamSeq, occurredAt: createdAt,
      payload: { notificationId: value.notificationId, roomId: value.roomId,
        recipientActorId: value.recipientActorId, reason: "source_inaccessible" } };
  }
  return { type, eventId: `event-${streamSeq}`, streamKind: "identity", streamId: "human-1",
    streamSeq, occurredAt: createdAt, payload: value };
}

describe("FT-12 recipient notification replica", () => {
  it("installs list projection only with its independent identity watermark", () => {
    const initial = createNotificationReplica("human-1");
    const bootstrapped = installNotificationListBootstrap(initial, {
      identityWatermark: 8,
      notifications: [projection()],
    });
    expect(bootstrapped.afterSeq).toBe(8);
    expect(bootstrapped.notifications).toHaveLength(1);
    expect(bootstrapped.roomBadges).toEqual([{ roomId: "room-1", unreadCount: 1,
      unhandledCount: 1 }]);
    expect(() => installNotificationListBootstrap(bootstrapped, {
      identityWatermark: 7, notifications: [],
    })).toThrowError("revision_regression");
  });

  it("advances the identity cursor for an event outside the bounded visible page", () => {
    const bootstrapped = installNotificationListBootstrap(createNotificationReplica("human-1"), {
      identityWatermark: 8, notifications: [projection()],
    });
    const outside = event("notification.read", projection({ notificationId: "notification-2",
      dedupeKey: "b".repeat(64), readAt: createdAt, readRevision: 1 }), 9);
    const advanced = advanceNotificationIdentityCursor(bootstrapped, outside);
    expect(advanced.afterSeq).toBe(9);
    expect(advanced.notifications).toEqual(bootstrapped.notifications);
  });

  it("converges two sessions from the same stable read and handled events", () => {
    let mac = createNotificationReplica("human-1");
    let imac = createNotificationReplica("human-1");
    const created = event("notification.created");
    mac = applyNotificationEvent(mac, created); imac = applyNotificationEvent(imac, created);
    const read = event("notification.read", projection({ readAt: createdAt, readRevision: 1 }), 2);
    mac = applyNotificationEvent(mac, read);
    expect(mac.notifications[0]).toMatchObject({ readRevision: 1, handled: false });
    expect(imac.notifications[0]).toMatchObject({ readRevision: 0, handled: false });
    imac = applyNotificationEvent(imac, read);
    const handled = event("notification.handled", projection({ readAt: createdAt, readRevision: 1,
      handled: true, handledAt: "2026-08-31T08:02:00.000Z" }), 3);
    mac = applyNotificationEvent(mac, handled); imac = applyNotificationEvent(imac, handled);
    expect(mac.notifications).toEqual(imac.notifications);
    expect(mac.roomBadges).toEqual([{ roomId: "room-1", unreadCount: 0, unhandledCount: 0 }]);
  });

  it("uses eventId/streamSeq exact replay, rejects conflicts and never regresses read", () => {
    const replica = applyNotificationEvent(createNotificationReplica("human-1"),
      event("notification.created"));
    expect(applyNotificationEvent(replica, event("notification.created"))).toBe(replica);
    expect(() => applyNotificationEvent(replica, { ...event("notification.created"), streamSeq: 2 }))
      .toThrow(/event_conflict/);
    expect(() => applyNotificationEvent(replica, event("notification.read",
      projection({ readAt: createdAt, readRevision: 1 }), 3))).toThrow(/event_gap/);
    const read = applyNotificationEvent(replica, event("notification.read",
      projection({ readAt: createdAt, readRevision: 1 }), 2));
    expect(() => applyNotificationEvent(read, event("notification.read", projection(), 3)))
      .toThrow(/revision_regression/);
  });

  it("removes revoked notifications without retaining source metadata or badges", () => {
    const created = applyNotificationEvent(createNotificationReplica("human-1"),
      event("notification.created"));
    const revoked = applyNotificationEvent(created, event("notification.revoked", projection(), 2));
    expect(revoked.notifications).toEqual([]);
    expect(revoked.roomBadges).toEqual([]);
    expect(JSON.stringify(revoked)).not.toContain("request-1");
  });

  it("keeps the old complete projection through repair failure and flips only a complete repair", () => {
    const old = applyNotificationEvent(createNotificationReplica("human-1"),
      event("notification.created"));
    let repairing = beginNotificationRepair(old, { snapshotId: "snapshot-1", watermark: 10, generation: 2 });
    repairing = stageNotificationRepairRecord(repairing, "snapshot-1", {
      kind: "notification", value: projection({ notificationId: "notification-2",
        source: { sourceKind: "tool_confirmation", sourceId: "confirmation-1", sourceRevision: 2,
          sourceBoundaryId: "confirmation-1:r2", ordinal: 0 },
        notificationKind: "tool_confirmation", deepLink: { kind: "confirmation", targetId: "confirmation-1" },
        safeProjection: { titleKey: "tool_confirmation", actorId: "agent-1" }, dedupeKey: "b".repeat(64) }),
    });
    expect(repairing.notifications[0]?.notificationId).toBe("notification-1");
    const failed = failNotificationRepair(repairing, { snapshotId: "snapshot-1", authorization: "retained" });
    expect(failed.notifications[0]?.notificationId).toBe("notification-1");
    repairing = stageNotificationRepairRecord(beginNotificationRepair(old,
      { snapshotId: "snapshot-2", watermark: 10, generation: 2 }), "snapshot-2", {
      kind: "notification", value: projection({ notificationId: "notification-2", dedupeKey: "b".repeat(64) }),
    });
    const committed = commitNotificationRepair(repairing,
      { snapshotId: "snapshot-2", watermark: 10, generation: 2 });
    expect(committed.notifications.map((item) => item.notificationId)).toEqual(["notification-2"]);
    expect(committed.afterSeq).toBe(10);
  });

  it("lets authorization revocation preempt repair and purge live plus staging projections", () => {
    const old = applyNotificationEvent(createNotificationReplica("human-1"),
      event("notification.created"));
    const repairing = stageNotificationRepairRecord(beginNotificationRepair(old,
      { snapshotId: "snapshot-revoked", watermark: 10, generation: 2 }), "snapshot-revoked", {
      kind: "notification", value: projection({ notificationId: "notification-staging",
        dedupeKey: "c".repeat(64) }),
    });
    const locked = failNotificationRepair(repairing,
      { snapshotId: "snapshot-revoked", authorization: "revoked" });
    expect(locked.mode).toBe("locked"); expect(locked.notifications).toEqual([]);
    expect(locked.repair).toBeUndefined(); expect(JSON.stringify(locked)).not.toContain("request-1");
  });

  it("is read-only offline and accepts no stable mutation until reconnect", () => {
    const online = applyNotificationEvent(createNotificationReplica("human-1"),
      event("notification.created"));
    const offline = markNotificationReplicaOffline(online, createdAt);
    expect(offline.mode).toBe("offline-read-only");
    expect(offline.notifications).toEqual(online.notifications);
    expect(() => applyNotificationEvent(offline, event("notification.read",
      projection({ readAt: createdAt, readRevision: 1 }), 2))).toThrow(/room_read_only/);
    const failed = failNotificationRepair(beginNotificationRepair(offline,
      { snapshotId: "snapshot-offline", watermark: 9, generation: 2 }),
    { snapshotId: "snapshot-offline", authorization: "retained" });
    expect(failed.mode).toBe("offline-read-only");
  });

  it("handles 10k bounded projections without changing canonical order", () => {
    const records = Array.from({ length: 10_000 }, (_, index) => ({
      kind: "notification" as const,
      value: projection({ notificationId: `notification-${String(index).padStart(5, "0")}`,
        roomId: `room-${index % 4}`, dedupeKey: index.toString(16).padStart(64, "0"),
        createdAt: new Date(Date.parse(createdAt) + index).toISOString() }),
    }));
    let replica = beginNotificationRepair(createNotificationReplica("human-1"),
      { snapshotId: "snapshot-capacity", watermark: 10_000, generation: 2 });
    replica = stageNotificationRepairPage(replica, "snapshot-capacity", records);
    const committed = commitNotificationRepair(replica,
      { snapshotId: "snapshot-capacity", watermark: 10_000, generation: 2 });
    expect(committed.notifications).toHaveLength(10_000);
    expect(committed.notifications[0]?.notificationId).toBe("notification-09999");
    expect(committed.notifications.at(-1)?.notificationId).toBe("notification-00000");
  });
});
