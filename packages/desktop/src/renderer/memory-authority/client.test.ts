import type {
  RoomMemoryEvent,
  RoomMemoryPageFrame,
  RoomMemoryRepairRecord,
  RoomMemoryRequest,
  RoomMemorySourceView,
  RoomMemoryStatus,
  RoomMemoryVersionProjection,
} from "@native-im/core";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryAuthorityClientFailure,
  createMemoryAuthorityClient,
  type MemoryAuthorityRawBridge,
} from "./client.js";

const occurredAt = "2026-08-19T08:00:00.000Z";
const source: RoomMemorySourceView = {
  roomId: "room-1", sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
  corpusSeq: 1, occurredAt, eligibility: "eligible", availability: "readable",
  metadata: { speakerActorId: "human-1", speakerKind: "human", provenance: null },
  navigation: { kind: "message", messageId: "message-1" },
};
const projection: RoomMemoryVersionProjection = {
  projectionKind: "memory", roomId: "room-1", memoryRecordId: "memory-1", kind: "context",
  currentVersion: {
    roomId: "room-1", memoryRecordId: "memory-1", memoryVersionId: "memory-version-1",
    version: 1, kind: "context", state: "active", derivedText: "Use the reviewed migration plan.",
    sourceRefs: [{ sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
      eligibility: "eligible", availability: "readable" }],
    createdAt: occurredAt, replacesMemoryVersionId: null,
  },
  disputes: [], resolutions: [],
};
const status: RoomMemoryStatus = {
  roomId: "room-1",
  health: { state: "healthy", reason: "none", memoryWatermark: 1, corpusHead: 1, lag: 0,
    lastAttemptAt: occurredAt, retryable: false, recoveryRequired: false },
  recoveryGeneration: 1, updatedAt: occurredAt,
};
const page = (requestId: string): RoomMemoryPageFrame => ({
  type: "room.memory.page.v1", requestId, roomId: "room-1",
  items: [projection], nextCursor: null, status,
});

function bridge(request: MemoryAuthorityRawBridge["request"]): {
  value: MemoryAuthorityRawBridge;
  publish(input: unknown): void;
} {
  let listener: ((input: unknown) => void) | undefined;
  return {
    value: {
      request,
      onAuthorityInput(next) { listener = next; return () => { listener = undefined; }; },
    },
    publish(input) { listener?.(input); },
  };
}

describe("closed renderer Memory Authority client", () => {
  it("accepts one exact epoch-correlated response and rejects mismatched or extra fields", async () => {
    const raw = bridge(vi.fn(async (input) => ({
      accessEpoch: input.accessEpoch,
      frame: page(input.frame.requestId),
    })));
    const client = createMemoryAuthorityClient(raw.value);
    const request: RoomMemoryRequest = {
      type: "room.memory.query.v1", requestId: "query-1", roomId: "room-1", limit: 50,
    };
    await expect(client.request({ accessEpoch: 7, frame: request })).resolves.toEqual({
      accessEpoch: 7, frame: page("query-1"),
    });

    raw.value.request = vi.fn(async () => ({ accessEpoch: 7, frame: page("wrong-request") })) as never;
    await expect(client.request({ accessEpoch: 7, frame: request })).rejects.toMatchObject({
      error: { status: 503, code: "memory_dependency_unavailable" },
    });
    raw.value.request = vi.fn(async () => ({ accessEpoch: 7, frame: page("query-1"), secret: "x" })) as never;
    await expect(client.request({ accessEpoch: 7, frame: request })).rejects.toBeInstanceOf(
      MemoryAuthorityClientFailure,
    );
    client.close();
  });

  it("turns a closed 403 into a safe failure without exposing raw transport errors", async () => {
    const raw = bridge(async (input) => ({
      accessEpoch: input.accessEpoch,
      frame: {
        type: "error", status: 403, code: "room_forbidden", message: "Room access denied",
        requestId: input.frame.requestId, objectId: input.frame.roomId,
        retryable: false,
      },
    }));
    const client = createMemoryAuthorityClient(raw.value);
    await expect(client.request({ accessEpoch: 2, frame: {
      type: "room.memory.status.query.v1", requestId: "status-1", roomId: "room-1",
    } })).rejects.toMatchObject({ accessEpoch: 2, error: { status: 403, code: "room_forbidden" } });
  });

  it("publishes only exact event/projection, repair, connection, and revoke applications", () => {
    const raw = bridge(async () => { throw new Error("unused"); });
    const client = createMemoryAuthorityClient(raw.value);
    const inputs: unknown[] = [];
    client.subscribe((input) => inputs.push(input));
    const event: RoomMemoryEvent = {
      eventId: "event-1", streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "steward-1", occurredAt,
      type: "room.memory.version.changed",
      payload: { memoryRecordId: "memory-1", memoryVersionId: "memory-version-1",
        kind: "context", state: "active", sourceIds: ["message:message-1"], memoryWatermark: 1 },
    };
    const records: readonly RoomMemoryRepairRecord[] = [
      { kind: "memory", roomId: "room-1", value: { recordType: "projection", projection } },
      { kind: "memory", roomId: "room-1", value: { recordType: "status", status } },
    ];
    raw.publish({ type: "room.memory.event", accessEpoch: 3, event, projection });
    raw.publish({ type: "room.memory.repair.completed", roomId: "room-1", accessEpoch: 3,
      generation: 4, records });
    raw.publish({ type: "room.memory.connection", roomId: "room-1", accessEpoch: 3,
      connection: { status: "offline" } });
    raw.publish({ type: "room.memory.revoked", roomId: "room-1", accessEpoch: 4,
      scope: "room", purgeCompleted: true });
    raw.publish({ type: "room.memory.event", accessEpoch: 3, event, projection, rawBody: "forbidden" });
    raw.publish({ type: "room.memory.event", accessEpoch: 3, event,
      projection: { ...projection, roomId: "room-2" } });
    expect(inputs).toHaveLength(4);
    expect(JSON.stringify(inputs)).not.toMatch(/rawBody|secret|provider|extraction/iu);
    client.close();
  });

  it("accepts a source response only for the exact requested Room/source", async () => {
    const raw = bridge(async (input) => ({ accessEpoch: input.accessEpoch, frame: {
      type: "room.memory.source.v1", requestId: input.frame.requestId,
      roomId: "room-1", source,
    } }));
    const client = createMemoryAuthorityClient(raw.value);
    await expect(client.request({ accessEpoch: 1, frame: {
      type: "room.memory.source.query.v1", requestId: "source-1",
      roomId: "room-1", sourceId: "message:message-1",
    } })).resolves.toMatchObject({ frame: { source } });
  });
});
