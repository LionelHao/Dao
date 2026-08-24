import {
  CONTEXT_COMPILER_CONFIG_VERSION, CONTEXT_COMPILER_LIMITS, CONTEXT_COMPILER_VERSION,
  CONTEXT_TOKEN_ESTIMATOR_VERSION, isContextCompileResultV1, isContextCompilerConfigV1, isContextCompilerInputV1,
  type CompiledContextEnvelopeV1, type CompiledContextGroupItemV1, type CompiledProjectContextV1,
  type ContextAccountingV1, type ContextCompileResultV1, type ContextCompilerConfigV1,
  type ContextCompilerInputV1, type ContextManifestDispositionV1, type ContextManifestEntryV1,
  type ContextManifestItemV1, type ContextManifestReasonV1,
  type ContextManifestSectionV1, type ContextManifestV1, type ContextMemoryCandidateV1,
  type ContextMemoryKindV1, type ContextSegmentV1, type ContextSourceAvailabilityV1,
  type ContextSourceCandidateV1, type ContextSourceIdentityV1, type ContextToolDescriptorV1,
} from "@native-im/core";
import { canonicalJsonV1, compareUtf8, sha256HexV1 } from "./canonical-json.js";
import { estimateStructuredTokensV1, utf8ByteLength } from "./token-estimator.js";

export const CONTEXT_COMPILER_CONFIG_V1: ContextCompilerConfigV1 = Object.freeze({
  version: CONTEXT_COMPILER_CONFIG_VERSION, configVersion: "ft06_production_v1", modelId: "server-selected",
  estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION, ...CONTEXT_COMPILER_LIMITS,
});

const MEMORY_ORDER = ["goal", "decision", "context", "next_action", "open_question_or_blocker"] as const;
const SECTION_ORDER: Record<ContextManifestSectionV1, number> = {
  trigger: 0, project: 1, memory: 2, delta: 3, retrieval: 4, attachment: 5,
};
const ITEM_STRUCTURE_TOKENS_V1 = 1_024;

type WorkItem = {
  section: ContextManifestSectionV1; source: ContextSourceIdentityV1; body: string | null;
  availability: ContextSourceAvailabilityV1; author: ContextSourceCandidateV1["author"];
  occurredAt: string | null; replyTo: ContextSourceCandidateV1["replyTo"];
  mentions: ContextSourceCandidateV1["mentions"]; readRef: string; segment: ContextSegmentV1 | null;
  sourceRefs: readonly ContextSourceIdentityV1[]; memoryKind: ContextMemoryKindV1 | null;
  canonicalOrder: string; rawCanonical: string; normalizedCanonical: string;
};
type Selection = {
  disposition: ContextManifestDispositionV1; reason: ContextManifestReasonV1;
  representation: CompiledContextGroupItemV1["representation"] | null;
  originalBytes: number; includedBytes: number; originalTokens: number; includedTokens: number;
  contentHash: string | null; range: ContextManifestItemV1["range"];
};

