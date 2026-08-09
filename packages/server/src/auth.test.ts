import { createHash, scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAuthenticationService,
  createJsonStateStore,
  createScryptIdentityAdapter,
  isSessionState,
  type IdentityAdapter,
  type LoginCredentials,
  type PasswordIdentityRecord,
} from "./index.js";

const accounts = new Map([
  ["account-li", { actorId: "human-li", secret: "correct-li" }],
  ["account-ada", { actorId: "human-ada", secret: "correct-ada" }],
]);

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

describe("authentication service", () => {
  it("survives restart, rotates refresh tokens, detects replay, and revokes the family", async () => {
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

      await afterServerRestart.revoke(rotated.accessToken);
      await expect(afterServerRestart.authenticate(rotated.accessToken)).rejects.toMatchObject({
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
});

describe("scrypt identity adapter", () => {
  it("verifies a salt/hash password record without storing plaintext credentials", async () => {
    const salt = Buffer.from("identity-salt", "utf8").toString("base64url");
    const record: PasswordIdentityRecord = {
      accountId: "account-li",
      actorId: "human-li",
      salt,
      hash: scryptSync("correct-li", Buffer.from(salt, "base64url"), 64).toString(
        "base64url",
      ),
    };
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
