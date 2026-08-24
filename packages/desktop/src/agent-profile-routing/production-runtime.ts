import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  isAgentProfileProjection,
  isAgentSettingsAuthorityMessage,
  isAgentSettingsMutationIntent,
  isAgentSettingsSnapshot,
  isRoomAgentAssignmentProjection,
  type AgentSettingsAuthorityMessage,
  type AgentSettingsBridge,
  type AgentSettingsMutationIntent,
  type AgentSettingsSnapshot,
  type RoomAgentAssignmentProjection,
} from "./contracts.js";

export interface AgentSettingsWebSocketLike {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

type Governance = Readonly<{ roomId: string; roomName: string; lifecycle: "active" | "archived";
  roomRevision: number; roomRole: "owner" | "admin" | "member" | null }>;
type WireRecord = Record<string, unknown>;
type PendingRequest = Readonly<{
  resolve(value: WireRecord): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}>;

const MAX_DEFERRED_ROOM_EVENTS = 512;

function record(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerProjection(value: unknown): AgentSettingsSnapshot["provider"] {
  if (!record(value)) throw new TypeError("Agent Settings Provider disclosure is unavailable");
  return {
    providerId: String(value.providerId),
    modelId: String(value.modelId),
    credentialStatus: value.credentialReadiness === "ready" ? "configured" : "missing",
    retentionDisabled: true,
    selectionPolicy: "server-managed-single",
  };
}

function assignmentValues(value: unknown): readonly RoomAgentAssignmentProjection[] {
  if (!Array.isArray(value)) throw new TypeError("Agent Settings Assignment repair is unavailable");
  return Object.freeze(value.map((entry) => {
    if (!record(entry)) throw new TypeError("Agent Settings Assignment projection is malformed");
    const projection = { ...entry };
    delete projection.updatedAt;
    if (!isRoomAgentAssignmentProjection(projection)) {
      throw new TypeError("Agent Settings Assignment projection is not closed");
    }
    return projection;
  }));
}

export function createDesktopAgentSettingsRuntime(options: {
  endpoint: string;
  session: () => IdentityAuthoritySession | undefined;
  webSocketFactory: (endpoint: string) => AgentSettingsWebSocketLike;
  governance: (roomId: string) => Promise<Governance>;
  createRequestIdentity: () => Readonly<{ requestId: string; idempotencyKey: string }>;
  timeoutMs?: number;
  syncIntervalMs?: number;
}): AgentSettingsBridge & { close(): void; invalidateAuthorizedState(): void } {
  const listeners = new Set<(message: AgentSettingsAuthorityMessage) => void>();
  const pending = new Map<string, PendingRequest>();
  const acknowledgedRequestsByEventId = new Map<string, string>();
  const observedEvents = new Map<string, Extract<AgentSettingsAuthorityMessage, { type: "stable-event" }>>();
  const eventWaiters = new Map<string, Set<() => void>>();
  let socket: AgentSettingsWebSocketLike | undefined;
  let connection: Promise<void> | undefined;
  let authenticated = false;
  let closed = false;
  let currentRoomId: string | undefined;
  let roomCursor = 0;
  let roomRepairWatermark = 0;
  let lastSnapshot: AgentSettingsSnapshot | undefined;
  let syncRunning = false;
  let authorityEpoch = 0;
  const activeRefreshes = new Set<number>();
  const deferredRoomFrames: WireRecord[] = [];
  const deferredRoomEventIds = new Set<string>();
  let deferredRoomOverflow = false;
  const removedAssignmentRevisions = new Map<string, number>();
  let repairGeneration = 0;
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let subscribedRoomId: string | undefined;
  let subscription: Promise<void> | undefined;
  let subscriptionRequestId: string | undefined;
  let settleSubscription: ((error?: Error) => void) | undefined;

  const publish = (message: AgentSettingsAuthorityMessage): void => {
    if (!isAgentSettingsAuthorityMessage(message)) throw new TypeError("Agent Settings message is not closed");
    for (const listener of listeners) listener(structuredClone(message));
  };

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  const publishOffline = (): void => {
    const asOf = new Date().toISOString();
    publish({ type: "offline", asOf,
      leaseExpiresAt: new Date(Date.parse(asOf) + 30_000).toISOString() });
  };

  const purgeAuthority = (scope: "room" | "session"): void => {
    authorityEpoch += 1;
    const candidate = socket;
    socket = undefined;
    connection = undefined;
    authenticated = false;
    subscribedRoomId = undefined;
    subscription = undefined;
    settleSubscription?.(new Error(scope === "session" ? "session_revoked" : "room_forbidden"));
    settleSubscription = undefined;
    subscriptionRequestId = undefined;
    rejectPending(new Error(scope === "session" ? "session_revoked" : "room_forbidden"));
    currentRoomId = undefined;
    roomCursor = 0;
    roomRepairWatermark = 0;
    lastSnapshot = undefined;
    activeRefreshes.clear();
    deferredRoomFrames.length = 0;
    deferredRoomEventIds.clear();
    deferredRoomOverflow = false;
    removedAssignmentRevisions.clear();
    acknowledgedRequestsByEventId.clear();
    observedEvents.clear();
    for (const waiters of eventWaiters.values()) for (const resolve of waiters) resolve();
    eventWaiters.clear();
    try { candidate?.close(); } catch { /* authority purge is already complete */ }
    publish({ type: "access-revoked", scope, purgeCompleted: true });
  };

  const stableEvent = (
    eventId: string,
    cursor: number,
    event: Extract<AgentSettingsAuthorityMessage, { type: "stable-event" }>["event"],
  ): Extract<AgentSettingsAuthorityMessage, { type: "stable-event" }> => ({
    type: "stable-event",
    eventId,
    cursor,
    ...(acknowledgedRequestsByEventId.get(eventId) === undefined
      ? {}
      : { causationRequestId: acknowledgedRequestsByEventId.get(eventId)! }),
    event,
  });

  const acceptStableEvent = (
    message: Extract<AgentSettingsAuthorityMessage, { type: "stable-event" }>,
  ): void => {
    observedEvents.set(message.eventId, message);
    if (observedEvents.size > 512) {
      const oldest = observedEvents.keys().next().value;
      if (typeof oldest === "string") observedEvents.delete(oldest);
    }
    for (const resolve of eventWaiters.get(message.eventId) ?? []) resolve();
    eventWaiters.delete(message.eventId);
    publish(message);
  };

  const waitForStableEvent = async (eventId: string): Promise<void> => {
    if (observedEvents.has(eventId)) return;
    await new Promise<void>((resolve) => {
      const waiters = eventWaiters.get(eventId) ?? new Set<() => void>();
      const timeout = setTimeout(() => {
        waiters.delete(done);
        if (waiters.size === 0) eventWaiters.delete(eventId);
        resolve();
      }, Math.min(options.timeoutMs ?? 10_000, 1_000));
      const done = () => {
        clearTimeout(timeout);
        waiters.delete(done);
        resolve();
      };
      waiters.add(done);
      eventWaiters.set(eventId, waiters);
    });
  };

  const handleRoomEvent = (frame: WireRecord): void => {
    if (!record(frame.event) || frame.event.type !== "room.agent-assignment.changed" ||
        frame.event.roomId !== currentRoomId || typeof frame.event.eventId !== "string" ||
        typeof frame.event.streamSeq !== "number" || !record(frame.event.payload)) return;
    if (activeRefreshes.size > 0) {
      if (deferredRoomEventIds.has(frame.event.eventId)) return;
      if (deferredRoomFrames.length >= MAX_DEFERRED_ROOM_EVENTS) {
        deferredRoomOverflow = true;
        return;
      }
      deferredRoomEventIds.add(frame.event.eventId);
      deferredRoomFrames.push(structuredClone(frame));
      return;
    }
    if (frame.event.streamSeq <= roomRepairWatermark) return;
    const payload = frame.event.payload;
    let event: Extract<AgentSettingsAuthorityMessage, { type: "stable-event" }>["event"];
    if (payload.change === "upserted" || payload.change === "availability-changed") {
      if (!record(payload.assignment) || typeof payload.roomRevision !== "number") return;
      const assignment = { ...payload.assignment };
      delete assignment.updatedAt;
      if (!isRoomAgentAssignmentProjection(assignment)) return;
      const removedRevision = removedAssignmentRevisions.get(assignment.assignmentId);
      if (removedRevision !== undefined && removedRevision >= assignment.assignmentRevision) return;
      if (removedRevision !== undefined) removedAssignmentRevisions.delete(assignment.assignmentId);
      event = { kind: "assignment.upserted", roomRevision: payload.roomRevision,
        assignment };
    } else if (payload.change === "removed" && typeof payload.roomRevision === "number" &&
        typeof payload.assignmentId === "string" && typeof payload.actorId === "string" &&
        typeof payload.assignmentRevision === "number" && currentRoomId !== undefined) {
      const removedRevision = removedAssignmentRevisions.get(payload.assignmentId);
      if (removedRevision !== undefined && removedRevision >= payload.assignmentRevision) return;
      event = { kind: "assignment.removed", roomId: currentRoomId,
        roomRevision: payload.roomRevision, assignmentId: payload.assignmentId,
        actorId: payload.actorId, assignmentRevision: payload.assignmentRevision };
      removedAssignmentRevisions.set(payload.assignmentId, Math.max(
        removedAssignmentRevisions.get(payload.assignmentId) ?? 0,
        payload.assignmentRevision,
      ));
    } else return;
    if (lastSnapshot?.room.status === "available" &&
        event.kind === "assignment.upserted") {
      const current = lastSnapshot.room.assignments.find((assignment) =>
        assignment.assignmentId === event.assignment.assignmentId);
      if (current !== undefined &&
          (event.assignment.assignmentRevision < current.assignmentRevision ||
           (event.assignment.assignmentRevision === current.assignmentRevision &&
            event.assignment.accessRevision < current.accessRevision))) {
        return;
      }
      const assignments = lastSnapshot.room.assignments
        .filter((assignment) => assignment.assignmentId !== event.assignment.assignmentId);
      lastSnapshot = { ...lastSnapshot, room: { ...lastSnapshot.room,
        roomRevision: Math.max(lastSnapshot.room.roomRevision, event.roomRevision),
        assignments: [...assignments, event.assignment]
          .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId)) } };
    } else if (lastSnapshot?.room.status === "available" &&
        event.kind === "assignment.removed") {
      const current = lastSnapshot.room.assignments.find((assignment) =>
        assignment.assignmentId === event.assignmentId);
      if (current === undefined || event.assignmentRevision <= current.assignmentRevision) {
        return;
      }
      lastSnapshot = { ...lastSnapshot, room: { ...lastSnapshot.room,
        roomRevision: Math.max(lastSnapshot.room.roomRevision, event.roomRevision),
        assignments: lastSnapshot.room.assignments
          .filter((assignment) => assignment.assignmentId !== event.assignmentId) } };
    }
    acceptStableEvent(stableEvent(frame.event.eventId, frame.event.streamSeq, event));
  };

