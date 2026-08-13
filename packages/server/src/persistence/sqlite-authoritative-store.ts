import { createHash, randomBytes } from "node:crypto";
import type {
  Actor,
  ManagedRoom,
  Message,
  RoomSyncRequest,
  RoomSyncResult,
} from "@native-im/core";
import type { RoomAuditRecord } from "../room-lifecycle.js";
import type { InvitationSecretProtector } from "../invitation-secret-protector.js";
import type {
  AgentCollaborationCommand,
  AgentInvocationInput,
  AgentRuntimeAuthorityStore,
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
  CancelForHumanFenceInput,
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  CommandStore,
  CommandAcknowledgement,
  HashedSessionIssue,
  HashedSessionRotation,
  HumanCollaborationCommand,
  InternalAgentCommandContext,
  InternalAgentRuntimeContext,
  IssuedSessionRecord,
  OutboxDelivery,
  OutboxDeliveryFailureReason,
  OutboxDispatchCandidate,
  RoomGovernanceCommand,
  SessionAuthority,
  SnapshotRevalidationRequest,
  SnapshotRevalidationStore,
  SyncQueryStore,
} from "./contracts.js";
import type { WorkerDatabaseClient } from "./worker-database-client.js";

export interface SqliteAuthoritativeStore extends
  SessionAuthority,
  CommandStore,
  SnapshotRevalidationStore,
  Pick<
    SyncQueryStore,
    | "syncRoom"
    | "readHistory"
    | "readActor"
    | "readRoom"
    | "canAccessRoom"
    | "readRoomAudit"
    | "listPendingOutbox"
    | "authorizeOutboxCandidate"
    | "markOutboxDispatched"
    | "markOutboxFailed"
  > {
  registerActors(actors: readonly Actor[]): Promise<void>;
  executeHuman(
    context: AuthenticatedCommandContext,
    command: HumanCollaborationCommand | RoomGovernanceCommand,
  ): Promise<CommandAcknowledgement>;
  executeAgent(
    context: InternalAgentCommandContext,
    command: AgentCollaborationCommand,
  ): Promise<CommandAcknowledgement>;
  invoke(
    context: AuthenticatedCommandContext | InternalAgentCommandContext,
    input: AgentInvocationInput,
    maxQueuedPerRoom?: number,
  ): Promise<import("@native-im/core").AgentExecution>;
  claimNext(
    runtime: InternalAgentRuntimeContext,
    roomId: string,
    now: number,
  ): Promise<import("@native-im/core").AgentExecution | undefined>;
  commitStep(
    runtime: InternalAgentRuntimeContext,
    input: CommitExecutionStepInput,
  ): Promise<import("@native-im/core").AgentExecution>;
  completeExecution(
    runtime: InternalAgentRuntimeContext,
    input: CompleteExecutionInput,
  ): Promise<import("@native-im/core").AgentExecution>;
  completeCompensation(
    runtime: InternalAgentRuntimeContext,
    input: CompleteCompensationInput,
  ): Promise<import("@native-im/core").AgentExecution>;
  scheduleRetry(
    runtime: InternalAgentRuntimeContext,
    input: ScheduleRetryInput,
  ): Promise<import("@native-im/core").AgentExecution>;
  failExecution(
    runtime: InternalAgentRuntimeContext,
    input: FailExecutionInput,
  ): Promise<import("@native-im/core").AgentExecution>;
  interrupt(
    context: AuthenticatedCommandContext,
    input: InterruptExecutionInput,
  ): Promise<import("@native-im/core").AgentExecution>;
  manualRetry(
    context: AuthenticatedCommandContext,
    executionId: string,
    maxQueuedPerRoom?: number,
  ): Promise<import("@native-im/core").AgentExecution>;
  compensate(
    context: AuthenticatedCommandContext,
    executionId: string,
    dispatchId: string,
    maxQueuedPerRoom?: number,
  ): Promise<import("@native-im/core").AgentExecution>;
  resumeCompensation(
    runtime: InternalAgentRuntimeContext,
    input: Parameters<AgentRuntimeAuthorityStore["resumeCompensation"]>[1],
  ): ReturnType<AgentRuntimeAuthorityStore["resumeCompensation"]>;
  recoverPage(
    runtime: InternalAgentRuntimeContext,
    input: Parameters<AgentRuntimeAuthorityStore["recoverPage"]>[1],
  ): ReturnType<AgentRuntimeAuthorityStore["recoverPage"]>;
  prepareTool(runtime: InternalAgentRuntimeContext, input: PrepareToolInput): Promise<ToolGrant>;
  confirmTool(context: AuthenticatedCommandContext, input: ToolConfirmationInput): Promise<ToolConfirmation>;
  resumeConfirmedTool(runtime: InternalAgentRuntimeContext, input: ResumeConfirmedToolInput): Promise<ResumedToolDispatch>;
  dispatchTool(runtime: InternalAgentRuntimeContext, input: DispatchToolInput): Promise<ToolDispatch>;
  settleTool(runtime: InternalAgentRuntimeContext, input: SettleToolInput): Promise<ToolDispatch>;
  readExecution(context: AuthenticatedSessionContext, executionId: string): Promise<import("@native-im/core").AgentExecution>;
  loadProviderContext(
    runtime: InternalAgentRuntimeContext,
    executionId: string,
  ): ReturnType<AgentRuntimeAuthorityStore["loadProviderContext"]>;
  cancelForHumanFence(runtime: InternalAgentRuntimeContext, input: CancelForHumanFenceInput): Promise<import("@native-im/core").AgentExecution>;
  readHistory(
    context: AuthenticatedSessionContext,
    roomId: string,
  ): Promise<readonly Message[]>;
  syncRoom(
    context: AuthenticatedSessionContext,
    request: RoomSyncRequest,
  ): Promise<RoomSyncResult>;
  compactRoomStream(roomId: string, retainedFromSeq: number): Promise<void>;
  readActor(actorId: string): Promise<Actor | undefined>;
  readRoom(roomId: string): Promise<ManagedRoom | undefined>;
  canAccessRoom(
    context: AuthenticatedSessionContext,
    roomId: string,
  ): Promise<boolean>;
  readRoomAudit(
    context: AuthenticatedSessionContext,
    roomId: string,
  ): Promise<readonly RoomAuditRecord[]>;
  listPendingOutbox(limit: number): Promise<readonly OutboxDelivery[]>;
  authorizeOutboxCandidate(
    delivery: OutboxDelivery,
    candidate: OutboxDispatchCandidate,
  ): Promise<boolean>;
  markOutboxDispatched(deliveryId: string): Promise<void>;
  markOutboxFailed(
    deliveryId: string,
    reason: OutboxDeliveryFailureReason,
  ): Promise<void>;
}

