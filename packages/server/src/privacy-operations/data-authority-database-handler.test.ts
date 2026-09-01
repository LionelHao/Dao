import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  executePrivacyDataAuthorityOperation,
  PrivacyDataAuthorityError,
} from "./data-authority-database-handler.js";
import type { RoomExportRecord } from "./room-export.js";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const STARTED_AT = new Date(NOW).toISOString();
const databases = new Set<DatabaseSync>();

function projectionDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.add(database);
  database.exec(`
    CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT);
    CREATE TABLE session_families (
      family_id TEXT PRIMARY KEY, actor_id TEXT, revoked_at INTEGER, refresh_expires_at INTEGER
    );
    CREATE TABLE tenant_administrators (human_actor_id TEXT, status TEXT);
    CREATE TABLE sessions (
      family_id TEXT, actor_id TEXT, access_token_hash TEXT,
      revoked_at INTEGER, access_expires_at INTEGER
    );
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, owner_actor_id TEXT,
      governance_revision INTEGER, created_at TEXT, archived_at TEXT
    );
    CREATE TABLE room_memberships (
      room_id TEXT, actor_id TEXT, kind TEXT, role TEXT, participation TEXT,
      joined_at TEXT, configured_at TEXT, access_revision INTEGER
    );
    CREATE TABLE streams (
      stream_kind TEXT, stream_id TEXT, head_seq INTEGER, retained_from_seq INTEGER
    );
    CREATE TABLE room_access_authority (room_id TEXT, access_revision INTEGER);
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, stream_kind TEXT, stream_id TEXT, stream_seq INTEGER,
      room_id TEXT, actor_id TEXT, event_type TEXT, occurred_at TEXT, payload_json TEXT
    );
    CREATE TABLE attachments (
      attachment_id TEXT, processing_generation INTEGER, original_filename TEXT,
      declared_mime TEXT, detected_mime TEXT, format TEXT, byte_size INTEGER, sha256 TEXT,
      processing_status TEXT, source_message_id TEXT, room_id TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE agent_executions (
      id TEXT, room_id TEXT, agent_id TEXT, trigger_message_id TEXT, status TEXT,
      started_at TEXT, completed_at TEXT, updated_at TEXT, result_message_id TEXT,
      execution_generation INTEGER
    );
    CREATE TABLE agent_execution_attempts (
      execution_id TEXT, attempt_seq INTEGER, retry_cycle INTEGER, retry_ordinal INTEGER,
      status TEXT, action_category TEXT, started_at TEXT, finished_at TEXT,
      error_code TEXT, next_retry_at TEXT, recovery_cursor INTEGER
    );
    CREATE TABLE tool_calls_v2 (
      tool_call_id TEXT, execution_id TEXT, room_id TEXT, tool_id TEXT, safe_preview_json TEXT
    );
    CREATE TABLE tool_dispatches_v2 (dispatch_id TEXT, tool_call_id TEXT);
    CREATE TABLE tool_reviews_v2 (
      review_id TEXT, dispatch_id TEXT, resolution TEXT, evidence_summary TEXT,
      evidence_sha256 TEXT, version INTEGER, reviewed_at TEXT
    );
    CREATE TABLE project_boundary_agent_executions (
      execution_id TEXT, intent_id TEXT, lineage_id TEXT, execution_ordinal INTEGER,
      retry_of_execution_id TEXT, room_id TEXT, agent_actor_id TEXT, source_revision INTEGER,
      lifecycle_generation INTEGER, provider_id TEXT, model_id TEXT, public_status TEXT,
      phase TEXT, authority_version INTEGER, queued_at TEXT, started_at TEXT,
      updated_at TEXT, completed_at TEXT, result_message_id TEXT
    );
    CREATE TABLE room_audit (
      id TEXT, type TEXT, room_id TEXT, actor_id TEXT, result TEXT,
      timestamp TEXT, details_json TEXT
    );
    CREATE TABLE room_memory_versions (
      memory_version_id TEXT, memory_record_id TEXT, room_id TEXT, version_number INTEGER,
      kind TEXT, state TEXT, derived_text TEXT, origin_kind TEXT, source_count INTEGER, created_at TEXT
      , created_by_actor_id TEXT, source_job_id TEXT, replaces_version_id TEXT
    );
    CREATE TABLE room_memory_source_edges (
      memory_version_id TEXT, room_id TEXT, source_kind TEXT, source_id TEXT, source_revision INTEGER
    );
    CREATE TABLE room_memory_sources (
      room_id TEXT, corpus_seq INTEGER, source_kind TEXT, source_id TEXT, source_revision INTEGER,
      server_stream_seq INTEGER, source_actor_id TEXT, read_reference TEXT,
      occurred_at TEXT, safe_metadata_json TEXT
    );
    CREATE TABLE messages (
      id TEXT, room_id TEXT, author_id TEXT, author_kind TEXT, body TEXT, sent_at TEXT
    );
    CREATE TABLE message_revisions (
      message_id TEXT, revision INTEGER, body TEXT, revised_at TEXT, revised_by_actor_id TEXT
    );
    CREATE TABLE message_envelopes (
      message_id TEXT, room_id TEXT, message_kind TEXT, lifecycle TEXT,
      current_revision INTEGER, revision_count INTEGER, created_at TEXT,
      recalled_at TEXT, recalled_by_actor_id TEXT
    );
    CREATE TABLE project_events (
      event_id TEXT, room_id TEXT, project_id TEXT, event_type TEXT, fact_kind TEXT,
      fact_id TEXT, fact_revision INTEGER, authority_kind TEXT, source_kind TEXT,
      source_id TEXT, source_revision INTEGER, occurred_at TEXT, payload_json TEXT
    );

    INSERT INTO actors VALUES ('owner', 'human');
    INSERT INTO session_families VALUES ('family-owner', 'owner', NULL, ${NOW + 60000});
    INSERT INTO sessions VALUES ('family-owner', 'owner', 'session-owner', NULL, ${NOW + 30000});
    INSERT INTO rooms VALUES (
      'room-1', 'Room one', 'active', 'owner', 3, '${STARTED_AT}', NULL
    );
    INSERT INTO rooms VALUES (
      'room-other', 'Other room', 'active', 'owner', 1, '${STARTED_AT}', NULL
    );
    INSERT INTO room_memberships VALUES (
      'room-1', 'owner', 'human', 'owner', 'active', '${STARTED_AT}', NULL, 7
    );
    INSERT INTO room_memberships VALUES (
      'room-1', 'agent-1', 'agent', NULL, 'active', NULL, '${STARTED_AT}', 0
    );
    INSERT INTO streams VALUES ('room', 'room-1', 12, 1);
    INSERT INTO room_access_authority VALUES ('room-1', 7);

    INSERT INTO events VALUES (
      'message-event', 'room', 'room-1', 1, 'room-1', 'owner',
      'room.message.accepted', '2026-08-31T23:00:00.000Z', '{"id":"message-1"}'
    );
    INSERT INTO events VALUES (
      'recall-event', 'room', 'room-1', 2, 'room-1', 'owner',
      'room.message.recalled', '2026-08-31T23:10:00.000Z', '{"id":"message-1"}'
    );
    INSERT INTO events VALUES (
      'governance-event', 'room', 'room-1', 3, 'room-1', 'owner',
      'room.governance.changed', '2026-08-31T23:20:00.000Z', '{}'
    );
    INSERT INTO events VALUES (
      'project-event', 'room', 'room-1', 4, 'room-1', 'owner',
      'project.fact.created', '2026-08-31T23:30:00.000Z', '{}'
    );
    INSERT INTO events VALUES (
      'trigger-event', 'room', 'room-1', 5, 'room-1', 'owner',
      'room.message.accepted', '2026-08-31T23:40:00.000Z', '{"id":"trigger-message"}'
    );
    INSERT INTO events VALUES (
      'attachment-bound-event', 'room', 'room-1', 6, 'room-1', 'owner',
      'room.attachment.bound', '2026-08-31T23:40:10.000Z',
      '{"attachment":{"attachmentId":"attachment-1","roomId":"room-1","originalFilename":"notes.txt","format":"txt","declaredMime":"text/plain","detectedMime":"text/plain","byteSize":12,"sha256":"${"a".repeat(64)}","uploaderActorId":"owner","createdAt":"2026-08-31T23:05:00.000Z","readyAt":"2026-08-31T23:06:00.000Z","processingStatus":"ready","generation":1,"sourceMessageId":"message-1"},"sourceEligibility":"bound-active"}'
    );
    INSERT INTO events VALUES (
      'execution-state-event', 'room', 'room-1', 7, 'room-1', 'agent-1',
      'agent.execution.changed', '2026-08-31T23:42:00.000Z',
      '{"executionId":"execution-1","intentId":"invocation-1","lineageId":"lineage-1","executionOrdinal":1,"roomId":"room-1","agentId":"agent-1","snapshotId":"snapshot-1","providerId":"provider-safe","modelId":"model-safe","status":"completed","phase":"completed","currentAttemptSeq":1,"version":4,"queuedAt":"2026-08-31T23:40:30.000Z","startedAt":"2026-08-31T23:41:00.000Z","updatedAt":"2026-08-31T23:42:00.000Z","completedAt":"2026-08-31T23:42:00.000Z","resultMessageId":"result-message"}'
    );
    INSERT INTO events VALUES (
      'execution-attempt-event', 'room', 'room-1', 8, 'room-1', 'agent-1',
      'agent.execution.attempt.changed', '2026-08-31T23:42:00.000Z',
      '{"executionId":"execution-1","intentId":"invocation-1","lineageId":"lineage-1","roomId":"room-1","agentId":"agent-1","attemptSeq":1,"snapshotId":"snapshot-1","providerId":"provider-safe","modelId":"model-safe","status":"completed","phase":"completed","executionVersion":4,"startedAt":"2026-08-31T23:41:00.000Z","updatedAt":"2026-08-31T23:42:00.000Z","finishedAt":"2026-08-31T23:42:00.000Z"}'
    );
    INSERT INTO events VALUES (
      'tool-call-event', 'room', 'room-1', 9, 'room-1', 'agent-1',
      'tool.safety.changed', '2026-08-31T23:42:10.000Z',
      '{"kind":"tool-call","value":{"toolCallId":"tool-call-1","executionId":"execution-1","attemptSeq":1,"toolId":"http-json.read","state":"created","version":1,"safePreview":{"topicKey":"safe-topic"}}}'
    );
    INSERT INTO events VALUES (
      'tool-dispatch-event', 'room', 'room-1', 10, 'room-1', 'agent-1',
      'tool.safety.changed', '2026-08-31T23:42:20.000Z',
      '{"kind":"tool-dispatch","value":{"dispatchId":"dispatch-1","toolCallId":"tool-call-1","state":"known_succeeded","version":4,"dispatchedAt":"2026-08-31T23:42:15.000Z","settledAt":"2026-08-31T23:42:20.000Z","safeSummary":{"result":"ok"}}}'
    );
    INSERT INTO events VALUES (
      'tool-review-event', 'room', 'room-1', 11, 'room-1', 'owner',
      'tool.safety.changed', '2026-08-31T23:43:00.000Z',
      '{"kind":"tool-review","value":{"reviewId":"review-1","dispatchId":"dispatch-1","principalHumanActorId":"owner","resolution":"known_succeeded","evidenceSummary":"reviewed safely","evidenceSha256":"${"c".repeat(64)}","version":1,"reviewedAt":"2026-08-31T23:43:00.000Z"}}'
    );
    INSERT INTO events VALUES (
      'boundary-execution-event', 'room', 'room-1', 12, 'room-1', 'agent-1',
      'project.boundary.invocation.decided', '2026-08-31T23:46:00.000Z',
      '{"boundaryId":"boundary-1","roomId":"room-1","status":"execution-state","intentId":"intent-1","executionId":"boundary-execution-1","agentId":"agent-1","executionStatus":"completed","occurredAt":"2026-08-31T23:46:00.000Z"}'
    );

    INSERT INTO messages VALUES (
      'message-1', 'room-1', 'owner', 'human', 'recalled-source-body',
      '2026-08-31T23:00:00.000Z'
    );
    INSERT INTO message_revisions VALUES (
      'message-1', 1, 'recalled-source-body', '2026-08-31T23:00:00.000Z', 'owner'
    );
    INSERT INTO message_envelopes VALUES (
      'message-1', 'room-1', 'human', 'recalled', 1, 1,
      '2026-08-31T23:00:00.000Z', '2026-08-31T23:10:00.000Z', 'owner'
    );
    INSERT INTO attachments VALUES (
      'attachment-1', 1, 'notes.txt', 'text/plain', 'text/plain', 'txt', 12,
      '${"a".repeat(64)}', 'ready', 'message-1', 'room-1',
      '2026-08-31T23:05:00.000Z', '2026-08-31T23:05:00.000Z'
    );
    INSERT INTO attachments VALUES (
      'cross-room-attachment', 1, 'other.txt', NULL, 'text/plain', 'txt', 5,
      '${"b".repeat(64)}', 'ready', NULL, 'room-other',
      '2026-08-31T23:05:00.000Z', '2026-08-31T23:05:00.000Z'
    );

    INSERT INTO agent_executions VALUES (
      'execution-1', 'room-1', 'agent-1', 'trigger-message', 'completed',
      '2026-08-31T23:41:00.000Z', '2026-08-31T23:42:00.000Z',
      '2026-08-31T23:42:00.000Z', 'result-message', 1
    );
    INSERT INTO agent_execution_attempts VALUES (
      'execution-1', 1, 1, 1, 'completed', 'tool_call',
      '2026-08-31T23:41:00.000Z', '2026-08-31T23:42:00.000Z', NULL, NULL, 0
    );
    INSERT INTO tool_calls_v2 VALUES (
      'tool-call-1', 'execution-1', 'room-1', 'http-json.read', '{"topicKey":"safe-topic"}'
    );
    INSERT INTO tool_dispatches_v2 VALUES ('dispatch-1', 'tool-call-1');
    INSERT INTO tool_reviews_v2 VALUES (
      'review-1', 'dispatch-1', 'known_succeeded', 'reviewed safely',
      '${"c".repeat(64)}', 1, '2026-08-31T23:43:00.000Z'
    );
    INSERT INTO project_boundary_agent_executions VALUES (
      'boundary-execution-1', 'intent-1', 'lineage-1', 1, NULL, 'room-1', 'agent-1',
      1, 0, 'provider-safe', 'model-safe', 'completed', 'completed', 2,
      '2026-08-31T23:44:00.000Z', '2026-08-31T23:45:00.000Z',
      '2026-08-31T23:46:00.000Z', '2026-08-31T23:46:00.000Z', 'result-message'
    );

    INSERT INTO room_audit VALUES (
      'governance-audit-1', 'room.ownership.transferred', 'room-1', 'owner',
      'ownership-transferred', '2026-08-31T23:20:00.000Z', '{"topicKey":"governance"}'
    );
    INSERT INTO room_memory_versions VALUES (
      'memory-version-1', 'memory-1', 'room-1', 1, 'context', 'active',
      'durable memory text', 'steward', 1, '2026-08-31T23:50:00.000Z', NULL, NULL, NULL
    );
    INSERT INTO room_memory_versions VALUES (
      'memory-version-2', 'memory-1', 'room-1', 2, 'context', 'resolved',
      'human resolved memory', 'human_resolution', 3, '2026-08-31T23:51:00.000Z',
      'owner', NULL, 'memory-version-1'
    );
    INSERT INTO room_memory_sources VALUES (
      'room-1', 1, 'message', 'message-1', 1, 1, 'owner', 'safe-ref',
      '2026-08-31T23:00:00.000Z', '{"topicKey":"legal","providerId":"provider-safe"}'
    );
    INSERT INTO room_memory_sources VALUES (
      'room-1', 2, 'message', 'Z-source', 1, 2, 'owner', 'safe-ref-Z',
      '2026-08-31T23:01:00.000Z', '{}'
    );
    INSERT INTO room_memory_sources VALUES (
      'room-1', 3, 'message', 'a-source', 1, 3, 'owner', 'safe-ref-a',
      '2026-08-31T23:02:00.000Z', '{}'
    );
    INSERT INTO room_memory_source_edges VALUES (
      'memory-version-1', 'room-1', 'message', 'message-1', 1
    );
    INSERT INTO room_memory_source_edges VALUES (
      'memory-version-2', 'room-1', 'message', 'message-1', 1
    );
    INSERT INTO room_memory_source_edges VALUES (
      'memory-version-2', 'room-1', 'message', 'Z-source', 1
    );
    INSERT INTO room_memory_source_edges VALUES (
      'memory-version-2', 'room-1', 'message', 'a-source', 1
    );
    INSERT INTO events VALUES (
      'memory-version-event-1', 'room', 'room-1', 10, 'room-1', 'owner',
      'room.memory.version.changed', '2026-08-31T23:50:00.000Z',
      '{"memoryVersionId":"memory-version-1"}'
    );
    INSERT INTO events VALUES (
      'memory-version-event-2', 'room', 'room-1', 11, 'room-1', 'owner',
      'room.memory.version.changed', '2026-08-31T23:51:00.000Z',
      '{"memoryVersionId":"memory-version-2"}'
    );
    INSERT INTO project_events VALUES (
      'project-event', 'room-1', 'room-1', 'fact.created', 'goal', 'goal-1', 1,
      'human', 'message', 'message-1', 1, '2026-08-31T23:30:00.000Z',
      '{"topicKey":"project","providerId":"provider-safe"}'
    );
  `);
  return database;
}

