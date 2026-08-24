import { createServer, type Server as HttpServer } from "node:http";
import { isIP } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  isDepartureConflictList,
  isIsoUtcTimestamp,
  isMessageRevision,
  isMessageTargetOutcome,
  isRoomRepairPage,
  isRoomGovernanceView,
  isRoomSyncResult,
  isSnapshotCompleted,
  isTimelineMessage,
  isWorkspaceBootstrapPage,
  MESSAGE_AUTHORITY_LIMITS,
  type HumanMessageSubmit,
  type MessageRevision,
  type MessageTargetOutcome,
  type PersistedRoomEvent,
  type RoomMemoryRequest,
  type RoomMemorySuccessFrame,
  type DepartureConflictList,
  type RoomCursor,
  type SnapshotVersion,
  type TimelineMessage,
} from "@native-im/core";
import {
  AuthenticationError,
  MAX_ACTIVE_SESSION_FAMILIES,
  type AuthenticatedPrincipal,
  type AuthenticationService,
  type IssuedSession,
} from "./auth.js";
import {
  createOutboxDispatcher,
  type OutboxDispatchFrame,
  type OutboxDispatchStore,
  type OutboxSendResult,
} from "./outbox-dispatcher.js";
import type {
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  ClosedRoomGovernanceAcknowledgement,
  ClosedRoomGovernanceTransportStore,
  CommandStore,
  SyncQueryStore,
} from "./persistence/contracts.js";
import type { OutboxDelivery } from "./persistence/contracts.js";
import {
  MessageValidationError,
  RoomAccessError,
  type MessageService,
} from "./service.js";
import { MessageIdConflictError } from "./store.js";
import type { SyncService } from "./sync-service.js";
import type { AgentRuntime } from "./agent-runtime/contracts.js";
import type { AuthoritativeCollaborationPrimitives } from "./primitives.js";
import type { BallRuntimeService } from "./ball-runtime/ball-runtime-service.js";
import type { AttachmentAuthorityCommandPort } from "./attachment-authority/authority-service.js";
import {
  parseClientFrame,
  PROTOCOL_FIELD_LIMITS,
  type AuthenticatedFrame,
  type ClientFrame,
  type ProtocolErrorFrame,
  type ServerFrame,
} from "./protocol.js";
import {
  FT07_AGENT_SETTINGS_MUTATIONS,
  isFt07AgentSettingsServerFrame,
  type Ft07AgentSettingsClientFrame,
  type Ft07AgentSettingsMutationType,
  type Ft07AgentSettingsServerFrame,
} from "./ft07-agent-settings-protocol.js";
import {
  createSubscriptionRegistry,
  type RegisteredConnection,
  type SubscriptionRegistry,
} from "./subscription-registry.js";

export interface MessageWebSocketServer {
  readonly url: string;
  publishAgentPreview(preview: {
    readonly roomId: string;
    readonly executionId: string;
    readonly attemptSeq: number;
    readonly streamSeq: number;
    readonly delta: string;
  }): void;
  close(): Promise<void>;
}

export interface MessageAuthorityTransport {
  submitHumanMessage(
    context: AuthenticatedCommandContext,
    message: HumanMessageSubmit,
  ): Promise<unknown>;
  reviseHumanMessage(
    context: AuthenticatedCommandContext,
    input: Readonly<{
      roomId: string;
      messageId: string;
      expectedRevision: number;
      body: string;
    }>,
  ): Promise<unknown>;
  recallHumanMessage(
    context: AuthenticatedCommandContext,
    input: Readonly<{
      roomId: string;
      messageId: string;
      expectedRevision: number;
    }>,
  ): Promise<unknown>;
  readMessageHistory(
    context: AuthenticatedSessionContext,
    input: Readonly<{
      roomId: string;
      afterMessageId?: string;
      limit?: number;
    }>,
  ): Promise<unknown>;
  readMessageRevisions(
    context: AuthenticatedSessionContext,
    input: Readonly<{
      roomId: string;
      messageId: string;
      afterRevision?: number;
      limit?: number;
    }>,
  ): Promise<unknown>;
}

export interface RoomMemoryAuthorityTransport {
  execute(
    context: AuthenticatedSessionContext,
    request: RoomMemoryRequest,
  ): Promise<RoomMemorySuccessFrame>;
}

type Ft07AgentSettingsMutationFrame = Extract<
  Ft07AgentSettingsClientFrame,
  { readonly type: Ft07AgentSettingsMutationType }
>;
type Ft07AgentSettingsRepairFrame = Extract<
  Ft07AgentSettingsClientFrame,
  { readonly type: "agent-profile.repair" | "room-agent-assignment.repair" }
>;
type Ft07AgentSettingsQueryFrame = Exclude<
  Ft07AgentSettingsClientFrame,
  Ft07AgentSettingsMutationFrame | Ft07AgentSettingsRepairFrame
>;

/**
 * Server-private adapter seam. Every method must revalidate the supplied current
 * session in the AuthorityWorker transaction. Deployment queries/repair require
 * Tenant Administrator; Room queries/mutations require current membership and
 * owner/admin for writes. Returned values are closed again before crossing WS.
 */
export interface Ft07AgentSettingsAuthorityTransport {
  executeQuery(
    context: AuthenticatedSessionContext,
    frame: Ft07AgentSettingsQueryFrame,
  ): Promise<unknown>;
  executeMutation(
    context: AuthenticatedCommandContext,
    frame: Ft07AgentSettingsMutationFrame,
  ): Promise<unknown>;
}

export interface StartMessageWebSocketServerOptions {
  readonly auth: AuthenticationService;
  readonly service: MessageService;
  readonly host?: string;
  readonly port?: number;
  readonly maxBufferedAmountBytes?: number;
  readonly maxQueuedFrameCount?: number;
  readonly maxQueuedFrameBytes?: number;
  readonly afterSubscribeRegistered?: (roomId: string) => void | Promise<void>;
  readonly outboxStore?: OutboxDispatchStore;
  readonly outboxPollIntervalMs?: number;
  readonly subscriptionRegistry?: SubscriptionRegistry;
  readonly sync?: SyncService;
  readonly v2GateMaxEvents?: number;
  readonly v2GateMaxBytes?: number;
  readonly agentRuntime?: AgentRuntime;
  readonly collaboration?: Pick<
    AuthoritativeCollaborationPrimitives,
    | "createOpenItem"
    | "transitionOpenItem"
    | "createLightTask"
    | "transitionLightTask"
    | "setLightTaskCriterion"
  >;
  readonly ballRuntime?: Pick<BallRuntimeService, "query">;
  readonly messageAuthority?: MessageAuthorityTransport;
  readonly memoryAuthority?: RoomMemoryAuthorityTransport;
  readonly attachmentAuthority?: AttachmentAuthorityCommandPort;
  readonly agentSettingsAuthority?: Ft07AgentSettingsAuthorityTransport;
  readonly governance?: Pick<CommandStore, "executeHuman"> &
    Pick<SyncQueryStore, "readRoomGovernance"> &
    Partial<ClosedRoomGovernanceTransportStore>;
}

type RuntimeMessageWebSocketServerOptions = StartMessageWebSocketServerOptions & {
  readonly streamingOwners: Map<string, StreamingSnapshotOwners>;
};

export const MESSAGE_WEBSOCKET_MAX_PAYLOAD_BYTES = 64 * 1_024;
export const MESSAGE_WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES = 1 * 1_024 * 1_024;
export const MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_COUNT = 64;
export const MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_BYTES = 256 * 1_024;
export const MESSAGE_WEBSOCKET_V2_GATE_MAX_EVENTS = 256;
export const MESSAGE_WEBSOCKET_V2_GATE_MAX_BYTES = 256 * 1_024;

export function validateMessageWebSocketListener(host: string, port: number): void {
  const loopback = host === "localhost" || host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."));
  if (host.trim() !== host || !loopback) {
    throw new TypeError("Message WebSocket listener must use an explicit loopback host");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("Message WebSocket listener port must be an integer from 0 to 65535");
  }
}

export function formatMessageWebSocketUrl(host: string, port: number): string {
  validateMessageWebSocketListener(host, port);
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `ws://${urlHost}:${port}`;
}

const maxBufferedAmountBySocket = new WeakMap<WebSocket, number>();
const abortConnectionBySocket = new WeakMap<WebSocket, () => void>();

function abortAndTerminate(socket: WebSocket): void {
  abortConnectionBySocket.get(socket)?.();
  socket.terminate();
}

interface ConnectionContext {
  principal: AuthenticatedPrincipal | undefined;
  session: AuthenticatedSessionContext | undefined;
  accessToken: string | undefined;
  credentialGeneration: number;
  authOperationPending: boolean;
  terminalRevocationPending: boolean;
  closed: boolean;
  readonly unsubscribersByRoom: Map<string, () => void>;
  readonly identityUnsubscribers: Set<() => void>;
  readonly subscriptionGenerationsByRoom: Map<string, number>;
  readonly ownedStreamingSnapshots: Map<string, AuthenticatedSessionContext>;
  readonly connectionId: string;
  readonly v2GatesByRoom: Map<string, V2SubscriptionGate>;
  readonly clearLiveSubscriptions: () => void;
  readonly clearRoomSubscriptions: () => void;
  readonly releaseSnapshotOwners: () => void;
  readonly unsubscribeAll: () => void;
  registeredConnection: RegisteredConnection | undefined;
}

interface V2SubscriptionGate {
  readonly requestId: string;
  readonly roomId: string;
  credentialGeneration: number;
  readonly subscriptionGeneration: number;
  readonly seenEventIds: Set<string>;
  readonly bufferedEvents: PersistedRoomEvent[];
  bufferedBytes: number;
  overflowed: boolean;
  active: boolean;
  cursor: RoomCursor;
  lastContiguousEventId: string | undefined;
  unsubscribe: (() => void) | undefined;
}

