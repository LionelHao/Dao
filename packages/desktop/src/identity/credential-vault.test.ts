import { chmod, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CredentialVaultError,
  createCredentialVault,
  nodeCredentialFileSystem,
  type CredentialEncryption,
} from "./credential-vault.js";
import type { IdentityStoredCredentials } from "./contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function temporaryVaultPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dao-identity-vault-"));
  temporaryDirectories.push(directory);
  return join(directory, "profile", "credentials.bin");
}

const credentials: IdentityStoredCredentials = {
  version: 1,
  accountId: "human@example.test",
  actorId: "human-1",
  sessionId: "public-session-1",
  accessToken: "access-token-canary",
  refreshToken: "refresh-token-canary",
  expiresAt: "2026-08-18T00:15:00.000Z",
  refreshExpiresAt: "2026-09-18T00:00:00.000Z",
};

const rotatedCredentials: IdentityStoredCredentials = {
  ...credentials,
  accessToken: "access-token-rotated",
  refreshToken: "refresh-token-rotated",
  expiresAt: "2026-08-18T00:30:00.000Z",
};

function xorEncryption(available = true): CredentialEncryption {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      return Uint8Array.from(new TextEncoder().encode(value), (byte) => byte ^ 0xa5);
    },
    decryptString(value) {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(Uint8Array.from(value, (byte) => byte ^ 0xa5));
    },
  };
}