function readOperation(after?: string) {
  return {
    version: 1 as const,
    type: "privacy.room-export.read-page" as const,
    actorId: "owner",
    sessionFamilyId: "family-owner",
    sessionId: "session-owner",
    tenantId: "deployment-singleton" as const,
    roomId: "room-1",
    accessRevision: 7,
    lifecycle: "active" as const,
    exportId: "export-1",
    watermark: 12,
    startedAt: STARTED_AT,
    ...(after === undefined ? {} : { after }),
    limit: 2,
    now: NOW,
  };
}

function readAll(database: DatabaseSync): RoomExportRecord[] {
  const records: RoomExportRecord[] = [];
  let after: string | undefined;
  do {
    const page = executePrivacyDataAuthorityOperation(database, readOperation(after));
    if (page.kind !== "room-export-page") throw new Error("unexpected page");
    records.push(...page.records);
    after = page.next;
  } while (after !== undefined);
  return records;
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("FT-14 closed multi-category SQLite Room export", () => {
  it("binds Room export to the exact session while allowing a dual-role administrator owner", () => {
    const database = projectionDatabase();
    database.prepare(
      "INSERT INTO tenant_administrators VALUES ('owner', 'active')",
    ).run();
    database.prepare(
      `INSERT INTO sessions VALUES (
         'family-owner', 'owner', 'session-owner-peer', NULL, ?
       )`,
    ).run(NOW + 30_000);

    expect(executePrivacyDataAuthorityOperation(database, {
      version: 1,
      type: "privacy.room-export.inspect-session",
      actorId: "owner",
      sessionFamilyId: "family-owner",
      sessionId: "session-owner",
      now: NOW,
    })).toMatchObject({
      kind: "room-export-session",
      session: { principalKind: "human", active: true },
    });

    database.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE access_token_hash = 'session-owner'",
    ).run(NOW);
    expect(() => executePrivacyDataAuthorityOperation(database, readOperation()))
      .toThrowError(PrivacyDataAuthorityError);
    expect(database.prepare(
      "SELECT revoked_at AS revokedAt FROM sessions WHERE access_token_hash = 'session-owner-peer'",
    ).get()).toEqual({ revokedAt: null });
  });

  it("pages every approved category with fixed authority and no cross-room rows", () => {
    const database = projectionDatabase();
    const records: RoomExportRecord[] = [];
    let after: string | undefined;
    do {
      const page = executePrivacyDataAuthorityOperation(database, readOperation(after));
      expect(page.kind).toBe("room-export-page");
      if (page.kind !== "room-export-page") throw new Error("unexpected page");
      expect(page.records.length).toBeLessThanOrEqual(2);
      records.push(...page.records);
      after = page.next;
    } while (after !== undefined);

    expect(new Set(records.map((record) => record.category))).toEqual(new Set([
      "attachment_inventory", "execution_tool_review", "membership_governance_audit",
      "memory", "message", "message_revision", "project_fact", "recall_audit", "source_link",
    ]));
    expect(records.filter((record) => record.category === "execution_tool_review")).toHaveLength(6);
    expect(records.filter((record) => record.category === "membership_governance_audit")).toHaveLength(2);
    expect(records.some((record) => record.category === "message_revision" &&
      JSON.stringify(record.payload).includes("recalled-source-body"))).toBe(true);
    expect(records.some((record) => record.entityId.includes("cross-room"))).toBe(false);
    expect(JSON.stringify(records)).toContain("topicKey");
    expect(JSON.stringify(records)).toContain("providerId");
    expect(records.find((record) => record.category === "attachment_inventory")?.payload)
      .toMatchObject({
        recordKind: "attachment_inventory", sourceEligibility: "bound-active",
        attachment: {
          attachmentId: "attachment-1", sourceMessageId: "message-1",
          declaredMime: "text/plain", byteSize: 12,
        },
      });
    expect(records.find((record) => record.entityId ===
      "execution-tool-event:execution-state-event")?.payload).toMatchObject({
        recordKind: "agent_execution",
        data: { status: "completed", phase: "completed", completedAt: "2026-08-31T23:42:00.000Z" },
      });
    expect(records.find((record) => record.entityId ===
      "execution-tool-event:tool-review-event")?.payload).toMatchObject({
        recordKind: "tool_safety_transition",
        data: { kind: "tool-review", value: { resolution: "known_succeeded" } },
      });
    expect(records.find((record) => record.entityId ===
      "boundary-event:boundary-execution-event")?.payload).toMatchObject({
        recordKind: "project_boundary_agent_execution", publicStatus: "completed",
        phase: "completed", completedAt: "2026-08-31T23:46:00.000Z",
        data: { executionId: "boundary-execution-1", intentId: "intent-1" },
        binding: { lineageId: "lineage-1", executionOrdinal: 1,
          retryOfExecutionId: null, sourceRevision: 1, lifecycleGeneration: 0,
          providerId: "provider-safe", modelId: "model-safe",
          queuedAt: "2026-08-31T23:44:00.000Z" },
      });
    expect(records.filter(({ category }) => category === "memory")).toEqual([
      expect.objectContaining({ entityId: "memory-version-1", revision: 1,
        payload: expect.objectContaining({
          originKind: "steward", createdByActorId: null, replacesVersionId: null,
          sourceCount: 1,
          sourceRefs: [{ sourceKind: "message", sourceId: "message-1", sourceRevision: 1 }],
        }) }),
      expect.objectContaining({ entityId: "memory-version-2", revision: 2,
        payload: expect.objectContaining({
          originKind: "human_resolution", createdByActorId: "owner",
          replacesVersionId: "memory-version-1", sourceCount: 3,
          sourceRefs: [
            { sourceKind: "message", sourceId: "Z-source", sourceRevision: 1 },
            { sourceKind: "message", sourceId: "a-source", sourceRevision: 1 },
            { sourceKind: "message", sourceId: "message-1", sourceRevision: 1 },
          ],
        }) }),
    ]);
    expect(new Set(records.map((record) => `${record.category}:${record.entityId}:${record.revision}`)).size)
      .toBe(records.length);
  });

  it("uses the same SQLite BINARY ordering for keyset cursors and in-memory merge", () => {
    const database = projectionDatabase();
    database.prepare("UPDATE streams SET head_seq = 14 WHERE stream_id = 'room-1'").run();
    for (const [eventId, streamSeq] of [["Z", 13], ["a", 14]] as const) {
      database.prepare(
        `INSERT INTO events VALUES (?, 'room', 'room-1', ?, 'room-1', 'owner',
           'project.fact.created', '2026-08-31T23:55:00.000Z', '{}')`,
      ).run(eventId, streamSeq);
      database.prepare(
        `INSERT INTO project_events VALUES (
           ?, 'room-1', 'room-1', 'fact.created', 'goal', ?, 1, 'human',
           'message', 'message-1', 1, '2026-08-31T23:55:00.000Z', '{}')`,
      ).run(eventId, `fact-${eventId}`);
    }
    const entityIds: string[] = [];
    let after: string | undefined;
    do {
      const page = executePrivacyDataAuthorityOperation(database, {
        ...readOperation(after), watermark: 14, limit: 1,
      });
      if (page.kind !== "room-export-page") throw new Error("unexpected page");
      entityIds.push(...page.records.filter(({ category }) => category === "project_fact")
        .map(({ entityId }) => entityId));
      after = page.next;
    } while (after !== undefined);

    expect(entityIds.filter((entityId) => entityId === "Z" || entityId === "a"))
      .toEqual(["Z", "a"]);
    expect(new Set(entityIds).size).toBe(entityIds.length);
  });

  it("keeps message state at the watermark and rejects raw provider material", () => {
    const database = projectionDatabase();
    database.prepare("UPDATE streams SET head_seq = 13 WHERE stream_id = 'room-1'").run();
    database.prepare(
      `INSERT INTO events VALUES (
         'post-snapshot-revision', 'room', 'room-1', 13, 'room-1', 'owner',
         'room.message.revised', '2026-09-01T00:01:00.000Z', '{"id":"message-1"}'
       )`,
    ).run();
    database.prepare(
      `INSERT INTO message_revisions VALUES (
         'message-1', 2, 'post-snapshot-body', '2026-09-01T00:01:00.000Z', 'owner'
       )`,
    ).run();
    database.prepare(
      "UPDATE message_envelopes SET current_revision = 2, revision_count = 2 WHERE message_id = 'message-1'",
    ).run();

    const first = executePrivacyDataAuthorityOperation(database, readOperation());
    expect(first.kind).toBe("room-export-page");
    let after = first.kind === "room-export-page" ? first.next : undefined;
    const records = first.kind === "room-export-page" ? [...first.records] : [];
    while (after !== undefined) {
      const page = executePrivacyDataAuthorityOperation(database, readOperation(after));
      if (page.kind !== "room-export-page") throw new Error("unexpected page");
      records.push(...page.records);
      after = page.next;
    }
    expect(JSON.stringify(records)).not.toContain("post-snapshot-body");
    expect(records.find((record) => record.category === "message")?.revision).toBe(1);

    database.prepare(
      `UPDATE room_memory_sources
       SET safe_metadata_json = '{"providerRequest":{"authorization":"sentinel"}}'`,
    ).run();
    expect(() => executePrivacyDataAuthorityOperation(database, readOperation()))
      .toThrowError(PrivacyDataAuthorityError);
  });

  it("does not let mutable current-only attachment, execution, or membership state drift across pages", () => {
    const baseline = projectionDatabase();
    const expected = readAll(baseline);
    const database = projectionDatabase();
    const first = executePrivacyDataAuthorityOperation(database, readOperation());
    if (first.kind !== "room-export-page") throw new Error("unexpected page");

    database.prepare(
      `UPDATE attachments SET processing_generation = 9, processing_status = 'cancelled',
       source_message_id = NULL, updated_at = '2026-09-01T00:02:00.000Z'
       WHERE attachment_id = 'attachment-1'`,
    ).run();
    database.prepare(
      `UPDATE agent_executions SET status = 'failed', completed_at = ?, updated_at = ?,
       result_message_id = 'post-snapshot-result' WHERE id = 'execution-1'`,
    ).run("2026-09-01T00:02:00.000Z", "2026-09-01T00:02:00.000Z");
    database.prepare(
      `UPDATE agent_execution_attempts SET status = 'failed', finished_at = ?,
       error_code = 'post_snapshot' WHERE execution_id = 'execution-1'`,
    ).run("2026-09-01T00:02:00.000Z");
    database.prepare(
      `UPDATE project_boundary_agent_executions
       SET public_status = 'failed', phase = 'failed', authority_version = 99,
           updated_at = '2026-09-01T00:02:00.000Z', completed_at = '2026-09-01T00:02:00.000Z'
       WHERE execution_id = 'boundary-execution-1'`,
    ).run();
    database.prepare(
      "UPDATE room_memberships SET participation = 'inactive', access_revision = 1 WHERE actor_id = 'agent-1'",
    ).run();
    database.prepare("UPDATE streams SET head_seq = 13 WHERE stream_id = 'room-1'").run();
    database.prepare(
      `INSERT INTO events VALUES (
         'post-watermark-execution', 'room', 'room-1', 13, 'room-1', 'agent-1',
         'agent.execution.changed', '2026-09-01T00:02:00.000Z',
         '{"executionId":"execution-post-watermark","roomId":"room-1","agentId":"agent-1","status":"failed","phase":"failed","version":1,"updatedAt":"2026-09-01T00:02:00.000Z"}'
       )`,
    ).run();

    const records = [...first.records];
    let after = first.next;
    while (after !== undefined) {
      const page = executePrivacyDataAuthorityOperation(database, readOperation(after));
      if (page.kind !== "room-export-page") throw new Error("unexpected page");
      records.push(...page.records);
      after = page.next;
    }
    expect(records).toEqual(expected);
    expect(JSON.stringify(records)).not.toContain("changed_after_snapshot");
    expect(JSON.stringify(records)).not.toContain("post-snapshot");
    expect(JSON.stringify(records)).not.toContain("post-watermark");
  });

  it("reruns old W byte-stably after boundary terminal and same-time post-W memory mutations", () => {
    const database = projectionDatabase();
    const before = readAll(database);
    database.prepare(
      `UPDATE project_boundary_agent_executions
       SET public_status = 'failed', phase = 'failed', authority_version = 99,
           updated_at = '2026-09-01T00:02:00.000Z',
           completed_at = '2026-09-01T00:02:00.000Z',
           result_message_id = 'post-watermark-result'
       WHERE execution_id = 'boundary-execution-1'`,
    ).run();
    database.prepare("UPDATE streams SET head_seq = 13 WHERE stream_id = 'room-1'").run();
    database.prepare(
      `INSERT INTO room_memory_versions VALUES (
        'memory-version-post-w', 'memory-1', 'room-1', 3, 'context', 'resolved',
        'post watermark memory', 'human_resolution', 1, ?, 'owner', NULL, 'memory-version-2'
      )`,
    ).run(STARTED_AT);
    database.prepare(
      `INSERT INTO room_memory_source_edges VALUES (
        'memory-version-post-w', 'room-1', 'message', 'message-1', 1
      )`,
    ).run();
    database.prepare(
      `INSERT INTO events VALUES (
        'memory-version-event-post-w', 'room', 'room-1', 13, 'room-1', 'owner',
        'room.memory.version.changed', ?, '{"memoryVersionId":"memory-version-post-w"}'
      )`,
    ).run(STARTED_AT);

    const after = readAll(database);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("post-watermark-result");
    expect(JSON.stringify(after)).not.toContain("post watermark memory");
    expect(after.find(({ entityId }) =>
      entityId === "boundary-event:boundary-execution-event")?.payload).toHaveProperty("binding");
  });
});
