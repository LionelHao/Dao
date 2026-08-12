import {
  isRoomRepairPage,
  isRoomCursor,
  isRoomSyncResult,
  isSnapshotCompleted,
  isWorkspaceBootstrapPage,
  type PersistedRoomEvent,
  type RoomCursor,
  type RoomRepairPage,
  type RoomSyncRequest,
  type RoomSyncResult,
  type SnapshotCompleted,
  type SnapshotVersion,
  type WorkspaceBootstrapPage,
} from "@native-im/core";

export interface RoomSubscriptionObserver {
  events(events: readonly PersistedRoomEvent[], cursor: RoomCursor): Promise<void>;
  retry(restartFrom: RoomCursor): Promise<void>;
}

export interface SyncTransport {
  bootstrapBegin(requestId: string): Promise<WorkspaceBootstrapPage>;
  bootstrapPage(requestId: string, snapshotId: string, afterPage: number): Promise<WorkspaceBootstrapPage>;
  syncRoom(request: RoomSyncRequest): Promise<RoomSyncResult>;
  repairRoomBegin(requestId: string, roomId: string): Promise<RoomRepairPage>;
  repairRoomPage(requestId: string, snapshotId: string, afterPage: number): Promise<RoomRepairPage>;
  completeSnapshot(
    requestId: string,
    snapshotId: string,
    version: SnapshotVersion,
    checksum: string,
  ): Promise<SnapshotCompleted>;
  subscribeRoom(
    roomId: string,
    cursor: RoomCursor,
    observer: RoomSubscriptionObserver,
  ): Promise<RoomSubscription>;
}

export interface RoomSubscription {
  readonly cursor: RoomCursor;
  close(): void;
}

export interface ClientAuthorityCache {
  roomCursor(roomId: string): RoomCursor | undefined;
  beginCatalog(snapshotId: string): void;
  stageCatalogPage(page: WorkspaceBootstrapPage): void;
  commitCatalog(version: number, checksum: string): void;
  beginRoom(roomId: string, snapshotId: string): void;
  stageRoomPage(page: RoomRepairPage): void;
  commitRoom(roomId: string, watermark: number, checksum: string): void;
  applyRoomEvents(
    roomId: string,
    events: readonly PersistedRoomEvent[],
    cursor: RoomCursor,
  ): void;
  discardSnapshot(snapshotId: string): void;
  clear(): void;
}

export class ClientSyncReplicaError extends Error {
  readonly code = "client_sync_invalid_response";

  constructor(message = "Authoritative sync response was invalid") {
    super(message);
    this.name = "ClientSyncReplicaError";
  }
}

export class SnapshotCompletionOutcomeUnknownError extends Error {
  readonly code = "snapshot_completion_outcome_unknown";

  constructor() {
    super("Snapshot completion outcome is unknown");
    this.name = "SnapshotCompletionOutcomeUnknownError";
  }
}

export interface ClientSyncReplica {
  restoreWorkspace(): Promise<void>;
  repairRoom(roomId: string): Promise<void>;
  clearAndRestore(): Promise<void>;
  close(): void;
}

interface SnapshotEnvelope {
  readonly snapshotId: string;
  readonly mode: "materialized" | "streaming";
  readonly checksum: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw invalid("Snapshot contained a non-canonical value");
}

async function snapshotChecksum(
  kind: "catalog" | "room",
  values: readonly unknown[],
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson({ kind, values, version: 1 })),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalid(message: string): ClientSyncReplicaError {
  return new ClientSyncReplicaError(message);
}

function sameCursorRoom(cursor: RoomCursor, roomId: string): boolean {
  return cursor.roomId === roomId;
}

function sameSnapshotVersion(left: SnapshotVersion, right: SnapshotVersion): boolean {
  return left.kind === "room" && right.kind === "room"
    ? left.roomId === right.roomId && left.watermark === right.watermark
    : left.kind === "catalog" && right.kind === "catalog" &&
      left.catalogRevision === right.catalogRevision;
}

function validateCatalogPage(
  page: unknown,
  expectedPage: number,
  envelope?: SnapshotEnvelope,
): asserts page is WorkspaceBootstrapPage {
  if (!isWorkspaceBootstrapPage(page) || page.page !== expectedPage ||
      (envelope !== undefined &&
        (page.snapshotId !== envelope.snapshotId || page.mode !== envelope.mode ||
          page.snapshotChecksum !== envelope.checksum))) {
    throw invalid("Workspace bootstrap page did not match its snapshot");
  }
}

