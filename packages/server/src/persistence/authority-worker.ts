import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
  AUTHORITY_SCHEMA_VERSION,
  migrateAuthorityDatabase,
  readSchemaVersion,
} from "./schema.js";
import {
  importLegacyState,
  inspectLegacyImport,
  recoverLegacyImportRemainder,
  replayLegacyImport,
  type LegacyImportRecovery,
} from "./legacy-importer.js";
import {
  isAuthorityWorkerRequest,
  type AuthorityWorkerRequest,
  type AuthorityWorkerResponse,
} from "./worker-protocol.js";

interface AuthorityWorkerData {
  readonly databasePath: string;
  readonly recovery?: LegacyImportRecovery;
}

function isAuthorityWorkerData(value: unknown): value is AuthorityWorkerData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    (keys.length !== 1 && keys.length !== 2) ||
    keys[0] !== "databasePath" ||
    (keys.length === 2 && keys[1] !== "recovery") ||
    typeof record.databasePath !== "string" ||
    record.databasePath.length === 0
  ) {
    return false;
  }
  if (record.recovery === undefined) {
    return keys.length === 1;
  }
  if (
    typeof record.recovery !== "object" ||
    record.recovery === null ||
    Array.isArray(record.recovery)
  ) {
    return false;
  }
  const recovery = record.recovery as Record<string, unknown>;
  return (
    Object.keys(recovery).sort().join("\u0000") ===
      ["nonce", "recoveryFilePath", "stagingFilePath", "state"]
        .sort()
        .join("\u0000") &&
    typeof recovery.nonce === "string" &&
    recovery.nonce.length > 0 &&
    typeof recovery.recoveryFilePath === "string" &&
    recovery.recoveryFilePath.length > 0 &&
    typeof recovery.stagingFilePath === "string" &&
    recovery.stagingFilePath.length > 0 &&
    (recovery.state === "pre-link" ||
      recovery.state === "linked" ||
      recovery.state === "post-unlink")
  );
}

function requestIdFromMalformedRequest(value: unknown): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const requestId = (value as Record<string, unknown>).requestId;
    if (typeof requestId === "string" && requestId.length > 0) {
      return requestId;
    }
  }
  return "invalid";
}

if (parentPort === null) {
  throw new Error("AuthorityWorker must run inside a worker thread");
}

const authorityPort = parentPort;
const requests: unknown[] = [];
let processing = false;
let database: DatabaseSync | undefined;
let workerInitialized = false;
let workerClosed = false;

function respond(response: AuthorityWorkerResponse): void {
  authorityPort.postMessage(response);
}

function respondWithError(requestId: string, code: string, message: string): void {
  respond({
    type: "authority.error",
    requestId,
    code,
    message,
  });
}

function openAuthorityDatabase(): DatabaseSync {
  if (!isAuthorityWorkerData(workerData)) {
    throw new Error("Invalid authority worker data");
  }
  const openedDatabase = new DatabaseSync(workerData.databasePath);
  try {
    migrateAuthorityDatabase(openedDatabase);
    return openedDatabase;
  } catch (error: unknown) {
    try {
      openedDatabase.close();
    } catch {
      // Preserve the original open or migration failure.
    }
    throw error;
  }
}

function initialize(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.initialize") {
    throw new TypeError("initialize received the wrong request type");
  }
  if (workerClosed) {
    respondWithError(
      request.requestId,
      "authority_worker_closed",
      "Authority worker is closed",
    );
    return;
  }
  if (workerInitialized) {
    respondWithError(
      request.requestId,
      "authority_already_initialized",
      "Authority worker is already initialized",
    );
    return;
  }
  if (!isAuthorityWorkerData(workerData)) {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority database initialization failed",
    );
    return;
  }

  try {
    if (workerData.recovery !== undefined) {
      recoverLegacyImportRemainder(workerData.databasePath, workerData.recovery);
    }
    if (existsSync(workerData.databasePath)) {
      database = openAuthorityDatabase();
    }
    workerInitialized = true;
    respond({
      type: "authority.ready",
      requestId: request.requestId,
      schemaVersion: AUTHORITY_SCHEMA_VERSION,
    });
  } catch {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority database initialization failed",
    );
  }
}

