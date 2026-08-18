import {
  createWorkerDatabaseClient as createInternalWorkerDatabaseClient,
  type AuthoritySchemaInspection,
  type CreateWorkerDatabaseClientOptions,
  type WorkerDatabaseClient as InternalWorkerDatabaseClient,
} from "./persistence/worker-database-client.js";

export {
  AUTHORITATIVE_SERVER_DEFAULT_HOST,
  AUTHORITATIVE_SERVER_DEFAULT_PORT,
  startAuthoritativeServer,
} from "./authoritative-server.js";
export type {
  AuthoritativeServer,
  StartAuthoritativeServerOptions,
} from "./authoritative-server.js";

export {
  AuthenticationError,
  createAuthenticationService,
  createScryptIdentityAdapter,
  isSessionState,
  MAX_ACTIVE_SESSION_FAMILIES,
  SESSION_DEVICE_ID_MAX_BYTES,
  SESSION_DEVICE_LABEL_MAX_BYTES,
} from "./auth.js";
export type {
  AuthenticatedPrincipal,
  AuthenticationActorDirectory,
  AuthenticationErrorCode,
  AuthenticationService,
  AuthenticationServiceOptions,
  IdentityAdapter,
  IssuedSession,
  LoginCredentials,
  PasswordIdentityRecord,
  SessionDevice,
  SessionPlatform,
  SessionState,
} from "./auth.js";
export { createJsonStateStore, StateStoreCorruptionError } from "./state-store.js";
export type { StateStore } from "./state-store.js";
export {
  createRoomLifecycleService,
  isRoomLifecycleState,
  RoomLifecycleError,
} from "./room-lifecycle.js";
export type {
  HumanInvitationRecord,
  HumanInvitationStatus,
  IssuedHumanInvitation,
  RoomAuditRecord,
  RoomAuditResult,
  RoomAuditType,
  RoomLifecycleErrorCode,
  RoomLifecycleService,
  RoomLifecycleServiceOptions,
  RoomLifecycleState,
  T0039CompatibilityRoomLifecycleService,
} from "./room-lifecycle.js";
export {
  createMessageService,
  MessageValidationError,
  RoomAccessError,
} from "./service.js";
export { createOutboxDispatcher } from "./outbox-dispatcher.js";
export {
  createSyncService,
  ROOM_SYNC_DEFAULT_LIMIT,
  ROOM_SYNC_MAX_LIMIT,
  ROOM_SYNC_MAX_PAGE_BYTES,
  SyncServiceError,
} from "./sync-service.js";
export type {
  MaterializedSnapshotStore,
  SyncService,
  SyncServiceOptions,
} from "./sync-service.js";
export type {
  OutboxDispatcher,
  OutboxDispatcherOptions,
  OutboxDispatchFrame,
  OutboxDispatchStore,
  OutboxSendResult,
} from "./outbox-dispatcher.js";
export { createSubscriptionRegistry } from "./subscription-registry.js";
export type {
  PrincipalSubscription,
  RegisteredConnection,
  RoomSubscription,
  SessionFamilySubscription,
  SubscriptionRegistry,
} from "./subscription-registry.js";
export type {
  ListenerErrorHandler,
  MessageDirectory,
  MessageErrorCode,
  MessageListener,
  MessageService,
  MessageServiceOptions,
} from "./service.js";
export {
  createJsonlMessageStore,
  MessageIdConflictError,
  MessageStoreCorruptionError,
} from "./store.js";
export type {
  MessageAppendResult,
  MessageStore,
  MessageStoreErrorCode,
} from "./store.js";
export { parseClientFrame, PROTOCOL_FIELD_LIMITS } from "./protocol.js";
export type {
  AuthenticatedFrame,
  AuthLoginFrame,
  AuthRefreshFrame,
  AuthResumeFrame,
  AuthRevokeFrame,
  AuthRevokedFrame,
  AuthSessionRevokeAckFrame,
  AuthSessionRevokeFrame,
  AuthSessionRevokedFrame,
  AuthSessionsFrame,
  AuthSessionsListFrame,
  AgentCompensateFrame,
  AgentExecutionAckFrame,
  AgentExecutionPreviewFrame,
  AgentInterruptFrame,
  AgentInvokeFrame,
  AgentRetryFrame,
  AgentToolConfirmFrame,
  ClientFrame,
  ClientFrameParseResult,
  MessageCreatedFrame,
  IdentityRoomAccessChangedFrame,
  MessageSendFrame,
  OpenItemAckFrame,
  OpenItemCreateFrame,
  OpenItemTransitionFrame,
  ProtocolErrorCode,
  ProtocolErrorFrame,
  RoomHistoryFrame,
  RoomHistoryRequestFrame,
  RoomEventFrame,
  RoomRepairBeginRequestFrame,
  RoomRepairPageRequestFrame,
  RoomSubscribeFrame,
  RoomSubscribeV2Frame,
  RoomSubscribeV2RetryFrame,
  RoomSubscribedFrame,
  RoomSubscribedV2Frame,
  RoomSyncRequestFrame,
  ServerFrame,
  SnapshotCompleteRequestFrame,
  WorkspaceBootstrapPageRequestFrame,
  WorkspaceBootstrapRequestFrame,
} from "./protocol.js";
export {
  MESSAGE_WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES,
  MESSAGE_WEBSOCKET_MAX_PAYLOAD_BYTES,
  MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_BYTES,
  MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_COUNT,
  MESSAGE_WEBSOCKET_V2_GATE_MAX_BYTES,
  MESSAGE_WEBSOCKET_V2_GATE_MAX_EVENTS,
  startMessageWebSocketServer,
} from "./websocket.js";
export type { MessageWebSocketServer, StartMessageWebSocketServerOptions } from "./websocket.js";
export {
  CollaborationPrimitiveError,
  createAuthoritativeCollaborationPrimitives,
  createCollaborationPrimitives,
} from "./primitives.js";
export type {
  AcceptedCollaborationFact,
  AgentCorrection,
  AgentExecution,
  AgentExecutionStatus,
  AgentJudgement,
  AgentJudgementOutcome,
  AgentToolInvocation,
  AgentToolInvoker,
  AuthoritativeCollaborationPrimitives,
  AuthoritativeCollaborationPrimitivesOptions,
  CalibrationSignal,
  CollaborationPrimitives,
  CollaborationPrimitivesOptions,
  HumanReadReceipt,
  MessageState,
  OpenItem,
  OpenItemAgentFailure,
  OpenItemOrigin,
  OpenItemStatus,
  OpenItemTransfer,
  PrimitiveErrorCode,
  SocialReaction,
} from "./primitives.js";
export { AuthorityWorkerClientError } from "./persistence/worker-database-client.js";
export type { AuthoritySchemaInspection, CreateWorkerDatabaseClientOptions };
export type WorkerDatabaseClient = Omit<
  InternalWorkerDatabaseClient,
  | "executeHuman"
  | "executeAgent"
  | "executeRuntime"
  | "executeRoute"
  | "executeBall"
  | "readActor"
  | "readRoom"
  | "listPendingOutbox"
  | "authorizeOutboxCandidate"
  | "markOutboxDispatched"
  | "markOutboxFailed"
  | "syncRoom"
  | "compactRoomStream"
  | "revalidateSnapshot"
  | "acquireStreamingRepair"
  | "registerStreamingRepair"
  | "authorizeStreamingRepairPage"
  | "completeStreamingRepair"
  | "releaseStreamingRepair"
