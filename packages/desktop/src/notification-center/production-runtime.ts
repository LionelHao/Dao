import type { NotificationProjection, NotificationStableEvent } from "@native-im/core";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import type { DesktopAuthorityCache } from "../governance/authority-cache.js";
import {
  MessageAuthorityTransportError,
  type MessageAuthorityWireTransport,
  type PrincipalIdentityCursorAdvance,
} from "../message-authority/websocket-authority.js";
import type {
  NotificationCenterConnection,
  NotificationCenterRemoteState,
  NotificationOperation,
} from "../renderer/notification-center/view-model.js";
import {
  advanceNotificationIdentityCursor,
  applyNotificationEvent,
  createNotificationReplica,
  installNotificationListBootstrap,
  type NotificationReplica,
  type NotificationRoomBadgeProjection,
} from "./replica.js";
import type {
  NotificationCenterBridge,
  NotificationClosedError,
  NotificationListQuery,
  NotificationMarkReadIntent,
  NotificationResolveSourceIntent,
  NotificationSourceResolution,
} from "./contracts.js";

const MAX_BUFFERED_EVENTS = 1_024;
const MAX_VISIBLE_NOTIFICATIONS = 10_000;
type BufferedIdentityEvent = NotificationStableEvent | PrincipalIdentityCursorAdvance;

function isNotificationEvent(event: BufferedIdentityEvent): event is NotificationStableEvent {
  return "type" in event;
}

function sameImmutableProjection(
  left: NotificationProjection,
  right: NotificationProjection,
): boolean {
  return left.recordVersion === right.recordVersion && left.notificationId === right.notificationId &&
    left.roomId === right.roomId && left.recipientActorId === right.recipientActorId &&
    left.notificationKind === right.notificationKind && left.dedupeKey === right.dedupeKey &&
    left.createdAt === right.createdAt && left.sourceAccessible === right.sourceAccessible &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    JSON.stringify(left.deepLink) === JSON.stringify(right.deepLink) &&
    JSON.stringify(left.safeProjection) === JSON.stringify(right.safeProjection);
}

function alreadyProjected(
  existing: NotificationProjection | undefined,
  event: NotificationStableEvent,
): boolean {
  if (event.type === "notification.revoked") return existing === undefined;
  if (existing === undefined || !sameImmutableProjection(existing, event.payload)) return false;
  if (event.type === "notification.created") return JSON.stringify(existing) === JSON.stringify(event.payload);
  if (event.type === "notification.read") {
    return existing.readAt !== null && existing.readRevision >= event.payload.readRevision &&
      (!event.payload.handled || existing.handled);
  }
  return existing.handled && existing.handledAt !== null &&
    existing.readRevision >= event.payload.readRevision;
}

function deriveBadges(values: readonly NotificationProjection[]): readonly NotificationRoomBadgeProjection[] {
  const badges = new Map<string, { unreadCount: number; unhandledCount: number }>();
  for (const value of values) {
    const badge = badges.get(value.roomId) ?? { unreadCount: 0, unhandledCount: 0 };
    if (value.readAt === null) badge.unreadCount += 1;
    if (!value.handled) badge.unhandledCount += 1;
    badges.set(value.roomId, badge);
  }
  return [...badges].sort(([left], [right]) => left.localeCompare(right))
    .map(([roomId, badge]) => ({ roomId, ...badge }));
}

function closedError(error: unknown): NotificationClosedError {
  if (error instanceof MessageAuthorityTransportError && error.notificationError !== undefined) {
    return error.notificationError;
  }
  if (error instanceof MessageAuthorityTransportError && error.code === "authentication_required" ||
      error instanceof MessageAuthorityTransportError && error.code === "session_revoked") {
    return { status: 401, code: "authentication_required" };
  }
  if (error instanceof MessageAuthorityTransportError && error.code === "access_revoked") {
    return { status: 403, code: "notification_forbidden" };
  }
  return { status: 503, code: "storage_unavailable" };
}

