import {
  isMessageDraft,
  type Actor,
  type Message,
  type MessageAcceptedAck,
  type MessageDraft,
  type Room,
} from "@native-im/core";
import type { MessageStore } from "./store.js";
import {
  isInternalAgentCommandContext,
  type AuthenticatedCommandContext,
  type AuthenticatedSessionContext,
  type CommandStore,
  type InternalAgentCommandContext,
  type SyncQueryStore,
} from "./persistence/contracts.js";

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
  send(
    context: AuthenticatedCommandContext | InternalAgentCommandContext,
    draft: MessageDraft,
  ): Promise<MessageAcceptedAck>;
  subscribe(actorId: string, roomId: string, listener: MessageListener): () => void;
  history(actorId: string, roomId: string): Promise<readonly Message[]>;
  history(
    context: AuthenticatedSessionContext,
    roomId: string,
  ): Promise<readonly Message[]>;
}

export interface MessageServiceOptions {
  readonly directory?: MessageDirectory;
  readonly store?: MessageStore;
  readonly commandStore?: CommandStore;
  readonly queryStore?: Pick<SyncQueryStore, "readHistory">;
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

function isAuthenticatedCommandContext(
  value: unknown,
): value is AuthenticatedCommandContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const context = value as Record<string, unknown>;
  const principal = context.principal;
  return context.kind === "human" &&
    typeof context.sessionId === "string" && context.sessionId.length > 0 &&
    typeof context.sessionFamilyId === "string" && context.sessionFamilyId.length > 0 &&
    typeof context.requestId === "string" && context.requestId.length > 0 &&
    typeof context.idempotencyKey === "string" && context.idempotencyKey.length > 0 &&
    typeof principal === "object" && principal !== null &&
    typeof (principal as Record<string, unknown>).accountId === "string" &&
    typeof (principal as Record<string, unknown>).actorId === "string";
}

function sessionContext(
  context: AuthenticatedCommandContext,
): AuthenticatedSessionContext {
  return {
    sessionId: context.sessionId,
    sessionFamilyId: context.sessionFamilyId,
    principal: context.principal,
  };
}

export function createMessageService(options: MessageServiceOptions): MessageService {
  const subscribersByRoom = new Map<string, Set<Subscription>>();
  const clock = options.clock ?? (() => new Date().toISOString());
  const usesAuthority = options.commandStore !== undefined || options.queryStore !== undefined;
  if (usesAuthority && (options.commandStore === undefined || options.queryStore === undefined)) {
    throw new TypeError("Message authority requires commandStore and queryStore");
  }
  if (!usesAuthority && (options.store === undefined || options.directory === undefined)) {
    throw new TypeError("Legacy message service requires a directory and store");
  }

  function reportListenerError(error: unknown): void {
    try {
      void Promise.resolve(options.onListenerError?.(error)).catch(() => undefined);
    } catch {
      // A listener error hook cannot alter persistence acknowledgement.
    }
  }

  function resolveAccess(actorId: string, roomId: string): Actor {
    const actor = options.directory?.getActor(actorId);
    const room = options.directory?.messageRoom(roomId);
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
    async send(
      actorOrContext: string | AuthenticatedCommandContext | InternalAgentCommandContext,
      draft: MessageDraft,
    ): Promise<MessageAcceptedAck> {
      if (!isStrictMessageDraft(draft)) {
        throw new MessageValidationError("invalid_message");
      }
      if (draft.body.trim().length === 0) {
        throw new MessageValidationError("empty_message");
      }

      if (usesAuthority) {
        const command = { type: "message.send", roomId: draft.roomId, payload: draft } as const;
        const acknowledgement = isInternalAgentCommandContext(actorOrContext)
          ? await options.commandStore!.executeAgent(actorOrContext, command)
          : isAuthenticatedCommandContext(actorOrContext)
            ? await options.commandStore!.executeHuman(actorOrContext, command)
            : (() => { throw new RoomAccessError(); })();
        return {
          type: "message.accepted",
          requestId: actorOrContext.requestId,
          messageId: acknowledgement.aggregateId,
          persistedAt: acknowledgement.acceptedAt,
        };
      }

      if (typeof actorOrContext !== "string") {
        throw new RoomAccessError();
      }

      const actor = resolveAccess(actorOrContext, draft.roomId);
      const message: Message = {
        ...draft,
        authorId: actor.id,
        authorKind: actor.kind,
      };
      const appendResult = await options.store!.append(message);

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
      if (usesAuthority) {
        throw new TypeError("Authoritative message subscriptions require outbox delivery");
      }
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

    async history(
      actorOrContext: string | AuthenticatedSessionContext,
      roomId: string,
    ): Promise<readonly Message[]> {
      if (usesAuthority) {
        if (typeof actorOrContext === "string") {
          throw new RoomAccessError();
        }
        return options.queryStore!.readHistory(
          isAuthenticatedCommandContext(actorOrContext)
            ? sessionContext(actorOrContext)
            : actorOrContext,
          roomId,
        );
      }
      if (typeof actorOrContext !== "string") {
        throw new RoomAccessError();
      }
      resolveAccess(actorOrContext, roomId);
      return options.store!.list(roomId);
    },
  };
}
