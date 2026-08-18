import {
  IDENTITY_CONTRACT_LIMITS,
  isIdentityLoginInput,
  type IdentityDevice,
  type IdentityLoginInput,
  type IdentityPublicSession,
} from "./contracts.js";

export type IdentityTransportErrorCode =
  | "invalid_credentials"
  | "invalid_token"
  | "token_expired"
  | "session_revoked"
  | "identity_forbidden"
  | "session_limit_reached"
  | "session_not_found"
  | "invalid_request"
  | "unauthenticated"
  | "already_authenticated"
  | "storage_unavailable"
  | "internal_error"
  | "connection_unavailable"
  | "request_timeout"
  | "protocol_error"
  | "client_closed";

export class IdentityTransportError extends Error {
  readonly code: IdentityTransportErrorCode;
  readonly status: number | undefined;

  constructor(code: IdentityTransportErrorCode, status?: number) {
    super(`Identity transport failed: ${code}`);
    this.name = "IdentityTransportError";
    this.code = code;
    this.status = status;
  }
}

export interface IdentityIssuedSession {
  readonly accountId: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly refreshExpiresAt: string;
}

export interface IdentityResumedSession {
  readonly accountId: string;
  readonly actorId: string;
  readonly sessionId: string;
}

type IdentitySocketEvent = "open" | "message" | "close" | "error";

export interface IdentityWebSocketLike {
  readonly readyState: number;
  addEventListener(type: IdentitySocketEvent, listener: (event: unknown) => void): void;
  removeEventListener(type: IdentitySocketEvent, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface IdentityWebSocketClient {
  connect(): Promise<void>;
  login(input: IdentityLoginInput, device: IdentityDevice): Promise<IdentityIssuedSession>;
  resume(accessToken: string): Promise<IdentityResumedSession>;
  refresh(refreshToken: string): Promise<IdentityIssuedSession>;
  listSessions(): Promise<readonly IdentityPublicSession[]>;
  revokeSession(sessionId: string): Promise<void>;
  logout(): Promise<void>;
  onTerminalRevoked(listener: (eventId: string) => void): () => void;
  onConnectionFailure(listener: (error: IdentityTransportError) => void): () => void;
  close(): void;
}

const MAX_SERVER_FRAME_BYTES = 64 * 1_024;
const utf8Encoder = new TextEncoder();

function failEndpoint(): never {
  throw new TypeError("Identity WebSocket endpoint is not allowed");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function validateIdentityWebSocketEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return failEndpoint();
  }
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.username !== "" || url.password !== "" || url.hash !== "" ||
    (url.protocol === "ws:" && !isLoopbackHostname(url.hostname))
  ) {
    return failEndpoint();
  }
  return url.toString();
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: UnknownRecord, fields: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).length === fields.size &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && fields.has(key));
}

function hasRequiredAndOptionalFields(
  value: UnknownRecord,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): boolean {
  return [...required].every((field) => Object.hasOwn(value, field)) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && (required.has(key) || optional.has(key)),
    );
}

function isBoundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    utf8Encoder.encode(value).byteLength <= maximumBytes;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isBoundedString(value, 64)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isDevice(value: IdentityDevice): boolean {
  return isBoundedString(value.id, IDENTITY_CONTRACT_LIMITS.deviceId) &&
    isBoundedString(value.label, IDENTITY_CONTRACT_LIMITS.deviceLabel) &&
    (value.platform === "macos" || value.platform === "windows" ||
      value.platform === "linux" || value.platform === "unknown");
}

const RESUMED_FIELDS = new Set(["type", "requestId", "accountId", "actorId", "sessionId"]);
const ISSUED_FIELDS = new Set([
  "type",
  "requestId",
  "accountId",
  "actorId",
  "sessionId",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "refreshExpiresAt",
]);
const SESSIONS_FIELDS = new Set(["type", "requestId", "sessions"]);
const PUBLIC_SESSION_REQUIRED_FIELDS = new Set([
  "id",
  "deviceLabel",
  "platform",
  "refreshExpiresAt",
  "current",
]);
const PUBLIC_SESSION_OPTIONAL_FIELDS = new Set(["createdAt"]);
const REVOKE_ACK_FIELDS = new Set(["type", "requestId", "sessionId", "revoked"]);
const LOGOUT_ACK_FIELDS = new Set(["type", "requestId"]);
const TERMINAL_FIELDS = new Set(["type", "eventId"]);
const ROOM_ACCESS_CHANGED_FIELDS = new Set([
  "eventId",
  "streamKind",
  "streamId",
  "streamSeq",
  "actorId",
  "occurredAt",
  "type",
  "payload",
]);
const ROOM_ACCESS_CHANGED_PAYLOAD_FIELDS = new Set(["roomId", "change"]);
const ROOM_ACCESS_CHANGES = new Set(["joined", "updated", "removed", "archived"]);
const ERROR_REQUIRED_FIELDS = new Set(["type", "status", "code", "message"]);
const ERROR_OPTIONAL_FIELDS = new Set(["requestId"]);

