import type {
  RoomMemoryContextDisputeAccepted,
  RoomMemoryPageFrame,
  RoomMemoryProjection,
  RoomMemorySourceFrame,
  RoomMemorySourceView,
  RoomMemoryStatus,
  RoomMemoryVersionProjection,
} from "@native-im/core";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryAuthorityClientFailure,
  type MemoryAuthorityClientApplication,
  type MemoryAuthorityClientPort,
  type MemoryAuthorityEpochRequest,
  type MemoryAuthorityEpochResponse,
} from "./client.js";
import { createMemoryAuthorityController } from "./controller.js";

const at = "2026-08-19T08:00:00.000Z";
const status: RoomMemoryStatus = {
  roomId: "room-1", health: { state: "healthy", reason: "none", memoryWatermark: 1,
    corpusHead: 1, lag: 0, lastAttemptAt: at, retryable: false, recoveryRequired: false },
  recoveryGeneration: 3, updatedAt: at,
};
const source: RoomMemorySourceView = {
  roomId: "room-1", sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
  corpusSeq: 1, occurredAt: at, eligibility: "eligible", availability: "readable",
  metadata: { speakerActorId: "human-1", speakerKind: "human", provenance: null },
  navigation: { kind: "message", messageId: "message-1" },
};
const projection = (text = "Use the reviewed migration plan.", version = 1): RoomMemoryVersionProjection => ({
  projectionKind: "memory", roomId: "room-1", memoryRecordId: "memory-1", kind: "context",
  currentVersion: { roomId: "room-1", memoryRecordId: "memory-1",
    memoryVersionId: `memory-version-${version}`, version, kind: "context", state: "active",
    derivedText: text, sourceRefs: [{ sourceKind: "message", sourceId: "message:message-1",
      sourceRevision: 1, eligibility: "eligible", availability: "readable" }],
    createdAt: at, replacesMemoryVersionId: version === 1 ? null : `memory-version-${version - 1}` },
  disputes: [], resolutions: [],
});

