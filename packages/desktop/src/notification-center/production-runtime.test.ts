import { describe, expect, it, vi } from "vitest";
import type { NotificationProjection, NotificationStableEvent } from "@native-im/core";
import { createDesktopNotificationCenterRuntime } from "./production-runtime.js";

const now = "2026-08-31T08:00:00.000Z";
function projection(overrides: Partial<NotificationProjection> = {}): NotificationProjection {
  return { recordVersion: "notification.v1", notificationId: "notification-1", roomId: "room-1",
    recipientActorId: "human-1", notificationKind: "human_request",
    source: { sourceKind: "project_request", sourceId: "request-1", sourceRevision: 1,
      sourceBoundaryId: "request-1:1", ordinal: 0 }, dedupeKey: "a".repeat(64), createdAt: now,
    readAt: null, readRevision: 0, handled: false, handledAt: null, sourceAccessible: true,
    deepLink: { kind: "request", targetId: "request-1" },
    safeProjection: { titleKey: "human_request", actorId: "human-2" }, ...overrides };
}
function event(type: "notification.read" | "notification.handled", streamSeq: number): NotificationStableEvent {
  return { eventId: `event-${streamSeq}`, streamKind: "identity", streamId: "human-1", streamSeq,
    type, occurredAt: now, payload: projection(type === "notification.read"
      ? { readAt: now, readRevision: 1 } : { handled: true, handledAt: now }) };
}