function inspectSchema(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.inspect-schema") {
    throw new TypeError("inspectSchema received the wrong request type");
  }
  if (!workerInitialized || workerClosed) {
    respondWithError(
      request.requestId,
      workerClosed ? "authority_worker_closed" : "authority_not_initialized",
      workerClosed ? "Authority worker is closed" : "Authority worker is not initialized",
    );
    return;
  }

  try {
    database ??= openAuthorityDatabase();
    const schemaVersion = readSchemaVersion(database);
    if (schemaVersion !== AUTHORITY_SCHEMA_VERSION) {
      throw new Error("Authority schema version changed after initialization");
    }
    respond({
      type: "authority.schema",
      requestId: request.requestId,
      schemaVersion: AUTHORITY_SCHEMA_VERSION,
    });
  } catch {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority database inspection failed",
    );
  }
}

async function importLegacy(request: AuthorityWorkerRequest): Promise<void> {
  if (request.type !== "authority.import-legacy") {
    throw new TypeError("importLegacy received the wrong request type");
  }
  if (!workerInitialized || workerClosed) {
    respondWithError(
      request.requestId,
      workerClosed ? "authority_worker_closed" : "authority_not_initialized",
      workerClosed ? "Authority worker is closed" : "Authority worker is not initialized",
    );
    return;
  }
  if (!isAuthorityWorkerData(workerData)) {
    respondWithError(
      request.requestId,
      "legacy_import_failed",
      "Legacy authority import failed",
    );
    return;
  }

  try {
    if (database !== undefined || existsSync(workerData.databasePath)) {
      database ??= openAuthorityDatabase();
      const existing = replayLegacyImport(database);
      respond({
        type: "authority.legacy-imported",
        requestId: request.requestId,
        ...existing,
      });
      return;
    }

    const result = await importLegacyState({
      databasePath: workerData.databasePath,
      sessionFilePath: request.sessionFilePath,
      roomFilePath: request.roomFilePath,
      messageFilePath: request.messageFilePath,
    });
    database = openAuthorityDatabase();
    respond({
      type: "authority.legacy-imported",
      requestId: request.requestId,
      ...result,
    });
  } catch {
    respondWithError(
      request.requestId,
      "legacy_import_failed",
      "Legacy authority import failed",
    );
  }
}

function inspectImport(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.inspect-legacy-import") {
    throw new TypeError("inspectImport received the wrong request type");
  }
  if (!workerInitialized || workerClosed) {
    respondWithError(
      request.requestId,
      workerClosed ? "authority_worker_closed" : "authority_not_initialized",
      workerClosed ? "Authority worker is closed" : "Authority worker is not initialized",
    );
    return;
  }
  try {
    database ??= openAuthorityDatabase();
    respond({
      type: "authority.legacy-import",
      requestId: request.requestId,
      ...inspectLegacyImport(database),
    });
  } catch {
    respondWithError(
      request.requestId,
      "legacy_import_unavailable",
      "Legacy authority import inspection failed",
    );
  }
}

function requireAuthorityDatabase(): DatabaseSync {
  if (!workerInitialized || workerClosed) {
    throw new Error(
      workerClosed ? "authority_worker_closed" : "authority_not_initialized",
    );
  }
  database ??= openAuthorityDatabase();
  return database;
}

function runImmediate<Result>(
  openedDatabase: DatabaseSync,
  operation: () => Result,
): Result {
  openedDatabase.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    openedDatabase.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      openedDatabase.exec("ROLLBACK");
    } catch {
      // Preserve the operation failure.
    }
    throw error;
  }
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("base64url");
}

