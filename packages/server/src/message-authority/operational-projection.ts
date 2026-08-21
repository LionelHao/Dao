import {
  isAttachmentReference,
  isMentionTarget,
  isMessageAuthorityEvent,
  isMessageAuthorityRepairRecord,
  isMessageRevision,
  isMessageTargetOutcome,
  isTimelineMessage,
  type ActiveHumanMessage,
  type AgentFinalMessage,
  type AgentMessageCitation,
  type AttachmentReference,
  type MentionTarget,
  type MessageAuthorityEvent,
  type MessageAuthorityRepairRecord,
  type MessageRevision,
  type MessageTargetOutcome,
  type MessageTombstone,
  type TimelineMessage,
} from "@native-im/core";

export type OperationalMessageProjectionFailureReason =
  | "invalid_source"
  | "invalid_projection"
  | "invalid_event";

export class OperationalMessageProjectionError extends Error {
  readonly reason: OperationalMessageProjectionFailureReason;

  constructor(reason: OperationalMessageProjectionFailureReason) {
    super(`Operational message projection rejected: ${reason}`);
    this.name = "OperationalMessageProjectionError";
    this.reason = reason;
  }
}

export type OperationalMessageEnvelopeRow = Readonly<{
  messageId: string;
  roomId: string;
  authorId: string;
  authorKind: "human" | "agent";
  messageKind: "human" | "agent-final" | "agent-correction";
  lifecycle: "active" | "recalled";
  currentRevision: number;
  revisionCount: number;
  createdAt: string;
  recalledAt: string | null;
}>;

export type OperationalMentionRow =
  | Readonly<{
      id: string;
      kind: "human-request";
      targetActorId: string;
      range: Readonly<{ startUtf16: number; endUtf16: number }>;
      targetOrder: number;
    }>
  | Readonly<{
      id: string;
      kind: "agent-invocation";
      targetActorId: string;
      range: Readonly<{ startUtf16: number; endUtf16: number }>;
      targetOrder: number;
    }>;

export type OperationalReplyRow = Readonly<{
  replyToMessageId: string;
}>;

export type OperationalAgentSourceLineageRow = Readonly<{
  messageId: string;
  roomId: string;
  invocationIntentId: string;
  executionId: string;
  sourceMessageId: string;
  sourceRevision: number;
  attemptSeq: number;
  executionGeneration: number;
}>;

export type OperationalAgentCorrectionRow = Readonly<{
  correctionMessageId: string;
  correctsMessageId: string;
  roomId: string;
  agentActorId: string;
}>;

export type OperationalActiveHumanSource = Readonly<{
  kind: "active-human";
  envelope: OperationalMessageEnvelopeRow;
  currentRevision: MessageRevision;
  mentionedTargets: readonly OperationalMentionRow[];
  targetOutcomes: readonly MessageTargetOutcome[];
  reply: OperationalReplyRow | null;
  attachments: readonly AttachmentReference[];
}>;

export type OperationalRecalledHumanSource = Readonly<{
  kind: "recalled-human";
  envelope: OperationalMessageEnvelopeRow;
}>;

export type OperationalAgentMessageSource = Readonly<{
  kind: "agent-message";
  envelope: OperationalMessageEnvelopeRow;
  finalRevision: MessageRevision;
  sourceLineage: OperationalAgentSourceLineageRow;
  citations: readonly AgentMessageCitation[];
  correction: OperationalAgentCorrectionRow | null;
}>;

export type OperationalMessageProjectionSource =
  | OperationalActiveHumanSource
  | OperationalRecalledHumanSource
  | OperationalAgentMessageSource;

export type OperationalMessageEventRow = Readonly<{
  eventId: string;
  streamKind: "room";
  streamId: string;
  streamSeq: number;
  roomId: string;
  type: MessageAuthorityEvent["type"];
  actorId: string;
  occurredAt: string;
}>;

type UnknownRecord = Record<string, unknown>;

