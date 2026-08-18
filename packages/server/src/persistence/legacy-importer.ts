import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Actor, Message } from "@native-im/core";
import {
  deriveLegacyPublicSessionId,
  isSessionState,
  type SessionState,
} from "../auth.js";
import {
  isRoomLifecycleState,
  type RoomAuditRecord,
  type RoomLifecycleState,
} from "../room-lifecycle.js";
import { createJsonlMessageStore } from "../store.js";
import {
  AUTHORITY_SCHEMA_VERSION,
  migrateAuthorityDatabase,
  readSchemaVersion,
} from "./schema.js";
import { MAX_ACTIVE_SESSION_FAMILIES } from "./contracts.js";

const IMPORT_MARKER_SCOPE = "__authority_legacy_import__";
const IMPORT_MARKER_KEY = "t0039-v1";
const MESSAGE_FIELDS = new Set([
  "id",
  "roomId",
  "authorId",
  "authorKind",
  "body",
  "sentAt",
]);

export interface LegacyImportPaths {
  readonly sessionFilePath: string;
  readonly roomFilePath: string;
  readonly messageFilePath: string;
}

export interface LegacyImportResult {
  readonly imported: boolean;
  readonly actors: number;
  readonly rooms: number;
  readonly messages: number;
}

export interface LegacyImportInspection {
  readonly markerVersion: 1;
  readonly actors: number;
  readonly rooms: number;
  readonly messages: number;
  readonly roomHeadSeq: number;
  readonly identityHeadSeq: number;
}

interface LegacyImportInput extends LegacyImportPaths {
  readonly databasePath: string;
}

interface LegacyImportTestFault {
  beforeActivate?(): void;
  afterManifestDurable?(): void;
  afterActivateLink?(): void;
  afterStagingUnlink?(): void;
}

export type LegacyImportRecoveryState = "pre-link" | "linked" | "post-unlink";

export interface LegacyImportRecovery {
  readonly stagingFilePath: string;
  readonly recoveryFilePath: string;
  readonly nonce: string;
  readonly state: LegacyImportRecoveryState;
}

interface LegacyImportMarker {
  readonly markerVersion: 1;
  readonly actors: number;
  readonly rooms: number;
  readonly messages: number;
  readonly activationNonce: string;
}

interface ValidatedLegacyState {
  readonly sessions: SessionState;
  readonly lifecycle: RoomLifecycleState;
  readonly messages: readonly Message[];
  readonly sourceHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.size &&
    keys.every((key) => typeof key === "string" && fields.has(key))
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isStrictMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    hasExactFields(value, MESSAGE_FIELDS) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.roomId === "string" &&
    value.roomId.trim().length > 0 &&
    typeof value.authorId === "string" &&
    value.authorId.trim().length > 0 &&
    (value.authorKind === "human" || value.authorKind === "agent") &&
    typeof value.body === "string" &&
    isIsoTimestamp(value.sentAt)
  );
}

function parseJson(content: string): unknown {
  return JSON.parse(content) as unknown;
}

function parseStrictMessages(content: string): readonly Message[] {
  const lines = content.split("\n");
  const messages: Message[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length === 0 && index === lines.length - 1) {
      continue;
    }
    const value = parseJson(line);
    if (!isStrictMessage(value)) {
      throw new Error("Invalid legacy message record");
    }
    messages.push(value);
  }
  return messages;
}

function registerId(ids: Set<string>, id: string): void {
  if (ids.has(id)) {
    throw new Error("Duplicate legacy entity identifier");
  }
  ids.add(id);
}

function validateCrossFileReferences(
  sessions: SessionState,
  lifecycle: RoomLifecycleState,
  messages: readonly Message[],
): void {
  const actorsById = new Map(lifecycle.actors.map((actor) => [actor.id, actor]));
  const roomIds = new Set(lifecycle.rooms.map((room) => room.id));
  const globalIds = new Set<string>();

  for (const actor of lifecycle.actors) {
    registerId(globalIds, actor.id);
  }
  for (const room of lifecycle.rooms) {
    registerId(globalIds, room.id);
  }
  for (const invitation of lifecycle.invitations) {
    registerId(globalIds, invitation.id);
  }
  for (const audit of lifecycle.audit) {
    registerId(globalIds, audit.id);
  }

  for (const session of sessions.sessions) {
    if (actorsById.get(session.actorId)?.kind !== "human") {
      throw new Error("Legacy session reference is invalid");
    }
  }
  for (const message of messages) {
    registerId(globalIds, message.id);
    if (
      !roomIds.has(message.roomId) ||
      actorsById.get(message.authorId)?.kind !== message.authorKind
    ) {
      throw new Error("Legacy message reference is invalid");
    }
  }
}

