import { describe, expect, it } from "vitest";
import {
  isRoomCursor,
  isRoomRepairPage,
  isRoomSyncResult,
  isSnapshotCompleted,
  isSnapshotVersion,
  isWorkspaceBootstrapPage,
} from "./sync.js";

describe("pure synchronization contracts", () => {
  it("accepts only versioned, non-negative room cursors", () => {
    expect(isRoomCursor({ version: 1, roomId: "room-1", afterSeq: 0 })).toBe(true);
    expect(isRoomCursor({
      version: 1,
      roomId: "room-1",
      afterSeq: 2,
      watermark: 5,
    })).toBe(true);
    expect(isRoomCursor({ version: 2, roomId: "room-1", afterSeq: 0 })).toBe(false);
    expect(isRoomCursor({ version: 1, roomId: "room-1", afterSeq: -1 })).toBe(false);
    expect(isRoomCursor({ version: 1, roomId: "room-1", afterSeq: 2, watermark: -1 })).toBe(false);
    expect(isRoomCursor({ version: 1, roomId: "room-1", afterSeq: 2, watermark: 1 })).toBe(false);
    expect(isRoomCursor({ version: 1, roomId: "room-1", afterSeq: 0, actorId: "human-1" })).toBe(false);
    expect(isRoomCursor({
      version: 1,
      roomId: "room-1",
      afterSeq: 2,
      watermark: 5,
      extra: true,
    })).toBe(false);
  });

  it("keeps materialized and streaming snapshot expiry fields mutually exclusive", () => {
    const page = {
      type: "workspace.bootstrap.page",
      requestId: "request-1",
      snapshotId: "snapshot-1",
      page: 0,
      rooms: [{ roomId: "room-1", name: "原生 IM", status: "active", role: "owner" }],
      catalogRevision: 2,
      snapshotChecksum: "sha256:catalog",
      hasMore: false,
      mode: "materialized",
      expiresAt: "2026-08-10T00:05:00.000Z",
    };
    expect(isWorkspaceBootstrapPage(page)).toBe(true);
    expect(isWorkspaceBootstrapPage({ ...page, idleExpiresAt: "2026-08-10T00:00:30.000Z" })).toBe(false);
    expect(isWorkspaceBootstrapPage({ ...page, mode: "streaming", expiresAt: undefined })).toBe(false);
  });

  it("validates repair records and business-level repair-required results", () => {
    const repairPage = {
      type: "room.repair.page",
      requestId: "request-1",
      snapshotId: "snapshot-1",
      roomId: "room-1",
      page: 0,
      records: [{
        kind: "human-read",
        value: {
          id: "read-1",
          messageId: "message-1",
          readerId: "human-1",
          readAt: "2026-08-10T00:00:00.000Z",
        },
      }],
      watermark: 4,
      snapshotChecksum: "sha256:room",
      hasMore: false,
      mode: "streaming",
      idleExpiresAt: "2026-08-10T00:00:30.000Z",
    };
    expect(isRoomRepairPage(repairPage)).toBe(true);
    expect(isRoomRepairPage({
      ...repairPage,
      records: [{ kind: "message", value: { id: "message-1", arbitrary: true } }],
    })).toBe(false);
    expect(isRoomRepairPage({
      ...repairPage,
      records: [{
        kind: "legacy-unknown-calibration",
        value: {
          id: "calibration-v3", sourceMessageId: null, actorId: null,
          agentId: "agent-1", emoji: "👍", createdAt: "2026-08-09T03:01:00.000Z",
        },
      }],
    })).toBe(true);
    expect(isRoomRepairPage({
      ...repairPage,
      records: [{
        kind: "legacy-unknown-calibration",
        value: {
          id: "calibration-v3", sourceMessageId: "null", actorId: "null",
          agentId: "agent-1", emoji: "👍", createdAt: "2026-08-09T03:01:00.000Z",
        },
      }],
    })).toBe(false);
    expect(isRoomSyncResult({
      type: "room.sync.result",
      requestId: "request-1",
      mode: "repair_required",
      reason: "cursor_expired",
      retainedFromSeq: 5,
      watermark: 8,
    })).toBe(true);
    expect(isRoomSyncResult({
      type: "room.sync.result",
      requestId: "request-1",
      mode: "repair_required",
      reason: "unknown",
      retainedFromSeq: 5,
      watermark: 8,
    })).toBe(false);
    expect(isRoomSyncResult({
      type: "room.sync.result",
      requestId: "request-1",
      mode: "repair_required",
      reason: "cursor_expired",
      retainedFromSeq: 0,
      watermark: 8,
    })).toBe(false);
    expect(isRoomSyncResult({
      type: "room.sync.result",
      requestId: "request-1",
      mode: "repair_required",
      reason: "cursor_expired",
      retainedFromSeq: 10,
      watermark: 8,
    })).toBe(false);
    expect(isRoomSyncResult({
      type: "room.sync.result",
      requestId: "request-1",
      mode: "delta",
      events: [{ arbitrary: true }],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 },
      watermark: 1,
      hasMore: false,
    })).toBe(false);
  });

  it("rejects impossible delta envelopes", () => {
    const event = (streamSeq: number, roomId = "room-1") => ({
      eventId: `event-${streamSeq}`,
      streamKind: "room",
      streamId: roomId,
      streamSeq,
      roomId,
      actorId: "human-1",
      occurredAt: "2026-08-11T00:00:00.000Z",
      type: "member.removed",
      payload: { targetActorId: "human-2" },
    });
    const valid = {
      type: "room.sync.result",
      requestId: "request-1",
      mode: "delta",
      events: [event(1), event(2)],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 2, watermark: 3 },
      watermark: 3,
      hasMore: true,
    };
    expect(isRoomSyncResult(valid)).toBe(true);
    expect(isRoomSyncResult({
      ...valid,
      events: [event(1), { ...event(2), eventId: "event-1" }],
    })).toBe(false);
    expect(isRoomSyncResult({ ...valid, events: [event(1), event(3)] })).toBe(false);
    expect(isRoomSyncResult({ ...valid, events: [event(1, "room-2"), event(2)] })).toBe(false);
    expect(isRoomSyncResult({
      ...valid,
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1, watermark: 3 },
    })).toBe(false);
    expect(isRoomSyncResult({
      ...valid,
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 4, watermark: 4 },
    })).toBe(false);
    expect(isRoomSyncResult({ ...valid, hasMore: false })).toBe(false);
    expect(isRoomSyncResult({
      ...valid,
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 2 },
    })).toBe(false);
    expect(isRoomSyncResult({
      ...valid,
      events: [event(1), event(2), event(3)],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 3, watermark: 3 },
      hasMore: false,
    })).toBe(false);
    expect(isRoomSyncResult({
      ...valid,
      events: [],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 2 },
      hasMore: false,
    })).toBe(false);
    expect(isRoomSyncResult({
      ...valid,
      events: [],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 3 },
      hasMore: false,
    })).toBe(true);
  });

  it("accepts only closed side-effect confirmation display facts", () => {
    const event = {
      eventId: "confirmation-event-1",
      streamKind: "room",
      streamId: "room-1",
      streamSeq: 1,
      roomId: "room-1",
      actorId: "agent-1",
      occurredAt: "2026-08-17T00:00:00.000Z",
      type: "agent.tool.confirmation-required",
      payload: {
        confirmationId: "confirmation-1",
        executionId: "execution-1",
        attemptSeq: 1,
        toolId: "sandbox-file.write",
        target: "sandbox-file.write",
        impact: "bounded-side-effect",
        reversibility: "compensatable",
        expiresAt: "2026-08-17T00:05:00.000Z",
      },
    };
    const result = {
      type: "room.sync.result",
      requestId: "request-1",
      mode: "delta",
      events: [event],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 },
      watermark: 1,
      hasMore: false,
    };
    expect(isRoomSyncResult(result)).toBe(true);
    expect(isRoomSyncResult({
      ...result,
      events: [{ ...event, payload: { ...event.payload, expiresAt: "not-a-date" } }],
    })).toBe(false);
    expect(isRoomSyncResult({
      ...result,
      events: [{ ...event, payload: { ...event.payload, parameterSha256: "secret-binding" } }],
    })).toBe(false);
  });

  it("repairs and streams only closed route jobs and per-agent judgments", () => {
    const job = {
      id: "route-job-1", roomId: "room-1", sourceMessageId: "message-1",
      status: "completed", currentAttempt: 2, topicKey: "topic-1",
      embeddingModelVersion: "dao-topic-embedding-v1", windowSize: 8,
      cosineThreshold: 0.82, roomPhase: "discussion",
      createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:02.000Z",
      completedAt: "2026-08-17T00:00:02.000Z",
    };
    const judgment = {
      id: "route-judgment-1", routeJobId: job.id, sourceMessageId: "message-1",
      agentId: "agent-1", outcome: "suppressed", reasonCode: "cooldown",
      reasonText: "same topic is cooling down", routeAttempt: 2,
      decidedAt: "2026-08-17T00:00:02.000Z",
    };
    const repairPage = {
      type: "room.repair.page", requestId: "request-1", snapshotId: "snapshot-1",
      roomId: "room-1", page: 0,
      records: [
        { kind: "route-job", value: job },
        { kind: "route-judgment", value: judgment },
      ],
      watermark: 2, snapshotChecksum: "sha256:route", hasMore: false,
      mode: "streaming", idleExpiresAt: "2026-08-17T00:00:30.000Z",
    };
    expect(isRoomRepairPage(repairPage)).toBe(true);
    expect(isRoomRepairPage({
      ...repairPage,
      records: [{ kind: "route-judgment", value: { ...judgment, outcome: "unknown" } }],
    })).toBe(false);

    const event = {
      eventId: "route-event-1", streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "human-1", occurredAt: "2026-08-17T00:00:02.000Z",
      type: "route.completed", payload: job,
    };
    const result = {
      type: "room.sync.result", requestId: "request-2", mode: "delta", events: [event],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 },
      watermark: 1, hasMore: false,
    };
    expect(isRoomSyncResult(result)).toBe(true);
    expect(isRoomSyncResult({
      ...result,
      events: [{ ...event, payload: { ...job, providerBody: "must-not-cross-sync" } }],
    })).toBe(false);
  });

  it("does not interchange room and catalog snapshot versions", () => {
    expect(isSnapshotVersion({ kind: "room", roomId: "room-1", watermark: 4 })).toBe(true);
    expect(isSnapshotVersion({ kind: "catalog", catalogRevision: 3 })).toBe(true);
    expect(isSnapshotVersion({ kind: "catalog", roomId: "room-1", catalogRevision: 3 })).toBe(false);
    expect(isSnapshotCompleted({
      type: "snapshot.completed",
      requestId: "request-1",
      snapshotId: "snapshot-1",
      version: { kind: "room", roomId: "room-1", watermark: 4 },
    })).toBe(true);
    expect(isSnapshotCompleted({
      type: "snapshot.completed",
      requestId: "request-1",
      snapshotId: "snapshot-1",
      version: { kind: "catalog", roomId: "room-1", catalogRevision: 3 },
    })).toBe(false);
  });
});
