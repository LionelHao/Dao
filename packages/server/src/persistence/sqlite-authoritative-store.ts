import { createHash, randomBytes } from "node:crypto";
import type { Actor, ManagedRoom, Message } from "@native-im/core";
import type { RoomAuditRecord } from "../room-lifecycle.js";
import type { InvitationSecretProtector } from "../invitation-secret-protector.js";
import type {
  AgentCollaborationCommand,
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  CommandStore,
  CommandAcknowledgement,
  HashedSessionIssue,
  HashedSessionRotation,
  HumanCollaborationCommand,
  InternalAgentCommandContext,
  IssuedSessionRecord,
  RoomGovernanceCommand,
  SessionAuthority,
  SyncQueryStore,
} from "./contracts.js";
import type { WorkerDatabaseClient } from "./worker-database-client.js";

export interface SqliteAuthoritativeStore extends
  SessionAuthority,
  CommandStore,
  Pick<
    SyncQueryStore,
    "readHistory" | "readActor" | "readRoom" | "canAccessRoom" | "readRoomAudit"
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

    readHistory(
      context: AuthenticatedSessionContext,
      roomId: string,
    ): Promise<readonly Message[]> {
      return client.readHistory(context, roomId, clock());
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

  };
}
