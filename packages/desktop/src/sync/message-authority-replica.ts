import {
  isMessageAuthorityEvent,
  isMessageAuthorityRepairRecord,
  type ActiveHumanMessage,
  type AgentFinalMessage,
  type AttachmentReference,
  type MentionTarget,
  type MessageAuthorityEvent,
  type MessageAuthorityRepairRecord,
  type MessageRevision,
  type MessageTargetOutcome,
  type MessageTombstone,
  type TimelineMessage,
} from "@native-im/core";

export type MessageAuthorityReplicaFailureReason =
  | "invalid_room"
  | "invalid_event"
  | "event_conflict"
  | "event_gap"
  | "revision_regression"
  | "immutable_source_changed"
  | "immutable_message_conflict"
  | "room_read_only"
  | "room_locked"
  | "repair_in_progress"
  | "invalid_repair"
  | "repair_not_active"
  | "audit_record_forbidden";

export class MessageAuthorityReplicaError extends Error {
  readonly reason: MessageAuthorityReplicaFailureReason;

  constructor(reason: MessageAuthorityReplicaFailureReason) {
    super(`Message authority replica rejected: ${reason}`);
    this.name = "MessageAuthorityReplicaError";
    this.reason = reason;
  }
}

export type MessageAuthorityReplicaMode =
  | "online"
  | "offline-read-only"
  | "repairing"
  | "locked";

export type MessageAuthorityEventLedgerEntry = Readonly<{
  eventId: string;
  streamSeq: number;
}>;

export type MessageAuthorityCursorAdvance = Readonly<{
  eventId: string;
  streamSeq: number;
}>;

export type MessageAuthorityRepairStage = Readonly<{
  snapshotId: string;
  watermark: number;
  generation: number;
  timeline: readonly TimelineMessage[];
}>;

export type MessageAuthorityReplica = Readonly<{
  roomId: string;
  mode: MessageAuthorityReplicaMode;
  generation: number;
  checkpoint: number;
  afterSeq: number;
  timeline: readonly TimelineMessage[];
  eventLedger: readonly MessageAuthorityEventLedgerEntry[];
  repair?: MessageAuthorityRepairStage;
}>;

export type BeginMessageAuthorityRepairInput = Readonly<{
  snapshotId: string;
  watermark: number;
  generation: number;
}>;

export type CommitMessageAuthorityRepairInput = BeginMessageAuthorityRepairInput;

export type FailMessageAuthorityRepairInput = Readonly<{
  snapshotId: string;
  authorization: "retained" | "revoked";
}>;

type TimelineRepairRecord = Extract<
  MessageAuthorityRepairRecord,
  { readonly kind: "timeline-message" }
>;