describe("safeStorage credential vault", () => {
  it("atomically stores ciphertext with restricted modes and reloads after restart", async () => {
    const filePath = await temporaryVaultPath();
    const first = createCredentialVault({ filePath, encryption: xorEncryption() });
    await first.save(credentials);

    const ciphertext = await readFile(filePath);
    expect(ciphertext.toString("utf8")).not.toContain(credentials.accessToken);
    expect(ciphertext.toString("utf8")).not.toContain(credentials.refreshToken);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(filePath, ".."))).mode & 0o777).toBe(0o700);

    const restarted = createCredentialVault({ filePath, encryption: xorEncryption() });
    await expect(restarted.load()).resolves.toEqual(credentials);
  });

  it("syncs the temporary file handle before rename and the parent directory after rename", async () => {
    const filePath = "/vault/credentials.bin";
    const temporaryPath = `${filePath}.fixed-attempt.tmp`;
    const order: string[] = [];
    const vault = createCredentialVault({
      filePath,
      encryption: xorEncryption(),
      randomSuffix: () => "fixed-attempt",
      fileSystem: {
        ...nodeCredentialFileSystem,
        mkdir: async () => { order.push("mkdir"); },
        lstat: async (path) => {
          order.push(`lstat:${path}`);
          if (path === "/vault") {
            return { mode: 0o40700, isFile: () => false, isDirectory: () => true };
          }
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        chmod: async (path, mode) => { order.push(`chmod:${path}:${mode.toString(8)}`); },
        openFileForExclusiveWrite: async (path, options) => {
          order.push(`open:${path}:${options.flag}:${options.mode.toString(8)}`);
          return {
            writeFile: async () => { order.push("file.write"); },
            sync: async () => { order.push("file.sync"); },
            close: async () => { order.push("file.close"); },
          };
        },
        rename: async (from, to) => { order.push(`rename:${from}:${to}`); },
        syncDirectory: async (path) => { order.push(`directory.sync:${path}`); },
      },
    });

    await vault.save(credentials);

    expect(order).toEqual([
      "mkdir",
      "lstat:/vault",
      "chmod:/vault:700",
      `lstat:${filePath}`,
      `open:${temporaryPath}:wx:600`,
      "file.write",
      "file.sync",
      "file.close",
      `rename:${temporaryPath}:${filePath}`,
      "directory.sync:/vault",
    ]);
  });

  it("rejects a temporary-file sync failure and preserves the previous credential file", async () => {
    const filePath = await temporaryVaultPath();
    await createCredentialVault({ filePath, encryption: xorEncryption() }).save(credentials);
    const openFileForExclusiveWrite = vi.fn(async (path: string, options: {
      readonly flag: "wx";
      readonly mode: number;
    }) => {
      const handle = await nodeCredentialFileSystem.openFileForExclusiveWrite(path, options);
      return {
        writeFile: (data: Uint8Array) => handle.writeFile(data),
        sync: async () => {
          throw Object.assign(new Error("fsync failed"), { code: "EIO" });
        },
        close: () => handle.close(),
      };
    });
    const replacing = createCredentialVault({
      filePath,
      encryption: xorEncryption(),
      randomSuffix: () => "sync-failure",
      fileSystem: { ...nodeCredentialFileSystem, openFileForExclusiveWrite },
    });

    await expect(replacing.save(rotatedCredentials)).rejects.toMatchObject({
      code: "credential_vault_io",
    });
    await expect(createCredentialVault({ filePath, encryption: xorEncryption() }).load())
      .resolves.toEqual(credentials);
    await expect(readFile(`${filePath}.sync-failure.tmp`))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back to the previous durable credential if parent-directory sync fails", async () => {
    const filePath = await temporaryVaultPath();
    await createCredentialVault({ filePath, encryption: xorEncryption() }).save(credentials);
    const syncDirectory = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("directory fsync failed"), { code: "EIO" }))
      .mockImplementation((path: string) => nodeCredentialFileSystem.syncDirectory(path));
    const replacing = createCredentialVault({
      filePath,
      encryption: xorEncryption(),
      randomSuffix: () => "directory-sync-failure",
      fileSystem: { ...nodeCredentialFileSystem, syncDirectory },
    });

    await expect(replacing.save(rotatedCredentials)).rejects.toMatchObject({
      code: "credential_vault_io",
    });
    expect(syncDirectory).toHaveBeenCalledTimes(2);
    await expect(createCredentialVault({ filePath, encryption: xorEncryption() }).load())
      .resolves.toEqual(credentials);
  });

  it("fails closed when OS encryption is unavailable without creating plaintext", async () => {
    const filePath = await temporaryVaultPath();
    const vault = createCredentialVault({ filePath, encryption: xorEncryption(false) });
    await expect(vault.load()).rejects.toMatchObject({
      code: "credential_vault_unavailable",
    });
    await expect(vault.save(credentials)).rejects.toMatchObject({
      code: "credential_vault_unavailable",
    });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects and removes corrupt ciphertext instead of guessing credentials", async () => {
    const filePath = await temporaryVaultPath();
    const vault = createCredentialVault({ filePath, encryption: xorEncryption() });
    await vault.save(credentials);
    await writeFile(filePath, Uint8Array.from([0xff, 0x00, 0x01]), { mode: 0o600 });

    await expect(vault.load()).rejects.toMatchObject({ code: "credential_vault_corrupt" });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects insecure file permissions", async () => {
    const filePath = await temporaryVaultPath();
    const vault = createCredentialVault({ filePath, encryption: xorEncryption() });
    await vault.save(credentials);
    await chmod(filePath, 0o644);

    await expect(vault.load()).rejects.toMatchObject({
      code: "credential_vault_permissions",
    });
  });

  it("rejects an insecure credential directory even if the file mode is restricted", async () => {
    const filePath = await temporaryVaultPath();
    const vault = createCredentialVault({ filePath, encryption: xorEncryption() });
    await vault.save(credentials);
    await chmod(join(filePath, ".."), 0o755);

    await expect(vault.load()).rejects.toMatchObject({
      code: "credential_vault_permissions",
    });
  });

  it("uses Windows ACL policy without POSIX chmod or mode-bit rejection", async () => {
    const filePath = await temporaryVaultPath();
    const chmodAttempt = vi.fn(async () => {
      throw new Error("chmod must not be used by the Windows policy");
    });
    const windowsVault = createCredentialVault({
      filePath,
      encryption: xorEncryption(),
      enforcePosixPermissions: false,
      fileSystem: { ...nodeCredentialFileSystem, chmod: chmodAttempt },
    });

    await windowsVault.save(credentials);
    expect(chmodAttempt).not.toHaveBeenCalled();
    await chmod(filePath, 0o666);
    await chmod(join(filePath, ".."), 0o777);
    await expect(windowsVault.load()).resolves.toEqual(credentials);
  });

  it("still rejects a credential symlink when POSIX mode enforcement is disabled", async () => {
    const filePath = await temporaryVaultPath();
    const vault = createCredentialVault({ filePath, encryption: xorEncryption() });
    await vault.save(credentials);
    const targetPath = `${filePath}.target`;
    await rename(filePath, targetPath);
    await symlink(targetPath, filePath);

    const windowsVault = createCredentialVault({
      filePath,
      encryption: xorEncryption(),
      enforcePosixPermissions: false,
    });
    await expect(windowsVault.load()).rejects.toMatchObject({
      code: "credential_vault_permissions",
    });
  });

  it("fails a broken atomic replace and removes its temporary ciphertext", async () => {
    const filePath = await temporaryVaultPath();
    const vault = createCredentialVault({
      filePath,
      encryption: xorEncryption(),
      randomSuffix: () => "fixed-attempt",
      fileSystem: {
        ...nodeCredentialFileSystem,
        rename: async () => {
          throw Object.assign(new Error("rename failed"), { code: "EIO" });
        },
      },
    });

    await expect(vault.save(credentials)).rejects.toBeInstanceOf(CredentialVaultError);
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${filePath}.fixed-attempt.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears credential material idempotently", async () => {
    const filePath = await temporaryVaultPath();
    const vault = createCredentialVault({ filePath, encryption: xorEncryption() });
    await vault.save(credentials);

    await vault.clear();
    await vault.clear();

    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(vault.load()).resolves.toBeUndefined();
  });

  it("syncs the parent directory once after deleting credentials and stale temporary files", async () => {
    const order: string[] = [];
    const paths = new Set([
      "/vault/credentials.bin",
      "/vault/credentials.bin.stale.tmp",
      "/vault/unrelated.json",
    ]);
    const vault = createCredentialVault({
      filePath: "/vault/credentials.bin",
      encryption: xorEncryption(),
      fileSystem: {
        ...nodeCredentialFileSystem,
        unlink: async (path) => {
          order.push(`unlink:${path}`);
          if (!paths.delete(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        readdir: async (path) => {
          order.push(`readdir:${path}`);
          return [...paths].filter((entry) => entry.startsWith(`${path}/`))
            .map((entry) => entry.slice(path.length + 1));
        },
        syncDirectory: async (path) => { order.push(`directory.sync:${path}`); },
      },
    });

    await vault.clear();

    expect(order).toEqual([
      "unlink:/vault/credentials.bin",
      "readdir:/vault",
      "unlink:/vault/credentials.bin.stale.tmp",
      "directory.sync:/vault",
    ]);
    expect(paths).toEqual(new Set(["/vault/unrelated.json"]));
  });

  it("does not report clear success when deletion happened but directory sync failed", async () => {
    const filePath = await temporaryVaultPath();
    await createCredentialVault({ filePath, encryption: xorEncryption() }).save(credentials);
    const syncDirectory = vi.fn(async () => {
      throw Object.assign(new Error("directory fsync failed"), { code: "EIO" });
    });
    const vault = createCredentialVault({
      filePath,
      encryption: xorEncryption(),
      fileSystem: { ...nodeCredentialFileSystem, syncDirectory },
    });

    await expect(vault.clear()).rejects.toMatchObject({ code: "credential_vault_io" });
    expect(syncDirectory).toHaveBeenCalledOnce();
    // The unlink reached the filesystem, but its crash durability was not confirmed.
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
