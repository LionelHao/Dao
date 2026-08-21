export const MESSAGE_AUTHORITY_LIMITS = Object.freeze({
  identifierUtf16: 256,
  bodyUtf16: 32 * 1_024,
  targets: 64,
  attachments: 64,
  targetOutcomes: 64,
  citations: 128,
});

export type Utf16Range = Readonly<{
  startUtf16: number;
  endUtf16: number;
}>;

export type MentionTargetKind = "human-request" | "agent-invocation";

export type MentionTarget =
  | Readonly<{
      id: string;
      kind: "human-request";
      targetActorId: string;
      range: Utf16Range;
    }>
  | Readonly<{
      id: string;
      kind: "agent-invocation";
      targetActorId: string;
      range: Utf16Range;
    }>;

export type AttachmentReference = Readonly<{
  attachmentId: string;
}>;

export type HumanMessageSubmit = Readonly<{
  messageId: string;
  roomId: string;
  body: string;
  mentionedTargets: readonly MentionTarget[];
  replyToMessageId?: string;
  attachments: readonly AttachmentReference[];
  authorId?: never;
  authorActorId?: never;
  authorKind?: never;
  actorId?: never;
  principal?: never;
  session?: never;
  sessionFamilyId?: never;
  capability?: never;
  runtimeKind?: never;
  provider?: never;
  model?: never;
}>;

export type HumanMessageSubmitLinkContext = Readonly<{
  expectedRoomId?: string;
  replyTargetRoomId?: string;
}>;

export type MessageTargetRejectionCode =
  | "target_not_member"
  | "target_kind_mismatch"
  | "target_assignment_inactive"
  | "target_room_archived";

export type MessageLifecycle = "active" | "recalled";

export type MessageTargetOutcome =
  | Readonly<{
      targetId: string;
      targetActorId: string;
      kind: "human-request";
      status: "request-created";
      requestIntentId: string;
    }>
  | Readonly<{
      targetId: string;
      targetActorId: string;
      kind: "agent-invocation";
      status: "invocation-intent-created";
      invocationIntentId: string;
    }>
  | Readonly<{
      targetId: string;
      targetActorId: string;
      kind: MentionTargetKind;
      status: "rejected";
      code: MessageTargetRejectionCode;
    }>;

export type MessageRevision = Readonly<{
  messageId: string;
  revision: number;
  body: string;
  revisedAt: string;
  revisedByActorId: string;
}>;

export type ActiveHumanMessage = Readonly<{
  id: string;
  roomId: string;
  authorId: string;
  authorKind: "human";
  createdAt: string;
  lifecycle: "active";
  currentRevision: MessageRevision;
  revisionCount: number;
  mentionedTargets: readonly MentionTarget[];
  replyToMessageId?: string;
  attachments: readonly AttachmentReference[];
  targetOutcomes: readonly MessageTargetOutcome[];
}>;

export type AgentFinalMessage = Readonly<{
  id: string;
  roomId: string;
  authorId: string;
  authorKind: "agent";
  createdAt: string;
  lifecycle: "active";
  finalBody: string;
  sourceInvocationIntentId: string;
  sourceExecutionId: string;
  citations: readonly AgentMessageCitation[];
  correctsMessageId?: string;
}>;

export type AgentMessageCitationSourceKind =
  | "message"
  | "message_revision"
  | "message_tombstone"
  | "attachment_extraction"
  | "memory"
  | "project_fact_checkpoint"
  | "delta_range";

export type AgentMessageCitation = Readonly<{
  ordinal: number;
  sourceKind: AgentMessageCitationSourceKind;
  sourceId: string;
  sourceRevision: number;
}>;

export type AgentFinalMessageLinkContext = Readonly<{
  expectedRoomId?: string;
  sourceInvocationRoomId?: string;
  sourceExecutionRoomId?: string;
  correctionTargetRoomId?: string;
  correctionTargetAuthorId?: string;
}>;

export type MessageTombstone = Readonly<{
  id: string;
  roomId: string;
  authorId: string;
  authorKind: "human";
  createdAt: string;
  lifecycle: "recalled";
  recalledAt: string;
  revisionCount: number;
}>;

