import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthorityCacheLockedError,
  createEncryptedAuthorityCachePersistence,
} from "./encrypted-authority-cache.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

let encryptedInputs: string[] = [];
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString(value: string) {
    encryptedInputs.push(value);
    return Uint8Array.from(new TextEncoder().encode(value)).reverse();
  },
  decryptString(value: Uint8Array) { return new TextDecoder().decode(Uint8Array.from(value).reverse()); },
};

describe("encrypted Desktop authority cache persistence", () => {
  it("wraps only a random 32-byte data key and AES-GCM encrypts the cache corpus", async () => {
    encryptedInputs = [];
    const directory = await mkdtemp(join(tmpdir(), "dao-ft09-authority-cache-")); directories.push(directory);
    const filePath = join(directory, "authority-cache.v1.enc");
    const persistence = createEncryptedAuthorityCachePersistence({ filePath, encryption });
    const value = { version: 1, actorId: "human-secret", rooms: [{ roomId: "room-secret",
      body: "plaintext-corpus-sentinel" }] };
    await persistence.save(value);
    const disk = new TextDecoder().decode(await readFile(filePath));
    expect(disk).not.toContain("room-secret");
    expect(disk).not.toContain("plaintext-corpus-sentinel");
    expect(encryptedInputs).toHaveLength(1);
    expect(Buffer.from(encryptedInputs[0]!, "base64")).toHaveLength(32);
    expect(encryptedInputs[0]).not.toContain("plaintext-corpus-sentinel");
    await expect(persistence.load()).resolves.toEqual(value);
    await persistence.clear();
    await expect(persistence.load()).resolves.toBeUndefined();
  });

  it("keeps corrupt ciphertext for diagnosis and returns a closed locked error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft09-authority-cache-")); directories.push(directory);
    const filePath = join(directory, "authority-cache.v1.enc");
    const persistence = createEncryptedAuthorityCachePersistence({ filePath, encryption });
    await persistence.save({ secret: "tamper-sentinel" });
    const bytes = await readFile(filePath);
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0xff;
    await writeFile(filePath, bytes, { mode: 0o600 });
    await expect(persistence.load()).rejects.toBeInstanceOf(AuthorityCacheLockedError);
    await expect(readFile(filePath)).resolves.toEqual(bytes);
  });

  it("fails closed when safeStorage is unavailable and never creates plaintext", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft09-authority-cache-")); directories.push(directory);
    const filePath = join(directory, "authority-cache.v1.enc");
    const unavailable = createEncryptedAuthorityCachePersistence({ filePath, encryption: {
      ...encryption, isEncryptionAvailable: () => false,
    } });
    await expect(unavailable.save({ secret: "must-not-hit-disk" }))
      .rejects.toBeInstanceOf(AuthorityCacheLockedError);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("clear removes primary and bounded crash residuals for the cache path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft09-authority-cache-")); directories.push(directory);
    const filePath = join(directory, "authority-cache.v1.enc");
    const persistence = createEncryptedAuthorityCachePersistence({ filePath, encryption });
    await persistence.save({ secret: "clear-sentinel" });
    for (const suffix of [".crash.tmp", "-wal", "-shm", "-journal"]) {
      await writeFile(`${filePath}${suffix}`, "encrypted-residual", { mode: 0o600 });
    }
    await persistence.clear();
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});
