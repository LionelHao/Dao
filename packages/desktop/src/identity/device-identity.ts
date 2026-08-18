import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  IDENTITY_CONTRACT_LIMITS,
  type IdentityDevice,
  type IdentityPlatform,
} from "./contracts.js";
import {
  nodeCredentialFileSystem,
  type CredentialFileSystem,
} from "./credential-vault.js";

export type DeviceIdentityErrorCode = "device_identity_corrupt" | "device_identity_io";

export class DeviceIdentityError extends Error {
  readonly code: DeviceIdentityErrorCode;

  constructor(code: DeviceIdentityErrorCode) {
    super(`Device identity failed: ${code}`);
    this.name = "DeviceIdentityError";
    this.code = code;
  }
}

export interface DeviceIdentityStore {
  loadOrCreate(): Promise<IdentityDevice>;
}

export function identityPlatformFromNode(platform: string): IdentityPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "unknown";
}

type DeviceIdentityFileSystem = Pick<
  CredentialFileSystem,
  "mkdir" | "chmod" | "lstat" | "readFile" | "writeFile" | "rename" | "unlink"
>;

type UnknownRecord = Record<string, unknown>;
const utf8Encoder = new TextEncoder();
const DEVICE_FIELDS = new Set(["version", "id", "label", "platform"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    utf8Encoder.encode(value).byteLength <= maximumBytes;
}

function isDevice(value: unknown): value is IdentityDevice & { readonly version?: 1 } {
  return isRecord(value) && Reflect.ownKeys(value).length === DEVICE_FIELDS.size &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && DEVICE_FIELDS.has(key)) &&
    value.version === 1 &&
    isBoundedString(value.id, IDENTITY_CONTRACT_LIMITS.deviceId) &&
    isBoundedString(value.label, IDENTITY_CONTRACT_LIMITS.deviceLabel) &&
    (value.platform === "macos" || value.platform === "windows" ||
      value.platform === "linux" || value.platform === "unknown");
}

function copyDevice(device: IdentityDevice): IdentityDevice {
  return Object.freeze({ id: device.id, label: device.label, platform: device.platform });
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function createDeviceIdentityStore(options: {
  readonly filePath: string;
  readonly idFactory?: () => string;
  readonly label: string;
  readonly platform: IdentityPlatform;
  /** Windows relies on the per-user userData ACL instead of POSIX mode bits. */
  readonly enforcePosixPermissions?: boolean;
  readonly fileSystem?: DeviceIdentityFileSystem;
  readonly randomSuffix?: () => string;
}): DeviceIdentityStore {
  if (options.filePath.length === 0) throw new TypeError("Device identity path is required");
  if (!isBoundedString(options.label, IDENTITY_CONTRACT_LIMITS.deviceLabel)) {
    throw new TypeError("Device label is invalid");
  }
  const fileSystem = options.fileSystem ?? nodeCredentialFileSystem;
  const enforcePosixPermissions = options.enforcePosixPermissions ?? true;
  const directory = dirname(options.filePath);
  const fileName = basename(options.filePath);
  let currentLoad: Promise<IdentityDevice> | undefined;

  const unlinkTemporary = async (path: string): Promise<void> => {
    try {
      await fileSystem.unlink(path);
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  };

  const loadOrCreate = async (): Promise<IdentityDevice> => {
    try {
      const directoryMetadata = await fileSystem.lstat(directory);
      const metadata = await fileSystem.lstat(options.filePath);
      if (!directoryMetadata.isDirectory() || !metadata.isFile() ||
          (enforcePosixPermissions &&
            ((directoryMetadata.mode & 0o077) !== 0 || (metadata.mode & 0o022) !== 0))) {
        throw new DeviceIdentityError("device_identity_corrupt");
      }
      const data = await fileSystem.readFile(options.filePath);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      } catch {
        throw new DeviceIdentityError("device_identity_corrupt");
      }
      if (!isDevice(value)) throw new DeviceIdentityError("device_identity_corrupt");
      return copyDevice(value);
    } catch (error: unknown) {
      if (error instanceof DeviceIdentityError) throw error;
      if (!hasCode(error, "ENOENT")) throw new DeviceIdentityError("device_identity_io");
    }

    const device: IdentityDevice = {
      id: options.idFactory?.() ?? randomUUID(),
      label: options.label,
      platform: options.platform,
    };
    if (!isBoundedString(device.id, IDENTITY_CONTRACT_LIMITS.deviceId)) {
      throw new DeviceIdentityError("device_identity_io");
    }
    const suffix = options.randomSuffix?.() ?? randomUUID();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(suffix)) {
      throw new DeviceIdentityError("device_identity_io");
    }
    const temporaryPath = join(directory, `${fileName}.${suffix}.tmp`);
    let temporaryCreated = false;
    try {
      await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
      if (enforcePosixPermissions) await fileSystem.chmod(directory, 0o700);
      const data = new TextEncoder().encode(JSON.stringify({ version: 1, ...device }));
      await fileSystem.writeFile(temporaryPath, data, { mode: 0o600, flag: "wx" });
      temporaryCreated = true;
      if (enforcePosixPermissions) await fileSystem.chmod(temporaryPath, 0o600);
      await fileSystem.rename(temporaryPath, options.filePath);
      temporaryCreated = false;
      if (enforcePosixPermissions) await fileSystem.chmod(options.filePath, 0o600);
      return copyDevice(device);
    } catch {
      if (temporaryCreated) {
        try {
          await unlinkTemporary(temporaryPath);
        } catch {
          // The fixed error below remains fail-closed.
        }
      }
      throw new DeviceIdentityError("device_identity_io");
    }
  };

  return {
    loadOrCreate() {
      currentLoad ??= loadOrCreate().catch((error: unknown) => {
        currentLoad = undefined;
        throw error;
      });
      return currentLoad;
    },
  };
}
