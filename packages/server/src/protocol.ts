import {
  MESSAGE_AUTHORITY_LIMITS,
  isAttachmentReference,
  isHumanMessageSubmit,
  isRoomCursor,
  isMessageDraft,
  isSnapshotVersion,
  isRoomMemoryRequest,
  isRoomExportTransportFrameType,
  parseRoomExportTransportClientFrame,
  isDiagnosticsTransportFrameType,
  parseDiagnosticsTransportClientFrame,
  type Message,
  type MessageAcceptedAck,
  type MessageDraft,
  type HumanMessageSubmit,
  type MessageAuthorityEvent,
  type MessageRevision,
  type MessageTargetOutcome,
  type NotificationStableEvent,
  type TimelineMessage,
  type PersistedIdentityEvent,
  type PersistedRoomEvent,
  type RoomCursor,
  type RoomRepairPage,
  type RoomSyncRequest,
  type RoomSyncResult,
  type RoomGovernanceView,
  type SnapshotCompleted,
  type SnapshotVersion,
  type WorkspaceBootstrapPage,
  type LegacyAgentExecution as AgentExecution,
  type LegacyAgentInvocationIntent as AgentInvocationIntent,
  type LightTask,
  type BallInCourt,
  type DepartureConflictList,
  type NeedsActionProjection,
  type ReminderCandidate,
  type OpenItem,
  type AttachmentPrivateEvent,
  type AttachmentMetadata,
  type AttachmentSourceEligibility,
  type RoomMemoryRequest,
  type RoomMemorySuccessFrame,
  type RoomExportTransportClientFrame,
  type RoomExportTransportServerFrame,
  type DiagnosticsTransportClientFrame,
  type DiagnosticsTransportServerFrame,
  type ScopedCancellationReceipt,
  type AgentExecutionRetryReceipt,
} from "@native-im/core";
import type { OfflineReadLeaseClaims } from "./access/offline-lease-invalidation-port.js";
import {
  parseAttachmentClientFrame,
  type AttachmentClientFrame,
} from "./attachment-authority/protocol.js";
import type {
  AuthenticationErrorCode,
  PublicSession,
  SessionDevice,
} from "./auth.js";
import {
  SESSION_DEVICE_ID_MAX_BYTES,
  SESSION_DEVICE_LABEL_MAX_BYTES,
} from "./auth.js";
import {
  MAX_ACTIVE_SESSION_FAMILIES,
  ROOM_SYNC_MAX_LIMIT,
} from "./persistence/contracts.js";
import type { MessageErrorCode } from "./service.js";
import type { MessageStoreErrorCode } from "./store.js";
import {
  isFt07AgentSettingsFrameType,
  parseFt07AgentSettingsClientFrame,
  type Ft07AgentSettingsClientFrame,
  type Ft07AgentSettingsServerFrame,
} from "./ft07-agent-settings-protocol.js";
import {
  isProjectLoopFrameType,
  parseProjectLoopClientFrame,
  type ProjectLoopClientFrame,
  type ProjectLoopServerFrame,
} from "./project-loop-protocol.js";
import {
  isNotificationFrameType,
  parseNotificationClientFrame,
  type NotificationClientFrame,
  type NotificationServerFrame,
} from "./notifications/protocol.js";

const AUTH_LOGIN_FIELDS = new Set(["type", "requestId", "accountId", "secret", "device"]);
const AUTH_LOGIN_DEVICE_FIELDS = new Set(["id", "label", "platform"]);
const AUTH_RESUME_FIELDS = new Set(["type", "requestId", "accessToken"]);
const AUTH_REFRESH_FIELDS = new Set(["type", "requestId", "refreshToken"]);
const AUTH_REVOKE_FIELDS = new Set(["type", "requestId"]);
const AUTH_SESSIONS_LIST_FIELDS = new Set(["type", "requestId"]);
const AUTH_SESSION_REVOKE_FIELDS = new Set(["type", "requestId", "sessionId"]);
const MESSAGE_SEND_FIELDS = new Set(["type", "requestId", "message"]);
const MESSAGE_V2_REQUIRED_FIELDS = new Set([
  "messageId", "roomId", "body", "mentionedTargets", "attachments",
]);
const MESSAGE_V2_OPTIONAL_FIELDS = new Set(["replyToMessageId"]);
const MESSAGE_REVISE_FIELDS = new Set([
  "type", "requestId", "roomId", "messageId", "expectedRevision", "body",
]);
const MESSAGE_RECALL_FIELDS = new Set([
  "type", "requestId", "roomId", "messageId", "expectedRevision",
]);
const ROOM_HISTORY_V2_REQUIRED_FIELDS = new Set(["type", "requestId", "roomId"]);
const ROOM_HISTORY_V2_OPTIONAL_FIELDS = new Set(["afterMessageId", "limit"]);
const MESSAGE_REVISIONS_REQUIRED_FIELDS = new Set([
  "type", "requestId", "roomId", "messageId",
]);
const MESSAGE_REVISIONS_OPTIONAL_FIELDS = new Set(["afterRevision", "limit"]);
const MESSAGE_AUTHORITY_FORBIDDEN_FIELDS = new Set([
  "authorId", "authorActorId", "authorKind", "actorId", "principal", "session",
  "sessionFamilyId", "capability", "runtimeKind", "provider", "model",
]);
const ROOM_FIELDS = new Set(["type", "requestId", "roomId"]);
const ROOM_DEPARTURE_CONFLICTS_FIELDS = new Set([
  "type", "requestId", "roomId", "targetActorId",
]);
const ROOM_GOVERNANCE_MUTATION_FIELDS = new Set([
  "type", "requestId", "roomId", "expectedGovernanceRevision", "idempotencyKey",
]);
const ROOM_GOVERNANCE_TARGET_FIELDS = new Set([
  ...ROOM_GOVERNANCE_MUTATION_FIELDS, "targetActorId",
]);
const ROOM_ROLE_SET_FIELDS = new Set([...ROOM_GOVERNANCE_TARGET_FIELDS, "role"]);
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
const AGENT_INVOKE_FIELDS = new Set(["type", "requestId", "intent"]);
const AGENT_INTENT_FIELDS = new Set(["kind", "roomId", "sourceMessageId", "targetAgentId"]);
const AGENT_CONTROL_FIELDS = new Set(["type", "requestId", "executionId"]);
const INVOCATION_CONTROL_FIELDS = new Set([
  "type", "requestId", "executionId", "expectedVersion",
]);
const INVOCATION_CANCEL_INTENT_FIELDS = new Set([
  "type", "requestId", "intentId", "expectedVersion",
]);
const AGENT_INTERRUPT_FIELDS = new Set(["type", "requestId", "executionId", "reason"]);
const AGENT_CONFIRM_FIELDS = new Set(["type", "requestId", "confirmation"]);
const AGENT_CONFIRMATION_FIELDS = new Set(["confirmationId", "executionId"]);
const TOOL_CONFIRMATION_DECIDE_FIELDS = new Set([
  "type", "requestId", "confirmationId", "expectedVersion", "decision",
]);
const TOOL_HANDOFF_OFFER_FIELDS = new Set([
  "type", "requestId", "confirmationId", "expectedVersion", "targetActorId",
]);
const TOOL_HANDOFF_ACCEPT_FIELDS = new Set([
  "type", "requestId", "handoffId", "expectedVersion",
]);
const TOOL_OUTCOME_REVIEW_FIELDS = new Set([
  "type", "requestId", "dispatchId", "expectedVersion", "resolution", "evidenceSummary",
]);
const TOOL_COMPENSATION_PROPOSE_FIELDS = new Set([
  "type", "requestId", "dispatchId", "expectedVersion",
]);
const OPEN_ITEM_CREATE_FIELDS = new Set([
  "type", "requestId", "roomId", "creationKind", "sourceMessageId", "targetActorId", "content",
]);
const OPEN_ITEM_TRANSITION_REQUIRED_FIELDS = new Set(["type", "requestId", "roomId", "itemId", "action"]);
const OPEN_ITEM_TRANSITION_OPTIONAL_FIELDS = new Set(["targetActorId", "reason"]);
const LIGHT_TASK_CREATE_FIELDS = new Set([
  "type", "requestId", "roomId", "sourceMessageId", "title", "verifierRole", "criteria",
]);
const LIGHT_TASK_CRITERION_FIELDS = new Set(["id", "text"]);
const LIGHT_TASK_TRANSITION_REQUIRED_FIELDS = new Set([
  "type", "requestId", "roomId", "taskId", "action",
]);
const LIGHT_TASK_TRANSITION_OPTIONAL_FIELDS = new Set(["emptyCriteriaConfirmed"]);
const LIGHT_TASK_CRITERION_SET_FIELDS = new Set([
  "type", "requestId", "roomId", "taskId", "criterionId", "met",
]);

