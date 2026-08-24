import { describe, expect, it } from "vitest";
import {
  CONTEXT_COMPILER_CONFIG_V1,
  compileContextV1,
  verifyContextCompileResultV1,
} from "./context-compiler.js";
import { canonicalJsonV1, sha256HexV1 } from "./canonical-json.js";
import { estimateStructuredTokensV1, utf8ByteLength } from "./token-estimator.js";
import type { ContextCompilerInputV1 } from "@native-im/core";
import { isCompiledContextEnvelopeV1, isContextCompileResultV1 } from "@native-im/core";

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
    invocation: { invocationId: "invocation-1", executionId: "execution-1", roomId: "room-1",
      intent: { kind: "direct_mention", sourceMessageId: "trigger", targetAgentId: "agent-1", reasonCode: "direct_mention", reasonText: "direct mandatory address" } },
    agent: { agentId: "agent-1", profileId: "profile-1", assignmentId: "assignment-1",
      displayName: "Build Agent", globalResponsibility: "Build engineering", roomResponsibility: "Own releases",
      participation: "on-mention", availability: "ready", effectiveCapabilities: ["room.conversation.read", "room.respond"],
      effectiveTools: ["repository.git-status", "room-memory.read"], revisions: { profile: 2, assignment: 3, access: 4 } },
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
        { targetId: "target-human-2", targetKind: "human-request", targetActorId: "human-2", range: { startUtf16: 13, endUtf16: 20 } },
        { targetId: "target-agent-1", targetKind: "agent-invocation", targetActorId: "agent-1", range: { startUtf16: 0, endUtf16: 12 } },
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
      { source: source("trigger", 9), body: "@Build Agent summarize the release.\r\nInclude citations.", availability: "readable",
        author: { actorId: "human-1", kind: "human", displayName: "Leo" }, occurredAt,
        replyTo: { sourceId: "message-0", revision: 2 },
        mentions: [
          { targetId: "target-human-2", targetKind: "human-request", targetActorId: "human-2", range: { startUtf16: 13, endUtf16: 20 } },
          { targetId: "target-agent-1", targetKind: "agent-invocation", targetActorId: "agent-1", range: { startUtf16: 0, endUtf16: 12 } },
        ], readRef: "read:trigger" },
      candidate("delta-8", 8, "The canary is green."),
      candidate("delta-6", 6, "Tests passed."),
    ],
    retrieval: [candidate("retrieved-1", 1, "An older decision remains relevant.")],
    attachments: [candidate("attachment-1", 7, "Extracted release checklist.", { source: source("attachment-1", 7, "attachment_extraction"), segment: { index: 0, count: 2, startByte: 0, endByte: 28 } })],
    project: { availability: "disabled", reason: "ft09_not_delivered" },
    tools: [
      { id: "room-memory.read", description: "Last", effect: "read-only", inputSchemaCanonical: "{}" },
      { id: "repository.git-status", description: "First", effect: "read-only", inputSchemaCanonical: "{}" },
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
      "trigger", "memory", "memory", "delta", "delta", "retrieval", "attachment",
    ]);
    expect(first.envelope.groupContent.filter((item) => item.section === "memory").map((item) => item.memoryKind)).toEqual(["goal", "decision"]);
    expect(first.envelope.groupContent[0]?.mentions.map((mention) => mention.targetActorId)).toEqual(["agent-1", "human-2"]);
    expect(first.envelope.groupContent[0]?.replyTo).toEqual({ sourceId: "message-0", revision: 2 });
    expect(first.envelope.availableTools.map((tool) => tool.id)).toEqual([
      "repository.git-status", "room-memory.read",
    ]);
    expect(first.envelope.projectContext).toEqual({ availability: "disabled", reason: "ft09_not_delivered" });
    expect(first.manifest.items.map((item) => item.citationLabel)).toEqual([
      "ctx-0001", "ctx-0002", "ctx-0003", "ctx-0004", "ctx-0005", "ctx-0006", "ctx-0007",
    ]);
    expect(first.manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.envelopeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.envelopeSha256).toBe("01af78b315eef321806bb03820b77d1a413437640f004996d134d920b331accc");
    expect(first.manifestSha256).toBe("cd44fe4da1b2a2c7f79abaf7bc2822d6e113d25a2b39b106fc460ac072975a95");
    expect(first.envelope.trusted.developer.agent).toMatchObject({
      profileId: "profile-1",
      assignmentId: "assignment-1",
      globalResponsibility: "Build engineering",
      roomResponsibility: "Own releases",
      participation: "on-mention",
      availability: "ready",
      revisions: { profile: 2, assignment: 3, access: 4 },
    });
    expect(first.envelope.trusted.developer.room.goal).toEqual({ availability: "unavailable", reason: "ft09_not_delivered" });
    expect(first.envelope.trusted.developer.triggerType).toBe("message");
    expect(isContextCompileResultV1(first)).toBe(true);
    expect(verifyContextCompileResultV1(first)).toBe(true);
    expect(isContextCompileResultV1({ ...first, manifestSha256: "0".repeat(64), covert: true })).toBe(false);
    expect(first.canonicalEnvelope).not.toContain("visibleConversation");
  });

  it("rejects cross-field, canonical-byte, and cryptographic tampering at the correct boundary", () => {
    const result = compileContextV1(makeInput(), CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const divergentIntentEnvelope = {
      ...result.envelope,
      trusted: { ...result.envelope.trusted, developer: { ...result.envelope.trusted.developer,
        invocationIntent: { kind: "structured_help", sourceMessageId: "trigger", targetAgentId: "agent-1",
          reasonCode: "structured_help", reasonText: "forged" } } },
    };
    expect(isCompiledContextEnvelopeV1(divergentIntentEnvelope)).toBe(false);

    const divergentAccountingEnvelope = {
      ...result.envelope,
      manifest: { ...result.envelope.manifest, accounting: { ...result.envelope.manifest.accounting,
        inputTokens: result.envelope.manifest.accounting.inputTokens + 1,
        envelopeBytes: result.envelope.manifest.accounting.envelopeBytes + 1,
        totalTokens: result.envelope.manifest.accounting.totalTokens + 1 } },
    };
    expect(isCompiledContextEnvelopeV1(divergentAccountingEnvelope)).toBe(false);

    const forgedGroupEnvelope = { ...result.envelope, groupContent: result.envelope.groupContent.map((item, index) => index === 0
      ? { ...item, citationLabel: result.envelope.groupContent[1]!.citationLabel }
      : item) };
    expect(isCompiledContextEnvelopeV1(forgedGroupEnvelope)).toBe(false);

    const nonCanonicalBytes = { ...result, canonicalEnvelope: ` ${result.canonicalEnvelope}` };
    expect(isContextCompileResultV1(nonCanonicalBytes)).toBe(true);
    expect(verifyContextCompileResultV1(nonCanonicalBytes)).toBe(false);
    const forgedSha = { ...result, envelopeSha256: "0".repeat(64) };
    expect(isContextCompileResultV1(forgedSha)).toBe(true);
    expect(verifyContextCompileResultV1(forgedSha)).toBe(false);

    const replaceRepresentation = (text: string) => ({
      ...result.envelope,
      groupContent: result.envelope.groupContent.map((item, index) => index === 0
        ? { ...item, representation: { ...item.representation, text } }
        : item),
    });
    const rehashEnvelope = (envelope: typeof result.envelope) => {
      const canonicalEnvelope = canonicalJsonV1(envelope);
      return { ...result, envelope, canonicalEnvelope, envelopeSha256: sha256HexV1(canonicalEnvelope) };
    };
    const originalText = result.envelope.groupContent[0]!.representation.text;
    const sameSizeForgery = rehashEnvelope(replaceRepresentation(originalText.replace(/[A-Za-z]/g, "x")));
    expect(isContextCompileResultV1(sameSizeForgery)).toBe(true);
    expect(verifyContextCompileResultV1(sameSizeForgery)).toBe(false);
    const staleAccountingForgery = rehashEnvelope(replaceRepresentation(`${originalText} forged`));
    expect(isContextCompileResultV1(staleAccountingForgery)).toBe(true);
    expect(verifyContextCompileResultV1(staleAccountingForgery)).toBe(false);
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

  it("round-trips routed invocation authority without rebuilding a direct mention", () => {
    const input = makeInput();
    input.invocation.intent = { kind: "routed_candidate", sourceMessageId: "trigger", targetAgentId: "agent-1", reasonCode: "risk_detected", reasonText: "migration is risky" };
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.invocation.intent).toEqual(input.invocation.intent);
    expect(result.envelope.trusted.developer.invocationIntent).toEqual(input.invocation.intent);
  });

  it("deduplicates one stable source identity so its body appears in only the highest-priority section", () => {
    const input = makeInput();
    input.retrieval = [{ ...input.delta.find((entry) => entry.source.sourceId === "delta-6")! }];
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.items.filter((item) => item.source.sourceId === "delta-6")).toHaveLength(1);
    expect(result.canonicalEnvelope.match(/Tests passed\./g)).toHaveLength(1);
  });

  it("rejects conflicting and normalization-colliding source, memory, and tool identities", () => {
    const corpusCollision = makeInput();
    corpusCollision.attachments = [...corpusCollision.attachments,
      candidate("attachment-collision", 6, "different corpus source", {
        source: source("attachment-collision", 6, "attachment_extraction"),
      })];
    expect(compileContextV1(corpusCollision, CONTEXT_COMPILER_CONFIG_V1)).toMatchObject({
      ok: false, error: { code: "invalid_input" },
    });

    const sourceConflict = makeInput();
    sourceConflict.retrieval = [candidate("delta-6", 6, "conflicting body")];
    expect(compileContextV1(sourceConflict, CONTEXT_COMPILER_CONFIG_V1)).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const newlineCollision = makeInput();
    newlineCollision.retrieval = [{ ...newlineCollision.delta.find((entry) => entry.source.sourceId === "delta-6")!, body: "Tests passed.\r\n" }];
    newlineCollision.delta = newlineCollision.delta.map((entry) => entry.source.sourceId === "delta-6" ? { ...entry, body: "Tests passed.\n" } : entry);
    expect(compileContextV1(newlineCollision, CONTEXT_COMPILER_CONFIG_V1)).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const memoryConflict = makeInput();
    memoryConflict.memories = [...memoryConflict.memories, { ...memoryConflict.memories[0]!, body: "different" }];
    expect(compileContextV1(memoryConflict, CONTEXT_COMPILER_CONFIG_V1)).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const toolConflict = makeInput();
    toolConflict.tools = [...toolConflict.tools, { ...toolConflict.tools[0]!, description: "different" }];
    expect(compileContextV1(toolConflict, CONTEXT_COMPILER_CONFIG_V1)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("deduplicates canonically identical memory, attachment, and tool identities", () => {
    const input = makeInput();
    input.memories = [...input.memories, { ...input.memories[0]!, sourceRefs: [...input.memories[0]!.sourceRefs].reverse() }];
    input.attachments = [...input.attachments, { ...input.attachments[0]! }];
    input.tools = [...input.tools, { ...input.tools[0]! }];
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.items.filter((item) => item.source?.sourceId === "mv-b")).toHaveLength(1);
    expect(result.manifest.items.filter((item) => item.source?.sourceId === "attachment-1")).toHaveLength(1);
    expect(result.envelope.availableTools.filter((tool) => tool.id === "room-memory.read")).toHaveLength(1);
  });

  it("uses immutable memory version identities and keeps same-record versions distinct", () => {
    const input = makeInput();
    input.memories = [
      {
        kind: "decision",
        memoryRecordId: "memory-stable",
        memoryVersionId: "memory-version-2",
        version: 2,
        body: "Current decision",
        sourceRefs: [source("old-source", 3)],
        availability: "readable",
      },
      {
        kind: "decision",
        memoryRecordId: "memory-stable",
        memoryVersionId: "memory-version-1",
        version: 1,
        body: "Superseded decision",
        sourceRefs: [source("older-source", 2)],
        availability: "invalidated",
      },
    ];
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const memoryItems = result.manifest.items.filter((item) => item.section === "memory");
    expect(memoryItems.map((item) => item.source?.sourceId)).toEqual(["memory-version-1", "memory-version-2"]);
    expect(memoryItems.map((item) => item.memoryKind)).toEqual(["decision", "decision"]);
    expect(memoryItems[0]).toMatchObject({ disposition: "invalidated", citationLabel: null });
    expect(result.envelope.groupContent.filter((item) => item.section === "memory").map((item) => item.source.sourceId))
      .toEqual(["memory-version-2"]);
  });

  it("records every closed disposition and never disguises unavailable or invalidated sources", () => {
    const input = makeInput();
    input.attachments = [];
    input.delta = [
      candidate("gone", 6, "", { body: null, availability: "temporarily_unavailable" }),
      candidate("recalled", 7, "", { body: null, availability: "invalidated" }),
      candidate("tombstone", 8, "", { body: null, availability: "tombstone", source: source("tombstone", 8, "message_tombstone") }),
      { ...input.delta.find((entry) => entry.source.sourceId === "trigger")! },
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
    input.delta = input.delta.map((entry) => entry.source.sourceId === "trigger"
      ? { ...entry, body: input.trigger.body, mentions: [] }
      : entry);
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
    input.attachments = [candidate("large-attachment", 2, "a".repeat(30_000), {
      source: source("large-attachment", 7, "attachment_extraction"),
    })];
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
    expect(result.envelope.accounting.inputTokens).toBe(Buffer.byteLength(result.canonicalEnvelope, "utf8"));
    expect(result.envelope.accounting.totalTokens).toBe(
      result.envelope.accounting.inputTokens
        + CONTEXT_COMPILER_CONFIG_V1.outputReserveTokens
        + CONTEXT_COMPILER_CONFIG_V1.toolSchemaBudgetTokens,
    );
    expect(Object.values(result.envelope.accounting.sectionTokens).reduce((sum, tokens) => sum + tokens, 0))
      .toBe(result.envelope.accounting.inputTokens);
  });

  it("enforces the configured single-segment token/byte caps and validates pre-segmented bodies", () => {
    const input = makeInput();
    input.retrieval = [candidate("huge-segment", 1, "🙂".repeat(4_000))];
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const represented = result.envelope.groupContent.find((item) => item.source.sourceId === "huge-segment")!;
    expect(utf8ByteLength(represented.representation.text)).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.singleSegmentBytes);
    expect(estimateStructuredTokensV1(represented.representation.text, "content")).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.singleSegmentTokens);

    const invalid = makeInput();
    invalid.attachments = [candidate("bad-segment", 2, "abc", {
      source: source("bad-segment", 2, "attachment_extraction"),
      segment: { index: 0, count: 1, startByte: 0, endByte: 2 },
    })];
    expect(compileContextV1(invalid, CONTEXT_COMPILER_CONFIG_V1)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("budgets available project authority and emits manifest-backed citations with source refs", () => {
    const input = makeInput();
    input.project = {
      availability: "available",
      projectId: "project-1",
      revision: 3,
      goals: ["Ship safely"],
      decisions: ["Two reviewers"],
      nextActions: ["Deploy canary"],
      blockers: ["None"],
      balls: ["agent-1"],
      due: ["2026-08-22"],
      criteria: ["All checks green"],
      sourceRefs: [source("project-checkpoint", 5, "project_fact_checkpoint")],
    };
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.projectContext).toMatchObject({ availability: "available", projectId: "project-1", revision: 3 });
    expect(result.envelope.projectContext.citationLabel).toMatch(/^ctx-/);
    expect(result.envelope.projectContext.sourceRefs).toEqual(input.project.sourceRefs);
    expect(result.manifest.items.some((item) => item.section === "project" && item.citationLabel === result.envelope.projectContext.citationLabel)).toBe(true);
  });

  it("aggregates a large complete delta tail into one deterministic source-index range", () => {
    const input = makeInput();
    input.memoryWatermark = 0;
    input.corpusHead = 512;
    input.memories = [];
    input.attachments = [];
    input.trigger.source = source("bulk-512", 512);
    input.delta = Array.from({ length: 512 }, (_, index) => candidate(
      `bulk-${index + 1}`,
      index + 1,
      `delta-${index + 1}:${"x".repeat(512)}`,
    ));
    const triggerCandidate = input.delta[511]!;
    input.trigger.body = triggerCandidate.body!;
    input.trigger.author = triggerCandidate.author!;
    input.trigger.occurredAt = triggerCandidate.occurredAt;
    input.trigger.replyTo = triggerCandidate.replyTo;
    input.trigger.mentions = triggerCandidate.mentions;
    input.trigger.readRef = triggerCandidate.readRef;
    input.invocation.intent = { ...input.invocation.intent, sourceMessageId: "bulk-512" };
    const result = compileContextV1(input, CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ranges = result.manifest.items.filter((item) => item.source === null);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ section: "delta", disposition: "index_only", toCorpusSeq: 511 });
    expect(ranges[0]?.fromCorpusSeq).toBeGreaterThan(6);
    expect(ranges[0]?.citationLabel).toMatch(/^ctx-/);
    expect(ranges[0]?.readRef).toMatch(/^delta-range:/);
    expect(ranges[0]?.sourceIndexHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isContextCompileResultV1(result)).toBe(true);
    expect(result.envelope.accounting.sectionTokens.manifest).toBe(Buffer.byteLength(result.canonicalManifest, "utf8"));
    expect(Object.values(result.envelope.accounting.sectionTokens).reduce((sum, tokens) => sum + tokens, 0))
      .toBe(result.envelope.accounting.inputTokens);
    expect(Buffer.byteLength(result.canonicalManifest, "utf8")).toBeLessThanOrEqual(CONTEXT_COMPILER_CONFIG_V1.manifestBytes);
  });
});
