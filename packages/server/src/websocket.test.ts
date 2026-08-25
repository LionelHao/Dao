import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer as createTcpServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { SnapshotWorkerClientError } from "./persistence/snapshot-worker-client.js";
import { AuthorityWorkerClientError } from "./persistence/worker-database-client.js";
import {
  isMessage,
  type Actor,
  type DepartureConflictList,
  type Message,
  type MessageDraft,
  type PersistedIdentityEvent,
  type PersistedRoomEvent,
  type RoomGovernanceView,
} from "@native-im/core";
import {
  createAuthenticationService,
  createJsonlMessageStore,
  createJsonStateStore,
  createMessageService,
  createRoomLifecycleService,
  isRoomLifecycleState,
  isSessionState,
  startMessageWebSocketServer,
  AuthenticationError,
  type AuthenticatedPrincipal,
  type AuthenticationService,
  type IdentityAdapter,
  type IssuedSession,
  type LoginCredentials,
  type MessageService,
  type MessageStore,
  type MessageWebSocketServer,
  type OutboxDelivery,
  type OutboxDispatchCandidate,
  type OutboxDispatchStore,
  type RoomLifecycleService,
  type SyncService,
  createSyncService,
  createSubscriptionRegistry,
} from "./index.js";
import {
  formatMessageWebSocketUrl,
  validateMessageWebSocketListener,
  type AgentPreviewDeliveryAuthority,
  type RoomMemoryAuthorityTransport,
} from "./websocket.js";

const humans = [
  {
    id: "human-1",
    kind: "human",
    displayName: "Lionel",
    reachability: "online",
  },
  {
    id: "human-2",
    kind: "human",
    displayName: "Ada",
    reachability: "online",
  },
  {
    id: "human-3",
    kind: "human",
    displayName: "Grace",
    reachability: "dnd",
  },
] as const satisfies readonly Actor[];

const agents = [
  {
    id: "agent-1",
    kind: "agent",
    displayName: "Research",
    readiness: "ready",
    toolPermissions: ["search"],
  },
  {
    id: "agent-2",
    kind: "agent",
    displayName: "Build",
    readiness: "busy",
    toolPermissions: ["filesystem"],
  },
  {
    id: "agent-3",
    kind: "agent",
    displayName: "Review",
    readiness: "paused",
    toolPermissions: [],
  },
  {
    id: "agent-4",
    kind: "agent",
    displayName: "Deploy",
    readiness: "noauth",
    toolPermissions: ["deploy"],
  },
] as const satisfies readonly Actor[];

const testLoginDevice = Object.freeze({
  id: "websocket-test-installation",
  label: "WebSocket test device",
  platform: "unknown" as const,
});

const outsider = {
  id: "human-outsider",
  kind: "human",
  displayName: "Outside",
  reachability: "offline",
} as const satisfies Actor;
const actors = [...humans, ...agents, outsider] as const;
const roomId = "room-1";

const credentialsByAccount = new Map(
  actors.map((actor) => [
    `account-${actor.id}`,
    { actorId: actor.id, secret: `secret-${actor.id}` },
  ]),
);

const identityAdapter: IdentityAdapter = {
  async verify(credentials: LoginCredentials) {
    const identity = credentialsByAccount.get(credentials.accountId);
    if (identity === undefined || identity.secret !== credentials.secret) {
      return undefined;
    }
    return { accountId: credentials.accountId, actorId: identity.actorId };
  },
};

interface ReceivedFrame {
  readonly frame: unknown;
  readonly receivedAt: number;
}

interface SessionFrame extends Record<string, unknown> {
  readonly type: "auth.authenticated";
  readonly requestId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly sessionId?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasType(value: unknown, type: string): value is Record<string, unknown> {
  return isRecord(value) && value.type === type;
}

function hasMessageCreated(value: unknown, messageId: string): boolean {
  return hasType(value, "message.created") && isMessage(value.message) && value.message.id === messageId;
}

function hasHistory(value: unknown, requestId: string): value is Record<string, unknown> {
  return hasType(value, "room.history") && value.requestId === requestId && Array.isArray(value.messages);
}

function hasAcceptance(value: unknown, messageId: string, requestId?: string): boolean {
  return (
    hasType(value, "message.accepted") &&
    value.messageId === messageId &&
    (requestId === undefined || value.requestId === requestId) &&
    typeof value.persistedAt === "string"
  );
}

class LoopbackClient {
  private readonly receivedFrames: ReceivedFrame[] = [];
  private readonly messagesById = new Map<string, Message>();
  private readonly waiters: Array<{
    readonly predicate: (frame: unknown) => boolean;
    readonly resolve: (frame: ReceivedFrame) => void;
  }> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as unknown;
      const received = { frame, receivedAt: Date.now() };
      this.receivedFrames.push(received);
      this.recordMessages(frame);

      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(received);
        }
      }
    });
  }

  static async connect(url: string, timeoutMs = 1_000): Promise<LoopbackClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(deadline);
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      const onOpen = (): void => { cleanup(); resolve(); };
      const onError = (error: Error): void => { cleanup(); reject(error); };
      const deadline = setTimeout(() => {
        cleanup();
        socket.once("error", () => undefined);
        socket.terminate();
        reject(new Error(`Loopback WebSocket did not connect within ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
    return new LoopbackClient(socket);
  }

  async login(
    actor: Actor,
    requestId = `login-${actor.id}`,
    device = {
      id: `installation-${actor.id}`,
      label: `Test device for ${actor.displayName}`,
      platform: "unknown" as const,
    },
  ): Promise<SessionFrame> {
    const accountId = `account-${actor.id}`;
    this.send({
      type: "auth.login",
      requestId,
      accountId,
      secret: `secret-${actor.id}`,
      device,
    });
    const received = await this.waitForAuthentication(requestId);
    return received.frame as SessionFrame;
  }

  async resume(accessToken: string, requestId = "resume"): Promise<ReceivedFrame> {
    this.send({ type: "auth.resume", requestId, accessToken });
    return this.waitForAuthentication(requestId);
  }

  async refresh(refreshToken: string, requestId = "refresh"): Promise<ReceivedFrame> {
    this.send({ type: "auth.refresh", requestId, refreshToken });
    return this.waitForAuthentication(requestId);
  }

  async revoke(requestId = "revoke"): Promise<ReceivedFrame> {
    this.send({ type: "auth.revoke", requestId });
    return this.waitFor(
      (frame) => hasType(frame, "auth.revoked") && frame.requestId === requestId,
      `revocation ${requestId}`,
    );
  }

  async listSessions(requestId = "sessions-list"): Promise<ReceivedFrame> {
    this.send({ type: "auth.sessions.list", requestId });
    return this.waitFor(
      (frame) => hasType(frame, "auth.sessions") && frame.requestId === requestId,
      `session list ${requestId}`,
    );
  }

  async revokeSession(
    sessionId: string,
    requestId = "session-revoke",
  ): Promise<ReceivedFrame> {
    this.send({ type: "auth.session.revoke", requestId, sessionId });
    return this.waitFor(
      (frame) =>
        hasType(frame, "auth.session.revoke.ack") &&
        frame.requestId === requestId &&
        frame.sessionId === sessionId,
      `targeted session revocation ${requestId}`,
    );
  }

  async subscribe(room: string, requestId = `subscribe-${room}`): Promise<ReceivedFrame> {
    this.send({ type: "room.subscribe", requestId, roomId: room });
    const history = await this.waitForHistory(requestId);
    await this.waitFor(
      (frame) => hasType(frame, "room.subscribed") && frame.requestId === requestId,
      `subscription ${requestId}`,
    );
    return history;
  }

  async history(room: string, requestId = `history-${room}`): Promise<ReceivedFrame> {
    this.send({ type: "room.history", requestId, roomId: room });
    return this.waitForHistory(requestId);
  }

  async sendDraft(message: MessageDraft, requestId = message.id): Promise<ReceivedFrame> {
    this.send({ type: "message.send", requestId, message });
    return this.waitFor(
      (frame) => hasAcceptance(frame, message.id, requestId),
      "persisted acceptance acknowledgement",
    );
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  sendRaw(value: string): void {
    this.socket.send(value);
  }

  messages(room: string): readonly Message[] {
    return [...this.messagesById.values()].filter((message) => message.roomId === room);
  }

  waitForMessage(messageId: string, timeoutMs?: number): Promise<ReceivedFrame> {
    return this.waitFor(
      (frame) => hasMessageCreated(frame, messageId),
      `live message ${messageId}`,
      timeoutMs,
    );
  }

  waitForHistory(requestId: string, timeoutMs?: number): Promise<ReceivedFrame> {
    return this.waitFor((frame) => hasHistory(frame, requestId), `history ${requestId}`, timeoutMs);
  }

  waitForAcceptance(messageId: string): Promise<ReceivedFrame> {
    return this.waitFor(
      (frame) => hasAcceptance(frame, messageId),
      `acceptance acknowledgement for ${messageId}`,
    );
  }

  waitForError(code: string, requestId?: string): Promise<ReceivedFrame> {
    return this.waitFor(
      (frame) =>
        hasType(frame, "error") &&
        frame.code === code &&
        typeof frame.status === "number" &&
        typeof frame.message === "string" &&
        (requestId === undefined || frame.requestId === requestId),
      `error ${code}`,
    );
  }

  waitForFrame(
    predicate: (frame: unknown) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<ReceivedFrame> {
    return this.waitFor(predicate, description, timeoutMs);
  }

  async close(timeoutMs = 1_000): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onClose = (): void => {
        cleanup();
        resolve();
      };
      const deadline = setTimeout(() => {
        cleanup();
        this.socket.terminate();
        reject(new Error(`Loopback WebSocket did not close within ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(deadline);
        this.socket.off("close", onClose);
      };
      this.socket.once("close", onClose);
      this.socket.close();
    });
  }

  async waitForClose(timeoutMs = 1_000): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onClose = (): void => {
        cleanup();
        resolve();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for socket close"));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.socket.off("close", onClose);
      };
      this.socket.once("close", onClose);
    });
  }

  closeListenerCountForTest(): number {
    return this.socket.listenerCount("close");
  }

  frameIndex(predicate: (frame: unknown) => boolean): number {
    return this.receivedFrames.findIndex((entry) => predicate(entry.frame));
  }

  frameCount(predicate: (frame: unknown) => boolean): number {
    return this.receivedFrames.filter((entry) => predicate(entry.frame)).length;
  }

  historyFrames(requestId: string): readonly ReceivedFrame[] {
    return this.receivedFrames.filter((entry) => hasHistory(entry.frame, requestId));
  }

  waitForAuthentication(requestId: string, timeoutMs?: number): Promise<ReceivedFrame> {
    return this.waitFor(
      (frame) => hasType(frame, "auth.authenticated") && frame.requestId === requestId,
      `authentication ${requestId}`,
      timeoutMs,
    );
  }

  private waitFor(
    predicate: (frame: unknown) => boolean,
    description: string,
    timeoutMs = 1_000,
  ): Promise<ReceivedFrame> {
    const received = this.receivedFrames.find((entry) => predicate(entry.frame));
    if (received !== undefined) {
      return Promise.resolve(received);
    }

    return new Promise<ReceivedFrame>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (frame: ReceivedFrame) => {
          clearTimeout(timeout);
          resolve(frame);
        },
      };
      const timeout = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex >= 0) {
          this.waiters.splice(waiterIndex, 1);
        }
        reject(new Error(`Timed out waiting for ${description}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private recordMessages(frame: unknown): void {
    if (hasType(frame, "message.created") && isMessage(frame.message)) {
      this.messagesById.set(frame.message.id, frame.message);
      return;
    }
    if (hasType(frame, "room.history") && Array.isArray(frame.messages)) {
      for (const message of frame.messages) {
        if (isMessage(message)) {
          this.messagesById.set(message.id, message);
        }
      }
    }
  }
}

async function createStalledWebSocketPeer(handshake: boolean): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (!handshake) return;
    let request = "";
    socket.on("data", (chunk: Buffer) => {
      request += chunk.toString("utf8");
      if (!request.includes("\r\n\r\n")) return;
      const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(request)?.[1]?.trim();
      if (key === undefined) return;
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.removeAllListeners("data");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("missing TCP port");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function draftFor(id: string, room = roomId): MessageDraft {
  return {
    id,
    roomId: room,
    body: `Message ${id}`,
    sentAt: "2026-08-06T00:01:00.000Z",
  };
}

function messageFor(actor: Actor, id: string, room = roomId): Message {
  return {
    ...draftFor(id, room),
    authorId: actor.id,
    authorKind: actor.kind,
  };
}

function sequenceFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Promise did not settle within ${timeoutMs}ms`)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function issuedSession(
  principal: AuthenticatedPrincipal,
  tokenPrefix: string,
): IssuedSession {
  return {
    ...principal,
    sessionId: `${tokenPrefix}-session`,
    accessToken: `${tokenPrefix}-access`,
    refreshToken: `${tokenPrefix}-refresh`,
    expiresAt: "2026-08-10T01:00:00.000Z",
    refreshExpiresAt: "2026-08-11T00:00:00.000Z",
  };
}

function idleMessageService(): MessageService {
  return {
    async send(_actorId, message) {
      return {
        type: "message.accepted",
        requestId: message.id,
        messageId: message.id,
        persistedAt: "2026-08-18T00:00:00.000Z",
      };
    },
    subscribe() { return () => undefined; },
    async history() { return []; },
  };
}

function idleOutboxStore(): OutboxDispatchStore {
  return {
    async listPendingOutbox() { return []; },
    async authorizeOutboxCandidate() { return false; },
    async markOutboxDispatched() {},
    async markOutboxFailed() {},
  };
}

async function populateRoom(rooms: RoomLifecycleService): Promise<void> {
  if (rooms.getRoom(roomId) !== undefined) {
    return;
  }
  const created = await rooms.createRoom(humans[0].id, { name: "Native IM" });
  expect(created.id).toBe(roomId);

  for (const human of humans.slice(1)) {
    const invitation = await rooms.inviteHuman(humans[0].id, {
      kind: "human-invitation",
      roomId,
      inviteeActorId: human.id,
    });
    await rooms.respondToHumanInvitation(human.id, invitation.token, "accept");
  }
  for (const agent of agents) {
    if (agent.toolPermissions.length === 0) {
      continue;
    }
    await rooms.configureAgent(humans[0].id, {
      kind: "agent-configuration",
      roomId,
      agentId: agent.id,
      participation: "active",
      toolPermissions: agent.toolPermissions,
    });
  }
}

async function createFixture(options: {
  readonly maxBufferedAmountBytes?: number;
  readonly memoryAuthority?: RoomMemoryAuthorityTransport;
} = {}): Promise<{
  readonly connect: () => Promise<LoopbackClient>;
  readonly clients: readonly LoopbackClient[];
  readonly close: () => Promise<void>;
  readonly closeServer: () => Promise<void>;
  readonly restartServer: () => Promise<void>;
  readonly setSubscriptionRace: (hook: () => Promise<void>) => void;
  readonly advanceClock: (milliseconds: number) => void;
  readonly messages: () => Promise<readonly Message[]>;
  readonly rooms: () => RoomLifecycleService;
  readonly service: () => MessageService;
}> {
  const directory = await mkdtemp(join(tmpdir(), "native-im-websocket-"));
  const sessionsPath = join(directory, "sessions.json");
  const roomsPath = join(directory, "rooms.json");
  const messagesPath = join(directory, "messages.jsonl");
  const clients: LoopbackClient[] = [];
  const servers: MessageWebSocketServer[] = [];
  let now = Date.parse("2026-08-09T08:00:00.000Z");
  let activeServer: MessageWebSocketServer | undefined;
  let activeRooms: RoomLifecycleService | undefined;
  let activeService: MessageService | undefined;
  let afterSubscribeRegistered: (() => Promise<void>) | undefined;

  async function start(): Promise<void> {
    const rooms = await createRoomLifecycleService({
      actors,
      state: createJsonStateStore(roomsPath, isRoomLifecycleState),
      clock: () => now,
      idFactory: sequenceFactory("room"),
      tokenFactory: sequenceFactory("invitation"),
    });
    await populateRoom(rooms);
    const auth = createAuthenticationService({
      actors: rooms,
      identities: identityAdapter,
      sessions: createJsonStateStore(sessionsPath, isSessionState),
      clock: () => now,
      accessTtlMs: 1_000,
      refreshTtlMs: 10_000,
    });
    const service = createMessageService({
      directory: rooms,
      store: createJsonlMessageStore(messagesPath),
    });
    activeRooms = rooms;
    activeService = service;
    activeServer = await startMessageWebSocketServer({
      auth,
      service,
      maxBufferedAmountBytes: options.maxBufferedAmountBytes,
      memoryAuthority: options.memoryAuthority,
      afterSubscribeRegistered: async () => {
        const hook = afterSubscribeRegistered;
        afterSubscribeRegistered = undefined;
        await hook?.();
      },
    });
    servers.push(activeServer);
  }

  await start();

  return {
    connect: async () => {
      if (activeServer === undefined) {
        throw new Error("server is not running");
      }
      const client = await LoopbackClient.connect(activeServer.url);
      clients.push(client);
      return client;
    },
    clients,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
      await Promise.all(servers.map((server) => server.close()));
      await rm(directory, { recursive: true, force: true });
    },
    closeServer: async () => {
      await activeServer?.close();
      activeServer = undefined;
    },
    restartServer: async () => {
      await activeServer?.close();
      activeServer = undefined;
      await start();
    },
    setSubscriptionRace: (hook) => {
      afterSubscribeRegistered = hook;
    },
    advanceClock: (milliseconds) => {
      now += milliseconds;
    },
    messages: () => createJsonlMessageStore(messagesPath).list(roomId),
    rooms: () => {
      if (activeRooms === undefined) {
        throw new Error("room directory is unavailable");
      }
      return activeRooms;
    },
    service: () => {
      if (activeService === undefined) {
        throw new Error("message service is unavailable");
      }
      return activeService;
    },
  };
}

const fixtures: Array<Awaited<ReturnType<typeof createFixture>>> = [];

