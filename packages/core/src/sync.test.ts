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
    expect(isRoomCursor({ version: 2, roomId: "room-1", afterSeq: 0 })).toBe(false);
    expect(isRoomCursor({ version: 1, roomId: "room-1", afterSeq: -1 })).toBe(false);
    expect(isRoomCursor({ version: 1, roomId: "room-1", afterSeq: 0, actorId: "human-1" })).toBe(false);
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
      mode: "delta",
      events: [{ arbitrary: true }],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 },
      watermark: 1,
      hasMore: false,
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
