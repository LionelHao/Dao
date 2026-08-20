import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { registerMemoryCorpusSource } from "./corpus-database-authority.js";
import {
  RoomMemoryDatabaseAuthorityError,
  beginRoomMemoryAttempt,
  commitRoomMemoryPlan,
  createRoomMemoryJob,
  discoverRoomMemoryReadyRooms,
  disputeRoomMemoryContext,
  invalidateRoomMemorySource,
  manualRetryRoomMemory,
  markRoomMemoryNoauth,
  markRoomMemoryProviderReady,
  queryRoomMemory,
  readRoomMemorySnapshot,
  readRoomMemoryStatus,
  resolveRoomMemoryContext,
  settleRoomMemoryAttempt,
} from "./database-authority.js";
import type { MemoryStewardPlan } from "./contracts.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const T0 = "2026-08-19T00:00:00.000Z";
const T1 = "2026-08-19T00:01:00.000Z";
const T2 = "2026-08-19T00:02:00.000Z";
const T3 = "2026-08-19T00:03:00.000Z";
const T4 = "2026-08-19T00:04:00.000Z";

function withDatabase<Result>(operation: (database: DatabaseSync) => Result): Result {
  const directory = mkdtempSync(join(tmpdir(), "dao-memory-db-authority-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    migrateAuthorityDatabase(database);
    return operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedRoom(database: DatabaseSync, roomId = "room-1"): void {
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json)
    VALUES ('human-owner', 'human', 'Owner', '[]'),
           ('human-member', 'human', 'Member', '[]'),
           ('human-admin', 'human', 'Admin', '[]'),
           ('human-outsider', 'human', 'Outsider', '[]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'human-owner', 0, 1),
           ('identity', 'human-member', 0, 1),
           ('identity', 'human-admin', 0, 1),
           ('identity', 'human-outsider', 0, 1),
           ('room', '${roomId}', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES ('${roomId}', 'Memory Room', 'active', '${T0}', 'human-owner');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('${roomId}', 'human-owner', 'human', 'owner', NULL, '[]', '${T0}', NULL, 0),
      ('${roomId}', 'human-member', 'human', 'member', NULL, '[]', '${T0}', NULL, 0),
      ('${roomId}', 'human-admin', 'human', 'admin', NULL, '[]', '${T0}', NULL, 0);
  `);
}

function source(database: DatabaseSync, ordinal: number, roomId = "room-1"): void {
  registerMemoryCorpusSource(database, {
    roomId,
    sourceKind: "message",
    sourceId: `message:message-${ordinal}`,
    sourceRevision: 1,
    serverStreamSeq: ordinal,
    eligibility: "eligible",
    availability: "readable",
    sourceActorId: "human-owner",
    safeMetadata: { authorKind: "human", messageId: `message-${ordinal}` },
    readReference: `message-authority:message-${ordinal}:1`,
    occurredAt: T0,
  });
}

function createAndBegin(
  database: DatabaseSync,
  input: { readonly jobId: string; readonly attemptId: string; readonly batchSize?: number },
) {
  const job = createRoomMemoryJob(database, {
    roomId: "room-1",
    jobId: input.jobId,
    batchSize: input.batchSize ?? 32,
    availableAt: T1,
    createdAt: T1,
  });
  expect(job).toBeDefined();
  const attempt = beginRoomMemoryAttempt(database, {
    roomId: "room-1",
    jobId: input.jobId,
    attemptId: input.attemptId,
    inputSha256: SHA_A,
    startedAt: T1,
  });
  expect(attempt).toBeDefined();
  return { job: job!, attempt: attempt! };
}

function plan(candidates: MemoryStewardPlan["candidates"]): MemoryStewardPlan {
  return { schemaVersion: 1, candidates };
}

function createCandidate(input: {
  readonly kind: "context" | "goal";
  readonly dedupeKey: string;
  readonly derivedText: string;
  readonly sourceOrdinals: readonly number[];
}) {
  return {
    operation: "create" as const,
    kind: input.kind,
    derivedText: input.derivedText,
    sourceRefs: input.sourceOrdinals.map((ordinal) => ({
      sourceKind: "message" as const,
      sourceId: `message:message-${ordinal}`,
      sourceRevision: 1,
    })),
    dedupeKey: input.dedupeKey,
    replacesMemoryRecordId: null,
  };
}

describe("FT-05 Room Memory database authority", () => {
  it("reads closed status and durably freezes only 32 contiguous descriptors while noauth never claims", () => {
    withDatabase((database) => {
      seedRoom(database);
      for (let ordinal = 1; ordinal <= 33; ordinal += 1) source(database, ordinal);

      expect(readRoomMemoryStatus(database, "room-1")).toMatchObject({
        roomId: "room-1",
        health: { state: "catching_up", reason: "backlog", memoryWatermark: 0, corpusHead: 33, lag: 33 },
        recoveryGeneration: 1,
      });
      markRoomMemoryNoauth(database, { roomId: "room-1", occurredAt: T1 });
      expect(createRoomMemoryJob(database, {
        roomId: "room-1", jobId: "job-noauth", batchSize: 32, availableAt: T1, createdAt: T1,
      })).toBeUndefined();
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_memory_jobs").get()).toEqual({ count: 0 });

      markRoomMemoryProviderReady(database, { roomId: "room-1", occurredAt: T1 });
      const job = createRoomMemoryJob(database, {
        roomId: "room-1", jobId: "job-1", batchSize: 32, availableAt: T1, createdAt: T1,
      });
      expect(job).toMatchObject({
        jobId: "job-1", recoveryGeneration: 1, fromWatermarkExclusive: 0,
        toCorpusSeqInclusive: 32, sourceCount: 32, status: "queued",
      });
      expect(job?.frozenSources).toHaveLength(32);
      const persisted = database.prepare(
        "SELECT frozen_sources_json AS frozenSourcesJson FROM room_memory_jobs WHERE job_id = 'job-1'",
      ).get()?.frozenSourcesJson;
      expect(typeof persisted).toBe("string");
      expect(String(persisted)).not.toContain("raw-corpus-sentinel");
      expect(String(persisted)).not.toContain("provider");

      const attempt = beginRoomMemoryAttempt(database, {
        roomId: "room-1", jobId: "job-1", attemptId: "attempt-1", inputSha256: SHA_A, startedAt: T1,
      });
      expect(attempt).toMatchObject({ attemptId: "attempt-1", attemptNumber: 1, status: "running" });
      expect(discoverRoomMemoryReadyRooms(database, 128)).toEqual([]);
    });
  });

  it("atomically commits a validated plan, closes Context/non-Context state, replays exactly, and rolls invalid plans back", () => {
    withDatabase((database) => {
      seedRoom(database);
      source(database, 1);
      source(database, 2);
      createAndBegin(database, { jobId: "job-commit", attemptId: "attempt-commit" });
      const providerPlan = plan([
        createCandidate({
          kind: "context", dedupeKey: "launch-context", derivedText: "Launch is Friday.", sourceOrdinals: [1, 2],
        }),
        createCandidate({
          kind: "goal", dedupeKey: "launch-goal", derivedText: "Prepare the launch.", sourceOrdinals: [1],
        }),
      ]);
      const committed = commitRoomMemoryPlan(database, {
        roomId: "room-1", jobId: "job-commit", attemptId: "attempt-commit",
        recoveryGeneration: 1, outputSha256: SHA_B, plan: providerPlan, committedAt: T2,
      });
      expect(committed.replayed).toBe(false);
      expect(readRoomMemoryStatus(database, "room-1").health).toMatchObject({
        state: "healthy", memoryWatermark: 2, corpusHead: 2, lag: 0,
      });
      expect(readRoomMemorySnapshot(database, "room-1")).toHaveLength(1);
      expect(readRoomMemorySnapshot(database, "room-1")[0]?.currentVersion).toMatchObject({
        kind: "context", state: "active", derivedText: "Launch is Friday.",
      });
      const queried = queryRoomMemory(database, { roomId: "room-1", limit: 50 });
      expect(queried.items.map((item) => [item.kind, item.currentVersion.state])).toEqual([
        ["context", "active"], ["goal", "proposal"],
      ]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_memory_source_edges").get()).toEqual({ count: 3 });
      expect(commitRoomMemoryPlan(database, {
        roomId: "room-1", jobId: "job-commit", attemptId: "attempt-commit",
        recoveryGeneration: 1, outputSha256: SHA_B, plan: providerPlan, committedAt: T3,
      }).replayed).toBe(true);
      expect(() => commitRoomMemoryPlan(database, {
        roomId: "room-1", jobId: "job-commit", attemptId: "attempt-commit",
        recoveryGeneration: 1, outputSha256: SHA_C, plan: providerPlan, committedAt: T3,
      })).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_memory_records").get()).toEqual({ count: 2 });
    });

    withDatabase((database) => {
      seedRoom(database);
      source(database, 1);
      createAndBegin(database, { jobId: "job-invalid", attemptId: "attempt-invalid" });
      const invalid = plan([createCandidate({
        kind: "context", dedupeKey: "invalid", derivedText: "Invalid.", sourceOrdinals: [2],
      })]);
      expect(() => commitRoomMemoryPlan(database, {
        roomId: "room-1", jobId: "job-invalid", attemptId: "attempt-invalid",
        recoveryGeneration: 1, outputSha256: SHA_B, plan: invalid, committedAt: T2,
      })).toThrowError(expect.objectContaining({ code: "source_stale" }));
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_memory_records").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT status FROM room_memory_attempts WHERE attempt_id = 'attempt-invalid'").get())
        .toEqual({ status: "running" });
      expect(readRoomMemoryStatus(database, "room-1").health.memoryWatermark).toBe(0);
    });
  });

  it("persists bounded retry/terminal outcomes and rejects late generations", () => {
    withDatabase((database) => {
      seedRoom(database);
      source(database, 1);
      createAndBegin(database, { jobId: "job-retry", attemptId: "attempt-1" });
      expect(settleRoomMemoryAttempt(database, {
        outcome: "retryable_failure", roomId: "room-1", jobId: "job-retry", attemptId: "attempt-1",
        recoveryGeneration: 1, errorCode: "provider_timeout", finishedAt: T2, nextAvailableAt: T3,
      })).toMatchObject({ status: "retry_wait", currentAttempt: 1, availableAt: T3 });
      expect(beginRoomMemoryAttempt(database, {
        roomId: "room-1", jobId: "job-retry", attemptId: "attempt-2", inputSha256: SHA_A, startedAt: T3,
      })).toMatchObject({ attemptNumber: 2, status: "running" });
      expect(settleRoomMemoryAttempt(database, {
        outcome: "terminal_failure", roomId: "room-1", jobId: "job-retry", attemptId: "attempt-2",
        recoveryGeneration: 1, errorCode: "invalid_provider_output", finishedAt: T4,
      })).toMatchObject({ status: "failed", currentAttempt: 2 });
      expect(readRoomMemoryStatus(database, "room-1").health).toMatchObject({
        state: "degraded", reason: "invalid_provider_output", retryable: false,
      });
      expect(() => settleRoomMemoryAttempt(database, {
        outcome: "terminal_failure", roomId: "room-1", jobId: "job-retry", attemptId: "attempt-1",
        recoveryGeneration: 1, errorCode: "invalid_provider_output", finishedAt: T4,
      })).toThrowError(expect.objectContaining({ code: "generation_conflict" }));
    });
  });

  it("moves affected current memories to review_required or invalidated before excluding a source", () => {
    withDatabase((database) => {
      seedRoom(database);
      source(database, 1);
      source(database, 2);
      createAndBegin(database, { jobId: "job-invalidate", attemptId: "attempt-invalidate" });
      commitRoomMemoryPlan(database, {
        roomId: "room-1", jobId: "job-invalidate", attemptId: "attempt-invalidate",
        recoveryGeneration: 1, outputSha256: SHA_B,
        plan: plan([
          createCandidate({ kind: "context", dedupeKey: "two-sources", derivedText: "Two sources.", sourceOrdinals: [1, 2] }),
          createCandidate({ kind: "context", dedupeKey: "one-source", derivedText: "One source.", sourceOrdinals: [1] }),
        ]),
        committedAt: T2,
      });
      const result = invalidateRoomMemorySource(database, {
        roomId: "room-1", sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
        eligibility: "excluded_recalled", availability: "metadata_only", occurredAt: T3,
      });
      expect(result.projections.map((item) => item.currentVersion.state).sort()).toEqual([
        "invalidated", "review_required",
      ]);
      expect(readRoomMemorySnapshot(database, "room-1")).toEqual([]);
      expect(database.prepare(`
        SELECT eligibility, availability FROM room_memory_sources
        WHERE room_id = 'room-1' AND source_id = 'message:message-1'
      `).get()).toEqual({ eligibility: "excluded_recalled", availability: "metadata_only" });
    });
  });

  it("disputes active Context with current-Human CAS and exact durable replay", () => {
    withDatabase((database) => {
      seedRoom(database);
      source(database, 1);
      createAndBegin(database, { jobId: "job-context", attemptId: "attempt-context" });
      commitRoomMemoryPlan(database, {
        roomId: "room-1", jobId: "job-context", attemptId: "attempt-context",
        recoveryGeneration: 1, outputSha256: SHA_B,
        plan: plan([createCandidate({
          kind: "context", dedupeKey: "context", derivedText: "Context.", sourceOrdinals: [1],
        })]),
        committedAt: T2,
      });
      const recordId = queryRoomMemory(database, { roomId: "room-1", limit: 10 }).items[0]!.memoryRecordId;
      const input = {
        roomId: "room-1", actorId: "human-member", requestId: "dispute-request",
        memoryRecordId: recordId, expectedVersion: 1, reason: "This context is wrong.", occurredAt: T3,
      } as const;
      const disputed = disputeRoomMemoryContext(database, input);
      expect(disputed.replayed).toBe(false);
      expect(disputed.projection.currentVersion).toMatchObject({ state: "disputed", version: 2 });
      expect(disputeRoomMemoryContext(database, { ...input, occurredAt: T4 }).replayed).toBe(true);
      expect(() => disputeRoomMemoryContext(database, { ...input, reason: "Changed payload." }))
        .toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
      expect(() => disputeRoomMemoryContext(database, {
        ...input, requestId: "concurrent-dispute", reason: "Concurrent.",
      })).toThrowError(expect.objectContaining({ code: "version_conflict" }));
      expect(() => disputeRoomMemoryContext(database, {
        ...input, requestId: "outsider-dispute", actorId: "human-outsider",
      })).toThrowError(expect.objectContaining({ code: "forbidden" }));
    });
  });

  it("allows only the original disputer or owner/admin with a later proven reevaluation result to resolve", () => {
    withDatabase((database) => {
      seedRoom(database);
      source(database, 1);
      createAndBegin(database, { jobId: "job-seed", attemptId: "attempt-seed" });
      commitRoomMemoryPlan(database, {
        roomId: "room-1", jobId: "job-seed", attemptId: "attempt-seed",
        recoveryGeneration: 1, outputSha256: SHA_B,
        plan: plan([
          createCandidate({ kind: "context", dedupeKey: "original", derivedText: "Original.", sourceOrdinals: [1] }),
          createCandidate({ kind: "context", dedupeKey: "owner-proof", derivedText: "Owner proof.", sourceOrdinals: [1] }),
        ]),
        committedAt: T1,
      });
      const records = queryRoomMemory(database, { roomId: "room-1", limit: 10 }).items;
      const original = records.find((item) => item.currentVersion.derivedText === "Original.")!;
      const ownerProof = records.find((item) => item.currentVersion.derivedText === "Owner proof.")!;
      disputeRoomMemoryContext(database, {
        roomId: "room-1", actorId: "human-member", requestId: "dispute-original",
        memoryRecordId: original.memoryRecordId, expectedVersion: 1, reason: "Wrong.", occurredAt: T2,
      });
      const resolved = resolveRoomMemoryContext(database, {
        roomId: "room-1", actorId: "human-member", requestId: "resolve-original",
        memoryRecordId: original.memoryRecordId, expectedVersion: 2, action: "resolve",
        reason: "Corrected by the disputer.", replacementDerivedText: "Corrected.",
        sourceRefs: [{ sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1 }],
        reevaluationProof: null, occurredAt: T3,
      });
      expect(resolved.projection.currentVersion).toMatchObject({ state: "active", version: 4, derivedText: "Corrected." });
      expect(resolved.resolution.operatorActorId).toBe("human-member");

      disputeRoomMemoryContext(database, {
        roomId: "room-1", actorId: "human-member", requestId: "dispute-owner-proof",
        memoryRecordId: ownerProof.memoryRecordId, expectedVersion: 1, reason: "Needs re-evaluation.", occurredAt: T2,
      });
      expect(() => resolveRoomMemoryContext(database, {
        roomId: "room-1", actorId: "human-owner", requestId: "resolve-no-proof",
        memoryRecordId: ownerProof.memoryRecordId, expectedVersion: 2, action: "re_evaluate",
        reason: "Owner attempted without proof.", replacementDerivedText: "Re-evaluated.",
        sourceRefs: [{ sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1 }],
        reevaluationProof: null, occurredAt: T3,
      })).toThrowError(expect.objectContaining({ code: "forbidden" }));
      expect(() => resolveRoomMemoryContext(database, {
        roomId: "room-1", actorId: "human-owner", requestId: "resolve-stale-proof",
        memoryRecordId: ownerProof.memoryRecordId, expectedVersion: 2, action: "re_evaluate",
        reason: "Stale proof.", replacementDerivedText: "Re-evaluated.",
        sourceRefs: [{ sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1 }],
        reevaluationProof: {
          jobId: "job-seed", attemptId: "attempt-seed", recoveryGeneration: 1, resultSha256: SHA_B,
        },
        occurredAt: T3,
      })).toThrowError(expect.objectContaining({ code: "forbidden" }));

      source(database, 2);
      createAndBegin(database, { jobId: "job-reevaluate", attemptId: "attempt-reevaluate" });
      commitRoomMemoryPlan(database, {
        roomId: "room-1", jobId: "job-reevaluate", attemptId: "attempt-reevaluate",
        recoveryGeneration: 1, outputSha256: SHA_C, plan: plan([]), committedAt: T3,
      });
      const ownerResolved = resolveRoomMemoryContext(database, {
        roomId: "room-1", actorId: "human-owner", requestId: "resolve-with-proof",
        memoryRecordId: ownerProof.memoryRecordId, expectedVersion: 2, action: "re_evaluate",
        reason: "Re-evaluated against the later completed generation.", replacementDerivedText: "Re-evaluated.",
        sourceRefs: [{ sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1 }],
        reevaluationProof: {
          jobId: "job-reevaluate", attemptId: "attempt-reevaluate", recoveryGeneration: 1, resultSha256: SHA_C,
        },
        occurredAt: T4,
      });
      expect(ownerResolved.projection.currentVersion).toMatchObject({ state: "active", version: 4 });
      expect(ownerResolved.resolution.action).toBe("re_evaluate");
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_memory_resolutions").get()).toEqual({ count: 2 });
    });
  });

  it("manual retry creates a new generation/attempt and archive fences late results until reopen reconciliation", () => {
    withDatabase((database) => {
      seedRoom(database);
      source(database, 1);
      createAndBegin(database, { jobId: "job-failed", attemptId: "attempt-failed" });
      settleRoomMemoryAttempt(database, {
        outcome: "terminal_failure", roomId: "room-1", jobId: "job-failed", attemptId: "attempt-failed",
        recoveryGeneration: 1, errorCode: "invalid_provider_output", finishedAt: T2,
      });
      const retried = manualRetryRoomMemory(database, {
        roomId: "room-1", actorId: "human-member", requestId: "retry-request",
        expectedRecoveryGeneration: 1, jobId: "job-manual", attemptId: "attempt-manual",
        inputSha256: SHA_A, batchSize: 32, acceptedAt: T3,
      });
      expect(retried).toMatchObject({ replayed: false, recoveryGeneration: 2 });
      expect(retried.job).toMatchObject({ jobId: "job-manual", recoveryGeneration: 2, status: "running" });
      expect(retried.attempt).toMatchObject({ attemptId: "attempt-manual", attemptNumber: 1, status: "running" });
      expect(manualRetryRoomMemory(database, { ...{
        roomId: "room-1", actorId: "human-member", requestId: "retry-request",
        expectedRecoveryGeneration: 1, jobId: "job-manual", attemptId: "attempt-manual",
        inputSha256: SHA_A, batchSize: 32, acceptedAt: T4,
      } }).replayed).toBe(true);

      database.exec(`
        UPDATE rooms SET status = 'archived', archived_at = '${T3}', archive_generation = 1 WHERE id = 'room-1'
      `);
      expect(() => commitRoomMemoryPlan(database, {
        roomId: "room-1", jobId: "job-manual", attemptId: "attempt-manual",
        recoveryGeneration: 2, outputSha256: SHA_B, plan: plan([]), committedAt: T4,
      })).toThrowError(expect.objectContaining({ code: "room_archived" }));
      expect(readRoomMemoryStatus(database, "room-1").health.memoryWatermark).toBe(0);
      expect(discoverRoomMemoryReadyRooms(database, 128)).toEqual([]);

      database.exec(`
        UPDATE rooms SET status = 'active', archived_at = NULL, archive_generation = 2 WHERE id = 'room-1'
      `);
      expect(discoverRoomMemoryReadyRooms(database, 128)).toEqual(["room-1"]);
      const reopened = createRoomMemoryJob(database, {
        roomId: "room-1", jobId: "job-reopened", batchSize: 32, availableAt: T4, createdAt: T4,
      });
      expect(reopened).toMatchObject({ jobId: "job-reopened", recoveryGeneration: 3, lifecycleGeneration: 2 });
      expect(database.prepare("SELECT status FROM room_memory_jobs WHERE job_id = 'job-manual'").get())
        .toEqual({ status: "cancelled" });
      expect(database.prepare("SELECT status FROM room_memory_attempts WHERE attempt_id = 'attempt-manual'").get())
        .toEqual({ status: "cancelled" });
    });
  });

  it("rejects hidden/extra authority inputs before any write", () => {
    withDatabase((database) => {
      seedRoom(database);
      source(database, 1);
      const input = {
        roomId: "room-1", jobId: "job-extra", batchSize: 32, availableAt: T1, createdAt: T1,
      };
      Object.defineProperty(input, "providerBody", { value: "provider-raw-sentinel", enumerable: false });
      expect(() => createRoomMemoryJob(database, input)).toThrow(RoomMemoryDatabaseAuthorityError);
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_memory_jobs").get()).toEqual({ count: 0 });
    });
  });
});