const SERVER_ERROR_CODES = new Set<IdentityTransportErrorCode>([
  "invalid_credentials",
  "invalid_token",
  "token_expired",
  "session_revoked",
  "identity_forbidden",
  "session_limit_reached",
  "session_not_found",
  "invalid_request",
  "unauthenticated",
  "already_authenticated",
  "storage_unavailable",
  "internal_error",
]);
const SERVER_ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 410, 429, 500, 503]);

interface ParsedResumedFrame extends IdentityResumedSession {
  readonly type: "auth.authenticated";
  readonly requestId: string;
}

interface ParsedIssuedFrame extends IdentityIssuedSession {
  readonly type: "auth.authenticated";
  readonly requestId: string;
}

interface ParsedSessionsFrame {
  readonly type: "auth.sessions";
  readonly requestId: string;
  readonly sessions: readonly IdentityPublicSession[];
}

interface ParsedRevokeAckFrame {
  readonly type: "auth.session.revoke.ack";
  readonly requestId: string;
  readonly sessionId: string;
  readonly revoked: true;
}

interface ParsedLogoutAckFrame {
  readonly type: "auth.revoked";
  readonly requestId: string;
}

interface ParsedTerminalFrame {
  readonly type: "auth.session-revoked";
  readonly eventId: string;
}

interface ParsedRoomAccessChangedFrame {
  readonly type: "identity.room-access.changed";
  readonly eventId: string;
}

interface ParsedErrorFrame {
  readonly type: "error";
  readonly status: number;
  readonly code: IdentityTransportErrorCode;
  readonly requestId?: string;
}

type ParsedServerFrame =
  | ParsedResumedFrame
  | ParsedIssuedFrame
  | ParsedSessionsFrame
  | ParsedRevokeAckFrame
  | ParsedLogoutAckFrame
  | ParsedTerminalFrame
  | ParsedRoomAccessChangedFrame
  | ParsedErrorFrame;

function parsePublicSession(value: unknown): IdentityPublicSession | undefined {
  if (!isRecord(value) || !hasRequiredAndOptionalFields(
    value,
    PUBLIC_SESSION_REQUIRED_FIELDS,
    PUBLIC_SESSION_OPTIONAL_FIELDS,
  ) || !isBoundedString(value.id, IDENTITY_CONTRACT_LIMITS.sessionId) ||
      !isBoundedString(value.deviceLabel, IDENTITY_CONTRACT_LIMITS.deviceLabel) ||
      (value.platform !== "macos" && value.platform !== "windows" &&
        value.platform !== "linux" && value.platform !== "unknown") ||
      !isIsoTimestamp(value.refreshExpiresAt) ||
      (value.createdAt !== undefined && !isIsoTimestamp(value.createdAt)) ||
      typeof value.current !== "boolean") {
    return undefined;
  }
  return Object.freeze({
    id: value.id,
    deviceLabel: value.deviceLabel,
    platform: value.platform,
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    refreshExpiresAt: value.refreshExpiresAt,
    current: value.current,
  });
}

