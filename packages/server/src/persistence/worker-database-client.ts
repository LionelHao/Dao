import type { BigIntStats } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  Actor,
  DepartureConflictList,
  HumanMessageSubmit,
  ManagedRoom,
  Message,
  RoomSyncRequest,
  RoomSyncResult,
  RoomGovernanceView,
  SnapshotCompleted,
  SnapshotVersion,
} from "@native-im/core";
import type { RoomAuditRecord } from "../room-lifecycle.js";
import {
  isAuthorityWorkerResponse,
  isAuthorityWorkerErrorCode,
  type AuthorityWorkerErrorCode,
  type AuthorityWorkerRequest,
  type AuthorityWorkerResponse,
  type ContextWorkerOperation,
} from "./worker-protocol.js";
import type {
  LegacyImportInspection,
  LegacyImportPaths,
  LegacyImportRecovery,
  LegacyImportResult,
} from "./legacy-importer.js";
import type {
  AgentCollaborationCommand,
  AgentMessageCommitCommand,
  AgentMessageCommitReceipt,
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  ClosedRoomGovernanceAcknowledgement,
  ClosedRoomGovernanceMutationCommand,
  CommandAcknowledgement,
  HashedSessionIssue,
  HashedSessionRotation,
  HumanCollaborationCommand,
  HumanMessageSubmissionReceipt,
  InternalAgentCommandContext,
  IssuedSessionRecord,
  PublicSession,
  OutboxDelivery,
  OutboxDeliveryFailureReason,
  OutboxDispatchCandidate,
  MessageHistoryPage,
  MessageHistoryQuery,
  MessageRecallCommand,
  MessageRecallReceipt,
  MessageRevisionCommand,
  MessageRevisionPage,
  MessageRevisionQuery,
  MessageRevisionReceipt,
  RoomGovernanceCommand,
  RepairScope,
  StreamingRepairLease,
  SnapshotRevalidationRequest,
} from "./contracts.js";
import type { DeploymentProviderDisclosure } from
  "../tenant-administration/authority-service.js";
import type {
  TenantAdministrationOperation,
  TenantAdministrationResult,
} from "../tenant-administration/authority-protocol.js";
import type {
  RoomAssignmentOperation,
  RoomAssignmentResult,
} from "../room-assignment/authority-protocol.js";
import {
  toAgentMessageWorkerContext,
  type InternalAgentMessageCommitContext,
} from "../message-authority/internal-message-capability.js";
import type { RuntimeAuthorityOperation } from "../agent-runtime/runtime-authority-protocol.js";
import type { RouteAuthorityOperation } from "../route-runtime/route-authority-protocol.js";
import type { MemoryAuthorityOperation } from "../room-memory/authority-protocol.js";
import type {
  BallAuthorityOperation,
  BallDeadlinePolicy,
} from "../ball-runtime/ball-authority-protocol.js";
import type {
  CommittedRoomCacheInvalidationIntent,
  RoomCacheInvalidationIntentAuthority,
} from "../access/room-cache-invalidation-port.js";
import type {
  AttachmentDatabaseOperation,
  AttachmentDatabaseOperationResult,
} from "../attachment-authority/database-contracts.js";
import {
  ROOM_SYNC_DEFAULT_LIMIT,
  toAgentWorkerCommandContext,
} from "./contracts.js";

export interface CreateWorkerDatabaseClientOptions {
  readonly databasePath: string;
  readonly sharedAuthorityRecovery?: {
    readonly ballPolicy: BallDeadlinePolicy;
    readonly maxOfflineReadLeaseMs: number;
  };
  readonly deploymentProviderDisclosure?: DeploymentProviderDisclosure;
}

export interface AuthoritySchemaInspection {
  readonly version: 20;
}

export interface WorkerDatabaseClient {
  inspectSchema(): Promise<AuthoritySchemaInspection>;
  executeAttachment(
    operation: AttachmentDatabaseOperation,
    now: number,
  ): Promise<AttachmentDatabaseOperationResult>;
  importLegacyState(paths: LegacyImportPaths): Promise<LegacyImportResult>;
  inspectLegacyImport(): Promise<LegacyImportInspection>;
  registerActors(actors: readonly Actor[]): Promise<number>;
  issueSession(input: HashedSessionIssue): Promise<IssuedSessionRecord>;
  authenticateSession(
    accessTokenHash: string,
    now: number,
  ): Promise<AuthenticatedSessionContext>;
  validateSessionRefresh(
    currentRefreshTokenHash: string,
    expectedPrincipal: { readonly accountId: string; readonly actorId: string } | undefined,
    now: number,
  ): Promise<void>;
  rotateSession(input: HashedSessionRotation): Promise<IssuedSessionRecord>;
  revokeSession(accessTokenHash: string, now: number): Promise<void>;
  listSessions(accessTokenHash: string, now: number): Promise<readonly PublicSession[]>;
  revokeTargetSession(
    accessTokenHash: string,
    publicSessionId: string,
    now: number,
  ): Promise<void>;
  executeHuman(
    context: AuthenticatedCommandContext,
    command: HumanCollaborationCommand | RoomGovernanceCommand,
    now: number,
    invitationSecret?: {
      readonly tokenHash: string;
      readonly sealedToken: string;
    },
  ): Promise<CommandAcknowledgement>;
  executeHumanGovernance(
    context: AuthenticatedCommandContext,
    command: ClosedRoomGovernanceMutationCommand,
    now: number,
  ): Promise<ClosedRoomGovernanceAcknowledgement>;
  readDepartureConflicts(
    context: AuthenticatedSessionContext,
    input: { readonly roomId: string; readonly targetActorId: string },
    now: number,
  ): Promise<DepartureConflictList>;
  executeAgent(
    context: InternalAgentCommandContext,
    command: AgentCollaborationCommand,
    now: number,
  ): Promise<CommandAcknowledgement>;
}

export interface MessageAuthorityWorkerDatabaseClient {
  submitHumanMessage(
    context: AuthenticatedCommandContext,
    message: HumanMessageSubmit,
    now: number,
  ): Promise<HumanMessageSubmissionReceipt>;
  reviseHumanMessage(
    context: AuthenticatedCommandContext,
    command: MessageRevisionCommand,
    now: number,
  ): Promise<MessageRevisionReceipt>;
  recallHumanMessage(
    context: AuthenticatedCommandContext,
    command: MessageRecallCommand,
    now: number,
  ): Promise<MessageRecallReceipt>;
  commitAgentMessage(
    context: InternalAgentMessageCommitContext,
    command: AgentMessageCommitCommand,
    now: number,
  ): Promise<AgentMessageCommitReceipt>;
  readMessageHistory(
    context: AuthenticatedSessionContext,
    query: MessageHistoryQuery,
    now: number,
  ): Promise<MessageHistoryPage>;
  readMessageRevisions(
    context: AuthenticatedSessionContext,
    query: MessageRevisionQuery,
    now: number,
  ): Promise<MessageRevisionPage>;
}

