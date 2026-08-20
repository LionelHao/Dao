import { readFileSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { registerMemoryCorpusSource } from "./corpus-database-authority.js";
import { executeMemoryAuthorityOperation } from "./authority-database-handler.js";
import { invalidateRoomMemorySource } from "./database-authority.js";
import { createOpenAIMemoryStewardProvider } from "./openai-memory-provider.js";
import { memoryRepairSegmentDescriptor } from "./repair-descriptor.js";
import { createMemoryStewardProviderAdapter } from "./steward-provider-adapter.js";
import type { MemoryStewardBatch } from "./memory-steward-runtime.js";

const T0 = Date.parse("2026-08-20T00:00:00.000Z");
const RAW_MESSAGE = "raw-message-sentinel-1427 launch is Friday";
const RAW_ATTACHMENT = "raw-attachment-sentinel-8d31 private appendix";
const SECRET = "provider-secret-sentinel-cb22";
const PROVIDER_BODY = "provider-body-sentinel-62aa";
const PROVIDER_HEADER = "provider-header-sentinel-321c";
const HIDDEN_REASONING = "hidden-reasoning-sentinel-99bd";
const SAFE_DERIVED = "Validated launch timing is Friday.";

function serializedRows(database: DatabaseSync, table: string): string {
  return JSON.stringify(database.prepare(`SELECT * FROM "${table}"`).all(), (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value);
}

describe("FT-05 raw corpus and Provider leak sentinel", () => {
  it("persists only validated memory and provenance across live WAL, repair, outbox, and diagnostics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-memory-secret-sentinel-"));
    const databasePath = join(directory, "authority.sqlite");
    const database = new DatabaseSync(databasePath);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      migrateAuthorityDatabase(database);
      database.exec("PRAGMA journal_mode=WAL");
      database.exec(`
        INSERT INTO actors (id, kind, display_name, tool_permissions_json)
        VALUES ('human-owner', 'human', 'Owner', '[]');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'human-owner', 0, 1), ('room', 'room-1', 0, 1);
        INSERT INTO rooms (id, name, status, created_at, owner_actor_id)
        VALUES ('room-1', 'Memory Room', 'active', '2026-08-20T00:00:00.000Z', 'human-owner');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES ('room-1', 'human-owner', 'human', 'owner', NULL, '[]',
          '2026-08-20T00:00:00.000Z', NULL, 0);
        INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
        VALUES ('message-1', 'room-1', 'human-owner', 'human', '${RAW_MESSAGE}',
          '2026-08-20T00:00:00.000Z');
        INSERT INTO message_revisions (message_id, revision, body, revised_at, revised_by_actor_id)
        VALUES ('message-1', 1, '${RAW_MESSAGE}', '2026-08-20T00:00:00.000Z', 'human-owner');
        INSERT INTO message_envelopes (
          message_id, room_id, message_kind, lifecycle, current_revision,
          revision_count, created_at, recalled_at, recalled_by_actor_id
        ) VALUES ('message-1', 'room-1', 'human', 'active', 1, 1,
          '2026-08-20T00:00:00.000Z', NULL, NULL);
      `);
      registerMemoryCorpusSource(database, {
        roomId: "room-1", sourceKind: "message", sourceId: "message:message-1",
        sourceRevision: 1, serverStreamSeq: 1, eligibility: "eligible",
        availability: "readable", sourceActorId: "human-owner",
        safeMetadata: { authorKind: "human", messageId: "message-1" },
        readReference: "message-authority:message-1:revision:1",
        occurredAt: "2026-08-20T00:00:00.000Z",
      });

      const claim = executeMemoryAuthorityOperation(database, {
        type: "memory.claim", roomId: "room-1", jobId: "memory-job:sentinel",
        attemptId: "memory-attempt:sentinel", inputSha256: "a".repeat(64),
        batchSize: 32, now: T0 + 1_000,
      });
      if (claim.kind !== "claimed" || claim.batch === null) throw new Error("missing batch");
      const response = (sourceKind: string) => new Response(JSON.stringify({
        output: [
          { type: "reasoning", encrypted_content: `${PROVIDER_BODY}:${HIDDEN_REASONING}` },
          { type: "message", content: [{ type: "output_text", text: JSON.stringify({
            schemaVersion: 1,
            candidates: [{ operation: "create", kind: "context",
              derivedText: sourceKind === "attachment_extraction"
                ? "Validated attachment note." : SAFE_DERIVED,
              sourceRefs: [{ sourceKind, sourceId: sourceKind === "attachment_extraction"
                ? "attachment-extraction:attachment-1" : "message:message-1",
              sourceRevision: 1 }], dedupeKey: `sentinel-${sourceKind}`,
              replacesMemoryRecordId: null }],
          }) }] },
        ],
      }), { status: 200, headers: { "content-type": "application/json",
        "x-provider-debug": PROVIDER_HEADER } });
      const fetchForTest = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = String(init?.body);
        return response(body.includes("attachment_extraction") ? "attachment_extraction" : "message");
      });
      const provider = createOpenAIMemoryStewardProvider({
        endpoint: "https://api.openai.com/v1/responses",
        model: "memory-model",
        secretProvider: { getSecret: () => SECRET },
        testOnlyFetch: fetchForTest,
      });
      const authority = {
        async authorizeSource(batch: typeof claim.batch, identity: Readonly<{
          sourceKind: "message" | "message_revision" | "attachment_extraction";
          sourceId: string;
          sourceRevision: number;
        }>) {
          const result = executeMemoryAuthorityOperation(database, {
            type: "memory.source-authorize", batch, ...identity, now: T0 + 1_100,
          });
          if (result.kind !== "source") throw new Error("source authorization failed");
          return result.source;
        },
        async isKnownRecord() { return false; },
      };
      const adapter = createMemoryStewardProviderAdapter({ authority, provider,
        readiness: () => "ready" });
      const result = await adapter.process({ ...claim.batch, sources: claim.sources },
        new AbortController().signal);
      const committed = executeMemoryAuthorityOperation(database, {
        type: "memory.complete", batch: claim.batch, outputSha256: result.outputSha256,
        plan: result.plan, now: T0 + 2_000,
      });
      expect(committed).toEqual({ kind: "completed", committed: true });

      const attachmentBatch: MemoryStewardBatch = {
        roomId: "room-1", jobId: "memory-job:attachment", attemptId: "memory-attempt:attachment",
        recoveryGeneration: 0, fromWatermarkExclusive: 1, toCorpusSeqInclusive: 2,
        sourceCount: 1, sources: [{ corpusSeq: 2, sourceKind: "attachment_extraction",
          sourceId: "attachment-extraction:attachment-1", sourceRevision: 1,
          eligibility: "eligible", availability: "readable" }],
      };
      const attachmentAdapter = createMemoryStewardProviderAdapter({
        authority: {
          async authorizeSource(_batch, identity) {
            return identity.sourceKind === "attachment_extraction"
              ? { kind: "attachment" as const, roomId: "room-1", ...identity, corpusSeq: 2,
                objectKey: "opaque-object-key", sha256: "b".repeat(64),
                byteSize: Buffer.byteLength(RAW_ATTACHMENT) }
              : (() => { throw new Error("unexpected source"); })();
          },
          async isKnownRecord() { return false; },
        },
        provider: {
          async generate(input) {
            expect(input.sources[0]?.content).toBe(RAW_ATTACHMENT);
            return Object.freeze({ schemaVersion: 1 as const, candidates: Object.freeze([Object.freeze({
              operation: "create" as const,
              kind: "context" as const,
              derivedText: "Validated attachment note.",
              sourceRefs: Object.freeze([Object.freeze({ sourceKind: "attachment_extraction" as const,
                sourceId: "attachment-extraction:attachment-1", sourceRevision: 1 })]),
              dedupeKey: "sentinel-attachment",
              replacesMemoryRecordId: null,
            })]) });
          },
        },
        readiness: () => "ready",
        objectStore: {
          async readAuthorizedRange(_objectKey, offset, maximumBytes) {
            const bytes = new TextEncoder().encode(RAW_ATTACHMENT);
            const result = bytes.slice(offset, offset + maximumBytes);
            return { bytes: result, byteSize: bytes.byteLength,
              eof: offset + result.byteLength === bytes.byteLength };
          },
        },
      });
      const attachmentResult = await attachmentAdapter.process(
        attachmentBatch,
        new AbortController().signal,
      );
      expect(JSON.stringify(attachmentResult)).not.toContain(RAW_ATTACHMENT);

      invalidateRoomMemorySource(database, { roomId: "room-1", sourceKind: "message",
        sourceId: "message:message-1", sourceRevision: 1,
        eligibility: "excluded_recalled", availability: "metadata_only",
        occurredAt: "2026-08-20T00:03:00.000Z" });
      const repairRows = memoryRepairSegmentDescriptor.readKeysetPage({ database,
        roomId: "room-1", watermark: 1, afterKey: undefined, limit: 200 });
      const repair = repairRows.map((row) => memoryRepairSegmentDescriptor.mapRow(row));
      const diagnostics = JSON.stringify({ result, attachmentResult, repair,
        logs: [...info.mock.calls, ...errorLog.mock.calls], stdout: "", stderr: "" });

      const tableNames = database.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
        .map((row) => String(row.name));
      const allRows = new Map(tableNames.map((table) => [table, serializedRows(database, table)]));
      const memoryDomain = [...allRows]
        .filter(([table]) => table.startsWith("room_memory_") || table === "events" ||
          table === "outbox_deliveries")
        .map(([, value]) => value).join("");
      expect(memoryDomain).not.toContain(RAW_MESSAGE);
      expect(memoryDomain).not.toContain(RAW_ATTACHMENT);
      expect(diagnostics).not.toContain(RAW_MESSAGE);
      expect(diagnostics).not.toContain(RAW_ATTACHMENT);
      expect(diagnostics).toContain(SAFE_DERIVED);
      expect(allRows.get("message_revisions")).toContain(RAW_MESSAGE);

      for (const forbidden of [SECRET, PROVIDER_BODY, PROVIDER_HEADER, HIDDEN_REASONING]) {
        expect([...allRows.values()].join("")).not.toContain(forbidden);
        expect(diagnostics).not.toContain(forbidden);
      }
      const requestBody = String(fetchForTest.mock.calls[0]?.[1]?.body);
      expect(requestBody).toContain(RAW_MESSAGE);
      expect(requestBody).not.toContain(SECRET);

      const liveFiles = readdirSync(directory)
        .map((name) => readFileSync(join(directory, name)).toString("latin1")).join("");
      for (const forbidden of [SECRET, PROVIDER_BODY, PROVIDER_HEADER, HIDDEN_REASONING,
        RAW_ATTACHMENT]) expect(liveFiles).not.toContain(forbidden);
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const checkpointedFiles = readdirSync(directory)
        .map((name) => readFileSync(join(directory, name)).toString("latin1")).join("");
      for (const forbidden of [SECRET, PROVIDER_BODY, PROVIDER_HEADER, HIDDEN_REASONING,
        RAW_ATTACHMENT]) expect(checkpointedFiles).not.toContain(forbidden);
    } finally {
      info.mockRestore();
      errorLog.mockRestore();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
