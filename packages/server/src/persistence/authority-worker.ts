import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { isRoomGovernanceView, type DepartureConflictList } from "@native-im/core";
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
  commitAgentMessageDatabaseCommand,
  executeHumanDatabaseCommand,
  submitHumanMessageDatabaseCommand,
  reviseHumanMessageDatabaseCommand,
  recallHumanMessageDatabaseCommand,
  executeRuntimeAuthorityOperation,
  executeTenantAdministrationAuthorityOperation,
  executeRoomAssignmentAuthorityOperation,
  executeRouteAuthorityOperation,
  executeBallAuthorityOperation,
  authorizeOutboxCandidateDatabaseQuery,
  canAccessRoomDatabaseQuery,
  compactRoomStreamDatabaseCommand,
  listPendingOutboxDatabaseQuery,
  listCommittedRoomCacheInvalidationIntentsDatabaseQuery,
  markOutboxDispatchedDatabaseCommand,
  markOutboxFailedDatabaseCommand,
  markRoomCacheInvalidationCompletedDatabaseCommand,
  markRoomCacheInvalidationFailedDatabaseCommand,
  readActorDatabaseQuery,
  readHistoryDatabaseQuery,
  readMessageHistoryDatabaseQuery,
  readMessageRevisionsDatabaseQuery,
  readRoomAuditDatabaseQuery,
  readRoomDatabaseQuery,
  readRoomGovernanceDatabaseQuery,
  readDepartureConflictsDatabaseQuery,
  readContextFinalExecution,
  repairMutationImpactDatabaseQuery,
  revalidateSnapshotDatabaseQuery,
  runAuthorityImmediateTransaction,
  runAuthorityParticipantImmediateTransaction,
  syncRoomDatabaseQuery,
  inspectStreamingRepairScopeDatabaseQuery,
} from "./authority-database-handler.js";
import { ballResultAsJson } from "../ball-runtime/ball-authority-protocol.js";
import { runtimeResultAsJson } from "../agent-runtime/runtime-authority-protocol.js";
import { routeResultAsJson } from "../route-runtime/route-authority-protocol.js";
import { memoryResultAsJson } from "../room-memory/authority-protocol.js";
import { executeMemoryAuthorityOperation } from "../room-memory/authority-database-handler.js";
import {
  ContextSnapshotDatabaseError,
  contextSnapshotResultAsJson,
  executeContextSnapshotAuthorityOperation,
} from "./context-snapshot-database-authority.js";
import {
  FallbackRepairCoordinator,
  FallbackRepairError,
  type RepairPreemptionCode,
  type StreamingRepairLease,
} from "../fallback-repair-coordinator.js";
import { MAX_ACTIVE_SESSION_FAMILIES, type JsonValue } from "./contracts.js";
import { recoverRuntimeArchiveFenceInTransaction } from "../agent-runtime/runtime-archive-fence-participant.js";
import type { BallDeadlinePolicy } from "../ball-runtime/ball-authority-protocol.js";
import { archivedMessageGateRegistration } from "../message-authority/archived-message-gate.js";
import { createBusinessTimerSuspensionProductionRegistration } from "../business-timers/business-timer-suspension-participant.js";
import { archiveToolSafetyParticipantRegistration } from "../tool-safety/archive-tool-safety-participant.js";
import { assignmentSecurityReductionParticipantRegistration } from "../room-assignment/assignment-security-reduction-participant.js";
import { roomCacheInvalidationRegistration } from "../access/room-cache-invalidation-port.js";
import { createOfflineLeaseInvalidationRegistration } from "../access/offline-lease-invalidation-port.js";
import { createProductionSharedAuthorityParticipantComposition } from "../room-governance/production-participant-composition.js";
import {
  AttachmentAuthorityDatabaseError,
  authorizeAgentAttachmentExtractionDatabaseQuery,
  authorizeAttachmentAccessDatabaseQuery,
  beginAttachmentUploadInTransaction,
  cancelAttachmentUploadInTransaction,
  claimAttachmentProcessingAttemptInTransaction,
  completeAttachmentProcessingAttemptInTransaction,
  finalizeAttachmentUploadInTransaction,
  markAttachmentReadyInTransaction,
  listRecoverableAttachmentProcessingDatabaseQuery,
  readAttachmentObjectReferencesDatabaseQuery,
  readAttachmentProcessingPlanDatabaseQuery,
  readAttachmentStatusDatabaseQuery,
  readAttachmentUploadAssemblyPlanDatabaseQuery,
  recordAttachmentChunkInTransaction,
  retryAttachmentProcessingInTransaction,
  runAttachmentAuthorityImmediateTransaction,
  startAttachmentProcessingAttemptInTransaction,
} from "../attachment-authority/database-authority.js";
import type {
  AttachmentAuthorityIdFactory,
  AttachmentDatabaseOperation,
  AttachmentDatabaseOperationResult,
} from "../attachment-authority/database-contracts.js";
import { isTransientSQLiteContention } from "./sqlite-contention.js";
import type { DeploymentProviderDisclosure } from
  "../tenant-administration/authority-service.js";
import { executeAgentSettingsWorkerOperation } from
  "../agent-settings/worker-authority-operation.js";

interface AuthorityWorkerData {
  readonly databasePath: string;
  readonly sharedAuthorityRecovery?: {
    readonly ballPolicy: BallDeadlinePolicy;
    readonly maxOfflineReadLeaseMs: number;
  };
  readonly deploymentProviderDisclosure?: DeploymentProviderDisclosure;
  readonly recovery?: LegacyImportRecovery;
  readonly rollbackFailureForTest?: true;
  readonly transactionFaultPoint?: "after-domain-write" | "before-commit";
}

