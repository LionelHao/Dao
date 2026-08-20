import {
  isRoomMemoryProjection,
  isRoomMemoryRequest,
  isRoomMemorySourceView,
  isRoomMemoryStatus,
  type RoomMemoryError,
  type RoomMemoryProjection,
  type RoomMemoryRequest,
  type RoomMemoryResolutionAction,
  type RoomMemorySourceNavigation,
  type RoomMemorySourceView,
  type RoomMemoryStatus,
  type RoomMemoryVersionSourceRef,
} from "@native-im/core";
import {
  createMemoryAuthorityCache,
  type MemoryAuthorityCache,
  type MemoryAuthorityCompleteSnapshot,
} from "./cache.js";
import {
  MemoryAuthorityClientFailure,
  type MemoryAuthorityClientApplication,
  type MemoryAuthorityClientPort,
  type MemoryAuthorityEpochRequest,
  type MemoryAuthorityEpochResponse,
} from "./client.js";
import type {
  MemoryClosedError,
  MemoryPanelConnection,
  MemoryPanelInput,
  MemoryPanelOperation,
  MemoryProjection,
  MemorySourceNavigation,
  MemorySourceProjection,
} from "./view-model.js";

export type MemoryAuthorityOperation = "query" | "source" | "dispute" | "resolve" | "retry";

export type MemoryAuthorityControllerContext = Readonly<{
  roomId: string;
  accessEpoch: number;
  lifecycle: "active" | "archived";
  viewer: Readonly<{ actorId: string; currentHuman: boolean }>;
  reducedMotion: boolean;
}>;

export type MemoryAuthorityControllerSnapshot = Readonly<{
  roomId: string;
  accessEpoch: number;
  panel: MemoryPanelInput;
}>;

export type MemoryAuthorityOperationReceipt = Readonly<{
  requestId: string;
  snapshot: MemoryAuthorityControllerSnapshot;
}>;

export type MemoryAuthoritySourceIntent = Readonly<{
  roomId: string;
  accessEpoch: number;
  navigation: MemorySourceNavigation;
}>;

export interface MemoryAuthorityController {
  open(context: MemoryAuthorityControllerContext): Promise<MemoryAuthorityControllerSnapshot>;
  current(roomId: string): MemoryAuthorityControllerSnapshot | undefined;
  subscribe(
    roomId: string,
    listener: (snapshot: MemoryAuthorityControllerSnapshot) => void,
  ): () => void;
  dispute(input: Readonly<{
    roomId: string;
    memoryRecordId: string;
    expectedVersion: number;
    reason: string;
  }>): MemoryAuthorityOperationReceipt;
  resolve(input: Readonly<{
    roomId: string;
    memoryRecordId: string;
    expectedVersion: number;
    reason: string;
    resolution?: RoomMemoryResolutionAction;
  }>): MemoryAuthorityOperationReceipt;
  retry(input: Readonly<{ roomId: string }>): MemoryAuthorityOperationReceipt;
  navigate(input: Readonly<{
    roomId: string;
    navigation: MemorySourceNavigation;
  }>): MemoryAuthoritySourceIntent | undefined;
  close(): void;
}

type Entry = {
  context: MemoryAuthorityControllerContext;
  snapshot: MemoryAuthorityControllerSnapshot;
  loadSequence: number;
};

type ControllerOptions = Readonly<{
  client: MemoryAuthorityClientPort;
  createRequestId(operation: MemoryAuthorityOperation): string;
  cache?: MemoryAuthorityCache;
}>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorView(error: RoomMemoryError): MemoryClosedError {
  return Object.freeze({
    status: error.status,
    code: error.code,
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
  });
}

function localError(status: 400 | 403 | 409 | 410 | 503, code: string): MemoryClosedError {
  return Object.freeze({ status, code });
}

function dependencyFailure(input: MemoryAuthorityEpochRequest): MemoryAuthorityClientFailure {
  return new MemoryAuthorityClientFailure(input.accessEpoch, {
    type: "error",
    status: 503,
    code: "memory_dependency_unavailable",
    message: "Memory authority response was unavailable or invalid",
    requestId: input.frame.requestId,
    objectId: input.frame.roomId,
    retryable: true,
  });
}

