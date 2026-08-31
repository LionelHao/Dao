import { randomUUID } from "node:crypto";
import {
  chmod as nodeChmod,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  open as nodeOpen,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  rename as nodeRename,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  IDENTITY_CONTRACT_LIMITS,
  type IdentityStoredCredentials,
} from "./contracts.js";

export type CredentialVaultErrorCode =
  | "credential_vault_unavailable"
  | "credential_vault_corrupt"
  | "credential_vault_permissions"
  | "credential_vault_io";

export class CredentialVaultError extends Error {
  readonly code: CredentialVaultErrorCode;

  constructor(code: CredentialVaultErrorCode) {
    super(`Credential vault failed: ${code}`);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

export interface CredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Uint8Array;
  decryptString(ciphertext: Uint8Array): string;
}

export interface CredentialWritableFile {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface CredentialFileSystem {
  mkdir(path: string, options: { readonly recursive: true; readonly mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<{
    readonly mode: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: Uint8Array,
    options: { readonly mode: number; readonly flag: "wx" },
  ): Promise<void>;
  openFileForExclusiveWrite(
    path: string,
    options: { readonly mode: number; readonly flag: "wx" },
  ): Promise<CredentialWritableFile>;
  rename(from: string, to: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EBADF",
  "EISDIR",
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EPERM",
]);

async function syncNodeDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof nodeOpen>> | undefined;
  try {
    handle = await nodeOpen(path, "r");
    await handle.sync();
  } catch (error: unknown) {
    const unsupportedOnWindows = process.platform === "win32" &&
      typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" &&
      WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error.code);
    if (!unsupportedOnWindows) throw error;
  } finally {
    await handle?.close();
  }
}

export const nodeCredentialFileSystem: CredentialFileSystem = {
  mkdir: nodeMkdir,
  chmod: nodeChmod,
  lstat: nodeLstat,
  readFile: nodeReadFile,
  writeFile: nodeWriteFile,
  async openFileForExclusiveWrite(path, options) {
    return nodeOpen(path, options.flag, options.mode);
  },
  rename: nodeRename,
  syncDirectory: syncNodeDirectory,
  unlink: nodeUnlink,
  readdir: nodeReaddir,
};

export interface IdentityCredentialVault {
  load(): Promise<IdentityStoredCredentials | undefined>;
  save(credentials: IdentityStoredCredentials): Promise<void>;
  clear(): Promise<void>;
}

type UnknownRecord = Record<string, unknown>;
const utf8Encoder = new TextEncoder();

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CREDENTIAL_FIELDS = new Set([
  "version",
  "accountId",
  "actorId",
  "sessionId",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "refreshExpiresAt",
]);
const BOUND_CREDENTIAL_FIELDS = new Set([...CREDENTIAL_FIELDS, "sessionFamilyId", "deviceId"]);

function hasOnlyFields(value: UnknownRecord, fields: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).length === fields.size &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && fields.has(key));
}

function isBoundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    utf8Encoder.encode(value).byteLength <= maximumBytes;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isBoundedString(value, 64)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isStoredCredentials(value: unknown): value is IdentityStoredCredentials {
  return isRecord(value) &&
    (hasOnlyFields(value, CREDENTIAL_FIELDS) || hasOnlyFields(value, BOUND_CREDENTIAL_FIELDS)) &&
    value.version === 1 &&
    isBoundedString(value.accountId, IDENTITY_CONTRACT_LIMITS.accountId) &&
    isBoundedString(value.actorId, IDENTITY_CONTRACT_LIMITS.actorId) &&
    isBoundedString(value.sessionId, IDENTITY_CONTRACT_LIMITS.sessionId) &&
    (value.sessionFamilyId === undefined ||
      isBoundedString(value.sessionFamilyId, IDENTITY_CONTRACT_LIMITS.token)) &&
    (value.deviceId === undefined ||
      isBoundedString(value.deviceId, IDENTITY_CONTRACT_LIMITS.deviceId)) &&
    isBoundedString(value.accessToken, IDENTITY_CONTRACT_LIMITS.token) &&
    isBoundedString(value.refreshToken, IDENTITY_CONTRACT_LIMITS.token) &&
    isIsoTimestamp(value.expiresAt) && isIsoTimestamp(value.refreshExpiresAt);
}