  const beginRefresh = (): Readonly<{ token: number; epoch: number }> => {
    const token = ++repairGeneration;
    activeRefreshes.add(token);
    return { token, epoch: authorityEpoch };
  };

  const assertRefreshCurrent = (
    refresh: Readonly<{ token: number; epoch: number }>,
    roomId: string,
  ): void => {
    if (closed || refresh.epoch !== authorityEpoch || refresh.token !== repairGeneration ||
        currentRoomId !== roomId) {
      throw new Error("authority_invalidated");
    }
  };

  const finishRefresh = (refresh: Readonly<{ token: number; epoch: number }>): void => {
    activeRefreshes.delete(refresh.token);
    if (activeRefreshes.size > 0) return;
    const deferred = deferredRoomFrames.splice(0);
    deferredRoomEventIds.clear();
    const overflowed = deferredRoomOverflow;
    deferredRoomOverflow = false;
    for (const frame of deferred) handleRoomEvent(frame);
    if (overflowed && !closed && lastSnapshot !== undefined && currentRoomId !== undefined) {
      setTimeout(() => void synchronize().catch(() => undefined), 0);
    }
  };

  const disconnect = (candidate: AgentSettingsWebSocketLike, error: Error): void => {
    if (socket !== candidate) return;
    socket = undefined;
    authenticated = false;
    connection = undefined;
    subscribedRoomId = undefined;
    subscription = undefined;
    settleSubscription?.(error);
    settleSubscription = undefined;
    subscriptionRequestId = undefined;
    rejectPending(error);
    if (!closed) publishOffline();
  };

