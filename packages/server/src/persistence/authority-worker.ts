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
  type AuthorityWorkerErrorCode,
} from "./worker-protocol.js";
import {
  AuthorityDatabaseError,
  AuthorityRollbackFatalError,
  appendCanonicalIdentityEvent,
  executeAgentDatabaseCommand,
  executeHumanDatabaseCommand,
  authorizeOutboxCandidateDatabaseQuery,
  canAccessRoomDatabaseQuery,
  compactRoomStreamDatabaseCommand,
  listPendingOutboxDatabaseQuery,
  markOutboxDispatchedDatabaseCommand,
  markOutboxFailedDatabaseCommand,
  readActorDatabaseQuery,
  readHistoryDatabaseQuery,
  readRoomAuditDatabaseQuery,
  readRoomDatabaseQuery,
  repairMutationImpactDatabaseQuery,
  revalidateSnapshotDatabaseQuery,
  runAuthorityImmediateTransaction,
  syncRoomDatabaseQuery,
  inspectStreamingRepairScopeDatabaseQuery,
} from "./authority-database-handler.js";
import {
  FallbackRepairCoordinator,
  FallbackRepairError,
  type RepairPreemptionCode,
  type StreamingRepairLease,
} from "../fallback-repair-coordinator.js";

interface AuthorityWorkerData {
  readonly databasePath: string;
  readonly recovery?: LegacyImportRecovery;
  readonly rollbackFailureForTest?: true;
}

