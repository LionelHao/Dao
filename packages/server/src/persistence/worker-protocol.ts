import {
  isActor,
  isMessage,
  isRoomSyncResult,
  isSnapshotCompleted,
  isSnapshotVersion,
} from "@native-im/core";
import type {
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
import {
  isRuntimeAuthorityOperation,
  type RuntimeAuthorityOperation,
} from "../agent-runtime/runtime-authority-protocol.js";
import type {
  AgentCollaborationCommand,
  AgentWorkerCommandContext,
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  CommandAcknowledgement,
  HashedSessionIssue,
  HashedSessionRotation,
  HumanCollaborationCommand,
  IssuedSessionRecord,
  JsonValue,
  OutboxDelivery,
  OutboxDispatchCandidate,
  RoomGovernanceCommand,
  SnapshotRevalidationRequest,
  RepairScope,
  StreamingRepairLease,
} from "./contracts.js";

export type AuthorityWorkerErrorCode =
  | "actor_conflict"
  | "agent_missing_permission"
  | "agent_queue_full"
  | "agent_permissions_invalid"
  | "agent_required"
  | "authority_already_initialized"
  | "authority_not_initialized"
  | "authority_worker_closed"
  | "calibration_source_invalid"
  | "confirmation_expired"
  | "confirmation_forbidden"
  | "confirmation_replayed"
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
  | "member_not_found"
  | "message_not_found"
  | "open_item_not_found"
  | "permission_denied"
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
  | "token_expired";

export function isAuthorityWorkerErrorCode(
  value: unknown,
): value is AuthorityWorkerErrorCode {
  switch (value) {
    case "actor_conflict":
    case "agent_missing_permission":
    case "agent_queue_full":
    case "agent_permissions_invalid":
    case "agent_required":
    case "authority_already_initialized":
    case "authority_not_initialized":
    case "authority_worker_closed":
    case "calibration_source_invalid":
    case "confirmation_expired":
    case "confirmation_forbidden":
    case "confirmation_replayed":
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
    case "member_not_found":
    case "message_not_found":
    case "open_item_not_found":
    case "permission_denied":
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
  | {
      readonly type: "authority.runtime";
      readonly requestId: string;
      readonly operation: RuntimeAuthorityOperation;
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
  | {
      readonly type: "authority.runtime-result";
      readonly requestId: string;
      readonly result: JsonValue;
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
    case "authority.runtime":
      return hasExactKeys(value, ["type", "requestId", "operation"]) &&
        isRuntimeAuthorityOperation(value.operation);
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
    case "authority.runtime-result":
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
