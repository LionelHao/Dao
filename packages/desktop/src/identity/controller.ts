import {
  cloneIdentityPublicState,
  isIdentityLoginInput,
  isIdentityRevokeSessionInput,
  type IdentityLoginInput,
  type IdentityPublicError,
  type IdentityPublicSession,
  type IdentityPublicState,
  type IdentityRevokeSessionInput,
  type IdentityStoredCredentials,
} from "./contracts.js";
import {
  CredentialVaultError,
  type IdentityCredentialVault,
} from "./credential-vault.js";
import type { DeviceIdentityStore } from "./device-identity.js";
import {
  IdentityTransportError,
  type IdentityIssuedSession,
  type IdentityWebSocketClient,
} from "./websocket-client.js";

export interface AuthorizedStateInvalidator {
  invalidate(): void | Promise<void>;
}

export const NOOP_AUTHORIZED_STATE_INVALIDATOR: AuthorizedStateInvalidator = Object.freeze({
  invalidate(): void {
    // Room/cache authority is introduced by FT-13/14; Identity still owns this explicit port.
  },
});

export type IdentityControllerErrorCode =
  | "session_not_found"
  | "identity_controller_closed"
  | "identity_invalid_state";

export class IdentityControllerError extends Error {
  readonly code: IdentityControllerErrorCode;

  constructor(code: IdentityControllerErrorCode) {
    super(`Identity operation failed: ${code}`);
    this.name = "IdentityControllerError";
    this.code = code;
  }
}

export interface IdentitySessionController {
  getState(): IdentityPublicState;
  getCurrentAuthoritySession(): IdentityAuthoritySession | undefined;
  initialize(): Promise<IdentityPublicState>;
  login(input: IdentityLoginInput): Promise<IdentityPublicState>;
  refreshSessions(): Promise<IdentityPublicState>;
  revokeSession(input: IdentityRevokeSessionInput): Promise<IdentityPublicState>;
  logout(): Promise<IdentityPublicState>;
  subscribe(listener: (state: IdentityPublicState) => void): () => void;
  close(): void;
}

/** Main-process-only authority material. This is never part of IdentityPublicState or preload. */
export interface IdentityAuthoritySession {
  readonly actorId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly expiresAt: string;
}

const PUBLIC_ERRORS = Object.freeze({
  invalidCredentials: Object.freeze({
    code: "invalid_credentials",
    message: "账号或密码不正确。",
  }) satisfies IdentityPublicError,
  identityForbidden: Object.freeze({
    code: "identity_forbidden",
    message: "该身份不能用于真人登录。",
  }) satisfies IdentityPublicError,
  sessionLimitReached: Object.freeze({
    code: "session_limit_reached",
    message: "活跃设备会话已达上限，请先在其他设备退出登录。",
  }) satisfies IdentityPublicError,
  unavailable: Object.freeze({
    code: "unavailable",
    message: "身份服务暂时不可用，请重试。",
  }) satisfies IdentityPublicError,
  storageUnavailable: Object.freeze({
    code: "credential_storage_unavailable",
    message: "系统安全凭据存储不可用。",
  }) satisfies IdentityPublicError,
  storageCorrupt: Object.freeze({
    code: "credential_storage_corrupt",
    message: "安全凭据已损坏，需要重新登录。",
  }) satisfies IdentityPublicError,
  internal: Object.freeze({
    code: "internal_error",
    message: "身份状态无法安全恢复。",
  }) satisfies IdentityPublicError,
});

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function storedFromIssued(session: IdentityIssuedSession): IdentityStoredCredentials {
  return Object.freeze({ version: 1, ...session });
}

function credentialsMatchIssued(
  current: IdentityStoredCredentials,
  issued: IdentityIssuedSession,
): boolean {
  return current.accountId === issued.accountId && current.actorId === issued.actorId &&
    current.sessionId === issued.sessionId;
}

function sessionsMatchCurrent(
  sessions: readonly IdentityPublicSession[],
  sessionId: string,
): boolean {
  return sessions.filter((session) => session.current).length === 1 &&
    sessions.some((session) => session.current && session.id === sessionId);
}

