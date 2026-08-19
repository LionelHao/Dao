import type { PersistedRoomEvent } from "./index.js";

type ArchivedEvent = Extract<PersistedRoomEvent, { readonly type: "room.archived" }>;
type ReopenedEvent = Extract<PersistedRoomEvent, { readonly type: "room.reopened" }>;

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

void reopenedFromArchive;
void archivedWithSecret;
