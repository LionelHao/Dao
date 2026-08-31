export const IDENTITY_CONTRACT_LIMITS = Object.freeze({
  accountId: 256,
  actorId: 256,
  secret: 4_096,
  sessionId: 128,
  deviceId: 128,
  deviceLabel: 128,
  token: 4_096,
  errorMessage: 512,
  // Must match the server's MAX_ACTIVE_SESSION_FAMILIES wire invariant.
  sessions: 96,
});

export type IdentityPlatform = "macos" | "windows" | "linux" | "unknown";

export interface IdentityPublicSession {
  readonly id: string;
  readonly deviceLabel: string;
  readonly platform: IdentityPlatform;
  readonly createdAt?: string;
  readonly refreshExpiresAt: string;
  readonly current: boolean;
}

export type IdentityPublicErrorCode =
  | "invalid_credentials"
  | "identity_forbidden"
  | "session_limit_reached"
  | "session_not_found"
  | "session_revoked"
  | "unavailable"
  | "credential_storage_unavailable"
  | "credential_storage_corrupt"
  | "internal_error";

export interface IdentityPublicError {
  readonly code: IdentityPublicErrorCode;
  readonly message: string;
}

export type IdentityPublicState =
  | { readonly status: "starting" }
  | {
      readonly status: "signed-out";
      readonly accountId?: string;
      readonly error?: IdentityPublicError;
    }
  | { readonly status: "authenticating"; readonly accountId: string }
  | { readonly status: "restoring"; readonly accountId?: string }
  | {
      readonly status: "authenticated";
      readonly accountId: string;
      readonly actorId: string;
      readonly sessions: readonly IdentityPublicSession[];
    }
  | {
      readonly status: "unavailable";
      readonly accountId?: string;
      readonly error: IdentityPublicError;
    }
  | { readonly status: "revoked"; readonly accountId?: string }
  | { readonly status: "fatal"; readonly error: IdentityPublicError };

export interface IdentityLoginInput {
  readonly accountId: string;
  readonly secret: string;
}

export interface IdentityRevokeSessionInput {
  readonly sessionId: string;
}

export interface IdentityBridge {
  getState(): Promise<IdentityPublicState>;
  login(input: IdentityLoginInput): Promise<IdentityPublicState>;
  refreshSessions(): Promise<IdentityPublicState>;
  revokeSession(input: IdentityRevokeSessionInput): Promise<IdentityPublicState>;
  logout(): Promise<IdentityPublicState>;
  onStateChanged(listener: (state: IdentityPublicState) => void): () => void;
}

export const IDENTITY_IPC_CHANNELS = Object.freeze({
  getState: "identity:get-state",
  login: "identity:login",
  refreshSessions: "identity:refresh-sessions",
  revokeSession: "identity:revoke-session",
  logout: "identity:logout",
  stateChanged: "identity:state-changed",
} as const);

/** Internal main-process credential material. This type is never part of IdentityBridge. */
export interface IdentityStoredCredentials {
  readonly version: 1;
  readonly accountId: string;
  readonly actorId: string;
  readonly sessionFamilyId?: string;
  readonly deviceId?: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly refreshExpiresAt: string;
}

export interface IdentityDevice {
  readonly id: string;
  readonly label: string;
  readonly platform: IdentityPlatform;
}

type UnknownRecord = Record<string, unknown>;
const utf8Encoder = new TextEncoder();

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: UnknownRecord, fields: ReadonlySet<string>): boolean {
  return (
    Reflect.ownKeys(value).length === fields.size &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && fields.has(key))
  );
}

function hasRequiredAndOptionalFields(
  value: UnknownRecord,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): boolean {
  return (
    [...required].every((field) => Object.hasOwn(value, field)) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && (required.has(key) || optional.has(key)),
    )
  );
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    utf8Encoder.encode(value).byteLength <= maximumLength;
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isBoundedString(value, 64)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isIdentityPlatform(value: unknown): value is IdentityPlatform {
  return value === "macos" || value === "windows" || value === "linux" || value === "unknown";
}

const LOGIN_FIELDS = new Set(["accountId", "secret"]);
const REVOKE_FIELDS = new Set(["sessionId"]);

export function isIdentityLoginInput(value: unknown): value is IdentityLoginInput {
  return isRecord(value) && hasOnlyFields(value, LOGIN_FIELDS) &&
    isBoundedString(value.accountId, IDENTITY_CONTRACT_LIMITS.accountId) &&
    isBoundedString(value.secret, IDENTITY_CONTRACT_LIMITS.secret);
}

export function isIdentityRevokeSessionInput(
  value: unknown,
): value is IdentityRevokeSessionInput {
  return isRecord(value) && hasOnlyFields(value, REVOKE_FIELDS) &&
    isBoundedString(value.sessionId, IDENTITY_CONTRACT_LIMITS.sessionId);
}

const PUBLIC_ERROR_CODES = new Set<IdentityPublicErrorCode>([
  "invalid_credentials",
  "identity_forbidden",
  "session_limit_reached",
  "session_not_found",
  "session_revoked",
  "unavailable",
  "credential_storage_unavailable",
  "credential_storage_corrupt",
  "internal_error",
]);
const ERROR_FIELDS = new Set(["code", "message"]);

function isIdentityPublicError(value: unknown): value is IdentityPublicError {
  return isRecord(value) && hasOnlyFields(value, ERROR_FIELDS) &&
    typeof value.code === "string" &&
    PUBLIC_ERROR_CODES.has(value.code as IdentityPublicErrorCode) &&
    isBoundedString(value.message, IDENTITY_CONTRACT_LIMITS.errorMessage);
}

