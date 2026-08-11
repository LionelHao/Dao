import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  AuthenticationError,
  type AuthenticatedPrincipal,
  type AuthenticationService,
  type IssuedSession,
} from "./auth.js";
import {
  createOutboxDispatcher,
  type OutboxDispatchFrame,
  type OutboxDispatchStore,
  type OutboxSendResult,
} from "./outbox-dispatcher.js";
import type { AuthenticatedSessionContext } from "./persistence/contracts.js";
import {
  MessageValidationError,
  RoomAccessError,
  type MessageService,
} from "./service.js";
import { MessageIdConflictError } from "./store.js";
import {
  parseClientFrame,
  type AuthenticatedFrame,
  type ClientFrame,
  type ProtocolErrorFrame,
  type ServerFrame,
} from "./protocol.js";
import {
  createSubscriptionRegistry,
  type RegisteredConnection,
  type SubscriptionRegistry,
} from "./subscription-registry.js";

export interface MessageWebSocketServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartMessageWebSocketServerOptions {
  readonly auth: AuthenticationService;
  readonly service: MessageService;
  readonly host?: string;
  readonly port?: number;
  readonly maxBufferedAmountBytes?: number;
  readonly maxQueuedFrameCount?: number;
  readonly maxQueuedFrameBytes?: number;
  readonly afterSubscribeRegistered?: (roomId: string) => void | Promise<void>;
  readonly outboxStore?: OutboxDispatchStore;
  readonly outboxPollIntervalMs?: number;
  readonly subscriptionRegistry?: SubscriptionRegistry;
}

export const MESSAGE_WEBSOCKET_MAX_PAYLOAD_BYTES = 64 * 1_024;
export const MESSAGE_WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES = 1 * 1_024 * 1_024;
export const MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_COUNT = 64;
export const MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_BYTES = 256 * 1_024;

const maxBufferedAmountBySocket = new WeakMap<WebSocket, number>();
const abortConnectionBySocket = new WeakMap<WebSocket, () => void>();

function abortAndTerminate(socket: WebSocket): void {
  abortConnectionBySocket.get(socket)?.();
  socket.terminate();
}

interface ConnectionContext {
  principal: AuthenticatedPrincipal | undefined;
  session: AuthenticatedSessionContext | undefined;
  accessToken: string | undefined;
  credentialGeneration: number;
  authOperationPending: boolean;
  terminalRevocationPending: boolean;
  closed: boolean;
  readonly unsubscribersByRoom: Map<string, () => void>;
  readonly identityUnsubscribers: Set<() => void>;
  readonly subscriptionGenerationsByRoom: Map<string, number>;
  readonly unsubscribeAll: () => void;
  registeredConnection: RegisteredConnection | undefined;
}

function errorFrame(
  status: ProtocolErrorFrame["status"],
  code: ProtocolErrorFrame["code"],
  message: string,
  requestId?: string,
): ProtocolErrorFrame {
  if (requestId === undefined) {
    return { type: "error", status, code, message };
  }
  return { type: "error", status, code, message, requestId };
}

function mappedError(error: unknown, requestId: string): ProtocolErrorFrame {
  if (error instanceof AuthenticationError) {
    return errorFrame(error.status, error.code, error.code, requestId);
  }
  if (error instanceof RoomAccessError) {
    return errorFrame(error.status, error.code, error.code, requestId);
  }
  if (error instanceof MessageValidationError) {
    return errorFrame(error.status, error.code, error.code, requestId);
  }
  if (error instanceof MessageIdConflictError) {
    return errorFrame(error.status, error.code, error.code, requestId);
  }
  return errorFrame(500, "internal_error", "Unable to process request", requestId);
}

