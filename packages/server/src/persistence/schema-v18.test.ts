import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SCHEMA_VERSION,
  AUTHORITY_V18_STATEMENT_COUNT_FOR_TEST,
  listAuthorityTables,
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToHistoricalVersionForTest,
  readSchemaVersion,
} from "./schema.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = "2026-08-19T00:00:00.000Z";

const V18_TABLE_COLUMNS = {
  room_memory_attempts: [
    "attempt_id", "job_id", "room_id", "recovery_generation", "attempt_number",
    "status", "input_sha256", "output_sha256", "error_code", "started_at",
    "finished_at", "available_at",
  ],
  room_memory_disputes: [
    "dispute_id", "room_id", "memory_record_id", "expected_version_id",
    "disputed_version_id", "expected_version_number", "operator_kind",
    "operator_actor_id", "reason", "created_at",
  ],
  room_memory_idempotency: [
    "scope", "idempotency_key", "room_id", "actor_id", "request_sha256",
    "response_json", "status_code", "created_at_ms", "expires_at_ms",
  ],
  room_memory_jobs: [
    "job_id", "room_id", "recovery_generation", "lifecycle_generation",
    "from_watermark_exclusive", "to_corpus_seq_inclusive", "source_count",
    "frozen_sources_json", "status", "current_attempt", "available_at",
    "claimed_at", "completed_at", "last_error_code", "result_sha256",
    "created_at", "updated_at",
  ],
  room_memory_project_checkpoint: [
    "room_id", "mode", "participant_id", "checkpoint_id", "checkpoint_version",
    "health", "health_reason_code", "updated_at",
  ],
  room_memory_records: [
    "memory_record_id", "room_id", "kind", "dedupe_key", "current_version_id",
    "current_version_number", "created_at", "updated_at",
  ],
  room_memory_resolutions: [
    "resolution_id", "dispute_id", "room_id", "memory_record_id",
    "expected_disputed_version_id", "resolution_version_id", "replacement_version_id",
    "operator_kind", "operator_actor_id", "resolution", "reason", "created_at",
  ],
  room_memory_source_edges: [
    "edge_id", "memory_version_id", "memory_record_id", "room_id", "source_kind",
    "source_id", "source_revision", "created_at",
  ],
  room_memory_source_transitions: [
    "transition_id", "room_id", "source_kind", "source_id", "source_revision",
    "from_eligibility", "to_eligibility", "from_availability", "to_availability",
    "reason_code", "transitioned_at",
  ],
  room_memory_sources: [
    "room_id", "corpus_seq", "source_kind", "source_id", "source_revision",
    "server_stream_seq", "eligibility", "availability", "source_actor_id",
    "safe_metadata_json", "read_reference", "occurred_at", "updated_at",
  ],
  room_memory_stewards: [
    "room_id", "steward_id", "lifecycle_generation", "memory_watermark",
    "corpus_head", "health", "health_reason_code", "recovery_generation",
    "last_attempt_at", "retryable", "recovery_required", "created_at", "updated_at",
  ],
  room_memory_versions: [
    "memory_version_id", "memory_record_id", "room_id", "version_number", "kind",
    "state", "derived_text", "proposal_id", "origin_kind", "created_by_actor_id",
    "source_job_id", "replaces_version_id", "source_count", "created_at",
  ],
} as const;

