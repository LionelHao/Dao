import {
  isActor,
  isAgentExecution,
  isMessage,
  isRoomSyncResult,
  isSnapshotCompleted,
  isSnapshotVersion,
} from "@native-im/core";
import type {
  AgentExecution,
  Actor,
  ManagedRoom,
  Message,
  RoomSyncRequest,
  RoomSyncResult,
  SnapshotCompleted,
  SnapshotVersion,
} from "@native-im/core";
import {
  isManagedRoomShape,
  isRoomAuditRecord,
  type RoomAuditRecord,
} from "../room-lifecycle.js";
import {
  parsePersistedIdentityEvent,
  parsePersistedRoomEvent,
  parsePersistentCommand,
  parseRoomSyncRequest,
} from "./contracts.js";
import type {
  AgentCollaborationCommand,
  AgentInvocationInput,
  AgentRuntimeRecovery,
  AgentRuntimeRecoveryPage,
  AgentRuntimeRecoveryPageInput,
  AgentRuntimeProviderContext,
  AgentRuntimeToolPlanEntry,
  CommitExecutionStepInput,
  CompleteExecutionInput,
  CompleteCompensationInput,
  FailExecutionInput,
  ScheduleRetryInput,
  InterruptExecutionInput,
  PrepareToolInput,
  ToolGrant,
  ToolConfirmationInput,
  ToolConfirmation,
  ResumeConfirmedToolInput,
  ResumedToolDispatch,
  DispatchToolInput,
  SettleToolInput,
  ToolDispatch,
  AgentRuntimeCompensationWork,
  ResumeAgentRuntimeCompensationInput,
  CancelForHumanFenceInput,
  AgentRuntimeWorkerContext,
  AgentWorkerCommandContext,
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  CommandAcknowledgement,
  HashedSessionIssue,
  HashedSessionRotation,
  HumanCollaborationCommand,
  IssuedSessionRecord,
  OutboxDelivery,
  OutboxDispatchCandidate,
  RoomGovernanceCommand,
  SnapshotRevalidationRequest,
  RepairScope,
  StreamingRepairLease,
} from "./contracts.js";

export type AuthorityWorkerErrorCode =
  | "actor_conflict"
  | "agent_capability_forbidden"
  | "agent_missing_permission"
  | "agent_permissions_invalid"
  | "agent_required"
  | "authority_already_initialized"
  | "authority_not_initialized"
  | "authority_worker_closed"
  | "calibration_source_invalid"
  | "confirmation_expired"
  | "execution_conflict"
  | "execution_not_running"
  | "idempotency_conflict"
  | "identity_forbidden"
  | "invalid_request"
  | "invalid_token"
  | "invitation_consumed"
  | "invitation_forbidden"
  | "invitation_not_found"
  | "invitation_pending"
  | "invitation_secret_unavailable"
  | "invitee_required"
  | "legacy_import_failed"
  | "legacy_import_unavailable"
  | "member_not_found"
  | "message_not_found"
  | "open_item_not_found"
  | "room_archived"
  | "room_compaction_blocked"
  | "room_forbidden"
  | "room_member_exists"
  | "room_member_not_found"
  | "room_not_found"
  | "room_owner_required"
  | "repair_barrier_active"
  | "session_revoked"
  | "snapshot_busy"
  | "snapshot_expired"
  | "snapshot_family_revoked"
  | "snapshot_forbidden"
  | "snapshot_not_found"
  | "snapshot_stale"
  | "storage_unavailable"
  | "target_busy"
  | "token_expired";