type DepartureScope = {
  readonly roomId: string;
  readonly targetActorId: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyOwnFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const allowed = new Set(fields);
  return fields.every((field) => Object.hasOwn(value, field)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

type ClosedMessageSubmitResult = Readonly<{
  messageId: string;
  persistedAt: string;
  targetOutcomes: readonly MessageTargetOutcome[];
}>;

type ClosedMessageRevisionResult = Readonly<{
  messageId: string;
  revision: number;
  persistedAt: string;
}>;

type ClosedMessageRecallResult = Readonly<{
  messageId: string;
  revision: number;
  recalledAt: string;
}>;

type ClosedMessageHistoryResult = Readonly<{
  messages: readonly TimelineMessage[];
  hasMore: boolean;
  lifecycle: "active" | "archived";
  actors: readonly Readonly<{
    actorId: string;
    kind: "human" | "agent";
    displayName: string;
    secondaryLabel: string;
  }>[];
}>;

type ClosedMessageRevisionsResult = Readonly<{
  revisions: readonly MessageRevision[];
  hasMore: boolean;
}>;

function closeMessageSubmitResult(
  value: unknown,
  message: HumanMessageSubmit,
): ClosedMessageSubmitResult | undefined {
  if (!isObjectRecord(value) ||
      !hasOnlyOwnFields(value, ["messageId", "persistedAt", "targetOutcomes"]) ||
      value.messageId !== message.messageId || !isIsoUtcTimestamp(value.persistedAt) ||
      !Array.isArray(value.targetOutcomes) ||
      value.targetOutcomes.length !== message.mentionedTargets.length ||
      value.targetOutcomes.length > MESSAGE_AUTHORITY_LIMITS.targetOutcomes) {
    return undefined;
  }
  const outcomesByTargetId = new Map<string, MessageTargetOutcome>();
  const closedOutcomes: MessageTargetOutcome[] = [];
  for (const outcome of value.targetOutcomes) {
    if (!isMessageTargetOutcome(outcome) || outcomesByTargetId.has(outcome.targetId)) {
      return undefined;
    }
    outcomesByTargetId.set(outcome.targetId, outcome);
    closedOutcomes.push(outcome);
  }
  if (message.mentionedTargets.some((target) => {
    const outcome = outcomesByTargetId.get(target.id);
    return outcome === undefined || outcome.kind !== target.kind ||
      outcome.targetActorId !== target.targetActorId;
  })) {
    return undefined;
  }
  return {
    messageId: value.messageId,
    persistedAt: value.persistedAt,
    targetOutcomes: closedOutcomes,
  };
}

function closeMessageRevisionResult(
  value: unknown,
  messageId: string,
  expectedRevision: number,
): ClosedMessageRevisionResult | undefined {
  if (!isObjectRecord(value) ||
      !hasOnlyOwnFields(value, ["messageId", "revision", "persistedAt"]) ||
      value.messageId !== messageId || value.revision !== expectedRevision + 1 ||
      !isIsoUtcTimestamp(value.persistedAt)) {
    return undefined;
  }
  return {
    messageId: value.messageId,
    revision: value.revision,
    persistedAt: value.persistedAt,
  };
}

function closeMessageRecallResult(
  value: unknown,
  messageId: string,
  expectedRevision: number,
): ClosedMessageRecallResult | undefined {
  if (!isObjectRecord(value) ||
      !hasOnlyOwnFields(value, ["messageId", "revision", "recalledAt"]) ||
      value.messageId !== messageId || value.revision !== expectedRevision ||
      !isIsoUtcTimestamp(value.recalledAt)) {
    return undefined;
  }
  return {
    messageId: value.messageId,
    revision: value.revision,
    recalledAt: value.recalledAt,
  };
}

function closeMessageHistoryResult(
  value: unknown,
  roomId: string,
  limit: number,
): ClosedMessageHistoryResult | undefined {
  if (!isObjectRecord(value) || !hasOnlyOwnFields(value, [
    "messages", "hasMore", "lifecycle", "actors",
  ]) ||
      typeof value.hasMore !== "boolean" || !Array.isArray(value.messages) ||
      value.messages.length > limit ||
      (value.lifecycle !== "active" && value.lifecycle !== "archived") ||
      !Array.isArray(value.actors) || value.actors.length > 512) {
    return undefined;
  }
  const actors: Array<ClosedMessageHistoryResult["actors"][number]> = [];
  const actorIds = new Set<string>();
  for (const actor of value.actors) {
    if (!isObjectRecord(actor) || !hasOnlyOwnFields(actor, [
      "actorId", "kind", "displayName", "secondaryLabel",
    ]) || typeof actor.actorId !== "string" || !isBoundedWireText(actor.actorId, 256) ||
        (actor.kind !== "human" && actor.kind !== "agent") ||
        typeof actor.displayName !== "string" || !isBoundedWireText(actor.displayName, 512) ||
        typeof actor.secondaryLabel !== "string" ||
        !isBoundedWireText(actor.secondaryLabel, 512) || actorIds.has(actor.actorId)) {
      return undefined;
    }
    actorIds.add(actor.actorId);
    actors.push({
      actorId: actor.actorId,
      kind: actor.kind,
      displayName: actor.displayName,
      secondaryLabel: actor.secondaryLabel,
    });
  }
  const messageIds = new Set<string>();
  const closedMessages: TimelineMessage[] = [];
  let previousCreatedAt: string | undefined;
  for (const message of value.messages) {
    if (!isTimelineMessage(message) || message.roomId !== roomId || messageIds.has(message.id) ||
        (previousCreatedAt !== undefined && message.createdAt < previousCreatedAt)) {
      return undefined;
    }
    messageIds.add(message.id);
    closedMessages.push(message);
    previousCreatedAt = message.createdAt;
  }
  return {
    messages: closedMessages,
    hasMore: value.hasMore,
    lifecycle: value.lifecycle,
    actors,
  };
}

function closeMessageRevisionsResult(
  value: unknown,
  messageId: string,
  afterRevision: number,
  limit: number,
): ClosedMessageRevisionsResult | undefined {
  if (!isObjectRecord(value) || !hasOnlyOwnFields(value, ["revisions", "hasMore"]) ||
      typeof value.hasMore !== "boolean" || !Array.isArray(value.revisions) ||
      value.revisions.length > limit) {
    return undefined;
  }
  let previousRevision = afterRevision;
  const closedRevisions: MessageRevision[] = [];
  for (const revision of value.revisions) {
    if (!isMessageRevision(revision) || revision.messageId !== messageId ||
        revision.revision !== previousRevision + 1) {
      return undefined;
    }
    previousRevision = revision.revision;
    closedRevisions.push(revision);
  }
  return { revisions: closedRevisions, hasMore: value.hasMore };
}

function isServiceErrorCode<TCode extends string>(
  error: unknown,
  code: TCode,
): error is { readonly status: unknown; readonly code: TCode; readonly details?: unknown } {
  return isObjectRecord(error) && error.code === code && Object.hasOwn(error, "status");
}

function isBoundedWireText(value: string, maximumBytes: number): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function closeDepartureConflictList(
  value: unknown,
  expectedRoomId: string | undefined,
  expectedTargetActorId: string | undefined,
): DepartureConflictList | undefined {
  if (
    expectedRoomId === undefined ||
    expectedTargetActorId === undefined ||
    !isDepartureConflictList(value) ||
    value.roomId !== expectedRoomId ||
    value.targetActorId !== expectedTargetActorId ||
    value.conflicts.length > 256 ||
    value.conflicts.some((conflict) =>
      conflict.revision <= 0 ||
      !isBoundedWireText(conflict.conflictId, 256) ||
      !isBoundedWireText(conflict.subjectId, 256) ||
      !isBoundedWireText(conflict.sourceId, 256) ||
      !isBoundedWireText(conflict.title, 1_024) ||
      !isBoundedWireText(conflict.state, 1_024))
  ) {
    return undefined;
  }
  return {
    roomId: value.roomId,
    targetActorId: value.targetActorId,
    governanceRevision: value.governanceRevision,
    conflicts: value.conflicts.map((conflict) => ({
      conflictId: conflict.conflictId,
      roomId: conflict.roomId,
      subjectId: conflict.subjectId,
      kind: conflict.kind,
      title: conflict.title,
      state: conflict.state,
      allowedResolutions: [...conflict.allowedResolutions],
      sourceId: conflict.sourceId,
      revision: conflict.revision,
    })),
  };
}

function closeGovernanceView(value: unknown, roomId: string) {
  if (
    !isRoomGovernanceView(value) ||
    value.roomId !== roomId ||
    value.projectId !== roomId ||
    !isBoundedWireText(value.ownerActorId, 256) ||
    (value.archivedAt !== undefined && !isBoundedWireText(value.archivedAt, 64))
  ) {
    return undefined;
  }
  return {
    roomId: value.roomId,
    projectId: value.projectId,
    lifecycle: value.lifecycle,
    governanceRevision: value.governanceRevision,
    ownerActorId: value.ownerActorId,
    archiveGeneration: value.archiveGeneration,
    ...(value.archivedAt === undefined ? {} : { archivedAt: value.archivedAt }),
  };
}

function closeGovernanceAcknowledgement(
  value: unknown,
  roomId: string,
  operation: "room.member.leave" | "room.member.remove" | "room.archive" | "room.reopen",
): ClosedRoomGovernanceAcknowledgement | undefined {
  if (
    !isObjectRecord(value) ||
    !hasOnlyOwnFields(value, ["governance", "eventIds", "replayed"])
  ) {
    return undefined;
  }
  const governance = closeGovernanceView(value.governance, roomId);
  if (
    governance === undefined ||
    !Array.isArray(value.eventIds) ||
    value.eventIds.length > 256 ||
    !value.eventIds.every((eventId) =>
      typeof eventId === "string" && eventId.trim().length > 0 &&
      Buffer.byteLength(eventId, "utf8") <= 256) ||
    new Set(value.eventIds).size !== value.eventIds.length ||
    typeof value.replayed !== "boolean" ||
    (operation === "room.archive" && governance.lifecycle !== "archived") ||
    (operation === "room.reopen" && governance.lifecycle !== "active")
  ) {
    return undefined;
  }
  return {
    governance,
    eventIds: [...value.eventIds] as readonly string[],
    replayed: value.replayed,
  };
}

function errorFrame(
  status: ProtocolErrorFrame["status"],
  code: Exclude<ProtocolErrorFrame["code"], "departure_blocked">,
  message: string,
  requestId?: string,
): ProtocolErrorFrame {
  if (requestId === undefined) {
    return { type: "error", status, code, message };
  }
  return { type: "error", status, code, message, requestId };
}

function departureBlockedFrame(
  requestId: string,
  details: DepartureConflictList,
): ProtocolErrorFrame {
  return {
    type: "error",
    status: 409,
    code: "departure_blocked",
    message: "departure_blocked",
    requestId,
    details,
  };
}

function mappedError(
  error: unknown,
  requestId: string,
  departureScope?: DepartureScope,
): ProtocolErrorFrame {
  if (isServiceErrorCode(error, "departure_blocked")) {
    const details = closeDepartureConflictList(
      error.details,
      departureScope?.roomId,
      departureScope?.targetActorId,
    );
    return error.status === 409 && details !== undefined
      ? departureBlockedFrame(requestId, details)
      : errorFrame(503, "dependency_unavailable", "dependency_unavailable", requestId);
  }
  if (error instanceof AuthenticationError) {
    return errorFrame(error.status, error.code, error.code, requestId);
  }
  if (error instanceof RoomAccessError) {
    return errorFrame(error.status, error.code, error.code, requestId);
  }
  if (error instanceof MessageValidationError) {
    return errorFrame(error.status, error.code, error.code, requestId);
  }
  if (error instanceof MessageIdConflictError) {
    return errorFrame(error.status, error.code, error.code, requestId);
  }
  const mapped = normalizeServiceError(error);
  if (mapped !== undefined) {
    return errorFrame(mapped.status, mapped.code, mapped.code, requestId);
  }
  return errorFrame(500, "internal_error", "Unable to process request", requestId);
}

async function revokeUnacknowledgedSession(
  auth: AuthenticationService,
  accessToken: string,
): Promise<void> {
  try {
    await auth.revoke(accessToken);
  } catch {
    // Preserve the original post-commit failure; compensation is best effort.
  }
}

type GenericProtocolErrorCode = Exclude<ProtocolErrorFrame["code"], "departure_blocked">;

const MAPPED_SERVICE_ERROR_STATUSES = new Map<GenericProtocolErrorCode, ProtocolErrorFrame["status"]>([
  ["invalid_token", 401],
  ["token_expired", 401],
  ["session_revoked", 403],
  ["session_limit_reached", 409],
  ["snapshot_family_revoked", 403],
  ["invalid_request", 400],
  ["invalid_message", 400],
  ["mention_entity_invalid", 400],
  ["author_fields_forbidden", 400],
  ["attachment_feature_unavailable", 400],
  ["invalid_chunk", 400],
  ["unauthenticated", 401],
  ["room_forbidden", 403],
  ["administrator_required", 403],
  ["profile_forbidden", 403],
  ["attachment_forbidden", 403],
  ["snapshot_forbidden", 403],
  ["snapshot_not_found", 404],
  ["room_not_found", 404],
  ["administrator_not_found", 404],
  ["profile_not_found", 404],
  ["assignment_not_found", 404],
  ["memory_not_found", 404],
  ["memory_source_not_found", 404],
  ["reply_target_not_found", 404],
  ["room_archived", 409],
  ["role_forbidden", 403],
  ["room_revision_conflict", 409],
  ["ownership_transfer_required", 409],
  ["member_not_found", 404],
  ["idempotency_conflict", 409],
  ["administrator_already_exists", 409],
  ["last_administrator_required", 409],
  ["administrator_revision_conflict", 409],
  ["profile_revision_conflict", 409],
  ["profile_state_conflict", 409],
  ["assignment_revision_conflict", 409],
  ["assignment_already_exists", 409],
  ["capability_ceiling_conflict", 409],
  ["attachment_already_bound", 409],
  ["generation_conflict", 409],
  ["attachment_not_ready", 409],
  ["upload_offset_conflict", 409],
  ["message_version_conflict", 409],
  ["memory_version_conflict", 409],
  ["memory_recovery_generation_conflict", 409],
  ["message_recalled", 409],
  ["agent_final_immutable", 409],
  ["protocol_upgrade_required", 410],
  ["upload_expired", 410],
  ["attachment_gone", 410],
  ["memory_source_gone", 410],
  ["profile_gone", 410],
  ["assignment_gone", 410],
  ["attachment_too_large", 413],
  ["chunk_too_large", 413],
  ["attachment_type_unsupported", 415],
  ["type_mismatch", 415],
  ["attachment_malformed", 422],
  ["encrypted_pdf", 422],
  ["archive_bomb", 422],
  ["image_bomb", 422],
  ["confirmation_rejected", 409],
  ["grant_revoked", 409],
  ["dependency_unavailable", 503],
  ["snapshot_stale", 409],
  ["snapshot_expired", 410],
  ["snapshot_busy", 429],
  ["capacity_limited", 429],
  ["attachment_capacity_limited", 429],
  ["memory_capacity_limited", 429],
  ["repair_barrier_active", 503],
  ["storage_unavailable", 503],
  ["memory_unavailable", 503],
  ["memory_dependency_unavailable", 503],
  ["scanner_unavailable", 503],
  ["extractor_unavailable", 503],
  ["ocr_unavailable", 503],
  ["agent_configuration_missing", 503],
  ["agent_queue_full", 429],
  ["agent_runtime_closed", 503],
  ["execution_conflict", 409],
  ["execution_not_found", 404],
  ["light_task_not_found", 404],
  ["open_item_not_found", 404],
  ["invalid_parameters", 400],
  ["permission_denied", 403],
  ["provider_authentication", 503],
  ["provider_failure", 503],
  ["provider_malformed", 503],
  ["provider_rate_limited", 503],
  ["provider_timeout", 503],
  ["provider_unavailable", 503],
  ["provider_configuration_unavailable", 503],
  ["side_effect_outcome_unknown", 409],
  ["tool_failure", 503],
  ["tool_target_busy", 503],
]);

const STORAGE_UNAVAILABLE_ERROR_CODES = new Set([
  "authority_not_initialized",
  "authority_worker_closed",
  "authority_worker_error",
  "authority_worker_exited",
  "authority_worker_message_error",
  "authority_worker_not_ready",
  "authority_worker_post_failed",
  "authority_worker_protocol_error",
  "invitation_secret_unavailable",
  "legacy_import_failed",
  "legacy_import_unavailable",
  "snapshot_worker_closed",
  "snapshot_worker_error",
  "snapshot_worker_exited",
  "snapshot_worker_message_error",
  "snapshot_worker_protocol_error",
]);

function normalizeServiceError(error: unknown): {
  readonly status: ProtocolErrorFrame["status"];
  readonly code: GenericProtocolErrorCode;
} | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("status" in error) ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return undefined;
  }
  if (STORAGE_UNAVAILABLE_ERROR_CODES.has(error.code) && error.status === 503) {
    return { status: 503, code: "storage_unavailable" };
  }
  const code = error.code as GenericProtocolErrorCode;
  const status = MAPPED_SERVICE_ERROR_STATUSES.get(code);
  return status !== undefined && status === error.status ? { status, code } : undefined;
}