export interface WorkerDatabaseClient {
  readHistory(
    context: AuthenticatedSessionContext,
    roomId: string,
    now: number,
  ): Promise<readonly Message[]>;
  syncRoom(
    context: AuthenticatedSessionContext,
    request: RoomSyncRequest,
    now: number,
  ): Promise<RoomSyncResult>;
  compactRoomStream(
    roomId: string,
    retainedFromSeq: number,
  ): Promise<{ readonly retainedFromSeq: number; readonly headSeq: number }>;
  revalidateSnapshot(
    validation: SnapshotRevalidationRequest,
    now: number,
  ): Promise<void>;
  acquireStreamingRepair(
    context: AuthenticatedSessionContext,
    scope: RepairScope,
    now: number,
  ): Promise<StreamingRepairLease>;
  registerStreamingRepair(
    snapshotId: string,
    checksum: string,
    pageCount: number,
    now: number,
  ): Promise<StreamingRepairLease>;
  authorizeStreamingRepairPage(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    page: number,
    now: number,
  ): Promise<StreamingRepairLease>;
  completeStreamingRepair(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    version: SnapshotVersion,
    checksum: string,
    now: number,
  ): Promise<SnapshotCompleted>;
  releaseStreamingRepair(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    now: number,
  ): Promise<void>;
  readActor(actorId: string): Promise<Actor | undefined>;
  readRoom(roomId: string): Promise<ManagedRoom | undefined>;
  readRoomGovernance(
    context: AuthenticatedSessionContext,
    roomId: string,
    now: number,
  ): Promise<RoomGovernanceView>;
  canAccessRoom(
    context: AuthenticatedSessionContext,
    roomId: string,
    now: number,
  ): Promise<boolean>;
  readRoomAudit(
    context: AuthenticatedSessionContext,
    roomId: string,
    now: number,
  ): Promise<readonly RoomAuditRecord[]>;
  listPendingOutbox(limit: number, now: number): Promise<readonly OutboxDelivery[]>;
  authorizeOutboxCandidate(
    deliveryId: string,
    candidate: OutboxDispatchCandidate,
    now: number,
  ): Promise<boolean>;
  markOutboxDispatched(deliveryId: string, now: number): Promise<void>;
  markOutboxFailed(
    deliveryId: string,
    reason: OutboxDeliveryFailureReason,
  ): Promise<void>;
  listCommittedRoomCacheInvalidations(
    limit: number,
  ): Promise<readonly CommittedRoomCacheInvalidationIntent[]>;
  markRoomCacheInvalidationCompleted(invalidationIntentId: string): Promise<void>;
  markRoomCacheInvalidationFailed(
    invalidationIntentId: string,
    errorCode: "purge_failed" | "authority_unavailable",
  ): Promise<void>;
  executeRuntime(operation: RuntimeAuthorityOperation): Promise<unknown>;
  executeRoute(operation: RouteAuthorityOperation): Promise<unknown>;
  executeBall(operation: BallAuthorityOperation): Promise<unknown>;
  executeMemory(operation: MemoryAuthorityOperation): Promise<unknown>;
  executeTenantAdministration(
    operation: TenantAdministrationOperation,
  ): Promise<TenantAdministrationResult>;
  executeRoomAssignment(operation: RoomAssignmentOperation): Promise<RoomAssignmentResult>;
  close(): Promise<void>;
}

export type CompleteWorkerDatabaseClient = WorkerDatabaseClient &
  MessageAuthorityWorkerDatabaseClient & ContextAuthorityWorkerDatabaseClient;

export interface ContextAuthorityWorkerDatabaseClient {
  executeContext(operation: ContextWorkerOperation): Promise<unknown>;
}

export interface AuthorityWorkerTransport {
  postMessage(message: AuthorityWorkerRequest): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "messageerror", listener: (error: Error) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
  terminate(): Promise<number>;
}

export class AuthorityWorkerClientError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly details?: DepartureConflictList;

  constructor(
    readonly code: AuthorityWorkerClientErrorCode,
    message: string,
    details?: DepartureConflictList,
  ) {
    super(message);
    this.name = "AuthorityWorkerClientError";
    this.status = authorityWorkerClientErrorStatus(code);
    this.retryAfterMs = code === "repair_barrier_active" ? 250 : undefined;
    if (details !== undefined) this.details = details;
  }

}

type AuthorityWorkerClientLocalErrorCode =
  | "authority_coordinator_exists"
  | "authority_worker_error"
  | "authority_worker_exited"
  | "authority_worker_message_error"
  | "authority_worker_not_ready"
  | "authority_worker_post_failed"
  | "authority_worker_protocol_error";

type AuthorityWorkerClientPublicErrorCode = Exclude<
  AuthorityWorkerErrorCode,
  | "authority_operation_unavailable"
  | "authority_storage_poisoned"
  | "authority_storage_transient"
>;

export type AuthorityWorkerClientErrorCode =
  | AuthorityWorkerClientPublicErrorCode
  | AuthorityWorkerClientLocalErrorCode;

