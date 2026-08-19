import {
  isDepartureConflictList,
  isActor,
  isAgentFinalMessage,
  isHumanMessageSubmit,
  isIsoUtcTimestamp,
  isMessage,
  isMessageRevision,
  isMessageTargetOutcome,
  isTimelineMessage,
  isRoomGovernanceView,
  isRoomSyncResult,
  isSnapshotCompleted,
  isSnapshotVersion,
} from "@native-im/core";
import type {
  Actor,
  HumanMessageSubmit,
  DepartureConflictList,
  ManagedRoom,
  Message,
  RoomSyncRequest,
  RoomSyncResult,
  RoomGovernanceView,
  SnapshotCompleted,
  SnapshotVersion,
} from "@native-im/core";
import {
  isManagedRoomShape,
  isRoomAuditRecord,
  type RoomAuditRecord,
} from "../room-lifecycle.js";
import {
  parseClosedRoomGovernanceMutationCommand,
  parsePersistedIdentityEvent,
  parsePersistedRoomEvent,
  parsePersistentCommand,
  parseRoomSyncRequest,
} from "./contracts.js";
import { MAX_ACTIVE_SESSION_FAMILIES } from "./contracts.js";
import {
  isRuntimeAuthorityOperation,
  type RuntimeAuthorityOperation,
} from "../agent-runtime/runtime-authority-protocol.js";
import {
  isRouteAuthorityOperation,
  type RouteAuthorityOperation,
} from "../route-runtime/route-authority-protocol.js";
import {
  isBallAuthorityOperation,
  type BallAuthorityOperation,
} from "../ball-runtime/ball-authority-protocol.js";
import type { CommittedRoomCacheInvalidationIntent } from "../access/room-cache-invalidation-port.js";
import type {
  AgentCollaborationCommand,
  AgentMessageCommitCommand,
  AgentMessageCommitReceipt,
  AgentWorkerCommandContext,
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  ClosedRoomGovernanceAcknowledgement,
  ClosedRoomGovernanceMutationCommand,
  CommandAcknowledgement,
  HashedSessionIssue,
  HashedSessionRotation,
  HumanCollaborationCommand,
  HumanMessageSubmissionReceipt,
  IssuedSessionRecord,
  JsonValue,
  MessageHistoryPage,
  MessageHistoryQuery,
  MessageRecallCommand,
  MessageRecallReceipt,
  MessageRevisionCommand,
  MessageRevisionPage,
  MessageRevisionQuery,
  MessageRevisionReceipt,
  OutboxDelivery,
  OutboxDispatchCandidate,
  RoomGovernanceCommand,
  SnapshotRevalidationRequest,
  RepairScope,
  PublicSession,
  SessionDevice,
  StreamingRepairLease,
} from "./contracts.js";
import type { AgentMessageWorkerContext } from "../message-authority/internal-message-capability.js";
import type {
  AttachmentDatabaseOperation,
  AttachmentDatabaseOperationResult,
} from "../attachment-authority/database-contracts.js";
import {
  isAttachmentDatabaseOperation,
  isAttachmentDatabaseOperationResult,
} from "../attachment-authority/database-contracts.js";

export type AuthorityWorkerErrorCode =
  | "actor_conflict"
  | "agent_missing_permission"
  | "agent_final_immutable"
  | "agent_queue_full"
  | "agent_permissions_invalid"
  | "agent_required"
  | "authority_already_initialized"
  | "authority_not_initialized"
  | "authority_worker_closed"
  | "unauthenticated"
  | "invalid_chunk"
  | "attachment_forbidden"
  | "attachment_already_bound"
  | "generation_conflict"
  | "attachment_not_ready"
  | "upload_offset_conflict"
  | "upload_expired"
  | "attachment_gone"
  | "attachment_too_large"
  | "chunk_too_large"
  | "attachment_type_unsupported"
  | "type_mismatch"
  | "attachment_malformed"
  | "encrypted_pdf"
  | "archive_bomb"
  | "image_bomb"
  | "attachment_capacity_limited"
  | "scanner_unavailable"
  | "extractor_unavailable"
  | "ocr_unavailable"
  | "calibration_source_invalid"
  | "confirmation_expired"
  | "confirmation_forbidden"
  | "confirmation_rejected"
  | "confirmation_replayed"
  | "departure_blocked"
  | "execution_conflict"
  | "execution_not_found"
  | "execution_not_running"
  | "idempotency_conflict"
  | "identity_forbidden"
  | "invalid_request"
  | "invalid_parameters"
  | "invalid_token"
  | "invitation_consumed"
  | "invitation_forbidden"
  | "invitation_not_found"
  | "invitation_pending"
  | "invitation_secret_unavailable"
  | "invitee_required"
  | "legacy_import_failed"
  | "legacy_import_unavailable"
  | "grant_revoked"
  | "light_task_not_found"
  | "member_not_found"
  | "message_not_found"
  | "message_version_conflict"
  | "open_item_not_found"
  | "permission_denied"
  | "protocol_upgrade_required"
  | "role_forbidden"
  | "room_revision_conflict"
  | "ownership_transfer_required"
  | "dependency_unavailable"
  | "room_archived"
  | "room_compaction_blocked"
  | "room_forbidden"
  | "room_member_exists"
  | "room_member_not_found"
  | "room_not_found"
  | "room_owner_required"
  | "repair_barrier_active"
  | "route_conflict"
  | "route_job_not_found"
  | "session_revoked"
  | "session_not_found"
  | "session_id_conflict"
  | "session_limit_reached"
  | "snapshot_busy"
  | "snapshot_expired"
  | "snapshot_family_revoked"
  | "snapshot_forbidden"
  | "snapshot_not_found"
  | "snapshot_stale"
  | "storage_unavailable"
  | "token_expired";

export function isAuthorityWorkerErrorCode(
  value: unknown,
): value is AuthorityWorkerErrorCode {
  switch (value) {
    case "actor_conflict":
    case "agent_missing_permission":
    case "agent_final_immutable":
    case "agent_queue_full":
    case "agent_permissions_invalid":
    case "agent_required":
    case "authority_already_initialized":
    case "authority_not_initialized":
    case "authority_worker_closed":
    case "unauthenticated":
    case "invalid_chunk":
    case "attachment_forbidden":
    case "attachment_already_bound":
    case "generation_conflict":
    case "attachment_not_ready":
    case "upload_offset_conflict":
    case "upload_expired":
    case "attachment_gone":
    case "attachment_too_large":
    case "chunk_too_large":
    case "attachment_type_unsupported":
    case "type_mismatch":
    case "attachment_malformed":
    case "encrypted_pdf":
    case "archive_bomb":
    case "image_bomb":
    case "attachment_capacity_limited":
    case "scanner_unavailable":
    case "extractor_unavailable":
    case "ocr_unavailable":
    case "calibration_source_invalid":
    case "confirmation_expired":
    case "confirmation_forbidden":
    case "confirmation_rejected":
    case "confirmation_replayed":
    case "departure_blocked":
    case "execution_conflict":
    case "execution_not_found":
    case "execution_not_running":
    case "idempotency_conflict":
    case "identity_forbidden":
    case "invalid_request":
    case "invalid_parameters":
    case "invalid_token":
    case "invitation_consumed":
    case "invitation_forbidden":
    case "invitation_not_found":
    case "invitation_pending":
    case "invitation_secret_unavailable":
    case "invitee_required":
    case "legacy_import_failed":
    case "legacy_import_unavailable":
    case "grant_revoked":
    case "light_task_not_found":
    case "member_not_found":
    case "message_not_found":
    case "message_version_conflict":
    case "open_item_not_found":
    case "permission_denied":
    case "protocol_upgrade_required":
    case "role_forbidden":
    case "room_revision_conflict":
    case "ownership_transfer_required":
    case "dependency_unavailable":
    case "room_archived":
    case "room_compaction_blocked":
    case "room_forbidden":
    case "room_member_exists":
    case "room_member_not_found":
    case "room_not_found":
    case "room_owner_required":
    case "repair_barrier_active":
    case "route_conflict":
    case "route_job_not_found":
    case "session_revoked":
    case "session_not_found":
    case "session_id_conflict":
    case "session_limit_reached":
    case "snapshot_busy":
    case "snapshot_expired":
    case "snapshot_family_revoked":
    case "snapshot_forbidden":
    case "snapshot_not_found":
    case "snapshot_stale":
    case "storage_unavailable":
    case "token_expired":
      return true;
    default:
      return false;
  }
}