export function isAuthorityWorkerErrorCode(
  value: unknown,
): value is AuthorityWorkerErrorCode {
  switch (value) {
    case "actor_conflict":
    case "agent_capability_forbidden":
    case "agent_missing_permission":
    case "agent_permissions_invalid":
    case "agent_required":
    case "authority_already_initialized":
    case "authority_not_initialized":
    case "authority_worker_closed":
    case "calibration_source_invalid":
    case "confirmation_expired":
    case "execution_conflict":
    case "execution_not_running":
    case "idempotency_conflict":
    case "identity_forbidden":
    case "invalid_request":
    case "invalid_token":
    case "invitation_consumed":
    case "invitation_forbidden":
    case "invitation_not_found":
    case "invitation_pending":
    case "invitation_secret_unavailable":
    case "invitee_required":
    case "legacy_import_failed":
    case "legacy_import_unavailable":
    case "member_not_found":
    case "message_not_found":
    case "open_item_not_found":
    case "room_archived":
    case "room_compaction_blocked":
    case "room_forbidden":
    case "room_member_exists":
    case "room_member_not_found":
    case "room_not_found":
    case "room_owner_required":
    case "repair_barrier_active":
    case "session_revoked":
    case "snapshot_busy":
    case "snapshot_expired":
    case "snapshot_family_revoked":
    case "snapshot_forbidden":
    case "snapshot_not_found":
    case "snapshot_stale":
    case "storage_unavailable":
    case "target_busy":
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
      readonly type: "authority.execute-agent";
      readonly requestId: string;
      readonly context: AgentWorkerCommandContext;
      readonly command: AgentCollaborationCommand;
      readonly now: number;
    }
  | {
      readonly type: "authority.agent-runtime.invoke";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext | AgentWorkerCommandContext;
      readonly input: AgentInvocationInput;
      readonly now: number;
      readonly maxQueuedPerRoom?: number;
    }
  | {
      readonly type: "authority.agent-runtime.claim-next";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly roomId: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.agent-runtime.commit-step";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: CommitExecutionStepInput;
    }
  | {
      readonly type: "authority.agent-runtime.complete-execution";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: CompleteExecutionInput;
    }
  | {
      readonly type: "authority.agent-runtime.complete-compensation";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: CompleteCompensationInput;
    }
  | {
      readonly type: "authority.agent-runtime.schedule-retry";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: ScheduleRetryInput;
    }
  | {
      readonly type: "authority.agent-runtime.fail-execution";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: FailExecutionInput;
    }
  | {
      readonly type: "authority.agent-runtime.interrupt";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly input: InterruptExecutionInput;
      readonly now: number;
    }
  | {
      readonly type: "authority.agent-runtime.manual-retry";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly executionId: string;
      readonly now: number;
      readonly maxQueuedPerRoom?: number;
    }
  | {
      readonly type: "authority.agent-runtime.compensate";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly executionId: string;
      readonly dispatchId: string;
      readonly now: number;
      readonly maxQueuedPerRoom?: number;
    }
  | {
      readonly type: "authority.agent-runtime.resume-compensation";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: ResumeAgentRuntimeCompensationInput;
    }
  | {
      readonly type: "authority.agent-runtime.recover";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: AgentRuntimeRecoveryPageInput;
    }
  | {
      readonly type: "authority.agent-runtime.prepare-tool";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: PrepareToolInput;
    }
  | {
      readonly type: "authority.agent-runtime.confirm-tool";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly input: ToolConfirmationInput;
      readonly now: number;
    }
  | {
      readonly type: "authority.agent-runtime.resume-confirmed-tool";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: ResumeConfirmedToolInput;
    }
  | {
      readonly type: "authority.agent-runtime.dispatch-tool";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: DispatchToolInput;
    }
  | {
      readonly type: "authority.agent-runtime.settle-tool";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: SettleToolInput;
    }
  | {
      readonly type: "authority.agent-runtime.read-execution";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
      readonly executionId: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.agent-runtime.load-provider-context";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly executionId: string;
    }
  | {
      readonly type: "authority.agent-runtime.cancel-human-fence";
      readonly requestId: string;
      readonly runtime: AgentRuntimeWorkerContext;
      readonly input: CancelForHumanFenceInput;
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
  | { readonly type: "authority.close"; readonly requestId: string };

export type AuthorityWorkerResponse =
  | {
      readonly type: "authority.ready";
      readonly requestId: string;
      readonly schemaVersion: 6;
    }
  | {
      readonly type: "authority.schema";
      readonly requestId: string;
      readonly schemaVersion: 6;
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
      readonly type: "authority.command-acknowledged";
      readonly requestId: string;
      readonly acknowledgement: CommandAcknowledgement;
    }
  | {
      readonly type: "authority.agent-runtime.invoked";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.claimed";
      readonly requestId: string;
      readonly execution?: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.step-committed";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.execution-completed";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.compensation-completed";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.retry-scheduled";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.execution-failed";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.interrupted";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.manual-retried";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.compensation-accepted";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.compensation-resumed";
      readonly requestId: string;
      readonly work: AgentRuntimeCompensationWork;
    }
  | {
      readonly type: "authority.agent-runtime.recovered";
      readonly requestId: string;
      readonly page: AgentRuntimeRecoveryPage;
    }
  | {
      readonly type: "authority.agent-runtime.tool-prepared";
      readonly requestId: string;
      readonly grant: ToolGrant;
    }
  | {
      readonly type: "authority.agent-runtime.tool-confirmed";
      readonly requestId: string;
      readonly confirmation: ToolConfirmation;
    }
  | {
      readonly type: "authority.agent-runtime.confirmed-tool-resumed";
      readonly requestId: string;
      readonly resumed: ResumedToolDispatch;
    }
  | {
      readonly type: "authority.agent-runtime.tool-dispatched" | "authority.agent-runtime.tool-settled";
      readonly requestId: string;
      readonly dispatch: ToolDispatch;
    }
  | {
      readonly type: "authority.agent-runtime.execution";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.agent-runtime.provider-context";
      readonly requestId: string;
      readonly executionId: string;
      readonly context: AgentRuntimeProviderContext;
    }
  | {
      readonly type: "authority.agent-runtime.human-fence-cancelled";
      readonly requestId: string;
      readonly execution: AgentExecution;
    }
  | {
      readonly type: "authority.history";
      readonly requestId: string;
      readonly messages: readonly Message[];
    }
  | { readonly type: "authority.actor"; readonly requestId: string; readonly actor?: Actor }
  | { readonly type: "authority.room"; readonly requestId: string; readonly room?: ManagedRoom }
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
  | { readonly type: "authority.closed"; readonly requestId: string }
  | {
      readonly type: "authority.error";
      readonly requestId: string;
      readonly code: AuthorityWorkerErrorCode;
      readonly message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
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
      "accessTokenHash",
      "refreshTokenHash",
      "accessExpiresAt",
      "refreshExpiresAt",
    ]) &&
    isText(value.accountId) &&
    isText(value.actorId) &&
    isTokenHash(value.accessTokenHash) &&
    isTokenHash(value.refreshTokenHash) &&
    value.accessTokenHash !== value.refreshTokenHash &&
    isNonNegativeSafeInteger(value.accessExpiresAt) &&
    isNonNegativeSafeInteger(value.refreshExpiresAt) &&
    value.refreshExpiresAt > value.accessExpiresAt
  );
}