function sendFrameWithResult(
  socket: WebSocket,
  frame: ServerFrame,
): Promise<OutboxSendResult> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ accepted: false, reason: "closed" });
  }
  try {
    const serialized = JSON.stringify(frame);
    if (serialized === undefined) {
      abortAndTerminate(socket);
      return Promise.resolve({ accepted: false, reason: "send_rejected" });
    }
    const maxBufferedAmount =
      maxBufferedAmountBySocket.get(socket) ??
      MESSAGE_WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES;
    const frameBytes = Buffer.byteLength(serialized, "utf8");
    if (frameBytes > maxBufferedAmount - socket.bufferedAmount) {
      abortAndTerminate(socket);
      return Promise.resolve({ accepted: false, reason: "backpressure" });
    }
    return new Promise<OutboxSendResult>((resolve) => {
      try {
        socket.send(serialized, (error) => {
          if (error != null) {
            abortAndTerminate(socket);
            resolve({ accepted: false, reason: "send_rejected" });
            return;
          }
          resolve({ accepted: true });
        });
      } catch {
        abortAndTerminate(socket);
        resolve({ accepted: false, reason: "send_rejected" });
      }
    });
  } catch {
    abortAndTerminate(socket);
    return Promise.resolve({ accepted: false, reason: "send_rejected" });
  }
}

function sendFrame(socket: WebSocket, frame: ServerFrame): void {
  void sendFrameWithResult(socket, frame);
}