function normalize(value: string): string { return value.replace(/\r\n?/g, "\n"); }
function sourceKey(source: ContextSourceIdentityV1): string {
  return `${source.roomId}\u0000${source.sourceKind}\u0000${source.sourceId}\u0000${source.revision}`;
}
function compareSource(left: ContextSourceIdentityV1, right: ContextSourceIdentityV1): number {
  return (left.corpusSeq ?? Number.MAX_SAFE_INTEGER) - (right.corpusSeq ?? Number.MAX_SAFE_INTEGER)
    || compareUtf8(left.sourceKind, right.sourceKind) || compareUtf8(left.sourceId, right.sourceId)
    || left.revision - right.revision;
}
function compareMentions(left: ContextSourceCandidateV1["mentions"][number], right: ContextSourceCandidateV1["mentions"][number]): number {
  return left.range.startUtf16 - right.range.startUtf16 || left.range.endUtf16 - right.range.endUtf16
    || compareUtf8(left.targetKind, right.targetKind) || compareUtf8(left.targetActorId, right.targetActorId)
    || compareUtf8(left.targetId, right.targetId);
}
function normalizeSource(source: ContextSourceIdentityV1): ContextSourceIdentityV1 {
  return { ...source, roomId: normalize(source.roomId), sourceId: normalize(source.sourceId) };
}
function candidateValue(candidate: ContextSourceCandidateV1): ContextSourceCandidateV1 {
  return {
    source: normalizeSource(candidate.source), body: candidate.body === null ? null : normalize(candidate.body),
    availability: candidate.availability,
    author: candidate.author === null ? null : { ...candidate.author, actorId: normalize(candidate.author.actorId), displayName: normalize(candidate.author.displayName) },
    occurredAt: candidate.occurredAt,
    replyTo: candidate.replyTo === null ? null : { sourceId: normalize(candidate.replyTo.sourceId), revision: candidate.replyTo.revision },
    mentions: [...candidate.mentions].map((mention) => ({ ...mention, targetId: normalize(mention.targetId), targetActorId: normalize(mention.targetActorId) })).sort(compareMentions),
    readRef: normalize(candidate.readRef), ...(candidate.segment === undefined ? {} : { segment: candidate.segment }),
  };
}
function rawCandidateValue(candidate: ContextSourceCandidateV1): ContextSourceCandidateV1 {
  return { ...candidate, mentions: [...candidate.mentions].sort(compareMentions) };
}
function normalizeCandidate(candidate: ContextSourceCandidateV1, section: WorkItem["section"]): WorkItem {
  const normalized = candidateValue(candidate);
  return {
    section, source: normalized.source, body: normalized.body, availability: normalized.availability,
    author: normalized.author, occurredAt: normalized.occurredAt, replyTo: normalized.replyTo,
    mentions: normalized.mentions, readRef: normalized.readRef, segment: normalized.segment ?? null,
    sourceRefs: [], memoryKind: null,
    canonicalOrder: `${String(normalized.source.corpusSeq ?? Number.MAX_SAFE_INTEGER).padStart(16, "0")}:${normalized.source.sourceKind}:${normalized.source.sourceId}:${String(normalized.source.revision).padStart(8, "0")}`,
    rawCanonical: canonicalJsonV1(rawCandidateValue(candidate)), normalizedCanonical: canonicalJsonV1(normalized),
  };
}
function memoryValue(memory: ContextMemoryCandidateV1): ContextMemoryCandidateV1 {
  return { ...memory, memoryRecordId: normalize(memory.memoryRecordId), memoryVersionId: normalize(memory.memoryVersionId),
    body: normalize(memory.body), sourceRefs: [...memory.sourceRefs].map(normalizeSource).sort(compareSource) };
}
function rawMemoryValue(memory: ContextMemoryCandidateV1): ContextMemoryCandidateV1 {
  return { ...memory, sourceRefs: [...memory.sourceRefs].sort(compareSource) };
}
function normalizeIntent(intent: ContextCompilerInputV1["invocation"]["intent"]): ContextCompilerInputV1["invocation"]["intent"] {
  return { ...intent, sourceMessageId: normalize(intent.sourceMessageId), targetAgentId: normalize(intent.targetAgentId),
    reasonText: normalize(intent.reasonText) };
}
function normalizeMemory(memory: ContextMemoryCandidateV1, roomId: string): WorkItem {
  const normalized = memoryValue(memory);
  const source: ContextSourceIdentityV1 = { roomId: normalize(roomId), sourceKind: "memory",
    sourceId: normalized.memoryVersionId, revision: normalized.version, corpusSeq: null };
  return {
    section: "memory", source, body: normalized.body,
    availability: normalized.availability === "readable" ? "readable" : normalized.availability === "invalidated" ? "invalidated" : "temporarily_unavailable",
    author: null, occurredAt: null, replyTo: null, mentions: [], readRef: `memory:${normalized.memoryVersionId}`,
    segment: null, sourceRefs: normalized.sourceRefs, memoryKind: normalized.kind,
    canonicalOrder: `${String(MEMORY_ORDER.indexOf(normalized.kind)).padStart(2, "0")}:${normalized.memoryRecordId}:${String(normalized.version).padStart(8, "0")}`,
    rawCanonical: canonicalJsonV1(rawMemoryValue(memory)), normalizedCanonical: canonicalJsonV1(normalized),
  };
}
function asCandidate(trigger: ContextCompilerInputV1["trigger"]): ContextSourceCandidateV1 {
  return { source: trigger.source, body: trigger.body, availability: "readable", author: trigger.author,
    occurredAt: trigger.occurredAt, replyTo: trigger.replyTo, mentions: trigger.mentions, readRef: trigger.readRef };
}
function normalizeProject(project: Extract<ContextCompilerInputV1["project"], { availability: "available" }>): WorkItem {
  const sourceRefs = [...project.sourceRefs].map(normalizeSource).sort(compareSource);
  const source = sourceRefs[0]!;
  const facts = { goals: [...project.goals].map(normalize).sort(compareUtf8), decisions: [...project.decisions].map(normalize).sort(compareUtf8),
    nextActions: [...project.nextActions].map(normalize).sort(compareUtf8), blockers: [...project.blockers].map(normalize).sort(compareUtf8),
    balls: [...project.balls].map(normalize).sort(compareUtf8), due: [...project.due].map(normalize).sort(compareUtf8),
    criteria: [...project.criteria].map(normalize).sort(compareUtf8) };
  const normalized = { ...project, projectId: normalize(project.projectId), ...facts, sourceRefs };
  const raw = { ...project, goals: [...project.goals].sort(compareUtf8), decisions: [...project.decisions].sort(compareUtf8),
    nextActions: [...project.nextActions].sort(compareUtf8), blockers: [...project.blockers].sort(compareUtf8),
    balls: [...project.balls].sort(compareUtf8), due: [...project.due].sort(compareUtf8),
    criteria: [...project.criteria].sort(compareUtf8), sourceRefs: [...project.sourceRefs].sort(compareSource) };
  return { section: "project", source, body: canonicalJsonV1(facts), availability: "readable", author: null,
    occurredAt: null, replyTo: null, mentions: [], readRef: `project:${normalized.projectId}:${normalized.revision}`,
    segment: null, sourceRefs, memoryKind: null, canonicalOrder: `${normalized.projectId}:${String(normalized.revision).padStart(8, "0")}`,
    rawCanonical: canonicalJsonV1(raw), normalizedCanonical: canonicalJsonV1(normalized) };
}