function reject(reason: OperationalMessageProjectionFailureReason): never {
  throw new OperationalMessageProjectionError(reason);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Reflect.ownKeys(value).length === expected.size &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && expected.has(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim();
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isEnvelopeRow(value: unknown): value is OperationalMessageEnvelopeRow {
  return isRecord(value) && hasExactKeys(value, [
    "messageId", "roomId", "authorId", "authorKind", "messageKind", "lifecycle",
    "currentRevision", "revisionCount", "createdAt", "recalledAt",
  ]) && isIdentifier(value.messageId) && isIdentifier(value.roomId) &&
    isIdentifier(value.authorId) &&
    (value.authorKind === "human" || value.authorKind === "agent") &&
    (value.messageKind === "human" || value.messageKind === "agent-final" ||
      value.messageKind === "agent-correction") &&
    (value.lifecycle === "active" || value.lifecycle === "recalled") &&
    isPositiveSafeInteger(value.currentRevision) &&
    isPositiveSafeInteger(value.revisionCount) &&
    typeof value.createdAt === "string" &&
    (value.recalledAt === null || typeof value.recalledAt === "string");
}

function isMentionRow(value: unknown): value is OperationalMentionRow {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "kind", "targetActorId", "range", "targetOrder",
  ]) || !isNonNegativeSafeInteger(value.targetOrder)) return false;
  return isMentionTarget({
    id: value.id,
    kind: value.kind,
    targetActorId: value.targetActorId,
    range: value.range,
  });
}

function isReplyRow(value: unknown): value is OperationalReplyRow {
  return isRecord(value) && hasExactKeys(value, ["replyToMessageId"]) &&
    isIdentifier(value.replyToMessageId);
}

function isAgentSourceLineageRow(
  value: unknown,
): value is OperationalAgentSourceLineageRow {
  return isRecord(value) && hasExactKeys(value, [
    "messageId", "roomId", "invocationIntentId", "executionId", "sourceMessageId",
    "sourceRevision", "attemptSeq", "executionGeneration",
  ]) && isIdentifier(value.messageId) && isIdentifier(value.roomId) &&
    isIdentifier(value.invocationIntentId) && isIdentifier(value.executionId) &&
    isIdentifier(value.sourceMessageId) && isPositiveSafeInteger(value.sourceRevision) &&
    isPositiveSafeInteger(value.attemptSeq) && isPositiveSafeInteger(value.executionGeneration);
}

function isAgentCorrectionRow(value: unknown): value is OperationalAgentCorrectionRow {
  return isRecord(value) && hasExactKeys(value, [
    "correctionMessageId", "correctsMessageId", "roomId", "agentActorId",
  ]) && isIdentifier(value.correctionMessageId) && isIdentifier(value.correctsMessageId) &&
    isIdentifier(value.roomId) && isIdentifier(value.agentActorId);
}

function freezeRevision(value: MessageRevision): MessageRevision {
  return Object.freeze({
    messageId: value.messageId,
    revision: value.revision,
    body: value.body,
    revisedAt: value.revisedAt,
    revisedByActorId: value.revisedByActorId,
  });
}

function freezeMention(value: OperationalMentionRow): MentionTarget {
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    targetActorId: value.targetActorId,
    range: Object.freeze({
      startUtf16: value.range.startUtf16,
      endUtf16: value.range.endUtf16,
    }),
  });
}

function freezeOutcome(value: MessageTargetOutcome): MessageTargetOutcome {
  if (value.status === "request-created") {
    return Object.freeze({
      targetId: value.targetId,
      targetActorId: value.targetActorId,
      kind: value.kind,
      status: value.status,
      requestIntentId: value.requestIntentId,
    });
  }
  if (value.status === "invocation-intent-created") {
    return Object.freeze({
      targetId: value.targetId,
      targetActorId: value.targetActorId,
      kind: value.kind,
      status: value.status,
      invocationIntentId: value.invocationIntentId,
    });
  }
  return Object.freeze({
    targetId: value.targetId,
    targetActorId: value.targetActorId,
    kind: value.kind,
    status: value.status,
    code: value.code,
  });
}

function freezeAttachment(value: AttachmentReference): AttachmentReference {
  return Object.freeze({ attachmentId: value.attachmentId });
}