export type TimelineMessage = ActiveHumanMessage | AgentFinalMessage | MessageTombstone;

type MessageRoomEvent<TType extends string, TPayload extends TimelineMessage> = Readonly<{
  eventId: string;
  streamKind: "room";
  streamId: string;
  streamSeq: number;
  roomId: string;
  type: TType;
  actorId: string;
  occurredAt: string;
  payload: TPayload;
}>;

export type MessageAuthorityEvent =
  | MessageRoomEvent<"room.message.accepted", ActiveHumanMessage | AgentFinalMessage>
  | MessageRoomEvent<"room.message.revised", ActiveHumanMessage>
  | MessageRoomEvent<"room.message.recalled", MessageTombstone>;

export type MessageAuthorityRepairRecord =
  | Readonly<{ kind: "timeline-message"; value: TimelineMessage }>
  | Readonly<{ kind: "message-revision"; roomId: string; value: MessageRevision }>;

type UnknownRecord = Record<string, unknown>;

const mentionKinds = new Set<MentionTargetKind>(["human-request", "agent-invocation"]);
const rejectionCodes = new Set<MessageTargetRejectionCode>([
  "target_not_member",
  "target_kind_mismatch",
  "target_assignment_inactive",
  "target_room_archived",
]);
const citationSourceKinds = new Set<AgentMessageCitationSourceKind>([
  "message",
  "message_revision",
  "message_tombstone",
  "attachment_extraction",
  "memory",
  "project_fact_checkpoint",
  "delta_range",
]);
const canonicalUtcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MESSAGE_AUTHORITY_LIMITS.identifierUtf16 && value === value.trim();
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isWellFormedText(value: unknown, maximumUtf16: number): value is string {
  return typeof value === "string" && value.length <= maximumUtf16 && hasWellFormedUtf16(value);
}

function isMessageBody(value: unknown): value is string {
  return isWellFormedText(value, MESSAGE_AUTHORITY_LIMITS.bodyUtf16) && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isUtf16Boundary(body: string, index: number): boolean {
  if (index <= 0 || index >= body.length) return true;
  const previous = body.charCodeAt(index - 1);
  const current = body.charCodeAt(index);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

function occurredNoEarlierThan(later: string, earlier: string): boolean {
  return Date.parse(later) >= Date.parse(earlier);
}

export function isIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !canonicalUtcTimestamp.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function isUtf16Range(value: unknown, body?: string): value is Utf16Range {
  if (!isRecord(value) || !hasExactKeys(value, ["startUtf16", "endUtf16"]) ||
      typeof value.startUtf16 !== "number" || !Number.isSafeInteger(value.startUtf16) ||
      typeof value.endUtf16 !== "number" || !Number.isSafeInteger(value.endUtf16) ||
      value.startUtf16 < 0 || value.endUtf16 <= value.startUtf16) {
    return false;
  }
  if (body === undefined) return true;
  return hasWellFormedUtf16(body) && value.endUtf16 <= body.length &&
    isUtf16Boundary(body, value.startUtf16) && isUtf16Boundary(body, value.endUtf16);
}

export function isMentionTarget(value: unknown, body?: string): value is MentionTarget {
  return isRecord(value) && hasExactKeys(value, ["id", "kind", "targetActorId", "range"]) &&
    isIdentifier(value.id) && mentionKinds.has(value.kind as MentionTargetKind) &&
    isIdentifier(value.targetActorId) && isUtf16Range(value.range, body);
}

export function isAttachmentReference(value: unknown): value is AttachmentReference {
  return isRecord(value) && hasExactKeys(value, ["attachmentId"]) &&
    isIdentifier(value.attachmentId);
}

function areMentionTargetsValid(value: unknown, body: string): value is readonly MentionTarget[] {
  if (!Array.isArray(value) || value.length > MESSAGE_AUTHORITY_LIMITS.targets) return false;
  const ids = new Set<string>();
  const semanticTargets = new Set<string>();
  let previousEnd = 0;
  for (const target of value) {
    if (!isMentionTarget(target, body) || target.range.startUtf16 < previousEnd ||
        ids.has(target.id) || semanticTargets.has(`${target.kind}\u0000${target.targetActorId}`)) {
      return false;
    }
    ids.add(target.id);
    semanticTargets.add(`${target.kind}\u0000${target.targetActorId}`);
    previousEnd = target.range.endUtf16;
  }
  return true;
}

function areAttachmentsValid(value: unknown): value is readonly AttachmentReference[] {
  if (!Array.isArray(value) || value.length > MESSAGE_AUTHORITY_LIMITS.attachments) return false;
  const ids = new Set<string>();
  for (const attachment of value) {
    if (!isAttachmentReference(attachment) || ids.has(attachment.attachmentId)) return false;
    ids.add(attachment.attachmentId);
  }
  return true;
}

export function isHumanMessageSubmit(
  value: unknown,
  linkContext: HumanMessageSubmitLinkContext = {},
): value is HumanMessageSubmit {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["messageId", "roomId", "body", "mentionedTargets", "attachments"],
    ["replyToMessageId"],
  ) || !isIdentifier(value.messageId) || !isIdentifier(value.roomId) ||
      !isMessageBody(value.body) || !areMentionTargetsValid(value.mentionedTargets, value.body) ||
      !areAttachmentsValid(value.attachments)) {
    return false;
  }
  if (value.replyToMessageId !== undefined && !isIdentifier(value.replyToMessageId)) return false;
  if (linkContext.expectedRoomId !== undefined &&
      (!isIdentifier(linkContext.expectedRoomId) || linkContext.expectedRoomId !== value.roomId)) {
    return false;
  }
  if (linkContext.replyTargetRoomId !== undefined) {
    return value.replyToMessageId !== undefined && isIdentifier(linkContext.replyTargetRoomId) &&
      linkContext.replyTargetRoomId === value.roomId;
  }
  return true;
}

