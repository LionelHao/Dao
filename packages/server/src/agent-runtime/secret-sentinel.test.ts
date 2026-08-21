import { readFileSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { RouterProviderInput } from "@native-im/core";
import { migrateAuthorityDatabase } from "../persistence/schema.js";
import { createOpenAIRouterProvider } from "../route-runtime/openai-router-provider.js";
import type { CompiledProviderEnvelopeV1 } from "./compiled-provider-envelope.js";
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
        `event: response.output_item.done\ndata: {"type":"response.output_item.done","raw_private_metadata":${JSON.stringify(sentinel)}}\n\n` +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"body\\":\\"safe\\",\\"citations\\":[]}"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
      const provider = createOpenAIResponsesProvider({
        endpoint: "https://api.openai.com/v1/responses",
        model: "configured-model",
        secretProvider: { getSecret: () => sentinel },
        fetch,
      });
      const input: CompiledProviderEnvelopeV1 = {
        purpose: "agent_runtime",
        schemaVersion: "compiled-context-envelope.v1",
        snapshot: {
          snapshotId: "snapshot-sentinel", generation: 1, manifestHash: "a".repeat(64),
          compilerVersion: "context-compiler-v1", configVersion: "context-budget-v1",
          modelId: "configured-model",
        },
        invocation: {
          kind: "direct_mention",
          roomId: "room-sentinel",
          sourceMessageId: "message-sentinel",
          targetAgentId: "agent-sentinel",
        },
        trusted: {
          system: [{ kind: "product_policy", text: "Follow server authority." }],
          developer: [{ kind: "agent_identity", data: { agentId: "agent-sentinel" } }],
        },
        groupContent: [{
          kind: "human_message", trust: "untrusted_group_content",
          source: { label: "source-sentinel", kind: "message", revision: 1 },
          speaker: { actorId: "human-sentinel", kind: "human" },
          content: "safe",
        }],
        projectContext: { status: "disabled" },
        availableTools: [],
        openItemTargets: [],
        committedSteps: [],
        limits: {
          maxInputBytes: 8_192, maxOutputTokens: 1_024,
          maxOutputBytes: 8_192, timeoutMs: 5_000,
        },
      };
      const wireEvents = [];
      for await (const event of provider.stream(input, new AbortController().signal)) wireEvents.push(event);
      const routerFetch = vi.fn(async () => new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify({ candidates: [] }) }] }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
      const router = createOpenAIRouterProvider({
        endpoint: "https://api.openai.com/v1/responses",
        model: "configured-router-model",
        secretProvider: { getSecret: () => sentinel },
        fetch: routerFetch,
      });
      const routerInput: RouterProviderInput = {
        purpose: "route_decision",
        roomId: "room-sentinel",
        sourceMessageId: "message-sentinel",
        message: { authorId: "human-sentinel", authorKind: "human", summary: "safe" },
        roomPhase: "discussion",
        agents: [],
        topic: {
          topicKey: "topic-v1:sentinel",
          embeddingModelVersion: "dao-topic-embedding-v1",
          windowSize: 8,
          cosineThreshold: 0.82,
        },
        limits: { timeoutMs: 1_000, maxCandidates: 0, maxOutputBytes: 64 * 1_024 },
      };
      const routePlan = await router.decide(routerInput, new AbortController().signal);
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.close();

      const durableBytes = readdirSync(directory)
        .map((name) => readFileSync(join(directory, name)))
        .reduce((total, bytes) => `${total}${bytes.toString("latin1")}`, "");
      const diagnostic = JSON.stringify({ wireEvents, routePlan, error: null, stdout: "", stderr: "" });
      expect(durableBytes).not.toContain(sentinel);
      expect(diagnostic).not.toContain(sentinel);
      expect(JSON.stringify(fetch.mock.calls[0]?.[1]?.body)).not.toContain(sentinel);
      expect(JSON.stringify(routerFetch.mock.calls[0]?.[1]?.body)).not.toContain(sentinel);
      expect(JSON.stringify(wireEvents)).not.toContain(sentinel);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
