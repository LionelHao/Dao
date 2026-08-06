import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Actor, Message, Room } from "@native-im/core";
import {
  createJsonlMessageStore,
  createMessageService,
  MessageStoreCorruptionError,
  MessageValidationError,
  type MessageErrorCode,
  type MessageService,
  type MessageStore,
} from "./index.js";

const human: Actor = {
  id: "human-1",
  kind: "human",
  displayName: "Lionel",
  reachability: "online",
};

const agent: Actor = {
  id: "agent-1",
  kind: "agent",
  displayName: "Research agent",
  readiness: "ready",
  toolPermissions: [],
};

const room: Room = {
  id: "room-1",
  name: "Native IM",
  memberIds: [human.id],
  createdAt: "2026-08-06T00:00:00.000Z",
};

const message: Message = {
  id: "message-1",
  roomId: room.id,
  authorId: human.id,
  authorKind: human.kind,
  body: "Hello from a human.",
  sentAt: "2026-08-06T00:01:00.000Z",
};

class DeferredMemoryStore implements MessageStore {
  readonly events: string[] = [];
  readonly messages: Message[] = [];
  private resolveAppend: (() => void) | undefined;

  async append(value: Message): Promise<void> {
    this.events.push(`append:${value.id}`);
    this.messages.push(value);
    await new Promise<void>((resolve) => {
      this.resolveAppend = resolve;
    });
  }

  async list(roomId: string): Promise<readonly Message[]> {
    return this.messages.filter((value) => value.roomId === roomId);
  }

  releaseAppend(): void {
    if (this.resolveAppend === undefined) {
      throw new Error("append has not started");
    }
    this.resolveAppend();
  }
}

class MemoryStore implements MessageStore {
  constructor(private readonly messages: readonly Message[] = []) {}

  async append(): Promise<void> {}

  async list(roomId: string): Promise<readonly Message[]> {
    return this.messages.filter((value) => value.roomId === roomId);
  }
}

type ServiceFactoryOptions = Omit<Parameters<typeof createMessageService>[0], "actors" | "rooms"> & {
  actors?: readonly Actor[];
  rooms?: readonly Room[];
};

