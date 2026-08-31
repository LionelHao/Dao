import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialEncryption } from "../identity/credential-vault.js";
import {
  EncryptedGenerationStoreError,
  authorityGenerationChecksum,
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

const oldRecords = [{ identity: "record-identity-secret",
  value: { roomId: "room-secret", body: "old-corpus" } }];
const newRecords = [{ identity: "record-identity-secret",
  value: { roomId: "room-secret", body: "new-corpus" } }];

function install(store: ReturnType<typeof createEncryptedAuthorityGenerationStore>, input: Readonly<{
  snapshotId: string; watermark: number; records: typeof oldRecords;
}>): void {
  const checksum = authorityGenerationChecksum("room", input.records.map((record) => record.value));
  store.beginRoomGeneration({ roomId: "room-secret", snapshotId: input.snapshotId,
    watermark: input.watermark, expectedCount: input.records.length, checksum });
  store.stageRoomRecords("room-secret", input.snapshotId, input.records);
  store.commitRoomGeneration({ roomId: "room-secret", snapshotId: input.snapshotId,
    watermark: input.watermark, expectedCount: input.records.length, checksum });
}

describe("encrypted Desktop authority generation store", () => {
  it("keeps staging invisible and atomically flips only a complete generation", async () => {
    const { store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    const nextChecksum = authorityGenerationChecksum("room", newRecords.map((record) => record.value));
    store.beginRoomGeneration({ roomId: "room-secret", snapshotId: "next", watermark: 12,
      expectedCount: 1, checksum: nextChecksum });
    store.stageRoomRecords("room-secret", "next", newRecords);
    expect(store.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords,
      cursor: { afterSeq: 9 } });
    store.commitRoomGeneration({ roomId: "room-secret", snapshotId: "next", watermark: 12,
      expectedCount: 1, checksum: nextChecksum });
    expect(store.readActiveRoom("room-secret")).toMatchObject({ records: newRecords,
      cursor: { afterSeq: 12 } });
    store.close();
  });

  it("atomically replaces an active generation when a valid repair repeats the same snapshot", async () => {
    const { store } = await fixture();
    install(store, { snapshotId: "same-fixed-snapshot", watermark: 9, records: oldRecords });
    const checksum = authorityGenerationChecksum("room", oldRecords.map((record) => record.value));

    store.beginRoomGeneration({ roomId: "room-secret", snapshotId: "same-fixed-snapshot",
      watermark: 9, expectedCount: 1, checksum });
    store.stageRoomRecords("room-secret", "same-fixed-snapshot", oldRecords);
    expect(store.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords,
      cursor: { afterSeq: 9 } });

    store.commitRoomGeneration({ roomId: "room-secret", snapshotId: "same-fixed-snapshot",
      watermark: 9, expectedCount: 1, checksum });
    expect(store.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords,
      cursor: { afterSeq: 9 } });
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
      const nextChecksum = authorityGenerationChecksum("room", newRecords.map((record) => record.value));
      store.beginRoomGeneration({ roomId: "room-secret", snapshotId: "next", watermark: 12,
        expectedCount: 1, checksum: nextChecksum });
      store.stageRoomRecords("room-secret", "next", newRecords);
      armed = true;
      expect(() => store.commitRoomGeneration({ roomId: "room-secret", snapshotId: "next",
        watermark: 12, expectedCount: 1, checksum: nextChecksum })).toThrow(`crash:${failurePoint}`);
      store.close();
      const reopened = createEncryptedAuthorityGenerationStore({
        databasePath, accountId: "account-secret", encryption: wrapping,
      });
      expect(reopened.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords,
        cursor: { afterSeq: 9 } });
      reopened.close();
    },
  );

  it("decrypts and canonically verifies staged disk rows before flipping the active head", async () => {
    const { databasePath, store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    const nextChecksum = authorityGenerationChecksum("room", newRecords.map((record) => record.value));
    store.beginRoomGeneration({ roomId: "room-secret", snapshotId: "next", watermark: 12,
      expectedCount: 1, checksum: nextChecksum });
    store.stageRoomRecords("room-secret", "next", newRecords);

    const tamper = new DatabaseSync(databasePath);
    tamper.prepare(`
      UPDATE cache_records SET sealed_record = randomblob(64)
      WHERE generation_id = (
        SELECT generation_id FROM cache_generations WHERE generation_state = 'staging'
      )
    `).run();
    tamper.close();

    expect(() => store.commitRoomGeneration({ roomId: "room-secret", snapshotId: "next",
      watermark: 12, expectedCount: 1, checksum: nextChecksum }))
      .toThrowError(expect.objectContaining({ code: "integrity_failed" }));
    expect(store.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords,
      cursor: { afterSeq: 9 } });
    store.close();
  });

  it("rejects a staged canonical-checksum mismatch while preserving the previous active generation", async () => {
    const { store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    const wrongChecksum = authorityGenerationChecksum("room", oldRecords.map((record) => record.value));
    store.beginRoomGeneration({ roomId: "room-secret", snapshotId: "next", watermark: 12,
      expectedCount: 1, checksum: wrongChecksum });
    store.stageRoomRecords("room-secret", "next", newRecords);
    expect(() => store.commitRoomGeneration({ roomId: "room-secret", snapshotId: "next",
      watermark: 12, expectedCount: 1, checksum: wrongChecksum }))
      .toThrowError(expect.objectContaining({ code: "integrity_failed" }));
    expect(store.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords,
      cursor: { afterSeq: 9 } });
    store.close();
  });

  it("recovers encrypted Room discovery without a legacy cache catalog after restart", async () => {
    const { databasePath, store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    expect(store.listActiveRoomIds()).toEqual(["room-secret"]);
    store.close();
    const reopened = createEncryptedAuthorityGenerationStore({
      databasePath, accountId: "account-secret", encryption: wrapping,
    });
    expect(reopened.listActiveRoomIds()).toEqual(["room-secret"]);
    expect(reopened.readActiveRoom("room-secret")).toMatchObject({ records: oldRecords });
    reopened.close();
  });

  it("persists the dual event ledger and applies ledger, projection and cursor atomically", async () => {
    const { databasePath, store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    expect(store.applyRoomEventBatch({ roomId: "room-secret", nextCursor: 10,
      events: [{ eventId: "event-secret", streamSeq: 10 }],
      upserts: [{ identity: "record-identity-secret",
        value: { roomId: "room-secret", body: "event-corpus" } }],
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
      records: [{ identity: "record-identity-secret", value: { body: "event-corpus" } }],
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
    store.writeOfflineLease("room-secret", {
      token: "offline-token-secret",
      claims: { leaseId: "offline-lease-secret" },
    });
    expect(store.readOfflineLease("room-secret")).toEqual({
      token: "offline-token-secret",
      claims: { leaseId: "offline-lease-secret" },
    });
    store.close();
    const files = await readdir(directory);
    const fileBytes = await Promise.all(files.map((file) => readFile(join(directory, file))));
    const disk = Buffer.concat(fileBytes);
    for (const sentinel of ["account-secret", "room-secret", "snapshot-secret", "event-secret",
      "old-corpus", "record-identity-secret", "offline-token-secret", "offline-lease-secret"]) {
      const leakingFiles = files.filter((_file, index) =>
        fileBytes[index]!.includes(Buffer.from(sentinel, "utf8")));
      expect(disk.includes(Buffer.from(sentinel, "utf8")),
        `${sentinel} leaked in ${leakingFiles.join(",")}`).toBe(false);
    }
  });

  it("binds an offline lease to the exact active generation and drops it on atomic replacement", async () => {
    const { store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    store.writeOfflineLease("room-secret", { token: "lease-for-old-generation" });
    expect(store.readOfflineLease("room-secret")).toEqual({ token: "lease-for-old-generation" });

    install(store, { snapshotId: "new", watermark: 12, records: newRecords });
    expect(store.readOfflineLease("room-secret")).toBeUndefined();
    store.close();
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
    expect(() => store.beginRoomGeneration({ roomId: "room-secret", snapshotId: "bounded",
      watermark: 0, expectedCount: 2, checksum: "bounded-sum" }))
      .toThrowError(EncryptedGenerationStoreError);
    store.destroy();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("clears only a revoked Room and physically removes account state on logout", async () => {
    const { directory, store } = await fixture();
    install(store, { snapshotId: "room-one", watermark: 9, records: oldRecords });
    store.beginRoomGeneration({ roomId: "room-two", snapshotId: "room-two-snapshot",
      watermark: 4, expectedCount: 1, checksum: authorityGenerationChecksum("room",
        [{ roomId: "room-two", body: "other-corpus" }]) });
    const roomTwoRecords = [{ identity: "other-record",
      value: { roomId: "room-two", body: "other-corpus" } }];
    store.stageRoomRecords("room-two", "room-two-snapshot", roomTwoRecords);
    store.commitRoomGeneration({ roomId: "room-two", snapshotId: "room-two-snapshot",
      watermark: 4, expectedCount: 1,
      checksum: authorityGenerationChecksum("room", roomTwoRecords.map((record) => record.value)) });

    store.clearRoom("room-secret");
    expect(store.readActiveRoom("room-secret")).toBeUndefined();
    expect(store.readActiveRoom("room-two")?.cursor.afterSeq).toBe(4);
    store.clearAccount();
    await expect(readdir(directory)).resolves.toEqual([]);
    expect(() => store.readActiveRoom("room-two")).toThrowError(EncryptedGenerationStoreError);
  });
});
