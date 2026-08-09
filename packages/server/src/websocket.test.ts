import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { isMessage, type Actor, type Message, type MessageDraft } from "@native-im/core";
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
  type RoomLifecycleService,
} from "./index.js";

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

  static async connect(url: string): Promise<LoopbackClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new LoopbackClient(socket);
  }

  async login(actor: Actor, requestId = `login-${actor.id}`): Promise<SessionFrame> {
    const accountId = `account-${actor.id}`;
    this.send({
      type: "auth.login",
      requestId,
      accountId,
      secret: `secret-${actor.id}`,
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

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.socket.once("close", resolve);
      this.socket.close();
    });
  }

  async waitForClose(timeoutMs = 1_000): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for socket close")), timeoutMs);
      this.socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
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
    accessToken: `${tokenPrefix}-access`,
    refreshToken: `${tokenPrefix}-refresh`,
    expiresAt: "2026-08-10T01:00:00.000Z",
    refreshExpiresAt: "2026-08-11T00:00:00.000Z",
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

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("authenticated message WebSocket service", () => {
  it("exports finite aggregate inbound queue defaults", async () => {
    const serverModule = await import("./index.js");

    expect(serverModule.MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_COUNT).toBe(64);
    expect(serverModule.MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_BYTES).toBe(256 * 1_024);
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

    client.send({
      type: "auth.login",
      requestId: "bad-login",
      accountId: "account-human-1",
      secret: "wrong-secret",
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