function validateLegacySessionCapacity(sessions: SessionState, now: number): void {
  const families = new Map<string, {
    readonly accountId: string;
    readonly actorId: string;
    active: boolean;
    refreshExpiresAt: number;
  }>();
  for (const session of sessions.sessions) {
    const family = families.get(session.familyId);
    families.set(session.familyId, {
      accountId: family?.accountId ?? session.accountId,
      actorId: family?.actorId ?? session.actorId,
      active: (family?.active ?? false) || session.revokedAt === undefined,
      refreshExpiresAt: Math.max(
        family?.refreshExpiresAt ?? -1,
        session.refreshExpiresAt,
      ),
    });
  }
  const capacityByPrincipal = new Map<string, number>();
  for (const family of families.values()) {
    if (!family.active || family.refreshExpiresAt <= now) continue;
    const principal = JSON.stringify([family.accountId, family.actorId]);
    const capacity = (capacityByPrincipal.get(principal) ?? 0) + 1;
    if (capacity > MAX_ACTIVE_SESSION_FAMILIES) {
      throw new Error(
        `Legacy active session family capacity exceeds ${MAX_ACTIVE_SESSION_FAMILIES}`,
      );
    }
    capacityByPrincipal.set(principal, capacity);
  }
}

async function readValidatedLegacyState(
  paths: LegacyImportPaths,
): Promise<ValidatedLegacyState> {
  const [sessionBytes, roomBytes, messageBytes] = await Promise.all([
    Promise.resolve(readFileSync(paths.sessionFilePath)),
    Promise.resolve(readFileSync(paths.roomFilePath)),
    Promise.resolve(readFileSync(paths.messageFilePath)),
  ]);

  const sessionValue = parseJson(sessionBytes.toString("utf8"));
  const roomValue = parseJson(roomBytes.toString("utf8"));
  if (!isSessionState(sessionValue) || !isRoomLifecycleState(roomValue)) {
    throw new Error("Invalid legacy authority state");
  }

  // Exercise T-0039's existing reader so its JSONL corruption and duplicate-ID
  // behavior remains the source contract, then enforce the importer's closed row shape.
  await createJsonlMessageStore(paths.messageFilePath).list("");
  const messages = parseStrictMessages(messageBytes.toString("utf8"));
  validateCrossFileReferences(sessionValue, roomValue, messages);
  validateLegacySessionCapacity(sessionValue, Date.now());

  const sourceHash = createHash("sha256")
    .update(sessionBytes)
    .update(roomBytes)
    .update(messageBytes)
    .digest("hex");
  return {
    sessions: sessionValue,
    lifecycle: roomValue,
    messages,
    sourceHash,
  };
}

function auditDetails(record: RoomAuditRecord): string {
  const details: Record<string, unknown> = {};
  if ("targetActorId" in record) details.targetActorId = record.targetActorId;
  if ("invitationId" in record) details.invitationId = record.invitationId;
  if ("inviterActorId" in record) details.inviterActorId = record.inviterActorId;
  if ("role" in record) details.role = record.role;
  if ("participation" in record) details.participation = record.participation;
  if ("toolPermissions" in record) details.toolPermissions = record.toolPermissions;
  return JSON.stringify(details);
}

