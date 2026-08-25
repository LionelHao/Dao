import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { nodeCredentialFileSystem, type CredentialEncryption } from "../identity/credential-vault.js";

export interface AuthorityCachePersistence {
  load(): Promise<unknown | undefined>;
  save(value: unknown): Promise<void>;
  clear(): Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function createEncryptedAuthorityCachePersistence(options: Readonly<{
  filePath: string;
  encryption: CredentialEncryption;
}>): AuthorityCachePersistence {
  if (options.filePath.length === 0) throw new TypeError("Authority cache path is required");
  const directory = dirname(options.filePath);
  let writes = Promise.resolve();
  const requireEncryption = (): void => {
    if (!options.encryption.isEncryptionAvailable()) throw new Error("authority_cache_encryption_unavailable");
  };
  const remove = async (): Promise<void> => {
    try { await unlink(options.filePath); await nodeCredentialFileSystem.syncDirectory(directory); }
    catch (error: unknown) { if (!hasCode(error, "ENOENT")) throw error; }
  };
  return Object.freeze({
    async load() {
      await writes.catch(() => undefined);
      requireEncryption();
      try {
        const metadata = await lstat(options.filePath);
        if (!metadata.isFile() || process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
          await remove();
          return undefined;
        }
        const ciphertext = await readFile(options.filePath);
        if (ciphertext.byteLength === 0 || ciphertext.byteLength > 32 * 1024 * 1024) throw new Error("invalid size");
        return JSON.parse(options.encryption.decryptString(Uint8Array.from(ciphertext)));
      } catch (error: unknown) {
        if (hasCode(error, "ENOENT")) return undefined;
        await remove().catch(() => undefined);
        return undefined;
      }
    },
    async save(value: unknown) {
      writes = writes.catch(() => undefined).then(async () => {
        requireEncryption();
        const ciphertext = options.encryption.encryptString(JSON.stringify(value));
        if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength === 0 ||
            ciphertext.byteLength > 32 * 1024 * 1024) throw new Error("authority_cache_encryption_failed");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await chmod(directory, 0o700);
        const temporaryPath = `${options.filePath}.${randomUUID()}.tmp`;
        let renamed = false;
        try {
          const handle = await open(temporaryPath, "wx", 0o600);
          try { await handle.writeFile(ciphertext); await handle.sync(); }
          finally { await handle.close(); }
          await rename(temporaryPath, options.filePath);
          renamed = true;
          await nodeCredentialFileSystem.syncDirectory(directory);
        } finally {
          if (!renamed) await unlink(temporaryPath).catch(() => undefined);
        }
        if (process.platform !== "win32") await chmod(options.filePath, 0o600);
      });
      return writes;
    },
    async clear() {
      writes = writes.catch(() => undefined).then(remove);
      return writes;
    },
  });
}