function parseServerFrame(raw: string): ParsedServerFrame | undefined {
  if (utf8Encoder.encode(raw).byteLength > MAX_SERVER_FRAME_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "auth.authenticated": {
      if (
        !isBoundedString(value.requestId, 128) ||
        !isBoundedString(value.accountId, IDENTITY_CONTRACT_LIMITS.accountId) ||
        !isBoundedString(value.actorId, IDENTITY_CONTRACT_LIMITS.actorId)
      ) return undefined;
      if (
        hasOnlyFields(value, RESUMED_FIELDS) &&
        isBoundedString(value.sessionId, IDENTITY_CONTRACT_LIMITS.sessionId)
      ) {
        return {
          type: "auth.authenticated",
          requestId: value.requestId,
          accountId: value.accountId,
          actorId: value.actorId,
          sessionId: value.sessionId,
        };
      }
      if (
        !hasOnlyFields(value, ISSUED_FIELDS) ||
        !isBoundedString(value.sessionId, IDENTITY_CONTRACT_LIMITS.sessionId) ||
        !isBoundedString(value.accessToken, IDENTITY_CONTRACT_LIMITS.token) ||
        !isBoundedString(value.refreshToken, IDENTITY_CONTRACT_LIMITS.token) ||
        !isIsoTimestamp(value.expiresAt) || !isIsoTimestamp(value.refreshExpiresAt)
      ) return undefined;
      return {
        type: "auth.authenticated",
        requestId: value.requestId,
        accountId: value.accountId,
        actorId: value.actorId,
        sessionId: value.sessionId,
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: value.expiresAt,
        refreshExpiresAt: value.refreshExpiresAt,
      };
    }
    case "auth.sessions": {
      if (!hasOnlyFields(value, SESSIONS_FIELDS) ||
          !isBoundedString(value.requestId, 128) || !Array.isArray(value.sessions) ||
          value.sessions.length === 0 ||
          value.sessions.length > IDENTITY_CONTRACT_LIMITS.sessions) return undefined;
      const sessions = value.sessions.map(parsePublicSession);
      if (sessions.some((session) => session === undefined)) return undefined;
      const closedSessions = sessions as IdentityPublicSession[];
      if (new Set(closedSessions.map((session) => session.id)).size !== closedSessions.length ||
          closedSessions.filter((session) => session.current).length !== 1) return undefined;
      return {
        type: "auth.sessions",
        requestId: value.requestId,
        sessions: Object.freeze(closedSessions),
      };
    }
    case "auth.session.revoke.ack":
      if (!hasOnlyFields(value, REVOKE_ACK_FIELDS) ||
          !isBoundedString(value.requestId, 128) ||
          !isBoundedString(value.sessionId, IDENTITY_CONTRACT_LIMITS.sessionId) ||
          value.revoked !== true) return undefined;
      return {
        type: "auth.session.revoke.ack",
        requestId: value.requestId,
        sessionId: value.sessionId,
        revoked: true,
      };
    case "auth.revoked":
      if (!hasOnlyFields(value, LOGOUT_ACK_FIELDS) || !isBoundedString(value.requestId, 128)) {
        return undefined;
      }
      return { type: "auth.revoked", requestId: value.requestId };
    case "auth.session-revoked":
      if (!hasOnlyFields(value, TERMINAL_FIELDS) || !isBoundedString(value.eventId, 256)) {
        return undefined;
      }
      return { type: "auth.session-revoked", eventId: value.eventId };
    case "identity.room-access.changed":
      if (!hasOnlyFields(value, ROOM_ACCESS_CHANGED_FIELDS) ||
          !isBoundedString(value.eventId, 256) || value.streamKind !== "identity" ||
          !isBoundedString(value.streamId, IDENTITY_CONTRACT_LIMITS.actorId) ||
          !Number.isSafeInteger(value.streamSeq) || (value.streamSeq as number) < 1 ||
          !isBoundedString(value.actorId, IDENTITY_CONTRACT_LIMITS.actorId) ||
          value.actorId !== value.streamId || !isIsoTimestamp(value.occurredAt) ||
          !isRecord(value.payload) ||
          !hasOnlyFields(value.payload, ROOM_ACCESS_CHANGED_PAYLOAD_FIELDS) ||
          !isBoundedString(value.payload.roomId, 256) ||
          typeof value.payload.change !== "string" ||
          !ROOM_ACCESS_CHANGES.has(value.payload.change)) {
        return undefined;
      }
      return { type: "identity.room-access.changed", eventId: value.eventId };
    case "error":
      if (!hasRequiredAndOptionalFields(value, ERROR_REQUIRED_FIELDS, ERROR_OPTIONAL_FIELDS) ||
          typeof value.status !== "number" || !SERVER_ERROR_STATUSES.has(value.status) ||
          typeof value.code !== "string" ||
          !SERVER_ERROR_CODES.has(value.code as IdentityTransportErrorCode) ||
          !isBoundedString(value.message, 512) ||
          (value.requestId !== undefined && !isBoundedString(value.requestId, 128))) {
        return undefined;
      }
      return {
        type: "error",
        status: value.status,
        code: value.code as IdentityTransportErrorCode,
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      };
    default:
      return undefined;
  }
}