export type AuthorityWorkerRequest =
  | { readonly type: "authority.initialize"; readonly requestId: string }
  | { readonly type: "authority.inspect-schema"; readonly requestId: string }
  | {
      readonly type: "authority.import-legacy";
      readonly requestId: string;
      readonly sessionFilePath: string;
      readonly roomFilePath: string;
      readonly messageFilePath: string;
    }
  | { readonly type: "authority.inspect-legacy-import"; readonly requestId: string }
  | {
      readonly type: "authority.register-actors";
      readonly requestId: string;
      readonly actors: readonly Actor[];
    }
  | {
      readonly type: "authority.session-issue";
      readonly requestId: string;
      readonly input: HashedSessionIssue;
    }
  | {
      readonly type: "authority.session-authenticate";
      readonly requestId: string;
      readonly accessTokenHash: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.session-rotate";
      readonly requestId: string;
      readonly input: HashedSessionRotation;
    }
  | {
      readonly type: "authority.session-validate-refresh";
      readonly requestId: string;
      readonly currentRefreshTokenHash: string;
      readonly expectedPrincipal?: {
        readonly accountId: string;
        readonly actorId: string;
      };
      readonly now: number;
    }
  | {
      readonly type: "authority.session-revoke";
      readonly requestId: string;
      readonly accessTokenHash: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.sessions-list";
      readonly requestId: string;
      readonly accessTokenHash: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.session-revoke-target";
      readonly requestId: string;
      readonly accessTokenHash: string;
      readonly publicSessionId: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.execute-human";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly command: HumanCollaborationCommand | RoomGovernanceCommand;
      readonly invitationSecret?: {
        readonly tokenHash: string;
        readonly sealedToken: string;
      };
      readonly now: number;
    }
  | {
      readonly type: "authority.execute-human-governance";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly command: ClosedRoomGovernanceMutationCommand;
      readonly now: number;
    }
  | {
      readonly type: "authority.departure-conflicts";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly targetActorId: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.execute-agent";
      readonly requestId: string;
      readonly context: AgentWorkerCommandContext;
      readonly command: AgentCollaborationCommand;
      readonly now: number;
    }
  | {
      readonly type: "authority.attachment";
      readonly requestId: string;
      readonly operation: AttachmentDatabaseOperation;
      readonly now: number;
    }
  | {
      readonly type: "authority.message-submit";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly message: HumanMessageSubmit;
      readonly now: number;
    }
  | {
      readonly type: "authority.message-revise";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly command: MessageRevisionCommand;
      readonly now: number;
    }
  | {
      readonly type: "authority.message-recall";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly command: MessageRecallCommand;
      readonly now: number;
    }
  | {
      readonly type: "authority.agent-message-commit";
      readonly requestId: string;
      readonly context: AgentMessageWorkerContext;
      readonly command: AgentMessageCommitCommand;
      readonly now: number;
    }
  | {
      readonly type: "authority.message-history";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly query: MessageHistoryQuery;
      readonly now: number;
    }
  | {
      readonly type: "authority.message-revisions";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly query: MessageRevisionQuery;
      readonly now: number;
    }
  | {
      readonly type: "authority.read-history";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly now: number;
    }
  | { readonly type: "authority.read-actor"; readonly requestId: string; readonly actorId: string }
  | { readonly type: "authority.read-room"; readonly requestId: string; readonly roomId: string }
  | {
      readonly type: "authority.read-room-governance";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.can-access-room";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.read-room-audit";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly roomId: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.outbox-list";
      readonly requestId: string;
      readonly limit: number;
      readonly now: number;
    }
  | {
      readonly type: "authority.outbox-authorize";
      readonly requestId: string;
      readonly deliveryId: string;
      readonly candidate: OutboxDispatchCandidate;
      readonly now: number;
    }
  | {
      readonly type: "authority.outbox-dispatched";
      readonly requestId: string;
      readonly deliveryId: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.outbox-failed";
      readonly requestId: string;
      readonly deliveryId: string;
      readonly reason: "closed" | "backpressure" | "send_rejected";
    }
  | {
      readonly type: "authority.room-cache-invalidation-list";
      readonly requestId: string;
      readonly limit: number;
    }
  | {
      readonly type: "authority.room-cache-invalidation-completed";
      readonly requestId: string;
      readonly invalidationIntentId: string;
    }
  | {
      readonly type: "authority.room-cache-invalidation-failed";
      readonly requestId: string;
      readonly invalidationIntentId: string;
      readonly errorCode: "purge_failed" | "authority_unavailable";
    }
  | {
      readonly type: "authority.sync-room";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly request: RoomSyncRequest;
      readonly now: number;
    }
  | {
      readonly type: "authority.snapshot-revalidate";
      readonly requestId: string;
      readonly validation: SnapshotRevalidationRequest;
      readonly now: number;
    }
  | {
      readonly type: "authority.repair-acquire";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly scope: RepairScope;
      readonly now: number;
    }
  | {
      readonly type: "authority.repair-register";
      readonly requestId: string;
      readonly snapshotId: string;
      readonly checksum: string;
      readonly pageCount: number;
      readonly now: number;
    }
  | {
      readonly type: "authority.repair-authorize-page";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly snapshotId: string;
      readonly page: number;
      readonly now: number;
    }
  | {
      readonly type: "authority.repair-complete";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly snapshotId: string;
      readonly version: SnapshotVersion;
      readonly checksum: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.repair-release";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly snapshotId: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.compact-room-stream";
      readonly requestId: string;
      readonly roomId: string;
      readonly retainedFromSeq: number;
    }
  | {
      readonly type: "authority.runtime";
      readonly requestId: string;
      readonly operation: RuntimeAuthorityOperation;
    }
  | {
      readonly type: "authority.route";
      readonly requestId: string;
      readonly operation: RouteAuthorityOperation;
    }
  | {
      readonly type: "authority.ball";
      readonly requestId: string;
      readonly operation: BallAuthorityOperation;
    }
  | { readonly type: "authority.close"; readonly requestId: string };

