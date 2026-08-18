import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Actor } from "@native-im/core";
import type { StateStore } from "./state-store.js";
import type {
  AuthenticatedSessionContext,
  HashedSessionIssue,
  PublicSession,
  SessionDevice,
  SessionPlatform,
  SessionAuthority,
} from "./persistence/contracts.js";
import { MAX_ACTIVE_SESSION_FAMILIES } from "./persistence/contracts.js";

export { MAX_ACTIVE_SESSION_FAMILIES } from "./persistence/contracts.js";
export type { PublicSession, SessionDevice, SessionPlatform } from "./persistence/contracts.js";

const DEFAULT_ACCESS_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SCRYPT_HASH_BYTES = 64;
const MIN_SCRYPT_SALT_BYTES = 16;
const DUMMY_SCRYPT_SALT = Buffer.from("native-im-auth-dummy-salt-v1", "utf8");
const DUMMY_SCRYPT_HASH = Buffer.alloc(SCRYPT_HASH_BYTES);
export const SESSION_DEVICE_ID_MAX_BYTES = 128;
export const SESSION_DEVICE_LABEL_MAX_BYTES = 128;
const DEFAULT_SESSION_DEVICE: SessionDevice = Object.freeze({
  id: "unknown",
  label: "Unknown device",
  platform: "unknown",
});
const LEGACY_SESSION_DEVICE: SessionDevice = Object.freeze({
  id: "legacy",
  label: "Legacy device",
  platform: "unknown",
});
const LEGACY_PUBLIC_SESSION_ID_DOMAIN = "native-im:legacy-public-session-id:v1\0";
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
  "publicSessionId",
  "deviceId",
  "deviceLabel",
  "platform",
  "createdAt",
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
  readonly sessionId: string;
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
  | "session_not_found"
  | "session_limit_reached"
  | "identity_forbidden";

export class AuthenticationError extends Error {
  readonly status: 401 | 403 | 404 | 409;
  readonly code: AuthenticationErrorCode;

  constructor(status: 401 | 403 | 404 | 409, code: AuthenticationErrorCode) {
    super(code);
    this.name = "AuthenticationError";
    this.status = status;
    this.code = code;
  }
}