interface PendingRequest {
  readonly responseType: ParsedServerFrame["type"];
  readonly accepts: (frame: ParsedServerFrame) => boolean;
  readonly resolve: (frame: ParsedServerFrame) => void;
  readonly reject: (error: IdentityTransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createIdentityWebSocketClient(options: {
  readonly endpoint: string;
  readonly webSocketFactory: (endpoint: string) => IdentityWebSocketLike;
  readonly requestIdFactory?: () => string;
  readonly timeoutMs?: number;
}): IdentityWebSocketClient {
  const endpoint = validateIdentityWebSocketEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new TypeError("Identity request timeout is invalid");
  }
  const socket = options.webSocketFactory(endpoint);
  const pending = new Map<string, PendingRequest>();
  const terminalListeners = new Set<(eventId: string) => void>();
  const connectionFailureListeners = new Set<(error: IdentityTransportError) => void>();
  let requestSequence = 0;
  let closed = false;
  let disposed = false;
  let terminal = false;
  let connected = socket.readyState === 1;
  let connectPromise: Promise<void> | undefined;
  let connectResolve: (() => void) | undefined;
  let connectReject: ((error: IdentityTransportError) => void) | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionFailureNotified = false;

  const notifyConnectionFailure = (error: IdentityTransportError): void => {
    if (connectionFailureNotified || terminal || disposed) return;
    connectionFailureNotified = true;
    for (const listener of [...connectionFailureListeners]) {
      try {
        listener(error);
      } catch {
        // A main-process observer cannot change the closed transport outcome.
      }
    }
  };

  const rejectAll = (error: IdentityTransportError): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const failConnection = (error: IdentityTransportError): void => {
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    connectReject?.(error);
    connectResolve = undefined;
    connectReject = undefined;
    rejectAll(error);
  };

  const protocolFailure = (): void => {
    if (closed || terminal) return;
    closed = true;
    const error = new IdentityTransportError("protocol_error");
    failConnection(error);
    notifyConnectionFailure(error);
    try {
      socket.close(1002, "protocol error");
    } catch {
      // The fixed protocol failure is already terminal for this client instance.
    }
  };

  const onOpen = (): void => {
    if (closed) return;
    connected = true;
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    connectResolve?.();
    connectResolve = undefined;
    connectReject = undefined;
  };
  const onError = (): void => {
    if (closed || terminal) return;
    closed = true;
    connected = false;
    const error = new IdentityTransportError("connection_unavailable");
    failConnection(error);
    notifyConnectionFailure(error);
    try {
      socket.close(1000, "connection unavailable");
    } catch {
      // Every pending operation is already finite and sanitized.
    }
  };
  const onClose = (): void => {
    connected = false;
    if (closed || terminal) return;
    closed = true;
    const error = new IdentityTransportError("connection_unavailable");
    failConnection(error);
    notifyConnectionFailure(error);
  };
  const onMessage = (event: unknown): void => {
    if (closed || terminal || !isRecord(event) || typeof event.data !== "string") {
      if (!closed && !terminal) protocolFailure();
      return;
    }
    const frame = parseServerFrame(event.data);
    if (frame === undefined) {
      protocolFailure();
      return;
    }
    if (frame.type === "auth.session-revoked") {
      terminal = true;
      connected = false;
      const error = new IdentityTransportError("session_revoked", 403);
      failConnection(error);
      for (const listener of [...terminalListeners]) listener(frame.eventId);
      try {
        socket.close(1000, "session revoked");
      } catch {
        // Terminal cleanup is best effort after all authority has been discarded.
      }
      return;
    }
    if (frame.type === "identity.room-access.changed") {
      // This authority notification invalidates room-level caches owned outside FT-01.
      // Identity transport deliberately consumes it without changing credentials or auth state.
      return;
    }
    const requestId = frame.requestId;
    if (requestId === undefined) {
      protocolFailure();
      return;
    }
    const request = pending.get(requestId);
    if (request === undefined) {
      protocolFailure();
      return;
    }
    pending.delete(requestId);
    clearTimeout(request.timer);
    if (frame.type === "error") {
      request.reject(new IdentityTransportError(frame.code, frame.status));
      return;
    }
    if (frame.type !== request.responseType || !request.accepts(frame)) {
      request.reject(new IdentityTransportError("protocol_error"));
      protocolFailure();
      return;
    }
    request.resolve(frame);
  };

  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);

  const connect = (): Promise<void> => {
    if (connected && !closed && !terminal) return Promise.resolve();
    if (closed || terminal || socket.readyState > 1) {
      return Promise.reject(new IdentityTransportError(
        terminal ? "session_revoked" : "connection_unavailable",
      ));
    }
    if (connectPromise !== undefined) return connectPromise;
    connectPromise = new Promise<void>((resolve, reject) => {
      connectResolve = resolve;
      connectReject = reject;
      connectTimer = setTimeout(() => {
        closed = true;
        const error = new IdentityTransportError("request_timeout");
        failConnection(error);
        notifyConnectionFailure(error);
        try {
          socket.close(1000, "connection timeout");
        } catch {
          // The finite timeout has already failed the client.
        }
      }, timeoutMs);
    });
    return connectPromise;
  };