function isAuthorityWorkerData(value: unknown): value is AuthorityWorkerData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (typeof record.databasePath !== "string" || record.databasePath.length === 0 ||
      keys.some((key) =>
        key !== "databasePath" && key !== "recovery" && key !== "rollbackFailureForTest" &&
        key !== "transactionFaultPoint" && key !== "sharedAuthorityRecovery" &&
        key !== "deploymentProviderDisclosure") ||
      (record.rollbackFailureForTest !== undefined && record.rollbackFailureForTest !== true) ||
      (record.transactionFaultPoint !== undefined &&
        record.transactionFaultPoint !== "after-domain-write" &&
        record.transactionFaultPoint !== "before-commit")) {
    return false;
  }
  if (record.sharedAuthorityRecovery !== undefined) {
    const authority = record.sharedAuthorityRecovery;
    if (typeof authority !== "object" || authority === null || Array.isArray(authority)) {
      return false;
    }
    const policy = (authority as Record<string, unknown>).ballPolicy;
    const maxOfflineReadLeaseMs =
      (authority as Record<string, unknown>).maxOfflineReadLeaseMs;
    if (Object.keys(authority).sort().join("\u0000") !==
        ["ballPolicy", "maxOfflineReadLeaseMs"].sort().join("\u0000") ||
        typeof policy !== "object" || policy === null || Array.isArray(policy) ||
        Object.keys(policy).sort().join("\u0000") !==
          ["lightTaskDeadlineMs", "openItemDeadlineMs"].sort().join("\u0000") ||
        !Number.isSafeInteger((policy as Record<string, unknown>).openItemDeadlineMs) ||
        Number((policy as Record<string, unknown>).openItemDeadlineMs) <= 0 ||
        !Number.isSafeInteger((policy as Record<string, unknown>).lightTaskDeadlineMs) ||
        Number((policy as Record<string, unknown>).lightTaskDeadlineMs) <= 0 ||
        !Number.isSafeInteger(maxOfflineReadLeaseMs) || Number(maxOfflineReadLeaseMs) <= 0) {
      return false;
    }
  }
  if (record.deploymentProviderDisclosure !== undefined) {
    const disclosure = record.deploymentProviderDisclosure;
    if (typeof disclosure !== "object" || disclosure === null || Array.isArray(disclosure) ||
        Object.keys(disclosure).sort().join("\0") !==
          ["credentialReadiness", "modelId", "providerId"].sort().join("\0") ||
        typeof (disclosure as Record<string, unknown>).providerId !== "string" ||
        typeof (disclosure as Record<string, unknown>).modelId !== "string" ||
        ((disclosure as Record<string, unknown>).credentialReadiness !== "ready" &&
         (disclosure as Record<string, unknown>).credentialReadiness !== "noauth")) {
      return false;
    }
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
const workerAuthorityPolicy = isAuthorityWorkerData(workerData)
  ? workerData.sharedAuthorityRecovery
  : undefined;
const governanceParticipantComposition = createProductionSharedAuthorityParticipantComposition({
  ballPolicy: workerAuthorityPolicy?.ballPolicy ?? {
    openItemDeadlineMs: 24 * 60 * 60 * 1_000,
    lightTaskDeadlineMs: 24 * 60 * 60 * 1_000,
  },
  maxOfflineReadLeaseMs:
    workerAuthorityPolicy?.maxOfflineReadLeaseMs ?? 24 * 60 * 60 * 1_000,
});

function respond(response: AuthorityWorkerResponse): void {
  authorityPort.postMessage(response);
}

function respondWithError(
  requestId: string,
  code: AuthorityWorkerErrorCode,
  message: string,
  details?: DepartureConflictList,
): void {
  if (code === "departure_blocked" && details !== undefined) {
    respond({ type: "authority.error", requestId, code, message, details });
    return;
  }
  if (code === "departure_blocked") {
    respond({
      type: "authority.error",
      requestId,
      code: "dependency_unavailable",
      message: "Authority departure conflict details were unavailable",
    });
    return;
  }
  respond({ type: "authority.error", requestId, code, message });
}

function recoverArchivedAuthorityParticipants(openedDatabase: DatabaseSync): void {
  const recoveryTime = new Date().toISOString();
  const recoveryPolicy = workerData.sharedAuthorityRecovery;
  const businessTimers = createBusinessTimerSuspensionProductionRegistration(
    recoveryPolicy?.ballPolicy ?? {
      openItemDeadlineMs: 24 * 60 * 60 * 1_000,
      lightTaskDeadlineMs: 24 * 60 * 60 * 1_000,
    },
  );
  const offlineLeases = recoveryPolicy === undefined
    ? undefined
    : createOfflineLeaseInvalidationRegistration({
        maxOfflineReadLeaseMs: recoveryPolicy.maxOfflineReadLeaseMs,
      });
  let afterRoomId = "";
  while (true) {
    const rooms = openedDatabase.prepare(
      `SELECT id, archive_generation AS archiveGeneration, archived_at AS archivedAt
       FROM rooms
       WHERE status = 'archived' AND id > ?
       ORDER BY id
       LIMIT 64`,
    ).all(afterRoomId);
    if (rooms.length === 0) return;
    for (const room of rooms) {
      if (typeof room.id !== "string" || room.id.length === 0 ||
          typeof room.archiveGeneration !== "number" || room.archiveGeneration <= 0 ||
          typeof room.archivedAt !== "string" ||
          !Number.isFinite(Date.parse(room.archivedAt))) {
        throw new Error("Archived participant recovery room was corrupt");
      }
      runAuthorityParticipantImmediateTransaction(
        openedDatabase,
        room.id,
        `shared-authority-archive-recovery:${room.id}:${String(room.archiveGeneration)}`,
        (transaction) => {
          const roomId = room.id as string;
          const archiveGeneration = room.archiveGeneration as number;
          const archivedAt = room.archivedAt as string;
          const results = [
            archivedMessageGateRegistration.participant!.blockForArchive(transaction, {
              roomId,
              archiveGeneration,
            }),
            businessTimers.participant!.suspendForArchive(transaction, {
              roomId,
              archiveGeneration,
              archivedAt,
            }),
            archiveToolSafetyParticipantRegistration.participant!.settleUndispatched(
              transaction,
              { roomId, archiveGeneration, now: archivedAt },
            ),
          ];
          if (results.some((result) => !result.ok)) {
            throw new Error("Archived participant recovery failed closed");
          }
          recoverRuntimeArchiveFenceInTransaction(transaction, {
            roomId,
            now: recoveryTime,
          });
          const assignment = assignmentSecurityReductionParticipantRegistration
            .participant!.reduceForArchive(transaction, {
              roomId,
              archiveGeneration,
              now: archivedAt,
            });
          const cache = roomCacheInvalidationRegistration.participant!
            .invalidateRoomCacheInTransaction(transaction, {
              roomId,
              lifecycleGeneration: archiveGeneration,
              reason: "room_archived",
            });
          const lease = offlineLeases?.participant!.invalidateOfflineLeasesInTransaction(
            transaction,
            {
              roomId,
              lifecycleGeneration: archiveGeneration,
              reason: "room_archived",
            },
          );
          if (!assignment.ok || !cache.ok || lease?.ok === false) {
            throw new Error("Archived participant recovery failed closed");
          }
        },
      );
    }
    const last = rooms.at(-1)?.id;
    if (typeof last !== "string") {
      throw new Error("Archived runtime recovery cursor was corrupt");
    }
    afterRoomId = last;
  }
}

function openAuthorityDatabase(): DatabaseSync {
  if (!isAuthorityWorkerData(workerData)) {
    throw new Error("Invalid authority worker data");
  }
  const openedDatabase = new DatabaseSync(workerData.databasePath);
  try {
    migrateAuthorityDatabase(openedDatabase);
    recoverArchivedAuthorityParticipants(openedDatabase);
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
    "authority_storage_poisoned",
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

function respondWithStorageFailure(
  requestId: string,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error instanceof AuthorityDatabaseError) {
    respondWithError(requestId, error.code, error.message, error.details);
    return;
  }
  respondWithError(
    requestId,
    isTransientSQLiteContention(error)
      ? "authority_storage_transient"
      : "authority_operation_unavailable",
    fallbackMessage,
  );
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
      const insertStaticAgentProfile = openedDatabase.prepare(
        `INSERT INTO agent_profiles (
           id, actor_id, revision, status, capability_ceiling_json, tool_ceiling_json,
           display_name, global_responsibility, created_at, updated_at, source_kind
         ) VALUES (?, ?, 1, 'disabled', '[]', '[]', ?, ?, ?, ?, 'static_bootstrap')`,
      );
      const insertStaticAgentProfileRevision = openedDatabase.prepare(
        `INSERT INTO agent_profile_revisions (
           profile_id, revision, actor_id, display_name, global_responsibility, status,
           capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id,
           changed_at, operation
         ) VALUES (?, 1, ?, ?, ?, 'disabled', '[]', '[]', NULL, ?, 'static_bootstrap')`,
      );

      for (const actor of request.actors) {
        const reachability = actor.kind === "human" ? actor.reachability : null;
        const readiness = actor.kind === "agent" ? actor.readiness : null;
        const toolPermissionsJson = JSON.stringify(
          actor.kind === "agent" ? actor.toolPermissions : [],
        );
        const existing = selectActor.get(actor.id);
        if (existing !== undefined) {
          const humanCatalogConflict = actor.kind === "human" && (
            existing.displayName !== actor.displayName ||
            existing.reachability !== reachability ||
            existing.readiness !== readiness ||
            existing.toolPermissionsJson !== toolPermissionsJson
          );
          if (existing.kind !== actor.kind || humanCatalogConflict) {
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
        const occurredAt = new Date().toISOString();
        if (actor.kind === "agent") {
          const profileId = `static-profile:${stableId("agent-profile", actor.id)}`;
          const responsibility = "Review static Agent configuration before enabling.";
          insertStaticAgentProfile.run(
            profileId,
            actor.id,
            actor.displayName,
            responsibility,
            occurredAt,
            occurredAt,
          );
          insertStaticAgentProfileRevision.run(
            profileId,
            actor.id,
            actor.displayName,
            responsibility,
            occurredAt,
          );
        }
        const payload = { actor };
        appendCanonicalIdentityEvent(openedDatabase, {
          principalId: actor.id,
          eventId: (canonicalPayloadJson) => stableId(
            "identity.actor.registered", actor.id, canonicalPayloadJson,
          ),
          eventType: "identity.actor.registered",
          occurredAt,
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
    if (!(error instanceof Error) || error.message !== "actor_conflict") {
      respondWithStorageFailure(
        request.requestId,
        error,
        "Authority actor registration failed",
      );
      return;
    }
    respondWithError(
      request.requestId,
      "actor_conflict",
      "Authority actor registration conflicts with existing state",
    );
  }
}

function issueSession(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.session-issue") {
    throw new TypeError("issueSession received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityTransactionDatabase();
    const result = runAuthorityImmediateTransaction(openedDatabase, () => {
      const actor = openedDatabase
        .prepare("SELECT kind FROM actors WHERE id = ?")
        .get(request.input.actorId);
      if (actor?.kind !== "human") {
        throw new Error("identity_forbidden");
      }
      const activeFamilyCount = openedDatabase.prepare(
        `SELECT COUNT(*) AS count
         FROM session_families
         WHERE account_id = ? AND actor_id = ?
           AND revoked_at IS NULL AND refresh_expires_at > ?`,
      ).get(
        request.input.accountId,
        request.input.actorId,
        request.input.now,
      )?.count;
      if (typeof activeFamilyCount !== "number") {
        throw new Error("session_family_corrupt");
      }
      if (activeFamilyCount > MAX_ACTIVE_SESSION_FAMILIES) {
        throw new Error("session_limit_reached");
      }
      let evictedFamilyId: string | undefined;
      if (activeFamilyCount === MAX_ACTIVE_SESSION_FAMILIES) {
        const oldest = readOldestActiveSessionFamily(
          openedDatabase,
          request.input.accountId,
          request.input.actorId,
          request.input.now,
        );
        if (oldest === undefined) {
          throw new Error("session_family_corrupt");
        }
        revokeSessionFamily(openedDatabase, oldest, request.input.now);
        evictedFamilyId = oldest.familyId;
      }
      const familyId = request.input.accessTokenHash;
      const sessionId = request.input.accessTokenHash;
      if (openedDatabase.prepare(
        "SELECT 1 FROM session_families WHERE public_id = ?",
      ).get(request.input.publicSessionId) !== undefined) {
        throw new Error("session_id_conflict");
      }
      openedDatabase
        .prepare(
          `INSERT INTO session_families (
             family_id, public_id, account_id, actor_id, device_id, device_label,
             platform, created_at, refresh_expires_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          familyId,
          request.input.publicSessionId,
          request.input.accountId,
          request.input.actorId,
          request.input.device.id,
          request.input.device.label,
          request.input.device.platform,
          request.input.now,
          request.input.refreshExpiresAt,
        );
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
        occurredAt: new Date(request.input.now).toISOString(),
        payload: {
          sessionId,
          familyId,
          accountId: request.input.accountId,
        },
      });
      return {
        session: {
          sessionId,
          familyId,
          publicSessionId: request.input.publicSessionId,
          accountId: request.input.accountId,
          actorId: request.input.actorId,
          accessExpiresAt: request.input.accessExpiresAt,
          refreshExpiresAt: request.input.refreshExpiresAt,
        },
        evictedFamilyId,
      };
    });
    if (result.evictedFamilyId !== undefined) {
      preemptRevokedFamilyAfterCommit(result.evictedFamilyId, request.input.now);
    }
    respond({
      type: "authority.session-issued",
      requestId: request.requestId,
      session: result.session,
    });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    const code = error instanceof Error && error.message === "identity_forbidden"
      ? "identity_forbidden"
      : error instanceof Error && error.message === "session_id_conflict"
        ? "session_id_conflict"
        : error instanceof Error && error.message === "session_limit_reached"
          ? "session_limit_reached"
          : undefined;
    if (code === undefined) {
      respondWithStorageFailure(
        request.requestId,
        error,
        "Authority session issuance failed",
      );
      return;
    }
    respondWithError(
      request.requestId,
      code,
      code === "identity_forbidden"
        ? "Session actor is forbidden"
        : code === "session_id_conflict"
          ? "Session identifier conflicts with existing state"
          : "Active session family limit reached",
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
           family.revoked_at AS familyRevokedAt,
           actor.kind AS actorKind
         FROM sessions AS session
         JOIN session_families AS family
           ON family.family_id = session.family_id
          AND family.account_id = session.account_id
          AND family.actor_id = session.actor_id
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
    if (
      typeof session.revokedAt === "number" ||
      typeof session.familyRevokedAt === "number"
    ) {
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
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority session authentication failed",
    );
  }
}

interface SessionAuthorityRow {
  readonly sessionId: string;
  readonly familyId: string;
  readonly publicSessionId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly revokedAt: number | null;
  readonly familyRevokedAt: number | null;
}

function readOldestActiveSessionFamily(
  openedDatabase: DatabaseSync,
  accountId: string,
  actorId: string,
  now: number,
): SessionAuthorityRow | undefined {
  const row = openedDatabase.prepare(
    `SELECT
       session.access_token_hash AS sessionId,
       family.family_id AS familyId,
       family.public_id AS publicSessionId,
       family.account_id AS accountId,
       family.actor_id AS actorId,
       session.access_expires_at AS accessExpiresAt,
       family.refresh_expires_at AS refreshExpiresAt,
       session.revoked_at AS revokedAt,
       family.revoked_at AS familyRevokedAt
     FROM session_families AS family
     JOIN sessions AS session ON session.family_id = family.family_id
     WHERE family.account_id = ? AND family.actor_id = ?
       AND family.revoked_at IS NULL AND family.refresh_expires_at > ?
     ORDER BY family.created_at ASC, family.public_id ASC, session.rowid ASC
     LIMIT 1`,
  ).get(accountId, actorId, now);
  if (row === undefined) return undefined;
  if (
    typeof row.sessionId !== "string" ||
    typeof row.familyId !== "string" ||
    typeof row.publicSessionId !== "string" ||
    typeof row.accountId !== "string" ||
    typeof row.actorId !== "string" ||
    typeof row.accessExpiresAt !== "number" ||
    typeof row.refreshExpiresAt !== "number" ||
    (row.revokedAt !== null && typeof row.revokedAt !== "number") ||
    (row.familyRevokedAt !== null && typeof row.familyRevokedAt !== "number")
  ) {
    throw new Error("session_family_corrupt");
  }
  return row as unknown as SessionAuthorityRow;
}

function readSessionByRefreshHash(
  openedDatabase: DatabaseSync,
  refreshTokenHash: string,
): SessionAuthorityRow | undefined {
  const row = openedDatabase
    .prepare(
      `SELECT
         access_token_hash AS sessionId,
         session.family_id AS familyId,
         family.public_id AS publicSessionId,
         session.account_id AS accountId,
         session.actor_id AS actorId,
         session.access_expires_at AS accessExpiresAt,
         session.refresh_expires_at AS refreshExpiresAt,
         session.revoked_at AS revokedAt,
         family.revoked_at AS familyRevokedAt
       FROM sessions AS session
       JOIN session_families AS family
         ON family.family_id = session.family_id
        AND family.account_id = session.account_id
        AND family.actor_id = session.actor_id
       WHERE session.refresh_token_hash = ?`,
    )
    .get(refreshTokenHash);
  if (row === undefined) {
    return undefined;
  }
  if (
    typeof row.sessionId !== "string" ||
    typeof row.familyId !== "string" ||
    typeof row.publicSessionId !== "string" ||
    typeof row.accountId !== "string" ||
    typeof row.actorId !== "string" ||
    typeof row.accessExpiresAt !== "number" ||
    typeof row.refreshExpiresAt !== "number" ||
    (row.revokedAt !== null && typeof row.revokedAt !== "number") ||
    (row.familyRevokedAt !== null && typeof row.familyRevokedAt !== "number")
  ) {
    throw new Error("session_corrupt");
  }
  return row as unknown as SessionAuthorityRow;
}

interface AccessAuthorityRow extends SessionAuthorityRow {
  readonly actorKind: string;
}

function readSessionByAccessHash(
  openedDatabase: DatabaseSync,
  accessTokenHash: string,
): AccessAuthorityRow | undefined {
  const row = openedDatabase.prepare(
    `SELECT
       session.access_token_hash AS sessionId,
       session.family_id AS familyId,
       family.public_id AS publicSessionId,
       session.account_id AS accountId,
       session.actor_id AS actorId,
       session.access_expires_at AS accessExpiresAt,
       family.refresh_expires_at AS refreshExpiresAt,
       session.revoked_at AS revokedAt,
       family.revoked_at AS familyRevokedAt,
       actor.kind AS actorKind
     FROM sessions AS session
     JOIN session_families AS family
       ON family.family_id = session.family_id
      AND family.account_id = session.account_id
      AND family.actor_id = session.actor_id
     JOIN actors AS actor ON actor.id = session.actor_id
     WHERE session.access_token_hash = ?`,
  ).get(accessTokenHash);
  if (row === undefined) {
    return undefined;
  }
  if (
    typeof row.sessionId !== "string" ||
    typeof row.familyId !== "string" ||
    typeof row.publicSessionId !== "string" ||
    typeof row.accountId !== "string" ||
    typeof row.actorId !== "string" ||
    typeof row.accessExpiresAt !== "number" ||
    typeof row.refreshExpiresAt !== "number" ||
    (row.revokedAt !== null && typeof row.revokedAt !== "number") ||
    (row.familyRevokedAt !== null && typeof row.familyRevokedAt !== "number") ||
    typeof row.actorKind !== "string"
  ) {
    throw new Error("session_corrupt");
  }
  return row as unknown as AccessAuthorityRow;
}

function validateAccessAuthorityRow(
  session: AccessAuthorityRow | undefined,
  now: number,
): "invalid_token" | "identity_forbidden" | "session_revoked" | "token_expired" | undefined {
  if (session === undefined) return "invalid_token";
  if (session.actorKind !== "human") return "identity_forbidden";
  if (session.revokedAt !== null || session.familyRevokedAt !== null) {
    return "session_revoked";
  }
  if (now >= session.accessExpiresAt) return "token_expired";
  return undefined;
}

function revokeSessionFamily(
  openedDatabase: DatabaseSync,
  session: SessionAuthorityRow,
  now: number,
): void {
  openedDatabase
    .prepare(
      `UPDATE session_families
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE family_id = ?`,
    )
    .run(now, session.familyId);
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

function preemptRevokedFamilyAfterCommit(familyId: string, now: number): void {
  repairs.preemptAfterCommit({
    roomIds: [],
    catalogPrincipalIds: [],
    familyIds: [familyId],
    code: "snapshot_family_revoked",
    now,
  });
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
      if (current.revokedAt !== null || current.familyRevokedAt !== null) {
        revokeSessionFamily(openedDatabase, current, request.now);
        return {
          ok: false as const,
          code: "session_revoked" as const,
          revokedFamilyId: current.familyId,
        };
      }
      if (request.now >= current.refreshExpiresAt) {
        return { ok: false as const, code: "token_expired" as const };
      }
      return { ok: true as const };
    }, isAuthorityWorkerData(workerData) && workerData.transactionFaultPoint === "before-commit"
      ? () => process.exit(82)
      : undefined);
    if (!result.ok) {
      if ("revokedFamilyId" in result) {
        preemptRevokedFamilyAfterCommit(result.revokedFamilyId, request.now);
      }
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
    respondWithStorageFailure(
      request.requestId,
      error,
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
      if (current.revokedAt !== null || current.familyRevokedAt !== null) {
        revokeSessionFamily(openedDatabase, current, request.input.now);
        return {
          kind: "error" as const,
          code: "session_revoked" as const,
          revokedFamilyId: current.familyId,
        };
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
      openedDatabase
        .prepare(
          `UPDATE session_families
           SET refresh_expires_at = MAX(refresh_expires_at, ?)
           WHERE family_id = ?`,
        )
        .run(request.input.refreshExpiresAt, current.familyId);
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
          publicSessionId: current.publicSessionId,
          accountId: current.accountId,
          actorId: current.actorId,
          accessExpiresAt: request.input.accessExpiresAt,
          refreshExpiresAt: request.input.refreshExpiresAt,
        },
      };
    }, isAuthorityWorkerData(workerData) && workerData.transactionFaultPoint === "before-commit"
      ? () => process.exit(82)
      : undefined);
    if (result.kind === "error") {
      if ("revokedFamilyId" in result) {
        preemptRevokedFamilyAfterCommit(result.revokedFamilyId, request.input.now);
      }
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
    respondWithStorageFailure(
      request.requestId,
      error,
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
    if (typeof family?.familyId === "string") {
      preemptRevokedFamilyAfterCommit(family.familyId, request.now);
    }
    respond({ type: "authority.session-revoked", requestId: request.requestId });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority session revoke failed",
    );
  }
}

function listSessions(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.sessions-list") {
    throw new TypeError("listSessions received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityTransactionDatabase();
    const result = runAuthorityImmediateTransaction(openedDatabase, () => {
      const caller = readSessionByAccessHash(openedDatabase, request.accessTokenHash);
      const error = validateAccessAuthorityRow(caller, request.now);
      if (error !== undefined || caller === undefined) {
        return { kind: "error" as const, code: error ?? "invalid_token" as const };
      }
      const rows = openedDatabase.prepare(
        `SELECT
           public_id AS id,
           device_label AS deviceLabel,
           platform,
           created_at AS createdAt,
           refresh_expires_at AS refreshExpiresAt,
           family_id AS familyId
         FROM session_families
         WHERE account_id = ? AND actor_id = ?
           AND revoked_at IS NULL AND refresh_expires_at > ?
         ORDER BY created_at DESC, public_id ASC
         LIMIT ?`,
      ).all(
        caller.accountId,
        caller.actorId,
        request.now,
        MAX_ACTIVE_SESSION_FAMILIES + 1,
      );
      if (rows.length > MAX_ACTIVE_SESSION_FAMILIES) {
        return { kind: "error" as const, code: "session_limit_reached" as const };
      }
      const sessions = rows.map((row) => {
        if (
          typeof row.id !== "string" ||
          typeof row.deviceLabel !== "string" ||
          (row.platform !== "macos" && row.platform !== "windows" &&
            row.platform !== "linux" && row.platform !== "unknown") ||
          (row.createdAt !== null && typeof row.createdAt !== "number") ||
          typeof row.refreshExpiresAt !== "number" ||
          typeof row.familyId !== "string"
        ) {
          throw new Error("session_family_corrupt");
        }
        const platform = row.platform as "macos" | "windows" | "linux" | "unknown";
        return {
          id: row.id,
          deviceLabel: row.deviceLabel,
          platform,
          ...(row.createdAt === null
            ? {}
            : { createdAt: new Date(row.createdAt).toISOString() }),
          refreshExpiresAt: new Date(row.refreshExpiresAt).toISOString(),
          current: row.familyId === caller.familyId,
        };
      });
      return { kind: "sessions" as const, sessions };
    });
    if (result.kind === "error") {
      respondWithError(request.requestId, result.code, "Authority session list was rejected");
      return;
    }
    respond({
      type: "authority.sessions",
      requestId: request.requestId,
      sessions: result.sessions,
    });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority session list failed",
    );
  }
}

function revokeTargetSession(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.session-revoke-target") {
    throw new TypeError("revokeTargetSession received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityTransactionDatabase();
    const result = runAuthorityImmediateTransaction(openedDatabase, () => {
      const caller = readSessionByAccessHash(openedDatabase, request.accessTokenHash);
      const error = validateAccessAuthorityRow(caller, request.now);
      if (error !== undefined || caller === undefined) {
        return { kind: "error" as const, code: error ?? "invalid_token" as const };
      }
      const target = openedDatabase.prepare(
        `SELECT
           session.access_token_hash AS sessionId,
           family.family_id AS familyId,
           family.public_id AS publicSessionId,
           family.account_id AS accountId,
           family.actor_id AS actorId,
           session.access_expires_at AS accessExpiresAt,
           family.refresh_expires_at AS refreshExpiresAt,
           session.revoked_at AS revokedAt,
           family.revoked_at AS familyRevokedAt
         FROM session_families AS family
         JOIN sessions AS session ON session.family_id = family.family_id
         WHERE family.public_id = ?
           AND family.account_id = ? AND family.actor_id = ?
         ORDER BY session.rowid
         LIMIT 1`,
      ).get(request.publicSessionId, caller.accountId, caller.actorId);
      if (target === undefined) {
        return { kind: "error" as const, code: "session_not_found" as const };
      }
      if (
        typeof target.sessionId !== "string" ||
        typeof target.familyId !== "string" ||
        typeof target.publicSessionId !== "string" ||
        typeof target.accountId !== "string" ||
        typeof target.actorId !== "string" ||
        typeof target.accessExpiresAt !== "number" ||
        typeof target.refreshExpiresAt !== "number" ||
        (target.revokedAt !== null && typeof target.revokedAt !== "number") ||
        (target.familyRevokedAt !== null && typeof target.familyRevokedAt !== "number")
      ) {
        throw new Error("session_family_corrupt");
      }
      const session = target as unknown as SessionAuthorityRow;
      revokeSessionFamily(openedDatabase, session, request.now);
      return { kind: "revoked" as const, familyId: session.familyId };
    }, isAuthorityWorkerData(workerData) && workerData.transactionFaultPoint === "before-commit"
      ? () => process.exit(82)
      : undefined);
    if (result.kind === "error") {
      respondWithError(
        request.requestId,
        result.code,
        "Authority targeted session revoke was rejected",
      );
      return;
    }
    preemptRevokedFamilyAfterCommit(result.familyId, request.now);
    respond({
      type: "authority.session-target-revoked",
      requestId: request.requestId,
      publicSessionId: request.publicSessionId,
    });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority targeted session revoke failed",
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
  respondWithStorageFailure(requestId, cause, fallbackMessage);
}

function revalidateRepairLease(
  lease: StreamingRepairLease,
  context: Extract<AuthorityWorkerRequest, { readonly type: "authority.repair-authorize-page" }>["context"],
  now: number,
): void {
  if ((lease.scope.kind === "room") !== (lease.version.kind === "room")) {
    throw new TypeError("Streaming repair lease scope/version mismatch");
  }
  revalidateSnapshotDatabaseQuery(
    requireAuthorityTransactionDatabase(),
    lease.scope.kind === "room"
      ? {
          kind: "room",
          context,
          roomId: lease.scope.roomId,
          accessRevision: lease.authorizationRevision,
          watermark: lease.version.kind === "room" ? lease.version.watermark : 0,
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
  command: Extract<AuthorityWorkerRequest, {
    readonly type: "authority.execute-human" | "authority.execute-human-governance";
  }>["command"],
  lease: StreamingRepairLease,
  roleDowngradeTargetId: string | undefined,
): boolean {
  if (command.type === "room.archive") return true;
  if (command.type === "member.remove" || command.type === "room.member.remove") {
    return command.payload.targetActorId === lease.principalId;
  }
  return command.type === "human.role.change" &&
    roleDowngradeTargetId === lease.principalId;
}

function humanRepairGate(
  opened: DatabaseSync,
  request: Extract<AuthorityWorkerRequest, {
    readonly type: "authority.execute-human" | "authority.execute-human-governance";
  }>,
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
  if (request.command.type === "member.remove" || request.command.type === "room.member.remove") {
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
      participantComposition: governanceParticipantComposition,
      ...(request.invitationSecret === undefined
        ? {}
        : { invitationSecret: request.invitationSecret }),
      now: request.now,
      beforeApply(actorId) {
        gate = humanRepairGate(openedDatabase, request, actorId);
      },
      ...(isAuthorityWorkerData(workerData) &&
        workerData.transactionFaultPoint === "after-domain-write"
        ? { afterDomainWrite: () => process.exit(81) }
        : {}),
      ...(isAuthorityWorkerData(workerData) &&
        workerData.transactionFaultPoint === "before-commit"
        ? { beforeCommit: () => process.exit(82) }
        : {}),
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
      respondWithError(request.requestId, error.code, error.message, error.details);
      return;
    }
    if (error instanceof FallbackRepairError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority command validation failed",
    );
  }
}

function executeHumanGovernance(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.execute-human-governance") {
    throw new TypeError("executeHumanGovernance received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityTransactionDatabase();
    let gate: ReturnType<typeof humanRepairGate> | undefined;
    const result = executeHumanDatabaseCommand(openedDatabase, {
      context: request.context,
      command: request.command,
      participantComposition: governanceParticipantComposition,
      now: request.now,
      beforeApply(actorId) {
        gate = humanRepairGate(openedDatabase, request, actorId);
      },
      ...(isAuthorityWorkerData(workerData) &&
        workerData.transactionFaultPoint === "after-domain-write"
        ? { afterDomainWrite: () => process.exit(81) }
        : {}),
      ...(isAuthorityWorkerData(workerData) &&
        workerData.transactionFaultPoint === "before-commit"
        ? { beforeCommit: () => process.exit(82) }
        : {}),
    });
    const acknowledgementResult = result.acknowledgement.result;
    const governance = typeof acknowledgementResult === "object" &&
        acknowledgementResult !== null && !Array.isArray(acknowledgementResult) &&
        "governance" in acknowledgementResult
      ? acknowledgementResult.governance
      : undefined;
    if (!isRoomGovernanceView(governance) || governance.roomId !== request.command.roomId) {
      throw new AuthorityDatabaseError(
        "storage_unavailable",
        "Authority governance acknowledgement is corrupt",
      );
    }
    respond({
      type: "authority.governance-acknowledged",
      requestId: request.requestId,
      acknowledgement: {
        governance,
        eventIds: result.acknowledgement.eventIds,
        replayed: result.disposition === "replayed",
      },
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
      respondWithError(request.requestId, error.code, error.message, error.details);
      return;
    }
    if (error instanceof FallbackRepairError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority governance command validation failed",
    );
  }
}

function readDepartureConflicts(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.departure-conflicts") {
    throw new TypeError("readDepartureConflicts received the wrong request type");
  }
  try {
    const conflicts = readDepartureConflictsDatabaseQuery(
      requireAuthorityTransactionDatabase(),
      request.context,
      { roomId: request.roomId, targetActorId: request.targetActorId },
      request.now,
      governanceParticipantComposition,
    );
    respond({ type: "authority.departure-conflicts", requestId: request.requestId, conflicts });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message, error.details);
      return;
    }
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority departure query validation failed",
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
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority Agent command failed",
    );
  }
}

function respondMessageAuthorityFailure(
  requestId: string,
  error: unknown,
  fallbackMessage: string,
): void {
  if (handleRollbackFatal(requestId, error)) return;
  if (error instanceof AuthorityDatabaseError) {
    respondWithError(requestId, error.code, error.message);
    return;
  }
  if (error instanceof FallbackRepairError) {
    respondWithError(requestId, error.code, error.message);
    return;
  }
  respondWithStorageFailure(requestId, error, fallbackMessage);
}

function requireNoMessageRepairBarrier(roomId: string, now: number): void {
  if (repairs.blockingLeases({ roomIds: [roomId], catalogPrincipalIds: [] }, now).length > 0) {
    throw new FallbackRepairError("repair_barrier_active");
  }
}

function deterministicAttachmentId(uploadId: string): string {
  const bytes = createHash("sha256").update("dao-attachment\0").update(uploadId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const attachmentAuthorityIds: AttachmentAuthorityIdFactory = Object.freeze({
  nextUploadId: () => randomUUID(),
  attachmentIdForUpload: deterministicAttachmentId,
  nextEventId: () => randomUUID(),
  nextOutboxId: () => randomUUID(),
  nextExtractionArtifactId: () => randomUUID(),
});

function executeAttachmentDatabaseOperation(
  operation: AttachmentDatabaseOperation,
  now: number,
): AttachmentDatabaseOperationResult {
  const database = requireAuthorityTransactionDatabase();
  const clock = { nowMs: () => now } as const;
  switch (operation.kind) {
    case "upload-begin":
      return runAttachmentAuthorityImmediateTransaction(database, () =>
        beginAttachmentUploadInTransaction(database, {
          context: operation.context,
          command: operation.command,
          clock,
          ids: attachmentAuthorityIds,
        }));
    case "upload-chunk":
      return runAttachmentAuthorityImmediateTransaction(database, () =>
        recordAttachmentChunkInTransaction(database, {
          context: operation.context,
          command: operation.command,
          clock,
        }));
    case "upload-plan":
      return readAttachmentUploadAssemblyPlanDatabaseQuery(database, {
        context: operation.context,
        uploadId: operation.uploadId,
        clock,
        ids: attachmentAuthorityIds,
      });
    case "upload-finalize":
      return runAttachmentAuthorityImmediateTransaction(database, () =>
        finalizeAttachmentUploadInTransaction(database, {
          context: operation.context,
          command: operation.command,
          clock,
          ids: attachmentAuthorityIds,
        }));
    case "upload-cancel":
      return runAttachmentAuthorityImmediateTransaction(database, () =>
        cancelAttachmentUploadInTransaction(database, {
          context: operation.context,
          command: operation.command,
          clock,
          ids: attachmentAuthorityIds,
        }));
    case "processing-retry":
      return runAttachmentAuthorityImmediateTransaction(database, () =>
        retryAttachmentProcessingInTransaction(database, {
          context: operation.context,
          command: operation.command,
          clock,
          ids: attachmentAuthorityIds,
        }));
    case "processing-inspect":
      return readAttachmentProcessingPlanDatabaseQuery(database, {
        context: operation.context,
        attachmentId: operation.attachmentId,
        expectedGeneration: operation.expectedGeneration,
      });
    case "processing-recover":
      return listRecoverableAttachmentProcessingDatabaseQuery(database, {
        context: operation.context,
        limit: operation.limit,
      });
    case "object-references":
      return readAttachmentObjectReferencesDatabaseQuery(database, {
        context: operation.context,
      });
    case "processing-claim":
      return runAttachmentAuthorityImmediateTransaction(database, () =>
        claimAttachmentProcessingAttemptInTransaction(database, {
          context: operation.context,
          command: operation.command,
          clock,
          ids: attachmentAuthorityIds,
        }));
    case "processing-start":
      return runAttachmentAuthorityImmediateTransaction(database, () =>
        startAttachmentProcessingAttemptInTransaction(database, {
          context: operation.context,
          command: operation.command,
          clock,
        }));
    case "processing-complete":
      return runAttachmentAuthorityImmediateTransaction(database, () =>
        completeAttachmentProcessingAttemptInTransaction(database, {
          context: operation.context,
          command: operation.command,
          clock,
          ids: attachmentAuthorityIds,
        }));
    case "attachment-ready":
      return runAttachmentAuthorityImmediateTransaction(database, () =>
        markAttachmentReadyInTransaction(database, {
          context: operation.context,
          command: operation.command,
          clock,
          ids: attachmentAuthorityIds,
        }));
    case "status-read":
      return readAttachmentStatusDatabaseQuery(database, {
        context: operation.context,
        attachmentId: operation.attachmentId,
        clock,
      });
    case "access-authorize":
      return authorizeAttachmentAccessDatabaseQuery(database, {
        context: operation.context,
        command: operation.command,
        clock,
      });
    case "agent-extraction-authorize":
      return authorizeAgentAttachmentExtractionDatabaseQuery(database, {
        context: operation.context,
        attachmentId: operation.attachmentId,
        expectedAttachmentGeneration: operation.expectedAttachmentGeneration,
      });
  }
}

function executeAttachment(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.attachment") throw new TypeError("wrong attachment operation");
  try {
    const result = executeAttachmentDatabaseOperation(request.operation, request.now);
    respond({ type: "authority.attachment-result", requestId: request.requestId, result });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AttachmentAuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithStorageFailure(request.requestId, error, "Attachment authority failed");
  }
}

async function executeTenantAdministration(request: AuthorityWorkerRequest): Promise<void> {
  if (request.type !== "authority.tenant-administration") {
    throw new TypeError("executeTenantAdministration received the wrong request type");
  }
  try {
    const result = await executeTenantAdministrationAuthorityOperation(
      requireAuthorityTransactionDatabase(),
      request.operation,
      {
        ...(isAuthorityWorkerData(workerData) &&
          workerData.deploymentProviderDisclosure !== undefined
          ? { provider: workerData.deploymentProviderDisclosure } : {}),
      },
    );
    respond({ type: "authority.tenant-administration-result", requestId: request.requestId, result });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    respondWithStorageFailure(
      request.requestId,
      error,
      "Tenant administration authority operation failed",
    );
  }
}

function executeRoomAssignment(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.room-assignment") {
    throw new TypeError("executeRoomAssignment received the wrong request type");
  }
  try {
    const result = executeRoomAssignmentAuthorityOperation(
      requireAuthorityTransactionDatabase(),
      request.operation,
      isAuthorityWorkerData(workerData) &&
          workerData.deploymentProviderDisclosure?.credentialReadiness === "ready"
        ? "ready"
        : "noauth",
    );
    respond({ type: "authority.room-assignment-result", requestId: request.requestId, result });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    respondWithStorageFailure(
      request.requestId,
      error,
      "Room Assignment authority operation failed",
    );
  }
}

async function executeAgentSettings(request: AuthorityWorkerRequest): Promise<void> {
  if (request.type !== "authority.agent-settings") {
    throw new TypeError("executeAgentSettings received the wrong request type");
  }
  try {
    const result = await executeAgentSettingsWorkerOperation(
      requireAuthorityTransactionDatabase(),
      { version: 1, context: request.context, frame: request.frame, now: request.now },
      isAuthorityWorkerData(workerData) ? workerData.deploymentProviderDisclosure : undefined,
    );
    respond({ type: "authority.agent-settings-result", requestId: request.requestId, result });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    respondWithStorageFailure(request.requestId, error, "Agent Settings authority operation failed");
  }
}

function submitHumanMessage(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.message-submit") throw new TypeError("wrong message submit");
  try {
    const receipt = submitHumanMessageDatabaseCommand(
      requireAuthorityTransactionDatabase(),
      {
        context: request.context,
        message: request.message,
        now: request.now,
        beforeApply: () => requireNoMessageRepairBarrier(request.message.roomId, request.now),
      },
    );
    respond({ type: "authority.message-submitted", requestId: request.requestId, receipt });
  } catch (error: unknown) {
    respondMessageAuthorityFailure(request.requestId, error, "Message submit failed");
  }
}

function reviseHumanMessage(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.message-revise") throw new TypeError("wrong message revision");
  try {
    const receipt = reviseHumanMessageDatabaseCommand(
      requireAuthorityTransactionDatabase(),
      {
        context: request.context,
        command: request.command,
        now: request.now,
        beforeApply: () => requireNoMessageRepairBarrier(request.command.roomId, request.now),
      },
    );
    respond({ type: "authority.message-revised", requestId: request.requestId, receipt });
  } catch (error: unknown) {
    respondMessageAuthorityFailure(request.requestId, error, "Message revision failed");
  }
}

function recallHumanMessage(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.message-recall") throw new TypeError("wrong message recall");
  try {
    const receipt = recallHumanMessageDatabaseCommand(
      requireAuthorityTransactionDatabase(),
      {
        context: request.context,
        command: request.command,
        now: request.now,
        beforeApply: () => requireNoMessageRepairBarrier(request.command.roomId, request.now),
      },
    );
    respond({ type: "authority.message-recalled", requestId: request.requestId, receipt });
  } catch (error: unknown) {
    respondMessageAuthorityFailure(request.requestId, error, "Message recall failed");
  }
}

function commitAgentMessage(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.agent-message-commit") {
    throw new TypeError("wrong Agent message commit");
  }
  try {
    const receipt = commitAgentMessageDatabaseCommand(
      requireAuthorityTransactionDatabase(),
      {
        context: request.context,
        command: request.command,
        now: request.now,
        beforeApply: () => requireNoMessageRepairBarrier(request.command.roomId, request.now),
      },
    );
    respond({ type: "authority.agent-message-committed", requestId: request.requestId, receipt });
  } catch (error: unknown) {
    respondMessageAuthorityFailure(request.requestId, error, "Agent message commit failed");
  }
}

function readMessageHistory(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.message-history") throw new TypeError("wrong message history");
  try {
    const page = readMessageHistoryDatabaseQuery(
      requireAuthorityTransactionDatabase(), request.context, request.query, request.now,
    );
    respond({ type: "authority.message-history", requestId: request.requestId, page });
  } catch (error: unknown) {
    respondMessageAuthorityFailure(request.requestId, error, "Message history failed");
  }
}

function readMessageRevisions(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.message-revisions") {
    throw new TypeError("wrong message revisions");
  }
  try {
    const page = readMessageRevisionsDatabaseQuery(
      requireAuthorityTransactionDatabase(), request.context, request.query, request.now,
    );
    respond({ type: "authority.message-revisions", requestId: request.requestId, page });
  } catch (error: unknown) {
    respondMessageAuthorityFailure(request.requestId, error, "Message revisions failed");
  }
}

function executeRuntime(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.runtime") {
    throw new TypeError("executeRuntime received the wrong request type");
  }
  try {
    const result = executeRuntimeAuthorityOperation(
      requireAuthorityTransactionDatabase(),
      request.operation,
    );
    respond({
      type: "authority.runtime-result",
      requestId: request.requestId,
      result: runtimeResultAsJson(result),
    });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority runtime operation failed",
    );
  }
}

function executeContext(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.context") {
    throw new TypeError("executeContext received the wrong request type");
  }
  try {
    if (request.operation.type === "context.finalize-agent-message") {
      const operation = request.operation;
      const receipt = commitAgentMessageDatabaseCommand(
        requireAuthorityTransactionDatabase(),
        {
          context: operation.context,
          command: operation.command,
          now: operation.now,
          beforeApply: () => requireNoMessageRepairBarrier(
            operation.command.roomId,
            operation.now,
          ),
          contextCitations: {
            snapshotId: operation.snapshotId,
            snapshotGeneration: operation.snapshotGeneration,
            citationLabels: operation.citationLabels,
          },
        },
      );
      respond({
        type: "authority.context-result",
        requestId: request.requestId,
        result: {
          kind: "context-finalized",
          receipt,
          execution: readContextFinalExecution(
            requireAuthorityTransactionDatabase(),
            operation.context.executionId,
          ),
        } as unknown as JsonValue,
      });
      return;
    }
    const result = executeContextSnapshotAuthorityOperation(
      requireAuthorityTransactionDatabase(),
      request.operation,
      {
        providerAuthenticated: isAuthorityWorkerData(workerData) &&
          workerData.deploymentProviderDisclosure?.credentialReadiness === "ready",
      },
    );
    respond({
      type: "authority.context-result",
      requestId: request.requestId,
      result: contextSnapshotResultAsJson(result) as unknown as JsonValue,
    });
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof ContextSnapshotDatabaseError || error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithError(
      request.requestId,
      "context_storage_unavailable",
      "Authority context operation failed",
    );
  }
}

function executeRoute(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.route") {
    throw new TypeError("executeRoute received the wrong request type");
  }
  try {
    const openedDatabase = requireAuthorityTransactionDatabase();
    const roomRows = request.operation.type === "route.claim"
      ? openedDatabase.prepare(
          `SELECT room_id AS roomId FROM messages WHERE id = ?`,
        ).all(request.operation.sourceMessageId)
      : request.operation.type === "route.handoff.claim"
        ? [{ roomId: request.operation.roomId }]
      : request.operation.type === "route.recover"
        ? openedDatabase.prepare(
            `SELECT DISTINCT room_id AS roomId FROM route_jobs WHERE status = 'running'`,
          ).all()
      : request.operation.type === "route.handoff.recover"
        ? openedDatabase.prepare(
            `SELECT DISTINCT room_id AS roomId FROM routed_agent_invocation_intents
             WHERE status = 'pending'`,
          ).all()
        : openedDatabase.prepare(
            `SELECT room_id AS roomId FROM route_jobs WHERE id = ?`,
          ).all(request.operation.routeJobId);
    const roomIds = roomRows.map((row) => row.roomId).filter(
      (roomId): roomId is string => typeof roomId === "string",
    );
    const result = executeRouteAuthorityOperation(
      openedDatabase,
      request.operation,
    );
    respond({
      type: "authority.route-result",
      requestId: request.requestId,
      result: routeResultAsJson(result),
    });
    if (roomIds.length > 0) {
      repairs.preemptAfterCommit({
        roomIds,
        catalogPrincipalIds: [],
        familyIds: [],
        code: "snapshot_stale",
        now: request.operation.now,
      });
    }
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithStorageFailure(request.requestId, error, "Authority route operation failed");
  }
}

function executeBall(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.ball") throw new TypeError("executeBall received the wrong request type");
  try {
    const result = executeBallAuthorityOperation(requireAuthorityTransactionDatabase(), request.operation);
    respond({
      type: "authority.ball-result", requestId: request.requestId, result: ballResultAsJson(result),
    });
    if (request.operation.type === "ball.scan-overdue" && result.kind === "ball-overdue-scan" &&
        (result.agentTriggers.length > 0 || result.reminders.length > 0)) {
      repairs.preemptAfterCommit({
        roomIds: [request.operation.roomId], catalogPrincipalIds: [], familyIds: [],
        code: "snapshot_stale", now: request.operation.now,
      });
    }
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithStorageFailure(request.requestId, error, "Authority ball operation failed");
  }
}

function executeMemory(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.memory") throw new TypeError("executeMemory received the wrong request type");
  try {
    const result = executeMemoryAuthorityOperation(requireAuthorityTransactionDatabase(), request.operation);
    respond({
      type: "authority.memory-result", requestId: request.requestId, result: memoryResultAsJson(result),
    });
    const roomId = request.operation.type === "memory.public"
      ? request.operation.request.roomId
      : request.operation.type === "memory.discover"
        ? undefined
        : request.operation.type === "memory.source-authorize" || request.operation.type === "memory.complete" ||
            request.operation.type === "memory.fail" || request.operation.type === "memory.abandon"
          ? request.operation.batch.roomId
          : request.operation.roomId;
    if (roomId !== undefined && request.operation.type !== "memory.readiness" &&
        request.operation.type !== "memory.source-authorize" && request.operation.type !== "memory.record-known") {
      repairs.preemptAfterCommit({
        roomIds: [roomId], catalogPrincipalIds: [], familyIds: [],
        code: "snapshot_stale", now: "now" in request.operation ? request.operation.now : Date.now(),
      });
    }
  } catch (error: unknown) {
    if (handleRollbackFatal(request.requestId, error)) return;
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithStorageFailure(request.requestId, error, "Authority memory operation failed");
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
    respondWithStorageFailure(request.requestId, error, "Authority history query failed");
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
  } catch (error: unknown) {
    respondWithStorageFailure(request.requestId, error, "Authority actor query failed");
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
  } catch (error: unknown) {
    respondWithStorageFailure(request.requestId, error, "Authority room query failed");
  }
}

function readRoomGovernance(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.read-room-governance") {
    throw new TypeError("readRoomGovernance received the wrong request type");
  }
  try {
    const governance = readRoomGovernanceDatabaseQuery(
      requireAuthorityDatabase(), request.context, request.roomId, request.now,
    );
    respond({ type: "authority.room-governance", requestId: request.requestId, governance });
  } catch (error: unknown) {
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithStorageFailure(request.requestId, error, "Authority governance query failed");
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
    respondWithStorageFailure(request.requestId, error, "Authority room access query failed");
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
    respondWithStorageFailure(request.requestId, error, "Authority room audit query failed");
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
    respondWithStorageFailure(request.requestId, error, "Authority outbox query failed");
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
  } catch (error: unknown) {
    respondWithStorageFailure(
      request.requestId,
      error,
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
  } catch (error: unknown) {
    respondWithStorageFailure(request.requestId, error, "Authority outbox update failed");
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
  } catch (error: unknown) {
    respondWithStorageFailure(request.requestId, error, "Authority outbox update failed");
  }
}

function listRoomCacheInvalidations(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.room-cache-invalidation-list") {
    throw new TypeError("listRoomCacheInvalidations received the wrong request type");
  }
  try {
    const intents = listCommittedRoomCacheInvalidationIntentsDatabaseQuery(
      requireAuthorityDatabase(),
      request.limit,
    );
    respond({
      type: "authority.room-cache-invalidations",
      requestId: request.requestId,
      intents,
    });
  } catch (error: unknown) {
    if (error instanceof AuthorityDatabaseError) {
      respondWithError(request.requestId, error.code, error.message);
      return;
    }
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority room cache invalidation query failed",
    );
  }
}

function markRoomCacheInvalidationCompleted(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.room-cache-invalidation-completed") {
    throw new TypeError("markRoomCacheInvalidationCompleted received the wrong request type");
  }
  try {
    markRoomCacheInvalidationCompletedDatabaseCommand(
      requireAuthorityTransactionDatabase(),
      request.invalidationIntentId,
    );
    respond({
      type: "authority.room-cache-invalidation-updated",
      requestId: request.requestId,
    });
  } catch (error: unknown) {
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority room cache invalidation update failed",
    );
  }
}

function markRoomCacheInvalidationFailed(request: AuthorityWorkerRequest): void {
  if (request.type !== "authority.room-cache-invalidation-failed") {
    throw new TypeError("markRoomCacheInvalidationFailed received the wrong request type");
  }
  try {
    markRoomCacheInvalidationFailedDatabaseCommand(
      requireAuthorityTransactionDatabase(),
      request.invalidationIntentId,
      request.errorCode,
    );
    respond({
      type: "authority.room-cache-invalidation-updated",
      requestId: request.requestId,
    });
  } catch (error: unknown) {
    respondWithStorageFailure(
      request.requestId,
      error,
      "Authority room cache invalidation update failed",
    );
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
    respondWithStorageFailure(request.requestId, error, "Authority room sync failed");
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
    respondWithStorageFailure(
      request.requestId,
      error,
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
    respondWithStorageFailure(
      request.requestId,
      error,
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
    case "authority.sessions-list":
      listSessions(value);
      return;
    case "authority.session-revoke-target":
      revokeTargetSession(value);
      return;
    case "authority.execute-human":
      executeHuman(value);
      return;
    case "authority.execute-human-governance":
      executeHumanGovernance(value);
      return;
    case "authority.departure-conflicts":
      readDepartureConflicts(value);
      return;
    case "authority.execute-agent":
      executeAgent(value);
      return;
    case "authority.attachment":
      executeAttachment(value);
      return;
    case "authority.tenant-administration":
      await executeTenantAdministration(value);
      return;
    case "authority.room-assignment":
      executeRoomAssignment(value);
      return;
    case "authority.agent-settings":
      await executeAgentSettings(value);
      return;
    case "authority.message-submit":
      submitHumanMessage(value);
      return;
    case "authority.message-revise":
      reviseHumanMessage(value);
      return;
    case "authority.message-recall":
      recallHumanMessage(value);
      return;
    case "authority.agent-message-commit":
      commitAgentMessage(value);
      return;
    case "authority.message-history":
      readMessageHistory(value);
      return;
    case "authority.message-revisions":
      readMessageRevisions(value);
      return;
    case "authority.runtime":
      executeRuntime(value);
      return;
    case "authority.context":
      executeContext(value);
      return;
    case "authority.route":
      executeRoute(value);
      return;
    case "authority.ball":
      executeBall(value);
      return;
    case "authority.memory":
      executeMemory(value);
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
    case "authority.read-room-governance":
      readRoomGovernance(value);
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
    case "authority.room-cache-invalidation-list":
      listRoomCacheInvalidations(value);
      return;
    case "authority.room-cache-invalidation-completed":
      markRoomCacheInvalidationCompleted(value);
      return;
    case "authority.room-cache-invalidation-failed":
      markRoomCacheInvalidationFailed(value);
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
