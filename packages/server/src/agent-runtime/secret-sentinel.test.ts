import { readFileSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeProviderInput } from "@native-im/core";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { createOpenAIResponsesProvider } from "./openai-responses-provider.js";

describe("Agent runtime secret sentinel", () => {
  it("keeps the provider credential out of durable SQLite/WAL, events, messages, wire events, errors, and diagnostics", async () => {
    const sentinel = "test-only-secret-sentinel-96d214";
    const directory = mkdtempSync(join(tmpdir(), "dao-secret-sentinel-"));
    try {
      const databasePath = join(directory, "authority.sqlite");
      const database = new DatabaseSync(databasePath);
      migrateAuthorityDatabase(database);
      database.exec("PRAGMA journal_mode=WAL");
      database.prepare(
        `INSERT INTO actors (id, kind, display_name, reachability, tool_permissions_json)
         VALUES ('human-sentinel', 'human', 'Sentinel-safe human', 'online', '[]')`,
      ).run();
      const fetch = vi.fn(async () => new Response(
        'event: response.created\ndata: {"type":"response.created"}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"safe"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
      const provider = createOpenAIResponsesProvider({
        endpoint: "https://api.openai.com/v1/responses",
        model: "configured-model",
        secretProvider: { getSecret: () => sentinel },
        fetch,
      });
      const input: AgentRuntimeProviderInput = {
        purpose: "agent_runtime",
        invocation: {
          kind: "direct_mention",
          roomId: "room-sentinel",
          sourceMessageId: "message-sentinel",
          targetAgentId: "agent-sentinel",
        },
        visibleConversation: [{ messageId: "message-sentinel", authorId: "human-sentinel", body: "safe" }],
        availableTools: [],
        committedSteps: [],
        limits: { maxInputBytes: 8_192, maxOutputBytes: 8_192, timeoutMs: 5_000 },
      };
      const wireEvents = [];
      for await (const event of provider.stream(input, new AbortController().signal)) wireEvents.push(event);
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.close();

      const durableBytes = readdirSync(directory)
        .map((name) => readFileSync(join(directory, name)))
        .reduce((total, bytes) => `${total}${bytes.toString("latin1")}`, "");
      const diagnostic = JSON.stringify({ wireEvents, error: null, stdout: "", stderr: "" });
      expect(durableBytes).not.toContain(sentinel);
      expect(diagnostic).not.toContain(sentinel);
      expect(JSON.stringify(fetch.mock.calls[0]?.[1]?.body)).not.toContain(sentinel);
      expect(JSON.stringify(wireEvents)).not.toContain(sentinel);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