function insertActor(database: DatabaseSync, actor: Actor): void {
  database
    .prepare(
      `INSERT INTO actors (
         id, kind, display_name, reachability, readiness, tool_permissions_json,
         catalog_revision
       ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      actor.id,
      actor.kind,
      actor.displayName,
      actor.kind === "human" ? actor.reachability : null,
      actor.kind === "agent" ? actor.readiness : null,
      JSON.stringify(actor.kind === "agent" ? actor.toolPermissions : []),
    );
}

function importRows(
  database: DatabaseSync,
  state: ValidatedLegacyState,
  activationNonce: string,
): void {
  database.exec("BEGIN IMMEDIATE");
  let transactionOpen = true;
  try {
    for (const actor of state.lifecycle.actors) {
      insertActor(database, actor);
    }
    const families = new Map<string, typeof state.sessions.sessions>();
    for (const session of state.sessions.sessions) {
      families.set(session.familyId, [
        ...(families.get(session.familyId) ?? []),
        session,
      ]);
    }
    const insertFamily = database.prepare(
      `INSERT INTO session_families (
         family_id, public_id, account_id, actor_id, device_id, device_label,
         platform, created_at, refresh_expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [familyId, generations] of families) {
      const canonical = generations[0];
      if (canonical === undefined) {
        throw new Error("Legacy session family is empty");
      }
      const revoked = generations.every((generation) => generation.revokedAt !== undefined);
      insertFamily.run(
        familyId,
        canonical.publicSessionId ?? deriveLegacyPublicSessionId(familyId),
        canonical.accountId,
        canonical.actorId,
        canonical.deviceId ?? "legacy",
        canonical.deviceLabel ?? "Legacy device",
        canonical.platform ?? "unknown",
        canonical.createdAt ?? null,
        Math.max(...generations.map((generation) => generation.refreshExpiresAt)),
        revoked
          ? Math.max(...generations.map((generation) => generation.revokedAt ?? 0))
          : null,
      );
    }
    const insertSession = database.prepare(
      `INSERT INTO sessions (
         family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
         access_expires_at, refresh_expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const session of state.sessions.sessions) {
      insertSession.run(
        session.familyId,
        session.accountId,
        session.actorId,
        session.accessTokenHash,
        session.refreshTokenHash,
        session.accessExpiresAt,
        session.refreshExpiresAt,
        session.revokedAt ?? null,
      );
    }
    const insertRoom = database.prepare(
      "INSERT INTO rooms (id, name, status, created_at) VALUES (?, ?, ?, ?)",
    );
    const insertMembership = database.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    for (const room of state.lifecycle.rooms) {
      insertRoom.run(room.id, room.name, room.status, room.createdAt);
      for (const membership of room.members) {
        insertMembership.run(
          room.id,
          membership.actorId,
          membership.kind,
          membership.kind === "human" ? membership.role : null,
          membership.kind === "agent" ? membership.participation : null,
          JSON.stringify(
            membership.kind === "agent" ? membership.toolPermissions : [],
          ),
          membership.kind === "human" ? membership.joinedAt : null,
          membership.kind === "agent" ? membership.configuredAt : null,
        );
      }
    }
    const insertInvitation = database.prepare(
      `INSERT INTO room_invitations (
         id, room_id, inviter_actor_id, invitee_actor_id, token_hash, status,
         created_at, decision_actor_id, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const invitation of state.lifecycle.invitations) {
      insertInvitation.run(
        invitation.id,
        invitation.roomId,
        invitation.inviterActorId,
        invitation.inviteeActorId,
        invitation.tokenHash,
        invitation.status,
        invitation.createdAt,
        invitation.decisionActorId ?? null,
        invitation.decidedAt ?? null,
      );
    }
    const insertAudit = database.prepare(
      `INSERT INTO room_audit (
         id, type, room_id, actor_id, result, timestamp, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const audit of state.lifecycle.audit) {
      insertAudit.run(
        audit.id,
        audit.type,
        audit.roomId,
        audit.actorId,
        audit.result,
        audit.timestamp,
        auditDetails(audit),
      );
    }
    const insertMessage = database.prepare(
      `INSERT INTO messages (
         id, room_id, author_id, author_kind, body, sent_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const message of state.messages) {
      insertMessage.run(
        message.id,
        message.roomId,
        message.authorId,
        message.authorKind,
        message.body,
        message.sentAt,
      );
    }
    const insertStream = database.prepare(
      `INSERT INTO streams (
         stream_kind, stream_id, head_seq, retained_from_seq
       ) VALUES (?, ?, 0, 1)`,
    );
    for (const room of state.lifecycle.rooms) {
      insertStream.run("room", room.id);
    }
    for (const actor of state.lifecycle.actors) {
      insertStream.run("identity", actor.id);
    }

    const marker = {
      markerVersion: 1 as const,
      actors: state.lifecycle.actors.length,
      rooms: state.lifecycle.rooms.length,
      messages: state.messages.length,
      activationNonce,
    };
    database
      .prepare(
        `INSERT INTO idempotency_records (
           scope, key, request_hash, response_json, status_code, created_at,
           expires_at
         ) VALUES (?, ?, ?, ?, 200, ?, ?)`,
      )
      .run(
        IMPORT_MARKER_SCOPE,
        IMPORT_MARKER_KEY,
        state.sourceHash,
        JSON.stringify(marker),
        "1970-01-01T00:00:00.000Z",
        "9999-12-31T23:59:59.999Z",
      );

    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error: unknown) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The staging database is discarded, so preserve the original failure.
      }
    }
    throw error;
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupStaging(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    rmSync(candidate, { force: true });
  }
}

