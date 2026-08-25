import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEncryptedAuthorityCachePersistence } from "./encrypted-authority-cache.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString(value: string) { return Uint8Array.from(new TextEncoder().encode(value)).reverse(); },
  decryptString(value: Uint8Array) { return new TextDecoder().decode(Uint8Array.from(value).reverse()); },
};

describe("encrypted Desktop authority cache persistence", () => {
  it("atomically round-trips ciphertext without a plaintext fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft09-authority-cache-")); directories.push(directory);
    const filePath = join(directory, "authority-cache.v1.enc");
    const persistence = createEncryptedAuthorityCachePersistence({ filePath, encryption });
    const value = { version: 1, actorId: "human-secret", rooms: [{ roomId: "room-secret" }] };
    await persistence.save(value);
    expect(new TextDecoder().decode(await readFile(filePath))).not.toContain("room-secret");
    await expect(persistence.load()).resolves.toEqual(value);
    await persistence.clear();
    await expect(persistence.load()).resolves.toBeUndefined();
  });

  it("purges corrupt ciphertext and fails closed when encryption is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft09-authority-cache-")); directories.push(directory);
    const filePath = join(directory, "authority-cache.v1.enc");
    await writeFile(filePath, Uint8Array.of(1, 2, 3), { mode: 0o600 });
    const persistence = createEncryptedAuthorityCachePersistence({ filePath, encryption });
    await expect(persistence.load()).resolves.toBeUndefined();
    const unavailable = createEncryptedAuthorityCachePersistence({ filePath, encryption: {
      ...encryption, isEncryptionAvailable: () => false,
    } });
    await expect(unavailable.save({ secret: true })).rejects.toThrow("encryption_unavailable");
  });
});
