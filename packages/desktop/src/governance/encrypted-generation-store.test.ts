import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialEncryption } from "../identity/credential-vault.js";
import {
  EncryptedGenerationStoreError,
  createEncryptedAuthorityGenerationStore,
} from "./encrypted-generation-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const wrapping: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Uint8Array.from(Buffer.from(value, "utf8")).reverse(),
  decryptString: (value) => Buffer.from(Uint8Array.from(value).reverse()).toString("utf8"),
};

function fixture(fault?: (point: "before-active-flip" | "after-active-flip") => void) {
  const create = async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft13-generation-store-"));
    directories.push(directory);
    const databasePath = join(directory, "authority-cache.sqlite");
    const store = createEncryptedAuthorityGenerationStore({
      databasePath,
      accountId: "account-secret",
      encryption: wrapping,
      ...(fault === undefined ? {} : { fault }),
    });
    return { directory, databasePath, store };
  };
  return create();
}

const oldRecords = [{ identity: "room", value: { roomId: "room-secret", body: "old-corpus" } }];
const newRecords = [{ identity: "room", value: { roomId: "room-secret", body: "new-corpus" } }];

function install(store: ReturnType<typeof createEncryptedAuthorityGenerationStore>, input: Readonly<{
  snapshotId: string; watermark: number; records: typeof oldRecords;
}>): void {
  store.beginRoomGeneration({ roomId: "room-secret", snapshotId: input.snapshotId,
    watermark: input.watermark, expectedCount: input.records.length, checksum: `${input.snapshotId}-sum` });
  store.stageRoomRecords("room-secret", input.snapshotId, input.records);
  store.commitRoomGeneration({ roomId: "room-secret", snapshotId: input.snapshotId,
    watermark: input.watermark, expectedCount: input.records.length, checksum: `${input.snapshotId}-sum` });
}