export type AuthorityWorkerResponse =
  | {
      readonly type: "authority.ready";
      readonly requestId: string;
      readonly schemaVersion: 18;
    }
  | {
      readonly type: "authority.schema";
      readonly requestId: string;
      readonly schemaVersion: 18;
    }
  | {
      readonly type: "authority.legacy-imported";
      readonly requestId: string;
      readonly imported: boolean;
      readonly actors: number;
      readonly rooms: number;
      readonly messages: number;
    }
  | {
      readonly type: "authority.legacy-import";
      readonly requestId: string;
      readonly markerVersion: 1;
      readonly actors: number;
      readonly rooms: number;
      readonly messages: number;
      readonly roomHeadSeq: number;
      readonly identityHeadSeq: number;
    }
  | {
      readonly type: "authority.actors-registered";
      readonly requestId: string;
      readonly actorCount: number;
    }
  | {
      readonly type: "authority.session-issued";
      readonly requestId: string;
      readonly session: IssuedSessionRecord;
    }
  | {
      readonly type: "authority.session-authenticated";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
    }
  | {
      readonly type: "authority.session-rotated";
      readonly requestId: string;
      readonly session: IssuedSessionRecord;
    }
  | {
      readonly type: "authority.session-refresh-valid";
      readonly requestId: string;
    }
  | {
      readonly type: "authority.session-revoked";
      readonly requestId: string;
    }
  | {
      readonly type: "authority.sessions";
      readonly requestId: string;
      readonly sessions: readonly PublicSession[];
    }
  | {
      readonly type: "authority.session-target-revoked";
      readonly requestId: string;
      readonly publicSessionId: string;
    }
  | {
      readonly type: "authority.command-acknowledged";
      readonly requestId: string;
      readonly acknowledgement: CommandAcknowledgement;
    }
  | {
      readonly type: "authority.attachment-result";
      readonly requestId: string;
      readonly result: AttachmentDatabaseOperationResult;
    }
  | {
      readonly type: "authority.message-submitted";
      readonly requestId: string;
      readonly receipt: HumanMessageSubmissionReceipt;
    }
  | {
      readonly type: "authority.message-revised";
      readonly requestId: string;
      readonly receipt: MessageRevisionReceipt;
    }
  | {
      readonly type: "authority.message-recalled";
      readonly requestId: string;
      readonly receipt: MessageRecallReceipt;
    }
  | {
      readonly type: "authority.agent-message-committed";
      readonly requestId: string;
      readonly receipt: AgentMessageCommitReceipt;
    }
  | {
      readonly type: "authority.message-history";
      readonly requestId: string;
      readonly page: MessageHistoryPage;
    }
  | {
      readonly type: "authority.message-revisions";
      readonly requestId: string;
      readonly page: MessageRevisionPage;
    }
  | {
      readonly type: "authority.governance-acknowledged";
      readonly requestId: string;
      readonly acknowledgement: ClosedRoomGovernanceAcknowledgement;
    }
  | {
      readonly type: "authority.departure-conflicts";
      readonly requestId: string;
      readonly conflicts: DepartureConflictList;
    }
  | {
      readonly type: "authority.history";
      readonly requestId: string;
      readonly messages: readonly Message[];
    }
  | { readonly type: "authority.actor"; readonly requestId: string; readonly actor?: Actor }
  | { readonly type: "authority.room"; readonly requestId: string; readonly room?: ManagedRoom }
  | {
      readonly type: "authority.room-governance";
      readonly requestId: string;
      readonly governance: RoomGovernanceView;
    }
  | { readonly type: "authority.room-access"; readonly requestId: string; readonly allowed: boolean }
  | {
      readonly type: "authority.room-audit";
      readonly requestId: string;
      readonly audit: readonly RoomAuditRecord[];
    }
  | {
      readonly type: "authority.outbox";
      readonly requestId: string;
      readonly deliveries: readonly OutboxDelivery[];
    }
  | {
      readonly type: "authority.outbox-authorized";
      readonly requestId: string;
      readonly authorized: boolean;
    }
  | { readonly type: "authority.outbox-updated"; readonly requestId: string }
  | {
      readonly type: "authority.room-cache-invalidations";
      readonly requestId: string;
      readonly intents: readonly CommittedRoomCacheInvalidationIntent[];
    }
  | {
      readonly type: "authority.room-cache-invalidation-updated";
      readonly requestId: string;
    }
  | {
      readonly type: "authority.room-synced";
      readonly requestId: string;
      readonly result: RoomSyncResult;
    }
  | { readonly type: "authority.snapshot-revalidated"; readonly requestId: string }
  | {
      readonly type: "authority.repair-lease";
      readonly requestId: string;
      readonly lease: StreamingRepairLease;
    }
  | {
      readonly type: "authority.snapshot-completed";
      readonly requestId: string;
      readonly completed: SnapshotCompleted;
    }
  | { readonly type: "authority.repair-released"; readonly requestId: string }
  | {
      readonly type: "authority.room-stream-compacted";
      readonly requestId: string;
      readonly roomId: string;
      readonly retainedFromSeq: number;
      readonly headSeq: number;
    }
  | {
      readonly type: "authority.runtime-result";
      readonly requestId: string;
      readonly result: JsonValue;
    }
  | {
      readonly type: "authority.route-result";
      readonly requestId: string;
      readonly result: JsonValue;
    }
  | {
      readonly type: "authority.ball-result";
      readonly requestId: string;
      readonly result: JsonValue;
    }
  | { readonly type: "authority.closed"; readonly requestId: string }
  | {
      readonly type: "authority.error";
      readonly requestId: string;
      readonly code: Exclude<AuthorityWorkerErrorCode, "departure_blocked">;
      readonly message: string;
      readonly details?: never;
    }
  | {
      readonly type: "authority.error";
      readonly requestId: string;
      readonly code: "departure_blocked";
      readonly message: string;
      readonly details: DepartureConflictList;
    };

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

function hasRequestId(value: Record<string, unknown>): boolean {
  return typeof value.requestId === "string" && value.requestId.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoundedSessionText(value: unknown): value is string {
  return isText(value) && Buffer.byteLength(value, "utf8") <= 128;
}

function isSessionDevice(value: unknown): value is SessionDevice {
  return isRecord(value) &&
    hasExactKeys(value, ["id", "label", "platform"]) &&
    isBoundedSessionText(value.id) &&
    isBoundedSessionText(value.label) &&
    (value.platform === "macos" ||
      value.platform === "windows" ||
      value.platform === "linux" ||
      value.platform === "unknown");
}

function isPublicSession(value: unknown): value is PublicSession {
  return isRecord(value) &&
    hasExactKeys(value, [
      "id", "deviceLabel", "platform", "refreshExpiresAt", "current",
      ...(Object.hasOwn(value, "createdAt") ? ["createdAt"] : []),
    ]) &&
    isBoundedSessionText(value.id) &&
    isBoundedSessionText(value.deviceLabel) &&
    (value.platform === "macos" ||
      value.platform === "windows" ||
      value.platform === "linux" ||
      value.platform === "unknown") &&
    (!Object.hasOwn(value, "createdAt") || isText(value.createdAt)) &&
    isText(value.refreshExpiresAt) &&
    typeof value.current === "boolean";
}

function isTokenHash(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function isStrictActor(value: unknown): value is Actor {
  if (!isRecord(value) || !isActor(value)) {
    return false;
  }
  const expectedKeys =
    value.kind === "human"
      ? ["id", "kind", "displayName", "reachability"]
      : ["id", "kind", "displayName", "readiness", "toolPermissions"];
  return hasExactKeys(value, expectedKeys);
}

function isHashedSessionIssue(value: unknown): value is HashedSessionIssue {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "accountId",
      "actorId",
      "publicSessionId",
      "device",
      "accessTokenHash",
      "refreshTokenHash",
      "accessExpiresAt",
      "refreshExpiresAt",
      "now",
    ]) &&
    isText(value.accountId) &&
    isText(value.actorId) &&
    isBoundedSessionText(value.publicSessionId) &&
    isSessionDevice(value.device) &&
    isTokenHash(value.accessTokenHash) &&
    isTokenHash(value.refreshTokenHash) &&
    value.accessTokenHash !== value.refreshTokenHash &&
    isNonNegativeSafeInteger(value.accessExpiresAt) &&
    isNonNegativeSafeInteger(value.refreshExpiresAt) &&
    value.refreshExpiresAt > value.accessExpiresAt &&
    isNonNegativeSafeInteger(value.now)
  );
}