function recoveryManifest(
  databasePath: string,
  stagingPath: string,
  nonce: string,
): string {
  return JSON.stringify({
    version: 1,
    databaseFileName: basename(databasePath),
    stagingFileName: basename(stagingPath),
    nonce,
  });
}

function recoveryBaseName(databasePath: string, nonce: string): string {
  return `.${basename(databasePath)}.${nonce}.legacy-import`;
}

async function runImport(
  input: LegacyImportInput,
  fault: LegacyImportTestFault | undefined,
): Promise<LegacyImportResult> {
  if (existsSync(input.databasePath)) {
    throw new Error("Authority database already exists");
  }

  const state = await readValidatedLegacyState(input);
  if (existsSync(input.databasePath)) {
    throw new Error("Authority database appeared during legacy validation");
  }

  const activationNonce = randomUUID();
  const recoveryBase = recoveryBaseName(input.databasePath, activationNonce);
  const stagingPath = join(dirname(input.databasePath), `${recoveryBase}.sqlite`);
  const recoveryFilePath = join(
    dirname(input.databasePath),
    `${recoveryBase}.recovery.json`,
  );
  let stagingDatabase: DatabaseSync | undefined;
  let activated = false;
  let simulatedCrash = false;
  try {
    stagingDatabase = new DatabaseSync(stagingPath);
    migrateAuthorityDatabase(stagingDatabase);
    importRows(stagingDatabase, state, activationNonce);
    migrateAuthorityDatabase(stagingDatabase);
    stagingDatabase.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    syncFile(stagingPath);
    stagingDatabase.close();
    stagingDatabase = undefined;

    writeFileSync(
      recoveryFilePath,
      recoveryManifest(input.databasePath, stagingPath, activationNonce),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    syncFile(recoveryFilePath);
    syncFile(dirname(input.databasePath));

    try {
      fault?.afterManifestDurable?.();
    } catch (error: unknown) {
      simulatedCrash = true;
      throw error;
    }
    fault?.beforeActivate?.();
    linkSync(stagingPath, input.databasePath);
    activated = true;
    syncFile(dirname(input.databasePath));
    try {
      fault?.afterActivateLink?.();
    } catch (error: unknown) {
      simulatedCrash = true;
      throw error;
    }
    rmSync(stagingPath);
    syncFile(dirname(input.databasePath));
    try {
      fault?.afterStagingUnlink?.();
    } catch (error: unknown) {
      simulatedCrash = true;
      throw error;
    }
    rmSync(recoveryFilePath);
    syncFile(dirname(input.databasePath));
    return {
      imported: true,
      actors: state.lifecycle.actors.length,
      rooms: state.lifecycle.rooms.length,
      messages: state.messages.length,
    };
  } catch (error: unknown) {
    if (activated && !simulatedCrash) {
      try {
        rmSync(input.databasePath, { force: true });
        syncFile(dirname(input.databasePath));
      } catch {
        // Preserve the activation failure; startup will refuse any invalid remainder.
      }
    }
    throw error;
  } finally {
    if (stagingDatabase !== undefined) {
      try {
        stagingDatabase.close();
      } catch {
        // Staging cleanup below is authoritative after any import failure.
      }
    }
    if (!simulatedCrash) {
      cleanupStaging(stagingPath);
      rmSync(recoveryFilePath, { force: true });
    }
  }
}

export function importLegacyState(
  input: LegacyImportInput,
): Promise<LegacyImportResult> {
  return runImport(input, undefined);
}

// Module-local test seam. It is intentionally absent from worker messages and root exports.
export function importLegacyStateForTest(
  input: LegacyImportInput,
  fault: LegacyImportTestFault,
): Promise<LegacyImportResult> {
  return runImport(input, fault);
}

function readCount(database: DatabaseSync, table: string): number {
  const value = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid legacy import count");
  }
  return value;
}

