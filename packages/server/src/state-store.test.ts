import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJsonStateStore, StateStoreCorruptionError } from "./index.js";

interface ExampleState {
  readonly version: 1;
  readonly value: string;
}

function isExampleState(value: unknown): value is ExampleState {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "value" in value &&
    typeof value.value === "string"
  );
}

describe("JSON state store", () => {
  it("persists an atomic replacement and reloads it from a new store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-state-store-"));
    const filePath = join(directory, "state", "example.json");

    try {
      const firstStore = createJsonStateStore(filePath, isExampleState);
      await expect(firstStore.load()).resolves.toBeUndefined();

      await firstStore.save({ version: 1, value: "persisted" });

      const reopenedStore = createJsonStateStore(filePath, isExampleState);
      await expect(reopenedStore.load()).resolves.toEqual({
        version: 1,
        value: "persisted",
      });
      await expect(readFile(`${filePath}.tmp`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { description: "malformed JSON", content: "{not-json}" },
    {
      description: "JSON rejected by the state guard",
      content: JSON.stringify({ version: 1, value: 42 }),
    },
  ])("reports $description as state corruption", async ({ content }) => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-state-store-"));
    const filePath = join(directory, "state", "example.json");

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      const store = createJsonStateStore(filePath, isExampleState);

      await expect(store.load()).rejects.toBeInstanceOf(StateStoreCorruptionError);
      await expect(store.load()).rejects.toMatchObject({ filePath });
      await expect(store.load()).rejects.toThrow(`Invalid state at ${filePath}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent saves so the last invocation wins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-state-store-"));
    const filePath = join(directory, "state", "example.json");
    const values = Array.from({ length: 20 }, (_, index) => ({
      version: 1 as const,
      value: `value-${index}-${"x".repeat(index * 1024)}`,
    }));

    try {
      const store = createJsonStateStore(filePath, isExampleState);
      await Promise.all(values.map((value) => store.save(value)));

      await expect(store.load()).resolves.toEqual(values.at(-1));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues queued saves after an earlier write rejects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-state-store-"));
    const blockedParent = join(directory, "blocked-parent");
    const filePath = join(blockedParent, "example.json");

    try {
      await writeFile(blockedParent, "not a directory", "utf8");
      const store = createJsonStateStore(filePath, isExampleState);

      await expect(store.save({ version: 1, value: "rejected" })).rejects.toThrow();

      await rm(blockedParent);
      await store.save({ version: 1, value: "recovered" });

      await expect(store.load()).resolves.toEqual({ version: 1, value: "recovered" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
