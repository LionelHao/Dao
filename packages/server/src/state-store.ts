import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StateStore<T> {
  load(): Promise<T | undefined>;
  save(value: T): Promise<void>;
}

export class StateStoreCorruptionError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`Invalid state at ${filePath}`);
    this.name = "StateStoreCorruptionError";
    this.filePath = filePath;
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

export function createJsonStateStore<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
): StateStore<T> {
  let saveQueue = Promise.resolve();

  return {
    async load(): Promise<T | undefined> {
      let content: string;

      try {
        content = await readFile(filePath, "utf8");
      } catch (error: unknown) {
        if (isMissingFile(error)) {
          return undefined;
        }
        throw error;
      }

      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch {
        throw new StateStoreCorruptionError(filePath);
      }

      if (!guard(value)) {
        throw new StateStoreCorruptionError(filePath);
      }

      return value;
    },

    save(value: T): Promise<void> {
      const write = saveQueue.then(async () => {
        if (!guard(value)) {
          throw new TypeError("state store only persists values accepted by its guard");
        }

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(`${filePath}.tmp`, JSON.stringify(value), {
          encoding: "utf8",
          flush: true,
        });
        await rename(`${filePath}.tmp`, filePath);
      });
      saveQueue = write.catch(() => undefined);

      return write;
    },
  };
}