export interface SqliteAuthoritativeStoreOptions {
  readonly clock?: () => number;
  readonly beforeEnqueueHuman?: () => Promise<void> | void;
  readonly afterCommitHuman?: (
    command: HumanCollaborationCommand | RoomGovernanceCommand,
    acknowledgement: CommandAcknowledgement,
  ) => Promise<void> | void;
  readonly invitationSecretProtector?: InvitationSecretProtector;
  readonly invitationTokenFactory?: () => string;
}

function invitationTokenResult(
  acknowledgement: CommandAcknowledgement,
  protector: InvitationSecretProtector,
): CommandAcknowledgement {
  const result = acknowledgement.result as unknown;
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result)
  ) {
    const error = new Error("invitation_secret_unavailable") as Error & {
      readonly code: string;
      readonly status: number;
    };
    Object.assign(error, { code: "invitation_secret_unavailable", status: 503 });
    throw error;
  }
  const resultRecord = result as Record<string, unknown>;
  const invitationValue = resultRecord.invitation;
  if (
    typeof invitationValue !== "object" ||
    invitationValue === null ||
    Array.isArray(invitationValue) ||
    typeof (invitationValue as Record<string, unknown>).sealedToken !== "string"
  ) {
    const error = new Error("invitation_secret_unavailable") as Error & {
      readonly code: string;
      readonly status: number;
    };
    Object.assign(error, { code: "invitation_secret_unavailable", status: 503 });
    throw error;
  }
  const { sealedToken, ...invitation } = invitationValue as Record<string, unknown> & {
    readonly sealedToken: string;
  };
  return {
    ...acknowledgement,
    result: {
      ...(resultRecord as Record<string, never>),
      invitation: {
        ...invitation,
        token: protector.open(sealedToken),
      },
    },
  };
}