const PUBLIC_SESSION_REQUIRED_FIELDS = new Set([
  "id",
  "deviceLabel",
  "platform",
  "refreshExpiresAt",
  "current",
]);
const PUBLIC_SESSION_OPTIONAL_FIELDS = new Set(["createdAt"]);

function isIdentityPublicSession(value: unknown): value is IdentityPublicSession {
  return isRecord(value) && hasRequiredAndOptionalFields(
    value,
    PUBLIC_SESSION_REQUIRED_FIELDS,
    PUBLIC_SESSION_OPTIONAL_FIELDS,
  ) &&
    isBoundedString(value.id, IDENTITY_CONTRACT_LIMITS.sessionId) &&
    isBoundedString(value.deviceLabel, IDENTITY_CONTRACT_LIMITS.deviceLabel) &&
    isIdentityPlatform(value.platform) &&
    isIsoTimestamp(value.refreshExpiresAt) &&
    (value.createdAt === undefined || isIsoTimestamp(value.createdAt)) &&
    typeof value.current === "boolean";
}

const STATUS_ONLY_FIELDS = new Set(["status"]);
const STATUS_ACCOUNT_REQUIRED_FIELDS = new Set(["status", "accountId"]);
const STATUS_ACCOUNT_OPTIONAL_REQUIRED_FIELDS = new Set(["status"]);
const STATUS_ACCOUNT_OPTIONAL_FIELDS = new Set(["accountId"]);
const SIGNED_OUT_OPTIONAL_FIELDS = new Set(["accountId", "error"]);
const AUTHENTICATED_FIELDS = new Set(["status", "accountId", "actorId", "sessions"]);
const UNAVAILABLE_REQUIRED_FIELDS = new Set(["status", "error"]);
const UNAVAILABLE_OPTIONAL_FIELDS = new Set(["accountId"]);
const FATAL_FIELDS = new Set(["status", "error"]);

export function isIdentityPublicState(value: unknown): value is IdentityPublicState {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "starting":
      return hasOnlyFields(value, STATUS_ONLY_FIELDS);
    case "signed-out":
      return hasRequiredAndOptionalFields(
        value,
        STATUS_ACCOUNT_OPTIONAL_REQUIRED_FIELDS,
        SIGNED_OUT_OPTIONAL_FIELDS,
      ) &&
        (value.accountId === undefined ||
          isBoundedString(value.accountId, IDENTITY_CONTRACT_LIMITS.accountId)) &&
        (value.error === undefined || isIdentityPublicError(value.error));
    case "authenticating":
      return hasOnlyFields(value, STATUS_ACCOUNT_REQUIRED_FIELDS) &&
        isBoundedString(value.accountId, IDENTITY_CONTRACT_LIMITS.accountId);
    case "restoring":
    case "revoked":
      return hasRequiredAndOptionalFields(
        value,
        STATUS_ACCOUNT_OPTIONAL_REQUIRED_FIELDS,
        STATUS_ACCOUNT_OPTIONAL_FIELDS,
      ) && (value.accountId === undefined ||
        isBoundedString(value.accountId, IDENTITY_CONTRACT_LIMITS.accountId));
    case "authenticated":
      return hasOnlyFields(value, AUTHENTICATED_FIELDS) &&
        isBoundedString(value.accountId, IDENTITY_CONTRACT_LIMITS.accountId) &&
        isBoundedString(value.actorId, IDENTITY_CONTRACT_LIMITS.actorId) &&
        Array.isArray(value.sessions) && value.sessions.length <= IDENTITY_CONTRACT_LIMITS.sessions &&
        value.sessions.every(isIdentityPublicSession);
    case "unavailable":
      return hasRequiredAndOptionalFields(
        value,
        UNAVAILABLE_REQUIRED_FIELDS,
        UNAVAILABLE_OPTIONAL_FIELDS,
      ) && isIdentityPublicError(value.error) &&
        (value.accountId === undefined ||
          isBoundedString(value.accountId, IDENTITY_CONTRACT_LIMITS.accountId));
    case "fatal":
      return hasOnlyFields(value, FATAL_FIELDS) && isIdentityPublicError(value.error);
    default:
      return false;
  }
}

function clonePublicError(error: IdentityPublicError): IdentityPublicError {
  return Object.freeze({ code: error.code, message: error.message });
}

function clonePublicSession(session: IdentityPublicSession): IdentityPublicSession {
  return Object.freeze({
    id: session.id,
    deviceLabel: session.deviceLabel,
    platform: session.platform,
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    refreshExpiresAt: session.refreshExpiresAt,
    current: session.current,
  });
}

/**
 * Validates, strips to the explicit DTO, and deeply freezes an IPC/public state value.
 */
export function cloneIdentityPublicState(value: unknown): IdentityPublicState {
  if (!isIdentityPublicState(value)) {
    throw new TypeError("Invalid public Identity state");
  }
  switch (value.status) {
    case "starting":
      return Object.freeze({ status: "starting" });
    case "signed-out":
      return Object.freeze({
        status: "signed-out",
        ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
        ...(value.error === undefined ? {} : { error: clonePublicError(value.error) }),
      });
    case "authenticating":
      return Object.freeze({ status: "authenticating", accountId: value.accountId });
    case "restoring":
      return Object.freeze({
        status: "restoring",
        ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
      });
    case "authenticated":
      return Object.freeze({
        status: "authenticated",
        accountId: value.accountId,
        actorId: value.actorId,
        sessions: Object.freeze(value.sessions.map(clonePublicSession)),
      });
    case "unavailable":
      return Object.freeze({
        status: "unavailable",
        ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
        error: clonePublicError(value.error),
      });
    case "revoked":
      return Object.freeze({
        status: "revoked",
        ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
      });
    case "fatal":
      return Object.freeze({ status: "fatal", error: clonePublicError(value.error) });
  }
}