function sendFrameWithResult(
  socket: WebSocket,
  frame: ServerFrame,
): Promise<OutboxSendResult> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ accepted: false, reason: "closed" });
  }
  try {
    const serialized = JSON.stringify(frame);
    if (serialized === undefined) {
      abortAndTerminate(socket);
      return Promise.resolve({ accepted: false, reason: "send_rejected" });
    }
    const maxBufferedAmount =
      maxBufferedAmountBySocket.get(socket) ??
      MESSAGE_WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES;
    const frameBytes = Buffer.byteLength(serialized, "utf8");
    if (frameBytes > maxBufferedAmount - socket.bufferedAmount) {
      abortAndTerminate(socket);
      return Promise.resolve({ accepted: false, reason: "backpressure" });
    }
    return new Promise<OutboxSendResult>((resolve) => {
      try {
        socket.send(serialized, (error) => {
          if (error != null) {
            abortAndTerminate(socket);
            resolve({ accepted: false, reason: "send_rejected" });
            return;
          }
          resolve({ accepted: true });
        });
      } catch {
        abortAndTerminate(socket);
        resolve({ accepted: false, reason: "send_rejected" });
      }
    });
  } catch {
    abortAndTerminate(socket);
    return Promise.resolve({ accepted: false, reason: "send_rejected" });
  }
}

function sendFrame(socket: WebSocket, frame: ServerFrame): void {
  void sendFrameWithResult(socket, frame);
}

