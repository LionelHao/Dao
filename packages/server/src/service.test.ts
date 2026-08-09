import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Actor, Message, MessageDraft } from "@native-im/core";
import {
  createJsonlMessageStore,
  createMessageService,
  createRoomLifecycleService,
  MessageStoreCorruptionError,
  MessageValidationError,
  RoomAccessError,
  type MessageDirectory,
  type MessageErrorCode,
  type MessageService,
  type MessageStore,
  type RoomLifecycleService,
  type RoomLifecycleState,
  type StateStore,
} from "./index.js";

const owner = {
  id: "human-owner",
  kind: "human",
  displayName: "Lionel",
  reachability: "online",
} as const satisfies Actor;
const member = {
  id: "human-member",
  kind: "human",
  displayName: "Ada",
  reachability: "online",
} as const satisfies Actor;
const outsider = {
  id: "human-outsider",
  kind: "human",
  displayName: "Grace",
  reachability: "dnd",
} as const satisfies Actor;
const actors = [owner, member, outsider] as const;

const draft: MessageDraft = {
  id: "message-1",
  roomId: "room-1",
  body: "Hello from a human.",
  sentAt: "2026-08-06T00:01:00.000Z",
};

class MemoryStateStore<Value> implements StateStore<Value> {
  constructor(private value?: Value) {}

  async load(): Promise<Value | undefined> {
    return this.value;
  }

  async save(value: Value): Promise<void> {
    this.value = value;
  }
}

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
  readonly messages: Message[];

  constructor(messages: readonly Message[] = []) {
    this.messages = [...messages];
  }

  async append(message: Message): Promise<void> {
    this.messages.push(message);
  }

  async list(roomId: string): Promise<readonly Message[]> {
    return this.messages.filter((value) => value.roomId === roomId);
  }
}

function sequenceFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

async function createDirectory(options: {
  readonly includeMember?: boolean;
} = {}): Promise<{ readonly directory: RoomLifecycleService; readonly roomId: string }> {
  const directory = await createRoomLifecycleService({
    actors,
    state: new MemoryStateStore<RoomLifecycleState>(),
    clock: () => Date.parse("2026-08-09T08:00:00.000Z"),
    idFactory: sequenceFactory("room"),
    tokenFactory: sequenceFactory("invitation"),
  });
  const room = await directory.createRoom(owner.id, { name: "Native IM" });

  if (options.includeMember ?? true) {
    const invitation = await directory.inviteHuman(owner.id, {
      kind: "human-invitation",
      roomId: room.id,
      inviteeActorId: member.id,
    });
    await directory.respondToHumanInvitation(member.id, invitation.token, "accept");
  }

  return { directory, roomId: room.id };
}

async function createService(
  store: MessageStore,
  options: {
    readonly directory?: MessageDirectory;
    readonly clock?: () => string;
    readonly onListenerError?: (error: unknown) => void | Promise<void>;
  } = {},
): Promise<{
  readonly service: MessageService;
  readonly directory: RoomLifecycleService;
  readonly roomId: string;
}> {
  const fixture = await createDirectory();
  return {
    ...fixture,
    service: createMessageService({
      directory: options.directory ?? fixture.directory,
      store,
      clock: options.clock,
      onListenerError: options.onListenerError,
    }),
  };
}

function draftFor(roomId: string, id = draft.id): MessageDraft {
  return { ...draft, id, roomId };
}