function isIssuedSessionRecord(value: unknown): value is IssuedSessionRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "sessionId",
      "familyId",
      "accountId",
      "actorId",
      "accessExpiresAt",
      "refreshExpiresAt",
    ]) &&
    isTokenHash(value.sessionId) &&
    isTokenHash(value.familyId) &&
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
    return hasExactKeys(value, ["kind", "context", "roomId", "accessRevision"]) &&
      isText(value.roomId) && isNonNegativeSafeInteger(value.accessRevision);
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

function isAgentInvocationInput(value: unknown): value is AgentInvocationInput {
  return isRecord(value) &&
    hasExactKeys(value, [
      "roomId", "sourceMessageId", "targetAgentId", "intentKind", "providerId", "modelId",
    ]) &&
    isText(value.roomId) && isText(value.sourceMessageId) && isText(value.targetAgentId) &&
    (value.intentKind === "direct_mention" ||
      value.intentKind === "structured_help" ||
      value.intentKind === "routed_candidate") &&
    isText(value.providerId) && isText(value.modelId);
}

function isAgentRuntimeWorkerContext(value: unknown): value is AgentRuntimeWorkerContext {
  return isRecord(value) && hasExactKeys(value, ["kind", "runtimeId", "agentId"]) &&
    value.kind === "runtime" && isText(value.runtimeId) && isText(value.agentId);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isAgentRuntimeToolPlanEntry(value: unknown): value is AgentRuntimeToolPlanEntry {
  return isRecord(value) && hasExactKeys(value, ["callId", "toolId", "parameters"]) &&
    isText(value.callId) && isText(value.toolId) && isJsonValue(value.parameters);
}

function isCommitExecutionStepInput(value: unknown): value is CommitExecutionStepInput {
  if (!isRecord(value)) return false;
  const common = isText(value.executionId) &&
    isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 &&
    isNonNegativeSafeInteger(value.stepSeq) && value.stepSeq > 0 &&
    isSha256(value.inputSha256) && isSha256(value.outputSha256) &&
    isNonNegativeSafeInteger(value.now);
  if (!common) return false;
  if (value.stepKind === "model_generation") {
    return hasExactKeys(value, [
      "executionId", "attemptSeq", "stepSeq", "stepKind", "inputSha256", "outputSha256", "now",
    ]);
  }
  if (value.stepKind === "tool_call") {
    return hasExactKeys(value, [
      "executionId", "attemptSeq", "stepSeq", "stepKind", "canonicalToolCall",
      "inputSha256", "outputSha256", "now",
    ]) && isRecord(value.canonicalToolCall) &&
      [["toolId"], ["toolId", "parameters"], ["toolId", "parameters", "remainingCalls"]]
        .some((keys) => hasExactKeys(value.canonicalToolCall as Record<string, unknown>, keys)) &&
      isText(value.canonicalToolCall.toolId) &&
      (!Object.hasOwn(value.canonicalToolCall, "parameters") ||
       isJsonValue(value.canonicalToolCall.parameters)) &&
      (!Object.hasOwn(value.canonicalToolCall, "remainingCalls") ||
       (Array.isArray(value.canonicalToolCall.remainingCalls) &&
        value.canonicalToolCall.remainingCalls.every(isAgentRuntimeToolPlanEntry)));
  }
  return value.stepKind === "tool_result" && hasExactKeys(value, [
    "executionId", "attemptSeq", "stepSeq", "stepKind", "dispatchId", "boundedToolResult",
    "inputSha256", "outputSha256", "now",
  ]) && isText(value.dispatchId) && value.boundedToolResult !== null && isJsonValue(value.boundedToolResult);
}

function isScheduleRetryInput(value: unknown): value is ScheduleRetryInput {
  return isRecord(value) && hasExactKeys(value, [
    "executionId", "attemptSeq", "errorCode", "now",
  ]) && isText(value.executionId) && isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 &&
    (value.errorCode === "rate_limited" || value.errorCode === "upstream_timeout" ||
      value.errorCode === "upstream_unavailable" || value.errorCode === "target_busy" ||
      value.errorCode === "runtime_restarted") &&
    isNonNegativeSafeInteger(value.now);
}

function isAgentRuntimeRecovery(value: unknown): value is AgentRuntimeRecovery {
  return isRecord(value) &&
    (hasExactKeys(value, ["execution"]) || hasExactKeys(value, ["execution", "nextRetryAt"])) &&
    isAgentExecution(value.execution) &&
    (!Object.hasOwn(value, "nextRetryAt") || isNonNegativeSafeInteger(value.nextRetryAt));
}

function isAgentRuntimeRecoveryPageInput(value: unknown): value is AgentRuntimeRecoveryPageInput {
  if (!isRecord(value)) return false;
  const keys = ["now", "limit", ...(Object.hasOwn(value, "cursor") ? ["cursor"] : [])];
  return hasExactKeys(value, keys) && isNonNegativeSafeInteger(value.now) &&
    isNonNegativeSafeInteger(value.limit) && value.limit > 0 && value.limit <= 256 &&
    (!Object.hasOwn(value, "cursor") || isText(value.cursor));
}

function isAgentRuntimeRecoveryPage(value: unknown): value is AgentRuntimeRecoveryPage {
  if (!isRecord(value)) return false;
  const keys = ["recoveries", ...(Object.hasOwn(value, "nextCursor") ? ["nextCursor"] : [])];
  return hasExactKeys(value, keys) && Array.isArray(value.recoveries) &&
    value.recoveries.length <= 256 && value.recoveries.every(isAgentRuntimeRecovery) &&
    (!Object.hasOwn(value, "nextCursor") || isText(value.nextCursor));
}

function isFailExecutionInput(value: unknown): value is FailExecutionInput {
  return isRecord(value) && hasExactKeys(value, [
    "executionId", "attemptSeq", "errorCode", "now",
  ]) && isText(value.executionId) && isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 &&
    (value.errorCode === "provider_cancelled" ||
      value.errorCode === "provider_input_too_large" ||
      value.errorCode === "provider_invalid_request" ||
      value.errorCode === "provider_invalid_response" ||
      value.errorCode === "provider_not_configured" ||
      value.errorCode === "provider_failure" ||
      value.errorCode === "provider_response_too_large" ||
      value.errorCode === "provider_unauthorized" ||
      value.errorCode === "tool_failure") &&
    isNonNegativeSafeInteger(value.now);
}

function isCompleteExecutionInput(value: unknown): value is CompleteExecutionInput {
  return isRecord(value) && hasExactKeys(value, [
    "executionId", "attemptSeq", "messageId", "body", "sentAt", "now",
  ]) && isText(value.executionId) && isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 &&
    isText(value.messageId) && isText(value.body) && typeof value.sentAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.sentAt) &&
    isNonNegativeSafeInteger(value.now);
}

