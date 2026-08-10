import { createHook } from "node:async_hooks";
import { createHash, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Actor } from "@native-im/core";
import {
  createAuthenticationService as createAuthenticationServiceWithActors,
  createJsonStateStore,
  createScryptIdentityAdapter,
  isSessionState,
  StateStoreCorruptionError,
  type IdentityAdapter,
  type AuthenticationServiceOptions,
  type LoginCredentials,
  type PasswordIdentityRecord,
  type SessionState,
  type StateStore,
} from "./index.js";

const accounts = new Map([
  ["account-li", { actorId: "human-li", secret: "correct-li" }],
  ["account-ada", { actorId: "human-ada", secret: "correct-ada" }],
]);

const authenticationActors = [
  {
    id: "human-li",
    kind: "human",
    displayName: "Lionel",
    reachability: "online",
  },
  {
    id: "human-ada",
    kind: "human",
    displayName: "Ada",
    reachability: "online",
  },
  {
    id: "agent-auth",
    kind: "agent",
    displayName: "Automation",
    readiness: "ready",
    toolPermissions: [],
  },
] as const satisfies readonly Actor[];

const actorDirectory = {
  getActor(actorId: string): Actor | undefined {
    return authenticationActors.find((actor) => actor.id === actorId);
  },
};

function createAuthenticationService(
  options: Omit<AuthenticationServiceOptions, "actors"> & {
    readonly actors?: AuthenticationServiceOptions["actors"];
  },
) {
  return createAuthenticationServiceWithActors({
    ...options,
    actors: options.actors ?? actorDirectory,
  });
}

const validIdentitySalt = Buffer.from("identity-salt-v1!", "utf8").toString(
  "base64url",
);
const validIdentityHash = scryptSync(
  "correct-li",
  Buffer.from(validIdentitySalt, "base64url"),
  64,
).toString("base64url");

function passwordIdentityRecord(
  overrides: Partial<PasswordIdentityRecord> = {},
): PasswordIdentityRecord {
  return {
    accountId: "account-li",
    actorId: "human-li",
    salt: validIdentitySalt,
    hash: validIdentityHash,
    ...overrides,
  };
}

const testIdentityAdapter: IdentityAdapter = {
  async verify(credentials: LoginCredentials) {
    const account = accounts.get(credentials.accountId);
    if (account === undefined || account.secret !== credentials.secret) {
      return undefined;
    }

    return { accountId: credentials.accountId, actorId: account.actorId };
  },
};

function createTokenFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function sessionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    familyId: tokenHash("family-access-token"),
    accountId: "account-li",
    actorId: "human-li",
    accessTokenHash: tokenHash("access-token"),
    refreshTokenHash: tokenHash("refresh-token"),
    accessExpiresAt: 1_000,
    refreshExpiresAt: 10_000,
    ...overrides,
  };
}

async function countScryptRequests(operation: () => Promise<unknown>): Promise<number> {
  let requests = 0;
  const hook = createHook({
    init(_asyncId, type) {
      if (type === "SCRYPTREQUEST") {
        requests += 1;
      }
    },
  });

  hook.enable();
  try {
    await operation();
  } finally {
    hook.disable();
  }
  return requests;
}

class FailingSessionStore implements StateStore<SessionState> {
  private state: SessionState | undefined;
  private nextSaveError: unknown;
  saveAttempts = 0;

  constructor(state?: SessionState) {
    this.state = state;
  }

  async load(): Promise<SessionState | undefined> {
    return this.state;
  }

  async save(value: SessionState): Promise<void> {
    this.saveAttempts += 1;
    if (this.nextSaveError !== undefined) {
      const error = this.nextSaveError;
      this.nextSaveError = undefined;
      throw error;
    }
    this.state = value;
  }

  failNextSave(error: unknown): void {
    this.nextSaveError = error;
  }
}

