import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
  AUTHORITY_SCHEMA_VERSION,
  migrateAuthorityDatabase,
  readSchemaVersion,
} from "./schema.js";
import {
  isAuthorityWorkerRequest,
  type AuthorityWorkerRequest,
  type AuthorityWorkerResponse,
} from "./worker-protocol.js";

interface AuthorityWorkerData {
  readonly databasePath: string;
}

function isAuthorityWorkerData(value: unknown): value is AuthorityWorkerData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 1 &&
    typeof record.databasePath === "string" &&
    record.databasePath.length > 0
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
  if (database !== undefined) {
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

  let openedDatabase: DatabaseSync | undefined;
  try {
    openedDatabase = new DatabaseSync(workerData.databasePath);
    migrateAuthorityDatabase(openedDatabase);
    database = openedDatabase;
    respond({
      type: "authority.ready",
      requestId: request.requestId,
      schemaVersion: AUTHORITY_SCHEMA_VERSION,
    });
  } catch {
    if (openedDatabase !== undefined) {
      try {
        openedDatabase.close();
      } catch {
        // Initialization already failed; never expose database internals to the caller.
      }
    }
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
  if (database === undefined || workerClosed) {
    respondWithError(
      request.requestId,
      workerClosed ? "authority_worker_closed" : "authority_not_initialized",
      workerClosed ? "Authority worker is closed" : "Authority worker is not initialized",
    );
    return;
  }

  try {
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
  if (database === undefined) {
    respondWithError(
      request.requestId,
      "authority_not_initialized",
      "Authority worker is not initialized",
    );
    return;
  }

  try {
    database.close();
    database = undefined;
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

function dispatch(value: unknown): void {
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
    case "authority.close":
      closeAuthority(value);
  }
}

function drainRequests(): void {
  if (processing) {
    return;
  }
  processing = true;
  try {
    while (requests.length > 0) {
      const request = requests.shift();
      dispatch(request);
    }
  } finally {
    processing = false;
  }
}

authorityPort.on("message", (request: unknown) => {
  requests.push(request);
  drainRequests();
});

authorityPort.on("messageerror", () => {
  throw new Error("Authority worker could not deserialize a request");
});
