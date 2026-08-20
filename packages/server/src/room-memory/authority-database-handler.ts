import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isRoomMemorySourceView,
  type RoomMemoryEvent,
  type RoomMemorySourceNavigation,
  type RoomMemorySourceView,
  type RoomMemoryVersionProjection,
} from "@native-im/core";
import {
  AuthorityDatabaseError,
  runAuthorityImmediateTransaction,
} from "../persistence/authority-database-handler.js";
import type { AuthorityWorkerErrorCode } from "../persistence/worker-protocol.js";
import { readMemoryCorpusSource } from "./corpus-database-authority.js";
import {
  RoomMemoryDatabaseAuthorityError,
  beginRoomMemoryAttempt,
  commitRoomMemoryPlan,
  createRoomMemoryJob,
  discoverRoomMemoryReadyRooms,
  disputeRoomMemoryContext,
  manualRetryRoomMemory,
  markRoomMemoryNoauth,
  markRoomMemoryProviderReady,
  queryRoomMemory,
  readRoomMemoryAttempt,
  readRoomMemoryJob,
  readRoomMemoryProjection,
  readRoomMemoryStatus,
  resolveRoomMemoryContext,
  settleRoomMemoryAttempt,
} from "./database-authority.js";
import type {
  MemoryAuthorityAuthorizedSource,
  MemoryAuthorityBatch,
  MemoryAuthorityOperation,
  MemoryAuthorityOperationResult,
} from "./authority-protocol.js";
import { memoryJobAsBatch } from "./authority-protocol.js";

const MEMORY_AUDIT_SCOPE = "room-memory-authority";

function fail(code: AuthorityWorkerErrorCode, message: string): never {
  throw new AuthorityDatabaseError(code, message);
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("base64url");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entry = value as Record<string, unknown>;
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(entry[key])}`).join(",")}}`;
  }
  throw new TypeError("Room memory canonical JSON rejected a value");
}

