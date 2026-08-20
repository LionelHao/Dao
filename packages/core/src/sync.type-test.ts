import type { PersistedRoomEvent, RoomRepairRecord } from "./index.js";

type ArchivedEvent = Extract<PersistedRoomEvent, { readonly type: "room.archived" }>;
type ReopenedEvent = Extract<PersistedRoomEvent, { readonly type: "room.reopened" }>;
type MemoryVersionChangedEvent = Extract<
  PersistedRoomEvent,
  { readonly type: "room.memory.version.changed" }
>;
type MemoryRepairRecord = Extract<RoomRepairRecord, { readonly kind: "memory" }>;

const archived: ArchivedEvent = {
  eventId: "event-archived",
  streamKind: "room",
  streamId: "room-1",
  streamSeq: 1,
  roomId: "room-1",
  actorId: "human-1",
  occurredAt: "2026-08-19T00:01:00.000Z",
  type: "room.archived",
  payload: {
    governance: {
      roomId: "room-1",
      projectId: "room-1",
      lifecycle: "archived",
      governanceRevision: 4,
      ownerActorId: "human-1",
      archiveGeneration: 1,
      archivedAt: "2026-08-19T00:01:00.000Z",
    },
    archiveGeneration: 1,
    frozenTimerCount: 2,
  },
};

// @ts-expect-error An archive event cannot stand in for the distinct reopen event.
const reopenedFromArchive: ReopenedEvent = archived;

const archivedWithSecret: ArchivedEvent = {
  ...archived,
  payload: {
    ...archived.payload,
    // @ts-expect-error Lifecycle events expose closed counts, never grant material.
    rawGrantToken: "secret",
  },
};

const memoryVersionChanged: MemoryVersionChangedEvent = {
  eventId: "event-memory-version",
  streamKind: "room",
  streamId: "room-1",
  streamSeq: 2,
  roomId: "room-1",
  actorId: "memory-steward",
  occurredAt: "2026-08-19T00:02:00.000Z",
  type: "room.memory.version.changed",
  payload: {
    memoryRecordId: "memory-record-1",
    memoryVersionId: "memory-version-1",
    kind: "context",
    state: "active",
    sourceIds: ["message:message-1"],
    memoryWatermark: 1,
  },
};

const memoryEventWithDerivedText: MemoryVersionChangedEvent = {
  ...memoryVersionChanged,
  payload: {
    ...memoryVersionChanged.payload,
    // @ts-expect-error Stable memory events contain identifiers/classification, never derived text.
    derivedText: "must-not-cross-event",
  },
};

const memoryEventWithRawBody: MemoryVersionChangedEvent = {
  ...memoryVersionChanged,
  payload: {
    ...memoryVersionChanged.payload,
    // @ts-expect-error Stable memory events never carry raw source bodies.
    rawBody: "must-not-cross-event",
  },
};

const memoryEventWithProviderOutput: MemoryVersionChangedEvent = {
  ...memoryVersionChanged,
  payload: {
    ...memoryVersionChanged.payload,
    // @ts-expect-error Stable memory events never carry provider output.
    providerOutput: "must-not-cross-event",
  },
};

const memoryRepair: MemoryRepairRecord = {
  kind: "memory",
  roomId: "room-1",
  value: {
    recordType: "status",
    status: {
      roomId: "room-1",
      health: {
        state: "healthy",
        reason: "none",
        memoryWatermark: 1,
        corpusHead: 1,
        lag: 0,
        lastAttemptAt: "2026-08-19T00:02:00.000Z",
        retryable: false,
        recoveryRequired: false,
      },
      recoveryGeneration: 0,
      updatedAt: "2026-08-19T00:02:00.000Z",
    },
  },
};

const memoryRepairWithProviderMetadata: MemoryRepairRecord = {
  ...memoryRepair,
  // @ts-expect-error Repair records never expose provider metadata.
  providerMetadata: "must-not-cross-repair",
};

void reopenedFromArchive;
void archivedWithSecret;
void memoryEventWithDerivedText;
void memoryEventWithRawBody;
void memoryEventWithProviderOutput;
void memoryRepairWithProviderMetadata;
