import { describe, expect, it } from "vitest";
import * as core from "./index.js";
import {
  ROOM_MEMORY_LIMITS,
  isRoomMemoryDispute,
  isRoomMemoryError,
  isRoomMemoryEvent,
  isRoomMemoryHealth,
  isRoomMemoryKind,
  isRoomMemoryProjection,
  isRoomMemoryProtocolFrame,
  isRoomMemoryRawDeltaPage,
  isRoomMemoryRepairRecord,
  isRoomMemoryRequest,
  isRoomMemoryResolution,
  isRoomMemorySource,
  isRoomMemorySourceIdentity,
  isRoomMemorySourceView,
  isRoomMemoryStatus,
  isRoomMemoryVersion,
} from "./room-memory.js";

const occurredAt = "2026-08-19T01:02:03.004Z";

const sourceIdentity = {
  sourceKind: "message" as const,
  sourceId: "message:message-1",
  sourceRevision: 1,
};

const metadata = {
  speakerActorId: "human-1",
  speakerKind: "human" as const,
  provenance: "message-authority",
};

const source = {
  roomId: "room-1",
  corpusSeq: 1,
  ...sourceIdentity,
  serverStreamSeq: 9,
  occurredAt,
  eligibility: "eligible" as const,
  availability: "readable" as const,
  metadata,
  authorizedReadRef: {
    sourceKind: "message" as const,
    opaqueId: "message:message-1:revision:1",
  },
};

const sourceRef = {
  ...sourceIdentity,
  eligibility: "eligible" as const,
  availability: "readable" as const,
};

const version = {
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
};

const dispute = {
  disputeId: "dispute-1",
  roomId: "room-1",
  memoryRecordId: "memory-record-1",
  memoryVersionId: "memory-version-1",
  operatorActorId: "human-2",
  reason: "This constraint has changed.",
  status: "open" as const,
  createdAt: occurredAt,
};

const resolution = {
  resolutionId: "resolution-1",
  disputeId: "dispute-1",
  roomId: "room-1",
  memoryRecordId: "memory-record-1",
  fromMemoryVersionId: "memory-version-1",
  replacementMemoryVersionId: "memory-version-2",
  operatorActorId: "human-2",
  action: "re_evaluate" as const,
  reason: "Re-evaluated against the current sources.",
  resolvedAt: occurredAt,
};

const projection = {
  projectionKind: "memory" as const,
  roomId: "room-1",
  memoryRecordId: "memory-record-1",
  kind: "context" as const,
  currentVersion: version,
  disputes: [] as const,
  resolutions: [] as const,
};

const health = {
  state: "healthy" as const,
  reason: "none" as const,
  memoryWatermark: 1,
  corpusHead: 1,
  lag: 0,
  lastAttemptAt: occurredAt,
  retryable: false,
  recoveryRequired: false,
};

const status = {
  roomId: "room-1",
  health,
  recoveryGeneration: 0,
  updatedAt: occurredAt,
};

const sourceView = {
  roomId: "room-1",
  corpusSeq: 1,
  ...sourceIdentity,
  occurredAt,
  eligibility: "eligible" as const,
  availability: "readable" as const,
  metadata,
  navigation: {
    kind: "message" as const,
    messageId: "message-1",
  },
};

function hidden(value: object, key: PropertyKey, injected: unknown): object {
  Object.defineProperty(value, key, {
    configurable: true,
    enumerable: false,
    value: injected,
  });
  return value;
}