export function createSqliteAuthoritativeStore(
  client: WorkerDatabaseClient,
  options: SqliteAuthoritativeStoreOptions = {},
): SqliteAuthoritativeStore {
  const clock = options.clock ?? Date.now;
  return {
    async registerActors(actors: readonly Actor[]): Promise<void> {
      await client.registerActors(actors);
    },

    issue(input: HashedSessionIssue): Promise<IssuedSessionRecord> {
      return client.issueSession(input);
    },

    authenticate(
      accessTokenHash: string,
      now: number,
    ): Promise<AuthenticatedSessionContext> {
      return client.authenticateSession(accessTokenHash, now);
    },

    validateRefresh(currentRefreshTokenHash, expectedPrincipal, now): Promise<void> {
      return client.validateSessionRefresh(
        currentRefreshTokenHash,
        expectedPrincipal,
        now,
      );
    },

    rotate(input: HashedSessionRotation): Promise<IssuedSessionRecord> {
      return client.rotateSession(input);
    },

    revoke(accessTokenHash: string, now: number): Promise<void> {
      return client.revokeSession(accessTokenHash, now);
    },

    async executeHuman(
      context: AuthenticatedCommandContext,
      command: HumanCollaborationCommand | RoomGovernanceCommand,
    ): Promise<CommandAcknowledgement> {
      await options.beforeEnqueueHuman?.();
      const invitationSecret = command.type === "human.invitation.issue"
        ? (() => {
            if (options.invitationSecretProtector === undefined) {
              const error = new Error("invitation_secret_unavailable") as Error & {
                readonly code: string;
                readonly status: number;
              };
              Object.assign(error, {
                code: "invitation_secret_unavailable",
                status: 503,
              });
              throw error;
            }
            const token = options.invitationTokenFactory?.() ?? randomBytes(32).toString("base64url");
            if (token.length === 0) {
              throw new TypeError("Invitation token factory returned an empty token");
            }
            return {
              tokenHash: createHash("sha256").update(token).digest("base64url"),
              sealedToken: options.invitationSecretProtector.seal(token),
            };
          })()
        : undefined;
      const internalAcknowledgement = await client.executeHuman(
        context,
        command,
        clock(),
        invitationSecret,
      );
      const acknowledgement = command.type === "human.invitation.issue"
        ? invitationTokenResult(
            internalAcknowledgement,
            options.invitationSecretProtector as InvitationSecretProtector,
          )
        : internalAcknowledgement;
      await options.afterCommitHuman?.(command, acknowledgement);
      return acknowledgement;
    },

    executeAgent(
      context: InternalAgentCommandContext,
      command: AgentCollaborationCommand,
    ): Promise<CommandAcknowledgement> {
      return client.executeAgent(context, command, clock());
    },

    invoke(
      context: AuthenticatedCommandContext | InternalAgentCommandContext,
      input: AgentInvocationInput,
      maxQueuedPerRoom?: number,
    ): Promise<import("@native-im/core").AgentExecution> {
      return client.invokeAgentRuntime(context, input, clock(), maxQueuedPerRoom);
    },

    claimNext(runtime, roomId, now) {
      return client.claimNextAgentRuntime(runtime, roomId, now);
    },

    commitStep(runtime, input) {
      return client.commitAgentRuntimeStep(runtime, input);
    },
    completeExecution(runtime, input) {
      return client.completeAgentRuntimeExecution(runtime, input);
    },
    completeCompensation(runtime, input: CompleteCompensationInput) {
      return client.completeAgentRuntimeCompensation(runtime, input);
    },

    scheduleRetry(runtime, input) {
      return client.scheduleAgentRuntimeRetry(runtime, input);
    },

    failExecution(runtime, input) {
      return client.failAgentRuntimeExecution(runtime, input);
    },

    interrupt(context, input) {
      return client.interruptAgentRuntime(context, input, clock());
    },

    manualRetry(context, executionId, maxQueuedPerRoom) {
      return client.manualRetryAgentRuntime(context, executionId, clock(), maxQueuedPerRoom);
    },

    compensate(context, executionId, dispatchId, maxQueuedPerRoom) {
      return client.compensateAgentRuntime(context, executionId, dispatchId, clock(), maxQueuedPerRoom);
    },
    resumeCompensation(runtime, input) {
      return client.resumeAgentRuntimeCompensation(runtime, input);
    },

    recoverPage(runtime, input) {
      return client.recoverAgentRuntimePage(runtime, input);
    },

    prepareTool(runtime, input) {
      return client.prepareAgentRuntimeTool(runtime, input);
    },

    confirmTool(context, input) {
      return client.confirmAgentRuntimeTool(context, input, clock());
    },

    resumeConfirmedTool(runtime, input) {
      return client.resumeConfirmedAgentRuntimeTool(runtime, input);
    },

    dispatchTool(runtime, input) {
      return client.dispatchAgentRuntimeTool(runtime, input);
    },

    settleTool(runtime, input) {
      return client.settleAgentRuntimeTool(runtime, input);
    },

    readExecution(context, executionId) {
      return client.readAgentRuntimeExecution(context, executionId, clock());
    },

    loadProviderContext(runtime, executionId) {
      return client.loadAgentRuntimeProviderContext(runtime, executionId);
    },

    cancelForHumanFence(runtime, input) {
      return client.cancelAgentRuntimeForHumanFence(runtime, input);
    },

    readHistory(
      context: AuthenticatedSessionContext,
      roomId: string,
    ): Promise<readonly Message[]> {
      return client.readHistory(context, roomId, clock());
    },

    syncRoom(
      context: AuthenticatedSessionContext,
      request: RoomSyncRequest,
    ): Promise<RoomSyncResult> {
      return client.syncRoom(context, request, clock());
    },

    revalidateSnapshot(validation: SnapshotRevalidationRequest): Promise<void> {
      return client.revalidateSnapshot(validation, clock());
    },

    async compactRoomStream(roomId: string, retainedFromSeq: number): Promise<void> {
      await client.compactRoomStream(roomId, retainedFromSeq);
    },

    readActor(actorId: string): Promise<Actor | undefined> {
      return client.readActor(actorId);
    },

    readRoom(roomId: string): Promise<ManagedRoom | undefined> {
      return client.readRoom(roomId);
    },

    canAccessRoom(
      context: AuthenticatedSessionContext,
      roomId: string,
    ): Promise<boolean> {
      return client.canAccessRoom(context, roomId, clock());
    },

    readRoomAudit(
      context: AuthenticatedSessionContext,
      roomId: string,
    ): Promise<readonly RoomAuditRecord[]> {
      return client.readRoomAudit(context, roomId, clock());
    },

    listPendingOutbox(limit: number): Promise<readonly OutboxDelivery[]> {
      return client.listPendingOutbox(limit, clock());
    },

    authorizeOutboxCandidate(
      delivery: OutboxDelivery,
      candidate: OutboxDispatchCandidate,
    ): Promise<boolean> {
      return client.authorizeOutboxCandidate(delivery.deliveryId, candidate, clock());
    },

    markOutboxDispatched(deliveryId: string): Promise<void> {
      return client.markOutboxDispatched(deliveryId, clock());
    },

    markOutboxFailed(
      deliveryId: string,
      reason: OutboxDeliveryFailureReason,
    ): Promise<void> {
      return client.markOutboxFailed(deliveryId, reason);
    },

  };
}