function rawDataToString(raw: RawData): string {
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

function rawDataByteLength(raw: RawData): number {
  if (Array.isArray(raw)) {
    return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return raw.byteLength;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function safelyUnsubscribe(unsubscribe: (() => void) | undefined): void {
  try {
    unsubscribe?.();
  } catch {
    // A failing listener cleanup cannot crash the transport event loop.
  }
}

function onceUnsubscribe(unsubscribe: () => void): () => void {
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    safelyUnsubscribe(unsubscribe);
  };
}

function samePrincipal(
  left: AuthenticatedPrincipal,
  right: AuthenticatedPrincipal,
): boolean {
  return left.accountId === right.accountId && left.actorId === right.actorId;
}

function authenticatedFrame(
  requestId: string,
  principal: AuthenticatedPrincipal,
  session?: IssuedSession,
): AuthenticatedFrame {
  return session === undefined
    ? {
        type: "auth.authenticated",
        requestId,
        accountId: principal.accountId,
        actorId: principal.actorId,
      }
    : {
        type: "auth.authenticated",
        requestId,
        accountId: principal.accountId,
        actorId: principal.actorId,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt,
        refreshExpiresAt: session.refreshExpiresAt,
      };
}

function installAuthentication(
  context: ConnectionContext,
  principal: AuthenticatedPrincipal,
  accessToken: string,
  session?: AuthenticatedSessionContext,
): boolean {
  if (context.closed) {
    return false;
  }
  context.credentialGeneration += 1;
  context.principal = principal;
  context.session = session;
  context.accessToken = accessToken;
  return true;
}

function registerIdentitySubscriptions(
  context: ConnectionContext,
  registry: SubscriptionRegistry | undefined,
): void {
  for (const unsubscribe of context.identityUnsubscribers) {
    safelyUnsubscribe(unsubscribe);
  }
  context.identityUnsubscribers.clear();
  const connection = context.registeredConnection;
  const session = context.session;
  if (registry === undefined || connection === undefined || session === undefined) {
    return;
  }
  context.identityUnsubscribers.add(registry.addPrincipal({
    principalId: session.principal.actorId,
    connection,
  }));
  context.identityUnsubscribers.add(registry.addSessionFamily({
    familyId: session.sessionFamilyId,
    connection,
  }));
}

function clearAuthentication(
  context: ConnectionContext,
  expectedGeneration?: number,
): boolean {
  if (
    expectedGeneration !== undefined &&
    context.credentialGeneration !== expectedGeneration
  ) {
    return false;
  }
  context.credentialGeneration += 1;
  context.principal = undefined;
  context.session = undefined;
  context.accessToken = undefined;
  context.unsubscribeAll();
  return true;
}

function abortConnection(context: ConnectionContext): void {
  if (context.closed) {
    return;
  }
  context.closed = true;
  clearAuthentication(context);
}

async function authenticateCurrent(
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<AuthenticatedPrincipal> {
  const storedPrincipal = context.principal;
  const accessToken = context.accessToken;
  const credentialGeneration = context.credentialGeneration;
  if (storedPrincipal === undefined || accessToken === undefined) {
    throw errorFrame(401, "unauthenticated", "Authentication is required");
  }

  try {
    const authenticatedSession = options.outboxStore === undefined
      ? undefined
      : await options.auth.authenticateSession(accessToken);
    const principal = authenticatedSession?.principal ??
      await options.auth.authenticate(accessToken);
    if (
      context.closed ||
      context.credentialGeneration !== credentialGeneration ||
      context.accessToken !== accessToken
    ) {
      throw errorFrame(401, "unauthenticated", "Authentication is required");
    }
    if (!samePrincipal(principal, storedPrincipal)) {
      clearAuthentication(context, credentialGeneration);
      throw errorFrame(403, "identity_forbidden", "Session identity changed");
    }
    if (authenticatedSession !== undefined) {
      context.session = authenticatedSession;
    }
    return principal;
  } catch (error: unknown) {
    if (
      options.outboxStore !== undefined &&
      error instanceof AuthenticationError &&
      error.code === "session_revoked"
    ) {
      context.terminalRevocationPending = true;
    } else {
      clearAuthentication(context, credentialGeneration);
    }
    throw error;
  }
}

function isProtocolErrorFrame(error: unknown): error is ProtocolErrorFrame {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "error" &&
    "status" in error &&
    "code" in error
  );
}

async function requirePrincipal(
  socket: WebSocket,
  requestId: string,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<AuthenticatedPrincipal | undefined> {
  if (context.closed) {
    return undefined;
  }
  if (context.principal === undefined || context.accessToken === undefined) {
    sendFrame(
      socket,
      errorFrame(401, "unauthenticated", "Authentication is required", requestId),
    );
    return undefined;
  }

  try {
    const principal = await authenticateCurrent(options, context);
    return context.closed ? undefined : principal;
  } catch (error: unknown) {
    if (context.closed) {
      return undefined;
    }
    sendFrame(
      socket,
      isProtocolErrorFrame(error)
        ? { ...error, requestId }
        : mappedError(error, requestId),
    );
    return undefined;
  }
}

async function handleLoginOrResume(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "auth.login" | "auth.resume" }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  if (
    context.principal !== undefined ||
    context.accessToken !== undefined ||
    context.authOperationPending
  ) {
    sendFrame(
      socket,
      errorFrame(
        409,
        "already_authenticated",
        "Socket already owns an authenticated session",
        frame.requestId,
      ),
    );
    return;
  }

  context.authOperationPending = true;
  try {
    if (frame.type === "auth.login") {
      const session = await options.auth.login({
        accountId: frame.accountId,
        secret: frame.secret,
      });
      const principal = { accountId: session.accountId, actorId: session.actorId };
      const authenticatedSession = options.outboxStore === undefined
        ? undefined
        : await options.auth.authenticateSession(session.accessToken);
      if (
        authenticatedSession !== undefined &&
        !samePrincipal(authenticatedSession.principal, principal)
      ) {
        throw new AuthenticationError(403, "identity_forbidden");
      }
      if (!installAuthentication(
        context,
        principal,
        session.accessToken,
        authenticatedSession,
      )) {
        return;
      }
      registerIdentitySubscriptions(context, options.subscriptionRegistry);
      sendFrame(socket, authenticatedFrame(frame.requestId, principal, session));
      return;
    }

    const authenticatedSession = options.outboxStore === undefined
      ? undefined
      : await options.auth.authenticateSession(frame.accessToken);
    const principal = authenticatedSession?.principal ??
      await options.auth.authenticate(frame.accessToken);
    if (!installAuthentication(context, principal, frame.accessToken, authenticatedSession)) {
      return;
    }
    registerIdentitySubscriptions(context, options.subscriptionRegistry);
    sendFrame(socket, authenticatedFrame(frame.requestId, principal));
  } catch (error: unknown) {
    if (!context.closed) {
      sendFrame(socket, mappedError(error, frame.requestId));
    }
  } finally {
    context.authOperationPending = false;
  }
}

async function handleRefresh(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "auth.refresh" }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  if (context.authOperationPending) {
    sendFrame(
      socket,
      errorFrame(
        409,
        "already_authenticated",
        "An authentication operation is already active",
        frame.requestId,
      ),
    );
    return;
  }

  const expectedPrincipal = context.principal;
  context.authOperationPending = true;
  try {
    const session = await options.auth.refresh(frame.refreshToken, expectedPrincipal);
    if (context.closed) {
      return;
    }
    const refreshedPrincipal = {
      accountId: session.accountId,
      actorId: session.actorId,
    };
    if (
      expectedPrincipal !== undefined &&
      !samePrincipal(expectedPrincipal, refreshedPrincipal)
    ) {
      sendFrame(
        socket,
        errorFrame(
          403,
          "identity_forbidden",
          "Refresh identity does not match the socket session",
          frame.requestId,
        ),
      );
      return;
    }

    const authenticatedSession = options.outboxStore === undefined
      ? undefined
      : await options.auth.authenticateSession(session.accessToken);
    if (
      authenticatedSession !== undefined &&
      !samePrincipal(authenticatedSession.principal, refreshedPrincipal)
    ) {
      throw new AuthenticationError(403, "identity_forbidden");
    }
    if (!installAuthentication(
      context,
      refreshedPrincipal,
      session.accessToken,
      authenticatedSession,
    )) {
      return;
    }
    registerIdentitySubscriptions(context, options.subscriptionRegistry);
    sendFrame(
      socket,
      authenticatedFrame(frame.requestId, refreshedPrincipal, session),
    );
  } catch (error: unknown) {
    if (!context.closed) {
      sendFrame(socket, mappedError(error, frame.requestId));
    }
  } finally {
    context.authOperationPending = false;
  }
}

async function handleRevoke(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "auth.revoke" }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  const accessToken = context.accessToken;
  if (context.principal === undefined || accessToken === undefined) {
    sendFrame(
      socket,
      errorFrame(401, "unauthenticated", "Authentication is required", frame.requestId),
    );
    return;
  }

  context.authOperationPending = true;
  try {
    await options.auth.revoke(accessToken);
    if (options.outboxStore === undefined) {
      clearAuthentication(context);
      sendFrame(socket, { type: "auth.revoked", requestId: frame.requestId });
    } else {
      context.terminalRevocationPending = true;
    }
  } catch (error: unknown) {
    if (options.outboxStore === undefined) {
      clearAuthentication(context);
    }
    if (!context.closed) {
      sendFrame(socket, mappedError(error, frame.requestId));
    }
  } finally {
    context.authOperationPending = false;
  }
}

