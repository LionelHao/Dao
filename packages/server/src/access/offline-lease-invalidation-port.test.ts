import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  mintDatabaseAuthorityTransactionView,
  releaseDatabaseAuthorityTransactionView,
} from "../persistence/authority-transaction-database.js";
import { isParticipantRegistration } from "../room-governance/private-participant-contracts.js";
import { ROOM_ACCESS_AUTHORITY_SCHEMA_STATEMENTS } from "./room-cache-invalidation-port.js";
import {
  OFFLINE_READ_LEASE_SCHEMA_STATEMENTS,
  OfflineReadLeaseValidationError,
  OfflineReadLeaseVerifier,
  OfflineReadLeaseIssuer,
  createOfflineLeaseInvalidationRegistration,
} from "./offline-lease-invalidation-port.js";

const NOW = 1_800_000_000_000;
const MAX_LEASE_MS = 60_000;

function createDatabase(path = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE actors (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent'))
    ) STRICT;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      archive_generation INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE room_memberships (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      actor_id TEXT NOT NULL REFERENCES actors(id),
      kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
      access_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, actor_id)
    ) STRICT;
    CREATE TABLE session_families (
      family_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES actors(id),
      device_id TEXT NOT NULL,
      refresh_expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    ) STRICT;
    INSERT INTO actors VALUES ('human-1', 'human');
    INSERT INTO rooms VALUES ('room-1', 'active', 0);
    INSERT INTO room_memberships VALUES ('room-1', 'human-1', 'human', 0);
    INSERT INTO session_families VALUES (
      'family-1', 'account-1', 'human-1', 'device-1', ${NOW + 300_000}, NULL
    );
    ${ROOM_ACCESS_AUTHORITY_SCHEMA_STATEMENTS.join(";\n")};
    ${OFFLINE_READ_LEASE_SCHEMA_STATEMENTS.join(";\n")};
  `);
  return database;
}

describe("offline lease production authority", () => {
  it("requires an explicit finite policy for the exact enabled production registration", () => {
    const registration = createOfflineLeaseInvalidationRegistration({
      maxOfflineReadLeaseMs: MAX_LEASE_MS,
    });
    expect(isParticipantRegistration(registration)).toBe(true);
    expect(registration).toMatchObject({
      registrationId: "dao.access.offline-lease-invalidation.v1",
      feature: "offline-lease-invalidation",
      version: 1,
      enabled: true,
    });
    expect(() => createOfflineLeaseInvalidationRegistration({
      maxOfflineReadLeaseMs: Number.POSITIVE_INFINITY,
    })).toThrow(new OfflineReadLeaseValidationError("invalid_policy"));
  });

  it("issues a finite human/device/installation/server/room-bound Ed25519 lease and verifies it", () => {
    const database = createDatabase();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    try {
      database.exec("BEGIN IMMEDIATE");
      const tx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-issue");
      const issuer = new OfflineReadLeaseIssuer({
        tenantId: "tenant-1",
        serverSubject: "server-1",
        keyId: "key-1",
        privateKey,
        maxOfflineReadLeaseMs: MAX_LEASE_MS,
        now: () => NOW,
        createLeaseId: () => "lease-1",
      });
      const issued = issuer.issueInTransaction(tx, {
        roomId: "room-1",
        accountId: "account-1",
        actorId: "human-1",
        sessionFamilyId: "family-1",
        deviceId: "device-1",
        installationId: "installation-1",
        requestedLeaseMs: 30_000,
        expectedLifecycleGeneration: 0,
        expectedAccessRevision: 0,
        expectedLeaseGeneration: 0,
      });
      releaseDatabaseAuthorityTransactionView(tx);
      database.exec("COMMIT");

      expect(issued.claims).toMatchObject({
        version: 1,
        keyId: "key-1",
        leaseId: "lease-1",
        tenantId: "tenant-1",
        accountId: "account-1",
        actorId: "human-1",
        actorKind: "human",
        sessionFamilyId: "family-1",
        deviceId: "device-1",
        installationId: "installation-1",
        serverSubject: "server-1",
        room: {
          roomId: "room-1",
          lifecycleGeneration: 0,
          accessRevision: 0,
          leaseGeneration: 0,
        },
        issuedAtMs: NOW,
        notBeforeMs: NOW,
        expiresAtMs: NOW + 30_000,
      });
      expect(database.prepare(`
        SELECT lease_id, room_id, actor_id, key_id, revoked_at_ms
        FROM offline_read_lease_issuances
      `).get()).toEqual({
        lease_id: "lease-1",
        room_id: "room-1",
        actor_id: "human-1",
        key_id: "key-1",
        revoked_at_ms: null,
      });

      const verifier = new OfflineReadLeaseVerifier({
        verificationKeys: new Map([["key-1", publicKey]]),
        now: () => NOW + 1,
      });
      expect(verifier.verify(issued.token, expectedBinding())).toEqual(issued.claims);
    } finally {
      database.close();
    }
  });

  it("keeps signing material and bearer lease tokens out of SQLite and WAL bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "dao-offline-lease-secret-"));
    const path = join(directory, "authority.sqlite");
    const database = createDatabase(path);
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyBytes = privateKey.export({ format: "der", type: "pkcs8" });
    try {
      database.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
      const tx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-secret-sentinel");
      const issued = new OfflineReadLeaseIssuer({
        tenantId: "tenant-secret-sentinel",
        serverSubject: "server-secret-sentinel",
        keyId: "key-secret-sentinel",
        privateKey,
        maxOfflineReadLeaseMs: MAX_LEASE_MS,
        now: () => NOW,
        createLeaseId: () => "lease-secret-sentinel",
      }).issueInTransaction(tx, {
        roomId: "room-1",
        accountId: "account-1",
        actorId: "human-1",
        sessionFamilyId: "family-1",
        deviceId: "device-1",
        installationId: "installation-1",
        requestedLeaseMs: 30_000,
        expectedLifecycleGeneration: 0,
        expectedAccessRevision: 0,
        expectedLeaseGeneration: 0,
      });
      releaseDatabaseAuthorityTransactionView(tx);
      database.exec("COMMIT");

      const durableBytes = [path, `${path}-wal`, `${path}-shm`]
        .filter(existsSync)
        .map((file) => readFileSync(file));
      for (const bytes of durableBytes) {
        expect(bytes.indexOf(privateKeyBytes)).toBe(-1);
        expect(bytes.toString("utf8")).not.toContain(issued.token);
      }
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for absent/invalid policy, excessive TTL, revoked session, and stale issue races", () => {
    const database = createDatabase();
    const { privateKey } = generateKeyPairSync("ed25519");
    try {
      const options = {
        tenantId: "tenant-1",
        serverSubject: "server-1",
        keyId: "key-1",
        privateKey,
        now: () => NOW,
      };
      expect(() => new OfflineReadLeaseIssuer({
        ...options,
        maxOfflineReadLeaseMs: undefined as unknown as number,
      })).toThrow(new OfflineReadLeaseValidationError("invalid_policy"));
      expect(() => new OfflineReadLeaseIssuer({
        ...options,
        maxOfflineReadLeaseMs: 0,
      })).toThrow(new OfflineReadLeaseValidationError("invalid_policy"));

      const issuer = new OfflineReadLeaseIssuer({
        ...options,
        maxOfflineReadLeaseMs: MAX_LEASE_MS,
        createLeaseId: () => "lease-race",
      });
      database.exec("BEGIN IMMEDIATE");
      const tx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-race");
      expect(() => issuer.issueInTransaction(tx, {
        ...issueInput(),
        requestedLeaseMs: MAX_LEASE_MS + 1,
      })).toThrow(new OfflineReadLeaseValidationError("lease_too_long"));
      database.prepare(`
        INSERT INTO room_access_authority (room_id, access_revision, lease_generation)
        VALUES ('room-1', 1, 1)
      `).run();
      expect(() => issuer.issueInTransaction(tx, issueInput())).toThrow(
        new OfflineReadLeaseValidationError("authority_revision_mismatch"),
      );
      releaseDatabaseAuthorityTransactionView(tx);
      database.exec("ROLLBACK");

      database.prepare("UPDATE session_families SET revoked_at = ?").run(NOW);
      database.exec("BEGIN IMMEDIATE");
      const revokedTx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-revoked");
      expect(() => issuer.issueInTransaction(revokedTx, issueInput())).toThrow(
        new OfflineReadLeaseValidationError("subject_unauthorized"),
      );
      releaseDatabaseAuthorityTransactionView(revokedTx);
      database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  });

  it("rejects wrong subject/device/revision/generation, exact expiry, and signature mutation", () => {
    const database = createDatabase();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    try {
      database.exec("BEGIN IMMEDIATE");
      const tx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-verify");
      const issuer = new OfflineReadLeaseIssuer({
        tenantId: "tenant-1",
        serverSubject: "server-1",
        keyId: "key-1",
        privateKey,
        maxOfflineReadLeaseMs: MAX_LEASE_MS,
        now: () => NOW,
        createLeaseId: () => "lease-verify",
      });
      const issued = issuer.issueInTransaction(tx, issueInput());
      releaseDatabaseAuthorityTransactionView(tx);
      database.exec("COMMIT");
      const verifier = new OfflineReadLeaseVerifier({
        verificationKeys: new Map([["key-1", publicKey]]),
        now: () => NOW + 1,
      });

      for (const changed of [
        { ...expectedBinding(), serverSubject: "server-2" },
        { ...expectedBinding(), deviceId: "device-2" },
        { ...expectedBinding(), accessRevision: 1 },
        { ...expectedBinding(), leaseGeneration: 1 },
      ]) {
        expect(() => verifier.verify(issued.token, changed)).toThrow(
          new OfflineReadLeaseValidationError("binding_mismatch"),
        );
      }
      expect(() => new OfflineReadLeaseVerifier({
        verificationKeys: new Map([["key-1", publicKey]]),
        now: () => NOW + 30_000,
      }).verify(issued.token, expectedBinding())).toThrow(
        new OfflineReadLeaseValidationError("expired"),
      );
      const [encodedClaims, encodedSignature] = issued.token.split(".") as [string, string];
      const signature = Buffer.from(encodedSignature, "base64url");
      signature[0] = signature[0]! ^ 1;
      const mutated = `${encodedClaims}.${signature.toString("base64url")}`;
      expect(() => verifier.verify(mutated, expectedBinding())).toThrow(
        new OfflineReadLeaseValidationError("bad_signature"),
      );
    } finally {
      database.close();
    }
  });

  it("invalidates current issuances monotonically, replays once, and binds the archive race", () => {
    const database = createDatabase();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    try {
      const issuer = new OfflineReadLeaseIssuer({
        tenantId: "tenant-1",
        serverSubject: "server-1",
        keyId: "key-1",
        privateKey,
        maxOfflineReadLeaseMs: MAX_LEASE_MS,
        now: () => NOW,
        createLeaseId: () => "lease-before-archive",
      });
      database.exec("BEGIN IMMEDIATE");
      const issueTx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-before-archive");
      const issued = issuer.issueInTransaction(issueTx, issueInput());
      releaseDatabaseAuthorityTransactionView(issueTx);
      database.exec("COMMIT");

      database.exec("BEGIN IMMEDIATE");
      database.prepare("UPDATE rooms SET status = 'archived', archive_generation = 1").run();
      const registration = createOfflineLeaseInvalidationRegistration({
        maxOfflineReadLeaseMs: MAX_LEASE_MS,
      });
      const input = {
        roomId: "room-1",
        lifecycleGeneration: 1,
        reason: "room_archived" as const,
      };
      const rollbackTx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-rollback");
      registration.participant?.invalidateOfflineLeasesInTransaction(rollbackTx, input);
      releaseDatabaseAuthorityTransactionView(rollbackTx);
      database.exec("ROLLBACK");
      expect(database.prepare("SELECT revoked_at_ms FROM offline_read_lease_issuances").get())
        .toEqual({ revoked_at_ms: null });
      expect(database.prepare("SELECT lease_generation FROM room_access_authority").get())
        .toEqual({ lease_generation: 0 });

      database.exec("BEGIN IMMEDIATE");
      database.prepare("UPDATE rooms SET status = 'archived', archive_generation = 1").run();
      const archiveTx = mintDatabaseAuthorityTransactionView(database, "room-1", "tx-archive");
      const first = registration.participant?.invalidateOfflineLeasesInTransaction(archiveTx, input);
      const replay = registration.participant?.invalidateOfflineLeasesInTransaction(archiveTx, input);
      expect(first).toEqual({
        ok: true,
        result: {
          roomId: "room-1",
          lifecycleGeneration: 1,
          leaseGeneration: 1,
          revokedLeaseCount: 1,
          maxOfflineReadLeaseMs: MAX_LEASE_MS,
        },
      });
      expect(replay).toEqual(first);
      releaseDatabaseAuthorityTransactionView(archiveTx);
      database.exec("COMMIT");

      expect(database.prepare("SELECT revoked_at_ms FROM offline_read_lease_issuances").get())
        .toMatchObject({ revoked_at_ms: expect.any(Number) });
      const verifier = new OfflineReadLeaseVerifier({
        verificationKeys: new Map([["key-1", publicKey]]),
        now: () => NOW + 1,
      });
      expect(() => verifier.verify(issued.token, {
        ...expectedBinding(),
        lifecycleGeneration: 1,
        leaseGeneration: 1,
      })).toThrow(new OfflineReadLeaseValidationError("binding_mismatch"));
    } finally {
      database.close();
    }
  });
});

function issueInput() {
  return {
    roomId: "room-1",
    accountId: "account-1",
    actorId: "human-1",
    sessionFamilyId: "family-1",
    deviceId: "device-1",
    installationId: "installation-1",
    requestedLeaseMs: 30_000,
    expectedLifecycleGeneration: 0,
    expectedAccessRevision: 0,
    expectedLeaseGeneration: 0,
  } as const;
}

function expectedBinding() {
  return {
    tenantId: "tenant-1",
    accountId: "account-1",
    actorId: "human-1",
    sessionFamilyId: "family-1",
    deviceId: "device-1",
    installationId: "installation-1",
    serverSubject: "server-1",
    roomId: "room-1",
    lifecycleGeneration: 0,
    accessRevision: 0,
    leaseGeneration: 0,
  } as const;
}