function isCompleteCompensationInput(value: unknown): value is CompleteCompensationInput {
  return isRecord(value) && hasExactKeys(value, [
    "executionId", "attemptSeq", "dispatchId", "grantId", "boundedToolResult",
    "inputSha256", "outputSha256", "closedSummary", "messageId", "body", "sentAt", "now",
  ]) && isText(value.executionId) && isNonNegativeSafeInteger(value.attemptSeq) &&
    value.attemptSeq > 0 && isText(value.dispatchId) && isText(value.grantId) &&
    value.boundedToolResult !== null && isJsonValue(value.boundedToolResult) &&
    isSha256(value.inputSha256) && isSha256(value.outputSha256) &&
    isText(value.closedSummary) && Buffer.byteLength(value.closedSummary, "utf8") <= 65_536 &&
    isText(value.messageId) && isText(value.body) &&
    typeof value.sentAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.sentAt) &&
    isNonNegativeSafeInteger(value.now);
}

function isInterruptExecutionInput(value: unknown): value is InterruptExecutionInput {
  return isRecord(value) && hasExactKeys(value, ["executionId", "reason"]) &&
    isText(value.executionId) &&
    (value.reason === "requested_by_requester" || value.reason === "requested_by_room_manager");
}

function isPrepareToolInput(value: unknown): value is PrepareToolInput {
  return isRecord(value) && hasExactKeys(value, [
    "executionId", "attemptSeq", "toolCallStepSeq", "toolId", "parameterHash", "toolPlanHash", "confirmationRequirement", "now", "expiresAt",
  ]) && isText(value.executionId) && isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 &&
    isNonNegativeSafeInteger(value.toolCallStepSeq) && value.toolCallStepSeq > 0 &&
    isText(value.toolId) && isSha256(value.parameterHash) && isSha256(value.toolPlanHash) &&
    (value.confirmationRequirement === "read_only" || value.confirmationRequirement === "side_effect") &&
    isNonNegativeSafeInteger(value.now) && isNonNegativeSafeInteger(value.expiresAt) && value.expiresAt > value.now;
}

