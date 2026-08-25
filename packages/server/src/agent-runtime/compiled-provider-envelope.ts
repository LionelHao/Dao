import type {
  LegacyAgentInvocationIntent as AgentInvocationIntent,
  AgentRuntimeProviderInput,
  ProviderNeutralCheckpoint,
  ToolDescriptor,
} from "@native-im/core";

export type CompiledProviderToolIdV1 = ToolDescriptor["id"] | "room-memory.read";

export interface CompiledProviderToolDescriptorV1 {
  readonly id: CompiledProviderToolIdV1;
  readonly displayName: string;
  readonly effect: "read-only" | "side-effecting";
  readonly reversibility: "compensatable" | "irreversible";
}

export interface CompiledProviderSnapshotV1 {
  readonly snapshotId: string;
  readonly generation: number;
  readonly manifestHash: string;
  readonly compilerVersion: string;
  readonly configVersion: string;
  readonly modelId: string;
}

export type CompiledTrustedSystemBlockV1 = Readonly<{
  kind: "product_policy" | "safety_policy";
  text: string;
}>;

export type CompiledTrustedDeveloperBlockV1 =
  | Readonly<{
      kind: "agent_identity" | "responsibility" | "room_goal" | "trigger_contract" |
        "citation_contract" | "authority_fact";
      data: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: "agent_identity" | "responsibility" | "room_goal" | "trigger_contract" |
        "citation_contract" | "authority_fact";
      text: string;
    }>;

export type CompiledGroupContentKindV1 =
  | "trigger"
  | "human_message"
  | "agent_message"
  | "memory"
  | "raw_delta"
  | "retrieval"
  | "attachment_extraction"
  | "omission";

export interface CompiledGroupContentBlockV1 {
  readonly kind: CompiledGroupContentKindV1;
  readonly trust: "untrusted_group_content";
  readonly source: Readonly<{
    label: string;
    kind: "message" | "message_revision" | "message_tombstone" |
      "attachment_extraction" | "memory" | "project_fact_checkpoint";
    revision: number;
  }>;
  readonly content: string;
  readonly memoryKind?: "goal" | "decision" | "context" | "next_action" | "open_question_or_blocker";
  readonly speaker?: Readonly<{ actorId: string; kind: "human" | "agent" }>;
  readonly serverTime?: string;
  readonly replyTo?: Readonly<{ messageId: string; revision: number }>;
  readonly mentions?: readonly Readonly<{
    startUtf16: number;
    endUtf16: number;
    targetKind: "human-request" | "agent-invocation";
    targetActorId: string;
  }>[];
}