function appendIdentityEvent(
  openedDatabase: DatabaseSync,
  input: {
    readonly actorId: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly occurredAt: string;
    readonly payload: unknown;
  },
): number {
  const stream = openedDatabase
    .prepare(
      `SELECT head_seq AS headSeq
       FROM streams
       WHERE stream_kind = 'identity' AND stream_id = ?`,
    )
    .get(input.actorId);
  if (typeof stream?.headSeq !== "number") {
    throw new Error("identity_stream_missing");
  }
  const streamSeq = stream.headSeq + 1;
  openedDatabase
    .prepare(
      `UPDATE streams
       SET head_seq = ?
       WHERE stream_kind = 'identity' AND stream_id = ?`,
    )
    .run(streamSeq, input.actorId);
  openedDatabase
    .prepare(
      `INSERT INTO events (
         event_id, stream_kind, stream_id, stream_seq, room_id,
         actor_id, event_type, occurred_at, payload_json
       ) VALUES (?, 'identity', ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      input.eventId,
      input.actorId,
      streamSeq,
      input.actorId,
      input.eventType,
      input.occurredAt,
      JSON.stringify(input.payload),
    );
  return streamSeq;
}

function registerActors(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.register-actors") {
    throw new TypeError("registerActors received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityDatabase();
    runImmediate(openedDatabase, () => {
      const selectActor = openedDatabase.prepare(
        `SELECT
           kind,
           display_name AS displayName,
           reachability,
           readiness,
           tool_permissions_json AS toolPermissionsJson
         FROM actors WHERE id = ?`,
      );
      const insertActor = openedDatabase.prepare(
        `INSERT INTO actors (
           id, kind, display_name, reachability, readiness,
           tool_permissions_json, catalog_revision
         ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      );
      const insertStream = openedDatabase.prepare(
        `INSERT INTO streams (
           stream_kind, stream_id, head_seq, retained_from_seq
         ) VALUES ('identity', ?, 0, 1)`,
      );

      for (const actor of request.actors) {
        const reachability = actor.kind === "human" ? actor.reachability : null;
        const readiness = actor.kind === "agent" ? actor.readiness : null;
        const toolPermissionsJson = JSON.stringify(
          actor.kind === "agent" ? actor.toolPermissions : [],
        );
        const existing = selectActor.get(actor.id);
        if (existing !== undefined) {
          if (
            existing.kind !== actor.kind ||
            existing.displayName !== actor.displayName ||
            existing.reachability !== reachability ||
            existing.readiness !== readiness ||
            existing.toolPermissionsJson !== toolPermissionsJson
          ) {
            throw new Error("actor_conflict");
          }
          continue;
        }

        insertActor.run(
          actor.id,
          actor.kind,
          actor.displayName,
          reachability,
          readiness,
          toolPermissionsJson,
        );
        insertStream.run(actor.id);
        const payload = { actor };
        appendIdentityEvent(openedDatabase, {
          actorId: actor.id,
          eventId: stableId(
            "identity.actor.registered",
            actor.id,
            JSON.stringify(payload),
          ),
          eventType: "identity.actor.registered",
          occurredAt: new Date().toISOString(),
          payload,
        });
      }
    });
    respond({
      type: "authority.actors-registered",
      requestId: request.requestId,
      actorCount: request.actors.length,
    });
  } catch (error: unknown) {
    const code = error instanceof Error && error.message === "actor_conflict"
      ? "actor_conflict"
      : "storage_unavailable";
    respondWithError(
      request.requestId,
      code,
      code === "actor_conflict"
        ? "Authority actor registration conflicts with existing state"
        : "Authority actor registration failed",
    );
  }
}

