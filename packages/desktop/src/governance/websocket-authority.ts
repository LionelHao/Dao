import {
  isRoomCursor,
  isRoomGovernanceView,
  isRoomRepairPage,
  isSnapshotCompleted,
  isWorkspaceBootstrapPage,
  isAgentExecutionRetryReceipt,
  isScopedCancellationReceipt,
  type AgentExecutionRetryReceipt,
  type RoomCursor,
  type RoomGovernanceView,
  type RoomRepairPage,
  type RoomSyncRequest,
  type SnapshotCompleted,
  type SnapshotVersion,
  type ScopedCancellationReceipt,
  type WorkspaceBootstrapPage,
} from "@native-im/core";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import type {
  DesktopRoomEvent,
  DesktopRoomSyncResult,
  RoomSubscription,
  RoomSubscriptionObserver,
  SyncTransport,
} from "../sync/client-sync-replica.js";
import { isDesktopRoomEvent, isDesktopRoomSyncResult } from "../sync/client-sync-replica.js";
import {
  isDepartureConflictList,
  type GovernanceAuthorityCommand,
} from "./contracts.js";
import type { DepartureConflictList, GovernanceCommand } from "../renderer/governance/view-model.js";

type SocketEvent = "open" | "message" | "close" | "error";

export interface GovernanceWebSocketLike {
  readonly readyState: number;
  addEventListener(type: SocketEvent, listener: (event: unknown) => void): void;
  removeEventListener(type: SocketEvent, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type GovernanceTransportErrorCode =
  | "authentication_required" | "session_revoked" | "access_revoked"
  | "role_forbidden" | "member_not_found" | "room_not_found"
  | "room_revision_conflict" | "ownership_transfer_required" | "room_archived"
  | "departure_blocked" | "snapshot_expired" | "snapshot_stale"
  | "context_unavailable"
  | "rate_limited" | "dependency_unavailable" | "service_unavailable"
  | "execution_conflict" | "protocol_upgrade_required"
  | "connection_unavailable" | "request_timeout" | "protocol_error" | "client_closed";

export class GovernanceTransportError extends Error {
  constructor(
    readonly code: GovernanceTransportErrorCode,
    readonly status?: number,
    readonly details?: DepartureConflictList,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Governance transport failed: ${code}`);
    this.name = "GovernanceTransportError";
  }
}

export interface GovernanceWireAck {
  readonly requestId: string;
  readonly command: GovernanceCommand;
  readonly result: "accepted" | "already_archived" | "already_active";
  readonly governance: RoomGovernanceView;
  readonly eventIds: readonly string[];
  readonly replayed: boolean;
}

export interface InvocationWireCommand {
  readonly type: "invocation.cancel" | "invocation.retry";
  readonly requestId: string;
  readonly executionId: string;
  readonly expectedVersion: number;
}

export type InvocationWireAck =
  | Readonly<{ type: "invocation.cancel.ack"; requestId: string;
      receipt: ScopedCancellationReceipt }>
  | Readonly<{ type: "invocation.retry.ack"; requestId: string;
      receipt: AgentExecutionRetryReceipt; replayed: boolean }>;

export interface GovernanceAuthorityTransport extends SyncTransport {
  queryDepartureConflicts(input: {
    readonly requestId: string;
    readonly roomId: string;
    readonly targetActorId: string;
    readonly expectedGovernanceRevision: number;
  }): Promise<DepartureConflictList>;
  execute(command: GovernanceAuthorityCommand): Promise<GovernanceWireAck>;
  controlInvocation(command: InvocationWireCommand): Promise<InvocationWireAck>;
  onTerminalRevoked(listener: () => void): () => void;
  onRoomAccessChanged(listener: (
    roomId: string,
    change: "joined" | "updated" | "removed" | "archived",
  ) => void): () => void;
  onConnectionFailure(listener: (error: GovernanceTransportError) => void): () => void;
  resetSession(): void;
  close(): void;
}

const encoder = new TextEncoder();
const MAX_FRAME_BYTES = 2 * 1_024 * 1_024;

function failEndpoint(): never { throw new TypeError("Governance WebSocket endpoint is not allowed"); }
function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function validateGovernanceWebSocketEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { return failEndpoint(); }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !loopback(url.hostname) ||
      url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
    return failEndpoint();
  }
  return url.toString();
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}
function text(value: unknown, bytes = 512): value is string {
  return typeof value === "string" && value.length > 0 && encoder.encode(value).byteLength <= bytes;
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function timestamp(value: unknown): value is string {
  if (!text(value, 64)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
type ParsedFrame =
  | { readonly type: "auth.authenticated"; readonly requestId: string; readonly actorId: string; readonly sessionId: string }
  | ({ readonly type: "room.governance.ack" } & GovernanceWireAck)
  | InvocationWireAck
  | { readonly type: "room.departure.conflicts.result"; readonly requestId: string; readonly conflicts: DepartureConflictList }
  | WorkspaceBootstrapPage | RoomRepairPage | DesktopRoomSyncResult | SnapshotCompleted
  | { readonly type: "room.subscribed.v2"; readonly requestId: string; readonly roomId: string; readonly cursor: RoomCursor; readonly watermark: number }
  | { readonly type: "room.subscribe.v2.retry"; readonly requestId: string; readonly roomId: string; readonly reason: "gate_overflow"; readonly restartFrom: RoomCursor }
  | { readonly type: "room.event"; readonly event: DesktopRoomEvent }
  | { readonly type: "auth.session-revoked"; readonly eventId: string }
  | {
      readonly type: "identity.room-access.changed";
      readonly eventId: string;
      readonly actorId: string;
      readonly roomId: string;
      readonly change: "joined" | "updated" | "removed" | "archived";
    }
  | { readonly type: "error"; readonly requestId?: string; readonly error: GovernanceTransportError };

const commands = new Set<GovernanceCommand>([
  "room.ownership.transfer", "room.member.leave", "room.member.remove", "room.archive", "room.reopen",
]);
const statuses = new Set([400, 401, 403, 404, 409, 410, 429, 500, 503]);

function mappedError(
  status: number,
  code: string,
  details: unknown,
  retryAfterSeconds: unknown,
): GovernanceTransportError | undefined {
  if (status === 409 && code === "departure_blocked" && isDepartureConflictList(details)) {
    return retryAfterSeconds === undefined
      ? new GovernanceTransportError("departure_blocked", 409, details) : undefined;
  }
  const mapping: Record<string, GovernanceTransportErrorCode> = {
    unauthenticated: "authentication_required", invalid_token: "authentication_required",
    token_expired: "authentication_required", session_revoked: "session_revoked",
    room_forbidden: "access_revoked", identity_forbidden: "access_revoked",
    context_forbidden: "access_revoked", permission_denied: "access_revoked",
    role_forbidden: "role_forbidden", member_not_found: "member_not_found",
    room_not_found: "room_not_found", room_revision_conflict: "room_revision_conflict",
    ownership_transfer_required: "ownership_transfer_required", room_archived: "room_archived",
    snapshot_expired: "snapshot_expired", snapshot_stale: "snapshot_stale",
    context_snapshot_invalidated: "context_unavailable",
    context_source_gone: "context_unavailable",
    context_generation_conflict: "execution_conflict",
    context_snapshot_conflict: "execution_conflict",
    rate_limited: "rate_limited", dependency_unavailable: "dependency_unavailable",
    context_capacity_limited: "rate_limited",
    agent_queue_full: "rate_limited", execution_conflict: "execution_conflict",
    protocol_upgrade_required: "protocol_upgrade_required",
    agent_runtime_closed: "service_unavailable",
    storage_unavailable: "service_unavailable", internal_error: "service_unavailable",
    context_storage_unavailable: "service_unavailable",
  };
  const closed = mapping[code];
  if (closed === undefined || (retryAfterSeconds !== undefined &&
      (status !== 429 || !Number.isSafeInteger(retryAfterSeconds) ||
        (retryAfterSeconds as number) <= 0 ||
        (retryAfterSeconds as number) > 86_400))) return undefined;
  return new GovernanceTransportError(closed, status, undefined,
    retryAfterSeconds as number | undefined);
}

export function parseGovernanceServerFrame(raw: string): ParsedFrame | undefined {
  if (encoder.encode(raw).byteLength > MAX_FRAME_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!record(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "auth.authenticated":
      return exact(value, ["type", "requestId", "accountId", "actorId", "sessionId"]) &&
        text(value.requestId, 128) && text(value.accountId, 256) && text(value.actorId, 256) && text(value.sessionId, 256)
        ? { type: value.type, requestId: value.requestId, actorId: value.actorId, sessionId: value.sessionId }
        : undefined;
    case "room.governance.ack": {
      if (!exact(value, ["type", "requestId", "operation", "governance", "eventIds", "replayed"]) ||
          !text(value.requestId, 128) || typeof value.operation !== "string" ||
          !commands.has(value.operation as GovernanceCommand) || !isRoomGovernanceView(value.governance) ||
          !Array.isArray(value.eventIds) || value.eventIds.length > 64 ||
          !value.eventIds.every((id) => text(id, 512)) || new Set(value.eventIds).size !== value.eventIds.length ||
          typeof value.replayed !== "boolean") return undefined;
      const inferred = value.eventIds.length > 0 || value.replayed ? "accepted"
        : value.operation === "room.archive" && value.governance.lifecycle === "archived" ? "already_archived"
          : value.operation === "room.reopen" && value.governance.lifecycle === "active" ? "already_active"
            : "accepted";
      return { type: value.type, requestId: value.requestId, command: value.operation as GovernanceCommand,
        result: inferred, governance: value.governance, replayed: value.replayed,
        eventIds: Object.freeze([...value.eventIds] as string[]) };
    }
    case "invocation.cancel.ack": {
      if (!exact(value, ["type", "requestId", "receipt"]) || !text(value.requestId, 128) ||
          !isScopedCancellationReceipt(value.receipt) ||
          value.receipt.requestId !== value.requestId) return undefined;
      return { type: value.type, requestId: value.requestId,
        receipt: structuredClone(value.receipt) };
    }
    case "invocation.retry.ack":
      return exact(value, ["type", "requestId", "receipt", "replayed"]) &&
        text(value.requestId, 128) && isAgentExecutionRetryReceipt(value.receipt) &&
        value.receipt.requestId === value.requestId && typeof value.replayed === "boolean"
        ? { type: value.type, requestId: value.requestId,
          receipt: structuredClone(value.receipt), replayed: value.replayed }
        : undefined;
    case "room.departure.conflicts.result":
      return exact(value, ["type", "requestId", "conflicts"]) && text(value.requestId, 128) &&
        isDepartureConflictList(value.conflicts)
        ? { type: value.type, requestId: value.requestId, conflicts: value.conflicts } : undefined;
    case "workspace.bootstrap.page": return isWorkspaceBootstrapPage(value) ? value : undefined;
    case "room.repair.page": return isRoomRepairPage(value) ? value : undefined;
    case "room.sync.result": return isDesktopRoomSyncResult(value) ? value : undefined;
    case "snapshot.completed": return isSnapshotCompleted(value) ? value : undefined;
    case "room.subscribed.v2":
      return exact(value, ["type", "requestId", "roomId", "cursor", "watermark"]) &&
        text(value.requestId, 128) && text(value.roomId, 256) && isRoomCursor(value.cursor) &&
        value.cursor.roomId === value.roomId && count(value.watermark) && value.watermark >= value.cursor.afterSeq
        ? value as ParsedFrame : undefined;
    case "room.subscribe.v2.retry":
      return exact(value, ["type", "requestId", "roomId", "reason", "restartFrom"]) &&
        text(value.requestId, 128) && text(value.roomId, 256) && value.reason === "gate_overflow" &&
        isRoomCursor(value.restartFrom) && value.restartFrom.roomId === value.roomId ? value as ParsedFrame : undefined;
    case "room.event":
      return exact(value, ["type", "event"]) && isDesktopRoomEvent(value.event)
        ? { type: value.type, event: value.event } : undefined;
    case "auth.session-revoked":
      return exact(value, ["type", "eventId"]) && text(value.eventId, 512)
        ? { type: value.type, eventId: value.eventId } : undefined;
    case "identity.room-access.changed":
      return exact(value, [
        "eventId", "streamKind", "streamId", "streamSeq", "actorId", "occurredAt", "type", "payload",
      ]) && text(value.eventId, 512) && value.streamKind === "identity" &&
        text(value.streamId, 256) && count(value.streamSeq) && value.streamSeq > 0 &&
        text(value.actorId, 256) && value.actorId === value.streamId && timestamp(value.occurredAt) &&
        record(value.payload) && exact(value.payload, ["roomId", "change"]) &&
        text(value.payload.roomId, 256) &&
        (value.payload.change === "joined" || value.payload.change === "updated" ||
          value.payload.change === "removed" || value.payload.change === "archived")
        ? {
            type: value.type,
            eventId: value.eventId,
            actorId: value.actorId,
            roomId: value.payload.roomId,
            change: value.payload.change,
          }
        : undefined;
    case "error": {
      if (!exact(value, ["type", "status", "code", "message"], [
        "requestId", "details", "retryAfterSeconds",
      ]) ||
          typeof value.status !== "number" || !statuses.has(value.status) || typeof value.code !== "string" ||
          !text(value.message, 512) || (value.requestId !== undefined && !text(value.requestId, 128))) return undefined;
      const error = mappedError(value.status, value.code, value.details, value.retryAfterSeconds);
      return error === undefined ? undefined : { type: "error",
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }), error };
    }
    default: return undefined;
  }
}

interface Pending {
  readonly accept: (frame: ParsedFrame) => boolean;
  readonly resolve: (frame: ParsedFrame) => void;
  readonly reject: (error: GovernanceTransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface LiveSubscription {
  readonly requestId: string;
  readonly observer: RoomSubscriptionObserver;
  cursor: RoomCursor;
  delivery: Promise<void>;
  closed: boolean;
}

export function createGovernanceWebSocketAuthority(options: {
  readonly endpoint: string;
  readonly session: () => IdentityAuthoritySession | undefined;
  readonly webSocketFactory: (endpoint: string) => GovernanceWebSocketLike;
  readonly timeoutMs?: number;
}): GovernanceAuthorityTransport {
  const endpoint = validateGovernanceWebSocketEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120_000) {
    throw new TypeError("Governance request timeout is invalid");
  }
  let socket: GovernanceWebSocketLike | undefined;
  let connectPromise: Promise<void> | undefined;
  let authenticatedSessionId: string | undefined;
  let sequence = 0;
  let closed = false;
  let terminal = false;
  const pending = new Map<string, Pending>();
  const subscriptions = new Map<string, LiveSubscription>();
  const terminalListeners = new Set<() => void>();
  const roomAccessChangedListeners = new Set<(
    roomId: string,
    change: "joined" | "updated" | "removed" | "archived",
  ) => void>();
  const failureListeners = new Set<(error: GovernanceTransportError) => void>();

  const rejectAll = (error: GovernanceTransportError): void => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const notifyFailure = (error: GovernanceTransportError): void => {
    for (const listener of [...failureListeners]) { try { listener(error); } catch { /* observer */ } }
  };
  const queueLiveDelivery = (
    live: LiveSubscription,
    deliver: () => Promise<void>,
  ): void => {
    live.delivery = live.delivery.then(async () => {
      if (!live.closed) await deliver();
    });
    void live.delivery.catch(() => protocolFailure());
  };
  const disposeSocket = (code = 1000, reason = "replace connection"): void => {
    const current = socket;
    socket = undefined;
    connectPromise = undefined;
    authenticatedSessionId = undefined;
    try { current?.close(code, reason); } catch { /* bounded cleanup */ }
  };
  const protocolFailure = (): void => {
    const error = new GovernanceTransportError("protocol_error");
    rejectAll(error); notifyFailure(error); disposeSocket(1002, "protocol error");
  };

  const receive = (event: unknown): void => {
    if (!record(event) || typeof event.data !== "string") { protocolFailure(); return; }
    const frame = parseGovernanceServerFrame(event.data);
    if (frame === undefined) { protocolFailure(); return; }
    if (frame.type === "auth.session-revoked") {
      terminal = true;
      const error = new GovernanceTransportError("session_revoked", 401);
      rejectAll(error); disposeSocket(1000, "session revoked");
      for (const listener of [...terminalListeners]) listener();
      return;
    }
    if (frame.type === "identity.room-access.changed") {
      if (frame.actorId !== options.session()?.actorId) { protocolFailure(); return; }
      for (const listener of [...roomAccessChangedListeners]) listener(frame.roomId, frame.change);
      return;
    }
    if (frame.type === "room.event") {
      const live = subscriptions.get(frame.event.roomId);
      if (live === undefined || live.closed) return;
      queueLiveDelivery(live, async () => {
        if (frame.event.streamSeq <= live.cursor.afterSeq) return;
        const cursor = {
          version: 1 as const,
          roomId: frame.event.roomId,
          afterSeq: frame.event.streamSeq,
        };
        await live.observer.events([frame.event], cursor);
        live.cursor = cursor;
      });
      return;
    }
    if (frame.type === "room.sync.result") {
      const live = [...subscriptions.values()].find(
        (candidate) => candidate.requestId === frame.requestId,
      );
      if (live === undefined) {
        // Ordinary room.sync RPC responses are resolved by the generic pending-request path.
      } else if (live.closed || frame.mode !== "delta" ||
          frame.nextCursor.roomId !== live.cursor.roomId) {
        protocolFailure();
        return;
      } else {
        queueLiveDelivery(live, async () => {
          await live.observer.events(frame.events, frame.nextCursor);
          live.cursor = structuredClone(frame.nextCursor);
        });
        return;
      }
    }
    if (frame.type === "room.subscribe.v2.retry") {
      const live = subscriptions.get(frame.roomId);
      if (live === undefined || live.closed || live.requestId !== frame.requestId) { protocolFailure(); return; }
      void live.observer.retry(frame.restartFrom).catch(() => protocolFailure());
      return;
    }
    const requestId = "requestId" in frame ? frame.requestId : undefined;
    if (requestId === undefined) { protocolFailure(); return; }
    const item = pending.get(requestId);
    if (item === undefined) { protocolFailure(); return; }
    pending.delete(requestId); clearTimeout(item.timer);
    if (frame.type === "error") { item.reject(frame.error); return; }
    if (!item.accept(frame)) { item.reject(new GovernanceTransportError("protocol_error")); protocolFailure(); return; }
    item.resolve(frame);
  };

  const connect = async (): Promise<void> => {
    if (closed) throw new GovernanceTransportError("client_closed");
    if (terminal) throw new GovernanceTransportError("session_revoked", 401);
    if (socket?.readyState === 1) return;
    if (connectPromise !== undefined) return connectPromise;
    connectPromise = new Promise<void>((resolve, reject) => {
      const next = options.webSocketFactory(endpoint);
      socket = next;
      const timer = setTimeout(() => {
        if (socket !== next) return;
        reject(new GovernanceTransportError("connection_unavailable"));
        disposeSocket(1000, "connect timeout");
      }, timeoutMs);
      const open = (): void => {
        if (socket !== next) return;
        clearTimeout(timer); resolve();
      };
      const failed = (): void => {
        if (socket !== next) return;
        clearTimeout(timer);
        const error = new GovernanceTransportError("connection_unavailable");
        rejectAll(error); reject(error); notifyFailure(error);
        if (socket === next) { socket = undefined; connectPromise = undefined; authenticatedSessionId = undefined; }
      };
      const closedEvent = (): void => {
        if (closed || terminal || socket !== next) return;
        failed();
      };
      next.addEventListener("open", open);
      next.addEventListener("message", (event) => {
        if (socket === next) receive(event);
      });
      next.addEventListener("error", failed);
      next.addEventListener("close", closedEvent);
      if (next.readyState === 1) open();
    });
    try { await connectPromise; } catch (cause) { connectPromise = undefined; throw cause; }
  };

  const send = async (frame: RecordValue, accept: Pending["accept"]): Promise<ParsedFrame> => {
    await connect();
    const requestId = frame.requestId;
    if (!text(requestId, 128) || pending.has(requestId)) throw new GovernanceTransportError("protocol_error");
    return new Promise<ParsedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new GovernanceTransportError("request_timeout"));
      }, timeoutMs);
      pending.set(requestId, { accept, resolve, reject, timer });
      try { socket!.send(JSON.stringify(frame)); }
      catch { clearTimeout(timer); pending.delete(requestId); reject(new GovernanceTransportError("connection_unavailable")); }
    });
  };

  const authenticate = async (): Promise<void> => {
    const session = options.session();
    if (session === undefined) throw new GovernanceTransportError("authentication_required", 401);
    if (authenticatedSessionId === session.sessionId && socket?.readyState === 1) return;
    if (authenticatedSessionId !== undefined && authenticatedSessionId !== session.sessionId) disposeSocket();
    const requestId = `governance-auth-${++sequence}`;
    const frame = await send({ type: "auth.resume", requestId, accessToken: session.accessToken },
      (candidate) => candidate.type === "auth.authenticated" && candidate.requestId === requestId &&
        candidate.actorId === session.actorId && candidate.sessionId === session.sessionId);
    if (frame.type !== "auth.authenticated") throw new GovernanceTransportError("protocol_error");
    authenticatedSessionId = session.sessionId;
  };

  const rpc = async (frame: RecordValue, accept: Pending["accept"]): Promise<ParsedFrame> => {
    let first: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { await authenticate(); return await send(frame, accept); }
      catch (cause) {
        first ??= cause;
        if (!(cause instanceof GovernanceTransportError) ||
            (cause.code !== "connection_unavailable" && cause.code !== "request_timeout") || attempt === 1) throw cause;
        disposeSocket(1000, "bounded reconnect");
      }
    }
    throw first;
  };

  const exactRequest = async <T extends ParsedFrame>(frame: RecordValue, type: T["type"]): Promise<T> => {
    const requestId = frame.requestId as string;
    const response = await rpc(frame, (candidate) => candidate.type === type &&
      "requestId" in candidate && candidate.requestId === requestId);
    return response as T;
  };

  return {
    bootstrapBegin: (requestId) => exactRequest<WorkspaceBootstrapPage>(
      { type: "workspace.bootstrap.begin", requestId }, "workspace.bootstrap.page"),
    bootstrapPage: (requestId, snapshotId, afterPage) => exactRequest<WorkspaceBootstrapPage>(
      { type: "workspace.bootstrap.page", requestId, snapshotId, afterPage }, "workspace.bootstrap.page"),
    syncRoom: (request: RoomSyncRequest) => exactRequest<DesktopRoomSyncResult>({ ...request }, "room.sync.result"),
    repairRoomBegin: (requestId, roomId) => exactRequest<RoomRepairPage>(
      { type: "room.repair.begin", requestId, roomId }, "room.repair.page"),
    repairRoomPage: (requestId, snapshotId, afterPage) => exactRequest<RoomRepairPage>(
      { type: "room.repair.page", requestId, snapshotId, afterPage }, "room.repair.page"),
    completeSnapshot: (requestId, snapshotId, version: SnapshotVersion, checksum) => exactRequest<SnapshotCompleted>(
      { type: "snapshot.complete", requestId, snapshotId, version, snapshotChecksum: checksum }, "snapshot.completed"),
    async subscribeRoom(roomId, cursor, observer): Promise<RoomSubscription> {
      const requestId = `room-subscribe-${++sequence}`;
      const live: LiveSubscription = {
        requestId,
        observer,
        cursor: structuredClone(cursor),
        delivery: Promise.resolve(),
        closed: false,
      };
      subscriptions.set(roomId, live);
      try {
        const response = await exactRequest<Extract<ParsedFrame, { type: "room.subscribed.v2" }>>(
          { type: "room.subscribe.v2", requestId, roomId, cursor }, "room.subscribed.v2");
        if (response.roomId !== roomId) throw new GovernanceTransportError("protocol_error");
        await live.delivery;
        live.cursor = structuredClone(response.cursor);
        return { get cursor() { return structuredClone(live.cursor); }, close() {
          live.closed = true;
          if (subscriptions.get(roomId) === live) subscriptions.delete(roomId);
        } };
      } catch (cause) {
        if (subscriptions.get(roomId) === live) subscriptions.delete(roomId);
        throw cause;
      }
    },
    async queryDepartureConflicts(input) {
      const response = await exactRequest<Extract<ParsedFrame, { type: "room.departure.conflicts.result" }>>({
        type: "room.departure.conflicts", ...input,
      }, "room.departure.conflicts.result");
      if (response.conflicts.roomId !== input.roomId ||
          response.conflicts.targetActorId !== input.targetActorId) throw new GovernanceTransportError("protocol_error");
      return structuredClone(response.conflicts);
    },
    async execute(command) {
      const response = await exactRequest<Extract<ParsedFrame, { type: "room.governance.ack" }>>({
        type: command.intent.command, requestId: command.requestId, roomId: command.roomId,
        expectedGovernanceRevision: command.intent.expectedGovernanceRevision,
        idempotencyKey: command.idempotencyKey,
        ...(command.intent.targetActorId === undefined ? {} : { targetActorId: command.intent.targetActorId }),
      }, "room.governance.ack");
      if (response.command !== command.intent.command || response.governance.roomId !== command.roomId) {
        throw new GovernanceTransportError("protocol_error");
      }
      return response;
    },
    async controlInvocation(command) {
      const responseType = command.type === "invocation.cancel"
        ? "invocation.cancel.ack" as const : "invocation.retry.ack" as const;
      const response = await exactRequest<InvocationWireAck>({ ...command }, responseType);
      if (response.type !== responseType ||
          (response.type === "invocation.cancel.ack" &&
            (response.receipt.scope.kind !== "execution" ||
              response.receipt.scope.executionId !== command.executionId ||
              response.receipt.scope.expectedVersion !== command.expectedVersion ||
              response.receipt.reason !== "human_cancelled")) ||
          (response.type === "invocation.retry.ack" &&
            response.receipt.sourceExecutionId !== command.executionId)) {
        throw new GovernanceTransportError("protocol_error");
      }
      return response;
    },
    onTerminalRevoked(listener) { terminalListeners.add(listener); return () => terminalListeners.delete(listener); },
    onRoomAccessChanged(listener) {
      roomAccessChangedListeners.add(listener);
      return () => roomAccessChangedListeners.delete(listener);
    },
    onConnectionFailure(listener) { failureListeners.add(listener); return () => failureListeners.delete(listener); },
    resetSession() {
      terminal = false;
      rejectAll(new GovernanceTransportError("authentication_required", 401));
      subscriptions.clear();
      disposeSocket(1000, "session reset");
    },
    close() {
      if (closed) return;
      closed = true;
      rejectAll(new GovernanceTransportError("client_closed"));
      subscriptions.clear(); terminalListeners.clear(); roomAccessChangedListeners.clear();
      failureListeners.clear(); disposeSocket(1000, "client closed");
    },
  };
}