function isToolConfirmationInput(value: unknown): value is ToolConfirmationInput {
  return isRecord(value) && hasExactKeys(value, [
    "executionId", "attemptSeq", "toolId", "parameterHash", "target", "impact", "reversibility", "expiresAt",
  ]) && isText(value.executionId) && isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 &&
    isText(value.toolId) && isSha256(value.parameterHash) && isText(value.target) && isText(value.impact) &&
    (value.reversibility === "compensatable" || value.reversibility === "irreversible") &&
    isNonNegativeSafeInteger(value.expiresAt);
}

function isDispatchToolInput(value: unknown): value is DispatchToolInput {
  if (!isRecord(value)) return false;
  const keys = ["executionId", "attemptSeq", "grantId", "toolId", "parameterHash", "confirmationRequirement", "now",
    ...(Object.hasOwn(value, "confirmationId") ? ["confirmationId"] : [])];
  return hasExactKeys(value, keys) && isText(value.executionId) &&
    isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 && isText(value.grantId) &&
    isText(value.toolId) && isSha256(value.parameterHash) && isNonNegativeSafeInteger(value.now) &&
    ((value.confirmationRequirement === "read_only" && !Object.hasOwn(value, "confirmationId")) ||
      (value.confirmationRequirement === "side_effect" && isText(value.confirmationId)));
}

function isSettleToolInput(value: unknown): value is SettleToolInput {
  if (!isRecord(value)) return false;
  const keys = ["dispatchId", "executionId", "attemptSeq", "grantId", "outcome", "now",
    ...(Object.hasOwn(value, "closedSummary") ? ["closedSummary"] : []),
    ...(Object.hasOwn(value, "sealedCompensation") ? ["sealedCompensation"] : [])];
  return hasExactKeys(value, keys) && isText(value.dispatchId) && isText(value.executionId) &&
    isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 && isText(value.grantId) &&
    (value.outcome === "succeeded" || value.outcome === "failed" || value.outcome === "outcome_unknown") &&
    (!Object.hasOwn(value, "closedSummary") ||
      (isText(value.closedSummary) && Buffer.byteLength(value.closedSummary, "utf8") <= 65_536)) &&
    (!Object.hasOwn(value, "sealedCompensation") ||
      (isText(value.sealedCompensation) && Buffer.byteLength(value.sealedCompensation, "utf8") <= 65_536)) &&
    isNonNegativeSafeInteger(value.now);
}

function isToolGrant(value: unknown): value is ToolGrant {
  if (!isRecord(value)) return false;
  const keys = ["id", "executionId", "attemptSeq", "toolCallStepSeq", "agentId", "roomId", "toolId", "parameterHash", "toolPlanHash", "confirmationRequirement", "issuedAt", "expiresAt",
    ...(Object.hasOwn(value, "consumedAt") ? ["consumedAt"] : [])];
  return hasExactKeys(value, keys) && isText(value.id) && isText(value.executionId) &&
    isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 &&
    isNonNegativeSafeInteger(value.toolCallStepSeq) && value.toolCallStepSeq > 0 && isText(value.agentId) &&
    isText(value.roomId) && isText(value.toolId) && isSha256(value.parameterHash) && isSha256(value.toolPlanHash) &&
    (value.confirmationRequirement === "read_only" || value.confirmationRequirement === "side_effect") &&
    isText(value.issuedAt) && isText(value.expiresAt) &&
    (!Object.hasOwn(value, "consumedAt") || isText(value.consumedAt));
}

function isToolConfirmation(value: unknown): value is ToolConfirmation {
  if (!isRecord(value)) return false;
  const keys = ["id", "executionId", "attemptSeq", "grantId", "toolId", "parameterHash", "toolPlanHash", "roomId", "humanPrincipalId",
    "sessionFamilyId", "target", "impact", "reversibility", "expiresAt",
    ...(Object.hasOwn(value, "consumedAt") ? ["consumedAt"] : [])];
  return hasExactKeys(value, keys) && isText(value.id) && isText(value.executionId) &&
    isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 && isText(value.grantId) && isText(value.toolId) &&
    isSha256(value.parameterHash) && isSha256(value.toolPlanHash) &&
    isText(value.roomId) && isText(value.humanPrincipalId) &&
    isText(value.sessionFamilyId) && isText(value.target) && isText(value.impact) &&
    (value.reversibility === "compensatable" || value.reversibility === "irreversible") &&
    isText(value.expiresAt) && (!Object.hasOwn(value, "consumedAt") || isText(value.consumedAt));
}