function rawDataToString(raw: RawData): string {
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

function rawDataByteLength(raw: RawData): number {
  if (Array.isArray(raw)) {
    return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return raw.byteLength;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function throwCleanupFailures(message: string, results: readonly PromiseSettledResult<void>[]): void {
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}

function safelyUnsubscribe(unsubscribe: (() => void) | undefined): void {
  try {
    unsubscribe?.();
  } catch {
    // A failing listener cleanup cannot crash the transport event loop.
  }
}

function onceUnsubscribe(unsubscribe: () => void): () => void {
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    safelyUnsubscribe(unsubscribe);
  };
}

function canonicalEventBytes(event: PersistedRoomEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function cleanupV2Gate(context: ConnectionContext, gate: V2SubscriptionGate): void {
  if (context.v2GatesByRoom.get(gate.roomId) === gate) {
    context.v2GatesByRoom.delete(gate.roomId);
  }
  if (context.unsubscribersByRoom.get(gate.roomId) === gate.unsubscribe) {
    context.unsubscribersByRoom.delete(gate.roomId);
  }
  safelyUnsubscribe(gate.unsubscribe);
  gate.unsubscribe = undefined;
}

function unsubscribeV2Gate(context: ConnectionContext, gate: V2SubscriptionGate): void {
  if (context.unsubscribersByRoom.get(gate.roomId) === gate.unsubscribe) {
    context.unsubscribersByRoom.delete(gate.roomId);
  }
  safelyUnsubscribe(gate.unsubscribe);
  gate.unsubscribe = undefined;
}

function captureV2Delivery(
  gate: V2SubscriptionGate,
  event: PersistedRoomEvent,
  maxEvents: number,
  maxBytes: number,
): "captured" | "duplicate" | "overflow" | "corrupt" {
  if (gate.seenEventIds.has(event.eventId)) {
    return "duplicate";
  }
  if (event.streamSeq < gate.cursor.afterSeq) {
    return "duplicate";
  }
  if (event.streamSeq === gate.cursor.afterSeq) {
    return gate.lastContiguousEventId === undefined ||
      gate.lastContiguousEventId === event.eventId
      ? "duplicate"
      : "corrupt";
  }
  if (gate.bufferedEvents.some((buffered) => buffered.streamSeq === event.streamSeq)) {
    return "corrupt";
  }
  const eventBytes = canonicalEventBytes(event);
  if (
    gate.bufferedEvents.length >= maxEvents ||
    eventBytes > maxBytes - gate.bufferedBytes
  ) {
    gate.overflowed = true;
    return "overflow";
  }
  gate.seenEventIds.add(event.eventId);
  gate.bufferedEvents.push(event);
  gate.bufferedBytes += eventBytes;
  return "captured";
}

function removeBufferedEvent(gate: V2SubscriptionGate, event: PersistedRoomEvent): void {
  const index = gate.bufferedEvents.indexOf(event);
  if (index < 0) {
    return;
  }
  gate.bufferedEvents.splice(index, 1);
  gate.bufferedBytes -= canonicalEventBytes(event);
  gate.seenEventIds.delete(event.eventId);
}

async function drainContiguousV2Events(
  socket: WebSocket,
  context: ConnectionContext,
  gate: V2SubscriptionGate,
): Promise<OutboxSendResult> {
  while (true) {
    const nextSequence = gate.cursor.afterSeq + 1;
    const event = gate.bufferedEvents.find(
      (buffered) => buffered.streamSeq === nextSequence,
    );
    if (event === undefined) {
      return { accepted: true };
    }
    if (
      context.closed ||
      context.credentialGeneration !== gate.credentialGeneration ||
      context.subscriptionGenerationsByRoom.get(gate.roomId) !==
        gate.subscriptionGeneration
    ) {
      return { accepted: false, reason: "closed" };
    }
    const result = await sendFrameWithResult(socket, { type: "room.event", event });
    if (!result.accepted) {
      return result;
    }
    removeBufferedEvent(gate, event);
    gate.cursor = {
      version: 1,
      roomId: gate.roomId,
      afterSeq: event.streamSeq,
    };
    gate.lastContiguousEventId = event.eventId;
  }
}

function samePrincipal(
  left: AuthenticatedPrincipal,
  right: AuthenticatedPrincipal,
): boolean {
  return left.accountId === right.accountId && left.actorId === right.actorId;
}

function authenticatedFrame(
  requestId: string,
  principal: AuthenticatedPrincipal,
  session?: IssuedSession,
  resumedSessionId?: string,
): AuthenticatedFrame {
  return session === undefined
    ? {
        type: "auth.authenticated",
        requestId,
        accountId: principal.accountId,
        actorId: principal.actorId,
        ...(resumedSessionId === undefined ? {} : { sessionId: resumedSessionId }),
      }
    : {
        type: "auth.authenticated",
        requestId,
        accountId: principal.accountId,
        actorId: principal.actorId,
        ...(typeof session.sessionId === "string"
          ? { sessionId: session.sessionId }
          : {}),
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt,
        refreshExpiresAt: session.refreshExpiresAt,
      };
}

function installAuthentication(
  context: ConnectionContext,
  principal: AuthenticatedPrincipal,
  accessToken: string,
  session?: AuthenticatedSessionContext,
): boolean {
  if (context.closed) {
    return false;
  }
  context.credentialGeneration += 1;
  for (const gate of [...context.v2GatesByRoom.values()]) {
    if (gate.active) {
      gate.credentialGeneration = context.credentialGeneration;
    } else {
      cleanupV2Gate(context, gate);
    }
  }
  context.principal = principal;
  context.session = session;
  context.accessToken = accessToken;
  return true;
}

function registerIdentitySubscriptions(
  context: ConnectionContext,
  registry: SubscriptionRegistry | undefined,
): void {
  for (const unsubscribe of context.identityUnsubscribers) {
    safelyUnsubscribe(unsubscribe);
  }
  context.identityUnsubscribers.clear();
  const connection = context.registeredConnection;
  const session = context.session;
  if (registry === undefined || connection === undefined || session === undefined) {
    return;
  }
  context.identityUnsubscribers.add(registry.addPrincipal({
    principalId: session.principal.actorId,
    connection,
  }));
  context.identityUnsubscribers.add(registry.addSessionFamily({
    familyId: session.sessionFamilyId,
    connection,
  }));
}

function clearAuthentication(
  context: ConnectionContext,
  expectedGeneration?: number,
  preserveRefreshState = false,
): boolean {
  if (
    expectedGeneration !== undefined &&
    context.credentialGeneration !== expectedGeneration
  ) {
    return false;
  }
  context.credentialGeneration += 1;
  if (!preserveRefreshState) {
    context.principal = undefined;
    context.session = undefined;
  }
  context.accessToken = undefined;
  if (preserveRefreshState) {
    context.clearRoomSubscriptions();
  } else {
    context.clearLiveSubscriptions();
    context.releaseSnapshotOwners();
  }
  return true;
}

function abortConnection(context: ConnectionContext): void {
  if (context.closed) {
    return;
  }
  context.closed = true;
  clearAuthentication(context);
}

async function authenticateCurrent(
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<AuthenticatedPrincipal> {
  const storedPrincipal = context.principal;
  const accessToken = context.accessToken;
  const credentialGeneration = context.credentialGeneration;
  if (storedPrincipal === undefined || accessToken === undefined) {
    throw errorFrame(401, "unauthenticated", "Authentication is required");
  }

  try {
    const authenticatedSession = options.outboxStore === undefined
      ? undefined
      : await options.auth.authenticateSession(accessToken);
    const principal = authenticatedSession?.principal ??
      await options.auth.authenticate(accessToken);
    if (
      context.closed ||
      context.credentialGeneration !== credentialGeneration ||
      context.accessToken !== accessToken
    ) {
      throw errorFrame(401, "unauthenticated", "Authentication is required");
    }
    if (!samePrincipal(principal, storedPrincipal)) {
      clearAuthentication(context, credentialGeneration);
      throw errorFrame(403, "identity_forbidden", "Session identity changed");
    }
    if (authenticatedSession !== undefined) {
      context.session = authenticatedSession;
    }
    return principal;
  } catch (error: unknown) {
    if (
      options.outboxStore !== undefined &&
      error instanceof AuthenticationError &&
      error.code === "session_revoked"
    ) {
      context.terminalRevocationPending = true;
    } else if (normalizeServiceError(error)?.code !== "storage_unavailable") {
      clearAuthentication(
        context,
        credentialGeneration,
        error instanceof AuthenticationError && error.code === "token_expired",
      );
    }
    throw error;
  }
}

function isProtocolErrorFrame(error: unknown): error is ProtocolErrorFrame {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "error" &&
    "status" in error &&
    "code" in error
  );
}

async function requirePrincipal(
  socket: WebSocket,
  requestId: string,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<AuthenticatedPrincipal | undefined> {
  if (context.closed) {
    return undefined;
  }
  if (context.principal === undefined || context.accessToken === undefined) {
    sendFrame(
      socket,
      errorFrame(401, "unauthenticated", "Authentication is required", requestId),
    );
    return undefined;
  }

  try {
    const principal = await authenticateCurrent(options, context);
    return context.closed ? undefined : principal;
  } catch (error: unknown) {
    if (context.closed) {
      return undefined;
    }
    sendFrame(
      socket,
      isProtocolErrorFrame(error)
        ? { ...error, requestId }
        : mappedError(error, requestId),
    );
    return undefined;
  }
}

async function requireSession(
  socket: WebSocket,
  requestId: string,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<AuthenticatedSessionContext | undefined> {
  const principal = await requirePrincipal(socket, requestId, options, context);
  if (principal === undefined) {
    return undefined;
  }
  if (context.session !== undefined) {
    return context.session;
  }
  const accessToken = context.accessToken;
  const generation = context.credentialGeneration;
  if (accessToken === undefined) {
    return undefined;
  }
  try {
    const session = await options.auth.authenticateSession(accessToken);
    if (
      context.closed ||
      context.credentialGeneration !== generation ||
      context.accessToken !== accessToken
    ) {
      return undefined;
    }
    if (!samePrincipal(session.principal, principal)) {
      clearAuthentication(context, generation);
      sendFrame(
        socket,
        errorFrame(403, "identity_forbidden", "Session identity changed", requestId),
      );
      return undefined;
    }
    context.session = session;
    return session;
  } catch (error: unknown) {
    if (!context.closed && context.credentialGeneration === generation) {
      sendFrame(socket, mappedError(error, requestId));
    }
    return undefined;
  }
}

function sendCurrentGeneration(
  socket: WebSocket,
  frame: ServerFrame,
  expectedGeneration: number,
  context: ConnectionContext,
): boolean {
  if (context.closed || context.credentialGeneration !== expectedGeneration) {
    return false;
  }
  sendFrame(socket, frame);
  return true;
}

function rememberStreamingSnapshot(
  frame: ServerFrame,
  session: AuthenticatedSessionContext,
  context: ConnectionContext,
  streamingOwners: Map<string, StreamingSnapshotOwners>,
): void {
  if (
    (frame.type === "room.repair.page" || frame.type === "workspace.bootstrap.page") &&
    frame.mode === "streaming"
  ) {
    context.ownedStreamingSnapshots.set(frame.snapshotId, session);
    const key = `${session.sessionFamilyId}\u0000${frame.snapshotId}`;
    const owners = streamingOwners.get(key) ?? {
      session,
      snapshotId: frame.snapshotId,
      connections: new Map<string, ConnectionContext>(),
    };
    owners.connections.set(context.connectionId, context);
    streamingOwners.set(key, owners);
  }
}

interface StreamingSnapshotOwners {
  readonly session: AuthenticatedSessionContext;
  readonly snapshotId: string;
  readonly connections: Map<string, ConnectionContext>;
}

const TERMINAL_SNAPSHOT_ERROR_CODES = new Set([
  "snapshot_stale",
  "snapshot_expired",
  "snapshot_not_found",
  "snapshot_family_revoked",
  "snapshot_forbidden",
]);

function forgetSharedStreamingSnapshot(
  session: AuthenticatedSessionContext,
  snapshotId: string,
  streamingOwners: Map<string, StreamingSnapshotOwners>,
): void {
  const key = `${session.sessionFamilyId}\u0000${snapshotId}`;
  const owners = streamingOwners.get(key);
  if (owners === undefined) {
    return;
  }
  streamingOwners.delete(key);
  for (const ownerContext of owners.connections.values()) {
    ownerContext.ownedStreamingSnapshots.delete(snapshotId);
  }
}

function isCorrelatedRecoveryResponse(
  frame: Exclude<ClientFrame, {
    readonly type:
      | "auth.login"
      | "auth.resume"
      | "auth.refresh"
      | "auth.revoke"
      | "auth.sessions.list"
      | "auth.session.revoke"
      | "message.send"
      | "message.send.v2"
      | "message.revise"
      | "message.recall"
      | "room.history.v2"
      | "message.revisions.query"
      | "attachment.upload.begin"
      | "attachment.upload.chunk"
      | "attachment.upload.finalize"
      | "attachment.upload.cancel"
      | "attachment.processing.retry"
      | "attachment.status.query"
      | "attachment.preview.open"
      | "attachment.download.open"
      | "attachment.stream.read"
      | "room.history"
      | "room.subscribe"
      | "room.subscribe.v2"
      | "room.governance.get"
      | "room.departure.conflicts"
      | "room.ownership.transfer"
      | "room.member.role.set"
      | "room.member.leave"
      | "room.member.remove"
      | "room.archive"
      | "room.reopen"
      | "agent.invoke"
      | "agent.interrupt"
      | "agent.retry"
      | "agent.tool.confirm"
      | "agent.compensate"
      | "open-item.create"
      | "open-item.transition"
      | "light-task.create"
      | "light-task.transition"
      | "light-task.criterion.set"
      | "ball.query"
      | "room.memory.query.v1"
      | "room.memory.source.query.v1"
      | "room.memory.context.dispute.v1"
      | "room.memory.context.resolve.v1"
      | "room.memory.status.query.v1"
      | "room.memory.retry.v1"
      | "tenant-administrator.list"
      | "tenant-administrator.add"
      | "tenant-administrator.remove"
      | "agent-profile.list"
      | "agent-profile.get"
      | "agent-profile.create"
      | "agent-profile.update"
      | "agent-profile.enable"
      | "agent-profile.disable"
      | "provider-configuration.disclose"
      | "agent-profile.sync"
      | "agent-profile.repair"
      | "room-agent-assignment.list"
      | "room-agent-assignment.get"
      | "room-agent-assignment.create"
      | "room-agent-assignment.update"
      | "room-agent-assignment.pause"
      | "room-agent-assignment.resume"
      | "room-agent-assignment.remove"
      | "room-agent-assignment.repair";
  }>,
  response: unknown,
): response is ServerFrame {
  if (frame.type === "workspace.bootstrap.begin") {
    return isWorkspaceBootstrapPage(response) &&
      response.requestId === frame.requestId && response.page === 0;
  }
  if (frame.type === "workspace.bootstrap.page") {
    return isWorkspaceBootstrapPage(response) &&
      response.requestId === frame.requestId &&
      response.snapshotId === frame.snapshotId &&
      response.page === frame.afterPage + 1;
  }
  if (frame.type === "room.sync") {
    return isRoomSyncResult(response) &&
      response.requestId === frame.requestId &&
      (response.mode !== "delta" || response.nextCursor.roomId === frame.roomId);
  }
  if (frame.type === "room.repair.begin") {
    return isRoomRepairPage(response) &&
      response.requestId === frame.requestId &&
      response.roomId === frame.roomId && response.page === 0;
  }
  if (frame.type === "room.repair.page") {
    return isRoomRepairPage(response) &&
      response.requestId === frame.requestId &&
      response.snapshotId === frame.snapshotId &&
      response.page === frame.afterPage + 1;
  }
  return isSnapshotCompleted(response) &&
    response.requestId === frame.requestId &&
    response.snapshotId === frame.snapshotId &&
    sameSnapshotVersion(response.version, frame.version);
}

function sameSnapshotVersion(left: SnapshotVersion, right: SnapshotVersion): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "catalog" && right.kind === "catalog") {
    return left.catalogRevision === right.catalogRevision;
  }
  return left.kind === "room" && right.kind === "room" &&
    left.roomId === right.roomId && left.watermark === right.watermark;
}

function detachStreamingSnapshot(
  context: ConnectionContext,
  session: AuthenticatedSessionContext,
  snapshotId: string,
  streamingOwners: Map<string, StreamingSnapshotOwners>,
): boolean {
  context.ownedStreamingSnapshots.delete(snapshotId);
  const key = `${session.sessionFamilyId}\u0000${snapshotId}`;
  const owners = streamingOwners.get(key);
  if (owners === undefined) return true;
  owners.connections.delete(context.connectionId);
  if (owners.connections.size > 0) return false;
  streamingOwners.delete(key);
  return true;
}

async function handleRecoveryFrame(
  socket: WebSocket,
  frame: Exclude<ClientFrame, {
    readonly type:
      | "auth.login"
      | "auth.resume"
      | "auth.refresh"
      | "auth.revoke"
      | "auth.sessions.list"
      | "auth.session.revoke"
      | "message.send"
      | "message.send.v2"
      | "message.revise"
      | "message.recall"
      | "room.history.v2"
      | "message.revisions.query"
      | "attachment.upload.begin"
      | "attachment.upload.chunk"
      | "attachment.upload.finalize"
      | "attachment.upload.cancel"
      | "attachment.processing.retry"
      | "attachment.status.query"
      | "attachment.preview.open"
      | "attachment.download.open"
      | "attachment.stream.read"
      | "room.history"
      | "room.subscribe"
      | "room.subscribe.v2"
      | "room.governance.get"
      | "room.departure.conflicts"
      | "room.ownership.transfer"
      | "room.member.role.set"
      | "room.member.leave"
      | "room.member.remove"
      | "room.archive"
      | "room.reopen"
      | "agent.invoke"
      | "agent.interrupt"
      | "agent.retry"
      | "agent.tool.confirm"
      | "agent.compensate"
      | "open-item.create"
      | "open-item.transition"
      | "light-task.create"
      | "light-task.transition"
      | "light-task.criterion.set"
      | "ball.query"
      | "room.memory.query.v1"
      | "room.memory.source.query.v1"
      | "room.memory.context.dispute.v1"
      | "room.memory.context.resolve.v1"
      | "room.memory.status.query.v1"
      | "room.memory.retry.v1"
      | "tenant-administrator.list"
      | "tenant-administrator.add"
      | "tenant-administrator.remove"
      | "agent-profile.list"
      | "agent-profile.get"
      | "agent-profile.create"
      | "agent-profile.update"
      | "agent-profile.enable"
      | "agent-profile.disable"
      | "provider-configuration.disclose"
      | "agent-profile.sync"
      | "agent-profile.repair"
      | "room-agent-assignment.list"
      | "room-agent-assignment.get"
      | "room-agent-assignment.create"
      | "room-agent-assignment.update"
      | "room-agent-assignment.pause"
      | "room-agent-assignment.resume"
      | "room-agent-assignment.remove"
      | "room-agent-assignment.repair";
  }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
  streamingOwners: Map<string, StreamingSnapshotOwners>,
): Promise<void> {
  const session = await requireSession(socket, frame.requestId, options, context);
  if (session === undefined) {
    return;
  }
  const generation = context.credentialGeneration;
  if (options.sync === undefined) {
    sendCurrentGeneration(
      socket,
      errorFrame(503, "storage_unavailable", "storage_unavailable", frame.requestId),
      generation,
      context,
    );
    return;
  }
  try {
    const response = await (() => {
      switch (frame.type) {
        case "workspace.bootstrap.begin":
          return options.sync.beginWorkspaceBootstrap(session, frame.requestId);
        case "workspace.bootstrap.page":
          return options.sync.readWorkspaceBootstrapPage(
            session,
            frame.requestId,
            frame.snapshotId,
            frame.afterPage,
          );
        case "room.sync":
          return options.sync.syncRoom(session, frame);
        case "room.repair.begin":
          return options.sync.beginRoomRepair(session, frame.requestId, frame.roomId);
        case "room.repair.page":
          return options.sync.readRoomRepairPage(
            session,
            frame.requestId,
            frame.snapshotId,
            frame.afterPage,
          );
        case "snapshot.complete":
          return options.sync.completeSnapshot(
            session,
            frame.requestId,
            frame.snapshotId,
            frame.version,
            frame.snapshotChecksum,
          );
      }
    })();
    if (!isCorrelatedRecoveryResponse(frame, response)) {
      sendCurrentGeneration(
        socket,
        errorFrame(503, "storage_unavailable", "storage_unavailable", frame.requestId),
        generation,
        context,
      );
      return;
    }
    rememberStreamingSnapshot(response, session, context, streamingOwners);
    if (sendCurrentGeneration(socket, response, generation, context)) {
      if (response.type === "snapshot.completed") {
        const key = `${session.sessionFamilyId}\u0000${response.snapshotId}`;
        const owners = streamingOwners.get(key);
        if (owners !== undefined) {
          streamingOwners.delete(key);
          for (const ownerContext of owners.connections.values()) {
            ownerContext.ownedStreamingSnapshots.delete(response.snapshotId);
          }
        }
        context.ownedStreamingSnapshots.delete(response.snapshotId);
      }
    } else if (
      (response.type === "room.repair.page" ||
        response.type === "workspace.bootstrap.page") &&
      response.mode === "streaming"
    ) {
      const owner = context.ownedStreamingSnapshots.get(response.snapshotId);
      const lastOwner = owner === undefined || detachStreamingSnapshot(
        context, owner, response.snapshotId, streamingOwners,
      );
      if (owner !== undefined && lastOwner) {
        void options.sync.releaseSnapshot(owner, response.snapshotId).catch(() => undefined);
      }
    }
  } catch (error: unknown) {
    if (
      "snapshotId" in frame &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      TERMINAL_SNAPSHOT_ERROR_CODES.has(error.code)
    ) {
      forgetSharedStreamingSnapshot(session, frame.snapshotId, streamingOwners);
    }
    sendCurrentGeneration(socket, mappedError(error, frame.requestId), generation, context);
  }
}

async function handleLoginOrResume(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "auth.login" | "auth.resume" }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  if (
    context.principal !== undefined ||
    context.accessToken !== undefined ||
    context.authOperationPending
  ) {
    sendFrame(
      socket,
      errorFrame(
        409,
        "already_authenticated",
        "Socket already owns an authenticated session",
        frame.requestId,
      ),
    );
    return;
  }

  context.authOperationPending = true;
  const initialGeneration = context.credentialGeneration;
  let issuedSession: IssuedSession | undefined;
  let installedGeneration: number | undefined;
  try {
    if (frame.type === "auth.login") {
      const session = await options.auth.login({
        accountId: frame.accountId,
        secret: frame.secret,
      }, frame.device);
      issuedSession = session;
      const principal = { accountId: session.accountId, actorId: session.actorId };
      const authenticatedSession = options.outboxStore === undefined
        ? undefined
        : await options.auth.authenticateSession(session.accessToken);
      if (
        authenticatedSession !== undefined &&
        !samePrincipal(authenticatedSession.principal, principal)
      ) {
        throw new AuthenticationError(403, "identity_forbidden");
      }
      if (!installAuthentication(
        context,
        principal,
        session.accessToken,
        authenticatedSession,
      )) {
        await revokeUnacknowledgedSession(options.auth, session.accessToken);
        issuedSession = undefined;
        return;
      }
      installedGeneration = context.credentialGeneration;
      registerIdentitySubscriptions(context, options.subscriptionRegistry);
      const sent = await sendFrameWithResult(
        socket,
        authenticatedFrame(frame.requestId, principal, session),
      );
      if (!sent.accepted) {
        clearAuthentication(context, installedGeneration);
        await revokeUnacknowledgedSession(options.auth, session.accessToken);
        issuedSession = undefined;
        return;
      }
      issuedSession = undefined;
      return;
    }

    const authenticatedSession = options.outboxStore === undefined
      ? undefined
      : await options.auth.authenticateSession(frame.accessToken);
    const principal = authenticatedSession?.principal ??
      await options.auth.authenticate(frame.accessToken);
    const currentSessions = (await options.auth.listSessions(frame.accessToken)).filter(
      (session) => session.current,
    );
    if (currentSessions.length !== 1) {
      throw new Error("Authenticated session list must have exactly one current session");
    }
    const [currentSession] = currentSessions;
    if (!installAuthentication(context, principal, frame.accessToken, authenticatedSession)) {
      return;
    }
    registerIdentitySubscriptions(context, options.subscriptionRegistry);
    sendFrame(
      socket,
      authenticatedFrame(frame.requestId, principal, undefined, currentSession!.id),
    );
  } catch (error: unknown) {
    if (issuedSession !== undefined) {
      clearAuthentication(
        context,
        installedGeneration ?? initialGeneration,
      );
      await revokeUnacknowledgedSession(options.auth, issuedSession.accessToken);
      issuedSession = undefined;
    }
    if (!context.closed) {
      sendFrame(socket, mappedError(error, frame.requestId));
    }
  } finally {
    context.authOperationPending = false;
  }
}

async function handleRefresh(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "auth.refresh" }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  if (context.authOperationPending) {
    sendFrame(
      socket,
      errorFrame(
        409,
        "already_authenticated",
        "An authentication operation is already active",
        frame.requestId,
      ),
    );
    return;
  }

  const expectedPrincipal = context.principal;
  context.authOperationPending = true;
  const initialGeneration = context.credentialGeneration;
  let issuedSession: IssuedSession | undefined;
  let installedGeneration: number | undefined;
  try {
    const session = await options.auth.refresh(frame.refreshToken, expectedPrincipal);
    issuedSession = session;
    if (context.closed) {
      await revokeUnacknowledgedSession(options.auth, session.accessToken);
      issuedSession = undefined;
      return;
    }
    const refreshedPrincipal = {
      accountId: session.accountId,
      actorId: session.actorId,
    };
    if (
      expectedPrincipal !== undefined &&
      !samePrincipal(expectedPrincipal, refreshedPrincipal)
    ) {
      throw new AuthenticationError(403, "identity_forbidden");
    }

    const authenticatedSession = options.outboxStore === undefined
      ? undefined
      : await options.auth.authenticateSession(session.accessToken);
    if (
      authenticatedSession !== undefined &&
      !samePrincipal(authenticatedSession.principal, refreshedPrincipal)
    ) {
      throw new AuthenticationError(403, "identity_forbidden");
    }
    if (!installAuthentication(
      context,
      refreshedPrincipal,
      session.accessToken,
      authenticatedSession,
    )) {
      await revokeUnacknowledgedSession(options.auth, session.accessToken);
      issuedSession = undefined;
      return;
    }
    installedGeneration = context.credentialGeneration;
    registerIdentitySubscriptions(context, options.subscriptionRegistry);
    const sent = await sendFrameWithResult(
      socket,
      authenticatedFrame(frame.requestId, refreshedPrincipal, session),
    );
    if (!sent.accepted) {
      clearAuthentication(context, installedGeneration);
      await revokeUnacknowledgedSession(options.auth, session.accessToken);
      issuedSession = undefined;
      return;
    }
    issuedSession = undefined;
  } catch (error: unknown) {
    if (issuedSession !== undefined) {
      clearAuthentication(
        context,
        installedGeneration ?? initialGeneration,
      );
      await revokeUnacknowledgedSession(options.auth, issuedSession.accessToken);
      issuedSession = undefined;
    }
    if (!context.closed) {
      sendFrame(socket, mappedError(error, frame.requestId));
    }
  } finally {
    context.authOperationPending = false;
  }
}

async function handleRevoke(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "auth.revoke" }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  const accessToken = context.accessToken;
  if (context.principal === undefined || accessToken === undefined) {
    sendFrame(
      socket,
      errorFrame(401, "unauthenticated", "Authentication is required", frame.requestId),
    );
    return;
  }

  context.authOperationPending = true;
  try {
    await options.auth.revoke(accessToken);
    if (context.session !== undefined) {
      options.attachmentAuthority?.invalidateFamily(context.session.sessionFamilyId);
    }
    if (options.outboxStore === undefined) {
      clearAuthentication(context);
      sendFrame(socket, { type: "auth.revoked", requestId: frame.requestId });
    } else {
      context.terminalRevocationPending = true;
    }
  } catch (error: unknown) {
    if (options.outboxStore === undefined) {
      clearAuthentication(context);
    }
    if (!context.closed) {
      sendFrame(socket, mappedError(error, frame.requestId));
    }
  } finally {
    context.authOperationPending = false;
  }
}