function issueSession(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.session-issue") {
    throw new TypeError("issueSession received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityDatabase();
    const session = runImmediate(openedDatabase, () => {
      const actor = openedDatabase
        .prepare("SELECT kind FROM actors WHERE id = ?")
        .get(request.input.actorId);
      if (actor?.kind !== "human") {
        throw new Error("identity_forbidden");
      }
      const familyId = request.input.accessTokenHash;
      const sessionId = request.input.accessTokenHash;
      openedDatabase
        .prepare(
          `INSERT INTO sessions (
             family_id, account_id, actor_id, access_token_hash,
             refresh_token_hash, access_expires_at, refresh_expires_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          familyId,
          request.input.accountId,
          request.input.actorId,
          request.input.accessTokenHash,
          request.input.refreshTokenHash,
          request.input.accessExpiresAt,
          request.input.refreshExpiresAt,
        );
      appendIdentityEvent(openedDatabase, {
        actorId: request.input.actorId,
        eventId: stableId("identity.session.issued", sessionId),
        eventType: "identity.session.issued",
        occurredAt: new Date().toISOString(),
        payload: {
          sessionId,
          familyId,
          accountId: request.input.accountId,
        },
      });
      return {
        sessionId,
        familyId,
        accountId: request.input.accountId,
        actorId: request.input.actorId,
        accessExpiresAt: request.input.accessExpiresAt,
        refreshExpiresAt: request.input.refreshExpiresAt,
      };
    });
    respond({
      type: "authority.session-issued",
      requestId: request.requestId,
      session,
    });
  } catch (error: unknown) {
    const code = error instanceof Error && error.message === "identity_forbidden"
      ? "identity_forbidden"
      : "storage_unavailable";
    respondWithError(
      request.requestId,
      code,
      code === "identity_forbidden"
        ? "Session actor is forbidden"
        : "Authority session issuance failed",
    );
  }
}

function authenticateSession(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.session-authenticate") {
    throw new TypeError("authenticateSession received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityDatabase();
    const session = openedDatabase
      .prepare(
        `SELECT
           session.access_token_hash AS sessionId,
           session.family_id AS familyId,
           session.account_id AS accountId,
           session.actor_id AS actorId,
           session.access_expires_at AS accessExpiresAt,
           session.revoked_at AS revokedAt,
           actor.kind AS actorKind
         FROM sessions AS session
         JOIN actors AS actor ON actor.id = session.actor_id
         WHERE session.access_token_hash = ?`,
      )
      .get(request.accessTokenHash);
    if (session === undefined) {
      respondWithError(request.requestId, "invalid_token", "Session token is invalid");
      return;
    }
    if (session.actorKind !== "human") {
      respondWithError(
        request.requestId,
        "identity_forbidden",
        "Session actor is forbidden",
      );
      return;
    }
    if (typeof session.revokedAt === "number") {
      respondWithError(
        request.requestId,
        "session_revoked",
        "Session family is revoked",
      );
      return;
    }
    if (
      typeof session.accessExpiresAt !== "number" ||
      request.now >= session.accessExpiresAt
    ) {
      respondWithError(request.requestId, "token_expired", "Session token is expired");
      return;
    }
    if (
      typeof session.sessionId !== "string" ||
      typeof session.familyId !== "string" ||
      typeof session.accountId !== "string" ||
      typeof session.actorId !== "string"
    ) {
      throw new Error("session_corrupt");
    }
    respond({
      type: "authority.session-authenticated",
      requestId: request.requestId,
      context: {
        sessionId: session.sessionId,
        sessionFamilyId: session.familyId,
        principal: {
          accountId: session.accountId,
          actorId: session.actorId,
        },
      },
    });
  } catch {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority session authentication failed",
    );
  }
}

interface SessionAuthorityRow {
  readonly sessionId: string;
  readonly familyId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly revokedAt: number | null;
}

function readSessionByRefreshHash(
  openedDatabase: DatabaseSync,
  refreshTokenHash: string,
): SessionAuthorityRow | undefined {
  const row = openedDatabase
    .prepare(
      `SELECT
         access_token_hash AS sessionId,
         family_id AS familyId,
         account_id AS accountId,
         actor_id AS actorId,
         access_expires_at AS accessExpiresAt,
         refresh_expires_at AS refreshExpiresAt,
         revoked_at AS revokedAt
       FROM sessions
       WHERE refresh_token_hash = ?`,
    )
    .get(refreshTokenHash);
  if (row === undefined) {
    return undefined;
  }
  if (
    typeof row.sessionId !== "string" ||
    typeof row.familyId !== "string" ||
    typeof row.accountId !== "string" ||
    typeof row.actorId !== "string" ||
    typeof row.accessExpiresAt !== "number" ||
    typeof row.refreshExpiresAt !== "number" ||
    (row.revokedAt !== null && typeof row.revokedAt !== "number")
  ) {
    throw new Error("session_corrupt");
  }
  return row as unknown as SessionAuthorityRow;
}

function revokeSessionFamily(
  openedDatabase: DatabaseSync,
  session: SessionAuthorityRow,
  now: number,
): void {
  openedDatabase
    .prepare(
      `UPDATE sessions
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE family_id = ?`,
    )
    .run(now, session.familyId);

  const eventId = stableId("identity.session.revoked", session.familyId);
  const existingEvent = openedDatabase
    .prepare("SELECT event_id FROM events WHERE event_id = ?")
    .get(eventId);
  if (existingEvent === undefined) {
    const canonicalSession = openedDatabase
      .prepare(
        `SELECT access_token_hash AS sessionId
         FROM sessions
         WHERE family_id = ?
         ORDER BY rowid
         LIMIT 1`,
      )
      .get(session.familyId);
    if (typeof canonicalSession?.sessionId !== "string") {
      throw new Error("session_family_corrupt");
    }
    const streamSeq = appendIdentityEvent(openedDatabase, {
      actorId: session.actorId,
      eventId,
      eventType: "identity.session.revoked",
      occurredAt: new Date(now).toISOString(),
      payload: {
        sessionId: canonicalSession.sessionId,
        familyId: session.familyId,
        accountId: session.accountId,
      },
    });
    openedDatabase
      .prepare(
        `INSERT INTO outbox_deliveries (
           id, event_id, target_kind, target_id, stream_seq, status, attempts,
           available_at, delivered_at, last_error
         ) VALUES (?, ?, 'session-family', ?, ?, 'pending', 0, ?, NULL, NULL)
         ON CONFLICT(event_id, target_kind, target_id) DO NOTHING`,
      )
      .run(
        stableId(
          "outbox",
          eventId,
          "session-family",
          session.familyId,
          String(streamSeq),
        ),
        eventId,
        session.familyId,
        streamSeq,
        new Date(now).toISOString(),
      );
  }
}

function validateSessionRefresh(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.session-validate-refresh") {
    throw new TypeError("validateSessionRefresh received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityDatabase();
    const result = runImmediate(openedDatabase, () => {
      const current = readSessionByRefreshHash(
        openedDatabase,
        request.currentRefreshTokenHash,
      );
      if (current === undefined) {
        return { ok: false as const, code: "invalid_token" };
      }
      if (
        request.expectedPrincipal !== undefined &&
        (current.accountId !== request.expectedPrincipal.accountId ||
          current.actorId !== request.expectedPrincipal.actorId)
      ) {
        return { ok: false as const, code: "identity_forbidden" };
      }
      if (current.revokedAt !== null) {
        revokeSessionFamily(openedDatabase, current, request.now);
        return { ok: false as const, code: "session_revoked" };
      }
      if (request.now >= current.refreshExpiresAt) {
        return { ok: false as const, code: "token_expired" };
      }
      return { ok: true as const };
    });
    if (!result.ok) {
      respondWithError(
        request.requestId,
        result.code,
        "Authority refresh validation was rejected",
      );
      return;
    }
    respond({
      type: "authority.session-refresh-valid",
      requestId: request.requestId,
    });
  } catch {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority refresh validation failed",
    );
  }
}

function rotateSession(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.session-rotate") {
    throw new TypeError("rotateSession received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityDatabase();
    const result = runImmediate(openedDatabase, () => {
      const current = readSessionByRefreshHash(
        openedDatabase,
        request.input.currentRefreshTokenHash,
      );
      if (current === undefined) {
        return { kind: "error" as const, code: "invalid_token" };
      }
      if (
        request.input.expectedPrincipal !== undefined &&
        (current.accountId !== request.input.expectedPrincipal.accountId ||
          current.actorId !== request.input.expectedPrincipal.actorId)
      ) {
        return { kind: "error" as const, code: "identity_forbidden" };
      }
      if (current.revokedAt !== null) {
        revokeSessionFamily(openedDatabase, current, request.input.now);
        return { kind: "error" as const, code: "session_revoked" };
      }
      if (request.input.now >= current.refreshExpiresAt) {
        return { kind: "error" as const, code: "token_expired" };
      }

      openedDatabase
        .prepare(
          `UPDATE sessions SET revoked_at = ?
           WHERE access_token_hash = ? AND revoked_at IS NULL`,
        )
        .run(request.input.now, current.sessionId);
      openedDatabase
        .prepare(
          `INSERT INTO sessions (
             family_id, account_id, actor_id, access_token_hash,
             refresh_token_hash, access_expires_at, refresh_expires_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          current.familyId,
          current.accountId,
          current.actorId,
          request.input.accessTokenHash,
          request.input.refreshTokenHash,
          request.input.accessExpiresAt,
          request.input.refreshExpiresAt,
        );
      appendIdentityEvent(openedDatabase, {
        actorId: current.actorId,
        eventId: stableId("identity.session.rotated", request.input.accessTokenHash),
        eventType: "identity.session.rotated",
        occurredAt: new Date(request.input.now).toISOString(),
        payload: {
          sessionId: request.input.accessTokenHash,
          familyId: current.familyId,
          accountId: current.accountId,
        },
      });
      return {
        kind: "rotated" as const,
        session: {
          sessionId: request.input.accessTokenHash,
          familyId: current.familyId,
          accountId: current.accountId,
          actorId: current.actorId,
          accessExpiresAt: request.input.accessExpiresAt,
          refreshExpiresAt: request.input.refreshExpiresAt,
        },
      };
    });
    if (result.kind === "error") {
      respondWithError(
        request.requestId,
        result.code,
        "Authority session rotation was rejected",
      );
      return;
    }
    respond({
      type: "authority.session-rotated",
      requestId: request.requestId,
      session: result.session,
    });
  } catch {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority session rotation failed",
    );
  }
}

