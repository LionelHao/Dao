import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { nodeCredentialFileSystem, type CredentialEncryption } from "../identity/credential-vault.js";

export interface AuthorityCachePersistence {
  load(): Promise<unknown | undefined>;
  save(value: unknown): Promise<void>;
  clear(): Promise<void>;
}

type LockedReason =
  | "encryption_unavailable"
  | "invalid_permissions"
  | "invalid_envelope"
  | "key_unwrap_failed"
  | "integrity_failed"
  | "cache_too_large";

export class AuthorityCacheLockedError extends Error {
  readonly code = "authority_cache_locked";

  constructor(readonly reason: LockedReason) {
    super(`Desktop authority cache is locked: ${reason}`);
    this.name = "AuthorityCacheLockedError";
  }
}

interface CacheEnvelope {
  readonly version: 2;
  readonly algorithm: "aes-256-gcm";
  readonly wrappedDataKey: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function exactBase64(value: unknown, expectedBytes?: number): value is string {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return (expectedBytes === undefined || decoded.byteLength === expectedBytes) &&
    decoded.toString("base64") === value;
}

function parseEnvelope(bytes: Uint8Array): CacheEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new AuthorityCacheLockedError("invalid_envelope");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== 6) {
    throw new AuthorityCacheLockedError("invalid_envelope");
  }
  const candidate = value as Partial<CacheEnvelope>;
  if (candidate.version !== 2 || candidate.algorithm !== "aes-256-gcm" ||
      !exactBase64(candidate.wrappedDataKey) || !exactBase64(candidate.nonce, NONCE_BYTES) ||
      !exactBase64(candidate.ciphertext) || !exactBase64(candidate.tag, TAG_BYTES)) {
    throw new AuthorityCacheLockedError("invalid_envelope");
  }
  return candidate as CacheEnvelope;
}

function requireEncryption(encryption: CredentialEncryption): void {
  try {
    if (!encryption.isEncryptionAvailable()) {
      throw new AuthorityCacheLockedError("encryption_unavailable");
    }
  } catch (cause: unknown) {
    if (cause instanceof AuthorityCacheLockedError) throw cause;
    throw new AuthorityCacheLockedError("encryption_unavailable");
  }
}

function wrapDataKey(encryption: CredentialEncryption, dataKey: Buffer): string {
  try {
    const wrapped = encryption.encryptString(dataKey.toString("base64"));
    if (!(wrapped instanceof Uint8Array) || wrapped.byteLength === 0) {
      throw new Error("empty wrapped key");
    }
    return Buffer.from(wrapped).toString("base64");
  } catch {
    throw new AuthorityCacheLockedError("key_unwrap_failed");
  }
}

function unwrapDataKey(encryption: CredentialEncryption, wrappedDataKey: string): Buffer {
  let plaintext = "";
  try {
    plaintext = encryption.decryptString(Buffer.from(wrappedDataKey, "base64"));
    if (!exactBase64(plaintext, DATA_KEY_BYTES)) throw new Error("invalid data key");
    return Buffer.from(plaintext, "base64");
  } catch {
    throw new AuthorityCacheLockedError("key_unwrap_failed");
  } finally {
    plaintext = "";
  }
}

function aad(filePath: string): Buffer {
  return Buffer.from(`dao.desktop.authority-cache\0v2\0${filePath}`, "utf8");
}

function encryptEnvelope(
  filePath: string,
  encryption: CredentialEncryption,
  dataKey: Buffer,
  plaintext: Buffer,
  existingWrappedKey?: string,
): CacheEnvelope {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  cipher.setAAD(aad(filePath));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 2,
    algorithm: "aes-256-gcm",
    wrappedDataKey: existingWrappedKey ?? wrapDataKey(encryption, dataKey),
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptEnvelope(filePath: string, envelope: CacheEnvelope, dataKey: Buffer): Buffer {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      dataKey,
      Buffer.from(envelope.nonce, "base64"),
    );
    decipher.setAAD(aad(filePath));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new AuthorityCacheLockedError("integrity_failed");
  }
}

