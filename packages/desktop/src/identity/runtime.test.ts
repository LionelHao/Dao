import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_IPC_CHANNELS } from "./contracts.js";
import {
  createDesktopIdentityRuntime,
  createIdentityDeviceLabel,
  createSafeStorageEncryption,
} from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })));
});

describe("Desktop Identity runtime composition", () => {
  it("adapts safeStorage without a plaintext fallback", () => {
    const encryptString = vi.fn(() => Uint8Array.from([1, 2, 3]));
    const decryptString = vi.fn(() => "decrypted");
    const getSelectedStorageBackend = vi.fn(() => "unknown" as const);
    const encryption = createSafeStorageEncryption({
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend,
      encryptString,
      decryptString,
    }, "macos");

    expect(encryption.isEncryptionAvailable()).toBe(true);
    expect(getSelectedStorageBackend).not.toHaveBeenCalled();
    expect(encryption.encryptString("secret")).toEqual(Uint8Array.from([1, 2, 3]));
    expect(encryption.decryptString(Uint8Array.from([4, 5]))).toBe("decrypted");
    expect(encryptString).toHaveBeenCalledWith("secret");
    expect(decryptString.mock.calls[0]?.[0]).toEqual(Uint8Array.from([4, 5]));
  });

  it.each(["basic_text", "unknown"] as const)(
    "fails Linux safeStorage closed for the %s backend",
    (backend) => {
      const getSelectedStorageBackend = vi.fn(() => backend);
      const encryption = createSafeStorageEncryption({
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend,
        encryptString: () => Uint8Array.of(1),
        decryptString: () => "unused",
      }, "linux");

      expect(encryption.isEncryptionAvailable()).toBe(false);
      expect(getSelectedStorageBackend).toHaveBeenCalledOnce();
    },
  );

  it.each(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"] as const)(
    "accepts Linux safeStorage backed by %s",
    (backend) => {
      const getSelectedStorageBackend = vi.fn(() => backend);
      const encryption = createSafeStorageEncryption({
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend,
        encryptString: () => Uint8Array.of(1),
        decryptString: () => "unused",
      }, "linux");

      expect(encryption.isEncryptionAvailable()).toBe(true);
      expect(getSelectedStorageBackend).toHaveBeenCalledOnce();
    },
  );

  it("fails Linux safeStorage closed when the selected backend cannot be queried", () => {
    const encryption = createSafeStorageEncryption({
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => {
        throw new Error("backend unavailable");
      },
      encryptString: () => Uint8Array.of(1),
      decryptString: () => "unused",
    }, "linux");

    expect(encryption.isEncryptionAvailable()).toBe(false);
  });

  it("bounds the main-owned device label by UTF-8 bytes", () => {
    const label = createIdentityDeviceLabel("原生协作".repeat(30), "host.local");

    expect(label.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(label).byteLength).toBeLessThanOrEqual(128);
  });

  it("registers fixed IPC before initialization and tears down idempotently", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "dao-desktop-identity-"));
    temporaryDirectories.push(dataDirectory);
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const removed: string[] = [];
    const mainFrame = {};
    const webContents = {
      mainFrame,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const webSocketFactory = vi.fn(() => {
      throw new Error("signed-out startup must not create a socket");
    });
    const runtime = createDesktopIdentityRuntime({
      dataDirectory,
      deviceLabel: "Dao on test-host",
      platform: "macos",
      endpoint: "ws://127.0.0.1:8787",
      encryption: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => new TextEncoder().encode(value),
        decryptString: (value) => new TextDecoder().decode(value),
      },
      webSocketFactory,
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
        removeHandler(channel) {
          handlers.delete(channel);
          removed.push(channel);
        },
      },
      webContents,
    });

    expect([...handlers]).toHaveLength(5);
    await expect(runtime.initialize()).resolves.toEqual({ status: "signed-out" });
    expect(webSocketFactory).not.toHaveBeenCalled();
    await expect(handlers.get(IDENTITY_IPC_CHANNELS.getState)?.({
      sender: webContents,
      senderFrame: mainFrame,
    })).resolves.toEqual({ status: "signed-out" });

    runtime.close();
    runtime.close();
    expect(handlers.size).toBe(0);
    expect(new Set(removed).size).toBe(5);
  });

  it("rejects a non-loopback plaintext endpoint before touching IPC or disk", () => {
    const handle = vi.fn();

    expect(() => createDesktopIdentityRuntime({
      dataDirectory: "/unused",
      deviceLabel: "Dao",
      platform: "macos",
      endpoint: "ws://example.com:8787",
      encryption: {
        isEncryptionAvailable: () => true,
        encryptString: () => Uint8Array.of(1),
        decryptString: () => "unused",
      },
      webSocketFactory: vi.fn(),
      ipcMain: { handle, removeHandler: vi.fn() },
      webContents: { mainFrame: {}, isDestroyed: () => false, send: vi.fn() },
    })).toThrow(/endpoint is not allowed/i);
    expect(handle).not.toHaveBeenCalled();
  });
});
