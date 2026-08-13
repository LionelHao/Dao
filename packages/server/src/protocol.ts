import {
  isRoomCursor,
  isMessageDraft,
  isSnapshotVersion,
  type AgentExecution,
  type Message,
  type MessageAcceptedAck,
  type MessageDraft,
  type PersistedIdentityEvent,
  type PersistedRoomEvent,
  type RoomCursor,
  type RoomRepairPage,
  type RoomSyncRequest,
  type RoomSyncResult,
  type SnapshotCompleted,
  type SnapshotVersion,
  type WorkspaceBootstrapPage,
} from "@native-im/core";
import type { AuthenticationErrorCode } from "./auth.js";
import { ROOM_SYNC_MAX_LIMIT } from "./persistence/contracts.js";
import type { MessageErrorCode } from "./service.js";
import type { MessageStoreErrorCode } from "./store.js";

const AUTH_LOGIN_FIELDS = new Set(["type", "requestId", "accountId", "secret"]);
const AUTH_RESUME_FIELDS = new Set(["type", "requestId", "accessToken"]);
const AUTH_REFRESH_FIELDS = new Set(["type", "requestId", "refreshToken"]);
const AUTH_REVOKE_FIELDS = new Set(["type", "requestId"]);
const MESSAGE_SEND_FIELDS = new Set(["type", "requestId", "message"]);
const ROOM_FIELDS = new Set(["type", "requestId", "roomId"]);
const WORKSPACE_BOOTSTRAP_BEGIN_FIELDS = new Set(["type", "requestId"]);
const SNAPSHOT_PAGE_FIELDS = new Set(["type", "requestId", "snapshotId", "afterPage"]);
const ROOM_SYNC_REQUIRED_FIELDS = new Set(["type", "requestId", "roomId"]);
const ROOM_SYNC_OPTIONAL_FIELDS = new Set(["cursor", "limit"]);
const SNAPSHOT_COMPLETE_FIELDS = new Set([
  "type",
  "requestId",
  "snapshotId",
  "version",
  "snapshotChecksum",
]);
const ROOM_SUBSCRIBE_V2_FIELDS = new Set(["type", "requestId", "roomId", "cursor"]);
const MESSAGE_DRAFT_FIELDS = new Set(["id", "roomId", "body", "sentAt"]);
const AGENT_INVOKE_FIELDS = new Set([
  "type", "requestId", "roomId", "sourceMessageId", "targetAgentId",
  "intentKind",
]);
const AGENT_INTERRUPT_FIELDS = new Set(["type", "requestId", "executionId", "reason"]);
const AGENT_EXECUTION_FIELDS = new Set(["type", "requestId", "executionId"]);
const AGENT_CONFIRM_FIELDS = new Set([
  "type", "requestId", "executionId", "attemptSeq", "toolId", "parameterHash",
  "target", "impact", "reversibility", "expiresAt",
]);
const AGENT_COMPENSATE_FIELDS = new Set(["type", "requestId", "executionId", "dispatchId"]);
const SHA256 = /^[0-9a-f]{64}$/u;

export const PROTOCOL_FIELD_LIMITS = Object.freeze({
  requestId: 128,
  accountId: 256,
  secret: 4_096,
  token: 4_096,
  roomId: 256,
  messageId: 256,
  body: 32 * 1_024,
  sentAt: 64,
  snapshotId: 256,
  snapshotChecksum: 256,
  agentRuntimeId: 256,
  toolConfirmationText: 4_096,
  executionPreviewText: 64 * 1_024,
});

export interface AuthLoginFrame {
  readonly type: "auth.login";
  readonly requestId: string;
  readonly accountId: string;
  readonly secret: string;
}

export interface AuthResumeFrame {
  readonly type: "auth.resume";
  readonly requestId: string;
  readonly accessToken: string;
}

export interface AuthRefreshFrame {
  readonly type: "auth.refresh";
  readonly requestId: string;
  readonly refreshToken: string;
}

