import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialEncryption } from "../identity/credential-vault.js";
import {
  authorityGenerationChecksum,
  createEncryptedAuthorityGenerationStore,
  type EncryptedGenerationRecord,
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

const PR_RECORD_COUNT = 10_000;
const NIGHTLY_RECORD_COUNT = 100_000;
const recordCount = process.env.DAO_FT13_NIGHTLY_ENCRYPTED_CACHE_RECORDS === "100000"
  ? NIGHTLY_RECORD_COUNT
  : PR_RECORD_COUNT;

describe("FT-13 encrypted generation store capacity", () => {
  it(`stages, commits, reopens, and verifies ${recordCount.toLocaleString("en-US")} real-file records`,
    { timeout: recordCount === NIGHTLY_RECORD_COUNT ? 10 * 60_000 : 2 * 60_000 }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "dao-ft13-encrypted-capacity-"));
      directories.push(directory);
      const databasePath = join(directory, "authority-cache.sqlite");
      const accountId = "capacity-account-plaintext-sentinel";
      const roomId = "capacity-room-plaintext-sentinel";
      const snapshotId = "capacity-snapshot-plaintext-sentinel";
      const records: readonly EncryptedGenerationRecord[] = Array.from(
        { length: recordCount },
        (_, index) => ({
          identity: `capacity-identity-plaintext-sentinel-${index}`,
          value: {
            roomId,
            ordinal: index,
            body: `capacity-payload-plaintext-sentinel-${index}`,
          },
        }),
      );
      const checksum = authorityGenerationChecksum("room", records.map((record) => record.value));

      const store = createEncryptedAuthorityGenerationStore({
        databasePath,
        accountId,
        encryption: wrapping,
      });
      store.beginRoomGeneration({
        roomId,
        snapshotId,
        watermark: recordCount,
        expectedCount: recordCount,
        checksum,
      });
      store.stageRoomRecords(roomId, snapshotId, records);
      store.commitRoomGeneration({
        roomId,
        snapshotId,
        watermark: recordCount,
        expectedCount: recordCount,
        checksum,
      });
      store.close();

      const reopened = createEncryptedAuthorityGenerationStore({
        databasePath,
        accountId,
        encryption: wrapping,
      });
      const active = reopened.readActiveRoom(roomId);
      expect(active).toMatchObject({
        cursor: { version: 1, roomId, afterSeq: recordCount },
        checksum,
      });
      expect(active?.records).toHaveLength(recordCount);
      expect(active?.records[0]).toEqual(records[0]);
      expect(active?.records.at(-1)).toEqual(records.at(-1));
      expect(authorityGenerationChecksum(
        "room",
        active?.records.map((record) => record.value) ?? [],
      )).toBe(checksum);
      reopened.close();

      const files = await readdir(directory);
      const persistedBytes = Buffer.concat(await Promise.all(
        files.filter((file) => file.startsWith("authority-cache.sqlite"))
          .map((file) => readFile(join(directory, file))),
      ));
      for (const sentinel of [
        accountId,
        roomId,
        snapshotId,
        "capacity-identity-plaintext-sentinel-0",
        `capacity-identity-plaintext-sentinel-${recordCount - 1}`,
        "capacity-payload-plaintext-sentinel-0",
        `capacity-payload-plaintext-sentinel-${recordCount - 1}`,
      ]) {
        expect(persistedBytes.includes(Buffer.from(sentinel, "utf8")), sentinel).toBe(false);
      }
    });
});