function revokeSession(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.session-revoke") {
    throw new TypeError("revokeSession received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityDatabase();
    const result = runImmediate(openedDatabase, () => {
      const row = openedDatabase
        .prepare(
          `SELECT
             access_token_hash AS sessionId,
             family_id AS familyId,
             account_id AS accountId,
             actor_id AS actorId,
             access_expires_at AS accessExpiresAt,
             refresh_expires_at AS refreshExpiresAt,
             revoked_at AS revokedAt
           FROM sessions
           WHERE access_token_hash = ?`,
        )
        .get(request.accessTokenHash);
      if (row === undefined) {
        return { kind: "error" as const, code: "invalid_token" };
      }
      const session = row as unknown as SessionAuthorityRow;
      if (
        typeof session.sessionId !== "string" ||
        typeof session.familyId !== "string" ||
        typeof session.accountId !== "string" ||
        typeof session.actorId !== "string"
      ) {
        throw new Error("session_corrupt");
      }
      revokeSessionFamily(openedDatabase, session, request.now);
      return { kind: "revoked" as const };
    });
    if (result.kind === "error") {
      respondWithError(
        request.requestId,
        result.code,
        "Authority session revoke was rejected",
      );
      return;
    }
    respond({ type: "authority.session-revoked", requestId: request.requestId });
  } catch {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority session revoke failed",
    );
  }
}