export function isMessageTargetOutcome(value: unknown): value is MessageTargetOutcome {
  if (!isRecord(value) || !isIdentifier(value.targetId) ||
      !isIdentifier(value.targetActorId) || !mentionKinds.has(value.kind as MentionTargetKind)) {
    return false;
  }
  if (value.status === "request-created") {
    return value.kind === "human-request" &&
      hasExactKeys(value, ["targetId", "targetActorId", "kind", "status", "requestIntentId"]) &&
      isIdentifier(value.requestIntentId);
  }
  if (value.status === "invocation-intent-created") {
    return value.kind === "agent-invocation" &&
      hasExactKeys(value, ["targetId", "targetActorId", "kind", "status", "invocationIntentId"]) &&
      isIdentifier(value.invocationIntentId);
  }
  return value.status === "rejected" &&
    hasExactKeys(value, ["targetId", "targetActorId", "kind", "status", "code"]) &&
    rejectionCodes.has(value.code as MessageTargetRejectionCode);
}

export function isMessageRevision(value: unknown): value is MessageRevision {
  return isRecord(value) && hasExactKeys(
    value,
    ["messageId", "revision", "body", "revisedAt", "revisedByActorId"],
  ) && isIdentifier(value.messageId) && isPositiveSafeInteger(value.revision) &&
    isMessageBody(value.body) && isIsoUtcTimestamp(value.revisedAt) &&
    isIdentifier(value.revisedByActorId);
}

function doTargetOutcomesMatch(
  value: unknown,
  mentionedTargets: readonly MentionTarget[],
): value is readonly MessageTargetOutcome[] {
  if (!Array.isArray(value) || value.length > MESSAGE_AUTHORITY_LIMITS.targetOutcomes ||
      value.length !== mentionedTargets.length) {
    return false;
  }
  const outcomes = new Map<string, MessageTargetOutcome>();
  const semanticTargets = new Set<string>();
  for (const outcome of value) {
    if (!isMessageTargetOutcome(outcome) || outcomes.has(outcome.targetId) ||
        semanticTargets.has(`${outcome.kind}\u0000${outcome.targetActorId}`)) {
      return false;
    }
    outcomes.set(outcome.targetId, outcome);
    semanticTargets.add(`${outcome.kind}\u0000${outcome.targetActorId}`);
  }
  return mentionedTargets.every((target) => {
    const outcome = outcomes.get(target.id);
    return outcome !== undefined && outcome.kind === target.kind &&
      outcome.targetActorId === target.targetActorId;
  });
}