describe("session state authority guard", () => {
  it("rejects unexpected top-level fields", () => {
    expect(
      isSessionState({ version: 1, sessions: [], secret: "must-not-be-state" }),
    ).toBe(false);
  });

  it.each([
    { field: "accessToken", value: "raw-access-token" },
    { field: "refreshToken", value: "raw-refresh-token" },
    { field: "secret", value: "raw-credential" },
  ])("rejects a raw $field field on a session record", ({ field, value }) => {
    expect(
      isSessionState({
        version: 1,
        sessions: [sessionRecord({ [field]: value })],
      }),
    ).toBe(false);
  });

  it.each([
    { field: "accountId", value: "" },
    { field: "actorId", value: "   " },
  ])("rejects an empty $field binding", ({ field, value }) => {
    expect(
      isSessionState({
        version: 1,
        sessions: [sessionRecord({ [field]: value })],
      }),
    ).toBe(false);
  });

  it.each([
    { field: "familyId", value: `${"A".repeat(42)}B` },
    { field: "accessTokenHash", value: `${"A".repeat(42)}B` },
    { field: "refreshTokenHash", value: `${"A".repeat(42)}B` },
  ])("rejects a non-canonical $field", ({ field, value }) => {
    expect(
      isSessionState({
        version: 1,
        sessions: [sessionRecord({ [field]: value })],
      }),
    ).toBe(false);
  });

  it("rejects the same hash used for access and refresh within one record", () => {
    const duplicateHash = tokenHash("duplicate-token");
    expect(
      isSessionState({
        version: 1,
        sessions: [
          sessionRecord({
            accessTokenHash: duplicateHash,
            refreshTokenHash: duplicateHash,
          }),
        ],
      }),
    ).toBe(false);
  });

  it("rejects duplicate access hashes across records", () => {
    const duplicateHash = tokenHash("duplicate-access-token");
    expect(
      isSessionState({
        version: 1,
        sessions: [
          sessionRecord({ accessTokenHash: duplicateHash }),
          sessionRecord({
            familyId: tokenHash("second-family"),
            accessTokenHash: duplicateHash,
            refreshTokenHash: tokenHash("second-refresh-token"),
          }),
        ],
      }),
    ).toBe(false);
  });

  it("rejects duplicate refresh hashes across records", () => {
    const duplicateHash = tokenHash("duplicate-refresh-token");
    expect(
      isSessionState({
        version: 1,
        sessions: [
          sessionRecord({ refreshTokenHash: duplicateHash }),
          sessionRecord({
            familyId: tokenHash("second-family"),
            accessTokenHash: tokenHash("second-access-token"),
            refreshTokenHash: duplicateHash,
          }),
        ],
      }),
    ).toBe(false);
  });

  it("rejects a cross-kind collision between refresh and access hashes", () => {
    const collision = tokenHash("cross-kind-token");
    expect(
      isSessionState({
        version: 1,
        sessions: [
          sessionRecord({ refreshTokenHash: collision }),
          sessionRecord({
            familyId: tokenHash("second-family"),
            accessTokenHash: collision,
            refreshTokenHash: tokenHash("second-refresh-token"),
          }),
        ],
      }),
    ).toBe(false);
  });

  it.each([
    { field: "accountId", value: "account-ada" },
    { field: "actorId", value: "human-ada" },
  ])("rejects a conflicting family $field binding", ({ field, value }) => {
    const familyId = tokenHash("shared-family");
    expect(
      isSessionState({
        version: 1,
        sessions: [
          sessionRecord({ familyId }),
          sessionRecord({
            familyId,
            accessTokenHash: tokenHash("second-access-token"),
            refreshTokenHash: tokenHash("second-refresh-token"),
            [field]: value,
          }),
        ],
      }),
    ).toBe(false);
  });

  it("rejects persisted ambiguous session state as corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-auth-guard-"));
    const sessionPath = join(directory, "sessions", "state.json");
    const duplicateHash = tokenHash("persisted-duplicate-token");

    try {
      await mkdir(dirname(sessionPath), { recursive: true });
      await writeFile(
        sessionPath,
        JSON.stringify({
          version: 1,
          sessions: [
            sessionRecord({ accessTokenHash: duplicateHash }),
            sessionRecord({
              familyId: tokenHash("persisted-second-family"),
              accessTokenHash: duplicateHash,
              refreshTokenHash: tokenHash("persisted-second-refresh"),
            }),
          ],
        }),
        "utf8",
      );

      const store = createJsonStateStore(sessionPath, isSessionState);
      await expect(store.load()).rejects.toMatchObject({
        name: "StateStoreCorruptionError",
        filePath: sessionPath,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("authentication service", () => {
  it("rejects an account mapped to an agent without issuing or persisting a session", async () => {
    const sessions = new FailingSessionStore();
    const service = createAuthenticationService({
      actors: actorDirectory,
      identities: {
        async verify() {
          return { accountId: "account-agent", actorId: "agent-auth" };
        },
      },
      sessions,
      tokenFactory: createTokenFactory("agent-session-token"),
    });

    await expect(
      service.login({ accountId: "account-agent", secret: "valid-agent-secret" }),
    ).rejects.toMatchObject({ status: 403, code: "identity_forbidden" });
    expect(sessions.saveAttempts).toBe(0);
    await expect(service.authenticate("agent-session-token-1")).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });
  });

  it.each([
    { description: "agent", actorId: "agent-auth" },
    { description: "stale", actorId: "missing-human" },
  ])("rejects a persisted $description actor session for every credential decision", async ({ actorId }) => {
    const persisted = sessionRecord({ actorId });
    expect(isSessionState({ version: 1, sessions: [persisted] })).toBe(true);
    const sessions = new FailingSessionStore({
      version: 1,
      sessions: [persisted as unknown as SessionState["sessions"][number]],
    });
    const service = createAuthenticationService({
      actors: actorDirectory,
      identities: testIdentityAdapter,
      sessions,
      clock: () => 0,
      tokenFactory: createTokenFactory("persisted-invalid-actor"),
    });

    await expect(service.authenticate("access-token")).rejects.toMatchObject({
      status: 403,
      code: "identity_forbidden",
    });
    await expect(service.refresh("refresh-token")).rejects.toMatchObject({
      status: 403,
      code: "identity_forbidden",
    });
    await expect(service.revoke("access-token")).rejects.toMatchObject({
      status: 403,
      code: "identity_forbidden",
    });
    expect(sessions.saveAttempts).toBe(0);
  });

  it("handles initialization corruption before the first operation and reuses the exact error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-auth-init-"));
    const sessionPath = join(directory, "sessions.json");
    const unhandledReasons: unknown[] = [];
    const listenerCountBefore = process.listenerCount("unhandledRejection");
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };
    let loadSettled!: () => void;
    const loadWasAttempted = new Promise<void>((resolve) => {
      loadSettled = resolve;
    });
    let initializationError: unknown;

    process.on("unhandledRejection", onUnhandledRejection);
    try {
      await writeFile(sessionPath, "{not-json}", "utf8");
      const jsonStore = createJsonStateStore(sessionPath, isSessionState);
      const service = createAuthenticationService({
        identities: testIdentityAdapter,
        sessions: {
          async load() {
            try {
              return await jsonStore.load();
            } catch (error: unknown) {
              initializationError = error;
              throw error;
            } finally {
              loadSettled();
            }
          },
          save: (value) => jsonStore.save(value),
        },
        tokenFactory: createTokenFactory("corrupt-state-token"),
      });

      await loadWasAttempted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledReasons).toEqual([]);
      expect(initializationError).toBeInstanceOf(StateStoreCorruptionError);

      for (const operation of [
        () => service.login({ accountId: "account-li", secret: "correct-li" }),
        () => service.authenticate("access-token"),
        () => service.refresh("refresh-token"),
        () => service.revoke("access-token"),
      ]) {
        await expect(operation()).rejects.toBe(initializationError);
      }
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await rm(directory, { recursive: true, force: true });
    }

    expect(process.listenerCount("unhandledRejection")).toBe(listenerCountBefore);
  });

  it("survives restart and revokes the rotated family after refresh replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-auth-"));
    const sessionPath = join(directory, "sessions", "state.json");
    const tokenFactory = createTokenFactory("restart-token");
    let now = Date.parse("2026-08-09T00:00:00.000Z");

    try {
      const first = createAuthenticationService({
        identities: testIdentityAdapter,
        sessions: createJsonStateStore(sessionPath, isSessionState),
        clock: () => now,
        tokenFactory,
      });
      const issued = await first.login({
        accountId: "account-li",
        secret: "correct-li",
      });

      expect(issued).toMatchObject({ accountId: "account-li", actorId: "human-li" });

      const persisted = await readFile(sessionPath, "utf8");
      expect(persisted).toContain(
        createHash("sha256").update(issued.accessToken).digest("base64url"),
      );
      expect(persisted).toContain(
        createHash("sha256").update(issued.refreshToken).digest("base64url"),
      );
      expect(persisted).not.toContain(issued.accessToken);
      expect(persisted).not.toContain(issued.refreshToken);
      expect(persisted).not.toContain("correct-li");

      now += 1_000;
      const afterServerRestart = createAuthenticationService({
        identities: testIdentityAdapter,
        sessions: createJsonStateStore(sessionPath, isSessionState),
        clock: () => now,
        tokenFactory,
      });
      await expect(afterServerRestart.authenticate(issued.accessToken)).resolves.toEqual({
        accountId: "account-li",
        actorId: "human-li",
      });

      const rotated = await afterServerRestart.refresh(issued.refreshToken);
      expect(rotated.accessToken).not.toBe(issued.accessToken);
      expect(rotated.refreshToken).not.toBe(issued.refreshToken);
      await expect(afterServerRestart.authenticate(issued.accessToken)).rejects.toMatchObject({
        status: 403,
        code: "session_revoked",
      });
      await expect(afterServerRestart.refresh(issued.refreshToken)).rejects.toMatchObject({
        status: 403,
        code: "session_revoked",
      });
      await expect(afterServerRestart.authenticate(rotated.accessToken)).rejects.toMatchObject({
        status: 403,
        code: "session_revoked",
      });
      await expect(afterServerRestart.refresh(rotated.refreshToken)).rejects.toMatchObject({
        status: 403,
        code: "session_revoked",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("explicitly revokes both tokens in a fresh active family", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-auth-revoke-"));
    const sessionPath = join(directory, "sessions.json");

    try {
      const service = createAuthenticationService({
        identities: testIdentityAdapter,
        sessions: createJsonStateStore(sessionPath, isSessionState),
        tokenFactory: createTokenFactory("explicit-revoke-token"),
      });
      const issued = await service.login({
        accountId: "account-ada",
        secret: "correct-ada",
      });

      await expect(service.authenticate(issued.accessToken)).resolves.toEqual({
        accountId: "account-ada",
        actorId: "human-ada",
      });
      await service.revoke(issued.accessToken);
      await expect(service.authenticate(issued.accessToken)).rejects.toMatchObject({
        status: 403,
        code: "session_revoked",
      });
      await expect(service.refresh(issued.refreshToken)).rejects.toMatchObject({
        status: 403,
        code: "session_revoked",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns 401 for invalid credentials, missing tokens, and unknown or tampered tokens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-auth-"));
    const sessionPath = join(directory, "sessions.json");

    try {
      const service = createAuthenticationService({
        identities: testIdentityAdapter,
        sessions: createJsonStateStore(sessionPath, isSessionState),
        tokenFactory: createTokenFactory("invalid-token"),
      });

      await expect(
        service.login({ accountId: "account-li", secret: "wrong" }),
      ).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
      await expect(service.authenticate("")).rejects.toMatchObject({
        status: 401,
        code: "invalid_token",
      });
      await expect(service.authenticate("random-access-token")).rejects.toMatchObject({
        status: 401,
        code: "invalid_token",
      });

      const issued = await service.login({
        accountId: "account-li",
        secret: "correct-li",
      });
      await expect(service.authenticate(`${issued.accessToken}-tampered`)).rejects.toMatchObject({
        status: 401,
        code: "invalid_token",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a refresh session usable after its access token expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-auth-"));
    const sessionPath = join(directory, "sessions.json");
    let now = 10_000;

    try {
      const service = createAuthenticationService({
        identities: testIdentityAdapter,
        sessions: createJsonStateStore(sessionPath, isSessionState),
        clock: () => now,
        tokenFactory: createTokenFactory("expiry-token"),
        accessTtlMs: 1_000,
        refreshTtlMs: 10_000,
      });
      const issued = await service.login({
        accountId: "account-li",
        secret: "correct-li",
      });

      now = 11_001;
      await expect(service.authenticate(issued.accessToken)).rejects.toMatchObject({
        status: 401,
        code: "token_expired",
      });
      await expect(service.refresh(issued.refreshToken)).resolves.toMatchObject({
        accountId: "account-li",
        actorId: "human-li",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves two concurrent first-login sessions across a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-im-auth-"));
    const sessionPath = join(directory, "sessions.json");
    const tokenFactory = createTokenFactory("multi-account-token");

    try {
      const service = createAuthenticationService({
        identities: testIdentityAdapter,
        sessions: createJsonStateStore(sessionPath, isSessionState),
        tokenFactory,
      });
      const [lionel, ada] = await Promise.all([
        service.login({ accountId: "account-li", secret: "correct-li" }),
        service.login({ accountId: "account-ada", secret: "correct-ada" }),
      ]);

      await expect(service.authenticate(lionel.accessToken)).resolves.toEqual({
        accountId: "account-li",
        actorId: "human-li",
      });
      await expect(service.authenticate(ada.accessToken)).resolves.toEqual({
        accountId: "account-ada",
        actorId: "human-ada",
      });

      const restarted = createAuthenticationService({
        identities: testIdentityAdapter,
        sessions: createJsonStateStore(sessionPath, isSessionState),
        tokenFactory,
      });
      await expect(restarted.authenticate(lionel.accessToken)).resolves.toEqual({
        accountId: "account-li",
        actorId: "human-li",
      });
      await expect(restarted.authenticate(ada.accessToken)).resolves.toEqual({
        accountId: "account-ada",
        actorId: "human-ada",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a bound cross-principal refresh without mutating either session", async () => {
    const sessions = new FailingSessionStore();
    const service = createAuthenticationService({
      identities: testIdentityAdapter,
      sessions,
      tokenFactory: createTokenFactory("bound-refresh-token"),
    });
    const lionel = await service.login({
      accountId: "account-li",
      secret: "correct-li",
    });
    const ada = await service.login({
      accountId: "account-ada",
      secret: "correct-ada",
    });
    const saveAttemptsBeforeMismatch = sessions.saveAttempts;

    await expect(
      service.refresh(ada.refreshToken, {
        accountId: lionel.accountId,
        actorId: lionel.actorId,
      }),
    ).rejects.toMatchObject({ status: 403, code: "identity_forbidden" });
    expect(sessions.saveAttempts).toBe(saveAttemptsBeforeMismatch);

    await expect(service.authenticate(lionel.accessToken)).resolves.toEqual({
      accountId: lionel.accountId,
      actorId: lionel.actorId,
    });
    await expect(service.authenticate(ada.accessToken)).resolves.toEqual({
      accountId: ada.accountId,
      actorId: ada.actorId,
    });
    await expect(service.refresh(ada.refreshToken)).resolves.toMatchObject({
      accountId: ada.accountId,
      actorId: ada.actorId,
    });
  });

  it("does not publish a login session when persistence rejects", async () => {
    const sessions = new FailingSessionStore();
    const persistenceError = new Error("login persistence failed");
    const service = createAuthenticationService({
      identities: testIdentityAdapter,
      sessions,
      tokenFactory: createTokenFactory("failed-login-token"),
    });

    sessions.failNextSave(persistenceError);
    await expect(
      service.login({ accountId: "account-li", secret: "correct-li" }),
    ).rejects.toBe(persistenceError);
    await expect(service.authenticate("failed-login-token-1")).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });

    const retried = await service.login({
      accountId: "account-li",
      secret: "correct-li",
    });
    await expect(service.authenticate(retried.accessToken)).resolves.toMatchObject({
      actorId: "human-li",
    });
  });

  it("does not publish refresh rotation when persistence rejects", async () => {
    const sessions = new FailingSessionStore();
    const persistenceError = new Error("refresh persistence failed");
    const service = createAuthenticationService({
      identities: testIdentityAdapter,
      sessions,
      tokenFactory: createTokenFactory("failed-refresh-token"),
    });
    const issued = await service.login({
      accountId: "account-li",
      secret: "correct-li",
    });

    sessions.failNextSave(persistenceError);
    await expect(service.refresh(issued.refreshToken)).rejects.toBe(persistenceError);
    await expect(service.authenticate(issued.accessToken)).resolves.toMatchObject({
      actorId: "human-li",
    });
    await expect(service.authenticate("failed-refresh-token-3")).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });
    await expect(service.refresh(issued.refreshToken)).resolves.toMatchObject({
      actorId: "human-li",
    });
  });

  it("does not publish family revocation when persistence rejects", async () => {
    const sessions = new FailingSessionStore();
    const persistenceError = new Error("revoke persistence failed");
    const service = createAuthenticationService({
      identities: testIdentityAdapter,
      sessions,
      tokenFactory: createTokenFactory("failed-revoke-token"),
    });
    const issued = await service.login({
      accountId: "account-ada",
      secret: "correct-ada",
    });

    sessions.failNextSave(persistenceError);
    await expect(service.revoke(issued.accessToken)).rejects.toBe(persistenceError);
    await expect(service.authenticate(issued.accessToken)).resolves.toMatchObject({
      actorId: "human-ada",
    });
    await expect(service.refresh(issued.refreshToken)).resolves.toMatchObject({
      actorId: "human-ada",
    });
  });

  it("expires an access token at its exact expiry boundary", async () => {
    const sessions = new FailingSessionStore();
    let now = 1_000;
    const service = createAuthenticationService({
      identities: testIdentityAdapter,
      sessions,
      clock: () => now,
      tokenFactory: createTokenFactory("boundary-expiry-token"),
      accessTtlMs: 1_000,
      refreshTtlMs: 2_000,
    });
    const issued = await service.login({
      accountId: "account-li",
      secret: "correct-li",
    });

    now = 2_000;
    await expect(service.authenticate(issued.accessToken)).rejects.toMatchObject({
      status: 401,
      code: "token_expired",
    });
  });

  it("expires a refresh token at its exact expiry boundary", async () => {
    const sessions = new FailingSessionStore();
    let now = 1_000;
    const service = createAuthenticationService({
      identities: testIdentityAdapter,
      sessions,
      clock: () => now,
      tokenFactory: createTokenFactory("refresh-boundary-expiry-token"),
      accessTtlMs: 1_000,
      refreshTtlMs: 2_000,
    });
    const issued = await service.login({
      accountId: "account-li",
      secret: "correct-li",
    });

    now = 3_000;
    await expect(service.refresh(issued.refreshToken)).rejects.toMatchObject({
      status: 401,
      code: "token_expired",
    });
  });
});

describe("scrypt identity adapter", () => {
  it.each([
    {
      description: "one-byte",
      hash: Buffer.from([7]).toString("base64url"),
    },
    {
      description: "truncated 63-byte",
      hash: Buffer.alloc(63, 7).toString("base64url"),
    },
  ])("rejects a $description password hash synchronously", ({ hash }) => {
    expect(() =>
      createScryptIdentityAdapter([passwordIdentityRecord({ hash })]),
    ).toThrow(/hash.*64 bytes/);
  });

  it("rejects a non-canonical password hash synchronously", () => {
    expect(() =>
      createScryptIdentityAdapter([
        passwordIdentityRecord({ hash: `${validIdentityHash}=` }),
      ]),
    ).toThrow(/hash.*canonical base64url/);
  });

  it.each([
    { description: "empty", salt: "" },
    {
      description: "short",
      salt: Buffer.alloc(15, 7).toString("base64url"),
    },
    {
      description: "non-canonical",
      salt: `${validIdentitySalt}=`,
    },
  ])("rejects an $description password salt synchronously", ({ salt }) => {
    expect(() =>
      createScryptIdentityAdapter([passwordIdentityRecord({ salt })]),
    ).toThrow(/salt/);
  });

  it("rejects duplicate account IDs synchronously", () => {
    expect(() =>
      createScryptIdentityAdapter([
        passwordIdentityRecord(),
        passwordIdentityRecord({ actorId: "human-duplicate" }),
      ]),
    ).toThrow(/duplicate accountId/);
  });

  it.each([
    { field: "accountId", value: "" },
    { field: "actorId", value: "   " },
  ])("rejects an empty $field synchronously", ({ field, value }) => {
    expect(() =>
      createScryptIdentityAdapter([
        passwordIdentityRecord({ [field]: value }),
      ]),
    ).toThrow(new RegExp(field));
  });

  it("performs the same scrypt workload before rejecting a missing account", async () => {
    const record = passwordIdentityRecord();
    const identities = createScryptIdentityAdapter([record]);

    const knownAccountRequests = await countScryptRequests(() =>
      identities.verify({ accountId: "account-li", secret: "wrong" }),
    );
    const missingAccountRequests = await countScryptRequests(() =>
      identities.verify({ accountId: "missing", secret: "wrong" }),
    );

    expect(knownAccountRequests).toBe(1);
    expect(missingAccountRequests).toBe(knownAccountRequests);
  });

  it("verifies a salt/hash password record without storing plaintext credentials", async () => {
    const record = passwordIdentityRecord();
    const identities = createScryptIdentityAdapter([record]);

    await expect(
      identities.verify({ accountId: "account-li", secret: "correct-li" }),
    ).resolves.toEqual({ accountId: "account-li", actorId: "human-li" });
    await expect(
      identities.verify({ accountId: "account-li", secret: "wrong" }),
    ).resolves.toBeUndefined();
    await expect(
      identities.verify({ accountId: "missing", secret: "correct-li" }),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("correct-li");
  });
});