  const nextRequestId = (): string => {
    const requestId = options.requestIdFactory?.() ?? `identity-${Date.now()}-${++requestSequence}`;
    if (!isBoundedString(requestId, 128) || pending.has(requestId)) {
      throw new IdentityTransportError("protocol_error");
    }
    return requestId;
  };

  const request = <T extends ParsedServerFrame>(
    frame: UnknownRecord,
    responseType: T["type"],
    accepts: (response: ParsedServerFrame) => boolean = () => true,
  ): Promise<T> => {
    if (!connected || closed || terminal || socket.readyState !== 1) {
      return Promise.reject(new IdentityTransportError(
        terminal ? "session_revoked" : closed ? "client_closed" : "connection_unavailable",
      ));
    }
    const requestId = nextRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new IdentityTransportError("request_timeout"));
      }, timeoutMs);
      pending.set(requestId, {
        responseType,
        accepts,
        resolve: (response) => resolve(response as T),
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify({ ...frame, requestId }));
      } catch {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new IdentityTransportError("connection_unavailable"));
      }
    });
  };

  return {
    connect,
    login(input, device) {
      if (!isIdentityLoginInput(input) || !isDevice(device)) {
        return Promise.reject(new IdentityTransportError("invalid_request", 400));
      }
      return request<ParsedIssuedFrame>({
        type: "auth.login",
        accountId: input.accountId,
        secret: input.secret,
        device: { id: device.id, label: device.label, platform: device.platform },
      }, "auth.authenticated", (response) => "accessToken" in response)
        .then((response) => ({
          accountId: response.accountId,
          actorId: response.actorId,
          sessionId: response.sessionId,
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          expiresAt: response.expiresAt,
          refreshExpiresAt: response.refreshExpiresAt,
        }));
    },
    resume(accessToken) {
      if (!isBoundedString(accessToken, IDENTITY_CONTRACT_LIMITS.token)) {
        return Promise.reject(new IdentityTransportError("invalid_request", 400));
      }
      return request<ParsedResumedFrame>(
        { type: "auth.resume", accessToken },
        "auth.authenticated",
        (response) => response.type === "auth.authenticated" &&
          "sessionId" in response && !("accessToken" in response),
      )
        .then((response) => ({
          accountId: response.accountId,
          actorId: response.actorId,
          sessionId: response.sessionId,
        }));
    },
    refresh(refreshToken) {
      if (!isBoundedString(refreshToken, IDENTITY_CONTRACT_LIMITS.token)) {
        return Promise.reject(new IdentityTransportError("invalid_request", 400));
      }
      return request<ParsedIssuedFrame>(
        { type: "auth.refresh", refreshToken },
        "auth.authenticated",
        (response) => "accessToken" in response,
      ).then((response) => ({
        accountId: response.accountId,
        actorId: response.actorId,
        sessionId: response.sessionId,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        expiresAt: response.expiresAt,
        refreshExpiresAt: response.refreshExpiresAt,
      }));
    },
    listSessions() {
      return request<ParsedSessionsFrame>({ type: "auth.sessions.list" }, "auth.sessions")
        .then((response) => response.sessions);
    },
    revokeSession(sessionId) {
      if (!isBoundedString(sessionId, IDENTITY_CONTRACT_LIMITS.sessionId)) {
        return Promise.reject(new IdentityTransportError("invalid_request", 400));
      }
      return request<ParsedRevokeAckFrame>(
        { type: "auth.session.revoke", sessionId },
        "auth.session.revoke.ack",
      ).then((response) => {
        if (response.sessionId !== sessionId || response.revoked !== true) {
          throw new IdentityTransportError("protocol_error");
        }
      });
    },
    logout() {
      return request<ParsedLogoutAckFrame>({ type: "auth.revoke" }, "auth.revoked")
        .then(() => undefined);
    },
    onTerminalRevoked(listener) {
      terminalListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        terminalListeners.delete(listener);
      };
    },
    onConnectionFailure(listener) {
      connectionFailureListeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        connectionFailureListeners.delete(listener);
      };
    },
    close() {
      if (disposed) return;
      disposed = true;
      closed = true;
      connected = false;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      failConnection(new IdentityTransportError("client_closed"));
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      terminalListeners.clear();
      connectionFailureListeners.clear();
      try {
        socket.close(1000, "client closed");
      } catch {
        // Idempotent close has no recovery work.
      }
    },
  };
}
