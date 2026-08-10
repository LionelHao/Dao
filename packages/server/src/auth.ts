import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Actor } from "@native-im/core";
import type { StateStore } from "./state-store.js";
import type {
  AuthenticatedSessionContext,
  HashedSessionIssue,
  SessionAuthority,
} from "./persistence/contracts.js";

const DEFAULT_ACCESS_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SCRYPT_HASH_BYTES = 64;
const MIN_SCRYPT_SALT_BYTES = 16;
const DUMMY_SCRYPT_SALT = Buffer.from("native-im-auth-dummy-salt-v1", "utf8");
const DUMMY_SCRYPT_HASH = Buffer.alloc(SCRYPT_HASH_BYTES);
const SESSION_STATE_FIELDS = new Set(["version", "sessions"]);
const SESSION_RECORD_FIELDS = new Set([
  "familyId",
  "accountId",
  "actorId",
  "accessTokenHash",
  "refreshTokenHash",
  "accessExpiresAt",
  "refreshExpiresAt",
  "revokedAt",
]);

export interface LoginCredentials {
  readonly accountId: string;
  readonly secret: string;
}

export interface PasswordIdentityRecord {
  readonly accountId: string;
  readonly actorId: string;
  readonly salt: string;
  readonly hash: string;
}

export interface IdentityAdapter {
  verify(
    credentials: LoginCredentials,
  ): Promise<{ accountId: string; actorId: string } | undefined>;
}

export interface IssuedSession {
  readonly accountId: string;
  readonly actorId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly refreshExpiresAt: string;
}

export interface AuthenticatedPrincipal {
  readonly accountId: string;
  readonly actorId: string;
}

export type AuthenticationErrorCode =
  | "invalid_credentials"
  | "invalid_token"
  | "token_expired"
  | "session_revoked"
  | "identity_forbidden";

export class AuthenticationError extends Error {
  readonly status: 401 | 403;
  readonly code: AuthenticationErrorCode;

  constructor(status: 401 | 403, code: AuthenticationErrorCode) {
    super(code);
    this.name = "AuthenticationError";
    this.status = status;
    this.code = code;
  }
}

export interface AuthenticationService {
  login(credentials: LoginCredentials): Promise<IssuedSession>;
  authenticate(accessToken: string): Promise<AuthenticatedPrincipal>;
  authenticateSession(accessToken: string): Promise<AuthenticatedSessionContext>;
  refresh(
    refreshToken: string,
    expectedPrincipal?: AuthenticatedPrincipal,
  ): Promise<IssuedSession>;
  revoke(accessToken: string): Promise<void>;
}

export interface AuthenticationActorDirectory {
  getActor(actorId: string): Actor | undefined;
}

interface SessionRecord {
  readonly familyId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly accessTokenHash: string;
  readonly refreshTokenHash: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
  readonly revokedAt?: number;
}

export interface SessionState {
  readonly version: 1;
  readonly sessions: readonly SessionRecord[];
}

