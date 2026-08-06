import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { MessageValidationError, type MessageService } from "./service.js";
import {
  parseClientFrame,
  type ClientFrame,
  type ProtocolErrorFrame,
  type ServerFrame,
} from "./protocol.js";

export interface MessageWebSocketServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartMessageWebSocketServerOptions {
  readonly service: MessageService;
  readonly host?: string;
  readonly port?: number;
  readonly afterSubscribeRegistered?: (roomId: string) => void | Promise<void>;
}

function errorFrame(
  code: ProtocolErrorFrame["code"],
  message: string,
  requestId?: string,
): ProtocolErrorFrame {
  if (requestId === undefined) {
    return { type: "error", code, message };
  }

  return { type: "error", code, message, requestId };
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

async function handleFrame(
  socket: WebSocket,
  frame: ClientFrame,
  service: MessageService,
  unsubscribersByRoom: Map<string, () => void>,
  subscriptionGenerationsByRoom: Map<string, number>,
  afterSubscribeRegistered?: (roomId: string) => void | Promise<void>,
): Promise<void> {
  if (frame.type === "message.send") {
    try {
      const acknowledgement = await service.send(frame.message);
      sendFrame(socket, { ...acknowledgement, requestId: frame.requestId });
    } catch (error: unknown) {
      const code = error instanceof MessageValidationError ? error.code : "internal_error";
      sendFrame(socket, errorFrame(code, code, frame.requestId));
    }
    return;
  }

  const previousUnsubscribe = unsubscribersByRoom.get(frame.roomId);
  let unsubscribe: (() => void) | undefined;
  let generation: number | undefined;

  try {
    unsubscribe = service.subscribe(frame.roomId, (message) => {
      sendFrame(socket, { type: "message.created", message });
    });
    try {
      previousUnsubscribe?.();
    } catch {
      safelyUnsubscribe(unsubscribe);
      throw new Error("Unable to replace room subscription");
    }

    generation = (subscriptionGenerationsByRoom.get(frame.roomId) ?? 0) + 1;
    subscriptionGenerationsByRoom.set(frame.roomId, generation);
    unsubscribersByRoom.set(frame.roomId, unsubscribe);

    await afterSubscribeRegistered?.(frame.roomId);
    if (subscriptionGenerationsByRoom.get(frame.roomId) !== generation) {
      return;
    }

    const messages = await service.history(frame.roomId);
    if (subscriptionGenerationsByRoom.get(frame.roomId) !== generation) {
      return;
    }

    sendFrame(socket, {
      type: "message.history",
      requestId: frame.requestId,
      roomId: frame.roomId,
      messages,
    });
  } catch {
    if (generation === undefined) {
      // A failed replacement leaves the prior room subscription installed.
      safelyUnsubscribe(unsubscribe);
      sendFrame(socket, errorFrame("internal_error", "Unable to subscribe to room", frame.requestId));
      return;
    }

    if (subscriptionGenerationsByRoom.get(frame.roomId) !== generation) {
      return;
    }

    safelyUnsubscribe(unsubscribe);
    if (unsubscribersByRoom.get(frame.roomId) === unsubscribe) {
      unsubscribersByRoom.delete(frame.roomId);
    }
    subscriptionGenerationsByRoom.delete(frame.roomId);
    sendFrame(socket, errorFrame("internal_error", "Unable to subscribe to room", frame.requestId));
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

    activeSockets.add(socket);
    socket.on("close", unsubscribeAll);
    socket.on("close", () => {
      activeSockets.delete(socket);
    });
    socket.on("error", unsubscribeAll);
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        sendFrame(socket, errorFrame("invalid_request", "Binary requests are not supported"));
        return;
      }

      const parsed = parseClientFrame(rawDataToString(raw));
      if (!parsed.ok) {
        sendFrame(socket, parsed.error);
        return;
      }

      void handleFrame(
        socket,
        parsed.frame,
        options.service,
        unsubscribersByRoom,
        subscriptionGenerationsByRoom,
        options.afterSubscribeRegistered,
      ).catch(() => {
        sendFrame(socket, errorFrame("internal_error", "Unable to process request", parsed.frame.requestId));
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