async function handleListSessions(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "auth.sessions.list" }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  const principal = await requirePrincipal(socket, frame.requestId, options, context);
  const accessToken = context.accessToken;
  if (principal === undefined || accessToken === undefined) {
    return;
  }
  const generation = context.credentialGeneration;

  try {
    const sessions = await options.auth.listSessions(accessToken);
    const response = { type: "auth.sessions" as const, requestId: frame.requestId, sessions };
    if (
      sessions.length > MAX_ACTIVE_SESSION_FAMILIES ||
      Buffer.byteLength(JSON.stringify(response), "utf8") >
        MESSAGE_WEBSOCKET_MAX_PAYLOAD_BYTES
    ) {
      throw new Error("Authentication session list exceeds the protocol bound");
    }
    sendCurrentGeneration(
      socket,
      response,
      generation,
      context,
    );
  } catch (error: unknown) {
    sendCurrentGeneration(
      socket,
      mappedError(error, frame.requestId),
      generation,
      context,
    );
  }
}

async function handleTargetedRevoke(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "auth.session.revoke" }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  const principal = await requirePrincipal(socket, frame.requestId, options, context);
  const accessToken = context.accessToken;
  if (principal === undefined || accessToken === undefined) {
    return;
  }
  const generation = context.credentialGeneration;

  try {
    await options.auth.revokeSession(accessToken, frame.sessionId);
    sendCurrentGeneration(
      socket,
      {
        type: "auth.session.revoke.ack",
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        revoked: true,
      },
      generation,
      context,
    );
  } catch (error: unknown) {
    sendCurrentGeneration(
      socket,
      mappedError(error, frame.requestId),
      generation,
      context,
    );
  }
}

async function handleSubscribe(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "room.subscribe" }>,
  actorId: string,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  if (context.closed) {
    return;
  }
  const generation = (context.subscriptionGenerationsByRoom.get(frame.roomId) ?? 0) + 1;
  context.subscriptionGenerationsByRoom.set(frame.roomId, generation);

  const previousUnsubscribe = context.unsubscribersByRoom.get(frame.roomId);
  context.unsubscribersByRoom.delete(frame.roomId);
  safelyUnsubscribe(previousUnsubscribe);
  const previousGate = context.v2GatesByRoom.get(frame.roomId);
  if (previousGate !== undefined) {
    cleanupV2Gate(context, previousGate);
  }

  if (options.outboxStore !== undefined) {
    const session = context.session;
    const connection = context.registeredConnection;
    const registry = options.subscriptionRegistry;
    if (session === undefined || connection === undefined || registry === undefined) {
      sendFrame(socket, errorFrame(
        401,
        "unauthenticated",
        "Authentication is required",
        frame.requestId,
      ));
      return;
    }
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = onceUnsubscribe(registry.addRoom({
        roomId: frame.roomId,
        connection,
      }));
      context.unsubscribersByRoom.set(frame.roomId, unsubscribe);
      await options.afterSubscribeRegistered?.(frame.roomId);
      if (
        context.closed ||
        context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
      ) {
        safelyUnsubscribe(unsubscribe);
        return;
      }
      const messages = await options.service.history(session, frame.roomId);
      if (
        context.closed ||
        context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
      ) {
        safelyUnsubscribe(unsubscribe);
        return;
      }
      sendFrame(socket, {
        type: "room.history",
        requestId: frame.requestId,
        roomId: frame.roomId,
        messages,
      });
      sendFrame(socket, {
        type: "room.subscribed",
        requestId: frame.requestId,
        roomId: frame.roomId,
      });
      return;
    } catch (error: unknown) {
      safelyUnsubscribe(unsubscribe);
      if (context.unsubscribersByRoom.get(frame.roomId) === unsubscribe) {
        context.unsubscribersByRoom.delete(frame.roomId);
      }
      context.subscriptionGenerationsByRoom.delete(frame.roomId);
      if (!context.closed) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
  }

  let unsubscribe: (() => void) | undefined;
  let deliveryQueue = Promise.resolve();
  try {
    unsubscribe = onceUnsubscribe(
      options.service.subscribe(actorId, frame.roomId, (message) => {
        deliveryQueue = deliveryQueue.then(async () => {
          if (
            context.closed ||
            context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
          ) {
            return;
          }
          try {
            await authenticateCurrent(options, context);
          } catch {
            return;
          }
          if (
            !context.closed &&
            context.subscriptionGenerationsByRoom.get(frame.roomId) === generation
          ) {
            sendFrame(socket, { type: "message.created", message });
          }
        });
        return deliveryQueue;
      }),
    );
    if (context.closed) {
      safelyUnsubscribe(unsubscribe);
      return;
    }
    context.unsubscribersByRoom.set(frame.roomId, unsubscribe);

    await options.afterSubscribeRegistered?.(frame.roomId);
    await deliveryQueue;
    if (
      context.closed ||
      context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
    ) {
      safelyUnsubscribe(unsubscribe);
      return;
    }

    const messages = await options.service.history(actorId, frame.roomId);
    if (
      context.closed ||
      context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation
    ) {
      safelyUnsubscribe(unsubscribe);
      return;
    }

    sendFrame(socket, {
      type: "room.history",
      requestId: frame.requestId,
      roomId: frame.roomId,
      messages,
    });
    sendFrame(socket, {
      type: "room.subscribed",
      requestId: frame.requestId,
      roomId: frame.roomId,
    });
  } catch (error: unknown) {
    safelyUnsubscribe(unsubscribe);
    if (context.closed) {
      return;
    }
    if (context.subscriptionGenerationsByRoom.get(frame.roomId) !== generation) {
      return;
    }
    if (context.unsubscribersByRoom.get(frame.roomId) === unsubscribe) {
      context.unsubscribersByRoom.delete(frame.roomId);
    }
    context.subscriptionGenerationsByRoom.delete(frame.roomId);
    sendFrame(socket, mappedError(error, frame.requestId));
  }
}

