import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isMessage, type Message } from "@native-im/core";

export type MessageAppendResult = "appended" | "replayed";
export type MessageStoreErrorCode = "message_id_conflict";

export interface MessageStore {
  append(message: Message): Promise<MessageAppendResult>;
  list(roomId: string): Promise<readonly Message[]>;
}

export class MessageIdConflictError extends Error {
  readonly status = 409 as const;
  readonly code = "message_id_conflict" as const;
  readonly messageId: string;

  constructor(messageId: string) {
    super("message_id_conflict");
    this.name = "MessageIdConflictError";
    this.messageId = messageId;
  }
}

export class MessageStoreCorruptionError extends Error {
  readonly filePath: string;
  readonly lineNumber: number;

  constructor(filePath: string, lineNumber: number) {
    super(`Invalid message log record at ${filePath}:${lineNumber}`);
    this.name = "MessageStoreCorruptionError";
    this.filePath = filePath;
    this.lineNumber = lineNumber;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parseMessage(filePath: string, lineNumber: number, line: string): Message {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    throw new MessageStoreCorruptionError(filePath, lineNumber);
  }

  if (!isMessage(value)) {
    throw new MessageStoreCorruptionError(filePath, lineNumber);
  }
  return value;
}

function sameMessage(left: Message, right: Message): boolean {
  return (
    left.id === right.id &&
    left.roomId === right.roomId &&
    left.authorId === right.authorId &&
    left.authorKind === right.authorKind &&
    left.body === right.body &&
    left.sentAt === right.sentAt
  );
}

async function readAllMessages(filePath: string): Promise<readonly Message[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }

  const messages: Message[] = [];
  const messageIds = new Set<string>();
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length === 0 && index === lines.length - 1) {
      continue;
    }
    const message = parseMessage(filePath, index + 1, line);
    if (messageIds.has(message.id)) {
      throw new MessageStoreCorruptionError(filePath, index + 1);
    }
    messageIds.add(message.id);
    messages.push(message);
  }
  return messages;
}

export function createJsonlMessageStore(filePath: string): MessageStore {
  let appendQueue = Promise.resolve();
  let messagesById: Map<string, Message> | undefined;

  async function indexedMessages(): Promise<Map<string, Message>> {
    if (messagesById === undefined) {
      const messages = await readAllMessages(filePath);
      messagesById = new Map(messages.map((message) => [message.id, message]));
    }
    return messagesById;
  }

  return {
    append(message: Message): Promise<MessageAppendResult> {
      if (!isMessage(message)) {
        return Promise.reject(new TypeError("message store only persists valid messages"));
      }

      const write = appendQueue.then(async () => {
        const index = await indexedMessages();
        const existing = index.get(message.id);
        if (existing !== undefined) {
          if (sameMessage(existing, message)) {
            return "replayed" as const;
          }
          throw new MessageIdConflictError(message.id);
        }

        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, `${JSON.stringify(message)}\n`, {
          encoding: "utf8",
          flush: true,
        });
        index.set(message.id, message);
        return "appended" as const;
      });
      appendQueue = write.then(
        () => undefined,
        () => undefined,
      );
      return write;
    },

    async list(roomId: string): Promise<readonly Message[]> {
      await appendQueue;
      const messages = await readAllMessages(filePath);
      return messages.filter((message) => message.roomId === roomId);
    },
  };
}