function validateRoomPage(
  page: unknown,
  roomId: string,
  expectedPage: number,
  envelope?: SnapshotEnvelope & { readonly watermark: number },
): asserts page is RoomRepairPage {
  if (!isRoomRepairPage(page) || page.roomId !== roomId || page.page !== expectedPage ||
      (envelope !== undefined &&
        (page.snapshotId !== envelope.snapshotId || page.mode !== envelope.mode ||
          page.snapshotChecksum !== envelope.checksum || page.watermark !== envelope.watermark))) {
    throw invalid("Room repair page did not match its snapshot");
  }
}

function deduplicateEvents(
  events: readonly PersistedRoomEvent[],
  seen: Set<string>,
): readonly PersistedRoomEvent[] {
  const result: PersistedRoomEvent[] = [];
  for (const event of events) {
    if (!seen.has(event.eventId)) {
      seen.add(event.eventId);
      result.push(event);
    }
  }
  return result;
}

function validateEventShape(roomId: string, event: PersistedRoomEvent): void {
  const eventCursor: RoomCursor = {
    version: 1,
    roomId,
    afterSeq: event.streamSeq,
  };
  if (!isRoomSyncResult({
    type: "room.sync.result",
    requestId: "observer-event-validation",
    mode: "delta",
    events: [event],
    nextCursor: eventCursor,
    watermark: event.streamSeq,
    hasMore: false,
  })) {
    throw invalid("Room event did not match the closed event contract");
  }
}

function validateEventAdvance(
  roomId: string,
  current: RoomCursor,
  events: readonly PersistedRoomEvent[],
  next: RoomCursor,
): void {
  if (!isRoomCursor(current) || !isRoomCursor(next) ||
      !sameCursorRoom(current, roomId) || !sameCursorRoom(next, roomId) ||
      next.afterSeq < current.afterSeq) {
    throw invalid("Room cursor moved backwards or referenced another room");
  }
  if (events.length === 0) {
    if (next.afterSeq !== current.afterSeq) {
      throw invalid("Room cursor advanced without an event");
    }
    return;
  }
  let expected = current.afterSeq + 1;
  for (const event of events) {
    if (event.streamSeq !== expected) {
      throw invalid("Room events were not a contiguous stream");
    }
    expected += 1;
  }
  if (next.afterSeq !== expected - 1) {
    throw invalid("Room cursor did not match its events");
  }
}