class Port implements MemoryAuthorityClientPort {
  listener: ((input: MemoryAuthorityClientApplication) => void) | undefined;
  readonly calls: MemoryAuthorityEpochRequest[] = [];
  constructor(readonly handle: (input: MemoryAuthorityEpochRequest) => Promise<MemoryAuthorityEpochResponse>) {}
  request(input: MemoryAuthorityEpochRequest): Promise<MemoryAuthorityEpochResponse> {
    this.calls.push(structuredClone(input));
    return this.handle(input);
  }
  subscribe(listener: (input: MemoryAuthorityClientApplication) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  close(): void {}
  publish(input: MemoryAuthorityClientApplication): void { this.listener?.(structuredClone(input)); }
}

function successfulPort(options: {
  readonly dispute?: (input: MemoryAuthorityEpochRequest) => Promise<MemoryAuthorityEpochResponse>;
} = {}): Port {
  return new Port(async (input) => {
    const frame = input.frame;
    if (frame.type === "room.memory.query.v1") {
      const result: RoomMemoryPageFrame = { type: "room.memory.page.v1", requestId: frame.requestId,
        roomId: frame.roomId, items: [projection()], nextCursor: null, status };
      return { accessEpoch: input.accessEpoch, frame: result };
    }
    if (frame.type === "room.memory.source.query.v1") {
      const result: RoomMemorySourceFrame = { type: "room.memory.source.v1", requestId: frame.requestId,
        roomId: frame.roomId, source };
      return { accessEpoch: input.accessEpoch, frame: result };
    }
    if (frame.type === "room.memory.context.dispute.v1" && options.dispute !== undefined) {
      return options.dispute(input);
    }
    if (frame.type === "room.memory.context.dispute.v1") {
      const result: RoomMemoryContextDisputeAccepted = {
        type: "room.memory.context.dispute.accepted.v1", requestId: frame.requestId, roomId: frame.roomId,
        dispute: { disputeId: "dispute-1", roomId: frame.roomId, memoryRecordId: frame.memoryRecordId,
          memoryVersionId: "memory-version-1", operatorActorId: "human-1", reason: frame.reason,
          status: "open", createdAt: at },
        projection: { ...projection("Disputed.", 2), currentVersion: {
          ...projection("Disputed.", 2).currentVersion, state: "disputed" } },
      };
      return { accessEpoch: input.accessEpoch, frame: result };
    }
    if (frame.type === "room.memory.context.resolve.v1") {
      return { accessEpoch: input.accessEpoch, frame: {
        type: "room.memory.context.resolve.accepted.v1", requestId: frame.requestId,
        roomId: frame.roomId,
        resolution: { resolutionId: "resolution-1", disputeId: "dispute-1",
          roomId: frame.roomId, memoryRecordId: frame.memoryRecordId,
          fromMemoryVersionId: "memory-version-1", replacementMemoryVersionId: "memory-version-2",
          operatorActorId: "human-1", action: frame.resolution, reason: frame.reason, resolvedAt: at },
        projection: projection("ACK resolve must not render", 2),
      } };
    }
    if (frame.type === "room.memory.retry.v1") {
      return { accessEpoch: input.accessEpoch, frame: {
        type: "room.memory.retry.accepted.v1", requestId: frame.requestId,
        roomId: frame.roomId, recoveryGeneration: frame.expectedRecoveryGeneration + 1,
        acceptedAt: at,
      } };
    }
    throw new Error("unexpected request");
  });
}

const context = (accessEpoch = 1) => ({
  roomId: "room-1", accessEpoch, lifecycle: "active" as const,
  viewer: { actorId: "human-1", currentHuman: true }, reducedMotion: false,
});

describe("production Memory Authority controller", () => {
  it("loads complete pages plus source navigation and emits only projection-backed panel state", async () => {
    const port = successfulPort();
    let sequence = 0;
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-${++sequence}` });
    const value = await controller.open(context(4));
    expect(value).toMatchObject({ accessEpoch: 4, panel: {
      query: { status: "ready" }, connection: { status: "online" },
      health: { memoryWatermark: 1 },
      memories: [{ memoryRecordId: "memory-1", derivedText: "Use the reviewed migration plan.",
        sources: [{ navigation: { kind: "message", messageId: "message-1" } }] }],
    } });
    expect(port.calls.map((call) => call.frame.type)).toEqual([
      "room.memory.query.v1", "room.memory.source.query.v1",
    ]);
    expect(JSON.stringify(value)).not.toMatch(/provider|prompt|rawBody|extraction|secret/iu);
  });

  it("requires a matching ACK requestId and never applies ACK projection as stable cache", async () => {
    const port = successfulPort({ dispute: async (input) => {
      const frame = input.frame as Extract<typeof input.frame, { type: "room.memory.context.dispute.v1" }>;
      return { accessEpoch: input.accessEpoch, frame: {
        type: "room.memory.context.dispute.accepted.v1", requestId: "wrong-request", roomId: frame.roomId,
        dispute: { disputeId: "dispute-1", roomId: frame.roomId, memoryRecordId: frame.memoryRecordId,
          memoryVersionId: "memory-version-1", operatorActorId: "human-1", reason: frame.reason,
          status: "open", createdAt: at },
        projection: { ...projection("ACK must not render", 2), currentVersion: {
          ...projection("ACK must not render", 2).currentVersion, state: "disputed" as const } },
      } };
    } });
    let sequence = 0;
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-${++sequence}` });
    await controller.open(context());
    const receipt = controller.dispute({ roomId: "room-1", memoryRecordId: "memory-1",
      expectedVersion: 1, reason: "The date changed." });
    expect(receipt.snapshot.panel.operation).toMatchObject({ status: "submitting", requestId: receipt.requestId });
    await vi.waitFor(() => expect(controller.current("room-1")?.panel.operation).toMatchObject({
      status: "failed", requestId: receipt.requestId,
    }));
    expect(controller.current("room-1")?.panel.memories[0]?.derivedText)
      .toBe("Use the reviewed migration plan.");
  });

  it("keeps last complete cache offline/repair-failed and disables writes before client I/O", async () => {
    const port = successfulPort();
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-1` });
    await controller.open(context(2));
    port.publish({ type: "room.memory.connection", roomId: "room-1", accessEpoch: 2,
      connection: { status: "offline" } });
    expect(controller.current("room-1")?.panel).toMatchObject({
      connection: { status: "offline" }, memories: [{ memoryRecordId: "memory-1" }],
    });
    const callsBefore = port.calls.length;
    const blocked = controller.dispute({ roomId: "room-1", memoryRecordId: "memory-1",
      expectedVersion: 1, reason: "offline" });
    expect(blocked.snapshot.panel.operation).toMatchObject({ status: "failed", error: { status: 503 } });
    expect(port.calls).toHaveLength(callsBefore);

    port.publish({ type: "room.memory.repair.failed", roomId: "room-1", accessEpoch: 2,
      generation: 9, errorCode: "checksum_mismatch" });
    expect(controller.current("room-1")?.panel).toMatchObject({
      connection: { status: "repair_failed" }, memories: [{ memoryRecordId: "memory-1" }],
    });
  });

  it("purges on matching 403 and on newer revoke, while stale epoch applications cannot restore data", async () => {
    const port = successfulPort({ dispute: async (input) => {
      throw new MemoryAuthorityClientFailure(input.accessEpoch, {
        type: "error", status: 403, code: "room_forbidden", message: "Room access denied",
        requestId: input.frame.requestId, objectId: "room-1", retryable: false,
      });
    } });
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-1` });
    await controller.open(context(5));
    controller.dispute({ roomId: "room-1", memoryRecordId: "memory-1",
      expectedVersion: 1, reason: "forbidden" });
    await vi.waitFor(() => expect(controller.current("room-1")?.panel.connection).toEqual({ status: "revoked" }));
    expect(controller.current("room-1")?.panel.memories).toEqual([]);