function previewDeliveryAuthority(
  authorize: (input: Parameters<AgentPreviewDeliveryAuthority["deliver"]>[0]) =>
    Promise<Readonly<{ authorized: boolean; authorityEpoch: string }>>,
): AgentPreviewDeliveryAuthority {
  return {
    async deliver(input, send) {
      send(await authorize(input));
    },
  };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("authenticated message WebSocket service", () => {
  it("publishes transient preview/reset only through the current scoped authority receipt", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-authorized");
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; },
      async revoke() {},
    };
    let authorizationCall = 0;
    const authorize = vi.fn(async () => {
      authorizationCall += 1;
      return authorizationCall === 2
        ? { authorized: false, authorityEpoch: "access:2" }
        : { authorized: true, authorityEpoch: authorizationCall >= 3 ? "access:2" : "access:1" };
    });
    const server = await startMessageWebSocketServer({
      auth,
      service: idleMessageService(),
      outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(authorize),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      await client.subscribe(roomId);
      await server.publishAgentPreview({
        roomId, executionId: "execution-preview-authorized", attemptSeq: 1,
        streamSeq: 1, delta: "TRANSIENT",
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "agent.execution.preview"),
        "authorized preview",
      )).resolves.toMatchObject({ frame: {
        type: "agent.execution.preview", roomId,
        executionId: "execution-preview-authorized", attemptSeq: 1,
        streamSeq: 1, delta: "TRANSIENT", authoritative: false,
      } });
      await server.resetAgentPreview({
        roomId, executionId: "execution-preview-authorized", attemptSeq: 1,
        reason: "execution_terminal",
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "agent.execution.preview.reset"),
        "authorized preview reset",
      )).resolves.toMatchObject({ frame: {
        type: "agent.execution.preview.reset", roomId,
        executionId: "execution-preview-authorized", attemptSeq: 1,
        reason: "execution_terminal", authoritative: false,
      } });
      expect(authorize).toHaveBeenNthCalledWith(2, expect.objectContaining({
        deliveryKind: "reset",
        expectedAuthorityEpoch: "access:1",
      }));
      expect(authorize).toHaveBeenNthCalledWith(3, expect.objectContaining({
        deliveryKind: "reset",
        expectedAuthorityEpoch: "access:2",
      }));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rechecks preview authority after a committed revoke and emits zero frames", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-revoke");
    const authorization = deferred<Readonly<{ authorized: boolean; authorityEpoch: string }>>();
    const authorizationStarted = deferred<void>();
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; },
      async revoke() {},
    };
    const server = await startMessageWebSocketServer({
      auth,
      service: idleMessageService(),
      outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(async () => {
          authorizationStarted.resolve();
          return authorization.promise;
      }),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      await client.subscribe(roomId);
      const delivery = server.publishAgentPreview({
        roomId, executionId: "execution-preview-revoked", attemptSeq: 1,
        streamSeq: 1, delta: "MUST-NOT-LEAK",
      });
      await authorizationStarted.promise;
      authorization.resolve({ authorized: false, authorityEpoch: "revoked:2" });
      await delivery;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(client.frameCount((frame) => hasType(frame, "agent.execution.preview"))).toBe(0);
    } finally {
      authorization.resolve({ authorized: false, authorityEpoch: "revoked:2" });
      await client.close();
      await server.close();
    }
  });

  it("bounds blocked preview authority work per Room without blocking another Room", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-bounded");
    const blocked = deferred<void>();
    const firstStarted = deferred<void>();
    let roomOneCalls = 0;
    const auth: AuthenticationService = {
      async login() { return session; }, async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; }, async revoke() {},
    };
    const server = await startMessageWebSocketServer({
      auth, service: idleMessageService(), outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(async (input) => {
        if (input.roomId === roomId) {
          roomOneCalls += 1;
          if (roomOneCalls === 1) { firstStarted.resolve(); await blocked.promise; }
        }
        return { authorized: true, authorityEpoch: "bounded:1" };
      }),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      await client.subscribe(roomId, "subscribe-bounded-one");
      await client.subscribe("room-2", "subscribe-bounded-two");
      const deliveries = [server.publishAgentPreview({ roomId, executionId: "blocked-0",
        attemptSeq: 1, streamSeq: 1, delta: "x" })];
      await firstStarted.promise;
      for (let index = 1; index < 200; index += 1) {
        deliveries.push(server.publishAgentPreview({ roomId, executionId: `blocked-${index}`,
          attemptSeq: 1, streamSeq: index + 1, delta: "x" }));
      }
      await server.publishAgentPreview({ roomId: "room-2", executionId: "isolated",
        attemptSeq: 1, streamSeq: 1, delta: "ROOM-TWO" });
      await expect(client.waitForFrame((frame) => hasType(frame, "agent.execution.preview") &&
        frame.roomId === "room-2", "isolated Room preview")).resolves.toMatchObject({ frame: {
          roomId: "room-2", delta: "ROOM-TWO",
        } });
      expect(roomOneCalls).toBe(1);
      blocked.resolve();
      await Promise.all(deliveries);
      await vi.waitFor(() => expect(roomOneCalls).toBeLessThanOrEqual(64));
    } finally {
      blocked.resolve(); await client.close(); await server.close();
    }
  });

  it("retains bounded reset markers for two visible executions when the Room queue overflows", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-multi-reset");
    const blocked = deferred<void>();
    const blockedStarted = deferred<void>();
    let blockNext = false;
    const auth: AuthenticationService = {
      async login() { return session; }, async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; }, async revoke() {},
    };
    const server = await startMessageWebSocketServer({
      auth, service: idleMessageService(), outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(async () => {
        if (blockNext) {
          blockNext = false;
          blockedStarted.resolve();
          await blocked.promise;
        }
        return { authorized: true, authorityEpoch: "multi-reset:1" };
      }),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      await client.subscribe(roomId);
      await server.publishAgentPreview({ roomId, executionId: "visible-a", attemptSeq: 1,
        streamSeq: 1, delta: "A" });
      await server.publishAgentPreview({ roomId, executionId: "visible-b", attemptSeq: 1,
        streamSeq: 1, delta: "B" });
      await client.waitForFrame((frame) => hasType(frame, "agent.execution.preview") &&
        frame.executionId === "visible-b", "second visible preview");

      blockNext = true;
      const deliveries = [server.publishAgentPreview({ roomId, executionId: "queued-0",
        attemptSeq: 1, streamSeq: 1, delta: "x" })];
      await blockedStarted.promise;
      for (let index = 1; index < 32; index += 1) {
        deliveries.push(server.publishAgentPreview({ roomId, executionId: `queued-${index}`,
          attemptSeq: 1, streamSeq: 1, delta: "x" }));
      }
      await server.resetAgentPreview({ roomId, executionId: "visible-a", attemptSeq: 1,
        reason: "execution_terminal" });
      await server.resetAgentPreview({ roomId, executionId: "visible-b", attemptSeq: 1,
        reason: "attempt_rolled_over" });
      blocked.resolve();
      await Promise.all(deliveries);

      await expect(client.waitForFrame((frame) => hasType(frame, "agent.execution.preview.reset") &&
        frame.executionId === "visible-a", "first overflow reset")).resolves.toMatchObject({
          frame: { executionId: "visible-a", reason: "execution_terminal" },
        });
      await expect(client.waitForFrame((frame) => hasType(frame, "agent.execution.preview.reset") &&
        frame.executionId === "visible-b", "second overflow reset")).resolves.toMatchObject({
          frame: { executionId: "visible-b", reason: "attempt_rolled_over" },
        });
      expect(client.frameCount((frame) => hasType(frame, "agent.execution.preview.reset") &&
        (frame.executionId === "visible-a" || frame.executionId === "visible-b"))).toBe(2);
    } finally {
      blocked.resolve(); await client.close(); await server.close();
    }
  });

  it("fails closed when an overflow reset cannot fit the exact Room byte budget", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-reset-byte-budget");
    const blocked = deferred<void>();
    const blockedStarted = deferred<void>();
    let blockNext = false;
    const auth: AuthenticationService = {
      async login() { return session; }, async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; }, async revoke() {},
    };
    const server = await startMessageWebSocketServer({
      auth, service: idleMessageService(), outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(async () => {
        if (blockNext) {
          blockNext = false;
          blockedStarted.resolve();
          await blocked.promise;
        }
        return { authorized: true, authorityEpoch: "reset-byte-budget:1" };
      }),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      await client.subscribe(roomId);
      blockNext = true;
      const delivery = server.publishAgentPreview({
        roomId, executionId: "queued", attemptSeq: 1, streamSeq: 1, delta: "x",
      });
      await blockedStarted.promise;
      await server.resetAgentPreview({
        roomId,
        executionId: "oversized-".padEnd(270 * 1_024, "x"),
        attemptSeq: 1,
        reason: "execution_terminal",
      });
      await client.waitForClose();
      blocked.resolve();
      await delivery;
    } finally {
      blocked.resolve(); await client.close(); await server.close();
    }
  });

  it("delivers an idle lifecycle reset that uses the reserved reset byte budget", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-idle-large-reset");
    const auth: AuthenticationService = {
      async login() { return session; }, async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; }, async revoke() {},
    };
    const server = await startMessageWebSocketServer({
      auth, service: idleMessageService(), outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(async () => ({
        authorized: true, authorityEpoch: "idle-large-reset:1",
      })),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      await client.subscribe(roomId);
      const executionId = "idle-large-reset-".padEnd(140 * 1_024, "x");
      await server.resetAgentPreview({
        roomId, executionId, attemptSeq: 1, reason: "execution_terminal",
      });
      await expect(client.waitForFrame((frame) => hasType(frame, "agent.execution.preview.reset") &&
        frame.executionId === executionId, "idle large reset")).resolves.toMatchObject({ frame: {
          executionId, reason: "execution_terminal",
        } });
    } finally {
      await client.close(); await server.close();
    }
  });

  it("does not deliver queued transient work to a later connection generation", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-publish-generation");
    const blocked = deferred<void>();
    const blockedStarted = deferred<void>();
    let calls = 0;
    const auth: AuthenticationService = {
      async login() { return session; }, async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; }, async revoke() {},
    };
    const server = await startMessageWebSocketServer({
      auth, service: idleMessageService(), outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(async () => {
        calls += 1;
        if (calls === 1) { blockedStarted.resolve(); await blocked.promise; }
        return { authorized: false, authorityEpoch: "publish-generation:closed" };
      }),
    });
    const first = await LoopbackClient.connect(server.url);
    let second: LoopbackClient | undefined;
    try {
      await first.login(humans[0]);
      await first.subscribe(roomId, "subscribe-publish-generation-old");
      const head = server.publishAgentPreview({
        roomId, executionId: "publish-generation-head", attemptSeq: 1,
        streamSeq: 1, delta: "HEAD",
      });
      await blockedStarted.promise;
      const queued = server.publishAgentPreview({
        roomId, executionId: "publish-generation-stale", attemptSeq: 1,
        streamSeq: 1, delta: "MUST-NOT-CROSS-CONNECTION",
      });
      await first.close();
      second = await LoopbackClient.connect(server.url);
      await second.login(humans[0], "login-publish-generation-new");
      await second.subscribe(roomId, "subscribe-publish-generation-new");
      blocked.resolve();
      await Promise.all([head, queued]);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(second.frameCount((frame) => hasType(frame, "agent.execution.preview") &&
        frame.executionId === "publish-generation-stale")).toBe(0);
    } finally {
      blocked.resolve(); await first.close(); await second?.close(); await server.close();
    }
  });

  it("clears orphaned visible preview state when a registered connection is revoked", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-revoked-visible-cleanup");
    const blocked = deferred<void>();
    const blockedStarted = deferred<void>();
    let blockNext = false;
    const auth: AuthenticationService = {
      async login() { return session; }, async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; }, async revoke() {},
    };
    const registry = createSubscriptionRegistry();
    const server = await startMessageWebSocketServer({
      auth, service: idleMessageService(), outboxStore: idleOutboxStore(),
      subscriptionRegistry: registry,
      previewAuthority: previewDeliveryAuthority(async () => {
        if (blockNext) {
          blockNext = false;
          blockedStarted.resolve();
          await blocked.promise;
        }
        return { authorized: true, authorityEpoch: "revoked-visible-cleanup:1" };
      }),
    });
    const first = await LoopbackClient.connect(server.url);
    let second: LoopbackClient | undefined;
    try {
      await first.login(humans[0]);
      await first.subscribe(roomId, "subscribe-revoked-visible-old");
      await server.publishAgentPreview({ roomId, executionId: "revoked-visible",
        attemptSeq: 1, streamSeq: 1, delta: "VISIBLE-ONLY-ON-OLD-CONNECTION" });
      await first.waitForFrame((frame) => hasType(frame, "agent.execution.preview") &&
        frame.executionId === "revoked-visible", "old visible preview");
      registry.candidates({ targetKind: "room", targetId: roomId })[0]!.revoke();
      await first.waitForClose();

      second = await LoopbackClient.connect(server.url);
      await second.login(humans[0], "login-revoked-visible-new");
      await second.subscribe(roomId, "subscribe-revoked-visible-new");
      blockNext = true;
      const deliveries = [server.publishAgentPreview({ roomId, executionId: "cleanup-head",
        attemptSeq: 1, streamSeq: 1, delta: "x" })];
      await blockedStarted.promise;
      for (let index = 1; index < 32; index += 1) {
        deliveries.push(server.publishAgentPreview({ roomId, executionId: `cleanup-${index}`,
          attemptSeq: 1, streamSeq: 1, delta: "x" }));
      }
      await server.publishAgentPreview({ roomId, executionId: "revoked-visible",
        attemptSeq: 1, streamSeq: 2, delta: "DROPPED-WITHOUT-STALE-RESET" });
      blocked.resolve();
      await Promise.all(deliveries);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(second.frameCount((frame) => hasType(frame, "agent.execution.preview.reset") &&
        frame.executionId === "revoked-visible")).toBe(0);
    } finally {
      blocked.resolve(); await first.close(); await second?.close(); await server.close();
    }
  });

  it("retains visible preview state across an in-place replacement subscription", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-replacement-visible");
    const blocked = deferred<void>();
    const blockedStarted = deferred<void>();
    let blockNext = false;
    const auth: AuthenticationService = {
      async login() { return session; }, async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; }, async revoke() {},
    };
    const server = await startMessageWebSocketServer({
      auth, service: idleMessageService(), outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(async () => {
        if (blockNext) {
          blockNext = false;
          blockedStarted.resolve();
          await blocked.promise;
        }
        return { authorized: true, authorityEpoch: "replacement-visible:1" };
      }),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      await client.subscribe(roomId, "subscribe-replacement-visible-old");
      await server.publishAgentPreview({ roomId, executionId: "replacement-visible",
        attemptSeq: 1, streamSeq: 1, delta: "VISIBLE-BEFORE-RESUBSCRIBE" });
      await client.waitForFrame((frame) => hasType(frame, "agent.execution.preview") &&
        frame.executionId === "replacement-visible", "visible before replacement");
      await client.subscribe(roomId, "subscribe-replacement-visible-new");

      blockNext = true;
      const deliveries = [server.publishAgentPreview({ roomId, executionId: "replacement-head",
        attemptSeq: 1, streamSeq: 1, delta: "x" })];
      await blockedStarted.promise;
      for (let index = 1; index < 32; index += 1) {
        deliveries.push(server.publishAgentPreview({ roomId, executionId: `replacement-${index}`,
          attemptSeq: 1, streamSeq: 1, delta: "x" }));
      }
      await server.publishAgentPreview({ roomId, executionId: "replacement-visible",
        attemptSeq: 1, streamSeq: 2, delta: "DROPPED-REQUIRES-RESET" });
      blocked.resolve();
      await Promise.all(deliveries);
      await expect(client.waitForFrame((frame) => hasType(frame, "agent.execution.preview.reset") &&
        frame.executionId === "replacement-visible", "replacement repair reset"))
        .resolves.toMatchObject({ frame: { reason: "repair" } });
    } finally {
      blocked.resolve(); await client.close(); await server.close();
    }
  });

  it("fences an authorized preview result to the captured subscription generation", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-generation");
    const authorization = deferred<Readonly<{ authorized: boolean; authorityEpoch: string }>>();
    const authorizationStarted = deferred<void>();
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; },
      async revoke() {},
    };
    const server = await startMessageWebSocketServer({
      auth,
      service: idleMessageService(),
      outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(async () => {
          authorizationStarted.resolve();
          return authorization.promise;
      }),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      await client.subscribe(roomId, "subscribe-preview-old");
      const delivery = server.publishAgentPreview({
        roomId, executionId: "execution-preview-generation", attemptSeq: 1,
        streamSeq: 1, delta: "OLD-SUBSCRIPTION",
      });
      await authorizationStarted.promise;
      await client.subscribe(roomId, "subscribe-preview-new");
      authorization.resolve({ authorized: true, authorityEpoch: "access:1" });
      await delivery;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(client.frameCount((frame) => hasType(frame, "agent.execution.preview"))).toBe(0);
    } finally {
      authorization.resolve({ authorized: false, authorityEpoch: "closed" });
      await client.close();
      await server.close();
    }
  });

  it("does not let a stale false authority result poison a replacement subscription", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "preview-false-generation");
    const blocked = deferred<void>();
    const blockedStarted = deferred<void>();
    let calls = 0;
    const auth: AuthenticationService = {
      async login() { return session; }, async authenticate() { return principal; },
      async authenticateSession() {
        return { sessionId: session.accessToken, sessionFamilyId: "family-preview", principal };
      },
      async refresh() { return session; }, async revoke() {},
    };
    const server = await startMessageWebSocketServer({
      auth, service: idleMessageService(), outboxStore: idleOutboxStore(),
      previewAuthority: previewDeliveryAuthority(async () => {
        calls += 1;
        if (calls === 2) {
          blockedStarted.resolve();
          await blocked.promise;
          return { authorized: false, authorityEpoch: "false-generation:2" };
        }
        return { authorized: true, authorityEpoch: `false-generation:${calls}` };
      }),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      await client.subscribe(roomId, "subscribe-false-generation-old");
      await server.publishAgentPreview({
        roomId, executionId: "false-generation-initial", attemptSeq: 1,
        streamSeq: 1, delta: "INITIAL",
      });
      await client.waitForFrame((frame) => hasType(frame, "agent.execution.preview") &&
        frame.executionId === "false-generation-initial", "initial generation preview");
      const stale = server.publishAgentPreview({
        roomId, executionId: "false-generation-stale", attemptSeq: 1,
        streamSeq: 1, delta: "STALE",
      });
      await blockedStarted.promise;
      await client.subscribe(roomId, "subscribe-false-generation-new");
      blocked.resolve();
      await stale;
      await server.publishAgentPreview({
        roomId, executionId: "false-generation-current", attemptSeq: 1,
        streamSeq: 1, delta: "CURRENT",
      });
      await expect(client.waitForFrame((frame) => hasType(frame, "agent.execution.preview") &&
        frame.executionId === "false-generation-current", "replacement generation preview"))
        .resolves.toMatchObject({ frame: { delta: "CURRENT" } });
    } finally {
      blocked.resolve(); await client.close(); await server.close();
    }
  });
  it.each([false, true])(
    "revokes an unacknowledged login after post-commit validation fails (cleanup fails: %s)",
    async (cleanupFails) => {
      const principal = { accountId: "account-human-1", actorId: humans[0].id };
      const session = issuedSession(principal, `login-compensation-${cleanupFails}`);
      const revokeCalls: string[] = [];
      const auth: AuthenticationService = {
        async login() { return session; },
        async authenticate() { return principal; },
        async authenticateSession() {
          throw new AuthorityWorkerClientError(
            "storage_unavailable",
            "authenticate-session-secret",
          );
        },
        async refresh() { return session; },
        async revoke(accessToken) {
          revokeCalls.push(accessToken);
          if (cleanupFails) throw new Error("cleanup-secret");
        },
        async listSessions() { return []; },
        async revokeSession() {},
      };
      const server = await startMessageWebSocketServer({
        auth,
        service: idleMessageService(),
        outboxStore: idleOutboxStore(),
      });
      const client = await LoopbackClient.connect(server.url);

      try {
        client.send({
          type: "auth.login",
          requestId: `login-compensation-${cleanupFails}`,
          accountId: principal.accountId,
          secret: "credential-secret",
          device: testLoginDevice,
        });
        const received = await client.waitForError(
          "storage_unavailable",
          `login-compensation-${cleanupFails}`,
        );
        expect(received.frame).toMatchObject({ status: 503 });
        expect(JSON.stringify(received.frame)).not.toContain("authenticate-session-secret");
        expect(JSON.stringify(received.frame)).not.toContain("cleanup-secret");
        expect(revokeCalls).toEqual([session.accessToken]);
        expect(client.frameCount((frame) => hasType(frame, "auth.authenticated"))).toBe(0);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it("keeps successful login unrevoked and compensates a failed post-rotation validation", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const loginSession = issuedSession(principal, "refresh-compensation-login");
    const rotatedSession = issuedSession(principal, "refresh-compensation-rotated");
    const revokeCalls: string[] = [];
    let authenticateSessionCalls = 0;
    const context = {
      sessionId: "refresh-compensation-generation",
      sessionFamilyId: "refresh-compensation-family",
      principal,
    };
    const auth: AuthenticationService = {
      async login() { return loginSession; },
      async authenticate() { return principal; },
      async authenticateSession() {
        authenticateSessionCalls += 1;
        if (authenticateSessionCalls === 1) return context;
        throw new AuthorityWorkerClientError(
          "storage_unavailable",
          "rotation-validation-secret",
        );
      },
      async refresh() { return rotatedSession; },
      async revoke(accessToken) { revokeCalls.push(accessToken); },
      async listSessions() { return []; },
      async revokeSession() {},
    };
    const server = await startMessageWebSocketServer({
      auth,
      service: idleMessageService(),
      outboxStore: idleOutboxStore(),
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0], "refresh-compensation-login");
      expect(revokeCalls).toEqual([]);
      client.send({
        type: "auth.refresh",
        requestId: "refresh-compensation-failure",
        refreshToken: loginSession.refreshToken,
      });
      const received = await client.waitForError(
        "storage_unavailable",
        "refresh-compensation-failure",
      );
      expect(received.frame).toMatchObject({ status: 503 });
      expect(JSON.stringify(received.frame)).not.toContain("rotation-validation-secret");
      expect(revokeCalls).toEqual([rotatedSession.accessToken]);
      expect(client.frameCount(
        (frame) => hasType(frame, "auth.authenticated") &&
          frame.requestId === "refresh-compensation-failure",
      )).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps an established session installed across a transient authority authentication check", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "transient-authentication-check");
    const sessionContext = {
      sessionId: "transient-authentication-session",
      sessionFamilyId: "transient-authentication-family",
      principal,
    };
    let authenticateSessionCalls = 0;
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() {
        authenticateSessionCalls += 1;
        if (authenticateSessionCalls === 2) {
          throw new AuthorityWorkerClientError(
            "storage_unavailable",
            "transient-authentication-secret",
          );
        }
        return sessionContext;
      },
      async refresh() { return session; },
      async revoke() {},
      async listSessions() { return []; },
      async revokeSession() {},
    };
    const server = await startMessageWebSocketServer({
      auth,
      service: idleMessageService(),
      outboxStore: idleOutboxStore(),
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0], "transient-authentication-login");
      client.send({ type: "auth.sessions.list", requestId: "transient-authentication-failure" });
      const failed = await client.waitForError(
        "storage_unavailable",
        "transient-authentication-failure",
      );
      expect(failed.frame).toMatchObject({ status: 503 });
      expect(JSON.stringify(failed.frame)).not.toContain("transient-authentication-secret");
      await expect(client.listSessions("transient-authentication-retry")).resolves.toMatchObject({
        frame: { type: "auth.sessions", sessions: [] },
      });
      expect(authenticateSessionCalls).toBe(3);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("revokes a login committed after its socket closes while issuance is pending", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "closed-login-compensation");
    const pending = deferred<IssuedSession>();
    const entered = deferred<void>();
    const revokeCalls: string[] = [];
    const auth: AuthenticationService = {
      async login() { entered.resolve(); return pending.promise; },
      async authenticate() { return principal; },
      async refresh() { return session; },
      async revoke(accessToken) { revokeCalls.push(accessToken); },
      async listSessions() { return []; },
      async revokeSession() {},
    };
    const server = await startMessageWebSocketServer({
      auth,
      service: idleMessageService(),
    });
    const client = await LoopbackClient.connect(server.url);

    client.send({
      type: "auth.login",
      requestId: "closed-login-compensation",
      accountId: principal.accountId,
      secret: "secret",
      device: testLoginDevice,
    });
    await entered.promise;
    await client.close();
    pending.resolve(session);
    await vi.waitFor(() => expect(revokeCalls).toEqual([session.accessToken]));
    await server.close();
  });

  it("revokes a rotation committed after its authenticated socket closes", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const loginSession = issuedSession(principal, "closed-refresh-login");
    const rotatedSession = issuedSession(principal, "closed-refresh-rotation");
    const pending = deferred<IssuedSession>();
    const entered = deferred<void>();
    const revokeCalls: string[] = [];
    const auth: AuthenticationService = {
      async login() { return loginSession; },
      async authenticate() { return principal; },
      async refresh() { entered.resolve(); return pending.promise; },
      async revoke(accessToken) { revokeCalls.push(accessToken); },
      async listSessions() { return []; },
      async revokeSession() {},
    };
    const server = await startMessageWebSocketServer({
      auth,
      service: idleMessageService(),
    });
    const client = await LoopbackClient.connect(server.url);

    await client.login(humans[0], "closed-refresh-login");
    expect(revokeCalls).toEqual([]);
    client.send({
      type: "auth.refresh",
      requestId: "closed-refresh-compensation",
      refreshToken: loginSession.refreshToken,
    });
    await entered.promise;
    await client.close();
    pending.resolve(rotatedSession);
    await vi.waitFor(() => expect(revokeCalls).toEqual([rotatedSession.accessToken]));
    await server.close();
  });

  it("lists same-account devices and revokes every live target-family connection without touching the caller", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const sessionA = issuedSession(principal, "device-a");
    const sessionB = issuedSession(principal, "device-b");
    const contextA = {
      sessionId: "authority-generation-a",
      sessionFamilyId: "authority-family-a",
      principal,
    };
    const contextB = {
      sessionId: "authority-generation-b",
      sessionFamilyId: "authority-family-b",
      principal,
    };
    const contextByAccessToken = new Map([
      [sessionA.accessToken, contextA],
      [sessionB.accessToken, contextB],
    ]);
    const publicIdByFamily = new Map([
      [contextA.sessionFamilyId, sessionA.sessionId],
      [contextB.sessionFamilyId, sessionB.sessionId],
    ]);
    const activeFamilies = new Set([
      contextA.sessionFamilyId,
      contextB.sessionFamilyId,
    ]);
    const publicSessions = [
      {
        id: sessionB.sessionId,
        deviceLabel: "iMac",
        platform: "macos" as const,
        createdAt: "2026-08-12T00:01:00.000Z",
        refreshExpiresAt: sessionB.refreshExpiresAt,
      },
      {
        id: sessionA.sessionId,
        deviceLabel: "MacBook",
        platform: "macos" as const,
        createdAt: "2026-08-12T00:00:00.000Z",
        refreshExpiresAt: sessionA.refreshExpiresAt,
      },
    ];
    const revokeCalls: string[] = [];
    const revocationEvent: PersistedIdentityEvent & {
      readonly type: "identity.session.revoked";
    } = {
      eventId: "targeted-revoke-event",
      streamKind: "identity",
      streamId: principal.actorId,
      streamSeq: 1,
      actorId: principal.actorId,
      occurredAt: "2026-08-12T00:02:00.000Z",
      type: "identity.session.revoked",
      payload: {
        sessionId: contextB.sessionId,
        familyId: contextB.sessionFamilyId,
        accountId: principal.accountId,
      },
    };
    const revocationDelivery: OutboxDelivery = {
      deliveryId: "targeted-revoke-delivery",
      eventId: revocationEvent.eventId,
      targetKind: "session-family",
      targetId: contextB.sessionFamilyId,
      streamSeq: revocationEvent.streamSeq,
      attempts: 0,
      event: revocationEvent,
    };
    let queuedRevocation: OutboxDelivery | undefined;
    let dispatchReleased = false;
    const dispatched: string[] = [];

    function authenticateContext(accessToken: string) {
      const context = contextByAccessToken.get(accessToken);
      if (context === undefined) {
        throw new AuthenticationError(401, "invalid_token");
      }
      if (!activeFamilies.has(context.sessionFamilyId)) {
        throw new AuthenticationError(403, "session_revoked");
      }
      return context;
    }

    const auth: AuthenticationService = {
      async login(_credentials, device) {
        if (device?.id === "installation-a") return sessionA;
        if (device?.id === "installation-b") return sessionB;
        throw new AuthenticationError(401, "invalid_credentials");
      },
      async authenticate(accessToken) {
        return authenticateContext(accessToken).principal;
      },
      async authenticateSession(accessToken) {
        return authenticateContext(accessToken);
      },
      async refresh() {
        return sessionA;
      },
      async revoke() {},
      async listSessions(accessToken) {
        const current = authenticateContext(accessToken);
        const currentPublicId = publicIdByFamily.get(current.sessionFamilyId);
        return publicSessions
          .filter((session) => [...publicIdByFamily.entries()].some(
            ([familyId, publicId]) =>
              publicId === session.id && activeFamilies.has(familyId),
          ))
          .map((session) => ({
            ...session,
            current: session.id === currentPublicId,
          }));
      },
      async revokeSession(accessToken, sessionId) {
        authenticateContext(accessToken);
        const targetFamily = [...publicIdByFamily.entries()].find(
          ([, publicId]) => publicId === sessionId,
        )?.[0];
        if (targetFamily === undefined) {
          throw new AuthenticationError(404, "session_not_found");
        }
        revokeCalls.push(sessionId);
        if (!activeFamilies.delete(targetFamily)) return;
        if (targetFamily === contextB.sessionFamilyId) {
          queuedRevocation = revocationDelivery;
        }
      },
    };
    const history = vi.fn(async () => [] as readonly Message[]);
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() { return () => undefined; },
      history,
    };
    const outboxStore: OutboxDispatchStore = {
      async listPendingOutbox() {
        return dispatchReleased && queuedRevocation !== undefined
          ? [queuedRevocation]
          : [];
      },
      async authorizeOutboxCandidate(delivery, candidate) {
        return delivery.targetKind === "session-family" &&
          delivery.targetId === candidate.sessionFamilyId;
      },
      async markOutboxDispatched(deliveryId) {
        dispatched.push(deliveryId);
        queuedRevocation = undefined;
      },
      async markOutboxFailed() {
        throw new Error("targeted terminal delivery must not fail");
      },
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      outboxStore,
      outboxPollIntervalMs: 10,
    });
    const deviceA = await LoopbackClient.connect(server.url);
    const deviceB = await LoopbackClient.connect(server.url);
    const deviceBPeer = await LoopbackClient.connect(server.url);

    try {
      const loginA = await deviceA.login(humans[0], "login-device-a", {
        id: "installation-a",
        label: "MacBook",
        platform: "macos",
      });
      const loginB = await deviceB.login(humans[0], "login-device-b", {
        id: "installation-b",
        label: "iMac",
        platform: "macos",
      });
      expect(loginA).toMatchObject({ sessionId: sessionA.sessionId });
      expect(loginB).toMatchObject({ sessionId: sessionB.sessionId });
      await expect(deviceBPeer.resume(sessionB.accessToken, "resume-device-b-peer"))
        .resolves.toMatchObject({ frame: { sessionId: sessionB.sessionId } });

      const initialList = await deviceA.listSessions("list-before-revoke");
      expect(initialList.frame).toEqual({
        type: "auth.sessions",
        requestId: "list-before-revoke",
        sessions: [
          { ...publicSessions[0], current: false },
          { ...publicSessions[1], current: true },
        ],
      });
      expect(JSON.stringify(initialList.frame)).not.toContain("device-a-access");
      expect(JSON.stringify(initialList.frame)).not.toContain("device-b-refresh");
      expect(JSON.stringify(initialList.frame)).not.toContain("authority-family");

      deviceA.send({
        type: "auth.session.revoke",
        requestId: "foreign-revoke",
        sessionId: "foreign-or-random-session",
      });
      await expect(deviceA.waitForError("session_not_found", "foreign-revoke"))
        .resolves.toMatchObject({ frame: { status: 404 } });
      expect(activeFamilies).toEqual(new Set([
        contextA.sessionFamilyId,
        contextB.sessionFamilyId,
      ]));

      await expect(deviceA.revokeSession(sessionB.sessionId, "revoke-device-b"))
        .resolves.toMatchObject({
          frame: {
            type: "auth.session.revoke.ack",
            requestId: "revoke-device-b",
            sessionId: sessionB.sessionId,
            revoked: true,
          },
        });
      expect(revokeCalls).toEqual([sessionB.sessionId]);

      deviceB.send({ type: "room.history", requestId: "device-b-after-revoke", roomId });
      deviceBPeer.send({
        type: "room.history",
        requestId: "device-b-peer-after-revoke",
        roomId,
      });
      await expect(deviceB.waitForError("session_revoked", "device-b-after-revoke"))
        .resolves.toMatchObject({ frame: { status: 403 } });
      await expect(deviceBPeer.waitForError(
        "session_revoked",
        "device-b-peer-after-revoke",
      )).resolves.toMatchObject({ frame: { status: 403 } });

      dispatchReleased = true;
      await Promise.all([
        deviceB.waitForFrame(
          (frame) => hasType(frame, "auth.session-revoked") &&
            frame.eventId === revocationEvent.eventId,
          "device B terminal revoke",
        ),
        deviceBPeer.waitForFrame(
          (frame) => hasType(frame, "auth.session-revoked") &&
            frame.eventId === revocationEvent.eventId,
          "device B peer terminal revoke",
        ),
      ]);
      await Promise.all([deviceB.waitForClose(), deviceBPeer.waitForClose()]);
      expect(deviceB.frameCount((frame) => hasType(frame, "auth.session-revoked"))).toBe(1);
      expect(deviceBPeer.frameCount((frame) => hasType(frame, "auth.session-revoked"))).toBe(1);
      await vi.waitFor(() => expect(dispatched).toEqual([revocationDelivery.deliveryId]));

      const converged = await deviceA.listSessions("list-after-revoke");
      expect(converged.frame).toEqual({
        type: "auth.sessions",
        requestId: "list-after-revoke",
        sessions: [{ ...publicSessions[1], current: true }],
      });
      await expect(deviceA.history(roomId, "caller-remains-authenticated"))
        .resolves.toMatchObject({
          frame: { type: "room.history", requestId: "caller-remains-authenticated" },
        });
      expect(history).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([
        deviceA.close(),
        deviceB.close(),
        deviceBPeer.close(),
      ]);
      await server.close();
    }
  });

  it("routes closed T-0017/T-0018 human collaboration frames and preserves API errors", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "open-item-api");
    const sessionContext = {
      sessionId: "session-open-item-api", sessionFamilyId: "family-open-item-api", principal,
    };
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return { type: "message.accepted", requestId: message.id, messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z" };
      },
      subscribe() { return () => undefined; },
      async history() { return []; },
    };
    const awaitingItem = {
      id: "item-api", roomId, sourceMessageId: "message-source", requesterId: humans[0].id,
      currentOwnerId: humans[1].id, content: "请确认", status: "awaiting" as const,
      origin: { kind: "human_mention" as const }, createdAt: "2026-08-12T00:00:00.000Z",
      transferChain: [],
    };
    const createOpenItem = vi.fn(async () => awaitingItem);
    const transitionOpenItem = vi.fn(async (_context, _room: string, payload: { readonly itemId: string }) => {
      if (payload.itemId === "forbidden") {
        throw Object.assign(new Error("closed"), { status: 403, code: "permission_denied" });
      }
      if (payload.itemId === "terminal") {
        throw Object.assign(new Error("closed"), { status: 409, code: "execution_conflict" });
      }
      return { ...awaitingItem, currentOwnerId: null, status: "answered" as const,
        respondedAt: "2026-08-12T00:01:00.000Z" };
    });
    const todoTask = {
      id: "task-api", roomId, sourceMessageId: "message-source", title: "完成评审",
      claimant: null, claimantRoleAtClaim: null, verifierRole: "owner" as const,
      verifierActorId: null, criteria: [{ id: "criterion-1", text: "评审通过", met: false }],
      status: "todo" as const, createdAt: "2026-08-12T00:00:00.000Z",
    };
    const createLightTask = vi.fn(async () => todoTask);
    const transitionLightTask = vi.fn(async () => ({
      ...todoTask, claimant: humans[1].id, claimantRoleAtClaim: "member" as const,
      status: "claimed" as const, claimedAt: "2026-08-12T00:01:00.000Z",
    }));
    const setLightTaskCriterion = vi.fn(async () => todoTask);
    const queryBalls = vi.fn(async () => ({
      balls: [{
        holderId: humans[0].id, roomId, sourceKind: "light-task" as const,
        sourceId: "task-api", reason: "claimed light task awaits delivery",
        since: "2026-08-12T00:01:00.000Z", deadline: "2026-08-13T00:01:00.000Z",
      }],
      needsAction: [],
      reminders: [],
    }));
    const server = await startMessageWebSocketServer({
      auth, service, collaboration: {
        createOpenItem, transitionOpenItem, createLightTask, transitionLightTask,
        setLightTaskCriterion,
      },
      ballRuntime: { query: queryBalls },
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      client.send({
        type: "open-item.create", requestId: "open-create", roomId,
        creationKind: "human_mention", sourceMessageId: "message-source",
        targetActorId: humans[1].id, content: "请确认",
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "open-item.ack") && frame.requestId === "open-create",
        "open item acknowledgement",
      )).resolves.toMatchObject({ frame: { item: { id: "item-api", status: "awaiting" } } });
      expect(createOpenItem).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "human", principal, requestId: "open-create" }),
        roomId,
        { creationKind: "human_mention", sourceMessageId: "message-source",
          targetActorId: humans[1].id, content: "请确认" },
      );

      client.send({ type: "open-item.transition", requestId: "open-forbidden", roomId,
        itemId: "forbidden", action: "answer" });
      await expect(client.waitForError("permission_denied", "open-forbidden"))
        .resolves.toMatchObject({ frame: { status: 403 } });
      client.send({ type: "open-item.transition", requestId: "open-terminal", roomId,
        itemId: "terminal", action: "answer" });
      await expect(client.waitForError("execution_conflict", "open-terminal"))
        .resolves.toMatchObject({ frame: { status: 409 } });
      expect(transitionOpenItem.mock.calls.map(([context]) => context.idempotencyKey))
        .toEqual([
          "open-item.transition:open-forbidden",
          "open-item.transition:open-terminal",
        ]);

      client.send({
        type: "light-task.create", requestId: "task-create", roomId,
        sourceMessageId: "message-source", title: "完成评审", verifierRole: "owner",
        criteria: [{ id: "criterion-1", text: "评审通过" }],
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "light-task.ack") && frame.requestId === "task-create",
        "light task acknowledgement",
      )).resolves.toMatchObject({ frame: { task: { id: "task-api", status: "todo" } } });
      expect(createLightTask).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "light-task.create:task-create" }),
        roomId,
        { sourceMessageId: "message-source", title: "完成评审", verifierRole: "owner",
          criteria: [{ id: "criterion-1", text: "评审通过" }] },
      );
      client.send({
        type: "light-task.transition", requestId: "task-claim", roomId,
        taskId: "task-api", action: "claim",
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "light-task.ack") && frame.requestId === "task-claim",
        "light task claim acknowledgement",
      )).resolves.toMatchObject({ frame: { task: { status: "claimed" } } });
      client.send({
        type: "light-task.criterion.set", requestId: "task-check", roomId,
        taskId: "task-api", criterionId: "criterion-1", met: true,
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "light-task.ack") && frame.requestId === "task-check",
        "light task criterion acknowledgement",
      )).resolves.toMatchObject({ frame: { task: { id: "task-api" } } });
      client.send({ type: "ball.query", requestId: "ball-query", roomId });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "ball.query.result") && frame.requestId === "ball-query",
        "ball query result",
      )).resolves.toMatchObject({
        frame: { roomId, balls: [{ sourceKind: "light-task", sourceId: "task-api" }] },
      });
      expect(queryBalls).toHaveBeenCalledWith(sessionContext, roomId);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("bounds stalled loopback connect, close, and close-wait listeners", async () => {
    const stalledConnect = await createStalledWebSocketPeer(false);
    try {
      const outcome = await Promise.race([
        LoopbackClient.connect(stalledConnect.url, 20)
          .then(() => "connected", (error: unknown) => String(error)),
        new Promise<string>((resolve) => setTimeout(() => resolve("outer-timeout"), 100)),
      ]);
      expect(outcome).toContain("within 20ms");
    } finally {
      await stalledConnect.close();
    }

    const stalledClose = await createStalledWebSocketPeer(true);
    const client = await LoopbackClient.connect(stalledClose.url);
    try {
      const listenersBefore = client.closeListenerCountForTest();
      await expect(client.waitForClose(20)).rejects.toThrow("Timed out");
      expect(client.closeListenerCountForTest()).toBe(listenersBefore);
      const outcome = await Promise.race([
        client.close(20).then(() => "closed", (error: unknown) => String(error)),
        new Promise<string>((resolve) => setTimeout(() => resolve("outer-timeout"), 100)),
      ]);
      expect(outcome).toContain("within 20ms");
    } finally {
      await stalledClose.close();
    }
  });
  it("closes listeners and sockets even when an active outbox flush rejects", async () => {
    const principal = { accountId: "account-close", actorId: humans[0].id };
    const session = issuedSession(principal, "close-cleanup");
    const activeFlush = deferred<readonly OutboxDelivery[]>();
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() {
        return {
          sessionId: session.accessToken,
          sessionFamilyId: "family-close",
          principal,
        };
      },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() { return () => undefined; },
      async history() { return []; },
    };
    const outboxStore: OutboxDispatchStore = {
      listPendingOutbox: () => activeFlush.promise,
      async authorizeOutboxCandidate() { return true; },
      async markOutboxDispatched() {},
      async markOutboxFailed() {},
    };
    const server = await startMessageWebSocketServer({ auth, service, outboxStore });
    const client = await LoopbackClient.connect(server.url);
    let unexpectedClient: LoopbackClient | undefined;

    try {
      const firstClose = server.close();
      const secondClose = server.close();
      const firstResultPromise = firstClose.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(secondClose).toBe(firstClose);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        unexpectedClient = await LoopbackClient.connect(server.url);
      } catch {
        // Listener rejection is the expected state while the failed flush is settling.
      }
      expect(unexpectedClient).toBeUndefined();
      await client.waitForClose();
      activeFlush.reject(new Error("active outbox close failed"));
      const firstResult = await firstResultPromise;
      expect(firstResult).toBeInstanceOf(AggregateError);
      await expect(secondClose).rejects.toBe(firstResult);
    } finally {
      activeFlush.reject(new Error("active outbox close failed"));
      await unexpectedClient?.close();
      await server.close().catch(() => undefined);
    }
  });

  it("routes closed recovery frames through SyncService with current request IDs", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-recovery");
    const sessionContext = {
      sessionId: "session-v2-recovery",
      sessionFamilyId: "family-v2-recovery",
      principal,
    };
    const auth: AuthenticationService = {
      async login() {
        return session;
      },
      async authenticate() {
        return principal;
      },
      async authenticateSession() {
        return sessionContext;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() {
        return () => undefined;
      },
      async history() {
        return [];
      },
    };
    const calls: string[] = [];
    const sync: SyncService = {
      async syncRoom(context, request) {
        expect(context).toEqual(sessionContext);
        expect(request).toMatchObject({ type: "room.sync", roomId });
        calls.push("sync");
        return {
          type: "room.sync.result",
          requestId: (request as { readonly requestId: string }).requestId,
          mode: "delta",
          events: [],
          nextCursor: { version: 1, roomId, afterSeq: 4 },
          watermark: 4,
          hasMore: false,
        };
      },
      async beginRoomRepair(context, requestId, targetRoomId) {
        expect(context).toEqual(sessionContext);
        expect(targetRoomId).toBe(roomId);
        calls.push("repair-begin");
        return {
          type: "room.repair.page",
          requestId,
          snapshotId: "room-snapshot",
          roomId,
          page: 0,
          records: [],
          watermark: 4,
          snapshotChecksum: "room-checksum",
          hasMore: true,
          mode: "materialized",
          expiresAt: "2026-08-12T00:05:00.000Z",
        };
      },
      async readRoomRepairPage(context, requestId, snapshotId, afterPage) {
        expect(context).toEqual(sessionContext);
        expect([snapshotId, afterPage]).toEqual(["room-snapshot", 0]);
        calls.push("repair-page");
        return {
          type: "room.repair.page",
          requestId,
          snapshotId,
          roomId,
          page: 1,
          records: [],
          watermark: 4,
          snapshotChecksum: "room-checksum",
          hasMore: false,
          mode: "materialized",
          expiresAt: "2026-08-12T00:05:00.000Z",
        };
      },
      async beginWorkspaceBootstrap(context, requestId) {
        expect(context).toEqual(sessionContext);
        calls.push("bootstrap-begin");
        return {
          type: "workspace.bootstrap.page",
          requestId,
          snapshotId: "catalog-snapshot",
          page: 0,
          rooms: [],
          catalogRevision: 2,
          snapshotChecksum: "catalog-checksum",
          hasMore: true,
          mode: "materialized",
          expiresAt: "2026-08-12T00:05:00.000Z",
        };
      },
      async readWorkspaceBootstrapPage(context, requestId, snapshotId, afterPage) {
        expect(context).toEqual(sessionContext);
        expect([snapshotId, afterPage]).toEqual(["catalog-snapshot", 0]);
        calls.push("bootstrap-page");
        return {
          type: "workspace.bootstrap.page",
          requestId,
          snapshotId,
          page: 1,
          rooms: [],
          catalogRevision: 2,
          snapshotChecksum: "catalog-checksum",
          hasMore: false,
          mode: "materialized",
          expiresAt: "2026-08-12T00:05:00.000Z",
        };
      },
      async completeSnapshot(context, requestId, snapshotId, version, checksum) {
        expect(context).toEqual(sessionContext);
        expect([snapshotId, version, checksum]).toEqual([
          "catalog-snapshot",
          { kind: "catalog", catalogRevision: 2 },
          "catalog-checksum",
        ]);
        calls.push("complete");
        return { type: "snapshot.completed", requestId, snapshotId, version };
      },
      async releaseSnapshot() {},
    };
    const server = await startMessageWebSocketServer({ auth, service, sync });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      const requests = [
        { type: "workspace.bootstrap.begin", requestId: "bootstrap-begin" },
        {
          type: "workspace.bootstrap.page",
          requestId: "bootstrap-page",
          snapshotId: "catalog-snapshot",
          afterPage: 0,
        },
        {
          type: "room.sync",
          requestId: "sync",
          roomId,
          cursor: { version: 1, roomId, afterSeq: 0 },
        },
        { type: "room.repair.begin", requestId: "repair-begin", roomId },
        {
          type: "room.repair.page",
          requestId: "repair-page",
          snapshotId: "room-snapshot",
          afterPage: 0,
        },
        {
          type: "snapshot.complete",
          requestId: "complete",
          snapshotId: "catalog-snapshot",
          version: { kind: "catalog", catalogRevision: 2 },
          snapshotChecksum: "catalog-checksum",
        },
      ] as const;
      for (const request of requests) {
        client.send(request);
        await expect(client.waitForFrame(
          (frame) => isRecord(frame) && frame.requestId === request.requestId,
          request.type,
        )).resolves.toMatchObject({ frame: { requestId: request.requestId } });
      }
      expect(calls).toEqual([
        "bootstrap-begin",
        "bootstrap-page",
        "sync",
        "repair-begin",
        "repair-page",
        "complete",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects malformed or mis-correlated recovery responses without sending them", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-correlation");
    const sessionContext = {
      sessionId: "session-v2-correlation",
      sessionFamilyId: "family-v2-correlation",
      principal,
    };
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return { type: "message.accepted", requestId: message.id, messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z" };
      },
      subscribe() { return () => undefined; },
      async history() { return []; },
    };
    const sync: SyncService = {
      async syncRoom(_context, request) {
        const valid = request.requestId === "valid-after-invalid";
        return { type: "room.sync.result",
          requestId: valid ? request.requestId : "wrong-sync-request",
          mode: "delta", events: [],
          nextCursor: { version: 1, roomId: valid ? roomId : "wrong-room", afterSeq: 0 },
          watermark: 0, hasMore: false };
      },
      async beginRoomRepair(_context, requestId) {
        return { type: "room.repair.page", requestId, snapshotId: "repair-correlation",
          roomId: "wrong-room", page: 1, records: [], watermark: 0,
          snapshotChecksum: "repair-correlation-checksum", hasMore: false,
          mode: "materialized", expiresAt: "2026-08-12T00:05:00.000Z" };
      },
      async readRoomRepairPage(_context, requestId) {
        return { type: "room.repair.page", requestId, snapshotId: "wrong-repair-snapshot",
          roomId, page: 7, records: [], watermark: 0,
          snapshotChecksum: "repair-correlation-checksum", hasMore: false,
          mode: "materialized", expiresAt: "2026-08-12T00:05:00.000Z" };
      },
      async beginWorkspaceBootstrap(_context, requestId) {
        return { type: "workspace.bootstrap.page", requestId: `${requestId}-wrong`,
          snapshotId: "catalog-correlation", page: 0, rooms: [], catalogRevision: 1,
          snapshotChecksum: "catalog-correlation-checksum", hasMore: false,
          mode: "materialized", expiresAt: "2026-08-12T00:05:00.000Z" };
      },
      async readWorkspaceBootstrapPage(_context, requestId) {
        return { type: "workspace.bootstrap.page", requestId,
          snapshotId: "wrong-catalog-snapshot", page: 9, rooms: [], catalogRevision: 1,
          snapshotChecksum: "catalog-correlation-checksum", hasMore: false,
          mode: "materialized", expiresAt: "2026-08-12T00:05:00.000Z" };
      },
      async completeSnapshot(_context, requestId, snapshotId) {
        return { type: "snapshot.completed", requestId, snapshotId,
          version: { kind: "catalog", catalogRevision: 999 } };
      },
      async releaseSnapshot() {},
    };
    const server = await startMessageWebSocketServer({ auth, service, sync });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      const invalidRequests = [
        { type: "workspace.bootstrap.begin", requestId: "invalid-bootstrap-begin" },
        { type: "workspace.bootstrap.page", requestId: "invalid-bootstrap-page",
          snapshotId: "catalog-correlation", afterPage: 0 },
        { type: "room.sync", requestId: "invalid-room-sync", roomId,
          cursor: { version: 1, roomId, afterSeq: 0 } },
        { type: "room.repair.begin", requestId: "invalid-repair-begin", roomId },
        { type: "room.repair.page", requestId: "invalid-repair-page",
          snapshotId: "repair-correlation", afterPage: 0 },
        { type: "snapshot.complete", requestId: "invalid-complete",
          snapshotId: "catalog-correlation",
          version: { kind: "catalog", catalogRevision: 1 },
          snapshotChecksum: "catalog-correlation-checksum" },
      ] as const;
      for (const request of invalidRequests) {
        client.send(request);
        await expect(client.waitForError("storage_unavailable", request.requestId))
          .resolves.toMatchObject({ frame: { status: 503 } });
        expect(client.frameCount((frame) => isRecord(frame) &&
          frame.requestId === request.requestId && frame.type !== "error")).toBe(0);
      }
      client.send({ type: "room.sync", requestId: "valid-after-invalid", roomId,
        cursor: { version: 1, roomId, afterSeq: 0 } });
      await client.waitForFrame(
        (frame) => hasType(frame, "room.sync.result") &&
          frame.requestId === "valid-after-invalid",
        "valid recovery after invalid responses",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(["catalog", "room"] as const)(
    "compares %s SnapshotVersion by meaning instead of object field order",
    async (kind) => {
      const principal = { accountId: "account-human-1", actorId: humans[0].id };
      const session = issuedSession(principal, `snapshot-version-${kind}`);
      const sessionContext = { sessionId: `session-snapshot-version-${kind}`,
        sessionFamilyId: `family-snapshot-version-${kind}`, principal };
      const auth: AuthenticationService = {
        async login() { return session; }, async authenticate() { return principal; },
        async authenticateSession() { return sessionContext; },
        async refresh() { return session; }, async revoke() {},
      };
      const service: MessageService = {
        async send(_context, message) {
          return { type: "message.accepted", requestId: message.id, messageId: message.id,
            persistedAt: "2026-08-12T00:00:00.000Z" };
        },
        subscribe() { return () => undefined; }, async history() { return []; },
      };
      const requestVersion = kind === "catalog"
        ? { kind: "catalog" as const, catalogRevision: 4 }
        : { kind: "room" as const, roomId, watermark: 7 };
      const responseVersion = kind === "catalog"
        ? { catalogRevision: 4, kind: "catalog" as const }
        : { watermark: 7, roomId, kind: "room" as const };
      const sync: SyncService = {
        async syncRoom() { throw new Error("unused"); },
        async beginRoomRepair() { throw new Error("unused"); },
        async readRoomRepairPage() { throw new Error("unused"); },
        async beginWorkspaceBootstrap() { throw new Error("unused"); },
        async readWorkspaceBootstrapPage() { throw new Error("unused"); },
        async completeSnapshot(_context, requestId, snapshotId) {
          return { type: "snapshot.completed", requestId, snapshotId,
            version: responseVersion };
        },
        async releaseSnapshot() {},
      };
      const server = await startMessageWebSocketServer({ auth, service, sync });
      const client = await LoopbackClient.connect(server.url);
      try {
        await client.login(humans[0]);
        client.send({ type: "snapshot.complete", requestId: `version-order-${kind}`,
          snapshotId: `snapshot-version-${kind}`, version: requestVersion,
          snapshotChecksum: "snapshot-version-checksum" });
        await client.waitForFrame(
          (frame) => hasType(frame, "snapshot.completed") &&
            frame.requestId === `version-order-${kind}`,
          `${kind} version completion`,
        );
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it.each([
    [new SnapshotWorkerClientError("invalid_token", "secret token"), 401, "invalid_token"],
    [new SnapshotWorkerClientError("token_expired", "secret token"), 401, "token_expired"],
    [new SnapshotWorkerClientError("session_revoked", "secret session"), 403, "session_revoked"],
    [new SnapshotWorkerClientError("snapshot_family_revoked", "secret family"), 403, "snapshot_family_revoked"],
    [new SnapshotWorkerClientError("snapshot_forbidden", "secret principal"), 403, "snapshot_forbidden"],
    [new SnapshotWorkerClientError("snapshot_not_found", "/private/cache.sqlite"), 404, "snapshot_not_found"],
    [new SnapshotWorkerClientError("snapshot_stale", "SELECT secret"), 409, "snapshot_stale"],
    [new SnapshotWorkerClientError("snapshot_expired", "expired secret"), 410, "snapshot_expired"],
    [new SnapshotWorkerClientError("snapshot_busy", "queue internals"), 429, "snapshot_busy"],
    [new SnapshotWorkerClientError("snapshot_worker_closed", "worker details"), 503, "storage_unavailable"],
    [new SnapshotWorkerClientError("snapshot_worker_error", "worker details"), 503, "storage_unavailable"],
    [new SnapshotWorkerClientError("snapshot_worker_protocol_error", "bad envelope"), 503, "storage_unavailable"],
    [new AuthorityWorkerClientError("repair_barrier_active", "authority internals"), 503, "repair_barrier_active"],
    [new AuthorityWorkerClientError("session_limit_reached", "authority capacity"), 409, "session_limit_reached"],
    [new AuthorityWorkerClientError("authority_worker_closed", "worker details"), 503, "storage_unavailable"],
    [new AuthorityWorkerClientError("authority_worker_error", "worker details"), 503, "storage_unavailable"],
    [new AuthorityWorkerClientError("authority_worker_protocol_error", "bad envelope"), 503, "storage_unavailable"],
    [new AuthorityWorkerClientError("storage_unavailable", "SQL secret"), 503, "storage_unavailable"],
  ] as const)(
    "maps a real worker error to stable %s/%s without leaking its message",
    async (workerError, status, code) => {
      const principal = { accountId: "account-human-1", actorId: humans[0].id };
      const session = issuedSession(principal, `worker-error-${code}`);
      const sessionContext = {
        sessionId: `session-worker-error-${code}`,
        sessionFamilyId: `family-worker-error-${code}`,
        principal,
      };
      const auth: AuthenticationService = {
        async login() { return session; },
        async authenticate() { return principal; },
        async authenticateSession() { return sessionContext; },
        async refresh() { return session; },
        async revoke() {},
      };
      const service: MessageService = {
        async send(_context, message) {
          return {
            type: "message.accepted",
            requestId: message.id,
            messageId: message.id,
            persistedAt: "2026-08-12T00:00:00.000Z",
          };
        },
        subscribe() { return () => undefined; },
        async history() { return []; },
      };
      const sync = {
        async syncRoom() { throw workerError; },
        async beginRoomRepair() { throw new Error("unused"); },
        async readRoomRepairPage() { throw new Error("unused"); },
        async beginWorkspaceBootstrap() { throw new Error("unused"); },
        async readWorkspaceBootstrapPage() { throw new Error("unused"); },
        async completeSnapshot() { throw new Error("unused"); },
        async releaseSnapshot() {},
      } satisfies SyncService;
      const server = await startMessageWebSocketServer({ auth, service, sync });
      const client = await LoopbackClient.connect(server.url);

      try {
        await client.login(humans[0]);
        client.send({ type: "room.sync", requestId: `worker-error-${code}`, roomId });
        const received = await client.waitForFrame(
          (frame) => hasType(frame, "error") && frame.requestId === `worker-error-${code}`,
          `worker error ${code}`,
        );
        expect(received.frame).toEqual({
          type: "error",
          status,
          code,
          message: code,
          requestId: `worker-error-${code}`,
        });
        expect(JSON.stringify(received.frame)).not.toContain(workerError.message);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it("does not send a deferred v2 result after its credential generation is revoked", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-generation");
    const sessionContext = {
      sessionId: "session-v2-generation",
      sessionFamilyId: "family-v2-generation",
      principal,
    };
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() { return () => undefined; },
      async history() { return []; },
    };
    const result = deferred<{
      readonly type: "room.sync.result";
      readonly requestId: string;
      readonly mode: "repair_required";
      readonly reason: "cursor_absent";
      readonly retainedFromSeq: number;
      readonly watermark: number;
    }>();
    const syncRoomEntered = deferred<void>();
    const sync = {
      async syncRoom() {
        syncRoomEntered.resolve();
        return result.promise;
      },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap() { throw new Error("unused"); },
      async readWorkspaceBootstrapPage() { throw new Error("unused"); },
      async completeSnapshot() { throw new Error("unused"); },
      async releaseSnapshot() {},
    } satisfies SyncService;
    const server = await startMessageWebSocketServer({ auth, service, sync });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({ type: "room.sync", requestId: "deferred-sync", roomId });
      await syncRoomEntered.promise;
      await client.close();
      result.resolve({
        type: "room.sync.result",
        requestId: "deferred-sync",
        mode: "repair_required",
        reason: "cursor_absent",
        retainedFromSeq: 1,
        watermark: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(client.frameCount(
        (frame) => isRecord(frame) && frame.requestId === "deferred-sync",
      )).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("releases a shared streaming snapshot only after its final connection owner closes", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-release");
    const sessionContext = {
      sessionId: "session-v2-release",
      sessionFamilyId: "family-v2-release",
      principal,
    };
    const releaseSnapshot = vi.fn(async () => undefined);
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() { return () => undefined; },
      async history() { return []; },
    };
    const sync = {
      async syncRoom() { throw new Error("unused"); },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap(_context, requestId) {
        return {
          type: "workspace.bootstrap.page",
          requestId,
          snapshotId: "owned-streaming-snapshot",
          page: 0,
          rooms: [],
          catalogRevision: 1,
          snapshotChecksum: "streaming-checksum",
          hasMore: false,
          mode: "streaming",
          idleExpiresAt: "2026-08-12T00:00:30.000Z",
        } as const;
      },
      async readWorkspaceBootstrapPage(_context, requestId) {
        return {
          type: "workspace.bootstrap.page",
          requestId,
          snapshotId: "owned-streaming-snapshot",
          page: 1,
          rooms: [],
          catalogRevision: 1,
          snapshotChecksum: "streaming-checksum",
          hasMore: false,
          mode: "streaming",
          idleExpiresAt: "2026-08-12T00:00:30.000Z",
        } as const;
      },
      async completeSnapshot() { throw new Error("unused"); },
      releaseSnapshot,
    } satisfies SyncService;
    const server = await startMessageWebSocketServer({ auth, service, sync });
    const owner = await LoopbackClient.connect(server.url);
    const peer = await LoopbackClient.connect(server.url);

    try {
      await owner.login(humans[0]);
      await peer.login(humans[0], "peer-v2-release");
      owner.send({ type: "workspace.bootstrap.begin", requestId: "owned-begin" });
      peer.send({ type: "workspace.bootstrap.begin", requestId: "peer-owned-begin" });
      await Promise.all([owner.waitForFrame(
        (frame) => hasType(frame, "workspace.bootstrap.page") &&
          frame.requestId === "owned-begin",
        "owned streaming page",
      ), peer.waitForFrame(
        (frame) => hasType(frame, "workspace.bootstrap.page") &&
          frame.requestId === "peer-owned-begin",
        "peer owned streaming page",
      )]);
      await owner.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(releaseSnapshot).not.toHaveBeenCalled();
      peer.send({
        type: "workspace.bootstrap.page",
        requestId: "peer-owned-page",
        snapshotId: "owned-streaming-snapshot",
        afterPage: 0,
      });
      await peer.waitForFrame(
        (frame) => hasType(frame, "workspace.bootstrap.page") &&
          frame.requestId === "peer-owned-page",
        "peer streaming continuation",
      );
      await peer.close();
      await vi.waitFor(() => expect(releaseSnapshot).toHaveBeenCalledTimes(1));
      expect(releaseSnapshot).toHaveBeenCalledWith(
        sessionContext,
        "owned-streaming-snapshot",
      );
    } finally {
      await owner.close();
      await peer.close();
      await server.close();
    }
  });

  it("keeps a streaming snapshot lease across access-token expiry and same-family refresh", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const expiredSession = issuedSession(principal, "streaming-expired");
    const refreshedSession = issuedSession(principal, "streaming-refreshed");
    const sessionContext = {
      sessionId: "session-streaming-refresh",
      sessionFamilyId: "family-streaming-refresh",
      principal,
    };
    let expired = false;
    const releaseSnapshot = vi.fn(async () => undefined);
    const auth: AuthenticationService = {
      async login() { return expiredSession; },
      async authenticate() {
        if (expired) throw new AuthenticationError(401, "token_expired");
        return principal;
      },
      async authenticateSession() { return sessionContext; },
      async refresh(refreshToken, expectedPrincipal) {
        expect(refreshToken).toBe(expiredSession.refreshToken);
        expect(expectedPrincipal).toEqual(principal);
        expired = false;
        return refreshedSession;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return { type: "message.accepted", requestId: message.id, messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z" };
      },
      subscribe() { return () => undefined; },
      async history() { return []; },
    };
    const sync = {
      async syncRoom() { throw new Error("unused"); },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage(_context, requestId, snapshotId, afterPage) {
        return { type: "room.repair.page", requestId, snapshotId, roomId,
          page: afterPage + 1, records: [], watermark: 1,
          snapshotChecksum: "refresh-checksum", hasMore: false, mode: "streaming",
          idleExpiresAt: "2026-08-12T00:00:30.000Z" } as const;
      },
      async beginWorkspaceBootstrap(_context, requestId) {
        return { type: "workspace.bootstrap.page", requestId,
          snapshotId: "refresh-streaming-snapshot", page: 0, rooms: [], catalogRevision: 1,
          snapshotChecksum: "refresh-checksum", hasMore: true, mode: "streaming",
          idleExpiresAt: "2026-08-12T00:00:30.000Z" } as const;
      },
      async readWorkspaceBootstrapPage(_context, requestId, snapshotId, afterPage) {
        return { type: "workspace.bootstrap.page", requestId, snapshotId,
          page: afterPage + 1, rooms: [], catalogRevision: 1,
          snapshotChecksum: "refresh-checksum", hasMore: false, mode: "streaming",
          idleExpiresAt: "2026-08-12T00:00:30.000Z" } as const;
      },
      async completeSnapshot() { throw new Error("unused"); },
      releaseSnapshot,
    } satisfies SyncService;
    const server = await startMessageWebSocketServer({ auth, service, sync });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({ type: "workspace.bootstrap.begin", requestId: "refresh-stream-begin" });
      await client.waitForFrame(
        (frame) => hasType(frame, "workspace.bootstrap.page") && frame.page === 0,
        "refresh streaming first page",
      );
      expired = true;
      client.send({ type: "workspace.bootstrap.page", requestId: "expired-stream-page",
        snapshotId: "refresh-streaming-snapshot", afterPage: 0 });
      await client.waitForError("token_expired", "expired-stream-page");
      expect(releaseSnapshot).not.toHaveBeenCalled();
      await client.refresh(expiredSession.refreshToken!, "refresh-stream-credential");
      client.send({ type: "workspace.bootstrap.page", requestId: "refreshed-stream-page",
        snapshotId: "refresh-streaming-snapshot", afterPage: 0 });
      await client.waitForFrame(
        (frame) => hasType(frame, "workspace.bootstrap.page") &&
          frame.requestId === "refreshed-stream-page" && frame.page === 1,
        "refreshed streaming continuation",
      );
      expect(releaseSnapshot).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
    expect(releaseSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps the family terminal route but removes room delivery after token expiry", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "expired-terminal-route");
    const sessionContext = { sessionId: "session-expired-terminal-route",
      sessionFamilyId: "family-expired-terminal-route", principal };
    let expired = false;
    const releaseSnapshot = vi.fn(async () => undefined);
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() {
        if (expired) throw new AuthenticationError(401, "token_expired");
        return principal;
      },
      async authenticateSession() {
        if (expired) throw new AuthenticationError(401, "token_expired");
        return sessionContext;
      },
      async refresh() { return session; }, async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return { type: "message.accepted", requestId: message.id, messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z" };
      },
      subscribe() { throw new Error("legacy listener must not be used"); },
      async history() { return []; },
    };
    const sync: SyncService = {
      async syncRoom() { throw new Error("unused"); },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap(_context, requestId) {
        return { type: "workspace.bootstrap.page", requestId,
          snapshotId: "expired-terminal-snapshot", page: 0, rooms: [], catalogRevision: 1,
          snapshotChecksum: "expired-terminal-checksum", hasMore: true, mode: "streaming",
          idleExpiresAt: "2026-08-12T00:00:30.000Z" };
      },
      async readWorkspaceBootstrapPage() { throw new Error("unused"); },
      async completeSnapshot() { throw new Error("unused"); }, releaseSnapshot,
    };
    const pending = new Map<string, OutboxDelivery>();
    const dispatched: string[] = [];
    const store: OutboxDispatchStore = {
      async listPendingOutbox(limit) { return [...pending.values()].slice(0, limit); },
      async authorizeOutboxCandidate() { return true; },
      async markOutboxDispatched(deliveryId) { dispatched.push(deliveryId); pending.delete(deliveryId); },
      async markOutboxFailed() { throw new Error("terminal route must dispatch"); },
    };
    const registry = createSubscriptionRegistry();
    const roomEvent: PersistedRoomEvent = { eventId: "expired-room-event",
      streamKind: "room", streamId: roomId, streamSeq: 1, roomId,
      actorId: humans[0].id, occurredAt: "2026-08-12T00:00:01.000Z",
      type: "room.message.accepted", payload: messageFor(humans[0], "expired-room") };
    const revokedEvent: PersistedIdentityEvent & { readonly type: "identity.session.revoked" } = {
      eventId: "expired-terminal-revoked", streamKind: "identity",
      streamId: humans[0].id, streamSeq: 2, actorId: humans[0].id,
      occurredAt: "2026-08-12T00:00:02.000Z", type: "identity.session.revoked",
      payload: { sessionId: sessionContext.sessionId,
        familyId: sessionContext.sessionFamilyId, accountId: principal.accountId },
    };
    const server = await startMessageWebSocketServer({ auth, service, sync,
      outboxStore: store, subscriptionRegistry: registry, outboxPollIntervalMs: 10 });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0]);
      client.send({ type: "workspace.bootstrap.begin", requestId: "expired-terminal-begin" });
      await client.waitForFrame((frame) => hasType(frame, "workspace.bootstrap.page"),
        "expired terminal snapshot owner");
      await client.subscribe(roomId, "expired-terminal-subscribe");
      expired = true;
      client.send({ type: "room.history", requestId: "expired-terminal-action", roomId });
      await client.waitForError("token_expired", "expired-terminal-action");
      expect(registry.candidates({ targetKind: "room", targetId: roomId })).toEqual([]);
      expect(registry.candidates({ targetKind: "session-family",
        targetId: sessionContext.sessionFamilyId })).toHaveLength(1);
      pending.set("expired-room-delivery", { deliveryId: "expired-room-delivery",
        eventId: roomEvent.eventId, targetKind: "room", targetId: roomId,
        streamSeq: 1, attempts: 0, event: roomEvent });
      pending.set("expired-terminal-delivery", { deliveryId: "expired-terminal-delivery",
        eventId: revokedEvent.eventId, targetKind: "session-family",
        targetId: sessionContext.sessionFamilyId, streamSeq: 2, attempts: 0,
        event: revokedEvent });
      await client.waitForFrame((frame) => hasType(frame, "auth.session-revoked") &&
        frame.eventId === revokedEvent.eventId, "expired terminal family frame");
      await client.waitForClose();
      await vi.waitFor(() => expect(dispatched).toContain("expired-terminal-delivery"));
      expect(client.frameCount((frame) => hasMessageCreated(frame, "expired-room"))).toBe(0);
      await vi.waitFor(() => expect(releaseSnapshot).toHaveBeenCalledTimes(1));
    } finally {
      await client.close(); await server.close();
    }
  });

  it.each([
    "snapshot_stale",
    "snapshot_expired",
    "snapshot_not_found",
    "snapshot_family_revoked",
    "snapshot_forbidden",
  ] as const)("forgets all shared owners after terminal snapshot error %s", async (code) => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, `terminal-${code}`);
    const sessionContext = {
      sessionId: `session-terminal-${code}`,
      sessionFamilyId: `family-terminal-${code}`,
      principal,
    };
    const releaseSnapshot = vi.fn(async () => undefined);
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return { type: "message.accepted", requestId: message.id, messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z" };
      },
      subscribe() { return () => undefined; },
      async history() { return []; },
    };
    const sync = {
      async syncRoom() { throw new Error("unused"); },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap(_context, requestId) {
        return { type: "workspace.bootstrap.page", requestId,
          snapshotId: `terminal-snapshot-${code}`, page: 0, rooms: [], catalogRevision: 1,
          snapshotChecksum: "terminal-checksum", hasMore: true, mode: "streaming",
          idleExpiresAt: "2026-08-12T00:00:30.000Z" } as const;
      },
      async readWorkspaceBootstrapPage() {
        throw new SnapshotWorkerClientError(code, "secret terminal details");
      },
      async completeSnapshot() { throw new Error("unused"); },
      releaseSnapshot,
    } satisfies SyncService;
    const server = await startMessageWebSocketServer({ auth, service, sync });
    const first = await LoopbackClient.connect(server.url);
    const second = await LoopbackClient.connect(server.url);

    try {
      await first.login(humans[0]);
      await second.login(humans[0], `terminal-peer-${code}`);
      for (const [client, requestId] of [[first, "first"], [second, "second"]] as const) {
        client.send({ type: "workspace.bootstrap.begin", requestId: `${requestId}-begin-${code}` });
        await client.waitForFrame(
          (frame) => hasType(frame, "workspace.bootstrap.page") &&
            frame.requestId === `${requestId}-begin-${code}`,
          `${requestId} terminal owner`,
        );
      }
      first.send({ type: "workspace.bootstrap.page", requestId: `terminal-page-${code}`,
        snapshotId: `terminal-snapshot-${code}`, afterPage: 0 });
      await first.waitForError(code, `terminal-page-${code}`);
      await first.close();
      await second.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(releaseSnapshot).not.toHaveBeenCalled();
    } finally {
      await first.close();
      await second.close();
      await server.close();
    }
  });

  it("gates a durable accepted-message event by eventId and streamSeq before v2 activation", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-gate");
    const sessionContext = {
      sessionId: "session-v2-gate",
      sessionFamilyId: "family-v2-gate",
      principal,
    };
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() {
        throw new Error("v2 must not use the legacy message listener");
      },
      async history() {
        throw new Error("v2 must not use legacy history");
      },
    };
    const pending = new Map<string, OutboxDelivery>();
    const store: OutboxDispatchStore = {
      async listPendingOutbox(limit) {
        return [...pending.values()].slice(0, limit);
      },
      async authorizeOutboxCandidate() { return true; },
      async markOutboxDispatched(deliveryId) { pending.delete(deliveryId); },
      async markOutboxFailed() { throw new Error("gate delivery must not fail"); },
    };
    const syncStarted = deferred<void>();
    const syncResult = deferred<{
      readonly type: "room.sync.result";
      readonly requestId: string;
      readonly mode: "delta";
      readonly events: readonly [];
      readonly nextCursor: {
        readonly version: 1;
        readonly roomId: string;
        readonly afterSeq: number;
        readonly watermark: number;
      };
      readonly watermark: number;
      readonly hasMore: false;
    }>();
    const sync = {
      async syncRoom() {
        syncStarted.resolve();
        return syncResult.promise;
      },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap() { throw new Error("unused"); },
      async readWorkspaceBootstrapPage() { throw new Error("unused"); },
      async completeSnapshot() { throw new Error("unused"); },
      async releaseSnapshot() {},
    } satisfies SyncService;
    const message = messageFor(humans[0], "v2-gated-message");
    const event: PersistedRoomEvent = {
      eventId: "event-v2-gated-message",
      streamKind: "room",
      streamId: roomId,
      streamSeq: 1,
      roomId,
      actorId: humans[0].id,
      occurredAt: message.sentAt,
      type: "room.message.accepted",
      payload: message,
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      sync,
      outboxStore: store,
      outboxPollIntervalMs: 10,
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({
        type: "room.subscribe.v2",
        requestId: "subscribe-v2-gate",
        roomId,
        cursor: { version: 1, roomId, afterSeq: 0 },
      });
      await settlesWithin(syncStarted.promise, 100);
      const queueDuplicate = (deliveryId: string) => pending.set(deliveryId, {
        deliveryId,
        eventId: event.eventId,
        targetKind: "room",
        targetId: roomId,
        streamSeq: event.streamSeq,
        attempts: 0,
        event,
      });
      queueDuplicate("delivery-v2-gated-message-1");
      queueDuplicate("delivery-v2-gated-message-duplicate");
      await vi.waitFor(() => expect(pending.size).toBe(0));
      syncResult.resolve({
        type: "room.sync.result",
        requestId: "subscribe-v2-gate",
        mode: "delta",
        events: [],
        nextCursor: { version: 1, roomId, afterSeq: 0 },
        watermark: 0,
        hasMore: false,
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "room.event") &&
          isRecord(frame.event) && frame.event.eventId === event.eventId,
        "gated accepted-message event envelope",
      )).resolves.toMatchObject({ frame: { type: "room.event", event } });
      expect(client.frameCount(
        (frame) => hasType(frame, "room.event") && isRecord(frame.event) &&
          frame.event.eventId === event.eventId,
      )).toBe(1);
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "room.subscribed.v2") &&
          frame.requestId === "subscribe-v2-gate",
        "v2 subscription activation",
      )).resolves.toMatchObject({
        frame: {
          type: "room.subscribed.v2",
          cursor: { version: 1, roomId, afterSeq: 1 },
          watermark: 1,
        },
      });
    } finally {
      syncResult.resolve({
        type: "room.sync.result",
        requestId: "subscribe-v2-gate",
        mode: "delta",
        events: [],
        nextCursor: { version: 1, roomId, afterSeq: 0 },
        watermark: 0,
        hasMore: false,
      });
      await client.close();
      await server.close();
    }
  });

  it("reads every delta page before draining the v2 gate and activating", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-paged");
    const sessionContext = {
      sessionId: "session-v2-paged",
      sessionFamilyId: "family-v2-paged",
      principal,
    };
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() { throw new Error("v2 must not use legacy listeners"); },
      async history() { throw new Error("v2 must not use legacy history"); },
    };
    const eventFor = (sequence: number): PersistedRoomEvent => ({
      eventId: `event-v2-paged-${sequence}`,
      streamKind: "room",
      streamId: roomId,
      streamSeq: sequence,
      roomId,
      actorId: humans[0].id,
      occurredAt: `2026-08-12T00:00:0${sequence}.000Z`,
      type: "room.message.accepted",
      payload: messageFor(humans[0], `v2-paged-${sequence}`),
    });
    const syncCursors: number[] = [];
    const secondPage = deferred<void>();
    const sync = {
      async syncRoom(_context, request) {
        const cursor = (request as { readonly cursor: { readonly afterSeq: number } }).cursor;
        syncCursors.push(cursor.afterSeq);
        if (cursor.afterSeq === 0) {
          return {
            type: "room.sync.result",
            requestId: "subscribe-v2-paged",
            mode: "delta",
            events: [eventFor(1)],
            nextCursor: { version: 1, roomId, afterSeq: 1, watermark: 3 },
            watermark: 3,
            hasMore: true,
          } as const;
        }
        await secondPage.promise;
        return {
          type: "room.sync.result",
          requestId: "subscribe-v2-paged",
          mode: "delta",
          events: [eventFor(2), eventFor(3)],
          nextCursor: { version: 1, roomId, afterSeq: 3 },
          watermark: 3,
          hasMore: false,
        } as const;
      },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap() { throw new Error("unused"); },
      async readWorkspaceBootstrapPage() { throw new Error("unused"); },
      async completeSnapshot() { throw new Error("unused"); },
      async releaseSnapshot() {},
    } satisfies SyncService;
    const pending = new Map<string, OutboxDelivery>();
    const store: OutboxDispatchStore = {
      async listPendingOutbox(limit) { return [...pending.values()].slice(0, limit); },
      async authorizeOutboxCandidate() { return true; },
      async markOutboxDispatched(deliveryId) { pending.delete(deliveryId); },
      async markOutboxFailed() { throw new Error("paged gate delivery must not fail"); },
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      sync,
      outboxStore: store,
      outboxPollIntervalMs: 10,
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({
        type: "room.subscribe.v2",
        requestId: "subscribe-v2-paged",
        roomId,
        cursor: { version: 1, roomId, afterSeq: 0 },
      });
      await vi.waitFor(() => expect(syncCursors).toEqual([0, 1]));
      const live = eventFor(4);
      pending.set("delivery-v2-paged-live", {
        deliveryId: "delivery-v2-paged-live",
        eventId: live.eventId,
        targetKind: "room",
        targetId: roomId,
        streamSeq: live.streamSeq,
        attempts: 0,
        event: live,
      });
      await vi.waitFor(() => expect(pending.size).toBe(0));
      expect(client.frameCount((frame) => hasType(frame, "room.subscribed.v2"))).toBe(0);
      secondPage.resolve();
      const subscribed = await client.waitForFrame(
        (frame) => hasType(frame, "room.subscribed.v2") &&
          frame.requestId === "subscribe-v2-paged",
        "paged v2 subscription",
      );
      expect(subscribed.frame).toMatchObject({
        cursor: { version: 1, roomId, afterSeq: 4 },
        watermark: 4,
      });
      expect(isRecord(subscribed.frame) && isRecord(subscribed.frame.cursor)
        ? Object.hasOwn(subscribed.frame.cursor, "watermark")
        : true).toBe(false);
      const syncFrames = [1, 3].map((afterSeq) => client.frameIndex(
        (frame) => hasType(frame, "room.sync.result") &&
          isRecord(frame.nextCursor) && frame.nextCursor.afterSeq === afterSeq,
      ));
      const liveIndex = client.frameIndex(
        (frame) => hasType(frame, "room.event") && isRecord(frame.event) &&
          frame.event.eventId === "event-v2-paged-4",
      );
      expect(syncFrames.every((index) => index >= 0)).toBe(true);
      expect(syncFrames[0]).toBeLessThan(syncFrames[1]!);
      expect(syncFrames[1]).toBeLessThan(liveIndex);
      expect(syncCursors).toEqual([0, 1]);
    } finally {
      secondPage.resolve();
      await client.close();
      await server.close();
    }
  });

  it.each(["first", "middle"] as const)(
    "rejects a wrong requestId on the %s v2 sync page",
    async (wrongPage) => {
      const principal = { accountId: "account-human-1", actorId: humans[0].id };
      const session = issuedSession(principal, `v2-wrong-request-${wrongPage}`);
      const sessionContext = { sessionId: `session-v2-wrong-request-${wrongPage}`,
        sessionFamilyId: `family-v2-wrong-request-${wrongPage}`, principal };
      const auth: AuthenticationService = {
        async login() { return session; }, async authenticate() { return principal; },
        async authenticateSession() { return sessionContext; },
        async refresh() { return session; }, async revoke() {},
      };
      const service: MessageService = {
        async send(_context, message) {
          return { type: "message.accepted", requestId: message.id, messageId: message.id,
            persistedAt: "2026-08-12T00:00:00.000Z" };
        },
        subscribe() { throw new Error("v2 must not use legacy listeners"); },
        async history() { throw new Error("v2 must not use legacy history"); },
      };
      let calls = 0;
      const firstEvent: PersistedRoomEvent = {
        eventId: `event-v2-wrong-${wrongPage}`,
        streamKind: "room", streamId: roomId, streamSeq: 1, roomId,
        actorId: humans[0].id, occurredAt: "2026-08-12T00:00:01.000Z",
        type: "room.message.accepted",
        payload: messageFor(humans[0], `v2-wrong-${wrongPage}`),
      };
      const secondEvent: PersistedRoomEvent = {
        ...firstEvent,
        eventId: `${firstEvent.eventId}-2`,
        streamSeq: 2,
        occurredAt: "2026-08-12T00:00:02.000Z",
      };
      const sync = {
        async syncRoom() {
          calls += 1;
          const first = calls === 1;
          return { type: "room.sync.result",
            requestId: wrongPage === (first ? "first" : "middle")
              ? "wrong-subscribe-request" : `subscribe-v2-wrong-${wrongPage}`,
            mode: "delta", events: first ? [firstEvent] : [secondEvent],
            nextCursor: first
              ? { version: 1, roomId, afterSeq: 1, watermark: 2 }
              : { version: 1, roomId, afterSeq: 2 },
            watermark: 2, hasMore: first } as const;
        },
        async beginRoomRepair() { throw new Error("unused"); },
        async readRoomRepairPage() { throw new Error("unused"); },
        async beginWorkspaceBootstrap() { throw new Error("unused"); },
        async readWorkspaceBootstrapPage() { throw new Error("unused"); },
        async completeSnapshot() { throw new Error("unused"); },
        async releaseSnapshot() {},
      } satisfies SyncService;
      const registry = createSubscriptionRegistry();
      const outboxStore: OutboxDispatchStore = {
        async listPendingOutbox() { return []; },
        async authorizeOutboxCandidate() { return true; },
        async markOutboxDispatched() {}, async markOutboxFailed() {},
      };
      const server = await startMessageWebSocketServer({ auth, service, sync,
        outboxStore, subscriptionRegistry: registry });
      const client = await LoopbackClient.connect(server.url);
      try {
        await client.login(humans[0]);
        client.send({ type: "room.subscribe.v2",
          requestId: `subscribe-v2-wrong-${wrongPage}`, roomId,
          cursor: { version: 1, roomId, afterSeq: 0 } });
        await client.waitForError("storage_unavailable", `subscribe-v2-wrong-${wrongPage}`);
        expect(client.frameCount((frame) => hasType(frame, "room.sync.result") &&
          frame.requestId === "wrong-subscribe-request")).toBe(0);
        expect(client.frameCount((frame) => hasType(frame, "room.subscribed.v2"))).toBe(0);
        expect(registry.candidates({ targetKind: "room", targetId: roomId })).toEqual([]);
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it("orders out-of-order active deliveries without advancing across a sequence gap", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-active-order");
    const sessionContext = {
      sessionId: "session-v2-active-order",
      sessionFamilyId: "family-v2-active-order",
      principal,
    };
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() { throw new Error("v2 must not use legacy listeners"); },
      async history() { throw new Error("v2 must not use legacy history"); },
    };
    const sync = {
      async syncRoom() {
        return {
          type: "room.sync.result",
          requestId: "subscribe-v2-active-order",
          mode: "delta",
          events: [],
          nextCursor: { version: 1, roomId, afterSeq: 0 },
          watermark: 0,
          hasMore: false,
        } as const;
      },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap() { throw new Error("unused"); },
      async readWorkspaceBootstrapPage() { throw new Error("unused"); },
      async completeSnapshot() { throw new Error("unused"); },
      async releaseSnapshot() {},
    } satisfies SyncService;
    const pending = new Map<string, OutboxDelivery>();
    const dispatched: string[] = [];
    const store: OutboxDispatchStore = {
      async listPendingOutbox(limit) { return [...pending.values()].slice(0, limit); },
      async authorizeOutboxCandidate() { return true; },
      async markOutboxDispatched(deliveryId) {
        dispatched.push(deliveryId);
        pending.delete(deliveryId);
      },
      async markOutboxFailed() { throw new Error("active ordering send must not fail"); },
    };
    const eventFor = (sequence: number): PersistedRoomEvent => ({
      eventId: `event-v2-active-order-${sequence}`,
      streamKind: "room",
      streamId: roomId,
      streamSeq: sequence,
      roomId,
      actorId: humans[0].id,
      occurredAt: `2026-08-12T00:00:0${sequence}.000Z`,
      type: "room.message.accepted",
      payload: messageFor(humans[0], `v2-active-order-${sequence}`),
    });
    const queue = (sequence: number) => {
      const event = eventFor(sequence);
      pending.set(`delivery-v2-active-order-${sequence}`, {
        deliveryId: `delivery-v2-active-order-${sequence}`,
        eventId: event.eventId,
        targetKind: "room",
        targetId: roomId,
        streamSeq: event.streamSeq,
        attempts: 0,
        event,
      });
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      sync,
      outboxStore: store,
      outboxPollIntervalMs: 10,
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({
        type: "room.subscribe.v2",
        requestId: "subscribe-v2-active-order",
        roomId,
        cursor: { version: 1, roomId, afterSeq: 0 },
      });
      await client.waitForFrame(
        (frame) => hasType(frame, "room.subscribed.v2") &&
          frame.requestId === "subscribe-v2-active-order",
        "active ordered subscription",
      );
      queue(2);
      await vi.waitFor(() => expect(dispatched).toEqual(["delivery-v2-active-order-2"]));
      expect(client.frameCount((frame) => hasType(frame, "room.event"))).toBe(0);
      queue(1);
      await vi.waitFor(() => expect(dispatched).toEqual([
        "delivery-v2-active-order-2",
        "delivery-v2-active-order-1",
      ]));
      await client.waitForFrame(
        (frame) => hasType(frame, "room.event") && isRecord(frame.event) &&
          frame.event.eventId === "event-v2-active-order-2",
        "drained active event 2",
      );
      const received = [1, 2].map((sequence) => client.frameIndex(
        (frame) => hasType(frame, "room.event") && isRecord(frame.event) &&
          frame.event.eventId === `event-v2-active-order-${sequence}`,
      ));
      expect(received[0]).toBeLessThan(received[1]!);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("retries from the last contiguous cursor when an active gap buffer overflows", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-active-overflow");
    const sessionContext = {
      sessionId: "session-v2-active-overflow",
      sessionFamilyId: "family-v2-active-overflow",
      principal,
    };
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() { throw new Error("v2 must not use legacy listeners"); },
      async history() { throw new Error("v2 must not use legacy history"); },
    };
    const sync = {
      async syncRoom() {
        return {
          type: "room.sync.result",
          requestId: "subscribe-v2-active-overflow",
          mode: "delta",
          events: [],
          nextCursor: { version: 1, roomId, afterSeq: 0 },
          watermark: 0,
          hasMore: false,
        } as const;
      },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap() { throw new Error("unused"); },
      async readWorkspaceBootstrapPage() { throw new Error("unused"); },
      async completeSnapshot() { throw new Error("unused"); },
      async releaseSnapshot() {},
    } satisfies SyncService;
    const pending = new Map<string, OutboxDelivery>();
    const dispatched: string[] = [];
    const store: OutboxDispatchStore = {
      async listPendingOutbox(limit) { return [...pending.values()].slice(0, limit); },
      async authorizeOutboxCandidate() { return true; },
      async markOutboxDispatched(deliveryId) {
        dispatched.push(deliveryId);
        pending.delete(deliveryId);
      },
      async markOutboxFailed() { throw new Error("active overflow capture must be accepted"); },
    };
    const eventFor = (sequence: number): PersistedRoomEvent => ({
        eventId: `event-v2-active-overflow-${sequence}`,
        streamKind: "room",
        streamId: roomId,
        streamSeq: sequence,
        roomId,
        actorId: humans[0].id,
        occurredAt: `2026-08-12T00:00:0${sequence}.000Z`,
        type: "room.message.accepted",
        payload: messageFor(humans[0], `v2-active-overflow-${sequence}`),
    });
    const queue = (sequence: number) => {
      const event = eventFor(sequence);
      pending.set(`delivery-v2-active-overflow-${sequence}`, {
        deliveryId: `delivery-v2-active-overflow-${sequence}`,
        eventId: event.eventId,
        targetKind: "room",
        targetId: roomId,
        streamSeq: event.streamSeq,
        attempts: 0,
        event,
      });
    };
    const registry = createSubscriptionRegistry();
    const server = await startMessageWebSocketServer({
      auth,
      service,
      sync,
      outboxStore: store,
      outboxPollIntervalMs: 10,
      subscriptionRegistry: registry,
      v2GateMaxEvents: 2,
      v2GateMaxBytes: Buffer.byteLength(JSON.stringify(eventFor(3)), "utf8"),
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({
        type: "room.subscribe.v2",
        requestId: "subscribe-v2-active-overflow",
        roomId,
        cursor: { version: 1, roomId, afterSeq: 0 },
      });
      const subscribed = await client.waitForFrame(
        (frame) => hasType(frame, "room.subscribed.v2") &&
          frame.requestId === "subscribe-v2-active-overflow",
        "active overflow subscription",
      );
      expect(subscribed.frame).toMatchObject({
        cursor: { version: 1, roomId, afterSeq: 0 },
        watermark: 0,
      });
      expect(isRecord(subscribed.frame) && isRecord(subscribed.frame.cursor)
        ? Object.hasOwn(subscribed.frame.cursor, "watermark")
        : true).toBe(false);
      queue(1);
      await vi.waitFor(() => expect(dispatched).toEqual([
        "delivery-v2-active-overflow-1",
      ]));
      await client.waitForFrame(
        (frame) => hasType(frame, "room.event") && isRecord(frame.event) &&
          frame.event.eventId === "event-v2-active-overflow-1",
        "active contiguous event 1",
      );
      queue(3);
      await vi.waitFor(() => expect(dispatched).toEqual([
        "delivery-v2-active-overflow-1",
        "delivery-v2-active-overflow-3",
      ]));
      expect(client.frameCount((frame) => hasType(frame, "room.event"))).toBe(1);
      queue(4);
      await vi.waitFor(() => expect(dispatched).toEqual([
        "delivery-v2-active-overflow-1",
        "delivery-v2-active-overflow-3",
        "delivery-v2-active-overflow-4",
      ]));
      const retry = await client.waitForFrame(
        (frame) => hasType(frame, "room.subscribe.v2.retry") &&
          frame.requestId === "subscribe-v2-active-overflow",
        "active overflow retry",
      );
      expect(retry.frame).toEqual({
        type: "room.subscribe.v2.retry",
        requestId: "subscribe-v2-active-overflow",
        roomId,
        reason: "gate_overflow",
        restartFrom: { version: 1, roomId, afterSeq: 1 },
      });
      expect(registry.candidates({ targetKind: "room", targetId: roomId })).toEqual([]);
      expect(client.frameCount((frame) => hasType(frame, "room.subscribed.v2"))).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not advance or drain higher active events when the next send fails", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-active-send-failure");
    const sessionContext = {
      sessionId: "session-v2-active-send-failure",
      sessionFamilyId: "family-v2-active-send-failure",
      principal,
    };
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() { throw new Error("v2 must not use legacy listeners"); },
      async history() { throw new Error("v2 must not use legacy history"); },
    };
    const sync = {
      async syncRoom() {
        return {
          type: "room.sync.result",
          requestId: "subscribe-v2-active-send-failure",
          mode: "delta",
          events: [],
          nextCursor: { version: 1, roomId, afterSeq: 0 },
          watermark: 0,
          hasMore: false,
        } as const;
      },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap() { throw new Error("unused"); },
      async readWorkspaceBootstrapPage() { throw new Error("unused"); },
      async completeSnapshot() { throw new Error("unused"); },
      async releaseSnapshot() {},
    } satisfies SyncService;
    const pending = new Map<string, OutboxDelivery>();
    const dispatched: string[] = [];
    const failed: Array<{ readonly deliveryId: string; readonly reason: string }> = [];
    const store: OutboxDispatchStore = {
      async listPendingOutbox(limit) { return [...pending.values()].slice(0, limit); },
      async authorizeOutboxCandidate() { return true; },
      async markOutboxDispatched(deliveryId) {
        dispatched.push(deliveryId);
        pending.delete(deliveryId);
      },
      async markOutboxFailed(deliveryId, reason) {
        failed.push({ deliveryId, reason });
        pending.delete(deliveryId);
      },
    };
    const queue = (sequence: number, body: string) => {
      const event: PersistedRoomEvent = {
        eventId: `event-v2-active-send-failure-${sequence}`,
        streamKind: "room",
        streamId: roomId,
        streamSeq: sequence,
        roomId,
        actorId: humans[0].id,
        occurredAt: `2026-08-12T00:00:0${sequence}.000Z`,
        type: "room.message.accepted",
        payload: { ...messageFor(humans[0], `v2-active-send-failure-${sequence}`), body },
      };
      pending.set(`delivery-v2-active-send-failure-${sequence}`, {
        deliveryId: `delivery-v2-active-send-failure-${sequence}`,
        eventId: event.eventId,
        targetKind: "room",
        targetId: roomId,
        streamSeq: event.streamSeq,
        attempts: 0,
        event,
      });
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      sync,
      outboxStore: store,
      outboxPollIntervalMs: 10,
      maxBufferedAmountBytes: 512,
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({
        type: "room.subscribe.v2",
        requestId: "subscribe-v2-active-send-failure",
        roomId,
        cursor: { version: 1, roomId, afterSeq: 0 },
      });
      await client.waitForFrame(
        (frame) => hasType(frame, "room.subscribed.v2") &&
          frame.requestId === "subscribe-v2-active-send-failure",
        "active send failure subscription",
      );
      queue(2, "buffered higher event");
      await vi.waitFor(() => expect(dispatched).toEqual([
        "delivery-v2-active-send-failure-2",
      ]));
      queue(1, "界".repeat(512));
      await expect(client.waitForClose()).resolves.toBeUndefined();
      await vi.waitFor(() => expect(failed).toEqual([{
        deliveryId: "delivery-v2-active-send-failure-1",
        reason: "backpressure",
      }]));
      expect(client.frameCount((frame) => hasType(frame, "room.event"))).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns retry and removes the inactive v2 subscription when its event gate overflows", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "v2-overflow");
    const sessionContext = {
      sessionId: "session-v2-overflow",
      sessionFamilyId: "family-v2-overflow",
      principal,
    };
    const auth: AuthenticationService = {
      async login() { return session; },
      async authenticate() { return principal; },
      async authenticateSession() { return sessionContext; },
      async refresh() { return session; },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      subscribe() { throw new Error("v2 must not use legacy listeners"); },
      async history() { throw new Error("v2 must not use legacy history"); },
    };
    const pending = new Map<string, OutboxDelivery>();
    const dispatched: string[] = [];
    const store: OutboxDispatchStore = {
      async listPendingOutbox(limit) { return [...pending.values()].slice(0, limit); },
      async authorizeOutboxCandidate() { return true; },
      async markOutboxDispatched(deliveryId) {
        dispatched.push(deliveryId);
        pending.delete(deliveryId);
      },
      async markOutboxFailed() { throw new Error("overflow capture must be accepted"); },
    };
    const syncStarted = deferred<void>();
    const syncResult = deferred<{
      readonly type: "room.sync.result";
      readonly requestId: string;
      readonly mode: "delta";
      readonly events: readonly [];
      readonly nextCursor: {
        readonly version: 1;
        readonly roomId: string;
        readonly afterSeq: number;
        readonly watermark: number;
      };
      readonly watermark: number;
      readonly hasMore: false;
    }>();
    const sync = {
      async syncRoom() {
        syncStarted.resolve();
        return syncResult.promise;
      },
      async beginRoomRepair() { throw new Error("unused"); },
      async readRoomRepairPage() { throw new Error("unused"); },
      async beginWorkspaceBootstrap() { throw new Error("unused"); },
      async readWorkspaceBootstrapPage() { throw new Error("unused"); },
      async completeSnapshot() { throw new Error("unused"); },
      async releaseSnapshot() {},
    } satisfies SyncService;
    const eventFor = (sequence: number): PersistedRoomEvent => ({
      eventId: `event-v2-overflow-${sequence}`,
      streamKind: "room",
      streamId: roomId,
      streamSeq: sequence,
      roomId,
      actorId: humans[0].id,
      occurredAt: `2026-08-12T00:00:0${sequence}.000Z`,
      type: "room.message.accepted",
      payload: messageFor(humans[0], `v2-overflow-${sequence}`),
    });
    const queue = (sequence: number) => {
      const event = eventFor(sequence);
      pending.set(`delivery-v2-overflow-${sequence}`, {
        deliveryId: `delivery-v2-overflow-${sequence}`,
        eventId: event.eventId,
        targetKind: "room",
        targetId: roomId,
        streamSeq: event.streamSeq,
        attempts: 0,
        event,
      });
    };
    const registry = createSubscriptionRegistry();
    const server = await startMessageWebSocketServer({
      auth,
      service,
      sync,
      outboxStore: store,
      outboxPollIntervalMs: 10,
      v2GateMaxEvents: 1,
      subscriptionRegistry: registry,
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({
        type: "room.subscribe.v2",
        requestId: "subscribe-v2-overflow",
        roomId,
        cursor: { version: 1, roomId, afterSeq: 0 },
      });
      await settlesWithin(syncStarted.promise, 100);
      queue(1);
      queue(2);
      await vi.waitFor(() => expect(dispatched).toEqual([
        "delivery-v2-overflow-1",
        "delivery-v2-overflow-2",
      ]));
      expect(() => registry.candidates({ targetKind: "room", targetId: roomId }))
        .not.toThrow();
      expect(registry.candidates({ targetKind: "room", targetId: roomId })).toEqual([]);
      queue(3);
      await vi.waitFor(() => expect(dispatched).toContain("delivery-v2-overflow-3"));
      syncResult.resolve({
        type: "room.sync.result",
        requestId: "subscribe-v2-overflow",
        mode: "delta",
        events: [],
        nextCursor: { version: 1, roomId, afterSeq: 0 },
        watermark: 0,
        hasMore: false,
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "room.subscribe.v2.retry") &&
          frame.requestId === "subscribe-v2-overflow",
        "v2 overflow retry",
      )).resolves.toMatchObject({
        frame: {
          type: "room.subscribe.v2.retry",
          reason: "gate_overflow",
          restartFrom: { version: 1, roomId, afterSeq: 0 },
        },
      });
      expect(client.frameCount((frame) => hasType(frame, "room.subscribed.v2"))).toBe(0);
      expect(client.frameCount((frame) => hasType(frame, "room.event"))).toBe(0);
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "room.event") && isRecord(frame.event) &&
          frame.event.eventId === "event-v2-overflow-3",
        "post-overflow room event",
        100,
      )).rejects.toThrow("Timed out");
    } finally {
      syncResult.resolve({
        type: "room.sync.result",
        requestId: "subscribe-v2-overflow",
        mode: "delta",
        events: [],
        nextCursor: { version: 1, roomId, afterSeq: 0 },
        watermark: 0,
        hasMore: false,
      });
      await client.close();
      await server.close();
    }
  });

  it("dispatches the owner-approved closed outbox wire without legacy listeners", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "outbox-wire");
    const sessionContext = {
      sessionId: "session-outbox-wire",
      sessionFamilyId: "family-outbox-wire",
      principal,
    };
    let revoked = false;
    let resolveRevokeCommitted!: () => void;
    const revokeCommitted = new Promise<void>((resolve) => {
      resolveRevokeCommitted = resolve;
    });
    let afterRevoke = () => {};
    const auth: AuthenticationService = {
      async login() {
        return session;
      },
      async authenticate() {
        return principal;
      },
      async authenticateSession() {
        if (revoked) {
          throw new AuthenticationError(403, "session_revoked");
        }
        return sessionContext;
      },
      async refresh() {
        return session;
      },
      async revoke() {
        revoked = true;
        afterRevoke();
      },
    };
    let subscribeCalls = 0;
    const service: MessageService = {
      async send(_context, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-11T00:00:00.000Z",
        };
      },
      subscribe() {
        subscribeCalls += 1;
        throw new Error("legacy listener must not be used");
      },
      async history(context) {
        expect(context).toEqual(sessionContext);
        return [];
      },
    };
    const pending = new Map<string, OutboxDelivery>();
    const dispatched: string[] = [];
    const store: OutboxDispatchStore = {
      async listPendingOutbox(limit) {
        return [...pending.values()].slice(0, limit);
      },
      async authorizeOutboxCandidate(_delivery, candidate) {
        expect(candidate).toMatchObject<Partial<OutboxDispatchCandidate>>({
          principal,
          sessionId: sessionContext.sessionId,
          sessionFamilyId: sessionContext.sessionFamilyId,
        });
        return true;
      },
      async markOutboxDispatched(deliveryId) {
        dispatched.push(deliveryId);
        pending.delete(deliveryId);
      },
      async markOutboxFailed() {
        throw new Error("outbox send must not fail");
      },
    };
    const message = messageFor(humans[0], "outbox-wire-message");
    const messageEvent: PersistedRoomEvent = {
      eventId: "event-outbox-message",
      streamKind: "room",
      streamId: roomId,
      streamSeq: 1,
      roomId,
      actorId: humans[0].id,
      occurredAt: message.sentAt,
      type: "room.message.accepted",
      payload: message,
    };
    const readEvent: PersistedRoomEvent = {
      eventId: "event-outbox-read",
      streamKind: "room",
      streamId: roomId,
      streamSeq: 2,
      roomId,
      actorId: humans[0].id,
      occurredAt: "2026-08-11T00:00:01.000Z",
      type: "room.human_read.recorded",
      payload: {
        id: "read-outbox-wire",
        messageId: message.id,
        readerId: humans[0].id,
        readAt: "2026-08-11T00:00:01.000Z",
      },
    };
    const accessEvent: PersistedIdentityEvent = {
      eventId: "event-outbox-access",
      streamKind: "identity",
      streamId: humans[0].id,
      streamSeq: 3,
      actorId: humans[0].id,
      occurredAt: "2026-08-11T00:00:02.000Z",
      type: "identity.room-access.changed",
      payload: { roomId, change: "updated" },
    };
    const revokedEvent: PersistedIdentityEvent & {
      readonly type: "identity.session.revoked";
    } = {
      eventId: "event-outbox-revoked",
      streamKind: "identity",
      streamId: humans[0].id,
      streamSeq: 4,
      actorId: humans[0].id,
      occurredAt: "2026-08-11T00:00:03.000Z",
      type: "identity.session.revoked",
      payload: {
        sessionId: sessionContext.sessionId,
        familyId: sessionContext.sessionFamilyId,
        accountId: principal.accountId,
      },
    };
    const queue = (delivery: OutboxDelivery) => pending.set(delivery.deliveryId, delivery);
    afterRevoke = () => {
      queue({
        deliveryId: "delivery-outbox-revoked",
        eventId: revokedEvent.eventId,
        targetKind: "session-family",
        targetId: sessionContext.sessionFamilyId,
        streamSeq: revokedEvent.streamSeq,
        attempts: 0,
        event: revokedEvent,
      });
      resolveRevokeCommitted();
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      outboxStore: store,
      outboxPollIntervalMs: 50,
    });
    const client = await LoopbackClient.connect(server.url);
    const peer = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      await peer.login(humans[0], "login-outbox-peer");
      client.send({ type: "room.subscribe", requestId: "outbox-subscribe", roomId });
      const subscribeResult = await client.waitForFrame(
        (frame) => isRecord(frame) && frame.requestId === "outbox-subscribe",
        "outbox subscribe result",
      );
      expect(subscribeResult.frame).toMatchObject({
        type: "room.history",
        requestId: "outbox-subscribe",
      });
      expect(subscribeCalls).toBe(0);

      queue({
        deliveryId: "delivery-outbox-message",
        eventId: messageEvent.eventId,
        targetKind: "room",
        targetId: roomId,
        streamSeq: messageEvent.streamSeq,
        attempts: 0,
        event: messageEvent,
      });
      await expect(client.waitForMessage(message.id)).resolves.toMatchObject({
        frame: { type: "message.created", message },
      });

      queue({
        deliveryId: "delivery-outbox-read",
        eventId: readEvent.eventId,
        targetKind: "room",
        targetId: roomId,
        streamSeq: readEvent.streamSeq,
        attempts: 0,
        event: readEvent,
      });
      await expect(
        client.waitForFrame(
          (frame) => hasType(frame, "room.event") && isRecord(frame.event) &&
            frame.event.eventId === readEvent.eventId,
          "closed room event",
        ),
      ).resolves.toMatchObject({ frame: { type: "room.event", event: readEvent } });

      queue({
        deliveryId: "delivery-outbox-access",
        eventId: accessEvent.eventId,
        targetKind: "principal",
        targetId: humans[0].id,
        streamSeq: accessEvent.streamSeq,
        attempts: 0,
        event: accessEvent,
      });
      await expect(
        client.waitForFrame(
          (frame) => hasType(frame, "identity.room-access.changed") &&
            frame.eventId === accessEvent.eventId,
          "room access identity event",
        ),
      ).resolves.toMatchObject({ frame: accessEvent });

      client.send({ type: "auth.revoke", requestId: "outbox-revoke" });
      await revokeCommitted;
      peer.send({ type: "room.history", requestId: "peer-after-revoke", roomId });
      await expect(
        client.waitForFrame(
          (frame) => hasType(frame, "auth.session-revoked") &&
            frame.eventId === revokedEvent.eventId && frame.requestId === undefined,
          "terminal session-family frame",
        ),
      ).resolves.toMatchObject({
        frame: { type: "auth.session-revoked", eventId: revokedEvent.eventId },
      });
      await expect(
        peer.waitForFrame(
          (frame) => hasType(frame, "auth.session-revoked") &&
            frame.eventId === revokedEvent.eventId && frame.requestId === undefined,
          "peer terminal session-family frame",
        ),
      ).resolves.toMatchObject({
        frame: { type: "auth.session-revoked", eventId: revokedEvent.eventId },
      });
      expect(client.frameCount(
        (frame) => hasType(frame, "auth.revoked") && frame.requestId === "outbox-revoke",
      )).toBe(0);
      await client.waitForClose();
      await peer.waitForClose();
      await vi.waitFor(() => expect(dispatched).toEqual([
        "delivery-outbox-message",
        "delivery-outbox-read",
        "delivery-outbox-access",
        "delivery-outbox-revoked",
      ]));
    } finally {
      await client.close();
      await peer.close();
      await server.close();
    }
  });

  it("exports finite aggregate inbound queue defaults", async () => {
    const serverModule = await import("./index.js");

    expect(serverModule.MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_COUNT).toBe(64);
    expect(serverModule.MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_BYTES).toBe(256 * 1_024);
  });

  it("keeps the plaintext authority listener loopback-only and formats IPv6 URLs", () => {
    expect(() => validateMessageWebSocketListener("127.0.0.1", 8_787)).not.toThrow();
    expect(() => validateMessageWebSocketListener("127.12.34.56", 0)).not.toThrow();
    expect(() => validateMessageWebSocketListener("localhost", 65_535)).not.toThrow();
    expect(() => validateMessageWebSocketListener("::1", 0)).not.toThrow();
    expect(formatMessageWebSocketUrl("::1", 8_787)).toBe("ws://[::1]:8787");

    for (const host of ["", " ", "127.0.0.1 ", "0.0.0.0", "::", "192.168.1.2", "example.com"]) {
      expect(() => validateMessageWebSocketListener(host, 8_787)).toThrow(TypeError);
    }
    for (const port of [-1, 1.5, 65_536, Number.POSITIVE_INFINITY]) {
      expect(() => validateMessageWebSocketListener("127.0.0.1", port)).toThrow(RangeError);
    }
  });

  it.each([
    { option: "maxQueuedFrameCount", value: 0 },
    { option: "maxQueuedFrameCount", value: 1.5 },
    { option: "maxQueuedFrameCount", value: Number.POSITIVE_INFINITY },
    { option: "maxQueuedFrameBytes", value: 0 },
    { option: "maxQueuedFrameBytes", value: 1.5 },
    { option: "maxQueuedFrameBytes", value: Number.POSITIVE_INFINITY },
  ] as const)("rejects invalid $option=$value", async ({ option, value }) => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "invalid-inbound-bound");
    const auth: AuthenticationService = {
      async login() {
        return session;
      },
      async authenticate() {
        return principal;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        return () => undefined;
      },
      async history() {
        return [];
      },
    };
    const attempt = startMessageWebSocketServer({
      auth,
      service,
      [option]: value,
    }).then(async (server) => {
      await server.close();
      return server;
    });

    await expect(attempt).rejects.toBeInstanceOf(RangeError);
  });

  it("returns closed structured errors without echoing credentials or tokens", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const client = await fixture.connect();

    client.sendRaw("{not-json");
    await expect(client.waitForError("invalid_request")).resolves.toMatchObject({
      frame: { type: "error", status: 400, code: "invalid_request" },
    });

    client.send({ type: "auth.sessions.list", requestId: "unauthenticated-list" });
    await expect(client.waitForError("unauthenticated", "unauthenticated-list"))
      .resolves.toMatchObject({ frame: { status: 401 } });
    client.send({
      type: "auth.session.revoke",
      requestId: "unauthenticated-target-revoke",
      sessionId: "public-session-canary",
    });
    const unauthenticatedRevoke = await client.waitForError(
      "unauthenticated",
      "unauthenticated-target-revoke",
    );
    expect(unauthenticatedRevoke.frame).toMatchObject({ status: 401 });
    expect(JSON.stringify(unauthenticatedRevoke.frame)).not.toContain(
      "public-session-canary",
    );

    client.send({
      type: "auth.login",
      requestId: "bad-login",
      accountId: "account-human-1",
      secret: "wrong-secret",
      device: testLoginDevice,
    });
    const invalidCredentials = await client.waitForError("invalid_credentials", "bad-login");
    expect(invalidCredentials.frame).toMatchObject({ status: 401 });
    expect(JSON.stringify(invalidCredentials.frame)).not.toContain("wrong-secret");

    client.send({
      type: "auth.resume",
      requestId: "bad-resume",
      accessToken: "tampered-access-token",
    });
    const invalidToken = await client.waitForError("invalid_token", "bad-resume");
    expect(invalidToken.frame).toMatchObject({ status: 401 });
    expect(JSON.stringify(invalidToken.frame)).not.toContain("tampered-access-token");

    client.send({
      type: "room.history",
      requestId: "extra-field",
      roomId,
      unexpected: true,
    });
    await expect(client.waitForError("invalid_request", "extra-field")).resolves.toMatchObject({
      frame: { status: 400 },
    });
  });

  it("fails closed when Message Authority vNext is not installed", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const client = await fixture.connect();
    const frames = [
      {
        type: "message.send.v2",
        requestId: "message-v2-unavailable",
        message: {
          messageId: "message-v2-1",
          roomId,
          body: "hello",
          mentionedTargets: [],
          attachments: [],
        },
      },
      {
        type: "message.revise",
        requestId: "message-revise-unavailable",
        roomId,
        messageId: "message-v2-1",
        expectedRevision: 1,
        body: "revised",
      },
      {
        type: "message.recall",
        requestId: "message-recall-unavailable",
        roomId,
        messageId: "message-v2-1",
        expectedRevision: 1,
      },
      {
        type: "room.history.v2",
        requestId: "message-history-unavailable",
        roomId,
        limit: 25,
      },
      {
        type: "message.revisions.query",
        requestId: "message-revisions-unavailable",
        roomId,
        messageId: "message-v2-1",
        limit: 25,
      },
    ] as const;

    client.send(frames[0]);
    await expect(client.waitForError("unauthenticated", frames[0].requestId))
      .resolves.toMatchObject({ frame: { status: 401 } });

    await client.login(humans[0], "message-authority-login");
    for (const frame of frames) {
      client.send(frame);
      await expect(client.waitForError("dependency_unavailable", frame.requestId))
        .resolves.toMatchObject({
          frame: {
            type: "error",
            status: 503,
            code: "dependency_unavailable",
            message: "dependency_unavailable",
            requestId: frame.requestId,
          },
        });
    }
  });

  it("routes closed Message Authority vNext frames with server-derived session authority", async () => {
    const acceptedMessage = {
      id: "message-v2-1",
      roomId,
      authorId: "human-1",
      authorKind: "human" as const,
      createdAt: "2026-08-19T00:00:00.000Z",
      lifecycle: "active" as const,
      currentRevision: {
        messageId: "message-v2-1",
        revision: 1,
        body: "hello",
        revisedAt: "2026-08-19T00:00:00.000Z",
        revisedByActorId: "human-1",
      },
      revisionCount: 1,
      mentionedTargets: [],
      attachments: [{ attachmentId: "attachment-ready-1" }],
      targetOutcomes: [],
    };
    const submitHumanMessage = vi.fn(async () => ({
      messageId: "message-v2-1",
      persistedAt: "2026-08-19T00:00:00.000Z",
      targetOutcomes: [],
    }));
    const reviseHumanMessage = vi.fn(async () => ({
      messageId: "message-v2-1",
      revision: 2,
      persistedAt: "2026-08-19T00:01:00.000Z",
    }));
    const recallHumanMessage = vi.fn(async () => ({
      messageId: "message-v2-1",
      revision: 2,
      recalledAt: "2026-08-19T00:02:00.000Z",
    }));
    const readMessageHistory = vi.fn(async () => ({
      messages: [acceptedMessage],
      hasMore: false,
      lifecycle: "active" as const,
      actors: [
        { actorId: "human-1", kind: "human" as const, displayName: "Sam",
          secondaryLabel: "Owner" },
        { actorId: "agent-1", kind: "agent" as const, displayName: "Sam",
          secondaryLabel: "On-mention Agent" },
      ],
    }));
    const readMessageRevisions = vi.fn(async () => ({
      revisions: [acceptedMessage.currentRevision],
      hasMore: false,
    }));
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      messageAuthority: {
        submitHumanMessage,
        reviseHumanMessage,
        recallHumanMessage,
        readMessageHistory,
        readMessageRevisions,
      },
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0], "message-v2-login");
      client.send({
        type: "message.send.v2",
        requestId: "message-v2-send",
        message: {
          messageId: "message-v2-1",
          roomId,
          body: "hello",
          mentionedTargets: [],
          attachments: [{ attachmentId: "attachment-ready-1" }],
        },
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "message.accepted") &&
          frame.requestId === "message-v2-send" && Array.isArray(frame.targetOutcomes),
        "v2 message acceptance",
      )).resolves.toMatchObject({ frame: {
        type: "message.accepted",
        requestId: "message-v2-send",
        messageId: "message-v2-1",
        persistedAt: "2026-08-19T00:00:00.000Z",
        targetOutcomes: [],
      } });

      client.send({
        type: "message.revise", requestId: "message-v2-revise", roomId,
        messageId: "message-v2-1", expectedRevision: 1, body: "revised",
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "message.revision.accepted") &&
          frame.requestId === "message-v2-revise",
        "message revision acceptance",
      )).resolves.toMatchObject({ frame: {
        messageId: "message-v2-1", revision: 2,
        persistedAt: "2026-08-19T00:01:00.000Z",
      } });

      client.send({
        type: "room.history.v2", requestId: "message-v2-history", roomId, limit: 25,
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "room.history.v2") &&
          frame.requestId === "message-v2-history",
        "message v2 history",
      )).resolves.toMatchObject({ frame: {
        roomId, messages: [acceptedMessage], hasMore: false, lifecycle: "active",
        actors: [
          { actorId: "human-1", kind: "human", displayName: "Sam", secondaryLabel: "Owner" },
          { actorId: "agent-1", kind: "agent", displayName: "Sam",
            secondaryLabel: "On-mention Agent" },
        ],
      } });

      client.send({
        type: "message.revisions.query", requestId: "message-v2-revisions",
        roomId, messageId: "message-v2-1", limit: 25,
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "message.revisions") &&
          frame.requestId === "message-v2-revisions",
        "message revisions",
      )).resolves.toMatchObject({ frame: {
        roomId, messageId: "message-v2-1",
        revisions: [acceptedMessage.currentRevision], hasMore: false,
      } });

      client.send({
        type: "message.recall", requestId: "message-v2-recall", roomId,
        messageId: "message-v2-1", expectedRevision: 2,
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "message.recall.accepted") &&
          frame.requestId === "message-v2-recall",
        "message recall acceptance",
      )).resolves.toMatchObject({ frame: {
        messageId: "message-v2-1", revision: 2,
        recalledAt: "2026-08-19T00:02:00.000Z",
      } });

      expect(submitHumanMessage).toHaveBeenCalledWith({
        ...governanceSession,
        kind: "human",
        requestId: "message-v2-send",
        idempotencyKey: "message-v2-1",
      }, expect.objectContaining({
        messageId: "message-v2-1",
        roomId,
        attachments: [{ attachmentId: "attachment-ready-1" }],
      }));
      expect(reviseHumanMessage).toHaveBeenCalledTimes(1);
      expect(recallHumanMessage).toHaveBeenCalledTimes(1);
      expect(readMessageHistory).toHaveBeenCalledWith(
        governanceSession,
        { roomId, limit: 25 },
      );
      expect(readMessageRevisions).toHaveBeenCalledWith(
        governanceSession,
        { roomId, messageId: "message-v2-1", limit: 25 },
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails closed on malformed Message Authority dependency results", async () => {
    const malformedHumanMessage = {
      id: "message-v2-1",
      roomId: "another-room",
      authorId: "human-1",
      authorKind: "human" as const,
      createdAt: "2026-08-19T00:00:00.000Z",
      lifecycle: "active" as const,
      currentRevision: {
        messageId: "message-v2-1",
        revision: 1,
        body: "hello",
        revisedAt: "2026-08-19T00:00:00.000Z",
        revisedByActorId: "human-1",
      },
      revisionCount: 1,
      mentionedTargets: [],
      attachments: [],
      targetOutcomes: [],
    };
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      messageAuthority: {
        async submitHumanMessage() {
          return {
            messageId: "message-v2-1",
            persistedAt: "2026-08-19T00:00:00.000Z",
            targetOutcomes: [{
              targetId: "wrong-target",
              targetActorId: "agent-1",
              kind: "agent-invocation",
              status: "invocation-intent-created",
              invocationIntentId: "intent-1",
            }],
          };
        },
        async reviseHumanMessage() {
          return {
            messageId: "message-v2-1",
            revision: 3,
            persistedAt: "2026-08-19T00:01:00.000Z",
          };
        },
        async recallHumanMessage() {
          return {
            messageId: "message-v2-1",
            revision: 2,
            recalledAt: "2026-08-19T00:02:00.000Z",
          };
        },
        async readMessageHistory() {
          return { messages: [malformedHumanMessage], hasMore: false };
        },
        async readMessageRevisions() {
          return {
            revisions: [
              { ...malformedHumanMessage.currentRevision, revision: 2 },
              { ...malformedHumanMessage.currentRevision, revision: 2 },
            ],
            hasMore: false,
          };
        },
      },
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0], "message-v2-malformed-login");
      const frames = [
        {
          type: "message.send.v2", requestId: "message-v2-malformed-send",
          message: {
            messageId: "message-v2-1", roomId, body: "@Ada",
            mentionedTargets: [{
              id: "target-1", kind: "agent-invocation",
              targetActorId: "agent-1", range: { startUtf16: 0, endUtf16: 4 },
            }],
            attachments: [],
          },
        },
        {
          type: "message.revise", requestId: "message-v2-malformed-revise", roomId,
          messageId: "message-v2-1", expectedRevision: 1, body: "revised",
        },
        {
          type: "message.recall", requestId: "message-v2-malformed-recall", roomId,
          messageId: "message-v2-1", expectedRevision: 1,
        },
        {
          type: "room.history.v2", requestId: "message-v2-malformed-history", roomId,
          limit: 25,
        },
        {
          type: "message.revisions.query",
          requestId: "message-v2-malformed-revisions", roomId,
          messageId: "message-v2-1", afterRevision: 1, limit: 25,
        },
      ] as const;
      for (const frame of frames) {
        client.send(frame);
        await expect(client.waitForError("dependency_unavailable", frame.requestId))
          .resolves.toMatchObject({ frame: { status: 503 } });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("maps the approved Message Authority error family without leaking causes", async () => {
    const errors = [
      ["invalid_message", 400],
      ["mention_entity_invalid", 400],
      ["author_fields_forbidden", 400],
      ["attachment_feature_unavailable", 400],
      ["room_forbidden", 403],
      ["reply_target_not_found", 404],
      ["message_version_conflict", 409],
      ["message_recalled", 409],
      ["agent_final_immutable", 409],
      ["protocol_upgrade_required", 410],
      ["dependency_unavailable", 503],
    ] as const;
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      messageAuthority: {
        async submitHumanMessage() { return undefined; },
        async reviseHumanMessage(_context, input) {
          const [code, status] = errors[Number(input.body)];
          throw Object.assign(new Error("message-authority-private-cause"), {
            code, status, secret: "message-authority-private-secret",
          });
        },
        async recallHumanMessage() { return undefined; },
        async readMessageHistory() { return undefined; },
        async readMessageRevisions() { return undefined; },
      },
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0], "message-v2-errors-login");
      for (const [index, [code, status]] of errors.entries()) {
        const requestId = `message-v2-error-${index}`;
        client.send({
          type: "message.revise", requestId, roomId,
          messageId: "message-v2-1", expectedRevision: 1, body: String(index),
        });
        const received = await client.waitForError(code, requestId);
        expect(received.frame).toMatchObject({ status, code, message: code, requestId });
        expect(JSON.stringify(received.frame)).not.toContain("message-authority-private");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("closes an inbound frame larger than 64 KiB", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const client = await fixture.connect();

    client.sendRaw("x".repeat(64 * 1_024 + 1));

    await expect(client.waitForClose()).resolves.toBeUndefined();
  });

  it("terminates at the aggregate queued-frame count bound without later side effects", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "queued-count-bound");
    const loginStarted = deferred<void>();
    const login = deferred<IssuedSession>();
    const terminationCalled = deferred<void>();
    const originalTerminate = WebSocket.prototype.terminate;
    let terminateCalls = 0;
    let sendCalls = 0;
    let historyCalls = 0;
    let subscribeCalls = 0;
    const auth: AuthenticationService = {
      login() {
        loginStarted.resolve();
        return login.promise;
      },
      async authenticate() {
        return principal;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        sendCalls += 1;
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        subscribeCalls += 1;
        return () => undefined;
      },
      async history() {
        historyCalls += 1;
        return [];
      },
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      maxQueuedFrameCount: 3,
      maxQueuedFrameBytes: 1_024 * 1_024,
    });
    const client = await LoopbackClient.connect(server.url);

    WebSocket.prototype.terminate = function terminateWithoutClosing() {
      terminateCalls += 1;
      terminationCalled.resolve();
    };
    try {
      client.send({
        type: "auth.login",
        requestId: "count-bound-login",
        accountId: principal.accountId,
        secret: "correct-secret",
        device: testLoginDevice,
      });
      await loginStarted.promise;
      client.send({
        type: "message.send",
        requestId: "count-queued-send",
        message: draftFor("count-queued-message"),
      });
      client.send({ type: "room.subscribe", requestId: "count-queued-subscribe", roomId });
      client.send({ type: "room.history", requestId: "count-overflow", roomId });
      client.send({ type: "room.history", requestId: "count-after-overflow", roomId });

      await settlesWithin(terminationCalled.promise, 250);
      login.resolve(session);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(terminateCalls).toBe(1);
      expect(sendCalls).toBe(0);
      expect(historyCalls).toBe(0);
      expect(subscribeCalls).toBe(0);
    } finally {
      WebSocket.prototype.terminate = originalTerminate;
      login.resolve(session);
      await client.close();
      await server.close();
    }
  });

  it("terminates at the aggregate queued-byte bound with only a few large frames", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "queued-byte-bound");
    const loginStarted = deferred<void>();
    const login = deferred<IssuedSession>();
    const terminationCalled = deferred<void>();
    const originalTerminate = WebSocket.prototype.terminate;
    let terminateCalls = 0;
    let sendCalls = 0;
    const auth: AuthenticationService = {
      login() {
        loginStarted.resolve();
        return login.promise;
      },
      async authenticate() {
        return principal;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        sendCalls += 1;
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        return () => undefined;
      },
      async history() {
        return [];
      },
    };
    const loginFrame = JSON.stringify({
      type: "auth.login",
      requestId: "byte-bound-login",
      accountId: principal.accountId,
      secret: "correct-secret",
      device: testLoginDevice,
    });
    const largeFrame = JSON.stringify({
      type: "message.send",
      requestId: "byte-queued-send",
      message: {
        ...draftFor("byte-queued-message"),
        body: "x".repeat(32 * 1_024),
      },
    });
    const maxQueuedFrameBytes =
      Buffer.byteLength(loginFrame) + Buffer.byteLength(largeFrame);
    const server = await startMessageWebSocketServer({
      auth,
      service,
      maxQueuedFrameCount: 10,
      maxQueuedFrameBytes,
    });
    const client = await LoopbackClient.connect(server.url);

    WebSocket.prototype.terminate = function terminateWithoutClosing() {
      terminateCalls += 1;
      terminationCalled.resolve();
    };
    try {
      client.sendRaw(loginFrame);
      await loginStarted.promise;
      client.sendRaw(largeFrame);
      client.sendRaw(largeFrame.replace("byte-queued-message", "byte-overflow-message"));

      await settlesWithin(terminationCalled.promise, 250);
      login.resolve(session);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(terminateCalls).toBe(1);
      expect(sendCalls).toBe(0);
    } finally {
      WebSocket.prototype.terminate = originalTerminate;
      login.resolve(session);
      await client.close();
      await server.close();
    }
  });

  it("terminates a socket before sending when its outbound buffer reaches the configured bound", async () => {
    const fixture = await createFixture({ maxBufferedAmountBytes: 0 });
    fixtures.push(fixture);
    const client = await fixture.connect();

    client.sendRaw("{not-json");

    await expect(client.waitForClose()).resolves.toBeUndefined();
  });

  it("terminates before sending one outbound frame larger than the configured bound", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "oversized-outbound");
    let historyCalls = 0;
    let sendCalls = 0;
    let subscribeCalls = 0;
    const auth: AuthenticationService = {
      async login() {
        return session;
      },
      async authenticate() {
        return principal;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        sendCalls += 1;
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        subscribeCalls += 1;
        return () => undefined;
      },
      async history() {
        historyCalls += 1;
        return [
          {
            ...messageFor(humans[0], "oversized-history-message"),
            body: "界".repeat(512),
          },
        ];
      },
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      maxBufferedAmountBytes: 512,
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({ type: "room.history", requestId: "oversized-history", roomId });
      client.send({
        type: "message.send",
        requestId: "queued-after-oversized-history",
        message: draftFor("queued-after-oversized-history"),
      });
      client.send({
        type: "room.subscribe",
        requestId: "subscribe-after-oversized-history",
        roomId,
      });

      await expect(client.waitForClose()).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(historyCalls).toBe(1);
      expect(sendCalls).toBe(0);
      expect(subscribeCalls).toBe(0);
      expect(client.historyFrames("oversized-history")).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sends an outbound frame whose UTF-8 payload exactly equals the configured bound", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "exact-outbound");
    const authenticated = {
      type: "auth.authenticated",
      requestId: "exact-outbound-login",
      accountId: principal.accountId,
      actorId: principal.actorId,
      sessionId: session.sessionId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      refreshExpiresAt: session.refreshExpiresAt,
    } as const;
    const auth: AuthenticationService = {
      async login() {
        return session;
      },
      async authenticate() {
        return principal;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        return () => undefined;
      },
      async history() {
        return [];
      },
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      maxBufferedAmountBytes: Buffer.byteLength(JSON.stringify(authenticated), "utf8"),
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      client.send({
        type: "auth.login",
        requestId: authenticated.requestId,
        accountId: principal.accountId,
        secret: "correct-secret",
        device: testLoginDevice,
      });

      await expect(client.waitForAuthentication(authenticated.requestId)).resolves.toMatchObject({
        frame: authenticated,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("aborts queued actions synchronously before an outbound-bound termination", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "outbound-abort");
    const terminationCalled = deferred<void>();
    const originalTerminate = WebSocket.prototype.terminate;
    let terminateCalls = 0;
    let sendCalls = 0;
    let persistedMessages = 0;
    let historyCalls = 0;
    let subscribeCalls = 0;
    let activeSubscriptions = 0;
    let unsubscribeCalls = 0;
    const auth: AuthenticationService = {
      async login() {
        return session;
      },
      async authenticate() {
        return principal;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        sendCalls += 1;
        persistedMessages += 1;
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        subscribeCalls += 1;
        activeSubscriptions += 1;
        return () => {
          activeSubscriptions -= 1;
          unsubscribeCalls += 1;
        };
      },
      async history() {
        historyCalls += 1;
        return [];
      },
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      maxBufferedAmountBytes: 0,
    });
    const client = await LoopbackClient.connect(server.url);

    WebSocket.prototype.terminate = function terminateWithoutClosing() {
      terminateCalls += 1;
      terminationCalled.resolve();
    };
    try {
      client.send({
        type: "auth.login",
        requestId: "terminate-login",
        accountId: principal.accountId,
        secret: "correct-secret",
        device: testLoginDevice,
      });
      client.send({
        type: "message.send",
        requestId: "queued-send",
        message: draftFor("queued-after-terminate"),
      });
      client.send({ type: "room.history", requestId: "queued-history", roomId });
      client.send({ type: "room.subscribe", requestId: "queued-subscribe", roomId });

      await terminationCalled.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(terminateCalls).toBe(1);
      expect(sendCalls).toBe(0);
      expect(persistedMessages).toBe(0);
      expect(historyCalls).toBe(0);
      expect(subscribeCalls).toBe(0);
      expect(activeSubscriptions).toBe(0);
      expect(unsubscribeCalls).toBe(0);
    } finally {
      WebSocket.prototype.terminate = originalTerminate;
      await client.close();
      await server.close();
    }
  });

  it("aborts queued actions when an outbound send throws synchronously", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "send-failure-abort");
    const loginStarted = deferred<void>();
    const login = deferred<IssuedSession>();
    const originalSend = WebSocket.prototype.send;
    const originalTerminate = WebSocket.prototype.terminate;
    let terminateCalls = 0;
    let sendCalls = 0;
    let historyCalls = 0;
    let subscribeCalls = 0;
    const auth: AuthenticationService = {
      login() {
        loginStarted.resolve();
        return login.promise;
      },
      async authenticate() {
        return principal;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        sendCalls += 1;
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        subscribeCalls += 1;
        return () => undefined;
      },
      async history() {
        historyCalls += 1;
        return [];
      },
    };
    const server = await startMessageWebSocketServer({ auth, service });
    const client = await LoopbackClient.connect(server.url);

    try {
      client.send({
        type: "auth.login",
        requestId: "throwing-login",
        accountId: principal.accountId,
        secret: "correct-secret",
        device: testLoginDevice,
      });
      client.send({
        type: "message.send",
        requestId: "queued-send",
        message: draftFor("queued-after-send-failure"),
      });
      client.send({ type: "room.history", requestId: "queued-history", roomId });
      client.send({ type: "room.subscribe", requestId: "queued-subscribe", roomId });
      await loginStarted.promise;

      WebSocket.prototype.send = function throwOnSend() {
        throw new Error("injected synchronous send failure");
      };
      WebSocket.prototype.terminate = function terminateWithoutClosing() {
        terminateCalls += 1;
      };
      login.resolve(session);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(terminateCalls).toBe(1);
      expect(sendCalls).toBe(0);
      expect(historyCalls).toBe(0);
      expect(subscribeCalls).toBe(0);
    } finally {
      WebSocket.prototype.send = originalSend;
      WebSocket.prototype.terminate = originalTerminate;
      login.resolve(session);
      await client.close();
      await server.close();
    }
  });

  it("returns 401 for each pre-auth action and 403 for each authenticated non-member action", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const client = await fixture.connect();
    const actions = [
      { type: "message.send", requestId: "preauth-send", message: draftFor("preauth") },
      { type: "room.history", requestId: "preauth-history", roomId },
      { type: "room.subscribe", requestId: "preauth-subscribe", roomId },
    ] as const;

    for (const action of actions) {
      client.send(action);
      await expect(client.waitForError("unauthenticated", action.requestId)).resolves.toMatchObject({
        frame: { status: 401 },
      });
    }

    await client.login(outsider);
    for (const action of actions) {
      const requestId = action.requestId.replace("preauth", "forbidden");
      client.send({ ...action, requestId });
      await expect(client.waitForError("room_forbidden", requestId)).resolves.toMatchObject({
        frame: { status: 403 },
      });
    }
  });

  it("rejects forged authorId and authorKind with 401 and persists nothing", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const client = await fixture.connect();
    await client.login(humans[0]);

    for (const [requestId, field] of [
      ["forged-author-id", { authorId: humans[1].id }],
      ["forged-author-kind", { authorKind: "agent" }],
    ] as const) {
      client.send({
        type: "message.send",
        requestId,
        message: { ...draftFor(requestId), ...field },
      });
      await expect(client.waitForError("identity_forbidden", requestId)).resolves.toMatchObject({
        frame: { status: 401 },
      });
    }
    await expect(fixture.messages()).resolves.toEqual([]);
  });

  it("derives identities for two independent accounts and correlates persisted acknowledgements", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const lionel = await fixture.connect();
    const ada = await fixture.connect();
    await Promise.all([lionel.login(humans[0]), ada.login(humans[1])]);
    await Promise.all([lionel.subscribe(roomId), ada.subscribe(roomId)]);

    const lionelDraft = draftFor("message-lionel");
    const adaDraft = draftFor("message-ada");
    lionel.send({ type: "message.send", requestId: "transport-lionel", message: lionelDraft });
    await expect(lionel.waitForAcceptance(lionelDraft.id)).resolves.toMatchObject({
      frame: {
        type: "message.accepted",
        requestId: "transport-lionel",
        messageId: lionelDraft.id,
      },
    });
    await ada.sendDraft(adaDraft);
    await Promise.all([
      lionel.waitForMessage(adaDraft.id),
      ada.waitForMessage(lionelDraft.id),
    ]);

    await expect(fixture.messages()).resolves.toEqual([
      messageFor(humans[0], lionelDraft.id),
      messageFor(humans[1], adaDraft.id),
    ]);
  });

  it("acknowledges exact replay once and rejects cross-author message ID reuse", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const lionel = await fixture.connect();
    const ada = await fixture.connect();
    await Promise.all([lionel.login(humans[0]), ada.login(humans[1])]);
    await ada.subscribe(roomId);
    const message = draftFor("transport-idempotent-message");

    await lionel.sendDraft(message, "first-send");
    await ada.waitForMessage(message.id);
    await lionel.sendDraft(message, "exact-replay");
    ada.send({ type: "message.send", requestId: "cross-author-id", message });
    await expect(ada.waitForError("message_id_conflict", "cross-author-id")).resolves.toMatchObject({
      frame: { status: 409 },
    });

    expect(ada.frameCount((frame) => hasMessageCreated(frame, message.id))).toBe(1);
    await expect(fixture.messages()).resolves.toEqual([messageFor(humans[0], message.id)]);
  });

  it("delivers one persisted message to three subscribed authenticated clients within one second", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const clients = await Promise.all([fixture.connect(), fixture.connect(), fixture.connect()]);
    await Promise.all(clients.map((client, index) => client.login(humans[index]!)));
    await Promise.all(clients.map((client) => client.subscribe(roomId)));

    const message = draftFor("message-three-client-fanout");
    const sentAt = Date.now();
    await clients[0]!.sendDraft(message);
    const receivedBySecond = await clients[1]!.waitForMessage(message.id);
    const receivedByThird = await clients[2]!.waitForMessage(message.id);

    expect(receivedBySecond.receivedAt - sentAt).toBeLessThan(1_000);
    expect(receivedByThird.receivedAt - sentAt).toBeLessThan(1_000);
    await expect(fixture.messages()).resolves.toEqual([messageFor(humans[0], message.id)]);
  });

  it("converges one Context dispute across three authenticated Memory Authority clients", async () => {
    const createdAt = "2026-08-20T00:00:00.000Z";
    let disputedBy: string | undefined;
    const projection = () => ({
      projectionKind: "memory" as const,
      roomId,
      memoryRecordId: "memory-context-1",
      kind: "context" as const,
      currentVersion: {
        roomId,
        memoryRecordId: "memory-context-1",
        memoryVersionId: disputedBy === undefined ? "memory-version-1" : "memory-version-2",
        version: disputedBy === undefined ? 1 : 2,
        kind: "context" as const,
        state: disputedBy === undefined ? "active" as const : "disputed" as const,
        derivedText: "Launch is Friday.",
        sourceRefs: [{ sourceKind: "message" as const, sourceId: "message:source-1",
          sourceRevision: 1, eligibility: "eligible" as const, availability: "readable" as const }],
        createdAt,
        replacesMemoryVersionId: disputedBy === undefined ? null : "memory-version-1",
      },
      disputes: disputedBy === undefined ? [] : [{ disputeId: "memory-dispute-1", roomId,
        memoryRecordId: "memory-context-1", memoryVersionId: "memory-version-2",
        operatorActorId: disputedBy, reason: "The date changed", status: "open" as const,
        createdAt }],
      resolutions: [],
    });
    const status = { roomId, health: { state: "healthy" as const, reason: "none" as const,
      memoryWatermark: 1, corpusHead: 1, lag: 0, lastAttemptAt: createdAt,
      retryable: false, recoveryRequired: false }, recoveryGeneration: 0, updatedAt: createdAt };
    const memoryAuthority: RoomMemoryAuthorityTransport = {
      async execute(context, request) {
        if (request.type === "room.memory.context.dispute.v1") {
          expect(Reflect.ownKeys(request)).not.toContain("actorId");
          disputedBy = context.principal.actorId;
          return { type: "room.memory.context.dispute.accepted.v1",
            requestId: request.requestId, roomId, dispute: projection().disputes[0]!,
            projection: projection() };
        }
        if (request.type === "room.memory.query.v1") return {
          type: "room.memory.page.v1", requestId: request.requestId, roomId,
          items: [projection()], nextCursor: null, status,
        };
        return { type: "room.memory.status.v1", requestId: request.requestId,
          roomId, status };
      },
    };
    const fixture = await createFixture({ memoryAuthority });
    fixtures.push(fixture);
    const clients = await Promise.all([fixture.connect(), fixture.connect(), fixture.connect()]);
    await Promise.all(clients.map((client, index) => client.login(humans[index]!)));
    clients[1]!.send({ type: "room.memory.context.dispute.v1", requestId: "dispute-device-2",
      roomId, memoryRecordId: "memory-context-1", expectedVersion: 1,
      reason: "The date changed" });
    await clients[1]!.waitForFrame((frame) => hasType(
      frame,
      "room.memory.context.dispute.accepted.v1",
    ), "memory dispute acknowledgement");
    clients[0]!.send({ type: "room.memory.query.v1", requestId: "memory-query-device-1",
      roomId, limit: 50 });
    clients[2]!.send({ type: "room.memory.query.v1", requestId: "memory-query-device-3",
      roomId, limit: 50 });
    const converged = await Promise.all([
      clients[0]!.waitForFrame((frame) => hasType(frame, "room.memory.page.v1") &&
        frame.requestId === "memory-query-device-1", "device one memory projection"),
      clients[2]!.waitForFrame((frame) => hasType(frame, "room.memory.page.v1") &&
        frame.requestId === "memory-query-device-3", "device three memory projection"),
    ]);
    for (const received of converged) {
      expect(received.frame).toMatchObject({ items: [{ currentVersion: { state: "disputed" },
        disputes: [{ operatorActorId: humans[1].id }] }] });
    }
  });

  it("registers live delivery before the history snapshot without a history/live gap", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const existingClient = await fixture.connect();
    await existingClient.login(humans[0]);
    await existingClient.subscribe(roomId);

    const raceDraft = draftFor("message-race-1");
    fixture.setSubscriptionRace(async () => {
      await existingClient.sendDraft(raceDraft);
    });

    const joiningClient = await fixture.connect();
    await joiningClient.login(humans[1]);
    const history = await joiningClient.subscribe(roomId, "subscribe-race");
    const created = await joiningClient.waitForMessage(raceDraft.id);

    expect(joiningClient.messages(roomId).filter((message) => message.id === raceDraft.id)).toEqual([
      messageFor(humans[0], raceDraft.id),
    ]);
    expect(joiningClient.frameIndex((frame) => hasMessageCreated(frame, raceDraft.id))).toBeLessThan(
      joiningClient.frameIndex((frame) => frame === history.frame),
    );
    expect(created.receivedAt).toBeLessThanOrEqual(history.receivedAt);
  });

  it("keeps one-shot history separate from live subscription and avoids duplicate listeners", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const historyOnly = await fixture.connect();
    const subscriber = await fixture.connect();
    const sender = await fixture.connect();
    await Promise.all([
      historyOnly.login(humans[0]),
      subscriber.login(humans[1]),
      sender.login(humans[2]),
    ]);

    await historyOnly.history(roomId, "history-only");
    await subscriber.subscribe(roomId, "subscribe-first");
    await subscriber.subscribe(roomId, "subscribe-repeated");
    const message = draftFor("message-single-listener");
    await sender.sendDraft(message);
    await subscriber.waitForMessage(message.id);

    await expect(historyOnly.waitForMessage(message.id, 100)).rejects.toThrow("Timed out");
    expect(subscriber.frameCount((frame) => hasMessageCreated(frame, message.id))).toBe(1);
    expect(
      subscriber.messages(roomId).filter((candidate) => candidate.id === message.id),
    ).toHaveLength(1);
  });

  it("keeps WebSocket sessions human-only while the trusted service can author agent messages", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const agentClient = await fixture.connect();
    agentClient.send({
      type: "auth.login",
      requestId: "agent-login",
      accountId: `account-${agents[0].id}`,
      secret: `secret-${agents[0].id}`,
      device: testLoginDevice,
    });
    await expect(agentClient.waitForError("identity_forbidden", "agent-login")).resolves.toMatchObject({
      frame: { status: 403 },
    });

    const clients = await Promise.all(humans.map(() => fixture.connect()));
    await Promise.all(clients.map((client, index) => client.login(humans[index]!)));
    await Promise.all(clients.map((client) => client.subscribe(roomId)));
    const configuredAgents = agents.filter((agent) => agent.toolPermissions.length > 0);

    for (const [index, human] of humans.entries()) {
      await clients[index]!.sendDraft(draftFor(`message-${human.kind}-${index + 1}`));
    }
    for (const [index, agent] of configuredAgents.entries()) {
      await fixture.service().send(agent.id, draftFor(`message-${agent.kind}-${index + 1}`));
    }

    const historyClient = await fixture.connect();
    await historyClient.login(humans[0]);
    await historyClient.history(roomId, "all-actors-history");
    const history = historyClient.messages(roomId);

    expect(history).toHaveLength(6);
    expect(history.filter((message) => message.authorKind === "human")).toHaveLength(3);
    expect(history.filter((message) => message.authorKind === "agent")).toHaveLength(3);
  });

  it("resumes after durable restart and rejects a revoked access token with 403", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const firstClient = await fixture.connect();
    const session = await firstClient.login(humans[0]);
    expect(session.accessToken).toBeTypeOf("string");

    await fixture.restartServer();
    const resumed = await fixture.connect();
    await expect(resumed.resume(session.accessToken!, "restart-resume")).resolves.toMatchObject({
      frame: {
        type: "auth.authenticated",
        requestId: "restart-resume",
        actorId: humans[0].id,
        sessionId: session.sessionId,
      },
    });
    await resumed.revoke("restart-revoke");

    const rejected = await fixture.connect();
    rejected.send({
      type: "auth.resume",
      requestId: "resume-revoked",
      accessToken: session.accessToken,
    });
    await expect(rejected.waitForError("session_revoked", "resume-revoked")).resolves.toMatchObject({
      frame: { status: 403 },
    });
  });

  it("revalidates sessions before actions and live delivery after external revocation", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const subscribed = await fixture.connect();
    const revoker = await fixture.connect();
    const sender = await fixture.connect();
    const session = await subscribed.login(humans[0]);
    await subscribed.subscribe(roomId);
    await revoker.resume(session.accessToken!, "shared-resume");
    await sender.login(humans[1]);

    await revoker.revoke("external-revoke");
    subscribed.send({ type: "room.history", requestId: "revoked-action", roomId });
    await expect(subscribed.waitForError("session_revoked", "revoked-action")).resolves.toMatchObject({
      frame: { status: 403 },
    });
    const laterMessage = draftFor("message-after-external-revoke");
    await sender.sendDraft(laterMessage);

    await expect(subscribed.waitForMessage(laterMessage.id, 100)).rejects.toThrow("Timed out");
  });

  it("maps expired access to 401 and clears live subscriptions", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const expired = await fixture.connect();
    const sender = await fixture.connect();
    await expired.login(humans[0]);
    await expired.subscribe(roomId);
    fixture.advanceClock(1_001);

    expired.send({ type: "room.history", requestId: "expired-history", roomId });
    await expect(expired.waitForError("token_expired", "expired-history")).resolves.toMatchObject({
      frame: { status: 401 },
    });
    await sender.login(humans[1], "login-valid-sender");
    const laterMessage = draftFor("message-after-expiry");
    await sender.sendDraft(laterMessage);
    await expect(expired.waitForMessage(laterMessage.id, 100)).rejects.toThrow("Timed out");
    await expect(fixture.messages()).resolves.toEqual([messageFor(humans[1], laterMessage.id)]);
  });

  it("refreshes an authenticated socket after its access token expires", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const expiredSession = issuedSession(principal, "expired-access");
    const refreshedSession = issuedSession(principal, "refreshed-access");
    let accessExpired = false;
    const auth: AuthenticationService = {
      async login() {
        return expiredSession;
      },
      async authenticate(accessToken) {
        if (accessToken === expiredSession.accessToken && accessExpired) {
          throw new AuthenticationError(401, "token_expired");
        }
        return principal;
      },
      async refresh(refreshToken, expectedPrincipal) {
        expect(refreshToken).toBe(expiredSession.refreshToken);
        expect(expectedPrincipal).toEqual(principal);
        return refreshedSession;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        return () => undefined;
      },
      async history() {
        return [];
      },
    };
    const server = await startMessageWebSocketServer({ auth, service });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      accessExpired = true;

      await expect(
        client.refresh(expiredSession.refreshToken, "refresh-expired-access"),
      ).resolves.toMatchObject({
        frame: {
          type: "auth.authenticated",
          requestId: "refresh-expired-access",
          actorId: humans[0].id,
          accessToken: refreshedSession.accessToken,
        },
      });
      await expect(client.history(roomId, "history-after-expired-refresh")).resolves.toMatchObject({
        frame: { type: "room.history", requestId: "history-after-expired-refresh" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("authenticates a fresh socket from a still-valid refresh token", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const originalSession = issuedSession(principal, "fresh-original");
    const refreshedSession = issuedSession(principal, "fresh-refreshed");
    const auth: AuthenticationService = {
      async login() {
        return originalSession;
      },
      async authenticate() {
        return principal;
      },
      async refresh(refreshToken, expectedPrincipal) {
        expect(refreshToken).toBe(originalSession.refreshToken);
        expect(expectedPrincipal).toBeUndefined();
        return refreshedSession;
      },
      async revoke() {},
    };
    const service: MessageService = {
      async send(_actorId, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        return () => undefined;
      },
      async history() {
        return [];
      },
    };
    const server = await startMessageWebSocketServer({ auth, service });
    const fresh = await LoopbackClient.connect(server.url);

    try {
      await expect(
        fresh.refresh(originalSession.refreshToken, "refresh-fresh-socket"),
      ).resolves.toMatchObject({
        frame: {
          type: "auth.authenticated",
          requestId: "refresh-fresh-socket",
          actorId: humans[0].id,
          accessToken: refreshedSession.accessToken,
        },
      });
      await expect(fresh.history(roomId, "history-after-fresh-refresh")).resolves.toMatchObject({
        frame: { type: "room.history", requestId: "history-after-fresh-refresh" },
      });
    } finally {
      await fresh.close();
      await server.close();
    }
  });

  it("keeps refresh bound to the current actor and rotates the socket credential", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const lionel = await fixture.connect();
    const ada = await fixture.connect();
    const lionelSession = await lionel.login(humans[0]);
    const adaSession = await ada.login(humans[1]);

    lionel.send({
      type: "auth.refresh",
      requestId: "cross-session-refresh",
      refreshToken: adaSession.refreshToken,
    });
    await expect(
      lionel.waitForError("identity_forbidden", "cross-session-refresh"),
    ).resolves.toMatchObject({
      frame: { status: 403 },
    });

    await expect(lionel.history(roomId, "lionel-after-cross-refresh")).resolves.toMatchObject({
      frame: { type: "room.history", requestId: "lionel-after-cross-refresh" },
    });
    await expect(ada.history(roomId, "ada-after-cross-refresh")).resolves.toMatchObject({
      frame: { type: "room.history", requestId: "ada-after-cross-refresh" },
    });
    await expect(ada.refresh(adaSession.refreshToken!, "ada-own-refresh")).resolves.toMatchObject({
      frame: { type: "auth.authenticated", actorId: humans[1].id },
    });

    const refreshed = await lionel.refresh(lionelSession.refreshToken!, "own-refresh");
    expect(refreshed.frame).toMatchObject({ actorId: humans[0].id });
    expect((refreshed.frame as SessionFrame).accessToken).not.toBe(lionelSession.accessToken);
    await lionel.sendDraft(draftFor("message-after-refresh"));
    await expect(fixture.messages()).resolves.toEqual([
      messageFor(humans[0], "message-after-refresh"),
    ]);
  });

  it.each(["message.send", "room.history", "room.subscribe"] as const)(
    "serializes a deferred %s before a later refresh and uses the new credential next",
    async (actionType) => {
      const principal = { accountId: "account-human-1", actorId: humans[0].id };
      const oldSession = issuedSession(principal, "serial-old");
      const newSession = issuedSession(principal, "serial-new");
      const actionGate = deferred<void>();
      const authenticatedTokens: string[] = [];
      const auth: AuthenticationService = {
        async login() {
          return oldSession;
        },
        async authenticate(accessToken) {
          authenticatedTokens.push(accessToken);
          return principal;
        },
        async refresh() {
          return newSession;
        },
        async revoke() {},
      };
      let actionReleased = false;
      const service: MessageService = {
        async send(_actorId, message) {
          if (actionType === "message.send" && !actionReleased) {
            await actionGate.promise;
          }
          return {
            type: "message.accepted",
            requestId: message.id,
            messageId: message.id,
            persistedAt: "2026-08-10T00:00:00.000Z",
          };
        },
        subscribe() {
          return () => undefined;
        },
        async history() {
          if (actionType === "room.history" && !actionReleased) {
            await actionGate.promise;
          }
          return [];
        },
      };
      const server = await startMessageWebSocketServer({
        auth,
        service,
        afterSubscribeRegistered:
          actionType === "room.subscribe"
            ? async () => {
                if (!actionReleased) {
                  await actionGate.promise;
                }
              }
            : undefined,
      });
      const client = await LoopbackClient.connect(server.url);
      const actionRequestId = `deferred-${actionType}`;

      try {
        await client.login(humans[0]);
        if (actionType === "message.send") {
          client.send({
            type: actionType,
            requestId: actionRequestId,
            message: draftFor("serial-action-message"),
          });
        } else {
          client.send({ type: actionType, requestId: actionRequestId, roomId });
        }
        client.send({
          type: "auth.refresh",
          requestId: "queued-refresh",
          refreshToken: oldSession.refreshToken,
        });

        await expect(client.waitForAuthentication("queued-refresh", 100)).rejects.toThrow(
          "Timed out",
        );
        actionReleased = true;
        actionGate.resolve();
        if (actionType === "message.send") {
          await client.waitForAcceptance("serial-action-message");
        } else {
          await client.waitForHistory(actionRequestId);
        }
        const refreshed = await client.waitForAuthentication("queued-refresh");
        expect(refreshed.frame).toMatchObject({ accessToken: newSession.accessToken });

        await client.history(roomId, "after-serialized-refresh");
        expect(authenticatedTokens.at(-1)).toBe(newSession.accessToken);
      } finally {
        actionReleased = true;
        actionGate.resolve();
        await client.close();
        await server.close();
      }
    },
  );

  it("does not let a failed live check for an old credential clear a refreshed session", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const oldSession = issuedSession(principal, "live-old");
    const newSession = issuedSession(principal, "live-new");
    const oldLiveAuthentication = deferred<AuthenticatedPrincipal>();
    let oldAuthenticationCalls = 0;
    const auth: AuthenticationService = {
      async login() {
        return oldSession;
      },
      authenticate(accessToken) {
        if (accessToken === newSession.accessToken) {
          return Promise.resolve(principal);
        }
        oldAuthenticationCalls += 1;
        if (oldAuthenticationCalls === 2) {
          return oldLiveAuthentication.promise;
        }
        return Promise.resolve(principal);
      },
      async refresh() {
        return newSession;
      },
      async revoke() {},
    };
    let liveListener: ((message: Message) => void | Promise<void>) | undefined;
    const service: MessageService = {
      async send(_actorId, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe(_actorId, _targetRoomId, listener) {
        liveListener = listener;
        return () => {
          liveListener = undefined;
        };
      },
      async history() {
        return [];
      },
    };
    const server = await startMessageWebSocketServer({ auth, service });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      await client.subscribe(roomId);
      const liveDelivery = Promise.resolve(
        liveListener?.(messageFor(humans[1], "stale-live-message")),
      );

      await client.refresh(oldSession.refreshToken, "refresh-during-live-check");
      oldLiveAuthentication.reject(new AuthenticationError(401, "invalid_token"));
      await liveDelivery;

      await expect(client.history(roomId, "after-live-race")).resolves.toMatchObject({
        frame: { type: "room.history", requestId: "after-live-race" },
      });
      await expect(client.waitForMessage("stale-live-message", 100)).rejects.toThrow(
        "Timed out",
      );
    } finally {
      oldLiveAuthentication.reject(new AuthenticationError(401, "invalid_token"));
      await client.close();
      await server.close();
    }
  });

  it("aborts deferred authentication and queued frames when the socket closes", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "close-race");
    const authentication = deferred<AuthenticatedPrincipal>();
    const authenticationStarted = deferred<void>();
    const auth: AuthenticationService = {
      async login() {
        return session;
      },
      authenticate() {
        authenticationStarted.resolve();
        return authentication.promise;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    let subscribeCalls = 0;
    let historyCalls = 0;
    let unsubscribeCalls = 0;
    const service: MessageService = {
      async send(_actorId, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        subscribeCalls += 1;
        return () => {
          unsubscribeCalls += 1;
        };
      },
      async history() {
        historyCalls += 1;
        return [];
      },
    };
    const server = await startMessageWebSocketServer({ auth, service });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({ type: "room.subscribe", requestId: "deferred-close", roomId });
      await authenticationStarted.promise;
      client.send({ type: "room.history", requestId: "queued-after-close", roomId });
      await client.close();
      await server.close();
      authentication.resolve(principal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(subscribeCalls).toBe(0);
      expect(historyCalls).toBe(0);
      expect(unsubscribeCalls).toBe(0);
    } finally {
      authentication.resolve(principal);
      await server.close();
    }
  });

  it("unsubscribes exactly once when close races a registered subscription", async () => {
    const principal = { accountId: "account-human-1", actorId: humans[0].id };
    const session = issuedSession(principal, "registered-close-race");
    const subscriptionRegistered = deferred<void>();
    const releaseSubscribeHandler = deferred<void>();
    const auth: AuthenticationService = {
      async login() {
        return session;
      },
      async authenticate() {
        return principal;
      },
      async refresh() {
        return session;
      },
      async revoke() {},
    };
    let activeSubscriptions = 0;
    let unsubscribeCalls = 0;
    let historyCalls = 0;
    const service: MessageService = {
      async send(_actorId, message) {
        return {
          type: "message.accepted",
          requestId: message.id,
          messageId: message.id,
          persistedAt: "2026-08-10T00:00:00.000Z",
        };
      },
      subscribe() {
        activeSubscriptions += 1;
        subscriptionRegistered.resolve();
        return () => {
          activeSubscriptions -= 1;
          unsubscribeCalls += 1;
        };
      },
      async history() {
        historyCalls += 1;
        return [];
      },
    };
    const server = await startMessageWebSocketServer({
      auth,
      service,
      afterSubscribeRegistered: () => releaseSubscribeHandler.promise,
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({ type: "room.subscribe", requestId: "registered-close", roomId });
      await subscriptionRegistered.promise;

      await client.close();
      await server.close();
      releaseSubscribeHandler.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(activeSubscriptions).toBe(0);
      expect(unsubscribeCalls).toBe(1);
      expect(historyCalls).toBe(0);
    } finally {
      releaseSubscribeHandler.resolve();
      await server.close();
    }
  });

  it("rejects login and resume on an authenticated socket without switching identity", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const client = await fixture.connect();
    const session = await client.login(humans[0]);

    client.send({
      type: "auth.login",
      requestId: "second-login",
      accountId: `account-${humans[1].id}`,
      secret: `secret-${humans[1].id}`,
      device: testLoginDevice,
    });
    await expect(client.waitForError("already_authenticated", "second-login")).resolves.toMatchObject({
      frame: { status: 409 },
    });
    client.send({
      type: "auth.resume",
      requestId: "second-resume",
      accessToken: session.accessToken,
    });
    await expect(client.waitForError("already_authenticated", "second-resume")).resolves.toMatchObject({
      frame: { status: 409 },
    });

    await client.sendDraft(draftFor("identity-still-owner"));
    await expect(fixture.messages()).resolves.toEqual([
      messageFor(humans[0], "identity-still-owner"),
    ]);
  });

  it("stops active delivery immediately when room membership is removed", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const removed = await fixture.connect();
    const ownerClient = await fixture.connect();
    await Promise.all([removed.login(humans[1]), ownerClient.login(humans[0])]);
    await removed.subscribe(roomId);

    await fixture.rooms().removeMember(humans[0].id, roomId, humans[1].id);
    const laterMessage = draftFor("message-after-member-removal");
    await ownerClient.sendDraft(laterMessage);

    await expect(removed.waitForMessage(laterMessage.id, 100)).rejects.toThrow("Timed out");
    for (const [type, payload] of [
      ["room.history", { roomId }],
      ["room.subscribe", { roomId }],
      ["message.send", { message: draftFor("removed-send") }],
    ] as const) {
      const requestId = `removed-${type}`;
      removed.send({ type, requestId, ...payload });
      await expect(removed.waitForError("room_forbidden", requestId)).resolves.toMatchObject({
        frame: { status: 403 },
      });
    }
  });

  it("closes the server without waiting for an active WebSocket client", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await fixture.connect();
    await expect(settlesWithin(fixture.closeServer(), 250)).resolves.toBeUndefined();
  });

  it("returns internal_error for a synchronous subscribe failure and continues processing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-subscribe-failure-"));
    const rooms = await createRoomLifecycleService({
      actors,
      state: createJsonStateStore(join(directory, "rooms.json"), isRoomLifecycleState),
      idFactory: sequenceFactory("room"),
      tokenFactory: sequenceFactory("invitation"),
    });
    await populateRoom(rooms);
    const auth = createAuthenticationService({
      actors: rooms,
      identities: identityAdapter,
      sessions: createJsonStateStore(join(directory, "sessions.json"), isSessionState),
    });
    const store = createJsonlMessageStore(join(directory, "messages.jsonl"));
    const stableService = createMessageService({ directory: rooms, store });
    let shouldThrowOnSubscribe = true;
    const service: MessageService = {
      send: (actorId, message) => stableService.send(actorId, message),
      subscribe: (actorId, targetRoomId, listener) => {
        if (shouldThrowOnSubscribe) {
          shouldThrowOnSubscribe = false;
          throw new Error("injected synchronous subscribe failure");
        }
        return stableService.subscribe(actorId, targetRoomId, listener);
      },
      history: (actorId, targetRoomId) => stableService.history(actorId, targetRoomId),
    };
    const server = await startMessageWebSocketServer({ auth, service });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({ type: "room.subscribe", requestId: "subscribe-failed", roomId });
      await expect(client.waitForError("internal_error", "subscribe-failed")).resolves.toMatchObject({
        frame: { status: 500 },
      });

      const subsequent = draftFor("message-after-subscribe-failure");
      await expect(client.sendDraft(subsequent)).resolves.toMatchObject({
        frame: { type: "message.accepted", messageId: subsequent.id },
      });
      await expect(store.list(roomId)).resolves.toEqual([messageFor(humans[0], subsequent.id)]);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes overlapping subscriptions in arrival order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-overlapping-subscribe-"));
    const rooms = await createRoomLifecycleService({
      actors,
      state: createJsonStateStore(join(directory, "rooms.json"), isRoomLifecycleState),
      idFactory: sequenceFactory("room"),
      tokenFactory: sequenceFactory("invitation"),
    });
    await populateRoom(rooms);
    const auth = createAuthenticationService({
      actors: rooms,
      identities: identityAdapter,
      sessions: createJsonStateStore(join(directory, "sessions.json"), isSessionState),
    });
    const historicalMessage = messageFor(humans[0], "message-before-subscribe");
    const storedMessages: Message[] = [historicalMessage];
    let listCalls = 0;
    let firstHistoryStarted: (() => void) | undefined;
    let releaseFirstHistory: (() => void) | undefined;
    const firstHistoryStartedPromise = new Promise<void>((resolve) => {
      firstHistoryStarted = resolve;
    });
    const firstHistoryReleasePromise = new Promise<void>((resolve) => {
      releaseFirstHistory = resolve;
    });
    const store: MessageStore = {
      async append(message) {
        storedMessages.push(message);
        return "appended" as const;
      },
      async list(targetRoomId): Promise<readonly Message[]> {
        listCalls += 1;
        if (listCalls === 1) {
          firstHistoryStarted?.();
          await firstHistoryReleasePromise;
        }
        return storedMessages.filter((message) => message.roomId === targetRoomId);
      },
    };
    const service = createMessageService({ directory: rooms, store });
    const server = await startMessageWebSocketServer({ auth, service });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0]);
      client.send({ type: "room.subscribe", requestId: "subscribe-obsolete", roomId });
      await firstHistoryStartedPromise;

      client.send({ type: "room.subscribe", requestId: "subscribe-current", roomId });
      await expect(client.waitForHistory("subscribe-current", 100)).rejects.toThrow(
        "Timed out",
      );

      releaseFirstHistory?.();
      const obsoleteHistory = await client.waitForHistory("subscribe-obsolete");
      const currentHistory = await client.waitForHistory("subscribe-current");
      expect(obsoleteHistory.frame).toMatchObject({
        type: "room.history",
        requestId: "subscribe-obsolete",
        messages: [historicalMessage],
      });
      expect(currentHistory.frame).toMatchObject({
        type: "room.history",
        requestId: "subscribe-current",
        messages: [historicalMessage],
      });
      expect(client.frameIndex((frame) => frame === obsoleteHistory.frame)).toBeLessThan(
        client.frameIndex((frame) => frame === currentHistory.frame),
      );
      expect(client.historyFrames("subscribe-obsolete")).toHaveLength(1);
      expect(client.historyFrames("subscribe-current")).toHaveLength(1);
    } finally {
      releaseFirstHistory?.();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const governancePrincipal = {
  accountId: "account-human-1",
  actorId: "human-1",
} as const;

const governanceSession = {
  sessionId: "governance-session",
  sessionFamilyId: "governance-family",
  principal: governancePrincipal,
} as const;

const governanceView: RoomGovernanceView = {
  roomId,
  projectId: roomId,
  lifecycle: "active",
  governanceRevision: 5,
  ownerActorId: "human-1",
  archiveGeneration: 0,
};

const departureConflictList: DepartureConflictList = {
  roomId,
  targetActorId: "human-2",
  governanceRevision: 4,
  conflicts: [{
    conflictId: "next-action:next-1:3",
    roomId,
    subjectId: "next-1",
    kind: "next_action",
    title: "待转交行动",
    state: "open",
    allowedResolutions: ["complete", "transfer", "escalate"],
    sourceId: "next-1",
    revision: 3,
  }],
};

function governanceAuthenticationService(): AuthenticationService {
  const issued = issuedSession(governancePrincipal, "governance");
  return {
    async login() { return issued; },
    async authenticate() { return governancePrincipal; },
    async authenticateSession() { return governanceSession; },
    async refresh() { return issued; },
    async revoke() {},
    async listSessions() {
      return [{
        id: issued.sessionId,
        deviceLabel: "Governance device",
        platform: "unknown",
        refreshExpiresAt: issued.refreshExpiresAt,
        current: true,
      }];
    },
    async revokeSession() {},
  };
}

describe("closed FT-02B/FT-02C WebSocket governance", () => {
  it.each(["direct_mention", "structured_help", "routed_candidate"] as const)(
    "closes legacy public agent.invoke %s with 410 and never calls runtime",
    async (kind) => {
      const invoke = vi.fn(async () => { throw new Error("legacy invoke must stay closed"); });
      const server = await startMessageWebSocketServer({
        auth: governanceAuthenticationService(),
        service: idleMessageService(),
        agentRuntime: {
          invoke,
          interrupt: vi.fn(),
          retry: vi.fn(),
          confirmTool: vi.fn(),
          compensate: vi.fn(),
          close: vi.fn(),
        } as never,
      });
      const client = await LoopbackClient.connect(server.url);
      try {
        await client.login(humans[0], `legacy-invoke-login-${kind}`);
        client.send({
          type: "agent.invoke",
          requestId: `legacy-invoke-${kind}`,
          intent: {
            kind,
            roomId,
            sourceMessageId: `source-${kind}`,
            targetAgentId: "agent-1",
          },
        });

        await expect(client.waitForError(
          "protocol_upgrade_required",
          `legacy-invoke-${kind}`,
        )).resolves.toMatchObject({
          frame: { status: 410, message: "protocol_upgrade_required" },
        });
        expect(invoke).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it("closes legacy interrupt/retry and routes only versioned vNext controls", async () => {
    const interrupt = vi.fn();
    const retry = vi.fn();
    const cancelInvocation = vi.fn(async () => ({
      requestId: "cancel-vnext", fenceId: "fence-vnext", roomId, lineageId: "lineage-1",
      scope: { kind: "execution" as const, executionId: "execution-1", expectedVersion: 7 },
      reason: "human_cancelled" as const,
      intentOutcomes: [{ intentId: "intent-1", outcome: "already_claimed" as const }],
      executionOutcomes: [{ executionId: "execution-1", outcome: "cancelled" as const, version: 8 }],
      rejectedConfirmationIds: [], revokedGrantIds: [], preservedDispatchIds: [],
      committedAt: "2026-08-25T00:00:00.000Z",
    }));
    const retryInvocation = vi.fn(async () => ({
      execution: { id: "execution-child" }, intent: {}, replayed: false,
      retryReceipt: {
        requestId: "retry-vnext", sourceExecutionId: "execution-1",
        executionId: "execution-child", intentId: "intent-1", lineageId: "lineage-1",
        roomId, executionOrdinal: 2, snapshotId: "snapshot-1", status: "accepted" as const,
        createdAt: "2026-08-25T00:00:01.000Z",
      },
    }));
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      agentRuntime: {
        invoke: vi.fn(), interrupt, retry, cancelInvocation, retryInvocation,
        confirmTool: vi.fn(), compensate: vi.fn(), close: vi.fn(),
      } as never,
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0], "vnext-control-login");
      client.send({
        type: "agent.interrupt", requestId: "legacy-interrupt",
        executionId: "execution-1", reason: "free text",
      });
      client.send({ type: "agent.retry", requestId: "legacy-retry", executionId: "execution-1" });
      await client.waitForError("protocol_upgrade_required", "legacy-interrupt");
      await client.waitForError("protocol_upgrade_required", "legacy-retry");
      expect(interrupt).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();

      client.send({
        type: "invocation.cancel", requestId: "cancel-vnext",
        executionId: "execution-1", expectedVersion: 7,
      });
      const cancelAck = await client.waitForFrame(
        (frame) => hasType(frame, "invocation.cancel.ack") && frame.requestId === "cancel-vnext",
        "vNext cancellation acknowledgement",
      );
      expect(cancelAck.frame).toEqual({
        type: "invocation.cancel.ack",
        requestId: "cancel-vnext",
        receipt: await cancelInvocation.mock.results[0]!.value,
      });
      expect(JSON.stringify(cancelAck.frame)).not.toContain('"queued"');
      expect(cancelInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "cancel-vnext", kind: "human" }),
        { executionId: "execution-1", expectedVersion: 7 },
      );

      cancelInvocation.mockResolvedValueOnce({
        requestId: "cancel-pending", fenceId: "fence-pending", roomId,
        lineageId: "lineage-pending",
        scope: { kind: "intent", intentId: "intent-pending", expectedVersion: 1 },
        reason: "human_cancelled", intentOutcomes: [
          { intentId: "intent-pending", outcome: "cancelled" },
        ],
        executionOutcomes: [], rejectedConfirmationIds: [], revokedGrantIds: [],
        preservedDispatchIds: [], committedAt: "2026-08-25T00:00:00.500Z",
      });
      client.send({
        type: "invocation.cancel", requestId: "cancel-pending",
        intentId: "intent-pending", expectedVersion: 1,
      });
      await expect(client.waitForFrame(
        (frame) => hasType(frame, "invocation.cancel.ack") && frame.requestId === "cancel-pending",
        "vNext pending intent cancellation acknowledgement",
      )).resolves.toMatchObject({ frame: {
        type: "invocation.cancel.ack", requestId: "cancel-pending",
        receipt: { scope: { kind: "intent", intentId: "intent-pending", expectedVersion: 1 } },
      } });
      expect(cancelInvocation).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: "cancel-pending", kind: "human" }),
        { intentId: "intent-pending", expectedVersion: 1 },
      );

      client.send({
        type: "invocation.retry", requestId: "retry-vnext",
        executionId: "execution-1", expectedVersion: 8,
      });
      const retryAck = await client.waitForFrame(
        (frame) => hasType(frame, "invocation.retry.ack") && frame.requestId === "retry-vnext",
        "vNext retry acknowledgement",
      );
      expect(retryAck.frame).toEqual({
        type: "invocation.retry.ack",
        requestId: "retry-vnext",
        receipt: await retryInvocation.mock.results[0]!.value.then((value) => value.retryReceipt),
        replayed: false,
      });
      expect(JSON.stringify(retryAck.frame)).not.toContain('"queued"');
      expect(retryInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "retry-vnext", kind: "human" }),
        "execution-1",
        8,
      );

      retryInvocation.mockRejectedValueOnce(Object.assign(
        new Error("Frozen context is no longer operational"),
        { status: 410, code: "context_snapshot_invalidated" },
      ));
      client.send({
        type: "invocation.retry", requestId: "retry-invalid-context",
        executionId: "execution-1", expectedVersion: 8,
      });
      await expect(client.waitForError(
        "context_snapshot_invalidated",
        "retry-invalid-context",
      )).resolves.toMatchObject({ frame: {
        status: 410,
        code: "context_snapshot_invalidated",
        message: "context_snapshot_invalidated",
        requestId: "retry-invalid-context",
      } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("fails unauthenticated and missing dependency paths closed without calling a legacy mutation", async () => {
    const executeHuman = vi.fn(async () => ({
      aggregateId: roomId,
      eventIds: ["legacy-event"],
      acceptedAt: "2026-08-19T00:00:00.000Z",
      result: {},
    }));
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      governance: {
        executeHuman,
        async readRoomGovernance() { return governanceView; },
      },
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      client.send({
        type: "room.departure.conflicts", requestId: "preflight-unauthenticated",
        roomId, targetActorId: "human-2",
      });
      await expect(client.waitForError("unauthenticated", "preflight-unauthenticated"))
        .resolves.toMatchObject({ frame: { status: 401 } });

      await client.login(humans[0], "governance-login");
      client.send({
        type: "room.departure.conflicts", requestId: "preflight-unavailable",
        roomId, targetActorId: "human-2",
      });
      await expect(client.waitForError("dependency_unavailable", "preflight-unavailable"))
        .resolves.toMatchObject({ frame: { status: 503 } });

      client.send({
        type: "room.archive", requestId: "archive-unavailable", roomId,
        expectedGovernanceRevision: 4, idempotencyKey: "archive-unavailable-key",
      });
      await expect(client.waitForError("dependency_unavailable", "archive-unavailable"))
        .resolves.toMatchObject({ frame: { status: 503 } });
      expect(executeHuman).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("derives the Human session, returns a closed preflight, and correlates every CAS ACK", async () => {
    const queries: unknown[] = [];
    const mutations: unknown[] = [];
    const executeHuman = vi.fn(async () => {
      throw new Error("legacy governance mutation must not run");
    });
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      governance: {
        executeHuman,
        async readRoomGovernance() { return governanceView; },
        async readDepartureConflicts(context, input) {
          queries.push({ context, input });
          return departureConflictList;
        },
        async executeHumanGovernance(context, command) {
          mutations.push({ context, command });
          return {
            governance: command.type === "room.archive"
              ? {
                  ...governanceView,
                  lifecycle: "archived" as const,
                  archiveGeneration: 1,
                  archivedAt: "2026-08-19T00:00:00.000Z",
                }
              : governanceView,
            eventIds: [`event-${command.type}`],
            replayed: false,
          };
        },
      },
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0], "governance-success-login");
      client.send({
        type: "room.departure.conflicts", requestId: "preflight-success",
        roomId, targetActorId: "human-2",
      });
      const preflight = await client.waitForFrame(
        (frame) => hasType(frame, "room.departure.conflicts.result") &&
          frame.requestId === "preflight-success",
        "departure preflight",
      );
      expect(preflight.frame).toEqual({
        type: "room.departure.conflicts.result",
        requestId: "preflight-success",
        conflicts: departureConflictList,
      });
      expect(queries).toEqual([{
        context: governanceSession,
        input: { roomId, targetActorId: "human-2" },
      }]);

      const frames = [
        {
          type: "room.member.leave", requestId: "leave-success", roomId,
          expectedGovernanceRevision: 4, idempotencyKey: "leave-key",
        },
        {
          type: "room.member.remove", requestId: "remove-success", roomId,
          targetActorId: "human-2", expectedGovernanceRevision: 4,
          idempotencyKey: "remove-key",
        },
        {
          type: "room.archive", requestId: "archive-success", roomId,
          expectedGovernanceRevision: 4, idempotencyKey: "archive-key",
        },
        {
          type: "room.reopen", requestId: "reopen-success", roomId,
          expectedGovernanceRevision: 5, idempotencyKey: "reopen-key",
        },
      ] as const;
      for (const frame of frames) {
        client.send(frame);
        const acknowledgement = await client.waitForFrame(
          (candidate) => hasType(candidate, "room.governance.ack") &&
            candidate.requestId === frame.requestId,
          `${frame.type} acknowledgement`,
        );
        expect(acknowledgement.frame).toEqual({
          type: "room.governance.ack",
          requestId: frame.requestId,
          operation: frame.type,
          governance: frame.type === "room.archive"
            ? {
                ...governanceView,
                lifecycle: "archived",
                archiveGeneration: 1,
                archivedAt: "2026-08-19T00:00:00.000Z",
              }
            : governanceView,
          eventIds: [`event-${frame.type}`],
          replayed: false,
        });
      }

      expect(mutations).toEqual(frames.map((frame) => ({
        context: {
          ...governanceSession,
          kind: "human",
          requestId: frame.requestId,
          idempotencyKey: frame.idempotencyKey,
        },
        command: frame.type === "room.member.remove"
          ? {
              type: frame.type, roomId,
              payload: {
                targetActorId: frame.targetActorId,
                expectedGovernanceRevision: frame.expectedGovernanceRevision,
              },
            }
          : {
              type: frame.type, roomId,
              payload: { expectedGovernanceRevision: frame.expectedGovernanceRevision },
            },
      })));
      expect(executeHuman).not.toHaveBeenCalled();

      client.send({
        type: "room.departure.conflicts", requestId: "preflight-injected", roomId,
        targetActorId: "human-2", principal: governancePrincipal,
      });
      await expect(client.waitForError("invalid_request", "preflight-injected"))
        .resolves.toMatchObject({ frame: { status: 400 } });
      expect(queries).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("maps the closed status family and exposes details only for a safe departure_blocked", async () => {
    const failures = new Map<string, { readonly status: number; readonly code: string }>([
      ["human-403", { status: 403, code: "role_forbidden" }],
      ["human-404", { status: 404, code: "member_not_found" }],
      ["human-409", { status: 409, code: "room_revision_conflict" }],
      ["human-410", { status: 410, code: "snapshot_expired" }],
      ["human-429", { status: 429, code: "snapshot_busy" }],
      ["human-503", { status: 503, code: "dependency_unavailable" }],
    ]);
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      governance: {
        async executeHuman() {
          throw new Error("legacy mutation must not run");
        },
        async readRoomGovernance() { return governanceView; },
        async readDepartureConflicts(_context, input) {
          const failure = failures.get(input.targetActorId);
          if (failure !== undefined) {
            throw Object.assign(new Error("provider-secret"), failure, {
              details: { secret: "must-not-cross-wire" },
            });
          }
          if (input.targetActorId === "human-cross-room") {
            return { ...departureConflictList, roomId: "room-2" };
          }
          if (input.targetActorId === "human-oversized") {
            return {
              ...departureConflictList,
              targetActorId: input.targetActorId,
              conflicts: [{
                ...departureConflictList.conflicts[0],
                title: "x".repeat(1_025),
              }],
            };
          }
          return {
            ...departureConflictList,
            targetActorId: input.targetActorId,
          };
        },
        async executeHumanGovernance(_context, command) {
          const malformed = command.type === "room.member.remove" &&
            command.payload.targetActorId === "human-malformed";
          const targetActorId = command.type === "room.member.leave"
            ? "human-1"
            : command.type === "room.member.remove"
              ? command.payload.targetActorId
              : "human-2";
          throw Object.assign(new Error("provider-secret"), {
            status: 409,
            code: "departure_blocked",
            details: malformed
              ? {
                  ...departureConflictList,
                  targetActorId: "human-malformed",
                  conflicts: [{ ...departureConflictList.conflicts[0], grant: "secret-grant" }],
                }
              : {
                  ...departureConflictList,
                  targetActorId,
                },
          });
        },
      },
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0], "governance-errors-login");
      for (const [targetActorId, expected] of failures) {
        const requestId = `error-${expected.status}`;
        client.send({
          type: "room.departure.conflicts", requestId, roomId, targetActorId,
        });
        const failure = await client.waitForError(expected.code, requestId);
        expect(failure.frame).toEqual({
          type: "error",
          status: expected.status,
          code: expected.code,
          message: expected.code,
          requestId,
        });
        expect(JSON.stringify(failure.frame)).not.toContain("provider-secret");
        expect(JSON.stringify(failure.frame)).not.toContain("must-not-cross-wire");
      }

      client.send({
        type: "room.member.remove", requestId: "remove-blocked", roomId,
        targetActorId: "human-2", expectedGovernanceRevision: 4,
        idempotencyKey: "remove-blocked-key",
      });
      const blocked = await client.waitForError("departure_blocked", "remove-blocked");
      expect(blocked.frame).toEqual({
        type: "error",
        status: 409,
        code: "departure_blocked",
        message: "departure_blocked",
        requestId: "remove-blocked",
        details: departureConflictList,
      });

      client.send({
        type: "room.member.leave", requestId: "leave-blocked", roomId,
        expectedGovernanceRevision: 4, idempotencyKey: "leave-blocked-key",
      });
      await expect(client.waitForError("departure_blocked", "leave-blocked"))
        .resolves.toMatchObject({
          frame: {
            status: 409,
            details: { roomId, targetActorId: "human-1" },
          },
        });

      client.send({
        type: "room.member.remove", requestId: "remove-malformed", roomId,
        targetActorId: "human-malformed", expectedGovernanceRevision: 4,
        idempotencyKey: "remove-malformed-key",
      });
      const malformed = await client.waitForError("dependency_unavailable", "remove-malformed");
      expect(malformed.frame).toEqual({
        type: "error", status: 503, code: "dependency_unavailable",
        message: "dependency_unavailable", requestId: "remove-malformed",
      });
      expect(JSON.stringify(malformed.frame)).not.toContain("secret-grant");

      client.send({
        type: "room.departure.conflicts", requestId: "preflight-cross-room", roomId,
        targetActorId: "human-cross-room",
      });
      await expect(client.waitForError("dependency_unavailable", "preflight-cross-room"))
        .resolves.toMatchObject({ frame: { status: 503 } });

      client.send({
        type: "room.departure.conflicts", requestId: "preflight-oversized", roomId,
        targetActorId: "human-oversized",
      });
      await expect(client.waitForError("dependency_unavailable", "preflight-oversized"))
        .resolves.toMatchObject({ frame: { status: 503 } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects malformed dependency acknowledgements instead of inventing mutation success", async () => {
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      governance: {
        async executeHuman() {
          throw new Error("legacy mutation must not run");
        },
        async readRoomGovernance() { return { ...governanceView, roomId: "room-2", projectId: "room-2" }; },
        async readDepartureConflicts() { return departureConflictList; },
        async executeHumanGovernance() {
          return {
            governance: { ...governanceView, roomId: "room-2", projectId: "room-2" },
            eventIds: ["forged-event", "forged-event"],
            replayed: false,
          };
        },
      },
    });
    const client = await LoopbackClient.connect(server.url);

    try {
      await client.login(humans[0], "governance-malformed-login");
      client.send({
        type: "room.archive", requestId: "archive-malformed", roomId,
        expectedGovernanceRevision: 4, idempotencyKey: "archive-malformed-key",
      });
      const failure = await client.waitForError("dependency_unavailable", "archive-malformed");
      expect(failure.frame).toEqual({
        type: "error", status: 503, code: "dependency_unavailable",
        message: "dependency_unavailable", requestId: "archive-malformed",
      });
      expect(client.frameCount((frame) => hasType(frame, "room.governance.ack") &&
        frame.requestId === "archive-malformed")).toBe(0);
      expect(JSON.stringify(failure.frame)).not.toContain("must-not-cross-wire");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes closed attachment commands only through the authenticated authority port", async () => {
    const uploadId = "00000000-0000-4000-8000-000000000101";
    const execute = vi.fn(async (_context, frame) => ({
      type: "attachment.upload.begun" as const,
      requestId: frame.requestId,
      uploadId,
      acknowledgedBytes: 0,
    }));
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      attachmentAuthority: {
        execute,
        invalidateFamily() {},
        close() {},
      },
    });
    const client = await LoopbackClient.connect(server.url);
    const request = {
      type: "attachment.upload.begin",
      requestId: "attachment-begin",
      roomId,
      uploadKey: "attachment-upload-key",
      originalFilename: "safe.txt",
      declaredMime: "text/plain",
      expectedBytes: 5,
      expectedSha256: createHash("sha256").update("hello").digest("hex"),
    } as const;

    try {
      client.send(request);
      await expect(client.waitForError("unauthenticated", request.requestId)).resolves.toMatchObject({
        frame: { status: 401 },
      });
      expect(execute).not.toHaveBeenCalled();

      await client.login(humans[0], "attachment-login");
      client.send(request);
      const response = await client.waitForFrame(
        (frame) => hasType(frame, "attachment.upload.begun") &&
          frame.requestId === request.requestId,
        "attachment upload begun",
      );
      expect(response.frame).toEqual({
        type: "attachment.upload.begun",
        requestId: request.requestId,
        uploadId,
        acknowledgedBytes: 0,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toMatchObject({
        kind: "human",
        sessionId: governanceSession.sessionId,
        sessionFamilyId: governanceSession.sessionFamilyId,
        principal: governanceSession.principal,
      });
      expect(execute.mock.calls[0]?.[1]).toEqual(request);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("closed FT-07 Agent Settings WebSocket authority", () => {
  const provider = {
    providerId: "openai",
    modelId: "gpt-5",
    credentialReadiness: "ready",
  } as const;
  const assignment = {
    recordVersion: "room-agent-assignment.v1",
    assignmentId: "assignment-1",
    roomId,
    profileId: "profile-1",
    actorId: "agent-1",
    displayName: "Research",
    globalResponsibility: "Review evidence",
    roomResponsibility: "Review this Room",
    participation: "on-mention",
    availability: "ready",
    paused: false,
    capabilityCeiling: ["room.conversation.read", "room.respond"],
    capabilitySubset: ["room.conversation.read"],
    effectiveCapabilities: ["room.conversation.read"],
    toolCeiling: ["room-memory.read"],
    toolSubset: ["room-memory.read"],
    effectiveTools: ["room-memory.read"],
    profileRevision: 2,
    assignmentRevision: 3,
    accessRevision: 4,
    updatedAt: "2026-08-24T00:00:00.000Z",
  } as const;

  it("requires authentication and a real authority port", async () => {
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      client.send({ type: "agent-profile.list", requestId: "profile-unauthenticated" });
      await expect(client.waitForError("unauthenticated", "profile-unauthenticated"))
        .resolves.toMatchObject({ frame: { status: 401 } });
      await client.login(humans[0], "profile-login");
      client.send({ type: "agent-profile.list", requestId: "profile-unavailable" });
      await expect(client.waitForError("storage_unavailable", "profile-unavailable"))
        .resolves.toMatchObject({ frame: { status: 503 } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes deployment queries, room queries, repair and mutations through typed authority seams", async () => {
    const executeQuery = vi.fn(async (_context, frame: Record<string, unknown>) =>
      frame.type === "room-agent-assignment.get"
        ? {
            type: "room-agent-assignment.detail",
            requestId: frame.requestId,
            roomId,
            assignment,
            provider,
          }
        : frame.type === "room-agent-assignment.list"
        ? {
            type: "room-agent-assignment.catalog",
            requestId: frame.requestId,
            roomId,
            roomRevision: 5,
            assignments: [],
            provider,
          }
        : {
            type: "agent-profile.catalog",
            requestId: frame.requestId,
            catalogRevision: 7,
            profiles: [],
            provider,
          });
    const executeMutation = vi.fn(async (_context, frame: Record<string, unknown>) => ({
      type: "agent-settings.ack",
      requestId: frame.requestId,
      operation: frame.type,
      acceptedRevision: 6,
      eventIds: ["assignment-event-1"],
      replayed: false,
    }));
    const repair = vi.fn(async (_context, requestId: string) => ({
      type: "agent-profile.repair.snapshot",
      requestId,
      watermark: 7,
      profiles: [],
      provider,
    }));
    const syncProfiles = vi.fn(async (_context, input: { requestId: string; afterSeq?: number }) => ({
      type: "agent-profile.sync.result",
      requestId: input.requestId,
      mode: "delta",
      events: [],
      nextCursor: input.afterSeq ?? 0,
      watermark: input.afterSeq ?? 0,
      hasMore: false,
    }));
    const sync = createSyncService({
      store: { async syncRoom() { throw new Error("not used"); } },
      agentSettings: {
        syncAgentProfiles: syncProfiles,
        repairAgentProfiles: repair,
        async repairRoomAgentAssignments() { throw new Error("not used"); },
      },
    });
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      agentSettingsAuthority: { executeQuery, executeMutation },
      sync,
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0], "agent-settings-login");
      client.send({ type: "agent-profile.list", requestId: "profile-list" });
      await client.waitForFrame((frame) => hasType(frame, "agent-profile.catalog") &&
        frame.requestId === "profile-list", "Profile catalog");
      client.send({
        type: "room-agent-assignment.list", requestId: "assignment-list", roomId,
      });
      await client.waitForFrame((frame) => hasType(frame, "room-agent-assignment.catalog") &&
        frame.requestId === "assignment-list", "Assignment catalog");
      client.send({
        type: "room-agent-assignment.get", requestId: "assignment-get", roomId,
        assignmentId: "assignment-1",
      });
      await client.waitForFrame((frame) => hasType(frame, "room-agent-assignment.detail") &&
        frame.requestId === "assignment-get" &&
        frame.assignment.assignmentId === "assignment-1", "Assignment detail");
      client.send({
        type: "agent-profile.sync", requestId: "profile-sync", afterSeq: 6, limit: 32,
      });
      await client.waitForFrame((frame) => hasType(frame, "agent-profile.sync.result") &&
        frame.requestId === "profile-sync" && frame.nextCursor === 6, "Profile delta sync");
      client.send({ type: "agent-profile.repair", requestId: "profile-repair" });
      await client.waitForFrame((frame) => hasType(frame, "agent-profile.repair.snapshot") &&
        frame.requestId === "profile-repair", "Profile repair");
      client.send({
        type: "room-agent-assignment.pause",
        requestId: "assignment-pause",
        idempotencyKey: "assignment-pause-key",
        roomId,
        assignmentId: "assignment-1",
        expectedRoomRevision: 5,
        expectedAssignmentRevision: 2,
      });
      const acknowledgement = await client.waitForFrame((frame) =>
        hasType(frame, "agent-settings.ack") && frame.requestId === "assignment-pause",
      "Assignment ACK");
      expect(acknowledgement.frame).toEqual({
        type: "agent-settings.ack",
        requestId: "assignment-pause",
        operation: "room-agent-assignment.pause",
        acceptedRevision: 6,
        eventIds: ["assignment-event-1"],
        replayed: false,
      });
      expect(acknowledgement.frame).not.toHaveProperty("assignment");
      expect(executeQuery).toHaveBeenCalledTimes(3);
      expect(syncProfiles).toHaveBeenCalledWith(governanceSession, {
        requestId: "profile-sync", afterSeq: 6, limit: 32,
      });
      expect(repair).toHaveBeenCalledOnce();
      expect(executeMutation).toHaveBeenCalledOnce();
      expect(executeMutation.mock.calls[0]?.[0]).toMatchObject({
        ...governanceSession,
        kind: "human",
        requestId: "assignment-pause",
        idempotencyKey: "assignment-pause-key",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects malformed authority results instead of inventing stable state", async () => {
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      agentSettingsAuthority: {
        async executeQuery(_context, frame) {
          return {
            type: "agent-profile.catalog",
            requestId: frame.requestId,
            catalogRevision: 1,
            profiles: [],
            provider: { ...provider, credential: "secret-canary" },
          };
        },
        async executeMutation(_context, frame) {
          return {
            type: "agent-settings.ack", requestId: frame.requestId, operation: frame.type,
            acceptedRevision: 2, eventIds: ["duplicate", "duplicate"], replayed: false,
          };
        },
      },
      sync: createSyncService({
        store: { async syncRoom() { throw new Error("not used"); } },
        agentSettings: {
          async syncAgentProfiles() { throw new Error("not used"); },
          async repairAgentProfiles(_context, requestId) {
            return { type: "agent-profile.repair.snapshot", requestId,
              watermark: 1, profiles: [], provider: { ...provider, roomId: "room-secret" } };
          },
          async repairRoomAgentAssignments() { throw new Error("not used"); },
        },
      }),
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0], "malformed-agent-settings-login");
      client.send({ type: "agent-profile.list", requestId: "malformed-profile" });
      const profileError = await client.waitForError("storage_unavailable", "malformed-profile");
      expect(JSON.stringify(profileError.frame)).not.toContain("secret-canary");
      client.send({ type: "agent-profile.repair", requestId: "malformed-repair" });
      const repairError = await client.waitForError("storage_unavailable", "malformed-repair");
      expect(JSON.stringify(repairError.frame)).not.toContain("room-secret");
      client.send({
        type: "agent-profile.disable", requestId: "malformed-ack", idempotencyKey: "key",
        profileId: "profile-1", expectedProfileRevision: 1,
      });
      await expect(client.waitForError("storage_unavailable", "malformed-ack"))
        .resolves.toMatchObject({ frame: { status: 503 } });
      expect(client.frameCount((frame) => hasType(frame, "agent-settings.ack"))).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    [400, "invalid_request"],
    [401, "unauthenticated"],
    [403, "administrator_required"],
    [404, "profile_not_found"],
    [409, "administrator_revision_conflict"],
    [409, "assignment_already_exists"],
    [409, "profile_revision_conflict"],
    [410, "profile_gone"],
    [429, "capacity_limited"],
    [503, "provider_configuration_unavailable"],
  ] as const)("preserves the closed %i/%s authority error", async (status, code) => {
    const server = await startMessageWebSocketServer({
      auth: governanceAuthenticationService(),
      service: idleMessageService(),
      agentSettingsAuthority: {
        async executeQuery() { throw Object.assign(new Error("private-detail"), { status, code }); },
        async executeMutation() { throw new Error("not used"); },
      },
    });
    const client = await LoopbackClient.connect(server.url);
    try {
      await client.login(humans[0], `agent-settings-error-${status}`);
      client.send({ type: "agent-profile.list", requestId: `profile-error-${status}` });
      const failure = await client.waitForError(code, `profile-error-${status}`);
      expect(failure.frame).toEqual({
        type: "error", status, code, message: code, requestId: `profile-error-${status}`,
      });
      expect(JSON.stringify(failure.frame)).not.toContain("private-detail");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