export function createIdentitySessionController(options: {
  readonly vault: IdentityCredentialVault;
  readonly deviceIdentity: DeviceIdentityStore;
  readonly clientFactory: () => IdentityWebSocketClient;
  readonly authorizedState?: AuthorizedStateInvalidator;
}): IdentitySessionController {
  const authorizedState = options.authorizedState ?? NOOP_AUTHORIZED_STATE_INVALIDATOR;
  const listeners = new Set<(state: IdentityPublicState) => void>();
  let state: IdentityPublicState = cloneIdentityPublicState({ status: "starting" });
  let activeClient: IdentityWebSocketClient | undefined;
  let activeCredentials: IdentityStoredCredentials | undefined;
  let terminalUnsubscribe: (() => void) | undefined;
  let connectionFailureUnsubscribe: (() => void) | undefined;
  let closed = false;
  let operationTail: Promise<void> = Promise.resolve();

  const getState = (): IdentityPublicState => cloneIdentityPublicState(state);
  const getCurrentAuthoritySession = (): IdentityAuthoritySession | undefined => {
    const credentials = activeCredentials;
    if (state.status !== "authenticated" || credentials === undefined) return undefined;
    return Object.freeze({
      actorId: credentials.actorId,
      sessionId: credentials.sessionId,
      accessToken: credentials.accessToken,
      expiresAt: credentials.expiresAt,
    });
  };

  const publish = (next: IdentityPublicState): IdentityPublicState => {
    const closedState = cloneIdentityPublicState(next);
    state = closedState;
    if (!closed) {
      for (const listener of [...listeners]) {
        try {
          listener(cloneIdentityPublicState(closedState));
        } catch {
          // A renderer/public observer cannot roll back the main-process state transition.
        }
      }
    }
    return getState();
  };

  const disposeClient = (client = activeClient): void => {
    if (client === undefined) return;
    if (client === activeClient) {
      terminalUnsubscribe?.();
      terminalUnsubscribe = undefined;
      connectionFailureUnsubscribe?.();
      connectionFailureUnsubscribe = undefined;
      activeClient = undefined;
    }
    try {
      client.close();
    } catch {
      // Local authority was already removed; transport cleanup is idempotent best effort.
    }
  };

  const invalidateAuthorizedState = async (): Promise<void> => {
    try {
      await authorizedState.invalidate();
    } catch {
      // Public state must remain locked even if a future cache adapter cannot finish cleanup.
    }
  };

  const transitionUnavailable = async (accountId?: string): Promise<IdentityPublicState> => {
    disposeClient();
    activeCredentials = undefined;
    state = cloneIdentityPublicState({ status: "starting" });
    await invalidateAuthorizedState();
    return publish({
      status: "unavailable",
      ...(accountId === undefined ? {} : { accountId }),
      error: PUBLIC_ERRORS.unavailable,
    });
  };

  const transitionCleared = async (
    status: "signed-out" | "revoked",
    accountId?: string,
  ): Promise<IdentityPublicState> => {
    disposeClient();
    activeCredentials = undefined;
    state = cloneIdentityPublicState({ status: "starting" });
    let clearFailed = false;
    try {
      await options.vault.clear();
    } catch {
      clearFailed = true;
    }
    await invalidateAuthorizedState();
    if (clearFailed) {
      return publish({ status: "fatal", error: PUBLIC_ERRORS.storageUnavailable });
    }
    return publish({ status, ...(accountId === undefined ? {} : { accountId }) });
  };

  const transitionFatalAndClear = async (
    error: IdentityPublicError,
  ): Promise<IdentityPublicState> => {
    disposeClient();
    activeCredentials = undefined;
    state = cloneIdentityPublicState({ status: "starting" });
    try {
      await options.vault.clear();
    } catch {
      // Fatal remains closed even if an OS I/O error prevents secure deletion.
    }
    await invalidateAuthorizedState();
    return publish({ status: "fatal", error });
  };

  const handleTerminal = async (
    client: IdentityWebSocketClient,
    accountId: string | undefined,
  ): Promise<IdentityPublicState> => {
    if (client !== activeClient) return getState();
    return transitionCleared("revoked", accountId);
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(async () => {
      if (closed) throw new IdentityControllerError("identity_controller_closed");
      return operation();
    });
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const openClient = async (accountId?: string): Promise<IdentityWebSocketClient> => {
    let client: IdentityWebSocketClient;
    try {
      client = options.clientFactory();
    } catch {
      throw new IdentityTransportError("connection_unavailable");
    }
    activeClient = client;
    terminalUnsubscribe = client.onTerminalRevoked(() => {
      void enqueue(() => handleTerminal(client, activeCredentials?.accountId ?? accountId))
        .catch(() => undefined);
    });
    connectionFailureUnsubscribe = client.onConnectionFailure((error) => {
      void enqueue(async () => {
        if (client !== activeClient) return getState();
        const currentAccountId = activeCredentials?.accountId ?? accountId;
        if (error.code === "connection_unavailable" || error.code === "request_timeout") {
          return transitionUnavailable(currentAccountId);
        }
        return transitionFatalAndClear(PUBLIC_ERRORS.internal);
      }).catch(() => undefined);
    });
    await client.connect();
    return client;
  };

  const handleStoredCredentialFailure = async (
    error: unknown,
    accountId: string,
  ): Promise<IdentityPublicState> => {
    if (error instanceof CredentialVaultError) {
      return transitionFatalAndClear(
        error.code === "credential_vault_corrupt"
          ? PUBLIC_ERRORS.storageCorrupt
          : PUBLIC_ERRORS.storageUnavailable,
      );
    }
    const code = errorCode(error);
    if (code === "session_revoked") return transitionCleared("revoked", accountId);
    if (code === "invalid_token" || code === "token_expired" ||
        code === "identity_forbidden" || code === "unauthenticated") {
      return transitionCleared("signed-out", accountId);
    }
    if (code === "connection_unavailable" || code === "request_timeout" ||
        code === "storage_unavailable" || code === "client_closed") {
      return transitionUnavailable(accountId);
    }
    return transitionFatalAndClear(PUBLIC_ERRORS.internal);
  };

  const requireCurrentSessions = async (
    client: IdentityWebSocketClient,
    credentials: IdentityStoredCredentials,
  ): Promise<readonly IdentityPublicSession[]> => {
    const sessions = await client.listSessions();
    if (!sessionsMatchCurrent(sessions, credentials.sessionId)) {
      throw new IdentityControllerError("identity_invalid_state");
    }
    return sessions;
  };

  const refreshCredentialsAndSessions = async (
    client: IdentityWebSocketClient,
    credentials: IdentityStoredCredentials,
  ): Promise<{
    readonly credentials: IdentityStoredCredentials;
    readonly sessions: readonly IdentityPublicSession[];
  }> => {
    const issued = await client.refresh(credentials.refreshToken);
    if (!credentialsMatchIssued(credentials, issued)) {
      throw new IdentityControllerError("identity_invalid_state");
    }
    const rotated = storedFromIssued(issued);
    try {
      await options.vault.save(rotated);
    } catch (error: unknown) {
      try {
        await client.logout();
      } catch {
        // Rotation already committed remotely. Revoke the refreshed family best effort,
        // while preserving the storage error as the fail-closed public outcome.
      }
      throw error;
    }
    activeCredentials = rotated;
    const sessions = await requireCurrentSessions(client, rotated);
    return { credentials: rotated, sessions };
  };

  const publishAuthenticated = (
    credentials: IdentityStoredCredentials,
    sessions: readonly IdentityPublicSession[],
  ): IdentityPublicState => publish({
    status: "authenticated",
    accountId: credentials.accountId,
    actorId: credentials.actorId,
    sessions,
  });

  const restore = async (): Promise<IdentityPublicState> => {
    let credentials: IdentityStoredCredentials | undefined;
    try {
      credentials = await options.vault.load();
    } catch (error: unknown) {
      const publicError = error instanceof CredentialVaultError &&
        error.code === "credential_vault_corrupt"
        ? PUBLIC_ERRORS.storageCorrupt
        : PUBLIC_ERRORS.storageUnavailable;
      return publish({ status: "fatal", error: publicError });
    }
    if (credentials === undefined) {
      activeCredentials = undefined;
      return publish({ status: "signed-out" });
    }
    activeCredentials = credentials;
    publish({ status: "restoring", accountId: credentials.accountId });
    let client: IdentityWebSocketClient;
    try {
      client = await openClient(credentials.accountId);
      try {
        const resumed = await client.resume(credentials.accessToken);
        if (resumed.accountId !== credentials.accountId ||
            resumed.actorId !== credentials.actorId ||
            resumed.sessionId !== credentials.sessionId) {
          throw new IdentityControllerError("identity_invalid_state");
        }
        const sessions = await requireCurrentSessions(client, credentials);
        return publishAuthenticated(credentials, sessions);
      } catch (error: unknown) {
        if (errorCode(error) !== "token_expired") throw error;
        const refreshed = await refreshCredentialsAndSessions(client, credentials);
        return publishAuthenticated(refreshed.credentials, refreshed.sessions);
      }
    } catch (error: unknown) {
      return handleStoredCredentialFailure(error, credentials.accountId);
    }
  };

  const refreshSessionsOperation = async (): Promise<IdentityPublicState> => {
    if (state.status === "unavailable") return restore();
    const credentials = activeCredentials;
    const client = activeClient;
    if (state.status !== "authenticated" || credentials === undefined || client === undefined) {
      return getState();
    }
    try {
      try {
        const sessions = await requireCurrentSessions(client, credentials);
        return publishAuthenticated(credentials, sessions);
      } catch (error: unknown) {
        if (errorCode(error) !== "token_expired") throw error;
        const refreshed = await refreshCredentialsAndSessions(client, credentials);
        return publishAuthenticated(refreshed.credentials, refreshed.sessions);
      }
    } catch (error: unknown) {
      return handleStoredCredentialFailure(error, credentials.accountId);
    }
  };

  return {
    getState,
    getCurrentAuthoritySession,
    initialize() {
      return enqueue(restore);
    },
    login(input) {
      if (!isIdentityLoginInput(input)) {
        return Promise.reject(new TypeError("Invalid Identity login input"));
      }
      return enqueue(async () => {
        if (state.status !== "signed-out" && state.status !== "revoked") {
          throw new IdentityControllerError("identity_invalid_state");
        }
        publish({ status: "authenticating", accountId: input.accountId });
        let device;
        try {
          device = await options.deviceIdentity.loadOrCreate();
        } catch {
          return publish({ status: "fatal", error: PUBLIC_ERRORS.internal });
        }
        let client: IdentityWebSocketClient;
        try {
          client = await openClient(input.accountId);
          const session = await client.login(input, device);
          if (session.accountId !== input.accountId) {
            throw new IdentityControllerError("identity_invalid_state");
          }
          const credentials = storedFromIssued(session);
          activeCredentials = credentials;
          try {
            await options.vault.save(credentials);
          } catch (error: unknown) {
            try {
              await client.logout();
            } catch {
              // A terminal frame or unavailable transport is acceptable for best-effort cleanup.
            }
            const publicError = error instanceof CredentialVaultError &&
              error.code === "credential_vault_corrupt"
              ? PUBLIC_ERRORS.storageCorrupt
              : PUBLIC_ERRORS.storageUnavailable;
            return transitionFatalAndClear(publicError);
          }
          const sessions = await requireCurrentSessions(client, credentials);
          return publishAuthenticated(credentials, sessions);
        } catch (error: unknown) {
          const code = errorCode(error);
          if (code === "invalid_credentials" || code === "identity_forbidden" ||
              code === "session_limit_reached") {
            disposeClient();
            activeCredentials = undefined;
            return publish({
              status: "signed-out",
              accountId: input.accountId,
              error: code === "invalid_credentials"
                ? PUBLIC_ERRORS.invalidCredentials
                : code === "identity_forbidden"
                  ? PUBLIC_ERRORS.identityForbidden
                  : PUBLIC_ERRORS.sessionLimitReached,
            });
          }
          if (code === "session_revoked") {
            return transitionCleared("revoked", input.accountId);
          }
          if (code === "connection_unavailable" || code === "request_timeout" ||
              code === "storage_unavailable" || code === "client_closed") {
            return transitionUnavailable(input.accountId);
          }
          return transitionFatalAndClear(PUBLIC_ERRORS.internal);
        }
      });
    },
    refreshSessions() {
      return enqueue(refreshSessionsOperation);
    },
    revokeSession(input) {
      if (!isIdentityRevokeSessionInput(input)) {
        return Promise.reject(new TypeError("Invalid Identity revoke input"));
      }
      return enqueue(async () => {
        const credentials = activeCredentials;
        const client = activeClient;
        if (state.status !== "authenticated" || credentials === undefined || client === undefined) {
          throw new IdentityControllerError("identity_invalid_state");
        }
        if (state.sessions.some(
          (session) => session.current && session.id === input.sessionId,
        )) {
          throw new IdentityControllerError("identity_invalid_state");
        }
        try {
          await client.revokeSession(input.sessionId);
          const sessions = await requireCurrentSessions(client, credentials);
          return publishAuthenticated(credentials, sessions);
        } catch (error: unknown) {
          if (errorCode(error) === "session_not_found") {
            try {
              const sessions = await requireCurrentSessions(client, credentials);
              publishAuthenticated(credentials, sessions);
            } catch (refreshError: unknown) {
              return handleStoredCredentialFailure(refreshError, credentials.accountId);
            }
            throw new IdentityControllerError("session_not_found");
          }
          return handleStoredCredentialFailure(error, credentials.accountId);
        }
      });
    },
    logout() {
      return enqueue(async () => {
        const accountId = activeCredentials?.accountId ??
          ("accountId" in state ? state.accountId : undefined);
        const client = activeClient;
        if (client === undefined) return transitionCleared("signed-out", accountId);
        try {
          await client.logout();
        } catch (error: unknown) {
          if (errorCode(error) !== "session_revoked") {
            return transitionUnavailable(accountId);
          }
          // Production delivers current-family revoke as terminal outbox, not a correlated ACK.
        }
        return transitionCleared("signed-out", accountId);
      });
    },
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      disposeClient();
      activeCredentials = undefined;
      listeners.clear();
    },
  };
}
