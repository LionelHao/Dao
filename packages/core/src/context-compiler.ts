export const CONTEXT_COMPILER_VERSION = "context_compiler_v1" as const;
export const CONTEXT_COMPILER_INPUT_VERSION = "context_compiler_input_v1" as const;
export const CONTEXT_COMPILER_CONFIG_VERSION = "context_compiler_config_v1" as const;
export const CONTEXT_TOKEN_ESTIMATOR_VERSION = "deterministic_utf8_v1" as const;

export const CONTEXT_COMPILER_LIMITS = Object.freeze({
  hardLimitTokens: 65_536,
  envelopeBytes: 262_144,
  outputReserveTokens: 8_192,
  providerOutputBytes: 262_144,
  toolSchemaBudgetTokens: 6_144,
  toolSchemaBytes: 49_152,
  trustedBudgetTokens: 4_096,
  trustedBytes: 32_768,
  triggerBudgetTokens: 8_192,
  triggerBytes: 32_768,
  identityBudgetTokens: 4_096,
  identityBytes: 24_576,
  memoryBudgetTokens: 10_240,
  memoryBytes: 49_152,
  deltaBudgetTokens: 8_192,
  deltaBytes: 40_960,
  retrievalBudgetTokens: 6_144,
  retrievalBytes: 32_768,
  attachmentBudgetTokens: 4_096,
  attachmentBytes: 16_384,
  manifestBudgetTokens: 2_048,
  manifestBytes: 131_072,
  framingReserveTokens: 4_096,
  singleSegmentTokens: 2_048,
  singleSegmentBytes: 8_192,
  sourceReadPageItems: 8,
  sourceReadCalls: 32,
  sourceReadPageBytes: 32_768,
  sourceReadExecutionBytes: 262_144,
  sourceReadTimeoutMs: 5_000,
});

export type ContextSourceKindV1 = "message" | "message_revision" | "message_tombstone"
  | "attachment_extraction" | "project_fact_checkpoint" | "memory";
export type ContextSourceIdentityV1 = Readonly<{
  roomId: string; sourceKind: ContextSourceKindV1; sourceId: string; revision: number; corpusSeq: number | null;
}>;
export type ContextActorV1 = Readonly<{ actorId: string; kind: "human" | "agent" | "system"; displayName: string }>;
export type ContextReplyRefV1 = Readonly<{ sourceId: string; revision: number }>;
export type ContextMentionV1 = Readonly<{
  targetId: string;
  targetKind: "human-request" | "agent-invocation";
  targetActorId: string;
  range: Readonly<{ startUtf16: number; endUtf16: number }>;
}>;
export type ContextSegmentV1 = Readonly<{ index: number; count: number; startByte: number; endByte: number }>;
export type ContextSourceAvailabilityV1 = "readable" | "metadata_only" | "tombstone" | "temporarily_unavailable" | "invalidated";
export type ContextSourceCandidateV1 = Readonly<{
  source: ContextSourceIdentityV1;
  body: string | null;
  availability: ContextSourceAvailabilityV1;
  author: ContextActorV1 | null;
  occurredAt: string;
  replyTo: ContextReplyRefV1 | null;
  mentions: readonly ContextMentionV1[];
  readRef: string;
  segment?: ContextSegmentV1;
}>;
export type ContextMemoryKindV1 = "goal" | "decision" | "context" | "next_action" | "open_question_or_blocker";
export type ContextMemoryCandidateV1 = Readonly<{
  kind: ContextMemoryKindV1;
  memoryRecordId: string;
  memoryVersionId: string;
  version: number;
  body: string;
  sourceRefs: readonly ContextSourceIdentityV1[];
  availability: "readable" | "invalidated" | "temporarily_unavailable";
}>;
export type ContextAgentResponsibilityV1 =
  | Readonly<{ availability: "available"; text: string; version: number }>
  | Readonly<{ availability: "unavailable"; reason: "ft07_not_delivered" | "authority_unavailable" }>;
export type ContextRoomGoalV1 =
  | Readonly<{ availability: "available"; text: string; version: number }>
  | Readonly<{ availability: "unavailable"; reason: "ft09_not_delivered" | "authority_unavailable" }>;
export type ContextTriggerV1 = Readonly<{
  triggerType: "message" | "reply" | "manual" | "tool_continuation";
  reason: "mention" | "reply" | "manual" | "tool_continuation";
  source: ContextSourceIdentityV1;
  body: string;
  author: ContextActorV1;
  occurredAt: string;
  replyTo: ContextReplyRefV1 | null;
  mentions: readonly ContextMentionV1[];
  readRef: string;
}>;
export type ContextInvocationIntentV1 =
  | Readonly<{ kind: "direct_mention"; sourceMessageId: string; targetAgentId: string; reasonCode: "direct_mention"; reasonText: string }>
  | Readonly<{ kind: "structured_help"; sourceMessageId: string; targetAgentId: string; reasonCode: "structured_help"; reasonText: string }>
  | Readonly<{ kind: "routed_candidate"; sourceMessageId: string; targetAgentId: string; reasonCode: "domain_match" | "risk_detected" | "ball_due"; reasonText: string }>;
