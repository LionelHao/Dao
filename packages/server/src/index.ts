import {
  createWorkerDatabaseClient as createInternalWorkerDatabaseClient,
  type AuthoritySchemaInspection,
  type CreateWorkerDatabaseClientOptions,
  type WorkerDatabaseClient as InternalWorkerDatabaseClient,
} from "./persistence/worker-database-client.js";

export {
  AuthenticationError,
  createAuthenticationService,
  createScryptIdentityAdapter,
  isSessionState,
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
  AuthSessionRevokedFrame,
  ClientFrame,
  ClientFrameParseResult,
  MessageCreatedFrame,
  IdentityRoomAccessChangedFrame,
  MessageSendFrame,
  ProtocolErrorCode,
  ProtocolErrorFrame,
  RoomHistoryFrame,
  RoomHistoryRequestFrame,
  RoomEventFrame,
  RoomSubscribeFrame,
  RoomSubscribedFrame,
  ServerFrame,
} from "./protocol.js";
export {
  MESSAGE_WEBSOCKET_MAX_BUFFERED_AMOUNT_BYTES,
  MESSAGE_WEBSOCKET_MAX_PAYLOAD_BYTES,
  MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_BYTES,
  MESSAGE_WEBSOCKET_MAX_QUEUED_FRAME_COUNT,
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
  | "readActor"
  | "readRoom"
  | "listPendingOutbox"
  | "authorizeOutboxCandidate"
  | "markOutboxDispatched"
  | "markOutboxFailed"
  | "syncRoom"
  | "compactRoomStream"
  | "revalidateSnapshot"
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
  JsonValue,
  OutboxDelivery,
  OutboxDeliveryFailureReason,
  OutboxDispatchCandidate,
  PersistentCommand,
  RoomGovernanceCommand,
  SessionAuthority,
} from "./persistence/contracts.js";