export function isActiveHumanMessage(value: unknown): value is ActiveHumanMessage {
  if (!isRecord(value) || !hasExactKeys(
    value,
    [
      "id", "roomId", "authorId", "authorKind", "createdAt", "lifecycle",
      "currentRevision", "revisionCount", "mentionedTargets", "attachments", "targetOutcomes",
    ],
    ["replyToMessageId"],
  ) || !isIdentifier(value.id) || !isIdentifier(value.roomId) || !isIdentifier(value.authorId) ||
      value.authorKind !== "human" || value.lifecycle !== "active" ||
      !isIsoUtcTimestamp(value.createdAt) || !isMessageRevision(value.currentRevision) ||
      value.currentRevision.messageId !== value.id || !isPositiveSafeInteger(value.revisionCount) ||
      value.currentRevision.revision !== value.revisionCount ||
      value.currentRevision.revisedByActorId !== value.authorId ||
      !occurredNoEarlierThan(value.currentRevision.revisedAt, value.createdAt) ||
      !areMentionTargetsValid(value.mentionedTargets, value.currentRevision.body) ||
      !areAttachmentsValid(value.attachments) ||
      !doTargetOutcomesMatch(value.targetOutcomes, value.mentionedTargets)) {
    return false;
  }
  return value.replyToMessageId === undefined || isIdentifier(value.replyToMessageId);
}

export function isAgentFinalMessage(
  value: unknown,
  linkContext: AgentFinalMessageLinkContext = {},
): value is AgentFinalMessage {
  if (!isRecord(value) || !hasExactKeys(
    value,
    [
      "id", "roomId", "authorId", "authorKind", "createdAt", "lifecycle", "finalBody",
      "sourceInvocationIntentId", "sourceExecutionId", "citations",
    ],
    ["correctsMessageId"],
  ) || !isIdentifier(value.id) || !isIdentifier(value.roomId) || !isIdentifier(value.authorId) ||
      value.authorKind !== "agent" || value.lifecycle !== "active" ||
      !isIsoUtcTimestamp(value.createdAt) || !isMessageBody(value.finalBody) ||
      !isIdentifier(value.sourceInvocationIntentId) || !isIdentifier(value.sourceExecutionId) ||
      !areAgentMessageCitationsValid(value.citations)) {
    return false;
  }
  if (value.correctsMessageId !== undefined &&
      (!isIdentifier(value.correctsMessageId) || value.correctsMessageId === value.id)) {
    return false;
  }
  for (const sourceRoomId of [
    linkContext.expectedRoomId,
    linkContext.sourceInvocationRoomId,
    linkContext.sourceExecutionRoomId,
  ]) {
    if (sourceRoomId !== undefined && (!isIdentifier(sourceRoomId) || sourceRoomId !== value.roomId)) {
      return false;
    }
  }
  if (linkContext.correctionTargetRoomId !== undefined ||
      linkContext.correctionTargetAuthorId !== undefined) {
    return value.correctsMessageId !== undefined &&
      isIdentifier(linkContext.correctionTargetRoomId) &&
      linkContext.correctionTargetRoomId === value.roomId &&
      isIdentifier(linkContext.correctionTargetAuthorId) &&
      linkContext.correctionTargetAuthorId === value.authorId;
  }
  return true;
}

export function isAgentMessageCitation(value: unknown): value is AgentMessageCitation {
  return isRecord(value) && hasExactKeys(value, [
    "ordinal", "sourceKind", "sourceId", "sourceRevision",
  ]) && isPositiveSafeInteger(value.ordinal) &&
    citationSourceKinds.has(value.sourceKind as AgentMessageCitationSourceKind) &&
    isIdentifier(value.sourceId) && isPositiveSafeInteger(value.sourceRevision);
}