function readHead(
  database: DatabaseSync,
  kind: "room" | "identity",
  expectedCount: number,
): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(MAX(head_seq), 0) AS head,
              COALESCE(MIN(head_seq), 0) AS minimum,
              COALESCE(MIN(retained_from_seq), 1) AS retained,
              COALESCE(MAX(retained_from_seq), 1) AS maximum_retained
       FROM streams WHERE stream_kind = ?`,
    )
    .get(kind);
  if (
    row?.count !== expectedCount ||
    typeof row?.head !== "number" ||
    row.head !== row.minimum ||
    row.retained !== 1 ||
    row.maximum_retained !== 1
  ) {
    throw new Error("Invalid legacy stream marker state");
  }
  return row.head;
}

function readLegacyImportMarker(database: DatabaseSync): LegacyImportMarker {
  const row = database
    .prepare(
      `SELECT request_hash, response_json, status_code, created_at, expires_at
       FROM idempotency_records
       WHERE scope = ? AND key = ?`,
    )
    .get(IMPORT_MARKER_SCOPE, IMPORT_MARKER_KEY);
  if (
    typeof row?.response_json !== "string" ||
    typeof row.request_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.request_hash) ||
    row.status_code !== 200 ||
    row.created_at !== "1970-01-01T00:00:00.000Z" ||
    row.expires_at !== "9999-12-31T23:59:59.999Z"
  ) {
    throw new Error("Legacy import marker is absent");
  }
  const marker = parseJson(row.response_json);
  if (
    !isRecord(marker) ||
    !hasExactFields(
      marker,
      new Set([
        "markerVersion",
        "actors",
        "rooms",
        "messages",
        "activationNonce",
      ]),
    ) ||
    marker.markerVersion !== 1 ||
    !isUuid(marker.activationNonce) ||
    ![marker.actors, marker.rooms, marker.messages].every(
      (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    throw new Error("Legacy import marker is invalid");
  }
  return marker as unknown as LegacyImportMarker;
}

export function replayLegacyImport(database: DatabaseSync): LegacyImportResult {
  if (readSchemaVersion(database) !== AUTHORITY_SCHEMA_VERSION) {
    throw new Error("Legacy import marker schema is unavailable");
  }
  const marker = readLegacyImportMarker(database);
  return {
    imported: false,
    actors: marker.actors,
    rooms: marker.rooms,
    messages: marker.messages,
  };
}

export function inspectLegacyImport(database: DatabaseSync): LegacyImportInspection {
  const marker = readLegacyImportMarker(database);

  const actors = readCount(database, "actors");
  const rooms = readCount(database, "rooms");
  const messages = readCount(database, "messages");
  if (
    marker.actors !== actors ||
    marker.rooms !== rooms ||
    marker.messages !== messages ||
    readCount(database, "events") !== 0
  ) {
    throw new Error("Legacy import marker does not match authority state");
  }
  return {
    markerVersion: 1,
    actors,
    rooms,
    messages,
    roomHeadSeq: readHead(database, "room", rooms),
    identityHeadSeq: readHead(database, "identity", actors),
  };
}

function validateRecoveryFiles(
  databasePath: string,
  recovery: LegacyImportRecovery,
): string {
  const recoveryBase = recoveryBaseName(databasePath, recovery.nonce);
  const expectedStaging = join(dirname(databasePath), `${recoveryBase}.sqlite`);
  const expectedRecovery = join(
    dirname(databasePath),
    `${recoveryBase}.recovery.json`,
  );
  if (
    !isUuid(recovery.nonce) ||
    recovery.stagingFilePath !== expectedStaging ||
    recovery.recoveryFilePath !== expectedRecovery ||
    !(["pre-link", "linked", "post-unlink"] as const).includes(recovery.state)
  ) {
    throw new Error("Legacy import recovery paths are invalid");
  }

  const finalMetadata = lstatIfPresent(databasePath);
  const stagingMetadata = lstatIfPresent(recovery.stagingFilePath);
  const manifestMetadata = lstatSync(recovery.recoveryFilePath, { bigint: true });
  let authorityMetadata: BigIntStats;
  let authorityPath: string;
  if (recovery.state === "pre-link") {
    if (
      finalMetadata !== undefined ||
      stagingMetadata === undefined ||
      !stagingMetadata.isFile() ||
      stagingMetadata.nlink !== 1n
    ) {
      throw new Error("Legacy import pre-link recovery state is invalid");
    }
    authorityMetadata = stagingMetadata;
    authorityPath = recovery.stagingFilePath;
  } else if (recovery.state === "linked") {
    if (
      finalMetadata === undefined ||
      stagingMetadata === undefined ||
      !finalMetadata.isFile() ||
      !stagingMetadata.isFile() ||
      finalMetadata.nlink !== 2n ||
      stagingMetadata.nlink !== 2n ||
      finalMetadata.dev !== stagingMetadata.dev ||
      finalMetadata.ino !== stagingMetadata.ino ||
      finalMetadata.uid !== stagingMetadata.uid
    ) {
      throw new Error("Legacy import linked recovery state is invalid");
    }
    authorityMetadata = finalMetadata;
    authorityPath = databasePath;
  } else {
    if (
      finalMetadata === undefined ||
      !finalMetadata.isFile() ||
      finalMetadata.nlink !== 1n ||
      stagingMetadata !== undefined
    ) {
      throw new Error("Legacy import post-unlink recovery state is invalid");
    }
    authorityMetadata = finalMetadata;
    authorityPath = databasePath;
  }

  if (
    !manifestMetadata.isFile() ||
    manifestMetadata.nlink !== 1n ||
    manifestMetadata.size <= 0n ||
    manifestMetadata.size > 1_024n ||
    authorityMetadata.dev !== manifestMetadata.dev ||
    authorityMetadata.uid !== manifestMetadata.uid ||
    (manifestMetadata.mode & 0o7777n) !== 0o600n
  ) {
    throw new Error("Legacy import recovery files are not controlled");
  }
  const manifest = parseJson(readFileSync(recovery.recoveryFilePath, "utf8"));
  if (
    !isRecord(manifest) ||
    !hasExactFields(
      manifest,
      new Set(["version", "databaseFileName", "stagingFileName", "nonce"]),
    ) ||
    manifest.version !== 1 ||
    manifest.databaseFileName !== basename(databasePath) ||
    manifest.stagingFileName !== basename(recovery.stagingFilePath) ||
    manifest.nonce !== recovery.nonce
  ) {
    throw new Error("Legacy import recovery manifest is invalid");
  }
  return authorityPath;
}

function lstatIfPresent(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

export function recoverLegacyImportRemainder(
  databasePath: string,
  recovery: LegacyImportRecovery,
): void {
  const authorityPath = validateRecoveryFiles(databasePath, recovery);

  const database = new DatabaseSync(authorityPath, { readOnly: true });
  try {
    if (readSchemaVersion(database) !== AUTHORITY_SCHEMA_VERSION) {
      throw new Error("Legacy import recovery database has the wrong schema");
    }
    const marker = readLegacyImportMarker(database);
    inspectLegacyImport(database);
    if (marker.activationNonce !== recovery.nonce) {
      throw new Error("Legacy import recovery nonce does not match its marker");
    }
  } finally {
    database.close();
  }

  validateRecoveryFiles(databasePath, recovery);
  if (recovery.state !== "post-unlink") {
    rmSync(recovery.stagingFilePath);
    syncFile(dirname(databasePath));
  }
  if (recovery.state === "pre-link") {
    if (existsSync(databasePath)) {
      throw new Error("Authority database appeared during pre-link recovery");
    }
  } else {
    const finalMetadata = lstatSync(databasePath, { bigint: true });
    if (!finalMetadata.isFile() || finalMetadata.nlink !== 1n) {
      throw new Error("Authority database still has unowned hardlinks");
    }
  }
  rmSync(recovery.recoveryFilePath);
  syncFile(dirname(databasePath));
}