function reject(reason: MessageAuthorityReplicaFailureReason): never {
  throw new MessageAuthorityReplicaError(reason);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim();
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cloneRevision(value: MessageRevision): MessageRevision {
  return Object.freeze({
    messageId: value.messageId,
    revision: value.revision,
    body: value.body,
    revisedAt: value.revisedAt,
    revisedByActorId: value.revisedByActorId,
  });
}

function cloneMention(value: MentionTarget): MentionTarget {
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

function cloneAttachment(value: AttachmentReference): AttachmentReference {
  return Object.freeze({ attachmentId: value.attachmentId });
}

function cloneOutcome(value: MessageTargetOutcome): MessageTargetOutcome {
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

function cloneHuman(value: ActiveHumanMessage): ActiveHumanMessage {
  return Object.freeze({
    id: value.id,
    roomId: value.roomId,
    authorId: value.authorId,
    authorKind: "human",
    createdAt: value.createdAt,
    lifecycle: "active",
    currentRevision: cloneRevision(value.currentRevision),
    revisionCount: value.revisionCount,
    mentionedTargets: Object.freeze(value.mentionedTargets.map(cloneMention)),
    ...(value.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: value.replyToMessageId }),
    attachments: Object.freeze(value.attachments.map(cloneAttachment)),
    targetOutcomes: Object.freeze(value.targetOutcomes.map(cloneOutcome)),
  });
}

function cloneAgent(value: AgentFinalMessage): AgentFinalMessage {
  return Object.freeze({
    id: value.id,
    roomId: value.roomId,
    authorId: value.authorId,
    authorKind: "agent",
    createdAt: value.createdAt,
    lifecycle: "active",
    finalBody: value.finalBody,
    sourceInvocationIntentId: value.sourceInvocationIntentId,
    sourceExecutionId: value.sourceExecutionId,
    ...(value.correctsMessageId === undefined
      ? {}
      : { correctsMessageId: value.correctsMessageId }),
  });
}

function cloneTombstone(value: MessageTombstone): MessageTombstone {
  return Object.freeze({
    id: value.id,
    roomId: value.roomId,
    authorId: value.authorId,
    authorKind: "human",
    createdAt: value.createdAt,
    lifecycle: "recalled",
    recalledAt: value.recalledAt,
    revisionCount: value.revisionCount,
  });
}

function cloneTimelineMessage(value: TimelineMessage): TimelineMessage {
  if (value.lifecycle === "recalled") return cloneTombstone(value);
  return value.authorKind === "human" ? cloneHuman(value) : cloneAgent(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Message authority state contained a non-canonical value");
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function freezeLedger(
  values: readonly MessageAuthorityEventLedgerEntry[],
): readonly MessageAuthorityEventLedgerEntry[] {
  return Object.freeze(values.map((value) => Object.freeze({
    eventId: value.eventId,
    streamSeq: value.streamSeq,
  })));
}

function freezeTimeline(values: readonly TimelineMessage[]): readonly TimelineMessage[] {
  return Object.freeze(values.map(cloneTimelineMessage));
}

function freezeStage(value: MessageAuthorityRepairStage): MessageAuthorityRepairStage {
  return Object.freeze({
    snapshotId: value.snapshotId,
    watermark: value.watermark,
    generation: value.generation,
    timeline: freezeTimeline(value.timeline),
  });
}

function freezeReplica(value: MessageAuthorityReplica): MessageAuthorityReplica {
  return Object.freeze({
    roomId: value.roomId,
    mode: value.mode,
    generation: value.generation,
    checkpoint: value.checkpoint,
    afterSeq: value.afterSeq,
    timeline: freezeTimeline(value.timeline),
    eventLedger: freezeLedger(value.eventLedger),
    ...(value.repair === undefined ? {} : { repair: freezeStage(value.repair) }),
  });
}

function assertMutableAuthorityMode(replica: MessageAuthorityReplica): void {
  if (replica.mode === "offline-read-only") reject("room_read_only");
  if (replica.mode === "locked") reject("room_locked");
  if (replica.mode === "repairing") reject("repair_in_progress");
}

function frozenHumanSource(value: ActiveHumanMessage): unknown {
  return {
    id: value.id,
    roomId: value.roomId,
    authorId: value.authorId,
    authorKind: value.authorKind,
    createdAt: value.createdAt,
    mentionedTargets: value.mentionedTargets,
    replyToMessageId: value.replyToMessageId ?? null,
    attachments: value.attachments,
    targetOutcomes: value.targetOutcomes,
  };
}

function assertCorrectionSource(
  timeline: readonly TimelineMessage[],
  value: AgentFinalMessage,
): void {
  if (value.correctsMessageId === undefined) return;
  const source = timeline.find(({ id }) => id === value.correctsMessageId);
  if (source === undefined || source.lifecycle !== "active" || source.authorKind !== "agent" ||
      source.roomId !== value.roomId || source.authorId !== value.authorId) {
    reject("immutable_source_changed");
  }
}

function reduceTimeline(
  timeline: readonly TimelineMessage[],
  event: MessageAuthorityEvent,
): readonly TimelineMessage[] {
  const existingIndex = timeline.findIndex(({ id }) => id === event.payload.id);
  const existing = existingIndex < 0 ? undefined : timeline[existingIndex];

  if (event.type === "room.message.accepted") {
    if (existing !== undefined) reject("immutable_message_conflict");
    if (event.payload.authorKind === "agent") assertCorrectionSource(timeline, event.payload);
    return freezeTimeline([...timeline, event.payload]);
  }

  if (event.type === "room.message.revised") {
    if (existing === undefined || existing.lifecycle !== "active" ||
        existing.authorKind !== "human") {
      reject("immutable_source_changed");
    }
    if (!sameValue(frozenHumanSource(existing), frozenHumanSource(event.payload))) {
      reject("immutable_source_changed");
    }
    if (event.payload.currentRevision.revision <= existing.currentRevision.revision) {
      reject("revision_regression");
    }
    const next = [...timeline];
    next[existingIndex] = event.payload;
    return freezeTimeline(next);
  }

  if (existing === undefined || existing.lifecycle !== "active" ||
      existing.authorKind !== "human" || existing.roomId !== event.payload.roomId ||
      existing.authorId !== event.payload.authorId || existing.createdAt !== event.payload.createdAt ||
      existing.revisionCount !== event.payload.revisionCount) {
    reject("immutable_source_changed");
  }
  const next = [...timeline];
  next[existingIndex] = event.payload;
  return freezeTimeline(next);
}

export type MessageAuthorityReplicaSeed = Readonly<{
  generation: number;
  checkpoint: number;
  timeline: readonly TimelineMessage[];
}>;

export function createMessageAuthorityReplica(
  roomId: string,
  seed?: MessageAuthorityReplicaSeed,
): MessageAuthorityReplica {
  if (!isIdentifier(roomId)) reject("invalid_room");
  if (seed !== undefined && (!isPositiveSafeInteger(seed.generation) ||
      !isNonNegativeSafeInteger(seed.checkpoint) ||
      seed.timeline.some((message) => message.roomId !== roomId))) {
    reject("invalid_repair");
  }
  if (seed !== undefined) validateCommittedTimeline(seed.timeline);
  return freezeReplica({
    roomId,
    mode: "online",
    generation: seed?.generation ?? 1,
    checkpoint: seed?.checkpoint ?? 0,
    afterSeq: seed?.checkpoint ?? 0,
    timeline: seed?.timeline ?? [],
    eventLedger: [],
  });
}

export function applyMessageAuthorityEvent(
  replica: MessageAuthorityReplica,
  event: MessageAuthorityEvent,
): MessageAuthorityReplica {
  assertMutableAuthorityMode(replica);
  if (!isMessageAuthorityEvent(event) || event.roomId !== replica.roomId) {
    reject("invalid_event");
  }

  const sameId = replica.eventLedger.find(({ eventId }) => eventId === event.eventId);
  if (sameId !== undefined) {
    if (sameId.streamSeq === event.streamSeq) return replica;
    reject("event_conflict");
  }
  const sameSequence = replica.eventLedger.find(({ streamSeq }) =>
    streamSeq === event.streamSeq);
  if (sameSequence !== undefined) reject("event_conflict");
  if (event.streamSeq <= replica.checkpoint) return replica;
  if (event.streamSeq <= replica.afterSeq) reject("event_conflict");
  if (event.streamSeq !== replica.afterSeq + 1) reject("event_gap");

  const timeline = reduceTimeline(replica.timeline, event);
  return freezeReplica({
    ...replica,
    afterSeq: event.streamSeq,
    timeline,
    eventLedger: [
      ...replica.eventLedger,
      { eventId: event.eventId, streamSeq: event.streamSeq },
    ],
  });
}

export function advanceMessageAuthorityCursor(
  replica: MessageAuthorityReplica,
  input: MessageAuthorityCursorAdvance,
): MessageAuthorityReplica {
  assertMutableAuthorityMode(replica);
  if (!isIdentifier(input.eventId) || !isPositiveSafeInteger(input.streamSeq)) {
    reject("invalid_event");
  }

  const sameId = replica.eventLedger.find(({ eventId }) => eventId === input.eventId);
  if (sameId !== undefined) {
    if (sameId.streamSeq === input.streamSeq) return replica;
    reject("event_conflict");
  }
  const sameSequence = replica.eventLedger.find(({ streamSeq }) =>
    streamSeq === input.streamSeq);
  if (sameSequence !== undefined) reject("event_conflict");
  if (input.streamSeq <= replica.checkpoint) return replica;
  if (input.streamSeq <= replica.afterSeq) reject("event_conflict");
  if (input.streamSeq !== replica.afterSeq + 1) reject("event_gap");

  return freezeReplica({
    ...replica,
    afterSeq: input.streamSeq,
    eventLedger: [
      ...replica.eventLedger,
      { eventId: input.eventId, streamSeq: input.streamSeq },
    ],
  });
}

function assertRepairInput(
  replica: MessageAuthorityReplica,
  input: BeginMessageAuthorityRepairInput,
): void {
  if (!isIdentifier(input.snapshotId) || !isNonNegativeSafeInteger(input.watermark) ||
      !isPositiveSafeInteger(input.generation) || input.generation <= replica.generation) {
    reject("invalid_repair");
  }
}

export function beginMessageAuthorityRepair(
  replica: MessageAuthorityReplica,
  input: BeginMessageAuthorityRepairInput,
): MessageAuthorityReplica {
  assertMutableAuthorityMode(replica);
  assertRepairInput(replica, input);
  return freezeReplica({
    ...replica,
    mode: "repairing",
    repair: {
      snapshotId: input.snapshotId,
      watermark: input.watermark,
      generation: input.generation,
      timeline: [],
    },
  });
}

function activeRepair(
  replica: MessageAuthorityReplica,
  snapshotId: string,
): MessageAuthorityRepairStage {
  if (replica.mode !== "repairing" || replica.repair === undefined) {
    reject("repair_not_active");
  }
  if (replica.repair.snapshotId !== snapshotId) reject("invalid_repair");
  return replica.repair;
}

function isTimelineRepairRecord(value: unknown): value is TimelineRepairRecord {
  return isMessageAuthorityRepairRecord(value) && value.kind === "timeline-message";
}

export function stageMessageAuthorityRepairRecord(
  replica: MessageAuthorityReplica,
  snapshotId: string,
  record: MessageAuthorityRepairRecord,
): MessageAuthorityReplica {
  const repair = activeRepair(replica, snapshotId);
  if (isMessageAuthorityRepairRecord(record) && record.kind === "message-revision") {
    reject("audit_record_forbidden");
  }
  if (!isTimelineRepairRecord(record) || record.value.roomId !== replica.roomId) {
    reject("invalid_repair");
  }
  if (repair.timeline.some(({ id }) => id === record.value.id)) reject("invalid_repair");
  return freezeReplica({
    ...replica,
    repair: {
      ...repair,
      timeline: [...repair.timeline, record.value],
    },
  });
}

function validateCommittedTimeline(timeline: readonly TimelineMessage[]): void {
  const ids = new Set<string>();
  for (const message of timeline) {
    if (ids.has(message.id)) reject("invalid_repair");
    ids.add(message.id);
  }
  for (const message of timeline) {
    if (message.lifecycle === "active" && message.authorKind === "agent" &&
        message.correctsMessageId !== undefined) {
      assertCorrectionSource(timeline, message);
    }
  }
}

export function commitMessageAuthorityRepair(
  replica: MessageAuthorityReplica,
  input: CommitMessageAuthorityRepairInput,
): MessageAuthorityReplica {
  const repair = activeRepair(replica, input.snapshotId);
  if (repair.watermark !== input.watermark || repair.generation !== input.generation) {
    reject("invalid_repair");
  }
  validateCommittedTimeline(repair.timeline);
  return freezeReplica({
    roomId: replica.roomId,
    mode: "online",
    generation: repair.generation,
    checkpoint: repair.watermark,
    afterSeq: repair.watermark,
    timeline: repair.timeline,
    eventLedger: [],
  });
}

export function failMessageAuthorityRepair(
  replica: MessageAuthorityReplica,
  input: FailMessageAuthorityRepairInput,
): MessageAuthorityReplica {
  activeRepair(replica, input.snapshotId);
  if (input.authorization === "revoked") return revokeMessageAuthorityRoom(replica);
  return freezeReplica({
    roomId: replica.roomId,
    mode: "online",
    generation: replica.generation,
    checkpoint: replica.checkpoint,
    afterSeq: replica.afterSeq,
    timeline: replica.timeline,
    eventLedger: replica.eventLedger,
  });
}

export function markMessageAuthorityOfflineReadOnly(
  replica: MessageAuthorityReplica,
): MessageAuthorityReplica {
  if (replica.mode === "locked") reject("room_locked");
  if (replica.mode === "repairing") reject("repair_in_progress");
  if (replica.mode === "offline-read-only") return replica;
  return freezeReplica({ ...replica, mode: "offline-read-only" });
}

export function revokeMessageAuthorityRoom(
  replica: MessageAuthorityReplica,
): MessageAuthorityReplica {
  return freezeReplica({
    roomId: replica.roomId,
    mode: "locked",
    generation: replica.generation,
    checkpoint: 0,
    afterSeq: 0,
    timeline: [],
    eventLedger: [],
  });
}