  async function ensureConnection(): Promise<void> {
    if (closed) throw new Error("authority_unavailable");
    if (authenticated && socket !== undefined) return;
    if (connection !== undefined) return connection;
    const session = options.session();
    if (session === undefined) {
      throw Object.assign(new Error("authentication_required"), { status: 401 });
    }
    const candidate = options.webSocketFactory(options.endpoint);
    socket = candidate;
    const authRequestId = `agent-settings-resume-${options.createRequestIdentity().requestId}`;
    connection = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        candidate.close();
        reject(new Error("authority_unavailable"));
      }, options.timeoutMs ?? 10_000);
      candidate.addEventListener("open", () => candidate.send(JSON.stringify({
        type: "auth.resume", requestId: authRequestId, accessToken: session.accessToken,
      })));
      candidate.addEventListener("message", (event: unknown) => {
        const raw = (event as { data?: unknown }).data;
        if (typeof raw !== "string") return;
        let value: unknown;
        try { value = JSON.parse(raw); } catch { return; }
        if (!record(value)) return;
        if (value.type === "auth.session-revoked") {
          purgeAuthority("session");
          return;
        }
        if (value.type === "identity.room-access.changed" &&
            value.actorId === options.session()?.actorId && value.roomId === currentRoomId &&
            value.change === "removed") {
          purgeAuthority("room");
          return;
        }
        if (value.type === "auth.authenticated" && value.requestId === authRequestId) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          authenticated = true;
          publish({ type: "online" });
          resolve();
          if (currentRoomId !== undefined && lastSnapshot !== undefined) {
            queueMicrotask(() => void subscribeRoom(currentRoomId!).catch(() => undefined));
          }
          return;
        }
        if (value.type === "room.event") {
          handleRoomEvent(value);
          return;
        }
        if (value.type === "room.subscribed" && value.requestId === subscriptionRequestId &&
            value.roomId === currentRoomId) {
          subscribedRoomId = currentRoomId;
          settleSubscription?.();
          settleSubscription = undefined;
          subscriptionRequestId = undefined;
          return;
        }
        const requestId = typeof value.requestId === "string" ? value.requestId : undefined;
        if (requestId === undefined) return;
        const request = pending.get(requestId);
        if (request === undefined) return;
        pending.delete(requestId);
        clearTimeout(request.timeout);
        if (value.type === "error") {
          request.reject(Object.assign(
            new Error(typeof value.code === "string" ? value.code : "authority_unavailable"),
            { status: value.status, code: value.code },
          ));
        } else request.resolve(value);
      });
      candidate.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("authority_unavailable"));
        }
        disconnect(candidate, new Error("authority_unavailable"));
      });
      candidate.addEventListener("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("authority_unavailable"));
        }
        disconnect(candidate, new Error("authority_unavailable"));
      });
    });
    try {
      await connection;
    } catch (error: unknown) {
      if (socket === candidate) {
        socket = undefined;
        connection = undefined;
      }
      throw error;
    }
  }

  async function exchangeOnce(frame: WireRecord): Promise<WireRecord> {
    await ensureConnection();
    const requestId = frame.requestId;
    if (typeof requestId !== "string" || pending.has(requestId) || socket === undefined) {
      throw new Error("authority_unavailable");
    }
    return new Promise<WireRecord>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("authority_unavailable"));
      }, options.timeoutMs ?? 10_000);
      pending.set(requestId, { resolve, reject, timeout });
      socket!.send(JSON.stringify(frame));
    });
  }

  async function subscribeRoom(roomId: string): Promise<void> {
    await ensureConnection();
    if (subscribedRoomId === roomId) return;
    if (subscription !== undefined) return subscription;
    const requestId = options.createRequestIdentity().requestId;
    subscriptionRequestId = requestId;
    subscription = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("authority_unavailable")),
        options.timeoutMs ?? 10_000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        subscription = undefined;
        if (error === undefined) resolve(); else reject(error);
      };
      settleSubscription = finish;
      socket!.send(JSON.stringify({ type: "room.subscribe", requestId, roomId }));
    });
    return subscription;
  }

  async function exchange(frame: WireRecord): Promise<WireRecord> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await exchangeOnce(frame); } catch (error: unknown) {
        lastError = error;
        const status = (error as { status?: unknown }).status;
        const retryable = status === 503 ||
          (error instanceof Error && error.message === "authority_unavailable");
        if (!retryable || attempt === 2 || closed) throw error;
        socket?.close();
        await new Promise<void>((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async function snapshot(roomId: string): Promise<AgentSettingsSnapshot> {
    currentRoomId = roomId;
    const refresh = beginRefresh();
    let completedSnapshot: AgentSettingsSnapshot | undefined;
    try {
      const governance = await options.governance(roomId);
      assertRefreshCurrent(refresh, roomId);
      const adminRequest = options.createRequestIdentity().requestId;
      let administrator = false;
      try {
        await exchange({ type: "tenant-administrator.list", requestId: adminRequest });
        assertRefreshCurrent(refresh, roomId);
        administrator = true;
      } catch (error) {
        assertRefreshCurrent(refresh, roomId);
        if ((error as { status?: number }).status !== 403) throw error;
      }
      let catalog: WireRecord | undefined;
      if (administrator) {
        catalog = await exchange({ type: "agent-profile.list",
          requestId: options.createRequestIdentity().requestId });
        assertRefreshCurrent(refresh, roomId);
      }
      let assignments: WireRecord | undefined;
      if (governance.roomRole !== null) {
        assignments = await exchange({
          type: "room-agent-assignment.repair", requestId: options.createRequestIdentity().requestId,
          roomId,
        });
        assertRefreshCurrent(refresh, roomId);
      }
      roomCursor = Number(assignments?.watermark ?? 0);
      roomRepairWatermark = roomCursor;
      removedAssignmentRevisions.clear();
      const providerWire = catalog?.provider ?? assignments?.provider;
      if (providerWire === undefined) {
        throw Object.assign(new Error("room_forbidden"), { status: 403 });
      }
      const value = {
        recordVersion: "agent-settings.snapshot.v1",
        cursor: Number(catalog?.catalogRevision ?? 0),
        viewer: { actorId: options.session()!.actorId, tenantAdministrator: administrator,
          roomRole: governance.roomRole },
        provider: providerProjection(providerWire),
        profileCatalog: administrator
          ? { status: "available", revision: catalog!.catalogRevision, profiles: catalog!.profiles }
          : { status: "forbidden" },
        room: governance.roomRole === null ? { status: "forbidden", roomId } : {
          status: "available", roomId, roomName: governance.roomName,
          lifecycle: governance.lifecycle, roomRevision: assignments!.roomRevision,
          assignments: assignmentValues(assignments!.assignments),
        },
      };
      if (!isAgentSettingsSnapshot(value)) throw new TypeError("Agent Settings snapshot is not closed");
      assertRefreshCurrent(refresh, roomId);
      lastSnapshot = structuredClone(value);
      await subscribeRoom(roomId);
      assertRefreshCurrent(refresh, roomId);
      if (syncTimer === undefined) {
        syncTimer = setInterval(() => void synchronize().catch((error: unknown) => {
          const status = (error as { status?: unknown }).status;
          if (status === 401) purgeAuthority("session");
          else if (status === 403 && lastSnapshot !== undefined) purgeAuthority("room");
        }),
          options.syncIntervalMs ?? 1_000);
      }
      completedSnapshot = value;
    } finally {
      finishRefresh(refresh);
    }
    assertRefreshCurrent(refresh, roomId);
    return structuredClone(lastSnapshot ?? completedSnapshot!);
  }

  function applyProfileEvent(event: WireRecord): void {
    if (lastSnapshot?.profileCatalog.status !== "available" ||
        typeof event.eventId !== "string" || typeof event.streamSeq !== "number" ||
        !record(event.payload) || !isAgentProfileProjection(event.payload.profile)) return;
    const profile = event.payload.profile;
    const profiles = [...lastSnapshot.profileCatalog.profiles
      .filter((item) => item.profileId !== profile.profileId), profile]
      .sort((left, right) => left.profileId.localeCompare(right.profileId));
    lastSnapshot = { ...lastSnapshot, cursor: event.streamSeq,
      profileCatalog: { status: "available", revision: event.streamSeq, profiles } };
    acceptStableEvent(stableEvent(event.eventId, event.streamSeq, {
      kind: "profile.upserted", catalogRevision: event.streamSeq, profile,
    }));
  }

  async function repairAll(reasonWatermark: number): Promise<void> {
    const current = lastSnapshot;
    const roomId = currentRoomId;
    if (current === undefined || roomId === undefined) return;
    const refresh = beginRefresh();
    const generation = refresh.token;
    let repairWatermark = reasonWatermark;
    try {
      const profileRepair = current.profileCatalog.status === "available"
        ? await exchange({ type: "agent-profile.repair",
            requestId: options.createRequestIdentity().requestId })
        : undefined;
      const assignmentRepair = current.room.status === "available"
        ? await exchange({ type: "room-agent-assignment.repair",
            requestId: options.createRequestIdentity().requestId, roomId })
        : undefined;
      assertRefreshCurrent(refresh, roomId);
      repairWatermark = Number(profileRepair?.watermark ?? current.cursor);
      publish({ type: "repair-started", generation, watermark: repairWatermark });
      const governance = await options.governance(roomId);
      assertRefreshCurrent(refresh, roomId);
      roomCursor = Number(assignmentRepair?.watermark ?? roomCursor);
      roomRepairWatermark = roomCursor;
      removedAssignmentRevisions.clear();
      const repaired = {
        ...current,
        cursor: Number(profileRepair?.watermark ?? current.cursor),
        provider: providerProjection(profileRepair?.provider ?? assignmentRepair?.provider),
        profileCatalog: current.profileCatalog.status === "available"
          ? { status: "available", revision: profileRepair!.watermark,
              profiles: profileRepair!.profiles }
          : { status: "forbidden" },
        room: current.room.status === "available" ? {
          status: "available", roomId, roomName: governance.roomName,
          lifecycle: governance.lifecycle, roomRevision: assignmentRepair!.roomRevision,
          assignments: assignmentValues(assignmentRepair!.assignments),
        } : { status: "forbidden", roomId },
      };
      if (!isAgentSettingsSnapshot(repaired)) throw new TypeError("Agent Settings repair is not closed");
      lastSnapshot = structuredClone(repaired);
      publish({ type: "repair-completed", generation, watermark: repairWatermark,
        snapshot: repaired });
    } catch (error: unknown) {
      if (refresh.epoch === authorityEpoch && refresh.token === repairGeneration &&
          currentRoomId === roomId) {
        publish({ type: "repair-failed", generation, watermark: repairWatermark,
          errorCode: error instanceof Error ? error.message : "repair_unavailable" });
      }
      throw error;
    } finally {
      finishRefresh(refresh);
    }
  }

  async function synchronize(): Promise<void> {
    if (syncRunning || closed || lastSnapshot === undefined || currentRoomId === undefined) return;
    syncRunning = true;
    try {
      if (lastSnapshot.profileCatalog.status === "available") {
        for (let page = 0; page < 8; page += 1) {
          const result = await exchange({ type: "agent-profile.sync",
            requestId: options.createRequestIdentity().requestId,
            afterSeq: lastSnapshot.cursor, limit: 256 });
          if (result.type !== "agent-profile.sync.result") throw new Error("repair_unavailable");
          if (result.mode === "repair_required") {
            await repairAll(Number(result.watermark));
            return;
          }
          if (result.mode !== "delta" || !Array.isArray(result.events) ||
              typeof result.nextCursor !== "number" || typeof result.hasMore !== "boolean") {
            throw new Error("repair_unavailable");
          }
          for (const event of result.events) if (record(event)) applyProfileEvent(event);
          if (lastSnapshot.profileCatalog.status === "available") {
            lastSnapshot = { ...lastSnapshot, cursor: result.nextCursor,
              profileCatalog: { ...lastSnapshot.profileCatalog, revision: result.nextCursor } };
          }
          if (!result.hasMore) break;
          if (page === 7) throw new Error("repair_unavailable");
        }
      }
      if (lastSnapshot.room.status === "available") {
        for (let page = 0; page < 8; page += 1) {
          const delta = await exchange({ type: "room.sync",
            requestId: options.createRequestIdentity().requestId,
            roomId: currentRoomId,
            cursor: { version: 1, roomId: currentRoomId, afterSeq: roomCursor },
            limit: 256 });
          if (delta.type !== "room.sync.result") throw new Error("repair_unavailable");
          if (delta.mode === "repair_required") {
            await repairAll(lastSnapshot.cursor);
            return;
          }
          if (delta.mode !== "delta" || !Array.isArray(delta.events) ||
              !record(delta.nextCursor) || typeof delta.nextCursor.afterSeq !== "number" ||
              typeof delta.hasMore !== "boolean") throw new Error("repair_unavailable");
          for (const event of delta.events) if (record(event)) {
            handleRoomEvent({ type: "room.event", event });
          }
          roomCursor = delta.nextCursor.afterSeq;
          roomRepairWatermark = Math.max(roomRepairWatermark, roomCursor);
          if (!delta.hasMore) break;
          if (page === 7) throw new Error("repair_unavailable");
        }
        const result = await exchange({ type: "room-agent-assignment.repair",
          requestId: options.createRequestIdentity().requestId, roomId: currentRoomId });
        const assignments = assignmentValues(result.assignments);
        if (typeof result.roomRevision !== "number") throw new Error("repair_unavailable");
        if (result.roomRevision !== lastSnapshot.room.roomRevision ||
            JSON.stringify(assignments) !== JSON.stringify(lastSnapshot.room.assignments)) {
          await repairAll(Number(result.watermark ?? lastSnapshot.cursor));
        }
      }
    } finally {
      syncRunning = false;
    }
  }

  function wire(intent: AgentSettingsMutationIntent, requestId: string, idempotencyKey: string) {
    const { command, ...fields } = intent;
    const types = { "profile.create": "agent-profile.create", "profile.update": "agent-profile.update",
      "profile.disable": "agent-profile.disable", "profile.enable": "agent-profile.enable",
      "assignment.create": "room-agent-assignment.create", "assignment.update": "room-agent-assignment.update",
      "assignment.pause": "room-agent-assignment.pause", "assignment.resume": "room-agent-assignment.resume",
      "assignment.remove": "room-agent-assignment.remove" } as const;
    return { type: types[command], requestId, idempotencyKey, ...fields,
      ...(command === "profile.create" ? { expectedProfileRevision: 0 } : {}) };
  }

  return Object.freeze({
    getSnapshot(input: { roomId: string }) { return snapshot(input.roomId); },
    async submit(input: Parameters<AgentSettingsBridge["submit"]>[0]) {
      if (!isAgentSettingsMutationIntent(input.intent)) {
        throw new TypeError("Agent Settings intent is not closed");
      }
      const identity = options.createRequestIdentity();
      const response = await exchange(wire(input.intent, identity.requestId, identity.idempotencyKey));
      if (response.type !== "agent-settings.ack" || !Array.isArray(response.eventIds)) {
        throw new Error("authority_unavailable");
      }
      for (const eventId of response.eventIds) {
        if (typeof eventId === "string") acknowledgedRequestsByEventId.set(eventId, input.requestId);
      }
      const ack = { type: "ack", requestId: input.requestId, command: input.intent.command,
        replayed: response.replayed, acceptedRevision: response.acceptedRevision,
        eventIds: response.eventIds } as AgentSettingsAuthorityMessage;
      publish(ack);
      for (const eventId of response.eventIds) {
        if (typeof eventId !== "string") continue;
        const observed = observedEvents.get(eventId);
        if (observed !== undefined) publish({ ...observed, causationRequestId: input.requestId });
      }
      await synchronize();
      await Promise.all(response.eventIds
        .filter((eventId): eventId is string => typeof eventId === "string")
        .map(waitForStableEvent));
      return structuredClone(ack);
    },
    onAuthorityMessage(listener: Parameters<AgentSettingsBridge["onAuthorityMessage"]>[0]) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidateAuthorizedState() {
      purgeAuthority("session");
    },
    close() {
      closed = true;
      if (syncTimer !== undefined) clearInterval(syncTimer);
      syncTimer = undefined;
      rejectPending(new Error("authority_unavailable"));
      for (const waiters of eventWaiters.values()) for (const resolve of waiters) resolve();
      eventWaiters.clear();
      socket?.close();
      socket = undefined;
      listeners.clear();
    },
  });
}
