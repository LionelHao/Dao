import {
  isMessageRevision,
  isRoomMemoryError,
  isRoomMemoryProtocolFrame,
  isRoomMemoryRequest,
  isRoomCursor,
  isTimelineMessage,
  type MessageRevision,
  type RoomMemoryError,
  type RoomMemoryRequest,
  type RoomMemorySuccessFrame,
  type RoomCursor,
  type TimelineMessage,
} from "@native-im/core";

import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  isDesktopRoomEvent,
  isDesktopRoomSyncResult,
  type DesktopRoomEvent,
  type DesktopRoomSyncResult,
  type RoomSubscription,
  type RoomSubscriptionObserver,
} from "../sync/client-sync-replica.js";
import {
  cloneMessageAcceptedResult,
  cloneMessageRecallAcceptedResult,
  cloneMessageRevisionAcceptedResult,
  type AgentExecutionPreviewInput,
  type AgentExecutionPreviewResetInput,
  type MessageAcceptedResult,
  type MessageHistoryV2Command,
  type MessageRecallAcceptedResult,
  type MessageRecallCommand,
  type MessageRevisionAcceptedResult,
  type MessageRevisionsCommand,
  type MessageRevisionsResult,
  type MessageReviseCommand,
  type MessageSendV2Command,
} from "./contracts.js";
import type { MessageClosedError } from "../renderer/message-authority/view-model.js";
import type { MessageActorOption } from "../renderer/message-authority/view-model.js";

type SocketEvent = "open" | "message" | "close" | "error";