async function handleSubscribe(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "room.subscribe" }>,
  actorId: string,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  if (context.closed) {
    return;
  }
  const generation = (context.subscriptionGenerationsByRoom.get(frame.roomId) ?? 0) + 1;
  context.subscriptionGenerationsByRoom.set(frame.roomId, generation);

  const previousUnsubscribe = context.unsubscribersByRoom.get(frame.roomId);
  context.unsubscribersByRoom.delete(frame.roomId);
  safelyUnsubscribe(previousUnsubscribe);

  if (options.outboxStore !== undefined) {
    const session = context.session;
    const connection = context.registeredConnection;
    const registry = options.subscriptionRegistry;
    if (session === undefined || connection === undefined || registry === undefined) {
      sendFrame(socket, errorFrame(
        401,
        "unauthenticated",
        "Authentication is required",
        frame.requestId,
      ));
      return;
    }
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = onceUnsubscribe(registry.addRoom({
        roomId: frame.roomId,
        connection,
      }));
      context.unsubscribersByRoom.set(frame.roomId, unsubscribe);
      await options.afterSubscribeRegistered?.(frame.roomId);
      if (
        context.closed ||
        context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
      ) {
        safelyUnsubscribe(unsubscribe);
        return;
      }
      const messages = await options.service.history(session, frame.roomId);
      if (
        context.closed ||
        context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
      ) {
        safelyUnsubscribe(unsubscribe);
        return;
      }
      sendFrame(socket, {
        type: "room.history",
        requestId: frame.requestId,
        roomId: frame.roomId,
        messages,
      });
      sendFrame(socket, {
        type: "room.subscribed",
        requestId: frame.requestId,
        roomId: frame.roomId,
      });
      return;
    } catch (error: unknown) {
      safelyUnsubscribe(unsubscribe);
      if (context.unsubscribersByRoom.get(frame.roomId) === unsubscribe) {
        context.unsubscribersByRoom.delete(frame.roomId);
      }
      context.subscriptionGenerationsByRoom.delete(frame.roomId);
      if (!context.closed) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
  }

  let unsubscribe: (() => void) | undefined;
  let deliveryQueue = Promise.resolve();
  try {
    unsubscribe = onceUnsubscribe(
      options.service.subscribe(actorId, frame.roomId, (message) => {
        deliveryQueue = deliveryQueue.then(async () => {
          if (
            context.closed ||
            context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
          ) {
            return;
          }
          try {
            await authenticateCurrent(options, context);
          } catch {
            return;
          }
          if (
            !context.closed &&
            context.subscriptionGenerationsByRoom.get(frame.roomId) === generation
          ) {
            sendFrame(socket, { type: "message.created", message });
          }
        });
        return deliveryQueue;
      }),
    );
    if (context.closed) {
      safelyUnsubscribe(unsubscribe);
      return;
    }
    context.unsubscribersByRoom.set(frame.roomId, unsubscribe);

    await options.afterSubscribeRegistered?.(frame.roomId);
    await deliveryQueue;
    if (
      context.closed ||
      context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
    ) {
      safelyUnsubscribe(unsubscribe);
      return;
    }

    const messages = await options.service.history(actorId, frame.roomId);
    if (
      context.closed ||
      context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
    ) {
      safelyUnsubscribe(unsubscribe);
      return;
    }

    sendFrame(socket, {
      type: "room.history",
      requestId: frame.requestId,
      roomId: frame.roomId,
      messages,
    });
    sendFrame(socket, {
      type: "room.subscribed",
      requestId: frame.requestId,
      roomId: frame.roomId,
    });
  } catch (error: unknown) {
    safelyUnsubscribe(unsubscribe);
    if (context.closed) {
      return;
    }
    if (context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation) {
      return;
    }
    if (context.unsubscribersByRoom.get(frame.roomId) === unsubscribe) {
      context.unsubscribersByRoom.delete(frame.roomId);
    }
    context.subscriptionGenerationsByRoom.delete(frame.roomId);
    sendFrame(socket, mappedError(error, frame.requestId));
  }
}