export interface CompiledProviderEnvelopeV1 {
  readonly purpose: "agent_runtime";
  readonly schemaVersion: "compiled-context-envelope.v1";
  readonly snapshot: CompiledProviderSnapshotV1;
  readonly invocation: AgentInvocationIntent;
  readonly trusted: Readonly<{
    system: readonly CompiledTrustedSystemBlockV1[];
    developer: readonly CompiledTrustedDeveloperBlockV1[];
  }>;
  readonly groupContent: readonly CompiledGroupContentBlockV1[];
  readonly projectContext: AgentRuntimeProviderInput["projectContext"];
  readonly availableTools: readonly CompiledProviderToolDescriptorV1[];
  readonly openItemTargets?: readonly Readonly<{ actorId: string; kind: "human" | "agent" }>[];
  readonly committedSteps: readonly ProviderNeutralCheckpoint[];
  readonly toolContinuations?: readonly Readonly<{
    callId: string;
    toolId: CompiledProviderToolIdV1 | "open-item.propose";
    argumentsJson: string;
    modelInput: string;
  }>[];
  readonly limits: Readonly<{
    maxInputBytes: number;
    compiledInputTokens: number;
    maxContextInputTokens: number;
    maxOutputTokens: number;
    maxOutputBytes: number;
    timeoutMs: number;
  }>;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function text(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value.normalize("NFC") === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

const toolIds = new Set<CompiledProviderToolIdV1>([
  "http-json.read", "repository.git-status", "sandbox-file.write", "room-memory.read",
]);

const groupKinds = new Set<CompiledGroupContentKindV1>([
  "trigger", "human_message", "agent_message", "memory", "raw_delta", "retrieval",
  "attachment_extraction", "omission",
]);

const sourceKinds = new Set<CompiledGroupContentBlockV1["source"]["kind"]>([
  "message", "message_revision", "message_tombstone", "attachment_extraction", "memory",
  "project_fact_checkpoint",
]);

function isInvocation(value: unknown): value is AgentInvocationIntent {
  return record(value) && exact(value, ["kind", "roomId", "sourceMessageId", "targetAgentId"]) &&
    (value.kind === "direct_mention" || value.kind === "structured_help" || value.kind === "routed_candidate") &&
    text(value.roomId) && text(value.sourceMessageId) && text(value.targetAgentId);
}

function isSystemBlock(value: unknown): value is CompiledTrustedSystemBlockV1 {
  return record(value) && exact(value, ["kind", "text"]) &&
    (value.kind === "product_policy" || value.kind === "safety_policy") &&
    typeof value.text === "string" && value.text.length > 0 && value.text.length <= 32_768;
}

function isCanonicalData(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!record(value)) return false;
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function isDeveloperBlock(value: unknown): value is CompiledTrustedDeveloperBlockV1 {
  if (!record(value) || !exact(value, ["kind"], ["data", "text"]) ||
      !["agent_identity", "responsibility", "room_goal", "trigger_contract", "citation_contract", "authority_fact"]
        .includes(String(value.kind)) || Object.hasOwn(value, "data") === Object.hasOwn(value, "text")) return false;
  return Object.hasOwn(value, "data")
    ? isCanonicalData(value.data)
    : typeof value.text === "string" && value.text.length > 0 && value.text.length <= 32_768;
}

function isSource(value: unknown): value is CompiledGroupContentBlockV1["source"] {
  return record(value) && exact(value, ["label", "kind", "revision"]) && text(value.label) &&
    sourceKinds.has(value.kind as CompiledGroupContentBlockV1["source"]["kind"]) && positive(value.revision);
}

function isSpeaker(value: unknown): value is NonNullable<CompiledGroupContentBlockV1["speaker"]> {
  return record(value) && exact(value, ["actorId", "kind"]) && text(value.actorId) &&
    (value.kind === "human" || value.kind === "agent");
}

function isReplyTo(value: unknown): value is NonNullable<CompiledGroupContentBlockV1["replyTo"]> {
  return record(value) && exact(value, ["messageId", "revision"]) && text(value.messageId) &&
    positive(value.revision);
}

function isMention(value: unknown): value is NonNullable<CompiledGroupContentBlockV1["mentions"]>[number] {
  return record(value) && exact(value, ["startUtf16", "endUtf16", "targetKind", "targetActorId"]) &&
    nonnegative(value.startUtf16) && positive(value.endUtf16) && value.endUtf16 > value.startUtf16 &&
    (value.targetKind === "human-request" || value.targetKind === "agent-invocation") &&
    text(value.targetActorId);
}

function isGroupBlock(value: unknown): value is CompiledGroupContentBlockV1 {
  if (!record(value) || !exact(value, ["kind", "trust", "source", "content"], [
    "memoryKind", "speaker", "serverTime", "replyTo", "mentions",
  ]) || !groupKinds.has(value.kind as CompiledGroupContentKindV1) ||
      value.trust !== "untrusted_group_content" || !isSource(value.source) ||
      typeof value.content !== "string" || value.content.length > 262_144) return false;
  if (Object.hasOwn(value, "memoryKind") &&
      !["goal", "decision", "context", "next_action", "open_question_or_blocker"]
        .includes(String(value.memoryKind))) return false;
  if ((value.kind === "memory") !== Object.hasOwn(value, "memoryKind")) return false;
  if (Object.hasOwn(value, "speaker") && !isSpeaker(value.speaker)) return false;
  if (Object.hasOwn(value, "serverTime") && (typeof value.serverTime !== "string" ||
      !Number.isFinite(Date.parse(value.serverTime)))) return false;
  if (Object.hasOwn(value, "replyTo") && !isReplyTo(value.replyTo)) return false;
  if (Object.hasOwn(value, "mentions")) {
    if (!Array.isArray(value.mentions) || !value.mentions.every(isMention)) return false;
    for (let index = 1; index < value.mentions.length; index += 1) {
      const previous = value.mentions[index - 1]!;
      const current = value.mentions[index]!;
      if (previous.startUtf16 > current.startUtf16 ||
          (previous.startUtf16 === current.startUtf16 && previous.endUtf16 > current.endUtf16) ||
          (previous.startUtf16 === current.startUtf16 && previous.endUtf16 === current.endUtf16 &&
            previous.targetActorId >= current.targetActorId)) return false;
    }
  }
  if (value.kind === "human_message" && (!isSpeaker(value.speaker) || value.speaker.kind !== "human")) return false;
  if (value.kind === "agent_message" && (!isSpeaker(value.speaker) || value.speaker.kind !== "agent")) return false;
  return true;
}

function isProjectContext(value: unknown): value is AgentRuntimeProviderInput["projectContext"] {
  if (!record(value)) return false;
  if (value.status === "disabled" || value.status === "unavailable") {
    return exact(value, ["status", "reason"]) && text(value.reason);
  }
  if (value.status !== "available" || !exact(value, [
    "status", "projectId", "revision", "representation", "disposition", "citationLabel", "sourceRefs",
  ]) || !text(value.projectId) || !positive(value.revision) ||
      !["included", "excerpted", "segmented", "digested", "index_only", "omitted", "unavailable", "invalidated"]
        .includes(String(value.disposition)) ||
      !(value.citationLabel === null || text(value.citationLabel)) || !Array.isArray(value.sourceRefs) ||
      value.sourceRefs.length === 0 || !value.sourceRefs.every((source) => record(source) && exact(source, [
        "roomId", "sourceKind", "sourceId", "revision", "corpusSeq",
      ]) && text(source.roomId) && sourceKinds.has(source.sourceKind as CompiledGroupContentBlockV1["source"]["kind"]) &&
        text(source.sourceId) && positive(source.revision) &&
        (source.corpusSeq === null || nonnegative(source.corpusSeq)))) return false;
  if (value.representation === null) return value.citationLabel === null;
  return record(value.representation) && exact(value.representation, ["kind", "text"]) &&
    ["content", "excerpt", "segment", "digest", "index"].includes(String(value.representation.kind)) &&
    typeof value.representation.text === "string" && value.representation.text.length <= 262_144 &&
    value.citationLabel !== null;
}

function isTool(value: unknown): value is CompiledProviderToolDescriptorV1 {
  return record(value) && exact(value, ["id", "displayName", "effect", "reversibility"]) &&
    toolIds.has(value.id as CompiledProviderToolIdV1) && text(value.displayName) &&
    (value.effect === "read-only" || value.effect === "side-effecting") &&
    (value.reversibility === "compensatable" || value.reversibility === "irreversible") &&
    (value.id !== "room-memory.read" || value.effect === "read-only");
}

function isContinuation(value: unknown): boolean {
  return record(value) && exact(value, ["callId", "toolId", "argumentsJson", "modelInput"]) &&
    text(value.callId) && (toolIds.has(value.toolId as CompiledProviderToolIdV1) || value.toolId === "open-item.propose") &&
    typeof value.argumentsJson === "string" && value.argumentsJson.length <= 49_152 &&
    typeof value.modelInput === "string" && value.modelInput.length <= 262_144;
}

function isCheckpoint(value: unknown): value is ProviderNeutralCheckpoint {
  return record(value) && exact(value, [
    "attemptSeq", "stepSeq", "kind", "inputSha256", "outputSha256",
  ]) && positive(value.attemptSeq) && nonnegative(value.stepSeq) &&
    (value.kind === "model" || value.kind === "tool") && sha256(value.inputSha256) &&
    sha256(value.outputSha256);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isCompiledProviderEnvelopeV1(value: unknown): value is CompiledProviderEnvelopeV1 {
  if (!record(value) || !exact(value, [
    "purpose", "schemaVersion", "snapshot", "invocation", "trusted", "groupContent",
    "projectContext", "availableTools", "committedSteps", "limits",
  ], ["openItemTargets", "toolContinuations"]) || value.purpose !== "agent_runtime" ||
      value.schemaVersion !== "compiled-context-envelope.v1" || !record(value.snapshot) ||
      !exact(value.snapshot, [
        "snapshotId", "generation", "manifestHash", "compilerVersion", "configVersion", "modelId",
      ]) || !text(value.snapshot.snapshotId) || !positive(value.snapshot.generation) ||
      !sha256(value.snapshot.manifestHash) || !text(value.snapshot.compilerVersion) ||
      !text(value.snapshot.configVersion) || !text(value.snapshot.modelId) || !isInvocation(value.invocation)) return false;
  if (!record(value.trusted) || !exact(value.trusted, ["system", "developer"]) ||
      !Array.isArray(value.trusted.system) || value.trusted.system.length === 0 ||
      !value.trusted.system.every(isSystemBlock) || !Array.isArray(value.trusted.developer) ||
      !value.trusted.developer.every(isDeveloperBlock)) return false;
  if (!Array.isArray(value.groupContent) || !value.groupContent.every(isGroupBlock) ||
      !isProjectContext(value.projectContext) ||
      !Array.isArray(value.availableTools) || !value.availableTools.every(isTool) ||
      new Set(value.availableTools.map((tool) => tool.id)).size !== value.availableTools.length ||
      !Array.isArray(value.committedSteps) || !value.committedSteps.every(isCheckpoint)) return false;
  if (Object.hasOwn(value, "openItemTargets") && (!Array.isArray(value.openItemTargets) ||
      !value.openItemTargets.every((target) => record(target) && exact(target, ["actorId", "kind"]) &&
        text(target.actorId) && (target.kind === "human" || target.kind === "agent")))) return false;
  if (Object.hasOwn(value, "toolContinuations") && (!Array.isArray(value.toolContinuations) ||
      !value.toolContinuations.every(isContinuation))) return false;
  return record(value.limits) && exact(value.limits, [
    "maxInputBytes", "compiledInputTokens", "maxContextInputTokens",
    "maxOutputTokens", "maxOutputBytes", "timeoutMs",
  ]) &&
    positive(value.limits.maxInputBytes) && value.limits.maxInputBytes <= 262_144 &&
    positive(value.limits.compiledInputTokens) &&
    positive(value.limits.maxContextInputTokens) &&
    value.limits.compiledInputTokens <= value.limits.maxContextInputTokens &&
    value.limits.maxContextInputTokens <= 65_536 &&
    positive(value.limits.maxOutputTokens) && value.limits.maxOutputTokens <= 65_536 &&
    positive(value.limits.maxOutputBytes) && value.limits.maxOutputBytes <= 262_144 &&
    positive(value.limits.timeoutMs) && value.limits.timeoutMs <= 120_000;
}

export function canonicalJson(value: unknown): string {
  const visit = (entry: unknown): unknown => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(visit);
    if (!record(entry)) throw new TypeError("Compiled provider data must be canonical JSON");
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(entry).sort()) normalized[key] = visit(entry[key]);
    return normalized;
  };
  return JSON.stringify(visit(value));
}