export function createEncryptedAuthorityCachePersistence(options: Readonly<{
  filePath: string;
  encryption: CredentialEncryption;
}>): AuthorityCachePersistence {
  if (options.filePath.length === 0) throw new TypeError("Authority cache path is required");
  const directory = dirname(options.filePath);
  const cacheBasename = basename(options.filePath);
  let writes = Promise.resolve();

  const inspectFile = async (): Promise<CacheEnvelope | undefined> => {
    try {
      const metadata = await lstat(options.filePath);
      if (!metadata.isFile() || process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw new AuthorityCacheLockedError("invalid_permissions");
      }
      if (metadata.size <= 0 || metadata.size > MAX_CACHE_BYTES) {
        throw new AuthorityCacheLockedError("cache_too_large");
      }
      return parseEnvelope(await readFile(options.filePath));
    } catch (cause: unknown) {
      if (hasCode(cause, "ENOENT")) return undefined;
      if (cause instanceof AuthorityCacheLockedError) throw cause;
      throw new AuthorityCacheLockedError("invalid_envelope");
    }
  };

  const removeResiduals = async (): Promise<void> => {
    let entries: string[] = [];
    try { entries = await readdir(directory); }
    catch (cause: unknown) { if (!hasCode(cause, "ENOENT")) throw cause; }
    const targets = entries.filter((entry) => entry === cacheBasename ||
      entry === `${cacheBasename}-wal` || entry === `${cacheBasename}-shm` ||
      entry === `${cacheBasename}-journal` ||
      entry.startsWith(`${cacheBasename}.`) &&
        (entry.endsWith(".tmp") || entry.endsWith(".bak") || entry.endsWith(".crash")));
    for (const entry of targets.slice(0, 4_096)) {
      await unlink(join(directory, entry)).catch((cause: unknown) => {
        if (!hasCode(cause, "ENOENT")) throw cause;
      });
    }
    if (targets.length > 4_096) throw new AuthorityCacheLockedError("cache_too_large");
    if (targets.length > 0) await nodeCredentialFileSystem.syncDirectory(directory);
  };

  return Object.freeze({
    async load() {
      await writes.catch(() => undefined);
      requireEncryption(options.encryption);
      const envelope = await inspectFile();
      if (envelope === undefined) return undefined;
      const dataKey = unwrapDataKey(options.encryption, envelope.wrappedDataKey);
      try {
        const plaintext = decryptEnvelope(options.filePath, envelope, dataKey);
        if (plaintext.byteLength > MAX_CACHE_BYTES) {
          throw new AuthorityCacheLockedError("cache_too_large");
        }
        try { return JSON.parse(plaintext.toString("utf8")); }
        catch { throw new AuthorityCacheLockedError("integrity_failed"); }
      } finally {
        dataKey.fill(0);
      }
    },
    async save(value: unknown) {
      writes = writes.catch(() => undefined).then(async () => {
        requireEncryption(options.encryption);
        const plaintext = Buffer.from(JSON.stringify(value), "utf8");
        if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_CACHE_BYTES / 2) {
          throw new AuthorityCacheLockedError("cache_too_large");
        }
        const existing = await inspectFile();
        const dataKey = existing === undefined
          ? randomBytes(DATA_KEY_BYTES)
          : unwrapDataKey(options.encryption, existing.wrappedDataKey);
        try {
          if (existing !== undefined) decryptEnvelope(options.filePath, existing, dataKey);
          const envelope = encryptEnvelope(
            options.filePath,
            options.encryption,
            dataKey,
            plaintext,
            existing?.wrappedDataKey,
          );
          const encoded = Buffer.from(JSON.stringify(envelope), "utf8");
          if (encoded.byteLength > MAX_CACHE_BYTES) {
            throw new AuthorityCacheLockedError("cache_too_large");
          }
          await mkdir(directory, { recursive: true, mode: 0o700 });
          if (process.platform !== "win32") await chmod(directory, 0o700);
          const temporaryPath = `${options.filePath}.${randomUUID()}.tmp`;
          let renamed = false;
          try {
            const handle = await open(temporaryPath, "wx", 0o600);
            try { await handle.writeFile(encoded); await handle.sync(); }
            finally { await handle.close(); }
            await rename(temporaryPath, options.filePath);
            renamed = true;
            await nodeCredentialFileSystem.syncDirectory(directory);
          } finally {
            if (!renamed) await unlink(temporaryPath).catch(() => undefined);
          }
          if (process.platform !== "win32") await chmod(options.filePath, 0o600);
        } finally {
          dataKey.fill(0);
          plaintext.fill(0);
        }
      });
      return writes;
    },
    async clear() {
      writes = writes.catch(() => undefined).then(removeResiduals);
      return writes;
    },
  });
}
