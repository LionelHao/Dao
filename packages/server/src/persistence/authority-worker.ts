import { existsSync } from "node:fs";
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
