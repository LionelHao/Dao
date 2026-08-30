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
  it("repairs and streams the canonical FT-08 lineage without preview or queued public state", () => {
    const occurredAt = "2026-08-25T00:00:00.000Z";
    const intent = {
      intentId: "intent-1", lineageId: "lineage-1", turnId: "turn-1", roomId: "room-1",
      sourceMessageId: "message-1", sourceRevision: 1, targetId: "target-1", agentId: "agent-1",
      origin: { kind: "message_target", messageTransactionId: "transaction-1", targetId: "target-1" },
      profileRevision: 1, assignmentRevision: 1, accessRevision: 1,
      status: "claimed", createdAt: occurredAt, claimedAt: occurredAt,
    } as const;
    const execution = {
      executionId: "execution-1", intentId: intent.intentId, lineageId: intent.lineageId,
      executionOrdinal: 1, roomId: intent.roomId, agentId: intent.agentId,
      snapshotId: "snapshot-1", providerId: "provider-1", modelId: "model-1",
      status: "running", phase: "waiting_confirmation", currentAttemptSeq: 1, version: 2,
      queuedAt: occurredAt, startedAt: occurredAt, updatedAt: occurredAt,
    } as const;
    const attempt = {
      executionId: execution.executionId, intentId: intent.intentId, lineageId: intent.lineageId,
      roomId: intent.roomId, agentId: intent.agentId,
      attemptSeq: 1, snapshotId: execution.snapshotId, providerId: execution.providerId,
      modelId: execution.modelId, status: "running", phase: "waiting_confirmation",
      executionVersion: 2, startedAt: occurredAt, updatedAt: occurredAt,
    } as const;
    const repair = (records: readonly unknown[]) => ({
      type: "room.repair.page", requestId: "request-repair", snapshotId: "repair-1",
      roomId: "room-1", page: 0, records, watermark: 3,
      snapshotChecksum: "sha256:ft08", hasMore: false, mode: "streaming",
      idleExpiresAt: "2026-08-25T00:01:00.000Z",
    });
    expect(isRoomRepairPage(repair([
      { kind: "agent-invocation-intent", value: intent },
      { kind: "agent-execution", value: execution },
      { kind: "agent-execution-attempt", value: attempt },
    ]))).toBe(true);
    expect(isRoomRepairPage(repair([
      { kind: "agent-execution", value: { ...execution, status: "queued", phase: "queued" } },
    ]))).toBe(false);
    expect(isRoomRepairPage(repair([
      { kind: "agent-execution", value: { ...execution, preview: "preview-sentinel" } },
    ]))).toBe(false);

    const event = (type: string, payload: unknown) => ({
      eventId: `event-${type}`, streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "agent-1", occurredAt, type, payload,
    });
    const delta = (roomEvent: unknown) => ({
      type: "room.sync.result", requestId: "request-sync", mode: "delta", events: [roomEvent],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 }, watermark: 1, hasMore: false,
    });
    expect(isRoomSyncResult(delta(event("agent.invocation.intent.changed", intent)))).toBe(true);
    expect(isRoomSyncResult(delta(event("agent.execution.changed", execution)))).toBe(true);
    expect(isRoomSyncResult(delta(event("agent.execution.attempt.changed", attempt)))).toBe(true);
    expect(isRoomSyncResult(delta(event("agent.execution.changed", {
      ...execution, providerDiagnostics: "must-not-cross-sync",
    })))).toBe(false);
  });

  it("accepts closed Message Authority and Attachment events plus active operational repair records", () => {
    const currentRevision = {
      messageId: "message-v2-1", revision: 1, body: "hello",
      revisedAt: "2026-08-19T00:00:00.000Z", revisedByActorId: "human-1",
    } as const;
    const active = {
      id: "message-v2-1", roomId: "room-1", authorId: "human-1",
      authorKind: "human", createdAt: "2026-08-19T00:00:00.000Z",
      lifecycle: "active", currentRevision, revisionCount: 1,
      mentionedTargets: [], attachments: [], targetOutcomes: [],
    } as const;
    const tombstone = {
      id: active.id, roomId: active.roomId, authorId: active.authorId,
      authorKind: "human", createdAt: active.createdAt, lifecycle: "recalled",
      recalledAt: "2026-08-19T00:02:00.000Z", revisionCount: 1,
    } as const;
    const event = (type: string, payload: unknown) => ({
      eventId: `event-${type}`, streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "human-1", occurredAt: "2026-08-19T00:03:00.000Z",
      type, payload,
    });
    const delta = (messageEvent: unknown) => ({
      type: "room.sync.result", requestId: "request-message-authority", mode: "delta",
      events: [messageEvent], nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 },
      watermark: 1, hasMore: false,
    });
    const repair = (record: unknown) => ({
      type: "room.repair.page", requestId: "request-message-repair",
      snapshotId: "snapshot-message", roomId: "room-1", page: 0, records: [record],
      watermark: 1, snapshotChecksum: "sha256:message", hasMore: false,
      mode: "streaming", idleExpiresAt: "2026-08-19T00:04:00.000Z",
    });

    expect(isRoomSyncResult(delta(event("room.message.accepted", active)))).toBe(true);
    expect(isRoomSyncResult(delta(event("room.message.revised", active)))).toBe(true);
    expect(isRoomSyncResult(delta(event("room.message.recalled", tombstone)))).toBe(true);
    expect(isRoomSyncResult(delta(event("room.message.recalled", {
      ...tombstone, body: "recalled-raw-sentinel",
    })))).toBe(false);
    expect(isRoomSyncResult(delta({
      ...event("room.message.accepted", active),
      payload: Object.defineProperty({ ...active }, "capability", { value: "hidden" }),
    }))).toBe(false);

    expect(isRoomRepairPage(repair({ kind: "timeline-message", value: tombstone }))).toBe(true);
    expect(isRoomRepairPage(repair({
      kind: "timeline-message", value: { ...tombstone, roomId: "room-2" },
    }))).toBe(false);
    expect(isRoomRepairPage(repair({
      kind: "message-revision", roomId: "room-1", value: currentRevision,
    }))).toBe(true);

    const attachment = {
      attachmentId: "attachment-1",
      roomId: "room-1",
      originalFilename: "requirements.txt",
      format: "txt",
      declaredMime: "text/plain",
      detectedMime: "text/plain",
      byteSize: 128,
      sha256: "a".repeat(64),
      uploaderActorId: "human-1",
      createdAt: "2026-08-19T00:00:00.000Z",
      readyAt: "2026-08-19T00:01:00.000Z",
      processingStatus: "ready",
      generation: 1,
      sourceMessageId: "message-v2-1",
      provenance: {
        scanner: { kind: "clamav", version: "1.5.3" },
        extraction: {
          method: "plain-text", tool: "builtin", version: "1",
          artifactSha256: "b".repeat(64), artifactByteSize: 42, pageCount: null,
        },
        ocr: null,
      },
    } as const;
    const boundEvent = {
      eventId: "event-attachment", streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "human-1", occurredAt: "2026-08-19T00:02:00.000Z",
      type: "room.attachment.bound",
      payload: { attachment, sourceEligibility: "bound-active" },
    } as const;
    expect(isRoomSyncResult(delta(boundEvent))).toBe(true);
    expect(isRoomSyncResult(delta({
      ...boundEvent,
      payload: { ...boundEvent.payload, objectKey: "object-secret" },
    }))).toBe(false);
    expect(isRoomRepairPage(repair({
      kind: "attachment", value: { attachment, sourceEligibility: "bound-active" },
    }))).toBe(true);
    expect(isRoomRepairPage(repair({
      kind: "attachment",
      value: { attachment: { ...attachment, sourceMessageId: null }, sourceEligibility: "bound-active" },
    }))).toBe(false);
  });

  it("keeps archive, reopen, and security-reduction lifecycle events distinct and closed", () => {
    const archivedGovernance = {
      roomId: "room-1", projectId: "room-1", lifecycle: "archived",
      governanceRevision: 4, ownerActorId: "human-1", archiveGeneration: 1,
      archivedAt: "2026-08-19T00:01:00.000Z",
    } as const;
    const activeGovernance = {
      roomId: "room-1", projectId: "room-1", lifecycle: "active",
      governanceRevision: 5, ownerActorId: "human-1", archiveGeneration: 1,
    } as const;
    const eventBase = {
      eventId: "event-lifecycle", streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "human-1", occurredAt: "2026-08-19T00:01:00.000Z",
    } as const;
    const archived = {
      ...eventBase,
      type: "room.archived",
      payload: { governance: archivedGovernance, archiveGeneration: 1, frozenTimerCount: 2 },
    } as const;
    const reopened = {
      ...eventBase,
      eventId: "event-reopened",
      type: "room.reopened",
      payload: { governance: activeGovernance, archiveGeneration: 1, resumedTimerCount: 1 },
    } as const;
    const reduced = {
      ...eventBase,
      eventId: "event-reduced",
      type: "room.security.reduced",
      payload: { governance: archivedGovernance, archiveGeneration: 1, assignmentRevision: 3 },
    } as const;
    const result = (event: unknown) => ({
      type: "room.sync.result", requestId: "request-lifecycle", mode: "delta",
      events: [event], nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 },
      watermark: 1, hasMore: false,
    });

    expect(isRoomSyncResult(result(archived))).toBe(true);
    expect(isRoomSyncResult(result(reopened))).toBe(true);
    expect(isRoomSyncResult(result(reduced))).toBe(true);
    expect(isRoomSyncResult(result({
      ...archived,
      payload: { room: { id: "room-1" } },
    }))).toBe(false);
    expect(isRoomSyncResult(result({
      ...reopened,
      payload: { ...reopened.payload, governance: archivedGovernance },
    }))).toBe(false);
    expect(isRoomSyncResult(result({
      ...reduced,
      payload: { ...reduced.payload, rawGrantToken: "secret" },
    }))).toBe(false);
    expect(isRoomSyncResult(result({
      ...archived,
      payload: { ...archived.payload, archiveGeneration: 2 },
    }))).toBe(false);
  });

  it("keeps governance delta and repair projections closed and room-bound", () => {
    const governance = {
      roomId: "room-1", projectId: "room-1", lifecycle: "active",
      governanceRevision: 3, ownerActorId: "human-1", archiveGeneration: 0,
    };
    const page = {
      type: "room.repair.page", requestId: "request-governance", snapshotId: "snapshot-1",
      roomId: "room-1", page: 0, records: [{ kind: "governance", value: governance }],
      watermark: 1, snapshotChecksum: "sha256:governance", hasMore: false,
      mode: "streaming", idleExpiresAt: "2026-08-18T00:00:30.000Z",
    };
    expect(isRoomRepairPage(page)).toBe(true);
    expect(isRoomRepairPage({ ...page, records: [{ kind: "governance", value: { ...governance, projectId: "project-2" } }] })).toBe(false);
    const event = {
      eventId: "event-governance", streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "human-1", occurredAt: "2026-08-18T00:00:00.000Z",
      type: "room.governance.changed", payload: { governance },
    };
    const result = {
      type: "room.sync.result", requestId: "request-governance", mode: "delta", events: [event],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 }, watermark: 1, hasMore: false,
    };
    expect(isRoomSyncResult(result)).toBe(true);
    expect(isRoomSyncResult({
      ...result, events: [{ ...event, payload: { governance: { ...governance, roomId: "room-2", projectId: "room-2" } } }],
    })).toBe(false);
  });
  it("accepts only the dedicated human-preemption room event", () => {
    const event = {
      eventId: "human-preemption-1", streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "human-1", occurredAt: "2026-08-17T00:00:01.000Z",
      type: "room.human_preemption.applied",
      payload: {
        roomId: "room-1", sourceHumanMessageId: "message-human-1",
        cancelledExecutionIds: ["execution-old-1"], rerouteStatus: "queued",
        occurredAt: "2026-08-17T00:00:01.000Z",
      },
    };
    const result = {
      type: "room.sync.result", requestId: "request-preemption", mode: "delta", events: [event],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 }, watermark: 1, hasMore: false,
    };
    expect(isRoomSyncResult(result)).toBe(true);
    expect(isRoomSyncResult({
      ...result, events: [{ ...event, payload: { ...event.payload, failed: true } }],
    })).toBe(false);
    expect(isRoomSyncResult({
      ...result, events: [{ ...event, payload: { ...event.payload, roomId: "room-2" } }],
    })).toBe(false);
  });

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
      reason: "operational_projection_changed",
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

  it("keeps LightTask repair records and events closed and room-bound", () => {
    const task = {
      id: "task-1", roomId: "room-1", sourceMessageId: "message-1", title: "Ship review",
      claimant: "human-1", claimantRoleAtClaim: "member", verifierRole: "owner",
      verifierActorId: "human-2", criteria: [{ id: "criterion-1", text: "Reviewed", met: true }],
      status: "delivered", createdAt: "2026-08-17T00:00:00.000Z",
      claimedAt: "2026-08-17T00:01:00.000Z", deliveredAt: "2026-08-17T00:02:00.000Z",
    };
    const page = {
      type: "room.repair.page", requestId: "request-1", snapshotId: "snapshot-1",
      roomId: "room-1", page: 0, records: [{ kind: "light-task", value: task }],
      watermark: 1, snapshotChecksum: "sha256:light-task", hasMore: false,
      mode: "streaming", idleExpiresAt: "2026-08-17T00:00:30.000Z",
    };
    expect(isRoomRepairPage(page)).toBe(true);
    expect(isRoomRepairPage({
      ...page,
      records: [{ kind: "light-task", value: { ...task, maturity: "stable" } }],
    })).toBe(false);

    const event = {
      eventId: "event-1", streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "human-1", occurredAt: "2026-08-17T00:02:00.000Z",
      type: "room.light_task.changed", payload: task,
    };
    const result = {
      type: "room.sync.result", requestId: "request-2", mode: "delta", events: [event],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 },
      watermark: 1, hasMore: false,
    };
    expect(isRoomSyncResult(result)).toBe(true);
    expect(isRoomSyncResult({
      ...result,
      events: [{ ...event, payload: { ...task, roomId: "room-2" } }],
    })).toBe(false);
  });

  it("accepts only agent-bound authoritative ball overdue events", () => {
    const ball = {
      holderId: "agent-1", roomId: "room-1", sourceKind: "open-item",
      sourceId: "item-1", reason: "open item awaits current owner",
      since: "2026-08-17T00:00:00.000Z", deadline: "2026-08-17T00:01:00.000Z",
    } as const;
    const event = {
      eventId: "event-ball", streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "agent-1", occurredAt: "2026-08-17T00:01:00.000Z",
      type: "room.ball.overdue",
      payload: {
        id: "trigger-1", roomId: "room-1", agentId: "agent-1", ball,
        triggeredAt: "2026-08-17T00:01:00.000Z",
      },
    } as const;
    const result = {
      type: "room.sync.result", requestId: "request-ball", mode: "delta", events: [event],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 1 },
      watermark: 1, hasMore: false,
    } as const;
    expect(isRoomSyncResult(result)).toBe(true);
    expect(isRoomSyncResult({ ...result, events: [{ ...event, actorId: "agent-2" }] })).toBe(false);
    expect(isRoomSyncResult({
      ...result, events: [{ ...event, payload: { ...event.payload, messageText: "我来" } }],
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

  it("integrates closed memory repair records and minimal ordered delta events", () => {
    const occurredAt = "2026-08-19T01:02:03.004Z";
    const sourceRef = {
      sourceKind: "message" as const,
      sourceId: "message:message-1",
      sourceRevision: 1,
      eligibility: "eligible" as const,
      availability: "readable" as const,
    };
    const projection = {
      projectionKind: "memory" as const,
      roomId: "room-1",
      memoryRecordId: "memory-record-1",
      kind: "context" as const,
      currentVersion: {
        roomId: "room-1",
        memoryRecordId: "memory-record-1",
        memoryVersionId: "memory-version-1",
        version: 1,
        kind: "context" as const,
        state: "active" as const,
        derivedText: "The production service is single-tenant.",
        sourceRefs: [sourceRef],
        createdAt: occurredAt,
        replacesMemoryVersionId: null,
      },
      disputes: [] as const,
      resolutions: [] as const,
    };
    const status = {
      roomId: "room-1",
      health: {
        state: "healthy" as const,
        reason: "none" as const,
        memoryWatermark: 1,
        corpusHead: 1,
        lag: 0,
        lastAttemptAt: occurredAt,
        retryable: false,
        recoveryRequired: false,
      },
      recoveryGeneration: 0,
      updatedAt: occurredAt,
    };
    const projectionRecord = {
      kind: "memory" as const,
      roomId: "room-1",
      value: { recordType: "projection" as const, projection },
    };
    const statusRecord = {
      kind: "memory" as const,
      roomId: "room-1",
      value: { recordType: "status" as const, status },
    };
    const repairPage = {
      type: "room.repair.page",
      requestId: "request-memory-repair",
      snapshotId: "snapshot-memory",
      roomId: "room-1",
      page: 0,
      records: [projectionRecord, statusRecord],
      watermark: 2,
      snapshotChecksum: "sha256:memory",
      hasMore: false,
      mode: "streaming",
      idleExpiresAt: "2026-08-19T01:03:00.000Z",
    };

    expect(isRoomRepairPage(repairPage)).toBe(true);
    expect(isRoomRepairPage({
      ...repairPage,
      records: [{ ...projectionRecord, roomId: "room-2" }],
    })).toBe(false);
    expect(isRoomRepairPage({
      ...repairPage,
      records: [{ ...projectionRecord, rawBody: "must-not-cross-repair" }],
    })).toBe(false);
    expect(isRoomRepairPage({
      ...repairPage,
      records: [{
        ...projectionRecord,
        value: {
          ...projectionRecord.value,
          projection: {
            ...projection,
            currentVersion: {
              ...projection.currentVersion,
              providerMetadata: "must-not-cross-repair",
            },
          },
        },
      }],
    })).toBe(false);

    const versionChanged = {
      eventId: "event-memory-version",
      streamKind: "room" as const,
      streamId: "room-1",
      streamSeq: 1,
      roomId: "room-1",
      actorId: "memory-steward",
      occurredAt,
      type: "room.memory.version.changed" as const,
      payload: {
        memoryRecordId: "memory-record-1",
        memoryVersionId: "memory-version-1",
        kind: "context" as const,
        state: "active" as const,
        sourceIds: ["message:message-1"],
        memoryWatermark: 1,
      },
    };
    const healthChanged = {
      eventId: "event-memory-health",
      streamKind: "room" as const,
      streamId: "room-1",
      streamSeq: 2,
      roomId: "room-1",
      actorId: "memory-steward",
      occurredAt,
      type: "room.memory.health.changed" as const,
      payload: status,
    };
    const delta = {
      type: "room.sync.result",
      requestId: "request-memory-delta",
      mode: "delta",
      events: [versionChanged, healthChanged],
      nextCursor: { version: 1, roomId: "room-1", afterSeq: 2 },
      watermark: 2,
      hasMore: false,
    };

    expect(isRoomSyncResult(delta)).toBe(true);
    expect(isRoomSyncResult({
      ...delta,
      events: [versionChanged, { ...healthChanged, eventId: versionChanged.eventId }],
    })).toBe(false);
    expect(isRoomSyncResult({
      ...delta,
      events: [healthChanged, versionChanged],
    })).toBe(false);
    expect(isRoomSyncResult({
      ...delta,
      events: [{
        ...versionChanged,
        payload: { ...versionChanged.payload, derivedText: "must-not-cross-event" },
      }, healthChanged],
    })).toBe(false);
    expect(isRoomSyncResult({
      ...delta,
      events: [{
        ...versionChanged,
        payload: { ...versionChanged.payload, rawBody: "must-not-cross-event" },
      }, healthChanged],
    })).toBe(false);
    expect(isRoomSyncResult({
      ...delta,
      events: [{
        ...versionChanged,
        payload: { ...versionChanged.payload, providerOutput: "must-not-cross-event" },
      }, healthChanged],
    })).toBe(false);
    expect(isRoomSyncResult({
      ...delta,
      events: [versionChanged, {
        ...healthChanged,
        payload: { ...status, roomId: "room-2" },
      }],
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

  it("accepts every closed Tool Safety record in a fixed-watermark repair page", () => {
    const page = (record: unknown) => ({
      type: "room.repair.page", requestId: "request-tool", snapshotId: "snapshot-tool",
      roomId: "room-1", page: 0, records: [record], watermark: 7,
      snapshotChecksum: "sha256:tool", hasMore: false, mode: "streaming",
      idleExpiresAt: "2026-08-30T08:01:00.000Z",
    });
    const preview = JSON.stringify({ schemaVersion: "tool-safe-preview.v1", target: "notes/a.txt",
      summary: "12 UTF-8 bytes", impact: "Writes one sandbox file", reversibility: "compensatable" });
    const records = [
      { kind: "tool-call", value: { toolCallId: "call-1", toolId: "sandbox-file.write",
        safePreview: preview, state: "prepared", version: 1, sourceRef: "message-1" } },
      { kind: "tool-handoff", value: { handoffId: "handoff-1", confirmationId: "confirmation-1",
        state: "offered", targetActorId: "human-2", targetNamedHumanDisplayRef: "Human B", version: 1 } },
      { kind: "tool-compensation", value: { lineageId: "lineage-1", originalDispatchId: "dispatch-1",
        compensationInvocationId: "invocation-2", compensationExecutionId: "execution-2",
        compensationToolCallId: "call-2", state: "pending", version: 1 } },
    ];
    for (const repairRecord of records) expect(isRoomRepairPage(page(repairRecord))).toBe(true);
    expect(isRoomRepairPage(page({ ...records[1], value: {
      ...(records[1] as { value: Record<string, unknown> }).value, targetActorId: undefined,
    } }))).toBe(false);
  });
});