async function handleSubscribeV2(
  socket: WebSocket,
  frame: Extract<ClientFrame, { type: "room.subscribe.v2" }>,
  options: StartMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  const session = await requireSession(socket, frame.requestId, options, context);
  if (session === undefined) {
    return;
  }
  const registry = options.subscriptionRegistry;
  const connection = context.registeredConnection;
  if (
    options.sync === undefined ||
    options.outboxStore === undefined ||
    registry === undefined ||
    connection === undefined
  ) {
    sendFrame(
      socket,
      errorFrame(503, "storage_unavailable", "storage_unavailable", frame.requestId),
    );
    return;
  }
  const credentialGeneration = context.credentialGeneration;
  const subscriptionGeneration =
    (context.subscriptionGenerationsByRoom.get(frame.roomId) ?? 0) + 1;
  context.subscriptionGenerationsByRoom.set(frame.roomId, subscriptionGeneration);
  const previousUnsubscribe = context.unsubscribersByRoom.get(frame.roomId);
  context.unsubscribersByRoom.delete(frame.roomId);
  safelyUnsubscribe(previousUnsubscribe);
  const previousGate = context.v2GatesByRoom.get(frame.roomId);
  if (previousGate !== undefined) {
    cleanupV2Gate(context, previousGate);
  }
  const gate: V2SubscriptionGate = {
    requestId: frame.requestId,
    roomId: frame.roomId,
    credentialGeneration,
    subscriptionGeneration,
    seenEventIds: new Set(),
    bufferedEvents: [],
    bufferedBytes: 0,
    overflowed: false,
    active: false,
    cursor: frame.cursor,
    lastContiguousEventId: undefined,
    unsubscribe: undefined,
  };
  context.v2GatesByRoom.set(frame.roomId, gate);
  try {
    gate.unsubscribe = onceUnsubscribe(registry.addRoom({ roomId: frame.roomId, connection }));
    context.unsubscribersByRoom.set(frame.roomId, gate.unsubscribe);
    await options.afterSubscribeRegistered?.(frame.roomId);
    if (
      context.closed ||
      context.credentialGeneration !== credentialGeneration ||
      context.subscriptionGenerationsByRoom.get(frame.roomId) !== subscriptionGeneration
    ) {
      cleanupV2Gate(context, gate);
      return;
    }
    let syncCursor = frame.cursor;
    let watermark: number | undefined;
    while (true) {
      const result = await options.sync.syncRoom(session, {
        type: "room.sync",
        requestId: frame.requestId,
        roomId: frame.roomId,
        cursor: syncCursor,
      });
      if (!isRoomSyncResult(result) || result.requestId !== frame.requestId) {
        cleanupV2Gate(context, gate);
        sendCurrentGeneration(
          socket,
          errorFrame(503, "storage_unavailable", "storage_unavailable", frame.requestId),
          credentialGeneration,
          context,
        );
        return;
      }
      if (
        context.closed ||
        context.credentialGeneration !== credentialGeneration ||
        context.subscriptionGenerationsByRoom.get(frame.roomId) !== subscriptionGeneration
      ) {
        cleanupV2Gate(context, gate);
        return;
      }
      if (result.mode !== "delta") {
        cleanupV2Gate(context, gate);
        sendCurrentGeneration(socket, result, credentialGeneration, context);
        return;
      }
      if (
        result.nextCursor.roomId !== frame.roomId ||
        (result.hasMore && result.nextCursor.afterSeq <= syncCursor.afterSeq) ||
        (watermark !== undefined && result.watermark !== watermark)
      ) {
        cleanupV2Gate(context, gate);
        sendCurrentGeneration(
          socket,
          errorFrame(503, "storage_unavailable", "storage_unavailable", frame.requestId),
          credentialGeneration,
          context,
        );
        return;
      }
      watermark ??= result.watermark;
      sendCurrentGeneration(socket, result, credentialGeneration, context);
      for (const event of result.events) {
        if (event.streamSeq === result.nextCursor.afterSeq) {
          gate.lastContiguousEventId = event.eventId;
        }
      }
      syncCursor = result.nextCursor;
      gate.cursor = result.nextCursor;
      if (!result.hasMore) {
        break;
      }
    }
    if (Object.hasOwn(gate.cursor, "watermark")) {
      cleanupV2Gate(context, gate);
      sendCurrentGeneration(
        socket,
        errorFrame(503, "storage_unavailable", "storage_unavailable", frame.requestId),
        credentialGeneration,
        context,
      );
      return;
    }
    if (gate.overflowed) {
      cleanupV2Gate(context, gate);
      sendCurrentGeneration(socket, {
        type: "room.subscribe.v2.retry",
        requestId: frame.requestId,
        roomId: frame.roomId,
        reason: "gate_overflow",
        restartFrom: gate.cursor,
      }, credentialGeneration, context);
      return;
    }
    for (const event of [...gate.bufferedEvents]) {
      if (event.streamSeq <= (watermark ?? gate.cursor.afterSeq)) {
        removeBufferedEvent(gate, event);
      }
    }
    gate.active = true;
    const drainResult = await drainContiguousV2Events(socket, context, gate);
    if (!drainResult.accepted) {
      cleanupV2Gate(context, gate);
      return;
    }
    if (
      context.closed ||
      context.credentialGeneration !== credentialGeneration ||
      context.subscriptionGenerationsByRoom.get(frame.roomId) !== subscriptionGeneration
    ) {
      cleanupV2Gate(context, gate);
      return;
    }
    sendCurrentGeneration(socket, {
      type: "room.subscribed.v2",
      requestId: frame.requestId,
      roomId: frame.roomId,
      cursor: gate.cursor,
      watermark: Math.max(watermark ?? gate.cursor.afterSeq, gate.cursor.afterSeq),
    }, credentialGeneration, context);
  } catch (error: unknown) {
    cleanupV2Gate(context, gate);
    sendCurrentGeneration(socket, mappedError(error, frame.requestId), credentialGeneration, context);
  }
}

const ft07MutationTypes = new Set<string>(FT07_AGENT_SETTINGS_MUTATIONS);

function isCorrelatedFt07Response(
  frame: Ft07AgentSettingsClientFrame,
  response: unknown,
): response is Ft07AgentSettingsServerFrame {
  if (!isFt07AgentSettingsServerFrame(response)) return false;
  if (!("requestId" in response) || response.requestId !== frame.requestId) return false;
  switch (frame.type) {
    case "tenant-administrator.list":
      return response.type === "tenant-administrator.registry";
    case "agent-profile.list":
      return response.type === "agent-profile.catalog";
    case "agent-profile.get":
      return response.type === "agent-profile.detail" && response.profile.profileId === frame.profileId;
    case "provider-configuration.disclose":
      return response.type === "provider-configuration.disclosure";
    case "agent-profile.sync":
      return response.type === "agent-profile.sync.result";
    case "agent-profile.repair":
      return response.type === "agent-profile.repair.snapshot";
    case "room-agent-assignment.list":
      return response.type === "room-agent-assignment.catalog" && response.roomId === frame.roomId;
    case "room-agent-assignment.get":
      return response.type === "room-agent-assignment.detail" && response.roomId === frame.roomId &&
        response.assignment.assignmentId === frame.assignmentId;
    case "room-agent-assignment.repair":
      return response.type === "room-agent-assignment.repair.snapshot" && response.roomId === frame.roomId;
    default:
      return response.type === "agent-settings.ack" && response.operation === frame.type;
  }
}

async function handleFt07AgentSettingsFrame(
  socket: WebSocket,
  frame: Ft07AgentSettingsClientFrame,
  options: RuntimeMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  const session = await requireSession(socket, frame.requestId, options, context);
  if (session === undefined) return;
  const authority = options.agentSettingsAuthority;
  const syncOperation = frame.type === "agent-profile.sync" ||
    frame.type === "agent-profile.repair" || frame.type === "room-agent-assignment.repair";
  if ((!syncOperation && authority === undefined) || (syncOperation && options.sync === undefined)) {
    sendFrame(socket, errorFrame(
      503, "storage_unavailable", "storage_unavailable", frame.requestId,
    ));
    return;
  }
  const generation = context.credentialGeneration;
  try {
    const response = frame.type === "agent-profile.sync"
      ? await options.sync!.syncAgentProfiles(session, frame.requestId, frame.afterSeq, frame.limit)
      : frame.type === "agent-profile.repair"
        ? await options.sync!.repairAgentProfiles(session, frame.requestId)
        : frame.type === "room-agent-assignment.repair"
          ? await options.sync!.repairRoomAgentAssignments(session, frame.requestId, frame.roomId)
          : ft07MutationTypes.has(frame.type)
      ? await authority!.executeMutation({
          ...session,
          kind: "human",
          requestId: frame.requestId,
          idempotencyKey: (frame as Ft07AgentSettingsMutationFrame).idempotencyKey,
        }, frame as Ft07AgentSettingsMutationFrame)
      : await authority!.executeQuery(session, frame as Ft07AgentSettingsQueryFrame);
    if (!isCorrelatedFt07Response(frame, response)) {
      sendCurrentGeneration(socket, errorFrame(
        503, "storage_unavailable", "storage_unavailable", frame.requestId,
      ), generation, context);
      return;
    }
    sendCurrentGeneration(socket, response, generation, context);
  } catch (error: unknown) {
    sendCurrentGeneration(socket, mappedError(error, frame.requestId), generation, context);
  }
}