function authorityWorkerClientErrorStatus(
  code: AuthorityWorkerClientErrorCode,
): 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 503 {
  switch (code) {
    case "agent_permissions_invalid":
    case "agent_required":
    case "calibration_source_invalid":
    case "invalid_parameters":
    case "invalid_request":
    case "invalid_chunk":
    case "invitee_required":
      return 400;
    case "invalid_token":
    case "token_expired":
    case "unauthenticated":
      return 401;
    case "agent_missing_permission":
    case "administrator_required":
    case "confirmation_forbidden":
    case "permission_denied":
    case "identity_forbidden":
    case "invitation_forbidden":
    case "room_forbidden":
    case "attachment_forbidden":
    case "session_revoked":
    case "snapshot_family_revoked":
    case "context_forbidden":
      return 403;
    case "invitation_not_found":
    case "administrator_not_found":
    case "assignment_not_found":
    case "profile_not_found":
    case "member_not_found":
    case "message_not_found":
    case "light_task_not_found":
    case "open_item_not_found":
    case "memory_not_found":
    case "memory_source_not_found":
    case "execution_not_found":
    case "route_job_not_found":
    case "room_member_not_found":
    case "room_not_found":
    case "snapshot_not_found":
    case "session_not_found":
      return 404;
    case "actor_conflict":
    case "administrator_already_exists":
    case "bootstrap_conflict":
    case "authority_already_initialized":
    case "authority_coordinator_exists":
    case "execution_conflict":
    case "route_conflict":
    case "session_id_conflict":
    case "session_limit_reached":
    case "execution_not_running":
    case "idempotency_conflict":
    case "last_administrator_required":
    case "profile_state_conflict":
    case "revision_conflict":
    case "attachment_already_bound":
    case "generation_conflict":
    case "attachment_not_ready":
    case "upload_offset_conflict":
    case "agent_final_immutable":
    case "message_version_conflict":
    case "memory_version_conflict":
    case "memory_recovery_generation_conflict":
    case "invitation_consumed":
    case "invitation_pending":
    case "room_archived":
    case "room_compaction_blocked":
    case "room_member_exists":
    case "room_owner_required":
    case "ownership_transfer_required":
    case "room_revision_conflict":
    case "snapshot_stale":
    case "confirmation_replayed":
    case "confirmation_rejected":
    case "departure_blocked":
    case "grant_revoked":
    case "context_generation_conflict":
    case "context_snapshot_conflict":
      return 409;
    case "snapshot_forbidden":
    case "role_forbidden":
      return 403;
    case "snapshot_expired":
    case "confirmation_expired":
    case "protocol_upgrade_required":
    case "upload_expired":
    case "attachment_gone":
    case "memory_source_gone":
    case "context_snapshot_invalidated":
    case "context_source_gone":
    case "assignment_gone":
      return 410;
    case "attachment_too_large":
    case "chunk_too_large":
      return 413;
    case "attachment_type_unsupported":
    case "type_mismatch":
      return 415;
    case "attachment_malformed":
    case "encrypted_pdf":
    case "archive_bomb":
    case "image_bomb":
      return 422;
    case "snapshot_busy":
    case "agent_queue_full":
    case "attachment_capacity_limited":
    case "memory_capacity_limited":
    case "context_capacity_limited":
    case "profile_fanout_capacity_limited":
      return 429;
    case "scanner_unavailable":
    case "extractor_unavailable":
    case "ocr_unavailable":
    case "authority_not_initialized":
    case "administrator_configuration_unavailable":
    case "authority_worker_closed":
    case "authority_worker_error":
    case "authority_worker_exited":
    case "authority_worker_message_error":
    case "authority_worker_not_ready":
    case "authority_worker_post_failed":
    case "authority_worker_protocol_error":
    case "invitation_secret_unavailable":
    case "legacy_import_failed":
    case "legacy_import_unavailable":
    case "storage_unavailable":
    case "memory_unavailable":
    case "memory_dependency_unavailable":
    case "repair_barrier_active":
    case "dependency_unavailable":
    case "configuration_unsupported":
    case "provider_configuration_unavailable":
    case "context_storage_unavailable":
      return 503;
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

interface PendingRequest {
  readonly requestType: AuthorityWorkerRequest["type"];
  readonly resolve: (response: AuthorityWorkerResponse) => void;
  readonly reject: (error: AuthorityWorkerClientError) => void;
}

type AuthorityWorkerCommand = AuthorityWorkerRequest extends infer Request
  ? Request extends AuthorityWorkerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

type ClientState = "initializing" | "open" | "closing" | "closed" | "failed";

const authorityCoordinatorPaths = new Set<string>();
const MAX_DATABASE_SYMLINK_DEPTH = 32;
const MAX_RECOVERY_MANIFEST_BYTES = 1_024n;
const RECOVERY_NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function databasePathResolutionError(): AuthorityWorkerClientError {
  return new AuthorityWorkerClientError(
    "storage_unavailable",
    "Authority database path could not be resolved",
  );
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const actualKeys = (ownKeys as string[]).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function roomSyncResultMatchesRequest(
  request: RoomSyncRequest,
  result: RoomSyncResult,
): boolean {
  if (result.requestId !== request.requestId) {
    return false;
  }
  if (result.mode === "repair_required") {
    if (request.cursor === undefined) {
      return result.reason === "cursor_absent";
    }
    return ((result.reason === "cursor_expired" &&
      request.cursor.afterSeq < result.retainedFromSeq - 1) ||
      result.reason === "operational_projection_changed") &&
      result.watermark >= request.cursor.afterSeq;
  }
  if (
    request.cursor === undefined ||
    (request.cursor.watermark !== undefined &&
      result.watermark !== request.cursor.watermark) ||
    result.nextCursor.roomId !== request.roomId ||
    result.watermark < request.cursor.afterSeq ||
    result.events.length > (request.limit ?? ROOM_SYNC_DEFAULT_LIMIT)
  ) {
    return false;
  }
  const firstEvent = result.events[0];
  return firstEvent === undefined
    ? result.nextCursor.afterSeq === request.cursor.afterSeq
    : firstEvent.streamSeq === request.cursor.afterSeq + 1;
}

async function controlledLegacyRecovery(
  databasePath: string,
  databaseMetadata: BigIntStats | undefined,
): Promise<LegacyImportRecovery | undefined> {
  let entries: readonly string[];
  try {
    entries = await readdir(dirname(databasePath));
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw databasePathResolutionError();
  }
  const recoveryPrefix = `.${basename(databasePath)}.`;
  const recoverySuffix = ".legacy-import.recovery.json";
  const recoveryFileNames = entries.filter(
    (entry) => entry.startsWith(recoveryPrefix) && entry.endsWith(recoverySuffix),
  );
  if (recoveryFileNames.length === 0) {
    return undefined;
  }
  if (recoveryFileNames.length !== 1) {
    throw databasePathResolutionError();
  }

  const recoveryFileName = recoveryFileNames[0];
  if (recoveryFileName === undefined) {
    throw databasePathResolutionError();
  }
  const nonce = recoveryFileName.slice(
    recoveryPrefix.length,
    -recoverySuffix.length,
  );
  if (!RECOVERY_NONCE_PATTERN.test(nonce)) {
    throw databasePathResolutionError();
  }
  const recoveryBase = `.${basename(databasePath)}.${nonce}.legacy-import`;
  const stagingFileName = `${recoveryBase}.sqlite`;
  const stagingFilePath = join(dirname(databasePath), stagingFileName);
  const recoveryFilePath = join(dirname(databasePath), recoveryFileName);

  try {
    const [recoveryMetadata, stagingMetadata] = await Promise.all([
      lstat(recoveryFilePath, { bigint: true }),
      lstatIfPresent(stagingFilePath),
    ]);
    let state: LegacyImportRecovery["state"];
    let authorityMetadata: BigIntStats;
    if (databaseMetadata === undefined) {
      if (
        stagingMetadata === undefined ||
        !stagingMetadata.isFile() ||
        stagingMetadata.nlink !== 1n
      ) {
        throw databasePathResolutionError();
      }
      state = "pre-link";
      authorityMetadata = stagingMetadata;
    } else if (
      databaseMetadata.isFile() &&
      databaseMetadata.nlink === 2n &&
      stagingMetadata !== undefined &&
      stagingMetadata.isFile() &&
      stagingMetadata.nlink === 2n &&
      stagingMetadata.dev === databaseMetadata.dev &&
      stagingMetadata.ino === databaseMetadata.ino &&
      stagingMetadata.uid === databaseMetadata.uid
    ) {
      state = "linked";
      authorityMetadata = databaseMetadata;
    } else if (
      databaseMetadata.isFile() &&
      databaseMetadata.nlink === 1n &&
      stagingMetadata === undefined
    ) {
      state = "post-unlink";
      authorityMetadata = databaseMetadata;
    } else {
      throw databasePathResolutionError();
    }

    if (
      !recoveryMetadata.isFile() ||
      recoveryMetadata.nlink !== 1n ||
      recoveryMetadata.size <= 0n ||
      recoveryMetadata.size > MAX_RECOVERY_MANIFEST_BYTES ||
      (recoveryMetadata.mode & 0o7777n) !== 0o600n ||
      recoveryMetadata.dev !== authorityMetadata.dev ||
      recoveryMetadata.uid !== authorityMetadata.uid
    ) {
      throw databasePathResolutionError();
    }
    const value = JSON.parse(await readFile(recoveryFilePath, "utf8")) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "version",
        "databaseFileName",
        "stagingFileName",
        "nonce",
      ]) ||
      value.version !== 1 ||
      value.databaseFileName !== basename(databasePath) ||
      value.stagingFileName !== stagingFileName ||
      value.nonce !== nonce
    ) {
      throw databasePathResolutionError();
    }
    return { stagingFilePath, recoveryFilePath, nonce, state };
  } catch (error: unknown) {
    if (error instanceof AuthorityWorkerClientError) {
      throw error;
    }
    throw databasePathResolutionError();
  }
}

async function lstatIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

interface CanonicalDatabaseTarget {
  readonly databasePath: string;
  readonly recovery?: LegacyImportRecovery;
}

async function canonicalizeDatabasePath(
  absolutePath: string,
  visitedSymlinks: Set<string>,
  depth: number,
): Promise<CanonicalDatabaseTarget> {
  if (depth > MAX_DATABASE_SYMLINK_DEPTH) {
    throw databasePathResolutionError();
  }

  let canonicalPath: string | undefined;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    // A dangling final symlink needs lstat/readlink before the nonexistent fallback.
  }
  if (canonicalPath !== undefined) {
    try {
      const pathMetadata = await stat(canonicalPath, { bigint: true });
      const recovery = await controlledLegacyRecovery(canonicalPath, pathMetadata);
      if (recovery !== undefined) {
        return { databasePath: canonicalPath, recovery };
      }
      if (pathMetadata.isFile() && pathMetadata.nlink > 1n) {
        throw databasePathResolutionError();
      }
    } catch (error: unknown) {
      if (error instanceof AuthorityWorkerClientError) {
        throw error;
      }
      throw databasePathResolutionError();
    }
    return { databasePath: canonicalPath };
  }

  let pathMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    pathMetadata = await lstat(absolutePath);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) {
      throw databasePathResolutionError();
    }
    let canonicalParent: string;
    try {
      canonicalParent = await realpath(dirname(absolutePath));
    } catch {
      return { databasePath: absolutePath };
    }
    const databasePath = join(canonicalParent, basename(absolutePath));
    const recovery = await controlledLegacyRecovery(databasePath, undefined);
    return {
      databasePath,
      ...(recovery === undefined ? {} : { recovery }),
    };
  }

  if (!pathMetadata.isSymbolicLink()) {
    throw databasePathResolutionError();
  }
  if (visitedSymlinks.has(absolutePath)) {
    throw databasePathResolutionError();
  }
  visitedSymlinks.add(absolutePath);

  let linkTarget: string;
  try {
    linkTarget = await readlink(absolutePath);
  } catch {
    throw databasePathResolutionError();
  }
  return canonicalizeDatabasePath(
    resolve(dirname(absolutePath), linkTarget),
    visitedSymlinks,
    depth + 1,
  );
}

