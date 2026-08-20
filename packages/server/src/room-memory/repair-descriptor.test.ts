import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isRoomMemoryRepairRecord,
  type RoomMemoryRepairRecord,
} from "@native-im/core";
import { describe, expect, it } from "vitest";
import {
  createClosedRepairProjectionRegistry,
} from "../persistence/repair-projection-registry.js";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import {
  ROOM_MEMORY_REPAIR_KEYSET_LIMIT,
  RoomMemoryRepairDescriptorError,
  memoryRepairSegmentDescriptor,
} from "./repair-descriptor.js";

const NOW = "2026-08-19T01:02:03.004Z";
const RAW_SENTINEL = "RAW_MESSAGE_EXTRACTION_PROVIDER_PROMPT_SENTINEL";
const databaseDirectories = new WeakMap<DatabaseSync, string>();

function createDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "dao-memory-repair-"));
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  databaseDirectories.set(database, directory);
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO actors (id, kind, display_name, tool_permissions_json)
    VALUES ('memory-owner', 'human', 'Owner', '[]'),
           ('memory-reviewer', 'human', 'Reviewer', '[]');
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('identity', 'memory-owner', 0, 1),
           ('identity', 'memory-reviewer', 0, 1),
           ('room', 'memory-room', 0, 1);
    INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
    VALUES ('memory-room', 'Memory Room', 'active', '${NOW}', 'memory-owner');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('memory-room', 'memory-owner', 'human', 'owner', NULL, '[]',
        '${NOW}', NULL, 0),
      ('memory-room', 'memory-reviewer', 'human', 'member', NULL, '[]',
        '${NOW}', NULL, 0);
    INSERT INTO room_memory_sources (
      room_id, corpus_seq, source_kind, source_id, source_revision,
      server_stream_seq, eligibility, availability, source_actor_id,
      safe_metadata_json, read_reference, occurred_at, updated_at
    ) VALUES (
      'memory-room', 1, 'message', 'message:source-1', 1,
      9, 'eligible', 'readable', 'memory-owner',
      '{"privateRaw":"${RAW_SENTINEL}"}', 'message-ref:1', '${NOW}', '${NOW}'
    );
  `);
  return database;
}

function closeDatabase(database: DatabaseSync): void {
  const directory = databaseDirectories.get(database);
  database.close();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
}

function insertRecord(
  database: DatabaseSync,
  recordId: string,
  kind: "context" | "goal",
): void {
  database.prepare(`
    INSERT INTO room_memory_records (
      memory_record_id, room_id, kind, dedupe_key, current_version_id,
      current_version_number, created_at, updated_at
    ) VALUES (?, 'memory-room', ?, ?, NULL, 0, ?, ?)
  `).run(recordId, kind, `${RAW_SENTINEL}:${recordId}`, NOW, NOW);
}

function insertVersion(
  database: DatabaseSync,
  input: Readonly<{
    versionId: string;
    recordId: string;
    version: number;
    kind: "context" | "goal";
    state: "active" | "proposal" | "disputed" | "resolved";
    derivedText: string;
    replacesVersionId?: string;
  }>,
): void {
  const isInitial = input.version === 1;
  database.prepare(`
    INSERT INTO room_memory_versions (
      memory_version_id, memory_record_id, room_id, version_number, kind, state,
      derived_text, proposal_id, origin_kind, created_by_actor_id, source_job_id,
      replaces_version_id, source_count, created_at
    ) VALUES (?, ?, 'memory-room', ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?)
  `).run(
    input.versionId,
    input.recordId,
    input.version,
    input.kind,
    input.state,
    input.derivedText,
    input.kind === "context" ? null : `proposal:${input.versionId}`,
    isInitial ? "steward" : "human_resolution",
    isInitial ? null : "memory-reviewer",
    input.replacesVersionId ?? null,
    NOW,
  );
  database.prepare(`
    INSERT INTO room_memory_source_edges (
      edge_id, memory_version_id, memory_record_id, room_id, source_kind,
      source_id, source_revision, created_at
    ) VALUES (?, ?, ?, 'memory-room', 'message', 'message:source-1', 1, ?)
  `).run(`edge:${input.versionId}`, input.versionId, input.recordId, NOW);
}

function seedCurrentMemory(database: DatabaseSync): void {
  insertRecord(database, "a-context", "context");
  insertVersion(database, {
    versionId: "context-v1",
    recordId: "a-context",
    version: 1,
    kind: "context",
    state: "active",
    derivedText: "The production service is single-tenant.",
  });
  insertVersion(database, {
    versionId: "context-v2",
    recordId: "a-context",
    version: 2,
    kind: "context",
    state: "disputed",
    derivedText: "The production service may be multi-tenant.",
    replacesVersionId: "context-v1",
  });
  database.exec(`
    INSERT INTO room_memory_disputes (
      dispute_id, room_id, memory_record_id, expected_version_id,
      disputed_version_id, expected_version_number, operator_kind,
      operator_actor_id, reason, created_at
    ) VALUES (
      'context-dispute', 'memory-room', 'a-context', 'context-v1',
      'context-v2', 1, 'human', 'memory-reviewer',
      'The tenancy constraint changed.', '${NOW}'
    );
  `);
  insertVersion(database, {
    versionId: "context-v3",
    recordId: "a-context",
    version: 3,
    kind: "context",
    state: "resolved",
    derivedText: "The current tenancy constraint was re-evaluated.",
    replacesVersionId: "context-v2",
  });
  insertVersion(database, {
    versionId: "context-v4",
    recordId: "a-context",
    version: 4,
    kind: "context",
    state: "active",
    derivedText: "The production service supports isolated tenants.",
    replacesVersionId: "context-v3",
  });
  database.exec(`
    INSERT INTO room_memory_resolutions (
      resolution_id, dispute_id, room_id, memory_record_id,
      expected_disputed_version_id, resolution_version_id, replacement_version_id,
      operator_kind, operator_actor_id, resolution, reason, created_at
    ) VALUES (
      'context-resolution', 'context-dispute', 'memory-room', 'a-context',
      'context-v2', 'context-v3', 'context-v4', 'human', 'memory-reviewer',
      're_evaluate', 'Re-evaluated against current sources.', '${NOW}'
    );
  `);

  insertRecord(database, "b-goal", "goal");
  insertVersion(database, {
    versionId: "goal-v1",
    recordId: "b-goal",
    version: 1,
    kind: "goal",
    state: "proposal",
    derivedText: "Ship the authority repair path.",
  });

  database.exec(`
    UPDATE room_memory_sources
    SET eligibility = 'excluded_recalled', availability = 'metadata_only',
        updated_at = '${NOW}'
    WHERE room_id = 'memory-room' AND source_id = 'message:source-1';
  `);
}

function registry() {
  return createClosedRepairProjectionRegistry<"memory", RoomMemoryRepairRecord>({
    knownKinds: ["memory"],
    descriptors: [memoryRepairSegmentDescriptor],
  });
}

describe("Room Memory repair descriptor", () => {
  it("declares the feature-owned descriptor without owning central assembly", () => {
    expect(memoryRepairSegmentDescriptor).toMatchObject({
      descriptorId: "dao.repair.memory.v1",
      descriptorVersion: 1,
      kind: "memory",
      order: 17,
    });
  });

  it("reads bounded stable pages from real v18 SQLite and maps current authority", () => {
    const database = createDatabase();
    try {
      seedCurrentMemory(database);
      const repair = registry();
      const first = repair.readStablePage({
        kind: "memory",
        database,
        roomId: "memory-room",
        watermark: 9,
        afterKey: undefined,
        limit: 1,
      });
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        kind: "memory",
        roomId: "memory-room",
        value: {
          recordType: "status",
          status: {
            roomId: "memory-room",
            health: {
              state: "catching_up",
              reason: "backlog",
              memoryWatermark: 0,
              corpusHead: 1,
              lag: 1,
            },
          },
        },
      });

      const statusKey = memoryRepairSegmentDescriptor.stableKey(first[0]!);
      expect(statusKey).toBe("0:status");
      const second = repair.readStablePage({
        kind: "memory",
        database,
        roomId: "memory-room",
        watermark: 9,
        afterKey: statusKey,
        limit: 1,
      });
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({
        kind: "memory",
        roomId: "memory-room",
        value: {
          recordType: "projection",
          projection: {
            projectionKind: "memory",
            memoryRecordId: "a-context",
            kind: "context",
            currentVersion: {
              memoryVersionId: "context-v4",
              version: 4,
              state: "active",
              derivedText: "The production service supports isolated tenants.",
              sourceRefs: [{
                sourceKind: "message",
                sourceId: "message:source-1",
                sourceRevision: 1,
                eligibility: "excluded_recalled",
                availability: "metadata_only",
              }],
            },
            disputes: [{
              disputeId: "context-dispute",
              memoryVersionId: "context-v2",
              status: "resolved",
            }],
            resolutions: [{
              resolutionId: "context-resolution",
              disputeId: "context-dispute",
              fromMemoryVersionId: "context-v2",
              replacementMemoryVersionId: "context-v4",
              action: "re_evaluate",
            }],
          },
        },
      });

      const contextKey = memoryRepairSegmentDescriptor.stableKey(second[0]!);
      const third = repair.readStablePage({
        kind: "memory",
        database,
        roomId: "memory-room",
        watermark: 9,
        afterKey: contextKey,
        limit: 1,
      });
      expect(third).toHaveLength(1);
      expect(third[0]).toMatchObject({
        value: {
          recordType: "projection",
          projection: {
            projectionKind: "memory",
            memoryRecordId: "b-goal",
            kind: "goal",
            currentVersion: {
              state: "proposal",
              derivedText: "Ship the authority repair path.",
            },
          },
        },
      });
      expect(Object.hasOwn(
        (third[0]!.value as { projection: object }).projection,
        "projectFactId",
      )).toBe(false);
      expect(Object.hasOwn(
        (third[0]!.value as { projection: object }).projection,
        "confirmedByActorId",
      )).toBe(false);
      expect(database.prepare(`
        SELECT mode FROM room_memory_project_checkpoint WHERE room_id = 'memory-room'
      `).get()).toEqual({ mode: "disabled" });

      const serialized = JSON.stringify([...first, ...second, ...third]);
      expect(serialized).not.toContain(RAW_SENTINEL);
      expect(serialized).toContain("The production service supports isolated tenants.");
      expect([...first, ...second, ...third].every((record) =>
        isRoomMemoryRepairRecord(record, "memory-room"))).toBe(true);
      expect(repair.readStablePage({
        kind: "memory",
        database,
        roomId: "memory-room",
        watermark: 9,
        afterKey: memoryRepairSegmentDescriptor.stableKey(third[0]!),
        limit: 1,
      })).toEqual([]);
    } finally {
      closeDatabase(database);
    }
  });

  it("uses SQL LIMIT for bounded pagination", () => {
    const database = createDatabase();
    try {
      seedCurrentMemory(database);
      expect(memoryRepairSegmentDescriptor.readKeysetPage({
        database,
        roomId: "memory-room",
        watermark: 9,
        afterKey: undefined,
        limit: 2,
      })).toHaveLength(2);
      expect(() => memoryRepairSegmentDescriptor.readKeysetPage({
        database,
        roomId: "memory-room",
        watermark: 9,
        afterKey: undefined,
        limit: ROOM_MEMORY_REPAIR_KEYSET_LIMIT + 1,
      })).toThrowError(RoomMemoryRepairDescriptorError);
    } finally {
      closeDatabase(database);
    }
  });

  it("fails closed for semantically malformed steward or source storage", () => {
    const malformedStatus = createDatabase();
    try {
      malformedStatus.exec(`
        UPDATE room_memory_stewards
        SET health = 'degraded', health_reason_code = 'provider_raw_stack',
            retryable = 1, updated_at = '${NOW}'
        WHERE room_id = 'memory-room'
      `);
      expect(() => registry().readStablePage({
        kind: "memory",
        database: malformedStatus,
        roomId: "memory-room",
        watermark: 0,
        afterKey: undefined,
        limit: 1,
      })).toThrowError(RoomMemoryRepairDescriptorError);
    } finally {
      closeDatabase(malformedStatus);
    }

    const malformedSource = createDatabase();
    try {
      seedCurrentMemory(malformedSource);
      malformedSource.exec(`
        UPDATE room_memory_sources
        SET availability = 'tombstone', updated_at = '${NOW}'
        WHERE room_id = 'memory-room' AND source_id = 'message:source-1'
      `);
      expect(() => registry().readStablePage({
        kind: "memory",
        database: malformedSource,
        roomId: "memory-room",
        watermark: 9,
        afterKey: "0:status",
        limit: 2,
      })).toThrowError(RoomMemoryRepairDescriptorError);
    } finally {
      closeDatabase(malformedSource);
    }
  });
});