export interface AuthenticationServiceOptions {
  readonly actors: AuthenticationActorDirectory;
  readonly identities: IdentityAdapter;
  readonly sessions?: StateStore<SessionState>;
  readonly authority?: SessionAuthority;
  readonly clock?: () => number;
  readonly tokenFactory?: () => string;
  readonly accessTtlMs?: number;
  readonly refreshTtlMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): boolean {
  return Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && allowedFields.has(key),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function decodeCanonicalBase64Url(value: unknown): Buffer | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

function isTokenHash(value: unknown): value is string {
  return decodeCanonicalBase64Url(value)?.length === 32;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return (
    isRecord(value) &&
    hasOnlyFields(value, SESSION_RECORD_FIELDS) &&
    isTokenHash(value.familyId) &&
    isNonEmptyString(value.accountId) &&
    isNonEmptyString(value.actorId) &&
    isTokenHash(value.accessTokenHash) &&
    isTokenHash(value.refreshTokenHash) &&
    isFiniteTimestamp(value.accessExpiresAt) &&
    isFiniteTimestamp(value.refreshExpiresAt) &&
    (value.revokedAt === undefined || isFiniteTimestamp(value.revokedAt))
  );
}

export function isSessionState(value: unknown): value is SessionState {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, SESSION_STATE_FIELDS) ||
    value.version !== 1 ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(isSessionRecord)
  ) {
    return false;
  }

  const tokenHashes = new Set<string>();
  const familyPrincipals = new Map<
    string,
    { readonly accountId: string; readonly actorId: string }
  >();
  for (const session of value.sessions) {
    if (
      session.accessTokenHash === session.refreshTokenHash ||
      tokenHashes.has(session.accessTokenHash) ||
      tokenHashes.has(session.refreshTokenHash)
    ) {
      return false;
    }
    tokenHashes.add(session.accessTokenHash);
    tokenHashes.add(session.refreshTokenHash);

    const principal = familyPrincipals.get(session.familyId);
    if (
      principal !== undefined &&
      (principal.accountId !== session.accountId || principal.actorId !== session.actorId)
    ) {
      return false;
    }
    familyPrincipals.set(session.familyId, {
      accountId: session.accountId,
      actorId: session.actorId,
    });
  }

  return true;
}