async function canonicalDatabasePath(
  databasePath: string,
): Promise<CanonicalDatabaseTarget> {
  return canonicalizeDatabasePath(resolve(databasePath), new Set<string>(), 0);
}

interface AuthorityCoordinatorReservation {
  readonly databasePath: string;
  readonly recovery?: LegacyImportRecovery;
  release(): void;
}

async function terminateTransport(worker: AuthorityWorkerTransport): Promise<boolean> {
  try {
    await worker.terminate();
    return true;
  } catch {
    return false;
  }
}

async function reserveAuthorityCoordinator(
  databasePath: string,
): Promise<AuthorityCoordinatorReservation> {
  const target = await canonicalDatabasePath(databasePath);
  const canonicalPath = target.databasePath;
  if (authorityCoordinatorPaths.has(canonicalPath)) {
    throw new AuthorityWorkerClientError(
      "authority_coordinator_exists",
      "Authority database coordinator already exists",
    );
  }
  authorityCoordinatorPaths.add(canonicalPath);

  let reserved = true;
  return {
    databasePath: canonicalPath,
    ...(target.recovery === undefined ? {} : { recovery: target.recovery }),
    release(): void {
      if (!reserved) {
        return;
      }
      reserved = false;
      authorityCoordinatorPaths.delete(canonicalPath);
    },
  };
}

function authorityWorkerUrl(): URL {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol !== "file:") {
    return pathToFileURL(
      resolve(process.cwd(), "packages/server/dist/persistence/authority-worker.js"),
    );
  }
  if (moduleUrl.pathname.endsWith(".ts")) {
    return new URL("../../dist/persistence/authority-worker.js", moduleUrl);
  }
  return new URL("./authority-worker.js", moduleUrl);
}

function createAuthorityWorker(
  options: CreateWorkerDatabaseClientOptions,
  recovery: LegacyImportRecovery | undefined,
  rollbackFailureForTest = false,
  transactionFaultPoint?: "after-domain-write" | "before-commit",
): AuthorityWorkerTransport {
  return new Worker(authorityWorkerUrl(), {
    workerData: {
      databasePath: options.databasePath,
      ...(options.sharedAuthorityRecovery === undefined
        ? {} : { sharedAuthorityRecovery: options.sharedAuthorityRecovery }),
      ...(options.deploymentProviderDisclosure === undefined
        ? {} : { deploymentProviderDisclosure: options.deploymentProviderDisclosure }),
      ...(recovery === undefined ? {} : { recovery }),
      ...(rollbackFailureForTest ? { rollbackFailureForTest: true } : {}),
      ...(transactionFaultPoint === undefined ? {} : { transactionFaultPoint }),
    },
  });
}