function areAgentMessageCitationsValid(value: unknown): value is readonly AgentMessageCitation[] {
  if (!Array.isArray(value) || value.length > MESSAGE_AUTHORITY_LIMITS.citations) return false;
  const identities = new Set<string>();
  return value.every((citation, index) => {
    if (!isAgentMessageCitation(citation) || citation.ordinal !== index + 1) return false;
    const identity = `${citation.sourceKind}\u0000${citation.sourceId}\u0000${citation.sourceRevision}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

export function isMessageTombstone(value: unknown): value is MessageTombstone {
  return isRecord(value) && hasExactKeys(
    value,
    [
      "id", "roomId", "authorId", "authorKind", "createdAt", "lifecycle", "recalledAt",
      "revisionCount",
    ],
  ) && isIdentifier(value.id) && isIdentifier(value.roomId) && isIdentifier(value.authorId) &&
    value.authorKind === "human" && value.lifecycle === "recalled" &&
    isIsoUtcTimestamp(value.createdAt) && isIsoUtcTimestamp(value.recalledAt) &&
    occurredNoEarlierThan(value.recalledAt, value.createdAt) &&
    isPositiveSafeInteger(value.revisionCount);
}

export function isTimelineMessage(value: unknown): value is TimelineMessage {
  return isActiveHumanMessage(value) || isAgentFinalMessage(value) || isMessageTombstone(value);
}

function messageAuthorityEventPayload(
  value: UnknownRecord,
): ActiveHumanMessage | AgentFinalMessage | MessageTombstone | undefined {
  if (value.type === "room.message.accepted" &&
      (isActiveHumanMessage(value.payload) || isAgentFinalMessage(value.payload))) {
    return value.payload;
  }
  if (value.type === "room.message.revised" && isActiveHumanMessage(value.payload)) {
    return value.payload;
  }
  if (value.type === "room.message.recalled" && isMessageTombstone(value.payload)) {
    return value.payload;
  }
  return undefined;
}

export function isMessageAuthorityEvent(value: unknown): value is MessageAuthorityEvent {
  if (!isRecord(value) || !hasExactKeys(value, [
    "eventId", "streamKind", "streamId", "streamSeq", "roomId", "type", "actorId",
    "occurredAt", "payload",
  ]) || !isIdentifier(value.eventId) || value.streamKind !== "room" ||
      !isIdentifier(value.streamId) || !isPositiveSafeInteger(value.streamSeq) ||
      !isIdentifier(value.roomId) || value.streamId !== value.roomId ||
      !isIdentifier(value.actorId) || !isIsoUtcTimestamp(value.occurredAt)) {
    return false;
  }
  const payload = messageAuthorityEventPayload(value);
  if (payload === undefined || payload.roomId !== value.roomId || payload.authorId !== value.actorId) {
    return false;
  }
  const authoritativeAt = payload.lifecycle === "recalled"
    ? payload.recalledAt
    : payload.authorKind === "human"
      ? payload.currentRevision.revisedAt
      : payload.createdAt;
  return occurredNoEarlierThan(value.occurredAt, authoritativeAt);
}

export function isMessageAuthorityRepairRecord(
  value: unknown,
  expectedRoomId?: string,
): value is MessageAuthorityRepairRecord {
  if (!isRecord(value)) return false;
  if (value.kind === "timeline-message") {
    if (!hasExactKeys(value, ["kind", "value"]) || !isTimelineMessage(value.value)) return false;
    return expectedRoomId === undefined || value.value.roomId === expectedRoomId;
  }
  if (value.kind === "message-revision") {
    if (!hasExactKeys(value, ["kind", "roomId", "value"]) ||
        !isIdentifier(value.roomId) || !isMessageRevision(value.value)) {
      return false;
    }
    return expectedRoomId === undefined || value.roomId === expectedRoomId;
  }
  return false;
}