function adjustBadges(
  badges: readonly NotificationRoomBadgeProjection[],
  event: Exclude<NotificationStableEvent, { type: "notification.revoked" }>,
): readonly NotificationRoomBadgeProjection[] {
  const result = new Map(badges.map((badge) => [badge.roomId, { ...badge }]));
  const current = result.get(event.payload.roomId) ?? { roomId: event.payload.roomId,
    unreadCount: 0, unhandledCount: 0 };
  if (event.type === "notification.created") {
    if (event.payload.readAt === null) current.unreadCount += 1;
    if (!event.payload.handled) current.unhandledCount += 1;
  } else if (event.type === "notification.read") {
    current.unreadCount = Math.max(0, current.unreadCount - 1);
  } else {
    current.unhandledCount = Math.max(0, current.unhandledCount - 1);
  }
  result.set(current.roomId, current);
  return [...result.values()].sort((left, right) => left.roomId.localeCompare(right.roomId));
}

export interface DesktopNotificationCenterRuntime extends NotificationCenterBridge {
  initialize(): Promise<NotificationCenterRemoteState>;
  invalidateAuthorizedState(reason?: "session_revoked" | "membership_revoked" | "lease_expired"): void;
  close(): void;
}

export function createDesktopNotificationCenterRuntime(options: Readonly<{
  session(): IdentityAuthoritySession | undefined;
  transport: Pick<MessageAuthorityWireTransport,
    "notificationList" | "notificationMarkRead" | "notificationResolveSource" |
    "onPrincipalIdentityAdvance" | "onNotificationEvent" | "onTerminalRevoked" |
    "onConnectionFailure">;
  cache: Pick<DesktopAuthorityCache,
    "advanceNotificationIdentityCursor" | "applyNotificationEvent" |
    "establishNotificationIdentityCursor" |
    "notificationProjections" | "roomIds" | "isOfflineReadAuthorized">;
  restoreWorkspace(): Promise<void>;
  createRequestId(operation: "list" | "read" | "source"): string;
  now?: () => string;
}>): DesktopNotificationCenterRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<(state: NotificationCenterRemoteState) => void>();
  const buffered: BufferedIdentityEvent[] = [];
  let replica: NotificationReplica | undefined;
  let badges: readonly NotificationRoomBadgeProjection[] = [];
  let badgesThroughSeq = 0;
  let state: NotificationCenterRemoteState = { status: "loading", recipientActorId: "unavailable" };
  let sourceResolutions = new Map<string, "available" | "recalled">();
  let operation: NotificationOperation = { status: "idle" };
  let hasMore = false;
  let synchronizing: Promise<NotificationCenterRemoteState> | undefined;
  let visibleRequest = false;
  let cacheReady = false;
  let closed = false;
  let eventWork = Promise.resolve();

  const publish = (next: NotificationCenterRemoteState): NotificationCenterRemoteState => {
    state = structuredClone(next);
    for (const listener of [...listeners]) {
      try { listener(structuredClone(state)); } catch { /* observers cannot alter authority state */ }
    }
    return structuredClone(state);
  };
  const ready = (connection: NotificationCenterConnection,
    page = { offset: 0, limit: 50 }): NotificationCenterRemoteState => {
    const session = options.session();
    if (session === undefined || replica === undefined) {
      return { status: "revoked", recipientActorId: session?.actorId ?? "unavailable",
        reason: "session_revoked" };
    }
    return { status: "ready", recipientActorId: session.actorId,
      notifications: replica.notifications, roomBadges: badges,
      sourceResolutions: [...sourceResolutions].map(([notificationId, status]) => ({ notificationId, status })),
      connection, operation, hasMore, page };
  };
  const buffer = (event: BufferedIdentityEvent): void => {
    if (buffered.some((item) => item.eventId === event.eventId && item.streamSeq === event.streamSeq)) return;
    if (buffered.length >= MAX_BUFFERED_EVENTS) {
      buffered.length = 0;
      void synchronize(true);
      return;
    }
    buffered.push(structuredClone(event));
  };
  const applyVisible = (event: NotificationStableEvent): void => {
    if (replica === undefined || event.streamSeq <= replica.afterSeq) return;
    const existing = replica.notifications.find((value) =>
      value.notificationId === event.payload.notificationId);
    if (alreadyProjected(existing, event)) {
      replica = advanceNotificationIdentityCursor(replica, event);
    } else if (event.type === "notification.created" || existing !== undefined) {
      replica = applyNotificationEvent(replica, event);
    } else {
      replica = advanceNotificationIdentityCursor(replica, event);
    }
    if (event.streamSeq > badgesThroughSeq && event.type !== "notification.revoked") {
      badges = adjustBadges(badges, event);
    }
    badgesThroughSeq = Math.max(badgesThroughSeq, event.streamSeq);
  };
  const drain = (): void => {
    if (replica === undefined) return;
    const values = buffered.splice(0).sort((left, right) => left.streamSeq - right.streamSeq);
    const seen = new Set<string>();
    for (const event of values) {
      if (seen.has(event.eventId) || event.streamSeq <= replica.afterSeq) continue;
      seen.add(event.eventId);
      if (isNotificationEvent(event)) {
        if (cacheReady) options.cache.applyNotificationEvent(event);
        applyVisible(event);
      } else {
        if (cacheReady) options.cache.advanceNotificationIdentityCursor(event);
        replica = advanceNotificationIdentityCursor(replica, event);
        badgesThroughSeq = Math.max(badgesThroughSeq, event.streamSeq);
      }
    }
  };
  const offlineState = (actorId: string): NotificationCenterRemoteState | undefined => {
    const roomIds = options.cache.roomIds();
    if (roomIds.length === 0 || roomIds.some((roomId) => !options.cache.isOfflineReadAuthorized(roomId))) {
      return undefined;
    }
    const notifications = options.cache.notificationProjections(actorId);
    replica = installNotificationListBootstrap(createNotificationReplica(actorId), {
      identityWatermark: 0, notifications,
    });
    badges = deriveBadges(notifications);
    badgesThroughSeq = 0;
    hasMore = false;
    cacheReady = true;
    return ready({ status: "offline", asOf: now() });
  };

  const fetchPage = async (query: NotificationListQuery, append: boolean): Promise<number> => {
    const session = options.session();
    if (session === undefined) throw new MessageAuthorityTransportError("authentication_required");
    const requestId = options.createRequestId("list");
    const result = await options.transport.notificationList({ type: "notification.list", requestId,
      ...query });
    if (result.requestId !== requestId || result.notifications.some((value) =>
      value.recipientActorId !== session.actorId)) {
      throw new MessageAuthorityTransportError("protocol_error");
    }
    const priorReplica = append ? replica : undefined;
    const prior = priorReplica?.notifications ?? [];
    const combined = [...prior, ...result.notifications];
    if (combined.length > MAX_VISIBLE_NOTIFICATIONS ||
        new Set(combined.map((value) => value.notificationId)).size !== combined.length ||
        priorReplica !== undefined && result.identityWatermark < priorReplica.afterSeq) {
      throw new MessageAuthorityTransportError("protocol_error");
    }
    replica = installNotificationListBootstrap(createNotificationReplica(session.actorId), {
      // A later page is not a replacement snapshot for retained rows. Keep the
      // delivered identity cursor and drain every inter-page stable event before
      // advancing it; the page watermark is authoritative for badges only.
      identityWatermark: priorReplica?.afterSeq ?? result.identityWatermark,
      notifications: combined,
    });
    badges = structuredClone(result.roomBadges);
    badgesThroughSeq = result.identityWatermark;
    hasMore = result.hasMore;
    return result.identityWatermark;
  };

  const synchronizeOnce = async (): Promise<NotificationCenterRemoteState> => {
    const session = options.session();
    if (session === undefined) return publish({ status: "revoked", recipientActorId: "unavailable",
      reason: "session_revoked" });
    cacheReady = false;
    visibleRequest = true;
    try {
      await fetchPage({ roomId: null, before: null, limit: 50 }, false);
      publish(ready({ status: "repairing", watermark: replica!.afterSeq }));
      await options.restoreWorkspace();
      options.cache.establishNotificationIdentityCursor(replica!.afterSeq);
      cacheReady = true;
      drain();
      operation = { status: "idle" };
      return publish(ready({ status: "online" }));
    } finally {
      visibleRequest = false;
    }
  };

  function synchronize(force: boolean): Promise<NotificationCenterRemoteState> {
    if (closed) return Promise.reject(new Error("Notification Center runtime is closed"));
    if (synchronizing !== undefined) return synchronizing;
    void force;
    const operationPromise = (async () => {
      let last: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await synchronizeOnce(); }
        catch (error: unknown) { last = error; buffered.length = 0; }
      }
      const session = options.session();
      if (session !== undefined) {
        const offline = offlineState(session.actorId);
        if (offline !== undefined) return publish(offline);
      }
      if (replica !== undefined && session !== undefined) {
        return publish(ready({ status: "repair_failed", code: closedError(last).code }));
      }
      return publish({ status: "revoked", recipientActorId: session?.actorId ?? "unavailable",
        reason: "lease_expired" });
    })().finally(() => {
      if (synchronizing === operationPromise) synchronizing = undefined;
    });
    synchronizing = operationPromise;
    return operationPromise;
  }

  const applyIncoming = async (event: NotificationStableEvent): Promise<void> => {
    if (closed || event.streamId !== options.session()?.actorId) return;
    if (visibleRequest || replica === undefined || !cacheReady) { buffer(event); return; }
    try {
      options.cache.applyNotificationEvent(event);
      if (event.type === "notification.revoked") {
        sourceResolutions.delete(event.payload.notificationId);
        await synchronize(false);
        return;
      }
      applyVisible(event);
      publish(ready({ status: "online" }));
    } catch {
      buffer(event);
      await synchronize(false);
    }
  };

  const advanceIncoming = async (event: PrincipalIdentityCursorAdvance): Promise<void> => {
    if (closed || event.streamId !== options.session()?.actorId) return;
    if (visibleRequest || replica === undefined || !cacheReady) { buffer(event); return; }
    try {
      options.cache.advanceNotificationIdentityCursor(event);
      replica = advanceNotificationIdentityCursor(replica, event);
      badgesThroughSeq = Math.max(badgesThroughSeq, event.streamSeq);
    } catch {
      buffer(event);
      await synchronize(false);
    }
  };

  const unsubscribeIdentityAdvance = options.transport.onPrincipalIdentityAdvance((event) => {
    if (visibleRequest || replica === undefined || !cacheReady) { buffer(event); return; }
    eventWork = eventWork.then(() => advanceIncoming(event));
    void eventWork.catch(() => undefined);
  });
  const unsubscribeNotification = options.transport.onNotificationEvent((event) => {
    if (visibleRequest || replica === undefined || !cacheReady) { buffer(event); return; }
    eventWork = eventWork.then(() => applyIncoming(event));
    void eventWork.catch(() => undefined);
  });
  const unsubscribeTerminal = options.transport.onTerminalRevoked(() => {
    runtime.invalidateAuthorizedState("session_revoked");
  });
  const unsubscribeFailure = options.transport.onConnectionFailure(() => {
    const session = options.session();
    if (session === undefined) return;
    const offline = offlineState(session.actorId);
    if (offline !== undefined) publish(offline);
  });

  const runtime: DesktopNotificationCenterRuntime = {
    initialize: () => synchronize(false),
    getState: async () => state.status === "loading" ? synchronize(false) : structuredClone(state),
    async list(query) {
      if (state.status !== "ready" || state.connection.status !== "online") return structuredClone(state);
      visibleRequest = true;
      try {
        const pageWatermark = await fetchPage(query, query.before !== null);
        drain();
        if (query.before !== null && replica !== undefined && replica.afterSeq < pageWatermark) {
          return synchronize(true);
        }
        operation = { status: "idle" };
        return publish(ready({ status: "online" }));
      } catch {
        return synchronize(true);
      } finally {
        visibleRequest = false;
      }
    },
    async markRead(intent: NotificationMarkReadIntent) {
      if (state.status !== "ready" || state.connection.status !== "online" || replica === undefined) {
        return structuredClone(state);
      }
      const projection = replica.notifications.find((value) => value.notificationId === intent.notificationId);
      if (projection === undefined || projection.readAt !== null ||
          projection.readRevision !== intent.expectedReadRevision) return structuredClone(state);
      const requestId = options.createRequestId("read");
      operation = { status: "submitting", requestId, notificationId: intent.notificationId };
      publish(ready({ status: "online" }));
      try {
        const ack = await options.transport.notificationMarkRead({ type: "notification.mark-read", requestId,
          ...intent });
        if (ack.requestId !== requestId || ack.notificationId !== intent.notificationId ||
            ack.recipientActorId !== options.session()?.actorId || ack.readRevision <= intent.expectedReadRevision) {
          throw new MessageAuthorityTransportError("protocol_error");
        }
        operation = { status: "acknowledged", requestId, notificationId: intent.notificationId,
          readRevision: ack.readRevision };
      } catch (error: unknown) {
        operation = { status: "failed", requestId, notificationId: intent.notificationId,
          error: closedError(error) };
      }
      return publish(ready({ status: "online" }));
    },
    async resolveSource(intent: NotificationResolveSourceIntent): Promise<NotificationSourceResolution> {
      if (state.status !== "ready" || state.connection.status !== "online" || replica === undefined ||
          !replica.notifications.some((value) => value.notificationId === intent.notificationId)) {
        return { status: "inaccessible", notificationId: intent.notificationId };
      }
      const requestId = options.createRequestId("source");
      try {
        const result = await options.transport.notificationResolveSource({
          type: "notification.source.resolve", requestId, ...intent,
        });
        if (result.requestId !== requestId || result.projection.notificationId !== intent.notificationId ||
            result.projection.recipientActorId !== options.session()?.actorId) {
          throw new MessageAuthorityTransportError("protocol_error");
        }
        sourceResolutions.set(intent.notificationId, "available");
        publish(ready({ status: "online" }));
        return { status: "available", notificationId: intent.notificationId,
          roomId: result.projection.roomId,
          deepLink: structuredClone(result.projection.deepLink) };
      } catch (error: unknown) {
        const failure = closedError(error);
        if (failure.status === 403 || failure.status === 410) {
          sourceResolutions.set(intent.notificationId, "recalled");
          operation = { status: "failed", requestId, notificationId: intent.notificationId,
            error: failure };
          publish(ready({ status: "online" }));
        }
        return { status: "inaccessible", notificationId: intent.notificationId };
      }
    },
    retryRepair: () => synchronize(true),
    onStateChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidateAuthorizedState(reason = "session_revoked") {
      buffered.length = 0; replica = undefined; badges = []; sourceResolutions = new Map();
      badgesThroughSeq = 0; operation = { status: "idle" }; cacheReady = false;
      const actorId = options.session()?.actorId ?? (state.recipientActorId || "unavailable");
      publish({ status: "revoked", recipientActorId: actorId, reason });
    },
    close() {
      if (closed) return;
      closed = true; buffered.length = 0; listeners.clear();
      unsubscribeIdentityAdvance(); unsubscribeNotification(); unsubscribeTerminal(); unsubscribeFailure();
    },
  };
  return Object.freeze(runtime);
}