function initialPanel(context: MemoryAuthorityControllerContext): MemoryPanelInput {
  return Object.freeze({
    roomId: context.roomId,
    lifecycle: context.lifecycle,
    connection: Object.freeze({ status: "online" }),
    query: Object.freeze({ status: "loading" }),
    memories: Object.freeze([]),
    operation: Object.freeze({ status: "idle" }),
    viewer: clone(context.viewer),
    reducedMotion: context.reducedMotion,
  });
}

function sourceRefs(projection: RoomMemoryProjection): readonly RoomMemoryVersionSourceRef[] {
  return projection.projectionKind === "memory"
    ? projection.currentVersion.sourceRefs
    : projection.sourceRefs;
}

function sourceKey(value: Pick<RoomMemorySourceView, "sourceKind" | "sourceId" | "sourceRevision">): string {
  return `${value.sourceKind}\u0000${value.sourceId}\u0000${value.sourceRevision}`;
}

function navigationKey(value: RoomMemorySourceNavigation | MemorySourceNavigation): string {
  if (value.kind === "message" || value.kind === "tombstone") return `${value.kind}\u0000${value.messageId}`;
  if (value.kind === "attachment") return `${value.kind}\u0000${value.attachmentId}`;
  return `${value.kind}\u0000${value.projectFactId}`;
}

function sourceAvailability(source: RoomMemorySourceView): MemorySourceProjection["availability"] {
  // Project facts have no renderer-owned authority route in Wave 2. Keep the exact
  // Core intent visible as a read-only/unavailable source rather than inventing a URL.
  if (source.navigation.kind === "project_fact") return "unavailable";
  if (source.eligibility === "excluded_revised") return "revised";
  if (source.eligibility === "excluded_recalled" || source.availability === "tombstone") {
    return "recalled";
  }
  return source.eligibility === "eligible" && source.availability === "readable"
    ? "active"
    : "unavailable";
}

function mapSource(source: RoomMemorySourceView): MemorySourceProjection {
  return Object.freeze({
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
    revision: source.sourceRevision,
    availability: sourceAvailability(source),
    navigation: clone(source.navigation),
  });
}

function mapProjection(
  projection: RoomMemoryProjection,
  sources: ReadonlyMap<string, RoomMemorySourceView>,
  viewerActorId: string,
): MemoryProjection {
  const mappedSources = sourceRefs(projection).map((sourceRef) => {
    const source = sources.get(sourceKey(sourceRef));
    if (source === undefined) throw new TypeError("Incomplete Memory Authority source coverage");
    return mapSource(source);
  });
  if (projection.projectionKind === "confirmed-project-reference") {
    return Object.freeze({
      memoryRecordId: projection.memoryRecordId,
      version: projection.projectFactVersion,
      kind: projection.kind,
      state: "confirmed_project_reference",
      derivedText: projection.derivedText,
      projectReferenceAvailable: true,
      sources: Object.freeze(mappedSources),
    });
  }
  const openDispute = projection.disputes.find((dispute) => dispute.status === "open");
  return Object.freeze({
    memoryRecordId: projection.memoryRecordId,
    version: projection.currentVersion.version,
    kind: projection.kind,
    state: projection.currentVersion.state,
    derivedText: projection.currentVersion.derivedText,
    ...(openDispute === undefined ? {} : { disputedBy: openDispute.operatorActorId }),
    ...(projection.currentVersion.state === "disputed"
      ? { canResolve: openDispute?.operatorActorId === viewerActorId }
      : {}),
    sources: Object.freeze(mappedSources),
  });
}

function panelFromCache(
  context: MemoryAuthorityControllerContext,
  complete: MemoryAuthorityCompleteSnapshot | undefined,
  connection: MemoryPanelConnection,
  query: MemoryPanelInput["query"],
  operation: MemoryPanelOperation,
): MemoryPanelInput {
  const sources = new Map<string, RoomMemorySourceView>();
  for (const source of complete?.sources ?? []) sources.set(sourceKey(source), source);
  return Object.freeze({
    roomId: context.roomId,
    lifecycle: context.lifecycle,
    connection: clone(connection),
    query: clone(query),
    ...(complete === undefined ? {} : {
      health: Object.freeze({
        status: complete.status.health.state,
        memoryWatermark: complete.status.health.memoryWatermark,
        corpusHead: complete.status.health.corpusHead,
        lag: complete.status.health.lag,
        retryable: complete.status.health.retryable,
        recoveryRequired: complete.status.health.recoveryRequired,
      }),
    }),
    memories: Object.freeze((complete?.projections ?? []).map((projection) =>
      mapProjection(projection, sources, context.viewer.actorId))),
    operation: clone(operation),
    viewer: clone(context.viewer),
    reducedMotion: context.reducedMotion,
  });
}

