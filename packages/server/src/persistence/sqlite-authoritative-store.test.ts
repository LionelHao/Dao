import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@native-im/core";
import {
  createAuthenticationService,
  AuthenticationError,
  MAX_ACTIVE_SESSION_FAMILIES,
  type IdentityAdapter,
  type LoginCredentials,
} from "../auth.js";
import { createAesGcmInvitationSecretProtector } from "../invitation-secret-protector.js";
import { mintInternalAgentMessageCommitContext } from
  "../message-authority/internal-message-capability.js";
import {
  submitHumanMessageDatabaseCommand,
  type MessageAuthoritySubmitFaultPointForTest,
} from "./authority-database-handler.js";
import { createSqliteAuthoritativeStore } from "./sqlite-authoritative-store.js";
import {
  mintInternalAgentCommandContext,
  type AgentCollaborationCommand,
  type AuthenticatedCommandContext,
  type CommandAcknowledgement,
  type CommandStore,
  type HumanCollaborationCommand,
  type RoomGovernanceCommand,
} from "./contracts.js";
import {
  migrateAuthorityDatabase,
  migrateAuthorityDatabaseToVersion11ForTest,
} from "./schema.js";
import {
  createWorkerDatabaseClient,
  createWorkerDatabaseClientWithTransactionFaultForTest,
} from "./worker-database-client.js";
import { isAuthorityWorkerRequest } from "./worker-protocol.js";
import { insertLegacyMessageAuthorityRecord } from "./message-authority-legacy-adapter.js";

function tokenSequence(...tokens: readonly string[]): () => string {
  const remaining = [...tokens];
  return () => remaining.shift() ?? `unexpected-token-${remaining.length}`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function claimMessageAuthorityExecution(
  databasePath: string,
  input: {
    readonly intentId: string;
    readonly executionId: string;
    readonly roomId: string;
    readonly sourceMessageId: string;
    readonly agentId: string;
    readonly requesterActorId: string;
  },
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    const timestamp = "2026-08-19T01:05:00.000Z";
    database.prepare(
      `UPDATE agent_invocation_intents
       SET status = 'claimed', claimed_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(timestamp, input.intentId);
    database.prepare(
      `INSERT INTO agent_executions (
         id, room_id, agent_id, trigger_message_id, status, started_at,
         completed_at, result_json, requester_actor_id, tool_name,
         action_category, tool_dispatch_phase, current_attempt_seq,
         retry_cycle, retry_ordinal, recovery_cursor, queued_at, updated_at,
         room_archive_generation
       ) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, 'message-authority',
                 'model_generation', NULL, 1, 1, 1, 0, ?, ?, 0)`,
    ).run(
      input.executionId,
      input.roomId,
      input.agentId,
      input.sourceMessageId,
      timestamp,
      input.requesterActorId,
      timestamp,
      timestamp,
    );
    database.prepare(
      `INSERT INTO agent_execution_attempts (
         execution_id, attempt_seq, retry_cycle, retry_ordinal, status,
         action_category, started_at, finished_at, error_code,
         next_retry_at, recovery_cursor
       ) VALUES (?, 1, 1, 1, 'running', 'model_generation', ?, NULL, NULL, NULL, 0)`,
    ).run(input.executionId, timestamp);
    database.prepare(
      `INSERT INTO agent_execution_intent_links (
         intent_id, execution_id, execution_ordinal, retry_of_execution_id,
         source_revision, linked_at
       ) VALUES (?, ?, 1, NULL, 1, ?)`,
    ).run(input.intentId, input.executionId, timestamp);
    database.exec("COMMIT");
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The original database failure is authoritative for this test helper.
    }
    throw error;
  } finally {
    database.close();
  }
}

function identitySessionMutationSnapshot(databasePath: string): unknown {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      families: database.prepare(
        `SELECT family_id AS familyId, public_id AS publicId, revoked_at AS revokedAt
         FROM session_families ORDER BY family_id`,
      ).all(),
      generations: database.prepare(
        `SELECT family_id AS familyId, access_token_hash AS accessTokenHash,
                revoked_at AS revokedAt
         FROM sessions ORDER BY family_id, access_token_hash`,
      ).all(),
      identityStreams: database.prepare(
        `SELECT stream_id AS streamId, head_seq AS headSeq
         FROM streams WHERE stream_kind = 'identity' ORDER BY stream_id`,
      ).all(),
      revokeEvents: database.prepare(
        `SELECT event_id AS eventId, stream_id AS streamId, stream_seq AS streamSeq,
                payload_json AS payloadJson
         FROM events WHERE event_type = 'identity.session.revoked'
         ORDER BY event_id`,
      ).all(),
      sessionFamilyOutbox: database.prepare(
        `SELECT id, event_id AS eventId, target_id AS targetId, stream_seq AS streamSeq,
                status, attempts
         FROM outbox_deliveries WHERE target_kind = 'session-family'
         ORDER BY id`,
      ).all(),
    };
  } finally {
    database.close();
  }
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

const actors = [
  {
    id: "human-li",
    kind: "human",
    displayName: "Lionel",
    reachability: "online",
  },
  {
    id: "agent-review",
    kind: "agent",
    displayName: "Reviewer",
    readiness: "ready",
    toolPermissions: ["review.read"],
  },
] as const satisfies readonly Actor[];

const actorDirectory = {
  getActor(actorId: string): Actor | undefined {
    return actors.find((actor) => actor.id === actorId);
  },
};

const identities: IdentityAdapter = {
  async verify(credentials: LoginCredentials) {
    if (credentials.accountId !== "account-li" || credentials.secret !== "correct") {
      return undefined;
    }
    return { accountId: "account-li", actorId: "human-li" };
  },
};

const invitationActors = [
  ...actors,
  {
    id: "human-chen",
    kind: "human",
    displayName: "Chen",
    reachability: "online",
  },
] as const satisfies readonly Actor[];

const invitationActorDirectory = {
  getActor(actorId: string): Actor | undefined {
    return invitationActors.find((actor) => actor.id === actorId);
  },
};

const invitationIdentities: IdentityAdapter = {
  async verify(credentials: LoginCredentials) {
    if (credentials.secret !== "correct") {
      return undefined;
    }
    if (credentials.accountId === "account-li") {
      return { accountId: "account-li", actorId: "human-li" };
    }
    if (credentials.accountId === "account-chen") {
      return { accountId: "account-chen", actorId: "human-chen" };
    }
    return undefined;
  },
};

const messageCommand = {
  type: "message.send",
  roomId: "room-command",
  payload: {
    id: "message-command",
    roomId: "room-command",
    body: "persist exactly once",
    sentAt: "2026-08-10T12:00:00.000Z",
  },
} as const;

async function createHumanCommandFixture(databasePath: string) {
  const bootstrapClient = await createWorkerDatabaseClient({ databasePath });
  const bootstrapAuthority = createSqliteAuthoritativeStore(bootstrapClient);
  await bootstrapAuthority.registerActors(actors);
  const auth = createAuthenticationService({
    actors: actorDirectory,
    identities,
    authority: bootstrapAuthority,
    clock: () => 1_000,
    tokenFactory: tokenSequence("command-access-token", "command-refresh-token"),
  });
  const issued = await auth.login({ accountId: "account-li", secret: "correct" });
  const session = await auth.authenticateSession(issued.accessToken);
  await bootstrapClient.close();

  const database = new DatabaseSync(databasePath);
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-command', 'Command Room', 'active', '2026-08-10T11:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES (
      'room-command', 'human-li', 'human', 'member', NULL, '[]',
      '2026-08-10T11:00:00.000Z', NULL, 0
    );
    UPDATE rooms SET owner_actor_id = 'human-li', governance_revision = 1
    WHERE id = 'room-command';
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('room', 'room-command', 0, 1);
  `);
  database.close();

  const client = await createWorkerDatabaseClient({ databasePath });
  const authority = createSqliteAuthoritativeStore(client, { clock: () => 2_000 });
  return {
    authority,
    client,
    context: {
      ...session,
      kind: "human" as const,
      requestId: "message-request-first",
      idempotencyKey: "message-idempotency-key",
    },
  };
}

async function createRoomGovernanceFixture(databasePath: string) {
  const client = await createWorkerDatabaseClient({ databasePath });
  const authority = createSqliteAuthoritativeStore(client, { clock: () => 2_000 });
  await authority.registerActors(actors);
  const auth = createAuthenticationService({
    actors: actorDirectory,
    identities,
    authority,
    clock: () => 1_000,
    tokenFactory: tokenSequence("governance-access", "governance-refresh"),
  });
  const issued = await auth.login({ accountId: "account-li", secret: "correct" });
  const session = await auth.authenticateSession(issued.accessToken);
  const context = {
    ...session,
    kind: "human" as const,
    requestId: "governance-setup-request",
    idempotencyKey: "governance-setup-room",
  };
  const created = await authority.executeHuman(
    context,
    { type: "room.create", payload: { name: "Governance" } },
  );
  return {
    authority,
    client,
    context,
    roomId: created.aggregateId,
  };
}