function projectActiveHuman(source: OperationalActiveHumanSource): ActiveHumanMessage {
  const { envelope } = source;
  if (envelope.authorKind !== "human" || envelope.messageKind !== "human" ||
      envelope.lifecycle !== "active" || envelope.recalledAt !== null ||
      !isMessageRevision(source.currentRevision) || !Array.isArray(source.mentionedTargets) ||
      !source.mentionedTargets.every(isMentionRow) || !Array.isArray(source.targetOutcomes) ||
      !source.targetOutcomes.every(isMessageTargetOutcome) ||
      !(source.reply === null || isReplyRow(source.reply)) ||
      !Array.isArray(source.attachments) || !source.attachments.every(isAttachmentReference)) {
    reject("invalid_source");
  }

  const orderedRows = [...source.mentionedTargets].sort((left, right) =>
    left.targetOrder - right.targetOrder);
  if (orderedRows.some((row, index) => row.targetOrder !== index)) reject("invalid_source");
  const mentionedTargets = Object.freeze(orderedRows.map(freezeMention));
  const outcomesByTarget = new Map<string, MessageTargetOutcome>();
  for (const outcome of source.targetOutcomes) {
    if (outcomesByTarget.has(outcome.targetId)) reject("invalid_source");
    outcomesByTarget.set(outcome.targetId, outcome);
  }
  const targetOutcomes = Object.freeze(mentionedTargets.map(({ id }) => {
    const outcome = outcomesByTarget.get(id);
    if (outcome === undefined) reject("invalid_source");
    return freezeOutcome(outcome);
  }));
  if (targetOutcomes.length !== source.targetOutcomes.length) reject("invalid_source");
  const attachments = Object.freeze([...source.attachments]
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId))
    .map(freezeAttachment));

  const projection: ActiveHumanMessage = Object.freeze({
    id: envelope.messageId,
    roomId: envelope.roomId,
    authorId: envelope.authorId,
    authorKind: "human",
    createdAt: envelope.createdAt,
    lifecycle: "active",
    currentRevision: freezeRevision(source.currentRevision),
    revisionCount: envelope.revisionCount,
    mentionedTargets,
    ...(source.reply === null ? {} : { replyToMessageId: source.reply.replyToMessageId }),
    attachments,
    targetOutcomes,
  });
  if (!isTimelineMessage(projection) || envelope.currentRevision !== envelope.revisionCount ||
      envelope.currentRevision !== source.currentRevision.revision) {
    reject("invalid_projection");
  }
  return projection;
}

function projectRecalledHuman(
  source: OperationalRecalledHumanSource,
): MessageTombstone {
  const { envelope } = source;
  if (envelope.authorKind !== "human" || envelope.messageKind !== "human" ||
      envelope.lifecycle !== "recalled" || envelope.recalledAt === null ||
      envelope.currentRevision !== envelope.revisionCount) {
    reject("invalid_source");
  }
  const projection: MessageTombstone = Object.freeze({
    id: envelope.messageId,
    roomId: envelope.roomId,
    authorId: envelope.authorId,
    authorKind: "human",
    createdAt: envelope.createdAt,
    lifecycle: "recalled",
    recalledAt: envelope.recalledAt,
    revisionCount: envelope.revisionCount,
  });
  if (!isTimelineMessage(projection)) reject("invalid_projection");
  return projection;
}

