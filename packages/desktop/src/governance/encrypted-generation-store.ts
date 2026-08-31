import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CredentialEncryption } from "../identity/credential-vault.js";

type StoreErrorCode =
  | "encryption_unavailable"
  | "key_unwrap_failed"
  | "integrity_failed"
  | "invalid_store"
  | "invalid_generation"
  | "bound_exceeded"
  | "repair_required"
  | "closed";

export class EncryptedGenerationStoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string) {
    super(message);
    this.name = "EncryptedGenerationStoreError";
  }
}

export interface EncryptedGenerationRecord {
  readonly identity: string;
  readonly value: unknown;
}

export interface EncryptedGenerationEvent {
  readonly eventId: string;
  readonly streamSeq: number;
}

export interface EncryptedActiveGenerationBinding {
  readonly roomId: string;
  readonly complete: true;
  readonly lifecycleGeneration: number;
  readonly accessRevision: number;
  readonly leaseGeneration: number;
}

export interface EncryptedAuthorityGenerationStore {
  beginRoomGeneration(input: Readonly<{
    roomId: string;
    snapshotId: string;
    watermark: number;
    expectedCount?: number;
    checksum: string;
  }>): void;
  stageRoomRecords(
    roomId: string,
    snapshotId: string,
    records: readonly EncryptedGenerationRecord[],
  ): void;
  commitRoomGeneration(input: Readonly<{
    roomId: string;
    snapshotId: string;
    watermark: number;
    expectedCount: number;
    checksum: string;
  }>): void;
  discardRoomGeneration(roomId: string, snapshotId: string): void;
  readActiveRoom(roomId: string): Readonly<{
    generationId: string;
    records: readonly EncryptedGenerationRecord[];
    cursor: Readonly<{ version: 1; roomId: string; afterSeq: number }>;
    checksum: string;
  }> | undefined;
  listActiveRoomIds(): readonly string[];
  applyRoomEventBatch(input: Readonly<{
    roomId: string;
    events: readonly EncryptedGenerationEvent[];
    nextCursor: number;
    upserts: readonly EncryptedGenerationRecord[];
    deletes: readonly string[];
    invalidateActiveBinding?: boolean;
  }>): Readonly<{ appliedEventIds: readonly string[]; replayedEventIds: readonly string[] }>;
  classifyRoomEvent(
    roomId: string,
    eventId: string,
    streamSeq: number,
  ): "unseen" | "exact" | "conflict";
  writeOfflineLease(roomId: string, lease: unknown): void;
  readOfflineLease(roomId: string): unknown | undefined;
  clearOfflineLease(roomId: string): void;
  bindActiveGeneration(roomId: string, binding: Readonly<{
    lifecycleGeneration: number;
    accessRevision: number;
    leaseGeneration: number;
  }>): void;
  readActiveGenerationBinding(roomId: string): EncryptedActiveGenerationBinding | undefined;
  clearActiveGenerationBinding(roomId: string): void;
  clearRoom(roomId: string): void;
  clearAccount(): void;
  close(): void;
  destroy(): void;
}

interface Limits {
  readonly maxRecordsPerRoom: number;
  readonly maxRecordBytes: number;
  readonly maxBatchEvents: number;
}

