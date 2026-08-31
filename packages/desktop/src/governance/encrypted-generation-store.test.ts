import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialEncryption } from "../identity/credential-vault.js";
import {
  EncryptedGenerationStoreError,
  authorityGenerationChecksum,
  createEncryptedAuthorityGenerationStore,
  createRecoverableEncryptedAuthorityGenerationStore,
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

function identifierHash(key: Buffer, namespace: string, value: string): string {
  return createHmac("sha256", key).update(namespace).update("\0").update(value).digest("hex");
}

function createVersion2Store(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE cache_metadata (
      metadata_key TEXT PRIMARY KEY,
      metadata_value BLOB NOT NULL
    ) STRICT;
    CREATE TABLE cache_generations (
      generation_id TEXT PRIMARY KEY,
      room_hash TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      generation_state TEXT NOT NULL CHECK (generation_state IN ('staging', 'active')),
      watermark INTEGER NOT NULL CHECK (watermark >= 0),
      cursor INTEGER NOT NULL CHECK (cursor >= 0),
      expected_count INTEGER NOT NULL CHECK (expected_count >= 0),
      checksum TEXT NOT NULL
    ) STRICT;
  `);
  const dataKey = Buffer.alloc(32, 0x2a);
  const wrapped = wrapping.encryptString(dataKey.toString("base64"));
  const insert = database.prepare(
    "INSERT INTO cache_metadata(metadata_key, metadata_value) VALUES (?, ?)",
  );
  insert.run("schema_version", Buffer.from("2", "utf8"));
  insert.run("wrapped_data_key", wrapped);
  insert.run("account_hash", Buffer.from(identifierHash(dataKey, "account", "account-secret"), "utf8"));
  insert.run("tenant_hash", Buffer.from(identifierHash(dataKey, "tenant", "dao-local-tenant"), "utf8"));
  dataKey.fill(0);
  database.close();
}

describe("encrypted Desktop authority generation store", () => {
  it("rebuilds a derived v2 cache, resyncs it, and reopens the v3 generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft13-generation-v2-"));
    directories.push(directory);
    const databasePath = join(directory, "authority-cache.sqlite");
    createVersion2Store(databasePath);

    const rebuilt = createRecoverableEncryptedAuthorityGenerationStore({
      databasePath, accountId: "account-secret", encryption: wrapping,
    });
    expect(rebuilt.listActiveRoomIds()).toEqual([]);
    install(rebuilt, { snapshotId: "resynced", watermark: 9, records: oldRecords });
    rebuilt.close();

    const reopened = createRecoverableEncryptedAuthorityGenerationStore({
      databasePath, accountId: "account-secret", encryption: wrapping,
    });
    expect(reopened.readActiveRoom("room-secret")).toMatchObject({
      records: oldRecords, cursor: { afterSeq: 9 },
    });
    reopened.close();
  });

  it("recovers a same-version corrupt cache and removes interrupted rebuild residuals", async () => {
    const { directory, databasePath, store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    store.close();
    const tamper = new DatabaseSync(databasePath);
    tamper.prepare("UPDATE cache_metadata SET metadata_value = ? WHERE metadata_key = 'account_hash'")
      .run(Buffer.from("corrupt-binding", "utf8"));
    tamper.close();
    await writeFile(`${databasePath}.crash`, "interrupted-rebuild-sentinel", "utf8");

    const rebuilt = createRecoverableEncryptedAuthorityGenerationStore({
      databasePath, accountId: "account-secret", encryption: wrapping,
    });
    expect(rebuilt.listActiveRoomIds()).toEqual([]);
    expect(await readdir(directory)).not.toContain("authority-cache.sqlite.crash");
    rebuilt.close();
  });

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
    const { databasePath, store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    store.bindActiveGeneration("room-secret", {
      lifecycleGeneration: 2, accessRevision: 7, leaseGeneration: 11,
    });
    store.writeOfflineLease("room-secret", { token: "lease-for-old-generation" });
    expect(store.readOfflineLease("room-secret")).toEqual({ token: "lease-for-old-generation" });
    expect(store.readActiveGenerationBinding("room-secret")).toEqual({
      roomId: "room-secret", complete: true,
      lifecycleGeneration: 2, accessRevision: 7, leaseGeneration: 11,
    });

    store.close();
    const reopened = createEncryptedAuthorityGenerationStore({
      databasePath, accountId: "account-secret", encryption: wrapping,
    });
    expect(reopened.readActiveGenerationBinding("room-secret")).toMatchObject({
      lifecycleGeneration: 2, accessRevision: 7, leaseGeneration: 11,
    });

    install(reopened, { snapshotId: "new", watermark: 12, records: newRecords });
    expect(reopened.readOfflineLease("room-secret")).toBeUndefined();
    expect(reopened.readActiveGenerationBinding("room-secret")).toBeUndefined();
    reopened.close();
  });

  it("revokes the persisted lease and generation binding in the stable-event transaction", async () => {
    const { store } = await fixture();
    install(store, { snapshotId: "old", watermark: 9, records: oldRecords });
    store.bindActiveGeneration("room-secret", {
      lifecycleGeneration: 2, accessRevision: 7, leaseGeneration: 11,
    });
    store.writeOfflineLease("room-secret", { token: "stale-after-access-change" });
    store.applyRoomEventBatch({
      roomId: "room-secret", nextCursor: 10,
      events: [{ eventId: "access-change", streamSeq: 10 }],
      upserts: [], deletes: [], invalidateActiveBinding: true,
    });
    expect(store.readOfflineLease("room-secret")).toBeUndefined();
    expect(store.readActiveGenerationBinding("room-secret")).toBeUndefined();
    expect(store.readActiveRoom("room-secret")?.cursor.afterSeq).toBe(10);
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
