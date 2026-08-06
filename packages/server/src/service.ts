import {
  isMessage,
  type Actor,
  type Message,
  type MessageAcceptedAck,
  type Room,
} from "@native-im/core";
import type { MessageStore } from "./store.js";

export type MessageErrorCode =
  | "invalid_message"
  | "unknown_author"
  | "author_kind_mismatch"
  | "unknown_room"
  | "author_not_in_room"
  | "empty_message";

export class MessageValidationError extends Error {
  readonly code: MessageErrorCode;

  constructor(code: MessageErrorCode) {
    super(code);
    this.name = "MessageValidationError";
    this.code = code;
  }
}

export type MessageListener = (message: Message) => void | Promise<void>;
export type ListenerErrorHandler = (error: unknown) => void | Promise<void>;

export interface MessageService {
  send(message: Message): Promise<MessageAcceptedAck>;
  subscribe(roomId: string, listener: MessageListener): () => void;
  history(roomId: string): Promise<readonly Message[]>;
}

export interface MessageServiceOptions {
  actors: readonly Actor[];
  rooms: readonly Room[];
  store: MessageStore;
  clock?: () => string;
  onListenerError?: ListenerErrorHandler;
}

export function createMessageService(options: MessageServiceOptions): MessageService {
  const actorsById = new Map(options.actors.map((actor) => [actor.id, actor]));
  const roomsById = new Map(options.rooms.map((room) => [room.id, room]));
  const subscribersByRoom = new Map<string, Set<MessageListener>>();
  const clock = options.clock ?? (() => new Date().toISOString());

  function reportListenerError(error: unknown): void {
    try {
      void Promise.resolve(options.onListenerError?.(error)).catch(() => undefined);
    } catch {
      // A listener error hook cannot alter persistence acknowledgement.
    }
  }

  function validate(message: Message): void {
    if (!isMessage(message)) {
      throw new MessageValidationError("invalid_message");
    }

    const author = actorsById.get(message.authorId);
    if (author === undefined) {
      throw new MessageValidationError("unknown_author");
    }
    if (author.kind !== message.authorKind) {
      throw new MessageValidationError("author_kind_mismatch");
    }

    const room = roomsById.get(message.roomId);
    if (room === undefined) {
      throw new MessageValidationError("unknown_room");
    }
    if (!room.memberIds.includes(author.id)) {
      throw new MessageValidationError("author_not_in_room");
    }
    if (message.body.trim().length === 0) {
      throw new MessageValidationError("empty_message");
    }
  }

  return {
    async send(message: Message): Promise<MessageAcceptedAck> {
      validate(message);
      await options.store.append(message);

      const acknowledgement: MessageAcceptedAck = {
        type: "message.accepted",
        requestId: message.id,
        messageId: message.id,
        persistedAt: clock(),
      };

      const listeners = subscribersByRoom.get(message.roomId);
      if (listeners !== undefined) {
        for (const listener of [...listeners]) {
          try {
            void Promise.resolve(listener(message)).catch((error: unknown) => {
              reportListenerError(error);
            });
          } catch (error: unknown) {
            reportListenerError(error);
          }
        }
      }

      return acknowledgement;
    },

    subscribe(roomId: string, listener: MessageListener): () => void {
      const listeners = subscribersByRoom.get(roomId) ?? new Set<MessageListener>();
      listeners.add(listener);
      subscribersByRoom.set(roomId, listeners);

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          subscribersByRoom.delete(roomId);
        }
      };
    },

    history(roomId: string): Promise<readonly Message[]> {
      return options.store.list(roomId);
    },
  };
}