function copyCredentials(value: IdentityStoredCredentials): IdentityStoredCredentials {
  return Object.freeze({
    version: 1,
    accountId: value.accountId,
    actorId: value.actorId,
    ...(value.sessionFamilyId === undefined ? {} : { sessionFamilyId: value.sessionFamilyId }),
    ...(value.deviceId === undefined ? {} : { deviceId: value.deviceId }),
    sessionId: value.sessionId,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    refreshExpiresAt: value.refreshExpiresAt,
  });
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function createCredentialVault(options: {
  readonly filePath: string;
  readonly encryption: CredentialEncryption;
  /** Windows relies on safeStorage plus the per-user userData ACL, not POSIX mode bits. */
  readonly enforcePosixPermissions?: boolean;
  readonly fileSystem?: CredentialFileSystem;
  readonly randomSuffix?: () => string;
}): IdentityCredentialVault {
  if (options.filePath.length === 0) throw new TypeError("Credential vault path is required");
  const fileSystem = options.fileSystem ?? nodeCredentialFileSystem;
  const enforcePosixPermissions = options.enforcePosixPermissions ?? true;
  const directory = dirname(options.filePath);
  const fileName = basename(options.filePath);

  const requireEncryption = (): void => {
    let available = false;
    try {
      available = options.encryption.isEncryptionAvailable();
    } catch {
      // A throwing platform adapter is equivalent to unavailable encryption.
    }
    if (!available) throw new CredentialVaultError("credential_vault_unavailable");
  };

  const unlinkIfPresent = async (path: string): Promise<boolean> => {
    try {
      await fileSystem.unlink(path);
      return true;
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  };

  const clear = async (): Promise<void> => {
    let deleted = false;
    let failure: unknown | undefined;
    try {
      deleted = await unlinkIfPresent(options.filePath);
      let entries: string[];
      try {
        entries = await fileSystem.readdir(directory);
      } catch (error: unknown) {
        if (hasCode(error, "ENOENT")) entries = [];
        else throw error;
      }
      const temporaryPrefix = `${fileName}.`;
      for (const entry of entries
        .filter((candidate) => candidate.startsWith(temporaryPrefix) && candidate.endsWith(".tmp"))
        .sort()) {
        deleted = await unlinkIfPresent(join(directory, entry)) || deleted;
      }
    } catch (error: unknown) {
      failure = error;
    }
    if (deleted) {
      try {
        await fileSystem.syncDirectory(directory);
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw new CredentialVaultError("credential_vault_io");
    }
  };

  return {
    async load() {
      requireEncryption();
      let directoryMetadata: {
        readonly mode: number;
        isFile(): boolean;
        isDirectory(): boolean;
      };
      let metadata: {
        readonly mode: number;
        isFile(): boolean;
        isDirectory(): boolean;
      };
      try {
        directoryMetadata = await fileSystem.lstat(directory);
        metadata = await fileSystem.lstat(options.filePath);
      } catch (error: unknown) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw new CredentialVaultError("credential_vault_io");
      }
      if (!directoryMetadata.isDirectory() || !metadata.isFile() ||
          (enforcePosixPermissions &&
            ((directoryMetadata.mode & 0o077) !== 0 || (metadata.mode & 0o077) !== 0))) {
        throw new CredentialVaultError("credential_vault_permissions");
      }
      let ciphertext: Uint8Array;
      try {
        ciphertext = await fileSystem.readFile(options.filePath);
      } catch {
        throw new CredentialVaultError("credential_vault_io");
      }
      try {
        const plaintext = options.encryption.decryptString(ciphertext);
        const value: unknown = JSON.parse(plaintext);
        if (!isStoredCredentials(value)) throw new TypeError("invalid credentials");
        return copyCredentials(value);
      } catch {
        try {
          await clear();
        } catch {
          throw new CredentialVaultError("credential_vault_io");
        }
        throw new CredentialVaultError("credential_vault_corrupt");
      }
    },
    async save(credentials) {
      requireEncryption();
      if (!isStoredCredentials(credentials)) {
        throw new CredentialVaultError("credential_vault_corrupt");
      }
      let ciphertext: Uint8Array;
      try {
        ciphertext = options.encryption.encryptString(JSON.stringify(copyCredentials(credentials)));
      } catch {
        throw new CredentialVaultError("credential_vault_unavailable");
      }
      if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength === 0) {
        throw new CredentialVaultError("credential_vault_unavailable");
      }
      const suffix = options.randomSuffix?.() ?? randomUUID();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(suffix)) {
        throw new CredentialVaultError("credential_vault_io");
      }
      const temporaryPath = `${options.filePath}.${suffix}.tmp`;
      let previousCiphertext: Uint8Array | undefined;
      let temporaryCreated = false;
      let replaced = false;

      const writeAndSyncTemporary = async (data: Uint8Array): Promise<void> => {
        let handle: CredentialWritableFile | undefined;
        try {
          handle = await fileSystem.openFileForExclusiveWrite(temporaryPath, {
            mode: 0o600,
            flag: "wx",
          });
          temporaryCreated = true;
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle?.close();
        }
      };

      try {
        await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
        const directoryMetadata = await fileSystem.lstat(directory);
        if (!directoryMetadata.isDirectory()) {
          throw new CredentialVaultError("credential_vault_permissions");
        }
        if (enforcePosixPermissions) await fileSystem.chmod(directory, 0o700);

        try {
          const previousMetadata = await fileSystem.lstat(options.filePath);
          if (!previousMetadata.isFile() ||
              (enforcePosixPermissions && (previousMetadata.mode & 0o077) !== 0)) {
            throw new CredentialVaultError("credential_vault_permissions");
          }
          previousCiphertext = await fileSystem.readFile(options.filePath);
        } catch (error: unknown) {
          if (!hasCode(error, "ENOENT")) throw error;
        }

        await writeAndSyncTemporary(ciphertext);
        await fileSystem.rename(temporaryPath, options.filePath);
        temporaryCreated = false;
        replaced = true;
        await fileSystem.syncDirectory(directory);
      } catch (error: unknown) {
        try {
          if (temporaryCreated) {
            await unlinkIfPresent(temporaryPath);
            temporaryCreated = false;
          }
          if (replaced && previousCiphertext === undefined) {
            await unlinkIfPresent(options.filePath);
            await fileSystem.syncDirectory(directory);
          } else if (replaced && previousCiphertext !== undefined) {
            await writeAndSyncTemporary(previousCiphertext);
            await fileSystem.rename(temporaryPath, options.filePath);
            temporaryCreated = false;
            await fileSystem.syncDirectory(directory);
          }
        } catch {
          try {
            if (temporaryCreated) await unlinkIfPresent(temporaryPath);
            if (replaced) await unlinkIfPresent(options.filePath);
          } catch {
            // The operation still fails closed; the caller must not publish authenticated state.
          }
        }
        throw error instanceof CredentialVaultError
          ? error
          : new CredentialVaultError("credential_vault_io");
      }
    },
    clear,
  };
}