    port.publish({ type: "room.memory.event", accessEpoch: 5, event: {
      eventId: "event-stale", streamKind: "room", streamId: "room-1", streamSeq: 2,
      roomId: "room-1", actorId: "steward-1", occurredAt: at,
      type: "room.memory.version.changed", payload: { memoryRecordId: "memory-1",
        memoryVersionId: "memory-version-2", kind: "context", state: "active",
        sourceIds: ["message:message-1"], memoryWatermark: 2 },
    }, projection: projection("must stay purged", 2) });
    port.publish({ type: "room.memory.revoked", roomId: "room-1", accessEpoch: 6,
      scope: "room", purgeCompleted: true });
    expect(controller.current("room-1")).toMatchObject({ accessEpoch: 6,
      panel: { connection: { status: "revoked" }, memories: [] } });
  });

  it("fences a late old-epoch query after a newer epoch has loaded", async () => {
    let resolveOld!: (value: MemoryAuthorityEpochResponse) => void;
    const old = new Promise<MemoryAuthorityEpochResponse>((resolve) => { resolveOld = resolve; });
    const port = new Port(async (input) => {
      if (input.frame.type === "room.memory.query.v1" && input.accessEpoch === 1) return old;
      if (input.frame.type === "room.memory.query.v1") return { accessEpoch: input.accessEpoch, frame: {
        type: "room.memory.page.v1", requestId: input.frame.requestId, roomId: "room-1",
        items: [projection("new epoch")], nextCursor: null, status,
      } };
      if (input.frame.type === "room.memory.source.query.v1") return { accessEpoch: input.accessEpoch,
        frame: { type: "room.memory.source.v1", requestId: input.frame.requestId,
          roomId: "room-1", source } };
      throw new Error("unexpected");
    });
    let sequence = 0;
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-${++sequence}` });
    const oldOpen = controller.open(context(1));
    await controller.open(context(2));
    const oldRequest = port.calls.find((call) => call.accessEpoch === 1)!;
    resolveOld({ accessEpoch: 1, frame: { type: "room.memory.page.v1",
      requestId: oldRequest.frame.requestId, roomId: "room-1",
      items: [projection("old epoch")], nextCursor: null, status } });
    await oldOpen;
    expect(controller.current("room-1")).toMatchObject({ accessEpoch: 2,
      panel: { memories: [{ derivedText: "new epoch" }] } });
  });

  it("submits resolve/retry as intents while stable events alone update projection state", async () => {
    const port = successfulPort();
    let sequence = 0;
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-${++sequence}` });
    await controller.open(context());
    const disputed = { ...projection("Stable disputed state."), currentVersion: {
      ...projection("Stable disputed state.").currentVersion, state: "disputed" as const,
    }, disputes: [{ disputeId: "dispute-1", roomId: "room-1", memoryRecordId: "memory-1",
      memoryVersionId: "memory-version-1", operatorActorId: "human-1", reason: "Changed.",
      status: "open" as const, createdAt: at }] };
    port.publish({ type: "room.memory.event", accessEpoch: 1, event: {
      eventId: "event-disputed", streamKind: "room", streamId: "room-1", streamSeq: 2,
      roomId: "room-1", actorId: "steward-1", occurredAt: at,
      type: "room.memory.version.changed", payload: { memoryRecordId: "memory-1",
        memoryVersionId: "memory-version-1", kind: "context", state: "disputed",
        sourceIds: ["message:message-1"], memoryWatermark: 2 },
    }, projection: disputed });
    await vi.waitFor(() => expect(controller.current("room-1")?.panel.memories[0]).toMatchObject({
      state: "disputed", canResolve: true, derivedText: "Stable disputed state.",
    }));

    const resolve = controller.resolve({ roomId: "room-1", memoryRecordId: "memory-1",
      expectedVersion: 1, reason: "Re-evaluate with the new date." });
    await vi.waitFor(() => expect(controller.current("room-1")?.panel.operation).toMatchObject({
      status: "acknowledged", command: "resolve", requestId: resolve.requestId,
    }));
    expect(port.calls.find((call) => call.frame.type === "room.memory.context.resolve.v1")?.frame)
      .toMatchObject({ resolution: "re_evaluate", reason: "Re-evaluate with the new date." });
    expect(controller.current("room-1")?.panel.memories[0]?.derivedText).toBe("Stable disputed state.");

    port.publish({ type: "room.memory.event", accessEpoch: 1, event: {
      eventId: "event-health", streamKind: "room", streamId: "room-1", streamSeq: 3,
      roomId: "room-1", actorId: "steward-1", occurredAt: at,
      type: "room.memory.health.changed", payload: { ...status, health: {
        state: "degraded", reason: "provider_dependency_unavailable", memoryWatermark: 1,
        corpusHead: 2, lag: 1, lastAttemptAt: at, retryable: true, recoveryRequired: false,
      } },
    } });
    const retry = controller.retry({ roomId: "room-1" });
    await vi.waitFor(() => expect(controller.current("room-1")?.panel.operation).toMatchObject({
      status: "acknowledged", command: "retry", requestId: retry.requestId,
    }));
    expect(port.calls.find((call) => call.frame.type === "room.memory.retry.v1")?.frame)
      .toMatchObject({ expectedRecoveryGeneration: 3 });
  });

  it("atomically installs complete repair and retains it when the next repair is incomplete", async () => {
    const port = successfulPort();
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-repair` });
    await controller.open(context(2));
    port.publish({ type: "room.memory.repair.completed", roomId: "room-1", accessEpoch: 2,
      generation: 8, records: [
        { kind: "memory", roomId: "room-1", value: { recordType: "projection",
          projection: projection("Repaired complete cache.", 2) } },
        { kind: "memory", roomId: "room-1", value: { recordType: "status",
          status: { ...status, health: { ...status.health, memoryWatermark: 2, corpusHead: 2 } } } },
      ] });
    await vi.waitFor(() => expect(controller.current("room-1")?.panel).toMatchObject({
      connection: { status: "online" }, memories: [{ version: 2,
        derivedText: "Repaired complete cache." }], health: { memoryWatermark: 2 },
    }));
    port.publish({ type: "room.memory.repair.completed", roomId: "room-1", accessEpoch: 2,
      generation: 9, records: [{ kind: "memory", roomId: "room-1", value: {
        recordType: "projection", projection: projection("Incomplete repair.", 3),
      } }] });
    await vi.waitFor(() => expect(controller.current("room-1")?.panel.connection)
      .toEqual({ status: "repair_failed" }));
    expect(controller.current("room-1")?.panel.memories[0]?.derivedText).toBe("Repaired complete cache.");
  });

  it("keeps exact project-fact navigation explicitly unavailable and read-only", async () => {
    const projectSource: RoomMemorySourceView = { ...source,
      sourceKind: "project_fact_checkpoint", sourceId: "project-fact:fact-1:1",
      navigation: { kind: "project_fact", projectFactId: "fact-1" } };
    const projectProjection: RoomMemoryProjection = { ...projection("Project reference."),
      currentVersion: { ...projection("Project reference.").currentVersion,
        sourceRefs: [{ sourceKind: "project_fact_checkpoint", sourceId: "project-fact:fact-1:1",
          sourceRevision: 1, eligibility: "eligible", availability: "readable" }] } };
    const port = new Port(async (input) => input.frame.type === "room.memory.query.v1"
      ? { accessEpoch: input.accessEpoch, frame: { type: "room.memory.page.v1",
        requestId: input.frame.requestId, roomId: "room-1", items: [projectProjection],
        nextCursor: null, status } }
      : { accessEpoch: input.accessEpoch, frame: { type: "room.memory.source.v1",
        requestId: input.frame.requestId, roomId: "room-1", source: projectSource } });
    const controller = createMemoryAuthorityController({ client: port,
      createRequestId: (operation) => `${operation}-project` });
    const loaded = await controller.open(context());
    expect(loaded.panel.memories[0]?.sources[0]).toMatchObject({
      availability: "unavailable", navigation: { kind: "project_fact", projectFactId: "fact-1" },
    });
    expect(controller.navigate({ roomId: "room-1",
      navigation: { kind: "project_fact", projectFactId: "fact-1" } })).toBeUndefined();
  });
});
