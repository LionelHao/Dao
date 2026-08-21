import { describe, expect, it } from "vitest";
import {
  CONTEXT_COMPILER_CONFIG_V1,
  compileContextV1,
} from "./context-compiler.js";
import type { ContextCompilerInputV1 } from "@native-im/core";
import { isContextCompileResultV1 } from "@native-im/core";

const occurredAt = "2026-08-21T01:02:03.004Z";

function source(sourceId: string, corpusSeq: number, sourceKind: "message" | "message_revision" | "message_tombstone" | "attachment_extraction" = "message") {
  return { roomId: "room-1", sourceKind, sourceId, revision: 1, corpusSeq } as const;
}

function candidate(sourceId: string, corpusSeq: number, body: string, overrides: Record<string, unknown> = {}) {
  return {
    source: source(sourceId, corpusSeq),
    body,
    availability: "readable" as const,
    author: { actorId: "human-2", kind: "human" as const, displayName: "Teammate" },
    occurredAt,
    replyTo: null,
    mentions: [],
    readRef: `read:${sourceId}`,
    ...overrides,
  };
}

function makeInput(): ContextCompilerInputV1 {
  return {
    version: "context_compiler_input_v1",
    invocation: { invocationId: "invocation-1", executionId: "execution-1", roomId: "room-1" },
    agent: { agentId: "agent-1", displayName: "Build Agent", responsibility: { availability: "unavailable", reason: "ft07_not_delivered" } },
    room: { roomId: "room-1", name: "Release room", goal: { availability: "unavailable", reason: "ft09_not_delivered" } },
    trigger: {
      triggerType: "message",
      reason: "mention",
      source: source("trigger", 9),
      body: "@Build Agent summarize the release.\r\nInclude citations.",
      author: { actorId: "human-1", kind: "human", displayName: "Leo" },
      occurredAt,
      replyTo: { sourceId: "message-0", revision: 2 },
      mentions: [
        { startUtf16: 13, endUtf16: 20, targetKind: "human", targetId: "human-2" },
        { startUtf16: 0, endUtf16: 12, targetKind: "agent", targetId: "agent-1" },
      ],
      readRef: "read:trigger",
    },
    memoryWatermark: 5,
    corpusHead: 9,
    memories: [
      {
        kind: "decision",
        memoryRecordId: "memory-b",
        memoryVersionId: "mv-b",
        version: 1,
        body: "Release requires two reviewers.",
        sourceRefs: [source("old-source", 3)],
        availability: "readable",
      },
      {
        kind: "goal",
        memoryRecordId: "memory-a",
        memoryVersionId: "mv-a",
        version: 2,
        body: "Ship safely.",
        sourceRefs: [source("older-source", 2)],
        availability: "readable",
      },
    ],
    delta: [
      candidate("trigger", 9, "duplicate trigger delta", { source: source("trigger", 9) }),
      candidate("delta-8", 8, "The canary is green."),
      candidate("delta-7", 7, "Release notes are ready."),
      candidate("delta-6", 6, "Tests passed."),
    ],
    retrieval: [candidate("retrieved-1", 1, "An older decision remains relevant.")],
    attachments: [candidate("attachment-1", 7, "Extracted release checklist.", { source: source("attachment-1", 7, "attachment_extraction"), segment: { index: 0, count: 2, startByte: 0, endByte: 28 } })],
    project: { availability: "disabled", reason: "ft09_not_delivered" },
    tools: [
      { id: "z-tool", description: "Last", effect: "read-only", inputSchemaCanonical: "{}" },
      { id: "a-tool", description: "First", effect: "read-only", inputSchemaCanonical: "{}" },
    ],
    trusted: { system: "Follow room authorization.", developerPolicy: "Cite manifest labels only." },
  };
}