function isToolDispatch(value: unknown): value is ToolDispatch {
  if (!isRecord(value)) return false;
  const keys = ["id", "executionId", "attemptSeq", "grantId", "toolId", "parameterHash", "state", "dispatchedAt",
    ...(Object.hasOwn(value, "settledAt") ? ["settledAt"] : []),
    ...(Object.hasOwn(value, "closedSummary") ? ["closedSummary"] : []),
    ...(Object.hasOwn(value, "sealedCompensation") ? ["sealedCompensation"] : [])];
  return hasExactKeys(value, keys) && isText(value.id) && isText(value.executionId) &&
    isNonNegativeSafeInteger(value.attemptSeq) && value.attemptSeq > 0 && isText(value.grantId) &&
    isText(value.toolId) && isSha256(value.parameterHash) &&
    (value.state === "dispatched" || value.state === "succeeded" || value.state === "failed" || value.state === "outcome_unknown") &&
    isText(value.dispatchedAt) && (!Object.hasOwn(value, "settledAt") || isText(value.settledAt)) &&
    (!Object.hasOwn(value, "closedSummary") ||
      (isText(value.closedSummary) && Buffer.byteLength(value.closedSummary, "utf8") <= 65_536)) &&
    (!Object.hasOwn(value, "sealedCompensation") ||
      (isText(value.sealedCompensation) && Buffer.byteLength(value.sealedCompensation, "utf8") <= 65_536));
}

function isHumanCommand(value: unknown): value is HumanCollaborationCommand | RoomGovernanceCommand {
  const parsed = parsePersistentCommand(value);
  if (!parsed.ok) {
    return false;
  }
  return parsed.value.type !== "agent.judgment.record" &&
    parsed.value.type !== "agent.execution.transition";
}