export interface AuthRevokeFrame {
  readonly type: "auth.revoke";
  readonly requestId: string;
}

export interface MessageSendFrame {
  readonly type: "message.send";
  readonly requestId: string;
  readonly message: MessageDraft;
}

export interface RoomHistoryRequestFrame {
  readonly type: "room.history";
  readonly requestId: string;
  readonly roomId: string;
}

export interface RoomSubscribeFrame {
  readonly type: "room.subscribe";
  readonly requestId: string;
  readonly roomId: string;
}

export interface WorkspaceBootstrapRequestFrame {
  readonly type: "workspace.bootstrap.begin";
  readonly requestId: string;
}

export interface WorkspaceBootstrapPageRequestFrame {
  readonly type: "workspace.bootstrap.page";
  readonly requestId: string;
  readonly snapshotId: string;
  readonly afterPage: number;
}

export type RoomSyncRequestFrame = RoomSyncRequest;

export interface RoomRepairBeginRequestFrame {
  readonly type: "room.repair.begin";
  readonly requestId: string;
  readonly roomId: string;
}

export interface RoomRepairPageRequestFrame {
  readonly type: "room.repair.page";
  readonly requestId: string;
  readonly snapshotId: string;
  readonly afterPage: number;
}

export interface SnapshotCompleteRequestFrame {
  readonly type: "snapshot.complete";
  readonly requestId: string;
  readonly snapshotId: string;
  readonly version: SnapshotVersion;
  readonly snapshotChecksum: string;
}

export interface RoomSubscribeV2Frame {
  readonly type: "room.subscribe.v2";
  readonly requestId: string;
  readonly roomId: string;
  readonly cursor: RoomCursor;
}

export interface AgentInvokeFrame {
  readonly type: "agent.invoke";
  readonly requestId: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly targetAgentId: string;
  readonly intentKind: "direct_mention" | "structured_help" | "routed_candidate";
}

export interface AgentInterruptFrame {
  readonly type: "agent.interrupt";
  readonly requestId: string;
  readonly executionId: string;
  readonly reason: "requested_by_requester" | "requested_by_room_manager";
}

export interface AgentRetryFrame {
  readonly type: "agent.retry";
  readonly requestId: string;
  readonly executionId: string;
}

export interface AgentToolConfirmFrame {
  readonly type: "agent.tool.confirm";
  readonly requestId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly toolId: string;
  readonly parameterHash: string;
  readonly target: string;
  readonly impact: string;
  readonly reversibility: "compensatable" | "irreversible";
  readonly expiresAt: number;
}

export interface AgentCompensateFrame {
  readonly type: "agent.compensate";
  readonly requestId: string;
  readonly executionId: string;
  readonly dispatchId: string;
}

export type ClientFrame =
  | AuthLoginFrame
  | AuthResumeFrame
  | AuthRefreshFrame
  | AuthRevokeFrame
  | MessageSendFrame
  | RoomHistoryRequestFrame
  | RoomSubscribeFrame
  | WorkspaceBootstrapRequestFrame
  | WorkspaceBootstrapPageRequestFrame
  | RoomSyncRequestFrame
  | RoomRepairBeginRequestFrame
  | RoomRepairPageRequestFrame
  | SnapshotCompleteRequestFrame
  | RoomSubscribeV2Frame
  | AgentInvokeFrame
  | AgentInterruptFrame
  | AgentRetryFrame
  | AgentToolConfirmFrame
  | AgentCompensateFrame;

export interface AuthenticatedFrame {
  readonly type: "auth.authenticated";
  readonly requestId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly refreshExpiresAt?: string;
}

export interface AuthRevokedFrame {
  readonly type: "auth.revoked";
  readonly requestId: string;
}

export interface MessageCreatedFrame {
  readonly type: "message.created";
  readonly message: Message;
}

