import {
  isHumanMessageSubmit,
  isMessageAuthorityEvent,
  isMessageRevision,
  isMessageTargetOutcome,
  isTimelineMessage,
  type HumanMessageSubmit,
  type MessageAuthorityEvent,
  type MessageRevision,
  type MessageTargetOutcome,
  type TimelineMessage,
} from "@native-im/core";
import type {
  MessageActorOption,
  MessageClosedError,
  MessageConnectionState,
} from "../renderer/message-authority/view-model.js";

export const MESSAGE_AUTHORITY_IPC_CHANNELS = Object.freeze({
  historyV2: "message-authority:history-v2",
  revisionsQuery: "message-authority:revisions-query",
  sendV2: "message-authority:send-v2",
  revise: "message-authority:revise",
  recall: "message-authority:recall",
  authorityInput: "message-authority:authority-input",
} as const);

export type MessageHistoryV2Query = Readonly<{
  type: "room.history.v2";
  roomId: string;
  afterMessageId?: string;
  limit?: number;
}>;

export type MessageRevisionsQuery = Readonly<{
  type: "message.revisions.query";
  roomId: string;
  messageId: string;
  afterRevision?: number;
  limit?: number;
}>;

export type MessageSendV2Intent = Readonly<{
  type: "message.send.v2";
  message: HumanMessageSubmit;
}>;

export type MessageReviseIntent = Readonly<{
  type: "message.revise";
  roomId: string;
  messageId: string;
  expectedRevision: number;
  body: string;
}>;

export type MessageRecallIntent = Readonly<{
  type: "message.recall";
  roomId: string;
  messageId: string;
  expectedRevision: number;
}>;

export type MessageHistoryV2Command = MessageHistoryV2Query & Readonly<{ requestId: string }>;
export type MessageRevisionsCommand = MessageRevisionsQuery & Readonly<{ requestId: string }>;
export type MessageSendV2Command = MessageSendV2Intent & Readonly<{ requestId: string }>;
export type MessageReviseCommand = MessageReviseIntent & Readonly<{ requestId: string }>;
export type MessageRecallCommand = MessageRecallIntent & Readonly<{ requestId: string }>;

export type MessageAuthorityReadyHistory = Readonly<{
  type: "room.history.v2";
  requestId: string;
  roomId: string;
  status: "ready";
  viewerActorId: string;
  lifecycle: "active" | "archived";
  connection: Exclude<MessageConnectionState, { readonly status: "revoked" | "fatal" }>;
  actors: readonly MessageActorOption[];
  messages: readonly TimelineMessage[];
  hasMore: boolean;
  generation: number;
  watermark: number;
}>;

export type MessageAuthorityLockedHistory = Readonly<{
  type: "room.history.v2";
  requestId: string;
  roomId: string;
  status: "locked";
  connection: Extract<MessageConnectionState, { readonly status: "revoked" | "fatal" }>;
}>;

export type MessageAuthorityHistoryResult =
  | MessageAuthorityReadyHistory
  | MessageAuthorityLockedHistory;

export type MessageRevisionsResult = Readonly<{
  type: "message.revisions";
  requestId: string;
  roomId: string;
  messageId: string;
  revisions: readonly MessageRevision[];
  hasMore: boolean;
}>;

export type MessageAcceptedResult = Readonly<{
  type: "message.accepted";
  requestId: string;
  messageId: string;
  persistedAt: string;
  targetOutcomes: readonly MessageTargetOutcome[];
}>;

export type MessageRevisionAcceptedResult = Readonly<{
  type: "message.revision.accepted";
  requestId: string;
  messageId: string;
  revision: number;
  persistedAt: string;
}>;

export type MessageRecallAcceptedResult = Readonly<{
  type: "message.recall.accepted";
  requestId: string;
  messageId: string;
  revision: number;
  recalledAt: string;
}>;

export type MessageAuthorityCommandReceipt = Readonly<{ requestId: string }>;

export type MessageAuthorityErrorInput = Readonly<{
  type: "message.error";
  requestId: string;
}> & MessageClosedError;

export type AgentExecutionPreviewInput = Readonly<{
  type: "agent.execution.preview";
  roomId: string;
  executionId: string;
  attemptSeq: number;
  streamSeq: number;
  delta: string;
  authoritative: false;
}>;

export type AgentExecutionPreviewResetInput = Readonly<{
  type: "agent.execution.preview.reset";
  roomId: string;
  executionId: string;
  attemptSeq: number;
  reason: "human_cancelled" | "message_recalled" | "runtime_shutdown" | "repair" | "reconnect";
  authoritative: false;
}>;