function derivePassword(secret: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keyLength, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function validatePasswordIdentityRecords(
  accounts: readonly PasswordIdentityRecord[],
): void {
  const accountIds = new Set<string>();

  for (const account of accounts) {
    if (!isNonEmptyString(account.accountId)) {
      throw new TypeError("password identity accountId must be non-empty");
    }
    if (!isNonEmptyString(account.actorId)) {
      throw new TypeError("password identity actorId must be non-empty");
    }

    const salt = decodeCanonicalBase64Url(account.salt);
    if (salt === undefined) {
      throw new TypeError("password identity salt must use canonical base64url");
    }
    if (salt.length < MIN_SCRYPT_SALT_BYTES) {
      throw new TypeError(
        `password identity salt must decode to at least ${MIN_SCRYPT_SALT_BYTES} bytes`,
      );
    }

    const hash = decodeCanonicalBase64Url(account.hash);
    if (hash === undefined) {
      throw new TypeError("password identity hash must use canonical base64url");
    }
    if (hash.length !== SCRYPT_HASH_BYTES) {
      throw new TypeError(
        `password identity hash must decode to exactly ${SCRYPT_HASH_BYTES} bytes`,
      );
    }

    if (accountIds.has(account.accountId)) {
      throw new TypeError(`duplicate accountId: ${account.accountId}`);
    }
    accountIds.add(account.accountId);
  }
}

export function createScryptIdentityAdapter(
  accounts: readonly PasswordIdentityRecord[],
): IdentityAdapter {
  validatePasswordIdentityRecords(accounts);
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]));

  return {
    async verify(credentials: LoginCredentials) {
      const account = accountsById.get(credentials.accountId);
      const expectedHash =
        account === undefined
          ? DUMMY_SCRYPT_HASH
          : Buffer.from(account.hash, "base64url");
      const salt =
        account === undefined
          ? DUMMY_SCRYPT_SALT
          : Buffer.from(account.salt, "base64url");

      const actualHash = await derivePassword(
        credentials.secret,
        salt,
        expectedHash.length,
      );
      const verified = timingSafeEqual(actualHash, expectedHash);
      if (account === undefined || !verified) {
        return undefined;
      }

      return { accountId: account.accountId, actorId: account.actorId };
    },
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function invalidToken(): AuthenticationError {
  return new AuthenticationError(401, "invalid_token");
}

function revokedSession(): AuthenticationError {
  return new AuthenticationError(403, "session_revoked");
}

export function createAuthenticationService(
  options: AuthenticationServiceOptions,
): AuthenticationService {
  const clock = options.clock ?? Date.now;
  const tokenFactory =
    options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  const accessTtlMs = options.accessTtlMs ?? DEFAULT_ACCESS_TTL_MS;
  const refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;

  if (accessTtlMs <= 0 || !Number.isFinite(accessTtlMs)) {
    throw new RangeError("accessTtlMs must be a positive finite number");
  }
  if (refreshTtlMs <= 0 || !Number.isFinite(refreshTtlMs)) {
    throw new RangeError("refreshTtlMs must be a positive finite number");
  }
  if ((options.sessions === undefined) === (options.authority === undefined)) {
    throw new TypeError("exactly one authentication session authority is required");
  }

  let state: SessionState | undefined;
  let initializationFailure: { readonly error: unknown } | undefined;
  const initialized = options.sessions?.load().then(
    (loaded) => {
      state = loaded ?? { version: 1, sessions: [] };
    },
    (error: unknown) => {
      initializationFailure = { error };
    },
  ) ?? Promise.resolve();
  let operationQueue = Promise.resolve();

  function runExclusive<Result>(
    operation: (current: SessionState) => Promise<Result> | Result,
  ): Promise<Result> {
    const result = operationQueue.then(async () => {
      await initialized;
      if (initializationFailure !== undefined) {
        throw initializationFailure.error;
      }
      if (state === undefined) {
        throw new Error("authentication state failed to initialize");
      }
      return operation(state);
    });
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function persist(nextState: SessionState): Promise<void> {
    if (options.sessions === undefined) {
      throw new Error("JSON session persistence is unavailable");
    }
    await options.sessions.save(nextState);
    state = nextState;
  }

  function createAuthorityIssue(
    accountId: string,
    actorId: string,
    now: number,
  ): {
    readonly issued: IssuedSession;
    readonly input: HashedSessionIssue;
  } {
    const accessToken = tokenFactory();
    const refreshToken = tokenFactory();
    if (accessToken.length === 0 || refreshToken.length === 0) {
      throw new Error("tokenFactory must return non-empty tokens");
    }
    const accessTokenHash = hashToken(accessToken);
    const refreshTokenHash = hashToken(refreshToken);
    if (accessTokenHash === refreshTokenHash) {
      throw new Error("tokenFactory produced a duplicate token");
    }
    const accessExpiresAt = now + accessTtlMs;
    const refreshExpiresAt = now + refreshTtlMs;
    return {
      input: {
        accountId,
        actorId,
        accessTokenHash,
        refreshTokenHash,
        accessExpiresAt,
        refreshExpiresAt,
      },
      issued: {
        accountId,
        actorId,
        accessToken,
        refreshToken,
        expiresAt: new Date(accessExpiresAt).toISOString(),
        refreshExpiresAt: new Date(refreshExpiresAt).toISOString(),
      },
    };
  }

  function translateAuthorityError(error: unknown): never {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "invalid_token") {
      throw invalidToken();
    }
    if (code === "token_expired") {
      throw new AuthenticationError(401, "token_expired");
    }
    if (code === "session_revoked") {
      throw revokedSession();
    }
    if (code === "identity_forbidden") {
      throw new AuthenticationError(403, "identity_forbidden");
    }
    throw error;
  }

  function createIssuedRecord(
    current: SessionState,
    accountId: string,
    actorId: string,
    familyId: string | undefined,
    now: number,
  ): { issued: IssuedSession; record: SessionRecord } {
    const accessToken = tokenFactory();
    const refreshToken = tokenFactory();
    if (accessToken.length === 0 || refreshToken.length === 0) {
      throw new Error("tokenFactory must return non-empty tokens");
    }

    const accessTokenHash = hashToken(accessToken);
    const refreshTokenHash = hashToken(refreshToken);
    const hasCollision = current.sessions.some(
      (session) =>
        session.accessTokenHash === accessTokenHash ||
        session.refreshTokenHash === accessTokenHash ||
        session.accessTokenHash === refreshTokenHash ||
        session.refreshTokenHash === refreshTokenHash,
    );
    if (accessTokenHash === refreshTokenHash || hasCollision) {
      throw new Error("tokenFactory produced a duplicate token");
    }

    const accessExpiresAt = now + accessTtlMs;
    const refreshExpiresAt = now + refreshTtlMs;
    const record: SessionRecord = {
      familyId: familyId ?? accessTokenHash,
      accountId,
      actorId,
      accessTokenHash,
      refreshTokenHash,
      accessExpiresAt,
      refreshExpiresAt,
    };

    return {
      record,
      issued: {
        accountId,
        actorId,
        accessToken,
        refreshToken,
        expiresAt: new Date(accessExpiresAt).toISOString(),
        refreshExpiresAt: new Date(refreshExpiresAt).toISOString(),
      },
    };
  }

  async function revokeFamily(
    current: SessionState,
    familyId: string,
    revokedAt: number,
  ): Promise<void> {
    let changed = false;
    const sessions = current.sessions.map((session) => {
      if (session.familyId !== familyId || session.revokedAt !== undefined) {
        return session;
      }

      changed = true;
      return { ...session, revokedAt };
    });

    if (changed) {
      await persist({ version: 1, sessions });
    }
  }

  function requireHumanActor(actorId: string): void {
    if (options.actors.getActor(actorId)?.kind !== "human") {
      throw new AuthenticationError(403, "identity_forbidden");
    }
  }

  return {
    async login(credentials: LoginCredentials): Promise<IssuedSession> {
      const identity = await options.identities.verify(credentials);
      if (identity === undefined) {
        throw new AuthenticationError(401, "invalid_credentials");
      }

      requireHumanActor(identity.actorId);
      const now = clock();
      if (options.authority !== undefined) {
        const authorityIssue = createAuthorityIssue(
          identity.accountId,
          identity.actorId,
          now,
        );
        try {
          await options.authority.issue(authorityIssue.input);
          return authorityIssue.issued;
        } catch (error: unknown) {
          return translateAuthorityError(error);
        }
      }

      return runExclusive(async (current) => {
        const { issued, record } = createIssuedRecord(
          current,
          identity.accountId,
          identity.actorId,
          undefined,
          now,
        );
        await persist({ version: 1, sessions: [...current.sessions, record] });
        return issued;
      });
    },

    authenticate(accessToken: string): Promise<AuthenticatedPrincipal> {
      if (options.authority !== undefined) {
        if (accessToken.length === 0) {
          return Promise.reject(invalidToken());
        }
        return options.authority
          .authenticate(hashToken(accessToken), clock())
          .then(({ principal }) => principal)
          .catch((error: unknown) => translateAuthorityError(error));
      }
      return runExclusive((current) => {
        if (accessToken.length === 0) {
          throw invalidToken();
        }

        const accessTokenHash = hashToken(accessToken);
        const session = current.sessions.find(
          (candidate) => candidate.accessTokenHash === accessTokenHash,
        );
        if (session === undefined) {
          throw invalidToken();
        }
        requireHumanActor(session.actorId);
        if (session.revokedAt !== undefined) {
          throw revokedSession();
        }
        if (clock() >= session.accessExpiresAt) {
          throw new AuthenticationError(401, "token_expired");
        }

        return { accountId: session.accountId, actorId: session.actorId };
      });
    },

    authenticateSession(accessToken: string): Promise<AuthenticatedSessionContext> {
      if (accessToken.length === 0) {
        return Promise.reject(invalidToken());
      }
      const accessTokenHash = hashToken(accessToken);
      if (options.authority !== undefined) {
        return options.authority.authenticate(accessTokenHash, clock()).catch(
          (error: unknown) => translateAuthorityError(error),
        );
      }
      return runExclusive((current) => {
        const session = current.sessions.find(
          (candidate) => candidate.accessTokenHash === accessTokenHash,
        );
        if (session === undefined) {
          throw invalidToken();
        }
        requireHumanActor(session.actorId);
        if (session.revokedAt !== undefined) {
          throw revokedSession();
        }
        if (clock() >= session.accessExpiresAt) {
          throw new AuthenticationError(401, "token_expired");
        }
        return {
          sessionId: session.accessTokenHash,
          sessionFamilyId: session.familyId,
          principal: {
            accountId: session.accountId,
            actorId: session.actorId,
          },
        };
      });
    },

    refresh(
      refreshToken: string,
      expectedPrincipal?: AuthenticatedPrincipal,
    ): Promise<IssuedSession> {
      if (options.authority !== undefined) {
        const authority = options.authority;
        if (refreshToken.length === 0) {
          return Promise.reject(invalidToken());
        }
        const now = clock();
        return authority
          .validateRefresh(hashToken(refreshToken), expectedPrincipal, now)
          .then(() => {
            const accessToken = tokenFactory();
            const nextRefreshToken = tokenFactory();
            if (accessToken.length === 0 || nextRefreshToken.length === 0) {
              throw new Error("tokenFactory must return non-empty tokens");
            }
            const accessTokenHash = hashToken(accessToken);
            const refreshTokenHash = hashToken(nextRefreshToken);
            if (accessTokenHash === refreshTokenHash) {
              throw new Error("tokenFactory produced a duplicate token");
            }
            return authority.rotate({
              currentRefreshTokenHash: hashToken(refreshToken),
              accessTokenHash,
              refreshTokenHash,
              accessExpiresAt: now + accessTtlMs,
              refreshExpiresAt: now + refreshTtlMs,
              ...(expectedPrincipal === undefined ? {} : { expectedPrincipal }),
              now,
            }).then((record) => ({ record, accessToken, nextRefreshToken }));
          })
          .then(({ record, accessToken, nextRefreshToken }) => ({
            accountId: record.accountId,
            actorId: record.actorId,
            accessToken,
            refreshToken: nextRefreshToken,
            expiresAt: new Date(record.accessExpiresAt).toISOString(),
            refreshExpiresAt: new Date(record.refreshExpiresAt).toISOString(),
          }))
          .catch((error: unknown) => translateAuthorityError(error));
      }
      return runExclusive(async (current) => {
        if (refreshToken.length === 0) {
          throw invalidToken();
        }

        const refreshTokenHash = hashToken(refreshToken);
        const session = current.sessions.find(
          (candidate) => candidate.refreshTokenHash === refreshTokenHash,
        );
        if (session === undefined) {
          throw invalidToken();
        }
        requireHumanActor(session.actorId);
        if (
          expectedPrincipal !== undefined &&
          (session.accountId !== expectedPrincipal.accountId ||
            session.actorId !== expectedPrincipal.actorId)
        ) {
          throw new AuthenticationError(403, "identity_forbidden");
        }

        const now = clock();
        if (session.revokedAt !== undefined) {
          await revokeFamily(current, session.familyId, now);
          throw revokedSession();
        }
        if (now >= session.refreshExpiresAt) {
          throw new AuthenticationError(401, "token_expired");
        }

        const { issued, record } = createIssuedRecord(
          current,
          session.accountId,
          session.actorId,
          session.familyId,
          now,
        );
        const sessions = current.sessions.map((candidate) =>
          candidate === session ? { ...candidate, revokedAt: now } : candidate,
        );
        await persist({ version: 1, sessions: [...sessions, record] });
        return issued;
      });
    },

    revoke(accessToken: string): Promise<void> {
      if (options.authority !== undefined) {
        if (accessToken.length === 0) {
          return Promise.reject(invalidToken());
        }
        return options.authority
          .revoke(hashToken(accessToken), clock())
          .catch((error: unknown) => translateAuthorityError(error));
      }
      return runExclusive(async (current) => {
        if (accessToken.length === 0) {
          throw invalidToken();
        }

        const accessTokenHash = hashToken(accessToken);
        const session = current.sessions.find(
          (candidate) => candidate.accessTokenHash === accessTokenHash,
        );
        if (session === undefined) {
          throw invalidToken();
        }
        requireHumanActor(session.actorId);

        await revokeFamily(current, session.familyId, clock());
      });
    },
  };
}