const DEFAULT_LIMITS: Limits = Object.freeze({
  maxRecordsPerRoom: 100_000,
  maxRecordBytes: 1024 * 1024,
  maxBatchEvents: 1_024,
});
const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SCHEMA_VERSION = "3";

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS cache_metadata (
    metadata_key TEXT PRIMARY KEY,
    metadata_value BLOB NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS cache_generations (
    generation_id TEXT PRIMARY KEY,
    room_hash TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    generation_state TEXT NOT NULL CHECK (generation_state IN ('staging', 'active')),
    watermark INTEGER NOT NULL CHECK (watermark >= 0),
    cursor INTEGER NOT NULL CHECK (cursor >= 0),
    expected_count INTEGER NOT NULL CHECK (expected_count >= 0),
    checksum TEXT NOT NULL,
    lifecycle_generation INTEGER CHECK (lifecycle_generation IS NULL OR lifecycle_generation >= 0),
    access_revision INTEGER CHECK (access_revision IS NULL OR access_revision >= 0),
    lease_generation INTEGER CHECK (lease_generation IS NULL OR lease_generation >= 0),
    CHECK (
      (lifecycle_generation IS NULL AND access_revision IS NULL AND lease_generation IS NULL) OR
      (lifecycle_generation IS NOT NULL AND access_revision IS NOT NULL AND lease_generation IS NOT NULL)
    )
  ) STRICT;
  CREATE INDEX IF NOT EXISTS cache_generations_room_state
    ON cache_generations(room_hash, generation_state);
  CREATE UNIQUE INDEX IF NOT EXISTS cache_generations_one_staging_per_room
    ON cache_generations(room_hash) WHERE generation_state = 'staging';
  CREATE TABLE IF NOT EXISTS cache_room_heads (
    room_hash TEXT PRIMARY KEY,
    active_generation_id TEXT NOT NULL UNIQUE
      REFERENCES cache_generations(generation_id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS cache_room_catalog (
    room_hash TEXT PRIMARY KEY REFERENCES cache_room_heads(room_hash) ON DELETE CASCADE,
    sealed_room_id BLOB NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS cache_records (
    generation_id TEXT NOT NULL REFERENCES cache_generations(generation_id) ON DELETE CASCADE,
    identity_hash TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    sealed_record BLOB NOT NULL,
    PRIMARY KEY (generation_id, identity_hash),
    UNIQUE (generation_id, ordinal)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS cache_event_ledger (
    generation_id TEXT NOT NULL REFERENCES cache_generations(generation_id) ON DELETE CASCADE,
    room_hash TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    stream_seq INTEGER NOT NULL CHECK (stream_seq > 0),
    PRIMARY KEY (room_hash, event_hash),
    UNIQUE (room_hash, stream_seq)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS cache_offline_leases (
    room_hash TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES cache_generations(generation_id) ON DELETE CASCADE,
    sealed_lease BLOB NOT NULL
  ) STRICT;
`;

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateText(value: string, label: string): void {
  if (value.length === 0 || value.length > 1_024) {
    throw new EncryptedGenerationStoreError("invalid_store", `${label} is invalid`);
  }
}

function validateLimits(value: Partial<Limits> | undefined): Limits {
  const limits = { ...DEFAULT_LIMITS, ...value };
  if (!positiveSafeInteger(limits.maxRecordsPerRoom) ||
      !positiveSafeInteger(limits.maxRecordBytes) ||
      !positiveSafeInteger(limits.maxBatchEvents)) {
    throw new EncryptedGenerationStoreError("bound_exceeded", "Generation store limits are invalid");
  }
  return Object.freeze(limits);
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (cause: unknown) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw cause;
  }
}

function blob(value: unknown): Buffer {
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new EncryptedGenerationStoreError("invalid_store", "Generation store blob is invalid");
}

function count(value: unknown): number {
  if (typeof value !== "number" || !nonnegativeSafeInteger(value)) {
    throw new EncryptedGenerationStoreError("invalid_store", "Generation store count is invalid");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new EncryptedGenerationStoreError("integrity_failed", "Generation cannot be canonicalized");
}

export function authorityGenerationChecksum(
  kind: "catalog" | "room",
  values: readonly unknown[],
): string {
  return createHash("sha256")
    .update(canonicalJson({ kind, values, version: 1 }), "utf8")
    .digest("hex");
}

function wrapKey(encryption: CredentialEncryption, key: Buffer): Buffer {
  try {
    const wrapped = encryption.encryptString(key.toString("base64"));
    if (!(wrapped instanceof Uint8Array) || wrapped.byteLength === 0) throw new Error("empty key");
    return Buffer.from(wrapped);
  } catch {
    throw new EncryptedGenerationStoreError("key_unwrap_failed", "Data key could not be wrapped");
  }
}

function unwrapKey(encryption: CredentialEncryption, wrapped: Uint8Array): Buffer {
  try {
    const value = encryption.decryptString(Uint8Array.from(wrapped));
    const decoded = Buffer.from(value, "base64");
    if (decoded.byteLength !== DATA_KEY_BYTES || decoded.toString("base64") !== value) {
      throw new Error("invalid key");
    }
    return decoded;
  } catch {
    throw new EncryptedGenerationStoreError("key_unwrap_failed", "Data key could not be unwrapped");
  }
}

function identifierHash(key: Buffer, namespace: string, value: string): string {
  return createHmac("sha256", key).update(namespace).update("\0").update(value).digest("hex");
}

function recordAad(
  tenantHash: string,
  accountHash: string,
  roomHash: string,
  generationId: string,
  identityHash: string,
): Buffer {
  return Buffer.from([
    "dao.desktop.authority-generation",
    SCHEMA_VERSION,
    tenantHash,
    accountHash,
    roomHash,
    generationId,
    identityHash,
  ].join("\0"), "utf8");
}

function sealRecord(
  key: Buffer,
  aad: Buffer,
  record: EncryptedGenerationRecord,
  maxBytes: number,
): Buffer {
  let plaintext: Buffer;
  try { plaintext = Buffer.from(JSON.stringify(record), "utf8"); }
  catch { throw new EncryptedGenerationStoreError("invalid_store", "Record is not JSON serializable"); }
  if (plaintext.byteLength === 0 || plaintext.byteLength > maxBytes) {
    plaintext.fill(0);
    throw new EncryptedGenerationStoreError("bound_exceeded", "Record exceeded the encrypted bound");
  }
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  } finally {
    plaintext.fill(0);
  }
}

function openRecord(
  key: Buffer,
  aad: Buffer,
  sealed: Uint8Array,
  maxBytes: number,
): EncryptedGenerationRecord {
  const bytes = Buffer.from(sealed);
  if (bytes.byteLength <= NONCE_BYTES + TAG_BYTES ||
      bytes.byteLength > maxBytes + NONCE_BYTES + TAG_BYTES) {
    throw new EncryptedGenerationStoreError("integrity_failed", "Encrypted record size is invalid");
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, NONCE_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    plaintext = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new EncryptedGenerationStoreError("integrity_failed", "Encrypted record authentication failed");
  }
  try {
    const value: unknown = JSON.parse(plaintext.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        Reflect.ownKeys(value).length !== 2 ||
        typeof (value as { identity?: unknown }).identity !== "string" ||
        !Object.hasOwn(value, "value")) {
      throw new Error("invalid record");
    }
    return value as EncryptedGenerationRecord;
  } catch {
    throw new EncryptedGenerationStoreError("integrity_failed", "Encrypted record payload is invalid");
  } finally {
    plaintext.fill(0);
  }
}

type EncryptedGenerationStoreOptions = Readonly<{
  databasePath: string;
  accountId: string;
  tenantId?: string;
  encryption: CredentialEncryption;
  limits?: Partial<Limits>;
  fault?: (point: "before-active-flip" | "after-active-flip") => void;
}>;

function removeGenerationStoreFiles(databasePath: string): void {
  validateText(databasePath, "databasePath");
  const directory = dirname(databasePath);
  const file = basename(databasePath);
  let entries: string[] = [];
  try { entries = readdirSync(directory); } catch { return; }
  const targets = entries.filter((entry) => entry === file || entry === `${file}-wal` ||
    entry === `${file}-shm` || entry === `${file}-journal` ||
    entry.startsWith(`${file}.`) &&
      (entry.endsWith(".tmp") || entry.endsWith(".bak") || entry.endsWith(".crash")));
  if (targets.length > 4_096) {
    throw new EncryptedGenerationStoreError("bound_exceeded", "Too many cache residuals");
  }
  // Sidecars go first and the main database last. An interrupted rebuild therefore leaves either
  // a recognizable old database for the next attempt or no SQLite authority cache at all.
  targets.sort((left, right) => Number(left === file) - Number(right === file));
  for (const entry of targets) rmSync(join(directory, entry), { force: true });
}

export function createEncryptedAuthorityGenerationStore(
  options: EncryptedGenerationStoreOptions,
): EncryptedAuthorityGenerationStore {
  validateText(options.databasePath, "databasePath");
  validateText(options.accountId, "accountId");
  const tenantId = options.tenantId ?? "dao-local-tenant";
  validateText(tenantId, "tenantId");
  const limits = validateLimits(options.limits);
  try {
    if (!options.encryption.isEncryptionAvailable()) {
      throw new EncryptedGenerationStoreError(
        "encryption_unavailable",
        "Secure safeStorage is unavailable",
      );
    }
  } catch (cause: unknown) {
    if (cause instanceof EncryptedGenerationStoreError) throw cause;
    throw new EncryptedGenerationStoreError("encryption_unavailable", "Secure safeStorage is unavailable");
  }

  mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(options.databasePath), 0o700);
  let openedDatabase: DatabaseSync | undefined;
  try {
    openedDatabase = new DatabaseSync(options.databasePath);
    openedDatabase.exec(SCHEMA);
  } catch (cause: unknown) {
    try { openedDatabase?.close(); } catch { /* preserve the open/schema failure */ }
    throw new EncryptedGenerationStoreError(
      "invalid_store",
      cause instanceof Error ? cause.message : "Generation store could not be opened",
    );
  }
  const database = openedDatabase;

  let dataKey: Buffer;
  try {
    const wrappedRow = database.prepare(
      "SELECT metadata_value FROM cache_metadata WHERE metadata_key = 'wrapped_data_key'",
    ).get() as { metadata_value?: unknown } | undefined;
    if (wrappedRow === undefined) {
      dataKey = randomBytes(DATA_KEY_BYTES);
      const wrapped = wrapKey(options.encryption, dataKey);
      transaction(database, () => {
        database.prepare("INSERT INTO cache_metadata(metadata_key, metadata_value) VALUES (?, ?)")
          .run("schema_version", Buffer.from(SCHEMA_VERSION, "utf8"));
        database.prepare("INSERT INTO cache_metadata(metadata_key, metadata_value) VALUES (?, ?)")
          .run("wrapped_data_key", wrapped);
        database.prepare("INSERT INTO cache_metadata(metadata_key, metadata_value) VALUES (?, ?)")
          .run("account_hash", Buffer.from(identifierHash(dataKey, "account", options.accountId), "utf8"));
        database.prepare("INSERT INTO cache_metadata(metadata_key, metadata_value) VALUES (?, ?)")
          .run("tenant_hash", Buffer.from(identifierHash(dataKey, "tenant", tenantId), "utf8"));
      });
    } else {
      dataKey = unwrapKey(options.encryption, blob(wrappedRow.metadata_value));
      const schemaRow = database.prepare(
        "SELECT metadata_value FROM cache_metadata WHERE metadata_key = 'schema_version'",
      ).get() as { metadata_value?: unknown } | undefined;
      const accountRow = database.prepare(
        "SELECT metadata_value FROM cache_metadata WHERE metadata_key = 'account_hash'",
      ).get() as { metadata_value?: unknown } | undefined;
      const tenantRow = database.prepare(
        "SELECT metadata_value FROM cache_metadata WHERE metadata_key = 'tenant_hash'",
      ).get() as { metadata_value?: unknown } | undefined;
      if (schemaRow === undefined || blob(schemaRow.metadata_value).toString("utf8") !== SCHEMA_VERSION ||
          accountRow === undefined || blob(accountRow.metadata_value).toString("utf8") !==
            identifierHash(dataKey, "account", options.accountId) || tenantRow === undefined ||
          blob(tenantRow.metadata_value).toString("utf8") !== identifierHash(dataKey, "tenant", tenantId)) {
        dataKey.fill(0);
        throw new EncryptedGenerationStoreError("integrity_failed", "Cache binding is invalid");
      }
    }
    if (process.platform !== "win32") chmodSync(options.databasePath, 0o600);
  } catch (cause: unknown) {
    database.close();
    if (cause instanceof EncryptedGenerationStoreError) throw cause;
    throw new EncryptedGenerationStoreError("invalid_store", "Generation metadata is invalid");
  }

  const accountHash = identifierHash(dataKey, "account", options.accountId);
  const tenantHash = identifierHash(dataKey, "tenant", tenantId);
  let closed = false;
  const requireOpen = (): void => {
    if (closed) throw new EncryptedGenerationStoreError("closed", "Generation store is closed");
  };
  const roomHash = (roomId: string): string => {
    validateText(roomId, "roomId");
    return identifierHash(dataKey, "room", roomId);
  };
  const snapshotHash = (snapshotId: string): string => {
    validateText(snapshotId, "snapshotId");
    return identifierHash(dataKey, "snapshot", snapshotId);
  };
  const identityHash = (identity: string): string => {
    validateText(identity, "identity");
    return identifierHash(dataKey, "record", identity);
  };
  const eventHash = (eventId: string): string => {
    validateText(eventId, "eventId");
    return identifierHash(dataKey, "event", eventId);
  };

  const generation = (roomId: string, snapshotId: string, state?: "staging" | "active") => {
    const row = database.prepare(`
      SELECT generation_id, watermark, cursor, expected_count, checksum, generation_state
      FROM cache_generations
      WHERE room_hash = ? AND snapshot_hash = ?${state === undefined ? "" : " AND generation_state = ?"}
    `).get(...(state === undefined
      ? [roomHash(roomId), snapshotHash(snapshotId)]
      : [roomHash(roomId), snapshotHash(snapshotId), state])) as Record<string, unknown> | undefined;
    return row;
  };

  const active = (roomId: string) => database.prepare(`
    SELECT g.generation_id, g.watermark, g.cursor, g.expected_count, g.checksum,
      g.lifecycle_generation, g.access_revision, g.lease_generation
    FROM cache_room_heads h
    JOIN cache_generations g ON g.generation_id = h.active_generation_id
    WHERE h.room_hash = ? AND g.generation_state = 'active'
  `).get(roomHash(roomId)) as Record<string, unknown> | undefined;

  const readGenerationRecords = (
    room: string,
    generationId: string,
  ): readonly EncryptedGenerationRecord[] => {
    const rows = database.prepare(`
      SELECT identity_hash, sealed_record FROM cache_records
      WHERE generation_id = ? ORDER BY ordinal ASC
    `).all(generationId) as Record<string, unknown>[];
    const identities = new Set<string>();
    return rows.map((row) => {
      if (typeof row.identity_hash !== "string") {
        throw new EncryptedGenerationStoreError("integrity_failed", "Record identity is invalid");
      }
      const result = openRecord(dataKey,
        recordAad(tenantHash, accountHash, room, generationId, row.identity_hash),
        blob(row.sealed_record), limits.maxRecordBytes);
      if (identityHash(result.identity) !== row.identity_hash || identities.has(result.identity)) {
        throw new EncryptedGenerationStoreError("integrity_failed", "Record identity binding failed");
      }
      identities.add(result.identity);
      return result;
    });
  };

  const sealRoomId = (roomId: string, room: string): Buffer => {
    const identity = identifierHash(dataKey, "record", "room-catalog-binding");
    return sealRecord(dataKey, recordAad(tenantHash, accountHash, room, "room-catalog", identity), {
      identity: "room-catalog-binding",
      value: roomId,
    }, limits.maxRecordBytes);
  };

  const openRoomId = (room: string, sealed: unknown): string => {
    const identity = identifierHash(dataKey, "record", "room-catalog-binding");
    const record = openRecord(dataKey,
      recordAad(tenantHash, accountHash, room, "room-catalog", identity), blob(sealed), limits.maxRecordBytes);
    if (record.identity !== "room-catalog-binding" || typeof record.value !== "string" ||
        roomHash(record.value) !== room) {
      throw new EncryptedGenerationStoreError("integrity_failed", "Room catalog binding failed");
    }
    return record.value;
  };

  const api: EncryptedAuthorityGenerationStore = {
    beginRoomGeneration(input) {
      requireOpen();
      validateText(input.checksum, "checksum");
      const expectedCount = input.expectedCount ?? 0;
      if (!nonnegativeSafeInteger(input.watermark) || !nonnegativeSafeInteger(expectedCount) ||
          expectedCount > limits.maxRecordsPerRoom) {
        throw new EncryptedGenerationStoreError("bound_exceeded", "Generation metadata exceeded bounds");
      }
      const room = roomHash(input.roomId);
      const snapshot = snapshotHash(input.snapshotId);
      transaction(database, () => {
        database.prepare("DELETE FROM cache_generations WHERE room_hash = ? AND generation_state = 'staging'")
          .run(room);
        database.prepare(`
          INSERT INTO cache_generations(
            generation_id, room_hash, snapshot_hash, generation_state,
            watermark, cursor, expected_count, checksum
          ) VALUES (?, ?, ?, 'staging', ?, ?, ?, ?)
        `).run(randomUUID(), room, snapshot, input.watermark, input.watermark,
          expectedCount, input.checksum);
      });
    },
    stageRoomRecords(roomId, snapshotId, records) {
      requireOpen();
      if (records.length > limits.maxRecordsPerRoom) {
        throw new EncryptedGenerationStoreError("bound_exceeded", "Record page exceeded bounds");
      }
      const stage = generation(roomId, snapshotId, "staging");
      if (stage === undefined || typeof stage.generation_id !== "string") {
        throw new EncryptedGenerationStoreError("invalid_generation", "Staging generation is absent");
      }
      const total = database.prepare("SELECT COUNT(*) AS total FROM cache_records WHERE generation_id = ?")
        .get(stage.generation_id) as { total?: unknown };
      if (count(total.total) + records.length > limits.maxRecordsPerRoom) {
        throw new EncryptedGenerationStoreError("bound_exceeded", "Room record bound was exceeded");
      }
      const room = roomHash(roomId);
      const existingCount = count(total.total);
      transaction(database, () => {
        records.forEach((record, index) => {
          const hashedIdentity = identityHash(record.identity);
          const sealed = sealRecord(dataKey,
            recordAad(tenantHash, accountHash, room, stage.generation_id as string, hashedIdentity),
            record, limits.maxRecordBytes);
          database.prepare(`
            INSERT INTO cache_records(generation_id, identity_hash, ordinal, sealed_record)
            VALUES (?, ?, ?, ?)
          `).run(stage.generation_id as string, hashedIdentity, existingCount + index, sealed);
        });
      });
    },
    commitRoomGeneration(input) {
      requireOpen();
      const room = roomHash(input.roomId);
      transaction(database, () => {
        const stage = generation(input.roomId, input.snapshotId, "staging");
        if (stage === undefined || typeof stage.generation_id !== "string" ||
            stage.watermark !== input.watermark ||
            (stage.expected_count !== 0 && stage.expected_count !== input.expectedCount) ||
            stage.checksum !== input.checksum) {
          throw new EncryptedGenerationStoreError(
            "invalid_generation",
            "Generation completion did not match",
          );
        }
        const records = readGenerationRecords(room, stage.generation_id);
        if (records.length !== input.expectedCount ||
            authorityGenerationChecksum("room", records.map((record) => record.value)) !== input.checksum) {
          throw new EncryptedGenerationStoreError(
            "integrity_failed",
            "Staged generation failed canonical disk verification",
          );
        }
        const oldHead = active(input.roomId);
        options.fault?.("before-active-flip");
        database.prepare(
          `UPDATE cache_generations
           SET generation_state = 'active', expected_count = ? WHERE generation_id = ?`,
        ).run(input.expectedCount, stage.generation_id as string);
        database.prepare(`
          INSERT INTO cache_room_heads(room_hash, active_generation_id) VALUES (?, ?)
          ON CONFLICT(room_hash) DO UPDATE SET active_generation_id = excluded.active_generation_id
        `).run(room, stage.generation_id as string);
        database.prepare(`
          INSERT INTO cache_room_catalog(room_hash, sealed_room_id) VALUES (?, ?)
          ON CONFLICT(room_hash) DO UPDATE SET sealed_room_id = excluded.sealed_room_id
        `).run(room, sealRoomId(input.roomId, room));
        options.fault?.("after-active-flip");
        if (oldHead !== undefined && typeof oldHead.generation_id === "string" &&
            oldHead.generation_id !== stage.generation_id) {
          database.prepare("DELETE FROM cache_generations WHERE generation_id = ?")
            .run(oldHead.generation_id);
        }
      });
    },
    discardRoomGeneration(roomId, snapshotId) {
      requireOpen();
      database.prepare(`
        DELETE FROM cache_generations
        WHERE room_hash = ? AND snapshot_hash = ? AND generation_state = 'staging'
      `).run(roomHash(roomId), snapshotHash(snapshotId));
    },
    readActiveRoom(roomId) {
      requireOpen();
      const head = active(roomId);
      if (head === undefined || typeof head.generation_id !== "string") return undefined;
      const room = roomHash(roomId);
      const records = readGenerationRecords(room, head.generation_id);
      if (records.length !== count(head.expected_count)) {
        throw new EncryptedGenerationStoreError("integrity_failed", "Active generation count is invalid");
      }
      const checksum = authorityGenerationChecksum("room", records.map((record) => record.value));
      if (typeof head.checksum !== "string" || checksum !== head.checksum) {
        throw new EncryptedGenerationStoreError("integrity_failed", "Active generation checksum is invalid");
      }
      return Object.freeze({
        generationId: head.generation_id,
        records: Object.freeze(records),
        cursor: Object.freeze({ version: 1 as const, roomId, afterSeq: count(head.cursor) }),
        checksum,
      });
    },
    listActiveRoomIds() {
      requireOpen();
      const rows = database.prepare(`
        SELECT catalog.room_hash, catalog.sealed_room_id
        FROM cache_room_catalog AS catalog
        JOIN cache_room_heads AS head ON head.room_hash = catalog.room_hash
        ORDER BY catalog.room_hash ASC
      `).all() as Record<string, unknown>[];
      return Object.freeze(rows.map((row) => {
        if (typeof row.room_hash !== "string") {
          throw new EncryptedGenerationStoreError("integrity_failed", "Room catalog hash is invalid");
        }
        return openRoomId(row.room_hash, row.sealed_room_id);
      }));
    },
    applyRoomEventBatch(input) {
      requireOpen();
      if (!nonnegativeSafeInteger(input.nextCursor) || input.events.length > limits.maxBatchEvents ||
          input.upserts.length > limits.maxRecordsPerRoom || input.deletes.length > limits.maxRecordsPerRoom) {
        throw new EncryptedGenerationStoreError("bound_exceeded", "Event batch exceeded bounds");
      }
      const head = active(input.roomId);
      if (head === undefined || typeof head.generation_id !== "string") {
        throw new EncryptedGenerationStoreError("invalid_generation", "Active generation is absent");
      }
      const current = count(head.cursor);
      const watermark = count(head.watermark);
      if (input.nextCursor < current) {
        throw new EncryptedGenerationStoreError("repair_required", "Room cursor moved backwards");
      }
      const room = roomHash(input.roomId);
      const applied: string[] = [];
      const replayed: string[] = [];
      const fresh: { event: EncryptedGenerationEvent; hash: string }[] = [];
      const batchEvents = new Map<string, number>();
      const batchSequences = new Map<number, string>();
      for (const event of input.events) {
        validateText(event.eventId, "eventId");
        if (!positiveSafeInteger(event.streamSeq)) {
          throw new EncryptedGenerationStoreError("repair_required", "Event sequence is invalid");
        }
        const hashedEvent = eventHash(event.eventId);
        const duplicateSequence = batchEvents.get(hashedEvent);
        const duplicateEvent = batchSequences.get(event.streamSeq);
        if (duplicateSequence !== undefined && duplicateSequence !== event.streamSeq ||
            duplicateEvent !== undefined && duplicateEvent !== hashedEvent) {
          throw new EncryptedGenerationStoreError("repair_required", "Event ledger conflict in batch");
        }
        batchEvents.set(hashedEvent, event.streamSeq);
        batchSequences.set(event.streamSeq, hashedEvent);
        const byEvent = database.prepare(`
          SELECT stream_seq FROM cache_event_ledger WHERE room_hash = ? AND event_hash = ?
        `).get(room, hashedEvent) as { stream_seq?: unknown } | undefined;
        const bySequence = database.prepare(`
          SELECT event_hash FROM cache_event_ledger WHERE room_hash = ? AND stream_seq = ?
        `).get(room, event.streamSeq) as { event_hash?: unknown } | undefined;
        if (byEvent !== undefined && byEvent.stream_seq !== event.streamSeq ||
            bySequence !== undefined && bySequence.event_hash !== hashedEvent) {
          throw new EncryptedGenerationStoreError("repair_required", "Durable event ledger conflict");
        }
        if (byEvent !== undefined) replayed.push(event.eventId);
        else if (event.streamSeq <= watermark) replayed.push(event.eventId);
        else fresh.push({ event, hash: hashedEvent });
      }
      let expected = current + 1;
      for (const item of fresh) {
        if (item.event.streamSeq !== expected) {
          throw new EncryptedGenerationStoreError("repair_required", "Room event stream has a gap");
        }
        expected += 1;
      }
      const expectedCursor = fresh.length === 0 ? current : expected - 1;
      if (input.nextCursor !== expectedCursor) {
        throw new EncryptedGenerationStoreError("repair_required", "Cursor did not match event batch");
      }

      transaction(database, () => {
        for (const item of fresh) {
          database.prepare(`
            INSERT INTO cache_event_ledger(generation_id, room_hash, event_hash, stream_seq)
            VALUES (?, ?, ?, ?)
          `).run(head.generation_id as string, room, item.hash, item.event.streamSeq);
          applied.push(item.event.eventId);
        }
        if (fresh.length > 0) {
          for (const identity of input.deletes) {
            database.prepare("DELETE FROM cache_records WHERE generation_id = ? AND identity_hash = ?")
              .run(head.generation_id as string, identityHash(identity));
          }
          for (const record of input.upserts) {
            const hashedIdentity = identityHash(record.identity);
            const existing = database.prepare(`
              SELECT ordinal FROM cache_records WHERE generation_id = ? AND identity_hash = ?
            `).get(head.generation_id as string, hashedIdentity) as { ordinal?: unknown } | undefined;
            const ordinal = existing === undefined
              ? count((database.prepare(`
                  SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
                  FROM cache_records WHERE generation_id = ?
                `).get(head.generation_id as string) as { ordinal?: unknown }).ordinal)
              : count(existing.ordinal);
            const sealed = sealRecord(dataKey,
              recordAad(tenantHash, accountHash, room, head.generation_id as string, hashedIdentity),
              record, limits.maxRecordBytes);
            database.prepare(`
              INSERT INTO cache_records(generation_id, identity_hash, ordinal, sealed_record)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(generation_id, identity_hash) DO UPDATE SET sealed_record = excluded.sealed_record
            `).run(head.generation_id as string, hashedIdentity, ordinal, sealed);
          }
          const total = database.prepare("SELECT COUNT(*) AS total FROM cache_records WHERE generation_id = ?")
            .get(head.generation_id as string) as { total?: unknown };
          if (count(total.total) > limits.maxRecordsPerRoom) {
            throw new EncryptedGenerationStoreError("bound_exceeded", "Room record bound was exceeded");
          }
          const records = readGenerationRecords(room, head.generation_id as string);
          database.prepare(`
            UPDATE cache_generations
            SET cursor = ?, expected_count = ?, checksum = ?
            WHERE generation_id = ?
          `).run(input.nextCursor, records.length,
            authorityGenerationChecksum("room", records.map((record) => record.value)),
            head.generation_id as string);
        }
        if (input.invalidateActiveBinding === true) {
          database.prepare("DELETE FROM cache_offline_leases WHERE room_hash = ?").run(room);
          database.prepare(`
            UPDATE cache_generations
            SET lifecycle_generation = NULL, access_revision = NULL, lease_generation = NULL
            WHERE generation_id = ?
          `).run(head.generation_id as string);
        }
      });
      return Object.freeze({
        appliedEventIds: Object.freeze(applied),
        replayedEventIds: Object.freeze(replayed),
      });
    },
    classifyRoomEvent(roomId, eventId, streamSeq) {
      requireOpen();
      if (!positiveSafeInteger(streamSeq)) return "conflict";
      const room = roomHash(roomId);
      const event = eventHash(eventId);
      const byEvent = database.prepare(`
        SELECT stream_seq FROM cache_event_ledger WHERE room_hash = ? AND event_hash = ?
      `).get(room, event) as { stream_seq?: unknown } | undefined;
      const bySequence = database.prepare(`
        SELECT event_hash FROM cache_event_ledger WHERE room_hash = ? AND stream_seq = ?
      `).get(room, streamSeq) as { event_hash?: unknown } | undefined;
      if (byEvent === undefined && bySequence === undefined) return "unseen";
      return byEvent?.stream_seq === streamSeq && bySequence?.event_hash === event
        ? "exact"
        : "conflict";
    },
    writeOfflineLease(roomId, lease) {
      requireOpen();
      const room = roomHash(roomId);
      const activeGeneration = active(roomId);
      if (activeGeneration === undefined || typeof activeGeneration.generation_id !== "string") {
        throw new EncryptedGenerationStoreError(
          "invalid_generation",
          "Offline lease requires an active Room generation",
        );
      }
      const identity = identifierHash(dataKey, "record", "offline-read-lease");
      const sealed = sealRecord(
        dataKey,
        recordAad(tenantHash, accountHash, room, "offline-read-lease", identity),
        { identity: "offline-read-lease", value: lease },
        limits.maxRecordBytes,
      );
      database.prepare(`
        INSERT INTO cache_offline_leases(room_hash, generation_id, sealed_lease) VALUES (?, ?, ?)
        ON CONFLICT(room_hash) DO UPDATE SET
          generation_id = excluded.generation_id,
          sealed_lease = excluded.sealed_lease
      `).run(room, activeGeneration.generation_id, sealed);
    },
    readOfflineLease(roomId) {
      requireOpen();
      const room = roomHash(roomId);
      const row = database.prepare(`
        SELECT lease.sealed_lease
        FROM cache_offline_leases AS lease
        JOIN cache_room_heads AS room_head
          ON room_head.room_hash = lease.room_hash
         AND room_head.active_generation_id = lease.generation_id
        WHERE lease.room_hash = ?
      `).get(room) as { sealed_lease?: unknown } | undefined;
      if (row === undefined) return undefined;
      const identity = identifierHash(dataKey, "record", "offline-read-lease");
      return openRecord(
        dataKey,
        recordAad(tenantHash, accountHash, room, "offline-read-lease", identity),
        blob(row.sealed_lease),
        limits.maxRecordBytes,
      ).value;
    },
    clearOfflineLease(roomId) {
      requireOpen();
      database.prepare("DELETE FROM cache_offline_leases WHERE room_hash = ?")
        .run(roomHash(roomId));
    },
    bindActiveGeneration(roomId, binding) {
      requireOpen();
      if (!nonnegativeSafeInteger(binding.lifecycleGeneration) ||
          !nonnegativeSafeInteger(binding.accessRevision) ||
          !nonnegativeSafeInteger(binding.leaseGeneration)) {
        throw new EncryptedGenerationStoreError("invalid_generation", "Generation binding is invalid");
      }
      const head = active(roomId);
      if (head === undefined || typeof head.generation_id !== "string") {
        throw new EncryptedGenerationStoreError(
          "invalid_generation",
          "Generation binding requires an active Room generation",
        );
      }
      database.prepare(`
        UPDATE cache_generations
        SET lifecycle_generation = ?, access_revision = ?, lease_generation = ?
        WHERE generation_id = ? AND generation_state = 'active'
      `).run(binding.lifecycleGeneration, binding.accessRevision, binding.leaseGeneration,
        head.generation_id);
    },
    readActiveGenerationBinding(roomId) {
      requireOpen();
      const head = active(roomId);
      if (head === undefined) return undefined;
      const values = [head.lifecycle_generation, head.access_revision, head.lease_generation];
      if (values.every((value) => value === null)) return undefined;
      if (!values.every((value) => typeof value === "number" && nonnegativeSafeInteger(value))) {
        throw new EncryptedGenerationStoreError("integrity_failed", "Generation binding is incomplete");
      }
      return Object.freeze({
        roomId,
        complete: true as const,
        lifecycleGeneration: head.lifecycle_generation as number,
        accessRevision: head.access_revision as number,
        leaseGeneration: head.lease_generation as number,
      });
    },
    clearActiveGenerationBinding(roomId) {
      requireOpen();
      const head = active(roomId);
      if (head === undefined || typeof head.generation_id !== "string") return;
      database.prepare(`
        UPDATE cache_generations
        SET lifecycle_generation = NULL, access_revision = NULL, lease_generation = NULL
        WHERE generation_id = ?
      `).run(head.generation_id);
    },
    clearRoom(roomId) {
      requireOpen();
      transaction(database, () => {
        database.prepare("DELETE FROM cache_offline_leases WHERE room_hash = ?").run(roomHash(roomId));
        database.prepare("DELETE FROM cache_room_heads WHERE room_hash = ?").run(roomHash(roomId));
        database.prepare("DELETE FROM cache_generations WHERE room_hash = ?").run(roomHash(roomId));
      });
    },
    clearAccount() {
      requireOpen();
      transaction(database, () => {
        database.exec(`
          DELETE FROM cache_room_heads;
          DELETE FROM cache_room_catalog;
          DELETE FROM cache_offline_leases;
          DELETE FROM cache_event_ledger;
          DELETE FROM cache_records;
          DELETE FROM cache_generations;
          DELETE FROM cache_metadata;
        `);
      });
      dataKey.fill(0);
      closed = true;
      database.close();
      api.destroy();
    },
    close() {
      if (closed) return;
      closed = true;
      try { database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally {
        database.close();
        dataKey.fill(0);
      }
    },
    destroy() {
      if (!closed) api.close();
      removeGenerationStoreFiles(options.databasePath);
    },
  };
  return Object.freeze(api);
}

/**
 * The authority generation database is a derived, encrypted cache rather than a source of truth.
 * Production may discard an unsupported or corrupt cache only after the failed handle is closed;
 * the next online repair then reconstructs it from Authority. Direct callers retain fail-closed
 * inspection semantics through createEncryptedAuthorityGenerationStore.
 */
export function createRecoverableEncryptedAuthorityGenerationStore(
  options: EncryptedGenerationStoreOptions,
): EncryptedAuthorityGenerationStore {
  try {
    return createEncryptedAuthorityGenerationStore(options);
  } catch (cause: unknown) {
    if (!(cause instanceof EncryptedGenerationStoreError) ||
        !["integrity_failed", "key_unwrap_failed", "invalid_store"].includes(cause.code)) {
      throw cause;
    }
    removeGenerationStoreFiles(options.databasePath);
    return createEncryptedAuthorityGenerationStore(options);
  }
}
