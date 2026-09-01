import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DesktopOfflineReadLeaseError,
  createDesktopOfflineReadLeaseVerifier,
  type DesktopOfflineReadLeaseBinding,
  type DesktopOfflineReadLeaseClaims,
} from "./offline-read-lease.js";

const keys = generateKeyPairSync("ed25519");
const now = 1_800_000_000_000;
const binding: DesktopOfflineReadLeaseBinding = {
  tenantId: "tenant-1", accountId: "account-1", actorId: "human-1",
  sessionFamilyId: "family-1", deviceId: "device-1", installationId: "installation-1",
  serverSubject: "authority.example", roomId: "room-1", lifecycleGeneration: 4,
  accessRevision: 7, leaseGeneration: 2,
};
const claims: DesktopOfflineReadLeaseClaims = {
  version: 1, keyId: "key-1", leaseId: "lease-1", tenantId: binding.tenantId,
  accountId: binding.accountId, actorId: binding.actorId, actorKind: "human",
  sessionFamilyId: binding.sessionFamilyId, deviceId: binding.deviceId,
  installationId: binding.installationId, serverSubject: binding.serverSubject,
  room: { roomId: binding.roomId, lifecycleGeneration: binding.lifecycleGeneration,
    accessRevision: binding.accessRevision, leaseGeneration: binding.leaseGeneration },
  issuedAtMs: now - 1_000, notBeforeMs: now - 1_000, expiresAtMs: now + 1_000,
};

function canonical(value: DesktopOfflineReadLeaseClaims): string {
  return JSON.stringify({
    version: value.version, keyId: value.keyId, leaseId: value.leaseId,
    tenantId: value.tenantId, accountId: value.accountId, actorId: value.actorId,
    actorKind: value.actorKind, sessionFamilyId: value.sessionFamilyId,
    deviceId: value.deviceId, installationId: value.installationId,
    serverSubject: value.serverSubject,
    room: { roomId: value.room.roomId, lifecycleGeneration: value.room.lifecycleGeneration,
      accessRevision: value.room.accessRevision, leaseGeneration: value.room.leaseGeneration },
    issuedAtMs: value.issuedAtMs, notBeforeMs: value.notBeforeMs, expiresAtMs: value.expiresAtMs,
  });
}

function token(value = claims, privateKey: KeyObject = keys.privateKey): string {
  const text = canonical(value);
  return `${Buffer.from(text).toString("base64url")}.${sign(null, Buffer.from(text), privateKey).toString("base64url")}`;
}

describe("Desktop OfflineReadLease verifier", () => {
  it("accepts only a canonical Ed25519 token with an exact binding and complete active generation", () => {
    const verifier = createDesktopOfflineReadLeaseVerifier({
      verificationKeys: new Map([["key-1", keys.publicKey]]), now: () => now,
    });
    expect(verifier.verifyForActiveGeneration(token(), binding, {
      roomId: "room-1", complete: true, lifecycleGeneration: 4,
      accessRevision: 7, leaseGeneration: 2,
    })).toEqual(claims);
  });

  it("expires at the exact millisecond and never grants an incomplete generation", () => {
    const atExpiry = createDesktopOfflineReadLeaseVerifier({
      verificationKeys: new Map([["key-1", keys.publicKey]]), now: () => claims.expiresAtMs,
    });
    expect(() => atExpiry.verify(token(), binding)).toThrowError(
      expect.objectContaining({ reason: "expired" }),
    );
    const valid = createDesktopOfflineReadLeaseVerifier({
      verificationKeys: new Map([["key-1", keys.publicKey]]), now: () => now,
    });
    expect(() => valid.verifyForActiveGeneration(token(), binding, {
      roomId: "room-1", complete: false, lifecycleGeneration: 4,
      accessRevision: 7, leaseGeneration: 2,
    })).toThrowError(expect.objectContaining({ reason: "generation_mismatch" }));
  });

  it("enforces previous-key issuance and verification cutoffs at exact boundaries", () => {
    const previousKeyWindows = new Map([["key-1", {
      issuanceCutoffMs: now,
      verificationCutoffMs: now + 500,
    }]]);
    const duringOverlap = createDesktopOfflineReadLeaseVerifier({
      verificationKeys: new Map([["key-1", keys.publicKey]]), previousKeyWindows,
      now: () => now + 499,
    });
    expect(duringOverlap.verify(token(), binding)).toEqual(claims);

    const issuedAtCutoff = { ...claims, issuedAtMs: now, notBeforeMs: now };
    expect(() => duringOverlap.verify(token(issuedAtCutoff), binding))
      .toThrowError(expect.objectContaining({ reason: "key_issuance_cutoff" }));

    const atVerificationCutoff = createDesktopOfflineReadLeaseVerifier({
      verificationKeys: new Map([["key-1", keys.publicKey]]), previousKeyWindows,
      now: () => now + 500,
    });
    expect(() => atVerificationCutoff.verify(token(), binding))
      .toThrowError(expect.objectContaining({ reason: "key_verification_cutoff" }));
  });

  it.each([
    ["accountId", { accountId: "other-account" }],
    ["deviceId", { deviceId: "other-device" }],
    ["installationId", { installationId: "other-installation" }],
    ["serverSubject", { serverSubject: "other-authority" }],
    ["roomId", { roomId: "room-2" }],
    ["accessRevision", { accessRevision: 8 }],
    ["leaseGeneration", { leaseGeneration: 3 }],
  ] as const)("rejects a mismatched %s binding", (_label, mismatch) => {
    const verifier = createDesktopOfflineReadLeaseVerifier({
      verificationKeys: new Map([["key-1", keys.publicKey]]), now: () => now,
    });
    expect(() => verifier.verify(token(), { ...binding, ...mismatch }))
      .toThrowError(expect.objectContaining({ reason: "binding_mismatch" }));
  });

  it("rejects noncanonical claims, unknown keys and signature tampering as closed errors", () => {
    const verifier = createDesktopOfflineReadLeaseVerifier({
      verificationKeys: new Map([["key-1", keys.publicKey]]), now: () => now,
    });
    const noncanonicalText = JSON.stringify({ ...claims, actorKind: "human" }, null, 2);
    const noncanonical = `${Buffer.from(noncanonicalText).toString("base64url")}.${
      sign(null, Buffer.from(noncanonicalText), keys.privateKey).toString("base64url")}`;
    expect(() => verifier.verify(noncanonical, binding))
      .toThrowError(expect.objectContaining({ reason: "noncanonical_claims" }));
    expect(() => verifier.verify(token({ ...claims, keyId: "unknown" }), binding))
      .toThrowError(expect.objectContaining({ reason: "unknown_key" }));
    const tampered = `${token().slice(0, -1)}${token().endsWith("A") ? "B" : "A"}`;
    expect(() => verifier.verify(tampered, binding)).toThrowError(DesktopOfflineReadLeaseError);
  });
});
