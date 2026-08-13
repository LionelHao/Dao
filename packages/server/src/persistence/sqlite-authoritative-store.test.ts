import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { isAgentExecution, type Actor, type AgentExecution } from "@native-im/core";
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
  mintInternalAgentRuntimeContext,
  parsePersistedRoomEvent,
  type AgentCollaborationCommand,
  type AgentRuntimeAuthorityStore,
  type AuthenticatedCommandContext,
  type CommandAcknowledgement,
  type CommandStore,
  type HumanCollaborationCommand,
  type InternalAgentRuntimeContext,
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

async function recoverAllAgentRuntimeExecutions(
  authority: Pick<AgentRuntimeAuthorityStore, "recoverPage">,
  runtime: InternalAgentRuntimeContext,
  now: number,
): Promise<readonly AgentExecution[]> {
  const executions: AgentExecution[] = [];
  let cursor: string | undefined;
  do {
    const page = await authority.recoverPage(runtime, {
      now, limit: 256, ...(cursor === undefined ? {} : { cursor }),
    });
    executions.push(...page.recoveries.map(({ execution }) => execution));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return executions;
}

const DEFAULT_TOOL_CALL_BINDING = {
  toolCallStepSeq: 1,
  toolPlanHash: createHash("sha256").update('{"toolId":"review.read"}').digest("hex"),
} as const;

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
      ('message-human-source-next', 'room-facts', 'human-li', 'human', 'please review next',
       '2026-08-10T13:01:30.000Z'),
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

async function checkpointToolCall(
  fixture: Awaited<ReturnType<typeof createAgentFactFixture>>,
  runtime: ReturnType<typeof mintInternalAgentRuntimeContext>,
  executionId: string,
  attemptSeq: number,
  now: number,
  parameterHash: string,
): Promise<void> {
  await fixture.authority.commitStep(runtime, {
    executionId, attemptSeq, stepSeq: 1, stepKind: "tool_call",
    canonicalToolCall: { toolId: "review.read" },
    inputSha256: "1".repeat(64), outputSha256: parameterHash, now,
  });
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
      id, room_id, source_message_id, assigned_actor_id, status, body,
      created_at, resolved_at, requester_actor_id, transfer_chain_json, responded_at
    ) VALUES (
      'matrix-open-existing', 'room-matrix', 'matrix-human-source', 'agent-review',
      'pending_response', 'respond to this', '2026-08-10T14:04:00.000Z', NULL,
      'human-li', '[]', NULL
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
        id: "message-human-source-next",
        roomId: "room-facts",
        authorId: "human-li",
        authorKind: "human",
        body: "please review next",
        sentAt: "2026-08-10T13:01:30.000Z",
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

      const database = new DatabaseSync(databasePath);
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
          sourceMessageId: "message-human-source",
          ownerId: "agent-review",
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
        payload: { itemId: created.aggregateId, action: "respond" },
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
                assigned_actor_id AS ownerId, transfer_chain_json AS transferChain,
                responded_at AS respondedAt
         FROM open_items`,
      ).get();
      expect(item).toEqual({
        status: "responded",
        requesterId: "human-li",
        ownerId: "agent-review",
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
  });

  describe("Agent execution authoritative facts", () => {
    it("Agent runtime authority requires the human requester to remain a current room member", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-human-membership-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      await fixture.client.close();
      const database = new DatabaseSync(databasePath);
      database.prepare(
        "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
      ).run("room-facts", "human-li");
      const before = database.prepare(
        `SELECT
           (SELECT COUNT(*) FROM agent_executions) AS executions,
           (SELECT COUNT(*) FROM agent_execution_attempts) AS attempts,
           (SELECT COUNT(*) FROM agent_invocation_intents) AS intents,
           (SELECT COUNT(*) FROM events) AS events,
           (SELECT COUNT(*) FROM outbox_deliveries) AS outbox`,
      ).get();
      database.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient, { clock: () => 3_000 });

      await expect(reopened.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source",
        targetAgentId: "agent-review", intentKind: "direct_mention",
        providerId: "provider-test", modelId: "model-test",
      })).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
      await reopenedClient.close();
      const afterDatabase = new DatabaseSync(databasePath, { readOnly: true });
      expect(afterDatabase.prepare(
        `SELECT
           (SELECT COUNT(*) FROM agent_executions) AS executions,
           (SELECT COUNT(*) FROM agent_execution_attempts) AS attempts,
           (SELECT COUNT(*) FROM agent_invocation_intents) AS intents,
           (SELECT COUNT(*) FROM events) AS events,
           (SELECT COUNT(*) FROM outbox_deliveries) AS outbox`,
      ).get()).toEqual(before);
      afterDatabase.close();
    });

    it("Agent runtime authority requires an internal Agent requester to remain a current room member", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-agent-membership-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      await fixture.client.close();
      const database = new DatabaseSync(databasePath);
      database.prepare(
        "DELETE FROM room_memberships WHERE room_id = ? AND actor_id = ?",
      ).run("room-facts", "agent-review");
      database.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient, { clock: () => 3_000 });

      await expect(reopened.invoke(mintInternalAgentCommandContext({
        agentId: "agent-review", requestId: "agent-invoke", idempotencyKey: "agent-invoke",
      }), {
        roomId: "room-facts", sourceMessageId: "message-agent-source",
        targetAgentId: "agent-review", intentKind: "direct_mention",
        providerId: "provider-test", modelId: "model-test",
      })).rejects.toMatchObject({ status: 403, code: "room_forbidden" });
      await reopenedClient.close();
    });

    it("Agent runtime authority invokes once per source and target with a queued attempt", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-invoke-"));
      temporaryDirectories.push(directory);
      const fixture = await createAgentFactFixture(join(directory, "authority.sqlite"));
      const input = {
        roomId: "room-facts",
        sourceMessageId: "message-human-source",
        targetAgentId: "agent-review",
        intentKind: "direct_mention" as const,
        providerId: "provider-test",
        modelId: "model-test",
      };
      const first = await fixture.authority.invoke(fixture.humanContext, input);
      const replay = await fixture.authority.invoke(fixture.humanContext, input);

      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        roomId: input.roomId,
        sourceMessageId: input.sourceMessageId,
        requesterId: "human-li",
        agentId: input.targetAgentId,
        status: "queued",
        actionCategory: "model_generation",
        currentAttemptSeq: 1,
        retryCycle: 1,
        retryOrdinal: 1,
        recoveryCursor: 0,
      });
      await fixture.client.close();
    });

    it("Agent runtime authority admits exact replay before enforcing the durable room cap", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-invoke-cap-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const common = {
        roomId: "room-facts",
        targetAgentId: "agent-review",
        intentKind: "direct_mention" as const,
        providerId: "provider-test",
        modelId: "model-test",
      };
      const first = await fixture.authority.invoke(
        fixture.humanContext,
        { ...common, sourceMessageId: "message-human-source" },
        1,
      );
      await fixture.authority.claimNext(
        mintInternalAgentRuntimeContext({ runtimeId: "runtime-cap", agentId: "agent-review" }),
        "room-facts",
        4_000,
      );
      const second = await fixture.authority.invoke(
        fixture.humanContext,
        { ...common, sourceMessageId: "message-human-source-next" },
        1,
      );
      await expect(
        fixture.authority.invoke(
          fixture.humanContext,
          { ...common, sourceMessageId: "message-human-source-next" },
          1,
        ),
      ).resolves.toEqual(second);
      const writer = new DatabaseSync(databasePath);
      writer.prepare(
        `INSERT INTO messages (id, room_id, author_id, author_kind, body, sent_at)
         VALUES (?, 'room-facts', 'human-li', 'human', 'overflow', ?)`,
      ).run("message-human-overflow", "2026-08-10T13:01:45.000Z");
      writer.close();
      await expect(
        fixture.authority.invoke(
          fixture.humanContext,
          { ...common, sourceMessageId: "message-human-overflow" },
          1,
        ),
      ).rejects.toMatchObject({ code: "target_busy", status: 429 });

      await fixture.client.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_executions").get())
        .toEqual({ count: 2 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_invocation_intents").get())
        .toEqual({ count: 2 });
      expect(first.id).not.toBe(second.id);
      database.close();
    });

    it.each(["paused", "noauth", "unconfigured", "silent_routed"] as const)(
      "Agent runtime authority rejects a %s target with zero writes across restart",
      async (condition) => {
        const directory = await mkdtemp(join(tmpdir(), `native-im-runtime-target-${condition}-`));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "authority.sqlite");
        const fixture = await createAgentFactFixture(databasePath);
        await fixture.client.close();
        const database = new DatabaseSync(databasePath);
        if (condition === "paused" || condition === "noauth") {
          database.prepare("UPDATE actors SET readiness = ? WHERE id = 'agent-review'").run(condition);
        } else if (condition === "unconfigured") {
          database.prepare("DELETE FROM room_memberships WHERE room_id = 'room-facts' AND actor_id = 'agent-review'").run();
        } else {
          database.prepare("UPDATE room_memberships SET participation = 'silent' WHERE room_id = 'room-facts' AND actor_id = 'agent-review'").run();
        }
        const before = authoritativeCountSnapshot(databasePath);
        database.close();
        const reopenedClient = await createWorkerDatabaseClient({ databasePath });
        const reopened = createSqliteAuthoritativeStore(reopenedClient, { clock: () => 3_000 });
        await expect(reopened.invoke(fixture.humanContext, {
          roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
          intentKind: condition === "silent_routed" ? "routed_candidate" : "direct_mention",
          providerId: "provider-test", modelId: "model-test",
        })).rejects.toMatchObject({ code: "room_member_not_found" });
        expect(authoritativeCountSnapshot(databasePath)).toEqual(before);
        await reopenedClient.close();
      },
    );

    it("Agent runtime direct mandatory invocation accepts a silent ready target", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-target-silent-direct-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      await fixture.client.close();
      const database = new DatabaseSync(databasePath);
      database.prepare("UPDATE room_memberships SET participation = 'silent' WHERE room_id = 'room-facts' AND actor_id = 'agent-review'").run();
      database.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient, { clock: () => 3_000 });
      await expect(reopened.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      })).resolves.toMatchObject({ status: "queued", agentId: "agent-review" });
      await reopenedClient.close();
    });

    it("Agent runtime authority deterministically upgrades invocation intent priority", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-intent-priority-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const base = {
        roomId: "room-facts", sourceMessageId: "message-human-source",
        targetAgentId: "agent-review", providerId: "provider-test", modelId: "model-test",
      } as const;
      const routed = await fixture.authority.invoke(fixture.humanContext, {
        ...base, intentKind: "routed_candidate",
      });
      await expect(fixture.authority.invoke(fixture.humanContext, {
        ...base, intentKind: "direct_mention",
      })).resolves.toEqual(routed);
      await expect(fixture.authority.invoke(fixture.humanContext, {
        ...base, intentKind: "structured_help",
      })).resolves.toEqual(routed);
      await expect(fixture.authority.invoke(fixture.humanContext, {
        ...base, intentKind: "direct_mention", modelId: "changed-model",
      })).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      await fixture.client.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        "SELECT intent_kind AS intentKind FROM agent_invocation_intents WHERE execution_id = ?",
      ).get(routed.id)).toEqual({ intentKind: "direct_mention" });
      database.close();
    });

    it("Agent runtime authority claims room executions in FIFO order exactly once", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-claim-"));
      temporaryDirectories.push(directory);
      const fixture = await createAgentFactFixture(join(directory, "authority.sqlite"));
      const common = {
        roomId: "room-facts",
        targetAgentId: "agent-review",
        intentKind: "direct_mention" as const,
        providerId: "provider-test",
        modelId: "model-test",
      };
      const first = await fixture.authority.invoke(fixture.humanContext, {
        ...common, sourceMessageId: "message-human-source",
      });
      const second = await fixture.authority.invoke(fixture.humanContext, {
        ...common, sourceMessageId: "message-human-source-next",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-fifo", agentId: "agent-review" });
      await fixture.client.close();
      const vacuum = new DatabaseSync(join(directory, "authority.sqlite"));
      vacuum.exec("VACUUM");
      const claimPlan = vacuum.prepare(
        `EXPLAIN QUERY PLAN
         SELECT execution.id
         FROM agent_execution_attempts AS attempt
         JOIN agent_executions AS execution
           ON execution.id = attempt.execution_id
          AND execution.current_attempt_seq = attempt.attempt_seq
         WHERE attempt.room_id = ? AND attempt.state = 'queued'
           AND execution.state = 'queued'
           AND (attempt.next_retry_at IS NULL OR attempt.next_retry_at <= ?)
         ORDER BY attempt.enqueue_stream_seq ASC LIMIT 1`,
      ).all("room-facts", 4_000) as readonly { readonly detail: string }[];
      expect(claimPlan.map((row) => row.detail)).not.toContain(
        "USE TEMP B-TREE FOR ORDER BY",
      );
      vacuum.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath: join(directory, "authority.sqlite") });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);

      await expect(reopened.claimNext(runtime, "room-facts", 4_000))
        .resolves.toMatchObject({ id: first.id, status: "running", startedAt: "1970-01-01T00:00:04.000Z" });
      await expect(reopened.claimNext(runtime, "room-facts", 5_000)).resolves.toBeUndefined();
      const interruptAuthority = createSqliteAuthoritativeStore(reopenedClient, { clock: () => 5_500 });
      await interruptAuthority.interrupt(fixture.humanContext, {
        executionId: first.id, reason: "requested_by_requester",
      });
      await expect(reopened.claimNext(runtime, "room-facts", 6_000))
        .resolves.toMatchObject({ id: second.id, status: "running", startedAt: "1970-01-01T00:00:06.000Z" });
      await expect(reopened.claimNext(runtime, "room-facts", 7_000)).resolves.toBeUndefined();
      await reopenedClient.close();
    });

    it("Agent runtime authority commits each checkpoint once with an attempt CAS", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-checkpoint-"));
      temporaryDirectories.push(directory);
      const fixture = await createAgentFactFixture(join(directory, "authority.sqlite"));
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-checkpoint", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      const input = {
        executionId: execution.id, attemptSeq: 1, stepSeq: 1, stepKind: "model_generation" as const,
        inputSha256: "a".repeat(64), outputSha256: "b".repeat(64), now: 5_000,
      };

      await expect(fixture.authority.commitStep(runtime, input))
        .resolves.toMatchObject({ id: execution.id, recoveryCursor: 1, status: "running" });
      await expect(fixture.authority.commitStep(runtime, input)).rejects.toMatchObject({ code: "execution_conflict" });
      await fixture.client.close();
    });

    it("Agent runtime provider context reloads the durable invocation and committed checkpoints", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-provider-context-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source",
        targetAgentId: "agent-review", intentKind: "structured_help",
        providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({
        runtimeId: "runtime-provider-context", agentId: "agent-review",
      });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 1,
        stepKind: "model_generation", inputSha256: "a".repeat(64),
        outputSha256: "b".repeat(64), now: 5_000,
      });
      await fixture.client.close();

      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(reopened.loadProviderContext(runtime, execution.id)).resolves.toEqual({
        invocation: {
          sourceMessageId: "message-human-source", requesterActorId: "human-li",
          targetAgentId: "agent-review", intentKind: "structured_help",
        },
        visibleConversation: [{
          messageId: "message-human-source", actorId: "human-li", body: "please review",
        }],
        committedSteps: [{
          stepSeq: 1, kind: "model_generation",
          modelInput: { inputSha256: "a".repeat(64), outputSha256: "b".repeat(64) },
        }],
      });
      const wrongRuntime = mintInternalAgentRuntimeContext({
        runtimeId: "runtime-provider-context-wrong", agentId: "agent-other",
      });
      await expect(reopened.loadProviderContext(wrongRuntime, execution.id))
        .rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
      await reopenedClient.close();
    });

    it("Agent runtime capabilities can claim and mutate only their bound Agent executions", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-agent-bound-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const right = mintInternalAgentRuntimeContext({ runtimeId: "runtime-right", agentId: "agent-review" });
      const wrong = mintInternalAgentRuntimeContext({ runtimeId: "runtime-wrong", agentId: "agent-other" });
      const beforeClaim = authoritativeCountSnapshot(databasePath);
      await expect(fixture.authority.claimNext(wrong, "room-facts", 4_000)).resolves.toBeUndefined();
      expect(authoritativeCountSnapshot(databasePath)).toEqual(beforeClaim);
      await fixture.authority.claimNext(right, "room-facts", 4_000);
      const beforeWrong = authoritativeCountSnapshot(databasePath);
      await expect(fixture.authority.commitStep(wrong, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 1, stepKind: "model_generation",
        inputSha256: "a".repeat(64), outputSha256: "b".repeat(64), now: 4_500,
      })).rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
      await expect(fixture.authority.scheduleRetry(wrong, {
        executionId: execution.id, attemptSeq: 1, errorCode: "upstream_timeout", now: 4_500,
      })).rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
      await expect(fixture.authority.completeExecution(wrong, {
        executionId: execution.id, attemptSeq: 1, messageId: "message-wrong-runtime",
        body: "forged", sentAt: "1970-01-01T00:00:04.500Z", now: 4_500,
      })).rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
      await expect(fixture.authority.cancelForHumanFence(wrong, {
        executionId: execution.id, fenceMessageId: "message-human-source", now: 4_500,
      })).rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
      expect(authoritativeCountSnapshot(databasePath)).toEqual(beforeWrong);
      await checkpointToolCall(fixture, right, execution.id, 1, 5_000, "a".repeat(64));
      await expect(fixture.authority.prepareTool(wrong, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "a".repeat(64), confirmationRequirement: "read_only",
        now: 5_250, expiresAt: 10_000,
      })).rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
      const grant = await fixture.authority.prepareTool(right, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "a".repeat(64), confirmationRequirement: "read_only",
        now: 5_250, expiresAt: 10_000,
      });
      await expect(fixture.authority.dispatchTool(wrong, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
        parameterHash: "a".repeat(64), confirmationRequirement: "read_only", now: 5_500,
      })).rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
      const dispatch = await fixture.authority.dispatchTool(right, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
        parameterHash: "a".repeat(64), confirmationRequirement: "read_only", now: 5_500,
      });
      await expect(fixture.authority.settleTool(wrong, {
        dispatchId: dispatch.id, executionId: execution.id, attemptSeq: 1, grantId: grant.id,
        outcome: "succeeded", now: 6_000,
      })).rejects.toMatchObject({ status: 403, code: "agent_capability_forbidden" });
      await expect(recoverAllAgentRuntimeExecutions(fixture.authority, wrong, 6_000)).resolves.toEqual([]);
      await fixture.client.close();
    });

    it("Agent runtime authority closes checkpoint phases before tool preparation", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-step-phases-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-step-phases", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      const before = authoritativeCountSnapshot(databasePath);
      await expect(fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "a".repeat(64), confirmationRequirement: "read_only",
        now: 4_500, expiresAt: 10_000,
      })).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
      expect(authoritativeCountSnapshot(databasePath)).toEqual(before);
      await expect(fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 1, stepKind: "tool_result",
        dispatchId: "dispatch-missing", boundedToolResult: { invalid: true }, inputSha256: "a".repeat(64),
        outputSha256: "b".repeat(64), now: 4_750,
      })).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
      expect(authoritativeCountSnapshot(databasePath)).toEqual(before);
      await expect(fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 1, stepKind: "tool_call",
        canonicalToolCall: { toolId: "review.read" }, inputSha256: "a".repeat(64),
        outputSha256: "a".repeat(64), now: 5_000,
      })).resolves.toMatchObject({
        actionCategory: "tool_call", toolDispatchPhase: "not_started", currentToolId: "review.read",
      });
      await expect(fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "a".repeat(64), confirmationRequirement: "read_only",
        now: 5_500, expiresAt: 10_000,
      })).resolves.toMatchObject({ toolId: "review.read" });
      const toolPhaseCounts = authoritativeCountSnapshot(databasePath);
      await expect(fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 2, stepKind: "model_generation",
        inputSha256: "a".repeat(64), outputSha256: "b".repeat(64), now: 6_000,
      })).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
      expect(authoritativeCountSnapshot(databasePath)).toEqual(toolPhaseCounts);
      await fixture.client.close();
    });

    it("Agent runtime authority atomically completes with one Agent message and closed execution event", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-complete-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-complete", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      const complete = (fixture.authority as unknown as {
        completeExecution(runtimeContext: typeof runtime, input: {
          readonly executionId: string; readonly attemptSeq: number; readonly messageId: string;
          readonly body: string; readonly sentAt: string; readonly now: number;
        }): Promise<import("@native-im/core").AgentExecution>;
      }).completeExecution.bind(fixture.authority);

      const exactCompletion = {
        executionId: execution.id, attemptSeq: 1, messageId: "message-agent-result",
        body: "Final answer body", sentAt: "1970-01-01T00:00:05.000Z", now: 5_000,
      } as const;
      const [firstComplete, concurrentReplay] = await Promise.all([
        complete(runtime, exactCompletion), complete(runtime, exactCompletion),
      ]);
      expect(firstComplete).toMatchObject({
        id: execution.id, status: "completed", resultMessageId: "message-agent-result",
      });
      expect(concurrentReplay).toEqual(firstComplete);
      await fixture.client.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT author_id AS authorId, body FROM messages WHERE id = ?")
        .get("message-agent-result")).toEqual({ authorId: "agent-review", body: "Final answer body" });
      const executionEvent = database.prepare(
        `SELECT payload_json AS payload FROM events
         WHERE event_type = 'room.agent_execution.changed'
         ORDER BY stream_seq DESC LIMIT 1`,
      ).get() as { readonly payload: string };
      expect(executionEvent.payload).not.toContain("Final answer body");
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.message.accepted' AND json_extract(payload_json, '$.id') = ?",
      ).get("message-agent-result")).toEqual({ count: 1 });
      database.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(reopened.completeExecution(runtime, exactCompletion)).resolves.toEqual(firstComplete);
      await expect(reopened.completeExecution(runtime, {
        ...exactCompletion, body: "changed body",
      })).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      await expect(reopened.completeExecution(runtime, {
        ...exactCompletion, messageId: "message-agent-result-changed",
      })).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      await reopenedClient.close();
    });

    it("Agent runtime authority schedules retry atomically with a new queued attempt", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-retry-"));
      temporaryDirectories.push(directory);
      const fixture = await createAgentFactFixture(join(directory, "authority.sqlite"));
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-retry", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await expect(fixture.authority.scheduleRetry(runtime, {
        executionId: execution.id, attemptSeq: 1, errorCode: "upstream_timeout", now: 5_000,
      })).resolves.toMatchObject({ currentAttemptSeq: 2, retryOrdinal: 2, status: "queued" });
      await expect(fixture.authority.claimNext(runtime, "room-facts", 5_999)).resolves.toBeUndefined();
      await expect(fixture.authority.claimNext(runtime, "room-facts", 6_000))
        .resolves.toMatchObject({ currentAttemptSeq: 2, retryOrdinal: 2, status: "running" });
      await expect(fixture.authority.scheduleRetry(runtime, {
        executionId: execution.id, attemptSeq: 1, errorCode: "upstream_timeout", now: 6_500,
      })).rejects.toMatchObject({ code: "execution_conflict" });
      await expect(fixture.authority.scheduleRetry(runtime, {
        executionId: execution.id, attemptSeq: 2, errorCode: "upstream_unavailable", now: 7_000,
      })).resolves.toMatchObject({ currentAttemptSeq: 3, retryOrdinal: 3, status: "queued" });
      await expect(fixture.authority.claimNext(runtime, "room-facts", 10_999)).resolves.toBeUndefined();
      await expect(fixture.authority.claimNext(runtime, "room-facts", 11_000))
        .resolves.toMatchObject({ currentAttemptSeq: 3, retryOrdinal: 3, status: "running" });
      await expect(fixture.authority.scheduleRetry(runtime, {
        executionId: execution.id, attemptSeq: 3, errorCode: "rate_limited", now: 12_000,
      })).resolves.toMatchObject({
        currentAttemptSeq: 3,
        retryOrdinal: 3,
        status: "failed",
        terminalErrorCode: "rate_limited",
        deadLetteredAt: "1970-01-01T00:00:12.000Z",
      });
      await expect(fixture.authority.claimNext(runtime, "room-facts", 20_000)).resolves.toBeUndefined();
      await fixture.client.close();
    });

    it("Agent runtime authority terminalizes a non-retryable provider failure atomically", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-terminal-failure-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({
        runtimeId: "runtime-terminal-failure",
        agentId: "agent-review",
      });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      const input = {
        executionId: execution.id,
        attemptSeq: 1,
        errorCode: "provider_invalid_response" as const,
        now: 5_000,
      };
      const failed = await fixture.authority.failExecution(runtime, input);
      expect(failed).toMatchObject({
        status: "failed",
        terminalErrorCode: "provider_invalid_response",
        currentAttemptSeq: 1,
      });
      await expect(fixture.authority.failExecution(runtime, input)).resolves.toEqual(failed);
      await fixture.client.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        "SELECT state, error_code AS errorCode FROM agent_execution_attempts WHERE execution_id = ? AND attempt_seq = 1",
      ).get(execution.id)).toEqual({ state: "failed", errorCode: "provider_invalid_response" });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.agent_execution.changed' AND json_extract(payload_json, '$.id') = ?",
      ).get(execution.id)).toEqual({ count: 3 });
      expect(database.prepare(
        "SELECT result_message_id AS resultMessageId FROM agent_executions WHERE id = ?",
      ).get(execution.id)).toEqual({ resultMessageId: null });
      database.close();

      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(reopened.failExecution(runtime, input)).resolves.toEqual(failed);
      await expect(reopened.failExecution(runtime, {
        ...input,
        errorCode: "provider_failure",
      })).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
      await reopenedClient.close();
    });

    it.each(["dispatched", "settled"] as const)(
      "Agent runtime authority refuses automatic retry for a %s side effect with zero writes",
      async (phase) => {
        const directory = await mkdtemp(join(tmpdir(), `native-im-runtime-side-effect-${phase}-`));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "authority.sqlite");
        const fixture = await createAgentFactFixture(databasePath);
        const execution = await fixture.authority.invoke(fixture.humanContext, {
          roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
          intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
        });
        const runtime = mintInternalAgentRuntimeContext({ runtimeId: `runtime-side-effect-${phase}`, agentId: "agent-review" });
        await fixture.authority.claimNext(runtime, "room-facts", 4_000);
        await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "9".repeat(64));
        const parameterHash = "9".repeat(64);
        const grant = await fixture.authority.prepareTool(runtime, {
          executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
          confirmationRequirement: "side_effect", now: 5_000, expiresAt: 10_000,
        });
        const confirmationAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_500 });
        const confirmation = await confirmationAuthority.confirmTool(fixture.humanContext, {
          executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
          target: "review target", impact: "updates remote review", reversibility: "irreversible",
          expiresAt: 9_000,
        });
        const dispatch = await fixture.authority.dispatchTool(runtime, {
          executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
          parameterHash, confirmationRequirement: "side_effect", confirmationId: confirmation.id,
          now: 6_000,
        });
        if (phase === "settled") {
          await fixture.authority.settleTool(runtime, {
            dispatchId: dispatch.id, executionId: execution.id, attemptSeq: 1, grantId: grant.id,
            outcome: "succeeded", closedSummary: "updated", now: 6_500,
          });
        }
        await fixture.client.close();
        const beforeDatabase = new DatabaseSync(databasePath, { readOnly: true });
        const before = beforeDatabase.prepare(
          `SELECT
             (SELECT json_object('state', state, 'attempt', current_attempt_seq,
                    'action', action_category, 'phase', tool_dispatch_phase)
                FROM agent_executions WHERE id = ?) AS execution,
             (SELECT json_group_array(json_object('attempt', attempt_seq, 'state', state,
                    'action', action_category, 'phase', tool_dispatch_phase, 'error', error_code))
                FROM agent_execution_attempts WHERE execution_id = ?) AS attempts,
             (SELECT json_group_array(json_object('id', id, 'state', state, 'settled', settled_at))
                FROM agent_tool_dispatches WHERE execution_id = ?) AS dispatches,
             (SELECT COUNT(*) FROM events) AS events,
             (SELECT COUNT(*) FROM outbox_deliveries) AS outbox`,
        ).get(execution.id, execution.id, execution.id);
        beforeDatabase.close();
        const reopenedClient = await createWorkerDatabaseClient({ databasePath });
        const reopened = createSqliteAuthoritativeStore(reopenedClient);

        await expect(reopened.scheduleRetry(runtime, {
          executionId: execution.id, attemptSeq: 1, errorCode: "runtime_restarted", now: 7_000,
        })).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
        await reopenedClient.close();
        const afterDatabase = new DatabaseSync(databasePath, { readOnly: true });
        expect(afterDatabase.prepare(
          `SELECT
             (SELECT json_object('state', state, 'attempt', current_attempt_seq,
                    'action', action_category, 'phase', tool_dispatch_phase)
                FROM agent_executions WHERE id = ?) AS execution,
             (SELECT json_group_array(json_object('attempt', attempt_seq, 'state', state,
                    'action', action_category, 'phase', tool_dispatch_phase, 'error', error_code))
                FROM agent_execution_attempts WHERE execution_id = ?) AS attempts,
             (SELECT json_group_array(json_object('id', id, 'state', state, 'settled', settled_at))
                FROM agent_tool_dispatches WHERE execution_id = ?) AS dispatches,
             (SELECT COUNT(*) FROM events) AS events,
             (SELECT COUNT(*) FROM outbox_deliveries) AS outbox`,
        ).get(execution.id, execution.id, execution.id)).toEqual(before);
        afterDatabase.close();
      },
    );

    it("Agent runtime authority commits a bounded read-only tool result and restart resumes model generation", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-read-tool-result-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-read-tool-result", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "8".repeat(64));
      const parameterHash = "8".repeat(64);
      const grant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
        confirmationRequirement: "read_only", now: 5_000, expiresAt: 10_000,
      });
      const dispatch = await fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
        parameterHash, confirmationRequirement: "read_only", now: 5_500,
      });
      await fixture.authority.settleTool(runtime, {
        dispatchId: dispatch.id, executionId: execution.id, attemptSeq: 1, grantId: grant.id,
        outcome: "succeeded", closedSummary: "read complete", now: 6_000,
      });
      await expect(fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 2, stepKind: "tool_result",
        dispatchId: dispatch.id, boundedToolResult: { ok: true, count: 1 },
        inputSha256: "a".repeat(64), outputSha256: "b".repeat(64), now: 6_500,
      })).resolves.toMatchObject({
        id: execution.id, status: "running", actionCategory: "model_generation",
        recoveryCursor: 2,
      });
      await fixture.client.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        `SELECT execution.action_category AS executionAction,
                execution.tool_dispatch_phase AS executionPhase,
                execution.current_tool_id AS executionTool,
                attempt.action_category AS attemptAction,
                attempt.tool_dispatch_phase AS attemptPhase,
                step.step_kind AS stepKind,
                step.bounded_tool_result_json AS boundedToolResult
         FROM agent_executions AS execution
         JOIN agent_execution_attempts AS attempt
           ON attempt.execution_id = execution.id AND attempt.attempt_seq = 1
         JOIN agent_execution_steps AS step
           ON step.execution_id = execution.id AND step.attempt_seq = 1 AND step.step_seq = 2
         WHERE execution.id = ?`,
      ).get(execution.id)).toEqual({
        executionAction: "model_generation", executionPhase: null, executionTool: null,
        attemptAction: "model_generation", attemptPhase: null, stepKind: "tool_result",
        boundedToolResult: '{"count":1,"ok":true}',
      });
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
      database.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(recoverAllAgentRuntimeExecutions(reopened, runtime, 7_000)).resolves.toEqual([
        expect.objectContaining({ id: execution.id, status: "queued", currentAttemptSeq: 2 }),
      ]);
      await reopenedClient.close();
    });

    it("Agent runtime tool-result checkpoint follows the latest dispatch in its attempt", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-latest-tool-result-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-latest-tool-result", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "a".repeat(64));
      const firstGrant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "a".repeat(64), confirmationRequirement: "read_only",
        now: 5_000, expiresAt: 20_000,
      });
      const firstDispatch = await fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: firstGrant.id, toolId: "review.read",
        parameterHash: "a".repeat(64), confirmationRequirement: "read_only", now: 5_500,
      });
      await fixture.authority.settleTool(runtime, {
        dispatchId: firstDispatch.id, executionId: execution.id, attemptSeq: 1, grantId: firstGrant.id,
        outcome: "succeeded", now: 6_000,
      });
      await fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 2, stepKind: "tool_result",
        dispatchId: firstDispatch.id, boundedToolResult: { ok: true }, inputSha256: "a".repeat(64),
        outputSha256: "b".repeat(64), now: 6_500,
      });
      await fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 3, stepKind: "tool_call",
        canonicalToolCall: { toolId: "review.read" }, inputSha256: "c".repeat(64),
        outputSha256: "e".repeat(64), now: 7_000,
      });
      const secondGrant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolCallStepSeq: 3,
        toolId: "review.read",
        parameterHash: "e".repeat(64), confirmationRequirement: "read_only",
        now: 7_500, expiresAt: 20_000,
      });
      const secondDispatch = await fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: secondGrant.id, toolId: "review.read",
        parameterHash: "e".repeat(64), confirmationRequirement: "read_only", now: 8_000,
      });
      await fixture.authority.settleTool(runtime, {
        dispatchId: secondDispatch.id, executionId: execution.id, attemptSeq: 1, grantId: secondGrant.id,
        outcome: "failed", now: 8_500,
      });
      const before = authoritativeCountSnapshot(databasePath);
      for (const dispatchId of [secondDispatch.id, firstDispatch.id, "dispatch-changed"]) {
        await expect(fixture.authority.commitStep(runtime, {
          executionId: execution.id, attemptSeq: 1, stepSeq: 4, stepKind: "tool_result",
          dispatchId, boundedToolResult: { ok: false }, inputSha256: "e".repeat(64),
          outputSha256: "f".repeat(64), now: 9_000,
        })).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
        expect(authoritativeCountSnapshot(databasePath)).toEqual(before);
      }
      await fixture.client.close();
    });

    it.each(["succeeded", "failed"] as const)(
      "Agent runtime authority closes a %s side-effect result safely",
      async (outcome) => {
        const directory = await mkdtemp(join(tmpdir(), `native-im-runtime-side-result-${outcome}-`));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "authority.sqlite");
        const fixture = await createAgentFactFixture(databasePath);
        const execution = await fixture.authority.invoke(fixture.humanContext, {
          roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
          intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
        });
        const runtime = mintInternalAgentRuntimeContext({ runtimeId: `runtime-side-result-${outcome}`, agentId: "agent-review" });
        await fixture.authority.claimNext(runtime, "room-facts", 4_000);
        await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "4".repeat(64));
        const parameterHash = "4".repeat(64);
        const grant = await fixture.authority.prepareTool(runtime, {
          executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
          confirmationRequirement: "side_effect", now: 5_000, expiresAt: 10_000,
        });
        const confirmationAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_500 });
        const confirmation = await confirmationAuthority.confirmTool(fixture.humanContext, {
          executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
          target: "review target", impact: "updates remote review", reversibility: "irreversible",
          expiresAt: 9_000,
        });
        const dispatch = await fixture.authority.dispatchTool(runtime, {
          executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
          parameterHash, confirmationRequirement: "side_effect", confirmationId: confirmation.id,
          now: 6_000,
        });
        await fixture.authority.settleTool(runtime, {
          dispatchId: dispatch.id, executionId: execution.id, attemptSeq: 1, grantId: grant.id,
          outcome, closedSummary: outcome, now: 6_500,
        });
        const commitment = fixture.authority.commitStep(runtime, {
          executionId: execution.id, attemptSeq: 1, stepSeq: 2, stepKind: "tool_result",
          dispatchId: dispatch.id, boundedToolResult: { outcome }, inputSha256: "a".repeat(64),
          outputSha256: "b".repeat(64), now: 7_000,
        });
        if (outcome === "succeeded") {
          await expect(commitment).resolves.toMatchObject({ actionCategory: "model_generation", status: "running" });
        } else {
          await expect(commitment).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
        }
        await fixture.client.close();
        if (outcome === "succeeded") {
          const restartedClient = await createWorkerDatabaseClient({ databasePath });
          const restarted = createSqliteAuthoritativeStore(restartedClient);
          await expect(recoverAllAgentRuntimeExecutions(restarted, runtime, 8_000)).resolves.toEqual([
            expect.objectContaining({ id: execution.id, status: "queued", currentAttemptSeq: 2,
              actionCategory: "model_generation" }),
          ]);
          await restartedClient.close();
        }
        const database = new DatabaseSync(databasePath, { readOnly: true });
        expect(() => migrateAuthorityDatabase(database)).not.toThrow();
        database.close();
      },
    );

    it("Agent runtime authority terminalizes an outcome-unknown side effect and forbids continuation", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-side-unknown-"));
      temporaryDirectories.push(directory);
      const fixture = await createAgentFactFixture(join(directory, "authority.sqlite"));
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-side-unknown", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "5".repeat(64));
      const parameterHash = "5".repeat(64);
      const grant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
        confirmationRequirement: "side_effect", now: 5_000, expiresAt: 10_000,
      });
      const confirmationAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_500 });
      const confirmation = await confirmationAuthority.confirmTool(fixture.humanContext, {
        executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
        target: "review target", impact: "updates remote review", reversibility: "irreversible",
        expiresAt: 9_000,
      });
      const dispatch = await fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
        parameterHash, confirmationRequirement: "side_effect", confirmationId: confirmation.id,
        now: 6_000,
      });
      await fixture.authority.settleTool(runtime, {
        dispatchId: dispatch.id, executionId: execution.id, attemptSeq: 1, grantId: grant.id,
        outcome: "outcome_unknown", closedSummary: "ambiguous", now: 6_500,
      });
      await expect(fixture.authority.readExecution({
        sessionId: fixture.humanContext.sessionId,
        sessionFamilyId: fixture.humanContext.sessionFamilyId,
        principal: fixture.humanContext.principal,
      }, execution.id)).resolves.toMatchObject({
        status: "failed", terminalErrorCode: "side_effect_outcome_unknown",
      });
      await expect(fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 1, stepKind: "tool_result",
        dispatchId: dispatch.id, boundedToolResult: { outcome: "unknown" }, inputSha256: "a".repeat(64),
        outputSha256: "b".repeat(64), now: 7_000,
      })).rejects.toMatchObject({ code: "execution_conflict" });
      await fixture.client.close();
    });

    it.each(["succeeded", "failed", "outcome_unknown"] as const)(
      "Agent runtime authority publishes one bounded observable %s settlement without sealed compensation",
      async (outcome) => {
        const directory = await mkdtemp(join(tmpdir(), `native-im-runtime-settle-event-${outcome}-`));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "authority.sqlite");
        const fixture = await createAgentFactFixture(databasePath);
        const execution = await fixture.authority.invoke(fixture.humanContext, {
          roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
          intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
        });
        const runtime = mintInternalAgentRuntimeContext({ runtimeId: `runtime-settle-event-${outcome}`, agentId: "agent-review" });
        await fixture.authority.claimNext(runtime, "room-facts", 4_000);
        await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "3".repeat(64));
        const grant = await fixture.authority.prepareTool(runtime, {
          executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
          parameterHash: "3".repeat(64), confirmationRequirement: "read_only",
          now: 5_000, expiresAt: 10_000,
        });
        const dispatch = await fixture.authority.dispatchTool(runtime, {
          executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
          parameterHash: "3".repeat(64), confirmationRequirement: "read_only", now: 5_500,
        });
        const input = {
          dispatchId: dispatch.id, executionId: execution.id, attemptSeq: 1, grantId: grant.id,
          outcome, closedSummary: "bounded", sealedCompensation: "sealed-private-token", now: 6_000,
        } as const;
        const first = await fixture.authority.settleTool(runtime, input);
        await expect(fixture.authority.settleTool(runtime, input)).resolves.toEqual(first);
        const eventDatabase = new DatabaseSync(databasePath, { readOnly: true });
        const settlementSequence = Number(eventDatabase.prepare(
          `SELECT stream_seq AS streamSeq FROM events
           WHERE event_type = 'room.agent_tool_dispatch.changed'`,
        ).get()?.streamSeq);
        const storedRoomEvents = eventDatabase.prepare(
          `SELECT event_id AS eventId, stream_kind AS streamKind, stream_id AS streamId,
                  stream_seq AS streamSeq, room_id AS roomId, actor_id AS actorId,
                  occurred_at AS occurredAt, event_type AS type, payload_json AS payloadJson
           FROM events WHERE stream_kind = 'room' ORDER BY stream_seq`,
        ).all() as readonly Record<string, unknown>[];
        for (const stored of storedRoomEvents) {
          const { payloadJson, ...envelope } = stored;
          expect(parsePersistedRoomEvent({ ...envelope, payload: JSON.parse(String(payloadJson)) }),
            `stored event ${JSON.stringify(envelope)} ${String(payloadJson)}`)
            .toMatchObject({ ok: true });
        }
        eventDatabase.close();
        const synchronized = await fixture.authority.syncRoom({
          sessionId: fixture.humanContext.sessionId,
          sessionFamilyId: fixture.humanContext.sessionFamilyId,
          principal: fixture.humanContext.principal,
        }, {
          type: "room.sync", requestId: `settlement-sync-${outcome}`, roomId: "room-facts",
          cursor: { version: 1, roomId: "room-facts", afterSeq: settlementSequence - 1 }, limit: 100,
        });
        expect(synchronized).toMatchObject({ mode: "delta" });
        expect(JSON.stringify(synchronized)).toContain("room.agent_tool_dispatch.changed");
        expect(JSON.stringify(synchronized)).not.toContain("sealed-private-token");
        const pending = await createSqliteAuthoritativeStore(fixture.client, { clock: () => 7_000 })
          .listPendingOutbox(100);
        expect(JSON.stringify(pending)).toContain("room.agent_tool_dispatch.changed");
        expect(JSON.stringify(pending)).not.toContain("sealed-private-token");
        await fixture.client.close();
        const database = new DatabaseSync(databasePath, { readOnly: true });
        const events = database.prepare(
          `SELECT payload_json AS payload FROM events
           WHERE event_type = 'room.agent_tool_dispatch.changed'`,
        ).all() as readonly { readonly payload: string }[];
        expect(events).toHaveLength(1);
        expect(JSON.parse(events[0]!.payload)).toMatchObject({ id: dispatch.id, state: outcome });
        expect(events[0]!.payload).not.toContain("sealed-private-token");
        expect(database.prepare(
          `SELECT COUNT(*) AS count FROM outbox_deliveries AS delivery
           JOIN events AS event ON event.event_id = delivery.event_id
           WHERE event.event_type = 'room.agent_tool_dispatch.changed'`,
        ).get()).toEqual({ count: 1 });
        database.close();
      },
    );

    it("Agent runtime authority interrupts idempotently and manual retry creates a new execution", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-interrupt-"));
      temporaryDirectories.push(directory);
      const fixture = await createAgentFactFixture(join(directory, "authority.sqlite"));
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-interrupt", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      const interruptAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_000 });
      const interrupted = await interruptAuthority.interrupt(fixture.humanContext, {
        executionId: execution.id, reason: "requested_by_requester",
      });
      expect(interrupted).toMatchObject({ status: "cancelled", cancellationReason: "requested_by_requester" });
      await expect(interruptAuthority.interrupt(fixture.humanContext, {
        executionId: execution.id, reason: "requested_by_requester",
      })).resolves.toEqual(interrupted);
      await expect(fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 1, stepKind: "model_generation",
        inputSha256: "a".repeat(64), outputSha256: "b".repeat(64), now: 6_000,
      })).rejects.toMatchObject({ code: "execution_conflict" });

      const failed = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source-next", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      await fixture.authority.claimNext(runtime, "room-facts", 7_000);
      await fixture.authority.scheduleRetry(runtime, {
        executionId: failed.id, attemptSeq: 1, errorCode: "upstream_timeout", now: 8_000,
      });
      await fixture.authority.claimNext(runtime, "room-facts", 9_000);
      await fixture.authority.scheduleRetry(runtime, {
        executionId: failed.id, attemptSeq: 2, errorCode: "upstream_timeout", now: 10_000,
      });
      await fixture.authority.claimNext(runtime, "room-facts", 14_000);
      await fixture.authority.scheduleRetry(runtime, {
        executionId: failed.id, attemptSeq: 3, errorCode: "upstream_timeout", now: 15_000,
      });
      const retryAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 16_000 });
      const retried = await retryAuthority.manualRetry(fixture.humanContext, failed.id);
      expect(retried).toMatchObject({
        status: "queued", currentAttemptSeq: 1, retryOrdinal: 1,
        manualRetryOfExecutionId: failed.id,
      });
      await expect(retryAuthority.manualRetry(fixture.humanContext, failed.id)).resolves.toEqual(retried);
      await fixture.client.close();
    });

    it("Agent runtime authority recovers a running model attempt without reviving the old attempt", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-recover-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-recover", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await fixture.client.close();

      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(recoverAllAgentRuntimeExecutions(reopened, runtime, 5_000)).resolves.toEqual([
        expect.objectContaining({ id: execution.id, status: "queued", currentAttemptSeq: 2, retryOrdinal: 2 }),
      ]);
      await expect(reopened.claimNext(runtime, "room-facts", 5_999)).resolves.toBeUndefined();
      await expect(reopened.claimNext(runtime, "room-facts", 6_000))
        .resolves.toMatchObject({ id: execution.id, currentAttemptSeq: 2, status: "running" });
      await reopenedClient.close();
    });

    it("Agent runtime authority pages recovery with a stable keyset across restart and unrelated agents", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-recovery-pages-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      await fixture.client.close();

      const database = new DatabaseSync(databasePath);
      database.exec(`
        INSERT INTO actors (id, kind, display_name)
        VALUES ('agent-unrelated-recovery', 'agent', 'Unrelated recovery Agent');
        INSERT INTO streams (stream_kind, stream_id, head_seq, retained_from_seq)
        VALUES ('identity', 'agent-unrelated-recovery', 0, 1);
        WITH RECURSIVE seq(value) AS (
          VALUES (1) UNION ALL SELECT value + 1 FROM seq WHERE value < 10000
        )
        INSERT INTO agent_executions (
          id, room_id, agent_id, source_message_id, requester_actor_id, state,
          action_category, tool_dispatch_phase, current_tool_id,
          current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
          recovery_cursor, queued_at, started_at, updated_at, completed_at,
          cancellation_reason, terminal_error_code, dead_lettered_at, result_message_id,
          manual_retry_of_execution_id, compensates_execution_id,
          supersedes_execution_ids_json, legacy_result_json
        )
        SELECT printf('unrelated-recovery-%05d', value), 'room-facts',
               'agent-unrelated-recovery', 'message-human-source', 'human-li',
               'queued', 'model_generation', NULL, NULL, 1, 1, 2,
               'provider-test', 'model-test', 0,
               '1970-01-01T00:00:03.000Z', NULL, '1970-01-01T00:00:03.000Z',
               NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', NULL
        FROM seq;
        WITH RECURSIVE seq(value) AS (
          VALUES (1) UNION ALL SELECT value + 1 FROM seq WHERE value < 5
        )
        INSERT INTO agent_executions (
          id, room_id, agent_id, source_message_id, requester_actor_id, state,
          action_category, tool_dispatch_phase, current_tool_id,
          current_attempt_seq, retry_cycle, retry_ordinal, provider_id, model_id,
          recovery_cursor, queued_at, started_at, updated_at, completed_at,
          cancellation_reason, terminal_error_code, dead_lettered_at, result_message_id,
          manual_retry_of_execution_id, compensates_execution_id,
          supersedes_execution_ids_json, legacy_result_json
        )
        SELECT printf('target-recovery-%02d', value), 'room-facts',
               'agent-review', 'message-human-source', 'human-li',
               'queued', 'model_generation', NULL, NULL, 1, 1, 2,
               'provider-test', 'model-test', 0,
               '1970-01-01T00:00:03.000Z', NULL, '1970-01-01T00:00:03.000Z',
               NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', NULL
        FROM seq;
        INSERT INTO agent_execution_attempts (
          execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
          action_category, tool_dispatch_phase, started_at, finished_at,
          error_code, next_retry_at, recovery_cursor, enqueue_stream_seq
        )
        SELECT id, room_id, 1, 1, 2, 'queued', 'model_generation', NULL,
               NULL, NULL, NULL, 0, 0, 1
        FROM agent_executions
        WHERE id LIKE 'unrelated-recovery-%' OR id LIKE 'target-recovery-%';
      `);
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
      for (const state of ["queued", "running"] as const) {
        const explain = database.prepare(
          `EXPLAIN QUERY PLAN
           SELECT execution.id
           FROM agent_executions AS execution INDEXED BY agent_executions_agent_state_id
           WHERE execution.agent_id = ? AND execution.state = ?
             AND execution.id > ?
           ORDER BY execution.id LIMIT ?`,
        ).all("agent-review", state, "", 2).map((row) => String(row.detail));
        expect(explain.some((detail) =>
          detail.includes("agent_executions_agent_state_id") && detail.includes("SEARCH execution"),
        )).toBe(true);
        expect(explain.join("\n")).not.toMatch(/SCAN execution|AUTOMATIC|TEMP B-TREE/);
      }
      database.close();

      const runtime = mintInternalAgentRuntimeContext({
        runtimeId: "runtime-recovery-pages",
        agentId: "agent-review",
      });
      let client = await createWorkerDatabaseClient({ databasePath });
      let authority = createSqliteAuthoritativeStore(client);
      let cursor: string | undefined;
      let restarted = false;
      const recoveredIds: string[] = [];
      do {
        const page = await authority.recoverPage(runtime, {
          now: 10_000, limit: 2, ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.recoveries.length).toBeLessThanOrEqual(2);
        recoveredIds.push(...page.recoveries.map(({ execution }) => execution.id));
        cursor = page.nextCursor;
        if (!restarted && recoveredIds.length === 2) {
          await client.close();
          client = await createWorkerDatabaseClient({ databasePath });
          authority = createSqliteAuthoritativeStore(client);
          restarted = true;
        }
      } while (cursor !== undefined);
      await client.close();
      expect(restarted).toBe(true);
      expect(recoveredIds).toEqual([
        "target-recovery-01", "target-recovery-02", "target-recovery-03",
        "target-recovery-04", "target-recovery-05",
      ]);
      expect(new Set(recoveredIds).size).toBe(recoveredIds.length);
    });

    it("Agent runtime recovery returns a future retry deadline after a worker restart", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-recovery-future-retry-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({
        runtimeId: "runtime-recovery-future-retry",
        agentId: "agent-review",
      });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      const retried = await fixture.authority.scheduleRetry(runtime, {
        executionId: execution.id, attemptSeq: 1, errorCode: "upstream_timeout", now: 5_000,
      });
      await fixture.client.close();

      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(reopened.recoverPage(runtime, { now: 5_500, limit: 1 })).resolves.toEqual({
        recoveries: [{ execution: retried, nextRetryAt: 6_000 }],
        nextCursor: expect.any(String),
      });
      await reopenedClient.close();
    });

    it("Agent runtime pages exact expired confirmations without holes or duplicates", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-expired-pages-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      await fixture.client.close();

      const database = new DatabaseSync(databasePath);
      database.exec(`
        WITH RECURSIVE seq(value) AS (
          VALUES (1) UNION ALL SELECT value + 1 FROM seq WHERE value < 257
        )
        INSERT INTO agent_executions (
          id, room_id, agent_id, source_message_id, requester_actor_id, state,
          action_category, current_attempt_seq, retry_cycle, retry_ordinal,
          provider_id, model_id, recovery_cursor, queued_at, started_at, updated_at
        )
        SELECT printf('expired-page-%03d', value), 'room-facts', 'agent-review',
               'message-human-source', 'human-li', 'running', 'waiting_upstream',
               1, 1, 1, 'provider-test', 'model-test', 1,
               '1970-01-01T00:00:03.000Z', '1970-01-01T00:00:04.000Z',
               '1970-01-01T00:00:04.000Z'
        FROM seq;
        INSERT INTO agent_execution_attempts (
          execution_id, room_id, attempt_seq, retry_cycle, retry_ordinal, state,
          action_category, started_at, recovery_cursor
        )
        SELECT id, room_id, 1, 1, 1, 'running', 'waiting_upstream',
               '1970-01-01T00:00:04.000Z', 1
        FROM agent_executions WHERE id LIKE 'expired-page-%';
        INSERT INTO agent_execution_steps (
          execution_id, attempt_seq, step_seq, step_kind, canonical_tool_call_json,
          input_sha256, output_sha256, completed_at
        )
        SELECT id, 1, 1, 'tool_call', '{"toolId":"review.read"}',
               '${"a".repeat(64)}', '${"a".repeat(64)}',
               '1970-01-01T00:00:04.000Z'
        FROM agent_executions WHERE id LIKE 'expired-page-%';
        INSERT INTO agent_tool_grants (
          id, execution_id, attempt_seq, tool_call_step_seq, agent_id, room_id,
          tool_id, parameter_hash, tool_plan_hash, confirmation_requirement,
          issued_at, expires_at
        )
        SELECT 'grant-' || id, id, 1, 1, 'agent-review', 'room-facts', 'review.read',
               '${"a".repeat(64)}', '${"a".repeat(64)}', 'side_effect',
               '1970-01-01T00:00:04.000Z', '1970-01-01T00:00:05.000Z'
        FROM agent_executions WHERE id LIKE 'expired-page-%';
      `);
      expect(() => migrateAuthorityDatabase(database)).not.toThrow();
      database.close();

      const client = await createWorkerDatabaseClient({ databasePath });
      const authority = createSqliteAuthoritativeStore(client);
      const runtime = mintInternalAgentRuntimeContext({
        runtimeId: "runtime-expired-pages",
        agentId: "agent-review",
      });
      const recoveredIds: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await authority.recoverPage(runtime, {
          now: 6_000, limit: 64, ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.recoveries.length).toBeLessThanOrEqual(64);
        recoveredIds.push(...page.recoveries.map(({ execution }) => execution.id));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      await client.close();

      expect(recoveredIds).toHaveLength(257);
      expect(new Set(recoveredIds).size).toBe(257);
      expect(recoveredIds).toEqual(
        Array.from({ length: 257 }, (_, index) => `expired-page-${String(index + 1).padStart(3, "0")}`),
      );
    });

    it("Agent runtime authority atomically confirms, dispatches, and late-settles a cancelled side effect", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-tool-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-tool", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "c".repeat(64));
      const parameterHash = "c".repeat(64);
      const grant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
        confirmationRequirement: "side_effect", now: 5_000, expiresAt: 10_000,
      });
      await expect(fixture.authority.readExecution({
        sessionId: fixture.humanContext.sessionId,
        sessionFamilyId: fixture.humanContext.sessionFamilyId,
        principal: fixture.humanContext.principal,
      }, execution.id)).resolves.toMatchObject({
        actionCategory: "waiting_upstream",
        status: "running",
      });
      const confirmationRequiredSync = await fixture.authority.syncRoom({
        sessionId: fixture.humanContext.sessionId,
        sessionFamilyId: fixture.humanContext.sessionFamilyId,
        principal: fixture.humanContext.principal,
      }, {
        type: "room.sync", requestId: "confirmation-required-sync", roomId: "room-facts",
        cursor: { version: 1, roomId: "room-facts", afterSeq: 0 }, limit: 100,
      });
      expect(JSON.stringify(confirmationRequiredSync)).toContain("room.agent_tool_confirmation.required");
      expect(JSON.stringify(await createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_250 })
        .listPendingOutbox(100))).toContain("room.agent_tool_confirmation.required");
      const confirmationAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_500 });
      const confirmation = await confirmationAuthority.confirmTool(fixture.humanContext, {
        executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
        target: "review target", impact: "updates remote review", reversibility: "compensatable",
        expiresAt: 9_000,
      });
      await expect(fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id,
        toolId: "review.read", parameterHash, confirmationRequirement: "read_only", now: 5_750,
      })).rejects.toMatchObject({ code: "execution_conflict" });
      const dispatch = await fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id,
        toolId: "review.read", parameterHash, confirmationRequirement: "side_effect",
        confirmationId: confirmation.id, now: 6_000,
      });
      expect(grant).toMatchObject({ confirmationRequirement: "side_effect" });
      expect(dispatch).toMatchObject({ state: "dispatched", grantId: grant.id });
      await expect(fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id,
        toolId: "review.read", parameterHash, confirmationRequirement: "side_effect",
        confirmationId: confirmation.id, now: 6_500,
      })).rejects.toMatchObject({ code: "execution_conflict" });

      const interruptAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 7_000 });
      await interruptAuthority.interrupt(fixture.humanContext, {
        executionId: execution.id, reason: "requested_by_requester",
      });
      await expect(fixture.authority.settleTool(runtime, {
        dispatchId: dispatch.id, executionId: execution.id, attemptSeq: 1, grantId: grant.id,
        outcome: "succeeded", closedSummary: "updated", sealedCompensation: "sealed-token", now: 8_000,
      })).resolves.toMatchObject({ state: "succeeded", closedSummary: "updated" });
      const sessionContext = {
        sessionId: fixture.humanContext.sessionId,
        sessionFamilyId: fixture.humanContext.sessionFamilyId,
        principal: fixture.humanContext.principal,
      };
      await expect(fixture.authority.readExecution(sessionContext, execution.id))
        .resolves.toMatchObject({ status: "cancelled", cancellationReason: "requested_by_requester" });
      await fixture.client.close();
    });

    it("Agent runtime compensation creates one new linked execution after a compensatable side effect", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-compensation-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const original = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({
        runtimeId: "runtime-compensation",
        agentId: "agent-review",
      });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      const parameters = { path: "note.txt", content: "after", expectedCurrentSha256: null } as const;
      const parameterHash = createHash("sha256")
        .update(JSON.stringify({ content: "after", expectedCurrentSha256: null, path: "note.txt" }))
        .digest("hex");
      const toolPlanHash = createHash("sha256")
        .update(`{"parameters":{"content":"after","expectedCurrentSha256":null,"path":"note.txt"},"remainingCalls":[],"toolId":"review.read"}`)
        .digest("hex");
      await fixture.authority.commitStep(runtime, {
        executionId: original.id, attemptSeq: 1, stepSeq: 1, stepKind: "tool_call",
        canonicalToolCall: { toolId: "review.read", parameters, remainingCalls: [] },
        inputSha256: "a".repeat(64), outputSha256: parameterHash, now: 4_500,
      });
      await fixture.authority.prepareTool(runtime, {
        executionId: original.id, attemptSeq: 1, toolCallStepSeq: 1,
        toolId: "review.read", parameterHash, toolPlanHash,
        confirmationRequirement: "side_effect", now: 4_750, expiresAt: 10_000,
      });
      const confirmation = await fixture.authority.confirmTool(fixture.humanContext, {
        executionId: original.id, attemptSeq: 1, toolId: "review.read", parameterHash,
        target: "note.txt", impact: "replace sandbox file", reversibility: "compensatable",
        expiresAt: 9_000,
      });
      const resumed = await fixture.authority.resumeConfirmedTool(runtime, {
        confirmationId: confirmation.id, executionId: original.id, attemptSeq: 1,
        roomId: "room-facts", toolId: "review.read", parameterHash,
        toolPlanHash: confirmation.toolPlanHash, now: 5_000,
      });
      await createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_125 })
        .interrupt(fixture.humanContext, {
          executionId: original.id,
          reason: "requested_by_requester",
        });
      await fixture.authority.settleTool(runtime, {
        dispatchId: resumed.dispatch.id, executionId: original.id, attemptSeq: 1,
        grantId: resumed.dispatch.grantId, outcome: "succeeded",
        closedSummary: "sandbox_write:replace", sealedCompensation: "sealed-private-token", now: 5_250,
      });
      await expect(fixture.authority.readExecution({
        sessionId: fixture.humanContext.sessionId,
        sessionFamilyId: fixture.humanContext.sessionFamilyId,
        principal: fixture.humanContext.principal,
      }, original.id)).resolves.toMatchObject({ status: "cancelled" });

      const authority = fixture.authority;
      const compensation = await authority.compensate(
        fixture.humanContext, original.id, resumed.dispatch.id, 32,
      );
      expect(compensation).toMatchObject({
        status: "queued", actionCategory: "model_generation",
        compensatesExecutionId: original.id, roomId: original.roomId, agentId: original.agentId,
      });
      await expect(authority.compensate(
        fixture.humanContext, original.id, resumed.dispatch.id, 32,
      ))
        .resolves.toEqual(compensation);
      await fixture.client.close();
      const restartedClient = await createWorkerDatabaseClient({ databasePath });
      const restartedAuthority = createSqliteAuthoritativeStore(restartedClient, { clock: () => 5_500 });
      const claimedCompensation = await restartedAuthority.claimNext(runtime, "room-facts", 5_500);
      expect(claimedCompensation).toMatchObject({ id: compensation.id, status: "running" });
      const wrongRuntime = mintInternalAgentRuntimeContext({
        runtimeId: "runtime-compensation-wrong-agent", agentId: "agent-other",
      });
      await expect(restartedAuthority.resumeCompensation(wrongRuntime, {
        executionId: compensation.id, attemptSeq: 1, now: 5_625,
      })).rejects.toMatchObject({ code: "agent_capability_forbidden", status: 403 });
      const denialDatabase = new DatabaseSync(databasePath, { readOnly: true });
      expect(denialDatabase.prepare(
        "SELECT COUNT(*) AS count FROM agent_tool_dispatches WHERE execution_id = ?",
      ).get(compensation.id)).toEqual({ count: 0 });
      denialDatabase.close();
      const work = await restartedAuthority.resumeCompensation(runtime, {
        executionId: compensation.id, attemptSeq: 1, now: 5_750,
      });
      expect(work).toMatchObject({
        execution: {
          id: compensation.id, status: "running", actionCategory: "tool_call",
          toolDispatchPhase: "dispatched", compensatesExecutionId: original.id,
        },
        sealedCompensation: "sealed-private-token",
        dispatch: { state: "dispatched", executionId: compensation.id },
      });
      await expect(restartedAuthority.resumeCompensation(runtime, {
        executionId: compensation.id, attemptSeq: 1, now: 6_000,
      })).rejects.toMatchObject({ code: "execution_conflict" });
      const result = { path: "note.txt", restored: true } as const;
      const completed = await restartedAuthority.completeCompensation(runtime, {
        executionId: compensation.id,
        attemptSeq: 1,
        dispatchId: work.dispatch.id,
        grantId: work.dispatch.grantId,
        boundedToolResult: result,
        inputSha256: work.dispatch.parameterHash,
        outputSha256: createHash("sha256")
          .update(JSON.stringify({ path: "note.txt", restored: true }))
          .digest("hex"),
        closedSummary: "sandbox_compensation:restored:note.txt",
        messageId: "message-compensation-result",
        body: "Compensation completed.",
        sentAt: new Date(6_250).toISOString(),
        now: 6_250,
      });
      expect(completed).toMatchObject({
        id: compensation.id,
        status: "completed",
        actionCategory: "model_generation",
        recoveryCursor: 2,
        resultMessageId: "message-compensation-result",
      });
      await expect(restartedAuthority.completeCompensation(runtime, {
        executionId: compensation.id,
        attemptSeq: 1,
        dispatchId: work.dispatch.id,
        grantId: work.dispatch.grantId,
        boundedToolResult: result,
        inputSha256: work.dispatch.parameterHash,
        outputSha256: createHash("sha256")
          .update(JSON.stringify({ path: "note.txt", restored: true }))
          .digest("hex"),
        closedSummary: "sandbox_compensation:restored:note.txt",
        messageId: "message-compensation-result",
        body: "Compensation completed.",
        sentAt: new Date(6_250).toISOString(),
        now: 6_250,
      })).resolves.toEqual(completed);
      await expect(restartedAuthority.completeCompensation(runtime, {
        executionId: compensation.id,
        attemptSeq: 1,
        dispatchId: work.dispatch.id,
        grantId: work.dispatch.grantId,
        boundedToolResult: result,
        inputSha256: work.dispatch.parameterHash,
        outputSha256: createHash("sha256")
          .update(JSON.stringify({ path: "note.txt", restored: true }))
          .digest("hex"),
        closedSummary: "sandbox_compensation:restored:note.txt",
        messageId: "message-compensation-result",
        body: "changed body",
        sentAt: new Date(6_250).toISOString(),
        now: 6_250,
      })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
      const completedDatabase = new DatabaseSync(databasePath, { readOnly: true });
      expect(completedDatabase.prepare(
        `SELECT dispatch.state, step.step_kind AS stepKind, execution.state AS executionState,
                execution.result_message_id AS resultMessageId
         FROM agent_tool_dispatches AS dispatch
         JOIN agent_execution_steps AS step ON step.dispatch_id = dispatch.id
         JOIN agent_executions AS execution ON execution.id = dispatch.execution_id
         WHERE dispatch.id = ?`,
      ).get(work.dispatch.id)).toEqual({
        state: "succeeded",
        stepKind: "tool_result",
        executionState: "completed",
        resultMessageId: "message-compensation-result",
      });
      expect(completedDatabase.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE id = ?",
      ).get("message-compensation-result")).toEqual({ count: 1 });
      completedDatabase.close();
      const privateDatabase = new DatabaseSync(databasePath, { readOnly: true });
      expect(JSON.stringify(privateDatabase.prepare(
        "SELECT payload_json AS payload FROM events WHERE stream_kind = 'room' ORDER BY stream_seq",
      ).all())).not.toContain("sealed-private-token");
      privateDatabase.close();
      await restartedClient.close();
    });

    it("Agent runtime authority resumes a confirmed side effect from bounded durable parameters after restart", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-side-resume-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-side-resume", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 1, stepKind: "model_generation",
        inputSha256: "a".repeat(64), outputSha256: "b".repeat(64), now: 4_250,
      });
      const parameters = { path: "note.txt", content: "hello" } as const;
      const parameterHash = createHash("sha256")
        .update(JSON.stringify({ content: "hello", path: "note.txt" }))
        .digest("hex");
      await fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 2, stepKind: "tool_call",
        canonicalToolCall: {
          toolId: "review.read",
          parameters,
          remainingCalls: [{ callId: "call-next", toolId: "review.next", parameters: { page: 2 } }],
        },
        inputSha256: "c".repeat(64), outputSha256: parameterHash, now: 4_500,
      });
      await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, toolCallStepSeq: 2,
        toolId: "review.read", parameterHash,
        toolPlanHash: createHash("sha256").update(
          '{"parameters":{"content":"hello","path":"note.txt"},"remainingCalls":[{"callId":"call-next","parameters":{"page":2},"toolId":"review.next"}],"toolId":"review.read"}',
        ).digest("hex"),
        confirmationRequirement: "side_effect", now: 4_750, expiresAt: 10_000,
      });
      const confirmation = await fixture.authority.confirmTool(fixture.humanContext, {
        executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
        target: "note.txt", impact: "create file", reversibility: "compensatable",
        expiresAt: 9_000,
      });
      await fixture.client.close();

      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(reopened.resumeConfirmedTool(runtime, {
        confirmationId: confirmation.id,
        executionId: execution.id,
        attemptSeq: 1,
        roomId: "room-wrong",
        toolId: "review.read",
        parameterHash,
        toolPlanHash: confirmation.toolPlanHash,
        now: 4_900,
      })).rejects.toMatchObject({ code: "execution_conflict", status: 409 });
      const beforeResume = new DatabaseSync(databasePath, { readOnly: true });
      expect(beforeResume.prepare(
        "SELECT COUNT(*) AS count FROM agent_tool_dispatches WHERE execution_id = ?",
      ).get(execution.id)).toEqual({ count: 0 });
      expect(beforeResume.prepare(
        "SELECT consumed_at AS consumedAt FROM agent_tool_confirmations WHERE id = ?",
      ).get(confirmation.id)).toEqual({ consumedAt: null });
      beforeResume.close();
      const resumed = await reopened.resumeConfirmedTool(runtime, {
        confirmationId: confirmation.id,
        executionId: execution.id,
        attemptSeq: 1,
        roomId: "room-facts",
        toolId: "review.read",
        parameterHash,
        toolPlanHash: confirmation.toolPlanHash,
        now: 5_000,
      });
      expect(resumed).toMatchObject({
        confirmationId: confirmation.id,
        parameters,
        remainingCalls: [{ callId: "call-next", toolId: "review.next", parameters: { page: 2 } }],
        execution: {
          id: execution.id,
          status: "running",
          actionCategory: "tool_call",
          toolDispatchPhase: "dispatched",
          currentToolId: "review.read",
        },
        dispatch: {
          executionId: execution.id,
          state: "dispatched",
          toolId: "review.read",
          parameterHash,
        },
      });
      await expect(reopened.resumeConfirmedTool(runtime, {
        confirmationId: confirmation.id,
        executionId: execution.id,
        attemptSeq: 1,
        roomId: "room-facts",
        toolId: "review.read",
        parameterHash,
        toolPlanHash: confirmation.toolPlanHash,
        now: 5_100,
      })).rejects.toMatchObject({ code: "execution_conflict", status: 409 });
      const readOnly = new DatabaseSync(databasePath, { readOnly: true });
      expect(readOnly.prepare(
        "SELECT COUNT(*) AS count FROM agent_tool_dispatches WHERE grant_id = ?",
      ).get(resumed.dispatch.grantId)).toEqual({ count: 1 });
      readOnly.close();
      await reopened.settleTool(runtime, {
        dispatchId: resumed.dispatch.id, executionId: execution.id, attemptSeq: 1,
        grantId: resumed.dispatch.grantId, outcome: "succeeded", now: 5_250,
      });
      await expect(reopened.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 3, stepKind: "tool_result",
        dispatchId: resumed.dispatch.id, boundedToolResult: { written: true },
        inputSha256: parameterHash, outputSha256: "d".repeat(64), now: 5_500,
      })).resolves.toMatchObject({ actionCategory: "model_generation", recoveryCursor: 3 });
      await reopenedClient.close();
    });

    it("Agent runtime authority distinguishes identical side-effect calls by durable tool-call step across restart", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-repeat-side-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-repeat-side", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      const parameters = {} as const;
      const parameterHash = createHash("sha256").update("{}").digest("hex");
      const canonicalToolCall = { toolId: "review.read", parameters, remainingCalls: [] } as const;
      const toolPlanHash = createHash("sha256")
        .update('{"parameters":{},"remainingCalls":[],"toolId":"review.read"}')
        .digest("hex");
      const confirm = async (stepSeq: number, now: number) => {
        await fixture.authority.commitStep(runtime, {
          executionId: execution.id, attemptSeq: 1, stepSeq, stepKind: "tool_call",
          canonicalToolCall, inputSha256: "a".repeat(64), outputSha256: parameterHash, now,
        });
        const grant = await fixture.authority.prepareTool(runtime, {
          executionId: execution.id, attemptSeq: 1, toolCallStepSeq: stepSeq,
          toolId: "review.read", parameterHash, toolPlanHash,
          confirmationRequirement: "side_effect", now: now + 100, expiresAt: now + 5_000,
        });
        const confirmationInput = {
          executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
          target: "same", impact: "same", reversibility: "compensatable", expiresAt: now + 4_000,
        } as const;
        const [confirmation, replay] = await Promise.all([
          fixture.authority.confirmTool(fixture.humanContext, confirmationInput),
          fixture.authority.confirmTool(fixture.humanContext, confirmationInput),
        ]);
        expect(replay).toEqual(confirmation);
        return { grant, confirmation };
      };
      const first = await confirm(1, 4_500);
      const firstDispatch = await fixture.authority.resumeConfirmedTool(runtime, {
        confirmationId: first.confirmation.id, executionId: execution.id, attemptSeq: 1,
        roomId: "room-facts", toolId: "review.read", parameterHash, toolPlanHash, now: 5_000,
      });
      await fixture.authority.settleTool(runtime, {
        dispatchId: firstDispatch.dispatch.id, executionId: execution.id, attemptSeq: 1,
        grantId: first.grant.id, outcome: "succeeded",
        sealedCompensation: "sealed-first", now: 5_100,
      });
      await fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 2, stepKind: "tool_result",
        dispatchId: firstDispatch.dispatch.id, boundedToolResult: { ok: true },
        inputSha256: parameterHash, outputSha256: "b".repeat(64), now: 5_200,
      });
      const second = await confirm(3, 5_300);
      expect(second.grant.id).not.toBe(first.grant.id);
      expect(second.confirmation.id).not.toBe(first.confirmation.id);
      await fixture.client.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      const secondDispatch = await reopened.resumeConfirmedTool(runtime, {
        confirmationId: second.confirmation.id, executionId: execution.id, attemptSeq: 1,
        roomId: "room-facts", toolId: "review.read", parameterHash, toolPlanHash, now: 5_500,
      });
      expect(secondDispatch.dispatch.id).not.toBe(firstDispatch.dispatch.id);
      expect(secondDispatch.toolPlanHash).toBe(toolPlanHash);
      await reopened.settleTool(runtime, {
        dispatchId: secondDispatch.dispatch.id, executionId: execution.id, attemptSeq: 1,
        grantId: second.grant.id, outcome: "succeeded",
        sealedCompensation: "sealed-second", now: 5_600,
      });
      await reopenedClient.close();

      const explainDatabase = new DatabaseSync(databasePath, { readOnly: true });
      const explain = explainDatabase.prepare(
        `EXPLAIN QUERY PLAN
         SELECT execution.id
         FROM agent_executions AS execution
         JOIN agent_execution_attempts AS attempt
           ON attempt.execution_id = execution.id
          AND attempt.attempt_seq = execution.current_attempt_seq
         JOIN agent_tool_grants AS grant INDEXED BY agent_tool_grants_execution_step
           ON grant.execution_id = execution.id
          AND grant.attempt_seq = execution.current_attempt_seq
          AND grant.tool_call_step_seq = execution.recovery_cursor
          AND grant.confirmation_requirement = 'side_effect'
         JOIN agent_tool_dispatches AS dispatch
           ON dispatch.grant_id = grant.id
          AND dispatch.execution_id = execution.id
          AND dispatch.attempt_seq = execution.current_attempt_seq
         WHERE execution.id = ? AND dispatch.state IN ('succeeded', 'failed')
         LIMIT 2`,
      ).all(execution.id).map((row) => String(row.detail));
      expect(explain.some((detail) =>
        detail.includes("SEARCH grant USING COVERING INDEX agent_tool_grants_execution_step"),
      )).toBe(true);
      expect(explain.join("\n")).not.toMatch(/SCAN grant|AUTOMATIC|TEMP B-TREE/);
      explainDatabase.close();

      const recoveredClient = await createWorkerDatabaseClient({ databasePath });
      const recovered = createSqliteAuthoritativeStore(recoveredClient, { clock: () => 6_000 });
      await expect(recoverAllAgentRuntimeExecutions(recovered, runtime, 6_000)).resolves.toEqual([
        expect.objectContaining({
          id: execution.id,
          status: "failed",
          terminalErrorCode: "side_effect_reconciliation_required",
        }),
      ]);
      const firstCompensation = await recovered.compensate(
        fixture.humanContext, execution.id, firstDispatch.dispatch.id, 32,
      );
      const secondCompensation = await recovered.compensate(
        fixture.humanContext, execution.id, secondDispatch.dispatch.id, 32,
      );
      expect(firstCompensation.id).not.toBe(secondCompensation.id);
      expect(firstCompensation).toMatchObject({ compensatesExecutionId: execution.id });
      expect(secondCompensation).toMatchObject({ compensatesExecutionId: execution.id });
      await recoveredClient.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM agent_tool_dispatches WHERE execution_id = ?",
      ).get(execution.id)).toEqual({ count: 2 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM agent_compensation_requests WHERE original_execution_id = ?",
      ).get(execution.id)).toEqual({ count: 2 });
      expect(database.prepare(
        `SELECT state, settled_at AS settledAt FROM agent_tool_dispatches
         WHERE execution_id = ? ORDER BY dispatched_at`,
      ).all(execution.id)).toEqual([
        { state: "succeeded", settledAt: "1970-01-01T00:00:05.100Z" },
        { state: "succeeded", settledAt: "1970-01-01T00:00:05.600Z" },
      ]);
      database.close();
    });

    it("Agent runtime authority distinguishes identical read-only calls by durable tool-call step across restart", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-repeat-read-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-repeat-read", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      const parameters = {} as const;
      const parameterHash = createHash("sha256").update("{}").digest("hex");
      const canonicalToolCall = { toolId: "review.read", parameters, remainingCalls: [] } as const;
      const toolPlanHash = createHash("sha256")
        .update('{"parameters":{},"remainingCalls":[],"toolId":"review.read"}')
        .digest("hex");
      await fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 1, stepKind: "tool_call",
        canonicalToolCall, inputSha256: "a".repeat(64), outputSha256: parameterHash, now: 4_500,
      });
      const firstGrant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, toolCallStepSeq: 1,
        toolId: "review.read", parameterHash, toolPlanHash,
        confirmationRequirement: "read_only", now: 4_600, expiresAt: 9_000,
      });
      const firstDispatch = await fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: firstGrant.id,
        toolId: "review.read", parameterHash, confirmationRequirement: "read_only", now: 4_700,
      });
      await fixture.authority.settleTool(runtime, {
        dispatchId: firstDispatch.id, executionId: execution.id, attemptSeq: 1,
        grantId: firstGrant.id, outcome: "succeeded", now: 4_800,
      });
      await fixture.authority.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 2, stepKind: "tool_result",
        dispatchId: firstDispatch.id, boundedToolResult: { ok: true },
        inputSha256: parameterHash, outputSha256: "b".repeat(64), now: 4_900,
      });
      await fixture.client.close();

      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await reopened.commitStep(runtime, {
        executionId: execution.id, attemptSeq: 1, stepSeq: 3, stepKind: "tool_call",
        canonicalToolCall, inputSha256: "c".repeat(64), outputSha256: parameterHash, now: 5_000,
      });
      const secondGrant = await reopened.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, toolCallStepSeq: 3,
        toolId: "review.read", parameterHash, toolPlanHash,
        confirmationRequirement: "read_only", now: 5_100, expiresAt: 9_500,
      });
      const secondDispatch = await reopened.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: secondGrant.id,
        toolId: "review.read", parameterHash, confirmationRequirement: "read_only", now: 5_200,
      });
      expect(secondGrant.id).not.toBe(firstGrant.id);
      expect(secondDispatch.id).not.toBe(firstDispatch.id);
      await reopenedClient.close();
    });

    it("Agent runtime authority denies mismatched tool dispatch without consuming or inserting facts", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-tool-deny-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-tool-deny", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "d".repeat(64));
      const grant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "d".repeat(64), confirmationRequirement: "read_only",
        now: 5_000, expiresAt: 10_000,
      });
      const preparedDatabase = new DatabaseSync(databasePath, { readOnly: true });
      expect(preparedDatabase.prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE event_type = 'room.agent_tool_confirmation.required'`,
      ).get()).toEqual({ count: 0 });
      preparedDatabase.close();
      await expect(fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id,
        toolId: "review.read", parameterHash: "e".repeat(64),
        confirmationRequirement: "read_only", now: 6_000,
      })).rejects.toMatchObject({ code: "execution_conflict" });
      await fixture.client.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT consumed_at AS consumedAt FROM agent_tool_grants WHERE id = ?")
        .get(grant.id)).toEqual({ consumedAt: null });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_tool_dispatches").get())
        .toEqual({ count: 0 });
      database.close();
    });

    it("Agent runtime authority rejects preparing another tool while a dispatch is unsettled with zero writes", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-tool-single-dispatch-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-one-dispatch", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "2".repeat(64));
      const grant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "2".repeat(64), confirmationRequirement: "read_only",
        now: 5_000, expiresAt: 10_000,
      });
      await fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
        parameterHash: "2".repeat(64), confirmationRequirement: "read_only", now: 5_500,
      });
      await fixture.client.close();
      const beforeDb = new DatabaseSync(databasePath, { readOnly: true });
      const before = beforeDb.prepare(
        `SELECT (SELECT COUNT(*) FROM agent_tool_grants) AS grants,
                (SELECT COUNT(*) FROM agent_tool_dispatches) AS dispatches,
                (SELECT COUNT(*) FROM events) AS events,
                (SELECT COUNT(*) FROM outbox_deliveries) AS outbox`,
      ).get();
      beforeDb.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(reopened.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "3".repeat(64), confirmationRequirement: "read_only",
        now: 6_000, expiresAt: 11_000,
      })).rejects.toMatchObject({ status: 409, code: "execution_conflict" });
      await reopenedClient.close();
      const afterDb = new DatabaseSync(databasePath, { readOnly: true });
      expect(afterDb.prepare(
        `SELECT (SELECT COUNT(*) FROM agent_tool_grants) AS grants,
                (SELECT COUNT(*) FROM agent_tool_dispatches) AS dispatches,
                (SELECT COUNT(*) FROM events) AS events,
                (SELECT COUNT(*) FROM outbox_deliveries) AS outbox`,
      ).get()).toEqual(before);
      afterDb.close();
    });

    it("Agent runtime authority cancels only fence-eligible attempts without creating a replacement", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-fence-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-fence", agentId: "agent-review" });
      await expect(fixture.authority.cancelForHumanFence(runtime, {
        executionId: execution.id, fenceMessageId: "message-human-source-next", now: 5_000,
      })).resolves.toMatchObject({ status: "cancelled", cancellationReason: "human_fence" });
      await expect(fixture.authority.cancelForHumanFence(runtime, {
        executionId: execution.id, fenceMessageId: "message-human-source-next", now: 6_000,
      })).resolves.toMatchObject({ status: "cancelled", cancellationReason: "human_fence" });
      await fixture.client.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_fence_replacements").get())
        .toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT replacement_execution_id AS replacementExecutionId FROM agent_fence_replacements",
      ).get()).toEqual({ replacementExecutionId: null });
      database.close();
    });

    it("Agent runtime recovery marks an unsettled side effect outcome unknown and terminal", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-side-effect-recover-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-side-effect-recover", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "f".repeat(64));
      const parameterHash = "f".repeat(64);
      const grant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
        confirmationRequirement: "side_effect", now: 5_000, expiresAt: 10_000,
      });
      const humanAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_500 });
      const confirmation = await humanAuthority.confirmTool(fixture.humanContext, {
        executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
        target: "review target", impact: "updates remote review", reversibility: "irreversible",
        expiresAt: 9_000,
      });
      const dispatch = await fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id,
        toolId: "review.read", parameterHash, confirmationRequirement: "side_effect",
        confirmationId: confirmation.id, now: 6_000,
      });
      await fixture.client.close();

      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(recoverAllAgentRuntimeExecutions(reopened, runtime, 7_000)).resolves.toEqual([
        expect.objectContaining({
          id: execution.id, status: "failed", terminalErrorCode: "side_effect_outcome_unknown",
        }),
      ]);
      await reopenedClient.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("SELECT state, settled_at AS settledAt FROM agent_tool_dispatches WHERE id = ?")
        .get(dispatch.id)).toEqual({ state: "outcome_unknown", settledAt: "1970-01-01T00:00:07.000Z" });
      database.close();
    });

    it.each([
      ["succeeded", "side_effect_reconciliation_required"],
      ["failed", "tool_failure"],
    ] as const)(
      "Agent runtime terminalizes a %s side effect without creating another effect-capable attempt",
      async (outcome, terminalErrorCode) => {
        const directory = await mkdtemp(join(tmpdir(), `native-im-runtime-side-settled-${outcome}-`));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "authority.sqlite");
        const fixture = await createAgentFactFixture(databasePath);
        const execution = await fixture.authority.invoke(fixture.humanContext, {
          roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
          intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
        });
        const runtime = mintInternalAgentRuntimeContext({ runtimeId: `runtime-side-settled-${outcome}`, agentId: "agent-review" });
        await fixture.authority.claimNext(runtime, "room-facts", 4_000);
        await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "c".repeat(64));
        const parameterHash = "c".repeat(64);
        const grant = await fixture.authority.prepareTool(runtime, {
          executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
          confirmationRequirement: "side_effect", now: 5_000, expiresAt: 10_000,
        });
        const humanAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_500 });
        const confirmation = await humanAuthority.confirmTool(fixture.humanContext, {
          executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
          target: "review target", impact: "updates remote review", reversibility: "irreversible",
          expiresAt: 9_000,
        });
        const dispatch = await fixture.authority.dispatchTool(runtime, {
          executionId: execution.id, attemptSeq: 1, grantId: grant.id,
          toolId: "review.read", parameterHash, confirmationRequirement: "side_effect",
          confirmationId: confirmation.id, now: 6_000,
        });
        await fixture.authority.settleTool(runtime, {
          dispatchId: dispatch.id, executionId: execution.id, attemptSeq: 1, grantId: grant.id,
          outcome, closedSummary: outcome, now: 6_500,
        });
        if (outcome === "failed") {
          await expect(fixture.authority.readExecution({
            sessionId: fixture.humanContext.sessionId,
            sessionFamilyId: fixture.humanContext.sessionFamilyId,
            principal: fixture.humanContext.principal,
          }, execution.id)).resolves.toMatchObject({ status: "failed", terminalErrorCode });
        }
        await fixture.client.close();

        const reopenedClient = await createWorkerDatabaseClient({ databasePath });
        const reopened = createSqliteAuthoritativeStore(reopenedClient);
        await expect(recoverAllAgentRuntimeExecutions(reopened, runtime, 7_000)).resolves.toEqual(
          outcome === "succeeded"
            ? [expect.objectContaining({ id: execution.id, status: "failed", terminalErrorCode })]
            : [],
        );
        await reopenedClient.close();

        const database = new DatabaseSync(databasePath, { readOnly: true });
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM agent_tool_dispatches WHERE execution_id = ?",
        ).get(execution.id)).toEqual({ count: 1 });
        expect(database.prepare(
          "SELECT COUNT(*) AS count FROM agent_tool_grants WHERE execution_id = ?",
        ).get(execution.id)).toEqual({ count: 1 });
        expect(database.prepare(
          "SELECT state, settled_at AS settledAt FROM agent_tool_dispatches WHERE id = ?",
        ).get(dispatch.id)).toEqual({ state: outcome, settledAt: "1970-01-01T00:00:06.500Z" });
        expect(database.prepare(
          `SELECT attempt_seq AS attemptSeq, state, action_category AS actionCategory,
                  error_code AS errorCode
           FROM agent_execution_attempts WHERE execution_id = ? ORDER BY attempt_seq`,
        ).all(execution.id)).toEqual([
          { attemptSeq: 1, state: "failed", actionCategory: "tool_call", errorCode: terminalErrorCode },
        ]);
        expect(() => migrateAuthorityDatabase(database)).not.toThrow();
        database.close();
      },
    );

    it("Agent runtime recovery never retries a settled side effect when its retry budget is exhausted", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-side-settled-dead-letter-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-side-settled-dead-letter", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await fixture.authority.scheduleRetry(runtime, {
        executionId: execution.id, attemptSeq: 1, errorCode: "upstream_timeout", now: 4_500,
      });
      await fixture.authority.claimNext(runtime, "room-facts", 5_500);
      await fixture.authority.scheduleRetry(runtime, {
        executionId: execution.id, attemptSeq: 2, errorCode: "upstream_timeout", now: 6_000,
      });
      await fixture.authority.claimNext(runtime, "room-facts", 10_000);
      await checkpointToolCall(fixture, runtime, execution.id, 3, 10_250, "d".repeat(64));
      const parameterHash = "d".repeat(64);
      const grant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 3, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
        confirmationRequirement: "side_effect", now: 10_500, expiresAt: 20_000,
      });
      const humanAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 11_000 });
      const confirmation = await humanAuthority.confirmTool(fixture.humanContext, {
        executionId: execution.id, attemptSeq: 3, toolId: "review.read", parameterHash,
        target: "review target", impact: "updates remote review", reversibility: "irreversible",
        expiresAt: 19_000,
      });
      const dispatch = await fixture.authority.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 3, grantId: grant.id,
        toolId: "review.read", parameterHash, confirmationRequirement: "side_effect",
        confirmationId: confirmation.id, now: 11_500,
      });
      await fixture.authority.settleTool(runtime, {
        dispatchId: dispatch.id, executionId: execution.id, attemptSeq: 3, grantId: grant.id,
        outcome: "succeeded", closedSummary: "succeeded", now: 12_000,
      });
      await fixture.client.close();

      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(recoverAllAgentRuntimeExecutions(reopened, runtime, 13_000)).resolves.toEqual([
        expect.objectContaining({
          id: execution.id, status: "failed", currentAttemptSeq: 3,
          terminalErrorCode: "side_effect_reconciliation_required",
        }),
      ]);
      await reopenedClient.close();
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM agent_tool_dispatches WHERE execution_id = ?",
      ).get(execution.id)).toEqual({ count: 1 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM agent_execution_attempts WHERE execution_id = ?",
      ).get(execution.id)).toEqual({ count: 3 });
      expect(database.prepare("SELECT state FROM agent_tool_dispatches WHERE id = ?")
        .get(dispatch.id)).toEqual({ state: "succeeded" });
      database.close();
    });

    it("Agent runtime recovery fails an expired waiting confirmation without dispatch", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-confirmation-expire-"));
      temporaryDirectories.push(directory);
      const fixture = await createAgentFactFixture(join(directory, "authority.sqlite"));
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-confirmation-expire", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "1".repeat(64));
      await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "1".repeat(64), confirmationRequirement: "side_effect",
        now: 5_000, expiresAt: 6_000,
      });
      await expect(recoverAllAgentRuntimeExecutions(fixture.authority, runtime, 6_000)).resolves.toEqual([
        expect.objectContaining({
          id: execution.id, status: "failed", terminalErrorCode: "confirmation_expired",
        }),
      ]);
      await fixture.client.close();
    });

    it("Agent runtime tool confirmation returns gone after its grant expires", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-confirmation-gone-"));
      temporaryDirectories.push(directory);
      const fixture = await createAgentFactFixture(join(directory, "authority.sqlite"));
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-confirmation-gone", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "7".repeat(64));
      const parameterHash = "7".repeat(64);
      await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
        confirmationRequirement: "side_effect", now: 5_000, expiresAt: 6_000,
      });
      const expiredAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 6_000 });
      await expect(expiredAuthority.confirmTool(fixture.humanContext, {
        executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
        target: "review target", impact: "updates remote review", reversibility: "irreversible",
        expiresAt: 7_000,
      })).rejects.toMatchObject({ status: 410, code: "confirmation_expired" });
      await fixture.client.close();
    });

    it.each(["grant", "confirmation"] as const)(
      "Agent runtime tool dispatch returns gone when its %s expires without consuming authority",
      async (expiredAuthority) => {
        const directory = await mkdtemp(join(tmpdir(), `native-im-runtime-dispatch-${expiredAuthority}-gone-`));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "authority.sqlite");
        const fixture = await createAgentFactFixture(databasePath);
        const execution = await fixture.authority.invoke(fixture.humanContext, {
          roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
          intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
        });
        const runtime = mintInternalAgentRuntimeContext({ runtimeId: `runtime-dispatch-${expiredAuthority}-gone`, agentId: "agent-review" });
        await fixture.authority.claimNext(runtime, "room-facts", 4_000);
        await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "e".repeat(64));
        const parameterHash = "e".repeat(64);
        const grant = await fixture.authority.prepareTool(runtime, {
          executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
          confirmationRequirement: "side_effect", now: 5_000,
          expiresAt: expiredAuthority === "grant" ? 6_000 : 10_000,
        });
        const confirmationAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_500 });
        const confirmation = await confirmationAuthority.confirmTool(fixture.humanContext, {
          executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
          target: "review target", impact: "updates remote review", reversibility: "irreversible",
          expiresAt: expiredAuthority === "confirmation" ? 6_000 : 9_000,
        });
        await expect(fixture.authority.dispatchTool(runtime, {
          executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
          parameterHash, confirmationRequirement: "side_effect", confirmationId: confirmation.id,
          now: 6_000,
        })).rejects.toMatchObject({ status: 410, code: "confirmation_expired" });
        await fixture.client.close();
        const database = new DatabaseSync(databasePath, { readOnly: true });
        expect(database.prepare(
          `SELECT (SELECT consumed_at FROM agent_tool_grants WHERE id = ?) AS grantConsumed,
                  (SELECT consumed_at FROM agent_tool_confirmations WHERE id = ?) AS confirmationConsumed,
                  (SELECT COUNT(*) FROM agent_tool_dispatches) AS dispatches`,
        ).get(grant.id, confirmation.id)).toEqual({
          grantConsumed: null, confirmationConsumed: null, dispatches: 0,
        });
        database.close();
      },
    );

    it("Agent runtime tool dispatch rechecks that the confirmation session family is active", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-confirmation-revoked-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-confirmation-revoked", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "6".repeat(64));
      const parameterHash = "6".repeat(64);
      const grant = await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
        confirmationRequirement: "side_effect", now: 5_000, expiresAt: 10_000,
      });
      const confirmationAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_500 });
      const confirmation = await confirmationAuthority.confirmTool(fixture.humanContext, {
        executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
        target: "review target", impact: "updates remote review", reversibility: "irreversible",
        expiresAt: 9_000,
      });
      await fixture.client.close();
      const database = new DatabaseSync(databasePath);
      database.prepare("UPDATE sessions SET revoked_at = ? WHERE family_id = ?")
        .run(5_750, fixture.humanContext.sessionFamilyId);
      const before = database.prepare(
        `SELECT (SELECT consumed_at FROM agent_tool_grants WHERE id = ?) AS grantConsumed,
                (SELECT consumed_at FROM agent_tool_confirmations WHERE id = ?) AS confirmationConsumed,
                (SELECT COUNT(*) FROM agent_tool_dispatches) AS dispatches`,
      ).get(grant.id, confirmation.id);
      database.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient);
      await expect(reopened.dispatchTool(runtime, {
        executionId: execution.id, attemptSeq: 1, grantId: grant.id, toolId: "review.read",
        parameterHash, confirmationRequirement: "side_effect", confirmationId: confirmation.id,
        now: 6_000,
      })).rejects.toMatchObject({ status: 403, code: "session_revoked" });
      await reopenedClient.close();
      const after = new DatabaseSync(databasePath, { readOnly: true });
      expect(after.prepare(
        `SELECT (SELECT consumed_at FROM agent_tool_grants WHERE id = ?) AS grantConsumed,
                (SELECT consumed_at FROM agent_tool_confirmations WHERE id = ?) AS confirmationConsumed,
                (SELECT COUNT(*) FROM agent_tool_dispatches) AS dispatches`,
      ).get(grant.id, confirmation.id)).toEqual(before);
      after.close();
    });

    it("Agent runtime recovery expires waiting side effects at the earlier confirmation deadline", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-confirmation-min-expiry-"));
      temporaryDirectories.push(directory);
      const fixture = await createAgentFactFixture(join(directory, "authority.sqlite"));
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-min-expiry", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "7".repeat(64));
      const parameterHash = "7".repeat(64);
      await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read", parameterHash,
        confirmationRequirement: "side_effect", now: 5_000, expiresAt: 10_000,
      });
      const confirmationAuthority = createSqliteAuthoritativeStore(fixture.client, { clock: () => 5_500 });
      await confirmationAuthority.confirmTool(fixture.humanContext, {
        executionId: execution.id, attemptSeq: 1, toolId: "review.read", parameterHash,
        target: "review target", impact: "updates remote review", reversibility: "irreversible",
        expiresAt: 6_000,
      });
      await expect(recoverAllAgentRuntimeExecutions(fixture.authority, runtime, 6_000)).resolves.toEqual([
        expect.objectContaining({ status: "failed", terminalErrorCode: "confirmation_expired" }),
      ]);
      await fixture.client.close();
    });

    it("Agent runtime recovery preserves an unexpired side-effect confirmation wait", async () => {
      const directory = await mkdtemp(join(tmpdir(), "native-im-runtime-confirmation-wait-recover-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "authority.sqlite");
      const fixture = await createAgentFactFixture(databasePath);
      const execution = await fixture.authority.invoke(fixture.humanContext, {
        roomId: "room-facts", sourceMessageId: "message-human-source", targetAgentId: "agent-review",
        intentKind: "direct_mention", providerId: "provider-test", modelId: "model-test",
      });
      const runtime = mintInternalAgentRuntimeContext({ runtimeId: "runtime-wait-recover", agentId: "agent-review" });
      await fixture.authority.claimNext(runtime, "room-facts", 4_000);
      await checkpointToolCall(fixture, runtime, execution.id, 1, 4_500, "f".repeat(64));
      await fixture.authority.prepareTool(runtime, {
        executionId: execution.id, attemptSeq: 1, ...DEFAULT_TOOL_CALL_BINDING, toolId: "review.read",
        parameterHash: "f".repeat(64), confirmationRequirement: "side_effect",
        now: 5_000, expiresAt: 10_000,
      });
      await fixture.client.close();
      const reopenedClient = await createWorkerDatabaseClient({ databasePath });
      const reopened = createSqliteAuthoritativeStore(reopenedClient, { clock: () => 6_000 });
      await expect(recoverAllAgentRuntimeExecutions(reopened, runtime, 6_000)).resolves.toEqual([]);
      await expect(reopened.readExecution({
        sessionId: fixture.humanContext.sessionId,
        sessionFamilyId: fixture.humanContext.sessionFamilyId,
        principal: fixture.humanContext.principal,
      }, execution.id)).resolves.toMatchObject({
        status: "running", actionCategory: "waiting_upstream",
      });
      await reopenedClient.close();
    });

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

      const legacySecret = "legacy-result-private-sentinel";
      const completed = {
        ...running,
        payload: { ...running.payload, status: "completed", result: legacySecret },
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
        `SELECT state AS status, requester_actor_id AS requesterId, agent_id AS agentId,
                current_tool_id AS toolName, legacy_result_json AS result
         FROM agent_executions`,
      ).get()).toEqual({
        status: "completed",
        requesterId: "human-li",
        agentId: "agent-review",
        toolName: "review.read",
        result: JSON.stringify(legacySecret),
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE event_type = 'room.agent_execution.changed'",
      ).get()).toEqual({ count: 2 });
      const eventPayloads = database.prepare(
        "SELECT payload_json AS payloadJson FROM events WHERE event_type = 'room.agent_execution.changed' ORDER BY stream_seq",
      ).all() as readonly { readonly payloadJson: string }[];
      expect(eventPayloads).toHaveLength(2);
      expect(eventPayloads.map(({ payloadJson }) => JSON.parse(payloadJson)).every(isAgentExecution)).toBe(true);
      expect(eventPayloads.some(({ payloadJson }) => payloadJson.includes(legacySecret))).toBe(false);
      expect(JSON.stringify(finished)).not.toContain(legacySecret);
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
      ).get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM calibration_signals").get())
        .toEqual({ count: 1 });
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
          payload: { sourceMessageId: "matrix-human-source", ownerId: "human-chen", content: "matrix open item" },
        }),
        ({ roomId }) => ({
          type: "open-item.create", roomId,
          payload: { sourceMessageId: "matrix-human-source", ownerId: "human-chen", content: "matrix changed item" },
        }),
      ),
      agentMatrixCase(
        "open-item.transition",
        "room.open_item.changed",
        "SELECT COUNT(*) AS count FROM open_items WHERE id = 'matrix-open-existing' AND status = 'responded'",
        ({ roomId }) => ({
          type: "open-item.transition", roomId,
          payload: { itemId: "matrix-open-existing", action: "respond" },
        }),
        ({ roomId }) => ({
          type: "open-item.transition", roomId,
          payload: { itemId: "matrix-open-existing", action: "defer" },
        }),
      ),
      agentMatrixCase(
        "agent.execution.transition",
        "room.agent_execution.changed",
        "SELECT COUNT(*) AS count FROM agent_executions WHERE id = 'matrix-execution' AND state = 'running'",
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