export interface MessageAuthorityWebSocketLike {
  readonly readyState: number;
  addEventListener(type: SocketEvent, listener: (event: unknown) => void): void;
  removeEventListener(type: SocketEvent, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type MessageAuthorityTransportErrorCode =
  | "authentication_required"
  | "session_revoked"
  | "access_revoked"
  | "connection_unavailable"
  | "request_timeout"
  | "repair_required"
  | "protocol_error"
  | "client_closed"
  | "request_capacity_exceeded";

export class MessageAuthorityTransportError extends Error {
  constructor(
    readonly code: MessageAuthorityTransportErrorCode,
    readonly closedError?: MessageClosedError,
    readonly repair?: Readonly<{
      reason: "cursor_absent" | "cursor_expired" | "operational_projection_changed";
      retainedFromSeq: number;
      watermark: number;
    }>,
    readonly memoryError?: RoomMemoryError,
  ) {
    super(`Message Authority transport failed: ${code}`);
    this.name = "MessageAuthorityTransportError";
  }
}

export type MessageHistoryV2WireResult = Readonly<{
  type: "room.history.v2";
  requestId: string;
  roomId: string;
  messages: readonly TimelineMessage[];
  hasMore: boolean;
  lifecycle: "active" | "archived";
  actors: readonly MessageActorOption[];
}>;

export interface MessageAuthorityWireTransport {
  historyV2(command: MessageHistoryV2Command): Promise<MessageHistoryV2WireResult>;
  revisionsQuery(command: MessageRevisionsCommand): Promise<MessageRevisionsResult>;
  sendV2(command: MessageSendV2Command): Promise<MessageAcceptedResult>;
  revise(command: MessageReviseCommand): Promise<MessageRevisionAcceptedResult>;
  recall(command: MessageRecallCommand): Promise<MessageRecallAcceptedResult>;
  memoryRequest(command: RoomMemoryRequest): Promise<RoomMemorySuccessFrame | RoomMemoryError>;
  subscribeRoom(
    roomId: string,
    cursor: RoomCursor,
    observer: RoomSubscriptionObserver,
  ): Promise<RoomSubscription>;
  onAgentPreview(listener: (
    input: AgentExecutionPreviewInput | AgentExecutionPreviewResetInput,
  ) => void): () => void;
  onTerminalRevoked(listener: () => void): () => void;
  onRoomAccessChanged(listener: (
    roomId: string,
    change: "joined" | "updated" | "removed" | "archived",
  ) => void): () => void;
  onConnectionFailure(listener: (error: MessageAuthorityTransportError) => void): () => void;
  resetSession(): void;
  close(): void;
}

const encoder = new TextEncoder();
const MAX_FRAME_BYTES = 2 * 1_024 * 1_024;
const MAX_LATE_REQUEST_IDS = 256;

function endpointFailure(): never {
  throw new TypeError("Message Authority WebSocket endpoint is not allowed");
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(host);
}

export function validateMessageAuthorityWebSocketEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return endpointFailure();
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !isLoopback(url.hostname) ||
      url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
    return endpointFailure();
  }
  return url.toString();
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(
  value: RecordValue,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}
function text(value: unknown, maximumBytes = 512): value is string {
  return typeof value === "string" && value.length > 0 &&
    encoder.encode(value).byteLength <= maximumBytes;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function timestamp(value: unknown): value is string {
  if (!text(value, 64)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

type ParsedFrame =
  | Readonly<{
      type: "auth.authenticated";
      requestId: string;
      actorId: string;
      sessionId: string;
    }>
  | MessageAcceptedResult
  | MessageRevisionAcceptedResult
  | MessageRecallAcceptedResult
  | MessageHistoryV2WireResult
  | MessageRevisionsResult
  | RoomMemorySuccessFrame
  | DesktopRoomSyncResult
  | Readonly<{
      type: "room.subscribed.v2";
      requestId: string;
      roomId: string;
      cursor: { readonly version: 1; readonly roomId: string; readonly afterSeq: number };
      watermark: number;
    }>
  | Readonly<{
      type: "room.subscribe.v2.retry";
      requestId: string;
      roomId: string;
      reason: "gate_overflow";
      restartFrom: { readonly version: 1; readonly roomId: string; readonly afterSeq: number };
    }>
  | Readonly<{ type: "room.event"; event: DesktopRoomEvent }>
  | AgentExecutionPreviewInput
  | AgentExecutionPreviewResetInput
  | Readonly<{ type: "auth.session-revoked"; eventId: string }>
  | Readonly<{
      type: "identity.room-access.changed";
      eventId: string;
      actorId: string;
      roomId: string;
      change: "joined" | "updated" | "removed" | "archived";
    }>
  | Readonly<{
      type: "error";
      requestId?: string;
      error: MessageAuthorityTransportError;
    }>;

function closedWireError(status: number, code: string): MessageClosedError | undefined {
  if (status === 400) {
    if (code === "invalid_request" || code === "invalid_message" ||
        code === "mention_entity_invalid" || code === "author_fields_forbidden") {
      return { status, code };
    }
    if (code === "attachment_feature_unavailable") return { status, code: "invalid_message" };
  }
  if (status === 401) {
    if (code === "identity_forbidden" || code === "session_revoked") {
      return { status, code: "identity_forbidden" };
    }
    if (code === "unauthenticated" || code === "invalid_token" || code === "token_expired") {
      return { status, code: "unauthenticated" };
    }
  }
  if (status === 403 && (code === "room_forbidden" || code === "identity_forbidden")) {
    return { status, code: "room_forbidden" };
  }
  if ((status === 404 && code === "room_not_found") ||
      (status === 409 && code === "room_archived")) {
    return { status: 403, code: "room_forbidden" };
  }
  if (status === 404 && code === "reply_target_not_found") return { status, code };
  if (status === 409 && (code === "message_version_conflict" || code === "message_recalled" ||
      code === "agent_final_immutable" || code === "idempotency_conflict")) {
    return { status, code };
  }
  if (status === 410 && (code === "protocol_upgrade_required" || code === "snapshot_expired")) {
    return { status, code };
  }
  if (status === 429 && code === "rate_limited") return { status, code };
  if ((status === 500 || status === 503) &&
      (code === "dependency_unavailable" || code === "storage_unavailable" ||
        code === "repair_barrier_active" || code === "internal_error")) {
    return { status: 503, code: code === "dependency_unavailable"
      ? "dependency_unavailable" : code === "repair_barrier_active"
        ? "repair_unavailable" : "service_unavailable" };
  }
  return undefined;
}

function parseAccepted(value: unknown): MessageAcceptedResult | undefined {
  try {
    return cloneMessageAcceptedResult(value);
  } catch {
    return undefined;
  }
}
function parseRevisionAccepted(value: unknown): MessageRevisionAcceptedResult | undefined {
  try {
    return cloneMessageRevisionAcceptedResult(value);
  } catch {
    return undefined;
  }
}
function parseRecallAccepted(value: unknown): MessageRecallAcceptedResult | undefined {
  try {
    return cloneMessageRecallAcceptedResult(value);
  } catch {
    return undefined;
  }
}

export function parseMessageAuthorityServerFrame(raw: string): ParsedFrame | undefined {
  if (encoder.encode(raw).byteLength > MAX_FRAME_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!record(value) || typeof value.type !== "string") return undefined;
  if (value.type !== "error" && isRoomMemoryProtocolFrame(value) &&
      !isRoomMemoryRequest(value)) {
    return structuredClone(value) as RoomMemorySuccessFrame;
  }
  switch (value.type) {
    case "auth.authenticated":
      return exact(value, ["type", "requestId", "accountId", "actorId", "sessionId"]) &&
        text(value.requestId, 128) && text(value.accountId, 256) && text(value.actorId, 256) &&
        text(value.sessionId, 256)
        ? { type: value.type, requestId: value.requestId,
          actorId: value.actorId, sessionId: value.sessionId }
        : undefined;
    case "message.accepted": return parseAccepted(value);
    case "message.revision.accepted": return parseRevisionAccepted(value);
    case "message.recall.accepted": return parseRecallAccepted(value);
    case "room.history.v2":
      return exact(value, [
        "type", "requestId", "roomId", "messages", "hasMore", "lifecycle", "actors",
      ]) &&
        text(value.requestId, 128) && text(value.roomId, 256) &&
        Array.isArray(value.messages) && value.messages.length <= 1_000 &&
        value.messages.every(isTimelineMessage) &&
        value.messages.every((message) => message.roomId === value.roomId) &&
        new Set(value.messages.map((message) => message.id)).size === value.messages.length &&
        typeof value.hasMore === "boolean" &&
        (value.lifecycle === "active" || value.lifecycle === "archived") &&
        Array.isArray(value.actors) && value.actors.length <= 512 &&
        value.actors.every((actor) => record(actor) && exact(actor, [
          "actorId", "kind", "displayName", "secondaryLabel",
        ]) && text(actor.actorId, 256) && (actor.kind === "human" || actor.kind === "agent") &&
          text(actor.displayName, 512) && text(actor.secondaryLabel, 512)) &&
        new Set(value.actors.map((actor) => actor.actorId)).size === value.actors.length
        ? { type: value.type, requestId: value.requestId, roomId: value.roomId,
          messages: structuredClone(value.messages as TimelineMessage[]), hasMore: value.hasMore,
          lifecycle: value.lifecycle,
          actors: structuredClone(value.actors as MessageActorOption[]) }
        : undefined;
    case "message.revisions":
      return exact(value, [
        "type", "requestId", "roomId", "messageId", "revisions", "hasMore",
      ]) && text(value.requestId, 128) && text(value.roomId, 256) &&
        text(value.messageId, 256) && Array.isArray(value.revisions) &&
        value.revisions.length <= 1_000 && value.revisions.every(isMessageRevision) &&
        value.revisions.every((revision) => revision.messageId === value.messageId) &&
        typeof value.hasMore === "boolean"
        ? { type: value.type, requestId: value.requestId, roomId: value.roomId,
          messageId: value.messageId,
          revisions: structuredClone(value.revisions as MessageRevision[]), hasMore: value.hasMore }
        : undefined;
    case "room.sync.result":
      return isDesktopRoomSyncResult(value) ? structuredClone(value) : undefined;
    case "room.subscribed.v2":
      return exact(value, ["type", "requestId", "roomId", "cursor", "watermark"]) &&
        text(value.requestId, 128) && text(value.roomId, 256) && isRoomCursor(value.cursor) &&
        value.cursor.roomId === value.roomId && count(value.watermark) &&
        value.watermark >= value.cursor.afterSeq
        ? structuredClone(value) as Extract<ParsedFrame, { type: "room.subscribed.v2" }>
        : undefined;
    case "room.subscribe.v2.retry":
      return exact(value, ["type", "requestId", "roomId", "reason", "restartFrom"]) &&
        text(value.requestId, 128) && text(value.roomId, 256) && value.reason === "gate_overflow" &&
        isRoomCursor(value.restartFrom) && value.restartFrom.roomId === value.roomId
        ? structuredClone(value) as Extract<ParsedFrame, { type: "room.subscribe.v2.retry" }>
        : undefined;
    case "room.event":
      return exact(value, ["type", "event"]) && isDesktopRoomEvent(value.event)
        ? { type: value.type, event: structuredClone(value.event) }
        : undefined;
    case "agent.execution.preview":
      return exact(value, [
        "type", "roomId", "executionId", "attemptSeq", "streamSeq", "delta", "authoritative",
      ]) && text(value.roomId, 256) && text(value.executionId, 256) &&
        count(value.attemptSeq) && value.attemptSeq > 0 && count(value.streamSeq) &&
        value.streamSeq > 0 && text(value.delta, 64 * 1_024) && value.authoritative === false
        ? structuredClone(value) as AgentExecutionPreviewInput
        : undefined;
    case "agent.execution.preview.reset":
      return exact(value, [
        "type", "roomId", "executionId", "attemptSeq", "reason", "authoritative",
      ]) && text(value.roomId, 256) && text(value.executionId, 256) &&
        count(value.attemptSeq) && value.attemptSeq > 0 &&
        (value.reason === "human_cancelled" || value.reason === "message_recalled" ||
          value.reason === "runtime_shutdown" || value.reason === "repair" ||
          value.reason === "reconnect") && value.authoritative === false
        ? structuredClone(value) as AgentExecutionPreviewResetInput
        : undefined;
    case "auth.session-revoked":
      return exact(value, ["type", "eventId"]) && text(value.eventId)
        ? { type: value.type, eventId: value.eventId }
        : undefined;
    case "identity.room-access.changed":
      return exact(value, [
        "eventId", "streamKind", "streamId", "streamSeq", "actorId", "occurredAt", "type",
        "payload",
      ]) && value.streamKind === "identity" && text(value.eventId) &&
        text(value.streamId, 256) && count(value.streamSeq) && value.streamSeq > 0 &&
        text(value.actorId, 256) && value.actorId === value.streamId &&
        timestamp(value.occurredAt) &&
        record(value.payload) && exact(value.payload, ["roomId", "change"]) &&
        text(value.payload.roomId, 256) &&
        (value.payload.change === "joined" || value.payload.change === "updated" ||
          value.payload.change === "removed" || value.payload.change === "archived")
        ? { type: value.type, eventId: value.eventId, actorId: value.actorId,
          roomId: value.payload.roomId, change: value.payload.change }
        : undefined;
    case "error": {
      if (isRoomMemoryError(value)) {
        return {
          type: "error",
          ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
          error: new MessageAuthorityTransportError(
            value.status === 401 ? "authentication_required"
              : value.status === 403 ? "access_revoked" : "protocol_error",
            undefined,
            undefined,
            structuredClone(value),
          ),
        };
      }
      if (!exact(value, ["type", "status", "code", "message"], ["requestId", "details"]) ||
          typeof value.status !== "number" || !text(value.code, 128) || !text(value.message) ||
          (value.requestId !== undefined && !text(value.requestId, 128))) return undefined;
      const closedError = closedWireError(value.status, value.code);
      if (closedError === undefined) return undefined;
      const code: MessageAuthorityTransportErrorCode = closedError.status === 401
        ? closedError.code === "identity_forbidden" ? "session_revoked" : "authentication_required"
        : closedError.status === 403 ? "access_revoked" : "protocol_error";
      return { type: "error",
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
        error: new MessageAuthorityTransportError(code, closedError) };
    }
    default: return undefined;
  }
}

interface Pending {
  readonly accept: (frame: ParsedFrame) => boolean;
  readonly resolve: (frame: ParsedFrame) => void;
  readonly reject: (error: MessageAuthorityTransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface LiveSubscription {
  readonly requestId: string;
  readonly observer: RoomSubscriptionObserver;
  cursor: { version: 1; roomId: string; afterSeq: number };
  delivery: Promise<void>;
  bufferedDeliveries: number;
  closed: boolean;
}

export function createMessageAuthorityWebSocketTransport(options: {
  readonly endpoint: string;
  readonly session: () => IdentityAuthoritySession | undefined;
  readonly webSocketFactory: (endpoint: string) => MessageAuthorityWebSocketLike;
  readonly timeoutMs?: number;
  readonly maxPendingRequests?: number;
  readonly maxBufferedEvents?: number;
}): MessageAuthorityWireTransport {
  const endpoint = validateMessageAuthorityWebSocketEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxPendingRequests = options.maxPendingRequests ?? 256;
  const maxBufferedEvents = options.maxBufferedEvents ?? 1_024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1 ||
      maxPendingRequests > 1_024 || !Number.isSafeInteger(maxBufferedEvents) ||
      maxBufferedEvents < 1 || maxBufferedEvents > 16_384) {
    throw new TypeError("Message Authority transport bounds are invalid");
  }
  let socket: MessageAuthorityWebSocketLike | undefined;
  let connectPromise: Promise<void> | undefined;
  let authenticatedSessionId: string | undefined;
  let sequence = 0;
  let closed = false;
  let terminal = false;
  const pending = new Map<string, Pending>();
  const expiredRequestIds = new Set<string>();
  const subscriptions = new Map<string, LiveSubscription>();
  const terminalListeners = new Set<() => void>();
  const roomAccessListeners = new Set<(
    roomId: string,
    change: "joined" | "updated" | "removed" | "archived",
  ) => void>();
  const previewListeners = new Set<(
    input: AgentExecutionPreviewInput | AgentExecutionPreviewResetInput,
  ) => void>();
  const failureListeners = new Set<(error: MessageAuthorityTransportError) => void>();

  const rememberExpired = (requestId: string): void => {
    expiredRequestIds.add(requestId);
    if (expiredRequestIds.size > MAX_LATE_REQUEST_IDS) {
      expiredRequestIds.delete(expiredRequestIds.values().next().value!);
    }
  };
  const rejectAll = (error: MessageAuthorityTransportError): void => {
    for (const [requestId, item] of pending) {
      clearTimeout(item.timer);
      rememberExpired(requestId);
      item.reject(error);
    }
    pending.clear();
  };
  const closeSubscriptions = (): void => {
    for (const live of subscriptions.values()) live.closed = true;
    subscriptions.clear();
  };
  const notifyFailure = (error: MessageAuthorityTransportError): void => {
    for (const listener of [...failureListeners]) {
      try { listener(error); } catch { /* observer failure is isolated */ }
    }
  };
  const disposeSocket = (code = 1000, reason = "replace connection"): void => {
    const current = socket;
    socket = undefined;
    connectPromise = undefined;
    authenticatedSessionId = undefined;
    try { current?.close(code, reason); } catch { /* bounded cleanup */ }
  };
  const protocolFailure = (): void => {
    const error = new MessageAuthorityTransportError("protocol_error");
    rejectAll(error);
    closeSubscriptions();
    notifyFailure(error);
    disposeSocket(1002, "protocol error");
  };
  const queueDelivery = (live: LiveSubscription, deliver: () => Promise<void>): void => {
    live.bufferedDeliveries += 1;
    if (live.bufferedDeliveries > maxBufferedEvents) {
      protocolFailure();
      return;
    }
    live.delivery = live.delivery.then(async () => {
      if (!live.closed) await deliver();
    }).finally(() => {
      live.bufferedDeliveries -= 1;
    });
    void live.delivery.catch(() => protocolFailure());
  };

  const receive = (event: unknown): void => {
    if (!record(event) || typeof event.data !== "string") {
      protocolFailure();
      return;
    }
    const frame = parseMessageAuthorityServerFrame(event.data);
    if (frame === undefined) {
      protocolFailure();
      return;
    }
    if (frame.type === "auth.session-revoked") {
      terminal = true;
      const error = new MessageAuthorityTransportError(
        "session_revoked",
        { status: 401, code: "identity_forbidden" },
      );
      rejectAll(error);
      closeSubscriptions();
      disposeSocket(1000, "session revoked");
      for (const listener of [...terminalListeners]) listener();
      return;
    }
    if (frame.type === "identity.room-access.changed") {
      if (frame.actorId !== options.session()?.actorId) {
        protocolFailure();
        return;
      }
      for (const listener of [...roomAccessListeners]) listener(frame.roomId, frame.change);
      return;
    }
    if (frame.type === "room.event") {
      const live = subscriptions.get(frame.event.roomId);
      if (live === undefined || live.closed) return;
      queueDelivery(live, async () => {
        if (frame.event.streamSeq <= live.cursor.afterSeq) return;
        const cursor = { version: 1 as const, roomId: frame.event.roomId,
          afterSeq: frame.event.streamSeq };
        await live.observer.events([frame.event], cursor);
        live.cursor = cursor;
      });
      return;
    }
    if (frame.type === "agent.execution.preview" ||
        frame.type === "agent.execution.preview.reset") {
      const live = subscriptions.get(frame.roomId);
      if (live === undefined || live.closed) return;
      for (const listener of [...previewListeners]) {
        try { listener(structuredClone(frame)); } catch { /* observer failure is isolated */ }
      }
      return;
    }
    if (frame.type === "room.sync.result") {
      const live = [...subscriptions.values()].find(
        (candidate) => candidate.requestId === frame.requestId,
      );
      if (live === undefined) {
        // No ordinary room.sync RPC exists on this message-specific transport.
      } else if (live.closed) {
        protocolFailure();
        return;
      } else if (frame.mode === "repair_required") {
        const item = pending.get(frame.requestId);
        if (item === undefined) {
          protocolFailure();
          return;
        }
        pending.delete(frame.requestId);
        clearTimeout(item.timer);
        live.closed = true;
        if (subscriptions.get(live.cursor.roomId) === live) {
          subscriptions.delete(live.cursor.roomId);
        }
        item.reject(new MessageAuthorityTransportError("repair_required", undefined, {
          reason: frame.reason,
          retainedFromSeq: frame.retainedFromSeq,
          watermark: frame.watermark,
        }));
        return;
      } else if (frame.nextCursor.roomId !== live.cursor.roomId) {
        protocolFailure();
        return;
      } else {
        queueDelivery(live, async () => {
          await live.observer.events(frame.events, frame.nextCursor);
          live.cursor = structuredClone(frame.nextCursor);
        });
        return;
      }
    }
    if (frame.type === "room.subscribe.v2.retry") {
      const live = subscriptions.get(frame.roomId);
      if (live === undefined || live.closed || live.requestId !== frame.requestId) {
        protocolFailure();
        return;
      }
      void live.observer.retry(frame.restartFrom).catch(() => protocolFailure());
      return;
    }
    const requestId = "requestId" in frame ? frame.requestId : undefined;
    if (requestId === undefined) {
      protocolFailure();
      return;
    }
    const item = pending.get(requestId);
    if (item === undefined) {
      if (expiredRequestIds.delete(requestId)) return;
      protocolFailure();
      return;
    }
    pending.delete(requestId);
    clearTimeout(item.timer);
    if (frame.type === "error") {
      item.reject(frame.error);
      return;
    }
    if (!item.accept(frame)) {
      item.reject(new MessageAuthorityTransportError("protocol_error"));
      protocolFailure();
      return;
    }
    item.resolve(frame);
  };

  const connect = async (): Promise<void> => {
    if (closed) throw new MessageAuthorityTransportError("client_closed");
    if (terminal) throw new MessageAuthorityTransportError(
      "session_revoked",
      { status: 401, code: "identity_forbidden" },
    );
    if (socket?.readyState === 1) return;
    if (connectPromise !== undefined) return connectPromise;
    connectPromise = new Promise<void>((resolve, reject) => {
      const next = options.webSocketFactory(endpoint);
      socket = next;
      const timer = setTimeout(() => {
        if (socket !== next) return;
        const error = new MessageAuthorityTransportError("connection_unavailable");
        reject(error);
        disposeSocket(1000, "connect timeout");
      }, timeoutMs);
      const open = (): void => {
        if (socket !== next) return;
        clearTimeout(timer);
        resolve();
      };
      const failed = (): void => {
        if (socket !== next) return;
        clearTimeout(timer);
        const error = new MessageAuthorityTransportError("connection_unavailable");
        rejectAll(error);
        closeSubscriptions();
        reject(error);
        notifyFailure(error);
        if (socket === next) {
          socket = undefined;
          connectPromise = undefined;
          authenticatedSessionId = undefined;
        }
      };
      const closedEvent = (): void => {
        if (closed || terminal || socket !== next) return;
        failed();
      };
      next.addEventListener("open", open);
      next.addEventListener("message", (messageEvent) => {
        if (socket === next) receive(messageEvent);
      });
      next.addEventListener("error", failed);
      next.addEventListener("close", closedEvent);
      if (next.readyState === 1) open();
    });
    try {
      await connectPromise;
    } catch (cause) {
      connectPromise = undefined;
      throw cause;
    }
  };

  const send = async (
    frame: RecordValue,
    accept: Pending["accept"],
  ): Promise<ParsedFrame> => {
    await connect();
    const requestId = frame.requestId;
    if (!text(requestId, 128) || pending.has(requestId)) {
      throw new MessageAuthorityTransportError("protocol_error");
    }
    if (pending.size >= maxPendingRequests) {
      throw new MessageAuthorityTransportError("request_capacity_exceeded");
    }
    return new Promise<ParsedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        rememberExpired(requestId);
        reject(new MessageAuthorityTransportError("request_timeout"));
      }, timeoutMs);
      pending.set(requestId, { accept, resolve, reject, timer });
      try {
        socket!.send(JSON.stringify(frame));
      } catch {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(new MessageAuthorityTransportError("connection_unavailable"));
      }
    });
  };

  const authenticate = async (): Promise<void> => {
    const session = options.session();
    if (session === undefined) {
      throw new MessageAuthorityTransportError(
        "authentication_required",
        { status: 401, code: "unauthenticated" },
      );
    }
    if (authenticatedSessionId === session.sessionId && socket?.readyState === 1) return;
    if (authenticatedSessionId !== undefined && authenticatedSessionId !== session.sessionId) {
      disposeSocket(1000, "session changed");
    }
    const requestId = `message-auth-${++sequence}`;
    const authenticated = await send({
      type: "auth.resume",
      requestId,
      accessToken: session.accessToken,
    }, (candidate) => candidate.type === "auth.authenticated" &&
      candidate.requestId === requestId && candidate.actorId === session.actorId &&
      candidate.sessionId === session.sessionId);
    if (authenticated.type !== "auth.authenticated") {
      throw new MessageAuthorityTransportError("protocol_error");
    }
    authenticatedSessionId = session.sessionId;
  };

  const rpc = async (frame: RecordValue, accept: Pending["accept"]): Promise<ParsedFrame> => {
    let first: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await authenticate();
        return await send(frame, accept);
      } catch (cause) {
        first ??= cause;
        if (!(cause instanceof MessageAuthorityTransportError) ||
            cause.code !== "connection_unavailable" || attempt === 1) throw cause;
        closeSubscriptions();
        disposeSocket(1000, "bounded reconnect");
      }
    }
    throw first;
  };

  const exactRequest = async <T extends ParsedFrame>(
    frame: RecordValue,
    type: T["type"],
  ): Promise<T> => {
    const requestId = frame.requestId as string;
    return await rpc(frame, (candidate) => candidate.type === type &&
      "requestId" in candidate && candidate.requestId === requestId) as T;
  };

  const transport: MessageAuthorityWireTransport = {
    historyV2: (command) => exactRequest<MessageHistoryV2WireResult>(
      { ...command },
      "room.history.v2",
    ),
    revisionsQuery: (command) => exactRequest<MessageRevisionsResult>(
      { ...command },
      "message.revisions",
    ),
    sendV2: (command) => exactRequest<MessageAcceptedResult>(
      { ...command },
      "message.accepted",
    ),
    revise: (command) => exactRequest<MessageRevisionAcceptedResult>(
      { ...command },
      "message.revision.accepted",
    ),
    recall: (command) => exactRequest<MessageRecallAcceptedResult>(
      { ...command },
      "message.recall.accepted",
    ),
    async memoryRequest(command) {
      if (!isRoomMemoryRequest(command)) {
        throw new MessageAuthorityTransportError("protocol_error");
      }
      const expected: Readonly<Record<RoomMemoryRequest["type"], RoomMemorySuccessFrame["type"]>> = {
        "room.memory.query.v1": "room.memory.page.v1",
        "room.memory.source.query.v1": "room.memory.source.v1",
        "room.memory.context.dispute.v1": "room.memory.context.dispute.accepted.v1",
        "room.memory.context.resolve.v1": "room.memory.context.resolve.accepted.v1",
        "room.memory.status.query.v1": "room.memory.status.v1",
        "room.memory.retry.v1": "room.memory.retry.accepted.v1",
      };
      try {
        return structuredClone(await exactRequest<RoomMemorySuccessFrame>(
          { ...command },
          expected[command.type],
        ));
      } catch (error) {
        if (error instanceof MessageAuthorityTransportError && error.memoryError !== undefined &&
            error.memoryError.requestId === command.requestId) {
          return structuredClone(error.memoryError);
        }
        throw error;
      }
    },
    async subscribeRoom(roomId, cursor, observer) {
      if (!isRoomCursor(cursor) || cursor.roomId !== roomId) {
        throw new MessageAuthorityTransportError("protocol_error");
      }
      const requestId = `message-room-subscribe-${++sequence}`;
      const live: LiveSubscription = {
        requestId,
        observer,
        cursor: structuredClone(cursor),
        delivery: Promise.resolve(),
        bufferedDeliveries: 0,
        closed: false,
      };
      const prior = subscriptions.get(roomId);
      if (prior !== undefined) prior.closed = true;
      subscriptions.set(roomId, live);
      try {
        const response = await exactRequest<Extract<ParsedFrame, {
          type: "room.subscribed.v2";
        }>>({ type: "room.subscribe.v2", requestId, roomId, cursor }, "room.subscribed.v2");
        if (response.roomId !== roomId) throw new MessageAuthorityTransportError("protocol_error");
        await live.delivery;
        live.cursor = structuredClone(response.cursor);
        return {
          get cursor() { return structuredClone(live.cursor); },
          close() {
            live.closed = true;
            if (subscriptions.get(roomId) === live) subscriptions.delete(roomId);
          },
        };
      } catch (cause) {
        live.closed = true;
        if (subscriptions.get(roomId) === live) subscriptions.delete(roomId);
        throw cause;
      }
    },
    onTerminalRevoked(listener) {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
    onAgentPreview(listener) {
      previewListeners.add(listener);
      return () => previewListeners.delete(listener);
    },
    onRoomAccessChanged(listener) {
      roomAccessListeners.add(listener);
      return () => roomAccessListeners.delete(listener);
    },
    onConnectionFailure(listener) {
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },
    resetSession() {
      terminal = false;
      rejectAll(new MessageAuthorityTransportError(
        "authentication_required",
        { status: 401, code: "unauthenticated" },
      ));
      closeSubscriptions();
      disposeSocket(1000, "session reset");
    },
    close() {
      if (closed) return;
      closed = true;
      rejectAll(new MessageAuthorityTransportError("client_closed"));
      closeSubscriptions();
      terminalListeners.clear();
      roomAccessListeners.clear();
      previewListeners.clear();
      failureListeners.clear();
      disposeSocket(1000, "client closed");
    },
  };
  return Object.freeze(transport);
}