function executeHuman(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.execute-human") {
    throw new TypeError("executeHuman received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityDatabase();
    const code = runImmediate(openedDatabase, () => {
      const session = openedDatabase
        .prepare(
          `SELECT
             session.family_id AS familyId,
             session.account_id AS accountId,
             session.actor_id AS actorId,
             session.access_expires_at AS accessExpiresAt,
             session.revoked_at AS revokedAt,
             actor.kind AS actorKind
           FROM sessions AS session
           JOIN actors AS actor ON actor.id = session.actor_id
           WHERE session.access_token_hash = ?`,
        )
        .get(request.context.sessionId);
      if (session === undefined) {
        return "invalid_token";
      }
      if (session.actorKind !== "human") {
        return "identity_forbidden";
      }
      if (
        session.familyId !== request.context.sessionFamilyId ||
        session.accountId !== request.context.principal.accountId ||
        session.actorId !== request.context.principal.actorId
      ) {
        return "identity_forbidden";
      }
      if (typeof session.revokedAt === "number") {
        return "session_revoked";
      }
      if (
        typeof session.accessExpiresAt !== "number" ||
        request.now >= session.accessExpiresAt
      ) {
        return "token_expired";
      }
      return "command_not_implemented";
    });
    respondWithError(
      request.requestId,
      code,
      code === "command_not_implemented"
        ? "Authority command is not implemented"
        : "Authority command session was rejected",
    );
  } catch {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority command validation failed",
    );
  }
}