function withDatabase<Result>(operation: (database: DatabaseSync) => Result): Result {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v18-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  try {
    return operation(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function withRestartedDatabase(operation: (database: DatabaseSync) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "dao-authority-v18-restart-"));
  const path = join(directory, "authority.sqlite");
  const initial = new DatabaseSync(path);
  let initialClosed = false;
  try {
    migrateAuthorityDatabase(initial);
    initial.close();
    initialClosed = true;
    const restarted = new DatabaseSync(path);
    try {
      operation(restarted);
    } finally {
      restarted.close();
    }
  } finally {
    if (!initialClosed) initial.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function tableColumns(database: DatabaseSync, table: string): readonly string[] {
  return database.prepare(`PRAGMA table_info('${table}')`).all()
    .map((row) => String(row.name));
}

function seedRoom(
  database: DatabaseSync,
  roomId = "memory-room",
  humanId = "memory-human",
): void {
  database.prepare(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json)
    VALUES (?, 'human', ?, '[]')
  `).run(humanId, humanId);
  database.prepare(`
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', ?, 0, 1), ('room', ?, 0, 1)
  `).run(humanId, roomId);
  database.prepare(`
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES (?, ?, 'active', ?, ?)
  `).run(roomId, roomId, NOW, humanId);
  database.prepare(`
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES (?, ?, 'human', 'owner', NULL, '[]', ?, NULL, 0)
  `).run(roomId, humanId, NOW);
}

function seedLegacyMessageAndAttachment(database: DatabaseSync): void {
  seedRoom(database);
  database.exec(`
    INSERT INTO session_families (
      family_id, public_id, account_id, actor_id, device_id, device_label,
      platform, created_at, refresh_expires_at, revoked_at
    ) VALUES (
      'memory-family', 'memory-public-family', 'memory-account', 'memory-human',
      'memory-device', 'Mac', 'macos', 1, 9999999999999, NULL
    );
    INSERT INTO sessions (
      family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
      access_expires_at, refresh_expires_at, revoked_at
    ) VALUES (
      'memory-family', 'memory-account', 'memory-human', 'memory-access-hash',
      'memory-refresh-hash', 9999999999998, 9999999999999, NULL
    );
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES ('legacy-memory-message', 'memory-room', 'memory-human', 'human',
      'legacy raw must stay in message authority', '${NOW}');
    INSERT INTO message_revisions (
      message_id, revision, body, revised_at, revised_by_actor_id
    ) VALUES ('legacy-memory-message', 1, 'legacy raw must stay in message authority',
      '${NOW}', 'memory-human');
    INSERT INTO message_envelopes (
      message_id, room_id, message_kind, lifecycle, current_revision,
      revision_count, created_at, recalled_at, recalled_by_actor_id
    ) VALUES ('legacy-memory-message', 'memory-room', 'human', 'active', 1, 1,
      '${NOW}', NULL, NULL);
    INSERT INTO attachment_uploads (
      upload_id, upload_key, canonical_input_sha256, room_id, uploader_actor_id,
      session_family_id, access_revision, lifecycle_generation, expected_bytes,
      received_bytes, expected_sha256, original_filename, declared_mime, format_hint,
      status, terminal_reason_code, created_at, updated_at, idle_expires_at,
      absolute_expires_at
    ) VALUES (
      'legacy-upload', 'legacy-upload-key', '${SHA_A}', 'memory-room', 'memory-human',
      'memory-family', 0, 0, 4, 0, '${SHA_B}', 'legacy.txt', 'text/plain', 'txt',
      'open', NULL, '${NOW}', '${NOW}', '2026-08-19T00:30:00.000Z',
      '2026-08-20T00:00:00.000Z'
    );
  `);
}

function insertSource(
  database: DatabaseSync,
  roomId: string,
  corpusSeq: number,
  sourceId = `message:source-${corpusSeq}`,
): void {
  database.prepare(`
    INSERT INTO room_memory_sources (
      room_id, corpus_seq, source_kind, source_id, source_revision,
      server_stream_seq, eligibility, availability, source_actor_id,
      safe_metadata_json, read_reference, occurred_at, updated_at
    ) VALUES (?, ?, 'message', ?, 1, ?, 'eligible', 'readable',
      'memory-human', '{}', ?, ?, ?)
  `).run(roomId, corpusSeq, sourceId, corpusSeq, `message-ref:${corpusSeq}`, NOW, NOW);
}

function insertJob(database: DatabaseSync, jobId = "memory-job-1", generation = 1): void {
  database.prepare(`
    INSERT INTO room_memory_jobs (
      job_id, room_id, recovery_generation, lifecycle_generation,
      from_watermark_exclusive, to_corpus_seq_inclusive, source_count,
      frozen_sources_json, status, current_attempt, available_at, claimed_at,
      completed_at, last_error_code, result_sha256, created_at, updated_at
    ) VALUES (?, 'memory-room', ?, 0, 0, 1, 1,
      '[{"sourceId":"message:source-1","sourceRevision":1}]',
      'queued', 0, ?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(jobId, generation, NOW, NOW, NOW);
}

function insertAttempt(
  database: DatabaseSync,
  attemptId = "memory-attempt-1",
  jobId = "memory-job-1",
  generation = 1,
  attemptNumber = 1,
): void {
  database.prepare(`
    INSERT INTO room_memory_attempts (
      attempt_id, job_id, room_id, recovery_generation, attempt_number,
      status, input_sha256, output_sha256, error_code, started_at,
      finished_at, available_at
    ) VALUES (?, ?, 'memory-room', ?, ?, 'running', ?, NULL, NULL, ?, NULL, ?)
  `).run(attemptId, jobId, generation, attemptNumber, SHA_A, NOW, NOW);
}

function insertRecord(
  database: DatabaseSync,
  recordId: string,
  kind: "context" | "goal" = "context",
): void {
  database.prepare(`
    INSERT INTO room_memory_records (
      memory_record_id, room_id, kind, dedupe_key, current_version_id,
      current_version_number, created_at, updated_at
    ) VALUES (?, 'memory-room', ?, ?, NULL, 0, ?, ?)
  `).run(recordId, kind, `dedupe-${recordId}`, NOW, NOW);
}

function insertVersion(
  database: DatabaseSync,
  input: {
    readonly versionId: string;
    readonly recordId: string;
    readonly versionNumber: number;
    readonly kind: "context" | "goal";
    readonly state: "active" | "proposal" | "disputed" | "resolved" | "superseded";
    readonly replacesVersionId?: string;
    readonly actorId?: string;
  },
): void {
  database.prepare(`
    INSERT INTO room_memory_versions (
      memory_version_id, memory_record_id, room_id, version_number, kind, state,
      derived_text, proposal_id, origin_kind, created_by_actor_id, source_job_id,
      replaces_version_id, source_count, created_at
    ) VALUES (?, ?, 'memory-room', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?)
  `).run(
    input.versionId,
    input.recordId,
    input.versionNumber,
    input.kind,
    input.state,
    `derived-${input.versionId}`,
    input.kind === "context" ? null : `proposal-${input.versionId}`,
    input.versionNumber === 1 ? "steward" : "human_resolution",
    input.versionNumber === 1 ? null : (input.actorId ?? "memory-human"),
    input.replacesVersionId ?? null,
    NOW,
  );
}

function insertEdge(
  database: DatabaseSync,
  versionId: string,
  recordId: string,
): void {
  database.prepare(`
    INSERT INTO room_memory_source_edges (
      edge_id, memory_version_id, memory_record_id, room_id, source_kind,
      source_id, source_revision, created_at
    ) VALUES (?, ?, ?, 'memory-room', 'message', 'message:source-1', 1, ?)
  `).run(`edge:${versionId}`, versionId, recordId, NOW);
}

describe("authority SQLite v18 Room Memory Authority & Steward", () => {
  it("upgrades fresh and every immutable v1-v17 schema to v18 and restarts idempotently", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      expect(AUTHORITY_SCHEMA_VERSION).toBe(25);
      expect(readSchemaVersion(database)).toBe(25);
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
        .toEqual({ count: 25 });
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
        .toEqual({ count: 25 });
    });

    for (let version = 1; version <= 17; version += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, version);
        expect(readSchemaVersion(database)).toBe(version);
        migrateAuthorityDatabase(database);
        expect(readSchemaVersion(database)).toBe(25);
      });
    }

    withRestartedDatabase((database) => {
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
      expect(readSchemaVersion(database)).toBe(25);
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
        .toEqual({ count: 25 });
    });
  }, 90_000);

  it("creates only the frozen metadata table family and preserves v17 data without inventing memory", () => {
    withDatabase((database) => {
      migrateAuthorityDatabaseToHistoricalVersionForTest(database, 17);
      seedLegacyMessageAndAttachment(database);
      const v17History = database.prepare(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      ).all();
      const messageBefore = database.prepare(
        "SELECT id, body FROM messages WHERE id = 'legacy-memory-message'",
      ).get();
      const uploadBefore = database.prepare(
        "SELECT upload_id, status, expected_bytes FROM attachment_uploads WHERE upload_id = 'legacy-upload'",
      ).get();

      migrateAuthorityDatabase(database);

      expect(AUTHORITY_V18_STATEMENT_COUNT_FOR_TEST).toBe(61);
      for (const [table, columns] of Object.entries(V18_TABLE_COLUMNS)) {
        expect(listAuthorityTables(database)).toContain(table);
        expect(tableColumns(database, table)).toEqual(columns);
      }
      expect(database.prepare(
        "SELECT version, name, checksum FROM schema_migrations WHERE version <= 17 ORDER BY version",
      ).all()).toEqual(v17History);
      expect(database.prepare(
        "SELECT name FROM schema_migrations WHERE version = 18",
      ).get()).toEqual({ name: "room-memory-authority-steward" });
      expect(database.prepare(
        "SELECT id, body FROM messages WHERE id = 'legacy-memory-message'",
      ).get()).toEqual(messageBefore);
      expect(database.prepare(
        "SELECT upload_id, status, expected_bytes FROM attachment_uploads WHERE upload_id = 'legacy-upload'",
      ).get()).toEqual(uploadBefore);
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_memory_records").get())
        .toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_memory_sources").get())
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT steward_id AS stewardId, memory_watermark AS watermark,
               corpus_head AS corpusHead, health, recovery_generation AS generation
        FROM room_memory_stewards WHERE room_id = 'memory-room'
      `).get()).toEqual({
        stewardId: "room-memory-steward:memory-room", watermark: 0,
        corpusHead: 0, health: "healthy", generation: 1,
      });
      expect(database.prepare(`
        SELECT mode, participant_id AS participantId, checkpoint_id AS checkpointId,
               checkpoint_version AS checkpointVersion, health
        FROM room_memory_project_checkpoint WHERE room_id = 'memory-room'
      `).get()).toEqual({
        mode: "disabled", participantId: null, checkpointId: null,
        checkpointVersion: 0, health: "disabled",
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM actors WHERE id LIKE 'room-memory-steward:%'",
      ).get()).toEqual({ count: 0 });
    });
  });

  it("enforces one non-actor steward, contiguous source identity, and committed watermarks", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedRoom(database);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM room_memory_stewards WHERE room_id = 'memory-room'",
      ).get()).toEqual({ count: 1 });
      expect(() => database.exec(`
        INSERT INTO room_memory_stewards (
          room_id, steward_id, lifecycle_generation, memory_watermark, corpus_head,
          health, health_reason_code, recovery_generation, last_attempt_at,
          retryable, recovery_required, created_at, updated_at
        ) VALUES (
          'memory-room', 'duplicate', 0, 0, 0, 'healthy', NULL, 1, NULL,
          0, 0, '${NOW}', '${NOW}'
        )
      `)).toThrow();
      expect(() => database.prepare(`
        INSERT INTO actors (id, kind, display_name, tool_permissions_json)
        VALUES ('room-memory-steward:memory-room', 'agent', 'fake', '[]')
      `).run()).toThrow(/steward|actor|identity/i);

      insertSource(database, "memory-room", 1);
      expect(database.prepare(`
        SELECT memory_watermark AS watermark, corpus_head AS corpusHead, health
        FROM room_memory_stewards WHERE room_id = 'memory-room'
      `).get()).toEqual({ watermark: 0, corpusHead: 1, health: "catching_up" });
      expect(() => insertSource(database, "memory-room", 3)).toThrow(/corpus|sequence|contiguous/i);
      expect(() => insertSource(database, "memory-room", 2, "message:source-1"))
        .toThrow(/UNIQUE|source|identity/i);
      expect(() => database.exec(`
        UPDATE room_memory_stewards SET memory_watermark = 1, health = 'healthy'
        WHERE room_id = 'memory-room'
      `)).toThrow(/watermark|job|checkpoint/i);

      insertJob(database);
      insertAttempt(database);
      database.exec(`
        UPDATE room_memory_attempts
        SET status = 'succeeded', output_sha256 = '${SHA_B}', finished_at = '${NOW}'
        WHERE attempt_id = 'memory-attempt-1';
        UPDATE room_memory_jobs
        SET status = 'completed', completed_at = '${NOW}', result_sha256 = '${SHA_B}',
            updated_at = '${NOW}'
        WHERE job_id = 'memory-job-1';
        UPDATE room_memory_stewards
        SET memory_watermark = 1, health = 'healthy', health_reason_code = NULL,
            retryable = 0, recovery_required = 0, updated_at = '${NOW}'
        WHERE room_id = 'memory-room';
      `);
      expect(database.prepare(`
        SELECT memory_watermark AS watermark, corpus_head AS corpusHead, health
        FROM room_memory_stewards WHERE room_id = 'memory-room'
      `).get()).toEqual({ watermark: 1, corpusHead: 1, health: "healthy" });
      expect(() => database.exec(`
        UPDATE room_memory_stewards SET memory_watermark = 0
        WHERE room_id = 'memory-room'
      `)).toThrow(/watermark|regress|checkpoint/i);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM room_memory_source_transitions",
      ).get()).toEqual({ count: 1 });
      database.exec(`
        UPDATE rooms
        SET status = 'archived', archived_at = '${NOW}', archive_generation = 1
        WHERE id = 'memory-room'
      `);
      expect(database.prepare(`
        SELECT lifecycle_generation AS lifecycleGeneration
        FROM room_memory_stewards WHERE room_id = 'memory-room'
      `).get()).toEqual({ lifecycleGeneration: 1 });
      database.exec(`
        UPDATE rooms
        SET status = 'active', archived_at = NULL, archive_generation = 3
        WHERE id = 'memory-room'
      `);
      expect(database.prepare(`
        SELECT lifecycle_generation AS lifecycleGeneration
        FROM room_memory_stewards WHERE room_id = 'memory-room'
      `).get()).toEqual({ lifecycleGeneration: 3 });
      expect(() => database.exec(`
        UPDATE room_memory_stewards SET lifecycle_generation = 4
        WHERE room_id = 'memory-room'
      `)).toThrow(/generation|checkpoint/i);
    });
  });

  it("fences job attempts by room generation and rejects late results or status regression", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedRoom(database);
      insertSource(database, "memory-room", 1);
      expect(() => insertJob(database, "wrong-generation", 2))
        .toThrow(/generation|job|steward/i);
      insertJob(database);
      expect(() => database.exec(`
        UPDATE room_memory_jobs
        SET status = 'running', current_attempt = 1, claimed_at = '${NOW}', updated_at = '${NOW}'
        WHERE job_id = 'memory-job-1'
      `)).toThrow(/attempt|job|transition/i);
      expect(() => insertAttempt(database, "attempt-two", "memory-job-1", 1, 2))
        .toThrow(/attempt|sequence/i);
      insertAttempt(database);
      database.exec(`
        UPDATE room_memory_stewards
        SET recovery_generation = 2, health = 'degraded',
            health_reason_code = 'manual_recovery', retryable = 1,
            recovery_required = 1, updated_at = '${NOW}'
        WHERE room_id = 'memory-room'
      `);
      expect(() => database.exec(`
        UPDATE room_memory_attempts
        SET status = 'succeeded', output_sha256 = '${SHA_B}', finished_at = '${NOW}'
        WHERE attempt_id = 'memory-attempt-1'
      `)).toThrow(/generation|late|attempt/i);
      expect(() => database.exec(`
        UPDATE room_memory_jobs SET status = 'completed', completed_at = '${NOW}',
          result_sha256 = '${SHA_B}' WHERE job_id = 'memory-job-1'
      `)).toThrow(/generation|late|job/i);
      expect(() => database.exec(
        "DELETE FROM room_memory_attempts WHERE attempt_id = 'memory-attempt-1'",
      )).toThrow(/immutable/i);
      expect(() => database.exec(
        "DELETE FROM room_memory_jobs WHERE job_id = 'memory-job-1'",
      )).toThrow(/immutable/i);
    });
  });

  it("keeps versions, source edges, disputes, and resolutions append-only with the Context boundary", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedRoom(database);
      database.exec(`
        INSERT INTO actors (id, kind, display_name, tool_permissions_json)
        VALUES ('memory-agent', 'human', 'Agent', '[]'),
               ('memory-outsider', 'human', 'Outsider', '[]'),
               ('memory-reviewer', 'human', 'Reviewer', '[]');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'memory-agent', 0, 1),
               ('identity', 'memory-outsider', 0, 1),
               ('identity', 'memory-reviewer', 0, 1);
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES (
          'memory-room', 'memory-reviewer', 'human', 'member', NULL, '[]',
          '${NOW}', NULL, 0
        )
      `);
      insertSource(database, "memory-room", 1);

      insertRecord(database, "context-record", "context");
      insertVersion(database, {
        versionId: "context-v1", recordId: "context-record", versionNumber: 1,
        kind: "context", state: "active",
      });
      insertEdge(database, "context-v1", "context-record");
      insertRecord(database, "goal-record", "goal");
      expect(() => insertVersion(database, {
        versionId: "goal-active", recordId: "goal-record", versionNumber: 1,
        kind: "goal", state: "active",
      })).toThrow(/context|active|proposal|version transition/i);
      insertVersion(database, {
        versionId: "goal-v1", recordId: "goal-record", versionNumber: 1,
        kind: "goal", state: "proposal",
      });
      insertEdge(database, "goal-v1", "goal-record");

      insertVersion(database, {
        versionId: "context-v2", recordId: "context-record", versionNumber: 2,
        kind: "context", state: "disputed", replacesVersionId: "context-v1",
        actorId: "memory-reviewer",
      });
      insertEdge(database, "context-v2", "context-record");
      expect(() => database.exec(`
        INSERT INTO room_memory_disputes (
          dispute_id, room_id, memory_record_id, expected_version_id,
          disputed_version_id, expected_version_number, operator_kind,
          operator_actor_id, reason, created_at
        ) VALUES (
          'bad-agent-dispute', 'memory-room', 'context-record', 'context-v1',
          'context-v2', 1, 'human', 'memory-agent', 'bad', '${NOW}'
        )
      `)).toThrow(/human|operator|member/i);
      database.exec(`
        INSERT INTO room_memory_disputes (
          dispute_id, room_id, memory_record_id, expected_version_id,
          disputed_version_id, expected_version_number, operator_kind,
          operator_actor_id, reason, created_at
        ) VALUES (
          'context-dispute', 'memory-room', 'context-record', 'context-v1',
          'context-v2', 1, 'human', 'memory-reviewer', 'source is disputed', '${NOW}'
        )
      `);
      expect(() => database.exec(
        "UPDATE room_memory_disputes SET reason = 'changed' WHERE dispute_id = 'context-dispute'",
      )).toThrow(/immutable/i);

      insertVersion(database, {
        versionId: "context-v3", recordId: "context-record", versionNumber: 3,
        kind: "context", state: "resolved", replacesVersionId: "context-v2",
        actorId: "memory-reviewer",
      });
      insertEdge(database, "context-v3", "context-record");
      insertVersion(database, {
        versionId: "context-v4", recordId: "context-record", versionNumber: 4,
        kind: "context", state: "active", replacesVersionId: "context-v3",
        actorId: "memory-reviewer",
      });
      insertEdge(database, "context-v4", "context-record");
      database.exec(`
        INSERT INTO room_memory_resolutions (
          resolution_id, dispute_id, room_id, memory_record_id,
          expected_disputed_version_id, resolution_version_id, replacement_version_id,
          operator_kind, operator_actor_id, resolution, reason, created_at
        ) VALUES (
          'context-resolution', 'context-dispute', 'memory-room', 'context-record',
          'context-v2', 'context-v3', 'context-v4', 'human', 'memory-reviewer',
          'replace', 're-evaluated with current source', '${NOW}'
        )
      `);

      for (const sql of [
        "UPDATE room_memory_versions SET derived_text = 'changed' WHERE memory_version_id = 'context-v1'",
        "DELETE FROM room_memory_versions WHERE memory_version_id = 'context-v1'",
        "UPDATE room_memory_source_edges SET source_revision = 2 WHERE edge_id = 'edge:context-v1'",
        "DELETE FROM room_memory_source_edges WHERE edge_id = 'edge:context-v1'",
        "DELETE FROM room_memory_disputes WHERE dispute_id = 'context-dispute'",
        "UPDATE room_memory_resolutions SET reason = 'changed' WHERE resolution_id = 'context-resolution'",
        "DELETE FROM room_memory_resolutions WHERE resolution_id = 'context-resolution'",
      ]) {
        expect(() => database.exec(sql)).toThrow(/immutable/i);
      }
      expect(database.prepare(`
        SELECT current_version_id AS versionId, current_version_number AS versionNumber
        FROM room_memory_records WHERE memory_record_id = 'context-record'
      `).get()).toEqual({ versionId: "context-v4", versionNumber: 4 });
      database.exec(`
        DELETE FROM room_memberships
        WHERE room_id = 'memory-room' AND actor_id = 'memory-reviewer'
      `);
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
    });
  });

  it("starts the future project checkpoint disabled and refuses enabled-without-checkpoint", () => {
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      seedRoom(database);
      expect(() => database.exec(`
        UPDATE room_memory_project_checkpoint
        SET mode = 'enabled', health = 'ready', updated_at = '${NOW}'
        WHERE room_id = 'memory-room'
      `)).toThrow(/checkpoint|enabled|constraint/i);
      database.exec(`
        UPDATE room_memory_project_checkpoint
        SET mode = 'enabled', participant_id = 'ft09-confirmed-fact-port',
            checkpoint_id = 'checkpoint-1', checkpoint_version = 1,
            health = 'ready', health_reason_code = NULL, updated_at = '${NOW}'
        WHERE room_id = 'memory-room'
      `);
      expect(() => database.exec(`
        UPDATE room_memory_project_checkpoint SET checkpoint_version = 0
        WHERE room_id = 'memory-room'
      `)).toThrow(/checkpoint|version|constraint/i);
      expect(() => database.exec(
        "DELETE FROM room_memory_project_checkpoint WHERE room_id = 'memory-room'",
      )).toThrow(/immutable/i);
    });
  });

  it("rolls every meaningful v18 statement back to an identical populated v17 database", () => {
    expect(AUTHORITY_V18_STATEMENT_COUNT_FOR_TEST).toBe(61);
    for (let statement = 1; statement <= AUTHORITY_V18_STATEMENT_COUNT_FOR_TEST; statement += 1) {
      withDatabase((database) => {
        migrateAuthorityDatabaseToHistoricalVersionForTest(database, 17);
        seedLegacyMessageAndAttachment(database);
        const beforeTables = listAuthorityTables(database);
        const beforeHistory = database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all();
        const beforeMessage = database.prepare(
          "SELECT id, body FROM messages WHERE id = 'legacy-memory-message'",
        ).get();
        const beforeUpload = database.prepare(
          "SELECT upload_id, status FROM attachment_uploads WHERE upload_id = 'legacy-upload'",
        ).get();

        expect(() => migrateAuthorityDatabase(database, { failAfterStatement: statement }))
          .toThrow(/injected migration failure/i);
        expect(readSchemaVersion(database)).toBe(17);
        expect(listAuthorityTables(database)).toEqual(beforeTables);
        expect(database.prepare(
          "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
        ).all()).toEqual(beforeHistory);
        expect(database.prepare(
          "SELECT id, body FROM messages WHERE id = 'legacy-memory-message'",
        ).get()).toEqual(beforeMessage);
        expect(database.prepare(
          "SELECT upload_id, status FROM attachment_uploads WHERE upload_id = 'legacy-upload'",
        ).get()).toEqual(beforeUpload);
      });
    }
  }, 120_000);

  it("refuses future, migration-history tamper, and physical v18 schema tamper", () => {
    withDatabase((database) => {
      database.exec("PRAGMA user_version = 26");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/future schema/i);
      expect(readSchemaVersion(database)).toBe(26);
    });
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.exec("DROP TRIGGER room_memory_versions_v18_immutable_update");
      expect(() => migrateAuthorityDatabase(database)).toThrow(/physical contract/i);
    });
    withDatabase((database) => {
      migrateAuthorityDatabase(database);
      database.prepare(
        "UPDATE schema_migrations SET checksum = ? WHERE version = 18",
      ).run(SHA_A);
      expect(() => migrateAuthorityDatabase(database)).toThrow(/migration|checksum/i);
    });
  });
});