async function createAgentFactFixture(databasePath: string) {
  const bootstrapClient = await createWorkerDatabaseClient({ databasePath });
  const bootstrapAuthority = createSqliteAuthoritativeStore(bootstrapClient);
  await bootstrapAuthority.registerActors(actors);
  const auth = createAuthenticationService({
    actors: actorDirectory,
    identities,
    authority: bootstrapAuthority,
    clock: () => 1_000,
    tokenFactory: tokenSequence("facts-access", "facts-refresh"),
  });
  const issued = await auth.login({ accountId: "account-li", secret: "correct" });
  const humanSession = await auth.authenticateSession(issued.accessToken);
  await bootstrapClient.close();

  const database = new DatabaseSync(databasePath);
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-facts', 'Facts', 'active', '2026-08-10T13:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-facts', 'human-li', 'human', 'member', NULL, '[]',
       '2026-08-10T13:00:00.000Z', NULL, 0),
      ('room-facts', 'agent-review', 'agent', NULL, 'active', '["review.read"]',
       NULL, '2026-08-10T13:00:00.000Z', 1);
    UPDATE rooms SET owner_actor_id = 'human-li', governance_revision = 1
    WHERE id = 'room-facts';
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('room', 'room-facts', 0, 1);
  `);
  insertLegacyMessageAuthorityRecord(database, {
    id: "message-human-source", roomId: "room-facts", authorId: "human-li",
    authorKind: "human", body: "please review", sentAt: "2026-08-10T13:01:00.000Z",
  });
  insertLegacyMessageAuthorityRecord(database, {
    id: "message-agent-source", roomId: "room-facts", authorId: "agent-review",
    authorKind: "agent", body: "review complete", sentAt: "2026-08-10T13:02:00.000Z",
  });
  database.close();

  const client = await createWorkerDatabaseClient({ databasePath });
  const authority = createSqliteAuthoritativeStore(client, { clock: () => 3_000 });
  return {
    authority,
    client,
    humanContext: {
      ...humanSession,
      kind: "human" as const,
      requestId: "facts-human-request",
      idempotencyKey: "facts-human-key",
    },
  };
}

const lightTaskActors = [
  { id: "human-task-owner", kind: "human", displayName: "Owner", reachability: "online" },
  { id: "human-task-claimant", kind: "human", displayName: "Claimant", reachability: "online" },
  { id: "human-task-admin-a", kind: "human", displayName: "Admin A", reachability: "online" },
  { id: "human-task-admin-b", kind: "human", displayName: "Admin B", reachability: "online" },
] as const satisfies readonly Actor[];

async function createLightTaskFixture(databasePath: string) {
  const bootstrapClient = await createWorkerDatabaseClient({ databasePath });
  const authority = createSqliteAuthoritativeStore(bootstrapClient);
  await authority.registerActors(lightTaskActors);
  const identitiesByAccount = new Map(lightTaskActors.map((actor) => [
    `account-${actor.id}`, actor.id,
  ]));
  const auth = createAuthenticationService({
    actors: { getActor: (actorId) => lightTaskActors.find((actor) => actor.id === actorId) },
    identities: {
      async verify(credentials) {
        const actorId = identitiesByAccount.get(credentials.accountId);
        return credentials.secret === "correct" && actorId !== undefined
          ? { accountId: credentials.accountId, actorId }
          : undefined;
      },
    },
    authority,
    clock: () => 1_000,
    tokenFactory: tokenSequence(
      "task-owner-access", "task-owner-refresh",
      "task-claimant-access", "task-claimant-refresh",
      "task-admin-a-access", "task-admin-a-refresh",
      "task-admin-b-access", "task-admin-b-refresh",
    ),
  });
  const sessions = new Map<string, Awaited<ReturnType<typeof auth.authenticateSession>>>();
  for (const actor of lightTaskActors) {
    const issued = await auth.login({ accountId: `account-${actor.id}`, secret: "correct" });
    sessions.set(actor.id, await auth.authenticateSession(issued.accessToken));
  }
  await bootstrapClient.close();

  const database = new DatabaseSync(databasePath);
  migrateAuthorityDatabase(database);
  database.exec(`
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-light-task', 'Light Tasks', 'active', '2026-08-17T00:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-light-task', 'human-task-owner', 'human', 'member', NULL, '[]', '2026-08-17T00:00:00.000Z', NULL, 0),
      ('room-light-task', 'human-task-claimant', 'human', 'member', NULL, '[]', '2026-08-17T00:00:00.000Z', NULL, 0),
      ('room-light-task', 'human-task-admin-a', 'human', 'admin', NULL, '[]', '2026-08-17T00:00:00.000Z', NULL, 0),
      ('room-light-task', 'human-task-admin-b', 'human', 'member', NULL, '[]', '2026-08-17T00:00:00.000Z', NULL, 0);
    UPDATE rooms SET owner_actor_id = 'human-task-owner', governance_revision = 1
    WHERE id = 'room-light-task';
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('room', 'room-light-task', 0, 1);
  `);
  insertLegacyMessageAuthorityRecord(database, {
    id: "message-light-task", roomId: "room-light-task", authorId: "human-task-owner",
    authorKind: "human", body: "需要一个明确承诺", sentAt: "2026-08-17T00:00:01.000Z",
  });
  database.close();

  const client = await createWorkerDatabaseClient({ databasePath });
  const store = createSqliteAuthoritativeStore(client, { clock: () => 3_000 });
  const context = (actorId: string, requestId: string): AuthenticatedCommandContext => ({
    ...sessions.get(actorId)!, kind: "human", requestId, idempotencyKey: requestId,
  });
  return { client, store, context };
}

function readMessageCommandCounts(databasePath: string): {
  readonly messages: number;
  readonly events: number;
  readonly outbox: number;
  readonly idempotency: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      messages: Number(database.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count),
      events: Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.message.accepted'")
          .get()?.count,
      ),
      outbox: Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM outbox_deliveries WHERE target_kind = 'room'")
          .get()?.count,
      ),
      idempotency: Number(
        database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get()?.count,
      ),
    };
  } finally {
    database.close();
  }
}

function invitationTokenFrom(acknowledgement: {
  readonly result: unknown;
}): string {
  const result = acknowledgement.result as {
    readonly invitation?: { readonly token?: unknown };
  };
  if (typeof result.invitation?.token !== "string") {
    throw new Error("invitation token missing from acknowledgement");
  }
  return result.invitation.token;
}

const matrixActors = [
  ...invitationActors,
  {
    id: "human-invitee",
    kind: "human",
    displayName: "Invitee",
    reachability: "online",
  },
  {
    id: "human-alternate",
    kind: "human",
    displayName: "Alternate",
    reachability: "online",
  },
] as const satisfies readonly Actor[];

const matrixActorDirectory = {
  getActor(actorId: string): Actor | undefined {
    return matrixActors.find((actor) => actor.id === actorId);
  },
};

const matrixIdentities: IdentityAdapter = {
  async verify(credentials: LoginCredentials) {
    if (credentials.secret !== "correct") return undefined;
    if (credentials.accountId === "account-li") {
      return { accountId: "account-li", actorId: "human-li" };
    }
    if (credentials.accountId === "account-invitee") {
      return { accountId: "account-invitee", actorId: "human-invitee" };
    }
    return undefined;
  },
};

interface MatrixContexts {
  readonly roomId: string;
  readonly owner: AuthenticatedCommandContext;
  readonly ownerSecondDevice: AuthenticatedCommandContext;
  readonly invitee: AuthenticatedCommandContext;
}

interface CommandMatrixCase {
  readonly label: string;
  readonly eventType: string;
  readonly factSql: string;
  readonly factCount?: number;
  readonly deliveryTargets: readonly ("room" | "principal" | null)[];
  execute(
    store: CommandStore,
    contexts: MatrixContexts,
    variant: "exact" | "changed",
    requestSuffix: string,
  ): Promise<CommandAcknowledgement>;
}

function humanMatrixCase(
  label: string,
  eventType: string,
  factSql: string,
  command: (contexts: MatrixContexts) => HumanCollaborationCommand | RoomGovernanceCommand,
  changed: (contexts: MatrixContexts) => HumanCollaborationCommand | RoomGovernanceCommand,
  actor: "owner" | "invitee" = "owner",
  factCount = 1,
  deliveryTargets: readonly ("room" | "principal" | null)[] = ["room"],
): CommandMatrixCase {
  return {
    label,
    eventType,
    factSql,
    factCount,
    deliveryTargets,
    execute(store, contexts, variant, requestSuffix) {
      const context = contexts[actor];
      return store.executeHuman(
        { ...context, requestId: `${label}-${requestSuffix}`, idempotencyKey: `${label}-matrix-key` },
        variant === "exact" ? command(contexts) : changed(contexts),
      );
    },
  };
}

function agentMatrixCase(
  label: string,
  eventType: string,
  factSql: string,
  command: (contexts: MatrixContexts) => AgentCollaborationCommand,
  changed: (contexts: MatrixContexts) => AgentCollaborationCommand,
): CommandMatrixCase {
  return {
    label,
    eventType,
    factSql,
    deliveryTargets: ["room"],
    execute(store, contexts, variant, requestSuffix) {
      return store.executeAgent(
        mintInternalAgentCommandContext({
          agentId: "agent-review",
          requestId: `${label}-${requestSuffix}`,
          idempotencyKey: `${label}-matrix-key`,
        }),
        variant === "exact" ? command(contexts) : changed(contexts),
      );
    },
  };
}

async function createCommandMatrixFixture(databasePath: string): Promise<{
  readonly store: ReturnType<typeof createSqliteAuthoritativeStore>;
  readonly client: Awaited<ReturnType<typeof createWorkerDatabaseClient>>;
  readonly contexts: MatrixContexts;
}> {
  const bootstrapClient = await createWorkerDatabaseClient({ databasePath });
  const bootstrapStore = createSqliteAuthoritativeStore(bootstrapClient);
  await bootstrapStore.registerActors(matrixActors);
  const authentication = createAuthenticationService({
    actors: matrixActorDirectory,
    identities: matrixIdentities,
    authority: bootstrapStore,
    clock: () => 1_000,
    tokenFactory: tokenSequence(
      "matrix-owner-access", "matrix-owner-refresh",
      "matrix-invitee-access", "matrix-invitee-refresh",
      "matrix-owner-second-access", "matrix-owner-second-refresh",
    ),
  });
  const ownerIssued = await authentication.login({ accountId: "account-li", secret: "correct" });
  const inviteeIssued = await authentication.login({ accountId: "account-invitee", secret: "correct" });
  const ownerSecondIssued = await authentication.login({
    accountId: "account-li",
    secret: "correct",
  });
  const ownerSession = await authentication.authenticateSession(ownerIssued.accessToken);
  const inviteeSession = await authentication.authenticateSession(inviteeIssued.accessToken);
  const ownerSecondSession = await authentication.authenticateSession(
    ownerSecondIssued.accessToken,
  );
  await bootstrapClient.close();

  const database = new DatabaseSync(databasePath);
  database.exec(`
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-matrix', 'Matrix Room', 'active', '2026-08-10T14:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-matrix', 'human-li', 'human', 'member', NULL, '[]',
       '2026-08-10T14:00:00.000Z', NULL, 0),
      ('room-matrix', 'human-chen', 'human', 'member', NULL, '[]',
       '2026-08-10T14:00:00.000Z', NULL, 0),
      ('room-matrix', 'agent-review', 'agent', NULL, 'active', '["review.read"]',
       NULL, '2026-08-10T14:00:00.000Z', 1);
    UPDATE rooms SET owner_actor_id = 'human-li', governance_revision = 1
    WHERE id = 'room-matrix';
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('room', 'room-matrix', 0, 1);
    UPDATE agent_profiles
    SET revision = revision + 1, status = 'enabled', updated_at = '2026-08-10T14:00:00.000Z',
        source_kind = 'administrator_command'
    WHERE actor_id = 'agent-review';
    INSERT INTO agent_profile_revisions (
      profile_id, revision, actor_id, display_name, global_responsibility, status,
      capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id,
      changed_at, operation
    ) SELECT id, revision, actor_id, display_name, global_responsibility, status,
             capability_ceiling_json, tool_ceiling_json, 'human-li',
             '2026-08-10T14:00:00.000Z', 'enable'
      FROM agent_profiles WHERE actor_id = 'agent-review';
    INSERT INTO room_agent_assignments (
      id, room_id, profile_id, agent_actor_id, revision, status, participation,
      paused, capability_subset_json, tool_subset_json, room_responsibility,
      created_at, updated_at, removed_at, source_kind
    ) SELECT 'matrix-assignment-agent-review', 'room-matrix', id, actor_id, 1,
             'current', 'active', 0, '[]', '[]', 'Review Matrix Room.',
             '2026-08-10T14:00:00.000Z', '2026-08-10T14:00:00.000Z', NULL,
             'room_command'
      FROM agent_profiles WHERE actor_id = 'agent-review';
    INSERT INTO room_agent_assignment_revisions (
      assignment_id, revision, room_id, profile_id, agent_actor_id,
      room_responsibility, status, participation, paused,
      capability_subset_json, tool_subset_json, changed_by_human_actor_id,
      changed_at, operation
    ) SELECT id, revision, room_id, profile_id, agent_actor_id,
             room_responsibility, status, participation, paused,
             capability_subset_json, tool_subset_json, 'human-li',
             '2026-08-10T14:00:00.000Z', 'create'
      FROM room_agent_assignments WHERE id = 'matrix-assignment-agent-review';
  `);
  insertLegacyMessageAuthorityRecord(database, {
    id: "matrix-human-source", roomId: "room-matrix", authorId: "human-li",
    authorKind: "human", body: "please review", sentAt: "2026-08-10T14:01:00.000Z",
  });
  insertLegacyMessageAuthorityRecord(database, {
    id: "matrix-agent-source", roomId: "room-matrix", authorId: "agent-review",
    authorKind: "agent", body: "review complete", sentAt: "2026-08-10T14:02:00.000Z",
  });
  database.exec(`
    INSERT INTO room_invitations (
      id, room_id, inviter_actor_id, invitee_actor_id, token_hash, status,
      created_at, decision_actor_id, decided_at
    ) VALUES (
      'matrix-decision-invitation', 'room-matrix', 'human-li', 'human-invitee',
      '${tokenHash("matrix-decision-token")}', 'pending',
      '2026-08-10T14:03:00.000Z', NULL, NULL
    );
    INSERT INTO open_items (
      id, room_id, source_message_id, current_owner_actor_id, status, body,
      created_at, responded_at, requester_actor_id, transfer_chain_json,
      origin_kind, proposal_kind, source_execution_id, proposal_reason
    ) VALUES (
      'matrix-open-existing', 'room-matrix', 'matrix-human-source', 'agent-review',
      'awaiting', 'respond to this', '2026-08-10T14:04:00.000Z', NULL,
      'human-li', '[]', 'manual_unfinished', NULL, NULL, NULL
    );
  `);
  database.close();

  const client = await createWorkerDatabaseClient({ databasePath });
  const store = createSqliteAuthoritativeStore(client, {
    clock: () => 5_000,
    invitationSecretProtector: createAesGcmInvitationSecretProtector(new Uint8Array(32).fill(47)),
    invitationTokenFactory: () => "matrix-issued-token",
  });
  return {
    store,
    client,
    contexts: {
      roomId: "room-matrix",
      owner: {
        ...ownerSession,
        kind: "human",
        requestId: "matrix-owner",
        idempotencyKey: "matrix-owner",
      },
      ownerSecondDevice: {
        ...ownerSecondSession,
        kind: "human",
        requestId: "matrix-owner-second",
        idempotencyKey: "matrix-owner-second",
      },
      invitee: {
        ...inviteeSession,
        kind: "human",
        requestId: "matrix-invitee",
        idempotencyKey: "matrix-invitee",
      },
    },
  };
}

function authoritativeCountSnapshot(databasePath: string): Readonly<Record<string, number>> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = [
      "rooms", "room_memberships", "room_invitations", "room_audit", "messages",
      "human_read_receipts", "agent_judgments", "open_items", "agent_executions",
      "calibration_signals", "events", "outbox_deliveries", "idempotency_records",
    ] as const;
    return Object.fromEntries(tables.map((table) => [
      table,
      Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count),
    ]));
  } finally {
    database.close();
  }
}

function messageAuthorityAggregateSnapshot(
  databasePath: string,
  messageId: string,
): Readonly<Record<string, number>> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (sql: string, ...parameters: readonly unknown[]): number =>
      Number(database.prepare(sql).get(...parameters)?.count);
    return {
      messages: count("SELECT COUNT(*) AS count FROM messages WHERE id = ?", messageId),
      envelopes: count(
        "SELECT COUNT(*) AS count FROM message_envelopes WHERE message_id = ?",
        messageId,
      ),
      revisions: count(
        "SELECT COUNT(*) AS count FROM message_revisions WHERE message_id = ?",
        messageId,
      ),
      targets: count(
        "SELECT COUNT(*) AS count FROM message_mentions WHERE message_id = ?",
        messageId,
      ),
      outcomes: count(
        "SELECT COUNT(*) AS count FROM message_target_outcomes WHERE message_id = ?",
        messageId,
      ),
      humanIntents: count(
        "SELECT COUNT(*) AS count FROM human_request_intents WHERE source_message_id = ?",
        messageId,
      ),
      agentIntents: count(
        "SELECT COUNT(*) AS count FROM agent_invocation_intents WHERE source_message_id = ?",
        messageId,
      ),
      events: count(
        `SELECT COUNT(*) AS count FROM events
         WHERE event_type = 'room.message.accepted'
           AND json_extract(payload_json, '$.id') = ?`,
        messageId,
      ),
      outbox: count(
        `SELECT COUNT(*) AS count FROM outbox_deliveries AS delivery
         JOIN events AS event ON event.event_id = delivery.event_id
         WHERE event.event_type = 'room.message.accepted'
           AND json_extract(event.payload_json, '$.id') = ?`,
        messageId,
      ),
      receipts: count(
        "SELECT COUNT(*) AS count FROM idempotency_records WHERE key = ?",
        messageId,
      ),
    };
  } finally {
    database.close();
  }
}

describe("SQLite authoritative sessions", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("persists two public device families and atomically revokes only the targeted family", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-device-sessions-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client);
    const foreignActor = {
      id: "human-foreign-session",
      kind: "human" as const,
      displayName: "Foreign Human",
      reachability: "online",
    };
    await authority.registerActors([...actors, foreignActor]);
    let now = 1_000;
    const publicIds = ["sqlite-device-a", "sqlite-device-b"];
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority,
      clock: () => now,
      tokenFactory: tokenSequence(
        "sqlite-a-access", "sqlite-a-refresh", "sqlite-b-access", "sqlite-b-refresh",
        "sqlite-b-next-access", "sqlite-b-next-refresh",
      ),
      sessionIdFactory: () => publicIds.shift() ?? "unexpected-public-id",
    });
    const a = await auth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "install-a", label: "Mac A", platform: "macos" },
    );
    now = 2_000;
    const b = await auth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "install-b", label: "Linux B", platform: "linux" },
    );

    await expect(auth.listSessions(a.accessToken)).resolves.toEqual([
      expect.objectContaining({ id: b.sessionId, deviceLabel: "Linux B", current: false }),
      expect.objectContaining({ id: a.sessionId, deviceLabel: "Mac A", current: true }),
    ]);
    const foreignAuth = createAuthenticationService({
      actors: { getActor: (actorId) => actorId === foreignActor.id ? foreignActor : undefined },
      identities: {
        async verify(credentials) {
          return credentials.accountId === "foreign-account" && credentials.secret === "correct"
            ? { accountId: "foreign-account", actorId: foreignActor.id }
            : undefined;
        },
      },
      authority,
      clock: () => now,
      tokenFactory: tokenSequence("foreign-access", "foreign-refresh"),
      sessionIdFactory: () => "foreign-public-session",
    });
    const foreign = await foreignAuth.login(
      { accountId: "foreign-account", secret: "correct" },
      { id: "foreign-install", label: "Foreign device", platform: "windows" },
    );
    await expect(foreignAuth.listSessions(foreign.accessToken)).resolves.toEqual([
      expect.objectContaining({ id: foreign.sessionId, current: true }),
    ]);
    await expect(
      foreignAuth.revokeSession(foreign.accessToken, b.sessionId),
    ).rejects.toMatchObject({ status: 404, code: "session_not_found" });
    now = 3_000;
    const [refreshRace, revokeRace] = await Promise.allSettled([
      auth.refresh(b.refreshToken),
      auth.revokeSession(a.accessToken, b.sessionId),
    ]);
    expect(revokeRace.status).toBe("fulfilled");
    if (refreshRace.status === "fulfilled") {
      await expect(auth.authenticate(refreshRace.value.accessToken)).rejects.toMatchObject({
        code: "session_revoked",
      });
    } else {
      expect(refreshRace.reason).toMatchObject({ code: "session_revoked" });
    }
    await auth.revokeSession(a.accessToken, b.sessionId);
    await expect(auth.authenticate(a.accessToken)).resolves.toMatchObject({ actorId: "human-li" });
    await expect(auth.authenticate(b.accessToken)).rejects.toMatchObject({ code: "session_revoked" });
    await expect(auth.refresh(b.refreshToken)).rejects.toMatchObject({ code: "session_revoked" });

    await client.close();
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'identity.session.revoked'",
    ).get()).toEqual({ count: 1 });
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE target_kind = 'session-family'",
    ).get()).toEqual({ count: 1 });
    inspection.close();

    const restartedClient = await createWorkerDatabaseClient({ databasePath });
    const restartedAuth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority: createSqliteAuthoritativeStore(restartedClient),
      clock: () => now,
      tokenFactory: tokenSequence("restart-access", "restart-refresh"),
    });
    await expect(restartedAuth.listSessions(a.accessToken)).resolves.toEqual([
      expect.objectContaining({ id: a.sessionId, current: true }),
    ]);
    await expect(restartedAuth.authenticate(b.accessToken)).rejects.toMatchObject({
      code: "session_revoked",
    });
    await restartedClient.close();
  });

  it("atomically evicts the oldest family on the 97th login and fails closed above capacity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-session-capacity-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client);
    await authority.registerActors(actors);
    let tokenSequenceNumber = 0;
    let publicIdSequence = 0;
    let now = 1_000;
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority,
      clock: () => now,
      tokenFactory: () => `capacity-token-${++tokenSequenceNumber}`,
      sessionIdFactory: () => `capacity-public-${++publicIdSequence}`,
    });
    const issued = [];
    for (let index = 0; index < MAX_ACTIVE_SESSION_FAMILIES; index += 1) {
      issued.push(await auth.login(
        { accountId: "account-li", secret: "correct" },
        { id: `capacity-device-${index}`, label: `Capacity ${index}`, platform: "macos" },
      ));
    }
    await expect(auth.listSessions(issued[0]!.accessToken)).resolves.toHaveLength(
      MAX_ACTIVE_SESSION_FAMILIES,
    );
    const evictedContext = await authority.authenticate(
      tokenHash(issued[0]!.accessToken),
      now,
    );
    const evictedLease = await client.acquireStreamingRepair(
      evictedContext,
      { kind: "catalog", principalId: "human-li" },
      now,
    );
    await client.registerStreamingRepair(
      evictedLease.snapshotId,
      "capacity-evicted-checksum",
      1,
      now,
    );
    const replacement = await auth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "capacity-overflow", label: "Overflow", platform: "linux" },
    );
    await expect(client.authorizeStreamingRepairPage(
      evictedContext,
      evictedLease.snapshotId,
      0,
      now,
    )).rejects.toMatchObject({
      status: 403,
      code: "snapshot_family_revoked",
    });
    const replacementContext = await authority.authenticate(
      tokenHash(replacement.accessToken),
      now,
    );
    const replacementLease = await client.acquireStreamingRepair(
      replacementContext,
      { kind: "catalog", principalId: "human-li" },
      now,
    );
    expect(replacementLease.sessionFamilyId).toBe(replacementContext.sessionFamilyId);
    await expect(auth.authenticate(issued[0]!.accessToken)).rejects.toMatchObject({
      status: 403,
      code: "session_revoked",
    });
    await expect(auth.refresh(issued[0]!.refreshToken)).rejects.toMatchObject({
      status: 403,
      code: "session_revoked",
    });
    const afterReplacement = await auth.listSessions(issued[1]!.accessToken);
    expect(afterReplacement).toHaveLength(MAX_ACTIVE_SESSION_FAMILIES);
    expect(afterReplacement).toContainEqual(
      expect.objectContaining({ id: replacement.sessionId }),
    );
    const capacityInspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(capacityInspection.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'identity.session.revoked'",
    ).get()).toEqual({ count: 1 });
    expect(capacityInspection.prepare(
      "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE target_kind = 'session-family'",
    ).get()).toEqual({ count: 1 });
    capacityInspection.close();

    const bypassFamilyId = tokenHash("capacity-bypass-family");
    const bypassDatabase = new DatabaseSync(databasePath);
    bypassDatabase.prepare(
      `INSERT INTO session_families (
         family_id, public_id, account_id, actor_id, device_id, device_label,
         platform, created_at, refresh_expires_at, revoked_at
       ) VALUES (?, 'capacity-bypass-public', 'account-li', 'human-li',
                 'bypass-device', 'Bypass', 'unknown', 2000, 9999999999999, NULL)`,
    ).run(bypassFamilyId);
    bypassDatabase.prepare(
      `INSERT INTO sessions (
         family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
         access_expires_at, refresh_expires_at, revoked_at
       ) VALUES (?, 'account-li', 'human-li', ?, ?, 9999999999998, 9999999999999, NULL)`,
    ).run(
      bypassFamilyId,
      tokenHash("capacity-bypass-access"),
      tokenHash("capacity-bypass-refresh"),
    );
    bypassDatabase.close();
    await expect(auth.listSessions(issued[1]!.accessToken)).rejects.toMatchObject({
      status: 409,
      code: "session_limit_reached",
    });

    const cleanupDatabase = new DatabaseSync(databasePath);
    cleanupDatabase.prepare("DELETE FROM sessions WHERE family_id = ?").run(bypassFamilyId);
    cleanupDatabase.prepare("DELETE FROM session_families WHERE family_id = ?")
      .run(bypassFamilyId);
    cleanupDatabase.close();

    now = 31 * 24 * 60 * 60 * 1_000;
    const afterExpiry = await auth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "capacity-after-expiry", label: "After expiry", platform: "linux" },
    );
    await expect(auth.listSessions(afterExpiry.accessToken)).resolves.toHaveLength(1);
    await client.close();
  });

  it("rolls back every targeted-revoke write when the authority worker fails before commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-target-revoke-rollback-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const bootstrapClient = await createWorkerDatabaseClient({ databasePath });
    const bootstrapAuthority = createSqliteAuthoritativeStore(bootstrapClient);
    await bootstrapAuthority.registerActors(actors);
    const bootstrapAuth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority: bootstrapAuthority,
      clock: () => 1_000,
      tokenFactory: tokenSequence(
        "rollback-caller-access",
        "rollback-caller-refresh",
        "rollback-target-access",
        "rollback-target-refresh",
      ),
      sessionIdFactory: tokenSequence("rollback-caller-public", "rollback-target-public"),
    });
    const caller = await bootstrapAuth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "rollback-caller", label: "Rollback caller", platform: "macos" },
    );
    const target = await bootstrapAuth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "rollback-target", label: "Rollback target", platform: "linux" },
    );
    await bootstrapClient.close();
    const before = identitySessionMutationSnapshot(databasePath);

    const faultClient = await createWorkerDatabaseClientWithTransactionFaultForTest(
      { databasePath },
      "before-commit",
    );
    const faultAuth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority: createSqliteAuthoritativeStore(faultClient),
      clock: () => 2_000,
    });

    await expect(faultAuth.revokeSession(caller.accessToken, target.sessionId))
      .rejects.toMatchObject({ code: "authority_worker_exited", status: 503 });
    expect(identitySessionMutationSnapshot(databasePath)).toEqual(before);

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare(
      `SELECT revoked_at AS revokedAt FROM session_families WHERE public_id = ?`,
    ).get(target.sessionId)).toEqual({ revokedAt: null });
    expect(inspection.prepare(
      `SELECT COUNT(*) AS count FROM sessions AS session
       JOIN session_families AS family ON family.family_id = session.family_id
       WHERE family.public_id = ? AND session.revoked_at IS NOT NULL`,
    ).get(target.sessionId)).toEqual({ count: 0 });
    inspection.close();
  });

  it.each([
    { callerState: "revoked", status: 403, code: "session_revoked" },
    { callerState: "expired", status: 401, code: "token_expired" },
  ] as const)(
    "rejects list and targeted revoke from a $callerState caller without any authority mutation",
    async ({ callerState, status, code }) => {
      const directory = await mkdtemp(join(tmpdir(), `native-im-${callerState}-caller-`));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const client = await createWorkerDatabaseClient({ databasePath });
      const authority = createSqliteAuthoritativeStore(client);
      await authority.registerActors(actors);
      let now = 1_000;
      const auth = createAuthenticationService({
        actors: actorDirectory,
        identities,
        authority,
        accessTtlMs: 100,
        refreshTtlMs: 1_000,
        clock: () => now,
        tokenFactory: tokenSequence(
          `${callerState}-caller-access`,
          `${callerState}-caller-refresh`,
          `${callerState}-target-access`,
          `${callerState}-target-refresh`,
        ),
        sessionIdFactory: tokenSequence(
          `${callerState}-caller-public`,
          `${callerState}-target-public`,
        ),
      });
      const caller = await auth.login(
        { accountId: "account-li", secret: "correct" },
        { id: `${callerState}-caller`, label: "Caller", platform: "macos" },
      );
      const target = await auth.login(
        { accountId: "account-li", secret: "correct" },
        { id: `${callerState}-target`, label: "Target", platform: "linux" },
      );
      if (callerState === "revoked") {
        await auth.revoke(caller.accessToken);
      } else {
        now = 1_100;
      }
      const before = identitySessionMutationSnapshot(databasePath);

      await expect(auth.listSessions(caller.accessToken)).rejects.toMatchObject({ status, code });
      await expect(auth.revokeSession(caller.accessToken, target.sessionId))
        .rejects.toMatchObject({ status, code });

      expect(identitySessionMutationSnapshot(databasePath)).toEqual(before);
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      expect(inspection.prepare(
        `SELECT revoked_at AS revokedAt FROM session_families WHERE public_id = ?`,
      ).get(target.sessionId)).toEqual({ revokedAt: null });
      inspection.close();
      await client.close();
    },
  );

  it("authenticates and refreshes v11 tokens after the v12 family migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-v11-session-token-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const oldAccessToken = "v11-access-token";
    const oldRefreshToken = "v11-refresh-token";
    const familyId = tokenHash(oldAccessToken);
    const database = new DatabaseSync(databasePath);
    migrateAuthorityDatabaseToVersion11ForTest(database);
    database.prepare(
      `INSERT INTO actors (id, kind, display_name)
       VALUES ('human-li', 'human', 'Lionel')`,
    ).run();
    database.prepare(
      `INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
       VALUES ('identity', 'human-li', 0, 1)`,
    ).run();
    database.prepare(
      `INSERT INTO sessions (
         family_id, account_id, actor_id, access_token_hash, refresh_token_hash,
         access_expires_at, refresh_expires_at, revoked_at
       ) VALUES (?, 'account-li', 'human-li', ?, ?, 5000, 20000, NULL)`,
    ).run(familyId, tokenHash(oldAccessToken), tokenHash(oldRefreshToken));
    database.close();

    const client = await createWorkerDatabaseClient({ databasePath });
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority: createSqliteAuthoritativeStore(client),
      clock: () => 1_000,
      tokenFactory: tokenSequence("v12-access-token", "v12-refresh-token"),
    });

    await expect(auth.authenticate(oldAccessToken)).resolves.toEqual({
      accountId: "account-li",
      actorId: "human-li",
    });
    const rotated = await auth.refresh(oldRefreshToken);
    expect(rotated.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.sessionId).not.toContain(familyId);
    await expect(auth.authenticate(rotated.accessToken)).resolves.toEqual({
      accountId: "account-li",
      actorId: "human-li",
    });
    await expect(client.inspectSchema()).resolves.toEqual({ version: 26 });
    await client.close();
  });

  it("persists a room.create command through the authoritative worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-room-command-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client, { clock: () => 2_000 });
    await authority.registerActors(actors);
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority,
      clock: () => 1_000,
      tokenFactory: tokenSequence("command-access", "command-refresh"),
    });
    const issued = await auth.login({ accountId: "account-li", secret: "correct" });
    const session = await auth.authenticateSession(issued.accessToken);

    const acknowledgement = await authority.executeHuman(
      {
        ...session,
        kind: "human",
        requestId: "request-create-room",
        idempotencyKey: "create-room-once",
      },
      { type: "room.create", payload: { name: "Persistence" } },
    );

    expect(acknowledgement.aggregateId).toEqual(expect.any(String));
    expect(acknowledgement.eventIds).toHaveLength(2);
    await client.close();
  });

  describe("message.send shared idempotency", () => {
    it("commits the human message before its fence and then snapshots closed Agent membership once", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-route-job-message-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const routeActors = [
        actors[0],
        actors[1],
        {
          id: "agent-route-second",
          kind: "agent",
          displayName: "Second Router Target",
          readiness: "ready",
          toolPermissions: ["route.read"],
        },
      ] as const satisfies readonly Actor[];
      const bootstrapClient = await createWorkerDatabaseClient({ databasePath });
      const bootstrapAuthority = createSqliteAuthoritativeStore(bootstrapClient);
      await bootstrapAuthority.registerActors(routeActors);
      const auth = createAuthenticationService({
        actors: { getActor: (actorId) => routeActors.find((actor) => actor.id === actorId) },
        identities,
        authority: bootstrapAuthority,
        clock: () => 1_000,
        tokenFactory: tokenSequence("route-access", "route-refresh"),
      });
      const issued = await auth.login({ accountId: "account-li", secret: "correct" });
      const session = await auth.authenticateSession(issued.accessToken);
      await bootstrapClient.close();

      const setup = new DatabaseSync(databasePath);
      migrateAuthorityDatabase(setup);
      setup.exec(`
        INSERT INTO rooms (id, name, status, created_at)
        VALUES ('room-route', 'Route Room', 'active', '2026-08-17T10:00:00.000Z');
        INSERT INTO room_memberships (
          room_id, actor_id, kind, role, participation, tool_permissions_json,
          joined_at, configured_at, access_revision
        ) VALUES
          ('room-route', 'human-li', 'human', 'member', NULL, '[]',
           '2026-08-17T10:00:00.000Z', NULL, 0),
          ('room-route', 'agent-review', 'agent', NULL, 'active', '["review.read"]',
           NULL, '2026-08-17T10:00:00.000Z', 1),
          ('room-route', 'agent-route-second', 'agent', NULL, 'on-mention', '["route.read"]',
           NULL, '2026-08-17T10:00:00.000Z', 1);
        UPDATE rooms SET owner_actor_id = 'human-li', governance_revision = 1
        WHERE id = 'room-route';
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('room', 'room-route', 0, 1);
      `);
      setup.close();

      const client = await createWorkerDatabaseClient({ databasePath });
      const authority = createSqliteAuthoritativeStore(client, { clock: () => 2_000 });
      const context = {
        ...session,
        kind: "human" as const,
        requestId: "route-message-first",
        idempotencyKey: "route-message-idempotency",
      };
      const command = {
        type: "message.send",
        roomId: "room-route",
        payload: {
          id: "message-route-source",
          roomId: "room-route",
          body: "@agent-review @agent-route-second Please assess the database migration risk",
          sentAt: "2026-08-17T10:01:00.000Z",
        },
      } as const;

      const first = await authority.executeHuman(context, command);
      await expect(authority.executeHuman(
        { ...context, requestId: "route-message-replay" },
        command,
      )).resolves.toEqual(first);
      await expect(client.executeRuntime({
        type: "runtime.cancel-for-human-fence",
        sourceHumanMessageId: command.payload.id,
        now: 2_000,
      })).resolves.toMatchObject({ kind: "human-fence-cancelled" });
      await expect(client.executeRuntime({
        type: "runtime.create-route-after-human-fence",
        sourceHumanMessageId: command.payload.id,
        now: 2_001,
      })).resolves.toMatchObject({ kind: "human-fence-route", replayed: false });

      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      expect(inspection.prepare(
        `SELECT source_message_id AS sourceMessageId, status, current_attempt AS currentAttempt,
                embedding_model_version AS embeddingModelVersion, window_size AS windowSize,
                cosine_threshold AS cosineThreshold, room_phase AS roomPhase
         FROM route_jobs`,
      ).all()).toEqual([{
        sourceMessageId: "message-route-source",
        status: "queued",
        currentAttempt: 1,
        embeddingModelVersion: "dao-topic-embedding-v1",
        windowSize: 8,
        cosineThreshold: 0.82,
        roomPhase: "discussion",
      }]);
      expect(inspection.prepare(
        `SELECT agent_id AS agentId, participation, role, capabilities_json AS capabilitiesJson,
                calibration_score AS calibrationScore, has_ball AS hasBall
         FROM route_job_agents ORDER BY agent_id`,
      ).all()).toEqual([
        {
          agentId: "agent-review",
          participation: "active",
          role: "Reviewer",
          capabilitiesJson: '["review.read"]',
          calibrationScore: 0,
          hasBall: 0,
        },
        {
          agentId: "agent-route-second",
          participation: "on-mention",
          role: "Second Router Target",
          capabilitiesJson: '["route.read"]',
          calibrationScore: 0,
          hasBall: 0,
        },
      ]);
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM route_attempts").get()).toEqual({ count: 1 });
      expect(inspection.prepare("SELECT COUNT(*) AS count FROM message_topics").get()).toEqual({ count: 1 });
      inspection.close();

      const claimed = await client.executeRoute({
        type: "route.claim",
        agentProviderReady: true,
        sourceMessageId: command.payload.id,
        now: 2_100,
      });
      expect(claimed).toMatchObject({
        kind: "route-claimed",
        job: { status: "running", currentAttempt: 1 },
        providerInput: {
          purpose: "route_decision",
          sourceMessageId: command.payload.id,
          message: {
            authorId: "human-li",
            authorKind: "human",
            summary: command.payload.body,
          },
          agents: [],
          limits: { timeoutMs: 1_000, maxCandidates: 0, maxOutputBytes: 65_536 },
        },
        decisionContext: {
          directMentionAgentIds: [],
          structuredHelpAgentIds: [],
        },
      });
      await expect(client.executeRoute({
        type: "route.claim",
        agentProviderReady: true,
        sourceMessageId: command.payload.id,
        now: 2_101,
      })).rejects.toMatchObject({ status: 409, code: "route_conflict" });

      await expect(authority.executeHuman(
        { ...context, requestId: "remove-route-agent", idempotencyKey: "remove-route-agent" },
        { type: "member.remove", roomId: "room-route", payload: { targetActorId: "agent-route-second" } },
      )).rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
      const routeJobId = (claimed as { readonly job: { readonly id: string } }).job.id;
      const judgments = [];
      const intents = [];
      await expect(client.executeRoute({
        type: "route.complete",
        routeJobId,
        attempt: 1,
        judgments,
        intents,
        agentProviderReady: true,
        now: 2_200,
      })).resolves.toMatchObject({
        kind: "route-completed",
        job: { status: "completed" },
        intents: [],
        handoffs: [],
      });

      const completedInspection = new DatabaseSync(databasePath, { readOnly: true });
      expect(completedInspection.prepare(
        `SELECT agent_id AS agentId, outcome, reason_code AS reasonCode
         FROM route_judgments ORDER BY agent_id`,
      ).all()).toEqual([]);
      expect(completedInspection.prepare(
        `SELECT target_agent_id AS targetAgentId FROM route_invocation_intents`,
      ).all()).toEqual([]);
      completedInspection.close();

      const routedInvocation = {
        type: "runtime.invoke-routed",
        routeJobId,
        intent: {
          kind: "direct_mention",
          roomId: "room-route",
          sourceMessageId: command.payload.id,
          targetAgentId: "agent-review",
        },
        executionId: "execution-routed-authoritative",
        intentId: "intent-routed-authoritative",
        providerId: "openai-responses",
        modelId: "runtime-model",
        now: 2_300,
      } as const;
      await expect(client.executeRuntime(routedInvocation)).rejects.toMatchObject({
        status: 403, code: "permission_denied",
      });
      await expect(client.executeRuntime({
        ...routedInvocation,
        executionId: "execution-routed-replay-unused",
        intentId: "intent-routed-replay-unused",
        now: 2_301,
      })).rejects.toMatchObject({
        status: 403, code: "permission_denied",
      });
      await expect(client.executeRuntime({
        ...routedInvocation,
        intent: { ...routedInvocation.intent, targetAgentId: "agent-route-second" },
        executionId: "execution-routed-forbidden",
        intentId: "intent-routed-forbidden",
        now: 2_302,
      })).rejects.toMatchObject({
        status: 403, code: "permission_denied",
      });

      const retryCommand = {
        type: "message.send",
        roomId: "room-route",
        payload: {
          id: "message-route-retry",
          roomId: "room-route",
          body: "Assess another migration risk",
          sentAt: "2026-08-17T10:02:00.000Z",
        },
      } as const;
      await authority.executeHuman(
        { ...context, requestId: "route-retry-message", idempotencyKey: "route-retry-message" },
        retryCommand,
      );
      await client.executeRuntime({
        type: "runtime.cancel-for-human-fence",
        sourceHumanMessageId: retryCommand.payload.id,
        now: 2_900,
      });
      await client.executeRuntime({
        type: "runtime.create-route-after-human-fence",
        sourceHumanMessageId: retryCommand.payload.id,
        now: 2_901,
      });
      const retryClaim1 = await client.executeRoute({
        type: "route.claim",
        agentProviderReady: true,
        sourceMessageId: retryCommand.payload.id,
        now: 3_000,
      }) as { readonly job: { readonly id: string } };
      const retryJobId = retryClaim1.job.id;
      await expect(client.executeRoute({
        type: "route.fail",
        routeJobId: retryJobId,
        attempt: 1,
        errorCode: "provider_timeout",
        now: 3_100,
      })).resolves.toMatchObject({
        kind: "route-failed",
        retryAfterMs: 250,
        job: { status: "queued", currentAttempt: 2, nextRetryAt: "1970-01-01T00:00:03.350Z" },
      });
      await expect(client.executeRoute({
        type: "route.claim",
        agentProviderReady: true,
        sourceMessageId: retryCommand.payload.id,
        now: 3_349,
      })).rejects.toMatchObject({ status: 409, code: "route_conflict" });
      await client.executeRoute({
        type: "route.claim",
        agentProviderReady: true,
        sourceMessageId: retryCommand.payload.id,
        now: 3_350,
      });
      await expect(client.executeRoute({
        type: "route.fail",
        routeJobId: retryJobId,
        attempt: 2,
        errorCode: "provider_malformed",
        now: 3_400,
      })).resolves.toMatchObject({
        kind: "route-failed",
        retryAfterMs: 1_000,
        job: { status: "queued", currentAttempt: 3, nextRetryAt: "1970-01-01T00:00:04.400Z" },
      });
      await client.executeRoute({
        type: "route.claim",
        agentProviderReady: true,
        sourceMessageId: retryCommand.payload.id,
        now: 4_400,
      });
      await expect(client.executeRoute({
        type: "route.fail",
        routeJobId: retryJobId,
        attempt: 3,
        errorCode: "provider_failure",
        now: 4_500,
      })).resolves.toMatchObject({
        kind: "route-failed",
        job: { status: "failed", currentAttempt: 3, terminalErrorCode: "provider_failure" },
      });
      const exhaustedInspection = new DatabaseSync(databasePath, { readOnly: true });
      expect(exhaustedInspection.prepare(
        `SELECT attempt_seq AS attemptSeq, status, error_code AS errorCode
         FROM route_attempts WHERE route_job_id = ? ORDER BY attempt_seq`,
      ).all(retryJobId)).toEqual([
        { attemptSeq: 1, status: "failed", errorCode: "provider_timeout" },
        { attemptSeq: 2, status: "failed", errorCode: "provider_malformed" },
        { attemptSeq: 3, status: "failed", errorCode: "provider_failure" },
      ]);
      expect(exhaustedInspection.prepare(
        `SELECT agent_id AS agentId, reason_code AS reasonCode, route_attempt AS routeAttempt
         FROM route_judgments WHERE route_job_id = ?`,
      ).all(retryJobId)).toEqual([
        { agentId: "agent-review", reasonCode: "provider_failed", routeAttempt: 3 },
        { agentId: "agent-route-second", reasonCode: "provider_failed", routeAttempt: 3 },
      ]);
      expect(exhaustedInspection.prepare(
        `SELECT metric_name AS metricName, value FROM route_metrics WHERE route_job_id = ?`,
      ).all(retryJobId)).toEqual([{ metricName: "attempts_exhausted", value: 1 }]);
      exhaustedInspection.close();

      const restartCommand = {
        type: "message.send",
        roomId: "room-route",
        payload: {
          id: "message-route-worker-restart",
          roomId: "room-route",
          body: "Assess the restart boundary",
          sentAt: "2026-08-17T10:03:00.000Z",
        },
      } as const;
      await authority.executeHuman(
        { ...context, requestId: "route-restart-message", idempotencyKey: "route-restart-message" },
        restartCommand,
      );
      await client.executeRuntime({
        type: "runtime.cancel-for-human-fence",
        sourceHumanMessageId: restartCommand.payload.id,
        now: 4_900,
      });
      await client.executeRuntime({
        type: "runtime.create-route-after-human-fence",
        sourceHumanMessageId: restartCommand.payload.id,
        now: 4_901,
      });
      const restartClaim = await client.executeRoute({
        type: "route.claim",
        agentProviderReady: true,
        sourceMessageId: restartCommand.payload.id,
        now: 5_000,
      }) as { readonly job: { readonly id: string } };
      await client.close();

      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      await expect(restartedClient.executeRoute({
        type: "route.recover",
        now: 5_100,
      })).resolves.toMatchObject({
        kind: "route-recovery",
        jobs: [{
          id: restartClaim.job.id,
          status: "queued",
          currentAttempt: 2,
          nextRetryAt: "1970-01-01T00:00:05.350Z",
        }],
      });
      await expect(restartedClient.executeRoute({
        type: "route.recover",
        now: 5_350,
      })).resolves.toMatchObject({
        kind: "route-recovery",
        jobs: [{
          id: restartClaim.job.id,
          status: "queued",
          currentAttempt: 2,
          nextRetryAt: "1970-01-01T00:00:05.350Z",
        }],
      });
      await restartedClient.close();
      const recoveredInspection = new DatabaseSync(databasePath, { readOnly: true });
      expect(recoveredInspection.prepare(
        `SELECT attempt_seq AS attemptSeq, status, error_code AS errorCode
         FROM route_attempts WHERE route_job_id = ? ORDER BY attempt_seq`,
      ).all(restartClaim.job.id)).toEqual([
        { attemptSeq: 1, status: "failed", errorCode: "runtime_restarted" },
        { attemptSeq: 2, status: "queued", errorCode: null },
      ]);
      expect(recoveredInspection.prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE event_type = 'route.retry-scheduled' AND payload_json LIKE ?`,
      ).get(`%${restartClaim.job.id}%`)).toEqual({ count: 1 });
      recoveredInspection.close();
    });

    it("returns one stable acknowledgement for sequential exact replay", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-message-sequential-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createHumanCommandFixture(databasePath);

      const first = await fixture.authority.executeHuman(fixture.context, messageCommand);
      const replay = await fixture.authority.executeHuman(
        {
          ...fixture.context,
          requestId: "message-request-replay",
          idempotencyKey: "different-transport-key",
        },
        messageCommand,
      );

      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        aggregateId: "message-command",
        eventIds: [expect.any(String)],
      });
      await fixture.client.close();
      expect(readMessageCommandCounts(databasePath)).toEqual({
        messages: 1,
        events: 1,
        outbox: 1,
        idempotency: 1,
      });
    });

    it("serializes concurrent exact replay to one fact and event", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-message-concurrent-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createHumanCommandFixture(databasePath);

      const [first, replay] = await Promise.all([
        fixture.authority.executeHuman(fixture.context, messageCommand),
        fixture.authority.executeHuman(
          { ...fixture.context, requestId: "message-request-concurrent" },
          messageCommand,
        ),
      ]);

      expect(replay).toEqual(first);
      await fixture.client.close();
      expect(readMessageCommandCounts(databasePath)).toEqual({
        messages: 1,
        events: 1,
        outbox: 1,
        idempotency: 1,
      });
    });

    it("rejects a changed canonical payload without changing counts", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-message-conflict-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createHumanCommandFixture(databasePath);
      await fixture.authority.executeHuman(fixture.context, messageCommand);

      await expect(
        fixture.authority.executeHuman(
          {
            ...fixture.context,
            requestId: "message-request-conflict",
            idempotencyKey: "changed-transport-key",
          },
          {
            ...messageCommand,
            payload: { ...messageCommand.payload, body: "changed payload" },
          },
        ),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });

      await fixture.client.close();
      expect(readMessageCommandCounts(databasePath)).toEqual({
        messages: 1,
        events: 1,
        outbox: 1,
        idempotency: 1,
      });
    });

    it("replays the stable acknowledgement after a worker restart", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-message-restart-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createHumanCommandFixture(databasePath);
      const first = await fixture.authority.executeHuman(fixture.context, messageCommand);
      await fixture.client.close();

      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
        clock: () => 9_000,
      });
      const replay = await restartedAuthority.executeHuman(
        { ...fixture.context, requestId: "message-request-after-restart" },
        messageCommand,
      );

      expect(replay).toEqual(first);
      await restartedClient.close();
      expect(readMessageCommandCounts(databasePath)).toEqual({
        messages: 1,
        events: 1,
        outbox: 1,
        idempotency: 1,
      });
    });
  });

  it("reads message history through an authenticated authority query", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-history-query-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createAgentFactFixture(databasePath);

    await expect(
      fixture.authority.readHistory(
        {
          sessionId: fixture.humanContext.sessionId,
          sessionFamilyId: fixture.humanContext.sessionFamilyId,
          principal: fixture.humanContext.principal,
        },
        "room-facts",
      ),
    ).resolves.toEqual([
      {
        id: "message-human-source",
        roomId: "room-facts",
        authorId: "human-li",
        authorKind: "human",
        body: "please review",
        sentAt: "2026-08-10T13:01:00.000Z",
      },
      {
        id: "message-agent-source",
        roomId: "room-facts",
        authorId: "agent-review",
        authorKind: "agent",
        body: "review complete",
        sentAt: "2026-08-10T13:02:00.000Z",
      },
    ]);
    await fixture.client.close();
  });

  it("serves actor, room, access, and audit through closed authoritative queries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-lifecycle-query-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createRoomGovernanceFixture(databasePath);
    const session = {
      sessionId: fixture.context.sessionId,
      sessionFamilyId: fixture.context.sessionFamilyId,
      principal: fixture.context.principal,
    };
    expect(isAuthorityWorkerRequest({
      type: "authority.read-actor",
      requestId: "query-extra",
      actorId: "human-li",
      extra: true,
    })).toBe(false);
    expect(isAuthorityWorkerRequest({
      type: "authority.read-room-audit",
      requestId: "query-extra",
      context: session,
      roomId: fixture.roomId,
      now: 2_000,
      extra: true,
    })).toBe(false);

    await expect(fixture.authority.readActor("human-li")).resolves.toEqual(actors[0]);
    await expect(fixture.authority.readRoom(fixture.roomId)).resolves.toMatchObject({
      id: fixture.roomId,
      name: "Governance",
      status: "active",
      members: [expect.objectContaining({ actorId: "human-li", role: "owner" })],
    });
    await expect(fixture.authority.canAccessRoom(session, fixture.roomId)).resolves.toBe(true);
    await expect(fixture.authority.readRoomAudit(session, fixture.roomId)).resolves.toEqual([
      expect.objectContaining({
        type: "room.created",
        roomId: fixture.roomId,
        actorId: "human-li",
        result: "created",
      }),
    ]);
    await expect(
      fixture.authority.canAccessRoom(
        { ...session, principal: { ...session.principal, actorId: "agent-review" } },
        fixture.roomId,
      ),
    ).rejects.toMatchObject({ status: 403, code: "identity_forbidden" });
    await fixture.client.close();

    const archivedDatabase = new DatabaseSync(databasePath);
    archivedDatabase.prepare(
      "UPDATE rooms SET status = 'archived', archived_at = ?, archive_generation = 1 WHERE id = ?",
    ).run("2026-08-18T00:00:00.000Z", fixture.roomId);
    archivedDatabase.prepare(
      `INSERT INTO room_message_archive_gates (room_id, gate_generation, blocked_at)
       VALUES (?, 1, ?)`,
    ).run(fixture.roomId, "2026-08-18T00:00:00.000Z");
    archivedDatabase.close();
    const archivedClient = await createWorkerDatabaseClient({ databasePath });
    const archivedAuthority = createSqliteAuthoritativeStore(archivedClient, { clock: () => 2_000 });
    await expect(archivedAuthority.canAccessRoom(session, fixture.roomId)).resolves.toBe(true);
    await expect(archivedAuthority.readRoomAudit(session, fixture.roomId))
      .resolves.toHaveLength(1);
    await archivedClient.close();

    const removedDatabase = new DatabaseSync(databasePath);
    removedDatabase.prepare(
      "UPDATE rooms SET status = 'active', archived_at = NULL WHERE id = ?",
    ).run(fixture.roomId);
    expect(() => removedDatabase.prepare(
      "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
    ).run(fixture.roomId, "human-li")).toThrow("current room owner cannot be removed");
    removedDatabase.close();
    const removedClient = await createWorkerDatabaseClient({ databasePath });
    const removedAuthority = createSqliteAuthoritativeStore(removedClient, { clock: () => 2_000 });
    await expect(removedAuthority.canAccessRoom(session, fixture.roomId)).resolves.toBe(true);
    await expect(removedAuthority.readRoomAudit(session, fixture.roomId)).resolves.toHaveLength(1);
    await removedClient.close();
  });

  it("rejects expired and revoked sessions before permission-sensitive queries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-query-session-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createRoomGovernanceFixture(databasePath);
    const session = {
      sessionId: fixture.context.sessionId,
      sessionFamilyId: fixture.context.sessionFamilyId,
      principal: fixture.context.principal,
    };
    await fixture.client.close();

    const expiredClient = await createWorkerDatabaseClient({ databasePath });
    const expiredAuthority = createSqliteAuthoritativeStore(expiredClient, {
      clock: () => 1_000_000_000,
    });
    await expect(expiredAuthority.canAccessRoom(session, fixture.roomId))
      .rejects.toMatchObject({ status: 401, code: "token_expired" });
    await expiredClient.close();

    const revokedClient = await createWorkerDatabaseClient({ databasePath });
    const revokedAuthority = createSqliteAuthoritativeStore(revokedClient, { clock: () => 2_000 });
    await revokedAuthority.revoke(session.sessionId, 1_500);
    await expect(revokedAuthority.readRoomAudit(session, fixture.roomId))
      .rejects.toMatchObject({ status: 403, code: "session_revoked" });
    await revokedClient.close();
  });

  it("fails closed when audit details attempt to override authoritative envelope fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-query-audit-corrupt-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createRoomGovernanceFixture(databasePath);
    const session = {
      sessionId: fixture.context.sessionId,
      sessionFamilyId: fixture.context.sessionFamilyId,
      principal: fixture.context.principal,
    };
    await fixture.client.close();
    const database = new DatabaseSync(databasePath);
    expect(() => database.prepare(
      "UPDATE room_audit SET details_json = ? WHERE room_id = ?",
    ).run('{"actorId":"agent-review"}', fixture.roomId)).toThrow("room audit is immutable");
    database.close();

    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client, { clock: () => 2_000 });
    await expect(authority.readRoomAudit(session, fixture.roomId)).resolves.toEqual([
      expect.objectContaining({ type: "room.created", actorId: "human-li" }),
    ]);
    await client.close();
  });

  it("persists a human read separately with stable replay and conflict semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-human-read-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createHumanCommandFixture(databasePath);
    await fixture.authority.executeHuman(fixture.context, messageCommand);
    const context = {
      ...fixture.context,
      requestId: "human-read-first",
      idempotencyKey: "human-read-key",
    };
    const command = {
      type: "human.read.record",
      roomId: messageCommand.roomId,
      payload: { messageId: messageCommand.payload.id },
    } as const;

    await expect(
      fixture.authority.executeHuman(
        { ...context, requestId: "human-read-missing", idempotencyKey: "human-read-missing-key" },
        { ...command, payload: { messageId: "missing-message" } },
      ),
    ).rejects.toMatchObject({ status: 404, code: "message_not_found" });

    const first = await fixture.authority.executeHuman(context, command);
    expect(
      await fixture.authority.executeHuman(
        { ...context, requestId: "human-read-replay" },
        command,
      ),
    ).toEqual(first);
    await expect(
      fixture.authority.executeHuman(
        { ...context, requestId: "human-read-conflict" },
        { ...command, payload: { messageId: "different-message" } },
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await fixture.client.close();

    const restartedClient = await createWorkerDatabaseClient({ databasePath });
    const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
      clock: () => 9_000,
    });
    await expect(
      restartedAuthority.executeHuman(
        { ...context, requestId: "human-read-restart" },
        command,
      ),
    ).resolves.toEqual(first);
    await restartedClient.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM human_read_receipts").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_judgments").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.human_read.recorded'").get())
      .toEqual({ count: 1 });
    database.close();
  });

  describe("Agent judgment authority and persistence", () => {
    it("persists Agent-authored messages from the opaque capability context", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-agent-message-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const command = {
        type: "message.send",
        roomId: "room-facts",
        payload: {
          id: "message-agent-authoritative",
          roomId: "room-facts",
          body: "agent authoritative reply",
          sentAt: "2026-08-10T13:03:00.000Z",
        },
      } as const;
      const context = mintInternalAgentCommandContext({
        agentId: "agent-review",
        requestId: "agent-message-first",
        idempotencyKey: "agent-message-key",
      });

      const first = await fixture.authority.executeAgent(context, command);
      await expect(fixture.authority.executeAgent(
        mintInternalAgentCommandContext({
          agentId: "agent-review",
          requestId: "agent-message-replay",
          idempotencyKey: "agent-message-other-transport-key",
        }),
        command,
      )).resolves.toEqual(first);
      await expect(fixture.authority.executeAgent(
        mintInternalAgentCommandContext({
          agentId: "agent-review",
          requestId: "agent-message-conflict",
          idempotencyKey: "agent-message-conflict-transport-key",
        }),
        { ...command, payload: { ...command.payload, body: "changed body" } },
      )).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      await fixture.client.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        "SELECT author_id AS authorId, author_kind AS authorKind FROM messages WHERE id = ?",
      ).get(command.payload.id)).toEqual({ authorId: "agent-review", authorKind: "agent" });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.message.accepted'",
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM route_jobs WHERE source_message_id = ?",
      ).get(command.payload.id)).toEqual({ count: 0 });
      database.close();
    });

    it.each([
      ["will_respond", "matches domain and will answer"],
      ["no_response_needed", "does not match domain"],
      ["suppressed", "cooldown is active"],
    ] as const)("persists %s with a non-empty reason", async (outcome, reason) => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-agent-judgment-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const context = mintInternalAgentCommandContext({
        agentId: "agent-review",
        requestId: `judgment-${outcome}-first`,
        idempotencyKey: `judgment-${outcome}-key`,
      });
      const command = {
        type: "agent.judgment.record",
        roomId: "room-facts",
        payload: {
          messageId: "message-human-source",
          outcome,
          reason,
        },
      } as const;

      const first = await fixture.authority.executeAgent(context, command);
      expect(
        await fixture.authority.executeAgent(
          mintInternalAgentCommandContext({
            agentId: "agent-review",
            requestId: `judgment-${outcome}-replay`,
            idempotencyKey: `judgment-${outcome}-key`,
          }),
          command,
        ),
      ).toEqual(first);
      await expect(
        fixture.authority.executeAgent(
          mintInternalAgentCommandContext({
            agentId: "agent-review",
            requestId: `judgment-${outcome}-conflict`,
            idempotencyKey: `judgment-${outcome}-key`,
          }),
          { ...command, payload: { ...command.payload, reason: `${reason} changed` } },
        ),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      await fixture.client.close();

      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
        clock: () => 9_000,
      });
      await expect(
        restartedAuthority.executeAgent(
          mintInternalAgentCommandContext({
            agentId: "agent-review",
            requestId: `judgment-${outcome}-restart`,
            idempotencyKey: `judgment-${outcome}-key`,
          }),
          command,
        ),
      ).resolves.toEqual(first);
      await restartedClient.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      const row = database
        .prepare("SELECT judgment_json AS judgmentJson FROM agent_judgments")
        .get();
      expect(JSON.parse(String(row?.judgmentJson))).toMatchObject({ outcome, reason });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_judgments").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM human_read_receipts").get())
        .toEqual({ count: 0 });
      database.close();
    });

    it("rejects forged capabilities and human/Agent primitive crossover", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-agent-authority-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const judgment = {
        type: "agent.judgment.record",
        roomId: "room-facts",
        payload: {
          messageId: "message-human-source",
          outcome: "will_respond",
          reason: "will answer",
        },
      } as const;

      await expect(
        fixture.authority.executeAgent(
          {
            kind: "agent",
            agent: { actorId: "agent-review", kind: "agent" },
            requestId: "forged",
            idempotencyKey: "forged",
          } as never,
          judgment,
        ),
      ).rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
      await expect(
        fixture.authority.executeHuman(
          { ...fixture.humanContext, requestId: "human-agent-crossover" },
          judgment as never,
        ),
      ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
      await expect(
        fixture.authority.executeAgent(
          mintInternalAgentCommandContext({
            agentId: "agent-review",
            requestId: "agent-human-crossover",
            idempotencyKey: "agent-human-crossover",
          }),
          {
            type: "human.read.record",
            roomId: "room-facts",
            payload: { messageId: "message-human-source" },
          } as never,
        ),
      ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
      await fixture.client.close();
    });
  });

  describe("open-item authoritative facts", () => {
    it("persists human create and Agent transition with stable replay acknowledgements", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-open-item-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const createCommand = {
        type: "open-item.create",
        roomId: "room-facts",
        payload: {
          creationKind: "manual_unfinished",
          sourceMessageId: "message-human-source",
          targetActorId: "agent-review",
          content: "Review the authoritative result",
        },
      } as const;
      const createContext = {
        ...fixture.humanContext,
        requestId: "open-item-create-first",
        idempotencyKey: "open-item-create-key",
      };

      const created = await fixture.authority.executeHuman(createContext, createCommand);
      await expect(
        fixture.authority.executeHuman(
          { ...createContext, requestId: "open-item-create-replay" },
          createCommand,
        ),
      ).resolves.toEqual(created);
      await expect(
        fixture.authority.executeHuman(
          { ...createContext, requestId: "open-item-create-conflict" },
          { ...createCommand, payload: { ...createCommand.payload, content: "changed" } },
        ),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });

      const transitionCommand = {
        type: "open-item.transition",
        roomId: "room-facts",
        payload: { itemId: created.aggregateId, action: "answer" },
      } as const;
      const agentContext = mintInternalAgentCommandContext({
        agentId: "agent-review",
        requestId: "open-item-respond-first",
        idempotencyKey: "open-item-respond-key",
      });
      const transitioned = await fixture.authority.executeAgent(agentContext, transitionCommand);
      await expect(
        fixture.authority.executeAgent(
          mintInternalAgentCommandContext({
            agentId: "agent-review",
            requestId: "open-item-respond-replay",
            idempotencyKey: "open-item-respond-key",
          }),
          transitionCommand,
        ),
      ).resolves.toEqual(transitioned);
      await fixture.client.close();

      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
        clock: () => 9_000,
      });
      await expect(
        restartedAuthority.executeHuman(
          { ...createContext, requestId: "open-item-create-restart" },
          createCommand,
        ),
      ).resolves.toEqual(created);
      await restartedClient.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      const item = database.prepare(
        `SELECT status, requester_actor_id AS requesterId,
                current_owner_actor_id AS currentOwnerId, transfer_chain_json AS transferChain,
                responded_at AS respondedAt
         FROM open_items`,
      ).get();
      expect(item).toEqual({
        status: "answered",
        requesterId: "human-li",
        currentOwnerId: null,
        transferChain: "[]",
        respondedAt: "1970-01-01T00:00:03.000Z",
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.open_item.changed'",
      ).get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM open_items").get())
        .toEqual({ count: 1 });
      database.close();
    });

    it("keeps human requests, Agent proposals, permissions, failures, and terminal CAS closed", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-open-item-closed-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const humanMention = await fixture.authority.executeHuman(
        { ...fixture.humanContext, requestId: "human-mention", idempotencyKey: "human-mention" },
        { type: "open-item.create", roomId: "room-facts", payload: {
          creationKind: "human_mention", sourceMessageId: "message-human-source",
          targetActorId: "human-li", content: "Human-only request",
        } },
      );
      await expect(fixture.authority.executeHuman(
        { ...fixture.humanContext, requestId: "human-mention-agent", idempotencyKey: "human-mention-agent" },
        { type: "open-item.create", roomId: "room-facts", payload: {
          creationKind: "human_mention", sourceMessageId: "message-human-source",
          targetActorId: "agent-review", content: "Must not turn an Agent invocation into a request",
        } },
      )).rejects.toMatchObject({ status: 400, code: "invalid_request" });
      const afterHumanMention = new DatabaseSync(databasePath, { readOnly: true });
      expect(afterHumanMention.prepare("SELECT COUNT(*) AS count FROM open_items").get())
        .toEqual({ count: 1 });
      expect(afterHumanMention.prepare("SELECT COUNT(*) AS count FROM agent_executions").get())
        .toEqual({ count: 0 });
      expect(afterHumanMention.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.open_item.changed'",
      ).get()).toEqual({ count: 1 });
      expect(afterHumanMention.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.agent_execution.changed'",
      ).get()).toEqual({ count: 0 });
      afterHumanMention.close();

      const agentContext = (requestId: string) => mintInternalAgentCommandContext({
        agentId: "agent-review", requestId, idempotencyKey: requestId,
      });
      const runningCommand = { type: "agent.execution.transition", roomId: "room-facts", payload: {
        executionId: "execution-open-item", sourceMessageId: "message-human-source",
        toolName: "review.read", status: "running",
      } } as const;
      await fixture.authority.executeAgent(agentContext("execution-open-item-running"), runningCommand);
      const afterAgentInvocation = new DatabaseSync(databasePath, { readOnly: true });
      expect(afterAgentInvocation.prepare("SELECT COUNT(*) AS count FROM open_items").get())
        .toEqual({ count: 1 });
      expect(afterAgentInvocation.prepare("SELECT COUNT(*) AS count FROM agent_executions").get())
        .toEqual({ count: 1 });
      expect(afterAgentInvocation.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.open_item.changed'",
      ).get()).toEqual({ count: 1 });
      expect(afterAgentInvocation.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.agent_execution.changed'",
      ).get()).toEqual({ count: 1 });
      afterAgentInvocation.close();
      const proposalCommand = { type: "open-item.propose", roomId: "room-facts", payload: {
        proposalKind: "risk", targetActorId: "agent-review",
        sourceExecutionId: "execution-open-item", sourceMessageId: "message-human-source",
        reason: "Authoritative review found a risk", content: "Resolve the identified risk",
      } } as const;
      const proposed = await fixture.authority.executeAgent(agentContext("proposal-open-item"), proposalCommand);
      await expect(fixture.authority.executeAgent(
        mintInternalAgentCommandContext({
          agentId: "agent-review", requestId: "proposal-replay", idempotencyKey: "proposal-open-item",
        }),
        proposalCommand,
      )).resolves.toEqual(proposed);
      await expect(fixture.authority.executeAgent(agentContext("proposal-forged-provenance"), {
        ...proposalCommand,
        payload: { ...proposalCommand.payload, sourceExecutionId: "execution-missing" },
      })).rejects.toMatchObject({ status: 403, code: "permission_denied" });
      await fixture.authority.executeAgent(agentContext("execution-open-item-failed"), {
        ...runningCommand, payload: { ...runningCommand.payload, status: "failed" },
      });
      const failureCommand = { type: "open-item.agent-failure.record", roomId: "room-facts", payload: {
        itemId: proposed.aggregateId, executionId: "execution-open-item",
        attemptSeq: 1, reasonCode: "legacy_failure",
      } } as const;
      const failure = await fixture.authority.executeAgent(agentContext("proposal-failure"), failureCommand);
      await expect(fixture.authority.executeAgent(
        mintInternalAgentCommandContext({
          agentId: "agent-review", requestId: "proposal-failure-replay", idempotencyKey: "proposal-failure",
        }),
        failureCommand,
      )).resolves.toEqual(failure);
      await expect(fixture.authority.executeAgent(agentContext("agent-cannot-defer"), {
        type: "open-item.transition", roomId: "room-facts",
        payload: { itemId: proposed.aggregateId, action: "defer", reason: "forbidden" },
      })).rejects.toMatchObject({ status: 403, code: "permission_denied" });

      const manual = await fixture.authority.executeHuman(
        { ...fixture.humanContext, requestId: "manual-item", idempotencyKey: "manual-item" },
        { type: "open-item.create", roomId: "room-facts", payload: {
          creationKind: "manual_unfinished", sourceMessageId: "message-human-source",
          targetActorId: "agent-review", content: "This is unfinished",
        } },
      );
      await expect(fixture.authority.executeAgent(agentContext("manual-agent-cannot-transfer"), {
        type: "open-item.transition", roomId: "room-facts", payload: {
          itemId: manual.aggregateId, action: "transfer", targetActorId: "human-li", reason: "forbidden",
        },
      })).rejects.toMatchObject({ status: 403, code: "permission_denied" });
      await expect(fixture.authority.executeHuman(
        {
          ...fixture.humanContext,
          requestId: "manual-requester-cannot-answer-for-owner",
          idempotencyKey: "manual-requester-cannot-answer-for-owner",
        },
        { type: "open-item.transition", roomId: "room-facts", payload: {
          itemId: manual.aggregateId, action: "cannot_answer", reason: "Requester is not the owner",
        } },
      )).rejects.toMatchObject({ status: 403, code: "permission_denied" });
      const transferred = await fixture.authority.executeHuman(
        { ...fixture.humanContext, requestId: "manual-transfer", idempotencyKey: "manual-transfer" },
        { type: "open-item.transition", roomId: "room-facts", payload: {
          itemId: manual.aggregateId, action: "transfer", targetActorId: "human-li", reason: "Requester takes it back",
        } },
      );
      expect(transferred.result).toMatchObject({ item: {
        status: "transferred", currentOwnerId: "human-li",
        transferChain: [{ fromId: "agent-review", toId: "human-li" }],
      } });
      await fixture.authority.executeHuman(
        { ...fixture.humanContext, requestId: "manual-answer", idempotencyKey: "manual-answer" },
        { type: "open-item.transition", roomId: "room-facts", payload: {
          itemId: manual.aggregateId, action: "answer",
        } },
      );
      await expect(fixture.authority.executeHuman(
        { ...fixture.humanContext, requestId: "manual-answer-again", idempotencyKey: "manual-answer-again" },
        { type: "open-item.transition", roomId: "room-facts", payload: {
          itemId: manual.aggregateId, action: "answer",
        } },
      )).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
      await fixture.client.close();

      const removal = new DatabaseSync(databasePath);
      expect(() => removal.prepare(
        "DELETE FROM room_memberships WHERE room_id = 'room-facts' AND actor_id = 'human-li'",
      ).run()).toThrow("current room owner cannot be removed");
      removal.close();
      const removedClient = await createWorkerDatabaseClient({ databasePath });
      const removedAuthority = createSqliteAuthoritativeStore(removedClient, { clock: () => 4_000 });
      await expect(removedAuthority.executeHuman(
        { ...fixture.humanContext, requestId: "removed-owner-answer", idempotencyKey: "removed-owner-answer" },
        { type: "open-item.transition", roomId: "room-facts", payload: {
          itemId: humanMention.aggregateId, action: "answer",
        } },
      )).resolves.toMatchObject({ result: { item: { status: "answered" } } });
      await removedClient.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT COUNT(*) AS count FROM open_items").get()).toEqual({ count: 3 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_executions").get()).toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT status, current_owner_actor_id AS currentOwnerId FROM open_items WHERE id = ?",
      ).get(proposed.aggregateId)).toEqual({ status: "awaiting", currentOwnerId: "agent-review" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM open_item_agent_failures").get())
        .toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.open_item.agent_attempt_failed'",
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT status, current_owner_actor_id AS currentOwnerId FROM open_items WHERE id = ?",
      ).get(manual.aggregateId)).toEqual({ status: "answered", currentOwnerId: null });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.open_item.changed'",
      ).get()).toEqual({ count: 6 });
      expect(humanMention.aggregateId).not.toBe(proposed.aggregateId);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE id = 'message-human-source'",
      ).get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM open_items WHERE id = ?")
        .get(humanMention.aggregateId)).toEqual({ count: 1 });
      database.close();
    });
  });

  describe("LightTask authoritative facts", () => {
    it("persists explicit confirmation, stable replay, forward transitions, criteria, and empty confirmation", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-light-task-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createLightTaskFixture(databasePath);
      await fixture.store.executeHuman(
        fixture.context("human-task-owner", "task-intent-only-message"),
        { type: "message.send", roomId: "room-light-task", payload: {
          id: "message-light-task-intent", roomId: "room-light-task", body: "我来做",
          sentAt: "2026-08-17T00:00:01.500Z",
        } },
      );
      const intentInspection = new DatabaseSync(databasePath, { readOnly: true });
      expect(intentInspection.prepare("SELECT COUNT(*) AS count FROM light_tasks").get())
        .toEqual({ count: 0 });
      intentInspection.close();
      const create = {
        type: "light-task.create", roomId: "room-light-task", payload: {
          sourceMessageId: "message-light-task", title: "完成权威评审", verifierRole: "owner",
          criteria: [{ id: "criterion-review", text: "评审通过" }],
        },
      } as const;
      const createContext = fixture.context("human-task-owner", "task-create-stable");
      const created = await fixture.store.executeHuman(createContext, create);
      await expect(fixture.store.executeHuman(
        { ...createContext, requestId: "task-create-ack-retry" }, create,
      )).resolves.toEqual(created);
      await expect(fixture.store.executeHuman(
        { ...createContext, requestId: "task-create-conflict" },
        { ...create, payload: { ...create.payload, title: "changed" } },
      )).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      expect(created.result).toMatchObject({ task: {
        status: "todo", claimant: null, claimantRoleAtClaim: null, verifierActorId: null,
      } });

      const claimed = await fixture.store.executeHuman(
        fixture.context("human-task-claimant", "task-claim"),
        { type: "light-task.transition", roomId: "room-light-task", payload: {
          taskId: created.aggregateId, action: "claim",
        } },
      );
      expect(claimed.result).toMatchObject({ task: {
        status: "claimed", claimant: "human-task-claimant", claimantRoleAtClaim: "member",
      } });
      const delivered = await fixture.store.executeHuman(
        fixture.context("human-task-claimant", "task-deliver"),
        { type: "light-task.transition", roomId: "room-light-task", payload: {
          taskId: created.aggregateId, action: "deliver",
        } },
      );
      expect(delivered.result).toMatchObject({ task: {
        status: "delivered", verifierRole: "owner", verifierActorId: "human-task-owner",
      } });
      await expect(fixture.store.executeHuman(
        fixture.context("human-task-claimant", "task-criterion-forbidden"),
        { type: "light-task.criterion.set", roomId: "room-light-task", payload: {
          taskId: created.aggregateId, criterionId: "criterion-review", met: true,
        } },
      )).rejects.toMatchObject({ status: 403, code: "permission_denied" });
      await expect(fixture.store.executeHuman(
        fixture.context("human-task-owner", "task-verify-incomplete"),
        { type: "light-task.transition", roomId: "room-light-task", payload: {
          taskId: created.aggregateId, action: "verify",
        } },
      )).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
      await fixture.store.executeHuman(
        fixture.context("human-task-owner", "task-criterion-met"),
        { type: "light-task.criterion.set", roomId: "room-light-task", payload: {
          taskId: created.aggregateId, criterionId: "criterion-review", met: true,
        } },
      );
      const verified = await fixture.store.executeHuman(
        fixture.context("human-task-owner", "task-verify"),
        { type: "light-task.transition", roomId: "room-light-task", payload: {
          taskId: created.aggregateId, action: "verify",
        } },
      );
      expect(verified.result).toMatchObject({ task: {
        status: "verified", claimant: "human-task-claimant", claimantRoleAtClaim: "member",
        verifierActorId: "human-task-owner", criteria: [{ met: true }],
      } });

      const emptyCreated = await fixture.store.executeHuman(
        fixture.context("human-task-owner", "empty-create"),
        { ...create, payload: { ...create.payload, title: "无清单验收", criteria: [] } },
      );
      await fixture.store.executeHuman(
        fixture.context("human-task-claimant", "empty-claim"),
        { type: "light-task.transition", roomId: "room-light-task", payload: {
          taskId: emptyCreated.aggregateId, action: "claim",
        } },
      );
      await fixture.store.executeHuman(
        fixture.context("human-task-claimant", "empty-deliver"),
        { type: "light-task.transition", roomId: "room-light-task", payload: {
          taskId: emptyCreated.aggregateId, action: "deliver",
        } },
      );
      await expect(fixture.store.executeHuman(
        fixture.context("human-task-owner", "empty-verify-no-confirm"),
        { type: "light-task.transition", roomId: "room-light-task", payload: {
          taskId: emptyCreated.aggregateId, action: "verify",
        } },
      )).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
      await fixture.store.executeHuman(
        fixture.context("human-task-owner", "empty-verify-confirmed"),
        { type: "light-task.transition", roomId: "room-light-task", payload: {
          taskId: emptyCreated.aggregateId, action: "verify", emptyCriteriaConfirmed: true,
        } },
      );
      await fixture.client.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT COUNT(*) AS count FROM light_tasks").get()).toEqual({ count: 2 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.light_task.changed'",
      ).get()).toEqual({ count: 9 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_deliveries AS delivery
         JOIN events AS event ON event.event_id = delivery.event_id
         WHERE event.event_type = 'room.light_task.changed'`,
      ).get()).toEqual({ count: 9 });
      database.close();
    });

    it("rejects same-role, ambiguous verifier, same actor, and removed claimant transitions", async () => {
      const scenarios = ["same-role", "ambiguous", "same-actor", "removed"] as const;
      for (const scenario of scenarios) {
        const directory = await mkdtemp(join(tmpdir(), `native-im-light-task-${scenario}-`));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "authority.sqlite");
        const fixture = await createLightTaskFixture(databasePath);
        const claimantId = scenario === "same-actor" ? "human-task-owner" : "human-task-claimant";
        const verifierRole = scenario === "same-role" ? "member"
          : scenario === "ambiguous" ? "admin"
          : scenario === "same-actor" ? "member" : "owner";
        const created = await fixture.store.executeHuman(
          fixture.context("human-task-owner", `${scenario}-create`),
          { type: "light-task.create", roomId: "room-light-task", payload: {
            sourceMessageId: "message-light-task", title: scenario, verifierRole, criteria: [],
          } },
        );
        await fixture.store.executeHuman(
          fixture.context(claimantId, `${scenario}-claim`),
          { type: "light-task.transition", roomId: "room-light-task", payload: {
            taskId: created.aggregateId, action: "claim",
          } },
        );
        await fixture.client.close();
        const database = new DatabaseSync(databasePath);
        if (scenario === "ambiguous") {
          database.exec(`UPDATE room_memberships SET role = 'admin'
                         WHERE room_id = 'room-light-task' AND actor_id = 'human-task-admin-b'`);
        } else if (scenario === "same-actor") {
          // Canonical ownership keeps the owner role immutable; the two member candidates
          // still close this ambiguous delivery path without forging an owner role change.
        } else if (scenario === "removed") {
          database.exec(`DELETE FROM room_memberships
                         WHERE room_id = 'room-light-task' AND actor_id = 'human-task-claimant'`);
        }
        database.close();
        const restartedClient = await createWorkerDatabaseClient({ databasePath });
        const restartedStore = createSqliteAuthoritativeStore(restartedClient, { clock: () => 4_000 });
        await expect(restartedStore.executeHuman(
          fixture.context(claimantId, `${scenario}-deliver`),
          { type: "light-task.transition", roomId: "room-light-task", payload: {
            taskId: created.aggregateId, action: "deliver",
          } },
        )).rejects.toMatchObject(scenario === "removed"
          ? { status: 403, code: "room_forbidden" }
          : { status: 409, code: "execution_conflict" });
        await restartedClient.close();
        const inspection = new DatabaseSync(databasePath, { readOnly: true });
        expect(inspection.prepare("SELECT status FROM light_tasks WHERE id = ?")
          .get(created.aggregateId)).toEqual({ status: "claimed" });
        inspection.close();
      }
    }, 15_000);
  });

  describe("Agent execution authoritative facts", () => {
    it("persists running and terminal transitions without duplicating the execution", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-agent-execution-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const running = {
        type: "agent.execution.transition",
        roomId: "room-facts",
        payload: {
          executionId: "execution-review-1",
          sourceMessageId: "message-human-source",
          toolName: "review.read",
          status: "running",
        },
      } as const;
      const runningContext = mintInternalAgentCommandContext({
        agentId: "agent-review",
        requestId: "execution-running-first",
        idempotencyKey: "execution-running-key",
      });
      const started = await fixture.authority.executeAgent(runningContext, running);
      await expect(
        fixture.authority.executeAgent(
          mintInternalAgentCommandContext({
            agentId: "agent-review",
            requestId: "execution-running-replay",
            idempotencyKey: "execution-running-key",
          }),
          running,
        ),
      ).resolves.toEqual(started);
      await expect(
        fixture.authority.executeAgent(
          mintInternalAgentCommandContext({
            agentId: "agent-review",
            requestId: "execution-running-conflict",
            idempotencyKey: "execution-running-key",
          }),
          { ...running, payload: { ...running.payload, toolName: "review.changed" } },
        ),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });

      const completed = {
        ...running,
        payload: { ...running.payload, status: "completed", result: "approved" },
      } as const;
      const completedContext = mintInternalAgentCommandContext({
        agentId: "agent-review",
        requestId: "execution-completed-first",
        idempotencyKey: "execution-completed-key",
      });
      const finished = await fixture.authority.executeAgent(completedContext, completed);
      await fixture.client.close();

      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
        clock: () => 9_000,
      });
      await expect(
        restartedAuthority.executeAgent(
          mintInternalAgentCommandContext({
            agentId: "agent-review",
            requestId: "execution-completed-restart",
            idempotencyKey: "execution-completed-key",
          }),
          completed,
        ),
      ).resolves.toEqual(finished);
      await restartedClient.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        `SELECT status, requester_actor_id AS requesterId, agent_id AS agentId,
                tool_name AS toolName, result_json AS result
         FROM agent_executions`,
      ).get()).toEqual({
        status: "completed",
        requesterId: "human-li",
        agentId: "agent-review",
        toolName: "review.read",
        result: "\"approved\"",
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.agent_execution.changed'",
      ).get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_executions").get())
        .toEqual({ count: 1 });
      database.close();
    });
  });

  describe("calibration authoritative facts", () => {
    it("derives the target Agent from its source message and rejects social emoji", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-calibration-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const command = {
        type: "calibration.record",
        roomId: "room-facts",
        payload: { sourceMessageId: "message-agent-source", emoji: "👎" },
      } as const;
      const context = {
        ...fixture.humanContext,
        requestId: "calibration-first",
        idempotencyKey: "calibration-key",
      };
      const first = await fixture.authority.executeHuman(context, command);
      await expect(
        fixture.authority.executeHuman(
          { ...context, requestId: "calibration-replay" },
          command,
        ),
      ).resolves.toEqual(first);
      const useful = {
        type: "calibration.record",
        roomId: "room-facts",
        payload: { sourceMessageId: "message-agent-source", feedback: "useful" },
      } as const;
      const usefulFirst = await fixture.authority.executeHuman(
        { ...context, requestId: "calibration-useful-1", idempotencyKey: "calibration-useful-1" },
        useful,
      );
      await expect(fixture.authority.executeHuman(
        { ...context, requestId: "calibration-useful-replay", idempotencyKey: "calibration-useful-1" },
        useful,
      )).resolves.toEqual(usefulFirst);
      await fixture.authority.executeHuman(
        { ...context, requestId: "calibration-useful-2", idempotencyKey: "calibration-useful-2" },
        useful,
      );
      await fixture.authority.executeHuman(
        { ...context, requestId: "calibration-useful-3", idempotencyKey: "calibration-useful-3" },
        useful,
      );
      await fixture.authority.executeHuman(
        { ...context, requestId: "calibration-not-needed", idempotencyKey: "calibration-not-needed" },
        { ...useful, payload: { ...useful.payload, feedback: "not_needed" } },
      );
      await fixture.authority.executeHuman(
        { ...context, requestId: "calibration-followup", idempotencyKey: "calibration-followup" },
        {
          type: "message.send",
          roomId: "room-facts",
          payload: {
            id: "message-after-calibration",
            roomId: "room-facts",
            body: "review complete",
            sentAt: "2026-08-10T13:03:00.000Z",
          },
        },
      );
      await fixture.client.executeRuntime({
        type: "runtime.cancel-for-human-fence",
        sourceHumanMessageId: "message-after-calibration",
        now: 8_100,
      });
      await fixture.client.executeRuntime({
        type: "runtime.create-route-after-human-fence",
        sourceHumanMessageId: "message-after-calibration",
        now: 8_101,
      });
      await expect(
        fixture.authority.executeHuman(
          { ...context, requestId: "calibration-conflict" },
          { ...command, payload: { ...command.payload, emoji: "👍" } },
        ),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      await expect(
        fixture.authority.executeHuman(
          { ...context, requestId: "calibration-social", idempotencyKey: "calibration-social" },
          { ...command, payload: { ...command.payload, emoji: "❤️" } } as never,
        ),
      ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
      await expect(
        fixture.authority.executeHuman(
          { ...context, requestId: "calibration-human", idempotencyKey: "calibration-human" },
          { ...command, payload: { sourceMessageId: "message-human-source", emoji: "👍" } },
        ),
      ).rejects.toMatchObject({ status: 400, code: "calibration_source_invalid" });
      await fixture.client.close();

      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
        clock: () => 9_000,
      });
      await expect(
        restartedAuthority.executeHuman(
          { ...context, requestId: "calibration-restart" },
          command,
        ),
      ).resolves.toEqual(first);
      await restartedClient.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        `SELECT actor_id AS actorId, agent_id AS agentId,
                source_message_id AS sourceMessageId, signal
         FROM calibration_signals`,
      ).get()).toEqual({
        actorId: "human-li",
        agentId: "agent-review",
        sourceMessageId: "message-agent-source",
        signal: "👎",
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.calibration.recorded'",
      ).get()).toEqual({ count: 5 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM calibration_signals").get())
        .toEqual({ count: 1 });
      expect(database.prepare(
        `SELECT kind, weight FROM route_calibration_facts ORDER BY rowid`,
      ).all()).toEqual([
        { kind: "thumbs_down", weight: -1 },
        { kind: "useful", weight: 2 },
        { kind: "useful", weight: 2 },
        { kind: "useful", weight: 2 },
        { kind: "not_needed", weight: -2 },
      ]);
      expect(database.prepare(
        `SELECT score FROM route_calibration_scores WHERE agent_id = 'agent-review'`,
      ).get()).toEqual({ score: 2 });
      expect(database.prepare(
        `SELECT snapshot.calibration_score AS calibrationScore
         FROM route_job_agents AS snapshot
         JOIN route_jobs AS job ON job.id = snapshot.route_job_id
         WHERE job.source_message_id = 'message-after-calibration'`,
      ).get()).toEqual({ calibrationScore: 2 });
      database.close();
    });
  });

  describe("accepted command four-quadrant matrix", () => {
    const cases: readonly CommandMatrixCase[] = [
      humanMatrixCase(
        "room.create",
        "room.created",
        "SELECT COUNT(*) AS count FROM rooms WHERE name = 'Matrix Created'",
        () => ({ type: "room.create", payload: { name: "Matrix Created" } }),
        () => ({ type: "room.create", payload: { name: "Matrix Changed" } }),
        "owner",
        1,
        ["room", "principal"],
      ),
      humanMatrixCase(
        "room.rename",
        "room.renamed",
        "SELECT COUNT(*) AS count FROM rooms WHERE id = 'room-matrix' AND name = 'Matrix Renamed'",
        ({ roomId }) => ({ type: "room.rename", roomId, payload: { name: "Matrix Renamed" } }),
        ({ roomId }) => ({ type: "room.rename", roomId, payload: { name: "Matrix Changed" } }),
        "owner",
        1,
        ["room", "principal", "principal"],
      ),
      humanMatrixCase(
        "human.invitation.issue",
        "human.invitation.issued",
        "SELECT COUNT(*) AS count FROM room_invitations WHERE invitee_actor_id = 'human-alternate'",
        ({ roomId }) => ({
          type: "human.invitation.issue", roomId, payload: { inviteeActorId: "human-alternate" },
        }),
        ({ roomId }) => ({
          type: "human.invitation.issue", roomId, payload: { inviteeActorId: "human-invitee" },
        }),
      ),
      humanMatrixCase(
        "human.invitation.decide",
        "human.invitation.rejected",
        "SELECT COUNT(*) AS count FROM room_invitations WHERE id = 'matrix-decision-invitation' AND status = 'rejected'",
        () => ({
          type: "human.invitation.decide",
          payload: { token: "matrix-decision-token", decision: "reject" },
        }),
        () => ({
          type: "human.invitation.decide",
          payload: { token: "matrix-decision-token", decision: "accept" },
        }),
        "invitee",
      ),
      humanMatrixCase(
        "agent.configure",
        "agent.configured",
        "SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'agent-review' AND participation = 'active'",
        ({ roomId }) => ({
          type: "agent.configure", roomId,
          payload: { agentId: "agent-review", participation: "active", toolPermissions: ["review.read"] },
        }),
        ({ roomId }) => ({
          type: "agent.configure", roomId,
          payload: { agentId: "agent-review", participation: "on-mention", toolPermissions: ["review.read"] },
        }),
        "owner",
        1,
        ["room", null],
      ),
      humanMatrixCase(
        "room.member.role.set",
        "room.governance.changed",
        "SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'human-chen' AND role = 'admin'",
        ({ roomId }) => ({
          type: "room.member.role.set", roomId,
          payload: { targetActorId: "human-chen", role: "admin", expectedGovernanceRevision: 1 },
        }),
        ({ roomId }) => ({
          type: "room.member.role.set", roomId,
          payload: { targetActorId: "human-chen", role: "member", expectedGovernanceRevision: 1 },
        }),
        "owner",
        1,
        ["room", "principal"],
      ),
      humanMatrixCase(
        "room.ownership.transfer",
        "room.governance.changed",
        "SELECT COUNT(*) AS count FROM rooms WHERE owner_actor_id = 'human-chen' AND governance_revision = 2",
        ({ roomId }) => ({
          type: "room.ownership.transfer", roomId,
          payload: { targetActorId: "human-chen", expectedGovernanceRevision: 1 },
        }),
        ({ roomId }) => ({
          type: "room.ownership.transfer", roomId,
          payload: { targetActorId: "human-invitee", expectedGovernanceRevision: 1 },
        }),
        "owner",
        1,
        ["room", "principal", "principal"],
      ),
      humanMatrixCase(
        "human.message.send",
        "room.message.accepted",
        "SELECT COUNT(*) AS count FROM messages WHERE id = 'matrix-human-message'",
        ({ roomId }) => ({
          type: "message.send", roomId,
          payload: { id: "matrix-human-message", roomId, body: "human matrix body", sentAt: "2026-08-10T14:10:00.000Z" },
        }),
        ({ roomId }) => ({
          type: "message.send", roomId,
          payload: { id: "matrix-human-message", roomId, body: "human changed body", sentAt: "2026-08-10T14:10:00.000Z" },
        }),
      ),
      agentMatrixCase(
        "agent.message.send",
        "room.message.accepted",
        "SELECT COUNT(*) AS count FROM messages WHERE id = 'matrix-agent-message'",
        ({ roomId }) => ({
          type: "message.send", roomId,
          payload: { id: "matrix-agent-message", roomId, body: "Agent matrix body", sentAt: "2026-08-10T14:11:00.000Z" },
        }),
        ({ roomId }) => ({
          type: "message.send", roomId,
          payload: { id: "matrix-agent-message", roomId, body: "Agent changed body", sentAt: "2026-08-10T14:11:00.000Z" },
        }),
      ),
      humanMatrixCase(
        "human.read.record",
        "room.human_read.recorded",
        "SELECT COUNT(*) AS count FROM human_read_receipts WHERE message_id = 'matrix-human-source'",
        ({ roomId }) => ({ type: "human.read.record", roomId, payload: { messageId: "matrix-human-source" } }),
        ({ roomId }) => ({ type: "human.read.record", roomId, payload: { messageId: "matrix-agent-source" } }),
      ),
      agentMatrixCase(
        "agent.judgment.record",
        "room.agent_judgment.recorded",
        "SELECT COUNT(*) AS count FROM agent_judgments WHERE message_id = 'matrix-human-source'",
        ({ roomId }) => ({
          type: "agent.judgment.record", roomId,
          payload: { messageId: "matrix-human-source", outcome: "will_respond", reason: "matrix reason" },
        }),
        ({ roomId }) => ({
          type: "agent.judgment.record", roomId,
          payload: { messageId: "matrix-human-source", outcome: "suppressed", reason: "matrix changed reason" },
        }),
      ),
      humanMatrixCase(
        "open-item.create",
        "room.open_item.changed",
        "SELECT COUNT(*) AS count FROM open_items WHERE body = 'matrix open item'",
        ({ roomId }) => ({
          type: "open-item.create", roomId,
          payload: { creationKind: "manual_unfinished", sourceMessageId: "matrix-human-source", targetActorId: "human-chen", content: "matrix open item" },
        }),
        ({ roomId }) => ({
          type: "open-item.create", roomId,
          payload: { creationKind: "manual_unfinished", sourceMessageId: "matrix-human-source", targetActorId: "human-chen", content: "matrix changed item" },
        }),
      ),
      agentMatrixCase(
        "open-item.transition",
        "room.open_item.changed",
        "SELECT COUNT(*) AS count FROM open_items WHERE id = 'matrix-open-existing' AND status = 'answered'",
        ({ roomId }) => ({
          type: "open-item.transition", roomId,
          payload: { itemId: "matrix-open-existing", action: "answer" },
        }),
        ({ roomId }) => ({
          type: "open-item.transition", roomId,
          payload: { itemId: "matrix-open-existing", action: "defer", reason: "matrix changed reason" },
        }),
      ),
      agentMatrixCase(
        "agent.execution.transition",
        "room.agent_execution.changed",
        "SELECT COUNT(*) AS count FROM agent_executions WHERE id = 'matrix-execution' AND status = 'running'",
        ({ roomId }) => ({
          type: "agent.execution.transition", roomId,
          payload: {
            executionId: "matrix-execution", sourceMessageId: "matrix-human-source",
            toolName: "review.read", status: "running",
          },
        }),
        ({ roomId }) => ({
          type: "agent.execution.transition", roomId,
          payload: {
            executionId: "matrix-execution", sourceMessageId: "matrix-agent-source",
            toolName: "review.read", status: "running",
          },
        }),
      ),
      humanMatrixCase(
        "calibration.record",
        "room.calibration.recorded",
        "SELECT COUNT(*) AS count FROM calibration_signals WHERE source_message_id = 'matrix-agent-source' AND signal = '👎'",
        ({ roomId }) => ({
          type: "calibration.record", roomId,
          payload: { sourceMessageId: "matrix-agent-source", emoji: "👎" },
        }),
        ({ roomId }) => ({
          type: "calibration.record", roomId,
          payload: { sourceMessageId: "matrix-agent-source", emoji: "👍" },
        }),
      ),
    ];

    it.each(cases)(
      "$label: concurrent/sequential/restart replay and changed-payload conflict",
      async (testCase) => {
        const directory = await mkdtemp(join(tmpdir(), "native-im-command-matrix-"));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "authority.sqlite");
        const fixture = await createCommandMatrixFixture(databasePath);

        const [first, concurrentReplay] = await Promise.all([
          testCase.execute(fixture.store, fixture.contexts, "exact", "first"),
          testCase.execute(fixture.store, fixture.contexts, "exact", "concurrent"),
        ]);
        expect(concurrentReplay).toEqual(first);
        await expect(
          testCase.execute(fixture.store, fixture.contexts, "exact", "sequential"),
        ).resolves.toEqual(first);
        await fixture.client.close();

        const restartedClient = await createWorkerDatabaseClient({ databasePath });
        const restartedStore = createSqliteAuthoritativeStore(restartedClient, {
          clock: () => 9_000,
          invitationSecretProtector: createAesGcmInvitationSecretProtector(new Uint8Array(32).fill(47)),
          invitationTokenFactory: () => "matrix-issued-token-after-restart",
        });
        await expect(
          testCase.execute(restartedStore, fixture.contexts, "exact", "restart"),
        ).resolves.toEqual(first);
        const beforeConflict = authoritativeCountSnapshot(databasePath);
        await expect(
          testCase.execute(restartedStore, fixture.contexts, "changed", "conflict"),
        ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
        await restartedClient.close();
        expect(authoritativeCountSnapshot(databasePath)).toEqual(beforeConflict);

        const database = new DatabaseSync(databasePath, { readOnly: true });
        expect(database.prepare(testCase.factSql).get()).toEqual({
          count: testCase.factCount ?? 1,
        });
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM events WHERE event_type = ?",
        ).get(testCase.eventType)).toEqual({ count: 1 });
        expect(database.prepare(
          `SELECT COUNT(*) AS count
           FROM outbox_deliveries AS delivery
           JOIN events AS event ON event.event_id = delivery.event_id
           WHERE event.event_type = ?`,
        ).get(testCase.eventType)).toEqual({ count: 1 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
          .toEqual({ count: 1 });
        expect(new Set(first.eventIds).size).toBe(first.eventIds.length);
        expect(testCase.deliveryTargets).toHaveLength(first.eventIds.length);
        for (const [index, eventId] of first.eventIds.entries()) {
          expect(database.prepare(
            "SELECT COUNT(*) AS count FROM events WHERE event_id = ?",
          ).get(eventId)).toEqual({ count: 1 });
          const deliveries = database.prepare(
            `SELECT target_kind AS targetKind, target_id AS targetId
             FROM outbox_deliveries WHERE event_id = ?`,
          ).all(eventId);
          const expectedTarget = testCase.deliveryTargets[index];
          if (expectedTarget === null) {
            expect(deliveries).toEqual([]);
          } else {
            expect(deliveries).toEqual([
              { targetKind: expectedTarget, targetId: expect.stringMatching(/\S/) },
            ]);
          }
        }
        const eventPlaceholders = first.eventIds.map(() => "?").join(", ");
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM events WHERE event_id IN (${eventPlaceholders})`,
        ).get(...first.eventIds)).toEqual({ count: first.eventIds.length });
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM outbox_deliveries
           WHERE event_id IN (${eventPlaceholders})`,
        ).get(...first.eventIds)).toEqual({
          count: testCase.deliveryTargets.filter((target) => target !== null).length,
        });
        database.close();
      },
    );
  });

  describe("room governance idempotency", () => {
    it.each([
      {
        label: "room.rename",
        eventType: "room.renamed",
        command(roomId: string) {
          return { type: "room.rename", roomId, payload: { name: "Renamed" } } as const;
        },
        changed(roomId: string) {
          return { type: "room.rename", roomId, payload: { name: "Changed" } } as const;
        },
        factSql: "SELECT COUNT(*) AS count FROM rooms WHERE name = 'Renamed'",
        eventCount: 2,
      },
      {
        label: "agent.configure",
        eventType: "agent.configured",
        command(roomId: string) {
          return {
            type: "agent.configure",
            roomId,
            payload: {
              agentId: "agent-review",
              participation: "active",
              toolPermissions: ["review.read"],
            },
          } as const;
        },
        changed(roomId: string) {
          return {
            type: "agent.configure",
            roomId,
            payload: {
              agentId: "agent-review",
              participation: "on-mention",
              toolPermissions: ["review.read"],
            },
          } as const;
        },
        factSql:
          "SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'agent-review' AND participation = 'active' AND access_revision = 1",
        eventCount: 2,
      },
    ])("persists $label once and rejects a changed payload", async (testCase) => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-governance-command-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createRoomGovernanceFixture(databasePath);
      const context = {
        ...fixture.context,
        requestId: `${testCase.label}-first`,
        idempotencyKey: `${testCase.label}-key`,
      };
      const command = testCase.command(fixture.roomId);

      const first = await fixture.authority.executeHuman(context, command);
      const replay = await fixture.authority.executeHuman(
        { ...context, requestId: `${testCase.label}-replay` },
        command,
      );
      expect(replay).toEqual(first);
      expect(first.eventIds).toHaveLength(testCase.eventCount);
      await expect(
        fixture.authority.executeHuman(
          { ...context, requestId: `${testCase.label}-conflict` },
          testCase.changed(fixture.roomId),
        ),
      ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });

      await fixture.client.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(testCase.factSql).get()).toEqual({ count: 1 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = ?")
          .get(testCase.eventType),
      ).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
        .toEqual({ count: 2 });
      database.close();
    });

    it("writes joined and updated Agent identity events while unsafe removal fails closed", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-agent-identity-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createRoomGovernanceFixture(databasePath);
      const baseContext = {
        ...fixture.context,
        requestId: "agent-identity",
        idempotencyKey: "agent-identity-joined",
      };
      const configured = await fixture.authority.executeHuman(baseContext, {
        type: "agent.configure",
        roomId: fixture.roomId,
        payload: {
          agentId: "agent-review",
          participation: "active",
          toolPermissions: ["review.read"],
        },
      });
      const updated = await fixture.authority.executeHuman(
        { ...baseContext, requestId: "agent-updated", idempotencyKey: "agent-identity-updated" },
        {
          type: "agent.configure",
          roomId: fixture.roomId,
          payload: {
            agentId: "agent-review",
            participation: "on-mention",
            toolPermissions: ["review.read"],
          },
        },
      );
      const beforeRemove = authoritativeCountSnapshot(databasePath);
      await expect(fixture.authority.executeHuman(
        { ...baseContext, requestId: "agent-removed", idempotencyKey: "agent-identity-removed" },
        {
          type: "member.remove",
          roomId: fixture.roomId,
          payload: { targetActorId: "agent-review" },
        },
      )).rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
      expect(authoritativeCountSnapshot(databasePath)).toEqual(beforeRemove);
      expect(configured.eventIds).toHaveLength(2);
      expect(updated.eventIds).toHaveLength(2);
      await fixture.client.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      const identityEvents = database.prepare(
        `SELECT payload_json AS payload
         FROM events
         WHERE stream_kind = 'identity' AND stream_id = 'agent-review'
           AND event_type = 'identity.room-access.changed'
         ORDER BY stream_seq`,
      ).all().map((row) => JSON.parse(String(row.payload)));
      expect(identityEvents).toEqual([
        { roomId: fixture.roomId, change: "joined" },
        { roomId: fixture.roomId, change: "updated" },
      ]);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE target_kind = 'principal' AND target_id = 'agent-review'",
      ).get()).toEqual({ count: 0 });
      database.close();
    });

    it("requires closed archive CAS input and replays the production participant result", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-archive-command-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createRoomGovernanceFixture(databasePath);
      const context = {
        ...fixture.context,
        requestId: "archive-first",
        idempotencyKey: "archive-key",
      };
      const command = {
        type: "room.archive" as const,
        roomId: fixture.roomId,
        payload: { expectedGovernanceRevision: 1 },
      };

      const before = authoritativeCountSnapshot(databasePath);
      const archived = await fixture.authority.executeHumanGovernance(context, command);
      expect(archived).toMatchObject({
        governance: {
          roomId: fixture.roomId, lifecycle: "archived",
          governanceRevision: 2, archiveGeneration: 1,
        },
        replayed: false,
      });
      expect(archived.eventIds.length).toBeGreaterThanOrEqual(2);
      const afterArchive = authoritativeCountSnapshot(databasePath);
      expect(afterArchive.rooms).toBe(before.rooms);
      expect(afterArchive.room_audit).toBe(before.room_audit + 1);
      expect(afterArchive.idempotency_records).toBe(before.idempotency_records + 1);
      await expect(
        fixture.authority.executeHumanGovernance(
          { ...context, requestId: "archive-invalid" },
          {
            ...command,
            payload: { reason: "not part of the closed command" },
          } as never,
        ),
      ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
      expect(authoritativeCountSnapshot(databasePath)).toEqual(afterArchive);
      await fixture.client.close();

      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
        clock: () => 9_000,
      });
      await expect(restartedAuthority.executeHumanGovernance(
        { ...context, requestId: "archive-restart" }, command,
      )).resolves.toEqual({ ...archived, replayed: true });
      await expect(
        restartedAuthority.executeHumanGovernance(
          { ...context, requestId: "archive-other-scope", idempotencyKey: "archive-other-scope" },
          { ...command, roomId: `${fixture.roomId}-other` },
        ),
      ).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
      await restartedClient.close();

      expect(authoritativeCountSnapshot(databasePath)).toEqual(afterArchive);
    });
  });

  it("seals invitation replay state and returns the same token after a lost acknowledgement and restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-invitation-secret-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const key = new Uint8Array(32).fill(23);
    const protector = createAesGcmInvitationSecretProtector(key);
    let dropFirstAcknowledgement = true;
    const firstClient = await createWorkerDatabaseClient({ databasePath });
    const firstAuthority = createSqliteAuthoritativeStore(firstClient, {
      clock: () => 2_000,
      invitationSecretProtector: protector,
      invitationTokenFactory: () => "private-invitation-token",
      afterCommitHuman(command) {
        if (command.type === "human.invitation.issue" && dropFirstAcknowledgement) {
          dropFirstAcknowledgement = false;
          throw new Error("injected_ack_loss");
        }
      },
    });
    await firstAuthority.registerActors(invitationActors);
    const ownerAuth = createAuthenticationService({
      actors: invitationActorDirectory,
      identities: invitationIdentities,
      authority: firstAuthority,
      clock: () => 1_000,
      tokenFactory: tokenSequence("invite-owner-access", "invite-owner-refresh"),
    });
    const ownerIssued = await ownerAuth.login({
      accountId: "account-li",
      secret: "correct",
    });
    const ownerSession = await ownerAuth.authenticateSession(ownerIssued.accessToken);
    const ownerContext = {
      ...ownerSession,
      kind: "human" as const,
      requestId: "invite-room-create",
      idempotencyKey: "invite-room-create-key",
    };
    const created = await firstAuthority.executeHuman(
      ownerContext,
      { type: "room.create", payload: { name: "Invitations" } },
    );
    const issueCommand = {
      type: "human.invitation.issue",
      roomId: created.aggregateId,
      payload: { inviteeActorId: "human-chen" },
    } as const;
    const issueContext = {
      ...ownerContext,
      requestId: "invite-issue-first",
      idempotencyKey: "invite-issue-key",
    };

    await expect(firstAuthority.executeHuman(issueContext, issueCommand)).rejects.toThrow(
      "injected_ack_loss",
    );
    await firstClient.close();

    const restartedClient = await createWorkerDatabaseClient({ databasePath });
    const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
      clock: () => 9_000,
      invitationSecretProtector: protector,
      invitationTokenFactory: () => "different-retry-candidate",
    });
    const replay = await restartedAuthority.executeHuman(
      { ...issueContext, requestId: "invite-issue-restart" },
      issueCommand,
    );
    expect(replay.eventIds).toHaveLength(1);
    expect(replay.result).toMatchObject({
      invitation: {
        invitationId: expect.any(String),
        roomId: created.aggregateId,
        inviteeActorId: "human-chen",
        token: "private-invitation-token",
      },
    });
    await restartedClient.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM room_invitations").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'human.invitation.issued'").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 2 });
    database.close();

    for (const fileName of await readdir(directory)) {
      if (!fileName.startsWith("authority.sqlite")) {
        continue;
      }
      const bytes = await readFile(join(directory, fileName));
      expect(bytes.includes(Buffer.from("private-invitation-token", "utf8"))).toBe(false);
    }

    const wrongKeyClient = await createWorkerDatabaseClient({ databasePath });
    const wrongKeyAuthority = createSqliteAuthoritativeStore(wrongKeyClient, {
      clock: () => 10_000,
      invitationSecretProtector: createAesGcmInvitationSecretProtector(
        new Uint8Array(32).fill(24),
      ),
      invitationTokenFactory: () => "unused-wrong-key-candidate",
    });
    await expect(
      wrongKeyAuthority.executeHuman(
        { ...issueContext, requestId: "invite-issue-wrong-key" },
        issueCommand,
      ),
    ).rejects.toMatchObject({ status: 503, code: "invitation_secret_unavailable" });
    await wrongKeyClient.close();
  });

  it("persists invitation acceptance and CAS role change while unsafe removal fails closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-member-governance-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client, {
      clock: () => 2_000,
      invitationSecretProtector: createAesGcmInvitationSecretProtector(
        new Uint8Array(32).fill(31),
      ),
      invitationTokenFactory: () => "member-governance-token",
    });
    await authority.registerActors(invitationActors);
    const ownerAuth = createAuthenticationService({
      actors: invitationActorDirectory,
      identities: invitationIdentities,
      authority,
      clock: () => 1_000,
      tokenFactory: tokenSequence("member-owner-access", "member-owner-refresh"),
    });
    const inviteeAuth = createAuthenticationService({
      actors: invitationActorDirectory,
      identities: invitationIdentities,
      authority,
      clock: () => 1_000,
      tokenFactory: tokenSequence("member-chen-access", "member-chen-refresh"),
    });
    const ownerIssued = await ownerAuth.login({ accountId: "account-li", secret: "correct" });
    const inviteeIssued = await inviteeAuth.login({ accountId: "account-chen", secret: "correct" });
    const ownerSession = await ownerAuth.authenticateSession(ownerIssued.accessToken);
    const inviteeSession = await inviteeAuth.authenticateSession(inviteeIssued.accessToken);
    const ownerContext = {
      ...ownerSession,
      kind: "human" as const,
      requestId: "member-room-create",
      idempotencyKey: "member-room-create-key",
    };
    const created = await authority.executeHuman(
      ownerContext,
      { type: "room.create", payload: { name: "Members" } },
    );
    const issuedInvitation = await authority.executeHuman(
      {
        ...ownerContext,
        requestId: "member-invite-issue",
        idempotencyKey: "member-invite-issue-key",
      },
      {
        type: "human.invitation.issue",
        roomId: created.aggregateId,
        payload: { inviteeActorId: "human-chen" },
      },
    );
    const invitationToken = invitationTokenFrom(issuedInvitation);
    const decideContext = {
      ...inviteeSession,
      kind: "human" as const,
      requestId: "member-invite-accept",
      idempotencyKey: "member-invite-decision-key",
    };
    const acceptCommand = {
      type: "human.invitation.decide",
      payload: { token: invitationToken, decision: "accept" },
    } as const;

    const accepted = await authority.executeHuman(decideContext, acceptCommand);
    expect(
      await authority.executeHuman(
        { ...decideContext, requestId: "member-invite-accept-replay" },
        acceptCommand,
      ),
    ).toEqual(accepted);
    expect(accepted.eventIds).toHaveLength(2);
    await expect(
      authority.executeHuman(
        { ...decideContext, requestId: "member-invite-decision-conflict" },
        { ...acceptCommand, payload: { ...acceptCommand.payload, decision: "reject" } },
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });

    const roleContext = {
      ...ownerContext,
      requestId: "member-role-admin",
      idempotencyKey: "member-role-key",
    };
    const roleCommand = {
      type: "room.member.role.set",
      roomId: created.aggregateId,
      payload: { targetActorId: "human-chen", role: "admin", expectedGovernanceRevision: 1 },
    } as const;
    const roleChanged = await authority.executeHuman(roleContext, roleCommand);
    expect(
      await authority.executeHuman(
        { ...roleContext, requestId: "member-role-replay" },
        roleCommand,
      ),
    ).toEqual(roleChanged);
    expect(roleChanged.eventIds).toHaveLength(2);
    await expect(
      authority.executeHuman(
        { ...roleContext, requestId: "member-role-conflict" },
        { ...roleCommand, payload: { ...roleCommand.payload, role: "member" } },
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });

    const inviteeMessage = {
      type: "message.send",
      roomId: created.aggregateId,
      payload: {
        id: "message-by-removed-member",
        roomId: created.aggregateId,
        body: "retain this authored message",
        sentAt: "2026-08-10T12:30:00.000Z",
      },
    } as const;
    await authority.executeHuman(
      {
        ...inviteeSession,
        kind: "human",
        requestId: "member-message",
        idempotencyKey: "member-message-key",
      },
      inviteeMessage,
    );

    const removeContext = {
      ...ownerContext,
      requestId: "member-remove",
      idempotencyKey: "member-remove-key",
    };
    const removeCommand = {
      type: "member.remove",
      roomId: created.aggregateId,
      payload: { targetActorId: "human-chen" },
    } as const;
    const beforeRemove = authoritativeCountSnapshot(databasePath);
    await expect(authority.executeHuman(removeContext, removeCommand))
      .rejects.toMatchObject({ status: 503, code: "dependency_unavailable" });
    expect(authoritativeCountSnapshot(databasePath)).toEqual(beforeRemove);
    await client.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'human-chen'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE id = 'message-by-removed-member'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type IN ('human.invitation.accepted', 'room.governance.changed')")
        .get(),
    ).toEqual({ count: 2 });
    database.close();
  });

  it("prevents direct owner removal and preserves exact message replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-replay-after-removal-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createHumanCommandFixture(databasePath);
    await fixture.authority.executeHuman(fixture.context, messageCommand);
    await fixture.client.close();

    const database = new DatabaseSync(databasePath);
    expect(() => database.prepare(
      "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
    ).run(messageCommand.roomId, fixture.context.principal.actorId))
      .toThrow("current room owner cannot be removed");
    database.close();

    const restartedClient = await createWorkerDatabaseClient({ databasePath });
    const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
      clock: () => 9_000,
    });
    await expect(restartedAuthority.executeHuman(
      { ...fixture.context, requestId: "message-replay-after-removal" }, messageCommand,
    )).resolves.toMatchObject({ aggregateId: messageCommand.payload.id });
    await restartedClient.close();

    expect(readMessageCommandCounts(databasePath)).toEqual({
      messages: 1,
      events: 1,
      outbox: 1,
      idempotency: 1,
    });
  });

  it("reads, authorizes, retries, and marks durable outbox deliveries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-outbox-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createRoomGovernanceFixture(databasePath);
    const candidate = {
      connectionId: "connection-owner",
      principal: fixture.context.principal,
      sessionId: fixture.context.sessionId,
      sessionFamilyId: fixture.context.sessionFamilyId,
      credentialGeneration: 1,
    };

    const initial = await fixture.authority.listPendingOutbox(10);
    expect(initial.map((item) => item.targetKind).sort()).toEqual(["principal", "room"]);
    expect(initial.every((item) => item.event.eventId === item.eventId)).toBe(true);
    await fixture.client.close();

    const membershipDatabase = new DatabaseSync(databasePath);
    membershipDatabase.prepare(
      `UPDATE rooms SET status = 'archived', archived_at = ?, archive_generation = 1
       WHERE id = ?`,
    ).run("2026-08-18T00:00:00.000Z", fixture.roomId);
    membershipDatabase.prepare(
      `INSERT INTO room_message_archive_gates (room_id, gate_generation, blocked_at)
       VALUES (?, 1, ?)`,
    ).run(fixture.roomId, "2026-08-18T00:00:00.000Z");
    membershipDatabase.close();

    const restartedClient = await createWorkerDatabaseClient({ databasePath });
    const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
      clock: () => 3_000,
    });
    const replayed = await restartedAuthority.listPendingOutbox(10);
    expect(replayed).toEqual(initial);
    await expect(
      restartedAuthority.authorizeOutboxCandidate(
        replayed.find((item) => item.targetKind === "room")!,
        candidate,
      ),
    ).resolves.toBe(false);
    await expect(
      restartedAuthority.authorizeOutboxCandidate(
        replayed.find((item) => item.targetKind === "principal")!,
        candidate,
      ),
    ).resolves.toBe(true);

    await restartedAuthority.revoke(candidate.sessionId, 3_000);
    const afterRevoke = await restartedAuthority.listPendingOutbox(10);
    const terminal = afterRevoke.find((item) => item.targetKind === "session-family")!;
    await expect(
      restartedAuthority.authorizeOutboxCandidate(terminal, candidate),
    ).resolves.toBe(true);
    await expect(
      restartedAuthority.authorizeOutboxCandidate(
        initial.find((item) => item.targetKind === "principal")!,
        candidate,
      ),
    ).resolves.toBe(false);

    const retry = initial.find((item) => item.targetKind === "room")!;
    await restartedAuthority.markOutboxFailed(retry.deliveryId, "closed");
    expect(
      (await restartedAuthority.listPendingOutbox(10))
        .find((item) => item.deliveryId === retry.deliveryId)?.attempts,
    ).toBe(1);
    await restartedClient.close();

    const failedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    expect(failedDatabase.prepare(
      `SELECT attempts, last_error AS lastError, status
       FROM outbox_deliveries WHERE id = ?`,
    ).get(retry.deliveryId)).toEqual({ attempts: 1, lastError: "closed", status: "pending" });
    failedDatabase.close();

    const finalClient = await createWorkerDatabaseClient({ databasePath });
    const finalAuthority = createSqliteAuthoritativeStore(finalClient, { clock: () => 9_000 });
    for (const item of await finalAuthority.listPendingOutbox(10)) {
      await finalClient.markOutboxDispatched(item.deliveryId, 9_000);
      await finalClient.markOutboxDispatched(item.deliveryId, 10_000);
    }
    await expect(finalAuthority.listPendingOutbox(10)).resolves.toEqual([]);

    const dispatchedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    expect(dispatchedDatabase.prepare(
      `SELECT attempts, delivered_at AS deliveredAt, last_error AS lastError, status
       FROM outbox_deliveries WHERE id = ?`,
    ).get(retry.deliveryId)).toEqual({
      attempts: 1,
      deliveredAt: "1970-01-01T00:00:09.000Z",
      lastError: null,
      status: "dispatched",
    });
    dispatchedDatabase.close();

    await expect(
      finalClient.markOutboxDispatched("delivery-missing", 10_000),
    ).rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
    await expect(finalClient.close()).rejects.toMatchObject({
      status: 503,
      code: "storage_unavailable",
    });
  });

  it("fails closed when a session-family delivery does not join to a revoked-session event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-outbox-pairing-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createRoomGovernanceFixture(databasePath);
    await fixture.client.close();

    const database = new DatabaseSync(databasePath);
    database.prepare(
      `UPDATE outbox_deliveries
       SET target_kind = 'session-family', target_id = 'family-corrupt'
       WHERE target_kind = 'principal'`,
    ).run();
    database.close();

    const restartedClient = await createWorkerDatabaseClient({ databasePath });
    const restartedAuthority = createSqliteAuthoritativeStore(restartedClient);
    await expect(restartedAuthority.listPendingOutbox(10)).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    await restartedClient.close().catch(() => undefined);
  });

  it("authenticates the same session context after a worker restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-session-authority-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");

    const firstClient = await createWorkerDatabaseClient({ databasePath });
    const firstAuthority = createSqliteAuthoritativeStore(firstClient);
    await firstAuthority.registerActors(actors);
    const firstAuth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority: firstAuthority,
      clock: () => 1_000,
      tokenFactory: tokenSequence("access-token", "refresh-token"),
    });

    const issued = await firstAuth.login({ accountId: "account-li", secret: "correct" });
    const authenticated = await firstAuth.authenticateSession(issued.accessToken);
    expect(authenticated).toMatchObject({
      principal: { accountId: "account-li", actorId: "human-li" },
      sessionFamilyId: expect.any(String),
      sessionId: expect.any(String),
    });
    const detachedAuthenticate = firstAuth.authenticate;
    await expect(detachedAuthenticate(issued.accessToken)).resolves.toEqual(
      authenticated.principal,
    );
    await firstClient.close();

    const persisted = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      persisted
        .prepare(
          `SELECT
             access_token_hash AS accessTokenHash,
             refresh_token_hash AS refreshTokenHash
           FROM sessions`,
        )
        .get(),
    ).toEqual({
      accessTokenHash: tokenHash("access-token"),
      refreshTokenHash: tokenHash("refresh-token"),
    });
    persisted.close();

    const restartedClient = await createWorkerDatabaseClient({ databasePath });
    const restartedAuthority = createSqliteAuthoritativeStore(restartedClient);
    const restartedAuth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority: restartedAuthority,
      clock: () => 1_001,
    });

    await expect(
      restartedAuth.authenticateSession(issued.accessToken),
    ).resolves.toEqual(authenticated);
    await restartedClient.close();
  });

  it("authenticates a session imported from the T-0039 JSON authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-imported-session-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const sessionFilePath = join(directory, "sessions.json");
    const roomFilePath = join(directory, "rooms.json");
    const messageFilePath = join(directory, "messages.jsonl");
    await writeFile(
      sessionFilePath,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            familyId: tokenHash("legacy-family"),
            accountId: "account-li",
            actorId: "human-li",
            accessTokenHash: tokenHash("legacy-access"),
            refreshTokenHash: tokenHash("legacy-refresh"),
            accessExpiresAt: 10_000,
            refreshExpiresAt: 20_000,
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      roomFilePath,
      JSON.stringify({
        version: 1,
        actors: [actors[0]],
        rooms: [],
        invitations: [],
        audit: [],
      }),
      "utf8",
    );
    await writeFile(messageFilePath, "", "utf8");

    const client = await createWorkerDatabaseClient({ databasePath });
    await client.importLegacyState({ sessionFilePath, roomFilePath, messageFilePath });
    const authority = createSqliteAuthoritativeStore(client);
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority,
      clock: () => 1_000,
    });

    await expect(auth.authenticateSession("legacy-access")).resolves.toEqual({
      sessionId: tokenHash("legacy-access"),
      sessionFamilyId: tokenHash("legacy-family"),
      principal: { accountId: "account-li", actorId: "human-li" },
    });
    await client.close();
  });

  it("registers actors and identity events once and rejects changed actor payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-actor-authority-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client);

    await authority.registerActors(actors);
    await authority.registerActors(actors);
    await expect(authority.registerActors([
      actors[0],
      {
        ...actors[1],
        displayName: "Mutable catalog name",
        readiness: "paused",
        toolPermissions: [],
      },
    ])).resolves.toBeUndefined();
    await expect(
      authority.registerActors([
        { ...actors[0], displayName: "Changed Lionel" },
        actors[1],
      ]),
    ).rejects.toMatchObject({ code: "actor_conflict" });
    await client.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM actors").get()).toEqual({
      count: 2,
    });
    expect(database.prepare(`
      SELECT profile.actor_id AS actorId, profile.display_name AS displayName,
             profile.status, profile.capability_ceiling_json AS capabilities,
             profile.tool_ceiling_json AS tools, profile.source_kind AS sourceKind,
             revision.operation
      FROM agent_profiles AS profile
      JOIN agent_profile_revisions AS revision
        ON revision.profile_id = profile.id AND revision.revision = profile.revision
      WHERE profile.actor_id = 'agent-review'
    `).get()).toEqual({
      actorId: "agent-review",
      displayName: "Reviewer",
      status: "disabled",
      capabilities: "[]",
      tools: "[]",
      sourceKind: "static_bootstrap",
      operation: "static_bootstrap",
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM events
           WHERE event_type = 'identity.actor.registered'`,
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(database.prepare(
      `SELECT payload_json AS payloadJson FROM events
       WHERE stream_kind = 'identity' AND stream_id = 'human-li'
         AND event_type = 'identity.actor.registered'`,
    ).get()).toEqual({
      payloadJson:
        '{"actor":{"displayName":"Lionel","id":"human-li","kind":"human","reachability":"online"}}',
    });
    database.close();
  });

  it("derives the same canonical registration event ID across Actor property orderings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-actor-canonical-id-"));
    temporaryDirectories.push(directory);
    const firstPath = join(directory, "first.sqlite");
    const secondPath = join(directory, "second.sqlite");
    const firstClient = await createWorkerDatabaseClient({ databasePath: firstPath });
    const secondClient = await createWorkerDatabaseClient({ databasePath: secondPath });
    const firstAuthority = createSqliteAuthoritativeStore(firstClient);
    const secondAuthority = createSqliteAuthoritativeStore(secondClient);

    await firstAuthority.registerActors([{
      id: "human-canonical",
      kind: "human",
      displayName: "Canonical Human",
      reachability: "online",
    }]);
    await secondAuthority.registerActors([{
      reachability: "online",
      displayName: "Canonical Human",
      kind: "human",
      id: "human-canonical",
    }]);
    await firstClient.close();
    await secondClient.close();

    const readIdentityEvent = (databasePath: string): unknown => {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return database.prepare(
          `SELECT event_id AS eventId, payload_json AS payloadJson
           FROM events WHERE event_type = 'identity.actor.registered'`,
        ).get();
      } finally {
        database.close();
      }
    };
    expect(readIdentityEvent(secondPath)).toEqual(readIdentityEvent(firstPath));
  });

  it("rotates within one family and revokes the family on refresh replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-rotate-authority-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client);
    await authority.registerActors(actors);
    let now = 1_000;
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority,
      clock: () => now,
      tokenFactory: tokenSequence(
        "access-one",
        "refresh-one",
        "access-two",
        "refresh-two",
        "access-independent",
        "refresh-independent",
      ),
    });

    const issued = await auth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "rotate-install", label: "Rotation device", platform: "macos" },
    );
    const firstContext = await auth.authenticateSession(issued.accessToken);
    await expect(
      auth.refresh(issued.refreshToken, {
        accountId: "account-other",
        actorId: "human-other",
      }),
    ).rejects.toMatchObject({ status: 403, code: "identity_forbidden" });

    now = 2_000;
    const rotated = await auth.refresh(issued.refreshToken, firstContext.principal);
    const rotatedContext = await auth.authenticateSession(rotated.accessToken);
    expect(rotated.sessionId).toBe(issued.sessionId);
    expect(rotatedContext.sessionFamilyId).toBe(firstContext.sessionFamilyId);
    expect(rotatedContext.sessionId).not.toBe(firstContext.sessionId);
    await expect(auth.listSessions(rotated.accessToken)).resolves.toEqual([{
      id: issued.sessionId,
      deviceLabel: "Rotation device",
      platform: "macos",
      createdAt: new Date(1_000).toISOString(),
      refreshExpiresAt: rotated.refreshExpiresAt,
      current: true,
    }]);

    const independent = await auth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "independent-install", label: "Independent device", platform: "linux" },
    );
    const independentContext = await auth.authenticateSession(independent.accessToken);
    const replayLease = await client.acquireStreamingRepair(
      rotatedContext,
      { kind: "catalog", principalId: "human-li" },
      now,
    );
    await client.registerStreamingRepair(
      replayLease.snapshotId,
      "refresh-replay-checksum",
      1,
      now,
    );

    now = 3_000;
    await expect(auth.refresh(rotated.refreshToken, {
      accountId: "foreign-account",
      actorId: "foreign-human",
    })).rejects.toMatchObject({
      status: 403,
      code: "identity_forbidden",
    });
    await expect(client.authorizeStreamingRepairPage(
      rotatedContext,
      replayLease.snapshotId,
      0,
      now,
    )).resolves.toMatchObject({ snapshotId: replayLease.snapshotId });
    await expect(auth.refresh(issued.refreshToken)).rejects.toMatchObject({
      status: 403,
      code: "session_revoked",
    });
    await expect(client.authorizeStreamingRepairPage(
      rotatedContext,
      replayLease.snapshotId,
      0,
      now,
    )).rejects.toMatchObject({
      status: 403,
      code: "snapshot_family_revoked",
    });
    const independentLease = await client.acquireStreamingRepair(
      independentContext,
      { kind: "catalog", principalId: "human-li" },
      now,
    );
    expect(independentLease.sessionFamilyId).toBe(independentContext.sessionFamilyId);
    await expect(auth.authenticateSession(rotated.accessToken)).rejects.toMatchObject({
      status: 403,
      code: "session_revoked",
    });
    await client.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      database
        .prepare(
          `SELECT event_type AS eventType, COUNT(*) AS count
           FROM events
           WHERE event_type LIKE 'identity.session.%'
           GROUP BY event_type
           ORDER BY event_type`,
        )
        .all(),
    ).toEqual([
      { eventType: "identity.session.issued", count: 2 },
      { eventType: "identity.session.revoked", count: 1 },
      { eventType: "identity.session.rotated", count: 1 },
    ]);
    expect(
      database
        .prepare(
          `SELECT
             target_kind AS targetKind,
             target_id AS targetId,
             stream_seq AS streamSeq,
             status,
             attempts
           FROM outbox_deliveries`,
        )
        .all(),
    ).toEqual([
      {
        targetKind: "session-family",
        targetId: firstContext.sessionFamilyId,
        streamSeq: 5,
        status: "pending",
        attempts: 0,
      },
    ]);
    database.close();
  });

  it.each(["validate", "rotate"] as const)(
    "rolls back refresh-replay %s before post-commit repair preemption",
    async (replayPath) => {
      const directory = await mkdtemp(join(tmpdir(), `native-im-${replayPath}-rollback-`));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const bootstrapClient = await createWorkerDatabaseClient({ databasePath });
      const bootstrapAuthority = createSqliteAuthoritativeStore(bootstrapClient);
      await bootstrapAuthority.registerActors(actors);
      let now = 1_000;
      const bootstrapAuth = createAuthenticationService({
        actors: actorDirectory,
        identities,
        authority: bootstrapAuthority,
        clock: () => now,
        tokenFactory: tokenSequence(
          `${replayPath}-rollback-access-one`,
          `${replayPath}-rollback-refresh-one`,
          `${replayPath}-rollback-access-two`,
          `${replayPath}-rollback-refresh-two`,
        ),
      });
      const issued = await bootstrapAuth.login(
        { accountId: "account-li", secret: "correct" },
      );
      now = 2_000;
      const rotated = await bootstrapAuth.refresh(issued.refreshToken);
      const rotatedContext = await bootstrapAuth.authenticateSession(rotated.accessToken);
      await bootstrapClient.close();
      const before = identitySessionMutationSnapshot(databasePath);

      const faultClient = await createWorkerDatabaseClientWithTransactionFaultForTest(
        { databasePath },
        "before-commit",
      );
      const faultAuthority = createSqliteAuthoritativeStore(faultClient);
      const lease = await faultClient.acquireStreamingRepair(
        rotatedContext,
        { kind: "catalog", principalId: "human-li" },
        now,
      );
      await faultClient.registerStreamingRepair(
        lease.snapshotId,
        `${replayPath}-rollback-checksum`,
        1,
        now,
      );
      const replay = replayPath === "validate"
        ? faultAuthority.validateRefresh(
            tokenHash(issued.refreshToken),
            rotatedContext.principal,
            3_000,
          )
        : faultAuthority.rotate({
            currentRefreshTokenHash: tokenHash(issued.refreshToken),
            accessTokenHash: tokenHash("rollback-loser-access"),
            refreshTokenHash: tokenHash("rollback-loser-refresh"),
            accessExpiresAt: 4_000,
            refreshExpiresAt: 30_000,
            expectedPrincipal: rotatedContext.principal,
            now: 3_000,
          });
      await expect(replay).rejects.toMatchObject({
        status: 503,
        code: "authority_worker_exited",
      });
      expect(identitySessionMutationSnapshot(databasePath)).toEqual(before);
    },
  );

  it("preempts a revoked family after a concurrent rotation loser commits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-rotate-race-preempt-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client);
    await authority.registerActors(actors);
    let now = 1_000;
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority,
      clock: () => now,
      tokenFactory: tokenSequence(
        "race-access",
        "race-refresh",
        "race-independent-access",
        "race-independent-refresh",
      ),
    });
    const issued = await auth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "race-install", label: "Race device", platform: "macos" },
    );
    const independent = await auth.login(
      { accountId: "account-li", secret: "correct" },
      { id: "race-independent", label: "Independent", platform: "linux" },
    );
    const initialContext = await auth.authenticateSession(issued.accessToken);
    const independentContext = await auth.authenticateSession(independent.accessToken);
    const raceLease = await client.acquireStreamingRepair(
      initialContext,
      { kind: "catalog", principalId: "human-li" },
      now,
    );
    await client.registerStreamingRepair(
      raceLease.snapshotId,
      "rotation-race-checksum",
      1,
      now,
    );

    now = 2_000;
    const rotations = await Promise.allSettled([
      authority.rotate({
        currentRefreshTokenHash: tokenHash(issued.refreshToken),
        accessTokenHash: tokenHash("race-winner-a-access"),
        refreshTokenHash: tokenHash("race-winner-a-refresh"),
        accessExpiresAt: 3_000,
        refreshExpiresAt: 30_000,
        expectedPrincipal: initialContext.principal,
        now,
      }),
      authority.rotate({
        currentRefreshTokenHash: tokenHash(issued.refreshToken),
        accessTokenHash: tokenHash("race-winner-b-access"),
        refreshTokenHash: tokenHash("race-winner-b-refresh"),
        accessExpiresAt: 3_000,
        refreshExpiresAt: 30_000,
        expectedPrincipal: initialContext.principal,
        now,
      }),
    ]);
    expect(rotations.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const winningRotation = rotations.find((result) => result.status === "fulfilled");
    const losingRotation = rotations.find((result) => result.status === "rejected");
    if (
      winningRotation?.status !== "fulfilled" ||
      losingRotation?.status !== "rejected"
    ) {
      throw new Error("Expected one winning and one losing rotation");
    }
    expect(losingRotation.reason).toMatchObject({
      status: 403,
      code: "session_revoked",
    });
    await expect(client.authorizeStreamingRepairPage(
      {
        sessionId: winningRotation.value.sessionId,
        sessionFamilyId: winningRotation.value.familyId,
        principal: initialContext.principal,
      },
      raceLease.snapshotId,
      0,
      now,
    )).rejects.toMatchObject({
      status: 403,
      code: "snapshot_family_revoked",
    });
    const independentLease = await client.acquireStreamingRepair(
      independentContext,
      { kind: "catalog", principalId: "human-li" },
      now,
    );
    expect(independentLease.sessionFamilyId).toBe(independentContext.sessionFamilyId);
    await client.close();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type = 'identity.session.revoked'",
    ).get()).toEqual({ count: 1 });
    expect(inspection.prepare(
      "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE target_kind = 'session-family'",
    ).get()).toEqual({ count: 1 });
    inspection.close();
  });

  it("explicitly revokes a family and persists one terminal outbox delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-revoke-authority-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client);
    await authority.registerActors(actors);
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority,
      clock: () => 1_000,
      tokenFactory: tokenSequence("access-revoke", "refresh-revoke"),
    });
    const issued = await auth.login({ accountId: "account-li", secret: "correct" });

    await auth.revoke(issued.accessToken);
    await auth.revoke(issued.accessToken);
    await expect(auth.authenticateSession(issued.accessToken)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await client.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM events
           WHERE event_type = 'identity.session.revoked'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_deliveries").get()).toEqual({
      count: 1,
    });
    database.close();
  });

  it("rejects an expired access token without mutating session state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-expiry-authority-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client);
    await authority.registerActors(actors);
    let now = 1_000;
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority,
      accessTtlMs: 100,
      refreshTtlMs: 1_000,
      clock: () => now,
      tokenFactory: tokenSequence("access-expiry", "refresh-expiry"),
    });
    const issued = await auth.login({ accountId: "account-li", secret: "correct" });

    now = 1_100;
    await expect(auth.authenticateSession(issued.accessToken)).rejects.toMatchObject({
      status: 401,
      code: "token_expired",
    });
    await client.close();
  });

  it("rechecks a queued human command after another connection revokes its family", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-command-auth-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const client = await createWorkerDatabaseClient({ databasePath });
    const enteredPause = deferred();
    const resumeCommand = deferred();
    const authority = createSqliteAuthoritativeStore(client, {
      beforeEnqueueHuman: async () => {
        enteredPause.resolve();
        await resumeCommand.promise;
      },
      clock: () => 1_000,
    });
    await authority.registerActors(actors);
    const auth = createAuthenticationService({
      actors: actorDirectory,
      identities,
      authority,
      clock: () => 1_000,
      tokenFactory: tokenSequence("access-command", "refresh-command"),
    });
    const issued = await auth.login({ accountId: "account-li", secret: "correct" });
    const session = await auth.authenticateSession(issued.accessToken);

    const command = authority.executeHuman(
      {
        kind: "human",
        ...session,
        requestId: "request-create-room",
        idempotencyKey: "create-room-once",
      },
      { type: "room.create", payload: { name: "Revoked room" } },
    );
    await enteredPause.promise;
    await auth.revoke(issued.accessToken);

    const inspectionBeforeResume = new DatabaseSync(databasePath, { readOnly: true });
    const countsBeforeResume = {
      rooms: inspectionBeforeResume.prepare("SELECT COUNT(*) AS count FROM rooms").get(),
      events: inspectionBeforeResume.prepare("SELECT COUNT(*) AS count FROM events").get(),
      outbox: inspectionBeforeResume
        .prepare("SELECT COUNT(*) AS count FROM outbox_deliveries")
        .get(),
    };
    inspectionBeforeResume.close();
    resumeCommand.resolve();

    await expect(command).rejects.toMatchObject({ code: "session_revoked" });
    await client.close();
    const inspectionAfter = new DatabaseSync(databasePath, { readOnly: true });
    expect({
      rooms: inspectionAfter.prepare("SELECT COUNT(*) AS count FROM rooms").get(),
      events: inspectionAfter.prepare("SELECT COUNT(*) AS count FROM events").get(),
      outbox: inspectionAfter
        .prepare("SELECT COUNT(*) AS count FROM outbox_deliveries")
        .get(),
    }).toEqual(countsBeforeResume);
    inspectionAfter.close();
  });

  it("rejects explicit undefined optional principals in worker requests", () => {
    expect(
      isAuthorityWorkerRequest({
        type: "authority.session-validate-refresh",
        requestId: "request-validate",
        currentRefreshTokenHash: tokenHash("refresh"),
        expectedPrincipal: undefined,
        now: 1_000,
      }),
    ).toBe(false);
    expect(
      isAuthorityWorkerRequest({
        type: "authority.session-rotate",
        requestId: "request-rotate",
        input: {
          currentRefreshTokenHash: tokenHash("refresh"),
          accessTokenHash: tokenHash("access-next"),
          refreshTokenHash: tokenHash("refresh-next"),
          accessExpiresAt: 2_000,
          refreshExpiresAt: 3_000,
          expectedPrincipal: undefined,
          now: 1_000,
        },
      }),
    ).toBe(false);
  });

  it("rejects non-canonical base64url token hashes", () => {
    const nonCanonicalHash = `${"A".repeat(42)}B`;
    expect(Buffer.from(nonCanonicalHash, "base64url").toString("base64url"))
      .not.toBe(nonCanonicalHash);
    expect(
      isAuthorityWorkerRequest({
        type: "authority.session-authenticate",
        requestId: "request-non-canonical",
        accessTokenHash: nonCanonicalHash,
        now: 1_000,
      }),
    ).toBe(false);
  });

  it("fails closed without writes when a submitted attachment is not authoritative", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-message-attachment-gate-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createCommandMatrixFixture(databasePath);
    const messageId = "message-v2-attachment-rejected";

    await expect(fixture.store.submitHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "message-v2-attachment-rejected",
        idempotencyKey: messageId,
      },
      {
        messageId,
        roomId: fixture.contexts.roomId,
        body: "attachment is not yet authoritative",
        mentionedTargets: [],
        attachments: [{ attachmentId: "attachment-unvalidated" }],
      },
    )).rejects.toMatchObject({ status: 410, code: "attachment_gone" });

    await fixture.client.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM messages WHERE id = ?) AS messages,
         (SELECT COUNT(*) FROM message_envelopes WHERE message_id = ?) AS envelopes,
         (SELECT COUNT(*) FROM message_attachment_links WHERE message_id = ?) AS attachments`,
    ).get(messageId, messageId, messageId)).toEqual({
      messages: 0,
      envelopes: 0,
      attachments: 0,
    });
    database.close();
  });

  it("serializes two devices of one Human revising the same expected revision to one winner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-message-two-device-revise-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createCommandMatrixFixture(databasePath);
    const messageId = "message-v2-two-device-revise";
    expect(fixture.contexts.owner.principal).toEqual(
      fixture.contexts.ownerSecondDevice.principal,
    );
    expect(fixture.contexts.owner.sessionFamilyId).not.toBe(
      fixture.contexts.ownerSecondDevice.sessionFamilyId,
    );
    await fixture.store.submitHumanMessage(
      { ...fixture.contexts.owner, requestId: "two-device-submit", idempotencyKey: messageId },
      {
        messageId,
        roomId: fixture.contexts.roomId,
        body: "original body",
        mentionedTargets: [],
        attachments: [],
      },
    );

    const contenders = await Promise.allSettled([
      fixture.store.reviseHumanMessage(
        {
          ...fixture.contexts.owner,
          requestId: "two-device-revise-a",
          idempotencyKey: "transport-key-a",
        },
        {
          roomId: fixture.contexts.roomId,
          messageId,
          expectedRevision: 1,
          body: "device A revision",
        },
      ),
      fixture.store.reviseHumanMessage(
        {
          ...fixture.contexts.ownerSecondDevice,
          requestId: "two-device-revise-b",
          idempotencyKey: "transport-key-b",
        },
        {
          roomId: fixture.contexts.roomId,
          messageId,
          expectedRevision: 1,
          body: "device B revision",
        },
      ),
    ]);
    const winners = contenders.filter((result) => result.status === "fulfilled");
    const losers = contenders.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({
      reason: { status: 409, code: "idempotency_conflict" },
    });

    await fixture.client.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      `SELECT lifecycle, current_revision AS currentRevision,
              revision_count AS revisionCount
       FROM message_envelopes WHERE message_id = ?`,
    ).get(messageId)).toEqual({ lifecycle: "active", currentRevision: 2, revisionCount: 2 });
    expect(database.prepare(
      "SELECT revision, body FROM message_revisions WHERE message_id = ? ORDER BY revision",
    ).all(messageId)).toEqual([
      { revision: 1, body: "original body" },
      { revision: 2, body: expect.stringMatching(/^device [AB] revision$/u) },
    ]);
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE event_type = 'room.message.revised'
         AND json_extract(payload_json, '$.id') = ?`,
    ).get(messageId)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM idempotency_records WHERE key = ?",
    ).get(`${messageId}:revision:1`)).toEqual({ count: 1 });
    database.close();
  });

  it.each(["revise-first", "recall-first"] as const)(
    "serializes %s revise-vs-recall to one CAS winner",
    async (order) => {
      const directory = await mkdtemp(join(tmpdir(), `native-im-message-${order}-`));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createCommandMatrixFixture(databasePath);
      const messageId = `message-v2-${order}`;
      await fixture.store.submitHumanMessage(
        { ...fixture.contexts.owner, requestId: `${order}-submit`, idempotencyKey: messageId },
        {
          messageId,
          roomId: fixture.contexts.roomId,
          body: "race source",
          mentionedTargets: [],
          attachments: [],
        },
      );
      const revise = () => fixture.store.reviseHumanMessage(
        {
          ...fixture.contexts.owner,
          requestId: `${order}-revise`,
          idempotencyKey: `${order}-revise-transport`,
        },
        {
          roomId: fixture.contexts.roomId,
          messageId,
          expectedRevision: 1,
          body: "race revision",
        },
      );
      const recall = () => fixture.store.recallHumanMessage(
        {
          ...fixture.contexts.ownerSecondDevice,
          requestId: `${order}-recall`,
          idempotencyKey: `${order}-recall-transport`,
        },
        { roomId: fixture.contexts.roomId, messageId, expectedRevision: 1 },
      );
      const contenders = await Promise.allSettled(
        order === "revise-first" ? [revise(), recall()] : [recall(), revise()],
      );
      expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(contenders.filter((result) => result.status === "rejected")).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ status: 409, code: "message_version_conflict" }),
        }),
      ]);

      await fixture.client.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      const envelope = database.prepare(
        `SELECT lifecycle, current_revision AS currentRevision,
                revision_count AS revisionCount
         FROM message_envelopes WHERE message_id = ?`,
      ).get(messageId);
      expect(envelope).toEqual(order === "revise-first"
        ? { lifecycle: "active", currentRevision: 2, revisionCount: 2 }
        : { lifecycle: "recalled", currentRevision: 1, revisionCount: 1 });
      expect(database.prepare(
        `SELECT event_type AS eventType FROM events
         WHERE event_type IN ('room.message.revised', 'room.message.recalled')
           AND json_extract(payload_json, '$.id') = ?`,
      ).all(messageId)).toEqual([{
        eventType: order === "revise-first" ? "room.message.revised" : "room.message.recalled",
      }]);
      database.close();
    },
  );

  it.each([
    ["human", "authority-cut-first"],
    ["human", "send-first"],
    ["agent", "authority-cut-first"],
    ["agent", "send-first"],
  ] as const)(
    "serializes %s target authority with %s and never rewrites the committed outcome",
    async (targetKind, order) => {
      const directory = await mkdtemp(join(
        tmpdir(),
        `native-im-message-target-${targetKind}-${order}-`,
      ));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createCommandMatrixFixture(databasePath);
      const messageId = `message-v2-target-${targetKind}-${order}`;
      const targetActorId = targetKind === "human" ? "human-chen" : "agent-review";
      const targetId = `${messageId}-target`;
      const mention = targetKind === "human" ? "@Chen" : "@Reviewer";
      const submit = () => fixture.store.submitHumanMessage(
        {
          ...fixture.contexts.ownerSecondDevice,
          requestId: `${messageId}-submit`,
          idempotencyKey: messageId,
        },
        {
          messageId,
          roomId: fixture.contexts.roomId,
          body: `${mention} race`,
          mentionedTargets: [{
            id: targetId,
            kind: targetKind === "human" ? "human-request" : "agent-invocation",
            targetActorId,
            range: { startUtf16: 0, endUtf16: mention.length },
          }],
          attachments: [],
        },
      );
      const cutAuthority = () => fixture.store.executeHuman(
        {
          ...fixture.contexts.owner,
          requestId: `${messageId}-cut`,
          idempotencyKey: `${messageId}-cut`,
        },
        targetKind === "human"
          ? {
              type: "room.member.remove",
              roomId: fixture.contexts.roomId,
              payload: { targetActorId, expectedGovernanceRevision: 1 },
            }
          : {
              type: "agent.configure",
              roomId: fixture.contexts.roomId,
              payload: {
                agentId: targetActorId,
                participation: "on-mention",
                toolPermissions: ["review.read"],
              },
            },
      );

      let submission: ReturnType<typeof submit>;
      let authorityCut: ReturnType<typeof cutAuthority>;
      if (order === "authority-cut-first") {
        authorityCut = cutAuthority();
        await authorityCut;
        submission = submit();
      } else {
        submission = submit();
        authorityCut = cutAuthority();
      }
      const departureBlocked = targetKind === "human" && order === "send-first";
      if (departureBlocked) {
        await expect(authorityCut).rejects.toMatchObject({
          status: 409,
          code: "departure_blocked",
          details: {
            roomId: fixture.contexts.roomId,
            targetActorId: targetActorId,
            conflicts: [expect.objectContaining({
              kind: "acceptance",
              title: "project.request.pending_acceptance.target",
              state: "pending_acceptance",
              revision: 1,
            })],
          },
        });
      } else {
        await Promise.all([submission, authorityCut]);
      }
      const receipt = await submission;
      const targetWasInvalidatedBeforeSend = order === "authority-cut-first";
      expect(receipt.targetOutcomes).toEqual([targetWasInvalidatedBeforeSend
        ? {
            targetId,
            targetActorId,
            kind: targetKind === "human" ? "human-request" : "agent-invocation",
            status: "rejected",
            code: targetKind === "human" ? "target_not_member" : "target_assignment_inactive",
          }
        : expect.objectContaining({
            targetId,
            targetActorId,
            kind: targetKind === "human" ? "human-request" : "agent-invocation",
            status: targetKind === "human" ? "request-created" : "invocation-intent-created",
          })]);

      await fixture.client.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        `SELECT status, rejection_code AS rejectionCode
         FROM message_target_outcomes WHERE message_id = ? AND target_id = ?`,
      ).get(messageId, targetId)).toEqual(targetWasInvalidatedBeforeSend
        ? {
            status: "rejected",
            rejectionCode: targetKind === "human"
              ? "target_not_member"
              : "target_assignment_inactive",
          }
        : {
            status: targetKind === "human"
              ? "request-created"
              : "invocation-intent-created",
            rejectionCode: null,
          });
      const intentTable = targetKind === "human"
        ? "human_request_intents"
        : "agent_invocation_intents";
      expect(database.prepare(
        `SELECT status FROM ${intentTable} WHERE source_message_id = ?`,
      ).all(messageId)).toEqual(targetWasInvalidatedBeforeSend
        ? []
        : [{ status: targetKind === "agent" ? "cancelled" : "pending" }]);
      if (targetKind === "agent" && !targetWasInvalidatedBeforeSend) {
        expect(database.prepare(
          `SELECT binding.profile_id AS profileId,
                  binding.profile_revision AS profileRevision,
                  binding.assignment_id AS assignmentId,
                  binding.assignment_revision AS assignmentRevision,
                  binding.access_revision AS accessRevision
           FROM direct_agent_invocation_authority_bindings AS binding
           JOIN agent_invocation_intents AS intent ON intent.id = binding.intent_id
           WHERE intent.source_message_id = ?`,
        ).all(messageId)).toEqual([
          expect.objectContaining({
            profileId: expect.any(String),
            profileRevision: expect.any(Number),
            assignmentId: expect.any(String),
            assignmentRevision: expect.any(Number),
            accessRevision: expect.any(Number),
          }),
        ]);
      }
      expect(database.prepare(
        `SELECT role, participation FROM room_memberships
         WHERE room_id = ? AND actor_id = ?`,
      ).get(fixture.contexts.roomId, targetActorId)).toEqual(targetKind === "human"
        ? departureBlocked ? { role: "member", participation: null } : undefined
        : { role: null, participation: "on-mention" });
      if (departureBlocked) {
        expect(database.prepare(
          `SELECT status, target_human_actor_id AS targetActorId
           FROM project_requests WHERE source_target_id = ?`,
        ).get(targetId)).toEqual({ status: "pending_acceptance", targetActorId });
      }
      database.close();
    },
  );

  it.each(["final-first", "recall-first"] as const)(
    "keeps the %s recall-vs-final CAS state closed across AuthorityWorker restart",
    async (order) => {
      const directory = await mkdtemp(join(tmpdir(), `native-im-message-${order}-restart-`));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createCommandMatrixFixture(databasePath);
      const sourceMessageId = `message-v2-source-${order}`;
      const finalMessageId = `message-v2-final-${order}`;
      const submitted = await fixture.store.submitHumanMessage(
        {
          ...fixture.contexts.owner,
          requestId: `${order}-source-submit`,
          idempotencyKey: sourceMessageId,
        },
        {
          messageId: sourceMessageId,
          roomId: fixture.contexts.roomId,
          body: "@Reviewer race",
          mentionedTargets: [{
            id: `${sourceMessageId}-target`,
            kind: "agent-invocation",
            targetActorId: "agent-review",
            range: { startUtf16: 0, endUtf16: 9 },
          }],
          attachments: [],
        },
      );
      const targetOutcome = submitted.targetOutcomes[0];
      if (targetOutcome?.status !== "invocation-intent-created") {
        throw new Error("Expected Agent invocation intent");
      }
      const invocationIntentId = targetOutcome.invocationIntentId;
      const executionId = `execution-v2-${order}`;
      claimMessageAuthorityExecution(databasePath, {
        intentId: invocationIntentId,
        executionId,
        roomId: fixture.contexts.roomId,
        sourceMessageId,
        agentId: "agent-review",
        requesterActorId: "human-li",
      });
      const commitFinal = () => fixture.store.commitAgentMessage(
        mintInternalAgentMessageCommitContext({
          agentActorId: "agent-review",
          invocationIntentId,
          executionId,
          attemptSeq: 1,
          executionGeneration: 1,
        }),
        {
          messageId: finalMessageId,
          roomId: fixture.contexts.roomId,
          body: `authoritative ${order} final`,
        },
      );
      const recallSource = () => fixture.store.recallHumanMessage(
        {
          ...fixture.contexts.ownerSecondDevice,
          requestId: `${order}-source-recall`,
          idempotencyKey: `${order}-source-recall-transport`,
        },
        { roomId: fixture.contexts.roomId, messageId: sourceMessageId, expectedRevision: 1 },
      );
      const contenders = await Promise.allSettled(
        order === "final-first"
          ? [commitFinal(), recallSource()]
          : [recallSource(), commitFinal()],
      );
      if (order === "final-first") {
        expect(contenders.every((result) => result.status === "fulfilled")).toBe(true);
      } else {
        expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(contenders.filter((result) => result.status === "rejected")).toEqual([
          expect.objectContaining({
            reason: expect.objectContaining({ status: 409, code: "execution_conflict" }),
          }),
        ]);
      }

      await fixture.client.close();
      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      const restartedStore = createSqliteAuthoritativeStore(restartedClient, { clock: () => 6_000 });
      const history = await restartedStore.readMessageHistory({
        sessionId: fixture.contexts.owner.sessionId,
        sessionFamilyId: fixture.contexts.owner.sessionFamilyId,
        principal: fixture.contexts.owner.principal,
      }, { roomId: fixture.contexts.roomId });
      expect(history.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sourceMessageId, lifecycle: "recalled" }),
      ]));
      expect(history.messages.some((message) => message.id === finalMessageId)).toBe(
        order === "final-first",
      );
      await restartedClient.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        `SELECT status, result_message_id AS resultMessageId,
                cancellation_reason AS cancellationReason
         FROM agent_executions WHERE id = ?`,
      ).get(executionId)).toEqual(order === "final-first"
        ? { status: "completed", resultMessageId: finalMessageId, cancellationReason: null }
        : { status: "cancelled", resultMessageId: null, cancellationReason: "message_recalled" });
      expect(database.prepare(
        "SELECT message_id AS messageId FROM agent_message_sources WHERE execution_id = ?",
      ).all(executionId)).toEqual(order === "final-first"
        ? [{ messageId: finalMessageId }]
        : []);
      database.close();
    },
  );

  it("rolls a v2 submit back at every named aggregate boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-message-v2-fault-boundaries-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createCommandMatrixFixture(databasePath);
    await fixture.client.close();
    const faultPoints: readonly MessageAuthoritySubmitFaultPointForTest[] = [
      "after-message",
      "after-target",
      "after-outcome",
      "after-event",
      "after-outbox",
      "after-receipt",
    ];
    const zero = {
      messages: 0,
      envelopes: 0,
      revisions: 0,
      targets: 0,
      outcomes: 0,
      humanIntents: 0,
      agentIntents: 0,
      events: 0,
      outbox: 0,
      receipts: 0,
    };

    for (const faultPoint of faultPoints) {
      const messageId = `message-v2-fault-${faultPoint}`;
      const database = new DatabaseSync(databasePath);
      expect(() => submitHumanMessageDatabaseCommand(database, {
        context: {
          ...fixture.contexts.owner,
          requestId: `${messageId}-request`,
          idempotencyKey: `${messageId}-transport`,
        },
        message: {
          messageId,
          roomId: fixture.contexts.roomId,
          body: "@Reviewer rollback",
          mentionedTargets: [{
            id: `${messageId}-target`,
            kind: "agent-invocation",
            targetActorId: "agent-review",
            range: { startUtf16: 0, endUtf16: 9 },
          }],
          attachments: [],
        },
        now: 5_000,
        onFaultPointForTest(point) {
          if (point === faultPoint) throw new Error(`injected-${faultPoint}`);
        },
      })).toThrow(`injected-${faultPoint}`);
      database.close();
      expect(messageAuthorityAggregateSnapshot(databasePath, messageId)).toEqual(zero);
    }
  });

  it("never creates new Agent-source routes and terminalizes bounded historical jobs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-route-active-agent-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createCommandMatrixFixture(databasePath);
    const sourceMessageId = "message-agent-active-route-source";
    await fixture.store.executeAgent(
      mintInternalAgentCommandContext({
        agentId: "agent-review",
        requestId: "active-agent-route-submit",
        idempotencyKey: "active-agent-route-submit",
      }),
      {
        type: "message.send",
        roomId: fixture.contexts.roomId,
        payload: {
          id: sourceMessageId,
          roomId: fixture.contexts.roomId,
          body: "active Agent route body",
          sentAt: "2026-08-19T09:00:00.000Z",
        },
      },
    );
    const completionSourceMessageId = "message-agent-complete-route-source";
    await fixture.store.executeAgent(
      mintInternalAgentCommandContext({
        agentId: "agent-review",
        requestId: "complete-agent-route-submit",
        idempotencyKey: "complete-agent-route-submit",
      }),
      {
        type: "message.send",
        roomId: fixture.contexts.roomId,
        payload: {
          id: completionSourceMessageId,
          roomId: fixture.contexts.roomId,
          body: "Agent route completion must be suppressed by Authority",
          sentAt: "2026-08-19T09:00:30.000Z",
        },
      },
    );

    const legacy = new DatabaseSync(databasePath);
    expect(legacy.prepare(
      "SELECT COUNT(*) AS count FROM route_jobs WHERE source_message_id IN (?, ?)",
    ).get(sourceMessageId, completionSourceMessageId)).toEqual({ count: 0 });
    const legacyRouteRows = [
      ["route-agent-callback", sourceMessageId, "queued", "2026-08-19T09:01:00.000Z"],
      ["route-agent-recovery", "matrix-agent-source", "queued", "2026-08-19T09:02:00.000Z"],
      ["route-agent-complete", completionSourceMessageId, "running", "2026-08-19T09:03:00.000Z"],
    ] as const;
    for (const [routeJobId, messageId, status, createdAt] of legacyRouteRows) {
      legacy.prepare(
        `INSERT INTO route_jobs (
           id, room_id, source_message_id, status, current_attempt, topic_key,
           embedding_model_version, window_size, cosine_threshold, room_phase,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, 'dao-topic-embedding-v1', 8, 0.82,
                   'discussion', ?, ?)`,
      ).run(
        routeJobId,
        fixture.contexts.roomId,
        messageId,
        status,
        `topic-v1:${routeJobId}`,
        createdAt,
        createdAt,
      );
      legacy.prepare(
        `INSERT INTO route_attempts (route_job_id, attempt_seq, status)
         VALUES (?, 1, ?)`,
      ).run(routeJobId, status);
      legacy.prepare(
        `INSERT INTO route_job_agents (
           route_job_id, agent_id, participation, role, capabilities_json,
           calibration_score, has_ball
         ) VALUES (?, 'agent-review', 'active', 'Reviewer', '["review.read"]', 0, 0)`,
      ).run(routeJobId);
    }
    legacy.close();

    await expect(fixture.client.executeRoute({
      type: "route.claim",
      agentProviderReady: true,
      sourceMessageId,
      now: 5_100,
    })).resolves.toMatchObject({
      kind: "route-completed",
      job: { id: "route-agent-callback", status: "completed" },
      intents: [],
    });
    await expect(fixture.client.executeRoute({
      type: "route.complete",
      routeJobId: "route-agent-complete",
      attempt: 1,
      judgments: [{
        id: "untrusted-agent-complete-judgment",
        routeJobId: "route-agent-complete",
        sourceMessageId: completionSourceMessageId,
        agentId: "agent-review",
        outcome: "will_respond",
        reasonCode: "direct_mention",
        reasonText: "must be discarded",
        routeAttempt: 1,
        decidedAt: "2026-08-19T09:04:00.000Z",
      }],
      intents: [{
        kind: "direct_mention",
        roomId: fixture.contexts.roomId,
        sourceMessageId: completionSourceMessageId,
        targetAgentId: "agent-review",
        reasonCode: "direct_mention",
        reasonText: "must be discarded",
        priority: 1,
      }],
      agentProviderReady: true,
      now: 5_150,
    })).resolves.toMatchObject({
      kind: "route-completed",
      job: { id: "route-agent-complete", status: "completed" },
      intents: [],
    });
    await expect(fixture.client.executeRoute({
      type: "route.recover",
      now: 5_200,
    })).resolves.toEqual({
      kind: "route-recovery",
      jobs: [],
    });
    await fixture.client.close();

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare(
      `SELECT job.id, job.status, attempt.status AS attemptStatus,
              attempt.error_code AS errorCode
       FROM route_jobs AS job
       JOIN route_attempts AS attempt ON attempt.route_job_id = job.id
       WHERE job.id IN ('route-agent-callback', 'route-agent-complete', 'route-agent-recovery')
       ORDER BY job.id`,
    ).all()).toEqual([
      {
        id: "route-agent-callback",
        status: "completed",
        attemptStatus: "cancelled",
        errorCode: "agent_authored_source",
      },
      {
        id: "route-agent-complete",
        status: "completed",
        attemptStatus: "cancelled",
        errorCode: "agent_authored_source",
      },
      {
        id: "route-agent-recovery",
        status: "completed",
        attemptStatus: "cancelled",
        errorCode: "agent_authored_source",
      },
    ]);
    expect(inspection.prepare(
      `SELECT route_job_id AS routeJobId, outcome, reason_code AS reasonCode,
              reason_text AS reasonText
       FROM route_judgments
       WHERE route_job_id IN ('route-agent-callback', 'route-agent-complete', 'route-agent-recovery')
       ORDER BY route_job_id`,
    ).all()).toEqual([
      {
        routeJobId: "route-agent-callback",
        outcome: "suppressed",
        reasonCode: "not_selected",
        reasonText: "agent_authored_source: Agent final messages cannot cascade",
      },
      {
        routeJobId: "route-agent-complete",
        outcome: "suppressed",
        reasonCode: "not_selected",
        reasonText: "agent_authored_source: Agent final messages cannot cascade",
      },
      {
        routeJobId: "route-agent-recovery",
        outcome: "suppressed",
        reasonCode: "not_selected",
        reasonText: "agent_authored_source: Agent final messages cannot cascade",
      },
    ]);
    expect(inspection.prepare(
      `SELECT COUNT(*) AS count FROM route_invocation_intents
       WHERE route_job_id IN ('route-agent-callback', 'route-agent-complete', 'route-agent-recovery')`,
    ).get()).toEqual({ count: 0 });
    inspection.close();
  });

  it("routes the current Human revision without exposing the retained old body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-route-current-revision-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createCommandMatrixFixture(databasePath);
    const sourceMessageId = "message-v2-route-current-revision";
    const oldBody = "OLD-ROUTE-REVISION-SENTINEL";
    const currentBody = "current authoritative route revision";
    await fixture.store.submitHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "route-current-revision-submit",
        idempotencyKey: sourceMessageId,
      },
      {
        messageId: sourceMessageId,
        roomId: fixture.contexts.roomId,
        body: oldBody,
        mentionedTargets: [],
        attachments: [],
      },
    );
    await fixture.client.executeRuntime({
      type: "runtime.cancel-for-human-fence",
      sourceHumanMessageId: sourceMessageId,
      now: 5_100,
    });
    await fixture.client.executeRuntime({
      type: "runtime.create-route-after-human-fence",
      sourceHumanMessageId: sourceMessageId,
      now: 5_101,
    });
    await fixture.store.reviseHumanMessage(
      {
        ...fixture.contexts.ownerSecondDevice,
        requestId: "route-current-revision-revise",
        idempotencyKey: "route-current-revision-revise-transport",
      },
      {
        roomId: fixture.contexts.roomId,
        messageId: sourceMessageId,
        expectedRevision: 1,
        body: currentBody,
      },
    );

    const claimed = await fixture.client.executeRoute({
      type: "route.claim",
      agentProviderReady: true,
      sourceMessageId,
      now: 5_200,
    });
    expect(claimed).toMatchObject({
      kind: "route-claimed",
      providerInput: { message: { summary: currentBody } },
    });
    expect(JSON.stringify(claimed)).not.toContain(oldBody);
    await fixture.client.close();
  });

  it("rejects route claim after its Human source is recalled without exposing raw body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-route-recalled-source-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createCommandMatrixFixture(databasePath);
    const sourceMessageId = "message-v2-route-recalled-source";
    await fixture.store.submitHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "route-recalled-source-submit",
        idempotencyKey: sourceMessageId,
      },
      {
        messageId: sourceMessageId,
        roomId: fixture.contexts.roomId,
        body: "recalled route body sentinel",
        mentionedTargets: [],
        attachments: [],
      },
    );
    await fixture.client.executeRuntime({
      type: "runtime.cancel-for-human-fence",
      sourceHumanMessageId: sourceMessageId,
      now: 5_100,
    });
    await fixture.client.executeRuntime({
      type: "runtime.create-route-after-human-fence",
      sourceHumanMessageId: sourceMessageId,
      now: 5_101,
    });
    await fixture.store.recallHumanMessage(
      {
        ...fixture.contexts.ownerSecondDevice,
        requestId: "route-recalled-source-recall",
        idempotencyKey: "route-recalled-source-recall-transport",
      },
      { roomId: fixture.contexts.roomId, messageId: sourceMessageId, expectedRevision: 1 },
    );

    await expect(fixture.client.executeRoute({
      type: "route.claim",
      agentProviderReady: true,
      sourceMessageId,
      now: 5_200,
    })).rejects.toMatchObject({ status: 409, code: "route_conflict" });
    await fixture.client.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      `SELECT job.status, attempt.status AS attemptStatus
       FROM route_jobs AS job
       JOIN route_attempts AS attempt ON attempt.route_job_id = job.id
       WHERE job.source_message_id = ? AND attempt.attempt_seq = 1`,
    ).get(sourceMessageId)).toEqual({ status: "queued", attemptStatus: "queued" });
    database.close();
  });

  it("keeps recalled Human sources out of pending fences and post-fence route creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-recalled-fences-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createCommandMatrixFixture(databasePath);
    const pendingMessageId = "message-v2-recalled-pending-fence";
    const createMessageId = "message-v2-recalled-create-route";
    for (const messageId of [pendingMessageId, createMessageId]) {
      await fixture.store.submitHumanMessage(
        {
          ...fixture.contexts.owner,
          requestId: `${messageId}-submit`,
          idempotencyKey: messageId,
        },
        {
          messageId,
          roomId: fixture.contexts.roomId,
          body: `${messageId} raw sentinel`,
          mentionedTargets: [],
          attachments: [],
        },
      );
    }
    await fixture.store.recallHumanMessage(
      {
        ...fixture.contexts.ownerSecondDevice,
        requestId: `${pendingMessageId}-recall`,
        idempotencyKey: `${pendingMessageId}-recall-transport`,
      },
      { roomId: fixture.contexts.roomId, messageId: pendingMessageId, expectedRevision: 1 },
    );
    await expect(fixture.client.executeRuntime({
      type: "runtime.list-pending-human-fences",
      now: 5_100,
    })).resolves.toMatchObject({
      kind: "pending-human-fences",
      sourceHumanMessageIds: [createMessageId],
    });

    await fixture.client.executeRuntime({
      type: "runtime.cancel-for-human-fence",
      sourceHumanMessageId: createMessageId,
      now: 5_101,
    });
    await fixture.store.recallHumanMessage(
      {
        ...fixture.contexts.ownerSecondDevice,
        requestId: `${createMessageId}-recall`,
        idempotencyKey: `${createMessageId}-recall-transport`,
      },
      { roomId: fixture.contexts.roomId, messageId: createMessageId, expectedRevision: 1 },
    );
    await expect(fixture.client.executeRuntime({
      type: "runtime.create-route-after-human-fence",
      sourceHumanMessageId: createMessageId,
      now: 5_200,
    })).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
    await fixture.client.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM route_jobs
       WHERE source_message_id IN (?, ?)`,
    ).get(pendingMessageId, createMessageId)).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM events
       WHERE event_type = 'route.started'
         AND payload_json LIKE ?`,
    ).get(`%${createMessageId}%`)).toEqual({ count: 0 });
    database.close();
  });

  it("excludes recalled Human raw bodies from calibration topic memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-calibration-recalled-topic-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createAgentFactFixture(databasePath);
    const recalledMessageId = "message-v2-recalled-topic-sentinel";
    const recalledTopicKey = "topic-recalled-raw-sentinel";
    await fixture.authority.submitHumanMessage(
      {
        ...fixture.humanContext,
        requestId: "calibration-recalled-topic-submit",
        idempotencyKey: recalledMessageId,
      },
      {
        messageId: recalledMessageId,
        roomId: "room-facts",
        body: "review complete",
        mentionedTargets: [],
        attachments: [],
      },
    );
    const setup = new DatabaseSync(databasePath);
    setup.prepare(
      `INSERT INTO message_topics (
         message_id, room_id, topic_key, embedding_model_version,
         window_size, cosine_threshold, created_at
       ) VALUES (?, 'room-facts', ?, 'dao-topic-embedding-v1', 8, 0.82, ?)`,
    ).run(recalledMessageId, recalledTopicKey, "1970-01-01T00:00:03.000Z");
    setup.close();
    await fixture.authority.recallHumanMessage(
      {
        ...fixture.humanContext,
        requestId: "calibration-recalled-topic-recall",
        idempotencyKey: "calibration-recalled-topic-recall-transport",
      },
      { roomId: "room-facts", messageId: recalledMessageId, expectedRevision: 1 },
    );
    await fixture.authority.executeHuman(
      {
        ...fixture.humanContext,
        requestId: "calibration-after-recalled-topic",
        idempotencyKey: "calibration-after-recalled-topic",
      },
      {
        type: "calibration.record",
        roomId: "room-facts",
        payload: { sourceMessageId: "message-agent-source", feedback: "useful" },
      },
    );
    await fixture.client.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      `SELECT topic_key AS topicKey FROM route_calibration_facts
       WHERE source_message_id = 'message-agent-source'`,
    ).get()).toEqual({ topicKey: expect.not.stringMatching(/recalled-raw-sentinel/u) });
    expect(database.prepare(
      "SELECT topic_key AS topicKey FROM message_topics WHERE message_id = 'message-agent-source'",
    ).get()).toEqual({ topicKey: expect.not.stringMatching(/recalled-raw-sentinel/u) });
    database.close();
  });

  it("atomically submits structured targets, replays ACK loss, revises, recalls, and projects a tombstone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-message-authority-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createCommandMatrixFixture(databasePath);
    const ownerSession = {
      sessionId: fixture.contexts.owner.sessionId,
      sessionFamilyId: fixture.contexts.owner.sessionFamilyId,
      principal: fixture.contexts.owner.principal,
    };
    const recallRawSentinel = "RECALLED-RAW-MESSAGE-V2-SENTINEL-7A4D";
    const beforeMessageDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const beforeMessageHead = beforeMessageDatabase.prepare(
      `SELECT head_seq AS headSeq FROM streams
       WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(fixture.contexts.roomId) as { readonly headSeq: number };
    beforeMessageDatabase.close();
    const message = {
      messageId: "message-v2-structured",
      roomId: fixture.contexts.roomId,
      body: `@Chen @Reviewer @Alternate hello ${recallRawSentinel}`,
      mentionedTargets: [
        {
          id: "target-human",
          kind: "human-request",
          targetActorId: "human-chen",
          range: { startUtf16: 0, endUtf16: 5 },
        },
        {
          id: "target-agent",
          kind: "agent-invocation",
          targetActorId: "agent-review",
          range: { startUtf16: 6, endUtf16: 15 },
        },
        {
          id: "target-nonmember",
          kind: "human-request",
          targetActorId: "human-alternate",
          range: { startUtf16: 16, endUtf16: 26 },
        },
      ],
      replyToMessageId: "matrix-human-source",
      attachments: [],
    } as const;

    expect(isAuthorityWorkerRequest({
      type: "authority.message-submit",
      requestId: "worker-message-submit",
      context: { ...fixture.contexts.owner, requestId: "message-v2-first", idempotencyKey: "ignored-first" },
      message,
      now: 5_000,
    })).toBe(true);

    const accepted = await fixture.store.submitHumanMessage(
      { ...fixture.contexts.owner, requestId: "message-v2-first", idempotencyKey: "ignored-first" },
      message,
    );
    expect(accepted).toMatchObject({
      messageId: message.messageId,
      persistedAt: "1970-01-01T00:00:05.000Z",
      eventId: expect.stringMatching(/\S/),
      replayed: false,
      targetOutcomes: [
        {
          targetId: "target-human", targetActorId: "human-chen", kind: "human-request",
          status: "request-created", requestIntentId: expect.stringMatching(/\S/),
        },
        {
          targetId: "target-agent", targetActorId: "agent-review", kind: "agent-invocation",
          status: "invocation-intent-created", invocationIntentId: expect.stringMatching(/\S/),
        },
        {
          targetId: "target-nonmember", targetActorId: "human-alternate", kind: "human-request",
          status: "rejected", code: "target_not_member",
        },
      ],
    });
    const ackLossRepair = await fixture.client.acquireStreamingRepair(
      ownerSession,
      { kind: "room", roomId: message.roomId },
      5_000,
    );
    await expect(fixture.store.submitHumanMessage(
      { ...fixture.contexts.owner, requestId: "message-v2-ack-loss", idempotencyKey: "changed" },
      message,
    )).resolves.toEqual({ ...accepted, replayed: true });
    await fixture.client.releaseStreamingRepair(
      ownerSession,
      ackLossRepair.snapshotId,
      5_000,
    );
    await expect(fixture.store.submitHumanMessage(
      { ...fixture.contexts.owner, requestId: "message-v2-conflict", idempotencyKey: "changed-again" },
      { ...message, body: `${message.body}!` },
    )).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });

    const acceptedHeadDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const acceptedHead = acceptedHeadDatabase.prepare(
      `SELECT head_seq AS headSeq FROM streams
       WHERE stream_kind = 'room' AND stream_id = ?`,
    ).get(message.roomId) as { readonly headSeq: number };
    acceptedHeadDatabase.close();

    const revised = await fixture.store.reviseHumanMessage(
      { ...fixture.contexts.owner, requestId: "revision-first", idempotencyKey: "revision-v2-1" },
      {
        roomId: message.roomId, messageId: message.messageId, expectedRevision: 1,
        body: "@Chen @Reviewer @Alternate revised",
      },
    );
    expect(revised).toMatchObject({ messageId: message.messageId, revision: 2, replayed: false });
    await expect(fixture.store.reviseHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "revision-ack-loss",
        idempotencyKey: "changed-revision-key",
      },
      {
        roomId: message.roomId,
        messageId: message.messageId,
        expectedRevision: 1,
        body: "@Chen @Reviewer @Alternate revised",
      },
    )).resolves.toEqual({ ...revised, replayed: true });
    await expect(fixture.store.readHistory(ownerSession, message.roomId)).rejects.toMatchObject({
      status: 410,
      code: "protocol_upgrade_required",
    });
    await expect(fixture.store.reviseHumanMessage(
      { ...fixture.contexts.owner, requestId: "revision-stale", idempotencyKey: "revision-v2-stale" },
      { roomId: message.roomId, messageId: message.messageId, expectedRevision: 1, body: "stale" },
    )).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await expect(fixture.store.reviseHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "revision-version-conflict",
        idempotencyKey: "revision-v2-version-conflict",
      },
      { roomId: message.roomId, messageId: message.messageId, expectedRevision: 7, body: "stale" },
    )).rejects.toMatchObject({ status: 409, code: "message_version_conflict" });
    await expect(fixture.store.reviseHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "revision-invalid-range",
        idempotencyKey: "revision-v2-invalid-range",
      },
      { roomId: message.roomId, messageId: message.messageId, expectedRevision: 2, body: "x" },
    )).rejects.toMatchObject({ status: 400, code: "invalid_parameters" });

    const revisions = await fixture.store.readMessageRevisions(ownerSession, {
      roomId: message.roomId, messageId: message.messageId,
    });
    expect(revisions).toMatchObject({ hasMore: false, revisions: [
      { messageId: message.messageId, revision: 1, body: message.body },
      { messageId: message.messageId, revision: 2, body: "@Chen @Reviewer @Alternate revised" },
    ] });
    await expect(fixture.store.syncRoom(ownerSession, {
      type: "room.sync",
      requestId: "revised-message-stale-accepted",
      roomId: message.roomId,
      cursor: { version: 1, roomId: message.roomId, afterSeq: beforeMessageHead.headSeq },
    })).resolves.toMatchObject({
      mode: "repair_required",
      reason: "operational_projection_changed",
    });
    const revisedDelta = await fixture.store.syncRoom(ownerSession, {
      type: "room.sync",
      requestId: "revised-message-current-event",
      roomId: message.roomId,
      cursor: {
        version: 1,
        roomId: message.roomId,
        afterSeq: acceptedHead.headSeq,
      },
    });
    expect(revisedDelta).toMatchObject({
      mode: "delta",
      events: [{
        type: "room.message.revised",
        payload: { id: message.messageId, currentRevision: { revision: 2 } },
      }],
    });
    expect(JSON.stringify(await fixture.store.listPendingOutbox(10)))
      .not.toContain(recallRawSentinel);

    const recalled = await fixture.store.recallHumanMessage(
      { ...fixture.contexts.owner, requestId: "recall-first", idempotencyKey: "recall-v2-2" },
      { roomId: message.roomId, messageId: message.messageId, expectedRevision: 2 },
    );
    expect(recalled).toMatchObject({
      messageId: message.messageId, revision: 2, replayed: false, abortTargets: [],
    });
    await expect(fixture.store.recallHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "recall-ack-loss",
        idempotencyKey: "changed-recall-key",
      },
      { roomId: message.roomId, messageId: message.messageId, expectedRevision: 2 },
    )).resolves.toEqual({ ...recalled, replayed: true });
    const history = await fixture.store.readMessageHistory(ownerSession, {
      roomId: message.roomId,
    });
    expect(history).toMatchObject({
      lifecycle: "active",
      actors: expect.arrayContaining([
        { actorId: "human-li", kind: "human", displayName: "Lionel", secondaryLabel: "Owner" },
        { actorId: "human-chen", kind: "human", displayName: "Chen", secondaryLabel: "Member" },
        { actorId: "agent-review", kind: "agent", displayName: "Reviewer",
          secondaryLabel: "Active Agent" },
      ]),
    });
    expect(history.actors.some(({ actorId }) => actorId === "human-alternate")).toBe(false);
    expect(history.messages.find((entry) => entry.id === message.messageId)).toEqual({
      id: message.messageId,
      roomId: message.roomId,
      authorId: "human-li",
      authorKind: "human",
      createdAt: accepted.persistedAt,
      lifecycle: "recalled",
      recalledAt: recalled.recalledAt,
      revisionCount: 2,
    });
    expect(JSON.stringify(history)).not.toContain(recallRawSentinel);
    await expect(fixture.store.syncRoom(ownerSession, {
      type: "room.sync",
      requestId: "recalled-message-stale-cursor",
      roomId: message.roomId,
      cursor: { version: 1, roomId: message.roomId, afterSeq: beforeMessageHead.headSeq },
    })).resolves.toMatchObject({
      type: "room.sync.result",
      requestId: "recalled-message-stale-cursor",
      mode: "repair_required",
      reason: "operational_projection_changed",
    });

    await fixture.client.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      `SELECT body FROM message_revisions
       WHERE message_id = ? AND instr(body, ?) > 0`,
    ).all(message.messageId, recallRawSentinel)).toHaveLength(1);
    const messageEventPayloads = database.prepare(
      `SELECT event_type AS eventType, payload_json AS payloadJson
       FROM events
       WHERE stream_id = ?
         AND event_type IN ('room.message.accepted', 'room.message.revised', 'room.message.recalled')
         AND json_extract(payload_json, '$.id') = ?
       ORDER BY stream_seq`,
    ).all(message.roomId, message.messageId);
    expect(messageEventPayloads).toEqual([
      { eventType: "room.message.accepted", payloadJson: JSON.stringify({ id: message.messageId }) },
      { eventType: "room.message.revised", payloadJson: JSON.stringify({ id: message.messageId }) },
      { eventType: "room.message.recalled", payloadJson: JSON.stringify({ id: message.messageId }) },
    ]);
    expect(JSON.stringify(messageEventPayloads)).not.toContain(recallRawSentinel);
    expect(database.prepare(
      `SELECT event.event_type AS eventType, delivery.status
       FROM outbox_deliveries AS delivery
       JOIN events AS event ON event.event_id = delivery.event_id
       WHERE event.stream_id = ?
         AND event.event_type IN ('room.message.accepted', 'room.message.revised', 'room.message.recalled')
         AND json_extract(event.payload_json, '$.id') = ?
       ORDER BY event.stream_seq`,
    ).all(message.roomId, message.messageId)).toEqual([
      { eventType: "room.message.accepted", status: "dispatched" },
      { eventType: "room.message.revised", status: "dispatched" },
      { eventType: "room.message.recalled", status: "pending" },
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM message_target_outcomes WHERE message_id = ?",
    ).get(message.messageId)).toEqual({ count: 3 });
    expect(database.prepare(
      "SELECT status FROM human_request_intents WHERE source_message_id = ?",
    ).all(message.messageId)).toEqual([{ status: "cancelled" }]);
    expect(database.prepare(
      "SELECT status FROM agent_invocation_intents WHERE source_message_id = ?",
    ).all(message.messageId)).toEqual([{ status: "cancelled" }]);
    expect(database.prepare(
      `SELECT operational_state AS operationalState FROM message_attachment_links
       WHERE message_id = ?`,
    ).all(message.messageId)).toEqual([]);
    expect(database.prepare(
      `SELECT scope_kind AS scopeKind FROM message_recall_fences
       WHERE source_message_id = ? ORDER BY scope_kind DESC`,
    ).all(message.messageId)).toEqual([
      { scopeKind: "message" },
      { scopeKind: "invocation-intent" },
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE event_type IN ('room.message.accepted', 'room.message.revised', 'room.message.recalled') AND stream_id = ?",
    ).get(message.roomId)).toEqual({ count: 3 });
    const memorySources = database.prepare(
      `SELECT source_kind AS sourceKind, source_id AS sourceId,
              source_revision AS sourceRevision, eligibility, availability,
              safe_metadata_json AS safeMetadataJson, read_reference AS readReference
       FROM room_memory_sources
       WHERE room_id = ? AND json_extract(safe_metadata_json, '$.messageId') = ?
       ORDER BY corpus_seq`,
    ).all(message.roomId, message.messageId);
    expect(memorySources).toEqual([
      {
        sourceKind: "message",
        sourceId: `message:${message.messageId}`,
        sourceRevision: 1,
        eligibility: "excluded_revised",
        availability: "metadata_only",
        safeMetadataJson: JSON.stringify({ authorKind: "human", messageId: message.messageId }),
        readReference: `message-authority:${message.messageId}:revision:1`,
      },
      {
        sourceKind: "message_revision",
        sourceId: `message-revision:${message.messageId}`,
        sourceRevision: 2,
        eligibility: "excluded_recalled",
        availability: "metadata_only",
        safeMetadataJson: JSON.stringify({ authorKind: "human", messageId: message.messageId }),
        readReference: `message-authority:${message.messageId}:revision:2`,
      },
      {
        sourceKind: "message_tombstone",
        sourceId: `message-tombstone:${message.messageId}`,
        sourceRevision: 2,
        eligibility: "excluded_recalled",
        availability: "tombstone",
        safeMetadataJson: JSON.stringify({ messageId: message.messageId, lifecycle: "recalled" }),
        readReference: `message-authority:tombstone:${message.messageId}:revision:2`,
      },
    ]);
    expect(JSON.stringify(memorySources)).not.toContain(recallRawSentinel);
    expect(database.prepare(
      `SELECT corpus_head AS corpusHead FROM room_memory_stewards WHERE room_id = ?`,
    ).get(message.roomId)).toEqual({ corpusHead: 3 });
    database.close();
  });

  it("commits Agent finals and corrections only from current unfenced execution lineage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-agent-message-authority-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createCommandMatrixFixture(databasePath);
    await fixture.store.registerActors([{
      id: "agent-alternate",
      kind: "agent",
      displayName: "Alternate Agent",
      readiness: "ready",
      toolPermissions: [],
    }]);
    const alternateMembership = new DatabaseSync(databasePath);
    alternateMembership.prepare(
      `INSERT INTO room_memberships (
         room_id, actor_id, kind, role, participation, tool_permissions_json,
         joined_at, configured_at, access_revision
       ) VALUES (?, 'agent-alternate', 'agent', NULL, 'active', '[]', NULL, ?, 1)`,
    ).run(fixture.contexts.roomId, "2026-08-19T01:04:00.000Z");
    alternateMembership.exec(`
      UPDATE agent_profiles
      SET revision = revision + 1, status = 'enabled',
          updated_at = '2026-08-19T01:04:00.000Z', source_kind = 'administrator_command'
      WHERE actor_id = 'agent-alternate';
      INSERT INTO agent_profile_revisions (
        profile_id, revision, actor_id, display_name, global_responsibility, status,
        capability_ceiling_json, tool_ceiling_json, changed_by_human_actor_id,
        changed_at, operation
      ) SELECT id, revision, actor_id, display_name, global_responsibility, status,
               capability_ceiling_json, tool_ceiling_json, 'human-li',
               '2026-08-19T01:04:00.000Z', 'enable'
        FROM agent_profiles WHERE actor_id = 'agent-alternate';
      INSERT INTO room_agent_assignments (
        id, room_id, profile_id, agent_actor_id, revision, status, participation,
        paused, capability_subset_json, tool_subset_json, room_responsibility,
        created_at, updated_at, removed_at, source_kind
      ) SELECT 'matrix-assignment-agent-alternate', 'room-matrix', id, actor_id, 1,
               'current', 'active', 0, '[]', '[]', 'Answer in Matrix Room.',
               '2026-08-19T01:04:00.000Z', '2026-08-19T01:04:00.000Z', NULL,
               'room_command'
        FROM agent_profiles WHERE actor_id = 'agent-alternate';
      INSERT INTO room_agent_assignment_revisions (
        assignment_id, revision, room_id, profile_id, agent_actor_id,
        room_responsibility, status, participation, paused,
        capability_subset_json, tool_subset_json, changed_by_human_actor_id,
        changed_at, operation
      ) SELECT id, revision, room_id, profile_id, agent_actor_id,
               room_responsibility, status, participation, paused,
               capability_subset_json, tool_subset_json, 'human-li',
               '2026-08-19T01:04:00.000Z', 'create'
        FROM room_agent_assignments WHERE id = 'matrix-assignment-agent-alternate';
    `);
    alternateMembership.close();
    const ownerSession = {
      sessionId: fixture.contexts.owner.sessionId,
      sessionFamilyId: fixture.contexts.owner.sessionFamilyId,
      principal: fixture.contexts.owner.principal,
    };

    const submitAgentSource = async (
      messageId: string,
      requestId: string,
      targetAgentId = "agent-review",
    ) => {
      const mention = targetAgentId === "agent-review" ? "@Reviewer" : "@Other";
      const receipt = await fixture.store.submitHumanMessage(
        { ...fixture.contexts.owner, requestId, idempotencyKey: messageId },
        {
          messageId,
          roomId: fixture.contexts.roomId,
          body: `${mention} please answer`,
          mentionedTargets: [{
            id: `${messageId}-target`,
            kind: "agent-invocation",
            targetActorId: targetAgentId,
            range: { startUtf16: 0, endUtf16: mention.length },
          }],
          attachments: [],
        },
      );
      const outcome = receipt.targetOutcomes[0];
      if (outcome?.status !== "invocation-intent-created") {
        throw new Error("Expected an Agent invocation intent");
      }
      return outcome.invocationIntentId;
    };

    const finalSourceId = "message-agent-final-source";
    const finalIntentId = await submitAgentSource(finalSourceId, "submit-agent-final-source");
    claimMessageAuthorityExecution(databasePath, {
      intentId: finalIntentId,
      executionId: "execution-agent-final",
      roomId: fixture.contexts.roomId,
      sourceMessageId: finalSourceId,
      agentId: "agent-review",
      requesterActorId: "human-li",
    });
    const finalCommand = {
      messageId: "message-agent-final-v2",
      roomId: fixture.contexts.roomId,
      body: "The requested review is complete.",
    } as const;
    await expect(fixture.store.commitAgentMessage(
      mintInternalAgentMessageCommitContext({
        agentActorId: "agent-review",
        invocationIntentId: finalIntentId,
        executionId: "execution-agent-final",
        attemptSeq: 1,
        executionGeneration: 2,
      }),
      finalCommand,
    )).rejects.toMatchObject({ status: 409, code: "execution_conflict" });

    const finalContext = mintInternalAgentMessageCommitContext({
      agentActorId: "agent-review",
      invocationIntentId: finalIntentId,
      executionId: "execution-agent-final",
      attemptSeq: 1,
      executionGeneration: 1,
    });
    const finalReceipt = await fixture.store.commitAgentMessage(finalContext, finalCommand);
    expect(finalReceipt).toMatchObject({
      messageId: finalCommand.messageId,
      replayed: false,
      message: {
        id: finalCommand.messageId,
        authorId: "agent-review",
        authorKind: "agent",
        finalBody: finalCommand.body,
        sourceInvocationIntentId: finalIntentId,
        sourceExecutionId: "execution-agent-final",
      },
    });
    await expect(fixture.store.commitAgentMessage(finalContext, finalCommand)).resolves.toEqual({
      ...finalReceipt,
      replayed: true,
    });
    await expect(fixture.store.commitAgentMessage(
      {
        kind: "agent-message",
        agent: { actorId: "agent-review", kind: "agent" },
        invocationIntentId: finalIntentId,
        executionId: "execution-agent-final",
        attemptSeq: 1,
        executionGeneration: 1,
      } as never,
      { ...finalCommand, messageId: "message-agent-forged" },
    )).rejects.toMatchObject({
      status: 403,
      code: "agent_message_capability_forbidden",
    });

    const alternateSourceId = "message-agent-alternate-source";
    const alternateIntentId = await submitAgentSource(
      alternateSourceId,
      "submit-agent-alternate-source",
      "agent-alternate",
    );
    claimMessageAuthorityExecution(databasePath, {
      intentId: alternateIntentId,
      executionId: "execution-agent-alternate",
      roomId: fixture.contexts.roomId,
      sourceMessageId: alternateSourceId,
      agentId: "agent-alternate",
      requesterActorId: "human-li",
    });
    await expect(fixture.store.commitAgentMessage(
      mintInternalAgentMessageCommitContext({
        agentActorId: "agent-alternate",
        invocationIntentId: alternateIntentId,
        executionId: "execution-agent-alternate",
        attemptSeq: 1,
        executionGeneration: 1,
      }),
      {
        messageId: "message-agent-cross-author-correction",
        roomId: fixture.contexts.roomId,
        body: "A different Agent cannot correct this final.",
        correctsMessageId: finalCommand.messageId,
      },
    )).rejects.toMatchObject({ status: 409, code: "agent_final_immutable" });

    const correctionSourceId = "message-agent-correction-source";
    const correctionIntentId = await submitAgentSource(
      correctionSourceId,
      "submit-agent-correction-source",
    );
    claimMessageAuthorityExecution(databasePath, {
      intentId: correctionIntentId,
      executionId: "execution-agent-correction",
      roomId: fixture.contexts.roomId,
      sourceMessageId: correctionSourceId,
      agentId: "agent-review",
      requesterActorId: "human-li",
    });
    const correctionReceipt = await fixture.store.commitAgentMessage(
      mintInternalAgentMessageCommitContext({
        agentActorId: "agent-review",
        invocationIntentId: correctionIntentId,
        executionId: "execution-agent-correction",
        attemptSeq: 1,
        executionGeneration: 1,
      }),
      {
        messageId: "message-agent-correction-v2",
        roomId: fixture.contexts.roomId,
        body: "Correction: the review is complete with one caveat.",
        correctsMessageId: finalCommand.messageId,
      },
    );
    expect(correctionReceipt.message).toMatchObject({
      correctsMessageId: finalCommand.messageId,
      authorId: "agent-review",
    });
    await expect(
      fixture.store.readHistory(ownerSession, fixture.contexts.roomId),
    ).rejects.toMatchObject({ status: 410, code: "protocol_upgrade_required" });
    const completedSourceRecall = await fixture.store.recallHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "recall-completed-agent-source",
        idempotencyKey: finalSourceId,
      },
      {
        roomId: fixture.contexts.roomId,
        messageId: finalSourceId,
        expectedRevision: 1,
      },
    );
    expect(completedSourceRecall.abortTargets).toEqual([]);
    await expect(fixture.store.readMessageHistory(ownerSession, {
      roomId: fixture.contexts.roomId,
    })).resolves.toEqual(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ id: finalSourceId, lifecycle: "recalled" }),
        expect.objectContaining({ id: finalCommand.messageId, lifecycle: "active" }),
      ]),
    }));

    const recalledSourceId = "message-agent-recalled-source";
    const recalledIntentId = await submitAgentSource(
      recalledSourceId,
      "submit-agent-recalled-source",
    );
    claimMessageAuthorityExecution(databasePath, {
      intentId: recalledIntentId,
      executionId: "execution-agent-recalled",
      roomId: fixture.contexts.roomId,
      sourceMessageId: recalledSourceId,
      agentId: "agent-review",
      requesterActorId: "human-li",
    });
    const recallReceipt = await fixture.store.recallHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "recall-agent-source",
        idempotencyKey: recalledSourceId,
      },
      {
        roomId: fixture.contexts.roomId,
        messageId: recalledSourceId,
        expectedRevision: 1,
      },
    );
    expect(recallReceipt.abortTargets).toEqual([{
      sourceMessageId: recalledSourceId,
      sourceRevision: 1,
      invocationIntentId: recalledIntentId,
      executionId: "execution-agent-recalled",
      attemptSeq: 1,
      cancellationReason: "message_recalled",
      sideEffectState: "none",
    }]);
    await expect(fixture.store.commitAgentMessage(
      mintInternalAgentMessageCommitContext({
        agentActorId: "agent-review",
        invocationIntentId: recalledIntentId,
        executionId: "execution-agent-recalled",
        attemptSeq: 1,
        executionGeneration: 1,
      }),
      {
        messageId: "message-agent-after-recall",
        roomId: fixture.contexts.roomId,
        body: "This late result must never commit.",
      },
    )).rejects.toMatchObject({ status: 409, code: "execution_conflict" });

    await fixture.client.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      `SELECT message_id AS messageId, execution_id AS executionId
       FROM agent_message_sources ORDER BY message_id`,
    ).all()).toEqual([
      {
        messageId: "message-agent-correction-v2",
        executionId: "execution-agent-correction",
      },
      { messageId: finalCommand.messageId, executionId: "execution-agent-final" },
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE id = 'message-agent-after-recall'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM route_jobs
       WHERE source_message_id IN (?, ?)`,
    ).get(finalCommand.messageId, "message-agent-correction-v2")).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT status, cancellation_reason AS cancellationReason
       FROM agent_executions WHERE id = 'execution-agent-recalled'`,
    ).get()).toEqual({ status: "cancelled", cancellationReason: "message_recalled" });
    expect(database.prepare(
      `SELECT scope_kind AS scopeKind FROM message_recall_fences
       WHERE source_message_id = ? ORDER BY scope_kind`,
    ).all(recalledSourceId)).toEqual([
      { scopeKind: "execution" },
      { scopeKind: "invocation-intent" },
      { scopeKind: "message" },
    ]);
    expect(database.prepare(
      `SELECT source_id AS sourceId, source_revision AS sourceRevision,
              eligibility, availability
       FROM room_memory_sources
       WHERE source_id IN (?, ?, ?)
       ORDER BY source_id`,
    ).all(
      `message:${finalCommand.messageId}`,
      "message:message-agent-correction-v2",
      "message:message-agent-after-recall",
    )).toEqual([
      {
        sourceId: "message:message-agent-correction-v2",
        sourceRevision: 1,
        eligibility: "eligible",
        availability: "readable",
      },
      {
        sourceId: `message:${finalCommand.messageId}`,
        sourceRevision: 1,
        eligibility: "eligible",
        availability: "readable",
      },
    ]);
    database.close();
  });

  it("requires a protocol upgrade before legacy history can expose a recalled revision-one message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-recalled-legacy-history-"));
    temporaryDirectories.push(directory);
    const fixture = await createCommandMatrixFixture(
      join(directory, "authority.sqlite"),
    );
    const messageId = "message-recalled-revision-one";
    const ownerSession = {
      sessionId: fixture.contexts.owner.sessionId,
      sessionFamilyId: fixture.contexts.owner.sessionFamilyId,
      principal: fixture.contexts.owner.principal,
    };
    const repair = await fixture.client.acquireStreamingRepair(
      ownerSession,
      { kind: "room", roomId: fixture.contexts.roomId },
      5_000,
    );
    await expect(fixture.store.submitHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "submit-behind-repair",
        idempotencyKey: messageId,
      },
      {
        messageId,
        roomId: fixture.contexts.roomId,
        body: "recall this message",
        mentionedTargets: [],
        attachments: [],
      },
    )).rejects.toMatchObject({ status: 503, code: "repair_barrier_active" });
    await fixture.client.releaseStreamingRepair(
      ownerSession,
      repair.snapshotId,
      5_000,
    );
    await fixture.store.submitHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "submit-recalled-revision-one",
        idempotencyKey: messageId,
      },
      {
        messageId,
        roomId: fixture.contexts.roomId,
        body: "recall this message",
        mentionedTargets: [],
        attachments: [],
      },
    );
    await fixture.store.recallHumanMessage(
      {
        ...fixture.contexts.owner,
        requestId: "recall-revision-one",
        idempotencyKey: messageId,
      },
      { roomId: fixture.contexts.roomId, messageId, expectedRevision: 1 },
    );
    await expect(fixture.store.readHistory(ownerSession, fixture.contexts.roomId))
      .rejects.toMatchObject({
      status: 410,
      code: "protocol_upgrade_required",
      });
    await fixture.client.close();
  });
});
