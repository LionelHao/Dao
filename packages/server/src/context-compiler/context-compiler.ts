import {
  CONTEXT_COMPILER_CONFIG_VERSION,
  CONTEXT_COMPILER_LIMITS,
  CONTEXT_COMPILER_VERSION,
  CONTEXT_TOKEN_ESTIMATOR_VERSION,
  isContextCompilerConfigV1,
  isContextCompilerInputV1,
  type CompiledContextEnvelopeV1,
  type CompiledContextGroupItemV1,
  type ContextAccountingV1,
  type ContextCompileResultV1,
  type ContextCompilerConfigV1,
  type ContextCompilerInputV1,
  type ContextManifestDispositionV1,
  type ContextManifestEntryV1,
  type ContextManifestItemV1,
  type ContextManifestRangeV1,
  type ContextManifestReasonV1,
  type ContextManifestSectionV1,
  type ContextManifestV1,
  type ContextMemoryCandidateV1,
  type ContextSegmentV1,
  type ContextSourceAvailabilityV1,
  type ContextSourceCandidateV1,
  type ContextSourceIdentityV1,
} from "@native-im/core";
import { canonicalJsonV1, compareUtf8, sha256HexV1 } from "./canonical-json.js";
import { STRUCTURAL_OVERHEAD_V1, estimateStructuredTokensV1, utf8ByteLength } from "./token-estimator.js";

export const CONTEXT_COMPILER_CONFIG_V1: ContextCompilerConfigV1 = Object.freeze({
  version: CONTEXT_COMPILER_CONFIG_VERSION,
  configVersion: "ft06_production_v1",
  modelId: "server-selected",
  estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
  ...CONTEXT_COMPILER_LIMITS,
});

const MEMORY_ORDER = ["goal", "decision", "context", "next_action", "open_question_or_blocker"] as const;
const SECTION_ORDER: Record<Exclude<ContextManifestSectionV1, "project">, number> = {
  trigger: 0,
  memory: 1,
  delta: 2,
  retrieval: 3,
  attachment: 4,
};

type WorkItem = {
  section: Exclude<ContextManifestSectionV1, "project">;
  source: ContextSourceIdentityV1;
  body: string | null;
  availability: ContextSourceAvailabilityV1;
  author: ContextSourceCandidateV1["author"];
  occurredAt: string | null;
  replyTo: ContextSourceCandidateV1["replyTo"];
  mentions: ContextSourceCandidateV1["mentions"];
  readRef: string;
  segment: ContextSegmentV1 | null;
  sourceRefs: readonly ContextSourceIdentityV1[];
  canonicalOrder: string;
};

type Selection = {
  disposition: ContextManifestDispositionV1;
  reason: ContextManifestReasonV1;
  representation: CompiledContextGroupItemV1["representation"] | null;
  originalBytes: number;
  includedBytes: number;
  originalTokens: number;
  includedTokens: number;
  contentHash: string | null;
  range: ContextManifestItemV1["range"];
};