class WorkerDatabaseClientImplementation implements CompleteWorkerDatabaseClient {
  readonly #pending = new Map<string, PendingRequest>();
  readonly #worker: AuthorityWorkerTransport;
  readonly #releaseCoordinator: () => void;
  #nextRequestId = 1n;
  #state: ClientState = "initializing";
  #terminalError: AuthorityWorkerClientError | undefined;
  #closedError: AuthorityWorkerClientError | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(worker: AuthorityWorkerTransport, releaseCoordinator: () => void) {
    this.#worker = worker;
    this.#releaseCoordinator = releaseCoordinator;
    worker.on("message", (message: unknown) => this.#handleMessage(message));
    worker.on("messageerror", () => {
      this.#failTerminal(
        new AuthorityWorkerClientError(
          "authority_worker_message_error",
          "Authority worker response could not be deserialized",
        ),
      );
    });
    worker.on("error", () => {
      this.#failTerminal(
        new AuthorityWorkerClientError(
          "authority_worker_error",
          "Authority worker failed",
        ),
      );
    });
    worker.on("exit", (exitCode: number) => {
      this.#releaseCoordinator();
      if (this.#state === "closed") {
        return;
      }
      this.#failTerminal(
        new AuthorityWorkerClientError(
          "authority_worker_exited",
          `Authority worker exited before close acknowledgement (exit code ${exitCode})`,
        ),
      );
    });
  }

  async initialize(): Promise<void> {
    const response = await this.#send({ type: "authority.initialize" });
    if (response.type !== "authority.ready") {
      this.#failProtocol("Authority worker returned the wrong initialization response");
      throw this.#terminalError;
    }
    this.#state = "open";
  }

  inspectSchema(): Promise<AuthoritySchemaInspection> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }

    return this.#send({ type: "authority.inspect-schema" }).then((response) => {
      if (response.type !== "authority.schema") {
        this.#failProtocol("Authority worker returned the wrong schema response");
        throw this.#terminalError;
      }
      return { version: response.schemaVersion };
    });
  }

  executeAttachment(
    operation: AttachmentDatabaseOperation,
    now: number,
  ): Promise<AttachmentDatabaseOperationResult> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.attachment", operation, now }).then((response) => {
      if (response.type !== "authority.attachment-result") {
        this.#failProtocol("Authority worker returned the wrong attachment response");
        throw this.#terminalError;
      }
      return response.result;
    });
  }

  importLegacyState(paths: LegacyImportPaths): Promise<LegacyImportResult> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({ type: "authority.import-legacy", ...paths }).then(
      (response) => {
        if (response.type !== "authority.legacy-imported") {
          this.#failProtocol("Authority worker returned the wrong import response");
          throw this.#terminalError;
        }
        return {
          imported: response.imported,
          actors: response.actors,
          rooms: response.rooms,
          messages: response.messages,
        };
      },
    );
  }

  inspectLegacyImport(): Promise<LegacyImportInspection> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({ type: "authority.inspect-legacy-import" }).then(
      (response) => {
        if (response.type !== "authority.legacy-import") {
          this.#failProtocol("Authority worker returned the wrong import inspection");
          throw this.#terminalError;
        }
        return {
          markerVersion: response.markerVersion,
          actors: response.actors,
          rooms: response.rooms,
          messages: response.messages,
          roomHeadSeq: response.roomHeadSeq,
          identityHeadSeq: response.identityHeadSeq,
        };
      },
    );
  }

  registerActors(actors: readonly Actor[]): Promise<number> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({ type: "authority.register-actors", actors }).then(
      (response) => {
        if (response.type !== "authority.actors-registered") {
          this.#failProtocol("Authority worker returned the wrong actor response");
          throw this.#terminalError;
        }
        return response.actorCount;
      },
    );
  }

  issueSession(input: HashedSessionIssue): Promise<IssuedSessionRecord> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({ type: "authority.session-issue", input }).then(
      (response) => {
        if (response.type !== "authority.session-issued") {
          this.#failProtocol("Authority worker returned the wrong session issue response");
          throw this.#terminalError;
        }
        return response.session;
      },
    );
  }

  authenticateSession(
    accessTokenHash: string,
    now: number,
  ): Promise<AuthenticatedSessionContext> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({
      type: "authority.session-authenticate",
      accessTokenHash,
      now,
    }).then((response) => {
      if (response.type !== "authority.session-authenticated") {
        this.#failProtocol("Authority worker returned the wrong authentication response");
        throw this.#terminalError;
      }
      return response.context;
    });
  }

  rotateSession(input: HashedSessionRotation): Promise<IssuedSessionRecord> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({ type: "authority.session-rotate", input }).then(
      (response) => {
        if (response.type !== "authority.session-rotated") {
          this.#failProtocol("Authority worker returned the wrong session rotation response");
          throw this.#terminalError;
        }
        return response.session;
      },
    );
  }

  validateSessionRefresh(
    currentRefreshTokenHash: string,
    expectedPrincipal: { readonly accountId: string; readonly actorId: string } | undefined,
    now: number,
  ): Promise<void> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({
      type: "authority.session-validate-refresh",
      currentRefreshTokenHash,
      ...(expectedPrincipal === undefined ? {} : { expectedPrincipal }),
      now,
    }).then((response) => {
      if (response.type !== "authority.session-refresh-valid") {
        this.#failProtocol("Authority worker returned the wrong refresh validation response");
        throw this.#terminalError;
      }
    });
  }

  revokeSession(accessTokenHash: string, now: number): Promise<void> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({
      type: "authority.session-revoke",
      accessTokenHash,
      now,
    }).then((response) => {
      if (response.type !== "authority.session-revoked") {
        this.#failProtocol("Authority worker returned the wrong session revoke response");
        throw this.#terminalError;
      }
    });
  }

  listSessions(
    accessTokenHash: string,
    now: number,
  ): Promise<readonly PublicSession[]> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({
      type: "authority.sessions-list",
      accessTokenHash,
      now,
    }).then((response) => {
      if (response.type !== "authority.sessions") {
        this.#failProtocol("Authority worker returned the wrong session list response");
        throw this.#terminalError;
      }
      return response.sessions;
    });
  }

  revokeTargetSession(
    accessTokenHash: string,
    publicSessionId: string,
    now: number,
  ): Promise<void> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({
      type: "authority.session-revoke-target",
      accessTokenHash,
      publicSessionId,
      now,
    }).then((response) => {
      if (
        response.type !== "authority.session-target-revoked" ||
        response.publicSessionId !== publicSessionId
      ) {
        this.#failProtocol("Authority worker returned the wrong targeted revoke response");
        throw this.#terminalError;
      }
    });
  }

  executeHuman(
    context: AuthenticatedCommandContext,
    command: HumanCollaborationCommand | RoomGovernanceCommand,
    now: number,
    invitationSecret?: {
      readonly tokenHash: string;
      readonly sealedToken: string;
    },
  ): Promise<CommandAcknowledgement> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({
      type: "authority.execute-human",
      context,
      command,
      ...(invitationSecret === undefined ? {} : { invitationSecret }),
      now,
    }).then((response) => {
      if (response.type !== "authority.command-acknowledged") {
        this.#failProtocol("Authority worker returned the wrong command response");
        throw this.#terminalError;
      }
      return response.acknowledgement;
    });
  }

  executeHumanGovernance(
    context: AuthenticatedCommandContext,
    command: ClosedRoomGovernanceMutationCommand,
    now: number,
  ): Promise<ClosedRoomGovernanceAcknowledgement> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({
      type: "authority.execute-human-governance",
      context,
      command,
      now,
    }).then((response) => {
      if (response.type !== "authority.governance-acknowledged") {
        this.#failProtocol("Authority worker returned the wrong governance command response");
        throw this.#terminalError;
      }
      return response.acknowledgement;
    });
  }

  readDepartureConflicts(
    context: AuthenticatedSessionContext,
    input: { readonly roomId: string; readonly targetActorId: string },
    now: number,
  ): Promise<DepartureConflictList> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({
      type: "authority.departure-conflicts",
      context,
      roomId: input.roomId,
      targetActorId: input.targetActorId,
      now,
    }).then((response) => {
      if (response.type !== "authority.departure-conflicts") {
        this.#failProtocol("Authority worker returned the wrong departure query response");
        throw this.#terminalError;
      }
      return response.conflicts;
    });
  }

  executeAgent(
    context: InternalAgentCommandContext,
    command: AgentCollaborationCommand,
    now: number,
  ): Promise<CommandAcknowledgement> {
    let wireContext: ReturnType<typeof toAgentWorkerCommandContext>;
    try {
      wireContext = toAgentWorkerCommandContext(context);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({
      type: "authority.execute-agent",
      context: wireContext,
      command,
      now,
    }).then((response) => {
      if (response.type !== "authority.command-acknowledged") {
        this.#failProtocol("Authority worker returned the wrong Agent command response");
        throw this.#terminalError;
      }
      return response.acknowledgement;
    });
  }

  submitHumanMessage(
    context: AuthenticatedCommandContext,
    message: HumanMessageSubmit,
    now: number,
  ): Promise<HumanMessageSubmissionReceipt> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.message-submit", context, message, now }).then(
      (response) => {
        if (response.type !== "authority.message-submitted") {
          this.#failProtocol("Authority worker returned the wrong message submit response");
          throw this.#terminalError;
        }
        return response.receipt;
      },
    );
  }

  reviseHumanMessage(
    context: AuthenticatedCommandContext,
    command: MessageRevisionCommand,
    now: number,
  ): Promise<MessageRevisionReceipt> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.message-revise", context, command, now }).then(
      (response) => {
        if (response.type !== "authority.message-revised") {
          this.#failProtocol("Authority worker returned the wrong message revision response");
          throw this.#terminalError;
        }
        return response.receipt;
      },
    );
  }

  recallHumanMessage(
    context: AuthenticatedCommandContext,
    command: MessageRecallCommand,
    now: number,
  ): Promise<MessageRecallReceipt> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.message-recall", context, command, now }).then(
      (response) => {
        if (response.type !== "authority.message-recalled") {
          this.#failProtocol("Authority worker returned the wrong message recall response");
          throw this.#terminalError;
        }
        return response.receipt;
      },
    );
  }

  commitAgentMessage(
    context: InternalAgentMessageCommitContext,
    command: AgentMessageCommitCommand,
    now: number,
  ): Promise<AgentMessageCommitReceipt> {
    let workerContext: ReturnType<typeof toAgentMessageWorkerContext>;
    try {
      workerContext = toAgentMessageWorkerContext(context);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({
      type: "authority.agent-message-commit",
      context: workerContext,
      command,
      now,
    }).then((response) => {
      if (response.type !== "authority.agent-message-committed") {
        this.#failProtocol("Authority worker returned the wrong Agent message response");
        throw this.#terminalError;
      }
      return response.receipt;
    });
  }

  readMessageHistory(
    context: AuthenticatedSessionContext,
    query: MessageHistoryQuery,
    now: number,
  ): Promise<MessageHistoryPage> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.message-history", context, query, now }).then(
      (response) => {
        if (response.type !== "authority.message-history") {
          this.#failProtocol("Authority worker returned the wrong message history response");
          throw this.#terminalError;
        }
        return response.page;
      },
    );
  }

  readMessageRevisions(
    context: AuthenticatedSessionContext,
    query: MessageRevisionQuery,
    now: number,
  ): Promise<MessageRevisionPage> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.message-revisions", context, query, now }).then(
      (response) => {
        if (response.type !== "authority.message-revisions") {
          this.#failProtocol("Authority worker returned the wrong message revisions response");
          throw this.#terminalError;
        }
        return response.page;
      },
    );
  }

  executeRuntime(operation: RuntimeAuthorityOperation): Promise<unknown> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.runtime", operation }).then((response) => {
      if (response.type !== "authority.runtime-result") {
        this.#failProtocol("Authority worker returned the wrong runtime response");
        throw this.#terminalError;
      }
      return response.result;
    });
  }

  executeTenantAdministration(
    operation: TenantAdministrationOperation,
  ): Promise<TenantAdministrationResult> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.tenant-administration", operation }).then((response) => {
      if (response.type !== "authority.tenant-administration-result") {
        this.#failProtocol("Authority worker returned the wrong tenant administration response");
        throw this.#terminalError;
      }
      return response.result;
    });
  }

  executeRoomAssignment(operation: RoomAssignmentOperation): Promise<RoomAssignmentResult> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.room-assignment", operation }).then((response) => {
      if (response.type !== "authority.room-assignment-result") {
        this.#failProtocol("Authority worker returned the wrong Room Assignment response");
        throw this.#terminalError;
      }
      return response.result;
    });
  }

  executeContext(operation: ContextWorkerOperation): Promise<unknown> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.context", operation }).then((response) => {
      if (response.type !== "authority.context-result") {
        this.#failProtocol("Authority worker returned the wrong context response");
        throw this.#terminalError;
      }
      return response.result;
    });
  }

  executeRoute(operation: RouteAuthorityOperation): Promise<unknown> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.route", operation }).then((response) => {
      if (response.type !== "authority.route-result") {
        this.#failProtocol("Authority worker returned the wrong route response");
        throw this.#terminalError;
      }
      return response.result;
    });
  }

  executeBall(operation: BallAuthorityOperation): Promise<unknown> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.ball", operation }).then((response) => {
      if (response.type !== "authority.ball-result") {
        this.#failProtocol("Authority worker returned the wrong ball response");
        throw this.#terminalError;
      }
      return response.result;
    });
  }

  executeMemory(operation: MemoryAuthorityOperation): Promise<unknown> {
    if (this.#terminalError !== undefined) return this.#rejectTerminal();
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) return Promise.reject(unavailable);
    return this.#send({ type: "authority.memory", operation }).then((response) => {
      if (response.type !== "authority.memory-result") {
        this.#failProtocol("Authority worker returned the wrong memory response");
        throw this.#terminalError;
      }
      return response.result;
    });
  }

  readHistory(
    context: AuthenticatedSessionContext,
    roomId: string,
    now: number,
  ): Promise<readonly Message[]> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    const unavailable = this.#unavailableError();
    if (unavailable !== undefined) {
      return Promise.reject(unavailable);
    }
    return this.#send({ type: "authority.read-history", context, roomId, now })
      .then((response) => {
        if (response.type !== "authority.history") {
          this.#failProtocol("Authority worker returned the wrong history response");
          throw this.#terminalError;
        }
        return response.messages;
      });
  }

  acquireStreamingRepair(
    context: AuthenticatedSessionContext,
    scope: RepairScope,
    now: number,
  ): Promise<StreamingRepairLease> {
    return this.#send({ type: "authority.repair-acquire", context, scope, now })
      .then((response) => {
        if (response.type !== "authority.repair-lease") {
          this.#failProtocol("Authority worker returned the wrong repair-acquire response");
          throw this.#terminalError;
        }
        return response.lease;
      });
  }

  registerStreamingRepair(
    snapshotId: string,
    checksum: string,
    pageCount: number,
    now: number,
  ): Promise<StreamingRepairLease> {
    return this.#send({
      type: "authority.repair-register", snapshotId, checksum, pageCount, now,
    }).then((response) => {
      if (response.type !== "authority.repair-lease") {
        this.#failProtocol("Authority worker returned the wrong repair-register response");
        throw this.#terminalError;
      }
      return response.lease;
    });
  }

  authorizeStreamingRepairPage(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    page: number,
    now: number,
  ): Promise<StreamingRepairLease> {
    return this.#send({
      type: "authority.repair-authorize-page", context, snapshotId, page, now,
    }).then((response) => {
      if (response.type !== "authority.repair-lease") {
        this.#failProtocol("Authority worker returned the wrong repair-page response");
        throw this.#terminalError;
      }
      return response.lease;
    });
  }

  completeStreamingRepair(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    version: SnapshotVersion,
    checksum: string,
    now: number,
  ): Promise<SnapshotCompleted> {
    return this.#send({
      type: "authority.repair-complete", context, snapshotId, version, checksum, now,
    }).then((response) => {
      if (response.type !== "authority.snapshot-completed") {
        this.#failProtocol("Authority worker returned the wrong repair-complete response");
        throw this.#terminalError;
      }
      return response.completed;
    });
  }

  releaseStreamingRepair(
    context: AuthenticatedSessionContext,
    snapshotId: string,
    now: number,
  ): Promise<void> {
    return this.#send({ type: "authority.repair-release", context, snapshotId, now })
      .then((response) => {
        if (response.type !== "authority.repair-released") {
          this.#failProtocol("Authority worker returned the wrong repair-release response");
          throw this.#terminalError;
        }
      });
  }

  syncRoom(
    context: AuthenticatedSessionContext,
    request: RoomSyncRequest,
    now: number,
  ): Promise<RoomSyncResult> {
    return this.#send({ type: "authority.sync-room", context, request, now })
      .then((response) => {
        if (response.type !== "authority.room-synced") {
          this.#failProtocol("Authority worker returned the wrong room-sync response");
          throw this.#terminalError;
        }
        if (!roomSyncResultMatchesRequest(request, response.result)) {
          this.#failProtocol("Authority worker returned an invalid room-sync result");
          throw this.#terminalError;
        }
        return response.result;
      });
  }

  compactRoomStream(
    roomId: string,
    retainedFromSeq: number,
  ): Promise<{ readonly retainedFromSeq: number; readonly headSeq: number }> {
    return this.#send({
      type: "authority.compact-room-stream",
      roomId,
      retainedFromSeq,
    }).then((response) => {
      if (response.type !== "authority.room-stream-compacted") {
        this.#failProtocol("Authority worker returned the wrong room-stream compaction response");
        throw this.#terminalError;
      }
      if (
        response.roomId !== roomId ||
        response.retainedFromSeq !== retainedFromSeq
      ) {
        this.#failProtocol("Authority worker returned an invalid room-stream compaction result");
        throw this.#terminalError;
      }
      return {
        retainedFromSeq: response.retainedFromSeq,
        headSeq: response.headSeq,
      };
    });
  }

  revalidateSnapshot(
    validation: SnapshotRevalidationRequest,
    now: number,
  ): Promise<void> {
    return this.#send({ type: "authority.snapshot-revalidate", validation, now })
      .then((response) => {
        if (response.type !== "authority.snapshot-revalidated") {
          this.#failProtocol("Authority worker returned the wrong snapshot revalidation response");
          throw this.#terminalError;
        }
      });
  }

  readActor(actorId: string): Promise<Actor | undefined> {
    return this.#send({ type: "authority.read-actor", actorId }).then((response) => {
      if (response.type !== "authority.actor") {
        this.#failProtocol("Authority worker returned the wrong actor response");
        throw this.#terminalError;
      }
      return response.actor;
    });
  }

  readRoom(roomId: string): Promise<ManagedRoom | undefined> {
    return this.#send({ type: "authority.read-room", roomId }).then((response) => {
      if (response.type !== "authority.room") {
        this.#failProtocol("Authority worker returned the wrong room response");
        throw this.#terminalError;
      }
      return response.room;
    });
  }

  readRoomGovernance(
    context: AuthenticatedSessionContext,
    roomId: string,
    now: number,
  ): Promise<RoomGovernanceView> {
    return this.#send({ type: "authority.read-room-governance", context, roomId, now })
      .then((response) => {
        if (response.type !== "authority.room-governance") {
          this.#failProtocol("Authority worker returned the wrong governance response");
          throw this.#terminalError;
        }
        return response.governance;
      });
  }

  canAccessRoom(
    context: AuthenticatedSessionContext,
    roomId: string,
    now: number,
  ): Promise<boolean> {
    return this.#send({ type: "authority.can-access-room", context, roomId, now })
      .then((response) => {
        if (response.type !== "authority.room-access") {
          this.#failProtocol("Authority worker returned the wrong room-access response");
          throw this.#terminalError;
        }
        return response.allowed;
      });
  }

  readRoomAudit(
    context: AuthenticatedSessionContext,
    roomId: string,
    now: number,
  ): Promise<readonly RoomAuditRecord[]> {
    return this.#send({ type: "authority.read-room-audit", context, roomId, now })
      .then((response) => {
        if (response.type !== "authority.room-audit") {
          this.#failProtocol("Authority worker returned the wrong room-audit response");
          throw this.#terminalError;
        }
        return response.audit;
      });
  }

  listPendingOutbox(limit: number, now: number): Promise<readonly OutboxDelivery[]> {
    return this.#send({ type: "authority.outbox-list", limit, now }).then((response) => {
      if (response.type !== "authority.outbox") {
        this.#failProtocol("Authority worker returned the wrong outbox response");
        throw this.#terminalError;
      }
      return response.deliveries;
    });
  }

  authorizeOutboxCandidate(
    deliveryId: string,
    candidate: OutboxDispatchCandidate,
    now: number,
  ): Promise<boolean> {
    return this.#send({
      type: "authority.outbox-authorize",
      deliveryId,
      candidate,
      now,
    }).then((response) => {
      if (response.type !== "authority.outbox-authorized") {
        this.#failProtocol("Authority worker returned the wrong outbox authorization response");
        throw this.#terminalError;
      }
      return response.authorized;
    });
  }

  markOutboxDispatched(deliveryId: string, now: number): Promise<void> {
    return this.#send({
      type: "authority.outbox-dispatched",
      deliveryId,
      now,
    }).then((response) => {
      if (response.type !== "authority.outbox-updated") {
        this.#failProtocol("Authority worker returned the wrong dispatched-outbox response");
        throw this.#terminalError;
      }
    });
  }

  markOutboxFailed(
    deliveryId: string,
    reason: OutboxDeliveryFailureReason,
  ): Promise<void> {
    return this.#send({ type: "authority.outbox-failed", deliveryId, reason })
      .then((response) => {
        if (response.type !== "authority.outbox-updated") {
          this.#failProtocol("Authority worker returned the wrong failed-outbox response");
          throw this.#terminalError;
        }
      });
  }

  listCommittedRoomCacheInvalidations(
    limit: number,
  ): Promise<readonly CommittedRoomCacheInvalidationIntent[]> {
    return this.#send({ type: "authority.room-cache-invalidation-list", limit })
      .then((response) => {
        if (response.type !== "authority.room-cache-invalidations") {
          this.#failProtocol("Authority worker returned the wrong room-cache invalidation response");
          throw this.#terminalError;
        }
        return response.intents;
      });
  }

  markRoomCacheInvalidationCompleted(invalidationIntentId: string): Promise<void> {
    return this.#send({
      type: "authority.room-cache-invalidation-completed",
      invalidationIntentId,
    }).then((response) => {
      if (response.type !== "authority.room-cache-invalidation-updated") {
        this.#failProtocol("Authority worker returned the wrong room-cache completion response");
        throw this.#terminalError;
      }
    });
  }

  markRoomCacheInvalidationFailed(
    invalidationIntentId: string,
    errorCode: "purge_failed" | "authority_unavailable",
  ): Promise<void> {
    return this.#send({
      type: "authority.room-cache-invalidation-failed",
      invalidationIntentId,
      errorCode,
    }).then((response) => {
      if (response.type !== "authority.room-cache-invalidation-updated") {
        this.#failProtocol("Authority worker returned the wrong room-cache failure response");
        throw this.#terminalError;
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }
    if (this.#state === "closed") {
      return Promise.resolve();
    }

    this.#state = "closing";
    this.#closePromise = this.#send({ type: "authority.close" })
      .then((response) => {
        if (response.type !== "authority.closed") {
          this.#failProtocol("Authority worker returned the wrong close response");
          throw this.#terminalError;
        }
        this.#state = "closed";
      })
      .catch((error: unknown) => {
        const stableError =
          error instanceof AuthorityWorkerClientError
            ? error
            : new AuthorityWorkerClientError(
                "authority_worker_error",
                "Authority worker close failed",
              );
        throw this.#failTerminal(stableError);
      });
    return this.#closePromise;
  }

  #unavailableError(): AuthorityWorkerClientError | undefined {
    if (this.#state === "closing" || this.#state === "closed") {
      return this.#stableClosedError();
    }
    if (this.#state !== "open") {
      return new AuthorityWorkerClientError(
        "authority_worker_not_ready",
        "Authority worker is not ready",
      );
    }
    return undefined;
  }

  #stableClosedError(): AuthorityWorkerClientError {
    this.#closedError ??= new AuthorityWorkerClientError(
      "authority_worker_closed",
      "Authority worker is closed",
    );
    return this.#closedError;
  }

  #send(command: AuthorityWorkerCommand): Promise<AuthorityWorkerResponse> {
    if (this.#terminalError !== undefined) {
      return this.#rejectTerminal();
    }

    const requestId = String(this.#nextRequestId);
    this.#nextRequestId += 1n;
    const request = { ...command, requestId } as AuthorityWorkerRequest;

    return new Promise<AuthorityWorkerResponse>((resolve, reject) => {
      this.#pending.set(requestId, { requestType: request.type, resolve, reject });
      try {
        this.#worker.postMessage(request);
      } catch {
        this.#failTerminal(
          new AuthorityWorkerClientError(
            "authority_worker_post_failed",
            "Authority worker request could not be sent",
          ),
        );
      }
    });
  }

  #handleMessage(message: unknown): void {
    if (this.#terminalError !== undefined || this.#state === "closed") {
      return;
    }
    if (
      isRecord(message) &&
      hasExactKeys(message, ["type", "requestId", "code", "message"]) &&
      message.type === "authority.error" &&
      typeof message.requestId === "string" &&
      typeof message.code === "string" &&
      !isAuthorityWorkerErrorCode(message.code)
    ) {
      this.#failTerminal(new AuthorityWorkerClientError(
        "storage_unavailable",
        "Authority storage became unavailable",
      ));
      return;
    }
    if (!isAuthorityWorkerResponse(message)) {
      this.#failProtocol("Authority worker sent a malformed response");
      return;
    }

    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) {
      this.#failProtocol("Authority worker sent a response for an unknown request");
      return;
    }
    if (!this.#responseMatchesRequest(pending.requestType, message.type)) {
      this.#failProtocol("Authority worker response did not match its request");
      return;
    }

    if (message.type === "authority.error") {
      if (
        message.code === "authority_operation_unavailable" ||
        message.code === "authority_storage_transient"
      ) {
        this.#pending.delete(message.requestId);
        pending.reject(new AuthorityWorkerClientError(
          "storage_unavailable",
          message.code === "authority_storage_transient"
            ? "Authority storage is temporarily unavailable"
            : "Authority operation is temporarily unavailable",
        ));
        return;
      }
      if (message.code === "authority_storage_poisoned") {
        this.#failTerminal(new AuthorityWorkerClientError(
          "storage_unavailable",
          "Authority storage became unavailable",
        ));
        return;
      }
      const error = new AuthorityWorkerClientError(
        message.code,
        message.message,
        message.code === "departure_blocked" ? message.details : undefined,
      );
      if (
        message.code === "storage_unavailable" ||
        pending.requestType === "authority.initialize" ||
        pending.requestType === "authority.close"
      ) {
        this.#failTerminal(error);
      } else {
        this.#pending.delete(message.requestId);
        pending.reject(error);
      }
      return;
    }
    if (message.type === "authority.closed") {
      this.#pending.delete(message.requestId);
      this.#state = "closed";
      const closedError = this.#stableClosedError();
      const remaining = [...this.#pending.values()];
      this.#pending.clear();
      for (const request of remaining) {
        request.reject(closedError);
      }
      this.#releaseCoordinator();
      pending.resolve(message);
      return;
    }
    this.#pending.delete(message.requestId);
    pending.resolve(message);
  }

  #responseMatchesRequest(
    requestType: AuthorityWorkerRequest["type"],
    responseType: AuthorityWorkerResponse["type"],
  ): boolean {
    if (responseType === "authority.error") {
      return true;
    }
    return (
      (requestType === "authority.initialize" && responseType === "authority.ready") ||
      (requestType === "authority.inspect-schema" &&
        responseType === "authority.schema") ||
      (requestType === "authority.import-legacy" &&
        responseType === "authority.legacy-imported") ||
      (requestType === "authority.inspect-legacy-import" &&
        responseType === "authority.legacy-import") ||
      (requestType === "authority.register-actors" &&
        responseType === "authority.actors-registered") ||
      (requestType === "authority.session-issue" &&
        responseType === "authority.session-issued") ||
      (requestType === "authority.session-authenticate" &&
        responseType === "authority.session-authenticated") ||
      (requestType === "authority.session-rotate" &&
        responseType === "authority.session-rotated") ||
      (requestType === "authority.session-validate-refresh" &&
        responseType === "authority.session-refresh-valid") ||
      (requestType === "authority.session-revoke" &&
        responseType === "authority.session-revoked") ||
      (requestType === "authority.sessions-list" &&
        responseType === "authority.sessions") ||
      (requestType === "authority.session-revoke-target" &&
        responseType === "authority.session-target-revoked") ||
      (requestType === "authority.execute-human" &&
        responseType === "authority.command-acknowledged") ||
      (requestType === "authority.execute-human-governance" &&
        responseType === "authority.governance-acknowledged") ||
      (requestType === "authority.departure-conflicts" &&
        responseType === "authority.departure-conflicts") ||
      (requestType === "authority.execute-agent" &&
        responseType === "authority.command-acknowledged") ||
      (requestType === "authority.attachment" &&
        responseType === "authority.attachment-result") ||
      (requestType === "authority.tenant-administration" &&
        responseType === "authority.tenant-administration-result") ||
      (requestType === "authority.room-assignment" &&
        responseType === "authority.room-assignment-result") ||
      (requestType === "authority.message-submit" &&
        responseType === "authority.message-submitted") ||
      (requestType === "authority.message-revise" &&
        responseType === "authority.message-revised") ||
      (requestType === "authority.message-recall" &&
        responseType === "authority.message-recalled") ||
      (requestType === "authority.agent-message-commit" &&
        responseType === "authority.agent-message-committed") ||
      (requestType === "authority.message-history" &&
        responseType === "authority.message-history") ||
      (requestType === "authority.message-revisions" &&
        responseType === "authority.message-revisions") ||
      (requestType === "authority.runtime" &&
        responseType === "authority.runtime-result") ||
      (requestType === "authority.context" &&
        responseType === "authority.context-result") ||
      (requestType === "authority.route" &&
        responseType === "authority.route-result") ||
      (requestType === "authority.ball" &&
        responseType === "authority.ball-result") ||
      (requestType === "authority.memory" &&
        responseType === "authority.memory-result") ||
      (requestType === "authority.read-history" &&
        responseType === "authority.history") ||
      (requestType === "authority.read-actor" && responseType === "authority.actor") ||
      (requestType === "authority.read-room" && responseType === "authority.room") ||
      (requestType === "authority.read-room-governance" && responseType === "authority.room-governance") ||
      (requestType === "authority.can-access-room" && responseType === "authority.room-access") ||
      (requestType === "authority.read-room-audit" && responseType === "authority.room-audit") ||
      (requestType === "authority.outbox-list" && responseType === "authority.outbox") ||
      (requestType === "authority.outbox-authorize" &&
        responseType === "authority.outbox-authorized") ||
      (requestType === "authority.outbox-dispatched" &&
        responseType === "authority.outbox-updated") ||
      (requestType === "authority.outbox-failed" &&
        responseType === "authority.outbox-updated") ||
      (requestType === "authority.room-cache-invalidation-list" &&
        responseType === "authority.room-cache-invalidations") ||
      ((requestType === "authority.room-cache-invalidation-completed" ||
        requestType === "authority.room-cache-invalidation-failed") &&
        responseType === "authority.room-cache-invalidation-updated") ||
      (requestType === "authority.sync-room" &&
        responseType === "authority.room-synced") ||
      (requestType === "authority.snapshot-revalidate" &&
        responseType === "authority.snapshot-revalidated") ||
      (requestType === "authority.repair-acquire" &&
        responseType === "authority.repair-lease") ||
      (requestType === "authority.repair-register" &&
        responseType === "authority.repair-lease") ||
      (requestType === "authority.repair-authorize-page" &&
        responseType === "authority.repair-lease") ||
      (requestType === "authority.repair-complete" &&
        responseType === "authority.snapshot-completed") ||
      (requestType === "authority.repair-release" &&
        responseType === "authority.repair-released") ||
      (requestType === "authority.compact-room-stream" &&
        responseType === "authority.room-stream-compacted") ||
      (requestType === "authority.close" && responseType === "authority.closed")
    );
  }

  #failProtocol(message: string): AuthorityWorkerClientError {
    return this.#failTerminal(
      new AuthorityWorkerClientError("authority_worker_protocol_error", message),
    );
  }

  #rejectTerminal<Result>(): Promise<Result> {
    const error = this.#terminalError;
    if (error === undefined) {
      return Promise.reject(
        new AuthorityWorkerClientError(
          "authority_worker_error",
          "Authority worker failed",
        ),
      );
    }
    return Promise.reject(error);
  }

  #failTerminal(error: AuthorityWorkerClientError): AuthorityWorkerClientError {
    if (this.#state === "closed") {
      return this.#stableClosedError();
    }
    if (this.#terminalError !== undefined) {
      return this.#terminalError;
    }

    this.#terminalError = error;
    this.#state = "failed";
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      request.reject(error);
    }
    void terminateTransport(this.#worker).then((terminated) => {
      if (terminated) {
        this.#releaseCoordinator();
      }
    });
    return error;
  }
}