function isIssuedSessionRecord(value: unknown): value is IssuedSessionRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "sessionId",
      "familyId",
      "publicSessionId",
      "accountId",
      "actorId",
      "accessExpiresAt",
      "refreshExpiresAt",
    ]) &&
    isTokenHash(value.sessionId) &&
    isTokenHash(value.familyId) &&
    isBoundedSessionText(value.publicSessionId) &&
    isText(value.accountId) &&
    isText(value.actorId) &&
    isNonNegativeSafeInteger(value.accessExpiresAt) &&
    isNonNegativeSafeInteger(value.refreshExpiresAt)
  );
}

function isPrincipal(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["accountId", "actorId"]) &&
    isText(value.accountId) &&
    isText(value.actorId)
  );
}

function isHashedSessionRotation(value: unknown): value is HashedSessionRotation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "currentRefreshTokenHash",
      "accessTokenHash",
      "refreshTokenHash",
      "accessExpiresAt",
      "refreshExpiresAt",
      "now",
      ...(Object.hasOwn(value, "expectedPrincipal") ? ["expectedPrincipal"] : []),
    ]) &&
    isTokenHash(value.currentRefreshTokenHash) &&
    isTokenHash(value.accessTokenHash) &&
    isTokenHash(value.refreshTokenHash) &&
    value.accessTokenHash !== value.refreshTokenHash &&
    isNonNegativeSafeInteger(value.accessExpiresAt) &&
    isNonNegativeSafeInteger(value.refreshExpiresAt) &&
    value.refreshExpiresAt > value.accessExpiresAt &&
    isNonNegativeSafeInteger(value.now) &&
    (!Object.hasOwn(value, "expectedPrincipal") || isPrincipal(value.expectedPrincipal))
  );
}

function isAuthenticatedSessionContext(
  value: unknown,
): value is AuthenticatedSessionContext {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sessionId", "sessionFamilyId", "principal"]) &&
    isTokenHash(value.sessionId) &&
    isTokenHash(value.sessionFamilyId) &&
    isRecord(value.principal) &&
    hasExactKeys(value.principal, ["accountId", "actorId"]) &&
    isText(value.principal.accountId) &&
    isText(value.principal.actorId)
  );
}

function isSnapshotRevalidationRequest(
  value: unknown,
): value is SnapshotRevalidationRequest {
  if (!isRecord(value) || !isAuthenticatedSessionContext(value.context)) {
    return false;
  }
  if (value.kind === "room") {
    return hasExactKeys(value, [
      "kind", "context", "roomId", "accessRevision", "watermark",
    ]) && isText(value.roomId) && isNonNegativeSafeInteger(value.accessRevision) &&
      isNonNegativeSafeInteger(value.watermark);
  }
  return value.kind === "catalog" &&
    hasExactKeys(value, ["kind", "context", "catalogRevision"]) &&
    isNonNegativeSafeInteger(value.catalogRevision);
}

function isRepairScope(value: unknown): value is RepairScope {
  return isRecord(value) && (
    (value.kind === "room" && hasExactKeys(value, ["kind", "roomId"]) &&
      isText(value.roomId)) ||
    (value.kind === "catalog" && hasExactKeys(value, ["kind", "principalId"]) &&
      isText(value.principalId))
  );
}

function isStreamingRepairLease(value: unknown): value is StreamingRepairLease {
  if (!isRecord(value) || !hasExactKeys(value, [
    "snapshotId", "principalId", "accountId", "sessionFamilyId", "scope",
    "version", "authorizationRevision", "idleExpiresAt",
    ...(Object.hasOwn(value, "checksum") ? ["checksum"] : []),
    ...(Object.hasOwn(value, "pageCount") ? ["pageCount"] : []),
    ...(Object.hasOwn(value, "lastPage") ? ["lastPage"] : []),
    ...(Object.hasOwn(value, "highestAuthorizedPage") ? ["highestAuthorizedPage"] : []),
  ])) return false;
  const attached = Object.hasOwn(value, "checksum") || Object.hasOwn(value, "pageCount") ||
    Object.hasOwn(value, "lastPage") || Object.hasOwn(value, "highestAuthorizedPage");
  return isText(value.snapshotId) && isText(value.principalId) &&
    isText(value.accountId) && isTokenHash(value.sessionFamilyId) &&
    isRepairScope(value.scope) && isSnapshotVersion(value.version) &&
    isNonNegativeSafeInteger(value.authorizationRevision) &&
    isText(value.idleExpiresAt) &&
    (!attached || (isText(value.checksum) && isNonNegativeSafeInteger(value.pageCount) &&
      value.pageCount > 0 && isNonNegativeSafeInteger(value.lastPage) &&
      value.lastPage === value.pageCount - 1 &&
      typeof value.highestAuthorizedPage === "number" &&
      Number.isSafeInteger(value.highestAuthorizedPage) && value.highestAuthorizedPage >= -1 &&
      value.highestAuthorizedPage <= value.lastPage));
}

function isAuthenticatedCommandContext(
  value: unknown,
): value is AuthenticatedCommandContext {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "kind",
      "sessionId",
      "sessionFamilyId",
      "principal",
      "requestId",
      "idempotencyKey",
    ]) &&
    value.kind === "human" &&
    isTokenHash(value.sessionId) &&
    isTokenHash(value.sessionFamilyId) &&
    isPrincipal(value.principal) &&
    isText(value.requestId) &&
    isText(value.idempotencyKey)
  );
}

function isAgentWorkerCommandContext(value: unknown): value is AgentWorkerCommandContext {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "agent", "requestId", "idempotencyKey"]) &&
    value.kind === "agent" &&
    isRecord(value.agent) &&
    hasExactKeys(value.agent, ["actorId", "kind"]) &&
    value.agent.kind === "agent" &&
    isText(value.agent.actorId) &&
    isText(value.requestId) &&
    isText(value.idempotencyKey)
  );
}

function isHumanCommand(value: unknown): value is HumanCollaborationCommand | RoomGovernanceCommand {
  const parsed = parsePersistentCommand(value);
  if (!parsed.ok) {
    return false;
  }
  return parsed.value.type !== "agent.judgment.record" &&
    parsed.value.type !== "agent.execution.transition" &&
    parsed.value.type !== "open-item.propose" &&
    parsed.value.type !== "open-item.agent-failure.record";
}