function isAgentCommand(value: unknown): value is AgentCollaborationCommand {
  const parsed = parsePersistentCommand(value);
  if (!parsed.ok) {
    return false;
  }
  return parsed.value.type === "message.send" ||
    parsed.value.type === "agent.judgment.record" ||
    parsed.value.type === "open-item.create" ||
    parsed.value.type === "open-item.transition" ||
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

function isAgentRuntimeProviderContext(value: unknown): value is AgentRuntimeProviderContext {
  if (!isRecord(value) ||
      !hasExactKeys(value, ["invocation", "visibleConversation", "committedSteps"]) ||
      !isRecord(value.invocation) ||
      !hasExactKeys(value.invocation, [
        "sourceMessageId", "requesterActorId", "targetAgentId", "intentKind",
      ]) ||
      !isText(value.invocation.sourceMessageId) ||
      !isText(value.invocation.requesterActorId) ||
      !isText(value.invocation.targetAgentId) ||
      !["direct_mention", "structured_help", "routed_candidate"].includes(
        String(value.invocation.intentKind),
      ) ||
      !Array.isArray(value.visibleConversation) ||
      !Array.isArray(value.committedSteps)) return false;
  if (!value.visibleConversation.every((entry) => isRecord(entry) &&
      hasExactKeys(entry, ["messageId", "actorId", "body"]) &&
      isText(entry.messageId) && isText(entry.actorId) && typeof entry.body === "string")) {
    return false;
  }
  return value.committedSteps.every((step) => isRecord(step) &&
    hasExactKeys(step, ["stepSeq", "kind", "modelInput"]) &&
    isNonNegativeSafeInteger(step.stepSeq) && step.stepSeq > 0 &&
    ["model_generation", "tool_call", "tool_result"].includes(String(step.kind)) &&
    isJsonValue(step.modelInput));
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
      event.type === "identity.room-access.changed";
  }
  return event.streamKind === "identity" &&
    event.type === "identity.session.revoked" &&
    event.payload.familyId === value.targetId;
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
    case "authority.execute-agent":
      return (
        hasExactKeys(value, ["type", "requestId", "context", "command", "now"]) &&
        isAgentWorkerCommandContext(value.context) &&
        isAgentCommand(value.command) &&
        isNonNegativeSafeInteger(value.now)
      );
    case "authority.agent-runtime.invoke":
      return (
        hasExactKeys(value, ["type", "requestId", "context", "input", "now"]) ||
        hasExactKeys(value, ["type", "requestId", "context", "input", "now", "maxQueuedPerRoom"])
      ) &&
        (isAuthenticatedCommandContext(value.context) || isAgentWorkerCommandContext(value.context)) &&
        isAgentInvocationInput(value.input) && isNonNegativeSafeInteger(value.now) &&
        (!Object.hasOwn(value, "maxQueuedPerRoom") ||
          (isNonNegativeSafeInteger(value.maxQueuedPerRoom) && value.maxQueuedPerRoom > 0));
    case "authority.agent-runtime.claim-next":
      return hasExactKeys(value, ["type", "requestId", "runtime", "roomId", "now"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isText(value.roomId) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.agent-runtime.commit-step":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isCommitExecutionStepInput(value.input);
    case "authority.agent-runtime.complete-execution":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isCompleteExecutionInput(value.input);
    case "authority.agent-runtime.complete-compensation":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isCompleteCompensationInput(value.input);
    case "authority.agent-runtime.schedule-retry":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isScheduleRetryInput(value.input);
    case "authority.agent-runtime.fail-execution":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isFailExecutionInput(value.input);
    case "authority.agent-runtime.interrupt":
      return hasExactKeys(value, ["type", "requestId", "context", "input", "now"]) &&
        isAuthenticatedCommandContext(value.context) && isInterruptExecutionInput(value.input) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.agent-runtime.manual-retry":
      return (hasExactKeys(value, ["type", "requestId", "context", "executionId", "now"]) ||
        hasExactKeys(value, ["type", "requestId", "context", "executionId", "now", "maxQueuedPerRoom"])) &&
        isAuthenticatedCommandContext(value.context) && isText(value.executionId) &&
        isNonNegativeSafeInteger(value.now) &&
        (!Object.hasOwn(value, "maxQueuedPerRoom") ||
         (isNonNegativeSafeInteger(value.maxQueuedPerRoom) && value.maxQueuedPerRoom > 0));
    case "authority.agent-runtime.compensate":
      return (hasExactKeys(value, ["type", "requestId", "context", "executionId", "dispatchId", "now"]) ||
        hasExactKeys(value, ["type", "requestId", "context", "executionId", "dispatchId", "now", "maxQueuedPerRoom"])) &&
        isAuthenticatedCommandContext(value.context) && isText(value.executionId) && isText(value.dispatchId) &&
        isNonNegativeSafeInteger(value.now) &&
        (!Object.hasOwn(value, "maxQueuedPerRoom") ||
         (isNonNegativeSafeInteger(value.maxQueuedPerRoom) && value.maxQueuedPerRoom > 0));
    case "authority.agent-runtime.resume-compensation":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isRecord(value.input) &&
        hasExactKeys(value.input, ["executionId", "attemptSeq", "now"]) &&
        isText(value.input.executionId) && isNonNegativeSafeInteger(value.input.attemptSeq) &&
        value.input.attemptSeq > 0 &&
        isNonNegativeSafeInteger(value.input.now);
    case "authority.agent-runtime.recover":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isAgentRuntimeRecoveryPageInput(value.input);
    case "authority.agent-runtime.prepare-tool":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isPrepareToolInput(value.input);
    case "authority.agent-runtime.confirm-tool":
      return hasExactKeys(value, ["type", "requestId", "context", "input", "now"]) &&
        isAuthenticatedCommandContext(value.context) && isToolConfirmationInput(value.input) &&
        isNonNegativeSafeInteger(value.now) && value.input.expiresAt > value.now;
    case "authority.agent-runtime.resume-confirmed-tool":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isRecord(value.input) &&
        hasExactKeys(value.input, [
          "confirmationId", "executionId", "attemptSeq", "roomId", "toolId", "parameterHash", "toolPlanHash", "now",
        ]) && isText(value.input.confirmationId) && isText(value.input.executionId) &&
        isNonNegativeSafeInteger(value.input.attemptSeq) && value.input.attemptSeq > 0 &&
        isText(value.input.roomId) && isText(value.input.toolId) &&
        isSha256(value.input.parameterHash) && isSha256(value.input.toolPlanHash) &&
        isNonNegativeSafeInteger(value.input.now);
    case "authority.agent-runtime.dispatch-tool":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isDispatchToolInput(value.input);
    case "authority.agent-runtime.settle-tool":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isSettleToolInput(value.input);
    case "authority.agent-runtime.read-execution":
      return hasExactKeys(value, ["type", "requestId", "context", "executionId", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isText(value.executionId) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.agent-runtime.load-provider-context":
      return hasExactKeys(value, ["type", "requestId", "runtime", "executionId"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isText(value.executionId);
    case "authority.agent-runtime.cancel-human-fence":
      return hasExactKeys(value, ["type", "requestId", "runtime", "input"]) &&
        isAgentRuntimeWorkerContext(value.runtime) && isRecord(value.input) &&
        hasExactKeys(value.input, ["executionId", "fenceMessageId", "now"]) &&
        isText(value.input.executionId) && isText(value.input.fenceMessageId) &&
        isNonNegativeSafeInteger(value.input.now);
    case "authority.read-history":
      return hasExactKeys(value, ["type", "requestId", "context", "roomId", "now"]) &&
        isAuthenticatedSessionContext(value.context) && isText(value.roomId) &&
        isNonNegativeSafeInteger(value.now);
    case "authority.read-actor":
      return hasExactKeys(value, ["type", "requestId", "actorId"]) && isText(value.actorId);
    case "authority.read-room":
      return hasExactKeys(value, ["type", "requestId", "roomId"]) && isText(value.roomId);
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
        value.schemaVersion === 6
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
    case "authority.command-acknowledged":
      return (
        hasExactKeys(value, ["type", "requestId", "acknowledgement"]) &&
        isCommandAcknowledgement(value.acknowledgement)
      );
    case "authority.agent-runtime.invoked":
      return hasExactKeys(value, ["type", "requestId", "execution"]) &&
        isAgentExecution(value.execution);
    case "authority.agent-runtime.claimed":
      return hasExactKeys(value, ["type", "requestId", ...(Object.hasOwn(value, "execution") ? ["execution"] : [])]) &&
        (!Object.hasOwn(value, "execution") || isAgentExecution(value.execution));
    case "authority.agent-runtime.step-committed":
      return hasExactKeys(value, ["type", "requestId", "execution"]) && isAgentExecution(value.execution);
    case "authority.agent-runtime.execution-completed":
    case "authority.agent-runtime.compensation-completed":
      return hasExactKeys(value, ["type", "requestId", "execution"]) && isAgentExecution(value.execution);
    case "authority.agent-runtime.retry-scheduled":
      return hasExactKeys(value, ["type", "requestId", "execution"]) && isAgentExecution(value.execution);
    case "authority.agent-runtime.execution-failed":
      return hasExactKeys(value, ["type", "requestId", "execution"]) && isAgentExecution(value.execution);
    case "authority.agent-runtime.interrupted":
    case "authority.agent-runtime.manual-retried":
      return hasExactKeys(value, ["type", "requestId", "execution"]) && isAgentExecution(value.execution);
    case "authority.agent-runtime.compensation-accepted":
      return hasExactKeys(value, ["type", "requestId", "execution"]) &&
        isAgentExecution(value.execution);
    case "authority.agent-runtime.compensation-resumed":
      return hasExactKeys(value, ["type", "requestId", "work"]) && isRecord(value.work) &&
        hasExactKeys(value.work, ["execution", "dispatch", "sealedCompensation"]) &&
        isAgentExecution(value.work.execution) && isToolDispatch(value.work.dispatch) &&
        isText(value.work.sealedCompensation) &&
        Buffer.byteLength(value.work.sealedCompensation, "utf8") <= 65_536;
    case "authority.agent-runtime.recovered":
      return hasExactKeys(value, ["type", "requestId", "page"]) &&
        isAgentRuntimeRecoveryPage(value.page);
    case "authority.agent-runtime.tool-prepared":
      return hasExactKeys(value, ["type", "requestId", "grant"]) && isToolGrant(value.grant);
    case "authority.agent-runtime.tool-confirmed":
      return hasExactKeys(value, ["type", "requestId", "confirmation"]) && isToolConfirmation(value.confirmation);
    case "authority.agent-runtime.confirmed-tool-resumed":
      return hasExactKeys(value, ["type", "requestId", "resumed"]) && isRecord(value.resumed) &&
        hasExactKeys(value.resumed, ["confirmationId", "execution", "dispatch", "parameters", "remainingCalls", "toolPlanHash"]) &&
        isText(value.resumed.confirmationId) &&
        isAgentExecution(value.resumed.execution) && isToolDispatch(value.resumed.dispatch) &&
        isJsonValue(value.resumed.parameters) && isSha256(value.resumed.toolPlanHash) &&
        Array.isArray(value.resumed.remainingCalls) &&
        value.resumed.remainingCalls.every(isAgentRuntimeToolPlanEntry);
    case "authority.agent-runtime.tool-dispatched":
    case "authority.agent-runtime.tool-settled":
      return hasExactKeys(value, ["type", "requestId", "dispatch"]) && isToolDispatch(value.dispatch);
    case "authority.agent-runtime.execution":
      return hasExactKeys(value, ["type", "requestId", "execution"]) && isAgentExecution(value.execution);
    case "authority.agent-runtime.provider-context":
      return hasExactKeys(value, ["type", "requestId", "executionId", "context"]) &&
        isText(value.executionId) && isAgentRuntimeProviderContext(value.context) &&
        value.context.invocation.targetAgentId.length > 0;
    case "authority.agent-runtime.human-fence-cancelled":
      return hasExactKeys(value, ["type", "requestId", "execution"]) && isAgentExecution(value.execution);
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
      return (
        hasExactKeys(value, ["type", "requestId", "code", "message"]) &&
        isAuthorityWorkerErrorCode(value.code) &&
        typeof value.message === "string" &&
        value.message.length > 0
      );
    default:
      return false;
  }
}
