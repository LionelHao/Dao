import { join } from "node:path";
import {
  IDENTITY_CONTRACT_LIMITS,
  type IdentityPlatform,
  type IdentityPublicState,
} from "./contracts.js";
import {
  createIdentitySessionController,
  NOOP_AUTHORIZED_STATE_INVALIDATOR,
  type AuthorizedStateInvalidator,
  type IdentitySessionController,
} from "./controller.js";
import {
  createCredentialVault,
  type CredentialEncryption,
} from "./credential-vault.js";
import { createDeviceIdentityStore } from "./device-identity.js";
import {
  registerIdentityIpc,
  type IdentityIpcMain,
  type IdentityIpcWebContents,
} from "./ipc.js";
import {
  createIdentityWebSocketClient,
  validateIdentityWebSocketEndpoint,
  type IdentityWebSocketLike,
} from "./websocket-client.js";

export interface SafeStoragePort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend():
    | "basic_text"
    | "gnome_libsecret"
    | "kwallet"
    | "kwallet5"
    | "kwallet6"
    | "unknown";
  encryptString(plaintext: string): Uint8Array;
  decryptString(ciphertext: Uint8Array): string;
}

const SECURE_LINUX_SAFE_STORAGE_BACKENDS = new Set([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);

export function createSafeStorageEncryption(
  safeStorage: SafeStoragePort,
  platform: IdentityPlatform,
): CredentialEncryption {
  return Object.freeze({
    isEncryptionAvailable: () => {
      try {
        if (!safeStorage.isEncryptionAvailable()) return false;
        return platform !== "linux" ||
          SECURE_LINUX_SAFE_STORAGE_BACKENDS.has(safeStorage.getSelectedStorageBackend());
      } catch {
        return false;
      }
    },
    encryptString: (plaintext: string) => Uint8Array.from(safeStorage.encryptString(plaintext)),
    decryptString: (ciphertext: Uint8Array) =>
      safeStorage.decryptString(Uint8Array.from(ciphertext)),
  });
}

export function createIdentityDeviceLabel(appName: string, hostName: string): string {
  const candidate = `${appName.trim()} on ${hostName.trim()}`.trim();
  const characters = Array.from(candidate.length === 0 ? "Desktop" : candidate);
  const encoder = new TextEncoder();
  while (
    characters.length > 1 &&
    encoder.encode(characters.join("")).byteLength > IDENTITY_CONTRACT_LIMITS.deviceLabel
  ) {
    characters.pop();
  }
  const label = characters.join("");
  return encoder.encode(label).byteLength <= IDENTITY_CONTRACT_LIMITS.deviceLabel
    ? label
    : "Desktop";
}

export interface DesktopIdentityRuntime {
  readonly controller: IdentitySessionController;
  initialize(): Promise<IdentityPublicState>;
  close(): void;
}

export function createDesktopIdentityRuntime(options: {
  readonly dataDirectory: string;
  readonly deviceLabel: string;
  readonly platform: IdentityPlatform;
  readonly endpoint: string;
  readonly encryption: CredentialEncryption;
  readonly webSocketFactory: (endpoint: string) => IdentityWebSocketLike;
  readonly ipcMain: IdentityIpcMain;
  readonly webContents: IdentityIpcWebContents;
  readonly authorizedState?: AuthorizedStateInvalidator;
}): DesktopIdentityRuntime {
  const endpoint = validateIdentityWebSocketEndpoint(options.endpoint);
  const identityDirectory = join(options.dataDirectory, "identity");
  const enforcePosixPermissions = options.platform !== "windows";
  const vault = createCredentialVault({
    filePath: join(identityDirectory, "credentials.bin"),
    encryption: options.encryption,
    enforcePosixPermissions,
  });
  const deviceIdentity = createDeviceIdentityStore({
    filePath: join(identityDirectory, "device.json"),
    label: options.deviceLabel,
    platform: options.platform,
    enforcePosixPermissions,
  });
  const controller = createIdentitySessionController({
    vault,
    deviceIdentity,
    clientFactory: () => createIdentityWebSocketClient({
      endpoint,
      webSocketFactory: options.webSocketFactory,
    }),
    authorizedState: options.authorizedState ?? NOOP_AUTHORIZED_STATE_INVALIDATOR,
  });
  const unregisterIpc = registerIdentityIpc({
    ipcMain: options.ipcMain,
    webContents: options.webContents,
    controller,
  });
  let closed = false;

  return Object.freeze({
    controller,
    initialize: () => controller.initialize(),
    close() {
      if (closed) return;
      closed = true;
      unregisterIpc();
      controller.close();
    },
  });
}