function authoritativeMessage(
  actor: Actor,
  roomId: string,
  id = draft.id,
): Message {
  return {
    ...draftFor(roomId, id),
    authorId: actor.id,
    authorKind: actor.kind,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function expectAllRoomActionsForbidden(
  service: MessageService,
  actorId: string,
  roomId: string,
): Promise<void> {
  await expect(service.history(actorId, roomId)).rejects.toMatchObject({
    status: 403,
    code: "room_forbidden",
  });
  expect(() => service.subscribe(actorId, roomId, () => undefined)).toThrow(
    expect.objectContaining({ status: 403, code: "room_forbidden" }),
  );
  await expect(service.send(actorId, draftFor(roomId, `forbidden-${actorId}`))).rejects.toMatchObject({
    status: 403,
    code: "room_forbidden",
  });
}

describe("message service", () => {
  it("derives authoritative authorship and persists before acknowledgement or fanout", async () => {
    const store = new DeferredMemoryStore();
    const { service, roomId } = await createService(store, {
      clock: () => "2026-08-06T00:02:00.000Z",
    });
    const received: Message[] = [];
    service.subscribe(owner.id, roomId, (message) => {
      received.push(message);
    });

    const acknowledgement = service.send(owner.id, draftFor(roomId));
    await Promise.resolve();

    expect(store.events).toEqual(["append:message-1"]);
    expect(store.messages).toEqual([authoritativeMessage(owner, roomId)]);
    expect(received).toEqual([]);

    store.releaseAppend();

    await expect(acknowledgement).resolves.toEqual({
      type: "message.accepted",
      requestId: "message-1",
      messageId: "message-1",
      persistedAt: "2026-08-06T00:02:00.000Z",
    });
    expect(received).toEqual([authoritativeMessage(owner, roomId)]);
  });

  it.each([
    {
      code: "invalid_message",
      candidate: { ...draft, body: 42 } as unknown as MessageDraft,
    },
    {
      code: "invalid_message",
      candidate: { ...draft, authorId: member.id } as unknown as MessageDraft,
    },
    {
      code: "invalid_message",
      candidate: { ...draft, authorKind: member.kind } as unknown as MessageDraft,
    },
    {
      code: "invalid_message",
      candidate: { ...draft, unexpected: true } as unknown as MessageDraft,
    },
    {
      code: "empty_message",
      candidate: { ...draft, body: " \n\t " },
    },
  ] satisfies ReadonlyArray<{ code: MessageErrorCode; candidate: MessageDraft }>) (
    "rejects a strict draft with $code",
    async ({ code, candidate }) => {
      const { service, roomId } = await createService(new MemoryStore());

      await expect(service.send(owner.id, { ...candidate, roomId })).rejects.toBeInstanceOf(
        MessageValidationError,
      );
      await expect(service.send(owner.id, { ...candidate, roomId })).rejects.toMatchObject({ code });
    },
  );

  it("maps missing actors, rooms, non-members, and archived rooms to the same access error", async () => {
    const { service, directory, roomId } = await createService(new MemoryStore());

    await expectAllRoomActionsForbidden(service, "missing-actor", roomId);
    await expectAllRoomActionsForbidden(service, outsider.id, roomId);
    await expectAllRoomActionsForbidden(service, owner.id, "missing-room");

    await directory.archiveRoom(owner.id, roomId);
    await expectAllRoomActionsForbidden(service, owner.id, roomId);

    await expect(service.history(owner.id, roomId)).rejects.toBeInstanceOf(RoomAccessError);
  });

  it("revokes removed members from history, send, subscribe, addressing, and active fanout", async () => {
    const store = new MemoryStore();
    const { service, directory, roomId } = await createService(store);
    const receivedByMember: Message[] = [];
    service.subscribe(member.id, roomId, (message) => {
      receivedByMember.push(message);
    });

    const memberMessage = authoritativeMessage(member, roomId, "member-before-removal");
    await service.send(member.id, draftFor(roomId, memberMessage.id));
    await directory.removeMember(owner.id, roomId, member.id);
    const ownerMessage = authoritativeMessage(owner, roomId, "owner-after-removal");
    await service.send(owner.id, draftFor(roomId, ownerMessage.id));

    await expect(service.history(owner.id, roomId)).resolves.toEqual([
      memberMessage,
      ownerMessage,
    ]);
    expect(directory.messageRoom(roomId)?.memberIds).not.toContain(member.id);
    expect(receivedByMember).toEqual([memberMessage]);
    await expectAllRoomActionsForbidden(service, member.id, roomId);
  });

  it("returns history and stops delivering to an unsubscribed listener", async () => {
    const { directory, roomId } = await createDirectory();
    const historicalMessage = authoritativeMessage(owner, roomId, "message-0");
    const service = createMessageService({
      directory,
      store: new MemoryStore([historicalMessage]),
    });
    const received: Message[] = [];
    const unsubscribe = service.subscribe(owner.id, roomId, (message) => {
      received.push(message);
    });

    unsubscribe();
    await service.send(owner.id, draftFor(roomId));

    await expect(service.history(owner.id, roomId)).resolves.toEqual([
      historicalMessage,
      authoritativeMessage(owner, roomId),
    ]);
    expect(received).toEqual([]);
  });

  it("acknowledges persisted messages when a listener throws and continues delivery", async () => {
    const listenerError = new Error("listener failed");
    const listenerErrors: unknown[] = [];
    const received: Message[] = [];
    const { service, roomId } = await createService(new MemoryStore(), {
      clock: () => "2026-08-06T00:02:00.000Z",
      onListenerError: (error) => {
        listenerErrors.push(error);
      },
    });
    service.subscribe(owner.id, roomId, () => {
      throw listenerError;
    });
    service.subscribe(member.id, roomId, (message) => {
      received.push(message);
    });

    await expect(service.send(owner.id, draftFor(roomId))).resolves.toMatchObject({
      type: "message.accepted",
      messageId: draft.id,
    });
    expect(received).toEqual([authoritativeMessage(owner, roomId)]);
    expect(listenerErrors).toEqual([listenerError]);
  });

  it("reports async listener failures without interrupting later listeners or acknowledgement", async () => {
    const listenerError = new Error("async listener failed");
    const listenerErrors: unknown[] = [];
    const received: Message[] = [];
    const { service, roomId } = await createService(new MemoryStore(), {
      onListenerError: async (error) => {
        await Promise.resolve();
        listenerErrors.push(error);
      },
    });
    service.subscribe(owner.id, roomId, async () => {
      throw listenerError;
    });
    service.subscribe(member.id, roomId, (message) => {
      received.push(message);
    });

    await expect(service.send(owner.id, draftFor(roomId))).resolves.toMatchObject({
      type: "message.accepted",
      messageId: draft.id,
    });
    await flushMicrotasks();

    expect(received).toEqual([authoritativeMessage(owner, roomId)]);
    expect(listenerErrors).toEqual([listenerError]);
  });

  it("swallows rejected and synchronously thrown listener error hooks", async () => {
    for (const synchronous of [false, true]) {
      const listenerError = new Error("listener failed");
      const listenerErrors: unknown[] = [];
      const { service, roomId } = await createService(new MemoryStore(), {
        onListenerError: (error) => {
          listenerErrors.push(error);
          if (synchronous) {
            throw new Error("synchronous error hook failed");
          }
          return Promise.reject(new Error("async error hook failed"));
        },
      });
      service.subscribe(owner.id, roomId, () => {
        throw listenerError;
      });

      await expect(service.send(owner.id, draftFor(roomId))).resolves.toMatchObject({
        type: "message.accepted",
      });
      await flushMicrotasks();
      expect(listenerErrors).toEqual([listenerError]);
    }
  });
});

describe("JSONL message store", () => {
  it("reopens persisted messages in append order for their exact room", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-server-"));
    const filePath = join(directory, "messages", "message-log.jsonl");
    const message = authoritativeMessage(owner, draft.roomId);

    try {
      const firstStore = createJsonlMessageStore(filePath);
      await firstStore.append(message);

      const reopenedStore = createJsonlMessageStore(filePath);
      await expect(reopenedStore.list(draft.roomId)).resolves.toEqual([message]);
      await expect(reopenedStore.list("another-room")).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves concurrent sends in invocation order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-server-"));
    const filePath = join(directory, "messages", "message-log.jsonl");

    try {
      const { service, roomId } = await createService(createJsonlMessageStore(filePath));
      const drafts = ["message-1", "message-2", "message-3"].map((id) =>
        draftFor(roomId, id),
      );

      await Promise.all(drafts.map((value) => service.send(owner.id, value)));

      const reopenedStore = createJsonlMessageStore(filePath);
      await expect(reopenedStore.list(roomId)).resolves.toEqual(
        drafts.map((value) => ({ ...value, authorId: owner.id, authorKind: owner.kind })),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues queued appends after a write rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-server-"));
    const parentPath = join(directory, "blocked-parent");
    const filePath = join(parentPath, "message-log.jsonl");
    const message = authoritativeMessage(owner, draft.roomId);

    try {
      await writeFile(parentPath, "not a directory", "utf8");
      const store = createJsonlMessageStore(filePath);

      await expect(store.append(message)).rejects.toThrow();

      await rm(parentPath);
      await store.append(message);

      const reopenedStore = createJsonlMessageStore(filePath);
      await expect(reopenedStore.list(draft.roomId)).resolves.toEqual([message]);
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

      await expect(store.list(draft.roomId)).rejects.toBeInstanceOf(MessageStoreCorruptionError);
      await expect(store.list(draft.roomId)).rejects.toMatchObject({ filePath, lineNumber: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
