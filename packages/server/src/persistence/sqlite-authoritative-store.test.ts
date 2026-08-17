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
  type IdentityAdapter,
  type LoginCredentials,
} from "../auth.js";
import { createAesGcmInvitationSecretProtector } from "../invitation-secret-protector.js";
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
import { migrateAuthorityDatabase } from "./schema.js";
import { createWorkerDatabaseClient } from "./worker-database-client.js";
import { isAuthorityWorkerRequest } from "./worker-protocol.js";

function tokenSequence(...tokens: readonly string[]): () => string {
  const remaining = [...tokens];
  return () => remaining.shift() ?? `unexpected-token-${remaining.length}`;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
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
      'room-command', 'human-li', 'human', 'owner', NULL, '[]',
      '2026-08-10T11:00:00.000Z', NULL, 0
    );
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
      ('room-facts', 'human-li', 'human', 'owner', NULL, '[]',
       '2026-08-10T13:00:00.000Z', NULL, 0),
      ('room-facts', 'agent-review', 'agent', NULL, 'active', '["review.read"]',
       NULL, '2026-08-10T13:00:00.000Z', 1);
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('room', 'room-facts', 0, 1);
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES
      ('message-human-source', 'room-facts', 'human-li', 'human', 'please review',
       '2026-08-10T13:01:00.000Z'),
      ('message-agent-source', 'room-facts', 'agent-review', 'agent', 'review complete',
       '2026-08-10T13:02:00.000Z');
  `);
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
      ('room-light-task', 'human-task-owner', 'human', 'owner', NULL, '[]', '2026-08-17T00:00:00.000Z', NULL, 0),
      ('room-light-task', 'human-task-claimant', 'human', 'member', NULL, '[]', '2026-08-17T00:00:00.000Z', NULL, 0),
      ('room-light-task', 'human-task-admin-a', 'human', 'admin', NULL, '[]', '2026-08-17T00:00:00.000Z', NULL, 0),
      ('room-light-task', 'human-task-admin-b', 'human', 'member', NULL, '[]', '2026-08-17T00:00:00.000Z', NULL, 0);
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('room', 'room-light-task', 0, 1);
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES ('message-light-task', 'room-light-task', 'human-task-owner', 'human',
            '需要一个明确承诺', '2026-08-17T00:00:01.000Z');
  `);
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
    ),
  });
  const ownerIssued = await authentication.login({ accountId: "account-li", secret: "correct" });
  const inviteeIssued = await authentication.login({ accountId: "account-invitee", secret: "correct" });
  const ownerSession = await authentication.authenticateSession(ownerIssued.accessToken);
  const inviteeSession = await authentication.authenticateSession(inviteeIssued.accessToken);
  await bootstrapClient.close();

  const database = new DatabaseSync(databasePath);
  database.exec(`
    INSERT INTO rooms (id, name, status, created_at)
    VALUES ('room-matrix', 'Matrix Room', 'active', '2026-08-10T14:00:00.000Z');
    INSERT INTO room_memberships (
      room_id, actor_id, kind, role, participation, tool_permissions_json,
      joined_at, configured_at, access_revision
    ) VALUES
      ('room-matrix', 'human-li', 'human', 'owner', NULL, '[]',
       '2026-08-10T14:00:00.000Z', NULL, 0),
      ('room-matrix', 'human-chen', 'human', 'member', NULL, '[]',
       '2026-08-10T14:00:00.000Z', NULL, 0),
      ('room-matrix', 'agent-review', 'agent', NULL, 'active', '["review.read"]',
       NULL, '2026-08-10T14:00:00.000Z', 1);
    INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
    VALUES ('room', 'room-matrix', 0, 1);
    INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
    VALUES
      ('matrix-human-source', 'room-matrix', 'human-li', 'human', 'please review',
       '2026-08-10T14:01:00.000Z'),
      ('matrix-agent-source', 'room-matrix', 'agent-review', 'agent', 'review complete',
       '2026-08-10T14:02:00.000Z');
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

describe("SQLite authoritative sessions", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
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
    it("commits one route job with the closed Agent membership snapshot before acknowledging", async () => {
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
          ('room-route', 'human-li', 'human', 'owner', NULL, '[]',
           '2026-08-17T10:00:00.000Z', NULL, 0),
          ('room-route', 'agent-review', 'agent', NULL, 'active', '["review.read"]',
           NULL, '2026-08-17T10:00:00.000Z', 1),
          ('room-route', 'agent-route-second', 'agent', NULL, 'on-mention', '["route.read"]',
           NULL, '2026-08-17T10:00:00.000Z', 1);
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
          agents: [
            { agentId: "agent-review", participation: "active", capabilities: ["review.read"] },
            { agentId: "agent-route-second", participation: "on-mention", capabilities: ["route.read"] },
          ],
          limits: { timeoutMs: 1_000, maxCandidates: 2, maxOutputBytes: 65_536 },
        },
        decisionContext: {
          directMentionAgentIds: ["agent-review", "agent-route-second"],
          structuredHelpAgentIds: [],
        },
      });
      await expect(client.executeRoute({
        type: "route.claim",
        sourceMessageId: command.payload.id,
        now: 2_101,
      })).rejects.toMatchObject({ status: 409, code: "route_conflict" });

      await authority.executeHuman(
        { ...context, requestId: "remove-route-agent", idempotencyKey: "remove-route-agent" },
        { type: "member.remove", roomId: "room-route", payload: { targetActorId: "agent-route-second" } },
      );
      const routeJobId = (claimed as { readonly job: { readonly id: string } }).job.id;
      const decidedAt = "1970-01-01T00:00:02.200Z";
      const judgments = ["agent-review", "agent-route-second"].map((agentId) => ({
        id: `judgment-${agentId}`,
        routeJobId,
        sourceMessageId: command.payload.id,
        agentId,
        outcome: "will_respond" as const,
        reasonCode: "direct_mention" as const,
        reasonText: "direct mandatory address",
        routeAttempt: 1 as const,
        decidedAt,
      }));
      const intents = ["agent-review", "agent-route-second"].map((targetAgentId) => ({
        kind: "direct_mention" as const,
        roomId: "room-route",
        sourceMessageId: command.payload.id,
        targetAgentId,
        reasonCode: "direct_mention" as const,
        reasonText: "direct mandatory address",
        priority: 1 as const,
      }));
      await expect(client.executeRoute({
        type: "route.complete",
        routeJobId,
        attempt: 1,
        judgments,
        intents,
        now: 2_200,
      })).resolves.toMatchObject({
        kind: "route-completed",
        job: { status: "completed" },
        intents: [{ targetAgentId: "agent-review" }],
      });

      const completedInspection = new DatabaseSync(databasePath, { readOnly: true });
      expect(completedInspection.prepare(
        `SELECT agent_id AS agentId, outcome, reason_code AS reasonCode
         FROM route_judgments ORDER BY agent_id`,
      ).all()).toEqual([
        { agentId: "agent-review", outcome: "will_respond", reasonCode: "direct_mention" },
        { agentId: "agent-route-second", outcome: "suppressed", reasonCode: "permission_denied" },
      ]);
      expect(completedInspection.prepare(
        `SELECT target_agent_id AS targetAgentId FROM route_invocation_intents`,
      ).all()).toEqual([{ targetAgentId: "agent-review" }]);
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
      await expect(client.executeRuntime(routedInvocation)).resolves.toMatchObject({
        kind: "invocation",
        replayed: false,
        execution: {
          id: "execution-routed-authoritative",
          requesterId: "human-li",
          agentId: "agent-review",
          status: "queued",
        },
      });
      await expect(client.executeRuntime({
        ...routedInvocation,
        executionId: "execution-routed-replay-unused",
        intentId: "intent-routed-replay-unused",
        now: 2_301,
      })).resolves.toMatchObject({
        kind: "invocation",
        replayed: true,
        execution: { id: "execution-routed-authoritative" },
      });
      await expect(client.executeRuntime({
        ...routedInvocation,
        intent: { ...routedInvocation.intent, targetAgentId: "agent-route-second" },
        executionId: "execution-routed-forbidden",
        intentId: "intent-routed-forbidden",
        now: 2_302,
      })).rejects.toMatchObject({ status: 403, code: "permission_denied" });

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
      const retryClaim1 = await client.executeRoute({
        type: "route.claim",
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
        sourceMessageId: retryCommand.payload.id,
        now: 3_349,
      })).rejects.toMatchObject({ status: 409, code: "route_conflict" });
      await client.executeRoute({
        type: "route.claim",
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
      const restartClaim = await client.executeRoute({
        type: "route.claim",
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
    archivedDatabase.prepare("UPDATE rooms SET status = 'archived' WHERE id = ?")
      .run(fixture.roomId);
    archivedDatabase.close();
    const archivedClient = await createWorkerDatabaseClient({ databasePath });
    const archivedAuthority = createSqliteAuthoritativeStore(archivedClient, { clock: () => 2_000 });
    await expect(archivedAuthority.canAccessRoom(session, fixture.roomId)).resolves.toBe(false);
    await expect(archivedAuthority.readRoomAudit(session, fixture.roomId))
      .rejects.toMatchObject({ status: 403, code: "room_forbidden" });
    await archivedClient.close();

    const removedDatabase = new DatabaseSync(databasePath);
    removedDatabase.prepare("UPDATE rooms SET status = 'active' WHERE id = ?").run(fixture.roomId);
    removedDatabase.prepare("DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?")
      .run(fixture.roomId, "human-li");
    removedDatabase.close();
    const removedClient = await createWorkerDatabaseClient({ databasePath });
    const removedAuthority = createSqliteAuthoritativeStore(removedClient, { clock: () => 2_000 });
    await expect(removedAuthority.canAccessRoom(session, fixture.roomId)).resolves.toBe(false);
    await expect(removedAuthority.readRoomAudit(session, fixture.roomId))
      .rejects.toMatchObject({ status: 403, code: "room_forbidden" });
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
    database.prepare("UPDATE room_audit SET details_json = ? WHERE room_id = ?")
      .run('{"actorId":"agent-review"}', fixture.roomId);
    database.close();

    const client = await createWorkerDatabaseClient({ databasePath });
    const authority = createSqliteAuthoritativeStore(client, { clock: () => 2_000 });
    const storageError = await authority.readRoomAudit(session, fixture.roomId).then(
      () => new Error("expected corrupt audit to fail"),
      (error: unknown) => error,
    );
    expect(storageError).toMatchObject({ status: 503, code: "storage_unavailable" });
    await expect(client.close()).rejects.toBe(storageError);
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
      removal.prepare(
        "DELETE FROM room_memberships WHERE room_id = 'room-facts' AND actor_id = 'human-li'",
      ).run();
      removal.close();
      const removedClient = await createWorkerDatabaseClient({ databasePath });
      const removedAuthority = createSqliteAuthoritativeStore(removedClient, { clock: () => 4_000 });
      await expect(removedAuthority.executeHuman(
        { ...fixture.humanContext, requestId: "removed-owner-answer", idempotencyKey: "removed-owner-answer" },
        { type: "open-item.transition", roomId: "room-facts", payload: {
          itemId: humanMention.aggregateId, action: "answer",
        } },
      )).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
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
      ).get()).toEqual({ count: 5 });
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
          database.exec(`
            DELETE FROM room_memberships
            WHERE room_id = 'room-light-task' AND actor_id = 'human-task-claimant';
            UPDATE room_memberships SET role = 'member'
            WHERE room_id = 'room-light-task' AND actor_id = 'human-task-owner';
          `);
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
    });
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
        "SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'agent-review' AND participation = 'silent'",
        ({ roomId }) => ({
          type: "agent.configure", roomId,
          payload: { agentId: "agent-review", participation: "silent", toolPermissions: ["review.read"] },
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
        "human.role.change",
        "human.role.changed",
        "SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'human-chen' AND role = 'admin'",
        ({ roomId }) => ({
          type: "human.role.change", roomId, payload: { targetActorId: "human-chen", role: "admin" },
        }),
        ({ roomId }) => ({
          type: "human.role.change", roomId, payload: { targetActorId: "human-chen", role: "member" },
        }),
        "owner",
        1,
        ["room", "principal"],
      ),
      humanMatrixCase(
        "member.remove",
        "member.removed",
        "SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'human-chen'",
        ({ roomId }) => ({
          type: "member.remove", roomId, payload: { targetActorId: "human-chen" },
        }),
        ({ roomId }) => ({
          type: "member.remove", roomId, payload: { targetActorId: "agent-review" },
        }),
        "owner",
        0,
        ["room", "principal"],
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
              participation: "silent",
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

    it("writes joined, updated, and removed Agent identity events without empty deliveries", async () => {
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
            participation: "silent",
            toolPermissions: ["review.read"],
          },
        },
      );
      const removed = await fixture.authority.executeHuman(
        { ...baseContext, requestId: "agent-removed", idempotencyKey: "agent-identity-removed" },
        {
          type: "member.remove",
          roomId: fixture.roomId,
          payload: { targetActorId: "agent-review" },
        },
      );
      expect(configured.eventIds).toHaveLength(2);
      expect(updated.eventIds).toHaveLength(2);
      expect(removed.eventIds).toHaveLength(2);
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
        { roomId: fixture.roomId, change: "removed" },
      ]);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM outbox_deliveries WHERE target_kind = 'principal' AND target_id = 'agent-review'",
      ).get()).toEqual({ count: 0 });
      database.close();
    });

    it("replays room.archive sequentially, concurrently, and after restart while rejecting extra payload fields", async () => {
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
        type: "room.archive",
        roomId: fixture.roomId,
        payload: {},
      } as const;

      const [first, concurrentReplay] = await Promise.all([
        fixture.authority.executeHuman(context, command),
        fixture.authority.executeHuman(
          { ...context, requestId: "archive-concurrent" },
          command,
        ),
      ]);
      expect(concurrentReplay).toEqual(first);
      expect(
        await fixture.authority.executeHuman(
          { ...context, requestId: "archive-sequential" },
          command,
        ),
      ).toEqual(first);
      const beforeInvalidPayload = authoritativeCountSnapshot(databasePath);
      await expect(
        fixture.authority.executeHuman(
          { ...context, requestId: "archive-invalid" },
          {
            ...command,
            payload: { reason: "not part of the closed command" },
          } as never,
        ),
      ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
      expect(authoritativeCountSnapshot(databasePath)).toEqual(beforeInvalidPayload);
      await fixture.client.close();

      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
        clock: () => 9_000,
      });
      await expect(
        restartedAuthority.executeHuman(
          { ...context, requestId: "archive-restart" },
          command,
        ),
      ).resolves.toEqual(first);
      await expect(
        restartedAuthority.executeHuman(
          { ...context, requestId: "archive-other-scope" },
          { ...command, roomId: `${fixture.roomId}-other` },
        ),
      ).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
      await restartedClient.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT COUNT(*) AS count FROM rooms WHERE status = 'archived'").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.archived'").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
        .toEqual({ count: 2 });
      expect(first.eventIds).toHaveLength(2);
      expect(new Set(first.eventIds).size).toBe(first.eventIds.length);
      const expectedTargets = ["room", "principal"] as const;
      for (const [index, eventId] of first.eventIds.entries()) {
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM events WHERE event_id = ?",
        ).get(eventId)).toEqual({ count: 1 });
        expect(database.prepare(
          `SELECT target_kind AS targetKind, target_id AS targetId
           FROM outbox_deliveries WHERE event_id = ?`,
        ).all(eventId)).toEqual([
          { targetKind: expectedTargets[index], targetId: expect.stringMatching(/\S/) },
        ]);
      }
      const placeholders = first.eventIds.map(() => "?").join(", ");
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM events WHERE event_id IN (${placeholders})`,
      ).get(...first.eventIds)).toEqual({ count: first.eventIds.length });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_deliveries WHERE event_id IN (${placeholders})`,
      ).get(...first.eventIds)).toEqual({ count: expectedTargets.length });
      database.close();
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

  it("persists invitation acceptance, role change, and removal while preserving authored messages", async () => {
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
      type: "human.role.change",
      roomId: created.aggregateId,
      payload: { targetActorId: "human-chen", role: "admin" },
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
    const removed = await authority.executeHuman(removeContext, removeCommand);
    expect(
      await authority.executeHuman(
        { ...removeContext, requestId: "member-remove-replay" },
        removeCommand,
      ),
    ).toEqual(removed);
    expect(removed.eventIds).toHaveLength(2);
    await expect(
      authority.executeHuman(
        { ...removeContext, requestId: "member-remove-conflict" },
        { ...removeCommand, payload: { targetActorId: "agent-review" } },
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    await client.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM room_memberships WHERE actor_id = 'human-chen'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE id = 'message-by-removed-member'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT catalog_revision AS catalogRevision FROM actors WHERE id = 'human-chen'")
        .get(),
    ).toEqual({ catalogRevision: 3 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type IN ('human.invitation.accepted', 'human.role.changed', 'member.removed')")
        .get(),
    ).toEqual({ count: 3 });
    database.close();
  });

  it("rechecks current room membership before replaying an old exact message acknowledgement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-replay-after-removal-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "authority.sqlite");
    const fixture = await createHumanCommandFixture(databasePath);
    await fixture.authority.executeHuman(fixture.context, messageCommand);
    await fixture.client.close();

    const database = new DatabaseSync(databasePath);
    database
      .prepare("DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?")
      .run(messageCommand.roomId, fixture.context.principal.actorId);
    database.close();

    const restartedClient = await createWorkerDatabaseClient({ databasePath });
    const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, {
      clock: () => 9_000,
    });
    await expect(
      restartedAuthority.executeHuman(
        { ...fixture.context, requestId: "message-replay-after-removal" },
        messageCommand,
      ),
    ).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
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
    membershipDatabase
      .prepare("DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?")
      .run(fixture.roomId, candidate.principal.actorId);
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
      ),
    });

    const issued = await auth.login({ accountId: "account-li", secret: "correct" });
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
    expect(rotatedContext.sessionFamilyId).toBe(firstContext.sessionFamilyId);
    expect(rotatedContext.sessionId).not.toBe(firstContext.sessionId);

    now = 3_000;
    await expect(auth.refresh(issued.refreshToken)).rejects.toMatchObject({
      status: 403,
      code: "session_revoked",
    });
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
      { eventType: "identity.session.issued", count: 1 },
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
        streamSeq: 4,
        status: "pending",
        attempts: 0,
      },
    ]);
    database.close();
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
});
