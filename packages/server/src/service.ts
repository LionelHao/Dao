import {
  isMessageDraft,
  type Actor,
  type Message,
  type MessageAcceptedAck,
  type MessageDraft,
  type Room,
} from "@native-im/core";
import type { MessageStore } from "./store.js";

const MESSAGE_DRAFT_FIELDS = new Set(["id", "roomId", "body", "sentAt"]);

export type MessageErrorCode = "invalid_message" | "empty_message";

export class MessageValidationError extends Error {
  readonly status = 400 as const;
  readonly code: MessageErrorCode;

  constructor(code: MessageErrorCode) {
    super(code);
    this.name = "MessageValidationError";
    this.code = code;
  }
}

export class RoomAccessError extends Error {
  readonly status = 403 as const;
  readonly code = "room_forbidden" as const;

  constructor() {
    super("room_forbidden");
    this.name = "RoomAccessError";
  }
}

export type MessageListener = (message: Message) => void | Promise<void>;
export type ListenerErrorHandler = (error: unknown) => void | Promise<void>;

export interface MessageDirectory {
  getActor(actorId: string): Actor | undefined;
  messageRoom(roomId: string): Room | undefined;
}

export interface MessageService {
  send(actorId: string, draft: MessageDraft): Promise<MessageAcceptedAck>;
  subscribe(actorId: string, roomId: string, listener: MessageListener): () => void;
  history(actorId: string, roomId: string): Promise<readonly Message[]>;
}

export interface MessageServiceOptions {
  readonly directory: MessageDirectory;
  readonly store: MessageStore;
  readonly clock?: () => string;
  readonly onListenerError?: ListenerErrorHandler;
}

interface Subscription {
  readonly actorId: string;
  readonly listener: MessageListener;
}

function isStrictMessageDraft(value: unknown): value is MessageDraft {
  return (
    isMessageDraft(value) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && MESSAGE_DRAFT_FIELDS.has(key),
    ) &&
    Reflect.ownKeys(value).length === MESSAGE_DRAFT_FIELDS.size
  );
}

export function createMessageService(options: MessageServiceOptions): MessageService {
  const subscribersByRoom = new Map<string, Set<Subscription>>();
  const clock = options.clock ?? (() => new Date().toISOString());

  function reportListenerError(error: unknown): void {
    try {
      void Promise.resolve(options.onListenerError?.(error)).catch(() => undefined);
    } catch {
      // A listener error hook cannot alter persistence acknowledgement.
    }
  }

  function resolveAccess(actorId: string, roomId: string): Actor {
    const actor = options.directory.getActor(actorId);
    const room = options.directory.messageRoom(roomId);
    if (
      actor === undefined ||
      room === undefined ||
      !room.memberIds.includes(actor.id)
    ) {
      throw new RoomAccessError();
    }
    return actor;
  }

  function hasAccess(actorId: string, roomId: string): boolean {
    try {
      resolveAccess(actorId, roomId);
      return true;
    } catch (error: unknown) {
      if (error instanceof RoomAccessError) {
        return false;
      }
      throw error;
    }
  }

  return {
    async send(actorId: string, draft: MessageDraft): Promise<MessageAcceptedAck> {
      if (!isStrictMessageDraft(draft)) {
        throw new MessageValidationError("invalid_message");
      }
      if (draft.body.trim().length === 0) {
        throw new MessageValidationError("empty_message");
      }

      const actor = resolveAccess(actorId, draft.roomId);
      const message: Message = {
        ...draft,
        authorId: actor.id,
        authorKind: actor.kind,
      };
      const appendResult = await options.store.append(message);

      const acknowledgement: MessageAcceptedAck = {
        type: "message.accepted",
        requestId: message.id,
        messageId: message.id,
        persistedAt: clock(),
      };

      if (appendResult === "replayed") {
        return acknowledgement;
      }

      const subscriptions = subscribersByRoom.get(message.roomId);
      if (subscriptions !== undefined) {
        for (const subscription of [...subscriptions]) {
          if (!hasAccess(subscription.actorId, message.roomId)) {
            subscriptions.delete(subscription);
            continue;
          }
          try {
            void Promise.resolve(subscription.listener(message)).catch((error: unknown) => {
              reportListenerError(error);
            });
          } catch (error: unknown) {
            reportListenerError(error);
          }
        }
        if (subscriptions.size === 0) {
          subscribersByRoom.delete(message.roomId);
        }
      }

      return acknowledgement;
    },

    subscribe(actorId: string, roomId: string, listener: MessageListener): () => void {
      resolveAccess(actorId, roomId);
      const subscriptions = subscribersByRoom.get(roomId) ?? new Set<Subscription>();
      const subscription = { actorId, listener };
      subscriptions.add(subscription);
      subscribersByRoom.set(roomId, subscriptions);

      return () => {
        subscriptions.delete(subscription);
        if (subscriptions.size === 0) {
          subscribersByRoom.delete(roomId);
        }
      };
    },

    async history(actorId: string, roomId: string): Promise<readonly Message[]> {
      resolveAccess(actorId, roomId);
      return options.store.list(roomId);
    },
  };
}
