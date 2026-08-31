import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  seedCanonicalAgentProfileFixture,
  seedCanonicalRoomAssignmentFixture,
  transitionRoomAssignmentPauseFixture,
} from "../fixtures/agent-authority-fixture.js";
import {
  AUTHORITY_SCHEMA_VERSION,
  migrateAuthorityDatabase,
} from "../persistence/schema.js";
import {
  authorizeOutboxCandidateDatabaseQuery,
  listPendingOutboxDatabaseQuery,
  recallHumanMessageDatabaseCommand,
  submitHumanMessageDatabaseCommand,
} from "../persistence/authority-database-handler.js";
import {
  AttachmentAuthorityDatabaseError,
  authorizeAgentAttachmentExtractionDatabaseQuery,
  authorizeAttachmentAccessDatabaseQuery,
  beginAttachmentUploadInTransaction,
  bindAttachmentToMessageInTransaction,
  cancelAttachmentUploadInTransaction,
  claimAttachmentProcessingAttemptInTransaction,
  completeAttachmentProcessingAttemptInTransaction,
  finalizeAttachmentUploadInTransaction,
  markAttachmentReadyInTransaction,
  listRecoverableAttachmentProcessingDatabaseQuery,
  readAttachmentProcessingPlanDatabaseQuery,
  readAttachmentObjectReferencesDatabaseQuery,
  readAttachmentStatusDatabaseQuery,
  readAttachmentUploadAssemblyPlanDatabaseQuery,
  recordAttachmentChunkInTransaction,
  retryAttachmentProcessingInTransaction,
  runAttachmentAuthorityImmediateTransaction,
  startAttachmentProcessingAttemptInTransaction,
} from "./database-authority.js";
import type {
  AttachmentAuthorityClock,
  AttachmentAuthorityIdFactory,
  AttachmentHumanContext,
  AttachmentWorkerContext,
} from "./database-contracts.js";

const NOW = Date.parse("2026-08-19T08:00:00.000Z");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const UPLOADER: AttachmentHumanContext = Object.freeze({
  kind: "human",
  sessionId: "attachment-access-token-hash",
  sessionFamilyId: "attachment-family",
  principal: Object.freeze({ accountId: "attachment-account", actorId: "attachment-human" }),
});
const OTHER: AttachmentHumanContext = Object.freeze({
  kind: "human",
  sessionId: "other-access-token-hash",
  sessionFamilyId: "other-family",
  principal: Object.freeze({ accountId: "other-account", actorId: "attachment-human-2" }),
});
const READER: AttachmentHumanContext = Object.freeze({
  kind: "human",
  sessionId: "reader-access-token-hash",
  sessionFamilyId: "reader-family",
  principal: Object.freeze({ accountId: "reader-account", actorId: "attachment-reader" }),
});
const WORKER: AttachmentWorkerContext = Object.freeze({
  kind: "attachment-worker",
  workerId: "attachment-worker-1",
});
const clock: AttachmentAuthorityClock = Object.freeze({ nowMs: () => NOW });

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createIds(): AttachmentAuthorityIdFactory {
  let upload = 0;
  let event = 0;
  let delivery = 0;
  let artifact = 0;
  return Object.freeze({
    nextUploadId: () => uuid(++upload),
    attachmentIdForUpload: (uploadId: string) =>
      uuid(Number(uploadId.slice(-12)) + 100),
    nextEventId: () => `attachment-event-${++event}`,
    nextOutboxId: () => `attachment-outbox-${++delivery}`,
    nextExtractionArtifactId: () => `attachment-extraction-${++artifact}`,
  });
}

function createDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "dao-attachment-schema-v17-"));
  const migrated = new DatabaseSync(join(directory, "authority.sqlite"));
  let statements: string[];
  try {
    migrateAuthorityDatabase(migrated);
    statements = migrated.prepare(`
      SELECT sql
      FROM sqlite_schema
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name
    `).all().map((row) => String(row.sql));
  } finally {
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  }
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = OFF");
  for (const statement of statements) database.exec(statement);
  database.exec(`PRAGMA user_version = ${AUTHORITY_SCHEMA_VERSION}`);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    INSERT INTO actors (id, kind, display_name) VALUES
      ('attachment-human', 'human', 'Uploader'),
      ('attachment-human-2', 'human', 'Other'),
      ('attachment-reader', 'human', 'Reader');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
      ('identity', 'attachment-human', 0, 1),
      ('identity', 'attachment-human-2', 0, 1),
      ('identity', 'attachment-reader', 0, 1),
      ('room', 'attachment-room', 0, 1),
      ('room', 'attachment-room-2', 0, 1);
    INSERT INTO rooms (id, name, status, created_at) VALUES
      ('attachment-room', 'Attachment Room', 'active', '2026-08-19T00:00:00.000Z'),
      ('attachment-room-2', 'Other Room', 'active', '2026-08-19T00:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('attachment-room', 'attachment-human', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('attachment-room', 'attachment-human-2', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('attachment-room', 'attachment-reader', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('attachment-room-2', 'attachment-human', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0);
    UPDATE rooms SET owner_actor_id = 'attachment-human';
    INSERT INTO session_families (
      family_id, public_id, account_id, actor_id, device_id, device_label,
      platform, created_at, refresh_expires_at, revoked_at
    ) VALUES
      ('attachment-family', 'attachment-public-family', 'attachment-account',
       'attachment-human', 'attachment-device', 'Mac', 'macos', 1, ${NOW + 10_000_000}, NULL),
      ('other-family', 'other-public-family', 'other-account',
       'attachment-human-2', 'other-device', 'Mac', 'macos', 1, ${NOW + 10_000_000}, NULL),
      ('reader-family', 'reader-public-family', 'reader-account',
       'attachment-reader', 'reader-device', 'Mac', 'macos', 1, ${NOW + 10_000_000}, NULL);
    INSERT INTO sessions (
      family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
      access_expires_at, refresh_expires_at, revoked_at
    ) VALUES
      ('attachment-family', 'attachment-account', 'attachment-human',
       'attachment-access-token-hash', 'attachment-refresh-token-hash',
       ${NOW + 5_000_000}, ${NOW + 10_000_000}, NULL),
      ('other-family', 'other-account', 'attachment-human-2',
       'other-access-token-hash', 'other-refresh-token-hash',
       ${NOW + 5_000_000}, ${NOW + 10_000_000}, NULL),
      ('reader-family', 'reader-account', 'attachment-reader',
       'reader-access-token-hash', 'reader-refresh-token-hash',
       ${NOW + 5_000_000}, ${NOW + 10_000_000}, NULL);
  `);
  return database;
}

function expectDatabaseError(
  operation: () => unknown,
  status: number,
  code: string,
): AttachmentAuthorityDatabaseError {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AttachmentAuthorityDatabaseError);
    expect(error).toMatchObject({ status, code });
    return error as AttachmentAuthorityDatabaseError;
  }
  throw new Error("Expected AttachmentAuthorityDatabaseError");
}

function beginInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    requestId: "begin-request-1",
    roomId: "attachment-room",
    uploadKey: "upload-key-1",
    originalFilename: "safe.txt",
    declaredMime: "text/plain" as const,
    expectedBytes: 4,
    expectedSha256: SHA_A,
    ...overrides,
  };
}

function beginUpload(
  database: DatabaseSync,
  ids: AttachmentAuthorityIdFactory,
  suffix = "1",
): string {
  return runAttachmentAuthorityImmediateTransaction(database, () =>
    beginAttachmentUploadInTransaction(database, {
      context: UPLOADER,
      command: beginInput({
        requestId: `begin-request-${suffix}`,
        uploadKey: `upload-key-${suffix}`,
      }),
      clock,
      ids,
    })).uploadId;
}

function checkpointUpload(
  database: DatabaseSync,
  ids: AttachmentAuthorityIdFactory,
  uploadId: string,
  suffix = "1",
): void {
  runAttachmentAuthorityImmediateTransaction(database, () =>
    recordAttachmentChunkInTransaction(database, {
      context: UPLOADER,
      command: {
        requestId: `chunk-request-${suffix}`,
        uploadId,
        ordinal: 0,
        offset: 0,
        byteLength: 4,
        chunkSha256: SHA_A,
        partObjectKey: `part_${suffix}_${SHA_A}`,
      },
      clock,
    }));
}

function finalizeUpload(
  database: DatabaseSync,
  ids: AttachmentAuthorityIdFactory,
  uploadId: string,
  suffix = "1",
): string {
  return runAttachmentAuthorityImmediateTransaction(database, () =>
    finalizeAttachmentUploadInTransaction(database, {
      context: UPLOADER,
      command: {
        requestId: `finalize-request-${suffix}`,
        uploadId,
        storage: {
          quarantineObjectKey: `quarantine_${suffix}_${SHA_A}`,
          byteSize: 4,
          sha256: SHA_A,
          format: "txt",
          detectedMime: "text/plain",
        },
      },
      clock,
      ids,
    })).attachmentId;
}

function createQuarantinedAttachment(
  database: DatabaseSync,
  ids: AttachmentAuthorityIdFactory,
  suffix = "1",
): Readonly<{ uploadId: string; attachmentId: string }> {
  const uploadId = beginUpload(database, ids, suffix);
  checkpointUpload(database, ids, uploadId, suffix);
  return { uploadId, attachmentId: finalizeUpload(database, ids, uploadId, suffix) };
}

function makeReady(
  database: DatabaseSync,
  ids: AttachmentAuthorityIdFactory,
  attachmentId: string,
): void {
  const scanner = runAttachmentAuthorityImmediateTransaction(database, () =>
    claimAttachmentProcessingAttemptInTransaction(database, {
      context: WORKER,
      command: {
        attachmentId,
        expectedGeneration: 1,
        adapter: {
          kind: "scanner",
          name: "clamav",
          version: "1.0",
          timeoutMs: 120_000,
          stdoutLimitBytes: 8_388_608,
          stderrLimitBytes: 65_536,
        },
      },
      clock,
      ids,
    }));
  runAttachmentAuthorityImmediateTransaction(database, () => {
    startAttachmentProcessingAttemptInTransaction(database, {
      context: WORKER,
      command: {
        attachmentId,
        expectedGeneration: 1,
        attemptNumber: scanner.attemptNumber,
      },
      clock,
    });
    completeAttachmentProcessingAttemptInTransaction(database, {
      context: WORKER,
      command: {
        attachmentId,
        expectedGeneration: 1,
        attemptNumber: scanner.attemptNumber,
        result: { status: "succeeded" },
      },
      clock,
      ids,
    });
  });

  const extractor = runAttachmentAuthorityImmediateTransaction(database, () =>
    claimAttachmentProcessingAttemptInTransaction(database, {
      context: WORKER,
      command: {
        attachmentId,
        expectedGeneration: 1,
        adapter: {
          kind: "extractor",
          name: "builtin",
          version: "1.0",
          timeoutMs: 60_000,
          stdoutLimitBytes: 8_388_608,
          stderrLimitBytes: 65_536,
        },
      },
      clock,
      ids,
    }));
  runAttachmentAuthorityImmediateTransaction(database, () => {
    startAttachmentProcessingAttemptInTransaction(database, {
      context: WORKER,
      command: {
        attachmentId,
        expectedGeneration: 1,
        attemptNumber: extractor.attemptNumber,
      },
      clock,
    });
    completeAttachmentProcessingAttemptInTransaction(database, {
      context: WORKER,
      command: {
        attachmentId,
        expectedGeneration: 1,
        attemptNumber: extractor.attemptNumber,
        result: {
          status: "succeeded",
          extraction: {
            method: "plain-text",
            tool: "builtin",
            version: "1.0",
            objectKey: `extraction_${SHA_B}`,
            sha256: SHA_B,
            byteSize: 3,
            pageCount: null,
          },
        },
      },
      clock,
      ids,
    });
    markAttachmentReadyInTransaction(database, {
      context: WORKER,
      command: {
        attachmentId,
        expectedGeneration: 1,
        objectKey: `object_${SHA_A}`,
        byteSize: 4,
        sha256: SHA_A,
      },
      clock,
      ids,
    });
  });
}

function insertMessage(database: DatabaseSync, messageId: string): void {
  database.prepare(`
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES (?, 'attachment-room', 'attachment-human', 'human', 'attachment message', ?)
  `).run(messageId, new Date(NOW).toISOString());
  database.prepare(`
    INSERT INTO message_revisions (
      message_id, revision, body, revised_at, revised_by_actor_id
    ) VALUES (?, 1, 'attachment message', ?, 'attachment-human')
  `).run(messageId, new Date(NOW).toISOString());
  database.prepare(`
    INSERT INTO message_envelopes (
      message_id, room_id, message_kind, lifecycle, current_revision,
      revision_count, created_at, recalled_at, recalled_by_actor_id
    ) VALUES (?, 'attachment-room', 'human', 'active', 1, 1, ?, NULL, NULL)
  `).run(messageId, new Date(NOW).toISOString());
}

describe("SQLite Attachment Authority transaction functions", () => {
  it("returns a sorted metadata-only object reference snapshot for filesystem reconciliation", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const openUploadId = beginUpload(database, ids, "open");
      const quarantined = createQuarantinedAttachment(database, ids, "quarantined");
      const ready = createQuarantinedAttachment(database, ids, "ready");
      makeReady(database, ids, ready.attachmentId);

      expect(readAttachmentObjectReferencesDatabaseQuery(database, { context: WORKER }))
        .toEqual({
          referencedUploadIds: [openUploadId],
          referencedQuarantineAttachmentIds: [quarantined.attachmentId],
          referencedObjectKeys: [
            `extraction_${SHA_B}`,
            `object_${SHA_A}`,
          ],
        });
    } finally {
      database.close();
    }
  });

  it("allows distinct safe attachments to share immutable content-addressed objects", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const first = createQuarantinedAttachment(database, ids, "dedupe-a");
      const second = createQuarantinedAttachment(database, ids, "dedupe-b");
      makeReady(database, ids, first.attachmentId);
      expect(() => makeReady(database, ids, second.attachmentId)).not.toThrow();
      expect(database.prepare(`
        SELECT attachment_id AS attachmentId, object_key AS objectKey
        FROM attachments WHERE attachment_id IN (?, ?) ORDER BY attachment_id
      `).all(first.attachmentId, second.attachmentId)).toEqual([
        { attachmentId: first.attachmentId, objectKey: `object_${SHA_A}` },
        { attachmentId: second.attachmentId, objectKey: `object_${SHA_A}` },
      ]);
    } finally {
      database.close();
    }
  });

  it("begins with exact business-key replay and rejects changed input or revoked authority", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const first = runAttachmentAuthorityImmediateTransaction(database, () =>
        beginAttachmentUploadInTransaction(database, {
          context: UPLOADER, command: beginInput(), clock, ids,
        }));
      const replay = runAttachmentAuthorityImmediateTransaction(database, () =>
        beginAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: beginInput({ requestId: "begin-request-replay" }),
          clock,
          ids,
        }));
      expect(first).toEqual({
        uploadId: uuid(1), acknowledgedBytes: 0, expectedBytes: 4,
        status: "open", replayed: false,
      });
      expect(replay).toEqual({ ...first, replayed: true });
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        beginAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: beginInput({ requestId: "changed", expectedSha256: SHA_B }),
          clock,
          ids,
        })), 409, "idempotency_conflict");
      expect(database.prepare("SELECT COUNT(*) AS count FROM attachment_uploads").get())
        .toEqual({ count: 1 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM idempotency_records
        WHERE scope LIKE '%attachment.upload.begin%'
      `).get()).toEqual({ count: 1 });

      database.exec(`
        UPDATE session_families SET revoked_at = ${NOW}
        WHERE family_id = 'attachment-family'
      `);
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        beginAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: beginInput({ uploadKey: "revoked-key", requestId: "revoked" }),
          clock,
          ids,
        })), 401, "unauthenticated");
      expect(database.prepare("SELECT COUNT(*) AS count FROM attachment_uploads").get())
        .toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("deletes an exact-expiry ghost receipt before treating the request as new", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const scope = "attachment-human:attachment.upload.begin:attachment-room";
      database.prepare(
        `INSERT INTO idempotency_records (
           scope, key, request_hash, response_json, status_code, created_at, expires_at
         ) VALUES (?, 'expired-upload', ?, '{}', 200, ?, ?)`,
      ).run(scope, "f".repeat(64), new Date(NOW - 1).toISOString(),
        new Date(NOW).toISOString());

      const result = runAttachmentAuthorityImmediateTransaction(database, () =>
        beginAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: beginInput({ requestId: "expired-new", uploadKey: "expired-upload" }),
          clock,
          ids,
        }));

      expect(result).toMatchObject({ uploadId: uuid(1), replayed: false });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM idempotency_records
         WHERE scope = ? AND key = 'expired-upload' AND expires_at > ?`,
      ).get(scope, new Date(NOW).toISOString())).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("caps active uploads globally before allocating another durable upload", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      database.exec(`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 32
        )
        INSERT INTO attachment_uploads (
          upload_id, upload_key, canonical_input_sha256, room_id, uploader_actor_id,
          session_family_id, access_revision, lifecycle_generation, expected_bytes,
          received_bytes, expected_sha256, original_filename, declared_mime, format_hint,
          status, terminal_reason_code, created_at, updated_at, idle_expires_at,
          absolute_expires_at
        )
        SELECT
          printf('capacity-upload-%02d', value), printf('capacity-key-%02d', value),
          '${SHA_A}', 'attachment-room-2', 'attachment-human', 'attachment-family',
          0, 0, 4, 0, '${SHA_A}', printf('capacity-%02d.txt', value), 'text/plain',
          'txt', 'open', NULL, '2026-08-19T08:00:00.000Z',
          '2026-08-19T08:00:00.000Z', '2026-08-19T08:30:00.000Z',
          '2026-08-20T08:00:00.000Z'
        FROM sequence
      `);

      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        beginAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: beginInput({ requestId: "capacity-global", uploadKey: "capacity-global" }),
          clock,
          ids,
        })), 429, "attachment_capacity_limited");
      expect(database.prepare("SELECT COUNT(*) AS count FROM attachment_uploads").get())
        .toEqual({ count: 32 });
    } finally {
      database.close();
    }
  });

  it("commits checkpoint receipts, exact chunk replay, conflicts, and rollback atomically", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const uploadId = beginUpload(database, ids);
      const command = {
        requestId: "chunk-request-1",
        uploadId,
        ordinal: 0,
        offset: 0,
        byteLength: 4,
        chunkSha256: SHA_A,
        partObjectKey: `part_${SHA_A}`,
      } as const;
      const first = runAttachmentAuthorityImmediateTransaction(database, () =>
        recordAttachmentChunkInTransaction(database, { context: UPLOADER, command, clock }));
      const replay = runAttachmentAuthorityImmediateTransaction(database, () =>
        recordAttachmentChunkInTransaction(database, {
          context: UPLOADER,
          command: { ...command, requestId: "chunk-replay" },
          clock,
        }));
      expect(first).toEqual({
        uploadId, ordinal: 0, acknowledgedBytes: 4, expectedBytes: 4, replayed: false,
      });
      expect(replay).toEqual({ ...first, replayed: true });
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        recordAttachmentChunkInTransaction(database, {
          context: UPLOADER,
          command: { ...command, requestId: "chunk-conflict", chunkSha256: SHA_B },
          clock,
        })), 409, "upload_offset_conflict");

      const secondUpload = runAttachmentAuthorityImmediateTransaction(database, () =>
        beginAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: beginInput({ requestId: "begin-second", uploadKey: "upload-key-2" }),
          clock,
          ids,
        })).uploadId;
      expect(() => runAttachmentAuthorityImmediateTransaction(database, () => {
        recordAttachmentChunkInTransaction(database, {
          context: UPLOADER,
          command: {
            ...command,
            requestId: "rollback",
            uploadId: secondUpload,
            partObjectKey: `part_2_${SHA_A}`,
          },
          clock,
        });
        throw new Error("inject rollback");
      })).toThrow("inject rollback");
      expect(database.prepare(`
        SELECT received_bytes AS receivedBytes FROM attachment_uploads WHERE upload_id = ?
      `).get(secondUpload)).toEqual({ receivedBytes: 0 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM attachment_upload_chunks WHERE upload_id = ?
      `).get(secondUpload)).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("finalizes only injected opaque metadata and atomically emits uploader-private authority", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const uploadId = beginUpload(database, ids);
      checkpointUpload(database, ids, uploadId);
      expect(readAttachmentUploadAssemblyPlanDatabaseQuery(database, {
        context: UPLOADER,
        uploadId,
        clock,
        ids,
      })).toEqual({
        uploadId,
        attachmentId: uuid(101),
        chunkCount: 1,
        expectedBytes: 4,
        expectedSha256: SHA_A,
        format: "txt",
      });
      const command = {
        requestId: "finalize-request-1",
        uploadId,
        storage: {
          quarantineObjectKey: `quarantine_${SHA_A}`,
          byteSize: 4,
          sha256: SHA_A,
          format: "txt" as const,
          detectedMime: "text/plain" as const,
        },
      };
      const first = runAttachmentAuthorityImmediateTransaction(database, () =>
        finalizeAttachmentUploadInTransaction(database, {
          context: UPLOADER, command, clock, ids,
        }));
      const replay = runAttachmentAuthorityImmediateTransaction(database, () =>
        finalizeAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: { ...command, requestId: "finalize-replay" },
          clock,
          ids,
        }));
      expect(first).toMatchObject({
        uploadId, attachmentId: uuid(101), status: "accepted-quarantined",
        generation: 1, replayed: false,
      });
      expect(replay).toEqual({ ...first, replayed: true });
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        finalizeAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: {
            ...command,
            requestId: "finalize-changed",
            storage: { ...command.storage, sha256: SHA_B },
          },
          clock,
          ids,
        })), 409, "idempotency_conflict");
      expect(database.prepare(`
        SELECT status FROM attachment_uploads WHERE upload_id = ?
      `).get(uploadId)).toEqual({ status: "accepted" });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM events
        WHERE stream_kind = 'identity' AND event_type = 'attachment.private.status-changed'
      `).get()).toEqual({ count: 1 });
      expect(database.prepare(`
        SELECT target_kind AS targetKind, target_id AS targetId
        FROM outbox_deliveries
      `).get()).toEqual({ targetKind: "principal", targetId: "attachment-human" });
      expect(listPendingOutboxDatabaseQuery(database, 10, NOW)).toMatchObject([{
        targetKind: "principal",
        targetId: "attachment-human",
        event: {
          streamKind: "identity",
          type: "attachment.private.status-changed",
          payload: { attachment: { attachmentId: uuid(101), sourceMessageId: null } },
        },
      }]);
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM events WHERE stream_kind = 'room'
      `).get()).toEqual({ count: 0 });
      const persisted = JSON.stringify({
        attachment: database.prepare("SELECT * FROM attachments").get(),
        events: database.prepare("SELECT payload_json FROM events").all(),
        outbox: database.prepare("SELECT * FROM outbox_deliveries").all(),
        receipts: database.prepare("SELECT response_json FROM idempotency_records").all(),
      });
      for (const forbidden of [
        "RAW_ATTACHMENT_SENTINEL", "/Users/", "file://", "https://", "access-token-hash",
      ]) expect(persisted).not.toContain(forbidden);
    } finally {
      database.close();
    }
  });

  it("rolls finalize metadata, event, outbox, and receipt back together", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const uploadId = beginUpload(database, ids);
      checkpointUpload(database, ids, uploadId);
      expect(() => runAttachmentAuthorityImmediateTransaction(database, () => {
        finalizeAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "finalize-rollback",
            uploadId,
            storage: {
              quarantineObjectKey: `quarantine_${SHA_A}`,
              byteSize: 4,
              sha256: SHA_A,
              format: "txt",
              detectedMime: "text/plain",
            },
          },
          clock,
          ids,
        });
        throw new Error("after attachment outbox");
      })).toThrow("after attachment outbox");
      expect(database.prepare("SELECT COUNT(*) AS count FROM attachments").get())
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT status FROM attachment_uploads WHERE upload_id = ?
      `).get(uploadId)).toEqual({ status: "open" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM events").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get())
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM idempotency_records
        WHERE scope LIKE '%attachment.upload.finalize%'
      `).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("exposes only current unbound processing plans for bounded restart recovery", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const { attachmentId } = createQuarantinedAttachment(database, ids);
      expect(readAttachmentProcessingPlanDatabaseQuery(database, {
        context: WORKER,
        attachmentId,
        expectedGeneration: 1,
      })).toEqual({
        attachmentId,
        generation: 1,
        format: "txt",
        declaredMime: "text/plain",
        byteSize: 4,
        sha256: SHA_A,
        stage: "accepted-quarantined",
      });
      expect(listRecoverableAttachmentProcessingDatabaseQuery(database, {
        context: WORKER,
        limit: 64,
      })).toEqual({
        candidates: [{
          attachmentId,
          generation: 1,
          format: "txt",
          declaredMime: "text/plain",
          byteSize: 4,
          sha256: SHA_A,
          stage: "accepted-quarantined",
        }],
      });
      expectDatabaseError(() => readAttachmentProcessingPlanDatabaseQuery(database, {
        context: WORKER,
        attachmentId,
        expectedGeneration: 2,
      }), 409, "generation_conflict");
    } finally {
      database.close();
    }
  });

  it("cancels upload/artifact idempotently and retries only the expected failed generation", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const openUpload = beginUpload(database, ids, "cancel-open");
      const cancelled = runAttachmentAuthorityImmediateTransaction(database, () =>
        cancelAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: { requestId: "cancel-open", uploadId: openUpload },
          clock,
          ids,
        }));
      const replay = runAttachmentAuthorityImmediateTransaction(database, () =>
        cancelAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: { requestId: "cancel-open-replay", uploadId: openUpload },
          clock,
          ids,
        }));
      expect(cancelled).toEqual({ uploadId: openUpload, attachmentId: null, replayed: false });
      expect(replay).toEqual({ ...cancelled, replayed: true });

      const { attachmentId } = createQuarantinedAttachment(database, ids);
      const scanner = runAttachmentAuthorityImmediateTransaction(database, () =>
        claimAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId,
            expectedGeneration: 1,
            adapter: {
              kind: "scanner", name: "clamav", version: "1.0", timeoutMs: 120_000,
              stdoutLimitBytes: 8_388_608, stderrLimitBytes: 65_536,
            },
          },
          clock,
          ids,
        }));
      const failed = runAttachmentAuthorityImmediateTransaction(database, () => {
        startAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: { attachmentId, expectedGeneration: 1, attemptNumber: scanner.attemptNumber },
          clock,
        });
        return completeAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId,
            expectedGeneration: 1,
            attemptNumber: scanner.attemptNumber,
            result: { status: "retryable-failed", failureCode: "scanner_unavailable" },
          },
          clock,
          ids,
        });
      });
      const failedReplay = runAttachmentAuthorityImmediateTransaction(database, () =>
        completeAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId,
            expectedGeneration: 1,
            attemptNumber: scanner.attemptNumber,
            result: { status: "retryable-failed", failureCode: "scanner_unavailable" },
          },
          clock,
          ids,
        }));
      expect(failedReplay).toEqual({ ...failed, replayed: true });
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        completeAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId,
            expectedGeneration: 1,
            attemptNumber: scanner.attemptNumber,
            result: { status: "retryable-failed", failureCode: "scanner_timeout" },
          },
          clock,
          ids,
        })), 409, "generation_conflict");
      const retried = runAttachmentAuthorityImmediateTransaction(database, () =>
        retryAttachmentProcessingInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "retry-request", attachmentId, expectedGeneration: 1,
          },
          clock,
          ids,
        }));
      expect(retried).toEqual({ attachmentId, generation: 2, replayed: false });
      const retryReplay = runAttachmentAuthorityImmediateTransaction(database, () =>
        retryAttachmentProcessingInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "retry-replay", attachmentId, expectedGeneration: 1,
          },
          clock,
          ids,
        }));
      expect(retryReplay).toEqual({ ...retried, replayed: true });
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        retryAttachmentProcessingInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "retry-stale", attachmentId, expectedGeneration: 99,
          },
          clock,
          ids,
        })), 409, "generation_conflict");
    } finally {
      database.close();
    }
  });

  it("fences archive/access reduction and late worker CAS while malware is permanent", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const first = createQuarantinedAttachment(database, ids);
      const attempt = runAttachmentAuthorityImmediateTransaction(database, () =>
        claimAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId: first.attachmentId,
            expectedGeneration: 1,
            adapter: {
              kind: "scanner", name: "clamav", version: "1.0", timeoutMs: 120_000,
              stdoutLimitBytes: 8_388_608, stderrLimitBytes: 65_536,
            },
          },
          clock,
          ids,
        }));
      runAttachmentAuthorityImmediateTransaction(database, () =>
        startAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId: first.attachmentId,
            expectedGeneration: 1,
            attemptNumber: attempt.attemptNumber,
          },
          clock,
        }));
      runAttachmentAuthorityImmediateTransaction(database, () =>
        cancelAttachmentUploadInTransaction(database, {
          context: UPLOADER,
          command: { requestId: "cancel-processing", uploadId: first.uploadId },
          clock,
          ids,
        }));
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        completeAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId: first.attachmentId,
            expectedGeneration: 1,
            attemptNumber: attempt.attemptNumber,
            result: { status: "succeeded" },
          },
          clock,
          ids,
        })), 409, "generation_conflict");
      expect(database.prepare(`
        SELECT status FROM attachment_processing_attempts
        WHERE attachment_id = ? AND attempt_number = ?
      `).get(first.attachmentId, attempt.attemptNumber)).toEqual({ status: "cancelled" });

      const second = createQuarantinedAttachment(database, ids, "2");
      database.exec(`
        INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
        VALUES ('attachment-room', 1, 0)
      `);
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        claimAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId: second.attachmentId,
            expectedGeneration: 1,
            adapter: {
              kind: "scanner", name: "clamav", version: "1.0", timeoutMs: 120_000,
              stdoutLimitBytes: 8_388_608, stderrLimitBytes: 65_536,
            },
          },
          clock,
          ids,
        })), 403, "attachment_forbidden");
      database.exec("DELETE FROM room_access_authority WHERE room_id = 'attachment-room'");

      const malwareAttempt = runAttachmentAuthorityImmediateTransaction(database, () =>
        claimAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId: second.attachmentId,
            expectedGeneration: 1,
            adapter: {
              kind: "scanner", name: "clamav", version: "1.0", timeoutMs: 120_000,
              stdoutLimitBytes: 8_388_608, stderrLimitBytes: 65_536,
            },
          },
          clock,
          ids,
        }));
      runAttachmentAuthorityImmediateTransaction(database, () => {
        startAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId: second.attachmentId,
            expectedGeneration: 1,
            attemptNumber: malwareAttempt.attemptNumber,
          },
          clock,
        });
        completeAttachmentProcessingAttemptInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId: second.attachmentId,
            expectedGeneration: 1,
            attemptNumber: malwareAttempt.attemptNumber,
            result: { status: "malware-rejected", failureCode: "malware_detected" },
          },
          clock,
          ids,
        });
      });
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        retryAttachmentProcessingInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "retry-malware", attachmentId: second.attachmentId,
            expectedGeneration: 1,
          },
          clock,
          ids,
        })), 409, "generation_conflict");
      expect(readAttachmentStatusDatabaseQuery(database, {
        context: UPLOADER, attachmentId: second.attachmentId, clock,
      }).attachment.processingStatus).toBe("malware-rejected");
    } finally {
      database.close();
    }
  });

  it("requires scanner/extraction provenance before ready and exposes no extracted text", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const { attachmentId } = createQuarantinedAttachment(database, ids);
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        markAttachmentReadyInTransaction(database, {
          context: WORKER,
          command: {
            attachmentId,
            expectedGeneration: 1,
            objectKey: `object_${SHA_A}`,
            byteSize: 4,
            sha256: SHA_A,
          },
          clock,
          ids,
        })), 409, "attachment_not_ready");
      makeReady(database, ids, attachmentId);
      const status = readAttachmentStatusDatabaseQuery(database, {
        context: UPLOADER, attachmentId, clock,
      });
      expect(status.attachment).toMatchObject({
        attachmentId,
        processingStatus: "ready",
        readyAt: new Date(NOW).toISOString(),
        provenance: {
          scanner: { kind: "clamav", version: "1.0" },
          extraction: {
            method: "plain-text", tool: "builtin", version: "1.0",
            artifactSha256: SHA_B, artifactByteSize: 3, pageCount: null,
          },
          ocr: null,
        },
      });
      const serialized = JSON.stringify({
        status,
        extractionRows: database.prepare("SELECT * FROM attachment_extraction_artifacts").all(),
        privateEvents: database.prepare(`
          SELECT payload_json FROM events WHERE stream_kind = 'identity'
        `).all(),
      });
      expect(serialized).not.toContain("RAW_EXTRACTED_TEXT_SENTINEL");
      expect(serialized).not.toContain("body");
      expect(serialized).not.toContain("content");
    } finally {
      database.close();
    }
  });

  it("binds ready source once, emits only then to Room, and reauthorizes every access", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const { attachmentId } = createQuarantinedAttachment(database, ids);
      makeReady(database, ids, attachmentId);
      insertMessage(database, "message-rollback");
      insertMessage(database, "message-1");
      insertMessage(database, "message-2");
      const beforeBind = database.prepare(`
        SELECT COUNT(*) AS count FROM events WHERE stream_kind = 'room'
      `).get();
      expect(beforeBind).toEqual({ count: 0 });
      expect(() => runAttachmentAuthorityImmediateTransaction(database, () => {
        bindAttachmentToMessageInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "bind-rollback", roomId: "attachment-room",
            messageId: "message-rollback", attachmentId,
          },
          clock,
          ids,
        });
        throw new Error("submit transaction rollback");
      })).toThrow("submit transaction rollback");
      expect(database.prepare(`
        SELECT source_message_id AS sourceMessageId, source_operational_state AS sourceState
        FROM attachments WHERE attachment_id = ?
      `).get(attachmentId)).toEqual({ sourceMessageId: null, sourceState: "unbound" });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM events WHERE stream_kind = 'room'
      `).get()).toEqual({ count: 0 });
      const bound = runAttachmentAuthorityImmediateTransaction(database, () =>
        bindAttachmentToMessageInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "bind-request", roomId: "attachment-room",
            messageId: "message-1", attachmentId,
          },
          clock,
          ids,
        }));
      const replay = runAttachmentAuthorityImmediateTransaction(database, () =>
        bindAttachmentToMessageInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "bind-replay", roomId: "attachment-room",
            messageId: "message-1", attachmentId,
          },
          clock,
          ids,
        }));
      expect(bound).toMatchObject({
        attachmentId, messageId: "message-1", sourceEligibility: "bound-active",
        replayed: false,
      });
      expect(replay).toEqual({ ...bound, replayed: true });
      expectDatabaseError(() => runAttachmentAuthorityImmediateTransaction(database, () =>
        bindAttachmentToMessageInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "bind-loser", roomId: "attachment-room",
            messageId: "message-2", attachmentId,
          },
          clock,
          ids,
        })), 409, "attachment_already_bound");
      expect(database.prepare(`
        SELECT event_type AS type FROM events WHERE stream_kind = 'room'
      `).all()).toEqual([{ type: "room.attachment.bound" }]);
      expect(database.prepare(`
        SELECT target_kind AS targetKind, target_id AS targetId
        FROM outbox_deliveries WHERE target_kind = 'room'
      `).get()).toEqual({ targetKind: "room", targetId: "attachment-room" });

      const firstDecision = authorizeAttachmentAccessDatabaseQuery(database, {
        context: READER,
        command: { attachmentId, operation: "preview", representation: "safe-text" },
        clock,
      });
      expect(firstDecision).toMatchObject({
        allowed: true, attachmentId, representation: "safe-text",
        objectKey: `extraction_${SHA_B}`, originalFilename: "safe.txt",
        generation: 1, lifecycleGeneration: 0, accessRevision: 0,
      });
      database.exec(`
        UPDATE sessions SET revoked_at = ${NOW}
        WHERE access_token_hash = 'reader-access-token-hash'
      `);
      expect(authorizeAttachmentAccessDatabaseQuery(database, {
        context: READER,
        command: { attachmentId, operation: "download" },
        clock,
      })).toEqual({ allowed: false, status: 401, code: "unauthenticated" });

      expect(authorizeAttachmentAccessDatabaseQuery(database, {
        context: OTHER,
        command: { attachmentId, operation: "preview", representation: "original" },
        clock,
      }).allowed).toBe(true);
      database.exec(`
        UPDATE rooms SET status = 'archived', archive_generation = 1,
          archived_at = '2026-08-19T08:01:00.000Z'
        WHERE id = 'attachment-room'
      `);
      const archivedDownload = authorizeAttachmentAccessDatabaseQuery(database, {
        context: OTHER,
        command: { attachmentId, operation: "download" },
        clock,
      });
      expect(archivedDownload).toMatchObject({
        allowed: true,
        originalFilename: "safe.txt",
        generation: 1,
        lifecycleGeneration: 1,
        accessRevision: 0,
      });
    } finally {
      database.close();
    }
  });

  it("submits the Human envelope, attachment source, stable events, outbox and receipt in one transaction", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const first = createQuarantinedAttachment(database, ids, "atomic-1");
      makeReady(database, ids, first.attachmentId);
      const receipt = submitHumanMessageDatabaseCommand(database, {
        context: {
          ...UPLOADER,
          requestId: "message-with-attachment-request",
          idempotencyKey: "message-with-attachment",
        },
        message: {
          messageId: "message-with-attachment",
          roomId: "attachment-room",
          body: "ready attachment",
          mentionedTargets: [],
          attachments: [{ attachmentId: first.attachmentId }],
        },
        now: NOW,
      });
      expect(receipt).toMatchObject({ messageId: "message-with-attachment", replayed: false });
      expect(database.prepare(`
        SELECT source_message_id AS sourceMessageId,
               source_operational_state AS sourceState
        FROM attachments WHERE attachment_id = ?
      `).get(first.attachmentId)).toEqual({
        sourceMessageId: "message-with-attachment",
        sourceState: "bound-active",
      });
      expect(database.prepare(`
        SELECT message_id AS messageId, attachment_id AS attachmentId,
               operational_state AS operationalState
        FROM message_attachment_links WHERE attachment_id = ?
      `).get(first.attachmentId)).toEqual({
        messageId: "message-with-attachment",
        attachmentId: first.attachmentId,
        operationalState: "active",
      });
      expect(database.prepare(`
        SELECT event_type AS type FROM events
        WHERE stream_kind = 'room' ORDER BY stream_seq
      `).all()).toEqual([
        { type: "room.message.accepted" },
        { type: "room.attachment.bound" },
      ]);
      recallHumanMessageDatabaseCommand(database, {
        context: {
          ...UPLOADER,
          requestId: "recall-message-with-attachment",
          idempotencyKey: "recall-message-with-attachment",
        },
        command: {
          roomId: "attachment-room",
          messageId: "message-with-attachment",
          expectedRevision: 1,
        },
        now: NOW + 1,
      });
      expect(database.prepare(`
        SELECT source_operational_state AS sourceState
        FROM attachments WHERE attachment_id = ?
      `).get(first.attachmentId)).toEqual({ sourceState: "excluded-recalled" });
      expect(database.prepare(`
        SELECT operational_state AS operationalState
        FROM message_attachment_links WHERE attachment_id = ?
      `).get(first.attachmentId)).toEqual({ operationalState: "excluded_recalled" });
      expect(database.prepare(`
        SELECT event_type AS type FROM events
        WHERE stream_kind = 'room' ORDER BY stream_seq
      `).all()).toEqual([
        { type: "room.message.accepted" },
        { type: "room.attachment.bound" },
        { type: "room.message.recalled" },
        { type: "room.attachment.excluded" },
      ]);
      const pending = listPendingOutboxDatabaseQuery(database, 10, NOW + 1);
      const boundDelivery = pending.find((item) => item.event.type === "room.attachment.bound");
      const excludedDelivery = pending.find((item) => item.event.type === "room.attachment.excluded");
      const candidate = {
        connectionId: "attachment-recall-reader",
        principal: UPLOADER.principal,
        sessionId: UPLOADER.sessionId,
        sessionFamilyId: UPLOADER.sessionFamilyId,
        credentialGeneration: 1,
      };
      expect(boundDelivery).toBeDefined();
      expect(excludedDelivery).toBeDefined();
      expect(authorizeOutboxCandidateDatabaseQuery(
        database, boundDelivery!.deliveryId, candidate, NOW + 1,
      )).toBe(false);
      expect(authorizeOutboxCandidateDatabaseQuery(
        database, excludedDelivery!.deliveryId, candidate, NOW + 1,
      )).toBe(true);

      const rollbackDatabase = createDatabase();
      const rollbackIds = createIds();
      try {
        const second = createQuarantinedAttachment(rollbackDatabase, rollbackIds, "atomic-2");
        makeReady(rollbackDatabase, rollbackIds, second.attachmentId);
        expect(() => submitHumanMessageDatabaseCommand(rollbackDatabase, {
          context: {
            ...UPLOADER,
            requestId: "message-attachment-rollback-request",
            idempotencyKey: "message-attachment-rollback",
          },
          message: {
            messageId: "message-attachment-rollback",
            roomId: "attachment-room",
            body: "rollback attachment",
            mentionedTargets: [],
            attachments: [{ attachmentId: second.attachmentId }],
          },
          now: NOW,
          onFaultPointForTest(point) {
            if (point === "after-attachment") throw new Error("after-attachment-rollback");
          },
        })).toThrow("after-attachment-rollback");
        expect(rollbackDatabase.prepare("SELECT 1 FROM messages WHERE id = ?").get(
          "message-attachment-rollback",
        )).toBeUndefined();
        expect(rollbackDatabase.prepare(`
          SELECT source_message_id AS sourceMessageId,
                 source_operational_state AS sourceState
          FROM attachments WHERE attachment_id = ?
        `).get(second.attachmentId)).toEqual({ sourceMessageId: null, sourceState: "unbound" });
        expect(rollbackDatabase.prepare(`
          SELECT COUNT(*) AS count FROM message_attachment_links WHERE attachment_id = ?
        `).get(second.attachmentId)).toEqual({ count: 0 });
        expect(rollbackDatabase.prepare(`
          SELECT COUNT(*) AS count FROM events
          WHERE json_extract(payload_json, '$.id') = 'message-attachment-rollback'
             OR json_extract(payload_json, '$.attachment.sourceMessageId') =
                'message-attachment-rollback'
        `).get()).toEqual({ count: 0 });
      } finally {
        rollbackDatabase.close();
      }
    } finally {
      database.close();
    }
  });

  it("keeps unbound status principal-private and denies recalled operational access", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const { attachmentId } = createQuarantinedAttachment(database, ids);
      expectDatabaseError(() => readAttachmentStatusDatabaseQuery(database, {
        context: OTHER, attachmentId, clock,
      }), 403, "attachment_forbidden");
      makeReady(database, ids, attachmentId);
      insertMessage(database, "message-recalled");
      runAttachmentAuthorityImmediateTransaction(database, () =>
        bindAttachmentToMessageInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "bind-recalled", roomId: "attachment-room",
            messageId: "message-recalled", attachmentId,
          },
          clock,
          ids,
        }));
      database.exec(`
        INSERT INTO message_recall_fences (
          fence_id, room_id, source_message_id, source_revision, scope_kind,
          invocation_intent_id, execution_id, reason, created_at
        ) VALUES (
          'attachment-recall-fence', 'attachment-room', 'message-recalled', 1,
          'message', NULL, NULL, 'message_recalled', '2026-08-19T08:02:00.000Z'
        );
        UPDATE message_envelopes
        SET lifecycle = 'recalled', recalled_at = '2026-08-19T08:02:00.000Z',
            recalled_by_actor_id = 'attachment-human'
        WHERE message_id = 'message-recalled';
        UPDATE message_attachment_links SET operational_state = 'excluded_recalled'
        WHERE message_id = 'message-recalled';
      `);
      expect(authorizeAttachmentAccessDatabaseQuery(database, {
        context: UPLOADER,
        command: { attachmentId, operation: "download" },
        clock,
      })).toEqual({ allowed: false, status: 403, code: "attachment_forbidden" });
    } finally {
      database.close();
    }
  });

  it("authorizes Agent extraction only for a current running execution and active source", () => {
    const database = createDatabase();
    const ids = createIds();
    try {
      const { attachmentId } = createQuarantinedAttachment(database, ids, "agent-reader");
      makeReady(database, ids, attachmentId);
      insertMessage(database, "message-agent-source");
      runAttachmentAuthorityImmediateTransaction(database, () =>
        bindAttachmentToMessageInTransaction(database, {
          context: UPLOADER,
          command: {
            requestId: "bind-agent-source", roomId: "attachment-room",
            messageId: "message-agent-source", attachmentId,
          },
          clock,
          ids,
        }));
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('attachment-agent', 'agent', 'Attachment Agent');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES (
          'attachment-room', 'attachment-agent', 'agent', NULL, 'active', '[]',
          '2026-08-19T08:00:00.000Z', '2026-08-19T08:00:00.000Z', 0
        );
        INSERT INTO agent_executions (
          id, room_id, room_archive_generation, agent_id, trigger_message_id, status,
          started_at, completed_at, result_json, requester_actor_id, tool_name,
          action_category, tool_dispatch_phase, current_attempt_seq, retry_cycle,
          retry_ordinal, recovery_cursor, queued_at, updated_at, execution_generation
        ) VALUES (
          'attachment-execution', 'attachment-room', 0, 'attachment-agent',
          'message-agent-source', 'running', '2026-08-19T08:00:00.000Z', NULL,
          NULL, 'attachment-human', 'context-read', 'tool_call', 'dispatched',
          1, 1, 1, 0, '2026-08-19T08:00:00.000Z',
          '2026-08-19T08:00:00.000Z', 1
        );
      `);
      seedCanonicalAgentProfileFixture(database, {
        actorId: "attachment-agent",
        profileId: "attachment-profile",
        displayName: "Attachment Agent",
        now: "2026-08-19T08:00:00.000Z",
      });
      seedCanonicalRoomAssignmentFixture(database, {
        assignmentId: "attachment-assignment",
        roomId: "attachment-room",
        profileId: "attachment-profile",
        actorId: "attachment-agent",
        now: "2026-08-19T08:00:00.000Z",
      });
      const input = {
        context: {
          kind: "agent-execution" as const,
          executionId: "attachment-execution",
          expectedExecutionGeneration: 1,
        },
        attachmentId,
        expectedAttachmentGeneration: 1,
      };
      expect(authorizeAgentAttachmentExtractionDatabaseQuery(database, input)).toEqual({
        kind: "agent-extraction",
        executionId: "attachment-execution",
        executionGeneration: 1,
        agentId: "attachment-agent",
        roomId: "attachment-room",
        roomLifecycleGeneration: 0,
        roomAccessRevision: 0,
        attachmentId,
        attachmentGeneration: 1,
        sourceMessageId: "message-agent-source",
        sourceRevision: 1,
        originalFilename: "safe.txt",
        format: "txt",
        method: "plain-text",
        tool: "builtin",
        toolVersion: "1.0",
        pageCount: null,
        objectKey: `extraction_${SHA_B}`,
        sha256: SHA_B,
        byteSize: 3,
      });

      transitionRoomAssignmentPauseFixture(database, {
        assignmentId: "attachment-assignment",
        expectedRevision: 1,
        paused: true,
        changedByHumanActorId: "attachment-human",
        now: "2026-08-19T08:01:00.000Z",
      });
      expectDatabaseError(() => authorizeAgentAttachmentExtractionDatabaseQuery(database, input),
        403, "attachment_forbidden");
      transitionRoomAssignmentPauseFixture(database, {
        assignmentId: "attachment-assignment",
        expectedRevision: 2,
        paused: false,
        changedByHumanActorId: "attachment-human",
        now: "2026-08-19T08:02:00.000Z",
      });
      recallHumanMessageDatabaseCommand(database, {
        context: {
          ...UPLOADER,
          requestId: "recall-agent-source",
          idempotencyKey: "recall-agent-source",
        },
        command: {
          roomId: "attachment-room",
          messageId: "message-agent-source",
          expectedRevision: 1,
        },
        now: NOW + 1,
      });
      expectDatabaseError(() => authorizeAgentAttachmentExtractionDatabaseQuery(database, input),
        403, "attachment_forbidden");
    } finally {
      database.close();
    }
  });
});