function isAgentCommand(value: unknown): value is AgentCollaborationCommand {
  const parsed = parsePersistentCommand(value);
  if (!parsed.ok) {
    return false;
  }
  return parsed.value.type === "message.send" ||
    parsed.value.type === "agent.judgment.record" ||
    parsed.value.type === "open-item.propose" ||
    parsed.value.type === "open-item.transition" ||
    parsed.value.type === "open-item.agent-failure.record" ||
    parsed.value.type === "agent.execution.transition";
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isCommandAcknowledgement(value: unknown): value is CommandAcknowledgement {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["aggregateId", "eventIds", "acceptedAt", "result"]) &&
    isText(value.aggregateId) &&
    Array.isArray(value.eventIds) &&
    value.eventIds.every(isText) &&
    isText(value.acceptedAt) &&
    isJsonValue(value.result)
  );
}

function isRevisionCommand(value: unknown): value is MessageRevisionCommand {
  return isRecord(value) && hasExactKeys(
    value, ["roomId", "messageId", "expectedRevision", "body"],
  ) && isText(value.roomId) && isMessageRevision({
    messageId: value.messageId,
    revision: value.expectedRevision,
    body: value.body,
    revisedAt: "1970-01-01T00:00:00.000Z",
    revisedByActorId: "authority-validation",
  });
}

function isRecallCommand(value: unknown): value is MessageRecallCommand {
  return isRecord(value) && hasExactKeys(
    value, ["roomId", "messageId", "expectedRevision"],
  ) && isText(value.roomId) && isText(value.messageId) &&
    Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) > 0;
}

function isAgentMessageWorkerContext(value: unknown): value is AgentMessageWorkerContext {
  return isRecord(value) && hasExactKeys(value, [
    "kind", "agent", "invocationIntentId", "executionId", "attemptSeq", "executionGeneration",
  ]) && value.kind === "agent-message" && isRecord(value.agent) &&
    hasExactKeys(value.agent, ["actorId", "kind"]) && value.agent.kind === "agent" &&
    isText(value.agent.actorId) && isText(value.invocationIntentId) &&
    isText(value.executionId) && Number.isSafeInteger(value.attemptSeq) &&
    Number(value.attemptSeq) > 0 && Number.isSafeInteger(value.executionGeneration) &&
    Number(value.executionGeneration) > 0;
}

function isAgentMessageCommand(value: unknown): value is AgentMessageCommitCommand {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["messageId", "roomId", "body", ...(Object.hasOwn(value, "correctsMessageId")
      ? ["correctsMessageId"]
      : [])],
  )) return false;
  return isAgentFinalMessage({
    id: value.messageId,
    roomId: value.roomId,
    authorId: "authority-agent",
    authorKind: "agent",
    createdAt: "1970-01-01T00:00:00.000Z",
    lifecycle: "active",
    finalBody: value.body,
    sourceInvocationIntentId: "authority-intent",
    sourceExecutionId: "authority-execution",
    ...(Object.hasOwn(value, "correctsMessageId")
      ? { correctsMessageId: value.correctsMessageId }
      : {}),
  });
}

function isMessageHistoryQuery(value: unknown): value is MessageHistoryQuery {
  return isRecord(value) && hasExactKeys(value, [
    "roomId",
    ...(Object.hasOwn(value, "afterMessageId") ? ["afterMessageId"] : []),
    ...(Object.hasOwn(value, "limit") ? ["limit"] : []),
  ]) && isText(value.roomId) &&
    (!Object.hasOwn(value, "afterMessageId") || isText(value.afterMessageId)) &&
    (!Object.hasOwn(value, "limit") ||
      (Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 200));
}

function isMessageRevisionQuery(value: unknown): value is MessageRevisionQuery {
  return isRecord(value) && hasExactKeys(value, [
    "roomId", "messageId",
    ...(Object.hasOwn(value, "afterRevision") ? ["afterRevision"] : []),
    ...(Object.hasOwn(value, "limit") ? ["limit"] : []),
  ]) && isText(value.roomId) && isText(value.messageId) &&
    (!Object.hasOwn(value, "afterRevision") ||
      (Number.isSafeInteger(value.afterRevision) && Number(value.afterRevision) >= 0)) &&
    (!Object.hasOwn(value, "limit") ||
      (Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 200));
}

function isMutationReceipt(value: unknown): value is MessageRevisionReceipt {
  return isRecord(value) && hasExactKeys(value, [
    "messageId", "persistedAt", "eventId", "replayed", "revision",
  ]) && isText(value.messageId) && isIsoUtcTimestamp(value.persistedAt) &&
    isText(value.eventId) && typeof value.replayed === "boolean" &&
    Number.isSafeInteger(value.revision) && Number(value.revision) > 0;
}

function isSubmissionReceipt(value: unknown): value is HumanMessageSubmissionReceipt {
  return isRecord(value) && hasExactKeys(value, [
    "messageId", "persistedAt", "eventId", "replayed", "targetOutcomes",
  ]) && isText(value.messageId) && isIsoUtcTimestamp(value.persistedAt) &&
    isText(value.eventId) && typeof value.replayed === "boolean" &&
    Array.isArray(value.targetOutcomes) && value.targetOutcomes.every(isMessageTargetOutcome);
}

function isRecallReceipt(value: unknown): value is MessageRecallReceipt {
  return isRecord(value) && hasExactKeys(value, [
    "messageId", "revision", "recalledAt", "eventId", "replayed", "abortTargets",
  ]) && isText(value.messageId) && Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0 && isIsoUtcTimestamp(value.recalledAt) &&
    isText(value.eventId) && typeof value.replayed === "boolean" &&
    Array.isArray(value.abortTargets) && value.abortTargets.length <= 256 &&
    value.abortTargets.every((target) => isRecord(target) && hasExactKeys(target, [
      "sourceMessageId", "sourceRevision", "invocationIntentId", "executionId",
      "attemptSeq", "cancellationReason", "sideEffectState",
    ]) && isText(target.sourceMessageId) &&
      Number.isSafeInteger(target.sourceRevision) && Number(target.sourceRevision) > 0 &&
      isText(target.invocationIntentId) && isText(target.executionId) &&
      Number.isSafeInteger(target.attemptSeq) && Number(target.attemptSeq) > 0 &&
      target.cancellationReason === "message_recalled" &&
      (target.sideEffectState === "none" ||
        target.sideEffectState === "dispatched-retained" ||
        target.sideEffectState === "outcome-unknown-retained")) &&
    new Set(value.abortTargets.map((target) => target.executionId)).size ===
      value.abortTargets.length;
}

function isAgentMessageReceipt(value: unknown): value is AgentMessageCommitReceipt {
  return isRecord(value) && hasExactKeys(value, [
    "messageId", "persistedAt", "eventId", "replayed", "message",
  ]) && isText(value.messageId) && isIsoUtcTimestamp(value.persistedAt) &&
    isText(value.eventId) && typeof value.replayed === "boolean" &&
    isAgentFinalMessage(value.message) && value.message.id === value.messageId;
}

function isMessageHistoryPage(value: unknown): value is MessageHistoryPage {
  return isRecord(value) && hasExactKeys(value, [
    "messages", "hasMore", "lifecycle", "actors",
  ]) &&
    Array.isArray(value.messages) && value.messages.every(isTimelineMessage) &&
    typeof value.hasMore === "boolean" &&
    (value.lifecycle === "active" || value.lifecycle === "archived") &&
    Array.isArray(value.actors) && value.actors.length <= 512 &&
    value.actors.every((actor) => isRecord(actor) && hasExactKeys(actor, [
      "actorId", "kind", "displayName", "secondaryLabel",
    ]) && isText(actor.actorId) && (actor.kind === "human" || actor.kind === "agent") &&
      isText(actor.displayName) && isText(actor.secondaryLabel)) &&
    new Set(value.actors.map((actor) => actor.actorId)).size === value.actors.length;
}