function createService({
  actors = [human, agent],
  rooms = [room],
  ...options
}: ServiceFactoryOptions): MessageService {
  return createMessageService({
    actors,
    rooms,
    ...options,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("message service", () => {
  it("persists a message before delivering it and returns its acceptance acknowledgement", async () => {
    const store = new DeferredMemoryStore();
    const service = createService({
      store,
      clock: () => "2026-08-06T00:02:00.000Z",
    });
    const received: Message[] = [];
    service.subscribe(room.id, (receivedMessage) => {
      received.push(receivedMessage);
    });

    const acknowledgement = service.send(message);
    await Promise.resolve();

    expect(store.events).toEqual(["append:message-1"]);
    expect(received).toEqual([]);

    store.releaseAppend();

    await expect(acknowledgement).resolves.toEqual({
      type: "message.accepted",
      requestId: "message-1",
      messageId: "message-1",
      persistedAt: "2026-08-06T00:02:00.000Z",
    });
    expect(received).toEqual([message]);
  });

  it.each([
    {
      code: "invalid_message",
      candidate: { ...message, body: 42 } as unknown as Message,
    },
    {
      code: "unknown_author",
      candidate: { ...message, authorId: "missing-author" },
    },
    {
      code: "author_kind_mismatch",
      candidate: { ...message, authorKind: "agent" as const },
    },
    {
      code: "unknown_room",
      candidate: { ...message, roomId: "missing-room" },
    },
    {
      code: "author_not_in_room",
      candidate: { ...message, authorId: agent.id, authorKind: agent.kind },
    },
    {
      code: "empty_message",
      candidate: { ...message, body: " \n\t " },
    },
  ] satisfies ReadonlyArray<{ code: MessageErrorCode; candidate: Message }>)(
    "rejects $code messages",
    async ({ code, candidate }) => {
      const service = createService({ store: new MemoryStore() });

      await expect(service.send(candidate)).rejects.toBeInstanceOf(MessageValidationError);
      await expect(service.send(candidate)).rejects.toMatchObject({ code });
    },
  );

  it("returns history and stops delivering to an unsubscribed listener", async () => {
    const historicalMessage = { ...message, id: "message-0" };
    const service = createService({ store: new MemoryStore([historicalMessage]) });
    const received: Message[] = [];
    const unsubscribe = service.subscribe(room.id, (receivedMessage) => {
      received.push(receivedMessage);
    });

    unsubscribe();
    await service.send(message);

    await expect(service.history(room.id)).resolves.toEqual([historicalMessage]);
    expect(received).toEqual([]);
  });

  it("acknowledges persisted messages when a listener throws and continues delivery", async () => {
    const listenerError = new Error("listener failed");
    const listenerErrors: unknown[] = [];
    const received: Message[] = [];
    const service = createService({
      store: new MemoryStore(),
      clock: () => "2026-08-06T00:02:00.000Z",
      onListenerError: (error) => {
        listenerErrors.push(error);
      },
    });
    service.subscribe(room.id, () => {
      throw listenerError;
    });
    service.subscribe(room.id, (receivedMessage) => {
      received.push(receivedMessage);
    });

    await expect(service.send(message)).resolves.toEqual({
      type: "message.accepted",
      requestId: "message-1",
      messageId: "message-1",
      persistedAt: "2026-08-06T00:02:00.000Z",
    });
    expect(received).toEqual([message]);
    expect(listenerErrors).toEqual([listenerError]);
  });

  it("reports async listener failures without interrupting later listeners or acknowledgement", async () => {
    const listenerError = new Error("async listener failed");
    const listenerErrors: unknown[] = [];
    const received: Message[] = [];
    const service = createService({
      store: new MemoryStore(),
      clock: () => "2026-08-06T00:02:00.000Z",
      onListenerError: async (error) => {
        await Promise.resolve();
        listenerErrors.push(error);
      },
    });
    service.subscribe(room.id, async () => {
      throw listenerError;
    });
    service.subscribe(room.id, (receivedMessage) => {
      received.push(receivedMessage);
    });

    await expect(service.send(message)).resolves.toEqual({
      type: "message.accepted",
      requestId: "message-1",
      messageId: "message-1",
      persistedAt: "2026-08-06T00:02:00.000Z",
    });
    await flushMicrotasks();

    expect(received).toEqual([message]);
    expect(listenerErrors).toEqual([listenerError]);
  });

  it("swallows rejected listener error hooks", async () => {
    const listenerError = new Error("listener failed");
    const hookError = new Error("error hook failed");
    const listenerErrors: unknown[] = [];
    const service = createService({
      store: new MemoryStore(),
      onListenerError: async (error) => {
        listenerErrors.push(error);
        throw hookError;
      },
    });
    service.subscribe(room.id, () => {
      throw listenerError;
    });

    await service.send(message);
    await flushMicrotasks();

    expect(listenerErrors).toEqual([listenerError]);
  });

  it("swallows synchronously thrown listener error hooks", async () => {
    const listenerError = new Error("listener failed");
    const hookError = new Error("synchronous error hook failed");
    const listenerErrors: unknown[] = [];
    const received: Message[] = [];
    const service = createService({
      store: new MemoryStore(),
      clock: () => "2026-08-06T00:02:00.000Z",
      onListenerError: (error) => {
        listenerErrors.push(error);
        throw hookError;
      },
    });
    service.subscribe(room.id, () => {
      throw listenerError;
    });
    service.subscribe(room.id, (receivedMessage) => {
      received.push(receivedMessage);
    });

    const acknowledgement = await service.send(message);
    await flushMicrotasks();

    expect(acknowledgement).toEqual({
      type: "message.accepted",
      requestId: "message-1",
      messageId: "message-1",
      persistedAt: "2026-08-06T00:02:00.000Z",
    });
    expect(received).toEqual([message]);
    expect(listenerErrors).toEqual([listenerError]);
  });
});

describe("JSONL message store", () => {
  it("reopens persisted messages in append order for their exact room", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-server-"));
    const filePath = join(directory, "messages", "message-log.jsonl");

    try {
      const firstStore = createJsonlMessageStore(filePath);
      await firstStore.append(message);

      const reopenedStore = createJsonlMessageStore(filePath);
      await expect(reopenedStore.list(room.id)).resolves.toEqual([message]);
      await expect(reopenedStore.list("another-room")).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves concurrent sends in invocation order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-server-"));
    const filePath = join(directory, "messages", "message-log.jsonl");
    const messages = [
      message,
      { ...message, id: "message-2" },
      { ...message, id: "message-3" },
    ];

    try {
      const service = createService({ store: createJsonlMessageStore(filePath) });

      await Promise.all(messages.map((value) => service.send(value)));

      const reopenedStore = createJsonlMessageStore(filePath);
      await expect(reopenedStore.list(room.id)).resolves.toEqual(messages);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues queued appends after a write rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-server-"));
    const parentPath = join(directory, "blocked-parent");
    const filePath = join(parentPath, "message-log.jsonl");

    try {
      await writeFile(parentPath, "not a directory", "utf8");
      const store = createJsonlMessageStore(filePath);

      await expect(store.append(message)).rejects.toThrow();

      await rm(parentPath);
      await store.append(message);

      const reopenedStore = createJsonlMessageStore(filePath);
      await expect(reopenedStore.list(room.id)).resolves.toEqual([message]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { description: "malformed JSON", line: "{not-json}" },
    { description: "a non-message JSON record", line: JSON.stringify({ id: "not-a-message" }) },
  ])("rejects $description instead of silently omitting it", async ({ line }) => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-server-"));
    const filePath = join(directory, "messages", "message-log.jsonl");

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${line}\n`, "utf8");
      const store = createJsonlMessageStore(filePath);

      await expect(store.list(room.id)).rejects.toBeInstanceOf(MessageStoreCorruptionError);
      await expect(store.list(room.id)).rejects.toMatchObject({ filePath, lineNumber: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
