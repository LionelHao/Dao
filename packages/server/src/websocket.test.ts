import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { isMessage, type Actor, type Message, type Room } from "@native-im/core";
import {
  createJsonlMessageStore,
  createMessageService,
  startMessageWebSocketServer,
  type MessageService,
  type MessageStore,
} from "./index.js";

const humans: readonly Actor[] = [
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
];

const agents: readonly Actor[] = [
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
];

const actors = [...humans, ...agents];
const room: Room = {
  id: "room-1",
  name: "Native IM",
  memberIds: actors.map((actor) => actor.id),
  createdAt: "2026-08-06T00:00:00.000Z",
};

interface ReceivedFrame {
  readonly frame: unknown;
  readonly receivedAt: number;
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
  return hasType(value, "message.history") && value.requestId === requestId && Array.isArray(value.messages);
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

  async subscribe(roomId: string, requestId = `subscribe-${roomId}`): Promise<ReceivedFrame> {
    this.send({ type: "room.subscribe", requestId, roomId });
    return this.waitForHistory(requestId);
  }

  async sendMessage(message: Message, requestId = message.id): Promise<ReceivedFrame> {
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

  messages(roomId: string): readonly Message[] {
    return [...this.messagesById.values()].filter((message) => message.roomId === roomId);
  }

  waitForMessage(messageId: string): Promise<ReceivedFrame> {
    return this.waitFor((frame) => hasMessageCreated(frame, messageId), `live message ${messageId}`);
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

  historyFrames(requestId: string): readonly ReceivedFrame[] {
    return this.receivedFrames.filter((entry) => hasHistory(entry.frame, requestId));
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

    if (hasType(frame, "message.history") && Array.isArray(frame.messages)) {
      for (const message of frame.messages) {
        if (isMessage(message)) {
          this.messagesById.set(message.id, message);
        }
      }
    }
  }
}

function messageFor(actor: Actor, id: string): Message {
  return {
    id,
    roomId: room.id,
    authorId: actor.id,
    authorKind: actor.kind,
    body: `Message from ${actor.displayName}`,
    sentAt: "2026-08-06T00:01:00.000Z",
  };
}

function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Promise did not settle within ${timeoutMs}ms`));
    }, timeoutMs);

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

async function createFixture(): Promise<{
  readonly connect: () => Promise<LoopbackClient>;
  readonly clients: readonly LoopbackClient[];
  readonly close: () => Promise<void>;
  readonly closeServer: () => Promise<void>;
  readonly setSubscriptionRace: (hook: () => Promise<void>) => void;
  readonly store: ReturnType<typeof createJsonlMessageStore>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "native-im-websocket-"));
  const store = createJsonlMessageStore(join(directory, "messages.jsonl"));
  const service = createMessageService({ actors, rooms: [room], store });
  const clients: LoopbackClient[] = [];
  let afterSubscribeRegistered: (() => Promise<void>) | undefined;
  let serverClosePromise: Promise<void> | undefined;
  const server = await startMessageWebSocketServer({
    service,
    afterSubscribeRegistered: async () => {
      const hook = afterSubscribeRegistered;
      afterSubscribeRegistered = undefined;
      await hook?.();
    },
  });

  return {
    connect: async () => {
      const client = await LoopbackClient.connect(server.url);
      clients.push(client);
      return client;
    },
    clients,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
      await (serverClosePromise ??= server.close());
      await rm(directory, { recursive: true, force: true });
    },
    closeServer: () => (serverClosePromise ??= server.close()),
    setSubscriptionRace: (hook) => {
      afterSubscribeRegistered = hook;
    },
    store,
  };
}

const fixtures: Array<Awaited<ReturnType<typeof createFixture>>> = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("message WebSocket service", () => {
  it("returns structured protocol errors for malformed and invalid send requests", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const client = await fixture.connect();

    client.sendRaw("{not-json");
    await expect(client.waitForError("invalid_request")).resolves.toMatchObject({
      frame: { type: "error", code: "invalid_request" },
    });

    client.send({
      type: "message.send",
      requestId: "invalid-message",
      message: { id: "invalid-message" },
    });
    await expect(client.waitForError("invalid_request", "invalid-message")).resolves.toMatchObject({
      frame: { type: "error", code: "invalid_request", requestId: "invalid-message" },
    });

    client.send({
      type: "message.send",
      requestId: "unknown-author",
      message: {
        ...messageFor(humans[0]!, "unknown-author"),
        authorId: "missing-author",
      },
    });
    await expect(client.waitForError("unknown_author", "unknown-author")).resolves.toMatchObject({
      frame: { type: "error", code: "unknown_author", requestId: "unknown-author" },
    });
  });

  it("correlates a persisted acknowledgement to the WebSocket request ID", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const client = await fixture.connect();
    const message = messageFor(humans[0]!, "message-request-id");

    client.send({
      type: "message.send",
      requestId: "transport-request-1",
      message,
    });

    await expect(client.waitForAcceptance(message.id)).resolves.toMatchObject({
      frame: {
        type: "message.accepted",
        requestId: "transport-request-1",
        messageId: message.id,
      },
    });
  });

  it("delivers a persisted human message to three subscribed local clients within one second", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const clients = await Promise.all([fixture.connect(), fixture.connect(), fixture.connect()]);
    await Promise.all(clients.map((client) => client.subscribe(room.id)));

    const message = messageFor(humans[0]!, "message-human-1");
    const sentAt = Date.now();
    await clients[0]!.sendMessage(message);
    const receivedBySecond = await clients[1]!.waitForMessage(message.id);
    const receivedByThird = await clients[2]!.waitForMessage(message.id);

    expect(receivedBySecond.receivedAt - sentAt).toBeLessThan(1_000);
    expect(receivedByThird.receivedAt - sentAt).toBeLessThan(1_000);
    await expect(fixture.store.list(room.id)).resolves.toEqual([message]);
  });

  it("registers live delivery before history so a joining client de-duplicates a race message", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const existingClient = await fixture.connect();
    await existingClient.subscribe(room.id);

    const raceMessage = messageFor(humans[1]!, "message-race-1");
    fixture.setSubscriptionRace(async () => {
      await existingClient.sendMessage(raceMessage);
    });

    const joiningClient = await fixture.connect();
    const history = await joiningClient.subscribe(room.id, "subscribe-race");
    const created = await joiningClient.waitForMessage(raceMessage.id);

    expect(joiningClient.messages(room.id).filter((message) => message.id === raceMessage.id)).toEqual([
      raceMessage,
    ]);
    expect(joiningClient.frameIndex((frame) => hasMessageCreated(frame, raceMessage.id))).toBeGreaterThanOrEqual(0);
    expect(joiningClient.frameIndex((frame) => hasMessageCreated(frame, raceMessage.id))).toBeLessThan(
      joiningClient.frameIndex((frame) => frame === history.frame),
    );
    expect(created.receivedAt).toBeLessThanOrEqual(history.receivedAt);
  });

  it("allows three humans and four agents to connect, subscribe, and send end-to-end", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    const clients = await Promise.all(actors.map(() => fixture.connect()));
    await Promise.all(clients.map((client) => client.subscribe(room.id)));

    for (const [index, actor] of actors.entries()) {
      await clients[index]!.sendMessage(messageFor(actor, `message-${actor.kind}-${index + 1}`));
    }

    const historyClient = await fixture.connect();
    await historyClient.subscribe(room.id);
    const history = historyClient.messages(room.id);

    expect(history).toHaveLength(7);
    expect(history.filter((message) => message.authorKind === "human")).toHaveLength(3);
    expect(history.filter((message) => message.authorKind === "agent")).toHaveLength(4);
    for (const [index, client] of clients.entries()) {
      expect(client.messages(room.id).some((message) => message.authorId !== actors[index]!.id)).toBe(true);
    }
  });

  it("closes the server without waiting for an active WebSocket client", async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);
    await fixture.connect();

    await expect(settlesWithin(fixture.closeServer(), 250)).resolves.toBeUndefined();
  });

  it("returns internal_error for a synchronous subscribe failure and continues processing frames", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-subscribe-failure-"));
    const store = createJsonlMessageStore(join(directory, "messages.jsonl"));
    const stableService = createMessageService({ actors, rooms: [room], store });
    let shouldThrowOnSubscribe = true;
    const service: MessageService = {
      send: (message) => stableService.send(message),
      subscribe: (roomId, listener) => {
        if (shouldThrowOnSubscribe) {
          shouldThrowOnSubscribe = false;
          throw new Error("injected synchronous subscribe failure");
        }
        return stableService.subscribe(roomId, listener);
      },
      history: (roomId) => stableService.history(roomId),
    };
    const server = await startMessageWebSocketServer({ service });
    const client = await LoopbackClient.connect(server.url);
    const subsequentMessage = messageFor(humans[0]!, "message-after-subscribe-failure");

    try {
      client.send({ type: "room.subscribe", requestId: "subscribe-failed", roomId: room.id });
      await expect(client.waitForError("internal_error", "subscribe-failed")).resolves.toMatchObject({
        frame: { type: "error", code: "internal_error", requestId: "subscribe-failed" },
      });

      await expect(client.sendMessage(subsequentMessage)).resolves.toMatchObject({
        frame: { type: "message.accepted", messageId: subsequentMessage.id },
      });
      await expect(store.list(room.id)).resolves.toEqual([subsequentMessage]);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not emit obsolete history when a newer room subscription supersedes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-overlapping-subscribe-"));
    const historicalMessage = messageFor(humans[0]!, "message-before-subscribe");
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
      async list(roomId): Promise<readonly Message[]> {
        listCalls += 1;
        if (listCalls === 1) {
          firstHistoryStarted?.();
          await firstHistoryReleasePromise;
        }
        return storedMessages.filter((message) => message.roomId === roomId);
      },
    };
    const service = createMessageService({ actors, rooms: [room], store });
    const server = await startMessageWebSocketServer({ service });
    const client = await LoopbackClient.connect(server.url);

    try {
      client.send({ type: "room.subscribe", requestId: "subscribe-obsolete", roomId: room.id });
      await firstHistoryStartedPromise;

      client.send({ type: "room.subscribe", requestId: "subscribe-current", roomId: room.id });
      const currentHistory = await client.waitForHistory("subscribe-current");
      expect(currentHistory.frame).toMatchObject({
        type: "message.history",
        requestId: "subscribe-current",
        messages: [historicalMessage],
      });

      releaseFirstHistory?.();
      await expect(client.waitForHistory("subscribe-obsolete", 100)).rejects.toThrow(
        "Timed out waiting for history subscribe-obsolete",
      );
      expect(client.historyFrames("subscribe-current")).toHaveLength(1);
    } finally {
      releaseFirstHistory?.();
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
