import { chmod, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeviceIdentityStore,
  identityPlatformFromNode,
} from "./device-identity.js";
import { nodeCredentialFileSystem } from "./credential-vault.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function temporaryDevicePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dao-device-identity-"));
  temporaryDirectories.push(directory);
  return join(directory, "profile", "device.json");
}

describe("persistent Desktop device identity", () => {
  it("creates once and reloads the same non-secret installation identity", async () => {
    const filePath = await temporaryDevicePath();
    const idFactory = vi.fn(() => "installation-one");
    const first = createDeviceIdentityStore({
      filePath,
      idFactory,
      label: "Work MacBook",
      platform: "macos",
    });
    await expect(first.loadOrCreate()).resolves.toEqual({
      id: "installation-one",
      label: "Work MacBook",
      platform: "macos",
    });

    const restarted = createDeviceIdentityStore({
      filePath,
      idFactory: () => "must-not-replace",
      label: "Changed hostname",
      platform: "linux",
    });
    await expect(restarted.loadOrCreate()).resolves.toEqual({
      id: "installation-one",
      label: "Work MacBook",
      platform: "macos",
    });
    expect(idFactory).toHaveBeenCalledOnce();
    expect(await readFile(filePath, "utf8")).not.toMatch(/token|secret|credential/i);
  });

  it.each([
    ["darwin", "macos"],
    ["win32", "windows"],
    ["linux", "linux"],
    ["freebsd", "unknown"],
  ] as const)("maps Node platform %s to %s", (nodePlatform, expected) => {
    expect(identityPlatformFromNode(nodePlatform)).toBe(expected);
  });

  it("fails on corrupt persistence instead of silently creating another server device", async () => {
    const filePath = await temporaryDevicePath();
    const store = createDeviceIdentityStore({
      filePath,
      idFactory: () => "new-installation",
      label: "MacBook",
      platform: "macos",
    });
    await store.loadOrCreate();
    await writeFile(filePath, "{not-json", { mode: 0o600 });

    const restarted = createDeviceIdentityStore({
      filePath,
      idFactory: () => "must-not-replace",
      label: "MacBook",
      platform: "macos",
    });
    await expect(restarted.loadOrCreate()).rejects.toMatchObject({
      code: "device_identity_corrupt",
    });
  });

  it("uses Windows ACL policy without POSIX chmod or mode-bit rejection", async () => {
    const filePath = await temporaryDevicePath();
    const chmodAttempt = vi.fn(async () => {
      throw new Error("chmod must not be used by the Windows policy");
    });
    const store = createDeviceIdentityStore({
      filePath,
      idFactory: () => "windows-installation",
      label: "Windows PC",
      platform: "windows",
      enforcePosixPermissions: false,
      fileSystem: { ...nodeCredentialFileSystem, chmod: chmodAttempt },
    });

    await expect(store.loadOrCreate()).resolves.toMatchObject({ id: "windows-installation" });
    expect(chmodAttempt).not.toHaveBeenCalled();
    await chmod(filePath, 0o666);
    await chmod(join(filePath, ".."), 0o777);

    const restarted = createDeviceIdentityStore({
      filePath,
      idFactory: () => "must-not-replace",
      label: "Windows PC",
      platform: "windows",
      enforcePosixPermissions: false,
    });
    await expect(restarted.loadOrCreate()).resolves.toMatchObject({ id: "windows-installation" });
  });

  it("still rejects a device identity symlink when POSIX mode enforcement is disabled", async () => {
    const filePath = await temporaryDevicePath();
    const store = createDeviceIdentityStore({
      filePath,
      idFactory: () => "windows-installation",
      label: "Windows PC",
      platform: "windows",
      enforcePosixPermissions: false,
    });
    await store.loadOrCreate();
    const targetPath = `${filePath}.target`;
    await rename(filePath, targetPath);
    await symlink(targetPath, filePath);

    const restarted = createDeviceIdentityStore({
      filePath,
      label: "Windows PC",
      platform: "windows",
      enforcePosixPermissions: false,
    });
    await expect(restarted.loadOrCreate()).rejects.toMatchObject({
      code: "device_identity_corrupt",
    });
  });
});