describe("FT-05 Room Memory Core contracts", () => {
  it("exports the complete closed Room Memory surface from the Core package root", () => {
    expect(core.ROOM_MEMORY_LIMITS).toBe(ROOM_MEMORY_LIMITS);
    expect(core.isRoomMemorySource).toBe(isRoomMemorySource);
    expect(core.isRoomMemoryVersion).toBe(isRoomMemoryVersion);
    expect(core.isRoomMemoryHealth).toBe(isRoomMemoryHealth);
    expect(core.isRoomMemoryRawDeltaPage).toBe(isRoomMemoryRawDeltaPage);
    expect(core.isRoomMemoryRequest).toBe(isRoomMemoryRequest);
    expect(core.isRoomMemoryProtocolFrame).toBe(isRoomMemoryProtocolFrame);
    expect(core.isRoomMemoryRepairRecord).toBe(isRoomMemoryRepairRecord);
  });

  it("closes the five memory kinds and every source identity component", () => {
    expect([
      "goal",
      "decision",
      "context",
      "next_action",
      "open_question_or_blocker",
    ].every(isRoomMemoryKind)).toBe(true);
    expect(isRoomMemoryKind("blocker")).toBe(false);
    expect(isRoomMemorySourceIdentity(sourceIdentity)).toBe(true);
    expect(isRoomMemorySourceIdentity({ ...sourceIdentity, sourceRevision: 0 })).toBe(false);
    expect(isRoomMemorySourceIdentity({ ...sourceIdentity, sourceKind: "attachment" })).toBe(false);
    expect(isRoomMemorySourceIdentity({ ...sourceIdentity, sourceId: "https://secret.test" })).toBe(false);
    expect(isRoomMemorySourceIdentity({ ...sourceIdentity, token: "secret" })).toBe(false);
  });

  it("accepts exact safe sources and rejects raw, secret, malformed, symbol, and hidden fields", () => {
    expect(isRoomMemorySource(source)).toBe(true);

    for (const candidate of [
      { ...source, corpusSeq: 0 },
      { ...source, sourceRevision: 0 },
      { ...source, serverStreamSeq: 0 },
      { ...source, serverStreamSeq: -1 },
      { ...source, occurredAt: "not-a-time" },
      { ...source, eligibility: "selected" },
      { ...source, availability: "body" },
      { ...source, body: "raw corpus" },
      { ...source, extractedText: "raw extraction" },
      { ...source, filename: "private.txt" },
      { ...source, path: "/private/object" },
      { ...source, url: "https://example.test/object" },
      { ...source, token: "secret" },
      {
        ...source,
        authorizedReadRef: { ...source.authorizedReadRef, sourceKind: "attachment_extraction" },
      },
      {
        ...source,
        metadata: { ...metadata, speakerActorId: null, speakerKind: "human" },
      },
      {
        ...source,
        metadata: { ...metadata, provenance: "x".repeat(ROOM_MEMORY_LIMITS.safeMetadataUtf8 + 1) },
      },
    ]) {
      expect(isRoomMemorySource(candidate)).toBe(false);
    }

    expect(isRoomMemorySource({ ...source, [Symbol("token")]: "secret" })).toBe(false);
    expect(isRoomMemorySource(hidden({ ...source }, "providerMetadata", "secret"))).toBe(false);
    expect(isRoomMemorySource({
      ...source,
      metadata: hidden({ ...metadata }, "body", "raw"),
    })).toBe(false);
  });

  it("enforces Context-only active/disputed/resolved states and bounded immutable support sets", () => {
    expect(isRoomMemoryVersion(version)).toBe(true);
    expect(isRoomMemoryVersion({ ...version, state: "proposal" })).toBe(false);
    expect(isRoomMemoryVersion({ ...version, kind: "decision", state: "active" })).toBe(false);
    expect(isRoomMemoryVersion({ ...version, kind: "decision", state: "proposal" })).toBe(true);
    expect(isRoomMemoryVersion({ ...version, kind: "goal", state: "disputed" })).toBe(false);
    expect(isRoomMemoryVersion({ ...version, sourceRefs: [] })).toBe(false);
    expect(isRoomMemoryVersion({ ...version, sourceRefs: [sourceRef, sourceRef] })).toBe(false);
    expect(isRoomMemoryVersion({ ...version, derivedText: "x".repeat(4_097) })).toBe(false);
    expect(isRoomMemoryVersion({ ...version, confirmedByActorId: "human-1" })).toBe(false);
    expect(isRoomMemoryVersion({ ...version, providerMetadata: { model: "secret" } })).toBe(false);
    expect(isRoomMemoryVersion({
      ...version,
      sourceRefs: [hidden({ ...sourceRef }, "body", "raw")],
    })).toBe(false);
  });

  it("keeps dispute and resolution chains exact, bounded, Human-attributed, and append-shaped", () => {
    expect(isRoomMemoryDispute(dispute)).toBe(true);
    expect(isRoomMemoryResolution(resolution)).toBe(true);
    expect(isRoomMemoryDispute({ ...dispute, reason: "" })).toBe(false);
    expect(isRoomMemoryDispute({ ...dispute, reason: "x".repeat(2_049) })).toBe(false);
    expect(isRoomMemoryDispute({ ...dispute, operatorKind: "agent" })).toBe(false);
    expect(isRoomMemoryResolution({ ...resolution, action: "activate" })).toBe(false);
    expect(isRoomMemoryResolution({ ...resolution, replacementMemoryVersionId: null })).toBe(false);
    expect(isRoomMemoryResolution({ ...resolution, providerOutput: "raw" })).toBe(false);
    expect(isRoomMemoryProjection(projection)).toBe(true);
    expect(isRoomMemoryProjection({
      ...projection,
      currentVersion: { ...version, roomId: "room-2" },
    })).toBe(false);
    expect(isRoomMemoryProjection({
      ...projection,
      disputes: [{ ...dispute, roomId: "room-2" }],
    })).toBe(false);
    expect(isRoomMemoryProjection({
      ...projection,
      disputes: [dispute, dispute],
    })).toBe(false);
    expect(isRoomMemoryProjection({
      ...projection,
      currentVersion: { ...version, state: "disputed" },
      disputes: [{ ...dispute, memoryVersionId: "memory-version-old" }],
    })).toBe(false);
    expect(isRoomMemoryProjection({
      ...projection,
      disputes: [{ ...dispute, status: "resolved" }],
    })).toBe(false);
  });

  it("separates future confirmed project references from steward memory state", () => {
    const reference = {
      projectionKind: "confirmed-project-reference" as const,
      roomId: "room-1",
      memoryRecordId: "memory-record-project-1",
      kind: "decision" as const,
      projectFactId: "project-fact-1",
      projectFactVersion: 2,
      derivedText: "Use the single-writer authority.",
      confirmedByActorId: "human-1",
      confirmedAt: occurredAt,
      sourceRefs: [sourceRef],
    };
    expect(isRoomMemoryProjection(reference)).toBe(true);
    expect(isRoomMemoryProjection({ ...reference, kind: "context" })).toBe(false);
    expect(isRoomMemoryProjection({ ...reference, state: "confirmed" })).toBe(false);
    expect(isRoomMemoryProjection({ ...reference, projectCommand: "confirm" })).toBe(false);
  });

  it("validates state-specific health, exact lag arithmetic, and recovery semantics", () => {
    expect(isRoomMemoryHealth(health)).toBe(true);
    expect(isRoomMemoryHealth({ ...health, corpusHead: 2 })).toBe(false);
    expect(isRoomMemoryHealth({ ...health, state: "catching_up", reason: "backlog", corpusHead: 2, lag: 1 }))
      .toBe(true);
    expect(isRoomMemoryHealth({ ...health, state: "catching_up", reason: "backlog" })).toBe(false);
    expect(isRoomMemoryHealth({ ...health, state: "noauth", reason: "provider_secret_missing" }))
      .toBe(true);
    expect(isRoomMemoryHealth({
      ...health,
      state: "degraded",
      reason: "invalid_provider_output",
      retryable: true,
    })).toBe(true);
    expect(isRoomMemoryHealth({
      ...health,
      state: "failed",
      reason: "checkpoint_discontinuity",
      recoveryRequired: true,
    })).toBe(true);
    expect(isRoomMemoryHealth({
      ...health,
      state: "failed",
      reason: "checkpoint_discontinuity",
      recoveryRequired: false,
    })).toBe(false);
    expect(isRoomMemoryHealth({ ...health, reason: "provider_body" })).toBe(false);
    expect(isRoomMemoryStatus(status)).toBe(true);
    expect(isRoomMemoryStatus({ ...status, provider: "openai" })).toBe(false);
  });

  it("closes the ordered raw-delta page without copying source bodies or leaking cursors across rooms", () => {
    const page = {
      roomId: "room-1",
      fromWatermarkExclusive: 0,
      toCorpusSeqInclusive: 1,
      authorizationEpoch: 3,
      cursor: null,
      entries: [source],
      nextCursor: null,
      hasMore: false,
    };
    expect(isRoomMemoryRawDeltaPage(page)).toBe(true);
    expect(isRoomMemoryRawDeltaPage({ ...page, fromWatermarkExclusive: 2 })).toBe(false);
    expect(isRoomMemoryRawDeltaPage({ ...page, entries: [source, source] })).toBe(false);
    expect(isRoomMemoryRawDeltaPage({
      ...page,
      entries: [{ ...source, roomId: "room-2" }],
    })).toBe(false);
    expect(isRoomMemoryRawDeltaPage({ ...page, hasMore: true })).toBe(false);
    expect(isRoomMemoryRawDeltaPage({ ...page, body: "raw corpus" })).toBe(false);
    expect(isRoomMemoryRawDeltaPage({
      ...page,
      entries: Object.assign([source], { token: "secret" }),
    })).toBe(false);
  });

  it("exposes only safe source navigation projections and enforces source-kind targets", () => {
    expect(isRoomMemorySourceView(sourceView)).toBe(true);
    expect(isRoomMemorySourceView({
      ...sourceView,
      navigation: { kind: "attachment", attachmentId: "attachment-1" },
    })).toBe(false);
    expect(isRoomMemorySourceView({ ...sourceView, authorizedReadRef: source.authorizedReadRef }))
      .toBe(false);
    expect(isRoomMemorySourceView({
      ...sourceView,
      navigation: { ...sourceView.navigation, body: "raw" },
    })).toBe(false);
  });

  it("accepts exactly the six public v1 requests and rejects all server-owned authority fields", () => {
    const requests = [
      {
        type: "room.memory.query.v1",
        requestId: "request-1",
        roomId: "room-1",
        cursor: null,
        limit: 25,
        kind: "context",
        state: "active",
      },
      {
        type: "room.memory.source.query.v1",
        requestId: "request-2",
        roomId: "room-1",
        sourceKind: "message",
        sourceId: "message:message-1",
        sourceRevision: 1,
      },
      {
        type: "room.memory.context.dispute.v1",
        requestId: "request-3",
        roomId: "room-1",
        memoryRecordId: "memory-record-1",
        expectedVersion: 1,
        reason: "The source changed.",
      },
      {
        type: "room.memory.context.resolve.v1",
        requestId: "request-4",
        roomId: "room-1",
        memoryRecordId: "memory-record-1",
        expectedVersion: 2,
        resolution: "re_evaluate",
        reason: "Use the replacement sources.",
      },
      {
        type: "room.memory.status.query.v1",
        requestId: "request-5",
        roomId: "room-1",
      },
      {
        type: "room.memory.retry.v1",
        requestId: "request-6",
        roomId: "room-1",
        expectedRecoveryGeneration: 4,
      },
    ] as const;

    expect(requests.every(isRoomMemoryRequest)).toBe(true);
    for (const field of [
      "actorId",
      "stewardId",
      "memoryWatermark",
      "eligibility",
      "sourceRevision",
      "providerMetadata",
      "confirmed",
    ]) {
      expect(isRoomMemoryRequest({ ...requests[2], [field]: "forged" })).toBe(false);
    }
    expect(isRoomMemoryRequest({ ...requests[0], limit: 51 })).toBe(false);
    expect(isRoomMemoryRequest({ ...requests[0], kind: "blocker" })).toBe(false);
    expect(isRoomMemoryRequest({ ...requests[3], resolution: "activate" })).toBe(false);
    expect(isRoomMemoryRequest(hidden({ ...requests[4] }, "provider", "secret"))).toBe(false);
  });

  it("validates request-correlated response frames, stable events, and minimal safe payloads", () => {
    const page = {
      type: "room.memory.page.v1" as const,
      requestId: "request-1",
      roomId: "room-1",
      items: [projection],
      nextCursor: null,
      status,
    };
    const sourceFrame = {
      type: "room.memory.source.v1" as const,
      requestId: "request-2",
      roomId: "room-1",
      source: sourceView,
    };
    const disputeAccepted = {
      type: "room.memory.context.dispute.accepted.v1" as const,
      requestId: "request-3",
      roomId: "room-1",
      dispute,
      projection: {
        ...projection,
        currentVersion: { ...version, state: "disputed" as const },
        disputes: [{ ...dispute, status: "open" as const }],
      },
    };
    const resolveAccepted = {
      type: "room.memory.context.resolve.accepted.v1" as const,
      requestId: "request-4",
      roomId: "room-1",
      resolution,
      projection: {
        ...projection,
        currentVersion: {
          ...version,
          memoryVersionId: "memory-version-2",
          version: 2,
          replacesMemoryVersionId: "memory-version-1",
        },
        disputes: [{ ...dispute, status: "resolved" as const }],
        resolutions: [resolution],
      },
    };
    const statusFrame = {
      type: "room.memory.status.v1" as const,
      requestId: "request-5",
      roomId: "room-1",
      status,
    };
    const retryAccepted = {
      type: "room.memory.retry.accepted.v1" as const,
      requestId: "request-6",
      roomId: "room-1",
      recoveryGeneration: 5,
      acceptedAt: occurredAt,
    };
    expect([
      page,
      sourceFrame,
      disputeAccepted,
      resolveAccepted,
      statusFrame,
      retryAccepted,
    ].every(isRoomMemoryProtocolFrame)).toBe(true);
    expect(isRoomMemoryProtocolFrame({ ...page, roomId: "room-2" })).toBe(false);
    expect(isRoomMemoryProtocolFrame({ ...sourceFrame, extraction: "raw" })).toBe(false);
    expect(isRoomMemoryProtocolFrame({ ...retryAccepted, actorId: "human-1" })).toBe(false);
    expect(isRoomMemoryProtocolFrame({ ...resolveAccepted, projection })).toBe(false);

    const event = {
      eventId: "event-memory-1",
      streamKind: "room" as const,
      streamId: "room-1",
      streamSeq: 12,
      roomId: "room-1",
      actorId: "human-1",
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
    expect(isRoomMemoryEvent(event)).toBe(true);
    expect(isRoomMemoryEvent({
      ...event,
      payload: { ...event.payload, derivedText: "do not persist" },
    })).toBe(false);
    expect(isRoomMemoryEvent({
      ...event,
      payload: { ...event.payload, kind: "decision", state: "active" },
    })).toBe(false);
    expect(isRoomMemoryEvent({ ...event, streamId: "room-2" })).toBe(false);
  });

  it("closes memory error status/code mappings and retry hints without diagnostic leakage", () => {
    const errors = [
      { status: 400, code: "invalid_request", retryable: false },
      { status: 401, code: "unauthenticated", retryable: false },
      { status: 403, code: "room_forbidden", retryable: false },
      { status: 404, code: "memory_not_found", retryable: false },
      { status: 409, code: "memory_version_conflict", retryable: true },
      { status: 410, code: "memory_source_gone", retryable: false },
      { status: 429, code: "memory_capacity_limited", retryable: true, retryAfterSeconds: 2 },
      { status: 503, code: "memory_unavailable", retryable: true, retryAfterSeconds: 2 },
    ].map((error, index) => ({
      type: "error" as const,
      requestId: `request-${index}`,
      message: "Memory request failed.",
      objectId: null,
      ...error,
    }));
    expect(errors.every(isRoomMemoryError)).toBe(true);
    expect(errors.every(isRoomMemoryProtocolFrame)).toBe(true);
    expect(isRoomMemoryError({ ...errors[0], status: 503 })).toBe(false);
    expect(isRoomMemoryError({ ...errors[6], retryAfterSeconds: undefined })).toBe(false);
    expect(isRoomMemoryError({ ...errors[0], path: "/private/db" })).toBe(false);
    expect(isRoomMemoryError({ ...errors[0], providerBody: "secret" })).toBe(false);
  });

  it("repairs only closed per-Room memory projections or status records", () => {
    const projectionRecord = {
      kind: "memory" as const,
      roomId: "room-1",
      value: {
        recordType: "projection" as const,
        projection,
      },
    };
    const statusRecord = {
      kind: "memory" as const,
      roomId: "room-1",
      value: {
        recordType: "status" as const,
        status,
      },
    };
    expect(isRoomMemoryRepairRecord(projectionRecord, "room-1")).toBe(true);
    expect(isRoomMemoryRepairRecord(statusRecord, "room-1")).toBe(true);
    expect(isRoomMemoryRepairRecord(projectionRecord, "room-2")).toBe(false);
    expect(isRoomMemoryRepairRecord({
      ...projectionRecord,
      value: { ...projectionRecord.value, projection: { ...projection, roomId: "room-2" } },
    })).toBe(false);
    expect(isRoomMemoryRepairRecord({ ...projectionRecord, body: "raw corpus" })).toBe(false);
    expect(isRoomMemoryRepairRecord(hidden({ ...statusRecord }, "prompt", "secret"))).toBe(false);
  });
});
