import { verify as verifySignature, type KeyObject } from "node:crypto";

export type DesktopOfflineReadLeaseReason =
  | "malformed_token"
  | "malformed_claims"
  | "noncanonical_claims"
  | "unknown_key"
  | "bad_signature"
  | "not_yet_valid"
  | "expired"
  | "binding_mismatch"
  | "generation_mismatch"
  | "invalid_clock";

export class DesktopOfflineReadLeaseError extends Error {
  readonly code = "offline_read_lease_rejected";

  constructor(readonly reason: DesktopOfflineReadLeaseReason) {
    super(`Desktop OfflineReadLease rejected: ${reason}`);
    this.name = "DesktopOfflineReadLeaseError";
  }
}

export interface DesktopOfflineReadLeaseClaims {
  readonly version: 1;
  readonly keyId: string;
  readonly leaseId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly actorKind: "human";
  readonly sessionFamilyId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly serverSubject: string;
  readonly room: Readonly<{
    roomId: string;
    lifecycleGeneration: number;
    accessRevision: number;
    leaseGeneration: number;
  }>;
  readonly issuedAtMs: number;
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
}

export interface DesktopOfflineReadLeaseBinding {
  readonly tenantId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly sessionFamilyId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly serverSubject: string;
  readonly roomId: string;
  readonly lifecycleGeneration: number;
  readonly accessRevision: number;
  readonly leaseGeneration: number;
}

export interface DesktopActiveGenerationBinding {
  readonly roomId: string;
  readonly complete: boolean;
  readonly lifecycleGeneration: number;
  readonly accessRevision: number;
  readonly leaseGeneration: number;
}

export interface DesktopOfflineReadLeaseVerifier {
  verify(token: string, expected: DesktopOfflineReadLeaseBinding): DesktopOfflineReadLeaseClaims;
  verifyForActiveGeneration(
    token: string,
    expected: DesktopOfflineReadLeaseBinding,
    generation: DesktopActiveGenerationBinding,
  ): DesktopOfflineReadLeaseClaims;
}

function reject(reason: DesktopOfflineReadLeaseReason): never {
  throw new DesktopOfflineReadLeaseError(reason);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function claims(value: unknown): value is DesktopOfflineReadLeaseClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, [
    "version", "keyId", "leaseId", "tenantId", "accountId", "actorId", "actorKind",
    "sessionFamilyId", "deviceId", "installationId", "serverSubject", "room",
    "issuedAtMs", "notBeforeMs", "expiresAtMs",
  ]) || candidate.version !== 1 || candidate.actorKind !== "human" ||
      ![candidate.keyId, candidate.leaseId, candidate.tenantId, candidate.accountId,
        candidate.actorId, candidate.sessionFamilyId, candidate.deviceId,
        candidate.installationId, candidate.serverSubject].every(nonempty) ||
      !nonnegativeInteger(candidate.issuedAtMs) ||
      !nonnegativeInteger(candidate.notBeforeMs) ||
      !nonnegativeInteger(candidate.expiresAtMs) ||
      candidate.notBeforeMs < candidate.issuedAtMs ||
      candidate.expiresAtMs <= candidate.notBeforeMs ||
      typeof candidate.room !== "object" || candidate.room === null ||
      Array.isArray(candidate.room)) return false;
  const room = candidate.room as Record<string, unknown>;
  return exactKeys(room, [
    "roomId", "lifecycleGeneration", "accessRevision", "leaseGeneration",
  ]) && nonempty(room.roomId) && nonnegativeInteger(room.lifecycleGeneration) &&
    nonnegativeInteger(room.accessRevision) && nonnegativeInteger(room.leaseGeneration);
}

function canonical(value: DesktopOfflineReadLeaseClaims): string {
  return JSON.stringify({
    version: value.version,
    keyId: value.keyId,
    leaseId: value.leaseId,
    tenantId: value.tenantId,
    accountId: value.accountId,
    actorId: value.actorId,
    actorKind: value.actorKind,
    sessionFamilyId: value.sessionFamilyId,
    deviceId: value.deviceId,
    installationId: value.installationId,
    serverSubject: value.serverSubject,
    room: {
      roomId: value.room.roomId,
      lifecycleGeneration: value.room.lifecycleGeneration,
      accessRevision: value.room.accessRevision,
      leaseGeneration: value.room.leaseGeneration,
    },
    issuedAtMs: value.issuedAtMs,
    notBeforeMs: value.notBeforeMs,
    expiresAtMs: value.expiresAtMs,
  });
}

function bindingMatches(
  value: DesktopOfflineReadLeaseClaims,
  expected: DesktopOfflineReadLeaseBinding,
): boolean {
  return value.tenantId === expected.tenantId && value.accountId === expected.accountId &&
    value.actorId === expected.actorId && value.sessionFamilyId === expected.sessionFamilyId &&
    value.deviceId === expected.deviceId && value.installationId === expected.installationId &&
    value.serverSubject === expected.serverSubject && value.room.roomId === expected.roomId &&
    value.room.lifecycleGeneration === expected.lifecycleGeneration &&
    value.room.accessRevision === expected.accessRevision &&
    value.room.leaseGeneration === expected.leaseGeneration;
}

export function createDesktopOfflineReadLeaseVerifier(options: Readonly<{
  verificationKeys: ReadonlyMap<string, KeyObject>;
  now?: () => number;
}>): DesktopOfflineReadLeaseVerifier {
  const now = options.now ?? Date.now;
  const verify = (
    token: string,
    expected: DesktopOfflineReadLeaseBinding,
  ): DesktopOfflineReadLeaseClaims => {
    if (!nonempty(token) || token.length > 64 * 1024) reject("malformed_token");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
      reject("malformed_token");
    }
    let text: string;
    let signature: Buffer;
    try {
      text = Buffer.from(parts[0]!, "base64url").toString("utf8");
      signature = Buffer.from(parts[1]!, "base64url");
    } catch {
      reject("malformed_token");
    }
    if (Buffer.from(text).toString("base64url") !== parts[0] ||
        signature.toString("base64url") !== parts[1] || signature.byteLength !== 64) {
      reject("malformed_token");
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { reject("malformed_claims"); }
    if (!claims(value)) reject("malformed_claims");
    if (canonical(value) !== text) reject("noncanonical_claims");
    const key = options.verificationKeys.get(value.keyId);
    if (key === undefined) reject("unknown_key");
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519" ||
        !verifySignature(null, Buffer.from(text), key, signature)) reject("bad_signature");
    const instant = now();
    if (!nonnegativeInteger(instant)) reject("invalid_clock");
    if (instant < value.notBeforeMs) reject("not_yet_valid");
    if (instant >= value.expiresAtMs) reject("expired");
    if (!bindingMatches(value, expected)) reject("binding_mismatch");
    return Object.freeze({ ...value, room: Object.freeze({ ...value.room }) });
  };

  return Object.freeze({
    verify,
    verifyForActiveGeneration(
      token: string,
      expected: DesktopOfflineReadLeaseBinding,
      generation: DesktopActiveGenerationBinding,
    ) {
      const value = verify(token, expected);
      if (!generation.complete || generation.roomId !== value.room.roomId ||
          generation.lifecycleGeneration !== value.room.lifecycleGeneration ||
          generation.accessRevision !== value.room.accessRevision ||
          generation.leaseGeneration !== value.room.leaseGeneration) {
        reject("generation_mismatch");
      }
      return value;
    },
  });
}