function closedSnapshot(entry: Entry): MemoryAuthorityControllerSnapshot {
  return clone(entry.snapshot);
}

function operationBlocked(entry: Entry, requireReady = true): MemoryClosedError | undefined {
  if (entry.context.lifecycle !== "active") return localError(410, "room_archived");
  if (!entry.context.viewer.currentHuman) return localError(403, "room_forbidden");
  if (entry.snapshot.panel.connection.status !== "online") {
    return localError(503, "memory_unavailable");
  }
  if (requireReady && entry.snapshot.panel.query.status !== "ready") {
    return localError(503, "memory_unavailable");
  }
  return undefined;
}

function sameStatus(left: RoomMemoryStatus, right: RoomMemoryStatus): boolean {
  return left.roomId === right.roomId && left.recoveryGeneration === right.recoveryGeneration &&
    left.updatedAt === right.updatedAt && left.health.state === right.health.state &&
    left.health.reason === right.health.reason &&
    left.health.memoryWatermark === right.health.memoryWatermark &&
    left.health.corpusHead === right.health.corpusHead && left.health.lag === right.health.lag &&
    left.health.lastAttemptAt === right.health.lastAttemptAt &&
    left.health.retryable === right.health.retryable &&
    left.health.recoveryRequired === right.health.recoveryRequired;
}

function validReason(reason: string): boolean {
  return reason.trim().length > 0 && new TextEncoder().encode(reason).byteLength <= 2_048;
}