export interface AuthenticationService {
  login(credentials: LoginCredentials, device?: SessionDevice): Promise<IssuedSession>;
  authenticate(accessToken: string): Promise<AuthenticatedPrincipal>;
  authenticateSession(accessToken: string): Promise<AuthenticatedSessionContext>;
  refresh(
    refreshToken: string,
    expectedPrincipal?: AuthenticatedPrincipal,
  ): Promise<IssuedSession>;
  revoke(accessToken: string): Promise<void>;
  listSessions(accessToken: string): Promise<readonly PublicSession[]>;
  revokeSession(accessToken: string, sessionId: string): Promise<void>;
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
  readonly publicSessionId?: string;
  readonly deviceId?: string;
  readonly deviceLabel?: string;
  readonly platform?: SessionPlatform;
  readonly createdAt?: number;
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
  readonly sessionIdFactory?: () => string;
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

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return isNonEmptyString(value) && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isSessionPlatform(value: unknown): value is SessionPlatform {
  return value === "macos" || value === "windows" || value === "linux" || value === "unknown";
}

function validateSessionDevice(device: SessionDevice): SessionDevice {
  if (!isBoundedText(device.id, SESSION_DEVICE_ID_MAX_BYTES)) {
    throw new TypeError(
      `session device id must be 1-${SESSION_DEVICE_ID_MAX_BYTES} UTF-8 bytes`,
    );
  }
  if (!isBoundedText(device.label, SESSION_DEVICE_LABEL_MAX_BYTES)) {
    throw new TypeError(
      `session device label must be 1-${SESSION_DEVICE_LABEL_MAX_BYTES} UTF-8 bytes`,
    );
  }
  if (!isSessionPlatform(device.platform)) {
    throw new TypeError("session device platform is invalid");
  }
  return Object.freeze({ id: device.id, label: device.label, platform: device.platform });
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
  if (!isRecord(value)) {
    return false;
  }
  const deviceFields = [
    "publicSessionId",
    "deviceId",
    "deviceLabel",
    "platform",
  ] as const;
  const presentDeviceFields = deviceFields.filter((field) => Object.hasOwn(value, field));
  return (
    hasOnlyFields(value, SESSION_RECORD_FIELDS) &&
    isTokenHash(value.familyId) &&
    isNonEmptyString(value.accountId) &&
    isNonEmptyString(value.actorId) &&
    isTokenHash(value.accessTokenHash) &&
    isTokenHash(value.refreshTokenHash) &&
    isFiniteTimestamp(value.accessExpiresAt) &&
    isFiniteTimestamp(value.refreshExpiresAt) &&
    (value.revokedAt === undefined || isFiniteTimestamp(value.revokedAt)) &&
    ((presentDeviceFields.length === 0 && value.createdAt === undefined) ||
      (presentDeviceFields.length === deviceFields.length &&
        isBoundedText(value.publicSessionId, SESSION_DEVICE_ID_MAX_BYTES) &&
        isBoundedText(value.deviceId, SESSION_DEVICE_ID_MAX_BYTES) &&
        isBoundedText(value.deviceLabel, SESSION_DEVICE_LABEL_MAX_BYTES) &&
        isSessionPlatform(value.platform) &&
        (value.createdAt === undefined || isFiniteTimestamp(value.createdAt))))
  );
}

export function deriveLegacyPublicSessionId(familyId: string): string {
  return createHash("sha256")
    .update(LEGACY_PUBLIC_SESSION_ID_DOMAIN, "utf8")
    .update(familyId, "utf8")
    .digest("base64url");
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
    {
      readonly accountId: string;
      readonly actorId: string;
      readonly publicSessionId?: string;
      readonly deviceId?: string;
      readonly deviceLabel?: string;
      readonly platform?: SessionPlatform;
      readonly createdAt?: number;
    }
  >();
  const publicSessionIds = new Map<string, string>();
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
      (principal.accountId !== session.accountId ||
        principal.actorId !== session.actorId ||
        principal.publicSessionId !== session.publicSessionId ||
        principal.deviceId !== session.deviceId ||
        principal.deviceLabel !== session.deviceLabel ||
        principal.platform !== session.platform ||
        principal.createdAt !== session.createdAt)
    ) {
      return false;
    }
    if (principal === undefined) {
      const publicSessionId =
        session.publicSessionId ?? deriveLegacyPublicSessionId(session.familyId);
      const existingFamily = publicSessionIds.get(publicSessionId);
      if (existingFamily !== undefined && existingFamily !== session.familyId) {
        return false;
      }
      publicSessionIds.set(publicSessionId, session.familyId);
      familyPrincipals.set(session.familyId, {
        accountId: session.accountId,
        actorId: session.actorId,
        ...(session.publicSessionId === undefined
          ? {}
          : {
              publicSessionId: session.publicSessionId,
              deviceId: session.deviceId,
              deviceLabel: session.deviceLabel,
              platform: session.platform,
              createdAt: session.createdAt,
            }),
      });
    }
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
  const sessionIdFactory =
    options.sessionIdFactory ?? (() => randomBytes(32).toString("base64url"));
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
    device: SessionDevice,
    now: number,
  ): {
    readonly issued: IssuedSession;
    readonly input: HashedSessionIssue;
  } {
    const accessToken = tokenFactory();
    const refreshToken = tokenFactory();
    const publicSessionId = sessionIdFactory();
    if (accessToken.length === 0 || refreshToken.length === 0) {
      throw new Error("tokenFactory must return non-empty tokens");
    }
    const accessTokenHash = hashToken(accessToken);
    const refreshTokenHash = hashToken(refreshToken);
    if (accessTokenHash === refreshTokenHash) {
      throw new Error("tokenFactory produced a duplicate token");
    }
    if (!isBoundedText(publicSessionId, SESSION_DEVICE_ID_MAX_BYTES)) {
      throw new Error("sessionIdFactory must return a bounded non-empty identifier");
    }
    const accessExpiresAt = now + accessTtlMs;
    const refreshExpiresAt = now + refreshTtlMs;
    return {
      input: {
        accountId,
        actorId,
        publicSessionId,
        device,
        accessTokenHash,
        refreshTokenHash,
        accessExpiresAt,
        refreshExpiresAt,
        now,
      },
      issued: {
        sessionId: publicSessionId,
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
    if (code === "session_not_found") {
      throw new AuthenticationError(404, "session_not_found");
    }
    if (code === "session_limit_reached") {
      throw new AuthenticationError(409, "session_limit_reached");
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
    publicSessionId: string | undefined,
    device: SessionDevice | undefined,
    createdAt: number | null | undefined,
    now: number,
  ): { issued: IssuedSession; record: SessionRecord } {
    const accessToken = tokenFactory();
    const refreshToken = tokenFactory();
    const nextPublicSessionId = publicSessionId ?? sessionIdFactory();
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
    if (!isBoundedText(nextPublicSessionId, SESSION_DEVICE_ID_MAX_BYTES)) {
      throw new Error("sessionIdFactory must return a bounded non-empty identifier");
    }
    const publicIdCollision = current.sessions.some(
      (session) =>
        session.familyId !== familyId &&
        (session.publicSessionId ?? deriveLegacyPublicSessionId(session.familyId)) ===
          nextPublicSessionId,
    );
    if (publicIdCollision) {
      throw new Error("sessionIdFactory produced a duplicate session identifier");
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
      publicSessionId: nextPublicSessionId,
      deviceId: device?.id ?? DEFAULT_SESSION_DEVICE.id,
      deviceLabel: device?.label ?? DEFAULT_SESSION_DEVICE.label,
      platform: device?.platform ?? DEFAULT_SESSION_DEVICE.platform,
      ...(createdAt === null ? {} : { createdAt: createdAt ?? now }),
    };

    return {
      record,
      issued: {
        sessionId: nextPublicSessionId,
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

  function publicSessionId(session: SessionRecord): string {
    return session.publicSessionId ?? deriveLegacyPublicSessionId(session.familyId);
  }

  function requireJsonAccessSession(
    current: SessionState,
    accessToken: string,
    now: number,
  ): SessionRecord {
    if (accessToken.length === 0) {
      throw invalidToken();
    }
    const session = current.sessions.find(
      (candidate) => candidate.accessTokenHash === hashToken(accessToken),
    );
    if (session === undefined) {
      throw invalidToken();
    }
    requireHumanActor(session.actorId);
    if (session.revokedAt !== undefined) {
      throw revokedSession();
    }
    if (now >= session.accessExpiresAt) {
      throw new AuthenticationError(401, "token_expired");
    }
    return session;
  }

  return {
    async login(
      credentials: LoginCredentials,
      device: SessionDevice = DEFAULT_SESSION_DEVICE,
    ): Promise<IssuedSession> {
      const validatedDevice = validateSessionDevice(device);
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
          validatedDevice,
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
        const familyCapacity = new Map<string, {
          active: boolean;
          refreshExpiresAt: number;
          createdAt: number;
          publicSessionId: string;
        }>();
        for (const session of current.sessions) {
          if (
            session.accountId !== identity.accountId ||
            session.actorId !== identity.actorId
          ) {
            continue;
          }
          const family = familyCapacity.get(session.familyId);
          familyCapacity.set(session.familyId, {
            active: (family?.active ?? false) || session.revokedAt === undefined,
            refreshExpiresAt: Math.max(
              family?.refreshExpiresAt ?? -1,
              session.refreshExpiresAt,
            ),
            createdAt: family?.createdAt ?? session.createdAt ?? -1,
            publicSessionId:
              family?.publicSessionId ?? publicSessionId(session),
          });
        }
        const activeFamilies = [...familyCapacity.entries()]
          .filter(([, family]) => family.active && family.refreshExpiresAt > now)
          .sort((left, right) =>
            left[1].createdAt - right[1].createdAt ||
            left[1].publicSessionId.localeCompare(right[1].publicSessionId));
        if (activeFamilies.length > MAX_ACTIVE_SESSION_FAMILIES) {
          throw new AuthenticationError(409, "session_limit_reached");
        }
        const evictedFamilyId = activeFamilies.length === MAX_ACTIVE_SESSION_FAMILIES
          ? activeFamilies[0]?.[0]
          : undefined;
        const sessionsBeforeIssue = evictedFamilyId === undefined
          ? current.sessions
          : current.sessions.map((session) =>
              session.familyId === evictedFamilyId && session.revokedAt === undefined
                ? { ...session, revokedAt: now }
                : session);
        const stateBeforeIssue = { version: 1, sessions: sessionsBeforeIssue } as const;
        const { issued, record } = createIssuedRecord(
          stateBeforeIssue,
          identity.accountId,
          identity.actorId,
          undefined,
          undefined,
          validatedDevice,
          undefined,
          now,
        );
        await persist({ version: 1, sessions: [...sessionsBeforeIssue, record] });
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
            sessionId: record.publicSessionId,
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

        const normalizedDevice = session.publicSessionId === undefined
          ? LEGACY_SESSION_DEVICE
          : {
              id: session.deviceId ?? DEFAULT_SESSION_DEVICE.id,
              label: session.deviceLabel ?? DEFAULT_SESSION_DEVICE.label,
              platform: session.platform ?? DEFAULT_SESSION_DEVICE.platform,
            };
        const normalizedFamily = {
          publicSessionId: publicSessionId(session),
          deviceId: normalizedDevice.id,
          deviceLabel: normalizedDevice.label,
          platform: normalizedDevice.platform,
          ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
        } as const;
        const { issued, record } = createIssuedRecord(
          current,
          session.accountId,
          session.actorId,
          session.familyId,
          normalizedFamily.publicSessionId,
          normalizedDevice,
          session.createdAt ?? null,
          now,
        );
        const sessions = current.sessions.map((candidate) => {
          if (candidate.familyId !== session.familyId) return candidate;
          return {
            ...candidate,
            ...normalizedFamily,
            ...(candidate === session ? { revokedAt: now } : {}),
          };
        });
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

    listSessions(accessToken: string): Promise<readonly PublicSession[]> {
      const now = clock();
      if (options.authority !== undefined) {
        if (accessToken.length === 0) {
          return Promise.reject(invalidToken());
        }
        return options.authority
          .listSessions(hashToken(accessToken), now)
          .catch((error: unknown) => translateAuthorityError(error));
      }
      return runExclusive((current) => {
        const caller = requireJsonAccessSession(current, accessToken, now);
        const families = new Map<string, SessionRecord[]>();
        for (const session of current.sessions) {
          if (session.accountId !== caller.accountId || session.actorId !== caller.actorId) {
            continue;
          }
          const family = families.get(session.familyId) ?? [];
          family.push(session);
          families.set(session.familyId, family);
        }
        const projected = [...families.entries()]
          .flatMap(([familyId, generations]) => {
            const active = generations.filter((generation) => generation.revokedAt === undefined);
            const refreshExpiresAt = Math.max(
              ...generations.map((generation) => generation.refreshExpiresAt),
            );
            if (active.length === 0 || now >= refreshExpiresAt) {
              return [];
            }
            const canonical = generations[0];
            if (canonical === undefined) {
              return [];
            }
            return [{
              id: publicSessionId(canonical),
              deviceLabel: canonical.deviceLabel ?? "Legacy device",
              platform: canonical.platform ?? "unknown",
              ...(canonical.createdAt === undefined
                ? {}
                : { createdAt: new Date(canonical.createdAt).toISOString() }),
              refreshExpiresAt: new Date(refreshExpiresAt).toISOString(),
              current: familyId === caller.familyId,
              sortCreatedAt: canonical.createdAt ?? -1,
            }];
          })
          .sort((left, right) =>
            right.sortCreatedAt - left.sortCreatedAt || left.id.localeCompare(right.id))
          .map((session) => ({
            id: session.id,
            deviceLabel: session.deviceLabel,
            platform: session.platform,
            ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
            refreshExpiresAt: session.refreshExpiresAt,
            current: session.current,
          }));
        if (projected.length > MAX_ACTIVE_SESSION_FAMILIES) {
          throw new AuthenticationError(409, "session_limit_reached");
        }
        return projected;
      });
    },

    revokeSession(accessToken: string, sessionId: string): Promise<void> {
      const now = clock();
      if (!isBoundedText(sessionId, SESSION_DEVICE_ID_MAX_BYTES)) {
        return Promise.reject(new AuthenticationError(404, "session_not_found"));
      }
      if (options.authority !== undefined) {
        if (accessToken.length === 0) {
          return Promise.reject(invalidToken());
        }
        return options.authority
          .revokeSession(hashToken(accessToken), sessionId, now)
          .catch((error: unknown) => translateAuthorityError(error));
      }
      return runExclusive(async (current) => {
        const caller = requireJsonAccessSession(current, accessToken, now);
        const target = current.sessions.find(
          (candidate) =>
            candidate.accountId === caller.accountId &&
            candidate.actorId === caller.actorId &&
            publicSessionId(candidate) === sessionId,
        );
        if (target === undefined) {
          throw new AuthenticationError(404, "session_not_found");
        }
        await revokeFamily(current, target.familyId, now);
      });
    },
  };
}