function deduplicate(items: readonly WorkItem[]): { ok: true; items: WorkItem[] } | { ok: false; message: string } {
  const result: WorkItem[] = [];
  const seen = new Map<string, WorkItem>();
  for (const item of items) {
    const key = sourceKey(item.source);
    const previous = seen.get(key);
    if (previous === undefined) { seen.set(key, item); result.push(item); continue; }
    if (previous.normalizedCanonical !== item.normalizedCanonical) return { ok: false, message: `Conflicting source identity: ${item.source.sourceKind}:${item.source.sourceId}` };
    if (previous.rawCanonical !== item.rawCanonical) return { ok: false, message: `Normalization-colliding source identity: ${item.source.sourceKind}:${item.source.sourceId}` };
  }
  return { ok: true, items: result };
}
function deduplicateTools(tools: readonly ContextToolDescriptorV1[]): { ok: true; tools: ContextToolDescriptorV1[] } | { ok: false; message: string } {
  const seen = new Map<string, { raw: string; normalized: string; tool: ContextToolDescriptorV1 }>();
  for (const tool of tools) {
    const normalizedTool = { ...tool, id: normalize(tool.id), description: normalize(tool.description), inputSchemaCanonical: normalize(tool.inputSchemaCanonical) };
    const current = { raw: canonicalJsonV1(tool), normalized: canonicalJsonV1(normalizedTool), tool: normalizedTool };
    const previous = seen.get(normalizedTool.id);
    if (previous === undefined) seen.set(normalizedTool.id, current);
    else if (previous.normalized !== current.normalized) return { ok: false, message: `Conflicting tool identity: ${normalizedTool.id}` };
    else if (previous.raw !== current.raw) return { ok: false, message: `Normalization-colliding tool identity: ${normalizedTool.id}` };
  }
  return { ok: true, tools: [...seen.values()].map((entry) => entry.tool).sort((left, right) => compareUtf8(left.id, right.id)) };
}

