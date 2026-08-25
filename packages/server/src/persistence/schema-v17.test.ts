import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V17_STATEMENT_COUNT_FOR_TEST,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  migrateAuthorityDatabaseToVersion16ForTest,
  readSchemaVersion,
} from "./schema.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const V16_CHECKSUM =
  "51e5b5114b90bc8407d7eec86a559da0170cec1ec0bfc1c5587d828a5765f1a7";

const V17_TABLE_COLUMNS = {
  attachment_extraction_artifacts: [
    "artifact_id", "attachment_id", "processing_generation", "method",
    "tool_name", "tool_version", "object_key", "sha256", "byte_size",
    "page_start", "page_end", "range_start", "range_end", "created_at",
  ],
  attachment_processing_attempts: [
    "attachment_id", "processing_generation", "attempt_number", "adapter_kind",
    "adapter_name", "adapter_version", "status", "failure_code", "timeout_ms",
    "stdout_limit_bytes", "stderr_limit_bytes", "started_at", "finished_at",
  ],
  attachment_upload_chunks: [
    "upload_id", "ordinal", "byte_offset", "byte_length", "chunk_sha256",
    "part_object_key", "created_at",
  ],
  attachment_uploads: [
    "upload_id", "upload_key", "canonical_input_sha256", "room_id",
    "uploader_actor_id", "session_family_id", "access_revision",
    "lifecycle_generation", "expected_bytes", "received_bytes", "expected_sha256",
    "original_filename", "declared_mime", "format_hint", "status",
    "terminal_reason_code", "created_at", "updated_at", "idle_expires_at",
    "absolute_expires_at",
  ],
  attachments: [
    "attachment_id", "source_upload_id", "room_id", "uploader_actor_id",
    "original_filename", "declared_mime", "detected_mime", "format", "byte_size",
    "sha256", "quarantine_object_key", "object_key", "processing_status",
    "processing_generation", "failure_code", "source_message_id",
    "source_operational_state", "source_bound_at", "lifecycle_generation",
    "access_revision", "created_at", "updated_at", "ready_at",
  ],
} as const;

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v17-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function withRestartedDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v17-restart-"));
  const databasePath = join(directory, "authority.sqlite");
  const initial = new DatabaseSync(databasePath);
  let initialClosed = false;
  try {
    migrateAuthorityDatabase(initial);
    initial.close();
    initialClosed = true;
    const restarted = new DatabaseSync(databasePath);
    try {
      operation(restarted);
    } finally {
      restarted.close();
    }
  } finally {
    if (!initialClosed) {
      initial.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function tableColumns(database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info('${table}')`).all()
    .map((row) => String(row.name));
}

function seedAuthority(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO actors (id, kind, display_name) VALUES
      ('attachment-human', 'human', 'Uploader'),
      ('attachment-human-2', 'human', 'Other Human');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq) VALUES
      ('identity', 'attachment-human', 0, 1),
      ('identity', 'attachment-human-2', 0, 1),
      ('room', 'attachment-room', 0, 1),
      ('room', 'attachment-room-2', 0, 1);
    INSERT INTO rooms (id, name, status, created_at) VALUES
      ('attachment-room', 'Room', 'active', '2026-08-19T00:00:00.000Z'),
      ('attachment-room-2', 'Other', 'active', '2026-08-19T00:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('attachment-room', 'attachment-human', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('attachment-room', 'attachment-human-2', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0),
      ('attachment-room-2', 'attachment-human', 'human', 'member', NULL, '[]',
       '2026-08-19T00:00:00.000Z', NULL, 0);
    UPDATE rooms SET owner_actor_id = 'attachment-human';
    INSERT INTO session_families (
      family_id, public_id, account_id, actor_id, device_id, device_label,
      platform, created_at, refresh_expires_at, revoked_at
    ) VALUES (
      'attachment-family', 'attachment-public-family', 'attachment-account',
      'attachment-human', 'attachment-device', 'Mac', 'macos', 1, 9999999999999, NULL
    );
    INSERT INTO sessions (
      family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
      access_expires_at, refresh_expires_at, revoked_at
    ) VALUES (
      'attachment-family', 'attachment-account', 'attachment-human',
      'attachment-access-token-hash', 'attachment-refresh-token-hash',
      9999999999998, 9999999999999, NULL
    );
  `);
}

function insertOpenUpload(
  database: DatabaseSync,
  uploadId = "upload-1",
  options: {
    readonly declaredMime?: string | null;
    readonly expectedBytes?: number;
  } = {},
): void {
  const declaredMime = options.declaredMime === undefined ? "text/plain" : options.declaredMime;
  const expectedBytes = options.expectedBytes ?? 4;
  database.prepare(`
    INSERT INTO attachment_uploads (
      upload_id, upload_key, canonical_input_sha256, room_id, uploader_actor_id,
      session_family_id, access_revision, lifecycle_generation, expected_bytes,
      received_bytes, expected_sha256, original_filename, declared_mime, format_hint,
      status, terminal_reason_code, created_at, updated_at, idle_expires_at,
      absolute_expires_at
    ) VALUES (?, ?, ?, 'attachment-room', 'attachment-human',
      'attachment-family', 0, 0, ?, 0, ?, 'safe.txt', ?, 'txt',
      'open', NULL, '2026-08-19T00:01:00.000Z', '2026-08-19T00:01:00.000Z',
      '2026-08-19T00:31:00.000Z', '2026-08-20T00:01:00.000Z')
  `).run(uploadId, `upload-key-${uploadId}`, SHA_B, expectedBytes, SHA_A, declaredMime);
}

function insertCompleteUpload(database: DatabaseSync): void {
  insertOpenUpload(database);
  database.prepare(`
    INSERT INTO attachment_upload_chunks (
      upload_id, ordinal, byte_offset, byte_length, chunk_sha256,
      part_object_key, created_at
    ) VALUES ('upload-1', 0, 0, 4, ?, 'partopaque1', '2026-08-19T00:02:00.000Z')
  `).run(SHA_A);
  database.exec(`
    UPDATE attachment_uploads
    SET status = 'finalizing', updated_at = '2026-08-19T00:03:00.000Z'
    WHERE upload_id = 'upload-1';
    INSERT INTO attachments (
      attachment_id, source_upload_id, room_id, uploader_actor_id, original_filename,
      declared_mime, detected_mime, format, byte_size, sha256,
      quarantine_object_key, object_key, processing_status, processing_generation,
      failure_code, source_message_id, source_operational_state, source_bound_at,
      lifecycle_generation, access_revision, created_at, updated_at, ready_at
    ) VALUES (
      'attachment-1', 'upload-1', 'attachment-room', 'attachment-human', 'safe.txt',
      'text/plain', 'text/plain', 'txt', 4,
      '${SHA_A}', 'quarantineopaque1', NULL, 'quarantined', 1, NULL, NULL,
      'unbound', NULL, 0, 0, '2026-08-19T00:03:00.000Z',
      '2026-08-19T00:03:00.000Z', NULL
    );
    UPDATE attachment_uploads
    SET status = 'accepted', updated_at = '2026-08-19T00:03:00.000Z'
    WHERE upload_id = 'upload-1';
  `);
}

function moveAttachmentToReady(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO attachment_processing_attempts (
      attachment_id, processing_generation, attempt_number, adapter_kind,
      adapter_name, adapter_version, status, failure_code, timeout_ms,
      stdout_limit_bytes, stderr_limit_bytes, started_at, finished_at
    ) VALUES (
      'attachment-1', 1, 1, 'scanner', 'clamav', '1.0', 'queued', NULL,
      120000, 8388608, 65536, NULL, NULL
    );
    UPDATE attachments SET processing_status = 'scanning',
      updated_at = '2026-08-19T00:04:00.000Z' WHERE attachment_id = 'attachment-1';
    UPDATE attachment_processing_attempts SET status = 'running',
      started_at = '2026-08-19T00:04:00.000Z'
      WHERE attachment_id = 'attachment-1' AND attempt_number = 1;
    UPDATE attachment_processing_attempts SET status = 'succeeded',
      finished_at = '2026-08-19T00:05:00.000Z'
      WHERE attachment_id = 'attachment-1' AND attempt_number = 1;
    INSERT INTO attachment_processing_attempts (
      attachment_id, processing_generation, attempt_number, adapter_kind,
      adapter_name, adapter_version, status, failure_code, timeout_ms,
      stdout_limit_bytes, stderr_limit_bytes, started_at, finished_at
    ) VALUES (
      'attachment-1', 1, 2, 'extractor', 'builtin-text', '1.0', 'queued', NULL,
      60000, 8388608, 65536, NULL, NULL
    );
    UPDATE attachments SET processing_status = 'extracting',
      updated_at = '2026-08-19T00:06:00.000Z' WHERE attachment_id = 'attachment-1';
    UPDATE attachment_processing_attempts SET status = 'running',
      started_at = '2026-08-19T00:06:00.000Z'
      WHERE attachment_id = 'attachment-1' AND attempt_number = 2;
    UPDATE attachment_processing_attempts SET status = 'succeeded',
      finished_at = '2026-08-19T00:07:00.000Z'
      WHERE attachment_id = 'attachment-1' AND attempt_number = 2;
    INSERT INTO attachment_extraction_artifacts (
      artifact_id, attachment_id, processing_generation, method, tool_name,
      tool_version, object_key, sha256, byte_size, page_start, page_end,
      range_start, range_end, created_at
    ) VALUES (
      'extraction-1', 'attachment-1', 1, 'extracted-text', 'builtin-text', '1.0',
      'extractionopaque1', '${SHA_B}', 4, NULL, NULL, 0, 4,
      '2026-08-19T00:07:00.000Z'
    );
    UPDATE attachments SET processing_status = 'ready', object_key = 'objectopaque1',
      ready_at = '2026-08-19T00:08:00.000Z',
      updated_at = '2026-08-19T00:08:00.000Z'
      WHERE attachment_id = 'attachment-1';
  `);
}

function insertMessage(database: DatabaseSync, messageId: string, roomId = "attachment-room"): void {
  database.prepare(`
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES (?, ?, 'attachment-human', 'human', 'with attachment',
      '2026-08-19T00:09:00.000Z')
  `).run(messageId, roomId);
  database.prepare(`
    INSERT INTO message_revisions (
      message_id, revision, body, revised_at, revised_by_actor_id
    ) VALUES (?, 1, 'with attachment', '2026-08-19T00:09:00.000Z',
      'attachment-human')
  `).run(messageId);
  database.prepare(`
    INSERT INTO message_envelopes (
      message_id, room_id, message_kind, lifecycle, current_revision,
      revision_count, created_at, recalled_at, recalled_by_actor_id
    ) VALUES (?, ?, 'human', 'active', 1, 1,
      '2026-08-19T00:09:00.000Z', NULL, NULL)
  `).run(messageId, roomId);
}

describe("authority SQLite v17 Attachment Authority", () => {
  it("upgrades fresh and every immutable v1-v16 schema through v17 and restarts idempotently", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_SCHEMA_VERSION).toBe(22);
      expect(readSchemaVersion(database)).toBe(22);
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
        .toEqual({ count: 22 });
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
        .toEqual({ count: 22 });
    });

    for (let version = 1; version <= 16; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        expect(readSchemaVersion(database)).toBe(version);
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(22);
        expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
          .toEqual({ count: 22 });
      });
    }

    withRestartedDatabase((database) => {
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
      expect(readSchemaVersion(database)).toBe(22);
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
        .toEqual({ count: 22 });
    });
  }, 60_000);

  it("creates metadata-only v17 tables without changing the v16 migration", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_V17_STATEMENT_COUNT_FOR_TEST).toBe(31);
      for (const [table, columns] of Object.entries(V17_TABLE_COLUMNS)) {
        expect(listAuthorityTables(database)).toContain(table);
        expect(tableColumns(database, table)).toEqual(columns);
        for (const forbidden of ["body", "text", "content", "bytes", "raw", "path", "url"] as const) {
          expect(columns).not.toContain(forbidden);
        }
      }
      expect(database.prepare(
        "SELECT name, checksum FROM schema_migrations WHERE version = 16",
      ).get()).toEqual({ name: "message-authority-vnext", checksum: V16_CHECKSUM });
      expect(database.prepare(
        "SELECT name, checksum FROM schema_migrations WHERE version = 17",
      ).get()).toEqual({
        name: "attachment-authority-pipeline",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });
  });

  it("rolls every meaningful v17 statement back to the identical v16 database", () => {
    for (let statement = 1; statement <= AUTHORITY_V17_STATEMENT_COUNT_FOR_TEST; statement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToVersion16ForTest(database);
        seedAuthority(database);
        const beforeTables = listAuthorityTables(database);
        const beforeHistory = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        const beforeActors = database.prepare(
          "SELECT id, kind, display_name FROM actors ORDER BY id",
        ).all();

        expect(() => migrateAuthorityDatabase(database, { failAfterStatement: statement }))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(16);
        expect(listAuthorityTables(database)).toEqual(beforeTables);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(beforeHistory);
        expect(database.prepare(
          "SELECT id, kind, display_name FROM actors ORDER BY id",
        ).all()).toEqual(beforeActors);
      });
    }
  }, 60_000);

  it("enforces upload identity, bounded contiguous chunks, immutable opaque keys, and legal finalize", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedAuthority(database);
      expect(() => insertOpenUpload(database, "upload-zero", { expectedBytes: 0 }))
        .toThrow(/CHECK constraint failed/i);
      expect(() => insertOpenUpload(database, "upload-null-mime", { declaredMime: null }))
        .not.toThrow();
      insertOpenUpload(database);

      expect(() => database.prepare(`
        INSERT INTO attachment_upload_chunks (
          upload_id, ordinal, byte_offset, byte_length, chunk_sha256,
          part_object_key, created_at
        ) VALUES ('upload-1', 1, 0, 4, ?, 'outoforder', 'now')
      `).run(SHA_A)).toThrow(/chunk|sequence|offset/i);
      expect(() => database.prepare(`
        INSERT INTO attachment_upload_chunks (
          upload_id, ordinal, byte_offset, byte_length, chunk_sha256,
          part_object_key, created_at
        ) VALUES ('upload-1', 0, 0, 32769, ?, 'oversized', 'now')
      `).run(SHA_A)).toThrow();
      expect(() => database.prepare(`
        INSERT INTO attachment_upload_chunks (
          upload_id, ordinal, byte_offset, byte_length, chunk_sha256,
          part_object_key, created_at
        ) VALUES ('upload-1', 0, 0, 4, ?, '../escape', 'now')
      `).run(SHA_A)).toThrow();

      database.prepare(`
        INSERT INTO attachment_upload_chunks (
          upload_id, ordinal, byte_offset, byte_length, chunk_sha256,
          part_object_key, created_at
        ) VALUES ('upload-1', 0, 0, 4, ?, 'partopaque1', 'now')
      `).run(SHA_A);
      expect(database.prepare(
        "SELECT received_bytes AS receivedBytes FROM attachment_uploads WHERE upload_id = 'upload-1'",
      ).get()).toEqual({ receivedBytes: 4 });
      expect(() => database.exec(
        "UPDATE attachment_upload_chunks SET part_object_key = 'changed' WHERE upload_id = 'upload-1'",
      )).toThrow(/immutable/i);
      expect(() => database.exec(
        "UPDATE attachment_uploads SET status = 'accepted' WHERE upload_id = 'upload-1'",
      )).toThrow(/attachment|transition/i);
      database.exec(`
        UPDATE attachment_uploads SET status = 'rejected',
          terminal_reason_code = 'attachment_malformed'
        WHERE upload_id = 'upload-1'
      `);
      expect(() => database.exec(`
        UPDATE attachment_uploads SET terminal_reason_code = 'hash_mismatch'
        WHERE upload_id = 'upload-1'
      `)).toThrow(/transition/i);
    });

    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedAuthority(database);
      insertOpenUpload(database);
      database.exec(`
        UPDATE session_families SET revoked_at = 2
        WHERE family_id = 'attachment-family'
      `);
      expect(() => database.prepare(`
        INSERT INTO attachment_upload_chunks (
          upload_id, ordinal, byte_offset, byte_length, chunk_sha256,
          part_object_key, created_at
        ) VALUES ('upload-1', 0, 0, 4, ?, 'revokedpart', 'now')
      `).run(SHA_A)).toThrow(/chunk|sequence|authority/i);
      expect(() => database.exec(`
        UPDATE attachment_uploads SET status = 'finalizing'
        WHERE upload_id = 'upload-1'
      `)).toThrow(/transition|authority/i);
    });
  });

  it("requires scanner and extraction provenance before ready and rejects illegal state/generation changes", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedAuthority(database);
      insertCompleteUpload(database);

      expect(() => database.exec(`
        UPDATE attachments SET processing_status = 'ready', object_key = 'objectopaque1',
          ready_at = 'now' WHERE attachment_id = 'attachment-1'
      `)).toThrow(/processing|provenance|ready/i);
      expect(() => database.exec(`
        UPDATE attachments SET processing_status = 'malware-rejected',
          failure_code = 'malware_detected' WHERE attachment_id = 'attachment-1'
      `)).toThrow(/processing|attempt/i);
      expect(() => database.exec(`
        UPDATE attachments SET processing_generation = 9
        WHERE attachment_id = 'attachment-1'
      `)).toThrow(/generation|transition/i);

      moveAttachmentToReady(database);
      expect(database.prepare(`
        SELECT processing_status AS status, processing_generation AS generation,
               object_key AS objectKey, ready_at AS readyAt
        FROM attachments WHERE attachment_id = 'attachment-1'
      `).get()).toEqual({
        status: "ready", generation: 1, objectKey: "objectopaque1",
        readyAt: "2026-08-19T00:08:00.000Z",
      });
      expect(() => database.exec(
        "DELETE FROM attachment_extraction_artifacts WHERE artifact_id = 'extraction-1'",
      )).toThrow(/immutable/i);
    });

    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedAuthority(database);
      insertCompleteUpload(database);
      database.exec(`
        INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
        VALUES ('attachment-room', 1, 0)
      `);
      expect(() => database.exec(`
        UPDATE attachments SET processing_status = 'scanning'
        WHERE attachment_id = 'attachment-1'
      `)).toThrow(/processing|authority|transition/i);
    });
  });

  it("fences late worker results by generation and makes malware terminal", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedAuthority(database);
      insertCompleteUpload(database);
      database.exec(`
        INSERT INTO attachment_processing_attempts (
          attachment_id, processing_generation, attempt_number, adapter_kind,
          adapter_name, adapter_version, status, failure_code, timeout_ms,
          stdout_limit_bytes, stderr_limit_bytes, started_at, finished_at
        ) VALUES (
          'attachment-1', 1, 1, 'scanner', 'clamav', '1.0', 'queued', NULL,
          120000, 8388608, 65536, NULL, NULL
        );
        UPDATE attachments SET processing_status = 'scanning'
        WHERE attachment_id = 'attachment-1';
        UPDATE attachment_processing_attempts SET status = 'running', started_at = 'start'
        WHERE attachment_id = 'attachment-1' AND attempt_number = 1;
        UPDATE attachments SET processing_status = 'cancelled',
          processing_generation = 2, failure_code = 'cancelled'
        WHERE attachment_id = 'attachment-1';
      `);
      expect(() => database.exec(`
        UPDATE attachment_processing_attempts SET status = 'succeeded', finished_at = 'late'
        WHERE attachment_id = 'attachment-1' AND processing_generation = 1
      `)).toThrow(/attempt|authority|transition/i);
    });

    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedAuthority(database);
      insertCompleteUpload(database);
      database.exec(`
        INSERT INTO attachment_processing_attempts (
          attachment_id, processing_generation, attempt_number, adapter_kind,
          adapter_name, adapter_version, status, failure_code, timeout_ms,
          stdout_limit_bytes, stderr_limit_bytes, started_at, finished_at
        ) VALUES (
          'attachment-1', 1, 1, 'scanner', 'clamav', '1.0', 'queued', NULL,
          120000, 8388608, 65536, NULL, NULL
        );
        UPDATE attachments SET processing_status = 'scanning'
        WHERE attachment_id = 'attachment-1';
        UPDATE attachment_processing_attempts SET status = 'running', started_at = 'start'
        WHERE attachment_id = 'attachment-1' AND attempt_number = 1;
        UPDATE attachment_processing_attempts SET status = 'malware-rejected',
          failure_code = 'malware_detected', finished_at = 'finish'
        WHERE attachment_id = 'attachment-1' AND attempt_number = 1;
      `);
      expect(() => database.exec(`
        UPDATE attachments SET processing_status = 'extracting'
        WHERE attachment_id = 'attachment-1'
      `)).toThrow(/processing|transition/i);
      database.exec(`
        UPDATE attachments SET processing_status = 'malware-rejected',
          failure_code = 'malware_detected'
        WHERE attachment_id = 'attachment-1'
      `);
      expect(() => database.exec(`
        UPDATE attachments SET processing_status = 'ready', failure_code = NULL,
          object_key = 'objectopaque1', ready_at = 'late'
        WHERE attachment_id = 'attachment-1'
      `)).toThrow(/processing|transition/i);
    });
  });

  it("binds only same-room ready artifacts once and mirrors recall exclusion", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedAuthority(database);
      insertCompleteUpload(database);
      insertMessage(database, "message-before-ready");
      expect(() => database.exec(`
        INSERT INTO message_attachment_links (
          message_id, room_id, attachment_id, operational_state
        ) VALUES ('message-before-ready', 'attachment-room', 'attachment-1', 'active')
      `)).toThrow(/attachment|ready/i);

      moveAttachmentToReady(database);
      insertMessage(database, "message-winner");
      insertMessage(database, "message-loser");
      insertMessage(database, "message-other-room", "attachment-room-2");
      expect(() => database.exec(`
        INSERT INTO message_attachment_links (
          message_id, room_id, attachment_id, operational_state
        ) VALUES ('message-other-room', 'attachment-room-2', 'attachment-1', 'active')
      `)).toThrow(/binding|room|source/i);
      database.exec(`
        INSERT INTO message_attachment_links (
          message_id, room_id, attachment_id, operational_state
        ) VALUES ('message-winner', 'attachment-room', 'attachment-1', 'active')
      `);
      expect(database.prepare(`
        SELECT source_message_id AS sourceMessageId,
               source_operational_state AS sourceState
        FROM attachments WHERE attachment_id = 'attachment-1'
      `).get()).toEqual({ sourceMessageId: "message-winner", sourceState: "bound-active" });
      expect(() => database.exec(`
        INSERT INTO message_attachment_links (
          message_id, room_id, attachment_id, operational_state
        ) VALUES ('message-loser', 'attachment-room', 'attachment-1', 'active')
      `)).toThrow(/bound|unique|source/i);

      database.exec(`
        INSERT INTO message_recall_fences (
          fence_id, room_id, source_message_id, source_revision, scope_kind,
          invocation_intent_id, execution_id, reason, created_at
        ) VALUES (
          'attachment-recall-fence', 'attachment-room', 'message-winner', 1,
          'message', NULL, NULL, 'message_recalled', '2026-08-19T00:09:00.000Z'
        );
        UPDATE message_envelopes
        SET lifecycle = 'recalled', recalled_at = '2026-08-19T00:10:00.000Z',
            recalled_by_actor_id = 'attachment-human'
        WHERE message_id = 'message-winner';
        UPDATE message_attachment_links SET operational_state = 'excluded_recalled'
        WHERE message_id = 'message-winner' AND attachment_id = 'attachment-1';
      `);
      expect(database.prepare(`
        SELECT source_message_id AS sourceMessageId,
               source_operational_state AS sourceState
        FROM attachments WHERE attachment_id = 'attachment-1'
      `).get()).toEqual({
        sourceMessageId: "message-winner", sourceState: "excluded-recalled",
      });
      expect(() => database.exec(`
        UPDATE attachments SET source_message_id = 'message-loser',
          source_operational_state = 'bound-active'
        WHERE attachment_id = 'attachment-1'
      `)).toThrow(/source|transition|immutable/i);
    });
  });

  it("refuses future and physically tampered v17 schemas", () => {
    withDatabase((database) => {
      database.exec("PRAGMA user_version = 23");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/future schema/i);
      expect(readSchemaVersion(database)).toBe(23);
    });
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec("DROP TRIGGER attachments_v17_immutable_delete");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/physical contract/i);
    });
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec(`
        UPDATE schema_migrations SET checksum = '${SHA_A}' WHERE version = 17
      `);
      expect(() => migrateAuthorityDatabase(database)).toThrow(/migration|checksum/i);
    });
    withDatabase((database) => {
      migrateAuthorityDatabaseToVersion16ForTest(database);
      seedAuthority(database);
      insertMessage(database, "legacy-orphan-link");
      database.exec(`
        INSERT INTO message_attachment_links (
          message_id, room_id, attachment_id, operational_state
        ) VALUES ('legacy-orphan-link', 'attachment-room', 'legacy-orphan', 'active')
      `);
      expect(() => migrateAuthorityDatabase(database)).toThrow(/attachment links|source/i);
      expect(readSchemaVersion(database)).toBe(16);
      expect(listAuthorityTables(database)).not.toContain("attachments");
    });
  });
});