export interface RoomEventFrame {
  readonly type: "room.event";
  readonly event: PersistedRoomEvent;
}

export type IdentityRoomAccessChangedFrame = Extract<
  PersistedIdentityEvent,
  { readonly type: "identity.room-access.changed" }
>;

export interface AuthSessionRevokedFrame {
  readonly type: "auth.session-revoked";
  readonly eventId: string;
}

export interface RoomHistoryFrame {
  readonly type: "room.history";
  readonly requestId: string;
  readonly roomId: string;
  readonly messages: readonly Message[];
}

export interface RoomSubscribedFrame {
  readonly type: "room.subscribed";
  readonly requestId: string;
  readonly roomId: string;
}

export interface RoomSubscribedV2Frame {
  readonly type: "room.subscribed.v2";
  readonly requestId: string;
  readonly roomId: string;
  readonly cursor: RoomCursor;
  readonly watermark: number;
}

export interface RoomSubscribeV2RetryFrame {
  readonly type: "room.subscribe.v2.retry";
  readonly requestId: string;
  readonly roomId: string;
  readonly reason: "gate_overflow";
  readonly restartFrom: RoomCursor;
}

export interface AgentExecutionResultFrame {
  readonly type: "agent.execution";
  readonly requestId: string;
  readonly execution: AgentExecution;
}

export interface AgentExecutionPreviewFrame {
  readonly type: "agent.execution.preview";
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly streamSeq: number;
  readonly text: string;
}

export type ProtocolErrorCode =
  | AuthenticationErrorCode
  | MessageErrorCode
  | MessageStoreErrorCode
  | "unauthenticated"
  | "room_forbidden"
  | "identity_forbidden"
  | "already_authenticated"
  | "invalid_request"
  | "snapshot_forbidden"
  | "snapshot_family_revoked"
  | "snapshot_stale"
  | "snapshot_not_found"
  | "snapshot_expired"
  | "snapshot_busy"
  | "repair_barrier_active"
  | "invalid_token"
  | "token_expired"
  | "session_revoked"
  | "storage_unavailable"
  | "room_not_found"
  | "room_archived"
  | "agent_missing_permission"
  | "execution_conflict"
  | "execution_not_running"
  | "idempotency_conflict"
  | "confirmation_expired"
  | "target_busy"
  | "runtime_closed"
  | "provider_not_configured"
  | "internal_error";

export interface ProtocolErrorFrame {
  readonly type: "error";
  readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500 | 503;
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly requestId?: string;
}

export type ServerFrame =
  | AuthenticatedFrame
  | AuthRevokedFrame
  | AuthSessionRevokedFrame
  | MessageAcceptedAck
  | MessageCreatedFrame
  | RoomEventFrame
  | IdentityRoomAccessChangedFrame
  | RoomHistoryFrame
  | RoomSubscribedFrame
  | WorkspaceBootstrapPage
  | RoomSyncResult
  | RoomRepairPage
  | SnapshotCompleted
  | RoomSubscribedV2Frame
  | RoomSubscribeV2RetryFrame
  | AgentExecutionResultFrame
  | AgentExecutionPreviewFrame
  | ProtocolErrorFrame;

export type ClientFrameParseResult =
  | { readonly ok: true; readonly frame: ClientFrame }
  | { readonly ok: false; readonly error: ProtocolErrorFrame };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: UnknownRecord, fields: ReadonlySet<string>): boolean {
  return (
    Reflect.ownKeys(value).length === fields.size &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && fields.has(key),
    )
  );
}

function hasRequiredAndOptionalFields(
  value: UnknownRecord,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): boolean {
  return (
    [...required].every((field) => Object.hasOwn(value, field)) &&
    Reflect.ownKeys(value).every(
      (key) =>
        typeof key === "string" && (required.has(key) || optional.has(key)),
    )
  );
}

function isPageIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBoundedRoomCursor(value: unknown, roomId: string): value is RoomCursor {
  return (
    isRoomCursor(value) &&
    value.roomId === roomId &&
    isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId)
  );
}

function isBoundedSnapshotVersion(value: unknown): value is SnapshotVersion {
  if (!isSnapshotVersion(value)) {
    return false;
  }
  return value.kind === "catalog" ||
    isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId);
}

function isStrictMessageDraft(value: unknown): value is MessageDraft {
  return (
    isRecord(value) &&
    hasOnlyFields(value, MESSAGE_DRAFT_FIELDS) &&
    isMessageDraft(value) &&
    isBoundedString(value.id, PROTOCOL_FIELD_LIMITS.messageId) &&
    isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) &&
    isBoundedString(value.body, PROTOCOL_FIELD_LIMITS.body) &&
    isBoundedString(value.sentAt, PROTOCOL_FIELD_LIMITS.sentAt)
  );
}

function protocolError(
  message: string,
  requestId?: string,
  status: ProtocolErrorFrame["status"] = 400,
  code: ProtocolErrorFrame["code"] = "invalid_request",
): ProtocolErrorFrame {
  if (requestId === undefined) {
    return { type: "error", status, code, message };
  }
  return { type: "error", status, code, message, requestId };
}

function isBoundedString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