export type ContextToolDescriptorV1 = Readonly<{
  id: string; description: string; effect: "read-only" | "reversible-write" | "irreversible-write"; inputSchemaCanonical: string;
}>;
export type ProjectContextInputV1 =
  | Readonly<{ availability: "disabled" | "unavailable"; reason: string }>
  | Readonly<{
      availability: "available"; projectId: string; revision: number; goals: readonly string[];
      decisions: readonly string[]; nextActions: readonly string[]; blockers: readonly string[];
      balls: readonly string[]; due: readonly string[]; criteria: readonly string[];
      sourceRefs: readonly ContextSourceIdentityV1[];
    }>;
export type ContextCompilerInputV1 = Readonly<{
  version: typeof CONTEXT_COMPILER_INPUT_VERSION;
  invocation: Readonly<{ invocationId: string; executionId: string; roomId: string; intent: ContextInvocationIntentV1 }>;
  agent: Readonly<{ agentId: string; displayName: string; responsibility: ContextAgentResponsibilityV1 }>;
  room: Readonly<{ roomId: string; name: string; goal: ContextRoomGoalV1 }>;
  trigger: ContextTriggerV1;
  memoryWatermark: number;
  corpusHead: number;
  memories: readonly ContextMemoryCandidateV1[];
  delta: readonly ContextSourceCandidateV1[];
  retrieval: readonly ContextSourceCandidateV1[];
  attachments: readonly ContextSourceCandidateV1[];
  project: ProjectContextInputV1;
  tools: readonly ContextToolDescriptorV1[];
  trusted: Readonly<{ system: string; developerPolicy: string }>;
}>;

export type ContextCompilerConfigV1 = Readonly<{
  version: typeof CONTEXT_COMPILER_CONFIG_VERSION; configVersion: string; modelId: string;
  estimatorVersion: typeof CONTEXT_TOKEN_ESTIMATOR_VERSION;
  hardLimitTokens: number; envelopeBytes: number; outputReserveTokens: number; providerOutputBytes: number;
  toolSchemaBudgetTokens: number; toolSchemaBytes: number; trustedBudgetTokens: number; trustedBytes: number;
  triggerBudgetTokens: number; triggerBytes: number; identityBudgetTokens: number; identityBytes: number;
  memoryBudgetTokens: number; memoryBytes: number; deltaBudgetTokens: number; deltaBytes: number;
  retrievalBudgetTokens: number; retrievalBytes: number; attachmentBudgetTokens: number; attachmentBytes: number;
  manifestBudgetTokens: number; manifestBytes: number; framingReserveTokens: number;
  singleSegmentTokens: number; singleSegmentBytes: number; sourceReadPageItems: number; sourceReadCalls: number;
  sourceReadPageBytes: number; sourceReadExecutionBytes: number; sourceReadTimeoutMs: number;
}>;

export type ContextManifestDispositionV1 = "included" | "excerpted" | "segmented" | "digested"
  | "index_only" | "omitted" | "unavailable" | "invalidated";
export type ContextManifestSectionV1 = "trigger" | "memory" | "delta" | "retrieval" | "attachment" | "project";
export type ContextManifestReasonV1 = "within_budget" | "presegmented" | "section_budget" | "byte_budget"
  | "metadata_only" | "source_tombstone" | "source_unavailable" | "source_invalidated"
  | "project_disabled" | "project_unavailable";
export type ContextManifestItemV1 = Readonly<{
  ordinal: number; section: ContextManifestSectionV1; disposition: ContextManifestDispositionV1;
  memoryKind: ContextMemoryKindV1 | null;
  source: ContextSourceIdentityV1; canonicalOrder: string; originalBytes: number; includedBytes: number;
  originalTokens: number; includedTokens: number; reason: ContextManifestReasonV1;
  citationLabel: string | null; contentHash: string | null; segment: ContextSegmentV1 | null;
  range: Readonly<{ startByte: number; endByte: number }> | null;
  availability: ContextSourceAvailabilityV1; readRef: string | null;
}>;
export type ContextManifestRangeV1 = Readonly<{
  ordinal: number; section: "delta"; disposition: "index_only"; memoryKind: null; source: null;
  canonicalOrder: string; fromCorpusSeq: number; toCorpusSeq: number; count: number;
  originalBytes: number; includedBytes: 0; originalTokens: number; includedTokens: 0;
  reason: "section_budget"; citationLabel: string; sourceIndexHash: string; readRef: string;
}>;
export type ContextManifestEntryV1 = ContextManifestItemV1 | ContextManifestRangeV1;
export type ContextSectionAccountingV1 = Readonly<{
  tools: number; trusted: number; trigger: number; identity: number; memory: number; delta: number;
  retrieval: number; attachment: number; project: number; manifest: number; framing: number;
}>;
export type ContextAccountingV1 = Readonly<{
  estimatorVersion: typeof CONTEXT_TOKEN_ESTIMATOR_VERSION; configVersion: string;
  hardLimitTokens: number; inputTokens: number; totalTokens: number; envelopeBytes: number;
  outputReserveTokens: number; toolSchemaReserveTokens: number;
  sectionTokens: ContextSectionAccountingV1;
}>;
export type CompiledContextGroupItemV1 = Readonly<{
  section: Exclude<ContextManifestSectionV1, "project">;
  trust: "untrusted_group_content";
  citationLabel: string;
  source: ContextSourceIdentityV1;
  representation: Readonly<{ kind: "content" | "excerpt" | "segment" | "digest" | "index"; text: string }>;
  author: ContextActorV1 | null; occurredAt: string | null; replyTo: ContextReplyRefV1 | null;
  mentions: readonly ContextMentionV1[];
  sourceRefs: readonly ContextSourceIdentityV1[];
  memoryKind: ContextMemoryKindV1 | null;
}>;
export type CompiledProjectContextV1 =
  | Extract<ProjectContextInputV1, { availability: "disabled" | "unavailable" }>
  | Readonly<{
      availability: "available"; projectId: string; revision: number;
      representation: CompiledContextGroupItemV1["representation"] | null;
      disposition: ContextManifestDispositionV1; citationLabel: string | null;
      sourceRefs: readonly ContextSourceIdentityV1[];
    }>;