function digestText(item: WorkItem, bytes: number, hash: string, body: string): string {
  const scalars = Array.from(body);
  return `[digest source=${item.source.sourceKind}:${item.source.sourceId}@${item.source.revision} bytes=${bytes} sha256=${hash} head=${JSON.stringify(scalars.slice(0, 48).join(""))} tail=${JSON.stringify(scalars.slice(-48).join(""))} read=${item.readRef}]`;
}
function indexText(item: WorkItem, bytes: number, hash: string | null): string {
  return `[index source=${item.source.sourceKind}:${item.source.sourceId}@${item.source.revision} bytes=${bytes} sha256=${hash ?? "none"} read=${item.readRef}]`;
}
function takePrefix(body: string, maximumBytes: number): string {
  let result = ""; let used = 0;
  for (const scalar of body) { const bytes = utf8ByteLength(scalar); if (used + bytes > maximumBytes) break; result += scalar; used += bytes; }
  return result;
}
function excerptText(body: string, maximumBytes: number): string | null {
  const marker = "\n…[deterministic excerpt]…\n";
  const budget = maximumBytes - utf8ByteLength(marker);
  if (budget < 2) return null;
  const scalars = Array.from(body); let head = ""; let tail = ""; let used = 0; let left = 0; let right = scalars.length - 1;
  let fromHead = true;
  while (left <= right) {
    const scalar = fromHead ? scalars[left]! : scalars[right]!; const bytes = utf8ByteLength(scalar);
    if (used + bytes > budget) break;
    if (fromHead) { head += scalar; left += 1; } else { tail = scalar + tail; right -= 1; }
    used += bytes; fromHead = !fromHead;
  }
  return left > right ? body : `${head}${marker}${tail}`;
}
function fits(text: string, tokenBudget: number, byteBudget: number, config: ContextCompilerConfigV1): boolean {
  return estimateStructuredTokensV1(text, "content") <= Math.min(tokenBudget, config.singleSegmentTokens)
    && utf8ByteLength(text) <= Math.min(byteBudget, config.singleSegmentBytes);
}
function emptySelection(item: WorkItem, disposition: "unavailable" | "invalidated", reason: ContextManifestReasonV1): Selection {
  return { disposition, reason, representation: null, originalBytes: item.body === null ? 0 : utf8ByteLength(item.body), includedBytes: 0,
    originalTokens: item.body === null ? 0 : estimateStructuredTokensV1(item.body, "content"), includedTokens: 0,
    contentHash: item.body === null ? null : sha256HexV1(item.body), range: null };
}
function select(item: WorkItem, tokenBudget: number, byteBudget: number, config: ContextCompilerConfigV1): Selection {
  if (item.availability === "invalidated") return emptySelection(item, "invalidated", "source_invalidated");
  if (item.availability === "temporarily_unavailable") return emptySelection(item, "unavailable", "source_unavailable");
  const body = item.body ?? ""; const originalBytes = utf8ByteLength(body);
  const originalTokens = estimateStructuredTokensV1(body, "content"); const contentHash = item.body === null ? null : sha256HexV1(body);
  const result = (disposition: ContextManifestDispositionV1, reason: ContextManifestReasonV1,
    representation: CompiledContextGroupItemV1["representation"] | null, range: Selection["range"] = null): Selection => {
    const text = representation?.text ?? "";
    return { disposition, reason, representation, originalBytes, includedBytes: utf8ByteLength(text), originalTokens,
      includedTokens: representation === null ? 0 : estimateStructuredTokensV1(text, "content"), contentHash, range };
  };
  if (item.availability === "metadata_only" || item.availability === "tombstone" || item.body === null) {
    const index = indexText(item, originalBytes, contentHash);
    return fits(index, tokenBudget, byteBudget, config)
      ? result("index_only", item.availability === "tombstone" ? "source_tombstone" : "metadata_only", { kind: "index", text: index })
      : result("omitted", "section_budget", null);
  }
  if (fits(body, tokenBudget, byteBudget, config)) {
    const segmented = item.segment !== null;
    return result(segmented ? "segmented" : "included", segmented ? "presegmented" : "within_budget",
      { kind: segmented ? "segment" : "content", text: body }, segmented ? { startByte: item.segment!.startByte, endByte: item.segment!.endByte } : { startByte: 0, endByte: originalBytes });
  }
  const maximumBytes = Math.min(byteBudget, config.singleSegmentBytes, Math.max(0, Math.min(tokenBudget, config.singleSegmentTokens) - 32));
  const excerpt = excerptText(body, maximumBytes);
  if (excerpt !== null && excerpt !== body && fits(excerpt, tokenBudget, byteBudget, config)) return result("excerpted", originalBytes > byteBudget ? "byte_budget" : "section_budget", { kind: "excerpt", text: excerpt });
  const segment = takePrefix(body, maximumBytes);
  if (segment.length > 0 && segment !== body && fits(segment, tokenBudget, byteBudget, config)) return result("segmented", "section_budget", { kind: "segment", text: segment }, { startByte: 0, endByte: utf8ByteLength(segment) });
  const digest = digestText(item, originalBytes, contentHash!, body);
  if (fits(digest, tokenBudget, byteBudget, config)) return result("digested", "section_budget", { kind: "digest", text: digest });
  const index = indexText(item, originalBytes, contentHash);
  if (fits(index, tokenBudget, byteBudget, config)) return result("index_only", "section_budget", { kind: "index", text: index });
  return result("omitted", "section_budget", null);
}