function normalize(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function sourceKey(source: ContextSourceIdentityV1): string {
  return `${source.roomId}\u0000${source.sourceKind}\u0000${source.sourceId}\u0000${source.revision}`;
}

function compareSource(left: ContextSourceIdentityV1, right: ContextSourceIdentityV1): number {
  const leftSeq = left.corpusSeq ?? Number.MAX_SAFE_INTEGER;
  const rightSeq = right.corpusSeq ?? Number.MAX_SAFE_INTEGER;
  return leftSeq - rightSeq || compareUtf8(left.sourceKind, right.sourceKind)
    || compareUtf8(left.sourceId, right.sourceId) || left.revision - right.revision;
}

function compareMentions(
  left: ContextSourceCandidateV1["mentions"][number],
  right: ContextSourceCandidateV1["mentions"][number],
): number {
  return left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16
    || compareUtf8(left.targetKind, right.targetKind) || compareUtf8(left.targetId, right.targetId);
}

function normalizeSource(source: ContextSourceIdentityV1): ContextSourceIdentityV1 {
  return { ...source, roomId: normalize(source.roomId), sourceId: normalize(source.sourceId) };
}

function normalizeCandidate(candidate: ContextSourceCandidateV1, section: WorkItem["section"]): WorkItem {
  const source = normalizeSource(candidate.source);
  return {
    section,
    source,
    body: candidate.body === null ? null : normalize(candidate.body),
    availability: candidate.availability,
    author: candidate.author === null ? null : {
      ...candidate.author,
      actorId: normalize(candidate.author.actorId),
      displayName: normalize(candidate.author.displayName),
    },
    occurredAt: candidate.occurredAt,
    replyTo: candidate.replyTo === null ? null : { sourceId: normalize(candidate.replyTo.sourceId), revision: candidate.replyTo.revision },
    mentions: [...candidate.mentions].map((mention) => ({ ...mention, targetId: normalize(mention.targetId) })).sort(compareMentions),
    readRef: normalize(candidate.readRef),
    segment: candidate.segment ?? null,
    sourceRefs: [],
    canonicalOrder: `${String(source.corpusSeq ?? Number.MAX_SAFE_INTEGER).padStart(16, "0")}:${source.sourceKind}:${source.sourceId}:${String(source.revision).padStart(8, "0")}`,
  };
}

function normalizeMemory(memory: ContextMemoryCandidateV1, roomId: string): WorkItem {
  const source: ContextSourceIdentityV1 = {
    roomId,
    sourceKind: "memory",
    sourceId: normalize(memory.memoryRecordId),
    revision: memory.version,
    corpusSeq: null,
  };
  return {
    section: "memory",
    source,
    body: normalize(memory.body),
    availability: memory.availability === "readable" ? "readable" : memory.availability === "invalidated" ? "invalidated" : "temporarily_unavailable",
    author: null,
    occurredAt: null,
    replyTo: null,
    mentions: [],
    readRef: `memory:${normalize(memory.memoryVersionId)}`,
    segment: null,
    sourceRefs: [...memory.sourceRefs].map(normalizeSource).sort(compareSource),
    canonicalOrder: `${String(MEMORY_ORDER.indexOf(memory.kind)).padStart(2, "0")}:${normalize(memory.memoryRecordId)}:${String(memory.version).padStart(8, "0")}`,
  };
}

function asCandidate(input: ContextCompilerInputV1["trigger"]): ContextSourceCandidateV1 {
  return {
    source: input.source,
    body: input.body,
    availability: "readable",
    author: input.author,
    occurredAt: input.occurredAt,
    replyTo: input.replyTo,
    mentions: input.mentions,
    readRef: input.readRef,
  };
}

function digestText(item: WorkItem, bytes: number, hash: string, body: string): string {
  const scalars = Array.from(body);
  const head = scalars.slice(0, 48).join("");
  const tail = scalars.slice(Math.max(48, scalars.length - 48)).join("");
  return `[digest source=${item.source.sourceKind}:${item.source.sourceId}@${item.source.revision} bytes=${bytes} sha256=${hash} head=${JSON.stringify(head)} tail=${JSON.stringify(tail)} read=${item.readRef}]`;
}

function indexText(item: WorkItem, bytes: number, hash: string | null): string {
  return `[index source=${item.source.sourceKind}:${item.source.sourceId}@${item.source.revision} bytes=${bytes} sha256=${hash ?? "none"} read=${item.readRef}]`;
}

function excerptText(body: string, maximumBytes: number): string | null {
  const marker = "\n…[deterministic excerpt]…\n";
  const markerBytes = utf8ByteLength(marker);
  if (maximumBytes <= markerBytes + 2) return null;
  const budget = maximumBytes - markerBytes;
  const scalars = Array.from(body);
  let head = "";
  let tail = "";
  let used = 0;
  let headIndex = 0;
  let tailIndex = scalars.length - 1;
  while (headIndex <= tailIndex) {
    const fromHead = used % 2 === 0;
    const scalar = fromHead ? scalars[headIndex]! : scalars[tailIndex]!;
    const bytes = utf8ByteLength(scalar);
    if (used + bytes > budget) break;
    if (fromHead) {
      head += scalar;
      headIndex += 1;
    } else {
      tail = scalar + tail;
      tailIndex -= 1;
    }
    used += bytes;
  }
  if (headIndex > tailIndex) return body;
  return `${head}${marker}${tail}`;
}

function unavailableSelection(item: WorkItem): Selection | null {
  if (item.availability === "invalidated") {
    return { disposition: "invalidated", reason: "source_invalidated", representation: null, originalBytes: 0, includedBytes: 0, originalTokens: 0, includedTokens: 0, contentHash: null, range: null };
  }
  if (item.availability === "temporarily_unavailable") {
    return { disposition: "unavailable", reason: "source_unavailable", representation: null, originalBytes: 0, includedBytes: 0, originalTokens: 0, includedTokens: 0, contentHash: null, range: null };
  }
  return null;
}

function select(item: WorkItem, tokenBudget: number, byteBudget: number): Selection {
  const unavailable = unavailableSelection(item);
  if (unavailable !== null) return unavailable;
  const body = item.body ?? "";
  const originalBytes = utf8ByteLength(body);
  const originalTokens = estimateStructuredTokensV1(body, "content");
  const hash = item.body === null ? null : sha256HexV1(body);
  const limitedTokens = Math.max(0, tokenBudget);
  const limitedBytes = Math.max(0, byteBudget);
  if (item.availability === "metadata_only" || item.availability === "tombstone" || item.body === null) {
    const value = indexText(item, originalBytes, hash);
    const tokens = estimateStructuredTokensV1(value, "content");
    const bytes = utf8ByteLength(value);
    if (tokens <= limitedTokens && bytes <= limitedBytes) {
      return { disposition: "index_only", reason: item.availability === "tombstone" ? "source_tombstone" : "metadata_only", representation: { kind: "index", text: value }, originalBytes, includedBytes: bytes, originalTokens, includedTokens: tokens, contentHash: hash, range: null };
    }
    return { disposition: "omitted", reason: "section_budget", representation: null, originalBytes, includedBytes: 0, originalTokens, includedTokens: 0, contentHash: hash, range: null };
  }
  if (originalTokens <= limitedTokens && originalBytes <= limitedBytes) {
    const segmented = item.segment !== null;
    return { disposition: segmented ? "segmented" : "included", reason: segmented ? "presegmented" : "within_budget", representation: { kind: segmented ? "segment" : "content", text: body }, originalBytes, includedBytes: originalBytes, originalTokens, includedTokens: originalTokens, contentHash: hash, range: segmented ? { startByte: item.segment!.startByte, endByte: item.segment!.endByte } : { startByte: 0, endByte: originalBytes } };
  }
  const excerptBytes = Math.min(limitedBytes, Math.max(0, limitedTokens - 32));
  const excerpt = excerptText(body, excerptBytes);
  if (excerpt !== null && excerpt !== body) {
    const tokens = estimateStructuredTokensV1(excerpt, "content");
    const bytes = utf8ByteLength(excerpt);
    if (tokens <= limitedTokens && bytes <= limitedBytes) {
      return { disposition: "excerpted", reason: originalBytes > limitedBytes ? "byte_budget" : "section_budget", representation: { kind: "excerpt", text: excerpt }, originalBytes, includedBytes: bytes, originalTokens, includedTokens: tokens, contentHash: hash, range: null };
    }
  }
  const digest = digestText(item, originalBytes, hash!, body);
  const digestTokens = estimateStructuredTokensV1(digest, "content");
  if (digestTokens <= limitedTokens && utf8ByteLength(digest) <= limitedBytes) {
    return { disposition: "digested", reason: "section_budget", representation: { kind: "digest", text: digest }, originalBytes, includedBytes: utf8ByteLength(digest), originalTokens, includedTokens: digestTokens, contentHash: hash, range: null };
  }
  const index = indexText(item, originalBytes, hash);
  const indexTokens = estimateStructuredTokensV1(index, "content");
  if (indexTokens <= limitedTokens && utf8ByteLength(index) <= limitedBytes) {
    return { disposition: "index_only", reason: "section_budget", representation: { kind: "index", text: index }, originalBytes, includedBytes: utf8ByteLength(index), originalTokens, includedTokens: indexTokens, contentHash: hash, range: null };
  }
  return { disposition: "omitted", reason: "section_budget", representation: null, originalBytes, includedBytes: 0, originalTokens, includedTokens: 0, contentHash: hash, range: null };
}

function invalid(code: "invalid_input" | "invalid_config", message: string): ContextCompileResultV1 {
  return { ok: false, error: { code, message, sourceLabel: null, recovery: code === "invalid_input" ? "fix_authority_input" : "fix_server_config" } };
}

function tooLarge(sourceLabel: string | null = null): ContextCompileResultV1 {
  return {
    ok: false,
    error: {
      code: "content_too_large",
      message: sourceLabel === null
        ? "Required authority metadata cannot fit the configured context envelope."
        : "The required trigger identity cannot fit the configured context envelope.",
      sourceLabel,
      recovery: sourceLabel === null ? "reduce_required_authority_metadata" : "reduce_required_trigger_metadata",
    },
  };
}

function manifestWithHash(base: Omit<ContextManifestV1, "manifestHash">): { manifest: ContextManifestV1; canonical: string } {
  const canonicalForHash = canonicalJsonV1(base);
  const manifest: ContextManifestV1 = { ...base, manifestHash: sha256HexV1(canonicalForHash) };
  return { manifest, canonical: canonicalJsonV1(manifest) };
}

function compactDeltaRanges(
  sourceItems: readonly ContextManifestItemV1[],
  sourceGroups: readonly CompiledContextGroupItemV1[],
): { items: ContextManifestEntryV1[]; groups: CompiledContextGroupItemV1[] } {
  const compacted: ContextManifestEntryV1[] = [];
  for (let index = 0; index < sourceItems.length;) {
    const first = sourceItems[index]!;
    if (first.section === "delta" && first.disposition === "omitted" && first.source.corpusSeq !== null) {
      const rangeItems = [first];
      let cursor = index + 1;
      while (cursor < sourceItems.length) {
        const next = sourceItems[cursor]!;
        const previousSeq = rangeItems[rangeItems.length - 1]!.source.corpusSeq!;
        if (next.section !== "delta" || next.disposition !== "omitted" || next.source.corpusSeq !== previousSeq + 1) break;
        rangeItems.push(next);
        cursor += 1;
      }
      if (rangeItems.length >= 2) {
        const fromCorpusSeq = first.source.corpusSeq;
        const toCorpusSeq = rangeItems[rangeItems.length - 1]!.source.corpusSeq!;
        const range: ContextManifestRangeV1 = {
          ordinal: 0,
          section: "delta",
          disposition: "omitted",
          source: null,
          canonicalOrder: `${SECTION_ORDER.delta}:${String(fromCorpusSeq).padStart(16, "0")}:${String(toCorpusSeq).padStart(16, "0")}`,
          fromCorpusSeq,
          toCorpusSeq,
          count: rangeItems.length,
          originalBytes: rangeItems.reduce((total, item) => total + item.originalBytes, 0),
          includedBytes: 0,
          originalTokens: rangeItems.reduce((total, item) => total + item.originalTokens, 0),
          includedTokens: 0,
          reason: "section_budget",
          citationLabel: null,
          sourceIndexHash: sha256HexV1(canonicalJsonV1(rangeItems.map((item) => item.source))),
        };
        compacted.push(range);
        index = cursor;
        continue;
      }
    }
    compacted.push(first);
    index += 1;
  }
  const labelMap = new Map<string, string>();
  const items = compacted.map((item, index) => {
    const ordinal = index + 1;
    if (item.source === null) return { ...item, ordinal };
    const citationLabel = item.citationLabel === null ? null : `ctx-${String(ordinal).padStart(4, "0")}`;
    if (item.citationLabel !== null) labelMap.set(item.citationLabel, citationLabel!);
    return { ...item, ordinal, citationLabel };
  });
  const groups = sourceGroups.map((group) => ({ ...group, citationLabel: labelMap.get(group.citationLabel) ?? group.citationLabel }));
  return { items, groups };
}

export function compileContextV1(inputValue: ContextCompilerInputV1, configValue: ContextCompilerConfigV1): ContextCompileResultV1 {
  if (!isContextCompilerInputV1(inputValue)) return invalid("invalid_input", "Context compiler input is not an exact V1 authority value.");
  if (!isContextCompilerConfigV1(configValue)) return invalid("invalid_config", "Context compiler config is not an exact deterministic V1 value.");

  const input = inputValue;
  const config = configValue;
  const trigger = normalizeCandidate(asCandidate(input.trigger), "trigger");
  const memories = input.memories.map((entry) => ({ entry, item: normalizeMemory(entry, input.invocation.roomId) }))
    .sort((left, right) => MEMORY_ORDER.indexOf(left.entry.kind) - MEMORY_ORDER.indexOf(right.entry.kind)
      || compareUtf8(left.entry.memoryRecordId, right.entry.memoryRecordId) || left.entry.version - right.entry.version)
    .map(({ item }) => item);
  const delta = input.delta.map((entry) => normalizeCandidate(entry, "delta")).sort((left, right) => compareSource(left.source, right.source));
  const retrieval = input.retrieval.map((entry) => normalizeCandidate(entry, "retrieval")).sort((left, right) => compareSource(left.source, right.source));
  const attachments = input.attachments.map((entry) => normalizeCandidate(entry, "attachment")).sort((left, right) => compareSource(left.source, right.source));
  const deduplicated: WorkItem[] = [];
  const seen = new Set<string>();
  for (const item of [trigger, ...memories, ...delta, ...retrieval, ...attachments]) {
    const key = sourceKey(item.source);
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(item);
  }

  const tools = [...input.tools].map((tool) => ({ ...tool, id: normalize(tool.id), description: normalize(tool.description), inputSchemaCanonical: normalize(tool.inputSchemaCanonical) }))
    .sort((left, right) => compareUtf8(left.id, right.id));
  for (const tool of tools) {
    try {
      if (canonicalJsonV1(JSON.parse(tool.inputSchemaCanonical)) !== tool.inputSchemaCanonical) {
        return invalid("invalid_input", `Tool ${tool.id} does not have a canonical input schema.`);
      }
    } catch {
      return invalid("invalid_input", `Tool ${tool.id} does not have a canonical input schema.`);
    }
  }
  const toolText = canonicalJsonV1(tools);
  const toolTokens = tools.reduce((total, tool) => total + estimateStructuredTokensV1(`${tool.id}\n${tool.description}\n${tool.inputSchemaCanonical}`, "tool"), 0);
  if (toolTokens > config.toolSchemaBudgetTokens || utf8ByteLength(toolText) > config.toolSchemaBytes) return tooLarge();
  const trustedSystem = normalize(input.trusted.system);
  const developerPolicy = normalize(input.trusted.developerPolicy);
  const trustedTokens = estimateStructuredTokensV1(`${trustedSystem}\n${developerPolicy}`, "trusted");
  const trustedBytes = utf8ByteLength(`${trustedSystem}\n${developerPolicy}`);
  if (trustedTokens > config.trustedBudgetTokens || trustedBytes > config.trustedBytes) return tooLarge();
  const identityValue = {
    invocation: input.invocation,
    agent: input.agent,
    room: input.room,
    triggerType: input.trigger.triggerType,
    triggerReason: input.trigger.reason,
    projectAvailability: input.project.availability,
  };
  const identityText = canonicalJsonV1(identityValue);
  const identityTokens = estimateStructuredTokensV1(identityText, "identity");
  if (identityTokens > config.identityBudgetTokens || utf8ByteLength(identityText) > config.identityBytes) return tooLarge();

  const budgets: Record<WorkItem["section"], { tokens: number; bytes: number }> = {
    trigger: { tokens: config.triggerBudgetTokens, bytes: config.triggerBytes },
    memory: { tokens: config.memoryBudgetTokens, bytes: config.memoryBytes },
    delta: { tokens: config.deltaBudgetTokens, bytes: config.deltaBytes },
    retrieval: { tokens: config.retrievalBudgetTokens, bytes: config.retrievalBytes },
    attachment: { tokens: config.attachmentBudgetTokens, bytes: config.attachmentBytes },
  };
  const used = { trigger: 0, memory: 0, delta: 0, retrieval: 0, attachment: 0 };
  const usedBytes = { trigger: 0, memory: 0, delta: 0, retrieval: 0, attachment: 0 };
  let carryTokens = Math.max(0, config.trustedBudgetTokens - trustedTokens) + Math.max(0, config.identityBudgetTokens - identityTokens);
  let groupContent: CompiledContextGroupItemV1[] = [];
  const items: ContextManifestItemV1[] = [];
  const manifestSourceLimit = Math.max(1, Math.min(6, Math.floor(config.manifestBudgetTokens / STRUCTURAL_OVERHEAD_V1.manifest) - 8));
  let ordinal = 0;
  for (const section of ["trigger", "memory", "delta", "retrieval", "attachment"] as const) {
    let availableTokens = budgets[section].tokens + carryTokens;
    let availableBytes = budgets[section].bytes;
    for (const item of deduplicated.filter((entry) => entry.section === section)) {
      ordinal += 1;
      const citationLabel = `ctx-${String(ordinal).padStart(4, "0")}`;
      const selection = section === "delta" && items.length >= manifestSourceLimit
        ? select(item, 0, 0)
        : select(item, availableTokens, availableBytes);
      if (section === "trigger" && selection.disposition === "omitted") return tooLarge("ctx-0001");
      const cited = !["omitted", "unavailable", "invalidated"].includes(selection.disposition);
      const manifestItem: ContextManifestItemV1 = {
        ordinal,
        section,
        disposition: selection.disposition,
        source: item.source,
        canonicalOrder: `${SECTION_ORDER[section]}:${item.canonicalOrder}`,
        originalBytes: selection.originalBytes,
        includedBytes: selection.includedBytes,
        originalTokens: selection.originalTokens,
        includedTokens: selection.includedTokens,
        reason: selection.reason,
        citationLabel: cited ? citationLabel : null,
        contentHash: selection.contentHash,
        segment: item.segment,
        range: selection.range,
        availability: item.availability,
        readRef: cited ? item.readRef : null,
      };
      items.push(manifestItem);
      used[section] += selection.includedTokens;
      usedBytes[section] += selection.includedBytes;
      availableTokens -= selection.includedTokens;
      availableBytes -= selection.includedBytes;
      if (selection.representation !== null && cited) {
        groupContent.push({
          section,
          trust: "untrusted_group_content",
          citationLabel,
          source: item.source,
          representation: selection.representation,
          author: item.author,
          occurredAt: item.occurredAt,
          replyTo: item.replyTo,
          mentions: item.mentions,
          sourceRefs: item.sourceRefs,
        });
      }
    }
    carryTokens = Math.max(0, availableTokens);
  }

  const compacted = compactDeltaRanges(items, groupContent);
  const manifestItems = compacted.items;
  groupContent = compacted.groups;
  const manifestBudgetValue = {
    version: "context_manifest_v1",
    compilerVersion: CONTEXT_COMPILER_VERSION,
    configVersion: config.configVersion,
    modelId: config.modelId,
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    memoryWatermark: input.memoryWatermark,
    corpusHead: input.corpusHead,
    projectAvailability: input.project.availability,
    items: manifestItems,
  };
  const manifestTokens = Math.max(
    STRUCTURAL_OVERHEAD_V1.manifest,
    utf8ByteLength(canonicalJsonV1(manifestBudgetValue)) - config.framingReserveTokens,
  );
  if (manifestTokens > config.manifestBudgetTokens) return tooLarge();
  const sectionTokens = {
    tools: toolTokens,
    trusted: trustedTokens,
    trigger: used.trigger,
    identity: identityTokens,
    memory: used.memory,
    delta: used.delta,
    retrieval: used.retrieval,
    attachment: used.attachment,
    manifest: manifestTokens,
    framing: config.framingReserveTokens,
  };
  const totalTokens = config.outputReserveTokens + Object.values(sectionTokens).reduce((total, value) => total + value, 0);
  if (totalTokens > config.hardLimitTokens) return tooLarge();
  let accounting: ContextAccountingV1 = {
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    configVersion: config.configVersion,
    hardLimitTokens: config.hardLimitTokens,
    totalTokens,
    envelopeBytes: 0,
    outputReserveTokens: config.outputReserveTokens,
    sectionTokens,
  };
  const manifestBase = {
    version: "context_manifest_v1" as const,
    compilerVersion: CONTEXT_COMPILER_VERSION,
    configVersion: config.configVersion,
    modelId: config.modelId,
    estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    memoryWatermark: input.memoryWatermark,
    corpusHead: input.corpusHead,
    deltaRange: { fromExclusive: input.memoryWatermark, toInclusive: input.corpusHead },
    projectAvailability: input.project.availability,
    items: manifestItems,
  };
  const projectContext = input.project.availability === "available"
    ? {
        ...input.project,
        projectId: normalize(input.project.projectId),
        goals: [...input.project.goals].map(normalize).sort(compareUtf8),
        decisions: [...input.project.decisions].map(normalize).sort(compareUtf8),
        nextActions: [...input.project.nextActions].map(normalize).sort(compareUtf8),
        blockers: [...input.project.blockers].map(normalize).sort(compareUtf8),
        balls: [...input.project.balls].map(normalize).sort(compareUtf8),
        due: [...input.project.due].map(normalize).sort(compareUtf8),
        criteria: [...input.project.criteria].map(normalize).sort(compareUtf8),
        sourceRefs: [...input.project.sourceRefs].map(normalizeSource).sort(compareSource),
      }
    : { availability: input.project.availability, reason: normalize(input.project.reason) };
  const degradationNotes = manifestItems.filter((item) => item.disposition !== "included").map((item) => ({
    citationLabel: item.citationLabel,
    section: item.section,
    disposition: item.disposition as Exclude<ContextManifestDispositionV1, "included">,
    reason: item.reason,
  }));
  let finalManifest!: ContextManifestV1;
  let canonicalManifest = "";
  let envelope!: CompiledContextEnvelopeV1;
  let canonicalEnvelope = "";
  for (let pass = 0; pass < 4; pass += 1) {
    ({ manifest: finalManifest, canonical: canonicalManifest } = manifestWithHash({ ...manifestBase, accounting }));
    envelope = {
      version: "compiled_context_envelope_v1",
      compilerVersion: CONTEXT_COMPILER_VERSION,
      invocation: { ...input.invocation },
      trusted: {
        system: trustedSystem,
        developer: {
          policy: developerPolicy,
          agent: {
            agentId: normalize(input.agent.agentId),
            displayName: normalize(input.agent.displayName),
            responsibility: input.agent.responsibility.availability === "available"
              ? { ...input.agent.responsibility, text: normalize(input.agent.responsibility.text) }
              : { ...input.agent.responsibility },
          },
          room: {
            roomId: normalize(input.room.roomId),
            name: normalize(input.room.name),
            goal: input.room.goal.availability === "available"
              ? { ...input.room.goal, text: normalize(input.room.goal.text) }
              : { ...input.room.goal },
          },
          triggerType: input.trigger.triggerType,
          triggerReason: input.trigger.reason,
          citationContract: "manifest_labels_only",
        },
      },
      groupContent,
      projectContext,
      availableTools: tools,
      degradationNotes,
      manifest: finalManifest,
      accounting,
    };
    canonicalEnvelope = canonicalJsonV1(envelope);
    const envelopeBytes = utf8ByteLength(canonicalEnvelope);
    if (accounting.envelopeBytes === envelopeBytes) break;
    accounting = { ...accounting, envelopeBytes };
  }
  if (accounting.envelopeBytes > config.envelopeBytes || utf8ByteLength(canonicalManifest) > config.manifestBytes) return tooLarge();
  return {
    ok: true,
    envelope,
    manifest: finalManifest,
    canonicalEnvelope,
    canonicalManifest,
    envelopeSha256: sha256HexV1(canonicalEnvelope),
    manifestSha256: sha256HexV1(canonicalManifest),
  };
}
