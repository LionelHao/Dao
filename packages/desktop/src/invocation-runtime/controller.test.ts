import type { PersistedRoomEvent, RoomRepairRecord } from "@native-im/core";
import { describe, expect, it, vi } from "vitest";
import { authoritySnapshotChecksum, createDesktopAuthorityCache } from "../governance/authority-cache.js";
import { GovernanceTransportError } from "../governance/websocket-authority.js";
import { createInvocationController } from "./controller.js";

const at = "2026-08-25T00:00:00.000Z";
const intent = {
  intentId: "intent-1", lineageId: "lineage-1", turnId: "turn-1", roomId: "room-1",
  sourceMessageId: "message-1", sourceRevision: 1, targetId: "target-1", agentId: "agent-1",
  origin: { kind: "message_target" as const, messageTransactionId: "message-1", targetId: "target-1" },
  profileRevision: 1, assignmentRevision: 1, accessRevision: 1, status: "claimed" as const,
  createdAt: at, claimedAt: at,
};
const execution = {
  executionId: "execution-1", intentId: intent.intentId, lineageId: intent.lineageId,
  executionOrdinal: 1, roomId: "room-1", agentId: "agent-1", snapshotId: "snapshot-1",
  providerId: "provider-1", modelId: "model-1", status: "running" as const,
  phase: "waiting_confirmation" as const, currentAttemptSeq: 1, version: 2,
  queuedAt: at, startedAt: at, updatedAt: at,
};

async function seeded() {
  const records: readonly RoomRepairRecord[] = [{ kind: "room", value: {
    id: "room-1", name: "Room", status: "active", createdAt: at,
  } }, { kind: "governance", value: {
    roomId: "room-1", projectId: "project-1", lifecycle: "active", governanceRevision: 1,
    ownerActorId: "human-1", archiveGeneration: 0,
  } }, { kind: "timeline-message", value: {
    id: "message-1", roomId: "room-1", authorId: "human-1", authorKind: "human",
    createdAt: at, lifecycle: "active", currentRevision: { messageId: "message-1", revision: 1,
      body: "@agent", revisedAt: at, revisedByActorId: "human-1" }, revisionCount: 1,
    mentionedTargets: [], attachments: [], targetOutcomes: [],
  } }, { kind: "agent-invocation-intent", value: intent }, { kind: "agent-execution", value: execution }];
  const cache = createDesktopAuthorityCache();
  const checksum = authoritySnapshotChecksum("room", records);
  cache.beginRoom("room-1", "repair-1");
  cache.stageRoomPage({ type: "room.repair.page", requestId: "request-1", snapshotId: "repair-1",
    roomId: "room-1", page: 0, records, watermark: 5, snapshotChecksum: checksum,
    hasMore: false, mode: "materialized", expiresAt: at });
  expect(await cache.finalizeRoom("repair-1", checksum)).toBe(true);
  cache.commitRoom("room-1", 5, checksum);
  return cache;
}