function invalid(code: "invalid_input" | "invalid_config", message: string): ContextCompileResultV1 {
  return { ok: false, error: { code, message, sourceLabel: null, recovery: code === "invalid_input" ? "fix_authority_input" : "fix_server_config" } };
}
function tooLarge(sourceLabel: string | null = null): ContextCompileResultV1 {
  return { ok: false, error: { code: "content_too_large", message: sourceLabel === null ? "Required authority metadata cannot fit the configured context envelope." : "The required trigger identity cannot fit the configured context envelope.",
    sourceLabel, recovery: sourceLabel === null ? "reduce_required_authority_metadata" : "reduce_required_trigger_metadata" } };
}
function manifestWithHash(base: Omit<ContextManifestV1, "manifestHash">): { manifest: ContextManifestV1; canonical: string } {
  const manifest: ContextManifestV1 = { ...base, manifestHash: sha256HexV1(canonicalJsonV1(base)) };
  return { manifest, canonical: canonicalJsonV1(manifest) };
}
function canonicalValuesBytes(values: readonly unknown[]): number {
  return values.reduce<number>((total, value) => total + utf8ByteLength(canonicalJsonV1(value)), 0);
}
function accountEnvelopeSections(
  envelope: CompiledContextEnvelopeV1,
  canonicalManifest: string,
  inputTokens: number,
): ContextAccountingV1["sectionTokens"] {
  const bySection = (section: CompiledContextGroupItemV1["section"]): number => canonicalValuesBytes(
    envelope.groupContent.filter((item) => item.section === section),
  );
  const sections = {
    tools: canonicalValuesBytes(envelope.availableTools),
    trusted: canonicalValuesBytes([envelope.trusted.system, envelope.trusted.developer.policy]),
    trigger: bySection("trigger"),
    identity: canonicalValuesBytes([
      envelope.invocation,
      envelope.trusted.developer.agent,
      envelope.trusted.developer.room,
      envelope.trusted.developer.triggerType,
      envelope.trusted.developer.triggerReason,
      envelope.trusted.developer.invocationIntent,
      envelope.trusted.developer.citationContract,
    ]),
    memory: bySection("memory"),
    delta: bySection("delta"),
    retrieval: bySection("retrieval"),
    attachment: bySection("attachment"),
    project: utf8ByteLength(canonicalJsonV1(envelope.projectContext)),
    manifest: utf8ByteLength(canonicalManifest),
    framing: 0,
  };
  const represented = Object.values(sections).reduce((total, value) => total + value, 0);
  return { ...sections, framing: Math.max(0, inputTokens - represented) };
}
function compactDeltaRanges(sourceItems: readonly ContextManifestItemV1[], sourceGroups: readonly CompiledContextGroupItemV1[]): { items: ContextManifestEntryV1[]; groups: CompiledContextGroupItemV1[] } {
  const compacted: ContextManifestEntryV1[] = [];
  for (let index = 0; index < sourceItems.length;) {
    const first = sourceItems[index]!;
    if (first.section === "delta" && first.disposition === "omitted" && first.source.corpusSeq !== null) {
      const rangeItems = [first]; let cursor = index + 1;
      while (cursor < sourceItems.length) {
        const next = sourceItems[cursor]!; const previous = rangeItems[rangeItems.length - 1]!.source.corpusSeq!;
        if (next.section !== "delta" || next.disposition !== "omitted" || next.source.corpusSeq !== previous + 1) break;
        rangeItems.push(next); cursor += 1;
      }
      if (rangeItems.length >= 1) {
        const fromCorpusSeq = first.source.corpusSeq; const toCorpusSeq = rangeItems[rangeItems.length - 1]!.source.corpusSeq!;
        const sourceIndexHash = sha256HexV1(canonicalJsonV1(rangeItems.map((item) => item.source)));
        compacted.push({ ordinal: 0, section: "delta", disposition: "index_only", memoryKind: null, source: null,
          canonicalOrder: `${SECTION_ORDER.delta}:${String(fromCorpusSeq).padStart(16, "0")}:${String(toCorpusSeq).padStart(16, "0")}`,
          fromCorpusSeq, toCorpusSeq, count: rangeItems.length,
          originalBytes: rangeItems.reduce((sum, item) => sum + item.originalBytes, 0), includedBytes: 0,
          originalTokens: rangeItems.reduce((sum, item) => sum + item.originalTokens, 0), includedTokens: 0,
          reason: "section_budget", citationLabel: "", sourceIndexHash,
          readRef: `delta-range:${fromCorpusSeq}:${toCorpusSeq}:${sourceIndexHash}` });
        index = cursor; continue;
      }
    }
    compacted.push(first); index += 1;
  }
  const labels = new Map<string, string>();
  const items = compacted.map((item, index) => {
    const citationLabel = item.source === null || item.citationLabel !== null ? `ctx-${String(index + 1).padStart(4, "0")}` : null;
    if (item.source !== null && item.citationLabel !== null) labels.set(item.citationLabel, citationLabel!);
    return { ...item, ordinal: index + 1, citationLabel } as ContextManifestEntryV1;
  });
  return { items, groups: sourceGroups.map((group) => ({ ...group, citationLabel: labels.get(group.citationLabel) ?? group.citationLabel })) };
}
function validateSegments(items: readonly WorkItem[], config: ContextCompilerConfigV1): string | null {
  for (const item of items) {
    if (item.segment === null) continue;
    if (item.body === null || utf8ByteLength(item.body) !== item.segment.endByte - item.segment.startByte) return `Segment byte range does not match body: ${item.source.sourceId}`;
    if ((item.segment.index === 0) !== (item.segment.startByte === 0)) return `Segment boundary is inconsistent with its index: ${item.source.sourceId}`;
    if (utf8ByteLength(item.body) > config.singleSegmentBytes || estimateStructuredTokensV1(item.body, "content") > config.singleSegmentTokens) return `Segment exceeds deterministic cap: ${item.source.sourceId}`;
  }
  return null;
}