describe("compileContextV1", () => {
  it("is byte-identical, canonically ordered, layered, and citation-manifest backed", () => {
    const first = compileContextV1(makeInput(), CONTEXT_COMPILER_CONFIG_V1);
    const second = compileContextV1(makeInput(), CONTEXT_COMPILER_CONFIG_V1);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.canonicalEnvelope).toBe(second.ok ? second.canonicalEnvelope : "");
    expect(first.envelope.trusted.system).toBe("Follow room authorization.");
    expect(first.envelope.groupContent.every((item) => item.trust === "untrusted_group_content")).toBe(true);
    expect(first.envelope.groupContent.map((item) => item.section)).toEqual([
      "trigger", "memory", "memory", "delta", "delta", "delta", "retrieval", "attachment",
    ]);
    expect(first.envelope.groupContent[0]?.mentions.map((mention) => mention.targetId)).toEqual(["agent-1", "human-2"]);
    expect(first.envelope.groupContent[0]?.replyTo).toEqual({ sourceId: "message-0", revision: 2 });
    expect(first.envelope.availableTools.map((tool) => tool.id)).toEqual(["a-tool", "z-tool"]);
    expect(first.envelope.projectContext).toEqual({ availability: "disabled", reason: "ft09_not_delivered" });
    expect(first.manifest.items.map((item) => item.citationLabel)).toEqual([
      "ctx-0001", "ctx-0002", "ctx-0003", "ctx-0004", "ctx-0005", "ctx-0006", "ctx-0007", "ctx-0008",
    ]);
    expect(first.manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.envelopeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.envelopeSha256).toBe("dd869f614c0a1782da9ab78f0e25e433594d6f45bb5da53e3ca9954962f48b90");
    expect(first.manifestSha256).toBe("f45c32cc7f83bc1d537187f33ea5698e54e10b0e3670b4473e314679154e80dc");
    expect(first.envelope.trusted.developer.agent.responsibility).toEqual({ availability: "unavailable", reason: "ft07_not_delivered" });
    expect(first.envelope.trusted.developer.room.goal).toEqual({ availability: "unavailable", reason: "ft09_not_delivered" });
    expect(first.envelope.trusted.developer.triggerType).toBe("message");
    expect(isContextCompileResultV1(first)).toBe(true);
    expect(isContextCompileResultV1({ ...first, manifestSha256: "0".repeat(64), covert: true })).toBe(false);
    expect(first.canonicalEnvelope).not.toContain("visibleConversation");
  });

  it("does not change output for input array and object insertion permutations", () => {
    const base = makeInput();
    const permuted: ContextCompilerInputV1 = {
      trusted: { developerPolicy: base.trusted.developerPolicy, system: base.trusted.system },
      tools: [...base.tools].reverse(),
      project: base.project,
      attachments: [...base.attachments].reverse(),
      retrieval: [...base.retrieval].reverse(),
      delta: [...base.delta].reverse(),
      memories: [...base.memories].reverse(),
      corpusHead: base.corpusHead,
      memoryWatermark: base.memoryWatermark,
      trigger: { ...base.trigger, mentions: [...base.trigger.mentions].reverse() },
      room: base.room,
      agent: base.agent,
      invocation: base.invocation,
      version: base.version,
    };
    expect(compileContextV1(permuted, CONTEXT_COMPILER_CONFIG_V1)).toEqual(compileContextV1(base, CONTEXT_COMPILER_CONFIG_V1));
  });

  it("deduplicates one stable source identity so its body appears in only the highest-priority section", () => {
    const input = makeInput();
    input.retrieval = [candidate("delta-6", 6, "duplicate body must not appear")];
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.items.filter((item) => item.source.sourceId === "delta-6")).toHaveLength(1);
    expect(result.canonicalEnvelope).not.toContain("duplicate body must not appear");
  });

  it("records every closed disposition and never disguises unavailable or invalidated sources", () => {
    const input = makeInput();
    input.delta = [
      candidate("gone", 6, "", { body: null, availability: "temporarily_unavailable" }),
      candidate("recalled", 7, "", { body: null, availability: "invalidated" }),
      candidate("tombstone", 8, "", { body: null, availability: "tombstone", source: source("tombstone", 8, "message_tombstone") }),
      candidate("trigger", 9, "duplicate trigger delta", { source: source("trigger", 9) }),
    ];
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.items.map((item) => item.disposition)).toContain("unavailable");
    expect(result.manifest.items.map((item) => item.disposition)).toContain("invalidated");
    expect(result.manifest.items.find((item) => item.source.sourceId === "tombstone")?.disposition).toBe("index_only");
    expect(result.envelope.groupContent.some((item) => item.source.sourceId === "gone")).toBe(false);
  });

  it("degrades Unicode-safely and returns content_too_large only when a necessary trigger representation cannot fit", () => {
    const input = makeInput();
    input.trigger.body = `${"🙂".repeat(10_000)}e\u0301${"x".repeat(20_000)}`;
    input.trigger.mentions = [];
    const degraded = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(degraded.ok).toBe(true);
    if (degraded.ok) {
      expect(["excerpted", "digested", "index_only"]).toContain(degraded.manifest.items[0]?.disposition);
      expect(degraded.manifest.items[0]?.disposition).not.toBe("omitted");
      expect(degraded.envelope.accounting.totalTokens).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.hardLimitTokens);
      expect(degraded.envelope.accounting.envelopeBytes).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.envelopeBytes);
    }

    const impossible = compileContextV1(input, {
      ...CONTEXT_COMPILER_CONFIG_V1,
      triggerBudgetTokens: 1,
      triggerBytes: 1,
    });
    expect(impossible).toMatchObject({
      ok: false,
      error: { code: "content_too_large", sourceLabel: "ctx-0001", recovery: "reduce_required_trigger_metadata" },
    });
  });

  it("keeps corrected retrieval and attachment budgets separate and respects all byte/token bounds", () => {
    const input = makeInput();
    input.retrieval = [candidate("large-retrieval", 1, "r".repeat(30_000))];
    input.attachments = [candidate("large-attachment", 2, "a".repeat(30_000), { source: source("large-attachment", 2, "attachment_extraction") })];
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const consumedInput = Object.entries(result.envelope.accounting.sectionTokens)
      .filter(([section]) => !["tools", "framing", "manifest"].includes(section))
      .reduce((sum, [, tokens]) => sum + tokens, 0);
    expect(consumedInput).toBeLessThanOrEqual(47_104);
    expect(result.envelope.accounting.sectionTokens.retrieval).toBeGreaterThan(0);
    expect(result.envelope.accounting.sectionTokens.attachment).toBeGreaterThan(0);
    expect(result.envelope.accounting.totalTokens).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.hardLimitTokens);
  });

  it("aggregates a large complete delta tail into one deterministic source-index range", () => {
    const input = makeInput();
    input.memoryWatermark = 0;
    input.corpusHead = 512;
    input.memories = [];
    input.trigger.source = source("bulk-512", 512);
    input.delta = Array.from({ length: 512 }, (_, index) => candidate(
      `bulk-${index + 1}`,
      index + 1,
      `delta-${index + 1}:${"x".repeat(512)}`,
    ));
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ranges = result.manifest.items.filter((item) => item.source === null);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ section: "delta", disposition: "omitted", count: 506, fromCorpusSeq: 6, toCorpusSeq: 511 });
    expect(ranges[0]?.sourceIndexHash).toBe("868b9a3a10254a601dd5424e4b1c6568e0ce190172cb9c679b35baacf9138f6f");
    expect(isContextCompileResultV1(result)).toBe(true);
    expect(result.envelope.accounting.sectionTokens.manifest).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.manifestBudgetTokens);
    expect(Buffer.byteLength(result.canonicalManifest, "utf8")).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.manifestBytes);
  });
});
