import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isMessage, type Message } from "@native-im/core";

export type MessageAppendResult = "appended" | "replayed";
export type MessageStoreErrorCode = "message_id_conflict";

export interface MessageStore {
  append(message: Message): Promise<MessageAppendResult>;
  list(roomId: string): Promise<readonly Message[]>;
}

interface MessageStoreCoordinator {
  queue: Promise<void>;
}

const coordinatorsByFilePath = new Map<string, MessageStoreCoordinator>();

function coordinatorFor(filePath: string): MessageStoreCoordinator {
  const existing = coordinatorsByFilePath.get(filePath);
  if (existing !== undefined) {
    return existing;
  }
  const coordinator = { queue: Promise.resolve() };
  coordinatorsByFilePath.set(filePath, coordinator);
  return coordinator;
}

function runExclusive<Result>(
  coordinator: MessageStoreCoordinator,
  operation: () => Promise<Result>,
): Promise<Result> {
  const result = coordinator.queue.then(operation);
  coordinator.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
  const canonicalFilePath = resolve(filePath);
  const coordinator = coordinatorFor(canonicalFilePath);

  return {
    append(message: Message): Promise<MessageAppendResult> {
      return runExclusive(coordinator, async () => {
        if (!isMessage(message)) {
          throw new TypeError("message store only persists valid messages");
        }

        const messages = await readAllMessages(canonicalFilePath);
        const existing = messages.find((candidate) => candidate.id === message.id);
        if (existing !== undefined) {
          if (sameMessage(existing, message)) {
            return "replayed" as const;
          }
          throw new MessageIdConflictError(message.id);
        }

        await mkdir(dirname(canonicalFilePath), { recursive: true });
        await appendFile(canonicalFilePath, `${JSON.stringify(message)}\n`, {
          encoding: "utf8",
          flush: true,
        });
        return "appended" as const;
      });
    },

    list(roomId: string): Promise<readonly Message[]> {
      return runExclusive(coordinator, async () => {
        const messages = await readAllMessages(canonicalFilePath);
        return messages.filter((message) => message.roomId === roomId);
      });
    },
  };
}