export type ContextManifestV1 = Readonly<{
  version: "context_manifest_v1"; compilerVersion: typeof CONTEXT_COMPILER_VERSION; configVersion: string;
  modelId: string; estimatorVersion: typeof CONTEXT_TOKEN_ESTIMATOR_VERSION; memoryWatermark: number;
  corpusHead: number; deltaRange: Readonly<{ fromExclusive: number; toInclusive: number }>;
  projectAvailability: ProjectContextInputV1["availability"]; items: readonly ContextManifestEntryV1[];
  accounting: ContextAccountingV1; manifestHash: string;
}>;
export type CompiledContextEnvelopeV1 = Readonly<{
  version: "compiled_context_envelope_v1"; compilerVersion: typeof CONTEXT_COMPILER_VERSION;
  invocation: ContextCompilerInputV1["invocation"];
  trusted: Readonly<{
    system: string;
    developer: Readonly<{
      policy: string; agent: ContextCompilerInputV1["agent"]; room: ContextCompilerInputV1["room"];
      triggerType: ContextTriggerV1["triggerType"]; triggerReason: ContextTriggerV1["reason"];
      invocationIntent: ContextInvocationIntentV1;
      citationContract: "manifest_labels_only";
    }>;
  }>;
  groupContent: readonly CompiledContextGroupItemV1[]; projectContext: CompiledProjectContextV1;
  availableTools: readonly ContextToolDescriptorV1[];
  degradationNotes: readonly Readonly<{
    citationLabel: string | null; section: ContextManifestSectionV1;
    disposition: Exclude<ContextManifestDispositionV1, "included">; reason: ContextManifestReasonV1;
  }>[];
  manifest: ContextManifestV1; accounting: ContextAccountingV1;
}>;
export type ContextCompileErrorV1 = Readonly<{
  code: "invalid_input" | "invalid_config" | "content_too_large"; message: string;
  sourceLabel: string | null;
  recovery: "fix_authority_input" | "fix_server_config" | "reduce_required_trigger_metadata" | "reduce_required_authority_metadata";
}>;
export type ContextCompileResultV1 =
  | Readonly<{
      ok: true; envelope: CompiledContextEnvelopeV1; manifest: ContextManifestV1;
      canonicalEnvelope: string; canonicalManifest: string; envelopeSha256: string; manifestSha256: string;
    }>
  | Readonly<{ ok: false; error: ContextCompileErrorV1 }>;

const INPUT_KEYS = ["version", "invocation", "agent", "room", "trigger", "memoryWatermark", "corpusHead", "memories", "delta", "retrieval", "attachments", "project", "tools", "trusted"];
const CONFIG_KEYS = ["version", "configVersion", "modelId", "estimatorVersion", ...Object.keys(CONTEXT_COMPILER_LIMITS)];
const SOURCE_KINDS = ["message", "message_revision", "message_tombstone", "attachment_extraction", "project_fact_checkpoint", "memory"];

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key)
    && Object.prototype.propertyIsEnumerable.call(value, key));
}
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => sameJsonValue(entry, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const leftKeys = Object.keys(left); const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key)
    && sameJsonValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