async function handleFrame(
  socket: WebSocket,
  frame: ClientFrame,
  options: RuntimeMessageWebSocketServerOptions,
  context: ConnectionContext,
): Promise<void> {
  if (context.terminalRevocationPending) {
    return;
  }
  switch (frame.type) {
    case "tenant-administrator.list":
    case "tenant-administrator.add":
    case "tenant-administrator.remove":
    case "agent-profile.list":
    case "agent-profile.get":
    case "agent-profile.create":
    case "agent-profile.update":
    case "agent-profile.enable":
    case "agent-profile.disable":
    case "provider-configuration.disclose":
    case "agent-profile.sync":
    case "agent-profile.repair":
    case "room-agent-assignment.list":
    case "room-agent-assignment.get":
    case "room-agent-assignment.create":
    case "room-agent-assignment.update":
    case "room-agent-assignment.pause":
    case "room-agent-assignment.resume":
    case "room-agent-assignment.remove":
    case "room-agent-assignment.repair":
      await handleFt07AgentSettingsFrame(socket, frame, options, context);
      return;
    case "auth.login":
    case "auth.resume":
      await handleLoginOrResume(socket, frame, options, context);
      return;
    case "auth.refresh":
      await handleRefresh(socket, frame, options, context);
      return;
    case "auth.revoke":
      await handleRevoke(socket, frame, options, context);
      return;
    case "auth.sessions.list":
      await handleListSessions(socket, frame, options, context);
      return;
    case "auth.session.revoke":
      await handleTargetedRevoke(socket, frame, options, context);
      return;
    case "attachment.upload.begin":
    case "attachment.upload.chunk":
    case "attachment.upload.finalize":
    case "attachment.upload.cancel":
    case "attachment.processing.retry":
    case "attachment.status.query":
    case "attachment.preview.open":
    case "attachment.download.open":
    case "attachment.stream.read": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      const authority = options.attachmentAuthority;
      if (authority === undefined) {
        sendFrame(socket, errorFrame(
          503,
          "storage_unavailable",
          "storage_unavailable",
          frame.requestId,
        ));
        return;
      }
      const credentialGeneration = context.credentialGeneration;
      try {
        const response = await authority.execute({
          ...session,
          kind: "human",
          requestId: frame.requestId,
          idempotencyKey: `attachment:${frame.type}:${frame.requestId}`,
        }, frame);
        sendCurrentGeneration(socket, response, credentialGeneration, context);
      } catch (error: unknown) {
        sendCurrentGeneration(
          socket,
          mappedError(error, frame.requestId),
          credentialGeneration,
          context,
        );
      }
      return;
    }
    case "message.send.v2":
    case "message.revise":
    case "message.recall":
    case "room.history.v2":
    case "message.revisions.query": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) {
        return;
      }
      const authority = options.messageAuthority;
      if (authority === undefined) {
        sendFrame(socket, errorFrame(
          503,
          "dependency_unavailable",
          "dependency_unavailable",
          frame.requestId,
        ));
        return;
      }
      try {
        if (frame.type === "message.send.v2") {
          const accepted = closeMessageSubmitResult(
            await authority.submitHumanMessage({
              ...session,
              kind: "human",
              requestId: frame.requestId,
              idempotencyKey: frame.message.messageId,
            }, frame.message),
            frame.message,
          );
          if (accepted !== undefined) {
            sendFrame(socket, {
              type: "message.accepted",
              requestId: frame.requestId,
              ...accepted,
            });
            return;
          }
        } else if (frame.type === "message.revise") {
          const accepted = closeMessageRevisionResult(
            await authority.reviseHumanMessage({
              ...session,
              kind: "human",
              requestId: frame.requestId,
              idempotencyKey:
                `message.revise:${frame.messageId}:${frame.expectedRevision}`,
            }, {
              roomId: frame.roomId,
              messageId: frame.messageId,
              expectedRevision: frame.expectedRevision,
              body: frame.body,
            }),
            frame.messageId,
            frame.expectedRevision,
          );
          if (accepted !== undefined) {
            sendFrame(socket, {
              type: "message.revision.accepted",
              requestId: frame.requestId,
              ...accepted,
            });
            return;
          }
        } else if (frame.type === "message.recall") {
          const accepted = closeMessageRecallResult(
            await authority.recallHumanMessage({
              ...session,
              kind: "human",
              requestId: frame.requestId,
              idempotencyKey:
                `message.recall:${frame.messageId}:${frame.expectedRevision}`,
            }, {
              roomId: frame.roomId,
              messageId: frame.messageId,
              expectedRevision: frame.expectedRevision,
            }),
            frame.messageId,
            frame.expectedRevision,
          );
          if (accepted !== undefined) {
            sendFrame(socket, {
              type: "message.recall.accepted",
              requestId: frame.requestId,
              ...accepted,
            });
            return;
          }
        } else if (frame.type === "room.history.v2") {
          const input = {
            roomId: frame.roomId,
            ...(frame.afterMessageId === undefined
              ? {}
              : { afterMessageId: frame.afterMessageId }),
            ...(frame.limit === undefined ? {} : { limit: frame.limit }),
          };
          const history = closeMessageHistoryResult(
            await authority.readMessageHistory(session, input),
            frame.roomId,
            frame.limit ?? PROTOCOL_FIELD_LIMITS.historyPage,
          );
          if (history !== undefined) {
            sendFrame(socket, {
              type: "room.history.v2",
              requestId: frame.requestId,
              roomId: frame.roomId,
              ...history,
            });
            return;
          }
        } else {
          const input = {
            roomId: frame.roomId,
            messageId: frame.messageId,
            ...(frame.afterRevision === undefined
              ? {}
              : { afterRevision: frame.afterRevision }),
            ...(frame.limit === undefined ? {} : { limit: frame.limit }),
          };
          const revisions = closeMessageRevisionsResult(
            await authority.readMessageRevisions(session, input),
            frame.messageId,
            frame.afterRevision ?? 0,
            frame.limit ?? PROTOCOL_FIELD_LIMITS.revisionPage,
          );
          if (revisions !== undefined) {
            sendFrame(socket, {
              type: "message.revisions",
              requestId: frame.requestId,
              roomId: frame.roomId,
              messageId: frame.messageId,
              ...revisions,
            });
            return;
          }
        }
        sendFrame(socket, errorFrame(
          503,
          "dependency_unavailable",
          "dependency_unavailable",
          frame.requestId,
        ));
      } catch (error: unknown) {
        if (!context.closed) {
          sendFrame(socket, mappedError(error, frame.requestId));
        }
      }
      return;
    }
    case "message.send": {
      const principal = await requirePrincipal(socket, frame.requestId, options, context);
      if (principal === undefined) {
        return;
      }
      try {
        const acknowledgement = options.outboxStore === undefined
          ? await options.service.send(principal.actorId, frame.message)
          : context.session === undefined
            ? (() => { throw new RoomAccessError(); })()
            : await options.service.send({
                ...context.session,
                kind: "human",
                requestId: frame.requestId,
                idempotencyKey: frame.message.id,
              }, frame.message);
        if (!context.closed) {
          sendFrame(socket, { ...acknowledgement, requestId: frame.requestId });
        }
      } catch (error: unknown) {
        if (!context.closed) {
          sendFrame(socket, mappedError(error, frame.requestId));
        }
      }
      return;
    }
    case "room.governance.get": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      if (options.governance === undefined) {
        sendFrame(socket, errorFrame(503, "dependency_unavailable", "dependency_unavailable", frame.requestId));
        return;
      }
      try {
        const governance = closeGovernanceView(
          await options.governance.readRoomGovernance(session, frame.roomId),
          frame.roomId,
        );
        if (governance === undefined) {
          sendFrame(socket, errorFrame(
            503, "dependency_unavailable", "dependency_unavailable", frame.requestId,
          ));
          return;
        }
        sendFrame(socket, { type: "room.governance", requestId: frame.requestId, governance });
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
    case "room.departure.conflicts": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      const governanceService = options.governance;
      const query = governanceService?.readDepartureConflicts;
      if (query === undefined) {
        sendFrame(socket, errorFrame(
          503, "dependency_unavailable", "dependency_unavailable", frame.requestId,
        ));
        return;
      }
      try {
        const conflicts = closeDepartureConflictList(
          await query.call(governanceService, session, {
            roomId: frame.roomId,
            targetActorId: frame.targetActorId,
          }),
          frame.roomId,
          frame.targetActorId,
        );
        if (conflicts === undefined) {
          sendFrame(socket, errorFrame(
            503, "dependency_unavailable", "dependency_unavailable", frame.requestId,
          ));
          return;
        }
        sendFrame(socket, {
          type: "room.departure.conflicts.result",
          requestId: frame.requestId,
          conflicts,
        });
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
    case "room.ownership.transfer":
    case "room.member.role.set": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      if (options.governance === undefined) {
        sendFrame(socket, errorFrame(503, "dependency_unavailable", "dependency_unavailable", frame.requestId));
        return;
      }
      const command = frame.type === "room.ownership.transfer"
        ? { type: frame.type, roomId: frame.roomId, payload: {
            targetActorId: frame.targetActorId,
            expectedGovernanceRevision: frame.expectedGovernanceRevision,
          } } as const
        : { type: frame.type, roomId: frame.roomId, payload: {
            targetActorId: frame.targetActorId, role: frame.role,
            expectedGovernanceRevision: frame.expectedGovernanceRevision,
          } } as const;
      try {
        const acknowledgement = await options.governance.executeHuman({
          ...session, kind: "human", requestId: frame.requestId,
          idempotencyKey: frame.idempotencyKey,
        }, command);
        const governance = closeGovernanceView(
          await options.governance.readRoomGovernance(session, frame.roomId),
          frame.roomId,
        );
        if (governance === undefined) {
          sendFrame(socket, errorFrame(
            503, "dependency_unavailable", "dependency_unavailable", frame.requestId,
          ));
          return;
        }
        sendFrame(socket, {
          type: "room.governance.ack", requestId: frame.requestId,
          operation: frame.type, governance, eventIds: acknowledgement.eventIds,
        });
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
    case "room.member.leave":
    case "room.member.remove":
    case "room.archive":
    case "room.reopen": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      const governanceService = options.governance;
      const execute = governanceService?.executeHumanGovernance;
      if (execute === undefined) {
        sendFrame(socket, errorFrame(
          503, "dependency_unavailable", "dependency_unavailable", frame.requestId,
        ));
        return;
      }
      const command = frame.type === "room.member.remove"
        ? {
            type: frame.type,
            roomId: frame.roomId,
            payload: {
              targetActorId: frame.targetActorId,
              expectedGovernanceRevision: frame.expectedGovernanceRevision,
            },
          } as const
        : {
            type: frame.type,
            roomId: frame.roomId,
            payload: { expectedGovernanceRevision: frame.expectedGovernanceRevision },
          } as const;
      const departureScope = frame.type === "room.member.leave"
        ? { roomId: frame.roomId, targetActorId: session.principal.actorId }
        : frame.type === "room.member.remove"
          ? { roomId: frame.roomId, targetActorId: frame.targetActorId }
          : undefined;
      try {
        const acknowledgement = closeGovernanceAcknowledgement(
          await execute.call(governanceService, {
            ...session,
            kind: "human",
            requestId: frame.requestId,
            idempotencyKey: frame.idempotencyKey,
          }, command),
          frame.roomId,
          frame.type,
        );
        if (acknowledgement === undefined) {
          sendFrame(socket, errorFrame(
            503, "dependency_unavailable", "dependency_unavailable", frame.requestId,
          ));
          return;
        }
        sendFrame(socket, {
          type: "room.governance.ack",
          requestId: frame.requestId,
          operation: frame.type,
          governance: acknowledgement.governance,
          eventIds: acknowledgement.eventIds,
          replayed: acknowledgement.replayed,
        });
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId, departureScope));
      }
      return;
    }
    case "open-item.create":
    case "open-item.transition": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      if (options.collaboration === undefined) {
        sendFrame(socket, errorFrame(503, "storage_unavailable", "storage_unavailable", frame.requestId));
        return;
      }
      const commandContext = {
        ...session,
        kind: "human" as const,
        requestId: frame.requestId,
        idempotencyKey: frame.type === "open-item.create"
          ? `${frame.creationKind}:${frame.sourceMessageId}:${frame.targetActorId}`
          : `${frame.type}:${frame.requestId}`,
      };
      try {
        const item = frame.type === "open-item.create"
          ? await options.collaboration.createOpenItem(commandContext, frame.roomId, {
              creationKind: frame.creationKind,
              sourceMessageId: frame.sourceMessageId,
              targetActorId: frame.targetActorId,
              content: frame.content,
            })
          : await options.collaboration.transitionOpenItem(commandContext, frame.roomId,
              frame.action === "answer"
                ? { itemId: frame.itemId, action: "answer" }
                : frame.action === "transfer"
                  ? { itemId: frame.itemId, action: "transfer", targetActorId: frame.targetActorId, reason: frame.reason }
                  : { itemId: frame.itemId, action: frame.action, reason: frame.reason });
        sendFrame(socket, { type: "open-item.ack", requestId: frame.requestId, item });
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
    case "light-task.create":
    case "light-task.transition":
    case "light-task.criterion.set": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      if (options.collaboration === undefined) {
        sendFrame(socket, errorFrame(503, "storage_unavailable", "storage_unavailable", frame.requestId));
        return;
      }
      const commandContext = {
        ...session,
        kind: "human" as const,
        requestId: frame.requestId,
        idempotencyKey: `${frame.type}:${frame.requestId}`,
      };
      try {
        const task = frame.type === "light-task.create"
          ? await options.collaboration.createLightTask(commandContext, frame.roomId, {
              sourceMessageId: frame.sourceMessageId,
              title: frame.title,
              verifierRole: frame.verifierRole,
              criteria: frame.criteria,
            })
          : frame.type === "light-task.transition"
            ? await options.collaboration.transitionLightTask(commandContext, frame.roomId, {
                taskId: frame.taskId,
                action: frame.action,
                ...(frame.action === "verify" && frame.emptyCriteriaConfirmed === true
                  ? { emptyCriteriaConfirmed: true as const }
                  : {}),
              })
            : await options.collaboration.setLightTaskCriterion(commandContext, frame.roomId, {
                taskId: frame.taskId,
                criterionId: frame.criterionId,
                met: frame.met,
              });
        sendFrame(socket, { type: "light-task.ack", requestId: frame.requestId, task });
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
    case "ball.query": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      if (options.ballRuntime === undefined) {
        sendFrame(socket, errorFrame(503, "storage_unavailable", "storage_unavailable", frame.requestId));
        return;
      }
      try {
        const result = await options.ballRuntime.query(session, frame.roomId);
        sendFrame(socket, {
          type: "ball.query.result", requestId: frame.requestId, roomId: frame.roomId,
          balls: result.balls, needsAction: result.needsAction, reminders: result.reminders,
        });
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
    case "agent.invoke": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      sendFrame(socket, errorFrame(
        410,
        "protocol_upgrade_required",
        "protocol_upgrade_required",
        frame.requestId,
      ));
      return;
    }
    case "agent.interrupt":
    case "agent.retry":
    case "agent.tool.confirm":
    case "agent.compensate": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      if (options.agentRuntime === undefined) {
        sendFrame(socket, errorFrame(503, "agent_runtime_closed", "agent_runtime_closed", frame.requestId));
        return;
      }
      const commandContext = {
        ...session,
        kind: "human" as const,
        requestId: frame.requestId,
        idempotencyKey: frame.type === "agent.tool.confirm"
            ? `${frame.type}:${frame.confirmation.confirmationId}`
            : `${frame.type}:${frame.executionId}`,
      };
      try {
        if (frame.type === "agent.interrupt") {
          const execution = await options.agentRuntime.interrupt(
            commandContext,
            frame.executionId,
            frame.reason,
          );
          sendFrame(socket, {
            type: "agent.execution.ack",
            requestId: frame.requestId,
            execution,
            replayed: false,
          });
        } else if (frame.type === "agent.retry") {
          const accepted = await options.agentRuntime.retry(commandContext, frame.executionId);
          sendFrame(socket, {
            type: "agent.execution.ack",
            requestId: frame.requestId,
            execution: accepted.execution,
            replayed: accepted.replayed,
          });
        } else if (frame.type === "agent.tool.confirm") {
          const execution = await options.agentRuntime.confirmTool(commandContext, frame.confirmation);
          sendFrame(socket, {
            type: "agent.execution.ack",
            requestId: frame.requestId,
            execution,
            replayed: false,
          });
        } else {
          const accepted = await options.agentRuntime.compensate(commandContext, frame.executionId);
          sendFrame(socket, {
            type: "agent.execution.ack",
            requestId: frame.requestId,
            execution: accepted.execution,
            replayed: accepted.replayed,
          });
        }
      } catch (error: unknown) {
        sendFrame(socket, mappedError(error, frame.requestId));
      }
      return;
    }
    case "room.history": {
      const principal = await requirePrincipal(socket, frame.requestId, options, context);
      if (principal === undefined) {
        return;
      }
      try {
        const messages = options.outboxStore === undefined
          ? await options.service.history(principal.actorId, frame.roomId)
          : context.session === undefined
            ? (() => { throw new RoomAccessError(); })()
            : await options.service.history(context.session, frame.roomId);
        if (!context.closed) {
          sendFrame(socket, {
            type: "room.history",
            requestId: frame.requestId,
            roomId: frame.roomId,
            messages,
          });
        }
      } catch (error: unknown) {
        if (!context.closed) {
          sendFrame(socket, mappedError(error, frame.requestId));
        }
      }
      return;
    }
    case "room.subscribe": {
      const principal = await requirePrincipal(socket, frame.requestId, options, context);
      if (principal === undefined) {
        return;
      }
      await handleSubscribe(socket, frame, principal.actorId, options, context);
      return;
    }
    case "room.subscribe.v2":
      await handleSubscribeV2(socket, frame, options, context);
      return;
    case "room.memory.query.v1":
    case "room.memory.source.query.v1":
    case "room.memory.context.dispute.v1":
    case "room.memory.context.resolve.v1":
    case "room.memory.status.query.v1":
    case "room.memory.retry.v1": {
      const session = await requireSession(socket, frame.requestId, options, context);
      if (session === undefined) return;
      if (options.memoryAuthority === undefined) {
        sendFrame(socket, errorFrame(
          503, "memory_dependency_unavailable", "memory_dependency_unavailable", frame.requestId,
        ));
        return;
      }
      const generation = context.credentialGeneration;
      try {
        const response = await options.memoryAuthority.execute(session, frame);
        sendCurrentGeneration(socket, response, generation, context);
      } catch (error: unknown) {
        sendCurrentGeneration(socket, mappedError(error, frame.requestId), generation, context);
      }
      return;
    }
    case "workspace.bootstrap.begin":
    case "workspace.bootstrap.page":
    case "room.sync":
    case "room.repair.begin":
    case "room.repair.page":
    case "snapshot.complete":
      await handleRecoveryFrame(socket, frame, options, context, options.streamingOwners);
      return;
  }
}