describe("Desktop Notification Center production runtime", () => {
  it("buffers event-before-list, repairs the single Room cache, then commits event before publishing", async () => {
    let notificationListener: (event: NotificationStableEvent) => void = () => undefined;
    let identityListener: (event: { eventId: string; streamId: string; streamSeq: number }) => void =
      () => undefined;
    let terminalListener = () => undefined; let failureListener = () => undefined;
    const order: string[] = [];
    const transport = {
      notificationList: vi.fn(async (command: { requestId: string }) => ({
        type: "notification.list.result" as const, requestId: command.requestId,
        notifications: [projection()], roomBadges: [{ roomId: "room-1", unreadCount: 1,
          unhandledCount: 1 }], hasMore: false, identityWatermark: 4,
      })),
      notificationMarkRead: vi.fn(async (command: { requestId: string }) => ({
        type: "notification.read.ack" as const, requestId: command.requestId,
        notificationId: "notification-1", roomId: "room-1", recipientActorId: "human-1",
        outcome: "read" as const, readAt: now, readRevision: 1, eventId: "event-5",
      })),
      notificationResolveSource: vi.fn(async (command: { requestId: string }) => ({
        type: "notification.source.result" as const, requestId: command.requestId,
        projection: projection(),
      })),
      onNotificationEvent(listener: typeof notificationListener) { notificationListener = listener;
        return () => { notificationListener = () => undefined; }; },
      onPrincipalIdentityAdvance(listener: typeof identityListener) { identityListener = listener;
        return () => { identityListener = () => undefined; }; },
      onTerminalRevoked(listener: () => void) { terminalListener = listener;
        return () => { terminalListener = () => undefined; }; },
      onConnectionFailure(listener: () => void) { failureListener = listener;
        return () => { failureListener = () => undefined; }; },
    };
    const cache = {
      establishNotificationIdentityCursor: vi.fn((watermark: number) => order.push(`cursor:${watermark}`)),
      advanceNotificationIdentityCursor: vi.fn((value: { streamSeq: number }) => {
        order.push(`advance:${value.streamSeq}`); return "applied" as const;
      }),
      applyNotificationEvent: vi.fn((value: NotificationStableEvent) => {
        order.push(`event:${value.streamSeq}`); return "applied" as const;
      }),
      notificationProjections: () => [projection()], roomIds: () => ["room-1"],
      isOfflineReadAuthorized: () => true,
    };
    let sequence = 0;
    const runtime = createDesktopNotificationCenterRuntime({
      session: () => ({ actorId: "human-1", sessionId: "session-1", accessToken: "token",
        expiresAt: "2026-09-01T00:00:00.000Z" }), transport, cache,
      async restoreWorkspace() { order.push("repair");
        identityListener({ eventId: "identity-5", streamId: "human-1", streamSeq: 5 });
        notificationListener(event("notification.read", 6)); },
      createRequestId: (operation) => `${operation}-${++sequence}`, now: () => now,
    });
    const states: unknown[] = []; runtime.onStateChanged((state) => states.push(state));
    await expect(runtime.initialize()).resolves.toMatchObject({ status: "ready",
      connection: { status: "online" }, notifications: [{ readRevision: 1 }] });
    expect(order).toEqual(["repair", "cursor:4", "advance:5", "event:6"]);
    expect(states).toContainEqual(expect.objectContaining({ connection: { status: "repairing", watermark: 4 } }));

    const acked = await runtime.markRead({ notificationId: "notification-1", expectedReadRevision: 1 });
    expect(acked).toMatchObject({ operation: { status: "idle" } });
    expect(transport.notificationMarkRead).not.toHaveBeenCalled();
    await expect(runtime.resolveSource({ notificationId: "notification-1" })).resolves.toEqual({
      status: "available", notificationId: "notification-1", roomId: "room-1",
      deepLink: { kind: "request", targetId: "request-1" },
    });
    failureListener();
    await expect(runtime.getState()).resolves.toMatchObject({ connection: { status: "offline" } });
    await runtime.markRead({ notificationId: "notification-1", expectedReadRevision: 1 });
    expect(transport.notificationMarkRead).not.toHaveBeenCalled();
    terminalListener();
    await expect(runtime.getState()).resolves.toMatchObject({ status: "revoked" });
    runtime.close();
  });

  it("keeps read unchanged after ACK and changes only on the stable event", async () => {
    let notify: (event: NotificationStableEvent) => void = () => undefined;
    const transport = {
      notificationList: async (command: { requestId: string }) => ({ type: "notification.list.result" as const,
        requestId: command.requestId, notifications: [projection()], roomBadges: [{ roomId: "room-1",
          unreadCount: 1, unhandledCount: 1 }], hasMore: false, identityWatermark: 4 }),
      notificationMarkRead: async (command: { requestId: string }) => ({ type: "notification.read.ack" as const,
        requestId: command.requestId, notificationId: "notification-1", roomId: "room-1",
        recipientActorId: "human-1", outcome: "read" as const, readAt: now, readRevision: 1,
        eventId: "event-5" }),
      notificationResolveSource: vi.fn(),
      onNotificationEvent(listener: typeof notify) { notify = listener; return () => undefined; },
      onPrincipalIdentityAdvance: () => () => undefined,
      onTerminalRevoked: () => () => undefined, onConnectionFailure: () => () => undefined,
    };
    const cache = { establishNotificationIdentityCursor: vi.fn(),
      advanceNotificationIdentityCursor: vi.fn(() => "applied" as const),
      applyNotificationEvent: vi.fn(() => "applied" as const),
      notificationProjections: () => [], roomIds: () => ["room-1"], isOfflineReadAuthorized: () => true };
    let id = 0;
    const runtime = createDesktopNotificationCenterRuntime({ session: () => ({ actorId: "human-1",
      sessionId: "session-1", accessToken: "token", expiresAt: "2026-09-01T00:00:00.000Z" }),
    transport, cache, restoreWorkspace: async () => undefined,
    createRequestId: (kind) => `${kind}-${++id}` });
    await runtime.initialize();
    const acked = await runtime.markRead({ notificationId: "notification-1", expectedReadRevision: 0 });
    expect(acked).toMatchObject({ notifications: [{ readAt: null, readRevision: 0 }],
      operation: { status: "acknowledged", readRevision: 1 } });
    notify(event("notification.read", 5));
    await vi.waitFor(async () => expect(await runtime.getState()).toMatchObject({
      notifications: [{ readAt: now, readRevision: 1 }],
      roomBadges: [{ unreadCount: 0, unhandledCount: 1 }],
    }));
    runtime.close();
  });

  it("advances non-notification identity frames without a redundant Room repair", async () => {
    let notify: (event: NotificationStableEvent) => void = () => undefined;
    let advance: (event: { eventId: string; streamId: string; streamSeq: number }) => void = () => undefined;
    let listCount = 0;
    const transport = {
      notificationList: vi.fn(async (command: { requestId: string }) => {
        listCount += 1;
        return { type: "notification.list.result" as const, requestId: command.requestId,
          notifications: [projection({ readAt: listCount === 1 ? null : now,
            readRevision: listCount === 1 ? 0 : 1 })],
          roomBadges: [{ roomId: "room-1", unreadCount: listCount === 1 ? 1 : 0,
            unhandledCount: 1 }], hasMore: false, identityWatermark: listCount === 1 ? 4 : 6 };
      }),
      notificationMarkRead: vi.fn(), notificationResolveSource: vi.fn(),
      onNotificationEvent(listener: typeof notify) { notify = listener; return () => undefined; },
      onPrincipalIdentityAdvance(listener: typeof advance) { advance = listener; return () => undefined; },
      onTerminalRevoked: () => () => undefined, onConnectionFailure: () => () => undefined,
    };
    let durableCursor = 0;
    const cache = { establishNotificationIdentityCursor: vi.fn((value: number) => { durableCursor = value; }),
      advanceNotificationIdentityCursor: vi.fn((value: { streamSeq: number }) => {
        if (value.streamSeq !== durableCursor + 1) throw new Error("identity gap");
        durableCursor = value.streamSeq; return "applied" as const;
      }),
      applyNotificationEvent: vi.fn((value: NotificationStableEvent) => {
        if (value.streamSeq !== durableCursor + 1) throw new Error("identity gap");
        durableCursor = value.streamSeq; return "applied" as const;
      }), notificationProjections: () => [], roomIds: () => ["room-1"],
      isOfflineReadAuthorized: () => true };
    const restoreWorkspace = vi.fn(async () => undefined);
    let id = 0;
    const runtime = createDesktopNotificationCenterRuntime({ session: () => ({ actorId: "human-1",
      sessionId: "session-1", accessToken: "token", expiresAt: "2026-09-01T00:00:00.000Z" }),
    transport, cache, restoreWorkspace, createRequestId: (kind) => `${kind}-${++id}` });
    await runtime.initialize();
    advance({ eventId: "room-access-5", streamId: "human-1", streamSeq: 5 });
    notify(event("notification.read", 6));
    await vi.waitFor(async () => expect(await runtime.getState()).toMatchObject({
      notifications: [{ readRevision: 1 }], roomBadges: [{ unreadCount: 0 }],
    }));
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
    expect(transport.notificationList).toHaveBeenCalledTimes(1);
    runtime.close();
  });

  it("re-lists and Room-repairs when the principal identity stream has a real gap", async () => {
    let notify: (event: NotificationStableEvent) => void = () => undefined;
    let advance: (event: { eventId: string; streamId: string; streamSeq: number }) => void = () => undefined;
    let listCount = 0;
    const transport = {
      notificationList: vi.fn(async (command: { requestId: string }) => {
        listCount += 1;
        return { type: "notification.list.result" as const, requestId: command.requestId,
          notifications: [projection({ readAt: listCount === 1 ? null : now,
            readRevision: listCount === 1 ? 0 : 1 })],
          roomBadges: [{ roomId: "room-1", unreadCount: listCount === 1 ? 1 : 0,
            unhandledCount: 1 }], hasMore: false, identityWatermark: listCount === 1 ? 4 : 7 };
      }),
      notificationMarkRead: vi.fn(), notificationResolveSource: vi.fn(),
      onNotificationEvent(listener: typeof notify) { notify = listener; return () => undefined; },
      onPrincipalIdentityAdvance(listener: typeof advance) { advance = listener; return () => undefined; },
      onTerminalRevoked: () => () => undefined, onConnectionFailure: () => () => undefined,
    };
    let durableCursor = 0;
    const cache = { establishNotificationIdentityCursor: vi.fn((value: number) => { durableCursor = value; }),
      advanceNotificationIdentityCursor: vi.fn((value: { streamSeq: number }) => {
        if (value.streamSeq !== durableCursor + 1) throw new Error("identity gap");
        durableCursor = value.streamSeq; return "applied" as const;
      }),
      applyNotificationEvent: vi.fn((value: NotificationStableEvent) => {
        if (value.streamSeq !== durableCursor + 1) throw new Error("identity gap");
        durableCursor = value.streamSeq; return "applied" as const;
      }), notificationProjections: () => [], roomIds: () => ["room-1"],
      isOfflineReadAuthorized: () => true };
    const restoreWorkspace = vi.fn(async () => undefined);
    let id = 0;
    const runtime = createDesktopNotificationCenterRuntime({ session: () => ({ actorId: "human-1",
      sessionId: "session-1", accessToken: "token", expiresAt: "2026-09-01T00:00:00.000Z" }),
    transport, cache, restoreWorkspace, createRequestId: (kind) => `${kind}-${++id}` });
    await runtime.initialize();
    advance({ eventId: "room-access-5", streamId: "human-1", streamSeq: 5 });
    notify(event("notification.read", 7)); // seq 6 was not delivered on this transport.
    await vi.waitFor(() => expect(restoreWorkspace).toHaveBeenCalledTimes(2));
    await expect(runtime.getState()).resolves.toMatchObject({ connection: { status: "online" },
      notifications: [{ readRevision: 1 }], roomBadges: [{ unreadCount: 0 }] });
    expect(transport.notificationList).toHaveBeenCalledTimes(2);
    runtime.close();
  });

  it("uses hasMore for bounded paging and preserves complete authority Room badges", async () => {
    let page = 0;
    const second = projection({ notificationId: "notification-2", roomId: "room-2",
      dedupeKey: "b".repeat(64), createdAt: "2026-08-31T07:00:00.000Z" });
    const transport = {
      notificationList: vi.fn(async (command: { requestId: string }) => {
        page += 1;
        return { type: "notification.list.result" as const, requestId: command.requestId,
          notifications: page === 1 ? [projection()] : [second],
          roomBadges: page === 1
            ? [{ roomId: "room-1", unreadCount: 8, unhandledCount: 3 },
              { roomId: "room-2", unreadCount: 5, unhandledCount: 2 }]
            : [{ roomId: "room-1", unreadCount: 7, unhandledCount: 3 },
              { roomId: "room-2", unreadCount: 4, unhandledCount: 2 }],
          hasMore: page === 1, identityWatermark: 4 };
      }),
      notificationMarkRead: vi.fn(), notificationResolveSource: vi.fn(),
      onNotificationEvent: () => () => undefined,
      onPrincipalIdentityAdvance: () => () => undefined,
      onTerminalRevoked: () => () => undefined, onConnectionFailure: () => () => undefined,
    };
    const cache = { establishNotificationIdentityCursor: vi.fn(),
      advanceNotificationIdentityCursor: vi.fn(() => "applied" as const),
      applyNotificationEvent: vi.fn(() => "applied" as const), notificationProjections: () => [],
      roomIds: () => ["room-1", "room-2"], isOfflineReadAuthorized: () => true };
    let id = 0;
    const runtime = createDesktopNotificationCenterRuntime({ session: () => ({ actorId: "human-1",
      sessionId: "session-1", accessToken: "token", expiresAt: "2026-09-01T00:00:00.000Z" }),
    transport, cache, restoreWorkspace: async () => undefined,
    createRequestId: (kind) => `${kind}-${++id}` });
    await expect(runtime.initialize()).resolves.toMatchObject({ hasMore: true,
      notifications: [{ notificationId: "notification-1" }],
      roomBadges: [{ roomId: "room-1", unreadCount: 8 }, { roomId: "room-2", unreadCount: 5 }] });
    await expect(runtime.list({ roomId: null, before: { createdAt: second.createdAt,
      notificationId: second.notificationId }, limit: 50 })).resolves.toMatchObject({ hasMore: false,
      notifications: [{ notificationId: "notification-1" }, { notificationId: "notification-2" }],
      roomBadges: [{ roomId: "room-1", unreadCount: 7 }, { roomId: "room-2", unreadCount: 4 }] });
    runtime.close();
  });

  it("retains a stable update for a page-one row while page two advances its watermark", async () => {
    let notify: (event: NotificationStableEvent) => void = () => undefined;
    let resolvePage!: (value: {
      type: "notification.list.result"; requestId: string;
      notifications: readonly NotificationProjection[];
      roomBadges: readonly { roomId: string; unreadCount: number; unhandledCount: number }[];
      hasMore: boolean; identityWatermark: number;
    }) => void;
    const pageTwo = new Promise<Parameters<typeof resolvePage>[0]>((resolve) => { resolvePage = resolve; });
    let calls = 0;
    const second = projection({ notificationId: "notification-2", dedupeKey: "b".repeat(64),
      createdAt: "2026-08-31T07:00:00.000Z" });
    const transport = {
      notificationList: vi.fn(async (command: { requestId: string }) => {
        calls += 1;
        if (calls === 1) return { type: "notification.list.result" as const,
          requestId: command.requestId, notifications: [projection()],
          roomBadges: [{ roomId: "room-1", unreadCount: 2, unhandledCount: 2 }],
          hasMore: true, identityWatermark: 4 };
        return pageTwo;
      }),
      notificationMarkRead: vi.fn(), notificationResolveSource: vi.fn(),
      onNotificationEvent(listener: typeof notify) { notify = listener; return () => undefined; },
      onPrincipalIdentityAdvance: () => () => undefined,
      onTerminalRevoked: () => () => undefined, onConnectionFailure: () => () => undefined,
    };
    let durableCursor = 0;
    const cache = { establishNotificationIdentityCursor: vi.fn((seq: number) => { durableCursor = seq; }),
      advanceNotificationIdentityCursor: vi.fn(() => "applied" as const),
      applyNotificationEvent: vi.fn((value: NotificationStableEvent) => {
        expect(value.streamSeq).toBe(durableCursor + 1); durableCursor = value.streamSeq;
        return "applied" as const;
      }), notificationProjections: () => [], roomIds: () => ["room-1"],
      isOfflineReadAuthorized: () => true };
    let id = 0;
    const runtime = createDesktopNotificationCenterRuntime({ session: () => ({ actorId: "human-1",
      sessionId: "session-1", accessToken: "token", expiresAt: "2026-09-01T00:00:00.000Z" }),
    transport, cache, restoreWorkspace: async () => undefined,
    createRequestId: (kind) => `${kind}-${++id}` });
    await runtime.initialize();
    const loadingPage = runtime.list({ roomId: null, before: { createdAt: projection().createdAt,
      notificationId: "notification-1" }, limit: 50 });
    await vi.waitFor(() => expect(transport.notificationList).toHaveBeenCalledTimes(2));
    notify(event("notification.read", 5));
    resolvePage({ type: "notification.list.result", requestId: "list-2", notifications: [second],
      roomBadges: [{ roomId: "room-1", unreadCount: 1, unhandledCount: 2 }],
      hasMore: false, identityWatermark: 5 });
    await expect(loadingPage).resolves.toMatchObject({
      notifications: [{ notificationId: "notification-1", readRevision: 1 },
        { notificationId: "notification-2", readRevision: 0 }],
      roomBadges: [{ roomId: "room-1", unreadCount: 1, unhandledCount: 2 }],
    });
    expect(cache.applyNotificationEvent).toHaveBeenCalledWith(expect.objectContaining({ streamSeq: 5 }));
    runtime.close();
  });

  it("Room-repairs immediately when an appended page watermark exposes an inter-page gap", async () => {
    const pageOne = projection();
    const pageTwo = projection({ notificationId: "notification-2", dedupeKey: "b".repeat(64),
      createdAt: "2026-08-31T07:00:00.000Z" });
    let calls = 0;
    const transport = {
      notificationList: vi.fn(async (command: { requestId: string }) => {
        calls += 1;
        if (calls === 1) return { type: "notification.list.result" as const,
          requestId: command.requestId, notifications: [pageOne],
          roomBadges: [{ roomId: "room-1", unreadCount: 2, unhandledCount: 2 }],
          hasMore: true, identityWatermark: 4 };
        if (calls === 2) return { type: "notification.list.result" as const,
          requestId: command.requestId, notifications: [pageTwo],
          roomBadges: [{ roomId: "room-1", unreadCount: 1, unhandledCount: 2 }],
          hasMore: false, identityWatermark: 6 };
        return { type: "notification.list.result" as const,
          requestId: command.requestId,
          notifications: [projection({ readAt: now, readRevision: 1 }), pageTwo],
          roomBadges: [{ roomId: "room-1", unreadCount: 1, unhandledCount: 2 }],
          hasMore: false, identityWatermark: 6 };
      }),
      notificationMarkRead: vi.fn(), notificationResolveSource: vi.fn(),
      onNotificationEvent: () => () => undefined,
      onPrincipalIdentityAdvance: () => () => undefined,
      onTerminalRevoked: () => () => undefined, onConnectionFailure: () => () => undefined,
    };
    const cache = { establishNotificationIdentityCursor: vi.fn(),
      advanceNotificationIdentityCursor: vi.fn(() => "applied" as const),
      applyNotificationEvent: vi.fn(() => "applied" as const), notificationProjections: () => [],
      roomIds: () => ["room-1"], isOfflineReadAuthorized: () => true };
    const restoreWorkspace = vi.fn(async () => undefined);
    let id = 0;
    const runtime = createDesktopNotificationCenterRuntime({ session: () => ({ actorId: "human-1",
      sessionId: "session-1", accessToken: "token", expiresAt: "2026-09-01T00:00:00.000Z" }),
    transport, cache, restoreWorkspace, createRequestId: (kind) => `${kind}-${++id}` });
    await runtime.initialize();
    await expect(runtime.list({ roomId: null, before: { createdAt: pageOne.createdAt,
      notificationId: pageOne.notificationId }, limit: 50 })).resolves.toMatchObject({
      notifications: [{ notificationId: "notification-1", readRevision: 1 },
        { notificationId: "notification-2" }],
      connection: { status: "online" },
    });
    expect(transport.notificationList).toHaveBeenCalledTimes(3);
    expect(restoreWorkspace).toHaveBeenCalledTimes(2);
    runtime.close();
  });
});