export function createWorkerRoomCacheInvalidationIntentAuthority(
  worker: Pick<WorkerDatabaseClient,
    | "listCommittedRoomCacheInvalidations"
    | "markRoomCacheInvalidationCompleted"
    | "markRoomCacheInvalidationFailed">,
): RoomCacheInvalidationIntentAuthority {
  return Object.freeze({
    listCommittedReady: (limit: number) => worker.listCommittedRoomCacheInvalidations(limit),
    markCompleted: (invalidationIntentId: string) =>
      worker.markRoomCacheInvalidationCompleted(invalidationIntentId),
    markFailed: (
      invalidationIntentId: string,
      errorCode: "purge_failed" | "authority_unavailable",
    ) => worker.markRoomCacheInvalidationFailed(invalidationIntentId, errorCode),
  });
}

type AuthorityWorkerFactory = (
  databasePath: string,
  recovery?: LegacyImportRecovery,
) => AuthorityWorkerTransport;

async function createClient(
  options: CreateWorkerDatabaseClientOptions,
  workerFactory: AuthorityWorkerFactory,
): Promise<CompleteWorkerDatabaseClient> {
  const reservation = await reserveAuthorityCoordinator(options.databasePath);
  let worker: AuthorityWorkerTransport;
  try {
    worker = workerFactory(reservation.databasePath, reservation.recovery);
  } catch {
    reservation.release();
    throw new AuthorityWorkerClientError(
      "authority_worker_error",
      "Authority worker failed",
    );
  }

  let client: WorkerDatabaseClientImplementation;
  try {
    client = new WorkerDatabaseClientImplementation(worker, reservation.release);
  } catch {
    if (await terminateTransport(worker)) {
      reservation.release();
    }
    throw new AuthorityWorkerClientError(
      "authority_worker_error",
      "Authority worker failed",
    );
  }

  try {
    await client.initialize();
    return client;
  } catch (error: unknown) {
    if (error instanceof AuthorityWorkerClientError) {
      throw error;
    }
    if (await terminateTransport(worker)) {
      reservation.release();
    }
    throw new AuthorityWorkerClientError(
      "authority_worker_error",
      "Authority worker failed",
    );
  }
}

