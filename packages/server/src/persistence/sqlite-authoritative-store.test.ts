import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createSqliteAuthoritativeStore } from "./sqlite-authoritative-store.js";
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

describe("SQLite authoritative sessions", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
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
    database.close();
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