async function listen(server: HttpServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const rejectOnce = (error: Error) => {
      server.off("error", rejectOnce);
      reject(error);
    };
    server.once("error", rejectOnce);
    server.listen(port, host, () => {
      server.off("error", rejectOnce);
      resolve();
    });
  });
}

export async function startMessageWebSocketServer(
  options: StartMessageWebSocketServerOptions,
): Promise<MessageWebSocketServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  validateMessageWebSocketListener(host, port);
  const maxBufferedAmountBytes =
    options.maxBufferedAmountBytes ?? MESSAGE_WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES;
  if (!Number.isFinite(maxBufferedAmountBytes) || maxBufferedAmountBytes < 0) {
    throw new RangeError("maxBufferedAmountBytes must be a non-negative finite number");
  }
  const maxQueuedFrameCount =
    options.maxQueuedFrameCount ?? MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_COUNT;
  if (!Number.isSafeInteger(maxQueuedFrameCount) || maxQueuedFrameCount <= 0) {
    throw new RangeError("maxQueuedFrameCount must be a positive safe integer");
  }
  const maxQueuedFrameBytes =
    options.maxQueuedFrameBytes ?? MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_BYTES;
  if (!Number.isSafeInteger(maxQueuedFrameBytes) || maxQueuedFrameBytes <= 0) {
    throw new RangeError("maxQueuedFrameBytes must be a positive safe integer");
  }
  const v2GateMaxEvents = options.v2GateMaxEvents ?? MESSAGE_WEBSOCKET_V2_GATE_MAX_EVENTS;
  if (!Number.isSafeInteger(v2GateMaxEvents) || v2GateMaxEvents <= 0) {
    throw new RangeError("v2GateMaxEvents must be a positive safe integer");
  }
  const v2GateMaxBytes = options.v2GateMaxBytes ?? MESSAGE_WEBSOCKET_V2_GATE_MAX_BYTES;
  if (!Number.isSafeInteger(v2GateMaxBytes) || v2GateMaxBytes <= 0) {
    throw new RangeError("v2GateMaxBytes must be a positive safe integer");
  }
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    maxPayload: MESSAGE_WEBSOCKET_MAX_PAYLOAD_BYTES,
  });
  const subscriptionRegistry = options.outboxStore === undefined
    ? undefined
    : options.subscriptionRegistry ?? createSubscriptionRegistry();
  if (options.subscriptionRegistry !== undefined && options.outboxStore === undefined) {
    throw new TypeError("subscriptionRegistry requires outboxStore");
  }
  const runtimeOptions: RuntimeMessageWebSocketServerOptions = {
    ...options,
    streamingOwners: new Map(),
    ...(subscriptionRegistry === undefined ? {} : { subscriptionRegistry }),
  };
  const activeSockets = new Set<WebSocket>();
  const liveConnections = new Map<
    string,
    { readonly socket: WebSocket; readonly context: ConnectionContext }
  >();
  let nextConnectionId = 0;
  const outboxDispatcher = options.outboxStore === undefined || subscriptionRegistry === undefined
    ? undefined
    : createOutboxDispatcher({
        store: options.outboxStore,
        registry: subscriptionRegistry,
        ...(options.outboxPollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: options.outboxPollIntervalMs }),
        async send(candidate, frame: OutboxDispatchFrame, delivery: OutboxDelivery) {
          const live = liveConnections.get(candidate.connectionId);
          const session = live?.context.session;
          if (
            live === undefined ||
            live.context.closed ||
            session === undefined ||
            live.context.credentialGeneration !== candidate.credentialGeneration ||
            session.sessionId !== candidate.sessionId ||
            session.sessionFamilyId !== candidate.sessionFamilyId ||
            !samePrincipal(session.principal, candidate.principal)
          ) {
            return { accepted: false, reason: "closed" };
          }
          if (delivery.targetKind === "session-family") {
            options.attachmentAuthority?.invalidateFamily(delivery.targetId);
          }
          if (delivery.targetKind === "room" && delivery.event.streamKind === "room") {
            const gate = live.context.v2GatesByRoom.get(delivery.targetId);
            if (gate !== undefined) {
              if (
                gate.credentialGeneration !== candidate.credentialGeneration ||
                live.context.subscriptionGenerationsByRoom.get(gate.roomId) !==
                  gate.subscriptionGeneration
              ) {
                return { accepted: false, reason: "closed" };
              }
              const capture = captureV2Delivery(
                gate,
                delivery.event,
                v2GateMaxEvents,
                v2GateMaxBytes,
              );
              if (capture === "overflow" || capture === "corrupt") {
                gate.overflowed = true;
                unsubscribeV2Gate(live.context, gate);
                if (gate.active) {
                  if (
                    !live.context.closed &&
                    live.context.credentialGeneration === gate.credentialGeneration &&
                    live.context.subscriptionGenerationsByRoom.get(gate.roomId) ===
                      gate.subscriptionGeneration
                  ) {
                    await sendFrameWithResult(live.socket, {
                      type: "room.subscribe.v2.retry",
                      requestId: gate.requestId,
                      roomId: gate.roomId,
                      reason: "gate_overflow",
                      restartFrom: gate.cursor,
                    });
                  }
                  cleanupV2Gate(live.context, gate);
                }
              }
              if (!gate.active || gate.overflowed) {
                return { accepted: true };
              }
              return drainContiguousV2Events(live.socket, live.context, gate);
            }
          }
          return sendFrameWithResult(live.socket, frame);
        },
      });
  let closePromise: Promise<void> | undefined;

  webSocketServer.on("connection", (socket) => {
    maxBufferedAmountBySocket.set(socket, maxBufferedAmountBytes);
    const unsubscribersByRoom = new Map<string, () => void>();
    const identityUnsubscribers = new Set<() => void>();
    const subscriptionGenerationsByRoom = new Map<string, number>();
    const ownedStreamingSnapshots = new Map<string, AuthenticatedSessionContext>();
    const v2GatesByRoom = new Map<string, V2SubscriptionGate>();
    const clearRoomSubscriptions = () => {
      for (const unsubscribe of unsubscribersByRoom.values()) {
        safelyUnsubscribe(unsubscribe);
      }
      unsubscribersByRoom.clear();
      subscriptionGenerationsByRoom.clear();
      for (const gate of v2GatesByRoom.values()) {
        safelyUnsubscribe(gate.unsubscribe);
      }
      v2GatesByRoom.clear();
    };
    const clearLiveSubscriptions = () => {
      clearRoomSubscriptions();
      for (const unsubscribe of identityUnsubscribers) {
        safelyUnsubscribe(unsubscribe);
      }
      identityUnsubscribers.clear();
    };
    const releaseSnapshotOwners = () => {
      if (options.sync !== undefined && runtimeOptions.streamingOwners !== undefined) {
        for (const [snapshotId, session] of ownedStreamingSnapshots) {
          if (detachStreamingSnapshot(
            context,
            session,
            snapshotId,
            runtimeOptions.streamingOwners,
          )) {
            void options.sync.releaseSnapshot(session, snapshotId).catch(() => undefined);
          }
        }
      }
      ownedStreamingSnapshots.clear();
    };
    const unsubscribeAll = () => {
      clearLiveSubscriptions();
      releaseSnapshotOwners();
    };
    const connectionId = `websocket-${++nextConnectionId}`;
    const context: ConnectionContext = {
      principal: undefined,
      session: undefined,
      accessToken: undefined,
      credentialGeneration: 0,
      authOperationPending: false,
      terminalRevocationPending: false,
      closed: false,
      unsubscribersByRoom,
      identityUnsubscribers,
      subscriptionGenerationsByRoom,
      ownedStreamingSnapshots,
      connectionId,
      v2GatesByRoom,
      clearRoomSubscriptions,
      clearLiveSubscriptions,
      releaseSnapshotOwners,
      unsubscribeAll,
      registeredConnection: undefined,
    };
    const registeredConnection: RegisteredConnection = {
      connectionId,
      get principal() {
        if (context.session === undefined) {
          throw new TypeError("Connection is not authenticated");
        }
        return context.session.principal;
      },
      get sessionId() {
        if (context.session === undefined) {
          throw new TypeError("Connection is not authenticated");
        }
        return context.session.sessionId;
      },
      get sessionFamilyId() {
        if (context.session === undefined) {
          throw new TypeError("Connection is not authenticated");
        }
        return context.session.sessionFamilyId;
      },
      get credentialGeneration() {
        return context.credentialGeneration;
      },
      revoke() {
        abortConnection(context);
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(4001, "session revoked");
        }
      },
    };
    context.registeredConnection = registeredConnection;
    liveConnections.set(connectionId, { socket, context });
    let frameQueue = Promise.resolve();
    let queuedFrameCount = 0;
    let queuedFrameBytes = 0;
    const abort = () => {
      abortConnection(context);
    };

    abortConnectionBySocket.set(socket, abort);
    activeSockets.add(socket);
    socket.on("close", () => {
      abort();
      activeSockets.delete(socket);
      liveConnections.delete(connectionId);
    });
    socket.on("error", abort);
    socket.on("message", (raw, isBinary) => {
      if (context.closed) {
        return;
      }
      const rawBytes = rawDataByteLength(raw);
      if (
        queuedFrameCount >= maxQueuedFrameCount ||
        rawBytes > maxQueuedFrameBytes - queuedFrameBytes
      ) {
        abortAndTerminate(socket);
        return;
      }
      queuedFrameCount += 1;
      queuedFrameBytes += rawBytes;
      const queued = frameQueue
        .then(async () => {
          if (context.closed) {
            return;
          }
          if (isBinary) {
            sendFrame(
              socket,
              errorFrame(400, "invalid_request", "Binary requests are not supported"),
            );
            return;
          }

          const parsed = parseClientFrame(rawDataToString(raw));
          if (!parsed.ok) {
            sendFrame(socket, parsed.error);
            return;
          }

          try {
            await handleFrame(socket, parsed.frame, runtimeOptions, context);
          } catch {
            if (!context.closed) {
              sendFrame(
                socket,
                errorFrame(
                  500,
                  "internal_error",
                  "Unable to process request",
                  parsed.frame.requestId,
                ),
              );
            }
          }
        })
        .finally(() => {
          queuedFrameCount -= 1;
          queuedFrameBytes -= rawBytes;
        });
      frameQueue = queued.catch(() => undefined);
    });
  });

  await listen(httpServer, host, port);
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await closeWebSocketServer(webSocketServer);
    await closeHttpServer(httpServer);
    throw new Error("Message WebSocket server did not expose a TCP address");
  }
  outboxDispatcher?.start();
  return {
    url: formatMessageWebSocketUrl(host, address.port),
    publishAgentPreview(preview): void {
      for (const { socket, context } of liveConnections.values()) {
        if (
          context.closed ||
          context.session === undefined ||
          (!context.unsubscribersByRoom.has(preview.roomId) &&
            !context.v2GatesByRoom.has(preview.roomId))
        ) {
          continue;
        }
        sendFrame(socket, {
          type: "agent.execution.preview",
          ...preview,
          authoritative: false,
        });
      }
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        // Calling close first synchronously fences future dispatcher scheduling.
        const dispatcherClose = outboxDispatcher?.close() ?? Promise.resolve();
        for (const socket of activeSockets) {
          abortAndTerminate(socket);
        }
        const results = await Promise.allSettled([
          dispatcherClose,
          closeWebSocketServer(webSocketServer),
          closeHttpServer(httpServer),
        ]);
        throwCleanupFailures("Message WebSocket server cleanup failed", results);
      })();
      return closePromise;
    },
  };
}