function dense(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).some((key) => typeof key === "symbol")) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return Reflect.ownKeys(value).every((key) => key === "length" || (/^(0|[1-9]\d*)$/.test(String(key)) && Number(key) < value.length));
}
function text(value: unknown, empty = false): value is string {
  if (typeof value !== "string" || (!empty && value.length === 0)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function uint(value: unknown, positive = false): value is number {
  return Number.isSafeInteger(value) && Number(value) >= (positive ? 1 : 0);
}
function source(value: unknown, roomId?: string): value is ContextSourceIdentityV1 {
  return exact(value, ["roomId", "sourceKind", "sourceId", "revision", "corpusSeq"])
    && text(value.roomId) && (roomId === undefined || value.roomId === roomId)
    && SOURCE_KINDS.includes(String(value.sourceKind)) && text(value.sourceId) && uint(value.revision, true)
    && (value.corpusSeq === null || uint(value.corpusSeq, true));
}
function sourceIdentityKey(value: ContextSourceIdentityV1): string {
  return `${value.roomId}\u0000${value.sourceKind}\u0000${value.sourceId}\u0000${value.revision}`;
}
function actor(value: unknown): value is ContextActorV1 {
  return exact(value, ["actorId", "kind", "displayName"]) && text(value.actorId)
    && ["human", "agent", "system"].includes(String(value.kind)) && text(value.displayName);
}
function reply(value: unknown): value is ContextReplyRefV1 {
  return exact(value, ["sourceId", "revision"]) && text(value.sourceId) && uint(value.revision, true);
}
function mentions(value: unknown): value is readonly ContextMentionV1[] {
  return dense(value) && value.every((entry) => exact(entry, ["targetId", "targetKind", "targetActorId", "range"])
    && text(entry.targetId) && ["human-request", "agent-invocation"].includes(String(entry.targetKind))
    && text(entry.targetActorId) && exact(entry.range, ["startUtf16", "endUtf16"])
    && uint(entry.range.startUtf16) && uint(entry.range.endUtf16, true) && entry.range.endUtf16 > entry.range.startUtf16);
}
function mentionsFitBody(body: string, values: readonly ContextMentionV1[]): boolean {
  return values.every((value) => value.range.endUtf16 <= body.length
    && !(value.range.startUtf16 > 0 && /[\ud800-\udbff]/.test(body[value.range.startUtf16 - 1]!))
    && !/[\ud800-\udbff]/.test(body[value.range.endUtf16 - 1] ?? ""));
}
function invocationIntent(value: unknown): value is ContextInvocationIntentV1 {
  if (!exact(value, ["kind", "sourceMessageId", "targetAgentId", "reasonCode", "reasonText"])
    || !text(value.sourceMessageId) || !text(value.targetAgentId) || !text(value.reasonText)) return false;
  if (value.kind === "direct_mention") return value.reasonCode === "direct_mention";
  if (value.kind === "structured_help") return value.reasonCode === "structured_help";
  return value.kind === "routed_candidate" && ["domain_match", "risk_detected", "ball_due"].includes(String(value.reasonCode));
}
function timestamp(value: unknown): value is string {
  return text(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}
function responsibility(value: unknown): value is ContextAgentResponsibilityV1 {
  return (exact(value, ["availability", "text", "version"]) && value.availability === "available"
      && text(value.text) && uint(value.version, true))
    || (exact(value, ["availability", "reason"]) && value.availability === "unavailable"
      && ["ft07_not_delivered", "authority_unavailable"].includes(String(value.reason)));
}
function goal(value: unknown): value is ContextRoomGoalV1 {
  return (exact(value, ["availability", "text", "version"]) && value.availability === "available"
      && text(value.text) && uint(value.version, true))
    || (exact(value, ["availability", "reason"]) && value.availability === "unavailable"
      && ["ft09_not_delivered", "authority_unavailable"].includes(String(value.reason)));
}
function agentIdentity(value: unknown): value is ContextCompilerInputV1["agent"] {
  return exact(value, ["agentId", "displayName", "responsibility"])
    && text(value.agentId) && text(value.displayName) && responsibility(value.responsibility);
}
function roomIdentity(value: unknown, roomId?: string): value is ContextCompilerInputV1["room"] {
  return exact(value, ["roomId", "name", "goal"]) && text(value.roomId)
    && (roomId === undefined || value.roomId === roomId) && text(value.name) && goal(value.goal);
}
function candidate(value: unknown, roomId: string): value is ContextSourceCandidateV1 {
  const keys = ["source", "body", "availability", "author", "occurredAt", "replyTo", "mentions", "readRef"];
  if (!exact(value, keys) && !exact(value, [...keys, "segment"])) return false;
  if (!source(value.source, roomId) || !(value.body === null || text(value.body, true))
    || !["readable", "metadata_only", "tombstone", "temporarily_unavailable", "invalidated"].includes(String(value.availability))
    || !(value.author === null || actor(value.author)) || !timestamp(value.occurredAt)
    || !(value.replyTo === null || reply(value.replyTo)) || !mentions(value.mentions) || !text(value.readRef)) return false;
  if (value.body !== null && !mentionsFitBody(value.body, value.mentions)) return false;
  if (value.availability === "readable" && value.body === null) return false;
  if ("segment" in value && (!exact(value.segment, ["index", "count", "startByte", "endByte"])
    || !uint(value.segment.index) || !uint(value.segment.count, true) || value.segment.index >= value.segment.count
    || !uint(value.segment.startByte) || !uint(value.segment.endByte, true) || value.segment.endByte <= value.segment.startByte)) return false;
  return true;
}
function memory(value: unknown, roomId: string): value is ContextMemoryCandidateV1 {
  return exact(value, ["kind", "memoryRecordId", "memoryVersionId", "version", "body", "sourceRefs", "availability"])
    && ["goal", "decision", "context", "next_action", "open_question_or_blocker"].includes(String(value.kind))
    && text(value.memoryRecordId) && text(value.memoryVersionId) && uint(value.version, true) && text(value.body, true)
    && dense(value.sourceRefs) && value.sourceRefs.every((entry) => source(entry, roomId))
    && ["readable", "invalidated", "temporarily_unavailable"].includes(String(value.availability));
}
function project(value: unknown, roomId: string): value is ProjectContextInputV1 {
  if (exact(value, ["availability", "reason"])) return ["disabled", "unavailable"].includes(String(value.availability)) && text(value.reason);
  return exact(value, ["availability", "projectId", "revision", "goals", "decisions", "nextActions", "blockers", "balls", "due", "criteria", "sourceRefs"])
    && value.availability === "available" && text(value.projectId) && uint(value.revision, true)
    && [value.goals, value.decisions, value.nextActions, value.blockers, value.balls, value.due, value.criteria]
      .every((entries) => dense(entries) && entries.every((entry) => text(entry)))
    && dense(value.sourceRefs) && value.sourceRefs.length > 0
    && value.sourceRefs.every((entry) => source(entry, roomId));
}
export function isContextCompilerInputV1(value: unknown): value is ContextCompilerInputV1 {
  if (!exact(value, INPUT_KEYS) || value.version !== CONTEXT_COMPILER_INPUT_VERSION) return false;
  if (!exact(value.invocation, ["invocationId", "executionId", "roomId", "intent"]) || !text(value.invocation.invocationId)
    || !text(value.invocation.executionId) || !text(value.invocation.roomId) || !invocationIntent(value.invocation.intent)) return false;
  const roomId = value.invocation.roomId;
  if (!agentIdentity(value.agent) || !roomIdentity(value.room, roomId)) return false;
  if (!exact(value.trigger, ["triggerType", "reason", "source", "body", "author", "occurredAt", "replyTo", "mentions", "readRef"])
    || !["message", "reply", "manual", "tool_continuation"].includes(String(value.trigger.triggerType))
    || !["mention", "reply", "manual", "tool_continuation"].includes(String(value.trigger.reason))
    || !source(value.trigger.source, roomId) || !text(value.trigger.body, true) || !actor(value.trigger.author)
    || !timestamp(value.trigger.occurredAt) || !(value.trigger.replyTo === null || reply(value.trigger.replyTo))
    || !mentions(value.trigger.mentions) || !mentionsFitBody(value.trigger.body, value.trigger.mentions) || !text(value.trigger.readRef)) return false;
  if (value.invocation.intent.sourceMessageId !== value.trigger.source.sourceId
    || value.invocation.intent.targetAgentId !== value.agent.agentId) return false;
  if (value.trigger.triggerType === "reply" && value.trigger.replyTo === null) return false;
  if (!uint(value.memoryWatermark) || !uint(value.corpusHead) || value.memoryWatermark > value.corpusHead) return false;
  if (!dense(value.memories) || !value.memories.every((entry) => memory(entry, roomId))) return false;
  if (!dense(value.delta) || !value.delta.every((entry) => candidate(entry, roomId))) return false;
  if (!dense(value.retrieval) || !value.retrieval.every((entry) => candidate(entry, roomId))) return false;
  if (!dense(value.attachments) || !value.attachments.every((entry) => candidate(entry, roomId))) return false;
  if (!project(value.project, roomId)) return false;
  if (!dense(value.tools) || !value.tools.every((tool) => exact(tool, ["id", "description", "effect", "inputSchemaCanonical"])
    && text(tool.id) && text(tool.description) && ["read-only", "reversible-write", "irreversible-write"].includes(String(tool.effect))
    && text(tool.inputSchemaCanonical))) return false;
  if (!exact(value.trusted, ["system", "developerPolicy"]) || !text(value.trusted.system) || !text(value.trusted.developerPolicy)) return false;
  const memoryWatermark = Number(value.memoryWatermark);
  const corpusHead = Number(value.corpusHead);
  if (value.trigger.source.corpusSeq !== null && value.trigger.source.corpusSeq > corpusHead) return false;
  if (!value.attachments.every((entry) => entry.source.sourceKind === "attachment_extraction")) return false;
  if (!value.delta.every((entry) => entry.source.corpusSeq !== null
    && entry.source.corpusSeq > memoryWatermark && entry.source.corpusSeq <= corpusHead)) return false;
  const corpusAttachments = value.attachments.filter((entry) => entry.source.corpusSeq !== null);
  if (!corpusAttachments.every((entry) => entry.source.corpusSeq! > memoryWatermark
    && entry.source.corpusSeq! <= corpusHead)) return false;
  const corpusSources = [...new Map(
    [...value.delta, ...corpusAttachments].map((entry) => [sourceIdentityKey(entry.source), entry]),
  ).values()];
  const corpusSeqs = corpusSources.map((entry) => entry.source.corpusSeq!)
    .sort((left, right) => left - right);
  if (corpusSeqs.length !== corpusHead - memoryWatermark
    || corpusSeqs.some((corpusSeq, index) => corpusSeq !== memoryWatermark + index + 1)) return false;
  if (new Set(value.delta.map((entry) => sourceIdentityKey(entry.source))).size !== value.delta.length) return false;
  if (![...value.retrieval, ...value.attachments].every((entry) => entry.source.corpusSeq === null || entry.source.corpusSeq <= corpusHead)) return false;
  if (!value.memories.every((entry) => entry.sourceRefs.every((entrySource) => entrySource.corpusSeq === null || entrySource.corpusSeq <= memoryWatermark))) return false;
  return true;
}

export function isContextCompilerConfigV1(value: unknown): value is ContextCompilerConfigV1 {
  if (!exact(value, CONFIG_KEYS) || value.version !== CONTEXT_COMPILER_CONFIG_VERSION
    || value.estimatorVersion !== CONTEXT_TOKEN_ESTIMATOR_VERSION || !text(value.configVersion) || !text(value.modelId)) return false;
  return Object.keys(CONTEXT_COMPILER_LIMITS).every((key) => uint(value[key], true));
}

export function isContextManifestV1(value: unknown): value is ContextManifestV1 {
  if (!exact(value, ["version", "compilerVersion", "configVersion", "modelId", "estimatorVersion", "memoryWatermark", "corpusHead", "deltaRange", "projectAvailability", "items", "accounting", "manifestHash"])) return false;
  return value.version === "context_manifest_v1" && value.compilerVersion === CONTEXT_COMPILER_VERSION
    && value.estimatorVersion === CONTEXT_TOKEN_ESTIMATOR_VERSION && text(value.configVersion) && text(value.modelId)
    && uint(value.memoryWatermark) && uint(value.corpusHead) && value.memoryWatermark <= value.corpusHead
    && exact(value.deltaRange, ["fromExclusive", "toInclusive"])
    && value.deltaRange.fromExclusive === value.memoryWatermark && value.deltaRange.toInclusive === value.corpusHead
    && ["available", "disabled", "unavailable"].includes(String(value.projectAvailability))
    && dense(value.items) && value.items.every((item, index) => isManifestEntry(item, index + 1))
    && isAccounting(value.accounting) && value.accounting.configVersion === value.configVersion
    && /^[0-9a-f]{64}$/.test(String(value.manifestHash));
}

function isManifestEntry(value: unknown, ordinal: number): value is ContextManifestEntryV1 {
  if (exact(value, ["ordinal", "section", "disposition", "memoryKind", "source", "canonicalOrder", "fromCorpusSeq", "toCorpusSeq", "count", "originalBytes", "includedBytes", "originalTokens", "includedTokens", "reason", "citationLabel", "sourceIndexHash", "readRef"])) {
    return value.ordinal === ordinal && value.section === "delta" && value.disposition === "index_only"
      && value.memoryKind === null && value.source === null && text(value.canonicalOrder) && uint(value.fromCorpusSeq, true) && uint(value.toCorpusSeq, true)
      && value.fromCorpusSeq <= value.toCorpusSeq && uint(value.count, true)
      && value.count === value.toCorpusSeq - value.fromCorpusSeq + 1 && uint(value.originalBytes)
      && value.includedBytes === 0 && uint(value.originalTokens) && value.includedTokens === 0
      && value.reason === "section_budget" && /^ctx-\d{4,}$/.test(String(value.citationLabel))
      && /^[0-9a-f]{64}$/.test(String(value.sourceIndexHash)) && text(value.readRef);
  }
  return exact(value, ["ordinal", "section", "disposition", "memoryKind", "source", "canonicalOrder", "originalBytes", "includedBytes", "originalTokens", "includedTokens", "reason", "citationLabel", "contentHash", "segment", "range", "availability", "readRef"])
    && value.ordinal === ordinal && source(value.source) && text(value.canonicalOrder)
    && (value.memoryKind === null || ["goal", "decision", "context", "next_action", "open_question_or_blocker"].includes(String(value.memoryKind)))
    && ["trigger", "memory", "delta", "retrieval", "attachment", "project"].includes(String(value.section))
    && ["included", "excerpted", "segmented", "digested", "index_only", "omitted", "unavailable", "invalidated"].includes(String(value.disposition))
    && uint(value.originalBytes) && uint(value.includedBytes) && uint(value.originalTokens) && uint(value.includedTokens)
    && ["within_budget", "presegmented", "section_budget", "byte_budget", "metadata_only", "source_tombstone", "source_unavailable", "source_invalidated", "project_disabled", "project_unavailable"].includes(String(value.reason))
    && (value.citationLabel === null || /^ctx-\d{4,}$/.test(String(value.citationLabel)))
    && (value.contentHash === null || /^[0-9a-f]{64}$/.test(String(value.contentHash)))
    && (value.segment === null || (exact(value.segment, ["index", "count", "startByte", "endByte"])
      && uint(value.segment.index) && uint(value.segment.count, true) && value.segment.index < value.segment.count
      && uint(value.segment.startByte) && uint(value.segment.endByte, true) && value.segment.startByte < value.segment.endByte))
    && (value.range === null || (exact(value.range, ["startByte", "endByte"])
      && uint(value.range.startByte) && uint(value.range.endByte) && value.range.startByte <= value.range.endByte))
    && ["readable", "metadata_only", "tombstone", "temporarily_unavailable", "invalidated"].includes(String(value.availability))
    && (value.readRef === null || text(value.readRef));
}

function isAccounting(value: unknown): value is ContextAccountingV1 {
  if (!exact(value, ["estimatorVersion", "configVersion", "hardLimitTokens", "inputTokens", "totalTokens", "envelopeBytes", "outputReserveTokens", "toolSchemaReserveTokens", "sectionTokens"])) return false;
  if (value.estimatorVersion !== CONTEXT_TOKEN_ESTIMATOR_VERSION || !text(value.configVersion)
    || !uint(value.hardLimitTokens, true) || !uint(value.totalTokens) || value.totalTokens > value.hardLimitTokens
    || !uint(value.inputTokens) || !uint(value.envelopeBytes) || value.inputTokens !== value.envelopeBytes
    || !uint(value.outputReserveTokens) || !uint(value.toolSchemaReserveTokens)
    || value.totalTokens !== value.inputTokens + value.outputReserveTokens + value.toolSchemaReserveTokens) return false;
  if (!exact(value.sectionTokens, ["tools", "trusted", "trigger", "identity", "memory", "delta", "retrieval", "attachment", "project", "manifest", "framing"])) return false;
  const sections = Object.values(value.sectionTokens);
  return sections.every((entry) => uint(entry))
    && sections.reduce((total, entry) => total + Number(entry), 0) === value.inputTokens;
}

export function isCompiledContextEnvelopeV1(value: unknown): value is CompiledContextEnvelopeV1 {
  if (!exact(value, ["version", "compilerVersion", "invocation", "trusted", "groupContent", "projectContext", "availableTools", "degradationNotes", "manifest", "accounting"])
    || value.version !== "compiled_context_envelope_v1" || value.compilerVersion !== CONTEXT_COMPILER_VERSION) return false;
  if (!exact(value.invocation, ["invocationId", "executionId", "roomId", "intent"])
    || !text(value.invocation.invocationId) || !text(value.invocation.executionId) || !text(value.invocation.roomId)
    || !invocationIntent(value.invocation.intent)) return false;
  const envelopeInvocation = value.invocation as ContextCompilerInputV1["invocation"];
  if (!exact(value.trusted, ["system", "developer"]) || !text(value.trusted.system)
    || !exact(value.trusted.developer, ["policy", "agent", "room", "triggerType", "triggerReason", "invocationIntent", "citationContract"])
    || !text(value.trusted.developer.policy) || !agentIdentity(value.trusted.developer.agent)
    || !roomIdentity(value.trusted.developer.room, value.invocation.roomId)
    || !["message", "reply", "manual", "tool_continuation"].includes(String(value.trusted.developer.triggerType))
    || !["mention", "reply", "manual", "tool_continuation"].includes(String(value.trusted.developer.triggerReason))
    || !invocationIntent(value.trusted.developer.invocationIntent)
    || !sameJsonValue(value.trusted.developer.invocationIntent, value.invocation.intent)
    || value.invocation.intent.targetAgentId !== value.trusted.developer.agent.agentId
    || value.trusted.developer.citationContract !== "manifest_labels_only") return false;
  if (!dense(value.groupContent) || !value.groupContent.every((item) => exact(item, ["section", "trust", "citationLabel", "source", "representation", "author", "occurredAt", "replyTo", "mentions", "sourceRefs", "memoryKind"])
    && ["trigger", "memory", "delta", "retrieval", "attachment"].includes(String(item.section))
    && item.trust === "untrusted_group_content" && /^ctx-\d{4,}$/.test(String(item.citationLabel)) && source(item.source)
    && exact(item.representation, ["kind", "text"]) && ["content", "excerpt", "segment", "digest", "index"].includes(String(item.representation.kind))
    && text(item.representation.text, true) && (item.author === null || actor(item.author))
    && (item.occurredAt === null || timestamp(item.occurredAt)) && (item.replyTo === null || reply(item.replyTo))
    && mentions(item.mentions) && dense(item.sourceRefs) && item.sourceRefs.every((entry) => source(entry))
    && (item.memoryKind === null || ["goal", "decision", "context", "next_action", "open_question_or_blocker"].includes(String(item.memoryKind))))) return false;
  if (!isCompiledProject(value.projectContext, value.invocation.roomId)) return false;
  if (!dense(value.availableTools) || !value.availableTools.every((tool) => exact(tool, ["id", "description", "effect", "inputSchemaCanonical"])
    && text(tool.id) && text(tool.description) && ["read-only", "reversible-write", "irreversible-write"].includes(String(tool.effect))
    && text(tool.inputSchemaCanonical))) return false;
  if (!dense(value.degradationNotes) || !value.degradationNotes.every((note) => exact(note, ["citationLabel", "section", "disposition", "reason"])
    && (note.citationLabel === null || /^ctx-\d{4,}$/.test(String(note.citationLabel)))
    && ["trigger", "memory", "delta", "retrieval", "attachment", "project"].includes(String(note.section))
    && ["excerpted", "segmented", "digested", "index_only", "omitted", "unavailable", "invalidated"].includes(String(note.disposition))
    && ["within_budget", "presegmented", "section_budget", "byte_budget", "metadata_only", "source_tombstone", "source_unavailable", "source_invalidated", "project_disabled", "project_unavailable"].includes(String(note.reason)))) return false;
  if (!isContextManifestV1(value.manifest) || !isAccounting(value.accounting)
    || !sameJsonValue(value.accounting, value.manifest.accounting)
    || value.projectContext.availability !== value.manifest.projectAvailability) return false;
  const manifestItems = value.manifest.items;
  const groupContent = value.groupContent as readonly CompiledContextGroupItemV1[];
  const triggerGroups = groupContent.filter((item) => item.section === "trigger");
  if (triggerGroups.length !== 1 || triggerGroups[0]!.source.sourceId !== envelopeInvocation.intent.sourceMessageId
    || groupContent.some((item) => item.source.roomId !== envelopeInvocation.roomId)
    || manifestItems.some((item) => item.source !== null && item.source.roomId !== envelopeInvocation.roomId)) return false;
  const manifestLabels = manifestItems.flatMap((item) => item.citationLabel === null ? [] : [item.citationLabel]);
  if (new Set(manifestLabels).size !== manifestLabels.length) return false;
  const representationForDisposition: Partial<Record<ContextManifestDispositionV1, CompiledContextGroupItemV1["representation"]["kind"]>> = {
    included: "content", excerpted: "excerpt", segmented: "segment", digested: "digest", index_only: "index",
  };
  for (const group of groupContent) {
    const matches = manifestItems.filter((item) => item.source !== null && item.citationLabel === group.citationLabel
      && item.section === group.section && sameJsonValue(item.source, group.source) && item.memoryKind === group.memoryKind);
    if (matches.length !== 1 || representationForDisposition[matches[0]!.disposition] !== group.representation.kind) return false;
  }
  for (const item of manifestItems) {
    if (item.source === null || item.section === "project" || item.citationLabel === null) continue;
    if (groupContent.filter((group) => group.citationLabel === item.citationLabel).length !== 1) return false;
  }
  if (value.projectContext.availability === "available") {
    const projects = manifestItems.filter((item) => item.section === "project");
    if (projects.length !== 1 || projects[0]!.disposition !== value.projectContext.disposition
      || projects[0]!.citationLabel !== value.projectContext.citationLabel
      || (value.projectContext.representation === null) !== (projects[0]!.citationLabel === null)
      || (value.projectContext.representation !== null
        && representationForDisposition[projects[0]!.disposition] !== value.projectContext.representation.kind)) return false;
  } else if (manifestItems.some((item) => item.section === "project")) return false;
  const expectedNotes = manifestItems.filter((item) => item.disposition !== "included").map((item) => ({
    citationLabel: item.citationLabel, section: item.section, disposition: item.disposition, reason: item.reason,
  }));
  return sameJsonValue(value.degradationNotes, expectedNotes);
}

function isCompiledProject(value: unknown, roomId: string): value is CompiledProjectContextV1 {
  if (exact(value, ["availability", "reason"])) return ["disabled", "unavailable"].includes(String(value.availability)) && text(value.reason);
  return exact(value, ["availability", "projectId", "revision", "representation", "disposition", "citationLabel", "sourceRefs"])
    && value.availability === "available" && text(value.projectId) && uint(value.revision, true)
    && (value.representation === null || (exact(value.representation, ["kind", "text"])
      && ["content", "excerpt", "segment", "digest", "index"].includes(String(value.representation.kind)) && text(value.representation.text, true)))
    && ["included", "excerpted", "segmented", "digested", "index_only", "omitted", "unavailable", "invalidated"].includes(String(value.disposition))
    && (value.citationLabel === null || /^ctx-\d{4,}$/.test(String(value.citationLabel)))
    && dense(value.sourceRefs) && value.sourceRefs.every((entry) => source(entry, roomId));
}

export function isContextCompileResultV1(value: unknown): value is ContextCompileResultV1 {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if ((value as { ok: unknown }).ok === false) {
    if (!exact(value, ["ok", "error"])) return false;
    const result = value as Record<string, unknown>;
    return exact(result.error, ["code", "message", "sourceLabel", "recovery"])
      && ["invalid_input", "invalid_config", "content_too_large"].includes(String(result.error.code))
      && text(result.error.message) && (result.error.sourceLabel === null || /^ctx-\d{4,}$/.test(String(result.error.sourceLabel)))
      && ["fix_authority_input", "fix_server_config", "reduce_required_trigger_metadata", "reduce_required_authority_metadata"].includes(String(result.error.recovery));
  }
  if (!exact(value, ["ok", "envelope", "manifest", "canonicalEnvelope", "canonicalManifest", "envelopeSha256", "manifestSha256"])) return false;
  const result = value as Record<string, unknown>;
  if (result.ok !== true || !isCompiledContextEnvelopeV1(result.envelope) || !isContextManifestV1(result.manifest)
    || !sameJsonValue(result.manifest, result.envelope.manifest)
    || typeof result.canonicalEnvelope !== "string" || typeof result.canonicalManifest !== "string"
    || !/^[0-9a-f]{64}$/.test(String(result.envelopeSha256)) || !/^[0-9a-f]{64}$/.test(String(result.manifestSha256))) return false;
  try {
    return sameJsonValue(JSON.parse(result.canonicalEnvelope), result.envelope)
      && sameJsonValue(JSON.parse(result.canonicalManifest), result.manifest);
  } catch {
    return false;
  }
}