async function handleFrame(
  socket: WebSocket,
  frame: ClientFrame,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  if (context.terminalRevocationPending) {
    return;
  }
  switch (frame.type) {
    case "auth.login":
    case "auth.resume":
      await handleLoginOrResume(socket, frame, options, context);
      return;
    case "auth.refresh":
      await handleRefresh(socket, frame, options, context);
      return;
    case "auth.revoke":
      await handleRevoke(socket, frame, options, context);
      return;
    case "message.send": {
      const principal = await requirePrincipal(socket, frame.requestId, options, context);
      if (principal === undefined) {
        return;
      }
      try {
        const acknowledgement = options.outboxStore === undefined
          ? await options.service.send(principal.actorId, frame.message)
          : context.session === undefined
            ? (() => { throw new RoomAccessError(); })()
            : await options.service.send({
                ...context.session,
                kind: "human",
                requestId: frame.requestId,
                idempotencyKey: frame.message.id,
              }, frame.message);
        if (!context.closed) {
          sendFrame(socket, { ...acknowledgement, requestId: frame.requestId });
        }
      } catch (error: unknown) {
        if (!context.closed) {
          sendFrame(socket, mappedError(error, frame.requestId));
        }
      }
      return;
    }
    case "room.history": {
      const principal = await requirePrincipal(socket, frame.requestId, options, context);
      if (principal === undefined) {
        return;
      }
      try {
        const messages = options.outboxStore === undefined
          ? await options.service.history(principal.actorId, frame.roomId)
          : context.session === undefined
            ? (() => { throw new RoomAccessError(); })()
            : await options.service.history(context.session, frame.roomId);
        if (!context.closed) {
          sendFrame(socket, {
            type: "room.history",
            requestId: frame.requestId,
            roomId: frame.roomId,
            messages,
          });
        }
      } catch (error: unknown) {
        if (!context.closed) {
          sendFrame(socket, mappedError(error, frame.requestId));
        }
      }
      return;
    }
    case "room.subscribe": {
      const principal = await requirePrincipal(socket, frame.requestId, options, context);
      if (principal === undefined) {
        return;
      }
      await handleSubscribe(socket, frame, principal.actorId, options, context);
    }
  }
}