export function createMemoryAuthorityController(options: ControllerOptions): MemoryAuthorityController {
  const cache = options.cache ?? createMemoryAuthorityCache();
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<(snapshot: MemoryAuthorityControllerSnapshot) => void>>();
  let closed = false;

  const emit = (entry: Entry): void => {
    for (const listener of listeners.get(entry.context.roomId) ?? []) listener(closedSnapshot(entry));
  };

  const updatePanel = (entry: Entry, panel: MemoryPanelInput): void => {
    entry.snapshot = Object.freeze({
      roomId: entry.context.roomId,
      accessEpoch: entry.context.accessEpoch,
      panel,
    });
    emit(entry);
  };

  const setFromCache = (
    entry: Entry,
    connection: MemoryPanelConnection = entry.snapshot.panel.connection,
    query: MemoryPanelInput["query"] = entry.snapshot.panel.query,
    operation: MemoryPanelOperation = entry.snapshot.panel.operation,
  ): void => updatePanel(entry, panelFromCache(
    entry.context,
    cache.snapshot(entry.context.roomId),
    connection,
    query,
    operation,
  ));

  const isCurrent = (roomId: string, accessEpoch: number, loadSequence?: number): boolean => {
    const entry = entries.get(roomId);
    return entry !== undefined && entry.context.accessEpoch === accessEpoch &&
      (loadSequence === undefined || entry.loadSequence === loadSequence);
  };

  const requireResponse = async (
    input: MemoryAuthorityEpochRequest,
    expectedType: MemoryAuthorityEpochResponse["frame"]["type"],
  ): Promise<MemoryAuthorityEpochResponse> => {
    const response = await options.client.request(input);
    if (response.accessEpoch !== input.accessEpoch || response.frame.type !== expectedType ||
        response.frame.requestId !== input.frame.requestId || response.frame.roomId !== input.frame.roomId) {
      throw dependencyFailure(input);
    }
    if (input.frame.type === "room.memory.source.query.v1" &&
        (response.frame.type !== "room.memory.source.v1" ||
         response.frame.source.sourceId !== input.frame.sourceId)) throw dependencyFailure(input);
    return response;
  };

  const hydrateSources = async (
    roomId: string,
    accessEpoch: number,
    projections: readonly RoomMemoryProjection[],
  ): Promise<readonly RoomMemorySourceView[]> => {
    const wanted = new Map<string, RoomMemoryVersionSourceRef>();
    for (const projection of projections) {
      for (const sourceRef of sourceRefs(projection)) wanted.set(sourceKey(sourceRef), sourceRef);
    }
    if (wanted.size > 5_000) throw new TypeError("Memory source hydration limit exceeded");
    const sources: RoomMemorySourceView[] = [];
    for (const sourceRef of wanted.values()) {
      const frame: RoomMemoryRequest = {
        type: "room.memory.source.query.v1",
        requestId: options.createRequestId("source"),
        roomId,
        sourceId: sourceRef.sourceId,
      };
      if (!isRoomMemoryRequest(frame)) throw dependencyFailure({ accessEpoch, frame });
      const response = await requireResponse({ accessEpoch, frame }, "room.memory.source.v1");
      if (response.frame.type !== "room.memory.source.v1" ||
          !isRoomMemorySourceView(response.frame.source) ||
          response.frame.source.roomId !== roomId ||
          sourceKey(response.frame.source) !== sourceKey(sourceRef) ||
          response.frame.source.eligibility !== sourceRef.eligibility ||
          response.frame.source.availability !== sourceRef.availability) {
        throw dependencyFailure({ accessEpoch, frame });
      }
      sources.push(response.frame.source);
    }
    return Object.freeze(sources);
  };

  const revoke = (entry: Entry, accessEpoch: number): void => {
    cache.purge(entry.context.roomId, accessEpoch);
    entry.context = Object.freeze({ ...entry.context, accessEpoch });
    entry.loadSequence += 1;
    updatePanel(entry, panelFromCache(
      entry.context,
      undefined,
      { status: "revoked" },
      { status: "ready" },
      { status: "idle" },
    ));
  };

  const failOperation = (
    entry: Entry,
    requestId: string,
    command: "dispute" | "resolve" | "retry",
    error: MemoryClosedError,
  ): void => setFromCache(entry, entry.snapshot.panel.connection, entry.snapshot.panel.query, {
    status: "failed",
    requestId,
    command,
    error,
  });

  const handleOperationFailure = (
    entry: Entry,
    requestId: string,
    command: "dispute" | "resolve" | "retry",
    error: unknown,
  ): void => {
    if (error instanceof MemoryAuthorityClientFailure && error.accessEpoch === entry.context.accessEpoch) {
      if (error.error.status === 403) {
        revoke(entry, entry.context.accessEpoch);
        return;
      }
      failOperation(entry, requestId, command, errorView(error.error));
      return;
    }
    failOperation(entry, requestId, command, localError(503, "memory_dependency_unavailable"));
  };

  const submit = (
    entry: Entry,
    command: "dispute" | "resolve" | "retry",
    frame: RoomMemoryRequest,
  ): MemoryAuthorityOperationReceipt => {
    const requestId = frame.requestId;
    setFromCache(entry, entry.snapshot.panel.connection, entry.snapshot.panel.query, {
      status: "submitting",
      requestId,
      command,
    });
    const accessEpoch = entry.context.accessEpoch;
    const expectedType = command === "dispute"
      ? "room.memory.context.dispute.accepted.v1"
      : command === "resolve"
        ? "room.memory.context.resolve.accepted.v1"
        : "room.memory.retry.accepted.v1";
    void requireResponse({ accessEpoch, frame }, expectedType).then((response) => {
      if (!isCurrent(entry.context.roomId, accessEpoch)) return;
      if ((command === "dispute" && response.frame.type !== "room.memory.context.dispute.accepted.v1") ||
          (command === "resolve" && response.frame.type !== "room.memory.context.resolve.accepted.v1") ||
          (command === "retry" && response.frame.type !== "room.memory.retry.accepted.v1")) {
        throw dependencyFailure({ accessEpoch, frame });
      }
      // ACK closes only the submitted command. Its included projection is deliberately
      // not installed; a stable event or an atomic repair owns visible authority state.
      setFromCache(entry, entry.snapshot.panel.connection, entry.snapshot.panel.query, {
        status: "acknowledged",
        requestId,
        command,
      });
    }).catch((error: unknown) => {
      if (isCurrent(entry.context.roomId, accessEpoch)) {
        handleOperationFailure(entry, requestId, command, error);
      }
    });
    return Object.freeze({ requestId, snapshot: closedSnapshot(entry) });
  };

  const handleApplication = async (input: MemoryAuthorityClientApplication): Promise<void> => {
    const roomId = input.type === "room.memory.event" ? input.event.roomId : input.roomId;
    const entry = entries.get(roomId);
    if (entry === undefined || input.accessEpoch < entry.context.accessEpoch) return;
    if (input.accessEpoch > entry.context.accessEpoch) {
      revoke(entry, input.accessEpoch);
      if (input.type !== "room.memory.revoked") return;
    }
    if (input.type === "room.memory.revoked") {
      revoke(entry, input.accessEpoch);
      return;
    }
    if (input.type === "room.memory.connection") {
      setFromCache(entry, { status: input.connection.status });
      return;
    }
    if (input.type === "room.memory.repair.failed") {
      setFromCache(entry, { status: "repair_failed" });
      return;
    }
    if (input.type === "room.memory.repair.completed") {
      entry.loadSequence += 1;
      const repairSequence = entry.loadSequence;
      setFromCache(entry, { status: "repairing" });
      try {
        cache.beginRepair(roomId, input.accessEpoch, input.generation);
        cache.stageRepair(roomId, input.accessEpoch, input.generation, input.records);
        const projections = input.records.flatMap((record) =>
          record.value.recordType === "projection" ? [record.value.projection] : []);
        const sources = await hydrateSources(roomId, input.accessEpoch, projections);
        if (!isCurrent(roomId, input.accessEpoch, repairSequence)) return;
        cache.commitRepair(roomId, input.accessEpoch, input.generation, sources);
        const connection = entry.snapshot.panel.connection.status === "offline"
          ? entry.snapshot.panel.connection
          : { status: "online" } as const;
        setFromCache(entry, connection, { status: "ready" }, { status: "idle" });
      } catch {
        if (!isCurrent(roomId, input.accessEpoch, repairSequence)) return;
        try { cache.failRepair(roomId, input.accessEpoch, input.generation); } catch { /* closed */ }
        setFromCache(entry, { status: "repair_failed" });
      }
      return;
    }
    if (input.event.type === "room.memory.health.changed") {
      const complete = cache.snapshot(roomId);
      if (complete === undefined || !isRoomMemoryStatus(input.event.payload) ||
          input.event.payload.roomId !== roomId) return;
      entry.loadSequence += 1;
      if (cache.replace({ ...complete, status: input.event.payload })) setFromCache(entry);
      return;
    }
    if (input.projection === undefined || !isRoomMemoryProjection(input.projection) ||
        input.projection.roomId !== roomId ||
        input.projection.memoryRecordId !== input.event.payload.memoryRecordId) return;
    const complete = cache.snapshot(roomId);
    if (complete === undefined) return;
    entry.loadSequence += 1;
    const eventSequence = entry.loadSequence;
    try {
      const projections = [
        ...complete.projections.filter((projection) =>
          projection.memoryRecordId !== input.projection?.memoryRecordId),
        input.projection,
      ];
      const hydrated = await hydrateSources(roomId, input.accessEpoch, [input.projection]);
      if (!isCurrent(roomId, input.accessEpoch, eventSequence)) return;
      const byKey = new Map(complete.sources.map((source) => [sourceKey(source), source]));
      for (const source of hydrated) byKey.set(sourceKey(source), source);
      const wanted = new Set(projections.flatMap((projection) => sourceRefs(projection).map(sourceKey)));
      const sources = [...byKey].filter(([key]) => wanted.has(key)).map(([, source]) => source);
      if (cache.replace({ ...complete, projections, sources })) setFromCache(entry);
    } catch {
      if (isCurrent(roomId, input.accessEpoch, eventSequence)) {
        setFromCache(entry, { status: "repair_failed" });
      }
    }
  };

  const stop = options.client.subscribe((input) => { void handleApplication(input); });

  const controller: MemoryAuthorityController = {
    async open(context): Promise<MemoryAuthorityControllerSnapshot> {
      if (closed) throw new TypeError("Memory Authority controller is closed");
      const previous = entries.get(context.roomId);
      if (previous !== undefined && context.accessEpoch < previous.context.accessEpoch) {
        return closedSnapshot(previous);
      }
      cache.advanceEpoch(context.roomId, context.accessEpoch);
      const loadSequence = (previous?.loadSequence ?? 0) + 1;
      const entry: Entry = previous ?? {
        context: clone(context),
        snapshot: Object.freeze({ roomId: context.roomId, accessEpoch: context.accessEpoch,
          panel: initialPanel(context) }),
        loadSequence,
      };
      entry.context = clone(context);
      entry.loadSequence = loadSequence;
      entries.set(context.roomId, entry);
      updatePanel(entry, panelFromCache(
        context,
        cache.snapshot(context.roomId),
        { status: "online" },
        { status: "loading" },
        { status: "idle" },
      ));
      let requestId = options.createRequestId("query");
      try {
        const projections: RoomMemoryProjection[] = [];
        const seen = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        let authoritativeStatus: RoomMemoryStatus | undefined;
        for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
          requestId = options.createRequestId("query");
          const frame: RoomMemoryRequest = cursor === null
            ? { type: "room.memory.query.v1", requestId, roomId: context.roomId, limit: 50 }
            : { type: "room.memory.query.v1", requestId, roomId: context.roomId, cursor, limit: 50 };
          if (!isRoomMemoryRequest(frame)) throw dependencyFailure({ accessEpoch: context.accessEpoch, frame });
          const response = await requireResponse({ accessEpoch: context.accessEpoch, frame }, "room.memory.page.v1");
          if (!isCurrent(context.roomId, context.accessEpoch, loadSequence)) {
            return closedSnapshot(entries.get(context.roomId) ?? entry);
          }
          if (response.frame.type !== "room.memory.page.v1" ||
              !isRoomMemoryStatus(response.frame.status) ||
              response.frame.status.roomId !== context.roomId ||
              !response.frame.items.every((projection) =>
                isRoomMemoryProjection(projection) && projection.roomId === context.roomId)) {
            throw dependencyFailure({ accessEpoch: context.accessEpoch, frame });
          }
          if (authoritativeStatus !== undefined && !sameStatus(authoritativeStatus, response.frame.status)) {
            throw dependencyFailure({ accessEpoch: context.accessEpoch, frame });
          }
          authoritativeStatus = response.frame.status;
          for (const projection of response.frame.items) {
            const key = `${projection.projectionKind}\u0000${projection.memoryRecordId}`;
            if (seen.has(key)) throw dependencyFailure({ accessEpoch: context.accessEpoch, frame });
            seen.add(key);
            projections.push(projection);
          }
          cursor = response.frame.nextCursor;
          if (cursor === null) break;
          if (cursors.has(cursor) || pageIndex === 99) {
            throw dependencyFailure({ accessEpoch: context.accessEpoch, frame });
          }
          cursors.add(cursor);
        }
        if (authoritativeStatus === undefined) throw new TypeError("Memory status unavailable");
        const sources = await hydrateSources(context.roomId, context.accessEpoch, projections);
        if (!isCurrent(context.roomId, context.accessEpoch, loadSequence)) {
          return closedSnapshot(entries.get(context.roomId) ?? entry);
        }
        cache.replace({ roomId: context.roomId, accessEpoch: context.accessEpoch,
          projections, status: authoritativeStatus, sources });
        setFromCache(entry, entry.snapshot.panel.connection, { status: "ready" }, { status: "idle" });
      } catch (error) {
        if (!isCurrent(context.roomId, context.accessEpoch, loadSequence)) {
          return closedSnapshot(entries.get(context.roomId) ?? entry);
        }
        if (error instanceof MemoryAuthorityClientFailure && error.error.status === 403) {
          revoke(entry, context.accessEpoch);
        } else {
          const failure = error instanceof MemoryAuthorityClientFailure
            ? errorView(error.error)
            : localError(503, "memory_dependency_unavailable");
          setFromCache(entry, entry.snapshot.panel.connection, {
            status: "failed",
            requestId,
            error: failure,
          });
        }
      }
      return closedSnapshot(entries.get(context.roomId) ?? entry);
    },
    current(roomId): MemoryAuthorityControllerSnapshot | undefined {
      const entry = entries.get(roomId);
      return entry === undefined ? undefined : closedSnapshot(entry);
    },
    subscribe(roomId, listener): () => void {
      if (closed) return () => undefined;
      const roomListeners = listeners.get(roomId) ?? new Set();
      roomListeners.add(listener);
      listeners.set(roomId, roomListeners);
      return () => {
        roomListeners.delete(listener);
        if (roomListeners.size === 0) listeners.delete(roomId);
      };
    },
    dispute(input): MemoryAuthorityOperationReceipt {
      const entry = entries.get(input.roomId);
      const requestId = options.createRequestId("dispute");
      if (entry === undefined) throw new TypeError("Memory Room is not open");
      const blocked = operationBlocked(entry);
      const memory = entry.snapshot.panel.memories.find((candidate) =>
        candidate.memoryRecordId === input.memoryRecordId);
      if (blocked !== undefined || !validReason(input.reason) || memory?.kind !== "context" ||
          memory.state !== "active" || memory.version !== input.expectedVersion) {
        failOperation(entry, requestId, "dispute", blocked ?? localError(409, "memory_version_conflict"));
        return Object.freeze({ requestId, snapshot: closedSnapshot(entry) });
      }
      const frame: RoomMemoryRequest = { type: "room.memory.context.dispute.v1", requestId,
        roomId: input.roomId, memoryRecordId: input.memoryRecordId,
        expectedVersion: input.expectedVersion, reason: input.reason.trim() };
      if (!isRoomMemoryRequest(frame)) {
        failOperation(entry, requestId, "dispute", localError(400, "invalid_request"));
        return Object.freeze({ requestId, snapshot: closedSnapshot(entry) });
      }
      return submit(entry, "dispute", frame);
    },
    resolve(input): MemoryAuthorityOperationReceipt {
      const entry = entries.get(input.roomId);
      const requestId = options.createRequestId("resolve");
      if (entry === undefined) throw new TypeError("Memory Room is not open");
      const blocked = operationBlocked(entry);
      const memory = entry.snapshot.panel.memories.find((candidate) =>
        candidate.memoryRecordId === input.memoryRecordId);
      if (blocked !== undefined || !validReason(input.reason) || memory?.kind !== "context" ||
          memory.state !== "disputed" || memory.canResolve !== true ||
          memory.version !== input.expectedVersion) {
        failOperation(entry, requestId, "resolve", blocked ?? localError(409, "memory_version_conflict"));
        return Object.freeze({ requestId, snapshot: closedSnapshot(entry) });
      }
      const frame: RoomMemoryRequest = { type: "room.memory.context.resolve.v1", requestId,
        roomId: input.roomId, memoryRecordId: input.memoryRecordId,
        expectedVersion: input.expectedVersion, resolution: input.resolution ?? "re_evaluate",
        reason: input.reason.trim() };
      if (!isRoomMemoryRequest(frame)) {
        failOperation(entry, requestId, "resolve", localError(400, "invalid_request"));
        return Object.freeze({ requestId, snapshot: closedSnapshot(entry) });
      }
      return submit(entry, "resolve", frame);
    },
    retry(input): MemoryAuthorityOperationReceipt {
      const entry = entries.get(input.roomId);
      const requestId = options.createRequestId("retry");
      if (entry === undefined) throw new TypeError("Memory Room is not open");
      const blocked = operationBlocked(entry, false);
      const complete = cache.snapshot(input.roomId);
      if (blocked !== undefined || complete === undefined) {
        failOperation(entry, requestId, "retry", blocked ?? localError(503, "memory_unavailable"));
        return Object.freeze({ requestId, snapshot: closedSnapshot(entry) });
      }
      const frame: RoomMemoryRequest = { type: "room.memory.retry.v1", requestId,
        roomId: input.roomId, expectedRecoveryGeneration: complete.status.recoveryGeneration };
      return submit(entry, "retry", frame);
    },
    navigate(input): MemoryAuthoritySourceIntent | undefined {
      const entry = entries.get(input.roomId);
      if (entry === undefined || entry.snapshot.panel.connection.status === "revoked") return undefined;
      const key = navigationKey(input.navigation);
      const source = entry.snapshot.panel.memories.flatMap((memory) => memory.sources)
        .find((candidate) => navigationKey(candidate.navigation) === key);
      if (source === undefined || source.availability === "unavailable") return undefined;
      return Object.freeze({ roomId: input.roomId, accessEpoch: entry.context.accessEpoch,
        navigation: clone(source.navigation) });
    },
    close(): void {
      if (closed) return;
      closed = true;
      stop();
      listeners.clear();
      entries.clear();
      options.client.close();
    },
  };
  return Object.freeze(controller);
}