describe("encrypted Desktop authority generation store", () => {
  it("keeps staging invisible and atomically flips only a complete generation", async () => {
    const { store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    store.beginRoomGeneration({ roomId: "room-secret", snapshotId: "next", watermark: 12,
      expectedCount: 1, checksum: "next-sum" });
    store.stageRoomRecords("room-secret", "next", newRecords);
    expect(store.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords,
      cursor: { afterSeq: 9 } });
    store.commitRoomGeneration({ roomId: "room-secret", snapshotId: "next", watermark: 12,
      expectedCount: 1, checksum: "next-sum" });
    expect(store.readActiveRoom("room-secret")).toMatchObject({ records: newRecords,
      cursor: { afterSeq: 12 } });
    store.close();
  });

  it.each(["before-active-flip", "after-active-flip"] as const)(
    "rolls back a crash at %s and reopens the old complete generation",
    async (failurePoint) => {
      let armed = false;
      const { databasePath, store } = await fixture((point) => {
        if (armed && point === failurePoint) throw new Error(`crash:${point}`);
      });
      install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
      store.beginRoomGeneration({ roomId: "room-secret", snapshotId: "next", watermark: 12,
        expectedCount: 1, checksum: "next-sum" });
      store.stageRoomRecords("room-secret", "next", newRecords);
      armed = true;
      expect(() => store.commitRoomGeneration({ roomId: "room-secret", snapshotId: "next",
        watermark: 12, expectedCount: 1, checksum: "next-sum" })).toThrow(`crash:${failurePoint}`);
      store.close();
      const reopened = createEncryptedAuthorityGenerationStore({
        databasePath, accountId: "account-secret", encryption: wrapping,
      });
      expect(reopened.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords,
        cursor: { afterSeq: 9 } });
      reopened.close();
    },
  );

  it("persists the dual event ledger and applies ledger, projection and cursor atomically", async () => {
    const { databasePath, store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    expect(store.applyRoomEventBatch({ roomId: "room-secret", nextCursor: 10,
      events: [{ eventId: "event-secret", streamSeq: 10 }],
      upserts: [{ identity: "room", value: { roomId: "room-secret", body: "event-corpus" } }],
      deletes: [] })).toEqual({ appliedEventIds: ["event-secret"], replayedEventIds: [] });
    store.close();

    const reopened = createEncryptedAuthorityGenerationStore({
      databasePath, accountId: "account-secret", encryption: wrapping,
    });
    expect(reopened.applyRoomEventBatch({ roomId: "room-secret", nextCursor: 10,
      events: [{ eventId: "event-secret", streamSeq: 10 }], upserts: [], deletes: [] }))
      .toEqual({ appliedEventIds: [], replayedEventIds: ["event-secret"] });
    expect(() => reopened.applyRoomEventBatch({ roomId: "room-secret", nextCursor: 11,
      events: [{ eventId: "event-secret", streamSeq: 11 }], upserts: [], deletes: [] }))
      .toThrowError(EncryptedGenerationStoreError);
    expect(() => reopened.applyRoomEventBatch({ roomId: "room-secret", nextCursor: 11,
      events: [{ eventId: "different-event", streamSeq: 10 }], upserts: [], deletes: [] }))
      .toThrowError(EncryptedGenerationStoreError);
    expect(reopened.readActiveRoom("room-secret")).toMatchObject({
      records: [{ identity: "room", value: { body: "event-corpus" } }],
      cursor: { afterSeq: 10 },
    });
    reopened.close();
  });

  it.each([
    ["gap", 12, [{ eventId: "gap-event", streamSeq: 12 }]],
    ["backwards", 8, []],
  ] as const)("rejects %s without changing projection or cursor", async (_name, nextCursor, events) => {
    const { store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    expect(() => store.applyRoomEventBatch({ roomId: "room-secret", nextCursor,
      events, upserts: newRecords, deletes: [] })).toThrowError(EncryptedGenerationStoreError);
    expect(store.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords,
      cursor: { afterSeq: 9 } });
    store.close();
  });

  it("stores no account, Room, event, identity, corpus or raw data-key sentinel on disk", async () => {
    const { directory, store } = await fixture();
    install(store, { snapshotId: "snapshot-secret", watermark: 9, records: oldRecords });
    store.applyRoomEventBatch({ roomId: "room-secret", nextCursor: 10,
      events: [{ eventId: "event-secret", streamSeq: 10 }], upserts: [], deletes: [] });
    store.close();
    const files = await readdir(directory);
    const disk = Buffer.concat(await Promise.all(files.map((file) => readFile(join(directory, file)))));
    for (const sentinel of ["account-secret", "room-secret", "snapshot-secret", "event-secret",
      "old-corpus", "identity"]) {
      expect(disk.includes(Buffer.from(sentinel, "utf8")), `${sentinel} leaked`).toBe(false);
    }
  });

  it("fails closed for unavailable safeStorage, enforces bounds, and destroys residual files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft13-generation-store-"));
    directories.push(directory);
    const databasePath = join(directory, "authority-cache.sqlite");
    expect(() => createEncryptedAuthorityGenerationStore({ databasePath,
      accountId: "account-secret", encryption: { ...wrapping, isEncryptionAvailable: () => false } }))
      .toThrowError(EncryptedGenerationStoreError);
    const store = createEncryptedAuthorityGenerationStore({ databasePath,
      accountId: "account-secret", encryption: wrapping, limits: { maxRecordsPerRoom: 1,
        maxRecordBytes: 64, maxBatchEvents: 1 } });
    store.beginRoomGeneration({ roomId: "room-secret", snapshotId: "bounded", watermark: 0,
      expectedCount: 2, checksum: "bounded-sum" });
    expect(() => store.stageRoomRecords("room-secret", "bounded", [
      { identity: "one", value: { value: "one" } }, { identity: "two", value: { value: "two" } },
    ])).toThrowError(EncryptedGenerationStoreError);
    store.destroy();
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});