function appendRoomMemoryEvent(
  database: DatabaseSync,
  input: Readonly<{
    eventId: string;
    roomId: string;
    actorId: string;
    type: RoomMemoryEvent["type"];
    payload: RoomMemoryEvent["payload"];
    occurredAt: string;
  }>,
): void {
  const stream = database.prepare(
    "SELECT head_seq AS headSeq FROM streams WHERE stream_kind = 'room' AND stream_id = ?",
  ).get(input.roomId);
  if (typeof stream?.headSeq !== "number") fail("storage_unavailable", "Room memory stream was missing");
  const streamSeq = stream.headSeq + 1;
  database.prepare(
    "UPDATE streams SET head_seq = ? WHERE stream_kind = 'room' AND stream_id = ?",
  ).run(streamSeq, input.roomId);
  database.prepare(`
    INSERT INTO events (
      event_id, stream_kind, stream_id, stream_seq, room_id,
      actor_id, event_type, occurred_at, payload_json
    ) VALUES (?, 'room', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.eventId, input.roomId, streamSeq, input.roomId, input.actorId,
    input.type, input.occurredAt, canonicalJson(input.payload),
  );
  database.prepare(`
    INSERT INTO outbox_deliveries (
      id, event_id, target_kind, target_id, stream_seq, status,
      attempts, available_at, delivered_at, last_error
    ) VALUES (?, ?, 'room', ?, ?, 'pending', 0, ?, NULL, NULL)
  `).run(
    stableId("outbox", MEMORY_AUDIT_SCOPE, input.eventId),
    input.eventId, input.roomId, streamSeq, input.occurredAt,
  );
}

function causalActor(database: DatabaseSync, roomId: string, jobId?: string): string {
  if (jobId !== undefined) {
    const row = database.prepare(`
      SELECT source.source_actor_id AS actorId
      FROM room_memory_jobs AS job, json_each(job.frozen_sources_json) AS frozen
      JOIN room_memory_sources AS source
        ON source.room_id = job.room_id
       AND source.source_kind = json_extract(frozen.value, '$.sourceKind')
       AND source.source_id = json_extract(frozen.value, '$.sourceId')
       AND source.source_revision = json_extract(frozen.value, '$.sourceRevision')
      WHERE job.job_id = ? AND job.room_id = ? AND source.source_actor_id IS NOT NULL
      ORDER BY source.corpus_seq DESC LIMIT 1
    `).get(jobId, roomId);
    if (typeof row?.actorId === "string") return row.actorId;
  }
  const room = database.prepare("SELECT owner_actor_id AS actorId FROM rooms WHERE id = ?").get(roomId);
  if (typeof room?.actorId !== "string") fail("storage_unavailable", "Room memory audit actor was missing");
  return room.actorId;
}

function appendProjectionEvent(
  database: DatabaseSync,
  projection: RoomMemoryVersionProjection,
  memoryWatermark: number,
  actorId: string,
  occurredAt: string,
): void {
  const version = projection.currentVersion;
  appendRoomMemoryEvent(database, {
    eventId: stableId("room-memory-version", version.memoryVersionId),
    roomId: projection.roomId,
    actorId,
    type: "room.memory.version.changed",
    occurredAt,
    payload: {
      memoryRecordId: projection.memoryRecordId,
      memoryVersionId: version.memoryVersionId,
      kind: projection.kind,
      state: version.state,
      sourceIds: version.sourceRefs.map((source) => source.sourceId),
      memoryWatermark,
    },
  });
}

function appendHealthEvent(
  database: DatabaseSync,
  roomId: string,
  actorId: string,
  occurredAt: string,
): void {
  const status = readRoomMemoryStatus(database, roomId);
  appendRoomMemoryEvent(database, {
    eventId: stableId(
      "room-memory-health", roomId, String(status.recoveryGeneration),
      String(status.health.memoryWatermark), status.health.state, status.updatedAt,
    ),
    roomId,
    actorId,
    type: "room.memory.health.changed",
    occurredAt,
    payload: status,
  });
}

function requireHumanSession(
  database: DatabaseSync,
  operation: Extract<MemoryAuthorityOperation, { type: "memory.public" }>,
): string {
  const session = database.prepare(`
    SELECT session.family_id AS familyId, session.account_id AS accountId,
           session.actor_id AS actorId, session.access_expires_at AS accessExpiresAt,
           session.revoked_at AS revokedAt, actor.kind AS actorKind
    FROM sessions AS session JOIN actors AS actor ON actor.id = session.actor_id
    WHERE session.access_token_hash = ?
  `).get(operation.context.sessionId);
  if (session === undefined) fail("invalid_token", "Room memory session was rejected");
  if (session.actorKind !== "human" || session.familyId !== operation.context.sessionFamilyId ||
      session.accountId !== operation.context.principal.accountId ||
      session.actorId !== operation.context.principal.actorId) {
    fail("identity_forbidden", "Room memory identity was rejected");
  }
  if (typeof session.revokedAt === "number") fail("session_revoked", "Room memory session was revoked");
  if (typeof session.accessExpiresAt !== "number" || operation.now >= session.accessExpiresAt) {
    fail("token_expired", "Room memory session expired");
  }
  return operation.context.principal.actorId;
}

function requireCurrentHumanMembership(
  database: DatabaseSync,
  roomId: string,
  actorId: string,
): "active" | "archived" {
  const row = database.prepare(`
    SELECT room.status AS roomStatus
    FROM room_memberships AS membership
    JOIN actors AS actor ON actor.id = membership.actor_id AND actor.kind = 'human'
    JOIN rooms AS room ON room.id = membership.room_id
    WHERE membership.room_id = ? AND membership.actor_id = ? AND membership.kind = 'human'
  `).get(roomId, actorId);
  if (row?.roomStatus !== "active" && row?.roomStatus !== "archived") {
    const room = database.prepare("SELECT 1 AS present FROM rooms WHERE id = ?").get(roomId);
    fail(room === undefined ? "room_not_found" : "room_forbidden", "Room memory access was rejected");
  }
  return row.roomStatus;
}

function mapDatabaseError(error: unknown): never {
  if (!(error instanceof RoomMemoryDatabaseAuthorityError)) throw error;
  const mapping: Readonly<Record<typeof error.code, AuthorityWorkerErrorCode>> = {
    invalid_input: "invalid_request",
    room_not_found: "room_not_found",
    record_not_found: "memory_not_found",
    job_not_found: "memory_unavailable",
    attempt_not_found: "memory_unavailable",
    room_archived: "room_archived",
    noauth: "memory_dependency_unavailable",
    forbidden: "room_forbidden",
    idempotency_conflict: "idempotency_conflict",
    version_conflict: "memory_version_conflict",
    generation_conflict: "memory_recovery_generation_conflict",
    source_stale: "memory_source_gone",
    invalid_plan: "memory_unavailable",
    storage_invariant: "storage_unavailable",
  };
  return fail(mapping[error.code], `Room memory authority rejected ${error.code}`);
}

function sourceView(database: DatabaseSync, operation: Extract<MemoryAuthorityOperation, { type: "memory.public" }>): RoomMemorySourceView {
  const request = operation.request;
  if (request.type !== "room.memory.source.query.v1") fail("invalid_request", "Room memory source request was invalid");
  const source = readMemoryCorpusSource(database, {
    roomId: request.roomId,
    sourceKind: request.sourceKind,
    sourceId: request.sourceId,
    sourceRevision: request.sourceRevision,
  });
  if (source === undefined) fail("memory_source_not_found", "Room memory source was not found");
  const metadata = source.safeMetadata;
  let navigation: RoomMemorySourceNavigation;
  let provenance: string | null = null;
  if (source.sourceKind === "message" || source.sourceKind === "message_revision") {
    if (!("messageId" in metadata) || !("authorKind" in metadata)) fail("storage_unavailable", "Memory source metadata was corrupt");
    navigation = { kind: "message", messageId: metadata.messageId };
    provenance = "message-authority";
  } else if (source.sourceKind === "message_tombstone") {
    if (!("messageId" in metadata)) fail("storage_unavailable", "Memory tombstone metadata was corrupt");
    navigation = { kind: "tombstone", messageId: metadata.messageId };
    provenance = "message-authority";
  } else if (source.sourceKind === "attachment_extraction") {
    if (!("attachmentId" in metadata)) fail("storage_unavailable", "Memory attachment metadata was corrupt");
    navigation = { kind: "attachment", attachmentId: metadata.attachmentId };
    provenance = "attachment-authority";
  } else {
    if (!("aggregateId" in metadata)) fail("storage_unavailable", "Memory project metadata was corrupt");
    navigation = { kind: "project_fact", projectFactId: metadata.aggregateId };
    provenance = "project-authority";
  }
  const result: RoomMemorySourceView = Object.freeze({
    roomId: source.roomId,
    corpusSeq: source.corpusSeq,
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    sourceRevision: source.sourceRevision,
    occurredAt: source.occurredAt,
    eligibility: source.eligibility,
    availability: source.availability,
    metadata: Object.freeze({
      speakerActorId: source.sourceActorId,
      speakerKind: "authorKind" in metadata ? metadata.authorKind : null,
      provenance,
    }),
    navigation: Object.freeze(navigation),
  });
  if (!isRoomMemorySourceView(result)) fail("storage_unavailable", "Memory source projection was corrupt");
  return result;
}

function latestReevaluationProof(database: DatabaseSync, roomId: string): Readonly<{
  jobId: string;
  attemptId: string;
  recoveryGeneration: number;
  resultSha256: string;
}> | null {
  const row = database.prepare(`
    SELECT job.job_id AS jobId, attempt.attempt_id AS attemptId,
           job.recovery_generation AS recoveryGeneration, job.result_sha256 AS resultSha256
    FROM room_memory_jobs AS job JOIN room_memory_attempts AS attempt ON attempt.job_id = job.job_id
    WHERE job.room_id = ? AND job.status = 'completed' AND attempt.status = 'succeeded'
    ORDER BY job.completed_at DESC, attempt.attempt_number DESC LIMIT 1
  `).get(roomId);
  if (typeof row?.jobId !== "string" || typeof row.attemptId !== "string" ||
      typeof row.recoveryGeneration !== "number" || typeof row.resultSha256 !== "string") return null;
  return {
    jobId: row.jobId,
    attemptId: row.attemptId,
    recoveryGeneration: row.recoveryGeneration,
    resultSha256: row.resultSha256,
  };
}

function executePublic(
  database: DatabaseSync,
  operation: Extract<MemoryAuthorityOperation, { type: "memory.public" }>,
): MemoryAuthorityOperationResult {
  return runAuthorityImmediateTransaction(database, () => {
    const actorId = requireHumanSession(database, operation);
    const lifecycle = requireCurrentHumanMembership(database, operation.request.roomId, actorId);
    const request = operation.request;
    const occurredAt = new Date(operation.now).toISOString();
    try {
      if (request.type === "room.memory.query.v1") {
        const result = queryRoomMemory(database, {
          roomId: request.roomId,
          limit: request.limit ?? 20,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.kind === undefined ? {} : { kind: request.kind }),
          ...(request.state === undefined ? {} : { state: request.state }),
        });
        return { kind: "public", frame: {
          type: "room.memory.page.v1", requestId: request.requestId, roomId: request.roomId,
          items: result.items, nextCursor: result.nextCursor,
          status: readRoomMemoryStatus(database, request.roomId),
        } };
      }
      if (request.type === "room.memory.source.query.v1") {
        return { kind: "public", frame: {
          type: "room.memory.source.v1", requestId: request.requestId,
          roomId: request.roomId, source: sourceView(database, operation),
        } };
      }
      if (request.type === "room.memory.status.query.v1") {
        return { kind: "public", frame: {
          type: "room.memory.status.v1", requestId: request.requestId,
          roomId: request.roomId, status: readRoomMemoryStatus(database, request.roomId),
        } };
      }
      if (lifecycle === "archived") fail("room_archived", "Archived Room memory is read-only");
      if (request.type === "room.memory.context.dispute.v1") {
        const result = disputeRoomMemoryContext(database, {
          roomId: request.roomId, actorId, requestId: request.requestId,
          memoryRecordId: request.memoryRecordId, expectedVersion: request.expectedVersion,
          reason: request.reason, occurredAt,
        });
        if (!result.replayed) {
          appendProjectionEvent(
            database, result.projection, readRoomMemoryStatus(database, request.roomId).health.memoryWatermark,
            actorId, occurredAt,
          );
        }
        return { kind: "public", frame: {
          type: "room.memory.context.dispute.accepted.v1", requestId: request.requestId,
          roomId: request.roomId, dispute: result.dispute, projection: result.projection,
        } };
      }
      if (request.type === "room.memory.context.resolve.v1") {
        const current = readRoomMemoryProjection(database, request.roomId, request.memoryRecordId);
        const proof = latestReevaluationProof(database, request.roomId);
        const result = resolveRoomMemoryContext(database, {
          roomId: request.roomId, actorId, requestId: request.requestId,
          memoryRecordId: request.memoryRecordId, expectedVersion: request.expectedVersion,
          action: request.resolution, reason: request.reason,
          replacementDerivedText: current.currentVersion.derivedText,
          sourceRefs: current.currentVersion.sourceRefs.map((source) => ({
            sourceKind: source.sourceKind,
            sourceId: source.sourceId,
            sourceRevision: source.sourceRevision,
          })),
          reevaluationProof: proof,
          occurredAt,
        });
        if (!result.replayed) {
          appendProjectionEvent(
            database, result.projection, readRoomMemoryStatus(database, request.roomId).health.memoryWatermark,
            actorId, occurredAt,
          );
        }
        return { kind: "public", frame: {
          type: "room.memory.context.resolve.accepted.v1", requestId: request.requestId,
          roomId: request.roomId, resolution: result.resolution, projection: result.projection,
        } };
      }
      const retry = manualRetryRoomMemory(database, {
        roomId: request.roomId, actorId, requestId: request.requestId,
        expectedRecoveryGeneration: request.expectedRecoveryGeneration,
        jobId: stableId("room-memory-manual-job", request.roomId, request.requestId),
        attemptId: stableId("room-memory-manual-attempt", request.roomId, request.requestId),
        inputSha256: createHash("sha256").update(canonicalJson(request)).digest("hex"),
        batchSize: 32, acceptedAt: occurredAt,
      });
      if (!retry.replayed) appendHealthEvent(database, request.roomId, actorId, occurredAt);
      return { kind: "public", frame: {
        type: "room.memory.retry.accepted.v1", requestId: request.requestId,
        roomId: request.roomId, recoveryGeneration: retry.recoveryGeneration, acceptedAt: occurredAt,
      } };
    } catch (error: unknown) {
      return mapDatabaseError(error);
    }
  });
}

function assertRunningBatch(database: DatabaseSync, batch: MemoryAuthorityBatch): ReturnType<typeof readRoomMemoryJob> {
  const job = readRoomMemoryJob(database, batch.jobId);
  const attempt = readRoomMemoryAttempt(database, batch.attemptId);
  if (job === undefined || attempt === undefined || job.roomId !== batch.roomId ||
      attempt.jobId !== batch.jobId || job.status !== "running" || attempt.status !== "running" ||
      job.recoveryGeneration !== batch.recoveryGeneration ||
      job.fromWatermarkExclusive !== batch.fromWatermarkExclusive ||
      job.toCorpusSeqInclusive !== batch.toCorpusSeqInclusive || job.sourceCount !== batch.sourceCount) {
    fail("memory_recovery_generation_conflict", "Memory steward batch was stale");
  }
  return job;
}

function authorizeSource(
  database: DatabaseSync,
  operation: Extract<MemoryAuthorityOperation, { type: "memory.source-authorize" }>,
): MemoryAuthorityAuthorizedSource {
  const job = assertRunningBatch(database, operation.batch);
  if (job === undefined) fail("memory_unavailable", "Memory steward job was missing");
  const frozen = job.frozenSources.find((source) => source.sourceKind === operation.sourceKind &&
    source.sourceId === operation.sourceId && source.sourceRevision === operation.sourceRevision);
  if (frozen === undefined || frozen.eligibility !== "eligible" || frozen.availability !== "readable") {
    fail("memory_source_gone", "Memory steward source was not eligible in the frozen batch");
  }
  const source = readMemoryCorpusSource(database, {
    roomId: operation.batch.roomId,
    sourceKind: operation.sourceKind,
    sourceId: operation.sourceId,
    sourceRevision: operation.sourceRevision,
  });
  if (source === undefined || source.eligibility !== "eligible" || source.availability !== "readable") {
    fail("memory_source_gone", "Memory steward source was no longer eligible");
  }
  const room = database.prepare("SELECT status FROM rooms WHERE id = ?").get(operation.batch.roomId);
  if (room?.status !== "active") fail("room_archived", "Archived Room steward work is frozen");
  if (source.sourceKind === "message" || source.sourceKind === "message_revision") {
    const metadata = source.safeMetadata;
    if (!("messageId" in metadata) || !("authorKind" in metadata)) {
      fail("storage_unavailable", "Memory message metadata was corrupt");
    }
    const row = database.prepare(`
      SELECT revision.body
      FROM message_envelopes AS envelope
      JOIN message_revisions AS revision ON revision.message_id = envelope.message_id
        AND revision.revision = envelope.current_revision
      WHERE envelope.room_id = ? AND envelope.message_id = ? AND envelope.lifecycle = 'active'
        AND envelope.current_revision = ?
    `).get(operation.batch.roomId, metadata.messageId, source.sourceRevision);
    if (typeof row?.body !== "string") fail("memory_source_gone", "Memory message source was no longer current");
    return Object.freeze({
      kind: "message", roomId: operation.batch.roomId, sourceKind: source.sourceKind,
      sourceId: source.sourceId, sourceRevision: source.sourceRevision,
      corpusSeq: source.corpusSeq, content: row.body,
    });
  }
  if (source.sourceKind !== "attachment_extraction") {
    fail("memory_source_gone", "Memory steward source is metadata-only");
  }
  const metadata = source.safeMetadata;
  if (!("attachmentId" in metadata) || !("messageId" in metadata)) {
    fail("storage_unavailable", "Memory attachment metadata was corrupt");
  }
  const row = database.prepare(`
    SELECT artifact.object_key AS objectKey, artifact.sha256, artifact.byte_size AS byteSize
    FROM attachments AS attachment
    JOIN message_attachment_links AS link ON link.attachment_id = attachment.attachment_id
      AND link.room_id = attachment.room_id AND link.message_id = ?
    JOIN message_envelopes AS envelope ON envelope.message_id = link.message_id
      AND envelope.room_id = link.room_id
    JOIN attachment_extraction_artifacts AS artifact
      ON artifact.attachment_id = attachment.attachment_id
     AND artifact.processing_generation = attachment.processing_generation
    WHERE attachment.attachment_id = ? AND attachment.room_id = ?
      AND attachment.processing_generation = ? AND attachment.processing_status = 'ready'
      AND attachment.source_operational_state = 'bound-active'
      AND link.operational_state = 'active' AND envelope.lifecycle = 'active'
    ORDER BY artifact.artifact_id LIMIT 1
  `).get(metadata.messageId, metadata.attachmentId, operation.batch.roomId, source.sourceRevision);
  if (typeof row?.objectKey !== "string" || typeof row.sha256 !== "string" ||
      typeof row.byteSize !== "number" || !Number.isSafeInteger(row.byteSize) || row.byteSize < 0) {
    fail("memory_source_gone", "Memory attachment extraction was no longer eligible");
  }
  return Object.freeze({
    kind: "attachment", roomId: operation.batch.roomId, sourceKind: "attachment_extraction",
    sourceId: source.sourceId, sourceRevision: source.sourceRevision,
    corpusSeq: source.corpusSeq, objectKey: row.objectKey, sha256: row.sha256, byteSize: row.byteSize,
  });
}

export function executeMemoryAuthorityOperation(
  database: DatabaseSync,
  operation: MemoryAuthorityOperation,
): MemoryAuthorityOperationResult {
  if (operation.type === "memory.public") return executePublic(database, operation);
  try {
    if (operation.type === "memory.readiness") {
      const status = readRoomMemoryStatus(database, operation.roomId);
      return { kind: "readiness", readiness: {
        status: status.health.state,
        memoryWatermark: status.health.memoryWatermark,
        corpusHead: status.health.corpusHead,
        rawDeltaComplete: status.health.state !== "failed",
        injectableSnapshotReadable: status.health.state !== "failed",
      } };
    }
    if (operation.type === "memory.discover") {
      return { kind: "rooms", roomIds: discoverRoomMemoryReadyRooms(database, operation.limit) };
    }
    if (operation.type === "memory.claim") {
      return runAuthorityImmediateTransaction(database, () => {
        const occurredAt = new Date(operation.now).toISOString();
        const job = createRoomMemoryJob(database, {
          roomId: operation.roomId, jobId: operation.jobId, batchSize: operation.batchSize,
          availableAt: occurredAt, createdAt: occurredAt,
        });
        if (job === undefined) return { kind: "claimed", batch: null, sources: [] };
        const attempt = beginRoomMemoryAttempt(database, {
          roomId: operation.roomId, jobId: job.jobId, attemptId: operation.attemptId,
          inputSha256: operation.inputSha256, startedAt: occurredAt,
        });
        if (attempt === undefined) return { kind: "claimed", batch: null, sources: [] };
        return {
          kind: "claimed",
          batch: memoryJobAsBatch(job, attempt.attemptId),
          sources: job.frozenSources.map((source) => Object.freeze({ roomId: job.roomId, ...source })),
        };
      });
    }
    if (operation.type === "memory.source-authorize") {
      return { kind: "source", source: authorizeSource(database, operation) };
    }
    if (operation.type === "memory.record-known") {
      try {
        const projection = readRoomMemoryProjection(database, operation.roomId, operation.memoryRecordId);
        return { kind: "known-record", known: projection.kind === operation.kind };
      } catch (error: unknown) {
        if (error instanceof RoomMemoryDatabaseAuthorityError && error.code === "record_not_found") {
          return { kind: "known-record", known: false };
        }
        throw error;
      }
    }
    if (operation.type === "memory.complete") {
      return runAuthorityImmediateTransaction(database, () => {
        assertRunningBatch(database, operation.batch);
        const occurredAt = new Date(operation.now).toISOString();
        const committed = commitRoomMemoryPlan(database, {
          roomId: operation.batch.roomId, jobId: operation.batch.jobId,
          attemptId: operation.batch.attemptId, recoveryGeneration: operation.batch.recoveryGeneration,
          outputSha256: operation.outputSha256, plan: operation.plan, committedAt: occurredAt,
        });
        if (!committed.replayed) {
          const actorId = causalActor(database, operation.batch.roomId, operation.batch.jobId);
          for (const projection of committed.projections) {
            appendProjectionEvent(database, projection, committed.memoryWatermark, actorId, occurredAt);
          }
          appendHealthEvent(database, operation.batch.roomId, actorId, occurredAt);
        }
        return { kind: "completed", committed: true };
      });
    }
    if (operation.type === "memory.fail" || operation.type === "memory.abandon") {
      return runAuthorityImmediateTransaction(database, () => {
        assertRunningBatch(database, operation.batch);
        const occurredAt = new Date(operation.now).toISOString();
        const errorCode = operation.type === "memory.abandon" ? "shutdown" : operation.errorCode;
        const retryable = operation.type === "memory.fail" && operation.retryable;
        const currentAttempt = readRoomMemoryAttempt(database, operation.batch.attemptId);
        if (currentAttempt === undefined) fail("memory_unavailable", "Memory attempt was missing");
        const retryDelayMs = currentAttempt.attemptNumber <= 1 ? 1_000 : 4_000;
        const job = settleRoomMemoryAttempt(database, retryable ? {
          outcome: "retryable_failure", roomId: operation.batch.roomId,
          jobId: operation.batch.jobId, attemptId: operation.batch.attemptId,
          recoveryGeneration: operation.batch.recoveryGeneration, errorCode,
          finishedAt: occurredAt,
          nextAvailableAt: new Date(operation.now + retryDelayMs).toISOString(),
        } : {
          outcome: operation.type === "memory.abandon" ? "cancelled" : "terminal_failure",
          roomId: operation.batch.roomId, jobId: operation.batch.jobId,
          attemptId: operation.batch.attemptId, recoveryGeneration: operation.batch.recoveryGeneration,
          errorCode, finishedAt: occurredAt,
        });
        appendHealthEvent(
          database, operation.batch.roomId,
          causalActor(database, operation.batch.roomId, operation.batch.jobId), occurredAt,
        );
        return { kind: "settled", continueRoom: job.status === "retry_wait" };
      });
    }
    return runAuthorityImmediateTransaction(database, () => {
      const occurredAt = new Date(operation.now).toISOString();
      const before = readRoomMemoryStatus(database, operation.roomId);
      if (operation.type === "memory.mark-noauth") {
        markRoomMemoryNoauth(database, { roomId: operation.roomId, occurredAt });
      } else {
        markRoomMemoryProviderReady(database, { roomId: operation.roomId, occurredAt });
      }
      const after = readRoomMemoryStatus(database, operation.roomId);
      if (canonicalJson(before) !== canonicalJson(after)) {
        appendHealthEvent(database, operation.roomId, causalActor(database, operation.roomId), occurredAt);
      }
      return { kind: "status-updated" };
    });
  } catch (error: unknown) {
    return mapDatabaseError(error);
  }
}