function projectAgentMessage(source: OperationalAgentMessageSource): AgentFinalMessage {
  const { envelope, sourceLineage, citations, correction } = source;
  if (envelope.authorKind !== "agent" || envelope.lifecycle !== "active" ||
      envelope.recalledAt !== null ||
      (envelope.messageKind !== "agent-final" && envelope.messageKind !== "agent-correction") ||
      envelope.currentRevision !== 1 || envelope.revisionCount !== 1 ||
      !isMessageRevision(source.finalRevision) ||
      !isAgentSourceLineageRow(sourceLineage) ||
      !(correction === null || isAgentCorrectionRow(correction))) {
    reject("invalid_source");
  }
  const isCorrection = envelope.messageKind === "agent-correction";
  if (isCorrection !== (correction !== null)) reject("invalid_source");
  if (sourceLineage.messageId !== envelope.messageId ||
      sourceLineage.roomId !== envelope.roomId ||
      source.finalRevision.messageId !== envelope.messageId ||
      source.finalRevision.revision !== 1 ||
      source.finalRevision.revisedByActorId !== envelope.authorId ||
      source.finalRevision.revisedAt !== envelope.createdAt ||
      (correction !== null && (
        correction.correctionMessageId !== envelope.messageId ||
        correction.roomId !== envelope.roomId ||
        correction.agentActorId !== envelope.authorId
      ))) {
    reject("invalid_projection");
  }

  const frozenCitations = Object.freeze(citations.map((citation) => Object.freeze({
    ordinal: citation.ordinal,
    sourceKind: citation.sourceKind,
    sourceId: citation.sourceId,
    sourceRevision: citation.sourceRevision,
  })));
  const projection: AgentFinalMessage = Object.freeze({
    id: envelope.messageId,
    roomId: envelope.roomId,
    authorId: envelope.authorId,
    authorKind: "agent",
    createdAt: envelope.createdAt,
    lifecycle: "active",
    finalBody: source.finalRevision.body,
    sourceInvocationIntentId: sourceLineage.invocationIntentId,
    sourceExecutionId: sourceLineage.executionId,
    citations: frozenCitations,
    ...(correction === null ? {} : { correctsMessageId: correction.correctsMessageId }),
  });
  if (!isTimelineMessage(projection)) reject("invalid_projection");
  return projection;
}

export function projectOperationalTimelineMessage(
  value: OperationalMessageProjectionSource,
): TimelineMessage {
  if (!isRecord(value) || typeof value.kind !== "string") reject("invalid_source");
  if (value.kind === "active-human") {
    if (!hasExactKeys(value, [
      "kind", "envelope", "currentRevision", "mentionedTargets", "targetOutcomes",
      "reply", "attachments",
    ]) || !isEnvelopeRow(value.envelope)) reject("invalid_source");
    return projectActiveHuman(value as OperationalActiveHumanSource);
  }
  if (value.kind === "recalled-human") {
    if (!hasExactKeys(value, ["kind", "envelope"]) || !isEnvelopeRow(value.envelope)) {
      reject("invalid_source");
    }
    return projectRecalledHuman(value as OperationalRecalledHumanSource);
  }
  if (value.kind === "agent-message") {
    if (!hasExactKeys(value, [
      "kind", "envelope", "finalRevision", "sourceLineage", "citations", "correction",
    ]) || !isEnvelopeRow(value.envelope)) reject("invalid_source");
    return projectAgentMessage(value as OperationalAgentMessageSource);
  }
  return reject("invalid_source");
}

function isEventRow(value: unknown): value is OperationalMessageEventRow {
  return isRecord(value) && hasExactKeys(value, [
    "eventId", "streamKind", "streamId", "streamSeq", "roomId", "type", "actorId",
    "occurredAt",
  ]) && isIdentifier(value.eventId) && value.streamKind === "room" &&
    isIdentifier(value.streamId) && isPositiveSafeInteger(value.streamSeq) &&
    isIdentifier(value.roomId) &&
    (value.type === "room.message.accepted" || value.type === "room.message.revised" ||
      value.type === "room.message.recalled") &&
    isIdentifier(value.actorId) && typeof value.occurredAt === "string";
}

export function projectOperationalMessageAuthorityEvent(
  row: OperationalMessageEventRow,
  source: OperationalMessageProjectionSource,
): MessageAuthorityEvent {
  if (!isEventRow(row)) reject("invalid_event");
  const payload = projectOperationalTimelineMessage(source);
  const event = Object.freeze({ ...row, payload });
  if (!isMessageAuthorityEvent(event)) reject("invalid_event");
  return event;
}

export function projectOperationalMessageRepairRecord(
  source: OperationalMessageProjectionSource,
): Extract<MessageAuthorityRepairRecord, { readonly kind: "timeline-message" }> {
  const value = projectOperationalTimelineMessage(source);
  const record = Object.freeze({ kind: "timeline-message" as const, value });
  if (!isMessageAuthorityRepairRecord(record, value.roomId)) reject("invalid_projection");
  return record;
}