export function createClientSyncReplica(options: {
  readonly transport: SyncTransport;
  readonly cache: ClientAuthorityCache;
}): ClientSyncReplica {
  const { transport, cache } = options;
  const subscriptions = new Map<string, RoomSubscription>();
  const subscriptionGenerations = new Map<string, number>();
  const roomOperationGenerations = new Map<string, number>();
  const seenByRoom = new Map<string, Set<string>>();
  const roomRepairs = new Map<string, Promise<void>>();
  let workspaceRestore: Promise<void> | undefined;
  let requestSequence = 0;
  let closed = false;
  let lifecycleEpoch = 0;

  const requestId = (prefix: string): string => `${prefix}-${++requestSequence}`;

  const requireOpen = (): void => {
    if (closed) throw invalid("Client sync replica is closed");
  };

  const closeSubscription = (subscription: RoomSubscription | undefined): void => {
    try {
      subscription?.close();
    } catch {
      // Cleanup cannot roll back an already installed or invalidated generation.
    }
  };

  const applyEvents = (
    roomId: string,
    events: readonly PersistedRoomEvent[],
    cursor: RoomCursor,
  ): void => {
    const current = cache.roomCursor(roomId) ?? { version: 1, roomId, afterSeq: 0 };
    const seen = seenByRoom.get(roomId) ?? new Set<string>();
    for (const event of events) validateEventShape(roomId, event);
    const candidateSeen = new Set(seen);
    const fresh = deduplicateEvents(events, candidateSeen);
    validateEventAdvance(roomId, current, fresh, cursor);
    cache.applyRoomEvents(roomId, fresh, cursor);
    for (const event of fresh) seen.add(event.eventId);
    seenByRoom.set(roomId, seen);
  };

  const syncFrom = async (
    roomId: string,
    initialCursor: RoomCursor,
    apply: (events: readonly PersistedRoomEvent[], cursor: RoomCursor) => void =
      (events, cursor) => applyEvents(roomId, events, cursor),
    assertCurrent: () => void = requireOpen,
  ): Promise<RoomCursor> => {
    let cursor = initialCursor;
    let fixedWatermark: number | undefined;
    const events: PersistedRoomEvent[] = [];
    for (;;) {
      const request: RoomSyncRequest = {
        type: "room.sync",
        requestId: requestId("room-sync"),
        roomId,
        cursor,
      };
      const result = await transport.syncRoom(request);
      assertCurrent();
      if (!isRoomSyncResult(result) || result.requestId !== request.requestId) {
        throw invalid("Room sync result did not match its request");
      }
      if (result.mode === "repair_required") {
        throw invalid("Room required another repair after snapshot completion");
      }
      if (fixedWatermark !== undefined && result.watermark !== fixedWatermark) {
        throw invalid("Room sync watermark changed between pages");
      }
      fixedWatermark ??= result.watermark;
      const firstEvent = result.events[0];
      if (result.nextCursor.roomId !== roomId || result.nextCursor.afterSeq < cursor.afterSeq ||
          (firstEvent !== undefined && firstEvent.streamSeq !== cursor.afterSeq + 1) ||
          (firstEvent === undefined && result.nextCursor.afterSeq !== cursor.afterSeq)) {
        throw invalid("Room sync result moved the cursor backwards");
      }
      events.push(...result.events);
      cursor = result.nextCursor;
      if (!result.hasMore) {
        assertCurrent();
        apply(events, cursor);
        return cursor;
      }
    }
  };

  const subscribe = async (
    roomId: string,
    cursor: RoomCursor,
    options: {
      readonly assertCurrent?: () => void;
    } = {},
  ): Promise<void> => {
    const assertCurrent = options.assertCurrent ?? requireOpen;
    const generation = (subscriptionGenerations.get(roomId) ?? 0) + 1;
    const buffered: { events: readonly PersistedRoomEvent[]; cursor: RoomCursor }[] = [];
    let activated = false;
    const observer: RoomSubscriptionObserver = {
      events: async (events, nextCursor) => {
        requireOpen();
        if (!activated) {
          buffered.push({ events, cursor: nextCursor });
          return;
        }
        if (subscriptionGenerations.get(roomId) !== generation) return;
        applyEvents(roomId, events, nextCursor);
      },
      retry: async (restartFrom) => {
        requireOpen();
        if (subscriptionGenerations.get(roomId) !== generation) return;
        if (!isRoomCursor(restartFrom) || !sameCursorRoom(restartFrom, roomId)) {
          throw invalid("Subscription retry referenced another room");
        }
        const retryOperation = (roomOperationGenerations.get(roomId) ?? 0) + 1;
        roomOperationGenerations.set(roomId, retryOperation);
        const retryLifecycle = lifecycleEpoch;
        const assertRetryCurrent = (): void => {
          requireOpen();
          if (lifecycleEpoch !== retryLifecycle ||
              roomOperationGenerations.get(roomId) !== retryOperation) {
            throw invalid("Room subscription retry was superseded");
          }
        };
        subscriptionGenerations.set(roomId, generation + 1);
        closeSubscription(subscriptions.get(roomId));
        subscriptions.delete(roomId);
        try {
          const recovered = await syncFrom(
            roomId,
            restartFrom,
            (events, nextCursor) => applyEvents(roomId, events, nextCursor),
            assertRetryCurrent,
          );
          await subscribe(roomId, recovered, { assertCurrent: assertRetryCurrent });
        } catch (cause: unknown) {
          if (closed || lifecycleEpoch !== retryLifecycle ||
              roomOperationGenerations.get(roomId) !== retryOperation) return;
          throw cause;
        }
      },
    };
    const subscription = await transport.subscribeRoom(roomId, cursor, observer);
    try {
      assertCurrent();
    } catch (cause: unknown) {
      closeSubscription(subscription);
      throw cause;
    }
    if (!isRoomCursor(subscription.cursor) || !sameCursorRoom(subscription.cursor, roomId) ||
        subscription.cursor.afterSeq < cursor.afterSeq) {
      closeSubscription(subscription);
      throw invalid("Room subscription returned an invalid cursor");
    }
    const bufferedSeen = new Set(seenByRoom.get(roomId) ?? []);
    let bufferedCursor = cursor;
    const prepared: { events: readonly PersistedRoomEvent[]; cursor: RoomCursor }[] = [];
    try {
      for (const item of buffered) {
        for (const event of item.events) validateEventShape(roomId, event);
        const fresh = deduplicateEvents(item.events, bufferedSeen);
        validateEventAdvance(roomId, bufferedCursor, fresh, item.cursor);
        prepared.push({ events: fresh, cursor: item.cursor });
        bufferedCursor = item.cursor;
      }
      if (subscription.cursor.afterSeq !== bufferedCursor.afterSeq) {
        throw invalid("Room subscription cursor did not match buffered events");
      }
      assertCurrent();
    } catch (cause: unknown) {
      closeSubscription(subscription);
      throw cause;
    }
    const previous = subscriptions.get(roomId);
    subscriptionGenerations.set(roomId, generation);
    subscriptions.set(roomId, subscription);
    closeSubscription(previous);
    activated = true;
    for (const item of prepared) applyEvents(roomId, item.events, item.cursor);
  };

  const completeStreaming = async (
    snapshotId: string,
    version: SnapshotVersion,
    value: string,
  ): Promise<void> => {
    let firstFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const completionRequestId = requestId("snapshot-complete");
      try {
        const completed = await transport.completeSnapshot(
          completionRequestId,
          snapshotId,
          version,
          value,
        );
        if (!isSnapshotCompleted(completed) || completed.snapshotId !== snapshotId ||
            completed.requestId !== completionRequestId ||
            !sameSnapshotVersion(completed.version, version)) {
          throw invalid("Snapshot completion did not match its request");
        }
        return;
      } catch (cause: unknown) {
        firstFailure ??= cause;
        if (!(cause instanceof SnapshotCompletionOutcomeUnknownError)) throw cause;
        if (typeof cause === "object" && cause !== null && "status" in cause &&
            typeof cause.status === "number") {
          throw cause;
        }
        if (attempt === 1) throw cause;
      }
    }
    throw firstFailure;
  };

  const repairRoomOnce = async (
    roomId: string,
    operationEpoch: number,
    roomOperation: number,
  ): Promise<void> => {
    requireOpen();
    const assertCurrent = (): void => {
      requireOpen();
      if (lifecycleEpoch !== operationEpoch ||
          roomOperationGenerations.get(roomId) !== roomOperation) {
        throw invalid("Client sync operation was superseded");
      }
    };
    const firstRequestId = requestId("room-repair-begin");
    const first = await transport.repairRoomBegin(firstRequestId, roomId);
    assertCurrent();
    validateRoomPage(first, roomId, 0);
    if (first.requestId !== firstRequestId) throw invalid("Room repair response did not match its request");
    const envelope = {
      snapshotId: first.snapshotId,
      mode: first.mode,
      checksum: first.snapshotChecksum,
      watermark: first.watermark,
    } as const;
    const records = [...first.records];
    try {
      cache.beginRoom(roomId, first.snapshotId);
      cache.stageRoomPage(first);
      let page = first;
      while (page.hasMore) {
        const pageRequestId = requestId("room-repair-page");
        const next = await transport.repairRoomPage(pageRequestId, first.snapshotId, page.page);
        assertCurrent();
        validateRoomPage(next, roomId, page.page + 1, envelope);
        if (next.requestId !== pageRequestId) throw invalid("Room repair response did not match its request");
        cache.stageRoomPage(next);
        records.push(...next.records);
        page = next;
      }
      if (await snapshotChecksum("room", records) !== first.snapshotChecksum) {
        throw invalid("Room repair checksum did not match its records");
      }
      if (first.mode === "streaming") {
        await completeStreaming(first.snapshotId, {
          kind: "room",
          roomId,
          watermark: first.watermark,
        }, first.snapshotChecksum);
        assertCurrent();
      }
      assertCurrent();
      cache.commitRoom(roomId, first.watermark, first.snapshotChecksum);
      seenByRoom.set(roomId, new Set<string>());
      const cursor = await syncFrom(
        roomId,
        { version: 1, roomId, afterSeq: first.watermark },
        (events, nextCursor) => applyEvents(roomId, events, nextCursor),
        assertCurrent,
      );
      await subscribe(roomId, cursor, { assertCurrent });
    } catch (cause: unknown) {
      cache.discardSnapshot(first.snapshotId);
      throw cause;
    }
  };

  const repairRoom = (roomId: string): Promise<void> => {
    const current = roomRepairs.get(roomId);
    if (current !== undefined) return current;
    const operationEpoch = lifecycleEpoch;
    const roomOperation = (roomOperationGenerations.get(roomId) ?? 0) + 1;
    roomOperationGenerations.set(roomId, roomOperation);
    const repairing = repairRoomOnce(roomId, operationEpoch, roomOperation).finally(() => {
      if (roomRepairs.get(roomId) === repairing) roomRepairs.delete(roomId);
    });
    roomRepairs.set(roomId, repairing);
    return repairing;
  };

  const restoreWorkspaceOnce = async (): Promise<void> => {
    requireOpen();
    const operationEpoch = lifecycleEpoch;
    const assertCurrent = (): void => {
      requireOpen();
      if (lifecycleEpoch !== operationEpoch) throw invalid("Client sync operation was superseded");
    };
    const firstRequestId = requestId("workspace-bootstrap-begin");
    const first = await transport.bootstrapBegin(firstRequestId);
    assertCurrent();
    validateCatalogPage(first, 0);
    if (first.requestId !== firstRequestId) throw invalid("Workspace bootstrap response did not match its request");
    const envelope = {
      snapshotId: first.snapshotId,
      mode: first.mode,
      checksum: first.snapshotChecksum,
    } as const;
    const roomIds: string[] = [];
    const rooms = [...first.rooms];
    try {
      cache.beginCatalog(first.snapshotId);
      cache.stageCatalogPage(first);
      roomIds.push(...first.rooms.map((room) => room.roomId));
      let page = first;
      while (page.hasMore) {
        const pageRequestId = requestId("workspace-bootstrap-page");
        const next = await transport.bootstrapPage(pageRequestId, first.snapshotId, page.page);
        assertCurrent();
        validateCatalogPage(next, page.page + 1, envelope);
        if (next.requestId !== pageRequestId) throw invalid("Workspace bootstrap response did not match its request");
        if (next.catalogRevision !== first.catalogRevision) {
          throw invalid("Catalog revision changed between pages");
        }
        cache.stageCatalogPage(next);
        rooms.push(...next.rooms);
        roomIds.push(...next.rooms.map((room) => room.roomId));
        page = next;
      }
      if (await snapshotChecksum("catalog", rooms) !== first.snapshotChecksum) {
        throw invalid("Workspace bootstrap checksum did not match its rooms");
      }
      if (new Set(roomIds).size !== roomIds.length) {
        throw invalid("Workspace bootstrap contained a duplicate room");
      }
      if (first.mode === "streaming") {
        await completeStreaming(first.snapshotId, {
          kind: "catalog",
          catalogRevision: first.catalogRevision,
        }, first.snapshotChecksum);
        assertCurrent();
      }
      assertCurrent();
      cache.commitCatalog(first.catalogRevision, first.snapshotChecksum);
    } catch (cause: unknown) {
      cache.discardSnapshot(first.snapshotId);
      throw cause;
    }
    for (const roomId of roomIds) await repairRoom(roomId);
  };

  const restoreWorkspace = (): Promise<void> => {
    if (workspaceRestore !== undefined) return workspaceRestore;
    const restoring = restoreWorkspaceOnce().finally(() => {
      if (workspaceRestore === restoring) workspaceRestore = undefined;
    });
    workspaceRestore = restoring;
    return restoring;
  };

  return {
    restoreWorkspace,
    repairRoom,
    async clearAndRestore() {
      requireOpen();
      lifecycleEpoch += 1;
      for (const subscription of subscriptions.values()) closeSubscription(subscription);
      subscriptions.clear();
      subscriptionGenerations.clear();
      roomOperationGenerations.clear();
      seenByRoom.clear();
      const pendingRepairs = [...roomRepairs.values()];
      const pendingWorkspace = workspaceRestore;
      await Promise.allSettled([
        ...pendingRepairs,
        ...(pendingWorkspace === undefined ? [] : [pendingWorkspace]),
      ]);
      cache.clear();
      await restoreWorkspace();
    },
    close() {
      if (closed) return;
      closed = true;
      lifecycleEpoch += 1;
      for (const subscription of subscriptions.values()) closeSubscription(subscription);
      subscriptions.clear();
      subscriptionGenerations.clear();
      roomOperationGenerations.clear();
      seenByRoom.clear();
    },
  };
}