function isAuthorityWorkerData(value: unknown): value is AuthorityWorkerData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (typeof record.databasePath !== "string" || record.databasePath.length === 0 ||
      keys.some((key) =>
        key !== "databasePath" && key !== "recovery" && key !== "rollbackFailureForTest") ||
      (record.rollbackFailureForTest !== undefined && record.rollbackFailureForTest !== true)) {
    return false;
  }
  if (record.recovery === undefined) {
    return true;
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
let rollbackFailureForTestAvailable =
  isAuthorityWorkerData(workerData) && workerData.rollbackFailureForTest === true;
const repairs = new FallbackRepairCoordinator();

function respond(response: AuthorityWorkerResponse): void {
  authorityPort.postMessage(response);
}

function respondWithError(
  requestId: string,
  code: AuthorityWorkerErrorCode,
  message: string,
): void {
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

function requireAuthorityTransactionDatabase(): DatabaseSync {
  const openedDatabase = requireAuthorityDatabase();
  if (!rollbackFailureForTestAvailable) {
    return openedDatabase;
  }
  rollbackFailureForTestAvailable = false;
  return new Proxy(openedDatabase, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string): void => {
          if (sql === "ROLLBACK") {
            throw new Error(
              "ROLLBACK failed after SELECT secret at /private/authority.sqlite",
            );
          }
          target.exec(sql);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function poisonAuthorityStorage(requestId: string): void {
  const poisonedDatabase = database;
  database = undefined;
  workerClosed = true;
  requests.length = 0;
  if (poisonedDatabase !== undefined) {
    try {
      poisonedDatabase.close();
    } catch {
      // The public terminal error is already fixed and sanitized.
    }
  }
  respondWithError(
    requestId,
    "storage_unavailable",
    "Authority storage became unavailable",
  );
  authorityPort.close();
}

function handleRollbackFatal(requestId: string, error: unknown): boolean {
  if (!(error instanceof AuthorityRollbackFatalError)) {
    return false;
  }
  poisonAuthorityStorage(requestId);
  return true;
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("base64url");
}

function registerActors(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.register-actors") {
    throw new TypeError("registerActors received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityTransactionDatabase();
    runAuthorityImmediateTransaction(openedDatabase, () => {
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
        appendCanonicalIdentityEvent(openedDatabase, {
          principalId: actor.id,
          eventId: (canonicalPayloadJson) => stableId(
            "identity.actor.registered", actor.id, canonicalPayloadJson,
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
    if (handleRollbackFatal(request.requestId, error)) return;
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
    const openedDatabase = requireAuthorityTransactionDatabase();
    const session = runAuthorityImmediateTransaction(openedDatabase, () => {
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
      appendCanonicalIdentityEvent(openedDatabase, {
        principalId: request.input.actorId,
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
    if (handleRollbackFatal(request.requestId, error)) return;
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
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
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
    const streamSeq = appendCanonicalIdentityEvent(openedDatabase, {
      principalId: session.actorId,
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
    const openedDatabase = requireAuthorityTransactionDatabase();
    const result = runAuthorityImmediateTransaction(openedDatabase, () => {
      const current = readSessionByRefreshHash(
        openedDatabase,
        request.currentRefreshTokenHash,
      );
      if (current === undefined) {
        return { ok: false as const, code: "invalid_token" as const };
      }
      if (
        request.expectedPrincipal !== undefined &&
        (current.accountId !== request.expectedPrincipal.accountId ||
          current.actorId !== request.expectedPrincipal.actorId)
      ) {
        return { ok: false as const, code: "identity_forbidden" as const };
      }
      if (current.revokedAt !== null) {
        revokeSessionFamily(openedDatabase, current, request.now);
        return { ok: false as const, code: "session_revoked" as const };
      }
      if (request.now >= current.refreshExpiresAt) {
        return { ok: false as const, code: "token_expired" as const };
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
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
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
    const openedDatabase = requireAuthorityTransactionDatabase();
    const result = runAuthorityImmediateTransaction(openedDatabase, () => {
      const current = readSessionByRefreshHash(
        openedDatabase,
        request.input.currentRefreshTokenHash,
      );
      if (current === undefined) {
        return { kind: "error" as const, code: "invalid_token" as const };
      }
      if (
        request.input.expectedPrincipal !== undefined &&
        (current.accountId !== request.input.expectedPrincipal.accountId ||
          current.actorId !== request.input.expectedPrincipal.actorId)
      ) {
        return { kind: "error" as const, code: "identity_forbidden" as const };
      }
      if (current.revokedAt !== null) {
        revokeSessionFamily(openedDatabase, current, request.input.now);
        return { kind: "error" as const, code: "session_revoked" as const };
      }
      if (request.input.now >= current.refreshExpiresAt) {
        return { kind: "error" as const, code: "token_expired" as const };
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
      appendCanonicalIdentityEvent(openedDatabase, {
        principalId: current.actorId,
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
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
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
    const openedDatabase = requireAuthorityTransactionDatabase();
    const family = openedDatabase.prepare(
      "SELECT family_id AS familyId FROM sessions WHERE access_token_hash = ?",
    ).get(request.accessTokenHash);
    const result = runAuthorityImmediateTransaction(openedDatabase, () => {
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
        return { kind: "error" as const, code: "invalid_token" as const };
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
    if (typeof family?.familyId === "string") {
      repairs.preemptAfterCommit({
        roomIds: [], catalogPrincipalIds: [], familyIds: [family.familyId],
        code: "snapshot_family_revoked", now: request.now,
      });
    }
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority session revoke failed",
    );
  }
}

function respondRepairFailure(requestId: string, cause: unknown, fallbackMessage: string): void {
  if (cause instanceof FallbackRepairError) {
    respondWithError(requestId, cause.code, cause.message);
    return;
  }
  if (cause instanceof AuthorityDatabaseError) {
    respondWithError(requestId, cause.code, cause.message);
    return;
  }
  respondWithError(requestId, "storage_unavailable", fallbackMessage);
}

function revalidateRepairLease(
  lease: StreamingRepairLease,
  context: Extract<AuthorityWorkerRequest, { readonly type: "authority.repair-authorize-page" }>["context"],
  now: number,
): void {
  revalidateSnapshotDatabaseQuery(
    requireAuthorityTransactionDatabase(),
    lease.scope.kind === "room"
      ? {
          kind: "room",
          context,
          roomId: lease.scope.roomId,
          accessRevision: lease.authorizationRevision,
        }
      : {
          kind: "catalog",
          context,
          catalogRevision: lease.authorizationRevision,
        },
    now,
  );
}

function acquireRepair(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.repair-acquire") throw new TypeError("wrong repair acquire");
  try {
    const inspected = inspectStreamingRepairScopeDatabaseQuery(
      requireAuthorityTransactionDatabase(), request.context, request.scope, request.now,
    );
    const lease = repairs.acquire({
      context: request.context,
      scope: request.scope,
      version: inspected.version,
      authorizationRevision: inspected.authorizationRevision,
      now: request.now,
    });
    respond({ type: "authority.repair-lease", requestId: request.requestId, lease });
  } catch (cause: unknown) {
    respondRepairFailure(request.requestId, cause, "Streaming repair acquire failed");
  }
}

function registerRepair(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.repair-register") throw new TypeError("wrong repair register");
  try {
    const lease = repairs.registerChecksum(
      request.snapshotId, request.checksum, request.pageCount, request.now,
    );
    respond({ type: "authority.repair-lease", requestId: request.requestId, lease });
  } catch (cause: unknown) {
    respondRepairFailure(request.requestId, cause, "Streaming repair registration failed");
  }
}

function authorizeRepairPage(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.repair-authorize-page") throw new TypeError("wrong repair page authorization");
  try {
    const current = repairs.describe({
      context: request.context, snapshotId: request.snapshotId, now: request.now,
    });
    revalidateRepairLease(current, request.context, request.now);
    const lease = repairs.authorizePage({
      context: request.context, snapshotId: request.snapshotId,
      page: request.page, now: request.now,
    });
    respond({ type: "authority.repair-lease", requestId: request.requestId, lease });
  } catch (cause: unknown) {
    respondRepairFailure(request.requestId, cause, "Streaming repair page authorization failed");
  }
}

function completeRepair(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.repair-complete") throw new TypeError("wrong repair completion");
  try {
    const current = repairs.describe({
      context: request.context, snapshotId: request.snapshotId, now: request.now,
    });
    revalidateRepairLease(current, request.context, request.now);
    const completed = repairs.complete({
      context: request.context,
      snapshotId: request.snapshotId,
      version: request.version,
      checksum: request.checksum,
      now: request.now,
    });
    respond({
      type: "authority.snapshot-completed",
      requestId: request.requestId,
      completed: {
        type: "snapshot.completed",
        requestId: request.requestId,
        snapshotId: completed.snapshotId,
        version: completed.version,
      },
    });
  } catch (cause: unknown) {
    respondRepairFailure(request.requestId, cause, "Streaming repair completion failed");
  }
}

function releaseRepair(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.repair-release") throw new TypeError("wrong repair release");
  try {
    repairs.releaseOwned({
      context: request.context, snapshotId: request.snapshotId, now: request.now,
    });
    respond({ type: "authority.repair-released", requestId: request.requestId });
  } catch (cause: unknown) {
    respondRepairFailure(request.requestId, cause, "Streaming repair release failed");
  }
}

function isAccessReducingForLease(
  command: Extract<AuthorityWorkerRequest, { readonly type: "authority.execute-human" }>["command"],
  lease: StreamingRepairLease,
  roleDowngradeTargetId: string | undefined,
): boolean {
  if (command.type === "room.archive") return true;
  if (command.type === "member.remove") {
    return command.payload.targetActorId === lease.principalId;
  }
  return command.type === "human.role.change" &&
    roleDowngradeTargetId === lease.principalId;
}

function humanRepairGate(
  opened: DatabaseSync,
  request: Extract<AuthorityWorkerRequest, { readonly type: "authority.execute-human" }>,
  actorId: string,
): {
  readonly impact: ReturnType<typeof repairMutationImpactDatabaseQuery>;
  readonly preemption?: {
    readonly code: RepairPreemptionCode;
    readonly roomPrincipalIds?: readonly string[];
  };
} {
  const impact = repairMutationImpactDatabaseQuery(opened, actorId, request.command);
  let roleDowngradeTargetId: string | undefined;
  if (request.command.type === "human.role.change" && request.command.payload.role === "member") {
    const current = opened.prepare(
      `SELECT role FROM room_memberships
       WHERE room_id = ? AND actor_id = ? AND kind = 'human'`,
    ).get(request.command.roomId, request.command.payload.targetActorId);
    if (current?.role === "admin") {
      roleDowngradeTargetId = request.command.payload.targetActorId;
    }
  }
  const blockers = repairs.blockingLeases(impact, request.now);
  if (blockers.some((lease) =>
    !isAccessReducingForLease(request.command, lease, roleDowngradeTargetId))) {
    throw new FallbackRepairError("repair_barrier_active");
  }
  if (request.command.type === "room.archive") {
    return { impact, preemption: { code: "room_archived" } };
  }
  if (request.command.type === "member.remove") {
    return { impact, preemption: {
      code: "snapshot_stale",
      roomPrincipalIds: [request.command.payload.targetActorId],
    } };
  }
  if (request.command.type === "human.role.change" && roleDowngradeTargetId !== undefined) {
    return { impact, preemption: {
      code: "snapshot_stale",
      roomPrincipalIds: [request.command.payload.targetActorId],
    } };
  }
  return { impact };
}

function executeHuman(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.execute-human") {
    throw new TypeError("executeHuman received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityTransactionDatabase();
    let gate: ReturnType<typeof humanRepairGate> | undefined;
    const result = executeHumanDatabaseCommand(openedDatabase, {
      context: request.context,
      command: request.command,
      ...(request.invitationSecret === undefined
        ? {}
        : { invitationSecret: request.invitationSecret }),
      now: request.now,
      beforeApply(actorId) {
        gate = humanRepairGate(openedDatabase, request, actorId);
      },
    });
    respond({
      type: "authority.command-acknowledged",
      requestId: request.requestId,
      acknowledgement: result.acknowledgement,
    });
    if (result.disposition === "applied" && gate?.preemption !== undefined) {
      repairs.preemptAfterCommit({
        ...gate.impact,
        familyIds: [],
        ...gate.preemption,
        now: request.now,
      });
    }
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    if (error instanceof FallbackRepairError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority command validation failed",
    );
  }
}

function executeAgent(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.execute-agent") {
    throw new TypeError("executeAgent received the wrong request type");
  }
  try {
    const impact = { roomIds: [request.command.roomId], catalogPrincipalIds: [] };
    const result = executeAgentDatabaseCommand(requireAuthorityTransactionDatabase(), {
      context: request.context,
      command: request.command,
      now: request.now,
      beforeApply() {
        if (repairs.blockingLease(impact, request.now) !== undefined) {
          throw new FallbackRepairError("repair_barrier_active");
        }
      },
    });
    respond({
      type: "authority.command-acknowledged",
      requestId: request.requestId,
      acknowledgement: result.acknowledgement,
    });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    if (error instanceof FallbackRepairError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority Agent command failed",
    );
  }
}

function readHistory(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.read-history") {
    throw new TypeError("readHistory received the wrong request type");
  }
  try {
    const messages = readHistoryDatabaseQuery(
      requireAuthorityDatabase(),
      request.context,
      request.roomId,
      request.now,
    );
    respond({
      type: "authority.history",
      requestId: request.requestId,
      messages,
    });
  } catch (error: unknown) {
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithError(request.requestId, "storage_unavailable", "Authority history query failed");
  }
}

function readActor(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.read-actor") {
    throw new TypeError("readActor received the wrong request type");
  }
  try {
    const actor = readActorDatabaseQuery(requireAuthorityDatabase(), request.actorId);
    respond({
      type: "authority.actor",
      requestId: request.requestId,
      ...(actor === undefined ? {} : { actor }),
    });
  } catch {
    respondWithError(request.requestId, "storage_unavailable", "Authority actor query failed");
  }
}

function readRoom(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.read-room") {
    throw new TypeError("readRoom received the wrong request type");
  }
  try {
    const room = readRoomDatabaseQuery(requireAuthorityDatabase(), request.roomId);
    respond({
      type: "authority.room",
      requestId: request.requestId,
      ...(room === undefined ? {} : { room }),
    });
  } catch {
    respondWithError(request.requestId, "storage_unavailable", "Authority room query failed");
  }
}

function canAccessRoom(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.can-access-room") {
    throw new TypeError("canAccessRoom received the wrong request type");
  }
  try {
    const allowed = canAccessRoomDatabaseQuery(
      requireAuthorityDatabase(),
      request.context,
      request.roomId,
      request.now,
    );
    respond({ type: "authority.room-access", requestId: request.requestId, allowed });
  } catch (error: unknown) {
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, "Authority room access query was rejected");
      return;
    }
    respondWithError(request.requestId, "storage_unavailable", "Authority room access query failed");
  }
}

function readRoomAudit(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.read-room-audit") {
    throw new TypeError("readRoomAudit received the wrong request type");
  }
  try {
    const audit = readRoomAuditDatabaseQuery(
      requireAuthorityDatabase(),
      request.context,
      request.roomId,
      request.now,
    );
    respond({ type: "authority.room-audit", requestId: request.requestId, audit });
  } catch (error: unknown) {
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, "Authority room audit query was rejected");
      return;
    }
    respondWithError(request.requestId, "storage_unavailable", "Authority room audit query failed");
  }
}

function listPendingOutbox(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.outbox-list") {
    throw new TypeError("listPendingOutbox received the wrong request type");
  }
  try {
    const deliveries = listPendingOutboxDatabaseQuery(
      requireAuthorityDatabase(),
      request.limit,
      request.now,
    );
    respond({ type: "authority.outbox", requestId: request.requestId, deliveries });
  } catch (error: unknown) {
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithError(request.requestId, "storage_unavailable", "Authority outbox query failed");
  }
}

function authorizeOutboxCandidate(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.outbox-authorize") {
    throw new TypeError("authorizeOutboxCandidate received the wrong request type");
  }
  try {
    const authorized = authorizeOutboxCandidateDatabaseQuery(
      requireAuthorityDatabase(),
      request.deliveryId,
      request.candidate,
      request.now,
    );
    respond({
      type: "authority.outbox-authorized",
      requestId: request.requestId,
      authorized,
    });
  } catch {
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority outbox authorization failed",
    );
  }
}

function markOutboxDispatched(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.outbox-dispatched") {
    throw new TypeError("markOutboxDispatched received the wrong request type");
  }
  try {
    markOutboxDispatchedDatabaseCommand(
      requireAuthorityTransactionDatabase(),
      request.deliveryId,
      request.now,
    );
    respond({ type: "authority.outbox-updated", requestId: request.requestId });
  } catch {
    respondWithError(request.requestId, "storage_unavailable", "Authority outbox update failed");
  }
}

function markOutboxFailed(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.outbox-failed") {
    throw new TypeError("markOutboxFailed received the wrong request type");
  }
  try {
    markOutboxFailedDatabaseCommand(
      requireAuthorityTransactionDatabase(),
      request.deliveryId,
      request.reason,
    );
    respond({ type: "authority.outbox-updated", requestId: request.requestId });
  } catch {
    respondWithError(request.requestId, "storage_unavailable", "Authority outbox update failed");
  }
}

function syncRoom(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.sync-room") {
    throw new TypeError("syncRoom received the wrong request type");
  }
  try {
    const result = syncRoomDatabaseQuery(
      requireAuthorityTransactionDatabase(),
      request.context,
      request.request,
      request.now,
    );
    respond({ type: "authority.room-synced", requestId: request.requestId, result });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithError(request.requestId, "storage_unavailable", "Authority room sync failed");
  }
}

function revalidateSnapshot(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.snapshot-revalidate") {
    throw new TypeError("revalidateSnapshot received the wrong request type");
  }
  try {
    revalidateSnapshotDatabaseQuery(
      requireAuthorityTransactionDatabase(),
      request.validation,
      request.now,
    );
    respond({ type: "authority.snapshot-revalidated", requestId: request.requestId });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority snapshot revalidation failed",
    );
  }
}

function compactRoomStream(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.compact-room-stream") {
    throw new TypeError("compactRoomStream received the wrong request type");
  }
  try {
    const compacted = compactRoomStreamDatabaseCommand(
      requireAuthorityTransactionDatabase(),
      request.roomId,
      request.retainedFromSeq,
    );
    respond({
      type: "authority.room-stream-compacted",
      requestId: request.requestId,
      roomId: request.roomId,
      ...compacted,
    });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithError(
      request.requestId,
      "storage_unavailable",
      "Authority room stream compaction failed",
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
    repairs.releaseAll();
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
    case "authority.execute-agent":
      executeAgent(value);
      return;
    case "authority.read-history":
      readHistory(value);
      return;
    case "authority.read-actor":
      readActor(value);
      return;
    case "authority.read-room":
      readRoom(value);
      return;
    case "authority.can-access-room":
      canAccessRoom(value);
      return;
    case "authority.read-room-audit":
      readRoomAudit(value);
      return;
    case "authority.outbox-list":
      listPendingOutbox(value);
      return;
    case "authority.outbox-authorize":
      authorizeOutboxCandidate(value);
      return;
    case "authority.outbox-dispatched":
      markOutboxDispatched(value);
      return;
    case "authority.outbox-failed":
      markOutboxFailed(value);
      return;
    case "authority.sync-room":
      syncRoom(value);
      return;
    case "authority.snapshot-revalidate":
      revalidateSnapshot(value);
      return;
    case "authority.repair-acquire":
      acquireRepair(value);
      return;
    case "authority.repair-register":
      registerRepair(value);
      return;
    case "authority.repair-authorize-page":
      authorizeRepairPage(value);
      return;
    case "authority.repair-complete":
      completeRepair(value);
      return;
    case "authority.repair-release":
      releaseRepair(value);
      return;
    case "authority.compact-room-stream":
      compactRoomStream(value);
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