>;
export async function createWorkerDatabaseClient(
  options: CreateWorkerDatabaseClientOptions,
): Promise<WorkerDatabaseClient> {
  const internal = await createInternalWorkerDatabaseClient(options);
  return {
    inspectSchema: () => internal.inspectSchema(),
    importLegacyState: (paths) => internal.importLegacyState(paths),
    inspectLegacyImport: () => internal.inspectLegacyImport(),
    registerActors: (actors) => internal.registerActors(actors),
    issueSession: (input) => internal.issueSession(input),
    authenticateSession: (accessTokenHash, now) =>
      internal.authenticateSession(accessTokenHash, now),
    validateSessionRefresh: (currentRefreshTokenHash, expectedPrincipal, now) =>
      internal.validateSessionRefresh(currentRefreshTokenHash, expectedPrincipal, now),
    rotateSession: (input) => internal.rotateSession(input),
    revokeSession: (accessTokenHash, now) => internal.revokeSession(accessTokenHash, now),
    listSessions: (accessTokenHash, now) => internal.listSessions(accessTokenHash, now),
    revokeTargetSession: (accessTokenHash, publicSessionId, now) =>
      internal.revokeTargetSession(accessTokenHash, publicSessionId, now),
    readHistory: (context, roomId, now) => internal.readHistory(context, roomId, now),
    canAccessRoom: (context, roomId, now) => internal.canAccessRoom(context, roomId, now),
    readRoomAudit: (context, roomId, now) => internal.readRoomAudit(context, roomId, now),
    close: () => internal.close(),
  };
}
export {
  parsePersistedIdentityEvent,
  parsePersistedRoomEvent,
  parsePersistentCommand,
} from "./persistence/contracts.js";
export type {
  AgentCollaborationCommand,
  AgentPrincipal,
  AuthenticatedCommandContext,
  AuthenticatedSessionContext,
  CollaborationCommand,
  CommandAcknowledgement,
  CommandStore,
  ContractParseResult,
  HumanCollaborationCommand,
  HashedSessionIssue,
  HashedSessionRotation,
  IssuedSessionRecord,
  PublicSession,
  JsonValue,
  OutboxDelivery,
  OutboxDeliveryFailureReason,
  OutboxDispatchCandidate,
  PersistentCommand,
  RoomGovernanceCommand,
  SessionAuthority,
} from "./persistence/contracts.js";