async function listen(server: HttpServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const rejectOnce = (error: Error) => {
      server.off("error", rejectOnce);
      reject(error);
    };
    server.once("error", rejectOnce);
    server.listen(port, host, () => {
      server.off("error", rejectOnce);
      resolve();
    });
  });
}

export async function startMessageWebSocketServer(
  options: StartMessageWebSocketServerOptions,
): Promise<MessageWebSocketServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const maxBufferedAmountBytes =
    options.maxBufferedAmountBytes ?? MESSAGE_WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES;
  if (!Number.isFinite(maxBufferedAmountBytes) || maxBufferedAmountBytes < 0) {
    throw new RangeError("maxBufferedAmountBytes must be a non-negative finite number");
  }
  const maxQueuedFrameCount =
    options.maxQueuedFrameCount ?? MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_COUNT;
  if (!Number.isSafeInteger(maxQueuedFrameCount) || maxQueuedFrameCount <= 0) {
    throw new RangeError("maxQueuedFrameCount must be a positive safe integer");
  }
  const maxQueuedFrameBytes =
    options.maxQueuedFrameBytes ?? MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_BYTES;
  if (!Number.isSafeInteger(maxQueuedFrameBytes) || maxQueuedFrameBytes <= 0) {
    throw new RangeError("maxQueuedFrameBytes must be a positive safe integer");
  }
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    maxPayload: MESSAGE_WEBSOCKET_MAX_PAYLOAD_BYTES,
  });
  const subscriptionRegistry = options.outboxStore === undefined
    ? undefined
    : options.subscriptionRegistry ?? createSubscriptionRegistry();
  if (options.subscriptionRegistry !== undefined && options.outboxStore === undefined) {
    throw new TypeError("subscriptionRegistry requires outboxStore");
  }
  const runtimeOptions: StartMessageWebSocketServerOptions = {
    ...options,
    ...(subscriptionRegistry === undefined ? {} : { subscriptionRegistry }),
  };
  const activeSockets = new Set<WebSocket>();
  const liveConnections = new Map<
    string,
    { readonly socket: WebSocket; readonly context: ConnectionContext }
  >();
  let nextConnectionId = 0;
  const outboxDispatcher = options.outboxStore === undefined || subscriptionRegistry === undefined
    ? undefined
    : createOutboxDispatcher({
        store: options.outboxStore,
        registry: subscriptionRegistry,
        ...(options.outboxPollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: options.outboxPollIntervalMs }),
        async send(candidate, frame: OutboxDispatchFrame) {
          const live = liveConnections.get(candidate.connectionId);
          const session = live?.context.session;
          if (
            live === undefined ||
            live.context.closed ||
            session === undefined ||
            live.context.credentialGeneration !== candidate.credentialGeneration ||
            session.sessionId !== candidate.sessionId ||
            session.sessionFamilyId !== candidate.sessionFamilyId ||
            !samePrincipal(session.principal, candidate.principal)
          ) {
            return { accepted: false, reason: "closed" };
          }
          return sendFrameWithResult(live.socket, frame);
        },
      });
  let closePromise: Promise<void> | undefined;

  webSocketServer.on("connection", (socket) => {
    maxBufferedAmountBySocket.set(socket, maxBufferedAmountBytes);
    const unsubscribersByRoom = new Map<string, () => void>();
    const identityUnsubscribers = new Set<() => void>();
    const subscriptionGenerationsByRoom = new Map<string, number>();
    const unsubscribeAll = () => {
      for (const unsubscribe of unsubscribersByRoom.values()) {
        safelyUnsubscribe(unsubscribe);
      }
      unsubscribersByRoom.clear();
      for (const unsubscribe of identityUnsubscribers) {
        safelyUnsubscribe(unsubscribe);
      }
      identityUnsubscribers.clear();
      subscriptionGenerationsByRoom.clear();
    };
    const context: ConnectionContext = {
      principal: undefined,
      session: undefined,
      accessToken: undefined,
      credentialGeneration: 0,
      authOperationPending: false,
      terminalRevocationPending: false,
      closed: false,
      unsubscribersByRoom,
      identityUnsubscribers,
      subscriptionGenerationsByRoom,
      unsubscribeAll,
      registeredConnection: undefined,
    };
    const connectionId = `websocket-${++nextConnectionId}`;
    const registeredConnection: RegisteredConnection = {
      connectionId,
      get principal() {
        if (context.session === undefined) {
          throw new TypeError("Connection is not authenticated");
        }
        return context.session.principal;
      },
      get sessionId() {
        if (context.session === undefined) {
          throw new TypeError("Connection is not authenticated");
        }
        return context.session.sessionId;
      },
      get sessionFamilyId() {
        if (context.session === undefined) {
          throw new TypeError("Connection is not authenticated");
        }
        return context.session.sessionFamilyId;
      },
      get credentialGeneration() {
        return context.credentialGeneration;
      },
      revoke() {
        abortConnection(context);
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(4001, "session revoked");
        }
      },
    };
    context.registeredConnection = registeredConnection;
    liveConnections.set(connectionId, { socket, context });
    let frameQueue = Promise.resolve();
    let queuedFrameCount = 0;
    let queuedFrameBytes = 0;
    const abort = () => {
      abortConnection(context);
    };

    abortConnectionBySocket.set(socket, abort);
    activeSockets.add(socket);
    socket.on("close", () => {
      abort();
      activeSockets.delete(socket);
      liveConnections.delete(connectionId);
    });
    socket.on("error", abort);
    socket.on("message", (raw, isBinary) => {
      if (context.closed) {
        return;
      }
      const rawBytes = rawDataByteLength(raw);
      if (
        queuedFrameCount >= maxQueuedFrameCount ||
        rawBytes > maxQueuedFrameBytes - queuedFrameBytes
      ) {
        abortAndTerminate(socket);
        return;
      }
      queuedFrameCount += 1;
      queuedFrameBytes += rawBytes;
      const queued = frameQueue
        .then(async () => {
          if (context.closed) {
            return;
          }
          if (isBinary) {
            sendFrame(
              socket,
              errorFrame(400, "invalid_request", "Binary requests are not supported"),
            );
            return;
          }

          const parsed = parseClientFrame(rawDataToString(raw));
          if (!parsed.ok) {
            sendFrame(socket, parsed.error);
            return;
          }

          try {
            await handleFrame(socket, parsed.frame, runtimeOptions, context);
          } catch {
            if (!context.closed) {
              sendFrame(
                socket,
                errorFrame(
                  500,
                  "internal_error",
                  "Unable to process request",
                  parsed.frame.requestId,
                ),
              );
            }
          }
        })
        .finally(() => {
          queuedFrameCount -= 1;
          queuedFrameBytes -= rawBytes;
        });
      frameQueue = queued.catch(() => undefined);
    });
  });

  await listen(httpServer, host, port);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeWebSocketServer(webSocketServer);
    await closeHttpServer(httpServer);
    throw new Error("Message WebSocket server did not expose a TCP address");
  }
  outboxDispatcher?.start();

  return {
    url: `ws://${host}:${address.port}`,
    close(): Promise<void> {
      closePromise ??= (async () => {
        await outboxDispatcher?.close();
        for (const socket of activeSockets) {
          abortAndTerminate(socket);
        }
        await closeWebSocketServer(webSocketServer);
        await closeHttpServer(httpServer);
      })();
      return closePromise;
    },
  };
}