function isMessageRevisionPage(value: unknown): value is MessageRevisionPage {
  return isRecord(value) && hasExactKeys(value, ["revisions", "hasMore"]) &&
    Array.isArray(value.revisions) && value.revisions.every(isMessageRevision) &&
    typeof value.hasMore === "boolean";
}

function isClosedRoomGovernanceAcknowledgement(
  value: unknown,
): value is ClosedRoomGovernanceAcknowledgement {
  return isRecord(value) &&
    hasExactKeys(value, ["governance", "eventIds", "replayed"]) &&
    isRoomGovernanceView(value.governance) && Array.isArray(value.eventIds) &&
    value.eventIds.length <= 1_024 && value.eventIds.every(isText) &&
    new Set(value.eventIds).size === value.eventIds.length &&
    typeof value.replayed === "boolean";
}

function isOutboxDispatchCandidate(value: unknown): value is OutboxDispatchCandidate {
  return isRecord(value) &&
    hasExactKeys(value, [
      "connectionId",
      "principal",
      "sessionId",
      "sessionFamilyId",
      "credentialGeneration",
    ]) &&
    isText(value.connectionId) &&
    isPrincipal(value.principal) &&
    isTokenHash(value.sessionId) &&
    isTokenHash(value.sessionFamilyId) &&
    isNonNegativeSafeInteger(value.credentialGeneration);
}

function isOutboxDelivery(value: unknown): value is OutboxDelivery {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "deliveryId",
      "eventId",
      "targetKind",
      "targetId",
      "streamSeq",
      "attempts",
      "event",
    ]) ||
    !isText(value.deliveryId) ||
    !isText(value.eventId) ||
    (value.targetKind !== "room" &&
      value.targetKind !== "principal" &&
      value.targetKind !== "session-family") ||
    !isText(value.targetId) ||
    !isNonNegativeSafeInteger(value.streamSeq) ||
    value.streamSeq < 1 ||
    !isNonNegativeSafeInteger(value.attempts)
  ) {
    return false;
  }
  const parsedEvent = value.targetKind === "room"
    ? parsePersistedRoomEvent(value.event)
    : parsePersistedIdentityEvent(value.event);
  const event = parsedEvent.ok ? parsedEvent.value : undefined;
  if (
    event === undefined ||
    event.eventId !== value.eventId ||
    event.streamSeq !== value.streamSeq
  ) {
    return false;
  }
  if (value.targetKind === "room") {
    return event.streamKind === "room" && event.roomId === value.targetId;
  }
  if (value.targetKind === "principal") {
    return event.streamKind === "identity" &&
      event.streamId === value.targetId &&
      (event.type === "identity.room-access.changed" ||
        event.type === "attachment.private.status-changed");
  }
  return event.streamKind === "identity" &&
    event.type === "identity.session.revoked" &&
    event.payload.familyId === value.targetId;
}

function isCommittedRoomCacheInvalidationIntent(
  value: unknown,
): value is CommittedRoomCacheInvalidationIntent {
  if (!isRecord(value) || !isText(value.invalidationIntentId) || !isText(value.roomId) ||
      !isNonNegativeSafeInteger(value.lifecycleGeneration) ||
      !isNonNegativeSafeInteger(value.accessRevision)) return false;
  if (value.reason === "room_archived") return hasExactKeys(value, [
    "invalidationIntentId", "roomId", "lifecycleGeneration", "accessRevision", "reason",
  ]);
  return (value.reason === "member_removed" || value.reason === "access_revoked") &&
    hasExactKeys(value, [
      "invalidationIntentId", "roomId", "lifecycleGeneration", "accessRevision", "reason",
      "targetActorId",
    ]) && isText(value.targetActorId);
}