export function compileContextV1(inputValue: ContextCompilerInputV1, configValue: ContextCompilerConfigV1): ContextCompileResultV1 {
  if (!isContextCompilerInputV1(inputValue)) return invalid("invalid_input", "Context compiler input is not an exact V1 authority value.");
  if (!isContextCompilerConfigV1(configValue)) return invalid("invalid_config", "Context compiler config is not an exact deterministic V1 value.");
  const input = inputValue; const config = configValue;
  const rawItems: WorkItem[] = [normalizeCandidate(asCandidate(input.trigger), "trigger")];
  if (input.project.availability === "available") rawItems.push(normalizeProject(input.project));
  rawItems.push(...input.memories.map((entry) => normalizeMemory(entry, input.invocation.roomId))
    .sort((left, right) => MEMORY_ORDER.indexOf(left.memoryKind!) - MEMORY_ORDER.indexOf(right.memoryKind!) || compareUtf8(left.canonicalOrder, right.canonicalOrder)));
  rawItems.push(...input.delta.map((entry) => normalizeCandidate(entry, "delta")).sort((left, right) => compareSource(left.source, right.source)));
  rawItems.push(...input.retrieval.map((entry) => normalizeCandidate(entry, "retrieval")).sort((left, right) => compareSource(left.source, right.source)));
  rawItems.push(...input.attachments.map((entry) => normalizeCandidate(entry, "attachment")).sort((left, right) => compareSource(left.source, right.source)));
  const deduplicated = deduplicate(rawItems);
  if (!deduplicated.ok) return invalid("invalid_input", deduplicated.message);
  const segmentError = validateSegments(deduplicated.items, config);
  if (segmentError !== null) return invalid("invalid_input", segmentError);
  const toolResult = deduplicateTools(input.tools);
  if (!toolResult.ok) return invalid("invalid_input", toolResult.message);
  const tools = toolResult.tools;
  for (const tool of tools) {
    try { if (canonicalJsonV1(JSON.parse(tool.inputSchemaCanonical)) !== tool.inputSchemaCanonical) return invalid("invalid_input", `Tool ${tool.id} does not have a canonical input schema.`); }
    catch { return invalid("invalid_input", `Tool ${tool.id} does not have a canonical input schema.`); }
  }
  const toolTokens = tools.reduce((sum, tool) => sum + estimateStructuredTokensV1(`${tool.id}\n${tool.description}\n${tool.inputSchemaCanonical}`, "tool"), 0);
  if (toolTokens > config.toolSchemaBudgetTokens || utf8ByteLength(canonicalJsonV1(tools)) > config.toolSchemaBytes) return tooLarge();
  const trustedSystem = normalize(input.trusted.system); const developerPolicy = normalize(input.trusted.developerPolicy);
  const trustedText = `${trustedSystem}\n${developerPolicy}`; const trustedTokens = estimateStructuredTokensV1(trustedText, "trusted");
  if (trustedTokens > config.trustedBudgetTokens || utf8ByteLength(trustedText) > config.trustedBytes) return tooLarge();
  const invocation = { invocationId: normalize(input.invocation.invocationId), executionId: normalize(input.invocation.executionId),
    roomId: normalize(input.invocation.roomId), intent: normalizeIntent(input.invocation.intent) };
  const agent = {
    agentId: normalize(input.agent.agentId),
    profileId: normalize(input.agent.profileId),
    assignmentId: normalize(input.agent.assignmentId),
    displayName: normalize(input.agent.displayName),
    globalResponsibility: normalize(input.agent.globalResponsibility),
    roomResponsibility: normalize(input.agent.roomResponsibility),
    participation: input.agent.participation,
    availability: input.agent.availability,
    effectiveCapabilities: [...input.agent.effectiveCapabilities],
    effectiveTools: [...input.agent.effectiveTools],
    revisions: { ...input.agent.revisions },
  };
  const room = { roomId: normalize(input.room.roomId), name: normalize(input.room.name),
    goal: input.room.goal.availability === "available"
      ? { ...input.room.goal, text: normalize(input.room.goal.text) }
      : { ...input.room.goal } };
  const identityText = canonicalJsonV1({ invocation, agent, room,
    triggerType: input.trigger.triggerType, triggerReason: input.trigger.reason,
    projectAvailability: input.project.availability, projectReason: input.project.availability === "available" ? null : input.project.reason });
  const identityTokens = estimateStructuredTokensV1(identityText, "identity");
  if (identityTokens > config.identityBudgetTokens || utf8ByteLength(identityText) > config.identityBytes) return tooLarge();
  const budgets: Record<ContextManifestSectionV1, { tokens: number; bytes: number }> = {
    trigger: { tokens: config.triggerBudgetTokens, bytes: config.triggerBytes },
    project: { tokens: Math.max(0, config.identityBudgetTokens - identityTokens), bytes: config.identityBytes },
    memory: { tokens: config.memoryBudgetTokens, bytes: config.memoryBytes }, delta: { tokens: config.deltaBudgetTokens, bytes: config.deltaBytes },
    retrieval: { tokens: config.retrievalBudgetTokens, bytes: config.retrievalBytes }, attachment: { tokens: config.attachmentBudgetTokens, bytes: config.attachmentBytes },
  };
  let carryTokens = Math.max(0, config.trustedBudgetTokens - trustedTokens); let groupContent: CompiledContextGroupItemV1[] = [];
  const sourceItems: ContextManifestItemV1[] = [];
  let projectSelection: { item: WorkItem; selection: Selection; citationLabel: string | null } | null = null;
  let ordinal = 0;
  for (const section of ["trigger", "project", "memory", "delta", "retrieval", "attachment"] as const) {
    let availableTokens = budgets[section].tokens + carryTokens; let availableBytes = budgets[section].bytes;
    for (const item of deduplicated.items.filter((entry) => entry.section === section)) {
      ordinal += 1; const citationLabel = `ctx-${String(ordinal).padStart(4, "0")}`;
      const selection = select(item, Math.max(0, availableTokens - ITEM_STRUCTURE_TOKENS_V1), availableBytes, config);
      if (section === "trigger" && selection.disposition === "omitted") return tooLarge("ctx-0001");
      const cited = !["omitted", "unavailable", "invalidated"].includes(selection.disposition);
      sourceItems.push({ ordinal, section, disposition: selection.disposition, memoryKind: item.memoryKind, source: item.source,
        canonicalOrder: `${SECTION_ORDER[section]}:${item.canonicalOrder}`, originalBytes: selection.originalBytes,
        includedBytes: selection.includedBytes, originalTokens: selection.originalTokens, includedTokens: selection.includedTokens,
        reason: selection.reason, citationLabel: cited ? citationLabel : null, contentHash: selection.contentHash,
        segment: item.segment, range: selection.range, availability: item.availability, readRef: cited ? item.readRef : null });
      const charged = selection.includedTokens + ITEM_STRUCTURE_TOKENS_V1;
      availableTokens = Math.max(0, availableTokens - charged); availableBytes = Math.max(0, availableBytes - selection.includedBytes);
      if (section === "project") projectSelection = { item, selection, citationLabel: cited ? citationLabel : null };
      else if (selection.representation !== null && cited) groupContent.push({ section, trust: "untrusted_group_content", citationLabel,
        source: item.source, representation: selection.representation, author: item.author, occurredAt: item.occurredAt,
        replyTo: item.replyTo, mentions: item.mentions, sourceRefs: item.sourceRefs, memoryKind: item.memoryKind });
    }
    carryTokens = availableTokens;
  }
  const compacted = compactDeltaRanges(sourceItems, groupContent); const manifestItems = compacted.items; groupContent = compacted.groups;
  const labelBySource = new Map(manifestItems.filter((item): item is ContextManifestItemV1 => item.source !== null && item.citationLabel !== null)
    .map((item) => [sourceKey(item.source), item.citationLabel!]));
  const projectContext: CompiledProjectContextV1 = input.project.availability === "available" && projectSelection !== null
    ? { availability: "available", projectId: normalize(input.project.projectId), revision: input.project.revision,
        representation: projectSelection.selection.representation, disposition: projectSelection.selection.disposition,
        citationLabel: labelBySource.get(sourceKey(projectSelection.item.source)) ?? null, sourceRefs: projectSelection.item.sourceRefs }
    : input.project.availability === "available"
      ? { availability: "available", projectId: normalize(input.project.projectId), revision: input.project.revision,
          representation: null, disposition: "omitted", citationLabel: null, sourceRefs: [...input.project.sourceRefs].map(normalizeSource).sort(compareSource) }
      : { availability: input.project.availability, reason: normalize(input.project.reason) };
  const degradationNotes = manifestItems.filter((item) => item.disposition !== "included").map((item) => ({ citationLabel: item.citationLabel,
    section: item.section, disposition: item.disposition as Exclude<ContextManifestDispositionV1, "included">, reason: item.reason }));
  const manifestBase = { version: "context_manifest_v1" as const, compilerVersion: CONTEXT_COMPILER_VERSION,
    configVersion: config.configVersion, modelId: config.modelId, estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION,
    memoryWatermark: input.memoryWatermark, corpusHead: input.corpusHead,
    deltaRange: { fromExclusive: input.memoryWatermark, toInclusive: input.corpusHead },
    projectAvailability: input.project.availability, items: manifestItems };
  const emptySections = { tools: 0, trusted: 0, trigger: 0, identity: 0,
    memory: 0, delta: 0, retrieval: 0, attachment: 0, project: 0, manifest: 0, framing: 0 };
  let accounting: ContextAccountingV1 = { estimatorVersion: CONTEXT_TOKEN_ESTIMATOR_VERSION, configVersion: config.configVersion,
    hardLimitTokens: config.hardLimitTokens, inputTokens: 0, totalTokens: config.outputReserveTokens + config.toolSchemaBudgetTokens,
    envelopeBytes: 0, outputReserveTokens: config.outputReserveTokens, toolSchemaReserveTokens: config.toolSchemaBudgetTokens,
    sectionTokens: emptySections };
  let finalManifest!: ContextManifestV1; let canonicalManifest = ""; let envelope!: CompiledContextEnvelopeV1; let canonicalEnvelope = "";
  let stable = false;
  for (let pass = 0; pass < 32; pass += 1) {
    ({ manifest: finalManifest, canonical: canonicalManifest } = manifestWithHash({ ...manifestBase, accounting }));
    envelope = { version: "compiled_context_envelope_v1", compilerVersion: CONTEXT_COMPILER_VERSION,
      invocation,
      trusted: { system: trustedSystem, developer: { policy: developerPolicy,
        agent, room, triggerType: input.trigger.triggerType, triggerReason: input.trigger.reason,
        invocationIntent: invocation.intent, citationContract: "manifest_labels_only" } },
      groupContent, projectContext, availableTools: tools, degradationNotes, manifest: finalManifest, accounting };
    canonicalEnvelope = canonicalJsonV1(envelope);
    const inputTokens = utf8ByteLength(canonicalEnvelope);
    const next: ContextAccountingV1 = { ...accounting, inputTokens, envelopeBytes: inputTokens,
      totalTokens: inputTokens + config.outputReserveTokens + config.toolSchemaBudgetTokens,
      sectionTokens: accountEnvelopeSections(envelope, canonicalManifest, inputTokens) };
    if (canonicalJsonV1(next) === canonicalJsonV1(accounting)) { accounting = next; stable = true; break; }
    accounting = next;
  }
  if (!stable || utf8ByteLength(canonicalEnvelope) !== accounting.inputTokens
    || Object.values(accounting.sectionTokens).reduce((total, value) => total + value, 0) !== accounting.inputTokens
    || accounting.totalTokens > config.hardLimitTokens
    || accounting.envelopeBytes > config.envelopeBytes || utf8ByteLength(canonicalManifest) > config.manifestBytes) return tooLarge();
  return { ok: true, envelope, manifest: finalManifest, canonicalEnvelope, canonicalManifest,
    envelopeSha256: sha256HexV1(canonicalEnvelope), manifestSha256: sha256HexV1(canonicalManifest) };
}

