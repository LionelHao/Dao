import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  AuthenticationError,
  type AuthenticatedPrincipal,
  type AuthenticationService,
  type IssuedSession,
} from "./auth.js";
import {
  MessageValidationError,
  RoomAccessError,
  type MessageService,
} from "./service.js";
import {
  parseClientFrame,
  type AuthenticatedFrame,
  type ClientFrame,
  type ProtocolErrorFrame,
  type ServerFrame,
} from "./protocol.js";

export interface MessageWebSocketServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartMessageWebSocketServerOptions {
  readonly auth: AuthenticationService;
  readonly service: MessageService;
  readonly host?: string;
  readonly port?: number;
  readonly afterSubscribeRegistered?: (roomId: string) => void | Promise<void>;
}

interface ConnectionContext {
  principal: AuthenticatedPrincipal | undefined;
  accessToken: string | undefined;
  authOperationPending: boolean;
  readonly unsubscribersByRoom: Map<string, () => void>;
  readonly subscriptionGenerationsByRoom: Map<string, number>;
  readonly unsubscribeAll: () => void;
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
  return errorFrame(500, "internal_error", "Unable to process request", requestId);
}

function sendFrame(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // A closing socket cannot affect another client's accepted message.
  }
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

function clearAuthentication(context: ConnectionContext): void {
  context.principal = undefined;
  context.accessToken = undefined;
  context.unsubscribeAll();
}

async function authenticateCurrent(
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<AuthenticatedPrincipal> {
  const storedPrincipal = context.principal;
  const accessToken = context.accessToken;
  if (storedPrincipal === undefined || accessToken === undefined) {
    throw errorFrame(401, "unauthenticated", "Authentication is required");
  }

  try {
    const principal = await options.auth.authenticate(accessToken);
    if (!samePrincipal(principal, storedPrincipal)) {
      clearAuthentication(context);
      throw errorFrame(403, "identity_forbidden", "Session identity changed");
    }
    return principal;
  } catch (error: unknown) {
    clearAuthentication(context);
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
  if (context.principal === undefined || context.accessToken === undefined) {
    sendFrame(
      socket,
      errorFrame(401, "unauthenticated", "Authentication is required", requestId),
    );
    return undefined;
  }

  try {
    return await authenticateCurrent(options, context);
  } catch (error: unknown) {
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
      context.principal = principal;
      context.accessToken = session.accessToken;
      sendFrame(socket, authenticatedFrame(frame.requestId, principal, session));
      return;
    }

    const principal = await options.auth.authenticate(frame.accessToken);
    context.principal = principal;
    context.accessToken = frame.accessToken;
    sendFrame(socket, authenticatedFrame(frame.requestId, principal));
  } catch (error: unknown) {
    sendFrame(socket, mappedError(error, frame.requestId));
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
  const principal = await requirePrincipal(socket, frame.requestId, options, context);
  if (principal === undefined) {
    return;
  }
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

  context.authOperationPending = true;
  try {
    const session = await options.auth.refresh(frame.refreshToken, principal);
    const refreshedPrincipal = {
      accountId: session.accountId,
      actorId: session.actorId,
    };
    if (!samePrincipal(principal, refreshedPrincipal)) {
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

    context.principal = refreshedPrincipal;
    context.accessToken = session.accessToken;
    sendFrame(
      socket,
      authenticatedFrame(frame.requestId, refreshedPrincipal, session),
    );
  } catch (error: unknown) {
    sendFrame(socket, mappedError(error, frame.requestId));
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
    clearAuthentication(context);
    sendFrame(socket, { type: "auth.revoked", requestId: frame.requestId });
  } catch (error: unknown) {
    clearAuthentication(context);
    sendFrame(socket, mappedError(error, frame.requestId));
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
  const generation = (context.subscriptionGenerationsByRoom.get(frame.roomId) ?? 0) + 1;
  context.subscriptionGenerationsByRoom.set(frame.roomId, generation);

  const previousUnsubscribe = context.unsubscribersByRoom.get(frame.roomId);
  context.unsubscribersByRoom.delete(frame.roomId);
  safelyUnsubscribe(previousUnsubscribe);

  let unsubscribe: (() => void) | undefined;
  let deliveryQueue = Promise.resolve();
  try {
    unsubscribe = options.service.subscribe(actorId, frame.roomId, (message) => {
      deliveryQueue = deliveryQueue.then(async () => {
        if (context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation) {
          return;
        }
        try {
          await authenticateCurrent(options, context);
        } catch {
          return;
        }
        if (context.subscriptionGenerationsByRoom.get(frame.roomId) === generation) {
          sendFrame(socket, { type: "message.created", message });
        }
      });
      return deliveryQueue;
    });
    context.unsubscribersByRoom.set(frame.roomId, unsubscribe);

    await options.afterSubscribeRegistered?.(frame.roomId);
    await deliveryQueue;
    if (context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation) {
      safelyUnsubscribe(unsubscribe);
      return;
    }

    const messages = await options.service.history(actorId, frame.roomId);
    if (context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation) {
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
        const acknowledgement = await options.service.send(principal.actorId, frame.message);
        sendFrame(socket, { ...acknowledgement, requestId: frame.requestId });
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
    case "room.history": {
      const principal = await requirePrincipal(socket, frame.requestId, options, context);
      if (principal === undefined) {
        return;
      }
      try {
        const messages = await options.service.history(principal.actorId, frame.roomId);
        sendFrame(socket, {
          type: "room.history",
          requestId: frame.requestId,
          roomId: frame.roomId,
          messages,
        });
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId));
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
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ server: httpServer });
  const activeSockets = new Set<WebSocket>();
  let closePromise: Promise<void> | undefined;

  webSocketServer.on("connection", (socket) => {
    const unsubscribersByRoom = new Map<string, () => void>();
    const subscriptionGenerationsByRoom = new Map<string, number>();
    const unsubscribeAll = () => {
      for (const unsubscribe of unsubscribersByRoom.values()) {
        safelyUnsubscribe(unsubscribe);
      }
      unsubscribersByRoom.clear();
      subscriptionGenerationsByRoom.clear();
    };
    const context: ConnectionContext = {
      principal: undefined,
      accessToken: undefined,
      authOperationPending: false,
      unsubscribersByRoom,
      subscriptionGenerationsByRoom,
      unsubscribeAll,
    };

    activeSockets.add(socket);
    socket.on("close", unsubscribeAll);
    socket.on("close", () => {
      activeSockets.delete(socket);
    });
    socket.on("error", unsubscribeAll);
    socket.on("message", (raw, isBinary) => {
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

      void handleFrame(socket, parsed.frame, options, context).catch(() => {
        sendFrame(
          socket,
          errorFrame(
            500,
            "internal_error",
            "Unable to process request",
            parsed.frame.requestId,
          ),
        );
      });
    });
  });

  await listen(httpServer, host, port);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeWebSocketServer(webSocketServer);
    await closeHttpServer(httpServer);
    throw new Error("Message WebSocket server did not expose a TCP address");
  }

  return {
    url: `ws://${host}:${address.port}`,
    close(): Promise<void> {
      closePromise ??= (async () => {
        for (const socket of activeSockets) {
          socket.terminate();
        }
        await closeWebSocketServer(webSocketServer);
        await closeHttpServer(httpServer);
      })();
      return closePromise;
    },
  };
}