describe("Invocation production controller", () => {
  it("keeps ACK transient and changes canonical status only after the stable event", async () => {
    const cache = await seeded();
    const controlInvocation = vi.fn().mockResolvedValue({ type: "invocation.cancel.ack",
      requestId: "cancel-1", receipt: {
        requestId: "cancel-1", fenceId: "fence-1", roomId: "room-1", lineageId: "lineage-1",
        scope: { kind: "execution", executionId: "execution-1", expectedVersion: 2 },
        reason: "human_cancelled", intentOutcomes: [{ intentId: "intent-1", outcome: "already_claimed" }],
        executionOutcomes: [{ executionId: "execution-1", outcome: "cancelled", version: 3 }],
        rejectedConfirmationIds: [], revokedGrantIds: [], preservedDispatchIds: [], committedAt: at,
      } });
    const controller = createInvocationController({ cache, transport: { controlInvocation },
      repairRoom: vi.fn().mockResolvedValue(undefined), session: () => ({ actorId: "human-1",
        sessionId: "session-1", accessToken: "secret", expiresAt: at }),
      createRequestId: () => "cancel-1" });
    await controller.getSurface({ roomId: "room-1" });
    const result = await controller.cancel({ roomId: "room-1", executionId: "execution-1", expectedVersion: 2 });
    expect(controlInvocation).toHaveBeenCalledWith({ type: "invocation.cancel", requestId: "cancel-1",
      executionId: "execution-1", expectedVersion: 2 });
    expect(result.state.executions[0]?.execution).toMatchObject({ status: "running", version: 2 });
    expect(result.state.operations[0]).toMatchObject({ status: "acknowledged" });
    const cancelled = { ...execution, status: "cancelled" as const, phase: "cancelled" as const,
      version: 3, updatedAt: "2026-08-25T00:00:01.000Z", completedAt: "2026-08-25T00:00:01.000Z",
      cancellationReason: "human_cancelled" as const };
    const event: PersistedRoomEvent = { eventId: "event-6", streamKind: "room", streamId: "room-1",
      streamSeq: 6, roomId: "room-1", actorId: "human-1", occurredAt: cancelled.updatedAt,
      type: "agent.execution.changed", payload: cancelled };
    cache.applyRoomEvents("room-1", [event], { version: 1, roomId: "room-1", afterSeq: 6 });
    const stable = await controller.getSurface({ roomId: "room-1" });
    expect(stable.executions[0]?.execution).toMatchObject({ status: "cancelled", version: 3 });
    expect(stable.operations).toEqual([]);
  });

  it.each([
    ["authentication_required", 401, "reauthenticate"], ["access_revoked", 403, "request-access"],
    ["execution_conflict", 409, "refresh-authority"], ["protocol_upgrade_required", 410, "upgrade-client"],
    ["rate_limited", 429, "retry-later"], ["service_unavailable", 503, "repair-room"],
  ] as const)("maps %s to a closed recovery without mutating execution", async (code, status, recovery) => {
    const cache = await seeded();
    const controller = createInvocationController({ cache, transport: { controlInvocation: vi.fn()
      .mockRejectedValue(new GovernanceTransportError(code)) }, repairRoom: vi.fn().mockResolvedValue(undefined),
      session: () => ({ actorId: "human-1", sessionId: "session-1", accessToken: "secret", expiresAt: at }),
      createRequestId: () => "request-1" });
    await controller.getSurface({ roomId: "room-1" });
    const result = await controller.cancel({ roomId: "room-1", executionId: "execution-1", expectedVersion: 2 });
    expect(result.state.executions[0]?.execution.status).toBe("running");
    expect(result.state.operations[0]).toMatchObject({ status: "failed", error: { status, recovery } });
  });

  it("fails closed offline and rejects stale expectedVersion before transport", async () => {
    const cache = await seeded();
    const controlInvocation = vi.fn();
    const controller = createInvocationController({ cache, transport: { controlInvocation },
      repairRoom: vi.fn().mockRejectedValue(new GovernanceTransportError("service_unavailable")),
      session: () => ({ actorId: "human-1", sessionId: "session-1", accessToken: "secret", expiresAt: at }),
      createRequestId: () => "request-1" });
    expect((await controller.getSurface({ roomId: "room-1" })).connection.status).toBe("offline");
    expect((await controller.cancel({ roomId: "room-1", executionId: "execution-1", expectedVersion: 1 }))
      .state.operations[0]).toMatchObject({ error: { status: 503 } });
    expect(controlInvocation).not.toHaveBeenCalled();
  });

  it("does not submit terminal cancel or a retry whose source was recalled", async () => {
    const cache = await seeded(); const controlInvocation = vi.fn();
    const failed = { ...execution, status: "failed" as const, phase: "failed" as const, version: 3,
      updatedAt: "2026-08-25T00:01:00.000Z", completedAt: "2026-08-25T00:01:00.000Z" };
    const tombstone = { id: "message-1", roomId: "room-1", authorId: "human-1" as const,
      authorKind: "human" as const, createdAt: at, lifecycle: "recalled" as const,
      recalledAt: "2026-08-25T00:01:00.000Z", revisionCount: 1 };
    const base = { streamKind: "room" as const, streamId: "room-1", roomId: "room-1",
      actorId: "human-1", occurredAt: "2026-08-25T00:01:00.000Z" };
    const events: readonly PersistedRoomEvent[] = [
      { ...base, eventId: "event-6", streamSeq: 6, type: "agent.execution.changed", payload: failed },
      { ...base, eventId: "event-7", streamSeq: 7, type: "room.message.recalled", payload: tombstone },
    ];
    cache.applyRoomEvents("room-1", events, { version: 1, roomId: "room-1", afterSeq: 7 });
    const controller = createInvocationController({ cache, transport: { controlInvocation },
      repairRoom: vi.fn().mockResolvedValue(undefined), session: () => ({ actorId: "human-1",
        sessionId: "session-1", accessToken: "secret", expiresAt: at }),
      createRequestId: () => "request-1" });
    await controller.getSurface({ roomId: "room-1" });
    expect((await controller.retry({ roomId: "room-1", executionId: "execution-1", expectedVersion: 3 }))
      .state.operations[0]).toMatchObject({ error: { status: 409 } });
    expect((await controller.cancel({ roomId: "room-1", executionId: "execution-1", expectedVersion: 3 }))
      .state.operations[0]).toMatchObject({ error: { status: 409 } });
    expect(controlInvocation).not.toHaveBeenCalled();
  });

  it("projects a revised source marker without invalidating the frozen execution", async () => {
    const cache = await seeded();
    const revised = {
      id: "message-1", roomId: "room-1", authorId: "human-1", authorKind: "human" as const,
      createdAt: at, lifecycle: "active" as const,
      currentRevision: { messageId: "message-1", revision: 2, body: "revised source",
        revisedAt: "2026-08-25T00:02:00.000Z", revisedByActorId: "human-1" },
      revisionCount: 2, mentionedTargets: [], attachments: [], targetOutcomes: [],
    };
    cache.applyRoomEvents("room-1", [{ eventId: "event-revised-6", streamKind: "room",
      streamId: "room-1", streamSeq: 6, roomId: "room-1", actorId: "human-1",
      occurredAt: revised.currentRevision.revisedAt, type: "room.message.revised", payload: revised }],
    { version: 1, roomId: "room-1", afterSeq: 6 });
    const controller = createInvocationController({ cache, transport: { controlInvocation: vi.fn() },
      repairRoom: vi.fn().mockResolvedValue(undefined), session: () => ({ actorId: "human-1",
        sessionId: "session-1", accessToken: "secret", expiresAt: at }),
      createRequestId: () => "request-1" });
    expect((await controller.getSurface({ roomId: "room-1" })).executions[0])
      .toMatchObject({ execution: { snapshotId: "snapshot-1" }, sourceLifecycle: "revised" });
  });
});