export function parseClientFrame(raw: string): ClientFrameParseResult {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: protocolError("Request must be valid JSON") };
  }

  if (!isRecord(value)) {
    return { ok: false, error: protocolError("Request must be an object") };
  }

  const requestId = isBoundedString(
    value.requestId,
    PROTOCOL_FIELD_LIMITS.requestId,
  )
    ? value.requestId
    : undefined;
  switch (value.type) {
    case "auth.login":
      if (
        !hasOnlyFields(value, AUTH_LOGIN_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.accountId, PROTOCOL_FIELD_LIMITS.accountId) ||
        !isBoundedString(value.secret, PROTOCOL_FIELD_LIMITS.secret)
      ) {
        return {
          ok: false,
          error: protocolError(
            "auth.login requires string requestId, accountId, and secret",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "auth.login",
          requestId,
          accountId: value.accountId,
          secret: value.secret,
        },
      };
    case "auth.resume":
      if (
        !hasOnlyFields(value, AUTH_RESUME_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.accessToken, PROTOCOL_FIELD_LIMITS.token)
      ) {
        return {
          ok: false,
          error: protocolError(
            "auth.resume requires string requestId and accessToken",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "auth.resume",
          requestId,
          accessToken: value.accessToken,
        },
      };
    case "auth.refresh":
      if (
        !hasOnlyFields(value, AUTH_REFRESH_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.refreshToken, PROTOCOL_FIELD_LIMITS.token)
      ) {
        return {
          ok: false,
          error: protocolError(
            "auth.refresh requires string requestId and refreshToken",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "auth.refresh",
          requestId,
          refreshToken: value.refreshToken,
        },
      };
    case "auth.revoke":
      if (!hasOnlyFields(value, AUTH_REVOKE_FIELDS) || requestId === undefined) {
        return {
          ok: false,
          error: protocolError("auth.revoke requires a string requestId", requestId),
        };
      }
      return { ok: true, frame: { type: "auth.revoke", requestId } };
    case "message.send": {
      if (!hasOnlyFields(value, MESSAGE_SEND_FIELDS) || requestId === undefined) {
        return {
          ok: false,
          error: protocolError(
            "message.send requires a string requestId and message",
            requestId,
          ),
        };
      }
      if (
        isRecord(value.message) &&
        ("authorId" in value.message || "authorKind" in value.message)
      ) {
        return {
          ok: false,
          error: protocolError(
            "Message identity is server-controlled",
            requestId,
            401,
            "identity_forbidden",
          ),
        };
      }
      if (!isStrictMessageDraft(value.message)) {
        return {
          ok: false,
          error: protocolError(
            "message.send requires a strict message draft",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: { type: "message.send", requestId, message: value.message },
      };
    }
    case "room.history":
    case "room.subscribe":
      if (
        !hasOnlyFields(value, ROOM_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId)
      ) {
        return {
          ok: false,
          error: protocolError(
            `${value.type} requires string requestId and roomId`,
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: value.type,
          requestId,
          roomId: value.roomId,
        },
      };
    case "workspace.bootstrap.begin":
      if (!hasOnlyFields(value, WORKSPACE_BOOTSTRAP_BEGIN_FIELDS) || requestId === undefined) {
        return {
          ok: false,
          error: protocolError("workspace.bootstrap.begin requires string requestId", requestId),
        };
      }
      return { ok: true, frame: { type: "workspace.bootstrap.begin", requestId } };
    case "workspace.bootstrap.page":
    case "room.repair.page":
      if (
        !hasOnlyFields(value, SNAPSHOT_PAGE_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.snapshotId, PROTOCOL_FIELD_LIMITS.snapshotId) ||
        !isPageIndex(value.afterPage)
      ) {
        return {
          ok: false,
          error: protocolError(
            `${value.type} requires string requestId, snapshotId, and non-negative afterPage`,
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: value.type,
          requestId,
          snapshotId: value.snapshotId,
          afterPage: value.afterPage,
        },
      };
    case "room.sync": {
      if (
        !hasRequiredAndOptionalFields(
          value,
          ROOM_SYNC_REQUIRED_FIELDS,
          ROOM_SYNC_OPTIONAL_FIELDS,
        ) ||
        requestId === undefined ||
        !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
        (value.cursor !== undefined && !isBoundedRoomCursor(value.cursor, value.roomId)) ||
        (value.limit !== undefined &&
          (!Number.isSafeInteger(value.limit) ||
            typeof value.limit !== "number" ||
            value.limit <= 0 ||
            value.limit > ROOM_SYNC_MAX_LIMIT))
      ) {
        return {
          ok: false,
          error: protocolError("room.sync requires a closed sync request", requestId),
        };
      }
      return {
        ok: true,
        frame: {
          type: "room.sync",
          requestId,
          roomId: value.roomId,
          ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
          ...(value.limit === undefined ? {} : { limit: value.limit }),
        },
      };
    }
    case "room.repair.begin":
      if (
        !hasOnlyFields(value, ROOM_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId)
      ) {
        return {
          ok: false,
          error: protocolError("room.repair.begin requires string requestId and roomId", requestId),
        };
      }
      return {
        ok: true,
        frame: { type: "room.repair.begin", requestId, roomId: value.roomId },
      };
    case "snapshot.complete":
      if (
        !hasOnlyFields(value, SNAPSHOT_COMPLETE_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.snapshotId, PROTOCOL_FIELD_LIMITS.snapshotId) ||
        !isBoundedSnapshotVersion(value.version) ||
        !isBoundedString(
          value.snapshotChecksum,
          PROTOCOL_FIELD_LIMITS.snapshotChecksum,
        )
      ) {
        return {
          ok: false,
          error: protocolError("snapshot.complete requires a closed snapshot completion", requestId),
        };
      }
      return {
        ok: true,
        frame: {
          type: "snapshot.complete",
          requestId,
          snapshotId: value.snapshotId,
          version: value.version,
          snapshotChecksum: value.snapshotChecksum,
        },
      };
    case "room.subscribe.v2":
      if (
        !hasOnlyFields(value, ROOM_SUBSCRIBE_V2_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
        !isBoundedRoomCursor(value.cursor, value.roomId)
      ) {
        return {
          ok: false,
          error: protocolError("room.subscribe.v2 requires string requestId, roomId, and cursor", requestId),
        };
      }
      return {
        ok: true,
        frame: {
          type: "room.subscribe.v2",
          requestId,
          roomId: value.roomId,
          cursor: value.cursor,
        },
      };
    case "agent.invoke":
      if (!hasOnlyFields(value, AGENT_INVOKE_FIELDS) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedString(value.sourceMessageId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isBoundedString(value.targetAgentId, PROTOCOL_FIELD_LIMITS.agentRuntimeId) ||
          !(value.intentKind === "direct_mention" || value.intentKind === "structured_help" ||
            value.intentKind === "routed_candidate")) {
        return { ok: false, error: protocolError("agent.invoke requires a closed invocation", requestId) };
      }
      return { ok: true, frame: {
        type: "agent.invoke", requestId, roomId: value.roomId,
        sourceMessageId: value.sourceMessageId, targetAgentId: value.targetAgentId,
        intentKind: value.intentKind,
      } };
    case "agent.interrupt":
      if (!hasOnlyFields(value, AGENT_INTERRUPT_FIELDS) || requestId === undefined ||
          !isBoundedString(value.executionId, PROTOCOL_FIELD_LIMITS.agentRuntimeId) ||
          !(value.reason === "requested_by_requester" || value.reason === "requested_by_room_manager")) {
        return { ok: false, error: protocolError("agent.interrupt requires a closed interruption", requestId) };
      }
      return { ok: true, frame: {
        type: "agent.interrupt", requestId, executionId: value.executionId, reason: value.reason,
      } };
    case "agent.retry":
      if (!hasOnlyFields(value, AGENT_EXECUTION_FIELDS) || requestId === undefined ||
          !isBoundedString(value.executionId, PROTOCOL_FIELD_LIMITS.agentRuntimeId)) {
        return { ok: false, error: protocolError("agent.retry requires an executionId", requestId) };
      }
      return { ok: true, frame: { type: "agent.retry", requestId, executionId: value.executionId } };
    case "agent.tool.confirm":
      if (!hasOnlyFields(value, AGENT_CONFIRM_FIELDS) || requestId === undefined ||
          !isBoundedString(value.executionId, PROTOCOL_FIELD_LIMITS.agentRuntimeId) ||
          !isPositiveSafeInteger(value.attemptSeq) ||
          !isBoundedString(value.toolId, PROTOCOL_FIELD_LIMITS.agentRuntimeId) ||
          typeof value.parameterHash !== "string" || !SHA256.test(value.parameterHash) ||
          !isBoundedString(value.target, PROTOCOL_FIELD_LIMITS.toolConfirmationText) ||
          !isBoundedString(value.impact, PROTOCOL_FIELD_LIMITS.toolConfirmationText) ||
          !(value.reversibility === "compensatable" || value.reversibility === "irreversible") ||
          !isPositiveSafeInteger(value.expiresAt)) {
        return { ok: false, error: protocolError("agent.tool.confirm requires a closed confirmation", requestId) };
      }
      return { ok: true, frame: {
        type: "agent.tool.confirm", requestId, executionId: value.executionId,
        attemptSeq: value.attemptSeq, toolId: value.toolId, parameterHash: value.parameterHash,
        target: value.target, impact: value.impact, reversibility: value.reversibility,
        expiresAt: value.expiresAt,
      } };
    case "agent.compensate":
      if (!hasOnlyFields(value, AGENT_COMPENSATE_FIELDS) || requestId === undefined ||
          !isBoundedString(value.executionId, PROTOCOL_FIELD_LIMITS.agentRuntimeId) ||
          !isBoundedString(value.dispatchId, PROTOCOL_FIELD_LIMITS.agentRuntimeId)) {
        return { ok: false, error: protocolError("agent.compensate requires closed identifiers", requestId) };
      }
      return { ok: true, frame: {
        type: "agent.compensate", requestId, executionId: value.executionId, dispatchId: value.dispatchId,
      } };
    default:
      return { ok: false, error: protocolError("Unknown request type", requestId) };
  }
}
