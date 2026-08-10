import type { Actor } from "@native-im/core";
import type {
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  CommandAcknowledgement,
  HashedSessionIssue,
  HashedSessionRotation,
  HumanCollaborationCommand,
  IssuedSessionRecord,
  RoomGovernanceCommand,
  SessionAuthority,
} from "./contracts.js";
import type { WorkerDatabaseClient } from "./worker-database-client.js";

export interface SqliteAuthoritativeStore extends SessionAuthority {
  registerActors(actors: readonly Actor[]): Promise<void>;
  executeHuman(
    context: AuthenticatedCommandContext,
    command: HumanCollaborationCommand | RoomGovernanceCommand,
  ): Promise<CommandAcknowledgement>;
}

export interface SqliteAuthoritativeStoreOptions {
  readonly clock?: () => number;
  readonly beforeEnqueueHuman?: () => Promise<void> | void;
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
      return client.executeHuman(context, command, clock());
    },

  };
}