export function verifyContextCompileResultV1(
  value: unknown,
  config: ContextCompilerConfigV1 = CONTEXT_COMPILER_CONFIG_V1,
): value is ContextCompileResultV1 {
  if (!isContextCompilerConfigV1(config) || !isContextCompileResultV1(value)) return false;
  if (!value.ok) return true;
  const { manifestHash, ...manifestBase } = value.manifest;
  if (value.canonicalEnvelope !== canonicalJsonV1(value.envelope)
    || value.canonicalManifest !== canonicalJsonV1(value.manifest)
    || value.envelopeSha256 !== sha256HexV1(value.canonicalEnvelope)
    || value.manifestSha256 !== sha256HexV1(value.canonicalManifest)
    || manifestHash !== sha256HexV1(canonicalJsonV1(manifestBase))) return false;
  const inputTokens = utf8ByteLength(value.canonicalEnvelope);
  const accounting = value.envelope.accounting;
  if (value.manifest.configVersion !== config.configVersion || value.manifest.modelId !== config.modelId
    || accounting.hardLimitTokens !== config.hardLimitTokens
    || accounting.outputReserveTokens !== config.outputReserveTokens
    || accounting.toolSchemaReserveTokens !== config.toolSchemaBudgetTokens
    || accounting.inputTokens !== inputTokens || accounting.envelopeBytes !== inputTokens
    || accounting.totalTokens !== inputTokens + config.outputReserveTokens + config.toolSchemaBudgetTokens
    || accounting.totalTokens > config.hardLimitTokens || inputTokens > config.envelopeBytes
    || utf8ByteLength(value.canonicalManifest) > config.manifestBytes
    || canonicalJsonV1(accounting.sectionTokens) !== canonicalJsonV1(
      accountEnvelopeSections(value.envelope, value.canonicalManifest, inputTokens),
    )) return false;
  const representations = new Map(value.envelope.groupContent.map((group) => [group.citationLabel, group.representation]));
  if (value.envelope.projectContext.availability === "available" && value.envelope.projectContext.citationLabel !== null
    && value.envelope.projectContext.representation !== null) {
    representations.set(value.envelope.projectContext.citationLabel, value.envelope.projectContext.representation);
  }
  for (const item of value.manifest.items) {
    if (item.source === null) continue;
    const representation = item.citationLabel === null ? undefined : representations.get(item.citationLabel);
    if (representation === undefined) {
      if (item.includedBytes !== 0 || item.includedTokens !== 0) return false;
      continue;
    }
    if (item.includedBytes !== utf8ByteLength(representation.text)
      || item.includedTokens !== estimateStructuredTokensV1(representation.text, "content")
      || ((item.disposition === "included" || (item.disposition === "segmented" && item.segment !== null))
        && item.contentHash !== sha256HexV1(representation.text))) return false;
  }
  return true;
}
