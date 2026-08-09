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
  type IdentityAdapter,
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
    const received = await this.waitForAuthenticated(requestId);
    return received.frame as SessionFrame;
  }

  async resume(accessToken: string, requestId = "resume"): Promise<ReceivedFrame> {
    this.send({ type: "auth.resume", requestId, accessToken });
    return this.waitForAuthenticated(requestId);
  }

  async refresh(refreshToken: string, requestId = "refresh"): Promise<ReceivedFrame> {
    this.send({ type: "auth.refresh", requestId, refreshToken });
    return this.waitForAuthenticated(requestId);
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

  frameIndex(predicate: (frame: unknown) => boolean): number {
    return this.receivedFrames.findIndex((entry) => predicate(entry.frame));
  }

  frameCount(predicate: (frame: unknown) => boolean): number {
    return this.receivedFrames.filter((entry) => predicate(entry.frame)).length;
  }

  historyFrames(requestId: string): readonly ReceivedFrame[] {
    return this.receivedFrames.filter((entry) => hasHistory(entry.frame, requestId));
  }

  private waitForAuthenticated(requestId: string): Promise<ReceivedFrame> {
    return this.waitFor(
      (frame) => hasType(frame, "auth.authenticated") && frame.requestId === requestId,
      `authentication ${requestId}`,
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
    await rooms.configureAgent(humans[0].id, {
      kind: "agent-configuration",
      roomId,
      agentId: agent.id,
      participation: "active",
      toolPermissions: agent.toolPermissions,
    });
  }
}

async function createFixture(): Promise<{
  readonly connect: () => Promise<LoopbackClient>;
  readonly clients: readonly LoopbackClient[];
  readonly close: () => Promise<void>;
  readonly closeServer: () => Promise<void>;
  readonly restartServer: () => Promise<void>;
  readonly setSubscriptionRace: (hook: () => Promise<void>) => void;
  readonly advanceClock: (milliseconds: number) => void;
  readonly messages: () => Promise<readonly Message[]>;
  readonly rooms: () => RoomLifecycleService;
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
    activeServer = await startMessageWebSocketServer({
      auth,
      service,
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
  };
}

const fixtures: Array<Awaited<ReturnType<typeof createFixture>>> = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("authenticated message WebSocket service", () => {
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

  it("rejects forged authorId and authorKind with 403 and persists nothing", async () => {
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
        frame: { status: 403 },
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

  it("supports all existing human and agent actors through authenticated sessions", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const roomActors = [...humans, ...agents];
    const clients = await Promise.all(roomActors.map(() => fixture.connect()));
    await Promise.all(clients.map((client, index) => client.login(roomActors[index]!)));
    await Promise.all(clients.map((client) => client.subscribe(roomId)));

    for (const [index, actor] of roomActors.entries()) {
      await clients[index]!.sendDraft(draftFor(`message-${actor.kind}-${index + 1}`));
    }

    const historyClient = await fixture.connect();
    await historyClient.login(humans[0]);
    await historyClient.history(roomId, "all-actors-history");
    const history = historyClient.messages(roomId);

    expect(history).toHaveLength(7);
    expect(history.filter((message) => message.authorKind === "human")).toHaveLength(3);
    expect(history.filter((message) => message.authorKind === "agent")).toHaveLength(4);
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
    await sender.login(humans[1]);
    fixture.advanceClock(1_001);

    expired.send({ type: "room.history", requestId: "expired-history", roomId });
    await expect(expired.waitForError("token_expired", "expired-history")).resolves.toMatchObject({
      frame: { status: 401 },
    });
    const laterMessage = draftFor("message-after-expiry");
    sender.send({ type: "message.send", requestId: laterMessage.id, message: laterMessage });
    await expect(sender.waitForError("token_expired", laterMessage.id)).resolves.toMatchObject({
      frame: { status: 401 },
    });
    await expect(expired.waitForMessage(laterMessage.id, 100)).rejects.toThrow("Timed out");
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
    await expect(lionel.waitForError("identity_forbidden", "cross-session-refresh")).resolves.toMatchObject({
      frame: { status: 403 },
    });

    const refreshed = await lionel.refresh(lionelSession.refreshToken!, "own-refresh");
    expect(refreshed.frame).toMatchObject({ actorId: humans[0].id });
    expect((refreshed.frame as SessionFrame).accessToken).not.toBe(lionelSession.accessToken);
    await lionel.sendDraft(draftFor("message-after-refresh"));
    await expect(fixture.messages()).resolves.toEqual([
      messageFor(humans[0], "message-after-refresh"),
    ]);
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

  it("does not emit obsolete history when a newer subscription supersedes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-overlapping-subscribe-"));
    const rooms = await createRoomLifecycleService({
      actors,
      state: createJsonStateStore(join(directory, "rooms.json"), isRoomLifecycleState),
      idFactory: sequenceFactory("room"),
      tokenFactory: sequenceFactory("invitation"),
    });
    await populateRoom(rooms);
    const auth = createAuthenticationService({
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
      async append(message): Promise<void> {
        storedMessages.push(message);
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
      const currentHistory = await client.waitForHistory("subscribe-current");
      expect(currentHistory.frame).toMatchObject({
        type: "room.history",
        requestId: "subscribe-current",
        messages: [historicalMessage],
      });

      releaseFirstHistory?.();
      await expect(client.waitForHistory("subscribe-obsolete", 100)).rejects.toThrow("Timed out");
      expect(client.historyFrames("subscribe-current")).toHaveLength(1);
    } finally {
      releaseFirstHistory?.();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