export function createWorkerDatabaseClient(
  options: CreateWorkerDatabaseClientOptions,
): Promise<CompleteWorkerDatabaseClient> {
  return createClient(options, (databasePath, recovery) =>
    createAuthorityWorker({ ...options, databasePath }, recovery),
  );
}

// Module-local test seam. It is intentionally absent from the package root export.
export function createWorkerDatabaseClientForTest(
  _options: CreateWorkerDatabaseClientOptions,
  workerFactory: AuthorityWorkerFactory,
): Promise<CompleteWorkerDatabaseClient> {
  return createClient(_options, workerFactory);
}

// Module-local integration seam. It is intentionally absent from the package root export.
export function createWorkerDatabaseClientWithRollbackFailureForTest(
  options: CreateWorkerDatabaseClientOptions,
): Promise<CompleteWorkerDatabaseClient> {
  return createClient(options, (databasePath, recovery) =>
    createAuthorityWorker({ ...options, databasePath }, recovery, true),
  );
}

// Deep-only real-worker crash seam; intentionally absent from the package root.
export function createWorkerDatabaseClientWithTransactionFaultForTest(
  options: CreateWorkerDatabaseClientOptions,
  faultPoint: "after-domain-write" | "before-commit",
): Promise<CompleteWorkerDatabaseClient> {
  return createClient(options, (databasePath, recovery) =>
    createAuthorityWorker({ ...options, databasePath }, recovery, false, faultPoint),
  );
}