function closeAuthority(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.close") {
    throw new TypeError("closeAuthority received the wrong request type");
  }
  if (workerClosed) {
    respondWithError(
      request.requestId,
      "authority_worker_closed",
      "Authority worker is closed",
    );
    return;
  }
  if (!workerInitialized) {
    respondWithError(
      request.requestId,
      "authority_not_initialized",
      "Authority worker is not initialized",
    );
    return;
  }

  try {
    if (database !== undefined) {
      database.close();
      database = undefined;
    }
    workerClosed = true;
    respond({ type: "authority.closed", requestId: request.requestId });
    authorityPort.close();
  } catch {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority database close failed",
    );
  }
}

async function dispatch(value: unknown): Promise<void> {
  if (!isAuthorityWorkerRequest(value)) {
    respondWithError(
      requestIdFromMalformedRequest(value),
      "invalid_request",
      "Invalid authority worker request",
    );
    return;
  }

  switch (value.type) {
    case "authority.initialize":
      initialize(value);
      return;
    case "authority.inspect-schema":
      inspectSchema(value);
      return;
    case "authority.import-legacy":
      await importLegacy(value);
      return;
    case "authority.inspect-legacy-import":
      inspectImport(value);
      return;
    case "authority.register-actors":
      registerActors(value);
      return;
    case "authority.session-issue":
      issueSession(value);
      return;
    case "authority.session-authenticate":
      authenticateSession(value);
      return;
    case "authority.session-rotate":
      rotateSession(value);
      return;
    case "authority.session-validate-refresh":
      validateSessionRefresh(value);
      return;
    case "authority.session-revoke":
      revokeSession(value);
      return;
    case "authority.execute-human":
      executeHuman(value);
      return;
    case "authority.close":
      closeAuthority(value);
  }
}

async function drainRequests(): Promise<void> {
  if (processing) {
    return;
  }
  processing = true;
  try {
    while (requests.length > 0) {
      const request = requests.shift();
      await dispatch(request);
    }
  } finally {
    processing = false;
  }
}

authorityPort.on("message", (request: unknown) => {
  requests.push(request);
  void drainRequests();
});

authorityPort.on("messageerror", () => {
  throw new Error("Authority worker could not deserialize a request");
});