export function isAuthorityWorkerRequest(value: unknown): value is AuthorityWorkerRequest {
  if (!isRecord(value) || !hasRequestId(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "authority.initialize":
    case "authority.inspect-schema":
    case "authority.inspect-legacy-import":
    case "authority.close":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.import-legacy":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "sessionFilePath",
          "roomFilePath",
          "messageFilePath",
        ]) &&
        typeof value.sessionFilePath === "string" &&
        value.sessionFilePath.length > 0 &&
        typeof value.roomFilePath === "string" &&
        value.roomFilePath.length > 0 &&
        typeof value.messageFilePath === "string" &&
        value.messageFilePath.length > 0
      );
    case "authority.register-actors":
      return (
        hasExactKeys(value, ["type", "requestId", "actors"]) &&
        Array.isArray(value.actors) &&
        value.actors.length > 0 &&
        value.actors.every(isStrictActor) &&
        new Set(value.actors.map((actor) => actor.id)).size === value.actors.length
      );
    case "authority.session-issue":
      return (
        hasExactKeys(value, ["type", "requestId", "input"]) &&
        isHashedSessionIssue(value.input)
      );
    case "authority.session-authenticate":
      return (
        hasExactKeys(value, ["type", "requestId", "accessTokenHash", "now"]) &&
        isTokenHash(value.accessTokenHash) &&
        isNonNegativeSafeInteger(value.now)
      );
    case "authority.session-rotate":
      return (
        hasExactKeys(value, ["type", "requestId", "input"]) &&
        isHashedSessionRotation(value.input)
      );
    case "authority.session-validate-refresh":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "currentRefreshTokenHash",
          "now",
          ...(Object.hasOwn(value, "expectedPrincipal") ? ["expectedPrincipal"] : []),
        ]) &&
        isTokenHash(value.currentRefreshTokenHash) &&
        isNonNegativeSafeInteger(value.now) &&
        (!Object.hasOwn(value, "expectedPrincipal") || isPrincipal(value.expectedPrincipal))
      );
    case "authority.session-revoke":
      return (
        hasExactKeys(value, ["type", "requestId", "accessTokenHash", "now"]) &&
        isTokenHash(value.accessTokenHash) &&
        isNonNegativeSafeInteger(value.now)
      );
    case "authority.sessions-list":
      return (
        hasExactKeys(value, ["type", "requestId", "accessTokenHash", "now"]) &&
        isTokenHash(value.accessTokenHash) &&
        isNonNegativeSafeInteger(value.now)
      );
    case "authority.session-revoke-target":
      return (
        hasExactKeys(value, [
          "type", "requestId", "accessTokenHash", "publicSessionId", "now",
        ]) &&
        isTokenHash(value.accessTokenHash) &&
        isBoundedSessionText(value.publicSessionId) &&
        isNonNegativeSafeInteger(value.now)
      );
    case "authority.execute-human":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "context",
          "command",
          "now",
          ...(Object.hasOwn(value, "invitationSecret") ? ["invitationSecret"] : []),
        ]) &&
        isAuthenticatedCommandContext(value.context) &&
        isHumanCommand(value.command) &&
        ((value.command.type === "human.invitation.issue" &&
          isRecord(value.invitationSecret) &&
          hasExactKeys(value.invitationSecret, ["tokenHash", "sealedToken"]) &&
          isTokenHash(value.invitationSecret.tokenHash) &&
          isText(value.invitationSecret.sealedToken)) ||
          (value.command.type !== "human.invitation.issue" &&
            !Object.hasOwn(value, "invitationSecret"))) &&
        isNonNegativeSafeInteger(value.now)
      );
    case "authority.execute-human-governance": {
      const parsed = parseClosedRoomGovernanceMutationCommand(value.command);
      return hasExactKeys(value, ["type", "requestId", "context", "command", "now"]) &&
        isAuthenticatedCommandContext(value.context) && parsed.ok &&
        isNonNegativeSafeInteger(value.now);
    }
    case "authority.departure-conflicts":
      return hasExactKeys(value, [
        "type", "requestId", "context", "roomId", "targetActorId", "now",
      ]) && isAuthenticatedSessionContext(value.context) && isText(value.roomId) &&
        isText(value.targetActorId) && isNonNegativeSafeInteger(value.now);
    case "authority.execute-agent":
      return (
        hasExactKeys(value, ["type", "requestId", "context", "command", "now"]) &&
        isAgentWorkerCommandContext(value.context) &&
        isAgentCommand(value.command) &&
        isNonNegativeSafeInteger(value.now)
      );
    case "authority.attachment":
      return hasExactKeys(value, ["type", "requestId", "operation", "now"]) &&
        isAttachmentDatabaseOperation(value.operation) && isNonNegativeSafeInteger(value.now);
    case "authority.message-submit":
      return hasExactKeys(value, ["type", "requestId", "context", "message", "now"]) &&
        isAuthenticatedCommandContext(value.context) && isHumanMessageSubmit(value.message) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.message-revise":
      return hasExactKeys(value, ["type", "requestId", "context", "command", "now"]) &&
        isAuthenticatedCommandContext(value.context) && isRevisionCommand(value.command) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.message-recall":
      return hasExactKeys(value, ["type", "requestId", "context", "command", "now"]) &&
        isAuthenticatedCommandContext(value.context) && isRecallCommand(value.command) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.agent-message-commit":
      return hasExactKeys(value, ["type", "requestId", "context", "command", "now"]) &&
        isAgentMessageWorkerContext(value.context) && isAgentMessageCommand(value.command) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.message-history":
      return hasExactKeys(value, ["type", "requestId", "context", "query", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isMessageHistoryQuery(value.query) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.message-revisions":
      return hasExactKeys(value, ["type", "requestId", "context", "query", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isMessageRevisionQuery(value.query) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.read-history":
      return hasExactKeys(value, ["type", "requestId", "context", "roomId", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isText(value.roomId) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.read-actor":
      return hasExactKeys(value, ["type", "requestId", "actorId"]) && isText(value.actorId);
    case "authority.read-room":
      return hasExactKeys(value, ["type", "requestId", "roomId"]) && isText(value.roomId);
    case "authority.read-room-governance":
      return hasExactKeys(value, ["type", "requestId", "context", "roomId", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isText(value.roomId) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.can-access-room":
    case "authority.read-room-audit":
      return hasExactKeys(value, ["type", "requestId", "context", "roomId", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isText(value.roomId) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.outbox-list":
      return hasExactKeys(value, ["type", "requestId", "limit", "now"]) &&
        isNonNegativeSafeInteger(value.limit) && value.limit > 0 && value.limit <= 1_000 &&
        isNonNegativeSafeInteger(value.now);
    case "authority.outbox-authorize":
      return hasExactKeys(value, ["type", "requestId", "deliveryId", "candidate", "now"]) &&
        isText(value.deliveryId) && isOutboxDispatchCandidate(value.candidate) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.outbox-dispatched":
      return hasExactKeys(value, ["type", "requestId", "deliveryId", "now"]) &&
        isText(value.deliveryId) && isNonNegativeSafeInteger(value.now);
    case "authority.outbox-failed":
      return hasExactKeys(value, ["type", "requestId", "deliveryId", "reason"]) &&
        isText(value.deliveryId) &&
        (value.reason === "closed" ||
          value.reason === "backpressure" ||
          value.reason === "send_rejected");
    case "authority.room-cache-invalidation-list":
      return hasExactKeys(value, ["type", "requestId", "limit"]) &&
        isNonNegativeSafeInteger(value.limit) && value.limit > 0 && value.limit <= 256;
    case "authority.room-cache-invalidation-completed":
      return hasExactKeys(value, ["type", "requestId", "invalidationIntentId"]) &&
        isText(value.invalidationIntentId);
    case "authority.room-cache-invalidation-failed":
      return hasExactKeys(value, [
        "type", "requestId", "invalidationIntentId", "errorCode",
      ]) && isText(value.invalidationIntentId) &&
        (value.errorCode === "purge_failed" || value.errorCode === "authority_unavailable");
    case "authority.sync-room": {
      const parsed = parseRoomSyncRequest(value.request);
      return hasExactKeys(value, ["type", "requestId", "context", "request", "now"]) &&
        isAuthenticatedSessionContext(value.context) && parsed.ok &&
        (parsed.value.cursor === undefined ||
          parsed.value.cursor.roomId === parsed.value.roomId) &&
        isNonNegativeSafeInteger(value.now);
    }
    case "authority.snapshot-revalidate":
      return hasExactKeys(value, ["type", "requestId", "validation", "now"]) &&
        isSnapshotRevalidationRequest(value.validation) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.repair-acquire":
      return hasExactKeys(value, ["type", "requestId", "context", "scope", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isRepairScope(value.scope) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.repair-register":
      return hasExactKeys(value, ["type", "requestId", "snapshotId", "checksum", "pageCount", "now"]) &&
        isText(value.snapshotId) &&
        isText(value.checksum) && isNonNegativeSafeInteger(value.pageCount) &&
        value.pageCount > 0 &&
        isNonNegativeSafeInteger(value.now);
    case "authority.repair-authorize-page":
      return hasExactKeys(value, ["type", "requestId", "context", "snapshotId", "page", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isText(value.snapshotId) &&
        isNonNegativeSafeInteger(value.page) && isNonNegativeSafeInteger(value.now);
    case "authority.repair-complete":
      return hasExactKeys(value, ["type", "requestId", "context", "snapshotId", "version", "checksum", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isText(value.snapshotId) &&
        isSnapshotVersion(value.version) && isText(value.checksum) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.repair-release":
      return hasExactKeys(value, ["type", "requestId", "context", "snapshotId", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isText(value.snapshotId) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.compact-room-stream":
      return hasExactKeys(value, ["type", "requestId", "roomId", "retainedFromSeq"]) &&
        isText(value.roomId) && isNonNegativeSafeInteger(value.retainedFromSeq) &&
        value.retainedFromSeq >= 1;
    case "authority.runtime":
      return hasExactKeys(value, ["type", "requestId", "operation"]) &&
        isRuntimeAuthorityOperation(value.operation);
    case "authority.route":
      return hasExactKeys(value, ["type", "requestId", "operation"]) &&
        isRouteAuthorityOperation(value.operation);
    case "authority.ball":
      return hasExactKeys(value, ["type", "requestId", "operation"]) &&
        isBallAuthorityOperation(value.operation);
    default:
      return false;
  }
}

export function isAuthorityWorkerResponse(
  value: unknown,
): value is AuthorityWorkerResponse {
  if (!isRecord(value) || !hasRequestId(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "authority.ready":
    case "authority.schema":
      return (
        hasExactKeys(value, ["type", "requestId", "schemaVersion"]) &&
        value.schemaVersion === 18
      );
    case "authority.closed":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.actors-registered":
      return (
        hasExactKeys(value, ["type", "requestId", "actorCount"]) &&
        isNonNegativeSafeInteger(value.actorCount)
      );
    case "authority.session-issued":
      return (
        hasExactKeys(value, ["type", "requestId", "session"]) &&
        isIssuedSessionRecord(value.session)
      );
    case "authority.session-authenticated":
      return (
        hasExactKeys(value, ["type", "requestId", "context"]) &&
        isAuthenticatedSessionContext(value.context)
      );
    case "authority.session-rotated":
      return (
        hasExactKeys(value, ["type", "requestId", "session"]) &&
        isIssuedSessionRecord(value.session)
      );
    case "authority.session-refresh-valid":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.session-revoked":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.sessions":
      return hasExactKeys(value, ["type", "requestId", "sessions"]) &&
        Array.isArray(value.sessions) &&
        value.sessions.length <= MAX_ACTIVE_SESSION_FAMILIES &&
        value.sessions.every(isPublicSession);
    case "authority.session-target-revoked":
      return hasExactKeys(value, ["type", "requestId", "publicSessionId"]) &&
        isBoundedSessionText(value.publicSessionId);
    case "authority.command-acknowledged":
      return (
        hasExactKeys(value, ["type", "requestId", "acknowledgement"]) &&
        isCommandAcknowledgement(value.acknowledgement)
      );
    case "authority.attachment-result":
      return hasExactKeys(value, ["type", "requestId", "result"]) &&
        isAttachmentDatabaseOperationResult(value.result);
    case "authority.message-submitted":
      return hasExactKeys(value, ["type", "requestId", "receipt"]) &&
        isSubmissionReceipt(value.receipt);
    case "authority.message-revised":
      return hasExactKeys(value, ["type", "requestId", "receipt"]) &&
        isMutationReceipt(value.receipt);
    case "authority.message-recalled":
      return hasExactKeys(value, ["type", "requestId", "receipt"]) &&
        isRecallReceipt(value.receipt);
    case "authority.agent-message-committed":
      return hasExactKeys(value, ["type", "requestId", "receipt"]) &&
        isAgentMessageReceipt(value.receipt);
    case "authority.message-history":
      return hasExactKeys(value, ["type", "requestId", "page"]) &&
        isMessageHistoryPage(value.page);
    case "authority.message-revisions":
      return hasExactKeys(value, ["type", "requestId", "page"]) &&
        isMessageRevisionPage(value.page);
    case "authority.governance-acknowledged":
      return hasExactKeys(value, ["type", "requestId", "acknowledgement"]) &&
        isClosedRoomGovernanceAcknowledgement(value.acknowledgement);
    case "authority.departure-conflicts":
      return hasExactKeys(value, ["type", "requestId", "conflicts"]) &&
        isDepartureConflictList(value.conflicts);
    case "authority.history":
      return hasExactKeys(value, ["type", "requestId", "messages"]) &&
        Array.isArray(value.messages) && value.messages.every(isMessage);
    case "authority.actor":
      return hasExactKeys(
        value,
        ["type", "requestId", ...(Object.hasOwn(value, "actor") ? ["actor"] : [])],
      ) && (!Object.hasOwn(value, "actor") || isStrictActor(value.actor));
    case "authority.room":
      return hasExactKeys(
        value,
        ["type", "requestId", ...(Object.hasOwn(value, "room") ? ["room"] : [])],
      ) && (!Object.hasOwn(value, "room") || isManagedRoomShape(value.room));
    case "authority.room-governance":
      return hasExactKeys(value, ["type", "requestId", "governance"]) &&
        isRoomGovernanceView(value.governance);
    case "authority.room-access":
      return hasExactKeys(value, ["type", "requestId", "allowed"]) &&
        typeof value.allowed === "boolean";
    case "authority.room-audit":
      return hasExactKeys(value, ["type", "requestId", "audit"]) &&
        Array.isArray(value.audit) && value.audit.every(isRoomAuditRecord);
    case "authority.outbox":
      return hasExactKeys(value, ["type", "requestId", "deliveries"]) &&
        Array.isArray(value.deliveries) && value.deliveries.every(isOutboxDelivery);
    case "authority.outbox-authorized":
      return hasExactKeys(value, ["type", "requestId", "authorized"]) &&
        typeof value.authorized === "boolean";
    case "authority.outbox-updated":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.room-cache-invalidations":
      return hasExactKeys(value, ["type", "requestId", "intents"]) &&
        Array.isArray(value.intents) && value.intents.length <= 256 &&
        value.intents.every(isCommittedRoomCacheInvalidationIntent);
    case "authority.room-cache-invalidation-updated":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.room-synced":
      return hasExactKeys(value, ["type", "requestId", "result"]) &&
        isRoomSyncResult(value.result);
    case "authority.snapshot-revalidated":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.repair-lease":
      return hasExactKeys(value, ["type", "requestId", "lease"]) &&
        isStreamingRepairLease(value.lease);
    case "authority.snapshot-completed":
      return hasExactKeys(value, ["type", "requestId", "completed"]) &&
        isSnapshotCompleted(value.completed);
    case "authority.repair-released":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.room-stream-compacted":
      return hasExactKeys(
        value,
        ["type", "requestId", "roomId", "retainedFromSeq", "headSeq"],
      ) && isText(value.roomId) &&
        isNonNegativeSafeInteger(value.retainedFromSeq) && value.retainedFromSeq >= 1 &&
        isNonNegativeSafeInteger(value.headSeq) &&
        value.retainedFromSeq <= value.headSeq + 1;
    case "authority.runtime-result":
      return hasExactKeys(value, ["type", "requestId", "result"]) &&
        isJsonValue(value.result);
    case "authority.route-result":
      return hasExactKeys(value, ["type", "requestId", "result"]) &&
        isJsonValue(value.result);
    case "authority.ball-result":
      return hasExactKeys(value, ["type", "requestId", "result"]) &&
        isJsonValue(value.result);
    case "authority.legacy-imported":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "imported",
          "actors",
          "rooms",
          "messages",
        ]) &&
        typeof value.imported === "boolean" &&
        isNonNegativeSafeInteger(value.actors) &&
        isNonNegativeSafeInteger(value.rooms) &&
        isNonNegativeSafeInteger(value.messages)
      );
    case "authority.legacy-import":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "markerVersion",
          "actors",
          "rooms",
          "messages",
          "roomHeadSeq",
          "identityHeadSeq",
        ]) &&
        value.markerVersion === 1 &&
        isNonNegativeSafeInteger(value.actors) &&
        isNonNegativeSafeInteger(value.rooms) &&
        isNonNegativeSafeInteger(value.messages) &&
        isNonNegativeSafeInteger(value.roomHeadSeq) &&
        isNonNegativeSafeInteger(value.identityHeadSeq)
      );
    case "authority.error":
      return typeof value.message === "string" && value.message.length > 0 &&
        isAuthorityWorkerErrorCode(value.code) &&
        (value.code === "departure_blocked"
          ? hasExactKeys(value, ["type", "requestId", "code", "message", "details"]) &&
            isDepartureConflictList(value.details)
          : hasExactKeys(value, ["type", "requestId", "code", "message"]));
    default:
      return false;
  }
}
