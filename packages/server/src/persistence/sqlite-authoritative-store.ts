import { createHash, randomBytes } from "node:crypto";
import type {
  Actor,
  ManagedRoom,
  Message,
  RoomSyncRequest,
  RoomSyncResult,
  RoomGovernanceView,
} from "@native-im/core";
import type { RoomAuditRecord } from "../room-lifecycle.js";
import type { InvitationSecretProtector } from "../invitation-secret-protector.js";
import type {
  AgentCollaborationCommand,
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  CommandStore,
  CommandAcknowledgement,
  ClosedRoomGovernanceAcknowledgement,
  ClosedRoomGovernanceMutationCommand,
  ClosedRoomGovernanceTransportStore,
  HashedSessionIssue,
  HashedSessionRotation,
  HumanCollaborationCommand,
  MessageAuthorityStore,
  HumanMessageSubmissionReceipt,
  MessageRevisionCommand,
  MessageRevisionReceipt,
  MessageRecallCommand,
  MessageRecallReceipt,
  AgentMessageCommitCommand,
  AgentMessageCommitReceipt,
  MessageHistoryQuery,
  MessageHistoryPage,
  MessageRevisionQuery,
  MessageRevisionPage,
  InternalAgentCommandContext,
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
import type {
  CompleteWorkerDatabaseClient,
  WorkerDatabaseClient,
} from "./worker-database-client.js";
import type { HumanMessageSubmit } from "@native-im/core";
import type { InternalAgentMessageCommitContext } from "../message-authority/internal-message-capability.js";

export interface SqliteAuthoritativeStore extends
  SessionAuthority,
  CommandStore,
  MessageAuthorityStore,
  ClosedRoomGovernanceTransportStore,
  SnapshotRevalidationStore,
  Pick<
    SyncQueryStore,
    | "syncRoom"
    | "readHistory"
    | "readActor"
    | "readRoom"
    | "readRoomGovernance"
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
  readRoomGovernance(
    context: AuthenticatedSessionContext,
    roomId: string,
  ): Promise<RoomGovernanceView>;
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
  readonly afterCommitGovernance?: (
    context: AuthenticatedCommandContext,
    command: ClosedRoomGovernanceMutationCommand,
    acknowledgement: ClosedRoomGovernanceAcknowledgement,
  ) => Promise<void> | void;
  readonly invitationSecretProtector?: InvitationSecretProtector;
  readonly invitationTokenFactory?: () => string;
}

function requireMessageAuthorityClient(
  client: WorkerDatabaseClient,
): CompleteWorkerDatabaseClient {
  const methodNames = [
    "submitHumanMessage",
    "reviseHumanMessage",
    "recallHumanMessage",
    "commitAgentMessage",
    "readMessageHistory",
    "readMessageRevisions",
  ] as const;
  if (!methodNames.every((method) => typeof Reflect.get(client, method) === "function")) {
    throw new TypeError("Worker database client lacks Message Authority support");
  }
  return client as CompleteWorkerDatabaseClient;
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

    listSessions(accessTokenHash, now) {
      return client.listSessions(accessTokenHash, now);
    },

    revokeSession(accessTokenHash, publicSessionId, now) {
      return client.revokeTargetSession(accessTokenHash, publicSessionId, now);
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

    async executeHumanGovernance(context, command) {
      const acknowledgement = await client.executeHumanGovernance(context, command, clock());
      await options.afterCommitGovernance?.(context, command, acknowledgement);
      return acknowledgement;
    },

    readDepartureConflicts(context, input) {
      return client.readDepartureConflicts(context, input, clock());
    },

    executeAgent(
      context: InternalAgentCommandContext,
      command: AgentCollaborationCommand,
    ): Promise<CommandAcknowledgement> {
      return client.executeAgent(context, command, clock());
    },

    submitHumanMessage(
      context: AuthenticatedCommandContext,
      message: HumanMessageSubmit,
    ): Promise<HumanMessageSubmissionReceipt> {
      return requireMessageAuthorityClient(client).submitHumanMessage(context, message, clock());
    },

    reviseHumanMessage(
      context: AuthenticatedCommandContext,
      command: MessageRevisionCommand,
    ): Promise<MessageRevisionReceipt> {
      return requireMessageAuthorityClient(client).reviseHumanMessage(context, command, clock());
    },

    recallHumanMessage(
      context: AuthenticatedCommandContext,
      command: MessageRecallCommand,
    ): Promise<MessageRecallReceipt> {
      return requireMessageAuthorityClient(client).recallHumanMessage(context, command, clock());
    },

    commitAgentMessage(
      context: InternalAgentMessageCommitContext,
      command: AgentMessageCommitCommand,
    ): Promise<AgentMessageCommitReceipt> {
      return requireMessageAuthorityClient(client).commitAgentMessage(context, command, clock());
    },

    readMessageHistory(
      context: AuthenticatedSessionContext,
      query: MessageHistoryQuery,
    ): Promise<MessageHistoryPage> {
      return requireMessageAuthorityClient(client).readMessageHistory(context, query, clock());
    },

    readMessageRevisions(
      context: AuthenticatedSessionContext,
      query: MessageRevisionQuery,
    ): Promise<MessageRevisionPage> {
      return requireMessageAuthorityClient(client).readMessageRevisions(context, query, clock());
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

    readRoomGovernance(
      context: AuthenticatedSessionContext,
      roomId: string,
    ): Promise<RoomGovernanceView> {
      return client.readRoomGovernance(context, roomId, clock());
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