export type MessageAuthorityPortInput =
  | Readonly<{
      type: "room.event";
      cursorBefore: number;
      generation: number;
      event: MessageAuthorityEvent;
    }>
  | Readonly<{
      type: "room.cursor.advanced";
      roomId: string;
      cursorBefore: number;
      generation: number;
      eventId: string;
      streamSeq: number;
    }>
  | Readonly<{
      type: "message.connection";
      roomId: string;
      connection: MessageConnectionState;
    }>
  | Readonly<{
      type: "message.repair.completed";
      roomId: string;
      generation: number;
      watermark: number;
      messages: readonly TimelineMessage[];
      eventIds: readonly string[];
    }>
  | AgentExecutionPreviewInput
  | AgentExecutionPreviewResetInput;

export type MessageAuthorityBridgeInput =
  | MessageAcceptedResult
  | MessageRevisionAcceptedResult
  | MessageRecallAcceptedResult
  | MessageAuthorityErrorInput
  | MessageAuthorityPortInput;

export type MessageRevisionsQueryResult = MessageRevisionsResult | MessageAuthorityErrorInput;

export interface MessageAuthorityBridge {
  historyV2(query: MessageHistoryV2Query): Promise<MessageAuthorityHistoryResult>;
  revisionsQuery(query: MessageRevisionsQuery): Promise<MessageRevisionsQueryResult>;
  sendV2(intent: MessageSendV2Intent): Promise<MessageAuthorityCommandReceipt>;
  revise(intent: MessageReviseIntent): Promise<MessageAuthorityCommandReceipt>;
  recall(intent: MessageRecallIntent): Promise<MessageAuthorityCommandReceipt>;
  onAuthorityInput(listener: (input: MessageAuthorityBridgeInput) => void): () => void;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value === value.trim();
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function limit(value: unknown): value is number {
  return positive(value) && value <= 200;
}

function body(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 32 * 1_024;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

export function isMessageHistoryV2Query(value: unknown): value is MessageHistoryV2Query {
  return record(value) && keys(value, ["type", "roomId"], ["afterMessageId", "limit"]) &&
    value.type === "room.history.v2" && text(value.roomId) &&
    (value.afterMessageId === undefined || text(value.afterMessageId)) &&
    (value.limit === undefined || limit(value.limit));
}

export function isMessageRevisionsQuery(value: unknown): value is MessageRevisionsQuery {
  return record(value) && keys(
    value,
    ["type", "roomId", "messageId"],
    ["afterRevision", "limit"],
  ) && value.type === "message.revisions.query" && text(value.roomId) &&
    text(value.messageId) &&
    (value.afterRevision === undefined || positive(value.afterRevision)) &&
    (value.limit === undefined || limit(value.limit));
}

export function isMessageSendV2Intent(value: unknown): value is MessageSendV2Intent {
  return record(value) && keys(value, ["type", "message"]) &&
    value.type === "message.send.v2" && isHumanMessageSubmit(value.message);
}

export function isMessageReviseIntent(value: unknown): value is MessageReviseIntent {
  return record(value) && keys(value, [
    "type", "roomId", "messageId", "expectedRevision", "body",
  ]) && value.type === "message.revise" && text(value.roomId) && text(value.messageId) &&
    positive(value.expectedRevision) && body(value.body);
}

export function isMessageRecallIntent(value: unknown): value is MessageRecallIntent {
  return record(value) && keys(value, [
    "type", "roomId", "messageId", "expectedRevision",
  ]) && value.type === "message.recall" && text(value.roomId) && text(value.messageId) &&
    positive(value.expectedRevision);
}

function isActor(value: unknown): value is MessageActorOption {
  return record(value) && keys(value, [
    "actorId", "kind", "displayName", "secondaryLabel",
  ]) && text(value.actorId) && (value.kind === "human" || value.kind === "agent") &&
    text(value.displayName) && text(value.secondaryLabel);
}

export function isMessageConnectionState(value: unknown): value is MessageConnectionState {
  if (!record(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "online": return keys(value, ["status"]);
    case "offline": return keys(value, ["status", "asOf"]) && iso(value.asOf);
    case "repairing": return keys(value, ["status", "watermark"]) && count(value.watermark);
    case "repair-failed": return keys(value, ["status", "errorCode"]) && text(value.errorCode);
    case "revoked": return keys(value, ["status", "scope", "purgeCompleted"]) &&
      (value.scope === "room" || value.scope === "session") &&
      typeof value.purgeCompleted === "boolean";
    case "fatal": return keys(value, ["status", "errorCode"]) && text(value.errorCode);
    default: return false;
  }
}

export function isMessageAuthorityHistoryResult(
  value: unknown,
): value is MessageAuthorityHistoryResult {
  if (!record(value) || value.type !== "room.history.v2" || !text(value.requestId) ||
      !text(value.roomId) || !isMessageConnectionState(value.connection)) return false;
  if (value.status === "locked") {
    return keys(value, ["type", "requestId", "roomId", "status", "connection"]) &&
      (value.connection.status === "revoked" || value.connection.status === "fatal");
  }
  if (value.status !== "ready" || !keys(value, [
    "type", "requestId", "roomId", "status", "viewerActorId", "lifecycle", "connection",
    "actors", "messages", "hasMore", "generation", "watermark",
  ]) || !text(value.viewerActorId) ||
      (value.lifecycle !== "active" && value.lifecycle !== "archived") ||
      value.connection.status === "revoked" || value.connection.status === "fatal" ||
      !Array.isArray(value.actors) || value.actors.length > 512 || !value.actors.every(isActor) ||
      new Set(value.actors.map(({ actorId }) => actorId)).size !== value.actors.length ||
      !Array.isArray(value.messages) || value.messages.length > 1_000 ||
      !value.messages.every(isTimelineMessage) ||
      value.messages.some((message) => message.roomId !== value.roomId) ||
      new Set(value.messages.map((message) => message.id)).size !== value.messages.length ||
      typeof value.hasMore !== "boolean" || !positive(value.generation) ||
      !count(value.watermark)) return false;
  return true;
}

export function isMessageRevisionsResult(value: unknown): value is MessageRevisionsResult {
  return record(value) && keys(value, [
    "type", "requestId", "roomId", "messageId", "revisions", "hasMore",
  ]) && value.type === "message.revisions" && text(value.requestId) && text(value.roomId) &&
    text(value.messageId) && Array.isArray(value.revisions) && value.revisions.length <= 1_000 &&
    value.revisions.every(isMessageRevision) &&
    value.revisions.every((revision) => revision.messageId === value.messageId) &&
    typeof value.hasMore === "boolean";
}

export function isMessageClosedError(value: unknown): value is MessageClosedError {
  if (!record(value) || typeof value.status !== "number" || !text(value.code)) return false;
  const allowed: Record<number, ReadonlySet<string>> = {
    400: new Set(["invalid_request", "invalid_message", "mention_entity_invalid", "author_fields_forbidden"]),
    401: new Set(["unauthenticated", "identity_forbidden"]),
    403: new Set(["room_forbidden"]),
    404: new Set(["reply_target_not_found"]),
    409: new Set(["message_version_conflict", "message_recalled", "agent_final_immutable", "idempotency_conflict"]),
    410: new Set(["protocol_upgrade_required", "snapshot_expired"]),
    429: new Set(["rate_limited"]),
    503: new Set(["service_unavailable", "dependency_unavailable", "repair_unavailable"]),
  };
  return keys(value, ["status", "code"], value.status === 429 ? ["retryAfterSeconds"] : []) &&
    allowed[value.status]?.has(value.code) === true &&
    (value.retryAfterSeconds === undefined || count(value.retryAfterSeconds));
}

export function isMessageAuthorityErrorInput(value: unknown): value is MessageAuthorityErrorInput {
  return record(value) && keys(
    value,
    ["type", "requestId", "status", "code"],
    value.status === 429 ? ["retryAfterSeconds"] : [],
  ) && value.type === "message.error" && text(value.requestId) && isMessageClosedError({
    status: value.status,
    code: value.code,
    ...(value.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: value.retryAfterSeconds }),
  });
}

function isAccepted(value: unknown): value is MessageAcceptedResult {
  return record(value) && keys(value, [
    "type", "requestId", "messageId", "persistedAt", "targetOutcomes",
  ]) && value.type === "message.accepted" && text(value.requestId) && text(value.messageId) &&
    iso(value.persistedAt) && Array.isArray(value.targetOutcomes) &&
    value.targetOutcomes.length <= 64 && value.targetOutcomes.every(isMessageTargetOutcome);
}

function isRevisionAccepted(value: unknown): value is MessageRevisionAcceptedResult {
  return record(value) && keys(value, [
    "type", "requestId", "messageId", "revision", "persistedAt",
  ]) && value.type === "message.revision.accepted" && text(value.requestId) &&
    text(value.messageId) && positive(value.revision) && iso(value.persistedAt);
}

function isRecallAccepted(value: unknown): value is MessageRecallAcceptedResult {
  return record(value) && keys(value, [
    "type", "requestId", "messageId", "revision", "recalledAt",
  ]) && value.type === "message.recall.accepted" && text(value.requestId) &&
    text(value.messageId) && positive(value.revision) && iso(value.recalledAt);
}

export function isMessageAuthorityPortInput(value: unknown): value is MessageAuthorityPortInput {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "room.event") {
    return keys(value, ["type", "cursorBefore", "generation", "event"]) &&
      count(value.cursorBefore) && positive(value.generation) &&
      isMessageAuthorityEvent(value.event) && value.event.streamSeq === value.cursorBefore + 1;
  }
  if (value.type === "room.cursor.advanced") {
    return keys(value, [
      "type", "roomId", "cursorBefore", "generation", "eventId", "streamSeq",
    ]) && text(value.roomId) && count(value.cursorBefore) && positive(value.generation) &&
      text(value.eventId) && positive(value.streamSeq) &&
      value.streamSeq === value.cursorBefore + 1;
  }
  if (value.type === "message.connection") {
    return keys(value, ["type", "roomId", "connection"]) && text(value.roomId) &&
      isMessageConnectionState(value.connection);
  }
  if (value.type === "agent.execution.preview") {
    return keys(value, [
      "type", "roomId", "executionId", "attemptSeq", "streamSeq", "delta", "authoritative",
    ]) && text(value.roomId) && text(value.executionId) && positive(value.attemptSeq) &&
      positive(value.streamSeq) && typeof value.delta === "string" && value.delta.length > 0 &&
      new TextEncoder().encode(value.delta).byteLength <= 64 * 1_024 && value.authoritative === false;
  }
  if (value.type === "agent.execution.preview.reset") {
    return keys(value, [
      "type", "roomId", "executionId", "attemptSeq", "reason", "authoritative",
    ]) && text(value.roomId) && text(value.executionId) && positive(value.attemptSeq) &&
      (value.reason === "human_cancelled" || value.reason === "message_recalled" ||
        value.reason === "runtime_shutdown" || value.reason === "repair" ||
        value.reason === "reconnect") && value.authoritative === false;
  }
  return value.type === "message.repair.completed" && keys(value, [
    "type", "roomId", "generation", "watermark", "messages", "eventIds",
  ]) && text(value.roomId) && positive(value.generation) && count(value.watermark) &&
    Array.isArray(value.messages) && value.messages.length <= 1_000 &&
    value.messages.every(isTimelineMessage) &&
    value.messages.every((message) => message.roomId === value.roomId) &&
    Array.isArray(value.eventIds) && value.eventIds.length <= 1_000 &&
    value.eventIds.every(text) && new Set(value.eventIds).size === value.eventIds.length;
}

export function isMessageAuthorityBridgeInput(value: unknown): value is MessageAuthorityBridgeInput {
  return isAccepted(value) || isRevisionAccepted(value) || isRecallAccepted(value) ||
    isMessageAuthorityErrorInput(value) || isMessageAuthorityPortInput(value);
}

export function isMessageAuthorityCommandReceipt(
  value: unknown,
): value is MessageAuthorityCommandReceipt {
  return record(value) && keys(value, ["requestId"]) && text(value.requestId);
}

export function isMessageRevisionsQueryResult(
  value: unknown,
): value is MessageRevisionsQueryResult {
  return isMessageRevisionsResult(value) || isMessageAuthorityErrorInput(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function cloneMessageAuthorityHistoryResult(value: unknown): MessageAuthorityHistoryResult {
  if (!isMessageAuthorityHistoryResult(value)) {
    throw new TypeError("Message Authority history result is not closed");
  }
  return clone(value);
}

export function cloneMessageRevisionsQueryResult(value: unknown): MessageRevisionsQueryResult {
  if (!isMessageRevisionsQueryResult(value)) {
    throw new TypeError("Message Authority revisions result is not closed");
  }
  return clone(value);
}

export function cloneMessageAuthorityBridgeInput(value: unknown): MessageAuthorityBridgeInput {
  if (!isMessageAuthorityBridgeInput(value)) {
    throw new TypeError("Message Authority input is not closed");
  }
  return clone(value);
}

export function cloneMessageAuthorityCommandReceipt(value: unknown): MessageAuthorityCommandReceipt {
  if (!isMessageAuthorityCommandReceipt(value)) {
    throw new TypeError("Message Authority command receipt is not closed");
  }
  return clone(value);
}

export function cloneMessageAcceptedResult(value: unknown): MessageAcceptedResult {
  if (!isAccepted(value)) throw new TypeError("Message Authority ACK is not closed");
  return clone(value);
}

export function cloneMessageRevisionAcceptedResult(value: unknown): MessageRevisionAcceptedResult {
  if (!isRevisionAccepted(value)) throw new TypeError("Message revision ACK is not closed");
  return clone(value);
}

export function cloneMessageRecallAcceptedResult(value: unknown): MessageRecallAcceptedResult {
  if (!isRecallAccepted(value)) throw new TypeError("Message recall ACK is not closed");
  return clone(value);
}