export const PROTOCOL_FIELD_LIMITS = Object.freeze({
  requestId: 128,
  accountId: 256,
  secret: 4_096,
  token: 4_096,
  deviceId: SESSION_DEVICE_ID_MAX_BYTES,
  deviceLabel: SESSION_DEVICE_LABEL_MAX_BYTES,
  sessionId: SESSION_DEVICE_ID_MAX_BYTES,
  sessions: MAX_ACTIVE_SESSION_FAMILIES,
  roomId: 256,
  messageId: 256,
  body: 32 * 1_024,
  messageTargets: MESSAGE_AUTHORITY_LIMITS.targets,
  messageAttachments: MESSAGE_AUTHORITY_LIMITS.attachments,
  historyPage: 100,
  revisionPage: 100,
  sentAt: 64,
  snapshotId: 256,
  snapshotChecksum: 256,
});

export interface AuthLoginFrame {
  readonly type: "auth.login";
  readonly requestId: string;
  readonly accountId: string;
  readonly secret: string;
  readonly device: SessionDevice;
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

export interface AuthSessionsListFrame {
  readonly type: "auth.sessions.list";
  readonly requestId: string;
}

export interface AuthSessionRevokeFrame {
  readonly type: "auth.session.revoke";
  readonly requestId: string;
  readonly sessionId: string;
}

export interface MessageSendFrame {
  readonly type: "message.send";
  readonly requestId: string;
  readonly message: MessageDraft;
}

export interface MessageSendV2Frame {
  readonly type: "message.send.v2";
  readonly requestId: string;
  readonly message: HumanMessageSubmit;
}

export interface MessageReviseFrame {
  readonly type: "message.revise";
  readonly requestId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly expectedRevision: number;
  readonly body: string;
}

export interface MessageRecallFrame {
  readonly type: "message.recall";
  readonly requestId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly expectedRevision: number;
}

export interface RoomHistoryV2RequestFrame {
  readonly type: "room.history.v2";
  readonly requestId: string;
  readonly roomId: string;
  readonly afterMessageId?: string;
  readonly limit?: number;
}

export interface MessageRevisionsQueryFrame {
  readonly type: "message.revisions.query";
  readonly requestId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly afterRevision?: number;
  readonly limit?: number;
}

export interface RoomHistoryRequestFrame {
  readonly type: "room.history";
  readonly requestId: string;
  readonly roomId: string;
}

export interface BallQueryFrame {
  readonly type: "ball.query";
  readonly requestId: string;
  readonly roomId: string;
}

export interface RoomSubscribeFrame {
  readonly type: "room.subscribe";
  readonly requestId: string;
  readonly roomId: string;
}

export interface RoomGovernanceGetFrame {
  readonly type: "room.governance.get";
  readonly requestId: string;
  readonly roomId: string;
}

export interface RoomDepartureConflictsFrame {
  readonly type: "room.departure.conflicts";
  readonly requestId: string;
  readonly roomId: string;
  readonly targetActorId: string;
}

export type RoomGovernanceMutationFrame =
  | {
      readonly type: "room.ownership.transfer";
      readonly requestId: string;
      readonly roomId: string;
      readonly targetActorId: string;
      readonly expectedGovernanceRevision: number;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "room.member.role.set";
      readonly requestId: string;
      readonly roomId: string;
      readonly targetActorId: string;
      readonly role: "admin" | "member";
      readonly expectedGovernanceRevision: number;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "room.member.leave" | "room.archive" | "room.reopen";
      readonly requestId: string;
      readonly roomId: string;
      readonly expectedGovernanceRevision: number;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "room.member.remove";
      readonly requestId: string;
      readonly roomId: string;
      readonly targetActorId: string;
      readonly expectedGovernanceRevision: number;
      readonly idempotencyKey: string;
    };

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

export interface OfflineReadLeaseIssueRequestFrame {
  readonly type: "offline-read-lease.issue";
  readonly requestId: string;
  readonly roomId: string;
}

export interface OfflineReadLeaseIssuedFrame {
  readonly type: "offline-read-lease.issued";
  readonly requestId: string;
  readonly token: string;
  readonly claims: OfflineReadLeaseClaims;
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
  readonly intent: AgentInvocationIntent;
}

export interface AgentInterruptFrame {
  readonly type: "agent.interrupt";
  readonly requestId: string;
  readonly executionId: string;
  readonly reason: string;
}

export interface AgentRetryFrame {
  readonly type: "agent.retry";
  readonly requestId: string;
  readonly executionId: string;
}

export type InvocationCancelFrame =
  | Readonly<{
      type: "invocation.cancel";
      requestId: string;
      executionId: string;
      expectedVersion: number;
    }>
  | Readonly<{
      type: "invocation.cancel";
      requestId: string;
      intentId: string;
      expectedVersion: number;
    }>;

export interface InvocationRetryFrame {
  readonly type: "invocation.retry";
  readonly requestId: string;
  readonly executionId: string;
  readonly expectedVersion: number;
}

export interface AgentToolConfirmFrame {
  readonly type: "agent.tool.confirm";
  readonly requestId: string;
  readonly confirmation: { readonly confirmationId: string; readonly executionId: string };
}

export interface AgentCompensateFrame {
  readonly type: "agent.compensate";
  readonly requestId: string;
  readonly executionId: string;
}

export interface ToolConfirmationDecideFrame {
  readonly type: "tool.confirmation.decide";
  readonly requestId: string;
  readonly confirmationId: string;
  readonly expectedVersion: number;
  readonly decision: "confirm" | "reject";
}

export interface ToolConfirmationHandoffOfferFrame {
  readonly type: "tool.confirmation.handoff.offer";
  readonly requestId: string;
  readonly confirmationId: string;
  readonly expectedVersion: number;
  readonly targetActorId: string;
}

export interface ToolConfirmationHandoffAcceptFrame {
  readonly type: "tool.confirmation.handoff.accept";
  readonly requestId: string;
  readonly handoffId: string;
  readonly expectedVersion: number;
}

export interface ToolOutcomeReviewFrame {
  readonly type: "tool.outcome.review";
  readonly requestId: string;
  readonly dispatchId: string;
  readonly expectedVersion: number;
  readonly resolution: "known_succeeded" | "known_failed" | "compensated" | "accepted_risk";
  readonly evidenceSummary: string;
}

export interface ToolCompensationProposeFrame {
  readonly type: "tool.compensation.propose";
  readonly requestId: string;
  readonly dispatchId: string;
  readonly expectedVersion: number;
}

export type ToolSafetyClientFrame =
  | ToolConfirmationDecideFrame
  | ToolConfirmationHandoffOfferFrame
  | ToolConfirmationHandoffAcceptFrame
  | ToolOutcomeReviewFrame
  | ToolCompensationProposeFrame;

export interface ToolSafetyCommandAckFrame {
  readonly type: "tool.safety.command.ack";
  readonly requestId: string;
  readonly operation: ToolSafetyClientFrame["type"];
  readonly objectId: string;
  readonly version: number;
  readonly replayed: boolean;
}

export interface OpenItemCreateFrame {
  readonly type: "open-item.create";
  readonly requestId: string;
  readonly roomId: string;
  readonly creationKind: "human_mention" | "manual_unfinished";
  readonly sourceMessageId: string;
  readonly targetActorId: string;
  readonly content: string;
}

export type OpenItemTransitionFrame = {
  readonly type: "open-item.transition";
  readonly requestId: string;
  readonly roomId: string;
  readonly itemId: string;
} & (
  | { readonly action: "answer" }
  | { readonly action: "defer" | "cannot_answer"; readonly reason: string }
  | { readonly action: "transfer"; readonly targetActorId: string; readonly reason: string }
);

export interface LightTaskCreateFrame {
  readonly type: "light-task.create";
  readonly requestId: string;
  readonly roomId: string;
  readonly sourceMessageId: string;
  readonly title: string;
  readonly verifierRole: "owner" | "admin" | "member";
  readonly criteria: readonly { readonly id: string; readonly text: string }[];
}

export type LightTaskTransitionFrame = {
  readonly type: "light-task.transition";
  readonly requestId: string;
  readonly roomId: string;
  readonly taskId: string;
} & (
  | { readonly action: "claim" | "deliver" }
  | { readonly action: "verify"; readonly emptyCriteriaConfirmed?: true }
);

export interface LightTaskCriterionSetFrame {
  readonly type: "light-task.criterion.set";
  readonly requestId: string;
  readonly roomId: string;
  readonly taskId: string;
  readonly criterionId: string;
  readonly met: boolean;
}

export type ClientFrame =
  | AuthLoginFrame
  | AuthResumeFrame
  | AuthRefreshFrame
  | AuthRevokeFrame
  | AuthSessionsListFrame
  | AuthSessionRevokeFrame
  | MessageSendFrame
  | MessageSendV2Frame
  | MessageReviseFrame
  | MessageRecallFrame
  | RoomHistoryV2RequestFrame
  | MessageRevisionsQueryFrame
  | RoomHistoryRequestFrame
  | BallQueryFrame
  | RoomSubscribeFrame
  | RoomGovernanceGetFrame
  | RoomDepartureConflictsFrame
  | RoomGovernanceMutationFrame
  | WorkspaceBootstrapRequestFrame
  | WorkspaceBootstrapPageRequestFrame
  | RoomSyncRequestFrame
  | RoomRepairBeginRequestFrame
  | RoomRepairPageRequestFrame
  | SnapshotCompleteRequestFrame
  | OfflineReadLeaseIssueRequestFrame
  | RoomSubscribeV2Frame
  | AgentInvokeFrame
  | AgentInterruptFrame
  | AgentRetryFrame
  | InvocationCancelFrame
  | InvocationRetryFrame
  | AgentToolConfirmFrame
  | AgentCompensateFrame
  | ToolSafetyClientFrame
  | OpenItemCreateFrame
  | OpenItemTransitionFrame
  | LightTaskCreateFrame
  | LightTaskTransitionFrame
  | LightTaskCriterionSetFrame
  | AttachmentClientFrame
  | RoomMemoryRequest
  | Ft07AgentSettingsClientFrame
  | ProjectLoopClientFrame
  | NotificationClientFrame
  | RoomExportTransportClientFrame
  | DiagnosticsTransportClientFrame;

export interface AuthenticatedFrame {
  readonly type: "auth.authenticated";
  readonly requestId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly sessionFamilyId?: string;
  readonly deviceId?: string;
  readonly sessionId?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly refreshExpiresAt?: string;
}

export interface AuthRevokedFrame {
  readonly type: "auth.revoked";
  readonly requestId: string;
}

export interface AuthSessionsFrame {
  readonly type: "auth.sessions";
  readonly requestId: string;
  readonly sessions: readonly PublicSession[];
}

export interface AuthSessionRevokeAckFrame {
  readonly type: "auth.session.revoke.ack";
  readonly requestId: string;
  readonly sessionId: string;
  readonly revoked: true;
}

export interface MessageCreatedFrame {
  readonly type: "message.created";
  readonly message: Message;
}

export interface MessageAcceptedV2Frame {
  readonly type: "message.accepted";
  readonly requestId: string;
  readonly messageId: string;
  readonly persistedAt: string;
  readonly targetOutcomes: readonly MessageTargetOutcome[];
}

export interface MessageRevisionAcceptedFrame {
  readonly type: "message.revision.accepted";
  readonly requestId: string;
  readonly messageId: string;
  readonly revision: number;
  readonly persistedAt: string;
}

export interface MessageRecallAcceptedFrame {
  readonly type: "message.recall.accepted";
  readonly requestId: string;
  readonly messageId: string;
  readonly revision: number;
  readonly recalledAt: string;
}

export interface MessageAuthorityRoomEventFrame {
  readonly type: "room.event";
  readonly event: MessageAuthorityEvent;
}

export interface RoomHistoryV2Frame {
  readonly type: "room.history.v2";
  readonly requestId: string;
  readonly roomId: string;
  readonly messages: readonly TimelineMessage[];
  readonly hasMore: boolean;
  readonly lifecycle: "active" | "archived";
  readonly actors: readonly MessageHistoryActorFrame[];
}

export interface MessageHistoryActorFrame {
  readonly actorId: string;
  readonly kind: "human" | "agent";
  readonly displayName: string;
  readonly secondaryLabel: string;
}

export interface MessageRevisionsFrame {
  readonly type: "message.revisions";
  readonly requestId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly revisions: readonly MessageRevision[];
  readonly hasMore: boolean;
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

export interface RoomGovernanceFrame {
  readonly type: "room.governance";
  readonly requestId: string;
  readonly governance: RoomGovernanceView;
}

export interface RoomDepartureConflictsResultFrame {
  readonly type: "room.departure.conflicts.result";
  readonly requestId: string;
  readonly conflicts: DepartureConflictList;
}

export type RoomGovernanceAckFrame =
  | {
      readonly type: "room.governance.ack";
      readonly requestId: string;
      readonly operation: "room.ownership.transfer" | "room.member.role.set";
      readonly governance: RoomGovernanceView;
      readonly eventIds: readonly string[];
    }
  | {
      readonly type: "room.governance.ack";
      readonly requestId: string;
      readonly operation: "room.member.leave" | "room.member.remove" | "room.archive" | "room.reopen";
      readonly governance: RoomGovernanceView;
      readonly eventIds: readonly string[];
      readonly replayed: boolean;
    };

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

export interface AgentExecutionAckFrame {
  readonly type: "agent.execution.ack";
  readonly requestId: string;
  readonly execution: AgentExecution;
  readonly replayed: boolean;
}

export interface AgentExecutionPreviewFrame {
  readonly type: "agent.execution.preview";
  readonly roomId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly streamSeq: number;
  readonly delta: string;
  readonly authoritative: false;
}

export interface AgentExecutionPreviewResetFrame {
  readonly type: "agent.execution.preview.reset";
  readonly roomId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly reason: "human_cancelled" | "message_recalled" | "runtime_shutdown" | "repair" | "reconnect" |
    "execution_terminal" | "attempt_rolled_over" | "access_revoked";
  readonly authoritative: false;
}

export interface InvocationCancelAckFrame {
  readonly type: "invocation.cancel.ack";
  readonly requestId: string;
  readonly receipt: ScopedCancellationReceipt;
}

export interface InvocationRetryAckFrame {
  readonly type: "invocation.retry.ack";
  readonly requestId: string;
  readonly receipt: AgentExecutionRetryReceipt;
  readonly replayed: boolean;
}

export interface OpenItemAckFrame {
  readonly type: "open-item.ack";
  readonly requestId: string;
  readonly item: OpenItem;
}

export interface LightTaskAckFrame {
  readonly type: "light-task.ack";
  readonly requestId: string;
  readonly task: LightTask;
}

export interface BallQueryResultFrame {
  readonly type: "ball.query.result";
  readonly requestId: string;
  readonly roomId: string;
  readonly balls: readonly BallInCourt[];
  readonly needsAction: readonly NeedsActionProjection[];
  readonly reminders: readonly ReminderCandidate[];
}

export type AttachmentAuthorityServerFrame =
  | AttachmentPrivateEvent
  | Readonly<{
      type: "attachment.upload.begun";
      requestId: string;
      uploadId: string;
      acknowledgedBytes: number;
    }>
  | Readonly<{
      type: "attachment.upload.chunk.ack";
      requestId: string;
      uploadId: string;
      acknowledgedBytes: number;
    }>
  | Readonly<{
      type: "attachment.upload.accepted";
      requestId: string;
      attachmentId: string;
      processingStatus: "accepted-quarantined";
    }>
  | Readonly<{
      type: "attachment.upload.cancelled";
      requestId: string;
      status: "cancelled";
    }>
  | Readonly<{
      type: "attachment.status";
      requestId: string;
      attachment: AttachmentMetadata;
      sourceEligibility: AttachmentSourceEligibility;
      accessProjection: "authorized" | "archived-read-only";
    }>
  | Readonly<{
      type: "attachment.preview.opened";
      requestId: string;
      streamId: string;
      byteSize: number;
    }>
  | Readonly<{
      type: "attachment.download.opened";
      requestId: string;
      streamId: string;
      byteSize: number;
      originalFilename: string;
    }>
  | Readonly<{
      type: "attachment.stream.chunk";
      requestId: string;
      streamId: string;
      offset: number;
      byteLength: number;
      base64: string;
      eof: boolean;
    }>;

export type ProtocolErrorCode =
  | AuthenticationErrorCode
  | MessageErrorCode
  | MessageStoreErrorCode
  | "unauthenticated"
  | "room_forbidden"
  | "administrator_required"
  | "administrator_already_exists"
  | "administrator_not_found"
  | "last_administrator_required"
  | "administrator_revision_conflict"
  | "profile_forbidden"
  | "profile_not_found"
  | "profile_gone"
  | "profile_revision_conflict"
  | "profile_state_conflict"
  | "assignment_not_found"
  | "assignment_gone"
  | "assignment_already_exists"
  | "assignment_revision_conflict"
  | "capability_ceiling_conflict"
  | "capacity_limited"
  | "provider_configuration_unavailable"
  | "identity_forbidden"
  | "already_authenticated"
  | "invalid_request"
  | "invalid_message"
  | "mention_entity_invalid"
  | "author_fields_forbidden"
  | "attachment_feature_unavailable"
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
  | "reply_target_not_found"
  | "room_archived"
  | "role_forbidden"
  | "room_revision_conflict"
  | "ownership_transfer_required"
  | "member_not_found"
  | "idempotency_conflict"
  | "message_version_conflict"
  | "message_recalled"
  | "agent_final_immutable"
  | "protocol_upgrade_required"
  | "departure_blocked"
  | "confirmation_rejected"
  | "confirmation_replayed"
  | "confirmation_expired"
  | "content_too_large"
  | "grant_revoked"
  | "dependency_unavailable"
  | "agent_configuration_missing"
  | "agent_queue_full"
  | "agent_runtime_closed"
  | "execution_conflict"
  | "execution_not_found"
  | "context_forbidden"
  | "context_generation_conflict"
  | "context_snapshot_conflict"
  | "context_snapshot_invalidated"
  | "context_source_gone"
  | "context_capacity_limited"
  | "context_storage_unavailable"
  | "light_task_not_found"
  | "open_item_not_found"
  | "invalid_parameters"
  | "permission_denied"
  | "provider_authentication"
  | "provider_failure"
  | "provider_malformed"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_unavailable"
  | "memory_not_found"
  | "memory_source_not_found"
  | "memory_version_conflict"
  | "memory_recovery_generation_conflict"
  | "memory_source_gone"
  | "memory_capacity_limited"
  | "memory_unavailable"
  | "memory_dependency_unavailable"
  | "project_fact_not_found"
  | "revision_conflict"
  | "invalid_transition"
  | "project_dependency_unavailable"
  | "side_effect_outcome_unknown"
  | "tool_failure"
  | "tool_target_busy"
  | "tool_confirmation_not_found"
  | "tool_parameters_changed"
  | "stale_tool_call"
  | "tool_already_terminal"
  | "tool_confirmation_expired"
  | "tool_grant_expired"
  | "tool_source_gone"
  | "tool_needs_review"
  | "tool_capacity_limited"
  | "notification_forbidden"
  | "notification_not_found"
  | "notification_source_gone"
  | "notification_revision_conflict"
  | "rate_limited"
  | "room_export_forbidden"
  | "room_export_stream_conflict"
  | "room_export_stream_gone"
  | "room_export_capacity_limited"
  | "room_export_timeout"
  | "diagnostics_stream_conflict"
  | "diagnostics_artifact_gone"
  | "diagnostics_capacity_limited"
  | "diagnostics_invalid_artifact"
  | "diagnostics_unavailable"
  | "administrator_required"
  | "internal_error";

export type ProtocolErrorFrame =
  | {
      readonly type: "error";
      readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 503;
      readonly code: Exclude<ProtocolErrorCode, "departure_blocked">;
      readonly message: string;
      readonly requestId?: string;
      readonly retryAfterSeconds?: number;
      readonly details?: never;
    }
  | {
      readonly type: "error";
      readonly status: 409;
      readonly code: "departure_blocked";
      readonly message: string;
      readonly requestId: string;
      readonly details: DepartureConflictList;
    };

export type ServerFrame =
  | AuthenticatedFrame
  | AuthRevokedFrame
  | AuthSessionsFrame
  | AuthSessionRevokeAckFrame
  | AuthSessionRevokedFrame
  | MessageAcceptedAck
  | MessageAcceptedV2Frame
  | MessageRevisionAcceptedFrame
  | MessageRecallAcceptedFrame
  | MessageCreatedFrame
  | RoomEventFrame
  | MessageAuthorityRoomEventFrame
  | IdentityRoomAccessChangedFrame
  | NotificationStableEvent
  | RoomHistoryFrame
  | RoomHistoryV2Frame
  | MessageRevisionsFrame
  | RoomSubscribedFrame
  | RoomGovernanceFrame
  | RoomDepartureConflictsResultFrame
  | RoomGovernanceAckFrame
  | WorkspaceBootstrapPage
  | RoomSyncResult
  | RoomRepairPage
  | SnapshotCompleted
  | OfflineReadLeaseIssuedFrame
  | RoomSubscribedV2Frame
  | RoomSubscribeV2RetryFrame
  | AgentExecutionAckFrame
  | AgentExecutionPreviewFrame
  | AgentExecutionPreviewResetFrame
  | InvocationCancelAckFrame
  | InvocationRetryAckFrame
  | ToolSafetyCommandAckFrame
  | OpenItemAckFrame
  | LightTaskAckFrame
  | BallQueryResultFrame
  | AttachmentAuthorityServerFrame
  | RoomMemorySuccessFrame
  | Ft07AgentSettingsServerFrame
  | ProjectLoopServerFrame
  | NotificationServerFrame
  | RoomExportTransportServerFrame
  | DiagnosticsTransportServerFrame
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

function hasMessageAuthorityInjection(value: UnknownRecord): boolean {
  return Reflect.ownKeys(value).some((key) =>
    typeof key !== "string" || MESSAGE_AUTHORITY_FORBIDDEN_FIELDS.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBoundedLimit(value: unknown, maximum: number): value is number {
  return isPositiveSafeInteger(value) && value <= maximum;
}

function hasValidV2MessageBasics(value: UnknownRecord): boolean {
  if (!hasRequiredAndOptionalFields(
    value,
    MESSAGE_V2_REQUIRED_FIELDS,
    MESSAGE_V2_OPTIONAL_FIELDS,
  ) || !isBoundedText(value.messageId, PROTOCOL_FIELD_LIMITS.messageId) ||
      !isBoundedText(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
      !isBoundedText(value.body, PROTOCOL_FIELD_LIMITS.body) ||
      value.body.length > MESSAGE_AUTHORITY_LIMITS.bodyUtf16 ||
      (value.replyToMessageId !== undefined &&
        !isBoundedText(value.replyToMessageId, PROTOCOL_FIELD_LIMITS.messageId)) ||
      !Array.isArray(value.attachments) ||
      value.attachments.length > PROTOCOL_FIELD_LIMITS.messageAttachments ||
      !value.attachments.every(isAttachmentReference)) {
    return false;
  }
  return Array.isArray(value.mentionedTargets) &&
    value.mentionedTargets.length <= PROTOCOL_FIELD_LIMITS.messageTargets;
}

function isSessionPlatform(value: unknown): value is SessionDevice["platform"] {
  return value === "macos" || value === "windows" || value === "linux" ||
    value === "unknown";
}

function isStrictSessionDevice(value: unknown): value is SessionDevice {
  return isRecord(value) &&
    hasOnlyFields(value, AUTH_LOGIN_DEVICE_FIELDS) &&
    isBoundedText(value.id, PROTOCOL_FIELD_LIMITS.deviceId) &&
    isBoundedText(value.label, PROTOCOL_FIELD_LIMITS.deviceLabel) &&
    isSessionPlatform(value.platform);
}

function protocolError(
  message: string,
  requestId?: string,
  status: ProtocolErrorFrame["status"] = 400,
  code: Exclude<ProtocolErrorFrame["code"], "departure_blocked"> = "invalid_request",
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

function isBoundedText(value: unknown, maximumBytes: number): value is string {
  return isBoundedString(value, maximumBytes) && value.trim().length > 0;
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
  if (isRoomExportTransportFrameType(value.type)) {
    const parsed = parseRoomExportTransportClientFrame(value);
    return parsed.ok ? parsed : {
      ok: false,
      error: protocolError(
        "Room export request must use a closed stream frame",
        parsed.requestId,
      ),
    };
  }
  if (isDiagnosticsTransportFrameType(value.type)) {
    const parsed = parseDiagnosticsTransportClientFrame(value);
    return parsed.ok ? parsed : {
      ok: false,
      error: protocolError(
        "Diagnostics request must use a closed stream frame",
        parsed.requestId,
      ),
    };
  }
  if (isFt07AgentSettingsFrameType(value.type)) {
    const parsed = parseFt07AgentSettingsClientFrame(value);
    return parsed.ok
      ? parsed
      : {
          ok: false,
          error: protocolError(
            "FT-07 Agent Settings request must use a closed authority frame",
            parsed.requestId,
          ),
        };
  }
  if (isProjectLoopFrameType(value.type)) {
    const parsed = parseProjectLoopClientFrame(value);
    return parsed.ok ? parsed : {
      ok: false,
      error: protocolError(
        "FT-09 Project Loop request must use a closed authority frame",
        parsed.requestId,
      ),
    };
  }
  if (isNotificationFrameType(value.type)) {
    const parsed = parseNotificationClientFrame(value);
    return parsed.ok ? parsed : {
      ok: false,
      error: protocolError(
        "FT-12 Notification request must use a closed recipient frame",
        parsed.requestId,
      ),
    };
  }
  if (typeof value.type === "string" && value.type.startsWith("room.memory.")) {
    if (requestId !== undefined && isRoomMemoryRequest(value)) {
      return { ok: true, frame: value };
    }
    return {
      ok: false,
      error: protocolError("Invalid Room Memory request", requestId),
    };
  }
  if (typeof value.type === "string" && value.type.startsWith("attachment.")) {
    const parsed = parseAttachmentClientFrame(value);
    if (parsed.ok) return parsed;
    return {
      ok: false,
      error: {
        type: "error",
        status: parsed.error.status,
        code: parsed.error.code,
        message: parsed.error.message,
        ...(parsed.error.requestId === undefined ? {} : { requestId: parsed.error.requestId }),
        ...("retryAfterSeconds" in parsed.error
          ? { retryAfterSeconds: parsed.error.retryAfterSeconds }
          : {}),
      },
    };
  }
  switch (value.type) {
    case "auth.login":
      if (
        !hasOnlyFields(value, AUTH_LOGIN_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.accountId, PROTOCOL_FIELD_LIMITS.accountId) ||
        !isBoundedString(value.secret, PROTOCOL_FIELD_LIMITS.secret) ||
        !isStrictSessionDevice(value.device)
      ) {
        return {
          ok: false,
          error: protocolError(
            "auth.login requires requestId, accountId, secret, and a device descriptor",
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
          device: value.device,
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
    case "auth.sessions.list":
      if (!hasOnlyFields(value, AUTH_SESSIONS_LIST_FIELDS) || requestId === undefined) {
        return {
          ok: false,
          error: protocolError(
            "auth.sessions.list requires a string requestId",
            requestId,
          ),
        };
      }
      return { ok: true, frame: { type: "auth.sessions.list", requestId } };
    case "auth.session.revoke":
      if (
        !hasOnlyFields(value, AUTH_SESSION_REVOKE_FIELDS) ||
        requestId === undefined ||
        !isBoundedText(value.sessionId, PROTOCOL_FIELD_LIMITS.sessionId)
      ) {
        return {
          ok: false,
          error: protocolError(
            "auth.session.revoke requires string requestId and sessionId",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "auth.session.revoke",
          requestId,
          sessionId: value.sessionId,
        },
      };
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
    case "message.send.v2": {
      if (!hasOnlyFields(value, MESSAGE_SEND_FIELDS) || requestId === undefined) {
        return {
          ok: false,
          error: protocolError(
            "message.send.v2 requires a string requestId and message",
            requestId,
          ),
        };
      }
      if (!isRecord(value.message)) {
        return {
          ok: false,
          error: protocolError(
            "message.send.v2 requires a closed message",
            requestId,
            400,
            "invalid_message",
          ),
        };
      }
      if (hasMessageAuthorityInjection(value.message)) {
        return {
          ok: false,
          error: protocolError(
            "Message author and authority fields are server-controlled",
            requestId,
            400,
            "author_fields_forbidden",
          ),
        };
      }
      if (!hasValidV2MessageBasics(value.message)) {
        return {
          ok: false,
          error: protocolError(
            "message.send.v2 message fields are invalid",
            requestId,
            400,
            "invalid_message",
          ),
        };
      }
      if (!isHumanMessageSubmit(value.message)) {
        return {
          ok: false,
          error: protocolError(
            "message.send.v2 mention entities are invalid",
            requestId,
            400,
            "mention_entity_invalid",
          ),
        };
      }
      return {
        ok: true,
        frame: { type: "message.send.v2", requestId, message: value.message },
      };
    }
    case "message.revise":
      if (!hasOnlyFields(value, MESSAGE_REVISE_FIELDS) || requestId === undefined ||
          !isBoundedText(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedText(value.messageId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isPositiveSafeInteger(value.expectedRevision) ||
          !isBoundedText(value.body, PROTOCOL_FIELD_LIMITS.body) ||
          value.body.length > MESSAGE_AUTHORITY_LIMITS.bodyUtf16) {
        return {
          ok: false,
          error: protocolError("message.revise requires closed CAS fields", requestId),
        };
      }
      return {
        ok: true,
        frame: {
          type: "message.revise",
          requestId,
          roomId: value.roomId,
          messageId: value.messageId,
          expectedRevision: value.expectedRevision,
          body: value.body,
        },
      };
    case "message.recall":
      if (!hasOnlyFields(value, MESSAGE_RECALL_FIELDS) || requestId === undefined ||
          !isBoundedText(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedText(value.messageId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isPositiveSafeInteger(value.expectedRevision)) {
        return {
          ok: false,
          error: protocolError("message.recall requires closed CAS fields", requestId),
        };
      }
      return {
        ok: true,
        frame: {
          type: "message.recall",
          requestId,
          roomId: value.roomId,
          messageId: value.messageId,
          expectedRevision: value.expectedRevision,
        },
      };
    case "room.history.v2":
      if (!hasRequiredAndOptionalFields(
        value,
        ROOM_HISTORY_V2_REQUIRED_FIELDS,
        ROOM_HISTORY_V2_OPTIONAL_FIELDS,
      ) || requestId === undefined ||
          !isBoundedText(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          (value.afterMessageId !== undefined &&
            !isBoundedText(value.afterMessageId, PROTOCOL_FIELD_LIMITS.messageId)) ||
          (value.limit !== undefined &&
            !isBoundedLimit(value.limit, PROTOCOL_FIELD_LIMITS.historyPage))) {
        return {
          ok: false,
          error: protocolError("room.history.v2 requires bounded query fields", requestId),
        };
      }
      return {
        ok: true,
        frame: {
          type: "room.history.v2",
          requestId,
          roomId: value.roomId,
          ...(value.afterMessageId === undefined
            ? {}
            : { afterMessageId: value.afterMessageId }),
          ...(value.limit === undefined ? {} : { limit: value.limit }),
        },
      };
    case "message.revisions.query":
      if (!hasRequiredAndOptionalFields(
        value,
        MESSAGE_REVISIONS_REQUIRED_FIELDS,
        MESSAGE_REVISIONS_OPTIONAL_FIELDS,
      ) || requestId === undefined ||
          !isBoundedText(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedText(value.messageId, PROTOCOL_FIELD_LIMITS.messageId) ||
          (value.afterRevision !== undefined && !isPageIndex(value.afterRevision)) ||
          (value.limit !== undefined &&
            !isBoundedLimit(value.limit, PROTOCOL_FIELD_LIMITS.revisionPage))) {
        return {
          ok: false,
          error: protocolError(
            "message.revisions.query requires bounded query fields",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "message.revisions.query",
          requestId,
          roomId: value.roomId,
          messageId: value.messageId,
          ...(value.afterRevision === undefined
            ? {}
            : { afterRevision: value.afterRevision }),
          ...(value.limit === undefined ? {} : { limit: value.limit }),
        },
      };
    case "room.history":
    case "room.subscribe":
    case "room.governance.get":
    case "ball.query":
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
    case "room.departure.conflicts":
      if (
        !hasOnlyFields(value, ROOM_DEPARTURE_CONFLICTS_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
        !isBoundedString(value.targetActorId, PROTOCOL_FIELD_LIMITS.accountId)
      ) {
        return {
          ok: false,
          error: protocolError(
            "room.departure.conflicts requires string requestId, roomId, and targetActorId",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "room.departure.conflicts",
          requestId,
          roomId: value.roomId,
          targetActorId: value.targetActorId,
        },
      };
    case "room.ownership.transfer":
    case "room.member.remove": {
      if (!hasOnlyFields(value, ROOM_GOVERNANCE_TARGET_FIELDS) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedString(value.targetActorId, PROTOCOL_FIELD_LIMITS.accountId) ||
          !isBoundedString(value.idempotencyKey, PROTOCOL_FIELD_LIMITS.requestId) ||
          !isPageIndex(value.expectedGovernanceRevision)) {
        return { ok: false, error: protocolError(`${value.type} requires a closed CAS command`, requestId) };
      }
      return { ok: true, frame: {
        type: value.type, requestId, roomId: value.roomId,
        targetActorId: value.targetActorId,
        expectedGovernanceRevision: value.expectedGovernanceRevision,
        idempotencyKey: value.idempotencyKey,
      } };
    }
    case "room.member.role.set": {
      if (!hasOnlyFields(value, ROOM_ROLE_SET_FIELDS) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedString(value.targetActorId, PROTOCOL_FIELD_LIMITS.accountId) ||
          (value.role !== "admin" && value.role !== "member") ||
          !isBoundedString(value.idempotencyKey, PROTOCOL_FIELD_LIMITS.requestId) ||
          !isPageIndex(value.expectedGovernanceRevision)) {
        return { ok: false, error: protocolError("room.member.role.set requires a closed CAS role command", requestId) };
      }
      return { ok: true, frame: {
        type: "room.member.role.set", requestId, roomId: value.roomId,
        targetActorId: value.targetActorId, role: value.role,
        expectedGovernanceRevision: value.expectedGovernanceRevision,
        idempotencyKey: value.idempotencyKey,
      } };
    }
    case "room.member.leave":
    case "room.archive":
    case "room.reopen": {
      if (!hasOnlyFields(value, ROOM_GOVERNANCE_MUTATION_FIELDS) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedString(value.idempotencyKey, PROTOCOL_FIELD_LIMITS.requestId) ||
          !isPageIndex(value.expectedGovernanceRevision)) {
        return { ok: false, error: protocolError(`${value.type} requires a closed CAS command`, requestId) };
      }
      return { ok: true, frame: {
        type: value.type, requestId, roomId: value.roomId,
        expectedGovernanceRevision: value.expectedGovernanceRevision,
        idempotencyKey: value.idempotencyKey,
      } };
    }
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
    case "offline-read-lease.issue":
      if (!hasOnlyFields(value, ROOM_FIELDS) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId)) {
        return {
          ok: false,
          error: protocolError(
            "offline-read-lease.issue requires string requestId and roomId",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: { type: "offline-read-lease.issue", requestId, roomId: value.roomId },
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
          !isRecord(value.intent) || !hasOnlyFields(value.intent, AGENT_INTENT_FIELDS) ||
          (value.intent.kind !== "direct_mention" && value.intent.kind !== "structured_help" && value.intent.kind !== "routed_candidate") ||
          !isBoundedString(value.intent.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedString(value.intent.sourceMessageId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isBoundedString(value.intent.targetAgentId, PROTOCOL_FIELD_LIMITS.accountId)) {
        return { ok: false, error: protocolError("agent.invoke requires a closed invocation intent", requestId) };
      }
      return { ok: true, frame: { type: "agent.invoke", requestId, intent: {
        kind: value.intent.kind,
        roomId: value.intent.roomId,
        sourceMessageId: value.intent.sourceMessageId,
        targetAgentId: value.intent.targetAgentId,
      } } };
    case "agent.interrupt":
      if (!hasOnlyFields(value, AGENT_INTERRUPT_FIELDS) || requestId === undefined ||
          !isBoundedString(value.executionId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isBoundedString(value.reason, 256)) {
        return { ok: false, error: protocolError("agent.interrupt requires executionId and bounded reason", requestId) };
      }
      return { ok: true, frame: { type: "agent.interrupt", requestId, executionId: value.executionId, reason: value.reason } };
    case "agent.retry":
      if (!hasOnlyFields(value, AGENT_CONTROL_FIELDS) || requestId === undefined ||
          !isBoundedString(value.executionId, PROTOCOL_FIELD_LIMITS.messageId)) {
        return { ok: false, error: protocolError("agent.retry requires executionId", requestId) };
      }
      return { ok: true, frame: { type: "agent.retry", requestId, executionId: value.executionId } };
    case "invocation.cancel":
      if (requestId === undefined || !isPositiveSafeInteger(value.expectedVersion)) {
        return {
          ok: false,
          error: protocolError(
            "invocation.cancel requires exactly one of executionId or intentId and positive expectedVersion",
            requestId,
          ),
        };
      }
      if (hasOnlyFields(value, INVOCATION_CONTROL_FIELDS) &&
          isBoundedString(value.executionId, PROTOCOL_FIELD_LIMITS.messageId)) {
        return { ok: true, frame: {
          type: "invocation.cancel", requestId, executionId: value.executionId,
          expectedVersion: value.expectedVersion,
        } };
      }
      if (hasOnlyFields(value, INVOCATION_CANCEL_INTENT_FIELDS) &&
          isBoundedString(value.intentId, PROTOCOL_FIELD_LIMITS.messageId)) {
        return { ok: true, frame: {
          type: "invocation.cancel", requestId, intentId: value.intentId,
          expectedVersion: value.expectedVersion,
        } };
      }
      return {
        ok: false,
        error: protocolError(
          "invocation.cancel requires exactly one of executionId or intentId and positive expectedVersion",
          requestId,
        ),
      };
    case "invocation.retry":
      if (!hasOnlyFields(value, INVOCATION_CONTROL_FIELDS) || requestId === undefined ||
          !isBoundedString(value.executionId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isPositiveSafeInteger(value.expectedVersion)) {
        return {
          ok: false,
          error: protocolError(
            "invocation.retry requires executionId and positive expectedVersion",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "invocation.retry",
          requestId,
          executionId: value.executionId,
          expectedVersion: value.expectedVersion,
        },
      };
    case "agent.compensate":
      if (!hasOnlyFields(value, AGENT_CONTROL_FIELDS) || requestId === undefined ||
          !isBoundedString(value.executionId, PROTOCOL_FIELD_LIMITS.messageId)) {
        return { ok: false, error: protocolError("agent.compensate requires executionId", requestId) };
      }
      return { ok: true, frame: { type: "agent.compensate", requestId, executionId: value.executionId } };
    case "agent.tool.confirm":
      if (!hasOnlyFields(value, AGENT_CONFIRM_FIELDS) || requestId === undefined ||
          !isRecord(value.confirmation) || !hasOnlyFields(value.confirmation, AGENT_CONFIRMATION_FIELDS) ||
          !isBoundedString(value.confirmation.confirmationId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isBoundedString(value.confirmation.executionId, PROTOCOL_FIELD_LIMITS.messageId)) {
        return { ok: false, error: protocolError("agent.tool.confirm requires a closed confirmation", requestId) };
      }
      return { ok: true, frame: { type: "agent.tool.confirm", requestId, confirmation: {
        confirmationId: value.confirmation.confirmationId,
        executionId: value.confirmation.executionId,
      } } };
    case "tool.confirmation.decide":
      if (!hasOnlyFields(value, TOOL_CONFIRMATION_DECIDE_FIELDS) || requestId === undefined ||
          !isBoundedText(value.confirmationId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isPositiveSafeInteger(value.expectedVersion) ||
          (value.decision !== "confirm" && value.decision !== "reject")) {
        return { ok: false, error: protocolError("tool.confirmation.decide requires a closed CAS decision", requestId) };
      }
      return { ok: true, frame: {
        type: "tool.confirmation.decide", requestId,
        confirmationId: value.confirmationId, expectedVersion: value.expectedVersion,
        decision: value.decision,
      } };
    case "tool.confirmation.handoff.offer":
      if (!hasOnlyFields(value, TOOL_HANDOFF_OFFER_FIELDS) || requestId === undefined ||
          !isBoundedText(value.confirmationId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isPositiveSafeInteger(value.expectedVersion) ||
          !isBoundedText(value.targetActorId, PROTOCOL_FIELD_LIMITS.accountId)) {
        return { ok: false, error: protocolError("tool.confirmation.handoff.offer requires a closed target-specific CAS offer", requestId) };
      }
      return { ok: true, frame: {
        type: "tool.confirmation.handoff.offer", requestId,
        confirmationId: value.confirmationId, expectedVersion: value.expectedVersion,
        targetActorId: value.targetActorId,
      } };
    case "tool.confirmation.handoff.accept":
      if (!hasOnlyFields(value, TOOL_HANDOFF_ACCEPT_FIELDS) || requestId === undefined ||
          !isBoundedText(value.handoffId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isPositiveSafeInteger(value.expectedVersion)) {
        return { ok: false, error: protocolError("tool.confirmation.handoff.accept requires a closed CAS acceptance", requestId) };
      }
      return { ok: true, frame: {
        type: "tool.confirmation.handoff.accept", requestId,
        handoffId: value.handoffId, expectedVersion: value.expectedVersion,
      } };
    case "tool.outcome.review":
      if (!hasOnlyFields(value, TOOL_OUTCOME_REVIEW_FIELDS) || requestId === undefined ||
          !isBoundedText(value.dispatchId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isPositiveSafeInteger(value.expectedVersion) ||
          (value.resolution !== "known_succeeded" && value.resolution !== "known_failed" &&
            value.resolution !== "compensated" && value.resolution !== "accepted_risk") ||
          !isBoundedText(value.evidenceSummary, 2_048)) {
        return { ok: false, error: protocolError("tool.outcome.review requires a closed bounded review", requestId) };
      }
      return { ok: true, frame: {
        type: "tool.outcome.review", requestId, dispatchId: value.dispatchId,
        expectedVersion: value.expectedVersion, resolution: value.resolution,
        evidenceSummary: value.evidenceSummary,
      } };
    case "tool.compensation.propose":
      if (!hasOnlyFields(value, TOOL_COMPENSATION_PROPOSE_FIELDS) || requestId === undefined ||
          !isBoundedText(value.dispatchId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isPositiveSafeInteger(value.expectedVersion)) {
        return { ok: false, error: protocolError("tool.compensation.propose requires a closed CAS proposal", requestId) };
      }
      return { ok: true, frame: {
        type: "tool.compensation.propose", requestId,
        dispatchId: value.dispatchId, expectedVersion: value.expectedVersion,
      } };
    case "open-item.create":
      if (!hasOnlyFields(value, OPEN_ITEM_CREATE_FIELDS) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          (value.creationKind !== "human_mention" && value.creationKind !== "manual_unfinished") ||
          !isBoundedString(value.sourceMessageId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isBoundedString(value.targetActorId, PROTOCOL_FIELD_LIMITS.accountId) ||
          !isBoundedString(value.content, PROTOCOL_FIELD_LIMITS.body)) {
        return { ok: false, error: protocolError("open-item.create requires a closed human request", requestId) };
      }
      return { ok: true, frame: {
        type: "open-item.create", requestId, roomId: value.roomId,
        creationKind: value.creationKind, sourceMessageId: value.sourceMessageId,
        targetActorId: value.targetActorId, content: value.content,
      } };
    case "open-item.transition": {
      if (!hasRequiredAndOptionalFields(
        value, OPEN_ITEM_TRANSITION_REQUIRED_FIELDS, OPEN_ITEM_TRANSITION_OPTIONAL_FIELDS,
      ) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedString(value.itemId, PROTOCOL_FIELD_LIMITS.messageId)) {
        return { ok: false, error: protocolError("open-item.transition requires a closed transition", requestId) };
      }
      const base = { type: "open-item.transition" as const, requestId, roomId: value.roomId, itemId: value.itemId };
      if (value.action === "answer" && value.reason === undefined && value.targetActorId === undefined) {
        return { ok: true, frame: { ...base, action: "answer" } };
      }
      if ((value.action === "defer" || value.action === "cannot_answer") &&
          isBoundedString(value.reason, 1_024) && value.targetActorId === undefined) {
        return { ok: true, frame: { ...base, action: value.action, reason: value.reason } };
      }
      if (value.action === "transfer" && isBoundedString(value.reason, 1_024) &&
          isBoundedString(value.targetActorId, PROTOCOL_FIELD_LIMITS.accountId)) {
        return { ok: true, frame: { ...base, action: "transfer", targetActorId: value.targetActorId, reason: value.reason } };
      }
      return { ok: false, error: protocolError("open-item.transition requires a closed transition", requestId) };
    }
    case "light-task.create": {
      const criteria = value.criteria;
      if (!hasOnlyFields(value, LIGHT_TASK_CREATE_FIELDS) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedString(value.sourceMessageId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isBoundedString(value.title, PROTOCOL_FIELD_LIMITS.body) || value.title.trim().length === 0 ||
          (value.verifierRole !== "owner" && value.verifierRole !== "admin" &&
           value.verifierRole !== "member") || !Array.isArray(criteria) || criteria.length > 64 ||
          !criteria.every((criterion) => isRecord(criterion) &&
            hasOnlyFields(criterion, LIGHT_TASK_CRITERION_FIELDS) &&
            isBoundedString(criterion.id, PROTOCOL_FIELD_LIMITS.messageId) &&
            criterion.id.trim().length > 0 &&
            isBoundedString(criterion.text, PROTOCOL_FIELD_LIMITS.body) &&
            criterion.text.trim().length > 0) ||
          new Set(criteria.map((criterion) => (criterion as UnknownRecord).id)).size !== criteria.length) {
        return { ok: false, error: protocolError("light-task.create requires a closed confirmation", requestId) };
      }
      return { ok: true, frame: {
        type: "light-task.create", requestId, roomId: value.roomId,
        sourceMessageId: value.sourceMessageId, title: value.title,
        verifierRole: value.verifierRole, criteria: criteria as LightTaskCreateFrame["criteria"],
      } };
    }
    case "light-task.transition": {
      if (!hasRequiredAndOptionalFields(
        value, LIGHT_TASK_TRANSITION_REQUIRED_FIELDS, LIGHT_TASK_TRANSITION_OPTIONAL_FIELDS,
      ) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedString(value.taskId, PROTOCOL_FIELD_LIMITS.messageId)) {
        return { ok: false, error: protocolError("light-task.transition requires a closed transition", requestId) };
      }
      const base = {
        type: "light-task.transition" as const, requestId, roomId: value.roomId, taskId: value.taskId,
      };
      if ((value.action === "claim" || value.action === "deliver") &&
          value.emptyCriteriaConfirmed === undefined) {
        return { ok: true, frame: { ...base, action: value.action } };
      }
      if (value.action === "verify" &&
          (value.emptyCriteriaConfirmed === undefined || value.emptyCriteriaConfirmed === true)) {
        return { ok: true, frame: {
          ...base, action: "verify",
          ...(value.emptyCriteriaConfirmed === true ? { emptyCriteriaConfirmed: true as const } : {}),
        } };
      }
      return { ok: false, error: protocolError("light-task.transition requires a closed transition", requestId) };
    }
    case "light-task.criterion.set":
      if (!hasOnlyFields(value, LIGHT_TASK_CRITERION_SET_FIELDS) || requestId === undefined ||
          !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) ||
          !isBoundedString(value.taskId, PROTOCOL_FIELD_LIMITS.messageId) ||
          !isBoundedString(value.criterionId, PROTOCOL_FIELD_LIMITS.messageId) ||
          typeof value.met !== "boolean") {
        return { ok: false, error: protocolError("light-task.criterion.set requires a closed criterion", requestId) };
      }
      return { ok: true, frame: {
        type: "light-task.criterion.set", requestId, roomId: value.roomId,
        taskId: value.taskId, criterionId: value.criterionId, met: value.met,
      } };
    default:
      return { ok: false, error: protocolError("Unknown request type", requestId) };
  }
}
