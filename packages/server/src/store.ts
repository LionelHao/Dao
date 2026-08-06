import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isMessage, type Message } from "@native-im/core";

export interface MessageStore {
  append(message: Message): Promise<void>;
  list(roomId: string): Promise<readonly Message[]>;
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

export function createJsonlMessageStore(filePath: string): MessageStore {
  let appendQueue = Promise.resolve();

  return {
    append(message: Message): Promise<void> {
      if (!isMessage(message)) {
        return Promise.reject(new TypeError("message store only persists valid messages"));
      }

      const write = appendQueue.then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        await appendFile(filePath, `${JSON.stringify(message)}\n`, {
          encoding: "utf8",
          flush: true,
        });
      });
      appendQueue = write.catch(() => undefined);

      return write;
    },

    async list(roomId: string): Promise<readonly Message[]> {
      let content: string;

      try {
        content = await readFile(filePath, "utf8");
      } catch (error: unknown) {
        if (isMissingFile(error)) {
          return [];
        }
        throw error;
      }

      const lines = content.split("\n");
      const messages: Message[] = [];
      for (const [index, line] of lines.entries()) {
        if (index === lines.length - 1 && line.length === 0) {
          continue;
        }

        const message = parseMessage(filePath, index + 1, line);
        if (message.roomId === roomId) {
          messages.push(message);
        }
      }

      return messages;
    },
  };
}
